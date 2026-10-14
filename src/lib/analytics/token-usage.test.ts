import { afterEach, describe, expect, it } from "vitest";
import { buildTokenUsageReport } from "@shared/lib/token-usage";
import type { UsageTokenEntry, UsageTokens } from "@shared/types/usage";

const originalTimezone = process.env.TZ;
afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

function entry(timestamp: number, engine: UsageTokenEntry["engine"], totalTokens: number): UsageTokenEntry {
  return { timestamp, engine, totalTokens, inputTokens: totalTokens - 10,
    outputTokens: 10, cacheReadTokens: 20, cacheCreationTokens: 5 };
}

describe("daily token reports", () => {
  it.each([[1, "2026-10-13"], [7, "2026-10-07"], [30, "2026-09-14"]] as const)("uses %s local calendar days including today", (range, firstDate) => {
    const now = +new Date(2026, 9, 13, 12);
    const start = +new Date(2026, 9, 14 - range);
    const data: UsageTokens = { version: 1, trackingStartedAt: start - 1000, entries: [
      entry(start - 1, "claude", 999), entry(start, "claude", 100),
      entry(now, "codex", 200), entry(now + 1, "codex", 999),
    ] };
    const report = buildTokenUsageReport(data, range, now);
    expect(report.days).toHaveLength(range);
    expect(report.days[0].date).toBe(firstDate);
    expect(report.engines.map((engine) => engine.totalTokens)).toEqual([100, 200, 0]);
    expect(report.days.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(300);
    expect(report.days.at(-1)?.date).toBe("2026-10-13");
  });

  it("keeps engine breakdowns and does not add cache tokens a second time", () => {
    const now = +new Date(2026, 9, 13, 12);
    const report = buildTokenUsageReport({ version: 1, trackingStartedAt: now - 1000,
      entries: [entry(now, "claude", 100), entry(now, "claude", 200), entry(now, "acp", 80)],
    }, 1, now);
    expect(report.days[0].totalTokens).toBe(380);
    expect(report.engines[0]).toMatchObject({ totalTokens: 300, inputTokens: 280,
      outputTokens: 20, cacheReadTokens: 40, cacheCreationTokens: 10, reported: true });
    expect(report.engines[1].reported).toBe(false);
    expect(report.engines[2]).toMatchObject({ totalTokens: 80, reported: true });
  });

  it("marks dates before collection and engines without usage as unrecorded", () => {
    const now = +new Date(2026, 9, 13, 12);
    const report = buildTokenUsageReport({ version: 1, trackingStartedAt: +new Date(2026, 9, 12, 12),
      entries: [entry(+new Date(2026, 9, 11, 12), "claude", 999)],
    }, 7, now);
    expect(report.days.map((day) => day.recorded)).toEqual([false, false, false, false, false, true, true]);
    expect(report.days.every((day) => day.totalTokens === 0)).toBe(true);
    expect(report.engines.every((engine) => !engine.reported)).toBe(true);
  });

  it("assigns tokens across local midnight and a DST transition", () => {
    process.env.TZ = "America/New_York";
    const midnight = +new Date(2026, 2, 9);
    const report = buildTokenUsageReport({ version: 1, trackingStartedAt: +new Date(2026, 2, 8),
      entries: [entry(midnight - 1, "claude", 100), entry(midnight, "codex", 200)],
    }, 7, midnight);
    expect(report.days.at(-2)).toMatchObject({ date: "2026-03-08", totalTokens: 100 });
    expect(report.days.at(-1)).toMatchObject({ date: "2026-03-09", totalTokens: 200 });
  });
});
