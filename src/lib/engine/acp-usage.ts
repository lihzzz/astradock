import type { ACPUsageUpdate } from "@shared/types/acp";
import type { ContextUsage } from "@/types/mcp";

/** ACP usage is a session snapshot, not a turn delta. Replays must be idempotent. */
export function reduceAcpUsage(previous: { totalCost: number; contextUsage: ContextUsage | null }, update: ACPUsageUpdate) {
  const valid = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0;
  return {
    // The app's cost display is USD. Never silently add a different currency.
    totalCost: update.cost?.currency === "USD" && valid(update.cost.amount) ? update.cost.amount : previous.totalCost,
    contextUsage: valid(update.used) || valid(update.size) ? {
      inputTokens: valid(update.used) ? update.used : previous.contextUsage?.inputTokens ?? 0,
      outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextWindow: valid(update.size) ? update.size : previous.contextUsage?.contextWindow ?? 0,
    } : previous.contextUsage,
  };
}
