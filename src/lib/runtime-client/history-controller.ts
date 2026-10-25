import type { HistoryReadResult, ThreadHistoryPage, ThreadPageQuery, HistoryPageItem } from "@shared/types/runtime-history";
export interface HistoryTransport { page(query: ThreadPageQuery): Promise<HistoryReadResult> }
export interface HistoryViewState { page: ThreadHistoryPage | null; loading: boolean; error: string | null }
/** A read-only client window. It exposes no save or send operation, and never
 * represents an unloaded history as a complete conversation snapshot. */
export class HistoryController {
  private state: HistoryViewState = { page: null, loading: false, error: null };
  private generation = 0;
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  constructor(private readonly transport: HistoryTransport, readonly projectId: string, readonly sessionId: string) {}
  getSnapshot = (): HistoryViewState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(state: HistoryViewState): void { this.state = state; for (const listener of this.listeners) listener(); }
  refresh(): Promise<void> { this.generation++; this.pending = null; return this.load(undefined); }
  older(): Promise<void> {
    if (this.pending) return this.pending;
    const cursor = this.state.page?.nextCursor; return cursor ? this.load(cursor) : Promise.resolve();
  }
  private load(cursor: string | undefined): Promise<void> {
    const generation = this.generation;
    this.publish({ ...this.state, loading: true, error: null });
    const pending = this.transport.page({ projectId: this.projectId, sessionId: this.sessionId, cursor, limit: 50, maxBytes: 512 * 1024 })
      .then(result => {
        if (generation !== this.generation) return;
        if (!result.ok) { this.publish({ ...this.state, loading: false, error: result.error.message }); return; }
        // One bounded page is intentionally retained; navigating older does not
        // accumulate all history in memory. Refresh returns to the newest page.
        this.publish({ page: result.page, loading: false, error: null });
      }).catch(error => {
        if (generation === this.generation) this.publish({ ...this.state, loading: false, error: error instanceof Error ? error.message : "History request failed" });
      }).finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending; return pending;
  }
  dispose(): void { this.generation++; this.pending = null; this.listeners.clear(); }
}
export function historyItemText(item: HistoryPageItem): string {
  if (!item.message) return `${item.bytes.toLocaleString()} bytes · content is loaded separately`;
  const content = item.message.content;
  if (typeof content === "string" && content) return content;
  if (item.message.toolResult !== undefined) return JSON.stringify(item.message.toolResult, null, 2);
  return JSON.stringify(item.message, null, 2);
}
