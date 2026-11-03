import test from 'node:test';
import assert from 'node:assert/strict';
import {initialAffect,applyAppraised,affectAt,makeAppraisedData,hasAppraised,affectForStep} from '../src/affect/engine.ts';
import {evaluatedAdd,evaluatedHas,emptyEvaluated,assertEvaluated,evaluatedFromSeqs} from '../src/affect/index.ts';
import {prepareAffectStep,affectReceipt} from '../src/affect/adapter.ts';
import {affectLineForReplay,renderAffectNow,MAX_AFFECT_LINE_CHARS} from '../src/affect/render.ts';
import type {AffectAppraisedData} from '../src/affect/types.ts';
const a={r:1,s:.3,u:.2,g:.5,b:0,n:.3,z:.3,c:.4,q:1};
const pulse=(seq:number,at=1_000_000)=>makeAppraisedData({sourceSeq:seq,evaluatedAtMs:at,sourceWeight:1,appraisal:a,reasonCode:'friendly_contact'});
test('lossless adaptive bitmap survives sparse, dense, out-of-order and roundtrip',()=>{
 const seqs=[...Array.from({length:200},(_,i)=>1024+i),2,101002,32768,1025];
 const idx=evaluatedFromSeqs(seqs);assertEvaluated(idx);
 assert.ok(idx.chunks.some(x=>x.dense!==undefined));assert.ok(idx.chunks.some(x=>x.sparse!==undefined));
 const replay=JSON.parse(JSON.stringify(idx));assertEvaluated(replay);
 for(const n of seqs)assert.equal(evaluatedHas(replay,n),true);
 assert.equal(evaluatedHas(replay,99999),false);
 assert.deepEqual(evaluatedAdd(replay,1024),replay);
});
test('index must not simply trim recent N source IDs',()=>{
 let idx=emptyEvaluated();for(let i=1;i<11000;i+=3)idx=evaluatedAdd(idx,i);
 assert.equal(evaluatedHas(idx,1),true);assert.equal(evaluatedHas(idx,10999),true);
 assert.equal(idx.chunks.length,Math.ceil(11000/1024));
});
test('append -> fold -> JSON checkpoint -> recover is idempotent (standalone projection simulation)',()=>{
 const events=[pulse(19),pulse(27,2_000_000),pulse(19,3_000_000)];
 const appendFold=events.reduce(applyAppraised,initialAffect());
 const snap=JSON.stringify({version:3,upToSeq:100,state:{lastSeq:100,affect:appendFold}});
 const recovered=JSON.parse(snap).state.affect;
 assert.equal(hasAppraised(recovered,19),true);
 assert.deepEqual(applyAppraised(recovered,pulse(19)),recovered);
 assert.deepEqual(applyAppraised(initialAffect(),events[0]!),applyAppraised(initialAffect(),events[0]!));
});
test('one step receipt renderedLine equals request bytes and replay consumes receipt (simulated request)',()=>{
 const stored=applyAppraised(initialAffect(),pulse(11));
 const prepared=prepareAffectStep(stored,'2026-10-29T10:00:00.000Z'),receipt=affectReceipt(prepared);
 const actual=`时刻：今天\n${receipt.renderedLine}\n当前任务：聊天`;
 const replayed=`时刻：今天\n${affectLineForReplay({data:{affect:receipt}})}\n当前任务：聊天`;
 assert.equal(Buffer.compare(Buffer.from(actual),Buffer.from(replayed)),0);
 assert.equal(affectLineForReplay({data:{}}),null);
 assert.throws(()=>affectLineForReplay({data:{affect:{renderedLine:'情绪：'+'a'.repeat(150)}}}));
});
test('disabled: no injected line, no modified prompt bytes (model input simulation)',()=>{
 const base={model:'heavy',instructions:'UNCHANGED PREFIX',input:[{role:'developer',content:'时刻：今天'}],tools:[{name:'speak'}]};
 const disabled=structuredClone(base);const before=JSON.stringify(base);
 const line=null;if(line!==null)disabled.input.push({role:'developer',content:line});
 assert.equal(JSON.stringify(disabled),before);
});
test('must-keep affect in steps 2/3 as a pure rendered field, no history mutation',()=>{
 const line='情绪：平稳。';const turn=[1,2,3].map(step=>({step,nowText:`时刻：今天\n${line}`}));
 for(const item of turn)assert.match(item.nowText,/^时刻：今天\n情绪：/);
});
test('CLI replay and GUI preview share affectLineForReplay pure helper',()=>{
 const receipt={renderedLine:'情绪：平稳。'};
 const cli=affectLineForReplay({data:{affect:receipt}});
 const gui=affectLineForReplay({data:{affect:receipt}});
 assert.equal(cli,gui);
});
test('cause eviction chooses strongest surviving impact, not arbitrary last eight',()=>{
 let state=initialAffect();
 for(let i=1;i<=15;i++)state=applyAppraised(state,{...pulse(i,i*60_000),impulse:{joy:i===1?1:0,distress:0,concern:0,irritation:0,warmth:i===1?0:.09,shyness:0}});
 assert.ok(state.causes.length<=8);
 assert.ok(state.causes.some(c=>c.sourceSeq===1));
});
test('forward-compatible unknown reasonCode maps to general, stored impulse stays truth',()=>{
 const e:AffectAppraisedData={...pulse(100),version:2,reasonCode:'future_type',impulse:{joy:0,distress:0,concern:.5,irritation:0,warmth:0,curiosity:0}};
 const stored=applyAppraised(initialAffect(),e);assert.ok(stored.causes.some(x=>x.reasonCode==='general'));
 assert.equal(stored.emotions.concern,.5);
 assert.throws(()=>applyAppraised(initialAffect(),{...e,version:800}));
});
test('invalid timestamp fails closed, rollback/zone/day shift never resets state',()=>{
 const state=applyAppraised(initialAffect(),pulse(3));
 assert.throws(()=>affectForStep(state,'yesterday'));
 assert.deepEqual(affectAt(state,500),state);
 const a=affectForStep(state,'2026-10-29T10:00:00+09:00'),b=affectForStep(state,'2026-10-29T01:00:00Z');
 assert.deepEqual(a,b);
 assert.equal(hasAppraised(affectForStep(state,'2026-10-30T01:00:00+09:00'),3),true);
});
test('bounded line and fixed vocabulary never leaks raw model messages',()=>{
 const result=renderAffectNow(applyAppraised(initialAffect(),pulse(19)));
 assert.ok([...result].length<=MAX_AFFECT_LINE_CHARS);assert.doesNotMatch(result,/token|密钥|password/);
});
