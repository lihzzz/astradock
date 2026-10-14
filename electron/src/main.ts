import "./lib/app-profile";
import { execSync } from "child_process";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, shell, systemPreferences, Tray, webContents } from "electron";
import path from "path";
import http from "http";
import contextMenu from "electron-context-menu";
import { getBootstrapMinWindowWidth } from "../../src/lib/layout/constants";
import { fitWindowToWorkArea } from "./lib/window-bounds";
import { isAllowedPreviewUrl } from "./lib/browser-safety";
import { prepareManagedQuit } from "./lib/app-quit";
import * as projectAppsIpc from "./ipc/project-apps";
import * as tasksIpc from "./ipc/tasks";
import { getProjectAppsService } from "./lib/project-apps";
import { shutdownProjectAppAgentBridge } from "./lib/project-apps/agent-bridge";

// Packaged .app bundles launched from Finder get a minimal PATH (/usr/bin:/bin).
// Inherit the user's shell PATH so child processes (SDK's `node`, git, etc.) resolve.
if (process.platform !== "win32") {
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const shellPath = execSync(`${shell} -ilc 'echo -n "$PATH"'`, {
      encoding: "utf8",
      timeout: 5000,
    });
    if (shellPath) process.env.PATH = shellPath;
  } catch {
    // Fall through — keep whatever PATH we already have
  }
}
import { log } from "./lib/logger";
import { reportError } from "./lib/error-utils";
import { migrateFromOpenAcpUi } from "./lib/migration";
import { glassEnabled, setGlassTint } from "./lib/glass";
import { createBackgroundEffects } from "./lib/background-effects";
import { getAppSettings } from "./lib/app-settings";
import { initPostHog, shutdownPostHog, reinitPostHog, captureEvent } from "./lib/posthog";
import { getAcpAnalyticsPropertiesForSession } from "./ipc/acp-sessions";
import { terminals } from "./ipc/terminal";

// IPC module registrations
import * as spacesIpc from "./ipc/spaces";
import * as projectsIpc from "./ipc/projects";
import * as sessionsIpc from "./ipc/sessions";
import * as sessionOperationsIpc from "./ipc/session-operations";
import * as historyIpc from "./ipc/history";
import { configureSessionStopper, configureProjectAppCleanup } from "./lib/session-service";
import { GlobalShortcuts } from "./lib/global-shortcuts";
import { QuickCapture } from "./lib/quick-capture";
import * as quickCaptureIpc from "./ipc/quick-capture";
import { safeSend } from "./lib/safe-send";
import * as foldersIpc from "./ipc/folders";
import * as ccImportIpc from "./ipc/cc-import";
import * as filesIpc from "./ipc/files";
import * as claudeSessionsIpc from "./ipc/claude-sessions";
import * as titleGenIpc from "./ipc/title-gen";
import * as composerPredictionIpc from "./ipc/composer-prediction";
import * as terminalIpc from "./ipc/terminal";
import * as gitIpc from "./ipc/git";
import * as agentRegistryIpc from "./ipc/agent-registry";
import * as acpSessionsIpc from "./ipc/acp-sessions";
import * as codexSessionsIpc from "./ipc/codex-sessions";
import { registerCodexFingerprintIpc } from "./ipc/codex-fingerprint";
import * as mcpIpc from "./ipc/mcp";
import * as settingsIpc from "./ipc/settings";
import * as memoryIpc from "./ipc/memory";
import * as skillsIpc from "./ipc/skills";
import * as usageIpc from "./ipc/usage";
import { shutdownUsage } from "./lib/usage";
import { onSettingsChanged } from "./ipc/settings";
import { getComputerUseRuntimeStatus, requestComputerUsePermissions } from "./lib/computer-use-runtime";

// --- Performance: Chromium/V8 flags (must be set before app.whenReady()) ---
if (!app.requestSingleInstanceLock()) app.exit(0);
app.commandLine.appendSwitch("enable-gpu-rasterization"); // force GPU raster for all content
app.commandLine.appendSwitch("enable-zero-copy"); // avoid CPU→GPU memory copies for tiles
app.commandLine.appendSwitch("enable-features", [app.commandLine.getSwitchValue("enable-features"), "CanvasOopRasterization", ...(process.platform === "linux" ? ["GlobalShortcutsPortal"] : [])].filter(Boolean).join(","));

// --- Liquid Glass command-line switches ---
if (glassEnabled) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222");
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

let mainWindow: BrowserWindow | null = null;
let preferredMinimumWidth = getBootstrapMinWindowWidth(process.platform);
let fittingWindow = false;

function fitMainWindowToDisplay(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || fittingWindow) return;
  const bounds = window.getBounds();
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const fitted = fitWindowToWorkArea(bounds, workArea, { width: preferredMinimumWidth, height: 600 });
  fittingWindow = true;
  try {
    const [minWidth, minHeight] = window.getMinimumSize();
    if (minWidth !== fitted.minimumWidth || minHeight !== fitted.minimumHeight) {
      window.setMinimumSize(fitted.minimumWidth, fitted.minimumHeight);
    }
    // Preserve native maximize/fullscreen behavior, while keeping restored windows reachable.
    if (!window.isMaximized() && !window.isFullScreen()
      && (bounds.x !== fitted.bounds.x || bounds.y !== fitted.bounds.y
        || bounds.width !== fitted.bounds.width || bounds.height !== fitted.bounds.height)) {
      window.setBounds(fitted.bounds);
    }
  } finally { fittingWindow = false; }
}
let quitting = false;
let tray: Tray | null = null;
const quickCapture = new QuickCapture((request) => safeSend(getMainWindow, "quick-capture:requested", request));
const globalInputShortcuts = new GlobalShortcuts(globalShortcut, (action) => {
  showMainWindow();
  quickCapture.capture(action, () => clipboard.readText(), getAppSettings().quickCaptureTarget);
}, process.platform);
const backgroundEffects = createBackgroundEffects(() => mainWindow);

import type { ThemeOption, MacBackgroundEffect as SharedMacBackgroundEffect } from "@shared/types/settings";

/** Transparency is tracked separately from the preferred macOS material. */
type MacBackgroundEffect = Exclude<SharedMacBackgroundEffect, "off">;

function normalizeThemeSource(value: unknown): ThemeOption {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

function normalizeMacBackgroundEffect(value: unknown): MacBackgroundEffect {
  return value === "vibrancy" ? "vibrancy" : "liquid-glass";
}

function getMacBackgroundEffectSupport(): { liquidGlass: boolean; vibrancy: boolean } {
  return {
    liquidGlass: glassEnabled,
    vibrancy: process.platform === "darwin",
  };
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const window = mainWindow;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function updateRecoveryEntry(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: "Show AstraDock", click: showMainWindow },
    { label: "Quit AstraDock", click: () => app.quit() },
  ];
  if (process.platform === "darwin") { app.dock?.setMenu(Menu.buildFromTemplate(template)); return; }
  if (!getAppSettings().globalShortcuts.enabled) { tray?.destroy(); tray = null; return; }
  if (tray) return;
  try {
    const iconPath = app.isPackaged ? path.join(process.resourcesPath, "astradock-tray.png") : path.join(__dirname, "../../build/icon.png");
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Tray icon is unavailable");
    tray = new Tray(icon.resize({ width: 20, height: 20 }));
    tray.setToolTip("AstraDock");
    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.on("double-click", showMainWindow);
  } catch (error) { reportError("SHORTCUTS:TRAY_ERR", error); tray = null; }
}

app.on("second-instance", showMainWindow);
app.on("activate", () => { if (app.isReady()) showMainWindow(); });
let managedQuitApproved = false;
let preparingQuit = false;
app.on("before-quit", (event) => {
  if (managedQuitApproved) { quitting = true; return; }
  event.preventDefault();
  if (preparingQuit) return;
  preparingQuit = true;
  void prepareManagedQuit({
    stop: () => getProjectAppsService().shutdown(),
    onFailure: async (error) => {
      reportError("PROJECT_APPS:QUIT", error);
      const chinese = app.getLocale().startsWith("zh");
      const response = await dialog.showMessageBox({
        type: "error", title: "AstraDock",
        message: chinese ? "部分应用未能停止，AstraDock 暂时保留运行。" : "Some applications could not be stopped. AstraDock is still running.",
        detail: error instanceof Error ? error.message : String(error),
        buttons: chinese ? ["重试", "取消退出", "强制退出"] : ["Retry", "Cancel quit", "Force quit"],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      return response.response === 0 ? "retry" : response.response === 2 ? "force" : "cancel";
    },
  }).then((approved) => {
    if (!approved) { showMainWindow(); return; }
    managedQuitApproved = true;
    quitting = true;
    app.quit();
  }).catch((error) => { reportError("PROJECT_APPS:QUIT", error); showMainWindow(); })
    .finally(() => { preparingQuit = false; });
});

function isMainRendererPermissionRequest(webContents: Electron.WebContents | null): boolean {
  return !!webContents && webContents.id === mainWindow?.webContents.id;
}

const DEV_SERVER_URL = "http://localhost:5173";

function waitForDevServer(url: string, timeoutMs = 750): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Dev server returned HTTP ${response.statusCode ?? "unknown"}`));
      }
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Dev server probe timed out"));
    });
    request.once("error", reject);
  });
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  if (app.isPackaged) {
    await window.loadFile(path.join(__dirname, "../../dist/index.html"));
    return;
  }

  // Vite and Electron are started concurrently. Wait for Vite instead of
  // letting a transient connection-refused error leave a transparent window blank.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (window.isDestroyed()) return;
    try {
      await waitForDevServer(DEV_SERVER_URL);
      await window.loadURL(DEV_SERVER_URL);
      return;
    } catch (error) {
      if (attempt === 39) {
        log("RENDERER", { message: "Failed to load Vite dev server", error });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function createWindow(): void {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  preferredMinimumWidth = getBootstrapMinWindowWidth(process.platform);
  const initial = fitWindowToWorkArea({
    x: workArea.x + Math.max(0, Math.round((workArea.width - 1200) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - 800) / 2)),
    width: 1200, height: 800,
  }, workArea, { width: preferredMinimumWidth, height: 600 });
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    show: false,
    ...initial.bounds,
    // Matches the renderer's stricter island-layout minimum before first IPC sync,
    // including the extra Windows frame buffer.
    minWidth: initial.minimumWidth,
    minHeight: initial.minimumHeight,
    // Packaged builds get the icon from the .app bundle / electron-builder config
    ...(!app.isPackaged && { icon: path.join(__dirname, "../../build/icon.png") }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      devTools: !glassEnabled,
      v8CacheOptions: "bypassHeatCheckAndEagerCompile", // cache compiled JS on first run — eliminates cold-start jank
    },
  };

  if (process.platform === "darwin") {
    windowOptions.titleBarStyle = "hidden";
    const fallback = backgroundEffects.getState().fallbackReason;
    windowOptions.transparent = fallback !== "low-memory" && fallback !== "low-cpu";
    windowOptions.backgroundColor = windowOptions.transparent ? "#00000000" : "#141414";
    windowOptions.trafficLightPosition = { x: 19, y: 19 };
  } else if (process.platform === "win32") {
    // Enable Mica Alt only after the hardware policy and saved preference are known.
    windowOptions.autoHideMenuBar = true;
    windowOptions.backgroundColor = "#141414";
  } else {
    // Linux uses an in-app Gaussian backdrop, so no transparent native window is needed.
    windowOptions.titleBarStyle = "hiddenInset";
    windowOptions.trafficLightPosition = { x: 19, y: 19 };
    windowOptions.backgroundColor = "#141414";
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.on("close", (event) => {
    const shortcuts = getAppSettings().globalShortcuts;
    if (!quitting && shortcuts.enabled && shortcuts.keepAliveOnClose && (process.platform === "darwin" || tray)) {
      event.preventDefault();
      mainWindow?.hide();
    } else if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  mainWindow.on("session-end", () => { quitting = true; });
  mainWindow.on("query-session-end", () => { quitting = true; });
  mainWindow.on("closed", () => { mainWindow = null; });
  mainWindow.on("moved", fitMainWindowToDisplay);
  mainWindow.on("unmaximize", fitMainWindowToDisplay);
  mainWindow.on("leave-full-screen", fitMainWindowToDisplay);
  backgroundEffects.refresh();

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  contextMenu({
    window: mainWindow,
    showSearchWithGoogle: false,
    showLookUpSelection: false,
    showInspectElement: false,
  });

  void loadRenderer(mainWindow).catch((error) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    log("RENDERER", { message: "Renderer failed to load", error });
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedPreviewUrl(url) && url !== "about:blank") void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    event.preventDefault();
    if (isAllowedPreviewUrl(url) && url !== "about:blank") void shell.openExternal(url);
  });

  mainWindow.webContents.on("will-attach-webview", (event, preferences, params) => {
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.nodeIntegrationInSubFrames = false;
    preferences.contextIsolation = true;
    preferences.sandbox = true;
    preferences.webSecurity = true;
    if (!isAllowedPreviewUrl(params.src)) event.preventDefault();
  });
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (isAllowedPreviewUrl(url) && url !== "about:blank") void shell.openExternal(url);
      return { action: "deny" };
    });
    guest.on("will-navigate", (event, url) => { if (!isAllowedPreviewUrl(url)) event.preventDefault(); });
    guest.on("will-redirect", (event, url) => { if (!isAllowedPreviewUrl(url)) event.preventDefault(); });
  });

  mainWindow.webContents.on("did-finish-load", () => backgroundEffects.refresh());
}

// Renderer uses this to decide whether the transparency toggle is available.
ipcMain.handle("app:getGlassSupported", () => {
  return backgroundEffects.getState().availableEffect !== null;
});

ipcMain.handle("app:get-background-effect", () => backgroundEffects.getState());
ipcMain.handle("app:set-transparency", (event, enabled: unknown) => {
  if (event.sender !== mainWindow?.webContents || typeof enabled !== "boolean") return backgroundEffects.getState();
  return backgroundEffects.setTransparency(enabled);
});

ipcMain.handle("app:get-mac-background-effect-support", () => {
  return getMacBackgroundEffectSupport();
});

ipcMain.handle("computer-use:status", () => getComputerUseRuntimeStatus());
ipcMain.handle("computer-use:request-permissions", () => requestComputerUsePermissions());

ipcMain.on("app:set-theme-source", (_event, themeSource: unknown) => {
  nativeTheme.themeSource = normalizeThemeSource(themeSource);
});

ipcMain.on("app:set-mac-background-effect", (_event, effect: unknown) => {
  backgroundEffects.setMacEffect(normalizeMacBackgroundEffect(effect));
});

ipcMain.handle("app:relaunch", () => {
  try {
    app.relaunch();
    app.quit();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reportError("APP_RELAUNCH", err) };
  }
});

ipcMain.handle("clipboard:write-text", (_event, text: string) => {
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reportError("CLIPBOARD_WRITE", err) };
  }
});

ipcMain.handle("browser:set-color-scheme", async (_event, payload: { targetWebContentsId: number; colorScheme: "light" | "dark" }) => {
  try {
    const targetId = payload?.targetWebContentsId;
    const colorScheme = payload?.colorScheme;

    if (!Number.isInteger(targetId)) {
      return { ok: false, error: "Invalid target webContents id" };
    }
    if (colorScheme !== "light" && colorScheme !== "dark") {
      return { ok: false, error: "Invalid browser color scheme" };
    }

    const target = webContents.fromId(targetId);
    if (!target || target.isDestroyed()) {
      return { ok: false, error: "Browser target is unavailable" };
    }

    if (!target.debugger.isAttached()) {
      target.debugger.attach("1.3");
    }

    await target.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: colorScheme }],
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: reportError("BROWSER_COLOR_SCHEME", err) };
  }
});

// Dynamic minimum window width — renderer calculates based on which panels are open.
// Also expands the window if it's currently smaller than the new minimum (e.g. Tasks
// panel appeared while at min size), so content never overflows off-screen.
ipcMain.on("app:set-min-width", (_event, minWidth: number) => {
  if (mainWindow && Number.isFinite(minWidth) && minWidth >= 600) {
    preferredMinimumWidth = Math.min(Math.round(minWidth), 4000);
    fitMainWindowToDisplay();
  }
});

// Native glass tint — re-creates glass view with updated tintColor.
// The C++ addon auto-cleans previous views in a single dispatch_sync block.
const GLASS_TINT_RE = /^#[0-9a-fA-F]{8}$/;
ipcMain.on("glass:set-tint-color", (_event, tintColor: string | null) => {
  if (backgroundEffects.getState().effect !== "liquid-glass") return;
  if (tintColor !== null && (typeof tintColor !== "string" || !GLASS_TINT_RE.test(tintColor))) {
    log("GLASS", `Ignoring invalid tintColor: ${String(tintColor)}`);
    return;
  }
  const viewId = setGlassTint(tintColor);
  if (viewId >= 0) {
    log("GLASS", `setTintColor=${tintColor}, viewId=${viewId}`);
  }
});

// Glass appearance — force light/dark/system on the native layer so the
// glass effect follows the app's theme setting, not just the OS preference.
ipcMain.on("glass:set-theme", (_event, theme: string) => {
  if (theme === "light" || theme === "dark" || theme === "system") {
    nativeTheme.themeSource = theme;
  }
});

// --- Register all IPC modules ---
spacesIpc.register();
projectsIpc.register(getMainWindow);
projectAppsIpc.register(getMainWindow);
tasksIpc.register(getMainWindow);
configureProjectAppCleanup((projectId) => getProjectAppsService().removeProject(projectId));
sessionsIpc.register();
sessionOperationsIpc.register(getMainWindow);
historyIpc.register(getMainWindow);
configureSessionStopper(async (runtimeIds, meta) => {
  for (const id of runtimeIds) {
    if (meta.engine === "codex") await codexSessionsIpc.stopForDeletion(id);
    else if (meta.engine === "acp") await acpSessionsIpc.stopForDeletion(id);
    else await claudeSessionsIpc.stopForDeletion(id);
  }
});
foldersIpc.register();
ccImportIpc.register();
filesIpc.register(getMainWindow);
claudeSessionsIpc.register(getMainWindow);
titleGenIpc.register();
composerPredictionIpc.register();
terminalIpc.register(getMainWindow);
gitIpc.register();
agentRegistryIpc.register();
acpSessionsIpc.register(getMainWindow);
codexSessionsIpc.register(getMainWindow);
registerCodexFingerprintIpc();
mcpIpc.register();
settingsIpc.register(getMainWindow);
settingsIpc.configureShortcutSettings((settings, persist) => globalInputShortcuts.apply(settings, persist));
quickCaptureIpc.register(getMainWindow, quickCapture, globalInputShortcuts);
memoryIpc.register(getMainWindow);
skillsIpc.register();
usageIpc.register(getMainWindow);

// Listen for analytics settings changes and reinitialize PostHog
let lastAnalyticsEnabled: boolean | undefined;
onSettingsChanged((settings) => {
  if (app.isReady()) updateRecoveryEntry();
  if (process.platform === "darwin") {
    backgroundEffects.setMacEffect(normalizeMacBackgroundEffect(settings.macBackgroundEffect));
  }
  if (lastAnalyticsEnabled !== undefined && settings.analyticsEnabled !== lastAnalyticsEnabled) {
    lastAnalyticsEnabled = settings.analyticsEnabled;
    reinitPostHog().catch((err) => {
      reportError("POSTHOG", err, { context: "reinitialize" });
    });
  } else {
    lastAnalyticsEnabled = settings.analyticsEnabled;
  }
});

// --- Renderer→main analytics bridge ---
ipcMain.on("analytics:capture", (_event, eventName: string, properties?: Record<string, unknown>) => {
  const nextProperties: Record<string, unknown> = properties ? { ...properties } : {};
  const sessionId = typeof nextProperties.session_id === "string" ? nextProperties.session_id : null;
  delete nextProperties.session_id;

  if (nextProperties.engine === "acp" && sessionId) {
    Object.assign(nextProperties, getAcpAnalyticsPropertiesForSession(sessionId) ?? {});
  }

  captureEvent(eventName, nextProperties).catch(() => { /* non-fatal */ });
});

// --- DevTools in separate window via remote debugging ---
let devToolsWindow: BrowserWindow | null = null;

function openDevToolsWindow(): void {
  if (!glassEnabled) {
    mainWindow?.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    devToolsWindow.focus();
    return;
  }

  http.get("http://127.0.0.1:9222/json", (res) => {
    let body = "";
    res.on("data", (chunk: Buffer) => { body += chunk; });
    res.on("end", () => {
      try {
        const targets = JSON.parse(body) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((t) => t.type === "page");
        if (!page) {
          log("DEVTOOLS", "No debuggable page target found");
          return;
        }

        const wsUrl = page.webSocketDebuggerUrl;
        if (!wsUrl) {
          log("DEVTOOLS", "No webSocketDebuggerUrl in target");
          return;
        }

        const wsParam = encodeURIComponent(wsUrl.replace("ws://", ""));
        const fullUrl = `devtools://devtools/bundled/inspector.html?ws=${wsParam}`;

        devToolsWindow = new BrowserWindow({
          width: 1000,
          height: 700,
          title: "AstraDock DevTools",
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
          },
        });

        devToolsWindow.loadURL(fullUrl);
        devToolsWindow.on("closed", () => {
          devToolsWindow = null;
        });

        log("DEVTOOLS", `Opened DevTools window: ${fullUrl}`);
      } catch (err) {
        reportError("DEVTOOLS_ERR", err, { context: "parse-targets" });
      }
    });
  }).on("error", (err) => {
    reportError("DEVTOOLS_ERR", err, { context: "remote-debugging" });
  });
}

// --- App lifecycle ---
// --- Speech dictation IPC ---
ipcMain.handle("speech:start-native-dictation", () => {
  if (process.platform === "darwin") {
    // Sends the macOS Cocoa selector to start native dictation in the focused text field
    Menu.sendActionToFirstResponder("startDictation:");
    return { ok: true };
  }
  return { ok: false, reason: "not-supported" };
});

ipcMain.handle("speech:get-platform", () => process.platform);

ipcMain.handle("speech:request-mic-permission", async () => {
  if (process.platform === "darwin") {
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "granted") return { granted: true };
    const granted = await systemPreferences.askForMediaAccess("microphone");
    return { granted };
  }
  // Windows/Linux don't require Electron-level mic permission — getUserMedia handles it
  return { granted: true };
});

app.whenReady().then(() => {
  // Migrate data from old "OpenACP UI" app directory before anything reads it
  migrateFromOpenAcpUi();
  if (process.platform === "darwin") {
    backgroundEffects.setMacEffect(normalizeMacBackgroundEffect(getAppSettings().macBackgroundEffect));
  }

  createWindow();
  screen.on("display-metrics-changed", fitMainWindowToDisplay);
  screen.on("display-removed", fitMainWindowToDisplay);
  powerMonitor.on("resume", () => { void getProjectAppsService().recheckHealth().catch((error) => reportError("PROJECT_APPS:RESUME", error)); });

  // Restore an explicitly enabled memory daemon in the background. If its
  // dependency is unavailable, the memory service remains fail-safe and the
  // settings panel exposes the installation/retry action.
  if (getAppSettings().memory.enabled) {
    void import("./lib/memory/daemon").then(({ startMemoryDaemon }) => startMemoryDaemon()).catch((error) => {
      reportError("MEMORY_DAEMON_STARTUP", error);
    });
  }

  // Initialize PostHog analytics (if enabled in settings) — fire-and-forget to avoid blocking startup
  initPostHog().catch((err) => {
    reportError("POSTHOG", err, { context: "startup-init" });
  });

  // Allow microphone access for Whisper voice dictation (getUserMedia in renderer)
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      // Only grant privileged permissions to the app's main renderer, not webviews.
      if (isMainRendererPermissionRequest(webContents) && (permission === "media" || permission === "notifications")) {
        callback(true);
        return;
      }
      callback(false);
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) => {
      if (isMainRendererPermissionRequest(webContents) && (permission === "media" || permission === "notifications")) {
        return true;
      }
      return false;
    },
  );

  // Set dock icon in dev mode — packaged builds get it from the .app bundle
  if (!app.isPackaged && process.platform === "darwin" && app.dock) {
    app.dock.setIcon(path.join(__dirname, "../../build/icon.png"));
  }

  const shortcuts = ["CommandOrControl+Alt+I", "F12", "CommandOrControl+Shift+J"];
  for (const shortcut of shortcuts) {
    const ok = globalShortcut.register(shortcut, () => {
      log("DEVTOOLS", `Shortcut ${shortcut} triggered`);
      openDevToolsWindow();
    });
    log("DEVTOOLS", `Register ${shortcut}: ${ok ? "OK" : "FAILED"}`);
  }
  globalInputShortcuts.initialize(getAppSettings().globalShortcuts);
  updateRecoveryEntry();
});

app.on("will-quit", (event) => {
  quitting = true;
  quickCapture.dispose();
  globalInputShortcuts.dispose();
  tray?.destroy();
  tray = null;
  const engineShutdown = Promise.all([
    claudeSessionsIpc.stopAll(), acpSessionsIpc.stopAll(), codexSessionsIpc.stopAll(),
  ]).catch((err) => reportError("ENGINE_SHUTDOWN_ERR", err));
  for (const term of terminals.values()) term.pty.kill();
  terminals.clear();
  globalShortcut.unregisterAll();

  // For normal quits, delay process exit until PostHog has flushed pending events.
  event.preventDefault();

  const shutdownMemory = import("./lib/memory/daemon")
    .then(({ stopMemoryDaemon }) => stopMemoryDaemon())
    .catch((err) => reportError("MEMORY_DAEMON", err, { context: "shutdown" }));
  Promise.all([
    shutdownProjectAppAgentBridge().catch((err) => reportError("PROJECT_APPS:BRIDGE_SHUTDOWN", err)),
    engineShutdown,
    shutdownPostHog().catch((err) => {
      // Log and continue exit even if analytics shutdown fails
      reportError("POSTHOG", err, { context: "shutdown" });
    }),
    shutdownMemory,
    // Engine teardown may deliver final usage reports before its process exits.
    engineShutdown.then(() => shutdownUsage()).catch((err) => reportError("USAGE_SHUTDOWN_ERR", err)),
    historyIpc.shutdownHistory().catch((err) => reportError("HISTORY:SHUTDOWN", err)),
  ]).finally(() => {
    app.exit(0);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
