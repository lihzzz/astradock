import { HandoffPreviewDialog } from "../../src/components/HandoffPreviewDialog";
import type { HandoffPacket } from "../../shared/types/session-handoff";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryPanel } from "../../src/components/memory/MemoryPanel";
import { I18nProvider } from "../../src/lib/i18n";
import type { MemoryApi, MemoryRecallState, MemoryWriteRecord } from "../../shared/types/memory";
function assert(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function waitFor(check:()=>boolean){const start=Date.now();while(!check()){if(Date.now()-start>4000)throw new Error("UI timed out: " + document.body.textContent?.slice(-2400));await new Promise(done=>setTimeout(done,10));}}
async function runChecks(){
  const container=document.createElement("main");document.body.append(container);const root=createRoot(container);
  let failWrite=true,feedbackCalls=0,reconcileCalls=0;const writes:unknown[][]=[];
  const record:MemoryWriteRecord={operationId:crypto.randomUUID(),projectId:"project",sessionId:"session",turnId:crypto.randomUUID(),target:"doc",scope:"project",workspace:"fixture",endpoint:"http://127.0.0.1:6806",anchor:"anchor",hash:"a".repeat(64),kind:"convention",state:"unknown",createdAt:1,updatedAt:1};
  const recall:MemoryRecallState={items:[{ref:crypto.randomUUID(),blockId:"20261025000000-aaaaaaa",text:"Fixture current knowledge",scope:"project",hash:"a".repeat(64),readAt:1,details:{level:"full",validity:"current",truncated:false,feedback:[]}}],usedAt:1,skipNext:false,status:"已读取最新正文"};
  const unsupported=async()=>({error:"not in this fixture"});
  const memory:MemoryApi={reviewSources:unsupported,openReference:async()=>({value:null}),correct:unsupported,onEvent:()=>()=>{},getStatus:async()=>({state:"ready",message:"Fixture connected",hasToken:false}),connect:unsupported,openBrain:async()=>({value:null}),probe:unsupported,setToken:unsupported,getProjectConfig:unsupported,setProjectConfig:unsupported,
    sessionRecall:async()=>({value:structuredClone(recall)}),skipNextRecall:async(_id,skip)=>{recall.skipNext=skip;return {value:null};},rememberSession:unsupported,
    remember:async(...args)=>{writes.push(args);return failWrite?{error:"Fixture write failed"}:{value:{...record,state:"verified"}};},writes:async()=>({value:[record]}),reconcile:async()=>{reconcileCalls++;record.state="verified";return {value:record};},
    trace:async()=>({value:[{id:crypto.randomUUID(),projectId:"project",sessionId:"session",turnId:record.turnId,at:1,stage:"body_read",reason:"ok",count:1,bytes:120}]}),
    feedback:async()=>{feedbackCalls++;recall.items[0].details={level:"full",validity:"review_requested",truncated:false,feedback:["outdated"]};return {value:{...record,state:"verified",recordKind:"feedback"}};}
  };
  Object.assign(window,{claude:{memory}});
  const button=(name:string)=>{const value=[...container.querySelectorAll("button")].find(b=>b.textContent===name);assert(value,"Missing "+name);return value;};
  const checks:string[]=[];
  try {
    flushSync(()=>root.render(<StrictMode><I18nProvider><MemoryPanel projectId="project" sessionId="session" headerControls={null}/></I18nProvider></StrictMode>));
    await waitFor(()=>container.textContent?.includes("Fixture current knowledge")===true);checks.push("fresh recall and trace load through real React effects");
    assert(document.documentElement.scrollWidth <= window.innerWidth + 1,"Memory panel horizontal overflow");
    assert(container.textContent?.includes("本轮记忆过程"),"Missing trace");assert(container.textContent?.includes("模型采用"),"Missing honest delivery distinction");
    const area=container.querySelector("textarea");assert(area,"Missing textarea");const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")?.set;assert(setter,"No native input setter");
    flushSync(()=>{setter.call(area,"New preference");area.dispatchEvent(new Event("input",{bubbles:true}));});flushSync(()=>button("保存到思源").click());
    await waitFor(()=>container.textContent?.includes("Fixture write failed")===true);assert(area.value==="New preference","Failed save lost text");checks.push("failed save preserves draft and surfaces error");
    failWrite=false;flushSync(()=>button("保存到思源").click());await waitFor(()=>area.value==="");assert(writes[0].join()==="project,New preference,project","Scope changed");checks.push("successful save clears draft with explicit project scope");
    flushSync(()=>button("核对结果（不重写）").click());await waitFor(()=>reconcileCalls===1&&!container.textContent?.includes("核对结果（不重写）"));checks.push("unknown write reconciles without resubmitting");
    await waitFor(()=>!button("需要复核").disabled);
    flushSync(()=>button("需要复核").click());await waitFor(()=>container.textContent?.includes("review_requested")===true);assert(feedbackCalls===1,"Duplicate feedback");assert(container.textContent?.includes("Fixture current knowledge"),"Feedback overwrote original");checks.push("version-bound feedback does not replace the displayed source");
    flushSync(()=>root.render(<StrictMode><I18nProvider><MemoryPanel projectId={null} sessionId={null} headerControls={null}/></I18nProvider></StrictMode>));await waitFor(()=>!container.textContent?.includes("Fixture current knowledge"));checks.push("switching away removes prior conversation data");
    let decision:boolean|null=null;
    const packet:HandoffPacket={version:1,operationId:crypto.randomUUID(),projectId:"p",sourceSessionId:"s",createdAt:Date.now(),targetEngine:"codex",targetModel:"fixture",objective:"<img src=x onerror=alert(1)> visible objective",acceptanceCriteria:[],completed:[],remaining:["未确认"],blockers:[],nextSteps:["重新检查工作区"],sourceRevision:1,historyOrigin:"visible_renderer_snapshot",verification:[],workspace:{projectId:"p",rootKind:"project",rootPath:"C:/fixture-workspace",repoCommonDir:null,relativeCwd:""},git:{head:null,branch:null,dirty:null},messageCount:3,lastMessageId:"m3",historyHash:"a".repeat(64),state:"exported",targetConversationId:null};
    const preview={prepared:{packet,filePath:"C:/fixture-history.md",packetPath:"C:/fixture-packet.json"},permissionMode:"default",planMode:true};
    flushSync(()=>root.render(<I18nProvider><HandoffPreviewDialog preview={preview} onDecision={value=>{decision=value;}}/></I18nProvider>));
    await waitFor(()=>document.body.textContent?.includes("检查交接快照")===true);
    assert(document.documentElement.scrollWidth <= window.innerWidth + 1,"Handoff modal horizontal overflow");
    assert(document.querySelector('img[src="x"]')===null,"Untrusted objective executed markup");
    const confirm=[...document.querySelectorAll("button")].find(b=>b.textContent==="确认交接");assert(confirm,"No explicit handoff confirmation");flushSync(()=>confirm.click());assert(decision===true,"Handoff confirmation not delivered");
    checks.push("structured handoff preview shows unknown state and safely renders untrusted data");
    return checks;
  }finally{flushSync(()=>root.unmount());container.remove();}
}
Object.assign(window,{runMemoryPanelChecks:runChecks});
