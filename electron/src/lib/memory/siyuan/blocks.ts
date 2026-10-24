import { z } from "zod";
import { blockId } from "@shared/lib/memory";
import type { MemoryReadScope } from "@shared/types/memory";
import { MemoryError, SiyuanClient } from "./connection";
export const attributesSchema = z.record(z.string(), z.string());
export async function attributes(client: SiyuanClient, id: string): Promise<Record<string, string>> {
  return client.api("/api/attr/getBlockAttrs", { id: blockId.parse(id) }, attributesSchema);
}
export async function location(client: SiyuanClient, id: string): Promise<{ notebook: string; path: string }> {
  return client.api("/api/filetree/getPathByID", { id: blockId.parse(id) }, z.object({ notebook: blockId, path: z.string().regex(/^\/(?:\d{14}-[a-z0-9]{7}\/)*\d{14}-[a-z0-9]{7}\.sy$/) }));
}
export async function documentLocation(client: SiyuanClient, id: string) {
  const loc = await location(client, id);
  if (!loc.path.endsWith("/" + id + ".sy")) throw new MemoryError("binding-invalid", "绑定目标必须是文档而非段落或标题");
  return loc;
}
export async function assertScope(client: SiyuanClient, id: string, scopes: MemoryReadScope[]): Promise<void> {
  const loc = await location(client, id);
  for (const scope of scopes) {
    const root = await documentLocation(client, scope.documentId);
    if (root.notebook !== scope.notebookId) continue;
    if (loc.notebook === root.notebook && (loc.path === root.path || (scope.includeDescendants && loc.path.startsWith(root.path.slice(0, -3) + "/")))) return;
  }
  throw new MemoryError("denied", "记忆内容已移出当前授权范围");
}
export async function readBlock(client: SiyuanClient, id: string): Promise<string> {
  const result = await client.api("/api/block/getBlockKramdown", { id: blockId.parse(id) }, z.object({ id: blockId, kramdown: z.string().max(100_000) }));
  if (result.id !== id) throw new MemoryError("incompatible", "Unexpected block identity");
  // IAL is metadata, not prompt content. Do not execute SQL embeds or follow references.
  return result.kramdown.replace(/^\{:[^\n]*\}\s*$/gm, "").trim().replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (original, hex: string | undefined, decimal: string | undefined) => { const code = hex ? Number.parseInt(hex, 16) : Number(decimal); return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : original; });
}
export async function children(client: SiyuanClient, id: string): Promise<string[]> {
  const list = await client.api("/api/block/getChildBlocks", { id: blockId.parse(id) }, z.array(z.object({ id: blockId })).max(500));
  return list.map((item) => item.id);
}
export function plainMemoryMarkdown(text: string): string {
  // One paragraph. Encode every user character as an entity, so no IAL, embed,
  // block reference or HTML can escape into a second structural block.
  return [...text].map((char) => "&#" + char.codePointAt(0) + ";").join("");
}
export function normalizeMemoryText(text: string): string { return text.replace(/\r\n?/g, "\n").trim().replace(/\s*\n\s*/g, " "); }
export function rejectSensitive(text: string): void {
  if (/\b(sk-[\w-]{12,}|ghp_[\w]{20,}|github_pat_[\w]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[\w-]{12,})\b|-----BEGIN .*PRIVATE KEY-----|(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]{4,}/i.test(text)) throw new MemoryError("denied", "记忆可能包含密钥或凭据，未保存");
}
