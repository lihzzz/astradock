import { spawn } from "child_process";
import fs from "fs/promises";
import { Readable, Writable } from "stream";
import { log } from "./logger";
import { getSDK, clientAppEnv } from "./sdk";
import { getClaudeBinaryPath } from "./claude-binary";
import { getAgent } from "./agent-registry";
import {
  assistantTextFromEvent,
  chooseContributionText,
  confineToWorkspace,
  resolveClaudeContributionModel,
} from "@shared/lib/collaboration";
import { ACP_CLIENT_CAPABILITIES, applyReadRange, resolveACPFilePath } from "@shared/lib/acp-helpers";
import type { CollaborationContributeRequest } from "@shared/types/collaboration";

const CONTRIBUTION_TIMEOUT_MS = 90_000;

export async function runCollaborationContribution(request: CollaborationContributeRequest): Promise<string> {
  if (request.engine === "claude") return runClaudeContribution(request);
  if (request.engine === "codex") return runCodexContribution(request);
  return runAcpContribution(request);
}

async function runClaudeContribution(request: CollaborationContributeRequest): Promise<string> {
  const model = resolveClaudeContributionModel(request.model);
  const query = await getSDK();
  const cliPath = await getClaudeBinaryPath();
  let assistantText = "";
  let resultText = "";
  const q = query({
    prompt: request.prompt,
    options: {
      cwd: request.cwd,
      model,
      maxTurns: 4,
      disallowedTools: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      pathToClaudeCodeExecutable: cliPath,
      env: { ...process.env, ...clientAppEnv() },
      stderr: (data: string) => {
        const trimmed = data.trim();
        if (trimmed) log("COLLABORATION_CLAUDE_STDERR", trimmed);
      },
    },
  });

  const timeout = setTimeout(() => {
    try { q.close(); } catch { /* already closed */ }
  }, CONTRIBUTION_TIMEOUT_MS);

  try {
    for await (const msg of q) {
      const event = msg as Record<string, unknown>;
      if (event.type === "assistant") assistantText += assistantTextFromEvent(event);
      if (event.type === "result" && typeof event.result === "string") resultText = event.result;
    }
  } finally {
    clearTimeout(timeout);
  }

  const text = chooseContributionText(assistantText, resultText);
  if (!text) throw new Error("Claude returned an empty collaboration response.");
  return text;
}

async function runCodexContribution(request: CollaborationContributeRequest): Promise<string> {
  const { codexUtilityPrompt } = await import("./codex-utility-prompt");
  const text = await codexUtilityPrompt(request.prompt, request.cwd, "COLLABORATION", {
    timeoutMs: CONTRIBUTION_TIMEOUT_MS,
    model: request.model,
  });
  if (!text.trim()) throw new Error("Codex returned an empty collaboration response.");
  return text.trim();
}

async function runAcpContribution(request: CollaborationContributeRequest): Promise<string> {
  const agent = getAgent(request.agentId);
  if (!agent || agent.engine !== "acp" || !agent.binary) {
    throw new Error(`ACP agent "${request.agentId}" is not available. Install it and try again.`);
  }

  const acp = await import("@agentclientprotocol/sdk");
  const proc = spawn(agent.binary, agent.args ?? [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: request.cwd,
    env: { ...process.env, ...agent.env },
    shell: process.platform === "win32",
  });
  if (!proc.pid || !proc.stdin || !proc.stdout) {
    proc.kill();
    throw new Error(`Failed to start ${agent.name}.`);
  }

  let text = "";
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });

  const input = Writable.toWeb(proc.stdin) as WritableStream;
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => ({
    async sessionUpdate(params: import("@agentclientprotocol/sdk").SessionNotification) {
      const update = params.update;
      if (update.sessionUpdate !== "agent_message_chunk" || !("content" in update)) return;
      const content = update.content;
      if (content && typeof content === "object" && "text" in content && typeof content.text === "string") {
        text += content.text;
      }
    },
    async requestPermission(params: { options?: Array<{ optionId: string; kind: string }> }) {
      const options = params.options ?? [];
      const reject = options.find((option) => option.kind === "reject_once") ?? options[options.length - 1];
      return { outcome: { outcome: "selected", optionId: reject?.optionId ?? "reject" } };
    },
    async readTextFile(params: { path?: string; uri?: string; line?: number | null; limit?: number | null }) {
      const filePath = confineToWorkspace(request.cwd, resolveACPFilePath(params));
      const content = applyReadRange(await fs.readFile(filePath, "utf8"), params.line, params.limit);
      return { content };
    },
    async writeTextFile() {
      throw new Error("Collaboration members do not write files. The lead session applies changes.");
    },
  }), stream);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${agent.name} collaboration turn timed out`));
    }, CONTRIBUTION_TIMEOUT_MS);
  });

  try {
    await Promise.race([
      (async () => {
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: ACP_CLIENT_CAPABILITIES,
        });
        const session = await connection.newSession({ cwd: request.cwd, mcpServers: [] });
        await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: request.prompt }],
        });
      })(),
      timeout,
    ]);
    if (!text.trim()) {
      throw new Error(stderr.trim() || `${agent.name} returned an empty collaboration response.`);
    }
    log("COLLABORATION_ACP", `agent=${agent.id} chars=${text.trim().length}`);
    return text.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = stderr.trim().split("\n").filter(Boolean).at(-1);
    if (!detail || message.includes(detail)) throw new Error(message);
    throw new Error(`${message}: ${detail}`);
  } finally {
    if (timer) clearTimeout(timer);
    proc.kill();
  }
}

