import { memo, useState, useCallback, useEffect } from "react";
import {
  SlidersHorizontal,
  Bell,
  Bot,
  Plug,
  Cpu,
  Wrench,
  Palette,
  Sparkles,
  BarChart3,
  PanelLeft,
  Archive,
  Brain,
  Search,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentSettings } from "@/components/settings/AgentSettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { GeneralSettings } from "@/components/settings/GeneralSettings";
import { NotificationsSettings } from "@/components/settings/NotificationsSettings";
import { McpSettings } from "@/components/settings/McpSettings";
import { AdvancedSettings } from "@/components/settings/AdvancedSettings";
import { EngineSettings } from "@/components/settings/EngineSettings";
import { AnalyticsSettings } from "@/components/settings/AnalyticsSettings";
import { useSettingsStore } from "@/stores/settings-store";
import { isMac } from "@/lib/utils";
import type { AppSettings } from "@/types";
import type { ChatSession, InstalledAgent, Project } from "@/types";
import { useAgentContext } from "./AgentContext";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { ArchivedSettings } from "@/components/settings/ArchivedSettings";
import { MemorySettings } from "@/components/settings/MemorySettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { HistorySettings } from "@/components/settings/HistorySettings";

// ── Section definitions ──

export type SettingsSection = "general" | "appearance" | "notifications" | "analytics" | "agents" | "mcp" | "engines" | "memory" | "skills" | "advanced" | "archived" | "history";

interface NavItem {
  id: SettingsSection;
  labelKey: TranslationKey;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { id: "general", labelKey: "general", icon: SlidersHorizontal },
  { id: "appearance", labelKey: "appearance", icon: Palette },
  { id: "notifications", labelKey: "notifications", icon: Bell },
  { id: "analytics", labelKey: "analytics", icon: BarChart3 },
  { id: "agents", labelKey: "acpAgents", icon: Bot },
  { id: "mcp", labelKey: "mcpServers", icon: Plug },
  { id: "engines", labelKey: "engines", icon: Cpu },
  { id: "memory", labelKey: "memory", icon: Brain },
  { id: "history", labelKey: "Conversation history", icon: Search },
  { id: "skills", labelKey: "skills", icon: Sparkles },
  { id: "advanced", labelKey: "advanced", icon: Wrench },
  { id: "archived", labelKey: "archived", icon: Archive },
];

// ── Props ──

interface SettingsViewProps {
  onClose: () => void;
  glassSupported: boolean;
  macLiquidGlassSupported: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  /** Resets the welcome wizard so it shows again. Dev-only. */
  onReplayWelcome: () => void;
  /** Open directly to a specific section (e.g. "agents" from the engine picker). */
  initialSection?: SettingsSection;
  sessions: ChatSession[];
  projects: Project[];
  activeSessionId: string | null;
  agents?: InstalledAgent[];
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  onRenameSession: (id: string, title: string) => void;
  onOpenInSplitView?: (id: string) => void;
  canOpenInSplitView?: (id: string) => boolean;
}

// ── Component ──

export const SettingsView = memo(function SettingsView({
  onClose,
  glassSupported,
  macLiquidGlassSupported,
  sidebarOpen = false,
  onToggleSidebar,
  onReplayWelcome,
  initialSection,
  sessions,
  projects,
  activeSessionId,
  agents: sessionAgents,
  onSelectSession,
  onDeleteSession,
  onArchiveSession,
  onRenameSession,
  onOpenInSplitView,
  canOpenInSplitView,
}: SettingsViewProps) {
  const { agents, saveAgent, deleteAgent } = useAgentContext();
  const { t } = useI18n();
  const islandLayout = useSettingsStore((s) => s.islandLayout);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection ?? "general");
  const macIslandTitlebarOffsetClass = "";

  // ── Main-process app settings (loaded once, updated optimistically) ──
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    window.claude.settings.get().then((s: AppSettings | null) => {
      if (s) setAppSettings(s);
    });
    return window.claude.settings.onChanged(setAppSettings);
  }, []);

  const updateAppSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const result = await window.claude.settings.set(patch);
    if (result.error) throw new Error(result.error);
    setAppSettings(await window.claude.settings.get());
  }, []);

  // Escape key closes settings
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const renderSection = useCallback(() => {
    switch (activeSection) {
      case "history":
        return <HistorySettings appSettings={appSettings} onUpdateAppSettings={updateAppSettings} />;
      case "general":
        return (
          <GeneralSettings
            appSettings={appSettings}
            onUpdateAppSettings={updateAppSettings}
          />
        );
      case "appearance":
        return (
          <AppearanceSettings
            glassSupported={glassSupported}
            macLiquidGlassSupported={macLiquidGlassSupported}
          />
        );
      case "notifications":
        return (
          <NotificationsSettings
            appSettings={appSettings}
            onUpdateAppSettings={updateAppSettings}
          />
        );
      case "analytics":
        return (
          <AnalyticsSettings
            appSettings={appSettings}
            onUpdateAppSettings={updateAppSettings}
          />
        );
      case "agents":
        return (
          <AgentSettings
            agents={agents}
            onSave={saveAgent}
            onDelete={deleteAgent}
          />
        );
      case "mcp":
        return <McpSettings />;
      case "engines":
        return (
          <EngineSettings
            appSettings={appSettings}
            onUpdateAppSettings={updateAppSettings}
          />
        );
      case "memory":
        return (
          <MemorySettings
            appSettings={appSettings}
            onUpdateAppSettings={updateAppSettings}
            projectId={sessions.find((session) => session.id === activeSessionId)?.projectId}
          />
        );
      case "advanced":
        return (
          <AdvancedSettings
            appSettings={appSettings}
            onUpdateAppSettings={updateAppSettings}
            onReplayWelcome={onReplayWelcome}
          />
        );
      case "archived":
        return (
          <ArchivedSettings
            sessions={sessions}
            projects={projects}
            activeSessionId={activeSessionId}
            agents={sessionAgents}
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
            onArchiveSession={onArchiveSession}
            onRenameSession={onRenameSession}
            onOpenInSplitView={onOpenInSplitView}
            canOpenInSplitView={canOpenInSplitView}
            islandLayout={islandLayout}
          />
        );
      case "skills":
        return <SkillsSettings />;
      default:
        return null;
    }
  }, [activeSection, appSettings, updateAppSettings, agents, saveAgent, deleteAgent, glassSupported, macLiquidGlassSupported, onReplayWelcome, sessions, activeSessionId, sessionAgents, onSelectSession, onDeleteSession, onArchiveSession, onRenameSession, onOpenInSplitView, canOpenInSplitView, islandLayout]);

  return (
    <div className={`island flex flex-1 flex-col overflow-hidden bg-background ${islandLayout ? "rounded-[var(--island-radius)]" : "rounded-none"}`}>
      <div
        className={`drag-region flex shrink-0 items-center border-b border-foreground/[0.06] ${
          islandLayout ? "h-[2.375rem] px-4" : "h-[3.25rem] px-4"
        } ${
          !sidebarOpen && isMac ? (islandLayout ? "ps-[78px]" : "ps-[84px]") : ""
        }`}
      >
        {onToggleSidebar && !sidebarOpen && (
          <Button
            variant="ghost"
            size="icon"
            className={`no-drag me-2 h-7 w-7 text-muted-foreground/60 hover:text-foreground ${macIslandTitlebarOffsetClass}`}
            onClick={onToggleSidebar}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        )}
        <span className={`leading-none text-sm font-semibold text-foreground ${macIslandTitlebarOffsetClass}`}>{t("settings")}</span>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Settings nav sidebar */}
        <div className="flex w-44 shrink-0 flex-col border-e border-foreground/[0.06]">
          {/* Nav items */}
          <nav className="flex flex-1 flex-col gap-0.5 px-1.5 py-2">
            {NAV_ITEMS.map((item) => {
              const isActive = activeSection === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
                  className={`flex w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-[13px] text-start transition-colors ${
                    isActive
                      ? "bg-foreground/[0.06] font-medium text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Content area — centered container with max width */}
        <div className="flex min-w-0 flex-1 justify-center overflow-hidden">
          <div className="flex h-full w-full max-w-3xl flex-col">
            {renderSection()}
          </div>
        </div>
      </div>
    </div>
  );
});
