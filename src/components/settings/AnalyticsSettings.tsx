import { memo, useState, useCallback, useEffect } from "react";
import { BarChart3 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingRow, SettingsHeader, SettingsSection } from "@/components/settings/shared";
import { syncAnalyticsSettings } from "@/lib/analytics/posthog";
import type { AppSettings } from "@/types";
import { useI18n } from "@/lib/i18n";
import { UsageDashboard } from "./UsageDashboard";

interface AnalyticsSettingsProps {
  appSettings: AppSettings | null;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

// ── Component ──

export const AnalyticsSettings = memo(function AnalyticsSettings({
  appSettings,
  onUpdateAppSettings,
}: AnalyticsSettingsProps) {
  const { t } = useI18n();
  // Local optimistic state — synced from props once loaded
  const [analyticsEnabled, setAnalyticsEnabled] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    if (appSettings) {
      setAnalyticsEnabled(appSettings.analyticsEnabled ?? false);
      setUserId(appSettings.analyticsUserId ?? null);
    }
  }, [appSettings]);

  const handleToggleAnalytics = useCallback(
    async (checked: boolean) => {
      setAnalyticsEnabled(checked); // optimistic
      await onUpdateAppSettings({ analyticsEnabled: checked });
      // Sync renderer-side posthog-js opt-in/out state to match
      await syncAnalyticsSettings();
    },
    [onUpdateAppSettings],
  );

  return (
    <div className="flex h-full flex-col">
      <SettingsHeader title={t("analytics")} description={t("settingsAnalyticsDescription")} />

      <ScrollArea className="min-h-0 flex-1">
        <div className="@container px-6 py-2">
          <UsageDashboard />
          {/* ── Analytics section ── */}
          <SettingsSection icon={BarChart3} label={t("usageTelemetry")}>
            <SettingRow
              label={t("settingsSendAnalytics")}
              description={t("settingsSendAnalyticsDescription")}
            >
              <Switch
                checked={analyticsEnabled}
                onCheckedChange={handleToggleAnalytics}
              />
            </SettingRow>

            {/* Show user ID when analytics is enabled */}
            {analyticsEnabled && userId && (
              <div className="mt-4 rounded-md bg-foreground/[0.03] p-3">
                <p className="text-xs font-medium text-foreground">
                  {t("settingsAnonymousId")}
                </p>
                <p className="mt-1 font-mono text-xs text-muted-foreground break-all">
                  {userId}
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  {t("settingsAnonymousIdDescription")}
                </p>
              </div>
            )}
          </SettingsSection>

          {/* ── What we collect section ── */}
          <div className="border-t border-foreground/[0.04] py-3">
            <h3 className="mb-2 text-sm font-medium text-foreground">
              {t("settingsWhatCollect")}
            </h3>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsAppVersion")}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsDailyUsers")}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsFeatureUsage")}</span>
              </li>
            </ul>

            <h3 className="mb-2 mt-4 text-sm font-medium text-foreground">
              {t("settingsWhatNotCollect")}
            </h3>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsNoCode")}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsNoPaths")}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsNoPersonalData")}</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-0.5 h-1 w-1 shrink-0 rounded-full bg-foreground/40" />
                <span>{t("analyticsNoCredentials")}</span>
              </li>
            </ul>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
});
