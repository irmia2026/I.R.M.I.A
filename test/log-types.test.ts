/**
 * 事件契约测试 — `turn/end.idleReason`（2026-10-19，纯事件层）
 *
 * 覆盖 `docs/schema.md` §2 的 TurnEnd 可选格与 `src/log/idle-reason.ts` 的读写口径：
 *   ① 有这一格的 turn/end 能写能读，字段**原样往返**；
 *   ② **老日志没有这一格** ⇒ 读侧给 null（未记录），**不报错**；
 *   ③ **未知 code** ⇒ 归 other，**note 原样保留**；
 *   ④ note 超长 ⇒ 截断到 80 字（按**码点**切，不切坏代理对）。
 *
 * 两条纪律：
 *   · 断言只认**日志字节与纯函数**，不认界面文案（"未记录"那行在 `cli-observe.test.ts` 里验）；
 *   · 每个用例一个独立临时目录——`EventLog.open` 拿写句柄，共用目录会让用例互相干扰。
 *
 * 说明：Node 的类型剥离不做 `.js` → `.ts` 映射，所以这里用显式 `.ts` 说明符导入源码；
 * tsconfig 的 include 只有 src/，测试文件由 node --test 直接执行。
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import {
  IDLE_REASON_NOTE_MAX_CHARS, idleReasonFromText, idleReasonOf, idleReasonTextOf,
} from '../src/log/idle-reason.ts';
import type { AppEvent, IdleReason, TurnEnd } from '../src/log/types.ts';
import { defaultVisibility } from '../src/log/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = '2026-10-19T09:00:00.000+08:00';

interface Fixture {
  dir: string;
  log: EventLog;
  /** 写一条事件（承诺类，与运行期同一纪律：落盘后才返回） */
  append: (type: string, data: unknown) => AppEvent;
  close: () => void;
}

async function setup(t: TestContext): Promise<Fixture> {
  const dir = tempDirSync('irmia-log-types-');
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const append = (type: string, data: unknown): AppEvent => {
    const event = {
      seq: log.nextSeq(), ts: T0, type, data, visibility: defaultVisibility(type), origin: 'test/log-types',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return event;
  };
  return { dir, log, append, close: () => log.close() };
}

/** 读回日志全部事件（open→读→close；本文件里没有第二个写者，安全） */
async function readAll(dir: string): Promise<AppEvent[]> {
  const log = await EventLog.open(join(dir, 'events'));
  try {
    const events: AppEvent[] = [];
    for await (const event of log.readAll()) events.push(event);
    return events;
  } finally {
    log.close();
  }
}

function lastTurnEnd(events: readonly AppEvent[]): TurnEnd {
  const ends = events.filter((event): event is TurnEnd => event.type === 'turn/end');
  const last = ends[ends.length - 1];
  assert.ok(last !== undefined, '日志里必须有 turn/end');
  return last;
}

// ──────────────────────────────── ① 往返 ────────────────────────────────

test('① 有 idleReason 的 turn/end：写进日志、读回来逐字段相同（原样往返）', async (t) => {
  const fx = await setup(t);
  const idle: IdleReason = { code: 'tired', note: '今天有点累，先不说话了。' };
  fx.append('turn/end', { turn: 7, reason: { kind: 'completed' }, spoke: false, idleReason: idle });
  fx.close();

  const end = lastTurnEnd(await readAll(fx.dir));
  assert.equal(end.data.turn, 7);
  assert.equal(end.data.spoke, false);
  assert.deepEqual(end.data.reason, { kind: 'completed' }, '既有字段的语义一个字都没动');
  assert.deepEqual(end.data.idleReason, idle, '日志里那一格与写进去的逐字段相同');

  // 读侧归一是**幂等**的：把日志里那一格再归一一次，还是同一格（写入侧写的就是归一之后的形状）
  assert.deepEqual(idleReasonOf(end.data.idleReason), idle);
  // 显示口径：code 的人话 + 她那句话（CLI 那一行用它）
  assert.equal(idleReasonTextOf(idle), `累了（今天有点累，先不说话了。）`);
});

// ──────────────────────────────── ② 老日志 ────────────────────────────────

test('② 老日志（没有这一格）⇒ 读侧给 null（未记录），不报错', async (t) => {
  const fx = await setup(t);
  // 旧形状逐字：spoke 之后没有任何可选格
  fx.append('turn/end', { turn: 3, reason: { kind: 'completed' }, spoke: false });
  fx.close();

  const end = lastTurnEnd(await readAll(fx.dir));
  assert.equal('idleReason' in end.data, false, '日志只增不改：老事件里就是没有这一格');
  assert.equal(idleReasonOf(end.data.idleReason), null, '缺省 = 未记录，不是"没有理由"也不是错误');
  // 各种"没有"的形态一律 null（读侧不许抛）
  assert.equal(idleReasonOf(undefined), null);
  assert.equal(idleReasonOf(null), null);
  assert.equal(idleReasonOf('tired'), null, '非对象（手工改过的日志）按未记录读，不当错误');
  assert.equal(idleReasonOf([]), null);
  assert.equal(idleReasonOf(42), null);
});

// ──────────────────────────────── ③ 未知 code ────────────────────────────────

test('③ 未知 code ⇒ 归 other，note 原样保留（日志字节不改写）', async (t) => {
  const fx = await setup(t);
  // 模拟"以后的版本写了别的 code"或"手工改过的日志"：原样落盘
  fx.append('turn/end', {
    turn: 9, reason: { kind: 'completed' }, spoke: false, idleReason: { code: 'bored', note: '今天有点累' },
  });
  fx.close();

  const end = lastTurnEnd(await readAll(fx.dir));
  // ① 日志只增不改：原始字节原样读回（写进去什么就是什么）
  assert.deepEqual(
    end.data.idleReason, { code: 'bored', note: '今天有点累' },
    '未知 code 不许被写侧/读侧偷偷改写日志',
  );
  // ② 读侧归一：未知 code 归 other，note 一个字都不丢（它是唯一的人话线索）
  assert.deepEqual(idleReasonOf(end.data.idleReason), { code: 'other', note: '今天有点累' });

  // 缺格 / 非字符串 code 同一条兜底：归 other，note 照样跟着走
  assert.deepEqual(idleReasonOf({ note: '没什么好说的' }), { code: 'other', note: '没什么好说的' });
  assert.deepEqual(idleReasonOf({ code: 42, note: '在忙' }), { code: 'other', note: '在忙' });
  assert.deepEqual(idleReasonOf({ code: 'bored' }), { code: 'other' }, '没有 note 就不写这一格');
  // 非字符串 note 不硬塞（宁可缺一格，也不把 42 存成"她那句话"）
  assert.deepEqual(idleReasonOf({ code: 'tired', note: 42 }), { code: 'tired' });
});

// ──────────────────────────────── ④ 超长 note ────────────────────────────────

test('④ note 超长 ⇒ 截断到 80 字（码点口径；读数：输入 → 落库）', async () => {
  const long = '累'.repeat(130);
  const note = idleReasonOf({ code: 'tired', note: long })?.note ?? '';
  assert.equal(Array.from(note).length, IDLE_REASON_NOTE_MAX_CHARS, `输入 ${Array.from(long).length} 字 → 落库 ${Array.from(note).length} 字`);
  assert.equal(note, '累'.repeat(80), '只截尾巴，开头一字不改');

  // 写侧同一个上限（两处共用 IDLE_REASON_NOTE_MAX_CHARS，不各写一个数）
  assert.equal(Array.from(idleReasonFromText(long).note ?? '').length, IDLE_REASON_NOTE_MAX_CHARS);

  // 按**码点**切：emoji 不许被切坏成半个代理对（与 JOB_WAKE_EXCERPT_CHARS 同一口径）
  const emoji = '🌙'.repeat(100);
  const emojiNote = idleReasonOf({ code: 'quiet_hours', note: emoji })?.note ?? '';
  assert.equal(Array.from(emojiNote).length, 80, `输入 ${Array.from(emoji).length} 个码点 → 落库 ${Array.from(emojiNote).length} 个`);
  assert.equal(emojiNote.includes('\uFFFD'), false, '没有半个代理对（替换字符）');
  assert.equal(emojiNote, '🌙'.repeat(80));

  // 压成一行：note 的读者是 `irmia tail` 的一行摘要与 grep（一条事件一行）
  assert.equal(idleReasonOf({ code: 'tired', note: '今天有点累，\n先不说话了。' })?.note, '今天有点累， 先不说话了。');
});

// ──────────────────────────────── 写侧判据 ────────────────────────────────

test('写侧：她那句话 → code（判不出来 = other，note 永远跟着走）', () => {
  const cases: readonly (readonly [string, IdleReason['code']])[] = [
    ['今天有点累，先不说话了。', 'tired'],
    ['肚子不舒服，不想开口。', 'unwell'],
    ['在忙着收尾，等下再说。', 'busy'],
    ['没什么好说的。', 'nothing_worth_saying'],
    ['等你回来再说吧。', 'waiting_for_owner'],
    ['太晚了，不吵他。', 'quiet_hours'],
    ['那棵树在窗外。', 'other'],
  ];
  for (const [text, code] of cases) {
    assert.deepEqual(idleReasonFromText(text), { code, note: text }, `${text} ⇒ ${code}`);
  }
  // 没有那句话（空/空白/根本没有）⇒ **只写 code，不编 note**
  assert.deepEqual(idleReasonFromText('  \n '), { code: 'nothing_worth_saying' });
  assert.deepEqual(idleReasonFromText(null), { code: 'nothing_worth_saying' });
  assert.deepEqual(idleReasonFromText(undefined), { code: 'nothing_worth_saying' });
});

test('这一格不进请求体：turn/end 的可见性仍是 internal（render 口径没动）', () => {
  assert.equal(defaultVisibility('turn/end'), 'internal', 'internal ⇒ 渲染层第一步就把它滤掉，不参与请求');
});
