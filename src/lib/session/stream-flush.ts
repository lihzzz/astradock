const flushers = new Set<() => void>();
export function registerStreamFlusher(flush: () => void): () => void {
  flushers.add(flush); return () => { flushers.delete(flush); };
}
export function flushStreamingBuffers(): void { for (const flush of flushers) flush(); }
