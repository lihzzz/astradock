import { describe, expect, it } from "vitest";
import { fileUrlToPortablePath, getFileDirectory, getFileName, parseLocalFileLink, resolvePortableFilePath } from "@shared/lib/file-paths";
import { getRelativePath } from "./file-access";
import { getLanguageFromPath } from "./languages";
import { getMonacoLanguageFromPath } from "./monaco";

describe("portable local file links", () => {
  it.each([
    ["C:/项目/a.ts:12", "C:/项目/a.ts", 12],
    ["C:\\项目\\a.ts#L12", "C:\\项目\\a.ts", 12],
    ["\\\\server\\share\\a.ts:7", "\\\\server\\share\\a.ts", 7],
    ["/Users/me/a.ts:3:8", "/Users/me/a.ts", 3],
    ["docs/remote-workbench/implementation-plan.md#L4", "docs/remote-workbench/implementation-plan.md", 4],
    ["README.md#L4", "README.md", 4],
    ["./src/a.ts#L4", "./src/a.ts", 4],
    ["../src/a.ts:5", "../src/a.ts", 5],
    ["file:///C:/My%20Project/%E4%B8%AD%E6%96%87.ts#L6", "C:/My Project/中文.ts", 6],
    ["file://server/share/a.ts#L8", "\\\\server\\share\\a.ts", 8],
    ["file:///Users/me/a.ts#L9", "/Users/me/a.ts", 9],
    ["file:///C:/repo/a.ts:10", "C:/repo/a.ts", 10],
  ])("resolves %s", (href, filePath, line) => {
    expect(parseLocalFileLink(href)).toEqual({ filePath, line });
  });

  it.each(["#section", "?page=2", "https://example.com/a.ts", "//example.com/a.ts", "javascript:alert(1)", "data:text/html,hi", "mailto:test@example.com", "file:///a%00.txt", "file:///a%2fb", "file:///a%ZZ", "C:/a\u0000.txt"])("does not interpret unsafe or non-file URL %s as a local path", (href) => {
    expect(parseLocalFileLink(href)).toBeNull();
  });

  it("decodes URI spaces while preserving literal percents and drive roots", () => {
    expect(parseLocalFileLink("C:/My%20Project/a.ts")).toEqual({ filePath: "C:/My Project/a.ts" });
    expect(parseLocalFileLink("C:/100%/a.ts")).toEqual({ filePath: "C:/100%/a.ts" });
    expect(fileUrlToPortablePath("file://localhost/C:/a.ts")).toBe("C:/a.ts");
    expect(parseLocalFileLink("file:///C:/100%2520/a.ts")).toEqual({ filePath: "C:/100%20/a.ts" });
    expect(getFileDirectory("C:\\a.ts")).toBe("C:/");
  });
});

describe("agent and display paths", () => {
  it.each(["C:\\repo\\a.ts", "C:/repo/a.ts", "\\\\server\\share\\a.ts", "/Users/me/a.ts"])("does not prefix absolute %s with cwd", (value) => {
    expect(resolvePortableFilePath(value, "C:\\repo\\")).toBe(value);
  });
  it("joins relative paths without duplicated separators", () => {
    expect(resolvePortableFilePath("src/a.ts", "C:\\repo\\")).toBe("C:\\repo/src/a.ts");
  });
  it("separates names and directories with both path separators", () => {
    expect(getFileName("C:\\repo\\中文.ts")).toBe("中文.ts");
    expect(getRelativePath("c:\\Repo\\src\\a.ts", "C:/repo")).toEqual({ fileName: "a.ts", dirPath: "src" });
    expect(getRelativePath("/repo-other/a.ts", "/repo")).toEqual({ fileName: "a.ts", dirPath: "/repo-other" });
  });
  it.each([
    ["C:\\repo\\Dockerfile", "docker", "dockerfile"],
    ["C:\\repo\\.env.local", "bash", "shell"],
    ["/Users/me/.env", "bash", "shell"],
    ["\\\\server\\share\\a.ts", "typescript", "typescript"],
  ])("detects special names and extensions in %s", (value, prism, monaco) => {
    expect(getLanguageFromPath(value)).toBe(prism);
    expect(getMonacoLanguageFromPath(value)).toBe(monaco);
  });
});
