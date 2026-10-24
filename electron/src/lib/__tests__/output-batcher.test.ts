import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputBatcher } from "../output-batcher";
afterEach(() => vi.useRealTimers());
describe("terminal output batching", () => {
  it("coalesces chunks in order and flushes at the snapshot barrier", () => {
    vi.useFakeTimers(); const send = vi.fn(); const output = new OutputBatcher(send);
    output.push("a"); output.push("b"); expect(send).not.toHaveBeenCalled();
    output.flush(); expect(send).toHaveBeenCalledExactlyOnceWith("ab");
    vi.runAllTimers(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("bounds latency and buffered size and cancels timers on disposal", () => {
    vi.useFakeTimers(); const send = vi.fn(); const output = new OutputBatcher(send, 16, 4);
    output.push("a"); vi.advanceTimersByTime(16); expect(send).toHaveBeenLastCalledWith("a");
    output.push("1234"); expect(send).toHaveBeenLastCalledWith("1234");
    output.push("discard"); const count = send.mock.calls.length; output.push("x"); output.dispose();
    vi.runAllTimers(); expect(send).toHaveBeenCalledTimes(count);
  });
});
