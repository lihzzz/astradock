import { removeFixture } from "./testing/fixture";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCoordinator, type ProviderRuntime } from "./coordinator";
import { OperationJournal } from "./journal";
import { RuntimeControlStore } from "./control-store";
import { resolveCapabilities } from "@shared/lib/runtime/capabilities";
let directory: string, store: RuntimeControlStore, coordinator: RuntimeCoordinator | null;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-coordinator-")); coordinator = null;
  store = new RuntimeControlStore(new OperationJournal(directory));
  await store.initializeProfile([{ id: "t", projectId: "p", engine: "codex", runtimeId: "native", runtimeGeneration: 1, legacyKey: "legacy", revision: 0 }], 1);
});
afterEach(async () => { await coordinator?.close(); await store.close(); await removeFixture(directory, "astradock-coordinator-"); });
const capability = { status: "supported" as const, reason: "fixture boundary", evidence: "synthetic" };
const command = (id: string, revision: number) => ({ commandId: id, threadId: "t", projectId: "p", writerGeneration: 1, runtimeGeneration: 1, expectedRevision: revision, intent: { kind: "send", clientMessageId: id, text: "same text" } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
describe("headless runtime coordinator", () => {
  it("dispatches each accepted intent once and reuses a single runtime", async () => {
    const execute = vi.fn<ProviderRuntime["execute"]>().mockResolvedValue("completed"); const open = vi.fn(async () => ({ execute, interrupt: async () => {}, respond: async () => {}, close: async () => {} }));
    coordinator = new RuntimeCoordinator(store, () => ({ capabilities: resolveCapabilities({}), open }), error => { throw error; });
    await Promise.all([coordinator.submit("desktop", command("one", 0)), coordinator.submit("desktop", command("one", 0))]);
    await coordinator.submit("desktop", command("two", 1)); await coordinator.idle();
    expect(open).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledTimes(2);
    expect((await store.snapshot("t")).runs.map(run => run.status)).toEqual(["completed", "completed"]);
  });
  it("keeps uncertain execution blocked rather than retrying or draining later sends", async () => {
    const execute = vi.fn<ProviderRuntime["execute"]>().mockRejectedValue(new Error("response lost")); const errors: unknown[] = [];
    coordinator = new RuntimeCoordinator(store, () => ({ capabilities: resolveCapabilities({}), open: async () => ({ execute, interrupt: async () => {}, respond: async () => {}, close: async () => {} }) }), error => errors.push(error));
    await coordinator.submit("desktop", command("one", 0)); await coordinator.idle();
    await coordinator.submit("desktop", command("two", 1)); await coordinator.idle();
    expect(execute).toHaveBeenCalledOnce(); expect(errors).toHaveLength(1);
    expect((await store.snapshot("t")).runs.map(run => run.status)).toEqual(["unknown", "queued"]);
  });
  it("does not complete a run merely because interrupt was acknowledged", async () => {
    const end = deferred<"interrupted">(), started = deferred<void>();
    const interrupt = vi.fn(async () => {});
    coordinator = new RuntimeCoordinator(store, () => ({ capabilities: resolveCapabilities({ interrupt: capability }), open: async () => ({ execute: async () => { started.resolve(); return end.promise; }, interrupt, respond: async () => {}, close: async () => { end.resolve("interrupted"); } }) }), error => { throw error; });
    await coordinator.submit("desktop", command("one", 0)); await started.promise;
    const run = (await store.snapshot("t")).runs[0];
    const stop = { ...command("stop", 1), intent: { kind: "interrupt", runId: run.id } };
    await Promise.all([coordinator.submit("desktop", stop), coordinator.submit("desktop", stop)]);
    await vi.waitFor(() => expect(interrupt).toHaveBeenCalledOnce());
    expect((await store.snapshot("t")).runs[0].status).toBe("running");
    end.resolve("interrupted"); await coordinator.idle(); expect((await store.snapshot("t")).runs[0].status).toBe("interrupted");
  });
  it("resolves a live approval once without racing the root terminal state", async () => {
    const waiting = deferred<void>(), end = deferred<"completed">(); const errors: unknown[] = [];
    const respond = vi.fn(async () => { end.resolve("completed"); });
    coordinator = new RuntimeCoordinator(store, () => ({ capabilities: resolveCapabilities({ approval: capability }), open: async () => ({
      execute: async context => { await context.request("request"); waiting.resolve(); return end.promise; }, respond, interrupt: async () => {}, close: async () => { end.resolve("completed"); },
    }) }), error => errors.push(error));
    await coordinator.submit("desktop", command("one", 0)); await waiting.promise;
    await coordinator.submit("desktop", { ...command("answer", 1), intent: { kind: "approval", requestId: "request", requestRevision: 0, decision: "allow" } });
    await coordinator.idle(); expect(errors).toHaveLength(0); expect(respond).toHaveBeenCalledOnce();
    expect((await store.snapshot("t")).runs[0].status).toBe("completed");
  });
});
