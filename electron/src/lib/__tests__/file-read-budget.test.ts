import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_BYTE_LIMIT, readBoundedText, scopedFile } from "../file-read-budget";
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "astradock-budget-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
describe("bounded attachment reads", () => {
  it("charges UTF-8 bytes rather than UTF-16 characters", async () => {
    const file = path.join(root, "text"); await fs.writeFile(file, "中文");
    await expect(readBoundedText(file, 5)).rejects.toThrow("byte limit");
    expect(await readBoundedText(file, 6)).toEqual({ content: "中文", bytes: 6 });
  });
  it("rejects the second 300KB attachment against the remaining total budget", async () => {
    const file = path.join(root, "text"); await fs.writeFile(file, "a".repeat(300000));
    const first = await readBoundedText(file, CONTEXT_BYTE_LIMIT);
    await expect(readBoundedText(file, CONTEXT_BYTE_LIMIT - first.bytes)).rejects.toThrow("byte limit");
  });
  it("rejects out-of-project paths", async () => {
    await expect(scopedFile(root, "..")).rejects.toThrow("outside project");
  });
});
