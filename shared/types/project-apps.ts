import type { EngineId } from "./engine";
import type { OperationError, OperationResult } from "./productivity";
import type { ProjectAppSessionOrigin, WorkspaceBinding } from "./workspace";
import type { ProjectAppAgentPermissionEvent, ProjectAppAgentPermissionRequest, ProjectAppAgentPermissionResponse } from "./project-app-agent";

export type AppCommand =
  | { kind: "package-script"; manager: "pnpm" | "npm" | "yarn" | "bun"; script: string; args: string[] }
  | { kind: "executable"; executable: string; args: string[] };
export type AppPortPolicy = { kind: "none" } | { kind: "fixed"; port: number } | { kind: "auto"; preferred: number };
export type AppReadiness = { kind: "process" } | { kind: "http"; path: string; acceptedStatuses: number[] };
export interface AppLaunchProfile {
  command: AppCommand;
  adapter: "generic" | "vite" | "next";
  env: Record<string, string>;
  port: AppPortPolicy;
  previewUrl: string;
  readiness: AppReadiness;
  startupTimeoutMs: number;
}
interface AppPresentation {
  name: string;
  icon: string;
  iconType: "emoji" | "lucide";
  favorite: boolean;
  folder: string;
  order: number;
}
export type ProjectAppInput = AppPresentation & (
  | { kind: "managed"; projectId: string; workspace: WorkspaceBinding; launch: AppLaunchProfile }
  | { kind: "web"; spaceId: string; url: string }
);
export type ProjectApp = ProjectAppInput & {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
};
export type AppProcessPhase = "starting" | "running" | "stopping" | "stopped" | "failed" | "interrupted";
export type AppHealth = "unknown" | "checking" | "ready" | "unhealthy";
export interface AppRun {
  runId: string;
  appId: string;
  configRevision: number;
  workspace: WorkspaceBinding;
  launch: AppLaunchProfile;
  phase: AppProcessPhase;
  health: AppHealth;
  pid: number | null;
  port: number | null;
  url: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  error: OperationError | null;
  cleanupPending: boolean;
}
export interface AppLogEntry { seq: number; timestamp: number; stream: "stdout" | "stderr" | "system"; text: string }
export interface AppLogPage { runId: string; entries: AppLogEntry[]; nextSeq: number; truncated: boolean }
export interface AppCatalogSnapshot { revision: number; apps: ProjectApp[]; runs: AppRun[]; errors: OperationError[]; workspaceErrors: Record<string, OperationError> }
export type AppEvent =
  | { kind: "catalog"; snapshot: AppCatalogSnapshot }
  | { kind: "run"; revision: number; run: AppRun }
  | { kind: "logs"; page: AppLogPage };
export interface AppDiscoveryCandidate { label: string; reason: string; launch: AppLaunchProfile }
export interface AppDiscovery { workspace: WorkspaceBinding; candidates: AppDiscoveryCandidate[]; warnings: string[] }
export interface AppSessionLink {
  appId: string;
  projectId: string;
  conversationId: string;
  engine: EngineId;
  workspace: WorkspaceBinding;
  createdAt: number;
}
export interface PreparedAppContext {
  appId: string;
  appName: string;
  workspaceBinding: WorkspaceBinding;
  origin: ProjectAppSessionOrigin;
  text: string;
}
export interface AppSaveRequest { id: string | null; expectedRevision: number | null; definition: ProjectAppInput }
export interface AppStartRequest { appId: string; expectedRevision: number; workspace: WorkspaceBinding; requestId: string }
export interface AppStopRequest { runId: string; requestId: string }
export interface AppRestartRequest extends AppStopRequest { expectedRevision: number }
export interface AppContextRequest { appId: string; runId: string | null; workspace: WorkspaceBinding | null; includeLogs: boolean }

export interface ProjectAppsApi {
  pendingAgentPermissions(): Promise<OperationResult<ProjectAppAgentPermissionRequest[]>>;
  respondAgentPermission(response: ProjectAppAgentPermissionResponse): Promise<OperationResult<null>>;
  onAgentPermission(listener: (event: ProjectAppAgentPermissionEvent) => void): () => void;
  list(): Promise<OperationResult<AppCatalogSnapshot>>;
  markUsed(appId: string): Promise<OperationResult<null>>;
  workspaces(projectId: string): Promise<OperationResult<WorkspaceBinding[]>>;
  validateWorkspace(workspace: WorkspaceBinding): Promise<OperationResult<{ workspace: WorkspaceBinding; cwd: string }>>;
  discover(workspace: WorkspaceBinding): Promise<OperationResult<AppDiscovery>>;
  save(request: AppSaveRequest): Promise<OperationResult<ProjectApp>>;
  remove(request: { appId: string; expectedRevision: number }): Promise<OperationResult<null>>;
  start(request: AppStartRequest): Promise<OperationResult<AppRun>>;
  stop(request: AppStopRequest): Promise<OperationResult<AppRun>>;
  restart(request: AppRestartRequest): Promise<OperationResult<AppRun>>;
  logs(request: { runId: string; afterSeq: number; limit: number }): Promise<OperationResult<AppLogPage>>;
  prepareContext(request: AppContextRequest): Promise<OperationResult<PreparedAppContext>>;
  links(appId: string): Promise<OperationResult<AppSessionLink[]>>;
  linkSession(link: AppSessionLink): Promise<OperationResult<null>>;
  exportConfig(appIds: string[]): Promise<OperationResult<string>>;
  importConfig(request: { content: string; projectId: string | null; spaceId: string }): Promise<OperationResult<ProjectApp[]>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
