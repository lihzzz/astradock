import type { EngineId } from "../types/engine";
import type { UsageRange, UsageTokenEngine, UsageTokenReport, UsageTokens } from "../types/usage";

const ENGINES: EngineId[] = ["claude", "codex", "acp"];

function emptyEngines(): UsageTokenEngine[] {
  return ENGINES.map((engine) => ({
    engine, reported: false, totalTokens: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0,
  }));
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Assign reported consumption to local calendar days, including today. */
export function buildTokenUsageReport(data: UsageTokens, range: UsageRange, now = Date.now()): UsageTokenReport {
  const today = new Date(now);
  const starts = Array.from({ length: range + 1 }, (_, i) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - range + 1 + i));
  const days = starts.slice(0, -1).map((date, i) => ({
    date: dateKey(date), engines: emptyEngines(), totalTokens: 0,
    recorded: +starts[i + 1] > data.trackingStartedAt,
  }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const engines = emptyEngines();
  const totalsByEngine = new Map(engines.map((entry) => [entry.engine, entry]));
  for (const entry of data.entries) {
    if (entry.timestamp < +starts[0] || entry.timestamp > now || entry.timestamp < data.trackingStartedAt) continue;
    const day = byDate.get(dateKey(new Date(entry.timestamp)));
    const total = totalsByEngine.get(entry.engine);
    const daily = day?.engines.find((engine) => engine.engine === entry.engine);
    if (!day || !total || !daily) continue;
    day.totalTokens += entry.totalTokens;
    for (const destination of [total, daily]) {
      destination.reported = true;
      destination.totalTokens += entry.totalTokens;
      destination.inputTokens += entry.inputTokens;
      destination.outputTokens += entry.outputTokens;
      destination.cacheReadTokens += entry.cacheReadTokens;
      destination.cacheCreationTokens += entry.cacheCreationTokens;
    }
  }
  return { days, engines, trackingStartedAt: data.trackingStartedAt, incomplete: false };
}
