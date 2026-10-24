/** SiYuan is the only live memory backend. No note bodies are persisted here. */
export type MemoryScope = "project" | "personal";
export type MemoryKind = "preference" | "convention" | "decision" | "troubleshooting" | "procedure" | "correction";
export interface MemoryReadScope { notebookId: string; documentId: string; includeDescendants: boolean }
export interface MemorySettings {
  schemaVersion: 2; enabled: boolean; baseUrl: string; expectedWorkspacePath: string;
  identityAnchorDocumentId: string; personalReadEnabled: boolean; personalAutoWriteEnabled: boolean;
  personalSummaryBlockIds: string[]; personalReadScopes: MemoryReadScope[]; personalWriteDocumentId: string;
}
export interface MemoryProjectConfig {
  schemaVersion: 2; enabled: boolean; revision: number; summaryBlockIds: string[];
  readScopes: MemoryReadScope[]; writeDocumentId: string; includePersonalMemory: boolean;
}
export type MemoryConnectionState = "unconfigured" | "connecting" | "ready" | "unavailable" | "auth-required" | "incompatible" | "workspace-mismatch" | "binding-invalid";
export interface MemoryStatusResult { state: MemoryConnectionState; message: string; version?: string; workspacePath?: string; hasToken: boolean }
export interface MemoryRecallItem { ref: string; blockId: string; text: string; scope: MemoryScope; hash: string; readAt: number }
export interface MemoryRecallState { items: MemoryRecallItem[]; usedAt: number | null; skipNext: boolean; status: string }
export type MemoryWriteState = "prepared" | "submitted" | "verified" | "unknown" | "conflict" | "rejected" | "changed";
export interface MemoryWriteRecord {
  operationId: string; projectId: string; sessionId: string; turnId: string; target: string; scope: MemoryScope;
  workspace: string; endpoint: string; anchor: string; hash: string; kind: MemoryKind; state: MemoryWriteState;
  createdAt: number; updatedAt: number; blockId?: string;
}
export type MemoryResult<T> = { value: T; error?: never } | { error: string; value?: never };
export interface MemoryEvent { projectId: string; message: string; level: "info" | "warning" }
export interface MemoryApi {
  onEvent(listener: (event: MemoryEvent) => void): () => void;
  getStatus(): Promise<MemoryStatusResult>;
  probe(baseUrl: string): Promise<MemoryResult<{ workspacePath: string; version: string }>>;
  setToken(token: string): Promise<MemoryResult<{ persistent: boolean }>>;
  getProjectConfig(projectId: string): Promise<MemoryResult<MemoryProjectConfig>>;
  setProjectConfig(projectId: string, config: MemoryProjectConfig): Promise<MemoryResult<MemoryProjectConfig>>;
  sessionRecall(sessionId: string): Promise<MemoryResult<MemoryRecallState | null>>;
  skipNextRecall(sessionId: string, skip: boolean): Promise<MemoryResult<null>>;
  rememberSession(sessionId: string, text: string): Promise<MemoryResult<MemoryWriteRecord>>;
  remember(projectId: string, text: string, scope: MemoryScope): Promise<MemoryResult<MemoryWriteRecord>>;
  writes(projectId: string): Promise<MemoryResult<MemoryWriteRecord[]>>;
  reconcile(projectId: string, operationId: string): Promise<MemoryResult<MemoryWriteRecord>>;
}
