import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import { acpSessions, getAcpSessionModel } from "../ipc/acp-sessions";
import { spawnExecutable } from "./command-launch";
import { closeAcpSession, withAcpTimeout } from "./acp-runtime";
import { stopProcessAndWait } from "@shared/lib/process-stop";
import { reportError } from "./error-utils";

import { openCodeUtilityConfig } from "./opencode-utility-config";

/** Generic ACP cannot promise tool-free inference. Fail closed rather than cancel after execution. */
export async function acpUtilityPrompt(internalId: string, prompt: string, timeoutMs: number | null = 15000, signal?: AbortSignal): Promise<string> {
  const entry = acpSessions.get(internalId);
  if (!entry) throw new Error("ACP session not found");
  if (entry.agentId !== "opencode") throw new Error("This ACP agent has no verified tool-free utility mode");
  if (signal?.aborted) throw new Error("ACP utility cancelled");
  const directory = await mkdtemp(path.join(tmpdir(), "astradock-acp-utility-"));
  const agent = "astradock-utility-" + crypto.randomUUID();
  const controller = new AbortController();
  const deadline = timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);
  const abort = AbortSignal.any([controller.signal, entry.connection.signal, ...(signal ? [signal] : [])]);
  const env = { ...process.env, ...entry.agentEnv, OPENCODE_CONFIG: "", OPENCODE_CONFIG_DIR: directory,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeUtilityConfig(agent, entry.agentEnv.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT, getAcpSessionModel(internalId))) };
  let child: ReturnType<typeof spawnExecutable> | undefined;
  let failed = false;
  try {
    const acp = await import("@agentclientprotocol/sdk");
    if (abort.aborted) throw new Error("ACP utility cancelled");
    child = spawnExecutable(entry.agentBinary, ["acp", "--pure", "--cwd", directory], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr?.on("data", () => {});
    child.on("error", () => controller.abort());
    let text = "";
    let utilityId: string | undefined;
    const connection = new acp.ClientSideConnection(() => ({
      sessionUpdate: async ({ sessionId, update }) => {
        if (sessionId !== utilityId) return;
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") { controller.abort(); return; }
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          text += update.content.text;
          if (text.length > 1024 * 1024) controller.abort();
        }
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => { throw new Error("Utility file access denied"); },
      writeTextFile: async () => { throw new Error("Utility file access denied"); },
    }), acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
    const combined = AbortSignal.any([abort, connection.signal]);
    const bounded = <T>(operation: Promise<T>) => withAcpTimeout(operation, timeoutMs, "ACP text-only utility", combined);
    const initialized = await bounded(connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "astradock-utility", version: "1" } }));
    const session = await bounded(connection.newSession({ cwd: directory, mcpServers: [] }));
    utilityId = session.sessionId;
    // Refuse to prompt unless the server actually selected our deny-all agent.
    if (!session.configOptions?.some(option => option.category === "mode" && option.currentValue === agent)) {
      throw new Error("OpenCode did not select the isolated text-only utility agent");
    }
    const response = await bounded(connection.prompt({ sessionId: utilityId, prompt: [{ type: "text", text: prompt }] }));
    if (response.stopReason !== "end_turn") throw new Error("ACP utility did not complete: " + response.stopReason);
    await bounded(closeAcpSession(connection, initialized.agentCapabilities ?? {}, utilityId));
    return text;
  } catch (error) {
    failed = true;
    reportError("ACP_UTILITY_ERR", error, { internalId });
    throw error;
  } finally {
    if (deadline) clearTimeout(deadline);
    // Hard-stop only the owned utility process, never the conversation process.
    try {
      if (child) await stopProcessAndWait(child);
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("astradock-acp-utility-")) throw new Error("Unexpected utility directory");
      await rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      reportError("ACP_UTILITY_CLEANUP_ERR", error, { internalId });
      if (!failed) throw error;
    }
  }
}
