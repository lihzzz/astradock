import { useEffect } from "react";
import { connectProjectApps, refreshProjectApps, useProjectAppsStore } from "@/stores/project-apps-store";

export function useProjectApps() {
  useEffect(connectProjectApps, []);
  useEffect(() => {
    const refresh = () => { void refreshProjectApps(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const snapshot = useProjectAppsStore((state) => state.snapshot);
  const loading = useProjectAppsStore((state) => state.loading);
  const error = useProjectAppsStore((state) => state.error);
  return { ...snapshot, loading, error, refresh: refreshProjectApps };
}
