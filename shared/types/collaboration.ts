import type { EngineId } from "./engine";

/** A member of a saved collaboration group. */
export interface CollaborationMember {
  id: string;
  agentId: string;
  engine: EngineId;
  /** Display name captured when the group was saved. */
  name: string;
  /** Optional model override. Empty means the engine default. */
  model?: string;
}

/** A reusable set of agents and models the user can pull into a chat. */
export interface CollaborationGroup {
  id: string;
  name: string;
  members: CollaborationMember[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Snapshot stored on a session when a group is pulled in.
 * Later edits to the saved group do not change an attached chat until it is pulled again.
 */
export interface SessionCollaboration {
  groupId: string;
  name: string;
  members: CollaborationMember[];
  attachedAt: number;
}

/** The session that owns the workspace and implements the task. */
export interface CollaborationWorkspace {
  engine: EngineId;
  agentId?: string;
  model?: string;
}

export interface CollaborationContributeRequest {
  engine: EngineId;
  agentId: string;
  model?: string;
  cwd: string;
  prompt: string;
}

export interface CollaborationCall {
  member: CollaborationMember;
  prompt: string;
}

export interface CollaborationTurnPlan {
  groupId: string;
  groupName: string;
  leadPrompt: string;
  calls: CollaborationCall[];
}
