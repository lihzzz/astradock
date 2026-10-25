import { describe, expect, it, vi } from "vitest";
import { HistoryController } from "./history-controller";
import type { HistoryReadResult, ThreadHistoryPage } from "@shared/types/runtime-history";
const page = (epoch: string, nextCursor: string | null = null): ThreadHistoryPage => ({ kind: "history-page", epoch, items: [], nextCursor, total: 100, damagedRecords: 0, coldBuild: false, sourceBytesRead: 0 });
describe("bounded history client", () => {
  it("ignores stale asynchronous results after a refresh", async () => {
    let finish!: (value: HistoryReadResult) => void;
    const transport = { page: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, page: page("new") }) };
    const controller = new HistoryController(transport, "p", "s"); const old = controller.refresh(); await controller.refresh();
    finish({ ok: true, page: page("old") }); await old;
    expect(controller.getSnapshot().page?.epoch).toBe("new");
  });
  it("keeps the old page readable on error and deduplicates older requests", async () => {
    const transport = { page: vi.fn().mockResolvedValueOnce({ ok: true, page: page("old", "cursor") }).mockResolvedValue({ ok: false, error: { code: "CURSOR_EXPIRED", message: "Refresh required" } }) };
    const controller = new HistoryController(transport, "p", "s"); await controller.refresh();
    await Promise.all([controller.older(), controller.older()]);
    expect(transport.page).toHaveBeenCalledTimes(2); expect(controller.getSnapshot().page?.epoch).toBe("old");
    expect(controller.getSnapshot().error).toBe("Refresh required");
  });
  it("does not publish a pending result after the final view is disposed", async () => {
    let finish!: (value: HistoryReadResult) => void;
    const controller = new HistoryController({ page: () => new Promise(resolve => { finish = resolve; }) }, "p", "s");
    const listener = vi.fn(); controller.subscribe(listener); const pending = controller.refresh(); controller.dispose(); listener.mockClear();
    finish({ ok: true, page: page("late") }); await pending; expect(listener).not.toHaveBeenCalled();
  });
});
