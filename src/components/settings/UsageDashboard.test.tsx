import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@shared/types/usage";
import { buildUsageReport } from "@shared/lib/usage";
const harness = vi.hoisted(() => ({ report: null as UsageReport | null }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [initial === null ? harness.report : initial, () => {}],
  useEffect: () => {},
}));
vi.mock("@/lib/i18n", () => ({ useI18n: () => ({ language: "en-US", t: (key: string) => key }) }));
vi.mock("@/lib/analytics/analytics", () => ({ reportError: vi.fn() }));
import { UsageDashboard } from "./UsageDashboard";
beforeEach(() => {
  const now = Date.now();
  harness.report = buildUsageReport([], { version: 1, trackingStartedAt: now, active: [], agent: [] }, 1,
    { version: 1, trackingStartedAt: now, entries: [{ engine: "codex", timestamp: now,
      totalTokens: 123, inputTokens: 100, outputTokens: 23, cacheReadTokens: 0, cacheCreationTokens: 0 }] }, now);
});
describe("partial usage report UI", () => {
  it("shows unavailable timing rather than zero while keeping token totals", () => {
    const report = harness.report!;
    report.incompleteTimings = true;
    for (const day of report.days) { day.activeMs = null; day.agentMs = null; }
    const html = renderToStaticMarkup(<UsageDashboard />);
    expect(html).toContain("usageTimingIncomplete");
    expect(html).toContain("usageNotRecorded");
    expect(html).not.toContain("usageTimingSince");
    expect(html).not.toContain("0usageSeconds");
    expect(html).toContain("123");
  });
  it("keeps timing visible when token data is unavailable, without claiming a new tracking date", () => {
    harness.report!.tokens.incomplete = true;
    const html = renderToStaticMarkup(<UsageDashboard />);
    expect(html).toContain("usageTokenIncomplete");
    expect(html).not.toContain("usageTokenNoReports");
    expect(html).not.toContain("usageTokenTrackingSince");
    expect(html).toContain("usageTimingSince");
    expect(html).not.toContain("usageTimingIncomplete");
  });
});
