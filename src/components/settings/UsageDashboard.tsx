import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { reportError } from "@/lib/analytics/analytics";
import { TokenUsageSection } from "./TokenUsageSection";
import type { UsageRange, UsageRank, UsageReport } from "@shared/types/usage";

function Rankings({ entries, label }: { entries: UsageRank[]; label: string }) {
  const { t, language } = useI18n();
  const maximum = entries[0]?.count ?? 1;
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="text-[11px] text-muted-foreground">{t("usageTopTen")}</span>
      </div>
      {entries.length === 0 ? (
        <p className="py-5 text-xs text-muted-foreground">{t("usageNoCalls")}</p>
      ) : (
        <ol className="space-y-3" aria-label={label}>
          {entries.slice(0, 10).map((entry, index) => (
            <li key={entry.name} className="flex items-start gap-3">
              <span className="w-4 pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="truncate" title={entry.name === "__shell_script__" ? t("usageShellScript") : entry.name}>
                    {entry.name === "__shell_script__" ? t("usageShellScript") : entry.name}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{entry.count.toLocaleString(language)}</span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/[0.04]" aria-hidden>
                  <div className="h-full rounded-full bg-primary/45" style={{ width: `${entry.count / maximum * 100}%` }} />
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function UsageDashboard() {
  const { t, language } = useI18n();
  const [range, setRange] = useState<UsageRange>(7);
  const [revision, setRevision] = useState(0);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [commandKind, setCommandKind] = useState<"shell" | "slash">("shell");

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    setLoading(true);
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await window.claude.usage.get(range);
        if (!result.data || result.error) throw new Error(result.error ?? "Missing usage report");
        if (!cancelled) { setReport(result.data); setError(false); }
      } catch (err) {
        reportError("UsageDashboard.load", err, { range });
        if (!cancelled) setError(true);
      } finally {
        pending = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [range, revision]);

  const duration = (ms: number | null) => {
    if (ms === null) return t("usageNotRecorded");
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (seconds < 60) return `${seconds}${t("usageSeconds")}`;
    if (minutes < 60) return `${minutes}${t("usageMinutes")}`;
    return `${Math.floor(minutes / 60)}${t("usageHours")} ${minutes % 60}${t("usageMinutes")}`;
  };
  const totals = report?.days.reduce((sum, day) => ({
    user: sum.user + day.userMessages,
    assistant: sum.assistant + day.assistantMessages,
    active: sum.active + (day.activeMs ?? 0),
    agent: sum.agent + (day.agentMs ?? 0),
  }), { user: 0, assistant: 0, active: 0, agent: 0 });
  const maxMessages = Math.max(1, ...report?.days.map((day) => day.userMessages + day.assistantMessages) ?? []);
  const maxDuration = Math.max(1, ...report?.days.flatMap((day) => [day.activeMs ?? 0, day.agentMs ?? 0]) ?? []);

  return (
    <section className="space-y-5 pb-6 pt-3" aria-labelledby="usage-heading" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="usage-heading" className="text-sm font-semibold">{t("usageOverview")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t("usageLocalOnly")}</p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label={t("usageDateRange")}>
          {([1, 7, 30, 90] as const).map((days) => (
            <Button key={days} size="sm" variant={range === days ? "secondary" : "ghost"}
              aria-pressed={range === days}
              onClick={() => { if (range !== days) { setReport(null); setRange(days); } }}>
              {days === 1 ? t("usageSingleDay") : `${days}${t("usageDays")}`}
            </Button>
          ))}
          <Button variant="ghost" size="icon-sm" disabled={loading} aria-label={t("usageRefresh")}
            title={t("usageRefresh")} onClick={() => setRevision((value) => value + 1)}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/25 px-3 py-2 text-xs">
          <span>{report ? t("usageRefreshFailed") : t("usageLoadFailed")}</span>
          <Button size="sm" variant="ghost" onClick={() => setRevision((value) => value + 1)}>{t("usageRetry")}</Button>
        </div>
      )}
      {loading && !report && (
        <div role="status" className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t("usageLoading")}
        </div>
      )}

      {report && totals && (
        <>
          <dl className="grid grid-cols-1 gap-4 border-y border-foreground/[0.06] py-4 @min-[500px]:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t("usageMessages")}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{(totals.user + totals.assistant).toLocaleString(language)}</dd>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("usageSent")} {totals.user.toLocaleString(language)} · {t("usageReplies")} {totals.assistant.toLocaleString(language)}</p>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("usageActiveTime")}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{duration(report.incompleteTimings ? null : totals.active)}</dd>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("usageActiveShort")}</p>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("usageAgentTime")}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{duration(report.incompleteTimings ? null : totals.agent)}</dd>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("usageAgentShort")}</p>
            </div>
          </dl>
          {totals.user + totals.assistant === 0 && report.tools.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("usageEmpty")}</p>
          )}
          {report.incompleteHistory && <p role="status" className="text-xs text-destructive">{t("usageIncomplete")}</p>}

          {report.incompleteTimings && <p role="status" className="text-xs text-destructive">{t("usageTimingIncomplete")}</p>}
          <TokenUsageSection report={report.tokens} />

          <div>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">{t("usageDaily")}</h3>
              <span className="text-[11px] text-muted-foreground">{report.timeZone}</span>
            </div>
            <div className="max-h-80 overflow-auto rounded-md border border-foreground/[0.06]" tabIndex={0} role="region" aria-label={t("usageDaily")}>
              <table className="w-full min-w-[480px] text-xs tabular-nums">
                <thead className="sticky top-0 z-10 bg-background text-muted-foreground">
                  <tr className="border-b border-foreground/[0.06]">
                    <th scope="col" className="px-3 py-2.5 text-left font-medium">{t("usageDate")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">{t("usageSent")} / {t("usageReplies")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">{t("usageActiveTime")}</th>
                    <th scope="col" className="px-3 py-2.5 text-right font-medium">{t("usageAgentTime")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...report.days].reverse().map((day) => (
                    <tr key={day.date} className="border-b border-foreground/[0.04] last:border-0 hover:bg-foreground/[0.02]">
                      <th scope="row" className="whitespace-nowrap px-3 py-3 text-left font-normal">{day.date.slice(5).replace("-", "/")}</th>
                      <td className="px-3 py-3 text-right">
                        {day.userMessages.toLocaleString(language)} / {day.assistantMessages.toLocaleString(language)}
                        <div className="mt-1 ml-auto h-0.5 bg-foreground/20" style={{ width: `${(day.userMessages + day.assistantMessages) / maxMessages * 100}%` }} aria-hidden />
                      </td>
                      {([day.activeMs, day.agentMs] as const).map((value, index) => (
                        <td key={index} className="whitespace-nowrap px-3 py-3 text-right">
                          <span className={value === null ? "text-muted-foreground" : ""}>{duration(value)}</span>
                          <div className={`mt-1 ml-auto h-0.5 ${index === 0 ? "bg-chart-1" : "bg-chart-2"}`} style={{ width: `${(value ?? 0) / maxDuration * 100}%` }} aria-hidden />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 @min-[500px]:grid-cols-2">
            <Rankings entries={report.tools} label={t("usageTools")} />
            <div className="min-w-0">
              <div className="mb-3 flex gap-1" role="group" aria-label={t("usageCommandType")}>
                {(["shell", "slash"] as const).map((kind) => (
                  <Button key={kind} size="xs" variant={commandKind === kind ? "secondary" : "ghost"}
                    aria-pressed={commandKind === kind} onClick={() => setCommandKind(kind)}>
                    {t(kind === "shell" ? "usageShell" : "usageSlash")}
                  </Button>
                ))}
              </div>
              <Rankings entries={commandKind === "shell" ? report.commands : report.slashCommands} label={t("usageCommands")} />
            </div>
          </div>

          <details className="border-t border-foreground/[0.06] pt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer text-foreground focus-visible:outline-ring">{t("usageHowCounted")}</summary>
            <div className="mt-2 space-y-2 leading-relaxed">
              <p>{t("usageHistoryNote")}</p>
              {!report.incompleteTimings && <p>{t("usageTimingSince")} {new Date(report.trackingStartedAt).toLocaleString(language)}</p>}
              <p>{t("usageActiveNote")}</p>
              <p>{t("usageAgentNote")}</p>
              <p>{t("usageCommandNote")}</p>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
