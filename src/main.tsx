import { toast } from "sonner";
import { StrictMode } from "react";
import { flushStreamingBuffers } from "./lib/session/stream-flush";
import { flushSync } from "react-dom";
import { flushAllCheckpoints } from "./lib/session/checkpoint-scheduler";
import { drainSessionWrites } from "./lib/session/persistence";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { migrateLocalStorage } from "./lib/local-storage-migration";
import { migrateSettingsIfNeeded } from "./stores/settings-store";
import { App } from "./App";
import "./index.css";

// Migrate localStorage keys from old "openacpui-*" prefix before React mounts
migrateLocalStorage();

// Hydrate Zustand settings store from legacy per-key localStorage entries.
// Must run before createRoot() so components read correct initial values.
migrateSettingsIfNeeded();

// Telemetry is delivered only by the main-process consent/privacy gateway.

window.claude.sessions.onFlush((id) => {
  flushSync(flushStreamingBuffers);
  void flushAllCheckpoints().then(() => drainSessionWrites()).then(
    () => window.claude.sessions.flushed(id),
    (error: unknown) => window.claude.sessions.flushed(id, error instanceof Error ? error.message : String(error)),
  );
});

const removeMemoryListener = window.claude.memory.onEvent((event) => {
  if (event.level === "warning") toast.warning(event.message, { id: "memory:" + event.projectId });
  else toast.message(event.message, { id: "memory:" + event.projectId });
});
if (import.meta.hot) import.meta.hot.dispose(removeMemoryListener);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
