import { observeMemoryEvent, recordMemoryDispatch } from "../lib/memory/runtime";
import { BrowserWindow, ipcMain } from "electron";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import { log } from "../lib/logger";
import { safeSend } from "../lib/safe-send";
import { AsyncChannel } from "../lib/async-channel";
import { getSDK, clientAppEnv } from "../lib/sdk";
import type { QueryHandle } from "../lib/sdk";
import type { SDKUserMessage, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { getMcpAuthHeaders } from "../lib/mcp-oauth-flow";
import { getClaudeModelsCache, setClaudeModelsCache } from "../lib/claude-model-cache";
import type { CachedModelInfo } from "../lib/claude-model-cache";
import { reportError } from "../lib/error-utils";
import { buildSdkMcpConfig } from "@shared/lib/mcp-config";
import type { McpServerInput } from "@shared/lib/mcp-config";
import { getClaudeBinaryPath, getClaudeBinaryStatus, getClaudeVersion, scanClaudeBinaries } from "../lib/claude-binary";
import { captureEvent } from "../lib/posthog";
import { withComputerUseMcpServer } from "../lib/computer-use-runtime";
import { withMemoryMcpServers, registerMemorySession, unregisterMemorySession, cancelMemoryTurn, beforeMemorySend, isMemoryTool } from "../lib/memory/service";
import { beginUsageTurn, endUsageTurn, stopUsageSession } from "../lib/usage";
import { bindSessionTokenUsage, createClaudeTokenObserver } from "../lib/token-usage";
import { observeClaudeTaskEvent } from "../lib/tasks/engine-events";
import { taskRuntimeEvents } from "../lib/tasks/runtime-events";
import { getSessionRepository } from "../lib/session-service";
import type { SessionRuntimeLease } from "../lib/session-repository";
import type { SessionResumeSource } from "@shared/types/productivity";
import { cancelProjectAppAgentPermissions, registerProjectAppAgentSession, revokeProjectAppAgentSession, withProjectAppMcpServer } from "../lib/project-apps/agent-bridge";

/** SDK options for file checkpointing — enables Write/Edit/NotebookEdit revert support */
function fileCheckpointOptions(): Record<string, unknown> {
  return {
    enableFileCheckpointing: true,
    extraArgs: { "replay-user-messages": null }, // required to receive checkpoint UUIDs
    env: { ...process.env, ...clientAppEnv(), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "1" },
  };
}

type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string };

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
}

interface SessionEntry {
  channel: AsyncChannel<SDKUserMessage>;
  queryHandle: QueryHandle | null;
  eventCounter: number;
  pendingPermissions: Map<string, PendingPermission>;
  startOptions?: StartOptions;
  /** When true, the old event loop should NOT send claude:exit on teardown */
  restarting?: boolean;
  /** When true, a stop was requested — suppress expected SDK teardown errors */
  stopping?: boolean;
  /** Why the stop was requested (user action, cleanup, etc.). */
  stopReason?: string;
  runtimeLease?: SessionRuntimeLease;
}

export const sessions = new Map<string, SessionEntry>();

function assertClaudeSessionActive(sessionId: string, session: SessionEntry): void {
  if (sessions.get(sessionId) !== session || (session.stopping && session.stopReason !== "interrupt") || session.restarting) throw new Error("Claude session stopped");
  session.runtimeLease?.assertActive();
}

async function stopSession(sessionId: string, reason: string): Promise<void> {
  revokeProjectAppAgentSession(sessionId);
  stopUsageSession(sessionId);  taskRuntimeEvents.stop(sessionId);
  const session = sessions.get(sessionId);
  if (!session) return;
  session.stopping = true;
  session.stopReason = reason;
  for (const pending of session.pendingPermissions.values()) pending.resolve({ behavior: "deny", message: "Session deleted" });
  session.pendingPermissions.clear();
  session.channel.close();
  session.queryHandle?.close();
  if (!session.queryHandle) {
    sessions.delete(sessionId);
    session.runtimeLease?.release();
    unregisterMemorySession(sessionId); revokeProjectAppAgentSession(sessionId);
    return;
  }
  const deadline = Date.now() + 5_000;
  while (sessions.get(sessionId) === session) {
    if (Date.now() >= deadline) throw new Error("Claude session did not stop before the deletion deadline");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function stopForDeletion(sessionId: string): Promise<void> {
  await stopSession(sessionId, "session_delete");
}

function toSdkModelOverride(model?: string | null): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  return normalized.toLowerCase() === "default" ? undefined : normalized;
}

function applyPermissionModeOptions(
  queryOptions: Record<string, unknown>,
  permissionMode?: string,
): void {
  if (permissionMode) {
    queryOptions.permissionMode = permissionMode;
  }
  // Harnss exposes "Allow All" as a runtime mode switch. The SDK only lets a
  // live session enter bypass mode if this startup flag was present from launch.
  queryOptions.allowDangerouslySkipPermissions = true;
}

async function setSessionPermissionMode(
  sessionId: string,
  session: SessionEntry,
  permissionMode: string,
  logLabel: string,
): Promise<void> {
  if (!session.queryHandle) {
    throw new Error("No active query handle");
  }
  await session.queryHandle.setPermissionMode(parsePermissionMode(permissionMode));
  if (session.startOptions) {
    session.startOptions.permissionMode = permissionMode;
  }
  log(logLabel, `session=${sessionId.slice(0, 8)} mode=${permissionMode}`);
}

/**
 * Explicitly set permissionMode on a freshly created query handle.
 * The SDK CLI may ignore the `permissionMode` query option for resumed sessions
 * (it loads saved state from disk). Calling setPermissionMode() on the live handle
 * is guaranteed to take effect.
 */
async function enforcePermissionMode(
  sessionId: string,
  queryHandle: QueryHandle,
  permissionMode: string | undefined,
  context: string,
): Promise<void> {
  if (!permissionMode || permissionMode === "default") return;
  try {
    await queryHandle.setPermissionMode(parsePermissionMode(permissionMode));
    log("PERMISSION_MODE_ENFORCED", `session=${sessionId.slice(0, 8)} mode=${permissionMode} (${context})`);
  } catch (err) {
    reportError("PERMISSION_MODE_ENFORCE_ERR", err, { engine: "claude", sessionId, permissionMode, context });
  }
}

function parsePermissionMode(value: string): PermissionMode {
  switch (value) {
    case "default": case "acceptEdits": case "bypassPermissions": case "plan": case "dontAsk": case "auto":
      return value;
    default: throw new Error(`Unsupported Claude permission mode: ${value}`);
  }
}

function summarizeSpawnOptions(options: Record<string, unknown>): Record<string, unknown> {
  const mcpServers = options.mcpServers;
  const mcpSummary = mcpServers && typeof mcpServers === "object"
    ? Object.entries(mcpServers as Record<string, unknown>).map(([name, config]) => ({
      name,
      transport:
        config && typeof config === "object" && "type" in config
          ? (config as { type?: unknown }).type ?? "stdio"
          : "stdio",
    }))
    : undefined;

  return {
    cwd: options.cwd,
    sessionId: options.sessionId,
    resume: options.resume,
    forkSession: options.forkSession,
    resumeSessionAt: options.resumeSessionAt,
    permissionMode: options.permissionMode,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
    model: options.model,
    includePartialMessages: options.includePartialMessages,
    thinking: options.thinking,
    effort: options.effort,
    settingSources: options.settingSources,
    enableFileCheckpointing: options.enableFileCheckpointing,
    extraArgs: options.extraArgs,
    envKeys:
      options.env && typeof options.env === "object"
        ? Object.keys(options.env as Record<string, unknown>).sort()
        : undefined,
    mcpServers: mcpSummary,
    canUseTool: "[callback]",
    stderr: "[callback]",
  };
}

function summarizeEvent(event: Record<string, unknown>): string {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        return `system/init session=${(event.session_id as string)?.slice(0, 8)} model=${event.model} permMode=${event.permissionMode ?? "?"}`;
      }
      if (event.subtype === "task_started") {
        return `system/task_started task=${(event.task_id as string)?.slice(0, 8)} tool_use=${(event.tool_use_id as string)?.slice(0, 12)} desc="${event.description}"`;
      }
      if (event.subtype === "task_progress") {
        const usage = event.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined;
        return `system/task_progress task=${(event.task_id as string)?.slice(0, 8)} tokens=${usage?.total_tokens} tools=${usage?.tool_uses} ${usage?.duration_ms}ms last=${event.last_tool_name ?? "-"}`;
      }
      if (event.subtype === "task_notification") {
        const usage = event.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined;
        return `system/task_notification task=${(event.task_id as string)?.slice(0, 8)} status=${event.status} tokens=${usage?.total_tokens} ${usage?.duration_ms}ms`;
      }
      return `system/${event.subtype}`;
    }
    case "stream_event": {
      const e = event.event as Record<string, unknown>;
      switch (e.type) {
        case "message_start":
          return `stream/message_start msg_id=${((e.message as Record<string, unknown>)?.id as string)?.slice(0, 12)}`;
        case "content_block_start": {
          const b = e.content_block as Record<string, unknown>;
          if (b.type === "tool_use") return `stream/block_start idx=${e.index} tool_use name=${b.name} id=${(b.id as string)?.slice(0, 12)}`;
          return `stream/block_start idx=${e.index} type=${b.type}`;
        }
        case "content_block_delta": {
          const d = e.delta as Record<string, unknown>;
          if (d.type === "text_delta") return `stream/block_delta idx=${e.index} text_delta len=${(d.text as string)?.length}`;
          if (d.type === "input_json_delta") return `stream/block_delta idx=${e.index} json_delta len=${(d.partial_json as string)?.length}`;
          if (d.type === "thinking_delta") return `stream/block_delta idx=${e.index} thinking_delta len=${(d.thinking as string)?.length}`;
          return `stream/block_delta idx=${e.index} type=${d.type}`;
        }
        case "content_block_stop":
          return `stream/block_stop idx=${e.index}`;
        case "message_delta":
          return `stream/message_delta stop_reason=${(e.delta as Record<string, unknown>)?.stop_reason}`;
        case "message_stop":
          return "stream/message_stop";
        default:
          return `stream/${e.type}`;
      }
    }
    case "assistant": {
      const blocks = ((event.message as Record<string, unknown>)?.content as Array<Record<string, unknown>>) || [];
      const types = blocks.map((b) => {
        if (b.type === "tool_use") return `tool_use(${b.name}, id=${(b.id as string)?.slice(0, 12)})`;
        if (b.type === "text") return `text(len=${(b.text as string)?.length})`;
        return b.type;
      });
      return `assistant uuid=${(event.uuid as string)?.slice(0, 12)} blocks=[${types.join(", ")}]`;
    }
    case "user": {
      const content = (event.message as Record<string, unknown>)?.content;
      if (typeof content === "string") {
        return `user text(len=${content.length})`;
      }
      const items = ((content as Array<Record<string, unknown>>) || []).map((c) => {
        if (c.type === "tool_result") return `tool_result(tool_use_id=${(c.tool_use_id as string)?.slice(0, 12)})`;
        return (c.type as string) || "unknown";
      });
      const result = event.tool_use_result as Record<string, unknown> | undefined;
      let resultInfo = "";
      if (result) {
        if (result.isAsync) resultInfo = ` async agentId=${result.agentId} status=${result.status}`;
        else if (result.file) resultInfo = ` file=${(result.file as Record<string, unknown>).filePath}`;
        else if (result.stdout !== undefined) resultInfo = ` bash stdout_len=${(result.stdout as string)?.length} stderr_len=${(result.stderr as string)?.length || 0}`;
        else if (result.filePath) resultInfo = ` edit=${result.filePath}`;
        else resultInfo = ` result_keys=[${Object.keys(result).join(",")}]`;
      }
      return `user items=[${items.join(", ")}]${resultInfo}`;
    }
    case "result":
      return `result/${event.subtype} cost=$${event.total_cost_usd} turns=${event.num_turns} duration=${event.duration_ms}ms`;
    default:
      return `${event.type} (unknown)`;
  }
}

/**
 * Shared event forwarding loop for Claude SDK sessions.
 * Iterates the query handle's async generator, logs events, and forwards them
 * to the renderer. On exit, sends claude:exit unless the session is restarting.
 */
function startEventLoop(
  sessionId: string,
  queryHandle: QueryHandle,
  session: SessionEntry,
  getMainWindow: () => BrowserWindow | null,
): void {
  const logPrefix = `session=${sessionId.slice(0, 8)}`;
  let queryError: string | undefined;
  // Maps tool_use_id → tool name, populated from assistant events so tool_result events can
  // reference the name when capturing analytics.
  const toolNameMap = new Map<string, string>();
  // Forks also inherit cumulative modelUsage from their source transcript.
  const tokenObserver = createClaudeTokenObserver(!!session.startOptions?.resume, sessionId);
  let deltaCounter = 0;
  (async () => {
    try {
      for await (const message of queryHandle) {
        session.eventCounter++;
        const msgObj = message as Record<string, unknown>;
        // Throttle logging for high-frequency content_block_delta events — they arrive
        // at ~60/sec during streaming and the deep sanitizeValue() + JSON.stringify in
        // log() burns significant CPU. Log every 50th delta as a sample.
        const isStreamDelta = msgObj.type === "stream_event" &&
          (msgObj.event as Record<string, unknown> | undefined)?.type === "content_block_delta";
        if (isStreamDelta) {
          deltaCounter++;
          if (deltaCounter % 50 === 1) {
            const summary = summarizeEvent(msgObj);
            log("EVENT", `${logPrefix} #${session.eventCounter} ${summary} (sampled, ${deltaCounter} deltas total)`);
          }
        } else {
          const summary = summarizeEvent(msgObj);
          log("EVENT", `${logPrefix} #${session.eventCounter} ${summary}`);
        }
        if (msgObj.type === "user" || msgObj.type === "result") {
          log("EVENT_FULL", message);
        }
        tokenObserver.observe(msgObj);
        if (!session.stopping) { observeClaudeTaskEvent(sessionId, msgObj); observeMemoryEvent(sessionId,"claude",msgObj); }
        if (msgObj.type === "system" && typeof msgObj.task_id === "string") {
          if (msgObj.subtype === "task_started") beginUsageTurn(sessionId, `task:${msgObj.task_id}`);
          if (msgObj.subtype === "task_notification") endUsageTurn(sessionId, `task:${msgObj.task_id}`);
        }
        if (msgObj.type === "result" && !msgObj.parent_tool_use_id) endUsageTurn(sessionId);
        safeSend(getMainWindow, "claude:event", { ...(message as object), _sessionId: sessionId });

        // Index tool names from assistant tool_use blocks for later lookup by tool_use_id
        if (msgObj.type === "assistant") {
          const assistantMsg = msgObj.message as { content?: unknown } | undefined;
          const blocks = assistantMsg?.content;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
                toolNameMap.set(b.id, b.name);
              }
            }
          }
        }

        // Track session completion on result events
        if (msgObj.type === "result") {
          void captureEvent("session_completed", {
            engine: "claude",
            total_cost: msgObj.total_cost_usd,
            num_turns: msgObj.num_turns,
            duration_ms: msgObj.duration_ms,
            is_error: !!msgObj.is_error,
          });
        }

        // Track tool execution on tool_result user events
        if (msgObj.type === "user") {
          const userMsg = msgObj.message as { content?: unknown } | undefined;
          const content = userMsg?.content;
          if (Array.isArray(content) && content[0]?.type === "tool_result") {
            const isError = !!content[0].is_error;
            const toolMeta = msgObj.tool_use_result as Record<string, unknown> | undefined;
            const toolUseId = content[0].tool_use_id as string | undefined;
            const toolName = (toolUseId ? toolNameMap.get(toolUseId) : undefined) ?? "unknown";
            void captureEvent("tool_executed", {
              engine: "claude",
              tool_name: toolName,
              is_error: isError,
              is_mcp: toolName.startsWith("mcp__"),
              is_async: !!toolMeta?.isAsync,
            });
          }
        }
      }
    } catch (err) {
      queryError = reportError("QUERY_ERROR", err, { engine: "claude", sessionId });
      if (!session.stopping && taskRuntimeEvents.get(sessionId)?.status === "running") taskRuntimeEvents.publish(sessionId, "claude", "failed", queryError);
      log("QUERY_ERROR", `${logPrefix} stopping=${!!session.stopping} reason=${session.stopReason ?? "none"}`);
    } finally {
      session.runtimeLease?.release();
      const ownsSession = sessions.get(sessionId) === session;
      if (ownsSession) {
        sessions.delete(sessionId);
        unregisterMemorySession(sessionId); revokeProjectAppAgentSession(sessionId);
      }
      if (!session.restarting && ownsSession) {
        stopUsageSession(sessionId);        taskRuntimeEvents.stop(sessionId);
        // Requested stop: treat teardown errors as clean exit
        const stopRequested = session.stopping;
        const exitCode = (queryError && !stopRequested) ? 1 : 0;
        log("EXIT", `${logPrefix} total_events=${session.eventCounter} stopRequested=${!!stopRequested} stopReason=${session.stopReason ?? "none"} error=${queryError ?? "none"}`);
        safeSend(getMainWindow, "claude:exit", {
          code: exitCode, _sessionId: sessionId,
          ...((queryError && !stopRequested) ? { error: queryError } : {}),
        });
      } else {
        log("EXIT_RESTART", `${logPrefix} old loop ended (restarting)`);
      }
    }
  })().catch((err) => reportError("EVENT_LOOP_FATAL", err, { engine: "claude", sessionId }));
}

function parseStopRequest(
  payload: string | { sessionId: string; reason?: string },
): { sessionId: string; reason: string } {
  if (typeof payload === "string") {
    return { sessionId: payload, reason: "user" };
  }
  return {
    sessionId: payload.sessionId,
    reason: typeof payload.reason === "string" && payload.reason.length > 0
      ? payload.reason
      : "user",
  };
}

interface StartOptions {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  thinkingEnabled?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  resume?: string;
  /** Fork to a new session ID when resuming (model forgets messages after resumeSessionAt) */
  forkSession?: boolean;
  /** Resume at a specific message UUID — used with forkSession to truncate history */
  resumeSessionAt?: string;
  mcpServers?: McpServerInput[];
  memoryContext?: { projectId: string };
  source?: SessionResumeSource;
}

function buildThinkingConfig(): { type: "adaptive" } {
  return { type: "adaptive" };
}

function logSdkCliPath(context: string, cliPath: string): void {
  log("SDK_CLI_PATH", `${context} path=${cliPath}`);
}

type ModelsRevalidationResult = { models: CachedModelInfo[]; updatedAt?: number; error?: string };
let modelsRevalidationPromise: Promise<ModelsRevalidationResult> | null = null;

/** Read credential configuration without sending a user turn or retaining account details. */
export async function hasConfiguredClaudeAccount(cwd: string): Promise<boolean> {
  const cliPath = await getClaudeBinaryPath();
  const query = await getSDK();
  const channel = new AsyncChannel<SDKUserMessage>();
  const handle = query({ prompt: channel, options: {
    cwd, settingSources: ["user", "project", "local"],
    pathToClaudeCodeExecutable: cliPath,
    env: { ...process.env, ...clientAppEnv() },
  } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const account = await Promise.race([
      handle.accountInfo(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Account check timed out; retry after the agent starts")), 4_000); }),
    ]);
    if (account.apiProvider && account.apiProvider !== "firstParty") return true;
    return [account.email, account.tokenSource, account.apiKeySource].some((value) => !!value && !/^(none|unknown)$/i.test(value));
  } finally {
    if (timeout) clearTimeout(timeout);
    channel.close();
    handle.close();
  }
}

async function revalidateClaudeModelsCache(cwd?: string): Promise<ModelsRevalidationResult> {
  if (modelsRevalidationPromise) return modelsRevalidationPromise;

  modelsRevalidationPromise = (async () => {
    const existing = getClaudeModelsCache();
    const cliPath = await getClaudeBinaryPath();
    const query = await getSDK();
    const channel = new AsyncChannel<SDKUserMessage>();
    let queryHandle: QueryHandle | null = null;
    try {
      logSdkCliPath("models-revalidate", cliPath);
      const version = await getClaudeVersion(cliPath);
      if (version) log("CLAUDE_VERSION", `models-revalidate version=${version}`);
      queryHandle = query({ prompt: channel, options: {
        cwd: cwd?.trim() || os.homedir(),
        includePartialMessages: true,
        thinking: buildThinkingConfig(),
        settingSources: ["user", "project", "local"],
        pathToClaudeCodeExecutable: cliPath,
        ...fileCheckpointOptions(),
        stderr: (data: string) => {
          const trimmed = data.trim();
          if (trimmed) log("MODELS_CACHE_STDERR", trimmed);
        },
      } });
      if (!queryHandle.supportedModels) return { models: existing.models, updatedAt: existing.updatedAt };
      const models = await queryHandle.supportedModels();
      if (Array.isArray(models) && models.length > 0) {
        const next = setClaudeModelsCache(models);
        return { models: next.models, updatedAt: next.updatedAt };
      }
      return { models: existing.models, updatedAt: existing.updatedAt };
    } finally {
      channel.close();
      if (queryHandle) {
        try { queryHandle.close(); } catch { /* The subprocess may already be closed. */ }
      }
    }
  })().catch((err) => {
    const message = reportError("MODELS_CACHE_REVALIDATE_ERR", err, { engine: "claude" });
    const existing = getClaudeModelsCache();
    return { models: existing.models, updatedAt: existing.updatedAt, error: message };
  }).finally(() => {
    modelsRevalidationPromise = null;
  });

  return modelsRevalidationPromise;
}

/** Shared MCP config options — injects auth header resolution and diagnostic logging. */
const mcpConfigOptions = {
  getAuthHeaders: async (name: string, url: string) => (await getMcpAuthHeaders(name, url)) ?? {},
  onWarn: (label: string, message: string) => log(label, message),
};

// ── Restart a running session with fresh config (resume = same conversation) ──

async function restartSession(
  sessionId: string,
  getMainWindow: () => BrowserWindow | null,
  mcpServersOverride?: McpServerInput[],
  cwdOverride?: string,
  effortOverride?: StartOptions["effort"],
  modelOverride?: string,
): Promise<{ ok?: boolean; error?: string; restarted?: boolean }> {
  const session = sessions.get(sessionId);
  if (!session?.queryHandle || !session.startOptions) {
    return { error: "No active session to restart" };
  }
  const opts = session.startOptions;
  const projectId = opts.memoryContext?.projectId ?? opts.source?.projectId;
  if (!projectId) return { error: "Save the session before restarting it" };
  try {
    if (!await getSessionRepository().load(projectId, sessionId)) return { error: "Save the session before restarting it" };
    assertClaudeSessionActive(sessionId, session);
    // Wait for the old event loop before reusing its runtime ID.
    session.restarting = true;
    await stopSession(sessionId, "restart");
    if (session.stopReason !== "restart") return { error: "Claude session stopped" };
    const result = await startSession({
      ...opts,
      cwd: cwdOverride ?? opts.cwd,
      mcpServers: mcpServersOverride ?? opts.mcpServers,
      effort: effortOverride ?? opts.effort,
      model: modelOverride ?? opts.model,
      resume: sessionId,
      forkSession: false,
      resumeSessionAt: undefined,
      source: { projectId, runtimeSessionId: sessionId },
    }, getMainWindow, session.eventCounter);
    return result.error ? { error: result.error } : { ok: true, restarted: true };
  } catch (err) {
    const errMsg = reportError("SESSION_RESTART_ERR", err, { engine: "claude", sessionId });
    return { error: `Restart failed: ${errMsg}` };
  }
}

async function startSession(options: StartOptions, getMainWindow: () => BrowserWindow | null, eventCounter = 0) {
  // Fork sessions get a fresh IPC-level ID to avoid race with old session's
  // async cleanup (which would delete the new Map entry if we reused the old key).
  const sessionId = (options.resume && options.forkSession)
    ? crypto.randomUUID()
    : (options.resume || crypto.randomUUID());
  let runtimeLease: SessionRuntimeLease | undefined;
  let ownedSession: SessionEntry | undefined;
  try {
    if (sessions.has(sessionId)) throw new Error("Claude session is already running");
    if (options.resume && !options.source) throw new Error("A saved source is required to resume a session");
    if (options.source) runtimeLease = await getSessionRepository().bindRuntime(options.source, "claude", sessionId, () => stopForDeletion(sessionId));
    else if (options.memoryContext?.projectId) runtimeLease = await getSessionRepository().bindProjectRuntime(options.memoryContext.projectId, sessionId, () => stopForDeletion(sessionId));
    bindSessionTokenUsage(sessionId, options.source?.runtimeSessionId);
    const query = await getSDK();
    runtimeLease?.assertActive();
    if (sessions.has(sessionId)) throw new Error("Claude session is already running");

    const channel = new AsyncChannel<SDKUserMessage>();
    const session: SessionEntry = {
      channel,
      queryHandle: null,
      eventCounter,
      pendingPermissions: new Map(),
      startOptions: options,
      runtimeLease,
    };
    ownedSession = session;
    sessions.set(sessionId, session);
    const memoryProjectId = options.source?.projectId ?? options.memoryContext?.projectId;
      if (memoryProjectId) await registerMemorySession(sessionId, memoryProjectId, "claude");

    const canUseTool = (toolName: string, input: unknown, context: { toolUseID: string; suggestions: unknown; decisionReason: string }) => {
      return new Promise<PermissionResult>((resolve) => {
        try { assertClaudeSessionActive(sessionId, session); }
        catch { resolve({ behavior: "deny", message: "Session stopped" }); return; }
        if (isMemoryTool(toolName)) { resolve({ behavior: "allow" }); return; }
        const requestId = crypto.randomUUID();
        session.pendingPermissions.set(requestId, { resolve });
        taskRuntimeEvents.wait(sessionId, "claude", requestId, toolName === "AskUserQuestion" ? "waiting_user" : "waiting_permission");
        log("PERMISSION_REQUEST", {
          session: sessionId.slice(0, 8),
          tool: toolName,
          requestId,
          toolUseId: context.toolUseID,
          reason: context.decisionReason,
          hasSuggestions: Array.isArray(context.suggestions) && context.suggestions.length > 0,
        });
        safeSend(getMainWindow,"claude:permission_request", {
          _sessionId: sessionId,
          requestId,
          toolName,
          toolInput: input,
          toolUseId: context.toolUseID,
          suggestions: context.suggestions,
          decisionReason: context.decisionReason,
        });
      });
    };

    const cliPath = await getClaudeBinaryPath();
    assertClaudeSessionActive(sessionId, session);
    logSdkCliPath(`start session=${sessionId.slice(0, 8)}`, cliPath);
    const queryOptions: Record<string, unknown> = {
      cwd: options.cwd || process.cwd(),
      includePartialMessages: true,
      thinking: buildThinkingConfig(),
      canUseTool,
      settingSources: ["user", "project", "local"],
      pathToClaudeCodeExecutable: cliPath,
      agentProgressSummaries: true,
      ...fileCheckpointOptions(),
      stderr: (data: string) => {
        const trimmed = data.trim();
        log("STDERR", `session=${sessionId.slice(0, 8)} ${trimmed}`);
        safeSend(getMainWindow,"claude:stderr", { data, _sessionId: sessionId });
      },
    };

    if (options.resume) {
      queryOptions.resume = options.resume;
      if (options.forkSession) {
        queryOptions.forkSession = true;
        // Use our IPC-level ID as the fork's session ID so future resume works
        queryOptions.sessionId = sessionId;
      }
      if (options.resumeSessionAt) queryOptions.resumeSessionAt = options.resumeSessionAt;
    } else {
      queryOptions.sessionId = sessionId;
    }

    applyPermissionModeOptions(queryOptions, options.permissionMode);
    const startModel = toSdkModelOverride(options.model);
    if (startModel) {
      queryOptions.model = startModel;
    }
    if (options.effort) {
      queryOptions.effort = options.effort;
    }

    await registerProjectAppAgentSession(sessionId, options.source?.projectId ?? options.memoryContext?.projectId, options.cwd || process.cwd());
    assertClaudeSessionActive(sessionId, session);
    const mcpServers = withProjectAppMcpServer(withMemoryMcpServers(withComputerUseMcpServer(options.mcpServers), sessionId), sessionId);
    if (mcpServers.length) {
      queryOptions.mcpServers = await buildSdkMcpConfig(mcpServers, mcpConfigOptions);
    }
    assertClaudeSessionActive(sessionId, session);

    log("SPAWN", { sessionId, resume: options.resume || null, options: summarizeSpawnOptions(queryOptions) });

    const q = query({ prompt: channel, options: queryOptions });
    session.queryHandle = q;
    startEventLoop(sessionId, q, session, getMainWindow);

    // For resumed sessions, explicitly enforce the permission mode on the live
    // handle — the SDK CLI may load its own saved state and ignore the query option.
    if (options.resume) {
      await enforcePermissionMode(sessionId, q, options.permissionMode, "start-resume");
    }

    assertClaudeSessionActive(sessionId, session);

    void captureEvent("session_created", {
      engine: "claude",
      model: options.model,
      is_resume: !!options.resume,
    });

    return { sessionId, pid: 0 };
  } catch (err) {
    if (ownedSession && sessions.get(sessionId) === ownedSession) {
      try { await stopSession(sessionId, "start_failed"); }
      catch (stopError) { reportError("START_STOP_ERR", stopError, { engine: "claude", sessionId }); }
    }
    if (!ownedSession || sessions.get(sessionId) !== ownedSession) runtimeLease?.release();
    const errMsg = reportError("START_ERROR", err, { engine: "claude", sessionId });
    if (!sessions.has(sessionId)) safeSend(getMainWindow,"claude:exit", {
      code: 1, _sessionId: sessionId, error: errMsg,
    });
    void captureEvent("session_error", { engine: "claude", phase: "start" });
    return { sessionId, pid: 0, error: errMsg };
  }
}

// ── IPC Registration ──

export function register(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("claude:start", (_event, options: StartOptions = {}) => startSession(options, getMainWindow));

  ipcMain.handle("claude:send", async (_event, { sessionId, message }: { sessionId: string; message: { message: Pick<SDKUserMessage["message"], "content"> } }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      log("SEND", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Claude session not found" };
    }
    const originalContent = message.message.content;
    const originalText = typeof originalContent === "string"
      ? originalContent
      : Array.isArray(originalContent)
        ? originalContent.map((block) => typeof block === "object" && block && "text" in block && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : "").join("\n")
        : "";
    const memory = await beforeMemorySend(sessionId, originalText);
    try { assertClaudeSessionActive(sessionId, session); }
    catch (error) { return { error: reportError("SEND_STOPPED", error, { engine: "claude", sessionId }) }; }
    const content: SDKUserMessage["message"]["content"] = memory.text === originalText || !originalText
      ? originalContent
      : Array.isArray(originalContent)
        ? [{ type: "text", text: memory.text.slice(0, memory.text.length - originalText.length) }, ...originalContent]
        : memory.text;
    log("SEND", `session=${sessionId.slice(0, 8)} content=${JSON.stringify(originalContent).slice(0, 500)}`);
    session.channel.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    recordMemoryDispatch(sessionId,memory.turnId,"queued");
    beginUsageTurn(sessionId);
    taskRuntimeEvents.publish(sessionId, "claude", "running");
    return { ok: true };
  });

  ipcMain.handle("claude:permission_response", async (_event, {
    sessionId, requestId, behavior, toolInput, newPermissionMode, updatedPermissions,
  }: {
    sessionId: string;
    requestId: string;
    behavior: string;
    toolUseId: string;
    toolInput: Record<string, unknown> | undefined;
    newPermissionMode?: string;
    updatedPermissions?: unknown[];
  }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      log("PERMISSION_RESPONSE", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Claude session not found" };
    }
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      log("PERMISSION_RESPONSE", `ERROR: no pending permission for requestId=${requestId}`);
      return { error: "No pending permission request" };
    }
    log("PERMISSION_RESPONSE", `session=${sessionId.slice(0, 8)} behavior=${behavior} requestId=${requestId} newMode=${newPermissionMode ?? "none"} hasUpdatedPermissions=${!!updatedPermissions?.length}`);

    if (newPermissionMode) {
      try {
        await setSessionPermissionMode(
          sessionId,
          session,
          newPermissionMode,
          "PERMISSION_MODE_CHANGED",
        );
      } catch (err) {
        const errMsg = reportError("PERMISSION_MODE_ERR", err, {
          engine: "claude",
          sessionId,
          newPermissionMode,
        });
        log("PERMISSION_RESPONSE", `ERROR: session=${sessionId.slice(0, 8)} requestId=${requestId} modeChangeFailed=${errMsg}`);
        return { error: errMsg };
      }
    }

    session.pendingPermissions.delete(requestId);
    taskRuntimeEvents.resolve(sessionId, requestId);

    if (behavior === "allow") {
      pending.resolve({ behavior: "allow", updatedInput: toolInput, updatedPermissions });
    } else {
      // Pass user-provided rejection reason (from plan feedback) to the SDK so the model can adjust
      const denyMsg = toolInput?.denyMessage;
      pending.resolve({
        behavior: "deny",
        message: typeof denyMsg === "string" && denyMsg.trim() ? denyMsg.trim() : "User denied permission",
      });
    }
    return { ok: true };
  });

  ipcMain.handle("claude:set-permission-mode", async (_event, { sessionId, permissionMode }: { sessionId: string; permissionMode: string }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      log("SET_PERM_MODE", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Claude session not found" };
    }
    if (!session.queryHandle) {
      return { error: "No active query handle" };
    }
    try {
      await setSessionPermissionMode(sessionId, session, permissionMode, "SET_PERM_MODE");
      return { ok: true };
    } catch (err) {
      const errMsg = reportError("SET_PERM_MODE_ERR", err, { engine: "claude", sessionId });
      return { error: errMsg };
    }
  });

  ipcMain.handle("claude:set-model", async (_event, { sessionId, model }: { sessionId: string; model?: string }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      log("SET_MODEL", "ERROR: session " + sessionId.slice(0, 8) + " not found");
      return { error: "Claude session not found" };
    }
    if (!session.queryHandle?.setModel) {
      log("SET_MODEL", "ERROR: session=" + sessionId.slice(0, 8) + " setModel unsupported");
      return { error: "Model switching is not supported by this Claude SDK version" };
    }
    try {
      const sdkModel = toSdkModelOverride(model);
      await session.queryHandle.setModel(sdkModel);
      if (session.startOptions) {
        session.startOptions.model = sdkModel;
      }
      log("SET_MODEL", "session=" + sessionId.slice(0, 8) + " model=" + (sdkModel ?? "default"));
      void captureEvent("model_changed", { engine: "claude", model: sdkModel ?? "default" });
      return { ok: true };
    } catch (err) {
      const errMsg = reportError("SET_MODEL_ERR", err, { engine: "claude", sessionId, model: model ?? "default" });
      return { error: errMsg };
    }
  });

  ipcMain.handle("claude:set-thinking", async (_event, { sessionId, thinkingEnabled }: { sessionId: string; thinkingEnabled: boolean }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      log("SET_THINKING", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Claude session not found" };
    }
    if (!session.queryHandle?.setMaxThinkingTokens) {
      log("SET_THINKING", `ERROR: session=${sessionId.slice(0, 8)} setMaxThinkingTokens unsupported`);
      return { error: "Reasoning toggle is not supported by this Claude SDK version" };
    }
    try {
      await session.queryHandle.setMaxThinkingTokens(null);
      if (session.startOptions) {
        session.startOptions.thinkingEnabled = true;
      }
      log("SET_THINKING", `session=${sessionId.slice(0, 8)} requested=${thinkingEnabled} applied=true`);
      return { ok: true };
    } catch (err) {
      const errMsg = reportError("SET_THINKING_ERR", err, { engine: "claude", sessionId });
      return { error: errMsg };
    }
  });

  ipcMain.on("claude:log", (_event, label: string, data: unknown) => {
    log(`UI:${label}`, data);
  });

  ipcMain.handle(
    "claude:stop",
    (_event, payload: string | { sessionId: string; reason?: string }) => {
      const { sessionId, reason } = parseStopRequest(payload);
      revokeProjectAppAgentSession(sessionId);
      stopUsageSession(sessionId);      taskRuntimeEvents.stop(sessionId);
      const session = sessions.get(sessionId);
      if (session) {
        // Mark as requested stop so teardown errors are suppressed
        session.stopping = true;
        session.stopReason = reason;
        // Drain pending permissions before closing
        for (const [, pending] of session.pendingPermissions) {
          pending.resolve({ behavior: "deny", message: "Session stopped" });
        }
        session.pendingPermissions.clear();
        session.channel.close();
        session.queryHandle?.close();
        // Let the event loop's finally block handle sessions.delete + claude:exit
      }
      return { ok: true };
    },
  );

  ipcMain.handle("claude:interrupt", async (_event, sessionId: string) => {
    cancelMemoryTurn(sessionId);
    cancelProjectAppAgentPermissions(sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      log("INTERRUPT", `ERROR: session ${sessionId?.slice(0, 8)} not found`);
      return { error: "Session not found" };
    }
    try { assertClaudeSessionActive(sessionId, session); }
    catch (error) { return { error: reportError("INTERRUPT_STOPPED", error, { engine: "claude", sessionId }) }; }

    log("INTERRUPT", `session=${sessionId.slice(0, 8)}`);

    // Mark as user-initiated stop so the event loop treats teardown errors
    // (including SDK ede_diagnostic results) as a clean exit.
    session.stopping = true;
    session.stopReason = "interrupt";

    for (const [requestId, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: "deny", message: "Interrupted by user" });
      session.pendingPermissions.delete(requestId);
    }

    try {
      await session.queryHandle!.interrupt();
      taskRuntimeEvents.stop(sessionId);
      log("INTERRUPT", `session=${sessionId.slice(0, 8)} acknowledged`);
    } catch (err) {
      const errMsg = reportError("INTERRUPT_ERR", err, { engine: "claude", sessionId });
      return { error: errMsg };
    }

    return { ok: true };
  });

  ipcMain.handle("claude:stop-task", async (_event, { sessionId, taskId }: { sessionId: string; taskId: string }) => {
    const session = sessions.get(sessionId);
    if (!session?.queryHandle?.stopTask) {
      return { error: "No active session or stopTask not supported" };
    }
    try {
      await session.queryHandle.stopTask(taskId);
      endUsageTurn(sessionId, `task:${taskId}`);
      log("STOP_TASK", `session=${sessionId.slice(0, 8)} task=${taskId}`);
      return { ok: true };
    } catch (err) {
      const errMsg = reportError("STOP_TASK_ERR", err, { engine: "claude", sessionId, taskId });
      return { error: errMsg };
    }
  });

  ipcMain.handle("claude:read-agent-output", async (_event, { outputFile }: { outputFile: string }) => {
    try {
      const content = await fs.promises.readFile(outputFile, "utf-8");
      const lines = content
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try { return JSON.parse(line); }
          catch { return null; }
        })
        .filter(Boolean);
      return { messages: lines };
    } catch (err) {
      const errMsg = reportError("READ_AGENT_OUTPUT_ERR", err, { outputFile });
      return { error: errMsg };
    }
  });

  ipcMain.handle("claude:revert-files", async (_event, { sessionId, checkpointId }: { sessionId: string; checkpointId: string }) => {
    const session = sessions.get(sessionId);
    if (!session?.queryHandle?.rewindFiles) {
      return { error: "No active session or rewind not supported" };
    }
    try {
      await session.queryHandle.rewindFiles(checkpointId);
      log("REVERT_FILES", `session=${sessionId.slice(0, 8)} checkpoint=${checkpointId.slice(0, 12)}`);
      return { ok: true };
    } catch (err) {
      const errMsg = reportError("REVERT_FILES_ERR", err, { engine: "claude", sessionId });
      return { error: errMsg };
    }
  });

  ipcMain.handle("claude:mcp-status", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session?.queryHandle?.mcpServerStatus) return { servers: [] };
    try {
      const servers = await session.queryHandle.mcpServerStatus();
      return { servers };
    } catch (err) {
      const errMsg = reportError("MCP_STATUS_ERR", err, { engine: "claude", sessionId });
      return { servers: [], error: errMsg };
    }
  });

  ipcMain.handle("claude:supported-models", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session?.queryHandle?.supportedModels) return { models: [] };
    try {
      const models = await session.queryHandle.supportedModels();
      if (Array.isArray(models) && models.length > 0) {
        setClaudeModelsCache(models);
      }
      return { models };
    } catch (err) {
      const errMsg = reportError("SUPPORTED_MODELS_ERR", err, { engine: "claude", sessionId });
      return { models: [], error: errMsg };
    }
  });

  ipcMain.handle("claude:slash-commands", async (_event, sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session?.queryHandle?.supportedCommands) return { commands: [] };
    try {
      const commands = await session.queryHandle.supportedCommands();
      return { commands: commands ?? [] };
    } catch (err) {
      const errMsg = reportError("SLASH_COMMANDS_ERR", err, { engine: "claude", sessionId });
      return { commands: [], error: errMsg };
    }
  });

  ipcMain.handle("claude:models-cache:get", async () => {
    const cached = getClaudeModelsCache();
    return { models: cached.models, updatedAt: cached.updatedAt };
  });

  ipcMain.handle("claude:models-cache:revalidate", async (_event, options?: { cwd?: string }) => {
    return revalidateClaudeModelsCache(options?.cwd);
  });

  ipcMain.handle("claude:version", async () => {
    try {
      return { version: await getClaudeVersion() };
    } catch (err) {
      return { error: reportError("CLAUDE_VERSION_ERR", err, { engine: "claude" }) };
    }
  });

  ipcMain.handle("claude:binary-status", async () => {
    return getClaudeBinaryStatus();
  });

  ipcMain.handle("claude:scan-binaries", async () => {
    try {
      return await scanClaudeBinaries();
    } catch (error) {
      return { candidates: [], selectedPath: null, error: reportError("CLAUDE_BINARY_SCAN_ERR", error, { engine: "claude" }) };
    }
  });

  ipcMain.handle("claude:mcp-reconnect", async (_event, { sessionId, serverName }: { sessionId: string; serverName: string }) => {
    const session = sessions.get(sessionId);
    if (!session?.queryHandle) return { error: "No active session" };

    // Check if we have stored OAuth tokens for this server.
    // If yes, we need to restart the entire session because the SDK was started
    // without auth headers — reconnectMcpServer() can't inject new headers.
    const mcpServer = session.startOptions?.mcpServers?.find((s) => s.name === serverName);
    const hasNewToken = mcpServer?.url ? !!(await getMcpAuthHeaders(mcpServer.name, mcpServer.url)) : false;

    if (hasNewToken) {
      return restartSession(sessionId, getMainWindow);
    }

    // No new token — try regular reconnect
    if (!session.queryHandle.reconnectMcpServer) return { error: "Not supported" };
    try {
      await session.queryHandle.reconnectMcpServer(serverName);
      log("MCP_RECONNECT", `session=${sessionId.slice(0, 8)} server=${serverName}`);
      return { ok: true };
    } catch (err) {
      const errMsg = reportError("MCP_RECONNECT_ERR", err, { engine: "claude", sessionId, serverName });
      return { error: errMsg };
    }
  });

  // Restart the session with a new MCP server list (e.g., after add/remove)
  ipcMain.handle("claude:restart-session", async (_event, {
    sessionId,
    mcpServers,
    cwd,
    effort,
    model,
    memoryContext,
  }: {
    sessionId: string;
    mcpServers?: McpServerInput[];
    cwd?: string;
    effort?: StartOptions["effort"];
    model?: string;
    memoryContext?: { projectId: string };
  }) => {
    const current = sessions.get(sessionId);
    if (memoryContext && current?.startOptions) current.startOptions.memoryContext = memoryContext;
    return restartSession(sessionId, getMainWindow, mcpServers, cwd, effort, model);
  });
}

/** Stop all Claude sessions (called on app quit). Idempotent. */
export async function stopAll(): Promise<void> {
  const stopping: Promise<void>[] = [];
  for (const sessionId of sessions.keys()) {
    log("CLEANUP", `Closing Claude session ${sessionId.slice(0, 8)}`);
    stopping.push(stopSession(sessionId, "app-quit"));
  }
  const results = await Promise.allSettled(stopping);
  for (const result of results) if (result.status === "rejected") reportError("CLAUDE_STOP_ERR", result.reason);
  for (const sessionId of sessions.keys()) { unregisterMemorySession(sessionId); revokeProjectAppAgentSession(sessionId); }
  sessions.clear();
}
