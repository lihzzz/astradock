import type { UIMessage } from "@/types";
import type { CodexAgentCardData, CodexAgentDetails, CodexSubagentUpdate } from "@shared/types/codex-subagents";
import { codexAgentCallKey } from "@shared/lib/codex-subagents";

/** A restarted app-server may not know the name/model/task already saved in a
 * card. Missing metadata must not erase persisted information. */
function mergeAgent(previous: CodexAgentDetails | undefined, incoming: CodexAgentDetails): CodexAgentDetails {
  if (!previous) return incoming;
  if (incoming.updatedAt < previous.updatedAt) return previous;
  const keepResolvedModel = (previous.modelSource === "resolved" && incoming.modelSource !== "resolved")
    || (previous.modelSource === "configured" && (incoming.modelSource === "requested" || incoming.modelSource === null));
  return {
    ...incoming,
    nickname: incoming.nickname ?? previous.nickname,
    role: incoming.role ?? previous.role,
    model: keepResolvedModel ? previous.model : incoming.model ?? previous.model,
    modelSource: keepResolvedModel ? previous.modelSource : incoming.modelSource ?? previous.modelSource,
    reasoningEffort: keepResolvedModel ? previous.reasoningEffort : incoming.reasoningEffort ?? previous.reasoningEffort,
    task: incoming.task ?? previous.task,
    status: incoming.status === "unknown" ? previous.status : incoming.status,
    message: incoming.message ?? previous.message,
  };
}

function cardMessage(id: string, data: CodexAgentCardData, previous?: UIMessage): UIMessage {
  const call = data.call;
  const done = call ? call.completedAt !== null : data.agents.every((agent) =>
    ["completed", "errored", "shutdown", "notFound", "interrupted"].includes(agent.status));
  const failed = call ? call.status === "failed" : data.agents.some((agent) => agent.status === "errored");
  const objective = call?.prompt ?? data.agents.find((agent) => agent.task)?.task ?? "";
  return {
    ...previous, id, role: "tool_call", content: "", toolName: "CodexAgent",
    timestamp: previous?.timestamp ?? call?.startedAt ?? data.agents[0]?.updatedAt ?? 0,
    codexAgent: data,
    // Also retain useful plain data for existing copy/export/search paths.
    toolInput: { operation: call?.tool ?? "subAgentActivity", description: objective,
      model: data.agents[0]?.model ?? call?.requestedModel ?? undefined },
    toolResult: done ? { status: call?.status ?? data.agents[0]?.status,
      content: data.agents.map((agent) => agent.message).filter(Boolean).join("\n\n") } : undefined,
    toolError: failed || undefined,
  };
}

/** Only new cards are stream boundaries; status updates must not split the
 * parent's in-progress answer into a new bubble. */
export function startsCodexAgentCard(messages: UIMessage[], update: CodexSubagentUpdate): boolean {
  if (update.call) return true;
  const known = new Set(messages.flatMap((message) => message.codexAgent?.agents.map((agent) => agent.threadId) ?? []));
  return update.agents.some((agent) => !known.has(agent.threadId));
}

/** Shared immutable reducer for active and background sessions. All card data is
 * serialized with UIMessage; no React-local registry is lost on session switches.
 */
export function applyCodexSubagentUpdate(messages: UIMessage[], update: CodexSubagentUpdate): UIMessage[] {
  const agents = new Map<string, CodexAgentDetails>();
  for (const message of messages) {
    for (const agent of message.codexAgent?.agents ?? []) {
      const existing = agents.get(agent.threadId);
      if (!existing || agent.updatedAt > existing.updatedAt) agents.set(agent.threadId, agent);
    }
  }
  for (const agent of update.agents) agents.set(agent.threadId, mergeAgent(agents.get(agent.threadId), agent));
  const callId = update.call ? `codex-agent-call-${codexAgentCallKey(update.call)}` : null;
  const targets = new Set(update.call?.receiverThreadIds ?? []);
  const referenced = new Set<string>();
  let foundCall = false;
  let changed = false;
  const next: UIMessage[] = [];

  for (const message of messages) {
    const card = message.codexAgent;
    if (!card) { next.push(message); continue; }
    // Lifecycle metadata can precede the spawn item. Replace its temporary card
    // once a real call references it, without duplicating the agent in the list.
    if (!card.call && card.agents.some((agent) => targets.has(agent.threadId))) {
      changed = true;
      continue;
    }
    const isCall = message.id === callId;
    if (isCall) foundCall = true;
    const ids = isCall && update.call ? update.call.receiverThreadIds : card.agents.map((agent) => agent.threadId);
    const updatedAgents = ids.flatMap((id) => {
      referenced.add(id);
      const agent = agents.get(id);
      return agent ? [agent] : [];
    });
    if (isCall || updatedAgents.some((agent, index) => agent !== card.agents[index])) {
      next.push(cardMessage(message.id, { call: isCall ? update.call : card.call, agents: updatedAgents }, message));
      changed = true;
    } else next.push(message);
  }

  if (update.call && callId && !foundCall) {
    const targets = update.call.receiverThreadIds.flatMap((id) => {
      referenced.add(id);
      const agent = agents.get(id);
      return agent ? [agent] : [];
    });
    next.push(cardMessage(callId, { call: update.call, agents: targets }));
    changed = true;
  }
  for (const incoming of update.agents) {
    if (referenced.has(incoming.threadId)) continue;
    const agent = agents.get(incoming.threadId)!;
    next.push(cardMessage(`codex-agent-${agent.threadId}`, { call: null, agents: [agent] }));
    referenced.add(agent.threadId);
    changed = true;
  }
  return changed ? next : messages;
}
