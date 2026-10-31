const {app,BrowserWindow,ipcMain}=require("electron");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const {CouncilService,CouncilRepository,taskBrief}=require("../../.cache/council-smoke/backend.js");
let directory,window,service;let modelCalls=0,taskCalls=0;const errors=[];
const root=path.resolve(__dirname,"../..");
async function until(expression){for(let i=0;i<150;i++){if(await window.webContents.executeJavaScript(expression))return;await new Promise(r=>setTimeout(r,70));}throw Error("Timed out: "+expression);}
async function click(text){await window.webContents.executeJavaScript("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==="+JSON.stringify(text)+").click()");}
async function fill(selector,value){await window.webContents.executeJavaScript("(()=>{const e=document.querySelector("+JSON.stringify(selector)+");const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,"+JSON.stringify(value)+");e.dispatchEvent(new Event('input',{bubbles:true}));})()");await new Promise(r=>setTimeout(r,50));}
(async()=>{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),"astradock-council-ui-"));app.setPath("userData",path.join(directory,"profile"));await app.whenReady();
 const workspace={projectId:"fixture",rootKind:"project",rootPath:directory,repoCommonDir:null,relativeCwd:""};
 service=new CouncilService({store:new CouncilRepository(path.join(directory,"store")),validateWorkspace:async w=>w,projectBlocked:()=>false,lease:async()=>({assertActive(){},release(){}}),report:e=>errors.push(String(e)),runtime:{validate:async()=>{},execute:async input=>{
  modelCalls++;await new Promise(r=>setTimeout(r,80));input.signal.throwIfAborted();
  const value=input.member.id==='moderator'?{summary:"两位成员已完成独立评审。",recommendation:"采用可恢复的状态机，先测试再执行。",agreements:["保留异议"],disagreements:[],movements:[{memberId:"architect",stance:"converged",note:"已核对"},{memberId:"reviewer",stance:"converged",note:"已核对"}],converged:true,acceptanceCriteria:["运行状态机测试"]}:{statement:"基于共享材料独立分析。",agreesWithPriorAssessment:true,dissent:[]};
  const text=JSON.stringify(value);input.onText(text.slice(0,24));await new Promise(r=>setTimeout(r,40));return {text,tokens:12,cost:null};
 }}});
 ipcMain.handle("fixture:council",async(_e,method,value)=>{try{
  if(method==='capabilities')return {ok:true,value:[{engine:"claude",supported:true,reason:"Synthetic runtime"},{engine:"codex",supported:false,reason:"Not attested"},{engine:"acp",supported:false,reason:"Not attested"}]};
  if(method==='workspaces')return {ok:true,value:[workspace]};
  if(method==='task'){taskCalls++;const brief=taskBrief(value);assert(brief.objective.includes("Council source:"));return {ok:true,value:{version:1,revision:1,tasks:[],runs:[],deliverables:[]}};}
  return {ok:true,value:await service[method](value)};
 }catch(e){return {ok:false,error:{code:"TEST_ERROR",message:e.message,retryable:false}};}});
 window=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{preload:path.join(__dirname,"preload.cjs"),contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
 window.webContents.on("console-message",(_event,level,message)=>{if(level>=3)errors.push(message);});
 service.onChanged(s=>{if(!window.isDestroyed())window.webContents.send("councils:changed",s);});service.onDelta(e=>{if(!window.isDestroyed())window.webContents.send("councils:delta",e);});
 await window.loadURL(process.env.COUNCIL_SMOKE_URL);await until("document.querySelector('[data-council-view]') && [...document.querySelectorAll('button')].some(b=>b.textContent==='新建讨论组'&&!b.disabled)");
 await click("新建讨论组");await until("document.querySelector('input[maxlength=\"160\"]')");
 await fill('input[maxlength="160"]','架构圆桌自测');await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='创建讨论组'&&!b.disabled)");await click("创建讨论组");
 await until("document.body.textContent.includes('发起新议题')");
 await fill('textarea[maxlength="12000"]','如何确保多模型讨论可恢复？');await click("导入当前会话可见消息，先预览");
 assert.equal(modelCalls,0);await click("开始讨论（消耗模型额度）");await until("document.querySelector('[data-council-conclusion]')");
 const state=await service.list();assert.equal(state.runs[0].status,'completed');assert.equal(state.runs[0].round,2);assert.equal(modelCalls,6);assert.equal(taskCalls,0);
 const output=path.join(root,".cache/council-smoke");await fs.mkdir(output,{recursive:true});await new Promise(r=>setTimeout(r,500));await fs.writeFile(path.join(output,"council-ui.png"),(await window.webContents.capturePage()).toPNG());
 await window.webContents.reload();await until("document.querySelector('[data-council-view]') && document.querySelector('select option[value=\""+state.councils[0].id+"\"]')");
 await window.webContents.executeJavaScript("(()=>{const el=document.querySelector('select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,"+JSON.stringify(state.councils[0].id)+");el.dispatchEvent(new Event('change',{bubbles:true}));})()");
 await until("document.querySelector('[data-council-conclusion]')");assert.equal(modelCalls,6);
 await click("预览并转为任务");await until("document.body.textContent.includes('预览执行任务')");assert.equal(taskCalls,0);await click("确认创建任务");await until("document.title==='task-created'");assert.equal(taskCalls,1);assert.equal(modelCalls,6);
 assert.equal(errors.length,0,errors.join("\n"));
 const report={status:"passed",modelCalls,taskCalls,rendererReload:"no replay",rounds:2,scope:"Hidden Electron UI + production Council service/repository with synthetic model responses. No provider calls or user data."};
 await fs.writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 await service?.shutdown();window?.destroy();
 if(directory && path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith("astradock-council-ui-"))await fs.rm(directory,{recursive:true,force:true});app.exit(process.exitCode||0);
});
