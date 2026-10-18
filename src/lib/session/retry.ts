import type { UIMessage } from "@/types";

/** Prompt used to resume a turn that already made partial progress. */
export const CONTINUE_INTERRUPTED_TURN_PROMPT =
  "Continue the previous task from where it was interrupted. Do not repeat work that is already complete; inspect the current state and finish the remaining work.";

export interface RetryRequest {
  content: string;
  images?: UIMessage["images"];
  displayContent?: string;
  /** True when the failed turn already produced work and should be continued. */
  continueFromPartial?: boolean;
}

const NON_RETRYABLE_ERROR_PATTERNS = [
  /\b(?:401|403)\b/,
  /unauthori[sz]ed|forbidden|missing\s+(?:bearer|basic)\s+authentication/i,
  /\b(?:authentication|api\s+key|credential)s?\b/i,
  /(?:access|permission)\s+denied/i,
  /\b(?:invalid|unknown|unsupported|missing)\b.*\b(?:model|parameter|request|config(?:uration)?|option|method)\b/i,
  /\bconfig(?:uration)?\b.*\berror\b/i,
  /\bsession(?:[- ](?:not found|closed|invalid)|\s+not found)\b/i,
  /\b(?:thread|conversation)\s+(?:not found|closed|invalid)\b|\bno active thread\b/i,
];

/** Configuration, authentication, and permission errors need user action before retrying. */
export function isRetryableUpstreamError(content: string): boolean {
  return !NON_RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(content));
}

/** Whether a user turn has already produced agent output or tool activity. */
export function hasTurnProgress(
  messages: UIMessage[],
  startIndex: number,
  endIndex = messages.length,
): boolean {
  return messages.slice(startIndex + 1, endIndex).some((message) => (
    message.role === "assistant"
    || message.role === "tool_call"
    || message.role === "tool_result"
  ));
}

/**
 * Find the most recent user turn before a retryable error.
 *
 * A failed turn is not always safe to replay: the agent may already have
 * produced assistant output or executed tools before the upstream error. In
 * that case the caller should send a continuation prompt instead of replaying
 * the original request and risking duplicate work.
 */
export function getRetryRequest(messages: UIMessage[], errorMessageId: string): RetryRequest | null {
  const errorIndex = messages.findIndex((message) => message.id === errorMessageId);
  const error = errorIndex >= 0 ? messages[errorIndex] : undefined;
  if (errorIndex < 0 || (!error?.retryable && !error?.continuable)) return null;

  for (let index = errorIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || message.isQueued) continue;

    const turnHasProgress = hasTurnProgress(messages, index, errorIndex);

    return {
      content: message.content,
      images: message.images,
      displayContent: message.displayContent,
      ...(turnHasProgress || error?.continuable ? { continueFromPartial: true } : {}),
    };
  }

  return null;
}
