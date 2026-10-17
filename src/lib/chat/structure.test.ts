import { expect, it } from "vitest";
import type { UIMessage } from "@/types";
import { createChatStructureTracker } from "./structure";
const tool: UIMessage = { id: "tool", role: "tool_call", content: "", timestamp: 0, toolName: "Bash", toolState: { status: "inProgress" } };
it("does not invalidate groups for partial command output or assistant tokens", () => {
  const track = createChatStructureTracker();
  const first = track([tool], true);
  expect(track([{ ...tool, toolResult: { stdout: "first" } }], true)).toBe(first);
  expect(track([{ ...tool, toolResult: { stdout: "first second" } }], true)).toBe(first);
  const text: UIMessage = { id: "text", role: "assistant", content: "first", timestamp: 0, isStreaming: true };
  const textRevision = track([text], true);
  expect(track([{ ...text, content: "first second" }], true)).toBe(textRevision);
});
it("invalidates on completion even if output already exists", () => {
  const track = createChatStructureTracker();
  const running = { ...tool, toolResult: { stdout: "done" } };
  const first = track([running], true);
  expect(track([{ ...running, toolState: { status: "completed" } }], true)).toBeGreaterThan(first);
});
it("detects changes outside the last ten messages and phase changes", () => {
  const track = createChatStructureTracker();
  const messages = Array.from({ length: 20 }, (_, i) => ({ ...tool, id: String(i) }));
  const first = track(messages, true);
  const completed = [...messages]; completed[0] = { ...completed[0], toolState: { status: "failed" } };
  expect(track(completed, true)).toBeGreaterThan(first);
  const text: UIMessage = { id: "text", role: "assistant", content: "message", timestamp: 0, phase: "commentary" };
  const next = track([text], false);
  expect(track([{ ...text, phase: "final_answer" }], false)).toBeGreaterThan(next);
});
it("refreshes corrected completed results and ignores unchanged objects", () => {
  const track = createChatStructureTracker();
  const done: UIMessage = { ...tool, toolState: { status: "completed" }, toolResult: { stdout: "a" } };
  const first = track([done], false);
  expect(track([done], false)).toBe(first);
  expect(track([{ ...done, toolResult: { stdout: "b" } }], false)).toBeGreaterThan(first);
});
