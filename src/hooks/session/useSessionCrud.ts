import { acpHistoryMessages } from "@/lib/engine/acp-history";
import { startTransition, useCallback, useRef } from "react";
import { toast } from "sonner";
import type { ChatSession, McpServerConfig, PersistedSession, Project, ACPConfigOption } from "@/types";
import { suppressNextSessionCompletion } from "../../lib/notification-utils";
import { capture } from "../../lib/analytics/analytics";
import { bgAgentStore } from "../../lib/background/agent-store";
import { invalidatePersistedCursor, patchSessionMetadata, saveSessionSmart } from "../../lib/session/persistence";
import { startBatchJob, waitForBatchJob } from "@/lib/session/batch-runtime";
import { conversationKey } from "@shared/lib/session-identity";
import type { HistoryLocation } from "@shared/types/productivity";
import { toChatSession } from "@/lib/session/records";
import {
  DRAFT_ID,
  DEFAULT_PERMISSION_MODE,
  getEffectiveClaudePermissionMode,
} from "./types";
import type { SharedSessionRefs, SharedSessionSetters, EngineHooks, StartOptions } from "./types";
import { resolveSessionCwd } from "./workspace-binding";

interface UseSessionCrudParams {
  refs: SharedSessionRefs;
  setters: SharedSessionSetters;
  engines: { acp: Pick<EngineHooks["acp"], "setMessages" | "setIsProcessing"> };
  findProject: (projectId: string) => Project | null;
  getProjectCwd: (project: Project) => string;
  // From persistence
  saveCurrentSession: () => Promise<void>;
  seedBackgroundStore: () => void;
  // From draft materialization
  eagerStartSession: (projectId: string, options?: StartOptions) => Promise<void>;
  eagerStartAcpSession: (projectId: string, options?: StartOptions, overrideServers?: McpServerConfig[]) => Promise<void>;
  prefetchCodexModels: (preferredModel?: string) => Promise<void>;
  probeMcpServers: (projectId: string, overrideServers?: McpServerConfig[]) => Promise<void>;
  abandonEagerSession: (reason?: string) => void;
  abandonDraftAcpSession: (reason?: string) => void;
  // From session cache
  cacheSessionPayload: (data: PersistedSession) => void;
  consumeCachedSessionPayload: (sessionId: string) => PersistedSession | null;
  applyLoadedSession: (id: string, data: PersistedSession) => void;
  evictFromCache: (sessionId: string) => void;
  // From message queue
  clearQueue: () => void;
}

export function useSessionCrud({
  refs,
  setters,
  engines,
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
  cacheSessionPayload,
  consumeCachedSessionPayload,
  applyLoadedSession,
  evictFromCache,
  clearQueue,
}: UseSessionCrudParams) {
  const createRequestIdRef = useRef(0);
  const { acp } = engines;
  const {
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
    setDraftMcpStatuses,
    setAcpConfigOptionsLoading,
    setAcpMcpStatuses,
  } = setters;
  const {
    activeSessionIdRef,
    sessionsRef,
    liveSessionIdsRef,
    backgroundStoreRef,
    draftProjectIdRef,
    startOptionsRef,
    acpAgentIdRef,
    acpAgentSessionIdRef,
    messageQueueRef,
    materializingRef,
    switchSessionRef,
    onSpaceChangeRef,
  } = refs;

  const switchRequestIdRef = useRef(0);

  const clearSessionPlanMode = useCallback((session: ChatSession) => {
    const normalizedPermissionMode = session.permissionMode?.trim() || DEFAULT_PERMISSION_MODE;

    setSessions((prev) => prev.map((entry) => (
      entry.id === session.id && entry.planMode
        ? { ...entry, planMode: false }
        : entry
    )));

    if (session.planMode) void patchSessionMetadata(session.projectId, session.id, { planMode: false })
      .catch((error) => toast.error("Failed to save session mode", { description: String(error) }));

    if ((session.engine ?? "claude") !== "claude" || !liveSessionIdsRef.current.has(session.id)) {
      return;
    }

    const effectiveMode = getEffectiveClaudePermissionMode({
      permissionMode: normalizedPermissionMode,
      planMode: false,
    });
    window.claude.setPermissionMode(session.id, effectiveMode).then((result) => {
      if (result?.error) {
        toast.error("Failed to update plan mode", { description: result.error });
      }
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Failed to update plan mode", { description: message });
    });
  }, [liveSessionIdsRef, setSessions]);

  // ── Create a new session (draft) ──

  const createSession = useCallback(
    async (projectId: string, options?: StartOptions, activation?: { beforeActivate?: () => void }) => {
      const requestId = ++createRequestIdRef.current;
      const previousActiveId = activeSessionIdRef.current;
      const previousConversationId = startOptionsRef.current.conversationId;
      const nextStartOptions = { ...options, conversationId: options?.conversationId ?? crypto.randomUUID(),
        ...(options?.workspaceBinding ? { workspaceBinding: { ...options.workspaceBinding } } : {}),
        ...(options?.origin ? { origin: { ...options.origin } } : {}) };
      if (nextStartOptions.workspaceBinding) {
        const project = findProject(projectId);
        if (!project) throw new Error("The application's project is no longer available.");
        await resolveSessionCwd(project, nextStartOptions.workspaceBinding, getProjectCwd);
        if (requestId !== createRequestIdRef.current || activeSessionIdRef.current !== previousActiveId
          || startOptionsRef.current.conversationId !== previousConversationId) {
          throw new Error("The application conversation was superseded by another selection.");
        }
      } else if (nextStartOptions.origin) {
        throw new Error("Application conversations require a fixed workspace binding.");
      }
      // The caller may have checked its composer before the asynchronous path
      // validation. Re-check synchronously at the last point before any draft
      // teardown or state mutation; never persist renderer callbacks in options.
      activation?.beforeActivate?.();
      abandonEagerSession("new_draft");
      abandonDraftAcpSession("new_draft");
      acpAgentIdRef.current = null;
      acpAgentSessionIdRef.current = null;
      setAcpMcpStatuses([]);
      seedBackgroundStore();
      void saveCurrentSession();
      const draftEngine = options?.engine ?? "claude";
      // Keep the ref-backed routing state in sync with the setters so a
      // programmatic create-then-send cannot send through the old session.
      startOptionsRef.current = nextStartOptions;
      draftProjectIdRef.current = projectId;
      activeSessionIdRef.current = DRAFT_ID;
      setStartOptions(nextStartOptions);
      setDraftProjectId(projectId);
      setInitialMessages([]);
      setInitialMeta(null);
      setInitialConfigOptions([]);
      setInitialSlashCommands([]);
      setAcpConfigOptionsLoading(draftEngine === "acp");
      setInitialPermission(null);
      setInitialRawAcpPermission(null);
      // Explicitly clear ACP state — when activeSessionId is already DRAFT_ID,
      // useACP's reset effect won't fire, so stale messages (e.g. from a failed start) would persist
      acp.setMessages([]);
      acp.setIsProcessing(false);
      setActiveSessionId(DRAFT_ID);
      // Remove any leftover pending DRAFT_ID session from a previous failed ACP start
      setSessions((prev) => prev.filter(s => s.id !== DRAFT_ID).map((s) => ({ ...s, isActive: false })));

      if (draftEngine === "claude") {
        // Eager start for Claude engine (fire-and-forget)
        eagerStartSession(projectId, nextStartOptions);
        // Set immediate "pending" statuses while SDK connects
        window.claude.mcp.list(projectId).then(servers => {
          if (activeSessionIdRef.current === DRAFT_ID && draftProjectIdRef.current === projectId) {
            setDraftMcpStatuses(servers.map(s => ({
              name: s.name,
              status: "pending" as const,
            })));
          }
        }).catch(() => { /* IPC failure */ });
      } else if (draftEngine === "acp") {
        eagerStartAcpSession(projectId, nextStartOptions);
        probeMcpServers(projectId);
      } else {
        // Codex: no eager start; prefetch model list for the picker.
        setDraftMcpStatuses([]);
        prefetchCodexModels(options?.model);
      }
    },
    [findProject, getProjectCwd, saveCurrentSession, seedBackgroundStore, eagerStartSession, eagerStartAcpSession, abandonEagerSession, abandonDraftAcpSession, prefetchCodexModels, probeMcpServers],
  );

  // ── Switch to an existing session ──

  const switchSession = useCallback(
    async (id: string, historyLocation?: HistoryLocation, activation?: { beforeActivate?: () => void }) => {
      const requestId = ++switchRequestIdRef.current;
      const previousActiveId = activeSessionIdRef.current;
      const previousConversationId = startOptionsRef.current.conversationId;
      let validatedData: PersistedSession | null = null;
      let restoredSession: ChatSession | null = null;
      if (historyLocation) {
        const [data, metadata] = await Promise.all([
          window.claude.sessions.load(historyLocation.projectId, id),
          window.claude.sessions.list(historyLocation.projectId),
        ]);
        if (requestId !== switchRequestIdRef.current) throw new Error("History navigation was cancelled");
        const meta = metadata.find((entry) => entry.id === id && conversationKey(entry) === historyLocation.conversationKey);
        if (!data || !meta) throw new Error("The original conversation is no longer available");
        const messages = id === activeSessionIdRef.current ? refs.messagesRef.current : backgroundStoreRef.current.get(id)?.messages ?? data.messages;
        if (historyLocation.messageId !== null && !messages.some((message) => message.id === historyLocation.messageId)) throw new Error("The original message is no longer available");
        if (!sessionsRef.current.some((session) => session.id === id && session.projectId === historyLocation.projectId)) {
          restoredSession = toChatSession(meta, false);
        }
        validatedData = data;
      } else if (activation && id !== activeSessionIdRef.current && !backgroundStoreRef.current.get(id)) {
        const session = sessionsRef.current.find((entry) => entry.id === id);
        if (!session) throw new Error("The original conversation is no longer available");
        validatedData = await window.claude.sessions.load(session.projectId, id);
        if (!validatedData) throw new Error("The original conversation is no longer available");
      }
      if (activation && (requestId !== switchRequestIdRef.current || activeSessionIdRef.current !== previousActiveId
        || startOptionsRef.current.conversationId !== previousConversationId)) {
        throw new Error("The application conversation was superseded by another selection.");
      }
      // Guard only after all required reads, before changing the old composer or
      // navigation. Retain the validated payload so activation needs no more I/O.
      activation?.beforeActivate?.();
      if (restoredSession) {
        const session = restoredSession;
        sessionsRef.current = [...sessionsRef.current, session];
        setSessions((previous) => previous.some((entry) => entry.id === id) ? previous : [...previous, session]);
      }
      if (validatedData && id !== activeSessionIdRef.current && !backgroundStoreRef.current.get(id)) cacheSessionPayload(validatedData);
      if (id === activeSessionIdRef.current) return;

      // A draft can be in the middle of materializing after its first prompt.
      // Keep that startup alive so switching chats does not discard the only
      // in-memory representation of the new conversation.
      const materializingDraft = activeSessionIdRef.current === DRAFT_ID && materializingRef.current;
      if (!materializingDraft) {
        abandonEagerSession("switch_session");
        abandonDraftAcpSession("switch_session");
      }
      acpAgentIdRef.current = null;
      acpAgentSessionIdRef.current = null;
      seedBackgroundStore();
      void saveCurrentSession();

      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session) return;
      clearSessionPlanMode(session);
      const sessionOptions: StartOptions = {
        ...startOptionsRef.current,
        conversationId: session.conversationId ?? session.id,
        workspaceBinding: session.workspaceBinding,
        origin: session.origin,
        engine: session.engine ?? "claude",
        model: session.model,
        effort: session.effort,
        permissionMode: session.permissionMode,
        planMode: false,
        agentId: session.agentId,
      };
      startOptionsRef.current = sessionOptions;
      setStartOptions(sessionOptions);

      // Switch to the correct space for this session's project — ensures that
      // clicking a permission toast (or any cross-space navigation) lands in the right space
      const sessionProject = refs.projectsRef.current.find((p) => p.id === session.projectId);
      // Commit the space and session in the same transition. An earlier space
      // render would otherwise restore its remembered chat over this selection.
      const activateSpace = () => { if (sessionProject) onSpaceChangeRef.current?.(sessionProject.spaceId || "default"); };

      // Restore from the in-memory session cache if available.
      const bgState = backgroundStoreRef.current.consume(id);
      if (bgState) {
        const normalizedBgSessionInfo = bgState.sessionInfo?.permissionMode === "plan"
          ? {
              ...bgState.sessionInfo,
              permissionMode: session.permissionMode?.trim() || DEFAULT_PERMISSION_MODE,
            }
          : bgState.sessionInfo;
        startTransition(() => {
          activateSpace();
          setInitialMessages(bgState.messages);
          setInitialMeta({
            isProcessing: bgState.isProcessing,
            isConnected: bgState.isConnected,
            sessionInfo: normalizedBgSessionInfo,
            totalCost: bgState.totalCost,
            contextUsage: bgState.contextUsage,
            isCompacting: bgState.isCompacting,
            codexGoal: bgState.codexGoal,
            codexGoalSupported: bgState.codexGoalSupported,
            reconnectMessage: bgState.reconnectMessage,
          });
          setInitialPermission(bgState.pendingPermission);
          setInitialRawAcpPermission(bgState.rawAcpPermission);
          setInitialSlashCommands(bgState.slashCommands ?? []);
          setActiveSessionId(id);
          setDraftProjectId(null);
          setSessions((prev) =>
            prev.filter(s => s.id !== DRAFT_ID).map((s) => ({
              ...s,
              isActive: s.id === id,
              ...(s.id === id ? { hasPendingPermission: false } : {}),
            })),
          );
        });
        toast.dismiss(`permission-${id}`);
        return;
      }

      const cachedData = consumeCachedSessionPayload(id);
      if (cachedData) {
        startTransition(() => { activateSpace(); applyLoadedSession(id, { ...cachedData, planMode: false }); });
        return;
      }

      // Fall back to loading from disk (non-live session)
      const data = validatedData ?? await window.claude.sessions.load(session.projectId, id);
      if (requestId !== switchRequestIdRef.current) return;
      if (data) {
        cacheSessionPayload({ ...data, planMode: false });
        const restored = consumeCachedSessionPayload(id);
        if (restored) {
          startTransition(() => { activateSpace(); applyLoadedSession(id, { ...restored, planMode: false }); });
        }
      }
    },
    [
      abandonDraftAcpSession,
      abandonEagerSession,
      applyLoadedSession,
      cacheSessionPayload,
      consumeCachedSessionPayload,
      saveCurrentSession,
      seedBackgroundStore,
      setActiveSessionId,
      setDraftProjectId,
      setInitialMessages,
      setInitialMeta,
      setInitialPermission,
      setInitialRawAcpPermission,
      setInitialSlashCommands,
      setSessions,
      setStartOptions,
    ],
  );

  // Keep switchSessionRef in sync for stable toast callbacks
  switchSessionRef.current = switchSession;

  // ── Delete a session ──

  const deleteSession = useCallback(
    async (id: string) => {
      const session = sessionsRef.current.find((s) => s.id === id);
      if (!session) return;
      suppressNextSessionCompletion(id);
      const started = await startBatchJob({ requestId: crypto.randomUUID(), action: "delete", targets: [{ projectId: session.projectId, conversationKey: conversationKey(session) }] });
      const result = await waitForBatchJob(started.jobId);
      if (result.items[0]?.state !== "succeeded") {
        toast.error("Failed to delete conversation", { description: result.items[0]?.error?.message });
        return;
      }
      evictFromCache(id);
      liveSessionIdsRef.current.delete(id);
      backgroundStoreRef.current.delete(id);
      messageQueueRef.current.delete(id);
      bgAgentStore.clearSession(id);
      invalidatePersistedCursor(id);
      // Dismiss any permission toast for this session
      toast.dismiss(`permission-${id}`);
      if (activeSessionIdRef.current === id) {
        clearQueue();
        setActiveSessionId(null);
        setInitialMessages([]);
        setInitialMeta(null);
        setInitialPermission(null);
        setInitialRawAcpPermission(null);
      }
      setSessions((prev) => prev.filter((s) => s.id !== id));
    },
    [clearQueue, evictFromCache],
  );

  // ── Archive / unarchive a session ──

  const archiveSession = useCallback(async (id: string, archived: boolean) => {
    const session = sessionsRef.current.find((entry) => entry.id === id);
    if (!session || session.archived === archived) return;

    setSessions((prev) => prev.map((entry) => (
      entry.id === id ? { ...entry, archived } : entry
    )));

    const result = await window.claude.sessions.updateMeta(session.projectId, id, { archived });
    if (result?.error) {
      setSessions((prev) => prev.map((entry) => (
        entry.id === id ? { ...entry, archived: session.archived } : entry
      )));
      toast.error(archived ? "Failed to archive conversation" : "Failed to restore conversation", {
        description: result.error,
      });
    }
  }, []);

  // ── Rename a session ──

  const renameSession = useCallback((id: string, title: string) => {
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title, titleGenerating: false } : s)),
    );
    void patchSessionMetadata(session.projectId, id, { title }).catch((error) => {
      toast.error("Failed to rename session", { description: String(error) });
    });
  }, []);

  // ── Deselect the active session ──

  const deselectSession = useCallback(async () => {
    abandonEagerSession("deselect");
    abandonDraftAcpSession("deselect");
    seedBackgroundStore();
    void saveCurrentSession();
    setActiveSessionId(null);
    setDraftProjectId(null);
    setInitialMessages([]);
    setInitialMeta(null);
    setInitialPermission(null);
    setInitialRawAcpPermission(null);
    // Filter out any leftover DRAFT_ID placeholder from a pending ACP start
    setSessions((prev) => prev.filter(s => s.id !== DRAFT_ID).map((s) => ({ ...s, isActive: false })));
  }, [saveCurrentSession, seedBackgroundStore, abandonEagerSession, abandonDraftAcpSession]);

  // ── Import a Claude Code session ──

  const importCCSession = useCallback(
    async (projectId: string, ccSessionId: string) => {
      const project = findProject(projectId);
      if (!project) return;

      // If already imported, just switch to it
      const existing = sessionsRef.current.find((s) => s.id === ccSessionId);
      if (existing) {
        await switchSession(ccSessionId);
        return;
      }

      seedBackgroundStore();
      void saveCurrentSession();

      const result = await window.claude.ccSessions.import(getProjectCwd(project), ccSessionId);
      if (result.error || !result.messages) return;

      const firstUserMsg = result.messages.find((m) => m.role === "user");
      const titleText = firstUserMsg?.content || "Imported Session";

      const newSession: ChatSession = {
        id: ccSessionId,
        projectId: project.id,
        title: titleText.length > 60 ? titleText.slice(0, 57) + "..." : titleText,
        createdAt: result.messages[0]?.timestamp || Date.now(),
        totalCost: 0,
        isActive: true,
      };

      // Persist immediately so switchSession can load it later
      await window.claude.sessions.save({
        id: ccSessionId,
        conversationId: ccSessionId,
        projectId: project.id,
        title: newSession.title,
        createdAt: newSession.createdAt,
        messages: result.messages,
        totalCost: 0,
      });
      cacheSessionPayload({
        id: ccSessionId,
        projectId: project.id,
        title: newSession.title,
        createdAt: newSession.createdAt,
        messages: result.messages,
        totalCost: 0,
      });

      setSessions((prev) => [
        newSession,
        ...prev.map((s) => ({ ...s, isActive: false })),
      ]);
      setInitialMessages(result.messages);
      setInitialMeta(null);
      setActiveSessionId(ccSessionId);
      setDraftProjectId(null);
      capture("session_imported", { message_count: result.messages.length });
    },
    [cacheSessionPayload, findProject, saveCurrentSession, seedBackgroundStore, switchSession],
  );

  const importAcpSession = useCallback(async (sourceId: string, remote: { sessionId: string; title?: string | null }) => {
    const viewId = activeSessionIdRef.current;
    const source = sessionsRef.current.find(session => session.id === sourceId);
    if (!source?.agentId || source.engine !== "acp") throw new Error("ACP source session not found");
    const existing = sessionsRef.current.find(session => session.projectId === source.projectId && session.agentId === source.agentId && session.agentSessionId === remote.sessionId);
    if (existing) { await switchSession(existing.id); return; }
    const history = await window.claude.acp.readSession(sourceId, remote.sessionId);
    if (history.error || !history.events) throw new Error(history.error ?? "ACP history unavailable");
    if (!sessionsRef.current.some(session => session.id === sourceId) || !findProject(source.projectId)) throw new Error("Source session was removed during import");
    const id = crypto.randomUUID();
    const persisted: PersistedSession = {
      id, conversationId: id, projectId: source.projectId, title: remote.title?.trim() || "Imported ACP session",
      createdAt: Date.now(), totalCost: 0, engine: "acp", agentId: source.agentId, agentSessionId: remote.sessionId,
      workspaceBinding: source.workspaceBinding, messages: acpHistoryMessages(history.events),
    };
    await saveSessionSmart(persisted);
    cacheSessionPayload(persisted);
    const session = toChatSession({ ...persisted, lastMessageAt: persisted.createdAt }, false);
    sessionsRef.current = [session, ...sessionsRef.current];
    setSessions(prev => [session, ...prev]);
    if (activeSessionIdRef.current === viewId) await switchSession(id);
  }, [activeSessionIdRef, cacheSessionPayload, findProject, setSessions, switchSession, sessionsRef]);

  // ── Switch draft engine/agent ──

  const setDraftAgent = useCallback((draftEngine: string, agentId: string, _cachedConfigOptions?: ACPConfigOption[], model?: string) => {
    const prevEngine = startOptionsRef.current.engine ?? "claude";
    const prevAgentId = startOptionsRef.current.agentId;
    if (prevEngine !== draftEngine) {
      capture("engine_switched", { from_engine: prevEngine, to_engine: draftEngine });
    }

    if (draftEngine !== "claude") {
      // Switching away from Claude draft should immediately close the eager Claude session.
      abandonEagerSession("engine_switch");
    }
    if (prevEngine === "acp" && (draftEngine !== "acp" || agentId !== prevAgentId)) {
      abandonDraftAcpSession("engine_switch");
    }

    const normalizedModel = typeof model === "string" ? model.trim() : "";
    const nextOptions = {
      ...startOptionsRef.current,
      engine: draftEngine as StartOptions["engine"],
      agentId,
      model: normalizedModel || undefined,
    };
    startOptionsRef.current = nextOptions;
    setStartOptions(nextOptions);
    if (draftEngine === "codex") {
      prefetchCodexModels(normalizedModel || undefined);
    } else if (draftEngine === "acp" && draftProjectIdRef.current) {
      setInitialConfigOptions([]);
      setInitialSlashCommands([]);
      eagerStartAcpSession(draftProjectIdRef.current, {
        ...startOptionsRef.current,
        engine: "acp",
        agentId,
        model: normalizedModel || undefined,
      });
      probeMcpServers(draftProjectIdRef.current);
    }
  }, [prefetchCodexModels, abandonEagerSession, abandonDraftAcpSession, eagerStartAcpSession, probeMcpServers]);

  return {
    createSession,
    switchSession,
    deleteSession,
    archiveSession,
    renameSession,
    deselectSession,
    importCCSession,
    importAcpSession,
    setDraftAgent,
  };
}
