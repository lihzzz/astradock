import type { ReasoningEffort } from "./codex-protocol/ReasoningEffort";

export interface CodexFingerprintSamplePrompt {
  sampleId: number;
  requestedCount: number;
  prompt: string;
}

export interface CodexFingerprintProbeRequest {
  model: string;
  effort?: ReasoningEffort | "max" | "ultra";
  /** Probe the live session's persisted thread; omitted for a fresh-session probe. */
  sessionId?: string;
  cwd?: string;
}

export interface CodexFingerprintSample extends CodexFingerprintSamplePrompt {
  threadId: string;
  response: string;
  parsedCount: number;
  accepted: boolean;
  error?: string;
}

export interface CodexFingerprintCandidate {
  model: string;
  displayName: string;
  family: string;
  familyName: string;
  probability: number;
  conditionalProbability: number;
  profileSimilarity: number;
  score: number;
}

export interface CodexFingerprintDiagnostic {
  index: number;
  parsedNumbers: number;
  minimumNumbers: number;
  accepted: boolean;
}

export interface CodexFingerprintCalibration {
  queries: string;
  beta: number;
  cvAccuracy: number;
}

export interface CodexFingerprintAnalysis {
  prediction: string;
  predictionName: string;
  probability: number;
  usedOutputs: number;
  results: CodexFingerprintCandidate[];
  diagnostics: CodexFingerprintDiagnostic[];
  calibration: CodexFingerprintCalibration;
  familyPrediction: string;
  familyPredictionName: string;
  familyProbability: number;
  familyProbabilities: Array<{ family: string; displayName: string; probability: number }>;
  method: string;
}

export interface CodexFingerprintVerdict {
  verdict: "MATCH" | "SUSPICIOUS" | "MISMATCH" | "UNLISTED" | "INVALID" | "UNKNOWN";
  direction: "upgrade" | "downgrade" | "lateral" | null;
  topModel: string | null;
  selectedModelProbability: number | null;
  margin: number | null;
  confidence: "high" | "low" | null;
  message: string;
}

export interface CodexFingerprintProbeResult {
  mode: "fresh" | "fork";
  parentThreadId: string | null;
  selectedModel: string;
  /** The label returned by Codex, independent of the statistical prediction. */
  actualModel: string | null;
  modelProvider: string | null;
  reasoningEffort: ReasoningEffort | "max" | "ultra" | null;
  verdict: CodexFingerprintVerdict;
  analysis: CodexFingerprintAnalysis | null;
  samples: CodexFingerprintSample[];
  startedAt: string;
  elapsedMs: number;
  error?: string;
}
