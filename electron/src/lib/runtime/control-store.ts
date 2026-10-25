import { createHash, randomUUID } from "node:crypto";
import { RuntimeCommand, RuntimeError, type AppRun, type AppThread, type CommandReceipt, type RuntimeRequest, type RuntimeSnapshot } from "@shared/types/runtime";
import { transitionRun } from "@shared/lib/runtime/state";
import { OperationJournal, type RuntimeCommit } from "./journal";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Application authority for experimental runtime profiles. Calls are serialized
 * independently of renderer lifetimes; external execution is deliberately separate. */
export class RuntimeControlStore {
  private threads = new Map<string, AppThread>(); private runs = new Map<string, AppRun>();
  private receipts = new Map<string, CommandReceipt>(); private requests = new Map<string, RuntimeRequest>();
  private writer = { generation: 0, mode: "legacy" as "legacy" | "shadow" | "managed" };
  private pending: Promise<void> = Promise.resolve(); private initialized: Promise<void>;
  constructor(readonly journal: OperationJournal, private readonly now = Date.now) {
    this.initialized = journal.open().then(frames => { for (const frame of frames) this.apply(frame.payload); });
  }
  private key(principal: string, id: string): string { return JSON.stringify([principal, id]); }
  private apply(commit: RuntimeCommit): void {
    for (const value of commit.threads) this.threads.set(value.id, value);
    for (const value of commit.runs) this.runs.set(value.id, value);
    for (const value of commit.receipts) this.receipts.set(this.key(value.principalId, value.commandId), value);
    for (const value of commit.requests) this.requests.set(value.id, value);
    if (commit.writer) this.writer = commit.writer;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => this.initialized).then(work);
    this.pending = result.then(() => {}, () => {}); return result;
  }
  private async commit(input: Partial<RuntimeCommit>): Promise<void> {
    const payload = { threads: [], runs: [], receipts: [], requests: [], ...input };
    const frame = await this.journal.append(payload); this.apply(frame.payload);
  }
  async initializeProfile(threads: AppThread[], generation: number): Promise<void> {
    return this.serial(async () => {
      if (this.writer.mode !== "legacy" || this.threads.size) throw new RuntimeError("ALREADY_INITIALIZED");
      if (generation < 1) throw new RuntimeError("INVALID_GENERATION");
      if (new Set(threads.map(t => t.id)).size !== threads.length || new Set(threads.map(t => t.legacyKey)).size !== threads.length) throw new RuntimeError("IDENTITY_CONFLICT");
      await this.commit({ threads, writer: { generation, mode: "managed" } });
    });
  }
  accept(principalId: string, input: unknown): Promise<CommandReceipt> {
    return this.serial(async () => {
      const command = RuntimeCommand.parse(input);
      const thread = this.threads.get(command.threadId);
      if (!thread || thread.projectId !== command.projectId) throw new RuntimeError("SOURCE_GONE");
      if (this.writer.mode !== "managed" || command.writerGeneration !== this.writer.generation) throw new RuntimeError("WRITER_REPLACED");
      if (command.runtimeGeneration !== thread.runtimeGeneration) throw new RuntimeError("RUNTIME_REPLACED");
      const payloadHash = createHash("sha256").update(canonical(command)).digest("hex");
      const prior = this.receipts.get(this.key(principalId, command.commandId));
      if (prior) { if (prior.payloadHash !== payloadHash) throw new RuntimeError("COMMAND_ID_REUSED"); return structuredClone(prior); }
      if (command.expectedRevision !== thread.revision) throw new RuntimeError("REVISION_CONFLICT");
      if (command.intent.kind === "send") {
        const intent = command.intent;
        const messagePrior = [...this.receipts.values()].find(r => r.principalId === principalId && r.command.threadId === thread.id && r.command.intent.kind === "send" && r.command.intent.clientMessageId === intent.clientMessageId);
        if (messagePrior) throw new RuntimeError("MESSAGE_ID_REUSED", "Query the original command instead of resubmitting a message under another command ID");
      }
      const receipt: CommandReceipt = { commandId: command.commandId, principalId, payloadHash, command, sequence: this.journal.lastSequence + 1, acceptedAt: this.now(), status: "accepted", error: null };
      const runs: AppRun[] = command.intent.kind !== "send" ? [] : [{ id: randomUUID(), threadId: thread.id, commandId: command.commandId, principalId,
        messageId: randomUUID(), ordinal: Math.max(0, ...[...this.runs.values()].filter(r => r.threadId === thread.id).map(r => r.ordinal)) + 1,
        attempt: 1, runtimeGeneration: thread.runtimeGeneration, status: "queued", createdAt: receipt.acceptedAt, updatedAt: receipt.acceptedAt }];
      const requests: RuntimeRequest[] = [];
      if (command.intent.kind === "approval") {
        const request = this.requests.get(command.intent.requestId);
        if (!request || request.threadId !== thread.id || request.status !== "pending" || request.revision !== command.intent.requestRevision || request.runtimeGeneration !== thread.runtimeGeneration) throw new RuntimeError("REQUEST_EXPIRED");
        requests.push({ ...request, status: "resolved", decision: command.intent.decision, revision: request.revision + 1 });
      }
      if (command.intent.kind === "interrupt") {
        const run = this.runs.get(command.intent.runId);
        if (!run || run.threadId !== thread.id || !["starting", "running", "waiting_permission", "waiting_user"].includes(run.status)) throw new RuntimeError("RUN_NOT_ACTIVE");
      }
      await this.commit({ threads: [{ ...thread, revision: thread.revision + 1 }], receipts: [receipt], runs, requests });
      return structuredClone(receipt);
    });
  }
  updateRun(id: string, status: AppRun["status"], generation: number): Promise<void> {
    return this.serial(async () => {
      const run = this.runs.get(id); if (!run || run.runtimeGeneration !== generation) throw new RuntimeError("RUNTIME_REPLACED");
      if (status === "starting" && [...this.runs.values()].some(other => other.id !== id && other.threadId === run.threadId && ["starting", "running", "waiting_permission", "waiting_user", "unknown"].includes(other.status))) throw new RuntimeError("THREAD_BUSY");
      await this.commit({ runs: [transitionRun(run, status, this.now())] });
    });
  }
  setReceipt(principalId: string, id: string, status: CommandReceipt["status"], error: string | null = null): Promise<void> {
    return this.serial(async () => {
      const prior = this.receipts.get(this.key(principalId, id)); if (!prior) throw new RuntimeError("COMMAND_NOT_FOUND");
      const allowed = prior.status === "accepted" ? ["dispatching", "failed"] : prior.status === "dispatching" ? ["completed", "failed", "unknown"] : [];
      if (status === prior.status) return;
      if (!allowed.includes(status)) throw new RuntimeError("INVALID_COMMAND_TRANSITION");
      await this.commit({ receipts: [{ ...prior, status, error }] });
    });
  }
  resumeAfterApproval(runId: string, generation: number): Promise<void> {
    return this.serial(async () => {
      const run = this.runs.get(runId);
      if (!run || run.runtimeGeneration !== generation || run.status !== "waiting_permission") return;
      if ([...this.requests.values()].some(request => request.runId === runId && request.status === "pending")) return;
      await this.commit({ runs: [transitionRun(run, "running", this.now())] });
    });
  }
  claimDispatch(principalId: string, id: string): Promise<boolean> {
    return this.serial(async () => {
      const prior = this.receipts.get(this.key(principalId, id));
      if (!prior || prior.status !== "accepted") return false;
      await this.commit({ receipts: [{ ...prior, status: "dispatching" }] }); return true;
    });
  }
  finishRun(principalId: string, commandId: string, runId: string, status: "completed" | "interrupted" | "unknown"): Promise<void> {
    return this.serial(async () => {
      const run = this.runs.get(runId), receipt = this.receipts.get(this.key(principalId, commandId));
      if (!run || !receipt || run.commandId !== commandId || run.principalId !== principalId) throw new RuntimeError("RUN_NOT_FOUND");
      const next = transitionRun(run, status, this.now());
      const requests = [...this.requests.values()].filter(request => request.runId === runId && request.status === "pending")
        .map(request => ({ ...request, status: "expired" as const, revision: request.revision + 1 }));
      await this.commit({ runs: [next], receipts: [{ ...receipt, status: status === "unknown" ? "unknown" : "completed" }], requests });
    });
  }
  addRequest(request: RuntimeRequest): Promise<void> {
    return this.serial(async () => {
      const thread = this.threads.get(request.threadId), run = this.runs.get(request.runId);
      if (!thread || !run || run.threadId !== thread.id || thread.runtimeGeneration !== request.runtimeGeneration || run.runtimeGeneration !== request.runtimeGeneration) throw new RuntimeError("RUNTIME_REPLACED");
      if (this.requests.has(request.id)) throw new RuntimeError("REQUEST_ID_REUSED");
      await this.commit({ requests: [request] });
    });
  }
  recoverAfterProcessLoss(): Promise<void> {
    return this.serial(async () => {
      await this.commit({ runs: [...this.runs.values()].filter(r => ["starting", "running", "waiting_permission", "waiting_user"].includes(r.status)).map(r => ({ ...r, status: "unknown" as const, updatedAt: this.now() })),
        receipts: [...this.receipts.values()].filter(r => r.status === "dispatching").map(r => ({ ...r, status: "unknown" as const })),
        requests: [...this.requests.values()].filter(r => r.status === "pending").map(r => ({ ...r, status: "expired" as const, revision: r.revision + 1 })) });
    });
  }
  snapshot(threadId: string): Promise<RuntimeSnapshot> {
    return this.serial(async () => {
      const thread = this.threads.get(threadId); if (!thread) throw new RuntimeError("SOURCE_GONE");
      return structuredClone({ thread, runs: [...this.runs.values()].filter(r => r.threadId === threadId),
        receipts: [...this.receipts.values()].filter(r => r.command.threadId === threadId), requests: [...this.requests.values()].filter(r => r.threadId === threadId), sequence: this.journal.lastSequence });
    });
  }
  async close(): Promise<void> { await this.pending; await this.journal.close(); }
}
