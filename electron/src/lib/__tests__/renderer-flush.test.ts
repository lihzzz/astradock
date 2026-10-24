import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", async () => { const { EventEmitter } = await import("node:events"); return { ipcMain: new EventEmitter() }; });
import { ipcMain } from "electron";
import { flushRendererSessions } from "../renderer-flush";
afterEach(() => { ipcMain.removeAllListeners(); vi.useRealTimers(); });
function fixture() {
  const webContents = { isDestroyed: () => false, send: vi.fn() };
  const window = { isDestroyed: () => false, webContents };
  return { window, webContents };
}
describe("quit flush acknowledgement", () => {
  it("only accepts the exact renderer and request, then removes the listener", async () => {
    const { window, webContents } = fixture(); const pending = flushRendererSessions(window);
    const id: unknown = webContents.send.mock.calls[0][1];
    ipcMain.emit("sessions:flushed", { sender: {} }, { id }); expect(ipcMain.listenerCount("sessions:flushed")).toBe(1);
    ipcMain.emit("sessions:flushed", { sender: webContents }, { id }); await pending;
    expect(ipcMain.listenerCount("sessions:flushed")).toBe(0);
  });
  it("surfaces save errors instead of silently allowing quit", async () => {
    const { window, webContents } = fixture(); const pending = flushRendererSessions(window);
    const assertion = expect(pending).rejects.toThrow("disk full");
    ipcMain.emit("sessions:flushed", { sender: webContents }, { id: webContents.send.mock.calls[0][1], error: "disk full" });
    await assertion;
  });
  it("times out a renderer that cannot save and cleans up", async () => {
    vi.useFakeTimers(); const pending = flushRendererSessions(fixture().window);
    const assertion = expect(pending).rejects.toThrow("did not finish");
    await vi.advanceTimersByTimeAsync(10000); await assertion;
    expect(ipcMain.listenerCount("sessions:flushed")).toBe(0);
  });
});
