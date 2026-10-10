import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "./memory";
type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const f = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), retain: vi.fn(), docs: vi.fn(), units: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: {}, ipcMain: { handle: (name: string, handler: Handler) => f.handlers.set(name, handler) } }));
vi.mock("./projects", () => ({ readProjects: () => [{ id: "project" }] }));
vi.mock("../lib/app-settings", () => ({ getAppSettings: vi.fn(), setAppSettings: vi.fn() }));
vi.mock("../lib/error-utils", () => ({ reportError: (_label: string, error: unknown) => String(error) }));
vi.mock("../lib/safe-send", () => ({ safeSend: vi.fn() }));
vi.mock("../lib/memory/client", () => ({ getMemoryClient: vi.fn() }));
vi.mock("../lib/memory/daemon", () => ({ installMemoryDependencies: vi.fn() }));
vi.mock("../lib/memory/llm-connection", () => ({ testMemoryLlm: vi.fn() }));
vi.mock("../lib/memory/service", () => ({ clearMemoryKey: vi.fn(), deleteMemoryDocument: vi.fn(), getMemoryProjectConfig: vi.fn(), getMemoryStatus: vi.fn(),
  listMemoryDocuments: f.docs, listMemoryUnits: f.units, memoryHasKey: () => false, retainManualMemory: vi.fn(), setMemoryEnabled: vi.fn(),
  setMemoryKey: vi.fn(), setMemoryProjectConfig: vi.fn(), updateMemoryUnit: vi.fn(), runMemoryGoldenSet: vi.fn(), invalidateMemoryCache: vi.fn(), retainProjectMemory: f.retain }));
const frame = {}; const contents = { mainFrame: frame }; const win = { isDestroyed: () => false, webContents: contents };
const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
beforeEach(() => { vi.clearAllMocks(); f.handlers.clear(); register(() => win as unknown as BrowserWindow); });
const call = async (channel: string, value: unknown, sender = event) => f.handlers.get(channel)!(sender, value);
describe("memory IPC boundary", () => {
  it("rejects guest and subframe callers before retention", async () => {
    const value = { projectId: "project", content: "User note", scope: "project" };
    expect(await call("memory:retain-project", value, { ...event, sender: {} } as IpcMainInvokeEvent)).toMatchObject({ error: expect.stringContaining("FORBIDDEN_SENDER") });
    expect(await call("memory:retain-project", value, { ...event, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ error: expect.stringContaining("FORBIDDEN_SENDER") });
    expect(f.retain).not.toHaveBeenCalled();
  });
  it("requires an existing project and explicit write scope", async () => {
    expect(await call("memory:retain-project", { projectId: "missing", content: "Note", scope: "user" })).toHaveProperty("error");
    expect(await call("memory:retain-project", { projectId: "project", content: "Note" })).toHaveProperty("error");
    expect(f.retain).not.toHaveBeenCalled();
    expect(await call("memory:retain-project", { projectId: "project", content: "Note", scope: "project" })).toEqual({ ok: true });
    expect(f.retain).toHaveBeenCalledWith("project", "Note", "project");
  });
  it("reports unavailable lists instead of a successful empty result", async () => {
    f.docs.mockResolvedValue(null); f.units.mockResolvedValue(null);
    expect(await call("memory:list-documents", "bank")).toHaveProperty("error");
    expect(await call("memory:list-memories", "bank")).toHaveProperty("error");
  });
  it("does not return success when retention fails", async () => {
    f.retain.mockRejectedValueOnce(new Error("Provider unavailable"));
    expect(await call("memory:retain-project", { projectId: "project", content: "Note", scope: "project" })).toMatchObject({ error: expect.stringContaining("Provider unavailable") });
  });
});
