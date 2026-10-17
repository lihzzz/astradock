import { describe, expect, it } from "vitest";
import { computeToolGroups } from "@/lib/workspace/tool-groups";
import type { UIMessage } from "@/types";

function makeToolCall(id: string, toolName: string, timestamp: number): UIMessage {
  return {
    id,
    role: "tool_call",
    content: "",
    timestamp,
    toolName,
    toolInput: {},
  };
}

function makeAssistant(id: string, content: string, timestamp: number): UIMessage {
  return {
    id,
    role: "assistant",
    content,
    timestamp,
  };
}

describe("computeToolGroups", () => {
  it("groups contiguous tool calls when edit boundaries are disabled", () => {
    const messages: UIMessage[] = [
      makeAssistant("a0", "Starting", 0),
      makeToolCall("t1", "Read", 1),
      makeToolCall("t2", "Read", 2),
      makeToolCall("t3", "Edit", 3),
      makeToolCall("t4", "Read", 4),
      makeToolCall("t5", "Read", 5),
      makeAssistant("a1", "Done", 6),
    ];

    const result = computeToolGroups(messages, false, false);
    const group = result.groups.get(1);

    expect(result.groups.size).toBe(1);
    expect(group?.tools.map((message) => message.id)).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect([...result.groupedIndices]).toEqual([1, 2, 3, 4, 5]);
  });

  it("treats edit and write tools as standalone boundaries when enabled", () => {
    const messages: UIMessage[] = [
      makeAssistant("a0", "Starting", 0),
      makeToolCall("t1", "Read", 1),
      makeToolCall("t2", "Read", 2),
      makeToolCall("t3", "Edit", 3),
      makeToolCall("t4", "Read", 4),
      makeToolCall("t5", "Read", 5),
      makeToolCall("t6", "Write", 6),
      makeToolCall("t7", "Read", 7),
      makeToolCall("t8", "Read", 8),
      makeAssistant("a1", "Done", 9),
    ];

    const result = computeToolGroups(messages, false, true);

    expect(result.groups.size).toBe(3);
    expect(result.groups.get(1)?.tools.map((message) => message.id)).toEqual(["t1", "t2"]);
    expect(result.groups.get(4)?.tools.map((message) => message.id)).toEqual(["t4", "t5"]);
    expect(result.groups.get(7)?.tools.map((message) => message.id)).toEqual(["t7", "t8"]);
    expect(result.groupedIndices.has(3)).toBe(false);
    expect(result.groupedIndices.has(6)).toBe(false);
  });
});


describe("Codex subagent cards", () => {
  it("keeps agent cards visible between collapsed ordinary tool groups", () => {
    const messages = ["Read", "Bash", "CodexAgent", "Read", "Bash"].map((name, index) => makeToolCall(String(index), name, index));
    const groups = computeToolGroups(messages, false, false);
    expect(groups.groupedIndices.has(2)).toBe(false);
    expect(groups.groups.size).toBe(2);
  });
});


describe("activity boundaries", () => {
  const read = (id: string): UIMessage => ({ ...makeToolCall(id, "Read", 0), toolResult: { content: "done" } });
  it.each(["failed", "declined", "interrupted", "inProgress"] as const)("never folds %s tools into completed activity", status => {
    const attention: UIMessage = { ...read("attention"), toolState: { status } };
    const result = computeToolGroups([read("a"), read("b"), attention, read("c"), read("d")], false, false);
    expect(result.groups.size).toBe(2);
    expect(result.groupedIndices.has(2)).toBe(false);
  });
  it("keeps actual command execution independent from exploration", () => {
    const command: UIMessage = { ...read("command"), toolName: "Bash", toolState: { status: "completed" }, commandExecution: { cwd: "/repo", processId: null, actions: [{ type: "unknown", command: "pnpm test" }] } };
    const result = computeToolGroups([read("a"), read("b"), command, read("c"), read("d")], false, false);
    expect(result.groupedIndices.has(2)).toBe(false);
  });
  it("never merges tools across user turns or error notices", () => {
    for (const role of ["user", "system", "summary"] as const) {
      const boundary: UIMessage = { id: "boundary", role, content: "notice", timestamp: 1 };
      expect(computeToolGroups([read("a"), boundary, read("b")], false, false).groups.size).toBe(0);
    }
    expect(computeToolGroups([{ ...read("a"), turnId: "one" }, { ...read("b"), turnId: "two" }], false, false).groups.size).toBe(0);
  });
});
