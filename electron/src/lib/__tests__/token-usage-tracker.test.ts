import { describe, expect, it } from "vitest";
import {
  cleanTokenCount, ClaudeTokenObserver, CodexTokenObserver, emptyTokenTotals,
  normalizeAcpTokenUsage, normalizeClaudeTokenUsage, normalizeCodexTokenUsage, TokenUsageTracker,
} from "../token-usage-tracker";
import type { UsageTokenTotals } from "@shared/types/usage";

function claudeUsage(input: number, output = 0, read = 0, creation = 0) {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: creation };
}

function claudeModel(input: number, output = 0, read = 0, creation = 0) {
  return { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: creation };
}

function codexUsage(input: number, output = 0, cached = 0) {
  return { totalTokens: input + output, inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: output };
}

function sum(tracker: TokenUsageTracker): UsageTokenTotals {
  const totals = emptyTokenTotals();
  for (const entry of tracker.data.entries) {
    for (const key of ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) totals[key] += entry[key];
  }
  return totals;
}

function makeClaude(resumed = false) {
  const tracker = new TokenUsageTracker(0);
  const observer = new ClaudeTokenObserver((engine, totals, timestamp) => tracker.record(engine, totals, timestamp), resumed);
  return { tracker, observer };
}

function makeCodex(resumed = false, saved?: UsageTokenTotals) {
  const tracker = new TokenUsageTracker(0);
  const baselines = new Map<string, UsageTokenTotals>();
  if (saved) baselines.set("thread", saved);
  const observer = new CodexTokenObserver((engine, totals, timestamp) => tracker.record(engine, totals, timestamp), resumed, baselines);
  const start = (turnId = "turn", threadId = "thread") => observer.observe("turn/started", { threadId, turn: { id: turnId } }, "thread", 1);
  const usage = (total: ReturnType<typeof codexUsage>, last = total, turnId = "turn", threadId = "thread") => observer.observe("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total, last } }, "thread", 2);
  return { tracker, observer, start, usage, baselines };
}

describe("token normalization", () => {
  it("cleans unsupported, negative and non-finite counts without coercing strings", () => {
    expect([NaN, Infinity, -3, "12", null, undefined].map(cleanTokenCount)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(cleanTokenCount(12.9)).toBe(12);
    expect(cleanTokenCount(Number.MAX_VALUE)).toBe(Number.MAX_SAFE_INTEGER);
    expect(normalizeClaudeTokenUsage(claudeUsage(10.8, -4, 3, 2))).toEqual({ totalTokens: 15, inputTokens: 15, outputTokens: 0, cacheReadTokens: 3, cacheCreationTokens: 2 });
  });

  it("includes Claude caches in input and treats Codex caches/reasoning as subsets", () => {
    expect(normalizeClaudeTokenUsage(claudeUsage(10, 5, 20, 30))).toEqual({ totalTokens: 65, inputTokens: 60, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 30 });
    expect(normalizeCodexTokenUsage(codexUsage(60, 5, 20))).toEqual({ totalTokens: 65, inputTokens: 60, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 0 });
  });

  it("keeps authoritative ACP totals and ignores context-window updates", () => {
    expect(normalizeAcpTokenUsage({ totalTokens: 100, inputTokens: 60, outputTokens: 30, thoughtTokens: 10, cachedReadTokens: 20, cachedWriteTokens: 5 })).toEqual({ totalTokens: 100, inputTokens: 60, outputTokens: 30, cacheReadTokens: 20, cacheCreationTokens: 5 });
    expect(normalizeAcpTokenUsage({ used: 1000, size: 10000, cost: { amount: 1 } })).toBeUndefined();
    expect(normalizeAcpTokenUsage(null)).toBeUndefined();
  });
});

describe("Claude cumulative usage", () => {
  it("adds only cumulative increases across multiple results and models", () => {
    const { tracker, observer } = makeClaude();
    observer.observe({ type: "assistant", message: { id: "ignored", usage: claudeUsage(99) } }, 1);
    observer.observe({ type: "result", uuid: "a", usage: claudeUsage(10), modelUsage: { a: claudeModel(10), b: claudeModel(20, 5, 3, 2) } }, 2);
    observer.observe({ type: "result", uuid: "a", usage: claudeUsage(10), modelUsage: { a: claudeModel(10), b: claudeModel(20, 5, 3, 2) } }, 3);
    observer.observe({ type: "result", uuid: "b", usage: claudeUsage(15), modelUsage: { a: claudeModel(15), b: claudeModel(20, 10, 5, 2) } }, 4);
    expect(sum(tracker)).toEqual({ totalTokens: 52, inputTokens: 42, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2 });
    expect(tracker.data.entries).toHaveLength(2);
  });

  it("deduplicates replayed results even after cumulative counters reset", () => {
    const { tracker, observer } = makeClaude();
    observer.observe({ type: "result", uuid: "a", usage: claudeUsage(100) }, 1);
    observer.observe({ type: "result", uuid: "b", usage: claudeUsage(20) }, 2);
    observer.observe({ type: "result", uuid: "a", usage: claudeUsage(100) }, 3);
    observer.observe({ type: "result", uuid: "c", usage: claudeUsage(30) }, 4);
    expect(sum(tracker).totalTokens).toBe(130);
  });

  it("uses query-local usage for resumed history and resets observers per query", () => {
    const { tracker, observer } = makeClaude(true);
    observer.observe({ type: "result", uuid: "a", usage: claudeUsage(10), modelUsage: { a: claudeModel(1010) } }, 1);
    observer.observe({ type: "result", uuid: "b", usage: claudeUsage(30), modelUsage: { a: claudeModel(1030) } }, 2);
    const restart = new ClaudeTokenObserver((engine, totals, timestamp) => tracker.record(engine, totals, timestamp), true);
    restart.observe({ type: "result", uuid: "c", usage: claudeUsage(5), modelUsage: { a: claudeModel(1035) } }, 3);
    expect(sum(tracker).totalTokens).toBe(35);
  });

  it("deduplicates API message blocks and includes visible agents in a resumed first result", () => {
    const { tracker, observer } = makeClaude(true);
    observer.observe({ type: "assistant", uuid: "block-a", message: { id: "main", usage: claudeUsage(10, 2) } }, 1);
    observer.observe({ type: "assistant", uuid: "block-b", message: { id: "main", usage: claudeUsage(10, 4) } }, 2);
    observer.observe({ type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: claudeUsage(20, 5) } }, 3);
    observer.observe({ type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: claudeUsage(20, 5) } }, 4);
    observer.observe({ type: "result", uuid: "result", usage: claudeUsage(15, 4), modelUsage: { a: claudeModel(1035, 9) } }, 5);
    expect(sum(tracker).totalTokens).toBe(44);
    observer.observe({ type: "result", uuid: "next", usage: claudeUsage(20, 9), modelUsage: { a: claudeModel(1040, 14) } }, 6);
    expect(sum(tracker).totalTokens).toBe(54);
  });

  it("records background agents after a result and subtracts them from the next snapshot", () => {
    const { tracker, observer } = makeClaude();
    observer.observe({ type: "result", uuid: "main", usage: claudeUsage(100), modelUsage: { a: claudeModel(100) } }, 1);
    observer.observe({ type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: claudeUsage(20) } }, 2);
    observer.observe({ type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: claudeUsage(20) } }, 3);
    observer.observe({ type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: claudeUsage(20, 5) } }, 4);
    expect(sum(tracker).totalTokens).toBe(125);
    observer.observe({ type: "result", uuid: "next", usage: claudeUsage(125), modelUsage: { a: claudeModel(145, 5) } }, 5);
    expect(sum(tracker).totalTokens).toBe(150);
    observer.observe({ type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: claudeUsage(20, 5) } }, 6);
    expect(sum(tracker).totalTokens).toBe(150);
  });

  it("reconciles usage-only fallbacks with a later model snapshot", () => {
    const { tracker, observer } = makeClaude();
    observer.observe({ type: "result", uuid: "a", usage: claudeUsage(10) }, 1);
    observer.observe({ type: "result", uuid: "b", usage: claudeUsage(20), modelUsage: { a: claudeModel(30) } }, 2);
    observer.observe({ type: "result", uuid: "c", usage: claudeUsage(30) }, 3);
    observer.observe({ type: "result", uuid: "d", usage: claudeUsage(40), modelUsage: { a: claudeModel(50) } }, 4);
    expect(sum(tracker).totalTokens).toBe(50);
  });
});

describe("Codex cumulative usage", () => {
  it("counts cumulative deltas once across multiple turns and filters subagent threads", () => {
    const { tracker, start, usage } = makeCodex();
    start();
    usage(codexUsage(100, 10, 50));
    usage(codexUsage(100, 10, 50));
    usage(codexUsage(900), undefined, "turn", "agent");
    start("next");
    usage(codexUsage(150, 20, 75), codexUsage(50, 10, 25), "next");
    expect(sum(tracker)).toEqual({ totalTokens: 170, inputTokens: 150, outputTokens: 20, cacheReadTokens: 75, cacheCreationTokens: 0 });
    expect(tracker.data.entries).toHaveLength(2);
  });

  it("establishes resumed historical baselines without counting old totals", () => {
    const { tracker, start, usage } = makeCodex(true);
    usage(codexUsage(1000), codexUsage(100), "old");
    start();
    usage(codexUsage(1050), codexUsage(20));
    usage(codexUsage(1070), codexUsage(20));
    expect(sum(tracker).totalTokens).toBe(70);
  });

  it("uses last as a conservative first update for an unknown resumed thread", () => {
    const { tracker, start, usage } = makeCodex(true);
    start();
    usage(codexUsage(1050), codexUsage(20));
    usage(codexUsage(1070), codexUsage(20));
    expect(sum(tracker).totalTokens).toBe(40);
  });

  it("restores tracked thread baselines to include all first-update calls", () => {
    const { tracker, start, usage, baselines } = makeCodex(true, normalizeCodexTokenUsage(codexUsage(1000)));
    start();
    usage(codexUsage(1050), codexUsage(20));
    expect(sum(tracker).totalTokens).toBe(50);
    expect(baselines.get("thread")?.totalTokens).toBe(1050);
  });

  it("does not replace a persisted baseline with an older pre-live replay", () => {
    const { tracker, start, usage } = makeCodex(true, normalizeCodexTokenUsage(codexUsage(1000)));
    usage(codexUsage(50), undefined, "old");
    start();
    usage(codexUsage(1100), codexUsage(20));
    expect(sum(tracker).totalTokens).toBe(100);
  });

  it("does not lower a live counter when an unseen historical notification arrives", () => {
    const { tracker, start, usage } = makeCodex(true);
    usage(codexUsage(100), undefined, "old");
    start();
    usage(codexUsage(200));
    usage(codexUsage(50), undefined, "older");
    usage(codexUsage(250));
    expect(sum(tracker).totalTokens).toBe(150);
  });

  it("handles a live cumulative reset without replaying an earlier snapshot", () => {
    const { tracker, start, usage } = makeCodex();
    start();
    usage(codexUsage(100));
    usage(codexUsage(20));
    usage(codexUsage(100));
    usage(codexUsage(30));
    expect(sum(tracker).totalTokens).toBe(130);
  });
});

describe("ACP prompt recording", () => {
  it("counts one response per prompt, preserves separate turns and skips absent usage", () => {
    const tracker = new TokenUsageTracker(0);
    tracker.recordAcpPrompt("first", { totalTokens: 15, inputTokens: 10, outputTokens: 5 }, 1);
    tracker.recordAcpPrompt("first", { totalTokens: 15, inputTokens: 10, outputTokens: 5 }, 2);
    tracker.recordAcpPrompt("second", { totalTokens: 15, inputTokens: 10, outputTokens: 5 }, 3);
    tracker.recordAcpPrompt("missing", undefined, 4);
    tracker.recordAcpPrompt("context", { used: 10000, size: 20000 }, 5);
    expect(sum(tracker).totalTokens).toBe(30);
    expect(tracker.data.entries).toHaveLength(2);
  });
});
