import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { entryInputSchema, intelligenceDefaults, parseEntry, planQueries, reciprocalRankFusion, renderEntry, serializeEntry } from "./memory-entry";
import { parseStoredMemory, MEMORY_DEFAULTS } from "./memory";
const input={formatVersion:2 as const,title:"测试约定",conclusion:"使用 pnpm test",applicability:"当前项目",detail:"测试退出码为 0 才说明执行成功",evidenceRefs:[randomUUID()]};
const sources=[{kind:"explicit_user_statement" as const,sourceId:"input:1",sourceHash:"a".repeat(64),observedAt:1}];
describe("memory intelligence pure contracts",()=>{
  it("round-trips a single readable JSON-escaped block",()=>{const text=serializeEntry(input,sources);expect(parseEntry(text)?.conclusion).toBe(input.conclusion);expect(renderEntry(text,"index")).toContain("当前项目");expect(renderEntry(text,"index")).not.toContain("sourceHash");expect(renderEntry(text,"full")).toContain("input:1");});
  it("does not parse user-edited or malformed content as old structured facts",()=>{expect(parseEntry("edited note")).toBeNull();expect(parseEntry("AstraDock memory v2 | {bad")).toBeNull();expect(renderEntry("User changed actual content", "full")).toBe("User changed actual content");});
  it("escapes delimiters without creating another record",()=>{const text=serializeEntry({...input,detail:'" } | AstraDock memory v2 | <script>\n{}'},sources);expect(parseEntry(text)?.detail).toContain("<script>");expect(parseEntry(text)?.sources).toHaveLength(1);});
  it("rejects missing evidence and unexpected model-controlled fields",()=>{expect(entryInputSchema.safeParse({...input,evidenceRefs:[]}).success).toBe(false);expect(entryInputSchema.safeParse({...input,workspace:"other"}).success).toBe(false);});
  it("caps the whole serialized entry, not each field separately",()=>{expect(()=>serializeEntry({...input,conclusion:"x".repeat(790),detail:"y".repeat(1190)},sources)).toThrow("2000");});
  it("preserves original negations and identifiers and deduplicates variants",()=>{const queries=planQueries("不要使用 npm，出现 ERR_TEST_42",["不要使用 npm，出现 ERR_TEST_42","ERR_TEST_42"]);expect(queries[0]).toContain("不要");expect(new Set(queries).size).toBe(queries.length);expect(queries.length).toBeLessThanOrEqual(3);});
  it("fuses ranks without duplicate votes within a stream",()=>{const hits=reciprocalRankFusion([["a","a","b"],["b","c"]]);expect(hits[0].id).toBe("b");expect(hits.find(h=>h.id==="a")?.ranks).toEqual([1]);});
  it("invalid enhancement config cannot reset the existing connection or authorization",()=>{const result=parseStoredMemory({...MEMORY_DEFAULTS,enabled:true,intelligence:{version:99}});expect(result.enabled).toBe(true);expect(result.intelligence).toEqual(intelligenceDefaults);});
});
