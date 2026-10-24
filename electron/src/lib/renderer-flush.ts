import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";

/** Called during before-quit, while the renderer and its message buffers still exist. */
export function flushRendererSessions(window: (Pick<BrowserWindow, "isDestroyed"> & { webContents: Pick<Electron.WebContents, "isDestroyed" | "send"> }) | null): Promise<void> {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve();
  const sender = window.webContents;
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error?: string) => {
      clearTimeout(timer); ipcMain.removeListener("sessions:flushed", reply);
      if (error) reject(new Error(error)); else resolve();
    };
    const reply = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (event.sender !== sender || !payload || typeof payload !== "object" || !("id" in payload) || payload.id !== id) return;
      finish("error" in payload && typeof payload.error === "string" ? payload.error : undefined);
    };
    const timer = setTimeout(() => finish("Conversation saving did not finish. Retry or explicitly force quit."), 10_000);
    ipcMain.on("sessions:flushed", reply);
    try { sender.send("sessions:flush", id); } catch (error) { finish(String(error)); }
  });
}
