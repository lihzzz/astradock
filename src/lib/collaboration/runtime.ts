import type { EngineId } from "@shared/types/engine";
import type { CollaborationContributeRequest, CollaborationMember, CollaborationTurnPlan } from "@shared/types/collaboration";
import { buildIntegrationPrompt, INTEGRATION_DISPLAY_TEXT, toContributeRequest } from "@shared/lib/collaboration";
import type { UIMessage } from "@/types";

export interface CollaborationMemberStatus {
  id: string;
  name: string;
  engine: EngineId;
  status: "working" | "done" | "error";
}

export interface CollaborationRuntimeDeps {
  cwd: string;
  contribute: (request: CollaborationContributeRequest) => Promise<{ result?: string; error?: string }>;
  appendMessages: (messages: UIMessage[]) => void;
  sendIntegration: (text: string, displayText: string) => Promise<void>;
  onStatus?: (members: CollaborationMemberStatus[]) => void;
  now?: () => number;
  createId?: () => string;
  isCancelled?: () => boolean;
}

interface ContributionOutcome {
  member: CollaborationMember;
  content?: string;
  error?: string;
}

/** Run collaborator turns, post them into the transcript, then ask the lead to integrate. */
export async function executeCollaborationTurn(
  plan: CollaborationTurnPlan,
  deps: CollaborationRuntimeDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const createId = deps.createId ?? (() => crypto.randomUUID());
  const statuses: CollaborationMemberStatus[] = plan.calls.map((call) => ({
    id: call.member.id,
    name: call.member.name,
    engine: call.member.engine,
    status: "working",
  }));
  deps.onStatus?.(statuses.map((status) => ({ ...status })));

  if (deps.isCancelled?.()) return;
  deps.appendMessages([systemMessage(
    `Collaboration group "${plan.groupName}" joined this turn (${plan.calls.length} ${plan.calls.length === 1 ? "collaborator" : "collaborators"}).`,
    now(),
    createId(),
  )]);

  const outcomes = await Promise.all(plan.calls.map(async (call, index): Promise<ContributionOutcome> => {
    try {
      const response = await deps.contribute(toContributeRequest(call, deps.cwd));
      const content = response.result?.trim();
      const error = content ? undefined : (response.error?.trim() || "The collaborator returned an empty response.");
      statuses[index] = { ...statuses[index], status: error ? "error" : "done" };
      deps.onStatus?.(statuses.map((status) => ({ ...status })));
      return error ? { member: call.member, error } : { member: call.member, content };
    } catch (err) {
      statuses[index] = { ...statuses[index], status: "error" };
      deps.onStatus?.(statuses.map((status) => ({ ...status })));
      return {
        member: call.member,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));

  if (deps.isCancelled?.()) return;

  const messages: UIMessage[] = [];
  const contributions: Array<{ member: CollaborationMember; content: string }> = [];
  for (const outcome of outcomes) {
    if (outcome.content) {
      contributions.push({ member: outcome.member, content: outcome.content });
      messages.push(contributionMessage(plan, outcome.member, outcome.content, now(), createId()));
    } else {
      messages.push(systemMessage(
        `${outcome.member.name} could not contribute: ${outcome.error ?? "Unknown error"}`,
        now(),
        createId(),
        true,
      ));
    }
  }
  deps.appendMessages(messages);

  if (contributions.length === 0 || deps.isCancelled?.()) return;
  await deps.sendIntegration(
    buildIntegrationPrompt(plan.groupName, contributions),
    INTEGRATION_DISPLAY_TEXT,
  );
}

function systemMessage(content: string, timestamp: number, id: string, isError = false): UIMessage {
  return {
    id: `collab-sys-${id}`,
    role: "system",
    content,
    timestamp,
    ...(isError ? { isError: true } : {}),
  };
}

function contributionMessage(
  plan: CollaborationTurnPlan,
  member: CollaborationMember,
  content: string,
  timestamp: number,
  id: string,
): UIMessage {
  return {
    id: `collab-${id}`,
    role: "assistant",
    content,
    timestamp,
    collaboration: {
      groupId: plan.groupId,
      groupName: plan.groupName,
      memberId: member.id,
      memberName: member.name,
      engine: member.engine,
      ...(member.model ? { model: member.model } : {}),
      status: "completed",
    },
  };
}
