import { describe, expect, it } from "vitest";
import type { UIMessage } from "@/types";
import { getRetryRequest, isRetryableUpstreamError } from "./retry";

function message(overrides: Partial<UIMessage>): UIMessage {
  return {
    id: "message",
    role: "system",
    content: "error",
    timestamp: 1,
    ...overrides,
  };
}

describe("getRetryRequest", () => {
  it("returns the user turn before a retryable error", () => {
    const images = [{ id: "image", data: "data", mediaType: "image/png" as const }];
    const messages = [
      message({ id: "user-1", role: "user", content: "try again", images, displayContent: "try" }),
      message({ id: "error-1", retryable: true }),
    ];

    expect(getRetryRequest(messages, "error-1")).toEqual({
      content: "try again",
      images,
      displayContent: "try",
    });
  });

  it("continues a turn that already produced assistant or tool progress", () => {
    const messages = [
      message({ id: "user-1", role: "user", content: "implement the feature" }),
      message({ id: "tool-1", role: "tool_call", content: "", toolName: "Edit" }),
      message({ id: "assistant-1", role: "assistant", content: "I started making the changes." }),
      message({ id: "error-1", retryable: true }),
    ];

    expect(getRetryRequest(messages, "error-1")).toMatchObject({
      content: "implement the feature",
      continueFromPartial: true,
    });
  });

  it("allows a manually interrupted turn to continue", () => {
    const messages = [
      message({ id: "user-1", role: "user", content: "finish the task" }),
      message({ id: "assistant-1", role: "assistant", content: "Partial result" }),
      message({ id: "interrupt-1", continuable: true }),
    ];

    expect(getRetryRequest(messages, "interrupt-1")).toMatchObject({
      content: "finish the task",
      continueFromPartial: true,
    });
  });

  it("ignores non-retryable errors and queued messages", () => {
    const messages = [
      message({ id: "queued", role: "user", content: "queued", isQueued: true }),
      message({ id: "error-1", retryable: true }),
    ];
    expect(getRetryRequest(messages, "error-1")).toBeNull();
    expect(getRetryRequest(messages, "missing")).toBeNull();
    expect(getRetryRequest([message({ id: "error-2" })], "error-2")).toBeNull();
  });
});

describe("isRetryableUpstreamError", () => {
  it("rejects errors that require authentication or configuration changes", () => {
    expect(isRetryableUpstreamError("401 Unauthorized")).toBe(false);
    expect(isRetryableUpstreamError("Missing bearer or basic authentication")).toBe(false);
    expect(isRetryableUpstreamError("Invalid configuration option")).toBe(false);
    expect(isRetryableUpstreamError("Session not found")).toBe(false);
    expect(isRetryableUpstreamError("No active thread")).toBe(false);
  });

  it("allows transient upstream failures", () => {
    expect(isRetryableUpstreamError("Upstream model timed out")).toBe(true);
  });
});
