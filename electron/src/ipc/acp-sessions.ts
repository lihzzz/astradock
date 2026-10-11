import { BrowserWindow, ipcMain } from "electron";
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
  pendingPermissions: Map<string, { resolve: (response: RequestPermissionResponse) => void }>;
  cwd: string;
  projectId: string | undefined;
  supportsLoadSession: boolean;
  agentName: string;
  authMethods: ACPAuthMethod[];
  pendingStartRequest?: {
    cwd: string;
    mcpServers: McpServer[];
    sourceServers: McpServerInput[];
  };
  /** True while session/load is in-flight — suppresses history replay notifications from reaching the renderer */
  isReloading: boolean;
  /** ACP-side session IDs for ephemeral utility prompts (title gen, commit msg) */
  utilitySessionIds?: Set<string>;
  /** Text accumulator buffers for utility sessions, keyed by ACP sessionId */
  utilityTextBuffers?: Map<string, string>;
  /** Refusal reason for a utility session that attempted a tool call. */
  utilityErrors?: Map<string, string>;
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
  await stopProcessAndWait(runtime.process);
  acpSessions.delete(sessionId);
  unregisterMemorySession(sessionId); revokeProjectAppAgentSession(sessionId);
  configBuffer.delete(sessionId);
  commandsBuffer.delete(sessionId);
}

// Buffer latest config options per session — survives the renderer's DRAFT→active transition
// where events arrive before useACP's listener is subscribed
const configBuffer = new Map<string, unknown[]>();

// Buffer latest available commands per session — same lifecycle as configBuffer
const commandsBuffer = new Map<string, unknown[]>();

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

/** Merge configOptions from session response, event buffer, and unstable models API. */
function resolveConfigOptions(
  sessionResult: { configOptions?: unknown[] | null; models?: unknown },
  internalId: string,
  logLabel: string,
): unknown[] {
  const fromResponse = (sessionResult.configOptions ?? []) as unknown[];
  const fromEvents = (configBuffer.get(internalId) ?? []) as unknown[];
  let configOptions = fromResponse.length ? fromResponse : fromEvents;

  // Fallback: synthesize config option from unstable models API
  const models = (sessionResult as Record<string, unknown>).models as { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string; description?: string }> } | null;
  if (configOptions.length === 0 && models?.availableModels?.length) {
    log(logLabel, `No configOptions, synthesizing from ${models.availableModels.length} models (unstable API)`);
    configOptions = [{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: models.currentModelId ?? models.availableModels[0].modelId,
      options: models.availableModels.map(m => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? null,
      })),
    }];
  }

  if (configOptions.length) configBuffer.set(internalId, configOptions);
  log(logLabel, `${configOptions.length} config options (response=${fromResponse.length}, buffered=${fromEvents.length}, models=${models?.availableModels?.length ?? 0})`);
  return configOptions;
}

interface AcpConnectionResult {
  proc: ChildProcess;
  connection: ClientSideConnection;
  pendingPermissions: Map<string, { resolve: (r: RequestPermissionResponse) => void }>;
  internalId: string;
  supportsLoadSession: boolean;
  authMethods: ACPAuthMethod[];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", closed); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const closed = () => fail(new Error(`${stage}: connection closed`));
    const timer = setTimeout(() => fail(new Error(`${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
    signal?.addEventListener("abort", closed, { once: true });
    if (signal?.aborted) closed();
    promise.then((value) => { cleanup(); resolve(value); }, fail);
  });
}

function deriveMcpStatuses(servers: McpServerInput[]): Array<{ name: string; status: "connected" }> {
  return servers.map((server) => ({
    name: server.name,
    status: "connected" as const,
  }));
}

async function finalizePendingAcpSession(
  entry: ACPSessionEntry,
  sessionResult: { sessionId: string; configOptions?: unknown[] | null; models?: unknown },
  sourceServers: McpServerInput[],
  logLabel: string,
): Promise<ACPAuthenticateResult> {
  assertAcpProcessActive(entry.internalId);
  entry.acpSessionId = sessionResult.sessionId;
  entry.pendingStartRequest = undefined;
  const configOptions = resolveConfigOptions(sessionResult, entry.internalId, logLabel);
  return {
    ok: true,
    sessionId: entry.internalId,
    agentSessionId: sessionResult.sessionId,
    agentName: entry.agentName,
    configOptions: configOptions as ACPAuthenticateResult["configOptions"],
    mcpStatuses: deriveMcpStatuses(sourceServers),
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
  const pendingPermissions = new Map<string, { resolve: (r: RequestPermissionResponse) => void }>();

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

  const connection = new acp.ClientSideConnection((_agent) => ({
    async sessionUpdate(params: Record<string, unknown>) {
      const update = (params as { update: Record<string, unknown> }).update;
      const acpSessionId = (params as { sessionId: string }).sessionId;
      const entry = acpSessions.get(internalId);

      // Utility session events: accumulate text, skip renderer forwarding
      if (entry?.utilitySessionIds?.has(acpSessionId)) {
        const eventKind = (update as { sessionUpdate: string }).sessionUpdate;
        if (eventKind === "tool_call" || eventKind === "tool_call_update") {
          if (!entry.utilityErrors) entry.utilityErrors = new Map();
          entry.utilityErrors.set(acpSessionId, "ACP utility sessions cannot execute tools");
          void entry.connection.cancel({ sessionId: acpSessionId }).catch(() => {});
          return;
        }
        if (eventKind === "agent_message_chunk") {
          const text = (update as { content?: { text?: string } }).content?.text ?? "";
          if (text && entry.utilityTextBuffers) {
            const current = entry.utilityTextBuffers.get(acpSessionId) ?? "";
            entry.utilityTextBuffers.set(acpSessionId, current + text);
          }
        }
        return;
      }

      if (entry) entry.eventCounter++;
      const count = entry?.eventCounter ?? 0;
      const summary = summarizeUpdate(update);
      log("ACP_EVENT", `session=${internalId.slice(0, 8)} #${count} ${entry?.isReloading ? "[suppressed] " : ""}${summary}`);

      // Full dump for tool calls and tool results
      const eventKind = update?.sessionUpdate as string;
      observeAcpUpdate(internalId, update);
      if (eventKind === "tool_call" || eventKind === "tool_call_update") {
        log("ACP_EVENT_FULL", update);
      }

      // Buffer config options for late-subscribing renderer listeners
      if (eventKind === "config_option_update") {
        const configOptions = (update as { configOptions: unknown[] }).configOptions;
        configBuffer.set(internalId, configOptions);
      }

      // Buffer available commands for late-subscribing renderer listeners
      if (eventKind === "available_commands_update") {
        const commands = (update as { availableCommands: unknown[] }).availableCommands;
        commandsBuffer.set(internalId, commands);
      }

      // During session/load, suppress history replay from reaching the renderer
      if (entry?.isReloading) return;

      safeSend(getMainWindow, "acp:event", {
        _sessionId: internalId,
        sessionId: acpSessionId,
        update,
      });
    },

    async requestPermission(params: Record<string, unknown>) {
      try { assertAcpProcessActive(internalId); }
      catch { return { outcome: { outcome: "cancelled" } }; }
      const acpSessionId = (params as { sessionId: string }).sessionId;
      const entry = acpSessions.get(internalId);

      // Auto-deny permission requests for utility sessions
      if (entry?.utilitySessionIds?.has(acpSessionId)) {
        log("ACP_UTILITY", `Auto-denying permission for utility session ${acpSessionId.slice(0, 12)}`);
        const options = (params as { options: Array<{ optionId: string; kind: string }> }).options;
        const rejectOption = options.find(o => o.kind === "reject_once") ?? options[options.length - 1];
        return { outcome: { outcome: "selected", optionId: rejectOption?.optionId ?? "reject" } };
      }

      return new Promise<RequestPermissionResponse>((resolve) => {
        const requestId = crypto.randomUUID();
        const toolCall = (params as { toolCall: Record<string, unknown> }).toolCall;
        const opts = (params as { options: unknown[] }).options;
        pendingPermissions.set(requestId, { resolve });
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
      if (params.sessionId && utilityEntry?.utilitySessionIds?.has(params.sessionId)) {
        throw new Error("ACP utility sessions cannot access files");
      }
      const { filePath, content } = await acpReadTextFile(params);
      log("ACP_FS", `readTextFile path=${filePath} line=${params.line ?? ""} limit=${params.limit ?? ""}`);
      log("ACP_FS", `readTextFile result len=${content.length}`);
      return { content };
    },
    async writeTextFile(params: { path?: string; uri?: string; content: string; sessionId?: string }) {
      const utilityEntry = acpSessions.get(internalId);
      if (params.sessionId && utilityEntry?.utilitySessionIds?.has(params.sessionId)) {
        throw new Error("ACP utility sessions cannot access files");
      }
      const { filePath } = await acpWriteTextFile(params);
      log("ACP_FS", `writeTextFile path=${filePath} len=${params.content.length}`);
      return {};
    },
  }), stream);

  // Protocol initialization
  log(logLabel, `Initializing protocol...`);
  let initResult: Awaited<ReturnType<ClientSideConnection["initialize"]>>;
  try {
    initResult = await withTimeout(connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
    }), ACP_INIT_TIMEOUT_MS, `${agentDef.name} ACP initialize`, connection.signal);
  } catch (err) {
    if (lastStderrError) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${message}: ${lastStderrError}`);
    }
    throw err;
  }
  assertAcpProcessActive(internalId);
  const supportsLoadSession = initResult.agentCapabilities?.loadSession === true;
  const authMethods = normalizeAcpAuthMethods((initResult as Record<string, unknown>).authMethods);
  log(logLabel, `Initialized protocol v${initResult.protocolVersion} for ${agentDef.name} (loadSession=${supportsLoadSession}, authMethods=${authMethods.length})`);

  return { proc, connection, pendingPermissions, internalId, supportsLoadSession, authMethods };
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
      const { proc, connection, pendingPermissions, internalId, supportsLoadSession, authMethods } = connResult;

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
        supportsLoadSession,
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
      const connResult = await createAcpConnection(
        agentDef as { binary: string; args?: string[]; env?: Record<string, string>; name: string },
        options.cwd,
        getMainWindow,
        "ACP_REVIVE",
        { internalId: runtimeId, runtimeLease },
      );
      const { proc, connection, pendingPermissions, internalId, supportsLoadSession, authMethods } = connResult;

      if (options.memoryContext?.projectId) registerMemorySession(internalId, options.memoryContext.projectId, "acp");
      await registerProjectAppAgentSession(internalId, options.source.projectId, options.cwd);
      assertAcpProcessActive(internalId);
      const sourceServers = withProjectAppMcpServer(withHindsightMcpServers(withComputerUseMcpServer(options.mcpServers), internalId), internalId);
      const acpMcpServers = await buildAcpMcpServers(sourceServers);
      assertAcpProcessActive(internalId);

      let acpSessionId: string;
      let usedLoad = false;
      let configOptions: unknown[] = [];

      if (supportsLoadSession && options.agentSessionId) {
        // Restore full context — suppress history replay from reaching the renderer
        const entry: ACPSessionEntry = { process: proc, connection, acpSessionId: options.agentSessionId, internalId, analyticsProperties, eventCounter: 0, pendingPermissions, cwd: options.cwd, projectId: options.source.projectId, supportsLoadSession, agentName: agentDef.name, authMethods, isReloading: true };
        acpSessions.set(internalId, entry);
        const loadResult = await withTimeout(connection.loadSession({ sessionId: options.agentSessionId, cwd: options.cwd, mcpServers: acpMcpServers }), ACP_START_TIMEOUT_MS, `${agentDef.name} ACP session/load`, connection.signal);
        assertAcpProcessActive(internalId);
        entry.isReloading = false;
        acpSessionId = options.agentSessionId;
        usedLoad = true;
        configOptions = (loadResult.configOptions ?? configBuffer.get(internalId) ?? []) as unknown[];
        if (configOptions.length) configBuffer.set(internalId, configOptions);
        log("ACP_REVIVE", `loadSession OK, session=${acpSessionId.slice(0, 12)} configOptions=${configOptions.length}`);
      } else {
        // Fall back to fresh session — UI messages already restored from disk
        const sessionResult = await withTimeout(connection.newSession({ cwd: options.cwd, mcpServers: acpMcpServers }), ACP_START_TIMEOUT_MS, `${agentDef.name} ACP session/new`, connection.signal);
        assertAcpProcessActive(internalId);
        acpSessionId = sessionResult.sessionId;
        const entry: ACPSessionEntry = { process: proc, connection, acpSessionId, internalId, analyticsProperties, eventCounter: 0, pendingPermissions, cwd: options.cwd, projectId: options.source.projectId, supportsLoadSession, agentName: agentDef.name, authMethods, isReloading: false };
        acpSessions.set(internalId, entry);
        configOptions = resolveConfigOptions(sessionResult, internalId, "ACP_REVIVE");
        log("ACP_REVIVE", `newSession fallback, session=${acpSessionId.slice(0, 12)}`);
      }

      const mcpStatuses = sourceServers.map(s => ({ name: s.name, status: "connected" as const }));
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
    const acpSessionId = session.acpSessionId;

    const memory = await beforeMemorySend(sessionId, text);
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
      void completeMemoryTurn(sessionId);
      finishAcpTaskTurn(sessionId, result.stopReason);

      safeSend(getMainWindow,"acp:turn_complete", {
        _sessionId: sessionId,
        stopReason: result.stopReason,
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
  // This preserves full conversation context on the agent side — no process restart needed.
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
    if (!session.supportsLoadSession) {
      log("ACP_RELOAD", `session=${sessionId.slice(0, 8)} agent does not support session/load, falling back to restart`);
      return { supportsLoad: false };
    }
    if (!session.acpSessionId) {
      return { error: buildAuthRequiredError(session.agentName, session.authMethods), supportsLoad: true };
    }
    const acpSessionId = session.acpSessionId;

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
        await withTimeout(session.connection.loadSession({
          sessionId: acpSessionId,
          cwd: nextCwd,
          mcpServers: acpMcpServers,
        }), ACP_START_TIMEOUT_MS, `${session.agentName} ACP session/load`, session.connection.signal);
      } finally {
        // Always reset — even if loadSession throws or process crashes
        if (acpSessions.has(sessionId)) {
          acpSessions.get(sessionId)!.isReloading = false;
        }
      }
      assertAcpProcessActive(sessionId);
      session.cwd = nextCwd;
      log("ACP_RELOAD", `session=${sessionId.slice(0, 8)} loadSession OK`);
      return { ok: true, supportsLoad: true };
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
      await session.connection.cancel({ sessionId: acpSessionId });
      log("ACP_CANCEL", `session=${sessionId.slice(0, 8)} acknowledged`);
      return { ok: true };
    } catch (err) {
      const msg = reportError("ACP_CANCEL_ERR", err, { engine: "acp", sessionId });
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
      const conn = session.connection;

      // Try the stable config option API first
      try {
        const result = await conn.setSessionConfigOption({
          sessionId: acpSessionId,
          configId,
          value,
        });
        log("ACP_CONFIG", `session=${sessionId.slice(0, 8)} ${configId}=${value} OK (via setSessionConfigOption)`);
        if (result.configOptions) configBuffer.set(sessionId, result.configOptions);
        return { configOptions: result.configOptions };
      } catch (configErr) {
        // If it fails and this is the model config, try the unstable setSessionModel API
        if (configId === "model") {
          log("ACP_CONFIG", `session=${sessionId.slice(0, 8)} setSessionConfigOption failed, trying unstable_setSessionModel...`);
          await conn.unstable_setSessionModel({
            sessionId: acpSessionId,
            modelId: value,
          });
          log("ACP_CONFIG", `session=${sessionId.slice(0, 8)} model=${value} OK (via unstable_setSessionModel)`);

          // Update the synthesized config option in the buffer
          const buffered = configBuffer.get(sessionId) as Array<{ id: string; currentValue: string }> | undefined;
          if (buffered) {
            const modelOpt = buffered.find(o => o.id === "model");
            if (modelOpt) modelOpt.currentValue = value;
            return { configOptions: buffered };
          }
          return {};
        }
        throw configErr;
      }
    } catch (err) {
      const errMsg = reportError("ACP_CONFIG_ERR", err, { engine: "acp", sessionId, configId });
      return { error: errMsg };
    }
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
    resolver.resolve({ outcome: { outcome: "selected", optionId } });
    session.pendingPermissions.delete(requestId);
    taskRuntimeEvents.resolve(sessionId, requestId);
    return { ok: true };
  });
}

/** Stop all ACP sessions (called on app quit). Idempotent. */
export async function stopAll(): Promise<void> {
  const stopping: Promise<void>[] = [];
  for (const [sessionId, runtime] of acpProcesses) {
    revokeProjectAppAgentSession(sessionId);
    stopUsageSession(sessionId);    taskRuntimeEvents.stop(sessionId);
    log("CLEANUP", `Stopping ACP session ${sessionId.slice(0, 8)}`);
    runtime.stopping = true;
    for (const permission of runtime.pendingPermissions.values()) permission.resolve({ outcome: { outcome: "cancelled" } });
    runtime.pendingPermissions.clear();
    stopping.push(stopProcessAndWait(runtime.process));
  }
  for (const sessionId of acpSessions.keys()) { unregisterMemorySession(sessionId); revokeProjectAppAgentSession(sessionId); }
  acpSessions.clear();
  configBuffer.clear();
  commandsBuffer.clear();
  const results = await Promise.allSettled(stopping);
  for (const result of results) if (result.status === "rejected") reportError("ACP_STOP_ERR", result.reason);
}
