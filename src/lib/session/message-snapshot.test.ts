import { describe, expect, it } from "vitest";
import { snapshotStreamingMessages } from "./message-snapshot";
import type { UIMessage } from "@/types";
describe("unpainted stream snapshot", () => {
  it("includes pending tokens while retaining identities of unchanged history", () => {
    const history: UIMessage = { id: "u", role: "user", content: "hi", timestamp: 1 };
    const partial: UIMessage = { id: "a", role: "assistant", content: "hel", timestamp: 2, isStreaming: true };
    const messages = [history, partial];
    const snapshot = snapshotStreamingMessages(messages, "a", "hello", "thought", false);
    expect(snapshot[0]).toBe(history); expect(snapshot[1].content).toBe("hello"); expect(partial.content).toBe("hel");
  });
  it("does not clone a settled history", () => {
    const messages: UIMessage[] = [];
    expect(snapshotStreamingMessages(messages, null, "", "", false)).toBe(messages);
  });
});
