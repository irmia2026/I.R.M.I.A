/**
 * 界面插话真的能打断她正在说的那半截话（2026-10-03 用户截图那轮）
 *
 * 事故形状（`data/events` 里 turn 345 step 2 的真实序列，17:38）：
 *   `tool/call`(speak, 17:38:26.425) → 气泡 seq 15491/15493/15495（17:38:33.7/44.6/52.6）
 *   → **用户插话** `wake/manual` seq 15497（17:38:54.986）
 *   → 气泡照旧继续 seq 15499…15509（17:38:59.9 … 17:39:31.9）
 *   → `tool/result`(17:39:31.887, durationMs 65461)
 * 也就是说：人插话之后，她**又说了六条**，工具卡一直显示「运行中」直到自己走完。
 *
 * 根因不是 speak 里没有打断（`ctx.interruptEpoch` 那套一直在，`test/admin-pwsh.test.ts`
 * 也一直绿），而是**那条计数在界面这条路线上从来没有被推动过**：
 * `noteUserSpoke` 只挂在 `RealLoop.wake()`（WakeSink 的正门）上，而界面聊天框是 Web 层
 * 直接 `appendSync('wake/manual')` 落库的——于是计数不动、判据读到的永远是"没人开口"。
 * 全量日志的取证结论（430 次 speak、112 条界面插话）：界面插话撞上 speak 的 13 次里
 * 打断生效 **0** 次；QQ/通道插话撞上 speak 的 45 次里生效 43 次。也就是说这条缝**从没接上过**，
 * 不是最近被哪次改动弄坏的（`src/web/server.ts` 在 git 历史里从未碰过 `interruptEpoch`）。
 *
 * 这份用例走**真 HTTP 路由 + 真 EventLog + 真投影**，把那条缝钉住。两条方向都测：
 *   • 接上通报口 → 插话之后剩下的气泡一条都不发（已发的不受影响）；
 *   • 摘掉通报口 → 应发的段**一条不少全发**（复现事故。这条是回归哨兵：缝再被撕开就会红）。
 *
 * 夹具使用四个自然句末，验证投递中断而不是旧版逗号分段规则。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { AppEvent, Projection } from '../src/log/types.js';
import { defaultVisibility, emptyProjection } from '../src/log/types.ts';
import { applyOne, finalizePressure } from '../src/state/fold.ts';
import { createAdminTools, setSleepForTest, SPEAK_TEXT_MAX } from '../src/tools/admin.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';

const TEST_TOKEN = 'test-token-0123456789abcdef';

const HER_SEGMENTS = ['第一句内容已经足够完整。', '第二句内容也已经足够完整。',
  '第三句内容还是足够完整。', '第四句内容同样足够完整。'];
const HER_SPEECH = HER_SEGMENTS.join('');
const expectedSegments = HER_SEGMENTS.length;
assert.ok([...HER_SPEECH].length <= SPEAK_TEXT_MAX);

interface Rig {
  dir: string;
  dataDir: string;
  log: EventLog;
  projection: Projection;
  server: WebServer;
  base: string;
  /** 界面那条消息落库时该拿到的 seq（通报口收到的 wakeSeq） */
  notified: Array<{ seq: number; type: string }>;
  /**
   * 「有人插话」计数——**只由通报口推动**（就是被测的那条缝）。
   *
   * 为什么不让用例自己加一：那样测的是"计数变了 speak 会不会停"（`admin-pwsh.test.ts`
   * 已经管了），而不是"界面那条消息会不会把计数推动起来"。后者才是这次坏掉的东西。
   * 复现事故（摘掉通报口）时这个计数一直是 0——所以应发的段会全发出去，与 17:38 那轮一模一样。
   */
  epoch(): number;
  readAll(): Promise<AppEvent[]>;
}

/**
 * 起一台真 Web 服务 + 一条真事件日志。
 *
 * `withNotify` 就是被测的那条接线：有它 = `main.ts` 现在给 WebServerDeps 装上的东西；
 * 没有它 = 事故当时的样子（Web 层自己 appendSync，没人通报循环层）。
 * `/dream` 那条唤醒**故意不接**这个口（它的 note 是框架拼的指令，不是人说的话），
 * 所以这里也不测它。
 */
async function rig(t: TestContext, withNotify: boolean): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-speak-wire-'));
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });

  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const notified: Array<{ seq: number; type: string }> = [];
  let epoch = 0;
  const timers = new TimerStore(join(dataDir, 'timers.json'));

  const server = await startWebServer({
    log,
    projection,
    config: defaultConfig(dir),
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers,
    now: () => new Date(),
    uiToken: TEST_TOKEN,
    port: 0,
    out: () => undefined,
    ...(withNotify
      ? {
        noteUserSpoke: (seq: number, type: string) => {
          notified.push({ seq, type });
          // 真实装配里循环层在同一刻把计数加一（见 RealLoop.noteUserSpokeEvent）
          epoch += 1;
        },
      }
      : {}),
  });

  t.after(async () => {
    await server.close();
    log.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  });

  return {
    dir,
    dataDir,
    log,
    projection,
    server,
    base: server.url(),
    notified,
    epoch: () => epoch,
    readAll: async () => {
      const out: AppEvent[] = [];
      for await (const event of log.readAll()) out.push(event);
      return out;
    },
  };
}

/** 界面聊天框那条路：POST /api/commands/wake（与 gui/lib/pages/chat_page.dart 同一条） */
async function uiWake(base: string, note: string): Promise<{ seq: number; status: number }> {
  const response = await fetch(`${base}/api/commands/wake`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  const body = await response.json() as { seq?: number };
  return { seq: body.seq ?? 0, status: response.status };
}

/**
 * 让 speak 真的跑一遍，并在**第二条气泡落库之后**从界面插一句话进来。
 *
 * 为什么在 `emit` 里就地发起那一次 fetch：那两行 emit 是同步的，之后 speak 才 `await`
 * 下一段的打字等待——于是这一次 fetch 与那条等待**真正并发**，正是事故的形状
 * （她的气泡一条条往外冒的时候，用户的消息到了）。
 *
 * 打字等待换成"等那条界面消息真的落库"而不是立即返回：真实装配里那条 HTTP 要走一个来回，
 * 而 speak 正好在那段时间里"打着字"。换成立即返回的话，判据会在通报到达之前就被读一遍，
 * 用例测到的就不是这条缝，而是机器有多快。等它有上限（2s），超时照旧往下走——
 * 摘掉通报口的那条回归用例正是靠这个上限跑完所有段。
 */
async function speakWhileOwnerInterrupts(
  rig: Rig,
  opts: { notify: boolean; wakeSeq: number | null },
): Promise<{
  content: string;
  bubbles: string[];
  /** 界面那条消息落库时，已经冒出去几条气泡（复现时 = 2，即第三条随并发一起出去） */
  bubblesWhenOwnerSpoke: number;
  wake: { seq: number; status: number } | null;
}> {
  const wkRef: { value: { seq: number; status: number } | null } = { value: null };
  /** 界面那条消息是**什么时候**发出去的——只有这段时间里的等待才需要等它落地 */
  let wakeFired = false;
  let signaled: (() => void) | null = null;
  const landed = new Promise<void>((resolve) => { signaled = resolve; });
  const bubbles: string[] = [];
  let bubblesWhenOwnerSpoke = -1;

  const waitForLanded = async (): Promise<void> => {
    for (let i = 0; i < 400 && wkRef.value === null; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  };

  const tools = createAdminTools({
    timers: new TimerStore(null),
    emit: (type, data) => {
      if (type !== 'message/assistant') return;
      bubbles.push((data as { text: string }).text);
      if (bubbles.length === 2 && !wakeFired) {
        wakeFired = true;
        void uiWake(rig.base, '和我的私聊是私有的，没关系')
          .then((result) => { wkRef.value = result; })
          .catch(() => { wkRef.value = { seq: 0, status: 0 }; })
          .finally(() => { signaled?.(); });
      }
    },
    personaRoot: join(rig.dataDir, 'persona'),
    speakTyping: { typingEffect: true, charsPerMinute: 90 },
    userSpoke: () => ({ text: '和我的私聊是私有的，没关系', wakeSeq: opts.wakeSeq ?? 0 }),
  });

  const ctx: ToolContext = {
    callId: 'call_wire_speak',
    turn: 345,
    step: 2,
    signal: new AbortController().signal,
    workspaceRoot: rig.dataDir,
    // 计数**只**来自通报口（rig 的 noteUserSpoke）：这条缝断了它就不动，
    // speak 会照旧把应发的段说完——正是事故当时的样子。
    interruptEpoch: rig.epoch,
    claimInterruption: () => {},
  };

  /**
   * 打字等待：**只在那条界面消息在飞的时候**等它落地，其余一律立即返回。
   *
   * 为什么必须这样分：一次 speak 的等待是切成 100ms 小片轮的（`SPEAK_INTERRUPT_POLL_MS`），
   * 一段十来个字要轮七十多次。每一片都去等两秒的话，这条用例要跑几分钟——那不是被测行为，
   * 是把注入点用错了。真正需要的只有"插话到达与下一段判据之间"这一段真实的往返时间：
   * 少了它，用例测的就变成机器有多快，而不是这条缝通不通。
   */
  setSleepForTest(async () => {
    if (opts.notify && wakeFired && wkRef.value === null) {
      if (bubblesWhenOwnerSpoke < 0) bubblesWhenOwnerSpoke = bubbles.length;
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      await Promise.race([landed, timeout]);
      await waitForLanded();
      return;
    }
    // 其余一律只让出一次事件循环：不是"等多久"，而是"插话到达与下一段判据之间有一次让出"
    // ——真实装配里那段时间被七十来片 100ms 的等待填满，这里用不着把七十次都睡满。
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  });
  try {
    const result = await tools.byName('speak').handler({ text: HER_SPEECH }, ctx);
    await waitForLanded();
    if (bubblesWhenOwnerSpoke < 0) bubblesWhenOwnerSpoke = bubbles.length;
    return { content: result.content, bubbles, bubblesWhenOwnerSpoke, wake: wkRef.value };
  } finally {
    setSleepForTest(null);
  }
}

test('界面插话打断她正在说的那半截话：已发的不受影响，没发的一条都不发', async (t) => {
  const r = await rig(t, true);
  const out = await speakWhileOwnerInterrupts(r, { notify: true, wakeSeq: 15497 });

  assert.ok(out.wake !== null && out.wake.status === 200, '界面那条消息必须真的落库（200）');
  assert.equal(r.notified.length, 1, '通报口被调了一次（就是界面那条 wake/manual）');
  assert.equal(r.notified[0]!.seq, out.wake!.seq, '通报的 seq 必须是**刚落的这条事件**：销账靠它');
  assert.equal(r.notified[0]!.type, 'wake/manual');

  assert.equal(out.bubblesWhenOwnerSpoke, 2, '用户开口时她刚说出第二条（事故那轮的形状）');
  // 已经出去的是**开头那几段**（顺序与分段都照旧；`bubblesWhenOwnerSpoke === 2` 本身也钉住了
  // "它至少冒过两条"，所以这一条不是空断言）。
  assert.deepEqual(
    out.bubbles,
    HER_SEGMENTS.slice(0, out.bubbles.length),
    '分段与顺序照旧：出去的就是那句原话的开头几段',
  );
  // 第三条是并发那一刻正在发的那一条（收不回来）；再往后一条都不许出去。
  // 允许"第三条之后又冒了一条"是如实留给时序的：判据在**每段开头**才被读一次，
  // 插话若正好落在那一读之后，正在打的那一条仍会出去——这与"不撤回已发"是同一条口径。
  assert.ok(
    out.bubbles.length <= out.bubblesWhenOwnerSpoke + 2,
    `插话之后最多再出去一条，实际出去了 ${out.bubbles.length - out.bubblesWhenOwnerSpoke} 条：`
    + out.bubbles.join('／'),
  );
  assert.ok(
    out.bubbles.length < expectedSegments,
    `插话必须落在发言中途：应发 ${expectedSegments} 段，实际已经全发完了 ${out.bubbles.length} 条`,
  );
  assert.match(out.content, /发言被打断：他刚说「和我的私聊是私有的，没关系」。/);
  assert.match(out.content, new RegExp(`已经发出去的（收不回来了）：${out.bubbles.length} 条`));
  assert.match(
    out.content,
    new RegExp(`没来得及发的（${expectedSegments - out.bubbles.length} 条）：1\\. `),
  );
});

test('回归哨兵：摘掉通报口就是事故当时的样子——人插话之后她照旧把应发的段说完', async (t) => {
  // 这条不是"测旧代码"，是把**缝**钉在用例里：`WebServerDeps.noteUserSpoke` 一旦被摘掉
  // （或者 main.ts 忘了接），这里立刻红——而那正是 17:38 那轮的表现。
  const r = await rig(t, false);
  const out = await speakWhileOwnerInterrupts(r, { notify: false, wakeSeq: 15497 });

  assert.deepEqual(r.notified, [], '没接通报口：没人被通知');
  // 判据是"**应发的段一条不少**"，不是"必须切成九条"：段数由 expectedSegments 按实现算出来，
  // 这样分段规则以后怎么变，这条哨兵测的都还是"插话拦不住她"这件事本身。
  assert.equal(
    out.bubbles.length,
    expectedSegments,
    `应发的 ${expectedSegments} 段一条不少全出去——这正是用户截图里看到的"她没停下来"`,
  );
  assert.deepEqual(out.bubbles, HER_SEGMENTS, '逐段原文和标点都保留');
  assert.ok(!out.content.includes('被打断'), `回执也不该说被打断：${out.content}`);
  assert.match(out.content, /发言已处理/, '照旧是"处理完了"的正常回执');
});

test('非人开口的事件不推计数：/dream 之外的计时器、意图、后台任务都不算插话', async (t) => {
  const r = await rig(t, true);
  // 用真路由的另一种写命令触发一条**不是** wake/manual 的事件：timer 取消（internal）
  const response = await fetch(`${r.base}/api/commands/timer-cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ timerId: 'tim_nonexistent' }),
  });
  assert.ok(response.status === 200 || response.status === 404, `路由可用即可，状态 ${response.status}`);
  assert.deepEqual(r.notified, [], '只有人开口的那几种唤醒才通报，别的一律不推计数');
});
