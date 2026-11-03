import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareAffectStep,affectReceipt} from '../src/affect/adapter.ts';
import {initialAffect,makeAppraisedData,applyAppraised} from '../src/affect/engine.ts';
import {affectLineForReplay} from '../src/affect/render.ts';
import {evaluatedAdd,assertEvaluated,emptyEvaluated} from '../src/affect/index.ts';
import {candidateFromReadChannel} from '../src/affect/triage.ts';

const generator=()=>readFileSync('scripts/generate_full_versions.py','utf8');
test('post-light budget guard is generated before heavy execution',()=>{
 const src=generator();
 assert.match(src,/budgetAfterAffect.*checkBeforeStep/);
 assert.match(src,/if \(budgetAfterAffect !== null\) return budgetAfterAffect/);
});
test('negative-cache schema rejects malformed evaluated-index and out-of-range mood',()=>{
 const src=generator();
 assert.match(src,/assertEvaluated\(a\['evaluated'\]/);
 assert.match(src,/a\['mood'\]\['valence'\] < -1/);
 assert.match(src,/a\['causes'\]\.length > 8/);
});
test('compressed dedup index validity catches corrupted offsets',()=>{
 let idx=emptyEvaluated();for(let i=1;i<=220;i++)idx=evaluatedAdd(idx,i);
 assert.doesNotThrow(()=>assertEvaluated(idx));
 const corrupted=JSON.parse(JSON.stringify(idx));corrupted.chunks[0].dense='bad';
 assert.throws(()=>assertEvaluated(corrupted));
});
test('replay receipt always overrides later calculated state',()=>{
 const a={r:1,s:0,u:-.9,g:0,b:0,n:0,z:0,c:0,q:1};
 const event=makeAppraisedData({sourceSeq:7,evaluatedAtMs:Date.parse('2026-10-29T12:00:00Z'),sourceWeight:1,appraisal:a,reasonCode:'owner_setback'});
 const first=affectReceipt(prepareAffectStep(initialAffect(),'2026-10-29T12:00:00Z'));
 const newState=applyAppraised(initialAffect(),event);
 const second=affectReceipt(prepareAffectStep(newState,'2026-10-29T12:00:00Z'));
 assert.notEqual(first.renderedLine,second.renderedLine);
 assert.equal(affectLineForReplay({data:{affect:first}}),first.renderedLine);
});
test('unobserved channel material never becomes evidence merely from a matching string',()=>{
 const toolResult={seq:12,type:'tool/result',visibility:'model',data:{callSeq:11,callId:'c',status:'ok',content:'测试消息'}};
 const unrelated=[{seq:11,type:'tool/call',visibility:'model',data:{callId:'other',name:'read_channel'}}];
 assert.equal(candidateFromReadChannel(toolResult,unrelated),null);
});
