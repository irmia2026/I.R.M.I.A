/**
 * read_channel 的窗口化读取（2026-11-02）。
 *
 * 现场：28 万条日志时，带 sid 的 `read_channel` 用 `readAll()` 全量扫，单次十几秒，
 * 撞 10s 工具超时 ⇒ **必然失败**。这里钉住三点：
 *   ① 最近窗口里够 limit 条 ⇒ 与全量扫结果一致（顺序、内容、seq）；
 *   ② 目标消息在最老处、窗口内不够 ⇒ 会扩窗直到读到（扩到 from=1）；
 *   ③ `before` 游标照旧（只取 seq 更小的）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent } from '../src/log/types.js';
import { sidOf } from '../src/channel/sessions.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';

const NOW = '2026-11-02T08:00:00.000Z';

function channelEvent(seq: number, text: string, chatId = 'CHAT'): AppEvent {
  return {
    seq,
    ts: NOW,
    type: 'channel/message',
    visibility: 'model',
    data: {
      channel: 'qq-official',
      chatType: 'c2c',
      chatId,
      person: 'PERSON',
      text,
      messageId: `m-${seq}`,
      msgSeq: seq,
    },
  } as AppEvent;
}

function fillerEvent(seq: number): AppEvent {
  return {
    seq,
    ts: NOW,
    type: 'message/user',
    visibility: 'model',
    data: { text: `无关事件 ${seq}`, source: 'human' },
  } as AppEvent;
}

/** 只给 readChannelMessages 需要的那几格；别的方法不走。 */
function fakeLoop(log: EventLog): { readChannelMessages: RealLoop['readChannelMessages'] } {
  const loop = Object.create(RealLoop.prototype) as RealLoop & { deps: unknown };
  (loop as unknown as { deps: { log: EventLog } }).deps = { log };
  (loop as unknown as { flaggedNoteFor: () => null }).flaggedNoteFor = () => null;
  (loop as unknown as { prepareAimedContextImages: () => void }).prepareAimedContextImages = () => undefined;
  return loop;
}

async function fullScan(log: EventLog, sid: string): Promise<string[]> {
  const out: string[] = [];
  for await (const event of log.readAll()) {
    if (event.type !== 'channel/message' && event.type !== 'wake/channel') continue;
    const d = event.data as { channel: string; chatType: string; chatId: string; text: string };
    if (sidOf(d.channel, d.chatType, d.chatId) !== sid) continue;
    out.push(d.text);
  }
  return out;
}

test('窗口内够 limit：与全量扫一致，且扩窗能读到最老处那条', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-read-channel-window-'));
  const log = await EventLog.open(join(dir, 'events'));
  try {
    // 最老处一条目标消息 + 6000 条无关事件（超过初始窗口 5000）+ 三条近期目标消息。
    log.append(channelEvent(log.nextSeq(), '最老的那条'), { sync: true });
    for (let i = 0; i < 6000; i += 1) log.append(fillerEvent(log.nextSeq()), { sync: false });
    log.append(channelEvent(log.nextSeq(), '近期一'), { sync: true });
    log.append(channelEvent(log.nextSeq(), '近期二'), { sync: true });
    log.append(channelEvent(log.nextSeq(), '近期三'), { sync: true });
    log.flush();

    const loop = fakeLoop(log);
    const got = await loop.readChannelMessages(sidOf('qq-official', 'c2c', 'CHAT'), 10);
    assert.deepEqual(got.map((m) => m.text), ['最老的那条', '近期一', '近期二', '近期三'], '扩窗后最老那条也要在');
    assert.deepEqual(
      got.map((m) => m.seq),
      [...got.map((m) => m.seq)].sort((a, b) => a - b),
      '返回顺序必须仍是事件 seq 升序',
    );
    const expected = await fullScan(log, sidOf('qq-official', 'c2c', 'CHAT'));
    assert.deepEqual(got.map((m) => m.text), expected.slice(-10), '窗口化结果必须与全量扫一致');
  } finally {
    log.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('before 游标：只取 seq 更小的一页', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-read-channel-before-'));
  const log = await EventLog.open(join(dir, 'events'));
  try {
    const texts = ['一', '二', '三', '四'];
    const seqs: number[] = [];
    for (const text of texts) {
      const seq = log.nextSeq();
      seqs.push(seq);
      log.append(channelEvent(seq, text), { sync: true });
    }
    for (let i = 0; i < 3000; i += 1) log.append(fillerEvent(log.nextSeq()), { sync: false });
    log.flush();

    const loop = fakeLoop(log);
    const got = await loop.readChannelMessages(sidOf('qq-official', 'c2c', 'CHAT'), 2, seqs[2]);
    assert.deepEqual(got.map((m) => m.text), ['一', '二'], 'before=三 时只取前两条');
  } finally {
    log.close();
    await rm(dir, { recursive: true, force: true });
  }
});
