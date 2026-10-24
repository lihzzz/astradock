import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationKey } from "@shared/lib/session-identity";
import { SessionRepository } from "../session-repository";
import { HistorySourceReader } from "../history/source";
import { HistoryStore } from "../history/store";

let root: string;
let repository: SessionRepository;
const session = (id = "old", thread = "thread") => ({
  projectId: "project", id, engine: "codex" as const, conversationId: "conversation", codexThreadId: thread,
  title: "Replacement", createdAt: 1, messages: [{ id: "m1", role: "user", content: "original", timestamp: 10 }],
});
const catalog = { projects: [{ id: "project", name: "Project", spaceId: "space" }], spaces: [{ id: "space", name: "Space" }] };
const scan = () => new HistorySourceReader(root).scan(catalog, new AbortController().signal, () => {});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-replacement-")); repository = new SessionRepository(root, vi.fn()); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("durable runtime replacement", () => {
  it("rejects old-ID saves, appends, metadata edits and starts across restart, including forged identity changes", async () => {
    await repository.save(session());
    await repository.save(session("new"), "old");
    for (const restart of [false, true]) {
      if (restart) repository = new SessionRepository(root, vi.fn());
      await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_REPLACED" });
      await expect(repository.save(session("old", "forged"))).rejects.toMatchObject({ code: "SESSION_REPLACED" });
      await expect(repository.append({ ...session(), appendedMessages: [], messageCount: 1 })).rejects.toMatchObject({ code: "SESSION_REPLACED" });
      await expect(repository.updateMeta("project", "old", { archived: true })).rejects.toMatchObject({ code: "SESSION_REPLACED" });
      await expect(repository.bindRuntime({ projectId: "project", runtimeSessionId: "old" }, "codex", "another", async () => {})).rejects.toMatchObject({ code: "SESSION_REPLACED" });
      expect(await repository.load("project", "old")).toBeNull();
      expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["new"]);
    }
    await expect(repository.save({ ...session(), projectId: "unrelated" })).resolves.toEqual(expect.any(Number));
  });

  it("preserves archive metadata and the new runtime lease when the logical identity changes", async () => {
    await repository.save(session());
    await repository.updateMeta("project", "old", { archived: true, pinned: true });
    const oldLease = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "old" }, "codex", "old", async () => {});
    const stop = vi.fn(async () => {});
    const lease = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "old" }, "codex", "new", stop);
    await repository.save(session("new", "new-thread"), "old");
    expect(() => oldLease.assertActive()).toThrow();
    expect(() => lease.assertActive()).not.toThrow();
    expect(await repository.load("project", "new")).toMatchObject({ archived: true, pinned: true });
    expect([...((await scan()).conversations.values())].map((item) => item.runtimeSessionId)).toEqual(["new"]);
    await expect(repository.remove("project", "old", async () => {})).resolves.toBe("deleted");
    expect(stop).toHaveBeenCalledOnce();
    expect(() => lease.assertActive()).toThrow();
    lease.release();
    oldLease.release();
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save(session("new", "new-thread"))).rejects.toMatchObject({ code: "SESSION_DELETED" });
    await expect(repository.save(session("old", "forged"))).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it("keeps a replacement chain deleted even when deletion is requested using its first runtime", async () => {
    await repository.save(session());
    await repository.save(session("second", "second-thread"), "old");
    await repository.save(session("third", "third-thread"), "second");
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.remove("project", "old", async (ids) => { expect(new Set(ids)).toEqual(new Set(["old", "second", "third"])); })).resolves.toBe("deleted");
    expect((await scan()).conversations.size).toBe(0);
    for (const id of ["old", "second", "third"]) await expect(repository.save(session(id, "untrusted"))).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it("rolls back an uncommitted replacement and does not overwrite an unrelated destination", async () => {
    await repository.save(session());
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("new.meta.json")) throw new Error("metadata unavailable");
      return rename(from, to);
    });
    await expect(repository.save(session("new"), "old")).rejects.toThrow("metadata unavailable");
    expect(await repository.load("project", "old")).not.toBeNull();
    expect(await repository.load("project", "new")).toBeNull();
    failure.mockRestore();
    await repository.save(session());
    await repository.save(session("occupied", "unrelated-thread"));
    await expect(repository.save(session("occupied"), "old")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await repository.load("project", "occupied")).toMatchObject({ codexThreadId: "unrelated-thread" });
    await expect(repository.save(session("unoccupied", "unrelated-thread"), "old")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(repository.save({ ...session("wrong-engine"), engine: "acp" }, "old")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("keeps committed retirement effective when old-file cleanup fails and retries it at startup", async () => {
    await repository.save(session());
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(`${path.sep}old.jsonl`)) throw new Error("old file locked");
      return unlink(file);
    });
    await expect(repository.save(session("new", "new-thread"), "old")).resolves.toEqual(expect.any(Number));
    expect(await repository.load("project", "old")).toBeNull();
    expect([...((await scan()).conversations.values())].map((item) => item.runtimeSessionId)).toEqual(["new"]);
    failure.mockRestore();
    repository = new SessionRepository(root, vi.fn());
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["new"]);
    await expect(fs.access(path.join(root, "sessions/project/old.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hides prepared targets and recovers a failed rollback without retiring the original", async () => {
    await repository.save(session());
    const rename = fs.rename.bind(fs);
    const unlink = fs.unlink.bind(fs);
    let recordWrites = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && ++recordWrites === 2) throw new Error("commit unavailable");
      return rename(from, to);
    });
    vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(`${path.sep}new.jsonl`)) throw new Error("rollback unavailable");
      return unlink(file);
    });
    await expect(repository.save(session("new", "new-thread"), "old")).rejects.toThrow();
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["old"]);
    expect([...((await scan()).conversations.values())].map((item) => item.runtimeSessionId)).toEqual(["old"]);
    vi.restoreAllMocks();
    repository = new SessionRepository(root, vi.fn());
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["old"]);
    await expect(repository.save(session())).resolves.toEqual(expect.any(Number));
    await expect(repository.save(session("retry"), "old")).resolves.toEqual(expect.any(Number));
  });

  it("coordinates a changed-identity handoff with deletion and rejects an old write queued behind it", async () => {
    await repository.save(session());
    const reached = deferred(); const release = deferred();
    const rename = fs.rename.bind(fs);
    let recordWrites = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && ++recordWrites === 2) { reached.resolve(); await release.promise; }
      return rename(from, to);
    });
    const replacing = repository.save(session("new", "new-thread"), "old");
    await reached.promise;
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["old"]);
    expect([...((await scan()).conversations.values())].map((item) => item.runtimeSessionId)).toEqual(["old"]);
    const late = repository.save(session("old", "forged")).then(() => "saved", (error: unknown) => error);
    const deleting = repository.remove("project", "old", async () => {});
    await vi.waitFor(() => expect(repository.isHistoryBlocked(conversationKey(session()))).toBe(true));
    release.resolve();
    await replacing;
    await expect(deleting).resolves.toBe("deleted");
    expect(await late).toMatchObject({ code: expect.stringMatching(/^SESSION_(REPLACED|DELETING|DELETED)$/) });
    expect(await repository.list("project")).toEqual([]);
    expect(await fs.readdir(path.join(root, "sessions/project"))).toEqual([]);
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save(session("new", "new-thread"))).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it.each([1, 2])("keeps the original usable if replacement record write %i fails", async (failedWrite) => {
    await repository.save(session());
    const rename = fs.rename.bind(fs);
    let writes = 0;
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && ++writes === failedWrite) throw new Error("record unavailable");
      return rename(from, to);
    });
    await expect(repository.save(session("new"), "old")).rejects.toThrow("record unavailable");
    expect(await repository.load("project", "new")).toBeNull();
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["old"]);
    expect(await fs.readdir(path.join(root, "sessions/.replacements"))).toEqual([]);
    failure.mockRestore();
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save(session())).resolves.toEqual(expect.any(Number));
  });

  it("rejects a damaged replacement record and resumes initialization after repair", async () => {
    await repository.save(session()); await repository.save(session("new"), "old");
    const folder = path.join(root, "sessions/.replacements");
    const file = path.join(folder, (await fs.readdir(folder))[0]);
    const valid = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "damaged");
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save(session())).rejects.toMatchObject({ code: "REPLACEMENT_STATE_INVALID" });
    await fs.writeFile(file, valid);
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    expect(await repository.load("project", "new")).not.toBeNull();
  });

  it("rejects an invalid incoming logical identity before persisting a replacement record", async () => {
    await repository.save(session());
    await expect(repository.save({ ...session("new"), codexThreadId: "", conversationId: 42 }, "old")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    repository = new SessionRepository(root, vi.fn());
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["old"]);
    await expect(fs.access(path.join(root, "sessions/.replacements"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits only one concurrent replacement of the same source", async () => {
    await repository.save(session());
    const results = await Promise.allSettled([repository.save(session("first", "first-thread"), "old"), repository.save(session("second", "second-thread"), "old")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await repository.list("project")).toHaveLength(1);
    expect((await scan()).conversations.size).toBe(1);
  });

  it("reconciles a replacement committed during the last index rebuild visibility check", async () => {
    await repository.save(session());
    const store = new HistoryStore(root, () => {}); store.setCatalog(catalog);
    try {
      await store.ready();
      const original = HistorySourceReader.prototype.replacementVisibility;
      let reads = 0;
      vi.spyOn(HistorySourceReader.prototype, "replacementVisibility").mockImplementation(async function (this: HistorySourceReader) {
        if (++reads === 3) await repository.save(session("new", "new-thread"), "old");
        return original.call(this);
      });
      await store.refresh(true);
      expect([...store.context().snapshot.conversations.values()].map((item) => item.runtimeSessionId)).toEqual(["new"]);
      expect(store.candidates("original")?.size).toBe(1);
      expect(store.status().coverage).toMatchObject({ discovered: 1, indexed: 1 });
    } finally { await store.close(); }
  });

  it("retires all legacy snapshots when a replacement rewinds to an earlier message", async () => {
    await repository.save(session("legacy"));
    await repository.save({ ...session(), messages: [{ id: "m2", role: "user", content: "newer", timestamp: 100 }] });
    await repository.updateMeta("project", "old", { archived: true });
    await repository.save({ ...session("new"), messages: [{ id: "m0", role: "user", content: "rewound", timestamp: 1 }] }, "old");
    for (const restart of [false, true]) {
      if (restart) repository = new SessionRepository(root, vi.fn());
      expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["new"]);
      const history = [...(await scan()).conversations.values()];
      expect(history.map((item) => item.runtimeSessionId)).toEqual(["new"]);
      expect(history[0].entries[1].displayText).toBe("rewound");
      expect(history[0].archived).toBe(true);
      await expect(repository.save(session("legacy", "forged"))).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    }
    await expect(repository.remove("project", "legacy", async (ids) => { expect(new Set(ids)).toEqual(new Set(["old", "legacy", "new"])); })).resolves.toBe("deleted");
  });

  it("remaps an identity without changing its runtime ID and preserves the active lease", async () => {
    await repository.save(session());
    await repository.updateMeta("project", "old", { archived: true });
    const stop = vi.fn(async () => {});
    const lease = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "old" }, "codex", "old", stop);
    await repository.save(session("old", "promoted-thread"));
    expect(() => lease.assertActive()).not.toThrow();
    expect(await repository.load("project", "old")).toMatchObject({ codexThreadId: "promoted-thread", archived: true });
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    await repository.save(session("old", "latest-thread"));
    expect((await scan()).conversations.has(conversationKey(session()))).toBe(false);
    expect((await scan()).conversations.has(conversationKey(session("old", "latest-thread")))).toBe(true);
    await repository.remove("project", "old", async () => {});
    expect(stop).toHaveBeenCalledOnce(); lease.release();
    repository = new SessionRepository(root, vi.fn());
    for (const thread of ["thread", "promoted-thread", "latest-thread"]) await expect(repository.save(session("old", thread))).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it("exposes the original snapshot until an in-place append identity change commits", async () => {
    await repository.save(session());
    const reached = deferred(); const release = deferred(); const rename = fs.rename.bind(fs);
    let writes = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && String(to).endsWith(".json") && ++writes === 2) { reached.resolve(); await release.promise; }
      return rename(from, to);
    });
    const task = repository.append({ ...session("old", "new-thread"), appendedMessages: [{ id: "m2", role: "user", content: "appended", timestamp: 20 }], messageCount: 2 });
    await reached.promise;
    expect(await repository.load("project", "old")).toMatchObject({ codexThreadId: "thread", messages: session().messages });
    expect([...((await scan()).conversations.keys())]).toEqual([conversationKey(session())]);
    release.resolve(); await task;
    expect(await repository.load("project", "old")).toMatchObject({ codexThreadId: "new-thread", messages: [session().messages[0], expect.objectContaining({ id: "m2" })] });
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.append({ ...session(), appendedMessages: [], messageCount: 2 })).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    await expect(repository.updateMeta("project", "old", { archived: true })).resolves.toEqual(expect.any(Number));
  });

  it.each([false, true])("restores legacy JSON after a failed in-place commit (rollback failure: %s)", async (failRollback) => {
    const folder = path.join(root, "sessions/project"); await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "old.json"), JSON.stringify(session()));
    const rename = fs.rename.bind(fs);
    let writes = 0; let commitFailed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && String(to).endsWith(".json") && ++writes === 2) { commitFailed = true; throw new Error("commit unavailable"); }
      if (failRollback && commitFailed && String(to) === path.join(folder, "old.json")) throw new Error("rollback unavailable");
      return rename(from, to);
    });
    await expect(repository.save(session("old", "new-thread"))).rejects.toThrow("commit unavailable");
    expect(await repository.load("project", "old")).toMatchObject({ codexThreadId: "thread", messages: session().messages });
    expect([...((await scan()).conversations.keys())]).toEqual([conversationKey(session())]);
    vi.restoreAllMocks();
    repository = new SessionRepository(root, vi.fn());
    expect((await repository.list("project")).map((meta) => meta.codexThreadId)).toEqual(["thread"]);
    expect(JSON.parse(await fs.readFile(path.join(folder, "old.json"), "utf8"))).toEqual(session());
    await expect(fs.access(path.join(folder, "old.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(repository.save(session("old", "retry-thread"))).resolves.toEqual(expect.any(Number));
  });

  it("queues a legacy alias writer behind the handoff even if it reports another logical key", async () => {
    await repository.save(session("legacy")); await repository.save(session());
    const reached = deferred(); const release = deferred(); const rename = fs.rename.bind(fs);
    let writes = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && String(to).endsWith(".json") && ++writes === 2) { reached.resolve(); await release.promise; }
      return rename(from, to);
    });
    const replacement = repository.save(session("new"), "old");
    await reached.promise;
    const late = repository.save(session("legacy", "forged")).then(() => "saved", (error: unknown) => error);
    release.resolve(); await replacement;
    expect(await late).toMatchObject({ code: "SESSION_REPLACED" });
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["new"]);
  });

  it.each(["conversation", "project"])("does not restore a prepared backup after %s deletion", async (scope) => {
    await repository.save(session());
    const rename = fs.rename.bind(fs); let writes = 0; let commitFailed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && String(to).endsWith(".json") && ++writes === 2) { commitFailed = true; throw new Error("commit unavailable"); }
      if (commitFailed && String(to) === path.join(root, "sessions/project/old.jsonl")) throw new Error("rollback unavailable");
      return rename(from, to);
    });
    await expect(repository.save(session("old", "new-thread"))).rejects.toThrow("commit unavailable");
    vi.restoreAllMocks();
    if (scope === "conversation") await repository.remove("project", "old", async () => {});
    else await repository.removeProject("project", async () => {});
    expect((await fs.readdir(path.join(root, "sessions/.replacements"))).filter((name) => name.endsWith(".backup"))).toEqual([]);
    repository = new SessionRepository(root, vi.fn());
    expect(await repository.list("project")).toEqual([]);
    expect(await repository.load("project", "old")).toBeNull();
    await expect(repository.save(session("old", "new-thread"))).rejects.toMatchObject({ code: scope === "project" ? "PROJECT_DELETED" : "SESSION_DELETED" });
    expect((await scan()).conversations.size).toBe(0);
  });

  it.each(["conversation", "project"])("recovers interrupted %s deletion before attempting identity rollback", async (scope) => {
    await repository.save(session());
    const rename = fs.rename.bind(fs); let writes = 0; let commitFailed = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.replacements${path.sep}`) && String(to).endsWith(".json") && ++writes === 2) { commitFailed = true; throw new Error("commit unavailable"); }
      if (commitFailed && String(to) === path.join(root, "sessions/project/old.jsonl")) throw new Error("rollback unavailable");
      return rename(from, to);
    });
    await expect(repository.save(session("old", "new-thread"))).rejects.toThrow();
    vi.restoreAllMocks();
    if (scope === "conversation") {
      const unlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
        if (String(file) === path.join(root, "sessions/project/old.jsonl")) throw new Error("source locked");
        return unlink(file);
      });
      await expect(repository.remove("project", "old", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    } else {
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
        if (String(file) === path.join(root, "sessions/project")) throw new Error("project locked");
        return rm(file, options);
      });
      await expect(repository.removeProject("project", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    }
    expect((await fs.readdir(path.join(root, "sessions/.replacements"))).some((name) => name.endsWith(".backup"))).toBe(true);
    vi.restoreAllMocks(); repository = new SessionRepository(root, vi.fn());
    expect(await repository.list("project")).toEqual([]);
    expect(await repository.pendingDeletions()).toEqual([]);
    expect((await fs.readdir(path.join(root, "sessions/.replacements"))).some((name) => name.endsWith(".backup"))).toBe(false);
    await expect(fs.access(path.join(root, "sessions/project/old.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a deletion barrier when a committed in-place backup cannot be removed", async () => {
    await repository.save(session());
    const rm = fs.rm.bind(fs);
    const failure = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file).endsWith(".json.backup")) throw new Error("backup locked");
      return rm(file, options);
    });
    await expect(repository.save(session("old", "new-thread"))).resolves.toEqual(expect.any(Number));
    await expect(repository.remove("project", "old", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    expect(await repository.load("project", "old")).toBeNull();
    failure.mockRestore();
    repository = new SessionRepository(root, vi.fn());
    expect(await repository.list("project")).toEqual([]);
    expect(await repository.pendingDeletions()).toEqual([]);
    expect((await fs.readdir(path.join(root, "sessions/.replacements"))).filter((name) => name.endsWith(".backup"))).toEqual([]);
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it("rejects a backup failure before changing the source and removes orphan backups at startup", async () => {
    await repository.save(session());
    const copy = fs.copyFile.bind(fs);
    const failure = vi.spyOn(fs, "copyFile").mockImplementation(async (from, to, mode) => {
      if (String(from).endsWith("old.meta.json")) throw new Error("backup unavailable");
      return copy(from, to, mode);
    });
    await expect(repository.save(session("old", "new-thread"))).rejects.toThrow("backup unavailable");
    expect(await repository.load("project", "old")).toMatchObject({ codexThreadId: "thread" });
    expect(await fs.readdir(path.join(root, "sessions/.replacements"))).toEqual([]);
    failure.mockRestore();
    const orphan = path.join(root, "sessions/.replacements", "a".repeat(64) + ".json.backup");
    await fs.mkdir(orphan); await fs.writeFile(path.join(orphan, "old.json"), JSON.stringify(session()));
    repository = new SessionRepository(root, vi.fn());
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["old"]);
    await expect(fs.access(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads the first version of runtime replacement records without alias or backup fields", async () => {
    await repository.save(session()); await repository.save(session("new"), "old");
    const folder = path.join(root, "sessions/.replacements"); const file = path.join(folder, (await fs.readdir(folder))[0]);
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    delete record.retiredIds; delete record.backupFormats;
    await fs.writeFile(file, JSON.stringify(record));
    repository = new SessionRepository(root, vi.fn());
    expect((await repository.list("project")).map((meta) => meta.id)).toEqual(["new"]);
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_REPLACED" });
  });

  it("does not overwrite a committed handoff record when its target snapshot is missing", async () => {
    await repository.save(session()); await repository.save(session("new"), "old");
    await fs.unlink(path.join(root, "sessions/project/new.jsonl"));
    await fs.unlink(path.join(root, "sessions/project/new.meta.json"));
    await repository.save(session("other", "other-thread"));
    await expect(repository.save(session("new", "other-thread"), "other")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    expect(await repository.load("project", "other")).not.toBeNull();
  });
});
