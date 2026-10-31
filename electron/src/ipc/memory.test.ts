import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./memory";
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const f = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), remember: vi.fn(), connect: vi.fn(), open: vi.fn(), document: vi.fn(), validate: vi.fn(), save: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: {}, shell: { openExternal: f.open }, ipcMain: { handle: (name: string, handler: Handler) => f.handlers.set(name, handler) } }));
vi.mock("../lib/error-utils", () => ({ reportError: vi.fn() }));
vi.mock("./projects", () => ({ readProjects: () => [{ id: "project" }] }));
vi.mock("../lib/memory/secrets", () => ({ setMemoryToken: vi.fn() }));
vi.mock("../lib/memory/service", () => ({ connectMemory: f.connect, getBrainDocument: f.document, remember: f.remember, rememberSession: vi.fn(), getMemoryStatus: vi.fn(), probeMemory: vi.fn(), getMemoryProjectConfig: vi.fn(), setMemoryProjectConfig: f.save, validateProjectBinding: f.validate, getMemoryRecallState: vi.fn(), setSkipNextMemoryRecall: vi.fn(), memoryJournal: { list: () => [] }, reconcileMemory: vi.fn() }));
const frame = {}; const contents = { mainFrame: frame }; const win = { isDestroyed: () => false, webContents: contents };
const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
beforeEach(() => { vi.clearAllMocks(); f.handlers.clear(); register(() => win as unknown as BrowserWindow); });
const call = (name: string, ...args: unknown[]) => f.handlers.get(name)!(event, ...args);
describe("SiYuan memory IPC", () => {
  it("initializes only through the trusted renderer", async () => {
    f.connect.mockResolvedValue({ enabled: true });
    expect(await call("memory:connect", "http://127.0.0.1:6806")).toEqual({ value: { enabled: true } });
    expect(await f.handlers.get("memory:connect")!({ ...event, sender: {} } as unknown as IpcMainInvokeEvent, "http://127.0.0.1:6806")).toHaveProperty("error");
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it("opens only the validated brain document", async () => {
    f.document.mockResolvedValue("20261024000000-aaaaaaa");
    expect(await call("memory:open-brain")).toEqual({ value: null });
    expect(f.open).toHaveBeenCalledWith("siyuan://blocks/20261024000000-aaaaaaa");
  });
  it("rejects foreign renderer writes", async () => { expect(await f.handlers.get("memory:remember")!({ ...event, sender: {} } as IpcMainInvokeEvent, "project", "Note", "project")).toHaveProperty("error"); expect(f.remember).not.toHaveBeenCalled(); });
  it("requires a valid project and explicit scope", async () => { expect(await call("memory:remember", "missing", "Note", "project")).toHaveProperty("error"); expect(await call("memory:remember", "project", "Note", "all")).toHaveProperty("error"); expect(f.remember).not.toHaveBeenCalled(); });
  it("does not add per-item approval", async () => { f.remember.mockResolvedValue({ state: "verified" }); expect(await call("memory:remember", "project", "A verified note", "project")).toEqual({ value: { state: "verified" } }); expect(f.remember).toHaveBeenCalledWith("project", "A verified note", "project", "convention", "panel:project"); });
  it("does not leak server content on failures", async () => { f.remember.mockRejectedValue(new Error("secret note body")); const result = await call("memory:remember", "project", "Note", "project"); expect(result).toHaveProperty("error"); expect(JSON.stringify(result)).not.toContain("secret note body"); });
  it("no longer exposes backend lifecycle, keys or arbitrary bank mutations", () => { for (const old of ["memory:daemon-start", "memory:set-llm-key", "memory:delete-document", "memory:update-memory"]) expect(f.handlers.has(old)).toBe(false); });
});
