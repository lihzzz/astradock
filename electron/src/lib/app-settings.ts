/**
 * Main-process settings store — JSON file in the app data directory.
 *
 * Unlike useSettings (renderer localStorage), this store is readable at
 * startup before any BrowserWindow exists. Use it for settings that the
 * main process needs synchronously at startup.
 *
 * File location: {userData}/openacpui-data/settings.json (kept as openacpui-data for backward compat)
 */

import path from "path";
import fs from "fs";
import { getDataDir } from "./data-dir";
import type { AppSettings, EngineBinarySource, NotificationSettings } from "@shared/types/settings";
import type { MemorySettings } from "@shared/types/memory";
import { GLOBAL_SHORTCUT_DEFAULTS, HISTORY_DEFAULTS, mergeGlobalShortcuts, mergeHistorySettings, parseQuickCaptureTarget } from "@shared/lib/productivity-settings";

// Re-export shared types so existing `import from "./app-settings"` consumers still work
export type { AppSettings, MacBackgroundEffect, PreferredEditor, VoiceDictationMode, NotificationTrigger, NotificationEventSettings, NotificationSettings, CodexBinarySource, ClaudeBinarySource } from "@shared/types/settings";

const NOTIFICATION_DEFAULTS: NotificationSettings = {
  exitPlanMode: { osNotification: "unfocused", sound: "always" },
  permissions: { osNotification: "unfocused", sound: "unfocused" },
  askUserQuestion: { osNotification: "unfocused", sound: "always" },
  sessionComplete: { osNotification: "unfocused", sound: "always" },
};

const MEMORY_DEFAULTS: MemorySettings = {
  enabled: false,
  localPort: 8888,
  llmProvider: "anthropic",
  llmModel: "claude-sonnet-4-20250514",
  llmBaseUrl: "",
  injectionPolicy: "first-turn",
  autoRetain: false,
  clientSideRedact: true,
  recallBudget: "mid",
  recallMaxTokens: 1024,
  recallMaxItems: 5,
  recallTimeoutMs: 2000,
  memoryDefense: "redact",
};

const DEFAULTS: AppSettings = {
  globalShortcuts: GLOBAL_SHORTCUT_DEFAULTS,
  quickCaptureTarget: null,
  history: HISTORY_DEFAULTS,
  defaultChatLimit: 10,
  preferredEditor: "auto",
  voiceDictation: "native",
  notifications: NOTIFICATION_DEFAULTS,
  codexClientName: "AstraDock",
  codexBinarySource: "auto",
  codexComputerUseEnabled: false,
  computerUseEnabled: false,
  computerUseBinaryPath: "",
  codexCustomBinaryPath: "",
  claudeBinarySource: "auto",
  claudeCustomBinaryPath: "",
  opencodeCustomBinaryPath: "",
  showDevFillInChatTitleBar: false,
  macBackgroundEffect: "liquid-glass",
  analyticsEnabled: false,
  memory: MEMORY_DEFAULTS,
};

// ── Internal state ──

let cached: AppSettings | null = null;

/** Older installations stored "managed"; all unsupported values use the system installation. */
function normalizeBinarySource(value: unknown): EngineBinarySource {
  return value === "custom" ? "custom" : "auto";
}

function filePath(): string {
  return path.join(getDataDir(), "settings.json");
}

// ── Public API ──

/** Read the full settings object (cached after first read). */
export function getAppSettings(): AppSettings {
  if (cached) return cached;

  try {
    const raw = fs.readFileSync(filePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Merge with defaults so newly added keys are always present.
    // Deep-merge `notifications` so upgrading users get defaults for each event type
    // even if their settings.json has a partial or missing notifications object.
    const parsedNotif = parsed.notifications as Partial<NotificationSettings> | undefined;
    const parsedMemory = parsed.memory as Partial<MemorySettings> | undefined;
    const computerUseEnabled = typeof parsed.computerUseEnabled === "boolean"
      ? parsed.computerUseEnabled
      : parsed.codexComputerUseEnabled === true;
    cached = {
      ...DEFAULTS,
      ...parsed,
      codexBinarySource: normalizeBinarySource(parsed.codexBinarySource),
      claudeBinarySource: normalizeBinarySource(parsed.claudeBinarySource),
      globalShortcuts: mergeGlobalShortcuts(parsed.globalShortcuts),
      quickCaptureTarget: parseQuickCaptureTarget(parsed.quickCaptureTarget),
      history: mergeHistorySettings(parsed.history),
      computerUseEnabled,
      notifications: {
        exitPlanMode: { ...NOTIFICATION_DEFAULTS.exitPlanMode, ...parsedNotif?.exitPlanMode },
        permissions: { ...NOTIFICATION_DEFAULTS.permissions, ...parsedNotif?.permissions },
        askUserQuestion: { ...NOTIFICATION_DEFAULTS.askUserQuestion, ...parsedNotif?.askUserQuestion },
        sessionComplete: { ...NOTIFICATION_DEFAULTS.sessionComplete, ...parsedNotif?.sessionComplete },
      },
      memory: { ...MEMORY_DEFAULTS, ...parsedMemory },
    };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

/** Read a single setting by key. */
export function getAppSetting<K extends keyof AppSettings>(key: K): AppSettings[K] {
  return getAppSettings()[key];
}

/** Update one or more settings and persist to disk. */
export function setAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getAppSettings();
  const next = {
    ...current,
    ...patch,
    codexBinarySource: normalizeBinarySource(patch.codexBinarySource ?? current.codexBinarySource),
    claudeBinarySource: normalizeBinarySource(patch.claudeBinarySource ?? current.claudeBinarySource),
    globalShortcuts: mergeGlobalShortcuts(patch.globalShortcuts, current.globalShortcuts),
    quickCaptureTarget: "quickCaptureTarget" in patch ? parseQuickCaptureTarget(patch.quickCaptureTarget) : current.quickCaptureTarget,
    history: mergeHistorySettings(patch.history, current.history),
    ...(patch.memory ? { memory: { ...current.memory, ...patch.memory } } : {}),
  };
  const destination = filePath();
  const temporary = `${destination}.${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf-8", flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  cached = next;
  return next;
}
