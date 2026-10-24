import fs from "node:fs/promises";
import path from "node:path";

export const CONTEXT_BYTE_LIMIT = 400_000;
export const CONTEXT_FILE_LIMIT = 500_000;

export async function scopedFile(root: string, relative: string): Promise<string> {
  const file = await fs.realpath(path.resolve(root, relative));
  const rel = path.relative(root, file);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Path outside project directory");
  return file;
}

/** Bounded reads remain bounded even when the file grows after stat. */
export async function readBoundedText(file: string, maxBytes: number): Promise<{ content: string; bytes: number }> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a regular file");
    if (stat.size > maxBytes) throw new Error("File exceeds the remaining content byte limit");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - bytes + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw new Error("File exceeds the remaining content byte limit");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return { content: Buffer.concat(chunks).toString("utf8"), bytes };
  } finally { await handle.close(); }
}
