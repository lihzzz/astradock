import { memo, useState, useCallback, useEffect } from "react";
import { MessageSquare, Code, Mic, Languages, Sparkles } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { SettingRow, SettingsSelect, SettingsHeader, SettingsSection } from "@/components/settings/shared";
import type { AppSettings, PreferredEditor, VoiceDictationMode } from "@/types";
import { useSettingsStore } from "@/stores/settings-store";
import { useI18n } from "@/lib/i18n";
import { ShortcutSettings } from "./ShortcutSettings";

interface GeneralSettingsProps {
  appSettings: AppSettings | null;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

// ── Component ──

export const GeneralSettings = memo(function GeneralSettings({
  appSettings,
  onUpdateAppSettings,
}: GeneralSettingsProps) {
  const { t } = useI18n();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const composerPredictionsEnabled = useSettingsStore((s) => s.composerPredictionsEnabled);
  const setComposerPredictionsEnabled = useSettingsStore((s) => s.setComposerPredictionsEnabled);
  // Local optimistic state — synced from props once loaded
  const [chatLimit, setChatLimit] = useState(10);
  const [preferredEditor, setPreferredEditor] = useState<PreferredEditor>("auto");
  const [voiceDictation, setVoiceDictation] = useState<VoiceDictationMode>("native");

  useEffect(() => {
    if (appSettings) {
      setChatLimit(appSettings.defaultChatLimit || 10);
      setPreferredEditor(appSettings.preferredEditor || "auto");
      setVoiceDictation(appSettings.voiceDictation || "native");
    }
  }, [appSettings]);

  const handleChatLimitChange = useCallback(
    async (value: number) => {
      const clamped = Math.max(5, Math.min(100, value));
      setChatLimit(clamped);
      await onUpdateAppSettings({ defaultChatLimit: clamped });
    },
    [onUpdateAppSettings],
  );

  const handleEditorChange = useCallback(
    async (value: PreferredEditor) => {
      setPreferredEditor(value); // optimistic
      await onUpdateAppSettings({ preferredEditor: value });
    },
    [onUpdateAppSettings],
  );

  const handleVoiceDictationChange = useCallback(
    async (value: VoiceDictationMode) => {
      setVoiceDictation(value); // optimistic
      await onUpdateAppSettings({ voiceDictation: value });
    },
    [onUpdateAppSettings],
  );

  return (
    <div className="flex h-full flex-col">
      <SettingsHeader title={t("general")} description={t("settingsGeneralDescription")} />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-2">
          <SettingsSection icon={Languages} label={t("settingsLanguageSection")} first>
            <SettingRow
              label={t("settingsLanguageLabel")}
              description={t("settingsLanguageDescription")}
            >
              <SettingsSelect
                value={language}
                onValueChange={setLanguage}
                options={[
                  { value: "zh-CN", label: "中文" },
                  { value: "en-US", label: "English" },
                ]}
              />
            </SettingRow>
          </SettingsSection>

          {/* ── Sidebar section ── */}
          <SettingsSection icon={MessageSquare} label={t("settingsSidebar")}>
            <SettingRow
              label={t("settingsRecentChats")}
              description={t("settingsRecentChatsDescription")}
            >
              <SettingsSelect
                value={String(chatLimit)}
                onValueChange={(v) => handleChatLimitChange(Number(v))}
                options={[5, 10, 15, 20, 25, 30, 50, 100].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </SettingRow>
          </SettingsSection>

          <SettingsSection icon={Sparkles} label={t("settingsComposerPredictionsSection")}>
            <SettingRow
              label={t("settingsComposerPredictions")}
              description={t("settingsComposerPredictionsDescription")}
            >
              <Switch
                checked={composerPredictionsEnabled}
                onCheckedChange={setComposerPredictionsEnabled}
                aria-label={t("settingsComposerPredictions")}
              />
            </SettingRow>
          </SettingsSection>

          {/* ── Editor section ── */}
          <SettingsSection icon={Code} label={t("settingsEditor")}>
            <SettingRow
              label={t("settingsDefaultEditor")}
              description={t("settingsDefaultEditorDescription")}
            >
              <SettingsSelect
                value={preferredEditor}
                onValueChange={handleEditorChange}
                options={[
                  { value: "auto", label: t("auto") },
                  { value: "cursor", label: "Cursor" },
                  { value: "code", label: "VS Code" },
                  { value: "zed", label: "Zed" },
                ]}
              />
            </SettingRow>
          </SettingsSection>

          {/* ── Voice Dictation section ── */}
          <ShortcutSettings appSettings={appSettings} onUpdate={onUpdateAppSettings} />
          <SettingsSection icon={Mic} label={t("settingsVoiceDictation")}>
            <SettingRow
              label={t("settingsDictationMode")}
              description={t("settingsDictationDescription")}
            >
              <SettingsSelect
                value={voiceDictation}
                onValueChange={handleVoiceDictationChange}
                options={[
                  { value: "native", label: t("nativeOs") },
                  { value: "whisper", label: t("whisperLocalAi") },
                ]}
              />
            </SettingRow>
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  );
});
