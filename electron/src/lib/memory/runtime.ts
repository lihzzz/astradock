import { createHash, randomUUID } from "node:crypto";
import type { MemoryEvidence, MemoryTraceEvent, MemoryTraceStage, MemoryTraceReason } from "@shared/types/memory-intelligence";
import { getAppSettings } from "../app-settings";
import { saveTrace } from "./trace";
import { clipMemoryText } from "./text-budget";
import { rejectSensitive } from "./siyuan/blocks";
interface Run { projectId: string; turnId: string; controller: AbortController; evidence: MemoryEvidence[]; events: MemoryTraceEvent[]; remaining: number; tools: Map<string,string>; nativeTurn: string | null }
const runs = new Map<string,Run>();
export const contentHash = (text: string): string => createHash("sha256").update(text).digest("hex");
function persist(id: string): void { const r=runs.get(id); if(r && getAppSettings().memory.intelligence?.persistTrace) saveTrace(r.events); }
export function registerMemoryRuntime(id: string, projectId: string): void {
  endMemoryRuntime(id); runs.set(id,{projectId,turnId:randomUUID(),controller:new AbortController(),evidence:[],events:[],remaining:2000,tools:new Map(),nativeTurn:null});
}
export function endMemoryRuntime(id: string): void { const r=runs.get(id); if(r) {r.controller.abort();persist(id);runs.delete(id);} }
export function beginMemoryRuntime(id: string, turnId: string, text: string): void {
  const old=runs.get(id); if(!old)return; old.controller.abort(); persist(id);
  const r:Run={projectId:old.projectId,turnId,controller:new AbortController(),evidence:[],events:[],remaining:2000,tools:new Map(),nativeTurn:null};runs.set(id,r);
  if(getAppSettings().memory.enabled && getAppSettings().memory.intelligence?.enabled && !/^(任务交接：|上一轮会话的完整上下文|<astradock-memory-policy>)/.test(text)) addEvidence(id,"explicit_user_statement",`input:${turnId}`,text);
}
export function cancelMemoryRuntime(id: string): void { const r=runs.get(id); if(r){r.controller.abort();r.evidence=[];r.tools.clear();} }
export function memorySignal(id: string): AbortSignal { return runs.get(id)?.controller.signal ?? AbortSignal.abort(); }
export function remainingMemoryBytes(id: string): number { return runs.get(id)?.remaining ?? 0; }
export function consumeMemoryBytes(id:string,n:number):void { const r=runs.get(id);if(r)r.remaining=Math.max(0,r.remaining-n); }
export function traceMemory(id:string,stage:MemoryTraceStage,reason:MemoryTraceReason="ok",count=0,bytes=0):void {
  const r=runs.get(id); if(!r || !getAppSettings().memory.enabled || !getAppSettings().memory.intelligence?.enabled)return;
  if(r.events.length>=256)r.events.splice(0,1);
  r.events.push({id:randomUUID(),projectId:r.projectId,sessionId:id,turnId:r.turnId,at:Date.now(),stage,reason,count,bytes});
}
export function memoryTrace(id:string):MemoryTraceEvent[]{return structuredClone(runs.get(id)?.events ?? []);}
export function evidenceList(id:string):MemoryEvidence[]{return structuredClone(runs.get(id)?.evidence ?? []);}
function addEvidence(id:string,kind:MemoryEvidence["kind"],sourceId:string,text:string):void {
  const key=id+"/"+sourceId; const r=runs.get(id);if(!r||r.controller.signal.aborted||!text.trim()||Buffer.byteLength(text)>65536||key.length>200||r.evidence.length>=32||r.evidence.some(e=>e.sourceId===key))return;
  // Reject, rather than leak a sensitive fragment into a tool result or durable source.
  try{rejectSensitive(text);}catch{return;}
  r.evidence.push({ref:randomUUID(),kind,sourceId:key,sourceHash:contentHash(text),observedAt:Date.now(),excerpt:clipMemoryText(text,600)});
}
function object(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
function visibleText(value:unknown):string {
  if(typeof value==="string")return value;
  if(Array.isArray(value))return value.filter(object).filter(b=>b.type==="text"&&typeof b.text==="string").map(b=>b.text).join("\n");
  return "";
}
/** Only host-observed completed visible tool events. Model tool arguments never enter here. */
export function observeMemoryEvent(id:string,engine:"claude"|"codex"|"acp",event:unknown):void {
  const r=runs.get(id);if(!r||r.controller.signal.aborted||!getAppSettings().memory.enabled||!getAppSettings().memory.intelligence?.enabled||!object(event))return;
  if(engine==="claude" && object(event.message) && Array.isArray(event.message.content)) {
    if(event.parent_tool_use_id)return;
    for(const b of event.message.content){if(!object(b))continue;
      if(b.type==="tool_use"&&typeof b.id==="string"&&typeof b.name==="string"&&r.tools.size<128)r.tools.set(b.id,b.name);
      if(b.type==="tool_result"&&typeof b.tool_use_id==="string"&&r.tools.has(b.tool_use_id)) {const name=r.tools.get(b.tool_use_id)!;r.tools.delete(b.tool_use_id);if(b.is_error!==true&&!/memory/i.test(name))addEvidence(id,"observed_tool_result",`claude:${b.tool_use_id}`,visibleText(b.content));}
    }
  }
  if(engine==="codex"&&object(event.params)&&object(event.params.item)) {
    const p=event.params,item=p.item;if(!object(item)||typeof item.id!=="string")return;
    if(r.nativeTurn && typeof p.turnId==="string" && p.turnId!==r.nativeTurn)return;
    if(event.method==="item/started"&&item.type==="commandExecution"&&r.tools.size<128)r.tools.set(item.id,"command");
    if(event.method==="item/completed"&&r.tools.has(item.id)){r.tools.delete(item.id);if(item.type==="commandExecution"&&item.status==="completed"&&item.exitCode===0&&typeof item.aggregatedOutput==="string")addEvidence(id,"observed_tool_result",`codex:${item.id}`,item.aggregatedOutput);}
  }
  if(engine==="acp"&&typeof event.toolCallId==="string") {
    if(event.sessionUpdate==="tool_call"&&typeof event.title==="string"&&r.tools.size<128)r.tools.set(event.toolCallId,event.title);
    if(event.status==="completed"&&r.tools.has(event.toolCallId)){const name=r.tools.get(event.toolCallId)!;r.tools.delete(event.toolCallId);if(!/memory/i.test(name)&&Array.isArray(event.content)){const text=event.content.filter(object).filter(b=>b.type==="content"&&object(b.content)&&b.content.type==="text").map(b=>object(b.content)?visibleText(b.content.text):"").join("\n");addEvidence(id,"observed_tool_result",`acp:${event.toolCallId}`,text);}}
  }
}
export function recordMemoryDispatch(id:string,turnId:string,receipt:"queued"|"accepted"|"finished",nativeTurn?:string):void {
  const r=runs.get(id);if(!r||r.turnId!==turnId||r.controller.signal.aborted)return;if(nativeTurn)r.nativeTurn=nativeTurn;
  traceMemory(id,receipt==="queued"?"dispatch_attempted":"dispatch_confirmed",receipt==="queued"?"delivery_unconfirmed":"ok");
}

/** Only the trusted renderer can authorize the source list; MCP has no scope-expansion tool. */
export function recordHistoricalEvidence(id:string,sourceSessionId:string,messageId:string,kind:"recorded_user_statement"|"recorded_tool_result",text:string):void { addEvidence(id,kind,`review:${sourceSessionId}:${messageId}`,text); }
