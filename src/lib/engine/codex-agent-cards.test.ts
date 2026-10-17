import { describe, expect, it } from "vitest";
import type { UIMessage } from "@/types";
import type { CodexAgentCall, CodexAgentDetails } from "@shared/types/codex-subagents";
import { applyCodexSubagentUpdate } from "./codex-agent-cards";

function agent(overrides: Partial<CodexAgentDetails> = {}): CodexAgentDetails {
  return { threadId: "child", parentThreadId: "root", nickname: "Atlas", role: "worker", model: "worker-model",
    modelSource: "resolved", reasoningEffort: "high", task: "Fix the protocol adapter", status: "running", message: null, updatedAt: 10, ...overrides };
}
function call(overrides: Partial<CodexAgentCall> = {}): CodexAgentCall {
  return { itemId: "spawn", threadId: "root", turnId: "turn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"],
    prompt: "Fix the protocol adapter", requestedModel: "requested-model", requestedReasoningEffort: "high", startedAt: 1, completedAt: 10, ...overrides };
}

describe("applyCodexSubagentUpdate", () => {
  it("creates a persisted card, replacing early lifecycle placeholders without duplicates", () => {
    let messages = applyCodexSubagentUpdate([], { call: null, agents: [agent()] });
    expect(messages).toHaveLength(1);
    expect(messages[0].codexAgent?.call).toBeNull();
    messages = applyCodexSubagentUpdate(messages, { call: call(), agents: [agent()] });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ toolName: "CodexAgent", toolInput: { description: "Fix the protocol adapter" },
      codexAgent: { call: { status: "completed" }, agents: [{ status: "running", model: "worker-model" }] } });
  });

  it("restores metadata from saved cards and keeps resolved models across a restarted runtime", () => {
    const saved = applyCodexSubagentUpdate([], { call: call(), agents: [agent()] });
    const restored: UIMessage[] = JSON.parse(JSON.stringify(saved));
    const updated = applyCodexSubagentUpdate(restored, { call: call({ itemId: "wait", tool: "wait", prompt: null }),
      agents: [agent({ nickname: null, model: null, modelSource: null, task: null, status: "completed", message: "Fixed", updatedAt: 20 })] });
    expect(updated).toHaveLength(2);
    for (const message of updated) expect(message.codexAgent?.agents[0]).toMatchObject({ nickname: "Atlas", model: "worker-model", task: "Fix the protocol adapter", status: "completed" });
    expect(saved[0].codexAgent?.agents[0].status).toBe("running");
  });

  it("updates only affected cards and keeps distinct same-item IDs in different turns", () => {
    const text: UIMessage = { id: "text", role: "assistant", content: "Working", timestamp: 0 };
    let messages = applyCodexSubagentUpdate([text], { call: call(), agents: [agent()] });
    messages = applyCodexSubagentUpdate(messages, { call: call({ turnId: "turn-2", receiverThreadIds: ["other"] }), agents: [agent({ threadId: "other" })] });
    const previous = messages;
    messages = applyCodexSubagentUpdate(messages, { call: null, agents: [agent({ status: "errored", message: "Failure", updatedAt: 20 })] });
    expect(messages).toHaveLength(3);
    expect(messages[0]).toBe(text);
    expect(messages[1]).not.toBe(previous[1]);
    expect(messages[2]).toBe(previous[2]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(3);
  });

  it("upserts repeated and completion-only calls, including empty results", () => {
    let messages = applyCodexSubagentUpdate([], { call: call({ status: "failed", receiverThreadIds: [] }), agents: [] });
    messages = applyCodexSubagentUpdate(messages, { call: call({ status: "failed", receiverThreadIds: [] }), agents: [] });
    expect(messages).toHaveLength(1);
    expect(messages[0].toolError).toBe(true);
    expect(messages[0].toolResult).toBeDefined();
  });
});
