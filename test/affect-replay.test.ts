import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAffect, applyAppraised, makeAppraisedData } from '../src/affect/engine.ts';
import { foldAffectEvents, prepareAffectStep, affectReceipt } from '../src/affect/adapter.ts';
import { evaluatedHas } from '../src/affect/index.ts';
import type { AffectAppraisedData } from '../src/affect/types.ts';

const a = { r:1,s:0.3,u:0.2,g:0.7,b:0,n:0,z:0,c:1,q:0.9 };
const ts1 = '2026-10-29T10:00:00.000Z';
const ts2 = '2026-10-29T10:01:00.000Z';
const ts3 = '2026-10-29T10:05:00.000Z';
const e1 = makeAppraisedData({sourceSeq:51,evaluatedAtMs:Date.parse(ts1),sourceWeight:1,appraisal:a,reasonCode:'friendly_contact'});
const e2 = makeAppraisedData({sourceSeq:64,evaluatedAtMs:Date.parse(ts2),sourceWeight:0.7,appraisal:{...a,s:0,g:0,n:0.3},reasonCode:'new_discovery'});

/** Host simulation: no real IRMIA repository code here. */
function foldUntil(events: readonly { seq:number; type:string; data:unknown }[], limit: number) {
  const mapped: AffectAppraisedData[] = events.filter(x => x.seq < limit && x.type==='affect/appraised')
    .map(x => x.data as AffectAppraisedData);
  return foldAffectEvents(mapped);
}

test('request receipt survives newer events; historical step uses its own timestamp', () => {
  const log = [
    {seq:52,type:'affect/appraised',data:e1},
    {seq:53,type:'step/start',data:{step:1}},
    {seq:65,type:'affect/appraised',data:e2},
    {seq:66,type:'step/start',data:{step:2}},
  ];
  const originalStep = affectReceipt(prepareAffectStep(foldUntil(log,53),ts1));
  const replayStep = affectReceipt(prepareAffectStep(foldUntil(log,53),ts1));
  assert.deepEqual(originalStep,replayStep);
  assert.notDeepEqual(originalStep,affectReceipt(prepareAffectStep(foldUntil(log,66),ts2)));
});

test('event impulse not appraisal calculation is the historical truth', () => {
  const tamperedAppraisal = {...e1, appraisal: {...e1.appraisal, g:-0.9} };
  assert.deepEqual(applyAppraised(initialAffect(), e1).emotions,
                   applyAppraised(initialAffect(),tamperedAppraisal).emotions);
});

test('silence/heartbeat is time decay only, no event append needed', () => {
  const stored=applyAppraised(initialAffect(),e1);
  const step=prepareAffectStep(stored,ts3);
  assert.equal(stored.atMs, Date.parse(ts1));
  assert.equal(step.state.atMs, Date.parse(ts3));
  assert.equal(evaluatedHas(stored.evaluated,51),true);
  assert.equal(evaluatedHas(step.state.evaluated,51),true);
});

test('repeated appraisals from crash-replay do not inflate sentiment', () => {
  const twice=foldAffectEvents([e1,e2,e1]);
  const once=foldAffectEvents([e1,e2]);
  assert.deepEqual(twice,once);
});
