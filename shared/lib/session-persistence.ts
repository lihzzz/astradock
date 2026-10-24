/**
 * Pure session persistence helpers shared between Electron and CLI.
 */

import { parseThreadGoal } from "./codex-goal";
import type { ProjectAppSessionOrigin, WorkspaceBinding } from "../types/workspace";

export interface SessionMetadataPatch {
  title?: string; model?: string; effort?: string; permissionMode?: string; planMode?: boolean;
  archived?: boolean; pinned?: boolean; folderId?: string | null; branch?: string | null;
  codexGoal?: import("../types/codex-protocol/v2/ThreadGoal").ThreadGoal | null;
}

export interface SessionMeta {
  persistenceRevision?: number;
  workspaceBinding?: WorkspaceBinding;
  origin?: ProjectAppSessionOrigin;
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
    persistenceRevision: typeof data.persistenceRevision === "number" ? data.persistenceRevision : 0,
    workspaceBinding: parseWorkspaceBinding(data.workspaceBinding),
    origin: parseSessionOrigin(data.origin),
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
  };
}

/** Corrupt bindings must fail visibly instead of restoring in a different directory. */
function parseWorkspaceBinding(value: unknown): WorkspaceBinding | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null
    || !("projectId" in value) || typeof value.projectId !== "string"
    || !("rootKind" in value) || (value.rootKind !== "project" && value.rootKind !== "worktree")
    || !("rootPath" in value) || typeof value.rootPath !== "string"
    || !("repoCommonDir" in value) || (value.repoCommonDir !== null && typeof value.repoCommonDir !== "string")
    || !("relativeCwd" in value) || typeof value.relativeCwd !== "string") {
    throw new Error("The conversation workspace binding is invalid. Rebind its application directory before continuing.");
  }
  return { projectId: value.projectId, rootKind: value.rootKind, rootPath: value.rootPath,
    repoCommonDir: value.repoCommonDir, relativeCwd: value.relativeCwd };
}

function parseSessionOrigin(value: unknown): ProjectAppSessionOrigin | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "project-app"
    || !("appId" in value) || typeof value.appId !== "string"
    || !("runId" in value) || (value.runId !== null && typeof value.runId !== "string")) {
    throw new Error("The conversation application origin is invalid.");
  }
  return { kind: "project-app", appId: value.appId, runId: value.runId };
}
