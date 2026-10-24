import { setTimeout as delay } from "node:timers/promises";
import { log } from "./logger";

/** Only retry transient transport/service failures, never auth or tool-policy failures. */
export function isRetryablePredictionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized|forbidden|invalid.api.key|authentication|quota|billing|refused tool|unsupported input|cancelled|canceled/i.test(message)) return false;
  return /timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|network|socket|connection (?:closed|reset)|temporar|overloaded|rate.?limit|\b(?:408|429|500|502|503|504)\b/i.test(message);
}

/** No total deadline. A single abort signal owns both inference and retry backoff. */
export async function retryComposerPrediction<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = await run();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted || !isRetryablePredictionError(error)) throw error;
      const delayMs = Math.min(1_000 * 2 ** Math.min(failures++, 5), 30_000);
      // Do not log prompts or generated suggestions.
      log("COMPOSER_PREDICTION_RETRY", "attempt=" + failures + " delay_ms=" + delayMs);
      await delay(delayMs, undefined, { signal });
    }
  }
}
