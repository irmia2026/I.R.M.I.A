/**
 * 观测面：**分节事实 + 新旧分段对照 + 构造点窗口**（2026-10-10）
 *
 * 这一条盯的是"下一次失守能不能**一次读**就定位"，三件事各钉一面：
 *
 *   ① **记忆层分节**（`context.memory.sections`）：技能目录 / MCP 索引 / 早期摘要三节各自的
 *      tokens / bytes / hash。现场（2026-10-09 18:07:11、18:08:28、18:08:54 三拍告警"原因不明"）
 *      的真因是**只有 MCP 索引那一行变了**（「工具清单还没拉过」→「已见 37 件工具…」，+6 token）；
 *      没有分节时这件事要靠事后逐字节重建才知道。
 *   ② **历史前段逐条**（`context.history.headItems`）：`headHash` 只说"前段变了"，逐条说"变的是第几条"。
 *      现场（2026-10-09 19:17:50，`hit=16512 / miss=37884`）真因是历史**第 1 条** item 被补了
 *      ` · 重投`（那一条后来由 v49 的 `NO_REQUEUED` 修掉；本条测试只钉"看得出来"）。
 *   ③ **窗口按构造点切**（`ContextBreakdown.builtAtSeq`）：`budget/consumed` 的 seq/ts 是调用
 *      **结束**的时刻，在飞 63 秒的调用会把真正的原因挡出窗口 ⇒ 误报 `unattributable` 并告警。
 *      这里同时钉新行为与**老日志的退路**（缺 `builtAtSeq` 时逐字段回到改动之前）。
 *
 * 纪律：本文件不读盘、不写盘、不依赖机器状态——输入全是构造出来的（判据是"渲染/比对这两处
 * 纯函数"，不是当前这台机器长什么样）。
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  detectCacheBreak, hashOf,
  type AuditedCall, type ContextBreakdown, type ContextSectionFact,
} from '../src/model/context-audit.ts';
import { RENDER_VERSION, render, type RenderInput, type RenderPersona } from '../src/model/render.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { estimateTokens } from '../src/tools/registry.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0_MS = Date.parse('2026-10-09T18:07:02.000Z');

const PERSONA: RenderPersona = {
  identity: 'IDENTITY：你是 Irmia。',
  constitution: 'CONSTITUTION：不越权。',
  style: 'STYLE：短句。',
  state: 'STATE：待命中。',
};

const TOOLS = [{ name: 'speak', description: '说话', parameters: { type: 'object', properties: {} } }];

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
    ...(o.mcpIndex === undefined ? {} : { mcpIndex: o.mcpIndex }),
  });
}

const pct = (text: string): ContextSectionFact => ({
  name: 'x', tokens: estimateTokens(text), bytes: Buffer.byteLength(text, 'utf8'), hash: hashOf(text),
});

function summaryEvent(seq: number, coveredUpToSeq: number, summary: string): AppEvent {
  return {
    seq,
    ts: new Date(T0_MS).toISOString(),
    type: 'compaction/summary',
    data: { coveredUpToSeq, summary },
    visibility: defaultVisibility('compaction/summary'),
  };
}

/** 一次被审计的调用（只给哨兵要的那几格；`builtAtSeq` 不给 = 老日志） */
function call(
  context: ContextBreakdown,
  minutes: number,
  hit: number,
  miss: number,
  extra: { seq?: number; builtAtSeq?: number } = {},
): AuditedCall {
  return {
    context,
    ts: new Date(T0_MS + minutes * 60_000).toISOString(),
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    ...(extra.seq === undefined ? {} : { seq: extra.seq }),
    ...(extra.builtAtSeq === undefined ? {} : { builtAtSeq: extra.builtAtSeq }),
  };
}

/** 手构一份上下文：只填哨兵要读的那几段（其余给稳定的占位） */
function contextOf(o: {
  memoryText?: string;
  sections?: ContextSectionFact[];
  headItems?: ContextSectionFact[];
  turn?: number;
} = {}): ContextBreakdown {
  const memoryText = o.memoryText ?? '[MCP server] 稳定的一屏';
  // headHash 按逐条哈希拼出来：只服务"两边可比/不可比"这个判断，不追求与渲染层同形
  const headHash = hashOf(JSON.stringify((o.headItems ?? []).map((item) => item.hash)));
  return {
    renderVersion: RENDER_VERSION,
    instructions: pct('IDENTITY：你是 Irmia。'),
    tools: { ...pct('speak 说话'), count: TOOLS.length },
    memory: {
      ...pct(memoryText),
      items: 1,
      ...(o.sections === undefined ? {} : { sections: o.sections }),
    },
    history: {
      ...pct('历史正文……'),
      items: 12,
      headHash,
      ...(o.headItems === undefined ? {} : { headItems: o.headItems }),
    },
    state: pct('STATE：待命中。'),
    now: pct('现在 18:07'),
    wake: pct(''),
    hint: pct(''),
    input: { items: 20, tokens: 1000 },
  };
}

// ──────────────────────────── ① 记忆层分节 ────────────────────────────

describe('记忆层分节：哪一节变了，一眼看出', () => {
  const SKILLS = '[可用技能] 以下是可按需使用的技能\n- anysearch: 搜索';
  const MCP_OLD = '[MCP server] 声明里有哪些 server\n- obscura —— 启用，工具清单还没拉过（要看就调 mcp 工具）';
  const MCP_NEW = '[MCP server] 声明里有哪些 server\n- obscura —— 启用，已见 37 件工具（来自缓存，取于 2026-10-09T17:55Z，可能过期）';
  const SUMMARY = '# 交接笔记\n把这一段往来收成一份笔记。';
  const EVENTS = [summaryEvent(10, 9, SUMMARY)];

  test('三节各记一份事实，顺序与渲染顺序一致（skills → mcp → summary）', () => {
    const rendered = renderOnce({ events: EVENTS, skillCatalog: SKILLS, mcpIndex: MCP_OLD });
    const sections = rendered.context.memory.sections;
    assert.deepEqual(sections?.map((s) => s.name), ['skills', 'mcp', 'summary']);
    // 每节的哈希/字节就是它自己那段文字（分隔符不计入任何一节）
    assert.equal(sections?.[0].hash, hashOf(SKILLS));
    assert.equal(sections?.[1].hash, hashOf(MCP_OLD));
    assert.ok((sections?.[1].bytes ?? 0) > 0, '字节数是可复算的硬数，必须记');
    assert.equal(sections?.[2].hash, hashOf(`[早期历史摘要 · 覆盖至 seq 9]\n${SUMMARY}`));
    // 整段哈希仍在：分节是**加在**它旁边，不是替掉它
    assert.ok(rendered.context.memory.hash.length > 0);
  });

  test('只有 MCP 索引那一行变了 ⇒ diff 指出 mcp，skills/summary 明说没变', () => {
    const prev = renderOnce({ events: EVENTS, skillCatalog: SKILLS, mcpIndex: MCP_OLD });
    const next = renderOnce({ events: EVENTS, skillCatalog: SKILLS, mcpIndex: MCP_NEW });
    assert.notEqual(prev.context.memory.hash, next.context.memory.hash, '前提：整段确实变了');

    const brk = detectCacheBreak(call(prev.context, 0, 1000, 10, { seq: 110 }), call(next.context, 1, 1000, 10, { seq: 112 }));
    assert.ok(brk !== null);
    assert.equal(brk.class, 'memory');
    const diff = brk.diff?.[0];
    assert.equal(diff?.class, 'memory');
    const byName = new Map((diff?.sections ?? []).map((s) => [s.name, s]));
    assert.equal(byName.get('mcp')?.changed, true);
    assert.equal(byName.get('skills')?.changed, false, '没变的节也要列出来（否则"没列"会被读成"没变"）');
    assert.equal(byName.get('summary')?.changed, false);
    assert.ok((byName.get('mcp')?.deltaBytes ?? 0) > 0, '变了多少字节要能直接读出来');
    assert.equal(byName.get('skills')?.deltaBytes, 0);
  });
});

// ─────────────────────── ② 历史前段：变的是第几条 ───────────────────────

describe('历史前段逐条：headHash 只说"前段变了"，逐条说"第几条"', () => {
  const head = (first: string): ContextSectionFact[] => [
    { ...pct(first), name: '#1' },
    { ...pct('{"type":"message","content":"第二条"}'), name: '#2' },
    { ...pct('{"type":"message","content":"第三条"}'), name: '#3' },
  ];

  test('第 1 条被改写 ⇒ diff 精确指到 #1，其余逐条写明没变', () => {
    const prev = contextOf({ headItems: head('[界面消息] 【框架通报 · 上下文压缩】…') });
    const next = contextOf({ headItems: head('[界面消息 · 重投] 【框架通报 · 上下文压缩】…') });
    assert.notEqual(prev.history.headHash, next.history.headHash, '前提：前段哈希确实变了');

    const brk = detectCacheBreak(call(prev, 0, 49000, 2000, { seq: 200 }), call(next, 1, 16512, 37884, { seq: 202 }));
    assert.ok(brk !== null);
    assert.equal(brk.class, 'history');
    const diff = brk.diff?.[0];
    assert.equal(diff?.class, 'history');
    // 历史段的"哈希"用 headHash（哨兵判的就是它）
    assert.equal(diff?.prevHash, prev.history.headHash);
    assert.equal(diff?.nextHash, next.history.headHash);
    const items = diff?.sections ?? [];
    assert.deepEqual(items.map((s) => s.name), ['#1', '#2', '#3']);
    assert.equal(items[0].changed, true);
    assert.equal(items[1].changed, false);
    assert.equal(items[2].changed, false);
  });

  test('两边都没有逐条事实（老日志）⇒ 不编分节（undefined 而不是空数组）', () => {
    const prev = contextOf({ memoryText: 'A' });
    const next = contextOf({ memoryText: 'B' });
    const brk = detectCacheBreak(call(prev, 0, 100, 10, { seq: 1 }), call(next, 1, 100, 10, { seq: 2 }));
    assert.ok(brk !== null);
    assert.equal(brk.diff?.[0].sections, undefined, '"拿不到分节"与"没有一节变了"必须能分开读');
  });
});

// ─────────────────── ③ 构造点窗口：修掉"原因不明"误报 ───────────────────

describe('归因窗口按构造点切：在飞久的调用不再把真因挡在窗口外', () => {
  // 现场形状（2026-10-09 18:07）：上一次调用**请求构造于压缩之前**，完成于压缩之后；
  // 压缩事件在它完成之后才写进日志 ⇒ 旧窗口（prev.seq, cur.seq）里空无一物 ⇒ 误报"原因不明"。
  const compaction: AppEvent = summaryEvent(105, 100, '# 交接笔记');

  test('有 builtAtSeq：压缩落进窗口 ⇒ cause=compaction、silent=true（不再告警）', () => {
    const prev = call(contextOf({ memoryText: '旧记忆层' }), 0, 178944, 2051, { seq: 110, builtAtSeq: 90 });
    const cur = call(contextOf({ memoryText: '新记忆层' }), 1, 11520, 8541, { seq: 112, builtAtSeq: 106 });
    const brk = detectCacheBreak(prev, cur, undefined, [compaction]);
    assert.ok(brk !== null);
    assert.equal(brk.class, 'memory');
    assert.equal(brk.cause, 'compaction');
    assert.equal(brk.silent, true, '设计内的压缩代价不该再进告警区');
  });

  test('没有 builtAtSeq（老日志）：退回按 seq 切 ⇒ 逐字段与改动之前一致（仍报 unattributable）', () => {
    const prev = call(contextOf({ memoryText: '旧记忆层' }), 0, 178944, 2051, { seq: 110 });
    const cur = call(contextOf({ memoryText: '新记忆层' }), 1, 11520, 8541, { seq: 112 });
    const brk = detectCacheBreak(prev, cur, undefined, [compaction]);
    assert.ok(brk !== null);
    assert.equal(brk.cause, 'unattributable');
    assert.equal(brk.silent, false);
  });
});
