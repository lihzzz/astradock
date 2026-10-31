vi.mock("./credential-env", () => ({ councilCredentialEnv: async () => ({}) }));
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  binary: vi.fn(async () => "claude.exe"),
  agent: vi.fn(() => ({ id: "claude-code", engine: "claude" }))
}));
vi.mock("../sdk", () => ({ getSDK: async () => mocks.query, clientAppEnv: () => ({ CLAUDE_AGENT_SDK_CLIENT_APP: "test" }) }));
vi.mock("../claude-binary", () => ({ getClaudeBinaryPath: mocks.binary }));
vi.mock("../agent-registry", () => ({ getAgent: mocks.agent }));
import { CouncilAgentRuntime, councilClaudeOptions, COUNCIL_CAPABILITIES } from "./runtime";
const member = {
  id: "a",
  name: "A",
  engine: "claude" as const,
  agentId: "claude-code",
  model: "requested-model",
  role: "Discuss"
};
function stream(events: unknown[]) {
  const close = vi.fn();
  return { close, async *[Symbol.asyncIterator]() {
      for (const e of events)
        yield e;
    } };
}
beforeEach(() => {
  vi.clearAllMocks();
});
describe("Council material-only runtime", () => {
  it("enforces no built-ins, no MCP, no loaded hooks/plugins or settings", async () => {
    const options = councilClaudeOptions("/temp", "model", "claude.exe", new AbortController());
    expect(options).toMatchObject({
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      plugins: [],
      settings: { disableAllHooks: true },
      settingSources: [],
      hooks: {},
      permissionMode: "dontAsk",
      persistSession: false,
      maxTurns: 1
    });
    expect(await options.canUseTool!("Bash", {}, {
      signal: new AbortController().signal,
      toolUseID: "x",
      requestId: "x"
    })).toMatchObject({ behavior: "deny" });
  });
  it("streams text, collects usage only on confirmed result, and removes its temporary cwd", async () => {
    const q = stream([{ type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } }, { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }, {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Hello",
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }]);
    mocks.query.mockReturnValue(q);
    const onText = vi.fn();
    const result = await new CouncilAgentRuntime().execute({
      member,
      prompt: "Public fixture",
      signal: new AbortController().signal,
      onText
    });
    expect(result).toEqual({
      text: "Hello",
      tokens: 6,
      cost: 0.01
    });
    expect(onText).toHaveBeenCalledWith("Hello");
    expect(q.close).toHaveBeenCalled();
    const call = mocks.query.mock.calls[0][0] as {
      options: Options;
    };
    expect(call.options.model).toBe("requested-model");
    await expect(fs.stat(call.options.cwd!)).rejects.toThrow();
  });
  it("does not mistake a partial assistant message for a successful turn", async () => {
    mocks.query.mockReturnValue(stream([{ type: "assistant", message: { content: [{ type: "text", text: "Partial" }] } }]));
    await expect(new CouncilAgentRuntime().execute({
      member,
      prompt: "x",
      signal: new AbortController().signal,
      onText: () => {
      }
    })).rejects.toThrow("No confirmed final result");
  });
  it("rejects tool outputs even if the engine violates the requested policy", async () => {
    const q = stream([{ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }]);
    mocks.query.mockReturnValue(q);
    await expect(new CouncilAgentRuntime().execute({
      member,
      prompt: "x",
      signal: new AbortController().signal,
      onText: () => {
      }
    })).rejects.toThrow("Tool output rejected");
    expect(q.close).toHaveBeenCalled();
  });
  it("does not spawn a query when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new CouncilAgentRuntime().execute({
      member,
      prompt: "x",
      signal: controller.signal,
      onText: () => {
      }
    })).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("fails closed on engines without an attested material-only adapter", async () => {
    expect(COUNCIL_CAPABILITIES.filter(c => c.supported).map(c => c.engine)).toEqual(["claude"]);
    const runtime = new CouncilAgentRuntime();
    for (const engine of ["codex", "acp"] as const)
      await expect(runtime.validate({ ...member, engine })).rejects.toThrow();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
