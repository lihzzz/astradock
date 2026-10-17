import { describe, expect, it } from "vitest";
import type { UIMessage } from "@/types";
import { getToolStatus, getCommandActivity, getToolGroupSummary, needsToolAttention } from "./tool-activity";

const base: UIMessage = { id: "tool", role: "tool_call", toolName: "Bash", content: "", timestamp: 0 };
describe("tool activity presentation", () => {
  it("uses lifecycle state rather than the presence of streamed output", () => {
    expect(getToolStatus({ ...base, toolState: { status: "inProgress" }, toolResult: { stdout: "partial" } })).toBe("inProgress");
    expect(getToolStatus({ ...base, toolState: { status: "completed" } })).toBe("completed");
    expect(getToolStatus({ ...base, toolState: { status: "completed", exitCode: 1 } })).toBe("failed");
    expect(getToolStatus({ ...base, toolError: true })).toBe("failed");
    expect(getToolStatus({ ...base, toolResult: { content: "old history" } })).toBe("completed");
    expect(getToolStatus(base)).toBe("inProgress");
    expect(needsToolAttention({ ...base, toolState: { status: "declined" } })).toBe(true);
  });
  it("labels reads/searches but does not mislabel mixed or unknown shell commands", () => {
    const read = { type: "read", command: "cat a.ts", name: "a.ts", path: "src/a.ts" } as const;
    expect(getCommandActivity({ ...base, commandExecution: { cwd: "/repo", processId: null, actions: [read] } })).toEqual({ toolName: "Read", summary: "src/a.ts" });
    const search = { type: "search", command: "rg query src", query: "query", path: "src" } as const;
    expect(getCommandActivity({ ...base, commandExecution: { cwd: "/repo", processId: null, actions: [search] } })).toEqual({ toolName: "Grep", summary: "“query” in src" });
    expect(getCommandActivity({ ...base, commandExecution: { cwd: "/repo", processId: null, actions: [read, search] } })).toBeNull();
    expect(getCommandActivity({ ...base, commandExecution: { cwd: "/repo", processId: null, actions: [{ type: "unknown", command: "pnpm test" }] } })).toBeNull();
  });
  it("counts distinct changed files instead of tool calls and keeps meaningful targets", () => {
    const edit: UIMessage = { ...base, toolName: "Edit", toolInput: { file_path: "src/a.ts" }, toolResult: { structuredPatch: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }] } };
    const result = getToolGroupSummary([edit, { ...edit, id: "again" }]);
    expect(result.label).toBe("2 files edited");
    expect(result.detail).toBe("a.ts, b.ts");
  });
  it("counts command reads as files rather than generic commands", () => {
    const read: UIMessage = { ...base, commandExecution: { cwd: "/repo", processId: null, actions: [{ type: "read", command: "cat a.ts", name: "a.ts", path: "a.ts" }] } };
    expect(getToolGroupSummary([read, { ...read, id: "again" }])).toEqual({ label: "1 file read", detail: "a.ts" });
  });
});
