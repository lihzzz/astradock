import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it, vi } from "vitest";
import { parseLocalFileLink, type LocalFileLink } from "@shared/lib/file-paths";
import { markdownUrlTransform, openMarkdownLink } from "./markdown-links";

describe("Markdown file links", () => {
  it("preserves actual renderer anchor hrefs for Windows, macOS and UNC paths", () => {
    const targets: Array<LocalFileLink | null> = [];
    renderToStaticMarkup(createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: { a: ({ href, children }) => { targets.push(parseLocalFileLink(href ?? "")); return createElement("a", { href }, children); } },
      children: "[win](<C:/My Project/中文.ts:4>) [mac](/Users/me/a.ts#L5) [unc](file://server/share/a.ts#L6) [plan](docs/remote-workbench/implementation-plan.md)",
    }));
    expect(targets).toEqual([
      { filePath: "C:/My Project/中文.ts", line: 4 },
      { filePath: "/Users/me/a.ts", line: 5 },
      { filePath: "\\\\server\\share\\a.ts", line: 6 },
      { filePath: "docs/remote-workbench/implementation-plan.md" },
    ]);
  });
  it("retains the default unsafe URL policy and does not load local file images", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      urlTransform: markdownUrlTransform,
      components: { img: ({ src, alt }) => createElement("img", { src: src || undefined, alt }) },
      children: "[unsafe](javascript:alert) [web](https://example.com) ![local](file:///C:/secret.png)",
    }));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("file:");
    expect(html).toContain('href="https://example.com"');
  });
});

describe("opening chat file links", () => {
  const makeBridge = () => ({
    openInEditor: vi.fn<(...args: unknown[]) => Promise<{ ok?: boolean; error?: string }>>().mockResolvedValue({ ok: true }),
    openExternal: vi.fn<(...args: unknown[]) => Promise<{ ok?: boolean; error?: string }>>().mockResolvedValue({ ok: true }),
  });
  it.each([
    ["docs/remote-workbench/implementation-plan.md", "E:/repo/docs/remote-workbench/implementation-plan.md", undefined],
    ["./docs/plan.md#L12", "E:/repo/./docs/plan.md", 12],
    ["../shared/plan.md:4", "E:/repo/../shared/plan.md", 4],
    ["README.md", "E:/repo/README.md", undefined],
    ["docs/My%20Plan.md", "E:/repo/docs/My Plan.md", undefined],
    ["C:/other/plan.md:7", "C:/other/plan.md", 7],
  ])("opens %s relative to the session rather than externally", async (href, filePath, line) => {
    const bridge = makeBridge();
    await openMarkdownLink(href, "E:/repo", bridge);
    expect(bridge.openInEditor).toHaveBeenCalledWith(filePath, line);
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });
  it("uses each pane's cwd, including a worktree", async () => {
    const bridge = makeBridge();
    await openMarkdownLink("docs/plan.md", "E:/repo", bridge);
    await openMarkdownLink("docs/plan.md", "E:/worktrees/feature", bridge);
    expect(bridge.openInEditor.mock.calls).toEqual([
      ["E:/repo/docs/plan.md", undefined],
      ["E:/worktrees/feature/docs/plan.md", undefined],
    ]);
  });
  it("does not open Explorer or an editor when the relative path has no cwd", async () => {
    const bridge = makeBridge();
    expect(await openMarkdownLink("docs/plan.md", undefined, bridge)).toHaveProperty("error");
    expect(bridge.openInEditor).not.toHaveBeenCalled();
    expect(bridge.openExternal).not.toHaveBeenCalled();
  });
  it("keeps web links external and propagates file-open errors", async () => {
    const bridge = makeBridge();
    await openMarkdownLink("https://example.com/docs/plan.md", "E:/repo", bridge);
    expect(bridge.openExternal).toHaveBeenCalledWith("https://example.com/docs/plan.md");
    bridge.openInEditor.mockResolvedValue({ error: "File not found" });
    expect(await openMarkdownLink("docs/plan.md", "E:/repo", bridge)).toEqual({ error: "File not found" });
  });
});
