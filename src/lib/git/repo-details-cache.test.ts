import { afterEach, describe, expect, it, vi } from "vitest";
import { repoDetails } from "./repo-details-cache";
const status = { branch: "main", head: "abc", ahead: 0, behind: 0, files: [] };
afterEach(() => vi.unstubAllGlobals());
describe("shared repository details", () => {
  it("deduplicates concurrent reads and refreshes on HEAD changes or explicit actions", async () => {
    const branches = vi.fn(async () => []); const log = vi.fn(async () => []);
    vi.stubGlobal("window", { claude: { git: { branches, log } } });
    const cwd = crypto.randomUUID();
    await Promise.all([repoDetails(cwd, status, false), repoDetails(cwd, status, false)]);
    await repoDetails(cwd, status, false); expect(log).toHaveBeenCalledTimes(1);
    await repoDetails(cwd, { ...status, head: "def" }, false); expect(log).toHaveBeenCalledTimes(2);
    await repoDetails(cwd, { ...status, head: "def" }, true); expect(log).toHaveBeenCalledTimes(3);
  });
});
