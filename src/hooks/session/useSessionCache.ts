import { startTransition, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { PersistedSession, Project } from "../../types";
import { toChatSession } from "../../lib/session/records";
import { DRAFT_ID } from "./types";
import { parseThreadGoal } from "@shared/lib/codex-goal";
import type { SharedSessionRefs, SharedSessionSetters, EngineHooks } from "./types";
import { isSessionFrozen, releaseSession } from "@/lib/session/batch-runtime";
import { invalidatePersistedCursor } from "@/lib/session/persistence";
import { bgAgentStore } from "@/lib/background/agent-store";

const MAX_SESSION_PAYLOAD_CACHE = 6;
const MAX_SESSION_PAYLOAD_BYTES = 32 * 1024 * 1024;
const payloadSizes = new WeakMap<PersistedSession, number>();
function payloadBytes(data: PersistedSession): number {
  const cached = payloadSizes.get(data);
  if (cached !== undefined) return cached;
  const bytes = JSON.stringify(data).length * 2;
  payloadSizes.set(data, bytes);
  return bytes;
}

interface UseSessionCacheParams {
  refs: SharedSessionRefs;
  setters: SharedSessionSetters;
  engines: EngineHooks;
  projects: Project[];
  activeSessionId: string | null;
  activeEngine: string;
  getProjectCwd: (project: Project) => string;
  prefetchCodexModels: (preferredModel?: string) => Promise<void>;
  abandonEagerSession: (reason: string) => void;
  abandonDraftAcpSession: (reason: string) => void;
}

export function useSessionCache({
  refs,
  setters,
  engines,
  projects,
  activeSessionId,
  activeEngine,
  getProjectCwd,
  prefetchCodexModels,
  abandonEagerSession,
  abandonDraftAcpSession,
}: UseSessionCacheParams) {
  const { codex } = engines;
  const {
    setSessions,
    setStartOptions,
    setInitialMessages,
    setInitialMeta,
    setInitialPermission,
    setInitialRawAcpPermission,
    setActiveSessionId,
    setDraftProjectId,
    setCachedModels,
  } = setters;
  const {
    activeSessionIdRef,
    sessionsRef,
    backgroundStoreRef,
    startOptionsRef,
  } = refs;

  const sessionPayloadCacheRef = useRef<Map<string, PersistedSession>>(new Map());
  const inFlightPrefetchRef = useRef<Set<string>>(new Set());
  const knownProjectsRef = useRef(new Set(projects.map((project) => project.id)));

  // ── LRU payload cache operations ──

  const cacheSessionPayload = useCallback((data: PersistedSession) => {
    if (isSessionFrozen(data.id) || !refs.projectsRef.current.some((project) => project.id === data.projectId)) return;
    const cache = sessionPayloadCacheRef.current;
    cache.delete(data.id);
    if (payloadBytes(data) > MAX_SESSION_PAYLOAD_BYTES) return;
    cache.set(data.id, data);
    let bytes = [...cache.values()].reduce((total, value) => total + payloadBytes(value), 0);
    while (cache.size > MAX_SESSION_PAYLOAD_CACHE || bytes > MAX_SESSION_PAYLOAD_BYTES) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      const evicted = cache.get(oldest);
      if (evicted) bytes -= payloadBytes(evicted);
      cache.delete(oldest);
    }
  }, [refs.projectsRef]);

  const consumeCachedSessionPayload = useCallback((sessionId: string) => {
    const cache = sessionPayloadCacheRef.current;
    const cached = cache.get(sessionId);
    if (!cached) return null;
    cache.delete(sessionId);
    return cached;
  }, []);

  /** Apply a loaded (or cached) session payload into React state. */
  const applyLoadedSession = useCallback((id: string, data: PersistedSession) => {
    if (isSessionFrozen(id) || !refs.projectsRef.current.some((project) => project.id === data.projectId)) return;
    const codexGoal = data.engine === "codex" ? parseThreadGoal(data.codexGoal) : null;
    startTransition(() => {
      const sessionOptions = {
        ...startOptionsRef.current,
        conversationId: data.conversationId ?? data.id,
        workspaceBinding: data.workspaceBinding,
        origin: data.origin,
        engine: data.engine ?? "claude",
        model: data.model,
        effort: data.effort,
        permissionMode: data.permissionMode,
        planMode: false,
        agentId: data.agentId,
      };
      startOptionsRef.current = sessionOptions;
      setStartOptions(sessionOptions);
      setInitialMessages(data.messages);
      setInitialMeta({
        isProcessing: false,
        isConnected: false,
        sessionInfo: null,
        totalCost: data.totalCost,
        contextUsage: data.contextUsage ?? null,
        codexGoal,
        codexGoalSupported: data.engine === "codex" ? null : false,
      });
      setInitialPermission(null);
      setInitialRawAcpPermission(null);
      setActiveSessionId(id);
      setDraftProjectId(null);
      setSessions((prev) =>
        prev.filter((s) => s.id !== DRAFT_ID).map((s) => ({
          ...s,
          isActive: s.id === id,
          ...(s.id === id ? {
            conversationId: data.conversationId ?? data.id,
            workspaceBinding: data.workspaceBinding,
            origin: data.origin,
            ...(data.engine ? { engine: data.engine } : {}),
            ...(data.agentId ? { agentId: data.agentId } : {}),
            ...(data.agentSessionId ? { agentSessionId: data.agentSessionId } : {}),
            ...(data.codexThreadId ? { codexThreadId: data.codexThreadId } : {}),
            ...(data.engine === "codex" ? { codexGoal } : {}),
            ...(data.effort ? { effort: data.effort } : {}),
            ...(data.permissionMode ? { permissionMode: data.permissionMode } : {}),
            planMode: false,
            hasPendingPermission: false,
            hasUnreadCompletion: false,
          } : {}),
        })),
      );
    });
  }, [
    refs.projectsRef,
    setActiveSessionId,
    setDraftProjectId,
    setInitialMessages,
    setInitialMeta,
    setInitialPermission,
    setInitialRawAcpPermission,
    setSessions,
    setStartOptions,
  ]);

  /** Evict a session from the payload cache (e.g. on delete). */
  const evictFromCache = useCallback((sessionId: string) => {
    sessionPayloadCacheRef.current.delete(sessionId);
    inFlightPrefetchRef.current.delete(sessionId);
  }, []);

  // ── Effects ──

  // Load sessions for ALL projects
  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    const removed = new Set([...knownProjectsRef.current].filter((id) => !projectIds.has(id)));
    knownProjectsRef.current = projectIds;
    if (removed.size) {
      const removedSessions = refs.sessionsRef.current.filter((session) => removed.has(session.projectId));
      const activeRemoved = removedSessions.some((session) => session.id === refs.activeSessionIdRef.current);
      const draftRemoved = !!refs.draftProjectIdRef.current && removed.has(refs.draftProjectIdRef.current);
      for (const session of removedSessions) {
        releaseSession(session.id, "project-deleted", true);
        refs.liveSessionIdsRef.current.delete(session.id);
        refs.backgroundStoreRef.current.delete(session.id);
        refs.messageQueueRef.current.delete(session.id);
        inFlightPrefetchRef.current.delete(session.id);
        invalidatePersistedCursor(session.id);
        bgAgentStore.clearSession(session.id);
        toast.dismiss(`permission-${session.id}`);
      }
      for (const [id, cached] of sessionPayloadCacheRef.current) if (removed.has(cached.projectId)) sessionPayloadCacheRef.current.delete(id);
      refs.sessionsRef.current = refs.sessionsRef.current.filter((session) => !removed.has(session.projectId));
      setSessions((previous) => previous.filter((session) => !removed.has(session.projectId)));
      if (draftRemoved) { abandonEagerSession("project_deleted"); abandonDraftAcpSession("project_deleted"); }
      if (activeRemoved || draftRemoved && refs.activeSessionIdRef.current === DRAFT_ID) {
        refs.activeSessionIdRef.current = null; refs.draftProjectIdRef.current = null;
        refs.messagesRef.current = []; refs.isProcessingRef.current = false;
        refs.acpAgentIdRef.current = null; refs.acpAgentSessionIdRef.current = null;
        refs.pendingAcpDraftPromptRef.current = null;
        setActiveSessionId(null); setDraftProjectId(null);
        setInitialMessages([]); setInitialMeta(null); setInitialPermission(null); setInitialRawAcpPermission(null);
        setters.setInitialConfigOptions([]); setters.setInitialSlashCommands([]); setters.setQueuedCount(0);
        engines.engine.setMessages([]); engines.engine.setIsProcessing(false);
      }
    }
    if (projects.length === 0) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      projects.map((p) => window.claude.sessions.list(p.id)),
    ).then((results) => {
      if (cancelled) return;
      const all = results.flat().map((session) => toChatSession(session, false));
      setSessions((prev) => {
        const existingById = new Map(prev.map((session) => [session.id, session]));
        return all.map((session) => {
          const existing = existingById.get(session.id);
          if (!existing) return session;
          return {
            ...session,
            ...(session.agentSessionId ? {} : existing.agentSessionId ? { agentSessionId: existing.agentSessionId } : {}),
            isActive: existing.isActive,
            isProcessing: existing.isProcessing,
            hasPendingPermission: existing.hasPendingPermission,
            hasUnreadCompletion: existing.hasUnreadCompletion,
            titleGenerating: existing.titleGenerating,
          };
        });
      });
    }).catch(() => { /* IPC failure — leave sessions empty */ });
    return () => { cancelled = true; };
  }, [projects]);

  // Hydrate Claude model cache at app startup and refresh it in the background.
  useEffect(() => {
    let cancelled = false;

    const firstProject = refs.projectsRef.current[0];
    const preferredCwd = firstProject ? getProjectCwd(firstProject) : undefined;

    window.claude.modelsCacheGet().then((result) => {
      if (cancelled) return;
      if (result.models?.length) {
        setCachedModels(result.models);
      }
    }).catch(() => { /* cache read is optional */ });

    // Defer revalidation (spawns a Claude SDK subprocess) to avoid competing with
    // the startup IPC burst. The cached models from modelsCacheGet() above are
    // sufficient for the initial render.
    const revalidateTimer = setTimeout(() => {
      window.claude.modelsCacheRevalidate(preferredCwd ? { cwd: preferredCwd } : undefined).then((result) => {
        if (cancelled) return;
        if (result.models?.length) {
          setCachedModels(result.models);
          return;
        }
        if (result.error) {
          toast.error("Failed to load Claude models", { description: result.error });
        }
      }).catch(() => { /* keep stale cache if revalidation fails */ });
    }, 3000);

    return () => {
      cancelled = true;
      clearTimeout(revalidateTimer);
    };
  }, [getProjectCwd]);

  // Ensure Codex model metadata is available even before first turn.
  useEffect(() => {
    if (activeEngine !== "codex") return;
    if (codex.codexModels.length > 0) return;
    const preferredModel = activeSessionId === DRAFT_ID
      ? startOptionsRef.current.model
      : sessionsRef.current.find((s) => s.id === activeSessionId)?.model;
    prefetchCodexModels(preferredModel);
  }, [
    activeEngine,
    activeSessionId,
    // Must re-run when sessions list changes (startOptions.model could resolve to session model)
    projects,
    startOptionsRef.current.model,
    codex.codexModels.length,
    prefetchCodexModels,
  ]);

  // Idle-time prefetch of recent session payloads.
  useEffect(() => {
    const candidates = sessionsRef.current
      .filter((session) => session.id !== activeSessionIdRef.current)
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
      .slice(0, MAX_SESSION_PAYLOAD_CACHE);

    if (candidates.length === 0) return;

    let cancelled = false;
    let idleId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      for (const session of candidates) {
        if (cancelled) return;
        if (sessionPayloadCacheRef.current.has(session.id)) continue;
        if (inFlightPrefetchRef.current.has(session.id)) continue;
        if (backgroundStoreRef.current.has(session.id)) continue;

        inFlightPrefetchRef.current.add(session.id);
        try {
          const data = await window.claude.sessions.load(session.projectId, session.id);
          if (!cancelled && data) {
            cacheSessionPayload(data);
          }
        } finally {
          inFlightPrefetchRef.current.delete(session.id);
        }
        // Yield between sequential loads to let the main process event loop breathe
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(() => {
        void run();
      }, { timeout: 5000 });
    } else {
      timerId = setTimeout(() => {
        void run();
      }, 3000);
    }

    return () => {
      cancelled = true;
      if (idleId !== null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [activeSessionId, cacheSessionPayload, projects]);

  return {
    cacheSessionPayload,
    consumeCachedSessionPayload,
    applyLoadedSession,
    evictFromCache,
  };
}
