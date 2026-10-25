import { removeFixture } from "./testing/fixture";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { clearHistoryReadCache } from "./read-cache";
it("removes only owned cache files without recursing into other content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-cache-"));
  try {
    const owned = "a".repeat(64) + ".sqlite";
    await fs.writeFile(path.join(root, owned), "index"); await fs.writeFile(path.join(root, owned + "-wal"), "wal");
    await fs.writeFile(path.join(root, "keep.jsonl"), "source"); await fs.mkdir(path.join(root, "subfolder"));
    await fs.writeFile(path.join(root, "subfolder", owned), "keep");
    await clearHistoryReadCache(root);
    expect((await fs.readdir(root)).sort()).toEqual(["keep.jsonl", "subfolder"]);
    expect(await fs.readFile(path.join(root, "subfolder", owned), "utf8")).toBe("keep");
  } finally { await removeFixture(root, "astradock-cache-"); }
});
