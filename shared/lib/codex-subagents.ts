import type {
  CodexAgentCall, CodexAgentCallStatus, CodexAgentDetails, CodexAgentStatus, CodexSubagentUpdate,
} from "../types/codex-subagents";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function timestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function agentStatus(value: unknown): CodexAgentStatus {
  switch (value) {
    case "pendingInit": case "running": case "interrupted": case "completed":
    case "errored": case "shutdown": case "notFound": return value;
    default: return "unknown";
  }
}
function callStatus(value: unknown, completed: boolean): CodexAgentCallStatus {
  switch (value) {
    case "inProgress": case "completed": case "failed": case "interrupted": return value;
    default: return value == null ? (completed ? "completed" : "inProgress") : "unknown";
  }
}
export function codexAgentCallKey(call: Pick<CodexAgentCall, "threadId" | "turnId" | "itemId">): string {
  return JSON.stringify([call.threadId, call.turnId, call.itemId]);
}
export function codexNotificationThreadId(method: string, params: Record<string, unknown>): string | null {
  if (method === "thread/started" && record(params.thread)) return text(params.thread.id);
  return text(params.threadId);
}
export function isCodexSubagentItem(method: string, params: Record<string, unknown>): boolean {
  return (method === "item/started" || method === "item/completed") && record(params.item)
    && (params.item.type === "collabAgentToolCall" || params.item.type === "subAgentActivity");
}

/** One tracker per app-server connection. Metadata arriving before spawn completion
 * stays here, independently of which conversation the renderer is currently viewing.
 * No child thread is resumed, spawned or subscribed to merely to display a card.
 */
export class CodexSubagentTracker {
  private agents = new Map<string, CodexAgentDetails>();
  private calls = new Map<string, CodexAgentCall>();
  private activities = new Map<string, { model: string | null; effort: string | null }>();

  constructor(private readonly rootThreadId: () => string | null) {}

  private owns(threadId: string): boolean {
    return threadId === this.rootThreadId() || this.agents.has(threadId);
  }

  private updateAgent(threadId: string, parentThreadId: string, patch: Partial<CodexAgentDetails>, at: number): CodexAgentDetails {
    const previous = this.agents.get(threadId);
    if (previous && at < previous.updatedAt) return previous;
    // Agent updates use receive time consistently. Mixing server item timestamps
    // with metadata receipt time can discard resolved models arriving in a batch.
    const next: CodexAgentDetails = {
      threadId, parentThreadId, nickname: null, role: null, model: null, modelSource: null,
      reasoningEffort: null, task: null, status: "unknown", message: null,
      ...previous, ...patch, updatedAt: at,
    };
    this.agents.set(threadId, next);
    return next;
  }

  observe(method: string, params: Record<string, unknown>, now = Date.now()): CodexSubagentUpdate | null {
    if (method === "thread/started" && record(params.thread)) {
      const thread = params.thread;
      const source = record(thread.source) && record(thread.source.subAgent) ? thread.source.subAgent : null;
      const spawn = source && record(source.thread_spawn) ? source.thread_spawn : null;
      const parent = text(thread.parentThreadId) ?? text(spawn?.parent_thread_id);
      const id = text(thread.id);
      if (!id || !parent || !this.owns(parent)) return null;
      const nickname = text(thread.agentNickname) ?? text(spawn?.agent_nickname);
      const role = text(thread.agentRole) ?? text(spawn?.agent_role);
      const model = text(thread.model);
      const effort = text(thread.reasoningEffort);
      const resolved = this.agents.get(id)?.modelSource === "resolved";
      return { call: null, agents: [this.updateAgent(id, parent, {
        ...(nickname ? { nickname } : {}), ...(role ? { role } : {}),
        // Thread.model is configured metadata, not per-turn execution telemetry.
        ...(!resolved && model ? { model, modelSource: "configured" } : {}),
        ...(!resolved && effort ? { reasoningEffort: effort } : {}),
      }, now)] };
    }

    const threadId = text(params.threadId);
    if (!threadId || !this.owns(threadId)) return null;
    const item = record(params.item) ? params.item : null;
    const completed = method === "item/completed";
    const at = timestamp(completed ? params.completedAtMs : params.startedAtMs, now);

    if ((method === "item/started" || completed) && item?.type === "collabAgentToolCall") {
      const itemId = text(item.id);
      const tool = text(item.tool);
      const sender = text(item.senderThreadId) ?? threadId;
      if (!itemId || !tool || sender !== threadId) return null;
      const key = codexAgentCallKey({ threadId, turnId: text(params.turnId) ?? "", itemId });
      const previous = this.calls.get(key);
      // Replayed starts/completions must not regress a newer agent lifecycle.
      if (previous?.completedAt != null) return null;
      const states = record(item.agentsStates) ? item.agentsStates : {};
      const ids = new Set<string>(previous?.receiverThreadIds ?? []);
      if (Array.isArray(item.receiverThreadIds)) {
        for (const id of item.receiverThreadIds) if (typeof id === "string" && id) ids.add(id);
      }
      for (const id of Object.keys(states)) ids.add(id);
      ids.delete(threadId);
      const rootId = this.rootThreadId();
      if (rootId) ids.delete(rootId);
      const call: CodexAgentCall = {
        itemId, threadId, turnId: text(params.turnId) ?? "", tool,
        status: callStatus(item.status, completed), receiverThreadIds: [...ids],
        prompt: text(item.prompt) ?? previous?.prompt ?? null,
        requestedModel: text(item.model) ?? previous?.requestedModel ?? null,
        requestedReasoningEffort: text(item.reasoningEffort) ?? previous?.requestedReasoningEffort ?? null,
        startedAt: previous?.startedAt ?? at, completedAt: completed ? at : null,
      };
      this.calls.set(key, call);
      const agents = call.receiverThreadIds.map((id) => {
        const known = this.agents.get(id);
        const state = states[id];
        const status = record(state) ? agentStatus(state.status) : "unknown";
        const message = record(state) ? text(state.message) : null;
        const patch: Partial<CodexAgentDetails> = {};
        if (status !== "unknown") patch.status = status;
        if (message) patch.message = message;
        if ((tool === "spawnAgent" || tool === "followupTask") && call.prompt) patch.task = call.prompt;
        if (tool === "spawnAgent" && known?.modelSource !== "resolved" && known?.modelSource !== "configured") {
          if (call.requestedModel) { patch.model = call.requestedModel; patch.modelSource = "requested"; }
          if (call.requestedReasoningEffort) patch.reasoningEffort = call.requestedReasoningEffort;
        }
        // close results can contain the state BEFORE closing, not shutdown.
        if (tool === "closeAgent" && call.status === "completed") patch.status = "shutdown";
        if (tool === "interruptAgent" && call.status === "completed" &&
            !["completed", "errored", "shutdown"].includes(patch.status ?? known?.status ?? "unknown")) {
          patch.status = "interrupted";
        }
        return this.updateAgent(id, known?.parentThreadId ?? threadId, patch, now);
      });
      return { call, agents };
    }

    if ((method === "item/started" || completed) && item?.type === "subAgentActivity") {
      const id = text(item.agentThreadId);
      const itemId = text(item.id);
      if (!id || !itemId || id === threadId || id === this.rootThreadId()) return null;
      const key = codexAgentCallKey({ threadId, turnId: text(params.turnId) ?? "", itemId });
      const seen = this.activities.get(key);
      const patch: Partial<CodexAgentDetails> = {};
      // An activity item describes one lifecycle point, not a long-running tool.
      // Its completed notification must not replay "started" after the agent ends.
      if (!seen) {
        switch (item.kind) {
          case "started": patch.status = "running"; break;
          case "interrupted": patch.status = "interrupted"; break;
          case "completed": patch.status = "completed"; break;
        }
      }
      const model = text(item.model);
      const effort = text(item.reasoningEffort);
      if (model && !seen?.model) { patch.model = model; patch.modelSource = "resolved"; }
      if (effort && !seen?.effort) patch.reasoningEffort = effort;
      this.activities.set(key, { model: model ?? seen?.model ?? null, effort: effort ?? seen?.effort ?? null });
      if (seen && Object.keys(patch).length === 0) return null;
      return { call: null, agents: [this.updateAgent(id, this.agents.get(id)?.parentThreadId ?? threadId, patch, now)] };
    }

    const agent = this.agents.get(threadId);
    if (!agent) return null;
    const patch: Partial<CodexAgentDetails> = {};
    if (method === "thread/closed") patch.status = "shutdown";
    else if (method === "thread/status/changed" && record(params.status)) {
      if (params.status.type === "active") patch.status = "running";
      if (params.status.type === "systemError") patch.status = "errored";
      // idle/notLoaded is not proof that a delegated task completed.
    } else if (method === "turn/started") patch.status = "running";
    else if (method === "turn/completed" && record(params.turn)) {
      const status = params.turn.status;
      if (status === "completed") patch.status = "completed";
      if (status === "failed") patch.status = "errored";
      if (status === "interrupted") patch.status = "interrupted";
      if (record(params.turn.error) && text(params.turn.error.message)) patch.message = text(params.turn.error.message);
    } else if (completed && item?.type === "agentMessage" && item.phase !== "commentary") {
      if (text(item.text)) patch.message = text(item.text);
    } else if (method === "error" && params.willRetry === false) {
      patch.status = "errored";
      if (record(params.error)) patch.message = text(params.error.message);
    }
    if (Object.keys(patch).length === 0) return null;
    // Delivery of a final child turn can race a successful close request.
    if (agent.status === "shutdown" && method === "turn/completed") delete patch.status;
    return { call: null, agents: [this.updateAgent(threadId, agent.parentThreadId, patch, now)] };
  }
}
