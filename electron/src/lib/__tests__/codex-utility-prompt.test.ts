import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHandler, ServerRequestHandler } from "../codex-rpc";
import { codexUtilityPrompt } from "../codex-utility-prompt";

const mocks = vi.hoisted(() => ({
  notifications: [] as Parameters<NotificationHandler>[0][],
  destroy: vi.fn(),
  request: vi.fn(),
  notify: null as NotificationHandler | null,
  exit: null as ((code: number | null, signal: string | null) => void) | null,
}));

vi.mock("../command-launch", () => ({ spawnExecutable: vi.fn(() => ({ pid: 123 })) }));
vi.mock("../codex-binary", () => ({ getCodexBinaryPath: vi.fn(async () => "codex") }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../error-utils", () => ({
  reportError: vi.fn((_label: string, error: unknown) => error instanceof Error ? error.message : String(error)),
}));
vi.mock("@shared/lib/codex-helpers", () => ({
  listModelsWithConfigured: vi.fn(async () => [{ id: "test-model", isDefault: true }]),
}));
vi.mock("../codex-rpc", () => ({
  CodexRpcClient: class {
    onNotification: NotificationHandler | null = null;
    onExit: ((code: number | null, signal: string | null) => void) | null = null;
    onServerRequest: ServerRequestHandler | null = null;
    onStderr: ((text: string) => void) | null = null;
    destroy = mocks.destroy;
    notify = vi.fn();
    respondToServerError = vi.fn();
    async request(method: string, params: unknown) {
      mocks.request(method, params);
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
        mocks.notify = this.onNotification;
        mocks.exit = this.onExit;
        for (const notification of mocks.notifications) this.onNotification?.(notification);
        return { turn: { id: "turn-1" } };
      }
      return {};
    }
  },
}));

function item(method: string, type: string, text?: string): Parameters<NotificationHandler>[0] {
  return { method, params: { item: { type, ...(text === undefined ? {} : { text }) } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notifications = [];
});

afterEach(() => vi.useRealTimers());

describe("codexUtilityPrompt item filtering", () => {
  it.each(["COMPOSER_PREDICTION", "TITLE_GEN", "COMMIT_MSG_GEN"])(
    "allows user messages and completes %s without premature shutdown",
    async (label) => {
      const output = '{"prediction":"Run the tests"}';
      mocks.notifications = [
        item("item/started", "userMessage"),
        item("item/completed", "userMessage"),
        item("item/started", "reasoning"),
        item("item/completed", "reasoning"),
        item("item/started", "plan"),
        item("item/completed", "plan"),
        item("item/started", "agentMessage"),
        item("item/completed", "agentMessage", output),
        { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
      ];

      await expect(codexUtilityPrompt("Predict next message", process.cwd(), label)).resolves.toBe(output);
      // Successful calls destroy only during final cleanup, not on message events.
      expect(mocks.destroy).toHaveBeenCalledTimes(1);
      expect(mocks.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
      }));
    },
  );

  it.each(["item/started", "item/completed"])("rejects tool and unknown items on %s", async (method) => {
    for (const type of ["commandExecution", "fileChange", "mcpToolCall", "webSearch", "unknownItem"]) {
      mocks.destroy.mockClear();
      mocks.notifications = [item(method, type)];
      await expect(codexUtilityPrompt("Predict next message", process.cwd(), "COMPOSER_PREDICTION"))
        .rejects.toThrow(`Codex prediction refused tool item: ${type}`);
      expect(mocks.destroy).toHaveBeenCalled();
    }
  });
});

describe("prediction cancellation without a deadline", () => {
  it("waits beyond nine seconds and accepts a late completion", async () => {
    vi.useFakeTimers();
    const result = codexUtilityPrompt("Predict", process.cwd(), "COMPOSER_PREDICTION", { timeoutMs: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.destroy).not.toHaveBeenCalled();
    mocks.notify?.(item("item/completed", "agentMessage", "late suggestion"));
    mocks.notify?.({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await expect(result).resolves.toBe("late suggestion");
  });

  it("settles and destroys the utility immediately when typing cancels it", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = codexUtilityPrompt("Predict", process.cwd(), "COMPOSER_PREDICTION", { timeoutMs: null, signal: controller.signal });
    const assertion = expect(result).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(20_000);
    controller.abort();
    await assertion;
    expect(mocks.destroy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hang if the utility process exits during inference", async () => {
    vi.useFakeTimers();
    const result = codexUtilityPrompt("Predict", process.cwd(), "COMPOSER_PREDICTION", { timeoutMs: null });
    const assertion = expect(result).rejects.toThrow("process exited");
    await vi.advanceTimersByTimeAsync(0);
    mocks.exit?.(1, null);
    await assertion;
  });
});
