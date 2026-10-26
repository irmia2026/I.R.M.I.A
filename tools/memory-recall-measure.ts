/**
 * Irmia Agent — **记忆召回的只读测量器**（阶段一/三：先测量，后设计）
 *
 * 跑法：
 *
 *   node --experimental-strip-types tools/memory-recall-measure.ts
 *   node --experimental-strip-types tools/memory-recall-measure.ts --emit-eval      # 只导出人眼标注样本
 *   node --experimental-strip-types tools/memory-recall-measure.ts --anonymize      # 换名对照实验
 *   node --experimental-strip-types tools/memory-recall-measure.ts --emit-dictionary medium
 *
 * 产物一律写到**仓库外**的 `memory-recall/`（`--out` 可改）：缺省落在系统临时目录
 * （`<os.tmpdir()>/irmia-measure/memory-recall/`），或用环境变量 `IRMIA_MEASURE_DIR` 指定根目录。
 * **本工具绝不写 `data/**`，也不往仓库里建任何目录**（仓库是"源 + 文档"，不是测量台；
 * 以前缺省写 `_research/` —— 那棵树 2026-10-23 已经整个搬出仓库了）。
 *
 * ──────────────────────────────── 它回答哪四个数 ────────────────────────────────
 *
 *   a. 平凡闲聊里"专名/新词命中"的比例（应很低）
 *   b. 涉及未知事实的轮次里命中的比例（应很高）
 *   c. 按 a/b 开触发 ⇒ 每轮平均注入 token 与触发率
 *   d. 三种阈值组合下的漏召回率与省下的 token
 *
 * 另外单独报两件事（2026-10-19 用户要求）：
 *   · **命名位置证据在 U 类上的命中率**——分开"证据不够"与"证据没接上"；
 *   · `no-candidate`（触发但无候选）的占比——它要靠**相对相关度下限**才有意义。
 *
 * ──────────────────────────────── 口径（与运行期同一份实现） ────────────────────────────────
 *
 * 这个文件**不重复实现**判据：发现器只产"候选 + 分量"，晋升/匹配/触发/注入全部调
 * `src/persona/recall.ts`（运行期那份）。于是"测量出来的数"与"跑起来的行为"是同一套代码。
 * 唯一属于本文件的是：**命名位置证据的抽取**（只有构建器需要，运行期只读词典文件）。
 *
 * 阈值全部是**本安装候选池的分位数**（没有从语料拟合出来的绝对常量）：
 *   · 熵 / count 下界 / count 上界 / 日数上界 —— 四个分位；
 *   · 晋升的硬门换成**命名位置证据 ≥ 2**（结构下限，与"跨 ≥2 天"同级），
 *     **PMI 只当辅助分**（它歧视"常用字拼出来的中文实体名"，实测三个漏召回例子全是这种）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMemoryIndex } from '../src/persona/memory-injection.ts';
import { renderMemoryRecommendation, selectMemoryRecommendation } from '../src/persona/memory-select.ts';
import {
  buildBodyMatcher, buildRecallMatcher, gateRecall, matchRecall, planRecallInjection, planRecallTurn,
  promoteRecallWords,
  quantileOf, recallDictionaryJsonl, recallThresholds,
  type RecallCandidate, type RecallState, type RecallThresholds,
} from '../src/persona/recall.ts';
import { estimateTokens } from '../src/tools/registry.ts';
import type { MemoryIndexEntry } from '../src/persona/memory-injection.ts';
import type { MemoryQueryInput } from '../src/persona/memory-select.ts';

// ──────────────────────────────── 参数（全部是比例 / 结构，不是语料拟合值） ────────────────────────────────

/** n-gram 的长度范围（用户原话：2–6 字） */
const NGRAM_MIN = 2;
const NGRAM_MAX = 6;

/** 候选池边界：语料里出现过 ≥2 次才进池（"重复"是词的前提，也是分位数有意义的前提） */
const POOL_MIN_COUNT = 2;

/**
 * 三个阈值组合（松 / 中 / 紧）。**全部是分位数**，每个都是 0–1 的比例。
 *
 * ⚠ 与最初设想的三处**实测修正**（2026-10-19，见报告）：
 *   ① count 曾经是**双向门**：单向的"够常用"只会选出通用词；
 *   ② **上界后来交给了"日数门"**：`count` 上界实测误杀了高频但真实的名字
 *      （`吱吱` 230、`1号` 228、`测试群` 524 都被 count 上界 222 挡在门外），
 *      而"太常用反而是通用词"这件事**日数门管得更准**（通用词 15–20 天都在，名字 2–12 天）；
 *      于是 countMax 置 1（不设上界），对照读数在报告里两版都留着；
 *   ③ **PMI 不再是硬门**（降级为辅助分），硬门换成"命名位置证据 ≥2"——
 *      PMI 歧视"常用字拼出来的名字"（`内测群`/`测试群`/`长门` 全都没过门槛）。
 *      `pmi` 这个分位现在只用于报告里那一列"辅助分读数"。
 */
const QUANTILE_COMBOS = [
  { id: 'loose', pmi: 0.8, entropy: 0.7, countMin: 0.25, countMax: 1, daysMax: 0.99, minIdfQuantile: 0.1 },
  { id: 'medium', pmi: 0.9, entropy: 0.8, countMin: 0.5, countMax: 1, daysMax: 0.95, minIdfQuantile: 0.25 },
  { id: 'tight', pmi: 0.95, entropy: 0.9, countMin: 0.75, countMax: 1, daysMax: 0.9, minIdfQuantile: 0.5 },
] as const;

/** 评测集目标条数（人眼标注的规模） */
const EVAL_SAMPLE_TARGET = 200;

/** 语料规模档位（"越用越好"的横轴；单位 = 对话消息条数） */
const DEFAULT_TIERS = [80, 1000, 5000, 20000];

/**
 * "在上下文里"这一判据的**可见历史**容量（字符）。取整段可见历史时按这个上限截断。
 *
 * 为什么是个上限而不是"全部"：运行期也必须有界（否则每轮都要扫几十万条），
 * 而且越往前的历史越可能已经被压缩遮蔽。它是**容量参数**，不是阈值：
 * 报告里给 20k / 60k 两档的读数，让"窗口大小影响多大"看得见。
 */
const DEFAULT_VISIBLE_CHARS = 60000;

// ──────────────────────────────── 字符类分块（不假设中文） ────────────────────────────────

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
const LATIN_RE = /[A-Za-z]/u;
const DIGIT_RE = /[0-9]/u;

type RunKind = 'cjk' | 'latin' | 'digit';
interface Run { kind: RunKind; start: number; end: number; text: string }

/** 把文本切成同类字符的连续块（三类各有用途，其余字符一律是分隔符） */
export function segmentRuns(text: string): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    let kind: RunKind | null = null;
    if (CJK_RE.test(ch)) kind = 'cjk';
    else if (LATIN_RE.test(ch)) kind = 'latin';
    else if (DIGIT_RE.test(ch)) kind = 'digit';
    if (kind === null) { i += 1; continue; }
    const start = i;
    let j = i + 1;
    while (j < text.length) {
      const c = text[j] as string;
      if (kind === 'cjk') { if (!CJK_RE.test(c)) break; }
      else if (kind === 'latin') { if (!/[A-Za-z0-9_'’-]/u.test(c)) break; }
      else if (!DIGIT_RE.test(c)) break;
      j += 1;
    }
    runs.push({ kind, start, end: j, text: text.slice(start, j) });
    i = j;
  }
  return runs;
}

interface Window { key: string; start: number; end: number; len: number }

/**
 * 一段文本 → 候选窗口（发现与"在不在记忆里"共用这一个扫法）：
 *   · CJK 块内 1–6 字 n-gram（单字只用于 PMI 分母）；
 *   · 拉丁块整词（小写归一）；
 *   · 数字前缀名（≤3 位数字紧跟 1–3 个 CJK 字，`1号` 这类标识符）。
 */
function forEachWindow(text: string, cb: (w: Window) => void): void {
  const runs = segmentRuns(text);
  for (let r = 0; r < runs.length; r += 1) {
    const run = runs[r] as Run;
    if (run.kind === 'cjk') {
      const chars = [...run.text];
      for (let i = 0; i < chars.length; i += 1) {
        cb({ key: chars[i] as string, start: run.start + i, end: run.start + i + 1, len: 1 });
        for (let n = NGRAM_MIN; n <= NGRAM_MAX; n += 1) {
          if (i + n > chars.length) break;
          cb({ key: chars.slice(i, i + n).join(''), start: run.start + i, end: run.start + i + n, len: n });
        }
      }
      continue;
    }
    if (run.kind === 'latin') {
      cb({ key: run.text.toLowerCase(), start: run.start, end: run.end, len: 0 });
      continue;
    }
    const next = runs[r + 1];
    if (next === undefined || next.kind !== 'cjk' || next.start !== run.end) continue;
    if (run.text.length > 3) continue;
    const chars = [...next.text];
    for (let k = 1; k <= 3 && k <= chars.length; k += 1) {
      cb({ key: `${run.text}${chars.slice(0, k).join('')}`, start: run.start, end: next.start + k, len: 0 });
    }
  }
}

function kindOf(key: string): 'cjk' | 'latin' | 'mixed' {
  const first = key[0] as string;
  if (CJK_RE.test(first)) return 'cjk';
  if (DIGIT_RE.test(first)) return 'mixed';
  return 'latin';
}

/** 香农熵（bit）。⚠ 必须先落成数组：Iterable 只能遍历一次（这个 bug 我们真写过一次） */
export function entropyOfBits(counts: Iterable<number>): number {
  const values = Array.isArray(counts) ? counts : [...counts];
  let total = 0;
  for (const n of values) total += n;
  if (total <= 0) return 0;
  let h = 0;
  for (const n of values) {
    if (n <= 0) continue;
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function dayOf(ts: string): string {
  return ts.slice(0, 10);
}

// ──────────────────────────────── 事件 → 语料 / 轮次 / 可见历史 ────────────────────────────────

export interface CorpusUnit { seq: number; ts: string; kind: 'user' | 'assistant'; text: string }

export interface TurnRecord {
  turn: number;
  ts: string;
  texts: string[];
  wakeSeqs: number[];
  sources: string[];
  memReads: number;
  injectedChars: number | null;
  selectedCount: number | null;
}

export interface EventScan {
  cacheVersion: number;
  files: Array<{ name: string; size: number; mtimeMs: number }>;
  units: CorpusUnit[];
  turns: TurnRecord[];
  /** 压缩遮蔽点（`compaction/summary.coveredUpToSeq`），升序；"可见历史"的起点 */
  masks: Array<{ seq: number; coveredUpToSeq: number }>;
  firstTs: string;
  lastTs: string;
  eventCount: number;
  typeCounts: Record<string, number>;
}

const EVENT_SCAN_CACHE_VERSION = 3;

function eventsFingerprint(eventsDir: string): EventScan['files'] {
  return readdirSync(eventsDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const st = statSync(join(eventsDir, name));
      return { name, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
    });
}

/**
 * 扫一遍事件日志，抽四样东西：**语料单位**、**每轮的人话**、**注入账**、**压缩遮蔽点**。
 *
 * 口径：
 *   · 人话 = `wake/channel.text` + `wake/manual.note`（`message/user` 是渲染后的包装，不用）；
 *   · 轮 ↔ 人话 = `input/claimed.wakeSeqs`（日志里唯一的权威对应）；
 *   · 她的话 = `message/assistant.text`（`message/reasoning` 不进语料：2700 万字自问自答会把 PMI 带偏）；
 *   · 可见历史 = seq 大于最近一次压缩遮蔽点的那批消息（③ 的判据）。
 */
export function scanEvents(eventsDir: string): EventScan {
  const files = eventsFingerprint(eventsDir);
  const typeCounts: Record<string, number> = {};
  const units: CorpusUnit[] = [];
  const wakeText = new Map<number, { text: string; source: string }>();
  const turns = new Map<number, TurnRecord>();
  const masks: Array<{ seq: number; coveredUpToSeq: number }> = [];
  let eventCount = 0;
  let firstTs = '';
  let lastTs = '';

  const turnOf = (turn: number, ts: string): TurnRecord => {
    let rec = turns.get(turn);
    if (rec === undefined) {
      rec = { turn, ts, texts: [], wakeSeqs: [], sources: [], memReads: 0, injectedChars: null, selectedCount: null };
      turns.set(turn, rec);
    }
    return rec;
  };

  for (const file of files) {
    const raw = readFileSync(join(eventsDir, file.name), 'utf8');
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      eventCount += 1;
      const type = String(ev.type);
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      const ts = String(ev.ts);
      if (firstTs === '' || ts < firstTs) firstTs = ts;
      if (lastTs === '' || ts > lastTs) lastTs = ts;
      const data = ev.data ?? {};
      switch (type) {
        case 'wake/channel': {
          const text = typeof data.text === 'string' ? data.text : '';
          if (text !== '') { wakeText.set(ev.seq, { text, source: String(data.chatType ?? 'channel') }); units.push({ seq: ev.seq, ts, kind: 'user', text }); }
          break;
        }
        case 'wake/manual': {
          const text = typeof data.note === 'string' ? data.note : '';
          if (text !== '') { wakeText.set(ev.seq, { text, source: 'manual' }); units.push({ seq: ev.seq, ts, kind: 'user', text }); }
          break;
        }
        case 'message/assistant': {
          const text = typeof data.text === 'string' ? data.text : '';
          if (text.trim() !== '') units.push({ seq: ev.seq, ts, kind: 'assistant', text });
          break;
        }
        case 'turn/start': { turnOf(Number(data.turn), ts); break; }
        case 'input/claimed': {
          const rec = turnOf(Number(data.turn), ts);
          for (const seq of (Array.isArray(data.wakeSeqs) ? data.wakeSeqs : []) as number[]) {
            const wake = wakeText.get(seq);
            if (wake === undefined) continue;
            rec.texts.push(wake.text);
            rec.wakeSeqs.push(seq);
            rec.sources.push(wake.source);
          }
          break;
        }
        case 'memory/read': { turnOf(Number(data.turn), ts).memReads += 1; break; }
        case 'memory/selected': {
          const rec = turnOf(Number(data.turn), ts);
          if (typeof data.injected === 'string') rec.injectedChars = data.injected.length;
          if (Array.isArray(data.selected)) rec.selectedCount = data.selected.length;
          break;
        }
        case 'compaction/summary': {
          const covered = Number(data.coveredUpToSeq);
          if (Number.isFinite(covered) && covered > 0) masks.push({ seq: Number(ev.seq), coveredUpToSeq: covered });
          break;
        }
        default: break;
      }
    }
  }

  units.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
  masks.sort((a, b) => a.seq - b.seq);
  const turnList = [...turns.values()].sort((a, b) => (a.ts === b.ts ? a.turn - b.turn : a.ts < b.ts ? -1 : 1));
  return { cacheVersion: EVENT_SCAN_CACHE_VERSION, files, units, turns: turnList, masks, firstTs, lastTs, eventCount, typeCounts };
}

// ──────────────────────────────── 记忆资产 + 命名位置证据（只读） ────────────────────────────────

export interface MemoryAssets {
  /** 每轮必进固定块的那四份（IDENTITY / CONSTITUTION / STYLE / STATE） */
  fixedBlock: string;
  /** 全部记忆资产（persona/** + workspace/MEMORIES/**） */
  memory: string;
  /**
   * **命名位置证据**（按线索种类分组；只有"结论型"文件参与）。
   *
   * ⚠ 语料里**排除 `episodes/` 与 `diary/`**（那两份是对话转写，引用多、噪声大：
   * 带着它们时"电脑"会拿到 9 条证据、"什么"能拿到 61 条）。结论型文件
   * （facts / aliases / jargon / style-notes / assets / notes-* / RELATIONSHIPS / persona）
   * 才是她**写下"这叫什么"**的地方。
   *
   * ⚠ **按种类分开存**是刻意的：晋升要求"至少两种不同线索"，见 recall.ts 的
   * `RECALL_MIN_EVIDENCE_KINDS`（单一来源——尤其是引号——太弱）。
   */
  namingEvidence: Array<{ kind: string; text: string }>;
  files: string[];
}

const FIXED_BLOCK_FILES = ['IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md', 'STATE.md'];

function collectMarkdown(root: string, out: string[]): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) collectMarkdown(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
}

/**
 * **命名位置证据的抽取**（格式判据，不认任何具体词 ⇒ 换一个人设照样成立）。
 *
 * 七类证据，都是"这个词被当作名字用过"的语法痕迹：
 *   ① 行首标题（`# <名字>`）                       ② `X = Y` / `X：Y` 的**值**位
 *   ③ `「」『』“”《》` 引号内                       ④ `@某人`
 *   ⑤ `叫/名叫/名为/昵称是/别名是/外号是/群名是` 之后的词
 *   ⑥ `群/号/家/店/铺/台` **之前**的尾巴（≤4 字头 + 后缀）
 *   ⑦ 联系人文件名（`RELATIONSHIPS/<名字>.md`）
 *
 * ⚠ 刻意**不含裸"是"**：中文里"是"太泛（"是不是已经…"会被当成命名），实测噪声 > 信息。
 * ⚠ 标签会**连着上下文**（例如"去内测群"），所以匹配时用滑窗找候选，不要求整段相等。
 */
export function collectNamingEvidence(
  files: readonly string[],
  readText: (path: string) => string,
): Array<{ kind: string; text: string }> {
  const byKind = new Map<string, string[]>();
  const push = (kind: string, s: string | undefined): void => {
    const t = (s ?? '').trim();
    if (t.length < 2 || t.length > 24) return;
    const list = byKind.get(kind) ?? [];
    list.push(t);
    byKind.set(kind, list);
  };
  for (const full of files) {
    if (/[\\/](episodes|diary)[\\/]/u.test(full)) continue;
    for (const line of readText(full).split('\n')) {
      const t = line.trim();
      if (t === '') continue;
      if (t.startsWith('#')) push('heading', t.replace(/^#+\s*/u, ''));
      const assign = /^[^=：:]{1,24}[=：:]\s*(.+)$/u.exec(t);
      if (assign) push('assign', assign[1]);
      for (const m of t.matchAll(/[「『“"《]([^」』”"》]{1,24})[」』”"》]/gu)) push('quote', m[1]);
      for (const m of t.matchAll(/@([^\s,,。，、:：]{1,24})/gu)) push('at', m[1]);
      for (const m of t.matchAll(/(?:叫做|名叫|名为|昵称是?|别名是?|外号是?|群名是?|叫)\s*([\u4e00-\u9fffA-Za-z0-9_]{1,12})/gu)) push('call', m[1]);
      for (const m of t.matchAll(/[\u4e00-\u9fff]{1,6}(?:[\u7fa4\u53f7\u5bb6\u5e97\u94fa\u53f0])/gu)) {
        // 只发最长的那一截（不在这里拆尾巴）：拆尾巴会造出 "试群"/"丝群" 这类碎片，
        // 而"哪一截才是名字"要靠语料自己的词频来判——那一步在 annotateEvidence 里做。
        push('suffix', m[0]);
      }
    }
  }
  for (const full of files) {
    const m = /RELATIONSHIPS[\\/](.+)\.md$/u.exec(full);
    if (m) push('filename', m[1]);
  }
  return [...byKind.entries()].map(([kind, spans]) => ({ kind, text: spans.join('\n') }));
}

export function readMemoryAssets(dataDir: string): MemoryAssets {
  const personaDir = join(dataDir, 'persona');
  const memoriesDir = join(dataDir, 'workspace', 'MEMORIES');
  const files: string[] = [];
  collectMarkdown(personaDir, files);
  collectMarkdown(memoriesDir, files);
  const texts = new Map<string, string>();
  for (const full of files) texts.set(full, readFileSync(full, 'utf8'));
  const fixedParts: string[] = [];
  const allParts: string[] = [];
  for (const full of files) {
    const text = texts.get(full) as string;
    allParts.push(text);
    if (FIXED_BLOCK_FILES.some((name) => full.endsWith(`${name}`)) && full.includes(join(dataDir, 'persona'))) fixedParts.push(text);
  }
  return {
    fixedBlock: fixedParts.join('\n'),
    memory: allParts.join('\n'),
    namingEvidence: collectNamingEvidence(files, (p) => texts.get(p) as string),
    files: files.map((full) => relative(dataDir, full).replace(/\\/gu, '/')),
  };
}

// ──────────────────────────────── 新词发现（两遍扫描） ────────────────────────────────

export interface Candidate {
  word: string;
  kind: 'cjk' | 'latin' | 'mixed';
  count: number;
  pmi: number | null;
  leftEntropy: number;
  rightEntropy: number;
  minEntropy: number;
  distinctDays: number;
  firstSeen: string;
  lastSeen: string;
  inMemory: boolean;
  inFixedBlock: boolean;
  inUnits: number;
  /** 命名位置证据条数（硬门，见 `src/persona/recall.ts` 的 RECALL_MIN_NAMING_EVIDENCE） */
  evidence: number;
  /** 证据的**种类数**（诊断用） */
  evidenceKinds: number;
  /** 证据的**加权分**（3×强线索 + 2×中线 + 1×弱线索；晋升就看这一格） */
  evidenceWeight: number;
  /** **强线索**条数（heading/assign/at/call/filename；一票通过要求 ≥1） */
  evidenceStrong: number;
}

interface RawCount { count: number; firstSeen: string; lastSeen: string; units: number; lastUnit: number }

function neighborKey(ch: string | undefined): string {
  if (ch === undefined) return '<edge>';
  if (/\s/u.test(ch)) return '<sp>';
  return ch;
}

export interface DiscoveryResult {
  cands: Map<string, Candidate>;
  totalWindows: number;
}

/**
 * 发现候选词。**两遍**：① 数 count / 首末时间；② 只对重复出现过的候选收邻域、跨天。
 *
 * 不用 jieba 的理由：这一层要的是**本安装自己的词**（人名、地名、OC 名、这个世界的术语），
 * 通用分词器给的是"通用词表里的词"——恰好是这里最不需要的那一半，而且它会把生造的名字
 * 切成两半，让"专名触发"永远不命中。零依赖是附带的好处，不是理由。
 */
export function discoverCandidates(units: readonly CorpusUnit[]): DiscoveryResult {
  const counts = new Map<string, RawCount>();
  const gramsByLen = new Map<number, number>();

  const bump = (key: string, ts: string, unitIdx: number, len: number): void => {
    let rec = counts.get(key);
    if (rec === undefined) { rec = { count: 0, firstSeen: ts, lastSeen: ts, units: 0, lastUnit: -1 }; counts.set(key, rec); }
    rec.count += 1;
    if (ts < rec.firstSeen) rec.firstSeen = ts;
    if (ts > rec.lastSeen) rec.lastSeen = ts;
    if (rec.lastUnit !== unitIdx) { rec.units += 1; rec.lastUnit = unitIdx; }
    if (len > 0) gramsByLen.set(len, (gramsByLen.get(len) ?? 0) + 1);
  };

  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u] as CorpusUnit;
    forEachWindow(unit.text, (w) => bump(w.key, unit.ts, u, w.len));
  }

  const recurring = new Set<string>();
  for (const [key, rec] of counts) if (rec.count >= POOL_MIN_COUNT) recurring.add(key);
  const leftN = new Map<string, Map<string, number>>();
  const rightN = new Map<string, Map<string, number>>();
  const days = new Map<string, Set<string>>();
  for (const key of recurring) { leftN.set(key, new Map()); rightN.set(key, new Map()); days.set(key, new Set()); }

  const addNeighbor = (table: Map<string, Map<string, number>>, key: string, nk: string): void => {
    const inner = table.get(key);
    if (inner === undefined) return;
    inner.set(nk, (inner.get(nk) ?? 0) + 1);
  };

  for (const unit of units) {
    const text = unit.text;
    const day = dayOf(unit.ts);
    forEachWindow(text, (w) => {
      if (!recurring.has(w.key)) return;
      addNeighbor(leftN, w.key, neighborKey(w.start > 0 ? text[w.start - 1] : undefined));
      addNeighbor(rightN, w.key, neighborKey(w.end < text.length ? text[w.end] : undefined));
      (days.get(w.key) as Set<string>).add(day);
    });
  }

  const byLenTotal = (len: number): number => gramsByLen.get(len) ?? 0;
  const out = new Map<string, Candidate>();
  for (const key of recurring) {
    const kind = kindOf(key);
    const len = kind === 'cjk' ? [...key].length : 0;
    // 单字 CJK 不是候选（只当 PMI 分母）：放进来会让"吧/拿/七"这类高频单字全部过关
    if (kind === 'cjk' && len < NGRAM_MIN) continue;
    const rec = counts.get(key) as RawCount;
    let pmi: number | null = null;
    if (kind === 'cjk' && len >= NGRAM_MIN) {
      const total = byLenTotal(len);
      let minPmi = Number.POSITIVE_INFINITY;
      const chars = [...key];
      for (let i = 1; i < len; i += 1) {
        const cl = counts.get(chars.slice(0, i).join(''))?.count ?? 0;
        const cr = counts.get(chars.slice(i).join(''))?.count ?? 0;
        const tl = byLenTotal(i);
        const tr = byLenTotal(len - i);
        if (cl <= 0 || cr <= 0 || total <= 0 || tl <= 0 || tr <= 0) continue;
        const pmiI = Math.log2((rec.count / total) / ((cl / tl) * (cr / tr)));
        if (pmiI < minPmi) minPmi = pmiI;
      }
      pmi = Number.isFinite(minPmi) ? minPmi : null;
    }
    const leftEntropy = entropyOfBits((leftN.get(key) as Map<string, number>).values());
    const rightEntropy = entropyOfBits((rightN.get(key) as Map<string, number>).values());
    out.set(key, {
      word: key, kind, count: rec.count, pmi, leftEntropy, rightEntropy,
      minEntropy: Math.min(leftEntropy, rightEntropy), distinctDays: (days.get(key) as Set<string>).size,
      firstSeen: rec.firstSeen, lastSeen: rec.lastSeen, inMemory: false, inFixedBlock: false,
      inUnits: rec.units, evidence: 0, evidenceKinds: 0, evidenceWeight: 0, evidenceStrong: 0,
    });
  }
  let totalWindows = 0;
  for (const rec of counts.values()) totalWindows += rec.count;
  return { cands: out, totalWindows };
}

/** 标"在不在记忆里 / 在不在固定块里"（与发现共用同一个滑窗，两处判据同源） */
export function annotateProvenance(cands: Map<string, Candidate>, assets: MemoryAssets): void {
  const mark = (text: string, field: 'inMemory' | 'inFixedBlock'): void => {
    forEachWindow(text, (w) => { const cand = cands.get(w.key); if (cand !== undefined) cand[field] = true; });
  };
  mark(assets.memory, 'inMemory');
  mark(assets.fixedBlock, 'inFixedBlock');
}

/** 标"被命名过几次"（证据文本里每出现一次算一条） */
export function annotateEvidence(
  cands: Map<string, Candidate>,
  byKind: readonly { kind: string; text: string }[],
): void {
  const STRONG = new Set(['heading', 'assign', 'at', 'call', 'filename']);
  const weightOf = (kind: string): number => (kind === 'suffix' ? 2 : (STRONG.has(kind) ? 3 : 1));
  const totals = new Map<string, { weight: number; kinds: Set<string>; strong: number }>();
  const mark = (word: string, kind: string): void => {
    const cand = cands.get(word);
    if (cand === undefined) return;
    cand.evidence += 1;
    const acc = totals.get(word) ?? { weight: 0, kinds: new Set<string>(), strong: 0 };
    acc.weight += weightOf(kind);
    acc.kinds.add(kind);
    if (STRONG.has(kind)) acc.strong += 1;
    totals.set(word, acc);
  };
  for (const { kind, text } of byKind) {
    for (const span of text.split('\n')) {
      if (span === '') continue;
      if (kind === 'suffix') {
        /**
         * **suffix 去脏**（第三轮）：从"最长的名字部分"往回收，取**第一个在语料里出现 ≥2 次**的
         * 头部，只给 `头+后缀` 这一个词记证据（**不再把尾巴都算上**）。
         *
         * 两个实测依据：
         *   · 不拆尾巴 ⇒ 不再造出 `试群`/`丝群` 这类碎片（它们曾把词典灌满）；
         *   · 头部必须自己是个词 ⇒ `国家`(国+家)、`大家`(大+家)、`老家`、`编号`(编+号) 全部出局，
         *     而 `测试群` 的头部 `测试`、`内测群` 的 `内测` 都是高频词 ⇒ 留下。
         */
        const chars = [...span];
        if (chars.length < 3) continue;
        const suffixChar = chars[chars.length - 1] as string;
        const headChars = chars.slice(0, -1);
        let resolved = '';
        for (let k = headChars.length; k >= 2; k -= 1) {
          const head = headChars.slice(headChars.length - k).join('');
          if ((cands.get(head)?.count ?? 0) >= 2) { resolved = head + suffixChar; break; }
        }
        if (resolved !== '') mark(resolved, kind);
        continue;
      }
      forEachWindow(span, (w) => mark(w.key, kind));
    }
  }
  for (const [word, acc] of totals) {
    const cand = cands.get(word);
    if (cand !== undefined) {
      cand.evidenceWeight = acc.weight;
      cand.evidenceKinds = acc.kinds.size;
      cand.evidenceStrong = acc.strong;
    }
  }
}

/** 候选池：重复出现过 + 在记忆里 + 不在固定块里（**证据与其余门槛交给晋升那一步**） */
export function poolOf(cands: Iterable<Candidate>): Candidate[] {
  const pool: Candidate[] = [];
  for (const cand of cands) {
    if (!cand.inMemory) continue;
    if (cand.inFixedBlock) continue;
    if (cand.count < POOL_MIN_COUNT) continue;
    pool.push(cand);
  }
  return pool;
}

/** Candidate → 运行期那份 `RecallCandidate`（字段一一对应，别加派生） */
export function toRecallCandidate(cand: Candidate): RecallCandidate {
  return {
    word: cand.word, count: cand.count, pmi: cand.pmi, minEntropy: cand.minEntropy,
    distinctDays: cand.distinctDays, firstSeen: cand.firstSeen, lastSeen: cand.lastSeen,
    evidence: cand.evidence,
    evidenceKinds: cand.evidenceKinds,
    evidenceWeight: cand.evidenceWeight,
    evidenceStrong: cand.evidenceStrong,
  };
}

// ──────────────────────────────── 评测集 / 可见历史 ────────────────────────────────

interface SampleTurn {
  turn: number;
  ts: string;
  seqs: number[];
  sources: string[];
  text: string;
  memReads: number;
  injectedChars: number | null;
}

interface Rates { n: number; triggered: number; triggerRate: number; tokensPerTurn: number }

function ratesOf(rows: Array<{ hits: number; tokens: number }>): Rates {
  const n = rows.length;
  if (n === 0) return { n: 0, triggered: 0, triggerRate: Number.NaN, tokensPerTurn: Number.NaN };
  let triggered = 0;
  let tokens = 0;
  for (const r of rows) { if (r.hits > 0) triggered += 1; tokens += r.tokens; }
  return { n, triggered, triggerRate: triggered / n, tokensPerTurn: tokens / n };
}

interface Args {
  dataDir: string;
  eventsDir: string;
  outDir: string;
  emitEval: boolean;
  anonymize: boolean;
  tiers: number[];
  useCache: boolean;
  corpus: 'all' | 'user';
  visibleChars: number;
  emitDictionary: string;
  sweep: boolean;
  minKinds: number;
  /** 一票通过的证据权重（默认 10；调小 = 词典更宽） */
  oneVoteWeight: number;
  /** 证据加权门槛（默认 4） */
  minWeight: number;
}

function parseArgs(argv: string[]): Args {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  // 产物目录**必须在仓库外**（见文件头）：环境变量 IRMIA_MEASURE_DIR 指定根，
  // 缺省落系统临时目录。`--out` 仍可整个换掉（包括换到一个临时目录之外的地方）。
  const measureRoot = (process.env.IRMIA_MEASURE_DIR ?? '').trim();
  const args: Args = {
    dataDir: join(repoRoot, 'data'),
    eventsDir: join(repoRoot, 'data', 'events'),
    outDir: measureRoot === ''
      ? join(tmpdir(), 'irmia-measure', 'memory-recall')
      : join(measureRoot, 'memory-recall'),
    emitEval: false,
    anonymize: false,
    tiers: DEFAULT_TIERS,
    useCache: true,
    corpus: 'all',
    visibleChars: DEFAULT_VISIBLE_CHARS,
    emitDictionary: '',
    sweep: false,
    minKinds: 2,
    oneVoteWeight: 10,
    minWeight: 4,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const next = (): string => { i += 1; return argv[i] as string; };
    if (a === '--data') args.dataDir = next();
    else if (a === '--events') args.eventsDir = next();
    else if (a === '--out') args.outDir = next();
    else if (a === '--emit-eval') args.emitEval = true;
    else if (a === '--anonymize') args.anonymize = true;
    else if (a === '--no-cache') args.useCache = false;
    else if (a === '--corpus') args.corpus = next() === 'user' ? 'user' : 'all';
    else if (a === '--visible-chars') args.visibleChars = Math.max(0, Number(next()) || 0);
    else if (a === '--emit-dictionary') args.emitDictionary = next();
    else if (a === '--sweep') args.sweep = true;
    else if (a === '--min-kinds') args.minKinds = Number(next());
    else if (a === '--one-vote') args.oneVoteWeight = Number(next());
    else if (a === '--min-weight') args.minWeight = Number(next());
    else if (a === '--tiers') args.tiers = next().split(',').map((x) => Number(x)).filter((n) => n > 0);
  }
  return args;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return n.toFixed(digits);
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}

function loadScan(args: Args): EventScan {
  const cachePath = join(args.outDir, 'events-cache.json');
  const fingerprint = eventsFingerprint(args.eventsDir);
  if (args.useCache && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as EventScan;
      const same = cached.cacheVersion === EVENT_SCAN_CACHE_VERSION
        && cached.files.length === fingerprint.length
        && cached.files.every((f, k) => f.name === fingerprint[k]?.name
          && f.size === fingerprint[k]?.size && f.mtimeMs === fingerprint[k]?.mtimeMs);
      if (same) return cached;
    } catch { /* 缓存坏了就重扫 */ }
  }
  const scan = scanEvents(args.eventsDir);
  ensureDir(args.outDir);
  writeJson(cachePath, scan);
  return scan;
}

function sampleTurns(scan: EventScan): SampleTurn[] {
  const human = scan.turns.filter((t) => t.texts.length > 0);
  const stride = Math.max(1, Math.round(human.length / EVAL_SAMPLE_TARGET));
  const out: SampleTurn[] = [];
  for (let i = 0; i < human.length; i += stride) {
    const t = human[i] as TurnRecord;
    out.push({
      turn: t.turn, ts: t.ts, seqs: t.wakeSeqs, sources: [...new Set(t.sources)],
      text: t.texts.join(' / ').replace(/\s+/gu, ' ').slice(0, 300),
      memReads: t.memReads, injectedChars: t.injectedChars,
    });
  }
  return out;
}

/**
 * **这一轮的可见历史**（③ 的判据：不是"最近 5 次输入"，而是整段还在现场的历史）。
 *
 * 做法：先把 turn 之前最近一条 `compaction/summary` 的 `coveredUpToSeq` 当起点（那之前已被
 * 遮蔽、不在现场），再把起点之后、这一轮的 wake 之前的所有人话与她的话拼起来，
 * 按 `visibleChars` 截尾部。**不包含这一轮自己的输入**（否则查询里的词会把自己判成"刚说过"）。
 */
function visibleTextOf(units: readonly CorpusUnit[], masks: EventScan['masks'], s: SampleTurn, cap: number): string {
  if (cap <= 0) return '';
  const own = new Set(s.seqs);
  const firstWake = s.seqs.length > 0 ? Math.min(...s.seqs) : Number.MAX_SAFE_INTEGER;
  let from = 0;
  for (const mask of masks) {
    if (mask.seq < firstWake && mask.coveredUpToSeq > from) from = mask.coveredUpToSeq;
  }
  const parts: string[] = [];
  for (let k = units.length - 1; k >= 0; k -= 1) {
    const unit = units[k] as CorpusUnit;
    if (unit.seq >= firstWake || unit.seq <= from || own.has(unit.seq)) continue;
    parts.push(unit.text);
    if (parts.reduce((sum, p) => sum + p.length, 0) >= cap) break;
  }
  const text = parts.reverse().join('\n');
  return text.length <= cap ? text : text.slice(text.length - cap);
}

function renderEvalSample(sample: readonly SampleTurn[], existing: Record<string, string>): string {
  const lines = [
    '# 评测集抽样（人眼标注用）', '',
    '判据（三分类，别混）：', '',
    '- `C` **平凡闲聊**：问候 / 撒娇 / 情绪 / 夸奖 / 玩笑 / 寒暄 / 要图 / 调情 / 让她做一件事。',
    '  判据是「**答案不在她记忆里，只靠眼前这句话就能回**」。',
    '- `U` **未知事实**：提到一个具体的人 / 地点 / 计划 / 事件 / 约定 / 术语 / 作品，或明确要求',
    '  「你记得…」「上次说的…」——**要答对必须去翻记忆**（或在记忆里才有的既定口径）。',
    '- `X` **混合/说不清**：既有寒暄又夹一个未知事实、或纯转述/纯指令且无法判断。**不计入 a/b**。',
    '', '标注写回同目录的 `eval-labels.json`：`{ "<turn>": "C|U|X" }`。', '',
    '| turn | 时间 | 来源 | 她翻记忆 | 原文 | 标签 |', '|---|---|---|---|---|---|',
  ];
  for (const s of sample) {
    const decided = existing[String(s.turn)] ?? '';
    lines.push(`| ${s.turn} | ${s.ts.slice(0, 16).replace('T', ' ')} | ${s.sources.join(',')} | ${s.memReads > 0 ? s.memReads : ''} | ${s.text.replace(/\|/gu, '\\|')} | ${decided} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderRecheck(sample: readonly SampleTurn[]): string {
  const picked: SampleTurn[] = [];
  for (let i = 0; i < sample.length; i += 10) picked.push(sample[i] as SampleTurn);
  return [
    '# 复核样本 20 轮（请独立标注，用于算一致率）', '',
    '判据与 `eval-sample.md` 完全相同（`C` 闲聊 / `U` 未知事实 / `X` 说不清）。',
    '标完把 `{ "<turn>": "C|U|X" }` 写进 `eval-recheck-labels.json`，与本文件同目录。',
    '一致率 = 我 `eval-labels.json` 里那 20 条与你这份相同的比例；**分歧 >10% 就说明口径没定死**，先修口径再谈数字。', '',
    '| turn | 时间 | 来源 | 原文 | 你的标签 |', '|---|---|---|---|---|',
    ...picked.map((s) => `| ${s.turn} | ${s.ts.slice(0, 16).replace('T', ' ')} | ${s.sources.join(',')} | ${s.text.replace(/\|/gu, '\\|')} | |`),
    '',
  ].join('\n');
}

// ──────────────────────────────── 匿名化（换一个人设会怎样） ────────────────────────────────

const SYNTH_CJK_POOL = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸', '子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
const SYNTH_LATIN_POOL = 'QZXJKVBYWPF';
const SYNTH_CJK_LENS = [2, 3, 4];
const SYNTH_LATIN_LENS = [4, 7, 11];

function fakeLatinName(len: number, idx: number): string {
  let out = 'Fake';
  let n = idx + 1;
  while (out.length < len) { out += SYNTH_LATIN_POOL[n % SYNTH_LATIN_POOL.length] as string; n = Math.floor(n / SYNTH_LATIN_POOL.length) + 1; }
  return out.slice(0, len);
}

/** 从数据目录里**派生**这个安装的专名（代码里一个都不写）；只用于换名实验 */
export function derivePrivateNames(dataDir: string): string[] {
  const names = new Set<string>();
  const aliasesPath = join(dataDir, 'workspace', 'MEMORIES', 'aliases.md');
  if (existsSync(aliasesPath)) {
    for (const line of readFileSync(aliasesPath, 'utf8').split('\n')) {
      const m = /[=：]\s*([^\s=（）()：:、，,。#]{2,12})\s*(?:[（(]|$)/u.exec(line);
      if (m === null) continue;
      const name = (m[1] as string).trim();
      if (/^[A-Za-z0-9_:.-]+$/u.test(name)) continue;
      if (name.length >= 2) names.add(name);
    }
  }
  const relDir = join(dataDir, 'persona', 'RELATIONSHIPS');
  if (existsSync(relDir)) {
    for (const name of readdirSync(relDir)) {
      if (!name.endsWith('.md')) continue;
      const base = name.slice(0, -3);
      if (/^[0-9A-Fa-f]{16,}$/u.test(base)) continue;
      names.add(base);
    }
  }
  return [...names].filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);
}

/** 造"同类、**不同长度**"的假名（只同长度替换测不出长度依赖） */
export function buildRenameMap(names: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  let cjkIdx = 0;
  let latinIdx = 0;
  for (const name of names) {
    const isLatin = !CJK_RE.test(name[0] ?? '');
    if (isLatin) {
      const len = SYNTH_LATIN_LENS[latinIdx % SYNTH_LATIN_LENS.length] as number;
      let fake = fakeLatinName(len, latinIdx);
      while (used.has(fake)) fake = fakeLatinName(len, ++latinIdx);
      latinIdx += 1;
      used.add(fake);
      map.set(name, fake);
      continue;
    }
    const len = SYNTH_CJK_LENS[cjkIdx % SYNTH_CJK_LENS.length] as number;
    let fake = '';
    let attempt = 0;
    do {
      fake = '';
      for (let k = 0; k < len; k += 1) fake += SYNTH_CJK_POOL[(cjkIdx + attempt * 3 + k) % SYNTH_CJK_POOL.length] as string;
      attempt += 1;
    } while (used.has(fake) && attempt < 512);
    cjkIdx += 1;
    used.add(fake);
    map.set(name, fake);
  }
  return map;
}

export function applyRename(text: string, map: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of map) {
    if (from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

// ──────────────────────────────── 主流程 ────────────────────────────────

/**
 * **名字 → 条目 的反向索引**（第四轮）：扫索引条目的**整行正文**，看每个名字落在哪几条里。
 *
 * 为什么必须扫整行、不能只看摘要：索引只留 40 字摘要，实体名常落在后面——实测
 * 5/35 个命中词在 266 条摘要里一个字都没有。扫整行把这个数抬到接近 100%，
 * 而且**不往索引行里加字**（指针的 token 一点不涨）——这就是用户给的两个形态里的 b)。
 */
export function buildRefsByWord(
  words: readonly string[],
  entries: readonly MemoryIndexEntry[],
  dataDir: string,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (words.length === 0 || entries.length === 0) return out;
  const matcher = buildRecallMatcher(words);
  const byPath = new Map<string, MemoryIndexEntry[]>();
  for (const entry of entries) {
    const list = byPath.get(entry.path) ?? [];
    list.push(entry);
    byPath.set(entry.path, list);
  }
  for (const [path, list] of byPath) {
    let text = '';
    try { text = readFileSync(join(dataDir, 'workspace', path), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (const entry of list) {
      const line = lines[entry.line - 1];
      if (line === undefined || line === '') continue;
      const ref = `${path}:${entry.line}`;
      for (const hit of matchRecall(line, matcher)) {
        const refs = out.get(hit.word) ?? [];
        if (refs.length < 8 && !refs.includes(ref)) refs.push(ref);
        out.set(hit.word, refs);
      }
    }
  }
  return out;
}

interface ComboReport {
  combo: string;
  thresholds: RecallThresholds;
  dictSize: number;
  dictPreview: string[];
  /** C 类：正文注入率 + 指针 token 均值（a 与 a′） */
  c: { n: number; bodyRate: number; pointerTokens: number; bodyTokens: number };
  /** U 类：证据门命中率 / 正文覆盖正确条目率 / 指针覆盖正确条目率（b 与 b′） */
  u: { n: number; gateRate: number; bodyCover: number; pointerCover: number };
  /** 全部抽样轮：每轮平均注入 token（指针 + 正文） */
  cost: { n: number; perTurn: number };
  x: { n: number; bodyRate: number } | null;
  /** U 类里"有命名证据的候选"占多少（证据够不够） vs "证据够但没过其他门"（接没接上） */
  evAny: number;
  evNamed: number;
  evDict: number;
  baselineTokensPerTurn: number;
  states: Record<RecallState, number>;
  tiers: Array<{ tier: number; dictSize: number; bodyRate: number; pointerCover: number; n: number }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(args.outDir);

  const scan = loadScan(args);

  // ── ① 盲标：先把抽样交出去，**在算任何阈值之前**返回 ──
  const sample = sampleTurns(scan);
  const labelsPath = join(args.outDir, 'eval-labels.json');
  const labels: Record<string, string> = existsSync(labelsPath)
    ? JSON.parse(readFileSync(labelsPath, 'utf8')) as Record<string, string>
    : {};
  writeFileSync(join(args.outDir, 'eval-sample.md'), renderEvalSample(sample, labels), 'utf8');
  writeFileSync(join(args.outDir, 'eval-recheck-20.md'), renderRecheck(sample), 'utf8');
  if (args.emitEval) {
    console.log(`抽样已写出（${sample.length} 轮）：${join(args.outDir, 'eval-sample.md')}`);
    return;
  }

  const assets = readMemoryAssets(args.dataDir);
  const entries: readonly MemoryIndexEntry[] = buildMemoryIndex(args.dataDir, { full: true }).entries;

  // ── ② 语料（可选匿名化） ──
  let units = scan.units;
  let memTexts = assets;
  if (args.anonymize) {
    const map = buildRenameMap(derivePrivateNames(args.dataDir));
    units = units.map((u) => ({ ...u, text: applyRename(u.text, map) }));
    memTexts = {
      fixedBlock: applyRename(assets.fixedBlock, map),
      memory: applyRename(assets.memory, map),
      namingEvidence: assets.namingEvidence.map((x) => ({ kind: x.kind, text: applyRename(x.text, map) })),
      files: assets.files,
    };
  }

  // ── ③ 发现 + 证据标注 + 候选池 ──
  const corpusUnits = args.corpus === 'user' ? units.filter((u) => u.kind === 'user') : units;
  const discovered = discoverCandidates(corpusUnits);
  const cands = discovered.cands;
  annotateProvenance(cands, memTexts);
  annotateEvidence(cands, memTexts.namingEvidence);
  const pool = poolOf(cands.values());
  const recallPool = pool.map(toRecallCandidate);
  const poolMatcher = buildRecallMatcher(pool.map((c) => c.word));

  // ── ④ 三档词典：**晋升/匹配/触发/注入全部走运行期那份实现** ──
  // `--sweep`：一次进程里扫多组分位（发现那一步最贵，不该每组重跑一遍），只打印对比表。
  if (args.sweep) {
    const sweepSets = [
      { id: 'A-ent-p50/cnt-p10', entropy: 0.5, countMin: 0.1, daysMax: 0.99 },
      { id: 'B-ent-p60/cnt-p25', entropy: 0.6, countMin: 0.25, daysMax: 0.95 },
      { id: 'C-ent-p70/cnt-p50', entropy: 0.7, countMin: 0.5, daysMax: 0.95 },
      { id: 'D-ent-p70/cnt-p25', entropy: 0.7, countMin: 0.25, daysMax: 0.95 },
      { id: 'E-ent-p80/cnt-p50', entropy: 0.8, countMin: 0.5, daysMax: 0.95 },
      { id: 'F-ent-p60/cnt-p10', entropy: 0.6, countMin: 0.1, daysMax: 0.95 },
    ];
    const group = (tag: string): SampleTurn[] => sample.filter((s) => labels[String(s.turn)] === tag);
    const C = group('C'); const U = group('U'); const X = group('X');
    console.log('| 设置 | 词典 | a(C) | b(U) | c 全局 | token/轮 | X | 四态(未触发/无候选/截断/注入) |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const s of sweepSets) {
      const combo = { ...s, pmi: 0.9, countMax: 1, minIdfQuantile: 0.25 };
      const th = recallThresholds(recallPool, combo);
      const words = promoteRecallWords(recallPool, th, { now: scan.lastTs });
      const matcher = buildRecallMatcher(words.map((w) => w.word));
      const states: Record<RecallState, number> = { 'not-triggered': 0, 'no-candidate': 0, truncated: 0, injected: 0 };
      let cHit = 0; let uHit = 0; let xHit = 0; let tokens = 0;
      for (const turn of sample) {
        const gate = gateRecall(turn.text, matcher, visibleTextOf(units, scan.masks, turn, args.visibleChars));
        const today = selectMemoryRecommendation(entries, [{ seq: 1, text: turn.text }]);
        const inj = planRecallInjection({
          query: turn.text, gate, entries,
          budget: { maxItems: 6, maxTokens: estimateTokens(renderMemoryRecommendation(today)), minIdfQuantile: combo.minIdfQuantile },
        });
        states[inj.trace.state] += 1;
        tokens += inj.trace.tokens;
        if (gate.hits.length > 0) {
          if (C.includes(turn)) cHit += 1;
          if (U.includes(turn)) uHit += 1;
          if (X.includes(turn)) xHit += 1;
        }
      }
      const p = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((a / b) * 100).toFixed(1)}%`);
      console.log(`| ${s.id} | ${words.length} | ${p(cHit, C.length)} | ${p(uHit, U.length)} | ${p(cHit + uHit + xHit, sample.length)} | ${(tokens / sample.length).toFixed(1)} | ${p(xHit, X.length)} | ${states['not-triggered']}/${states['no-candidate']}/${states.truncated}/${states.injected} |`);
    }
    return;
  }

  const dictionaries = QUANTILE_COMBOS.map((combo) => {
    const thresholds = recallThresholds(recallPool, combo);
    /**
     * **两级注入 = 一份词典、两个视图**（第三轮）：
     *   · 指针层用**全词典**（`oneVoteWeight` 调到最低 → 只要被命名过就在），
     *   · 正文层用**强证据子集**（`buildBodyMatcher`：权重 ≥ 10）。
     * 于是"目录永远在、展开很克制"这件事不需要两套阈值。
     */
    const words = promoteRecallWords(recallPool, thresholds, {
      now: scan.lastTs,
      oneVoteWeight: 4,
      minEvidenceWeight: args.minWeight,
    });
    // 第四轮：给每个词补上**反向索引**（扫索引行的整行正文；不往索引里加字）
    const refsByWord = buildRefsByWord(words.map((w) => w.word), entries, args.dataDir);
    for (const word of words) {
      const refs = refsByWord.get(word.word);
      if (refs !== undefined && refs.length > 0) word.refs = refs;
    }
    const byWord = new Map(words.map((w) => [w.word, w]));
    return {
      combo,
      thresholds,
      words,
      refsByWord,
      cands: [...byWord.keys()].map((w) => cands.get(w)).filter((c): c is Candidate => c !== undefined),
      matcher: buildRecallMatcher(words.map((w) => w.word)),
      bodyMatcher: buildBodyMatcher(words),
    };
  });

  // 只导出**运行期格式**的词典就退出
  if (args.emitDictionary !== '') {
    const dict = dictionaries.find((d) => d.combo.id === args.emitDictionary) ?? (dictionaries[1] as typeof dictionaries[number]);
    const outPath = join(args.outDir, `recall-dictionary-${dict.combo.id}.jsonl`);
    writeFileSync(outPath, recallDictionaryJsonl(dict.words, { kind: (w) => cands.get(w)?.kind ?? 'cjk' }), 'utf8');
    console.log(`词典已写出（${dict.combo.id}）：${dict.words.length} 个词 → ${outPath}`);
    console.log(`阈值读数：熵=${fmt(dict.thresholds.entropy)} count=${fmt(dict.thresholds.countMin, 1)}–${fmt(dict.thresholds.countMax, 1)} days≤${fmt(dict.thresholds.daysMax, 1)}`);
    return;
  }

  // ── ⑤ 标注分组 + 今日基线 ──
  const group = (tag: string): SampleTurn[] => sample.filter((s) => labels[String(s.turn)] === tag);
  const chitchat = group('C');
  const unknown = group('U');
  const mixed = group('X');
  const labeledCount = chitchat.length + unknown.length + mixed.length;

  const human = scan.turns.filter((t) => t.texts.length > 0);
  let baselineTokens = 0;
  for (let i = 0; i < human.length; i += 1) {
    const inputs: MemoryQueryInput[] = [];
    for (let k = Math.max(0, i - 4); k <= i; k += 1) {
      const prev = human[k] as TurnRecord;
      for (const text of prev.texts) inputs.push({ seq: k + 1, text });
    }
    const rec = selectMemoryRecommendation(entries, inputs);
    const text = renderMemoryRecommendation(rec);
    baselineTokens += text === '' ? 0 : estimateTokens(text);
  }
  const baselineTokensPerTurn = human.length === 0 ? Number.NaN : baselineTokens / human.length;

  // 可见历史（③）：每轮一份，三档共用（判据与档位无关）
  const visibleByTurn = new Map<number, string>();
  for (const s of sample) visibleByTurn.set(s.turn, visibleTextOf(units, scan.masks, s, args.visibleChars));

  const comboReports: ComboReport[] = [];
  const debugRows: string[] = [
    '# 逐轮命中明细（诊断用：哪些词在闲聊里误触发、哪些 U 轮漏了）', '',
    '| 组合 | 标签 | turn | 命中的词（已扣掉"可见历史里出现过"的） | 结局 | 原文前 56 字 |',
    '|---|---|---|---|---|---|',
  ];

  for (const dict of dictionaries) {
    // 一轮的账：指针层与正文层**分开记**（用户的 a/a′/b/b′ 就是这四个数）
    interface TurnSim {
      hits: string[];
      pointerTokens: number;
      bodyTokens: number;
      pointerCover: boolean;
      bodyCover: boolean;
      state: RecallState;
    }
    const sims = new Map<number, TurnSim>();
    let costTokens = 0;
    for (const s of sample) {
      const visible = visibleByTurn.get(s.turn) ?? '';
      const rawHits = [...new Set(matchRecall(s.text, dict.matcher).map((h) => h.word))];
      // 正文门用**强证据子集**（两级注入的第二级）；指针层用全词典
      const gate = gateRecall(s.text, dict.bodyMatcher, visible);
      // 预算：今天这一轮本来会注入多少（相对量） + 三档各自的相关度下限
      const today = selectMemoryRecommendation(entries, [{ seq: 1, text: s.text }]);
      const maxTokens = estimateTokens(renderMemoryRecommendation(today));
      // **两级注入**：指针层永远有；正文层只在证据门命中时展开（同一份实现，见 recall.ts）
      const plan = planRecallTurn({
        query: s.text, gate, entries, rawHits,
        refsOf: (w: string) => dict.refsByWord.get(w) ?? [],
        bodyBudget: { maxItems: 6, maxTokens, minIdfQuantile: dict.combo.minIdfQuantile },
      });
      // "覆盖了正确条目" = 指针里那一条的**反向索引**里有这一轮的命中词（或行文本里直接出现）
      const covering = (items: readonly { path: string; summary: string; ref: string }[]): boolean =>
        rawHits.length > 0 && items.some((item) => rawHits.some((w) =>
          (dict.refsByWord.get(w) ?? []).includes(item.ref) || `${item.path} ${item.summary}`.includes(w)));
      const sim: TurnSim = {
        hits: gate.hits,
        pointerTokens: plan.trace.pointerTokens,
        bodyTokens: plan.trace.tokens,
        pointerCover: covering(plan.pointer.items),
        bodyCover: covering(plan.body.items),
        state: plan.trace.state,
      };
      sims.set(s.turn, sim);
      costTokens += sim.pointerTokens + sim.bodyTokens;
      const label = labels[String(s.turn)] ?? '-';
      if (label === 'C' || label === 'U') {
        debugRows.push(`| ${dict.combo.id} | ${label} | ${s.turn} | ${gate.hits.slice(0, 8).join('、')} | ${plan.trace.state} | 指针 ${sim.pointerTokens} / 正文 ${sim.bodyTokens} | ${s.text.slice(0, 48).replace(/\|/gu, '\\|')} |`);
      }
    }

    const statsOf = (set: readonly SampleTurn[]): {
      n: number; bodyRate: number; pointerTokens: number; bodyTokens: number;
      gateRate: number; bodyCover: number; pointerCover: number;
    } => {
      const n = set.length;
      if (n === 0) {
        return { n: 0, bodyRate: Number.NaN, pointerTokens: Number.NaN, bodyTokens: Number.NaN, gateRate: Number.NaN, bodyCover: Number.NaN, pointerCover: Number.NaN };
      }
      let body = 0; let ptrT = 0; let bodyT = 0; let gateFired = 0; let bodyCov = 0; let ptrCov = 0;
      for (const s of set) {
        const sim = sims.get(s.turn) as TurnSim;
        if (sim.bodyTokens > 0) body += 1;
        ptrT += sim.pointerTokens;
        bodyT += sim.bodyTokens;
        if (sim.hits.length > 0) gateFired += 1;
        if (sim.bodyCover) bodyCov += 1;
        if (sim.pointerCover) ptrCov += 1;
      }
      return {
        n, bodyRate: body / n, pointerTokens: ptrT / n, bodyTokens: bodyT / n,
        gateRate: gateFired / n, bodyCover: bodyCov / n, pointerCover: ptrCov / n,
      };
    };

    const states: Record<RecallState, number> = { 'not-triggered': 0, 'no-candidate': 0, truncated: 0, injected: 0 };
    for (const sim of sims.values()) states[sim.state] += 1;

    // 证据三问：U 类里 ①有没有任何候选 ②其中有没有带命名证据（加权分 ≥ 门槛）③最后进了词典的
    const evMatcher = buildRecallMatcher(pool.filter((c) => c.evidenceWeight >= 4).map((c) => c.word));
    const evOf = (set: readonly SampleTurn[]): { evAny: number; evNamed: number; evDict: number } => {
      let evAny = 0; let evNamed = 0; let evDict = 0;
      for (const s of set) {
        const any = matchRecall(s.text, poolMatcher).length > 0;
        const named = matchRecall(s.text, evMatcher).length > 0;
        const inDict = matchRecall(s.text, dict.matcher).length > 0;
        if (any) evAny += 1;
        if (named) evNamed += 1;
        if (inDict) evDict += 1;
      }
      return { evAny, evNamed, evDict };
    };
    const uEv = evOf(unknown);

    const tiers: ComboReport['tiers'] = [];
    for (const tier of args.tiers) {
      const tierCands = discoverCandidates(corpusUnits.slice(0, tier)).cands;
      annotateProvenance(tierCands, memTexts);
      annotateEvidence(tierCands, memTexts.namingEvidence);
      const tierPool = poolOf(tierCands.values());
      const tierRecallPool = tierPool.map(toRecallCandidate);
      const tierWords = promoteRecallWords(tierRecallPool, recallThresholds(tierRecallPool, dict.combo), { now: scan.lastTs, oneVoteWeight: 4, minEvidenceWeight: args.minWeight });
      const tierMatcher = buildRecallMatcher(tierWords.map((w) => w.word));
      const tierBodyMatcher = buildBodyMatcher(tierWords);
      let tierBody = 0;
      let tierPCover = 0;
      let tierU = 0;
      const tierRefs = buildRefsByWord(tierWords.map((w) => w.word), entries, args.dataDir);
      for (const s of sample) {
        const tierRawHits = [...new Set(matchRecall(s.text, tierMatcher).map((h) => h.word))];
        const gate = gateRecall(s.text, tierBodyMatcher, visibleByTurn.get(s.turn) ?? '');
        const today = selectMemoryRecommendation(entries, [{ seq: 1, text: s.text }]);
        const plan = planRecallTurn({
          query: s.text, gate, entries, rawHits: tierRawHits,
          refsOf: (w: string) => tierRefs.get(w) ?? [],
          bodyBudget: { maxItems: 6, maxTokens: estimateTokens(renderMemoryRecommendation(today)), minIdfQuantile: dict.combo.minIdfQuantile },
        });
        if (plan.trace.tokens > 0) tierBody += 1;
        if (labels[String(s.turn)] === 'U') {
          tierU += 1;
          const covered = tierRawHits.length > 0 && plan.pointer.items.some((item) => tierRawHits.some((w) =>
            (tierRefs.get(w) ?? []).includes(item.ref) || `${item.path} ${item.summary}`.includes(w)));
          if (covered) tierPCover += 1;
        }
      }
      tiers.push({
        tier, dictSize: tierWords.length,
        bodyRate: sample.length === 0 ? Number.NaN : tierBody / sample.length,
        pointerCover: tierU === 0 ? Number.NaN : tierPCover / tierU,
        n: sample.length,
      });
    }

    const cStat = statsOf(chitchat);
    const uStat = statsOf(unknown);
    const xStat = mixed.length === 0 ? null : statsOf(mixed);
    comboReports.push({
      combo: dict.combo.id,
      thresholds: dict.thresholds,
      dictSize: dict.words.length,
      dictPreview: dict.cands.slice(0, 12).map((c) => c.word),
      c: { n: cStat.n, bodyRate: cStat.bodyRate, pointerTokens: cStat.pointerTokens, bodyTokens: cStat.bodyTokens },
      u: { n: uStat.n, gateRate: uStat.gateRate, bodyCover: uStat.bodyCover, pointerCover: uStat.pointerCover },
      cost: { n: sample.length, perTurn: sample.length === 0 ? Number.NaN : costTokens / sample.length },
      x: xStat === null ? null : { n: xStat.n, bodyRate: xStat.bodyRate },
      evAny: uEv.evAny, evNamed: uEv.evNamed, evDict: uEv.evDict,
      baselineTokensPerTurn,
      states,
      tiers,
    });

    const suffix = args.anonymize ? '-anon' : '';
    writeFileSync(join(args.outDir, `dictionary-${dict.combo.id}${suffix}.jsonl`), `${dict.cands.map((c) => JSON.stringify({
      word: c.word, kind: c.kind, count: c.count, pmi: c.pmi, entropy: c.minEntropy,
      days: c.distinctDays, evidence: c.evidence, evidenceWeight: c.evidenceWeight,
      inMemory: c.inMemory, inFixedBlock: c.inFixedBlock,
    })).join('\n')}\n`, 'utf8');
  }

  const suffix = args.anonymize ? '-anon' : '';

  writeFileSync(join(args.outDir, `candidates${suffix}.jsonl`), `${[...cands.values()]
    .filter((c) => c.count >= POOL_MIN_COUNT)
    .sort((a, b) => b.count - a.count)
    .map((c) => JSON.stringify({
      word: c.word, kind: c.kind, count: c.count, pmi: c.pmi, entropy: c.minEntropy,
      days: c.distinctDays, evidence: c.evidence, evidenceWeight: c.evidenceWeight,
      firstSeen: c.firstSeen, lastSeen: c.lastSeen,
      inMemory: c.inMemory, inFixedBlock: c.inFixedBlock, units: c.inUnits,
    })).join('\n')}\n`, 'utf8');

  const dictForSample = (dictionaries[1] ?? dictionaries[0]) as typeof dictionaries[number];
  const sampleWords = dictForSample === undefined ? [] : dictForSample.cands;
  const step = Math.max(1, Math.floor(sampleWords.length / 20));
  const top20 = sampleWords.filter((_, i) => i % step === 0).slice(0, 20);
  writeFileSync(join(args.outDir, `sample-20${suffix}.md`), [
    '# 候选词抽样 20 条（人眼判"这确实是专名/新词吗"）', '',
    `口径：从 **${dictForSample?.combo.id ?? '?'} 档词典**（${sampleWords.length} 词）里按排名**等距**抽 20 条。`,
    '`pmi` = 凝聚度（辅助分，不再是硬门）；`ent` = min(左邻熵, 右邻熵)；`ev` = **命名位置证据条数**；',
    '`days` = 出现日数；`count` = 出现次数。', '',
    '| # | word | kind | count | pmi | ent | ev | days |', '|---|---|---|---|---|---|---|---|',
    ...top20.map((c, i) => `| ${i + 1} | ${c.word} | ${c.kind} | ${c.count} | ${fmt(c.pmi)} | ${fmt(c.minEntropy)} | ${c.evidence} | ${c.distinctDays} |`),
    '',
  ].join('\n'), 'utf8');

  const summary = {
    generatedAt: new Date().toISOString(),
    anonymized: args.anonymize,
    scope: {
      eventCount: scan.eventCount, firstTs: scan.firstTs, lastTs: scan.lastTs,
      corpusUnits: units.length, corpusChars: units.reduce((sum, u) => sum + u.text.length, 0),
      userUnits: units.filter((u) => u.kind === 'user').length, humanTurns: human.length,
      indexEntries: entries.length, visibleChars: args.visibleChars,
      poolSize: pool.length, labeledTurns: labeledCount,
      chitchatTurns: chitchat.length, unknownTurns: unknown.length, mixedTurns: mixed.length,
      evidenceSpans: memTexts.namingEvidence.reduce((sum, x) => sum + x.text.split('\n').filter((s) => s !== '').length, 0),
      evidenceKinds: memTexts.namingEvidence.map((x) => x.kind),
    },
    candidateStats: {
      windows: discovered.totalWindows,
      uniqueRecurring: cands.size,
      inMemory: [...cands.values()].filter((c) => c.count >= POOL_MIN_COUNT && c.inMemory).length,
      pool: pool.length,
      withEvidence: pool.filter((c) => c.evidenceWeight >= 4).length,
    },
    combos: comboReports,
  };
  writeJson(join(args.outDir, `report${suffix}.json`), summary);

  const md: string[] = [];
  const corpusChars = units.reduce((s, u) => s + u.text.length, 0);
  md.push(`# 记忆召回测量报告${args.anonymize ? '（换名对照）' : ''}（生成物，可复算）`, '');
  md.push(`- 事件：${scan.eventCount} 条（${scan.firstTs.slice(0, 10)} → ${scan.lastTs.slice(0, 10)}）`);
  md.push(`- 语料：${units.length} 条消息 / ${corpusChars} 字（人 ${units.filter((u) => u.kind === 'user').length} 条）`);
  md.push(`- 人的轮次：${human.length}；索引条目：${entries.length}；可见历史上限：${args.visibleChars} 字`);
  md.push(`- 候选池：${pool.length}（其中**带命名证据 ≥2** 的：${summary.candidateStats.withEvidence}）`);
  md.push(`- 人眼标注：${labeledCount} 轮（C=${chitchat.length} / U=${unknown.length} / X=${mixed.length}）${labeledCount === 0 ? ' ⚠ **未标注 ⇒ a/b 记 n/a**' : ''}`);
  md.push('');
  md.push('## 三档阈值（分位读数）与词典', '');
  md.push('| 组合 | 熵分位 | 熵阈 | count 区间 | 日数上界 | idf 下限分位 | 词典大小 | 词典前 12 条 |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const c of comboReports) {
    const combo = QUANTILE_COMBOS.find((x) => x.id === c.combo);
    md.push(`| ${c.combo} | p${(combo?.entropy ?? 0) * 100} | ${fmt(c.thresholds.entropy)} | ${fmt(c.thresholds.countMin, 1)}–${fmt(c.thresholds.countMax, 1)} | ${fmt(c.thresholds.daysMax, 1)} | p${(combo?.minIdfQuantile ?? 0) * 100} | ${c.dictSize} | ${c.dictPreview.join(' / ')} |`);
  }
  md.push('');
  md.push('## 四个数（两级注入：a/a′ 在 C 类，b/b′ 在 U 类）', '');
  md.push('| 组合 | 词典 | a 正文注入率(C) | a′ 指针 token(C) | b 正文覆盖(U) | b′ 指针覆盖(U) | 每轮 token（指针+正文） | 今日基线 | 成本比 |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  for (const c of comboReports) {
    const ratio = Number.isNaN(c.cost.perTurn) ? Number.NaN : c.cost.perTurn / baselineTokensPerTurn;
    md.push(`| ${c.combo} | ${c.dictSize} | ${pct(c.c.bodyRate)} | ${fmt(c.c.pointerTokens)} | ${pct(c.u.bodyCover)} | ${pct(c.u.pointerCover)} | ${fmt(c.cost.perTurn)} | ${fmt(baselineTokensPerTurn)} | ${pct(ratio)} |`);
  }
  md.push('');
  md.push('> `a` = 闲聊轮里**正文展开**的比例（目标 ≤5%）；`a′` = 闲聊轮**指针层**的 token（目标 ≤40）。');
  md.push('> `b` = U 轮里**正文含正确条目**的比例（目标 ≥90%）；`b′` = U 轮里**指针层含正确条目**的比例（≥90% 就说明"能不能想起"这条路通了）。');
  md.push('> "含正确条目" = 那一条的行文本里出现了这一轮命中的词典词（自动口径，见 §7 的局限）。');
  md.push('');
  md.push('## 命名证据三问（U 类，n = ' + unknown.length + '）', '');
  md.push('| 组合 | ① 有任一候选 | ② 其中带命名证据（加权 ≥4） | ③ 最后进词典（= 门命中） |');
  md.push('|---|---|---|---|');
  for (const c of comboReports) {
    md.push(`| ${c.combo} | ${c.evAny}/${unknown.length} | ${c.evNamed}/${unknown.length} | ${c.evDict}/${unknown.length} |`);
  }
  md.push('');
  md.push('> ①→② 的差 = **证据不够**（话里的候选没有被命名过）；②→③ 的差 = **证据没接上**（有证据但被别的门挡了）。');
  md.push('');
  md.push('## 四态分布（全部抽样轮）', '');
  md.push('| 组合 | 未触发 | 触发但无候选 | 命中但被预算截断 | 正常注入 |');
  md.push('|---|---|---|---|---|');
  for (const c of comboReports) md.push(`| ${c.combo} | ${c.states['not-triggered']} | ${c.states['no-candidate']} | ${c.states.truncated} | ${c.states.injected} |`);
  md.push('');
  md.push('## 覆盖率曲线（同一条评测集，训练窗口从小到大）', '');
  md.push('| 组合 | 语料条数 | 词典大小 | 正文注入率 | 指针覆盖(U) |');
  md.push('|---|---|---|---|---|');
  for (const c of comboReports) for (const t of c.tiers) md.push(`| ${c.combo} | ${t.tier} | ${t.dictSize} | ${pct(t.bodyRate)} | ${pct(t.pointerCover)} |`);
  md.push('');
  md.push('## 候选词表统计', '');
  md.push(`- 扫过的窗口（含只出现一次）：${discovered.totalWindows}`);
  md.push(`- 不同的候选（重复出现过，count ≥ ${POOL_MIN_COUNT}）：${cands.size}`);
  md.push(`- 其中在记忆资产里出现过：${summary.candidateStats.inMemory}`);
  md.push(`- 再去掉"每轮都在上下文里"的：${pool.length}`);
  md.push(`- 其中**命名证据加权 ≥4** 的：${summary.candidateStats.withEvidence}`);
  md.push(`- 命名证据片段（结论型文件里抽出来的）：${summary.scope.evidenceSpans}`);
  md.push('');
  writeFileSync(join(args.outDir, `report${suffix}.md`), md.join('\n'), 'utf8');
  writeFileSync(join(args.outDir, `hits-debug${suffix}.md`), `${debugRows.join('\n')}\n`, 'utf8');
  console.log(md.join('\n'));
  console.log(`\n产物：${args.outDir}`);
}

await main();
