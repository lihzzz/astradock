/**
 * Settings types shared between electron and renderer processes.
 *
 * Canonical definitions — import from here, never redefine.
 */

// ── Simple scalar types ──

export type PreferredEditor = "auto" | "cursor" | "code" | "zed";
export type VoiceDictationMode = "native" | "whisper";
/** UI language. Chinese is the first-run default. */
export type Language = "zh-CN" | "en-US";
export type ThemeOption = "light" | "dark" | "system";
/**
 * Renderer-only theme preference. "auto" resolves to light/dark by local time
 * and must never be sent to the main process (nativeTheme accepts only ThemeOption).
 */
export type ThemePreference = ThemeOption | "auto";
/** UI information density. "comfortable" is the default layout. */
export type DensityOption = "compact" | "comfortable" | "loose";
/** UI motion level. "auto" follows the OS prefers-reduced-motion setting. */
export type MotionLevelOption = "auto" | "full" | "reduced";
export type MacBackgroundEffect = "liquid-glass" | "vibrancy" | "off";
export type EngineBinarySource = "auto" | "custom";
export type CodexBinarySource = EngineBinarySource;
export type ClaudeBinarySource = EngineBinarySource;

/** Installed executables stay in their original directories with their helpers. */
export interface EngineBinaryCandidate {
  path: string;
  version: string | null;
}

export interface EngineBinaryScanResult {
  candidates: EngineBinaryCandidate[];
  selectedPath: string | null;
  error?: string;
}
import type { MemorySettings } from "./memory";
import type { GlobalShortcutSettings, QuickCaptureTarget } from "./productivity";

// ── Notification settings ──

export type NotificationTrigger = "always" | "unfocused" | "never";

export interface NotificationEventSettings {
  osNotification: NotificationTrigger;
  sound: NotificationTrigger;
}

export interface NotificationSettings {
  exitPlanMode: NotificationEventSettings;
  permissions: NotificationEventSettings;
  askUserQuestion: NotificationEventSettings;
  sessionComplete: NotificationEventSettings;
}

// ── Main AppSettings interface ──

/** Main-process app settings (persisted to JSON file in data dir). */
export interface AppSettings {
  globalShortcuts: GlobalShortcutSettings;
  quickCaptureTarget: QuickCaptureTarget | null;
  history: { semanticEnabled: boolean; embeddingModelKey: string | null };
  /** Number of recent chats to show per project in the sidebar (default: 10) */
  defaultChatLimit: number;
  /** Preferred code editor for "Open in Editor" actions (default: "auto") */
  preferredEditor: PreferredEditor;
  /** Voice dictation mode: "native" uses OS dictation, "whisper" uses local AI model (default: "native") */
  voiceDictation: VoiceDictationMode;
  /** Per-event notification and sound configuration */
  notifications: NotificationSettings;
  /** Custom client name sent to Codex servers during handshake (default: "AstraDock") */
  codexClientName: string;
  /** Which Codex binary source to use */
  codexBinarySource: CodexBinarySource;
  /** Enable Codex's experimental desktop Computer Use feature for new sessions */
  codexComputerUseEnabled: boolean;
  /** Enable the engine-independent Cua Driver MCP runtime for new sessions */
  computerUseEnabled: boolean;
  /** Optional absolute path to the Cua Driver executable; empty uses PATH */
  computerUseBinaryPath: string;
  /** Absolute path used when codexBinarySource is custom */
  codexCustomBinaryPath: string;
  /** Which Claude binary source to use */
  claudeBinarySource: ClaudeBinarySource;
  /** Absolute path used when claudeBinarySource is custom */
  claudeCustomBinaryPath: string;
  /** Absolute path to the OpenCode executable when the desktop PATH cannot resolve it */
  opencodeCustomBinaryPath: string;
  /** Show developer-only "Dev Fill" button in chat title bar (local dev builds only) */
  showDevFillInChatTitleBar: boolean;
  /** Preferred native macOS background material when window transparency is enabled */
  macBackgroundEffect: MacBackgroundEffect;
  /** Enable anonymous analytics to help improve the app (default: true) */
  analyticsEnabled: boolean;
  /** Anonymous user ID for analytics (auto-generated) */
  analyticsUserId?: string;
  /** Last date (YYYY-MM-DD) when daily_active_user was sent */
  analyticsLastDailyActiveDate?: string;
  /** Local Hindsight long-term memory configuration. API keys live in an encrypted main-process store. */
  memory: MemorySettings;
}
