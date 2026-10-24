import { memo, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import type { EngineId } from "@shared/types/engine";
import type { UsageTokenDay, UsageTokenEngine, UsageTokenReport, UsageTokenTotals } from "@shared/types/usage";

type EngineFilter = EngineId | "all";

const ENGINE_NAMES: Record<EngineId, string> = { claude: "Claude", codex: "Codex", acp: "ACP" };
const ENGINES: EngineId[] = ["claude", "codex", "acp"];
const ENGINE_COLORS: Record<EngineId, string> = {
  claude: "bg-chart-1",
  codex: "bg-chart-2",
  acp: "bg-chart-3",
};

function combineEngines(engines: UsageTokenEngine[], filter: EngineFilter): UsageTokenTotals & { reported: boolean } {
  const totals = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reported: false };
  for (const engine of engines) {
    if (filter !== "all" && engine.engine !== filter) continue;
    if (!engine.reported) continue;
    totals.reported = true;
    totals.totalTokens += engine.totalTokens;
    totals.inputTokens += engine.inputTokens;
    totals.outputTokens += engine.outputTokens;
    totals.cacheReadTokens += engine.cacheReadTokens;
    totals.cacheCreationTokens += engine.cacheCreationTokens;
  }
  return totals;
}

function dailyTotals(day: UsageTokenDay, filter: EngineFilter) {
  const totals = combineEngines(day.engines, filter);
  return { date: day.date, ...totals, reported: day.recorded && totals.reported };
}

export const TokenUsageSection = memo(function TokenUsageSection({ report }: { report: UsageTokenReport }) {
  const { t, language } = useI18n();
  const [engineFilter, setEngineFilter] = useState<EngineFilter>("all");
  const summary = useMemo(() => combineEngines(report.engines, engineFilter), [report.engines, engineFilter]);
  const rows = useMemo(
    () => report.days.map((day) => dailyTotals(day, engineFilter)).reverse(),
    [report.days, engineFilter],
  );
  const maximum = Math.max(1, ...rows.map((row) => row.totalTokens));
  const number = (value: number, recorded: boolean) => recorded ? value.toLocaleString(language) : t("usageNotRecorded");

  return (
    <section className="space-y-3" aria-labelledby="usage-token-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="usage-token-heading" className="text-sm font-medium">{t("usageTokens")}</h3>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("usageTokenEngine")}>
          <Button size="xs" variant={engineFilter === "all" ? "secondary" : "ghost"}
            aria-pressed={engineFilter === "all"} onClick={() => setEngineFilter("all")}>
            {t("usageTokenAllEngines")}
          </Button>
          {ENGINES.map((engine) => (
            <Button key={engine} size="xs" variant={engineFilter === engine ? "secondary" : "ghost"}
              aria-pressed={engineFilter === engine} onClick={() => setEngineFilter(engine)}>
              {ENGINE_NAMES[engine]}
            </Button>
          ))}
        </div>
      </div>

      <dl className="grid grid-cols-1 gap-4 rounded-md bg-foreground/[0.025] px-3 py-4 @min-[500px]:grid-cols-3">
        {([
          ["usageTokenTotal", summary.totalTokens],
          ["usageTokenInput", summary.inputTokens],
          ["usageTokenOutput", summary.outputTokens],
        ] as const).map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{t(label)}</dt>
            <dd className={`mt-1 text-xl font-semibold tabular-nums ${summary.reported ? "" : "text-muted-foreground"}`}>
              {number(value, summary.reported)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 gap-3 @min-[500px]:grid-cols-3" aria-label={t("usageTokenEngine")}>
        {ENGINES.map((engine) => {
          const usage = report.engines.find((item) => item.engine === engine);
          const reported = usage?.reported ?? false;
          return (
            <div key={engine} className={`min-w-0 rounded-md border px-3 py-3 ${engineFilter === engine ? "border-primary/30" : "border-foreground/[0.06]"}`}>
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className={`h-2 w-2 rounded-full ${ENGINE_COLORS[engine]}`} aria-hidden />
                {ENGINE_NAMES[engine]}
              </div>
              <p className={`mt-2 text-lg font-semibold tabular-nums ${reported ? "" : "text-muted-foreground"}`}>
                {number(usage?.totalTokens ?? 0, reported)}
              </p>
              <dl className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                {([
                  ["usageTokenInput", usage?.inputTokens ?? 0],
                  ["usageTokenOutput", usage?.outputTokens ?? 0],
                  ["usageTokenCacheRead", usage?.cacheReadTokens ?? 0],
                  ["usageTokenCacheCreation", usage?.cacheCreationTokens ?? 0],
                ] as const).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt>{t(label)}</dt>
                    <dd className="shrink-0 tabular-nums">{number(value, reported)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("usageTokenCountingNote")}</p>
      {!report.incomplete && !summary.reported && <p className="text-xs text-muted-foreground">{t("usageTokenNoReports")}</p>}
      {report.incomplete && <p role="status" className="text-xs text-destructive">{t("usageTokenIncomplete")}</p>}

      <div className="max-h-80 overflow-auto rounded-md border border-foreground/[0.06]" tabIndex={0} role="region" aria-label={t("usageTokenDaily")}>
        <table className="w-full min-w-[640px] text-xs tabular-nums">
          <caption className="sr-only">{t("usageTokenDaily")} · {engineFilter === "all" ? t("usageTokenAllEngines") : ENGINE_NAMES[engineFilter]}</caption>
          <thead className="sticky top-0 z-10 bg-background text-muted-foreground">
            <tr className="border-b border-foreground/[0.06]">
              <th scope="col" className="px-3 py-2.5 text-left font-medium">{t("usageDate")}</th>
              {(["usageTokenTotal", "usageTokenInput", "usageTokenOutput", "usageTokenCacheRead", "usageTokenCacheCreation"] as const).map((label) => (
                <th key={label} scope="col" className="whitespace-nowrap px-3 py-2.5 text-right font-medium">{t(label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date} className="border-b border-foreground/[0.04] last:border-0 hover:bg-foreground/[0.02]">
                <th scope="row" className="whitespace-nowrap px-3 py-3 text-left font-normal">{row.date}</th>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <span className={row.reported ? "" : "text-muted-foreground"}>{number(row.totalTokens, row.reported)}</span>
                  {row.reported && (
                    <div className={`ms-auto mt-1 h-0.5 ${engineFilter === "all" ? "bg-primary/45" : ENGINE_COLORS[engineFilter]}`}
                      style={{ width: `${row.totalTokens / maximum * 100}%` }} aria-hidden />
                  )}
                </td>
                {([row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens] as const).map((value, index) => (
                  <td key={index} className={`whitespace-nowrap px-3 py-3 text-right ${row.reported ? "" : "text-muted-foreground"}`}>
                    {number(value, row.reported)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
        {!report.incomplete && <p>{t("usageTokenTrackingSince")} {new Date(report.trackingStartedAt).toLocaleString(language)}</p>}
        <p>{t("usageTokenLocalNote")}</p>
        <p>{t("usageTokenMissingNote")}</p>
      </div>
    </section>
  );
}, (previous, next) => previous.report === next.report);
