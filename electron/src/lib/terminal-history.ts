export const MAX_TERMINAL_HISTORY_CHARS = 250_000;

export interface TerminalHistoryState {
  chunks: string[];
  totalChars: number;
  head: number;
}

export const EMPTY_TERMINAL_HISTORY: TerminalHistoryState = {
  chunks: [],
  totalChars: 0,
  head: 0,
};

export function appendTerminalHistory(
  history: TerminalHistoryState,
  chunk: string,
  maxChars: number = MAX_TERMINAL_HISTORY_CHARS,
): TerminalHistoryState {
  if (!chunk) return history;

  // Single-owner mutable deque; never mutate the shared empty sentinel.
  if (history === EMPTY_TERMINAL_HISTORY) history = { chunks: [], totalChars: 0, head: 0 };
  const chunks = history.chunks;
  chunks.push(chunk);
  let head = history.head;
  let totalChars = history.totalChars + chunk.length;

  while (chunks.length - head > 1 && totalChars > maxChars) {
    const removed = chunks[head];
    chunks[head++] = "";
    if (!removed) break;
    totalChars -= removed.length;
  }

  if (chunks.length - head === 1 && totalChars > maxChars) {
    chunks[head] = chunks[head].slice(-maxChars);
    totalChars = chunks[head].length;
  }

  if (head >= 1024 && head * 2 >= chunks.length) {
    history.chunks = chunks.slice(head); head = 0;
  }
  history.head = head; history.totalChars = totalChars;
  return history;
}

export function readTerminalHistory(history: TerminalHistoryState): string {
  return history.chunks.slice(history.head).join("");
}
