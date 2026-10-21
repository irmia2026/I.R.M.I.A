/**
 * 段归因读数（`src/model/cost-segments.ts`）—— 2026-10-21 加的常驻读数。
 *
 * 这一份钉五件事：
 *   ① **九段之和 = 请求的估算合计**（`instructions + tools + context.input.tokens`），
 *      且 `summary` 是从长期记忆层里**拆出来**的一格（`summary + memoryOther = memory`）；
 *   ② **占比按窗口合计算**（不是把每行的百分比再平均——大小行的权重不同）；
 *   ③ **没有 context 的老日志不参与统计**（`budgetRows` 照数，`rows` 只数真读到的）；
 *   ④ `OPS-cost-segments` 的七段顺序就是用户点名的顺序，读数能直接贴；
 *   ⑤ 报表页脚给出"真实 vs 估算"（`compaction/decision` 那两格）与"估算线用到几成"。
 *
 * 判据/聚合只有一处实现（`model/cost-segments.ts`）；doctor 与 `tools/cost-segments.ts`
 * 都读它。这里只喂合成事件，不跑真链路（真链路的段事实在 `context-audit` 的用例里）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppEvent } from '../src/log/types.ts';
import {
  COST_SEGMENT_FOCUS,
  costSegmentsDoctorDetail,
  formatCostSegments,
  readCostSegments,
} from '../src/model/cost-segments.ts';

const T0 = '2026-10-21T10:00:00.000Z';

interface Segments {
  instructions: number;
  tools: number;
  memory: number;
  summary: number;
  history: number;
  state: number;
  now: number;
  wake: number;
  hint?: number;
}

/** 一条带 `context` 的 `budget/consumed`（形状与渲染层记下的段事实同形） */
function consumed(seq: number, segments: Segments): AppEvent {
  const { instructions, tools, memory, summary, history, state, now, wake, hint = 0 } = segments;
  const memoryOther = Math.max(0, memory - summary);
  return {
    seq,
    ts: T0,
    type: 'budget/consumed',
    visibility: 'internal',
    origin: 'test',
    data: {
      turn: 1, step: 1, lane: 'heavy', model: 'fake', inputTokens: 1, outputTokens: 1,
      cacheHitTokens: 0, cacheMissTokens: 1, durationMs: 1, retryCount: 0,
      finishReason: 'completed', tokensTodayAccum: 2,
      context: {
        renderVersion: '77',
        instructions: { tokens: instructions, hash: 'i', bytes: 1 },
        tools: { tokens: tools, hash: 't', bytes: 1, count: 1 },
        memory: {
          tokens: memory,
          hash: 'm',
          bytes: 1,
          sections: [
            { name: 'skills', tokens: memoryOther, bytes: 1, hash: 's' },
            { name: 'summary', tokens: summary, bytes: 1, hash: 'sm' },
          ],
        },
        history: { tokens: history, hash: 'h', bytes: 1, headHash: 'hh', items: 1 },
        state: { tokens: state, hash: 'st', bytes: 1 },
        now: { tokens: now, hash: 'n', bytes: 1 },
        wake: { tokens: wake, hash: 'w', bytes: 1 },
        hint: { tokens: hint, hash: 'hi', bytes: 1 },
        input: { items: 1, tokens: memory + history + state + now + wake + hint },
      },
    },
  } as unknown as AppEvent;
}

/** 没有 `context` 的老日志（2026-10-21 之前的 budget/consumed 就是这个形状） */
function oldConsumed(seq: number): AppEvent {
  return {
    seq, ts: T0, type: 'budget/consumed', visibility: 'internal', origin: 'test',
    data: {
      turn: 1, step: 1, lane: 'heavy', model: 'fake', inputTokens: 100, outputTokens: 10,
      cacheHitTokens: 0, cacheMissTokens: 100, durationMs: 1, retryCount: 0,
      finishReason: 'completed', tokensTodayAccum: 110,
    },
  } as unknown as AppEvent;
}

const SEGMENTS: Segments = {
  instructions: 40_000,
  tools: 10_000,
  memory: 30_000,
  summary: 25_000,
  history: 80_000,
  state: 5_000,
  now: 10_000,
  wake: 5_000,
};

test('① 九段之和 = 估算合计；summary 从记忆层里拆出来（summary + memoryOther = memory）', () => {
  const reading = readCostSegments([consumed(1, SEGMENTS)]);
  assert.equal(reading.rows, 1);
  assert.equal(reading.budgetRows, 1);
  // 40k + 10k + 30k + 80k + 5k + 10k + 5k = 180k
  assert.equal(reading.totalTokens, 180_000, '九段之和就是 requests 的估算合计');
  assert.equal(reading.totals.summary, 25_000);
  assert.equal(reading.totals.memoryOther, 5_000);
  assert.equal(reading.totals.summary + reading.totals.memoryOther, SEGMENTS.memory,
    'summary 是记忆层里的一节，不是另一段独立内容');
  for (const key of COST_SEGMENT_FOCUS) {
    assert.ok(reading.shares[key] > 0, `${key} 该有占比`);
  }
  const sum = Object.values(reading.shares).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `九段占比之和该是 1（实测 ${sum}）`);
});

test('② 老日志（没有 context）不参与统计：budgetRows 照数、rows 只数真读到的', () => {
  const reading = readCostSegments([oldConsumed(1), consumed(2, SEGMENTS), oldConsumed(3)]);
  assert.equal(reading.budgetRows, 3, '日志里三笔 budget/consumed');
  assert.equal(reading.rows, 1, '只有一笔带 context ⇒ 只有它参与段归因');
  assert.equal(reading.totalTokens, 180_000);
});

test('③ 窗口只统计最后 N 笔（占比按窗口合计算，不平均百分比）', () => {
  const small = { ...SEGMENTS, instructions: 0, tools: 0, history: 10_000, memory: 0, summary: 0, state: 0, now: 0, wake: 0 };
  const events = [consumed(1, SEGMENTS), consumed(2, small)];
  const all = readCostSegments(events, 0);
  assert.equal(all.rows, 2);
  assert.equal(all.totalTokens, 190_000);
  const last = readCostSegments(events, 1);
  assert.equal(last.rows, 1, '只要最后 1 笔');
  assert.equal(last.totalTokens, 10_000);
  assert.equal(last.shares.history, 1, '窗口里只剩 history 那一段 ⇒ 占比 100%');
  assert.equal(last.budgetRows, 2, 'budgetRows 仍是日志里的总数');
});

test('④ doctor 那一行只印用户点名的七段（顺序照他写的）', () => {
  const detail = costSegmentsDoctorDetail(readCostSegments([consumed(1, SEGMENTS)]));
  assert.match(detail, /^近 1 笔（末笔 180,000 tok）：/u, detail);
  assert.match(detail, /history 44\.4% \/ 此刻层 5\.6% \/ 固定块 2\.8% \/ instructions 22\.2% \/ tools 5\.6% \/ summary 13\.9% \/ wake 2\.8%$/u, detail);
  // 没有 context ⇒ 明说读不出来（不是一段 0%）
  assert.match(
    costSegmentsDoctorDetail(readCostSegments([oldConsumed(1)])),
    /没有一笔带 context ⇒ 读不出段归因/u,
  );
});

test('⑤ 报表页脚：真实 vs 估算与"估算线用到几成"分开印（可能不是同一行）', () => {
  const reading = readCostSegments([consumed(1, SEGMENTS)]);
  const lines = formatCostSegments(reading, {
    dataDir: 'D:/data',
    compaction: {
      latest: { seq: 16, turn: 9, usedRatio: 0.87 },
      real: { seq: 15, turn: 9, inputTokens: 151_204, estimatedInputTokens: 180_000 },
    },
  });
  const text = lines.join('\n');
  assert.match(text, /段归因 · D:\/data/u);
  assert.match(text, /真实 vs 估算（compaction\/decision seq 15 · turn 9）：inputTokens 151,204 \/ estimatedInputTokens 180,000 = 0\.84×/u);
  assert.match(text, /估算线用到 87\.0%（compaction\/decision seq 16 · turn 9 的 historyTokens \/ thresholdTokens）/u);
  // 没有读数时明说"还没有"，不编 0
  const empty = formatCostSegments(readCostSegments([oldConsumed(1)]));
  assert.match(empty.join('\n'), /没有一笔带 context/u);
});
