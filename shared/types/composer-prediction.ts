import type { EngineId } from "./engine";

/** A compact, provider-neutral turn sent to the prediction model. */
export interface ComposerPredictionTurn {
  role: "user" | "assistant" | "tool" | "summary";
  content: string;
}

/** Only the recent conversation is sent; tool output is already compacted by the renderer. */
export interface ComposerPredictionContext {
  turns: ComposerPredictionTurn[];
  locale?: string;
}

export interface ComposerPredictionRequest {
  requestId: string;
  sessionId: string;
  engine: EngineId;
  model?: string;
  cwd?: string;
  locale?: string;
  /** Monotonic renderer revision used to discard stale responses. */
  sourceRevision: string;
  context: ComposerPredictionContext;
}

export type ComposerPredictionStatus = "available" | "empty" | "cancelled" | "failed";

export interface ComposerPredictionResult {
  requestId: string;
  sourceRevision: string;
  status: ComposerPredictionStatus;
  text?: string;
  latencyMs?: number;
}

export interface ComposerPredictionCancelResult {
  ok: boolean;
}
