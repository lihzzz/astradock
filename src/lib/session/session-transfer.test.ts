import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@shared/lib/session-persistence";
import type { UIMessage } from "@/types";
import {
  buildSessionTransferPrompt,
  buildTransferMarkdown,
  TRANSFER_MARKDOWN_MAX_BYTES,
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

describe("buildTransferMarkdown", () => {
  it("returns the full transcript when it fits", () => {
    const { markdown, omittedCount } = buildTransferMarkdown(session, [
      msg("user", "hello"),
      msg("assistant", "hi"),
    ]);
    expect(markdown).toContain("# Refactor auth");
    expect(markdown).toContain("## User\n\nhello");
    expect(markdown).toContain("## Assistant\n\nhi");
    expect(omittedCount).toBe(0);
  });

  it("keeps the first and most recent messages when truncating", () => {
    const messages = [
      msg("user", "ORIGINAL_REQUEST"),
      ...Array.from({ length: 40 }, (_, i) => msg("assistant", `middle-${i} ${"x".repeat(400)}`)),
      msg("assistant", "LATEST_ANSWER"),
    ];
    const { markdown, omittedCount } = buildTransferMarkdown(session, messages, 8 * 1024);
    expect(omittedCount).toBeGreaterThan(0);
    expect(markdown).toContain("ORIGINAL_REQUEST");
    expect(markdown).toContain("LATEST_ANSWER");
    expect(markdown).toContain("omitted");
    expect(new TextEncoder().encode(markdown).byteLength).toBeLessThanOrEqual(8 * 1024);
  });

  it("never exceeds the default cap for huge transcripts", () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg("assistant", `m${i} ${"y".repeat(4000)}`));
    const { markdown } = buildTransferMarkdown(session, messages);
    expect(new TextEncoder().encode(markdown).byteLength).toBeLessThanOrEqual(TRANSFER_MARKDOWN_MAX_BYTES + 1024);
  });
});

describe("buildSessionTransferPrompt", () => {
  it("embeds takeover instructions and the transcript", () => {
    const { prompt, messageCount, omittedCount } = buildSessionTransferPrompt({
      session,
      messages: [msg("user", "do X"), msg("assistant", "done X")],
      projectPath: "E:/repo",
    });
    expect(prompt).toContain("taking over an ongoing work session");
    expect(prompt).toContain("claude");
    expect(prompt).toContain("E:/repo");
    expect(prompt).toContain("## User\n\ndo X");
    expect(messageCount).toBe(2);
    expect(omittedCount).toBe(0);
  });
});
