import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MEMORY_DEFAULTS } from "@shared/lib/memory";
import type { MemorySettings } from "@shared/types/memory";
const f = vi.hoisted(() => {
  const settings: MemorySettings = { schemaVersion: 2, enabled: false, baseUrl: "http://127.0.0.1:6806", expectedWorkspacePath: "", identityAnchorDocumentId: "", personalReadEnabled: false, personalAutoWriteEnabled: false, personalSummaryBlockIds: [], personalReadScopes: [], personalWriteDocumentId: "" };
  return { dir: "", settings, api: vi.fn(), call: vi.fn(), probe: vi.fn() };
});
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../data-dir", () => ({ getDataDir: () => f.dir }));
vi.mock("../app-settings", () => ({ getAppSettings: () => ({ memory: f.settings }), setAppSettings: (patch: { memory: MemorySettings }) => { f.settings = patch.memory; return { memory: f.settings }; } }));
vi.mock("../error-utils", () => ({ reportError: vi.fn() }));
vi.mock("./secrets", () => ({ getMemoryToken: () => "" }));
vi.mock("./agent-bridge", () => ({ registerMemoryBridge: vi.fn(), revokeMemoryBridge: vi.fn(), memoryMcpDefinition: () => null, shutdownMemoryBridge: vi.fn() }));
vi.mock("./siyuan/connection", async original => { const actual = await original<typeof import("./siyuan/connection")>(); return { ...actual, SiyuanClient: class { baseUrl = "http://127.0.0.1:6806"; api = f.api; call = f.call; probe = f.probe; } }; });
const book = "20261024000000-aaaaaaa";
type Doc = { id: string; hpath: string; path: string; attrs: Record<string, string>; children: string[] };
let documents: Map<string, Doc>;
let notes: Map<string, { parent: string; body: string; attrs: Record<string, string> }>;
let notebooks: Array<{ id: string; name: string; closed: boolean }>;
let sequence = 0;
const nextId = () => "20261024000000-" + String(++sequence).padStart(7, "0");
const inputSchema = z.object({ id: z.string().optional(), path: z.string().optional(), name: z.string().optional(), markdown: z.string().optional(), attrs: z.record(z.string(), z.string()).optional() });
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); f.dir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-brain-"));
  f.settings = { ...MEMORY_DEFAULTS }; documents = new Map(); notes = new Map(); notebooks = []; sequence = 0;
  f.probe.mockResolvedValue({ workspacePath: "C:/SiYuan", version: "3.8.8" });
  f.api.mockImplementation(async (route: string, value: unknown) => {
    const input = inputSchema.parse(value);
    if (route.endsWith("lsNotebooks")) return { notebooks };
    if (route.endsWith("createNotebook")) { notebooks.push({ id: book, name: input.name!, closed: false }); return { notebook: { id: book } }; }
    if (route.endsWith("getIDsByHPath")) return [...documents.values()].filter(d => d.hpath === input.path).map(d => d.id);
    if (route.endsWith("createDocWithMd")) {
      const id = nextId(), hpath = input.path!;
      const parent = [...documents.values()].find(d => d.hpath === hpath.slice(0, hpath.lastIndexOf("/")));
      const marker = nextId();
      const attrs = Object.fromEntries([...(input.markdown ?? "").matchAll(/(custom-[\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      notes.set(marker, { parent: id, body: "Initialization marker", attrs });
      documents.set(id, { id, hpath, path: (parent ? parent.path.slice(0, -3) : "") + "/" + id + ".sy", attrs: {}, children: [marker] }); return id;
    }
    const note = notes.get(input.id ?? "");
    const doc = documents.get(note?.parent ?? input.id ?? "");
    if (!doc) throw Error("missing document");
    if (route.endsWith("getPathByID")) return { notebook: book, path: doc.path };
    if (route.endsWith("setBlockAttrs")) { doc.attrs = { ...doc.attrs, ...input.attrs }; return null; }
    if (route.endsWith("getBlockAttrs")) return note?.attrs ?? doc.attrs;
    if (route.endsWith("getChildBlocks")) return doc.children.map(id => ({ id }));
    if (route.endsWith("getBlockKramdown")) return { id: input.id, kramdown: note?.body ?? "" };
    throw Error("unexpected route " + route);
  });
  f.call.mockImplementation(async (name: string, raw: unknown) => {
    if (name === "search") {
      const input = z.object({ path: z.string() }).parse(raw);
      const found = [...notes.entries()].filter(([, n]) => n.attrs["custom-astradock-operation-id"] && documents.get(n.parent)!.path.startsWith(input.path));
      return { text: "Found " + found.length + " results\n" + found.map(([id]) => "  id: " + id).join("\n") };
    }
    const input = z.object({ parentID: z.string(), data: z.string() }).parse(raw);
    const id = nextId(); const doc = documents.get(input.parentID)!;
    const attrs = Object.fromEntries([...input.data.matchAll(/(custom-[\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
    const body = input.data.split("\n")[0].replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
    notes.set(id, { parent: doc.id, body, attrs }); doc.children.push(id);
    return { text: "", structured: { action: "append", id } };
  });
});
afterEach(() => { fs.rmSync(f.dir, { recursive: true, force: true }); });
async function service() { return import("./service"); }
async function connected() { const s = await service(); await s.connectMemory(MEMORY_DEFAULTS.baseUrl); await s.registerMemorySession("session", "project", "codex"); return s; }
const calls = (route: string) => f.api.mock.calls.filter(args => String(args[0]).endsWith(route));
describe("fixed managed brain", () => {
  it("initializes one notebook without project binding", async () => {
    const s = await connected();
    expect(f.settings.managedNotebookId).toBe(book); expect(f.settings.personalAutoWriteEnabled).toBe(true);
    expect((await s.getMemoryStatus()).state).toBe("ready");
    expect(await s.callMemoryTool("session", "memory_status", {})).toHaveProperty("projectEnabled", true);
    expect((await s.beforeMemorySend("session", "Explain the project")).text).toContain("memory_remember");
    expect(calls("createNotebook")).toHaveLength(1);
  });
  it("reconnects and resumes after restart without duplicating the notebook", async () => {
    const s = await connected(); const anchor = f.settings.identityAnchorDocumentId;
    await s.connectMemory(MEMORY_DEFAULTS.baseUrl); vi.resetModules(); await (await service()).connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect(f.settings.identityAnchorDocumentId).toBe(anchor); expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("serializes concurrent initialization", async () => {
    const s = await service(); await Promise.allSettled([s.connectMemory(MEMORY_DEFAULTS.baseUrl), s.connectMemory(MEMORY_DEFAULTS.baseUrl)]);
    expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("writes both scopes and prioritizes this project while isolating other projects", async () => {
    const s = await connected();
    expect((await s.remember("project", "Use the project test runner", "project", "convention", "session")).state).toBe("verified");
    expect((await s.remember("project", "Always explain in Chinese", "personal", "preference", "session")).state).toBe("verified");
    const found = z.object({ candidates: z.array(z.object({ ref: z.string(), scope: z.string() })) }).parse(await s.callMemoryTool("session", "memory_search", { query: "test" }));
    expect(found.candidates.map(c => c.scope)).toEqual(["project", "personal"]);
    const result = await s.callMemoryTool("session", "memory_read", { refs: found.candidates.map(c => c.ref) });
    expect(JSON.stringify(result)).toContain("Use the project test runner"); expect(JSON.stringify(result)).toContain("Always explain in Chinese");
    await s.registerMemorySession("other", "other-project", "claude");
    const other = z.object({ candidates: z.array(z.object({ scope: z.string() })) }).parse(await s.callMemoryTool("other", "memory_search", { query: "test" }));
    expect(other.candidates.map(c => c.scope)).toEqual(["personal"]); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("rotates full pages and reconciles and deduplicates old writes", async () => {
    const s = await connected(); const first = await s.remember("project", "First project conclusion", "project", "convention", "session");
    const page = documents.get(first.target)!; page.children = Array.from({ length: 90 }, () => first.blockId!);
    const second = await s.remember("project", "Second project conclusion", "project", "convention", "session");
    expect(second.state).toBe("verified"); expect(second.target).not.toBe(first.target); page.children = [first.blockId!];
    expect((await s.reconcileMemory("project", first.operationId)).state).toBe("verified");
    expect((await s.remember("project", "First project conclusion", "project", "convention", "session")).operationId).toBe(first.operationId);
  });
  it("keeps corrections on the original page", async () => {
    const s = await connected(); const original = await s.remember("project", "Original conclusion", "project", "convention", "session");
    const result = z.object({ candidates: z.array(z.object({ ref: z.string() })) }).parse(await s.callMemoryTool("session", "memory_search", { query: "test" }));
    const correction = await s.remember("project", "Corrected conclusion", "project", "correction", "session", result.candidates[0].ref);
    expect(correction.target).toBe(original.target); expect(correction.state).toBe("verified");
    expect(JSON.stringify(await s.callMemoryTool("session", "memory_read", { refs: [result.candidates[0].ref] }))).toContain("Corrected conclusion");
  });
  it("never switches workspaces", async () => {
    const s = await connected(); f.probe.mockResolvedValue({ workspacePath: "C:/Different", version: "3.8.8" });
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("工作空间已变化"); expect(calls("createNotebook")).toHaveLength(1);
    expect((await s.getMemoryStatus()).state).toBe("workspace-mismatch");
  });
  it("does not replace missing or closed notebooks", async () => {
    const s = await connected(); notebooks[0].closed = true;
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("关闭或不存在"); notebooks = [];
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("关闭或不存在"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("does not recreate a deleted anchor", async () => {
    const s = await connected(); documents.delete(f.settings.identityAnchorDocumentId);
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow(); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("refuses an unrelated same-name user notebook", async () => {
    notebooks.push({ id: book, name: "AstraDock 记忆", closed: false }); const s = await service();
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("不是可识别"); expect(calls("createDocWithMd")).toHaveLength(0);
  });
  it("fails closed on corrupt registry", async () => {
    const s = await connected(); fs.writeFileSync(path.join(f.dir, "siyuan-managed-brain", "brain.json"), "corrupt");
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("身份记录损坏"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("never resubmits an unknown notebook creation", async () => {
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (...args) => { if (String(args[0]).endsWith("createNotebook")) throw Error("lost response"); return original(...args); });
    const s = await service(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("待核对"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("does not create replacements after an external rename", async () => {
    const s = await connected(); documents.get(f.settings.identityAnchorDocumentId)!.hpath = "/Renamed";
    await expect(s.remember("project", "New project conclusion", "project", "convention", "session")).rejects.toThrow("改名或移动"); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("disabling memory stops use and preserves notes", async () => {
    const s = await connected(); f.settings = { ...f.settings, enabled: false };
    await expect(s.remember("project", "New project conclusion", "project", "convention", "session")).rejects.toThrow("未启用");
    expect((await s.beforeMemorySend("session", "hello")).text).toBe("hello"); expect(documents.size).toBe(2);
  });
});

// Recovery exercises mutation boundaries, not just successful creation responses.
describe("managed initialization recovery", () => {
  it("does not append to a page moved into another category", async () => {
    const s = await connected(); const first = await s.remember("project", "First conclusion", "project", "convention", "session");
    const personal = documents.get(f.settings.personalWriteDocumentId)!;
    documents.get(first.target)!.path = personal.path.slice(0, -3) + "/" + first.target + ".sy";
    await expect(s.remember("project", "Second conclusion", "project", "convention", "session")).rejects.toThrow("其他分类");
    expect(f.call.mock.calls.filter(c => c[0] === "block")).toHaveLength(1);
  });
  it("recovers a lost document response by its persisted ownership marker", async () => {
    const original = f.api.getMockImplementation()!; let dropped = false;
    f.api.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!dropped && String(args[0]).endsWith("createDocWithMd")) { dropped = true; throw Error("response lost after commit"); }
      return result;
    });
    const s = await service(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow();
    await s.connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect((await s.getMemoryStatus()).state).toBe("ready"); expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("repairs interrupted document metadata idempotently without recreating notes", async () => {
    const original = f.api.getMockImplementation()!; let dropped = false;
    f.api.mockImplementation(async (...args) => {
      if (!dropped && String(args[0]).endsWith("setBlockAttrs")) { dropped = true; throw Error("connection lost"); }
      return original(...args);
    });
    const s = await service(); await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow(); await s.connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect((await s.getMemoryStatus()).state).toBe("ready"); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("never recreates a known brain when the local identity record disappears", async () => {
    const s = await connected(); fs.unlinkSync(path.join(f.dir, "siyuan-managed-brain", "brain.json")); notebooks = [];
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("身份记录不匹配"); expect(calls("createNotebook")).toHaveLength(1);
  });
  it("reuses an existing marked brain on a fresh installation", async () => {
    const s = await connected(); const root = f.settings.identityAnchorDocumentId;
    fs.unlinkSync(path.join(f.dir, "siyuan-managed-brain", "brain.json")); f.settings = { ...MEMORY_DEFAULTS };
    await s.connectMemory(MEMORY_DEFAULTS.baseUrl);
    expect(f.settings.identityAnchorDocumentId).toBe(root); expect(calls("createNotebook")).toHaveLength(1); expect(calls("createDocWithMd")).toHaveLength(2);
  });
  it("refuses broad personal scopes even if a stale renderer submits them", async () => {
    const s = await connected(); f.settings = { ...f.settings, personalReadScopes: [] };
    expect((await s.getMemoryStatus()).state).toBe("binding-invalid");
    await expect(s.callMemoryTool("session", "memory_search", { query: "test" })).rejects.toThrow();
  });
  it("stops initialization if permissions change while probing", async () => {
    const s = await service(); f.probe.mockImplementation(async () => { f.settings = { ...f.settings, enabled: true }; return { workspacePath: "C:/SiYuan", version: "3.8.8" }; });
    await expect(s.connectMemory(MEMORY_DEFAULTS.baseUrl)).rejects.toThrow("连接设置已变化"); expect(calls("createNotebook")).toHaveLength(0);
  });
});
