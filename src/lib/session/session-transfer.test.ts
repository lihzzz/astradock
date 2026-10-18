import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@shared/lib/session-persistence";
import type { UIMessage } from "@/types";
import {
  buildSessionTransferPrompt,
  buildTransferMarkdown,
  getHighestEffort,
} from "./session-transfer";

const session: SessionMeta = {
  id: "s1",
  projectId: "p1",
  title: "Refactor auth",
  createdAt: 0,
  lastMessageAt: 0,
  engine: "claude",
  model: "claude-sonnet",
};

function msg(role: UIMessage["role"], content: string): UIMessage {
  return { id: Math.random().toString(36).slice(2), role, content, timestamp: 1 };
}

describe("getHighestEffort", () => {
  it("returns undefined for an empty list", () => {
    expect(getHighestEffort([])).toBeUndefined();
  });

  it("picks the strongest known Claude level", () => {
    expect(getHighestEffort(["low", "medium", "high", "max"])).toBe("max");
  });

  it("picks the strongest known Codex level", () => {
    expect(getHighestEffort(["minimal", "low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(getHighestEffort(["low", "medium", "high", "xhigh", "max", "ultra"])).toBe("ultra");
  });

  it("is case-insensitive and falls back to list order for unknown levels", () => {
    expect(getHighestEffort(["LOW", "High"])).toBe("High");
    expect(getHighestEffort(["foo", "bar"])).toBe("bar");
  });
});

describe("buildTransferMarkdown", () => {
  it("exports all messages without the former inline prompt size cap", () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg("assistant", `message-${i} ${"x".repeat(4000)}`));
    const markdown = buildTransferMarkdown(session, messages);
    expect(new TextEncoder().encode(markdown).byteLength).toBeGreaterThan(240 * 1024);
    for (const message of messages) expect(markdown).toContain(message.content);
    expect(markdown).not.toContain("older message(s) omitted");
  });

  it("keeps actual prompts instead of display summaries and excludes queued messages", () => {
    const markdown = buildTransferMarkdown(session, [
      { ...msg("user", "Read C:/context/previous.md"), displayContent: "Transfer summary" },
      msg("assistant", "Current progress"),
      { ...msg("user", "Queued instruction"), isQueued: true },
    ]);
    expect(markdown).toContain("Read C:/context/previous.md");
    expect(markdown).toContain("Current progress");
    expect(markdown).not.toContain("Transfer summary");
    expect(markdown).not.toContain("Queued instruction");
  });
});

describe("buildSessionTransferPrompt", () => {
  const filePath = "C:/上下文目录/session context.md";
  it.each([undefined, "", "   \n\t  "])("uses the exact default template for empty objectives (%j)", (objective) => {
    expect(buildSessionTransferPrompt({ filePath, objective })).toBe(
      `上一轮会话的完整上下文已导出到 ${filePath}。请先阅读该文件，了解之前的讨论内容、进展和当前状态，然后从中断处继续完成未完成的任务`,
    );
  });

  it("uses the exact objective template and preserves internal newlines", () => {
    const objective = "只实现第 2 步\n不要重复已完成的任务";
    expect(buildSessionTransferPrompt({ filePath, objective: `  \n${objective}\n  ` })).toBe(
      `上一轮会话的完整上下文已导出到 ${filePath}。请先阅读该文件，了解之前的讨论内容、进展和当前状态，沿用已有决策和进度，不重复已完成的工作，然后以这些上下文为基础完成以下工作：\n\n${objective}`,
    );
  });
});
