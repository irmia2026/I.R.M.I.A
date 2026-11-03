import {affectForStep,applyAppraised,initialAffect} from './engine.ts';
import {renderAffectNow} from './render.ts';
import {AFFECT_VERSION,type AffectAppraisedData,type AffectState,type PreparedAffect,type AffectStepReceipt} from './types.ts';
/**
 * 把事件按给定顺序折成一份情绪状态。
 *
 * `onState` 是给"要每个时点快照"的调用方用的（`/api/affect` 的 history）：每折完一条就回调一次，
 * 这样一次线性遍历就能拿到全部中间态，既不改判据也不用把同一条事件反复折。
 * 不传它时行为与从前逐字节相同。
 */
export function foldAffectEvents(events:Iterable<AffectAppraisedData>,initialAtMs=0,onState?:(state:AffectState)=>void):AffectState{let state=initialAffect(initialAtMs);for(const event of events){state=applyAppraised(state,event);onState?.(state);}return state;}
export function prepareAffectStep(state:AffectState,stepTs:string,warn?: (line:string)=>void):PreparedAffect{const at=affectForStep(state,stepTs);return {state:at,renderedLine:renderAffectNow(at,warn)};}
export function affectReceipt(prepared:PreparedAffect):AffectStepReceipt{return {version:AFFECT_VERSION,atMs:prepared.state.atMs,renderedLine:prepared.renderedLine};}
