import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { CodexSessionEvent, CodexThreadItem, CodexExitEvent, UIMessage } from "@/types";
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
interface Driver { emit: (event: CodexSessionEvent) => void; disconnect: (code?: number) => void; messages: () => UIMessage[]; processing: () => boolean }
function foreground(initialMessages: UIMessage[] = []): Driver {
  let handler: Driver["emit"] = () => { throw new Error("Not subscribed"); };
  let exit: (event: CodexExitEvent) => void = () => { throw new Error("Not subscribed"); };
  vi.stubGlobal("window", { claude: { codex: {
    onEvent: (callback: Driver["emit"]) => { handler = callback; return vi.fn(); },
    onApprovalRequest: () => vi.fn(), onExit: (callback: typeof exit) => { exit = callback; return vi.fn(); },
    getGoal: vi.fn().mockResolvedValue({ supported: false }),
    listSkills: vi.fn().mockResolvedValue({ skills: [] }), listApps: vi.fn().mockResolvedValue({ apps: [] }),
  } } });
  lifecycle.effects = [];
  const hook = useCodex({ sessionId, initialMessages });
  for (const effect of lifecycle.effects) { const cleanup = effect(); if (cleanup) lifecycle.cleanups.push(cleanup); }
  return { emit: (event) => handler(event), disconnect: (code) => exit({ _sessionId: sessionId, code: code ?? null, signal: "SIGTERM" }),
    messages: () => { let value: UIMessage[] = []; hook.setMessages((current) => { value = current; return current; }); return value; },
    processing: () => { let value = false; hook.setIsProcessing((current) => { value = current; return current; }); return value; } };
}
function background(initialMessages: UIMessage[] = []): Driver {
  const store = new BackgroundSessionStore();
  store.initFromState(sessionId, { messages: initialMessages, isProcessing: false, isConnected: true, isCompacting: false,
    sessionInfo: null, totalCost: 0, contextUsage: null, pendingPermission: null, rawAcpPermission: null, slashCommands: [] });
  return { emit: (event) => store.handleCodexEvent(event), disconnect: () => store.markDisconnected(sessionId), messages: () => store.get(sessionId)!.messages,
    processing: () => store.get(sessionId)!.isProcessing };
}
beforeEach(() => {
  lifecycle.effects = []; lifecycle.cleanups = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0));
  vi.stubGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
});
afterEach(() => { for (const cleanup of lifecycle.cleanups) cleanup(); vi.unstubAllGlobals(); });


function itemEvent(driver: Driver, method: "item/started" | "item/completed", item: CodexThreadItem) {
  driver.emit({ _sessionId: sessionId, method, params: { threadId: "root", turnId: "turn", item } });
}
function command(status: "inProgress" | "completed" | "failed" | "declined" = "inProgress"): CodexThreadItem {
  return { type: "commandExecution", id: "cmd", command: "cat src/main.ts", cwd: "/repo", processId: "42", status,
    commandActions: [{ type: "read", command: "cat src/main.ts", name: "main.ts", path: "src/main.ts" }],
    aggregatedOutput: null, durationMs: status === "inProgress" ? null : 120, exitCode: status === "completed" ? 0 : null };
}
function output(driver: Driver, delta: string) {
  driver.emit({ _sessionId: sessionId, method: "item/commandExecution/outputDelta", params: { threadId: "root", turnId: "turn", itemId: "cmd", delta } });
}
function text(driver: Driver, itemId: string, delta: string) {
  driver.emit({ _sessionId: sessionId, method: "item/agentMessage/delta", params: { threadId: "root", turnId: "turn", itemId, delta } });
}

describe.each([["foreground", foreground], ["background", background]] as const)("Codex %s message metadata", (_name, createDriver) => {
  it("keeps commentary and final answers separate and persists their identities", () => {
    const driver = createDriver();
    itemEvent(driver, "item/started", { type: "agentMessage", id: "progress", text: "", phase: "commentary" });
    text(driver, "progress", "Checking code");
    itemEvent(driver, "item/completed", { type: "agentMessage", id: "progress", text: "Checking code", phase: "commentary" });
    itemEvent(driver, "item/started", { type: "agentMessage", id: "answer", text: "", phase: "final_answer" });
    text(driver, "answer", "Done");
    itemEvent(driver, "item/completed", { type: "agentMessage", id: "answer", text: "Done", phase: "final_answer" });
    expect(driver.messages()).toMatchObject([
      { phase: "commentary", codexItemId: "progress", turnId: "turn", content: "Checking code", isStreaming: false },
      { phase: "final_answer", codexItemId: "answer", turnId: "turn", content: "Done", isStreaming: false },
    ]);
  });
  it("retains command semantics and stays in progress during stdout", () => {
    const driver = createDriver();
    itemEvent(driver, "item/started", command());
    output(driver, "partial output");
    expect(driver.messages()[0]).toMatchObject({ toolName: "Bash", toolState: { status: "inProgress" },
      commandExecution: { cwd: "/repo", processId: "42", actions: [{ type: "read", path: "src/main.ts" }] } });
    const done = command("completed");
    if (done.type !== "commandExecution") throw new Error("Expected command");
    itemEvent(driver, "item/completed", { ...done, aggregatedOutput: "canonical output" });
    expect(driver.messages()[0]).toMatchObject({ toolState: { status: "completed", durationMs: 120, exitCode: 0 } });
    expect(driver.messages()[0].toolResult?.stdout).toContain("canonical output");
    expect(driver.messages()[0].toolResult?.stdout).not.toContain("partial output");
  });
  it("keeps streamed output when completion omits it", () => {
    const driver = createDriver();
    itemEvent(driver, "item/started", command()); output(driver, "retained output");
    itemEvent(driver, "item/completed", command("completed"));
    expect(driver.messages()[0].toolResult?.stdout).toBe("retained output");
    itemEvent(driver, "item/completed", command("completed"));
    expect(driver.messages()[0].toolResult?.stdout).toBe("retained output");
  });
  it("completes an empty-output tool and preserves refusals", () => {
    const driver = createDriver();
    const item: CodexThreadItem = { type: "mcpToolCall", id: "empty", server: "server", tool: "tool", status: "inProgress", arguments: {}, result: null, error: null, durationMs: null };
    itemEvent(driver, "item/started", item);
    itemEvent(driver, "item/completed", { ...item, status: "completed", durationMs: 10 });
    expect(driver.messages()[0]).toMatchObject({ toolState: { status: "completed", durationMs: 10 } });
    itemEvent(driver, "item/started", command()); itemEvent(driver, "item/completed", command("declined"));
    expect(driver.messages()[1]).toMatchObject({ toolState: { status: "declined" }, toolError: true });
  });
  it("stops outstanding tools when their turn is interrupted", () => {
    const driver = createDriver(); itemEvent(driver, "item/started", command());
    driver.emit({ _sessionId: sessionId, method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "interrupted", items: [], error: null } } });
    expect(driver.messages()[0].toolState?.status).toBe("interrupted");
  });
  it("keeps retryable transport errors running but settles terminal errors", () => {
    const driver = createDriver(); itemEvent(driver, "item/started", command());
    const params = { threadId: "root", turnId: "turn", willRetry: true, error: { message: "Connection lost", codexErrorInfo: null, additionalDetails: null } };
    driver.emit({ _sessionId: sessionId, method: "error", params });
    expect(driver.messages()[0].toolState?.status).toBe("inProgress");
    driver.emit({ _sessionId: sessionId, method: "error", params: { ...params, willRetry: false } });
    expect(driver.messages()[0].toolState?.status).toBe("failed");
  });
  it("marks unfinished tools as stopped when the process exits", () => {
    const driver = createDriver(); itemEvent(driver, "item/started", command());
    driver.disconnect();
    expect(driver.messages()[0].toolState?.status).toBe("interrupted");
  });
  it("handles final messages that arrive without a start event", () => {
    const driver = createDriver();
    itemEvent(driver, "item/completed", { type: "agentMessage", id: "answer", text: "Done", phase: "final_answer" });
    expect(driver.messages()[0]).toMatchObject({ content: "Done", phase: "final_answer", codexItemId: "answer" });
  });
});

it("retains metadata and output through foreground → background → JSON → foreground", () => {
  const active = foreground(); itemEvent(active, "item/started", command()); output(active, "one ");
  const hidden = background(active.messages()); output(hidden, "two ");
  const restored = foreground(JSON.parse(JSON.stringify(hidden.messages()))); output(restored, "three");
  itemEvent(restored, "item/completed", command("completed"));
  expect(restored.messages()).toHaveLength(1);
  expect(restored.messages()[0]).toMatchObject({ codexItemId: "cmd", turnId: "turn", toolState: { status: "completed" }, commandExecution: { actions: [{ type: "read" }] } });
  expect(restored.messages()[0].toolResult?.stdout).toContain("one two three");
});

it("rebinds phase-aware assistant deltas after switching back", () => {
  const active = foreground();
  itemEvent(active, "item/started", { type: "agentMessage", id: "answer", text: "", phase: "final_answer" });
  const hidden = background(active.messages()); text(hidden, "answer", "one ");
  const restored = foreground(JSON.parse(JSON.stringify(hidden.messages()))); text(restored, "answer", "two");
  itemEvent(restored, "item/completed", { type: "agentMessage", id: "answer", text: "", phase: "final_answer" });
  expect(restored.messages()).toHaveLength(1);
  expect(restored.messages()[0]).toMatchObject({ content: "one two", phase: "final_answer", isStreaming: false });
});


describe("Codex process exit retry eligibility", () => {
  it("does not retry an idle session", () => {
    const driver = foreground();
    driver.disconnect(1);
    expect(driver.messages().at(-1)).toMatchObject({ isError: true });
    expect(driver.messages().at(-1)?.retryable).not.toBe(true);
  });
  it("does not retry after completion, even before React renders", () => {
    const driver = foreground();
    driver.emit({ _sessionId: sessionId, method: "turn/started", params: { threadId: "root", turn: { id: "turn", status: "inProgress", items: [], error: null } } });
    driver.emit({ _sessionId: sessionId, method: "turn/completed", params: { threadId: "root", turn: { id: "turn", status: "completed", items: [], error: null } } });
    driver.disconnect(1);
    expect(driver.messages().at(-1)?.retryable).not.toBe(true);
  });
  it("still permits retry when an active turn crashes", () => {
    const driver = foreground();
    driver.emit({ _sessionId: sessionId, method: "turn/started", params: { threadId: "root", turn: { id: "turn", status: "inProgress", items: [], error: null } } });
    driver.disconnect(1);
    expect(driver.messages().at(-1)?.retryable).toBe(true);
  });
});
