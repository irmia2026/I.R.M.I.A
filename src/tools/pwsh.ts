/**
 * Irmia Agent — 平台命令执行工具（Windows PowerShell / 非 Windows Bash）
 *
 * Bash 的脚本与路径扫描在 bash.ts；执行、超时和回执共用本模块。
 * 以下 PowerShell 专项约束只作用于 Windows。
 *
 * 1. **检测链**：先探 `pwsh`（PowerShell 7+），缺失则 fallback `powershell`（5.1），
 *    并把带安装建议的 warning 回给模型。探测结果缓存，进程生命周期内只探一次。
 *    实测 5.1 与 7.x 能跑完全相同的 bootstrap（编码/错误流/退出码行为一致），
 *    所以 fallback 只是换可执行文件名，不需要两套代码。
 *
 *    v30 之后这条链**接在外部依赖管理器上**（`src/deps/`）：pwsh 7 的可用性与路径
 *    由框架统一探测一次（`deps.get('pwsh')`），这里不再自己遍历候选。
 *    两处口径刻意分开：**依赖报告里 pwsh 只有"就绪 / 版本不符 / 未安装"三态**，
 *    而这里的 fallback 到 5.1 是**运行期的可用性妥协**——报告说"没装 PS7"的同时，
 *    工具仍然能跑（并每次都说明"这次用的是哪个 shell"，见下一条）。
 *    找不到 PS7 时**不静默退回 5.1**：回执里每次都写 `[shell]` 那一行。
 *
 *    **每次调用的回执都标明本次用的是哪个 shell**（用户点名）：一行 `[shell] pwsh 7.4.6 · D:\...\pwsh.exe`。
 *    为什么不只在第一次说：回退状态会在**运行期变化**（用户装完 PS7 不必重启进程，
 *    见 deps 的"安装后复检"），"这次用哪个 shell"是每次执行的既成事实，
 *    说一次就够的前提是它永不变——而它不是。
 *
 *    位置上也刻意：**贴在内容的最后一行**。回执的第一行必须是命令自己的输出
 *    （模型与测试都按首行读结果），把元信息塞在开头会让"命令输出了什么"变成第二行的事。
 *
 * 2. **双模式**：单次（spawn 新进程）与持久会话（长驻子进程，默认）。
 *    持久会话用 stdin 写**一行 base64**（UTF-8 编码的命令），彻底绕开 Windows 命令行
 *    的引号/换行/中文转义地狱；命令执行完由会话自己写唯一结束标记
 *    `__IRMIA_END_<guid>__ <exitCode>`。标记只写 stdout 一份：头部已用 SetError
 *    把 PowerShell 的 error stream 并进 stdout，再往 stderr 写一份只会变成 stdout 里的
 *    第二个标记，等待条件反而永不满足（实测踩过，代价是每条命令干等 60 秒超时）。
 *
 * 3. **编码与错误可读性**（实测出来的三条，缺一条模型就会看到乱码或 CLIXML）：
 *    `[Console]::OutputEncoding=UTF8` 解决 5.1 的中文乱码；
 *    `[Console]::SetError([Console]::Out)` 把 PowerShell 的 error stream 并到 stdout，
 *    否则错误会被序列化成 `#< CLIXML ...>` XML（模型完全读不懂）；
 *    `$Error.Clear()` + 显式逐条打印，既保证非终止错误可读，也避免旧错误重复输出。
 *
 * 4. **持久会话会死，而且必须如实告知**：会话进程死亡（命令里含 `exit`、被外部杀掉、
 *    超时被我们杀树）后，**下一次调用**自动重建，但 cwd 与变量已经丢了——结果里明说，
 *    不让模型以为 `$x` 还在。绝不"自动重试这条命令"：那对有副作用的命令等于重复执行。
 *    bootstrap 用 try/finally 包住执行体，这样 `exit 7` 也能把标记写出来，
 *    客户端至少拿得到该命令在终止前的输出。
 *
 * 5. **安全**：命令黑名单正则（匹配即拒绝，原因回给模型）；超时/中断一律
 *    `taskkill /T /F` 杀**进程树**——只杀父进程会留下仍在写盘的后代，
 *    那是 review.md 缺陷 6 的 zombie。输出截断头 8k + 尾 2k 并附续读指导。
 *
 * 6. **活动边界**（`config.trust.mode`，2026-10-05）：`'full'`（默认）**不拦**——她能在任意
 *    目录跑命令；`'workspace'` 时两处要判：① `workdir` 必须落在 `trust.workspaceRoot` 内
 *    （此前 `assertWorkdir` 只判 `isDirectory()`，实测可以选 `C:\Windows`）；② 命令行里出现的
 *    **绝对路径字面量**（`[A-Za-z]:\` 与 `\\` 开头）必须在边界内，否则整条命令拒绝、原因说清
 *    边界在哪。判据与 fs 工具族**同一份**（`tools/boundary.ts` 的 `isInside`）。
 *
 *    ⚠️ 这条边界管的是"能在哪儿动"，**不是**"能改什么"：`FORBIDDEN_PATTERNS` 黑名单照旧
 *    （删除、格式化、注册表、关机…在两种模式下都拒绝），destructive 默认关闭也照旧。
 *
 *    已知不覆盖（刻意的"够用"边界，不是漏洞承诺）：相对路径的 `..` 上升、以及通过
 *    `$env:TEMP`/变量拼出来的路径，不在扫描范围内——shell 里做完整路径分析需要自己写一个
 *    PowerShell 解析器，代价远超收益。真正兜底的是 destructive 门与人工确认（同第 5 条口径）。
 *
 * 内存有界：捕获层（BoundedText）与展示层（truncateOutput）是两道独立的闸，
 * 前者防一个 `Get-Content 大文件` 把进程吃爆，后者防大输出撑爆上下文。
 */

import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { boundaryFixHint, boundaryScopeNote, effectiveBoundaryRoot, isInside } from './boundary.ts';
import {
  BASH_FORBIDDEN_PATTERNS, bashAbsolutePathsIn, buildBashSessionBootstrap,
  buildBashSessionRoundScript, probeBashVersion, shellToolName,
} from './bash.ts';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from './types.js';
import {
  TOOL_ERROR_CODES,
  ToolArgumentError,
  argsRecord,
  errorResult,
  okResult,
  optionalBoolean,
  optionalInteger,
  optionalString,
  requiredString,
} from './types.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

export const PWSH_TOOL_NAME = 'pwsh';

/** 工具整体超时（design §4.18 工具清单表：pwsh 60s） */
export const PWSH_TIMEOUT_MS = 60_000;

/** 单条命令允许的最小/最大超时；上限 = 工具整体超时，更长的活应走 runInBackground */
export const PWSH_MIN_TIMEOUT_MS = 100;
export const PWSH_MAX_TIMEOUT_MS = PWSH_TIMEOUT_MS;

/** 后台任务硬上限：无人值守下没有硬顶的后台任务就是资源泄漏（默认 30 分钟） */
export const DEFAULT_BACKGROUND_MAX_MS = 30 * 60_000;

/** 探测子进程的超时：启动一个 shell 读版本号，10s 足够 */
export const PROBE_TIMEOUT_MS = 10_000;

/** 展示层截断：头 8k + 尾 2k（design §4.18 pwsh 专项第 4 条） */
export const OUTPUT_HEAD_CHARS = 8 * 1024;
export const OUTPUT_TAIL_CHARS = 2 * 1024;

/**
 * 捕获层上限（字符）：单条命令的原始输出超过它就只保留头尾，中间丢弃并计数。
 * 与展示层截断的区别是目的不同——这里是为了让内存有界，不是为了让上下文好看。
 */
export const MAX_CAPTURE_CHARS = 2 * 1024 * 1024;

/** 尾部搜索窗口：结束标记总在本轮输出的最后，64k 窗口足够容纳它和它前面的收尾输出 */
const MARKER_WINDOW_CHARS = 64 * 1024;

/** 后台任务输出落盘文件后缀 */
export const JOB_LOG_SUFFIX = '.log';

/** 检测不到 PS7 时回给模型的安装建议（design §4.18 pwsh 专项第 1 条） */
export const POWERSHELL_INSTALL_HINT = 'winget install Microsoft.PowerShell';

/** 会话内结束标记的前缀，中间嵌 guid */
const END_MARKER_PREFIX = '__IRMIA_END_';

// ──────────────────────────────── 类型 ────────────────────────────────

export type PowerShellKind = 'pwsh' | 'powershell';
export type ShellKind = PowerShellKind | 'bash';

export interface PowerShellProbe {
  /** 探测到的运行时种类 */
  kind: ShellKind;
  /** 可执行文件名（交给 spawn，走 PATH 解析） */
  exe: string;
  /** 版本号文本，如 7.4.6 / 5.1.26100.9444 */
  version: string;
  major: number;
  /** 回退到 5.1 时的告警（含安装建议）；用上 PS7 时为 null */
  warning: string | null;
}

/** 后台任务事件（design §4.21：job/started → 独立运行 → job/finished + wake/job） */
export interface JobCallbacks {
  started(job: { jobId: string; command: string; turn: number }): void;
  finished(job: { jobId: string; exitCode: number | null; outputRef?: string }): void;
}

export interface PwshToolOptions {
  /**
   * 显式开启 destructive 执行（design §4.10 第三级门）。**默认 false**：
   * 未开启时 handler 直接拒绝并说明怎么开。注册表层的"默认不进模型清单"是另一道门，
   * 这里是纵深防御的第二道——两道门都默认关。
   */
  destructiveEnabled?: boolean;
  /** 告警收集（探测回退、会话终止、落盘失败等），宿主据此写 alarm/sent */
  onWarning?: (message: string) => void;
  /** 后台任务回调；未注入时 runInBackground 会被拒绝而不是静默降级成前台 */
  jobs?: JobCallbacks;
  /** 后台任务输出落盘目录；给了才会在 job/finished 里带 outputRef */
  jobsDir?: string;
  /** 默认工作目录；省略时用边界根（`'workspace'` 模式）或 `ctx.workspaceRoot`（完全信任） */
  defaultWorkdir?: string;
  /** 默认超时；省略时 PWSH_TIMEOUT_MS */
  defaultTimeoutMs?: number;
  /** 后台任务硬上限；省略时 DEFAULT_BACKGROUND_MAX_MS */
  maxBackgroundMs?: number;
  /**
   * 外部依赖管理器给出的 pwsh 7 结论（惰性）。传了它，默认 shell 就是**探测到的 pwsh 7**
   * （可能是 PATH 上的、用户在 config 里指的，或框架自装目录里的完整路径）；
   * 不传则退回"自己探一次 PATH 上的 pwsh"（CLI 窄路径与单测）。
   */
  depsProbe?: PowerShellDepProbe | undefined;
  /** shell 平台覆盖点，供跨平台执行测试使用。 */
  platform?: NodeJS.Platform;
}

export interface PwshToolDefinition extends ToolDefinition {
  /** 当前探测结果（缓存；宿主启动时读版本与路径记 session/start） */
  probe(): Promise<PowerShellProbe>;
  /**
   * 本次执行用的是哪个 shell，一句话（`[shell] pwsh 7.4.6 · <路径>`）。
   * 回执里每次都贴它（见文件头第 1 条）；宿主与 GUI 也可以直接拿它显示当前 shell。
   */
  shellLine(): Promise<string>;
  /** 关掉持久会话子进程（宿主退出前调用，避免留下孤儿 shell） */
  shutdown(): Promise<void>;
}

// ──────────────────────────────── 命令黑名单 ────────────────────────────────

export interface ForbiddenPattern {
  id: string;
  /** 在归一化（小写、压空白）的命令文本上匹配 */
  pattern: RegExp;
  /** 回给模型的原因：说清"为什么危险"与"该改走哪条路" */
  reason: string;
}

/**
 * 三级门第 2 条（design §4.10）：shell 工具拒绝这类模式。
 * 匹配对象是**归一化后**的命令文本（小写、连续空白压成一个空格），
 * 大小写变体与换行变形因此都被覆盖。判定不追求完备——它挡的是误伤与惯性，
 * 不是对抗性绕过（真正的兜底是 destructive 默认关 + 人工确认）。
 */
export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    id: 'rm-recursive-force',
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/,
    reason: '递归强制删除（rm -rf）在无人值守下不可撤销',
  },
  {
    id: 'remove-item-recursive-force',
    pattern: /remove-item\b(?=[^\n]*-recurse)(?=[^\n]*-force)/,
    reason: 'Remove-Item -Recurse -Force 是递归强制删除的 PowerShell 写法',
  },
  {
    id: 'remove-item-drive-root',
    pattern: /remove-item\b[^\n]*\s[a-z]:(\\)?(\s|$)/,
    reason: '删除盘符根目录会摧毁整台机器的数据',
  },
  {
    id: 'format-volume',
    pattern: /\bformat\s+[a-z]:|format-volume\b/,
    reason: '格式化卷会抹掉该分区全部数据',
  },
  {
    id: 'mkfs',
    pattern: /\bmkfs(\.\w+)?\b/,
    reason: 'mkfs 会重建文件系统，原有数据全部丢失',
  },
  {
    id: 'disk-management',
    pattern: /\b(diskpart|clear-disk|initialize-disk|remove-partition|new-partition)\b/,
    reason: '磁盘/分区级操作会不可逆地改变分区表',
  },
  {
    id: 'registry-write',
    pattern: /\breg\s+(add|delete|import|restore)\b|set-itemproperty\s+['"]?hk(lm|cu):/,
    reason: '写注册表属于系统级持久化改动，会跨重启生效',
  },
  {
    id: 'boot-config',
    pattern: /\b(bcdedit|bootrec|vssadmin\s+delete)\b/,
    reason: '引导配置或卷影副本删除会让系统无法启动/无法回滚',
  },
  {
    id: 'takeown-icacls-grant',
    pattern: /\btakeown\b|icacls\b[^\n]*\/grant/,
    reason: '夺取所有权/批量授权会破坏系统 ACL，后续无法审计',
  },
  {
    id: 'power-state',
    pattern: /\b(shutdown|stop-computer|restart-computer)\b/,
    reason: '关机/重启会掐断守护进程本身，且无人值守时没人能再拉起来',
  },
  {
    id: 'wipe-free-space',
    pattern: /\bcipher\s+\/w\b/,
    reason: 'cipher /w 反复覆写空闲空间，耗时且不可中断',
  },
  {
    id: 'execution-policy',
    pattern: /set-executionpolicy\s+(-executionpolicy\s+)?(unrestricted|bypass)/,
    reason: '放开执行策略会削弱本机所有脚本的防线',
  },
  {
    id: 'del-rd-recursive',
    pattern: /\b(del|rd|rmdir)\s+(\/[a-z]+\s+)*[a-z]:(\\)?(\s|$)|\b(del|rd|rmdir)\s+\/[a-z]*[sq][a-z]*\s+\/[a-z]*[sq]/,
    reason: 'cmd 语法的递归静默删除',
  },
];

/** 归一化：小写 + 连续空白压成一个空格。换行与制表符因此不会成为绕过通道 */
export function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 命中返回规则本身，未命中返回 null */
export function screenCommand(command: string, platform: NodeJS.Platform = process.platform): ForbiddenPattern | null {
  const normalized = normalizeCommand(command);
  const rules = platform === 'win32' ? FORBIDDEN_PATTERNS : [...FORBIDDEN_PATTERNS, ...BASH_FORBIDDEN_PATTERNS];
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) return rule;
  }
  return null;
}

// ──────────────────────────────── 活动边界（trust.mode） ────────────────────────────────

/** 绝对路径字面量的起点：盘符路径（`C:\` / `C:/`）与 UNC 或 `\\?\` 前缀（`\\`） */
const ABSOLUTE_PATH_START = /[A-Za-z]:[\\/]|\\\\/gu;

/**
 * 路径 token 的终止字符：空白、引号、以及命令行里有语法意义的分隔符。
 * 路径里可以有空格，但那样必须带引号——引号内的路径走下面的引号分支，不按这些字符截断。
 */
const PATH_TOKEN_END = /[\s"'`,;)\]}>|&^=+]/u;

/**
 * 扫出命令里出现的**绝对路径字面量**（按出现顺序，可能重复）。
 *
 * 为什么是这个"够用"的口径：shell 命令没有结构化的路径信息，穷尽它等于自己写一个
 * PowerShell 解析器；而真要绕开这条边界，`$env:TEMP`、`..`、变量拼接都是口子——
 * 这条检查挡的是**误伤与惯性**（模型顺手写 `C:\Windows\...`），不是对抗性绕过。
 * 真正兜底的是 destructive 默认关 + 命令黑名单 + 人工确认（design §4.10 三道门）。
 *
 * 两种截断口径：字面量紧跟在引号后面（`'C:\Program Files\x'`）时按**同种引号**收尾，
 * 带空格的路径因此不会被切半；其余按空白与命令行分隔符截断。
 */
export function absolutePathLiteralsIn(command: string): string[] {
  const found: string[] = [];
  ABSOLUTE_PATH_START.lastIndex = 0;
  for (let match = ABSOLUTE_PATH_START.exec(command); match !== null; match = ABSOLUTE_PATH_START.exec(command)) {
    const start = match.index;
    const previous = start > 0 ? command[start - 1] : undefined;
    const quote = previous === '"' || previous === "'" ? previous : null;
    let end = start + match[0].length;
    while (end < command.length) {
      const char = command[end] as string;
      if (quote === null ? PATH_TOKEN_END.test(char) : char === quote) break;
      end += 1;
    }
    found.push(command.slice(start, end));
  }
  return found;
}

/** 目标不存在时的边界判定仍要有意义：退到字符串层的 `resolve`（`..` 照样被吃掉） */
function effectivePathOf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

/**
 * `workdir` 的边界判定（`'workspace'` 模式）。
 * 返回 null = 在边界内；否则是给模型看的完整原因（边界在哪、怎么改）。
 */
export function workdirBoundaryError(workdir: string, boundary: string): string | null {
  const effective = effectivePathOf(workdir);
  if (isInside(boundary, effective)) return null;
  return `工作目录 ${workdir} 落在信任边界 ${boundary} 之外（解析后的真实路径 ${effective}）：`
    + `${boundaryScopeNote(boundary)}。${boundaryFixHint(boundary)}`
    + `省略 workdir 时，本次会用边界根 ${boundary} 作为工作目录。`;
}

/** 命令行里某条绝对路径字面量的边界判定；返回 null 表示在边界内 */
export function commandPathBoundaryError(literal: string, boundary: string): string | null {
  const effective = effectivePathOf(literal);
  if (isInside(boundary, effective)) return null;
  return `命令被拒绝：命令行里的绝对路径 ${literal} 落在信任边界 ${boundary} 之外`
    + `（解析后的真实路径 ${effective}）：${boundaryScopeNote(boundary)}。${boundaryFixHint(boundary)}`
    + '如果它只是命令里的字符串或正则字面量、并不真去访问该路径，'
    + '请改写成不含盘符、也不含 \\\\ 开头的写法再试。';
}

// ──────────────────────────────── 输出处理 ────────────────────────────────

/**
 * 剥离 PowerShell 的错误序列化残留。
 * 实测：把 error stream 并到 stdout 后，pwsh 仍会在**首次**输出错误时先写一行
 * `#< CLIXML`，5.1 下还可能追加一整块 `<Objs ...>...</Objs>` XML。
 * 只在文本**以该标记开头**时才剥，不做全局猜测——用户正常输出里出现 `#< CLIXML`
 * 的概率极低，且不该被我们改掉。
 */
export function stripClixml(text: string): string {
  if (!text.startsWith('#< CLIXML')) return text;
  return text
    .replace(/^#< CLIXML\r?\n/, '')
    .replace(/<Objs[\s\S]*?<\/Objs>\r?\n?/g, '');
}

/** Windows 的 CRLF 统一成 LF：模型读长输出时能省下大量无意义字符 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * 展示层截断：头 8k + 尾 2k，中间给出省略说明。
 * 截断处附"下一步怎么拿"的指导（design §4.18 原则 4），不是冷冰冰的省略号。
 */
export function truncateOutput(
  text: string,
  headChars = OUTPUT_HEAD_CHARS,
  tailChars = OUTPUT_TAIL_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= headChars + tailChars) return { text, truncated: false };
  const omitted = text.length - headChars - tailChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const note = `\n…[中间 ${omitted} 字已省略：完整输出可用更精确的命令取回，`
    + `例如 Select-String 过滤关键字、Select-Object -First N、或先写入 workspace/ 下的文件再分段读取]…\n`;
  return { text: `${head}${note}${tail}`, truncated: true };
}

/**
 * 有界文本缓冲：保留头 headLimit + 尾 tailLimit，中间丢弃并计数。
 * 两个用途合一的理由：结束标记**总是最后写出**，所以它必然落在保留下来的尾部里，
 * 边界解析与内存保护用同一个结构即可，不需要两套累积逻辑。
 */
export class BoundedText {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = '';
  #tail = '';
  #dropped = 0;

  constructor(limit = MAX_CAPTURE_CHARS) {
    this.#headLimit = Math.floor(limit / 2);
    this.#tailLimit = limit - this.#headLimit;
  }

  push(chunk: string): void {
    if (this.#head.length < this.#headLimit) {
      this.#head += chunk;
      if (this.#head.length > this.#headLimit) {
        // 头写满：溢出部分滚进尾部，此后头不再增长
        this.#tail = this.#head.slice(this.#headLimit);
        this.#head = this.#head.slice(0, this.#headLimit);
      }
      return;
    }
    this.#tail += chunk;
    if (this.#tail.length > this.#tailLimit) {
      this.#dropped += this.#tail.length - this.#tailLimit;
      this.#tail = this.#tail.slice(-this.#tailLimit);
    }
  }

  get droppedChars(): number {
    return this.#dropped;
  }

  /** 保留下的文本（中间被丢弃时是头尾直接相接，省略说明由展示层负责） */
  text(): string {
    return this.#head + this.#tail;
  }

  /**
   * 尾部搜索窗口：取 `text()` 的最后 MARKER_WINDOW_CHARS 个字符。
   * 为什么不是 `#tail` 单独一段：短输出时尾部为空（全在头部），那样永远找不到标记。
   */
  window(): string {
    const all = this.#head + this.#tail;
    return all.length <= MARKER_WINDOW_CHARS ? all : all.slice(-MARKER_WINDOW_CHARS);
  }

  get length(): number {
    return this.#head.length + this.#tail.length;
  }
}

/** 从有界缓冲里切出标记之前的那一段；标记按 window() 定位，再换算回 text() 坐标 */
function cutBeforeMarker(buffer: BoundedText, match: RegExpExecArray): string {
  const text = buffer.text();
  const window = buffer.window();
  // window 是 text 的后缀（长输出时取尾部窗口，短输出时就是全部），所以换算只需减去长度差
  const base = text.length - window.length;
  return text.slice(0, base + match.index);
}

// ──────────────────────────────── 脚本拼装 ────────────────────────────────

/**
 * 单次执行的子进程形状：stdin 是 'ignore'（真的是 null），stdout/stderr 是管道。
 * 不用 ChildProcessWithoutNullStreams 是因为它的 stdin 非空，与 'ignore' 不符。
 */
type SingleShotChild = ChildProcessByStdio<null, Readable, Readable>;

/** PowerShell 的 -EncodedCommand 要 UTF-16LE base64，这是它唯一不会误解码的通道 */
function toEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** 命令本体走 UTF-8 base64：中文、换行、引号、`$` 都不再需要转义 */
function toCommandBase64(command: string): string {
  return Buffer.from(command, 'utf8').toString('base64');
}

/** 每条命令共用的头部。三条设置各自解决一个实测问题，见文件头第 3 条 */
const SCRIPT_HEADER = [
  "$ErrorActionPreference='Continue'",
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  '[Console]::SetError([Console]::Out)',
].join('\n');

/** 把本轮 $Error 里的错误逐条打成可读文本；随后清空，避免下一轮重复输出旧错误 */
const ERROR_FLUSH = [
  'for($irmiaI=0; $irmiaI -lt $Error.Count; $irmiaI++){ [Console]::Out.WriteLine("错误: " + $Error[$irmiaI].ToString()) }',
  '$Error.Clear()',
].join('\n');

/** 把命令包进 try/catch（catch 留空：错误文本已由 ERROR_FLUSH 输出，catch 只负责不中断会话） */
function invokeExpressionLine(command: string): string {
  return `try{ Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toCommandBase64(command)}'))) }catch{ }`;
}

/**
 * 单次执行脚本：编码设置 → 执行 → 错误回显 → 用 $LASTEXITCODE 收敛退出码。
 * 末尾那句 `exit $LASTEXITCODE` 是必需的：实测 `-EncodedCommand` 结束时 pwsh 会把
 * `cmd /c "exit 9"` 这种非零退出码吞成 1，显式 exit 才能把真实码传出来。
 */
export function buildSingleShotScript(command: string): string {
  return [
    SCRIPT_HEADER,
    '$Error.Clear()',
    invokeExpressionLine(command),
    ERROR_FLUSH,
    'if($null -ne $LASTEXITCODE){exit $LASTEXITCODE}',
  ].join('\n');
}

/**
 * 持久会话 bootstrap：从 stdin 逐行读 base64 命令并执行，每轮结束写边界标记。
 * 外层 try/finally 让 `exit` 也能写出标记（实测 `exit 7` 会终止整个会话，
 * 但 finally 仍会执行）——这样客户端至少能拿到该命令终止前的输出，而不是干等超时。
 */
export function buildSessionBootstrap(marker: string): string {
  const markerExpression = `"${END_MARKER_PREFIX}\${irmiaMarker}__ \${irmiaEc}"`;
  return [
    SCRIPT_HEADER,
    `$irmiaMarker='${marker}'`,
    'while($true){',
    '$irmiaLine=[Console]::In.ReadLine()',
    'if($null -eq $irmiaLine){break}',
    '$irmiaCode=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($irmiaLine))',
    '$global:LASTEXITCODE=0',
    '$irmiaEc=0',
    '$Error.Clear()',
    'try{',
    'try{ Invoke-Expression $irmiaCode }catch{ }',
    'for($irmiaI=0; $irmiaI -lt $Error.Count; $irmiaI++){ [Console]::Out.WriteLine("错误: " + $Error[$irmiaI].ToString()) }',
    '$Error.Clear()',
    'if($null -ne $global:LASTEXITCODE){$irmiaEc=$global:LASTEXITCODE}',
    '} finally {',
    `[Console]::Out.WriteLine(${markerExpression}); [Console]::Out.Flush()`,
    '}',
    '}',
  ].join('\n');
}

/** PowerShell 单引号字面量里唯一需要转义的是单引号本身（用两个单引号） */
function quoteSingle(text: string): string {
  return text.replace(/'/g, "''");
}

/** 会话的每轮脚本：先切工作目录（会话内持久），再跑命令本体 */
export function buildSessionRoundScript(command: string, workdir: string | null): string {
  if (workdir === null) return command;
  return `Set-Location -LiteralPath '${quoteSingle(workdir)}'\n${command}`;
}

// ──────────────────────────────── 探测 ────────────────────────────────

/** 跑一次 `$PSVersionTable.PSVersion.ToString()`；任何失败（含超时）都返回 null */
function probeVersion(exe: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };

    const script = toEncodedCommand('$PSVersionTable.PSVersion.ToString()');
    let child: SingleShotChild;
    try {
      child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    timer = setTimeout(() => {
      killTree(child.pid);
      finish(null);
    }, PROBE_TIMEOUT_MS);

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      out += data;
    });
    child.stdout.on('error', () => undefined);
    child.stderr.on('data', () => undefined);
    child.stderr.on('error', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', () => {
      const version = out.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
      finish(version === '' ? null : version);
    });
  });
}

function parseMajor(version: string): number {
  const matched = /^(\d+)/.exec(version.trim());
  return matched === null ? 0 : Number(matched[1]);
}

/**
 * 检测链的输入：外部依赖管理器给出的 pwsh 7 结论（可选）。
 *
 * 为什么要这个接缝而不是让本模块 import deps：tools 层不应该知道 dataDir 与配置在哪
 * （那是宿主的事），而 deps 层也不该反过来依赖工具。**探测一次、结论传进来**，
 * 两边的分工就干净了：deps 回答"本机有没有 pwsh 7、在哪"，这里回答"用不了它时怎么办"。
 */
export type PowerShellDepProbe = () => Promise<{ ok: boolean; path: string; version: string; reason: string }>;

export interface PowerShellDetectOptions {
  /** pwsh 7 的探测结论（惰性取值）；未注入时退化成"自己在 PATH 上探一次 pwsh" */
  deps?: { probe: PowerShellDepProbe } | undefined;
  /** 探测覆盖点（测试注入假 shell 用）：给了它就不改 spawn 参数、只换被探的可执行文件 */
  runProbe?: ((exe: string) => Promise<string | null>) | undefined;
  platform?: NodeJS.Platform;
}

/** 探测结论的缓存：进程生命周期内只探一次（真探测代价是一次 shell 启动） */
let cachedProbe: Promise<PowerShellProbe> | null = null;
let cachedBashProbe: Promise<PowerShellProbe> | null = null;

/** 丢掉探测缓存（测试与"安装后复检"用；宿主不必调——它拿的是 deps 的缓存结论） */
export function resetPowerShellProbeCache(): void {
  cachedProbe = null;
  cachedBashProbe = null;
}

/**
 * 检测链：pwsh（PS7+）优先，缺失则 powershell（5.1）。
 *
 * 两条探测来源的优先级：**外部依赖管理器的结论 > 自己探 PATH**。
 * 管理器那份是框架级的（含用户在 config 里指定的路径与自装目录），它说没有才是真的没有；
 * 没注入管理器时（CLI 的窄路径、单测）退回自己探一次 `pwsh`。
 * 两者都探测不到才算环境不可用——那时返回的错误消息要给出安装路径，
 * 而不是让模型对着"执行失败"猜。
 */
export async function detectPowerShell(options: PowerShellDetectOptions = {}): Promise<PowerShellProbe> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    cachedBashProbe ??= (async () => {
      const version = await (options.runProbe?.('bash') ?? probeBashVersion(PROBE_TIMEOUT_MS));
      if (version === null) throw new Error('找不到可用的 Bash 运行时：请安装 bash 并加入 PATH。');
      return { kind: 'bash', exe: 'bash', version, major: parseMajor(version), warning: null };
    })();
    return cachedBashProbe;
  }
  const probe = options.runProbe ?? probeVersion;
  cachedProbe ??= resolvePowerShell(probe, options.deps);
  return cachedProbe;
}

async function resolvePowerShell(
  probe: (exe: string) => Promise<string | null>,
  deps: PowerShellDetectOptions['deps'],
): Promise<PowerShellProbe> {
  // ① 框架级结论：管理器说 pwsh 7 在哪就用它，不再自己遍历候选
  if (deps !== undefined) {
    const resolved = await deps.probe();
    if (resolved.ok) {
      return { kind: 'pwsh', exe: resolved.path, version: resolved.version, major: parseMajor(resolved.version), warning: null };
    }
    // ② 管理器说 pwsh 7 不可用：如实回退 5.1（它是回退选项，不是"满足 pwsh 依赖"）
    const legacy = await probeLegacy(probe);
    if (legacy !== null) return legacy;
    throw new Error(
      `找不到可用的 PowerShell 运行时：框架依赖探测判定 pwsh 7 未就绪（${resolved.reason}），`
      + `PATH 上也没有 Windows PowerShell 5.1 可回退。请安装后重试：${POWERSHELL_INSTALL_HINT}`,
    );
  }

  // ③ 没注入管理器（CLI 窄路径 / 单测）：自己探一次 PATH 上的 pwsh
  const ps7 = await probe('pwsh');
  if (ps7 !== null && parseMajor(ps7) >= 7) {
    return { kind: 'pwsh', exe: 'pwsh', version: ps7, major: parseMajor(ps7), warning: null };
  }
  const legacy = await probeLegacy(probe);
  if (legacy !== null) return legacy;
  const ps7Hint = ps7 === null ? '（pwsh 未找到或未能启动）' : `（pwsh 版本 ${ps7} 低于 7）`;
  throw new Error(
    `找不到可用的 PowerShell 运行时${ps7Hint}。请安装后重试：${POWERSHELL_INSTALL_HINT}`,
  );
}

/** 回退项：Windows PowerShell 5.1。它不算满足 pwsh 依赖，只是让工具还能跑 */
async function probeLegacy(
  probe: (exe: string) => Promise<string | null>,
): Promise<PowerShellProbe | null> {
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'powershell';
  const legacy = await probe(exe);
  if (legacy === null) return null;
  return {
    kind: 'powershell',
    exe,
    version: legacy,
    major: parseMajor(legacy),
    warning:
      `未检测到 PowerShell 7（pwsh），已回退到 Windows PowerShell ${legacy}。`
      + '5.1 与 7 的语法与默认编码存在差异（本工具已显式统一为 UTF-8），长期建议安装 PS7：'
      + POWERSHELL_INSTALL_HINT
      + '（装完不必重启本进程：依赖探测支持安装后复检）',
  };
}

// ──────────────────────────────── 进程树 ────────────────────────────────

/**
 * 杀进程树。只杀直接子进程会留下仍在写盘的后代，那正是 review.md 缺陷 6 的
 * "日志说没成、现实成了"。Windows 用 taskkill /T /F；其它平台先试进程组再退化为单进程。
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* taskkill 不可用时没有更可靠的手段；close 事件会自然兜底 */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* 不是进程组组长 */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经退出 */
  }
}

// ──────────────────────────────── 执行结果 ────────────────────────────────

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** 超时被杀树 */
  timedOut: boolean;
  /** 调用方取消 */
  aborted: boolean;
  /** 本次调用开始时会话被重建（cwd/变量丢失） */
  sessionRestarted: boolean;
  /** 会话进程在等待期间死亡（命令里可能含 exit，或被外部杀掉） */
  sessionLost: boolean;
  /** 捕获层丢弃的字符数 */
  droppedChars: number;
}

function emptyOutcome(patch: Partial<ExecOutcome> = {}): ExecOutcome {
  return {
    stdout: '',
    stderr: '',
    exitCode: null,
    timedOut: false,
    aborted: false,
    sessionRestarted: false,
    sessionLost: false,
    droppedChars: 0,
    ...patch,
  };
}

/** 把捕获结果整理成给模型看的文本：输出 + stderr + 退出码 + 状态说明 */
export function composeContent(outcome: ExecOutcome): string {
  const blocks: string[] = [];
  const stdout = normalizeNewlines(stripClixml(outcome.stdout));
  const stderr = normalizeNewlines(stripClixml(outcome.stderr));

  if (stdout.trim() !== '') {
    blocks.push(truncateOutput(stdout).text);
  } else if (stderr.trim() === '') {
    blocks.push('（命令没有产生任何输出）');
  }
  if (stderr.trim() !== '') {
    blocks.push(`[stderr]\n${truncateOutput(stderr).text}`);
  }
  if (outcome.droppedChars > 0) {
    blocks.push(
      `[注] 输出过大，捕获阶段已丢弃中间 ${outcome.droppedChars} 字；`
      + '如需完整内容，请把结果写入文件后再分段读取。',
    );
  }
  if (outcome.exitCode !== null) {
    blocks.push(`[exit code: ${outcome.exitCode}]`);
  }
  return blocks.join('\n');
}

// ──────────────────────────────── 持久会话 ────────────────────────────────

interface SessionRound {
  /** 完成回调：事件驱动路径与超时/中断路径都走它，清理逻辑只有一处 */
  resolve: (outcome: ExecOutcome) => void;
  endRegex: RegExp;
  stdout: BoundedText;
  stderr: BoundedText;
}

/**
 * 长驻 PowerShell 会话。保持 cwd / 变量 / 函数，代价是"它随时可能死"——
 * 所以每次调用前先检查存活，死了就重建，并在结果里如实告知状态丢失。
 */
class PersistentSession {
  readonly marker = randomUUID();

  #probe: PowerShellProbe;
  #child: ChildProcessWithoutNullStreams | null = null;
  #dead = false;
  #round: SessionRound | null = null;
  /**
   * 会话代数。旧会话被杀后它的 close/data 事件会迟到到达；没有代数隔离，
   * 迟到事件会把新一轮调用误判成会话终止（实测踩过：新会话永远只能拿到空输出）。
   */
  #generation = 0;

  constructor(probe: PowerShellProbe) {
    this.#probe = probe;
  }

  get alive(): boolean {
    return this.#child !== null && !this.#dead;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /**
   * 启动会话进程。返回是否属于"重建"（此前有过会话）——
   * 调用方据此在结果里告诉模型 cwd 与变量已经丢了。
   */
  start(workdir: string): boolean {
    const restarted = this.#child !== null;
    this.#disposeChild();
    // 递增代数必须晚于 disposeChild：旧会话迟到的 close 一定不匹配新代数
    const generation = ++this.#generation;
    const isBash = this.#probe.kind === 'bash';
    const args = isBash
      ? ['--noprofile', '--norc', '-c', buildBashSessionBootstrap(this.marker)]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', toEncodedCommand(buildSessionBootstrap(this.marker))];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#probe.exe,
        args,
        { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' },
      );
    } catch {
      // 起步失败（可执行文件或 cwd 不可用）：保持 dead 状态，由 run 返回 sessionLost
      this.#dead = true;
      this.#child = null;
      return restarted;
    }
    this.#child = child;
    this.#dead = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => this.#onData(generation, 'stdout', data));
    child.stderr.on('data', (data: string) => this.#onData(generation, 'stderr', data));
    // stdin 的 EPIPE 是"会话刚死、写还在路上"的正常竞态，不能让它变成未捕获异常
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.on('error', () => this.#onExit(generation, null));
    child.on('close', (code: number | null) => this.#onExit(generation, code));
    return restarted;
  }

  #onData(generation: number, channel: 'stdout' | 'stderr', data: string): void {
    if (generation !== this.#generation) return; // 上一代会话的迟到数据
    const round = this.#round;
    if (round === null) return;
    (channel === 'stdout' ? round.stdout : round.stderr).push(data);
    this.#trySettle();
  }

  #onExit(generation: number, code: number | null): void {
    if (generation !== this.#generation) return; // 上一代会话的迟到退出，不得判死新一轮
    this.#dead = true;
    const round = this.#round;
    if (round === null) return;
    // 会话在等待期间死亡：交回已拿到的输出，并如实标记"会话丢了"
    round.resolve(emptyOutcome({
      stdout: round.stdout.text(),
      stderr: round.stderr.text(),
      exitCode: code,
      sessionLost: true,
      droppedChars: round.stdout.droppedChars + round.stderr.droppedChars,
    }));
  }

  #trySettle(): void {
    const round = this.#round;
    if (round === null) return;
    // 边界只在 stdout 上找：bootstrap 已把 PowerShell 的 error stream 并进 stdout，
    // 因此 stderr 只剩 native 子进程的输出、不含标记，按本轮全部内容取即可
    const stdoutMatch = round.endRegex.exec(round.stdout.window());
    if (stdoutMatch === null) return;

    round.resolve(emptyOutcome({
      stdout: cutBeforeMarker(round.stdout, stdoutMatch),
      stderr: round.stderr.text(),
      exitCode: Number(stdoutMatch[1]),
      droppedChars: round.stdout.droppedChars + round.stderr.droppedChars,
    }));
  }

  /**
   * 执行一轮。前置条件：调用方已确保 alive。
   * 这里**不重试**：命令可能有副作用，重复执行比失败更糟。
   */
  async run(request: { command: string; timeoutMs: number; signal: AbortSignal }): Promise<ExecOutcome> {
    const child = this.#child;
    if (child === null || this.#dead) {
      return emptyOutcome({ sessionLost: true });
    }

    let settled = false;
    let resolveOutcome!: (outcome: ExecOutcome) => void;
    const outcome = new Promise<ExecOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const round: SessionRound = {
      resolve: () => undefined,
      endRegex: new RegExp(`${END_MARKER_PREFIX}${this.marker}__ (-?\\d+)`),
      stdout: new BoundedText(),
      stderr: new BoundedText(),
    };

    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    /** 唯一完成点：清定时器、摘监听、摘轮次，然后兑现 Promise */
    const finish = (value: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null) request.signal.removeEventListener('abort', onAbort);
      this.#round = null;
      resolveOutcome(value);
    };
    // 数据到达路径（#trySettle / #onExit）也走 finish，享受同一套清理
    round.resolve = finish;
    this.#round = round;

    try {
      child.stdin.write(`${toCommandBase64(request.command)}\n`);
    } catch {
      finish(emptyOutcome({ sessionLost: true }));
      return outcome;
    }

    timer = setTimeout(() => {
      // 超时必须杀进程树：命令可能已派生出一堆还在写盘的后代（review.md 缺陷 6）
      killTree(child.pid);
      this.#dead = true;
      finish(emptyOutcome({
        stdout: round.stdout.text(),
        stderr: round.stderr.text(),
        timedOut: true,
        droppedChars: round.stdout.droppedChars + round.stderr.droppedChars,
      }));
    }, request.timeoutMs);

    onAbort = () => {
      killTree(child.pid);
      this.#dead = true;
      finish(emptyOutcome({
        stdout: round.stdout.text(),
        stderr: round.stderr.text(),
        aborted: true,
        droppedChars: round.stdout.droppedChars + round.stderr.droppedChars,
      }));
    };
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });

    return outcome;
  }

  #disposeChild(): void {
    const child = this.#child;
    this.#child = null;
    if (child === null) return;
    // 已退出的子进程不再杀：它的 pid 可能已被系统复用，误杀会波及无关进程
    if (child.exitCode === null) killTree(child.pid);
  }

  /** 优雅关停：先关 stdin 让会话自己退出（bootstrap 读到 EOF 即 break），再兜底杀树 */
  async dispose(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    this.#dead = true;
    this.#round = null;
    if (child === null) return;
    try {
      child.stdin.end();
    } catch {
      /* 已经死了 */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        killTree(child.pid);
        resolve();
      }, 1_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ──────────────────────────────── 单次执行 ────────────────────────────────

interface SingleShotOptions {
  probe: PowerShellProbe;
  command: string;
  workdir: string;
  timeoutMs: number;
  signal: AbortSignal;
}

/** 单次执行：独立进程，隔离干净，不共享任何会话状态 */
function runSingleShot(options: SingleShotOptions): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    const args = options.probe.kind === 'bash'
      ? ['--noprofile', '--norc', '-c', options.command]
      : ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', toEncodedCommand(buildSingleShotScript(options.command))];
    let child: SingleShotChild;
    try {
      child = spawn(
        options.probe.exe,
        args,
        { cwd: options.workdir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' },
      );
    } catch (err) {
      resolve(emptyOutcome({
        stderr: `无法启动 ${options.probe.exe}：${err instanceof Error ? err.message : String(err)}`,
      }));
      return;
    }

    const stdout = new BoundedText();
    const stderr = new BoundedText();
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;

    const finish = (patch: Partial<ExecOutcome>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null) options.signal.removeEventListener('abort', onAbort);
      resolve(emptyOutcome({
        stdout: stdout.text(),
        stderr: stderr.text(),
        droppedChars: stdout.droppedChars + stderr.droppedChars,
        ...patch,
      }));
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => stdout.push(data));
    child.stderr.on('data', (data: string) => stderr.push(data));
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.on('error', (err: Error) => finish({ stderr: err.message }));
    child.on('close', (code: number | null) => finish({ exitCode: code }));

    timer = setTimeout(() => {
      killTree(child.pid);
      finish({ timedOut: true });
    }, options.timeoutMs);

    onAbort = () => {
      killTree(child.pid);
      finish({ aborted: true });
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ──────────────────────────────── 工具工厂 ────────────────────────────────

interface PreparedCall {
  command: string;
  /** 本轮要用的工作目录：单次模式直接作为 spawn 的 cwd，持久会话里作为初始/切换目录 */
  workdir: string;
  /**
   * 模型是否显式给了 workdir。持久会话里这个标志决定要不要注入 Set-Location：
   * 每轮都硬切回默认目录会抹掉会话自己的 cwd 状态，那持久会话就名不副实了。
   */
  explicitWorkdir: boolean;
  timeoutMs: number;
  persistent: boolean;
  background: boolean;
  /**
   * 本次调用的有效边界（`trust.mode` 的执行形态）：`null` = 完全信任（不拦），
   * string = 只允许在这个根内。决议来自 `tools/boundary.ts`，本文件不自己判。
   */
  boundary: string | null;
}

export function createPwshTool(options: PwshToolOptions = {}): PwshToolDefinition {
  const destructiveEnabled = options.destructiveEnabled === true;
  const warn = options.onWarning ?? ((): void => undefined);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? PWSH_TIMEOUT_MS;
  const maxBackgroundMs = options.maxBackgroundMs ?? DEFAULT_BACKGROUND_MAX_MS;
  const platform = options.platform ?? process.platform;
  const toolName = shellToolName(platform);
  const shellLabel = platform === 'win32' ? 'PowerShell' : 'Bash';

  /** 探测结果缓存：进程生命周期内只探一次 */
  let probePromise: Promise<PowerShellProbe> | null = null;
  /** 探测回退的 warning 只随第一次执行回给模型，避免每轮都刷同一句话 */
  let warningDelivered = false;

  let session: PersistentSession | null = null;
  let backgroundSeq = 0;

  const probe = (): Promise<PowerShellProbe> => {
    probePromise ??= detectPowerShell({
      platform,
      ...(options.depsProbe === undefined ? {} : { deps: { probe: options.depsProbe } }),
    }).then((result) => {
      if (result.warning !== null) warn(result.warning);
      return result;
    });
    return probePromise;
  };

  /**
   * 本次执行用的是哪个 shell（回执的最后一行）。
   * 它**每次调用都重新算**，但探测本身是缓存的——所以代价只有一次字符串拼接。
   * 为什么不缓存这一行：回退状态会在运行期变化（用户装完 PS7，下一次调用就该显示 pwsh 7）。
   */
  const shellLine = async (): Promise<string> => {
    const resolved = await probe();
    return `[shell] ${resolved.kind} ${resolved.version} · ${resolved.exe}`;
  };

  const prepare = (rawArgs: unknown, ctx: ToolContext): PreparedCall => {
    const args = argsRecord(rawArgs, toolName);
    const command = requiredString(args, 'command', { maxLength: 100_000 });
    const requestedWorkdir = optionalString(args, 'workdir', { maxLength: 4096 });
    // 边界决议只此一处（tools/boundary.ts）：`undefined` = 历史默认（ctx.workspaceRoot 即边界），
    // `null` = 完全信任，string = 只限这个根。
    const boundary = effectiveBoundaryRoot(ctx);
    // 默认工作目录：`'workspace'` 模式下**就是边界根**——否则默认值本身越界，这个模式一调用
    // 就全被拒（那不是安全，是坏掉）。完全信任时照旧用 ctx.workspaceRoot。
    const workdir = requestedWorkdir ?? options.defaultWorkdir ?? boundary ?? ctx.workspaceRoot;
    const timeoutMs = optionalInteger(args, 'timeoutMs', defaultTimeoutMs, {
      min: PWSH_MIN_TIMEOUT_MS,
      max: PWSH_MAX_TIMEOUT_MS,
    });
    const persistent = optionalBoolean(args, 'persistent', true);
    const background = optionalBoolean(args, 'runInBackground', false);
    return {
      command,
      workdir,
      explicitWorkdir: requestedWorkdir !== undefined,
      timeoutMs,
      persistent,
      background,
      boundary,
    };
  };

  /**
   * 活动边界的执行点（`'workspace'` 模式）。两处一起判，判据都是 `tools/boundary.ts` 的
   * `isInside`——与 fs 工具族同一份，绝不在这里另写一套前缀比较。
   *
   * 返回 null = 放行（`'full'` 模式**永远**是 null：用户在这一档要的就是"任意目录"）。
   */
  const screenBoundary = (call: PreparedCall): string | null => {
    const boundary = call.boundary;
    if (boundary === null) return null;
    const workdirProblem = workdirBoundaryError(call.workdir, boundary);
    if (workdirProblem !== null) return workdirProblem;
    const paths = platform === 'win32' ? absolutePathLiteralsIn(call.command) : bashAbsolutePathsIn(call.command);
    for (const literal of paths) {
      const problem = commandPathBoundaryError(literal, boundary);
      if (problem !== null) return problem;
    }
    return null;
  };

  /** 工作目录必须先存在再 spawn：否则子进程只会给一句难以定位的 ENOENT */
  const assertWorkdir = (workdir: string): string | null => {
    try {
      if (statSync(workdir).isDirectory()) return null;
      return `工作目录不是目录：${workdir}`;
    } catch {
      return `工作目录不存在或不可访问：${workdir}。请用存在的目录，或省略 workdir 以使用默认值。`;
    }
  };

  /** 后台任务收尾：写输出文件 + 回调 job/finished。失败只告警，不打断主流程 */
  const finishBackground = async (
    jobId: string,
    outcome: ExecOutcome,
    command: string,
  ): Promise<void> => {
    let outputRef: string | undefined;
    const jobsDir = options.jobsDir;
    if (jobsDir !== undefined) {
      try {
        const target = join(jobsDir, `${jobId}${JOB_LOG_SUFFIX}`);
        await mkdir(dirname(target), { recursive: true });
        const header = `# command: ${command}\n# exit code: ${outcome.exitCode ?? 'null'}\n`
          + `# timed out: ${String(outcome.timedOut)}\n\n`;
        await writeFile(target, header + composeContent(outcome), 'utf8');
        outputRef = target;
      } catch (err) {
        warn(`后台任务 ${jobId} 的输出落盘失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      options.jobs?.finished(
        outputRef === undefined
          ? { jobId, exitCode: outcome.exitCode }
          : { jobId, exitCode: outcome.exitCode, outputRef },
      );
    } catch (err) {
      warn(`后台任务 ${jobId} 的 job/finished 回调抛错：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handler = async (rawArgs: unknown, ctx: ToolContext): Promise<ToolHandlerResult> => {
    let call: PreparedCall;
    try {
      call = prepare(rawArgs, ctx);
    } catch (err) {
      if (err instanceof ToolArgumentError) return errorResult(err.message, err.code);
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message, TOOL_ERROR_CODES.invalidArgs);
    }

    // 第三级门：destructive 默认关闭（design §4.10）
    if (!destructiveEnabled) {
      return errorResult(
        `${toolName} 是 destructive 工具，默认关闭，当前配置未显式开启，命令未执行。`
        + '请在配置里显式打开后重试（design §4.10 第三级门：有副作用的工具必须在配置里显式开启）。',
        TOOL_ERROR_CODES.destructiveDisabled,
      );
    }

    // 命令黑名单：命中即拒绝，并把原因与替代路径回给模型
    const forbidden = screenCommand(call.command, platform);
    if (forbidden !== null) {
      return errorResult(
        `命令被拒绝（规则 ${forbidden.id}）：${forbidden.reason}。`
        + '如果目标确实需要这一步，请说明理由并交人工执行；'
        + '若你只是想清理临时产物，把范围收敛到具体路径内再试。',
        TOOL_ERROR_CODES.denied,
      );
    }

    // 活动边界（trust.mode = 'workspace' 才拦）：workdir 与命令行里的绝对路径。
    // 放在黑名单**之后**：黑名单管"改什么"（两种模式下都拒绝），这一道管"能在哪儿动"。
    const boundaryProblem = screenBoundary(call);
    if (boundaryProblem !== null) {
      return errorResult(boundaryProblem, TOOL_ERROR_CODES.unsafePath);
    }

    if (ctx.signal.aborted) {
      return errorResult('调用已被取消，命令未执行。', TOOL_ERROR_CODES.aborted);
    }

    const workdirError = assertWorkdir(call.workdir);
    if (workdirError !== null) {
      return errorResult(workdirError, TOOL_ERROR_CODES.invalidArgs);
    }

    let resolved: PowerShellProbe;
    try {
      resolved = await probe();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message, TOOL_ERROR_CODES.noRuntime);
    }

    const extra: string[] = [];
    if (resolved.warning !== null && !warningDelivered) {
      warningDelivered = true;
      extra.push(resolved.warning);
    }

    // 后台任务：强制单次执行。持久会话是一份共享的 cwd/变量，
    // 多个后台命令并发写同一个会话会互相污染输出边界，得不偿失。
    if (call.background) {
      const jobs = options.jobs;
      if (jobs === undefined) {
        return errorResult(
          '未配置后台任务回调（jobs 未注入），runInBackground 无法使用。'
          + '请改用前台执行（命令短的话），或让维护者注入 jobs 回调。',
          TOOL_ERROR_CODES.notConfigured,
          extra,
        );
      }
      backgroundSeq += 1;
      const jobId = `job_${Date.now()}_${backgroundSeq}`;
      try {
        jobs.started({ jobId, command: call.command, turn: ctx.turn });
      } catch (err) {
        warn(`job/started 回调抛错：${err instanceof Error ? err.message : String(err)}`);
      }

      // 刻意不接 ctx.signal：后台任务的语义就是脱离本 turn 独立跑完
      void runSingleShot({
        probe: resolved,
        command: call.command,
        workdir: call.workdir,
        timeoutMs: maxBackgroundMs,
        signal: new AbortController().signal,
      }).then((outcome) => finishBackground(jobId, outcome, call.command));

      const note = call.persistent
        ? '\n[注] 后台任务使用独立进程，不共享持久会话的 cwd 与变量——需要状态请在同一条命令里完整带上。'
        : '';
      return okResult(
        `后台任务已启动：${jobId}（工作目录 ${call.workdir}，硬上限 ${maxBackgroundMs}ms）。`
        + `完成后会写 job/finished 并唤醒你；这期间本 turn 可以继续做别的事。${note}`,
        extra,
      );
    }

    let outcome: ExecOutcome;
    if (call.persistent) {
      session ??= new PersistentSession(resolved);
      // 会话不在（首次启动或已死）就重建：重建只影响"状态丢失"的告知，不影响命令语义
      let restarted = false;
      if (!session.alive) restarted = session.start(call.workdir);
      // 显式指定目录时才切换；普通调用保留会话当前目录。
      const roundScript = call.explicitWorkdir
        ? (resolved.kind === 'bash'
          ? buildBashSessionRoundScript(call.command, call.workdir)
          : buildSessionRoundScript(call.command, call.workdir))
        : call.command;
      outcome = await session.run({
        command: roundScript,
        timeoutMs: call.timeoutMs,
        signal: ctx.signal,
      });
      if (restarted) outcome = { ...outcome, sessionRestarted: true };
    } else {
      outcome = await runSingleShot({
        probe: resolved,
        command: call.command,
        workdir: call.workdir,
        timeoutMs: call.timeoutMs,
        signal: ctx.signal,
      });
    }

    const content = composeContent(outcome);
    const notes: string[] = [];
    if (outcome.sessionRestarted) {
      notes.push(
        '[持久会话已在本次调用前重建：工作目录与变量状态丢失] '
        + `之前的 ${resolved.kind === 'bash' ? 'cd' : 'Set-Location'} 与变量/函数定义都不再有效，需要的话请重新设置。`,
      );
    }
    if (outcome.sessionLost) {
      notes.push(
        '[持久会话在命令执行中终止] 常见原因是命令自身调用了 exit，或会话被外部终止。'
        + '上面是终止前拿到的输出；下一次调用会自动重建会话。',
      );
    }
    // 「这次用的是哪个 shell」贴在最末（见文件头第 1 条）：首行必须留给命令自己的输出，
    // 而这一行是元信息——模型要读它，但它不该挡住结果本身
    notes.push(await shellLine());
    const body = `${content}\n${notes.join('\n')}`;

    if (outcome.aborted) {
      return errorResult(`命令已取消（进程树已终止）。\n${body}`, TOOL_ERROR_CODES.aborted, extra);
    }
    if (outcome.timedOut) {
      return errorResult(
        `命令超时（${call.timeoutMs}ms），已终止进程树。\n${body}\n`
        + '如果这条命令本来就需要跑很久，请改用 runInBackground=true，或把它拆成更小的步骤。',
        TOOL_ERROR_CODES.timeout,
        extra,
      );
    }
    // 非零退出码不是工具失败：命令跑了、码也拿到了，模型据此自己判断
    return okResult(body, extra);
  };

  return {
    name: toolName,
    description:
      `执行 ${shellLabel} 命令，默认持久会话（cwd/变量/函数跨调用保持）。`
      + 'runInBackground=true 转后台，立刻返回 jobId、完成唤醒你。'
      + '危险命令会被拒并说明原因。输出按头 8k 尾 2k 截断。',    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: `要执行的 ${shellLabel} 命令文本，可多行` },
        workdir: { type: 'string', description: '工作目录；省略则继承持久会话当前目录（首轮为工作根；只限工作目录模式为边界根）' },
        timeoutMs: {
          type: 'integer',
          description: `超时毫秒数（${PWSH_MIN_TIMEOUT_MS}..${PWSH_MAX_TIMEOUT_MS}），默认 ${PWSH_TIMEOUT_MS}`,
        },
        persistent: { type: 'boolean', description: '是否复用持久会话，默认 true；false 则每次开新进程' },
        runInBackground: { type: 'boolean', description: '是否转入后台任务，默认 false；长命令用这个' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: PWSH_TIMEOUT_MS,
    handler,
    probe,
    shellLine,
    async shutdown(): Promise<void> {
      const current = session;
      session = null;
      if (current !== null) await current.dispose();
    },
  };
}
