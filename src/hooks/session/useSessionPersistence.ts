import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { PersistedSession, ClaudeEvent, SystemInitEvent, EngineId, ACPSessionEvent, ACPPermissionEvent, ACPTurnCompleteEvent } from "@/types";
import { canonicalizeModelValue } from "@/lib/model-utils";
import { getSessionNotificationActor } from "@/lib/session-notifications";
import { toMcpStatusState } from "../../lib/mcp-utils";
import { buildPersistedSession } from "../../lib/session/records";
import { patchSessionMetadata, saveSessionSmart } from "../../lib/session/persistence";
import { createSystemMessage } from "../../lib/message-factory";
import { isRetryableUpstreamError } from "../../lib/session/retry";
import { normalizeToolInput as acpNormalizeToolInput, pickAutoResponseOption } from "../../lib/engine/acp-adapter";
import { CheckpointScheduler, registerCheckpointFlusher } from "@/lib/session/checkpoint-scheduler";
import { reportError } from "@/lib/analytics/analytics";
import { DRAFT_ID } from "./types";
import type { SharedSessionRefs, SharedSessionSetters, EngineHooks } from "./types";

interface UseSessionPersistenceParams {
  refs: SharedSessionRefs;
  setters: SharedSessionSetters;
  engines: EngineHooks;
  activeSessionId: string | null;
  continueQueuedBackgroundSession?: (sessionId: string) => boolean;
}

export function useSessionPersistence({
  refs,
  setters,
  engines,
  activeSessionId,
  continueQueuedBackgroundSession,
}: UseSessionPersistenceParams) {
  const { claude, acp, codex, engine } = engines;
  const { messages, totalCost, sessionInfo } = engine;
  const {
    setSessions,
    setDraftMcpStatuses,
    setPreStartedSessionId,
    setDraftAcpSessionId,
    setInitialConfigOptions,
    setInitialSlashCommands,
  } = setters;
  const {
    activeSessionIdRef,
    sessionsRef,
    messagesRef,
    totalCostRef,
    contextUsageRef,
    isProcessingRef,
    isCompactingRef,
    isConnectedRef,
    sessionInfoRef,
    pendingPermissionRef,
    liveSessionIdsRef,
    backgroundStoreRef,
    preStartedSessionIdRef,
    draftAcpSessionIdRef,
    lastMessageSyncSessionRef,
    switchSessionRef,
    acpPermissionBehaviorRef,
  } = refs;
  const activeClaudeModels = claude.supportedModels;

  // Persist session with Codex thread ID fallback
  const persistSessionWithCodexFallback = useCallback(async (data: PersistedSession) => {
    let payload = data;
    if (data.engine === "codex" && !data.codexThreadId) {
      try {
        const existing = await window.claude.sessions.load(data.projectId, data.id);
        if (existing?.codexThreadId) payload = { ...data, codexThreadId: existing.codexThreadId };
      } catch {
        // Best-effort fallback only.
      }
    }
    await saveSessionSmart(payload);
  }, []);

  const persistCodexGoalMutation = useCallback(async (sessionId: string, goal: PersistedSession["codexGoal"]) => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session || session.engine !== "codex") return;

    const backgroundState = backgroundStoreRef.current.get(sessionId);
    if (backgroundState) {
      await persistSessionWithCodexFallback(buildPersistedSession(
        { ...session, codexGoal: goal },
        backgroundState.messages,
        backgroundState.totalCost,
        backgroundState.contextUsage,
      ));
      return;
    }

    if (activeSessionIdRef.current === sessionId) {
      await persistSessionWithCodexFallback(buildPersistedSession(
        { ...session, codexGoal: goal },
        messagesRef.current.filter((message) => !message.isQueued),
        totalCostRef.current,
        contextUsageRef.current,
      ));
      return;
    }

    try {
      await patchSessionMetadata(session.projectId, sessionId, { codexGoal: goal });
    } catch {
      // Goal persistence is best effort; the next session load can refresh it from Codex.
    }
  }, [activeSessionIdRef, backgroundStoreRef, contextUsageRef, messagesRef, persistSessionWithCodexFallback, sessionsRef, totalCostRef]);

  // Wire up background store callbacks for sidebar indicators
  useEffect(() => {
    backgroundStoreRef.current.onProcessingChange = (sessionId, isProcessing) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const wasProcessing = !!session?.isProcessing;
      const backgroundGoal = backgroundStoreRef.current.get(sessionId)?.codexGoal;
      const goalOwnsCompletion = !!backgroundGoal;
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                isProcessing,
                ...(isProcessing
                  ? { hasUnreadCompletion: false }
                  : { hasUnreadCompletion: !goalOwnsCompletion })
              }
            : s,
        ),
      );

      const continuedQueuedSession = wasProcessing && !isProcessing
        ? !!continueQueuedBackgroundSession?.(sessionId)
        : false;

      if (wasProcessing && !isProcessing && session && !continuedQueuedSession && !goalOwnsCompletion) {
        window.dispatchEvent(new CustomEvent("harnss:background-session-complete", {
          detail: {
            sessionId,
            sessionTitle: session.title,
            actor: getSessionNotificationActor(session),
          },
        }));
      }
    };

    // When a background session receives a permission request, update sidebar + show toast
    backgroundStoreRef.current.onPermissionRequest = (sessionId, permission) => {
      // Update sidebar badge
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, hasPendingPermission: true } : s,
        ),
      );

      // Show a persistent toast so the user notices the blocked session
      const session = sessionsRef.current.find((s) => s.id === sessionId);
      const sessionTitle = session?.title ?? "Background session";
      const toolLabel = permission.toolName;

      toast(`${sessionTitle}`, {
        id: `permission-${sessionId}`,
        description: `Waiting for permission: ${toolLabel}`,
        duration: Infinity, // Permission is blocking — keep until resolved
        action: {
          label: "Switch",
          onClick: () => switchSessionRef.current?.(sessionId),
        },
      });

      window.dispatchEvent(new CustomEvent("harnss:background-permission-request", {
        detail: {
          sessionId,
          sessionTitle,
          actor: getSessionNotificationActor(session),
          permission,
        },
      }));
    };

    backgroundStoreRef.current.onGoalChange = (sessionId, goal) => {
      const terminal = goal?.status === "complete"
        || goal?.status === "blocked"
        || goal?.status === "usageLimited"
        || goal?.status === "budgetLimited";
      setSessions((prev) => prev.map((session) => session.id === sessionId
        ? { ...session, codexGoal: goal, ...(terminal ? { hasUnreadCompletion: true } : { hasUnreadCompletion: false }) }
        : session));
      void persistCodexGoalMutation(sessionId, goal);
      window.dispatchEvent(new CustomEvent("harnss:background-goal-updated", {
        detail: { sessionId, goal },
      }));
    };
  }, [backgroundStoreRef, continueQueuedBackgroundSession, persistCodexGoalMutation, sessionsRef, setSessions, switchSessionRef]);

  useEffect(() => {
    const handleGoalMutation = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; goal?: unknown }>).detail;
      if (typeof detail?.sessionId !== "string") return;
      void persistCodexGoalMutation(detail.sessionId, detail.goal as PersistedSession["codexGoal"]);
    };
    window.addEventListener("harnss:codex-goal-mutated", handleGoalMutation);
    return () => window.removeEventListener("harnss:codex-goal-mutated", handleGoalMutation);
  }, [persistCodexGoalMutation]);

  // Handle session exits across all engines
  useEffect(() => {
    const handleSessionExit = (sid: string, code: number | null, error?: string) => {
      liveSessionIdsRef.current.delete(sid);

      // If the pre-started eager session crashed, clear it
      if (sid === preStartedSessionIdRef.current) {
        preStartedSessionIdRef.current = null;
        setPreStartedSessionId(null);
        backgroundStoreRef.current.delete(sid);
        return;
      }
      if (sid === draftAcpSessionIdRef.current) {
        draftAcpSessionIdRef.current = null;
        setDraftAcpSessionId(null);
        setInitialConfigOptions([]);
        setInitialSlashCommands([]);
        backgroundStoreRef.current.delete(sid);
        return;
      }

      // Auto-save and mark disconnected for background sessions
      if (sid !== activeSessionIdRef.current && backgroundStoreRef.current.has(sid)) {
        if (code !== 0 && code !== null) {
          const errorText = error || `Session process exited with code ${code}`;
          const backgroundState = backgroundStoreRef.current.get(sid);
          if (backgroundState?.messages.at(-1)?.content !== errorText) {
            backgroundStoreRef.current.updateMessages(sid, (messages) => [
              ...messages,
              createSystemMessage(errorText, true, !!backgroundState?.isProcessing && isRetryableUpstreamError(errorText)),
            ]);
          }
        }
        backgroundStoreRef.current.markDisconnected(sid);
        const bgState = backgroundStoreRef.current.get(sid);
        const session = sessionsRef.current.find((s) => s.id === sid);
        if (bgState && session) {
          const persisted = buildPersistedSession(
            {
              ...session,
              model: session.model || bgState.sessionInfo?.model,
              ...(session.engine === "codex" ? { codexGoal: bgState.codexGoal ?? null } : {}),
            },
            bgState.messages,
            bgState.totalCost,
            bgState.contextUsage,
          );
          void saveSessionSmart(persisted);
        }
      }
    };

    const unsubExit = window.claude.onExit((data) => handleSessionExit(data._sessionId, data.code, data.error));
    const unsubAcpExit = window.claude.acp.onExit((data: { _sessionId: string; code: number | null; error?: string }) => handleSessionExit(data._sessionId, data.code, data.error));
    const unsubCodexExit = window.claude.codex.onExit((data) => handleSessionExit(
      data._sessionId,
      data.code,
      data.signal ? `Codex process exited with ${data.signal}` : undefined,
    ));
    return () => {
      unsubExit();
      unsubAcpExit();
      unsubCodexExit();
    };
  }, []);

  // Route events for non-active sessions to the background store
  useEffect(() => {
    const unsub = window.claude.onEvent((event: ClaudeEvent & { _sessionId?: string }) => {
      const sid = event._sessionId;
      if (!sid) return;
      // Pre-started session: route to background store AND extract MCP statuses
      if (sid === preStartedSessionIdRef.current) {
        if (!backgroundStoreRef.current.hasLive(sid)) backgroundStoreRef.current.handleEvent(event);
        if (event.type === "system" && "subtype" in event && event.subtype === "init") {
          const init = event as SystemInitEvent;
          if (init.mcp_servers?.length) {
            setDraftMcpStatuses(init.mcp_servers.map(s => ({
              name: s.name,
              status: toMcpStatusState(s.status),
            })));
          }
        }
        return;
      }

      if (!backgroundStoreRef.current.hasLive(sid)) backgroundStoreRef.current.handleEvent(event);
    });
    const unsubAcp = window.claude.acp.onEvent((event: ACPSessionEvent) => {
      const sid = event._sessionId;
      if (!sid) return;
      if (backgroundStoreRef.current.hasLive(sid)) return;
      backgroundStoreRef.current.handleACPEvent(event);
    });

    // Route permission requests for non-active Claude sessions to the background store
    const unsubBgPerm = window.claude.onPermissionRequest((data) => {
      const sid = data._sessionId;
      if (!sid || backgroundStoreRef.current.hasLive(sid)) return;
      backgroundStoreRef.current.setPermission(sid, {
        requestId: data.requestId,
        toolName: data.toolName,
        toolInput: data.toolInput,
        toolUseId: data.toolUseId,
        suggestions: data.suggestions,
        decisionReason: data.decisionReason,
      });
    });

    // Route permission requests for non-active ACP sessions to the background store
    // (auto-respond if the client-side permission behavior allows it)
    const unsubBgAcpPerm = window.claude.acp.onPermissionRequest((data: ACPPermissionEvent) => {
      const sid = data._sessionId;
      if (!sid || backgroundStoreRef.current.hasLive(sid)) return;

      // Auto-respond for background ACP sessions when behavior is configured
      const autoOptionId = pickAutoResponseOption(data.options, acpPermissionBehaviorRef.current);
      if (autoOptionId) {
        window.claude.acp.respondPermission(sid, data.requestId, autoOptionId);
        return;
      }

      backgroundStoreRef.current.setPermission(
        sid,
        {
          requestId: data.requestId,
          toolName: data.toolCall.title,
          toolInput: acpNormalizeToolInput(data.toolCall.rawInput, data.toolCall.kind),
          toolUseId: data.toolCall.toolCallId,
        },
        data,
      );
    });

    // Route turn-complete for non-active ACP sessions to the background store
    // (clears isProcessing so the session doesn't appear stuck when switching back)
    const unsubBgAcpTurn = window.claude.acp.onTurnComplete((data: ACPTurnCompleteEvent) => {
      const sid = data._sessionId;
      if (!sid || backgroundStoreRef.current.hasLive(sid)) return;
      backgroundStoreRef.current.handleACPTurnComplete(sid, data.stopReason);
    });

    // Route Codex events for non-active sessions to the background store
    const unsubCodex = window.claude.codex.onEvent((event) => {
      const sid = event._sessionId;
      if (!sid || backgroundStoreRef.current.hasLive(sid)) return;
      backgroundStoreRef.current.handleCodexEvent(event);
    });

    // Retain Codex approval requests until the user returns to their session
    const unsubCodexApproval = window.claude.codex.onApprovalRequest((data) => {
      const sid = data._sessionId;
      if (!sid || backgroundStoreRef.current.hasLive(sid)) return;
      if (data.method === "item/tool/requestUserInput") {
        backgroundStoreRef.current.setPermission(sid, {
          requestId: String(data.rpcId),
          toolName: "AskUserQuestion",
          toolInput: {
            source: "codex_request_user_input",
            questions: data.questions.map((question) => ({
              id: question.id,
              header: question.header,
              question: question.question,
              isOther: question.isOther,
              isSecret: question.isSecret,
              options: question.options ?? undefined,
              multiSelect: false,
            })),
          },
          toolUseId: data.itemId,
          codexRpcId: data.rpcId,
        });
        return;
      }

      // Keep the request pending; never silently decline an unseen approval
      backgroundStoreRef.current.setPermission(sid, {
        requestId: String(data.rpcId),
        toolName: data.method.includes("commandExecution") ? "Bash" : "Edit",
        toolInput: {},
        toolUseId: data.itemId,
        codexRpcId: data.rpcId,
      });
    });

    return () => { unsub(); unsubAcp(); unsubBgPerm(); unsubBgAcpPerm(); unsubBgAcpTurn(); unsubCodex(); unsubCodexApproval(); };
  }, []);

  // A single checkpoint owner saves primary, split and background sessions alike.
  const latest = useRef({ refs, codex });
  latest.current = { refs, codex };
  useEffect(() => {
    const store = latest.current.refs.backgroundStoreRef.current;
    const scheduler = new CheckpointScheduler((id) => {
      const current = latest.current;
      const session = current.refs.sessionsRef.current.find((entry) => entry.id === id);
      const state = store.get(id);
      if (!session || id === DRAFT_ID || !state) return null;
      if (!state.messages.length && session.engine !== "codex") return null;
      return buildPersistedSession({ ...session,
        ...(session.engine === "codex" ? { codexGoal: state.codexGoal ?? null } : {}),
      }, state.messages.filter((message) => !message.isQueued), state.totalCost, state.contextUsage);
    }, persistSessionWithCodexFallback, (error) => {
      reportError("SESSION_CHECKPOINT", error);
      toast.error("Could not save conversation. Your changes remain in memory; retry before quitting.", { id: "session-save-error" });
    });
    store.onChanged = (id) => {
      scheduler.mark(id, store.checkpointUrgent(id));
    };
    const unregister = registerCheckpointFlusher(async () => {
      for (const session of latest.current.refs.sessionsRef.current) if (store.has(session.id)) scheduler.mark(session.id);
      await scheduler.flushAll();
    });
    return () => {
      store.onChanged = undefined;
      unregister();
      void scheduler.flushAll().catch((error) => reportError("SESSION_CHECKPOINT_UNMOUNT", error)).finally(() => scheduler.dispose());
    };
  }, [persistSessionWithCodexFallback]);

  // Materialization can change the logical session without producing another engine event.
  useEffect(() => {
    if (activeSessionId && activeSessionId !== DRAFT_ID) backgroundStoreRef.current.notifyChanged(activeSessionId);
  }, [activeSessionId, backgroundStoreRef]);

  // Consolidated sync of session metadata to the session list (model, totalCost,
  // lastMessageAt, isProcessing, hasPendingPermission). A single effect avoids
  // multiple separate setSessions(prev => prev.map(...)) calls per render cycle.
  useEffect(() => {
    if (!activeSessionId || activeSessionId === DRAFT_ID) return;

    // Compute lastMessageAt — only user messages affect sort order
    let lastMessageAt: number | undefined;
    if (messages.length > 0) {
      // On session switch, React state can briefly still hold the previous session's messages.
      // Skip one cycle so we don't stamp the new session with stale activity timestamps.
      if (lastMessageSyncSessionRef.current !== activeSessionId) {
        lastMessageSyncSessionRef.current = activeSessionId;
      } else {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === "user" && typeof messages[i].timestamp === "number") {
            lastMessageAt = messages[i].timestamp;
            break;
          }
        }
      }
    }

    setSessions((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (s.id !== activeSessionId) return s;

        const updates: Record<string, unknown> = {};

        // Model sync
        const nextModel = (s.engine ?? "claude") === "claude"
          ? (activeClaudeModels.length > 0
            ? (canonicalizeModelValue(sessionInfo?.model, activeClaudeModels) ?? sessionInfo?.model)
            : s.model)
          : sessionInfo?.model;
        if (nextModel && s.model !== nextModel) {
          updates.model = nextModel;
        }

        if (sessionInfo?.permissionMode && s.permissionMode !== sessionInfo.permissionMode) {
          updates.permissionMode = sessionInfo.permissionMode;
        }

        // Total cost sync
        if (totalCost !== 0 && s.totalCost !== totalCost) {
          updates.totalCost = totalCost;
        }

        // lastMessageAt sync
        if (lastMessageAt !== undefined && s.lastMessageAt !== lastMessageAt) {
          updates.lastMessageAt = lastMessageAt;
        }

        // isProcessing sync
        if (s.isProcessing !== engine.isProcessing) {
          updates.isProcessing = engine.isProcessing;
        }

        if (s.engine === "codex" && s.codexGoal !== codex.codexGoal) {
          updates.codexGoal = codex.codexGoal;
        }

        // hasPendingPermission sync — clear badge when permission is resolved
        if (!engine.pendingPermission && s.hasPendingPermission) {
          updates.hasPendingPermission = false;
        }

        if (Object.keys(updates).length === 0) return s;
        changed = true;
        return { ...s, ...updates };
      });
      return changed ? next : prev;
    });
  }, [activeClaudeModels, activeSessionId, sessionInfo?.model, sessionInfo?.permissionMode, totalCost, messages.length, engine.isProcessing, engine.pendingPermission, codex.codexGoal]);

  // Save current session to disk (used before switching/creating)
  const saveCurrentSession = useCallback(async () => {
    const id = activeSessionIdRef.current;
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!id || id === DRAFT_ID || !session || (messagesRef.current.length === 0 && session.engine !== "codex")) return;
    // Never persist queued messages — unsent queue state is runtime-only.
    const msgs = (backgroundStoreRef.current.get(id)?.messages ?? messagesRef.current).filter((m) => !m.isQueued);
    const data: PersistedSession = buildPersistedSession(
      session.engine === "codex" ? { ...session, codexGoal: codex.codexGoal } : session,
      msgs,
      totalCostRef.current,
      contextUsageRef.current,
    );
    await persistSessionWithCodexFallback(data);
  }, [codex.codexGoal, persistSessionWithCodexFallback]);

  // Seed background store with current active session's state
  const seedBackgroundStore = useCallback(() => {
    const currentId = activeSessionIdRef.current;
    if (currentId && currentId !== DRAFT_ID) {
      // Pick slash commands from the active engine hook
      const sessionEngine = sessionsRef.current.find(s => s.id === currentId)?.engine ?? "claude";
      const slashCommands = sessionEngine === "codex"
        ? codex.slashCommands
        : sessionEngine === "acp"
          ? acp.slashCommands
          : claude.slashCommands;

      const live = backgroundStoreRef.current.get(currentId);
      backgroundStoreRef.current.initFromState(currentId, live ?? {
        messages: messagesRef.current,
        isProcessing: isProcessingRef.current,
        isConnected: isConnectedRef.current,
        isCompacting: isCompactingRef.current,
        sessionInfo: sessionInfoRef.current,
        totalCost: totalCostRef.current,
        contextUsage: contextUsageRef.current,
        pendingPermission: pendingPermissionRef.current ?? null,
        rawAcpPermission: sessionEngine === "acp" ? acp.getRawPermission() : null,
        slashCommands,
        codexGoal: sessionEngine === "codex" ? codex.codexGoal : null,
        codexGoalSupported: sessionEngine === "codex" ? codex.codexGoalSupported : null,
        reconnectMessage: sessionEngine === "codex" ? codex.reconnectMessage : null,
      });
    }
  }, [claude.slashCommands, acp.slashCommands, codex.slashCommands, codex.codexGoal, codex.codexGoalSupported, codex.reconnectMessage]);

  // AI-generated title via background utility prompt (SDK Haiku or ACP utility session)
  const generateSessionTitle = useCallback(
    async (sessionId: string, message: string, projectPath: string, titleEngine?: EngineId) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId ? { ...s, titleGenerating: true } : s,
        ),
      );

      const fallbackTitle =
        message.length > 60 ? message.slice(0, 57) + "..." : message;

      try {
        // Pass engine + sessionId so the IPC handler routes to ACP if needed
        const result = await window.claude.generateTitle(
          message,
          projectPath,
          titleEngine,
          titleEngine === "acp" ? sessionId : undefined,
        );

        // Guard: session may have been deleted or manually renamed while generating
        const current = sessionsRef.current.find((s) => s.id === sessionId);
        if (!current || !current.titleGenerating) return;

        const title = result.title || fallbackTitle;

        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, title, titleGenerating: false }
              : s,
          ),
        );

        // Persist the new title
        await patchSessionMetadata(current.projectId, sessionId, { title });
      } catch {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, title: fallbackTitle, titleGenerating: false }
              : s,
          ),
        );
      }
    },
    [],
  );

  return {
    saveCurrentSession,
    seedBackgroundStore,
    generateSessionTitle,
    persistSessionWithCodexFallback,
  };
}
