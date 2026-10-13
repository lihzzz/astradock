import { memo, useState, useCallback, useEffect } from "react";
import { Server } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SettingRow, SettingsHeader, SettingsSection } from "@/components/settings/shared";
import { useSettingsStore } from "@/stores/settings-store";
import type { AppSettings } from "@/types";
import { useI18n } from "@/lib/i18n";

interface AdvancedSettingsProps {
  appSettings: AppSettings | null;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** Resets the welcome wizard so it shows again. Dev-only. */
  onReplayWelcome: () => void;
}

// ── Component ──

export const AdvancedSettings = memo(function AdvancedSettings({
  appSettings,
  onUpdateAppSettings,
  onReplayWelcome,
}: AdvancedSettingsProps) {
  const { t } = useI18n();
  const backgroundProcessLimit = useSettingsStore((s) => s.backgroundProcessLimit);
  const setBackgroundProcessLimit = useSettingsStore((s) => s.setBackgroundProcessLimit);
  const [codexClientName, setCodexClientName] = useState("AstraDock");
  const [showDevFillInChatTitleBar, setShowDevFillInChatTitleBar] = useState(false);

  useEffect(() => {
    if (appSettings) {
      setCodexClientName(appSettings.codexClientName || "AstraDock");
      setShowDevFillInChatTitleBar(!!appSettings.showDevFillInChatTitleBar);
    }
  }, [appSettings]);

  const handleClientNameChange = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setCodexClientName(trimmed);
      await onUpdateAppSettings({ codexClientName: trimmed });
    },
    [onUpdateAppSettings],
  );

  const handleDevFillToggle = useCallback(
    async (checked: boolean) => {
      setShowDevFillInChatTitleBar(checked);
      await onUpdateAppSettings({ showDevFillInChatTitleBar: checked });
    },
    [onUpdateAppSettings],
  );

  const isDev = import.meta.env.DEV;

  return (
    <div className="flex h-full flex-col">
      <SettingsHeader
        title={t("advanced")}
        description={t("settingsAdvancedDescription")}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-2">
          <SettingsSection icon={Server} label="Codex" first>
            <SettingRow
              label="Client name"
              description="How this app identifies itself to Codex servers during the handshake. Changes take effect on new sessions."
            >
              <input
                type="text"
                value={codexClientName}
                onChange={(e) => setCodexClientName(e.target.value)}
                onBlur={(e) => handleClientNameChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleClientNameChange(e.currentTarget.value);
                }}
                spellCheck={false}
                className="h-8 w-40 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
                placeholder="AstraDock"
              />
            </SettingRow>

            {isDev && (
              <SettingRow
                label="Show Dev Fill in chat title bar"
                description="Enable developer seeding actions in the active chat title bar. Hidden by default."
              >
                <Switch
                  checked={showDevFillInChatTitleBar}
                  onCheckedChange={handleDevFillToggle}
                />
              </SettingRow>
            )}

            <SettingRow
              label="Background process limit"
              description="Idle background sessions keep their engine process alive (100-130MB each). Beyond this limit, the least recently active idle sessions are stopped and revived on demand. Set to 0 to disable reaping."
            >
              <input
                type="number"
                min={0}
                max={32}
                value={backgroundProcessLimit}
                onChange={(e) => setBackgroundProcessLimit(Number(e.target.value))}
                className="h-8 w-20 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
              />
            </SettingRow>

            {isDev && (
              <SettingRow
                label="Replay welcome wizard"
                description="Reset the onboarding flag and relaunch the welcome wizard."
              >
                <button
                  onClick={onReplayWelcome}
                  className="rounded-md border border-foreground/10 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/20 hover:bg-foreground/[0.03]"
                >
                  Replay
                </button>
              </SettingRow>
            )}
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  );
});
