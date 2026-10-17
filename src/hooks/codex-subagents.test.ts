import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { CodexSessionEvent, UIMessage } from "@/types";
import { CodexSubagentTracker } from "@shared/lib/codex-subagents";
import type { CodexSubagentUpdate } from "@shared/types/codex-subagents";
import { BackgroundSessionStore } from "@/lib/background/session-store";
import { useCodex } from "./useCodex";

const lifecycle = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, cleanups: [] as Array<() => void> }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    let value = initial;
    return [value, (update: SetStateAction<T>) => {
      value = typeof update === "function" ? (update as (previous: T) => T)(value) : update;
    }];
  },
  useRef: <T,>(current: T) => ({ current }),
  useCallback: <T,>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => lifecycle.effects.push(effect),
}));
vi.mock("@/lib/analytics/analytics", () => ({ captureException: vi.fn() }));

const sessionId = "session";
interface Driver { emit: (event: CodexSessionEvent) => void; messages: () => UIMessage[]; processing: () => boolean }
function foreground(initialMessages: UIMessage[] = []): Driver {
  let handler: Driver["emit"] = () => { throw new Error("Not subscribed"); };
  vi.stubGlobal("window", { claude: { codex: {
    onEvent: (callback: Driver["emit"]) => { handler = callback; return vi.fn(); },
    onApprovalRequest: () => vi.fn(), onExit: () => vi.fn(),
    getGoal: vi.fn().mockResolvedValue({ supported: false }),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }), listApps: vi.fn().mockResolvedValue({ apps: [] }),
  } } });
  lifecycle.effects = [];
  const hook = useCodex({ sessionId, initialMessages });
  for (const effect of lifecycle.effects) { const cleanup = effect(); if (cleanup) lifecycle.cleanups.push(cleanup); }
  return { emit: (event) => handler(event),
    messages: () => { let value: UIMessage[] = []; hook.setMessages((current) => { value = current; return current; }); return value; },
    processing: () => { let value = false; hook.setIsProcessing((current) => { value = current; return current; }); return value; } };
}
function background(initialMessages: UIMessage[] = []): Driver {
  const store = new BackgroundSessionStore();
  store.initFromState(sessionId, { messages: initialMessages, isProcessing: false, isConnected: true, isCompacting: false,
    sessionInfo: null, totalCost: 0, contextUsage: null, pendingPermission: null, rawAcpPermission: null, slashCommands: [] });
  return { emit: (event) => store.handleCodexEvent(event), messages: () => store.get(sessionId)!.messages,
    processing: () => store.get(sessionId)!.isProcessing };
}
function emitUpdate(driver: Driver, update: CodexSubagentUpdate | null) {
  if (!update) throw new Error("Expected a normalized subagent event");
  driver.emit({ _sessionId: sessionId, method: "codex:subagent", params: update });
}
function spawn(tracker: CodexSubagentTracker) {
  return tracker.observe("item/completed", { threadId: "root", turnId: "turn", item: {
    type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", senderThreadId: "root",
    receiverThreadIds: ["child"], prompt: "Render subagents as cards", model: "worker-model", reasoningEffort: "high",
    agentsStates: { child: { status: "running", message: null } },
  } }, 10);
}
function finish(tracker: CodexSubagentTracker) {
  return tracker.observe("item/completed", { threadId: "root", turnId: "turn", item: {
    type: "subAgentActivity", id: "done", kind: "completed", agentThreadId: "child", model: "resolved-model", reasoningEffort: "high",
  } }, 20);
}

beforeEach(() => {
  lifecycle.effects = []; lifecycle.cleanups = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
});
afterEach(() => { for (const cleanup of lifecycle.cleanups) cleanup(); vi.unstubAllGlobals(); });

describe.each([["foreground", foreground], ["background", background]] as const)("Codex %s agent cards", (_name, createDriver) => {
  it("displays model/objective and updates the agent without completing the parent's turn", () => {
    const driver = createDriver();
    const tracker = new CodexSubagentTracker(() => "root");
    driver.emit({ _sessionId: sessionId, method: "turn/started", params: { threadId: "root", turn: { id: "turn", status: "inProgress", items: [], error: null } } });
    emitUpdate(driver, spawn(tracker));
    expect(driver.messages()[0].codexAgent).toMatchObject({ call: { status: "completed", prompt: "Render subagents as cards" }, agents: [{ status: "running", model: "worker-model" }] });
    emitUpdate(driver, finish(tracker));
    expect(driver.messages()).toHaveLength(1);
    expect(driver.messages()[0].codexAgent?.agents[0]).toMatchObject({ status: "completed", model: "resolved-model" });
    expect(driver.processing()).toBe(true);
  });
});

it("retains card data through foreground -> background -> foreground and JSON reload", () => {
  const tracker = new CodexSubagentTracker(() => "root");
  const active = foreground();
  emitUpdate(active, spawn(tracker));
  const hidden = background(active.messages());
  emitUpdate(hidden, finish(tracker));
  const reloaded: UIMessage[] = JSON.parse(JSON.stringify(hidden.messages()));
  const restored = foreground(reloaded);
  expect(restored.messages()[0].codexAgent?.agents[0]).toMatchObject({ status: "completed", model: "resolved-model", task: "Render subagents as cards" });
  emitUpdate(restored, tracker.observe("thread/closed", { threadId: "child" }, 30));
  expect(restored.messages()[0].codexAgent?.agents[0].status).toBe("shutdown");
  expect(restored.messages()).toHaveLength(1);
});
