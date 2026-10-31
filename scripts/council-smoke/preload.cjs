const {contextBridge,ipcRenderer}=require("electron");
const invoke=(method,value)=>ipcRenderer.invoke("fixture:council",method,value);
const on=(name,fn)=>{const listener=(_e,value)=>fn(value);ipcRenderer.on(name,listener);return ()=>ipcRenderer.removeListener(name,listener);};
contextBridge.exposeInMainWorld("claude",{
  councils:{list:()=>invoke("list"),capabilities:()=>invoke("capabilities"),create:v=>invoke("create",v),start:v=>invoke("start",v),command:v=>invoke("command",v),supplement:v=>invoke("supplement",v),taskBrief:v=>invoke("taskBrief",v),remove:v=>invoke("remove",v),onChanged:fn=>on("councils:changed",fn),onDelta:fn=>on("councils:delta",fn)},
  projectApps:{workspaces:()=>invoke("workspaces")},tasks:{create:v=>invoke("task",v)},analytics:{capture:()=>{}},
});
