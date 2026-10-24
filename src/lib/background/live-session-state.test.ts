import { describe, expect, it } from "vitest";
import { BackgroundSessionStore, type BackgroundSessionState } from "./session-store";
function state(text: string): BackgroundSessionState {
  return { messages: [{ id: "a", role: "assistant", content: text, timestamp: 1 }], isProcessing: false,
    isConnected: true, isCompacting: false, sessionInfo: null, totalCost: 0, contextUsage: null,
    pendingPermission: null, rawAcpPermission: null, slashCommands: [] };
}
describe("pane ownership handoff", () => {
  it("reads the live split pane instead of stale background bootstrap and retains it on close", () => {
    const store = new BackgroundSessionStore(); store.initFromState("s", state("old"));
    let latest = state("new"); const release = store.registerLive("s", () => latest);
    expect(store.consume("s")?.messages[0].content).toBe("new");
    latest = state("final"); release();
    expect(store.hasLive("s")).toBe(false);
    expect(store.consume("s")?.messages[0].content).toBe("final");
  });
  it("keeps raw ACP choices through a foreground/background roundtrip", () => {
    const store = new BackgroundSessionStore(); const pending = state("waiting");
    pending.pendingPermission = { requestId: "req", toolName: "Edit", toolInput: {}, toolUseId: "tool" };
    pending.rawAcpPermission = { _sessionId: "s", sessionId: "agent-s", requestId: "req", toolCall: { toolCallId: "tool", title: "Edit", rawInput: {} }, options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] };
    const release = store.registerLive("s", () => pending); release();
    expect(store.consume("s")?.rawAcpPermission?.options[0].optionId).toBe("allow");
  });
  it("does not replace a newer pane owner when an older one unmounts", () => {
    const store = new BackgroundSessionStore();
    const first = store.registerLive("s", () => state("old pane"));
    const second = store.registerLive("s", () => state("new pane"));
    first(); expect(store.get("s")?.messages[0].content).toBe("new pane");
    second(); expect(store.get("s")?.messages[0].content).toBe("new pane");
  });
});
