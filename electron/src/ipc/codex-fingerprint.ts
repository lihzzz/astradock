import { ipcMain } from "electron";
import { spawn } from "child_process";
import { app } from "electron";

import { reportError } from "../lib/error-utils";
import { getCodexBinaryPath, getCodexHome } from "../lib/codex-binary";
import { log } from "../lib/logger";
import { CodexRpcClient } from "../lib/codex-rpc";
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
import type {
  CodexInitializeResponse,
  CodexThreadStartResponse,
  CodexTurnStartResponse,
} from "@shared/types/codex";
import type { RequestId } from "@shared/types/codex-protocol/RequestId";

const PROBE_COUNT = 3;
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;

const PROMPTS = [
  {
    language: "zh",
    task: "直接选择 {n} 个 1 到 355（含边界）的整数。",
    rules: "直接回答一个 JSON 整数数组，不要解释。不要调用工具、读文件、运行代码或让其他模型代答。",
  },
  {
    language: "en",
    task: "Directly choose {n} integers from 1 through 355, inclusive.",
    rules: "Reply directly with one JSON integer array and no explanation. Do not call tools, read files, execute code or ask another model.",
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePrompt(sampleId: number): { count: number; prompt: string } {
  const template = PROMPTS[sampleId % PROMPTS.length];
  const count = 292 + (sampleId * 13) % 41;
  return {
    count,
    prompt: `${template.task.replace("{n}", String(count))}\n${template.rules}`,
  };
}

function sampleFromState(sampleId: number, state: ProbeState): CodexFingerprintSample {
  const response = state.response ?? state.otherResponses.join("\n");
  const parsedCount = parseFingerprintNumbers(response).length;
  return {
    sampleId,
    threadId: state.threadId,
    requestedCount: state.requestedCount,
    prompt: state.prompt,
    response,
    parsedCount,
    accepted: !state.error && parsedCount >= Math.max(80, Math.ceil(state.requestedCount * 0.55)),
    ...(state.error ? { error: state.error } : {}),
  };
}

function setupFingerprintNotifications(rpc: CodexRpcClient, states: ProbeState[]): void {
  rpc.onNotification = ({ method, params }) => {
    const state = states.find((item) => item.threadId === params.threadId);
    if (!state || state.done) return;

    if (method === "item/started") {
      const itemType = String((params.item as { type?: string } | undefined)?.type ?? "");
      if (!["userMessage", "agentMessage", "reasoning", "hookPrompt"].includes(itemType)) {
        state.error = `模型尝试调用工具（${itemType}），样本已作废。`;
        state.done = true;
      }
      return;
    }

    if (method === "item/completed") {
      const item = params.item as { type?: string; text?: string; phase?: string | null };
      if (item.type === "agentMessage") {
        if (item.phase === "final_answer" || item.phase === "final") {
          state.response = item.text ?? state.response;
        } else if (!item.phase) {
          state.otherResponses.push(item.text ?? "");
        }
      }
      return;
    }

    if (method === "turn/completed") {
      const status = String((params.turn as { status?: string } | undefined)?.status ?? "");
      state.done = true;
      if (status !== "completed") state.error = state.error ?? `探测回合状态异常：${status}`;
      return;
    }

    if (method === "error") {
      if (!params.willRetry) {
        state.error = String(
          (params.error as { message?: string } | undefined)?.message ??
            (params.error as { message?: unknown } | undefined)?.message ??
            "Codex 推理失败",
        );
        state.done = true;
      }
    }
  };

  rpc.onServerRequest = (msg: { id: RequestId; method: string }) => {
    rpc.respondToServerError(msg.id, -32601, `Fingerprint probe refused server request: ${msg.method}`);
  };
}

async function runFingerprintProbe({ model, effort }: CodexFingerprintProbeRequest): Promise<CodexFingerprintProbeResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const codexPath = await getCodexBinaryPath();
  const proc = spawn(codexPath, ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: getCodexHome(),
      RUST_LOG: process.env.RUST_LOG ?? "warn",
    },
  });
  if (!proc.pid) throw new Error("无法启动 Codex app-server");

  const rpc = new CodexRpcClient(proc);
  let actualModel: string | null = null;
  let reasoningEffort: CodexFingerprintProbeResult["reasoningEffort"] = null;

  try {
    await rpc.request<CodexInitializeResponse>("initialize", {
      clientInfo: { name: "AstraDock", title: "AstraDock", version: app.getVersion() },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});

    const states: ProbeState[] = [];
    for (let sampleId = 0; sampleId < PROBE_COUNT; sampleId += 1) {
      const prompt = makePrompt(sampleId);
      const threadResponse = await rpc.request<CodexThreadStartResponse>("thread/start", {
        model,
        ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
        cwd: process.cwd(),
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      });
      if (threadResponse.model !== model || threadResponse.thread.path) {
        throw new Error(
          `临时会话设置异常：请求 ${model}，实际 ${threadResponse.model}`,
        );
      }
      if (effort && threadResponse.reasoningEffort !== effort) {
        throw new Error(
          `临时会话推理强度异常：请求 ${effort}，实际 ${threadResponse.reasoningEffort ?? "default"}`,
        );
      }
      actualModel = threadResponse.model;
      reasoningEffort = threadResponse.reasoningEffort;
      states.push({
        threadId: threadResponse.thread.id,
        requestedCount: prompt.count,
        prompt: prompt.prompt,
        response: null,
        otherResponses: [],
        turnId: null,
        error: null,
        done: false,
      });
    }

    setupFingerprintNotifications(rpc, states);
    for (const state of states) {
      const turnResponse = await rpc.request<CodexTurnStartResponse>("turn/start", {
        threadId: state.threadId,
        input: [{ type: "text", text: state.prompt }],
        ...(effort ? { effort } : {}),
      });
      state.turnId = turnResponse.turn.id;
    }

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (rpc.isAlive && Date.now() < deadline && states.some((state) => !state.done)) {
      await sleep(500);
    }
    states.forEach((state) => {
      state.done = true;
      state.error = state.error ?? (state.response ? null : "未返回最终文本答案");
    });

    const samples = states.map((state, index) => sampleFromState(index, state));
    const analysis = analyzeFingerprintSamples(samples);
    const verdict = assessFingerprint(model, analysis);
    return {
      selectedModel: model,
      actualModel: analysis?.prediction ?? actualModel,
      reasoningEffort,
      verdict,
      analysis,
      samples,
      startedAt,
      elapsedMs: Date.now() - startedMs,
    };
  } finally {
    rpc.destroy();
  }
}

export function registerCodexFingerprintIpc(): void {
  ipcMain.handle("codex:fingerprint-probe", async (_event, data: CodexFingerprintProbeRequest) => {
    const model = data?.model?.trim();
    if (!model) return { error: "请选择一个模型" };
    const effort = data.effort;

    log("codex-fingerprint", `Probe requested model=${model} effort=${effort ?? "default"}`);
    try {
      const result = await runFingerprintProbe({ model, effort });
      log(
        "codex-fingerprint",
        `Probe completed model=${model} verdict=${result.verdict.verdict} top=${result.analysis?.prediction ?? "none"}`,
      );
      return result;
    } catch (error) {
      const message = reportError("CODEX_FINGERPRINT_PROBE_ERR", error, { engine: "codex", model, effort });
      log("codex-fingerprint", `Probe failed model=${model}: ${message}`);
      return { error: message };
    }
  });
}
