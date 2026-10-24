import { afterEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@/types";
import { sharedSessionStore } from "@/lib/background/shared-session-store";
import { useSessionPane } from "./useSessionPane";
const runtime = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void>,
  messages: [] as UIMessage[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: <T,>(current: T) => ({ current }), useEffect: (effect: () => void | (() => void)) => runtime.effects.push(effect),
}));
vi.mock("../useClaude", () => ({ useClaude: () => ({}) }));
vi.mock("../useACP", () => ({ useACP: () => ({}) }));
vi.mock("../useCodex", () => ({ useCodex: () => ({ isReadyForSession: () => false,
  getMessagesSnapshot: () => runtime.messages, messages: [], isProcessing: true, isConnected: true,
  isCompacting: false, sessionInfo: null, totalCost: 0, contextUsage: null, pendingPermission: null, slashCommands: [],
  codexGoal: null, codexGoalSupported: null, reconnectMessage: null }) }));
afterEach(() => { for (const cleanup of runtime.cleanups) cleanup(); runtime.effects = []; runtime.cleanups = []; sharedSessionStore.delete("commit-test"); });
describe("pane commit-time message reader", () => {
  it("publishes the post-reset history and pending tokens before a follow-up render", () => {
    const initial: UIMessage = { id: "u", role: "user", content: "question", timestamp: 1 };
    useSessionPane({ activeSessionId: "commit-test", activeEngine: "codex", claudeSessionId: null, acpSessionId: null,
      codexSessionId: "commit-test", codexSessionModel: undefined, codexPlanModeEnabled: false,
      initialMessages: [initial], initialMeta: null, initialPermission: null, acpPermissionBehavior: "ask" });
    // Base reset runs before pane registration and restores a newer accumulator.
    runtime.messages = [initial, { id: "a", role: "assistant", content: "arrived during transition", timestamp: 2 }];
    for (const effect of runtime.effects) { const cleanup = effect(); if (cleanup) runtime.cleanups.push(cleanup); }
    expect(sharedSessionStore.get("commit-test")?.messages).toEqual(runtime.messages);
    runtime.messages = [...runtime.messages, { id: "tail", role: "assistant", content: "unpainted tokens", timestamp: 3 }];
    for (const cleanup of runtime.cleanups.splice(0)) cleanup();
    expect(sharedSessionStore.hasLive("commit-test")).toBe(false);
    expect(sharedSessionStore.get("commit-test")?.messages).toEqual(runtime.messages);
  });
});
