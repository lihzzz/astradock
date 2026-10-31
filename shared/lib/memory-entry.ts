import { z } from "zod";
import type { MemoryEntry, MemoryEntryInput, MemoryLevel } from "../types/memory-intelligence";
export const intelligenceDefaults = { version: 1 as const, enabled: false, briefing: false, persistTrace: false };
export const intelligenceSchema = z.object({ version: z.literal(1), enabled: z.boolean(), briefing: z.boolean(), persistTrace: z.boolean() }).strict();
export const entryInputSchema = z.object({ formatVersion: z.literal(2), title: z.string().trim().min(1).max(120), conclusion: z.string().trim().min(3).max(800), applicability: z.string().trim().min(1).max(300), detail: z.string().trim().max(1200), evidenceRefs: z.array(z.string().uuid()).min(1).max(8), relation: z.object({type:z.enum(["supplement","contradiction"]),ref:z.string().uuid()}).strict().optional() }).strict();
export const sourceSchema = z.object({ kind: z.enum(["explicit_user_statement", "observed_tool_result", "recorded_user_statement", "recorded_tool_result"]), sourceId: z.string().max(200), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.number().finite() }).strict();
const entrySchema = entryInputSchema.omit({ evidenceRefs: true, relation: true }).extend({ sources: z.array(sourceSchema).min(1).max(8), relation:z.object({type:z.enum(["supplement","contradiction"]),blockId:z.string().regex(/^\d{14}-[a-z0-9]{7}$/)}).strict().optional() });
export const feedbackSignalSchema = z.enum(["helpful", "not_helpful", "outdated", "condition_mismatch"]);
// Readable, single-block format: each field is JSON escaped, preventing delimiter injection.
const PREFIX = "AstraDock memory v2 | ";
export function serializeEntry(input: MemoryEntryInput, sources: MemoryEntry["sources"], relation?: MemoryEntry["relation"]): string {
  const entry = entrySchema.parse({ formatVersion: 2, title: input.title, conclusion: input.conclusion, applicability: input.applicability, detail: input.detail, sources, ...(relation ? {relation} : {}) });
  const result = PREFIX + JSON.stringify(entry);
  if ([...result].length > 2000) throw new Error("结构化记忆（含来源）超过 2000 字符，请缩短内容");
  return result;
}
export function parseEntry(body: string): MemoryEntry | null {
  if (!body.startsWith(PREFIX)) return null;
  try { const parsed = entrySchema.safeParse(JSON.parse(body.slice(PREFIX.length))); return parsed.success ? parsed.data : null; } catch { return null; }
}
export function renderEntry(body: string, level: MemoryLevel): string {
  const e = parseEntry(body);
  if (!e) return level === "full" ? body : body.split(/(?<=[。.!?])\s*/u)[0];
  const index = `${e.title}：${e.conclusion}\n适用条件：${e.applicability}`;
  return level === "index" ? index : `${index}${e.detail ? "\n说明：" + e.detail : ""}${level === "full" ? "\n来源：" + e.sources.map(s => `${s.kind} / ${s.sourceId} / ${s.sourceHash.slice(0, 12)}`).join("；") : ""}`;
}
export function planQueries(query: string, variants: string[] = []): string[] {
  const result: string[] = [];
  const add = (s: string) => { const v = s.trim(); if (v.length >= 2 && v.length <= 300 && !result.some(x => x.toLocaleLowerCase() === v.toLocaleLowerCase()) && result.length < 3) result.push(v); };
  add(query); variants.forEach(add);
  const identifiers = query.match(/(?:[A-Za-z][\w./:-]*\d[\w./:-]*|[A-Z][A-Z_]{2,}|[\w-]+\.[a-z]{1,5})/g);
  if (identifiers?.length) add(identifiers.slice(0, 4).join(" "));
  const synonyms: Array<[RegExp, string]> = [[/包管理器|package manager/i, "pnpm npm"], [/打包|发布|release/i, "发布 构建"], [/测试|test/i, "测试 验证"], [/鉴权|认证|auth/i, "认证 Token"]];
  for (const [pattern, term] of synonyms) if (pattern.test(query)) add(term);
  return result;
}
export function reciprocalRankFusion(streams: string[][]): Array<{ id: string; score: number; ranks: number[] }> {
  const hits = new Map<string, { id: string; score: number; ranks: number[] }>();
  for (const stream of streams) [...new Set(stream)].forEach((id, i) => { const hit = hits.get(id) ?? { id, score: 0, ranks: [] }; hit.score += 1 / (60 + i + 1); hit.ranks.push(i + 1); hits.set(id, hit); });
  return [...hits.values()].sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
}
