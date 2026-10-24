/**
 * useSessionPane — encapsulates one complete engine triple (useClaude + useACP + useCodex)
 * for a single "pane" of the UI.
 *
 * In single mode, only the primary pane is active. In split view, both primary
 * and secondary panes are active simultaneously. The hook is always called
 * unconditionally (satisfying Rules of Hooks); when not in use, all engine hooks
 * receive null sessionIds and hold dormant empty state.
 */

import { useEffect, useRef } from "react";
import { sharedSessionStore } from "@/lib/background/shared-session-store";
import type { BackgroundSessionState } from "@/lib/background/session-store";
import { useClaude } from "../useClaude";
import { useACP } from "../useACP";
import { useCodex } from "../useCodex";
import type { UIMessage, PermissionRequest, EngineId, AcpPermissionBehavior, ContextUsage, SessionInfo, ACPConfigOption, ACPPermissionEvent, SlashCommand } from "@/types";
import type { InitialMeta } from "./types";

export interface UseSessionPaneOptions {
  /** The logical session ID for this pane (or null when the pane is unused). */
  activeSessionId: string | null;
  /** Which engine this pane's session uses. */
  activeEngine: EngineId;

  // ── Per-engine session IDs (pre-computed by the caller) ──
  claudeSessionId: string | null;
  acpSessionId: string | null;
  codexSessionId: string | null;
  codexSessionModel: string | undefined;
  codexPlanModeEnabled: boolean;

  // ── Initial state for session restoration ──
  initialMessages: UIMessage[];
  initialMeta: InitialMeta | null;
  initialPermission: PermissionRequest | null;

  // ── ACP-specific initial state ──
  initialConfigOptions?: ACPConfigOption[];
  initialSlashCommands?: SlashCommand[];
  initialRawAcpPermission?: ACPPermissionEvent | null;
  acpPermissionBehavior: AcpPermissionBehavior;
}

export interface SessionPaneState {
  /** Individual engine hook returns — sub-hooks need direct access. */
  claude: ReturnType<typeof useClaude>;
  acp: ReturnType<typeof useACP>;
  codex: ReturnType<typeof useCodex>;

  /** The currently-selected engine for this pane. */
  engine: ReturnType<typeof useClaude> | ReturnType<typeof useACP> | ReturnType<typeof useCodex>;

  /** Convenience accessors — derived from the active engine. */
  messages: UIMessage[];
  totalCost: number;
  contextUsage: ContextUsage | null;
  isProcessing: boolean;
  isConnected: boolean;
  isCompacting: boolean;
  reconnectMessage: string | null;
  sessionInfo: SessionInfo | null;
  pendingPermission: PermissionRequest | null;
  codexGoal: ReturnType<typeof useCodex>["codexGoal"];
  codexGoalSupported: ReturnType<typeof useCodex>["codexGoalSupported"];
}

export function useSessionPane({
  activeEngine,
  claudeSessionId,
  acpSessionId,
  codexSessionId,
  codexSessionModel,
  codexPlanModeEnabled,
  initialMessages,
  initialMeta,
  initialPermission,
  initialConfigOptions,
  initialSlashCommands,
  initialRawAcpPermission,
  acpPermissionBehavior,
}: UseSessionPaneOptions): SessionPaneState {
  const isACP = activeEngine === "acp";
  const isCodex = activeEngine === "codex";
  const isClaude = activeEngine === "claude";

  // ── Engine hooks (always called — Rules of Hooks) ──
  const claude = useClaude({
    sessionId: claudeSessionId,
    initialMessages: isClaude ? initialMessages : [],
    initialMeta: isClaude ? initialMeta : null,
    initialPermission: isClaude ? initialPermission : null,
  });

  const acp = useACP({
    sessionId: acpSessionId,
    initialMessages: isACP ? initialMessages : [],
    initialConfigOptions: isACP ? initialConfigOptions : undefined,
    initialSlashCommands: isACP ? initialSlashCommands : undefined,
    initialMeta: isACP ? initialMeta : null,
    initialPermission: isACP ? initialPermission : null,
    initialRawAcpPermission: isACP ? initialRawAcpPermission : null,
    acpPermissionBehavior,
  });

  const codex = useCodex({
    sessionId: codexSessionId,
    sessionModel: codexSessionModel,
    planModeEnabled: codexPlanModeEnabled,
    initialMessages: isCodex ? initialMessages : [],
    initialMeta: isCodex ? initialMeta : null,
    initialPermission: isCodex ? initialPermission : null,
  });

  // Pick the active engine's state
  const engine = isCodex ? codex : isACP ? acp : claude;

  const runtimeId = isCodex ? codexSessionId : isACP ? acpSessionId : claudeSessionId;
  const snapshots = useRef(new Map<string, BackgroundSessionState>());
  const messageSnapshots = useRef(new Map<string, () => UIMessage[]>());
  if (runtimeId && (engine.isReadyForSession(runtimeId) || !snapshots.current.has(runtimeId))) {
    const ready = engine.isReadyForSession(runtimeId);
    messageSnapshots.current.set(runtimeId, ready ? engine.getMessagesSnapshot : () => initialMessages);
    snapshots.current.set(runtimeId, {
      messages: ready ? engine.messages : initialMessages,
      isProcessing: ready ? engine.isProcessing : initialMeta?.isProcessing ?? false,
      isConnected: ready ? engine.isConnected : initialMeta?.isConnected ?? false,
      isCompacting: ready ? engine.isCompacting : initialMeta?.isCompacting ?? false,
      sessionInfo: ready ? engine.sessionInfo : initialMeta?.sessionInfo ?? null,
      totalCost: ready ? engine.totalCost : initialMeta?.totalCost ?? 0,
      contextUsage: ready ? engine.contextUsage : initialMeta?.contextUsage ?? null,
      pendingPermission: ready ? engine.pendingPermission : initialPermission,
      rawAcpPermission: isACP ? (ready ? acp.getRawPermission() : initialRawAcpPermission ?? null) : null,
      slashCommands: engine.slashCommands,
      codexGoal: isCodex ? codex.codexGoal : null,
      codexGoalSupported: isCodex ? codex.codexGoalSupported : null,
      reconnectMessage: engine.reconnectMessage,
    });
  }
  const stateForRuntime = runtimeId ? snapshots.current.get(runtimeId) : undefined;
  useEffect(() => {
    if (!runtimeId || !stateForRuntime) return;
    const states = snapshots.current;
    const readers = messageSnapshots.current;
    // Base reset has restored commit-time history. Publish that reader now,
    // rather than the stale bootstrap from the render preceding the reset.
    readers.set(runtimeId, engine.getMessagesSnapshot);
    const release = sharedSessionStore.registerLive(runtimeId, () => {
      const state = states.get(runtimeId) ?? stateForRuntime;
      return { ...state, messages: readers.get(runtimeId)?.() ?? state.messages };
    });
    return () => { release(); states.delete(runtimeId); readers.delete(runtimeId); };
  }, [runtimeId]);
  useEffect(() => {
    if (runtimeId) sharedSessionStore.notifyChanged(runtimeId);
  }, [runtimeId, engine.messages, engine.isProcessing, engine.pendingPermission, engine.totalCost, codex.codexGoal]);

  return {
    claude,
    acp,
    codex,
    engine,
    messages: engine.messages,
    totalCost: engine.totalCost,
    contextUsage: engine.contextUsage,
    isProcessing: engine.isProcessing,
    isConnected: engine.isConnected,
    isCompacting: "isCompacting" in engine ? !!engine.isCompacting : false,
    reconnectMessage: engine.reconnectMessage ?? null,
    sessionInfo: engine.sessionInfo,
    pendingPermission: engine.pendingPermission,
    codexGoal: codex.codexGoal,
    codexGoalSupported: codex.codexGoalSupported,
  };
}
