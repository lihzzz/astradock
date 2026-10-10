import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { SessionMeta } from "@shared/lib/session-persistence";
import type { TaskBrief, TaskDeliverable, TaskRun, TaskSnapshot, WorkbenchTask, PreparedTaskRun } from "@shared/types/tasks";
import { isActiveTaskRun, taskBrief, taskEngine, taskId, taskNumber, taskRecord, taskRelativePath, taskRunPrompt, taskStatusForRun, taskText, TASK_LIMITS, TaskValidationError } from "@shared/lib/tasks";
import { validateWorkspaceBinding } from "@shared/lib/project-apps";
import { ProductivityError } from "../productivity-errors";
import { containsPath, pathIdentity, resolveWorkspace, type AppProject } from "../project-apps/workspace";
import { TaskStore } from "./store";
import type { TaskRuntimeEvent, TaskRuntimeEvents } from "./runtime-events";

interface TaskServiceOptions {
  store: TaskStore;
  projects: () => AppProject[];
  projectBlocked: (projectId: string) => boolean;
  runtime: Pick<TaskRuntimeEvents, "get">;
  report: (error: unknown) => void;
}
export class TaskService {
  private state: TaskSnapshot | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(snapshot: TaskSnapshot) => void>();
  constructor(private readonly options: TaskServiceOptions) {}
  onChanged(listener: (snapshot: TaskSnapshot) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private async initialize(): Promise<void> {
    if (this.state) return;
    const loaded = await this.options.store.load();
    let changed = false;
    for (const run of loaded.runs) {
      if (!isActiveTaskRun(run.status)) continue;
      run.status = "interrupted";
      run.error = "Harnss restarted. Inspect the conversation and files before preparing a new attempt; no work was automatically replayed.";
      run.updatedAt = Date.now(); changed = true;
      const task = loaded.tasks.find((entry) => entry.id === run.taskId && entry.latestRunId === run.id);
      if (task) { task.status = "interrupted"; task.revision++; task.updatedAt = run.updatedAt; }
    }
    if (changed) { loaded.revision++; await this.options.store.save(loaded); }
    this.state = loaded;
  }
  private serial<T>(operation: (snapshot: TaskSnapshot) => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(async () => {
      await this.initialize();
      if (!this.state) throw new Error("Task store unavailable");
      return operation(this.state);
    });
    this.tail = next;
    return next;
  }
  private async commit(next: TaskSnapshot): Promise<TaskSnapshot> {
    next.revision++;
    await this.options.store.save(next);
    this.state = next;
    for (const listener of this.listeners) {
      try { listener(structuredClone(next)); } catch (error) { this.options.report(error); }
    }
    return structuredClone(next);
  }
  list(): Promise<TaskSnapshot> { return this.serial(async (snapshot) => structuredClone(snapshot)); }
  private task(snapshot: TaskSnapshot, id: unknown, revision?: unknown): WorkbenchTask {
    const task = snapshot.tasks.find((entry) => entry.id === taskId(id));
    if (!task) throw new ProductivityError("TARGET_GONE", "Task no longer exists");
    if (revision !== undefined && task.revision !== taskNumber(revision)) throw new ProductivityError("REVISION_CONFLICT", "Task changed. Refresh and review its current state.", true);
    return task;
  }
  private project(task: Pick<WorkbenchTask, "projectId">): AppProject {
    const project = this.options.projects().find((entry) => entry.id === task.projectId);
    if (!project || this.options.projectBlocked(task.projectId)) throw new ProductivityError("TARGET_GONE", "The task project is unavailable or being deleted");
    return project;
  }
  private touch(task: WorkbenchTask): void { task.revision++; task.updatedAt = Date.now(); }
  create(value: unknown): Promise<TaskSnapshot> {
    return this.serial(async (snapshot) => {
      const input = taskRecord(value);
      const brief = taskBrief(input);
      const workspace = validateWorkspaceBinding(input.workspace);
      const resolved = await resolveWorkspace(this.project({ projectId: workspace.projectId }), workspace);
      this.project({ projectId: workspace.projectId });
      const now = Date.now();
      const next = structuredClone(snapshot);
      next.tasks.push({ ...brief, id: randomUUID(), revision: 1, projectId: workspace.projectId, workspace: resolved.binding,
        status: "ready", latestRunId: null, createdAt: now, updatedAt: now });
      return this.commit(next);
    });
  }
  prepare(value: unknown): Promise<PreparedTaskRun> {
    return this.serial(async (snapshot) => {
      const input = taskRecord(value);
      const next = structuredClone(snapshot);
      const task = this.task(next, input.taskId, taskNumber(input.expectedRevision));
      const previous = next.runs.find((run) => run.id === task.latestRunId);
      const live = previous?.runtimeSessionId ? this.options.runtime.get(previous.runtimeSessionId) : undefined;
      if (live && isActiveTaskRun(live.status)) throw new ProductivityError("BUSY", "The previous conversation is still running. Stop it before preparing another attempt.");
      if (previous && isActiveTaskRun(previous.status)) throw new ProductivityError("BUSY", "This task already has an active or prepared attempt");
      if (task.status === "completed" || task.status === "needs_review") throw new ProductivityError("REVIEW_REQUIRED", "Review this attempt before starting another one");
      const engine = taskEngine(input.engine);
      const agentId = taskId(input.agentId);
      const resolved = await resolveWorkspace(this.project(task), task.workspace);
      this.project(task);
      const now = Date.now();
      const brief: TaskBrief = { title: task.title, objective: task.objective, acceptanceCriteria: [...task.acceptanceCriteria] };
      const run: TaskRun = { id: randomUUID(), taskId: task.id, engine, agentId, conversationId: randomUUID(), runtimeSessionId: null,
        brief, status: "prepared", review: null, reviewNote: "", error: null, createdAt: now, updatedAt: now };
      task.workspace = resolved.binding; task.latestRunId = run.id; task.status = "active"; this.touch(task);
      next.runs.push(run);
      await this.commit(next);
      return { task: structuredClone(task), run: structuredClone(run), prompt: taskRunPrompt(brief, previous?.reviewNote ?? "") };
    });
  }
  abandonDraft(value: unknown): Promise<TaskSnapshot> {
    return this.serial(async (snapshot) => {
      const input = taskRecord(value);
      const next = structuredClone(snapshot);
      const task = this.task(next, input.taskId);
      const run = next.runs.find((entry) => entry.id === taskId(input.runId) && entry.taskId === task.id);
      if (!run || run.id !== task.latestRunId || run.status !== "prepared" || run.runtimeSessionId !== null) throw new ProductivityError("BUSY", "Only an unused draft can be discarded. Stop a running agent in its conversation.");
      run.status = "interrupted"; run.error = "Unused execution draft was discarded; no engine was stopped."; run.updatedAt = Date.now();
      task.status = "interrupted"; this.touch(task);
      return this.commit(next);
    });
  }
  private applyRuntime(task: WorkbenchTask, run: TaskRun, event: TaskRuntimeEvent): boolean {
    if (run.engine !== event.engine || task.latestRunId !== run.id || run.review !== null) return false;
    if (run.status === "interrupted" && run.error === "The linked conversation was removed or replaced.") return false;
    // A human review finalizes this attempt. Later chat turns do not rewrite accepted evidence.
    if (run.status === event.status && run.error === event.error) return false;
    run.status = event.status; run.error = event.error; run.updatedAt = Date.now(); run.review = null; run.reviewNote = "";
    task.status = taskStatusForRun(run.status); this.touch(task);
    return true;
  }
  observeRuntime(event: TaskRuntimeEvent): Promise<void> {
    return this.serial(async (snapshot) => {
      const next = structuredClone(snapshot);
      let changed = false;
      const currentEvent = this.options.runtime.get(event.sessionId);
      if (currentEvent && currentEvent.seq > event.seq) return;
      const runById = new Map(next.runs.map((entry) => [entry.id, entry]));
      for (const task of next.tasks) {
        if (this.options.projectBlocked(task.projectId)) continue;
        const candidate = task.latestRunId ? runById.get(task.latestRunId) : undefined;
        const run = candidate?.runtimeSessionId === event.sessionId ? candidate : undefined;
        if (run && this.applyRuntime(task, run, event)) changed = true;
      }
      if (changed) await this.commit(next);
    });
  }
  /** A persisted source, not a renderer-supplied phase, establishes conversation ownership. */
  syncSession(meta: SessionMeta, startupError: string | null, isCurrent: () => boolean = () => true): Promise<void> {
    return this.serial(async (snapshot) => {
      if (!isCurrent() || this.options.projectBlocked(meta.projectId)) return;
      const next = structuredClone(snapshot);
      let changed = false;
      for (const task of next.tasks) {
        if (task.projectId !== meta.projectId) continue;
        const run = next.runs.find((entry) => entry.id === task.latestRunId && entry.conversationId === (meta.conversationId ?? meta.id));
        if (!run || run.review !== null || (run.status === "interrupted" && run.runtimeSessionId === null)) continue;
        const binding = meta.workspaceBinding;
        if (!binding || binding.projectId !== task.projectId || binding.rootKind !== task.workspace.rootKind
          || pathIdentity(binding.rootPath) !== pathIdentity(task.workspace.rootPath) || binding.relativeCwd !== task.workspace.relativeCwd) {
          if (run.status === "prepared") {
            run.status = "failed"; run.error = "Conversation workspace does not match the task."; task.status = "failed"; this.touch(task); changed = true;
          }
          continue;
        }
        if (run.status === "prepared" && run.runtimeSessionId === null) { run.engine = meta.engine ?? "claude"; run.agentId = meta.agentId ?? run.agentId; }
        if (run.engine !== (meta.engine ?? "claude")) continue;
        if (run.runtimeSessionId !== meta.id) { run.runtimeSessionId = meta.id; this.touch(task); changed = true; }
        const event = this.options.runtime.get(meta.id);
        if (event && this.applyRuntime(task, run, event)) changed = true;
        else if (!event && startupError && run.status === "prepared") {
          run.status = "failed"; run.error = startupError.slice(0, 2000); run.updatedAt = Date.now(); task.status = "failed"; this.touch(task); changed = true;
        }
      }
      if (changed) await this.commit(next);
    });
  }
  async tracksProject(projectId: string): Promise<boolean> {
    return this.serial(async (snapshot) => snapshot.tasks.some((task) => task.projectId === projectId && task.latestRunId !== null));
  }
  sourceDeleted(projectId: string, runtimeId: string): Promise<void> {
    return this.serial(async (snapshot) => {
      const next = structuredClone(snapshot);
      let changed = false;
      for (const task of next.tasks.filter((item) => item.projectId === projectId)) {
        const run = next.runs.find((item) => item.id === task.latestRunId && item.runtimeSessionId === runtimeId);
        if (run && isActiveTaskRun(run.status)) {
          run.status = "interrupted"; run.error = "The linked conversation was removed or replaced."; run.updatedAt = Date.now(); task.status = "interrupted"; this.touch(task); changed = true;
        }
      }
      if (changed) await this.commit(next);
    });
  }
  private async file(task: WorkbenchTask, relativePath: string): Promise<{ absolutePath: string; sha256: string; size: number }> {
    const resolved = await resolveWorkspace(this.project(task), task.workspace);
    const absolutePath = await fs.realpath(path.resolve(resolved.cwd, taskRelativePath(relativePath)));
    if (!containsPath(resolved.cwd, absolutePath)) throw new ProductivityError("OUT_OF_SCOPE", "File resolves outside the task working directory");
    const handle = await fs.open(absolutePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > TASK_LIMITS.fileBytes) throw new TaskValidationError("Only regular files up to 10 MiB can be recorded");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > TASK_LIMITS.fileBytes) throw new TaskValidationError("File grew beyond 10 MiB");
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      const currentStat = await fs.stat(absolutePath);
      this.project(task);
      if (stat.ino !== currentStat.ino || stat.dev !== currentStat.dev || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || size !== stat.size || pathIdentity(await fs.realpath(path.resolve(resolved.cwd, relativePath))) !== pathIdentity(absolutePath)) throw new ProductivityError("FILE_CHANGED", "File changed while it was being recorded", true);
      return { absolutePath, sha256: hash.digest("hex"), size };
    } finally { await handle.close(); }
  }
  addDeliverable(value: unknown): Promise<TaskSnapshot> {
    return this.serial(async (snapshot) => {
      const input = taskRecord(value);
      const next = structuredClone(snapshot);
      const task = this.task(next, input.taskId, taskNumber(input.expectedRevision));
      const run = next.runs.find((entry) => entry.id === taskId(input.runId) && entry.taskId === task.id);
      if (!run || run.id !== task.latestRunId || run.review !== null || isActiveTaskRun(run.status)) throw new ProductivityError("INVALID_STATE", "Record results after the attempt ends and before review");
      const base = { id: randomUUID(), taskId: task.id, runId: run.id, title: taskText(input.title, "deliverable title", 160), createdAt: Date.now() };
      let entry: TaskDeliverable;
      if (input.kind === "note") entry = { ...base, kind: "note", content: taskText(input.content, "deliverable content", TASK_LIMITS.note) };
      else if (input.kind === "file") {
        const relativePath = taskRelativePath(input.relativePath);
        const file = await this.file(task, relativePath);
        entry = { ...base, kind: "file", relativePath, sha256: file.sha256, size: file.size };
      } else throw new TaskValidationError("Unknown deliverable kind");
      next.deliverables.push(entry); this.touch(task);
      return this.commit(next);
    });
  }
  review(value: unknown): Promise<TaskSnapshot> {
    return this.serial(async (snapshot) => {
      const input = taskRecord(value);
      const next = structuredClone(snapshot);
      const task = this.task(next, input.taskId, taskNumber(input.expectedRevision));
      const run = next.runs.find((entry) => entry.id === taskId(input.runId) && entry.taskId === task.id);
      if (!run || run.id !== task.latestRunId || run.review !== null || run.status !== "needs_review") throw new ProductivityError("INVALID_STATE", "Only the latest finished attempt can be reviewed");
      const runtime = run.runtimeSessionId ? this.options.runtime.get(run.runtimeSessionId) : undefined;
      if (runtime && isActiveTaskRun(runtime.status)) throw new ProductivityError("BUSY", "The agent is running again; review after it finishes");
      const note = taskText(input.note, "review note", 12000, false);
      if (input.decision === "accepted") {
        if (!Array.isArray(input.checkedCriteria) || input.checkedCriteria.length !== run.brief.acceptanceCriteria.length
          || new Set(input.checkedCriteria).size !== run.brief.acceptanceCriteria.length
          || !input.checkedCriteria.every((entry: unknown) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < run.brief.acceptanceCriteria.length)) throw new TaskValidationError("Explicitly confirm every acceptance criterion");
        if (!next.deliverables.some((entry) => entry.runId === run.id)) throw new TaskValidationError("Record at least one deliverable before accepting");
        task.status = "completed"; run.review = "accepted";
      } else if (input.decision === "changes_requested") {
        if (!note) throw new TaskValidationError("Explain the requested changes");
        task.status = "ready"; run.review = "changes_requested";
      } else throw new TaskValidationError("Unknown review decision");
      run.reviewNote = note; run.updatedAt = Date.now(); this.touch(task);
      return this.commit(next);
    });
  }
  revealFile(id: unknown): Promise<string> {
    return this.serial(async (snapshot) => {
      const entry = snapshot.deliverables.find((item) => item.id === taskId(id));
      if (!entry || entry.kind !== "file") throw new ProductivityError("TARGET_GONE", "File reference not found");
      const file = await this.file(this.task(snapshot, entry.taskId), entry.relativePath);
      if (file.sha256 !== entry.sha256 || file.size !== entry.size) throw new ProductivityError("FILE_CHANGED", "The file no longer matches the recorded result. Inspect it in the project before recording a new result.");
      return file.absolutePath;
    });
  }
}
