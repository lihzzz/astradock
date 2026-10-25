import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow } from "electron";
import { SessionRepository } from "../lib/session-repository";
import { register } from "./runtime-history";
import { removeFixture } from "../lib/runtime/testing/fixture";
import type { ThreadHistoryPage } from "@shared/types/runtime-history";
type Handler = (event: unknown, input: unknown) => Promise<unknown>;
const state = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), repository: null as SessionRepository | null,
  projectListeners: new Set<() => void>(), page: vi.fn<() => Promise<ThreadHistoryPage>>(), invalidate: vi.fn(async () => {}), report: vi.fn() }));
vi.mock("electron", () => ({
  app: { on: vi.fn() }, ipcMain: { handle: (channel: string, handler: Handler) => state.handlers.set(channel, handler) },
  BrowserWindow: class { webContents = { mainFrame: {} }; isDestroyed() { return false; } },
}));
vi.mock("../lib/session-service", () => ({ getSessionRepository: () => state.repository }));
vi.mock("../lib/error-utils", () => ({ reportError: state.report }));
vi.mock("./projects", () => ({ readProjects: () => [{ id: "p" }], onProjectsChanged: (listener: () => void) => { state.projectListeners.add(listener); return () => state.projectListeners.delete(listener); } }));
vi.mock("../lib/runtime/history-reader", () => ({ ThreadHistoryReader: class {
  page = state.page; chunk = vi.fn(); invalidate = state.invalidate; close = vi.fn(async () => {});
} }));
let root: string, window: BrowserWindow;
const page: ThreadHistoryPage = { kind: "history-page", epoch: "a".repeat(64), items: [], nextCursor: null, total: 1, damagedRecords: 0, coldBuild: false, sourceBytesRead: 0 };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-history-ipc-"));
  state.repository = new SessionRepository(root, state.report);
  await state.repository.save({ id: "s", projectId: "p", title: "source", createdAt: 1, engine: "claude", messages: [{ id: "m", role: "user", content: "keep", timestamp: 1 }] });
  state.page.mockReset(); state.page.mockResolvedValue(page); state.invalidate.mockClear(); state.handlers.clear(); state.projectListeners.clear(); window = new BrowserWindow(); register(() => window);
});
afterEach(async () => { await removeFixture(root, "astradock-history-ipc-"); });
const query = { projectId: "p", sessionId: "s", limit: 50, maxBytes: 4096 };
function event() { return { sender: window.webContents, senderFrame: window.webContents.mainFrame }; }
describe("history IPC security and consistency", () => {
  it("rejects other renderers and nested frames before reading", async () => {
    const handler = state.handlers.get("sessions:history-page")!;
    expect(await handler({ sender: {}, senderFrame: {} }, query)).toMatchObject({ ok: false, error: { code: "FORBIDDEN_SENDER" } });
    expect(await handler({ ...event(), senderFrame: {} }, query)).toMatchObject({ ok: false, error: { code: "FORBIDDEN_SENDER" } });
    expect(state.page).not.toHaveBeenCalled();
  });
  it("rejects path traversal and unbounded requests", async () => {
    const handler = state.handlers.get("sessions:history-page")!;
    expect(await handler(event(), { ...query, projectId: "../escape" })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect(await handler(event(), { ...query, limit: 5000 })).toMatchObject({ ok: false }); expect(state.page).not.toHaveBeenCalled();
  });
  it("returns a read-only page without changing the source", async () => {
    const file = path.join(root, "sessions/p/s.jsonl"), before = await fs.readFile(file, "utf8");
    expect(await state.handlers.get("sessions:history-page")!(event(), query)).toEqual({ ok: true, page });
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("invalidates derived content when the project catalog changes", async () => {
    await state.handlers.get("sessions:history-page")!(event(), query);
    for (const listener of state.projectListeners) listener();
    expect(state.invalidate).toHaveBeenCalledOnce();
  });
  it("does not return history after deletion while a worker request is pending", async () => {
    let finish!: (page: ThreadHistoryPage) => void;
    state.page.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = state.handlers.get("sessions:history-page")!(event(), query);
    await vi.waitFor(() => expect(state.page).toHaveBeenCalledOnce());
    await state.repository!.remove("p", "s", async () => {}); finish(page);
    expect(await pending).toMatchObject({ ok: false, error: { code: "CURSOR_EXPIRED" } }); expect(state.invalidate).toHaveBeenCalled();
  });
});
