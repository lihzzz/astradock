import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskSnapshot } from "@shared/types/tasks";
import type { OperationResult } from "@shared/types/productivity";
import { reportError } from "@/lib/analytics/analytics";

export function unwrapTaskResult<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
export function newerTaskSnapshot(current: TaskSnapshot | null, incoming: TaskSnapshot): TaskSnapshot {
  return !current || incoming.revision >= current.revision ? incoming : current;
}
export function useTasks() {
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const next = unwrapTaskResult(await window.claude.tasks.list());
      if (mounted.current) { setSnapshot((previous) => newerTaskSnapshot(previous, next)); setError(null); }
    } catch (error) { const message = reportError("TASKS:LIST", error); if (mounted.current) setError(message); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    // Subscribe first; a slower initial snapshot must not overwrite a newer event.
    const dispose = window.claude.tasks.onChanged((next) => {
      if (mounted.current) { setSnapshot((previous) => newerTaskSnapshot(previous, next)); setError(null); }
    });
    void refresh();
    return () => { mounted.current = false; dispose(); };
  }, [refresh]);
  return { snapshot, error, refresh };
}
