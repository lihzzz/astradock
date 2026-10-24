import fs from "node:fs";
import path from "node:path";
import type { SessionTokenUsage, UsageTokens, UsageTokenTotals } from "@shared/types/usage";
import { getDataDir } from "./data-dir";
import { writeTextAtomically } from "./atomic-file";
import { reportError } from "./error-utils";
import { ClaudeTokenObserver, CodexTokenObserver, TokenUsageTracker, type CodexChildTurnListener } from "./token-usage-tracker";
import { isSessionTokenData, SessionTokenUsageTracker, type SessionTokenData } from "./session-token-usage-tracker";

let tracker: TokenUsageTracker | undefined;
let sessionTracker: SessionTokenUsageTracker;
let loadError: unknown;
let savedJson = "";
let writeQueue: Promise<void> = Promise.resolve();
const codexBaselines = new Map<string, UsageTokenTotals>();

interface StoredUsageTokens extends UsageTokens {
  /** Internal thread high-water marks; older ledgers do not contain them. */
  codexBaselines?: Record<string, UsageTokenTotals>;
  sessionTokens?: SessionTokenData;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTokenTotals(value: unknown): value is UsageTokenTotals {
  if (!isRecord(value)) return false;
  return [value.totalTokens, value.inputTokens, value.outputTokens, value.cacheReadTokens, value.cacheCreationTokens]
    .every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
}

function isTokens(value: unknown): value is StoredUsageTokens {
  if (!isRecord(value) || value.version !== 1 || typeof value.trackingStartedAt !== "number" || !Number.isFinite(value.trackingStartedAt)) return false;
  const startedAt = value.trackingStartedAt;
  const baselinesValid = value.codexBaselines === undefined || (isRecord(value.codexBaselines)
    && Object.values(value.codexBaselines).every(isTokenTotals));
  return baselinesValid && (value.sessionTokens === undefined || isSessionTokenData(value.sessionTokens))
    && Array.isArray(value.entries) && value.entries.every((entry: unknown) => isRecord(entry) && isTokenTotals(entry)
    && typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) && entry.timestamp >= startedAt
    && (entry.engine === "claude" || entry.engine === "codex" || entry.engine === "acp"));
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function getTracker(): TokenUsageTracker {
  if (!tracker) {
    let saved: StoredUsageTokens | undefined;
    try {
      const json = fs.readFileSync(path.join(getDataDir(), "usage-tokens.json"), "utf-8");
      const parsed: unknown = JSON.parse(json);
      if (!isTokens(parsed)) throw new Error("Invalid token usage data");
      saved = parsed;
      if (parsed.codexBaselines) for (const [threadId, totals] of Object.entries(parsed.codexBaselines)) codexBaselines.set(threadId, totals);
      savedJson = json;
    } catch (error) {
      if (!isMissingFile(error)) {
        // Never replace an unreadable ledger with an apparently accurate zero.
        loadError = error;
        reportError("TOKEN_USAGE_LOAD_ERR", error);
      }
    }
    tracker = new TokenUsageTracker(Date.now(), saved);
    sessionTracker = new SessionTokenUsageTracker(Date.now(), saved?.sessionTokens);
  }
  return tracker;
}

export function getTokenUsage(): UsageTokens {
  const current = getTracker();
  if (loadError) throw loadError;
  return current.data;
}

export function bindSessionTokenUsage(sessionId: string, sourceId?: string): void {
  getTracker();
  sessionTracker.bind(sessionId, sourceId);
}

export function getSessionTokenUsage(sessionId: string): SessionTokenUsage {
  getTokenUsage();
  return sessionTracker.read(sessionId);
}

export function createClaudeTokenObserver(resumed: boolean, sessionId?: string): ClaudeTokenObserver {
  getTracker();
  return new ClaudeTokenObserver((engine, totals, timestamp) => {
    getTracker().record(engine, totals, timestamp);
    if (sessionId) sessionTracker.record(sessionId, totals);
  }, resumed, sessionId ? (agentId, tokens) => sessionTracker.recordSubagent(sessionId, agentId, tokens) : undefined);
}

export function createCodexTokenObserver(resumed: boolean, sessionId?: string, onChildTurn?: CodexChildTurnListener): CodexTokenObserver {
  getTracker();
  return new CodexTokenObserver((engine, totals, timestamp) => {
    getTracker().record(engine, totals, timestamp);
    if (sessionId) sessionTracker.record(sessionId, totals);
  }, resumed, {
    get(threadId) { getTracker(); return codexBaselines.get(threadId); },
    set(threadId, totals) { getTracker(); codexBaselines.set(threadId, totals); },
  }, sessionId ? (agentId, tokens) => sessionTracker.recordSubagent(sessionId, agentId, tokens) : undefined, undefined, onChildTurn);
}

export function recordAcpTokenUsage(promptId: string, usage: unknown, sessionId?: string): void {
  const current = getTracker();
  const before = current.data.entries.length;
  current.recordAcpPrompt(promptId, usage);
  const entry = current.data.entries[before];
  if (sessionId && entry) sessionTracker.record(sessionId, entry);
}

export function flushTokenUsage(): Promise<void> {
  const current = getTracker();
  if (loadError) return Promise.reject(loadError);
  const json = JSON.stringify({ ...current.data, codexBaselines: Object.fromEntries(codexBaselines), sessionTokens: sessionTracker.data });
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    if (json === savedJson) return;
    await writeTextAtomically(path.join(getDataDir(), "usage-tokens.json"), json);
    savedJson = json;
  });
  return writeQueue;
}
