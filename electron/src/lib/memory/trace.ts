import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDataDir } from "../data-dir";
import { reportError } from "../error-utils";
import type { MemoryTraceEvent } from "@shared/types/memory-intelligence";
const schema = z.object({ id: z.string().uuid(), projectId: z.string().max(200), sessionId: z.string().max(200), turnId: z.string().uuid(), at: z.number(), stage: z.enum(["query_planned","search_finished","candidate_checked","body_read","context_selected","dispatch_attempted","dispatch_confirmed","extraction_checked","write_submitted","write_verified","write_unknown","write_changed","write_conflict","excluded"]), reason: z.enum(["ok","scope_denied","source_missing","body_changed","duplicate","not_applicable","superseded","conflict","relations_incomplete","budget_exhausted","cancelled","unavailable","delivery_unconfirmed","legacy","feedback"]), count: z.number().nonnegative(), bytes: z.number().nonnegative() }).strict();
export function saveTrace(events: MemoryTraceEvent[]): void {
  if (!events.length) return;
  const file = path.join(getDataDir(), "siyuan-trace.json");
  const temp = file + "." + randomUUID();
  try {
    let old: MemoryTraceEvent[] = [];
    if (fs.existsSync(file) && fs.statSync(file).size <= 5 * 1024 * 1024) { const p = z.array(schema).max(10000).safeParse(JSON.parse(fs.readFileSync(file,"utf8"))); if(p.success) old=p.data; }
    const unique = new Map([...old,...events].filter(e=>e.at > Date.now()-7*86400000).map(e=>[e.id,schema.parse(e)]));
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(temp,JSON.stringify([...unique.values()].slice(-10000)),{encoding:"utf8",flag:"wx",mode:0o600}); fs.renameSync(temp,file);
  } catch(error) { reportError("MEMORY_TRACE_STORE", error); }
  finally { try { fs.rmSync(temp,{force:true}); } catch { /* Non-critical diagnostic cleanup. */ } }
}

/** Called after a successful conversation/project deletion, not by a mere history read. */
export function clearTrace(projectId: string, sessionIds?: string[]): void {
  const file=path.join(getDataDir(),"siyuan-trace.json"),temp=file+"."+randomUUID();
  try {
    if(!fs.existsSync(file))return;
    if(fs.statSync(file).size>5*1024*1024)throw new Error("Trace metadata exceeds limit");
    const data=z.array(schema).max(10000).parse(JSON.parse(fs.readFileSync(file,"utf8")));
    const ids=sessionIds?new Set(sessionIds):null;
    fs.writeFileSync(temp,JSON.stringify(data.filter(e=>e.projectId!==projectId || (ids && !ids.has(e.sessionId)))),{encoding:"utf8",flag:"wx",mode:0o600});fs.renameSync(temp,file);
  }catch(error){reportError("MEMORY_TRACE_CLEAR",error);}finally{try{fs.rmSync(temp,{force:true});}catch{/* Metadata cleanup only. */}}
}
