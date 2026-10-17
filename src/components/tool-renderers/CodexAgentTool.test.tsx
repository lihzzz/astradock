import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CodexAgentCardData } from "@shared/types/codex-subagents";
import { CodexAgentTool } from "./CodexAgentTool";

function card(): CodexAgentCardData {
  return { call: { itemId: "spawn", threadId: "root", turnId: "turn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"],
    prompt: "Inspect the adapter and render all subagents", requestedModel: "requested-model", requestedReasoningEffort: "high", startedAt: 0, completedAt: 10 },
    agents: [{ threadId: "child", parentThreadId: "root", nickname: "Atlas", role: "explorer", model: "actual-model", modelSource: "resolved",
      reasoningEffort: "high", task: "Inspect the adapter and render all subagents", status: "running", message: "Result", updatedAt: 10 }] };
}

describe("CodexAgentTool", () => {
  it("shows model, objective, name and independent call/agent states without expansion", () => {
    const html = renderToStaticMarkup(<CodexAgentTool data={card()} messageId="card" />);
    for (const value of ["actual-model", "Task objective", "Inspect the adapter", "Atlas", "explorer", "Reasoning:", "high", "Call:", "Completed", "Agent:", "Running"]) {
      expect(html).toContain(value);
    }
    expect(html).not.toContain("Agent output");
    expect(html).toContain('aria-expanded="false"');
  });
  it("labels a requested model and never substitutes the parent's model", () => {
    const data = card();
    data.agents = [];
    expect(renderToStaticMarkup(<CodexAgentTool data={data} messageId="pending" />)).toContain("Requested model");
    data.call = null;
    const html = renderToStaticMarkup(<CodexAgentTool data={data} messageId="legacy" />);
    expect(html).toContain("Not reported");
    expect(html).toContain("Task details not reported by Codex.");
  });
  it("renders multiple agents and safely falls back for a future operation", () => {
    const data = card();
    if (data.call) data.call.tool = "futureOperation";
    data.agents.push({ ...data.agents[0], threadId: "second", nickname: "Reviewer", model: "review-model", status: "errored" });
    const html = renderToStaticMarkup(<CodexAgentTool data={data} messageId="multi" />);
    for (const value of ["futureOperation", "2 agents", "Reviewer", "review-model", "Failed"]) expect(html).toContain(value);
  });
});
