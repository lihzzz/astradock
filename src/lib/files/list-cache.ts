interface Listing { files: string[] }
const pending = new Map<string, Promise<Listing>>();
/** In-flight only: never serve a stale directory list after a mutation. */
export function listProjectFilesShared(cwd: string): Promise<Listing> {
  const running = pending.get(cwd);
  if (running) return running;
  const task = window.claude.files.listAll(cwd).finally(() => { if (pending.get(cwd) === task) pending.delete(cwd); });
  pending.set(cwd, task);
  return task;
}
export function sameFileList(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((file, index) => file === next[index]);
}
