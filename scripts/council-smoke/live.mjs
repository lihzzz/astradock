import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import path from "node:path";
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)("electron"),[path.join(import.meta.dirname,"live.cjs")],{env,windowsHide:true,stdio:"inherit"});
const timer=setTimeout(()=>child.kill(),75000);
child.once("error",e=>{clearTimeout(timer);console.error(e);process.exitCode=1;});child.once("exit",code=>{clearTimeout(timer);process.exitCode=code??1;});
