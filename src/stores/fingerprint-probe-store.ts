import { createStore, type StoreApi } from "zustand/vanilla";
import { reportError } from "@/lib/analytics/analytics";
import type { CodexFingerprintProbeRequest, CodexFingerprintProbeResult } from "@shared/types/codex-fingerprint";

interface FingerprintProbeState {
  selectedModel: string;
  selectedEffort: string;
  probeTarget: "fresh" | "current";
  running: boolean;
  result: CodexFingerprintProbeResult | null;
  latestAttempt: CodexFingerprintProbeResult | null;
  probeError: string | null;
  setSelectedModel: (model: string) => void;
  setSelectedEffort: (effort: string) => void;
  changeTarget: (target: "fresh" | "current") => void;
  runProbe: (request: CodexFingerprintProbeRequest) => Promise<void>;
}

export interface FingerprintProbeScope {
  scopeId: string | null;
  sessionId: string | null;
  cwd: string | undefined;
}

export function createFingerprintProbeStore(): StoreApi<FingerprintProbeState> {
  return createStore<FingerprintProbeState>()((set, get) => ({
    selectedModel: "",
    selectedEffort: "",
    probeTarget: "fresh",
    running: false,
    result: null,
    latestAttempt: null,
    probeError: null,
    setSelectedModel: (selectedModel) => set({ selectedModel }),
    setSelectedEffort: (selectedEffort) => set({ selectedEffort }),
    changeTarget: (probeTarget) => {
      if (get().running) return;
      set({ probeTarget, result: null, latestAttempt: null, probeError: null });
    },
    runProbe: async (request) => {
      // Shared by remounted panels and split panes, so a hidden run cannot
      // accidentally be started again from another view of the same scope.
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
}

const probeStores = new Map<string, StoreApi<FingerprintProbeState>>();

// Runs and their results belong to the session/project, not the lifetime of
// a docked panel. Keep them in memory while panels collapse, move or unmount.
export function getFingerprintProbeStore(scope: FingerprintProbeScope): StoreApi<FingerprintProbeState> {
  const key = JSON.stringify([scope.scopeId, scope.sessionId, scope.cwd]);
  let store = probeStores.get(key);
  if (!store) {
    store = createFingerprintProbeStore();
    probeStores.set(key, store);
  }
  return store;
}
