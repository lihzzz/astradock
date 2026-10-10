import { describe, expect, it } from "vitest";
import { TaskRuntimeEvents } from "./runtime-events";
import { finishAcpTaskTurn, observeClaudeTaskEvent, observeCodexTaskEvent } from "./engine-events";

describe("task runtime event normalization", () => {
  it("ignores Claude subagent completion and historical result replay", () => {
    const runtime = new TaskRuntimeEvents();
    observeClaudeTaskEvent("s", { type: "result", subtype: "success" }, runtime);
    expect(runtime.get("s")).toBeUndefined();
    runtime.publish("s", "claude", "running");
    observeClaudeTaskEvent("s", { type: "result", parent_tool_use_id: "child", subtype: "success" }, runtime);
    expect(runtime.get("s")?.status).toBe("running");
    observeClaudeTaskEvent("s", { type: "result", subtype: "success" }, runtime);
    expect(runtime.get("s")?.status).toBe("needs_review");
    runtime.stop("s"); expect(runtime.get("s")?.status).toBe("needs_review");
  });
  it("keeps interruption separate from a Claude result acknowledgement", () => {
    const runtime = new TaskRuntimeEvents(); runtime.publish("s", "claude", "running"); runtime.stop("s");
    observeClaudeTaskEvent("s", { type: "result", subtype: "success" }, runtime);
    expect(runtime.get("s")?.status).toBe("interrupted");
  });
  it("reports Claude errors without accepting the task", () => {
    const runtime = new TaskRuntimeEvents(); runtime.publish("s", "claude", "running");
    observeClaudeTaskEvent("s", { type: "result", subtype: "error_max_turns" }, runtime);
    expect(runtime.get("s")?.status).toBe("failed");
  });
  it("tracks Codex turn identity and ignores retryable or stale errors", () => {
    const runtime = new TaskRuntimeEvents();
    observeCodexTaskEvent("s", "turn/started", { turn: { id: "a" } }, runtime);
    observeCodexTaskEvent("s", "turn/started", { turn: { id: "b" } }, runtime);
    observeCodexTaskEvent("s", "turn/completed", { turn: { id: "a", status: "completed" } }, runtime);
    expect(runtime.get("s")?.status).toBe("running");
    observeCodexTaskEvent("s", "error", { willRetry: true, turnId: "b" }, runtime);
    observeCodexTaskEvent("s", "error", { willRetry: false, turnId: "a" }, runtime);
    expect(runtime.get("s")?.status).toBe("running");
    observeCodexTaskEvent("s", "turn/completed", { turn: { id: "b", status: "completed" } }, runtime);
    expect(runtime.get("s")?.status).toBe("needs_review");
  });
  it.each(["failed", "interrupted"] as const)("preserves Codex %s outcomes", (status) => {
    const runtime = new TaskRuntimeEvents(); observeCodexTaskEvent("s", "turn/started", { turn: { id: "a" } }, runtime);
    observeCodexTaskEvent("s", "turn/completed", { turn: { id: "a", status } }, runtime);
    expect(runtime.get("s")?.status).toBe(status);
  });
  it("distinguishes ACP end_turn from cancellation and limits", () => {
    const runtime = new TaskRuntimeEvents(); runtime.publish("s", "acp", "running"); finishAcpTaskTurn("s", "end_turn", runtime);
    expect(runtime.get("s")?.status).toBe("needs_review");
    finishAcpTaskTurn("s", "cancelled", runtime); expect(runtime.get("s")?.status).toBe("interrupted");
    finishAcpTaskTurn("s", "max_tokens", runtime); expect(runtime.get("s")?.status).toBe("interrupted");
  });
  it("keeps multiple approvals blocked and ignores late responses after stop", () => {
    const runtime = new TaskRuntimeEvents(); runtime.publish("s", "codex", "running");
    runtime.wait("s", "codex", "a", "waiting_permission"); runtime.wait("s", "codex", "b", "waiting_user");
    runtime.resolve("s", "a"); expect(runtime.get("s")?.status).toBe("waiting_user");
    runtime.resolve("s", "b"); expect(runtime.get("s")?.status).toBe("running");
    runtime.wait("s", "codex", "c", "waiting_permission"); runtime.stop("s"); runtime.resolve("s", "c");
    expect(runtime.get("s")?.status).toBe("interrupted");
  });
  it("deduplicates unchanged phases and bounds process-local history", () => {
    const runtime = new TaskRuntimeEvents(); let count = 0; const dispose = runtime.subscribe(() => { count++; });
    runtime.publish("s", "claude", "running"); runtime.publish("s", "claude", "running"); expect(count).toBe(1);
    dispose(); for (let n = 0; n < 513; n++) runtime.publish(String(n), "claude", "running");
    expect(runtime.get("s")).toBeUndefined(); expect(count).toBe(1);
  });
});
