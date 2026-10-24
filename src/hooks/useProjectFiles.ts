import { useCallback, useEffect, useRef, useState } from "react";
import { buildFileTree, type FileTreeNode } from "@/lib/file-tree";
import { listProjectFilesShared, sameFileList } from "@/lib/files/list-cache";
import { captureException } from "@/lib/analytics/analytics";

interface UseProjectFilesReturn {
  tree: FileTreeNode[] | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the file list from disk. */
  refresh: () => void;
}

/**
 * Fetches the project file list via IPC and builds a nested tree.
 * Re-fetches when `cwd` changes. Returns loading/error states.
 */
export function useProjectFiles(
  cwd: string | undefined,
  enabled: boolean,
): UseProjectFilesReturn {
  const [tree, setTree] = useState<FileTreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the latest fetch to avoid stale responses
  const fetchIdRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const scopeRef = useRef({ cwd, enabled });
  scopeRef.current = { cwd, enabled };
  const runningRef = useRef(new Set<string>());
  const dirtyRef = useRef(new Set<string>());
  const previousRef = useRef<{ cwd: string; files: string[] } | null>(null);
  const fetchFiles = useCallback(async function refreshDirectory(dir: string) {
    if (!scopeRef.current.enabled || scopeRef.current.cwd !== dir) return;
    if (runningRef.current.has(dir)) { dirtyRef.current.add(dir); return; }
    runningRef.current.add(dir);
    const id = ++fetchIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await listProjectFilesShared(dir);
      // Guard against stale response (cwd changed while fetching)
      if (id !== fetchIdRef.current) return;
      const previous = previousRef.current;
      if (!previous || previous.cwd !== dir || !sameFileList(previous.files, result.files)) {
        setTree(buildFileTree(result.files));
        previousRef.current = { cwd: dir, files: result.files };
      }
    } catch (err) {
      if (id !== fetchIdRef.current) return;
      captureException(err instanceof Error ? err : new Error(String(err)), { label: "FILE_LIST_ERR" });
      setError(err instanceof Error ? err.message : "Failed to list files");
      previousRef.current = null;
      setTree(null);
    } finally {
      runningRef.current.delete(dir);
      if (dirtyRef.current.delete(dir)) void refreshDirectory(dir);
      if (id === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!cwd || !enabled) {
      fetchIdRef.current += 1;
      previousRef.current = null;
      setTree(null);
      setLoading(false);
      setError(null);
      return;
    }

    void fetchFiles(cwd);
    return () => { fetchIdRef.current += 1; };
  }, [cwd, enabled, fetchFiles]);

  const scheduleRefresh = useCallback((dir: string) => {
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      void fetchFiles(dir);
    }, 150);
  }, [fetchFiles]);

  useEffect(() => {
    if (!cwd || !enabled) return;

    void window.claude.files.watch(cwd);
    let lastVerification = Date.now();
    let verificationTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.claude.files.onChanged(({ cwd: changedCwd, structural }) => {
      if (changedCwd !== cwd) return;
      if (structural === false && Date.now() - lastVerification < 5000) {
        verificationTimer ??= setTimeout(() => {
          verificationTimer = undefined; lastVerification = Date.now(); scheduleRefresh(cwd);
        }, 5000 - (Date.now() - lastVerification));
        return;
      }
      clearTimeout(verificationTimer); verificationTimer = undefined;
      lastVerification = Date.now();
      scheduleRefresh(cwd);
    });

    const refreshOnFocus = () => scheduleRefresh(cwd);
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        scheduleRefresh(cwd);
      }
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);

    return () => {
      unsubscribe();
      clearTimeout(verificationTimer);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
      clearTimeout(refreshTimerRef.current);
      void window.claude.files.unwatch(cwd);
    };
  }, [cwd, enabled, scheduleRefresh]);

  const refresh = useCallback(() => {
    if (cwd && enabled) fetchFiles(cwd);
  }, [cwd, enabled, fetchFiles]);

  return { tree, loading, error, refresh };
}
