import { app, ipcMain } from "electron";
import { randomInt } from "node:crypto";
import { spawnExecutable } from "../lib/command-launch";
import { reportError } from "../lib/error-utils";
import { getAppSetting } from "../lib/app-settings";
import { getCodexBinaryPath, getCodexHome } from "../lib/codex-binary";
import { log } from "../lib/logger";
import { isRecord } from "../lib/productivity-errors";
import { CodexRpcClient } from "../lib/codex-rpc";
import { getCodexFingerprintTarget } from "./codex-sessions";
import { isMethodNotFoundError } from "@shared/lib/codex-goal";
import {
  analyzeFingerprintSamples,
  assessFingerprint,
  parseFingerprintNumbers,
} from "@shared/lib/codex-fingerprint";
import type {
  CodexFingerprintProbeRequest,
  CodexFingerprintProbeResult,
  CodexFingerprintSample,
} from "@shared/types/codex-fingerprint";
import type { CodexInitializeResponse, CodexThreadStartResponse, CodexTurnStartResponse } from "@shared/types/codex";

const PROBE_COUNT = 3;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
const MESSAGE_ITEMS = new Set(["userMessage", "agentMessage", "reasoning", "hookPrompt"]);
const EFFORTS: ReadonlyArray<NonNullable<CodexFingerprintProbeResult["reasoningEffort"]>> =
  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// ModelTrace's calibrated numerical task must stay unchanged.
const PROMPTS = [
  {
    task: "直接选择 {n} 个 1 到 355（含边界）的整数。允许重复；不要排序、平衡频数、修复重复，也不要刻意构造等差规律。",
    rules: "直接回答一个 JSON 整数数组，不要解释。不要调用工具、读文件、运行代码或让其他模型代答；不要继续之前的任务。",
  },
  {
    task: "Directly choose {n} integers from 1 through 355, inclusive. Allow repeats. Do not sort, balance frequencies, repair duplicates, or deliberately create an arithmetic pattern.",
    rules: "Reply directly with one JSON integer array and no explanation. Do not call tools, read files, execute code or ask another model. Do not continue the preceding task.",
  },
];

interface ProbeState {
  threadId: string;
  requestedCount: number;
  prompt: string;
  response: string | null;
  otherResponses: string[];
  turnId: string | null;
  error: string | null;
  done: boolean;
  timedOut: boolean;
}

interface ProbeThreadResponse extends Omit<CodexThreadStartResponse, "thread" | "reasoningEffort"> {
  thread: { id: string; path: string | null; ephemeral?: boolean; forkedFromId?: string | null };
  reasoningEffort: CodexFingerprintProbeResult["reasoningEffort"];
}

interface TargetThread {
  id: string;
  model: string;
  provider: string;
  cwd: string;
  effort: CodexFingerprintProbeResult["reasoningEffort"];
  lastTurnId: string;
  lastTurnIds: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePrompt(): { count: number; prompt: string } {
  const template = PROMPTS[randomInt(PROMPTS.length)];
  const count = randomInt(292, 333);
  return { count, prompt: `${template.task.replace("{n}", String(count))}\n${template.rules}` };
}

function sampleFromState(sampleId: number, state: ProbeState): CodexFingerprintSample {
  const response = state.response ?? state.otherResponses.join("\n");
  const parsedCount = parseFingerprintNumbers(response).length;
  return {
    sampleId, threadId: state.threadId, requestedCount: state.requestedCount, prompt: state.prompt,
    response, parsedCount,
    accepted: state.done && !state.error && parsedCount >= Math.max(80, Math.ceil(state.requestedCount * 0.55)),
    ...(state.error ? { error: state.error } : {}),
  };
}

function finish(state: ProbeState, error: string | null = null): void {
  if (state.done) return;
  state.done = true;
  state.error = error;
  if (!error && !(state.response ?? state.otherResponses.join("\n"))) state.error = "未返回最终文本答案";
}

function setupFingerprintNotifications(rpc: CodexRpcClient, states: ProbeState[]): void {
  rpc.onNotification = ({ method, params }) => {
    const state = states.find((item) => item.threadId === params.threadId);
    if (!state || state.done) return;
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : null;
    if (state.turnId && eventTurnId && state.turnId !== eventTurnId) return;

    if (method === "turn/started") {
      if (isRecord(params.turn) && typeof params.turn.id === "string") state.turnId ??= params.turn.id;
    } else if (method === "item/started" || method === "item/completed") {
      const item = isRecord(params.item) ? params.item : {};
      const itemType = typeof item.type === "string" ? item.type : "unknown";
      if (!MESSAGE_ITEMS.has(itemType)) {
        finish(state, `模型尝试调用工具（${itemType}），样本已作废。`);
      } else if (method === "item/completed" && itemType === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer" || item.phase === "final") state.response = item.text;
        else if (!item.phase) state.otherResponses.push(item.text);
      }
    } else if (method === "turn/completed") {
      const turn = isRecord(params.turn) ? params.turn : {};
      if (state.turnId && typeof turn.id === "string" && turn.id !== state.turnId) return;
      state.turnId ??= typeof turn.id === "string" ? turn.id : null;
      finish(state, turn.status === "completed" ? null : `探测回合状态异常：${String(turn.status ?? "unknown")}`);
    } else if (method === "error" && !params.willRetry) {
      const error = isRecord(params.error) ? params.error : {};
      finish(state, typeof error.message === "string" ? error.message : "Codex 推理失败");
    }
  };
  rpc.onServerRequest = (msg) => {
    rpc.respondToServerError(msg.id, -32601, `Fingerprint probe refused server request: ${msg.method}`);
    for (const state of states) {
      if (typeof msg.params.threadId !== "string" || state.threadId === msg.params.threadId) {
        finish(state, `模型请求 ${msg.method}，样本已作废。`);
      }
    }
  };
}

async function readTargetThread(rpc: CodexRpcClient, sessionId: string): Promise<TargetThread> {
  const hints = getCodexFingerprintTarget(sessionId);
  if (!hints) throw new Error("当前 Codex 会话不可用，请先开始一个会话。");
  const response = await rpc.request<unknown>("thread/read", { threadId: hints.threadId, includeTurns: false });
  const thread = isRecord(response) && isRecord(response.thread) ? response.thread : {};
  if (thread.id !== hints.threadId || thread.ephemeral || typeof thread.path !== "string" || !thread.path) {
    throw new Error("当前会话没有可用于临时分支的持久历史。");
  }
  const model = typeof thread.model === "string" && thread.model ? thread.model : hints.model;
  const provider = typeof thread.modelProvider === "string" && thread.modelProvider ? thread.modelProvider : hints.provider;
  const cwd = typeof thread.cwd === "string" && thread.cwd ? thread.cwd : hints.cwd;
  const effortValue = thread.reasoningEffort ?? hints.effort;
  const effort = EFFORTS.find((value) => value === effortValue) ?? null;
  if (!model || !provider || !cwd || (effortValue != null && !effort)) {
    throw new Error("无法确认当前会话的模型、provider 或推理强度，不能进行指纹探测。");
  }

  let turns: unknown[];
  try {
    const listed = await rpc.request<unknown>("thread/turns/list", {
      threadId: hints.threadId, limit: 6, itemsView: "notLoaded", sortDirection: "desc",
    });
    turns = isRecord(listed) && Array.isArray(listed.data) ? listed.data : [];
  } catch (error) {
    if (!isMethodNotFoundError(error)) throw error;
    const legacy = await rpc.request<unknown>("thread/read", { threadId: hints.threadId, includeTurns: true });
    turns = isRecord(legacy) && isRecord(legacy.thread) && Array.isArray(legacy.thread.turns)
      ? [...legacy.thread.turns].reverse() : [];
  }
  const lastTurnIds = turns.flatMap((turn) => isRecord(turn) && typeof turn.id === "string" &&
    ["completed", "interrupted", "failed"].includes(String(turn.status)) ? [turn.id] : []).slice(0, 3);
  if (!lastTurnIds.length) {
    throw new Error("当前会话还没有结束的回合，请等待本回合完成后重试。");
  }
  return { id: hints.threadId, model, provider, cwd, effort, lastTurnId: lastTurnIds[0], lastTurnIds };
}

async function runFingerprintProbe(request: CodexFingerprintProbeRequest): Promise<CodexFingerprintProbeResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const hints = request.sessionId ? getCodexFingerprintTarget(request.sessionId) : null;
  if (request.sessionId && !hints) throw new Error("当前 Codex 会话不可用，请先开始一个会话。");
  const cwd = hints?.cwd ?? request.cwd ?? process.cwd();
  const clientName = getAppSetting("codexClientName") || "AstraDock";
  const proc = spawnExecutable(await getCodexBinaryPath(), ["app-server", "-c", "notify=[]", "-c", "features.hooks=false"], {
    stdio: ["pipe", "pipe", "pipe"], cwd,
    env: {
      ...process.env, CODEX_HOME: getCodexHome(), RUST_LOG: process.env.RUST_LOG ?? "warn",
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ?? clientName,
      NERFED_PROBE_PROCESS: "1",
    },
  });
  if (!proc.pid) throw new Error("无法启动 Codex app-server");
  const rpc = new CodexRpcClient(proc);
  const states: ProbeState[] = [];
  setupFingerprintNotifications(rpc, states);
  try {
    await rpc.request<CodexInitializeResponse>("initialize", {
      clientInfo: { name: clientName, title: clientName, version: app.getVersion() },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    const target = request.sessionId ? await readTargetThread(rpc, request.sessionId) : null;
    const selectedModel = target?.model ?? request.model;
    const effort = target ? target.effort : request.effort ?? null;
    let actualModel: string | null = null;
    let modelProvider: string | null = target?.provider ?? null;
    let reasoningEffort: CodexFingerprintProbeResult["reasoningEffort"] = effort;

    const createThread = async (): Promise<ProbeThreadResponse> => {
      const candidates = target && states.length === 0 ? target.lastTurnIds : [target?.lastTurnId ?? ""];
      for (const [index, lastTurnId] of candidates.entries()) {
        try {
          const response = await rpc.request<ProbeThreadResponse>(target ? "thread/fork" : "thread/start", {
            ...(target ? { threadId: target.id, lastTurnId, excludeTurns: true, modelProvider: target.provider, deferGoalContinuation: true }
              : { experimentalRawEvents: false, persistExtendedHistory: false }),
            model: selectedModel, cwd: target?.cwd ?? cwd, ephemeral: true,
            approvalPolicy: "never", sandbox: "read-only",
            ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
          }, 45_000);
          if (target) target.lastTurnId = lastTurnId;
          return response;
        } catch (error) {
          // A just-completed turn can still be live during steering. All samples
          // must use the same earlier finished turn once a fork succeeds.
          if (!target || index === candidates.length - 1 ||
            !/in[- ]?progress|inprogress/i.test(error instanceof Error ? error.message : String(error))) throw error;
        }
      }
      throw new Error("无法创建当前会话的临时分支，请等待当前回合完成后重试。");
    };

    const runRound = async (count: number, replacement = false): Promise<ProbeState[]> => {
      const round: ProbeState[] = [];
      for (let index = 0; index < count; index += 1) {
        const prompt = makePrompt();
        let threadResponse: ProbeThreadResponse;
        try {
          threadResponse = await createThread();
        } catch (error) {
          if (!replacement) throw error;
          const failed: ProbeState = {
            threadId: "", requestedCount: prompt.count, prompt: prompt.prompt, response: null,
            otherResponses: [], turnId: null, done: true, timedOut: false,
            error: reportError("CODEX_FINGERPRINT_REPLACEMENT_ERR", error, { engine: "codex", model: selectedModel }),
          };
          states.push(failed);
          round.push(failed);
          continue;
        }
        if (threadResponse.model !== selectedModel || !threadResponse.thread.id ||
          threadResponse.thread.path ||
          (target ? threadResponse.thread.ephemeral !== true : threadResponse.thread.ephemeral === false) ||
          (target && (threadResponse.thread.id === target.id || threadResponse.thread.forkedFromId !== target.id))) {
          throw new Error(`临时会话设置异常：请求 ${selectedModel}，实际 ${threadResponse.model}；需要支持临时分支的 Codex 版本。`);
        }
        if (effort && threadResponse.reasoningEffort !== effort) {
          throw new Error(`临时会话推理强度异常：请求 ${effort}，实际 ${threadResponse.reasoningEffort ?? "default"}`);
        }
        if (modelProvider && threadResponse.modelProvider !== modelProvider) throw new Error("临时会话 provider 与目标不一致。");
        if (actualModel && threadResponse.reasoningEffort !== reasoningEffort) throw new Error("临时会话的推理强度不一致。");
        if (target) {
          // Forks inherit the parent's goal. Defer its initial continuation,
          // then remove it from this validated private fork so completing a
          // numerical sample cannot resume the user's original task.
          try {
            await rpc.request("thread/goal/clear", { threadId: threadResponse.thread.id, origin: "automatic" });
          } catch (error) {
            // Older servers without goal APIs cannot inherit a running goal.
            if (!isMethodNotFoundError(error)) throw error;
          }
        }
        actualModel = threadResponse.model;
        modelProvider = threadResponse.modelProvider;
        reasoningEffort = threadResponse.reasoningEffort;
        const state: ProbeState = {
          threadId: threadResponse.thread.id, requestedCount: prompt.count, prompt: prompt.prompt,
          response: null, otherResponses: [], turnId: null, error: null, done: false, timedOut: false,
        };
        states.push(state);
        round.push(state);
      }
      // One RPC failure must not discard the other samples.
      const deadline = Date.now() + PROBE_TIMEOUT_MS;
      await Promise.all(round.map(async (state) => {
        if (state.done) return;
        try {
          const turnResponse = await rpc.request<CodexTurnStartResponse>("turn/start", {
            threadId: state.threadId, input: [{ type: "text", text: state.prompt }],
            ...(!target && request.effort ? { effort: request.effort } : {}),
          });
          state.turnId ??= turnResponse.turn.id;
        } catch (error) {
          finish(state, reportError("CODEX_FINGERPRINT_TURN_ERR", error, { engine: "codex", model: selectedModel }));
        }
      }));
      while (rpc.isAlive && Date.now() < deadline && round.some((state) => !state.done)) await sleep(100);
      for (const state of round) {
        if (!state.done) {
          state.timedOut = rpc.isAlive && Date.now() >= deadline;
          finish(state, state.timedOut ? "探测超时，样本已作废。" : "Codex 进程在回合完成前退出，样本已作废。");
          if (rpc.isAlive && state.turnId) {
            try { await rpc.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 3_000); }
            catch { /* Best-effort cleanup; the private process is destroyed in finally. */ }
          }
        }
      }
      return round;
    };

    const firstRound = await runRound(PROBE_COUNT);
    const timedOut = firstRound.filter((state) => state.timedOut).length;
    if (timedOut && rpc.isAlive) await runRound(timedOut, true); // replace slow/missing answers once
    const samples = states.map((state, index) => sampleFromState(index, state));
    const analysis = analyzeFingerprintSamples(samples);
    return {
      mode: target ? "fork" : "fresh", parentThreadId: target?.id ?? null,
      selectedModel, actualModel, modelProvider, reasoningEffort,
      verdict: assessFingerprint(selectedModel, analysis), analysis, samples,
      startedAt, elapsedMs: Date.now() - startedMs,
    };
  } finally {
    rpc.destroy();
  }
}

export function registerCodexFingerprintIpc(): void {
  ipcMain.handle("codex:fingerprint-probe", async (_event, data: CodexFingerprintProbeRequest) => {
    const model = typeof data?.model === "string" ? data.model.trim() : "";
    if (!model && !data?.sessionId) return { error: "请选择一个模型" };
    if (data.effort != null && !EFFORTS.includes(data.effort)) return { error: "无效的推理强度" };
    log("codex-fingerprint", `Probe requested model=${model} effort=${data.effort ?? "default"} mode=${data.sessionId ? "fork" : "fresh"}`);
    try {
      const result = await runFingerprintProbe({ ...data, model });
      log("codex-fingerprint", `Probe completed model=${result.selectedModel} verdict=${result.verdict.verdict} top=${result.analysis?.prediction ?? "none"}`);
      return result;
    } catch (error) {
      return { error: reportError("CODEX_FINGERPRINT_PROBE_ERR", error, { engine: "codex", model, effort: data.effort }) };
    }
  });
}
