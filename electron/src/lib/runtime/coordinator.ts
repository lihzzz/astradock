import { RuntimeCommand, RuntimeError, type AppRun, type AppThread, type CapabilitySet, type CommandReceipt, type RuntimeRequest } from "@shared/types/runtime";
import { requireCapability } from "@shared/lib/runtime/capabilities";
import { RuntimeControlStore } from "./control-store";

export interface ProviderExecutionContext {
  run: AppRun;
  command: RuntimeCommand;
  /** Adapter-normalized callbacks. Tool/child terminal events must never resolve execute(). */
  request(requestId: string): Promise<void>;
}
export interface ProviderRuntime {
  execute(context: ProviderExecutionContext): Promise<"completed" | "interrupted">;
  interrupt(runId: string): Promise<void>;
  respond(requestId: string, decision: "allow" | "deny"): Promise<void>;
  close(): Promise<void>;
}
export interface ProviderRuntimeAdapter {
  capabilities: CapabilitySet;
  open(thread: AppThread, signal: AbortSignal): Promise<ProviderRuntime>;
}
/** Headless orchestration kernel. Production adapters must pass the separate
 * real-provider gate before this kernel may replace legacy desktop ownership. */
export class RuntimeCoordinator {
  private runtimes = new Map<string, Promise<ProviderRuntime>>();
  private starting = new Map<string, AbortController>();
  private pumps = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  private controls = new Set<Promise<void>>();
  private closing = false;
  constructor(private readonly store: RuntimeControlStore, private readonly adapterFor: (thread: AppThread) => ProviderRuntimeAdapter,
    private readonly report: (error: unknown) => void) {}

  async submit(principalId: string, input: unknown): Promise<CommandReceipt> {
    if (this.closing) throw new RuntimeError("RUNTIME_CLOSING");
    const command = RuntimeCommand.parse(input), snapshot = await this.store.snapshot(command.threadId);
    const adapter = this.adapterFor(snapshot.thread);
    if (command.intent.kind === "approval") requireCapability(adapter.capabilities, "approval");
    if (command.intent.kind === "interrupt") requireCapability(adapter.capabilities, "interrupt");
    const receipt = await this.store.accept(principalId, command);
    if (receipt.status !== "accepted") return receipt;
    if (command.intent.kind === "send") this.kick(command.threadId);
    else {
      // A duplicate control request must not execute twice while its receipt is
      // being durably moved out of accepted. The store CAS arbitrates that race.
      const work = this.control(receipt).catch(this.report);
      this.controls.add(work); void work.finally(() => this.controls.delete(work));
    }
    return receipt;
  }
  private runtime(thread: AppThread): Promise<ProviderRuntime> {
    const old = this.runtimes.get(thread.id); if (old) return old;
    const controller = new AbortController(); this.starting.set(thread.id, controller);
    // Install the promise before the first asynchronous startup step.
    const pending = Promise.resolve().then(() => this.adapterFor(thread).open(thread, controller.signal)).then(async live => {
      if (controller.signal.aborted || this.closing) { await live.close(); throw new RuntimeError("START_CANCELLED"); }
      return live;
    });
    this.runtimes.set(thread.id, pending); return pending;
  }
  private kick(threadId: string): void {
    const old = this.pumps.get(threadId); if (old) { old.dirty = true; return; }
    const state = { dirty: true, promise: Promise.resolve() };
    this.pumps.set(threadId, state);
    state.promise = Promise.resolve().then(async () => {
      do { state.dirty = false; await this.drain(threadId); } while (state.dirty && !this.closing);
    }).catch(this.report).finally(() => { if (this.pumps.get(threadId) === state) this.pumps.delete(threadId); });
  }
  private async drain(threadId: string): Promise<void> {
    while (!this.closing) {
      const snapshot = await this.store.snapshot(threadId);
      if (snapshot.runs.some(run => run.status === "unknown") || snapshot.receipts.some(receipt => receipt.status === "unknown")) return;
      const run = snapshot.runs.find(run => run.status === "queued"); if (!run) return;
      const receipt = snapshot.receipts.find(r => r.commandId === run.commandId && r.principalId === run.principalId);
      if (!receipt || receipt.status !== "accepted") return;
      await this.store.updateRun(run.id, "starting", run.runtimeGeneration);
      if (!await this.store.claimDispatch(receipt.principalId, receipt.commandId)) return;
      try {
        const live = await this.runtime(snapshot.thread);
        await this.store.updateRun(run.id, "running", run.runtimeGeneration);
        const status = await live.execute({ run, command: receipt.command, request: async requestId => {
          const request: RuntimeRequest = { id: requestId, threadId, runId: run.id, runtimeGeneration: run.runtimeGeneration, revision: 0, status: "pending", decision: null };
          await this.store.addRequest(request); await this.store.updateRun(run.id, "waiting_permission", run.runtimeGeneration);
        } });
        await this.store.finishRun(receipt.principalId, receipt.commandId, run.id, status);
      } catch (error) {
        // A transport exception does not prove that the provider performed no work.
        await this.store.finishRun(receipt.principalId, receipt.commandId, run.id, "unknown");
        this.report(error); return;
      }
    }
  }
  private async control(receipt: CommandReceipt): Promise<void> {
    if (!await this.store.claimDispatch(receipt.principalId, receipt.commandId)) return;
    try {
      const snapshot = await this.store.snapshot(receipt.command.threadId);
      const current = this.runtimes.get(snapshot.thread.id); if (!current) throw new RuntimeError("RUNTIME_NOT_LIVE");
      const live = await current, intent = receipt.command.intent;
      if (intent.kind === "interrupt") await live.interrupt(intent.runId);
      else if (intent.kind === "approval") {
        await live.respond(intent.requestId, intent.decision);
        const request = snapshot.requests.find(request => request.id === intent.requestId);
        if (request) {
          const run = snapshot.runs.find(run => run.id === request.runId);
          if (run?.status === "waiting_permission") await this.store.resumeAfterApproval(run.id, run.runtimeGeneration);
        }
      }
      await this.store.setReceipt(receipt.principalId, receipt.commandId, "completed");
    } catch (error) { await this.store.setReceipt(receipt.principalId, receipt.commandId, "unknown"); this.report(error); }
  }
  async idle(): Promise<void> {
    while (this.pumps.size || this.controls.size) await Promise.all([...this.pumps.values()].map(p => p.promise).concat([...this.controls]));
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.starting.values()) controller.abort();
    // Failure retains the poisoned coordinator; never silently spawn a replacement.
    await Promise.all([...this.runtimes.values()].map(async pending => {
      let live: ProviderRuntime;
      try { live = await pending; } catch (error) {
        if (error instanceof RuntimeError && error.code === "START_CANCELLED") return;
        throw error;
      }
      await live.close();
    }));
    await this.idle();
  }
}
