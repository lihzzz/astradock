import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@shared/types/usage";

const mocks = vi.hoisted(() => ({
  directory: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
  power: new Map<string, () => void>(),
  sender: {},
}));
vi.mock("electron", () => ({
  app: { whenReady: () => Promise.resolve() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler),
    on: (name: string, handler: (...args: unknown[]) => void) => mocks.listeners.set(name, handler),
  },
  powerMonitor: { on: (name: string, listener: () => void) => mocks.power.set(name, listener) },
}));
vi.mock("../lib/data-dir", () => ({ getDataDir: () => mocks.directory }));
vi.mock("../lib/logger", () => ({ log: vi.fn() }));
vi.mock("../lib/error-utils", () => ({ reportError: vi.fn() }));

const now = new Date(2026, 9, 7, 12).getTime();
let usage: typeof import("../lib/usage");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.handlers.clear();
  mocks.listeners.clear();
  mocks.power.clear();
  mocks.directory = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-usage-ipc-"));
  usage = await import("../lib/usage");
});
afterEach(async () => {
  await usage.shutdownUsage().catch(() => undefined);
  vi.useRealTimers();
  await fs.rm(mocks.directory, { recursive: true, force: true });
});

async function register() {
  const ipc = await import("./usage");
  ipc.register(() => ({ webContents: mocks.sender }) as Electron.BrowserWindow);
  await Promise.resolve();
}

async function query(range: unknown = 7, sender: unknown = mocks.sender) {
  return await mocks.handlers.get("usage:get")!({ sender }, range) as { data?: UsageReport; error?: string };
}

describe("local usage IPC", () => {
  it.each([1, 7, 30, 90])("supports a %s-day report with engine token totals", async (range) => {
    await fs.writeFile(path.join(mocks.directory, "usage-tokens.json"), JSON.stringify({
      version: 1, trackingStartedAt: now - 86_400_000,
      entries: [{ timestamp: now, engine: "codex", totalTokens: 150, inputTokens: 100,
        outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 0 }],
    }));
    await register();
    const result = await query(range);
    expect(result.error).toBeUndefined();
    expect(result.data?.days).toHaveLength(range);
    expect(result.data?.tokens.days).toHaveLength(range);
    expect(result.data?.tokens.engines.find((entry) => entry.engine === "codex"))
      .toMatchObject({ totalTokens: 150, cacheReadTokens: 40, reported: true });
  });

  it("combines persisted history with live timing and saves durations independently of telemetry", async () => {
    const directory = path.join(mocks.directory, "sessions", "p");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "s.json"), JSON.stringify({ id: "s", projectId: "p", messages: [
      { id: "user", role: "user", content: "hello", timestamp: now },
      { id: "tool", role: "tool_call", toolName: "Bash", toolInput: { command: "pnpm test" }, timestamp: now },
    ] }));
    await register();
    usage.beginUsageTurn("claude", "a");
    vi.setSystemTime(now + 5000);
    usage.beginUsageTurn("codex", "b");
    vi.setSystemTime(now + 10000);
    usage.endUsageTurn("claude", "a");
    vi.setSystemTime(now + 15000);
    usage.endUsageTurn("codex", "b");
    mocks.listeners.get("usage:activity")!({ sender: mocks.sender }, now + 5000, now + 15000);
    const result = await query();
    expect(result.error).toBeUndefined();
    expect(result.data?.days.at(-1)).toMatchObject({ userMessages: 1, activeMs: 10000, agentMs: 15000 });
    expect(result.data?.commands).toEqual([{ name: "pnpm test", count: 1 }]);
    const saved = JSON.parse(await fs.readFile(path.join(mocks.directory, "usage-timings.json"), "utf-8"));
    expect(saved.agent).toEqual([[now, now + 15000]]);
    expect(saved.active).toEqual([[now + 5000, now + 15000]]);
  });

  it("rejects foreign senders, unsupported ranges and invalid activity intervals", async () => {
    await register();
    expect((await query(7, {})).error).toBeTruthy();
    expect((await query(365)).error).toBeTruthy();
    const activity = mocks.listeners.get("usage:activity")!;
    vi.setSystemTime(now + 20000);
    activity({ sender: {} }, now, now + 10000);
    activity({ sender: mocks.sender }, NaN, now);
    activity({ sender: mocks.sender }, now - 100000, now);
    activity({ sender: mocks.sender }, now, now + 100000);
    expect((await query()).data?.days.at(-1)?.activeMs).toBe(0);
  });

  it("surfaces corrupted timing data without overwriting it with zeros", async () => {
    const file = path.join(mocks.directory, "usage-timings.json");
    await fs.writeFile(file, "{broken");
    await register();
    expect((await query()).error).toBeTruthy();
    expect(await fs.readFile(file, "utf-8")).toBe("{broken");
  });

  it("surfaces corrupted token data without replacing retained usage", async () => {
    const file = path.join(mocks.directory, "usage-tokens.json");
    await fs.writeFile(file, "{broken");
    await register();
    expect((await query(1)).error).toBeTruthy();
    expect(await fs.readFile(file, "utf-8")).toBe("{broken");
  });
});
