import fs from "node:fs/promises";
import syncFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRepository } from "../session-repository";
import { onProjectsChanged, readProjectCatalog, writeProjectCatalog } from "../project-catalog";
import { conversationKey } from "@shared/lib/session-identity";
import { HistorySourceReader } from "../history/source";

let root: string;
let repository: SessionRepository;
const data = (id = "one", projectId = "project") => ({ id, projectId, conversationId: id, title: id, createdAt: 1,
  engine: "claude" as const, messages: [{ id: "message", role: "user", content: "Original history", timestamp: 1 }] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-project-delete-"));
  repository = new SessionRepository(root, vi.fn());
  writeProjectCatalog(root, ["project", "other"].map((id) => ({ id, name: id, path: `/${id}`, createdAt: 1 })));
  await repository.save(data()); await repository.save(data("two")); await repository.save(data("other-session", "other"));
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

describe("durable project deletion", () => {
  it("cancels saved restores and unsaved drafts, waits for exit and rejects every late writer", async () => {
    const exit = deferred(), requested = deferred();
    const restore = await repository.bindRuntime({ projectId: "project", runtimeSessionId: "one" }, "claude", "restoring", async () => { requested.resolve(); await exit.promise; });
    const draftStop = vi.fn(async () => {});
    const draft = await repository.bindProjectRuntime("project", "draft", draftStop);
    const stopping = vi.fn(async () => {});
    const removing = repository.removeProject("project", stopping);
    await requested.promise;
    expect(() => restore.assertActive()).toThrow(); expect(() => draft.assertActive()).toThrow();
    expect(repository.isHistoryBlocked(conversationKey(data()))).toBe(true);
    expect(await fs.readFile(path.join(root, "sessions/project/one.jsonl"), "utf8")).toContain("Original history");
    expect(readProjectCatalog(root).map((p) => p.id)).toContain("project");
    await expect(repository.save(data("late"))).rejects.toMatchObject({ code: "PROJECT_DELETING" });
    await expect(repository.bindProjectRuntime("project", "too-late", async () => {})).rejects.toMatchObject({ code: "PROJECT_DELETING" });
    // An independent catalog mutation while stopping must survive deletion.
    writeProjectCatalog(root, readProjectCatalog(root).map((p) => p.id === "other" ? { ...p, name: "Renamed" } : p));
    exit.resolve(); expect(await removing).toBe("deleted");
    expect(draftStop).toHaveBeenCalledOnce(); expect(stopping).toHaveBeenCalledTimes(2);
    expect(readProjectCatalog(root)).toEqual([expect.objectContaining({ id: "other", name: "Renamed" })]);
    await expect(fs.access(path.join(root, "sessions/project"))).rejects.toMatchObject({ code: "ENOENT" });
    restore.release(); draft.release();
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.save(data("late-new-identity"))).rejects.toMatchObject({ code: "PROJECT_DELETED" });
    await expect(repository.append({ ...data(), appendedMessages: [], messageCount: 1 })).rejects.toMatchObject({ code: "PROJECT_DELETED" });
    await expect(repository.updateMeta("project", "one", { archived: true })).rejects.toMatchObject({ code: "PROJECT_DELETED" });
    expect(await repository.list("project")).toEqual([]); expect(await repository.load("project", "one")).toBeNull();
    expect(await repository.load("other", "other-session")).not.toBeNull();
  });

  it("rolls back a stop failure without losing source data or reactivating cancelled drafts", async () => {
    const draft = await repository.bindProjectRuntime("project", "draft", async () => { throw new Error("process still alive"); });
    await expect(repository.removeProject("project", async () => {})).rejects.toMatchObject({ code: "STOP_FAILED" });
    expect(repository.isProjectBlocked("project")).toBe(false); expect(() => draft.assertActive()).toThrow();
    expect(await repository.list("project")).toHaveLength(2); expect(readProjectCatalog(root)).toHaveLength(2);
    await expect(fs.access(path.join(root, "sessions/.project-deletions/project.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await repository.save(data("after-failure"));
    draft.release();
    expect(await repository.removeProject("project", async () => {})).toBe("deleted");
  });

  it("does not stop processes or retain a barrier when the initial intent cannot be persisted", async () => {
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.project-deletions${path.sep}`)) throw new Error("disk full");
      return rename(from, to);
    });
    const stop = vi.fn(async () => {});
    const lease = await repository.bindProjectRuntime("project", "draft", stop);
    await expect(repository.removeProject("project", stop)).rejects.toThrow("disk full");
    expect(stop).not.toHaveBeenCalled(); expect(() => lease.assertActive()).not.toThrow();
    expect(repository.isProjectBlocked("project")).toBe(false);
    failure.mockRestore(); await repository.save(data("still-writable")); lease.release();
  });

  it("recovers partial directory removal on restart while unrelated projects remain usable", async () => {
    const rm = fs.rm.bind(fs);
    const failure = vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (String(file) === path.join(root, "sessions/project")) {
        await fs.unlink(path.join(root, "sessions/project/one.jsonl")).catch(() => {});
        throw new Error("locked directory");
      }
      return rm(file, options);
    });
    await expect(repository.removeProject("project", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    repository = new SessionRepository(root, vi.fn());
    expect(await repository.list("project")).toEqual([]);
    await expect(repository.save(data("new", "other"))).resolves.toEqual(expect.any(Number));
    expect(readProjectCatalog(root).map((p) => p.id)).toContain("project");
    failure.mockRestore();
    repository = new SessionRepository(root, vi.fn());
    await repository.initialize();
    expect(readProjectCatalog(root).map((p) => p.id)).toEqual(["other"]);
    expect(await repository.removeProject("project", async () => {})).toBe("already_deleted");
  });

  it("keeps a catalog retry entry when committing deleted source data fails", async () => {
    const rename = fs.rename.bind(fs); let writes = 0;
    const failure = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).includes(`${path.sep}.project-deletions${path.sep}`) && ++writes === 3) throw new Error("commit failed");
      return rename(from, to);
    });
    await expect(repository.removeProject("project", async () => {})).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    expect(readProjectCatalog(root).map((p) => p.id)).toContain("project");
    expect(await repository.list("project")).toEqual([]);
    failure.mockRestore();
    expect(await repository.removeProject("project", async () => {})).toBe("deleted");
    expect(readProjectCatalog(root).map((p) => p.id)).toEqual(["other"]);
  });

  it("retries catalog removal after source deletion committed without stopping twice", async () => {
    const rename = syncFs.renameSync.bind(syncFs);
    const failure = vi.spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === path.join(root, "projects.json")) throw new Error("catalog locked");
      return rename(from, to);
    });
    const stop = vi.fn(async () => {});
    await expect(repository.removeProject("project", stop)).rejects.toMatchObject({ code: "DELETE_INCOMPLETE" });
    expect(readProjectCatalog(root)).toHaveLength(2);
    failure.mockRestore(); stop.mockClear();
    expect(await repository.removeProject("project", stop)).toBe("already_deleted");
    expect(stop).not.toHaveBeenCalled(); expect(readProjectCatalog(root)).toHaveLength(1);
  });

  it("waits for an in-flight source write before committing deletion and coalesces duplicate requests", async () => {
    const rename = fs.rename.bind(fs), entered = deferred(), finish = deferred();
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, "sessions/project/one.jsonl")) { entered.resolve(); await finish.promise; }
      return rename(from, to);
    });
    const saving = repository.save({ ...data(), title: "In-flight save" }); await entered.promise;
    const stop = vi.fn(async () => {});
    const first = repository.removeProject("project", stop), second = repository.removeProject("project", stop);
    await vi.waitFor(() => expect(repository.isProjectBlocked("project")).toBe(true));
    expect(stop).not.toHaveBeenCalled(); finish.resolve(); await saving;
    expect(await first).toBe("deleted"); expect(await second).toBe("deleted");
    expect(stop).toHaveBeenCalledTimes(2);
    await expect(fs.access(path.join(root, "sessions/project"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("invalidates history at the barrier and excludes a blocked project even with an old catalog", async () => {
    const entered = deferred(), finish = deferred();
    const off = onProjectsChanged(() => { if (repository.isProjectBlocked("project")) entered.resolve(); });
    try {
      await repository.bindProjectRuntime("project", "draft", async () => { await finish.promise; });
      const deleting = repository.removeProject("project", async () => {}); await entered.promise;
      await vi.waitFor(async () => expect(await fs.readFile(path.join(root, "sessions/.project-deletions/project.json"), "utf8")).toContain("pending"));
      const reader = new HistorySourceReader(root);
      const snapshot = await reader.scan({ projects: [{ id: "project", name: "Project", spaceId: "default" }, { id: "other", name: "Other", spaceId: "default" }], spaces: [] }, new AbortController().signal, () => {});
      expect([...snapshot.conversations.values()].map((c) => c.projectId)).toEqual(["other"]);
      finish.resolve(); await deleting;
    } finally { off(); }
  });

  it("reports a malformed project deletion record and can initialize again after repair", async () => {
    const folder = path.join(root, "sessions/.project-deletions"), file = path.join(folder, "project.json");
    await fs.mkdir(folder, { recursive: true }); await fs.writeFile(file, "broken-record");
    repository = new SessionRepository(root, vi.fn());
    await expect(repository.initialize()).rejects.toMatchObject({ code: "DELETION_STATE_INVALID" });
    await fs.writeFile(file, JSON.stringify({ version: 1, projectId: "project", state: "pending", unlinkStarted: false, updatedAt: 1 }));
    await repository.initialize();
    expect(await repository.list("project")).toEqual([]);
    expect(readProjectCatalog(root).map((p) => p.id)).toEqual(["other"]);
  });

  it("allows history to recover when a stop failure rolls back the intent during its read", async () => {
    const folder = path.join(root, "sessions/.project-deletions"), file = path.join(folder, "project.json");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, projectId: "project", state: "pending" }));
    const read = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === file) await fs.unlink(file);
      return read(...args);
    });
    const reader = new HistorySourceReader(root);
    const snapshot = await reader.scan({ projects: [{ id: "project", name: "Project", spaceId: "default" }], spaces: [] }, new AbortController().signal, () => {});
    expect(snapshot.conversations.size).toBe(2); expect(snapshot.coverage.failed).toBe(0);
  });
});
