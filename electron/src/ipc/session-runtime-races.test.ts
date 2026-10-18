import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionRepository } from "../lib/session-service";
import { isRecord } from "../lib/productivity-errors";
import { AsyncChannel } from "../lib/async-channel";
import * as claude from "./claude-sessions";
import * as codex from "./codex-sessions";
import * as acp from "./acp-sessions";
import * as processStop from "@shared/lib/process-stop";
import { safeSend } from "../lib/safe-send";
import { beginUsageTurn, endUsageTurn } from "../lib/usage";
import { WINDOWS_SHELL_INSTRUCTIONS } from "../lib/codex-shell-instructions";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const state = vi.hoisted(() => ({
  root: "",
  handlers: new Map<string, Handler>(),
  children: [] as ChildProcess[],
  requests: [] as string[],
  rpcRequests: [] as Array<{ method: string; params: unknown }>,
  authRequired: false,
  pause: "",
  getSDK: vi.fn(),
  claudeBinary: vi.fn<() => Promise<string>>(),
  codexBinary: vi.fn<() => Promise<string>>(),
  beforeSend: vi.fn(async (_id: string, text: string) => ({ text })),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "test" }, BrowserWindow: {},
  ipcMain: { handle: (name: string, handler: Handler) => state.handlers.set(name, handler), on: vi.fn() },
}));
vi.mock("../lib/data-dir", () => ({ getDataDir: () => state.root }));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));
vi.mock("../lib/safe-send", () => ({ safeSend: vi.fn() }));
vi.mock("../lib/posthog", () => ({ captureEvent: vi.fn() }));
vi.mock("../lib/error-utils", () => ({
  reportError: (_label: string, error: unknown) => String(error),
  extractErrorMessage: (error: unknown) => String(error),
}));
vi.mock("../lib/sdk", () => ({ getSDK: state.getSDK, clientAppEnv: () => ({}), getCliPath: () => "fixture" }));
vi.mock("../lib/claude-binary", () => ({ getClaudeBinaryPath: state.claudeBinary }));
vi.mock("../lib/codex-binary", () => ({ getCodexBinaryPath: state.codexBinary, getCodexHome: () => state.root }));
vi.mock("../lib/app-settings", () => ({ getAppSetting: vi.fn() }));
vi.mock("../lib/mcp-oauth-flow", () => ({ getMcpAuthHeaders: async () => ({}) }));
vi.mock("../lib/claude-model-cache", () => ({ getClaudeModelsCache: vi.fn(), setClaudeModelsCache: vi.fn() }));
vi.mock("../lib/agent-registry", () => ({
  getAgent: () => ({ id: "fixture", name: "Fixture", engine: "acp", binary: "fixture" }),
}));
vi.mock("../lib/computer-use-runtime", () => ({
  COMPUTER_USE_MCP_SERVER_NAME: "computer-use", getComputerUseMcpServer: () => null,
  getComputerUseRuntimeStatus: vi.fn(), getCodexMcpServerOverrides: () => [],
  withComputerUseMcpServer: (servers: unknown[] = []) => servers,
}));
vi.mock("../lib/memory/service", () => ({
  withHindsightMcpServers: (servers: unknown[] = []) => servers, getHindsightCodexMcpOverrides: () => [],
  registerMemorySession: vi.fn(), unregisterMemorySession: vi.fn(), beforeMemorySend: state.beforeSend,
  observeClaudeEvent: vi.fn(), observeCodexNotification: vi.fn(), observeAcpUpdate: vi.fn(), completeMemoryTurn: vi.fn(),
}));
// Application bridge authentication/scope/approval behavior is covered by its
// own tests; these fixtures isolate engine process and repository lifetimes.
vi.mock("../lib/project-apps/agent-bridge", () => ({
  registerProjectAppAgentSession: vi.fn(async () => {}), revokeProjectAppAgentSession: vi.fn(), cancelProjectAppAgentPermissions: vi.fn(),
  withProjectAppMcpServer: (servers: unknown[] = []) => servers,
  getProjectAppMcpServer: () => null, getProjectAppAgentProjectId: () => "project",
}));
vi.mock("../lib/usage", () => ({ beginUsageTurn: vi.fn(), endUsageTurn: vi.fn(), stopUsageSession: vi.fn() }));
// Command launch has separate real native/shim/argument tests. These fixtures
// exercise protocol lifecycle races without invoking a real installed agent.
vi.mock("../lib/command-launch", async () => {
  const childProcess = await import("child_process");
  return { spawnExecutable: childProcess.spawn };
});

// Real stdio and process exit, with a local fixture speaking only the protocol
// methods needed here. No installed agent, credentials, model or user data.
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fixture = `
    const readline = require('node:readline');
    const input = readline.createInterface({ input: process.stdin });
    process.on('message', message => process.stdout.write(JSON.stringify(message) + '\\n'));
    input.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === undefined || !message.method) return;
      process.send({ method: message.method, params: message.params });
      if (message.method === process.env.PAUSED_METHOD) return;
      let result = {};
      if (message.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (message.method === 'thread/resume' || message.method === 'thread/start') result = { thread: { id: 'thread' } };
      if (message.method === 'model/list') result = { data: [], nextCursor: null };
      if (message.method === 'config/read') result = { config: { developer_instructions: 'Fixture project rules' } };
      if (message.method === 'turn/start') result = { turn: { id: 'turn' } };
      if (message.method === 'account/read') result = { account: null, requiresOpenaiAuth: process.env.AUTH_REQUIRED === '1' };
      if (message.method === 'thread/goal/get') result = { goal: null };
      if (message.method === 'session/new') result = { sessionId: 'agent-thread' };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `;
  return { ...actual, spawn: () => {
    const child = actual.spawn(process.execPath, ["-e", fixture], {
      stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env, PAUSED_METHOD: state.pause, AUTH_REQUIRED: state.authRequired ? "1" : "" },
    });
    state.children.push(child);
    child.on("message", (message: unknown) => {
      if (isRecord(message) && typeof message.method === "string") {
        state.requests.push(message.method);
        state.rpcRequests.push({ method: message.method, params: message.params });
      }
    });
    return child;
  } };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sdkFixture() {
  const done = deferred<void>();
  const permission = vi.fn(async (_mode: string) => {});
  const query = vi.fn((_options: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => ({
    close: () => done.resolve(), setPermissionMode: permission, interrupt: async () => {},
    async *[Symbol.asyncIterator]() { await done.promise; },
  }));
  return { query, permission };
}

async function invoke(name: string, payload: unknown): Promise<Record<string, unknown>> {
  const handler = state.handlers.get(name);
  if (!handler) throw new Error(`Missing handler: ${name}`);
  const result = await handler(undefined, payload);
  if (!isRecord(result)) throw new Error(`Missing result: ${name}`);
  return result;
}

const source = { projectId: "project", runtimeSessionId: "old" };
async function save(engine: "claude" | "codex" | "acp") {
  await getSessionRepository().save({
    id: "old", projectId: "project", conversationId: "conversation", engine,
    ...(engine === "codex" ? { codexThreadId: "thread" } : {}),
    messages: [{ id: "message", role: "user", content: "saved history", timestamp: 1 }],
  });
}
function resume(engine: "codex" | "acp") {
  return engine === "codex"
    ? invoke("codex:resume", { cwd: state.root, threadId: "thread", source })
    : invoke("acp:revive-session", { cwd: state.root, agentId: "fixture", agentSessionId: "agent-thread", source });
}
async function remove() {
  return getSessionRepository().remove("project", "old", async (ids, meta) => {
    for (const id of ids) await ({ claude, codex, acp })[meta.engine ?? "claude"].stopForDeletion(id);
  });
}

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-runtime-race-"));
  state.children = []; state.requests = []; state.pause = "";
  state.rpcRequests = []; state.authRequired = false;
  state.getSDK.mockReset(); state.claudeBinary.mockReset(); state.codexBinary.mockReset();
  state.beforeSend.mockReset().mockImplementation(async (_id, text) => ({ text }));
  state.claudeBinary.mockResolvedValue("fixture"); state.codexBinary.mockResolvedValue("fixture");
  state.handlers.clear(); claude.register(() => null); codex.register(() => null); acp.register(() => null);
});
afterEach(async () => {
  for (const id of claude.sessions.keys()) await claude.stopForDeletion(id);
  for (const child of state.children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  }
  await fs.rm(state.root, { recursive: true, force: true });
});

describe("project deletion includes unsaved drafts", () => {
  it.each(["codex", "acp"] as const)("awaits every %s runtime during application shutdown", async (engine) => {
    await save(engine);
    await resume(engine);
    await ({ codex, acp })[engine].stopAll();
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
  });

  it("awaits Claude runtime cleanup during application shutdown", async () => {
    await save("claude"); const fixture = sdkFixture(); state.getSDK.mockResolvedValue(fixture.query);
    await invoke("claude:start", { resume: "old", source });
    await claude.stopAll();
    expect(claude.sessions.size).toBe(0);
  });

  it("cancels Claude while loading the SDK before any draft snapshot exists", async () => {
    const sdk = deferred<ReturnType<typeof sdkFixture>["query"]>(); const fixture = sdkFixture();
    state.getSDK.mockReturnValue(sdk.promise);
    const starting = invoke("claude:start", { memoryContext: { projectId: "project" } });
    await vi.waitFor(() => expect(state.getSDK).toHaveBeenCalledOnce());
    await getSessionRepository().removeProject("project", async () => {}); sdk.resolve(fixture.query);
    expect(await starting).toHaveProperty("error"); expect(fixture.query).not.toHaveBeenCalled();
    expect(claude.sessions.size).toBe(0);
  });

  it("cancels Codex binary lookup before a child is spawned", async () => {
    const binary = deferred<string>(); state.codexBinary.mockReturnValue(binary.promise);
    const starting = invoke("codex:start", { cwd: state.root, memoryContext: { projectId: "project" } });
    await vi.waitFor(() => expect(state.codexBinary).toHaveBeenCalledOnce());
    await getSessionRepository().removeProject("project", async () => {}); binary.resolve("fixture");
    expect(await starting).toHaveProperty("error"); expect(state.children).toHaveLength(0);
  });

  it.each(["codex", "acp"] as const)("stops an unsaved %s draft during its handshake", async (engine) => {
    state.pause = "initialize";
    const starting = invoke(`${engine}:start`, { cwd: state.root, agentId: "fixture", memoryContext: { projectId: "project" } });
    await vi.waitFor(() => expect(state.requests).toContain("initialize"));
    await getSessionRepository().removeProject("project", async () => {});
    const result = await starting;
    expect(result.cancelled === true || typeof result.error === "string").toBe(true);
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
    expect(state.requests).not.toContain(engine === "codex" ? "thread/start" : "session/new");
  });

  it.each(["codex", "acp"] as const)("stops a returned %s draft and refuses a delayed first prompt", async (engine) => {
    const started = await invoke(`${engine}:start`, { cwd: state.root, agentId: "fixture", memoryContext: { projectId: "project" } });
    expect(started.error).toBeUndefined();
    const memory = deferred<{ text: string }>(); state.beforeSend.mockReturnValue(memory.promise);
    const sending = invoke(engine === "codex" ? "codex:send" : "acp:prompt", { sessionId: started.sessionId, text: "Input" });
    await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
    await getSessionRepository().removeProject("project", async () => {}); memory.resolve({ text: "Input" });
    expect(await sending).toHaveProperty("error");
    expect(state.requests).not.toContain(engine === "codex" ? "turn/start" : "session/prompt");
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
  });
});

describe("deletion while an engine is being restored", () => {
  it("cancels Claude before SDK loading finishes", async () => {
    await save("claude");
    const sdk = deferred<ReturnType<typeof sdkFixture>["query"]>();
    const fixture = sdkFixture();
    state.getSDK.mockReturnValue(sdk.promise);
    const restoring = invoke("claude:start", { resume: "old", source });
    await vi.waitFor(() => expect(state.getSDK).toHaveBeenCalledOnce());
    await remove();
    sdk.resolve(fixture.query);
    expect(await restoring).toHaveProperty("error");
    expect(fixture.query).not.toHaveBeenCalled();
    expect(claude.sessions.size).toBe(0);
  });

  it("cancels Codex before binary lookup finishes", async () => {
    await save("codex");
    const binary = deferred<string>(); state.codexBinary.mockReturnValue(binary.promise);
    const restoring = resume("codex");
    await vi.waitFor(() => expect(state.codexBinary).toHaveBeenCalledOnce());
    await remove(); binary.resolve("fixture");
    expect(await restoring).toHaveProperty("error");
    expect(state.children).toHaveLength(0);
  });

  it.each(["codex", "acp"] as const)("stops a %s child during protocol initialization", async (engine) => {
    await save(engine); state.pause = "initialize";
    const restoring = resume(engine);
    await vi.waitFor(() => expect(state.requests).toContain("initialize"));
    await remove();
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
    expect(await restoring).toHaveProperty("error");
    expect(state.requests).not.toContain(engine === "codex" ? "thread/resume" : "session/load");
    expect(await getSessionRepository().load("project", "old")).toBeNull();
  });

  it.each(["codex", "acp"] as const)("finds the returned %s runtime before its replacement snapshot exists", async (engine) => {
    await save(engine);
    const result = await resume(engine);
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toEqual(expect.any(String));
    await remove();
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
    expect(await getSessionRepository().list("project")).toEqual([]);
  });

  it("stops Claude while permission-mode initialization is still pending", async () => {
    await save("claude");
    const fixture = sdkFixture(); const permission = deferred<void>();
    fixture.permission.mockReturnValue(permission.promise); state.getSDK.mockResolvedValue(fixture.query);
    const restoring = invoke("claude:start", { resume: "old", source, permissionMode: "acceptEdits" });
    await vi.waitFor(() => expect(fixture.permission).toHaveBeenCalledOnce());
    await remove(); permission.resolve();
    expect(await restoring).toHaveProperty("error");
    expect(claude.sessions.size).toBe(0);
  });

  it("cancels the ACP restart fallback while session/new is pending", async () => {
    await save("acp"); state.pause = "session/new";
    const starting = invoke("acp:start", { cwd: state.root, agentId: "fixture", source });
    await vi.waitFor(() => expect(state.requests).toContain("session/new"));
    await remove();
    const result = await starting;
    expect(result.cancelled === true || typeof result.error === "string").toBe(true);
    expect(state.children[0].exitCode !== null || state.children[0].signalCode !== null).toBe(true);
    expect(acp.acpSessions.size).toBe(0);
  });

  it.each(["codex", "acp"] as const)("rejects a %s send whose memory preflight completes after deletion", async (engine) => {
    await save(engine);
    const result = await resume(engine);
    expect(result.error).toBeUndefined();
    const memory = deferred<{ text: string }>(); state.beforeSend.mockReturnValue(memory.promise);
    const sending = invoke(engine === "codex" ? "codex:send" : "acp:prompt", { sessionId: result.sessionId, text: "hello" });
    await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
    await remove(); memory.resolve({ text: "hello" });
    expect(await sending).toHaveProperty("error");
    expect(state.requests).not.toContain(engine === "codex" ? "turn/start" : "session/prompt");
  });

  it.each(["codex", "acp"] as const)("keeps the source after a %s stop failure without reactivating the cancelled runtime", async (engine) => {
    await save(engine);
    const result = await resume(engine);
    const kill = vi.spyOn(processStop, "stopProcessAndWait").mockRejectedValue(new Error("fixture stop failed"));
    try {
      await expect(remove()).rejects.toMatchObject({ code: "STOP_FAILED" });
      expect(await getSessionRepository().load("project", "old")).not.toBeNull();
      expect(await invoke(engine === "codex" ? "codex:send" : "acp:prompt", { sessionId: result.sessionId, text: "hello" })).toHaveProperty("error");
    } finally { kill.mockRestore(); }
    if (typeof result.sessionId !== "string") throw new Error("Missing resumed runtime ID");
    await ({ codex, acp })[engine].stopForDeletion(result.sessionId);
    const retry = await resume(engine);
    expect(retry.error).toBeUndefined();
  });

  it("denies a pending Claude tool permission and leaves an existing session intact on duplicate resume", async () => {
    await save("claude"); const fixture = sdkFixture(); state.getSDK.mockResolvedValue(fixture.query);
    await invoke("claude:start", { resume: "old", source });
    const original = claude.sessions.get("old");
    expect(await invoke("claude:start", { resume: "old", source })).toHaveProperty("error");
    expect(claude.sessions.get("old")).toBe(original);
    const canUseTool = fixture.query.mock.calls[0][0].options.canUseTool;
    if (typeof canUseTool !== "function") throw new Error("Missing permission callback");
    const permission = canUseTool("Read", {}, { toolUseID: "tool", suggestions: [], decisionReason: "test" });
    expect(original?.pendingPermissions.size).toBe(1);
    await remove();
    expect(await permission).toMatchObject({ behavior: "deny" });
  });

  it("rejects a delayed Claude send after deletion, but allows another turn after interrupt", async () => {
    await save("claude"); const fixture = sdkFixture(); state.getSDK.mockResolvedValue(fixture.query);
    expect(await invoke("claude:start", { resume: "old", source })).not.toHaveProperty("error");
    expect(await invoke("claude:interrupt", "old")).toMatchObject({ ok: true });
    const channel = fixture.query.mock.calls[0][0].prompt;
    expect(channel).toBeInstanceOf(AsyncChannel);
    if (!(channel instanceof AsyncChannel)) throw new Error("Expected the actual input channel");
    const push = vi.spyOn(channel, "push");
    const payload = { sessionId: "old", message: { message: { content: "hello" } } };
    expect(await invoke("claude:send", payload)).toMatchObject({ ok: true });
    push.mockClear();
    const memory = deferred<{ text: string }>(); state.beforeSend.mockReturnValue(memory.promise);
    const sending = invoke("claude:send", payload);
    await remove(); memory.resolve({ text: "hello" });
    expect(await sending).toHaveProperty("error"); expect(push).not.toHaveBeenCalled();
  });

  it("cancels Claude's internal restart before spawning its replacement query", async () => {
    await save("claude"); const fixture = sdkFixture(); state.getSDK.mockResolvedValue(fixture.query);
    await invoke("claude:start", { resume: "old", source });
    const binary = deferred<string>(); state.claudeBinary.mockReturnValue(binary.promise);
    const restarting = invoke("claude:restart-session", { sessionId: "old" });
    await vi.waitFor(() => expect(state.claudeBinary).toHaveBeenCalledTimes(2));
    await remove(); binary.resolve("fixture");
    expect(await restarting).toHaveProperty("error"); expect(fixture.query).toHaveBeenCalledOnce();
  });

  it("keeps an unsaved Claude query running when restart cannot resolve its source", async () => {
    const fixture = sdkFixture(); state.getSDK.mockResolvedValue(fixture.query);
    const started = await invoke("claude:start", { memoryContext: { projectId: "project" } });
    if (typeof started.sessionId !== "string") throw new Error("Missing runtime ID");
    const original = claude.sessions.get(started.sessionId);
    expect(await invoke("claude:restart-session", { sessionId: started.sessionId })).toHaveProperty("error");
    expect(claude.sessions.get(started.sessionId)).toBe(original);
    expect(original?.stopping).not.toBe(true);
  });
});


describe("Codex subagent notification routing", () => {
  it("forwards normalized cards and keeps child turns out of root processing/interrupt state", async () => {
    await save("codex");
    const result = await resume("codex");
    expect(result.error).toBeUndefined();
    if (typeof result.sessionId !== "string") throw new Error("Missing runtime ID");
    vi.mocked(safeSend).mockClear();
    vi.mocked(beginUsageTurn).mockClear();
    vi.mocked(endUsageTurn).mockClear();
    const child = state.children[0];
    child.send({ method: "turn/started", params: { threadId: "thread", turn: { id: "root-turn", status: "inProgress", items: [] } } });
    const item = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", senderThreadId: "thread", prompt: "Inspect the renderer",
      model: "worker-model", reasoningEffort: "high", receiverThreadIds: [], agentsStates: {}, status: "inProgress" };
    child.send({ method: "item/started", params: { threadId: "thread", turnId: "root-turn", item } });
    child.send({ method: "item/completed", params: { threadId: "thread", turnId: "root-turn", item: { ...item, status: "completed", receiverThreadIds: ["agent"],
      agentsStates: { agent: { status: "running", message: null } } } } });
    child.send({ method: "turn/started", params: { threadId: "agent", turn: { id: "child-turn", status: "inProgress", items: [] } } });
    child.send({ method: "item/completed", params: { threadId: "agent", turnId: "child-turn", item: { type: "agentMessage", id: "reply", text: "Renderer inspected", phase: "final_answer" } } });
    child.send({ method: "turn/completed", params: { threadId: "agent", turn: { id: "child-turn", status: "completed", items: [] } } });
    child.send({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "root-turn", itemId: "answer", delta: "Root is still running" } });
    await vi.waitFor(() => expect(safeSend).toHaveBeenCalledWith(expect.any(Function), "codex:event", expect.objectContaining({
      method: "item/agentMessage/delta", params: expect.objectContaining({ delta: "Root is still running" }),
    })));
    expect(safeSend).toHaveBeenCalledWith(expect.any(Function), "codex:event", expect.objectContaining({
      method: "codex:subagent", params: expect.objectContaining({ call: expect.objectContaining({ requestedModel: "worker-model", prompt: "Inspect the renderer" }) }),
    }));
    expect(safeSend).toHaveBeenCalledWith(expect.any(Function), "codex:event", expect.objectContaining({
      method: "codex:subagent", params: { call: null, agents: [expect.objectContaining({ status: "completed", message: "Renderer inspected" })] },
    }));
    expect(safeSend).not.toHaveBeenCalledWith(expect.any(Function), "codex:event", expect.objectContaining({
      method: "turn/completed", params: expect.objectContaining({ threadId: "agent" }),
    }));
    expect(beginUsageTurn).toHaveBeenCalledExactlyOnceWith(result.sessionId, "root-turn");
    expect(endUsageTurn).not.toHaveBeenCalled();
    await invoke("codex:interrupt", result.sessionId);
    await vi.waitFor(() => expect(state.requests).toContain("turn/interrupt"));
    await codex.stopForDeletion(result.sessionId);
  });
});

describe.skipIf(process.platform !== "win32")("Codex Windows encoding lifecycle", () => {
  it.each(["new", "resume", "lazy"] as const)("adds UTF-8 rules for a %s thread without changing user input or plan instructions", async (flow) => {
    state.authRequired = flow === "lazy";
    if (flow === "resume") await save("codex");
    const result = flow === "resume"
      ? await resume("codex")
      : await invoke("codex:start", { cwd: state.root });
    expect(result.error).toBeUndefined();
    if (flow === "lazy") expect(result.needsAuth).toBe(true);
    const collaborationMode = { mode: "plan", settings: { model: "fixture", reasoning_effort: "medium", developer_instructions: null } };
    expect(await invoke("codex:send", { sessionId: result.sessionId, text: "读取 CLAUDE.md", collaborationMode }))
      .not.toHaveProperty("error");
    await vi.waitFor(() => expect(state.requests).toContain("turn/start"));
    const method = flow === "resume" ? "thread/resume" : "thread/start";
    const thread = state.rpcRequests.find((request) => request.method === method);
    expect(thread?.params).toMatchObject({ developerInstructions: `Fixture project rules\n\n${WINDOWS_SHELL_INSTRUCTIONS}` });
    expect(state.rpcRequests).toContainEqual({ method: "config/read", params: { cwd: state.root, includeLayers: false } });
    expect(state.rpcRequests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      input: [{ type: "text", text: "读取 CLAUDE.md" }], collaborationMode,
    });
  });

  it("does not resume a deleted session after its instruction lookup settles", async () => {
    await save("codex"); state.pause = "config/read";
    const restoring = resume("codex");
    await vi.waitFor(() => expect(state.requests).toContain("config/read"));
    await remove();
    expect(await restoring).toHaveProperty("error");
    expect(state.requests).not.toContain("thread/resume");
  });

  it("does not lazily create a thread after its project is deleted during instruction lookup", async () => {
    state.pause = "config/read"; state.authRequired = true;
    const result = await invoke("codex:start", { cwd: state.root, memoryContext: { projectId: "project" } });
    expect(result.needsAuth).toBe(true);
    const sending = invoke("codex:send", { sessionId: result.sessionId, text: "read a file" });
    await vi.waitFor(() => expect(state.requests).toContain("config/read"));
    await getSessionRepository().removeProject("project", async () => {});
    expect(await sending).toHaveProperty("error");
    expect(state.requests).not.toContain("thread/start");
    expect(state.requests).not.toContain("turn/start");
  });
});
