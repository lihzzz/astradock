import { memo, useId } from "react";
import { ChartNoAxesCombined, ChevronDown, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSessionTokenUsage } from "@/hooks/useSessionTokenUsage";
import { useI18n } from "@/lib/i18n";

const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const SessionTokenUsage = memo(function SessionTokenUsage({ sessionId, isProcessing }: {
  sessionId: string;
  isProcessing: boolean;
}) {
  const { t, language } = useI18n();
  const { usage, error, refresh } = useSessionTokenUsage(sessionId, isProcessing);
  const headingId = useId();
  const number = (value: number) => value.toLocaleString(language);
  const reported = usage?.reported ?? false;
  const subagentCount = usage?.subagentCount ?? 0;
  const rows = usage ? [
    { label: t("sessionTokenInput"), value: usage.inputTokens, indent: false },
    { label: t("sessionTokenCacheRead"), value: usage.cacheReadTokens, indent: true },
    ...(usage.cacheCreationTokens > 0 ? [{ label: t("sessionTokenCacheWrite"), value: usage.cacheCreationTokens, indent: true }] : []),
    { label: t("sessionTokenOutput"), value: usage.outputTokens, indent: false },
  ] : [];

  return (
    <Popover onOpenChange={(open) => { if (open) refresh(); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          className="no-drag h-6 gap-1.5 border-primary/20 bg-primary/5 px-2 text-xs text-primary shadow-none hover:bg-primary/10 dark:border-primary/20 dark:bg-primary/5 dark:hover:bg-primary/10"
          aria-label={`${t("sessionTokenUsage")}: ${reported && usage ? number(usage.totalTokens) : t("sessionTokenUnreported")}`}
        >
          <ChartNoAxesCombined className="size-3.5" />
          <span className="tabular-nums">{t("sessionTokenAccumulated")} {reported && usage ? compactTokens.format(usage.totalTokens) : "—"} Token</span>
          {subagentCount > 0 && (
            <span className="flex items-center gap-1 border-s border-primary/20 ps-1.5">
              <UsersRound className="size-3" />
              <span className="tabular-nums">{subagentCount}</span>
            </span>
          )}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={8} className="no-drag w-80 max-w-[calc(100vw-2rem)] p-4" aria-labelledby={headingId}>
        <h2 id={headingId} className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ChartNoAxesCombined className="size-4 text-primary" />
          {t("sessionTokenUsage")}
        </h2>
        <div className="mb-3 rounded-lg bg-primary/5 px-3 py-2.5">
          <p className="mb-1 text-xs text-muted-foreground">{t("sessionTokenTotal")}</p>
          <p className="font-mono text-2xl font-semibold tabular-nums text-primary">
            {reported && usage ? number(usage.totalTokens) : "—"}
          </p>
        </div>
        {reported && usage ? (
          <>
            <dl className="space-y-2 text-xs">
              {rows.map(({ label, value, indent }) => (
                <div key={label} className={`flex items-baseline justify-between gap-4 ${indent ? "ps-3 text-muted-foreground" : ""}`}>
                  <dt>{label}</dt>
                  <dd className="font-mono tabular-nums">{number(value)}</dd>
                </div>
              ))}
            </dl>
            {subagentCount > 0 && (
              <dl className="mt-3 space-y-2 border-t pt-3 text-xs">
                <div className="flex justify-between gap-4">
                  <dt>{t("sessionTokenMainAgent")}</dt>
                  <dd className="font-mono tabular-nums">{number(usage.mainTokens)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt>{t("sessionTokenSubagents")} ({subagentCount})</dt>
                  <dd className="font-mono tabular-nums">{number(usage.subagentTokens)}</dd>
                </div>
              </dl>
            )}
            <p className="mt-3 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">{t("sessionTokenCacheNote")}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("sessionTokenTrackingSince")} {new Date(usage.trackingStartedAt).toLocaleDateString(language)}{t("sessionTokenHistoryNote")}
            </p>
          </>
        ) : !error ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{t(usage ? "sessionTokenNoReports" : "sessionTokenLoading")}</p>
        ) : null}
        {error && (
          <div role="alert" className="mt-3 flex items-start justify-between gap-2 text-xs text-destructive">
            <p>{t("sessionTokenReadError")}</p>
            <Button variant="ghost" size="xs" className="h-auto shrink-0 py-0 text-xs" onClick={refresh}>{t("usageRetry")}</Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
