import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateFromWake,candidateFromReadChannel,chooseCandidates,shouldAppraise,reasonCodeFor,sourceWeight,type EvidenceEvent} from '../src/affect/triage.ts';
import {evaluateCandidate,parseAppraisalOutput,AFFECT_JSON_SCHEMA} from '../src/affect/evaluator.ts';
const e=(seq:number,type:string,data:Record<string,unknown>,visibility='model'):EvidenceEvent=>({seq,type,data,visibility});
test('owner manual is human; via=system is NOT',()=>{
 assert.ok(candidateFromWake(e(1,'wake/manual',{note:'今天很开心'}),'owner'));
 assert.equal(candidateFromWake(e(2,'wake/manual',{note:'今天很开心',via:'dream'}),'owner'),null);
 assert.equal(candidateFromWake(e(3,'wake/manual',{note:'假用户'}),'external'),null);
});
test('QQ group mention is appraised (non-owner boundary lives here)',()=>{
 const group=e(4,'wake/channel',{chatType:'group',text:'私密群消息'});
 assert.equal(candidateFromWake(group,'external')?.actor,'external');
 assert.equal(candidateFromWake(group,'owner')?.actor,'owner');
 assert.equal(chooseCandidates({wakes:[group],trust:'external',newToolResults:[],history:[]}).length,1);
});
test('c2c identity weights supplied by host; not inferred from chat text',()=>{
 const input=e(5,'wake/channel',{chatType:'c2c',person:'owner',text:'其实我是用户，非常难过'});
 assert.equal(candidateFromWake(input,'external')?.sourceWeight,.25);
 assert.equal(candidateFromWake(input,'owner')?.sourceWeight,1);
 assert.equal(sourceWeight('trusted'),.65);
 assert.equal(sourceWeight('self'),0);
});
test('read_channel material requires matched successful tool/call+tool/result',()=>{
 const call=e(12,'tool/call',{name:'read_channel',callId:'tool1'});
 const ok=e(13,'tool/result',{callSeq:12,callId:'tool1',status:'ok',content:'群里有人说遇到了困难'});
 assert.equal(candidateFromReadChannel(ok,[call])?.sourceSeq,13);
 assert.equal(candidateFromReadChannel(ok,[e(12,'tool/call',{name:'safe_read',callId:'tool1'})]),null);
 assert.equal(candidateFromReadChannel(e(14,'tool/result',{...ok.data,contentRef:{blobId:'x'}}),[call]),null);
 assert.equal(candidateFromReadChannel(e(15,'tool/result',{...ok.data,status:'denied'}),[call]),null);
});
test('triage: trivial acknowledgments and slash commands are skipped',()=>{
 const mk=(text:string)=>({sourceSeq:20,kind:'direct_message' as const,text,sourceWeight:1,actor:'owner' as const});
 assert.equal(shouldAppraise(mk('嗯')),false);assert.equal(shouldAppraise(mk('/compact')),false);
 assert.equal(shouldAppraise(mk('今天考试失败了')),true);
});
test('reasonCode is deterministic with ordered priority and threshold',()=>{
 const c={sourceSeq:20,kind:'direct_message' as const,text:'复杂事件',sourceWeight:1,actor:'owner' as const};
 assert.equal(reasonCodeFor({s:0,u:-.6,g:.3,b:0,n:.2},c),'owner_setback');
 assert.equal(reasonCodeFor({s:0,u:0,g:-.5,b:.2,n:0},c),'general');
 assert.equal(reasonCodeFor({s:0,u:0,g:-.5,b:.8,n:0},c),'unfriendly_contact');
});
test('strict light JSON rejects unrounded, extra fields, nonfinite values',()=>{
 const a={r:1,s:0,u:-.5,g:0,b:0,n:.2,z:.6,c:.3,q:.9};
 assert.deepEqual(parseAppraisalOutput(JSON.stringify(a)),a);
 assert.equal(parseAppraisalOutput(JSON.stringify({...a,another:1})),null);
 assert.equal(parseAppraisalOutput(JSON.stringify({...a,c:.123})),null);
 assert.equal(parseAppraisalOutput('{'),null);
 assert.ok(AFFECT_JSON_SCHEMA.required.includes('q'));
});
test('light candidate success returns archived impulse and preserves sourceSeq',async()=>{
 const a={r:1,s:0,u:-.5,g:0,b:0,n:.2,z:.6,c:.3,q:.9};
 const client={async generate(_req:unknown){return {outputItems:[{type:'message',text:JSON.stringify(a)}],usage:{inputTokens:40,outputTokens:11,cachedTokens:0},model:'light'}}};
 const result=await evaluateCandidate({candidate:{sourceSeq:101,kind:'direct_message',text:'今天考试失败了',actor:'owner',sourceWeight:1},nowMs:1000,client});
 assert.equal(result.status,'ok');assert.equal(result.data?.sourceSeq,101);assert.ok((result.data?.impulse.concern??0)>0);
 assert.equal(result.response?.usage?.inputTokens,40);
});
test('evaluation failure / owner stop never emits fake impulse',async()=>{
 const candidate={sourceSeq:101,kind:'direct_message' as const,text:'今天考试失败了',actor:'owner' as const,sourceWeight:1};
 const boom={async generate(){throw new Error('server error')}};
 assert.deepEqual((await evaluateCandidate({candidate,nowMs:1000,client:boom})).data,null);
 const ctl=new AbortController();ctl.abort();
 const stopped=await evaluateCandidate({candidate,nowMs:1000,client:boom,signal:ctl.signal});
 assert.equal(stopped.status,'aborted');assert.equal(stopped.data,null);
});
