/**
 * useBackgroundReaper — caps the number of live background engine processes.
 *
 * Every background session keeps its engine process alive (measured 100-130MB RSS
 * each for codex app-server; Claude CLI node processes are similar), and processes
 * used to live until app quit. When the number of live background sessions exceeds
 * `backgroundProcessLimit`, the least-recently-active idle sessions are persisted,
 * stopped, and removed from the background store. Switching back loads history from
 * disk; sending a message revives the engine via the existing revival paths.
 *
 * Guards: a session is never reaped while it is processing a turn or has a pending
 * permission request, and the active/visible-split/draft sessions are protected.
 */
import { useEffect, useRef } from "react";
import { DRAFT_ID } from "./types";
import type { SharedSessionRefs } from "./types";
import { buildPersistedSession } from "../../lib/session/records";
import { invalidatePersistedCursor, saveSessionSmart } from "../../lib/session/persistence";
import { suppressNextSessionCompletion } from "../../lib/notification-utils";
import { reportError } from "@/lib/analytics/analytics";
import { useSettingsStore } from "@/stores/settings-store";

const REAP_INTERVAL_MS = 60_000;

interface UseBackgroundReaperParams {
  refs: SharedSessionRefs;
}

export interface ReapCandidateInfo {
  sid: string;
  isProcessing: boolean;
  hasPendingPermission: boolean;
  lastActivityAt: number;
}

/**
 * Pure selection: which background session IDs to reap this pass.
 * Guards — never reap sessions that are mid-turn or awaiting a permission response;
 * protected IDs (active pane, split panes, drafts) never appear in the result.
 */
export function selectReapCandidates(
  liveBackgroundIds: string[],
  limit: number,
  info: (sid: string) => ReapCandidateInfo | undefined,
): string[] {
  if (!limit || limit <= 0) return [];
  const excess = liveBackgroundIds.length - limit;
  if (excess <= 0) return [];
  return liveBackgroundIds
    .map((sid) => info(sid))
    .filter((c): c is ReapCandidateInfo => !!c && !c.isProcessing && !c.hasPendingPermission)
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
    .slice(0, excess)
    .map((c) => c.sid);
}

type ReaperRefs = Pick<SharedSessionRefs, "activeSessionIdRef" | "visibleSplitSessionIdsRef" | "preStartedSessionIdRef" | "draftAcpSessionIdRef" | "liveSessionIdsRef" | "backgroundStoreRef" | "sessionsRef">;
export async function reapBackgroundSessions(refs: ReaperRefs): Promise<void> {
  const limit = useSettingsStore.getState().backgroundProcessLimit;
  if (!limit || limit <= 0) return;
  const { activeSessionIdRef, visibleSplitSessionIdsRef, preStartedSessionIdRef,
    draftAcpSessionIdRef, liveSessionIdsRef, backgroundStoreRef, sessionsRef } = refs;
  const protectedSession = (id: string) => id === activeSessionIdRef.current || id === DRAFT_ID
    || visibleSplitSessionIdsRef.current.includes(id) || id === preStartedSessionIdRef.current
    || id === draftAcpSessionIdRef.current || backgroundStoreRef.current.hasLive(id);
  const candidates = selectReapCandidates([...liveSessionIdsRef.current].filter((id) => !protectedSession(id)), limit, (id) => {
    const state = backgroundStoreRef.current.get(id);
    const session = sessionsRef.current.find((entry) => entry.id === id);
    return state && session ? { sid: id, isProcessing: state.isProcessing,
      hasPendingPermission: !!state.pendingPermission, lastActivityAt: session.lastMessageAt ?? session.createdAt } : undefined;
  });
  for (const id of candidates) {
    const state = backgroundStoreRef.current.get(id);
    const session = sessionsRef.current.find((entry) => entry.id === id);
    if (!state || !session || protectedSession(id) || state.isProcessing || state.pendingPermission) continue;
    try {
      await saveSessionSmart(buildPersistedSession({ ...session,
        model: session.model || state.sessionInfo?.model,
        ...(session.engine === "codex" ? { codexGoal: state.codexGoal ?? null } : {}),
      }, state.messages.filter((message) => !message.isQueued), state.totalCost, state.contextUsage));
      // Saving yields: the user may have activated this pane or started a turn.
      const latest = backgroundStoreRef.current.get(id);
      if (protectedSession(id) || !liveSessionIdsRef.current.has(id) || !latest || latest.isProcessing || latest.pendingPermission) continue;
      suppressNextSessionCompletion(id);
      const result = session.engine === "codex" ? await window.claude.codex.stop(id)
        : session.engine === "acp" ? await window.claude.acp.stop(id)
        : await window.claude.stop(id, "background_reap");
      if (result && "error" in result && result.error) throw new Error(result.error);
      if (result && "ok" in result && result.ok === false) throw new Error("Engine refused to stop");
      liveSessionIdsRef.current.delete(id);
      if (!protectedSession(id)) backgroundStoreRef.current.delete(id);
      invalidatePersistedCursor(id);
    } catch (error) { reportError("BACKGROUND_REAP", error); }
  }
}

export function useBackgroundReaper({ refs }: UseBackgroundReaperParams): void {
  const latest = useRef(refs);
  latest.current = refs;
  useEffect(() => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void reapBackgroundSessions(latest.current).catch((error) => reportError("BACKGROUND_REAP", error))
        .finally(() => { running = false; });
    }, REAP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
}
