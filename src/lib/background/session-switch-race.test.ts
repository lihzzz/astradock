import { describe, expect, it } from "vitest";
import { BackgroundSessionStore, type BackgroundSessionState } from "./session-store";
function history(): BackgroundSessionState {
  return { messages: [{ id: "user", role: "user", content: "question", timestamp: 1 },
    { id: "answer", role: "assistant", content: "partial", timestamp: 2, codexItemId: "item", isStreaming: true }],
    isProcessing: true, isConnected: true, isCompacting: false, sessionInfo: null, totalCost: 0,
    contextUsage: null, pendingPermission: null, rawAcpPermission: null, slashCommands: [] };
}
function complete(store: BackgroundSessionStore, text: string) {
  store.handleCodexEvent({ _sessionId: "s", method: "item/completed", params: {
    threadId: "thread", turnId: "turn", item: { type: "agentMessage", id: "item", text, phase: "final_answer" },
  } });
}
describe("session selection to pane commit gap", () => {
  it("retains full history when a completion arrives after selection but before React mounts the pane", () => {
    const store = new BackgroundSessionStore(); store.initFromState("s", history());
    const bootstrap = store.consume("s")!;
    complete(store, "completed during transition");
    const committed = store.get("s")!;
    expect(committed.messages.map(m => m.id)).toEqual(["user", "answer"]);
    expect(committed.messages[1].content).toBe("completed during transition");
    expect(bootstrap.messages[1].content).toBe("partial");
    const release = store.registerLive("s", () => committed); release();
    expect(store.get("s")?.messages).toEqual(committed.messages);
  });
  it("keeps the authoritative state if a transition is superseded, without leaking into another session", () => {
    const store = new BackgroundSessionStore(); store.initFromState("s", history());
    store.initFromState("other", { ...history(), messages: [] });
    for (let i = 0; i < 5; i++) { store.consume("s"); complete(store, "update " + i); }
    expect(store.get("s")?.messages.map(m => m.id)).toEqual(["user", "answer"]);
    expect(store.get("s")?.messages[1].content).toBe("update 4");
    expect(store.get("other")?.messages).toEqual([]);
    store.delete("s"); expect(store.has("s")).toBe(false);
  });
});
