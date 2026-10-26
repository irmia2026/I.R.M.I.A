/**
 * **框架通报的正文必须是纯文本**——一个 `**` 都不许有（2026-10-22 用户点名的硬性要求）
 *
 * ───────────────────────────────── 用户原话 ─────────────────────────────────
 *
 * > 「自我整理提示：……然后就不提示了。」
 * > 「……且文案里的 `**` 被**原样显示**在界面上（渲染层不认 Markdown）」
 *
 * 那条唤醒/通报正文是**给人在界面上读的**，不是给渲染器读的：`gui/lib/pages/chat_page.dart`
 * 把 `note` 原样塞进一个 `Text`，`**重点**` 会变成四个星号。所以这不是"风格"问题，
 * 是**硬性文案约束**：正文里要强调就用「」或换行。
 *
 * 这一份钉两件事（两层都扫，缺一层就会漏）：
 *
 *   ① **输出层**：把每一个通报构造器用**代表性素材**真的调一遍（每个分支各一份），
 *      正则断言产出的字符串里 `**` 出现 **0** 次。这是"她真正读到的那串字节"。
 *   ② **源码层**：读那些模块的源码，剥掉注释、只取**字符串字面量里的正文**，再断言 `**`
 *      出现 0 次。这样即使某个分支的素材这一份没构造出来（例如 `exec.failure` 的某一句），
 *      只要它写在通报类的函数体里就会被抓住。
 *
 * 为什么分两种扫法：`real-loop.ts` / `cache-alert.ts` / `main.ts` 这些文件里**别的地方**
 * 也有带 `**` 的字符串（控制台行、工具描述、doctor detail）——那些不进 GUI 的框架通报卡，
 * 本批不动它们。所以对它们只扫**通报构造器那一个函数体**；而对 `model/*` 与 `grant/*`
 * 那几个"整份都在产出给人读的话"的模块，就整份扫。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import type { RuntimeRestartPrevious } from '../src/log/types.ts';
import type { McpDeclarationChange } from '../src/mcp/client.ts';
import type { CacheAlertReading } from '../src/runtime/cache-alert.ts';
import type { EchoPressureSignals } from '../src/runtime/reasoning-echo-pressure.ts';

import { mcpReloadNoteOf } from '../src/main.ts';
import { GRANT_WAKE_CARD_SENTENCE, grantWakeNoteOf, type GrantWakeFacts } from '../src/grant/mcp-grant.ts';
import { skillGrantWakeNoteOf } from '../src/grant/skill-grant.ts';
import { compactionSoonNote } from '../src/model/compaction-warning.ts';
import { selfOrganizeNote } from '../src/model/self-organize-reminder.ts';
import { cacheAlertWakeNote } from '../src/runtime/cache-alert.ts';
import { compactionWakeNote, deathReasonText, restartWakeNote } from '../src/runtime/real-loop.ts';
import { echoPressureWakeNote } from '../src/runtime/reasoning-echo-pressure.ts';

/** 正则只有一处：正文里出现 `**` 就是违规（`g` 用来数次数，报错时能说清几处） */
const MARKDOWN_BOLD = /\*\*/gu;
const countMarks = (text: string): number => (text.match(MARKDOWN_BOLD) ?? []).length;

// ──────────────────────── ① 输出层：每个通报构造器的每个分支 ────────────────────────

/** MCP 加/删三态共用的素材（与 `test/mcp-grant.test.ts` 的 `CARD_FACTS` 同形） */
const MCP_FACTS: GrantWakeFacts = {
  id: 'g-90', kind: 'mcp-add', name: 'obscura',
  outcome: 'approved', reason: null,
  exec: { state: 'ok', landed: 'obscura' },
};

/** 技能装/删三态共用的素材（带脚本与不带脚本两支各一份） */
const SKILL_FACTS: GrantWakeFacts = {
  id: 'g-91', kind: 'skill-install', name: 'morning-review',
  outcome: 'approved', reason: null,
  exec: { state: 'ok', landed: 'morning-review' },
  scriptCount: 2,
};

/** 一份上一任留痕（重启通报的素材） */
const PREVIOUS: RuntimeRestartPrevious = {
  pid: 4242,
  startedAt: '2026-10-21T23:00:00.000+08:00',
  version: '0.1.0-beta.6',
  death: 'oom',
  abnormal: true,
  endedAt: null,
  endedReason: null,
  evidence: '上一任输出尾部有 "JavaScript heap out of memory"',
};

/** 缓存告警的读数（字段与 `CacheAlertPayload` 逐字同形） */
const CACHE_READING: CacheAlertReading = {
  lane: 'heavy',
  windowTurns: 20,
  missRatio: 0.3,
  baselineMissRatio: 0.01,
  estCostPerTurn: 37_100,
  estCostUnit: 'miss-equiv-tokens',
  topContributor: 'reasoning-echo-eviction',
  renderVersion: '77',
  missRatioBand: 3,
  windowCalls: 20,
  windowReasoningCalls: 2,
  windowRetries: 1,
};

/** 思维链回传压力的读数 */
const ECHO_SIGNALS: EchoPressureSignals = {
  turn: 12,
  step: 3,
  cap: 40_000,
  echoChars: 39_000,
  keptChars: 5_000,
  droppedGroups: 3,
  droppedChars: 34_000,
  evictedThisTurn: true,
};

/** 一份 MCP 声明变更（`main.ts` 那条热更通报的素材） */
const MCP_CHANGE = {
  added: ['obscura'], removed: [], changed: [], unchanged: [],
} as unknown as McpDeclarationChange;

/** 全部通报构造器 × 每个分支各一份（这是"她真正读到的那串字节"） */
const NOTICE_SAMPLES: ReadonlyArray<{ label: string; text: string }> = [
  // ── 压缩预警（`compact-soon`）──
  { label: '压缩临近（未过 100%）', text: compactionSoonNote({ historyTokens: 164_454, thresholdTokens: 200_000 }) },
  { label: '压缩临近（已过 100%）', text: compactionSoonNote({ historyTokens: 210_000, thresholdTokens: 200_000 }) },
  // ── 压缩之后（`compact`）──
  { label: '压缩之后（首次交接）', text: compactionWakeNote({ turn: 7, covered: 120, previous: 0, dataDir: 'D:\\data' }) },
  { label: '压缩之后（此前遮蔽过）', text: compactionWakeNote({ turn: 8, covered: 140, previous: 120, dataDir: '/tmp/data' }) },
  // ── 进程重启（`restart`）──
  ...(['oom', 'error', 'killed', 'unknown'] as const).map(death => ({
    label: `进程重启（上一任 ${death}）`,
    text: restartWakeNote({
      pid: 5150, version: '0.1.0-beta.6',
      previous: { ...PREVIOUS, death, pid: death === 'unknown' ? null : PREVIOUS.pid },
      at: '2026-10-22T08:00:00.000+08:00',
    }),
  })),
  { label: '上一任死因（首任/无痕迹）', text: deathReasonText({ ...PREVIOUS, death: 'unknown', pid: null }) },
  { label: '上一任死因（没能留下停机记录）', text: deathReasonText({ ...PREVIOUS, death: 'unknown', pid: 4242 }) },
  // ── 自我整理（`self-organize` × 2）──
  { label: '自我整理（第 1 次）', text: selfOrganizeNote(1) },
  { label: '自我整理（第 2 次）', text: selfOrganizeNote(2) },
  // ── 成本两条（`system`）──
  { label: '缓存成本告警', text: cacheAlertWakeNote(CACHE_READING) },
  { label: '思维链回传压力', text: echoPressureWakeNote(ECHO_SIGNALS, 0.975) },
  // ── 申请单结局（`grant`）──
  { label: 'MCP 申请（批准并落地）', text: grantWakeNoteOf(MCP_FACTS) },
  {
    label: 'MCP 申请（删除并落地）',
    text: grantWakeNoteOf({ ...MCP_FACTS, kind: 'mcp-remove', name: 'obscura', exec: { state: 'ok', landed: 'obscura' } }),
  },
  {
    label: 'MCP 申请（驳回，带理由）',
    text: grantWakeNoteOf({ ...MCP_FACTS, outcome: 'rejected', reason: '不想加' }),
  },
  {
    label: 'MCP 申请（驳回，没写理由）',
    text: grantWakeNoteOf({ ...MCP_FACTS, outcome: 'rejected', reason: '' }),
  },
  {
    label: 'MCP 申请（批准但没落地）',
    text: grantWakeNoteOf({ ...MCP_FACTS, exec: { state: 'failed', failure: '写配置时文件被锁住' } }),
  },
  {
    label: '技能申请（装成功，带脚本）',
    text: skillGrantWakeNoteOf(SKILL_FACTS),
  },
  {
    label: '技能申请（装成功，不带脚本）',
    text: skillGrantWakeNoteOf({ ...SKILL_FACTS, scriptCount: 0 }),
  },
  {
    label: '技能申请（删成功）',
    text: skillGrantWakeNoteOf({ ...SKILL_FACTS, kind: 'skill-remove', exec: { state: 'ok', landed: 'morning-review' } }),
  },
  {
    label: '技能申请（驳回）',
    text: skillGrantWakeNoteOf({ ...SKILL_FACTS, outcome: 'rejected', reason: '不要这个' }),
  },
  {
    label: '技能申请（批准但没落地）',
    text: skillGrantWakeNoteOf({ ...SKILL_FACTS, exec: { state: 'skipped-invalid', failure: '技能目录已经存在' } }),
  },
  { label: '申请单末尾那句"卡在哪"（共用常量）', text: GRANT_WAKE_CARD_SENTENCE },
  // ── MCP 声明热更（`mcp`，两条路各一份）──
  { label: 'MCP 声明热更（文件侧）', text: mcpReloadNoteOf(MCP_CHANGE, 2) },
  {
    label: 'MCP 声明热更（声明一个都不剩）',
    text: mcpReloadNoteOf({ added: [], removed: ['obscura'], changed: [], unchanged: [] } as unknown as McpDeclarationChange, 0),
  },
];

test('① 输出层：每个通报构造器产出的正文里 `**` 出现 0 次', () => {
  const bad: string[] = [];
  for (const sample of NOTICE_SAMPLES) {
    const marks = countMarks(sample.text);
    if (marks > 0) bad.push(`${sample.label}：${marks} 处 —— ${JSON.stringify(sample.text.slice(0, 160))}`);
  }
  assert.deepEqual(bad, [], `框架通报正文里不许出现 Markdown 记号（界面不渲染它）：\n${bad.join('\n')}`);
  // 素材表本身要够宽：少于这几十份就说明有分支没被代表性输入覆盖
  assert.ok(NOTICE_SAMPLES.length >= 20, `通报分支至少要覆盖 20 份（实测 ${NOTICE_SAMPLES.length} 份）`);
});

// ──────────────────────── ② 源码层：剥注释、只取字符串字面量 ────────────────────────

/** `**` 只许出现在注释里：把一段源码的字符串字面量正文拼起来（注释与代码一律丢掉） */
function stringLiteralTextOf(source: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    // 行注释 / 块注释：整段跳过（`**` 写在注释里是允许的，那是给人读的文档）
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let text = '';
      while (j < source.length) {
        const c = source[j]!;
        if (c === '\\') {
          text += source.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (c === quote) break;
        text += c;
        j += 1;
      }
      parts.push(text);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return parts.join('\n');
}

/** 跳过一段字符串（返回闭合引号的下标；模板字面量整段跳过，`${}` 里的括号不参与配对） */
function skipStringAt(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i;
    i += 1;
  }
  return source.length - 1;
}

/**
 * 按声明把函数体切出来（**不按调用点**：`this.foo(` / 注释里提到的名字都不能算）。
 *
 * 只认两种声明形状——`function NAME(`（含 `export` / `async`）与
 * `private|public|protected NAME(`（方法）。这两种覆盖了本仓全部通报构造器。
 */
function functionBodyOf(source: string, name: string): string {
  const declaration = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`
    + `|(?:^|\\n)\\s*(?:private|public|protected)\\s+(?:static\\s+)?(?:async\\s+)?${name}\\s*\\(`,
    'u',
  );
  const match = declaration.exec(source);
  assert.ok(match !== null, `源码里找不到 ${name} 的声明（不是 function NAME( 也不是 private NAME(）`);
  const open = source.indexOf('{', match.index);
  assert.ok(open >= 0, `${name} 后面找不到函数体的左花括号`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipStringAt(source, i);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合（扫描器出错了？）`);
}

const srcPath = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const readSrc = (rel: string): string => readFileSync(srcPath(rel), 'utf8');

/**
 * 整份扫的模块：它们**整份都在产出给人读的话**（判据 + 文案），没有"日志行"那一类
 * 不上面儿的字符串。`grant/*` 两支连卡面与工具回执也算了——那是同一类给人看的字。
 */
const WHOLE_FILE_MODULES = [
  'src/model/compaction-warning.ts',
  'src/model/self-organize-reminder.ts',
  'src/grant/mcp-grant.ts',
  'src/grant/skill-grant.ts',
];

/**
 * 只扫**通报构造器那一个函数体**的模块：同一文件里还有控制台行 / doctor detail / 工具描述
 * 等**不进 GUI 通报卡**的字符串，它们不在本批的约束里（本批不动那些字节）。
 */
const NOTICE_BUILDERS: ReadonlyArray<{ file: string; fn: string }> = [
  { file: 'src/runtime/real-loop.ts', fn: 'compactionWakeNote' },
  { file: 'src/runtime/real-loop.ts', fn: 'restartWakeNote' },
  { file: 'src/runtime/real-loop.ts', fn: 'deathReasonText' },
  { file: 'src/runtime/cache-alert.ts', fn: 'cacheAlertWakeNote' },
  { file: 'src/runtime/reasoning-echo-pressure.ts', fn: 'echoPressureWakeNote' },
  { file: 'src/main.ts', fn: 'mcpReloadNoteOf' },
  { file: 'src/web/server.ts', fn: 'mcpChangeWakeNoteOf' },
  { file: 'src/runtime/agent-loop.ts', fn: 'notifyAbandonedInputs' },
];

test('② 源码层：整份模块的字符串字面量里 `**` 出现 0 次（注释不算）', () => {
  const bad: string[] = [];
  for (const file of WHOLE_FILE_MODULES) {
    const text = stringLiteralTextOf(readSrc(file));
    const marks = countMarks(text);
    if (marks > 0) {
      const hit = text.split('\n').filter(line => countMarks(line) > 0).slice(0, 3);
      bad.push(`${file}：${marks} 处 —— ${JSON.stringify(hit)}`);
    }
  }
  assert.deepEqual(bad, [], `这些模块的运行时字符串里不许出现 Markdown 记号：\n${bad.join('\n')}`);
});

test('②b 源码层：每个通报构造器的函数体里 `**` 出现 0 次（注释不算）', () => {
  const bad: string[] = [];
  for (const { file, fn } of NOTICE_BUILDERS) {
    const body = functionBodyOf(readSrc(file), fn);
    const marks = countMarks(stringLiteralTextOf(body));
    if (marks > 0) {
      const hit = stringLiteralTextOf(body).split('\n').filter(line => countMarks(line) > 0).slice(0, 3);
      bad.push(`${file} ${fn}：${marks} 处 —— ${JSON.stringify(hit)}`);
    }
  }
  assert.deepEqual(bad, [], `通报构造器的正文里不许出现 Markdown 记号：\n${bad.join('\n')}`);
});
