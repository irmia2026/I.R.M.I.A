/**
 * **轮内不许把"框架自己的动作"当普通输入领走** —— 记忆维护唤醒的永久消失（2026-10-11 修）。
 *
 * ──────────────────────────── 现场（逐 seq，全部可复算） ────────────────────────────
 *
 * 10-08 那一天（`_ops-light2\REPORT.md` ③）：
 *   · `seq 64021 turn/start{turn:1119}` —— 用户派的那件活开跑了；
 *   · `seq 64033/64034` —— 每日整理的 cron **在 turn 跑着的时候**到点：
 *     `timer/fired` + `wake/timer{payload:{kind:'memory-maintain'}}`；
 *   · `seq 64041 input/claimed{turn:1119, wakeSeqs:[64034]}` —— **被这一轮领走了**；
 *   · `seq 64121 turn/end{completed}` —— 正常跑完（不是崩溃）⇒ **没有任何安全网**；
 *   · `memory/maintained` 全窗口 12 条，**唯一缺的就是 `2026-10-08`**；
 *     `diary/2026-10-08.md` 在磁盘上**永久不存在**。
 * 自动 cron 10 次丢 1 次（另一次被轮内领走是 10-02 的 `seq 12349`，靠进程重启的 recover 兜住了）。
 *
 * 机制：`agent-loop.claimDeliveredInputs()` 的判据是"送进这一份请求的输入＝她看见了"，
 * 而它**只看 seq**（到没到、本 turn 记过没有），**一个字节都不看 payload**；
 * `input/claimed` 又是把唤醒从 `pending` 摘除的**唯一**写入点（`fold.ts`）。
 * 于是那条 `{kind:'memory-maintain'}` 既进了请求体（渲染成一行 `[定时器触发] <timerId>`，
 * 也就是"她看见了"——**这一半才是注意力真正被占掉的地方**），又被销了账。
 *
 * 修法（一处，判据只留一份）：`AgentLoopDeps.isFrameworkWake` —— 由 `real-loop` 注入现成的
 * `isMemoryMaintainWake`（布防 / 认领两处共用的那个函数）。命中的唤醒**不进 `fresh`**：
 * 不销账、不写 `input/claimed`、也不进请求体；它留在 `pending` 里，本 turn 结束后的下一拍
 * 由 `tickOnce` 的 `memoryMaintainWake(batch)` 正常认走、走整理（那条路一直在开轮之前）。
 *
 * ──────────────────────────── 这一份钉四件事 ────────────────────────────
 *
 *   ① **请求体里不含那行 `[定时器触发]`**（只看账不看请求体，会漏掉"她看见了"这一半）；
 *   ② **反向用例**：人的 `wake/channel` 与她**带 note** 的 timer **照旧被轮内认领**
 *      ——判据不能关过头，否则"她正看着时人插话"会一起被吞掉；
 *   ③ 该唤醒在 turn 结束后**确实被下一拍整理**（真 rig 驱动，断言出现 `memory/maintained`）；
 *   ④ 它**不再写** `input/claimed`（账上没有它，`pending` 里还有它）。
 *
 * 走**真链路**：真 EventLog + 真 fold + 真 agent-loop + 真 render + 真 RealLoop.tickOnce，
 * 只有模型是假的（`test/fixtures/real-wake-rig.ts`）。
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { makeRealWakeRig, type RealWakeRig } from './fixtures/real-wake-rig.ts';
import type { AppEvent, InputClaimed } from '../src/log/types.ts';

/** 框架布防时用的那个 payload（与 `real-loop` 的 `timers.set` 逐字同形） */
const MAINTAIN_PAYLOAD = { kind: 'memory-maintain' };

/** 轮内落一条事件的那个替身工具的名字（真装配里它会被真实执行器派发） */
const TRIGGER_TOOL = 'mid_turn_probe';

/** 一次请求的全部文本（"她这一轮看到了什么"就看它） */
function requestText(rig: RealWakeRig, index: number): string {
  const entry = rig.requests[index];
  assert.ok(entry !== undefined, `第 ${index} 次请求存在`);
  const items = entry.request.input;
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      const content = (item as { content?: unknown }).content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => String((part as { text?: unknown }).text ?? '')).join('\n');
      }
      return JSON.stringify(item);
    })
    .join('\n');
}

function allRequestText(rig: RealWakeRig): string[] {
  return rig.requests.map((_entry, index) => requestText(rig, index));
}

function claimsOf(events: readonly AppEvent[]): InputClaimed[] {
  return events.filter((event): event is InputClaimed => event.type === 'input/claimed');
}

function claimedSeqsOf(events: readonly AppEvent[]): number[] {
  return claimsOf(events).flatMap(claim => claim.data.wakeSeqs);
}

/**
 * 两拍的台子：`stream` 脚本是"第 1 步调工具、第 2 步收尾"，那件替身工具在**第 1 步执行时**
 * 落一条事件（人话 / 她自己的 timer / 框架的整理唤醒，由调用方给）。
 *
 * 为什么插事件的时机必须是"工具执行那一刻"：`claimDeliveredInputs()` 只在**下一个**
 * `runStep` 的开头跑（`agent-loop.ts` 的 `runStep` 第一件事），所以只有落在两步之间的事件
 * 才走得到那条路——生产里 10-08 那次也正是这个形状（cron 在她跑到一半时到点）。
 */
async function makeTwoStepRig(
  t: TestContext,
  makeEvent: () => AppEvent,
): Promise<{ rig: RealWakeRig; seq: () => number }> {
  let seq = 0;
  const rig = await makeRealWakeRig({
    registerTools: [{
      name: TRIGGER_TOOL,
      handler: async () => {
        seq = makeEvent().seq;
        return { content: '已落一条唤醒' };
      },
    }],
    stream: [
      { text: '我先看一眼。', toolCalls: [{ callId: 'call_probe', name: TRIGGER_TOOL, arguments: '{}' }] },
      { text: '看完了。' },
    ],
  });
  t.after(() => { rig.dispose(); });
  return { rig, seq: () => seq };
}

/** 起一轮：落一条人话唤醒，然后跑一拍（`tickOnce` 是生产定时器回调的同一份逻辑） */
async function runOneTurn(rig: RealWakeRig, seq: () => number): Promise<void> {
  rig.append('wake/manual', { note: '帮我看看日志' });
  await rig.tick();
  assert.ok(seq() > 0, `${TRIGGER_TOOL} 没被调用：这一轮没跑出第 2 步，"轮内到达"这件事就没发生`);
}

// ───────────── ① 请求体里不含那行 `[定时器触发]`；④ 它不再被 input/claimed 销账 ─────────────

test('① 轮内到达的整理唤醒：请求体里没有那行 [定时器触发]，账上也没有它', async (t) => {
  const handle = await makeTwoStepRig(t, () => handle.rig.append('wake/timer', {
    timerId: 't_maintain_probe',
    scheduledAt: '2026-02-14T02:00:00.000Z',
    firedAt: '2026-02-14T02:00:00.000Z',
    payload: MAINTAIN_PAYLOAD,
  }));
  await runOneTurn(handle.rig, handle.seq);
  const maintainSeq = handle.seq();

  // ── ① **这条最关键**：任何一份请求体里都不许有那一行 ──
  const texts = allRequestText(handle.rig);
  assert.ok(texts.length >= 2, `这一轮该跑出至少两拍，实际 ${texts.length}`);
  const sawIt = texts.filter(text => text.includes('t_maintain_probe'));
  assert.deepEqual(sawIt, [],
    '轮内到达的整理唤醒**不许进任何一份请求体**——"她看见了那行 [定时器触发]"这一半是这条 bug 的'
    + '主要代价（它正是 10-08 她自己去手动补账的起因）。见到它的请求：\n' + sawIt.join('\n---\n'));
  // 反证"请求体确实被检查过了"：本轮那条人话在请求体里（不是空输入，也不是没发请求）
  assert.ok(texts.some(text => text.includes('帮我看看日志')),
    '本轮新输入那一格该有那条人话——否则上一条断言是废话');

  // ── ④ 账上没有它 ──
  const events = await handle.rig.events();
  const claimed = claimedSeqsOf(events);
  assert.ok(!claimed.includes(maintainSeq),
    `整理唤醒不许出现在 input/claimed 里（实际认领过：${JSON.stringify(claimed)}）`);

  // ── 它还留在 pending 里（等下拍整理） ──
  assert.deepEqual(handle.rig.projection.pending.map(item => item.wakeSeq), [maintainSeq],
    '它必须留在待办里——下一拍的开轮分支才看得见它');
});

// ───────────── ② 反向用例：人的插话与她带 note 的 timer 照旧被轮内认领 ─────────────

test('② 反向：人的 wake/channel 照旧被轮内认领（判据没有关过头）', async (t) => {
  const handle = await makeTwoStepRig(t, () => handle.rig.append('wake/channel', {
    channel: 'qq-official',
    chatType: 'c2c',
    person: 'owner-openid',
    chatId: 'owner-openid',
    text: '在忙吗？我又想到一件事',
    messageId: 'm-mid-turn-1',
    msgSeq: 1,
    dedupeKey: 'm-mid-turn-1',
  }));
  await runOneTurn(handle.rig, handle.seq);
  const spokeSeq = handle.seq();
  const events = await handle.rig.events();

  const claimed = claimedSeqsOf(events);
  assert.ok(claimed.includes(spokeSeq),
    '人说的话必须照旧被轮内认领——否则"她正看着的时候人插话"会被一起吞掉'
    + `（实际认领过：${JSON.stringify(claimed)}）`);
  const texts = allRequestText(handle.rig);
  assert.ok(texts.some(text => text.includes('在忙吗？我又想到一件事')),
    `她该在请求体里看见那句话：\n${texts.join('\n---\n')}`);
  assert.deepEqual(handle.rig.projection.pending, [], '看见并认领了，就不该再留在队列里');
});

test('②-b 反向：她自己布的 timer（带 note）照旧被轮内认领', async (t) => {
  const handle = await makeTwoStepRig(t, () => handle.rig.append('wake/timer', {
    timerId: 't_her_own',
    scheduledAt: '2026-02-14T02:00:00.000Z',
    firedAt: '2026-02-14T02:00:00.000Z',
    payload: { note: '提醒我：十分钟后问她回话没有' },
  }));
  await runOneTurn(handle.rig, handle.seq);
  const timerSeq = handle.seq();
  const events = await handle.rig.events();

  const claimed = claimedSeqsOf(events);
  assert.ok(claimed.includes(timerSeq),
    '她自己的定时器（带 note）不是框架动作，必须照旧被认领'
    + `（实际认领过：${JSON.stringify(claimed)}）`);
  const texts = allRequestText(handle.rig);
  assert.ok(texts.some(text => text.includes('提醒我：十分钟后问她回话没有')),
    `那一行 note 该进请求体（这正是 at 型定时器的 payload 存在的意义）：\n${texts.join('\n---\n')}`);
  assert.deepEqual(handle.rig.projection.pending, []);
});

// ───────────── ③ turn 结束后，下一拍确实把它整理了 ─────────────

test('③ 它留在队列里，下一拍真的跑成了整理：memory/maintained 出现，且不是被循环层领走的', async (t) => {
  const handle = await makeTwoStepRig(t, () => handle.rig.append('wake/timer', {
    timerId: 't_maintain_probe',
    scheduledAt: '2026-02-14T02:00:00.000Z',
    firedAt: '2026-02-14T02:00:00.000Z',
    payload: MAINTAIN_PAYLOAD,
  }));
  await runOneTurn(handle.rig, handle.seq);
  const maintainSeq = handle.seq();

  // ── 第一拍：普通 turn（整理唤醒中途到达，留在队列里） ──
  const afterTurn = await handle.rig.events();
  assert.equal(afterTurn.filter(event => event.type === 'memory/maintained').length, 0,
    '这一拍里不该整理——整理是**下一拍**在开轮之前做的事');
  assert.deepEqual(handle.rig.projection.pending.map(item => item.wakeSeq), [maintainSeq]);

  // ── 第二拍：整理 ──
  await handle.rig.tick();
  const events = await handle.rig.events();
  const maintained = events.filter(event => event.type === 'memory/maintained');
  assert.equal(maintained.length, 1,
    '下一拍必须真的走整理，而不是把它当普通输入再领一遍（整轮事件类型：'
    + `${events.map(event => event.type).join(',')}）`);
  // 台子的时钟冻在 2026-02-14T10:00+08:00 ⇒ UTC 日期段是 02-14（与 maintainMemory 的 dayOf 同口径）
  assert.equal(maintained[0]!.data.date, '2026-02-14', '整理的日期口径与 maintainMemory 同源');

  // 它最终**恰好**被认领一次，而且那一笔不是循环层写的（`origin` 区分两条路）
  const claims = claimsOf(events).filter(claim => claim.data.wakeSeqs.includes(maintainSeq));
  assert.equal(claims.length, 1, `它最终恰好被认领一次（实际 ${claims.length} 笔）`);
  assert.notEqual(claims[0]!.origin, 'runtime/agent-loop',
    `它不该由循环层领走（实际 origin=${claims[0]!.origin}）`);
  // 那一笔与整理挂同一个 turn（`turn/start → input/claimed → memory/maintained → turn/end` 同形）
  const ownedByMaintainTurn = events.some((event) => {
    if (event.type !== 'turn/start') return false;
    return event.data.turn === claims[0]!.data.turn
      && maintained[0]!.seq > event.seq;
  });
  assert.ok(ownedByMaintainTurn, '整理那一笔的 turn 号该是它自己那个 turn/start 分配的');
  assert.deepEqual(handle.rig.projection.pending, [], '整理完就该离开队列');
});
