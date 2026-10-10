import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundSessionStore } from "@/lib/background/session-store";
import type { WorkspaceBinding } from "@shared/types/workspace";
import type { PersistedSession } from "@/types";
import { conversationKey } from "@shared/lib/session-identity";
import type { HistoryLocation } from "@shared/types/productivity";
import { useSessionCrud } from "./useSessionCrud";

vi.mock("@/lib/analytics/analytics", () => ({ capture: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@/lib/notification-utils", () => ({ suppressNextSessionCompletion: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  type Params = Parameters<typeof useSessionCrud>[0];
  const project = { id: "project", name: "Project", path: "/project", createdAt: 1 };
  const binding: WorkspaceBinding = { projectId: project.id, rootKind: "worktree", rootPath: "/worktree-a",
    repoCommonDir: "/project/.git", relativeCwd: "apps/web" };
  const refs: Params["refs"] = {
    activeSessionIdRef: { current: "previous-session" }, sessionsRef: { current: [] }, projectsRef: { current: [project] },
    draftProjectIdRef: { current: null }, startOptionsRef: { current: { conversationId: "previous-conversation", engine: "codex" } },
    messagesRef: { current: [] }, totalCostRef: { current: 0 }, contextUsageRef: { current: null },
    isProcessingRef: { current: false }, isCompactingRef: { current: false }, isConnectedRef: { current: true },
    sessionInfoRef: { current: null }, pendingPermissionRef: { current: null }, liveSessionIdsRef: { current: new Set(["previous-session"]) },
    backgroundStoreRef: { current: new BackgroundSessionStore() }, preStartedSessionIdRef: { current: null },
    draftAcpSessionIdRef: { current: null }, draftMcpStatusesRef: { current: [] }, materializingRef: { current: false },
    saveTimerRef: { current: null }, messageQueueRef: { current: new Map() }, pendingAcpDraftPromptRef: { current: null },
    acpAgentIdRef: { current: null }, acpAgentSessionIdRef: { current: null }, codexRawModelsRef: { current: [] },
    codexEffortRef: { current: "medium" }, codexEffortManualOverrideRef: { current: false }, lastMessageSyncSessionRef: { current: null },
    switchSessionRef: { current: undefined }, onSpaceChangeRef: { current: undefined }, acpPermissionBehaviorRef: { current: "ask" },
    currentBranchRef: { current: "main" }, visibleSplitSessionIdsRef: { current: [] },
  };
  const setters: Params["setters"] = {
    setSessions: vi.fn(), setActiveSessionId: vi.fn(), setInitialMessages: vi.fn(), setInitialMeta: vi.fn(),
    setInitialConfigOptions: vi.fn(), setInitialSlashCommands: vi.fn(), setInitialPermission: vi.fn(), setInitialRawAcpPermission: vi.fn(),
    setStartOptions: vi.fn(), setDraftProjectId: vi.fn(), setPreStartedSessionId: vi.fn(), setDraftAcpSessionId: vi.fn(),
    setAcpConfigOptionsLoading: vi.fn(), setDraftMcpStatuses: vi.fn(), setAcpMcpStatuses: vi.fn(), setQueuedCount: vi.fn(),
    setCachedModels: vi.fn(), setCodexRawModels: vi.fn(), setCodexModelsLoadingMessage: vi.fn(),
  };
  const params: Params = { refs, setters, engines: { acp: { setMessages: vi.fn(), setIsProcessing: vi.fn() } },
    findProject: () => project, getProjectCwd: () => "/worktree-b", saveCurrentSession: vi.fn(async () => {}), seedBackgroundStore: vi.fn(),
    eagerStartSession: vi.fn(async () => {}), eagerStartAcpSession: vi.fn(async () => {}), prefetchCodexModels: vi.fn(async () => {}),
    probeMcpServers: vi.fn(async () => {}), abandonEagerSession: vi.fn(), abandonDraftAcpSession: vi.fn(),
    cacheSessionPayload: vi.fn(), consumeCachedSessionPayload: vi.fn(() => null), applyLoadedSession: vi.fn(), evictFromCache: vi.fn(), clearQueue: vi.fn() };
  let finishValidation!: (result: Awaited<ReturnType<Window["claude"]["projectApps"]["validateWorkspace"]>>) => void;
  const validation = new Promise<Awaited<ReturnType<Window["claude"]["projectApps"]["validateWorkspace"]>>>((resolve) => { finishValidation = resolve; });
  const validateWorkspace = vi.fn(() => validation);
  vi.stubGlobal("window", { claude: { projectApps: { validateWorkspace } } });
  let crud: ReturnType<typeof useSessionCrud> | undefined;
  function Harness() { crud = useSessionCrud(params); return null; }
  renderToString(createElement(Harness));
  if (!crud) throw new Error("Session hook did not render");
  return { create: crud.createSession, switchSession: crud.switchSession, params, refs, setters, binding, validateWorkspace,
    finishValidation: () => finishValidation({ ok: true, value: { workspace: binding, cwd: "/worktree-a/apps/web" } }) };
}

describe("programmatic draft activation guard", () => {
  it("preserves the previous conversation if text is entered while workspace validation is pending", async () => {
    const f = fixture();
    let composerText = "";
    const guard = vi.fn(() => { if (composerText) throw new Error("Unsent text must be preserved"); });
    const pending = f.create("project", { engine: "codex", workspaceBinding: f.binding }, { beforeActivate: guard });
    expect(f.validateWorkspace).toHaveBeenCalledOnce();
    expect(guard).not.toHaveBeenCalled();
    composerText = "New input typed during validation";
    f.finishValidation();
    await expect(pending).rejects.toThrow("Unsent text must be preserved");
    expect(guard).toHaveBeenCalledOnce();
    expect(f.refs.activeSessionIdRef.current).toBe("previous-session");
    expect(f.refs.startOptionsRef.current.conversationId).toBe("previous-conversation");
    expect(composerText).toBe("New input typed during validation");
    expect(f.params.abandonEagerSession).not.toHaveBeenCalled();
    expect(f.params.abandonDraftAcpSession).not.toHaveBeenCalled();
    expect(f.params.saveCurrentSession).not.toHaveBeenCalled();
    for (const setter of Object.values(f.setters)) expect(setter).not.toHaveBeenCalled();
  });

  it("activates after a successful guard without storing the callback in start options", async () => {
    const f = fixture(); const guard = vi.fn();
    const pending = f.create("project", { engine: "codex", workspaceBinding: f.binding,
      conversationId: "app-conversation" }, { beforeActivate: guard });
    f.finishValidation(); await pending;
    expect(guard).toHaveBeenCalledOnce();
    expect(f.refs.activeSessionIdRef.current).toBe("__draft__");
    expect(f.refs.startOptionsRef.current).toEqual({ engine: "codex", workspaceBinding: f.binding, conversationId: "app-conversation" });
    expect(f.params.abandonEagerSession).toHaveBeenCalledOnce();
  });

  it("rechecks before any session mutation after the history payload finishes loading", async () => {
    const f = fixture();
    const data: PersistedSession = { id: "app-runtime", conversationId: "app-conversation", projectId: "project",
      title: "App conversation", createdAt: 1, totalCost: 0, messages: [] };
    const location: HistoryLocation = { projectId: data.projectId, conversationKey: conversationKey(data),
      runtimeSessionId: data.id, messageId: null, spaceId: null };
    let finishLoad!: (value: PersistedSession) => void;
    const loaded = new Promise<PersistedSession>((resolve) => { finishLoad = resolve; });
    vi.stubGlobal("window", { claude: { sessions: { load: vi.fn(() => loaded), list: vi.fn(async () => [data]) } } });
    let composerText = "";
    const guard = vi.fn(() => { if (composerText) throw new Error("Unsent text must be preserved"); });
    const pending = f.switchSession(data.id, location, { beforeActivate: guard });
    expect(guard).not.toHaveBeenCalled();
    composerText = "Text typed while loading"; finishLoad(data);
    await expect(pending).rejects.toThrow("Unsent text must be preserved");
    expect(guard).toHaveBeenCalledOnce();
    expect(f.refs.activeSessionIdRef.current).toBe("previous-session");
    expect(f.refs.sessionsRef.current).toEqual([]);
    expect(f.params.abandonEagerSession).not.toHaveBeenCalled();
    expect(f.params.abandonDraftAcpSession).not.toHaveBeenCalled();
    expect(f.params.cacheSessionPayload).not.toHaveBeenCalled();
    expect(f.params.applyLoadedSession).not.toHaveBeenCalled();
    for (const setter of Object.values(f.setters)) expect(setter).not.toHaveBeenCalled();
  });
});
