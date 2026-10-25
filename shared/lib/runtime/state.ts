import { RuntimeError, type AppRun, type RunStatus } from "../../types/runtime";
const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["starting", "cancelled"], starting: ["running", "failed", "cancelled", "unknown"],
  running: ["waiting_permission", "waiting_user", "completed", "failed", "interrupted", "unknown"],
  waiting_permission: ["running", "completed", "failed", "interrupted", "unknown"],
  waiting_user: ["running", "completed", "failed", "interrupted", "unknown"],
  completed: [], failed: [], interrupted: [], cancelled: [], unknown: [],
};
export function transitionRun(run: AppRun, status: RunStatus, now: number): AppRun {
  if (run.status === status) return run;
  if (!transitions[run.status].includes(status)) throw new RuntimeError("INVALID_RUN_TRANSITION", `${run.status} -> ${status}`);
  return { ...run, status, updatedAt: now };
}
export function isActiveRun(run: AppRun): boolean { return transitions[run.status].length > 0 && run.status !== "queued"; }
/** Provider counters and text hashes are deliberately not application IDs. */
export function legacyThreadKey(projectId: string, engine: string, nativeId: string): string {
  return JSON.stringify([projectId, engine, nativeId]);
}
