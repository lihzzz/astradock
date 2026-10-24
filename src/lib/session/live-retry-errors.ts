import type { UIMessage } from "@/types";

// Object identity deliberately does not survive JSON persistence or app restart.
// A recent timestamp alone is not evidence that an error happened in this runtime.
const liveErrors = new WeakSet<UIMessage>();

export function registerLiveRetryError(message: UIMessage): void {
  if (message.isError && message.retryable) liveErrors.add(message);
}

export function isLiveRetryError(message: UIMessage): boolean {
  return liveErrors.has(message);
}
