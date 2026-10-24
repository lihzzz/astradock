import { describe, expect, it } from "vitest";
import { buildFileTree, collectDirPaths, flattenTree } from "./file-tree";
describe("file tree collation", () => {
  it("preserves locale-aware case-insensitive ordering and directory priority", () => {
    const names = ["Zebra.ts", "alpha.ts", "Éclair.ts", "eclair.ts", "甲.ts", "乙.ts"];
    const expected = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const tree = buildFileTree([...names, "folder/nested.ts"]);
    expect(tree[0].type).toBe("directory");
    expect(tree.slice(1).map(node => node.name)).toEqual(expected);
  });
  it("keeps all files and stable path identities in a large tree", () => {
    const paths = Array.from({ length: 10000 }, (_, i) => `packages/pkg-${i % 20}/src/module-${i}.ts`);
    const tree = buildFileTree(paths);
    const rows = flattenTree(tree, collectDirPaths(tree));
    expect(rows.filter(row => row.node.type === "file")).toHaveLength(10000);
    expect(new Set(rows.map(row => row.node.path)).size).toBe(rows.length);
  });
});
