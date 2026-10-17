import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UIMessage } from "@/types";
import { ChatUiStateProvider } from "./chat-ui-state";
import { TooltipProvider } from "./ui/tooltip";
import { MessageBubble } from "./MessageBubble";
import { ToolGroupBlock } from "./ToolGroupBlock";

const assistant: UIMessage = { id: "answer", role: "assistant", content: "Visible message", timestamp: 0 };
function renderMessage(message: UIMessage) {
  return renderToStaticMarkup(<TooltipProvider><ChatUiStateProvider><MessageBubble message={message} /></ChatUiStateProvider></TooltipProvider>);
}
describe("phase-aware conversation hierarchy", () => {
  it("distinguishes progress from the final response", () => {
    const progress = renderMessage({ ...assistant, phase: "commentary" });
    const answer = renderMessage({ ...assistant, phase: "final_answer" });
    expect(progress).toContain('data-message-phase="commentary"');
    expect(progress).toContain("Progress");
    expect(answer).toContain('data-message-phase="final_answer"');
    expect(answer).toContain("Response");
  });
  it("keeps old messages readable without guessing their phase", () => {
    const markup = renderMessage(assistant);
    expect(markup).toContain("Visible message");
    expect(markup).not.toContain("data-message-phase");
    expect(markup).not.toContain("Progress");
  });
  it("keeps meaningful group summaries visible without mounting tool output", () => {
    const tools: UIMessage[] = ["a.ts", "b.ts"].map(path => ({ id: path, role: "tool_call", content: "", timestamp: 0,
      toolName: "Bash", toolInput: { command: "cat " + path }, toolState: { status: "completed" }, toolResult: { stdout: "large hidden output" },
      commandExecution: { cwd: "/repo", processId: null, actions: [{ type: "read", command: "cat " + path, name: path, path }] } }));
    const markup = renderToStaticMarkup(<ChatUiStateProvider><ToolGroupBlock tools={tools} messages={tools} animate={false} disableCollapseAnimation /></ChatUiStateProvider>);
    expect(markup).toContain("2 files read");
    expect(markup).toContain("a.ts, b.ts");
    expect(markup).not.toContain("large hidden output");
    expect(markup).toContain('aria-expanded="false"');
  });
});
