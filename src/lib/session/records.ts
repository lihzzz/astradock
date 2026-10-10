import type { SessionMeta as SessionListItem } from "@shared/lib/session-persistence";
import type { ChatSession, ClaudeEffort, ContextUsage, PersistedSession, UIMessage } from "@/types";

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "max"]);
function toClaudeEffort(value: string | undefined): ClaudeEffort | undefined {
  return value && VALID_EFFORTS.has(value) ? (value as ClaudeEffort) : undefined;
}

export function toChatSession(
  session: SessionListItem,
  isActive: boolean,
): ChatSession {
  return {
    id: session.id,
    conversationId: session.conversationId ?? session.id,
    workspaceBinding: session.workspaceBinding,
    origin: session.origin,
    projectId: session.projectId,
    title: session.title,
    createdAt: session.createdAt,
    lastMessageAt: session.lastMessageAt || session.createdAt,
    model: session.model,
    effort: toClaudeEffort(session.effort),
    permissionMode: session.permissionMode,
    // Plan mode was removed -- normalize legacy persisted sessions to off.
    planMode: false,
    totalCost: session.totalCost ?? 0,
    isActive,
    engine: session.engine,
    codexThreadId: session.codexThreadId,
    folderId: session.folderId,
    pinned: session.pinned,
    archived: session.archived,
    branch: session.branch,
    agentId: session.agentId,
    agentSessionId: session.agentSessionId,
    codexGoal: session.codexGoal,
  };
}

export function buildPersistedSession(
  session: ChatSession,
  messages: UIMessage[],
  totalCost: number,
  contextUsage: ContextUsage | null,
): PersistedSession {
  return {
    id: session.id,
    conversationId: session.conversationId ?? session.id,
    workspaceBinding: session.workspaceBinding,
    origin: session.origin,
    projectId: session.projectId,
    title: session.title,
    createdAt: session.createdAt,
    messages,
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    planMode: session.planMode,
    totalCost,
    contextUsage,
    engine: session.engine,
    folderId: session.folderId,
    pinned: session.pinned,
    archived: session.archived,
    branch: session.branch,
    ...(session.agentId ? { agentId: session.agentId } : {}),
    ...(session.agentSessionId ? { agentSessionId: session.agentSessionId } : {}),
    ...(session.engine === "codex" && session.codexThreadId ? { codexThreadId: session.codexThreadId } : {}),
    ...(session.engine === "codex" ? { codexGoal: session.codexGoal ?? null } : {}),
  };
}
