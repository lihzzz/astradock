import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRepository } from "../session-repository";
let root: string; let repo: SessionRepository;
const messages = [{ id: "user", role: "user", content: "question", timestamp: 1 },
  { id: "answer", role: "assistant", content: "answer", timestamp: 2 }];
const data = { id: "s", projectId: "p", title: "history", createdAt: 1, messages };
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "session-guard-")); repo = new SessionRepository(root); await repo.save(data); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("ordinary snapshots cannot remove persisted history", () => {
  it.each([undefined, 1])("rejects a partial snapshot even with revision %s", async (persistenceRevision) => {
    const file = path.join(root, "sessions/p/s.jsonl"); const original = await fs.readFile(file);
    const meta = await fs.readFile(path.join(root, "sessions/p/s.meta.json"));
    await expect(repo.save({ ...data, persistenceRevision, messages: messages.slice(1) })).rejects.toMatchObject({ code: "INCOMPLETE_SNAPSHOT" });
    expect(await fs.readFile(file)).toEqual(original);
    expect(await fs.readFile(path.join(root, "sessions/p/s.meta.json"))).toEqual(meta);
    expect((await new SessionRepository(root).load("p", "s"))?.messages).toEqual(messages);
  });
  it("rejects replacement IDs even when the incoming list is longer", async () => {
    await expect(repo.save({ ...data, messages: [messages[1], { ...messages[0], id: "new" }, { ...messages[0], id: "new2" }] })).rejects.toMatchObject({ code: "INCOMPLETE_SNAPSHOT" });
  });
  it("allows editing content, appending messages, and explicit history replacement", async () => {
    await repo.save({ ...data, messages: [{ ...messages[0], content: "short" }, messages[1]] });
    await repo.append({ id: "s", projectId: "p", appendedMessages: [{ ...messages[1], id: "third" }], messageCount: 3 });
    expect((await repo.load("p", "s"))?.messages).toHaveLength(3);
    await repo.save({ ...data, messages: messages.slice(0, 1) }, "s");
    expect((await repo.load("p", "s"))?.messages).toHaveLength(1);
  });
  it("checks inside the write lock and leaves other sessions and usage files untouched", async () => {
    await repo.save({ ...data, id: "other" });
    const other = await fs.readFile(path.join(root, "sessions/p/other.jsonl"));
    const usage = path.join(root, "usage-tokens.json"); await fs.writeFile(usage, "unchanged");
    // Gate the first atomic rename so the second request is definitely queued
    // behind a writer holding the lock (pre-lock metadata I/O can reorder calls).
    let entered!: () => void; let release!: () => void;
    const insideWrite = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename.bind(fs); let blocked = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!blocked && to === path.join(root, "sessions/p/s.jsonl")) { blocked = true; entered(); await gate; }
      return rename(from, to);
    });
    try {
      const first = repo.save({ ...data, messages: [...messages, { ...messages[1], id: "third" }] });
      await insideWrite;
      const second = repo.save(data); release();
      const results = await Promise.allSettled([first, second]);
      expect(results[0].status).toBe("fulfilled");
      expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "INCOMPLETE_SNAPSHOT" } });
    } finally { release(); spy.mockRestore(); }
    expect(await fs.readFile(path.join(root, "sessions/p/other.jsonl"))).toEqual(other);
    expect(await fs.readFile(usage, "utf8")).toBe("unchanged");
  });
});
