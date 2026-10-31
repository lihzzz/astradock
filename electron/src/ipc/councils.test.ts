import { beforeEach, describe, it, expect, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
type Handler = (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>;
const f = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  assert: vi.fn(),
  list: vi.fn(async () => ({
    version: 1,
    revision: 0,
    councils: [],
    runs: []
  })),
  create: vi.fn(),
  brief: vi.fn(),
  changed: vi.fn(),
  delta: vi.fn()
}));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, fn: Handler) => f.handlers.set(name, fn) } }));
vi.mock("../lib/councils", () => ({ getCouncilService: () => ({
    list: f.list,
    create: f.create,
    taskBrief: f.brief,
    onChanged: f.changed,
    onDelta: f.delta
  }) }));
vi.mock("../lib/councils/runtime", () => ({ COUNCIL_CAPABILITIES: [] }));
vi.mock("../lib/productivity-ipc", () => ({ assertMainRenderer: f.assert }));
vi.mock("../lib/error-utils", () => ({ reportError: vi.fn() }));
vi.mock("../lib/safe-send", () => ({ safeSend: vi.fn() }));
import { register } from "./councils";
const event = {} as IpcMainInvokeEvent;
beforeEach(() => {
  vi.clearAllMocks();
  f.handlers.clear();
  register(() => null);
});
describe("Council IPC boundary", () => {
  it("checks the trusted renderer before every command", async () => {
    f.assert.mockImplementationOnce(() => {
      throw Error("forbidden");
    });
    expect(await f.handlers.get("councils:create")!(event, {})).toMatchObject({ ok: false });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("rejects malformed task source references before reaching the service", async () => {
    expect(await f.handlers.get("councils:task-brief")!(event, { runId: "../escape", expectedRevision: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect(f.brief).not.toHaveBeenCalled();
  });
  it("does not convert storage errors into successful mutations", async () => {
    f.create.mockRejectedValueOnce(Error("disk full"));
    expect(await f.handlers.get("councils:create")!(event, {})).toMatchObject({ ok: false, error: { code: "IO_ERROR", message: "disk full" } });
  });
});
