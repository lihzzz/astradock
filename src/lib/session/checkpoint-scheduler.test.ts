import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointScheduler } from "./checkpoint-scheduler";
import type { PersistedSession } from "@/types";
const session: PersistedSession = { id: "s", projectId: "p", title: "test", createdAt: 1, totalCost: 0, messages: [] };
afterEach(() => vi.useRealTimers());
describe("conversation checkpoints", () => {
  it("checkpoints continuous streaming within maxWait and uses the latest snapshot", async () => {
    vi.useFakeTimers();
    let latest = session;
    const save = vi.fn(async () => {});
    const scheduler = new CheckpointScheduler(() => latest, save, vi.fn());
    for (let i = 0; i < 10; i++) {
      latest = { ...session, totalCost: i };
      scheduler.mark("s"); await vi.advanceTimersByTimeAsync(500);
    }
    expect(save).toHaveBeenCalledOnce(); expect(save).toHaveBeenLastCalledWith(latest);
    scheduler.dispose();
  });
  it("flushes on completion and retries dirty snapshots after a failed save", async () => {
    vi.useFakeTimers();
    const save = vi.fn<(data: PersistedSession) => Promise<void>>().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const report = vi.fn();
    const scheduler = new CheckpointScheduler(() => session, save, report);
    scheduler.mark("s", true); await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    await scheduler.flushAll(); expect(save).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });
  it("waits for outstanding writes and flushes a second dirty generation", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const save = vi.fn<(data: PersistedSession) => Promise<void>>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const scheduler = new CheckpointScheduler(() => session, save, vi.fn());
    scheduler.mark("s", true); await vi.advanceTimersByTimeAsync(0);
    scheduler.mark("s");
    let done = false; const flush = scheduler.flushAll().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    finish(); await flush; expect(save).toHaveBeenCalledTimes(2); scheduler.dispose();
  });
});
