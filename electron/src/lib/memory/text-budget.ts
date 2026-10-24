/** UTF-8 bytes are used as a conservative prompt-size budget, not a fake exact token count. */
export function clipMemoryText(value: string, maxBytes: number): string {
  let remaining = maxBytes; const result: string[] = [];
  for (const character of value) { const bytes = Buffer.byteLength(character, "utf8"); if (bytes > remaining) break; remaining -= bytes; result.push(character); }
  return result.join("");
}
