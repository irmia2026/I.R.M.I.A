/**
 * 21:40 那一次真实交接的夹具 —— `test/handoff-mask-window.test.ts` 与
 * `_research/probe-handoff-mask.mts` 共用同一份。
 *
 * 数值来自生产日志（`data/events`，2026-10-06 13:40:08Z 那次交接），字节由本文件按
 * 精确权重生成——不是从日志里抄下来的正文（那一小段有 1.6 MB）。
 * 出处与复算方式见 `_research/probe-handoff-mask.mts`。
 */

import assert from 'node:assert/strict';

import type { AppEvent } from '../../src/log/types.js';

// ──────────────────────────────── 真实实测值 ────────────────────────────────

/** 那次压实事件自己的 seq（`compaction/summary`，2026-10-06T13:40:09Z） */
export const COMPACTION_SEQ = 36934;
/** 当时实际写下的遮蔽点：上一个已结束 turn 的 `turn/end`（turn 748，被 interrupt 的那一轮） */
export const OLD_COVERED = 36498;
/** 本 turn（749）的 `turn/start` */
export const TURN_START_SEQ = 36509;
/** 本 turn（749）的 `turn/end` —— 改后要遮到的点 */
export const TURN_END_SEQ = 36933;
/** 更早那次压实的 seq（它遮蔽 [0, 33,817]） */
export const EARLIER_COMPACTION_SEQ = 33_817;

/**
 * 本 turn 可见历史按类型分项的实测值（`estimateHistoryTokens` 口径），合计 43,832。
 *
 * 这 43,832 对应真实的 72,096 token（低估 1.63×，与 `estimateTokens` 已知的 1.5~1.7× 一致），
 * 也就是交接后第一次调用那笔未命中。
 */
export const TURN_VISIBLE = {
  toolResult: 34_408,
  toolCall: 6_853,
  assistant: 2_554,
  channelWake: 16,
  manualWake: 1,
} as const;
export const TURN_VISIBLE_TOTAL = 43_832;

/**
 * 两条唤醒线在**夹具里**的渲染量（`renderExternalEvent` / `renderWake` 自带包装与时间戳）。
 *
 * 生产里它们是 16 与 1（同一口径量出来的）；夹具用的是同一张包装模板，但人名/会话名不同，
 * 于是差 30 token（42/5）。这一点偏差只影响夹具自己的两个数，不影响任何一条断言的方向。
 */
export const FIXTURE_WAKE = { channelWake: 42, manualWake: 5 } as const;
/** 夹具本 turn 的可见历史合计（= 上面四项实测值 + 两条唤醒在夹具里的渲染量） */
export const FIXTURE_TURN_TOTAL = TURN_VISIBLE.toolResult + TURN_VISIBLE.toolCall
  + TURN_VISIBLE.assistant + FIXTURE_WAKE.channelWake + FIXTURE_WAKE.manualWake;

/** 那次交接后第一次调用的真实未命中（代价全在这一段上） */
export const REAL_MISS = 72_096;
/** 当时的生产阈值（config.persona.compactionThresholdTokens） */
export const REAL_THRESHOLD = 100_000;
/**
 * 本 turn 之前那段可见历史在夹具里的规模。
 *
 * 生产里"旧遮蔽点之后的可见历史"是 76,762（= 此前积累的老账 + 本 turn 的 43,832），
 * 阈值 100,000。夹具只需要让这一段明显大于 0、且总量越过阈值即可。
 */
export const HISTORY_BEFORE_TURN = 60_000;
/** 紧接压实之后留在现场的那 4 条的实测合计 */
export const AFTER_COMPACTION_TOKENS = 443;

// ──────────────────────────────── 精确 token 构造 ────────────────────────────────

const WIDE_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u;
const WIDE_WEIGHT = 8;
const NARROW_WEIGHT = 3;

/** 用宽字符逼近、剩余一截用 ASCII 补（两者每字符权重都是整数，误差 ≤1 权重） */
function fillToWeight(weight: number): string {
  let rest = Math.max(0, weight);
  let out = '';
  while (rest >= WIDE_WEIGHT) { out += '浆'; rest -= WIDE_WEIGHT; }
  while (rest >= NARROW_WEIGHT) { out += 'x'; rest -= NARROW_WEIGHT; }
  return out;
}

function weightOf(text: string): number {
  let w = 0;
  for (const ch of text) w += WIDE_RE.test(ch) ? WIDE_WEIGHT : NARROW_WEIGHT;
  return w;
}

/**
 * 造一段 token 估算 ≈ `targetTokens` 的正文。
 *
 * 权重表（`estimateTokens`：宽字符 8/12、其余 3/12，末尾取上界）：一个汉字 2/3 token、
 * 一个 ASCII 字符 1/4 token，所以"目标 token 数 × 12"就是要凑的**权重**。
 */
export function filler(targetTokens: number, salt: string): string {
  const head = salt === '' ? '' : `【${salt}】`;
  const budget = targetTokens * 12 - weightOf(head);
  assert.ok(budget >= 0, `salt ${salt} 本身就超预算（目标 ${targetTokens} token）`);
  return head + fillToWeight(budget);
}

/** 把 `prefix` 算进预算：返回 `prefix + 填充`，整串权重 ≈ `targetTokens × 12` */
export function fillerWith(prefix: string, targetTokens: number): string {
  const budget = targetTokens * 12 - weightOf(prefix);
  assert.ok(budget >= 0, `前缀本身就超预算（目标 ${targetTokens} token）`);
  return prefix + fillToWeight(budget);
}

// ──────────────────────────────── 夹具本体 ────────────────────────────────

function evt(seq: number, ts: string, type: string, data: unknown, visibility = 'model'): AppEvent {
  return { seq, ts, type, data, visibility, origin: 'test-fixture' } as unknown as AppEvent;
}

/** 把一批事件摊到 [lo, hi] 的 seq 区间上 */
function spread(events: AppEvent[], lo: number, hi: number): AppEvent[] {
  const step = (hi - lo) / Math.max(1, events.length - 1);
  return events.map((e, i) => ({ ...e, seq: lo + Math.round(i * step) }));
}

/**
 * 21:40 那一次交接的等价事件序列：
 *
 *   33,818        此前积累的可见历史（HISTORY_BEFORE_TURN）——它必须落在旧遮蔽点**之后**，
 *                 否则会被更早的那次压实遮蔽掉、根本不进历史规模（夹具第一版就踩了这个空）
 *   36,498        turn/end（旧遮蔽点；turn 748，被 interrupt）      [internal]
 *   36,509        turn/start（turn 749，本 turn）                   [internal]
 *   36,510..36,932 本 turn 的可见历史，合计 43,832 token
 *   36,933        turn/end（turn 749）                              [internal]
 *   36,934        compaction/summary（当时写下的那条，遮蔽点 36,498）
 *   36,935        紧接压实之后留在现场的那条
 */
export function real2140Events(): AppEvent[] {
  const tsOf = (seq: number) => new Date(Date.UTC(2026, 9, 6, 13, 39, 0) + (seq - 36_498) * 400).toISOString();
  const build = (seq: number, type: string, data: unknown, visibility = 'model'): AppEvent =>
    evt(seq, tsOf(seq), type, data, visibility);

  const inner: AppEvent[] = [];
  // 本轮起因：一条外部来话（生产 16 token）+ 一条唤醒（生产 1 token）
  inner.push(build(0, 'wake/channel', {
    channel: 'qq-official', chatType: 'c2c', person: 'OPENID',
    text: filler(TURN_VISIBLE.channelWake, 'CH'),
  }));
  inner.push(build(0, 'wake/manual', { note: '看' }));

  // 工具往来：回执 34,408 + 入参 6,853（按实测比例摊到 12 对，尾差落到最后一条上）。
  //
  // **工具名要错开**：入参一过 512 字节就被压成「键名 + 字节数」，而同名同结构的调用压出来
  // 是同一串字节 ⇒ 笔记的逐字重复合并会把它们并成一条 `(同样的一条重复了 N 次)`。
  // 生产里这一轮调的是好几件不同的工具（read/rg/pwsh…），错开名字才是它的样子。
  // **名字不许因为"工具删了"而改**：这份夹具是历史重建（生产 turn 749），`list_dir` 于 v42
  // 被删，但那一轮真的调过它——改名字既是伪造历史，也会改掉下面按 `name.length` 配平的字节数。
  const toolNames = ['safe_read', 'rg_search', 'list_dir', 'pwsh'] as const;
  const pairs = 12;
  const resultEach = Math.floor(TURN_VISIBLE.toolResult / pairs);
  const callEach = Math.floor(TURN_VISIBLE.toolCall / pairs);
  const resultTail = TURN_VISIBLE.toolResult - resultEach * pairs;
  const callTail = TURN_VISIBLE.toolCall - callEach * pairs;
  for (let i = 0; i < pairs; i += 1) {
    const callId = `call_${i}`;
    const name = toolNames[i % toolNames.length]!;
    const last = i === pairs - 1;
    inner.push(build(0, 'tool/call', {
      turn: 749, step: i + 1, callId, name,
      // estimateHistoryTokens 里 tool/call 的文本是 `${name}${arguments}` —— 连名字一起配平
      arguments: fillerWith(`${name}{"file_path":"path_${i}.txt"}`,
        callEach + (last ? callTail : 0)).slice(name.length),
      sideEffect: 'none',
    }));
    inner.push(build(0, 'tool/result', {
      turn: 749, step: i + 1, callId, callSeq: 0, status: 'ok',
      content: filler(resultEach + (last ? resultTail : 0), `R${i}`),
      durationMs: 12,
    }));
  }
  inner.push(build(0, 'message/assistant', { text: filler(TURN_VISIBLE.assistant, 'S'), toolCalls: [] }));

  // 本 turn 的可见历史：**在 [36,510, 36,932] 之间塞进 43,832 token 的正文**。
  //
  // 为什么本 turn 之前的可见历史（`HISTORY_BEFORE_TURN`）没法一起塞进来：遮蔽点是
  // `turn/end`，而 36,498 之后、36,509 之前没有可用的 seq 区间（真实日志里那 11 个 seq
  // 是 turn 之间的空档）。所以本 turn 之前那一段在夹具里**不逐 token 复现**——它只影响
  // "旧遮蔽点下的总量"，而所有断言只关心"本 turn 那 43,832 在不在遮蔽段里"。
  const spreaded = spread(inner, TURN_START_SEQ + 1, TURN_END_SEQ - 1);
  // tool/result 的 callSeq 指向配对的那条 tool/call（渲染配对要用）
  const callSeqById = new Map<string, number>();
  for (const e of spreaded) if (e.type === 'tool/call') callSeqById.set(e.data.callId, e.seq);
  for (const e of spreaded) if (e.type === 'tool/result') e.data = { ...e.data, callSeq: callSeqById.get(e.data.callId) ?? 0 };

  return [
    // 更早那次压实留下的旧遮蔽点（它之前的一切都被遮蔽；seq 是真实值）
    build(EARLIER_COMPACTION_SEQ, 'compaction/summary', {
      coveredUpToSeq: EARLIER_COMPACTION_SEQ,
      summary: '# 交接笔记\n（更早那一段的笔记）\n',
    }),
    // 「旧遮蔽点之前就已经积累起来的历史」：它**落在两次遮蔽点之间**（33,818 < 36,498），
    // 所以它进的是"更早那次遮蔽点之后"的总量，`estimateHistoryTokens(events, OLD_COVERED)`
    // 里看不到它——真实日志里对应的就是 [33,818, 36,498] 之间那 32,930 token。
    build(33_818, 'message/assistant', { text: filler(HISTORY_BEFORE_TURN, 'H'), toolCalls: [] }),
    build(OLD_COVERED, 'turn/end', { turn: 748, reason: { kind: 'interrupted' }, spoke: false }, 'internal'),
    build(TURN_START_SEQ, 'turn/start', { turn: 749 }, 'internal'),
    ...spreaded,
    build(TURN_END_SEQ, 'turn/end', { turn: 749, reason: { kind: 'completed' }, spoke: true }, 'internal'),
    build(COMPACTION_SEQ, 'compaction/summary', {
      coveredUpToSeq: OLD_COVERED,
      summary: '# 交接笔记\n## 最近（…）\n- [13:20:00] [结果] safe_read ok：早前那一段\n',
    }),
    build(COMPACTION_SEQ + 1, 'tool/result', {
      turn: 749, step: 19, callId: 'call_18', callSeq: 0, status: 'ok',
      content: filler(AFTER_COMPACTION_TOKENS, 'AFTER'), durationMs: 3,
    }),
  ];
}
