import { ipcMain, type BrowserWindow } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { isRecord } from "../lib/productivity-errors";
import { z } from "zod";
import { getDataDir } from "../lib/data-dir";
import { assertMainRenderer } from "../lib/productivity-ipc";
import { reportError } from "../lib/error-utils";
import { HandoffStore, parseHandoffInput } from "../lib/session-handoff";
import { readProjects } from "./projects";
import { containsPath, listWorkspaces, pathIdentity, resolveWorkspace, runGit } from "../lib/project-apps/workspace";
import { getSessionRepository } from "../lib/session-service";
import { getTaskService } from "../lib/tasks";
export function register(getMainWindow:()=>BrowserWindow|null):void {
  const store=new HandoffStore(path.join(getDataDir(),"session-transfers"));
  ipcMain.handle("sessions:prepare-handoff",async(event,value:unknown)=>{try{
    assertMainRenderer(event,getMainWindow);const input=parseHandoffInput(value);const project=readProjects().find(p=>p.id===input.projectId);if(!project)throw new Error("来源项目不存在");
    const source=await getSessionRepository().load(project.id,input.sourceSessionId);if(!source)throw new Error("来源会话尚未保存，请稍后再交接");
    const bindings=await listWorkspaces(project);const match=bindings.filter(b=>containsPath(b.rootPath,input.sourceCwd)).sort((a,b)=>b.rootPath.length-a.rootPath.length)[0];if(!match)throw new Error("来源目录不属于项目的有效工作区");
    const resolved=await resolveWorkspace(project,source.workspaceBinding??{...match,relativeCwd:path.relative(match.rootPath,input.sourceCwd)});
    if(pathIdentity(resolved.cwd)!==pathIdentity(await fs.realpath(input.sourceCwd)))throw new Error("来源工作区与会话绑定不同，未启动交接");
    const [head,branch,status]=await Promise.all([runGit(["rev-parse","HEAD"],resolved.cwd).catch(()=>null),runGit(["branch","--show-current"],resolved.cwd).catch(()=>null),runGit(["status","--porcelain"],resolved.cwd).catch(()=>null)]);
    const tasks=await getTaskService().list();const run=tasks.runs.find(r=>r.conversationId===source.conversationId);const task=run?tasks.tasks.find(t=>t.id===run.taskId&&t.projectId===project.id):undefined;
    assertMainRenderer(event,getMainWindow);if(!readProjects().some(p=>p.id===project.id))throw new Error("来源项目已删除");
    if(!await getSessionRepository().load(project.id,input.sourceSessionId))throw new Error("来源会话已删除，交接取消");
    const verification=Array.isArray(source.messages)?source.messages.filter(isRecord).filter(m=>typeof m.id==="string"&&isRecord(m.toolState)&&m.toolState.status==="completed"&&m.toolState.exitCode===0).slice(-10).map(m=>({messageId:String(m.id),toolName:typeof m.toolName==="string"?m.toolName:"tool",observedAt:typeof m.timestamp==="number"?m.timestamp:0})):[];
    const result=await store.prepare(input,{sourceRevision:typeof source.persistenceRevision==="number"?source.persistenceRevision:undefined,verification,workspace:resolved.binding,git:{head:head?.trim()??null,branch:branch?.trim()??null,dirty:status===null?null:status.trim().length>0},objective:task?.objective??"",acceptanceCriteria:run?.brief.acceptanceCriteria??[],completed:run?.review==="accepted"?["该次任务运行已获用户验收"]:[],remaining:run?.review!=="accepted"?run?.brief.acceptanceCriteria??["未结构化记录；请检查完整历史"]:[],blockers:run?.error?[run.error]:[]});
    return {value:result};
  }catch(error){reportError("HANDOFF_PREPARE",error);return {error:error instanceof Error?error.message:"交接准备失败"};}});
  ipcMain.handle("sessions:handoff-state",async(event,value:unknown)=>{try{assertMainRenderer(event,getMainWindow);const input=z.object({operationId:z.string().uuid(),state:z.enum(["target_created","dispatch_confirmed","dispatch_unknown"]),targetConversationId:z.string().min(1).max(200)}).strict().parse(value);await store.advance(input.operationId,input.state,input.targetConversationId);return {ok:true};}catch(error){reportError("HANDOFF_STATE",error);return {error:"交接状态未确认；请打开已有目标，不要重复创建"};}});
}
