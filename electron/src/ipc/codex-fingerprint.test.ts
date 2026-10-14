import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHandler, ServerRequestHandler } from "../lib/codex-rpc";
import type { CodexFingerprintProbeRequest, CodexFingerprintProbeResult } from "@shared/types/codex-fingerprint";
import { registerCodexFingerprintIpc } from "./codex-fingerprint";

type IpcHandler = (event: unknown, data: CodexFingerprintProbeRequest) => Promise<CodexFingerprintProbeResult | { error: string }>;
interface RpcParams {
  model?: string;
  threadId?: string;
  config?: { model_reasoning_effort: NonNullable<CodexFingerprintProbeRequest["effort"]> };
  effort?: CodexFingerprintProbeRequest["effort"];
  lastTurnId?: string;
  deferGoalContinuation?: boolean;
  origin?: "automatic";
  input?: Array<{ type: string; text: string }>;
  includeTurns?: boolean;
}

const mocks = vi.hoisted(() => ({
  handle: vi.fn<(channel: string, handler: IpcHandler) => void>(),
  request: vi.fn<(method: string, params: RpcParams, notify: NotificationHandler | null, server: ServerRequestHandler | null) => Promise<unknown>>(),
  spawn: vi.fn<(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => { pid: number }>(() => ({ pid: 123 })),
  serverError: vi.fn(),
  destroy: vi.fn(),
  alive: true,
  target: null as { threadId: string; model: string; cwd: string; effort: string | null; provider: string } | null,
  returnedEffort: undefined as CodexFingerprintProbeRequest["effort"],
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "test" },
  ipcMain: { handle: mocks.handle },
}));
vi.mock("../lib/command-launch", () => ({ spawnExecutable: mocks.spawn }));
vi.mock("../lib/app-settings", () => ({ getAppSetting: () => "AstraDock-test" }));
vi.mock("./codex-sessions", () => ({ getCodexFingerprintTarget: () => mocks.target }));
vi.mock("../lib/codex-binary", () => ({
  getCodexBinaryPath: async () => "codex",
  getCodexHome: () => "/tmp/harnss-fingerprint-test",
}));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));
vi.mock("../lib/error-utils", () => ({
  reportError: (_label: string, error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock("../lib/codex-rpc", () => ({
  CodexRpcClient: class {
    onNotification: NotificationHandler | null = null;
    onServerRequest: ServerRequestHandler | null = null;
    get isAlive() { return mocks.alive; }
    notify = vi.fn();
    respondToServerError = mocks.serverError;
    destroy = mocks.destroy;
    request(method: string, params: RpcParams) {
      return mocks.request(method, params, this.onNotification, this.onServerRequest);
    }
  },
}));

function invoke(data: CodexFingerprintProbeRequest) {
  return mocks.handle.mock.calls[0][1](undefined, data);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODEX_INTERNAL_ORIGINATOR_OVERRIDE", undefined);
  mocks.returnedEffort = undefined;
  mocks.alive = true;
  mocks.target = null;
  let threadCount = 0;
  mocks.request.mockImplementation(async (method, params, notify) => {
    if (method === "thread/read") {
      return { thread: { id: mocks.target?.threadId, path: "/test/rollout.jsonl", cwd: mocks.target?.cwd,
        modelProvider: mocks.target?.provider } };
    }
    if (method === "thread/turns/list") {
      return { data: [{ id: "running", status: "inProgress" }, { id: "finished", status: "completed" }] };
    }
    if (method === "thread/start" || method === "thread/fork") {
      return {
        thread: { id: `thread-${++threadCount}`, path: null, ephemeral: true,
          ...(method === "thread/fork" ? { forkedFromId: mocks.target?.threadId } : {}) },
        model: params.model,
        modelProvider: mocks.target?.provider ?? "configured-relay",
        reasoningEffort: mocks.returnedEffort ?? params.config?.model_reasoning_effort ?? "medium",
      };
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${params.threadId}`, status: "completed" };
      notify?.({
        method: "item/completed",
        params: {
          threadId: params.threadId,
          item: {
            type: "agentMessage",
            phase: "final_answer",
            text: JSON.stringify(Array.from({ length: 300 }, (_, index) => index + 1)),
          },
        },
      });
      notify?.({ method: "turn/completed", params: { threadId: params.threadId, turn } });
      return { turn };
    }
    return {};
  });
  registerCodexFingerprintIpc();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("fingerprint probe reasoning effort", () => {
  it.each(["high", "none", "max", "ultra"] as const)("uses %s effort for all three samples", async (effort) => {
    const result = await invoke({ model: "gpt-test", effort });

    expect(result).toMatchObject({ selectedModel: "gpt-test", reasoningEffort: effort });
    const threads = mocks.request.mock.calls.filter(([method]) => method === "thread/start");
    const turns = mocks.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(threads).toHaveLength(3);
    expect(turns).toHaveLength(3);
    for (const [, params] of threads) {
      expect(params).toMatchObject({ ephemeral: true, config: { model_reasoning_effort: effort } });
    }
    for (const [, params] of turns) {
      expect(params.effort).toBe(effort);
    }
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("keeps the server default when no effort is selected", async () => {
    const result = await invoke({ model: "gpt-test" });

    expect(result).toMatchObject({ reasoningEffort: "medium" });
    for (const [method, params] of mocks.request.mock.calls) {
      if (method === "thread/start") expect(params).not.toHaveProperty("config");
      if (method === "turn/start") expect(params).not.toHaveProperty("effort");
    }
  });

  it("reports an error if the server does not apply the selected effort", async () => {
    mocks.returnedEffort = "low";

    expect(await invoke({ model: "gpt-test", effort: "high" })).toEqual({
      error: "临时会话推理强度异常：请求 high，实际 low",
    });
    expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});

describe("fingerprint probe validity", () => {
  it("uses the calibrated prompts, isolated hooks, configured client and project directory", async () => {
    const result = await invoke({ model: "gpt-test", cwd: "/test/project" });
    if ("error" in result) throw new Error(result.error);
    expect(result).toMatchObject({ mode: "fresh", parentThreadId: null, modelProvider: "configured-relay", actualModel: "gpt-test" });
    expect(result.analysis?.prediction).not.toBe(result.actualModel);
    const [binary, args, options] = mocks.spawn.mock.calls[0];
    expect(binary).toBe("codex");
    expect(args).toEqual(expect.arrayContaining(["features.hooks=false", "notify=[]"]));
    expect(options.cwd).toBe("/test/project");
    expect(options.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe("AstraDock-test");
    for (const sample of result.samples) {
      expect(sample.requestedCount).toBeGreaterThanOrEqual(292);
      expect(sample.requestedCount).toBeLessThanOrEqual(332);
      expect(sample.prompt).toMatch(/允许重复；不要排序|Allow repeats\. Do not sort/);
      expect(sample.prompt).toMatch(/不要继续之前的任务|Do not continue the preceding task/);
    }
  });

  it.each(["tool", "failed", "server-request"])("rejects numerical output after %s", async (failure) => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method !== "turn/start") return normal(method, params, notify, server);
      const turn = { id: `turn-${params.threadId}`, status: "completed" };
      notify?.({ method: "item/completed", params: { threadId: params.threadId, item: {
        type: "agentMessage", phase: "final_answer", text: JSON.stringify(Array.from({ length: 300 }, (_, i) => i + 1)),
      } } });
      if (failure === "tool") notify?.({ method: "item/started", params: { threadId: params.threadId, item: { type: "commandExecution" } } });
      if (failure === "server-request") server?.({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: params.threadId } });
      notify?.({ method: "turn/completed", params: { threadId: params.threadId, turn: { ...turn, status: failure === "failed" ? "failed" : "completed" } } });
      return { turn };
    });
    const result = await invoke({ model: "gpt-test" });
    if ("error" in result) throw new Error(result.error);
    expect(result.analysis).toBeNull();
    expect(result.verdict.verdict).toBe("INVALID");
    expect(result.samples.every((sample) => !sample.accepted && sample.parsedCount === 300 && sample.error)).toBe(true);
    if (failure === "server-request") expect(mocks.serverError).toHaveBeenCalledTimes(3);
  });

  it("accepts unphased final answers after completed turns", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((method, params, notify, server) => normal(method, params,
      notify && ((message) => {
        if (message.method === "item/completed") {
          notify({ ...message, params: { ...message.params, item: { type: "agentMessage", text: JSON.stringify(Array.from({ length: 300 }, (_, i) => i + 1)) } } });
        } else notify(message);
      }), server));
    const result = await invoke({ model: "gpt-test" });
    expect(result).toMatchObject({ analysis: { usedOutputs: 3 } });
  });

  it("does not discard valid samples when one turn request fails", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((method, params, notify, server) => {
      if (method === "turn/start" && params.threadId === "thread-1") return Promise.reject(new Error("network failed"));
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test" })).toMatchObject({ analysis: { usedOutputs: 2 } });
  });

  it("rejects text from a turn whose process exits before completion", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method !== "turn/start") return normal(method, params, notify, server);
      mocks.alive = false;
      notify?.({ method: "item/completed", params: { threadId: params.threadId, item: {
        type: "agentMessage", phase: "final_answer", text: JSON.stringify(Array.from({ length: 300 }, (_, i) => i + 1)),
      } } });
      return { turn: { id: `turn-${params.threadId}` } };
    });
    expect(await invoke({ model: "gpt-test" })).toMatchObject({ analysis: null, verdict: { verdict: "INVALID" } });
  });

  it("replaces timed-out answers once and never scores their partial text", async () => {
    vi.useFakeTimers();
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "turn/start" && params.threadId === "thread-1") {
        notify?.({ method: "item/completed", params: { threadId: params.threadId, item: {
          type: "agentMessage", phase: "final_answer", text: JSON.stringify(Array.from({ length: 300 }, (_, i) => i + 1)),
        } } });
        return { turn: { id: "timeout-turn" } };
      }
      return normal(method, params, notify, server);
    });
    const pending = invoke({ model: "gpt-test" });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    const result = await pending;
    expect(result).toMatchObject({ analysis: { usedOutputs: 3 } });
    if ("error" in result) throw new Error(result.error);
    expect(result.samples).toHaveLength(4);
    expect(result.samples[0]).toMatchObject({ accepted: false, parsedCount: 300 });
    expect(mocks.request.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(1);
  });

  it("refuses persisted probe threads before inference", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/start") return { model: params.model, thread: { id: "persisted", path: "/saved.jsonl", ephemeral: false } };
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test" })).toHaveProperty("error");
    expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("accepts a fresh ephemeral response that omits its optional marker", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/start") return {
        model: params.model, modelProvider: "relay", reasoningEffort: "medium",
        thread: { id: `fresh-${mocks.request.mock.calls.length}`, path: null },
      };
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test" })).toMatchObject({ mode: "fresh", analysis: { usedOutputs: 3 } });
  });

  it("retains completed samples if a timeout replacement cannot be created", async () => {
    vi.useFakeTimers();
    const normal = mocks.request.getMockImplementation()!;
    let created = 0;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/start" && ++created > 3) throw new Error("replacement network failure");
      if (method === "turn/start" && params.threadId === "thread-1") return { turn: { id: "slow" } };
      return normal(method, params, notify, server);
    });
    const pending = invoke({ model: "gpt-test" });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);
    const result = await pending;
    expect(result).toMatchObject({ analysis: { usedOutputs: 2 } });
    if ("error" in result) throw new Error(result.error);
    expect(result.samples[3]).toMatchObject({ accepted: false, error: "replacement network failure" });
  });

  it("ignores stale turn notifications while waiting for the probe turn", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "turn/start") {
        notify?.({ method: "turn/started", params: { threadId: params.threadId, turn: { id: `turn-${params.threadId}` } } });
        notify?.({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: "old", status: "failed" } } });
        notify?.({ method: "item/started", params: { threadId: params.threadId, turnId: "old", item: { type: "commandExecution" } } });
      }
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test" })).toMatchObject({ analysis: { usedOutputs: 3 } });
  });
});

describe("current-session fingerprint forks", () => {
  beforeEach(() => {
    mocks.target = { threadId: "parent", model: "gpt-6-astra", cwd: "/original/project", effort: "high", provider: "relay" };
  });

  it("inherits session settings and forks its last finished turn", async () => {
    expect(await invoke({ model: "gpt-other", effort: "low", sessionId: "runtime-session", cwd: "/wrong" })).toMatchObject({
      mode: "fork", parentThreadId: "parent", selectedModel: "gpt-6-astra", actualModel: "gpt-6-astra", modelProvider: "relay", reasoningEffort: "high",
    });
    const forks = mocks.request.mock.calls.filter(([method]) => method === "thread/fork");
    expect(forks).toHaveLength(3);
    for (const [, params] of forks) expect(params).toMatchObject({
      threadId: "parent", lastTurnId: "finished", ephemeral: true, excludeTurns: true, deferGoalContinuation: true,
      model: "gpt-6-astra", modelProvider: "relay", cwd: "/original/project", config: { model_reasoning_effort: "high" },
    });
    const turns = mocks.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(turns.every(([, params]) => params.threadId !== "parent" && !params.effort)).toBe(true);
    expect(mocks.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
  });

  it("defers and clears inherited goals only on private forks before starting samples", async () => {
    const normal = mocks.request.getMockImplementation()!;
    const inheritedGoals = new Set<string>(["parent"]);
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/fork") {
        expect(params.deferGoalContinuation).toBe(true);
        const response = await normal(method, params, notify, server);
        if (typeof response !== "object" || response === null || !("thread" in response)
          || typeof response.thread !== "object" || response.thread === null || !("id" in response.thread)
          || typeof response.thread.id !== "string") throw new Error("Missing private fork");
        inheritedGoals.add(response.thread.id);
        return response;
      }
      if (method === "thread/goal/clear") {
        expect(params.threadId).not.toBe("parent");
        expect(params.origin).toBe("automatic");
        return { cleared: inheritedGoals.delete(params.threadId ?? "") };
      }
      if (method === "turn/start") expect(inheritedGoals.has(params.threadId ?? "")).toBe(false);
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toMatchObject({ analysis: { usedOutputs: 3 } });
    const calls = mocks.request.mock.calls;
    expect(calls.filter(([method]) => method === "thread/goal/clear").map(([, params]) => params.threadId))
      .toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(calls.findIndex(([method]) => method === "turn/start"))
      .toBeGreaterThan(calls.findLastIndex(([method]) => method === "thread/goal/clear"));
    expect([...inheritedGoals]).toEqual(["parent"]);
  });

  it("supports older fork servers whose goal API is unavailable", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((method, params, notify, server) => method === "thread/goal/clear"
      ? Promise.reject(new Error("RPC error -32601: Method not found")) : normal(method, params, notify, server));
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toMatchObject({ analysis: { usedOutputs: 3 } });
    expect(mocks.request.mock.calls.filter(([method]) => method === "thread/goal/clear")).toHaveLength(3);
  });

  it("refuses inference if clearing a private fork's goal fails", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((method, params, notify, server) => method === "thread/goal/clear"
      ? Promise.reject(new Error("Goal clear failed")) : normal(method, params, notify, server));
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toEqual({ error: "Goal clear failed" });
    expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("does not clear goals when the returned fork is the original thread", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/fork") return {
        model: params.model, modelProvider: "relay", reasoningEffort: "high",
        thread: { id: "parent", path: null, ephemeral: true, forkedFromId: "parent" },
      };
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toHaveProperty("error");
    expect(mocks.request.mock.calls.some(([method]) => method === "thread/goal/clear" || method === "turn/start")).toBe(false);
  });

  it("does not clear goals for fresh probes", async () => {
    expect(await invoke({ model: "gpt-test" })).toMatchObject({ mode: "fresh", analysis: { usedOutputs: 3 } });
    expect(mocks.request.mock.calls.some(([method]) => method === "thread/goal/clear")).toBe(false);
  });

  it("does not silently switch to a fresh probe when no finished turn exists", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((method, params, notify, server) => method === "thread/turns/list"
      ? Promise.resolve({ data: [{ id: "running", status: "inProgress" }] }) : normal(method, params, notify, server));
    expect(await invoke({ model: "gpt-test", sessionId: "runtime-session" })).toHaveProperty("error");
    expect(mocks.request.mock.calls.some(([method]) => method === "turn/start" || method === "thread/start")).toBe(false);
  });

  it("falls back from a busy turn and anchors all forks to the same earlier turn", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/turns/list") return { data: [{ id: "new", status: "completed" }, { id: "old", status: "completed" }] };
      if (method === "thread/fork" && params.lastTurnId === "new") throw new Error("turn is in-progress");
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toMatchObject({ mode: "fork", analysis: { usedOutputs: 3 } });
    expect(mocks.request.mock.calls.filter(([method]) => method === "thread/fork").map(([, params]) => params.lastTurnId))
      .toEqual(["new", "old", "old", "old"]);
  });

  it("reads legacy turn history only when the paginated method is unsupported", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/turns/list") throw new Error("method not found");
      if (method === "thread/read" && params.includeTurns) return { thread: {
        id: "parent", turns: [{ id: "older", status: "completed" }, { id: "newer", status: "completed" }],
      } };
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toMatchObject({ analysis: { usedOutputs: 3 } });
    expect(mocks.request.mock.calls.filter(([method]) => method === "thread/fork").every(([, params]) => params.lastTurnId === "newer")).toBe(true);
  });

  it("rejects forks that report a different provider before inference", async () => {
    const normal = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(async (method, params, notify, server) => {
      if (method === "thread/fork") return {
        model: params.model, modelProvider: "other", reasoningEffort: "high",
        thread: { id: "fork", path: null, ephemeral: true, forkedFromId: "parent" },
      };
      return normal(method, params, notify, server);
    });
    expect(await invoke({ model: "gpt-test", sessionId: "live" })).toEqual({ error: "临时会话 provider 与目标不一致。" });
    expect(mocks.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });
});
