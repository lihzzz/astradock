import type { EngineId } from "@shared/types/engine";
import type { UsageTokenEntry, UsageTokens, UsageTokenTotals } from "@shared/types/usage";

type TokenRecorder = (engine: EngineId, totals: UsageTokenTotals, timestamp: number) => void;
export interface CodexTokenBaselines {
  get(threadId: string): UsageTokenTotals | undefined;
  set(threadId: string, totals: UsageTokenTotals): void;
}

const TOKEN_KEYS = ["totalTokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function cleanTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : 0;
}

export function emptyTokenTotals(): UsageTokenTotals {
  return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function addTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  const result = emptyTokenTotals();
  for (const key of TOKEN_KEYS) result[key] = cleanTokenCount(left[key] + right[key]);
  return result;
}

function positiveDifference(current: UsageTokenTotals, previous: UsageTokenTotals): UsageTokenTotals {
  const result = emptyTokenTotals();
  for (const key of TOKEN_KEYS) result[key] = Math.max(0, current[key] - previous[key]);
  return result;
}

function maximumTotals(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  const result = emptyTokenTotals();
  for (const key of TOKEN_KEYS) result[key] = Math.max(left[key], right[key]);
  return result;
}

/** A lower total means the engine started a new cumulative counter. */
function cumulativeDifference(current: UsageTokenTotals, previous: UsageTokenTotals): UsageTokenTotals {
  return current.totalTokens < previous.totalTokens ? current : positiveDifference(current, previous);
}

function hasTokens(totals: UsageTokenTotals): boolean {
  return TOKEN_KEYS.some((key) => totals[key] > 0);
}

/** Anthropic reports uncached input separately; our input count includes caches. */
export function normalizeClaudeTokenUsage(value: unknown, modelUsage = false): UsageTokenTotals | undefined {
  if (!isRecord(value)) return;
  const inputKey = modelUsage ? "inputTokens" : "input_tokens";
  const outputKey = modelUsage ? "outputTokens" : "output_tokens";
  const readKey = modelUsage ? "cacheReadInputTokens" : "cache_read_input_tokens";
  const creationKey = modelUsage ? "cacheCreationInputTokens" : "cache_creation_input_tokens";
  if (![inputKey, outputKey, readKey, creationKey].some((key) => key in value)) return;
  const cacheReadTokens = cleanTokenCount(value[readKey]);
  const cacheCreationTokens = cleanTokenCount(value[creationKey]);
  const inputTokens = cleanTokenCount(cleanTokenCount(value[inputKey]) + cacheReadTokens + cacheCreationTokens);
  const outputTokens = cleanTokenCount(value[outputKey]);
  return { totalTokens: cleanTokenCount(inputTokens + outputTokens), inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

function normalizeClaudeModelUsage(value: unknown): UsageTokenTotals | undefined {
  if (!isRecord(value)) return;
  let total: UsageTokenTotals | undefined;
  for (const usage of Object.values(value)) {
    const normalized = normalizeClaudeTokenUsage(usage, true);
    if (normalized) total = addTotals(total ?? emptyTokenTotals(), normalized);
  }
  return total;
}

/** Codex cached input and reasoning output are already included in input/output. */
export function normalizeCodexTokenUsage(value: unknown): UsageTokenTotals | undefined {
  if (!isRecord(value) || !["totalTokens", "inputTokens", "outputTokens"].some((key) => key in value)) return;
  const inputTokens = cleanTokenCount(value.inputTokens);
  const outputTokens = cleanTokenCount(value.outputTokens);
  return {
    totalTokens: value.totalTokens === undefined ? cleanTokenCount(inputTokens + outputTokens) : cleanTokenCount(value.totalTokens),
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.min(inputTokens, cleanTokenCount(value.cachedInputTokens)),
    cacheCreationTokens: 0,
  };
}

/** ACP prompt usage covers the request's model/tool turns; used/size are context gauges. */
export function normalizeAcpTokenUsage(value: unknown): UsageTokenTotals | undefined {
  if (!isRecord(value) || !["totalTokens", "inputTokens", "outputTokens"].some((key) => key in value)) return;
  const inputTokens = cleanTokenCount(value.inputTokens);
  const outputTokens = cleanTokenCount(value.outputTokens);
  return {
    totalTokens: value.totalTokens === undefined ? cleanTokenCount(inputTokens + outputTokens) : cleanTokenCount(value.totalTokens),
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.min(inputTokens, cleanTokenCount(value.cachedReadTokens)),
    cacheCreationTokens: Math.min(inputTokens, cleanTokenCount(value.cachedWriteTokens)),
  };
}

export class TokenUsageTracker {
  readonly data: UsageTokens;
  private prompts = new Set<string>();

  constructor(now: number, saved?: UsageTokens) {
    this.data = saved
      ? { version: 1, trackingStartedAt: saved.trackingStartedAt, entries: saved.entries }
      : { version: 1, trackingStartedAt: now, entries: [] };
  }

  record(engine: EngineId, totals: UsageTokenTotals, timestamp = Date.now()): void {
    if (!Number.isFinite(timestamp) || timestamp < this.data.trackingStartedAt) return;
    const entry: UsageTokenEntry = { engine, timestamp, ...emptyTokenTotals() };
    for (const key of TOKEN_KEYS) entry[key] = cleanTokenCount(totals[key]);
    this.data.entries.push(entry);
  }

  recordAcpPrompt(promptId: string, usage: unknown, timestamp = Date.now()): void {
    if (this.prompts.has(promptId)) return;
    const totals = normalizeAcpTokenUsage(usage);
    if (!totals) return;
    this.prompts.add(promptId);
    this.record("acp", totals, timestamp);
  }
}

/** One observer per SDK query; cumulative counters must not cross a query restart. */
export class ClaudeTokenObserver {
  private resultIds = new Set<string>();
  private resultsObserved = 0;
  private usagePrevious = emptyTokenTotals();
  private modelPrevious: UsageTokenTotals | undefined;
  private fallbackSinceModel = emptyTokenTotals();
  private assistantMessages = new Map<string, UsageTokenTotals>();
  private assistantMain = emptyTokenTotals();
  private assistantAgents = emptyTokenTotals();

  constructor(private record: TokenRecorder, private resumed: boolean) {}

  observe(event: unknown, timestamp = Date.now()): void {
    if (!isRecord(event)) return;
    if (event.type === "assistant" && isRecord(event.message) && (event.parent_tool_use_id || (this.resumed && !this.modelPrevious))) {
      const message = event.message;
      const totals = normalizeClaudeTokenUsage(message.usage);
      if (!totals || typeof message.id !== "string") return;
      // Several content blocks can have different UUIDs and the same API message ID.
      const previous = this.assistantMessages.get(message.id) ?? emptyTokenTotals();
      const maximum = maximumTotals(totals, previous);
      const delta = positiveDifference(maximum, previous);
      this.assistantMessages.set(message.id, maximum);
      if (event.parent_tool_use_id && this.resultsObserved > 0) {
        // Background agents can finish after the last main-loop result. Persist
        // their consumption now and subtract it from the next model snapshot.
        if (hasTokens(delta)) {
          this.record("claude", delta, timestamp);
          this.fallbackSinceModel = addTotals(this.fallbackSinceModel, delta);
        }
      } else if (event.parent_tool_use_id) this.assistantAgents = addTotals(this.assistantAgents, delta);
      else this.assistantMain = addTotals(this.assistantMain, delta);
      return;
    }
    if (event.type !== "result" || event.parent_tool_use_id) return;
    if (typeof event.uuid === "string") {
      if (this.resultIds.has(event.uuid)) return;
      this.resultIds.add(event.uuid);
    }
    const usage = normalizeClaudeTokenUsage(event.usage);
    const model = normalizeClaudeModelUsage(event.modelUsage);
    if (!usage && !model) return;
    this.resultsObserved++;
    const usageDelta = usage ? cumulativeDifference(usage, this.usagePrevious) : emptyTokenTotals();
    if (usage) this.usagePrevious = usage;

    let delta: UsageTokenTotals;
    if (model) {
      if (!this.modelPrevious && this.resumed) {
        // Claude may restore lastModelUsage from its global config on resume.
        // Assistant usage is local to this query; include visible subagents once.
        // Main-loop usage also covers calls without an assistant event (compaction).
        // An invisible subagent call before this first result can be underreported.
        delta = addTotals(maximumTotals(usageDelta, this.assistantMain), this.assistantAgents);
      } else {
        const modelDelta = cumulativeDifference(model, this.modelPrevious ?? emptyTokenTotals());
        delta = positiveDifference(modelDelta, this.fallbackSinceModel);
      }
      this.modelPrevious = model;
      this.fallbackSinceModel = emptyTokenTotals();
    } else {
      if (!usage) return;
      delta = !this.modelPrevious
        ? addTotals(maximumTotals(usageDelta, this.assistantMain), this.assistantAgents)
        : usageDelta;
      this.fallbackSinceModel = addTotals(this.fallbackSinceModel, delta);
    }
    this.assistantMain = emptyTokenTotals();
    this.assistantAgents = emptyTokenTotals();
    if (hasTokens(delta)) return this.record("claude", delta, timestamp);
    // Retain a reported zero for the first result, without adding duplicate snapshots.
    if (this.resultsObserved === 1) this.record("claude", delta, timestamp);
  }
}

/** Only the selected thread is observed; subagent threads have independent counters. */
export class CodexTokenObserver {
  private previous: UsageTokenTotals | undefined;
  private turns = new Set<string>();
  private snapshots = new Set<string>();
  private loadedBaseline = false;
  private hasLiveUsage = false;

  constructor(private record: TokenRecorder, private resumed: boolean, private baselines: CodexTokenBaselines) {
    this.previous = resumed ? undefined : emptyTokenTotals();
  }

  observe(method: string, params: unknown, threadId: string | null, timestamp = Date.now()): void {
    if (!isRecord(params) || !threadId || params.threadId !== threadId) return;
    if (!this.loadedBaseline) {
      if (this.resumed) this.previous = this.baselines.get(threadId);
      this.loadedBaseline = true;
    }
    if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      this.turns.add(params.turn.id);
      return;
    }
    if (method !== "thread/tokenUsage/updated" || !isRecord(params.tokenUsage)) return;
    const current = normalizeCodexTokenUsage(params.tokenUsage.total);
    if (!current) return;
    const key = JSON.stringify([params.turnId, current]);
    if (this.snapshots.has(key)) return;
    this.snapshots.add(key);
    const live = typeof params.turnId === "string" && this.turns.has(params.turnId);
    if (!live) {
      // Replay/resume snapshots establish the baseline without charging history today.
      // Once live usage was seen, an old snapshot must never lower that baseline.
      if (!this.hasLiveUsage) {
        this.previous = this.previous ? maximumTotals(this.previous, current) : current;
        this.baselines.set(threadId, this.previous);
      }
      return;
    }
    const last = normalizeCodexTokenUsage(params.tokenUsage.last);
    // A resumed thread has no total in thread/read. Without an initial historical
    // notification, last is the safe lower bound for its first live update.
    const delta = this.previous ? cumulativeDifference(current, this.previous) : last;
    this.previous = current;
    this.hasLiveUsage = true;
    this.baselines.set(threadId, current);
    if (delta && (hasTokens(delta) || this.snapshots.size === 1)) this.record("codex", delta, timestamp);
  }
}
