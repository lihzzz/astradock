import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";
import { confineToWorkspace } from "../collaboration-workspace";

describe("confineToWorkspace", () => {
  const root = path.resolve("/tmp/workspace");

  it("resolves relative paths and file URLs inside the workspace", () => {
    expect(confineToWorkspace(root, "src/app.ts")).toBe(path.join(root, "src/app.ts"));
    const inside = pathToFileURL(path.join(root, "src/app.ts")).href;
    expect(confineToWorkspace(root, inside)).toBe(path.join(root, "src/app.ts"));
  });

  it("rejects paths and file URLs that leave the workspace", () => {
    expect(() => confineToWorkspace(root, "../secret")).toThrow(/outside the workspace/);
    const outside = pathToFileURL(path.resolve(root, "../secret")).href;
    expect(() => confineToWorkspace(root, outside)).toThrow(/outside the workspace/);
  });
});
