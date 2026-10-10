import { taskRuntimeEvents, type TaskRuntimeEvents } from "./runtime-events";

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function observeClaudeTaskEvent(sessionId: string, event: unknown, runtime: TaskRuntimeEvents = taskRuntimeEvents): void {
  if (!record(event) || event.parent_tool_use_id || event.type !== "result") return;
  if (!runtime.get(sessionId) || runtime.get(sessionId)?.status === "interrupted") return; // Ignore restored history before a real user turn.
  const failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
  runtime.publish(sessionId, "claude", failed ? "failed" : "needs_review", failed ? "Claude ended the turn with an error. Inspect the conversation." : null);
}
export function observeCodexTaskEvent(sessionId: string, method: string, params: unknown, runtime: TaskRuntimeEvents = taskRuntimeEvents): void {
  if (!record(params)) return;
  if (method === "turn/started" && record(params.turn) && typeof params.turn.id === "string") runtime.publish(sessionId, "codex", "running", null, params.turn.id);
  else if (method === "turn/completed" && record(params.turn) && runtime.get(sessionId)) {
    if (runtime.get(sessionId)?.turnId !== params.turn.id) return;
    const status = params.turn.status;
    runtime.publish(sessionId, "codex", status === "completed" ? "needs_review" : status === "failed" ? "failed" : "interrupted",
      status === "failed" ? "Codex ended the turn with an error. Inspect the conversation." : null);
  } else if (method === "error" && params.willRetry === false && runtime.get(sessionId)) {
    if (typeof params.turnId === "string" && runtime.get(sessionId)?.turnId !== params.turnId) return;
    runtime.publish(sessionId, "codex", "failed", "Codex reported a non-retryable error. Inspect the conversation.");
  }
}
export function finishAcpTaskTurn(sessionId: string, stopReason: string, runtime: TaskRuntimeEvents = taskRuntimeEvents): void {
  runtime.publish(sessionId, "acp", stopReason === "end_turn" ? "needs_review" : "interrupted",
    stopReason === "end_turn" ? null : `ACP stopped: ${stopReason}`);
}
