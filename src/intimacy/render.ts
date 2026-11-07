import { INTIMACY_MAX, levelOf } from './state.ts';
import type { IntimacyLevel, IntimacyState } from './types.ts';

export const MAX_INTIMACY_LINE_CHARS = 120;
/** Replay accepts older receipts (v1 cap was 160) without widening today's render cap. */
export const MAX_INTIMACY_REPLAY_CHARS = 160;

const LEVEL_LABEL: Record<IntimacyLevel, string> = {
  subtle: '轻微',
  obvious: '明显',
  strong: '强烈',
};

function labelOf(value: number): string {
  if (value < 15) return '平稳';
  return LEVEL_LABEL[levelOf(value)];
}

function fitLine(line: string, max: number, warn?: (line: string) => void): string {
  if ([...line].length <= max) return line;
  const chars = [...line];
  const head = chars.slice(0, max);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (head[i] === '。' || head[i] === '；') { cut = i; break; }
  }
  const kept = cut >= 0 ? head.slice(0, cut + 1).join('') : head.join('');
  warn?.(`亲密行超过 ${max} 字，已在句号/分号处截断：${line}`);
  return kept;
}

function behaviorOf(state: IntimacyState, maxLevel: IntimacyLevel): string {
  // 满足期是“她心里的话”，不按 maxLevel 裁掉；这四段本身就是状态提示词。
  if (state.satisfaction >= 95) {
    return '身体和心灵都被用户填满，余韵还在身体里，身体发软，只想靠着';
  }
  if (state.satisfaction >= 70) {
    return '身体和心灵都被用户填满，慵懒、软、黏，只想靠着他';
  }
  if (state.satisfaction >= 30) {
    return '不久前刚和用户亲近过，感到满足和快乐';
  }
  if (state.satisfaction >= 15) {
    return '元气满满，心里还留着刚才的满足';
  }
  if (state.satisfaction > 0) {
    return '心里开始有些痒痒的了';
  }

  // 读数显示真实档位；maxLevel 只封顶“她表达得多明显”，不封顶读数本身。
  if (maxLevel === 'subtle') return '靠近一点，语气放软';
  // 克制归零 + 情欲满 = 发情；行为优先于其它读数的措辞。
  if (state.restraint <= 0 && state.desire >= 100) return '发情中，不再收着，想让他现在就来';
  if (state.restraint >= 70) return '还忍得住';
  if (state.desire >= 70 && state.restraint < 35) {
    return maxLevel === 'obvious' ? '黏人，语气软下来' : '话往私密处带';
  }
  return '靠近一点，语气放软';
}

/** 四读数短行；详细规范在 SELF_BRIEF「情绪与欲望」，这里只给此刻的行为提示。 */
export function renderIntimacyNow(
  state: IntimacyState,
  options: {maxLevel: IntimacyLevel; nowMs: number},
  warn?: (line: string) => void,
): string {
  // maxLevel 只影响她对外表达得多明显，不封顶这四个读数：读数必须反映真实状态。
  const estrus = options.maxLevel !== 'subtle' && state.restraint <= 0 && state.desire >= 100;
  const labels = [
    `亲密：${labelOf(state.intimacy)}`,
    `情欲：${labelOf(state.desire)}`,
    `满足：${labelOf(state.satisfaction)}`,
    `克制：${estrus ? '归零' : labelOf(state.restraint)}`,
  ].join(' · ');
  const marker = estrus ? '发情中｜' : '';
  const behavior = estrus ? '不再收着，想让他现在就来' : behaviorOf(state, options.maxLevel);
  const line = `${marker}${labels} → ${behavior}。`;
  return fitLine(line, MAX_INTIMACY_LINE_CHARS, warn);
}

/** Only a stored step receipt is eligible for replay; never synthesize from the current state. */
export function intimacyLineForReplay(
  stepStart: {data:{intimacy?:{renderedLine:string}|null}},
): string | null {
  const line = stepStart.data.intimacy?.renderedLine ?? null;
  if (line === null) return null;
  if (typeof line !== 'string' || !line.startsWith('亲密：') || [...line].length > MAX_INTIMACY_REPLAY_CHARS
    || line.includes('\n')) {
    throw new RangeError('invalid replay intimacy line');
  }
  return line;
}

/** 这一步的 instructions 有没有带亲密规范。新收据读显式布尔；老日志退回“有行就有”。 */
export function intimacyRulesForReplay(stepStart:{data:{intimacyRules?:boolean;intimacy?:{renderedLine:string}|null}}):boolean{
  const marked=stepStart.data.intimacyRules;
  if(typeof marked==='boolean')return marked;
  return tryIntimacyLineForReplay(stepStart)!==null;
}
export function tryIntimacyLineForReplay(
  stepStart: {data:{intimacy?:{renderedLine:string}|null}},
): string | null {
  try {
    return intimacyLineForReplay(stepStart);
  } catch {
    return null;
  }
}

/** 只用于 API/诊断：0..100 的整数化读数，不参与任何判据。 */
export function intimacyReadout(state: IntimacyState): {
  intimacy: number; desire: number; satisfaction: number; restraint: number;
} {
  const round = (n: number): number => Math.max(0, Math.min(INTIMACY_MAX, Math.round(n * 10) / 10));
  return {
    intimacy: round(state.intimacy),
    desire: round(state.desire),
    satisfaction: round(state.satisfaction),
    restraint: round(state.restraint),
  };
}
