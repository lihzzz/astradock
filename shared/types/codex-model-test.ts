import type { ReasoningEffort } from "./codex-protocol/ReasoningEffort";

export type CodexCandyReasoningEffort = ReasoningEffort | "max" | "ultra";

export interface CodexCandyTestRequest {
  model: string;
  effort?: CodexCandyReasoningEffort;
  /** Run the test in a temporary fork of the live Codex session. */
  sessionId?: string;
  cwd?: string;
  /** Number of independent candy questions to run. Defaults to three. */
  tests?: number;
}

export interface CodexCandyTestSample {
  sampleId: number;
  threadId: string;
  prompt: string;
  response: string;
  passed: boolean;
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  tps: number | null;
  error?: string;
}

export interface CodexCandyTestResult {
  mode: "fresh" | "fork";
  parentThreadId: string | null;
  selectedModel: string;
  /** The model label returned by the Codex app-server for the temporary thread. */
  actualModel: string | null;
  modelProvider: string | null;
  reasoningEffort: CodexCandyReasoningEffort | null;
  requestedTests: number;
  passedTests: number;
  accuracy: number | null;
  samples: CodexCandyTestSample[];
  startedAt: string;
  elapsedMs: number;
  error?: string;
}

export interface CodexCandyTestError {
  error: string;
}

export type CodexCandyTestResponse = CodexCandyTestResult | CodexCandyTestError;
