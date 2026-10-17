/** Stable UI contract, normalized from old and new Codex app-server schemas.
 * Keep this compatibility layer separate from generated protocol files.
 */
export type CodexAgentStatus =
  | "pendingInit" | "running" | "interrupted" | "completed"
  | "errored" | "shutdown" | "notFound" | "unknown";

export type CodexAgentCallStatus = "inProgress" | "completed" | "failed" | "interrupted" | "unknown";

export interface CodexAgentDetails {
  threadId: string;
  parentThreadId: string;
  nickname: string | null;
  role: string | null;
  model: string | null;
  modelSource: "requested" | "configured" | "resolved" | null;
  reasoningEffort: string | null;
  task: string | null;
  status: CodexAgentStatus;
  message: string | null;
  updatedAt: number;
}

export interface CodexAgentCall {
  itemId: string;
  threadId: string;
  turnId: string;
  /** Preserve unknown future operations instead of silently dropping them. */
  tool: string;
  status: CodexAgentCallStatus;
  receiverThreadIds: string[];
  prompt: string | null;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface CodexSubagentUpdate {
  call: CodexAgentCall | null;
  agents: CodexAgentDetails[];
}

/** Stored on UIMessage so reloads and foreground/background transfers keep the card. */
export interface CodexAgentCardData {
  call: CodexAgentCall | null;
  agents: CodexAgentDetails[];
}

export interface CodexSubagentNotification {
  method: "codex:subagent";
  params: CodexSubagentUpdate;
}
