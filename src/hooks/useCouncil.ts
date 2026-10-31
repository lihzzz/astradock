import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CouncilSnapshot } from "@shared/types/council";
import type { OperationResult } from "@shared/types/productivity";
import { reportError } from "@/lib/analytics/analytics";
export function unwrapCouncil<T>(result: OperationResult<T>): T {
  if (!result.ok)
    throw new Error(result.error.code + ": " + result.error.message);
  return result.value;
}
export function newerCouncil(current: CouncilSnapshot | null, incoming: CouncilSnapshot): CouncilSnapshot {
  return !current || incoming.revision >= current.revision ? incoming : current;
}
const streams = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();
function publish(id: string, text: string) {
  streams.set(id, text);
  for (const fn of listeners.get(id) ?? [])
    fn();
}
export function useCouncilText(id: string, fallback: string): string {
  const subscribe = useCallback((fn: () => void) => {
    const set = listeners.get(id) ?? new Set();
    set.add(fn);
    listeners.set(id, set);
    return () => {
      set.delete(fn);
      if (!set.size)
        listeners.delete(id);
    };
  }, [id]);
  const read = useCallback(() => streams.get(id) ?? fallback, [id, fallback]);
  return useSyncExternalStore(subscribe, read, read);
}
export function useCouncil() {
  const [snapshot, setSnapshot] = useState<CouncilSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const s = unwrapCouncil(await window.claude.councils.list());
      if (alive.current) {
        setSnapshot(old => newerCouncil(old, s));
        setError(null);
      }
    }
    catch (e) {
      const message = reportError("COUNCIL:LOAD", e);
      if (alive.current)
        setError(message);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const off = window.claude.councils.onChanged(s => {
      setSnapshot(old => newerCouncil(old, s));
      const live = new Set(s.runs.flatMap(r => r.attempts.filter(a => a.status === "dispatching").map(a => a.id)));
      for (const id of streams.keys())
        if (!live.has(id)) {
          streams.delete(id);
          for (const fn of listeners.get(id) ?? [])
            fn();
        }
    });
    const delta = window.claude.councils.onDelta(e => publish(e.attemptId, e.text));
    void refresh();
    return () => {
      alive.current = false;
      off();
      delta();
      streams.clear();
    };
  }, [refresh]);
  return {
    snapshot,
    error,
    refresh
  };
}
