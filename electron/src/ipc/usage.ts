import { app, ipcMain, powerMonitor, type BrowserWindow } from "electron";
import path from "node:path";
import { buildUsageReport, USAGE_MAX_GAP_MS } from "@shared/lib/usage";
import { getDataDir } from "../lib/data-dir";
import { UsageHistory } from "../lib/usage-history";
import { flushUsage, getUsageTracker, getUsageTimings, startUsageTracking } from "../lib/usage";
import { log } from "../lib/logger";
import { reportError } from "../lib/error-utils";
import { getSessionTokenUsage, getTokenUsage } from "../lib/token-usage";
import type { UsageTimings, UsageTokens } from "@shared/types/usage";

export function register(getMainWindow: () => BrowserWindow | null): void {
  let history: UsageHistory | undefined;
  ipcMain.handle("usage:session-tokens", (event, sessionId: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return { error: "Unknown usage client" };
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return { error: "Invalid session ID" };
    try {
      return { data: getSessionTokenUsage(sessionId) };
    } catch (error) {
      reportError("SESSION_TOKEN_USAGE_READ_ERR", error);
      return { error: "Could not read session token usage" };
    }
  });
  ipcMain.handle("usage:get", async (event, range: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return { error: "Unknown usage client" };
    if (range !== 1 && range !== 7 && range !== 30 && range !== 90) return { error: "Invalid usage range" };
    try {
      // Read-only dashboard: persistence failures must not hide readable data.
      const now = Date.now();
      history ??= new UsageHistory(path.join(getDataDir(), "sessions"));
      const result = await history.read().catch((error: unknown) => {
        reportError("USAGE_HISTORY_READ_ERR", error);
        return { sessions: [], incomplete: true };
      });
      let timings: UsageTimings = { version: 1, trackingStartedAt: now, active: [], agent: [] };
      let tokens: UsageTokens = { version: 1, trackingStartedAt: now, entries: [] };
      let incompleteTimings = false;
      let incompleteTokens = false;
      try { timings = getUsageTimings(); }
      catch (error) { incompleteTimings = true; reportError("USAGE_TIMINGS_READ_ERR", error); }
      try { tokens = getTokenUsage(); }
      catch (error) { incompleteTokens = true; reportError("USAGE_TOKENS_READ_ERR", error); }
      const data = buildUsageReport(result.sessions, timings, range, tokens, now);
      data.incompleteHistory = result.incomplete;
      data.incompleteTimings = incompleteTimings;
      data.tokens.incomplete = incompleteTokens;
      if (incompleteTimings) for (const day of data.days) { day.activeMs = null; day.agentMs = null; }
      return { data };
    } catch (error) {
      reportError("USAGE_READ_ERR", error);
      return { error: "Could not read local usage statistics" };
    }
  });

  ipcMain.on("usage:activity", (event, start: unknown, end: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) return;
    const now = Date.now();
    if (end <= start || end - start > USAGE_MAX_GAP_MS || start < now - USAGE_MAX_GAP_MS || end > now + 1000) return;
    getUsageTracker().activity(start, Math.min(end, now));
  });

  void app.whenReady().then(() => {
    startUsageTracking();
    powerMonitor.on("suspend", () => { void flushUsage().catch((error) => log("USAGE_SAVE_ERR", error)); });
    powerMonitor.on("resume", () => getUsageTracker().resume());
  });
}
