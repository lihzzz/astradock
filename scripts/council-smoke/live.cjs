const {app}=require("electron");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
let directory;
(async()=>{
 if(process.env.ASTRADOCK_COUNCIL_LIVE!=="1")throw Error("Set ASTRADOCK_COUNCIL_LIVE=1 to permit one synthetic paid provider call using the existing Claude login.");
 directory=await fs.mkdtemp(path.join(os.tmpdir(),"astradock-council-live-"));app.setPath("userData",path.join(directory,"profile"));await app.whenReady();
 const {CouncilAgentRuntime}=require("../../.cache/council-smoke/live-backend.js");
 const result=await new CouncilAgentRuntime().execute({member:{id:"smoke",name:"Smoke",engine:"claude",agentId:"claude-code",model:process.env.COUNCIL_SMOKE_MODEL||"haiku",role:"Synthetic smoke test"},prompt:"This is a synthetic connectivity test containing no user data. Do not access tools, files, network, or memory. Reply exactly COUNCIL_SMOKE_OK.",signal:AbortSignal.timeout(60000),onText:()=>{}});
 if(result.text.trim()!=="COUNCIL_SMOKE_OK")throw Error("Provider did not return the expected marker; response not logged");
 console.log(JSON.stringify({status:"passed",provider:"claude",model:process.env.COUNCIL_SMOKE_MODEL||"haiku",tokens:result.tokens,cost:result.cost,scope:"One synthetic real-provider material-only call; not a cross-engine acceptance test"}));
})().catch(e=>{console.error("Council live smoke:",e.message);process.exitCode=1;}).finally(async()=>{if(directory && path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith("astradock-council-live-"))await fs.rm(directory,{recursive:true,force:true});app.exit(process.exitCode||0);});
