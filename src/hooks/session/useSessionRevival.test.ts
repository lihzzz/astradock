import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatSession, EngineId, ImageAttachment, UIMessage } from "@/types";
import { BackgroundSessionStore } from "@/lib/background/session-store";
import { freezeSession, isSessionFrozen, isSessionRecovering, releaseSession } from "@/lib/session/batch-runtime";
import { useSessionRevival } from "./useSessionRevival";
import { useSessionRestart } from "./useSessionRestart";

vi.mock("@/lib/analytics/analytics", () => ({ capture: vi.fn(), reportError: (_label: string, error: unknown) => String(error) }));
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/notification-utils", () => ({ suppressNextSessionCompletion: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Params = Parameters<typeof useSessionRevival>[0];

function fixture(engineId: EngineId) {
  const id = crypto.randomUUID(); const newId = crypto.randomUUID(); const otherId = crypto.randomUUID();
  const source: ChatSession = { id, projectId: "project", title: "Source", createdAt: 1, totalCost: 3, engine: engineId, agentId: "agent", agentSessionId: "agent-thread", codexThreadId: "thread", isActive: true };
  const original: UIMessage = { id: "original", role: "user", content: "Original history", timestamp: 1 };
  const otherMessage: UIMessage = { id: "other-message", role: "user", content: "Other conversation", timestamp: 2 };
  const refs: Params["refs"] = {
    activeSessionIdRef: { current: id }, sessionsRef: { current: [source, { ...source, id: otherId, title: "Other", isActive: false }] },
    messagesRef: { current: [original] }, totalCostRef: { current: 3 }, contextUsageRef: { current: null }, isProcessingRef: { current: false },
    liveSessionIdsRef: { current: new Set() }, backgroundStoreRef: { current: new BackgroundSessionStore() }, messageQueueRef: { current: new Map() },
    startOptionsRef: { current: {} }, codexEffortRef: { current: "medium" }, acpAgentIdRef: { current: "agent" }, acpAgentSessionIdRef: { current: "agent-thread" },
  };
  let holdReady = false;
  const ready = new Set<string>([id]);
  const engine = {
    setMessages: vi.fn<Params["engines"]["claude"]["setMessages"]>((value) => { refs.messagesRef.current = typeof value === "function" ? value(refs.messagesRef.current) : value; }),
    setIsProcessing: vi.fn<Params["engines"]["claude"]["setIsProcessing"]>((value) => { refs.isProcessingRef.current = typeof value === "function" ? value(refs.isProcessingRef.current) : value; }),
    isReadyForSession: vi.fn((sessionId: string) => ready.has(sessionId)),
    flushNow: vi.fn(), resetStreaming: vi.fn(), refreshMcpStatus: vi.fn<Parameters<typeof useSessionRestart>[0]["engines"]["claude"]["refreshMcpStatus"]>(async () => {}),
  };
  const setters: Params["setters"] = {
    setSessions: vi.fn((value) => { refs.sessionsRef.current = typeof value === "function" ? value(refs.sessionsRef.current) : value; }),
    setActiveSessionId: vi.fn((value) => {
      const next = typeof value === "function" ? value(refs.activeSessionIdRef.current) : value;
      refs.activeSessionIdRef.current = next; if (next && !holdReady) ready.add(next);
    }),
    setInitialMessages: vi.fn((value) => { refs.messagesRef.current = typeof value === "function" ? value(refs.messagesRef.current) : value; }),
    setInitialMeta: vi.fn(), setInitialConfigOptions: vi.fn(), setAcpMcpStatuses: vi.fn(), setQueuedCount: vi.fn(),
  };
  const api = {
    projectApps: { validateWorkspace: vi.fn<Window["claude"]["projectApps"]["validateWorkspace"]>()
      .mockImplementation(async (workspace) => ({ ok: true, value: { workspace, cwd: "/worktree-a/apps/web" } })) },
    start: vi.fn<Window["claude"]["start"]>().mockResolvedValue({ sessionId: newId, pid: 0 }),
    send: vi.fn<Window["claude"]["send"]>().mockResolvedValue({ ok: true }),
    stop: vi.fn<Window["claude"]["stop"]>().mockResolvedValue({ ok: true }),
    restartSession: vi.fn<Window["claude"]["restartSession"]>().mockResolvedValue({ ok: true, restarted: true }),
    revertFiles: vi.fn<Window["claude"]["revertFiles"]>().mockResolvedValue({}),
    mcp: { list: vi.fn(async () => []), probe: vi.fn(async () => []) },
    sessions: {
      save: vi.fn<Window["claude"]["sessions"]["save"]>().mockResolvedValue({}),
      append: vi.fn<Window["claude"]["sessions"]["append"]>().mockResolvedValue({}),
      load: vi.fn<Window["claude"]["sessions"]["load"]>().mockResolvedValue(null),
    },
    codex: {
      resume: vi.fn<Window["claude"]["codex"]["resume"]>().mockResolvedValue({ sessionId: newId, threadId: "thread" }),
      send: vi.fn<Window["claude"]["codex"]["send"]>().mockResolvedValue({}),
      stop: vi.fn<Window["claude"]["codex"]["stop"]>().mockResolvedValue(undefined),
    },
    acp: {
      reviveSession: vi.fn<Window["claude"]["acp"]["reviveSession"]>().mockResolvedValue({ sessionId: newId, agentSessionId: "agent-thread" }),
      start: vi.fn<Window["claude"]["acp"]["start"]>().mockResolvedValue({ sessionId: newId, agentSessionId: "agent-thread" }),
      reloadSession: vi.fn<Window["claude"]["acp"]["reloadSession"]>().mockResolvedValue({ supportsLoad: false }),
      prompt: vi.fn<Window["claude"]["acp"]["prompt"]>().mockResolvedValue({ ok: true }),
      stop: vi.fn<Window["claude"]["acp"]["stop"]>().mockResolvedValue({ ok: true }),
    },
  };
  vi.stubGlobal("window", { claude: api });
  const params = { refs, setters, engines: { claude: engine, codex: engine, acp: engine },
    findProject: () => ({ id: "project", name: "Project", path: "/project", createdAt: 1 }), getProjectCwd: () => "/project" };
  let hooks: ReturnType<typeof useSessionRevival> | undefined;
  let restart: ReturnType<typeof useSessionRestart> | undefined;
  function Harness() { hooks = useSessionRevival(params); restart = useSessionRestart(params); return null; }
  renderToString(createElement(Harness));
  if (!hooks || !restart) throw new Error("Hooks did not render");
  const revive = engineId === "claude" ? hooks.reviveSession : engineId === "codex" ? hooks.reviveCodexSession : hooks.reviveAcpSession;
  const send = engineId === "claude" ? api.send : engineId === "codex" ? api.codex.send : api.acp.prompt;
  const stop = engineId === "claude" ? api.stop : engineId === "codex" ? api.codex.stop : api.acp.stop;
  const starting = engineId === "claude" ? api.start : engineId === "codex" ? api.codex.resume : api.acp.reviveSession;
  function delayStart() {
    const result = deferred<{ sessionId: string; pid: number; threadId: string; agentSessionId: string }>();
    api.start.mockReturnValue(result.promise); api.codex.resume.mockReturnValue(result.promise); api.acp.reviveSession.mockReturnValue(result.promise);
    return () => result.resolve({ sessionId: newId, pid: 0, threadId: "thread", agentSessionId: "agent-thread" });
  }
  function navigate() {
    const activeId = refs.activeSessionIdRef.current;
    if (activeId) refs.backgroundStoreRef.current.initFromState(activeId, {
      messages: refs.messagesRef.current, isProcessing: refs.isProcessingRef.current, isConnected: false, isCompacting: false,
      sessionInfo: null, totalCost: 3, contextUsage: null, pendingPermission: null, rawAcpPermission: null, slashCommands: [],
    });
    refs.activeSessionIdRef.current = otherId; refs.messagesRef.current = [otherMessage]; refs.totalCostRef.current = 999;
  }
  return { id, newId, otherId, refs, setters, engine, api, revive, reviveQueuedMessage: hooks.reviveQueuedMessage, restart, send, stop, starting, delayStart, navigate, original, otherMessage, ready,
    holdReady: () => { holdReady = true; } };
}

describe.each(["claude", "codex", "acp"] as const)("%s renderer restoration ownership", (engineId) => {
  it("restores in the bound worktree and preserves application identity when the runtime changes", async () => {
    const f = fixture(engineId);
    const source = f.refs.sessionsRef.current[0];
    source.conversationId = "logical-app-conversation";
    source.workspaceBinding = { projectId: "project", rootKind: "worktree", rootPath: "/worktree-a",
      repoCommonDir: "/project/.git", relativeCwd: "apps/web" };
    source.origin = { kind: "project-app", appId: "web", runId: "run" };
    await f.revive("Continue editing");
    expect(f.starting).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/worktree-a/apps/web" }));
    expect(f.api.sessions.save.mock.calls[0][0]).toMatchObject({ conversationId: "logical-app-conversation",
      workspaceBinding: source.workspaceBinding, origin: source.origin });
    expect(f.refs.sessionsRef.current.find((session) => session.id === f.newId)?.workspaceBinding).toEqual(source.workspaceBinding);
  });

  it("keeps the prompt queued without starting an engine when the bound directory is gone", async () => {
    const f = fixture(engineId);
    f.refs.sessionsRef.current[0].workspaceBinding = { projectId: "project", rootKind: "worktree", rootPath: "/gone",
      repoCommonDir: "/project/.git", relativeCwd: "." };
    f.api.projectApps.validateWorkspace.mockResolvedValue({ ok: false, error: { code: "TARGET_GONE", message: "Worktree is unavailable", retryable: false } });
    await f.revive("Do not lose this input");
    expect(f.starting).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.refs.messageQueueRef.current.get(f.id)?.[0].text).toBe("Do not lose this input");
    expect(f.refs.messagesRef.current.at(-1)).toMatchObject({ content: "Worktree is unavailable", isError: true });
  });
  it("saves the original snapshot before switching, then waits for the new view before one send", async () => {
    const f = fixture(engineId); f.holdReady();
    const pending = f.revive("Unsent input");
    await vi.waitFor(() => expect(f.refs.activeSessionIdRef.current).toBe(f.newId));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.api.sessions.save.mock.calls[0][0]).toMatchObject({ messages: [f.original], totalCost: 3 });
    f.ready.add(f.newId); await pending;
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.refs.messagesRef.current.filter((m) => m.content === "Unsent input")).toEqual([expect.objectContaining({ isQueued: false })]);
    expect(f.refs.messageQueueRef.current.has(f.newId)).toBe(false);
    expect(isSessionRecovering(f.newId)).toBe(false);
  });

  it("stops a late runtime without saving, switching or sending after deletion", async () => {
    const f = fixture(engineId); const complete = f.delayStart();
    const pending = f.revive("Unsent input");
    await vi.waitFor(() => expect(f.starting).toHaveBeenCalledOnce());
    freezeSession(f.id, "deletion"); releaseSession(f.id, "deletion", true);
    f.refs.activeSessionIdRef.current = null; f.refs.sessionsRef.current = [];
    complete(); await pending;
    expect(f.stop).toHaveBeenCalledWith(f.newId, ...(engineId === "claude" ? ["revival_cancelled"] : []));
    expect(f.api.sessions.save).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(f.setters.setActiveSessionId).not.toHaveBeenCalled();
  });

  it("keeps unsent text and images in the original queue when navigation supersedes startup", async () => {
    const f = fixture(engineId); const complete = f.delayStart();
    const images: ImageAttachment[] = [{ id: "image", data: "abc", mediaType: "image/png" }];
    const pending = f.revive("Unsent input", images);
    await vi.waitFor(() => expect(f.starting).toHaveBeenCalledOnce()); f.navigate(); complete(); await pending;
    expect(f.refs.messagesRef.current).toEqual([f.otherMessage]); expect(f.send).not.toHaveBeenCalled();
    expect(f.refs.messageQueueRef.current.get(f.id)).toEqual([expect.objectContaining({ text: "Unsent input", images })]);
    expect(f.refs.backgroundStoreRef.current.get(f.id)?.isProcessing).toBe(false);
  });

  it("preserves the original identity and unsent queue when persistence fails", async () => {
    const f = fixture(engineId); f.api.sessions.save.mockResolvedValue({ error: "disk full" });
    await f.revive("Unsent input");
    expect(f.refs.activeSessionIdRef.current).toBe(f.id); expect(f.send).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalled(); expect(f.refs.messageQueueRef.current.get(f.id)?.[0].text).toBe("Unsent input");
    expect(f.refs.messagesRef.current.at(-1)).toMatchObject({ role: "system", content: "disk full" });
  });

  it("retries a retained prompt once with the same message and attachments", async () => {
    const f = fixture(engineId);
    const images: ImageAttachment[] = [{ id: "image", data: "abc", mediaType: "image/png" }];
    f.api.sessions.save.mockResolvedValueOnce({ error: "disk full" });
    await f.revive("Retained input", images, "Display text");
    const messageId = f.refs.messageQueueRef.current.get(f.id)![0].messageId;
    const complete = f.delayStart();
    const retry = f.reviveQueuedMessage(messageId);
    await f.reviveQueuedMessage(messageId);
    complete(); await retry;
    expect(f.starting).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.refs.messagesRef.current.filter((m) => m.content === "Retained input")).toEqual([
      expect.objectContaining({ id: messageId, images, displayContent: "Display text", isQueued: false }),
    ]);
    expect(f.refs.messageQueueRef.current.has(f.newId)).toBe(false);
    if (engineId === "acp") expect(f.api.acp.prompt).toHaveBeenCalledWith(f.newId, "Retained input", images);
    else if (engineId === "codex") expect(f.api.codex.send.mock.calls[0][2]).toEqual([{ type: "image", url: "data:image/png;base64,abc" }]);
    else expect(f.api.send.mock.calls[0][1]).toMatchObject({ message: { content: expect.arrayContaining([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]) } });
  });

  it("does not resurrect a queued message removed before retry or during startup", async () => {
    const f = fixture(engineId); f.api.sessions.save.mockResolvedValueOnce({ error: "disk full" });
    await f.revive("Retained input");
    const messageId = f.refs.messageQueueRef.current.get(f.id)![0].messageId;
    await f.reviveQueuedMessage("removed-message");
    expect(f.starting).toHaveBeenCalledOnce();
    const complete = f.delayStart(); const retry = f.reviveQueuedMessage(messageId);
    await vi.waitFor(() => expect(f.starting).toHaveBeenCalledTimes(2));
    f.refs.messageQueueRef.current.delete(f.id);
    f.refs.messagesRef.current = f.refs.messagesRef.current.filter((m) => m.id !== messageId);
    complete(); await retry;
    expect(f.send).not.toHaveBeenCalled(); expect(f.refs.messageQueueRef.current.has(f.newId)).toBe(false);
    expect(f.refs.messagesRef.current.some((m) => m.id === messageId)).toBe(false);
  });

  it("releases recovery ownership once the prompt is dispatched, even while its turn is running", async () => {
    const f = fixture(engineId); const response = deferred<{ ok: true; turnId: string }>();
    f.api.send.mockReturnValue(response.promise); f.api.acp.prompt.mockReturnValue(response.promise); f.api.codex.send.mockReturnValue(response.promise);
    const pending = f.revive("Input");
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(isSessionRecovering(f.newId)).toBe(false);
    expect(f.refs.liveSessionIdsRef.current.has(f.newId)).toBe(true);
    response.resolve({ ok: true, turnId: "fixture-turn" }); await pending;
  });

  it("stops a failed first send and keeps later queued prompts for an explicit retry", async () => {
    const f = fixture(engineId); const response = deferred<{ error: string }>();
    f.api.send.mockReturnValue(response.promise); f.api.acp.prompt.mockReturnValue(response.promise); f.api.codex.send.mockReturnValue(response.promise);
    const pending = f.revive("First input");
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.refs.messageQueueRef.current.set(f.newId, [{ messageId: "later", text: "Later input" }]);
    response.resolve({ error: "upstream unavailable" }); await pending;
    expect(f.stop).toHaveBeenCalledOnce(); expect(f.refs.liveSessionIdsRef.current.has(f.newId)).toBe(false);
    expect(f.refs.messageQueueRef.current.get(f.newId)?.[0].text).toBe("Later input");
    expect(f.refs.messagesRef.current.at(-1)).toMatchObject({ role: "system", content: "upstream unavailable", retryable: true });
  });

  it("reflects a committed save without stealing focus when navigation happens during persistence", async () => {
    const f = fixture(engineId); const saved = deferred<{}>(); f.api.sessions.save.mockReturnValue(saved.promise);
    const pending = f.revive("Unsent input");
    await vi.waitFor(() => expect(f.api.sessions.save).toHaveBeenCalledOnce()); f.navigate(); saved.resolve({}); await pending;
    expect(f.refs.activeSessionIdRef.current).toBe(f.otherId); expect(f.refs.messagesRef.current).toEqual([f.otherMessage]);
    expect(f.refs.sessionsRef.current.some((s) => s.id === f.newId)).toBe(true);
    expect(f.refs.messageQueueRef.current.get(f.newId)?.[0].text).toBe("Unsent input");
    expect(f.refs.backgroundStoreRef.current.get(f.newId)?.messages.some((m) => m.content === "Unsent input" && m.isQueued)).toBe(true);
    expect(f.send).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalled();
  });

  it("inherits deletion guards after the runtime ID changes while waiting for the view", async () => {
    const f = fixture(engineId); f.holdReady(); const pending = f.revive("Unsent input");
    await vi.waitFor(() => expect(f.refs.activeSessionIdRef.current).toBe(f.newId));
    freezeSession(f.id, "deletion"); releaseSession(f.newId, "deletion", true);
    expect(isSessionFrozen(f.id)).toBe(true); expect(isSessionFrozen(f.newId)).toBe(true);
    await pending; expect(f.send).not.toHaveBeenCalled(); expect(f.stop).toHaveBeenCalled();
  });
});

describe("manual restarts", () => {
  it.each(["claude", "codex", "acp"] as const)("retains the fixed workspace when restarting %s", async (engineId) => {
    const f = fixture(engineId);
    const workspaceBinding = { projectId: "project", rootKind: "worktree" as const, rootPath: "/worktree-a",
      repoCommonDir: "/project/.git", relativeCwd: "apps/web" };
    f.refs.sessionsRef.current[0].workspaceBinding = workspaceBinding;
    await f.restart.restartActiveSessionInCurrentWorktree();
    if (engineId === "claude") expect(f.api.restartSession.mock.calls[0][2]).toBe("/worktree-a/apps/web");
    else if (engineId === "acp") expect(f.api.acp.reloadSession.mock.calls[0][2]).toBe("/worktree-a/apps/web");
    else expect(f.api.codex.resume).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/worktree-a/apps/web" }));
    expect(f.api.projectApps.validateWorkspace).toHaveBeenCalledWith(workspaceBinding);
  });
  it("discards a Claude restart's late status refresh after navigation", async () => {
    const f = fixture("claude"); const refreshing = deferred<void>();
    f.engine.refreshMcpStatus.mockImplementation(async (isCurrent) => {
      await refreshing.promise;
      expect(isCurrent?.()).toBe(false);
    });
    const pending = f.restart.restartActiveSessionInCurrentWorktree();
    await vi.waitFor(() => expect(f.engine.refreshMcpStatus).toHaveBeenCalledOnce());
    f.navigate(); refreshing.resolve();
    expect(await pending).toEqual({ error: "sessionRecoveryCancelled" });
    expect(f.refs.messagesRef.current).toEqual([f.otherMessage]);
    expect(f.stop).toHaveBeenCalledWith(f.id, "session_restart");
  });

  it.each(["codex", "acp"] as const)("does not adopt a %s replacement after its save fails", async (engineId) => {
    const f = fixture(engineId);
    f.api.sessions.save.mockResolvedValueOnce({}).mockResolvedValueOnce({ error: "disk full" });
    const result = await f.restart.restartActiveSessionInCurrentWorktree();
    expect(result.error).toBe("disk full"); expect(f.refs.activeSessionIdRef.current).toBe(f.id);
    expect(f.setters.setActiveSessionId).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledWith(f.newId);
  });

  it("does not restart or update ACP status after navigation during reload negotiation", async () => {
    const f = fixture("acp"); const reload = deferred<{ supportsLoad: boolean }>(); f.api.acp.reloadSession.mockReturnValue(reload.promise);
    const pending = f.restart.restartAcpSession([]);
    await vi.waitFor(() => expect(f.api.acp.reloadSession).toHaveBeenCalledOnce()); f.navigate(); reload.resolve({ supportsLoad: false });
    expect((await pending).error).toBeDefined(); expect(f.stop).not.toHaveBeenCalled();
    expect(f.setters.setAcpMcpStatuses).not.toHaveBeenCalled();
    expect(f.api.mcp.probe).not.toHaveBeenCalled();
  });

  it("does not rewind files for a checkpoint absent from the source snapshot", async () => {
    const f = fixture("claude"); await f.restart.fullRevertSession("missing-checkpoint");
    expect(f.api.revertFiles).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled();
  });
});


it("restarts ACP with the original backing session after MCP reload requires a new connection", async () => {
  const f = fixture("acp");
  const result = await f.restart.restartAcpSession([]);
  expect(result.error).toBeUndefined();
  expect(f.api.acp.reviveSession).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: "agent-thread", mcpServers: [] }));
  expect(f.api.acp.start).not.toHaveBeenCalled();
  expect(f.api.mcp.probe).not.toHaveBeenCalled();
});
