import { createStore } from "zustand/vanilla";
import { reportError } from "@/lib/analytics/analytics";
import type { CodexFingerprintProbeRequest, CodexFingerprintProbeResult } from "@shared/types/codex-fingerprint";

export type ModelTestKind = "fingerprint" | "candy";

interface FingerprintProbeState {
  selectedTest: ModelTestKind;
  selectedModel: string;
  selectedEffort: string;
  probeTarget: "fresh" | "current";
  running: boolean;
  result: CodexFingerprintProbeResult | null;
  latestAttempt: CodexFingerprintProbeResult | null;
  probeError: string | null;
  setSelectedTest: (test: ModelTestKind) => void;
  setSelectedModel: (model: string) => void;
  setSelectedEffort: (effort: string) => void;
  changeTarget: (target: "fresh" | "current") => void;
  setTarget: (target: "fresh" | "current") => void;
  runProbe: (request: CodexFingerprintProbeRequest) => Promise<void>;
}

// All panels share one probe, including across sessions, projects and docks.
// Keep it alive when a panel moves, collapses or unmounts.
export const fingerprintProbeStore = createStore<FingerprintProbeState>()((set, get) => ({
  selectedTest: "fingerprint",
  selectedModel: "",
  selectedEffort: "",
  probeTarget: "fresh",
  running: false,
  result: null,
  latestAttempt: null,
  probeError: null,
  setSelectedTest: (selectedTest) => set({ selectedTest }),
  setSelectedModel: (selectedModel) => set({ selectedModel }),
  setSelectedEffort: (selectedEffort) => set({ selectedEffort }),
  changeTarget: (probeTarget) => {
    if (get().running) return;
    set({ probeTarget, result: null, latestAttempt: null, probeError: null });
  },
  setTarget: (probeTarget) => {
    if (get().running) return;
    set({ probeTarget });
  },
  runProbe: async (request) => {
    // Guard every entry point, including stale handlers in other panes.
    if (get().running) return;
    set({ running: true, probeError: null, latestAttempt: null });
    try {
      const response = await window.claude.codex.fingerprintProbe(request);
      if (!("verdict" in response)) {
        set({ probeError: response.error || "Fingerprint probe failed" });
      } else if (response.error || !response.analysis || response.verdict.verdict === "INVALID"
        || response.verdict.verdict === "UNKNOWN") {
        set({ latestAttempt: response, probeError: response.error || response.verdict.message });
      } else {
        set({ latestAttempt: response, result: response });
      }
    } catch (error: unknown) {
      set({ probeError: reportError("fingerprint:probe", error) });
    } finally {
      set({ running: false });
    }
  },
}));
