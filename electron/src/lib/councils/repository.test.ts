import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CouncilRepository } from "./repository";
const dirs: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "council-store-test-"));
  dirs.push(root);
  return new CouncilRepository(root);
}
afterEach(async () => {
  for (const root of dirs.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
describe("Council durable catalog", () => {
  it("starts empty and roundtrips an atomic catalog", async () => {
    const repo = await fixture();
    const state = await repo.load();
    expect(state).toEqual({
      version: 1,
      revision: 0,
      councils: [],
      runs: []
    });
    state.revision = 4;
    await repo.save(state);
    expect(await repo.load()).toEqual(state);
  });
  it("preserves malformed files instead of resetting them", async () => {
    const repo = await fixture();
    const file = path.join(repo.root, "catalog.json");
    await fs.writeFile(file, "broken-json");
    await expect(repo.load()).rejects.toThrow("original file preserved");
    expect(await fs.readFile(file, "utf8")).toBe("broken-json");
  });
  it("rejects future schema versions without overwriting", async () => {
    const repo = await fixture();
    await fs.writeFile(path.join(repo.root, "catalog.json"), JSON.stringify({
      version: 99,
      revision: 0,
      councils: [],
      runs: []
    }));
    await expect(repo.load()).rejects.toThrow("unsupported");
  });
});
