import { expect, it } from "vitest";
import { parseClaudeJsonl } from "../cc-import-parser";
async function* lines(values: unknown[]) { for (const value of values) yield typeof value === "string" ? value : JSON.stringify(value); }
it("imports thinking, text and indexed tool results while ignoring malformed/sidechain rows", async () => {
  const result = await parseClaudeJsonl(lines([
    "broken", null, { type: "user", isSidechain: true, message: { content: "skip" } },
    { type: "user", uuid: "u", message: { content: "hello" } },
    { type: "assistant", uuid: "a", message: { content: [{ type: "thinking", thinking: "plan" }, { type: "text", text: "answer" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "test" } }] } },
    { type: "user", uuid: "r", message: { content: [{ type: "tool_result", tool_use_id: "t", content: [{ text: "output" }], is_error: true }] } },
  ]));
  expect(result.map(message => message.role)).toEqual(["user", "assistant", "tool_call", "tool_result"]);
  expect(result[1]).toMatchObject({ thinking: "plan", thinkingComplete: true, content: "answer" });
  expect(result[2]).toMatchObject({ toolError: true, toolResult: { stdout: "output" } });
});
it("preserves the supplied structured tool result and standalone thinking before a task", async () => {
  const result = await parseClaudeJsonl(lines([
    { type: "assistant", uuid: "a", message: { content: [{ type: "thinking", thinking: "plan" }, { type: "tool_use", id: "t", name: "Task" }] } },
    { type: "user", toolUseResult: { stdout: "structured", exitCode: 0 }, message: { content: [{ type: "tool_result", tool_use_id: "t", content: "plain" }] } },
  ]));
  expect(result[0]).toMatchObject({ role: "assistant", thinking: "plan", content: "" });
  expect(result[1]).toMatchObject({ subagentStatus: "completed", toolResult: { stdout: "structured", exitCode: 0 } });
});
