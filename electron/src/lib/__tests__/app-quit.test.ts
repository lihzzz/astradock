import { describe, expect, it, vi } from "vitest";
import { prepareManagedQuit } from "../app-quit";

describe("managed application quit", () => {
  it("offers a decision after 15 seconds and observes the live attempt on retry", async () => {
    vi.useFakeTimers();
    try {
      let complete = () => {};
      const stop = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
      const onFailure = vi.fn(async () => "retry" as const);
      const pending = prepareManagedQuit({ stop, onFailure });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(onFailure).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
      complete(); expect(await pending).toBe(true); expect(stop).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("waits for every stop before allowing exit", async () => {
    let finish: () => void = () => {};
    let completed = false;
    const result = prepareManagedQuit({ stop: () => new Promise<void>((resolve) => { finish = resolve; }), onFailure: vi.fn() });
    void result.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    expect(await result).toBe(true);
  });
  it("keeps the host alive when a failed cleanup is cancelled", async () => {
    expect(await prepareManagedQuit({ stop: async () => { throw new Error("child alive"); }, onFailure: async () => "cancel" })).toBe(false);
  });
  it("retries cleanup and only permits forcing exit after an explicit decision", async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
    expect(await prepareManagedQuit({ stop, onFailure: async () => "retry" })).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(await prepareManagedQuit({ stop: async () => { throw new Error("busy"); }, onFailure: async () => "force" })).toBe(true);
  });
});
