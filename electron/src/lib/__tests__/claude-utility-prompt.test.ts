import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeUtilityPrompt } from "../claude-utility-prompt";
const mocks = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }));
vi.mock("../claude-binary", () => ({ getClaudeBinaryPath: async () => "claude" }));
vi.mock("../sdk", () => ({ getSDK: async () => mocks.query, clientAppEnv: () => ({}) }));
vi.mock("../error-utils", () => ({ reportError: (_label: string, error: unknown) => error instanceof Error ? error.message : String(error) }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("Claude prediction lifetime", () => {
  it("waits beyond nine seconds for a successful prediction", async () => {
    vi.useFakeTimers();
    mocks.query.mockReturnValue({ close: mocks.close, async *[Symbol.asyncIterator]() {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      yield { type: "result", result: '{"prediction":"Run tests"}' };
    } });
    const pending = claudeUtilityPrompt("predict", process.cwd(), { timeoutMs: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe('{"prediction":"Run tests"}');
  });
  it("closes the isolated query when the user starts typing", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    mocks.close.mockImplementation(() => release());
    mocks.query.mockReturnValue({ close: mocks.close, async *[Symbol.asyncIterator]() {
      await new Promise<void>(resolve => { release = resolve; });
    } });
    const controller = new AbortController();
    const pending = claudeUtilityPrompt("predict", process.cwd(), { timeoutMs: null, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(mocks.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("propagates provider error results so transient errors can be retried", async () => {
    mocks.query.mockReturnValue({ close: mocks.close, async *[Symbol.asyncIterator]() {
      yield { type: "result", is_error: true, errors: ["503 temporarily unavailable"] };
    } });
    await expect(claudeUtilityPrompt("predict", process.cwd(), { timeoutMs: null })).rejects.toThrow("503");
  });
});
