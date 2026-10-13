import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppEvent, AppRun, ProjectApp } from "@shared/types/project-apps";
import type { WorkspaceBinding } from "@shared/types/workspace";
import { ProductivityError, operationError } from "../productivity-errors";
import { AppLogBuffer } from "./logs";
import { checkHttp, selectPort, validateReadinessTarget } from "./health";
import { cleanAppEnvironment, prepareAppCommand } from "./command-resolver";
import { spawnManagedProcess, type ManagedProcess } from "./process-tree";
import { pathIdentity } from "./workspace";
import type { ProjectAppsStore } from "./store";

export interface AppRuntimeLease { assertActive(): void; release(): void }
export interface AppRuntimeDependencies {
  store: ProjectAppsStore;
  validateWorkspace(binding: WorkspaceBinding): Promise<{ binding: WorkspaceBinding; cwd: string }>;
  bindRuntime(projectId: string, runId: string, stop: () => Promise<void>): Promise<AppRuntimeLease>;
  emit(event: AppEvent): void;
  nextRevision(): number;
  report(error: unknown): void;
  assertStartAllowed(appId: string, rootPath: string, revision: number): void;
  onEnded(): void;
}
interface RuntimeEntry {
  run: AppRun;
  key: string;
  process: ManagedProcess | null;
  lease: AppRuntimeLease | null;
  logs: AppLogBuffer;
  abort: AbortController;
  startup: Promise<void> | null;
  stopping: Promise<AppRun> | null;
  healthTimer: ReturnType<typeof setTimeout> | null;
  healthVersion: number;
  persistence: Promise<void>;
  assertAuthorized: () => void;
}
function runtimeKey(appId: string, binding: WorkspaceBinding): string {
  return JSON.stringify([appId, pathIdentity(binding.rootPath), pathIdentity(path.resolve(binding.rootPath, binding.relativeCwd))]);
}
const copyRun = (run: AppRun): AppRun => structuredClone(run);
export class ProjectAppRuntimeManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly runs = new Map<string, AppRun>();
  private quitting = false;
  constructor(private readonly dependencies: AppRuntimeDependencies) {}
  restore(runs: AppRun[]): void { for (const run of runs) this.runs.set(run.runId, run); }
  snapshot(): AppRun[] { return [...this.runs.values()].map(copyRun).sort((a, b) => b.startedAt - a.startedAt); }
  get(runId: string): AppRun {
    const run = this.runs.get(runId); if (!run) throw new ProductivityError("TARGET_GONE", "This run no longer exists"); return copyRun(run);
  }
  isActive(run: AppRun): boolean { return run.cleanupPending || ["starting", "running", "stopping"].includes(run.phase); }
  private publish(entry: RuntimeEntry): void {
    this.runs.set(entry.run.runId, entry.run);
    const snapshot = copyRun(entry.run);
    this.dependencies.emit({ kind: "run", revision: this.dependencies.nextRevision(), run: snapshot });
    entry.persistence = entry.persistence.then(() => this.dependencies.store.saveRun(snapshot)).catch(this.dependencies.report);
  }
  private assertActive(entry: RuntimeEntry): void {
    if (entry.abort.signal.aborted || this.quitting) throw new ProductivityError("CANCELLED", "Application startup was cancelled");
    entry.lease?.assertActive();
    entry.assertAuthorized();
    this.dependencies.assertStartAllowed(entry.run.appId, entry.run.workspace.rootPath, entry.run.configRevision);
  }
  async start(app: Extract<ProjectApp, { kind: "managed" }>, binding: WorkspaceBinding, assertAuthorized: () => void = () => {}): Promise<AppRun> {
    if (this.quitting) throw new ProductivityError("SHUTTING_DOWN", "AstraDock is shutting down");
    const runId = randomUUID();
    const env = cleanAppEnvironment(app.launch.env);
    const secrets = Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_?KEY|PRIVATE_?KEY|CREDENTIAL/i.test(key)).flatMap(([, value]) => value ? [value] : []);
    const entry: RuntimeEntry = {
      run: { runId, appId: app.id, configRevision: app.revision, workspace: structuredClone(binding), launch: structuredClone(app.launch),
        phase: "starting", health: app.launch.readiness.kind === "http" ? "checking" : "unknown", pid: null, port: null, url: null,
        startedAt: Date.now(), endedAt: null, exitCode: null, error: null, cleanupPending: false },
      key: runtimeKey(app.id, binding), process: null, lease: null, abort: new AbortController(), startup: null, stopping: null, healthTimer: null, healthVersion: 0, persistence: Promise.resolve(), assertAuthorized,
      logs: new AppLogBuffer(runId, this.dependencies.store.runPath(runId), (page) => this.dependencies.emit({ kind: "logs", page }), this.dependencies.report, secrets),
    };
    this.entries.set(runId, entry);
    try {
      entry.lease = await this.dependencies.bindRuntime(app.projectId, runId, async () => { await this.stop(runId); });
      this.assertActive(entry);
      const resolved = await this.dependencies.validateWorkspace(binding);
      this.assertActive(entry);
      entry.run.workspace = resolved.binding;
      entry.key = runtimeKey(app.id, resolved.binding);
      const existing = [...this.entries.values()].find((other) => other !== entry && other.key === entry.key && this.isActive(other.run));
      if (existing) { entry.lease.release(); this.entries.delete(runId); return copyRun(existing.run); }
      this.dependencies.assertStartAllowed(app.id, resolved.binding.rootPath, app.revision);
      // Persist the starting record before any service process is created.
      await this.dependencies.store.saveRun(entry.run);
      this.assertActive(entry);
      this.publish(entry);
      entry.startup = this.launch(entry, resolved.cwd, env);
      void entry.startup.catch(this.dependencies.report);
      return copyRun(entry.run);
    } catch (error) {
      entry.lease?.release(); this.entries.delete(runId);
      throw error;
    }
  }
  async preflightRestart(app: Extract<ProjectApp, { kind: "managed" }>, binding: WorkspaceBinding, previous: AppRun): Promise<void> {
    const resolved = await this.dependencies.validateWorkspace(binding);
    const key = runtimeKey(app.id, resolved.binding);
    if ([...this.entries.values()].some((entry) => entry.run.runId !== previous.runId && entry.key === key && this.isActive(entry.run))) throw new ProductivityError("BUSY", "Another instance already occupies the new working directory", true);
    const ownFixedPort = app.launch.port.kind === "fixed" && app.launch.port.port === previous.port && this.isActive(previous);
    const previousPreviewPort = previous.url && this.isActive(previous) ? Number(new URL(previous.url).port || (new URL(previous.url).protocol === "https:" ? 443 : 80)) : null;
    const ownCustomPreview = app.launch.port.kind === "none" && app.launch.previewUrl === previous.url ? previousPreviewPort : null;
    const port = ownFixedPort ? previous.port : await selectPort(app.launch, ownCustomPreview);
    validateReadinessTarget(app.launch, port);
    await prepareAppCommand(app.launch, resolved.cwd, port, cleanAppEnvironment(app.launch.env));
    this.dependencies.assertStartAllowed(app.id, resolved.binding.rootPath, app.revision);
  }
  private async launch(entry: RuntimeEntry, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    try {
      const launch = entry.run.launch;
      const port = await selectPort(launch);
      this.assertActive(entry);
      entry.run.port = port;
      entry.run.url = validateReadinessTarget(launch, port);
      const { executable, args } = await prepareAppCommand(launch, cwd, port, env);
      entry.logs.append("system", `Starting ${executable} ${args.join(" ")}\nWorking directory: ${cwd}\n`);
      this.assertActive(entry);
      const previewPort = entry.run.url ? Number(new URL(entry.run.url).port || (new URL(entry.run.url).protocol === "https:" ? 443 : 80)) : null;
      entry.process = await spawnManagedProcess(executable, args, cwd, env, path.join(this.dependencies.store.root, "helpers"), previewPort);
      entry.process.child.stdout?.on("data", (chunk: Buffer) => entry.logs.append("stdout", chunk));
      entry.process.child.stderr?.on("data", (chunk: Buffer) => entry.logs.append("stderr", chunk));
      entry.process.child.stdin?.on("error", () => { /* The owned helper may already have exited. */ });
      void entry.process.closed.then((code) => this.processExited(entry, code)).catch(this.dependencies.report);
      entry.run.pid = entry.process.child.pid ?? null;
      entry.run.cleanupPending = true;
      this.assertActive(entry);
      entry.run.phase = "running";
      this.publish(entry);
      if (launch.readiness.kind === "http") this.scheduleHealth(entry);
    } catch (error) {
      if (entry.abort.signal.aborted) return; // stop() joins startup, then cleans any just-created process.
      entry.run.error = operationError(error);
      entry.logs.append("system", `${entry.run.error.code}: ${entry.run.error.message}\n`);
      try { await entry.process?.stop(); entry.run.cleanupPending = false; }
      catch (stopError) { entry.run.error = operationError(stopError); entry.run.cleanupPending = true; }
      entry.run.phase = "failed"; entry.run.health = "unknown"; entry.run.endedAt = Date.now();
      if (!entry.run.cleanupPending) entry.lease?.release();
      this.publish(entry);
      await entry.logs.close();
      this.dependencies.onEnded();
    }
  }
  recheckHealth(): void {
    for (const entry of this.entries.values()) {
      if (entry.run.phase !== "running" || entry.run.launch.readiness.kind !== "http") continue;
      if (entry.healthTimer) clearTimeout(entry.healthTimer);
      this.scheduleHealth(entry);
    }
  }
  private scheduleHealth(entry: RuntimeEntry): void {
    const version = ++entry.healthVersion;
    const tick = async () => {
      if (version !== entry.healthVersion || entry.abort.signal.aborted || entry.run.phase !== "running" || !entry.run.url) return;
      const url = new URL(entry.run.url);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const checkedAfter = Date.now();
      const http = await checkHttp(entry.run.url, entry.run.launch, entry.abort.signal);
      // Match the actual socket's address/family, not just a port number. A
      // different local service can bind the same port on another interface.
      const ready = http.ready && http.address !== null && await entry.process?.ownsPort(port, http.address, checkedAfter) === true;
      if (version !== entry.healthVersion || entry.abort.signal.aborted || entry.run.phase !== "running") return;
      if (ready) {
        if (entry.run.health !== "ready") { entry.run.health = "ready"; this.publish(entry); }
      } else if (entry.run.health === "ready" || entry.run.health === "unhealthy") {
        if (entry.run.health !== "unhealthy") { entry.run.health = "unhealthy"; this.publish(entry); }
      } else if (Date.now() - entry.run.startedAt >= entry.run.launch.startupTimeoutMs) {
        entry.run.error = { code: "START_TIMEOUT", message: "The service did not pass its readiness check before the startup timeout", retryable: true };
        await this.stop(entry.run.runId);
        entry.run.phase = "failed"; this.publish(entry); return;
      }
      entry.healthTimer = setTimeout(() => { void tick().catch(this.dependencies.report); }, ready ? 5000 : 500);
    };
    entry.healthTimer = setTimeout(() => { void tick().catch(this.dependencies.report); }, 250);
  }
  private async processExited(entry: RuntimeEntry, exitCode: number | null): Promise<void> {
    entry.run.exitCode = exitCode;
    if (entry.run.phase === "stopping" || entry.abort.signal.aborted || entry.run.phase === "failed") return;
    if (entry.healthTimer) clearTimeout(entry.healthTimer);
    // POSIX wrappers can close their own pipes before the process group is gone.
    try { await entry.process?.stop(); entry.run.cleanupPending = false; }
    catch (error) { entry.run.cleanupPending = true; entry.run.error = operationError(error); }
    entry.run.phase = "failed"; entry.run.health = "unknown"; entry.run.endedAt = Date.now();
    entry.run.error ??= { code: "PROCESS_EXITED", message: `Service exited unexpectedly (${exitCode ?? "signal"})`, retryable: true };
    entry.logs.append("system", `${entry.run.error.message}\n`);
    if (!entry.run.cleanupPending) entry.lease?.release();
    this.publish(entry); await entry.logs.close(); this.dependencies.onEnded();
  }
  async stop(runId: string): Promise<AppRun> {
    const entry = this.entries.get(runId);
    if (!entry) return this.get(runId);
    if (entry.stopping) return entry.stopping;
    if (!this.isActive(entry.run) && !entry.process?.alive()) return copyRun(entry.run);
    entry.abort.abort();
    if (entry.healthTimer) { clearTimeout(entry.healthTimer); entry.healthTimer = null; }
    entry.run.phase = "stopping"; this.publish(entry);
    entry.stopping = (async () => {
      try {
        await entry.startup;
        await entry.process?.stop();
        entry.run.phase = "stopped"; entry.run.cleanupPending = false; entry.run.health = "unknown"; entry.run.endedAt = Date.now();
        entry.lease?.release();
        entry.logs.append("system", "Application stopped.\n");
        this.publish(entry);
        await Promise.all([entry.logs.close(), entry.persistence]);
        this.dependencies.onEnded();
        return copyRun(entry.run);
      } catch (error) {
        entry.run.phase = "failed"; entry.run.cleanupPending = true; entry.run.error = operationError(error);
        this.publish(entry); throw error;
      } finally { entry.stopping = null; }
    })();
    return entry.stopping;
  }
  async logs(runId: string, afterSeq: number, limit: number) {
    this.get(runId);
    const existing = this.entries.get(runId);
    if (existing) return existing.logs.page(afterSeq, limit);
    const logs = new AppLogBuffer(runId, this.dependencies.store.runPath(runId), () => {}, this.dependencies.report, []);
    await logs.restore(); return logs.page(afterSeq, limit);
  }
  async tailLogs(runId: string, limit: number) {
    const end = await this.logs(runId, Number.MAX_SAFE_INTEGER, 1);
    return this.logs(runId, Math.max(0, end.nextSeq - limit), limit);
  }
  async stopMatching(predicate: (run: AppRun) => boolean): Promise<void> {
    const outcomes = await Promise.allSettled([...this.entries.values()].filter((entry) => predicate(entry.run) && this.isActive(entry.run)).map((entry) => this.stop(entry.run.runId)));
    const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
  async forget(runId: string): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry && this.isActive(entry.run)) throw new ProductivityError("BUSY", "Application is still active");
    if (entry) await Promise.all([entry.logs.close(), entry.persistence]);
    await this.dependencies.store.deleteRun(runId); this.entries.delete(runId); this.runs.delete(runId);
  }
  async shutdown(): Promise<void> {
    this.quitting = true;
    try {
      await this.stopMatching(() => true);
      await Promise.all([...this.entries.values()].map(async (entry) => { await entry.logs.close(); await entry.persistence; }));
    } finally { this.quitting = false; }
  }
}
