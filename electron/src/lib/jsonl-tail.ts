import fs from "node:fs/promises";

/** Repair a torn final record before appending. Keep a complete record missing only its newline. */
export async function repairJsonlTail(file: string): Promise<void> {
  const handle = await fs.open(file, "r+");
  try {
    const { size } = await handle.stat();
    if (!size) return;
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    let end = size;
    let boundary = 0;
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) { boundary = start + newline + 1; break; }
      end = start;
    }
    if (boundary === size) return;
    const tail = Buffer.alloc(size - boundary);
    let offset = 0;
    while (offset < tail.length) {
      const { bytesRead } = await handle.read(tail, offset, tail.length - offset, boundary + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let complete = false;
    try { JSON.parse(tail.subarray(0, offset).toString("utf8")); complete = offset === tail.length; } catch { /* Torn tail. */ }
    if (complete) await handle.write("\n", size, "utf8");
    else await handle.truncate(boundary);
  } finally { await handle.close(); }
}
