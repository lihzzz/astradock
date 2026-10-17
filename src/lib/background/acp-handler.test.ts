import { describe, expect, it } from "vitest";
import { handleACPEvent, handleACPTurnComplete } from "./acp-handler";
import type { InternalState } from "./session-store";

function state(): InternalState {
  return {
    messages: [], isProcessing: true, isConnected: true, isCompacting: false,
    sessionInfo: null, totalCost: 0, contextUsage: null, pendingPermission: null,
    rawAcpPermission: null, slashCommands: [], codexGoal: null, codexGoalSupported: null,
    parentToolMap: new Map(), currentStreamingMsgId: null, codexPlanText: "",
    codexPlanTurnCounter: 0, activeTask: null,
  };
}

describe("background ACP turn completion", () => {
  it("surfaces failed turns as retryable errors", () => {
    const current = state();
    handleACPTurnComplete(current, "error");

    expect(current.isProcessing).toBe(false);
    expect(current.messages.at(-1)?.isError).toBe(true);
    expect(current.messages.at(-1)?.retryable).toBe(true);
  });

  it("does not expose retries for user cancellation", () => {
    const current = state();
    handleACPTurnComplete(current, "cancelled");

    expect(current.messages).toHaveLength(0);
  });
});


it("treats background cost events as cumulative snapshots, including duplicate replay", () => {
  const current = state();
  for (const amount of [0.1, 0.3, 0.3]) handleACPEvent(current, { _sessionId: "main", sessionId: "agent", update: { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } } });
  expect(current.totalCost).toBe(0.3);
});
