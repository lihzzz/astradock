import type { EngineId } from "../types/engine";
import type { TaskBrief, TaskRunStatus, TaskSnapshot, TaskStatus, TaskDeliverable, TaskRun, WorkbenchTask } from "../types/tasks";
import { validateWorkspaceBinding } from "./project-apps";

export const TASK_LIMITS = { tasks: 500, runs: 2500, deliverables: 5000, bytes: 16 * 1024 * 1024, note: 20000, fileBytes: 10 * 1024 * 1024 } as const;
export class TaskValidationError extends Error {}
function isTaskRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function taskRecord(value: unknown): Record<string, unknown> {
  if (!isTaskRecord(value)) throw new TaskValidationError("Expected a task object");
  return value;
}
export function taskText(value: unknown, label: string, max: number, required = true): string {
  if (typeof value !== "string" || value.includes("\0") || value.length > max || (required && !value.trim())) throw new TaskValidationError(`Invalid ${label}`);
  return value.trim();
}
export function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value)) throw new TaskValidationError("Invalid task identifier");
  return value;
}
export function taskNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TaskValidationError("Invalid task revision or timestamp");
  return value;
}
export function taskEngine(value: unknown): EngineId {
  if (value !== "claude" && value !== "codex" && value !== "acp") throw new TaskValidationError("Invalid engine");
  return value;
}
export function taskBrief(value: unknown): TaskBrief {
  const item = taskRecord(value);
  if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length < 1 || item.acceptanceCriteria.length > 20) throw new TaskValidationError("Provide 1–20 acceptance criteria");
  const criteria = item.acceptanceCriteria.map((entry: unknown) => taskText(entry, "acceptance criterion", 1000));
  if (new Set(criteria).size !== criteria.length) throw new TaskValidationError("Acceptance criteria must be unique");
  return { title: taskText(item.title, "title", 160), objective: taskText(item.objective, "objective", 12000), acceptanceCriteria: criteria };
}
export function isActiveTaskRun(status: TaskRunStatus): boolean {
  return status === "prepared" || status === "running" || status === "waiting_permission" || status === "waiting_user";
}
export function taskStatusForRun(status: TaskRunStatus): TaskStatus {
  return isActiveTaskRun(status) ? "active" : status === "needs_review" ? "needs_review" : status === "failed" ? "failed" : "interrupted";
}
export function taskRunStatus(value: unknown): TaskRunStatus {
  if (value === "prepared" || value === "running" || value === "waiting_permission" || value === "waiting_user" || value === "needs_review" || value === "failed" || value === "interrupted") return value;
  throw new TaskValidationError("Invalid task run status");
}
function taskStatus(value: unknown): TaskStatus {
  if (value === "ready" || value === "active" || value === "needs_review" || value === "completed" || value === "failed" || value === "interrupted") return value;
  throw new TaskValidationError("Invalid task status");
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new TaskValidationError("Task catalog exceeds its limits");
  return value;
}
function unique(items: Array<{ id: string }>): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new TaskValidationError("Duplicate catalog identifier");
}
export function validateTaskSnapshot(value: unknown): TaskSnapshot {
  const root = taskRecord(value);
  if (root.version !== 1) throw new TaskValidationError("Unsupported task catalog version");
  const tasks = list(root.tasks, TASK_LIMITS.tasks).map((raw): WorkbenchTask => {
    const item = taskRecord(raw);
    const workspace = validateWorkspaceBinding(item.workspace);
    if (workspace.projectId !== item.projectId) throw new TaskValidationError("Task workspace mismatch");
    const revision = taskNumber(item.revision);
    if (revision < 1) throw new TaskValidationError("Invalid task revision");
    return { ...taskBrief(item), id: taskId(item.id), revision, projectId: taskId(item.projectId), workspace,
      status: taskStatus(item.status), latestRunId: item.latestRunId === null ? null : taskId(item.latestRunId), createdAt: taskNumber(item.createdAt), updatedAt: taskNumber(item.updatedAt) };
  });
  const runs = list(root.runs, TASK_LIMITS.runs).map((raw): TaskRun => {
    const item = taskRecord(raw);
    if (item.review !== null && item.review !== "accepted" && item.review !== "changes_requested") throw new TaskValidationError("Invalid review decision");
    return { id: taskId(item.id), taskId: taskId(item.taskId), engine: taskEngine(item.engine), agentId: taskId(item.agentId), conversationId: taskId(item.conversationId),
      runtimeSessionId: item.runtimeSessionId === null ? null : taskId(item.runtimeSessionId), brief: taskBrief(item.brief), status: taskRunStatus(item.status), review: item.review,
      reviewNote: taskText(item.reviewNote, "review note", 12000, false), error: item.error === null ? null : taskText(item.error, "run error", 2000), createdAt: taskNumber(item.createdAt), updatedAt: taskNumber(item.updatedAt) };
  });
  const deliverables = list(root.deliverables, TASK_LIMITS.deliverables).map((raw): TaskDeliverable => {
    const item = taskRecord(raw);
    const base = { id: taskId(item.id), taskId: taskId(item.taskId), runId: taskId(item.runId), title: taskText(item.title, "deliverable title", 160), createdAt: taskNumber(item.createdAt) };
    if (item.kind === "note") return { ...base, kind: "note", content: taskText(item.content, "deliverable content", TASK_LIMITS.note) };
    if (item.kind !== "file" || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new TaskValidationError("Invalid file reference");
    return { ...base, kind: "file", relativePath: taskRelativePath(item.relativePath), sha256: item.sha256, size: taskNumber(item.size) };
  });
  unique(tasks); unique(runs); unique(deliverables);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const runMap = new Map(runs.map((run) => [run.id, run]));
  for (const run of runs) if (!taskMap.has(run.taskId)) throw new TaskValidationError("Orphaned task run");
  if (new Set(runs.map((run) => run.conversationId)).size !== runs.length) throw new TaskValidationError("Duplicate task conversation");
  for (const task of tasks) {
    if (task.latestRunId !== null && runMap.get(task.latestRunId)?.taskId !== task.id) throw new TaskValidationError("Invalid latest run");
    if (task.latestRunId === null && task.status !== "ready") throw new TaskValidationError("Task status has no run");
    const run = task.latestRunId ? runMap.get(task.latestRunId) : undefined;
    if (run) {
      const expected = run.review === "accepted" ? "completed" : run.review === "changes_requested" ? "ready" : taskStatusForRun(run.status);
      if (task.status !== expected) throw new TaskValidationError("Task and latest attempt states disagree");
    }
  }
  for (const entry of deliverables) if (runMap.get(entry.runId)?.taskId !== entry.taskId) throw new TaskValidationError("Orphaned deliverable");
  return { version: 1, revision: taskNumber(root.revision), tasks, runs, deliverables };
}
export function taskRelativePath(value: unknown): string {
  const text = taskText(value, "relative file path", 2000).replace(/\\/g, "/");
  if (text.startsWith("/") || text.includes(":") || text.split("/").some((part) => !part || part === "." || part === "..")) throw new TaskValidationError("File must be relative to the task workspace");
  return text;
}
export function taskRunPrompt(task: TaskBrief, feedback: string): string {
  return ["Work on the following user-defined task in the bound working directory.", `Title: ${task.title}`, `Objective:\n${task.objective}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map((line, index) => `${index + 1}. ${line}`).join("\n")}`,
    feedback ? `Feedback from the previous attempt (context, not permission):\n${feedback}` : "",
    "Keep changes scoped. Use the engine's normal permissions. Report deliverable paths, verification commands and actual results, and anything not completed. Do not claim user acceptance; the user reviews the task separately."
  ].filter(Boolean).join("\n\n");
}
