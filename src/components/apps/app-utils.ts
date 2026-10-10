import type { AppCatalogSnapshot, AppEvent, AppLogEntry, AppLogPage, AppRun, ProjectApp, ProjectAppInput } from "@shared/types/project-apps";
import type { WorkspaceBinding } from "@shared/types/workspace";
import type { OperationResult } from "@shared/types/productivity";

export interface AppViewSnapshot extends AppCatalogSnapshot { catalogRevision: number; runRevisions: Record<string, number> }
export const EMPTY_APP_SNAPSHOT: AppViewSnapshot = { revision: -1, catalogRevision: -1, runRevisions: {}, apps: [], runs: [], errors: [], workspaceErrors: {} };
export const isActiveRun = (run: AppRun): boolean => run.phase === "starting" || run.phase === "running" || run.phase === "stopping" || run.cleanupPending;
export function workspaceKey(workspace: WorkspaceBinding): string {
  return JSON.stringify([workspace.projectId, workspace.rootKind, workspace.rootPath, workspace.relativeCwd]);
}
export function appDefinition(app: ProjectApp): ProjectAppInput {
  const presentation = { name: app.name, icon: app.icon, iconType: app.iconType, favorite: app.favorite, folder: app.folder, order: app.order };
  return app.kind === "web" ? { ...presentation, kind: "web", spaceId: app.spaceId, url: app.url }
    : { ...presentation, kind: "managed", projectId: app.projectId, workspace: app.workspace, launch: app.launch };
}
/** Logs are deliberately excluded from catalog state to isolate high-frequency output. */
export function reduceAppEvent(current: AppViewSnapshot, event: AppEvent): AppViewSnapshot {
  if (event.kind === "logs") return current;
  if (event.kind === "catalog") {
    const incoming = event.snapshot;
    if (incoming.revision < current.catalogRevision) return current;
    const newerRuns = current.runs.filter((run) => (current.runRevisions[run.runId] ?? -1) > incoming.revision);
    const newerIds = new Set(newerRuns.map((run) => run.runId));
    const runs = [...incoming.runs.filter((run) => !newerIds.has(run.runId)), ...newerRuns];
    return { ...incoming, revision: Math.max(current.revision, incoming.revision), catalogRevision: incoming.revision, runs,
      runRevisions: Object.fromEntries(runs.map((run) => [run.runId, newerIds.has(run.runId) ? current.runRevisions[run.runId] : incoming.revision])) };
  }
  if (event.revision < (current.runRevisions[event.run.runId] ?? current.catalogRevision)) return current;
  const previous = current.runs.find((run) => run.runId === event.run.runId);
  return { ...current, revision: Math.max(current.revision, event.revision), runRevisions: { ...current.runRevisions, [event.run.runId]: event.revision }, runs: previous ? current.runs.map((run) => run.runId === event.run.runId ? event.run : run) : [...current.runs, event.run] };
}
export function preferredAppRun(app: ProjectApp, runs: AppRun[]): AppRun | undefined {
  if (app.kind === "web") return undefined;
  return runs.filter((run) => workspaceKey(run.workspace) === workspaceKey(app.workspace))
    .sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.startedAt - a.startedAt)[0];
}
export interface AppDetailOpenRequest { requestId: string; workspace: WorkspaceBinding | null; runId: string | null; tab: "preview" | "logs" }
export function selectedAppRun(runs: AppRun[], target: WorkspaceBinding | null, runId: string | null): AppRun | null {
  if (!target) return null;
  const candidates = runs.filter((run) => workspaceKey(run.workspace) === workspaceKey(target));
  return candidates.find((run) => run.runId === runId) ?? candidates.find(isActiveRun) ?? candidates[0] ?? null;
}
export function getHttpSearchUrl(input: string): string | null {
  try { const url = new URL(input.trim()); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function mergeAppLogs(entries: AppLogEntry[], page: AppLogPage, maxEntries = 3000): AppLogEntry[] {
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  page.entries.forEach((entry) => bySeq.set(entry.seq, entry));
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-maxEntries);
}
/** Replay only recoverable gaps, twice at most per cursor. A truncated response
 * advances the available floor so evicted output cannot create a retry loop. */
export function nextAppLogRecoveryCursor(entries: AppLogEntry[], unavailableBeforeSeq: number, attempts: ReadonlyMap<number, number>): number | null {
  for (let index = 1; index < entries.length; index += 1) {
    const cursor = entries[index - 1].seq;
    if (entries[index].seq > cursor + 1 && cursor + 1 >= unavailableBeforeSeq && (attempts.get(cursor) ?? 0) < 2) return cursor;
  }
  return null;
}
export function unwrapAppResult<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new AppOperationError(result.error.code, result.error.message);
  return result.value;
}
export class AppOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AppOperationError"; }
}
export function parseEnvironment(value: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const names = new Set<string>();
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || names.has(match[1])) throw new Error("appsValidationEnv");
    names.add(match[1]); entries.push([match[1], match[2]]);
  }
  return Object.fromEntries(entries);
}
export const appPhaseKey = (phase: AppRun["phase"] | undefined): string => ({ starting: "appsStarting", running: "appsRunning", stopping: "appsStopping", stopped: "appsStopped", failed: "appsFailed", interrupted: "appsInterrupted" }[phase ?? "stopped"]);
export const appHealthKey = (health: AppRun["health"]): string => ({ unknown: "appsUnknown", checking: "appsChecking", ready: "appsReady", unhealthy: "appsUnhealthy" }[health]);
