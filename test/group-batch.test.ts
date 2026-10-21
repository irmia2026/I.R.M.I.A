/**
 * 群消息攒批门测试 — src/runtime/group-batch.ts
 *
 * 判据是纯函数，所以这里不需要搭循环：直接喂 pending + 事件表 + 时刻，
 * 把「私聊每句都看、群聊攒够再看」与四种不攒的情形逐条钉死。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { AppEvent, PendingInput } from '../src/log/types.js';
import { holdsGroupBatch } from '../src/runtime/group-batch.ts';

const WINDOW_MS = 3 * 60_000;
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

/** 造一个 wake/channel 事件（只填判据用到的字段） */
function channelEvent(seq: number, chatType: string, ts: string): AppEvent {
  return {
    seq, ts, type: 'wake/channel', visibility: 'model', origin: 'test/group-batch',
    data: { channel: 'qq-official', chatType, chatId: 'c1', person: 'p1', messageId: `m${seq}`, msgSeq: seq, text: 'x' },
  } as unknown as AppEvent;
}

function pending(...seqs: number[]): PendingInput[] {
  return seqs.map(seq => ({ wakeSeq: seq, source: 'channel' as const, claimCount: 0 }));
}

function gate(p: PendingInput[], events: AppEvent[], windowMs = WINDOW_MS): boolean {
  const bySeq = new Map(events.map(e => [e.seq, e]));
  return holdsGroupBatch({
    pending: p,
    getEvent: (seq) => bySeq.get(seq) ?? null,
    nowMs: NOW,
    windowMs,
  });
}

describe('群消息攒批门', () => {
  test('群聊消息刚进来：攒着（未到窗口）', () => {
    const events = [channelEvent(1, 'group-at', minutesAgo(0.5))];
    assert.equal(gate(pending(1), events), true);
  });

  test('群聊消息在窗口里攒着：到点就放行', () => {
    const events = [channelEvent(1, 'group-at', minutesAgo(3.5))];
    assert.equal(gate(pending(1), events), false, '超过窗口就不该再压着');
  });

  test('最早一条到点即放行，哪怕后面还有新消息', () => {
    const events = [
      channelEvent(1, 'group-at', minutesAgo(4)),
      channelEvent(2, 'group-at', minutesAgo(0.2)),
    ];
    assert.equal(gate(pending(1, 2), events), false);
  });

  test('单聊：每句都及时看，不攒', () => {
    const events = [channelEvent(1, 'c2c', minutesAgo(0.1))];
    assert.equal(gate(pending(1), events), false);
  });

  test('群里混进一条单聊：立即放行（私聊优先，不被人拖着）', () => {
    const events = [
      channelEvent(1, 'group-at', minutesAgo(1)),
      channelEvent(2, 'c2c', minutesAgo(0.1)),
    ];
    assert.equal(gate(pending(1, 2), events), false);
  });

  test('窗口配成 0：不攒，每条都唤醒', () => {
    const events = [channelEvent(1, 'group-at', minutesAgo(0.1))];
    assert.equal(gate(pending(1), events, 0), false);
  });

  test('队列里有非通道来源的唤醒：不攒（定时器/意图那些事不该被群消息拖住）', () => {
    const events = [channelEvent(1, 'group-at', minutesAgo(0.5))];
    const mixed: PendingInput[] = [
      ...pending(1),
      { wakeSeq: 2, source: 'timer', claimCount: 0 },
    ];
    assert.equal(gate(mixed, events), false);
  });

  test('取不到事件或不是通道唤醒：不攒（宁可多起一个 turn，也不把消息压在窗口里）', () => {
    assert.equal(gate(pending(99), [channelEvent(1, 'group-at', minutesAgo(0.5))]), false);
    const wrongType = {
      seq: 1, ts: minutesAgo(0.5), type: 'wake/timer', visibility: 'model', origin: 'x',
      data: { timerId: 't1', scheduledAt: minutesAgo(0.5) },
    } as unknown as AppEvent;
    assert.equal(gate(pending(1), [wrongType]), false);
  });

  test('时间戳全坏：不攒', () => {
    assert.equal(gate(pending(1), [channelEvent(1, 'group-at', 'not-a-time')]), false);
  });

  test('队列为空：不攒（没有要等的消息）', () => {
    assert.equal(gate([], []), false);
  });

  test('将来的 group（全量模式）走同一道攒批门', () => {
    const events = [channelEvent(1, 'group', minutesAgo(0.5))];
    assert.equal(gate(pending(1), events), true);
    const late = [channelEvent(1, 'group', minutesAgo(9))];
    assert.equal(gate(pending(1), late), false);
  });
});
