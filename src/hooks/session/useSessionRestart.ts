import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { ChatSession, McpServerConfig, Project } from "../../types";
import { toMcpStatusState } from "../../lib/mcp-utils";
import { suppressNextSessionCompletion } from "../../lib/notification-utils";
import { createSystemMessage } from "../../lib/message-factory";
import { buildPersistedSession } from "../../lib/session/records";
import { persistSessionReplacement } from "../../lib/session/persistence";
import { beginSessionRecovery, isSessionFrozen } from "../../lib/session/batch-runtime";
import { useI18n } from "@/lib/i18n";
import { DRAFT_ID, getEffectiveClaudePermissionMode, getCodexApprovalPolicy, getCodexSandboxMode } from "./types";
import type { SharedSessionRefs, SharedSessionSetters, EngineHooks, InitialMeta } from "./types";
import { resolveSessionCwd } from "./workspace-binding";

interface UseSessionRestartParams {
  refs: Pick<SharedSessionRefs, "activeSessionIdRef" | "sessionsRef" | "messagesRef" | "totalCostRef" | "contextUsageRef" | "isProcessingRef" | "liveSessionIdsRef" | "backgroundStoreRef" | "messageQueueRef" | "startOptionsRef" | "acpAgentIdRef" | "acpAgentSessionIdRef">;
  setters: Pick<SharedSessionSetters, "setSessions" | "setActiveSessionId" | "setInitialMessages" | "setInitialMeta" | "setInitialConfigOptions" | "setAcpMcpStatuses">;
  engines: { claude: Pick<EngineHooks["claude"], "flushNow" | "resetStreaming" | "refreshMcpStatus"> };
  findProject: (projectId: string) => Project | null;
  getProjectCwd: (project: Project) => string;
}
type RestartRequest = { kind: "acp"; servers: McpServerConfig[]; cwd?: string } | { kind: "worktree" } | { kind: "revert"; checkpointId: string };

export function useSessionRestart({ refs, setters, engines, findProject, getProjectCwd }: UseSessionRestartParams) {
  const { t } = useI18n();
  const view = useRef({ id: refs.activeSessionIdRef.current, epoch: 0, mounted: true });
  if (view.current.id !== refs.activeSessionIdRef.current) view.current = { ...view.current, id: refs.activeSessionIdRef.current, epoch: view.current.epoch + 1 };
  useEffect(() => { view.current.mounted = true; return () => { view.current.mounted = false; view.current.epoch++; }; }, []);

  const restart = useCallback(async (request: RestartRequest): Promise<{ ok?: boolean; error?: string }> => {
    const oldId = refs.activeSessionIdRef.current;
    if (!oldId || oldId === DRAFT_ID) return { ok: true };
    const session = refs.sessionsRef.current.find((s) => s.id === oldId);
    const project = session && findProject(session.projectId);
    if (!session || !project) return { error: t("sessionRecoveryCancelled") };
    const engineId = session.engine ?? "claude";
    if ((request.kind === "acp" && engineId !== "acp") || (request.kind === "revert" && engineId !== "claude")) return { error: t("sessionRecoveryCancelled") };
    if (refs.isProcessingRef.current) return { error: t("sessionRestartWait") };
    const release = beginSessionRecovery(oldId);
    if (!release) return { error: t("sessionRecoveryBusy") };
    const epoch = view.current.epoch;
    const valid = () => view.current.mounted && view.current.epoch === epoch && refs.activeSessionIdRef.current === oldId && !isSessionFrozen(oldId)
      && refs.sessionsRef.current.some((s) => s.id === oldId && s.projectId === session.projectId);
    const check = () => { if (!valid()) throw new Error(t("sessionRecoveryCancelled")); };
    const options = { ...refs.startOptionsRef.current };
    const cost = refs.totalCostRef.current;
    const usage = refs.contextUsageRef.current;
    let ownedId: string | undefined;
    let adopted = false;
    const stop = async (id: string) => {
      suppressNextSessionCompletion(id);
      if (engineId === "codex") await window.claude.codex.stop(id);
      else {
        const result = engineId === "acp" ? await window.claude.acp.stop(id) : await window.claude.stop(id, "session_restart");
        if ("error" in result && result.error) throw new Error(String(result.error));
      }
      refs.liveSessionIdsRef.current.delete(id);
    };

    try {
      if (request.kind === "revert") { engines.claude.flushNow(); engines.claude.resetStreaming(); }
      const snapshot = refs.messagesRef.current;
      await persistSessionReplacement(oldId, buildPersistedSession(session, snapshot.filter((m) => !m.isQueued), cost, usage));
      check();
      const cwd = await resolveSessionCwd(project, session.workspaceBinding,
        (target) => request.kind === "acp" && request.cwd ? request.cwd : getProjectCwd(target));
      check();
      const servers = request.kind === "acp" ? request.servers : await window.claude.mcp.list(session.projectId);
      check();
      let next: ChatSession = session;
      let messages = snapshot;
      let config: Parameters<typeof setters.setInitialConfigOptions>[0] = [];
      let meta: InitialMeta = { isProcessing: false, isConnected: true, sessionInfo: null, totalCost: cost, contextUsage: usage };
      if (engineId === "acp") {
        if (!session.agentId) throw new Error(t("sessionRecoveryNoAgent"));
        const reloaded = await window.claude.acp.reloadSession(oldId, servers, cwd); check();
        if (reloaded.error) throw new Error(reloaded.error);
        if (reloaded.supportsLoad) {
          if (reloaded.ok) setters.setAcpMcpStatuses((reloaded.mcpStatuses ?? servers.map(server => ({ name: server.name, status: "unknown" }))).map(status => ({ name: status.name, status: toMcpStatusState(status.status) })));
          return reloaded.ok ? { ok: true } : { error: t("sessionRecoveryFailed") };
        }
        await stop(oldId); check();
        const result = session.agentSessionId
          ? await window.claude.acp.reviveSession({ agentId: session.agentId, agentSessionId: session.agentSessionId, cwd, mcpServers: servers,
              memoryContext: { projectId: session.projectId }, source: { projectId: session.projectId, runtimeSessionId: oldId } })
          : await window.claude.acp.start({ agentId: session.agentId, cwd, mcpServers: servers,
              memoryContext: { projectId: session.projectId }, source: { projectId: session.projectId, runtimeSessionId: oldId } });
        if ("sessionId" in result) ownedId = result.sessionId;
        if ("error" in result && result.error) throw new Error(result.error);
        if (!ownedId || ("authRequired" in result && result.authRequired)) throw new Error(t("sessionRecoveryFailed"));
        check();
        setters.setAcpMcpStatuses("mcpStatuses" in result ? (result.mcpStatuses ?? []).map(status => ({ name: status.name, status: toMcpStatusState(status.status) })) : []);
        next = { ...session, id: ownedId, conversationId: session.conversationId ?? oldId,
          agentSessionId: "agentSessionId" in result ? result.agentSessionId ?? session.agentSessionId : session.agentSessionId };
        config = "configOptions" in result ? result.configOptions ?? [] : [];
      } else if (engineId === "codex") {
        let threadId = session.codexThreadId;
        if (!threadId) { const saved = await window.claude.sessions.load(session.projectId, oldId); check(); threadId = saved?.codexThreadId; }
        if (!threadId) throw new Error(t("sessionRecoveryNoThread"));
        const result = await window.claude.codex.resume({ cwd, threadId, model: session.model,
          approvalPolicy: getCodexApprovalPolicy(options), sandbox: getCodexSandboxMode(options),
          memoryContext: { projectId: session.projectId }, source: { projectId: session.projectId, runtimeSessionId: oldId } });
        ownedId = result.sessionId;
        if (result.error || !ownedId) throw new Error(result.error || t("sessionRecoveryFailed"));
        check();
        const goal = result.goalSupported === true ? result.goal ?? null : result.goalSupported === false ? null : session.codexGoal ?? null;
        next = { ...session, id: ownedId, conversationId: session.conversationId ?? oldId, codexThreadId: result.threadId ?? threadId, codexGoal: goal };
        meta = { ...meta, codexGoal: goal, codexGoalSupported: result.goalSupported ?? null };
        await stop(oldId); check();
      } else if (request.kind === "revert") {
        const checkpoint = snapshot.findIndex((m) => m.role === "user" && m.checkpointId === request.checkpointId);
        if (checkpoint < 0) throw new Error(t("sessionRestartNoCheckpoint"));
        const reverted = await window.claude.revertFiles(oldId, request.checkpointId); check();
        if (reverted.error) throw new Error(reverted.error);
        await stop(oldId); check();
        const result = await window.claude.start({ cwd, model: session.model, permissionMode: getEffectiveClaudePermissionMode(options),
          thinkingEnabled: options.thinkingEnabled, effort: options.effort, resume: oldId, forkSession: true, resumeSessionAt: request.checkpointId,
          mcpServers: servers, memoryContext: { projectId: session.projectId }, source: { projectId: session.projectId, runtimeSessionId: oldId } });
        if (result.error) throw new Error(result.error);
        ownedId = result.sessionId; check();
        next = { ...session, id: ownedId, conversationId: session.conversationId ?? oldId };
        messages = [...snapshot.slice(0, checkpoint), createSystemMessage(t("sessionRestartReverted"))];
      } else {
        const result = await window.claude.restartSession(oldId, servers, cwd, undefined, undefined, { projectId: session.projectId });
        if (result.error) throw new Error(result.error);
        ownedId = oldId; check();
        await engines.claude.refreshMcpStatus(valid); check();
        adopted = true;
        return { ok: true };
      }

      await persistSessionReplacement(oldId, buildPersistedSession(next, messages.filter((m) => !m.isQueued), cost, usage));
      const mayContinue = valid();
      const remap = (sessions: ChatSession[]) => sessions.map((s) => s.id === oldId && s.projectId === session.projectId
        ? { ...s, id: next.id, conversationId: next.conversationId, agentSessionId: next.agentSessionId, codexThreadId: next.codexThreadId, codexGoal: next.codexGoal } : s);
      refs.sessionsRef.current = remap(refs.sessionsRef.current);
      if (view.current.mounted) setters.setSessions(remap);
      const background = refs.backgroundStoreRef.current.get(oldId);
      const queued = refs.messageQueueRef.current.get(oldId);
      if (queued) { refs.messageQueueRef.current.set(next.id, queued); if (next.id !== oldId) refs.messageQueueRef.current.delete(oldId); }
      if (background && next.id !== oldId) {
        refs.backgroundStoreRef.current.delete(oldId);
        refs.backgroundStoreRef.current.initFromState(next.id, { ...background, isProcessing: false, isConnected: mayContinue,
          messages: request.kind === "revert" ? [...messages, ...background.messages.filter((m) => m.isQueued)] : background.messages });
      }
      if (view.current.mounted && refs.activeSessionIdRef.current === oldId && !isSessionFrozen(next.id)) {
        const currentQueued = refs.messagesRef.current.filter((m) => m.isQueued);
        view.current.id = next.id;
        refs.activeSessionIdRef.current = next.id;
        setters.setInitialMessages(request.kind === "revert" ? [...messages, ...currentQueued] : refs.messagesRef.current);
        setters.setInitialMeta({ ...meta, isConnected: mayContinue });
        setters.setInitialConfigOptions(config);
        setters.setActiveSessionId(next.id);
      }
      if (!mayContinue) throw new Error(t("sessionRecoveryCancelled"));
      refs.liveSessionIdsRef.current.add(next.id);
      if (engineId === "acp") {
        refs.acpAgentIdRef.current = next.agentId ?? null;
        refs.acpAgentSessionIdRef.current = next.agentSessionId ?? null;
      }
      adopted = true;
      return { ok: true };
    } catch (error) {
      if (ownedId && !adopted) {
        try { await stop(ownedId); }
        catch (stopError) { if (view.current.mounted) toast.error(String(stopError)); }
      }
      return { error: error instanceof Error ? error.message : String(error) };
    } finally { release(); }
  }, [engines, findProject, getProjectCwd, refs, setters, t]);

  return {
    restartAcpSession: useCallback((servers: McpServerConfig[], cwd?: string) => restart({ kind: "acp", servers, cwd }), [restart]),
    restartActiveSessionInCurrentWorktree: useCallback(() => restart({ kind: "worktree" }), [restart]),
    fullRevertSession: useCallback(async (checkpointId: string) => {
      const result = await restart({ kind: "revert", checkpointId });
      if (result.error && view.current.mounted) toast.error(result.error);
    }, [restart]),
  };
}
