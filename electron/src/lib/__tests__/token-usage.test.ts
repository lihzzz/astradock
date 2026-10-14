import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ directory: "" }));
vi.mock("../data-dir", () => ({ getDataDir: () => mocks.directory }));
vi.mock("../logger", () => ({ log: vi.fn() }));
vi.mock("../error-utils", () => ({ reportError: vi.fn() }));

let usage: typeof import("../token-usage");
beforeEach(async () => {
  vi.resetModules();
  mocks.directory = await fs.mkdtemp(path.join(os.tmpdir(), "harnss-token-usage-"));
  usage = await import("../token-usage");
});
afterEach(async () => { await fs.rm(mocks.directory, { recursive: true, force: true }); });

describe("local token ledger", () => {
  it("records in memory, atomically persists and restores tokens without telemetry", async () => {
    usage.recordAcpTokenUsage("prompt", { totalTokens: 40, inputTokens: 30, outputTokens: 10, cachedReadTokens: 20 });
    await expect(fs.readFile(path.join(mocks.directory, "usage-tokens.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await Promise.all([usage.flushTokenUsage(), usage.flushTokenUsage()]);
    const saved = usage.getTokenUsage();
    expect(await fs.readdir(mocks.directory)).toEqual(["usage-tokens.json"]);
    vi.resetModules();
    usage = await import("../token-usage");
    expect(usage.getTokenUsage()).toEqual(saved);
    usage.recordAcpTokenUsage("next", { totalTokens: 10, inputTokens: 8, outputTokens: 2 });
    await usage.flushTokenUsage();
    expect(JSON.parse(await fs.readFile(path.join(mocks.directory, "usage-tokens.json"), "utf-8")).entries).toHaveLength(2);
  });

  it("persists Codex baselines and restores them for a resumed thread", async () => {
    const observer = usage.createCodexTokenObserver(false);
    observer.observe("turn/started", { threadId: "thread", turn: { id: "first" } }, "thread");
    observer.observe("thread/tokenUsage/updated", { threadId: "thread", turnId: "first", tokenUsage: { total: { totalTokens: 100, inputTokens: 80, outputTokens: 20 }, last: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } } }, "thread");
    await usage.flushTokenUsage();
    vi.resetModules();
    usage = await import("../token-usage");
    const resumed = usage.createCodexTokenObserver(true);
    resumed.observe("turn/started", { threadId: "thread", turn: { id: "next" } }, "thread");
    resumed.observe("thread/tokenUsage/updated", { threadId: "thread", turnId: "next", tokenUsage: { total: { totalTokens: 150, inputTokens: 120, outputTokens: 30 }, last: { totalTokens: 20, inputTokens: 15, outputTokens: 5 } } }, "thread");
    expect(usage.getTokenUsage().entries.map((entry) => entry.totalTokens)).toEqual([100, 50]);
  });

  it.each(["{broken", JSON.stringify({ version: 1, trackingStartedAt: 0, entries: [{ engine: "claude", timestamp: 1, totalTokens: -1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }] })])("surfaces invalid data without overwriting the original ledger", async (content) => {
    const file = path.join(mocks.directory, "usage-tokens.json");
    await fs.writeFile(file, content);
    expect(() => usage.getTokenUsage()).toThrow();
    usage.recordAcpTokenUsage("new", { totalTokens: 10, inputTokens: 8, outputTokens: 2 });
    await expect(usage.flushTokenUsage()).rejects.toThrow();
    expect(await fs.readFile(file, "utf-8")).toBe(content);
  });

  it("accepts ledgers from before persisted baselines were added", async () => {
    await fs.writeFile(path.join(mocks.directory, "usage-tokens.json"), JSON.stringify({ version: 1, trackingStartedAt: 0, entries: [] }));
    expect(usage.getTokenUsage().entries).toEqual([]);
    await usage.flushTokenUsage();
  });
});
