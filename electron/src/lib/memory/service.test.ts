import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_DEFAULTS, MEMORY_PROJECT_DEFAULTS } from "@shared/lib/memory";
const f = vi.hoisted(() => ({ directory: "", settings: {}, config: {}, api: vi.fn(), call: vi.fn(), probe: vi.fn(), register: vi.fn(), revoke: vi.fn() }));
vi.mock("../app-settings", () => ({ getAppSettings: () => ({ memory: f.settings }) }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../error-utils", () => ({ reportError: vi.fn() }));
vi.mock("../data-dir", () => ({ getDataDir: () => f.directory }));
vi.mock("./secrets", () => ({ getMemoryToken: () => "" }));
vi.mock("./project-config", () => ({ getMemoryProjectConfig: () => f.config, setMemoryProjectConfig: vi.fn() }));
vi.mock("./agent-bridge", () => ({ registerMemoryBridge: f.register, revokeMemoryBridge: f.revoke, memoryMcpDefinition: () => null, shutdownMemoryBridge: vi.fn() }));
vi.mock("./siyuan/connection", async (original) => { const actual = await original<typeof import("./siyuan/connection")>(); return { ...actual, SiyuanClient: class { baseUrl = "http://127.0.0.1:6806"; api = f.api; call = f.call; probe = f.probe; } }; });
const doc = "20261023000000-aaaaaaa", note = "20261023000000-bbbbbbb", book = "20261023000000-ccccccc";
let body = "Verified test memory"; let attrs: Record<string, string> = {}; let exists = true; let appendCount = 0;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); f.directory = fs.mkdtempSync(path.join(os.tmpdir(), "memory-service-"));
  f.settings = { ...MEMORY_DEFAULTS, enabled: true, expectedWorkspacePath: "C:/SiYuan", identityAnchorDocumentId: doc };
  f.config = { ...MEMORY_PROJECT_DEFAULTS, enabled: true, writeDocumentId: doc, readScopes: [{ notebookId: book, documentId: doc, includeDescendants: false }] };
  body = "Verified test memory"; attrs = {}; exists = true; appendCount = 0;
  f.probe.mockResolvedValue({ workspacePath: "C:/SiYuan", version: "3.8.8" });
  f.api.mockImplementation(async (route: string, input: { id: string }) => {
    if (route.endsWith("getPathByID")) return { notebook: book, path: "/" + doc + ".sy" };
    if (route.endsWith("getChildBlocks")) return exists ? [{ id: note }] : [];
    if (route.endsWith("getBlockAttrs")) return attrs;
    if (route.endsWith("getBlockKramdown")) { if (!exists) { const { MemoryError } = await import("./siyuan/connection"); throw new MemoryError("binding-invalid", "missing"); } return { id: input.id, kramdown: body }; }
    throw new Error("Unexpected API");
  });
  f.call.mockImplementation(async (name: string, input: { action: string; data?: string }) => {
    if (name === "search") return { text: "Found 1 results (page 1/1):\n  id: " + note + "\n" };
    if (input.action === "append") { appendCount++; const data = input.data ?? ""; const paragraph = data.split("\n")[0]; body = paragraph.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code))); attrs = Object.fromEntries([...data.matchAll(/(custom-[\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])); return { text: "", structured: { action: "append", id: note } }; }
    throw new Error("Unexpected tool");
  });
});
afterEach(() => { fs.rmSync(f.directory, { recursive: true, force: true }); });
async function setup() { const s = await import("./service"); await s.registerMemorySession("session", "project", "codex"); return s; }
describe("SiYuan service policies", () => {
  it("only exempts exact server-qualified memory tools from per-item approval", async () => { const s = await setup(); expect(s.isMemoryTool("mcp__harnss_memory__memory_remember")).toBe(true); expect(s.isMemoryTool("Tool: harnss_memory/memory_read")).toBe(true); for (const name of ["memory_remember", "Bash", "mcp__other__memory_remember", "mcp__harnss_memory__delete"]) expect(s.isMemoryTool(name)).toBe(false); });
  it("injects policy without inventing a separate summarizer", async () => { const s = await setup(); const result = await s.beforeMemorySend("session", "Solve this task"); expect(result.text).toContain("memory_remember"); expect(result.text).toContain("No per-item confirmation"); expect(result.text).toContain("Solve this task"); expect(appendCount).toBe(0); });
  it("falls back to original text when memory is unavailable", async () => { const s = await setup(); f.probe.mockRejectedValue(new Error("offline")); expect((await s.beforeMemorySend("session", "Original question")).text).toBe("Original question"); expect(s.getMemoryRecallState("session")?.status).toContain("暂时失效"); });
  it("does not inject after settings change during a read", async () => { const s = await setup(); f.config = { ...f.config, summaryBlockIds: [note] }; const original = f.api.getMockImplementation()!; f.api.mockImplementation(async (...args) => { const result = await original(...args); if (String(args[0]).endsWith("getBlockKramdown")) f.settings = { ...f.settings, enabled: false }; return result; }); expect((await s.beforeMemorySend("session", "Original question")).text).toBe("Original question"); });
  it("requires an authorized reference for corrections", async () => { const s = await setup(); await expect(s.remember("project", "Corrected conclusion", "project", "correction", "session", "fake")).rejects.toThrow(); expect(appendCount).toBe(0); });
  it("does not reconcile into a different configured document", async () => { const s = await setup(); const result = await s.remember("project", "Verified test memory", "project", "procedure", "session"); f.config = { ...f.config, writeDocumentId: "20261023000000-zzzzzzz" }; await expect(s.reconcileMemory("project", result.operationId)).rejects.toThrow(); });
  it("refuses writing when the bounded reconciliation domain is already full", async () => { const s = await setup(); const original = f.api.getMockImplementation()!; f.api.mockImplementation(async (...args) => String(args[0]).endsWith("getChildBlocks") ? Array.from({ length: 100 }, () => ({ id: note })) : original(...args)); await expect(s.remember("project", "Verified test memory", "project", "procedure", "session")).rejects.toThrow(); expect(appendCount).toBe(0); });

  it("automatically appends and verifies without an approval round trip", async () => { const s = await setup(); const result = await s.remember("project", "Verified test memory", "project", "procedure", "session"); expect(result.state).toBe("verified"); expect(appendCount).toBe(1); expect(attrs["custom-astradock-operation-id"]).toBe(result.operationId); });
  it("deduplicates concurrent identical writes", async () => { const s = await setup(); const results = await Promise.all([s.remember("project", "Verified test memory", "project", "procedure", "session"), s.remember("project", "Verified test memory", "project", "procedure", "session")]); expect(results[0].operationId).toBe(results[1].operationId); expect(appendCount).toBe(1); });
  it("unknown submission never retries; reconciliation finds a completed write", async () => { const s = await setup(); const original = f.call.getMockImplementation()!; f.call.mockImplementationOnce(async (...args) => { await original(...args); throw new Error("lost response"); }); const result = await s.remember("project", "Verified test memory", "project", "procedure", "session"); expect(result.state).toBe("unknown"); expect((await s.reconcileMemory("project", result.operationId)).state).toBe("verified"); expect(appendCount).toBe(1); });
  it("does not claim success when no matching operation exists", async () => { const s = await setup(); f.call.mockRejectedValue(new Error("timeout")); exists = false; const result = await s.remember("project", "Verified test memory", "project", "procedure", "session"); expect(result.state).toBe("unknown"); expect((await s.reconcileMemory("project", result.operationId)).state).toBe("unknown"); expect(f.call).toHaveBeenCalledTimes(1); });
  it("preserves an externally edited note instead of rewriting it", async () => { const s = await setup(); const result = await s.remember("project", "Verified test memory", "project", "procedure", "session"); body = "User changed actual content"; expect((await s.reconcileMemory("project", result.operationId)).state).toBe("changed"); expect(appendCount).toBe(1); });
  it("denies personal writes unless configured", async () => { const s = await setup(); await expect(s.remember("project", "Explicit preference", "personal", "preference", "session")).rejects.toThrow(); expect(appendCount).toBe(0); });
  it("blocks not-yet-submitted writes after turn cancellation", async () => { const s = await setup(); s.cancelMemoryTurn("session"); await expect(s.remember("project", "Verified test memory", "project", "procedure", "session")).rejects.toThrow(); expect(appendCount).toBe(0); });
  it("denies revoked sessions", async () => { const s = await setup(); s.unregisterMemorySession("session"); await expect(s.callMemoryTool("session", "memory_search", { query: "test" })).rejects.toThrow(); });
  it("reads fresh content after search, not the snippet", async () => { const s = await setup(); const found = await s.callMemoryTool("session", "memory_search", { query: "test" }); const { z } = await import("zod"); const parsed = z.object({ candidates: z.array(z.object({ ref: z.string() })) }).parse(found); body = "Updated actual content"; expect(await s.callMemoryTool("session", "memory_read", { refs: [parsed.candidates[0].ref] })).toMatchObject({ items: [{ text: "Updated actual content" }] }); });
  it("discards stale search hits after deletion", async () => { const s = await setup(); const { z } = await import("zod"); const found = z.object({ candidates: z.array(z.object({ ref: z.string() })) }).parse(await s.callMemoryTool("session", "memory_search", { query: "test" })); exists = false; expect(await s.callMemoryTool("session", "memory_read", { refs: [found.candidates[0].ref] })).toMatchObject({ items: [] }); });
  it("invalidates candidates when bindings change", async () => { const s = await setup(); const { z } = await import("zod"); const found = z.object({ candidates: z.array(z.object({ ref: z.string() })) }).parse(await s.callMemoryTool("session", "memory_search", { query: "test" })); f.config = { ...f.config, revision: 1 }; await expect(s.callMemoryTool("session", "memory_read", { refs: [found.candidates[0].ref] })).rejects.toThrow(); });
  it("fails closed on foreign workspaces", async () => { const s = await setup(); f.probe.mockResolvedValue({ workspacePath: "C:/Other", version: "3.8.8" }); expect((await s.getMemoryStatus()).state).toBe("workspace-mismatch"); await expect(s.remember("project", "Verified test memory", "project", "procedure", "session")).rejects.toThrow(); });
  it("refuses secret-looking content", async () => { const s = await setup(); await expect(s.remember("project", "api_key=super-secret-value", "project", "procedure", "session")).rejects.toThrow(); expect(f.call).not.toHaveBeenCalled(); });
  it("rejects arbitrary tools and raw targets", async () => { const s = await setup(); await expect(s.callMemoryTool("session", "sql", {})).rejects.toThrow(); await expect(s.callMemoryTool("session", "memory_search", { query: "test", path: "/" })).rejects.toThrow(); });
  it("persists the turn quota and blocks a fourth write", async () => { const s = await setup(); for (let i = 0; i < 3; i++) await s.remember("project", "Verified note " + i, "project", "procedure", "session"); await expect(s.remember("project", "Fourth verified note", "project", "procedure", "session")).rejects.toThrow(); expect(appendCount).toBe(3); });
});
