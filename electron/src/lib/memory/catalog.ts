import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDataDir } from "../data-dir";
import { reportError } from "../error-utils";
const itemSchema=z.object({identity:z.string(),projectId:z.string(),scope:z.enum(["project","personal"]),blockId:z.string().regex(/^\d{14}-[a-z0-9]{7}$/),kind:z.enum(["preference","convention","decision","troubleshooting","procedure","correction"]),at:z.number()}).strict();
export type CatalogItem=z.infer<typeof itemSchema>;
/** Disposable ID-only locator. Every returned block must still be authorized and reread. */
export function catalogItems(identity:string,projectId:string):CatalogItem[]{
  try{const file=path.join(getDataDir(),"siyuan-memory-catalog.json");if(fs.statSync(file).size>3*1024*1024)return [];const parsed=z.array(itemSchema).max(10000).safeParse(JSON.parse(fs.readFileSync(file,"utf8")));return parsed.success?parsed.data.filter(i=>i.identity===identity&&(i.projectId===projectId||i.scope==="personal")).sort((a,b)=>b.at-a.at):[];}catch{return [];}
}
export function catalogRemember(item:CatalogItem):void {
  const file=path.join(getDataDir(),"siyuan-memory-catalog.json"),temp=file+"."+randomUUID();
  try{let old:CatalogItem[]=[];if(fs.existsSync(file)&&fs.statSync(file).size<=3*1024*1024){const parsed=z.array(itemSchema).max(10000).safeParse(JSON.parse(fs.readFileSync(file,"utf8")));if(parsed.success)old=parsed.data;}
    const valid=itemSchema.parse(item);const next=old.filter(i=>!(i.identity===valid.identity&&i.blockId===valid.blockId));next.push(valid);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(temp,JSON.stringify(next.slice(-10000)),{encoding:"utf8",flag:"wx",mode:0o600});fs.renameSync(temp,file);
  }catch(error){reportError("MEMORY_CATALOG",error);}finally{try{fs.rmSync(temp,{force:true});}catch{/* Derived data only. */}}
}
