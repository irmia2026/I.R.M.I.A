/**
 * Irmia Agent — 按索引指针读记忆（`memory_read` 的实现层）
 *
 * 用户的原话：**「读记忆时能指定读对应索引的记忆，而不是用 read 工具，导致反复把 state、
 * memory 的全文读入」**。所以他定下的形状是：**只看索引；需要时自己去读那一条**，
 * 读回来的内容跟着这次 tool call 留在上下文里（长尾命中缓存）。
 *
 * 实测依据（工具清单审计）：MEMORIES 下的 `safe_read` **整篇读 23 次 / 带区间读 4 次**
 * （85% 是整篇），整篇读回来的回执合计 **52,211 字符 ≈ 22,177 token**，而且它们留在历史里、
 * 之后每轮重发；`facts.md` 一篇现在 ≈3035 token。索引里那条 `MEMORIES/facts.md:9` 本来就
 * 已经指向"那一行"，缺的只是一个**只取那几行**的读口。
 *
 * 本模块的职责边界（三件事，一件都不多）：
 *
 *   1. **核对指针还成不成立**。索引是"路径:行号 + 一行摘要"，而她随时会改记忆文件——
 *      在 `facts.md:9` 上面插一行，那条指针就指到别的东西上去了。**指错了比不指还糟**
 *      （她会拿到一条不属于那个摘要的记忆，并且不知道自己拿错了），所以逐字节比一遍
 *      摘要，不一致就如实说"这条挪了/失效了"，**绝不猜**。
 *   2. **一次只给那几条**。上限是硬的（{@link MEMORY_READ_MAX_LINES}），因为"再读一点"
 *      的下一步就是"读整篇"——而那是这件工具存在的唯一理由。
 *   3. **不碰盘**。只读；访问账由调用方（工具层）写成 `memory/read` 事件。
 *
 * 与 `memory-injection.ts` 的分工：那边是**建索引**（扫描 → 指针表 → 注入文本），
 * 这边是**按指针取正文**。两处共用同一份"这一行算不算条目"的判据
 * （`memory-injection.ts` 的 `entryShapeAt`）——否则"建索引时算条目、核对时不算"会让
 * 每一条都报"指针漂了"。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { entryShapeAt, type MemoryEntryShape } from './memory-injection.ts';
import { MEMORY_DIR_NAME } from './memory-maintain.ts';

/**
 * 单次能取的行数上限。
 *
 * 40 这个数的依据：索引摘要上限是 40 字（`ENTRY_SUMMARY_MAX_CHARS`），而一条记忆正文
 * 通常就是一两行——40 行足够覆盖"这一条被写成了多条子项"（`facts.md` 里确实有那种
 * 缩进子项，见 `- [valid …] …` 下面挂的 `- **16:21 亲历补全**`），又不至于变成"换个名字
 * 的整篇读"。`facts.md` 现在 13KB / 约 200 行，40 行是它的五分之一。
 */
export const MEMORY_READ_MAX_LINES = 40;

/** 一次读取的默认行数：**只取那一行**。要看子项就显式给 `lines` */
export const MEMORY_READ_DEFAULT_LINES = 1;

/**
 * 指针指向的那一行**还在不在**（三种"不在"各有各的说法，别混成一句）。
 *
 * 分开的理由：她说"指针漂了"与说"这行超出文件长度了"要做的事不一样——
 * 前者该回去重看索引，后者该怀疑自己记错了行号。
 */
export type MemoryReadStatus =
  /** 核对通过，`text` 是那几行 */
  | 'ok'
  /** 行号还在文件里，但**那一行已经不是索引里的那一条了**（或压根不是条目了） */
  | 'drift'
  /** 行号超出了文件长度 */
  | 'out-of-range'
  /** 文件不在（记忆文件缺失是正常状态，不是错误） */
  | 'missing';

export interface MemoryReadOk {
  ok: true;
  status: 'ok';
  /** 相对工作根的 posix 路径（回显用，与索引里的指针同一写法） */
  path: string;
  /** 起始行号（1 起） */
  line: number;
  /** 实际取到的行数 */
  lines: number;
  /** 取到的正文（含第 `line` 行本身；行间用 `\n` 连） */
  text: string;
  /** 这一条是不是 `!pinned` */
  pinned: boolean;
  /** 那一刻的索引摘要（回显给模型，便于它确认"我读到的就是我要的那条"） */
  summary: string;
  /**
   * 下一次要接着读时该给的行号；`null` = 已经读到文件末尾，没有下文。
   *
   * 为什么给"下一行"而不是"这一条还没读完"：条目**没有明确的结束标记**——
   * `facts.md` 里一条记忆下面可以挂缩进子项，也可以就此结束，判据只能是"下一行还
   * 算不算一条新条目"。所以这里只给一个**精确且可执行**的线索（从哪一行接着读），
   * 让"我是不是读全了"由她自己看一眼决定，而不是由我猜。
   */
  nextLine: number | null;
}

export interface MemoryReadProblem {
  ok: false;
  status: Exclude<MemoryReadStatus, 'ok'>;
  path: string;
  line: number;
  /** 人话（工具层直接回给模型） */
  message: string;
  /** `drift` 时给：那一行**现在**的摘要（与索引里那份不同，所以是证据） */
  actualSummary?: string;
  /** `drift` 时给：索引里那份（她本来想读的） */
  expectedSummary?: string;
  /** `out-of-range` 时给：文件实际有多少行 */
  totalLines?: number;
}

export type MemoryReadResult = MemoryReadOk | MemoryReadProblem;

/**
 * 记忆文件的**唯一**入参写法：相对工作根的 posix 路径，且必须落在 `MEMORIES/` 之内。
 *
 * 为什么卡这么死：这件工具的存在理由是"按索引指针读**那一条**"。放开到任意路径就等于
 * 又造了一个 `safe_read`（连同它的整篇读能力），而"反复把全文读入"正是它要治的病。
 * 索引里的指针长这样：`MEMORIES/facts.md:9`。
 */
export function isMemoryPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) return false;
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return false;
  return parts.length === 2 && parts[0] === MEMORY_DIR_NAME;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/u);
}

/**
 * 按索引指针读一段记忆，并**先核对这条指针还成不成立**。
 *
 * 调用方（`memory_read`）负责：把相对路径解析成绝对路径（走 fs 包的白名单）、
 * 把 `lines` 夹到上限、以及把这次访问写成事件。本函数只做"读 + 核对"。
 *
 * @param absPath 记忆文件的绝对路径（调用方已过白名单）
 * @param relPath 相对工作根的 posix 路径（用于回显与判据选择）
 * @param line    条目起始行号（1 起）
 * @param lines   一共取几行（调用方已夹到 {@link MEMORY_READ_MAX_LINES}）
 */
export function readMemoryEntry(
  absPath: string,
  relPath: string,
  line: number,
  lines: number,
): MemoryReadResult {
  if (!existsSync(absPath)) {
    return {
      ok: false,
      status: 'missing',
      path: relPath,
      line,
      message: `${relPath} 不在盘上。记忆文件缺失是正常状态（她还没写过那一份）；`
        + '要确认现在有哪些记忆文件，用 safe_read 把 MEMORIES/ 这个目录交给它（传目录即列目录）。',
    };
  }

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    return {
      ok: false,
      status: 'missing',
      path: relPath,
      line,
      message: `${relPath} 读不出来：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const all = splitLines(raw);
  // 末尾换行会 split 出一个空串，那不算"一行"（与 safe_read / splitLines 的同一口径）
  const totalLines = all.length > 0 && all[all.length - 1] === '' ? all.length - 1 : all.length;

  if (line < 1 || line > totalLines) {
    return {
      ok: false,
      status: 'out-of-range',
      path: relPath,
      line,
      totalLines,
      message:
        `${relPath} 现在只有 ${totalLines} 行，行号 ${line} 超出范围`
        + `（合法范围 1~${totalLines}）。索引里的行号是**建索引那一刻**的——`
        + '文件被改短过就会这样。建议重新看一眼索引里那一条，或先用 safe_read 看这个文件。',
    };
  }

  const targetLine = all[line - 1] ?? '';
  const shape: MemoryEntryShape | null = entryShapeAt(relPath, targetLine);
  if (shape === null) {
    // 那一行还在，但它不是一条索引条目了：说明文件被改过（这一行被并进上一条、
    // 或整段被换成别的内容）。**绝不给正文**——给了她就拿到一条不属于那个摘要的记忆。
    return {
      ok: false,
      status: 'drift',
      path: relPath,
      line,
      actualSummary: '（这一行已经不是条目了）',
      message:
        `${relPath}:${line} 上那一条**已经不在原来的位置了**：这一行现在不是一条索引条目`
        + '（可能被并进上一条、或那一行被改写/删掉了）。'
        + '这条指针已经失效，我不会给你可能对不上的正文。'
        + '请重新看一眼索引（或 safe_read 这个文件）确认它现在在哪一行。',
    };
  }

  const requested = Math.max(1, lines);
  const end = Math.min(line + requested - 1, totalLines);
  const text = all.slice(line - 1, end).join('\n');

  return {
    ok: true,
    status: 'ok',
    path: relPath,
    line,
    lines: end - line + 1,
    text,
    pinned: shape.pinned,
    summary: shape.summary,
    nextLine: end < totalLines ? end + 1 : null,
  };
}

/** 记忆目录的绝对路径（`<dataDir>/workspace/MEMORIES`）——调用方拼白名单时用 */
export function memoryDirAbs(dataDir: string): string {
  return join(dataDir, 'workspace', MEMORY_DIR_NAME);
}
