import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { acpHistoryMessages } from "./acp-history";

function event(update: SessionNotification["update"]): SessionNotification { return { sessionId: "remote", update }; }
describe("ACP explicit history import", () => {
  it("reconstructs user and assistant messages without streaming leftovers", () => {
    const result = acpHistoryMessages([
      event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } }),
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first " } }),
      event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } }),
      event({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "next" } }),
    ]);
    expect(result.map(message => [message.role, message.content])).toEqual([["user", "hello"], ["assistant", "first answer"], ["user", "next"]]);
    expect(result.every(message => !message.isStreaming)).toBe(true);
  });
  it("preserves image data and embedded text", () => {
    const result = acpHistoryMessages([
      event({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: "png" } }),
      event({ sessionUpdate: "user_message_chunk", content: { type: "resource", resource: { uri: "file:///code.ts", text: "const x = 1;" } } }),
    ]);
    expect(result[0].images?.[0]).toMatchObject({ data: "png", mediaType: "image/png" });
    expect(result[0].content).toContain("const x = 1;");
  });
  it("preserves multi-file patches and nullable tool locations", () => {
    const result = acpHistoryMessages([
      event({ sessionUpdate: "tool_call", toolCallId: "t", title: "edit", kind: "edit", locations: [{ path: "a", line: null }] }),
      event({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed", content: [
        { type: "diff", path: "a", oldText: null, newText: "a" }, { type: "diff", path: "b", oldText: "b", newText: "" },
      ] }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].toolResult?.structuredPatch).toHaveLength(2);
  });
});
