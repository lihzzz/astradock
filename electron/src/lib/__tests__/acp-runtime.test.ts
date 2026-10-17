import { describe, expect, it, vi } from "vitest";
import { AcpSerialQueue, AcpEventRouter, acpMcpStatuses, closeAcpSession, restoreAcpSession, setAcpConfig, withAcpTimeout } from "../acp-runtime";

const request = { sessionId: "session", cwd: "/project", mcpServers: [] };
describe("ACP capability-driven runtime", () => {
  it("prefers resume and does not replay history", async () => {
    const connection = { unstable_resumeSession: vi.fn().mockResolvedValue({ configOptions: [] }), loadSession: vi.fn() };
    expect((await restoreAcpSession(connection, { loadSession: true, sessionCapabilities: { resume: {} } }, request)).method).toBe("resume");
    expect(connection.loadSession).not.toHaveBeenCalled();
  });
  it("falls back only on method-not-found", async () => {
    const connection = { unstable_resumeSession: vi.fn().mockRejectedValue({ code: -32601 }), loadSession: vi.fn().mockResolvedValue({}) };
    expect((await restoreAcpSession(connection, { loadSession: true, sessionCapabilities: { resume: {} } }, request)).method).toBe("load");
    connection.loadSession.mockClear(); connection.unstable_resumeSession.mockRejectedValue({ code: -32602 });
    await expect(restoreAcpSession(connection, { loadSession: true, sessionCapabilities: { resume: {} } }, request)).rejects.toEqual({ code: -32602 });
    expect(connection.loadSession).not.toHaveBeenCalled();
  });
  it("does not mistake MCP registration for connection", () => {
    expect(acpMcpStatuses([{ name: "broken" }])).toEqual([{ name: "broken", status: "unknown" }]);
  });
  it("bounds unresponsive work and reacts to closed connections", async () => {
    vi.useFakeTimers();
    const promise = withAcpTimeout(new Promise<never>(() => {}), 100, "test");
    const assertion = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100); await assertion;
    const controller = new AbortController(); controller.abort();
    await expect(withAcpTimeout(new Promise<never>(() => {}), 100, "test", controller.signal)).rejects.toThrow("closed");
    expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
  it("buffers startup control events but rejects other sessions", () => {
    const deliver = vi.fn(); const router = new AcpEventRouter(deliver);
    router.receive("aux", { sessionUpdate: "available_commands_update" });
    router.receive("main", { sessionUpdate: "config_option_update" });
    router.receive("aux", { sessionUpdate: "tool_call" });
    router.bind("main"); router.receive("aux", { sessionUpdate: "usage_update" });
    expect(deliver.mock.calls).toEqual([[{ sessionUpdate: "config_option_update" }, "main"]]);
  });
  it("closes only when advertised and tolerates old servers", async () => {
    const connection = { extMethod: vi.fn().mockResolvedValue({}) };
    expect(await closeAcpSession(connection, {}, "session")).toBe(false);
    expect(connection.extMethod).not.toHaveBeenCalled();
    const capabilities = { sessionCapabilities: { resume: {}, close: {} } };
    expect(await closeAcpSession(connection, capabilities, "session")).toBe(true);
    expect(connection.extMethod).toHaveBeenCalledWith("session/close", { sessionId: "session" });
  });
});

describe("ACP configuration compatibility", () => {
  const options = [{ id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "old", options: [] },
    { id: "effort", name: "Effort", category: "thought_level", type: "select" as const, currentValue: "high", options: [] }];
  const input = { sessionId: "s", configId: "model", value: "new" };
  it("replaces options, including model-dependent effort", async () => {
    const connection = { setSessionConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }), unstable_setSessionModel: vi.fn(), setSessionMode: vi.fn() };
    expect(await setAcpConfig(connection, input, options)).toEqual([]);
  });
  it("never retries invalid model or transport failures through a legacy API", async () => {
    for (const error of [{ code: -32602 }, new Error("closed"), { code: -32603 }]) {
      const connection = { setSessionConfigOption: vi.fn().mockRejectedValue(error), unstable_setSessionModel: vi.fn(), setSessionMode: vi.fn() };
      await expect(setAcpConfig(connection, input, options)).rejects.toEqual(error);
      expect(connection.unstable_setSessionModel).not.toHaveBeenCalled();
    }
  });
  it("drops stale effort on legacy model changes and handles mode separately", async () => {
    const connection = { setSessionConfigOption: vi.fn().mockRejectedValue({ code: -32601 }), unstable_setSessionModel: vi.fn(), setSessionMode: vi.fn() };
    expect(await setAcpConfig(connection, input, options)).toEqual([{ ...options[0], currentValue: "new" }]);
    await setAcpConfig(connection, { ...input, configId: "mode", value: "plan" }, []);
    expect(connection.setSessionMode).toHaveBeenCalledWith({ sessionId: "s", modeId: "plan" });
  });
});


it("serializes configuration mutations without poisoning the queue on failure", async () => {
  const queue = new AcpSerialQueue(); const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue.run("s", async () => { calls.push("first"); await gate; throw new Error("invalid model"); });
  const failure = expect(first).rejects.toThrow("invalid model");
  const second = queue.run("s", async () => { calls.push("second"); return "ok"; });
  await Promise.resolve(); expect(calls).toEqual(["first"]); release();
  await failure; expect(await second).toBe("ok"); expect(calls).toEqual(["first", "second"]);
});
