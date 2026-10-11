/**
 * 上下文审计测试 — src/model/context-audit.ts + render 的归因副产物（2026-10-03）
 *
 * 三件事分开测，因为它们是三件不同的事：
 *   ① **归因**（每步一条事实）：段边界由渲染层给出，token / 条数 / 哈希都对得上；
 *   ② **哨兵**（只在真破坏时记）：逐类覆盖 persona / tools / memory / history / render / idle，
 *      并钉死"正常追加尾巴不算破坏"——那是这个哨兵唯一容易写成刷屏的地方；
 *   ③ **重放保真**：哨兵的基准取自日志（`lastAuditedCall`），不是内存里的"上一次"。
 *
 * 全部用例不读时钟、不碰文件：时间由事件 ts 给，基线由构造出来的 `BudgetConsumed` 给。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CACHE_BREAK_CAUSE_LABEL, CACHE_BREAK_CLASS_LABEL, CONTEXT_LABEL, DEFAULT_CACHE_BREAK_THRESHOLDS,
  detectCacheBreak, describeContext, hashOf, isExpectedCause, lastAuditedCall,
  type AuditedCall, type ContextBreakdown, type ContextSectionFact,
} from '../src/model/context-audit.ts';
import { RENDER_VERSION, render, type RenderInput, type RenderPersona } from '../src/model/render.ts';
import { defaultVisibility } from '../src/log/types.ts';
import { estimateTokens } from '../src/tools/registry.ts';
import type { AppEvent, BudgetConsumed } from '../src/log/types.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0_MS = Date.parse('2026-03-01T00:00:00.000Z');
const MIN_MS = 60_000;

const PERSONA: RenderPersona = {
  identity: 'IDENTITY：你是 Irmia。',
  constitution: 'CONSTITUTION：不越权。',
  style: 'STYLE：短句。',
  state: 'STATE：待命中。',
};

const TOOLS = [
  { name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } },
  { name: 'speak', description: '说话', parameters: { type: 'object', properties: {} } },
];

function renderOnce(o: Partial<RenderInput> = {}): ReturnType<typeof render> {
  return render({
    events: o.events ?? [],
    persona: o.persona ?? PERSONA,
    tools: o.tools ?? TOOLS,
    wakeEvent: o.wakeEvent ?? null,
    taskCard: o.taskCard ?? null,
    now: o.now ?? new Date(T0_MS).toISOString(),
    timezone: o.timezone ?? 'Asia/Shanghai',
    model: o.model ?? 'deepseek-flash',
    lane: o.lane ?? 'heavy',
    softHint: o.softHint ?? null,
    ...(o.skillCatalog === undefined ? {} : { skillCatalog: o.skillCatalog }),
  });
}

/** 一次被审计的调用：只给归因与命中数，够哨兵用 */
function call(context: ContextBreakdown, minutes: number, hit: number, miss: number): AuditedCall {
  return {
    context,
    ts: new Date(T0_MS + minutes * MIN_MS).toISOString(),
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}

/** 把一次调用原样包成 `budget/consumed` 事件（哨兵的日志来源） */
function consumedEvent(c: AuditedCall, seq: number): BudgetConsumed {
  return {
    seq,
    ts: c.ts,
    type: 'budget/consumed',
    data: {
      turn: 1, step: seq, lane: 'heavy', model: 'deepseek-flash',
      inputTokens: c.cacheHitTokens + c.cacheMissTokens, outputTokens: 0,
      cacheHitTokens: c.cacheHitTokens, cacheMissTokens: c.cacheMissTokens,
      durationMs: 1, retryCount: 0, finishReason: 'completed', tokensTodayAccum: 0,
      context: c.context,
    },
    visibility: defaultVisibility('budget/consumed'),
  };
}

// ──────────────────────────────── ① 归因 ────────────────────────────────

describe('归因：render 是段边界的唯一知情人', () => {
  test('每一段都记了 token 与条数，input 合计等于各 item 段之和', () => {
    const rendered = renderOnce();
    const c = rendered.context;

    assert.equal(c.renderVersion, RENDER_VERSION);
    // instructions 就是渲染出来的那一整段（人格三层 + SELF_BRIEF）
    assert.ok(c.instructions.tokens > 0);
    assert.equal(c.instructions.hash, hashOf(rendered.instructions));
    assert.equal(c.instructions.items, undefined, 'instructions 不是 input item，没有条数');
    // 工具清单：条数如实
    assert.equal(c.tools.count, TOOLS.length);
    assert.equal(c.tools.hash, hashOf(JSON.stringify(rendered.tools)));
    // 各段条数加起来就是 input 的条数（没有一段被漏掉）
    const counted = (c.memory.items ?? 0) + (c.history.items ?? 0) + (c.now.items ?? 0)
      + (c.wake.items ?? 0) + (c.hint.items ?? 0);
    assert.equal(counted, c.input.items);
    assert.equal(counted, rendered.input.length);
    // 合计只数 item 段（instructions / tools 是另外两个顶层字段）
    assert.equal(
      c.input.tokens,
      c.memory.tokens + c.history.tokens + c.now.tokens + c.wake.tokens + c.hint.tokens,
    );
  });

  test('此刻层恒为一条、本轮输入只在首 step 出现、插播单独成段', () => {
    const noWake = renderOnce();
    assert.equal(noWake.context.now.items, 1, '此刻层永远是尾部那一条 developer 消息');
    assert.equal(noWake.context.wake.items, 0, 'turn 内后续 step 没有本轮新输入');

    const hint = renderOnce({ softHint: '手上的事做完就收尾' });
    assert.equal(hint.context.hint.items, 1, '尾部插播（软阈值提示）也是上下文的一段');
    assert.ok(hint.context.hint.tokens > 0);
    assert.equal(hint.context.input.items, noWake.context.input.items + 1);
  });

  test('同一份输入渲染两次：归因逐字节相同（缓存铁律 1 的归因版）', () => {
    const a = renderOnce().context;
    const b = renderOnce().context;
    assert.deepEqual(a, b);
  });

  test('人格改写 → instructions 段的哈希变；工具改动 → tools 段的哈希变', () => {
    const base = renderOnce().context;
    const otherPersona = renderOnce({ persona: { ...PERSONA, identity: 'IDENTITY：改过了。' } }).context;
    assert.notEqual(base.instructions.hash, otherPersona.instructions.hash);
    assert.equal(base.tools.hash, otherPersona.tools.hash, '人格改动不该动工具段');

    const fewerTools = renderOnce({ tools: TOOLS.slice(0, 1) }).context;
    assert.notEqual(base.tools.hash, fewerTools.tools.hash);
    assert.equal(fewerTools.tools.count, 1);
  });

  test('历史前段哈希不随"追加尾巴"而变（哨兵靠它区分追加与重写）', () => {
    const base = renderOnce().context;
    const again = renderOnce().context;
    assert.equal(base.history.headHash, again.history.headHash);
  });

  test('describeContext 是一行人话：分部与合计自洽，不出现任何价格/货币字样', () => {
    const breakdown = renderOnce().context;
    const text = describeContext(breakdown);
    assert.match(text, /指令/u);
    assert.match(text, /工具 /u);
    assert.match(text, /历史/u);
    assert.match(text, /整条/u);
    // 用户明确不要计价：措辞里不许出现钱
    assert.equal(/[元$€£]|价格|费用|花费|计费|美元|人民币/u.test(text), false);

    // 2026-10-04 的回归：他看到的旧版是"指令 0.4万 · 工具 0.4万×25 · … · 合计 0.6万"——
    // 合计只数 input 段，却印在整行末尾，像是前面几项的和。这条钉住新的口径与形状：
    // 整条 = 指令 + 工具 + input 段，且每一项都是**精确整数**（能自己加一遍）。
    const m = /整条 ([\d,]+) = 指令 ([\d,]+) \+ 工具 ([\d,]+)（(\d+) 件） \+ input 段 ([\d,]+)/u.exec(text);
    assert.ok(m !== null, `这一行的形状变了，核对措辞与断言：${text}`);
    const num = (raw: string): number => Number(raw.replace(/,/gu, ''));
    const whole = num(m[1]!);
    const instructions = num(m[2]!);
    const tools = num(m[3]!);
    const count = Number(m[4]!);
    const inputSegment = num(m[5]!);
    assert.equal(instructions, breakdown.instructions.tokens, '第二项是指令');
    assert.equal(tools, breakdown.tools.tokens, '第三项是工具合计（不是每件的量）');
    assert.equal(count, breakdown.tools.count, '工具那一段要写明"多少件"，不能只丢一个乘号让人猜');
    assert.equal(inputSegment, breakdown.input.tokens, '第五项是 input 段（instructions / tools 不在里面）');
    assert.equal(instructions + tools + inputSegment, whole, '等式两边必须真的相等（旧版读起来像瞎写就是这里）');
    // 分段明细跟在 input 段后面，数字照旧精确
    assert.match(text, new RegExp(`记忆 ${breakdown.memory.tokens}`, 'u'));
    assert.match(text, new RegExp(`历史 ${breakdown.history.tokens}（${breakdown.history.items} 条）`, 'u'));
  });

  test('标签词由后端给，界面不维护第二份词表', () => {
    assert.equal(CONTEXT_LABEL, '上下文');
    assert.equal(CACHE_BREAK_CLASS_LABEL.persona, '人格文件变更');
    assert.equal(CACHE_BREAK_CLASS_LABEL.idle, '空闲过期');
  });
});

// ──────────────────────────────── ② 哨兵 ────────────────────────────────

describe('缓存破坏哨兵：只在真破坏时记一条', () => {
  const base = renderOnce().context;

  test('第一次调用不报（没有可比的对象）', () => {
    assert.equal(detectCacheBreak(null, call(base, 0, 0, 0)), null);
  });

  test('只有尾巴变（历史追加、此刻层刷新）→ 不报', () => {
    const prev = call(base, 0, 100, 100);
    const cur = call({
      ...base,
      history: { ...base.history, tokens: base.history.tokens + 500, items: base.history.items + 3, hash: 'tail-grew' },
      now: { ...base.now, hash: 'now-moved' },
    }, 1, 100, 100);
    assert.equal(detectCacheBreak(prev, cur), null, '追加是常态，不是破坏');
  });

  test('人格文件变更 → persona（头部失守）', () => {
    const cur = call({ ...base, instructions: { ...base.instructions, hash: 'new-persona' } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.ok(found !== null);
    assert.equal(found.class, 'persona');
    assert.deepEqual(found.classes, ['persona']);
    assert.match(found.reason, /人格文件被改写/u);
    assert.match(found.reason, /IDENTITY \/ CONSTITUTION \/ STYLE/u);
  });

  test('工具清单变更 → tools', () => {
    const cur = call({ ...base, tools: { ...base.tools, hash: 'new-tools' } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'tools');
    assert.match(found?.reason ?? '', /工具清单变了/u);
  });

  test('压缩改写长期记忆层 → memory（从最前面失守）', () => {
    const cur = call({ ...base, memory: { tokens: 10, hash: 'summary-rewritten', items: 1 } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'memory');
    assert.match(found?.reason ?? '', /长期记忆层被改写/u);
  });

  test('历史前段被重写 → history', () => {
    const cur = call({ ...base, history: { ...base.history, headHash: 'rewritten' } }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'history');
    assert.match(found?.reason ?? '', /历史前段被重写/u);
  });

  test('前 8 条还没攒够时正常追加不算重写（窗口长度不同 ≠ 内容变了）', () => {
    const three = call({ ...base, history: { tokens: 30, hash: 'h3', items: 3, headHash: 'head-of-3' } }, 0, 100, 0);
    const ten = call({ ...base, history: { tokens: 100, hash: 'h10', items: 10, headHash: 'head-of-10' } }, 1, 100, 0);
    assert.equal(detectCacheBreak(three, ten), null, '3 条涨到 10 条：窗口本就不同长，不是重写');

    // 攒满之后窗口就固定了：前 8 条逐字节变了才是重写
    const tenB = call({ ...base, history: { tokens: 100, hash: 'h10b', items: 10, headHash: 'other' } }, 2, 100, 0);
    assert.equal(detectCacheBreak(ten, tenB)?.class, 'history');

    // 条数变少（遮蔽/抹掉）同样是重写，不管有没有攒满
    const five = call({ ...base, history: { tokens: 50, hash: 'h5', items: 5, headHash: 'x' } }, 3, 100, 0);
    assert.equal(detectCacheBreak(ten, five)?.class, 'history');
  });

  test('渲染版本变更 → render（正交：不是某一段的事）', () => {
    const cur = call({ ...base, renderVersion: 'x' }, 1, 0, 100);
    const found = detectCacheBreak(call(base, 0, 100, 0), cur);
    assert.equal(found?.class, 'render');
  });

  test('多处同时失守：主类别取**最早**那一段，其余进 classes', () => {
    const prev = call(base, 0, 100, 0);
    const cur = call({
      ...base,
      instructions: { ...base.instructions, hash: 'p2' },
      tools: { ...base.tools, hash: 't2' },
      memory: { ...base.memory, hash: 'm2' },
    }, 1, 0, 100);
    const found = detectCacheBreak(prev, cur);
    assert.equal(found?.class, 'persona', '头部失守才是"整段前缀没了"的答案');
    assert.deepEqual(found?.classes, ['persona', 'tools', 'memory']);
  });

  test('空闲过期：隔得久 **且** 命中率塌陷才算', () => {
    const prev = call(base, 0, 900, 100); // 命中 90%
    // ① 隔得久但命中率没塌（前缀还在）：不报
    assert.equal(detectCacheBreak(prev, call(base, 60, 900, 100)), null);
    // ② 命中率塌了但没隔多久（另有原因）：不报
    assert.equal(detectCacheBreak(prev, call(base, 1, 10, 990)), null);
    // ③ 两个都命中：报 idle
    const found = detectCacheBreak(prev, call(base, 60, 10, 990));
    assert.equal(found?.class, 'idle');
    assert.match(found?.reason ?? '', /空闲太久/u);
    assert.equal(found?.gapMs, 60 * MIN_MS);
  });

  test('空闲判据的边界：上次本来就没命中（输入很短）时不报——跌无可跌', () => {
    const prev = call(base, 0, 0, 5);
    assert.equal(detectCacheBreak(prev, call(base, 120, 0, 500)), null);
  });

  test('阈值可配：把空闲线调到 5 分钟，同一个间隔就报出来了', () => {
    const prev = call(base, 0, 900, 100);
    const cur = call(base, 10, 10, 990);
    assert.equal(detectCacheBreak(prev, cur), null, '默认 30 分钟：10 分钟不算空闲过期');
    const found = detectCacheBreak(prev, cur, { idleMs: 5 * MIN_MS, hitDrop: 0.5 });
    assert.equal(found?.class, 'idle');
  });

  test('默认阈值是保守的：空闲线 30 分钟、跌幅门槛一半', () => {
    assert.equal(DEFAULT_CACHE_BREAK_THRESHOLDS.idleMs, 30 * MIN_MS);
    assert.equal(DEFAULT_CACHE_BREAK_THRESHOLDS.hitDrop, 0.5);
  });
});

// ──────────────────────────── ④ 归因与分级（2026-10-05） ────────────────────────────

/**
 * 用户那次的原话（2026-10-05）：框架提示天天报失守，而今天绝大多数失守是**我们自己造成的**
 * ——十几次重启后端、她自己频繁改 `STATE.md`、工具清单变更。**预期内的代价和真正的异常混在
 * 同一条告警里 ⇒ 告警常态化 ⇒ 人就不看了**。所以这一节钉住两件事：
 *   · 四类归因各自的判据（谁解释哪一段、没有证据不许替它编原因）；
 *   · 分级——预期内的 `silent === true`（普通记录），**只有 `unattributable` 仍然告警**。
 */
describe('失守归因：预期内的降级成普通记录，无法归因的才告警', () => {
  const base = renderOnce().context;
  /**
   * 两次调用之间"形状可比"的那一份。
   *
   * 为什么不能直接用 `base`：
   *   · 固定块的 `items` 只有真发了块才是 1（`renderOnce` 没给 `turnBlock`，默认是 0 条）
   *     ——换轮重建那条判据要求"两次都发了块"，0 条时它按"没发"处理；
   *   · 历史的 `headHash` 只在两边都攒满前 8 条时才直接可比（见 `historyRewritten`），
   *     要让"前段被改写"成立，就得先把窗口攒满。
   */
  const comparable: ContextBreakdown = {
    ...base,
    state: { tokens: 120, hash: 'block-v1', items: 1 },
    history: { tokens: 500, hash: 'hist-v1', items: 26, headHash: 'head-v1' },
  };
  /** 带 seq + 轮号的调用（归因要切事件窗口、判断是不是换轮，两者都由调用自己带） */
  const seqCall = (
    context: ContextBreakdown, seq: number, minutes: number, hit: number, miss: number, turn = 1,
  ): AuditedCall => ({ ...call(context, minutes, hit, miss), seq, turn });

  /** 造一条事件：只给归因认得的字段，够用 */
  const evt = (seq: number, type: string, data: Record<string, unknown> = {}): AppEvent =>
    ({ seq, ts: new Date(T0_MS + seq * 1000).toISOString(), type, data, visibility: 'internal' }) as unknown as AppEvent;

  test('① 接管/重启：窗口里有 session/start → 归因 restart，**不告警**', () => {
    const prev = seqCall(comparable, 10, 0, 100, 0);
    // 重启后工具清单换了版（这正是当天那几条的形状）
    const cur = seqCall({ ...comparable, tools: { ...comparable.tools, hash: 'after-restart' } }, 20, 5, 0, 200);
    const events = [evt(14, 'session/end'), evt(15, 'instance/takeover'), evt(16, 'session/start')];

    const found = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, events);
    assert.equal(found?.class, 'tools');
    assert.equal(found?.cause, 'restart');
    assert.deepEqual(found?.causes, [{ class: 'tools', cause: 'restart' }]);
    assert.equal(found?.silent, true, '重启是预期内的代价：记一条普通记录，不进告警区');
    assert.match(found?.reason ?? '', /接管\/重启/u);
  });

  test('② 她自己改 STATE.md：归因 asset（固定块那一段），**不告警**', () => {
    const prev = seqCall(comparable, 40, 0, 100, 0);
    // 固定块换版：只有 state 段变（STATE 只进固定块，见 renderTurnBlock）
    const cur = seqCall({ ...comparable, state: { tokens: 90, hash: 'state-v2', items: 1 } }, 60, 2, 40, 60);
    const events = [
      evt(45, 'turn/end'),
      evt(47, 'persona/updated', { file: 'STATE.md', diffHash: 'h2', by: 'agent' }),
      evt(48, 'turn/start'),
    ];

    const found = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, events);
    assert.equal(found?.class, 'state', '固定块被改写是它自己的类别');
    assert.equal(found?.cause, 'asset');
    assert.equal(found?.silent, true, '她自己刚改的资产是预期内的：不告警');
    assert.match(found?.reason ?? '', /她自己刚改了资产/u);
  });

  test('②b 她写记忆 ⇒ 索引重建：同样归因 asset（写 MEMORIES 下的文件就是证据）', () => {
    const prev = seqCall(comparable, 70, 0, 100, 0);
    const cur = seqCall({ ...comparable, state: { tokens: 90, hash: 'index-rebuilt', items: 1 } }, 80, 1, 50, 50);
    const events = [evt(75, 'tool/call', {
      callId: 'c1', name: 'safe_edit', arguments: '{"path":"MEMORIES/facts.md","old":"a","new":"b"}',
    })];

    assert.equal(detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, events)?.cause, 'asset');
  });

  test('③ 前缀无故变化 → 归因 unattributable，**仍然告警**', () => {
    const prev = seqCall(comparable, 90, 0, 100, 0);
    const cur = seqCall({ ...comparable, instructions: { ...comparable.instructions, hash: 'who-changed-this' } }, 92, 1, 0, 200);
    // 窗口里只有无关的事（她只是在干活）——没有任何东西能解释 instructions 为什么变
    const events = [evt(91, 'tool/call', { callId: 'c9', name: 'safe_read', arguments: '{"path":"README.md"}' })];

    const found = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, events);
    assert.equal(found?.class, 'persona');
    assert.equal(found?.cause, 'unattributable');
    assert.equal(found?.silent, false, '说不清为什么的失守才是要人看一眼的那一类');
    assert.equal(isExpectedCause('unattributable'), false);
    assert.match(found?.reason ?? '', /原因不明/u);
  });

  test('④ 判据只紧不松：STATE 被改**不能**替 instructions 段作证', () => {
    const prev = seqCall(comparable, 100, 0, 100, 0);
    // instructions 变了，而窗口里只有一条"改 STATE.md"——STATE 不在 instructions 段里
    const cur = seqCall({ ...comparable, instructions: { ...comparable.instructions, hash: 'x' } }, 110, 1, 0, 200);
    const events = [evt(105, 'persona/updated', { file: 'STATE.md', diffHash: 'h', by: 'agent' })];

    const found = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, events);
    assert.equal(found?.cause, 'unattributable', '没有证据就落无法归因，不许拿别的段的证据顶替');
    assert.equal(found?.silent, false);
  });

  test('④b 没有事件窗口（老日志 / 手写调用）时归因一律"无法归因"，行为与本次改动前逐条一致', () => {
    const prev = call(comparable, 0, 100, 0);   // 不带 seq
    const cur = call({ ...comparable, tools: { ...comparable.tools, hash: 't2' } }, 1, 0, 100);
    const found = detectCacheBreak(prev, cur);
    assert.equal(found?.class, 'tools', '类别判据一个字没动');
    assert.equal(found?.cause, 'unattributable');
    assert.equal(found?.silent, false, '没有窗口就没有归因：宁可多报一条');
  });

  test('压缩换了一版早期摘要 → 归因 compaction（记忆层与历史前段都算它的）', () => {
    const prev = seqCall(comparable, 120, 0, 100, 0);
    const cur = seqCall({
      ...comparable,
      memory: { tokens: 30, hash: 'summary-v2', items: 1 },
      history: { tokens: 80, hash: 'hist-v2', items: 12, headHash: 'head-v2' },
    }, 130, 3, 0, 200);
    const events = [evt(125, 'compaction/summary', { coveredUpToSeq: 900, summary: '早前的事' })];

    const found = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, events);
    assert.deepEqual(found?.causes, [
      { class: 'memory', cause: 'compaction' },
      { class: 'history', cause: 'compaction' },
    ]);
    assert.equal(found?.silent, true);
  });

  test('记忆层变了**却没有**压缩事件 → 无法归因（这条是压缩那一条的对照）', () => {
    const prev = seqCall(comparable, 140, 0, 100, 0);
    const cur = seqCall({ ...comparable, memory: { tokens: 30, hash: 'summary-v2', items: 1 } }, 150, 3, 0, 200);
    assert.equal(detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, [])?.cause, 'unattributable');
  });

  test('工具清单变更（配置热更 / 技能目录）→ 归因 tool-inventory，**不告警**', () => {
    const prev = seqCall(comparable, 160, 0, 100, 0);
    const cur = seqCall({ ...comparable, tools: { ...comparable.tools, hash: 'destructive-on' } }, 170, 1, 0, 200);

    const byConfig = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(165, 'config/changed', { fields: ['tools.destructiveEnabled'], configHash: 'c' })]);
    assert.equal(byConfig?.cause, 'tool-inventory');
    assert.equal(byConfig?.silent, true);

    const bySkill = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(165, 'skill/installed', { name: 'x', path: 'x', by: 'human' })]);
    assert.equal(bySkill?.cause, 'tool-inventory');

    const byMcp = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(165, 'mcp/server-started', { name: 'srv', pid: 1, tools: ['t'] })]);
    assert.equal(byMcp?.cause, 'tool-inventory');

    // 没有任何清单动作的对照：同一个指纹变化落"无法归因"
    assert.equal(detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS, [])?.cause, 'unattributable');
  });

  const blockChangedContext = { ...comparable, state: { tokens: 90, hash: 'block-v2', items: 1 } };

  test('固定块的形状差异：换轮重建不算失守，同一轮内被改写照旧算', () => {
    // 上一轮第 1 步（turn 9）→ 这一轮第 1 步（turn 10）：块在轮首重建，形状本就不同 → 不报
    const t9 = seqCall(comparable, 100, 0, 100, 0, 9);
    const t10 = seqCall(blockChangedContext, 200, 1, 100, 0, 10);
    const acrossTurn = detectCacheBreak(t9, t10, DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(150, 'turn/end'), evt(160, 'turn/start')]);
    assert.equal(acrossTurn, null, '换轮时固定块换的是快照，不是故障');

    // 上一轮那一步没发块（第 2 步起摘了）：两块不可比 → 也不报（2026-10-05 seq=26240 的形状）
    const noBlockBefore = seqCall({ ...comparable, state: { tokens: 0, hash: 'no-block', items: 0 } }, 100, 0, 100, 0, 10);
    assert.equal(
      detectCacheBreak(noBlockBefore, t10, DEFAULT_CACHE_BREAK_THRESHOLDS, [evt(150, 'tool/result')]),
      null,
    );

    // **同一轮内**（两边块都发了、轮号相同）块被改写 = 真失守 → 照旧报
    const sameTurn = detectCacheBreak(
      seqCall(comparable, 100, 0, 100, 0, 9),
      seqCall(blockChangedContext, 150, 1, 100, 0, 9),
      DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(120, 'tool/result')],
    );
    assert.equal(sameTurn?.class, 'state');
    assert.equal(sameTurn?.cause, 'unattributable', '同一轮内改动无法归因 ⇒ 仍然告警');
    assert.equal(sameTurn?.silent, false);

    // 判据只紧不松的**旧形状**（2026-10-11 起被"跨轮不比段"整体取代，见下面那一节）：
    // 同一次换轮里她真改了 STATE —— 以前这里报 `state`（归因 asset），现在**轮号不同就不比**。
    // 换成同一轮内的形状，把"她真改了资产 ⇒ 报 asset"这条性质照旧钉住（判据一个字没放松）。
    const assetSameTurn = detectCacheBreak(
      seqCall(comparable, 100, 0, 100, 0, 9),
      seqCall(blockChangedContext, 150, 1, 100, 0, 9),
      DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(120, 'persona/updated', { file: 'STATE.md', diffHash: 'h', by: 'agent' })],
    );
    assert.equal(assetSameTurn?.class, 'state', '她真改了资产时必须报出来');
    assert.equal(assetSameTurn?.cause, 'asset');
    assert.equal(assetSameTurn?.silent, true);
  });

  test('渲染版本换代与空闲塌陷：各自算一条原因，都不告警', () => {
    const prev = seqCall(comparable, 200, 0, 900, 100);
    const renderOnly = seqCall({ ...comparable, renderVersion: 'next' }, 210, 1, 0, 100);
    const r = detectCacheBreak(prev, renderOnly, DEFAULT_CACHE_BREAK_THRESHOLDS, []);
    assert.equal(r?.cause, 'render');
    assert.equal(r?.silent, true);

    const idleOnly = seqCall(comparable, 220, 60, 10, 990);
    const i = detectCacheBreak(prev, idleOnly, DEFAULT_CACHE_BREAK_THRESHOLDS, []);
    assert.equal(i?.cause, 'idle');
    assert.equal(i?.silent, true, '空闲回收是服务端的正常行为，不是异常');
  });

  test('多段同时失守：主原因是**最早那一段**的原因，只要有一段说不清就仍然告警', () => {
    const prev = seqCall(comparable, 240, 0, 100, 0);
    const cur = seqCall({
      ...comparable,
      tools: { ...comparable.tools, hash: 't2' },
      memory: { ...comparable.memory, hash: 'm2' },
    }, 250, 1, 0, 200);
    // 压缩能解释 memory 段，却解释不了 tools 段为什么变
    const found = detectCacheBreak(prev, cur, DEFAULT_CACHE_BREAK_THRESHOLDS,
      [evt(245, 'compaction/summary', { coveredUpToSeq: 1, summary: 's' })]);
    assert.deepEqual(found?.causes, [
      { class: 'tools', cause: 'unattributable' },
      { class: 'memory', cause: 'compaction' },
    ]);
    assert.equal(found?.cause, 'unattributable', '主原因 = 最早的段（tools）');
    assert.equal(found?.silent, false, '有一条说不清，整条就还得告警');
  });

  test('词表由后端给：原因短标签齐了，界面不维护第二份', () => {
    assert.equal(CACHE_BREAK_CAUSE_LABEL.restart, '接管/重启');
    assert.equal(CACHE_BREAK_CAUSE_LABEL.asset, '她改了资产');
    assert.equal(CACHE_BREAK_CAUSE_LABEL.unattributable, '无法归因');
    assert.equal(CACHE_BREAK_CLASS_LABEL.state, '固定块改写');
  });
});

// ──────────────────── ④b 跨轮不比段 + 段级 changed/side（2026-10-11 修） ────────────────────

/**
 * **BUG-2 的判据那一半：跨轮不比段。**
 *
 * 现场：本机 00:27:38 / 00:30:36 / 00:30:52 三拍都报「缓存前缀失守（memory）」并告警，
 * 而 `diff[0]` **逐字段完全相同**（`cfe932817dcb2a6e`(4208) → `1ad6e5ffc5306859`(4267)）。
 * 三拍的 `turn` 都是 1302，基线却被取成了 **turn 1300 的 step 1**（seq 76203）——
 * 拿**别的轮**的那一拍当基准，"变了"就是跨轮比出来的假差异。
 *
 * 两处各修一半，缺一仍会误报：
 *   · **基线那一半**在 `agent-loop` 的 `TurnRunner`（`previousAuditedCall`：本 runner 自己记上一拍，
 *     不再从 `this.events` 那个轮首快照里现取——那正是"同一个 prev 被连用三拍"的根）；
 *   · **判据那一半**在 `detectCacheBreak`（本节）：轮号不同 ⇒ 两个请求形状本就不同
 *     （固定块在轮首重建、工具清单与记忆层都可能整体换版）⇒ "哪一段失守"这个问题本身不成立。
 *
 * 正交判据（`render` / `idle`）**不在这条护栏里**：它们比的是版本号与命中率，
 * 与"两拍可不可比"无关，跨轮时照旧成立（下面最后一条正面钉着）。
 */
describe('跨轮不比段：轮号不同就不报段失守（BUG-2 判据那一半）', () => {
  const base = renderOnce().context;
  /** 形状可比的那一份（与 ④ 同一份理由：块要真发过、历史前段要攒满） */
  const comparable: ContextBreakdown = {
    ...base,
    state: { tokens: 120, hash: 'block-v1', items: 1 },
    history: { tokens: 500, hash: 'hist-v1', items: 26, headHash: 'head-v1' },
  };
  const callsOf = (context: ContextBreakdown, seq: number, minutes: number, hit: number, miss: number,
    turn: number): AuditedCall => ({ ...call(context, minutes, hit, miss), seq, turn });
  const evtOf = (seq: number, type: string, data: Record<string, unknown> = {}): AppEvent =>
    ({ seq, ts: new Date(T0_MS + seq * 1000).toISOString(), type, data, visibility: 'internal' }) as unknown as AppEvent;
  /** 上一轮那一步发块、这一轮第 1 步的块换了个快照（现场形状） */
  const blockV2 = { ...comparable, state: { tokens: 90, hash: 'block-v2', items: 1 } };

  test('prev.turn ≠ cur.turn ⇒ 一段都不报（连"她真改了资产"也不报）——跨轮的前缀本来就不可比', () => {
    const t9 = callsOf(comparable, 100, 0, 100, 0, 9);
    const t10 = callsOf(blockV2, 200, 1, 100, 0, 10);
    const found = detectCacheBreak(t9, t10, DEFAULT_CACHE_BREAK_THRESHOLDS, [
      evtOf(120, 'persona/updated', { file: 'STATE.md', diffHash: 'h', by: 'agent' }),
      evtOf(150, 'turn/end'),
      evtOf(160, 'turn/start'),
    ]);
    assert.equal(found, null, '跨轮不比段：三段都没报，也没有告警');
  });

  test('跨轮是**整体**不比段，不是只放过固定块：tools 段同样不报', () => {
    const before = callsOf(comparable, 100, 0, 100, 0, 1301);
    // 现场形状：24 件 → 4 件（03:00:05 那一拍）
    const after = callsOf(
      { ...comparable, tools: { tokens: 888, hash: 'tools-4', count: 4 } },
      200, 1, 0, 400, 1302,
    );
    assert.equal(
      detectCacheBreak(before, after, DEFAULT_CACHE_BREAK_THRESHOLDS,
        [evtOf(150, 'turn/end'), evtOf(160, 'turn/start')]),
      null,
      '工具清单整体换版也是"跨轮形状不同"的一种 ⇒ 同样不报',
    );
  });

  test('同轮内真失守 ⇒ 照旧报（护栏只挡跨轮，不许顺手把同一轮也放过去）', () => {
    const before = callsOf(comparable, 160, 0, 100, 0, 42);
    const after = callsOf({ ...comparable, tools: { ...comparable.tools, hash: 'destructive-on' } },
      170, 1, 0, 200, 42);
    const found = detectCacheBreak(before, after, DEFAULT_CACHE_BREAK_THRESHOLDS, []);
    assert.equal(found?.class, 'tools', '同一轮内清单变了照旧是失守');
    assert.equal(found?.cause, 'unattributable');
    assert.equal(found?.silent, false, '说不清就照旧告警');
  });

  test('轮号读不出来（老日志 / 手写调用）：判不出来算同轮，照旧报（宁可多报一条）', () => {
    const noTurnBefore = call(base, 0, 100, 0);
    const toolsV2 = { ...base, tools: { ...base.tools, hash: 'new-tools' } };
    // ① 两边都没有 turn
    assert.equal(detectCacheBreak(noTurnBefore, call(toolsV2, 1, 0, 100))?.class, 'tools');
    // ② 只有一边有 turn ⇒ 同样算同轮（不许凭"另一半缺字段"替一段失守开脱）
    assert.equal(
      detectCacheBreak(noTurnBefore, { ...call(toolsV2, 1, 0, 100), turn: 7 })?.class,
      'tools',
    );
    // ③ 正对照：两边都有、且不同 ⇒ 才是不比
    assert.equal(
      detectCacheBreak({ ...noTurnBefore, turn: 6 }, { ...call(toolsV2, 1, 0, 100), turn: 7 }),
      null,
      '两边都读得出轮号且不同 ⇒ 不比',
    );
  });

  test('正交判据不受这条护栏影响：版本换代与空闲塌陷跨轮照旧各算一条原因', () => {
    const renderUp = detectCacheBreak(
      callsOf(comparable, 300, 0, 900, 100, 9),
      callsOf({ ...comparable, renderVersion: 'next' }, 310, 1, 0, 100, 10),
      DEFAULT_CACHE_BREAK_THRESHOLDS, [],
    );
    assert.equal(renderUp?.cause, 'render', '版本换代比的是版本号，与两拍可不可比无关');
    assert.equal(renderUp?.silent, true);

    const idle = detectCacheBreak(
      callsOf(comparable, 320, 0, 900, 100, 9),
      callsOf(comparable, 380, 60, 10, 990, 10),
      DEFAULT_CACHE_BREAK_THRESHOLDS, [],
    );
    assert.equal(idle?.cause, 'idle');
    assert.equal(idle?.silent, true);
  });
});

/**
 * **BUG-1：段级条目必须带 `changed` / `side`。**
 *
 * 现场：seq 78374 的 `diff[0]` 原始 JSON 只有 `{class, prevHash, prevTokens, nextHash,
 * nextTokens, deltaTokens}` —— **没有 `changed`、没有 `side`**。原因在代码单点上：
 * `persona` / `tools` / `state` 三类只走 `segmentDiff`，而它从来不设这两个字段
 * （只有 `sectionDiffsOf` 给 `memory` / `history` 的分节设）。
 * 于是把 `changed` 当"这段变没变"的读数会**必然读错**——`class='tools'` 与"diff 没有 changed"
 * 并不矛盾，两者不是同一件事。
 *
 * 这一节钉住三件事：**变了的那一段 `changed=true`**、**三态 `side` 各有正确取值**、
 * 以及对得上 `class`（`changed` 是新旧对照的读数，`class` 是判据的结论，两处不许互相顶替）。
 */
describe('段级新旧对照：changed 与三态 side（BUG-1）', () => {
  const base = renderOnce().context;

  test('tools 段变了 ⇒ diff[0].changed=true、side=both，哈希就是两边的 tools 哈希', () => {
    const prev = call(base, 0, 100, 100);
    const next = call({ ...base, tools: { ...base.tools, hash: 'tools-4', tokens: 888, count: 4 } },
      1, 0, 200);
    const found = detectCacheBreak(prev, next);
    assert.equal(found?.class, 'tools');
    const diff = found?.diff?.[0];
    assert.ok(diff !== undefined, 'tools 段失守必须有 diff（判据没变）');
    assert.equal(diff.class, 'tools');
    assert.equal(diff.changed, true, '两边哈希不等 ⇒ 变了（这正是缺的那一格）');
    assert.equal(diff.side, 'both', '两边都发了这一段');
    assert.equal(diff.prevHash, base.tools.hash);
    assert.equal(diff.nextHash, 'tools-4');
    assert.equal(diff.deltaTokens, 888 - base.tools.tokens, '变了多少 token 照旧要能直接读出');
  });

  test('persona 段变了 ⇒ 同样 changed=true、side=both', () => {
    const prev = call(base, 0, 100, 100);
    const next = call({ ...base, instructions: { ...base.instructions, hash: 'p2' } }, 1, 0, 200);
    const found = detectCacheBreak(prev, next);
    assert.equal(found?.class, 'persona');
    assert.equal(found?.diff?.[0].changed, true);
    assert.equal(found?.diff?.[0].side, 'both');
  });

  test('side 三态（段级）：这一段只在一边时是 prev-only / next-only；state 那一种被形状判据吃掉（照实记）', () => {
    // ⚠ **一个刻意的否证**：`state` 只在每轮第 1 步发，所以"旧的有、新的没有"最像 prev-only 的
    // 现场形状 —— 但它**报不出来**，而且是既有判据的设计，不是这次改动漏掉的：
    //   · 一边没发块 ⇒ `blockIsShapeDifference` 第 ② 条直接判"形状差异"（`state` 根本不进 classes）
    //     ⇒ `diffOf` 只为**真的按段失守**的那几类出对照，于是连 `diff[]` 都没有这一条。
    // 把它照实钉在这里：谁要读"state 段的 side"，得先知道它多数时候压根不在 diff 里。
    const withBlock = { ...base, state: { tokens: 120, hash: 'block-v1', items: 1 } };
    assert.equal(
      detectCacheBreak(call(withBlock, 0, 100, 100), call(base, 1, 0, 200)), null,
      '一边没发块 ⇒ 形状差异，state 不进 classes（既有判据）',
    );

    // 真能读出三态的是**分节那一层**（下面那条）：它们不受"块只在轮首发"这条约束。
    // 段级这一层在"两边都在、内容不同"时给 `both`（上面两条已钉）——三态里的另两态由分节覆盖。
    const both = detectCacheBreak(
      call(withBlock, 0, 100, 100),
      call({ ...base, state: { tokens: 90, hash: 'block-v2', items: 1 } }, 1, 0, 200),
    );
    assert.equal(both?.class, 'state');
    assert.equal(both?.diff?.[0].side, 'both', '两边都发了块 ⇒ both');
    assert.equal(both?.diff?.[0].changed, true);
    assert.equal(both?.diff?.[0].prevHash, 'block-v1');
    assert.equal(both?.diff?.[0].nextHash, 'block-v2');
  });

  test('side 三态（分节级）：分节事实只在一侧时是 prev-only / next-only，且哈希只出那一边', () => {
    const fact = (name: string, text: string): ContextSectionFact => ({
      name, tokens: estimateTokens(text), bytes: Buffer.byteLength(text, 'utf8'), hash: hashOf(text),
    });
    const block = { tokens: 120, hash: 'block-v1', items: 1 };
    const prevWith = {
      ...base,
      state: block,
      memory: { ...base.memory, hash: 'm-with', sections: [fact('mcp', '旧的那一版索引')] },
    };
    // ⚠ 这一边**也要带块**：两边都发过块时 `state` 才不落入形状差异判据，记忆层那条失守才报得出来
    const nextWithout = { ...base, state: block, memory: { ...base.memory, hash: 'm-without' } };

    const prevOnly = detectCacheBreak(call(prevWith, 0, 100, 100), call(nextWithout, 1, 0, 200));
    assert.equal(prevOnly?.class, 'memory');
    const gone = prevOnly?.diff?.[0].sections?.[0];
    assert.equal(gone?.name, 'mcp');
    assert.equal(gone?.side, 'prev-only', '这一节只在上一次的读数里');
    assert.equal(gone?.changed, true);
    assert.equal(gone?.prevHash, hashOf('旧的那一版索引'));
    assert.equal(gone?.nextHash, undefined, '缺的那一边不许编哈希');

    const nextOnly = detectCacheBreak(call(nextWithout, 0, 100, 100), call(prevWith, 1, 0, 200));
    assert.equal(nextOnly?.class, 'memory');
    assert.equal(nextOnly?.diff?.[0].sections?.[0].side, 'next-only');
    assert.equal(nextOnly?.diff?.[0].sections?.[0].changed, true);
    assert.equal(nextOnly?.diff?.[0].sections?.[0].prevHash, undefined);
  });

  test('memory / history 的整段条目也带这两格（它们本来由 sections 带着，整段那一层同样要对上）', () => {
    const prev = call(base, 0, 100, 100);
    const next = call({ ...base, memory: { ...base.memory, hash: 'm2' } }, 1, 0, 200);
    const found = detectCacheBreak(prev, next);
    assert.equal(found?.class, 'memory');
    const diff = found?.diff?.[0];
    assert.equal(diff?.class, 'memory');
    assert.equal(diff?.changed, true);
    assert.equal(diff?.side, 'both');
    // 分节照旧（两边都没有分节事实 ⇒ undefined，"拿不到"与"没变"仍然分得开）
    assert.equal(diff?.sections, undefined);
  });

  test('口径一致：changed 与 class 不是同一件事，但同一次失守里必须互相对得上', () => {
    const prev = call(base, 0, 100, 100);
    const next = call({ ...base, tools: { ...base.tools, hash: 't2' } }, 1, 0, 200);
    const found = detectCacheBreak(prev, next);
    // 判据说"tools 这一类失守了" ⇒ 那条对照里的这一段必须 `changed: true`（反之亦然）
    for (const entry of found?.diff ?? []) {
      assert.equal(
        entry.changed, entry.class === 'tools',
        `diff 里的 changed 与 class 对不上：${entry.class} changed=${entry.changed}`,
      );
      assert.equal(entry.side, 'both');
    }
  });
});

// ──────────────────────────────── ③ 重放保真 ────────────────────────────────

describe('哨兵的基准取自日志：重放时从同一个地方取数据', () => {
  const base = renderOnce().context;
  const first = call(base, 0, 100, 100);
  const second = call({ ...base, instructions: { ...base.instructions, hash: 'p2' } }, 5, 0, 200);

  test('lastAuditedCall 取的是**最后一次**带归因的调用', () => {
    const events: AppEvent[] = [consumedEvent(first, 1), consumedEvent(second, 2)];
    const found = lastAuditedCall(events);
    assert.equal(found?.ts, second.ts);
    assert.equal(found?.context.instructions.hash, 'p2');
  });

  test('没有归因的老事件被跳过（不拿它当基准，免得得出"到处都变了"）', () => {
    const legacy: AppEvent = {
      ...consumedEvent(first, 1),
      data: {
        turn: 1, step: 1, lane: 'heavy', model: 'm', inputTokens: 1, outputTokens: 0,
        cacheHitTokens: 0, cacheMissTokens: 1, durationMs: 1, retryCount: 0,
        finishReason: 'completed', tokensTodayAccum: 0,
      },
    } as unknown as AppEvent;
    assert.equal(lastAuditedCall([legacy]), null);
    // 新旧混着：基准应当是那条**有归因**的
    assert.equal(lastAuditedCall([consumedEvent(second, 2), legacy])?.ts, second.ts);
  });

  test('把日志喂回来 → 同一份结论（重放可重算，不是只有运行期才有的字段）', () => {
    // 运行期那一刻，日志里只有**上一次**调用；重放时把同一段事件喂进来，基准就是同一条
    const atSecondCall: AppEvent[] = [consumedEvent(first, 1)];
    const replayed = detectCacheBreak(lastAuditedCall(atSecondCall), second);
    const live = detectCacheBreak(first, second);
    assert.deepEqual(replayed, live);
    assert.equal(replayed?.class, 'persona');
  });
});
