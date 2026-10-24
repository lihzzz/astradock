import { afterEach, expect, it, vi } from "vitest";
import { listProjectFilesShared, sameFileList } from "./list-cache";
afterEach(() => vi.unstubAllGlobals());
it("shares only in-flight scans and refetches after completion", async () => {
  let finish!: (result: { files: string[] }) => void;
  const listAll = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  vi.stubGlobal("window", { claude: { files: { listAll } } });
  const first = listProjectFilesShared("project"); const second = listProjectFilesShared("project");
  expect(first).toBe(second); expect(listAll).toHaveBeenCalledTimes(1);
  finish({ files: ["a"] }); await first;
  const next = listProjectFilesShared("project"); expect(listAll).toHaveBeenCalledTimes(2);
  finish({ files: ["b"] }); await next;
});
it("compares directory listings without rebuilding unchanged trees", () => {
  expect(sameFileList(["a", "b"], ["a", "b"])).toBe(true);
  expect(sameFileList(["a"], ["b"])).toBe(false);
  expect(sameFileList(["a"], ["a", "b"])).toBe(false);
});
