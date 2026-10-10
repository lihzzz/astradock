import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@shared/lib/session-persistence";
import type { PreparedTaskRun, TaskRun } from "@shared/types/tasks";
import { taskBrief, taskRelativePath, taskRunPrompt, validateTaskSnapshot } from "@shared/lib/tasks";
import { TaskStore } from "./store";
import { TaskService } from "./service";
import { TaskRuntimeEvents } from "./runtime-events";

let root: string;
let workspaceRoot: string;
let store: TaskStore;
let runtime: TaskRuntimeEvents;
let service: TaskService;
let blocked = false;
const projectId = "project";
function createService() { return new TaskService({ store, runtime, projects: () => [{ id: projectId, path: workspaceRoot }], projectBlocked: () => blocked, report: vi.fn() }); }
const brief = { title: "Ship the report", objective: "Summarize the source material", acceptanceCriteria: ["Includes sources", "Lists verification"] };
function binding() { return { projectId, rootKind: "project" as const, rootPath: workspaceRoot, repoCommonDir: null, relativeCwd: "" }; }
async function task() { return (await service.create({ ...brief, workspace: binding() })).tasks[0]; }
async function prepare() { const created = await task(); return service.prepare({ taskId: created.id, expectedRevision: created.revision, engine: "codex", agentId: "codex" }); }
function meta(prepared: PreparedTaskRun, id = "runtime"): SessionMeta {
  return { id, projectId, conversationId: prepared.run.conversationId, workspaceBinding: prepared.task.workspace, engine: prepared.run.engine, agentId: prepared.run.agentId, title: "Execution", createdAt: 1, lastMessageAt: 2 };
}
async function finish(prepared: PreparedTaskRun) {
  runtime.publish("runtime", "codex", "running");
  await service.syncSession(meta(prepared), null);
  runtime.publish("runtime", "codex", "needs_review");
  const event = runtime.get("runtime"); if (!event) throw new Error("Fixture event missing");
  await service.observeRuntime(event);
  return (await service.list()).tasks[0];
}
async function addNote(prepared: PreparedTaskRun) {
  const current = (await service.list()).tasks[0];
  return service.addDeliverable({ taskId: current.id, expectedRevision: current.revision, runId: prepared.run.id, title: "Report", kind: "note", content: "Verified using fixture inputs; real providers not called." });
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-tasks-"));
  workspaceRoot = path.join(root, "project"); await fs.mkdir(workspaceRoot);
  store = new TaskStore(path.join(root, "data")); runtime = new TaskRuntimeEvents(); blocked = false; service = createService();
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (!root.startsWith(path.join(os.tmpdir(), "harnss-tasks-"))) throw new Error("Unsafe fixture cleanup");
  await fs.rm(root, { recursive: true, force: true });
});

describe("durable tasks", () => {
  it("stores a fixed workspace and survives restart without creating a session", async () => {
    const created = await task();
    expect(created.status).toBe("ready"); expect(created.latestRunId).toBeNull();
    expect((await createService().list()).tasks).toEqual([created]);
    expect((await service.list()).runs).toEqual([]);
  });
  it("serializes concurrent preparation and refuses stale revisions", async () => {
    const created = await task();
    const request = { taskId: created.id, expectedRevision: created.revision, engine: "codex", agentId: "codex" };
    const result = await Promise.allSettled([service.prepare(request), service.prepare(request)]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect((await service.list()).runs).toHaveLength(1);
    await expect(service.prepare(request)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  it("marks incomplete attempts interrupted on startup without replaying anything", async () => {
    const prepared = await prepare();
    const snapshot = await createService().list();
    expect(snapshot.runs[0].status).toBe("interrupted"); expect(snapshot.tasks[0].status).toBe("interrupted");
    expect(snapshot.runs[0].conversationId).toBe(prepared.run.conversationId);
    expect((await createService().list()).revision).toBe(snapshot.revision);
  });
  it("latches completion before first session save, but never auto-accepts", async () => {
    const prepared = await prepare();
    runtime.publish("runtime", "codex", "running"); runtime.publish("runtime", "codex", "needs_review");
    await service.syncSession(meta(prepared), null);
    const snapshot = await service.list();
    expect(snapshot.runs[0].status).toBe("needs_review"); expect(snapshot.tasks[0].status).toBe("needs_review"); expect(snapshot.runs[0].review).toBeNull();
    expect((await createService().list()).tasks[0].status).toBe("needs_review");
  });
  it("requires a deliverable and every explicit checklist item for acceptance", async () => {
    const prepared = await prepare(); await finish(prepared);
    const request = { taskId: prepared.task.id, runId: prepared.run.id, decision: "accepted", note: "User checked", checkedCriteria: [0, 1] };
    let current = (await service.list()).tasks[0];
    await expect(service.review({ ...request, expectedRevision: current.revision })).rejects.toThrow("deliverable");
    const withNote = await addNote(prepared); current = withNote.tasks[0];
    await expect(service.review({ ...request, expectedRevision: current.revision, checkedCriteria: [0, 0] })).rejects.toThrow("criterion");
    await expect(service.review({ ...request, expectedRevision: current.revision, checkedCriteria: [0] })).rejects.toThrow("criterion");
    const accepted = await service.review({ ...request, expectedRevision: current.revision });
    expect(accepted.tasks[0].status).toBe("completed"); expect(accepted.runs[0].review).toBe("accepted");
    expect((await createService().list()).deliverables).toEqual(withNote.deliverables);
    runtime.publish("runtime", "codex", "running"); const later = runtime.get("runtime"); if (later) await service.observeRuntime(later);
    expect((await service.list()).tasks[0].status).toBe("completed"); // Reviewed evidence is immutable.
  });
  it("rejects acceptance while a newer native turn is already running", async () => {
    const prepared = await prepare(); await finish(prepared); const snapshot = await addNote(prepared);
    runtime.publish("runtime", "codex", "running");
    await expect(service.review({ taskId: prepared.task.id, runId: prepared.run.id, expectedRevision: snapshot.tasks[0].revision, decision: "accepted", note: "", checkedCriteria: [0, 1] })).rejects.toMatchObject({ code: "BUSY" });
  });
  it("preserves feedback and old evidence across rework, ignoring the old runtime", async () => {
    const first = await prepare(); await finish(first); const withNote = await addNote(first);
    const revised = await service.review({ taskId: first.task.id, runId: first.run.id, expectedRevision: withNote.tasks[0].revision, decision: "changes_requested", note: "Add the missing source", checkedCriteria: [] });
    const second = await service.prepare({ taskId: first.task.id, expectedRevision: revised.tasks[0].revision, engine: "claude", agentId: "claude-code" });
    expect(second.prompt).toContain("Add the missing source");
    runtime.publish("runtime", "codex", "failed", "old error"); const event = runtime.get("runtime"); if (event) await service.observeRuntime(event);
    const current = await service.list();
    expect(current.tasks[0].latestRunId).toBe(second.run.id); expect(current.tasks[0].status).toBe("active");
    expect(current.runs[0].reviewNote).toBe("Add the missing source"); expect(current.deliverables).toHaveLength(1);
  });
  it("does not resurrect a discarded draft when its late source arrives", async () => {
    const prepared = await prepare(); await service.abandonDraft({ taskId: prepared.task.id, runId: prepared.run.id });
    runtime.publish("runtime", "codex", "running"); await service.syncSession(meta(prepared), null);
    expect((await service.list()).runs[0].status).toBe("interrupted");
  });
  it("cannot abandon a materialized conversation or another task's attempt", async () => {
    const prepared = await prepare(); runtime.publish("runtime", "codex", "running"); await service.syncSession(meta(prepared), null);
    await expect(service.abandonDraft({ taskId: prepared.task.id, runId: prepared.run.id })).rejects.toMatchObject({ code: "BUSY" });
  });
  it("retains a failed startup as an attempt without claiming a completed result", async () => {
    const prepared = await prepare(); await service.syncSession(meta(prepared, "failed-codex"), "No engine binary found");
    expect((await service.list()).tasks[0].status).toBe("failed");
  });
  it("tracks a draft engine explicitly changed by the user before sending", async () => {
    const prepared = await prepare(); runtime.publish("runtime", "claude", "running");
    await service.syncSession({ ...meta(prepared), engine: "claude", agentId: "claude-code" }, null);
    expect((await service.list()).runs[0]).toMatchObject({ engine: "claude", agentId: "claude-code", status: "running" });
  });
  it("follows runtime replacement by stable conversation and ignores retired IDs", async () => {
    const prepared = await prepare(); runtime.publish("runtime", "codex", "running"); await service.syncSession(meta(prepared), null);
    runtime.publish("replacement", "codex", "running"); await service.syncSession(meta(prepared, "replacement"), null);
    runtime.stop("runtime"); const event = runtime.get("runtime"); if (event) await service.observeRuntime(event);
    expect((await service.list()).runs[0]).toMatchObject({ runtimeSessionId: "replacement", status: "running" });
  });
  it("interrupts active deleted conversations but preserves task and results", async () => {
    const prepared = await prepare(); runtime.publish("runtime", "codex", "running"); await service.syncSession(meta(prepared), null);
    await service.sourceDeleted(projectId, "runtime");
    expect((await service.list()).tasks[0].status).toBe("interrupted");
  });
  it("refuses another workspace or project without adopting that runtime", async () => {
    const prepared = await prepare();
    await service.syncSession({ ...meta(prepared), projectId: "other" }, null);
    expect((await service.list()).runs[0].runtimeSessionId).toBeNull();
    await service.syncSession({ ...meta(prepared), workspaceBinding: { ...prepared.task.workspace, relativeCwd: "other" } }, null);
    expect((await service.list()).runs[0]).toMatchObject({ runtimeSessionId: null, status: "failed" });
  });
  it("does not fall back when a workspace disappears or a project is being deleted", async () => {
    const created = await task();
    blocked = true; await expect(service.prepare({ taskId: created.id, expectedRevision: created.revision, engine: "codex", agentId: "codex" })).rejects.toMatchObject({ code: "TARGET_GONE" });
    blocked = false; await fs.rename(workspaceRoot, path.join(root, "moved"));
    await expect(service.prepare({ taskId: created.id, expectedRevision: created.revision, engine: "codex", agentId: "codex" })).rejects.toMatchObject({ code: "TARGET_GONE" });
    expect((await service.list()).runs).toHaveLength(0);
  });
  it("records file fingerprints and reports changed or missing outputs", async () => {
    const prepared = await prepare(); await finish(prepared);
    await fs.writeFile(path.join(workspaceRoot, "report.md"), "done");
    const current = (await service.list()).tasks[0];
    const recorded = await service.addDeliverable({ taskId: current.id, expectedRevision: current.revision, runId: prepared.run.id, title: "File", kind: "file", relativePath: "report.md" });
    const file = recorded.deliverables[0]; expect(file.kind).toBe("file");
    expect(await service.revealFile(file.id)).toBe(await fs.realpath(path.join(workspaceRoot, "report.md")));
    await fs.writeFile(path.join(workspaceRoot, "report.md"), "changed");
    await expect(service.revealFile(file.id)).rejects.toMatchObject({ code: "FILE_CHANGED" });
    await fs.unlink(path.join(workspaceRoot, "report.md")); await expect(service.revealFile(file.id)).rejects.toBeDefined();
  });
  it("rejects traversal and junctions leaving the fixed working directory", async () => {
    const prepared = await prepare(); await finish(prepared);
    const outside = path.join(root, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "secret.txt"), "do not read");
    await fs.symlink(outside, path.join(workspaceRoot, "linked"), process.platform === "win32" ? "junction" : "dir");
    const current = (await service.list()).tasks[0];
    const input = { taskId: current.id, expectedRevision: current.revision, runId: prepared.run.id, title: "Unsafe", kind: "file" };
    await expect(service.addDeliverable({ ...input, relativePath: "../outside/secret.txt" })).rejects.toThrow("relative");
    await expect(service.addDeliverable({ ...input, relativePath: "linked/secret.txt" })).rejects.toMatchObject({ code: "OUT_OF_SCOPE" });
    expect((await service.list()).deliverables).toHaveLength(0);
  });
  it("does not commit in-memory state or emit success when atomic replacement fails", async () => {
    await task(); const before = await service.list(); const disk = await fs.readFile(path.join(store.root, "catalog.json"), "utf8");
    const changed = vi.fn(); service.onChanged(changed);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("fixture locked file"));
    await expect(service.create({ ...brief, workspace: binding() })).rejects.toThrow("locked");
    expect(await service.list()).toEqual(before); expect(changed).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(store.root, "catalog.json"), "utf8")).toBe(disk);
  });
  it("preserves corrupt data and allows retry after an explicit external repair", async () => {
    await fs.mkdir(store.root); await fs.writeFile(path.join(store.root, "catalog.json"), "{broken");
    await expect(service.list()).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(service.create({ ...brief, workspace: binding() })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await fs.readFile(path.join(store.root, "catalog.json"), "utf8")).toBe("{broken");
    await fs.writeFile(path.join(store.root, "catalog.json"), JSON.stringify({ version: 1, revision: 0, tasks: [], runs: [], deliverables: [] }));
    expect((await service.list()).tasks).toEqual([]);
  });
  it("returns detached snapshots rather than exposing mutable authoritative state", async () => {
    await task(); const snapshot = await service.list(); snapshot.tasks[0].title = "tamper";
    expect((await service.list()).tasks[0].title).toBe(brief.title);
  });
});

describe("task contracts", () => {
  it("validates bounded briefs, distinct criteria and relative paths", () => {
    expect(() => taskBrief({ ...brief, acceptanceCriteria: ["one", "one"] })).toThrow();
    expect(() => taskBrief({ ...brief, title: "x".repeat(161) })).toThrow();
    for (const bad of ["../x", "C:/x", "/etc/passwd", "\\\\server\\share", "a/../b"]) expect(() => taskRelativePath(bad)).toThrow();
    expect(taskRelativePath("docs\\report.md")).toBe("docs/report.md");
    expect(taskRunPrompt(brief, "")).toContain("1. Includes sources\n2. Lists verification");
  });
  it("rejects unsupported catalogs, duplicate IDs and orphaned records", async () => {
    const prepared = await prepare(); const snapshot = await service.list();
    expect(() => validateTaskSnapshot({ ...snapshot, version: 2 })).toThrow();
    expect(() => validateTaskSnapshot({ ...snapshot, tasks: [...snapshot.tasks, snapshot.tasks[0]] })).toThrow();
    const orphan: TaskRun = { ...prepared.run, taskId: "missing" };
    expect(() => validateTaskSnapshot({ ...snapshot, runs: [orphan] })).toThrow();
  });
});
