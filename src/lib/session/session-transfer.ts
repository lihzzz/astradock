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

/** Upper bound for the transcript embedded in a transfer prompt (~240 KB). */
export const TRANSFER_MARKDOWN_MAX_BYTES = 240 * 1024;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export interface TransferMarkdownResult {
  markdown: string;
  /** Number of middle messages dropped to satisfy the size cap (0 = full transcript). */
  omittedCount: number;
}

/**
 * Render the session as Markdown. When the transcript exceeds `maxBytes`, keep
 * the first message (usually the original request) plus as many trailing
 * messages as fit, and record how many middle messages were omitted.
 */
export function buildTransferMarkdown(
  session: SessionMeta,
  messages: UIMessage[],
  maxBytes: number = TRANSFER_MARKDOWN_MAX_BYTES,
): TransferMarkdownResult {
  const prepared = markdownMessages(messages);
  const full = buildSessionMarkdown(session, prepared);
  if (byteLength(full) <= maxBytes) return { markdown: full, omittedCount: 0 };

  const omissionNote = (count: number) =>
    `> [${count} older message(s) omitted to keep this handoff within size limits. ` +
    `The first request and the most recent turns are preserved.]`;

  // Binary search the largest trailing window that still fits alongside the first message.
  const first = prepared.slice(0, 1);
  const rest = prepared.slice(1);
  let lo = 0;
  let hi = rest.length;
  let best = "";
  let bestK = -1;
  while (lo <= hi) {
    const k = Math.floor((lo + hi) / 2);
    const kept = [...first, ...rest.slice(rest.length - k)];
    const omitted = prepared.length - kept.length;
    const candidate = `${buildSessionMarkdown(session, kept)}\n${omissionNote(omitted)}\n`;
    if (byteLength(candidate) <= maxBytes) {
      best = candidate;
      bestK = k;
      lo = k + 1;
    } else {
      hi = k - 1;
    }
  }
  if (bestK < 0) {
    // Even a single message is too large -- hard-truncate the full document.
    const encoder = new TextEncoder();
    const truncated = new TextDecoder().decode(encoder.encode(full).slice(0, maxBytes));
    return { markdown: `${truncated}\n\n${omissionNote(prepared.length - 1)}\n`, omittedCount: prepared.length - 1 };
  }
  return { markdown: best, omittedCount: rest.length - bestK };
}

export interface SessionTransferPromptResult {
  prompt: string;
  omittedCount: number;
  messageCount: number;
}

/**
 * Build the initial prompt for the target session: takeover instructions plus
 * the source session transcript as Markdown.
 */
export function buildSessionTransferPrompt(input: {
  session: SessionMeta;
  messages: UIMessage[];
  projectPath?: string;
  maxBytes?: number;
}): SessionTransferPromptResult {
  const { session, messages, projectPath, maxBytes } = input;
  const { markdown, omittedCount } = buildTransferMarkdown(session, messages, maxBytes);
  const sourceEngine = session.engine ?? "claude";
  const lines = [
    `You are taking over an ongoing work session previously handled by the ${sourceEngine} agent. The full conversation transcript is provided below as Markdown.`,
    "",
    "Continue the work exactly from where the transcript ends:",
    "- Treat the transcript as the source of truth for decisions, progress, and pending tasks.",
    "- Do not restart or redo completed steps; verify the current workspace state before editing files.",
    "- Resume with the most recent unanswered request or unfinished task.",
  ];
  if (projectPath) lines.push(`- Work inside the current project directory: ${projectPath}`);
  if (omittedCount > 0) {
    lines.push(`- Note: ${omittedCount} older message(s) were omitted for size; the opening request and recent turns are complete.`);
  }
  return {
    prompt: `${lines.join("\n")}\n\n---\n\n${markdown}`,
    omittedCount,
    messageCount: messages.length,
  };
}
