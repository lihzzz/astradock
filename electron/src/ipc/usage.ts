import { app, ipcMain, powerMonitor, type BrowserWindow } from "electron";
import path from "node:path";
import { buildUsageReport, USAGE_MAX_GAP_MS } from "@shared/lib/usage";
import { getDataDir } from "../lib/data-dir";
import { UsageHistory } from "../lib/usage-history";
import { flushUsage, getUsageTracker, startUsageTracking } from "../lib/usage";
import { log } from "../lib/logger";
import { reportError } from "../lib/error-utils";
import { getTokenUsage } from "../lib/token-usage";

export function register(getMainWindow: () => BrowserWindow | null): void {
  let history: UsageHistory | undefined;
  ipcMain.handle("usage:get", async (event, range: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return { error: "Unknown usage client" };
    if (range !== 1 && range !== 7 && range !== 30 && range !== 90) return { error: "Invalid usage range" };
    try {
      await flushUsage();
      history ??= new UsageHistory(path.join(getDataDir(), "sessions"));
      const result = await history.read();
      const tracker = getUsageTracker();
      tracker.checkpoint();
      const data = buildUsageReport(result.sessions, tracker.data, range, getTokenUsage());
      data.incompleteHistory = result.incomplete;
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
