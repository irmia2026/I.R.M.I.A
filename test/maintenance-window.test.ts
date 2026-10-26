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
 * **v53（2026-10-12）另加两类，判据一个字没动、只动了文案分档**（用户：「夜间空拍不必太过
 * 在意消耗」·「主动联系不设频次」·「不要加什么阀门」·「只设计提示词，不要增加新的框架机制」）：
 *
 *   ⑤ **同一行两档**（`maintenanceWindowLine`）：压缩临近 ⇒ 照旧"维护窗口：压缩临近……
 *      现在适合整理你自己的那些文档"；**夜里（凌晨）与长时间空拍 ⇒ 「自主时段」那一段**
 *      （`AUTONOMOUS`，逐字锁在本文件里）。两档共用同一行、同一道闸、同一条"同一轮只出一条"
 *      ——不是两条信号（这一条正面钉着，见 ②b 那三条用例）。
 *   ⑥ **文案纪律**：那一段里**不许有数字**（配额/频次/时段都靠数字说话），也不许出现
 *      阀门式字样（每天/一次/最多/禁止/先存草稿/非紧急不发……）。
 *
 * 另有一条**版本锁**：那一句进的是 `instructions`（最大公共前缀）⇒ 必须与 `RENDER_VERSION`
 * 的递增同批（v51 落它，v55 是当前代——v55 是"timer 的 `payload` 三格约定"那一段加进 ⑦ 段）。
 * 它同时也是"这一版确实动了 instructions"的凭据。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAINTENANCE_COMPACTION_RATIO, MAINTENANCE_IDLE_TICKS, MAINTENANCE_LATE_NIGHT_FROM_HOUR,
  MAINTENANCE_LATE_NIGHT_TO_HOUR, MAINTENANCE_MIN_GAP_HOURS, NOW_LAYER_BANNER, RENDER_VERSION,
  lastCompactionReading, lastMaintenanceWindowAt, localHourOf, maintenanceWindowOf,
  render, type MaintenanceSignals, type RenderInput,
} from '../src/model/render.ts';
import {
  AGENDA_USAGE_TEXT, ASSISTANT_STANCE_TEXT, CLOSER_TEXT, DEMANDS_AND_LINES_TEXT,
  FRAMEWORK_DEFAULT_TEXT, LIFE_TOGETHER_TEXT,
  MAINTENANCE_RULE_TEXT, MAINTENANCE_WINDOW_REASONS, MAINTENANCE_WINDOW_WORDS,
  MEMORY_MAINTENANCE_RULE, MEMORY_PURPOSE_TEXT, NO_CATCHPHRASE_TEXT, PAYLOAD_SHAPE_TEXT,
  REAL_RETREAT_TEXT, ROLE_TEXT, SCHEDULING_TEXT, SELF_BRIEF, VOICE_LAYER_TEXT,
} from '../src/model/self-brief.ts';
import type { AppEvent } from '../src/log/types.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

/** 压缩线（现场 `persona.compactionThresholdTokens` = 100000）：阈值那一格用它算 */
const THRESHOLD = 100_000;
/** 80% 那一点：`THRESHOLD * MAINTENANCE_COMPACTION_RATIO` = 80000 */
const AT_LINE = THRESHOLD * MAINTENANCE_COMPACTION_RATIO;

/**
 * **「自主时段」那一档的正文，逐字抄自用户 2026-10-12 的草稿**（v53）。
 *
 * 为什么在测试里再抄一遍、而不是 import `render.ts` 那个常量：这一条是**文案锁**——
 * 两边各写一份，谁改了哪边都会红。import 进来就变成"拿实现断言实现"，改一个字也照样绿。
 * 口径与既有的 `维护窗口：…` 那一句同源（下面"不变量"那一段里也是逐字写的）。
 *
 * **v70（P1-04）只加了一格字段名**：正文前面那五个字 `维护窗口：`。它不是这句话的一部分，
 * 而是此刻层的**行首标签**（`nowFieldsOf` 认标签 ⇒ 这一行第 2 步起才不再重发）。
 * 所以下面分成两格：`AUTONOMOUS_BODY` 是**正文**（v53 的逐字草稿，一个字节没动），
 * `AUTONOMOUS` 是它在那一刻层里的**整行**（标签 + 正文）。
 */
const AUTONOMOUS_BODY = [
  '[自主时段] 现在没人打扰你，这是你自己的时间。可以考虑做些事，包括但不限于：',
  '复盘今天（发生了什么事、他今天怎么样、你应过什么）· 想更远的事（你和他要一起做成什么、',
  '有什么建议值得给他）· 只是想说句话——不必等到有事。',
  '资源不用省，你觉得该做就做；但要有产出：写进你自己的文件，或者说给他听。',
  '没有新东西、没有实际进展，就到此为止——不必为了显得忙而继续。',
].join('\n');

/** 那一刻层里的**整行**：v70 起带行首标签（正文原样跟在后面） */
const AUTONOMOUS = `维护窗口：${AUTONOMOUS_BODY}`;

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
      // v53：夜里那一档**不再说"维护窗口"**，说的是「自主时段」（逐字，见本文件顶部 AUTONOMOUS）
      assert.equal(hit!.text, AUTONOMOUS, `夜里那一档就是「自主时段」那一段：${hit!.text}`);
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
    // v53：空拍那一档与夜里**同一档文案**（「自主时段」），不是"维护窗口"那一句
    assert.equal(hit!.text, AUTONOMOUS, hit!.text);
    assert.equal(at({ idleTicks: MAINTENANCE_IDLE_TICKS - 1 }), null, '差一拍都不给（那是"午睡一会儿"）');
    assert.equal(at({ idleTicks: 40 })?.reason, 'heartbeat-idle', '更久当然也算（空拍数一路累加）');
    assert.equal(at({ idleTicks: null }), null, '没有空拍读数就不判');
    assert.equal(at({ idleTicks: -1 }), null);
    assert.equal(at({ idleTicks: Number.NaN }), null);
  });
});

// ────────── ②b 两档文案（v53）：只有压缩临近还讲"整理文档"，夜里/空拍是「自主时段」 ──────────

describe('维护窗口 · 两档文案（v53：同一行两档，不是两条；v70：2/3 档补行首标签）', () => {
  test('压缩临近 ⇒ 旧那一句（含词表里那个词）；夜里/空拍 ⇒ 「自主时段」那一段', () => {
    const compaction = at({ historyTokens: AT_LINE });
    assert.ok(compaction!.text.startsWith(`维护窗口：${MAINTENANCE_WINDOW_REASONS[0]}`),
      `压缩临近照旧用词表里那个词：${compaction!.text}`);
    assert.ok(compaction!.text.includes('现在适合整理你自己的那些文档'), '而且仍是原来那一句');
    for (const patch of [{ localHour: 3 }, { idleTicks: MAINTENANCE_IDLE_TICKS }] as Array<Partial<MaintenanceSignals>>) {
      const hit = at(patch);
      assert.equal(hit!.text, AUTONOMOUS, `这一档该换成「自主时段」：${JSON.stringify(patch)}`);
      // v53 的口径落在**正文**上：换过档的这一行正文不许再讲"维护窗口"那件事
      assert.equal(AUTONOMOUS_BODY.includes('现在适合整理你自己的那些文档'), false, '也不许把旧文案留在后面');
      // v70（P1-04）：整行必须以行首标签开头——那是"第 2 步起不发"的唯一开关
      assert.equal(hit!.text.startsWith('维护窗口：'), true, `2/3 档也要有行首标签：${hit!.text.slice(0, 20)}`);
    }
  });

  test('用户这一场定的纪律（逐条落在字节上）：没有数字、没有频次配额、没有时段禁令', () => {
    // 判据是用户的原话：「不要加什么阀门」「主动联系不设频次」「只设计提示词，不要增加新的框架机制」。
    // 这一条锁的是**文案本身**不许长回成一套配额表——它比"读起来像不像"硬：出现数字就红。
    assert.equal(/\d/u.test(AUTONOMOUS), false, '这一段里不许出现任何数字（配额/频次/时段都靠数字说话）');
    for (const banned of ['每天', '每周', '一次', '次数', '最多', '至少', '不得超过', '禁止', '不许',
      '仅限', '只做一件', '先存草稿', '非紧急不发', '冷却', '间隔']) {
      assert.equal(AUTONOMOUS.includes(banned), false, `这一段不许出现阀门式字样：「${banned}」`);
    }
    // 三条**该在**的口径（用户点名保留的两条 + 这一版的落点）
    assert.ok(AUTONOMOUS.includes('包括但不限于'), '用户原话：只说"可以考虑做些事，包括但不限于"');
    assert.ok(AUTONOMOUS.includes('没有新东西、没有实际进展，就到此为止'), '保留"没有新进展就停"（防反刍）');
    assert.ok(AUTONOMOUS.includes('写进你自己的文件'), '要有产出：落盘或说给他听');
  });

  test('同一行：渲染出来的此刻层里那段只出现一次（不许变成两条信号）', () => {
    const text = nowLayerText({
      maintenanceWindow: { text: AUTONOMOUS, reason: 'late-night', atMs: NOON_MS, day: '2026-10-12' },
    });
    assert.equal(text.split('[自主时段]').length - 1, 1, '同一轮只许出现一行');
    // v70（P1-04）：这一档现在是**行首 `维护窗口：[自主时段] …`**——标签是字段名，
    // 正文仍是 v53 那段（"维护窗口"这四个字在**正文**里照旧不出现，落点是下面这一条）。
    assert.ok(text.includes('\n维护窗口：[自主时段] '), `2/3 档必须带行首标签：\n${text}`);
    assert.equal(AUTONOMOUS_BODY.includes('维护窗口'), false, '正文里照旧没有"维护窗口"这四个字');
    assert.equal(text.includes('现在适合整理你自己的那些文档'), false, '也不许把压缩那一档的正文串进来');
    // 反面参照：压缩临近那一档仍走老文案（两档是**同一个字段**的两种取值）
    const compaction = nowLayerText({
      maintenanceWindow: { text: `维护窗口：${MAINTENANCE_WINDOW_REASONS[0]}——现在适合整理。`,
        reason: 'compaction-soon', atMs: NOON_MS, day: null },
    });
    assert.equal(compaction.includes('[自主时段]'), false, '压缩临近那一轮不许出现"自主时段"');
    // ⚠ 此处**只在"此刻层"这一条 item 上判**：`instructions` 里那两条常驻规则本来就写着
    // "维护窗口"（`MAINTENANCE_RULE_TEXT`），拿整份渲染结果判会把它误当成信号。
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

/** 从一次渲染结果里取**此刻层那一条 item** 的正文（按段头认层，不按索引——与 render 自己一致） */
function nowLayerText(extra: Partial<RenderInput> = {}): string {
  const items = render(renderInput(extra)).input;
  for (const item of Array.isArray(items) ? items : []) {
    const content = (item as { content?: unknown }).content;
    if (typeof content === 'string' && content.includes(NOW_LAYER_BANNER)) return content;
  }
  return '';
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
    // v53 起这里用**夜里那一档的真实文案**（`AUTONOMOUS`）——反面参照要与生产同形状。
    const shown = JSON.stringify(render(renderInput({
      maintenanceWindow: { text: AUTONOMOUS, reason: 'late-night', atMs: NOON_MS, day: '2026-10-12' },
    })));
    assert.notEqual(shown, absent, '有窗口时必须真的多出那一行');
    assert.ok(shown.includes('[自主时段]'), '而且就是那一行');
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
    // v53 起**只有压缩临近那一档**还写那个词（夜里/空拍换成「自主时段」，见上面 ②b），
    // 所以下面按档分别核：压缩那一档核"它写的正是词表里那一个"，另两档核"它换成了哪一段"。
    const cases: Array<[Partial<MaintenanceSignals>, string]> = [
      [{ historyTokens: AT_LINE }, MAINTENANCE_WINDOW_REASONS[0]],
      [{ localHour: 3 }, MAINTENANCE_WINDOW_REASONS[1]],
      [{ idleTicks: MAINTENANCE_IDLE_TICKS }, MAINTENANCE_WINDOW_REASONS[2]],
    ];
    for (const [patch, word] of cases) {
      const hit = at(patch);
      assert.ok(hit !== null, `这组信号该给窗口：${JSON.stringify(patch)}`);
      if (hit!.reason === 'compaction-soon') {
        assert.ok(hit!.text.startsWith(`维护窗口：${word}`), `信号必须用词表里那个词「${word}」：${hit!.text}`);
        // 其余两个理由的词不许混进来（"一条许可"不许写成"一串催促"）
        for (const other of MAINTENANCE_WINDOW_REASONS.filter(item => item !== word)) {
          assert.equal(hit!.text.includes(other), false, `没命中的理由不许出现：「${other}」`);
        }
        continue;
      }
      assert.equal(hit!.text, AUTONOMOUS, `这一档是「自主时段」：${JSON.stringify(patch)}`);
      for (const other of MAINTENANCE_WINDOW_REASONS) {
        assert.equal(hit!.text.includes(other), false, `换档之后理由词一个都不许出现：「${other}」`);
      }
    }
  });

  test('常驻那句的四处口径都在（v61：口径搬进新稿 §6；旧容器退场但常量仍自洽）', () => {
    // ⚠ **v61（2026-10-12）**：用户手写稿**逐字置换**了 `SELF_BRIEF` ⇒ 旧的 ⑦ 段容器
    // （`MEMORY_MAINTENANCE_RULE`）**不再进装置自述**，维护口径按新稿落进它的 **§6**。
    // 这条锁**按新正文重锚**（不是放宽）：① 口径逐句核新稿；② 旧容器自身仍自洽（其它用例/审计
    // 还引用它）；③ "旧句不许回到前缀里"也一并钉住。
    assert.ok(SELF_BRIEF.includes('框架自身的文档'), '① 文档只有她在维护（新稿 §6 的原话）');
    assert.ok(SELF_BRIEF.includes('已经在上下文里的不要反复读'), '② 读进上下文了就不必再读');
    assert.ok(SELF_BRIEF.includes('只在框架提示的维护窗口'), '③ 时机：只在框架提示的维护窗口');
    // v62：用户这一句改过——"没要改的就不动"与他加的"或有明确变化时"**都被他删掉了**，
    // 换成了"实时变化都在当前上下文窗口内 / 每一轮都读写是浪费"。所以第 ④ 条按**新原文**锁：
    assert.ok(SELF_BRIEF.includes('每一轮都进行读写和记录是没有意义且浪费的'), '④ 不变量：不必每轮读写');
    assert.ok(SELF_BRIEF.includes('最近的实时变化都存在于你当前的上下文窗口内'), '④ 理由照原文');
    assert.equal(SELF_BRIEF.includes(MAINTENANCE_RULE_TEXT), false,
      'v61：旧常驻规则句随用户原文退场（要它回来得用户改稿——见 render.ts 的 v61 那一篇）');
    assert.ok(MEMORY_MAINTENANCE_RULE.includes(MAINTENANCE_RULE_TEXT), '旧容器自身仍自洽');

    const memory = MEMORY_MAINTENANCE_RULE;
    // **2026-10-12 v53/v54 之后这条位置锁换了形态**（不是放宽）：⑦ 段末尾**依次缀了十一段**
    // （`LIFE_TOGETHER_TEXT` → `CLOSER_TEXT` → `VOICE_LAYER_TEXT` → `NO_CATCHPHRASE_TEXT` →
    // `MEMORY_PURPOSE_TEXT` → `DEMANDS_AND_LINES_TEXT` → `FRAMEWORK_DEFAULT_TEXT` →
    // `SCHEDULING_TEXT` → **`PAYLOAD_SHAPE_TEXT`（v55）** → `ROLE_TEXT` → `REAL_RETREAT_TEXT`），
    // 所以"规则缀在段末"变成"规则仍在
    // ⑦ 段里、而段末是**点名的那一段**"——每加一段，判据就多点名一条（连同它们的先后顺序）。
    assert.ok(memory!.includes(MAINTENANCE_RULE_TEXT), '规则仍在 ⑦ 段里（一字未动）');
    const TAIL = [LIFE_TOGETHER_TEXT, CLOSER_TEXT, VOICE_LAYER_TEXT, NO_CATCHPHRASE_TEXT,
      MEMORY_PURPOSE_TEXT, DEMANDS_AND_LINES_TEXT, FRAMEWORK_DEFAULT_TEXT, SCHEDULING_TEXT,
      PAYLOAD_SHAPE_TEXT, AGENDA_USAGE_TEXT, ASSISTANT_STANCE_TEXT, ROLE_TEXT, REAL_RETREAT_TEXT];
    for (const seg of TAIL) {
      assert.ok(memory!.includes(seg), '这一段必须在旧容器里（不是另开了一节）');
    }
    // v61：这些段**不再进 `SELF_BRIEF`**（用户新稿把它们并进了自己的 §§5/8）⇒ 旧口径的
    // "在 SELF_BRIEF 里只出现一次"改为**容器自洽 + 新结构不变**两条：容器里各一次，
    // 而装置自述本身仍是 11 节（结构锁在 `self-brief.test.ts`）。
    assert.equal(SELF_BRIEF.split('\n## ').length - 1, 17,
      'v65：用户重排后按 `##` 分节共 17 节（自述 10 + 工作规范 7）');
    assert.ok(memory!.endsWith(REAL_RETREAT_TEXT), 'H（退要是真的退）就是 ⑦ 段的段末');
    // **改动 J**：那句框架定性要留，且位置是"I 那两块之后、H 之前"（用户点明的落点）。
    assert.ok(memory!.includes(FRAMEWORK_DEFAULT_TEXT), 'J 那句框架定性必须在 ⑦ 段里');
    assert.ok(memory!.indexOf(DEMANDS_AND_LINES_TEXT) < memory!.indexOf(FRAMEWORK_DEFAULT_TEXT),
      'J 在 I 那一块之后');
    assert.ok(memory!.indexOf(FRAMEWORK_DEFAULT_TEXT) < memory!.indexOf(REAL_RETREAT_TEXT),
      'J 在 H 之前（所以段末仍是 H）');
    // **改动 K / L**：用户点名的位置是"J 之后、H 之前"，且 **K 在前、L 紧接其后**。
    // （K∩L 的**逐字重复**是用户逐字草稿自带的一处，已上报；这里**不锁"两段不许重复"**——
    //  锁一条实现满足不了的判据等于把用例写成红的，等用户定删哪句再加锁。）
    assert.ok(memory!.indexOf(FRAMEWORK_DEFAULT_TEXT) < memory!.indexOf(SCHEDULING_TEXT),
      'K 在 J 之后');
    // **改动 M（v55）**：用户点的落点是"**紧接 `SCHEDULING_TEXT` 之后**"（⇒ L 仍紧接 K 之后，
    // 只是中间多了这一小段）。它与 K 的**逐字重复**按用户 2026-10-13 的裁决**各留一处**：
    // 改后机械检查 **K∩M ≥6 字 = 0 处**（读数 `_research/_tmp-v55-verbatim.txt`）——
    // 这一条与 K∩L 不同，用户给了明确裁决，所以它**可以**被锁成硬判据。
    assert.ok(memory!.indexOf(SCHEDULING_TEXT) < memory!.indexOf(PAYLOAD_SHAPE_TEXT), 'M 紧接 K 之后');
    assert.ok(memory!.indexOf(PAYLOAD_SHAPE_TEXT) < memory!.indexOf(ROLE_TEXT), 'L 仍紧接在 M 之后');
    assert.ok(memory!.indexOf(ROLE_TEXT) < memory!.indexOf(REAL_RETREAT_TEXT), 'L 在 H 之前 ⇒ 段末仍是 H');
    // **改动 I（2026-10-12 第五批）把 G 那三条线整块换掉了** ⇒ 正反两面都锁：
    // 新的两块必须在，旧那一块**不许回来**（换掉的证据不是"新的在"，而是"旧的真的没了"）。
    for (const added of ['你怎么用力，不必主动向他报账', '不主动说假话', '你和他看的是同一本账',
      '你要在他身边', '你可以说出你愿意为他牺牲', '你不拿它当筹码']) {
      assert.ok(memory!.includes(added), `改动 I 的文本必须在 ⑦ 段里：「${added}」`);
    }
    for (const gone of ['有三条线你不越', '一、他问你', '二、他最低落', '三、不把他和别人隔开']) {
      assert.equal(SELF_BRIEF.includes(gone), false, `I 之后旧那三条线不许回来：「${gone}」`);
    }
    assert.equal(SELF_BRIEF.includes('我会消失'), false,
      '旧第三条里的那句话随整块删除一起离开前缀（与 v53 那次"不要说这句"的裁决同向）');
    // 顺序也是**点名**的（C 紧接着 A、E 接在 A 那段末尾、F 最后；见用户的落点）
    for (let i = 1; i < TAIL.length; i += 1) {
      assert.ok(memory!.indexOf(TAIL[i - 1]!) < memory!.indexOf(TAIL[i]!), `第 ${i} 段与第 ${i + 1} 段的先后顺序`);
    }
    assert.equal(SELF_BRIEF.split('\n## ').length - 1, 17,
      'v65：用户重排后按 `##` 分节共 17 节（自述 10 + 工作规范 7）；旧"18 段"口径已随 v61 退场');

    // 用户那句话的五层意思，逐条落在文本里
    assert.ok(MAINTENANCE_RULE_TEXT.includes('只有你在维护'), '① 唯一维护源是她');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('别人不会去改'), '① 没有别人去改');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('已经在上下文里的，不要反复去读'), '② 读进上下文了就不必再读');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('每一轮都去改也没有意义'), '③ 每轮都改没意义');
    // ④ 时机（**v54 改成两档口径**：此刻层那两档已经分家，常驻这句必须跟着分，否则同一句里
    //    两套说法会让读的人以为有两种提示）。三条约束逐条钉住：
    assert.ok(MAINTENANCE_RULE_TEXT.includes('只在框架提示的时候'), '④ 时机：框架提示的时候');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('维护窗口'), '④ 两个词都要在：维护窗口（压缩临近那一档）');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('自主时段'), '④ 两个词都要在：自主时段（凌晨/空拍那一档）');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('或有明确变化时'), '④ 时机：或有明确变化');
    assert.ok(MAINTENANCE_RULE_TEXT.includes('没有要改的，就不必动它'), '⑤ 不变量：没有要改的就别动');
    // 改口径不许顺手加东西：不许出现数字（配额/频次/时段都靠数字说话），也不许出现阀门字样。
    // ⚠ `一次` **不在**禁列：原句本来就有"……改一次；"，那是**分寸**（一次，不是每轮），
    // 不是阀门——把它也禁掉就等于连原口径一起判红。
    assert.equal(/\d/u.test(MAINTENANCE_RULE_TEXT), false, '这一句里不许出现数字');
    for (const banned of ['每天', '每周', '次数', '最多', '至少', '不得超过', '禁止', '不许',
      '仅限', '冷却', '间隔']) {
      assert.equal(MAINTENANCE_RULE_TEXT.includes(banned), false, `这一句不许出现阀门式字样：「${banned}」`);
    }
    // 三个窗口词仍只出自那一份词表（改口径不许顺手改词）
    for (const word of MAINTENANCE_WINDOW_REASONS) {
      assert.ok(MAINTENANCE_RULE_TEXT.includes(word), `窗口词仍要出自共享词表：「${word}」`);
    }
    // 长度同一量级（旧口径那一句 44 字符 → 新口径 49 字符；这里钉一个上界防它长成一段话）
    assert.ok(MAINTENANCE_RULE_TEXT.includes('只在框架提示的时候（压缩临近的维护窗口，或凌晨、长时间空拍的自主时段）'),
      '时机那一句的最终措辞（逐字）');
  });

  test('这一句进的是 instructions ⇒ 必须与 `RENDER_VERSION` 的递增同批（v51 落它、v71 是当前代）', () => {
    // 判据：它落在 `renderInstructions` 拼出来的那一段里（最大公共前缀）
    //
    // 这个锁**跟着 `RENDER_VERSION` 走**（不是"钉死 51"）：v51 是落这一句的那一代，
    // v52 是工具清单那一批，v53 是装置自述补"长期相处"那一段，v54 是"想更近那一段 + 常驻规则
    // 改两档口径"，v55 是 timer 的 `payload` 三格约定那一段（①），v56 是每一层加分割线，
    // v57 是 timer 的 `payload` 再约四格（`title`/`cat`/`dur`/`action`），
    // v58 是装置自述补"日程怎么用"那一段（`AGENDA_USAGE_TEXT`），
    // v59 是 timer 的 `payload` 再约一格 `scope`（`self` = 她自己的内部事，不上日程页的周历）
    // ＋ 日程页照用户批注重做（周历只画用户向、清单里她的内务降级），
    // v60 是装置自述补"助理的站位 + 那页是给用户看的"那一段（`ASSISTANT_STANCE_TEXT`），
    // **v61 是记忆那一批：固定块里换成"框架推荐 top-6"（省 644 token/轮）
    // ＋ `memory_read` 扩三个入口 ＋ 腾挪 −37 ＋ `ask_human` 断装配**（2026-10-15），
    // v65 是装置自述大改（删 §11 / 删两处"必须说话" / 工作规范重排 / 新增"人类的偏好"，净减 384 token），
    // **v66 是此刻层结构压缩 + 会话清单窗口 + `read_channel` 列会话簿**（2026-10-16 用户定的方向：
    // 总体以减少输入为优化目标）——① 把此刻层里"一轮之内不变"的那几件挪进固定块、
    // ② 此刻层逐字段增量（不变的不发）、③ 会话清单加窗口（私聊常驻 / 群聊 7 天回过话或 1 小时被 @）、
    // ④ `read_channel` 的 `sid` 变可选（不给就列会话簿）。
    // **v67 是 `read_channel` 的描述与行为对齐**（2026-10-17：行为在 `fceeffe` 已换成"默认只给
    // 上次查看之后的增量"，描述还停在旧口径）——只动 `tools` 段一处说明，
    // `instructions` 这一段一个字节没改（见 `render.ts` 的 v67 那一篇）。
    // **v68 是思维链按帽回传**（2026-10-17：`message/reasoning` 从 internal 改成 model，渲染层只回传
    // 最近 3 步、单条正文 ≤ 20,000 字符）——动的是 `input` 的历史段，`instructions` 仍一个字节没改；
    // 换代照旧递增（与 v51 那一笔无关，这一句本身没动）。
    // **v69 是此刻层逐字段增量的两处失真修复 + `write_persona` 描述门槛 4KB→2KB**（2026-10-17 晚：
    // 切分只认登记过的标签并剥掉尾随分隔换行；基线改成"上一步**完整**的那一层"
    // `RenderedRequest.nowLayerFull`）——动的是 `input` 的尾段与 `tools` 段的一句描述，
    // `instructions` 这一段一个字节没改；换代照旧递增（理由同上：模板字节变了）。
    // **v70 是此刻层"必须看见"的三样 + 维护窗口 2/3 档的行首标签 + 窗口改写读数**（2026-10-18，
    // REVIEW 那四条 P1）——动的是 `input` 尾段（第 ≥2 步的此刻层字节），`instructions` 仍一个
    // 字节没改；换代照旧递增。
    // **v71 是给 `cdc6b92`（脱敏）补的账**（2026-10-18）：那一笔把 `SELF_BRIEF` 正文里 4 位尾号
    // 换成了占位值，**等长替换**（`SELF_BRIEF` 9226 字符、`tokens` / `bytes` 一个数没动），
    // 但它落在 `instructions`（最大公共前缀）⇒ **整份请求头部字节变了** ⇒ 必须换代，
    // 否则 `replay` 会拿"renderVersion 一致"掩盖"字节已经不同"（判据与实测见 `render.ts` 的 v71 那一篇）。
    // **v72 是用户整段置换自述 + 三处工具描述改准**（2026-10-20）：动的正是 `instructions` 与
    // `tools` 两段（`render.ts` 的 v72 那一篇）——`instructions` 变了 ⇒ 这一代必须递增。
    // **v73 是思维链全量回传 + 超硬限整组丢 + 发前自洽断言**（2026-10-20，治"每轮 400"）：
    // 动的是 `input` 的历史段（reasoning item 从"最近 3 条"变成"全量"），`instructions` 这一段
    // 一个字节没改；换代照旧递增（理由同 v68：模板字节变了）。
    // **v74 是 400 的"形状"那一批**（2026-10-20）：组内 canonical 顺序（reasoning → 正文）、
    // 孤儿正文整条不发、本轮输入钉住、发送前第三条断言——动的仍是 `input`，`instructions` 一个
    // 字节没改；换代照旧递增。
    // **v75 是"驱逐不再逐步微调"那一批**（2026-10-21）：阶梯制 + 边界按本轮开头冻结 + 压缩线
    // 接上回传字符那一条——动的仍是 `input` 的历史段（同一轮内头部不再逐笔位移），
    // `instructions` 一个字节没改；换代照旧递增。
    // **v77 是"一步多调用不再被回执切断"那一批**（2026-10-21）：`function_call_output` 延后到
    // 组边界发射（`fc1, fc2, …, out1, out2`）——动的仍是 `input` 的历史段，`instructions`
    // 一个字节没改；换代照旧递增。
    // **v78 是"关系档案改索引"那一批**（2026-10-22）：命中档案时固定块只印两行事实
    // （索引：路径 + 字数 + 小节名；以及"如已在上下文中，则不需再读"）——动的仍是 `input`
    // 的固定块，`instructions` 一个字节没改（首版给 `SELF_BRIEF` 补的那一句已撤回）⇒ 换代照旧递增。
    // **v79 是"`http_get` 换正文抽取器"那一批**（2026-10-23）：动的是 `tools` 段的描述字节
    // 与工具回执文本，`instructions` 一个字节没改；换代照旧递增。
    // **v80 是"`read_channel` 翻页一页的条数 50 → 15"那一批**（2026-10-23）：动的是 `tools` 段里
    // 两个参数描述（页大小逐字在里面），`instructions` 一个字节没改；换代照旧递增。
    // ——当前这一代就是它。换代之后这个数要一起改，而**改它的理由必须是"换了一代"**——
    // 所以断言里那句理由写成"当前这一代就是它"，免得下一个人把它读成"这句话只许属于 51"。
    assert.equal(RENDER_VERSION, '80', '模板换代就必须递增：一次设计内的全 miss');
    const rendered = render(renderInput());
    // v61：装置自述**逐字置换**后，这一句的落点从旧的 ⑦ 段容器搬进新稿的 §6（口径不变、措辞是
    // 用户的原文）⇒ 这条按新正文重锚，**不是放宽**：它照样要求"这一口径真的进 instructions"。
    assert.ok(rendered.instructions.includes('只在框架提示的维护窗口'), 'instructions 里必须有这一口径');
    assert.ok(rendered.instructions.includes(SELF_BRIEF), '而且它就是通过装置自述进去的');
    // 反面：此刻层那一行**不在** instructions 里（它逐 step 发，进冻结前缀就是每步全 miss）
    // v53：这里用夜里那一档的真实文案（`AUTONOMOUS`）——"自主时段"那一段同样一个字节都不许
    // 进冻结前缀（它是此刻层，逐 step 重发）。
    const withWindow = render(renderInput({
      maintenanceWindow: { text: AUTONOMOUS, reason: 'late-night', atMs: NOON_MS, day: null },
    }));
    assert.equal(withWindow.instructions, rendered.instructions, '信号一个字都不许进冻结前缀');
    assert.equal(withWindow.instructions.includes('[自主时段]'), false, '同上（正面再核一次）');
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
