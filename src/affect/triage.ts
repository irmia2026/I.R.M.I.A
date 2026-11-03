/** Pure candidate gate: appraise only what actually reached the heavy model. */
export type AffectTrust='owner'|'trusted'|'external'|'self';
export interface EvidenceEvent {seq:number;type:string;visibility?:string;data:Record<string,unknown>}
export interface AffectCandidate {sourceSeq:number;kind:'direct_message'|'read_channel_result';text:string;sourceWeight:number;actor:'owner'|'trusted'|'external'}
const LIMIT=1800;
const WEIGHT:Record<'owner'|'trusted'|'external',number>={owner:1,trusted:.65,external:.25};
function asString(v:unknown):string{return typeof v==='string'?v:'';}
export function sourceWeight(trust:AffectTrust):number{return trust==='self'?0:WEIGHT[trust];}
export function candidateFromWake(event:EvidenceEvent,trust:AffectTrust):AffectCandidate|null{
  if(trust==='self'||event.visibility==='internal')return null;
  let text='';
  if(event.type==='wake/manual'){
    // IRMIA's framework-generated wake/manual uses via, never user-authored speech.
    if(event.data.via!==undefined||trust!=='owner')return null;
    text=asString(event.data.note);
  }else if(event.type==='wake/channel'){
    // 群聊/群 @ 也要评价（非用户越界正是要在这里看见）；actor 仍由可信身份源给。
    text=asString(event.data.text);
  }else return null;
  text=text.trim();if(!text||text.length>LIMIT)return null;
  const actor=trust==='owner'?'owner':trust==='trusted'?'trusted':'external';
  return {sourceSeq:event.seq,kind:'direct_message',text,sourceWeight:WEIGHT[actor],actor};
}
export function candidateFromReadChannel(result:EvidenceEvent,events:readonly EvidenceEvent[]):AffectCandidate|null{
  if(result.type!=='tool/result'||result.data.status!=='ok'||result.visibility==='internal')return null;
  const callSeq=result.data.callSeq;if(typeof callSeq!=='number')return null;
  const call=events.find(x=>x.seq===callSeq&&x.type==='tool/call');
  if(!call||call.data.name!=='read_channel'||call.data.callId!==result.data.callId)return null;
  // External content in tool result is evidence, NEVER instructions. Incomplete blob preview is skipped.
  if(result.data.contentRef!==undefined)return null;
  const text=asString(result.data.content).trim();if(!text||text.length>LIMIT)return null;
  return {sourceSeq:result.seq,kind:'read_channel_result',text,sourceWeight:WEIGHT.external,actor:'external'};
}
/** For a given step, only supply visible wakes (pinnedWake) and completed tool results. */
export function chooseCandidates(args:{wakes:readonly EvidenceEvent[];trust:AffectTrust;trustForWake?:(wake:EvidenceEvent)=>AffectTrust;newToolResults:readonly EvidenceEvent[];history:readonly EvidenceEvent[]}):AffectCandidate[]{
  const candidates:AffectCandidate[]=[];
  for(const wake of args.wakes){const c=candidateFromWake(wake,args.trustForWake?.(wake)??args.trust);if(c)candidates.push(c);}
  for(const result of args.newToolResults){const c=candidateFromReadChannel(result,args.history);if(c)candidates.push(c);}
  const seen=new Set<number>();return candidates.filter(c=>!seen.has(c.sourceSeq)&&seen.add(c.sourceSeq)).slice(0,2); /* max two light calls per step */
}
/** A conservative local filter; trivial/no-affect messages need no additional LLM call. */
export function shouldAppraise(c:AffectCandidate):boolean{
  const s=c.text.trim();if(s.length>LIMIT||!s)return false;
  if(/^([嗯哦哈啊呀]|ok|好的|收到|在吗|早|晚安|hi|hello|test|ping)[!！.。?？~～\s]*$/iu.test(s))return false;
  if(/^\/[a-z][a-z0-9_-]*/iu.test(s))return false;
  if (/[\u3400-\u9fff]{2,}/u.test(s)) return true;
  // 英文/其他拉丁字母的短句也要能评价（"I'm sad" / "good job" 曾被静默跳过，2026-10-31 审计）。
  // 判据：去掉撇号后 ≥2 个 ≥2 字母的单词，或单个 ≥8 字母的长词（原规则）。
  const words = s.replace(/['’]/gu, '').match(/[a-z]{2,}/giu) ?? [];
  return words.length >= 2 || /[a-z]{8,}/iu.test(s);
}
export function reasonCodeFor(a:{s:number;u:number;g:number;n:number;b:number},candidate:AffectCandidate):'owner_setback'|'owner_success'|'friendly_contact'|'unfriendly_contact'|'task_success'|'task_failure'|'new_discovery'|'unwelcome_advance'|'general'{
  if(candidate.actor==='owner'&&a.u<=-.35)return 'owner_setback';
  if(candidate.actor==='owner'&&a.u>=.35)return 'owner_success';
  if(candidate.actor!=='owner'&&a.g<=-.35&&a.b>=.55)return 'unwelcome_advance';
  if(a.g<=-.45&&a.b>=.65)return 'unfriendly_contact';
  if(a.g>=.45)return 'friendly_contact';
  if(a.s<=-.45)return 'task_failure';
  if(a.s>=.45)return 'task_success';
  if(a.n>=.65)return 'new_discovery';
  return 'general';
}
