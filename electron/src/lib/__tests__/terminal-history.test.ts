import { describe, expect, it } from "vitest";
import {
  appendTerminalHistory,
  EMPTY_TERMINAL_HISTORY,
  readTerminalHistory,
} from "../terminal-history";

describe("terminal history", () => {
  it("accumulates output chunks in order", () => {
    const history = appendTerminalHistory(
      appendTerminalHistory(EMPTY_TERMINAL_HISTORY, "hello "),
      "world",
    );

    expect(readTerminalHistory(history)).toBe("hello world");
  });

  it("does not share mutable history between terminals and compacts the deque", () => {
    let first = EMPTY_TERMINAL_HISTORY;
    const second = appendTerminalHistory(EMPTY_TERMINAL_HISTORY, "other");
    for (let i = 0; i < 5000; i++) first = appendTerminalHistory(first, String(i) + ",", 100);
    expect(readTerminalHistory(second)).toBe("other");
    expect(readTerminalHistory(first).endsWith("4999,")).toBe(true);
    expect(first.totalChars).toBeLessThanOrEqual(100);
    expect(first.chunks.length).toBeLessThan(1100);
    expect(EMPTY_TERMINAL_HISTORY).toEqual({ chunks: [], totalChars: 0, head: 0 });
  });

  it("drops oldest chunks when the buffer exceeds the limit", () => {
    let history = EMPTY_TERMINAL_HISTORY;
    history = appendTerminalHistory(history, "abc", 5);
    history = appendTerminalHistory(history, "de", 5);
    history = appendTerminalHistory(history, "fg", 5);

    expect(readTerminalHistory(history)).toBe("defg");
  });
});
