import type { EngineId } from "./engine";

export type UsageRange = 1 | 7 | 30 | 90;

/** Cache tokens are subsets of inputTokens, not additional consumption. */
export interface UsageTokenTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SessionTokenUsage extends UsageTokenTotals {
  /** Missing engine reports must not be presented as zero consumption. */
  reported: boolean;
  trackingStartedAt: number;
  mainTokens: number;
  subagentTokens: number;
  subagentCount: number;
}

export interface UsageTokenEntry extends UsageTokenTotals {
  timestamp: number;
  engine: EngineId;
}

export interface UsageTokens {
  version: 1;
  trackingStartedAt: number;
  entries: UsageTokenEntry[];
}

export interface UsageTokenEngine extends UsageTokenTotals {
  engine: EngineId;
  /** False means no engine usage was reported in this period. */
  reported: boolean;
}

export interface UsageTokenDay {
  date: string;
  engines: UsageTokenEngine[];
  totalTokens: number;
  /** False means this date predates token collection. */
  recorded: boolean;
}

export interface UsageTokenReport {
  days: UsageTokenDay[];
  engines: UsageTokenEngine[];
  trackingStartedAt: number;
  incomplete: boolean;
}

export type UsageInterval = [start: number, end: number];

export interface UsageTimings {
  version: 1;
  trackingStartedAt: number;
  active: UsageInterval[];
  agent: UsageInterval[];
}

export interface UsageDay {
  date: string;
  userMessages: number;
  assistantMessages: number;
  /** Null means this date predates timing collection. */
  activeMs: number | null;
  agentMs: number | null;
}

export interface UsageRank {
  name: string;
  count: number;
}

export interface UsageReport {
  days: UsageDay[];
  tokens: UsageTokenReport;
  tools: UsageRank[];
  commands: UsageRank[];
  slashCommands: UsageRank[];
  trackingStartedAt: number;
  timeZone: string;
  incompleteHistory: boolean;
}
