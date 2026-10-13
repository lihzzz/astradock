import { memo, useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingRow, SettingsSection } from "./shared";
import { useI18n } from "@/lib/i18n";
import { GLOBAL_SHORTCUT_DEFAULTS } from "@shared/lib/productivity-settings";
import type { GlobalShortcutSettings, QuickCaptureAction, ShortcutStatus } from "@shared/types/productivity";
import type { AppSettings } from "@/types";

const actions: Array<{ action: QuickCaptureAction; label: string }> = [
  { action: "wake", label: "Wake and type" }, { action: "dictate", label: "Wake and dictate" }, { action: "analyzeClipboard", label: "Analyze clipboard" },
];

export const ShortcutSettings = memo(function ShortcutSettings({ appSettings, onUpdate }: {
  appSettings: AppSettings | null; onUpdate: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<GlobalShortcutSettings>(GLOBAL_SHORTCUT_DEFAULTS);
  const [status, setStatus] = useState<ShortcutStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(appSettings?.globalShortcuts ?? GLOBAL_SHORTCUT_DEFAULTS);
    let current = true;
    window.claude.shortcuts.getStatus().then((result) => {
      if (!current) return;
      if (result.ok) setStatus(result.value); else setError(result.error.message);
    }).catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [appSettings?.globalShortcuts]);
  async function save() {
    setBusy(true); setError(null);
    try { await onUpdate({ globalShortcuts: draft }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <SettingsSection icon={Keyboard} label={t("Global shortcuts")}>
    <SettingRow label={t("Enable global shortcuts")} description={t("Use AstraDock while another app is in front. AstraDock must remain running.")}>
      <Switch aria-label={t("Enable global shortcuts")} checked={draft.enabled} disabled={busy || !appSettings} onCheckedChange={(enabled) => setDraft({ ...draft, enabled })} />
    </SettingRow>
    {actions.map(({ action, label }) => <div key={action} className="py-2">
      <SettingRow label={t(label)} description={action === "analyzeClipboard" ? t("This shortcut sends copied text to your chosen agent in a new conversation.") : undefined}>
        <Input className="w-64" aria-label={t(label)} value={draft[action] ?? ""} placeholder={t("Not assigned")} disabled={busy || !appSettings}
          onChange={(event) => setDraft({ ...draft, [action]: event.target.value.trim() || null })} />
      </SettingRow>
      <p className="text-xs text-muted-foreground" role="status">{status.find((item) => item.action === action)?.error?.message ?? (status.find((item) => item.action === action)?.registered ? t("Active") : t("Inactive"))}</p>
    </div>)}
    <p className="py-2 text-xs text-muted-foreground">{t("Example: CommandOrControl+Shift+Space. Leave a shortcut blank to unassign it.")}</p>
    <SettingRow label={t("Keep running when closing the window")} description={t("Reopen from the Dock or system tray. Choose Quit to stop AstraDock.")}>
      <Switch aria-label={t("Keep running when closing the window")} checked={draft.keepAliveOnClose} disabled={busy || !appSettings} onCheckedChange={(keepAliveOnClose) => setDraft({ ...draft, keepAliveOnClose })} />
    </SettingRow>
    {error && <p role="alert" className="py-2 text-sm text-destructive">{error}</p>}
    <Button size="sm" disabled={busy || !appSettings} onClick={() => { void save(); }}>{t("Save shortcuts")}</Button>
  </SettingsSection>;
});
