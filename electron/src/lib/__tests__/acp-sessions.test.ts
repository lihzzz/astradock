import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client, SessionNotification } from "@agentclientprotocol/sdk";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

const f = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  client: undefined as Client | undefined,
  controller: new AbortController(),
  newSession: vi.fn(), resume: vi.fn(), load: vi.fn(), prompt: vi.fn(), cancel: vi.fn(), ext: vi.fn(),
  config: vi.fn(), model: vi.fn(), mode: vi.fn(), list: vi.fn(), fork: vi.fn(),
  send: vi.fn(), observe: vi.fn(), stop: vi.fn(), spawn: vi.fn(),
  agent: { id: "opencode", name: "OpenCode", engine: "acp", binary: "opencode", args: ["acp"] },
}));
vi.mock("electron", () => ({ app: { getVersion: () => "1" }, BrowserWindow: class {}, ipcMain: { on: vi.fn(), handle: (name: string, fn: (...args: unknown[]) => unknown) => f.handlers.set(name, fn) } }));
vi.mock("../command-launch", () => ({ spawnExecutable: f.spawn }));
vi.mock("../agent-registry", () => ({ getAgent: () => f.agent }));
vi.mock("../app-settings", () => ({ getAppSetting: () => "" }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../safe-send", () => ({ safeSend: f.send }));
vi.mock("../error-utils", () => ({ extractErrorMessage: String, reportError: (_label: string, error: unknown) => String(error) }));
vi.mock("../posthog", () => ({ captureEvent: vi.fn() }));
vi.mock("../mcp-oauth-flow", () => ({ getMcpAuthHeaders: async () => ({}) }));
vi.mock("../computer-use-runtime", () => ({ withComputerUseMcpServer: (servers: unknown[] = []) => servers }));
vi.mock("../memory/service", () => ({ withHindsightMcpServers: (servers: unknown[]) => servers, registerMemorySession: vi.fn(), unregisterMemorySession: vi.fn(), beforeMemorySend: async (_id: string, text: string) => ({ text }), observeAcpUpdate: f.observe, completeMemoryTurn: vi.fn() }));
vi.mock("../project-apps/agent-bridge", () => ({ withProjectAppMcpServer: (servers: unknown[]) => servers, registerProjectAppAgentSession: vi.fn(), unregisterProjectAppAgentSession: vi.fn(), revokeProjectAppAgentSession: vi.fn(), cancelProjectAppAgentPermissions: vi.fn() }));
vi.mock("../usage", () => ({ beginUsageTurn: vi.fn(), endUsageTurn: vi.fn(), stopUsageSession: vi.fn() }));
vi.mock("../token-usage", () => ({ bindSessionTokenUsage: vi.fn(), recordAcpTokenUsage: vi.fn() }));
vi.mock("../tasks/engine-events", () => ({ finishAcpTaskTurn: vi.fn() }));
vi.mock("../tasks/runtime-events", () => ({ taskRuntimeEvents: { stop: vi.fn(), wait: vi.fn(), resolve: vi.fn(), publish: vi.fn(), get: vi.fn() } }));
vi.mock("../session-service", () => ({ getSessionRepository: () => ({ bindRuntime: async () => ({ assertActive() {}, release() {} }) }) }));
vi.mock("@shared/lib/process-stop", () => ({ stopProcessAndWait: f.stop }));
vi.mock("@agentclientprotocol/sdk", () => ({ PROTOCOL_VERSION: 1, ndJsonStream: vi.fn(), ClientSideConnection: class {
  signal = f.controller.signal;
  constructor(client: () => Client) { f.client = client(); }
  initialize = async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, close: {}, list: {}, fork: {} } } });
  newSession = f.newSession; unstable_resumeSession = f.resume; loadSession = f.load; prompt = f.prompt; cancel = f.cancel;
  extMethod = f.ext; setSessionConfigOption = f.config; unstable_setSessionModel = f.model; setSessionMode = f.mode;
  unstable_listSessions = f.list; unstable_forkSession = f.fork;
} }));

import { acpUtilityPrompt } from "../acp-utility-prompt";
import { acpSessions, register, stopAll } from "../../ipc/acp-sessions";

async function call(name: string, ...args: unknown[]) {
  const handler = f.handlers.get(name);
  if (!handler) throw new Error("Missing handler " + name);
  return await handler({}, ...args);
}
async function start() {
  const result = await call("acp:start", { agentId: "opencode", cwd: process.cwd(), mcpServers: [{ name: "bad", transport: "stdio", command: "missing" }] });
  if (!result || typeof result !== "object" || !("sessionId" in result) || typeof result.sessionId !== "string") throw new Error(JSON.stringify(result));
  return result.sessionId;
}
async function update(sessionId: string, update: SessionNotification["update"]) { await f.client?.sessionUpdate({ sessionId, update }); }

beforeEach(() => {
  vi.clearAllMocks(); f.handlers.clear(); f.controller = new AbortController();
  f.agent.id = "opencode";
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null }));
  f.stop.mockImplementation(async (child: EventEmitter) => { child.emit("exit", 0); });
  f.newSession.mockImplementation(async () => {
    await update("main", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "compact" }] });
    return { sessionId: "main", configOptions: [] };
  });
  f.resume.mockResolvedValue({ configOptions: [] }); f.load.mockResolvedValue({ configOptions: [] });
  f.cancel.mockResolvedValue(undefined); f.ext.mockResolvedValue({}); f.prompt.mockResolvedValue({ stopReason: "end_turn" });
  f.config.mockResolvedValue({ configOptions: [] }); f.list.mockResolvedValue({ sessions: [] }); f.fork.mockResolvedValue({ sessionId: "fork" });
  register(() => null);
});
afterEach(async () => { await stopAll(); vi.useRealTimers(); });

describe("ACP IPC lifecycle", () => {
  it("buffers main-session startup state, reports unknown MCP health, and drops foreign events", async () => {
    const id = await start();
    expect(await call("acp:get-available-commands", id)).toEqual({ commands: [{ name: "compact", description: "compact" }] });
    f.send.mockClear(); f.observe.mockClear();
    await update("aux", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret" } });
    expect(f.send).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
    const result = await call("acp:start", { agentId: "opencode", cwd: process.cwd(), mcpServers: [{ name: "bad", transport: "stdio", command: "missing" }] });
    expect(result).toMatchObject({ mcpStatuses: [{ name: "bad", status: "unknown" }] });
  });
  it("resumes without replaying into UI or memory", async () => {
    f.resume.mockImplementation(async () => { await update("old", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replay" } }); return {}; });
    const result = await call("acp:revive-session", { agentId: "opencode", cwd: process.cwd(), agentSessionId: "old", source: { projectId: "p", runtimeSessionId: "old-ui" } });
    expect(result).toMatchObject({ agentSessionId: "old", usedLoad: true });
    expect(f.resume).toHaveBeenCalledOnce(); expect(f.load).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
  });
  it("requires a fresh OpenCode connection for MCP removal", async () => {
    const id = await start();
    expect(await call("acp:reload-session", { sessionId: id, mcpServers: [] })).toMatchObject({ supportsLoad: false, requiresRestart: true });
    expect(f.load).not.toHaveBeenCalled();
  });
  it("rejects unknown file/permission sessions and invalid permission choices", async () => {
    const id = await start();
    await expect(f.client?.readTextFile?.({ sessionId: "foreign", path: "secret" })).rejects.toThrow("Unknown");
    const permission = { sessionId: "main", toolCall: { toolCallId: "t", title: "bash" }, options: [{ optionId: "yes", kind: "allow_once" as const, name: "Allow" }] };
    expect(await f.client?.requestPermission({ ...permission, sessionId: "foreign" })).toEqual({ outcome: { outcome: "cancelled" } });
    const pending = f.client?.requestPermission(permission);
    const entry = acpSessions.get(id)!; const requestId = [...entry.pendingPermissions.keys()][0];
    expect(await call("acp:permission_response", { sessionId: id, requestId, optionId: "invented" })).toHaveProperty("error");
    await call("acp:cancel", id);
    expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
    expect(entry.pendingPermissions.size).toBe(0);
  });
  it("cleans pending permissions and the process on transport disconnect", async () => {
    const id = await start();
    const pending = f.client?.requestPermission({ sessionId: "main", toolCall: { toolCallId: "t" }, options: [] });
    f.controller.abort();
    expect(await pending).toEqual({ outcome: { outcome: "cancelled" } });
    await vi.waitFor(() => expect(acpSessions.has(id)).toBe(false));
    expect(f.stop).toHaveBeenCalled();
  });
  it("captures explicit history without broadcasting or remembering it", async () => {
    const id = await start(); f.send.mockClear(); f.observe.mockClear();
    f.load.mockImplementation(async () => { await update("remote", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } }); return {}; });
    expect(await call("acp:read-session", { sessionId: id, agentSessionId: "remote" })).toMatchObject({ events: [{ sessionId: "remote" }] });
    expect(f.send).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
    expect(f.ext).toHaveBeenCalledWith("session/close", { sessionId: "remote" });
  });
  it("closes the backing session before terminating its owned process", async () => {
    const id = await start(); await call("acp:stop", id);
    expect(f.ext).toHaveBeenCalledWith("session/close", { sessionId: "main" });
    expect(acpSessions.has(id)).toBe(false);
  });
});


describe("isolated ACP utility processes", () => {
  function isolatedSession() {
    f.newSession.mockImplementation(async () => {
      const config = JSON.parse(f.spawn.mock.calls.at(-1)?.[2].env.OPENCODE_CONFIG_CONTENT);
      return { sessionId: "utility", configOptions: [{ id: "mode", category: "mode", currentValue: config.default_agent }] };
    });
    f.prompt.mockImplementation(async () => {
      await update("utility", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A title" } });
      return { stopReason: "end_turn" };
    });
  }
  it("uses a dedicated deny-all process, never broadcasts utility output, and closes it", async () => {
    const id = await start(); const mainProcess = acpSessions.get(id)!.process;
    isolatedSession(); f.send.mockClear(); f.observe.mockClear();
    expect(await acpUtilityPrompt(id, "title please")).toBe("A title");
    const options = f.spawn.mock.calls.at(-1)?.[2];
    const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
    expect(config.permission).toBe("deny"); expect(config.agent[config.default_agent].permission).toBe("deny");
    expect(f.spawn.mock.calls.at(-1)?.[1]).toContain("--pure");
    expect(options.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    expect(f.send).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled();
    expect(f.stop).not.toHaveBeenCalledWith(mainProcess); expect(acpSessions.has(id)).toBe(true);
    expect(f.ext).toHaveBeenCalledWith("session/close", { sessionId: "utility" });
    await expect(f.client?.writeTextFile?.({ sessionId: "utility", path: "x", content: "x" })).rejects.toThrow("denied");
  });
  it("fails closed for agents without verified tool-free execution", async () => {
    f.agent.id = "other"; const id = await start(); f.spawn.mockClear();
    await expect(acpUtilityPrompt(id, "title")).rejects.toThrow("verified tool-free");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("does not prompt if the server failed to select the deny-all agent", async () => {
    const id = await start(); f.prompt.mockClear();
    await expect(acpUtilityPrompt(id, "title")).rejects.toThrow("did not select");
    expect(f.prompt).not.toHaveBeenCalled(); expect(acpSessions.has(id)).toBe(true);
  });
  it("bounds even a hung session/new and preserves the main process", async () => {
    const id = await start(); const mainProcess = acpSessions.get(id)!.process;
    f.newSession.mockImplementation(() => new Promise(() => {}));
    await expect(acpUtilityPrompt(id, "title", 100)).rejects.toThrow(/cancelled|timed out/);
    expect(f.stop).not.toHaveBeenCalledWith(mainProcess); expect(acpSessions.has(id)).toBe(true);
  });
  it("rejects a tool event and terminates only the utility process", async () => {
    const id = await start(); isolatedSession();
    f.prompt.mockImplementation(async () => {
      await update("utility", { sessionUpdate: "tool_call", toolCallId: "t", title: "bash" });
      return { stopReason: "end_turn" };
    });
    await expect(acpUtilityPrompt(id, "title")).rejects.toThrow("cancelled");
    expect(acpSessions.has(id)).toBe(true);
  });
  it("does not create any process for an already cancelled request", async () => {
    const id = await start(); const controller = new AbortController(); controller.abort(); f.spawn.mockClear();
    await expect(acpUtilityPrompt(id, "title", 100, controller.signal)).rejects.toThrow("cancelled");
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
