/** Offline contract regression, or scoring recorded retrieval IDs. Never invokes a model or SiYuan. */
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');const {z}=require('zod');
const root=path.resolve(__dirname,'..'),fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/memory-intelligence/cases.json'),'utf8'));
const index=process.argv.indexOf('--results');
if(index<0){
  const cli=path.join(path.dirname(require.resolve('vitest/package.json')),'vitest.mjs');
  const run=spawnSync(process.execPath,[cli,'run','--config','vitest.config.electron.ts','shared/lib/memory-entry.test.ts','shared/lib/memory-evaluation.test.ts','electron/src/lib/memory/intelligence-runtime.test.ts','electron/src/lib/memory/managed-brain.test.ts','electron/src/lib/session-handoff.test.ts'],{cwd:root,stdio:'inherit',shell:false});
  console.log(JSON.stringify({mode:'offline_contracts',knowledgeCases:fixtures.cases.length,queryVariants:fixtures.cases.length*3,negativeCases:fixtures.negative.length,realModelQuality:'not_run',realSiYuanRetrieval:'not_run'},null,2));process.exitCode=run.status??1;
}else{
  const file=process.argv[index+1];if(!file)throw new Error('--results requires a recorded result file');
  const schema=z.object({engine:z.string().min(1),model:z.string().min(1),commit:z.string().min(1),fixtureVersion:z.literal(1),runs:z.array(z.object({caseId:z.string(),variant:z.number().int().min(0).max(2),iteration:z.number().int().min(1).max(3),retrieved:z.array(z.string()).max(40)}).strict()).max(10000)}).strict();
  const data=schema.parse(JSON.parse(fs.readFileSync(file,'utf8')));const seen=new Set();let hits=0,mrr=0,positives=0,negativeHits=0,negatives=0;
  for(const r of data.runs){const key=[r.caseId,r.variant,r.iteration].join(':');if(seen.has(key))throw new Error('Duplicate run '+key);seen.add(key);const c=fixtures.cases.find(c=>c.id===r.caseId),n=fixtures.negative.find(n=>n.id===r.caseId);if(!c&&!n)throw new Error('Unknown case '+r.caseId);if(n&&r.variant!==0)throw new Error('Negative cases use variant 0');if(new Set(r.retrieved).size!==r.retrieved.length)throw new Error('Duplicate retrieved IDs');if(c){positives++;const rank=r.retrieved.slice(0,5).indexOf(c.id);if(rank>=0){hits++;mrr+=1/(rank+1);}}else{negatives++;if(r.retrieved.length)negativeHits++;}}
  const complete=positives===fixtures.cases.length*3*3 && negatives===fixtures.negative.length*3;
  const report={engine:data.engine,model:data.model,commit:data.commit,fixtureVersion:1,mode:'recorded_id_retrieval',positives,negatives,recallAt5:positives?hits/positives:null,mrrAt5:positives?mrr/positives:null,negativeHitRate:negatives?negativeHits/negatives:null,complete,gate:complete&&hits/positives>=0.9&&negativeHits===0?'retrieval_ids_pass':'incomplete_or_failed',extractionAndTaskQuality:'requires separate source/condition/task judgement; not inferred from these IDs'};
  console.log(JSON.stringify(report,null,2));if(!complete||report.gate!=='retrieval_ids_pass')process.exitCode=2;
}
