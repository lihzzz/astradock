import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { writeJsonAtomically } from "./atomic-file";
import type { HandoffPacket, PreparedHandoff, PrepareHandoffInput, HandoffState } from "@shared/types/session-handoff";
import type { WorkspaceBinding } from "@shared/types/workspace";
const inputSchema = z.object({operationId:z.string().uuid(),projectId:z.string().min(1).max(200),sourceSessionId:z.string().min(1).max(200),sourceCwd:z.string().min(1).max(4000),objective:z.string().max(4000),targetEngine:z.enum(["claude","codex","acp"]),targetModel:z.string().max(200),markdown:z.string().min(1).max(16*1024*1024),messageCount:z.number().int().min(1).max(100000),lastMessageId:z.string().max(200)}).strict();
const bindingSchema=z.object({projectId:z.string(),rootKind:z.enum(["project","worktree"]),rootPath:z.string(),repoCommonDir:z.string().nullable(),relativeCwd:z.string()});
const packetSchema=z.object({version:z.literal(1),operationId:z.string().uuid(),projectId:z.string(),sourceSessionId:z.string(),createdAt:z.number(),targetEngine:z.enum(["claude","codex","acp"]),targetModel:z.string(),objective:z.string(),acceptanceCriteria:z.array(z.string()),completed:z.array(z.string()),nextSteps:z.array(z.string()).default([]),sourceRevision:z.number().nullable().default(null),historyOrigin:z.literal("visible_renderer_snapshot").default("visible_renderer_snapshot"),verification:z.array(z.object({messageId:z.string(),toolName:z.string(),observedAt:z.number()})).default([]),remaining:z.array(z.string()),blockers:z.array(z.string()),workspace:bindingSchema,git:z.object({head:z.string().nullable(),branch:z.string().nullable(),dirty:z.boolean().nullable()}),messageCount:z.number(),lastMessageId:z.string(),historyHash:z.string(),state:z.enum(["exported","target_created","dispatch_confirmed","dispatch_unknown"]),targetConversationId:z.string().nullable()});
const manifestSchema=z.object({fingerprint:z.string(),packet:packetSchema});
export interface HandoffFacts { workspace: WorkspaceBinding; git: HandoffPacket["git"]; objective: string; acceptanceCriteria: string[]; completed: string[]; remaining: string[]; blockers: string[]; sourceRevision?: number; verification?: HandoffPacket["verification"] }
/** Only app-owned paths; no caller-controlled filesystem targets or automatic execution. */
export class HandoffStore {
  private tails=new Map<string,Promise<unknown>>();
  constructor(private readonly directory:string){}
  private async locked<T>(id:string,run:()=>Promise<T>):Promise<T>{const previous=this.tails.get(id)??Promise.resolve();const next=previous.catch(()=>undefined).then(run);this.tails.set(id,next);try{return await next;}finally{if(this.tails.get(id)===next)this.tails.delete(id);}}
  private paths(id:string){z.string().uuid().parse(id);return {manifest:path.join(this.directory,id+".json"),filePath:path.join(this.directory,id+".md"),packetPath:path.join(this.directory,id+"-packet.json")};}
  async prepare(value:unknown,facts:HandoffFacts):Promise<PreparedHandoff>{const input=inputSchema.parse(value);const fingerprint=createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return this.locked(input.operationId,async()=>{const p=this.paths(input.operationId);await fs.mkdir(this.directory,{recursive:true});
      let exists=true;try{await fs.stat(p.manifest);}catch(error){if(error instanceof Error&&"code" in error&&error.code==="ENOENT")exists=false;else throw error;}
      if(exists) {const saved=manifestSchema.parse(JSON.parse(await fs.readFile(p.manifest,"utf8")));if(saved.fingerprint!==fingerprint)throw new Error("交接 ID 已用于不同的来源或目标");if(createHash("sha256").update(await fs.readFile(p.filePath)).digest("hex")!==saved.packet.historyHash)throw new Error("交接历史已变化，不能继续使用");const archived=packetSchema.parse(JSON.parse(await fs.readFile(p.packetPath,"utf8")));if(JSON.stringify({...saved.packet,state:"exported",targetConversationId:null})!==JSON.stringify(archived))throw new Error("交接摘要已变化，不能继续使用");return {packet:saved.packet,filePath:p.filePath,packetPath:p.packetPath};}
      const packet:HandoffPacket={nextSteps:facts.remaining.length?["先核对以下事项的当前完成情况",...facts.remaining.slice(0,8)]:["重新检查当前工作区和用户目标"],sourceRevision:facts.sourceRevision??null,historyOrigin:"visible_renderer_snapshot",verification:facts.verification??[],version:1,operationId:input.operationId,projectId:input.projectId,sourceSessionId:input.sourceSessionId,createdAt:Date.now(),targetEngine:input.targetEngine,targetModel:input.targetModel,objective:input.objective||facts.objective||"未显式提供；先核对历史与用户目标",acceptanceCriteria:facts.acceptanceCriteria,completed:facts.completed,remaining:facts.remaining,blockers:facts.blockers,workspace:facts.workspace,git:facts.git,messageCount:input.messageCount,lastMessageId:input.lastMessageId,historyHash:createHash("sha256").update(input.markdown).digest("hex"),state:"exported",targetConversationId:null};
      // A leftover partial export may be reused only if byte-identical. Never overwrite history.
      for(const [file,body] of [[p.filePath,input.markdown],[p.packetPath,JSON.stringify(packet,null,2)]]){try{await fs.writeFile(file,body,{encoding:"utf8",flag:"wx",mode:0o600});}catch(error){if(!(error instanceof Error&&"code" in error&&error.code==="EEXIST"))throw error;if(file===p.filePath&&await fs.readFile(file,"utf8")!==body)throw new Error("不完整交接历史与请求不一致");if(file===p.packetPath)await writeJsonAtomically(file,packet);}}
      await writeJsonAtomically(p.manifest,{fingerprint,packet});return {packet,filePath:p.filePath,packetPath:p.packetPath};
    });
  }
  async advance(id:string,state:HandoffState,targetConversationId:string):Promise<void>{z.string().min(1).max(200).parse(targetConversationId);await this.locked(id,async()=>{const p=this.paths(id);const saved=manifestSchema.parse(JSON.parse(await fs.readFile(p.manifest,"utf8")));
    if(saved.packet.targetConversationId&&saved.packet.targetConversationId!==targetConversationId)throw new Error("该交接已有目标，不能重复创建");
    const allowed:Record<HandoffState,HandoffState[]>={exported:["target_created"],target_created:["dispatch_confirmed","dispatch_unknown"],dispatch_unknown:["dispatch_confirmed"],dispatch_confirmed:[]};
    if(saved.packet.state===state)return;if(!allowed[saved.packet.state].includes(state))throw new Error("无效的交接状态转换");
    saved.packet={...saved.packet,state,targetConversationId};await writeJsonAtomically(p.manifest,saved);
  });}
}
export function parseHandoffInput(value:unknown):PrepareHandoffInput{return inputSchema.parse(value);}
