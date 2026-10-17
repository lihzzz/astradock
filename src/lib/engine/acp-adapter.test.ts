import { describe, expect, it } from "vitest";
import { deriveToolName, normalizeToolInput, normalizeToolResult } from "./acp-adapter";

describe("ACP OpenCode tool compatibility", () => {
  it.each(["read", "edit"])("preserves Windows absolute paths in parsed %s commands", (kind) => {
    expect(normalizeToolInput({
      command: ["powershell", "-Command", "Get-Content a.ts"],
      cwd: "C:\\repo", parsed_cmd: [{ path: "C:\\repo\\a.ts" }],
    }, kind)).toEqual({ file_path: "C:\\repo\\a.ts" });
  });
  it("normalizes OpenCode tool titles when ACP omits kind", () => {
    expect(deriveToolName("bash")).toBe("Bash");
    expect(deriveToolName("read_file")).toBe("Read");
    expect(deriveToolName("apply_patch")).toBe("Edit");
    expect(deriveToolName("question")).toBe("AskUserQuestion");
  });

  it("normalizes OpenCode tool titles when kind is other", () => {
    expect(deriveToolName("grep", "other")).toBe("Grep");
    expect(deriveToolName("glob", "other")).toBe("Glob");
    expect(deriveToolName("todowrite", "other")).toBe("TodoWrite");
  });

  it("accepts OpenCode camelCase edit fields", () => {
    expect(normalizeToolInput(
      {
        filePath: "src/example.ts",
        oldString: "before",
        newString: "after",
      },
      "edit",
    )).toEqual({
      file_path: "src/example.ts",
      old_string: "before",
      new_string: "after",
    });
  });
});

// Preserve every ACP diff for the shared multi-file renderer and file tracking.
it("retains multiple ACP diff files including creations and deletions", () => {
  const result = normalizeToolResult(undefined, [
    { type: "diff", path: "a.ts", oldText: null, newText: "new" },
    { type: "diff", path: "b.ts", oldText: "old", newText: "" },
  ]);
  expect(result?.structuredPatch).toEqual([
    { filePath: "a.ts", kind: "add", oldString: "", newString: "new" },
    { filePath: "b.ts", kind: "update", oldString: "old", newString: "" },
  ]);
  expect(result?.filePath).toBeUndefined();
});
