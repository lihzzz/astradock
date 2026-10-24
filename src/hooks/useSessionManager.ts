import { useState, useCallback, useEffect, useRef } from "react";
import type { ChatSession, UIMessage, PermissionRequest, McpServerStatus, McpServerConfig, ModelInfo, AcpPermissionBehavior, EngineId, Project, ACPAuthenticateResult, ACPConfigOption, ACPPermissionEvent } from "@/types";
import { toMcpStatusState } from "../lib/mcp-utils";
import { toChatSession } from "../lib/session/records";
import { sharedSessionStore } from "../lib/background/shared-session-store";
import { createSystemMessage } from "../lib/message-factory";
import {
  CONTINUE_INTERRUPTED_TURN_PROMPT,
  getRetryRequest,
  isRetryableUpstreamError,
} from "../lib/session/retry";
import { suppressNextSessionCompletion } from "../lib/notification-utils";
import {
  DRAFT_ID,
  type StartOptions,
  type CodexModelSummary,
  type InitialMeta,
  type PendingAcpDraftPrompt,
  type QueuedMessage,
  type SessionPaneBootstrap,
  type SharedSessionRefs,
  type SharedSessionSetters,
  type EngineHooks,
  buildCodexCollabMode,
} from "./session/types";
import { useSessionPane } from "./session/useSessionPane";
import { useMessageQueue } from "./session/useMessageQueue";
import { useSessionPersistence } from "./session/useSessionPersistence";
import { useBackgroundReaper } from "./session/useBackgroundReaper";
import { useDraftMaterialization } from "./session/useDraftMaterialization";
import { useSessionRevival } from "./session/useSessionRevival";
import { useSessionLifecycle } from "./session/useSessionLifecycle";
import { resolveSessionCwd } from "./session/workspace-binding";
import { toast } from "sonner";

export function useSessionManager(
  projects: Project[],
  acpPermissionBehavior: AcpPermissionBehavior = "ask",
  onSpaceChange?: (spaceId: string) => void,
  /** Session IDs currently visible in extra split panes. */
  visibleSplitSessionIds: readonly string[] = [],
) {
  // ── Core state ──
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [startOptions, setStartOptions] = useState<StartOptions>({});
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [initialMeta, setInitialMeta] = useState<InitialMeta | null>(null);
  const [initialConfigOptions, setInitialConfigOptions] = useState<ACPConfigOption[]>([]);
  const [initialSlashCommands, setInitialSlashCommands] = useState<import("@/types").SlashCommand[]>([]);
  const [initialPermission, setInitialPermission] = useState<PermissionRequest | null>(null);
  const [initialRawAcpPermission, setInitialRawAcpPermission] = useState<ACPPermissionEvent | null>(null);
  const [acpMcpStatuses, setAcpMcpStatuses] = useState<McpServerStatus[]>([]);
  const [acpConfigOptionsLoading, setAcpConfigOptionsLoading] = useState(false);
  const [preStartedSessionId, setPreStartedSessionId] = useState<string | null>(null);
  const [draftAcpSessionId, setDraftAcpSessionId] = useState<string | null>(null);
  const [draftMcpStatuses, setDraftMcpStatuses] = useState<McpServerStatus[]>([]);
  const [cachedModels, setCachedModels] = useState<ModelInfo[]>([]);
  const [codexRawModels, setCodexRawModels] = useState<CodexModelSummary[]>([]);
  const [codexModelsLoadingMessage, setCodexModelsLoadingMessage] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  // ── Refs needed by extra pane loaders (declared early) ──
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const backgroundStoreRef = useRef(sharedSessionStore);

  useEffect(() => {
    if (visibleSplitSessionIds.length === 0) return;
    const visibleIds = new Set(visibleSplitSessionIds);
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((session) => {
        if (!visibleIds.has(session.id) || !session.hasUnreadCompletion) return session;
        changed = true;
        return { ...session, hasUnreadCompletion: false };
      });
      return changed ? next : prev;
    });
  }, [visibleSplitSessionIds]);

  // ── Determine active engine ──
  const activeEngine: EngineId = activeSessionId === DRAFT_ID
    ? (startOptions.engine ?? "claude")
    : (sessions.find(s => s.id === activeSessionId)?.engine ?? "claude");
  const isACP = activeEngine === "acp";
  const isCodex = activeEngine === "codex";

  const claudeSessionId = (activeEngine === "claude" && activeSessionId !== DRAFT_ID) ? activeSessionId : null;
  const acpSessionId = activeEngine === "acp"
    ? (activeSessionId !== DRAFT_ID ? activeSessionId : draftAcpSessionId)
    : null;
  const codexSessionId = (activeEngine === "codex" && activeSessionId !== DRAFT_ID) ? activeSessionId : null;
  const codexSessionModel = (activeEngine === "codex" && activeSessionId !== DRAFT_ID)
    ? (sessions.find((s) => s.id === activeSessionId)?.model ?? startOptions.model)
    : undefined;
  const codexPlanModeEnabled = activeEngine === "codex"
    ? (activeSessionId === DRAFT_ID
      ? !!startOptions.planMode
      : !!sessions.find((s) => s.id === activeSessionId)?.planMode)
    : false;

  // ── Primary session pane (wraps all three engine hooks) ──
  const primaryPane = useSessionPane({
    activeSessionId,
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
  });

  const { claude, acp, codex, engine } = primaryPane;
  const { messages, totalCost, contextUsage } = primaryPane;

  // ── All refs (21+) — kept for stale-closure avoidance ──
  const liveSessionIdsRef = useRef<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const totalCostRef = useRef(totalCost);
  totalCostRef.current = totalCost;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  // sessionsRef declared above (near extra pane loaders)
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const draftProjectIdRef = useRef(draftProjectId);
  draftProjectIdRef.current = draftProjectId;
  const startOptionsRef = useRef(startOptions);
  startOptionsRef.current = startOptions;
  const isProcessingRef = useRef(engine.isProcessing);
  isProcessingRef.current = engine.isProcessing;
  const isCompactingRef = useRef("isCompacting" in engine ? !!engine.isCompacting : false);
  isCompactingRef.current = "isCompacting" in engine ? !!engine.isCompacting : false;
  const isConnectedRef = useRef(engine.isConnected);
  isConnectedRef.current = engine.isConnected;
  const sessionInfoRef = useRef(engine.sessionInfo);
  sessionInfoRef.current = engine.sessionInfo;
  const pendingPermissionRef = useRef(engine.pendingPermission);
  pendingPermissionRef.current = engine.pendingPermission;
  // Split view: track visible split-pane session IDs for IPC routing gate
  const visibleSplitSessionIdsRef = useRef<readonly string[]>(visibleSplitSessionIds);
  visibleSplitSessionIdsRef.current = visibleSplitSessionIds;
  // Prevent cross-session bleed: skip the first lastMessageAt sync after switching chats.
  const lastMessageSyncSessionRef = useRef<string | null>(null);
  const preStartedSessionIdRef = useRef<string | null>(null);
  preStartedSessionIdRef.current = preStartedSessionId;  // kept in sync with state for event routing
  const draftAcpSessionIdRef = useRef<string | null>(null);
  draftAcpSessionIdRef.current = draftAcpSessionId;
  const draftMcpStatusesRef = useRef<McpServerStatus[]>([]);
  draftMcpStatusesRef.current = draftMcpStatuses;
  const materializingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageQueueRef = useRef<Map<string, QueuedMessage[]>>(new Map());
  const pendingAcpDraftPromptRef = useRef<PendingAcpDraftPrompt | null>(null);
  const retryInFlightRef = useRef<Set<string>>(new Set());
  const acpAgentIdRef = useRef<string | null>(null);
  const acpAgentSessionIdRef = useRef<string | null>(null);
  const codexRawModelsRef = useRef(codexRawModels);
  codexRawModelsRef.current = codexRawModels;
  const codexEffortRef = useRef(codex.codexEffort);
  codexEffortRef.current = codex.codexEffort;
  // Tracks whether current Codex effort was explicitly chosen by the user.
  const codexEffortManualOverrideRef = useRef(false);
  const acpPermissionBehaviorRef = useRef<AcpPermissionBehavior>(acpPermissionBehavior);
  acpPermissionBehaviorRef.current = acpPermissionBehavior;
  const currentBranchRef = useRef<string | undefined>(undefined);
  const [currentBranch, setCurrentBranchState] = useState<string | undefined>();
  // Stable ref to switchSession so toast callbacks don't capture stale closures
  const switchSessionRef = useRef<((id: string) => Promise<void>) | undefined>(undefined);
  // Stable ref for space switching — avoids adding onSpaceChange as a useCallback dependency
  const onSpaceChangeRef = useRef(onSpaceChange);
  onSpaceChangeRef.current = onSpaceChange;
  // backgroundStoreRef declared above (near extra pane loaders)

  // ── Codex effort helpers (kept in orchestrator — too small to extract) ──
  const setCodexEffortFromUser = useCallback((effort: string) => {
    codexEffortManualOverrideRef.current = true;
    codex.setCodexEffort(effort);
  }, [codex.setCodexEffort]);
  const applyCodexModelDefaultEffort = useCallback((effort: string | undefined) => {
    if (!effort || codexEffortManualOverrideRef.current) return;
    codex.setCodexEffort(effort);
  }, [codex.setCodexEffort]);
  const resetCodexEffortToModelDefault = useCallback((effort: string | undefined) => {
    if (!effort) return;
    codexEffortManualOverrideRef.current = false;
    codex.setCodexEffort(effort);
  }, [codex.setCodexEffort]);

  // ── Utility callbacks ──
  const findProject = useCallback((projectId: string) => {
    return projectsRef.current.find((p) => p.id === projectId) ?? null;
  }, []);

  const getProjectCwd = useCallback((project: Project) => {
    const selected = localStorage.getItem(`harnss-${project.id}-git-cwd`)?.trim();
    return selected || project.path;
  }, []);

  // ── Build shared refs/setters/engines objects for sub-hooks ──
  const refs: SharedSessionRefs = {
    activeSessionIdRef,
    sessionsRef,
    projectsRef,
    draftProjectIdRef,
    startOptionsRef,
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
    draftMcpStatusesRef,
    materializingRef,
    saveTimerRef,
    messageQueueRef,
    pendingAcpDraftPromptRef,
    acpAgentIdRef,
    acpAgentSessionIdRef,
    codexRawModelsRef,
    codexEffortRef,
    codexEffortManualOverrideRef,
    lastMessageSyncSessionRef,
    switchSessionRef,
    onSpaceChangeRef,
    acpPermissionBehaviorRef,
    currentBranchRef,
    visibleSplitSessionIdsRef,
  };

  const setters: SharedSessionSetters = {
    setSessions,
    setActiveSessionId,
    setInitialMessages,
    setInitialMeta,
    setInitialConfigOptions,
    setInitialSlashCommands,
    setInitialPermission,
    setInitialRawAcpPermission,
    setStartOptions,
    setDraftProjectId,
    setPreStartedSessionId,
    setDraftAcpSessionId,
    setAcpConfigOptionsLoading,
    setDraftMcpStatuses,
    setAcpMcpStatuses,
    setQueuedCount,
    setCachedModels,
    setCodexRawModels,
    setCodexModelsLoadingMessage,
  };

  const engines: EngineHooks = {
    claude,
    acp,
    codex,
    engine,
  };

  // ── Compose sub-hooks ──
  const { reviveSession, reviveAcpSession, reviveCodexSession, reviveQueuedMessage } = useSessionRevival({
    refs,
    setters,
    engines,
    findProject,
    getProjectCwd,
  });

  const {
    enqueueMessage,
    clearQueue,
    unqueueMessage,
    sendQueuedMessageNext,
    continueQueuedBackgroundSession,
    sendNextId,
  } = useMessageQueue({ refs, setters, engines, activeSessionId, reviveQueuedMessage });

  useBackgroundReaper({ refs });

  const { saveCurrentSession, seedBackgroundStore, generateSessionTitle } = useSessionPersistence({
    refs,
    setters,
    engines,
    activeSessionId,
    continueQueuedBackgroundSession,
  });

  const {
    eagerStartSession,
    eagerStartAcpSession,
    prefetchCodexModels,
    probeMcpServers,
    abandonEagerSession,
    abandonDraftAcpSession,
    materializeDraft,
  } =
    useDraftMaterialization({
      refs,
      setters,
      engines,
      findProject,
      getProjectCwd,
      generateSessionTitle,
      applyCodexModelDefaultEffort,
    });

  const {
    createSession,
    switchSession,
    deleteSession,
    archiveSession,
    renameSession,
    deselectSession,
    importCCSession,
    importAcpSession,
    setDraftAgent,
    setActiveModel,
    setSessionModel,
    setActivePermissionMode,
    setSessionPermissionMode,
    setActivePlanMode,
    setSessionPlanMode,
    setActiveThinking,
    setActiveClaudeEffort,
    setActiveClaudeModelAndEffort,
    setSessionClaudeModelAndEffort,
    restartAcpSession,
    restartActiveSessionInCurrentWorktree,
    fullRevertSession,
    send,
  } = useSessionLifecycle({
    refs,
    setters,
    engines,
    projects,
    activeSessionId,
    activeEngine,
    findProject,
    getProjectCwd,
    saveCurrentSession,
    seedBackgroundStore,
    eagerStartSession,
    eagerStartAcpSession,
    prefetchCodexModels,
    probeMcpServers,
    abandonEagerSession,
    abandonDraftAcpSession,
    materializeDraft,
    reviveSession,
    reviveAcpSession,
    reviveCodexSession,
    enqueueMessage,
    clearQueue,
    resetCodexEffortToModelDefault,
  });

  const ensureCodexSessionForGoal = useCallback(async (): Promise<string | null> => {
    if (activeEngine !== "codex") return null;
    if (codexSessionId) return codexSessionId;
    if (activeSessionId !== DRAFT_ID) return null;
    const sessionId = await materializeDraft("");
    if (!sessionId) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return sessionId;
  }, [activeEngine, activeSessionId, codexSessionId, materializeDraft]);

  const getCodexGoal = useCallback(async () => {
    const sessionId = await ensureCodexSessionForGoal();
    if (sessionId) await codex.getGoal(sessionId);
  }, [codex.getGoal, ensureCodexSessionForGoal]);
  const setCodexGoal = useCallback(async (input: { objective: string; tokenBudget: number | null }) => {
    const sessionId = await ensureCodexSessionForGoal();
    if (!sessionId) return false;
    return codex.setGoal(input, sessionId);
  }, [codex.setGoal, ensureCodexSessionForGoal]);
  const clearCodexGoal = useCallback(async () => codex.clearGoal(), [codex.clearGoal]);
  const pauseCodexGoal = useCallback(async () => codex.pauseGoal(), [codex.pauseGoal]);
  const resumeCodexGoal = useCallback(async () => codex.resumeGoal(), [codex.resumeGoal]);

  const retryLastMessage = useCallback(async (errorMessageId: string) => {
    if (isProcessingRef.current) return;
    if (retryInFlightRef.current.has(errorMessageId)) return;
    const request = getRetryRequest(messagesRef.current, errorMessageId);
    if (!request) return;

    retryInFlightRef.current.add(errorMessageId);
    // Disable this action before sending so a slow upstream cannot receive
    // duplicate requests from repeated clicks.
    engine.setMessages((prev) => prev.map((message) =>
      message.id === errorMessageId
        ? { ...message, retryable: false, continuable: false }
        : message,
    ));
    try {
      if (!request.continueFromPartial) {
        await send(request.content, request.images, request.displayContent);
        return;
      }

      // The failed turn already produced output/tool activity. Replaying the
      // original user prompt can duplicate edits or other side effects, so
      // continue the existing live session with a short resume instruction.
      const activeId = activeSessionIdRef.current;
      const continuation = CONTINUE_INTERRUPTED_TURN_PROMPT;
      if (activeId !== DRAFT_ID && activeId && liveSessionIdsRef.current.has(activeId)) {
        engine.setMessages((prev) => [
          ...prev,
          createSystemMessage("Continuing the interrupted task."),
        ]);

        let succeeded: boolean;
        if (activeEngine === "codex") {
          let collaborationMode: ReturnType<typeof buildCodexCollabMode>;
          try {
            collaborationMode = buildCodexCollabMode(
              codexPlanModeEnabled,
              sessionsRef.current.find((session) => session.id === activeId)?.model,
            );
          } catch (error) {
            engine.setMessages((prev) => [
              ...prev,
              createSystemMessage(error instanceof Error ? error.message : String(error), true),
            ]);
            return;
          }
          const result = await codex.sendRaw(continuation, undefined, collaborationMode);
          succeeded = result.ok;
        } else {
          const result = await engine.sendRaw(continuation);
          succeeded = typeof result === "boolean" ? result : result.ok;
        }
        if (!succeeded && activeEngine !== "acp") {
          engine.setMessages((prev) => [
            ...prev,
            createSystemMessage("Unable to continue the interrupted task.", true, true),
          ]);
        }
        return;
      }

      // If the live process is gone, the normal send path revives the session
      // first and then submits the continuation prompt to its transcript.
      await send(continuation);
    } finally {
      retryInFlightRef.current.delete(errorMessageId);
    }
  }, [
    activeEngine,
    codex,
    codexPlanModeEnabled,
    engine,
    send,
  ]);

  const seedDevExampleConversation = useCallback(async () => {
    if (!import.meta.env.DEV) return;
    const { buildDevExampleConversation } = await import("../lib/dev-seeding/chat-seed");
    const base = Date.now();
    const seeded = buildDevExampleConversation(base);
    engine.setMessages((prev) => [...prev, ...seeded.messages]);
    const activeId = activeSessionIdRef.current;
    if (activeId && activeId !== DRAFT_ID) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? { ...s, lastMessageAt: seeded.lastMessageAt }
            : s,
        ),
      );
    }
  }, [engine, setSessions]);

  const refreshSessions = useCallback(async (projectIds?: string[]) => {
    const ids = (projectIds && projectIds.length > 0)
      ? projectIds
      : projectsRef.current.map((p) => p.id);
    if (ids.length === 0) return;
    const uniqueIds = [...new Set(ids)];
    const lists = await Promise.all(uniqueIds.map((projectId) => window.claude.sessions.list(projectId)));
    const refreshed = lists.flat().map((session) =>
      toChatSession(session, session.id === activeSessionIdRef.current),
    );
    setSessions((prev) => {
      const keep = prev.filter((s) => !uniqueIds.includes(s.projectId));
      const existingById = new Map(prev.map((session) => [session.id, session]));
      const map = new Map<string, ChatSession>();
      [...keep, ...refreshed].forEach((session) => {
        const existing = existingById.get(session.id);
        map.set(session.id, existing
          ? {
              ...session,
              ...(session.agentSessionId ? {} : existing.agentSessionId ? { agentSessionId: existing.agentSessionId } : {}),
              isProcessing: existing.isProcessing,
              hasPendingPermission: existing.hasPendingPermission,
              hasUnreadCompletion: existing.hasUnreadCompletion,
              titleGenerating: existing.titleGenerating,
            }
          : session);
      });
      return Array.from(map.values()).sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
    });
  }, [setSessions]);

  // ── Derived state ──
  const isDraft = activeSessionId === DRAFT_ID;
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const setCurrentBranch = useCallback((branch: string | undefined) => {
    currentBranchRef.current = branch;
    setCurrentBranchState(branch);
  }, []);

  const completeAcpAuth = useCallback(async (result: ACPAuthenticateResult) => {
    if (!acpSessionId) return;
    const authOptions = { ...startOptionsRef.current };
    const authActiveId = activeSessionIdRef.current;
    const authProjectId = authActiveId === DRAFT_ID ? draftProjectIdRef.current
      : sessionsRef.current.find((session) => session.id === authActiveId)?.projectId;
    const authProject = authProjectId ? findProject(authProjectId) : null;
    let authCwd: string | undefined;
    try {
      if (authProject) authCwd = await resolveSessionCwd(authProject, authOptions.workspaceBinding, getProjectCwd);
      else if (authOptions.workspaceBinding) throw new Error("The application's project is no longer available.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      acp.setIsProcessing(false);
      return;
    }
    if (activeSessionIdRef.current !== authActiveId || startOptionsRef.current.conversationId !== authOptions.conversationId) return;
    const pendingPrompt = pendingAcpDraftPromptRef.current;
    acpAgentSessionIdRef.current = result.agentSessionId ?? acpAgentSessionIdRef.current;
    if (result.configOptions) {
      setInitialConfigOptions(result.configOptions);
      acp.setConfigOptions(result.configOptions);
    }
    if (result.mcpStatuses?.length) {
      const normalizedStatuses = result.mcpStatuses.map((status) => ({
        name: status.name,
        status: toMcpStatusState(status.status),
      }));
      setDraftMcpStatuses(normalizedStatuses);
      setAcpMcpStatuses(normalizedStatuses);
    }

    if (activeSessionIdRef.current === DRAFT_ID && draftProjectIdRef.current) {
      const project = findProject(draftProjectIdRef.current);
      if (project) {
        liveSessionIdsRef.current.add(acpSessionId);
        const now = Date.now();
        const currentBranch = authOptions.workspaceBinding ? undefined : currentBranchRef.current;
        setSessions((prev) => [
          {
            id: acpSessionId,
            conversationId: authOptions.conversationId ?? acpSessionId,
            workspaceBinding: authOptions.workspaceBinding,
            origin: authOptions.origin,
            projectId: project.id,
            title: "New Chat",
            createdAt: now,
            lastMessageAt: now,
            totalCost: 0,
            planMode: !!startOptionsRef.current.planMode,
            isActive: true,
            titleGenerating: true,
            engine: "acp" as const,
            agentId: startOptionsRef.current.agentId,
            agentSessionId: acpAgentSessionIdRef.current ?? undefined,
            ...(currentBranch ? { branch: currentBranch } : {}),
          },
          ...prev.filter((s) => s.id !== DRAFT_ID).map((s) => ({ ...s, isActive: false })),
        ]);
        setActiveSessionId(acpSessionId);
        setDraftProjectId(null);
        setDraftAcpSessionId(null);
        setAcpMcpStatuses(draftMcpStatusesRef.current.length > 0 ? draftMcpStatusesRef.current : []);
        if (pendingPrompt) {
          generateSessionTitle(acpSessionId, pendingPrompt.text, authCwd ?? getProjectCwd(project), "acp");
        }
      }
    }

    acp.clearAuthRequired();

    if (!pendingPrompt) return;
    pendingAcpDraftPromptRef.current = null;
    acp.setIsProcessing(true);
    const promptResult = await window.claude.acp.prompt(acpSessionId, pendingPrompt.text, pendingPrompt.images);
    if (promptResult?.error) {
      acp.setMessages((prev) => [
        ...prev,
        createSystemMessage(
          `ACP prompt error: ${promptResult.error}`,
          true,
          isRetryableUpstreamError(promptResult.error ?? ""),
        ),
      ]);
      acp.setIsProcessing(false);
    }
  }, [acp, acpSessionId, findProject, generateSessionTitle, getProjectCwd, setAcpMcpStatuses, setDraftAcpSessionId, setDraftMcpStatuses, setDraftProjectId, setInitialConfigOptions, setSessions]);

  const cancelAcpAuth = useCallback(async () => {
    pendingAcpDraftPromptRef.current = null;
    acp.clearAuthRequired();
    acp.setIsProcessing(false);
    if (activeSessionIdRef.current === DRAFT_ID) {
      acp.setMessages([]);
      abandonDraftAcpSession("auth_cancel");
      setSessions((prev) => prev.filter((s) => s.id !== DRAFT_ID).map((s) => ({ ...s, isActive: false })));
      setInitialMessages([]);
      setInitialMeta(null);
      setActiveSessionId(null);
      setDraftProjectId(null);
      return;
    }
    if (acpSessionId) {
      suppressNextSessionCompletion(acpSessionId);
      await window.claude.acp.stop(acpSessionId);
    }
  }, [abandonDraftAcpSession, acp, acpSessionId, setActiveSessionId, setDraftProjectId, setInitialMessages, setInitialMeta, setSessions]);

  const loadSplitPaneBootstrap = useCallback(async (sessionId: string): Promise<SessionPaneBootstrap | null> => {
    const session = sessionsRef.current.find((entry) => entry.id === sessionId);
    if (!session) {
      return null;
    }

    const backgroundState = backgroundStoreRef.current.get(sessionId);
    if (backgroundState) {
      return {
        session,
        initialMessages: backgroundState.messages,
        initialMeta: {
          isProcessing: backgroundState.isProcessing,
          isConnected: backgroundState.isConnected,
          sessionInfo: backgroundState.sessionInfo,
          totalCost: backgroundState.totalCost,
          contextUsage: backgroundState.contextUsage,
          isCompacting: backgroundState.isCompacting,
          codexGoal: backgroundState.codexGoal,
          codexGoalSupported: backgroundState.codexGoalSupported,
          reconnectMessage: backgroundState.reconnectMessage,
        },
        initialPermission: backgroundState.pendingPermission,
        initialConfigOptions: [],
        initialSlashCommands: backgroundState.slashCommands ?? [],
        initialRawAcpPermission: backgroundState.rawAcpPermission,
      };
    }

    const persistedSession = await window.claude.sessions.load(session.projectId, sessionId);
    if (!persistedSession) {
      return null;
    }

    return {
      session: { ...session, workspaceBinding: persistedSession.workspaceBinding, origin: persistedSession.origin,
        conversationId: persistedSession.conversationId ?? session.conversationId ?? session.id },
      initialMessages: persistedSession.messages ?? [],
      initialMeta: {
        isProcessing: false,
        isConnected: false,
        sessionInfo: null,
        totalCost: persistedSession.totalCost ?? 0,
        contextUsage: persistedSession.contextUsage ?? null,
      },
      initialPermission: null,
      initialConfigOptions: [],
      initialSlashCommands: [],
      initialRawAcpPermission: null,
    };
  }, []);

  // ACP agents own model selection through their config option API. Mirror a
  // successful model change into the shared session settings so OpenCode (and
  // other ACP agents) persist the same model state as Claude and Codex.
  const setACPConfig = useCallback(async (configId: string, value: string) => {
    const result = await acp.setConfig(configId, value);
    const changedOption = result.configOptions?.find((option) => option.id === configId);
    if (!result.error && (configId === "model" || changedOption?.category === "model")) {
      setActiveModel(value);
    }
    return result;
  }, [acp.setConfig, setActiveModel]);

  // ── Return ──
  return {
    primaryPane,
    sessions,
    setSessions,
    activeSessionId,
    setCurrentBranch,
    currentBranch,
    activeSession,
    activeWorkspaceBinding: isDraft ? startOptions.workspaceBinding : activeSession?.workspaceBinding,
    activeSessionOrigin: isDraft ? startOptions.origin : activeSession?.origin,
    activeEngine,
    isDraft,
    draftProjectId,
    createSession,
    switchSession,
    deselectSession,
    deleteSession,
    archiveSession,
    renameSession,
    importCCSession,
    importAcpSession,
    setActiveModel,
    setSessionModel,
    setActivePermissionMode,
    setSessionPermissionMode,
    setActivePlanMode,
    setSessionPlanMode,
    setActiveThinking,
    setActiveClaudeEffort,
    setActiveClaudeModelAndEffort,
    setSessionClaudeModelAndEffort,
    restartActiveSessionInCurrentWorktree,
    setDraftAgent,
    messages: engine.messages,
    isProcessing: engine.isProcessing,
    isConnected: engine.isConnected || isDraft,
    sessionInfo: engine.sessionInfo,
    totalCost: engine.totalCost,
    send,
    quickCaptureDraftIdentity: () => startOptionsRef.current.conversationId ?? null,
    ownsQuickCaptureDraft: (target: { projectId: string; agentId: string }, identity: string) => activeSessionIdRef.current === DRAFT_ID
      && draftProjectIdRef.current === target.projectId && (startOptionsRef.current.agentId ?? "claude-code") === target.agentId
      && startOptionsRef.current.conversationId === identity,
    quickCaptureDraftReadiness: (): "ready" | "preparing" | "authRequired" => {
      if (startOptionsRef.current.engine !== "acp") return "ready";
      if (acp.authRequired) return "authRequired";
      const id = draftAcpSessionIdRef.current;
      return id && liveSessionIdsRef.current.has(id) ? "ready" : "preparing";
    },
    retryLastMessage,
    unqueueMessage,
    sendQueuedMessageNext,
    sendNextId,
    seedDevExampleConversation,
    refreshSessions,
    loadSplitPaneBootstrap,
    queuedCount,
    stop: engine.stop,
    interrupt: async () => {
      // Clear queued messages before interrupting
      clearQueue();
      // During ACP startup (DRAFT + processing), abort the pending start process
      if (activeSessionIdRef.current === DRAFT_ID
          && startOptionsRef.current.engine === "acp"
          && isProcessingRef.current) {
        if (draftAcpSessionIdRef.current && liveSessionIdsRef.current.has(draftAcpSessionIdRef.current)) {
          await window.claude.acp.cancel(draftAcpSessionIdRef.current);
        } else {
          await window.claude.acp.abortPendingStart();
        }
        acp.setIsProcessing(false);
        return;
      }
      await engine.interrupt();
    },
    pendingPermission: engine.pendingPermission,
    respondPermission: engine.respondPermission,
    contextUsage: engine.contextUsage,
    isCompacting: "isCompacting" in engine ? !!engine.isCompacting : false,
    reconnectMessage: engine.reconnectMessage ?? null,
    compact: engine.compact,
    slashCommands: isCodex
      ? codex.slashCommands
      : isACP
        ? acp.slashCommands
        : claude.slashCommands,
    acpConfigOptions: acp.configOptions,
    acpConfigOptionsLoading,
    setACPConfig,
    mcpServerStatuses: isACP || isCodex
      ? (acpMcpStatuses.length > 0 ? acpMcpStatuses : draftMcpStatuses)
      : (claude.mcpServerStatuses.length > 0 ? claude.mcpServerStatuses : draftMcpStatuses),
    mcpStatusPreliminary: isDraft && draftMcpStatuses.length > 0 && (
      isACP || isCodex ? acpMcpStatuses.length === 0 : claude.mcpServerStatuses.length === 0
    ),
    refreshMcpStatus: isACP || isCodex
      ? (() => Promise.resolve())
      : (preStartedSessionId && isDraft)
        ? (async () => {
            const result = await window.claude.mcpStatus(preStartedSessionId);
            if (result.servers?.length) {
              setDraftMcpStatuses(result.servers.map(s => ({
                name: s.name,
                status: toMcpStatusState(s.status),
              })));
            }
          })
        : claude.refreshMcpStatus,
    reconnectMcpServer: isACP
      ? isDraft
        ? async (_name: string) => {
            // ACP draft: restart the hidden draft session so fresh auth is applied
            if (draftProjectIdRef.current) {
              abandonDraftAcpSession("mcp_reconnect");
              await probeMcpServers(draftProjectIdRef.current);
              await eagerStartAcpSession(draftProjectIdRef.current, startOptionsRef.current);
            }
          }
        : async (_name: string) => {
            // ACP live: restart session so fresh auth tokens are applied
            const currentId = activeSessionIdRef.current;
            const session = sessionsRef.current.find(s => s.id === currentId);
            if (!session) return;
            const servers = await window.claude.mcp.list(session.projectId);
            await restartAcpSession(servers);
          }
      : isCodex
        ? async (_name: string) => { /* Codex MCP reconnect: not yet implemented */ }
      : (preStartedSessionId && isDraft)
        ? (async (name: string) => {
            const result = await window.claude.mcpReconnect(preStartedSessionId, name);
            if (result?.restarted) {
              await new Promise(r => setTimeout(r, 3000));
            }
            const statusResult = await window.claude.mcpStatus(preStartedSessionId);
            if (statusResult.servers?.length) {
              setDraftMcpStatuses(statusResult.servers.map(s => ({
                name: s.name,
                status: toMcpStatusState(s.status),
              })));
            }
          })
        : claude.reconnectMcpServer,
    supportedModels: isCodex
      ? codex.codexModels
      : isACP
        ? []
        : claude.supportedModels.length > 0 ? claude.supportedModels : cachedModels,
    cachedClaudeModels: cachedModels,
    restartWithMcpServers: isACP
      ? isDraft
        ? async (servers: McpServerConfig[]) => {
            // ACP draft: restart the hidden session with the updated MCP server list
            if (draftProjectIdRef.current) {
              await probeMcpServers(draftProjectIdRef.current, servers);
              abandonDraftAcpSession("mcp_restart");
              await eagerStartAcpSession(draftProjectIdRef.current, startOptionsRef.current, servers);
            }
          }
        : async (servers: McpServerConfig[]) => {
            // ACP live: stop + restart session with updated MCP servers
            await restartAcpSession(servers);
          }
      : isCodex
        ? async (_servers: McpServerConfig[]) => { /* Codex MCP restart: not yet implemented */ }
      : (preStartedSessionId && isDraft)
        ? async (_servers: McpServerConfig[]) => {
            // Claude eager draft: stop old eager session and start fresh
            abandonEagerSession("mcp_restart");
            setDraftMcpStatuses(_servers.map(s => ({
              name: s.name,
              status: "pending" as const,
            })));
            if (draftProjectIdRef.current) {
              eagerStartSession(draftProjectIdRef.current, startOptionsRef.current);
            }
          }
        : claude.restartWithMcpServers,
    // File revert: only supported by Claude SDK engine
    revertFiles: activeEngine === "claude" ? claude.revertFiles : undefined,
    fullRevert: activeEngine === "claude" ? fullRevertSession : undefined,
    // Codex reasoning effort
    codexEffort: codex.codexEffort,
    setCodexEffort: setCodexEffortFromUser,
    codexAuthRequired: isCodex ? codex.authRequired : false,
    clearCodexAuthRequired: () => codex.setAuthRequired(false),
    acpAuthRequired: isACP ? acp.authRequired : false,
    acpAuthMethods: isACP ? acp.authMethods : [],
    acpAuthSessionId: acpSessionId,
    acpAuthAgentId: isACP
      ? (activeSessionId === DRAFT_ID ? startOptions.agentId ?? null : activeSession?.agentId ?? null)
      : null,
    completeAcpAuth,
    cancelAcpAuth,
    codexRawModels,
    codexModelsLoadingMessage,
    // Codex plan steps (from turn/plan/updated events — separate from Claude's TodoWrite tool)
    codexTodoItems: codex.todoItems,
    codexGoal: isCodex ? codex.codexGoal : null,
    codexGoalSupported: isCodex ? codex.codexGoalSupported : null,
    codexGoalLoading: isCodex ? codex.goalLoading : false,
    codexGoalError: isCodex ? codex.goalError : null,
    getCodexGoal: isCodex ? getCodexGoal : async () => undefined,
    setCodexGoal: isCodex ? setCodexGoal : async () => false,
    clearCodexGoal: isCodex ? clearCodexGoal : async () => false,
    pauseCodexGoal: isCodex ? pauseCodexGoal : async () => false,
    resumeCodexGoal: isCodex ? resumeCodexGoal : async () => false,
  };
}
