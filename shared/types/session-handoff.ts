import type { WorkspaceBinding } from "./workspace";
import type { EngineId } from "./engine";
export interface PrepareHandoffInput {
  operationId: string; projectId: string; sourceSessionId: string; sourceCwd: string;
  objective: string; targetEngine: EngineId; targetModel: string;
  markdown: string; messageCount: number; lastMessageId: string;
}
export type HandoffState = "exported" | "target_created" | "dispatch_confirmed" | "dispatch_unknown";
export interface HandoffPacket {
  version: 1; operationId: string; projectId: string; sourceSessionId: string; createdAt: number;
  targetEngine: EngineId; targetModel: string; objective: string; acceptanceCriteria: string[];
  completed: string[]; remaining: string[]; blockers: string[];
  nextSteps: string[]; sourceRevision: number | null; historyOrigin: "visible_renderer_snapshot";
  verification: Array<{ messageId: string; toolName: string; observedAt: number }>;
  workspace: WorkspaceBinding; git: { head: string | null; branch: string | null; dirty: boolean | null };
  messageCount: number; lastMessageId: string; historyHash: string;
  state: HandoffState; targetConversationId: string | null;
}
export interface PreparedHandoff { packet: HandoffPacket; filePath: string; packetPath: string }
export type HandoffResult = { value: PreparedHandoff; error?: never } | { error: string; value?: never };
