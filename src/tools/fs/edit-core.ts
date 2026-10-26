/**
 * Irmia Agent — 文件系工具包：编辑内核
 *
 * safe_edit / safe_write / safe_rollback / multi_edit 四件共用这里的三个内核：
 *
 *   1. **内容规划**（planEdit）：精确替换 → 缩进容错替换 → 多匹配消歧，
 *      以及 insert_at_line / delete_lines 两种行模式。全部在「行尾统一成 \n」的
 *      中间形态上计算，最后按原文件的换行风格还原，避免把 CRLF 文件改成 LF。
 *
 *   2. **缩进容错**（fuzzyMatch）：模型抄缩进经常差一两格。做法是逐行算
 *      「文件实际缩进 − old 里的缩进」，要求所有非空行的差值**一致**且 |差值| ≤ 2，
 *      再去掉行首空白逐行比对。命中后用文件里的真实文本当 old，替换是不失真的。
 *
 *   3. **受保护的写入**（guardedWrite）：语法检查 → 备份 → 原子落盘 → 失败全量回滚。
 *      多文件一次性传入即可获得「任一失败全量回滚」的原子语义：语法检查在动盘之前，
 *      所以「检查不通过」这一最常见失败路径根本不产生写入。
 */

import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createBackup, readBackup, type BackupRecord } from './backup.ts';
import type { FsEnv } from './env.ts';
// 文件级 undo 的版本库（design §4.22）：与 persona 共用 .versions 机制，零依赖
import {
  VERSION_SCOPE_WORKSPACE, workspaceVersionRelOf, writeFileVersion,
} from '../../persona/versions.ts';
import { insideAny, readOnlyPrefixOfWrite } from './path-guard.ts';
import { checkSyntax, describeVerdict, type SyntaxVerdict } from './syntax-check.ts';
import { encodeText, positionAt, previewLine, splitLines, type DetectedEncoding, type Eol } from './text-codec.ts';
import {
  FS_ERROR_CODES,
  isRecord,
  toErrorMessage,
  type FsErrorCode,
  type ToolContext,
} from './types.ts';

/**
 * 单文件编辑的字节上限：**20 MiB**。取这个数的依据是 devkit 的同一个常量
 * （`tools/_file_utils.py:13` `SAFE_EDIT_MAX_SIZE = 20 * 1024 * 1024`），
 * 它对 `safe_edit` 的读取、`safe_write` 的 content 各设一道，两边同值。
 *
 * 这个常量在本仓库的含义与源仓库**不同，而且必须不同**：
 *
 * - 源仓库：超限拒绝（`safe_edit.py:135-136`、`safe_write.py:118-123`）；
 * - 本仓库 v30 之前：读取硬顶 16 MiB、**静默丢弃超出的部分**，然后把截断后的内容
 *   整篇写回。实测 17,825,826 B 的文件做一次 safe_edit → 落盘 16,777,216 B，
 *   丢 1,048,610 B，全程 `isError=false`（docs/devkit-migration-audit.md §1 #1）。
 *
 * 所以这里不是一个"调大调小"的阈值，而是**数据完整性的边界**：超过它的目标文件
 * 一律拒绝进入编辑链路（见 readTargetFile），超过它的新内容一律拒绝落盘
 * （见 guardedWrite）。取整文件的 stat().st_size 与内存里的原始字节长度来判，
 * 不再有"读一部分、写整篇"的组合。
 *
 * 为什么是 20 MiB 而不是继续用 16 MiB：① 与源同值，迁移忠实度审计把这条判成"漂移"的
 * 直接依据就是两边同用 `SAFE_EDIT_MAX_SIZE`；② 20 MiB 在源仓库里同时管"读"与"写"
 * 两道门，本仓库照抄同一个数，将来对照两边行为时不必先换算阈值；
 * ③ 可经 `FsEnv.maxEditBytes` 显式调大（无人值守下若真有更大的文件要改，那是配置的事），
 * 但默认值不随环境漂移——默认值只由这段注释里的依据决定。
 */
export const DEFAULT_MAX_EDIT_BYTES = 20 * 1024 * 1024;

/** 字节数转人话（与 text-codec 的 formatBytes 同形，这里独立一份避免内核反向依赖展示层） */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 超限拒绝的统一话术：**多大、上限多少、可以怎么做**——三件事缺一不可。
 *
 * 为什么把这三件写死在这里而不是各调用点自己拼：这条拒绝是**数据丢失的防线**，
 * 它出现的每一次都必须让模型立刻明白"不是路径错了、不是参数错了，是太大了，
 * 而我没动它"。少任何一件，模型下一步的动作就会变成"再试一次/换个参数试"
 * ——而它真正该做的是换一条路（分段处理或让人上手）。
 *
 * @param subject 被拒的东西（`a.ts`、或 `a.ts 这次要写入的内容`）
 */
export function oversizeMessage(subject: string, size: number, limit: number): string {
  return (
    `${subject} 有 ${humanBytes(size)}，超过本工具能安全处理的上限 ${humanBytes(limit)}，已拒绝（**一个字节都没动**）。`
    + '为什么是"拒绝"而不是"读一部分"：写工具会把整篇内容写回去，读到一部分就等于把没读到的那部分删掉。'
    + '可以怎么做：① 把要改的地方挪到一个小文件里再改；'
    + '② 用 grep 定位后只 safe_read 需要的区间，不要整篇改写；'
    + '③ 确实要动这么大的文件，请由人在外部编辑器里改（或把 FsEnv.maxEditBytes 调大后重启）。'
  );
}

// ──────────────────────────────── 内容规划 ────────────────────────────────

export type EditMode = 'replace' | 'insert_at_line' | 'delete_lines';

export interface EditRequest {
  mode: EditMode;
  old?: string | undefined;
  new?: string | undefined;
  replaceAll?: boolean | undefined;
  occurrence?: number | undefined;
  line?: number | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
}

export interface MatchLocation {
  /** 1-based 行号 */
  line: number;
  /** 1-based 列号 */
  column: number;
  preview: string;
}

export type PlanSuccess = {
  ok: true;
  /** 规划后的完整文件内容（已按原换行风格还原） */
  text: string;
  summary: string;
  matchCount: number;
  /** 是否走了缩进容错（模型需要知道「找到的不是字面量本身」） */
  fuzzy: boolean;
};

export type PlanFailure = {
  ok: false;
  code: FsErrorCode;
  message: string;
  matches?: MatchLocation[];
};

export type PlanResult = PlanSuccess | PlanFailure;

function normalizeEol(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

// ──────────────────────── 行号前缀的防呆剥除（v27） ────────────────────────

/**
 * safe_read 的行号前缀：宽度 4 右对齐 + `│` + 空格（`  12│ const x = 1;`）。
 * 同时容忍旧形状 `  12| …`：模型可能从**历史上下文**里抄来 v27 之前读到的内容，
 * 那时候的前缀是半角竖线；只认新形状会让这类调用在升级后当场失效。
 *
 * 前导空白限 0~8 个（`{0,8}` 而不是 `\s*`）：宽松到任意空白就等于把"行首恰好有一串
 * 空格 + 数字 + 竖线"的正常内容也当成前缀，而这里宁可不剥——剥错了是改坏文件，
 * 不剥只是这一次调用失败（错误消息会让模型重读一遍）。
 */
const LINE_NUMBER_PREFIX_RE = /^[ \t]{0,8}\d{1,6}[│|] /u;

/**
 * 若文本**所有非空行**都带行号前缀，剥掉前缀；否则原样返回。
 *
 * 为什么要求"所有"：old 里通常只有一部分行真带 `│`（比如它本来就在改一段含表格的
 * Markdown），只剥匹配上的那几行会得到一段错位的内容，替换进去就是坏文件。
 * 全有才算"这是抄来的"，这条判据让文件里字面含 `数字│` 的内容不受影响。
 */
export function stripLineNumberPrefixes(text: string): { text: string; stripped: boolean } {
  // 快筛：一个 `│`/`|` 都没有就不可能有前缀。半角 `|` 太常见，这一层只挡 `│`
  if (!text.includes('│') && !text.includes('|')) return { text, stripped: false };
  const lines = text.split('\n');
  const contentLines = lines.filter((line) => line.trim() !== '');
  if (contentLines.length === 0) return { text, stripped: false };
  if (!contentLines.every((line) => LINE_NUMBER_PREFIX_RE.test(line))) return { text, stripped: false };
  return {
    text: lines
      .map((line) => (line.trim() === '' ? line : line.replace(LINE_NUMBER_PREFIX_RE, '')))
      .join('\n'),
    stripped: true,
  };
}

/** 前导空白长度：tab 也记 1 格。只用于缩进差值比较 */
function indentWidth(line: string): number {
  const match = /^[ \t]*/u.exec(line);
  return match === null ? 0 : match[0].length;
}

interface ExactMatch {
  index: number;
  length: number;
}

function findAll(haystack: string, needle: string): ExactMatch[] {
  const out: ExactMatch[] = [];
  if (needle === '') return out;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    out.push({ index, length: needle.length });
    // 不重叠推进：重叠匹配会让 replace_all 的结果依赖匹配顺序
    from = index + Math.max(1, needle.length);
  }
  return out;
}

function locate(text: string, matches: readonly ExactMatch[]): MatchLocation[] {
  return matches.map((match) => {
    const pos = positionAt(text, match.index);
    const lineStart = match.index - (pos.column - 1);
    const lineEnd = text.indexOf('\n', match.index);
    const rawLine = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    return { line: pos.line, column: pos.column, preview: previewLine(rawLine) };
  });
}

interface FuzzyHit {
  /** 在行数组中的起始下标 */
  start: number;
  /** old 覆盖的行数 */
  lineCount: number;
  /** 被替换的原始文本（含真实缩进） */
  actual: string;
  /** 文件缩进 − old 缩进，取值 ∈ [-2,2] 且非 0 */
  delta: number;
}

/**
 * 缩进容错匹配：old 的缩进整体差一到两格时仍能命中。
 * 返回全部命中位置——多于一个就让调用方用 occurrence 消歧，不做静默猜测。
 */
export function fuzzyMatch(fileLines: readonly string[], oldLines: readonly string[]): FuzzyHit[] {
  if (oldLines.length === 0 || fileLines.length < oldLines.length) return [];
  const hits: FuzzyHit[] = [];

  for (let start = 0; start + oldLines.length <= fileLines.length; start++) {
    let delta: number | null = null;
    let consistent = true;
    for (let j = 0; j < oldLines.length; j++) {
      const fileLine = fileLines[start + j] ?? '';
      const oldLine = oldLines[j] ?? '';
      const fileStripped = fileLine.replace(/^[ \t]+/u, '');
      const oldStripped = oldLine.replace(/^[ \t]+/u, '');
      if (fileStripped !== oldStripped) {
        consistent = false;
        break;
      }
      // 空行不约束缩进：它的前导空白没有语义
      if (oldStripped === '') continue;
      const diff = indentWidth(fileLine) - indentWidth(oldLine);
      if (delta === null) {
        delta = diff;
        if (Math.abs(diff) > 2) {
          consistent = false;
          break;
        }
      } else if (diff !== delta) {
        consistent = false;
        break;
      }
    }
    if (!consistent) continue;
    // 缩进完全一致属于「精确命中的变体」，交给精确路径，避免重复报告
    if (delta === null || delta === 0) continue;
    hits.push({
      start,
      lineCount: oldLines.length,
      actual: fileLines.slice(start, start + oldLines.length).join('\n'),
      delta,
    });
  }
  return hits;
}

/**
 * 把 new 的缩进按同一个 delta 校正回文件风格：
 * 容错命中的前提就是「模型数错了缩进」，若只换正文而保留错缩进，
 * 替换结果会与周围代码风格不一致。delta>0 补空格，delta<0 削掉等量前导字符。
 */
function applyIndentDelta(line: string, delta: number): string {
  if (line.trim() === '') return line;
  if (delta > 0) return ' '.repeat(delta) + line;
  const leading = /^[ \t]*/u.exec(line)?.[0] ?? '';
  const drop = Math.min(leading.length, -delta);
  return line.slice(drop);
}

function rebuild(fileText: string, eol: Eol, trailingNewline: boolean): string {
  if (fileText === '' && !trailingNewline) return '';
  const out = fileText.split('\n').join(eol);
  return trailingNewline && out !== '' && !out.endsWith(eol) ? out + eol : out;
}

function fuzzyFailure(hits: readonly FuzzyHit[], message: string): PlanFailure {
  return {
    ok: false,
    code: FS_ERROR_CODES.AMBIGUOUS_MATCH,
    message,
    matches: hits.map((hit) => ({
      line: hit.start + 1,
      column: 1,
      preview: previewLine(hit.actual.split('\n')[0] ?? ''),
    })),
  };
}

/**
 * 精确替换的完整消歧逻辑（无命中时返回 null，交回给调用方走下一层）。
 *
 * 抽成函数只为一件事：**行号前缀剥除后要能原样重跑一遍**（见 planEdit 的 replace 分支）。
 * 消歧、replace_all、occurrence 越界的口径必须在两条路径上完全一致——复制一份出来
 * 就等于给自己留一个"剥除后行为不同"的暗坑。
 */
function planExactReplace(
  normalized: string,
  oldText: string,
  newText: string,
  split: { eol: Eol; trailingNewline: boolean },
  request: EditRequest,
  summarySuffix: string,
): PlanSuccess | PlanFailure | null {
  const exact = findAll(normalized, oldText);
  if (exact.length === 0) return null;
  const replaceAll = request.replaceAll === true;
  // occurrence === 0 = "没指定"（devkit 的 schema 默认值就是 0，见 parseEditRequest）。
  // 归一在这里做一次，下面的三分支才不用各写一遍 `|| request.occurrence === 0`。
  const occurrence = request.occurrence === undefined || request.occurrence === 0
    ? undefined
    : request.occurrence;

  if (!replaceAll && exact.length > 1 && occurrence === undefined) {
    return {
      ok: false,
      code: FS_ERROR_CODES.AMBIGUOUS_MATCH,
      message:
        `old 在文件中出现 ${exact.length} 次，必须消歧：加 replace_all:true 全替换，` +
        '或用 occurrence:N 指定第 N 处（下面列出全部位置）。',
      matches: locate(normalized, exact),
    };
  }
  if (!replaceAll && occurrence !== undefined) {
    if (occurrence > exact.length) {
      return {
        ok: false,
        code: FS_ERROR_CODES.INVALID_ARGS,
        // v64（她的实测）：原来这句报"old 找不到"——**与真因不符**：`old` 明明找到了，是 `occurrence`
        // 要的第 N 处不存在。措辞改成事实（语义一个字没动：仍然是 INVALID_ARGS + 列出全部位置）。
        message: `occurrence=${occurrence} 越界：old 在文件里只有 ${exact.length} 处，你要的是第 ${occurrence} 处`,
        matches: locate(normalized, exact),
      };
    }
    const target = exact[occurrence - 1] as ExactMatch;
    const result = normalized.slice(0, target.index) + newText + normalized.slice(target.index + target.length);
    return {
      ok: true,
      text: rebuild(result, split.eol, split.trailingNewline),
      summary: `精确替换第 ${occurrence} 处（共 ${exact.length} 处命中）${summarySuffix}`,
      matchCount: 1,
      fuzzy: false,
    };
  }
  const result = replaceAll
    ? normalized.split(oldText).join(newText)
    : replaceFirst(normalized, exact[0] as ExactMatch, newText);
  return {
    ok: true,
    text: rebuild(result, split.eol, split.trailingNewline),
    summary: `${replaceAll ? `精确替换全部 ${exact.length} 处` : '精确替换 1 处（唯一命中）'}${summarySuffix}`,
    matchCount: replaceAll ? exact.length : 1,
    fuzzy: false,
  };
}

/** 规划一次编辑。不触碰磁盘——落盘与回滚由 guardedWrite 负责 */
export function planEdit(original: string, request: EditRequest): PlanResult {
  const split = splitLines(original);
  const normalized = split.lines.join('\n');

  if (request.mode === 'replace') {
    const oldRaw = request.old ?? '';
    const newRaw = request.new ?? '';
    if (oldRaw === '') {
      return { ok: false, code: FS_ERROR_CODES.INVALID_ARGS, message: 'replace 模式必须提供非空的 old' };
    }
    // 剥除前后的两份文本各跑一次精确匹配；剥除只在**精确未命中**时发生
    const oldText = normalizeEol(oldRaw);
    const newText = normalizeEol(newRaw);

    const first = planExactReplace(normalized, oldText, newText, split, request, '');
    if (first !== null) return first;

    // ── 防呆：模型从 safe_read 抄内容时会把行号前缀一起抄进 old（`  12│ const x = 1;`）──
    //
    // 顺序是刻意的：**精确匹配优先**，所以文件里字面含 `数字│` 的内容仍能按原文命中，
    // 防呆只在精确命中不了时才兜底。old 必须**每一行都带前缀**才算"这是抄来的"
    // （见 stripLineNumberPrefixes），new 的三种形态都接受：空（删除式替换）、
    // 全带前缀（整段改写）、一行都不带（模型自己敲的新内容）；唯独**半带不带**不动手
    // ——那种情况下没有判据知道哪些前缀是内容、哪些是噪音。
    const strippedOld = stripLineNumberPrefixes(oldText);
    const strippedNew = stripLineNumberPrefixes(newText);
    const hasAnyPrefix = newText.split('\n').some((line) => LINE_NUMBER_PREFIX_RE.test(line));
    if (strippedOld.stripped && (!hasAnyPrefix || strippedNew.stripped)) {
      const retry = planExactReplace(
        normalized,
        strippedOld.text,
        strippedNew.text,
        split,
        request,
        '（已自动剥除 old/new 上的 safe_read 行号前缀）',
      );
      if (retry !== null) return retry;
    }

    // 精确未命中 → 缩进容错
    const oldLines = oldText.split('\n');
    const hits = fuzzyMatch(split.lines, oldLines);
    if (hits.length === 0) {
      return {
        ok: false,
        code: FS_ERROR_CODES.NO_MATCH,
        message:
          'old 在文件中找不到（精确匹配与缩进容错都未命中）。' +
          '请先用 safe_read 或 grep 确认原文，注意行尾空白与换行符也是内容的一部分。',
      };
    }
    if (hits.length > 1 && request.occurrence === undefined) {
      return fuzzyFailure(hits, `缩进容错匹配到 ${hits.length} 处，必须用 occurrence:N 消歧。`);
    }
    const index = (request.occurrence ?? 1) - 1;
    const hit = hits[index];
    if (hit === undefined) {
      return {
        ok: false,
        code: FS_ERROR_CODES.INVALID_ARGS,
        // 同上（v64）：缩进容错那条路也一样——说清"只有 N 处、你要第 M 处"，别报成"找不到"。
        message: `occurrence=${request.occurrence ?? 1} 越界：缩进容错只命中 ${hits.length} 处，你要的是第 ${request.occurrence ?? 1} 处`,
        matches: hits.map((h) => ({ line: h.start + 1, column: 1, preview: previewLine(h.actual.split('\n')[0] ?? '') })),
      };
    }
    const lines = [...split.lines];
    const replacementLines = newText === ''
      ? []
      : newText.split('\n').map((line) => applyIndentDelta(line, hit.delta));
    lines.splice(hit.start, hit.lineCount, ...replacementLines);
    return {
      ok: true,
      text: rebuild(lines.join('\n'), split.eol, split.trailingNewline),
      summary:
        `缩进容错替换 1 处（第 ${hit.start + 1} 行起；old 的缩进与文件相差 ${hit.delta > 0 ? '+' : ''}${hit.delta} 格，` +
        '已按文件里的实际缩进对齐，new 的缩进同步校正）',
      matchCount: 1,
      fuzzy: true,
    };
  }

  const total = split.lines.length;

  if (request.mode === 'insert_at_line') {
    const lineNo = request.line ?? 0;
    if (request.new === undefined) {
      return { ok: false, code: FS_ERROR_CODES.INVALID_ARGS, message: 'insert_at_line 模式必须提供 new' };
    }
    if (lineNo < 0 || lineNo > total) {
      return {
        ok: false,
        code: FS_ERROR_CODES.INVALID_ARGS,
        message:
          `line=${lineNo} 越界：文件共 ${total} 行，insert_at_line 要求 0 ≤ line ≤ ${total}` +
          '（0 表示插到文件开头，N 表示插到第 N 行**之后**）。',
      };
    }
    const insertText = normalizeEol(request.new);
    const insertLines = insertText === '' ? [] : insertText.split('\n');
    // 与 devkit 逐字对齐（`tools/safe_edit.py:289-295`）：line=0 → 插到最前；
    // 否则 **插在第 line 行之后**。源仓库那句 `parts[:line] + "\n" + insert_text + "\n" + parts[line:]`
    // 展开成 0-based 下标就是下面这两支，一字不差。
    //
    // ⚠️ 方向与下面的 delete_lines **不同**（那个按闭区间删、含两端），因此
    // "删第 N 行 + 插 line=N" 拼不出"替换第 N 行"——新内容会落到原第 N+1 行之后。
    // 两句各自都与源一致，**不要**为了"看起来对齐"改其中一支：那等于把核对过的差异反着改回去。
    // 处置（描述里的两句 + 锁测试）见 `edit-tools.ts` 里 `line` 参数上方那段注释。
    const at = lineNo === 0 ? 0 : lineNo;
    const lines = [...split.lines];
    lines.splice(at, 0, ...insertLines);
    const afterLine = lineNo === 0 ? '文件开头' : `第 ${lineNo} 行之后`;
    return {
      ok: true,
      text: rebuild(lines.join('\n'), split.eol, split.trailingNewline),
      summary: `在${afterLine}插入 ${insertLines.length} 行（原文件共 ${total} 行）`,
      matchCount: 1,
      fuzzy: false,
    };
  }

  // delete_lines：三个越界条件一律报错，**不夹取**（devkit 同判据，`tools/safe_edit.py:252-263`）。
  // 夹取在"删多了"与"删少了"两个方向上都错，而模型看不出哪个方向发生了——报错才能让它改区间重试。
  const startLine = request.startLine ?? 1;
  const endLine = request.endLine ?? startLine;
  if (startLine < 1 || endLine < startLine || endLine > total) {
    return {
      ok: false,
      code: FS_ERROR_CODES.INVALID_ARGS,
      message:
        `行号越界：start_line=${startLine}, end_line=${endLine}，文件共 ${total} 行` +
        `（delete_lines 要求 1 ≤ start_line ≤ end_line ≤ ${total}）。`,
    };
  }
  const from = startLine - 1;
  const to = endLine;
  const lines = [...split.lines];
  const removed = lines.splice(from, to - from);
  return {
    ok: true,
    text: rebuild(lines.join('\n'), split.eol, split.trailingNewline),
    summary: `删除第 ${startLine}-${to} 行（共 ${removed.length} 行）`,
    matchCount: removed.length,
    fuzzy: false,
  };
}

function replaceFirst(text: string, match: ExactMatch, replacement: string): string {
  return text.slice(0, match.index) + replacement + text.slice(match.index + match.length);
}

// ──────────────────────────────── 受保护的写入 ────────────────────────────────

export interface WriteTarget {
  /** 已过白名单校验的绝对路径 */
  path: string;
  /** 工作区相对路径，用于展示 */
  relPath: string;
  /**
   * **别名改写前**的那条输入（`guarded.inputPath`）。
   *
   * 只读区判定要它：`skills/office/SKILL.md` 被别名改写到 `<dataDir>/skills/…` 之后，
   * `skills` 这个只读前缀已经不在 `relPath` 里了（见 `readOnlyPrefixOfWrite`）。
   */
  inputPath: string;
  /** 待写入的文本 */
  text: string;
  /** 读盘得到的原始字节；null 表示目标是新建文件 */
  original: Buffer | null;
  /** 原文件的编码判定结果，用于写回时保持编码 */
  encoding: DetectedEncoding;
}

export interface BackupNote {
  relPath: string;
  record: BackupRecord;
  /** true 表示这次备份记录的是「文件将要被新建」 */
  created: boolean;
}

export interface WriteSuccess {
  ok: true;
  backups: BackupNote[];
  verdicts: Array<{ relPath: string; verdict: SyntaxVerdict }>;
  /**
   * 版本快照（`data/.versions/`，design §4.22）失败的路径与原因。非空表示文件已写入、
   * 但文件级 undo 的历史里少了这一版——调用方必须把它报给模型/人，别让"已留快照"变成假承诺。
   */
  snapshotWarnings?: string[];
}

export interface WriteFailure {
  ok: false;
  code: FsErrorCode;
  message: string;
  /** 是否已经执行过回滚动作 */
  rolledBack: boolean;
  verdict?: SyntaxVerdict;
}

let tmpSeq = 0;

/** 原子落盘：先写同目录临时文件再 rename，中途崩溃不会留下半个文件 */
export async function atomicWrite(absPath: string, content: Buffer): Promise<void> {
  tmpSeq += 1;
  const tmp = `${absPath}.irmia-tmp-${process.pid}-${tmpSeq}`;
  try {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(tmp, content);
    await rename(tmp, absPath);
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // tmp 清理失败不影响原文件完整性
    }
    throw err;
  }
}

/**
 * 语法检查 → 备份 → 原子落盘 → 失败全量回滚。
 * 多文件传进来即可得到多文件原子性：任一语法检查不通过就一个字节都不写。
 */
export async function guardedWrite(
  env: FsEnv,
  ctx: ToolContext,
  targets: readonly WriteTarget[],
): Promise<WriteSuccess | WriteFailure> {
  if (targets.length === 0) {
    return { ok: false, code: FS_ERROR_CODES.INVALID_ARGS, message: '没有要写入的目标', rolledBack: false };
  }

  // 第零步：只读区（design §4.19 技能目录 / P2 的人格资产）。放在最前面——命中就不该产生备份、更不该碰盘。
  // 这是「拦截在决定操作的那一层」：不靠提示词祈求模型别改这些地方。
  //
  // v79：判据换成 `readOnlyPrefixOfWrite`（**改写前**与**改写后**两种写法都看）——技能实体搬进
  // 数据目录之后，`skills/x` 会被别名改写到 `<dataDir>/skills/x`，只判 `relPath` 会让那批技能
  // 成为唯一"读得到也改得动"的技能目录。
  for (const target of targets) {
    const prefix = readOnlyPrefixOfWrite(env.readOnlyPrefixes, target);
    if (prefix === null) continue;
    return {
      ok: false,
      code: FS_ERROR_CODES.PATH_DENIED,
      message:
        `${target.relPath} 在只读区 ${prefix}/ 内（模型可读、不可改）。`
        + (env.readOnlyHints[prefix] ?? '要改它请走它自己的写通道，不要用通用文件工具。'),
      rolledBack: false,
    };
  }

  // 第零步之二：受保护文件（钩子配置等「防护自身定义」，绝对路径）。同样放在最前面：
  // 命中就不该产生备份、更不该碰盘。绕过它等于让 agent 自己拆掉拦自己的门（design §4.19 第 5 条）。
  for (const target of targets) {
    if (!insideAny(env.protectedPaths, target.path)) continue;
    return {
      ok: false,
      code: FS_ERROR_CODES.PATH_DENIED,
      message:
        `${target.relPath} 是受保护配置（对 agent 只读）：它定义的正是「谁能改我」，`
        + '由 agent 改写会让这道防护形同虚设，因此写入口直接拒绝。'
        + '要变更请由人修改该文件本体，重启后生效（读它不受限制）。',
      rolledBack: false,
    };
  }

  // 第一步：按目标文件的编码编回字节，同时做语法检查
  const encoded: Array<{ target: WriteTarget; buffer: Buffer }> = [];
  const verdicts: Array<{ relPath: string; verdict: SyntaxVerdict }> = [];
  for (const target of targets) {
    const bytes = encodeText(target.text, target.encoding);
    // 落盘内容的体积闸门。**与读取端那道门同值、同判据**：读取端挡的是"目标文件太大"，
    // 这一道挡的是"这次要写进去的内容太大"——两道都必要，因为 multi_edit 能把若干个
    // 小文件改成一个巨大的结果，safe_write 也能凭空写一个超过上限的新文件。
    // 放在编码之后：判的是**真实落盘的字节数**，不是 JS 字符串的字符数（中文一字三字节）。
    if (bytes.buffer.length > env.maxEditBytes) {
      return {
        ok: false,
        code: FS_ERROR_CODES.TOO_LARGE,
        message: oversizeMessage(`${target.relPath} 这次要写入的内容`, bytes.buffer.length, env.maxEditBytes),
        rolledBack: false,
      };
    }
    encoded.push({ target, buffer: bytes.buffer });
    const verdict = await checkSyntax(target.path, bytes.buffer, env.deps);
    verdicts.push({ relPath: target.relPath, verdict });
    if (verdict.status === 'error') {
      return {
        ok: false,
        code: FS_ERROR_CODES.SYNTAX_ERROR,
        message:
          `${target.relPath} 的改动未通过语法检查，已放弃全部写入（本次 ${targets.length} 个目标一个都没动）：\n` +
          verdict.message,
        rolledBack: false,
        verdict,
      };
    }
  }

  // 第二步：备份（original 为 null 时记录「新建前」的空快照，回滚据此删文件）
  const backupRoot = env.backupRoot(ctx);
  const backups: BackupNote[] = [];
  for (const target of targets) {
    try {
      const record = await createBackup(
        backupRoot,
        ctx.workspaceRoot,
        target.path,
        target.original,
        env.deps.now(),
        env.backupKeep,
      );
      backups.push({ relPath: target.relPath, record, created: target.original === null });
    } catch (err) {
      return {
        ok: false,
        code: FS_ERROR_CODES.WRITE_FAILED,
        message: `备份 ${target.relPath} 失败，未写入任何文件：${toErrorMessage(err)}`,
        rolledBack: false,
      };
    }
  }

  // 第三步：逐个原子落盘；任何一步失败就按备份全量还原
  const done: Array<{ target: WriteTarget; note: BackupNote }> = [];
  for (const item of encoded) {
    if (ctx.signal.aborted) {
      const restored = await rollbackAll(backupRoot, ctx, done);
      return {
        ok: false,
        code: FS_ERROR_CODES.ABORTED,
        message: restored
          ? '写入被中断，已回滚本次所有改动。'
          : '写入被中断，回滚未能完全成功，请用 safe_rollback 逐个检查。',
        rolledBack: restored,
      };
    }
    const note = backups.find((entry) => entry.relPath === item.target.relPath);
    if (note === undefined) continue;
    try {
      await atomicWrite(item.target.path, item.buffer);
      done.push({ target: item.target, note });
    } catch (err) {
      const restored = await rollbackAll(backupRoot, ctx, done);
      return {
        ok: false,
        code: FS_ERROR_CODES.WRITE_FAILED,
        message:
          `写入 ${item.target.relPath} 失败（${toErrorMessage(err)}）` +
          (restored ? '，已回滚本次所有改动。' : '，回滚未能完全成功，请用 safe_rollback 逐个检查。'),
        rolledBack: restored,
      };
    }
  }

  // 第四步：写版本快照（design §4.22 / M8-9）。
  // 「写工具执行后自动留快照」——留的是**改完后的新内容**，所以同一内容重复写不产生第二份，
  // 跨日的旧版本也不会被覆盖（内容寻址、只增不改）。回滚到昨日版本因此只是从库里挑一份读回来。
  // 快照失败**不影响写入结果**：文件已经落盘这件事是事实，版本库是派生设施；
  // 但它必须被报出来（返回里带上告警），否则"留了快照"就成了一句没人核对的承诺。
  const snapshotNotes: string[] = [];
  const versionDataDir = env.dataDir(ctx);
  for (const item of done) {
    try {
      await writeFileVersion(
        versionDataDir,
        VERSION_SCOPE_WORKSPACE,
        workspaceVersionRelOf(ctx.workspaceRoot, item.target.path),
        item.target.text,
      );
    } catch (err) {
      snapshotNotes.push(`${item.target.relPath}（${toErrorMessage(err)}）`);
    }
  }

  return { ok: true, backups, verdicts, ...(snapshotNotes.length > 0 ? { snapshotWarnings: snapshotNotes } : {}) };
}

/** 按备份还原已写入的文件：原来存在的恢复内容，原来不存在的删掉 */
async function rollbackAll(
  backupRoot: string,
  ctx: ToolContext,
  done: readonly { target: WriteTarget; note: BackupNote }[],
): Promise<boolean> {
  let allRestored = true;
  for (const item of [...done].reverse()) {
    try {
      if (item.note.record.existedBefore) {
        const read = await readBackup(backupRoot, ctx.workspaceRoot, item.target.path, item.note.record.name);
        if (!read.ok) {
          allRestored = false;
          continue;
        }
        await atomicWrite(item.target.path, read.buffer);
      } else {
        await rm(item.target.path, { force: true });
      }
    } catch {
      allRestored = false;
    }
  }
  return allRestored;
}

// ──────────────────────────────── 参数与读取 ────────────────────────────────

export function parseEditRequest(args: Record<string, unknown>): EditRequest | { error: string } {
  const modeRaw = args['mode'];
  let mode: EditMode = 'replace';
  if (modeRaw !== undefined) {
    if (modeRaw !== 'replace' && modeRaw !== 'insert_at_line' && modeRaw !== 'delete_lines') {
      return { error: `mode 只能是 replace / insert_at_line / delete_lines，实际 ${String(modeRaw)}` };
    }
    mode = modeRaw;
  }
  const request: EditRequest = { mode };

  const old = args['old'];
  if (old !== undefined) {
    if (typeof old !== 'string') return { error: 'old 必须是字符串' };
    request.old = old;
  }
  const newText = args['new'];
  if (newText !== undefined) {
    if (typeof newText !== 'string') return { error: 'new 必须是字符串' };
    request.new = newText;
  }
  const replaceAll = args['replace_all'];
  if (replaceAll !== undefined) {
    if (typeof replaceAll !== 'boolean') return { error: 'replace_all 必须是布尔值' };
    request.replaceAll = replaceAll;
  }
  const occurrence = args['occurrence'];
  if (occurrence !== undefined) {
    if (typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0) {
      return { error: 'occurrence 必须是 >= 0 的整数（0 = 未指定）' };
    }
    // occurrence === 0 合法：devkit 的 schema 把 `default: 0` 写明了（`_registry.py:211-215`），
    // 模型照默认值回填 `occurrence: 0` 时不该当场失败（旧实现报"必须是 >= 1 的整数"，
    // 见 docs/devkit-migration-audit.md §3.5 #14）。0 的语义就是"没指定"，不落进 request，
    // 下游因此只有一种"未指定"的表示，不必在每条分支里都记得判 0。
    if (occurrence > 0) request.occurrence = occurrence;
  }
  const line = args['line'];
  if (line !== undefined) {
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 0) {
      return { error: 'line 必须是 >= 0 的整数' };
    }
    request.line = line;
  }
  const startLine = args['start_line'];
  if (startLine !== undefined) {
    if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
      return { error: 'start_line 必须是 >= 1 的整数' };
    }
    request.startLine = startLine;
  }
  const endLine = args['end_line'];
  if (endLine !== undefined) {
    if (typeof endLine !== 'number' || !Number.isInteger(endLine) || endLine < 1) {
      return { error: 'end_line 必须是 >= 1 的整数' };
    }
    request.endLine = endLine;
  }

  if (mode === 'replace' && (request.old === undefined || request.old === '')) {
    return { error: 'replace 模式必须提供非空 old' };
  }
  // 互斥（devkit 同判据，`tools/safe_edit.py:183-189`）：两个都"指定第几处"的口径同时出现时，
  // 源仓库报错，旧实现**静默按 replace_all 执行、occurrence 被丢掉**——而 schema 描述里
  // 写着"与 replace_all 互斥"（docs/devkit-migration-audit.md §1 #13：实测
  // `{old:'const',new:'let',replace_all:true,occurrence:9}` 成功替换全部 3 处）。
  // 描述与实现必须说同一句话：模型以为自己只改了第 9 处，实际全改了，这是最容易漏看的一类静默扩大。
  // 注意判据是 `occurrence > 0`：`occurrence: 0` 是"未指定"，与 replace_all 并存不算冲突。
  if (request.replaceAll === true && request.occurrence !== undefined) {
    return {
      error:
        `occurrence=${request.occurrence} 与 replace_all 不能同时使用，请只选其一` +
        '（要全替换就去掉 occurrence，要只改一处就把 replace_all 去掉）',
    };
  }
  if (mode === 'insert_at_line' && (request.new === undefined || request.line === undefined)) {
    return { error: 'insert_at_line 模式必须提供 line 与 new' };
  }
  if (mode === 'delete_lines' && (request.startLine === undefined || request.endLine === undefined)) {
    return { error: 'delete_lines 模式必须提供 start_line 与 end_line' };
  }
  if (
    mode === 'delete_lines' &&
    request.startLine !== undefined &&
    request.endLine !== undefined &&
    request.endLine < request.startLine
  ) {
    return { error: `end_line(${request.endLine}) 不能小于 start_line(${request.startLine})` };
  }
  return request;
}

export function parseEditRequestFromUnknown(args: unknown): EditRequest | { error: string } {
  return isRecord(args) ? parseEditRequest(args) : { error: 'edits 的每一项都必须是对象' };
}

export interface ReadTargetResult {
  buffer: Buffer | null;
  error?: string;
  /** 错误码；只在 error 非空时有意义。缺省按 IO_ERROR 处理 */
  code?: FsErrorCode;
  /** 目标文件的字节数。超限被拒时调用方要把它写进错误消息 */
  size?: number;
}

/**
 * 读目标文件的**全部**内容；不存在时返回 buffer=null（新建语义），其他错误如实上报。
 *
 * **这里绝不能截断**：读到的内容会被规划后整篇写回，所以"读到一部分"等于"把没读到的
 * 那部分删掉"。旧实现正是这么干的——`open` 后读一个 16 MiB 的缓冲、`subarray(0, bytesRead)`
 * 直接返回，一个字节的提示都没有，于是任何超过 16 MiB 的文件做一次 `safe_edit` 都会被
 * 截掉尾巴（实测 17,825,826 B → 16,777,216 B，丢 1,048,610 B，`isError=false`）。
 *
 * 现在的做法：先 `stat` 拿**整文件**大小，超过 `env.maxEditBytes`（默认 20 MiB，见
 * `DEFAULT_MAX_EDIT_BYTES`）就直接拒绝，一个字节都不读、更不写；错误里给全三件事
 * ——**文件多大、上限多少、可以怎么做**。只读不写是本函数唯一的两种结果。
 */
export async function readTargetFile(absPath: string, maxBytes: number = DEFAULT_MAX_EDIT_BYTES): Promise<ReadTargetResult> {
  let size: number;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absPath, 'r');
  } catch (err) {
    if (isRecord(err) && err['code'] === 'ENOENT') return { buffer: null };
    return { buffer: null, error: toErrorMessage(err) };
  }
  try {
    size = (await handle.stat()).size;
    if (size > maxBytes) {
      return { buffer: null, size, code: FS_ERROR_CODES.TOO_LARGE, error: oversizeMessage(absPath, size, maxBytes) };
    }
    // 精确按 stat 到的长度分配：读到的字节数必须与这个长度相等，否则宁可报错也不返回短内容
    const buf = Buffer.allocUnsafe(size);
    const read = await handle.read(buf, 0, size, 0);
    if (read.bytesRead !== size) {
      return {
        buffer: null,
        size,
        error:
          `只读到 ${read.bytesRead} 字节（stat 说是 ${size} 字节）——文件正在被别处改动，`
          + '为避免写回时丢掉没读到的部分，本次操作已放弃；请稍后重试。',
      };
    }
    return { buffer: buf };
  } catch (err) {
    return { buffer: null, error: toErrorMessage(err) };
  } finally {
    await handle.close();
  }
}

export { describeVerdict };
