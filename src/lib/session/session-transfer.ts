/**
 * Session transfer ("hand off to another model"): serialize the live session
 * to Markdown and build the prompt that lets a different engine/model pick up
 * the work where this session left off.
 */

import type { SessionMeta } from "@shared/lib/session-persistence";
import { buildSessionMarkdown, markdownMessages } from "@shared/lib/session-markdown";
import type { ACPConfigOption, EngineId, UIMessage } from "@/types";

/** Where a session transfer should continue the conversation. */
export interface SessionTransferTarget {
  engine: EngineId;
  /** ACP agent id (required when engine === "acp"); built-in engines resolve their own default agent. */
  agentId?: string;
  /** Cached ACP config options so the new session can render model pickers immediately. */
  cachedConfigOptions?: ACPConfigOption[];
  /** Explicit model id; when omitted the engine's configured default model is used. */
  model?: string;
  /** Explicit reasoning effort for the new session (Claude/Codex); omitted = current/default effort. */
  effort?: string;
  /** Human-readable target label shown in toasts, e.g. "Codex · gpt-5". */
  label: string;
}

/** Known reasoning-effort levels ranked from lowest to highest. */
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 7,
};

function effortScore(effort: string): number {
  return EFFORT_RANK[effort.trim().toLowerCase()] ?? -1;
}

/**
 * Pick the strongest effort a model supports. Known levels win by rank;
 * unknown levels are treated as lowest and ties fall to the later list entry
 * (catalogs list efforts in ascending order).
 */
export function getHighestEffort(efforts: readonly string[]): string | undefined {
  if (efforts.length === 0) return undefined;
  let best = efforts[0];
  let bestScore = effortScore(efforts[0]);
  for (let i = 1; i < efforts.length; i++) {
    const value = effortScore(efforts[i]);
    if (value >= bestScore) {
      best = efforts[i];
      bestScore = value;
    }
  }
  return best;
}

/** Export all live messages without the size cap used by inline handoffs. */
export function buildTransferMarkdown(session: SessionMeta, messages: UIMessage[]): string {
  // Keep actual user prompts, including earlier handoff file paths, rather than
  // the abbreviated display text shown in the chat UI.
  const prepared = markdownMessages(messages).map((message) => ({
    ...message,
    displayContent: undefined,
  }));
  return buildSessionMarkdown(session, prepared);
}

/** Build the first message only after the context file has been written. */
export function buildSessionTransferPrompt(input: {
  filePath: string;
  objective?: string;
}): string {
  const objective = input.objective?.trim();
  const prefix = `上一轮会话的完整上下文已导出到 ${input.filePath}。请先阅读该文件，了解之前的讨论内容、进展和当前状态`;
  return objective
    ? `${prefix}，沿用已有决策和进度，不重复已完成的工作，然后以这些上下文为基础完成以下工作：\n\n${objective}`
    : `${prefix}，然后从中断处继续完成未完成的任务`;
}
