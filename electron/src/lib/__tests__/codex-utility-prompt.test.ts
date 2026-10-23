import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationHandler, ServerRequestHandler } from "../codex-rpc";
import { codexUtilityPrompt } from "../codex-utility-prompt";

const mocks = vi.hoisted(() => ({
  notifications: [] as Parameters<NotificationHandler>[0][],
  destroy: vi.fn(),
  request: vi.fn(),
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
    onServerRequest: ServerRequestHandler | null = null;
    onStderr: ((text: string) => void) | null = null;
    destroy = mocks.destroy;
    notify = vi.fn();
    respondToServerError = vi.fn();
    async request(method: string, params: unknown) {
      mocks.request(method, params);
      if (method === "thread/start") return { thread: { id: "thread-1" } };
      if (method === "turn/start") {
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