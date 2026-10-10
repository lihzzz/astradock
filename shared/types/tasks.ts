import type { EngineId } from "./engine";
import type { WorkspaceBinding } from "./workspace";
import type { OperationResult } from "./productivity";

export type TaskStatus = "ready" | "active" | "needs_review" | "completed" | "failed" | "interrupted";
export type TaskRunStatus = "prepared" | "running" | "waiting_permission" | "waiting_user" | "needs_review" | "failed" | "interrupted";
export type TaskReview = "accepted" | "changes_requested";
export interface TaskBrief {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
}
export interface WorkbenchTask extends TaskBrief {
  id: string;
  revision: number;
  projectId: string;
  workspace: WorkspaceBinding;
  status: TaskStatus;
  latestRunId: string | null;
  createdAt: number;
  updatedAt: number;
}
/** Not an AppRun: this is an agent attempt, not a managed service process. */
export interface TaskRun {
  id: string;
  taskId: string;
  engine: EngineId;
  agentId: string;
  conversationId: string;
  runtimeSessionId: string | null;
  brief: TaskBrief;
  status: TaskRunStatus;
  review: TaskReview | null;
  reviewNote: string;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export type TaskDeliverable = {
  id: string;
  taskId: string;
  runId: string;
  title: string;
  createdAt: number;
} & ({ kind: "note"; content: string } | { kind: "file"; relativePath: string; sha256: string; size: number });
export interface TaskSnapshot {
  version: 1;
  revision: number;
  tasks: WorkbenchTask[];
  runs: TaskRun[];
  deliverables: TaskDeliverable[];
}
export interface CreateTaskInput extends TaskBrief { workspace: WorkspaceBinding }
export interface TaskVersionInput { taskId: string; expectedRevision: number }
export interface PrepareTaskRunInput extends TaskVersionInput { engine: EngineId; agentId: string }
export interface PreparedTaskRun {
  task: WorkbenchTask;
  run: TaskRun;
  prompt: string;
}
export interface TaskRunRef { taskId: string; runId: string }
export type AddTaskDeliverableInput = TaskVersionInput & { runId: string; title: string } &
  ({ kind: "note"; content: string } | { kind: "file"; relativePath: string });
export interface ReviewTaskInput extends TaskVersionInput {
  runId: string;
  decision: TaskReview;
  note: string;
  /** Explicit user checklist, validated against the frozen attempt brief. */
  checkedCriteria: number[];
}
export interface TasksApi {
  list: () => Promise<OperationResult<TaskSnapshot>>;
  create: (input: CreateTaskInput) => Promise<OperationResult<TaskSnapshot>>;
  prepare: (input: PrepareTaskRunInput) => Promise<OperationResult<PreparedTaskRun>>;
  abandonDraft: (input: TaskRunRef) => Promise<OperationResult<TaskSnapshot>>;
  addDeliverable: (input: AddTaskDeliverableInput) => Promise<OperationResult<TaskSnapshot>>;
  review: (input: ReviewTaskInput) => Promise<OperationResult<TaskSnapshot>>;
  revealFile: (deliverableId: string) => Promise<OperationResult<null>>;
  onChanged: (listener: (snapshot: TaskSnapshot) => void) => () => void;
}
