import fs from "node:fs/promises";
import path from "node:path";
const CACHE_FILE = /^[a-f0-9]{64}\.sqlite(?:-wal|-shm)?$/;
/** Only unlink this feature's derived files. Never recurse or follow a junction. */
export async function clearHistoryReadCache(directory: string): Promise<void> {
  let entries;
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing a redirected cache directory");
    entries = await fs.readdir(directory, { withFileTypes: true });
  }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  const root = path.resolve(directory);
  for (const entry of entries) {
    if (!entry.isFile() || !CACHE_FILE.test(entry.name)) continue;
    const target = path.resolve(root, entry.name);
    if (path.dirname(target) !== root) throw new Error("Invalid cache path");
    await fs.unlink(target);
  }
}
