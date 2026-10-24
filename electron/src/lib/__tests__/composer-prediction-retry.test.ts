import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { isRetryablePredictionError, retryComposerPrediction } from "../composer-prediction-retry";
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => { vi.mocked(delay).mockReset().mockResolvedValue(undefined); });

describe("prediction retries", () => {
  it("retries transient failures with capped exponential backoff", async () => {
    const controller = new AbortController();
    const run = vi.fn<() => Promise<string>>();
    for (let i = 0; i < 8; i++) run.mockRejectedValueOnce(new Error("503 temporarily unavailable"));
    run.mockResolvedValue("suggestion");
    await expect(retryComposerPrediction(run, controller.signal)).resolves.toBe("suggestion");
    expect(vi.mocked(delay).mock.calls.map(call => call[0])).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(vi.mocked(delay).mock.calls.every(call => call[2]?.signal === controller.signal)).toBe(true);
  });
  it("never retries a valid empty prediction", async () => {
    const run = vi.fn().mockResolvedValue('{"prediction":null}');
    await expect(retryComposerPrediction(run, new AbortController().signal)).resolves.toBe('{"prediction":null}');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(["401 Unauthorized", "403 Forbidden", "quota exceeded", "Codex prediction refused tool item: webSearch", "Invalid configuration"])("does not retry %s", async message => {
    const run = vi.fn().mockRejectedValue(new Error(message));
    await expect(retryComposerPrediction(run, new AbortController().signal)).rejects.toThrow(message);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("aborts a pending backoff without issuing another request", async () => {
    const controller = new AbortController();
    vi.mocked(delay).mockImplementationOnce((_ms, _value, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const run = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const result = retryComposerPrediction(run, controller.signal);
    const assertion = expect(result).rejects.toThrow("cancelled");
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not retry an in-flight failure after user cancellation", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => { controller.abort(); throw new Error("network error"); });
    await expect(retryComposerPrediction(run, controller.signal)).rejects.toThrow("network error");
    expect(delay).not.toHaveBeenCalled();
  });
  it.each(["fetch failed", "socket hang up", "429 rate limited", "Codex RPC timeout"])("recognizes %s", message => {
    expect(isRetryablePredictionError(new Error(message))).toBe(true);
  });
});
