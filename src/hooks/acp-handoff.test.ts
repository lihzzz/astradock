import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { ACPPermissionEvent, PermissionRequest } from "@/types";
import { sharedSessionStore } from "@/lib/background/shared-session-store";
import { useACP } from "./useACP";
const lifecycle = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void> }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => { let value = initial; return [value, (update: SetStateAction<T>) => { value = typeof update === "function" ? (update as (previous: T) => T)(value) : update; }]; },
  useRef: <T,>(current: T) => ({ current }), useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
}));
vi.mock("@/lib/analytics/analytics", () => ({ captureException: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
afterEach(() => { for (const cleanup of lifecycle.cleanups) cleanup(); lifecycle.effects = []; lifecycle.cleanups = []; sharedSessionStore.delete("handoff"); vi.unstubAllGlobals(); });
describe("ACP permission and stream handoff", () => {
  it("uses the commit-time raw permission and buffered message rather than stale bootstrap", async () => {
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const respondPermission = vi.fn(async () => ({}));
    vi.stubGlobal("window", { claude: { acp: { log: vi.fn(), respondPermission,
      getConfigOptions: async () => ({ configOptions: [] }), getAvailableCommands: async () => ({ commands: [] }),
      onEvent: () => vi.fn(), onPermissionRequest: () => vi.fn(), onTurnComplete: () => vi.fn(), onExit: () => vi.fn(),
    } } });
    const permission: PermissionRequest = { requestId: "req", toolName: "Edit", toolInput: {}, toolUseId: "tool" };
    const raw: ACPPermissionEvent = { _sessionId: "handoff", sessionId: "agent", requestId: "req", toolCall: { toolCallId: "tool", title: "Edit", rawInput: {} },
      options: [{ optionId: "allow-choice", kind: "allow_once", name: "Allow" }] };
    const hook = useACP({ sessionId: "handoff", initialMessages: [], initialPermission: permission, initialRawAcpPermission: null });
    sharedSessionStore.initFromState("handoff", { messages: [{ id: "a", role: "assistant", content: "latest tokens", timestamp: 1, isStreaming: true }],
      isProcessing: true, isConnected: true, isCompacting: false, sessionInfo: null, totalCost: 0, contextUsage: null,
      pendingPermission: permission, rawAcpPermission: raw, slashCommands: [] });
    for (const effect of lifecycle.effects) { const cleanup = effect(); if (cleanup) lifecycle.cleanups.push(cleanup); }
    expect(hook.getMessagesSnapshot()[0].content).toBe("latest tokens");
    expect(hook.getRawPermission()).toEqual(raw);
    await hook.respondPermission("allow");
    expect(respondPermission).toHaveBeenCalledWith("handoff", "req", "allow-choice");
    expect(hook.getRawPermission()).toBeNull();
  });
});
