/**
 * useAutoRetry — automatically retries a turn when it ends
 * with a retryable upstream error (network drops, timeouts, 5xx). Partial turns
 * are continued instead of replaying the original prompt.
 *
 * Pure scheduling logic lives in lib/session/auto-retry.ts; this hook only
 * owns the timer and exposes countdown state for the UI. Budget: 3 attempts
 * with backoff, chained per user turn (see turnSignature). Any newer chat
 * message cancels the schedule — the user took over.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { UIMessage } from "@/types";
import {
  AUTO_RETRY_MAX_ATTEMPTS,
  planAutoRetry,
  type AutoRetryChain,
  type AutoRetryState,
} from "@/lib/session/auto-retry";

export interface UseAutoRetryOptions {
  sessionId: string | null;
  messages: UIMessage[];
  isProcessing: boolean;
  onRetry: (errorMessageId: string) => void | Promise<void>;
}

export function useAutoRetry({ sessionId, messages, isProcessing, onRetry }: UseAutoRetryOptions) {
  const [autoRetry, setAutoRetry] = useState<AutoRetryState | null>(null);
  const chainRef = useRef<AutoRetryChain | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Error id the current timer is scheduled for — avoids re-arming on unrelated re-renders. */
  const scheduledForRef = useRef<string | null>(null);
  /** Error id the user explicitly cancelled — never rescheduled, but later errors still retry. */
  const cancelledErrorRef = useRef<string | null>(null);
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;

  const clearScheduled = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    scheduledForRef.current = null;
    setAutoRetry(null);
  }, []);

  /** User-facing cancel: stops the pending retry for this error without marking it non-retryable. */
  const cancelAutoRetry = useCallback(() => {
    cancelledErrorRef.current = scheduledForRef.current;
    clearScheduled();
  }, [clearScheduled]);

  // Switching sessions drops the schedule, the attempt chain, and cancellations.
  useEffect(() => {
    chainRef.current = null;
    cancelledErrorRef.current = null;
    clearScheduled();
  }, [sessionId, clearScheduled]);

  useEffect(() => {
    if (isProcessing) {
      clearScheduled();
      return;
    }
    const plan = planAutoRetry(messages, chainRef.current);
    if (!plan) {
      cancelledErrorRef.current = null;
      clearScheduled();
      return;
    }
    if (plan.error.id === cancelledErrorRef.current) return;
    if (scheduledForRef.current === plan.error.id) return;

    clearScheduled();
    const runAt = Date.now() + plan.delayMs;
    scheduledForRef.current = plan.error.id;
    setAutoRetry({
      errorMessageId: plan.error.id,
      attempt: plan.attempt,
      maxAttempts: AUTO_RETRY_MAX_ATTEMPTS,
      runAt,
    });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      scheduledForRef.current = null;
      chainRef.current = { ...plan.chain, count: plan.attempt };
      setAutoRetry(null);
      void onRetryRef.current(plan.error.id);
    }, plan.delayMs);
  }, [messages, isProcessing, clearScheduled]);

  // Release the timer on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { autoRetry, cancelAutoRetry };
}
