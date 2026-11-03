import { EMOTIONS,type AffectState,type EmotionName } from './types.ts';

const labels:Record<EmotionName,string>={joy:'愉快',distress:'低落',concern:'关切',irritation:'不悦',warmth:'亲近',shyness:'害羞'};
type Band='light'|'obvious'|'strong';

/** 此刻层只留 8–15 字的短行为；详细规范在 SELF_BRIEF「情绪与欲望」。 */
const shortBehavior:Record<EmotionName,Record<Band,string>>={
  joy:{light:'轻快，句尾带点俏皮',obvious:'话变多，主动分享',strong:'表达热烈，连发两条'},
  warmth:{light:'温和，多应一句',obvious:'语气放软，主动关心',strong:'黏人，语气明显软'},
  concern:{light:'多留意对方状态',obvious:'先问一句，语速放慢',strong:'注意力全放对方'},
  irritation:{light:'话少，语气硬一点',obvious:'回复变短，带一点刺',strong:'短句反问，不骂人'},
  distress:{light:'平淡，不太热络',obvious:'提不起劲，句子变短',strong:'几乎不想多说'},
  shyness:{light:'有点不自在，语气软下来',obvious:'想躲眼神，嘴上不承认',strong:'句子变短，想藏又想留'},
};

const band=(v:number):Band=>v>=.65?'strong':v>=.35?'obvious':'light';
const level=(v:number)=>v>=.65?'强烈':v>=.35?'明显':'轻微';
export const MAX_AFFECT_LINE_CHARS=90;
/** Replay accepts old v83 receipts (up to 140) without changing today's 90-char render cap. */
export const MAX_AFFECT_REPLAY_CHARS=140;

function fitLine(line:string,max:number,warn?: (line:string)=>void):string{
  if([...line].length<=max)return line;
  const chars=[...line];
  const head=chars.slice(0,max);
  let cut=-1;
  for(let i=head.length-1;i>=0;i-=1){if(head[i]==='。'||head[i]==='；'){cut=i;break;}}
  const kept=cut>=0?head.slice(0,cut+1).join(''):head.join('');
  warn?.(`情绪行超过 ${max} 字，已在句号/分号处截断：${line}`);
  return kept;
}

export function renderAffectNow(state:AffectState,warn?: (line:string)=>void):string{
  const active=EMOTIONS.map(key=>({key,value:state.emotions[key]??0})).filter(x=>x.value>=.15)
    .sort((a,b)=>b.value-a.value||EMOTIONS.indexOf(a.key)-EMOTIONS.indexOf(b.key)).slice(0,2);
  if(active.length===0)return '情绪：平稳。';
  const main=active[0]!;
  const second=active[1];
  const mixed=second===undefined?'':`·微带${labels[second.key]}`;
  const unwelcome=state.causes.some(c=>c.reasonCode==='unwelcome_advance'
    && c.strength>=.08 && state.atMs-c.evaluatedAtMs<6*60*60_000);
  const behavior=unwelcome?'冷下来，短句拒绝':shortBehavior[main.key][band(main.value)];
  const line=`情绪：${level(main.value)}${labels[main.key]}${mixed} → ${behavior}。`;
  return fitLine(line,MAX_AFFECT_LINE_CHARS,warn);
}

/** Only a stored step receipt is eligible for replay. No live-state fallback. */
/** 这一步的 instructions 有没有带情绪规范。新收据读显式布尔；老日志退回“有行就有”。 */
export function affectRulesForReplay(stepStart:{data:{affectRules?:boolean;affect?:{renderedLine:string}|null}}):boolean{
  const marked=stepStart.data.affectRules;
  if(typeof marked==='boolean')return marked;
  return tryAffectLineForReplay(stepStart)!==null;
}
export function tryAffectLineForReplay(stepStart:{data:{affect?:{renderedLine:string}|null}}):string|null{try{return affectLineForReplay(stepStart);}catch{return null;}}
export function affectLineForReplay(stepStart:{data:{affect?:{renderedLine:string}|null}}):string|null{const line=stepStart.data.affect?.renderedLine??null;if(line===null)return null;if(typeof line!=='string'||!line.startsWith('情绪：')||[...line].length>MAX_AFFECT_REPLAY_CHARS||line.includes('\n'))throw new RangeError('invalid replay affect line');return line;}
