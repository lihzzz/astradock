import path from "path";
import { fileURLToPath } from "url";
import type { EngineId } from "../types/engine";
import type {
  CollaborationCall,
  CollaborationContributeRequest,
  CollaborationGroup,
  CollaborationMember,
  CollaborationTurnPlan,
  CollaborationWorkspace,
  SessionCollaboration,
} from "../types/collaboration";

const ENGINES = new Set<EngineId>(["claude", "acp", "codex"]);
const MAX_NAME_LENGTH = 40;
const MAX_CONTEXT_CHARS = 3500;
const MAX_MESSAGE_CHARS = 700;
const MAX_TASK_CHARS = 12000;

export type CollaborationGroupError = "name" | "members" | "duplicate";

export function createCollaborationGroup(
  name: string,
  members: Array<Omit<CollaborationMember, "id">>,
  options?: { id?: string; now?: number; createId?: () => string },
): { ok: true; group: CollaborationGroup } | { ok: false; error: CollaborationGroupError } {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: "name" };
  if (members.length < 2) return { ok: false, error: "members" };

  const createId = options?.createId ?? (() => `member-${Math.random().toString(36).slice(2, 10)}`);
  const normalized: CollaborationMember[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    const next = normalizeMember({ ...member, id: createId() });
    if (!next) return { ok: false, error: "members" };
    const key = workerKey(next);
    if (seen.has(key)) return { ok: false, error: "duplicate" };
    seen.add(key);
    normalized.push(next);
  }

  const now = options?.now ?? Date.now();
  return {
    ok: true,
    group: {
      id: options?.id ?? `group-${createId()}`,
      name: trimmed,
      members: normalized,
      createdAt: now,
      updatedAt: now,
    },
  };
}

export function attachCollaboration(group: CollaborationGroup, attachedAt = Date.now()): SessionCollaboration {
  return {
    groupId: group.id,
    name: group.name,
    members: group.members.map((member) => ({ ...member })),
    attachedAt,
  };
}

export function parseSessionCollaboration(value: unknown): SessionCollaboration | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.groupId !== "string" || !record.groupId) return undefined;
  if (typeof record.name !== "string" || !record.name.trim()) return undefined;
  if (!Array.isArray(record.members) || record.members.length === 0) return undefined;

  const members: CollaborationMember[] = [];
  for (const entry of record.members) {
    const member = parseMember(entry);
    if (!member) return undefined;
    members.push(member);
  }

  return {
    groupId: record.groupId,
    name: record.name.trim(),
    members,
    attachedAt: typeof record.attachedAt === "number" ? record.attachedAt : 0,
  };
}

export function parseCollaborationGroups(value: unknown): CollaborationGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: CollaborationGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const attached = parseSessionCollaboration({
      groupId: record.id,
      name: record.name,
      members: record.members,
      attachedAt: record.createdAt,
    });
    if (!attached || typeof record.id !== "string") continue;
    const createdAt = typeof record.createdAt === "number" ? record.createdAt : 0;
    groups.push({
      id: record.id,
      name: attached.name,
      members: attached.members,
      createdAt,
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : createdAt,
    });
  }
  return groups;
}

/** Slash commands stay on the single-agent path. */
export function isDirectCommand(text: string): boolean {
  return /^\s*\//.test(text);
}

export function recentCollaborationContext(
  messages: Array<{ role?: string; content?: string }>,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = (message.content ?? "").trim();
    if (!content) continue;
    const clipped = content.length > MAX_MESSAGE_CHARS
      ? `${content.slice(0, MAX_MESSAGE_CHARS)}…`
      : content;
    lines.push(`${message.role}: ${clipped}`);
  }
  const joined = lines.join("\n");
  if (joined.length <= MAX_CONTEXT_CHARS) return joined;
  return joined.slice(joined.length - MAX_CONTEXT_CHARS);
}

export function planCollaborationTurn(input: {
  collaboration: SessionCollaboration;
  workspace: CollaborationWorkspace;
  userText: string;
  recentContext?: string;
  hasImages?: boolean;
}): CollaborationTurnPlan | null {
  if (isDirectCommand(input.userText)) return null;
  const calls: CollaborationCall[] = [];
  for (const member of input.collaboration.members) {
    if (isSameWorker(member, input.workspace)) continue;
    calls.push({
      member,
      prompt: buildCollaboratorPrompt(input.collaboration.name, member, input.workspace, input.userText, input.recentContext ?? "", !!input.hasImages),
    });
  }
  if (calls.length === 0) return null;

  return {
    groupId: input.collaboration.groupId,
    groupName: input.collaboration.name,
    leadPrompt: buildLeadPrompt(input.collaboration.name, calls, input.userText),
    calls,
  };
}

export function buildIntegrationPrompt(
  groupName: string,
  contributions: Array<{ member: CollaborationMember; content: string }>,
): string {
  const sections = contributions.map((entry) => {
    const model = entry.member.model?.trim();
    const who = `${entry.member.name} (${entry.member.engine}${model ? `, ${model}` : ""})`;
    return `## ${who}\n${clip(entry.content.trim(), 8000)}`;
  });
  return [
    `Collaboration group "${groupName}" finished a parallel pass. Integrate the useful parts and continue the task.`,
    `You are the only member who should change files. If a suggestion conflicts with work already done, keep the better result and say why.`,
    "",
    ...sections,
  ].join("\n");
}

export const INTEGRATION_DISPLAY_TEXT = "Integrate group contributions";

export function toContributeRequest(call: CollaborationCall, cwd: string): CollaborationContributeRequest {
  return {
    engine: call.member.engine,
    agentId: call.member.agentId,
    model: call.member.model,
    cwd,
    prompt: call.prompt,
  };
}

export function parseContributeRequest(value: unknown): CollaborationContributeRequest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const engine = record.engine;
  if (engine !== "claude" && engine !== "acp" && engine !== "codex") return null;
  if (typeof record.agentId !== "string" || !record.agentId.trim()) return null;
  if (typeof record.cwd !== "string" || !record.cwd.trim()) return null;
  if (typeof record.prompt !== "string" || !record.prompt.trim()) return null;
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return {
    engine,
    agentId: record.agentId.trim(),
    cwd: record.cwd,
    prompt: record.prompt,
    ...(model ? { model } : {}),
  };
}

export function resolveClaudeContributionModel(model?: string): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed || trimmed === "default") return "sonnet";
  return trimmed;
}

export function assistantTextFromEvent(event: Record<string, unknown>): string {
  const message = event.message;
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") text += record.text;
  }
  return text;
}

export function confineToWorkspace(cwd: string, requested: string): string {
  const raw = requested.startsWith("file://") ? fileURLToPath(requested) : requested;
  const root = path.resolve(cwd);
  const target = path.resolve(root, raw);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Path is outside the workspace");
  }
  return target;
}

export function chooseContributionText(assistantText: string, resultText: string): string {
  const assistant = assistantText.trim();
  const result = resultText.trim();
  if (!assistant) return result;
  if (!result) return assistant;
  return result.length > assistant.length ? result : assistant;
}

function buildLeadPrompt(groupName: string, calls: CollaborationCall[], userText: string): string {
  const teammates = calls.map((call) => {
    const model = call.member.model?.trim();
    return `- ${call.member.name} (${call.member.engine}${model ? `, ${model}` : ""})`;
  }).join("\n");
  return [
    `You are the lead in collaboration group "${groupName}".`,
    "These teammates are working on the same task in parallel and were asked not to edit files:",
    teammates,
    "Make progress on the request now. A follow-up message will include their contributions for you to integrate.",
    "",
    userText,
  ].join("\n");
}

function buildCollaboratorPrompt(
  groupName: string,
  member: CollaborationMember,
  workspace: CollaborationWorkspace,
  userText: string,
  recentContext: string,
  hasImages: boolean,
): string {
  const model = member.model?.trim();
  const lines = [
    `You are ${member.name}, a collaborator in the group "${groupName}".`,
    `Your engine is ${member.engine}${model ? ` and your model is ${model}` : ""}.`,
    `The lead (${workspace.engine}) is implementing this task in the workspace. Do not create, edit, or delete files.`,
    "Read the workspace when you can. Return a concrete contribution: the approach you recommend, the risks, and the specific changes the lead should make.",
  ];
  if (hasImages) {
    lines.push("The user also attached images. Only the lead can see them, so call out anything that depends on those images.");
  }
  if (recentContext.trim()) {
    lines.push("", "Recent conversation:", recentContext.trim());
  }
  lines.push("", "Task:", clip(userText, MAX_TASK_CHARS));
  return lines.join("\n");
}

function isSameWorker(member: CollaborationMember, workspace: CollaborationWorkspace): boolean {
  if (member.engine !== workspace.engine) return false;
  if (member.agentId !== workspaceAgentId(workspace)) return false;
  return modelKey(member.model) === modelKey(workspace.model);
}

function workspaceAgentId(workspace: CollaborationWorkspace): string {
  if (workspace.agentId?.trim()) return workspace.agentId.trim();
  if (workspace.engine === "codex") return "codex";
  if (workspace.engine === "claude") return "claude-code";
  return "";
}

function modelKey(model?: string): string {
  const value = model?.trim() ?? "";
  return value === "default" ? "" : value;
}

function workerKey(member: CollaborationMember): string {
  return `${member.engine}\u0000${member.agentId}\u0000${modelKey(member.model)}`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated]`;
}

function normalizeMember(member: CollaborationMember): CollaborationMember | null {
  if (!ENGINES.has(member.engine)) return null;
  const agentId = member.agentId.trim();
  const name = member.name.trim();
  if (!agentId || !name) return null;
  const model = member.model?.trim();
  return {
    id: member.id,
    agentId,
    engine: member.engine,
    name,
    ...(model ? { model } : {}),
  };
}

function parseMember(value: unknown): CollaborationMember | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.agentId !== "string" || typeof record.name !== "string") return null;
  if (record.engine !== "claude" && record.engine !== "acp" && record.engine !== "codex") return null;
  return normalizeMember({
    id: record.id,
    agentId: record.agentId,
    engine: record.engine,
    name: record.name,
    model: typeof record.model === "string" ? record.model : undefined,
  });
}
