import type { GitStatus, GitBranch, GitLogEntry } from "@/types";
interface Details { branches: GitBranch[]; log: GitLogEntry[] }
interface Entry { signature: string; time: number; value: Details }
const entries = new Map<string, Entry>();
const pending = new Map<string, { signature: string; promise: Promise<Details> }>();
/** Status/diff stay live; HEAD/ref-derived details are shared and refreshed on changes or TTL. */
export async function repoDetails(cwd: string, status: GitStatus | null, force: boolean): Promise<Details> {
  const signature = JSON.stringify([status?.head, status?.branch, status?.upstream, status?.ahead, status?.behind]);
  const cached = entries.get(cwd);
  if (!force && cached?.signature === signature && Date.now() - cached.time < 30_000) return cached.value;
  const running = pending.get(cwd);
  if (running?.signature === signature) return running.promise;
  const promise = Promise.all([window.claude.git.branches(cwd), window.claude.git.log(cwd, 30)]).then(([branches, log]) => {
    const value = { branches: Array.isArray(branches) ? branches : cached?.value.branches ?? [],
      log: Array.isArray(log) ? log : cached?.value.log ?? [] };
    if (pending.get(cwd)?.promise === promise && Array.isArray(branches) && Array.isArray(log)) {
      entries.delete(cwd); entries.set(cwd, { signature, time: Date.now(), value });
      while (entries.size > 64) { const oldest = entries.keys().next().value; if (oldest !== undefined) entries.delete(oldest); }
    }
    return value;
  }).finally(() => { if (pending.get(cwd)?.promise === promise) pending.delete(cwd); });
  pending.set(cwd, { signature, promise });
  return promise;
}
