import { app, BrowserWindow, ipcMain } from "electron";
import { AcpSerialQueue, AcpEventRouter, acpMcpStatuses, canRestoreAcpSession, restoreAcpSession, setAcpConfig, closeAcpSession, withAcpTimeout as withTimeout } from "../lib/acp-runtime";
import type { ChildProcess } from "child_process";
import { spawnExecutable } from "../lib/command-launch";
import { Readable, Writable } from "stream";
import crypto from "crypto";
import path from "path";
import { log } from "../lib/logger";
import { safeSend } from "../lib/safe-send";
import { getAgent } from "../lib/agent-registry";
import type { InstalledAgent } from "../lib/agent-registry";
import { getMcpAuthHeaders } from "../lib/mcp-oauth-flow";
import { getAppSetting } from "../lib/app-settings";
import { extractErrorMessage, reportError } from "../lib/error-utils";
import { captureEvent } from "../lib/posthog";
import {
  buildAuthRequiredError,
  extractAuthRequired,
  getAuthGuidance,
  normalizeAcpAuthMethods,
} from "../lib/acp-auth";

// ACP SDK is ESM-only, must be async-imported
import type {
  AgentCapabilities,
  SessionConfigOption,
  SessionNotification,
  NewSessionResponse,
  ClientSideConnection,
  ContentBlock,
  McpServer,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
let _acp: typeof import("@agentclientprotocol/sdk") | null = null;
async function getACP() {
  if (!_acp) _acp = await import("@agentclientprotocol/sdk");
  return _acp;
}

import { resolveACPFilePath, applyReadRange, ACP_CLIENT_CAPABILITIES } from "@shared/lib/acp-helpers";
import type { ACPTextFileParams } from "@shared/lib/acp-helpers";
import type { McpServerInput } from "@shared/lib/mcp-config";
import type { ACPAuthMethod, ACPAuthenticateResult } from "@shared/types/acp";
import { withComputerUseMcpServer } from "../lib/computer-use-runtime";
import { withHindsightMcpServers, registerMemorySession, unregisterMemorySession, beforeMemorySend, observeAcpUpdate, completeMemoryTurn } from "../lib/memory/service";
import { cancelProjectAppAgentPermissions, registerProjectAppAgentSession, revokeProjectAppAgentSession, withProjectAppMcpServer } from "../lib/project-apps/agent-bridge";
import { beginUsageTurn, endUsageTurn, stopUsageSession } from "../lib/usage";
import { bindSessionTokenUsage, recordAcpTokenUsage } from "../lib/token-usage";
import { finishAcpTaskTurn } from "../lib/tasks/engine-events";
import { taskRuntimeEvents } from "../lib/tasks/runtime-events";
import { stopProcessAndWait } from "@shared/lib/process-stop";
import { getSessionRepository } from "../lib/session-service";
import type { SessionRuntimeLease } from "../lib/session-repository";
import type { SessionResumeSource } from "@shared/types/productivity";

type ACPReadTextFileParams = ACPTextFileParams & { content?: string; line?: number | null; limit?: number | null };
type ACPWriteTextFileParams = ACPTextFileParams & { content: string };

async function acpReadTextFile(params: ACPReadTextFileParams): Promise<{ content: string; filePath: string }> {
  const filePath = resolveACPFilePath(params);
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf-8");
  return { filePath, content: applyReadRange(content, params.line, params.limit) };
}

async function acpWriteTextFile(params: ACPWriteTextFileParams): Promise<{ filePath: string }> {
  const filePath = resolveACPFilePath(params);
  const fs = await import("fs/promises");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, params.content, "utf-8");
  return { filePath };
}

const ACP_INIT_TIMEOUT_MS = 15000;
const ACP_START_TIMEOUT_MS = 20000;
const ACP_AUTH_TIMEOUT_MS = 120000;

interface ACPSessionEntry {
  process: ChildProcess;
  connection: ClientSideConnection;
  acpSessionId?: string;
  internalId: string;
  analyticsProperties: AcpAnalyticsProperties;
  eventCounter: number;
  pendingPermissions: Map<string, { resolve: (response: RequestPermissionResponse) => void; optionIds: Set<string> }>;
  cwd: string;
  projectId: string | undefined;
  supportsLoadSession: boolean;
  capabilities: AgentCapabilities;
  router: AcpEventRouter<SessionNotification["update"]>;
  agentName: string;
  agentId: string;
  agentBinary: string;
  agentEnv: Record<string, string>;
  isPrompting?: boolean;
  promptFinished?: Promise<void>;
  turnCancelled?: boolean;
  historyCapture?: { sessionId: string; events: SessionNotification[]; bytes: number; overflow: boolean };
  authMethods: ACPAuthMethod[];
  pendingStartRequest?: {
    cwd: string;
    mcpServers: McpServer[];
    sourceServers: McpServerInput[];
  };
  /** True while session/load is in-flight — suppresses history replay notifications from reaching the renderer */
  isReloading: boolean;
  /** Last actionable stderr error line observed from the ACP agent process */
  lastStderrError?: string;
}

export const acpSessions = new Map<string, ACPSessionEntry>();
const acpProcesses = new Map<string, {
  process: ChildProcess;
  stopping: boolean;
  runtimeLease?: SessionRuntimeLease;
  pendingPermissions: ACPSessionEntry["pendingPermissions"];
}>();

function assertAcpProcessActive(sessionId: string): void {
  const runtime = acpProcesses.get(sessionId);
  if (!runtime || runtime.stopping) throw new Error("ACP session stopped");
  runtime.runtimeLease?.assertActive();
}

export async function stopForDeletion(sessionId: string): Promise<void> {
  revokeProjectAppAgentSession(sessionId);
  stopUsageSession(sessionId);  taskRuntimeEvents.stop(sessionId);
  const runtime = acpProcesses.get(sessionId);
  if (!runtime) return;
  runtime.stopping = true;
  if (pendingStartProcess?.id === sessionId) pendingStartProcess.aborted = true;
  for (const permission of runtime.pendingPermissions.values()) permission.resolve({ outcome: { outcome: "cancelled" } });
  runtime.pendingPermissions.clear();
  const session = acpSessions.get(sessionId);
  if (session?.acpSessionId && !session.connection.signal.aborted) {
    try { await withTimeout(closeAcpSession(session.connection, session.capabilities, session.acpSessionId), 1000, "ACP close", session.connection.signal); }
    catch (error) { reportError("ACP_CLOSE_ERR", error, { sessionId }); }
  }
  await stopProcessAndWait(runtime.process);
  acpSessions.delete(sessionId);
  unregisterMemorySession(sessionId); revokeProjectAppAgentSession(sessionId);
  configBuffer.delete(sessionId);
  commandsBuffer.delete(sessionId);
}

// Buffer latest config options per session — survives the renderer's DRAFT→active transition
// where events arrive before useACP's listener is subscribed
const configQueue = new AcpSerialQueue();
const configBuffer = new Map<string, SessionConfigOption[]>();

// Buffer latest available commands per session — same lifecycle as configBuffer
export function getAcpSessionModel(sessionId: string): string | undefined {
  return configBuffer.get(sessionId)?.find(option => option.category === "model")?.currentValue;
}

const commandsBuffer = new Map<string, import("@agentclientprotocol/sdk").AvailableCommand[]>();

// Track in-flight acp:start so the renderer can abort during npx download / protocol init.
// Only one start can be in-flight at a time (guarded by materializingRef in the renderer).
let pendingStartProcess: { id: string; process: ChildProcess; aborted?: boolean } | null = null;

type AcpAnalyticsProperties = {
  acp_agent: string;
  acp_agent_source: "registry" | "custom";
  acp_agent_launch_method: "npx" | "binary" | "unknown";
  acp_agent_registry_id?: string;
  acp_agent_registry_version?: string;
};

function buildAcpAnalyticsProperties(agent: InstalledAgent): AcpAnalyticsProperties {
  const registryId = agent.registryId?.trim();
  const launchMethod = agent.binary === "npx" ? "npx" : agent.binary ? "binary" : "unknown";

  if (registryId) {
    return {
      acp_agent: registryId,
      acp_agent_source: "registry",
      acp_agent_launch_method: launchMethod,
      acp_agent_registry_id: registryId,
      ...(agent.registryVersion ? { acp_agent_registry_version: agent.registryVersion } : {}),
    };
  }

  const customHash = crypto.createHash("sha256").update(agent.id).digest("hex").slice(0, 12);
  return {
    acp_agent: `custom:${customHash}`,
    acp_agent_source: "custom",
    acp_agent_launch_method: launchMethod,
  };
}

function resolveAgentDefinition(agent: InstalledAgent | undefined): InstalledAgent | undefined {
  if (!agent || agent.id !== "opencode") return agent;
  const customBinary = getAppSetting("opencodeCustomBinaryPath").trim();
  return customBinary ? { ...agent, binary: customBinary } : agent;
}

export function getAcpAnalyticsPropertiesForSession(sessionId: string): Record<string, unknown> | null {
  return acpSessions.get(sessionId)?.analyticsProperties ?? null;
}

/** One-line summary for each ACP session update (mirrors summarizeEvent for Claude) */
function summarizeUpdate(update: Record<string, unknown>): string {
  const kind = update.sessionUpdate as string;
  switch (kind) {
    case "agent_message_chunk": {
      const c = update.content as { type?: string; text?: string } | undefined;
      return `agent_message_chunk text_len=${c?.text?.length ?? 0}`;
    }
    case "agent_thought_chunk": {
      const c = update.content as { type?: string; text?: string } | undefined;
      return `agent_thought_chunk text_len=${c?.text?.length ?? 0}`;
    }
    case "user_message_chunk": {
      const c = update.content as { type?: string; text?: string } | undefined;
      return `user_message_chunk text_len=${c?.text?.length ?? 0}`;
    }
    case "tool_call": {
      const tc = update as { toolCallId?: string; title?: string; kind?: string; status?: string };
      return `tool_call id=${tc.toolCallId?.slice(0, 12)} title="${tc.title}" kind=${tc.kind ?? "?"} status=${tc.status}`;
    }
    case "tool_call_update": {
      const tcu = update as { toolCallId?: string; status?: string; rawOutput?: unknown; content?: unknown[] };
      const hasOutput = tcu.rawOutput != null;
      const contentCount = Array.isArray(tcu.content) ? tcu.content.length : 0;
      return `tool_call_update id=${tcu.toolCallId?.slice(0, 12)} status=${tcu.status ?? "?"} hasOutput=${hasOutput} content_items=${contentCount}`;
    }
    case "plan": {
      const p = update as { entries?: unknown[] };
      return `plan entries=${p.entries?.length ?? 0}`;
    }
    case "usage_update": {
      const uu = update as { size?: number; used?: number; cost?: { amount?: number; currency?: string } };
      const parts: string[] = [];
      if (uu.size != null) parts.push(`size=${uu.size}`);
      if (uu.used != null) parts.push(`used=${uu.used}`);
      if (uu.cost) parts.push(`cost=$${uu.cost.amount}`);
      return `usage_update ${parts.join(" ")}`;
    }
    case "session_info_update": {
      const si = update as { title?: string };
      return `session_info_update title="${si.title ?? ""}"`;
    }
    case "current_mode_update": {
      const cm = update as { currentModeId?: string };
      return `current_mode_update mode=${cm.currentModeId}`;
    }
    case "config_option_update": {
      const co = update as { configOptions?: unknown[] };
      return `config_option_update options_count=${co.configOptions?.length ?? 0}`;
    }
    case "available_commands_update": {
      const ac = update as { availableCommands?: unknown[] };
      return `available_commands_update count=${ac.availableCommands?.length ?? 0}`;
    }
    default:
      return `${kind} (unknown)`;
  }
}

/** Convert renderer MCP server configs to ACP SDK format (with fresh auth headers). */
async function buildAcpMcpServers(servers: McpServerInput[]): Promise<McpServer[]> {
  const resolved = await Promise.all(servers.map(async (s): Promise<McpServer | null> => {
    if (s.transport === "stdio") {
      if (!s.command) { log("ACP_MCP_WARN", `Server "${s.name}" (stdio) missing command — skipping`); return null; }
      return {
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ? Object.entries(s.env).map(([name, value]) => ({ name, value })) : [],
      };
    }
    if (!s.url) { log("ACP_MCP_WARN", `Server "${s.name}" (${s.transport}) missing URL — skipping`); return null; }
    const authHeaders = await getMcpAuthHeaders(s.name, s.url);
    const mergedHeaders = { ...s.headers, ...authHeaders };
    return {
      type: s.transport,
      name: s.name,
      url: s.url,
      headers: Object.entries(mergedHeaders).map(([name, value]) => ({ name, value })),
    };
  }));
  return resolved.filter((server): server is McpServer => server != null);
}

/** Prefer authoritative stable options; synthesize legacy model and mode independently. */
function resolveConfigOptions(
  sessionResult: Pick<NewSessionResponse, "configOptions" | "models" | "modes">,
  internalId: string,
  logLabel: string,
): SessionConfigOption[] {
  let configOptions = sessionResult.configOptions ?? configBuffer.get(internalId) ?? [];
  if (!configOptions.length && sessionResult.configOptions == null) {
    const models = sessionResult.models;
    const modes = sessionResult.modes;
    configOptions = [
      ...(models?.availableModels.length ? [{ id: "model", name: "Model", category: "model", type: "select" as const,
        currentValue: models.currentModelId, options: models.availableModels.map(model => ({ value: model.modelId, name: model.name, description: model.description })) }] : []),
      ...(modes?.availableModes.length ? [{ id: "mode", name: "Mode", category: "mode", type: "select" as const,
        currentValue: modes.currentModeId, options: modes.availableModes.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })) }] : []),
    ];
  }
  configBuffer.set(internalId, configOptions);
  log(logLabel, `${configOptions.length} config options`);
  return configOptions;
}

interface AcpConnectionResult {
  proc: ChildProcess;
  connection: ClientSideConnection;
  pendingPermissions: Map<string, { resolve: (r: RequestPermissionResponse) => void; optionIds: Set<string> }>;
  internalId: string;
  supportsLoadSession: boolean;
  capabilities: AgentCapabilities;
  router: AcpEventRouter<SessionNotification["update"]>;
  authMethods: ACPAuthMethod[];
}

async function finalizePendingAcpSession(
  entry: ACPSessionEntry,
  sessionResult: NewSessionResponse,
  sourceServers: McpServerInput[],
  logLabel: string,
): Promise<ACPAuthenticateResult> {
  assertAcpProcessActive(entry.internalId);
  entry.acpSessionId = sessionResult.sessionId;
  entry.router.bind(sessionResult.sessionId);
  entry.pendingStartRequest = undefined;
  const configOptions = resolveConfigOptions(sessionResult, entry.internalId, logLabel);
  return {
    ok: true,
    sessionId: entry.internalId,
    agentSessionId: sessionResult.sessionId,
    agentName: entry.agentName,
    configOptions: configOptions as ACPAuthenticateResult["configOptions"],
    mcpStatuses: acpMcpStatuses(sourceServers),
  };
}

/**
 * Spawn an ACP agent process, create the ClientSideConnection, and initialize the protocol.
 * Shared by acp:start and acp:revive-session to avoid duplicating ~120 lines of boilerplate.
 */
async function createAcpConnection(
  agentDef: { binary: string; args?: string[]; env?: Record<string, string>; name: string },
  cwd: string,
  getMainWindow: () => BrowserWindow | null,
  logLabel: string,
  options: { internalId: string; runtimeLease?: SessionRuntimeLease; onSpawn?: (internalId: string, proc: ChildProcess) => void },
): Promise<AcpConnectionResult> {
  const acp = await getACP();
  options.runtimeLease?.assertActive();
  const { internalId } = options;
  let lastStderrError: string | undefined;
  const pendingPermissions = new Map<string, { resolve: (r: RequestPermissionResponse) => void; optionIds: Set<string> }>();

  const proc = spawnExecutable(agentDef.binary, agentDef.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env, ...agentDef.env },
  });
  acpProcesses.set(internalId, { process: proc, stopping: false, runtimeLease: options.runtimeLease, pendingPermissions });
  options.onSpawn?.(internalId, proc);

  // Process lifecycle handlers
  proc.on("error", (err) => {
    stopUsageSession(internalId);    taskRuntimeEvents.stop(internalId);
    log(logLabel, `ERROR: spawn failed: ${err.message}`);
    safeSend(getMainWindow, "acp:exit", {
      _sessionId: internalId,
      code: 1,
      error: `Failed to start agent: ${err.message}`,
    });
    // A failed signal is not evidence that an already spawned process exited.
    if (proc.pid) return;
    acpProcesses.delete(internalId);
    options.runtimeLease?.release();
    acpSessions.delete(internalId);
    unregisterMemorySession(internalId); revokeProjectAppAgentSession(internalId);
    configBuffer.delete(internalId);
    commandsBuffer.delete(internalId);
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const raw = chunk.toString().trim();
    log("ACP_STDERR", `session=${internalId.slice(0, 8)} ${raw}`);
    const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, "");
    const turnError = cleaned.match(/Unhandled error during turn:\s*(.+)$/)?.[1]?.trim();
    const lastLine = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    const parsed = turnError
      || (/\b(?:ERROR|Error|ServeError)\b/.test(cleaned) ? lastLine ?? cleaned : undefined);
    if (!parsed) return;
    lastStderrError = parsed;
    const entry = acpSessions.get(internalId);
    if (entry) entry.lastStderrError = parsed;
  });

  proc.on("exit", (code) => {
    stopUsageSession(internalId);    taskRuntimeEvents.stop(internalId);
    acpProcesses.delete(internalId);
    options.runtimeLease?.release();
    for (const permission of pendingPermissions.values()) permission.resolve({ outcome: { outcome: "cancelled" } });
    pendingPermissions.clear();
    unregisterMemorySession(internalId); revokeProjectAppAgentSession(internalId);
    configBuffer.delete(internalId);
    commandsBuffer.delete(internalId);
    // Guard: session may already be deleted by the "error" handler (ENOENT race)
    if (!acpSessions.has(internalId)) return;
    const entry = acpSessions.get(internalId)!;
    log("ACP_EXIT", `session=${internalId.slice(0, 8)} code=${code} total_events=${entry.eventCounter}`);
    for (const [, resolver] of entry.pendingPermissions) {
      resolver.resolve({ outcome: { outcome: "cancelled" } });
    }
    entry.pendingPermissions.clear();
    safeSend(getMainWindow, "acp:exit", { _sessionId: internalId, code });
    acpSessions.delete(internalId);
    unregisterMemorySession(internalId); revokeProjectAppAgentSession(internalId);
    configBuffer.delete(internalId);
    commandsBuffer.delete(internalId);
  });

  // Stream + connection setup
  const input = Writable.toWeb(proc.stdin!) as WritableStream;
  const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const router = new AcpEventRouter<SessionNotification["update"]>((update, acpSessionId) => {
      const entry = acpSessions.get(internalId);
      if (!entry || acpProcesses.get(internalId)?.stopping) return;
      entry.eventCounter++;
      const count = entry?.eventCounter ?? 0;
      const summary = summarizeUpdate(update);
      log("ACP_EVENT", `session=${internalId.slice(0, 8)} #${count} ${entry?.isReloading ? "[suppressed] " : ""}${summary}`);

      // Full dump for tool calls and tool results
      const eventKind = update?.sessionUpdate as string;
      if (!entry?.isReloading) observeAcpUpdate(internalId, update);
      if (eventKind === "tool_call" || eventKind === "tool_call_update") {
        log("ACP_EVENT_FULL", update);
      }

      // Buffer config options for late-subscribing renderer listeners
      if (eventKind === "config_option_update") {
        const configOptions = update.sessionUpdate === "config_option_update" ? update.configOptions : [];
        configBuffer.set(internalId, configOptions);
      }

      if (update.sessionUpdate === "current_mode_update") {
        configBuffer.set(internalId, (configBuffer.get(internalId) ?? []).map(option => option.category === "mode" ? { ...option, currentValue: update.currentModeId } : option));
      }

      // Buffer available commands for late-subscribing renderer listeners
      if (eventKind === "available_commands_update") {
        const commands = update.sessionUpdate === "available_commands_update" ? update.availableCommands : [];
        commandsBuffer.set(internalId, commands);
      }

      // During session/load, suppress history replay from reaching the renderer
      if (entry?.isReloading) return;

      safeSend(getMainWindow, "acp:event", {
        _sessionId: internalId,
        sessionId: acpSessionId,
        update,
      });

  });
  const connection = new acp.ClientSideConnection((_agent) => ({
    async sessionUpdate(params) {
      const capture = acpSessions.get(internalId)?.historyCapture;
      if (capture?.sessionId === params.sessionId) {
        capture.bytes += Buffer.byteLength(JSON.stringify(params));
        if (capture.events.length >= 10000 || capture.bytes > 32 * 1024 * 1024) capture.overflow = true;
        else capture.events.push(params);
        return;
      }
      router.receive(params.sessionId, params.update);
    },

    async requestPermission(params) {
      try { assertAcpProcessActive(internalId); }
      catch { return { outcome: { outcome: "cancelled" } }; }
      const acpSessionId = (params as { sessionId: string }).sessionId;
      const entry = acpSessions.get(internalId);

      if (!entry?.acpSessionId || acpSessionId !== entry.acpSessionId || entry.isReloading) {
        return { outcome: { outcome: "cancelled" } };
      }

      return new Promise<RequestPermissionResponse>((resolve) => {
        const requestId = crypto.randomUUID();
        const toolCall = (params as { toolCall: Record<string, unknown> }).toolCall;
        const opts = (params as { options: unknown[] }).options;
        pendingPermissions.set(requestId, { resolve, optionIds: new Set(params.options.map(option => option.optionId)) });
        taskRuntimeEvents.wait(internalId, "acp", requestId, "waiting_permission");

        log("ACP_PERMISSION_REQUEST", {
          session: internalId.slice(0, 8),
          requestId,
          tool: toolCall?.title,
          kind: toolCall?.kind,
          toolCallId: (toolCall?.toolCallId as string)?.slice(0, 12),
          optionCount: Array.isArray(opts) ? opts.length : 0,
        });

        safeSend(getMainWindow, "acp:permission_request", {
          _sessionId: internalId,
          requestId,
          sessionId: acpSessionId,
          toolCall,
          options: opts,
        });
      });
    },

    async readTextFile(params: { path?: string; uri?: string; line?: number | null; limit?: number | null; sessionId?: string }) {
      const utilityEntry = acpSessions.get(internalId);
      assertAcpProcessActive(internalId);
      if (!params.sessionId || utilityEntry?.acpSessionId !== params.sessionId || utilityEntry.isReloading) {
        throw new Error("Unknown or inactive ACP file-access session");
      }
      const { filePath, content } = await acpReadTextFile(params);
      log("ACP_FS", `readTextFile path=${filePath} line=${params.line ?? ""} limit=${params.limit ?? ""}`);
      log("ACP_FS", `readTextFile result len=${content.length}`);
      return { content };
    },
    async writeTextFile(params: { path?: string; uri?: string; content: string; sessionId?: string }) {
      const utilityEntry = acpSessions.get(internalId);
      assertAcpProcessActive(internalId);
      if (!params.sessionId || utilityEntry?.acpSessionId !== params.sessionId || utilityEntry.isReloading) {
        throw new Error("Unknown or inactive ACP file-access session");
      }
      const { filePath } = await acpWriteTextFile(params);
      log("ACP_FS", `writeTextFile path=${filePath} len=${params.content.length}`);
      return {};
    },
  }), stream);

  connection.signal.addEventListener("abort", () => {
    for (const pending of pendingPermissions.values()) pending.resolve({ outcome: { outcome: "cancelled" } });
    pendingPermissions.clear();
    if (acpProcesses.get(internalId)?.stopping) return;
    void stopForDeletion(internalId).catch(error => reportError("ACP_DISCONNECT_STOP_ERR", error, { sessionId: internalId }));
  }, { once: true });

  // Protocol initialization
  log(logLabel, `Initializing protocol...`);
  let initResult: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
  try {
    initResult = await withTimeout(connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: { name: "astradock", version: app.getVersion() },
    }), ACP_INIT_TIMEOUT_MS, `${agentDef.name} ACP initialize`, connection.signal);
  } catch (err) {
    if (lastStderrError) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message}: ${lastStderrError}`);
    }
    throw err;
  }
  assertAcpProcessActive(internalId);
  const capabilities = initResult.agentCapabilities ?? {};
  const supportsLoadSession = canRestoreAcpSession(capabilities);
  const authMethods = normalizeAcpAuthMethods((initResult as Record<string, unknown>).authMethods);
  log(logLabel, `Initialized protocol v${initResult.protocolVersion} for ${agentDef.name} (loadSession=${supportsLoadSession}, authMethods=${authMethods.length})`);

  return { proc, connection, pendingPermissions, internalId, supportsLoadSession, capabilities, router, authMethods };
}

export function register(getMainWindow: () => BrowserWindow | null): void {

  // Forward renderer-side ACP logs to main process log file
  ipcMain.on("acp:log", (_event, label: string, data: unknown) => {
    log(`ACP_UI:${label}`, data);
  });

  ipcMain.handle("acp:start", async (_event, options: { agentId: string; cwd: string; mcpServers?: McpServerInput[]; memoryContext?: { projectId: string }; source?: SessionResumeSource }) => {
    log("ACP_SPAWN", `acp:start called with agentId=${options.agentId} cwd=${options.cwd}`);

    const agentDef = resolveAgentDefinition(getAgent(options.agentId));
    if (!agentDef || agentDef.engine !== "acp") {
      const err = `Agent "${options.agentId}" not found or not an ACP agent`;
      log("ACP_SPAWN", `ERROR: ${err}`);
      return { error: err };
    }
    if (!agentDef.binary) {
      const err = `Agent "${options.agentId}" has no binary configured`;
      log("ACP_SPAWN", `ERROR: ${err}`);
      return { error: err };
    }

    let connResult: AcpConnectionResult | null = null;
    const runtimeId = crypto.randomUUID();
    let runtimeLease: SessionRuntimeLease | undefined;
    const analyticsProperties = buildAcpAnalyticsProperties(agentDef);
    try {
      if (options.source) runtimeLease = await getSessionRepository().bindRuntime(options.source, "acp", runtimeId, () => stopForDeletion(runtimeId));
      else if (options.memoryContext?.projectId) runtimeLease = await getSessionRepository().bindProjectRuntime(options.memoryContext.projectId, runtimeId, () => stopForDeletion(runtimeId));
      bindSessionTokenUsage(runtimeId, options.source?.runtimeSessionId);
      connResult = await createAcpConnection(
        agentDef as { binary: string; args?: string[]; env?: Record<string, string>; name: string },
        options.cwd,
        getMainWindow,
        "ACP_SPAWN",
        {
          internalId: runtimeId,
          runtimeLease,
          onSpawn: (internalId, proc) => { pendingStartProcess = { id: internalId, process: proc }; },
        },
      );
      const { proc, connection, pendingPermissions, internalId, supportsLoadSession, capabilities, router, authMethods } = connResult;

      if (options.memoryContext?.projectId) registerMemorySession(internalId, options.memoryContext.projectId, "acp");
      await registerProjectAppAgentSession(internalId, options.source?.projectId ?? options.memoryContext?.projectId, options.cwd);
      assertAcpProcessActive(internalId);
      const sourceServers = withProjectAppMcpServer(withHindsightMcpServers(withComputerUseMcpServer(options.mcpServers), internalId), internalId);
      const acpMcpServers = await buildAcpMcpServers(sourceServers);
      assertAcpProcessActive(internalId);
      const entry: ACPSessionEntry = {
        process: proc,
        connection,
        internalId,
        analyticsProperties,
        eventCounter: 0,
        pendingPermissions,
        cwd: options.cwd,
        projectId: options.source?.projectId ?? options.memoryContext?.projectId,
        supportsLoadSession, capabilities, router,
        agentId: agentDef.id, agentBinary: agentDef.binary, agentEnv: agentDef.env ?? {},
        agentName: agentDef.name,
        authMethods,
        pendingStartRequest: {
          cwd: options.cwd,
          mcpServers: acpMcpServers,
          sourceServers,
        },
        isReloading: false,
      };
      acpSessions.set(internalId, entry);

      log("ACP_SPAWN", `Creating new session with ${acpMcpServers.length} MCP server(s)...`);
      const sessionResult = await withTimeout(connection.newSession({
        cwd: options.cwd,
        mcpServers: acpMcpServers,
      }), ACP_START_TIMEOUT_MS, `${agentDef.name} ACP session/new`, connection.signal);
      assertAcpProcessActive(internalId);
      log("ACP_SPAWN", `Created session ${sessionResult.sessionId} for ${agentDef.name}`);

      // Startup succeeded — clear the pending tracker before returning
      if (pendingStartProcess?.id === runtimeId) pendingStartProcess = null;

      void captureEvent("session_created", { engine: "acp", ...analyticsProperties });

      return await finalizePendingAcpSession(entry, sessionResult, sourceServers, "ACP_SPAWN");
    } catch (err) {
      const authMethods = connResult?.authMethods ?? [];
      const authRequiredMethods = extractAuthRequired(err, authMethods);
      const runtime = acpProcesses.get(runtimeId);
      if (authRequiredMethods && connResult && runtime && !runtime.stopping) {
        let active = true;
        try { runtimeLease?.assertActive(); } catch { active = false; }
        if (active) {
          if (pendingStartProcess?.id === runtimeId) pendingStartProcess = null;
          const entry = acpSessions.get(connResult.internalId);
          if (entry) entry.authMethods = authRequiredMethods;
          return {
            authRequired: true as const,
            sessionId: connResult.internalId,
            agentName: agentDef.name,
            authMethods: authRequiredMethods,
          };
        }
      }

      // Check if the user intentionally aborted the start (stop button during download)
      const wasAborted = pendingStartProcess?.id === runtimeId && pendingStartProcess.aborted === true;
      if (pendingStartProcess?.id === runtimeId) pendingStartProcess = null;
      try { await stopForDeletion(runtimeId); }
      catch (stopError) { reportError("ACP_START_STOP_ERR", stopError, { engine: "acp", sessionId: runtimeId }); }
      if (!acpProcesses.has(runtimeId)) runtimeLease?.release();

      if (wasAborted) {
        log("ACP_SPAWN", `Aborted by user`);
        return { cancelled: true };
      }

      const msg = reportError("ACP_SPAWN", err, { engine: "acp", ...analyticsProperties });
      return { error: msg };
    }
  });

  ipcMain.handle("acp:authenticate", async (_event, { sessionId, methodId }: { sessionId: string; methodId: string }) => {
    const session = acpSessions.get(sessionId);
    if (!session) {
      return { error: "ACP session not found." };
    }
    if (!session.pendingStartRequest) {
      return { error: "ACP session does not need authentication." };
    }

    try {
      await withTimeout(
        session.connection.authenticate({ methodId }),
        ACP_AUTH_TIMEOUT_MS,
        `${session.agentName} ACP authenticate(${methodId})`,
        session.connection.signal,
      );
      assertAcpProcessActive(sessionId);

      const sessionResult = await withTimeout(session.connection.newSession({
        cwd: session.pendingStartRequest.cwd,
        mcpServers: session.pendingStartRequest.mcpServers,
      }), ACP_START_TIMEOUT_MS, `${session.agentName} ACP session/new after authenticate`, session.connection.signal);

      const finalized = await finalizePendingAcpSession(
        session,
        sessionResult,
        session.pendingStartRequest.sourceServers,
        "ACP_AUTH",
      );

      return finalized;
    } catch (err) {
      const authRequiredMethods = extractAuthRequired(err, session.authMethods);
      if (authRequiredMethods) {
        session.authMethods = authRequiredMethods;
        return {
          authRequired: true,
          sessionId,
          agentName: session.agentName,
          authMethods: authRequiredMethods,
          error: buildAuthRequiredError(session.agentName, authRequiredMethods),
        };
      }

      const message = extractErrorMessage(err);
      const guidance = getAuthGuidance(session.agentName, session.authMethods);
      const error = guidance ? `${message} ${guidance}` : message;
      log("ACP_AUTH", error);
      return { error };
    }
  });

  // Revive a dead ACP session after app restart.
  // Spawns a fresh agent process and calls session/load (if supported) to restore context,
  // or falls back to newSession (fresh context, UI messages already restored from disk).
  ipcMain.handle("acp:revive-session", async (_event, options: {
    agentId: string;
    cwd: string;
    agentSessionId?: string; // ACP-side session ID from previous run
    mcpServers?: McpServerInput[];
    memoryContext?: { projectId: string };
    source: SessionResumeSource;
  }) => {
    log("ACP_REVIVE", `agentId=${options.agentId} agentSessionId=${options.agentSessionId?.slice(0, 12) ?? "none"} cwd=${options.cwd}`);

    const agentDef = resolveAgentDefinition(getAgent(options.agentId));
    if (!agentDef || agentDef.engine !== "acp" || !agentDef.binary) {
      return { error: `Agent "${options.agentId}" not found or not an ACP agent` };
    }

    const runtimeId = crypto.randomUUID();
    let runtimeLease: SessionRuntimeLease | undefined;
    const analyticsProperties = buildAcpAnalyticsProperties(agentDef);
    try {
      runtimeLease = await getSessionRepository().bindRuntime(options.source, "acp", runtimeId, () => stopForDeletion(runtimeId));
      bindSessionTokenUsage(runtimeId, options.source.runtimeSessionId);
      const connResult = await createAcpConnection(
        agentDef as { binary: string; args?: string[]; env?: Record<string, string>; name: string },
        options.cwd,
        getMainWindow,
        "ACP_REVIVE",
        { internalId: runtimeId, runtimeLease },
      );
      const { proc, connection, pendingPermissions, internalId, supportsLoadSession, capabilities, router, authMethods } = connResult;

      if (options.memoryContext?.projectId) registerMemorySession(internalId, options.memoryContext.projectId, "acp");
      await registerProjectAppAgentSession(internalId, options.source.projectId, options.cwd);
      assertAcpProcessActive(internalId);
      const sourceServers = withProjectAppMcpServer(withHindsightMcpServers(withComputerUseMcpServer(options.mcpServers), internalId), internalId);
      const acpMcpServers = await buildAcpMcpServers(sourceServers);
      assertAcpProcessActive(internalId);

      let acpSessionId: string;
      let usedLoad = false;
      let configOptions: SessionConfigOption[] = [];

      if (supportsLoadSession && options.agentSessionId) {
        // Restore full context — suppress history replay from reaching the renderer
        const entry: ACPSessionEntry = { process: proc, connection, acpSessionId: options.agentSessionId, internalId, analyticsProperties, eventCounter: 0, pendingPermissions, cwd: options.cwd, projectId: options.source.projectId, supportsLoadSession, capabilities, router, agentId: agentDef.id, agentBinary: agentDef.binary, agentEnv: agentDef.env ?? {}, agentName: agentDef.name, authMethods, isReloading: true };
        acpSessions.set(internalId, entry);
        router.bind(options.agentSessionId);
        const restored = await withTimeout(restoreAcpSession(connection, capabilities, { sessionId: options.agentSessionId, cwd: options.cwd, mcpServers: acpMcpServers }), ACP_START_TIMEOUT_MS, `${agentDef.name} ACP session/restore`, connection.signal);
        const loadResult = restored.result;
        assertAcpProcessActive(internalId);
        entry.isReloading = false;
        acpSessionId = options.agentSessionId;
        usedLoad = true;
        configOptions = resolveConfigOptions(loadResult, internalId, "ACP_REVIVE");
        log("ACP_REVIVE", `loadSession OK, session=${acpSessionId.slice(0, 12)} configOptions=${configOptions.length}`);
      } else {
        // Fall back to fresh session — UI messages already restored from disk
        const sessionResult = await withTimeout(connection.newSession({ cwd: options.cwd, mcpServers: acpMcpServers }), ACP_START_TIMEOUT_MS, `${agentDef.name} ACP session/new`, connection.signal);
        assertAcpProcessActive(internalId);
        acpSessionId = sessionResult.sessionId;
        const entry: ACPSessionEntry = { process: proc, connection, acpSessionId, internalId, analyticsProperties, eventCounter: 0, pendingPermissions, cwd: options.cwd, projectId: options.source.projectId, supportsLoadSession, capabilities, router, agentId: agentDef.id, agentBinary: agentDef.binary, agentEnv: agentDef.env ?? {}, agentName: agentDef.name, authMethods, isReloading: false };
        acpSessions.set(internalId, entry);
        router.bind(acpSessionId);
        configOptions = resolveConfigOptions(sessionResult, internalId, "ACP_REVIVE");
        log("ACP_REVIVE", `newSession fallback, session=${acpSessionId.slice(0, 12)}`);
      }

      const mcpStatuses = acpMcpStatuses(sourceServers);
      void captureEvent("session_revived", { engine: "acp", success: true, ...analyticsProperties });
      return { sessionId: internalId, agentSessionId: acpSessionId, usedLoad, configOptions, mcpStatuses };
    } catch (err) {
      try { await stopForDeletion(runtimeId); }
      catch (stopError) { reportError("ACP_REVIVE_STOP_ERR", stopError, { engine: "acp", sessionId: runtimeId }); }
      if (!acpProcesses.has(runtimeId)) runtimeLease?.release();
      const msg = reportError("ACP_REVIVE", err, { engine: "acp", ...analyticsProperties });
      return { error: msg };
    }
  });

  ipcMain.handle("acp:prompt", async (_event, { sessionId, text, images }: { sessionId: string; text: string; images?: Array<{ data: string; mediaType: string }> }) => {
    const session = acpSessions.get(sessionId);
    if (!session) {
      log("ACP_SEND", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Session not found" };
    }
    if (!session.acpSessionId) {
      return { error: buildAuthRequiredError(session.agentName, session.authMethods) };
    }
    if (session.isPrompting || session.isReloading) return { error: "ACP session is busy" };
    if (images?.length && !session.capabilities.promptCapabilities?.image) return { error: "Agent does not support image prompts" };
    session.isPrompting = true;
    session.turnCancelled = false;
    let finishPrompt!: () => void;
    session.promptFinished = new Promise<void>(resolve => { finishPrompt = resolve; });
    const acpSessionId = session.acpSessionId;

    let memory: Awaited<ReturnType<typeof beforeMemorySend>>;
    try { memory = await beforeMemorySend(sessionId, text); }
    catch (error) { session.isPrompting = false; finishPrompt(); return { error: reportError("ACP_MEMORY_ERR", error, { sessionId }) }; }
    log("ACP_SEND", `session=${sessionId.slice(0, 8)} text=${text.slice(0, 500)} images=${images?.length ?? 0}`);

    const prompt: ContentBlock[] = [];
    if (images) {
      for (const img of images) {
        prompt.push({ type: "image", data: img.data, mimeType: img.mediaType });
      }
    }
    prompt.push({ type: "text", text: memory.text });

    const usageTurnId = crypto.randomUUID();
    try {
      assertAcpProcessActive(sessionId);
      beginUsageTurn(sessionId, usageTurnId);
      taskRuntimeEvents.publish(sessionId, "acp", "running");
      session.lastStderrError = undefined;
      const result = await session.connection.prompt({
        sessionId: acpSessionId,
        prompt,
      });

      log("ACP_TURN_COMPLETE", `session=${sessionId.slice(0, 8)} stopReason=${result.stopReason} usage=${JSON.stringify(result.usage ?? null)}`);
      recordAcpTokenUsage(usageTurnId, result.usage, sessionId);
      void completeMemoryTurn(sessionId);
      finishAcpTaskTurn(sessionId, session.turnCancelled ? "cancelled" : result.stopReason);

      safeSend(getMainWindow,"acp:turn_complete", {
        _sessionId: sessionId,
        stopReason: session.turnCancelled ? "cancelled" : result.stopReason,
        usage: result.usage,
      });

      return { ok: true };
    } catch (err) {
      const msg = extractErrorMessage(err);
      const surfacedError = msg === "Internal error" && session.lastStderrError ? session.lastStderrError : msg;
      reportError("ACP_PROMPT_ERR", err, { engine: "acp", sessionId, surfacedError });
      if (taskRuntimeEvents.get(sessionId)?.status !== "interrupted") taskRuntimeEvents.publish(sessionId, "acp", "failed", surfacedError);
      return { error: surfacedError };
    } finally {
      session.isPrompting = false;
      finishPrompt();
      endUsageTurn(sessionId, usageTurnId);
    }
  });

  // Abort an in-flight acp:start (e.g. user clicked stop during npx download).
  // Marks pendingStartProcess as aborted and kills the process — the acp:start
  // catch block will detect `.aborted` and return { cancelled: true }.
  ipcMain.handle("acp:abort-pending-start", async () => {
    if (!pendingStartProcess) {
      log("ACP_ABORT_START", "No pending start to abort");
      return { ok: false };
    }
    log("ACP_ABORT_START", `Aborting start id=${pendingStartProcess.id.slice(0, 8)} pid=${pendingStartProcess.process.pid}`);
    pendingStartProcess.aborted = true;
    try { await stopForDeletion(pendingStartProcess.id); return { ok: true }; }
    catch (error) { return { error: reportError("ACP_ABORT_ERR", error, { engine: "acp" }) }; }
  });

  ipcMain.handle("acp:stop", async (_event, sessionId: string) => {
    try { await stopForDeletion(sessionId); return { ok: true }; }
    catch (error) { return { error: reportError("ACP_STOP_ERR", error, { engine: "acp", sessionId }) }; }
  });

  // Reload an existing ACP session with a new MCP server list using session/load.
  // Generic agents can reload in place. OpenCode requires restart to remove stale MCP registrations.
  // Returns { ok: true, supportsLoad: true } if successful, { supportsLoad: false } if not supported.
  ipcMain.handle("acp:reload-session", async (_event, { sessionId, mcpServers, cwd }: {
    sessionId: string;
    mcpServers?: McpServerInput[];
    cwd?: string;
  }) => {
    const session = acpSessions.get(sessionId);
    if (!session) {
      log("ACP_RELOAD", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Session not found" };
    }
    if (session.agentId === "opencode") return { supportsLoad: false, requiresRestart: true };
    if (!session.supportsLoadSession) {
      log("ACP_RELOAD", `session=${sessionId.slice(0, 8)} agent does not support session/load, falling back to restart`);
      return { supportsLoad: false };
    }
    if (!session.acpSessionId) {
      return { error: buildAuthRequiredError(session.agentName, session.authMethods), supportsLoad: true };
    }
    const acpSessionId = session.acpSessionId;

    if (session.isPrompting || session.isReloading) return { error: "ACP session is busy", supportsLoad: true };
    const nextCwd = cwd ?? session.cwd;
    log("ACP_RELOAD", `session=${sessionId.slice(0, 8)} calling loadSession with ${mcpServers?.length ?? 0} MCP server(s) cwd=${nextCwd}`);

    try {
      const projectId = session.projectId;
      revokeProjectAppAgentSession(sessionId);
      await registerProjectAppAgentSession(sessionId, projectId, nextCwd);
      const acpMcpServers = await buildAcpMcpServers(withProjectAppMcpServer(withHindsightMcpServers(withComputerUseMcpServer(mcpServers), sessionId), sessionId));
      // Suppress history replay notifications so the renderer doesn't get duplicates
      assertAcpProcessActive(sessionId);
      session.isReloading = true;
      try {
        const restored = await withTimeout(restoreAcpSession(session.connection, session.capabilities, {
          sessionId: acpSessionId,
          cwd: nextCwd,
          mcpServers: acpMcpServers,
        }), ACP_START_TIMEOUT_MS, `${session.agentName} ACP session/restore`, session.connection.signal);
        const configOptions = resolveConfigOptions(restored.result, sessionId, "ACP_RELOAD");
        safeSend(getMainWindow, "acp:event", { _sessionId: sessionId, sessionId: acpSessionId, update: { sessionUpdate: "config_option_update", configOptions } });
      } finally {
        // Always reset — even if loadSession throws or process crashes
        if (acpSessions.has(sessionId)) {
          acpSessions.get(sessionId)!.isReloading = false;
        }
      }
      assertAcpProcessActive(sessionId);
      session.cwd = nextCwd;
      log("ACP_RELOAD", `session=${sessionId.slice(0, 8)} loadSession OK`);
      return { ok: true, supportsLoad: true, mcpStatuses: acpMcpStatuses(mcpServers ?? []) };
    } catch (err) {
      const msg = reportError("ACP_RELOAD_ERR", err, { engine: "acp", sessionId });
      return { error: msg, supportsLoad: true };
    }
  });

  ipcMain.handle("acp:cancel", async (_event, sessionId: string) => {
    cancelProjectAppAgentPermissions(sessionId);
    const session = acpSessions.get(sessionId);
    if (!session) {
      log("ACP_CANCEL", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Session not found" };
    }

    session.turnCancelled = true;
    taskRuntimeEvents.publish(sessionId, "acp", "interrupted");
    const pendingCount = session.pendingPermissions.size;
    log("ACP_CANCEL", `session=${sessionId.slice(0, 8)} cancelling (${pendingCount} pending permissions)`);

    for (const [, resolver] of session.pendingPermissions) {
      resolver.resolve({ outcome: { outcome: "cancelled" } });
    }
    session.pendingPermissions.clear();
    if (!session.acpSessionId) {
      return { ok: true };
    }
    const acpSessionId = session.acpSessionId;

    try {
      await withTimeout(session.connection.cancel({ sessionId: acpSessionId }), 5000, "ACP cancel", session.connection.signal);
      if (session.promptFinished) {
        try { await withTimeout(session.promptFinished, 5000, "ACP prompt cancellation"); }
        catch { await stopForDeletion(sessionId); }
      }
      log("ACP_CANCEL", `session=${sessionId.slice(0, 8)} acknowledged`);
      return { ok: true };
    } catch (err) {
      const msg = reportError("ACP_CANCEL_ERR", err, { engine: "acp", sessionId });
      try { await stopForDeletion(sessionId); } catch (stopError) { reportError("ACP_CANCEL_STOP_ERR", stopError, { sessionId }); }
      return { error: msg };
    }
  });

  ipcMain.handle("acp:set-config", async (_event, { sessionId, configId, value }: { sessionId: string; configId: string; value: string }) => {
    const session = acpSessions.get(sessionId);
    if (!session) {
      log("ACP_CONFIG", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Session not found" };
    }
    if (!session.acpSessionId) {
      return { error: buildAuthRequiredError(session.agentName, session.authMethods) };
    }
    const acpSessionId = session.acpSessionId;
    log("ACP_CONFIG", `session=${sessionId.slice(0, 8)} setting ${configId}=${value}`);
    try {
      return await configQueue.run(sessionId, async () => {
        assertAcpProcessActive(sessionId);
      const configOptions = await withTimeout(setAcpConfig(session.connection,
        { sessionId: acpSessionId, configId, value }, configBuffer.get(sessionId) ?? []),
        ACP_START_TIMEOUT_MS, "ACP configuration", session.connection.signal);
      configBuffer.set(sessionId, configOptions);
      safeSend(getMainWindow, "acp:event", { _sessionId: sessionId, sessionId: acpSessionId, update: { sessionUpdate: "config_option_update", configOptions } });
      return { configOptions };
      });
    } catch (err) {
      const errMsg = reportError("ACP_CONFIG_ERR", err, { engine: "acp", sessionId, configId });
      return { error: errMsg };
    }
  });

  ipcMain.handle("acp:get-capabilities", (_event, sessionId: string) => {
    const session = acpSessions.get(sessionId);
    return { capabilities: session?.capabilities ?? {}, agentName: session?.agentName };
  });

  ipcMain.handle("acp:list-sessions", async (_event, { sessionId, cursor }: { sessionId: string; cursor?: string }) => {
    const session = acpSessions.get(sessionId);
    if (!session?.capabilities.sessionCapabilities?.list) return { error: "Agent does not support session listing" };
    try {
      assertAcpProcessActive(sessionId);
      return await withTimeout(session.connection.unstable_listSessions({ cwd: session.cwd, cursor }), ACP_START_TIMEOUT_MS, "ACP session/list", session.connection.signal);
    } catch (error) { return { error: reportError("ACP_LIST_ERR", error, { sessionId }) }; }
  });

  ipcMain.handle("acp:read-session", async (_event, { sessionId, agentSessionId }: { sessionId: string; agentSessionId: string }) => {
    const session = acpSessions.get(sessionId);
    if (!session?.capabilities.loadSession) return { error: "Agent does not support history loading" };
    if (session.isPrompting || session.isReloading) return { error: "ACP session is busy" };
    session.isReloading = true;
    const capture = { sessionId: agentSessionId, events: [] as SessionNotification[], bytes: 0, overflow: false };
    session.historyCapture = capture;
    try {
      assertAcpProcessActive(sessionId);
      await withTimeout(session.connection.loadSession({ sessionId: agentSessionId, cwd: session.cwd, mcpServers: [] }), ACP_START_TIMEOUT_MS, "ACP history", session.connection.signal);
      if (capture.overflow) throw new Error("History exceeds the import limit; refusing an incomplete import");
      return { events: capture.events };
    } catch (error) { return { error: reportError("ACP_HISTORY_ERR", error, { sessionId }) }; }
    finally {
      if (agentSessionId !== session.acpSessionId) {
        try { await withTimeout(closeAcpSession(session.connection, session.capabilities, agentSessionId), 1000, "ACP history close", session.connection.signal); }
        catch (error) { reportError("ACP_HISTORY_CLOSE_ERR", error, { sessionId }); }
      }
      session.historyCapture = undefined; session.isReloading = false;
    }
  });

  ipcMain.handle("acp:fork-session", async (_event, { sessionId }: { sessionId: string }) => {
    const session = acpSessions.get(sessionId);
    if (!session?.acpSessionId || !session.capabilities.sessionCapabilities?.fork) return { error: "Agent does not support session fork" };
    if (session.isPrompting || session.isReloading) return { error: "ACP session is busy" };
    session.isReloading = true;
    try {
      assertAcpProcessActive(sessionId);
      const fork = await withTimeout(session.connection.unstable_forkSession({ sessionId: session.acpSessionId, cwd: session.cwd, mcpServers: [] }), ACP_START_TIMEOUT_MS, "ACP session/fork", session.connection.signal);
      // Persistent history remains; only detach the transient fork from this connection.
      await withTimeout(closeAcpSession(session.connection, session.capabilities, fork.sessionId), 1000, "ACP fork close", session.connection.signal);
      return { agentSessionId: fork.sessionId, cwd: session.cwd };
    } catch (error) { return { error: reportError("ACP_FORK_ERR", error, { sessionId }) }; }
    finally { session.isReloading = false; }
  });

  // Retrieve buffered config options — used by renderer when useACP first mounts
  // and may have missed config_option_update events during DRAFT→active transition
  ipcMain.handle("acp:get-config-options", async (_event, sessionId: string) => {
    return { configOptions: configBuffer.get(sessionId) ?? [] };
  });

  // Retrieve buffered available commands — same pattern as config options
  ipcMain.handle("acp:get-available-commands", async (_event, sessionId: string) => {
    return { commands: commandsBuffer.get(sessionId) ?? [] };
  });

  ipcMain.handle("acp:permission_response", async (_event, { sessionId, requestId, optionId }: { sessionId: string; requestId: string; optionId: string }) => {
    const session = acpSessions.get(sessionId);
    if (!session) {
      log("ACP_PERMISSION_RESPONSE", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Session not found" };
    }

    const resolver = session.pendingPermissions.get(requestId);
    if (!resolver) {
      log("ACP_PERMISSION_RESPONSE", `ERROR: session=${sessionId.slice(0, 8)} no pending permission for requestId=${requestId}`);
      return { error: "No pending permission" };
    }

    log("ACP_PERMISSION_RESPONSE", `session=${sessionId.slice(0, 8)} requestId=${requestId} optionId=${optionId}`);
    if (!resolver.optionIds.has(optionId)) return { error: "Invalid ACP permission option" };
    resolver.resolve({ outcome: { outcome: "selected", optionId } });
    session.pendingPermissions.delete(requestId);
    taskRuntimeEvents.resolve(sessionId, requestId);
    return { ok: true };
  });
}

/** Stop all ACP sessions (called on app quit). Idempotent. */
export async function stopAll(): Promise<void> {
  const results = await Promise.allSettled([...acpProcesses.keys()].map(sessionId => stopForDeletion(sessionId)));
  for (const result of results) if (result.status === "rejected") reportError("ACP_STOP_ERR", result.reason);
}
