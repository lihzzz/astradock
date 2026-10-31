import { councilCredentialEnv } from "./credential-env";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { CouncilCapability, CouncilMember } from "@shared/types/council";
import { getSDK, clientAppEnv } from "../sdk";
import { getClaudeBinaryPath } from "../claude-binary";
import { getAgent } from "../agent-registry";
import { isRecord, ProductivityError } from "../productivity-errors";
import type { CouncilRuntime, CouncilCallResult } from "./service";
/** Do not advertise isolation based on a prompt or on post-execution tool events.
* Codex read-only still permits reads/MCP; ACP has no portable no-tools contract. */
export const COUNCIL_CAPABILITIES: CouncilCapability[] = [
  {
    engine: "claude",
    supported: true,
    reason: "Material-only: SDK tools=[], strict empty MCP, disabled hooks/plugins, fresh temporary cwd; requires installed Claude login."
  },
  {
    engine: "codex",
    supported: false,
    reason: "Material-only isolation not attested: read-only sandbox is not a no-tools/no-MCP boundary. Ordinary Codex sessions remain available."
  },
  {
    engine: "acp",
    supported: false,
    reason: "ACP agents do not expose a portable verified no-tools contract. Ordinary ACP sessions remain available."
  },
];
export function councilClaudeOptions(cwd: string, model: string, binary: string, controller: AbortController): Options {
  return {
    cwd,
    model,
    maxTurns: 1,
    persistSession: false,
    settingSources: [],
    tools: [],
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    plugins: [],
    settings: { disableAllHooks: true },
    hooks: {},
    permissionMode: "dontAsk",
    abortController: controller,
    pathToClaudeCodeExecutable: binary,
    canUseTool: async () => ({ behavior: "deny", message: "Council material-only sessions never execute tools" }),
    env: { ...process.env, ...clientAppEnv() },
    includePartialMessages: true
  };
}
export class CouncilAgentRuntime implements CouncilRuntime {
  async validate(member: CouncilMember): Promise<void> {
    const capability = COUNCIL_CAPABILITIES.find(c => c.engine === member.engine);
    if (!capability?.supported)
      throw new ProductivityError("UNSUPPORTED_CAPABILITY", capability?.reason ?? "Unsupported engine");
    const agent = getAgent(member.agentId);
    if (!agent || agent.engine !== member.engine || member.agentId !== "claude-code")
      throw new ProductivityError("INVALID_ARGUMENT", "Use the verified built-in Claude adapter");
    await getClaudeBinaryPath();
  }
  async execute(input: Parameters<CouncilRuntime["execute"]>[0]): Promise<CouncilCallResult> {
    await this.validate(input.member);
    input.signal.throwIfAborted();
    const [query, binary, credentials] = await Promise.all([getSDK(), getClaudeBinaryPath(), councilCredentialEnv()]);
    input.signal.throwIfAborted();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-council-"));
    const controller = new AbortController();
    let close: (() => void) | null = null;
    const abort = () => {
      controller.abort();
      close?.();
    };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted)
      abort();
    try {
      input.signal.throwIfAborted();
      const options = councilClaudeOptions(cwd, input.member.model, binary, controller);
      options.env = { ...credentials, ...options.env };
      const q = query({ prompt: input.prompt, options });
      close = () => {
        try {
          q.close();
        }
        catch { /* already stopped */
        }
      };
      let text = "";
      let streamed = "";
      let finished = false;
      let tokens: number | null = null;
      let cost: number | null = null;
      for await (const event of q) {
        input.signal.throwIfAborted();
        if (!isRecord(event))
          continue;
        if (event.type === "stream_event" && isRecord(event.event) && isRecord(event.event.delta) && event.event.delta.type === "text_delta" && typeof event.event.delta.text === "string") {
          streamed += event.event.delta.text;
          input.onText(streamed);
        }
        if (event.type === "assistant" && isRecord(event.message) && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (isRecord(block) && block.type === "tool_use")
              throw new Error("Tool output rejected in material-only Council");
            if (isRecord(block) && block.type === "text" && typeof block.text === "string")
              text += block.text;
          }
          if (!streamed)
            input.onText(text);
        }
        if (text.length > 64000 || streamed.length > 64000)
          throw new Error("Council output exceeds 64,000 characters");
        if (event.type === "result") {
          if (event.is_error === true || event.subtype !== "success")
            throw new Error("Claude did not complete the discussion turn successfully (" + (typeof event.subtype === "string" ? event.subtype.slice(0, 80) : "unknown") + "). " + councilFailureHint(event));
          if (typeof event.result === "string")
            text = event.result;
          if (typeof event.total_cost_usd === "number" && Number.isFinite(event.total_cost_usd))
            cost = event.total_cost_usd;
          if (isRecord(event.usage)) {
            const values = [event.usage.input_tokens, event.usage.output_tokens, event.usage.cache_read_input_tokens, event.usage.cache_creation_input_tokens];
            if (values.every(v => typeof v === "number" && Number.isSafeInteger(v) && v >= 0))
              tokens = values.reduce<number>((n, v) => n + (typeof v === "number" ? v : 0), 0);
          }
          finished = true;
          break;
        }
      }
      input.signal.throwIfAborted();
      if (!finished)
        throw new Error("No confirmed final result from Claude");
      return {
        text,
        tokens,
        cost
      };
    }
    finally {
      input.signal.removeEventListener("abort", abort);
      close?.();
      // This exact directory was created by mkdtemp above, never a caller-supplied path.
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
}
function councilFailureHint(event: Record<string, unknown>): string {
  const detail = [typeof event.result === "string" ? event.result : "", ...(Array.isArray(event.errors) ? event.errors.filter((e): e is string => typeof e === "string") : [])].join(" ");
  if (/auth|log.?in|api.?key|unauthor|credentials|sign.?in/i.test(detail))
    return "Check Claude authentication in a normal session. Council never relaxes its tool restrictions.";
  if (/nested|inside another|CLAUDECODE/i.test(detail))
    return "Nested Claude launch rejected by the installed CLI.";
  if (/model|not.found|not.available/i.test(detail))
    return "The selected model may not be available to this account.";
  if (/permission|denied|policy/i.test(detail))
    return "The installed CLI or organization policy rejected this material-only call.";
  if (/max.turn|turn.limit/i.test(detail))
    return "The model exceeded the single-turn material-only limit.";
  return "Check the installed Claude CLI and account in a normal session. Raw provider errors are not persisted.";
}
