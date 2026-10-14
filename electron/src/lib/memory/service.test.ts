import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectBankId } from "./bank-router";
const f = vi.hoisted(() => ({
  settings: { enabled: true, autoRetain: true, clientSideRedact: true, injectionPolicy: "every-turn", recallMaxTokens: 1024, recallMaxItems: 5, recallBudget: "low", recallTimeoutMs: 1000 },
  config: { memoryMode: "auto", memoryIsolated: false },
  retain: vi.fn(), recall: vi.fn(), remove: vi.fn(), update: vi.fn(),
}));
vi.mock("../app-settings", () => ({ getAppSettings: () => ({ memory: f.settings }) }));
vi.mock("../error-utils", () => ({ reportError: (_label: string, error: Error) => error.message }));
vi.mock("../posthog", () => ({ captureEvent: vi.fn() }));
vi.mock("./daemon", () => ({ getMemoryDaemonStatus: vi.fn(), getMemoryBaseUrl: () => "", isMemoryDaemonReady: () => true, startMemoryDaemon: vi.fn(), stopMemoryDaemon: vi.fn() }));
vi.mock("./secrets", () => ({ getMemoryLlmKey: vi.fn(), hasMemoryLlmKey: vi.fn(), setMemoryLlmKey: vi.fn(), clearMemoryLlmKey: vi.fn() }));
vi.mock("./project-config", () => ({ getMemoryProjectConfig: () => ({ ...f.config }), setMemoryProjectConfig: vi.fn() }));
vi.mock("./golden-set", () => ({ runMemoryGoldenSet: vi.fn() }));
vi.mock("./client", () => ({ retainMemory: f.retain, recallMemory: f.recall, deleteMemoryDocument: f.remove, updateMemoryUnit: f.update,
  ensureMemoryBank: vi.fn(), listMemoryBanks: vi.fn(), listMemoryDocuments: vi.fn(), listMemoryUnits: vi.fn(), resetMemoryClient: vi.fn() }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); f.settings.enabled = true; f.config.memoryIsolated = false; f.config.memoryMode = "auto";
  f.retain.mockResolvedValue({}); f.recall.mockResolvedValue([{ text: "Known preference" }]); f.remove.mockResolvedValue(true); f.update.mockResolvedValue(true);
});
describe("memory trust and control", () => {
  it("shows detached actual injected context and skips exactly one message", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude");
    await service.beforeMemorySend("s", "Recall question");
    const state = service.getMemoryRecallState("s"); expect(state?.items.length).toBe(2);
    if (state) state.items.length = 0;
    expect(service.getMemoryRecallState("s")?.items.length).toBe(2);
    service.setSkipNextMemoryRecall("s", true);
    expect((await service.beforeMemorySend("s", "Next question")).text).toBe("Next question");
    expect(service.getMemoryRecallState("s")).toEqual({ items: [], usedAt: null, skipNext: false });
    expect((await service.beforeMemorySend("s", "Another question")).text).toContain("harnss-memory");
    service.unregisterMemorySession("s"); expect(service.getMemoryRecallState("s")).toBeNull();
  });
  it("preserves a next-message skip selected while the current recall is in flight", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude");
    f.config.memoryIsolated = true;
    let resolveRecall!: (items: { text: string }[]) => void;
    f.recall.mockReturnValueOnce(new Promise<{ text: string }[]>((resolve) => { resolveRecall = resolve; }));
    const pending = service.beforeMemorySend("s", "Current question");
    service.setSkipNextMemoryRecall("s", true);
    resolveRecall([{ text: "Current recalled context" }]);
    expect((await pending).text).toContain("Current recalled context");
    expect(service.getMemoryRecallState("s")?.skipNext).toBe(true);
    expect((await service.beforeMemorySend("s", "Next question")).text).toBe("Next question");
    expect(f.recall).toHaveBeenCalledTimes(1);
    expect(service.getMemoryRecallState("s")).toEqual({ items: [], usedAt: null, skipNext: false });
    expect((await service.beforeMemorySend("s", "Following question")).text).toContain("harnss-memory");
    expect(f.recall).toHaveBeenCalledTimes(2);
  });
  it("returns a manual write failure and permits the next queued write", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude");
    f.retain.mockRejectedValueOnce(new Error("write failed"));
    expect(await service.retainManualMemory("s", "Remember this preference")).toMatchObject({ ok: false, error: "write failed" });
    expect(await service.retainManualMemory("s", "Try again")).toEqual({ ok: true });
    expect(f.retain.mock.calls[1][0]).toBe(projectBankId("p"));
  });
  it("does not report two unavailable writes as success", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude"); f.retain.mockResolvedValue(null);
    expect(await service.retainManualMemory("s", "Remember this preference")).toMatchObject({ ok: false });
    expect(f.retain).toHaveBeenCalledTimes(2);
  });
  it("retains automatic turns only in the project bank", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "codex");
    await service.beforeMemorySend("s", "Long enough user message"); service.observeCodexNotification("s", "item/agentMessage/delta", { delta: "Long enough assistant result" });
    await service.completeMemoryTurn("s"); expect(f.retain).toHaveBeenCalledTimes(1); expect(f.retain.mock.calls[0][0]).toBe(projectBankId("p"));
  });
  it("requires explicit personal scope and respects isolation", async () => {
    const service = await import("./service"); await service.retainProjectMemory("p", "Personal preference", "user");
    expect(f.retain.mock.calls[0][0]).toBe("harnss-user"); f.config.memoryIsolated = true;
    await expect(service.retainProjectMemory("p", "Personal preference", "user")).rejects.toThrow("isolated");
    await service.retainProjectMemory("p", "Project preference", "project"); expect(f.retain.mock.calls.at(-1)?.[0]).toBe(projectBankId("p"));
  });
  it("invalidates recall cache after edits and deletions", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude");
    await service.beforeMemorySend("s", "Recall question"); await service.beforeMemorySend("s", "Recall question"); expect(f.recall).toHaveBeenCalledTimes(2);
    await service.updateMemoryUnit("bank", "fact", { text: "Corrected" }); await service.beforeMemorySend("s", "Recall question"); expect(f.recall).toHaveBeenCalledTimes(4);
    await service.deleteMemoryDocument("bank", "doc"); await service.beforeMemorySend("s", "Recall question"); expect(f.recall).toHaveBeenCalledTimes(6);
  });
  it("discards in-flight recall after invalidation", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude");
    let resolve!: (items: { text: string }[]) => void;
    f.recall.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = service.beforeMemorySend("s", "Recall question"); service.invalidateMemoryCache(); resolve([{ text: "Stale fact" }]);
    expect((await pending).text).toBe("Recall question");
  });
  it("does not inject after the user disables memory while recalling", async () => {
    const service = await import("./service"); service.registerMemorySession("s", "p", "claude");
    let resolve!: (items: { text: string }[]) => void;
    f.recall.mockReturnValue(new Promise((done) => { resolve = done; }));
    const pending = service.beforeMemorySend("s", "Recall question"); f.settings.enabled = false; resolve([{ text: "Stale fact" }]);
    expect((await pending).text).toBe("Recall question");
  });
  it("rechecks disabled retention when a queued write starts", async () => {
    const service = await import("./service");
    let release!: (value: object) => void; f.retain.mockReturnValueOnce(new Promise<object>((done) => { release = done; }));
    const first = service.retainProjectMemory("p", "First note", "project"); await vi.waitFor(() => expect(f.retain).toHaveBeenCalledOnce());
    const second = service.retainProjectMemory("p", "Second note", "project");
    const rejected = expect(second).rejects.toThrow("disabled"); f.settings.enabled = false; release({});
    await first; await rejected;
  });
});
