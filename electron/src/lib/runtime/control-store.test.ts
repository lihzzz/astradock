import { removeFixture } from "./testing/fixture";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OperationJournal } from "./journal";
import { RuntimeControlStore } from "./control-store";
import type { RuntimeCommand } from "@shared/types/runtime";
let dir: string; let stores: RuntimeControlStore[]; let journals: OperationJournal[];
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-runtime-")); stores = []; journals = []; });
afterEach(async () => {
  await Promise.all(stores.map(s => s.close())); await Promise.all(journals.map(j => j.close()));
  await removeFixture(dir, "astradock-runtime-");
});
async function open(initial = true) {
  const journal = new OperationJournal(dir); const store = new RuntimeControlStore(journal, () => 10); stores.push(store);
  if (initial) await store.initializeProfile([{ id: "t", projectId: "p", legacyKey: '["p","codex","native"]', engine: "codex", runtimeId: "runtime", runtimeGeneration: 1, revision: 0 }], 1);
  return store;
}
function command(id = "c", revision = 0): RuntimeCommand {
  return { commandId: id, threadId: "t", projectId: "p", writerGeneration: 1, runtimeGeneration: 1, expectedRevision: revision,
    intent: { kind: "send", clientMessageId: `message-${id}`, text: "hello" } };
}
describe("durable runtime control", () => {
  it("deduplicates concurrent requests and after reopening without executing", async () => {
    const store = await open(); const [a, b] = await Promise.all([store.accept("desktop", command()), store.accept("desktop", command())]);
    expect(a).toEqual(b); expect((await store.snapshot("t")).runs).toHaveLength(1);
    await store.close(); const reopened = await open(false);
    expect(await reopened.accept("desktop", command())).toEqual(a);
    expect((await reopened.snapshot("t")).runs).toHaveLength(1);
  });
  it("rejects reused payload, stale revision and generation before acceptance", async () => {
    const store = await open(); await store.accept("desktop", command());
    await expect(store.accept("desktop", { ...command(), intent: { kind: "send", clientMessageId: "message-c", text: "changed" } })).rejects.toThrow("COMMAND_ID_REUSED");
    await expect(store.accept("desktop", command("second"))).rejects.toThrow("REVISION_CONFLICT");
    await expect(store.accept("desktop", { ...command(), writerGeneration: 0 })).rejects.toThrow("WRITER_REPLACED");
    await expect(store.accept("desktop", { ...command(), runtimeGeneration: 0 })).rejects.toThrow("RUNTIME_REPLACED");
  });
  it("allows identical text as a new message but not identity laundering", async () => {
    const store = await open(); await store.accept("desktop", command());
    await expect(store.accept("desktop", { ...command("other", 1), intent: command().intent })).rejects.toThrow("Query the original");
    await store.accept("desktop", command("other", 1)); expect((await store.snapshot("t")).runs).toHaveLength(2);
  });
  it("scopes principal ids without overwriting runs", async () => {
    const store = await open(); await store.accept("a", command()); await store.accept("b", command("c", 1));
    const runs = (await store.snapshot("t")).runs; expect(runs).toHaveLength(2); expect(runs[0].id).not.toBe(runs[1].id);
  });
  it("keeps ambiguous provider dispatch unknown across restart", async () => {
    const store = await open(); await store.accept("desktop", command());
    const run = (await store.snapshot("t")).runs[0]; await store.updateRun(run.id, "starting", 1); await store.updateRun(run.id, "running", 1);
    await store.setReceipt("desktop", "c", "dispatching"); await store.close();
    const reopened = await open(false); await reopened.recoverAfterProcessLoss(); const state = await reopened.snapshot("t");
    expect(state.runs[0].status).toBe("unknown"); expect(state.receipts[0].status).toBe("unknown");
    await expect(reopened.setReceipt("desktop", "c", "dispatching")).rejects.toThrow("INVALID_COMMAND_TRANSITION");
  });
  it("only starts one root run and treats requests as live-only", async () => {
    const store = await open(); await store.accept("desktop", command()); await store.accept("desktop", command("second", 1));
    const [a, b] = (await store.snapshot("t")).runs; await store.updateRun(a.id, "starting", 1);
    await expect(store.updateRun(b.id, "starting", 1)).rejects.toThrow("THREAD_BUSY");
    await store.addRequest({ id: "req", threadId: "t", runId: a.id, runtimeGeneration: 1, revision: 0, status: "pending", decision: null });
    await store.recoverAfterProcessLoss();
    await expect(store.accept("desktop", { ...command("approval", 2), intent: { kind: "approval", requestId: "req", requestRevision: 0, decision: "allow" } })).rejects.toThrow("REQUEST_EXPIRED");
  });
  it("commits only one approval decision with CAS", async () => {
    const store = await open(); await store.accept("desktop", command()); const run = (await store.snapshot("t")).runs[0];
    await store.addRequest({ id: "req", threadId: "t", runId: run.id, runtimeGeneration: 1, revision: 0, status: "pending", decision: null });
    const response = { ...command("approval", 1), intent: { kind: "approval" as const, requestId: "req", requestRevision: 0, decision: "allow" as const } };
    await store.accept("desktop", response);
    await expect(store.accept("desktop", { ...response, commandId: "late", expectedRevision: 2 })).rejects.toThrow("REQUEST_EXPIRED");
    expect((await store.snapshot("t")).requests[0].decision).toBe("allow");
  });
  it("prevents two writers, repairs only a torn unacknowledged tail", async () => {
    const store = await open(); const second = new OperationJournal(dir); journals.push(second);
    await expect(second.open()).rejects.toThrow("locked");
    await store.accept("desktop", command()); await store.close(); await fs.appendFile(path.join(dir, "operations.jsonl"), '{"version":');
    const reopened = await open(false); expect((await reopened.snapshot("t")).runs).toHaveLength(1);
  });
  it("fails closed on complete corruption and preserves the file", async () => {
    const store = await open(); await store.close(); const file = path.join(dir, "operations.jsonl"); await fs.appendFile(file, '{}\n');
    const before = await fs.readFile(file, "utf8"); const broken = new OperationJournal(dir); journals.push(broken);
    await expect(broken.open()).rejects.toThrow(); expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("does not acknowledge or commit when the configured budget is exhausted", async () => {
    const journal = new OperationJournal(dir, 30); journals.push(journal); await journal.open();
    await expect(journal.append({ threads: [], runs: [], receipts: [], requests: [] })).rejects.toThrow("JOURNAL_LIMIT");
    expect(journal.lastSequence).toBe(0); expect(await fs.readFile(journal.file, "utf8")).toBe("");
  });
});
