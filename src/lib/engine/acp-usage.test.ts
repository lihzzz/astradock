import { describe, expect, it } from "vitest";
import { reduceAcpUsage } from "./acp-usage";

describe("ACP usage snapshots", () => {
  it("does not double-count repeated or resumed totals", () => {
    let state = { totalCost: 0, contextUsage: null };
    for (const amount of [0.1, 0.25, 0.4, 0.4]) state = { ...state, totalCost: reduceAcpUsage(state, { sessionUpdate: "usage_update", cost: { amount, currency: "USD" } }).totalCost };
    expect(state.totalCost).toBe(0.4);
    expect(reduceAcpUsage({ ...state, totalCost: 42 }, { sessionUpdate: "usage_update", cost: { amount: 0.4, currency: "USD" } }).totalCost).toBe(0.4);
  });
  it("does not sum cache tokens twice or retain stale output usage", () => {
    const previous = { totalCost: 1, contextUsage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 5, contextWindow: 100 } };
    expect(reduceAcpUsage(previous, { sessionUpdate: "usage_update", used: 60 }).contextUsage).toEqual({ inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 100 });
  });
  it("ignores invalid costs and currencies rather than treating them as USD", () => {
    for (const cost of [{ amount: NaN, currency: "USD" }, { amount: -1, currency: "USD" }, { amount: 10, currency: "EUR" }]) expect(reduceAcpUsage({ totalCost: 2, contextUsage: null }, { sessionUpdate: "usage_update", cost }).totalCost).toBe(2);
  });
});
