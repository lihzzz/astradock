import { describe, expect, it } from "vitest";
import { CodexSubagentTracker, codexNotificationThreadId, isCodexSubagentItem } from "@shared/lib/codex-subagents";

function collab(overrides: Record<string, unknown> = {}) {
  return { type: "collabAgentToolCall", id: "call-1", tool: "spawnAgent", status: "inProgress",
    senderThreadId: "root", receiverThreadIds: [], prompt: "Inspect the event protocol",
    model: "worker-model", reasoningEffort: "high", agentsStates: {}, ...overrides };
}
function params(item: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { threadId: "root", turnId: "turn-1", item, ...extra };
}

describe("CodexSubagentTracker", () => {
  it.each(["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent", "sendMessage", "followupTask", "interruptAgent", "listAgents", "futureTool"])("preserves %s calls including completion-only events", (tool) => {
    const tracker = new CodexSubagentTracker(() => "root");
    expect(tracker.observe("item/completed", params(collab({ tool, status: "completed" })), 10)?.call)
      .toMatchObject({ tool, status: "completed", completedAt: 10 });
  });

  it("distinguishes successful spawning from a completed agent and preserves prompt/model", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    const start = tracker.observe("item/started", params(collab()), 10);
    expect(start?.call?.requestedModel).toBe("worker-model");
    const end = tracker.observe("item/completed", params(collab({ status: "completed", prompt: null, model: null,
      receiverThreadIds: ["child"], agentsStates: { child: { status: "running", message: null } } })), 20);
    expect(end?.call).toMatchObject({ prompt: "Inspect the event protocol", requestedModel: "worker-model", status: "completed", startedAt: 10 });
    expect(end?.agents[0]).toMatchObject({ threadId: "child", model: "worker-model", modelSource: "requested", reasoningEffort: "high", status: "running" });
  });

  it("merges early thread metadata and resolved models even when server timestamps precede receipt", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    tracker.observe("item/started", params(collab()), 10);
    tracker.observe("thread/started", { thread: { id: "child", parentThreadId: "root", agentNickname: "Atlas", agentRole: "explorer" } }, 20);
    const activity = tracker.observe("item/started", params({ type: "subAgentActivity", id: "activity", kind: "started",
      agentThreadId: "child", model: "resolved-model", reasoningEffort: "medium" }, { startedAtMs: 18 }), 21);
    expect(activity?.agents[0]).toMatchObject({ model: "resolved-model", modelSource: "resolved", nickname: "Atlas" });
    const end = tracker.observe("item/completed", params(collab({ status: "completed", receiverThreadIds: ["child"] }), { completedAtMs: 19 }), 22);
    expect(end?.agents[0]).toMatchObject({ model: "resolved-model", reasoningEffort: "medium", role: "explorer", task: "Inspect the event protocol" });
  });

  it("uses configured thread models when the spawn call inherits defaults", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    tracker.observe("thread/started", { thread: { id: "child", parentThreadId: "root", model: "configured-model", reasoningEffort: "medium" } }, 10);
    const update = tracker.observe("item/completed", params(collab({ status: "completed", model: null, receiverThreadIds: ["child"] })), 20);
    expect(update?.agents[0]).toMatchObject({ model: "configured-model", modelSource: "configured", reasoningEffort: "medium" });
  });

  it("supports old thread sources and does not invent a model for old runtimes", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    const metadata = tracker.observe("thread/started", { thread: { id: "child", source: {
      subAgent: { thread_spawn: { parent_thread_id: "root", agent_nickname: "Old agent", agent_role: "worker" } },
    } } }, 10);
    expect(metadata?.agents[0]).toMatchObject({ nickname: "Old agent", model: null, modelSource: null });
    expect(tracker.observe("thread/started", { thread: { id: "foreign", parentThreadId: "another-session" } })).toBeNull();
  });

  it("handles multiple receivers, failures, close semantics and replayed completions", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    const wait = tracker.observe("item/completed", params(collab({ tool: "wait", status: "completed", receiverThreadIds: ["a", "b"],
      agentsStates: { a: { status: "completed", message: "Found the bug" }, b: { status: "errored", message: "Failed to read" } } })), 10);
    expect(wait?.agents.map((agent) => agent.status)).toEqual(["completed", "errored"]);
    const close = tracker.observe("item/completed", params(collab({ id: "close", tool: "closeAgent", status: "completed", receiverThreadIds: ["a"],
      agentsStates: { a: { status: "completed", message: null } } })), 20);
    expect(close?.agents[0]).toMatchObject({ status: "shutdown", message: "Found the bug" });
    expect(tracker.observe("item/completed", params(collab({ tool: "wait", status: "completed", receiverThreadIds: ["a"] })), 30)).toBeNull();
    expect(tracker.observe("item/started", params(collab()), 40)).toBeNull();
    expect(tracker.observe("item/completed", params(collab({ id: "failure", status: "failed" })), 50)?.call?.status).toBe("failed");
  });

  it("updates nested agents and child turn/output state without treating idle as task completion", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    tracker.observe("item/completed", params(collab({ status: "completed", receiverThreadIds: ["child"] })), 10);
    const nested = tracker.observe("item/completed", params(collab({ id: "nested", senderThreadId: "child", receiverThreadIds: ["grandchild"], status: "completed" }), { threadId: "child" }), 20);
    expect(nested?.agents[0].parentThreadId).toBe("child");
    tracker.observe("turn/started", { threadId: "child" }, 30);
    expect(tracker.observe("thread/status/changed", { threadId: "child", status: { type: "idle" } }, 40)).toBeNull();
    expect(tracker.observe("item/completed", { threadId: "child", item: { type: "agentMessage", phase: "final_answer", text: "Done" } }, 50)?.agents[0])
      .toMatchObject({ status: "running", message: "Done" });
    expect(tracker.observe("turn/completed", { threadId: "child", turn: { status: "interrupted" } }, 60)?.agents[0].status).toBe("interrupted");
    expect(tracker.observe("turn/completed", { threadId: "root", turn: { status: "completed" } }, 70)).toBeNull();
  });

  it("does not regress a completed agent on a replayed lifecycle item", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    const started = { type: "subAgentActivity", id: "started", kind: "started", agentThreadId: "child", model: "worker" };
    tracker.observe("item/started", params(started), 10);
    tracker.observe("item/completed", params({ ...started, id: "done", kind: "completed" }), 20);
    const replay = tracker.observe("item/completed", params(started), 30);
    expect(replay?.agents[0].status ?? "completed").toBe("completed");
  });

  it("ignores malformed or foreign calls and identifies child routing boundaries", () => {
    const tracker = new CodexSubagentTracker(() => "root");
    expect(tracker.observe("item/started", params({ type: "collabAgentToolCall" }))).toBeNull();
    expect(tracker.observe("item/started", params(collab({ senderThreadId: "foreign" })))).toBeNull();
    expect(tracker.observe("item/started", params(collab(), { threadId: "foreign" }))).toBeNull();
    expect(isCodexSubagentItem("item/started", params(collab()))).toBe(true);
    expect(isCodexSubagentItem("item/started", { item: null })).toBe(false);
    expect(codexNotificationThreadId("turn/completed", { threadId: "child" })).toBe("child");
    expect(codexNotificationThreadId("thread/started", { thread: { id: "child" } })).toBe("child");
  });
});
