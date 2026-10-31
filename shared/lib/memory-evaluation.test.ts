import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planQueries, reciprocalRankFusion } from "./memory-entry";
const fixture=z.object({cases:z.array(z.object({id:z.string(),scope:z.literal("project"),text:z.string(),queries:z.array(z.string()).length(3)})).length(40),negative:z.array(z.object({id:z.string(),query:z.string()})).length(15)}).parse(JSON.parse(fs.readFileSync(path.resolve("scripts/fixtures/memory-intelligence/cases.json"),"utf8")));
describe("frozen synthetic query contracts (not semantic/LLM acceptance)",()=>{
  it.each(fixture.cases)("$id keeps original wording and a bounded deterministic plan",c=>{for(const query of c.queries){const plan=planQueries(query);expect(plan[0]).toBe(query);expect(plan.length).toBeLessThanOrEqual(3);expect(new Set(plan).size).toBe(plan.length);expect(plan.every(q=>q.length<=300)).toBe(true);}});
  it("does not generate candidates when every scoped backend stream is empty",()=>{for(const ignored of fixture.negative){expect(ignored.id).toMatch(/^N/);expect(reciprocalRankFusion([[],[],[]])).toEqual([]);}});
  it("uses stable non-overlapping IDs for leave-out evaluation",()=>{expect(new Set([...fixture.cases,...fixture.negative].map(c=>c.id)).size).toBe(55);});
});
