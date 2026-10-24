import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRepository } from "../session-repository";
import { parseSessionJsonl } from "../session-jsonl";
let root: string; let repo: SessionRepository;
const data = { id: "s", projectId: "p", title: "original", createdAt: 1, messages: [{ id: "m1", role: "user", content: "one", timestamp: 1 }] };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-integrity-")); repo = new SessionRepository(root); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("session snapshot integrity", () => {
  it("rejects an old full snapshot and lets a title patch preserve newer messages", async () => {
    await repo.save(data); const stale = (await repo.load("p", "s"))!;
    await repo.save({ ...data, messages: [...data.messages, { id: "m2", role: "assistant", content: "new", timestamp: 2 }] });
    await expect(repo.save({ ...stale, title: "renamed" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await repo.updateMeta("p", "s", { title: "renamed", model: "new-model" });
    const current = (await repo.load("p", "s"))!;
    expect(current.messages).toHaveLength(2); expect(current.title).toBe("renamed");
    await repo.append({ ...data, persistenceRevision: current.persistenceRevision, appendedMessages: [], messageCount: 2 });
    expect(await repo.load("p", "s")).toMatchObject({ title: "renamed", model: "new-model" });
  });
  it("repairs a torn tail before another append, including metadata-only updates", async () => {
    await repo.save(data); const file = path.join(root, "sessions/p/s.jsonl");
    await fs.appendFile(file, '{"type":"msg","msg":{"id":"cut');
    await repo.append({ ...data, totalCost: 99, appendedMessages: [], messageCount: 10 });
    expect(await repo.load("p", "s")).toMatchObject({ totalCost: 99 });
    await fs.appendFile(file, '{"type":');
    await repo.updateMeta("p", "s", { title: "repaired" });
    expect(await repo.load("p", "s")).toMatchObject({ title: "repaired" });
  });
  it("preserves a complete final record that is missing only its newline", async () => {
    await repo.save(data); const file = path.join(root, "sessions/p/s.jsonl");
    await fs.appendFile(file, JSON.stringify({ type: "msg", msg: { id: "last", role: "assistant", content: "kept" } }));
    await repo.updateMeta("p", "s", { pinned: true });
    expect((await repo.load("p", "s"))?.messages).toHaveLength(2);
  });
  it("uses authoritative JSONL metadata after a sidecar write was lost", async () => {
    await repo.save(data); const file = path.join(root, "sessions/p/s.jsonl");
    await fs.appendFile(file, JSON.stringify({ type: "header", title: "committed", persistenceRevision: 2 }) + "\n");
    await fs.utimes(path.join(root, "sessions/p/s.meta.json"), new Date(1000), new Date(1000));
    expect(await repo.currentMetadata("p", "s")).toMatchObject({ title: "committed", persistenceRevision: 2 });
  });
  it("ignores malformed JSONL record shapes", () => {
    expect(parseSessionJsonl('null\n42\n[]\n{"type":"msg","msg":null}\n')).toEqual({ messages: [] });
  });
  it("rejects invalid metadata without allowing it to replace messages", async () => {
    await repo.save(data);
    await expect(repo.updateMeta("p", "s", { title: "x".repeat(10001) })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((await repo.load("p", "s"))?.messages).toHaveLength(1);
  });
});
