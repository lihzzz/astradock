import { describe, expect, it } from "vitest";
import type { UIMessage } from "@/types";
import { createSystemMessage } from "../message-factory";
import { getRetryRequest } from "./retry";
import {
  AUTO_RETRY_DELAYS_MS,
  AUTO_RETRY_MAX_ATTEMPTS,
  AUTO_RETRY_MAX_ERROR_AGE_MS,
  getTailRetryableError,
  planAutoRetry,
  turnSignature,
  type AutoRetryChain,
} from "./auto-retry";

const NOW = 1_800_000_000_000;

function userMessage(content: string, timestamp = NOW - 1000): UIMessage {
  return { id: `user-${content}`, role: "user", content, timestamp };
}

function errorMessage(overrides: Partial<UIMessage> = {}): UIMessage {
  const message = Object.assign(createSystemMessage("stream disconnected", true, true), {
    id: "sys-err-1",
    role: "system" as const,
    content: "stream disconnected",
    isError: true,
    retryable: true,
    timestamp: NOW - 500,
    ...overrides,
  });
  return message;
}

describe("getTailRetryableError", () => {
  it("returns the error only when it is the newest message", () => {
    const error = errorMessage();
    expect(getTailRetryableError([userMessage("hi"), error])).toBe(error);
    expect(getTailRetryableError([error, userMessage("hi")])).toBeNull();
  });

  it("ignores non-retryable or non-error tails", () => {
    expect(getTailRetryableError([errorMessage({ retryable: false })])).toBeNull();
    expect(getTailRetryableError([errorMessage({ isError: false })])).toBeNull();
    expect(getTailRetryableError([])).toBeNull();
  });
});

describe("planAutoRetry", () => {
  it("never auto-retries a restored recent error, but preserves manual retry", () => {
    const live = errorMessage();
    const restored: UIMessage = JSON.parse(JSON.stringify(live));
    const messages = [userMessage("hi"), restored];
    expect(planAutoRetry(messages, null, NOW)).toBeNull();
    expect(getRetryRequest(messages, restored.id)).not.toBeNull();
    expect(planAutoRetry([userMessage("hi"), live], null, NOW)).not.toBeNull();
  });
  it("schedules the first attempt with the first delay", () => {
    const plan = planAutoRetry([userMessage("hi"), errorMessage()], null, NOW);
    expect(plan?.attempt).toBe(1);
    expect(plan?.delayMs).toBe(AUTO_RETRY_DELAYS_MS[0]);
    expect(plan?.chain.count).toBe(0);
  });

  it("advances attempts and delays within the same turn chain", () => {
    const messages = [userMessage("hi"), errorMessage()];
    const first = planAutoRetry(messages, null, NOW);
    const chain: AutoRetryChain = { ...first!.chain, count: first!.attempt };
    const second = planAutoRetry(messages, chain, NOW);
    expect(second?.attempt).toBe(2);
    expect(second?.delayMs).toBe(AUTO_RETRY_DELAYS_MS[1]);
  });

  it("stops after the attempt budget is spent", () => {
    const messages = [userMessage("hi"), errorMessage()];
    const chain: AutoRetryChain = { key: turnSignature({ content: "hi" }), count: AUTO_RETRY_MAX_ATTEMPTS };
    expect(planAutoRetry(messages, chain, NOW)).toBeNull();
  });

  it("resets the chain when a different turn fails", () => {
    const chain: AutoRetryChain = { key: turnSignature({ content: "other" }), count: 2 };
    const plan = planAutoRetry([userMessage("hi"), errorMessage()], chain, NOW);
    expect(plan?.attempt).toBe(1);
  });

  it("skips stale errors (e.g. restored sessions after an app restart)", () => {
    const stale = errorMessage({ timestamp: NOW - AUTO_RETRY_MAX_ERROR_AGE_MS - 1 });
    expect(planAutoRetry([userMessage("hi"), stale], null, NOW)).toBeNull();
  });

  it("skips errors without a resendable user turn", () => {
    expect(planAutoRetry([errorMessage()], null, NOW)).toBeNull();
  });
});
