/**
 * 维护窗口测试 — `src/model/render.ts` 的 `maintenanceWindowOf` / `localHourOf` /
 * `lastCompactionReading` / `lastMaintenanceWindowAt`，以及 `src/model/self-brief.ts` 的常驻那句。
 *
 * ──────────────────────────── 这一版要钉的是什么 ────────────────────────────
 *
 * 用户 2026-10-11 的原话（判据的唯一出处）：
 *
 * > 「不，我的意思就是维护框架自身文档。**她自己那摊**……因为我经常发现。**她会去反复读取、
 * >  修改，每 turn 结束时都想去做。每 turn 开始时都想读**。这是不对的……**已经读入上下文的，
 * >  没必要反复去读**。**每一 turn 改，也很没必要**……**理想的情况是什么呢**。她得知
 * >  **compact 即将发生（已达 compact 线的 80%）**、**凌晨**、**长时间心跳空拍后**。才去改。
 * >  **只有需要改、无事可做的时候，才有限地去改一次**。」
 *
 * 所以这里的断言分四类，**判据优先于文案**：
 *
 *   ① **三个窗口各自在阈值处触发、阈值以下不触发**（含边界：`>=` 还是 `>` 是有意的，
 *      见 `MAINTENANCE_COMPACTION_RATIO` 等三个常量的注释）；
 *   ② **限流生效**：距上次窗口不足 6 小时，**任何**窗口都不再出那一条（三者共用一道闸）；
 *   ③ **不变量（最要紧的一条）**：没有窗口的那些轮次，**请求字节与今天逐字节相同**
 *      ——它保证这一版不会把"没窗口的日子"改坏（用户点名的那类回归）；
 *   ④ **常驻那句与信号同源**：两处用的是**同一份词表**（`MAINTENANCE_WINDOW_WORDS`），
 *      并且那句确实长在 `SELF_BRIEF` 的第 ⑦ 段里（不是新开的一节）。
 *
 * 另有一条**版本锁**：那一句进的是 `instructions`（最大公共前缀）⇒ 必须与 `RENDER_VERSION`
 * 的递增同批（本次 50 → 51）。它同时也是"这一版确实动了 instructions"的凭据。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAINTENANCE_COMPACTION_RATIO, MAINTENANCE_IDLE_TICKS, MAINTENANCE_LATE_NIGHT_FROM_HOUR,
  MAINTENANCE_LATE_NIGHT_TO_HOUR, MAINTENANCE_MIN_GAP_HOURS, RENDER_VERSION,
  lastCompactionReading, lastMaintenanceWindowAt, localHourOf, maintenanceWindowOf,
  render, type MaintenanceSignals, type RenderInput,
} from '../src/model/render.ts';
import {
  MAINTENANCE_RULE_TEXT, MAINTENANCE_WINDOW_REASONS, MAINTENANCE_WINDOW_WORDS,
  MEMORY_MAINTENANCE_RULE, SELF_BRIEF,
} from '../src/model/self-brief.ts';
import type { AppEvent } from '../src/log/types.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

/** 压缩线（现场 `persona.compactionThresholdTokens` = 100000）：阈值那一格用它算 */
const THRESHOLD = 100_000;
/** 80% 那一点：`THRESHOLD * MAINTENANCE_COMPACTION_RATIO` = 80000 */
const AT_LINE = THRESHOLD * MAINTENANCE_COMPACTION_RATIO;

/** 一个"什么都没发生"的基线信号：不在夜里、空拍为 0、历史远在压缩线之下、从没给过窗口 */
const COLD: MaintenanceSignals = {
  historyTokens: 1_000,
  compactionThresholdTokens: THRESHOLD,
  localHour: 14,
  localDay: '2026-10-12',
  idleTicks: 0,
  lastWindowAtMs: null,
};

const NOON_MS = Date.parse('2026-10-12T06:00:00.000Z'); // 本机（Asia/Shanghai）14:00
const HOUR_MS = 60 * 60 * 1000;

/** 一条 `compaction/decision` 事件（只带本测试要读的那两格 + 维护窗口那一格） */
function decisionEvent(
  seq: number,
  data: { historyTokens: number; thresholdTokens: number; windowAtMs?: number; reason?: string; day?: string },
): AppEvent {
  return {
    seq,
    ts: new Date(NOON_MS).toISOString(),
    type: 'compaction/decision',
    visibility: 'internal',
    data: {
      turn: seq,
      historyTokens: data.historyTokens,
      thresholdTokens: data.thresholdTokens,
      reason: 'threshold',
      ...(data.windowAtMs === undefined ? {} : {
        maintenanceWindow: {
          reason: data.reason ?? 'late-night',
          atMs: data.windowAtMs,
          ...(data.day === undefined ? {} : { day: data.day }),
        },
      }),
    },
  } as unknown as AppEvent;
}

/** 这一刻跑一次判据（默认基线信号 + 覆盖） */
function at(patch: Partial<MaintenanceSignals>, nowMs = NOON_MS): ReturnType<typeof maintenanceWindowOf> {
  return maintenanceWindowOf({ ...COLD, ...patch }, nowMs);
}

// ──────────────────────── ① 三个窗口：阈值处触发、以下不触发 ────────────────────────

describe('维护窗口 · 压缩临近（阈值 80%）', () => {
  test('恰好到线就触发；差一个 token 不触发（边界是有意的 `>=`）', () => {
    const on = at({ historyTokens: AT_LINE });
    assert.ok(on !== null, `到线那一点必须触发（${AT_LINE}）`);
    assert.equal(on.reason, 'compaction-soon');
    assert.ok(on.text.includes(MAINTENANCE_WINDOW_REASONS[0]), `信号里要用共享词表那个词：${on.text}`);

    assert.equal(at({ historyTokens: AT_LINE - 1 }), null, '线下一个 token 都不许触发');
    assert.equal(at({ historyTokens: 1_000 }), null, '历史很小的时候当然不触发');
  });

  test('线以上一路触发（不设上限）；阈值缺失/非法时不判（不猜）', () => {
    assert.equal(at({ historyTokens: THRESHOLD * 2 })?.reason, 'compaction-soon');
    assert.equal(at({ historyTokens: null }), null, '没有读数就不判：不许拿"大概快到了"当判据');
    assert.equal(at({ compactionThresholdTokens: null }), null);
    assert.equal(at({ compactionThresholdTokens: 0 }), null, '阈值 0 是"没配"，不是"永远到线"');
    assert.equal(at({ historyTokens: Number.NaN }), null);
  });
});

describe('维护窗口 · 凌晨（01:00–06:00，本机时间）', () => {
  test('四个边界：01:00 与 05:59 触发，00:59 与 06:00 不触发', () => {
    for (const hour of [MAINTENANCE_LATE_NIGHT_FROM_HOUR, 2, 3, 4, MAINTENANCE_LATE_NIGHT_TO_HOUR - 1]) {
      const hit = at({ localHour: hour });
      assert.equal(hit?.reason, 'late-night', `本机 ${hour} 点该给窗口`);
      assert.ok(hit!.text.includes(MAINTENANCE_WINDOW_REASONS[1]), hit!.text);
    }
    assert.equal(at({ localHour: MAINTENANCE_LATE_NIGHT_FROM_HOUR - 1 }), null, '00:59 不算凌晨（他可能还在说话）');
    assert.equal(at({ localHour: MAINTENANCE_LATE_NIGHT_TO_HOUR }), null, '06:00 起不算（该起身了）');
    assert.equal(at({ localHour: 14 }), null);
    assert.equal(at({ localHour: null }), null, '算不出本机小时就不判——绝不拿 UTC 当本机时间');
    assert.equal(at({ localHour: 24 }), null, '越界的小时不判');
  });

  test('`localHourOf` 按配置时区算（与此刻层「时刻：」同一把尺子）', () => {
    // 2026-10-12 17:30 UTC = 次日 01:30 Asia/Shanghai ⇒ 正是凌晨那一刻
    const shanghai = localHourOf('2026-10-12T17:30:00.000Z', 'Asia/Shanghai');
    assert.deepEqual(shanghai, { hour: 1, day: '2026-10-13' }, '东八区：UTC 17:30 → 本机 01:30（跨日）');
    assert.equal(at({ localHour: shanghai!.hour, localDay: shanghai!.day })?.reason, 'late-night');

    // 同一时刻在 UTC 口径下是 17 点（不是凌晨）——这一条正是"必须按本机算"的反面参照
    assert.deepEqual(localHourOf('2026-10-12T17:30:00.000Z', 'UTC'), { hour: 17, day: '2026-10-12' });
    // 算不出来（时区名非法 / now 非法）⇒ null，调用方据此不判
    assert.equal(localHourOf('2026-10-12T17:30:00.000Z', 'Not/AZone'), null);
    assert.equal(localHourOf('这不是时间', 'Asia/Shanghai'), null);
  });
});

describe('维护窗口 · 长时间空拍（6 拍）', () => {
  test('恰好 6 拍触发；5 拍不触发', () => {
    const hit = at({ idleTicks: MAINTENANCE_IDLE_TICKS });
    assert.equal(hit?.reason, 'heartbeat-idle');
    assert.ok(hit!.text.includes(MAINTENANCE_WINDOW_REASONS[2]), hit!.text);
    assert.equal(at({ idleTicks: MAINTENANCE_IDLE_TICKS - 1 }), null, '差一拍都不给（那是"午睡一会儿"）');
    assert.equal(at({ idleTicks: 40 })?.reason, 'heartbeat-idle', '更久当然也算（空拍数一路累加）');
    assert.equal(at({ idleTicks: null }), null, '没有空拍读数就不判');
    assert.equal(at({ idleTicks: -1 }), null);
    assert.equal(at({ idleTicks: Number.NaN }), null);
  });
});

describe('维护窗口 · 同一轮只出一条（顺序即优先级）', () => {
  test('三个窗口同时成立时给第一个：压缩临近 > 凌晨 > 空拍', () => {
    const all = at({ historyTokens: THRESHOLD, localHour: 3, idleTicks: 20 });
    assert.equal(all?.reason, 'compaction-soon', '压缩临近有截止线，它优先');

    const nightAndIdle = at({ historyTokens: THRESHOLD, localHour: 3, idleTicks: 20 });
    assert.equal(nightAndIdle?.text.split('维护窗口：').length - 1, 1, '同一轮只许出现一行');

    const noHistory = at({ historyTokens: null, localHour: 3, idleTicks: 20 });
    assert.equal(noHistory?.reason, 'late-night', '压缩那一条判不出来时，凌晨接上');
    const onlyIdle = at({ historyTokens: null, localHour: 14, idleTicks: 20 });
    assert.equal(onlyIdle?.reason, 'heartbeat-idle');
  });

  test('返回的 `atMs` 就是判据那一刻；`day` 只在可读时带上', () => {
    const hit = at({ localHour: 3 });
    assert.equal(hit?.atMs, NOON_MS, 'atMs 是这一条作答的时刻（那道闸的锚点）');
    assert.equal(hit?.day, '2026-10-12', '当地自然日随信号一起回，供留痕用');
    assert.equal(at({ localHour: 3, localDay: null })?.day, null, '日子读不出来就不带（不编一个）');
  });
});

// ──────────────────────────── ② 限流：三者共用一道闸 ────────────────────────────

describe('维护窗口 · 限流（三者共用 6 小时）', () => {
  const GAP_MS = MAINTENANCE_MIN_GAP_HOURS * HOUR_MS;

  test('刚给过就一个字都不加；满 6 小时才再给一条', () => {
    // 上一次窗口就在刚才（同一刻）——三个窗口全成立也不给
    const justGave = { lastWindowAtMs: NOON_MS };
    assert.equal(at({ ...justGave, historyTokens: THRESHOLD * 2 }), null, '压缩临近也得等闸');
    assert.equal(at({ ...justGave, localHour: 3 }), null, '凌晨也得等闸（每夜最多一次就是这么来的）');
    assert.equal(at({ ...justGave, idleTicks: 30 }), null, '空拍也得等闸');

    // 差一毫秒、差一小时：都不行
    assert.equal(at({ ...justGave, localHour: 3 }, NOON_MS + GAP_MS - 1), null);
    assert.equal(at({ ...justGave, localHour: 3 }, NOON_MS + HOUR_MS), null, '6 小时内第二次触碰任何窗口都不加');
    // 满了：给（这正是"每夜最多一次"的判据：夜只有 5 小时宽 < 6 小时闸）
    const allowed = at({ ...justGave, localHour: 3 }, NOON_MS + GAP_MS);
    assert.equal(allowed?.reason, 'late-night');
  });

  test('从没给过（`null`）不算拦；非法值按"没给"处理', () => {
    assert.ok(at({ lastWindowAtMs: null }) === null, '基线本身没有窗口（历史 1000 token / 14 点 / 0 拍）');
    assert.equal(at({ localHour: 3, lastWindowAtMs: null })?.reason, 'late-night', '第一次该给就给');
    assert.equal(at({ localHour: 3, lastWindowAtMs: Number.NaN })?.reason, 'late-night', 'NaN 当没给');
    assert.equal(at({ localHour: 3, lastWindowAtMs: -1 })?.reason, 'late-night', '负数当没给');
  });

  test('时钟读不出来（`nowMs` 非法）⇒ 一个字都不加', () => {
    assert.equal(at({ localHour: 3 }, Number.NaN), null);
    assert.equal(at({ idleTicks: 30 }, Number.POSITIVE_INFINITY), null);
  });
});

// ─────────────── ③ 不变量：不触发时，请求字节与"没有这一版"逐字节相同 ───────────────

/** 一份最小的 `RenderInput`（只给渲染层要的那几格；此刻层那一行是我们要看的对象） */
function renderInput(extra: Partial<RenderInput> = {}): RenderInput {
  return {
    events: [],
    persona: { identity: 'I', constitution: 'C', style: 'S', state: 'STATE', relationship: null },
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: new Date(NOON_MS).toISOString(),
    timezone: 'Asia/Shanghai',
    model: 'fake',
    lane: 'heavy',
    ...extra,
  };
}

describe('维护窗口 · 不变量（没有窗口的日子不许变）', () => {
  test('`null` / 缺省 / 空串：此刻层一行都不加 ⇒ 请求字节逐字节相同', () => {
    const absent = JSON.stringify(render(renderInput()));            // 老调用点：根本没有这一格
    const nulled = JSON.stringify(render(renderInput({ maintenanceWindow: null })));
    const alerted = JSON.stringify(render(renderInput({
      // 同一轮里另一条此刻层提示还在（STATE 超预算）：它不许被这一版碰掉
      stateBytes: 999_999, stateBudgetBytes: 8192,
    })));
    const withNullWindow = JSON.stringify(render(renderInput({
      maintenanceWindow: null, stateBytes: 999_999, stateBudgetBytes: 8192,
    })));
    assert.equal(nulled, absent, '`null` 与"没有这一格"必须逐字节相同');
    assert.equal(withNullWindow, alerted, '有别的提示时同样一个字节都不许变');

    // 空串不是"一条空的窗口"：也不出现
    const emptyText = JSON.stringify(render(renderInput({
      maintenanceWindow: { text: '   ', reason: 'late-night', atMs: NOON_MS, day: null },
    })));
    assert.equal(emptyText, absent, '空串等于没有（不写一个空行）');

    // 反面对照：真的给了窗口时，字节**必须**变（否则上面那三条可能只是因为整条路都坏了）
    const shown = JSON.stringify(render(renderInput({
      maintenanceWindow: { text: '维护窗口：凌晨（2026-10-12）——现在适合整理你自己的那些文档。',
        reason: 'late-night', atMs: NOON_MS, day: '2026-10-12' },
    })));
    assert.notEqual(shown, absent, '有窗口时必须真的多出那一行');
    assert.ok(shown.includes('维护窗口：'), '而且就是那一行');
  });

  test('判据不触发 ⇒ 渲染层那一格就是 null ⇒ 上面那条不变量自动成立', () => {
    // 这条把"判据"与"字节"接起来：COLD 那一组信号处处不满足三个窗口
    assert.equal(at({}), null);
    for (const patch of [
      { historyTokens: AT_LINE - 1 }, { localHour: 14 }, { localHour: 0 },
      { localHour: MAINTENANCE_LATE_NIGHT_TO_HOUR }, { idleTicks: MAINTENANCE_IDLE_TICKS - 1 },
    ] as Array<Partial<MaintenanceSignals>>) {
      assert.equal(at(patch), null, `这组信号不该给窗口：${JSON.stringify(patch)}`);
    }
  });
});

// ──────────────── ④ 常驻那句与信号同源（词表一处、位置一处） ────────────────

describe('维护窗口 · 常驻规则与信号同源（用户点名要的那条判据）', () => {
  test('两处共用同一份词表：信号只写命中的那一个词，且那个词出自同一份表', () => {
    assert.equal(MAINTENANCE_WINDOW_WORDS, MAINTENANCE_WINDOW_REASONS.join(' / '));
    for (const word of MAINTENANCE_WINDOW_REASONS) {
      assert.ok(MAINTENANCE_RULE_TEXT.includes(word), `常驻规则里必须点到「${word}」：两处措辞不许漂移`);
    }
    // 信号那一行写的是**命中的那一个词**（同一轮只出一条），而那个词只能从共享词表里来；
    // 三个窗口各给一次，逐条核"它写的正是词表里那一个"（不是自己另起一个说法）。
    const cases: Array<[Partial<MaintenanceSignals>, string]> = [
      [{ historyTokens: AT_LINE }, MAINTENANCE_WINDOW_REASONS[0]],
      [{ localHour: 3 }, MAINTENANCE_WINDOW_REASONS[1]],
      [{ idleTicks: MAINTENANCE_IDLE_TICKS }, MAINTENANCE_WINDOW_REASONS[2]],
    ];
    for (const [patch, word] of cases) {
      const hit = at(patch);
      assert.ok(hit !== null, `这组信号该给窗口：${JSON.stringify(patch)}`);
      assert.ok(hit!.text.startsWith(`维护窗口：${word}`), `信号必须用词表里那个词「${word}」：${hit!.text}`);
      // 其余两个理由的词不许混进来（"一条许可"不许写成"一串催促"）
      for (const other of MAINTENANCE_WINDOW_REASONS.filter(item => item !== word)) {
        assert.equal(hit!.text.includes(other), false, `没命中的理由不许出现：「${other}」`);
      }
    }
  });

  test('常驻那句的四处口径都在（不重复、不新开一节、段数照旧 18）', () => {
    assert.ok(SELF_BRIEF.includes(MAINTENANCE_RULE_TEXT), '它必须真的在装置自述里（不是只写了个常量）');
    assert.equal(SELF_BRIEF.split(MAINTENANCE_RULE_TEXT).length - 1, 1, '只许出现一次');
    assert.equal(SELF_BRIEF.split('\n\n').length, 18, '长在第 ⑦ 段里，不是新开的一节');

    const memory = SELF_BRIEF.split('\n\n').find(seg => seg.includes('你还有一份长期记忆'));
    assert.equal(memory, MEMORY_MAINTENANCE_RULE, '第 ⑦ 段就是那个常量（一处文本）');
    assert.ok(memory!.endsWith(MAINTENANCE_RULE_TEXT), '规则缀在 ⑦ 段末尾');

    // 用户那句话的五层意思，逐条落在文本里
    assert.ok(MAINTENANCE_RULE_TEXT.includes('只有你在维护'), '① 唯一维护源是她');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('别人不会去改'), '① 没有别人去改');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('已经在上下文里的，不要反复去读'), '② 读进上下文了就不必再读');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('每一轮都去改也没有意义'), '③ 每轮都改没意义');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('只在框架提示的维护窗口'), '④ 时机：维护窗口');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('或有明确变化时'), '④ 时机：或有明确变化');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('没有要改的，就不必动它'), '⑤ 不变量：没有要改的就别动');
  });

  test('这一句进的是 instructions ⇒ 必须与 `RENDER_VERSION` 的递增同批（本次 51）', () => {
    // 判据：它落在 `renderInstructions` 拼出来的那一段里（最大公共前缀）
    assert.equal(RENDER_VERSION, '51', '加了这一句就必须换代：一次设计内的全 miss');
    const rendered = render(renderInput());
    assert.ok(rendered.instructions.includes(MAINTENANCE_RULE_TEXT), 'instructions 里必须有这一句');
    assert.ok(rendered.instructions.includes(SELF_BRIEF), '而且它就是通过装置自述进去的');
    // 反面：此刻层那一行**不在** instructions 里（它逐 step 发，进冻结前缀就是每步全 miss）
    const withWindow = render(renderInput({
      maintenanceWindow: { text: '维护窗口：凌晨——现在适合整理。', reason: 'late-night', atMs: NOON_MS, day: null },
    }));
    assert.equal(withWindow.instructions, rendered.instructions, '信号一个字都不许进冻结前缀');
  });
});

// ─────────── ⑤ 留痕与限流的锚点：从日志里读得回来（重启之后仍成立） ───────────

describe('维护窗口 · 从日志读回"上一次窗口"（那道闸的锚点）', () => {
  test('只认最后一条带窗口的 `compaction/decision`；没有就是 null', () => {
    const early = decisionEvent(1, { historyTokens: 10, thresholdTokens: THRESHOLD, windowAtMs: NOON_MS - 3 * HOUR_MS });
    const mid = decisionEvent(2, { historyTokens: 20, thresholdTokens: THRESHOLD }); // 这一轮没给窗口
    const late = decisionEvent(3, { historyTokens: 30, thresholdTokens: THRESHOLD, windowAtMs: NOON_MS, day: '2026-10-12' });
    assert.equal(lastMaintenanceWindowAt([early, mid, late]), NOON_MS, '取最后一条给了窗口的');
    assert.equal(lastMaintenanceWindowAt([mid]), null, '一条都没给过 ⇒ null（第一次该给就给）');
    assert.equal(lastMaintenanceWindowAt([]), null);
    // 老日志（这一格还不存在）与非法值都当"没给"
    assert.equal(lastMaintenanceWindowAt([decisionEvent(4, { historyTokens: 1, thresholdTokens: 1 })]), null);
  });

  test('`historyTokens` / `thresholdTokens` 读的是同一条账（压缩临近与压缩判定同源）', () => {
    const a = decisionEvent(1, { historyTokens: 79_000, thresholdTokens: THRESHOLD });
    const b = decisionEvent(2, { historyTokens: 81_000, thresholdTokens: THRESHOLD });
    assert.deepEqual(lastCompactionReading([a, b]), { historyTokens: 81_000, thresholdTokens: THRESHOLD });
    assert.deepEqual(lastCompactionReading([]), { historyTokens: null, thresholdTokens: null });
    // 与判据接上：79% 不给、81% 给（同一个数，不另算一份）
    assert.equal(at({ ...lastCompactionReading([a]), localHour: 14 }), null);
    const hit = at({ ...lastCompactionReading([b]), localHour: 14 });
    assert.equal(hit?.reason, 'compaction-soon');
  });
});
