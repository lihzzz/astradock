import { clearTrace } from "./memory/trace";
import type { SessionMeta } from "@shared/lib/session-persistence";
import { getDataDir } from "./data-dir";
import { SessionRepository } from "./session-repository";
import { reportError } from "./error-utils";

let repository: SessionRepository | null = null;
export function getSessionRepository(): SessionRepository {
  const root = getDataDir();
  if (!repository || repository.root !== root) repository = new SessionRepository(root, reportError);
  return repository;
}

let stopRuntimes: (runtimeIds: string[], meta: SessionMeta) => Promise<void> = async () => {};
export function configureSessionStopper(stop: typeof stopRuntimes): void { stopRuntimes = stop; }
let cleanupProjectApps: (projectId: string) => Promise<void> = async () => {};
export function configureProjectAppCleanup(cleanup: typeof cleanupProjectApps): void { cleanupProjectApps = cleanup; }
export function deleteConversation(projectId: string, runtimeId: string): Promise<"deleted" | "already_deleted"> {
  return getSessionRepository().remove(projectId, runtimeId, stopRuntimes);
}
export async function deleteProject(projectId: string): Promise<"deleted" | "already_deleted"> {
  const result = await getSessionRepository().removeProject(projectId, stopRuntimes);
  // Runtime leases have been cancelled and the repository's durable deletion
  // barrier now rejects new starts. A failed catalog cleanup is safe to retry.
  await cleanupProjectApps(projectId);
  clearTrace(projectId);
  return result;
}
