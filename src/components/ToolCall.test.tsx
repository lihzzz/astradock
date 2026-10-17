import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "@/types";
import { ChatUiStateProvider } from "./chat-ui-state";
import { ToolCall } from "./ToolCall";

describe("ToolCall", () => {
  it("renders presented plans expanded and full by default", () => {
    const plan = `# Implementation Plan

${Array.from({ length: 220 }, (_, index) => `- Step ${index + 1}`).join("\n")}`;
    const message: UIMessage = {
      id: "plan-1",
      role: "tool_call",
      content: "",
      toolName: "ExitPlanMode",
      toolInput: {
        plan,
        filePath: "/repo/.codex/plan.md",
      },
      toolResult: {
        content: "Plan: 220 steps",
      },
      timestamp: 0,
    };

    const markup = renderToStaticMarkup(
      <ChatUiStateProvider>
        <ToolCall message={message} disableCollapseAnimation />
      </ChatUiStateProvider>,
    );

    expect(markup).toContain("Presented plan");
    expect(markup).toContain("Step 220");
    expect(markup).not.toContain("Show full plan");
  });
});


function renderTool(message: UIMessage) {
  return renderToStaticMarkup(<ChatUiStateProvider><ToolCall message={message} disableCollapseAnimation /></ChatUiStateProvider>);
}
const command: UIMessage = { id: "command", role: "tool_call", content: "", timestamp: 0, toolName: "Bash",
  toolInput: { command: "pnpm test" }, toolState: { status: "inProgress" },
  commandExecution: { cwd: "/repo", processId: null, actions: [{ type: "unknown", command: "pnpm test" }] } };

it("renders live output without falsely showing completion", () => {
  const markup = renderTool({ ...command, toolResult: { stdout: "partial output" } });
  expect(markup).toContain('data-tool-status="inProgress"');
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain("partial output");
  expect(markup).not.toContain('data-tool-status="completed"');
});
it("shows completed empty-output tools as completed", () => {
  expect(renderTool({ ...command, toolState: { status: "completed", durationMs: 120 } })).toContain('data-tool-status="completed"');
});
it("keeps failure context and exit status visible", () => {
  const markup = renderTool({ ...command, toolState: { status: "failed", durationMs: 1200, exitCode: 1 }, toolResult: { stdout: "Test assertion failed" } });
  expect(markup).toContain('aria-expanded="true"');
  expect(markup).toContain("Test assertion failed");
  expect(markup).toContain("exit 1");
  expect(markup).toContain("1.2s");
});
it("uses the read semantic without mounting command output in history", () => {
  const markup = renderTool({ ...command, toolState: { status: "completed" }, toolResult: { stdout: "large hidden output" },
    commandExecution: { cwd: "/repo", processId: null, actions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }] } });
  expect(markup).toContain("Read"); expect(markup).toContain("src/a.ts");
  expect(markup).not.toContain("large hidden output");
});
it("retains multi-file summaries without mounting the full diffs", () => {
  const markup = renderTool({ id: "edit", role: "tool_call", toolName: "Edit", content: "", timestamp: 0, toolInput: { file_path: "src/a.ts" },
    toolState: { status: "completed" }, toolResult: { structuredPatch: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }] } });
  expect(markup).toContain("src/a.ts"); expect(markup).toContain("src/b.ts");
  expect(markup).toContain('aria-expanded="false"');
});

it("keeps unanswered questions expanded independently of tool preferences", () => {
  const markup = renderTool({ id: "question", role: "tool_call", toolName: "AskUserQuestion", content: "", timestamp: 0,
    toolInput: { questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "First" }] }] } });
  expect(markup).toContain("Which approach?");
});
