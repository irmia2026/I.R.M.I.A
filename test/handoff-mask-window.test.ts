/**
 * 交接的「那一轮该不该进遮蔽段」回归 — 夹具见 `test/fixtures/handoff-2140.ts`
 *
 * ## 为什么有这一条
 *
 * 生产实测（`data/events`，只读；复算脚本 `_research/probe-handoff-mask.mts`）：
 *
 * | | seq | 时刻 | 输入 | 命中 | 未命中 |
 * |---|---|---|---|---|---|
 * | 交接前最后一次调用 | 36931 | 13:40:08Z | 169,336 | 167,680 | 1,656 |
 * | 交接后第一次调用 | 36946 | 13:40:18Z | 83,104 | 11,008 | **72,096** |
 *
 * 交接省下 86,232 输入，却付了 72,096 未命中——**代价几乎全在**「本 turn 自己的内容没被遮掉」：
 * 那次压实（seq 36934）把遮蔽点写成 36,498（= 上一个已结束 turn 的 `turn/end`，turn 748，
 * 而且它还是被 interrupt 的那一轮），而**真正吃上下文的是紧接着跑完的 turn 749**
 * （36,509..36,933，18 步）。
 *
 * 口径要说清（复算时确认的两件事）：
 *   • 我们自己的 `estimateTokens` 量出来那一段是 **43,832**，它对应真实的 **72,096** token
 *     —— 低估 1.63×，正是这个估算口径已知的 1.5~1.7× 偏低（`tools/registry.ts`）。
 *   • 那 72,096 **不是**思维链：同一窗口里的 `message/reasoning` 是 `internal` 可见性，
 *     根本不进请求。（我一开始按"可见 43,832 + 思维链 26k"解释过，复算证明是错的。）
 *
 * 改后遮蔽点取**本 turn 的 `turn/end`**（36,933），交接后第一次请求不再含这一段。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultVisibility } from '../src/log/types.ts';
import {
  estimateHistoryTokens, estimateMaskedTokens, mechanicalSummaryText, renderHandoffNote,
  collectHandoffEntries,
} from '../src/persona/handoff-note.ts';
import { RECENT_TAIL_TOKENS, compactionCoveredUpToSeq } from '../src/runtime/agent-loop.ts';
import {
  AFTER_COMPACTION_TOKENS, EARLIER_COMPACTION_SEQ, FIXTURE_TURN_TOTAL, FIXTURE_WAKE,
  OLD_COVERED, REAL_MISS, REAL_THRESHOLD, TURN_END_SEQ, TURN_START_SEQ,
  TURN_VISIBLE, TURN_VISIBLE_TOTAL, filler, fillerWith, real2140Events,
} from './fixtures/handoff-2140.ts';
import { estimateTokens } from '../src/persona/handoff-note.ts';
import type { AppEvent } from '../src/log/types.js';

/** 本 turn 自身的可见历史（旧遮蔽点之后、36,933 之前） */
function turnVisibleTokens(events: readonly AppEvent[]): number {
  return estimateHistoryTokens(events, OLD_COVERED) - estimateHistoryTokens(events, TURN_END_SEQ);
}

/** 旧遮蔽点之后、本 turn 开始之前那一段（生产里是 32,930） */
function beforeTurnTokens(events: readonly AppEvent[]): number {
  return estimateHistoryTokens(events, OLD_COVERED) - turnVisibleTokens(events);
}

/** 遮蔽段里某一类事件的 token 合计（按 estimateHistoryTokens 的口径单条量） */
function maskedTokensOfType(events: readonly AppEvent[], type: string): number {
  return events
    .filter(e => e.type === type && e.seq > OLD_COVERED && e.seq <= TURN_END_SEQ)
    .reduce((sum, e) => sum + estimateHistoryTokens([e], 0), 0);
}

// ──────────────────────────────── ① 夹具自检 ────────────────────────────────

test('21:40 真实交接：夹具与生产实测逐项对得上', () => {
  const events = real2140Events();
  // 分项逐条对：改"哪一类事件被遮"时这条会失败，提示夹具与实测脱节
  const bt = {
    toolResult: maskedTokensOfType(events, 'tool/result'),
    toolCall: maskedTokensOfType(events, 'tool/call'),
    assistant: maskedTokensOfType(events, 'message/assistant'),
    channelWake: maskedTokensOfType(events, 'wake/channel'),
    manualWake: maskedTokensOfType(events, 'wake/manual'),
  };
  assert.deepEqual(bt, { ...TURN_VISIBLE, ...FIXTURE_WAKE }, `分项必须等于生产实测：${JSON.stringify(bt)}`);
  assert.equal(turnVisibleTokens(events), FIXTURE_TURN_TOTAL, `夹具本 turn 的可见历史 = ${FIXTURE_TURN_TOTAL}`);
  // 与生产实测的偏差必须有界（夹具是等量的，不是同一批字节）
  assert.ok(Math.abs(turnVisibleTokens(events) - TURN_VISIBLE_TOTAL) < 64,
    '夹具本 turn 的总量与生产实测的偏差应小于 64 token');
  assert.equal(estimateHistoryTokens(events, TURN_END_SEQ), AFTER_COMPACTION_TOKENS,
    '遮到 36,933 之后留在现场的只剩压实之后那一条');
  // 更早那次遮蔽点之后还有历史（生产里是 76,762）——所以"越阈值"这件事在夹具里也成立。
  // 其中本 turn 之前那一段落在 [33,818, 36,498]，量在 `EARLIER_COMPACTION_SEQ` 上。
  assert.ok(estimateHistoryTokens(events, EARLIER_COMPACTION_SEQ) >= REAL_THRESHOLD,
    `更早遮蔽点下的可见历史（${estimateHistoryTokens(events, EARLIER_COMPACTION_SEQ)}）`
    + `必须越过生产阈值 ${REAL_THRESHOLD}`);
  assert.ok(beforeTurnTokens(events) >= AFTER_COMPACTION_TOKENS,
    '旧遮蔽点之后、本 turn 之前也有内容（夹具里靠压实之后那一条代表）');
});

// ──────────────────────────────── ② 遮蔽点 ────────────────────────────────

test('21:40 真实交接：遮蔽点落在本 turn 的 turn/end，本 turn 整轮进笔记', () => {
  const events = real2140Events();

  // 改后：遮蔽点 = 本 turn 的 turn/end
  const covered = compactionCoveredUpToSeq(events, TURN_START_SEQ, 0, true);
  assert.equal(covered, TURN_END_SEQ, '自动压缩的遮蔽点 = 本 turn 的 turn/end');
  // 对照：旧口径只遮到上一个已结束的 turn（而它还在本 turn 之前）
  assert.equal(compactionCoveredUpToSeq(events, TURN_START_SEQ, 0, false), OLD_COVERED,
    '旧口径仍只遮到上一个已结束的 turn —— 这就是 21:40 那次未命中的来源');
  assert.ok(OLD_COVERED < TURN_START_SEQ, '旧遮蔽点落在本 turn 之前，本 turn 整轮留在现场');
  assert.ok(covered > TURN_START_SEQ, '新遮蔽点落在本 turn 之内');
  // 劈不开的性质没变：遮蔽点仍然是 turn 边界
  assert.ok(events.some(e => e.type === 'turn/end' && e.seq === covered), '遮蔽点本身必须是一条 turn/end');

  // 收益：本 turn 的可见历史全部进遮蔽段（这正是那 72,096 未命中的来源）
  const masked = estimateHistoryTokens(events, OLD_COVERED) - estimateHistoryTokens(events, covered);
  assert.ok(masked >= TURN_VISIBLE_TOTAL, '本 turn 的可见历史全部落进遮蔽段');
  assert.ok(masked / REAL_MISS > 0.6,
    `可见历史应占那次未命中的六成以上（实得 ${(masked / REAL_MISS * 100).toFixed(0)}%）`);

  // ── ④甲 收益闸门：这一次交接在改后**会被允许**（用户要的那条事件证据）──
  // 闸门量的是"已有摘要的覆盖点之后、本次要折进去的那一段"；这次没有更新摘要，
  // 参照点就是旧覆盖点 36,498，量出来 43,832 ≫ 闸门线 20,000。
  const gateAmount = estimateMaskedTokens(events, OLD_COVERED, covered);
  assert.equal(gateAmount, masked, '闸门量与收益量是同一把尺');
  assert.ok(gateAmount >= RECENT_TAIL_TOKENS,
    `21:40 这次交接必须过闸门（量得 ${gateAmount} ≥ ${RECENT_TAIL_TOKENS}）`);
  // 对照：旧口径下"本次要折进去的那一段"只有 443 —— 换了参照点才看得见真正的收益
  assert.ok(
    estimateMaskedTokens(events, OLD_COVERED, compactionCoveredUpToSeq(events, TURN_START_SEQ, 0, false))
      < RECENT_TAIL_TOKENS,
    '旧口径量出来只有几百 token（这就是第一版闸门误拒这次交接的原因）',
  );

  // ④乙 摘要不许落空：机械替代文本是纯函数、非空、且点破"留白 ≠ 什么都没发生"
  const mechanical = mechanicalSummaryText(7);
  assert.equal(mechanical, mechanicalSummaryText(7), '同一入参同一字节串（可重放）');
  assert.ok(mechanical.trim() !== '', '替代文本非空');
  assert.match(mechanical, /7 条往来/u, '报出折了多少条（不是一句含糊的"出错了"）');
  assert.match(mechanical, /不是"这段什么都没发生"/u, '点破留白会被误读成"什么都没有"');

  // 硬前提：**笔记必须覆盖到新的遮蔽点**——否则被遮的内容既不在笔记里、也不在历史里。
  // 这里钉的是"覆盖"这件事本身，而不是"逐条都在"：
  //   • 本 turn 的工具往来必须留得下（遮蔽段里它占 41,261 / 43,832）；
  //   • 装不下的条目**必须计数**（笔记预算 4096 token 的既有口径，不得静默丢弃）；
  //   • 未被收录的原文仍在**日志**里（`compaction/summary` 遮蔽的是渲染，不是事实）。
  const note = renderHandoffNote(events, { now: new Date(Date.UTC(2026, 9, 6, 13, 40, 9)).toISOString() });
  assert.ok(note.included > 0, '笔记收进了条目（不是只有标题的空摘要）');
  assert.equal(note.text.startsWith('# 交接笔记'), true, '新摘要的正文就是这份笔记');
  // 本 turn 的工具往来：**回执**在（`[结果] <工具名> ok`），**入参**在（`[调用] <工具名>`，
  // 且因为过 512 字节已压成「键名 + 字节数」——见下面那条专项断言）
  //
  // ⚠ `list_dir` 于 v42 被删，但**这个名字留在断言里是对的**：这份夹具是按生产 turn 749
  // 重建的，那一轮真的调过它（`tool/call` 里存的是**当时**的名字）。交接笔记要能照旧显示
  // **历史里存在过**的工具名，否则翻旧账时读到的会是一段被抹掉的历史。
  assert.match(note.text, /\[结果\] (safe_read|rg_search|list_dir|pwsh) ok/u, '本 turn 的工具回执在笔记里');
  assert.match(note.text, /\[调用\] (safe_read|rg_search|list_dir|pwsh)\(/u, '本 turn 的工具入参在笔记里');
  // 笔记的硬上限：遮蔽 43,832 token 换来的替代品必须远小于它（否则这次交接不划算）
  assert.ok(note.tokens <= 4_096, `笔记必须守在预算内（实得 ${note.tokens}）`);
  assert.ok(note.tokens * 8 < FIXTURE_TURN_TOTAL,
    `笔记（${note.tokens}）必须远小于它遮蔽的东西（${FIXTURE_TURN_TOTAL}）`);

  // 已知口径（**不是**本次改动引入的，也不随遮蔽点变化）：总预算 4096 token 装不下时，
  // 早期条目只记数量。本 turn 里最老的那条外部来话排在最前，就是这样被省掉的；
  // 在 43,832 token 的实测规模下，连最新、最便宜的那条唤醒也会挤不进去
  // （实测 included=4 / omitted=25）。要真让它们留下，该动的是笔记的选材与分档
  // （另一笔账），而不是把遮蔽点往回退。
  //
  // 两个计数之外只允许两种"少掉的条目"，且各有自己的显式痕迹：
  //   • `dedupeByStateKey`：状态类条目按 key 只留最新（重复的**不计数**，是刻意的去重）；
  //   • `mergeRepeats`：逐字重复的合并成一条并标注 `(同样的一条重复了 N 次)`。
  // 12 条工具调用被压成 4 种文本（4 个工具名）⇒ 逐字重复合并会并掉 8 条，所以上界是 8。
  const MERGED_AWAY_MAX = 8;
  const collected = collectHandoffEntries(events).length;
  assert.ok(note.omitted >= 1, '装不下的条目会计数（笔记预算的既有口径）；不得静默丢弃');
  assert.ok(note.included + note.omitted > 0, '装入 + 省略 = 全部（下面按区间钉住）');
  assert.ok(
    note.included + note.omitted <= collected
    && note.included + note.omitted >= collected - MERGED_AWAY_MAX,
    `装入 ${note.included} + 省略 ${note.omitted} 必须落在 [${collected - MERGED_AWAY_MAX}, ${collected}]：`
    + '差额只能来自去重与逐字重复合并（那两条各有自己的显式计数），不能有别的黑洞',
  );
});

// ──────────────────────────────── ③ 改后的请求体 ────────────────────────────────

test('21:40 真实交接：改后交接后第一次请求的可见历史不到改前的 10%', () => {
  const events = real2140Events();
  const before = estimateHistoryTokens(events, OLD_COVERED);
  const after = estimateHistoryTokens(events, compactionCoveredUpToSeq(events, TURN_START_SEQ, 0, true));
  assert.ok(after * 10 < before, `改后留在现场的量必须不到改前的 10%（改前 ${before} / 改后 ${after}）`);
  assert.ok(before - after >= TURN_VISIBLE_TOTAL, '省下的量至少是本 turn 的可见历史（43,832）');
  // 与生产口径同向：那次交接后第一次调用 in=83,104 / miss=72,096，
  // 改后这一段不再进请求 ⇒ 请求体再降 43,832（可见）+ 约 26k（思考链）
  assert.ok(after < 1_000, `改后留在现场的可见历史应当接近零（实得 ${after}）`);
});

// ──────────────────────────────── ④ 工具与口径自检 ────────────────────────────────

test('夹具的 token 构造精确（filler 逐值命中，不引入偏差）', () => {
  assert.equal(estimateTokens(filler(300, 'X')), 300);
  assert.equal(estimateTokens(fillerWith('safe_read{"a":"b"}', 777)), 777);
  assert.equal(
    estimateHistoryTokens([{
      seq: 1, ts: '2026-10-06T00:00:00.000Z', type: 'message/user',
      data: { text: filler(2_554, 'S') }, visibility: 'model', origin: 'x',
    } as unknown as AppEvent], 0),
    2_554,
  );
});

test('夹具的可见性口径与生产一致（turn/start 与 turn/end 是 internal）', () => {
  assert.equal(defaultVisibility('turn/start'), 'internal');
  assert.equal(defaultVisibility('turn/end'), 'internal');
  assert.equal(defaultVisibility('tool/result'), 'model');
});
