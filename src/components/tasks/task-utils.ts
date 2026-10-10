import type { TaskRunStatus, TaskStatus } from "@shared/types/tasks";
export const TASK_STATUS_KEYS: Record<TaskStatus, string> = { ready: "tasksReady", active: "tasksActive", needs_review: "tasksReview", completed: "tasksCompleted", failed: "tasksFailed", interrupted: "tasksInterrupted" };
export const RUN_STATUS_KEYS: Record<TaskRunStatus, string> = { prepared: "tasksPrepared", running: "tasksRunning", waiting_permission: "tasksPermission", waiting_user: "tasksQuestion", needs_review: "tasksReview", failed: "tasksFailed", interrupted: "tasksInterrupted" };
export const TASK_FIELD_CLASS = "mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
