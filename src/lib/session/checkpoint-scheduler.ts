import type { PersistedSession } from "@/types";

/** Debounce with a hard deadline. Dirty entries survive failures and view unmounts. */
export class CheckpointScheduler {
  private dirty = new Map<string, { first: number; timer: ReturnType<typeof setTimeout> }>();
  private pending = new Set<Promise<void>>();
  constructor(private readonly snapshot: (id: string) => PersistedSession | null,
    private readonly save: (data: PersistedSession) => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly delay = 2000, private readonly maxWait = 5000) {}
  mark(id: string, immediate = false): void {
    const old = this.dirty.get(id);
    if (old) clearTimeout(old.timer);
    const first = old?.first ?? Date.now();
    const wait = immediate ? 0 : Math.max(0, Math.min(this.delay, this.maxWait - (Date.now() - first)));
    const timer = setTimeout(() => { void this.flush(id).catch(this.report); }, wait);
    this.dirty.set(id, { first, timer });
  }
  async flush(id: string): Promise<void> {
    const dirty = this.dirty.get(id);
    if (!dirty) return;
    clearTimeout(dirty.timer); this.dirty.delete(id);
    const data = this.snapshot(id);
    if (!data) return;
    const task = this.save(data);
    this.pending.add(task);
    try { await task; }
    catch (error) {
      // Retain for explicit retry/quit, without an unbounded automatic retry loop.
      if (!this.dirty.has(id)) this.dirty.set(id, { first: Date.now(), timer: setTimeout(() => {}, 0) });
      throw error;
    } finally { this.pending.delete(task); }
  }
  async flushAll(): Promise<void> {
    await Promise.all([...this.pending, ...[...this.dirty.keys()].map((id) => this.flush(id))]);
  }
  dispose(): void { for (const entry of this.dirty.values()) clearTimeout(entry.timer); this.dirty.clear(); }
}

const flushers = new Set<() => Promise<void>>();
export function registerCheckpointFlusher(flush: () => Promise<void>): () => void {
  flushers.add(flush); return () => { flushers.delete(flush); };
}
export async function flushAllCheckpoints(): Promise<void> { await Promise.all([...flushers].map((flush) => flush())); }
