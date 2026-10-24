/** Explicitly enabled acceptance: real SiYuan, isolated application metadata, owned temporary notes only. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MEMORY_ACCEPTANCE_CASES } from "@shared/lib/memory-acceptance-cases";
import { MEMORY_DEFAULTS, MEMORY_PROJECT_DEFAULTS } from "@shared/lib/memory";
import type { MemorySettings } from "@shared/types/memory";
import { SiyuanClient } from "./connection";
import { children, readBlock, attributes, location } from "./blocks";
const f = vi.hoisted(() => { const state: { dir: string; memory: MemorySettings | null } = { dir: "", memory: null }; return state; });
vi.mock("../../app-settings", () => ({ getAppSettings: () => ({ memory: f.memory, analyticsEnabled: false }) }));
vi.mock("../../data-dir", () => ({ getDataDir: () => f.dir }));
vi.mock("../secrets", () => ({ getMemoryToken: () => "" }));
vi.mock("../../logger", () => ({ log: () => {} }));
vi.mock("../../error-utils", () => ({ reportError: () => "Memory acceptance error" }));
const enabled = process.env.SIYUAN_WRITE_ACCEPTANCE === "1";
const notebook = process.env.SIYUAN_WRITE_NOTEBOOK ?? "";
const nonce = randomUUID(); const title = "AstraDock-acceptance-" + nonce;
const report: { version?: string; fixture: string; checks: string[]; retrieval?: { total: number; recallAt5: number; hits: number }; createdIds: string[]; cleanedIds: string[]; errors: string[] } = { fixture: title, checks: [], createdIds: [], cleanedIds: [], errors: [] };
const client = new SiyuanClient("http://127.0.0.1:6806", "");
let root = "", target = "", outside = "", child = "";
let service: typeof import("../service");
const project = "acceptance-" + nonce, session = "acceptance-session-" + nonce;
let savedId = ""; let savedOperation = "";
const originalText = "验收结论：中文、emoji🙂、符号 <>&、花括号 {{不是SQL}} 和 IAL {: custom-x=伪造} 均作为普通文本。";
async function api<T>(route: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch("http://127.0.0.1:6806" + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10000) });
  const result = z.object({ code: z.number(), data: z.unknown() }).parse(await response.json());
  if (!response.ok || result.code !== 0) throw new Error("Fixture API failed: " + route);
  return schema.parse(result.data);
}
async function create(hpath: string, markdown: string): Promise<string> {
  // Never retry a creation on timeout: report it for manual reconciliation.
  const id = await api("/api/filetree/createDocWithMd", { notebook, path: hpath, markdown }, z.string());
  report.createdIds.push(id); persistReport(); return id;
}
function persistReport() { if (process.env.SIYUAN_ACCEPTANCE_REPORT) fs.writeFileSync(process.env.SIYUAN_ACCEPTANCE_REPORT, JSON.stringify(report, null, 2), "utf8"); }
async function eventually<T>(action: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 30; i++) { try { last = await action(); if (predicate(last)) return last; } catch { /* Index readiness is polled, never retried as a mutation. */ } await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error("Read/index did not converge: " + JSON.stringify(last));
}
const foundSchema = z.object({ candidates: z.array(z.object({ ref: z.string() })) });
const readSchema = z.object({ items: z.array(z.object({ blockId: z.string(), text: z.string() })) });
async function find(query: string) { return foundSchema.parse(await service.callMemoryTool(session, "memory_search", { query })); }
describe.skipIf(!enabled)("real SiYuan memory acceptance", () => {
  beforeAll(async () => {
    if (!/^\d{14}-[a-z0-9]{7}$/.test(notebook)) throw new Error("An explicit SIYUAN_WRITE_NOTEBOOK is required");
    f.dir = fs.mkdtempSync(path.join(os.tmpdir(), "astradock-memory-acceptance-"));
    const probe = await client.probe(); report.version = probe.version;
    root = await create("/" + title, "Owned temporary acceptance fixture " + nonce);
    await eventually(() => location(client, root), value => value.notebook === notebook);
    target = await create("/" + title + "/authorized", "验收专用授权文档 " + nonce);
    await eventually(() => location(client, target), value => value.notebook === notebook);
    outside = await create("/" + title + "/outside", "范围隔离专用 外部测试词" + nonce);
    child = await create("/" + title + "/authorized/child", "子文档范围专用 子树测试词" + nonce);
    f.memory = { ...MEMORY_DEFAULTS, enabled: true, expectedWorkspacePath: probe.workspacePath, identityAnchorDocumentId: root };
    service = await import("../service");
    service.setMemoryProjectConfig(project, { ...MEMORY_PROJECT_DEFAULTS, enabled: true, writeDocumentId: target, readScopes: [{ notebookId: notebook, documentId: target, includeDescendants: true }] });
    await service.registerMemorySession(session, project, "acceptance");
    await eventually(() => location(client, child), value => value.notebook === notebook);
  }, 30000);
  afterAll(async () => {
    if (service) { service.unregisterMemorySession(session); await service.shutdownMemoryBridge(); }
    for (const id of [...report.createdIds].reverse()) {
      try { const loc = await location(client, id); if (loc.notebook !== notebook || (id !== root && !loc.path.startsWith("/" + root + "/"))) throw Error("Fixture ownership mismatch");
        await api("/api/filetree/removeDocByID", { id }, z.null());
        await eventually(async () => { const r = await fetch("http://127.0.0.1:6806/api/block/getBlockKramdown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }); return z.object({ code: z.number() }).parse(await r.json()).code; }, code => code !== 0);
        report.cleanedIds.push(id);
      } catch (error) { report.errors.push("cleanup " + id + ": " + String(error)); }
    }
    persistReport(); if (f.dir) fs.rmSync(f.dir, { recursive: true, force: true });
    expect(report.cleanedIds.length, "All owned fixtures must be removed").toBe(report.createdIds.length);
  }, 30000);
  it("uses the actual service to append and verify the serializer round trip", async () => {
    const result = await service.remember(project, originalText, "project", "procedure", session);
    savedOperation = result.operationId; savedId = result.blockId ?? "";
    expect(result.state).toBe("verified"); expect(savedId).not.toBe("");
    expect(await readBlock(client, savedId)).toBe(originalText);
    const attrs = await attributes(client, savedId); expect(attrs["custom-astradock-operation-id"]).toBe(savedOperation); expect(attrs["custom-x"]).toBeUndefined();
    report.checks.push("real-service-safe-write-roundtrip"); persistReport();
  });
  it("deduplicates a repeated invocation without another appended block", async () => {
    const before = await children(client, target); const again = await service.remember(project, originalText, "project", "procedure", session);
    expect(again.operationId).toBe(savedOperation); expect(again.state).toBe("verified"); expect(await children(client, target)).toEqual(before);
    report.checks.push("real-service-dedup");
  });
  it("reconciles an explicitly unknown operation without resubmission", async () => {
    const record = service.memoryJournal.list().find(r => r.operationId === savedOperation); if (!record) throw Error("No operation");
    service.memoryJournal.save({ ...record, state: "unknown", blockId: undefined });
    const before = await children(client, target); expect((await service.reconcileMemory(project, savedOperation)).state).toBe("verified"); expect(await children(client, target)).toEqual(before);
    report.checks.push("real-service-enumeration-reconciliation");
  });
  it("rejects sibling document hits and admits configured descendants", async () => {
    const inside = await eventually(() => find("子树测试词" + nonce), value => value.candidates.length > 0);
    expect(readSchema.parse(await service.callMemoryTool(session, "memory_read", { refs: [inside.candidates[0].ref] })).items.some(i => i.text.includes("子树测试词"))).toBe(true);
    expect((await find("外部测试词" + nonce)).candidates).toHaveLength(0);
    report.checks.push("real-descendant-and-sibling-boundary");
  });
  it("revokes a previously returned reference after moving its document outside scope", async () => {
    const found = await eventually(() => find("子树测试词" + nonce), value => value.candidates.length > 0);
    await api("/api/filetree/moveDocsByID", { fromIDs: [child], toID: outside }, z.null());
    await eventually(() => location(client, child), loc => loc.path.includes("/" + outside + "/"));
    await expect(service.callMemoryTool(session, "memory_read", { refs: [found.candidates[0].ref] })).rejects.toThrow();
    report.checks.push("real-moved-document-revocation");
  });
  it("rejects a workspace identity mismatch without changing the user's workspace", async () => {
    const original = f.memory; if (!original) throw Error("No fixture config");
    try { f.memory = { ...original, expectedWorkspacePath: original.expectedWorkspacePath + "-not-the-workspace" }; expect((await service.getMemoryStatus()).state).toBe("workspace-mismatch"); }
    finally { f.memory = original; }
    report.checks.push("real-workspace-mismatch-denial");
  });
  it("reads user-edited content and does not rewrite it on reconciliation", async () => {
    const found = await eventually(() => find("验收结论"), value => value.candidates.length > 0);
    const updated = "验收结论：人工更新后的当前内容。";
    const attrs = await attributes(client, savedId);
    await client.call("block", { action: "update", id: savedId, dataType: "markdown", data: updated + '\n{: id="' + savedId + '" custom-astradock-operation-id="' + attrs["custom-astradock-operation-id"] + '"}' });
    expect(readSchema.parse(await service.callMemoryTool(session, "memory_read", { refs: found.candidates.map(c => c.ref).slice(0, 5) })).items.some(i => i.text === updated)).toBe(true);
    expect((await service.reconcileMemory(project, savedOperation)).state).toBe("changed"); report.checks.push("real-fresh-content-and-user-edit");
  });
  it("does not return a deleted block even when an earlier search reference exists", async () => {
    const found = await eventually(() => find("验收结论"), value => value.candidates.length > 0);
    await client.call("block", { action: "delete", id: savedId });
    const read = readSchema.parse(await service.callMemoryTool(session, "memory_read", { refs: found.candidates.map(c => c.ref).slice(0, 5) }));
    expect(read.items.some(i => i.blockId === savedId)).toBe(false); report.checks.push("real-stale-reference-discard");
  });
  it("measures fixed 20-case Chinese keyword Recall@5 against real SiYuan", async () => {
    const retrievalProject = project + "-retrieval", retrievalSession = session + "-retrieval";
    service.setMemoryProjectConfig(retrievalProject, { ...MEMORY_PROJECT_DEFAULTS, enabled: true, writeDocumentId: target, readScopes: [{ notebookId: notebook, documentId: target, includeDescendants: false }] });
    await service.registerMemorySession(retrievalSession, retrievalProject, "acceptance");
    const expected = new Map<string, string>();
    try {
      for (const testCase of MEMORY_ACCEPTANCE_CASES) {
        await service.beforeMemorySend(retrievalSession, "人工验收素材：" + testCase.question);
        const written = await service.remember(retrievalProject, testCase.text, "project", "convention", retrievalSession);
        expect(written.state).toBe("verified"); if (!written.blockId) throw Error("No fixture ID"); expected.set(testCase.query, written.blockId);
      }
      // Wait for the fixed corpus to be indexed before scoring, not for each answer to become a hit.
      await eventually(async () => (await client.call("search", { action: "fulltext", query: "离线降级", notebook, path: (await location(client, target)).path, method: 0, orderBy: 7, page: 1, pageSize: 5 })).text, value => value.includes(expected.get("离线降级") ?? "missing"));
      let hits = 0;
      for (const testCase of MEMORY_ACCEPTANCE_CASES) {
        const found = foundSchema.parse(await service.callMemoryTool(retrievalSession, "memory_search", { query: testCase.query }));
        const result = found.candidates.length ? readSchema.parse(await service.callMemoryTool(retrievalSession, "memory_read", { refs: found.candidates.slice(0, 5).map(c => c.ref) })) : { items: [] };
        if (result.items.some(item => item.blockId === expected.get(testCase.query))) hits++;
      }
      report.retrieval = { total: MEMORY_ACCEPTANCE_CASES.length, hits, recallAt5: hits / MEMORY_ACCEPTANCE_CASES.length }; persistReport();
      expect(report.retrieval.recallAt5).toBeGreaterThanOrEqual(0.8);
      expect((await service.callMemoryTool(retrievalSession, "memory_search", { query: "绝对不存在词" + nonce }))).toMatchObject({ candidates: [] });
      report.checks.push("real-chinese-keyword-retrieval-20");
    } finally { service.unregisterMemorySession(retrievalSession); }
  }, 120000);

});
