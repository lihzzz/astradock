import type { EngineId } from "@shared/types/engine";
import type { TaskRunStatus } from "@shared/types/tasks";

export interface TaskRuntimeEvent { sessionId: string; engine: EngineId; status: Exclude<TaskRunStatus, "prepared">; error: string | null; seq: number; turnId: string | null }
/** Small process-local latch: events can precede the first persisted conversation. */
export class TaskRuntimeEvents {
  private sequence = 0;
  private latest = new Map<string, TaskRuntimeEvent>();
  private waiting = new Map<string, Map<string, "waiting_permission" | "waiting_user">>();
  private listeners = new Set<(event: TaskRuntimeEvent) => void>();
  get(sessionId: string): TaskRuntimeEvent | undefined { return this.latest.get(sessionId); }
  subscribe(listener: (event: TaskRuntimeEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  publish(sessionId: string, engine: EngineId, status: TaskRuntimeEvent["status"], error: string | null = null, turnId: string | null = this.latest.get(sessionId)?.turnId ?? null): void {
    const previous = this.latest.get(sessionId);
    if (status !== "waiting_permission" && status !== "waiting_user") this.waiting.delete(sessionId);
    if (previous?.status === status && previous.error === error && previous.turnId === turnId) return;
    const event = { sessionId, engine, status, error: error?.slice(0, 2000) || null, seq: ++this.sequence, turnId };
    this.latest.delete(sessionId); this.latest.set(sessionId, event);
    while (this.latest.size > 512) { const first = this.latest.keys().next().value; if (first) { this.latest.delete(first); this.waiting.delete(first); } }
    for (const listener of this.listeners) listener(event);
  }
  wait(sessionId: string, engine: EngineId, requestId: string, status: "waiting_permission" | "waiting_user"): void {
    const current = this.latest.get(sessionId);
    if (!current || !["running", "waiting_permission", "waiting_user"].includes(current.status)) return;
    const pending = this.waiting.get(sessionId) ?? new Map();
    pending.set(requestId, status); this.waiting.set(sessionId, pending);
    this.publish(sessionId, engine, [...pending.values()].includes("waiting_user") ? "waiting_user" : "waiting_permission");
  }
  resolve(sessionId: string, requestId: string): void {
    const pending = this.waiting.get(sessionId);
    const current = this.latest.get(sessionId);
    if (!pending?.delete(requestId) || !current) return;
    this.publish(sessionId, current.engine, pending.size ? [...pending.values()].includes("waiting_user") ? "waiting_user" : "waiting_permission" : "running");
  }
  stop(sessionId: string): void {
    const previous = this.latest.get(sessionId);
    if (previous && (previous.status === "running" || previous.status === "waiting_permission" || previous.status === "waiting_user")) this.publish(sessionId, previous.engine, "interrupted");
  }
}
export const taskRuntimeEvents = new TaskRuntimeEvents();
