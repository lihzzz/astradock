import type { UIMessage } from "@/types";
import { isLiveRetryError } from "./live-retry-errors";
import { getRetryRequest, type RetryRequest } from "./retry";

/** Live state of a scheduled auto-retry, exposed for countdown UI. */
export interface AutoRetryState {
  errorMessageId: string;
  attempt: number;
  maxAttempts: number;
  /** Epoch ms when the retry fires. */
  runAt: number;
}

export const AUTO_RETRY_MAX_ATTEMPTS = 3;
export const AUTO_RETRY_DELAYS_MS = [4000, 10000, 20000] as const;
/**
 * Errors older than this only get the manual Retry button. Prevents opening a
 * session with a stale failed turn (e.g. after an app restart) from suddenly
 * retrying the message on its own.
 */
export const AUTO_RETRY_MAX_ERROR_AGE_MS = 2 * 60_000;

/** Tracks consecutive auto-retries of the same user turn. */
export interface AutoRetryChain {
  key: string;
  count: number;
}

/**
 * Auto-retry only fires when the retryable error is the newest message in the
 * chat. Any newer message (user typed, queued, info) means the user took over.
 */
export function getTailRetryableError(messages: UIMessage[]): UIMessage | null {
  const tail = messages[messages.length - 1];
  if (tail && tail.role === "system" && tail.isError && tail.retryable) return tail;
  return null;
}

/**
 * Identifies the user turn an error belongs to. Retries keep the original
 * turn signature, including when a partial turn is resumed, so consecutive
 * failures share one attempt budget.
 */
export function turnSignature(request: RetryRequest): string {
  return `${request.content.length}:${request.content}\n${request.displayContent ?? ""}\n${request.images?.length ?? 0}`;
}

export interface AutoRetryPlan {
  error: UIMessage;
  chain: AutoRetryChain;
  attempt: number;
  delayMs: number;
}

/**
 * Decide whether the tail error should be auto-retried. Returns null when the
 * error was loaded from history, is stale, has no retryable user turn, or the attempt budget is spent
 * (in which case only the manual Retry button remains).
 */
export function planAutoRetry(
  messages: UIMessage[],
  previousChain: AutoRetryChain | null,
  now = Date.now(),
): AutoRetryPlan | null {
  const error = getTailRetryableError(messages);
  if (!error || !isLiveRetryError(error)) return null;
  if (now - error.timestamp > AUTO_RETRY_MAX_ERROR_AGE_MS) return null;
  const request = getRetryRequest(messages, error.id);
  if (!request) return null;

  const key = turnSignature(request);
  const chain = previousChain?.key === key ? previousChain : { key, count: 0 };
  const attempt = chain.count + 1;
  if (attempt > AUTO_RETRY_MAX_ATTEMPTS) return null;

  return { error, chain, attempt, delayMs: AUTO_RETRY_DELAYS_MS[attempt - 1] };
}
