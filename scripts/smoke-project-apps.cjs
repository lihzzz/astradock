/** Real packaged-Electron smoke test. Uses only an isolated temporary profile
 * and fixture project. Does not contact a model or modify the user's data. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const executable = path.resolve(process.argv[2] || path.join(root, 'release/0.2.0/win-unpacked/Harnss.exe'));
const output = path.join(root, 'outputs/project-apps-smoke');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, test, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (test(value)) return value;
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(value).slice(0, 4000)}`);
}
async function freePort() {
  const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
async function portFree(port) {
  return new Promise(resolve => { const s = net.createServer(); s.once('error',()=>resolve(false)); s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true))); });
}
async function connect(url) {
  const socket = new WebSocket(url); const pending = new Map(); let id = 0;
  await new Promise((resolve,reject) => {socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage = event => { const data = JSON.parse(event.data); const item=pending.get(data.id); if(!item)return; pending.delete(data.id); clearTimeout(item.timer); data.error ? item.reject(new Error(JSON.stringify(data.error))) : item.resolve(data.result); };
  const send = (method,params={}) => new Promise((resolve,reject) => {
    const key=++id; const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timed out: ${method}`));},30000);
    pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params}));
  });
  const evaluate = async expression => {const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);return result.result.value;};
  return {send,evaluate,close:()=>socket.close()};
}
async function main() {
  await fs.mkdir(output,{recursive:true});
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'harnss-apps-packaged-'));
  const data=path.join(profile,'openacpui-data'); await fs.mkdir(data);
  await fs.writeFile(path.join(profile,'.harnss-migrated'),'isolated test profile');
  await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({analyticsEnabled:false,globalShortcuts:{enabled:false,keepAliveOnClose:false}}));
  const project=path.join(profile,'中文 project');await fs.mkdir(project);
  await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'apps-smoke',private:true,packageManager:'pnpm@10.26.0',scripts:{dev:'vite'},devDependencies:{vite:'7.3.1'}}));
  await fs.writeFile(path.join(project,'.npmrc'),'verify-deps-before-run=false\n');
  await fs.writeFile(path.join(project,'index.html'),'<style>body{background:#f5f5f5;color:#222;padding:32px;font:18px sans-serif}</style><title>Managed preview fixture</title><h1>Managed Vite application</h1><label>Preview state <input id="state"></label>');
  await fs.symlink(path.join(root,'node_modules'),path.join(project,'node_modules'),process.platform==='win32'?'junction':'dir');
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<style>body{background:#f5f5f5;color:#222;padding:32px;font:18px sans-serif}</style><title>Website preview fixture</title><h1>Website preview</h1><input id="state">');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const website=`http://127.0.0.1:${server.address().port}/`;
  const evidence={executable,profile,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,checks:[]};
  let child,cdp;let exit;
  const record=(name,details={})=>{evidence.checks.push({name,...details}); console.log('PASS '+name+' '+JSON.stringify(details));};
  const launch=async()=>{
    const port=await freePort();const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(executable,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    exit=new Promise((resolve,reject)=>{child.once('exit',code=>resolve(code));child.once('error',reject);});
    const logs=[];child.stdout.on('data',b=>logs.push(b));child.stderr.on('data',b=>logs.push(b));
    child.once('exit',()=>{void fs.writeFile(path.join(output,'packaged-runtime.log'),Buffer.concat(logs));});
    const targets=await until(async()=>{try{return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();}catch{return [];}},items=>items.some(t=>t.type==='page'&&t.url.startsWith('file:')),'packaged renderer target');
    cdp=await connect(targets.find(t=>t.type==='page'&&t.url.startsWith('file:')).webSocketDebuggerUrl);
    await until(()=>cdp.evaluate('Boolean(window.claude?.projectApps && document.querySelector("button"))'),Boolean,'renderer ready');
  };
  const visible='e => e.getClientRects().length > 0';
  const click=async pattern=>{
    const result=await cdp.evaluate(`(()=>{const e=[...(document.querySelector('[role=dialog]')||document).querySelectorAll('button')].filter(${visible}).find(e=>new RegExp(${JSON.stringify(pattern)}).test(e.textContent.trim())||new RegExp(${JSON.stringify(pattern)}).test(e.getAttribute('aria-label')||''));if(!e)return {buttons:[...(document.querySelector('[role=dialog]')||document).querySelectorAll('button')].filter(${visible}).map(e=>e.textContent.trim()||e.getAttribute('aria-label'))};if(e.disabled)throw Error('Button disabled: '+e.textContent);e.focus();e.click();return true})()`);
    assert.equal(result,true,JSON.stringify(result));await delay(120);
  };
  const field=async(pattern,value)=>{
    await cdp.evaluate(`(()=>{const label=[...(document.querySelector('[role=dialog]')||document).querySelectorAll('label')].filter(${visible}).find(e=>new RegExp(${JSON.stringify(pattern)}).test(e.textContent));const e=label?document.getElementById(label.htmlFor):[...document.querySelectorAll('input')].filter(${visible}).find(e=>new RegExp(${JSON.stringify(pattern)}).test(e.getAttribute('aria-label')||e.placeholder));if(!e)throw Error('Field not found: '+${JSON.stringify(pattern)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);await delay(80);
  };
  const snapshot=async()=>{const result=await cdp.evaluate('window.claude.projectApps.list()');if(!result.ok)throw Error(JSON.stringify(result.error));return result.value;};
  const capture=async name=>{const result=await cdp.send('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,name+'.png'),Buffer.from(result.data,'base64'));};
  const guest=code=>cdp.evaluate(`document.querySelector('webview')?.executeJavaScript(${JSON.stringify(code)})`);
  const quit=async()=>{
    await cdp.evaluate('setTimeout(()=>window.close(),50);true');
    assert.equal(await Promise.race([exit,delay(20000).then(()=>{throw Error('Normal application exit timed out');})]),0);
    cdp.close();cdp=null;child=null;
  };
  try {
    await launch();await cdp.evaluate('localStorage.setItem("harnss-welcome-completed","true")');await click('^(应用|Apps)$');
    await until(()=>cdp.evaluate('document.body?.innerText || ""'),t=>/项目应用|Project Apps/.test(t),'apps visible');
    assert.equal((await snapshot()).apps.length,0);record('zero-project zero-conversation entry');
    await field('搜索应用|Search apps',website);await click('保存为应用|Save as app');
    await field('^(名称|Name)$','Website fixture');await click('^(保存|Save)$');
    await until(snapshot,s=>s.apps.length===1,'website saved');await click('^(打开|Open)$');
    await until(()=>guest('document.title'),t=>t==='Website preview fixture','website preview');
    assert.equal(await guest('typeof window.claude'),'undefined');record('website preview without privileged preload');
    await guest('document.getElementById("state").value="retained preview"');await click('返回应用|Back to apps');await click('^(打开|Open)$');
    assert.equal(await guest('document.getElementById("state").value'),'retained preview');record('preview state retained across grid');await capture('website-preview');
    await fs.writeFile(path.join(data,'projects.json'),JSON.stringify([{id:'smoke-project',name:'中文 project',path:project,createdAt:Date.now()}]));
    await cdp.send('Page.reload');await until(()=>cdp.evaluate('document.body?.innerText || ""'),t=>t.includes('中文 project'),'fixture project loaded');
    await click('^(应用|Apps)$');await until(()=>cdp.evaluate('document.body?.innerText || ""'),t=>/添加应用|Add app/.test(t),'application editor entry');await click('^(添加应用|Add app)$');await field('^(名称|Name)$','Managed fixture');
    await until(()=>cdp.evaluate(`[...document.querySelectorAll('button')].find(e=>/检测启动命令|Detect start/.test(e.textContent))?.disabled === false`),Boolean,'workspace selected');
    await click('检测启动命令|Detect start');await until(()=>cdp.evaluate('document.body?.innerText || ""'),t=>t.includes('pnpm run dev'),'Vite discovery');
    await click('pnpm run dev');await click('^(保存|Save)$');
    const saved=await until(snapshot,s=>s.apps.some(a=>a.name==='Managed fixture'),'managed app saved');const managed=saved.apps.find(a=>a.name==='Managed fixture');
    await click('启动并打开|Start and open');
    let ready=await until(snapshot,s=>s.runs.some(r=>r.appId===managed.id&&r.health==='ready'),'managed readiness');
    let run=ready.runs.find(r=>r.appId===managed.id&&r.health==='ready');
    await until(()=>guest('document.title'),t=>t==='Managed preview fixture','managed preview');record('packaged pnpm Vite launch in Unicode path',{port:run.port,runId:run.runId});
    await guest('document.getElementById("state").value="logs keep preview"');await click('^(日志|Logs)$');
    await until(()=>cdp.evaluate('document.body?.innerText || ""'),t=>t.includes('VITE')||t.includes('vite'),'runtime logs');await click('^(预览|Preview)$');
    assert.equal(await guest('document.getElementById("state").value'),'logs keep preview');await capture('managed-preview');record('logs and preview switching');
    await click('在此目录打开终端|Open terminal here');
    await until(()=>cdp.evaluate('window.claude.terminal.list()'),r=>r.terminals?.some(t=>t.spaceId.startsWith('app-terminal:')),'repair terminal');
    await click('^(预览|Preview)$');
    await until(()=>cdp.evaluate('window.claude.terminal.list()'),r=>!r.terminals?.some(t=>t.spaceId.startsWith('app-terminal:')),'repair terminal cleanup');record('native repair terminal creates and cleans up');
    const previous=run.runId;await click('^(重启|Restart)$');ready=await until(snapshot,s=>s.runs.some(r=>r.appId===managed.id&&r.runId!==previous&&r.health==='ready'),'restart readiness');run=ready.runs.find(r=>r.appId===managed.id&&r.runId!==previous&&r.health==='ready');
    assert.equal(ready.runs.find(r=>r.runId===previous).phase,'stopped');record('restart replaces the exact run');
    await click('^(停止|Stop)$');await until(snapshot,s=>s.runs.find(r=>r.runId===run.runId)?.phase==='stopped','stop');assert(await portFree(run.port));record('stop releases owned port');
    await click('^(启动|Start)$');ready=await until(snapshot,s=>s.runs.some(r=>r.appId===managed.id&&r.health==='ready'),'restart for exit');run=ready.runs.find(r=>r.appId===managed.id&&r.health==='ready');
    await quit();assert(await portFree(run.port));record('normal packaged exit cleans running service');
    await launch();const restored=await snapshot();assert.equal(restored.apps.length,2);assert(restored.runs.every(r=>!['running','starting','stopping'].includes(r.phase)));record('restart persists config and ended history without auto-start');
    await click('^(应用|Apps)$');await until(()=>cdp.evaluate('document.querySelectorAll("article").length'),n=>n===2,'restored cards visible');await capture('apps-catalog');
    await click('^(导出配置|Export configuration)$');
    const exported = await cdp.evaluate('document.querySelector("[role=dialog] textarea").value');
    assert.equal(JSON.parse(exported).apps.length, 2);assert(!exported.includes(profile));
    await click('^(关闭|Close)$');
    record('export shows portable configuration');
    const manifest = JSON.stringify({schemaVersion:1,apps:Array.from({length:500},(_,i)=>({name:`catalog fixture ${i}`,kind:'web',url:website,icon:'🌐',iconType:'emoji',favorite:false,folder:'Smoke',order:i}))});
    await click('^(导入配置|Import configuration)$');await field('配置 JSON|Configuration JSON',manifest);await click('^(导入配置|Import configuration)$');
    await until(snapshot,s=>s.apps.length===502,'500 configurations imported');
    await until(()=>cdp.evaluate('document.querySelectorAll("article").length'),n=>n>2,'virtualized catalog populated');
    const mounted=await cdp.evaluate('document.querySelectorAll("article").length');assert(mounted<100);
    const samples=[];
    for(let i=490;i<500;i++) {
      const query=`catalog fixture ${i}`;
      samples.push(await cdp.evaluate(`(async()=>{const input=document.querySelector('input[aria-label]');const start=performance.now();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}));for(let frame=0;frame<100;frame++){await new Promise(requestAnimationFrame);const cards=[...document.querySelectorAll('article')];if(cards.length===1&&cards[0].textContent.includes(${JSON.stringify(query)}))return performance.now()-start;}throw Error('Search did not settle')})()`));
    }
    record('500-app catalog virtualization and search',{mountedCards:mounted,samplesMs:samples,maxMs:Math.max(...samples)});
    assert((await snapshot()).runs.every(r=>!['starting','running'].includes(r.phase)));record('bulk import does not start commands');
    await field('搜索应用|Search apps','');await fs.rename(project,project+'-moved');await click('^(刷新|Refresh)$');
    await until(snapshot,s=>!!s.workspaceErrors[managed.id],'missing directory status');
    await field('搜索应用|Search apps','Managed fixture');await until(()=>cdp.evaluate('document.body?.innerText||""'),t=>t.includes('工作区不可用')||t.includes('Workspace unavailable'),'unavailable card');
    await fs.rename(project+'-moved',project);await click('^(刷新|Refresh)$');await until(snapshot,s=>!s.workspaceErrors[managed.id],'restored directory status');record('directory disappearance and restoration');
    if (process.env.HARNSS_TEST_NEXT_PROJECT) {
      const nextPath=path.resolve(process.env.HARNSS_TEST_NEXT_PROJECT);
      const nextPackage=JSON.parse(await fs.readFile(path.join(nextPath,'package.json'),'utf8'));
      await fs.writeFile(path.join(data,'projects.json'),JSON.stringify([{id:'smoke-project',name:'中文 project',path:project,createdAt:Date.now()},{id:'next-project',name:'Next fixture',path:nextPath,createdAt:Date.now()}]));
      const registered=await cdp.evaluate(`(async()=>{const api=window.claude.projectApps;const bindings=await api.workspaces('next-project');if(!bindings.ok)throw Error(bindings.error.message);const workspace=bindings.value[0];const found=await api.discover(workspace);if(!found.ok)throw Error(found.error.message);const candidate=found.value.candidates.find(c=>c.launch.adapter==='next');if(!candidate)throw Error('Next adapter not discovered');return api.save({id:null,expectedRevision:null,definition:{name:'Next fixture',kind:'managed',projectId:'next-project',workspace,launch:{...candidate.launch,env:{NEXT_TELEMETRY_DISABLED:'1'}},icon:'🚀',iconType:'emoji',favorite:false,folder:'',order:0}})})()`);
      assert(registered.ok,JSON.stringify(registered));
      await cdp.send('Page.reload');await until(()=>cdp.evaluate('document.body?.innerText||""'),t=>t.includes('Next fixture'),'Next project loaded');await click('^(应用|Apps)$');await until(()=>cdp.evaluate('document.querySelector("input[aria-label]")?.placeholder'),p=>/搜索应用|Search apps/.test(p),'apps ready');await field('搜索应用|Search apps','Next fixture');await click('启动并打开|Start and open');
      const nextReady=await until(snapshot,s=>s.runs.some(r=>r.appId===registered.value.id&&r.health==='ready'),'real Next readiness',90000);const nextRun=nextReady.runs.find(r=>r.appId===registered.value.id&&r.health==='ready');
      await until(()=>guest('document.body.innerText'),text=>text?.includes('Harnss Next application'),'Next preview');await capture('next-preview');record('real Next discovery launch preview',{version:nextPackage.dependencies.next,port:nextRun.port});
      await click('^(停止|Stop)$');await until(snapshot,s=>s.runs.find(r=>r.runId===nextRun.runId)?.phase==='stopped','Next stop');assert(await portFree(nextRun.port));record('Next stop releases port');
    }
    await quit();evidence.ok=true;
  } catch(error) {
    evidence.ok=false;evidence.error=error.stack;
    if(cdp){try{evidence.lastUI=await cdp.evaluate('document.body?.innerText || ""');await capture('failed-state');}catch{}}
    throw error;
  } finally {
    if(cdp){try{await quit();}catch{cdp?.close();}}
    if(child && child.exitCode===null)child.kill();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await fs.writeFile(path.join(output,'packaged-smoke.json'),JSON.stringify(evidence,null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
