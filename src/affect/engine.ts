import { AFFECT_VERSION,AFFECT_STATE_VERSION,EMOTIONS,REASONS,type AffectAppraisal,type AffectAppraisedData,type AffectCause,type AffectState,type EmotionName,type EmotionVector,type ReasonCode } from './types.ts';
import {emptyEvaluated,evaluatedAdd,evaluatedHas} from './index.ts';
const HALF:Record<EmotionName,number>={joy:45,distress:120,concern:90,irritation:30,warmth:240,shyness:40};
const clamp=(x:number,min:number,max:number):number=>Math.max(min,Math.min(max,x));
const pos=(x:number)=>Math.max(x,0),neg=(x:number)=>Math.max(-x,0);
function range(x:number,min:number,max:number,key:string):void{if(!Number.isFinite(x)||x<min||x>max)throw new RangeError(`invalid ${key}: ${min}..${max}`);}
function checkTime(n:number):void{if(!Number.isSafeInteger(n)||n<0)throw new RangeError('invalid timestamp');}
function emptyVector():EmotionVector{return {joy:0,distress:0,concern:0,irritation:0,warmth:0,shyness:0};}
/** Old events may carry curiosity and omit shyness; ignore unknown keys and default missing ones to 0. */
function normalizeImpulse(raw:unknown):EmotionVector{
  if(raw===null||typeof raw!=='object'||Array.isArray(raw))throw new RangeError('invalid impulse');
  const source=raw as Record<string,unknown>,out=emptyVector();
  for(const k of EMOTIONS){const value=source[k];if(value===undefined){out[k]=0;continue;}range(value as number,0,1,`impulse.${k}`);out[k]=value as number;}
  return out;
}
export function initialAffect(atMs=0):AffectState{checkTime(atMs);return {version:AFFECT_STATE_VERSION,atMs,mood:{valence:.2,arousal:.35},emotions:emptyVector(),evaluated:emptyEvaluated(),causes:[]};}
export function assertAppraisal(a:AffectAppraisal):void{for(const k of ['r','b','n','z','c','q'] as const)range(a[k],0,1,k);for(const k of ['s','u','g'] as const)range(a[k],-1,1,k);}
export function computeImpulse(a:AffectAppraisal,sourceWeight:number,empathy=.8):EmotionVector{
  assertAppraisal(a);range(sourceWeight,0,1,'sourceWeight');range(empathy,0,1,'empathy');
  const L=a.r*a.q*sourceWeight;
  return {
    joy:clamp(L*(.8*pos(a.s)+.35*empathy*pos(a.u)),0,1),
    distress:clamp(.85*L*neg(a.s)*(1-.3*a.c),0,1),
    concern:clamp(.85*L*neg(a.u)*(.6+.4*a.z),0,1),
    irritation:clamp(.75*L*neg(a.g)*a.b*(.5+.5*a.c),0,1),
    warmth:clamp(.8*L*pos(a.g),0,1),
    shyness:clamp(.7*L*(.55*pos(a.g)+.45*pos(a.u))*(1-.5*a.c),0,1),
  };
}
export function makeAppraisedData(input:{sourceSeq:number;evaluatedAtMs:number;sourceWeight:number;appraisal:AffectAppraisal;reasonCode:ReasonCode}):AffectAppraisedData{if(!Number.isSafeInteger(input.sourceSeq)||input.sourceSeq<=0)throw new RangeError('sourceSeq');checkTime(input.evaluatedAtMs);if(!(REASONS as readonly string[]).includes(input.reasonCode))throw new RangeError('reasonCode');return {version:AFFECT_VERSION,sourceSeq:input.sourceSeq,evaluatedAtMs:input.evaluatedAtMs,sourceWeight:input.sourceWeight,appraisal:{...input.appraisal},impulse:computeImpulse(input.appraisal,input.sourceWeight),reasonCode:input.reasonCode};}
/** Pure view: clock movement NEVER changes the canonical Projection. */
export function affectAt(old:AffectState,nowMs:number):AffectState{
  checkTime(nowMs);const effective=Math.max(old.atMs,nowMs),dt=(effective-old.atMs)/60_000;const emotions=emptyVector();
  for(const k of EMOTIONS)emotions[k]=(old.emotions[k]??0)*Math.pow(2,-dt/HALF[k]);
  const mood={valence:.2+(old.mood.valence-.2)*Math.pow(2,-dt/480),arousal:.35+(old.mood.arousal-.35)*Math.pow(2,-dt/240)};
  const causes=old.causes.filter(c=>effective-c.evaluatedAtMs<24*60*60_000);
  return {...old,atMs:effective,mood,emotions,causes};
}
export function hasAppraised(state:AffectState,sourceSeq:number):boolean{return evaluatedHas(state.evaluated,sourceSeq);}
/** Store and fold the original impulse. Unknown future reason strings render as 'recent event'. */
export function applyAppraised(state:AffectState,event:AffectAppraisedData):AffectState{
  if(event.version!==1&&event.version!==2)throw new RangeError('unsupported event version');
  if(!Number.isSafeInteger(event.sourceSeq)||event.sourceSeq<=0)throw new RangeError('sourceSeq');
  checkTime(event.evaluatedAtMs);assertAppraisal(event.appraisal);range(event.sourceWeight,0,1,'sourceWeight');
  const I=normalizeImpulse(event.impulse);
  if(hasAppraised(state,event.sourceSeq))return state;
  const old=affectAt(state,event.evaluatedAtMs),next=emptyVector();
  for(const k of EMOTIONS)next[k]=clamp((old.emotions[k]??0)+(1-(old.emotions[k]??0))*I[k],0,1);
  const mood={valence:clamp(old.mood.valence+.12*(I.joy+.5*I.warmth-I.distress-.5*I.irritation-.35*I.concern),-1,1),arousal:clamp(old.mood.arousal+.1*(.5*I.joy+.6*I.irritation+.6*I.concern+.5*I.shyness-.4*I.distress),0,1)};
  const dominant=EMOTIONS.reduce((a,b)=>I[b]>I[a]?b:a,EMOTIONS[0]);
  const strength=Math.max(...EMOTIONS.map(k=>I[k]));
  const cause:AffectCause={sourceSeq:event.sourceSeq,reasonCode:(REASONS as readonly string[]).includes(event.reasonCode)?event.reasonCode as ReasonCode:'general',dominantEmotion:dominant,strength,evaluatedAtMs:old.atMs};
  const pool=strength<.08?old.causes:[...old.causes,cause];
  const halfOf=(name:EmotionName):number=>(HALF[name] as number|undefined)??60;
  const weighted=pool.map(c=>({cause:c,score:c.strength*Math.pow(2,-Math.max(0,old.atMs-c.evaluatedAtMs)/60_000/halfOf(c.dominantEmotion))}));
  weighted.sort((a,b)=>b.score-a.score||b.cause.evaluatedAtMs-a.cause.evaluatedAtMs||b.cause.sourceSeq-a.cause.sourceSeq);
  const causes=weighted.slice(0,8).map(x=>x.cause).sort((a,b)=>a.evaluatedAtMs-b.evaluatedAtMs||a.sourceSeq-b.sourceSeq);
  return {...old,emotions:next,mood,causes,evaluated:evaluatedAdd(old.evaluated,event.sourceSeq)};
}
export function affectForStep(state:AffectState,stepTs:string):AffectState{if(typeof stepTs!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(stepTs))throw new RangeError('invalid step timestamp');const ms=Date.parse(stepTs);if(!Number.isSafeInteger(ms)||ms<0)throw new RangeError('invalid step timestamp');return affectAt(state,ms);}
