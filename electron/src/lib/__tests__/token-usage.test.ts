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

  it("isolates concurrent sessions, includes cache once and distinguishes missing reports", () => {
    const claude = usage.createClaudeTokenObserver(false, "claude-chat");
    claude.observe({ type: "result", uuid: "result", usage: {
      input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 3,
    } });
    usage.recordAcpTokenUsage("acp-turn", { totalTokens: 100, inputTokens: 60, outputTokens: 30 }, "acp-chat");
    usage.recordAcpTokenUsage("acp-turn", { totalTokens: 100, inputTokens: 60, outputTokens: 30 }, "acp-chat");
    usage.recordAcpTokenUsage("missing", undefined, "unreported-chat");
    expect(usage.getSessionTokenUsage("claude-chat")).toMatchObject({
      reported: true, totalTokens: 38, inputTokens: 33, outputTokens: 5, cacheReadTokens: 20, cacheCreationTokens: 3,
    });
    expect(usage.getSessionTokenUsage("acp-chat")).toMatchObject({ reported: true, totalTokens: 100 });
    expect(usage.getSessionTokenUsage("unreported-chat")).toMatchObject({ reported: false, totalTokens: 0 });
    expect(usage.getTokenUsage().entries).toHaveLength(2);
  });

  it("preserves a conversation's usage through repeated runtime replacements and application restarts", async () => {
    usage.bindSessionTokenUsage("original");
    usage.recordAcpTokenUsage("first", { totalTokens: 40, inputTokens: 30, outputTokens: 10 }, "original");
    usage.bindSessionTokenUsage("revived", "original");
    usage.recordAcpTokenUsage("second", { totalTokens: 15, inputTokens: 10, outputTokens: 5 }, "revived");
    await usage.flushTokenUsage();
    vi.resetModules();
    usage = await import("../token-usage");
    usage.bindSessionTokenUsage("restarted", "revived");
    usage.recordAcpTokenUsage("third", { totalTokens: 10, inputTokens: 8, outputTokens: 2 }, "restarted");
    for (const id of ["original", "revived", "restarted"]) {
      expect(usage.getSessionTokenUsage(id)).toMatchObject({ reported: true, totalTokens: 65, inputTokens: 48, outputTokens: 17 });
    }
    expect(usage.getSessionTokenUsage("another-chat").reported).toBe(false);
  });

  it("splits Claude subagent consumption without counting repeated or late snapshots twice", () => {
    const observer = usage.createClaudeTokenObserver(false, "chat");
    const agent = { type: "assistant", parent_tool_use_id: "task", message: {
      id: "agent-message", usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 5 },
    } };
    observer.observe(agent);
    observer.observe(agent);
    observer.observe({ type: "result", uuid: "first", usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { model: { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 5 } } });
    expect(usage.getSessionTokenUsage("chat")).toMatchObject({ totalTokens: 45, mainTokens: 15, subagentTokens: 30, subagentCount: 1 });
    observer.observe({ ...agent, message: { ...agent.message, usage: { ...agent.message.usage, output_tokens: 10 } } });
    expect(usage.getSessionTokenUsage("chat")).toMatchObject({ totalTokens: 50, mainTokens: 15, subagentTokens: 35 });
    observer.observe({ type: "result", uuid: "second", usage: { input_tokens: 20, output_tokens: 10 },
      modelUsage: { model: { inputTokens: 40, outputTokens: 20, cacheReadInputTokens: 5 } } });
    expect(usage.getSessionTokenUsage("chat")).toMatchObject({ totalTokens: 65, mainTokens: 30, subagentTokens: 35, subagentCount: 1 });
  });

  it("reconciles Claude agent completion metadata with partial messages and persists the breakdown", async () => {
    const observer = usage.createClaudeTokenObserver(false, "chat");
    observer.observe({ type: "system", subtype: "task_started", tool_use_id: "shell", task_type: "local_bash" });
    observer.observe({ type: "system", subtype: "task_notification", tool_use_id: "shell" });
    expect(usage.getSessionTokenUsage("chat").subagentCount).toBe(0);
    observer.observe({ type: "system", subtype: "task_started", tool_use_id: "task", task_type: "local_agent" });
    const agent = { type: "assistant", parent_tool_use_id: "task", message: { id: "agent", usage: { input_tokens: 10 } } };
    observer.observe(agent);
    const complete = { type: "user", tool_use_result: { totalTokens: 30 },
      message: { content: [{ type: "tool_result", tool_use_id: "task" }] } };
    observer.observe(complete);
    observer.observe(complete);
    observer.observe({ ...agent, message: { ...agent.message, usage: { input_tokens: 15 } } });
    observer.observe({ type: "system", subtype: "task_notification", tool_use_id: "task", usage: { total_tokens: 30 } });
    observer.observe({ type: "result", uuid: "done", usage: { input_tokens: 10 }, modelUsage: { model: { inputTokens: 40 } } });
    await usage.flushTokenUsage();
    vi.resetModules();
    usage = await import("../token-usage");
    usage.bindSessionTokenUsage("revived", "chat");
    expect(usage.getSessionTokenUsage("revived")).toMatchObject({ totalTokens: 40, mainTokens: 10, subagentTokens: 30, subagentCount: 1 });
  });

  it("retains a ledger with invalid session totals instead of replacing its statistics", async () => {
    const file = path.join(mocks.directory, "usage-tokens.json");
    const content = JSON.stringify({ version: 1, trackingStartedAt: 0, entries: [],
      sessionTokens: { aliases: {}, sessions: { chat: { totalTokens: -1 } } } });
    await fs.writeFile(file, content);
    expect(() => usage.getSessionTokenUsage("chat")).toThrow();
    await expect(usage.flushTokenUsage()).rejects.toThrow();
    expect(await fs.readFile(file, "utf-8")).toBe(content);
  });

  it("includes only owned Codex child threads and counts nested agents once", () => {
    const observer = usage.createCodexTokenObserver(false, "codex-chat");
    const start = (threadId: string, id: string) => observer.observe("turn/started", { threadId, turn: { id } }, "root");
    const report = (threadId: string, turnId: string, total: number, last = total) => observer.observe("thread/tokenUsage/updated", {
      threadId, turnId, tokenUsage: { total: { totalTokens: total, inputTokens: total, outputTokens: 0 },
        last: { totalTokens: last, inputTokens: last, outputTokens: 0 } },
    }, "root");
    const child = (id: string, parent: string) => observer.observe("thread/started", {
      thread: { id, source: { subAgent: { thread_spawn: { parent_thread_id: parent } } } },
    }, "root");
    start("root", "main");
    report("root", "main", 100);
    child("child", "root");
    start("child", "child-turn");
    report("child", "child-turn", 1025, 25);
    report("child", "child-turn", 1025, 25);
    child("grandchild", "child");
    start("grandchild", "nested-turn");
    report("grandchild", "nested-turn", 5005, 5);
    start("unrelated", "other");
    report("unrelated", "other", 999);
    report("root", "main", 150, 50);
    expect(usage.getSessionTokenUsage("codex-chat")).toMatchObject({ totalTokens: 180, mainTokens: 150, subagentTokens: 30, subagentCount: 2 });
  });
});
