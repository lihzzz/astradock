import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundSessionStore, type BackgroundSessionState } from "@/lib/background/session-store";
import { saveSessionSmart } from "./persistence";
import type { PersistedSession } from "@/types";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const data: PersistedSession = { id: crypto.randomUUID(), projectId: "p", title: "test", createdAt: 1, totalCost: 0,
    messages: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), role: "user", content: "x".repeat(100), timestamp: i })) };
  const api = { save: vi.fn().mockResolvedValue({ revision: 1 }), append: vi.fn().mockResolvedValue({ revision: 2 }) };
  vi.stubGlobal("window", { claude: { sessions: api } });
  return { data, api };
}
describe("checkpoint delta integration", () => {
  it("does not send cloned unchanged messages, and sends only the changed tail", async () => {
    const { data, api } = setup();
    const store = new BackgroundSessionStore();
    const state: BackgroundSessionState = { messages: data.messages!, isProcessing: true, isConnected: true, isCompacting: false,
      sessionInfo: null, totalCost: 0, contextUsage: null, pendingPermission: null, rawAcpPermission: null, slashCommands: [] };
    store.registerLive(data.id, () => state);
    const save = () => saveSessionSmart({ ...data, messages: store.get(data.id)!.messages });
    await save(); await save();
    expect(api.append.mock.calls[0][0].appendedMessages).toEqual([]);
    state.messages[999].content += "changed";
    await save();
    expect(api.append.mock.calls[1][0].appendedMessages).toEqual([state.messages[999]]);
    expect(api.append.mock.calls[1][0].persistenceRevision).toBe(2);
  });
  it("detects in-place nested tool edits and freezes queued wire snapshots", async () => {
    const { data, api } = setup();
    data.messages = [{ id: "tool", role: "tool_call", content: "", timestamp: 1, toolInput: { nested: { value: 1 } } }];
    await saveSessionSmart(data);
    data.messages[0].toolInput = { nested: { value: 2 } };
    let finish!: (value: object) => void;
    api.append.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = saveSessionSmart(data);
    data.messages[0].toolInput = { nested: { value: 3 } };
    finish({ revision: 2 }); await pending;
    expect(api.append.mock.calls[0][0].appendedMessages[0].toolInput).toEqual({ nested: { value: 2 } });
    await saveSessionSmart(data);
    expect(api.append.mock.calls[1][0].appendedMessages[0].toolInput).toEqual({ nested: { value: 3 } });
  });
});
