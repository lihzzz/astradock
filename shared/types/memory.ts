/** Shared types for the local Hindsight memory integration. */

export type MemoryInjectionPolicy = "first-turn" | "every-turn" | "off";
export type MemoryRecallBudget = "low" | "mid" | "high";
export type MemoryMode = "auto" | "manual" | "off";

export interface MemorySettings {
  enabled: boolean;
  localPort: number;
  llmProvider?: string;
  llmModel?: string;
  llmBaseUrl?: string;
  injectionPolicy: MemoryInjectionPolicy;
  autoRetain: boolean;
  clientSideRedact: boolean;
  recallBudget: MemoryRecallBudget;
  recallMaxTokens: number;
  recallMaxItems: number;
  recallTimeoutMs: number;
  memoryDefense: "redact" | "block" | "off";
}

export interface MemoryProjectConfig {
  memoryMode: MemoryMode;
  memoryIsolated: boolean;
}

export interface MemoryDaemonStatus {
  enabled: boolean;
  running: boolean;
  healthy: boolean;
  baseUrl: string;
  port: number;
  uv: { installed: boolean; version?: string; error?: string };
  hasLlmKey: boolean;
  provider?: string;
  model?: string;
  llmBaseUrl?: string;
  error?: string;
}

export interface MemoryDocument {
  id: string;
  bankId: string;
  originalText?: string;
  memoryUnitCount?: number;
  createdAt?: string;
  updatedAt?: string;
  tags?: string[];
}

export interface MemoryFact {
  id: string;
  bankId: string;
  text: string;
  context?: string;
  factType?: string;
  documentId?: string;
  state?: string;
  tags?: string[];
  proofCount?: number;
  sourceMemoryIds?: string[];
  updatedAt?: string;
}

export interface MemoryGoldenCase {
  id: string;
  content: string;
  expectedKeywords: string[];
  context?: string;
}

export interface MemoryGoldenCaseScore {
  id: string;
  candidateCount: number;
  matchedKeywords: string[];
  precision: number;
  recall: number;
  f1: number;
}

export interface MemoryGoldenReport {
  cases: MemoryGoldenCaseScore[];
  precision: number;
  recall: number;
  f1: number;
  generatedAt: string;
}

export interface MemoryRecallState {
  items: MemoryRecallItem[];
  usedAt: number | null;
  skipNext: boolean;
}

export interface MemoryRecallItem {
  bankId?: string;
  text: string;
  type?: string;
  context?: string | null;
  documentId?: string | null;
  tags?: string[];
  score?: number;
  sourceFacts?: Array<{ id: string; text: string }>;
}

export interface MemoryStatusResult extends MemoryDaemonStatus {
  banks: string[];
}
