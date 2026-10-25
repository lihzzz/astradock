import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
/** Never recursively clean a computed path before checking the fixture boundary. */
export async function removeFixture(directory: string, prefix: string): Promise<void> {
  const target = path.resolve(directory), parent = path.resolve(os.tmpdir());
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(prefix)) throw new Error("Refusing cleanup outside the fixture root");
  const info = await fs.lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing a redirected fixture root");
  await fs.rm(target, { recursive: true, force: true });
}
