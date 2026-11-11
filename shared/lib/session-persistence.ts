/**
 * Pure session persistence helpers shared between Electron and CLI.
 */

import { parseThreadGoal } from "./codex-goal";
import { parseSessionCollaboration } from "./collaboration";
import type { SessionCollaboration } from "../types/collaboration";

export interface SessionMeta {
  conversationId?: string;
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  /** Timestamp of the most recent user message — used for sidebar sort order */
  lastMessageAt: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
  planMode?: boolean;
  totalCost?: number;
  engine?: "claude" | "acp" | "codex";
  codexThreadId?: string;
  /** Which folder this chat belongs to (undefined = root level). */
  folderId?: string;
  /** Whether this chat is pinned to the top of the sidebar. */
  pinned?: boolean;
  /** Whether this chat is hidden from the active sidebar list. */
  archived?: boolean;
  /** Git branch at session creation time. */
  branch?: string;
  /** Agent ID — which agent was used for this session. */
  agentId?: string;
  /** ACP-side session ID used to restore the agent conversation. */
  agentSessionId?: string;
  codexGoal?: import("../types/codex-protocol/v2/ThreadGoal").ThreadGoal | null;
  /** Collaboration group attached to this conversation, if any. */
  collaboration?: SessionCollaboration;
}

/**
 * Walk messages backward to find the timestamp of the last user message.
 */
export function getLastUserMessageTimestamp(
  messages?: Array<{ role?: string; timestamp?: number }>,
): number | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user" && typeof msg.timestamp === "number") return msg.timestamp;
  }
  return undefined;
}

/**
 * Extract a SessionMeta from a raw session data object.
 */
export function extractSessionMeta(data: Record<string, unknown>, lastMessageAt: number): SessionMeta {
  return {
    id: data.id as string,
    conversationId: data.conversationId as string | undefined,
    projectId: data.projectId as string,
    title: (data.title as string) || "Untitled",
    createdAt: (data.createdAt as number) || 0,
    lastMessageAt,
    model: data.model as string | undefined,
    effort: data.effort as string | undefined,
    permissionMode: data.permissionMode as string | undefined,
    planMode: data.planMode as boolean | undefined,
    totalCost: (data.totalCost as number) || 0,
    engine: data.engine as SessionMeta["engine"],
    codexThreadId: data.codexThreadId as string | undefined,
    folderId: data.folderId as string | undefined,
    pinned: data.pinned as boolean | undefined,
    archived: data.archived as boolean | undefined,
    branch: data.branch as string | undefined,
    agentId: data.agentId as string | undefined,
    agentSessionId: data.agentSessionId as string | undefined,
    codexGoal: data.codexGoal === null || data.codexGoal === undefined
      ? null
      : parseThreadGoal(data.codexGoal),
    collaboration: parseSessionCollaboration(data.collaboration),
  };
}
