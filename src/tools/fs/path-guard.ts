/**
 * Irmia Agent — 文件系工具包：路径白名单守卫
 *
 * 对齐 docs/design.md §4.10 第 1 条与 docs/milestones.md M4-1 / M4-2：
 *   1. `resolve` 后做前缀比较；
 *   2. 注意符号链接——解析 realpath 之后再比一次。
 *
 * 设计要点（每条都对应一个真实绕过手法）：
 *
 *   • **前缀比较必须带分隔符**：只比 `C:\work` 会让 `C:\workspace-evil` 混进来。
 *   • **`..` 在字符串层消除**：`path.resolve` 会吃掉 `..`，而内核解析 `link/../x` 时
 *     `..` 是相对「符号链接的目标路径」的——两者语义不同。因此本模块**返回规范化后的
 *     绝对路径，调用方必须用返回值去操作文件系统**，绝不把原始输入交给 fs。
 *   • **realpath 取「最深已存在祖先」**：目标本身可能还不存在（新建文件），但它的
 *     某一级父目录可能是指向工作区外的符号链接。逐级回退到第一个真实存在的祖先，
 *     解析它，再把剩余不存在的段拼回去，就得到内核真正会访问的路径。
 *   • **Windows 特例**：盘符大小写不敏感（比较时统一小写）、保留设备名（`NUL`/`CON`
 *     /`COM1` 等会变成黑洞或设备）、尾部点与空格会被内核剥除。
 *   • **边界有两态**（2026-10-05，`config.trust.mode`）：`GuardOptions.boundaryRoot === null`
 *     表示**完全信任**——只跳过"必须在根内"这一条，上面每一条守卫照旧。判断只有一处
 *     （`tools/boundary.ts` 的 `isInside`），pwsh 用的是同一份。
 *
 * 已知边界（不在本模块解决）：检查与写入之间存在 TOCTOU 窗口。彻底关闭需要以
 * `O_NOFOLLOW` 打开后用 fstat 复核句柄，本包按「检查即用同一路径」收敛风险。
 */

import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { boundaryDecision, comparisonKey, isInside, outsideBoundaryReason } from '../boundary.ts';
import { FS_ERROR_CODES, type FsErrorCode, toErrorMessage } from './types.ts';

export type GuardResult =
  | { ok: true; path: string; relPath: string; existed: boolean }
  | { ok: false; code: FsErrorCode; reason: string };

const IS_WINDOWS = process.platform === 'win32';

/** Windows 保留设备名：写在任何目录下都会被内核当设备，必须拒绝 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// 前缀比较（`comparisonKey` / `isInside`）从 `tools/boundary.ts` 复出：pwsh 也要判同一条边界，
// 而它不该 import fs 工具族的实现。本模块的对外出口保持不变（`fs/index.ts` 照旧从这里拿）。
export { comparisonKey, isInside } from '../boundary.ts';

// ──────────────────────────────── 路径前缀别名（P1，2026-10-04） ────────────────────────────────

/**
 * 路径前缀别名：把"按**另一个根**写下的相对路径"接回同一个工作根。
 *
 * 为什么需要它（实测，2026-10-04 的工具清单审计）：`ctx.workspaceRoot` 是仓库根，
 * 而三处提示源教她的是另一套写法——
 *   · `self-brief`（进 instructions）："长期记忆落在 `MEMORIES/`…用普通的文件工具自己读写"；
 *   · 每轮进上下文的 `MEMORIES/INDEX.md` 头："要看哪一条就 `safe_read` 那条路径"，
 *     条目写成 `` `MEMORIES/facts.md:9` ``；
 *   · 她自己的写习惯 `persona/STATE.md`。
 * 结果是：写了完整前缀的 209 次调用只失败 5 次（2.4%），而写短前缀的 18 次**全部失败**。
 *
 * 为什么不是"把工作根换成 `<dataDir>/workspace`"：把四天里 615 条带路径参数的调用分别用两个
 * 候选根解析，仓库根能解析到 536 条（87.2%），`<dataDir>/workspace` 只有 45 条（7.3%）
 * ——**7 换 491**，而且 `skills/`（design §4.19 渐进披露第二层）、`data/events/`（她查自己的
 * 日志）、`src/`（她读自己的源码）会整片越界。所以根不动，补一张**显式**的别名表。
 *
 * 为什么表要显式、而且只有几行：与 `runtime/authz.ts` 的 `MACHINE_TOOLS` 同一条理由——
 * 这是"人读一眼就能核对"的东西，宁可列出来、代码评审时看得见。
 */
export interface PathAlias {
  /** 相对路径的首段（大小写不敏感），如 `'MEMORIES'` */
  prefix: string;
  /** 别名根的绝对路径，如 `<dataDir>/workspace/MEMORIES` */
  root: string;
}

/** 相对路径的首段（`MEMORIES/facts.md` → `MEMORIES`）；没有分隔符时就是整串 */
export function firstSegmentOf(input: string): string {
  const normalized = input.replaceAll('\\', '/');
  const end = normalized.indexOf('/');
  return end === -1 ? normalized : normalized.slice(0, end);
}

/** 首段之后的剩余部分（`MEMORIES/facts.md` → `facts.md`）；只有首段时返回 '' */
function restAfterFirstSegment(input: string): string {
  const normalized = input.replaceAll('\\', '/');
  const end = normalized.indexOf('/');
  return end === -1 ? '' : normalized.slice(end + 1);
}

/**
 * 按别名表改写一条相对路径。
 *
 * **"主根优先"是这条规则的全部要点**：主根下已经存在这个目标就一个字都不改。
 * 于是
 *   · 确定性：同一份盘 + 同一个输入 ⟹ 同一个结果（与 render 那套确定性纪律同源）；
 *   · 不劫持：主根里本来就能解析的路径不受影响，别名只在"主根找不到"时接管；
 *   · 不放大边界：别名根通常就在主根之内（`<dataDir>` 在仓库里），万一它在主根之外，
 *     改写出来的绝对路径会被 `resolveInsideRoot` 的越界检查照旧拒绝——**最坏情况是
 *     "别名不生效"，不是"能碰的地方变多"**。
 *
 * 绝对路径与空输入一律原样返回（别名只服务相对路径）。
 */
export function expandAliases(
  input: string,
  aliases: readonly PathAlias[],
  primaryRoot: string,
): string {
  if (typeof input !== 'string' || input === '' || isAbsolute(input)) return input;
  const head = firstSegmentOf(input);
  if (head === '' || head === '.' || head === '..') return input;
  const lowered = head.toLowerCase();
  const alias = aliases.find((candidate) => candidate.prefix.toLowerCase() === lowered);
  if (alias === undefined) return input;
  if (existsSync(resolve(primaryRoot, input))) return input;
  const rest = restAfterFirstSegment(input);
  return rest === '' ? alias.root : resolve(alias.root, rest);
}

/**
 * 只读区判定：相对路径是否落在某个只读前缀内。命中返回该前缀（给错误消息说明用），否则 null。
 *
 * 只读区的语义是**「模型可读、不可改」**——技能目录（design.md §4.19 信任门）就是这类资产：
 * 模型必须能 safe_read 读 SKILL.md 正文（渐进披露第二层），但目录本身只能由人确认后才变更。
 * 比较走 comparisonKey，因此 Windows 上的大小写与分隔符差异不会成为绕过口子。
 */
export function readOnlyPrefixOf(prefixes: readonly string[], relPath: string): string | null {
  const target = comparisonKey(relPath).replaceAll(sep, '/');
  for (const raw of prefixes) {
    const prefix = comparisonKey(raw).replaceAll(sep, '/');
    if (prefix === '' || prefix === '.' || prefix === '/') continue;
    if (target === prefix || target.startsWith(`${prefix}/`)) return prefix;
  }
  return null;
}

/**
 * 检查一个路径分量是否是 Windows 保留设备名（`NUL.txt` 也算，扩展名被内核忽略）。
 */
function hitsReservedDevice(segment: string): boolean {
  if (!IS_WINDOWS) return false;
  const dot = segment.indexOf('.');
  const stem = (dot === -1 ? segment : segment.slice(0, dot)).replace(/[ .]+$/u, '');
  return WINDOWS_RESERVED.has(stem.toUpperCase());
}

/**
 * 逐级向上找到第一个真实存在的祖先，返回 { base, rest }：
 *   base = 该祖先的 realpath（已解析全部符号链接）
 *   rest = 从 base 到目标之间尚不存在的路径分量
 */
async function deepestExisting(target: string): Promise<{ base: string; rest: string[] }> {
  const rest: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return { base: real, rest };
    } catch {
      const parent = resolve(cursor, '..');
      // 已经爬到根还找不到（盘符不存在之类）：退化为把整条路径当 rest
      if (parent === cursor) return { base: cursor, rest };
      const name = cursor.slice(parent.length).replace(/^[\\/]+/u, '');
      if (name !== '') rest.unshift(name);
      cursor = parent;
    }
  }
}

export interface GuardOptions {
  /** 允许目标不存在（写入新文件场景）；false 时目标必须已存在 */
  allowMissing?: boolean;
  /**
   * 要求目标是目录（`vision_read` 传目录时用）；默认 false，即要求目标是普通文件。
   *
   * v42 起 `list_dir` 已删、列目录并入 `safe_read`，所以**默认这一档不再是"列目录"的前置**：
   * `safe_read` 走的是下面那个 `allowDirectory`（文件与目录两种都收），因为它得先拿到真实路径
   * 才能 `stat` 出目标到底是哪一种。
   */
  requireDirectory?: boolean;
  /**
   * 允许目标是目录——**目录与文件两种都收**，怎么用由调用方决定（`rg_search` 用：
   * 传目录它就递归搜，传单个文件就只搜那一个文件）。
   *
   * 与 `requireDirectory` 不是一回事：那个是"只收目录"，这个是"两种都收"。
   * 为什么要有第三个态：这件工具（rg）本来就吃文件操作数，卡它的从来不是安全，
   * 而是这里默认的"目录不是文件操作数"——实测 11 次传文件被拒就是这么来的。
   */
  allowDirectory?: boolean;
  /** 调用用途，用于组织错误消息，例如 'safe_edit' */
  purpose?: string;
  /**
   * 活动边界根（`ToolContext.boundaryRoot` 的三态，语义见 tools/types.ts）：
   *   · `undefined`（默认）= 拿第一个参数 `workspaceRoot` 当边界——历史行为，一个字不变
   *     （**连拒绝措辞也不变**：仍然是那句"白名单只允许工作目录内"）；
   *   · `null` = **不设边界**（完全信任）：跳过"必须在根内"这一条检查，**其余守卫一条不少**
   *     （NUL、保留设备名、realpath、符号链接展开、目标类型、体积门都不受影响）；
   *   · `string` = 用这个根当边界。**显式给值就等于说"这条边界来自 trust.mode"**——
   *     哪怕它恰好与 `workspaceRoot` 是同一个根（`workspace` 档的默认边界正是工作根），
   *     拒绝消息也要说清 trust.mode 与怎么改（判据见 `boundaryDecision`，这里不另写一套）。
   */
  boundaryRoot?: string | null;
}

/**
 * 把用户输入解析为「边界内的规范化绝对路径」，越界即拒绝。
 * 返回的 `path` 是解析过符号链接的结果，调用方必须用它做后续 fs 操作。
 *
 * 两个根要分清：
 *   · `workspaceRoot`（第一个参数）＝**相对路径的解析基准**，也决定 `relPath` 的口径；
 *   · 边界（`options.boundaryRoot`）＝**允许活动的范围**，`null` 表示不设范围。
 * 两者在历史默认下是同一个值（边界缺省即 `workspaceRoot`），但语义不同：`relPath` 始终相对
 * `workspaceRoot`，**只读区前缀（skills/、data/persona）因此与 `trust.mode` 无关**——
 * 换成 `'full'` 之后这些"改什么"的门照旧生效（实测用例见 test/trust-boundary.test.ts）。
 */
export async function resolveInsideRoot(
  workspaceRoot: string,
  input: string,
  options: GuardOptions = {},
): Promise<GuardResult> {
  const purpose = options.purpose ?? '文件操作';
  // 三态 → 有效边界 + "是不是显式给的"（判据在 tools/boundary.ts，这里不另写一套）。
  // 条件展开是 exactOptionalPropertyTypes 下的既定写法：`undefined` 与"没有这个字段"同义。
  const { boundary, explicit } = boundaryDecision({
    workspaceRoot,
    ...(options.boundaryRoot === undefined ? {} : { boundaryRoot: options.boundaryRoot }),
  });

  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, code: FS_ERROR_CODES.INVALID_ARGS, reason: 'path 不能为空' };
  }
  if (input.includes('\0')) {
    return { ok: false, code: FS_ERROR_CODES.PATH_DENIED, reason: 'path 含 NUL 字节' };
  }

  for (const segment of input.replaceAll('\\', '/').split('/')) {
    if (hitsReservedDevice(segment)) {
      return {
        ok: false,
        code: FS_ERROR_CODES.PATH_DENIED,
        reason: `path 命中 Windows 保留设备名「${segment}」，拒绝访问`,
      };
    }
  }

  // 工作根自身必须是真实存在的目录，否则一切比较都失去基准
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch (err) {
    return {
      ok: false,
      code: FS_ERROR_CODES.PATH_DENIED,
      reason: `工作根不可用（${workspaceRoot}）：${toErrorMessage(err)}`,
    };
  }

  const requested = isAbsolute(input) ? resolve(input) : resolve(rootReal, input);
  const { base, rest } = await deepestExisting(requested);
  const effective = rest.length === 0 ? base : join(base, ...rest);

  // 边界检查：`boundary === null` 时**只**跳过这一条（完全信任），其余守卫照走。
  if (boundary !== null) {
    let boundaryReal: string;
    if (comparisonKey(boundary) === comparisonKey(workspaceRoot)) {
      // 边界与工作根是同一个目录：不必再跑一次 realpath（判定不受影响，措辞由 `explicit` 决定）
      boundaryReal = rootReal;
    } else {
      try {
        boundaryReal = await realpath(boundary);
      } catch (err) {
        return {
          ok: false,
          code: FS_ERROR_CODES.PATH_DENIED,
          reason:
            `信任边界根不可用（${boundary}）：${toErrorMessage(err)}。`
            + 'trust.mode = \'workspace\' 时活动范围就是它，它必须是一个真实存在的目录——'
            + '请让人创建它，或把 config.json 的 trust.mode 改成 \'full\'。',
        };
      }
    }
    if (!isInside(boundaryReal, effective)) {
      return {
        ok: false,
        code: FS_ERROR_CODES.PATH_DENIED,
        reason: outsideBoundaryReason({
          subject: purpose,
          effective,
          boundary: boundaryReal,
          // 措辞看的是"调用方表没表态"，不是"两个路径相不相等"：`workspace` 档的默认边界
          // 正是工作根，若按相等判，最常见的那一档反而拿不到"怎么改"那句话
          implicitBoundary: !explicit,
        }),
      };
    }
  }

  let existed = true;
  let isDir = false;
  try {
    const info = await stat(effective);
    isDir = info.isDirectory();
  } catch {
    existed = false;
  }

  if (!existed && options.allowMissing !== true) {
    return { ok: false, code: FS_ERROR_CODES.NOT_FOUND, reason: `路径不存在：${effective}` };
  }
  if (existed && isDir && options.requireDirectory !== true && options.allowDirectory !== true) {
    return {
      ok: false,
      code: FS_ERROR_CODES.NOT_A_FILE,
      // v42：这句话过去指向 `list_dir`，而它已经删了——**指路指到不存在的工具比不指路更坏**
      // （她照做只会拿到一句"未知工具"）。现在的出路是 `safe_read`（传目录即列目录），
      // 递归/隐藏/按时间排这些少数用法归 `pwsh` 的 Get-ChildItem。
      //
      // **一个死名字都不留**：这句回执里连"与旧 list_dir 行为一致"这种等价说明也不写。
      // 她历史里调过 `list_dir` 201 次，回执里出现这个名字就等于把那个选项重新摆到她面前
      // ——**对模型来说，提到名字就是可选项**，她下一个动作就会是再发一次（然后拿到"未知工具"）。
      // 反向断言在 test/fs-tools.test.ts（防将来有人"顺手加回等价说明"）。
      reason: `${effective} 是目录。看目录内容：把目录路径交给 safe_read（可带 depth / limit）；`
        + '要递归、看隐藏项、按修改时间排序，用 pwsh 的 Get-ChildItem。',
    };
  }
  if (existed && !isDir && options.requireDirectory === true) {
    return { ok: false, code: FS_ERROR_CODES.NOT_A_DIRECTORY, reason: `${effective} 不是目录` };
  }

  return {
    ok: true,
    path: effective,
    relPath: relative(rootReal, effective).replaceAll('\\', '/'),
    existed,
  };
}

/** 目标是否落在给定的多个允许根之内（blob 目录等第二白名单用） */
export function insideAny(roots: readonly string[], p: string): boolean {
  return roots.some((root) => isInside(root, p));
}
