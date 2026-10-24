import type { MemoryEvent } from "@shared/types/memory";
const listeners = new Set<(event: MemoryEvent) => void>();
const recent = new Map<string, string>();
export function onMemoryEvent(listener: (event: MemoryEvent) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function memoryNotice(key: string, event: MemoryEvent): void {
  if (recent.get(key) === event.message) return;
  if (recent.size >= 500) recent.clear(); recent.set(key, event.message);
  for (const listener of listeners) { try { listener(event); } catch { /* A closed view cannot affect a write. */ } }
}
