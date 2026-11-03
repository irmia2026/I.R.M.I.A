/**
 * Copy into test/ AFTER generating/applying all eight full replacement files.
 * NOT executed in the standalone delivery; this requires the actual IRMIA checkout.
 * Keep upstream authz/real-loop end-to-end tests as separately required checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventLog} from '../src/log/event-log.ts';
import {fold} from '../src/state/fold.ts';
import {writeSnapshot,loadLatestSnapshot,foldFromSnapshot} from '../src/state/snapshot.ts';
import {saveProjectionCache} from '../src/state/projection-cache.ts';
import {recover,timersOf} from '../src/runtime/recover.ts';
import {makeAppraisedData,hasAppraised,initialAffect} from '../src/affect/engine.ts';
import {prepareAffectStep,affectReceipt} from '../src/affect/adapter.ts';
import {affectLineForReplay} from '../src/affect/render.ts';
import {deriveRequest} from '../src/runtime/agent-loop.ts';
import {candidateFromWake,candidateFromReadChannel} from '../src/affect/triage.ts';
import type {AppEvent} from '../src/log/types.js';
const AP={r:1,s:0,u:-.8,g:0,b:0,n:.2,z:.5,c:.1,q:1};
const now='2026-10-29T10:00:00.000Z';
function derived(overrides:Record<string,unknown>={}){
 return deriveRequest({persona:{identity:'测试人格',constitution:'边界不变',style:'简洁',state:'',personaHash:'hash',relationship:null},tools:[{name:'speak',description:'send',parameters:{type:'object'}}],timezone:'Asia/Tokyo',lane:'heavy',events:[],wakeEvent:null,taskCard:{title:'回话',turn:1,step:1,todoOpen:[]},now,model:'test',channelRender:null,...overrides} as Parameters<typeof deriveRequest>[0]);
}
test('01: append -> fold -> snapshot -> recover (upstream real EventLog)',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'irmia-affect-e2e-'));let recovered:Awaited<ReturnType<typeof recover>>|null=null;
 try{
  const log=await EventLog.open(join(dir,'events'));
  const event={seq:log.nextSeq(),ts:now,type:'affect/appraised',visibility:'internal',data:makeAppraisedData({sourceSeq:100,evaluatedAtMs:Date.parse(now),sourceWeight:1,appraisal:AP,reasonCode:'owner_setback'})} as AppEvent;
  log.append(event,{sync:true});const original=fold([event]);
  assert.equal(hasAppraised(original.affect,100),true);
  await writeSnapshot(dir,original);
  await saveProjectionCache(dir,original,original.lastSeq);
  log.close();
  // Force snapshot restoration; runtime recovery must ignore missing projection cache.
  await unlink(join(dir,'projection.json'));
  recovered=await recover({dataDir:dir});
  assert.equal(hasAppraised(recovered.projection.affect,100),true);
  const snap=await loadLatestSnapshot(dir);
  assert.ok(snap);
  const replayed=await foldFromSnapshot(recovered.log,snap!);
  assert.deepEqual(replayed.affect,recovered.projection.affect);
 }finally{timersOf(recovered as NonNullable<typeof recovered>)?.stop();recovered?.log.close();recovered?.lock.release();await rm(dir,{recursive:true,force:true});}
});
test('02: step/start receipt bytes equal generated now-layer line',()=>{
 const s=prepareAffectStep(initialAffect(),'2026-10-29T10:00:00.000Z');const receipt=affectReceipt(s);
 const actual=derived({affectLine:s.renderedLine});
 const injected=actual.input.filter(x=>x.type==='message'&&x.role==='developer'&&typeof x.content==='string'&&x.content.includes(receipt.renderedLine));
 assert.equal(injected.length,1,'one and only one affect-bearing developer item');
 assert.equal((injected[0] as {content:string}).content.split(receipt.renderedLine).length-1,1,'affect state appears exactly once');
 assert.equal(affectLineForReplay({data:{affect:receipt}}),receipt.renderedLine);
});
test('03: disabled negative snapshot identical to pre-extension shape',()=>{
 const old=derived();const disabled=derived({affectLine:null});
 assert.equal(JSON.stringify({model:old.model,instructions:old.instructions,input:old.input,tools:old.tools}),JSON.stringify({model:disabled.model,instructions:disabled.instructions,input:disabled.input,tools:disabled.tools}));
});
test('04: NOW_MUST_KEEP affect step 2/3',()=>{
 for(const step of [2,3]){const req=derived({taskCard:{title:'回话',turn:1,step,todoOpen:[]},affectLine:'情绪：平稳。',previousNowLayer:'────【此刻】────\n时刻：10:00\n情绪：平稳。'});assert.ok(req.input.some(x=>x.type==='message'&&x.role==='developer'&&typeof x.content==='string'&&x.content.includes('情绪：平稳。')));}
});
test('05: replay receipt does not depend on current affect state',()=>{
 const historical={data:{affect:{renderedLine:'情绪：平稳。'}}};
 const later=prepareAffectStep(initialAffect(),'2027-03-04T10:00:00.000Z');
 assert.equal(affectLineForReplay(historical),'情绪：平稳。');
 assert.equal(affectLineForReplay({data:{}}),null,'missing historical receipt must not be invented from current Projection');
 assert.equal(typeof later.renderedLine,'string');
 // GUI preview is private; its adapter must call the same helper, not this test fixture.
});
test('06: group mention is appraised; read_channel preview still needs an observed tool/result',()=>{
 const group={seq:77,type:'wake/channel',visibility:'model',data:{chatType:'group',text:'群里的正文'}};
 assert.equal(candidateFromWake(group,'external')?.actor,'external');
 const result={seq:80,type:'tool/result',visibility:'model',data:{callSeq:79,callId:'a',status:'ok',content:'消息正文'}};
 assert.equal(candidateFromReadChannel(result,[]),null);
});
test('07: affect line never changes registered tools or action permissions',()=>{
 const a=derived({affectLine:'情绪：平稳。'}),b=derived();
 assert.deepEqual(a.tools,b.tools);
 assert.deepEqual(a.tools.map(t=>t.name),['speak']);
 // Authorization still needs existing trust.ts/authz.ts main test suite; not emulated here.
});

test('08: auxiliary light accounting charges tokens but never changes heavy health probes',()=>{
 const payload={turn:1,step:1,lane:'light' as const,model:'light-test',inputTokens:13,outputTokens:4,
  cacheHitTokens:3,cacheMissTokens:10,durationMs:7,retryCount:0,
  finishReason:'failed' as const,tokensTodayAccum:17};
 const auxiliary={seq:1,ts:now,type:'budget/consumed',visibility:'internal',data:{...payload,affectEvaluation:true}} as AppEvent;
 const regular={seq:1,ts:now,type:'budget/consumed',visibility:'internal',data:payload} as AppEvent;
 const afterAux=fold([auxiliary]);
 const afterRegular=fold([regular]);
 assert.equal(afterAux.budget.tokensTodayLight,14,'light usage still counts toward the actual budget');
 assert.equal(afterAux.failStreak,0,'auxiliary failure cannot mark the main model unhealthy');
 assert.equal(afterAux.lastModelSuccessAt,null,'auxiliary success/failure cannot advance the main model health clock');
 assert.equal(afterRegular.failStreak,1,'original global health semantics remain unchanged for non-affect calls');
});

test('09: reopening the same dataDir keeps the digest and never invents appraisals',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'irmia-affect-reopen-'));
 try{
  const log=await EventLog.open(join(dir,'events'));
  const event={seq:log.nextSeq(),ts:now,type:'affect/appraised',visibility:'internal',data:makeAppraisedData({sourceSeq:100,evaluatedAtMs:Date.parse(now),sourceWeight:1,appraisal:AP,reasonCode:'owner_setback'})} as AppEvent;
  log.append(event,{sync:true});
  log.close();
  const openOnce=async()=>{
   const recovered=await recover({dataDir:dir});
   try{
    const events=[];for await(const item of recovered.log.readAll())events.push(item);
    return {digest:JSON.stringify(recovered.projection.affect),appraisals:events.filter(item=>item.type==='affect/appraised').length};
   }finally{timersOf(recovered)?.stop();recovered.log.close();recovered.lock.release();}
  };
  const first=await openOnce(),second=await openOnce();
  assert.equal(first.appraisals,1);
  assert.equal(second.appraisals,1,'recovery must dedupe by sourceSeq, not append a fresh appraisal');
  assert.equal(second.digest,first.digest,'same log must rebuild the same affect projection twice');
 }finally{await rm(dir,{recursive:true,force:true});}
});
