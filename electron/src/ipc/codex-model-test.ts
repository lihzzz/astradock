import { app, ipcMain } from "electron";
import { spawnExecutable } from "../lib/command-launch";
import { reportError } from "../lib/error-utils";
import { getAppSetting } from "../lib/app-settings";
import { getCodexBinaryPath, getCodexHome } from "../lib/codex-binary";
import { log } from "../lib/logger";
import { isRecord } from "../lib/productivity-errors";
import { CodexRpcClient } from "../lib/codex-rpc";
import { getCodexFingerprintTarget } from "./codex-sessions";
import { isMethodNotFoundError } from "@shared/lib/codex-goal";
import { CODEX_CANDY_PROMPT, gradeCodexCandyResponse } from "@shared/lib/codex-model-test";
import type {
  CodexCandyReasoningEffort,
  CodexCandyTestRequest,
  CodexCandyTestResult,
  CodexCandyTestSample,
} from "@shared/types/codex-model-test";
import type {
  CodexInitializeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
} from "@shared/types/codex";

const DEFAULT_TEST_COUNT = 3;
const MAX_TEST_COUNT = 10;
const TEST_TIMEOUT_MS = 5 * 60 * 1000;
const MESSAGE_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "hookPrompt"]);
const EFFORTS: ReadonlyArray<CodexCandyReasoningEffort> =
  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

interface TestState {
  threadId: string;
  response: string | null;
  otherResponses: string[];
  turnId: string | null;
  usage: TokenUsage | null;
  error: string | null;
  done: boolean;
  timedOut: boolean;
  elapsedMs: number;
}

interface TestThreadResponse extends Omit<CodexThreadStartResponse, "thread" | "reasoningEffort"> {
  thread: { id: string; path: string | null; ephemeral?: boolean; forkedFromId?: string | null };
  reasoningEffort: CodexCandyReasoningEffort | null;
}

interface TargetThread {
  id: string;
  model: string;
  provider: string;
  cwd: string;
  effort: CodexCandyReasoningEffort | null;
  lastTurnId: string;
  lastTurnIds: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTestCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TEST_COUNT;
  return Math.max(1, Math.min(MAX_TEST_COUNT, Math.floor(value)));
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const reasoningOutputTokens = value.reasoningOutputTokens;
  const isFiniteNumber = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
  if (!isFiniteNumber(inputTokens) || !isFiniteNumber(outputTokens) || !isFiniteNumber(reasoningOutputTokens)) {
    return null;
  }
  return { inputTokens, outputTokens, reasoningOutputTokens };
}

function finish(state: TestState, error: string | null = null): void {
  if (state.done) return;
  state.done = true;
  state.error = error;
  if (!error && !(state.response ?? state.otherResponses.join("\n"))) {
    state.error = "The model returned no final text.";
  }
}

function setupTestNotifications(rpc: CodexRpcClient, states: TestState[]): void {
  rpc.onNotification = ({ method, params }) => {
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const state = threadId ? states.find((item) => item.threadId === threadId) : undefined;
    if (!state || state.done) return;

    const eventTurnId = typeof params.turnId === "string" ? params.turnId : null;
    if (state.turnId && eventTurnId && state.turnId !== eventTurnId) return;

    if (method === "turn/started") {
      if (isRecord(params.turn) && typeof params.turn.id === "string") state.turnId ??= params.turn.id;
    } else if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params.item) ? params.item : {};
      const itemType = typeof item.type === "string" ? item.type : "unknown";
      if (!MESSAGE_ITEMS.has(itemType)) {
        finish(state, `The model attempted to use a tool (${itemType}); the sample was rejected.`);
      } else if (method === "item/completed" && itemType === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer" || item.phase === "final") state.response = item.text;
        else if (!item.phase) state.otherResponses.push(item.text);
      }
    } else if (method === "thread/tokenUsage/updated") {
      const usage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
      state.usage = parseTokenUsage(usage?.last);
    } else if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : {};
      if (state.turnId && typeof turn.id === "string" && turn.id !== state.turnId) return;
      state.turnId ??= typeof turn.id === "string" ? turn.id : null;
      finish(state, turn.status === "completed" ? null : `The test turn ended with status: ${String(turn.status ?? "unknown")}`);
    } else if (method === "error" && !params.willRetry) {
      const error = isRecord(params.error) ? params.error : {};
      finish(state, typeof error.message === "string" ? error.message : "Codex inference failed.");
    }
  };

  rpc.onServerRequest = (msg) => {
    rpc.respondToServerError(msg.id, -32601, `Model test refused server request: ${msg.method}`);
    for (const state of states) {
      if (typeof msg.params.threadId !== "string" || state.threadId === msg.params.threadId) {
        finish(state, `The model requested ${msg.method}; the sample was rejected.`);
      }
    }
  };
}

async function readTargetThread(rpc: CodexRpcClient, sessionId: string): Promise<TargetThread> {
  const hints = getCodexFingerprintTarget(sessionId);
  if (!hints) throw new Error("The current Codex session is unavailable. Start a session first.");

  const response = await rpc.request<unknown>("thread/read", { threadId: hints.threadId, includeTurns: false });
  const thread = isRecord(response) && isRecord(response.thread) ? response.thread : {};
  if (thread.id !== hints.threadId || thread.ephemeral || typeof thread.path !== "string" || !thread.path) {
    throw new Error("The current session cannot be forked because it has no persistent rollout history.");
  }

  const model = typeof thread.model === "string" && thread.model ? thread.model : hints.model;
  const provider = typeof thread.modelProvider === "string" && thread.modelProvider ? thread.modelProvider : hints.provider;
  const cwd = typeof thread.cwd === "string" && thread.cwd ? thread.cwd : hints.cwd;
  const effortValue = thread.reasoningEffort ?? hints.effort;
  const effort = EFFORTS.find((value) => value === effortValue) ?? null;
  if (!model || !provider || !cwd || (effortValue != null && !effort)) {
    throw new Error("The current session's model, provider, or reasoning effort could not be confirmed.");
  }

  let turns: unknown[];
  try {
    const listed = await rpc.request<unknown>("thread/turns/list", {
      threadId: hints.threadId,
      limit: 6,
      itemsView: "notLoaded",
      sortDirection: "desc",
    });
    turns = isRecord(listed) && Array.isArray(listed.data) ? listed.data : [];
  } catch (error) {
    if (!isMethodNotFoundError(error)) throw error;
    const legacy = await rpc.request<unknown>("thread/read", { threadId: hints.threadId, includeTurns: true });
    turns = isRecord(legacy) && isRecord(legacy.thread) && Array.isArray(legacy.thread.turns)
      ? [...legacy.thread.turns].reverse()
      : [];
  }

  const lastTurnIds = turns.flatMap((turn) => isRecord(turn) && typeof turn.id === "string"
    && ["completed", "interrupted", "failed"].includes(String(turn.status)) ? [turn.id] : []).slice(0, 3);
  if (!lastTurnIds.length) {
    throw new Error("The current session has no completed turn to fork. Wait for the current response to finish.");
  }

  return { id: hints.threadId, model, provider, cwd, effort, lastTurnId: lastTurnIds[0], lastTurnIds };
}

function sampleFromState(sampleId: number, state: TestState, elapsedMs: number): CodexCandyTestSample {
  const response = state.response ?? state.otherResponses.join("\n");
  const passed = !state.error && gradeCodexCandyResponse(response);
  const seconds = elapsedMs / 1000;
  return {
    sampleId,
    threadId: state.threadId,
    prompt: CODEX_CANDY_PROMPT,
    response,
    passed,
    elapsedMs,
    inputTokens: state.usage?.inputTokens ?? null,
    outputTokens: state.usage?.outputTokens ?? null,
    reasoningOutputTokens: state.usage?.reasoningOutputTokens ?? null,
    tps: state.usage && seconds > 0 ? state.usage.outputTokens / seconds : null,
    ...(state.error ? { error: state.error } : {}),
  };
}

async function runCandyTest(request: CodexCandyTestRequest): Promise<CodexCandyTestResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const requestedTests = normalizeTestCount(request.tests);
  const hints = request.sessionId ? getCodexFingerprintTarget(request.sessionId) : null;
  if (request.sessionId && !hints) throw new Error("The current Codex session is unavailable. Start a session first.");

  const cwd = hints?.cwd ?? request.cwd ?? process.cwd();
  const clientName = getAppSetting("codexClientName") || "AstraDock";
  const proc = spawnExecutable(await getCodexBinaryPath(), ["app-server", "-c", "notify=[]", "-c", "features.hooks=false"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      CODEX_HOME: getCodexHome(),
      RUST_LOG: process.env.RUST_LOG ?? "warn",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? clientName,
      NERFED_PROBE_PROCESS: "1",
    },
  });
  if (!proc.pid) throw new Error("Unable to start the Codex app-server.");

  const rpc = new CodexRpcClient(proc);
  const states: TestState[] = [];
  setupTestNotifications(rpc, states);

  try {
    await rpc.request<CodexInitializeResponse>("initialize", {
      clientInfo: { name: clientName, title: clientName, version: app.getVersion() },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});

    const target = request.sessionId ? await readTargetThread(rpc, request.sessionId) : null;
    const selectedModel = target?.model ?? request.model.trim();
    const effort = target?.effort ?? request.effort ?? null;
    if (!selectedModel) throw new Error("Choose a Codex model before running the model test.");

    let actualModel: string | null = null;
    let modelProvider: string | null = target?.provider ?? null;
    let reasoningEffort: CodexCandyReasoningEffort | null = effort;

    const createThread = async (): Promise<TestThreadResponse> => {
      const candidates = target ? target.lastTurnIds : [""];
      for (const [index, lastTurnId] of candidates.entries()) {
        try {
          const response = await rpc.request<TestThreadResponse>(target ? "thread/fork" : "thread/start", {
            ...(target
              ? {
                  threadId: target.id,
                  lastTurnId,
                  excludeTurns: true,
                  modelProvider: target.provider,
                  deferGoalContinuation: true,
                }
              : { experimentalRawEvents: false, persistExtendedHistory: false }),
            model: selectedModel,
            cwd: target?.cwd ?? cwd,
            ephemeral: true,
            approvalPolicy: "never",
            sandbox: "read-only",
            ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
          }, 45_000);
          if (target) target.lastTurnId = lastTurnId;
          return response;
        } catch (error) {
          if (!target || index === candidates.length - 1
            || !/in[- ]?progress|inprogress/i.test(error instanceof Error ? error.message : String(error))) {
            throw error;
          }
        }
      }
      throw new Error("Unable to fork the current session.");
    };

    for (let index = 0; index < requestedTests; index += 1) {
      const state: TestState = {
        threadId: "",
        response: null,
        otherResponses: [],
        turnId: null,
        usage: null,
        error: null,
        done: false,
        timedOut: false,
        elapsedMs: 0,
      };
      states.push(state);
      const sampleStartedMs = Date.now();
      try {
        const threadResponse = await createThread();
        state.threadId = threadResponse.thread.id;
        if (threadResponse.model !== selectedModel || !state.threadId || threadResponse.thread.path
          || (target ? threadResponse.thread.ephemeral !== true : threadResponse.thread.ephemeral === false)
          || (target && (state.threadId === target.id || threadResponse.thread.forkedFromId !== target.id))) {
          throw new Error(`Temporary test thread settings were not honored (requested ${selectedModel}, received ${threadResponse.model}).`);
        }
        if (effort && threadResponse.reasoningEffort !== effort) {
          throw new Error(`Temporary test reasoning effort was not honored (requested ${effort}, received ${threadResponse.reasoningEffort ?? "default"}).`);
        }
        if (modelProvider && threadResponse.modelProvider !== modelProvider) {
          throw new Error("Temporary test provider did not match the selected session.");
        }
        if (actualModel && threadResponse.model !== actualModel) {
          throw new Error("The model label changed between test samples.");
        }
        if (reasoningEffort && threadResponse.reasoningEffort !== reasoningEffort) {
          throw new Error("The reasoning effort changed between test samples.");
        }

        if (target) {
          try {
            await rpc.request("thread/goal/clear", { threadId: state.threadId, origin: "automatic" });
          } catch (error) {
            if (!isMethodNotFoundError(error)) throw error;
          }
        }

        actualModel = threadResponse.model;
        modelProvider = threadResponse.modelProvider;
        reasoningEffort = threadResponse.reasoningEffort;

        const turnResponse = await rpc.request<CodexTurnStartResponse>("turn/start", {
          threadId: state.threadId,
          input: [{ type: "text", text: CODEX_CANDY_PROMPT }],
          ...(!target && request.effort ? { effort: request.effort } : {}),
        });
        state.turnId ??= turnResponse.turn.id;

        const deadline = Date.now() + TEST_TIMEOUT_MS;
        while (rpc.isAlive && Date.now() < deadline && !state.done) await sleep(100);
        if (!state.done) {
          state.timedOut = rpc.isAlive && Date.now() >= deadline;
          finish(state, state.timedOut ? "Model test timed out." : "Codex exited before the test turn completed.");
          if (rpc.isAlive && state.turnId) {
            try {
              await rpc.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 3_000);
            } catch {
              // The private process is destroyed in finally; interruption is best-effort.
            }
          }
        }
      } catch (error) {
        finish(state, reportError("CODEX_MODEL_TEST_SAMPLE_ERR", error, {
          engine: "codex",
          model: selectedModel,
          sample: index + 1,
        }));
      }
      if (state.error && rpc.isAlive && state.turnId) {
        try {
          await rpc.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 3_000);
        } catch {
          // The private process is destroyed in finally; interruption is best-effort.
        }
      }
      state.done = true;
      if (!state.error && !(state.response ?? state.otherResponses.join("\n"))) {
        state.error = "The model returned no final text.";
      }
      state.elapsedMs = Date.now() - sampleStartedMs;
    }

    const samples = states.map((state, index) => sampleFromState(
      index,
      state,
      state.elapsedMs,
    ));
    const attempted = samples.filter((sample) => !sample.error).length;
    const passedTests = samples.filter((sample) => sample.passed).length;
    return {
      mode: target ? "fork" : "fresh",
      parentThreadId: target?.id ?? null,
      selectedModel,
      actualModel,
      modelProvider,
      reasoningEffort,
      requestedTests,
      passedTests,
      accuracy: attempted > 0 ? passedTests / attempted : null,
      samples,
      startedAt,
      elapsedMs: Date.now() - startedMs,
      ...(attempted === 0 ? { error: "No model test samples completed." } : {}),
    };
  } finally {
    rpc.destroy();
  }
}

export function registerCodexModelTestIpc(): void {
  ipcMain.handle("codex:model-test", async (_event, data: CodexCandyTestRequest) => {
    const model = typeof data?.model === "string" ? data.model.trim() : "";
    if (!model && !data?.sessionId) return { error: "Choose a Codex model before running the model test." };
    if (data?.effort != null && !EFFORTS.includes(data.effort)) return { error: "Invalid reasoning effort." };
    const tests = normalizeTestCount(data?.tests);
    log("codex-model-test", `Test requested model=${model} effort=${data?.effort ?? "default"} tests=${tests} mode=${data?.sessionId ? "fork" : "fresh"}`);
    try {
      const result = await runCandyTest({ ...data, model, tests });
      log("codex-model-test", `Test completed model=${result.selectedModel} passed=${result.passedTests}/${result.requestedTests}`);
      return result;
    } catch (error) {
      return { error: reportError("CODEX_MODEL_TEST_ERR", error, { engine: "codex", model, effort: data?.effort, tests }) };
    }
  });
}
