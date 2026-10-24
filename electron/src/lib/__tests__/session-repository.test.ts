import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRepository } from "../session-repository";
import { conversationKey } from "@shared/lib/session-identity";

let root: string;
let repository: SessionRepository;
const session = (id = "one") => ({
  id, projectId: "project", conversationId: "conversation", engine: "codex" as const,
  codexThreadId: "thread", title: "Original", createdAt: 1,
  messages: [{ id: "m1", role: "user", content: "hello", timestamp: 10 }],
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-repository-"));
  repository = new SessionRepository(root, vi.fn());
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("logical session coordination", () => {
  it("uses an unambiguous, engine-aware identity and Codex thread IDs", () => {
    expect(conversationKey(session("one"))).toBe(conversationKey(session("resumed")));
    expect(conversationKey({ ...session(), engine: "acp" })).not.toBe(conversationKey(session()));
    expect(conversationKey({ id: "c", projectId: "a/b", conversationId: "d" }))
      .not.toBe(conversationKey({ id: "c", projectId: "a", conversationId: "b/d" }));
  });

  it("preserves authoritative archive and pin changes through stale saves and resumes", async () => {
    await repository.save(session());
    await repository.updateMeta("project", "one", { archived: true, pinned: true, folderId: "folder" });
    await repository.save({ ...session(), archived: false, pinned: false });
    await repository.save(session("resumed"), "one");
    expect(await repository.load("project", "resumed")).toMatchObject({ archived: true, pinned: true, folderId: "folder" });
    await repository.updateMeta("project", "resumed", { archived: false, pinned: false, folderId: null });
    await repository.append({ ...session("resumed"), archived: true, pinned: true, folderId: "folder", appendedMessages: [], messageCount: 1 });
    expect(await repository.load("project", "resumed")).toMatchObject({ archived: false, pinned: false, folderId: null });
  });

  it("rejects late save, append and metadata writes after deletion, including after restart", async () => {
    await repository.save(session());
    await repository.remove("project", "one", async () => {});
    repository = new SessionRepository(root);
    await expect(repository.save(session("late-runtime"))).rejects.toMatchObject({ code: "SESSION_DELETED" });
    await expect(repository.append({ ...session(), appendedMessages: [], messageCount: 1 })).rejects.toMatchObject({ code: "SESSION_DELETED" });
    await expect(repository.updateMeta("project", "one", { archived: true })).rejects.toMatchObject({ code: "SESSION_DELETED" });
    expect(await repository.list("project")).toEqual([]);
    expect(await repository.load("project", "one")).toBeNull();
  });

  it("freezes all aliases before stopping and rolls back when stopping fails", async () => {
    await repository.save(session());
    await repository.save(session("two"));
    let stopped: string[] = [];
    await expect(repository.remove("project", "two", async (ids) => {
      stopped = ids;
      await expect(repository.save(session("late"))).rejects.toMatchObject({ code: "SESSION_DELETING" });
      throw new Error("engine did not stop");
    })).rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(stopped.sort()).toEqual(["one", "two"]);
    expect(await repository.load("project", "one")).not.toBeNull();
    await expect(repository.save(session("after-rollback"))).resolves.toEqual(expect.any(Number));
  });

  it("recovers pending deletion on startup and keeps unrelated conversations", async () => {
    await repository.save(session());
    await repository.save({ ...session("other"), codexThreadId: "other-thread" });
    const dir = path.join(root, "sessions", ".deletions");
    await fs.mkdir(dir, { recursive: true });
    const recordName = `${createHash("sha256").update(conversationKey(session())).digest("hex")}.json`;
    await fs.writeFile(path.join(dir, recordName), JSON.stringify({
      version: 1, conversationKey: conversationKey(session()), projectId: "project",
      runtimeIds: ["one"], state: "pending", unlinkStarted: true, updatedAt: 1,
    }));
    repository = new SessionRepository(root);
    expect(await repository.list("project")).toEqual([expect.objectContaining({ id: "other" })]);
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it("rejects path traversal before touching the filesystem", async () => {
    await expect(repository.save({ ...session(), projectId: "../escape" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(repository.load("project", "../../escape")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("isolates a failed startup deletion and permits retry using its durable identity", async () => {
    await repository.save(session());
    await repository.save({ ...session("healthy"), codexThreadId: "healthy-thread" });
    const unlink = fs.unlink.bind(fs);
    const failure = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
      if (String(file).endsWith(`${path.sep}one.jsonl`)) throw Object.assign(new Error("file locked"), { code: "EACCES" });
      return unlink(file);
    });
    await expect(repository.remove("project", "one", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    const report = vi.fn();
    repository = new SessionRepository(root, report);
    expect(await repository.list("project")).toEqual([expect.objectContaining({ id: "healthy" })]);
    expect(report).toHaveBeenCalledOnce();
    await expect(repository.save({ ...session("healthy"), codexThreadId: "healthy-thread" })).resolves.toEqual(expect.any(Number));
    await expect(repository.save(session("late"))).rejects.toMatchObject({ code: "SESSION_DELETING" });
    expect(await repository.pendingDeletions()).toEqual([expect.objectContaining({ conversationKey: conversationKey(session()), id: "one", state: "pending" })]);
    failure.mockRestore();
    await expect(repository.remove("project", "one", async () => {})).resolves.toBe("deleted");
    expect(await repository.pendingDeletions()).toEqual([]);
    await expect(repository.remove("project", "one", async () => {})).resolves.toBe("already_deleted");
  });

  it("retries after all snapshots were removed but the deletion commit failed", async () => {
    await repository.save(session());
    const rename = fs.rename.bind(fs);
    let deletionWrites = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.deletions${path.sep}`) && ++deletionWrites === 3) throw new Error("disk full");
      return rename(from, to);
    });
    await expect(repository.remove("project", "one", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    expect(await fs.readdir(path.join(root, "sessions/project"))).toEqual([]);
    expect(await repository.resolveDeletion("project", conversationKey(session()))).toMatchObject({ id: "one", state: "pending", title: "Original" });
    await expect(repository.remove("project", "one", async () => {})).resolves.toBe("deleted");
  });

  it("does not let a derived-index listener invalidate a committed source write", async () => {
    const report = vi.fn();
    repository = new SessionRepository(root, report);
    repository.onChange(() => { throw new Error("index unavailable"); });
    const nextListener = vi.fn();
    repository.onChange(nextListener);
    await expect(repository.save(session())).resolves.toEqual(expect.any(Number));
    expect(await repository.load("project", "one")).not.toBeNull();
    expect(report).toHaveBeenCalledOnce();
    expect(nextListener).toHaveBeenCalledOnce();
  });

  it("rejects a late replacement even if the new runtime reports a different logical identity", async () => {
    await repository.save(session());
    await repository.remove("project", "one", async () => {});
    await expect(repository.save({ ...session("revived"), codexThreadId: "changed-thread" }, "one")).rejects.toMatchObject({ code: "SESSION_DELETED" });
    expect(await fs.readdir(path.join(root, "sessions/project"))).toEqual([]);
  });

  it("does not leave a write barrier behind if persisting the deletion intent fails", async () => {
    await repository.save(session());
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.deletions${path.sep}`)) throw new Error("intent write denied");
      return rename(from, to);
    });
    const stop = vi.fn();
    await expect(repository.remove("project", "one", stop)).rejects.toThrow("intent write denied");
    expect(stop).not.toHaveBeenCalled();
    expect(repository.isHistoryBlocked(conversationKey(session()))).toBe(false);
    failure.mockRestore();
    await expect(repository.save(session())).resolves.toEqual(expect.any(Number));
    expect(await repository.load("project", "one")).not.toBeNull();
  });

  it("reports a damaged deletion record explicitly and recovers after it is repaired", async () => {
    await repository.save(session());
    await repository.remove("project", "one", async () => {});
    const file = path.join(root, "sessions/.deletions", `${createHash("sha256").update(conversationKey(session())).digest("hex")}.json`);
    const valid = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "broken-record");
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.pendingDeletions()).rejects.toMatchObject({ code: "DELETION_STATE_INVALID" });
    await fs.writeFile(file, valid);
    await expect(repository.pendingDeletions()).resolves.toEqual([]);
    await expect(repository.save(session())).rejects.toMatchObject({ code: "SESSION_DELETED" });
  });

  it("cancels a registered restore before its process has spawned and persists its new alias", async () => {
    await repository.save(session());
    const stop = vi.fn(async () => {});
    const lease = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "one" }, "codex", "unspawned", stop);
    lease.assertActive();
    await repository.remove("project", "one", async (ids) => { expect(ids).toContain("unspawned"); });
    expect(stop).toHaveBeenCalledOnce();
    expect(() => lease.assertActive()).toThrow();
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save({ ...session("unspawned"), codexThreadId: "different-thread" })).rejects.toMatchObject({ code: "SESSION_DELETED" });
    lease.release();
  });

  it("waits for a restored process to stop before removing its source files", async () => {
    await repository.save(session());
    let stopped!: () => void;
    const exit = new Promise<void>((resolve) => { stopped = resolve; });
    let requested!: () => void;
    const stopRequested = new Promise<void>((resolve) => { requested = resolve; });
    const lease = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "one" }, "codex", "restoring", async () => { requested(); await exit; });
    const deletion = repository.remove("project", "one", async () => {});
    await stopRequested;
    expect(() => lease.assertActive()).toThrow();
    expect(await fs.readFile(path.join(root, "sessions/project/one.jsonl"), "utf8")).toContain("hello");
    stopped();
    await expect(deletion).resolves.toBe("deleted");
    lease.release();
  });

  it("does not reactivate a cancelled restore if stopping fails and deletion rolls back", async () => {
    await repository.save(session());
    const lease = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "one" }, "codex", "restoring", async () => { throw new Error("still running"); });
    await expect(repository.remove("project", "one", async () => {})).rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(await repository.load("project", "one")).not.toBeNull();
    expect(() => lease.assertActive()).toThrow();
    lease.release();
    const retry = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "one" }, "codex", "retry", async () => {});
    expect(() => retry.assertActive()).not.toThrow();
    retry.release();
  });
});
