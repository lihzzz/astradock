import type { ClaudeEvent } from "./protocol";
import type { CCSessionInfo, ChatFolder, PersistedSession, Project, UIMessage, ClaudeEffort } from "./session";
import type { Space } from "./spaces";
import type { SearchMessageResult, SearchSessionResult } from "./search";
import type { ModelInfo, McpServerConfig, McpServerStatus } from "./mcp";
import type { PermissionUpdate } from "./permissions";
import type { GitRepoInfo, GitStatus, GitBranch, GitLogEntry } from "@shared/types/git";
import type { InstalledAgent } from "@shared/types/registry";
import type { AppSettings, EngineBinaryScanResult, MacBackgroundEffect, ThemeOption } from "@shared/types/settings";
import type { MemoryRecallState, MemoryDocument, MemoryFact, MemoryGoldenReport, MemoryProjectConfig, MemoryStatusResult } from "@shared/types/memory";
import type { SkillsListResult } from "@shared/types/skills";
import type { SessionTokenUsage, UsageRange, UsageReport } from "@shared/types/usage";
import type {
  ACPSessionEvent,
  ACPPermissionEvent,
  ACPTurnCompleteEvent,
  ACPConfigOption,
  ACPAuthenticateResult,
  ACPAvailableCommand,
  ACPAuthMethod,
  ACPStartResult,
  ACPStatusInfo,
} from "./acp";
import type { EngineId, AppPermissionBehavior } from "./engine";
import type { CodexSessionEvent, CodexServerRequest, CodexExitEvent } from "./codex";
import type { Model as CodexModel } from "./codex-protocol/v2/Model";
import type { CollaborationMode } from "./codex-protocol/CollaborationMode";
import type { SkillsListEntry } from "./codex-protocol/v2/SkillsListEntry";
import type { AppInfo } from "./codex-protocol/v2/AppInfo";
import type { CodexFingerprintProbeRequest, CodexFingerprintProbeResult } from "./codex-fingerprint";
import type { BackgroundEffectState } from "@shared/types/background-effect";
import type { ProjectAppsApi } from "@shared/types/project-apps";
import type { TasksApi } from "@shared/types/tasks";
import type { SessionMeta as SessionListItem } from "@shared/lib/session-persistence";
import type { HistoryApi, OperationResult, QuickCaptureApi, SessionBatchApi, SessionResumeSource, ShortcutStatus } from "@shared/types/productivity";
import type { ComposerPredictionCancelResult, ComposerPredictionRequest, ComposerPredictionResult } from "@shared/types/composer-prediction";

/** Standard IPC result envelope — most IPC calls return this shape. */
interface IpcResult {
  ok?: boolean;
  error?: string;
}

type CodexImageInput = { type: "image"; url: string } | { type: "localImage"; path: string };

declare global {
  interface Window {
    claude: {
      projectApps: ProjectAppsApi;
      tasks: TasksApi;
      getGlassSupported: () => Promise<boolean>;
      getBackgroundEffect: () => Promise<BackgroundEffectState>;
      setTransparency: (enabled: boolean) => Promise<BackgroundEffectState>;
      onBackgroundEffectChanged: (callback: (state: BackgroundEffectState) => void) => () => void;
      getMacBackgroundEffectSupport: () => Promise<{ liquidGlass: boolean; vibrancy: boolean }>;
      setThemeSource: (themeSource: ThemeOption) => void;
      setMacBackgroundEffect: (effect: MacBackgroundEffect) => void;
      relaunchApp: () => Promise<IpcResult>;
      setMinWidth: (width: number) => void;
      glass: {
        setTintColor: (tintColor: string | null) => void;
        setTheme: (theme: "light" | "dark" | "system") => void;
      };
      start: (options?: {
        cwd?: string;
        model?: string;
        permissionMode?: string;
        thinkingEnabled?: boolean;
        effort?: ClaudeEffort;
        resume?: string;
        /** Fork to a new session ID when resuming (model forgets messages after resumeSessionAt) */
        forkSession?: boolean;
        /** Resume at a specific message UUID — used with forkSession to truncate history */
        resumeSessionAt?: string;
        mcpServers?: McpServerConfig[];
        memoryContext?: { projectId: string };
        source?: SessionResumeSource;
      }) => Promise<{ sessionId: string; pid: number; error?: string }>;
      send: (
        sessionId: string,
        message: { type: string; message: { role: string; content: string | Array<{ type: string; [key: string]: unknown }> } },
      ) => Promise<IpcResult>;
      stop: (sessionId: string, reason?: string) => Promise<{ ok: boolean }>;
      interrupt: (sessionId: string) => Promise<IpcResult>;
      stopTask: (sessionId: string, taskId: string) => Promise<IpcResult>;
      readAgentOutput: (outputFile: string) => Promise<{ messages?: unknown[]; error?: string }>;
      supportedModels: (sessionId: string) => Promise<{ models: ModelInfo[]; error?: string }>;
      slashCommands: (sessionId: string) => Promise<{
        commands: Array<{ name: string; description?: string; argumentHint?: string }>;
        error?: string;
      }>;
      modelsCacheGet: () => Promise<{ models: ModelInfo[]; updatedAt?: number; error?: string }>;
      modelsCacheRevalidate: (options?: { cwd?: string }) => Promise<{ models: ModelInfo[]; updatedAt?: number; error?: string }>;
      mcpStatus: (sessionId: string) => Promise<{ servers: McpServerStatus[]; error?: string }>;
      mcpReconnect: (sessionId: string, serverName: string) => Promise<IpcResult & { restarted?: boolean }>;
      revertFiles: (sessionId: string, checkpointId: string) => Promise<IpcResult>;
      restartSession: (sessionId: string, mcpServers?: McpServerConfig[], cwd?: string, effort?: ClaudeEffort, model?: string, memoryContext?: { projectId: string }) => Promise<IpcResult & { restarted?: boolean }>;
      readFile: (filePath: string) => Promise<{ content?: string; error?: string }>;
      renameFile: (oldPath: string, newPath: string) => Promise<IpcResult>;
      trashItem: (filePath: string) => Promise<IpcResult>;
      newFile: (filePath: string) => Promise<IpcResult>;
      newFolder: (folderPath: string) => Promise<IpcResult>;
      writeClipboardText: (text: string) => Promise<IpcResult>;
      setBrowserColorScheme: (
        targetWebContentsId: number,
        colorScheme: "light" | "dark",
      ) => Promise<IpcResult>;
      openInEditor: (filePath: string, line?: number, editor?: string) => Promise<IpcResult & { editor?: string }>;
      openExternal: (url: string) => Promise<IpcResult>;
      showItemInFolder: (filePath: string) => Promise<IpcResult>;
      generateTitle: (
        message: string,
        cwd?: string,
        engine?: EngineId,
        sessionId?: string,
      ) => Promise<{ title?: string; error?: string }>;
      log: (label: string, data: unknown) => void;
      onEvent: (callback: (event: ClaudeEvent & { _sessionId: string }) => void) => () => void;
      onStderr: (callback: (data: { data: string; _sessionId: string }) => void) => () => void;
      onExit: (callback: (data: { code: number | null; _sessionId: string; error?: string }) => void) => () => void;
      onPermissionRequest: (
        callback: (data: {
          _sessionId: string;
          requestId: string;
          toolName: string;
          toolInput: Record<string, unknown>;
          toolUseId: string;
          suggestions?: PermissionUpdate[];
          decisionReason?: string;
        }) => void,
      ) => () => void;
      respondPermission: (
        sessionId: string,
        requestId: string,
        behavior: AppPermissionBehavior,
        toolUseId: string,
        toolInput: Record<string, unknown>,
        newPermissionMode?: string,
        updatedPermissions?: unknown[],
      ) => Promise<IpcResult>;
      setPermissionMode: (
        sessionId: string,
        permissionMode: string,
      ) => Promise<IpcResult>;
      setModel: (
        sessionId: string,
        model?: string,
      ) => Promise<IpcResult>;
      setThinking: (
        sessionId: string,
        thinkingEnabled: boolean,
      ) => Promise<IpcResult>;
      version: () => Promise<{ version?: string | null; error?: string }>;
      binaryStatus: () => Promise<{ installed: boolean }>;
      scanBinaries: () => Promise<EngineBinaryScanResult>;
      computerUseStatus: () => Promise<import("@shared/types/computer-use").ComputerUseRuntimeStatus>;
      computerUseRequestPermissions: () => Promise<import("@shared/types/computer-use").ComputerUseRuntimeStatus["permissions"]>;
      projects: {
        list: () => Promise<Project[]>;
        create: (spaceId?: string) => Promise<Project | null>;
        createDev: (name: string, spaceId?: string) => Promise<Project | null>;
        delete: (projectId: string) => Promise<IpcResult>;
        rename: (projectId: string, name: string) => Promise<IpcResult>;
        updateSpace: (projectId: string, spaceId: string) => Promise<IpcResult>;
        updateIcon: (projectId: string, icon: string | null, iconType: "emoji" | "lucide" | null) => Promise<IpcResult>;
        reorder: (projectId: string, targetProjectId: string) => Promise<IpcResult>;
      };
      sessions: {
        batch: SessionBatchApi;
        save: (data: PersistedSession, previousSessionId?: string) => Promise<IpcResult>;
        append: (data: Omit<PersistedSession, "messages"> & {
          appendedMessages: UIMessage[];
          messageCount: number;
          lastMessageAt: number;
        }, previousSessionId?: string) => Promise<IpcResult>;
        load: (projectId: string, sessionId: string) => Promise<PersistedSession | null>;
        list: (projectId: string) => Promise<SessionListItem[]>;
        delete: (projectId: string, sessionId: string) => Promise<IpcResult>;
        search: (projectIds: string[], query: string) => Promise<{
          messageResults: SearchMessageResult[];
          sessionResults: SearchSessionResult[];
        }>;
        updateMeta: (projectId: string, sessionId: string, patch: {
          pinned?: boolean;
          folderId?: string | null;
          branch?: string;
          archived?: boolean;
        }) => Promise<IpcResult>;
        exportMarkdown: (projectId: string, sessionId: string) => Promise<{
          ok?: boolean;
          filePath?: string;
          canceled?: boolean;
          error?: string;
        }>;
      };
      folders: {
        list: (projectId: string) => Promise<ChatFolder[]>;
        create: (projectId: string, name: string) => Promise<ChatFolder>;
        delete: (projectId: string, folderId: string) => Promise<IpcResult>;
        rename: (projectId: string, folderId: string, name: string) => Promise<IpcResult>;
        pin: (projectId: string, folderId: string, pinned: boolean) => Promise<IpcResult>;
      };
      spaces: {
        list: () => Promise<Space[]>;
        save: (spaces: Space[]) => Promise<IpcResult>;
      };
      ccSessions: {
        list: (projectPath: string) => Promise<CCSessionInfo[]>;
        import: (projectPath: string, ccSessionId: string) => Promise<{
          messages?: UIMessage[];
          ccSessionId?: string;
          error?: string;
        }>;
      };
      files: {
        list: (cwd: string) => Promise<{ files: string[]; dirs: string[] }>;
        listAll: (cwd: string) => Promise<{ files: string[]; dirs: string[] }>;
        watch: (cwd: string) => Promise<IpcResult>;
        unwatch: (cwd: string) => Promise<IpcResult>;
        calculateDeepSize: (
          cwd: string,
          paths: string[],
        ) => Promise<{
          totalSize: number;
          fileCount: number;
          estimatedTokens: number;
          warnings: string[];
        }>;
        readMultiple: (
          cwd: string,
          paths: string[],
          deepPaths?: Set<string>,
        ) => Promise<
          Array<
            | { path: string; content: string; isDir?: false; error?: undefined }
            | { path: string; isDir: true; tree: string; error?: undefined }
            | { path: string; error: string; content?: undefined; isDir?: undefined }
          >
        >;
        onChanged: (callback: (data: { cwd: string }) => void) => () => void;
      };
      git: {
        discoverRepos: (projectPath: string) => Promise<GitRepoInfo[]>;
        status: (cwd: string) => Promise<GitStatus | { error: string }>;
        stage: (cwd: string, files: string[]) => Promise<IpcResult>;
        unstage: (cwd: string, files: string[]) => Promise<IpcResult>;
        stageAll: (cwd: string) => Promise<IpcResult>;
        unstageAll: (cwd: string) => Promise<IpcResult>;
        discard: (cwd: string, files: string[]) => Promise<IpcResult>;
        commit: (cwd: string, message: string) => Promise<IpcResult & { output?: string }>;
        branches: (cwd: string) => Promise<GitBranch[] | { error: string }>;
        checkout: (cwd: string, branch: string) => Promise<IpcResult>;
        createBranch: (cwd: string, name: string) => Promise<IpcResult>;
        createWorktree: (cwd: string, path: string, branch: string, fromRef?: string) => Promise<IpcResult & { path?: string; output?: string; setupResults?: Array<{ command: string; ok: boolean; output?: string; error?: string }> }>;
        removeWorktree: (cwd: string, path: string, force?: boolean) => Promise<IpcResult & { output?: string }>;
        pruneWorktrees: (cwd: string) => Promise<IpcResult & { output?: string }>;
        push: (cwd: string) => Promise<IpcResult & { output?: string }>;
        pull: (cwd: string) => Promise<IpcResult & { output?: string }>;
        fetch: (cwd: string) => Promise<IpcResult & { output?: string }>;
        diffFile: (cwd: string, file: string, staged: boolean) => Promise<{ diff?: string; error?: string }>;
        diffStat: (cwd: string) => Promise<{ additions: number; deletions: number }>;
        log: (cwd: string, count?: number) => Promise<GitLogEntry[] | { error: string }>;
        generateCommitMessage: (
          cwd: string,
          engine?: EngineId,
          sessionId?: string,
        ) => Promise<{ message?: string; error?: string }>;
      };
      terminal: {
        create: (options: { cwd?: string; cols?: number; rows?: number; spaceId?: string }) => Promise<{ terminalId?: string; error?: string }>;
        list: () => Promise<{
          terminals?: Array<{
            terminalId: string;
            spaceId: string;
            createdAt: number;
            exited: boolean;
            exitCode: number | null;
          }>;
          error?: string;
        }>;
        snapshot: (terminalId: string) => Promise<{
          output?: string;
          seq?: number;
          cols?: number;
          rows?: number;
          exited?: boolean;
          exitCode?: number | null;
          error?: string;
        }>;
        write: (terminalId: string, data: string) => Promise<IpcResult>;
        resize: (terminalId: string, cols: number, rows: number) => Promise<IpcResult>;
        destroy: (terminalId: string) => Promise<{ ok?: boolean }>;
        destroySpace: (spaceId: string) => Promise<{ ok?: boolean }>;
        onData: (callback: (data: { terminalId: string; data: string; seq: number }) => void) => () => void;
        onExit: (callback: (data: { terminalId: string; exitCode: number }) => void) => () => void;
      };
      acp: {
        log: (label: string, data: unknown) => void;
        start: (options: { agentId: string; cwd: string; mcpServers?: McpServerConfig[]; memoryContext?: { projectId: string }; source?: SessionResumeSource }) => Promise<ACPStartResult>;
        authenticate: (sessionId: string, methodId: string) => Promise<ACPAuthenticateResult>;
        prompt: (sessionId: string, text: string, images?: unknown[]) => Promise<IpcResult>;
        stop: (sessionId: string) => Promise<IpcResult>;
        reloadSession: (sessionId: string, mcpServers?: McpServerConfig[], cwd?: string) => Promise<IpcResult & { supportsLoad?: boolean; mcpStatuses?: ACPStatusInfo[] }>;
        reviveSession: (options: { agentId: string; cwd: string; agentSessionId?: string; mcpServers?: McpServerConfig[]; memoryContext?: { projectId: string }; source: SessionResumeSource }) => Promise<{ sessionId?: string; agentSessionId?: string; usedLoad?: boolean; configOptions?: ACPConfigOption[]; mcpStatuses?: ACPStatusInfo[]; error?: string }>;
        cancel: (sessionId: string) => Promise<IpcResult>;
        abortPendingStart: () => Promise<{ ok?: boolean }>;
        respondPermission: (sessionId: string, requestId: string, optionId: string) => Promise<IpcResult>;
        setConfig: (sessionId: string, configId: string, value: string) => Promise<{ configOptions?: ACPConfigOption[]; error?: string }>;
        getCapabilities: (sessionId: string) => Promise<{ capabilities: import("@agentclientprotocol/sdk").AgentCapabilities; agentName?: string }>;
        listSessions: (sessionId: string, cursor?: string) => Promise<{ sessions?: import("@agentclientprotocol/sdk").SessionInfo[]; nextCursor?: string | null; error?: string }>;
        readSession: (sessionId: string, agentSessionId: string) => Promise<{ events?: import("@agentclientprotocol/sdk").SessionNotification[]; error?: string }>;
        forkSession: (sessionId: string) => Promise<{ agentSessionId?: string; cwd?: string; error?: string }>;
        getConfigOptions: (sessionId: string) => Promise<{ configOptions?: ACPConfigOption[] }>;
        getAvailableCommands: (sessionId: string) => Promise<{ commands?: ACPAvailableCommand[] }>;
        onEvent: (callback: (data: ACPSessionEvent) => void) => () => void;
        onPermissionRequest: (callback: (data: ACPPermissionEvent) => void) => () => void;
        onTurnComplete: (callback: (data: ACPTurnCompleteEvent) => void) => () => void;
        onExit: (callback: (data: { _sessionId: string; code: number | null; error?: string }) => void) => () => void;
      };
      codex: {
        log: (label: string, data: unknown) => void;
        start: (options: { cwd: string; model?: string; approvalPolicy?: string; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; personality?: string; collaborationMode?: CollaborationMode; memoryContext?: { projectId: string } }) =>
          Promise<{
            sessionId?: string;
            threadId?: string;
            models?: CodexModel[];
            selectedModel?: string;
            account?: unknown;
            needsAuth?: boolean;
            error?: string;
          }>;
        send: (sessionId: string, text: string, images?: CodexImageInput[], effort?: string, collaborationMode?: CollaborationMode) =>
          Promise<{ turnId?: string; error?: string }>;
        stop: (sessionId: string) => Promise<void>;
        interrupt: (sessionId: string) => Promise<{ error?: string }>;
        respondApproval: (sessionId: string, rpcId: string | number, decision: string, acceptSettings?: unknown) =>
          Promise<IpcResult>;
        respondUserInput: (
          sessionId: string,
          rpcId: string | number,
          answers: Record<string, { answers: string[] }>,
        ) => Promise<IpcResult>;
        respondServerRequestError: (
          sessionId: string,
          rpcId: string | number,
          code: number,
          message: string,
        ) => Promise<IpcResult>;
        compact: (sessionId: string) => Promise<{ error?: string }>;
        getGoal: (sessionId: string) => Promise<{
          supported: boolean;
          goal: import("@shared/types/codex").CodexThreadGoal | null;
          reason?: "method-not-found";
          error?: string;
        }>;
        setGoal: (sessionId: string, input: { objective?: string | null; tokenBudget?: number | null; status?: "active" | "paused" }) => Promise<{
          supported: boolean;
          goal: import("@shared/types/codex").CodexThreadGoal | null;
          reason?: "method-not-found";
          error?: string;
        }>;
        clearGoal: (sessionId: string) => Promise<{
          supported: boolean;
          goal: import("@shared/types/codex").CodexThreadGoal | null;
          reason?: "method-not-found";
          error?: string;
        }>;
        listSkills: (sessionId: string) => Promise<{
          skills: SkillsListEntry[];
          error?: string;
        }>;
        listApps: (sessionId: string) => Promise<{
          apps: AppInfo[];
          error?: string;
        }>;
        listModels: () => Promise<{ models: CodexModel[]; error?: string }>;
        fingerprintProbe: (options: CodexFingerprintProbeRequest) => Promise<CodexFingerprintProbeResult | { error: string }>;
        authStatus: () => Promise<{ account: unknown; requiresOpenaiAuth: boolean }>;
        login: (sessionId: string, type: "apiKey" | "chatgpt", apiKey?: string) => Promise<unknown>;
        resume: (options: { cwd: string; threadId: string; model?: string; approvalPolicy?: string; sandbox?: "read-only" | "workspace-write" | "danger-full-access"; memoryContext?: { projectId: string }; source: SessionResumeSource }) =>
          Promise<{ sessionId?: string; threadId?: string; goal?: import("@shared/types/codex").CodexThreadGoal | null; goalSupported?: boolean; error?: string }>;
        setModel: (sessionId: string, model: string) => Promise<{ error?: string }>;
        version: () => Promise<{ version?: string; error?: string }>;
        binaryStatus: () => Promise<{ installed: boolean }>;
        scanBinaries: () => Promise<EngineBinaryScanResult>;
        computerUseStatus: () => Promise<import("@shared/types/codex").CodexComputerUseStatus>;
        onEvent: (callback: (data: CodexSessionEvent) => void) => () => void;
        onApprovalRequest: (callback: (data: CodexServerRequest) => void) => () => void;
        onExit: (callback: (data: CodexExitEvent) => void) => () => void;
      };
      mcp: {
        list: (projectId: string) => Promise<McpServerConfig[]>;
        add: (projectId: string, server: McpServerConfig) => Promise<IpcResult>;
        remove: (projectId: string, name: string) => Promise<IpcResult>;
        authenticate: (serverName: string, serverUrl: string) => Promise<IpcResult>;
        authStatus: (serverName: string) => Promise<{ hasToken: boolean; expiresAt?: number }>;
        probe: (servers: McpServerConfig[]) => Promise<Array<{ name: string; status: "connected" | "needs-auth" | "failed"; error?: string }>>;
      };
      agents: {
        list: () => Promise<InstalledAgent[]>;
        save: (agent: InstalledAgent) => Promise<IpcResult>;
        delete: (id: string) => Promise<IpcResult>;
        updateCachedConfig: (agentId: string, configOptions: ACPConfigOption[]) => Promise<{ ok?: boolean }>;
        /** Batch-check if binary-only agents are installed on the system PATH. */
        checkBinaries: (
          agents: Array<{ id: string; binary: Record<string, { cmd: string; args?: string[] }> }>,
        ) => Promise<Record<string, { path: string; args?: string[] } | null>>;
        /** Preferred ACP registry platform keys for the current machine. */
        getPlatformKeys: () => Promise<string[]>;
      };
      settings: {
        get: () => Promise<AppSettings>;
        set: (patch: Partial<AppSettings>) => Promise<IpcResult>;
        /** Subscribe to settings changes pushed from the main process. */
        onChanged: (callback: (settings: AppSettings) => void) => () => void;
      };
      composerPrediction: {
        request: (request: ComposerPredictionRequest) => Promise<ComposerPredictionResult>;
        cancel: (requestId: string) => Promise<ComposerPredictionCancelResult>;
      };
      skills: {
        list: () => Promise<SkillsListResult>;
      };
      memory: {
        sessionRecall: (sessionId: string) => Promise<{ state?: MemoryRecallState | null; error?: string }>;
        skipNextRecall: (sessionId: string, skip: boolean) => Promise<IpcResult>;
        getDocument: (bankId: string, documentId: string) => Promise<{ text?: string; tags?: string[]; error?: string }>;
        projectBank: (projectId: string) => Promise<{ bankId?: string; error?: string }>;
        retainProject: (projectId: string, content: string, scope: "project" | "user") => Promise<IpcResult>;
        getStatus: () => Promise<MemoryStatusResult>;
        setLlmKey: (key: string) => Promise<IpcResult & { hasLlmKey?: boolean }>;
        clearLlmKey: () => Promise<IpcResult>;
        testConnection: (key?: string) => Promise<{ ok: boolean; error?: string }>;
        daemonStart: () => Promise<{ ok?: boolean; error?: string; status?: MemoryStatusResult }>;
        daemonStop: () => Promise<{ ok?: boolean; error?: string }>;
        daemonInstallDeps: () => Promise<{ ok?: boolean; error?: string; status?: MemoryStatusResult }>;
        listDocuments: (bankId: string) => Promise<{ documents?: MemoryDocument[]; total?: number; error?: string }>;
        listMemories: (bankId: string) => Promise<{ memories?: MemoryFact[]; total?: number; error?: string }>;
        updateMemory: (bankId: string, memoryId: string, patch: Record<string, unknown>) => Promise<IpcResult>;
        runGoldenSet: (bankId: string) => Promise<{ report?: MemoryGoldenReport; error?: string }>;
        deleteDocument: (bankId: string, documentId: string) => Promise<IpcResult>;
        retainManual: (sessionId: string, content: string) => Promise<IpcResult>;
        getProjectConfig: (projectId: string) => Promise<MemoryProjectConfig | { error: string }>;
        setProjectConfig: (projectId: string, patch: Partial<MemoryProjectConfig>) => Promise<MemoryProjectConfig | { error: string }>;
      };
      analytics: {
        /** Fire-and-forget analytics event via the main process PostHog client. */
        capture: (event: string, properties?: Record<string, unknown>) => void;
      };
      usage: {
        get: (days: UsageRange) => Promise<{ data?: UsageReport; error?: string }>;
        getSessionTokens: (sessionId: string) => Promise<{ data?: SessionTokenUsage; error?: string }>;
        activity: (start: number, end: number) => void;
      };
      shortcuts: { getStatus: () => Promise<OperationResult<ShortcutStatus[]>> };
      quickCapture: QuickCaptureApi;
      history: HistoryApi;
      speech: {
        /** Triggers macOS native dictation (Cocoa startDictation: selector). Returns { ok: false } on non-macOS. */
        startNativeDictation: () => Promise<{ ok: boolean; reason?: string }>;
        /** Returns the OS platform string (darwin, win32, linux) */
        getPlatform: () => Promise<string>;
        /** Requests microphone permission (macOS system dialog). Returns { granted } on all platforms. */
        requestMicPermission: () => Promise<{ granted: boolean }>;
      };
    };
  }
}
