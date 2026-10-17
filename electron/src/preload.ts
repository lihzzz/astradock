import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { CodexFingerprintProbeRequest } from "@shared/types/codex-fingerprint";
import type { BackgroundEffectState } from "@shared/types/background-effect";
import type { BatchJob, BatchPreparedRequest, BatchStartRequest, HistoryApi, HistoryIndexStatus, QuickCaptureApi, QuickCaptureTarget, QuickCaptureUpdate, SessionBatchApi, SessionResumeSource } from "@shared/types/productivity";
import { applyBackgroundEffectClasses } from "@shared/lib/background-effect-classes";
import type { AppEvent, ProjectAppsApi } from "@shared/types/project-apps";
import type { TasksApi, TaskSnapshot } from "@shared/types/tasks";
import type { ProjectAppAgentPermissionEvent } from "@shared/types/project-app-agent";
import type { ComposerPredictionRequest } from "@shared/types/composer-prediction";

interface PreloadDocument {
  addEventListener: (type: string, listener: () => void, options: { once: boolean }) => void;
  documentElement: {
    classList: {
      add: (token: string) => void;
      toggle: (token: string, force: boolean) => boolean;
    };
  };
}

interface PreloadStorage {
  getItem: (key: string) => string | null;
}

interface PreloadGlobals {
  document?: PreloadDocument;
  localStorage?: PreloadStorage;
}

import type { ThemeOption as ThemeSource, MacBackgroundEffect } from "@shared/types/settings";
import type { MemoryProjectConfig } from "@shared/types/memory";

function readStoredThemeSource(storage: PreloadStorage | undefined): ThemeSource {
  const stored = storage?.getItem("harnss-theme");
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "dark";
}

function readStoredTransparency(storage: PreloadStorage | undefined): boolean {
  try {
    const persisted: unknown = JSON.parse(storage?.getItem("harnss-settings-store") ?? "null");
    if (persisted && typeof persisted === "object" && "state" in persisted) {
      const state = persisted.state;
      if (state && typeof state === "object" && "transparency" in state && typeof state.transparency === "boolean") {
        return state.transparency;
      }
    }
  } catch { /* Invalid persisted JSON: fall back to the legacy preference. */ }
  return storage?.getItem("harnss-transparency") !== "false";
}

// Early setup wrapped in try/catch so contextBridge.exposeInMainWorld always runs
// even if DOM isn't ready or something else fails above it.
try {
  const globals = globalThis as typeof globalThis & PreloadGlobals;
  const root = globals.document?.documentElement;
  const themeSource = readStoredThemeSource(globals.localStorage);

  // Start opaque; expose transparent surfaces only after main confirms the material.
  root?.classList.add(`platform-${process.platform}`);
  ipcRenderer.send("app:set-theme-source", themeSource);
  let latestEffect: BackgroundEffectState | undefined;
  const applyEffect = (state: BackgroundEffectState) => {
    latestEffect = state;
    const classes = globals.document?.documentElement?.classList;
    if (classes) applyBackgroundEffectClasses(classes, state);
  };
  globals.document?.addEventListener("DOMContentLoaded", () => {
    globals.document?.documentElement?.classList.add(`platform-${process.platform}`);
    if (latestEffect) applyEffect(latestEffect);
  }, { once: true });
  ipcRenderer.on("app:background-effect-changed", (_event, state: BackgroundEffectState) => applyEffect(state));
  void ipcRenderer.invoke("app:set-transparency", readStoredTransparency(globals.localStorage))
    .then(applyEffect)
    .catch((error) => console.error("[preload] background effect setup failed:", error));

  // Push stored theme to main process early so glass appearance is correct
  // before React mounts. Default to "dark" to match useSettings, which falls
  // back to "dark" when harnss-theme is unset — avoids a system→dark flash.
  const storedTheme = globals.localStorage?.getItem("harnss-theme");
  if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
    ipcRenderer.send("glass:set-theme", storedTheme);
  } else {
    ipcRenderer.send("glass:set-theme", "dark");
  }
} catch (e) {
  console.error("[preload] early setup failed:", e);
}

const projectApps: ProjectAppsApi = {
  pendingAgentPermissions: () => ipcRenderer.invoke("project-apps:agent-permissions"),
  respondAgentPermission: (response) => ipcRenderer.invoke("project-apps:agent-permission-response", response),
  onAgentPermission: (callback) => {
    const listener = (_event: IpcRendererEvent, event: ProjectAppAgentPermissionEvent) => callback(event);
    ipcRenderer.on("project-apps:agent-permission", listener);
    return () => ipcRenderer.removeListener("project-apps:agent-permission", listener);
  },
  list: () => ipcRenderer.invoke("project-apps:list"),
  markUsed: (appId) => ipcRenderer.invoke("project-apps:mark-used", appId),
  workspaces: (projectId) => ipcRenderer.invoke("project-apps:workspaces", projectId),
  validateWorkspace: (workspace) => ipcRenderer.invoke("project-apps:validate-workspace", workspace),
  discover: (workspace) => ipcRenderer.invoke("project-apps:discover", workspace),
  save: (request) => ipcRenderer.invoke("project-apps:save", request),
  remove: (request) => ipcRenderer.invoke("project-apps:remove", request),
  start: (request) => ipcRenderer.invoke("project-apps:start", request),
  stop: (request) => ipcRenderer.invoke("project-apps:stop", request),
  restart: (request) => ipcRenderer.invoke("project-apps:restart", request),
  logs: (request) => ipcRenderer.invoke("project-apps:logs", request),
  prepareContext: (request) => ipcRenderer.invoke("project-apps:prepare-context", request),
  links: (appId) => ipcRenderer.invoke("project-apps:links", appId),
  linkSession: (link) => ipcRenderer.invoke("project-apps:link-session", link),
  exportConfig: (ids) => ipcRenderer.invoke("project-apps:export-config", ids),
  importConfig: (request) => ipcRenderer.invoke("project-apps:import-config", request),
  onEvent: (callback) => {
    const listener = (_event: IpcRendererEvent, event: AppEvent) => callback(event);
    ipcRenderer.on("project-apps:event", listener);
    return () => ipcRenderer.removeListener("project-apps:event", listener);
  },
};

const tasks: TasksApi = {
  list: () => ipcRenderer.invoke("tasks:list"), create: (input) => ipcRenderer.invoke("tasks:create", input),
  prepare: (input) => ipcRenderer.invoke("tasks:prepare", input), abandonDraft: (input) => ipcRenderer.invoke("tasks:abandon-draft", input),
  addDeliverable: (input) => ipcRenderer.invoke("tasks:add-deliverable", input), review: (input) => ipcRenderer.invoke("tasks:review", input),
  revealFile: (id) => ipcRenderer.invoke("tasks:reveal-file", id),
  onChanged: (callback) => {
    const listener = (_event: IpcRendererEvent, snapshot: TaskSnapshot) => callback(snapshot);
    ipcRenderer.on("tasks:changed", listener);
    return () => ipcRenderer.removeListener("tasks:changed", listener);
  },
};

contextBridge.exposeInMainWorld("claude", {
  tasks,
  projectApps,
  getGlassSupported: () => ipcRenderer.invoke("app:getGlassSupported"),
  getBackgroundEffect: () => ipcRenderer.invoke("app:get-background-effect"),
  setTransparency: (enabled: boolean) => ipcRenderer.invoke("app:set-transparency", enabled),
  onBackgroundEffectChanged: (callback: (state: BackgroundEffectState) => void) => {
    const listener = (_event: IpcRendererEvent, state: BackgroundEffectState) => callback(state);
    ipcRenderer.on("app:background-effect-changed", listener);
    return () => ipcRenderer.removeListener("app:background-effect-changed", listener);
  },
  getMacBackgroundEffectSupport: () => ipcRenderer.invoke("app:get-mac-background-effect-support"),
  setThemeSource: (themeSource: ThemeSource) => ipcRenderer.send("app:set-theme-source", themeSource),
  setMacBackgroundEffect: (effect: MacBackgroundEffect) => ipcRenderer.send("app:set-mac-background-effect", effect),
  relaunchApp: () => ipcRenderer.invoke("app:relaunch"),
  setMinWidth: (width: number) => ipcRenderer.send("app:set-min-width", width),
  glass: {
    setTintColor: (tintColor: string | null) =>
      ipcRenderer.send("glass:set-tint-color", tintColor),
    setTheme: (theme: string) =>
      ipcRenderer.send("glass:set-theme", theme),
  },
  start: (options: unknown) => ipcRenderer.invoke("claude:start", options),
  send: (sessionId: string, message: unknown) => ipcRenderer.invoke("claude:send", { sessionId, message }),
  stop: (sessionId: string, reason?: string) =>
    ipcRenderer.invoke("claude:stop", { sessionId, reason }),
  interrupt: (sessionId: string) => ipcRenderer.invoke("claude:interrupt", sessionId),
  stopTask: (sessionId: string, taskId: string) =>
    ipcRenderer.invoke("claude:stop-task", { sessionId, taskId }),
  readAgentOutput: (outputFile: string) =>
    ipcRenderer.invoke("claude:read-agent-output", { outputFile }),
  log: (label: string, data: unknown) => ipcRenderer.send("claude:log", label, data),
  onEvent: (callback: (data: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("claude:event", listener);
    return () => ipcRenderer.removeListener("claude:event", listener);
  },
  onStderr: (callback: (data: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("claude:stderr", listener);
    return () => ipcRenderer.removeListener("claude:stderr", listener);
  },
  onExit: (callback: (data: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("claude:exit", listener);
    return () => ipcRenderer.removeListener("claude:exit", listener);
  },
  onPermissionRequest: (callback: (data: unknown) => void) => {
    const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on("claude:permission_request", listener);
    return () => ipcRenderer.removeListener("claude:permission_request", listener);
  },
  respondPermission: (sessionId: string, requestId: string, behavior: string, toolUseId: string, toolInput: unknown, newPermissionMode?: string, updatedPermissions?: unknown[]) =>
    ipcRenderer.invoke("claude:permission_response", { sessionId, requestId, behavior, toolUseId, toolInput, newPermissionMode, updatedPermissions }),
  setPermissionMode: (sessionId: string, permissionMode: string) =>
    ipcRenderer.invoke("claude:set-permission-mode", { sessionId, permissionMode }),
  setModel: (sessionId: string, model?: string) =>
    ipcRenderer.invoke("claude:set-model", { sessionId, model }),
  setThinking: (sessionId: string, thinkingEnabled: boolean) =>
    ipcRenderer.invoke("claude:set-thinking", { sessionId, thinkingEnabled }),
  version: () => ipcRenderer.invoke("claude:version"),
  binaryStatus: () => ipcRenderer.invoke("claude:binary-status"),
  scanBinaries: () => ipcRenderer.invoke("claude:scan-binaries"),
  computerUseStatus: () => ipcRenderer.invoke("computer-use:status"),
  computerUseRequestPermissions: () => ipcRenderer.invoke("computer-use:request-permissions"),
  supportedModels: (sessionId: string) => ipcRenderer.invoke("claude:supported-models", sessionId),
  slashCommands: (sessionId: string) => ipcRenderer.invoke("claude:slash-commands", sessionId),
  modelsCacheGet: () => ipcRenderer.invoke("claude:models-cache:get"),
  modelsCacheRevalidate: (options?: { cwd?: string }) => ipcRenderer.invoke("claude:models-cache:revalidate", options),
  mcpStatus: (sessionId: string) => ipcRenderer.invoke("claude:mcp-status", sessionId),
  mcpReconnect: (sessionId: string, serverName: string) =>
    ipcRenderer.invoke("claude:mcp-reconnect", { sessionId, serverName }),
  revertFiles: (sessionId: string, checkpointId: string) =>
    ipcRenderer.invoke("claude:revert-files", { sessionId, checkpointId }),
  restartSession: (sessionId: string, mcpServers?: unknown[], cwd?: string, effort?: string, model?: string, memoryContext?: { projectId: string }) =>
    ipcRenderer.invoke("claude:restart-session", { sessionId, mcpServers, cwd, effort, model, memoryContext }),
  readFile: (filePath: string) => ipcRenderer.invoke("file:read", filePath),
  renameFile: (oldPath: string, newPath: string) => ipcRenderer.invoke("file:rename", { oldPath, newPath }),
  trashItem: (filePath: string) => ipcRenderer.invoke("file:trash", filePath),
  newFile: (filePath: string) => ipcRenderer.invoke("file:new-file", filePath),
  newFolder: (folderPath: string) => ipcRenderer.invoke("file:new-folder", folderPath),
  writeClipboardText: (text: string) => ipcRenderer.invoke("clipboard:write-text", text),
  setBrowserColorScheme: (targetWebContentsId: number, colorScheme: "light" | "dark") =>
    ipcRenderer.invoke("browser:set-color-scheme", { targetWebContentsId, colorScheme }),
  openInEditor: (filePath: string, line?: number, editor?: string) => ipcRenderer.invoke("file:open-in-editor", { filePath, line, editor }),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:show-item-in-folder", filePath),
  generateTitle: (message: string, cwd?: string, engine?: string, sessionId?: string) =>
    ipcRenderer.invoke("claude:generate-title", { message, cwd, engine, sessionId }),
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (spaceId?: string) => ipcRenderer.invoke("projects:create", spaceId),
    createDev: (name: string, spaceId?: string) => ipcRenderer.invoke("projects:create-dev", name, spaceId),
    delete: (projectId: string) => ipcRenderer.invoke("projects:delete", projectId),
    rename: (projectId: string, name: string) => ipcRenderer.invoke("projects:rename", projectId, name),
    updateSpace: (projectId: string, spaceId: string) => ipcRenderer.invoke("projects:update-space", projectId, spaceId),
    updateIcon: (projectId: string, icon: string | null, iconType: "emoji" | "lucide" | null) => ipcRenderer.invoke("projects:update-icon", projectId, icon, iconType),
    reorder: (projectId: string, targetProjectId: string) => ipcRenderer.invoke("projects:reorder", projectId, targetProjectId),
  },
  sessions: {
    batch: {
      recoveries: () => ipcRenderer.invoke("sessions:batch-recoveries"),
      start: (request: BatchStartRequest) => ipcRenderer.invoke("sessions:batch-start", request),
      status: (jobId: string) => ipcRenderer.invoke("sessions:batch-status", jobId),
      cancel: (jobId: string) => ipcRenderer.invoke("sessions:batch-cancel", jobId),
      prepared: (request: BatchPreparedRequest) => ipcRenderer.invoke("sessions:batch-prepared", request),
      onProgress: (listener: (job: BatchJob) => void) => {
        const handler = (_event: IpcRendererEvent, job: BatchJob) => listener(job);
        ipcRenderer.on("sessions:batch-progress", handler);
        return () => { ipcRenderer.removeListener("sessions:batch-progress", handler); };
      },
      onPrepare: (listener: (job: BatchJob) => void) => {
        const handler = (_event: IpcRendererEvent, job: BatchJob) => listener(job);
        ipcRenderer.on("sessions:batch-prepare", handler);
        return () => { ipcRenderer.removeListener("sessions:batch-prepare", handler); };
      },
    } satisfies SessionBatchApi,
    save: (data: unknown, previousSessionId?: string) => ipcRenderer.invoke("sessions:save", data, previousSessionId),
    append: (data: unknown, previousSessionId?: string) => ipcRenderer.invoke("sessions:append", data, previousSessionId),
    load: (projectId: string, sessionId: string) => ipcRenderer.invoke("sessions:load", projectId, sessionId),
    list: (projectId: string) => ipcRenderer.invoke("sessions:list", projectId),
    delete: (projectId: string, sessionId: string) => ipcRenderer.invoke("sessions:delete", projectId, sessionId),
    search: (projectIds: string[], query: string) => ipcRenderer.invoke("sessions:search", { projectIds, query }),
    updateMeta: (projectId: string, sessionId: string, patch: { pinned?: boolean; folderId?: string | null; branch?: string; archived?: boolean }) =>
      ipcRenderer.invoke("sessions:update-meta", { projectId, sessionId, patch }),
    exportMarkdown: (projectId: string, sessionId: string) =>
      ipcRenderer.invoke("sessions:export-markdown", { projectId, sessionId }),
  },
  folders: {
    list: (projectId: string) => ipcRenderer.invoke("folders:list", projectId),
    create: (projectId: string, name: string) => ipcRenderer.invoke("folders:create", { projectId, name }),
    delete: (projectId: string, folderId: string) => ipcRenderer.invoke("folders:delete", { projectId, folderId }),
    rename: (projectId: string, folderId: string, name: string) => ipcRenderer.invoke("folders:rename", { projectId, folderId, name }),
    pin: (projectId: string, folderId: string, pinned: boolean) => ipcRenderer.invoke("folders:pin", { projectId, folderId, pinned }),
  },
  spaces: {
    list: () => ipcRenderer.invoke("spaces:list"),
    save: (spaces: unknown) => ipcRenderer.invoke("spaces:save", spaces),
  },
  ccSessions: {
    list: (projectPath: string) => ipcRenderer.invoke("cc-sessions:list", projectPath),
    import: (projectPath: string, ccSessionId: string) => ipcRenderer.invoke("cc-sessions:import", projectPath, ccSessionId),
  },
  files: {
    list: (cwd: string) => ipcRenderer.invoke("files:list", cwd),
    listAll: (cwd: string) => ipcRenderer.invoke("files:list-all", cwd),
    watch: (cwd: string) => ipcRenderer.invoke("files:watch", cwd),
    unwatch: (cwd: string) => ipcRenderer.invoke("files:unwatch", cwd),
    calculateDeepSize: (cwd: string, paths: string[]) => ipcRenderer.invoke("files:calculate-deep-size", { cwd, paths }),
    readMultiple: (cwd: string, paths: string[], deepPaths?: Set<string>) => ipcRenderer.invoke("files:read-multiple", { cwd, paths, deepPaths: deepPaths ? Array.from(deepPaths) : undefined }),
    onChanged: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("files:changed", listener);
      return () => ipcRenderer.removeListener("files:changed", listener);
    },
  },
  git: {
    discoverRepos: (projectPath: string) => ipcRenderer.invoke("git:discover-repos", projectPath),
    status: (cwd: string) => ipcRenderer.invoke("git:status", cwd),
    stage: (cwd: string, files: string[]) => ipcRenderer.invoke("git:stage", { cwd, files }),
    unstage: (cwd: string, files: string[]) => ipcRenderer.invoke("git:unstage", { cwd, files }),
    stageAll: (cwd: string) => ipcRenderer.invoke("git:stage-all", cwd),
    unstageAll: (cwd: string) => ipcRenderer.invoke("git:unstage-all", cwd),
    discard: (cwd: string, files: string[]) => ipcRenderer.invoke("git:discard", { cwd, files }),
    commit: (cwd: string, message: string) => ipcRenderer.invoke("git:commit", { cwd, message }),
    branches: (cwd: string) => ipcRenderer.invoke("git:branches", cwd),
    checkout: (cwd: string, branch: string) => ipcRenderer.invoke("git:checkout", { cwd, branch }),
    createBranch: (cwd: string, name: string) => ipcRenderer.invoke("git:create-branch", { cwd, name }),
    createWorktree: (cwd: string, path: string, branch: string, fromRef?: string) => ipcRenderer.invoke("git:create-worktree", { cwd, path, branch, fromRef }),
    removeWorktree: (cwd: string, path: string, force?: boolean) => ipcRenderer.invoke("git:remove-worktree", { cwd, path, force }),
    pruneWorktrees: (cwd: string) => ipcRenderer.invoke("git:prune-worktrees", cwd),
    push: (cwd: string) => ipcRenderer.invoke("git:push", cwd),
    pull: (cwd: string) => ipcRenderer.invoke("git:pull", cwd),
    fetch: (cwd: string) => ipcRenderer.invoke("git:fetch", cwd),
    diffFile: (cwd: string, file: string, staged: boolean) => ipcRenderer.invoke("git:diff-file", { cwd, file, staged }),
    diffStat: (cwd: string) => ipcRenderer.invoke("git:diff-stat", cwd) as Promise<{ additions: number; deletions: number }>,
    log: (cwd: string, count?: number) => ipcRenderer.invoke("git:log", { cwd, count }),
    generateCommitMessage: (cwd: string, engine?: string, sessionId?: string) =>
      ipcRenderer.invoke("git:generate-commit-message", { cwd, engine, sessionId }),
  },
  terminal: {
    create: (options: { cwd?: string; cols?: number; rows?: number; spaceId?: string }) => ipcRenderer.invoke("terminal:create", options),
    list: () => ipcRenderer.invoke("terminal:list"),
    snapshot: (terminalId: string) => ipcRenderer.invoke("terminal:snapshot", terminalId),
    write: (terminalId: string, data: string) => ipcRenderer.invoke("terminal:write", { terminalId, data }),
    resize: (terminalId: string, cols: number, rows: number) => ipcRenderer.invoke("terminal:resize", { terminalId, cols, rows }),
    destroy: (terminalId: string) => ipcRenderer.invoke("terminal:destroy", terminalId),
    destroySpace: (spaceId: string) => ipcRenderer.invoke("terminal:destroy-space", spaceId),
    onData: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("terminal:data", listener);
      return () => ipcRenderer.removeListener("terminal:data", listener);
    },
    onExit: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("terminal:exit", listener);
      return () => ipcRenderer.removeListener("terminal:exit", listener);
    },
  },
  acp: {
    log: (label: string, data: unknown) => ipcRenderer.send("acp:log", label, data),
    start: (options: { agentId: string; cwd: string; mcpServers?: unknown[]; source?: SessionResumeSource }) => ipcRenderer.invoke("acp:start", options),
    authenticate: (sessionId: string, methodId: string) =>
      ipcRenderer.invoke("acp:authenticate", { sessionId, methodId }),
    prompt: (sessionId: string, text: string, images?: unknown[]) =>
      ipcRenderer.invoke("acp:prompt", { sessionId, text, images }),
    stop: (sessionId: string) => ipcRenderer.invoke("acp:stop", sessionId),
    reloadSession: (sessionId: string, mcpServers?: unknown[], cwd?: string) =>
      ipcRenderer.invoke("acp:reload-session", { sessionId, mcpServers, cwd }),
    reviveSession: (options: { agentId: string; cwd: string; agentSessionId?: string; mcpServers?: unknown[]; source: SessionResumeSource }) =>
      ipcRenderer.invoke("acp:revive-session", options),
    cancel: (sessionId: string) => ipcRenderer.invoke("acp:cancel", sessionId),
    abortPendingStart: () => ipcRenderer.invoke("acp:abort-pending-start"),
    respondPermission: (sessionId: string, requestId: string, optionId: string) =>
      ipcRenderer.invoke("acp:permission_response", { sessionId, requestId, optionId }),
    setConfig: (sessionId: string, configId: string, value: string) =>
      ipcRenderer.invoke("acp:set-config", { sessionId, configId, value }),
    getCapabilities: (sessionId: string) => ipcRenderer.invoke("acp:get-capabilities", sessionId),
    listSessions: (sessionId: string, cursor?: string) => ipcRenderer.invoke("acp:list-sessions", { sessionId, cursor }),
    readSession: (sessionId: string, agentSessionId: string) => ipcRenderer.invoke("acp:read-session", { sessionId, agentSessionId }),
    forkSession: (sessionId: string) => ipcRenderer.invoke("acp:fork-session", { sessionId }),
    getConfigOptions: (sessionId: string) =>
      ipcRenderer.invoke("acp:get-config-options", sessionId),
    getAvailableCommands: (sessionId: string) =>
      ipcRenderer.invoke("acp:get-available-commands", sessionId),
    onEvent: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("acp:event", listener);
      return () => ipcRenderer.removeListener("acp:event", listener);
    },
    onPermissionRequest: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("acp:permission_request", listener);
      return () => ipcRenderer.removeListener("acp:permission_request", listener);
    },
    onTurnComplete: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("acp:turn_complete", listener);
      return () => ipcRenderer.removeListener("acp:turn_complete", listener);
    },
    onExit: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("acp:exit", listener);
      return () => ipcRenderer.removeListener("acp:exit", listener);
    },
  },
  codex: {
    log: (label: string, data: unknown) => ipcRenderer.send("codex:log", label, data),
    start: (options: { cwd: string; model?: string; approvalPolicy?: string; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; personality?: string; collaborationMode?: { mode: string; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } } }) =>
      ipcRenderer.invoke("codex:start", options),
    send: (sessionId: string, text: string, images?: Array<{ type: "image"; url: string } | { type: "localImage"; path: string }>, effort?: string, collaborationMode?: { mode: string; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } }) =>
      ipcRenderer.invoke("codex:send", { sessionId, text, images, effort, collaborationMode }),
    stop: (sessionId: string) => ipcRenderer.invoke("codex:stop", sessionId),
    interrupt: (sessionId: string) => ipcRenderer.invoke("codex:interrupt", sessionId),
    respondApproval: (sessionId: string, rpcId: string | number, decision: string, acceptSettings?: unknown) =>
      ipcRenderer.invoke("codex:approval_response", { sessionId, rpcId, decision, acceptSettings }),
    respondUserInput: (sessionId: string, rpcId: string | number, answers: Record<string, { answers: string[] }>) =>
      ipcRenderer.invoke("codex:user_input_response", { sessionId, rpcId, answers }),
    respondServerRequestError: (sessionId: string, rpcId: string | number, code: number, message: string) =>
      ipcRenderer.invoke("codex:server_request_error", { sessionId, rpcId, code, message }),
    compact: (sessionId: string) => ipcRenderer.invoke("codex:compact", sessionId),
    getGoal: (sessionId: string) => ipcRenderer.invoke("codex:goal-get", { sessionId }),
    setGoal: (sessionId: string, input: { objective?: string | null; tokenBudget?: number | null; status?: "active" | "paused" }) =>
      ipcRenderer.invoke("codex:goal-set", { sessionId, ...input }),
    clearGoal: (sessionId: string) => ipcRenderer.invoke("codex:goal-clear", { sessionId }),
    listSkills: (sessionId: string) => ipcRenderer.invoke("codex:list-skills", sessionId),
    listApps: (sessionId: string) => ipcRenderer.invoke("codex:list-apps", sessionId),
    listModels: () => ipcRenderer.invoke("codex:list-models"),
    fingerprintProbe: (options: CodexFingerprintProbeRequest) => ipcRenderer.invoke("codex:fingerprint-probe", options),
    authStatus: () => ipcRenderer.invoke("codex:auth-status"),
    login: (sessionId: string, type: "apiKey" | "chatgpt", apiKey?: string) =>
      ipcRenderer.invoke("codex:login", { sessionId, type, apiKey }),
    resume: (options: { cwd: string; threadId: string; model?: string; approvalPolicy?: string; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; source: SessionResumeSource }) =>
      ipcRenderer.invoke("codex:resume", options),
    setModel: (sessionId: string, model: string) =>
      ipcRenderer.invoke("codex:set-model", { sessionId, model }),
    version: () => ipcRenderer.invoke("codex:version"),
    binaryStatus: () => ipcRenderer.invoke("codex:binary-status"),
    scanBinaries: () => ipcRenderer.invoke("codex:scan-binaries"),
    computerUseStatus: () => ipcRenderer.invoke("codex:computer-use-status"),
    onEvent: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("codex:event", listener);
      return () => ipcRenderer.removeListener("codex:event", listener);
    },
    onApprovalRequest: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("codex:approval_request", listener);
      return () => ipcRenderer.removeListener("codex:approval_request", listener);
    },
    onExit: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("codex:exit", listener);
      return () => ipcRenderer.removeListener("codex:exit", listener);
    },
  },
  mcp: {
    list: (projectId: string) => ipcRenderer.invoke("mcp:list", projectId),
    add: (projectId: string, server: unknown) => ipcRenderer.invoke("mcp:add", { projectId, server }),
    remove: (projectId: string, name: string) => ipcRenderer.invoke("mcp:remove", { projectId, name }),
    authenticate: (serverName: string, serverUrl: string) => ipcRenderer.invoke("mcp:authenticate", { serverName, serverUrl }),
    authStatus: (serverName: string) => ipcRenderer.invoke("mcp:auth-status", serverName),
    probe: (servers: unknown[]) => ipcRenderer.invoke("mcp:probe", servers),
  },
  agents: {
    list: () => ipcRenderer.invoke("agents:list"),
    save: (agent: unknown) => ipcRenderer.invoke("agents:save", agent),
    delete: (id: string) => ipcRenderer.invoke("agents:delete", id),
    updateCachedConfig: (agentId: string, configOptions: unknown[]) =>
      ipcRenderer.invoke("agents:update-cached-config", agentId, configOptions),
    checkBinaries: (agents: Array<{ id: string; binary: Record<string, { cmd: string; args?: string[] }> }>) =>
      ipcRenderer.invoke("agents:check-binaries", agents),
    getPlatformKeys: () => ipcRenderer.invoke("agents:get-platform-keys"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:set", patch),
    onChanged: (callback: (data: unknown) => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on("settings:changed", listener);
      return () => ipcRenderer.removeListener("settings:changed", listener);
    },
  },
  composerPrediction: {
    request: (request: ComposerPredictionRequest) => ipcRenderer.invoke("composer-prediction:request", request),
    cancel: (requestId: string) => ipcRenderer.invoke("composer-prediction:cancel", requestId),
  },
  skills: {
    list: () => ipcRenderer.invoke("skills:list"),
  },
  memory: {
    sessionRecall: (sessionId: string) => ipcRenderer.invoke("memory:session-recall", sessionId),
    skipNextRecall: (sessionId: string, skip: boolean) => ipcRenderer.invoke("memory:skip-next-recall", { sessionId, skip }),
    getDocument: (bankId: string, documentId: string) => ipcRenderer.invoke("memory:get-document", { bankId, documentId }),
    projectBank: (projectId: string) => ipcRenderer.invoke("memory:project-bank", projectId),
    retainProject: (projectId: string, content: string, scope: "project" | "user") => ipcRenderer.invoke("memory:retain-project", { projectId, content, scope }),
    getStatus: () => ipcRenderer.invoke("memory:get-status"),
    setLlmKey: (key: string) => ipcRenderer.invoke("memory:set-llm-key", key),
    clearLlmKey: () => ipcRenderer.invoke("memory:clear-llm-key"),
    testConnection: (key?: string) => ipcRenderer.invoke("memory:test-connection", key),
    daemonStart: () => ipcRenderer.invoke("memory:daemon-start"),
    daemonStop: () => ipcRenderer.invoke("memory:daemon-stop"),
    daemonInstallDeps: () => ipcRenderer.invoke("memory:daemon-install-deps"),
    listDocuments: (bankId: string) => ipcRenderer.invoke("memory:list-documents", bankId),
    listMemories: (bankId: string) => ipcRenderer.invoke("memory:list-memories", bankId),
    updateMemory: (bankId: string, memoryId: string, patch: Record<string, unknown>) => ipcRenderer.invoke("memory:update-memory", { bankId, memoryId, patch }),
    runGoldenSet: (bankId: string) => ipcRenderer.invoke("memory:run-golden-set", bankId),
    deleteDocument: (bankId: string, documentId: string) => ipcRenderer.invoke("memory:delete-document", { bankId, documentId }),
    retainManual: (sessionId: string, content: string) => ipcRenderer.invoke("memory:retain-manual", { sessionId, content }),
    getProjectConfig: (projectId: string) => ipcRenderer.invoke("memory:get-project-config", projectId),
    setProjectConfig: (projectId: string, patch: Partial<MemoryProjectConfig>) => ipcRenderer.invoke("memory:set-project-config", { projectId, patch }),
  },
  analytics: {
    capture: (event: string, properties?: Record<string, unknown>) =>
      ipcRenderer.send("analytics:capture", event, properties),
  },
  usage: {
    get: (days: number) => ipcRenderer.invoke("usage:get", days),
    getSessionTokens: (sessionId: string) => ipcRenderer.invoke("usage:session-tokens", sessionId),
    activity: (start: number, end: number) => ipcRenderer.send("usage:activity", start, end),
  },
  shortcuts: { getStatus: () => ipcRenderer.invoke("shortcuts:get-status") },
  history: {
    search: (request) => ipcRenderer.invoke("history:search", request),
    timeline: (request) => ipcRenderer.invoke("history:timeline", request),
    activity: (request) => ipcRenderer.invoke("history:activity", request),
    resolve: (location) => ipcRenderer.invoke("history:resolve", location),
    cancel: (id) => ipcRenderer.invoke("history:cancel", id),
    status: () => ipcRenderer.invoke("history:status"),
    rebuild: (kind) => ipcRenderer.invoke("history:rebuild", kind ?? "keyword"),
    cancelRebuild: () => ipcRenderer.invoke("history:cancelRebuild"),
    semanticControl: (action) => ipcRenderer.invoke("history:semantic-control", action),
    onStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, status: HistoryIndexStatus) => listener(status);
      ipcRenderer.on("history:status-changed", handler);
      return () => { ipcRenderer.removeListener("history:status-changed", handler); };
    },
  } satisfies HistoryApi,
  quickCapture: {
    checkTarget: (requestId: string, target: QuickCaptureTarget) => ipcRenderer.invoke("quick-capture:check-target", { requestId, target }),
    pending: () => ipcRenderer.invoke("quick-capture:pending"),
    update: (request: QuickCaptureUpdate) => ipcRenderer.invoke("quick-capture:update", request),
    onRequested: (listener) => {
      const handler = (_event: IpcRendererEvent, request: Parameters<typeof listener>[0]) => listener(request);
      ipcRenderer.on("quick-capture:requested", handler);
      return () => { ipcRenderer.removeListener("quick-capture:requested", handler); };
    },
  } satisfies QuickCaptureApi,
  speech: {
    startNativeDictation: () => ipcRenderer.invoke("speech:start-native-dictation"),
    getPlatform: () => ipcRenderer.invoke("speech:get-platform"),
    requestMicPermission: () => ipcRenderer.invoke("speech:request-mic-permission"),
  },
});
