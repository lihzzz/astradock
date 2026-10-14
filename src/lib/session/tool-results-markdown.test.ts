import { describe, expect, it } from "vitest";
import { renderToolCall, sanitizeExportFileName } from "@shared/lib/session-markdown";

describe("tool Markdown export", () => {
  it("preserves source order, errors, nested steps, valid times and code fences", () => {
    const output = [
      { id: "a", role: "tool_call", toolName: "Read", timestamp: 1, toolInput: { path: "file" }, toolResult: { content: "```md\ntext\n```" } },
      { id: "b", role: "tool_call", toolName: "Bash", toolError: true, toolResult: { stderr: "failed" }, subagentSteps: [{ toolName: "inner", toolError: true, toolResult: { stdout: "nested output" } }] },
    ].map(renderToolCall).join("\n\n");
    expect(output.indexOf("Tool call: Read")).toBeLessThan(output.indexOf("Tool call: Bash"));
    expect(output).toContain("````");
    expect(output).toContain("**Error**");
    expect(output).toContain("nested output");
    expect(output).toContain("1970-01-01T00:00:00.001Z");
  });
  it("produces safe export stems including reserved Windows names and long CJK titles", () => {
    expect(sanitizeExportFileName("CON")).toBe("session-CON");
    expect(sanitizeExportFileName("a/b:c*?")).not.toMatch(/[/:*?]/);
    expect(new TextEncoder().encode(sanitizeExportFileName("中文标题".repeat(100))).byteLength).toBeLessThanOrEqual(140);
  });
});
