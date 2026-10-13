import { memo, useState, useCallback, useEffect, useRef } from "react";
import { RefreshCw, Server } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { SettingRow, SettingsSelect, SettingsHeader, SettingsSection } from "@/components/settings/shared";
import type { AppSettings } from "@/types";
import type { ComputerUseRuntimeStatus } from "@shared/types/computer-use";
import { useI18n } from "@/lib/i18n";

interface EngineSettingsProps {
  appSettings: AppSettings | null;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

// ── Component ──

export const EngineSettings = memo(function EngineSettings({
  appSettings,
  onUpdateAppSettings,
}: EngineSettingsProps) {
  const { t } = useI18n();
  const [claudeBinarySource, setClaudeBinarySource] = useState<"auto" | "managed" | "custom">("auto");
  const [claudeCustomBinaryPath, setClaudeCustomBinaryPath] = useState("");
  const [codexBinarySource, setCodexBinarySource] = useState<"auto" | "managed" | "custom">("auto");
  const [codexCustomBinaryPath, setCodexCustomBinaryPath] = useState("");
  const [opencodeCustomBinaryPath, setOpencodeCustomBinaryPath] = useState("");
  const [computerUseEnabled, setComputerUseEnabled] = useState(false);
  const [computerUseBinaryPath, setComputerUseBinaryPath] = useState("");
  const [computerUseStatus, setComputerUseStatus] = useState<ComputerUseRuntimeStatus | null>(null);
  const [computerUseChecking, setComputerUseChecking] = useState(false);
  const [computerUseStatusError, setComputerUseStatusError] = useState<string | null>(null);
  const computerUseStatusRequestRef = useRef(0);

  useEffect(() => {
    if (appSettings) {
      setClaudeBinarySource(appSettings.claudeBinarySource || "auto");
      setClaudeCustomBinaryPath(appSettings.claudeCustomBinaryPath || "");
      setCodexBinarySource(appSettings.codexBinarySource || "auto");
      setCodexCustomBinaryPath(appSettings.codexCustomBinaryPath || "");
      setOpencodeCustomBinaryPath(appSettings.opencodeCustomBinaryPath || "");
      setComputerUseEnabled(appSettings.computerUseEnabled || false);
      setComputerUseBinaryPath(appSettings.computerUseBinaryPath || "");
    }
  }, [appSettings]);

  const refreshComputerUseStatus = useCallback(async (enabled = computerUseEnabled) => {
    const requestId = ++computerUseStatusRequestRef.current;
    if (!enabled) {
      setComputerUseStatus(null);
      setComputerUseStatusError(null);
      setComputerUseChecking(false);
      return;
    }

    setComputerUseChecking(true);
    setComputerUseStatusError(null);
    try {
      const status = await window.claude.computerUseStatus();
      if (requestId !== computerUseStatusRequestRef.current) return;
      setComputerUseStatus(status);
    } catch (error) {
      if (requestId !== computerUseStatusRequestRef.current) return;
      setComputerUseStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === computerUseStatusRequestRef.current) setComputerUseChecking(false);
    }
  }, [computerUseEnabled]);

  useEffect(() => {
    void refreshComputerUseStatus();
  }, [refreshComputerUseStatus, appSettings?.computerUseBinaryPath]);

  useEffect(() => () => {
    computerUseStatusRequestRef.current += 1;
  }, []);

  const handleClaudeBinarySourceChange = useCallback(
    async (source: "auto" | "managed" | "custom") => {
      setClaudeBinarySource(source);
      await onUpdateAppSettings({ claudeBinarySource: source });
    },
    [onUpdateAppSettings],
  );

  const handleClaudeCustomPathSave = useCallback(
    async (value: string) => {
      const next = value.trim();
      setClaudeCustomBinaryPath(next);
      await onUpdateAppSettings({ claudeCustomBinaryPath: next });
    },
    [onUpdateAppSettings],
  );

  const handleCodexBinarySourceChange = useCallback(
    async (source: "auto" | "managed" | "custom") => {
      setCodexBinarySource(source);
      await onUpdateAppSettings({ codexBinarySource: source });
    },
    [onUpdateAppSettings],
  );

  const handleCodexCustomPathSave = useCallback(
    async (value: string) => {
      const next = value.trim();
      setCodexCustomBinaryPath(next);
      await onUpdateAppSettings({ codexCustomBinaryPath: next });
    },
    [onUpdateAppSettings],
  );

  const handleOpencodeCustomPathSave = useCallback(
    async (value: string) => {
      const next = value.trim();
      setOpencodeCustomBinaryPath(next);
      await onUpdateAppSettings({ opencodeCustomBinaryPath: next });
    },
    [onUpdateAppSettings],
  );

  const handleComputerUseToggle = useCallback(
    async (checked: boolean) => {
      setComputerUseEnabled(checked);
      await onUpdateAppSettings({ computerUseEnabled: checked, codexComputerUseEnabled: checked });
      if (checked) {
        await window.claude.computerUseRequestPermissions();
      }
      await refreshComputerUseStatus(checked);
    },
    [onUpdateAppSettings, refreshComputerUseStatus],
  );

  const computerUseStatusText = computerUseChecking
    ? "Checking Cua Driver runtime…"
    : computerUseStatusError
      ? `Check failed: ${computerUseStatusError}`
    : !computerUseStatus
      ? ""
      : computerUseStatus.error
        ? `Check failed: ${computerUseStatus.error}`
        : computerUseStatus.ready
          ? `Ready — Cua Driver available (${computerUseStatus.mode})`
          : computerUseStatus.permissions && (!computerUseStatus.permissions.accessibility || !computerUseStatus.permissions.screenRecording)
            ? "Grant Accessibility and Screen Recording permissions, then retry."
          : computerUseStatus.mode === "internal"
            ? "The bundled Cua native runtime could not start. Check the app log for native permission or loading errors."
            : "The configured Cua Driver executable is unavailable.";

  return (
    <div className="flex h-full flex-col">
      <SettingsHeader
        title={t("engines")}
        description={t("settingsEnginesDescription")}
      />

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-6 py-2">
          <SettingsSection icon={Server} label="Claude Code" first>
            <SettingRow
              label="Claude binary source"
              description="Choose how AstraDock resolves the Claude executable."
            >
              <SettingsSelect
                value={claudeBinarySource}
                onValueChange={handleClaudeBinarySourceChange}
                options={[
                  { value: "auto", label: "Auto detect" },
                  { value: "managed", label: "Managed install" },
                  { value: "custom", label: "Custom path" },
                ]}
                className="w-44"
              />
            </SettingRow>

            {claudeBinarySource === "custom" && (
              <SettingRow
                label="Custom Claude path"
                description="Absolute path to claude executable (claude or claude.exe)."
              >
                <input
                  type="text"
                  value={claudeCustomBinaryPath}
                  onChange={(e) => setClaudeCustomBinaryPath(e.target.value)}
                  onBlur={(e) => handleClaudeCustomPathSave(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleClaudeCustomPathSave(e.currentTarget.value);
                  }}
                  spellCheck={false}
                  className="h-8 w-80 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
                  placeholder="Absolute path to claude executable"
                />
              </SettingRow>
            )}
          </SettingsSection>

          <SettingsSection icon={Server} label="Codex">
            <SettingRow
              label="Codex binary source"
              description="Choose how AstraDock resolves the Codex executable."
            >
              <SettingsSelect
                value={codexBinarySource}
                onValueChange={handleCodexBinarySourceChange}
                options={[
                  { value: "auto", label: "Auto detect" },
                  { value: "managed", label: "Managed download" },
                  { value: "custom", label: "Custom path" },
                ]}
                className="w-44"
              />
            </SettingRow>

            {codexBinarySource === "custom" && (
              <SettingRow
                label="Custom Codex path"
                description="Absolute path to codex executable (codex or codex.exe)."
              >
                <input
                  type="text"
                  value={codexCustomBinaryPath}
                  onChange={(e) => setCodexCustomBinaryPath(e.target.value)}
                  onBlur={(e) => handleCodexCustomPathSave(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCodexCustomPathSave(e.currentTarget.value);
                  }}
                  spellCheck={false}
                  className="h-8 w-80 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
                  placeholder="Absolute path to codex executable"
                />
              </SettingRow>
            )}

            <SettingRow
              label="Computer Use runtime"
              description="Let Claude, ACP agents, and Codex operate desktop apps through the independent Cua Driver MCP runtime. Applies to newly started sessions."
            >
              <Switch
                checked={computerUseEnabled}
                onCheckedChange={handleComputerUseToggle}
              />
            </SettingRow>

            {computerUseEnabled && (
              <SettingRow
                label="External Cua Driver path"
                description="Optional override for an external cua-driver executable. Leave empty to use the bundled native runtime."
              >
                <input
                  type="text"
                  value={computerUseBinaryPath}
                  onChange={(e) => setComputerUseBinaryPath(e.target.value)}
                  onBlur={(e) => {
                    const next = e.currentTarget.value.trim();
                    setComputerUseBinaryPath(next);
                    void onUpdateAppSettings({ computerUseBinaryPath: next });
                  }}
                  spellCheck={false}
                  className="h-8 w-80 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
                  placeholder="Bundled runtime"
                />
              </SettingRow>
            )}

            {computerUseEnabled && computerUseStatusText && (
              <SettingRow
                label="Computer Use status"
                description={computerUseStatusText}
              >
                <button
                  type="button"
                  onClick={() => void refreshComputerUseStatus()}
                  disabled={computerUseChecking}
                  aria-label="Refresh Computer Use status"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-foreground/10 px-2.5 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${computerUseChecking ? "animate-spin" : ""}`} />
                  Retry
                </button>
              </SettingRow>
            )}
          </SettingsSection>

          <SettingsSection icon={Server} label="OpenCode">
            <SettingRow
              label="OpenCode executable path"
              description="Optional absolute path used to launch OpenCode ACP. Leave empty to use PATH."
            >
              <input
                type="text"
                value={opencodeCustomBinaryPath}
                onChange={(e) => setOpencodeCustomBinaryPath(e.target.value)}
                onBlur={(e) => handleOpencodeCustomPathSave(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleOpencodeCustomPathSave(e.currentTarget.value);
                }}
                spellCheck={false}
                className="h-8 w-80 rounded-md border border-foreground/10 bg-background px-2.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:border-foreground/20 focus:border-foreground/30 focus:ring-1 focus:ring-foreground/20"
                placeholder="/opt/homebrew/bin/opencode"
              />
            </SettingRow>
          </SettingsSection>
        </div>
      </ScrollArea>
    </div>
  );
});
