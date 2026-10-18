import { createStore } from "zustand/vanilla";
import { reportError } from "@/lib/analytics/analytics";
import type { CodexCandyTestRequest, CodexCandyTestResult } from "@shared/types/codex-model-test";

interface CandyModelTestState {
  selectedRuns: number;
  running: boolean;
  result: CodexCandyTestResult | null;
  latestAttempt: CodexCandyTestResult | null;
  testError: string | null;
  setSelectedRuns: (runs: number) => void;
  clearResults: () => void;
  runTest: (request: CodexCandyTestRequest) => Promise<void>;
}

const MAX_RUNS = 10;

function normalizeRuns(runs: number): number {
  return Number.isFinite(runs) ? Math.max(1, Math.min(MAX_RUNS, Math.floor(runs))) : 3;
}

export const candyModelTestStore = createStore<CandyModelTestState>()((set, get) => ({
  selectedRuns: 3,
  running: false,
  result: null,
  latestAttempt: null,
  testError: null,
  setSelectedRuns: (runs) => {
    if (get().running) return;
    set({ selectedRuns: normalizeRuns(runs) });
  },
  clearResults: () => set({ result: null, latestAttempt: null, testError: null }),
  runTest: async (request) => {
    if (get().running) return;
    set({ running: true, testError: null, latestAttempt: null });
    try {
      const response = await window.claude.codex.modelTest(request);
      if (!("samples" in response)) {
        set({ testError: response.error || "Model test failed" });
      } else if (response.error || response.samples.length === 0) {
        set({ latestAttempt: response, testError: response.error || "No model test samples completed." });
      } else {
        set({ latestAttempt: response, result: response });
      }
    } catch (error: unknown) {
      set({ testError: reportError("model-test:candy", error) });
    } finally {
      set({ running: false });
    }
  },
}));
