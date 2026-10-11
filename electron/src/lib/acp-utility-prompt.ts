import { log } from "./logger";
import { reportError } from "./error-utils";
import { acpSessions } from "../ipc/acp-sessions";

/**
 * Send a one-shot prompt through an existing ACP session's connection.
 * Creates an ephemeral utility session on the same agent process, sends the prompt,
 * accumulates text from agent_message_chunk events, and returns the result.
 * Permissions are auto-denied since utility sessions are text-only.
 */
export async function acpUtilityPrompt(
  internalId: string,
  prompt: string,
  timeoutMs = 15000,
  signal?: AbortSignal,
): Promise<string> {
  const entry = acpSessions.get(internalId);
  if (!entry) {
    throw new Error("ACP session not found");
  }

  const conn = entry.connection;

  // Create ephemeral utility session on the same connection (no extra process spawn)
  const utilitySession = await conn.newSession({ cwd: entry.cwd, mcpServers: [] });
  const utilitySessionId = utilitySession.sessionId;
  log("ACP_UTILITY", `Created utility session ${utilitySessionId.slice(0, 12)} on connection ${internalId.slice(0, 8)}`);

  // Register so sessionUpdate callback knows to accumulate text, not forward to renderer
  if (!entry.utilitySessionIds) entry.utilitySessionIds = new Set();
  entry.utilitySessionIds.add(utilitySessionId);

  if (!entry.utilityTextBuffers) entry.utilityTextBuffers = new Map();
  entry.utilityTextBuffers.set(utilitySessionId, "");
  if (!entry.utilityErrors) entry.utilityErrors = new Map();
  entry.utilityErrors.delete(utilitySessionId);

  let timedOut = false;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    conn.cancel({ sessionId: utilitySessionId }).catch(() => {});
  };
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeoutMs);
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });

  try {
    await conn.prompt({
      sessionId: utilitySessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    clearTimeout(timeoutHandle);

    if (timedOut) {
      throw new Error("ACP utility prompt timed out");
    }
    if (cancelled) throw new Error("ACP utility prompt cancelled");
    const utilityError = entry.utilityErrors.get(utilitySessionId);
    if (utilityError) throw new Error(utilityError);

    const result = entry.utilityTextBuffers.get(utilitySessionId) ?? "";
    log("ACP_UTILITY", `Utility session ${utilitySessionId.slice(0, 12)} result len=${result.length}`);
    return result;
  } catch (err) {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", cancel);
    reportError("ACP_UTILITY_ERR", err, { internalId });
    throw err;
  } finally {
    // Clean up this utility session — don't null the collections since another
    // concurrent utility prompt may still be active on the same connection
    entry.utilitySessionIds?.delete(utilitySessionId);
    entry.utilityTextBuffers?.delete(utilitySessionId);
    entry.utilityErrors?.delete(utilitySessionId);
    signal?.removeEventListener("abort", cancel);
  }
}
