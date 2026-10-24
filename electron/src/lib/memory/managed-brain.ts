import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { blockId, MEMORY_PROJECT_DEFAULTS } from "@shared/lib/memory";
import type { MemoryProjectConfig, MemorySettings } from "@shared/types/memory";
import { JsonFileStore } from "../json-file-store";
import { attributes, children, documentLocation } from "./siyuan/blocks";
import { MemoryError, SiyuanClient } from "./siyuan/connection";

export const BRAIN_NAME = "AstraDock 记忆";
const OWNER = "astradock-managed-brain-v1";
const entrySchema = z.object({ path: z.string(), id: z.union([z.literal(""), blockId]), pending: z.boolean(), operationId: z.string().uuid().optional() });
const registrySchema = z.object({ workspace: z.string(), notebook: z.union([z.literal(""), blockId]), notebookPending: z.boolean(), documents: z.record(z.string(), entrySchema) });
type Registry = z.infer<typeof registrySchema>;
const store = new JsonFileStore<unknown>({ subDir: "siyuan-managed-brain", label: "MEMORY_BRAIN" });
const pathKey = (p: string) => process.platform === "win32" ? p.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase() : p.replace(/\/$/, "");
let queue: Promise<unknown> = Promise.resolve();
export async function serializeBrain<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(run); queue = next;
  return next;
}
function load(): Registry | null {
  if (!store.has("brain")) return null;
  const parsed = registrySchema.safeParse(store.load("brain"));
  if (!parsed.success) throw new MemoryError("binding-invalid", "记忆库身份记录损坏；已停止自动初始化，原记忆不会被替换");
  return parsed.data;
}
function save(registry: Registry) { store.save("brain", registry); }
function assertWorkspace(registry: Registry, workspace: string) {
  if (pathKey(registry.workspace) !== pathKey(workspace)) throw new MemoryError("workspace-mismatch", "思源工作空间已变化，请恢复原工作空间；不会自动创建空记忆库");
}
async function verifyDocument(c: SiyuanClient, registry: Registry, key: string, id: string, hpath = registry.documents[key]?.path) {
  const loc = await documentLocation(c, id);
  const attrs = await attributes(c, id);
  if (loc.notebook !== registry.notebook || attrs["custom-astradock-brain"] !== OWNER || attrs["custom-astradock-slot"] !== key) throw new MemoryError("binding-invalid", "固定记忆库文档已移动或身份不符，请在思源恢复原文档");
  if (key !== "root") {
    const root = registry.documents.root;
    if (!root?.id || !loc.path.startsWith("/" + root.id + "/")) throw new MemoryError("binding-invalid", "记忆文档已移出固定大脑，已停止访问");
    const parentPath = hpath?.slice(0, hpath.lastIndexOf("/"));
    const parent = Object.values(registry.documents).find(d => d.path === parentPath);
    if (!parent?.id) throw new MemoryError("binding-invalid", "记忆分类身份缺失");
    const parentLocation = await documentLocation(c, parent.id);
    if (loc.path !== parentLocation.path.slice(0, -3) + "/" + id + ".sy") throw new MemoryError("binding-invalid", "记忆文档已移到其他分类，已停止写入");
  }
}
/** Persist intent before creation. An ambiguous response is reconciled, never re-submitted. */
async function document(c: SiyuanClient, registry: Registry, key: string, hpath: string, check: () => void): Promise<string> {
  check();
  let entry = registry.documents[key];
  if (entry?.id) {
    if (entry.pending) {
      // Only an ID returned by our successful create is eligible for this idempotent metadata repair.
      const loc = await documentLocation(c, entry.id);
      if (loc.notebook !== registry.notebook) throw new MemoryError("binding-invalid", "初始化中的记忆文档已移动");
      check(); await c.api("/api/attr/setBlockAttrs", { id: entry.id, attrs: { "custom-astradock-brain": OWNER, "custom-astradock-slot": key } }, z.unknown());
      check(); entry.pending = false; save(registry);
    }
    await verifyDocument(c, registry, key, entry.id, hpath); return entry.id;
  }
  const ids = await c.api("/api/filetree/getIDsByHPath", { notebook: registry.notebook, path: hpath }, z.array(blockId));
  check();
  if (ids.length > 1) throw new MemoryError("binding-invalid", "发现重复的记忆文档，请在思源核对；未自动选择");
  if (ids.length === 1) {
    if (entry?.pending && entry.operationId) {
      const loc = await documentLocation(c, ids[0]);
      if (loc.notebook !== registry.notebook) throw new MemoryError("binding-invalid", "初始化文档位置不符");
      // The creation marker is in the same markdown submission as the new document.
      // It proves ownership after a lost create response; path/title alone never does.
      const documentAttrs = await attributes(c, ids[0]);
      let owned = documentAttrs["custom-astradock-init-id"] === entry.operationId && documentAttrs["custom-astradock-brain"] === OWNER && documentAttrs["custom-astradock-slot"] === key;
      const blocks = owned ? [] : await children(c, ids[0]);
      for (const id of blocks.slice(0, 10)) {
        const attrs = await attributes(c, id);
        if (attrs["custom-astradock-init-id"] === entry.operationId && attrs["custom-astradock-brain"] === OWNER && attrs["custom-astradock-slot"] === key) { owned = true; break; }
      }
      if (!owned) throw new MemoryError("binding-invalid", "初始化文档身份尚未确认，请等待索引完成后重新连接；未重复创建");
      check(); entry.id = ids[0]; save(registry);
      await c.api("/api/attr/setBlockAttrs", { id: ids[0], attrs: { "custom-astradock-brain": OWNER, "custom-astradock-slot": key } }, z.unknown());
    }
    await verifyDocument(c, registry, key, ids[0], hpath); check();
    registry.documents[key] = { path: hpath, id: ids[0], pending: false }; save(registry); return ids[0];
  }
  if (entry?.pending) throw new MemoryError("binding-invalid", "记忆库初始化结果待核对；请等待思源索引完成后重新连接，不会重复创建");
  if (key !== "root") {
    const parentPath = hpath.slice(0, hpath.lastIndexOf("/"));
    const parent = Object.values(registry.documents).find(d => d.path === parentPath);
    const parents = await c.api("/api/filetree/getIDsByHPath", { notebook: registry.notebook, path: parentPath }, z.array(blockId));
    if (!parent?.id || parents.length !== 1 || parents[0] !== parent.id) throw new MemoryError("binding-invalid", "记忆分类已改名或移动，请恢复原分类后重试；未新建替代文档");
    check();
  }
  entry = { path: hpath, id: "", pending: true, operationId: randomUUID() }; registry.documents[key] = entry; save(registry);
  check();
  const id = await c.api("/api/filetree/createDocWithMd", { notebook: registry.notebook, path: hpath,
    markdown: '自动管理的长期记忆。请勿删除身份标记。\n{: custom-astradock-brain="' + OWNER + '" custom-astradock-slot="' + key + '" custom-astradock-init-id="' + entry.operationId + '"}\n',
  }, blockId);
  // Document attributes must be set on the document, not its first paragraph.
  entry.id = id; save(registry);
  await c.api("/api/attr/setBlockAttrs", { id, attrs: { "custom-astradock-brain": OWNER, "custom-astradock-slot": key } }, z.unknown());
  check(); await verifyDocument(c, registry, key, id, hpath); entry.pending = false; save(registry); return id;
}
export async function initializeBrain(c: SiyuanClient, workspace: string, check: () => void): Promise<{ notebook: string; root: string; personal: string }> {
  return serializeBrain(async () => {
    const registry = load() ?? { workspace, notebook: "", notebookPending: false, documents: {} };
    assertWorkspace(registry, workspace); check();
    const result = await c.api("/api/notebook/lsNotebooks", {}, z.object({ notebooks: z.array(z.object({ id: blockId, name: z.string(), closed: z.boolean().optional() })) }));
    if (registry.notebook) {
      const notebook = result.notebooks.find(n => n.id === registry.notebook);
      if (!notebook || notebook.closed) throw new MemoryError("binding-invalid", "固定记忆库已关闭或不存在，请在思源恢复；不会创建替代库");
    } else {
      const matches = result.notebooks.filter(n => n.name === BRAIN_NAME);
      if (matches.length > 1 || matches.some(n => n.closed)) throw new MemoryError("binding-invalid", "同名记忆库重复或已关闭，请在思源核对");
      if (matches.length) {
        registry.notebook = matches[0].id;
        // A fresh installation may reuse a marked brain, never an arbitrary user notebook.
        if (!registry.notebookPending) {
          const roots = await c.api("/api/filetree/getIDsByHPath", { notebook: registry.notebook, path: "/长期记忆" }, z.array(blockId));
          if (roots.length !== 1) throw new MemoryError("binding-invalid", "同名笔记本不是可识别的 AstraDock 记忆库；不会读取或改写其中的笔记");
          await verifyDocument(c, registry, "root", roots[0]);
          registry.documents.root = { path: "/长期记忆", id: roots[0], pending: false };
        }
      } else {
        if (registry.notebookPending) throw new MemoryError("binding-invalid", "记忆库创建结果待核对，请稍后重新连接；未重复创建");
        registry.notebookPending = true; save(registry); check();
        const created = await c.api("/api/notebook/createNotebook", { name: BRAIN_NAME }, z.object({ notebook: z.object({ id: blockId }) }));
        registry.notebook = created.notebook.id;
      }
      registry.notebookPending = false; check(); save(registry);
    }
    const root = await document(c, registry, "root", "/长期记忆", check);
    const personal = await document(c, registry, "personal", "/长期记忆/通用偏好", check);
    return { notebook: registry.notebook, root, personal };
  });
}
export async function validateBrain(c: SiyuanClient, settings: MemorySettings): Promise<void> {
  const registry = load();
  if (!registry || registry.notebook !== settings.managedNotebookId || registry.documents.root?.id !== settings.identityAnchorDocumentId) throw new MemoryError("binding-invalid", "固定记忆库身份记录不匹配，请重新连接核对");
  assertWorkspace(registry, settings.expectedWorkspacePath);
  await verifyDocument(c, registry, "root", settings.identityAnchorDocumentId);
  const personal = registry.documents.personal?.id;
  const scope = settings.personalReadScopes[0];
  if (!personal || settings.personalWriteDocumentId !== personal || settings.personalReadScopes.length !== 1 || scope.documentId !== personal || scope.notebookId !== registry.notebook || !scope.includeDescendants || settings.personalSummaryBlockIds.length) throw new MemoryError("binding-invalid", "固定记忆库分类配置不匹配，已停止访问");
  await verifyDocument(c, registry, "personal", personal);
}
export async function managedProject(c: SiyuanClient, settings: MemorySettings, projectId: string, check: () => void): Promise<MemoryProjectConfig> {
  return serializeBrain(async () => {
    const registry = load(); if (!registry || registry.notebook !== settings.managedNotebookId) throw new MemoryError("binding-invalid", "固定记忆库身份不匹配");
    assertWorkspace(registry, settings.expectedWorkspacePath);
    const key = "project-" + createHash("sha256").update(projectId).digest("hex");
    const id = await document(c, registry, key, "/长期记忆/" + key, check); check();
    return { ...MEMORY_PROJECT_DEFAULTS, enabled: true, includePersonalMemory: true, writeDocumentId: id,
      readScopes: [{ notebookId: registry.notebook, documentId: id, includeDescendants: true }] };
  });
}
/** Partition growth into bounded pages while retaining the same brain and read root. */
export async function managedWritePage(c: SiyuanClient, settings: MemorySettings, rootId: string, check: () => void): Promise<string> {
  return serializeBrain(async () => {
    const registry = load(); if (!registry || registry.notebook !== settings.managedNotebookId) throw new MemoryError("binding-invalid", "固定记忆库身份不匹配");
    assertWorkspace(registry, settings.expectedWorkspacePath);
    const root = Object.entries(registry.documents).find(([, d]) => d.id === rootId);
    if (!root) throw new MemoryError("binding-invalid", "未知记忆分类");
    const prefix = root[0] + "-page-";
    const pages = Object.keys(registry.documents).filter(k => k.startsWith(prefix)).sort();
    const last = pages.at(-1);
    if (last) {
      const entry = registry.documents[last];
      const id = await document(c, registry, last, entry.path, check);
      if ((await children(c, id)).length < 90) { check(); return id; }
    }
    const number = String(pages.length + 1).padStart(8, "0");
    return document(c, registry, prefix + number, root[1].path + "/记忆-" + number, check);
  });
}
