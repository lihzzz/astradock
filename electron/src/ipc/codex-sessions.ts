/**
 * Codex app-server IPC handler.
 *
 * Manages the lifecycle of Codex sessions: spawn the `codex app-server` process,
 * perform the JSON-RPC initialize handshake, create/resume threads, forward
 * notifications to the renderer, and bridge approval requests.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import { spawn } from "child_process";
import crypto from "crypto";
import { log } from "../lib/logger";
import { safeSend } from "../lib/safe-send";
import { CodexRpcClient } from "../lib/codex-rpc";
import { getCodexBinaryPath, getCodexBinaryStatus, getCodexHome, getCodexVersion } from "../lib/codex-binary";
import { getAppSetting } from "../lib/app-settings";
import { reportError } from "../lib/error-utils";
import { captureEvent } from "../lib/posthog";
import {
  COMPUTER_USE_MCP_SERVER_NAME,
  getComputerUseMcpServer,
  getComputerUseRuntimeStatus,
  getCodexMcpServerOverrides,
} from "../lib/computer-use-runtime";
import { getHindsightCodexMcpOverrides, registerMemorySession, unregisterMemorySession, beforeMemorySend, observeCodexNotification, completeMemoryTurn } from "../lib/memory/service";
import { beginUsageTurn, endUsageTurn, stopUsageSession } from "../lib/usage";
import { getSessionRepository } from "../lib/session-service";
import type { SessionRuntimeLease } from "../lib/session-repository";
import type { SessionResumeSource } from "@shared/types/productivity";

import type {
  CodexServerNotification,
  CodexModel,
  CodexAccountResponse,
  CodexThreadStartResponse,
  CodexThreadResumeResponse,
  CodexTurnStartResponse,
  CodexInitializeResponse,
  CodexItemStartedNotification,
  CodexItemCompletedNotification,
  CodexThreadGoal,
  CodexThreadGoalGetResponse,
  CodexThreadGoalSetResponse,
  CodexThreadGoalClearResponse,
  CodexComputerUseStatus,
} from "@shared/types/codex";
import { isMethodNotFoundError, parseThreadGoal } from "@shared/lib/codex-goal";
import type { SkillsListResponse } from "@shared/types/codex-protocol/v2/SkillsListResponse";
import type { AppsListResponse } from "@shared/types/codex-protocol/v2/AppsListResponse";

// ── Session state ──

interface CodexSession {
  rpc: CodexRpcClient;
  internalId: string;
  threadId: string | null;
  /** Active turn id — needed for interrupt */
  activeTurnId: string | null;
  eventCounter: number;
  cwd: string;
  model?: string;
  /** Approval policy for the session — passed to turn/start and lazy thread/start */
  approvalPolicy?: string;
  /** Sandbox policy for the session — passed to lazy thread/start */
  sandbox?: string;
  goalSupport: "unknown" | "supported" | "unsupported";
  goal: CodexThreadGoal | null;
  goalMutation: Promise<void>;
  threadStart: Promise<string> | null;
  runtimeLease?: SessionRuntimeLease;
}

export type CodexGoalResult =
  | { supported: true; goal: CodexThreadGoal | null; error?: string }
  | { supported: false; goal: null; reason: "method-not-found"; error?: string };

import { SUPPORTED_SERVER_REQUESTS, isSupportedServerRequestMethod, listModelsWithConfigured, pickModelId } from "@shared/lib/codex-helpers";

const codexSessions = new Map<string, CodexSession>();

function assertCodexSessionActive(session: CodexSession): void {
  if (codexSessions.get(session.internalId) !== session) throw new Error("Codex session stopped");
  session.runtimeLease?.assertActive();
}

export async function stopForDeletion(sessionId: string): Promise<void> {
  stopUsageSession(sessionId);
  const session = codexSessions.get(sessionId);
  if (!session) return;
  await session.rpc.destroyAndWait();
  codexSessions.delete(sessionId);
  unregisterMemorySession(sessionId);
}

/** Expose the currently selected model for utility prompts (title/commit generation). */
export function getCodexSessionModel(internalId: string): string | undefined {
  return codexSessions.get(internalId)?.model;
}

/** Check the target project's account configuration before dispatching clipboard text. */
export async function hasConfiguredCodexAccount(cwd: string): Promise<boolean> {
  const proc = spawnCodexAppServer(await getCodexBinaryPath(), cwd);
  const rpc = new CodexRpcClient(proc);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const readAccount = async () => {
      await rpc.request<CodexInitializeResponse>("initialize", { clientInfo: getAppServerClientInfo(), capabilities: { experimentalApi: true } });
      rpc.notify("initialized", {});
      const response = await rpc.request<CodexAccountResponse>("account/read", { refreshToken: false });
      return !response.requiresOpenaiAuth || response.account !== null;
    };
    return await Promise.race([
      readAccount(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Account check timed out; retry after the agent starts")), 4_000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); rpc.destroy(); }
}

function getAppServerClientInfo(): { name: string; title: string; version: string } {
  const clientName = getAppSetting("codexClientName") || "AstraDock";
  return {
    name: clientName,
    title: clientName,
    version: app.getVersion(),
  };
}

function getCodexAppServerArgs(sessionId?: string): string[] {
  const args = ["app-server"];
  const computerUse = getComputerUseMcpServer();
  if (computerUse) {
    args.push("--enable", "computer_use");
    // Codex app-server supports -c overrides, so AstraDock can inject the
    // runtime without mutating the user's ~/.codex/config.toml.
    args.push(...getCodexMcpServerOverrides(computerUse));
  }
  if (sessionId) args.push(...getHindsightCodexMcpOverrides(sessionId));
  return args;
}

function getCodexAppServerEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_HOME: getCodexHome(),
    RUST_LOG: process.env.RUST_LOG ?? "warn",
  };
}

function spawnCodexAppServer(codexPath: string, cwd: string, sessionId?: string) {
  return spawn(codexPath, getCodexAppServerArgs(sessionId), {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: getCodexAppServerEnv(),
  });
}

interface CodexConfigReadResponse {
  config?: {
    features?: Record<string, unknown> | null;
  };
}

interface CodexMcpServerStatus {
  name?: string;
  serverInfo?: unknown;
  tools?: Record<string, unknown> | null;
  toolsError?: unknown;
}

interface CodexMcpServerStatusResponse {
  data?: CodexMcpServerStatus[];
}

async function getComputerUseStatus(): Promise<CodexComputerUseStatus> {
  const runtime = await getComputerUseRuntimeStatus();
  const enabled = runtime.enabled;
  const base: CodexComputerUseStatus = {
    enabled,
    featureEnabled: false,
    mcpConnected: false,
    mcpTools: [],
    ready: false,
  };

  if (!enabled || !runtime.installed) {
    return { ...base, error: runtime.error };
  }

  try {
    const codexPath = await getCodexBinaryPath();
    const [codexVersion] = await Promise.all([getCodexVersion()]);
    const proc = spawnCodexAppServer(codexPath, process.cwd());
    if (!proc.pid) throw new Error("Failed to spawn codex app-server process");

    const rpc = new CodexRpcClient(proc);
    try {
      const initResult = await rpc.request<CodexInitializeResponse>("initialize", {
        clientInfo: getAppServerClientInfo(),
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized", {});

      const [configResult, mcpResult] = await Promise.all([
        rpc.request<CodexConfigReadResponse>("config/read"),
        rpc.request<CodexMcpServerStatusResponse>("mcpServerStatus/list", {}, 120_000),
      ]);
      const cua = (mcpResult.data ?? []).find((server) => server.name === COMPUTER_USE_MCP_SERVER_NAME);
      const cuaTools = cua?.tools && typeof cua.tools === "object"
        ? Object.keys(cua.tools)
        : [];
      const featureEnabled = configResult.config?.features?.computer_use === true;
      const mcpConnected = !!cua?.serverInfo && cua?.toolsError == null;

      return {
        ...base,
        featureEnabled,
        mcpConnected,
        mcpTools: cuaTools,
        ready: enabled && featureEnabled && runtime.ready && mcpConnected && cuaTools.length > 0,
        codexPath,
        codexVersion,
        codexHome: initResult.codexHome,
      };
    } finally {
      rpc.destroy();
    }
  } catch (error) {
    return {
      ...base,
      error: reportError("CODEX_COMPUTER_USE_STATUS_ERR", error, { engine: "codex" }),
    };
  }
}

// pickModelId imported from @shared/lib/codex-helpers

function shortId(value: unknown, length = 8): string {
  return typeof value === "string" ? value.slice(0, length) : "n/a";
}

function shouldLogFullToolEvent(
  method: string,
  params: CodexItemStartedNotification | CodexItemCompletedNotification,
): boolean {
  if (method !== "item/started" && method !== "item/completed") return false;
  const { item } = params;
  return (
    item.type === "commandExecution" ||
    item.type === "fileChange" ||
    item.type === "mcpToolCall" ||
    item.type === "webSearch" ||
    item.type === "imageView"
  );
}

function summarizeCodexNotification(notification: CodexServerNotification): string {
  switch (notification.method) {
    case "turn/started": {
      const { turn } = notification.params;
      return `turn/started turn=${shortId(turn.id, 12)}`;
    }
    case "turn/completed": {
      const { turn } = notification.params;
      const errMsg = turn.error?.message;
      return `turn/completed turn=${shortId(turn.id, 12)} status=${turn.status}${typeof errMsg === "string" ? ` error="${errMsg.slice(0, 120)}"` : ""}`;
    }
    case "item/started":
    case "item/completed": {
      const { item } = notification.params;
      const status = "status" in item ? ` status=${item.status}` : "";
      const cmd = "command" in item ? ` cmd="${item.command.split("\n")[0].slice(0, 80)}"` : "";
      const exit = "exitCode" in item && item.exitCode != null ? ` exit=${item.exitCode}` : "";
      return `${notification.method} type=${item.type} id=${shortId(item.id, 12)}${status}${exit}${cmd}`;
    }
    case "item/agentMessage/delta": {
      const { delta, itemId } = notification.params;
      return `item/agentMessage/delta id=${shortId(itemId, 12)} len=${delta.length}`;
    }
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const { delta, itemId } = notification.params;
      return `${notification.method} id=${shortId(itemId, 12)} len=${delta.length}`;
    }
    case "item/commandExecution/outputDelta": {
      const { delta, itemId } = notification.params;
      return `item/commandExecution/outputDelta id=${shortId(itemId, 12)} len=${delta.length}`;
    }
    case "turn/plan/updated": {
      const { plan } = notification.params;
      return `turn/plan/updated steps=${plan.length}`;
    }
    case "thread/tokenUsage/updated": {
      const { tokenUsage } = notification.params;
      return `thread/tokenUsage/updated total=${tokenUsage.total.totalTokens} last_in=${tokenUsage.last.inputTokens} last_out=${tokenUsage.last.outputTokens}`;
    }
    case "thread/goal/updated":
      {
        const goal = parseThreadGoal((notification.params as { goal?: unknown })?.goal);
        return goal
          ? `thread/goal/updated status=${goal.status} updated=${goal.updatedAt}`
          : "thread/goal/updated malformed";
      }
    case "thread/goal/cleared":
      return `thread/goal/cleared thread=${shortId((notification.params as { threadId?: unknown })?.threadId, 12)}`;
    case "error": {
      const { error } = notification.params;
      return `error message="${error.message.slice(0, 180)}"`;
    }
    default:
      return notification.method;
  }
}

/** Start a thread only when a session was created without one (draft/lazy path). */
async function ensureCodexThread(session: CodexSession): Promise<string> {
  if (session.threadId) return session.threadId;
  if (session.threadStart) return session.threadStart;

  const start = (async () => {
    const threadParams: Record<string, unknown> = {
      cwd: session.cwd,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    };
    if (session.model) threadParams.model = session.model;
    if (session.approvalPolicy) threadParams.approvalPolicy = session.approvalPolicy;
    if (session.sandbox) threadParams.sandbox = session.sandbox;
    const threadResult = await session.rpc.request<CodexThreadStartResponse>("thread/start", threadParams);
    session.threadId = threadResult.thread.id;
    log("codex", ` Thread lazily started: session=${shortId(session.internalId, 12)} thread=${shortId(session.threadId, 12)}`);
    return session.threadId;
  })();
  session.threadStart = start;
  try {
    return await start;
  } finally {
    if (session.threadStart === start) session.threadStart = null;
  }
}

async function refreshGoal(
  session: CodexSession,
  getMainWindow?: () => BrowserWindow | null,
): Promise<CodexGoalResult> {
  const threadId = await ensureCodexThread(session);
  try {
    const result = await session.rpc.request<CodexThreadGoalGetResponse>("thread/goal/get", { threadId });
    const goal = result?.goal == null ? null : parseThreadGoal(result.goal);
    if (result?.goal != null && !goal) {
      session.goalSupport = "supported";
      return { supported: true, goal: session.goal, error: "Codex returned a malformed Goal snapshot" };
    }
    session.goalSupport = "supported";
    session.goal = goal;
    if (goal && getMainWindow) {
      safeSend(getMainWindow, "codex:event", {
        _sessionId: session.internalId,
        method: "thread/goal/updated",
        params: { threadId, turnId: null, goal },
      });
    }
    return { supported: true, goal };
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      session.goalSupport = "unsupported";
      session.goal = null;
      return { supported: false, goal: null, reason: "method-not-found" };
    }
    return {
      supported: true,
      goal: session.goal,
      error: reportError("CODEX_GOAL_GET_ERR", error, { engine: "codex", sessionId: session.internalId }),
    };
  }
}

function withGoalMutation<T>(session: CodexSession, operation: () => Promise<T>): Promise<T> {
  const previous = session.goalMutation;
  let release!: () => void;
  session.goalMutation = new Promise<void>((resolve) => { release = resolve; });
  return previous.catch(() => undefined).then(operation).finally(release);
}

function validateGoalInput(input: {
  objective?: unknown;
  tokenBudget?: unknown;
  status?: unknown;
}): string | null {
  if (input.objective !== undefined && input.objective !== null &&
      (typeof input.objective !== "string" || input.objective.trim().length === 0)) {
    return "Goal objective must not be empty";
  }
  if (input.tokenBudget !== undefined && input.tokenBudget !== null &&
      (typeof input.tokenBudget !== "number" || !Number.isInteger(input.tokenBudget) || input.tokenBudget <= 0)) {
    return "Goal token budget must be a positive integer or null";
  }
  if (input.status !== undefined && input.status !== null &&
      input.status !== "active" && input.status !== "paused") {
    return "Goal status must be active or paused";
  }
  return null;
}

/** Wire up all RPC event handlers for a Codex session (shared by start and resume). */
function setupCodexHandlers(
  rpc: CodexRpcClient,
  session: CodexSession,
  internalId: string,
  getMainWindow: () => BrowserWindow | null,
): void {
  rpc.onStderr = (text) => {
    log("codex", `[stderr:${internalId.slice(0, 8)}] ${text.slice(0, 500)}`);
  };

  rpc.onNotification = (msg) => {
    // Cast to the generated discriminated union for typed access
    const notification = msg as CodexServerNotification;
    session.eventCounter++;
    log(
      "codex",
      `[evt:${internalId.slice(0, 8)}] #${session.eventCounter} ${summarizeCodexNotification(notification)}`,
    );
    if (
      (notification.method === "item/started" || notification.method === "item/completed") &&
      shouldLogFullToolEvent(notification.method, notification.params)
    ) {
      log("CODEX_EVENT_FULL", {
        session: internalId.slice(0, 8),
        method: notification.method,
        item: notification.params.item,
      });
    }

    if (notification.method === "thread/goal/updated") {
      const params = notification.params;
      const goal = parseThreadGoal(params.goal);
      if (!goal || goal.threadId !== session.threadId) {
        log("codex", ` Ignoring malformed or cross-thread thread/goal/updated for session=${internalId}`);
        return;
      }
      if (!session.goal || goal.updatedAt >= session.goal.updatedAt) {
        session.goal = goal;
        session.goalSupport = "supported";
      }
    } else if (notification.method === "thread/goal/cleared") {
      if (notification.params.threadId === session.threadId) {
        session.goal = null;
        session.goalSupport = "supported";
      } else {
        log("codex", ` Ignoring cross-thread thread/goal/cleared for session=${internalId}`);
        return;
      }
    }

    // Track active turn from turn events
    if (notification.method === "turn/started") {
      beginUsageTurn(internalId, notification.params.turn.id);
      session.activeTurnId = notification.params.turn.id;
    } else if (notification.method === "turn/completed") {
      endUsageTurn(internalId, notification.params.turn.id);
      session.activeTurnId = null;
      void completeMemoryTurn(internalId);
    } else if (notification.method === "error" && !notification.params.willRetry) {
      endUsageTurn(internalId, notification.params.turnId);
    }

    observeCodexNotification(internalId, notification.method, notification.params as Record<string, unknown>);

    safeSend(getMainWindow, "codex:event", {
      _sessionId: internalId,
      method: notification.method,
      params: notification.params,
    });
  };

  rpc.onServerRequest = (msg) => {
    log(
      "codex",
      `[srvreq:${internalId.slice(0, 8)}] ${msg.method} id=${msg.id}`,
    );
    if (isSupportedServerRequestMethod(msg.method)) {
      safeSend(getMainWindow, "codex:approval_request", {
        _sessionId: internalId,
        rpcId: msg.id,
        method: msg.method,
        // Spread typed params — the renderer narrows by method
        ...(msg.params as Record<string, unknown>),
      });
    } else {
      log("codex", ` Unknown server request: ${msg.method}, auto-declining`);
      rpc.respondToServerError(msg.id, -32601, `Unsupported server request: ${msg.method}`);
    }
  };

  rpc.onExit = (code, signal) => {
    stopUsageSession(internalId);
    log("codex", ` Process exited: code=${code} signal=${signal} session=${internalId}`);
    codexSessions.delete(internalId);
    unregisterMemorySession(internalId);
    safeSend(getMainWindow, "codex:exit", {
      _sessionId: internalId,
      code,
      signal,
    });
  };
}

// ── Registration ──

export function register(getMainWindow: () => BrowserWindow | null): void {
  // Forward renderer-side Codex logs to main process log file.
  ipcMain.on("codex:log", (_event, label: string, data: unknown) => {
    log(`CODEX_UI:${label}`, data);
  });

  // ─── codex:start ───
  ipcMain.handle(
    "codex:start",
    async (
      _,
      options: {
        cwd: string;
        model?: string;
        approvalPolicy?: string;
        sandbox?: string;
        memoryContext?: { projectId: string };
        personality?: string;
        collaborationMode?: { mode: string; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } };
      },
    ) => {
      const internalId = crypto.randomUUID();
      let runtimeLease: SessionRuntimeLease | undefined;

      try {
        if (options.memoryContext?.projectId) runtimeLease = await getSessionRepository().bindProjectRuntime(options.memoryContext.projectId, internalId, () => stopForDeletion(internalId));
        const codexPath = await getCodexBinaryPath();
        runtimeLease?.assertActive();
        log("codex",` Starting app-server: ${codexPath} (session=${internalId})`);

        if (options.memoryContext?.projectId) registerMemorySession(internalId, options.memoryContext.projectId, "codex");
        const proc = spawnCodexAppServer(codexPath, options.cwd, internalId);
        if (runtimeLease) proc.once("exit", runtimeLease.release);

        if (!proc.pid) {
          throw new Error("Failed to spawn codex app-server process");
        }
        log("codex",` Spawned pid=${proc.pid} for session=${internalId}`);

        const rpc = new CodexRpcClient(proc);
        const session: CodexSession = {
          rpc,
          internalId,
          threadId: null,
          activeTurnId: null,
          eventCounter: 0,
          cwd: options.cwd,
          model: undefined,
          approvalPolicy: options.approvalPolicy,
          sandbox: options.sandbox,
          goalSupport: "unknown",
          goal: null,
          goalMutation: Promise.resolve(),
          threadStart: null,
          runtimeLease,
        };
        codexSessions.set(internalId, session);
        setupCodexHandlers(rpc, session, internalId, getMainWindow);

        // ── Initialize handshake ──
        const initResult = await rpc.request<CodexInitializeResponse>("initialize", {
          clientInfo: getAppServerClientInfo(),
          capabilities: {
            experimentalApi: true,
          },
        });
        assertCodexSessionActive(session);
        rpc.notify("initialized", {});
        log("codex",` Initialized: ${JSON.stringify(initResult).slice(0, 200)}`);

        // ── Check auth status ──
        const authResult = await rpc.request<CodexAccountResponse>("account/read", { refreshToken: false });
        assertCodexSessionActive(session);

        const needsAuth = authResult.requiresOpenaiAuth && !authResult.account;
        if (needsAuth) {
          // Notify renderer that auth is required — don't start thread yet
          safeSend(getMainWindow, "codex:event", {
            _sessionId: internalId,
            method: "codex:auth_required",
            params: { requiresOpenaiAuth: authResult.requiresOpenaiAuth },
          });
          return {
            sessionId: internalId,
            needsAuth: true,
            account: authResult.account,
          };
        }

        // ── Fetch available models ──
        let models: CodexModel[] = [];
        let selectedModel: string | undefined;
        try {
          models = await listModelsWithConfigured(rpc);
        } catch (err) {
          reportError("CODEX_MODEL_LIST_ERR", err, { engine: "codex", sessionId: internalId });
        }
        assertCodexSessionActive(session);
        // Honor explicitly requested models as-is: custom providers accept
        // model IDs that never appear in the account catalog.
        selectedModel = options.model?.trim() || pickModelId(undefined, models);
        if (selectedModel) {
          session.model = selectedModel;
        }

        // ── Start a thread ──
        // ThreadStartParams: experimentalRawEvents and persistExtendedHistory are required booleans
        const threadParams: Record<string, unknown> = {
          cwd: options.cwd,
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        };
        if (selectedModel) threadParams.model = selectedModel;
        if (options.approvalPolicy) threadParams.approvalPolicy = options.approvalPolicy;
        if (options.sandbox) threadParams.sandbox = options.sandbox;
        if (options.personality) threadParams.personality = options.personality;
        // collaborationMode is set per-turn via turn/start, not on thread/start

        const threadResult = await rpc.request<CodexThreadStartResponse>("thread/start", threadParams);
        assertCodexSessionActive(session);
        session.threadId = threadResult.thread.id;
        log("codex",` Thread started: ${session.threadId}`);

        void captureEvent("session_created", { engine: "codex", model: selectedModel });

        return {
          sessionId: internalId,
          threadId: session.threadId,
          models,
          selectedModel,
          account: authResult.account,
          needsAuth: false,
        };
      } catch (err) {
        void captureEvent("session_error", { engine: "codex", phase: "start" });
        const errMsg = reportError("CODEX_START_ERR", err, { engine: "codex", sessionId: internalId });
        try { await stopForDeletion(internalId); }
        catch (stopError) { reportError("CODEX_START_STOP_ERR", stopError, { engine: "codex", sessionId: internalId }); }
        if (!codexSessions.has(internalId)) { runtimeLease?.release(); unregisterMemorySession(internalId); }
        return { error: errMsg };
      }
    },
  );

  // ─── codex:send (start a turn) ───
  ipcMain.handle(
    "codex:send",
    async (
      _,
      data: {
        sessionId: string;
        text: string;
        images?: Array<{ type: "image"; url: string } | { type: "localImage"; path: string }>;
        effort?: string;
        collaborationMode?: { mode: string; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } };
      },
    ) => {
      const session = codexSessions.get(data.sessionId);
      if (!session) {
        log("codex", ` Send rejected: session not found id=${shortId(data.sessionId, 12)}`);
        return { error: "Session not found" };
      }
      if (!session.threadId) {
        try {
          await ensureCodexThread(session);
        } catch (err) {
          const msg = reportError("CODEX_THREAD_START_ERR", err, { engine: "codex", sessionId: data.sessionId });
          return { error: msg };
        }
      }

      log(
        "codex",
        ` Send requested: session=${shortId(data.sessionId, 12)} thread=${shortId(session.threadId, 12)} text_len=${data.text.length} images=${data.images?.length ?? 0} effort=${data.effort ?? "default"} collab=${data.collaborationMode?.mode ?? "none"} approval=${session.approvalPolicy ?? "default"} activeTurn=${session.activeTurnId ? shortId(session.activeTurnId, 12) : "none"}`,
      );

      try {
        const memory = await beforeMemorySend(data.sessionId, data.text);
        assertCodexSessionActive(session);
        const input: unknown[] = [{ type: "text", text: memory.text }];
        if (data.images) {
          input.push(...data.images);
        }

        // TurnStartParams: only threadId and input are required; all other fields are optional.
        // Only include fields we actually have values for.
        const turnParams: Record<string, unknown> = {
          threadId: session.threadId,
          input,
          ...(session.model ? { model: session.model } : {}),
          ...(data.effort ? { effort: data.effort } : {}),
          ...(data.collaborationMode ? { collaborationMode: data.collaborationMode } : {}),
          ...(session.approvalPolicy ? { approvalPolicy: session.approvalPolicy } : {}),
        };


        const result = await session.rpc.request<CodexTurnStartResponse>("turn/start", turnParams);
        session.activeTurnId = result.turn.id;
        log(
          "codex",
          ` Send accepted: session=${shortId(data.sessionId, 12)} turn=${shortId(result.turn.id, 12)}`,
        );
        return { turnId: result.turn.id };
      } catch (err) {
        const errMsg = reportError("CODEX_SEND_ERR", err, { engine: "codex", sessionId: data.sessionId });
        return { error: errMsg };
      }
    },
  );

  // ─── codex:stop ───
  ipcMain.handle("codex:stop", async (_, sessionId: string) => {
    await stopForDeletion(sessionId);
    log("codex",` Session stopped: ${sessionId}`);
  });

  // ─── codex:interrupt ───
  ipcMain.handle("codex:interrupt", async (_, sessionId: string) => {
    const session = codexSessions.get(sessionId);
    if (!session?.threadId || !session.activeTurnId) return { error: "No active turn" };

    try {
      await session.rpc.request("turn/interrupt", {
        threadId: session.threadId,
        turnId: session.activeTurnId,
      });
      return {};
    } catch (err) {
      return { error: reportError("CODEX_INTERRUPT_ERR", err, { engine: "codex", sessionId }) };
    }
  });

  // ─── codex:approval_response ───
  ipcMain.handle(
    "codex:approval_response",
    async (
      _,
      data: {
        sessionId: string;
        rpcId: string | number;
        decision: string;
        acceptSettings?: { forSession?: boolean };
      },
    ) => {
      const session = codexSessions.get(data.sessionId);
      if (!session) return { error: "Session not found" };

      try {
        const result: Record<string, unknown> = { decision: data.decision };
        if (data.acceptSettings) result.acceptSettings = data.acceptSettings;
        session.rpc.respondToServer(data.rpcId, result);
        return { ok: true };
      } catch (err) {
        return {
          error: reportError("CODEX_APPROVAL_RESPONSE_ERR", err, {
            engine: "codex",
            sessionId: data.sessionId,
            rpcId: data.rpcId,
          }),
        };
      }
    },
  );

  // ─── codex:user_input_response ───
  ipcMain.handle(
    "codex:user_input_response",
    async (
      _,
      data: {
        sessionId: string;
        rpcId: string | number;
        answers: Record<string, { answers: string[] }>;
      },
    ) => {
      const session = codexSessions.get(data.sessionId);
      if (!session) return { error: "Session not found" };
      try {
        session.rpc.respondToServer(data.rpcId, { answers: data.answers });
        return { ok: true };
      } catch (err) {
        return {
          error: reportError("CODEX_USER_INPUT_RESPONSE_ERR", err, {
            engine: "codex",
            sessionId: data.sessionId,
            rpcId: data.rpcId,
          }),
        };
      }
    },
  );

  // ─── codex:server_request_error ───
  ipcMain.handle(
    "codex:server_request_error",
    async (
      _,
      data: {
        sessionId: string;
        rpcId: string | number;
        code: number;
        message: string;
      },
    ) => {
      const session = codexSessions.get(data.sessionId);
      if (!session) return { error: "Session not found" };
      try {
        session.rpc.respondToServerError(data.rpcId, data.code, data.message);
        return { ok: true };
      } catch (err) {
        return {
          error: reportError("CODEX_SERVER_REQUEST_ERROR_ERR", err, {
            engine: "codex",
            sessionId: data.sessionId,
            rpcId: data.rpcId,
          }),
        };
      }
    },
  );

  // ─── codex:compact ───
  ipcMain.handle("codex:compact", async (_, sessionId: string) => {
    const session = codexSessions.get(sessionId);
    if (!session?.threadId) return { error: "No active thread" };

    try {
      await session.rpc.request("thread/compact/start", { threadId: session.threadId });
      return {};
    } catch (err) {
      return { error: reportError("CODEX_COMPACT_ERR", err, { engine: "codex", sessionId }) };
    }
  });

  // ─── codex:goal-get ───
  ipcMain.handle("codex:goal-get", async (_, data: { sessionId: string }): Promise<CodexGoalResult> => {
    const session = codexSessions.get(data.sessionId);
    if (!session) return { supported: true, goal: null, error: "Session not found" };
    try {
      return await withGoalMutation(session, () => refreshGoal(session, getMainWindow));
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        session.goalSupport = "unsupported";
        return { supported: false, goal: null, reason: "method-not-found" };
      }
      return {
        supported: true,
        goal: session.goal,
        error: reportError("CODEX_GOAL_GET_ERR", error, { engine: "codex", sessionId: data.sessionId }),
      };
    }
  });

  // ─── codex:goal-set ───
  ipcMain.handle("codex:goal-set", async (_, data: {
    sessionId: string;
    objective?: string | null;
    tokenBudget?: number | null;
    status?: "active" | "paused";
  }): Promise<CodexGoalResult> => {
    const session = codexSessions.get(data.sessionId);
    if (!session) return { supported: true, goal: null, error: "Session not found" };
    const validationError = validateGoalInput(data);
    if (validationError) return { supported: true, goal: session.goal, error: validationError };
    try {
      return await withGoalMutation(session, async () => {
        const threadId = await ensureCodexThread(session);
        const params: Record<string, unknown> = { threadId };
        if (data.objective !== undefined) params.objective = data.objective === null ? null : data.objective.trim();
        if (data.tokenBudget !== undefined) params.tokenBudget = data.tokenBudget;
        if (data.status !== undefined) params.status = data.status;
        const result = await session.rpc.request<CodexThreadGoalSetResponse>("thread/goal/set", params);
        const goal = parseThreadGoal(result?.goal);
        if (!goal) return { supported: true, goal: session.goal, error: "Codex returned a malformed Goal snapshot" };
        session.goalSupport = "supported";
        session.goal = goal;
        return { supported: true, goal };
      });
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        session.goalSupport = "unsupported";
        return { supported: false, goal: null, reason: "method-not-found" };
      }
      return { supported: true, goal: session.goal, error: reportError("CODEX_GOAL_SET_ERR", error, { engine: "codex", sessionId: data.sessionId }) };
    }
  });

  // ─── codex:goal-clear ───
  ipcMain.handle("codex:goal-clear", async (_, data: { sessionId: string }): Promise<CodexGoalResult> => {
    const session = codexSessions.get(data.sessionId);
    if (!session) return { supported: true, goal: null, error: "Session not found" };
    try {
      return await withGoalMutation(session, async () => {
        const threadId = await ensureCodexThread(session);
        await session.rpc.request<CodexThreadGoalClearResponse>("thread/goal/clear", { threadId });
        session.goalSupport = "supported";
        session.goal = null;
        return { supported: true, goal: null };
      });
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        session.goalSupport = "unsupported";
        return { supported: false, goal: null, reason: "method-not-found" };
      }
      return { supported: true, goal: session.goal, error: reportError("CODEX_GOAL_CLEAR_ERR", error, { engine: "codex", sessionId: data.sessionId }) };
    }
  });

  // ─── codex:list-skills ───
  ipcMain.handle("codex:list-skills", async (_, sessionId: string) => {
    const session = codexSessions.get(sessionId);
    if (!session) return { skills: [], error: "Session not found" };
    try {
      const result = await session.rpc.request<SkillsListResponse>("skills/list", {
        cwds: [session.cwd],
      });
      return { skills: result.data ?? [] };
    } catch (err) {
      const errMsg = reportError("CODEX_SKILLS_LIST_ERR", err, { engine: "codex", sessionId });
      return { skills: [], error: errMsg };
    }
  });

  // ─── codex:list-apps ───
  ipcMain.handle("codex:list-apps", async (_, sessionId: string) => {
    const session = codexSessions.get(sessionId);
    if (!session) return { apps: [], error: "Session not found" };
    try {
      const result = await session.rpc.request<AppsListResponse>("app/list", {});
      return { apps: result.data ?? [] };
    } catch (err) {
      const errMsg = reportError("CODEX_APPS_LIST_ERR", err, { engine: "codex", sessionId });
      return { apps: [], error: errMsg };
    }
  });

  // ─── codex:list-models ───
  ipcMain.handle("codex:list-models", async () => {
    // Try to use any active session's RPC first
    for (const session of codexSessions.values()) {
      if (session.rpc.isAlive) {
        try {
          return { models: await listModelsWithConfigured(session.rpc) };
        } catch {
          continue;
        }
      }
    }

    // No live session: spawn a short-lived app-server process and fetch model/list.
    try {
      const codexPath = await getCodexBinaryPath();
      const proc = spawnCodexAppServer(codexPath, process.cwd());
      if (!proc.pid) {
        throw new Error("Failed to spawn codex app-server process");
      }

      const rpc = new CodexRpcClient(proc);
      try {
        await rpc.request<CodexInitializeResponse>("initialize", {
          clientInfo: getAppServerClientInfo(),
          capabilities: { experimentalApi: true },
        });
        rpc.notify("initialized", {});
        return { models: await listModelsWithConfigured(rpc) };
      } finally {
        rpc.destroy();
      }
    } catch (err) {
      return { models: [], error: reportError("CODEX_MODELS_SPAWN_ERR", err, { engine: "codex" }) };
    }
  });

  // ─── codex:auth-status ───
  ipcMain.handle("codex:auth-status", async () => {
    for (const session of codexSessions.values()) {
      if (session.rpc.isAlive) {
        try {
          return await session.rpc.request("account/read", { refreshToken: false });
        } catch {
          continue;
        }
      }
    }
    return { account: null, requiresOpenaiAuth: true };
  });

  // ─── codex:login ───
  ipcMain.handle(
    "codex:login",
    async (
      _,
      data: {
        sessionId: string;
        type: "apiKey" | "chatgpt";
        apiKey?: string;
      },
    ) => {
      const session = codexSessions.get(data.sessionId);
      if (!session) return { error: "Session not found" };

      try {
        const params: Record<string, unknown> = { type: data.type };
        if (data.type === "apiKey" && data.apiKey) {
          params.apiKey = data.apiKey;
        }
        const result = await session.rpc.request("account/login/start", params, 60000);
        return result;
      } catch (err) {
        return { error: reportError("CODEX_LOGIN_ERR", err, { engine: "codex", sessionId: data.sessionId }) };
      }
    },
  );

  // ─── codex:resume (restart process + resume thread) ───
  ipcMain.handle(
    "codex:resume",
    async (
      _,
      data: {
        cwd: string;
        threadId: string;
        model?: string;
        approvalPolicy?: string;
        sandbox?: string;
        memoryContext?: { projectId: string };
        source: SessionResumeSource;
      },
    ) => {
      const internalId = crypto.randomUUID();
      let runtimeLease: SessionRuntimeLease | undefined;

      try {
        runtimeLease = await getSessionRepository().bindRuntime(data.source, "codex", internalId, () => stopForDeletion(internalId));
        const codexPath = await getCodexBinaryPath();
        runtimeLease.assertActive();
        log("codex",` Resuming thread ${data.threadId} in new process (session=${internalId})`);

        if (data.memoryContext?.projectId) registerMemorySession(internalId, data.memoryContext.projectId, "codex");
        const proc = spawnCodexAppServer(codexPath, data.cwd, internalId);
        proc.once("exit", runtimeLease.release);
        const rpc = new CodexRpcClient(proc);
        if (!proc.pid) throw new Error("Failed to spawn codex app-server");
        const session: CodexSession = {
          rpc,
          internalId,
          threadId: null,
          activeTurnId: null,
          eventCounter: 0,
          cwd: data.cwd,
          model: data.model,
          approvalPolicy: data.approvalPolicy,
          sandbox: data.sandbox,
          goalSupport: "unknown",
          goal: null,
          goalMutation: Promise.resolve(),
          threadStart: null,
          runtimeLease,
        };
        codexSessions.set(internalId, session);
        setupCodexHandlers(rpc, session, internalId, getMainWindow);

        // Initialize
        await rpc.request<CodexInitializeResponse>("initialize", {
          clientInfo: getAppServerClientInfo(),
          capabilities: { experimentalApi: true },
        });
        assertCodexSessionActive(session);
        rpc.notify("initialized", {});

        // Resume thread — persistExtendedHistory is required by ThreadResumeParams
        const threadParams: Record<string, unknown> = {
          threadId: data.threadId,
          persistExtendedHistory: false,
        };
        if (data.approvalPolicy) threadParams.approvalPolicy = data.approvalPolicy;
        if (data.sandbox) threadParams.sandbox = data.sandbox;

        const threadResult = await rpc.request<CodexThreadResumeResponse>("thread/resume", threadParams);
        assertCodexSessionActive(session);
        session.threadId = threadResult.thread.id;
        log("codex",` Thread resumed: ${session.threadId}`);
        const goal = await refreshGoal(session, getMainWindow);
        assertCodexSessionActive(session);

        void captureEvent("session_revived", { engine: "codex", success: true });
        return { sessionId: internalId, threadId: session.threadId, goal: goal.goal, goalSupported: goal.supported };
      } catch (err) {
        void captureEvent("session_revived", { engine: "codex", success: false });
        const errMsg = reportError("CODEX_RESUME_ERR", err, { engine: "codex", sessionId: internalId });
        try { await stopForDeletion(internalId); }
        catch (stopError) { reportError("CODEX_RESUME_STOP_ERR", stopError, { engine: "codex", sessionId: internalId }); }
        if (!codexSessions.has(internalId)) {
          runtimeLease?.release();
          unregisterMemorySession(internalId);
        }
        return { error: errMsg };
      }
    },
  );

  // ─── codex:set-model ───
  ipcMain.handle(
    "codex:set-model",
    async (_, data: { sessionId: string; model: string }) => {
      const session = codexSessions.get(data.sessionId);
      if (!session) return { error: "Session not found" };
      // Store model for next turn/start override
      session.model = data.model;
      return {};
    },
  );

  // ─── codex:version ───
  ipcMain.handle("codex:version", async () => {
    try {
      return { version: await getCodexVersion() };
    } catch (err) {
      return { error: reportError("CODEX_VERSION_ERR", err, { engine: "codex" }) };
    }
  });

  // ─── codex:binary-status ───
  ipcMain.handle("codex:binary-status", async () => {
    return getCodexBinaryStatus();
  });

  // ─── codex:computer-use-status ───
  ipcMain.handle("codex:computer-use-status", async () => getComputerUseStatus());
}

/** Stop all Codex sessions (called on app quit). */
export function stopAll(): void {
  for (const [id, session] of codexSessions) {
    stopUsageSession(id);
    session.rpc.destroy();
    codexSessions.delete(id);
    unregisterMemorySession(id);
  }
}
