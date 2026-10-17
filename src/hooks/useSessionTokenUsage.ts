import { useEffect, useReducer, useState } from "react";
import type { SessionTokenUsage } from "@shared/types/usage";
import { reportError } from "@/lib/analytics/analytics";

interface TokenUsageState {
  sessionId: string;
  data: SessionTokenUsage | null;
  error: boolean;
}

/** Poll only mounted chat headers, independently of message/streaming updates. */
export function useSessionTokenUsage(sessionId: string, isProcessing: boolean) {
  const [state, setState] = useState<TokenUsageState>({ sessionId, data: null, error: false });
  const [refreshKey, refresh] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const result = await window.claude.usage.getSessionTokens(sessionId);
        if (cancelled) return;
        setState((previous) => ({
          sessionId,
          data: result.data ?? (previous.sessionId === sessionId ? previous.data : null),
          error: !!result.error || !result.data,
        }));
      } catch (error) {
        if (cancelled) return;
        reportError("SESSION_TOKEN_USAGE_READ_ERR", error);
        setState((previous) => ({ sessionId, data: previous.sessionId === sessionId ? previous.data : null, error: true }));
      } finally {
        if (!cancelled) timer = setTimeout(update, isProcessing ? 1500 : 10_000);
      }
    }
    void update();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, isProcessing, refreshKey]);

  return {
    usage: state.sessionId === sessionId ? state.data : null,
    error: state.sessionId === sessionId && state.error,
    refresh,
  };
}
