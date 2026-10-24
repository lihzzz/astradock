import type { EngineId } from "@shared/types/engine";
import type { UsageTokenEntry, UsageTokens, UsageTokenTotals } from "@shared/types/usage";

type TokenRecorder = (engine: EngineId, totals: UsageTokenTotals, timestamp: number) => void;
type SubagentTokenRecorder = (agentId: string, tokens: number) => void;
export type CodexChildTurnListener = (threadId: string, turnId: string, running: boolean) => void;

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
  private agentAssistantTotals = new Map<string, number>();
  private agentReportedTotals = new Map<string, number>();

  constructor(private record: TokenRecorder, private resumed: boolean, private recordSubagent?: SubagentTokenRecorder) {}

  observe(event: unknown, timestamp = Date.now()): void {
    if (!isRecord(event)) return;
    if (event.type === "system" && typeof event.tool_use_id === "string") {
      if (event.subtype === "task_started" && (event.task_type === "local_agent" || typeof event.subagent_type === "string")) {
        this.reportAgentTotal(event.tool_use_id, 0);
      }
      if (event.subtype === "task_notification" && isRecord(event.usage) && typeof event.usage.total_tokens === "number") {
        this.reportAgentTotal(event.tool_use_id, cleanTokenCount(event.usage.total_tokens));
      }
    }
    if (event.type === "user" && isRecord(event.tool_use_result) && typeof event.tool_use_result.totalTokens === "number"
      && isRecord(event.message) && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          this.reportAgentTotal(block.tool_use_id, cleanTokenCount(event.tool_use_result.totalTokens));
        }
      }
    }
    if (event.type === "assistant" && isRecord(event.message) && (event.parent_tool_use_id || (this.resumed && !this.modelPrevious))) {
      const message = event.message;
      const totals = normalizeClaudeTokenUsage(message.usage);
      if (!totals || typeof message.id !== "string") return;
      // Several content blocks can have different UUIDs and the same API message ID.
      const previous = this.assistantMessages.get(message.id) ?? emptyTokenTotals();
      const maximum = maximumTotals(totals, previous);
      const delta = positiveDifference(maximum, previous);
      this.assistantMessages.set(message.id, maximum);
      if (typeof event.parent_tool_use_id === "string") {
        const total = cleanTokenCount((this.agentAssistantTotals.get(event.parent_tool_use_id) ?? 0) + delta.totalTokens);
        this.agentAssistantTotals.set(event.parent_tool_use_id, total);
        this.reportAgentTotal(event.parent_tool_use_id, total);
      }
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

  private reportAgentTotal(agentId: string, tokens: number): void {
    const previous = this.agentReportedTotals.get(agentId);
    const maximum = Math.max(previous ?? 0, tokens);
    this.agentReportedTotals.set(agentId, maximum);
    if (previous === undefined || maximum > previous) this.recordSubagent?.(agentId, maximum - (previous ?? 0));
  }
}

/** Observe the selected thread and explicitly owned children, each with its own counter. */
export class CodexTokenObserver {
  private previous: UsageTokenTotals | undefined;
  private turns = new Map<string, number>();
  private lastUsageTurn = -1;
  private activeTurns = new Set<string>();
  private snapshots = new Set<string>();
  private loadedBaseline = false;
  private hasLiveUsage = false;
  private children = new Map<string, CodexTokenObserver>();

  constructor(private record: TokenRecorder, private resumed: boolean, private baselines: CodexTokenBaselines,
    private recordSubagent?: SubagentTokenRecorder, private agentId?: string, private onChildTurn?: CodexChildTurnListener) {
    this.previous = resumed ? undefined : emptyTokenTotals();
  }

  observe(method: string, params: unknown, threadId: string | null, timestamp = Date.now()): void {
    if (!isRecord(params) || !threadId) return;
    if (method === "thread/started" && isRecord(params.thread)) {
      const thread = params.thread;
      const source = isRecord(thread.source) ? thread.source.subAgent : undefined;
      const spawn = isRecord(source) ? source.thread_spawn : undefined;
      const parentId = typeof thread.parentThreadId === "string" ? thread.parentThreadId
        : isRecord(spawn) ? spawn.parent_thread_id : undefined;
      if (parentId === threadId && typeof thread.id === "string" && thread.id !== threadId) {
        this.addChild(thread.id);
      }
    }
    if (params.threadId !== threadId) {
      for (const [childId, child] of this.children) child.observe(method, params, childId, timestamp);
      return;
    }
    if ((method === "item/started" || method === "item/completed") && isRecord(params.item)) {
      const item = params.item;
      if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent" && Array.isArray(item.receiverThreadIds)) {
        for (const id of item.receiverThreadIds) if (typeof id === "string" && id !== threadId) this.addChild(id);
      }
    }
    if (!this.loadedBaseline) {
      if (this.resumed) this.previous = this.baselines.get(threadId);
      this.loadedBaseline = true;
    }
    if (method === "turn/started" && isRecord(params.turn) && typeof params.turn.id === "string") {
      if (!this.turns.has(params.turn.id)) {
        this.turns.set(params.turn.id, this.turns.size);
        this.activeTurns.add(params.turn.id);
        if (this.agentId) this.onChildTurn?.(threadId, params.turn.id, true);
      }
      return;
    }
    const completedTurn = method === "turn/completed" && isRecord(params.turn) ? params.turn.id
      : method === "error" && params.willRetry === false ? params.turnId : undefined;
    if (typeof completedTurn === "string" && this.activeTurns.delete(completedTurn) && this.agentId) {
      this.onChildTurn?.(threadId, completedTurn, false);
    }
    if (method === "thread/closed") {
      for (const turn of this.activeTurns) if (this.agentId) this.onChildTurn?.(threadId, turn, false);
      this.activeTurns.clear();
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
    const turnOrder = typeof params.turnId === "string" ? this.turns.get(params.turnId) : undefined;
    if (turnOrder === undefined || turnOrder < this.lastUsageTurn) return;
    const decreased = this.previous && current.totalTokens < this.previous.totalTokens;
    // A lower snapshot in the same turn is stale, not proof of a counter reset.
    // Keep the high-water mark so a later update cannot charge the old tokens again.
    if (decreased && turnOrder === this.lastUsageTurn) return;
    const last = normalizeCodexTokenUsage(params.tokenUsage.last);
    // Across a new turn/resume a lower counter is ambiguous. Only charge the
    // explicitly reported last call, never the entire possibly historical total.
    const delta = this.previous && !decreased ? positiveDifference(current, this.previous) : last;
    this.lastUsageTurn = turnOrder;
    this.previous = decreased || !this.previous ? current : maximumTotals(current, this.previous);
    this.hasLiveUsage = true;
    this.baselines.set(threadId, this.previous);
    if (delta && (hasTokens(delta) || this.snapshots.size === 1)) {
      this.record("codex", delta, timestamp);
      if (this.agentId) this.recordSubagent?.(this.agentId, delta.totalTokens);
    }
  }

  private addChild(threadId: string): void {
    if (this.children.has(threadId)) return;
    this.recordSubagent?.(threadId, 0);
    // Forked threads can inherit their parent's counter. The first live `last`
    // report is the safe baseline when no historical notification was supplied.
    this.children.set(threadId, new CodexTokenObserver(this.record, true, this.baselines, this.recordSubagent, threadId, this.onChildTurn));
  }
}
