import type { AgentCapabilities, ClientSideConnection, LoadSessionRequest, SessionConfigOption } from "@agentclientprotocol/sdk";

export function isAcpMethodUnsupported(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === -32601;
}

export function withAcpTimeout<T>(promise: Promise<T>, timeoutMs: number | null, stage: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const abort = () => fail(new Error(stage + ": cancelled or connection closed"));
    const timer = timeoutMs === null ? null : setTimeout(() => fail(new Error(stage + " timed out after " + timeoutMs + "ms")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    promise.then(value => { cleanup(); resolve(value); }, fail);
  });
}

export function canRestoreAcpSession(capabilities: AgentCapabilities): boolean {
  return !!capabilities.sessionCapabilities?.resume || capabilities.loadSession === true;
}

export async function restoreAcpSession(connection: Pick<ClientSideConnection, "unstable_resumeSession" | "loadSession">,
  capabilities: AgentCapabilities, request: LoadSessionRequest) {
  if (capabilities.sessionCapabilities?.resume) {
    try { return { result: await connection.unstable_resumeSession(request), method: "resume" as const }; }
    catch (error) { if (!isAcpMethodUnsupported(error) || !capabilities.loadSession) throw error; }
  }
  if (!capabilities.loadSession) throw new Error("Agent does not support restoring sessions");
  return { result: await connection.loadSession(request), method: "load" as const };
}

export async function setAcpConfig(connection: Pick<ClientSideConnection, "setSessionConfigOption" | "unstable_setSessionModel" | "setSessionMode">,
  request: { sessionId: string; configId: string; value: string }, options: SessionConfigOption[]) {
  try { return (await connection.setSessionConfigOption(request)).configOptions; }
  catch (error) {
    if (!isAcpMethodUnsupported(error)) throw error;
    const option = options.find(item => item.id === request.configId);
    if (request.configId === "model" || option?.category === "model") {
      await connection.unstable_setSessionModel({ sessionId: request.sessionId, modelId: request.value });
      // Legacy model APIs cannot return the new effort choices. Drop stale ones.
      return options.filter(item => item.category !== "thought_level").map(item =>
        item.id === request.configId ? { ...item, currentValue: request.value } : item);
    }
    if (request.configId === "mode" || option?.category === "mode") {
      await connection.setSessionMode({ sessionId: request.sessionId, modeId: request.value });
      return options.map(item => item.id === request.configId ? { ...item, currentValue: request.value } : item);
    }
    throw error;
  }
}

export async function closeAcpSession(connection: Pick<ClientSideConnection, "extMethod">, capabilities: AgentCapabilities, sessionId: string) {
  const session = capabilities.sessionCapabilities;
  if (!session || !("close" in session) || !session.close) return false;
  try { await connection.extMethod("session/close", { sessionId }); return true; }
  catch (error) { if (isAcpMethodUnsupported(error)) return false; throw error; }
}

/** Standard ACP has no MCP health query. Configuration acceptance is not connectivity. */
export function acpMcpStatuses(servers: ReadonlyArray<{ name: string }>) {
  return servers.map(server => ({ name: server.name, status: "unknown" as const }));
}

/** Buffer only startup control state. Unknown sessions must never enter chat or memory. */
export class AcpEventRouter<T extends { sessionUpdate: string }> {
  private sessionId: string | undefined;
  private pending = new Map<string, T[]>();
  constructor(private readonly dispatch: (update: T, sessionId: string) => void) {}
  receive(sessionId: string, update: T) {
    if (sessionId === this.sessionId) { this.dispatch(update, sessionId); return; }
    if (this.sessionId || !["config_option_update", "available_commands_update", "current_mode_update"].includes(update.sessionUpdate)) return;
    if (!this.pending.has(sessionId) && this.pending.size >= 8) return;
    const queued = this.pending.get(sessionId) ?? [];
    if (queued.length < 32) queued.push(update);
    this.pending.set(sessionId, queued);
  }
  bind(sessionId: string) {
    this.sessionId = sessionId;
    const queued = this.pending.get(sessionId) ?? [];
    this.pending.clear();
    for (const update of queued) this.dispatch(update, sessionId);
  }
}

/** Preserve user mutation order even when an earlier request fails. */
export class AcpSerialQueue {
  private tails = new Map<string, Promise<void>>();
  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation);
    const tail = current.then(() => {}, () => {});
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return current;
  }
}
