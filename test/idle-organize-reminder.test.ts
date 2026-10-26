/**
 * 空拍提醒「可以进行自我整理」：**第 2 拍一次、第 5 拍再一次、之后不再提**（2026-10-22 用户裁决）
 *
 * 用户这一场的原话（逐字）：
 *
 * > 「**自我整理提示**：连续两次空拍后提示一次，然后，再过三个空拍再提示一次，
 * >  **然后就不提示了**。」
 *
 * 上一版（2026-10-20）是"一段安静期只提醒一次"——但**只要中间来过一次输入就重新武装**，
 * 于是在没人理她的长夜里变成了每两拍一次（2026-10-22 03:16 又冒出一条）。这一版把它改成
 * **两道、然后闭嘴**：
 *
 *   · 连续 **2** 拍空拍 ⇒ 第 1 次提示；
 *   · 此后**再连续 3 拍**（累计 **5**）⇒ 第 2 次提示；
 *   · 之后**本段安静期不再提示**（第 3 次永不出现）；
 *   · **插一次真实往来**（任一条非心跳唤醒）⇒ 计数与"已提示两次"一起归零，下一次从 2 拍起算。
 *
 * 本文件钉的是**两条路分家之后**的形状（不许读串）：
 *
 *   · **提醒**（本文件的主角，`model/self-organize-reminder.ts` + `real-loop.ts` 的
 *     `remindSelfOrganizeIfDue`）：`wake/manual{via:'self-organize'}`，2/5 各发一次；
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
  SELF_ORGANIZE_MAX_REMINDERS,
  SELF_ORGANIZE_REMINDER_TICKS,
  SELF_ORGANIZE_SECOND_AFTER_TICKS,
  SELF_ORGANIZE_SECOND_TICKS,
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

// ──────────────────────── 一、纯判据：两段式的正反面 ────────────────────────

test('纯判据 · 2 拍第 1 次；再 3 拍（累计 5）第 2 次；再 10 拍 0 次', () => {
  // ① 前 1 拍不提醒（第一道门槛是 2）
  for (const idleBeats of [0, 1]) {
    const plan = planSelfOrganizeReminder({ idleBeats, remindedCount: 0 });
    assert.equal(plan.fired, false, `${idleBeats} 拍不该提醒`);
    assert.equal(plan.why, 'not-idle-enough');
    assert.equal(plan.threshold, SELF_ORGANIZE_REMINDER_TICKS);
  }
  assert.equal(SELF_ORGANIZE_REMINDER_TICKS, 2, '第一道就是用户要的"连续两次空拍"');
  assert.equal(SELF_ORGANIZE_SECOND_AFTER_TICKS, 3, '第二道是"再过三个空拍"');
  assert.equal(SELF_ORGANIZE_SECOND_TICKS, 5, '累计门槛 = 2 + 3（只有一处算式）');
  assert.equal(SELF_ORGANIZE_MAX_REMINDERS, 2, '一段安静期最多两次（第 3 次永不出现）');

  // ② 第 2 拍 ⇒ 第 1 次提醒
  const first = planSelfOrganizeReminder({ idleBeats: 2, remindedCount: 0 });
  assert.equal(first.fired, true, '第二拍必须提醒');
  assert.equal(first.why, 'fired');
  assert.equal(first.reminderIndex, 1);
  assert.equal(first.threshold, 2);

  // ③ 第 3、4 拍 ⇒ 不提醒（还没到第二道）
  for (const idleBeats of [3, 4]) {
    const plan = planSelfOrganizeReminder({ idleBeats, remindedCount: 1 });
    assert.equal(plan.fired, false, `${idleBeats} 拍不该提醒（第二道要等累计 5 拍）`);
    assert.equal(plan.why, 'not-idle-enough');
    assert.equal(plan.threshold, 5, '此时判的是第二道门槛');
  }

  // ④ 第 5 拍 ⇒ 第 2 次提醒
  const second = planSelfOrganizeReminder({ idleBeats: 5, remindedCount: 1 });
  assert.equal(second.fired, true, '第五拍必须再提醒一次');
  assert.equal(second.why, 'fired');
  assert.equal(second.reminderIndex, 2);
  assert.equal(second.threshold, 5);

  // ⑤ 之后再 10 拍 ⇒ **0 次**（第三道永不出现）
  for (let idleBeats = 6; idleBeats <= 15; idleBeats += 1) {
    const plan = planSelfOrganizeReminder({ idleBeats, remindedCount: 2 });
    assert.equal(plan.fired, false, `${idleBeats} 拍不许再提醒（已经两次了）`);
    assert.equal(plan.why, 'already-reminded', '出口要能分清"还没到"与"说完了"（事后读日志的人靠它）');
    assert.equal(plan.reminderIndex, 0);
  }
});

test('纯判据 · 拍数缺失/非法时不判（不猜）；跨拍跳变也只在门槛处发一次', () => {
  for (const idleBeats of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const plan = planSelfOrganizeReminder({ idleBeats, remindedCount: 0 });
    assert.equal(plan.fired, false, `非法拍数不判：${String(idleBeats)}`);
    assert.equal(plan.why, 'unknown', `缺拍数不许退化成"没到拍"（那是另一个事实）：${String(idleBeats)}`);
  }
  // 日志里连着三条心跳一起被看到（拍数从 3 跳到 6）：第二道在 6 这一拍补上，且只补一次
  const jumped = planSelfOrganizeReminder({ idleBeats: 6, remindedCount: 1 });
  assert.equal(jumped.fired, true);
  assert.equal(jumped.reminderIndex, 2);
  // "已提示两次"这面旗在拍数非法时也照样先判（闭嘴优先于拍数）
  const closed = planSelfOrganizeReminder({ idleBeats: 9, remindedCount: 2 });
  assert.equal(closed.why, 'already-reminded');
});

test('文案 · 两份都是"提醒可以整理"；第 2 份明说这是最后一次；不许有 Markdown / 数字', () => {
  const first = selfOrganizeNote(1);
  const second = selfOrganizeNote(2);

  for (const [label, note] of [['第 1 次', first], ['第 2 次', second]] as const) {
    assert.ok(note.startsWith('【框架通报 · 可以自我整理】'),
      `${label}：开头要有来源锚（她与事后读日志的人都靠它认来源）：${note.slice(0, 40)}`);
    assert.ok(note.includes('可以进行一次自我整理'), `${label}：主体是"可以进行"，不是"去整理"`);
    assert.ok(note.includes('你自己判断'), `${label}：做不做由她定（用户原话："提醒可以进行自我整理"）`);
    // 用户这一场的纪律（同 `maintenance-window.test.ts` 锁 AUTONOMOUS 那一条）：不加阀门、不写频次
    assert.equal(/\d/u.test(note), false, `${label}：文案里不许出现数字：${note}`);
    // 2026-10-22 硬性要求：界面上不渲染 Markdown，`**` 会原样显示成星号
    assert.equal(/\*\*/u.test(note), false, `${label}：正文里不许出现 Markdown 记号：${note}`);
    for (const banned of ['必须', '立刻', '马上', '应当']) {
      assert.equal(note.includes(banned), false, `${label}：提醒不是命令，别用"${banned}"：${note}`);
    }
  }

  // 两份的差别只有"这是第几次"那两句：第一份**预告**还会再提一次，第二份**明说不再催**
  assert.ok(first.includes('会再提醒你一次'), `第 1 次要预告后面还有一次：${first}`);
  assert.ok(second.includes('不会再催'), `第 2 次要说清这是最后一次：${second}`);
  assert.notEqual(first, second, '两份正文不许共用（否则第 2 次会说成"还会再提醒"，那是假话）');
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
    { idleBeats: 1, remindedCount: 0 },
    '有人说过话之后的第一拍',
  );
  assert.deepEqual(
    selfOrganizeTraceOf([CHANNEL(1), HB(2), HB(3)]),
    { idleBeats: 2, remindedCount: 0 },
    '两拍空拍（第 1 次提醒该在这一拍响）',
  );
  // **这个坑必须被钉住**：`message/assistant` 每拍都写一条（含沉默轮），若它清零，
  // 拍数就永远是 1 —— 那条 6 拍判据在现网一直不响就是它（见模块文件头的实测）。
  assert.deepEqual(
    selfOrganizeTraceOf([CHANNEL(1), HB(2), ASSISTANT(3), HB(4)]),
    { idleBeats: 2, remindedCount: 0 },
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

test('数拍 · 自己那条提醒不算"外部事件"：拍数不回零，只把已提示次数抬一', () => {
  const withFirst = [CHANNEL(1), HB(2), HB(3), REMINDER(4)];
  assert.deepEqual(
    selfOrganizeTraceOf(withFirst),
    { idleBeats: 2, remindedCount: 1 },
    '第 1 次提醒落库之后：拍数不回零（它还在同一段安静期里），已提示 1 次',
  );
  assert.deepEqual(
    selfOrganizeTraceOf([...withFirst, HB(5), HB(6)]),
    { idleBeats: 4, remindedCount: 1 },
    '第 3、4 拍：拍数继续涨，已提示次数不动',
  );
  // 第 5 拍：同一份快照里再落一条提醒（调用点就是在这一拍落的）⇒ 已提示 2 次
  assert.deepEqual(
    selfOrganizeTraceOf([...withFirst, HB(5), HB(6), REMINDER(7)]),
    { idleBeats: 4, remindedCount: 2 },
    '第 2 次提醒落库之后：拍数照旧，已提示 2 次',
  );
  // 再 10 拍：已提示次数封顶在 2（第 3 次不许出现；真出现了也只按"两次"算）
  const long = [...withFirst, REMINDER(7)];
  for (let seq = 8; seq <= 17; seq += 1) long.push(HB(seq));
  assert.deepEqual(
    selfOrganizeTraceOf(long),
    { idleBeats: 12, remindedCount: 2 },
    '长空拍里已提示次数封顶（拍数照涨，提示不再增加）',
  );
});

test('数拍 · 插一次真实往来 ⇒ 拍数与"已提示两次"一起归零（下一次从 2 拍重新开始）', () => {
  const quiet = [CHANNEL(1), HB(2), HB(3), REMINDER(4), HB(5), HB(6), REMINDER(7), HB(8)];
  assert.deepEqual(
    selfOrganizeTraceOf(quiet),
    { idleBeats: 5, remindedCount: 2 },
    '安静期的形状：五拍空拍、两次都提示过了',
  );
  assert.deepEqual(
    selfOrganizeTraceOf([...quiet, NOTE(9)]),
    { idleBeats: 0, remindedCount: 0 },
    '用户打字 ⇒ 拍数与已提示次数一起归零（"真实往来"的判据）',
  );
  assert.deepEqual(
    selfOrganizeTraceOf([...quiet, HB(9), CHANNEL(10)]),
    { idleBeats: 0, remindedCount: 0 },
    '通道里有人说话 ⇒ 同样归零',
  );
  // 归零之后重新走一遍：第 2 拍第 1 次、第 5 拍第 2 次
  const restart = [...quiet, NOTE(9)];
  assert.equal(planSelfOrganizeReminder(selfOrganizeTraceOf([...restart, HB(10)])).fired, false);
  const revived = planSelfOrganizeReminder(selfOrganizeTraceOf([...restart, HB(10), HB(11)]));
  assert.equal(revived.fired, true);
  assert.equal(revived.reminderIndex, 1, '新安静期从"第 1 次"重新开始（不是接着第 3 次）');
});

// ──────────────────────── 三、整条链路上：两段式 ────────────────────────

test('整条链路 · ①第 2 拍第 1 次 ②第 3/4 拍不重复 ③第 5 拍第 2 次 ④之后不再提 ⑤真实往来后重新起算', async (t) => {
  // 每一拍空 turn 也要发一次 heavy 请求（心跳是真实唤醒）；light 一次都不该问。
  // ⚠ 心跳 payload 里的 `idleTicks` **一律 1**（现网形状）：判据要的是日志里数出来的拍数。
  const rig = await makeRealWakeRig({ stream: Array.from({ length: 14 }, () => ({ text: '', toolCalls: [] })) });
  t.after(rig.dispose);

  // ── ① 第 1 拍空拍：不提醒 ──
  rig.append('wake/heartbeat', heartbeatData(2700, 1));
  await rig.tick();
  assert.equal(remindersOf(await rig.events()).length, 0, '第一拍一个字节都不发');
  assert.equal(rig.requests.length, 1, '心跳那一拍照旧真发一次请求（这是既有口径，不是本次新增）');
  assert.equal(textOfRequest(rig, 0).includes('可以自我整理'), false, '第一拍的请求体里不许出现这条提醒');

  // ── ② 第 2 拍空拍：第 1 次提醒（事件 + 内容 + 与心跳同轮） ──
  rig.append('wake/heartbeat', heartbeatData(5400, 1));
  await rig.tick();
  {
    const reminders = remindersOf(await rig.events());
    assert.equal(reminders.length, 1, `第二拍必须恰好一条提醒（实测 ${reminders.length} 条）`);
    const reminder = reminders[0]!;
    assert.equal(reminder.visibility, 'model', '它必须是她看得见的事件（internal 就等于没说）');
    assert.equal(String(reminder.data.note), selfOrganizeNote(1), '正文逐字与纯模块一致（同一处措辞）');

    assert.equal(rig.requests.length, 2, '提醒与心跳**同一轮**：不多花一次请求（这是"同轮"的直接证据）');
    const text = textOfRequest(rig, 1);
    assert.ok(text.includes('【框架通报 · 可以自我整理】'), `那一条提醒必须真的进她的请求体：${text.slice(0, 200)}`);
    assert.ok(text.includes('心跳自省'), '同一轮里那条心跳唤醒也要在（否则就不是"同轮"，而是多起了一轮）');
    assert.equal(text.includes('**'), false, '请求体里那一段提醒不许带 Markdown 记号');

    // 同轮的直接凭据：那一轮认领了 **两条** 唤醒（心跳 + 提醒）
    const claimed = (await rig.events()).filter(event => event.type === 'input/claimed').at(-1);
    assert.equal(claimed?.data.wakeSeqs.length, 2, `那一轮该认领两条唤醒（实测 ${String(claimed?.data.wakeSeqs.length)}）`);
    assert.equal(rig.projection.pending.length, 0, '两条都被认领出队，没有留下"下一拍再来一次"的尾巴');

    // 留痕：一行，说清第几次与门槛（事后读日志能回答"这一条为什么发"）
    const logged = rig.lines.filter(line => line.includes('可以进行自我整理'));
    assert.equal(logged.length, 1, `留痕该恰好一行：${JSON.stringify(logged)}`);
    assert.ok(logged[0]!.includes(SELF_ORGANIZE_VIA), `留痕要带来源：${logged[0]!}`);
    assert.ok(logged[0]!.includes('第 1 次'), `留痕要带第几次：${logged[0]!}`);
    assert.ok(logged[0]!.includes('2 拍'), `留痕要带判据用的拍数：${logged[0]!}`);
  }

  // ── ③ 第 3、4 拍：不重复（第一道之后要再等三拍才到第二道） ──
  for (const beats of [3, 4]) {
    rig.append('wake/heartbeat', heartbeatData(2700 * beats, 1));
    await rig.tick();
    assert.equal(remindersOf(await rig.events()).length, 1, `第 ${beats} 拍不许再来一条（第二道要等累计 5 拍）`);
  }

  // ── ④ 第 5 拍：第 2 次提醒（正文换成了"这是最后一次"） ──
  rig.append('wake/heartbeat', heartbeatData(13_500, 1));
  await rig.tick();
  {
    const reminders = remindersOf(await rig.events());
    assert.equal(reminders.length, 2, `第五拍该有第二条提醒（实测 ${reminders.length} 条）`);
    assert.equal(String(reminders[1]!.data.note), selfOrganizeNote(2), '第 2 次的正文逐字与纯模块一致');
    assert.ok(String(reminders[1]!.data.note).includes('不会再催'), '第 2 次必须说清这是最后一次');
    assert.equal(textOfRequest(rig, 4).includes('又安静了三拍'), true, '第 2 次的正文真的进了这一拍的请求体');
  }

  // ── ⑤ 之后三拍：不再提醒（第 3 次永不出现） ──
  for (const beats of [6, 7, 8]) {
    rig.append('wake/heartbeat', heartbeatData(2700 * beats, 1));
    await rig.tick();
    assert.equal(remindersOf(await rig.events()).length, 2, `${beats} 拍也不许再发（一段安静期只有两次）`);
  }
  {
    // 历史里那两份提醒仍在请求体里（既有口径：历史每轮重发），所以数**出现次数**：
    // 第 8 拍恰好两份（历史里的），不许再多出一条新的。
    const occurrences = textOfRequest(rig, 7).split('【框架通报 · 可以自我整理】').length - 1;
    assert.equal(occurrences, 2, `第 8 拍只该有历史里的那两份（实测 ${occurrences} 份）`);
  }

  // ── ⑥ 真实往来：拍数与已提示次数一起清零 ──
  rig.append('wake/manual', { note: '在吗' });
  await rig.tick();
  {
    assert.equal(rig.projection.idleTicks, 0, '有人说话 ⇒ 投影的空拍数归零（既有折叠口径，本批没动它）');
    assert.deepEqual(
      selfOrganizeTraceOf(await rig.events()),
      { idleBeats: 0, remindedCount: 0 },
      '本判据用的"拍数"与已提示次数也一起清零',
    );
    assert.equal(remindersOf(await rig.events()).length, 2, '输入本身不该顺手补一条提醒');
  }

  // ── ⑦ 新的一段安静期：第 1 拍不提醒，第 2 拍重新提醒第 1 次 ──
  rig.append('wake/heartbeat', heartbeatData(2700, 1));
  await rig.tick();
  assert.equal(remindersOf(await rig.events()).length, 2, '新安静期的第一拍不提醒');

  rig.append('wake/heartbeat', heartbeatData(5400, 1));
  await rig.tick();
  {
    const reminders = remindersOf(await rig.events());
    assert.equal(reminders.length, 3, `新安静期的第二拍该再提醒一次（实测 ${reminders.length} 条）`);
    const seqs = reminders.map(event => event.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, '三条提醒按时间先后排列');
    assert.equal(String(reminders[2]!.data.note), selfOrganizeNote(1), '新安静期重新从第 1 次的正文开始');
  }
});

// ──────────────────────── 四、与原来那条（六拍 + 此刻层）互不干扰 ────────────────────────

test('隔离 · 本次没有动 `render.ts` 那条 6 拍判据（它仍由 maintenance-window 的用例钉着）', async () => {
  // 这一条不是"测旧代码"，而是把**两条路分家**这件事钉在用例里：`render.ts` 的导出里
  // `MAINTENANCE_IDLE_TICKS` 仍然是 6（本批没碰），而新提醒的门槛是另一个模块里的 2 / 5。
  const render = await import('../src/model/render.ts');
  assert.equal(render.MAINTENANCE_IDLE_TICKS, 6, '原来那条 6 拍判据一个字没动（本批的硬边界）');
  // v72（2026-10-20，用户整段置换自述 + 三处描述）把它递到了 **72**；本批（`b12d517`）落地时
  // 它是 **71**——**本批没有递版本**这条事实不变（判据：那一笔不动请求前缀）。
  // v73（2026-10-20，思维链全量回传）把它递到了 **73**；v74（2026-10-20，400 的**形状**那一批：
  // 组内顺序 + 孤儿正文 + 唤醒钉位 + 发前断言）递到 **74**；v75（2026-10-21，**驱逐改阶梯制 +
  // 边界按本轮开头冻结**）递到 **75**；v77（2026-10-21，**一步多调用不再被回执切断**）递到 **77**
  // —— 全都与这一条（6 拍判据）无关：
  // 这个数只是"当前是哪一代模板"，换代之后这里要跟着改（改的理由必须是"换了一代"）。
  // v78（2026-10-22，**关系档案从整篇注入改成索引**：路径 / 字数 / 小节名；正文不进上下文、
  // 也不给读取指令）
  // 递到 **78**——同样与这一条（6 拍判据）无关：这个数只是"当前是哪一代模板"，
  // 换代之后这里要跟着改（改的理由必须是"换了一代"）。
  // v79（2026-10-23，**`http_get` 换正文抽取器 + 三句失败诊断 + 截断报真实总量**）：
  // 动的是 `tools` 段（描述字节）与工具回执文本，与 6 拍判据同样无关，换代照旧递增。
  // v80（2026-10-23，**`read_channel` 翻页一页的条数 50 → 15**）：动的是 `tools` 段里那两个参数描述
  // （`before` / `limit` 里逐字的页大小），与 6 拍判据同样无关，换代照旧递增。
  assert.equal(render.RENDER_VERSION, '80',
    '当前这一代是 v80（read_channel 翻页一页的条数 50→15 那一批递的）；本批（A/B/C 三件）落地时是 71，没递');
  assert.equal(SELF_ORGANIZE_REMINDER_TICKS, 2, '第一道：第 2 拍');
  assert.equal(SELF_ORGANIZE_SECOND_TICKS, 5, '第二道：累计第 5 拍');
  assert.equal(SELF_ORGANIZE_MAX_REMINDERS, 2, '一段安静期最多两次');
  assert.notEqual(render.MAINTENANCE_IDLE_TICKS, SELF_ORGANIZE_REMINDER_TICKS,
    '两个数服务两条路，故意不同（见新模块文件头）');
});
