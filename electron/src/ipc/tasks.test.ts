import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./tasks";
type Handler = (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>;
const fixture = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), list: vi.fn(), create: vi.fn(), revealFile: vi.fn(), show: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: Handler) => fixture.handlers.set(name, handler) }, shell: { showItemInFolder: fixture.show } }));
vi.mock("../lib/tasks", () => ({ getTaskService: () => ({ list: fixture.list, create: fixture.create, revealFile: fixture.revealFile, onChanged: vi.fn() }) }));
vi.mock("../lib/productivity-ipc", async () => {
  const { ProductivityError } = await import("../lib/productivity-errors");
  return { assertMainRenderer: (event: IpcMainInvokeEvent, getWindow: () => BrowserWindow) => {
    const win = getWindow(); if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new ProductivityError("FORBIDDEN_SENDER");
  } };
});
vi.mock("../lib/error-utils", () => ({ reportError: vi.fn() }));
vi.mock("../lib/safe-send", () => ({ safeSend: vi.fn() }));
const frame = {}; const contents = { mainFrame: frame }; const win = { isDestroyed: () => false, webContents: contents };
const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
beforeEach(() => { fixture.handlers.clear(); vi.clearAllMocks(); fixture.list.mockResolvedValue({ version: 1, revision: 0, tasks: [], runs: [], deliverables: [] }); register(() => win as unknown as BrowserWindow); });
describe("tasks IPC boundary", () => {
  it("refuses guest and subframe mutation callers", async () => {
    const create = fixture.handlers.get("tasks:create")!;
    expect(await create({ ...event, sender: {} } as IpcMainInvokeEvent, {})).toMatchObject({ ok: false, error: { code: "FORBIDDEN_SENDER" } });
    expect(await create({ ...event, senderFrame: {} } as IpcMainInvokeEvent, {})).toMatchObject({ ok: false, error: { code: "FORBIDDEN_SENDER" } });
    expect(fixture.create).not.toHaveBeenCalled();
  });
  it("only reveals the path validated by the authoritative task service", async () => {
    fixture.revealFile.mockResolvedValue("validated/report.md");
    expect(await fixture.handlers.get("tasks:reveal-file")!(event, "file-id")).toEqual({ ok: true, value: null });
    expect(fixture.revealFile).toHaveBeenCalledWith("file-id"); expect(fixture.show).toHaveBeenCalledWith("validated/report.md");
  });
  it("returns storage errors without a success envelope", async () => {
    fixture.create.mockRejectedValue(new Error("disk full"));
    expect(await fixture.handlers.get("tasks:create")!(event, {})).toMatchObject({ ok: false, error: { code: "IO_ERROR", message: "disk full" } });
  });
});
