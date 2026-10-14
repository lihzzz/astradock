import { afterEach, describe, expect, it } from "vitest";
import { buildUsageReport, getCommandName, summarizeUsageSession } from "@shared/lib/usage";
import { UsageTracker } from "../usage-tracker";

const originalTimezone = process.env.TZ;
afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

describe("usage history", () => {
  it("counts messages once and excludes queued, thinking-only and synthetic messages", () => {
    const timestamp = new Date(2026, 9, 7, 12).getTime();
    const session = summarizeUsageSession({ id: "session", projectId: "p", messages: [
      { id: "user", role: "user", content: "/review private/path", timestamp },
      { id: "user", role: "user", content: "/review private/path", timestamp },
      { id: "queued", role: "user", content: "queued", isQueued: true, timestamp },
      { id: "thought", role: "assistant", content: "", thinking: "thinking", timestamp },
      { id: "reply", role: "assistant", content: "Done", timestamp },
      { id: "system", role: "system", content: "status", timestamp },
      { id: "codex-plan-update-1", role: "tool_call", toolName: "TodoWrite", timestamp },
      { id: "tool", role: "tool_call", toolName: "Bash", toolInput: { command: "git status --short" }, timestamp },
    ] });
    const report = buildUsageReport([session], { version: 1, trackingStartedAt: timestamp, active: [], agent: [] }, 7,
      { version: 1, trackingStartedAt: timestamp, entries: [] }, timestamp);
    expect(report.days.at(-1)).toMatchObject({ userMessages: 1, assistantMessages: 1, activeMs: 0, agentMs: 0 });
    expect(report.days[0].activeMs).toBeNull();
    expect(report.tools).toEqual([{ name: "Bash", count: 1 }]);
    expect(report.commands).toEqual([{ name: "git status", count: 1 }]);
    expect(report.slashCommands).toEqual([{ name: "/review", count: 1 }]);
  });

  it("uses the latest logical conversation, not every resumed snapshot", () => {
    const timestamp = Date.now();
    const message = { id: "m1", role: "user", content: "hello", timestamp };
    const old = summarizeUsageSession({ id: "old", projectId: "p", conversationId: "stable", messages: [message] }, 1);
    const current = summarizeUsageSession({ id: "new", projectId: "p", conversationId: "stable", messages: [message, { ...message, id: "m2" }] }, 2);
    const report = buildUsageReport([old, current], { version: 1, trackingStartedAt: timestamp, active: [], agent: [] }, 7,
      { version: 1, trackingStartedAt: timestamp, entries: [] }, timestamp);
    expect(report.days.at(-1)?.userMessages).toBe(2);
  });

  it("splits intervals at local midnight and respects DST day lengths", () => {
    process.env.TZ = "America/New_York";
    const start = new Date(2026, 2, 8).getTime();
    const end = new Date(2026, 2, 9).getTime();
    const report = buildUsageReport([], { version: 1, trackingStartedAt: start, active: [[start, end]], agent: [[start, end]] }, 7,
      { version: 1, trackingStartedAt: start, entries: [] }, end);
    expect(report.days.at(-2)).toMatchObject({ date: "2026-03-08", activeMs: 23 * 3_600_000, agentMs: 23 * 3_600_000 });
    expect(report.days.at(-1)?.activeMs).toBe(0);
  });
});

describe("command grouping", () => {
  it.each([
    ["git status --short", "git status"],
    ["pnpm test -- private/file", "pnpm test"],
    ["rg 'private query' /private/path", "rg"],
    ["/usr/bin/git diff -- src/secret.ts", "git diff"],
    ["git status && pnpm test", "__shell_script__"],
    ["python -c 'print(1); print(2)'", "python"],
    ["echo $(cat /secret)", "__shell_script__"],
    ["TOKEN=secret pnpm test", "__shell_script__"],
    ["npm run private-task-name", "npm run"],
    ["/bin/zsh -lc 'git status --short'", "git status"],
    [["/bin/zsh", "-lc", "pnpm test"], "pnpm test"],
    ["bash -c 'git status && pnpm test'", "__shell_script__"],
  ])("groups %s without retaining arguments", (command, expected) => {
    expect(getCommandName(command)).toBe(expected);
  });
});

describe("usage timer", () => {
  it("merges concurrent agents and handles duplicate starts and ends", () => {
    const tracker = new UsageTracker(0);
    tracker.begin("a", "turn", 0);
    tracker.begin("a", "turn", 1000);
    tracker.begin("b", "turn", 5000);
    tracker.end("a", "turn", 10000);
    tracker.end("a", "turn", 11000);
    tracker.end("b", "turn", 15000);
    expect(tracker.data.agent).toEqual([[0, 15000]]);
  });

  it("stops all work for an exited session without stopping other agents", () => {
    const tracker = new UsageTracker(0);
    tracker.begin("a", "turn", 0);
    tracker.begin("a", "task:1", 1000);
    tracker.begin("b", "turn", 2000);
    tracker.stopSession("a", 5000);
    tracker.end("b", "turn", 7000);
    tracker.checkpoint(10000);
    expect(tracker.data.agent).toEqual([[0, 7000]]);
  });

  it("does not charge suspended time or restore stale running agents after restart", () => {
    const tracker = new UsageTracker(0);
    tracker.begin("a", "turn", 0);
    tracker.checkpoint(15000);
    tracker.checkpoint(3_600_000);
    tracker.end("a", "turn", 3_610_000);
    expect(tracker.data.agent).toEqual([[0, 15000], [3_600_000, 3_610_000]]);
    const restarted = new UsageTracker(4_000_000, tracker.data);
    restarted.checkpoint(4_010_000);
    expect(restarted.data.agent).toEqual(tracker.data.agent);
  });

  it("clips a delayed activity heartbeat at resume, even after a short sleep", () => {
    const tracker = new UsageTracker(0);
    tracker.activity(0, 5000);
    tracker.resume(12000);
    tracker.activity(5000, 15000);
    expect(tracker.data.active).toEqual([[0, 5000], [12000, 15000]]);
  });

  it("does not stop a newer turn when an old completion arrives twice", () => {
    const tracker = new UsageTracker(0);
    tracker.begin("a", "first", 0);
    tracker.end("a", "first", 5000);
    tracker.begin("a", "second", 10000);
    tracker.end("a", "first", 11000);
    tracker.end("a", "second", 15000);
    expect(tracker.data.agent).toEqual([[0, 5000], [10000, 15000]]);
  });
});
