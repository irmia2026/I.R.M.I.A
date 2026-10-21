/**
 * 空拍到**第二拍**就提醒「可以进行自我整理」（2026-10-20 用户裁决）—— 正反两面的判据
 *
 * 用户这一场的原话（逐字）：
 *
 * > 「之前**自我整理**不是要 **6 拍空拍**才触发吗，改成**第二拍空拍就提醒可以进行自我整理**吧。」
 *
 * 本文件钉的是**两条路分家之后**的形状（不许读串）：
 *
 *   · **提醒**（本文件的主角，`model/self-organize-reminder.ts` + `real-loop.ts` 的
 *     `remindSelfOrganizeIfDue`）：`wake/manual{via:'self-organize'}`，第二拍就发、
 *     一段安静期**只发一次**、有输入就重新武装；
 *   · **原来那条**（`render.ts` 的 `maintenanceWindowOf` + `MAINTENANCE_IDLE_TICKS = 6`，
 *     此刻层的「[自主时段]」那一行）：本批**一个字节没动**，判据仍在
 *     `test/maintenance-window.test.ts`（`6` 拍、六小时闸、"没有窗口时请求字节不变"）。
 *
 * ⚠ **"拍"怎么数**：不读 `projection.idleTicks`（它被每拍的 `message/assistant` 清零，
 * 现网 93% 的拍都是 1），而是数"上一次非心跳唤醒之后出现过几条 `wake/heartbeat`"
 * （`selfOrganizeTraceOf`）。所以集成用例里的心跳**一律带 `idleTicks: 1`**——那正是现网
 * `data/events` 里的形状（462 条心跳里 428 条是 1），提醒照样在第二拍响。
 *
 * 台子用 `test/fixtures/real-wake-rig.ts`（真 RealLoop + 真 agent-loop + 真折叠，只有模型是假的）
 * ——"提醒到底有没有落成一条她看得见的事件"只有这样才测得到。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppEvent } from '../src/log/types.ts';
import {
  SELF_ORGANIZE_REMINDER_TICKS,
  SELF_ORGANIZE_VIA,
  planSelfOrganizeReminder,
  selfOrganizeNote,
  selfOrganizeTraceOf,
} from '../src/model/self-organize-reminder.ts';
import { heartbeatData, makeRealWakeRig, type RealWakeRig } from './fixtures/real-wake-rig.ts';

/** 日志里那些"自我整理提醒"（按 `via` 认，与 `wake/manual` 的其余用途严格分开） */
const remindersOf = (events: readonly AppEvent[]): Array<AppEvent & { type: 'wake/manual' }> =>
  events.filter((event): event is AppEvent & { type: 'wake/manual' } =>
    event.type === 'wake/manual' && (event.data as { via?: unknown }).via === SELF_ORGANIZE_VIA);

/** 一次请求里输入那一段的全部文本（与 `heartbeat-real-wake.test.ts` 的同名函数同一口径） */
function textOfRequest(rig: RealWakeRig, index: number): string {
  const input = rig.requests[index]?.request.input;
  const items = Array.isArray(input) ? input : [];
  return items
    .map(item => {
      const content = (item as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      return Array.isArray(content)
        ? content.map(part => String((part as { text?: unknown }).text ?? '')).join('\n')
        : '';
    })
    .join('\n');
}

// ──────────────────────── 一、纯判据：阈值处的正反面 ────────────────────────

test('纯判据 · 第一拍不提醒；第二拍提醒；第三拍（已提醒过）不重复', () => {
  // ① 第一拍空拍 ⇒ 不提醒（这条是用户点名的第一个反面）
  const first = planSelfOrganizeReminder({ idleBeats: 1, remindedSinceLastInput: false });
  assert.equal(first.fired, false, '第一拍不该提醒');
  assert.equal(first.why, 'not-idle-enough');
  assert.equal(first.threshold, SELF_ORGANIZE_REMINDER_TICKS);
  assert.equal(SELF_ORGANIZE_REMINDER_TICKS, 2, '阈值就是用户要的"第二拍"（这条锁住 6 → 2 的裁决）');
  assert.equal(
    planSelfOrganizeReminder({ idleBeats: 0, remindedSinceLastInput: false }).fired, false,
    '刚开始安静（0 拍）当然不提醒',
  );

  // ② 第二拍空拍 ⇒ 提醒（正面）
  const second = planSelfOrganizeReminder({ idleBeats: SELF_ORGANIZE_REMINDER_TICKS, remindedSinceLastInput: false });
  assert.equal(second.fired, true, '第二拍必须提醒');
  assert.equal(second.why, 'fired');
  assert.equal(second.idleBeats, 2);

  // ③ 第三拍空拍 ⇒ 不重复提醒（迟滞在第一拍提醒之后就立住了）
  const third = planSelfOrganizeReminder({ idleBeats: 3, remindedSinceLastInput: true });
  assert.equal(third.fired, false, '同一段安静期里不催第二遍');
  assert.equal(third.why, 'already-reminded', '出口要能分清"还没到"与"已经说过"（事后读日志的人靠它）');
  for (const idleBeats of [4, 5, 6, 40]) {
    assert.equal(
      planSelfOrganizeReminder({ idleBeats, remindedSinceLastInput: true }).why, 'already-reminded',
      `${idleBeats} 拍也不许再发（安静期只提醒一次）`,
    );
  }
});

test('纯判据 · 拍数缺失/非法时不判（不猜）；有输入之后（迟滞清掉）第二拍重新提醒', () => {
  for (const idleBeats of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const plan = planSelfOrganizeReminder({ idleBeats, remindedSinceLastInput: false });
    assert.equal(plan.fired, false, `非法拍数不判：${String(idleBeats)}`);
    assert.equal(plan.why, 'unknown', `缺拍数不许退化成"没到拍"（那是另一个事实）：${String(idleBeats)}`);
  }
  // 有输入进来 ⇒ 迟滞那面旗被清掉（调用方从日志里读出来的事实）⇒ 新安静期的第二拍再提醒
  assert.equal(
    planSelfOrganizeReminder({ idleBeats: 2, remindedSinceLastInput: false }).fired, true,
    '上一段安静期提醒过、但这中间来过输入 ⇒ 新的一段安静期照旧提醒',
  );
});

test('文案 · 是"提醒可以整理"，不是"派活"；不写数字/频次', () => {
  const note = selfOrganizeNote();
  assert.ok(note.startsWith('【框架通报 · 可以自我整理】'),
    `开头要有来源锚（她与事后读日志的人都靠它认来源）：${note.slice(0, 40)}`);
  assert.ok(note.includes('可以进行一次自我整理'), '主体是"可以进行"，不是"去整理"');
  assert.ok(note.includes('你自己判断'), '做不做由她定（用户原话："提醒可以进行自我整理"）');
  assert.ok(note.includes('不会再催'), '明说只提醒一次，免得她把它读成一串催促');
  // 用户这一场的纪律（同 `maintenance-window.test.ts` 锁 AUTONOMOUS 那一条）：不加阀门、不写频次
  assert.equal(/\d/u.test(note), false, `文案里不许出现数字：${note}`);
  for (const banned of ['必须', '立刻', '马上', '应当']) {
    assert.equal(note.includes(banned), false, `提醒不是命令，别用"${banned}"：${note}`);
  }
});

// ──────────────────────── 二、"拍"从哪来：同一份事件快照数 ────────────────────────

/** 造一条只带判据要读的那几格的事件 */
function evt(seq: number, type: string, data: unknown = {}): AppEvent {
  return { seq, ts: new Date(Date.UTC(2026, 9, 20, 2, seq)).toISOString(), type, data, visibility: 'model' } as unknown as AppEvent;
}
const HB = (seq: number): AppEvent => evt(seq, 'wake/heartbeat', { quietSeconds: 2700, idleTicks: 1 });
const CHANNEL = (seq: number): AppEvent => evt(seq, 'wake/channel', { text: '在吗', chatType: 'c2c', chatId: '1' });
const NOTE = (seq: number, via?: string): AppEvent => evt(seq, 'wake/manual', via === undefined ? { note: '在吗' } : { note: '框架说的', via });
const REMINDER = (seq: number): AppEvent => NOTE(seq, SELF_ORGANIZE_VIA);
const ASSISTANT = (seq: number): AppEvent => evt(seq, 'message/assistant', { turn: 1, step: 1, text: '' });

test('数拍 · 只数心跳；外部事件清零；她的`message/assistant`不清零（现网那个坑的反面）', () => {
  assert.deepEqual(
    selfOrganizeTraceOf([CHANNEL(1), HB(2)]),
    { idleBeats: 1, remindedSinceLastInput: false },
    '有人说过话之后的第一拍',
  );
  assert.deepEqual(
    selfOrganizeTraceOf([CHANNEL(1), HB(2), HB(3)]),
    { idleBeats: 2, remindedSinceLastInput: false },
    '两拍空拍（提醒该在这一拍响）',
  );
  // **这个坑必须被钉住**：`message/assistant` 每拍都写一条（含沉默轮），若它清零，
  // 拍数就永远是 1 —— 那条 6 拍判据在现网一直不响就是它（见模块文件头的实测）。
  assert.deepEqual(
    selfOrganizeTraceOf([CHANNEL(1), HB(2), ASSISTANT(3), HB(4)]),
    { idleBeats: 2, remindedSinceLastInput: false },
    '她的 message/assistant 不清零空拍数（否则拍数永远是 1）',
  );
  // 她自己排的定时器 / 后台回执 / 用户打字 —— 都算"这一拍不空"
  for (const [seq, event] of [
    [5, evt(5, 'wake/timer', { timerId: 't1', scheduledAt: 'x', firedAt: 'y' })],
    [5, evt(5, 'wake/job', { jobId: 'j1' })],
    [5, NOTE(5)],
  ] as const) {
    assert.equal(
      selfOrganizeTraceOf([CHANNEL(1), HB(2), HB(3), event]).idleBeats, 0,
      `非心跳唤醒该清零空拍数：${event.type}（seq ${seq}）`,
    );
  }
});

test('数拍 · 自己那条提醒不算"外部事件"（否则每两拍又提醒一次）', () => {
  const withReminder = [CHANNEL(1), HB(2), HB(3), REMINDER(4)];
  assert.deepEqual(
    selfOrganizeTraceOf(withReminder),
    { idleBeats: 2, remindedSinceLastInput: true },
    '提醒落库之后：拍数不回零（它还在同一段安静期里），旗子翻成"提醒过"',
  );
  assert.deepEqual(
    selfOrganizeTraceOf([...withReminder, HB(5)]),
    { idleBeats: 3, remindedSinceLastInput: true },
    '第三拍：拍数继续涨，但迟滞挡住第二条',
  );
  // 真正的输入进来之后，两件事一起复位
  assert.deepEqual(
    selfOrganizeTraceOf([...withReminder, HB(5), NOTE(6)]),
    { idleBeats: 0, remindedSinceLastInput: false },
    '有输入进来 ⇒ 拍数清零 + 重新武装（下一段安静期的第二拍会再提醒）',
  );
});

// ──────────────────────── 三、整条链路上：四次读数 ────────────────────────

test('整条链路 · ①第一拍不提醒 ②第二拍提醒一次 ③第三拍不重复 ④有输入清零', async (t) => {
  // 六拍各一次 heavy 调用（空 turns 也要发请求：心跳是真实唤醒）；light 一次都不该问。
  // ⚠ 心跳 payload 里的 `idleTicks` **一律 1**（现网形状）：判据要的是日志里数出来的拍数。
  const rig = await makeRealWakeRig({ stream: Array.from({ length: 7 }, () => ({ text: '', toolCalls: [] })) });
  t.after(rig.dispose);

  // ── ① 第一拍空拍：不提醒 ──
  rig.append('wake/heartbeat', heartbeatData(2700, 1));
  await rig.tick();
  {
    const events = await rig.events();
    assert.equal(remindersOf(events).length, 0, '第一拍一个字节都不发');
    assert.equal(rig.requests.length, 1, '心跳那一拍照旧真发一次请求（这是既有口径，不是本次新增）');
    assert.equal(
      textOfRequest(rig, 0).includes('可以自我整理'), false,
      '第一拍的请求体里不许出现这条提醒',
    );
  }

  // ── ② 第二拍空拍：提醒一次（事件 + 内容 + 与心跳同轮） ──
  rig.append('wake/heartbeat', heartbeatData(5400, 1));
  await rig.tick();
  {
    const events = await rig.events();
    const reminders = remindersOf(events);
    assert.equal(reminders.length, 1, `第二拍必须恰好一条提醒（实测 ${reminders.length} 条）`);
    const reminder = reminders[0]!;
    assert.equal(reminder.visibility, 'model', '它必须是她看得见的事件（internal 就等于没说）');
    assert.equal(String(reminder.data.note), selfOrganizeNote(), '正文逐字与纯模块一致（同一处措辞）');

    assert.equal(rig.requests.length, 2, '提醒与心跳**同一轮**：不多花一次请求（这是"同轮"的直接证据）');
    const text = textOfRequest(rig, 1);
    assert.ok(text.includes('【框架通报 · 可以自我整理】'), `那一条提醒必须真的进她的请求体：${text.slice(0, 200)}`);
    assert.ok(text.includes('心跳自省'), '同一轮里那条心跳唤醒也要在（否则就不是"同轮"，而是多起了一轮）');

    // 同轮的直接凭据：那一轮认领了 **两条** 唤醒（心跳 + 提醒）
    const claimed = events.filter(event => event.type === 'input/claimed').at(-1);
    assert.equal(claimed?.data.wakeSeqs.length, 2, `那一轮该认领两条唤醒（实测 ${String(claimed?.data.wakeSeqs.length)}）`);
    assert.equal(rig.projection.pending.length, 0, '两条都被认领出队，没有留下"下一拍再来一次"的尾巴');

    // 留痕：一行，说清拍数与来源（事后读日志能回答"这一条为什么发"）
    const logged = rig.lines.filter(line => line.includes('可以进行自我整理'));
    assert.equal(logged.length, 1, `留痕该恰好一行：${JSON.stringify(logged)}`);
    assert.ok(logged[0]!.includes(SELF_ORGANIZE_VIA), `留痕要带来源：${logged[0]!}`);
    assert.ok(logged[0]!.includes('2 拍'), `留痕要带拍数（判据用的那个数）：${logged[0]!}`);
  }

  // ── ③ 第三拍空拍：不重复提醒 ──
  rig.append('wake/heartbeat', heartbeatData(8100, 1));
  await rig.tick();
  {
    const events = await rig.events();
    assert.equal(remindersOf(events).length, 1, '第三拍不许再来一条（迟滞在第一拍提醒之后就立住了）');
    assert.equal(rig.requests.length, 3);
    // 那一条提醒仍在**可见历史**里（它进了第二拍的请求体，之后每轮都要重发——这是既有口径），
    // 所以这里数**出现次数**：第三拍恰好一次（历史里的那一份），不许再多出一条新的。
    const occurrences = textOfRequest(rig, 2).split('【框架通报 · 可以自我整理】').length - 1;
    assert.equal(occurrences, 1, `第三拍只该有历史里的那一份，不许重复提醒（实测 ${occurrences} 份）`);
  }

  // ── ④ 有输入进来：空拍计数清零 ──
  rig.append('wake/manual', { note: '在吗' });
  await rig.tick();
  {
    assert.equal(rig.projection.idleTicks, 0, '有人说话 ⇒ 投影的空拍数归零（既有折叠口径，本批没动它）');
    assert.deepEqual(
      selfOrganizeTraceOf(await rig.events()),
      { idleBeats: 0, remindedSinceLastInput: false },
      '本判据用的"拍数"与迟滞也一起清零/重新武装',
    );
    assert.equal(remindersOf(await rig.events()).length, 1, '输入本身不该顺手补一条提醒');
  }

  // ── ④b 新的一段安静期：第一拍不提醒，第二拍重新提醒（"清零"不是"用完了"） ──
  rig.append('wake/heartbeat', heartbeatData(2700, 1));
  await rig.tick();
  assert.equal(remindersOf(await rig.events()).length, 1, '新安静期的第一拍不提醒');

  rig.append('wake/heartbeat', heartbeatData(5400, 1));
  await rig.tick();
  {
    const reminders = remindersOf(await rig.events());
    assert.equal(reminders.length, 2, `新安静期的第二拍该再提醒一次（实测 ${reminders.length} 条）`);
    const seqs = reminders.map(event => event.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, '两条提醒按时间先后排列');
  }
});

// ──────────────────────── 四、与原来那条（六拍 + 此刻层）互不干扰 ────────────────────────

test('隔离 · 本次没有动 `render.ts` 那条 6 拍判据（它仍由 maintenance-window 的用例钉着）', async () => {
  // 这一条不是"测旧代码"，而是把**两条路分家**这件事钉在用例里：`render.ts` 的导出里
  // `MAINTENANCE_IDLE_TICKS` 仍然是 6（本批没碰），而新提醒的阈值是另一个模块里的 2。
  const render = await import('../src/model/render.ts');
  assert.equal(render.MAINTENANCE_IDLE_TICKS, 6, '原来那条 6 拍判据一个字没动（本批的硬边界）');
  // v72（2026-10-20，用户整段置换自述 + 三处描述）把它递到了 **72**；本批（`b12d517`）落地时
  // 它是 **71**——**本批没有递版本**这条事实不变（判据：那一笔不动请求前缀）。
  // v73（2026-10-20，思维链全量回传）把它递到了 **73**；v74（2026-10-20，400 的**形状**那一批：
  // 组内顺序 + 孤儿正文 + 唤醒钉位 + 发前断言）递到 **74**；v75（2026-10-21，**驱逐改阶梯制 +
  // 边界按本轮开头冻结**）递到 **75**；v77（2026-10-21，**一步多调用不再被回执切断**）递到 **77**
  // —— 全都与这一条（6 拍判据）无关：
  // 这个数只是"当前是哪一代模板"，换代之后这里要跟着改（改的理由必须是"换了一代"）。
  assert.equal(render.RENDER_VERSION, '77',
    '当前这一代是 v77（多调用段的 fc 连发那一批递的）；本批（b12d517）落地时是 71，没递');
  assert.equal(SELF_ORGANIZE_REMINDER_TICKS, 2);
  assert.notEqual(render.MAINTENANCE_IDLE_TICKS, SELF_ORGANIZE_REMINDER_TICKS,
    '两个数服务两条路，故意不同（见新模块文件头）');
});
