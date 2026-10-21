/**
 * Irmia Agent — PowerShell 执行工具（docs/design.md §4.10 / §4.18 pwsh 专项、§4.21 jobs）
 *
 * 五条实现纪律，每条都有实测依据：
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
 * 6. **活动边界**（`config.trust.mode`，2026-10-05；v64 归类为**写类**）：`'full'`（默认）**不拦**
 *    ——她能在任意目录跑命令；`'workspace'` 时两处要判：① `workdir` 必须落在
 *    `trust.workspaceRoot` 内（此前 `assertWorkdir` 只判 `isDirectory()`，实测可以选 `C:\Windows`）；
 *    ② 命令行里出现的**绝对路径字面量**（`[A-Za-z]:\` 与 `\\` 开头）必须在边界内，否则整条命令拒绝、
 *    原因说清边界在哪。判据与 fs 工具族**同一份**（`tools/boundary.ts` 的 `isInside`）。
 *
 *    ⚠️ **v64 把这条边界归到"写"这一类**（用户 2026-10-13：「当开启工作目录模式时，**写操作**被限制到
 *    自身目录内」）：`pwsh` 能改盘上的东西 ⇒ 它按写类受限（`fs/path-guard.ts` 的 `access: 'write'`
 *    是那条判据的入口；`pwsh` 自己走上面这两处判断，语义相同）。
 *    ⚠️ **但只能管住上面那两处**：脚本内部（变量拼出来的路径、`..` 上升、子进程）仍可写到盘外——
 *    这是**既有事实**，不许读成"已经拦住"；真正兜底的是 destructive 门、黑名单与人工确认。
 *
 *    ⚠️ 这条边界管的是"能在哪儿动"，**不是**"能改什么"：`FORBIDDEN_PATTERNS` 黑名单照旧
 *    （删除、格式化、注册表、关机…在两种模式下都拒绝），`destructive` 那道门也照旧
 *    （配置显式关掉时仍然直接拒绝；出厂默认从 2026-10-21 起是全开）。
 *
 *    已知不覆盖（刻意的"够用"边界，不是漏洞承诺）：相对路径的 `..` 上升、以及通过
 *    `$env:TEMP`/变量拼出来的路径，不在扫描范围内——shell 里做完整路径分析需要自己写一个
 *    PowerShell 解析器，代价远超收益。真正兜底的是 destructive 门与人工确认（同第 5 条口径）。
 *
 * 内存有界：捕获层（BoundedText）与展示层（truncateOutput）是两道独立的闸，
 * 前者防一个 `Get-Content 大文件` 把进程吃爆，后者防大输出撑爆上下文。
 *
 * ──────────────────────────── v52：`lang`（2026-10-12） ────────────────────────────
 *
 * 用户裁决「**改造 pwsh 工具，并且 desc 要优化到清楚怎么用（整段脚本的用法）**」，
 * IRMIA 本人（用的人）实测补了五条设计要求。这一版落的六件事，逐条对应的判据：
 *
 *   ① **整段脚本**：`command` **本来就收多行**（`requiredString(maxLength:100_000)`，
 *      持久会话走 stdin 的一行 base64）——实测 `$sum=0; foreach…`、函数定义、多行输出、
 *      `Set-Location` 全部照跑。"新能力"是**描述里写清了这件事**，不是改了执行路径。
 *   ② **`lang`**：`pwsh`(默认) / `python` / `node`。她是这么说的：「省掉嵌套引号地狱、
 *      省掉'写临时 .py/.mjs → 存盘 → 跑 → 清理'那一趟往返」。⇒ 三档**同源**：
 *      都走 `runScriptFile`（写 `<workdir>/.irmia-tmp/` 下的唯一命名临时文件 → 跑 → **必删**），
 *      共用 `superviseChild` 那一套超时/杀树/2 MiB 捕获/头 8k 尾 2k。
 *   ③ **输出一套**：三档逐字同一个 `[stderr]` 段头与 `[exit code: N · <ms>ms]` 状态行
 *      （她点名的第 1 条："不想记三套"）。为此改了两处**知情的口径**：
 *      `SetError([Console]::Out)` 被删（它会把 PowerShell 的报错并进正文，另两档在 stderr），
 *      以及会话档的错误改由 `$Error` 收集、经带标记的 stdout 通道搬回 stderr
 *      （实测：pwsh 往 stderr **管道**写错误要 ~2.5 秒才落地，会话里那一轮根本读不到）。
 *   ④ **闸门一套**：超时/工作目录/截断三档同源（同一条 `superviseChild` + `assertWorkdir`）。
 *   ⑤ **cwd 与变量**：只有 `pwsh` 档共用持久会话；`python` / `node` 各开各的进程、
 *      cwd 就是 `workdir`（**不跟着 shell 会话走**）——这一条写进了 `lang` 的参数描述，
 *      并有用例钉住"上一次 `cd` 过之后下一条命令在哪"。
 *   ⑥ **node 的 `.mjs`**：工作根的 `package.json` 是 `"type": "module"`，`.js` 会被当 ESM
 *      （`require is not defined`）⇒ `lang=node` **一律写 `.mjs`**，默认就是 import 语义，
 *      不让她每次自己绕。
 *
 * **没有做**的两件事（如实记，别当成漏掉）：`site` 与时间范围筛选。端点的文档里没有它们、
 * 她的 curl 现场也没用过——编一个参数名塞进请求体，最坏的结果是"搜索照常返回、筛选静默失效"。
 * 真要限定站点，把 `site:example.com` 写进 `query` 即可（本文件不解析它，原样透传）。
 */

import {
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

import { boundaryFixHint, boundaryScopeNote, effectiveBoundaryRoot, isInside } from './boundary.ts';
import {
  POWERSHELL_UTF8_HEADER,
  decodeConsoleText,
  decodeText,
  utf8ConsoleEnv,
  type DecodedText,
} from '../util/bytes-text.ts';
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

/**
 * 持久会话里"认出结束标记"到"兑现结果"之间的收尾窗口（毫秒）。
 *
 * 为什么需要它（v52 实测踩到，**不是猜测**）：pwsh 把错误写进 stderr **管道**时不是立刻
 * 落地的（实测要 30ms 上下才到达），而结束标记是同一轮里立刻写出来的——于是
 * `Write-Error "boom"` 的错误在"认出标记"那一刻还在路上，`round.stderr` 读出来是空串，
 * 报错就这么凭空消失了（实测：stderr 里只剩一个孤零零的 `#< CLIXML` 头）。
 * 这不只是显示问题：IRMIA 2026-10-12 的第 1 条要求是"三种 lang 同一套 stderr"，
 * 而 python / node 的报错是同步写出来的，只有 PowerShell 这一档会漏。
 *
 * 30ms 是**实测值**（探针 `_research/_tmp-pwsh-session-stderr.mts`：标记与 CLIXML 同轮写出，
 * 前者先到、后者晚 20~40ms）。代价是每条会话命令多等 30ms——相对 pwsh 一次调用的
 * 几百毫秒启动/往返，这 30ms 买的是"报错不许丢"，这笔账是划算的。
 */
const SESSION_STDERR_SETTLE_MS = 30;

/** 后台任务输出落盘文件后缀 */
export const JOB_LOG_SUFFIX = '.log';

/** 检测不到 PS7 时回给模型的安装建议（design §4.18 pwsh 专项第 1 条） */
export const POWERSHELL_INSTALL_HINT = 'winget install Microsoft.PowerShell';

// ──────────────────────────────── 语言（v52） ────────────────────────────────

/**
 * 这段脚本是什么语言。`pwsh` 是默认档。
 *
 * 用户 2026-10-12 的原话：「**改造 pwsh 工具，并且 desc 要优化到清楚怎么用（整段脚本的用法）**」
 * ——诉求是"**她不用先把脚本写成文件**，直接把整段代码交给它就能跑"。
 * 实测依据（`_ops-audit-7/REPORT.md` §5.3）：全量 860+ 次 `pwsh` 调用里 **64 处**是在内联跑
 * `node -e "…"` / `python -c @"…"@` / `python - <<'PY'`，其中最长的单条命令 **900+ 字符**
 * （`seq 36476`：PIL + ctypes 截屏）——转义吃掉的是她的注意力，不是能力。
 */
export type PwshLang = 'pwsh' | 'python' | 'node';

/** `lang` 的取值表（顺序即报错文案里的顺序，也是描述里的顺序） */
export const PWSH_LANGS: readonly PwshLang[] = ['pwsh', 'python', 'node'];

/** `lang` 缺省值：不写就是 PowerShell，与 v51 的 `command` 语义**逐字相同** */
export const PWSH_DEFAULT_LANG: PwshLang = 'pwsh';

/**
 * 每种语言的落盘后缀与调用形状。
 *
 * 为什么非 PowerShell 那两档必须走**临时文件**（而不是 `python -c "…"`）：
 * `-c` 的正文要重新过一次命令行引号规则，那正是用户要消灭的那件事
 * （「引号/换行/中文都不需要她自己转义」）。写文件之后，引号、换行、中文、`$`、`%`
 * 全部只是文件里的字节——`spawn` 的命令行里只有**一个我们生成的路径**。
 */
export const LANG_SPECS: Record<PwshLang, { suffix: string; label: string }> = {
  pwsh: { suffix: '.ps1', label: 'PowerShell' },
  python: { suffix: '.py', label: 'Python' },
  node: { suffix: '.mjs', label: 'Node.js' },
};

/** 临时脚本目录名（落在**本次调用的 workdir 之下**，见 `tmpScriptDirOf`） */
export const TMP_SCRIPT_DIR_NAME = '.irmia-tmp';

/**
 * 非 PowerShell 那两档的解释器探测顺序。
 *
 * 为什么 python 有两项：Windows 上官方安装器给的是 `python.exe`（Store 版是 `python3.exe`），
 * 而 Linux/macOS 上是 `python3`（`python` 常常根本不存在或者指 python2）。
 * 顺序按"哪个更可能是 python3"排：`python3` 先探，`python` 兜底。
 */
export const LANG_INTERPRETERS: Record<Exclude<PwshLang, 'pwsh'>, readonly string[]> = {
  python: ['python3', 'python'],
  node: ['node'],
};

/** 探测解释器时的超时：跑一次 `--version`，10s 足够（与 PROBE_TIMEOUT_MS 同一口径） */
export const INTERPRETER_PROBE_TIMEOUT_MS = 10_000;

/** 临时脚本的删除重试：Windows 上子进程刚读完时可能短暂占用（EBUSY/EPERM） */
const TMP_SCRIPT_UNLINK_ATTEMPTS = 5;

/** 会话内结束标记的前缀，中间嵌 guid */
const END_MARKER_PREFIX = '__IRMIA_END_';

/**
 * 错误块的起止标记（v52，见 `SCRIPT_HEADER` 与 `extractSessionErrors` 的注释）。
 *
 * 为什么错误要**借 stdout 的一条带标记的通道**走：pwsh 把错误记录写进 stderr **管道**时
 * 不是立刻落地的（实测：标记 444ms 到，错误块 **2.5 秒后**才到，而且只有 stdin 关闭才吐出来）
 * ——会话是一份长驻进程，这个延迟等于"报错这一轮读不到"。所以改由 bootstrap 自己
 * 把错误格式化成纯文本、夹在标记里写 stdout，Node 侧再把它搬回 `[stderr]` 段
 * （用户的 `[Console]::Error.WriteLine` 照旧走真 stderr，不受影响）。
 */
const SESSION_ERROR_BEGIN = '__IRMIA_ERR_BEGIN__';
const SESSION_ERROR_END = '__IRMIA_ERR_END__';

// ──────────────────────────────── 类型 ────────────────────────────────

export type PowerShellKind = 'pwsh' | 'powershell';

export interface PowerShellProbe {
  /** 探测到的运行时种类 */
  kind: PowerShellKind;
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
  /**
   * 托管 Python 的自包含 pip 配置路径（`<数据Dir>/tools/python/pip.ini`，由宿主给出——
   * tools 层不知道 dataDir 在哪，与 `depsProbe` 同一条分工）。
   *
   * 给了它并且**文件真的在盘上**时，`lang:'python'` 那一段脚本的子进程会带上
   * `PIP_CONFIG_FILE=<它>`（镜像 / 超时 / 代理都写在那一个文件里，于是她的 pip 配置自包含）。
   * **另两档（`pwsh` / `node`）一个字节都不加**——那对它们毫无意义，设上就是污染别人的环境。
   */
  pythonPipConfigFile?: string | undefined;
  /**
   * 非 pwsh 那两档的**解释器候选接缝**（宿主注入；见 `LangDepProbe`）。
   *
   * 给了它就有"**PATH 优先、托管兜底**"：先用机器上本来就有的那份（名字链 `python3` /
   * `python`，走 PATH），**一个都没有**时才用框架自装目录里那一份。
   * 不给 = 与 v52 逐字相同的纯 PATH 行为（CLI 窄路径与大多数单测）。
   */
  langProbe?: LangDepProbe | undefined;
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
  /**
   * 这条规则管哪些语言（`lang` 的那些取值）。
   *
   * 为什么要有这一格（v52 加 `lang` 之后才成立的一件事）：`screenCommand` 原先只面对
   * PowerShell 文本，所以那些规则写成了 PowerShell/cmd 的**语法**。同一个动作在
   * python / node 里写成 `shutil.rmtree` / `fs.rmSync(..., {recursive:true, force:true})` 时
   * **一句都命不中**，而它的破坏力与 `Remove-Item -Recurse -Force` 一模一样。
   * 反过来，python 脚本正文里出现 `"Remove-Item -Recurse -Force"` 这种**字符串**只是数据
   * （她可能在写一个生成 PowerShell 的脚本），拿 PowerShell 的语法去拒它就会误伤。
   * ⇒ 判据按语言分组：`powershell` 的规则是既有那 13 条（一个字节不改），
   *   `python` / `node` 各有一组**按该语言真实语法**写的规则。
   *
   * 缺省（不写这一格）= 只对 PowerShell 生效：既有 13 条因此逐字保持原意，
   * `screenCommand(command)` 这个单参调用点的行为与 v51 逐字节相同。
   */
  langs?: readonly PwshLang[];
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
  // ── 下面两组只对 `lang: 'python'` / `lang: 'node'` 生效（v52） ──
  //
  // 判据（写在这里防暗坑）：上面 13 条写的是 **PowerShell / cmd 的语法**，
  // 它们在 python / node 正文里**一句都命不中**——`shutil.rmtree('C:/')` 与
  // `fs.rmSync('C:/', {recursive:true, force:true})` 的破坏力与 `Remove-Item -Recurse -Force`
  // 完全一样，而从前那两条路上没有任何一条规则看得见它们（语言是 v52 才有的）。
  // 所以这里补的是**按各语言真实语法**写的同一批动作，不是把 PowerShell 的正则照搬过来
  // （照搬会误伤：写一个"生成 PowerShell 删除命令"的 python 脚本时，正文里那句字符串只是数据）。
  {
    id: 'py-rmtree',
    langs: ['python'],
    pattern: /shutil\s*\.\s*rmtree\b|\bos\s*\.\s*removedirs\b/,
    reason: 'shutil.rmtree / os.removedirs 是递归删除目录的 Python 写法，无人值守下不可撤销',
  },
  {
    id: 'py-disk-write',
    langs: ['python'],
    pattern: /\b(format|diskpart|mkfs(\.\w+)?|bcdedit|vssadmin)\b|winreg\s*\.\s*(SetValue|CreateKey|DeleteKey)|shutdown\s*\.\s*(shutdown|restart)/,
    reason: '格式化 / 分区 / 引导配置 / 写注册表 / 关机重启：系统级且跨重启生效',
  },
  {
    id: 'node-rm-recursive',
    langs: ['node'],
    // ⚠ 这条规则**刻意不写成一个把调用语法描出来的正则**（v52 连踩两次，两次都是"看着对、
    //    跑起来一个都不命中"）：`\b` 在 `fs.rmSync(` 上两头都成立、`[^)]*` 在
    //    `{ recursive: true }` 上会被自己的 `)` 截断、`{0,200}?` 又要求至少一个字符……
    //    这些细节任何一处写歪的结果都是**静默放行**，而这一条是安全规则，静默放行是最坏的失败。
    //    所以判据拆成两条**交集**（都在归一化后的同一行上找，见下）：
    //      ① 出现了删除调用名（`rmsync` / `rmdirsync` / 独立的 `rm`）；
    //      ② **同一行上**同时出现 `recursive` 与 `true`（顺序、引号、空格都不拘）。
    //    行内约束（`[^\n]`）是必须的：跨行的 `recursive: true` 多半属于另一个对象字面量，
    //    放它过去会把一大片正常的 `fs.rm` 误判成递归删除。
    //    代价（知情接受）：同一行里既有 `fs.rm(...)` 又有别处一个无关的 `recursive: true`
    //    会被误判——那是**收紧**方向，且这一层本来就不是完备判定（见 FORBIDDEN_PATTERNS 说明）。
    pattern: /(?=[^\n]*?(?<!\w)(rmsync|rmdirsync|rm)(?![\w]))(?=[^\n]*recursive[^\n]*true)/,
    reason: 'fs.rmSync/rm/rmdirSync 带 recursive:true 等于递归强制删除，无人值守下不可撤销',
  },
  {
    id: 'node-disk-write',
    langs: ['node'],
    pattern: /\b(format|diskpart|mkfs(\.\w+)?|bcdedit|vssadmin)\b/,
    reason: '格式化 / 分区 / 引导配置 / 卷影删除：系统级且跨重启生效',
  },
];

/** 归一化：小写 + 连续空白压成一个空格。换行与制表符因此不会成为绕过通道 */
export function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 这条规则管不管这个语言（没写 `langs` = 只管 PowerShell，见 ForbiddenPattern.langs） */
function appliesTo(rule: ForbiddenPattern, lang: PwshLang): boolean {
  return (rule.langs ?? ['pwsh']).includes(lang);
}

/** 命中返回规则本身，未命中返回 null（`lang` 缺省 = PowerShell，与 v51 逐字同义） */
export function screenCommand(command: string, lang: PwshLang = PWSH_DEFAULT_LANG): ForbiddenPattern | null {
  const normalized = normalizeCommand(command);
  for (const rule of FORBIDDEN_PATTERNS) {
    if (!appliesTo(rule, lang)) continue;
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

/** ANSI 颜色序列（CLIXML 里的错误文本带着 `ESC[31;1m` 这类装饰） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/gu;

/** CLIXML 的字符转义：`_x001B_` = U+001B、`_x000D_` = CR */
const CLIXML_ESCAPE_RE = /_x([0-9A-Fa-f]{4})_/gu;

/**
 * 把 PowerShell 的 **CLIXML 错误块**解成可读的纯文本（v52 新增，见 `SCRIPT_HEADER` 那段注释）。
 *
 * 为什么需要它：pwsh 往**非控制台的 stderr 句柄**（我们 spawn 出来的管道就是）写错误时，
 * 会把错误记录序列化成
 * `#< CLIXML\n<Objs …><S S="Error">_x001B_[31;1mWrite-Error: _x001B_[31;1mboom_x001B_[0m…</S></Objs>`。
 * `stripClixml` 会把整个 `<Objs>` 块**丢掉**（它当年的用途是"别让模型读到一坨 XML"），
 * 于是有了 `lang` 之后就不够了：IRMIA 2026-10-12 的第 1 条要求是"三种 lang 都返回同一套
 * stdout/stderr/exit code/耗时"——python 的 traceback 与 node 的栈是她读得到的，
 * 而 PowerShell 的 `Write-Error` 只剩一句空（实测：`stripClixml` 之后 stderr 变成空串）。
 *
 * 所以这里做的是**解码而不是丢弃**：把每个 `<S S="Error">…</S>` 里的文本解出来、
 * 去掉 ANSI 装饰、还原 `_xNNNN_` 转义，逐条成行。它不是 CLIXML 的完整解析器
 * （只认 `S="Error"` 那一类节点，够用即可），解不出来时**退回原文**而不是报错——
 * 这是展示层，宁可多留几个字节，也不能让她的报错凭空消失。
 */
export function decodeClixmlErrors(text: string): string {
  if (!text.startsWith('#< CLIXML')) return text;
  const chunks: string[] = [];
  const nodeRe = /<S S="Error">([\s\S]*?)<\/S>/gu;
  for (let match = nodeRe.exec(text); match !== null; match = nodeRe.exec(text)) {
    const decoded = (match[1] ?? '')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replace(CLIXML_ESCAPE_RE, (_all, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(ANSI_RE, '');
    for (const line of normalizeNewlines(decoded).split('\n')) {
      const trimmed = line.trimEnd();
      if (trimmed.trim() !== '') chunks.push(trimmed);
    }
  }
  // 一个 Error 节点都没解出来：退回"剥掉 XML 只留散文本"的旧口径，绝不返回空串
  return chunks.length === 0 ? stripClixml(text) : chunks.join('\n');
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
 * 子进程输出 → 文本。**判据已收口到 `util/bytes-text.ts`**（`decodeConsoleText`）：
 * 严格 UTF-8 → 严格 UTF-16 BOM → 严格 GB18030 → 混编码时"谁留下的无法映射字符更少"。
 *
 * 为什么需要回落（2026-10-16；392 条回执的来源就是这个）：
 * 命令本体走 base64 + `Invoke-Expression`，所以子进程（python / node / 老的 exe）**从我们这里
 * 拿到的编码始终是 UTF-8**；但**它写回来的字节**取决于它自己的控制台代码页——中文 Windows 上
 * 常是 GBK（cp936）。`SCRIPT_HEADER` 里那几条设置管得住 PowerShell 自己的输出流，管不住
 * 子进程：那是一个独立进程、自己决定往管道里写什么字节。于是 `setEncoding('utf8')` 把 GBK
 * 字节解成一串 `U+FFFD`，而且**原有的字节在字符串化那一刻就已经丢了**——事后无从补救。
 *
 * 所以捕获层存**原始字节**，解码推迟到这里，一次读完再判。
 *
 * ⚠ **判据是"哪个无法映射的字符少"，不是"猜内容"**：我们不改写、不纠正任何字符。
 * 2026-10-18 起还有一件事变了：**绝不静默产出 U+FFFD**——真到两档都失败时，
 * 回执会写明"按 X 解、N 处无法映射"（见 `composeContent` 的 `[编码]` 段）。
 */
export function decodeConsole(bytes: Uint8Array): string {
  return decodeConsoleText(bytes).text;
}

/** 解码的完整读数（`decodeConsole` 只要文本，回执要能说出"按什么解、有没有损"） */
export function decodeConsoleResult(bytes: Uint8Array): DecodedText {
  return decodeConsoleText(bytes);
}

/**
 * 有界文本缓冲：保留头 headLimit + 尾 tailLimit，中间丢弃并计数。
 * 两个用途合一的理由：结束标记**总是最后写出**，所以它必然落在保留下来的尾部里，
 * 边界解析与内存保护用同一个结构即可，不需要两套累积逻辑。
 *
 * **内部存原始字节**（2026-10-16）：`push` 收 `Buffer`（暂存字符串时按 UTF-8 转字节），
 * `text()` / `window()` 在**读的那一刻**才解码，于是 {@link decodeConsole} 的
 * "UTF-8 不行就 GBK"这一次判断能看见完整的字节序列。头/尾两道闸按**字节**计
 * （与 `MAX_CAPTURE_CHARS` 的语义差一个常数因子：UTF-8 中文 3 字节/字，这个上限本来就是
 * 内存保护、不是精确配额，收紧方向是安全的）。
 */
export class BoundedText {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head: Buffer = Buffer.alloc(0);
  #tail: Buffer = Buffer.alloc(0);
  #dropped = 0;
  /** 最近一次读出的解码读数（回执靠它说"按什么解、有没有损"） */
  #decode: DecodedText | null = null;

  constructor(limit = MAX_CAPTURE_CHARS) {
    this.#headLimit = Math.floor(limit / 2);
    this.#tailLimit = limit - this.#headLimit;
  }

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (bytes.length === 0) return;
    if (this.#head.length < this.#headLimit) {
      this.#head = Buffer.concat([this.#head, bytes]);
      if (this.#head.length > this.#headLimit) {
        // 头写满：溢出部分滚进尾部，此后头不再增长
        this.#tail = this.#head.subarray(this.#headLimit);
        this.#head = this.#head.subarray(0, this.#headLimit);
      }
      return;
    }
    this.#tail = Buffer.concat([this.#tail, bytes]);
    if (this.#tail.length > this.#tailLimit) {
      this.#dropped += this.#tail.length - this.#tailLimit;
      this.#tail = this.#tail.subarray(-this.#tailLimit);
    }
  }

  /** 捕获层丢弃的**字节数**（展示层那句话说的是"字"，量纲差一个常数因子，见类注释） */
  get droppedChars(): number {
    return this.#dropped;
  }

  /** 保留下的文本（中间被丢弃时是头尾直接相接，省略说明由展示层负责） */
  text(): string {
    const decoded = decodeConsoleText(Buffer.concat([this.#head, this.#tail]));
    this.#decode = decoded;
    return decoded.text;
  }

  /** {@link text} 那一次的完整解码读数（`text()` 没被调用过时为 null） */
  get decode(): DecodedText | null {
    return this.#decode;
  }

  /**
   * 尾部搜索窗口：取 `text()` 的最后 MARKER_WINDOW_CHARS 个字符。
   * 为什么不是 `#tail` 单独一段：短输出时尾部为空（全在头部），那样永远找不到标记。
   */
  window(): string {
    const all = this.text();
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

/**
 * 每条命令共用的头部。三条设置各自解决一个实测问题，见文件头第 3 条。
 *
 * ⚠ v52 删掉了这里的 `[Console]::SetError([Console]::Out)`（**一处知情的口径变更**）：
 * 它当年的作用是"把 PowerShell 的 error stream 并进 stdout，否则错误会被序列化成
 * `<# CLIXML …>` XML（模型完全读不懂）"。加了 `lang` 之后这条口径站不住了——
 * IRMIA 2026-10-12 的第 1 条要求是"**三种 lang 都返回同一套 stdout / stderr / exit code / 耗时**"，
 * 而 python / node 的 stderr 天然是独立流（强行合并等于把两档的报错混进正文）。
 * 合并 stdout 之后，`Write-Error` 的文本会落在**正文**里，而另两档落在 `[stderr]` 段里
 * ⇒ 同一件事在三个档三种位置，正是她不想记的那套东西。
 * 所以：**stderr 就是 stderr**（`composeContent` 逐档同一个 `[stderr]` 段头）。
 * CLIXML 那一层没有丢：`stripClixml` 照旧按锚定剥离（5.1 在非控制台句柄上仍会输出它），
 * `ERROR_FLUSH` 那份逐条回显也不再需要（错误本来就在 stderr 上，回显只会变成第二份）。
 */
const SCRIPT_HEADER = [
  "$ErrorActionPreference='Continue'",
  // 编码那几条**从 `util/bytes-text.ts` 取**（2026-10-18 收口）：全仓只有那一处定义
  // "把控制台逼成 UTF-8"的三条设置，别的 spawn 也引同一份，不存在两处各写一套而漂移。
  //
  // ⚠ v52 删掉了这里的 `[Console]::SetError([Console]::Out)`（**一处知情的口径变更**）：
  // 它当年的作用是"把 PowerShell 的 error stream 并进 stdout，否则错误会被序列化成
  // `<# CLIXML …>` XML（模型完全读不懂）"。加了 `lang` 之后这条口径站不住了——
  // IRMIA 2026-10-12 的第 1 条要求是"**三种 lang 都返回同一套 stdout / stderr / exit code / 耗时**"，
  // 而 python / node 的 stderr 天然是独立流（强行合并等于把两档的报错混进正文）。
  // 合并 stdout 之后，`Write-Error` 的文本会落在**正文**里，而另两档落在 `[stderr]` 段里
  // ⇒ 同一件事在三个档三种位置，正是她不想记的那套东西。
  // 所以：**stderr 就是 stderr**（`composeContent` 逐档同一个 `[stderr]` 段头）。
  // CLIXML 那一层没有丢：`stripClixml` 照旧按锚定剥离（5.1 在非控制台句柄上仍会输出它），
  // `ERROR_FLUSH` 那份逐条回显也不再需要（错误本来就在 stderr 上，回显只会变成第二份）。
  ...POWERSHELL_UTF8_HEADER,
].join('\n');

/** 把命令包进 try/catch（catch 留空：错误已经在 stderr 上，catch 只负责不中断会话） */
function invokeExpressionLine(command: string): string {
  return `try{ Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${toCommandBase64(command)}'))) }catch{ }`;
}

/**
 * 单次执行脚本：编码设置 → 执行 → 用 $LASTEXITCODE 收敛退出码。
 * 末尾那句 `exit $LASTEXITCODE` 是必需的：实测 `-EncodedCommand` 结束时 pwsh 会把
 * `cmd /c "exit 9"` 这种非零退出码吞成 1，显式 exit 才能把真实码传出来。
 */
export function buildSingleShotScript(command: string): string {
  return [
    SCRIPT_HEADER,
    invokeExpressionLine(command),
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
    `$irmiaErrBegin='${SESSION_ERROR_BEGIN}'`,
    `$irmiaErrEnd='${SESSION_ERROR_END}'`,
    'while($true){',
    '$irmiaLine=[Console]::In.ReadLine()',
    'if($null -eq $irmiaLine){break}',
    '$irmiaCode=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($irmiaLine))',
    '$global:LASTEXITCODE=0',
    '$irmiaEc=0',
    // `$Error` 每轮清零：不清就会把前面几轮的旧错误一遍遍重放（v52 之前用 ERROR_FLUSH
    // 就是为了同一件事，那一版在**之后**清、这一版在**之前**清——判据见下面那段）
    '$Error.Clear()',
    'try{',
    'try{ Invoke-Expression $irmiaCode }catch{ }',
    'if($null -ne $global:LASTEXITCODE){$irmiaEc=$global:LASTEXITCODE}',
    '} finally {',
    // 错误块：从 `$Error` 里逐条取（**这里不能用 `2>&1` 去收**——v52 实测：`2>&1` 会把
    // 错误流并进成功流，而 `Invoke-Expression` 里 `Write-Error` 产生的那一条**在合并时被
    // 丢掉了**（`@(iex … 2>&1)` 只剩 `after`，`$Error` 里却明明有一条）。`$Error` 是
    // 唯一可靠的来源：非终止错误、终止错误、native 的 stderr 都在里面。
    'for($irmiaI=0; $irmiaI -lt $Error.Count; $irmiaI++){',
    '[Console]::Out.WriteLine($irmiaErrBegin)',
    '[Console]::Out.WriteLine(($Error[$irmiaI] | Out-String).TrimEnd())',
    '[Console]::Out.WriteLine($irmiaErrEnd)',
    '}',
    '$Error.Clear()',
    `[Console]::Out.WriteLine(${markerExpression}); [Console]::Out.Flush()`,
    '}',
    '}',
  ].join('\n');
}

/**
 * 从会话输出里切出错误块，剩下的才是正文（`{ stdout, stderr }` 两份）。
 *
 * 判据是那两个标记（`SESSION_ERROR_BEGIN` / `SESSION_ERROR_END`）：成对出现才算一块，
 * 半块（用户自己的输出里恰好写了标记）**按正文留着**，绝不吞掉她的字节。
 * 一块错误 = `[stderr]` 段里的一段；多块按出现顺序拼起来（顺序就是它们产生的顺序）。
 */
export function extractSessionErrors(text: string): { stdout: string; stderr: string } {
  const beginAt = text.indexOf(SESSION_ERROR_BEGIN);
  if (beginAt < 0) return { stdout: text, stderr: '' };
  const stdoutLines: string[] = [];
  const errorBlocks: string[] = [];
  for (const line of normalizeNewlines(text).split('\n')) {
    if (line === SESSION_ERROR_BEGIN) {
      errorBlocks.push('');
      continue;
    }
    if (line === SESSION_ERROR_END) {
      errorBlocks.push('\u0000'); // 块结束哨兵：下一个非空行开新块
      continue;
    }
    if (errorBlocks.length === 0) {
      stdoutLines.push(line);
      continue;
    }
    if (errorBlocks[errorBlocks.length - 1] === '\u0000') {
      if (line.trim() === '') continue; // 块与块之间的空行不进任何一份
      errorBlocks.push(line);
      continue;
    }
    const last = errorBlocks.length - 1;
    errorBlocks[last] = errorBlocks[last] === '' ? line : `${errorBlocks[last]}\n${line}`;
  }
  const stderr = errorBlocks
    .filter((block) => block !== '' && block !== '\u0000')
    .join('\n');
  return { stdout: stdoutLines.join('\n'), stderr };
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

// ──────────────────────────────── 临时脚本（v52 的 lang 通道） ────────────────────────────────

/**
 * 本次调用放临时脚本的目录：**workdir 之下**（`<workdir>/.irmia-tmp`）。
 *
 * 为什么不是 `os.tmpdir()`：临时文件的落点必须过**同一道活动边界**。
 * `workdir` 在走到这里之前已经过 `screenBoundary`（`workspace` 模式下必须在边界内）
 * 与 `assertWorkdir`（必须存在且是目录），所以它是"本次调用本来就允许活动的地方"——
 * 往它下面写一个隐藏目录，边界判据一个都不用重写，也不会与用户现场的文件撞名。
 * 用系统 temp 则要多一套"临时目录算不算在边界内"的判据，那正是 `boundary.ts` 文件头
 * 点名不许再出现第二份的东西。
 */
export function tmpScriptDirOf(workdir: string): string {
  return join(workdir, TMP_SCRIPT_DIR_NAME);
}

/**
 * 临时脚本名：**唯一**（同一次调用重入也不会撞）。
 *
 * 三段拼出来：工具名 + 随机 uuid（主段，进程内与跨进程都唯一）+ 时间戳（36 进制，给人读）。
 * 为什么不用 `callId`：它由宿主给，格式不在工具层手里；而"两次调用撞同一个文件名"
 * 的后果是**她跑的是别人那一段脚本**——那是这个功能里最不能出的错。
 */
export function tmpScriptPathOf(workdir: string, lang: PwshLang): string {
  const unique = randomUUID().replace(/-/g, '').slice(0, 16);
  return join(tmpScriptDirOf(workdir), `pwsh-${lang}-${Date.now().toString(36)}-${unique}${LANG_SPECS[lang].suffix}`);
}

/**
 * 删掉临时脚本（**异常路径也要删**，这是用户点名的判据之一）。
 *
 * 为什么退避重试：Windows 上子进程刚读完文件时可能短暂持有句柄（EBUSY/EPERM），
 * 而"删不掉"的后果是 `.irmia-tmp` 里越攒越多她的脚本正文。重试 5 次仍失败**不抛错**
 * ——命令已经跑完了，为了删文件把结果变成错误是本末倒置——改为经 `onWarning` 如实告知。
 */
async function removeTmpScript(path: string, onWarning: (message: string) => void): Promise<void> {
  let delay = 20;
  for (let attempt = 0; attempt < TMP_SCRIPT_UNLINK_ATTEMPTS; attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return;
      if (attempt === TMP_SCRIPT_UNLINK_ATTEMPTS - 1) {
        onWarning(
          `临时脚本删不掉（${path}）：${err instanceof Error ? err.message : String(err)}。`
          + '它留在了上一次调用的工作目录下，可以手动清理。',
        );
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

/** 目录空就顺手删掉：不空（别的调用的脚本还在）就留着，rmdir 失败属于正常 */
async function removeTmpDirIfEmpty(dir: string): Promise<void> {
  try {
    await rmdir(dir);
  } catch {
    /* 不空 / 不存在 / 被占用：都不是错误 */
  }
}

/**
 * **解释器候选的两槽结论**（只有 python 有"托管"这回事：`node` 不在外部依赖清单里，
 * 它由机器自己装 —— 所以这个接缝只回答 python）。
 *
 * 为什么要有这个接缝：`tools` 层不知道 dataDir 与配置在哪（那是宿主的事），而"本机有没有
 * 可用的 python、在哪"这件事由 `src/deps/` 统一回答。**探测一次、结论传进来**：
 * `deps` 回答"两处各有什么"，这里回答"先用哪一个、用不了怎么办"。
 *
 * 为什么是**两槽**而不是一个"答案"（用户 2026-10-17 翻正的那一次）：
 * 上一版宿主直接把赢家交给工具，而当时的口径是"托管优先"——于是"PATH 上有一个现成的"
 * 这件事在工具层根本看不见。现在工具自己定顺序（见 `resolveInterpreter`），
 * 就必须同时拿到两处**各自**的候选，否则"PATH 优先"只能靠重新探一遍 PATH 来实现。
 *
 * ⚠ **PATH 优先、托管兜底**（用户的原话：「**Python 和 pip 不应该是默认要求装的，
 * 而是有就用 PATH 里的。没有的话就要求装。**」）：
 *   · `pathSlot`   = 机器上本来那一份（PATH 上的裸名，或 `deps.paths.python` 指的路径）；
 *   · `managedSlot`= 框架自装目录 `<数据Dir>/tools/python/` 里那一份（**兜底**；
 *     一键安装的落点，本来是给"这台机器一个 python 都没有"的机器准备的）。
 *
 * `pipConfigFile` 只在**真的用到托管那一份**时才有值（`<数据Dir>/tools/python/pip.ini`，
 * 引导步骤写的）——系统那份旁边没有我们的 pip.ini，硬塞过去就是改掉她自己的 pip 配置。
 */
export interface LangDepProbeOutcome {
  /** PATH / 用户指定那一槽的候选；两处都没有时 null */
  pathSlot: string | null;
  /** 框架自装目录里那一槽的候选（完整路径）；托管没装时 null */
  managedSlot: string | null;
  /** 用到 `managedSlot` 时随之生效的托管 pip 配置；否则 null */
  pipConfigFile: string | null;
}

/** 宿主注入的解释器候选接缝（`undefined` = 与 v52 逐字相同的纯 PATH 行为） */
export type LangDepProbe = () => Promise<LangDepProbeOutcome>;

/**
 * 解析出来的解释器：`exe` / `version` 之外还带上**它是哪一份**。
 *
 * `managed` 那一格是给回执用的（用户 2026-10-17：「回执里要说清**用的是哪一个 python**
 * ——PATH 的还是托管的」）：只写路径时，`C:\...\tools\python\python.exe` 与
 * `C:\Python311\python.exe` 要人去分辨，而"这一次到底用了谁"是这个工具必须自己说清的事。
 */
interface ResolvedInterpreter {
  exe: string;
  version: string;
  pipConfigFile: string | null;
  /** true = 用的是框架托管那一份（`<数据Dir>/tools/<名字>/` 下那个） */
  managed: boolean;
}

/** 解释器探测（python / node）：跑一次 `--version`，成功即认定可用。
 *
 * 探测结果**按语言缓存**（进程生命周期内一次）：与 `detectPowerShell` 的缓存同一条纪律
 * ——"这台机器有没有 python"在一次会话里不会变，而每次调用都起一个进程问版本是纯浪费。
 * 找不到时**不静默降级**（不会偷偷拿 PowerShell 去跑它）：回执里如实说清"这台机器上没有
 * 可用的 python"，因为拿错语言跑一段脚本的结果是"看起来跑了、结果全错"。
 */
async function probeInterpreter(exe: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    let child: SingleShotChild;
    try {
      child = spawn(exe, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => {
      killTree(child.pid);
      finish(null);
    }, INTERPRETER_PROBE_TIMEOUT_MS);
    // **收原始字节**（2026-10-18）：版本串本身是 ASCII，但这条命令的 stderr 里可能带着
    // 发行版自己写的中文诊断（cp936 字节）。同一个函数产出的文本会被拿去判"这是哪个解释器"，
    // 拿不准就会把另一门语言认成 python——那比一句乱码贵得多。
    const outChunks: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => { outChunks.push(data); });
    child.stdout.on('error', () => undefined);
    // 有的解释器把版本写 stderr（node 早期版本、部分 python 发行版），两路一起收
    child.stderr.on('data', (data: Buffer) => { outChunks.push(data); });
    child.stderr.on('error', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', () => {
      const out = decodeText(Buffer.concat(outChunks)).text;
      const version = out.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
      finish(version === '' ? null : version);
    });
  });
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

    // **收原始字节**（2026-10-18）：同 `probeInterpreter`，版本串走同一条判定链
    const outChunks: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => {
      outChunks.push(data);
    });
    child.stdout.on('error', () => undefined);
    child.stderr.on('data', () => undefined);
    child.stderr.on('error', () => undefined);
    child.on('error', () => finish(null));
    child.on('close', () => {
      const out = decodeText(Buffer.concat(outChunks)).text;
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
}

/** 探测结论的缓存：进程生命周期内只探一次（真探测代价是一次 shell 启动） */
let cachedProbe: Promise<PowerShellProbe> | null = null;

/** 丢掉探测缓存（测试与"安装后复检"用；宿主不必调——它拿的是 deps 的缓存结论） */
export function resetPowerShellProbeCache(): void {
  cachedProbe = null;
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
  /**
   * 进程根本没起来（解释器找不到、脚本文件写不出去……）。
   *
   * 为什么要与 `exitCode !== 0` 分开：这两件事对她要做的事完全不同——
   * "脚本跑了、退出码 1"是代码有问题（读 stderr 改代码），
   * "进程没起来"是环境有问题（换解释器或让别人装一个）。混成一种会让她去改一段没错的代码。
   */
  spawnFailed?: boolean;
  /**
   * 这一趟实际花了多少毫秒（**三档同一套读数**，IRMIA 2026-10-12 点名的第 1 条）：
   * 她要看的是"这次是慢在命令本身还是慢在别处"，而"三档各给一套格式"等于让她记三套。
   * 缺省 null = 没量到（不该出现，只是别编一个数出来）。
   */
  elapsedMs?: number | null;
  /**
   * 捕获层这次是按什么编码把字节解成文本的（2026-10-18）。
   *
   * 为什么必须带出来：回执要能说出"这份输出不是 UTF-8，是按 GB18030 解的、有 N 处无法映射"。
   * **宁可说出来，不许装作没事**——历史那 14,759 条 pwsh 乱码回执全部是"解错了却什么都不说"。
   * 缺省 undefined = 这一趟还没解过（空输出等），此时不提。
   */
  decode?: { encoding: string; replaced: number; lossy: boolean } | undefined;
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
    elapsedMs: null,
    ...patch,
  };
}

/**
 * 两路缓冲的解码读数，取"**更有损**"的那一份。
 *
 * 只看 stdout 会把 stderr 上的乱码藏起来（PowerShell 的报错就在 stderr 上）。
 * 两边都是合法 UTF-8 时返回 `{ encoding: 'utf8' }` —— `composeContent` 见到它就一个字都不说。
 */
function decodeOf(...buffers: readonly BoundedText[]): ExecOutcome['decode'] {
  const readings = buffers.map((buffer) => buffer.decode).filter((value): value is DecodedText => value !== null);
  if (readings.length === 0) return undefined;
  const worst = readings.find((value) => value.lossy)
    ?? readings.find((value) => value.encoding !== 'utf8')
    ?? readings[0];
  if (worst === undefined) return undefined;
  return { encoding: worst.encoding, replaced: worst.replaced, lossy: worst.lossy };
}

/** 把捕获结果整理成给模型看的文本：输出 + stderr + 状态行（退出码 · 耗时）+ 截断说明 */
export function composeContent(outcome: ExecOutcome): string {
  const blocks: string[] = [];
  // ANSI 剥除（2026-10-16）：**所有 pwsh 回执出站前都走这一处**——它是三档（pwsh / python /
  // node）唯一的共同出口，也是回执进上下文（或写进 jobs 输出文件）之前的最后一站。
  //
  // 为什么提到这里：原来只有 CLIXML 那条路（`decodeClixmlErrors`）剥 ANSI，于是**同一台机器上
  // 同一个命令，报错走 CLIXML 就干净、走 stdout 就带着 `ESC[31;1m` 一类的装饰**进她的上下文。
  // 那些字节她读不了、只占位置（这正是"减少输入"要治的东西之一）。
  //
  // 复用 `ANSI_RE`、**不新写正则**：它是这个仓库里"ANSI 颜色序列"的唯一定义，两处各写一份
  // 迟早漂成"CLIXML 那条剥得掉、这条剥不掉"。
  //
  // 位置在 `stripClixml` / `decodeClixmlErrors` **之外**：那两处各按 CLIXML 的锚点先解包，
  // 解出来的文本再统一过这一道（`decodeClixmlErrors` 内部那次剥除保留——它自己也要保证
  // 输出干净，重复剥一次无副作用）。
  const stdout = normalizeNewlines(stripClixml(outcome.stdout).replace(ANSI_RE, ''));
  // stderr 走**解码**（不是丢弃）：PowerShell 的错误在管道上会被 CLIXML 包一层，
  // 而另两档的报错是纯文本——三档要同一套读数，见 decodeClixmlErrors 的注释
  const stderr = normalizeNewlines(decodeClixmlErrors(outcome.stderr).replace(ANSI_RE, ''));

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
  // 编码那段实话（2026-10-18）：子进程输出不是 UTF-8 时**必须说**，否则她看到的是一串
  // 看着像字、其实是另一种解读的字符。正常路径（合法 UTF-8）这一段完全不出现。
  //
  // 2026-10-20（R5）：措辞压短，40 token → 约 17。砍掉的是复述（"子进程输出不是 UTF-8"与
  // "已按 X 解码"说的是同一件事的两面；"字节没丢，只是这份字节本身不是 UTF-8"又把第二句
  // 说了一遍）。留下两格**判据**：① 这些非 ASCII 字符是同一份字节的另一种解读（所以她不该
  // 把它们当"输出坏了"直接重跑）；② 有损时怎么才能拿到保真内容（写进文件 + safe_read，
  // 或让命令自己按 UTF-8 输出）。`[编码]` 这个抬头与 `gb18030` 那个编码名**一个字都没动**
  // （`test/encoding-boundaries.test.ts` 按这两个记号判"该说的时候说了"）。
  const decoding = outcome.decode;
  if (decoding !== undefined && decoding.encoding !== 'utf8') {
    const loss = decoding.lossy ? `，其中 ${decoding.replaced} 处无法映射` : '';
    const advice = decoding.lossy
      ? '要保真请把输出写进文件后用 safe_read，或让命令自己按 UTF-8 输出。'
      : '字节没丢。';
    blocks.push(
      `[编码] 已按 ${decoding.encoding} 解码${loss}：非 ASCII 字符是同一份字节的另一种解读，${advice}`,
    );
  }
  // 状态行：**三档（pwsh / python / node）逐字同一套**（IRMIA 2026-10-12 的第 1 条：
  // "不想记三套"）。耗时与退出码贴在**同一行**：它们是同一件事的两半（"跑完了、多久、成没成"），
  // 拆成两行会让每条回执多占一行上下文，而 `[exit code: N]` 这个前缀有既有用例钉着，不能改形状。
  const status: string[] = [];
  if (outcome.exitCode !== null) status.push(`exit code: ${outcome.exitCode}`);
  if (typeof outcome.elapsedMs === 'number' && Number.isFinite(outcome.elapsedMs)) {
    status.push(`${outcome.elapsedMs}ms`);
  }
  if (status.length > 0) blocks.push(`[${status.join(' · ')}]`);
  return blocks.join('\n');
}

// ──────────────────────────────── 持久会话 ────────────────────────────────

interface SessionRound {
  /** 完成回调：事件驱动路径与超时/中断路径都走它，清理逻辑只有一处 */
  resolve: (outcome: ExecOutcome) => void;
  endRegex: RegExp;
  stdout: BoundedText;
  stderr: BoundedText;
  /**
   * 这一轮开始计时的那一刻（IRMIA 2026-10-12 第 1 条：三档同一套读数）。
   *
   * 计时起点刻意放在**写完那一行 base64 之后**：持久会话的启动/重建代价不属于"这条命令
   * 跑了多久"，把它算进去会让第一条命令看起来比实际慢一个数量级，而她要读的正是
   * "这条命令本身慢不慢"。
   */
  startedAt: number;
  /** 收尾窗口长度（毫秒）；0 = 认出标记就立刻兑现（测试用，见 SESSION_STDERR_SETTLE_MS） */
  windowMs: number;
  /** 已经兑现过了（收尾窗口结束时再判一次，避免超时/中断那两条路已经被处理过） */
  settled: boolean;
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
  /** 收尾窗口是否已经在等（见 `#trySettle` 与 SESSION_STDERR_SETTLE_MS） */
  #settling = false;

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
    const script = toEncodedCommand(buildSessionBootstrap(this.marker));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.#probe.exe,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script],
        { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
    } catch {
      // 起步失败（可执行文件或 cwd 不可用）：保持 dead 状态，由 run 返回 sessionLost
      this.#dead = true;
      this.#child = null;
      return restarted;
    }
    this.#child = child;
    this.#dead = false;

    // 收**原始字节**（不下 `setEncoding('utf8')`）：解码推迟到读的那一刻，见 `decodeConsole`
    // ——子进程按控制台代码页（中文 Windows 上常是 GBK）写回来的字节，只有拿得到字节才救得回来。
    child.stdout.on('data', (data: Buffer) => this.#onData(generation, 'stdout', data));
    child.stderr.on('data', (data: Buffer) => this.#onData(generation, 'stderr', data));
    // stdin 的 EPIPE 是"会话刚死、写还在路上"的正常竞态，不能让它变成未捕获异常
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.on('error', () => this.#onExit(generation, null));
    child.on('close', (code: number | null) => this.#onExit(generation, code));
    return restarted;
  }

  #onData(generation: number, channel: 'stdout' | 'stderr', data: Buffer): void {
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
      decode: decodeOf(round.stdout, round.stderr),
    }));
  }

  #trySettle(): void {
    const round = this.#round;
    if (round === null) return;
    // 结束标记只在 stdout 上找（它是 bootstrap 自己写出来的一行）。
    const stdoutMatch = round.endRegex.exec(round.stdout.window());
    if (stdoutMatch === null) return;
    // 已经认出标记了，但**先别兑现**：见下面 `SESSION_STDERR_SETTLE_MS` 那段。
    if (this.#settling) return;
    this.#settling = true;

    const settle = (): void => {
      this.#settling = false;
      // 这一轮可能已经结束（超时/中断/会话死亡都走 finish）
      if (this.#round !== round || round.settled) return;
      // **在兑现前重新读一次两路缓冲**：标记那一行写出来之后，stderr 的最后一段可能还在
      // 管道里（见 SESSION_STDERR_SETTLE_MS 的注释）。`round` 对象是同一个，所以这里
      // 拿到的是"窗口期结束时"的完整内容，而不是"认出标记那一刻"的快照。
      //
      // 错误块（bootstrap 用标记搬过来的那一份）在这里切出来搬进 `stderr`：
      // 于是 `composeContent` 对三档**逐字同一套**（stdout / [stderr] / 状态行），
      // 而 PowerShell 那一档的报错也不会因为 stderr 管道的延迟而丢掉。
      const split = extractSessionErrors(cutBeforeMarker(round.stdout, stdoutMatch));
      const nativeStderr = round.stderr.text();
      const stderr = split.stderr === '' ? nativeStderr : (nativeStderr === '' ? split.stderr : `${nativeStderr}${split.stderr}`);
      round.resolve(emptyOutcome({
        stdout: split.stdout,
        stderr,
        exitCode: Number(stdoutMatch[1]),
        droppedChars: round.stdout.droppedChars + round.stderr.droppedChars,
        decode: decodeOf(round.stdout, round.stderr),
      }));
    };

    if (round.windowMs <= 0) {
      settle();
      return;
    }
    setTimeout(settle, round.windowMs).unref();
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
      startedAt: Date.now(),
      windowMs: SESSION_STDERR_SETTLE_MS,
      settled: false,
    };

    let timer: NodeJS.Timeout | null = null;
    let onAbort: (() => void) | null = null;
    /** 唯一完成点：清定时器、摘监听、摘轮次，然后兑现 Promise */
    const finish = (value: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      round.settled = true;
      this.#settling = false;
      if (timer !== null) clearTimeout(timer);
      if (onAbort !== null) request.signal.removeEventListener('abort', onAbort);
      this.#round = null;
      // 耗时在这里补齐（三档同一套读数）：各条 finish 路径不必各自记一遍时刻
      resolveOutcome({ ...value, elapsedMs: value.elapsedMs ?? Date.now() - round.startedAt });
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
        decode: decodeOf(round.stdout, round.stderr),
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
        decode: decodeOf(round.stdout, round.stderr),
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

/** 一个已在跑的独立子进程（单次执行与临时脚本共用同一套输出/超时/杀树管理） */
interface SpawnedChild {
  child: SingleShotChild;
  /** spawn 时的异常（解释器不存在等）；非 null 时 `child` 是废的，调用方只该用这个字符串 */
  failure: string | null;
}

/**
 * 子进程的环境：**强制 UTF-8 输出**（`PYTHONIOENCODING` / `PYTHONUTF8`），
 * 外加 **只给 `lang:'python'` 那一档**的 `PIP_CONFIG_FILE`。
 *
 * 为什么必须有 UTF-8 那两句（v52 实测踩到）：Windows 上 python 的 stdout 默认走**控制台代码页**
 * （这台机器是 GBK/936），于是 `print("中文")` 出来的字节以 utf-8 解码后是乱码
 * （实测回执里就是 `�������`）。PowerShell 那条路早就用 `[Console]::OutputEncoding=UTF8`
 * 抹平了同一件事（文件头第 3 条），python 这一档缺的就是那一句的等价物。
 * node 的 `console.log` 本来就写 utf-8，这两个环境变量对它无害。
 *
 * `pipConfigFile` 是用户 2026-10-16 点名的加分项（「让她的 pip 配置**自包含**」）：
 * 托管 Python 的引导步骤会在 `<数据Dir>/tools/python/pip.ini` 写一份配置（镜像 / 超时 /
 * 代理的落点都在这一个文件里），**靠这个变量指过去才生效**——不设时 pip 读的是
 * 用户级 `%APPDATA%\pip\pip.ini`，那是**用户的**配置，框架不去改它、也不该假装自己改了。
 *
 * **只给 python 档**（`lang: 'pwsh' | 'node'` 时一个字节都不加）：`PIP_CONFIG_FILE` 对
 * PowerShell 与 node 毫无意义，给它们也设上就是**污染别人的环境**——而环境是会被子进程
 * 里的任何东西读到的（`$env:PIP_CONFIG_FILE` / `process.env.PIP_CONFIG_FILE`）。
 * 这一条有专门用例钉着（见 test/admin-pwsh.test.ts 的 pip 环境那一组）。
 *
 * 2026-10-18：那两句 UTF-8 相关变量的**构造**收口到 `util/bytes-text.ts` 的
 * `utf8ConsoleEnv`（别的 spawn 也引同一份），这里只负责"只给 python 档补 pip 配置"。
 */
export function scriptEnv(lang: PwshLang, pipConfigFile: string | null = null): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = utf8ConsoleEnv();
  if (lang === 'python' && pipConfigFile !== null) base['PIP_CONFIG_FILE'] = pipConfigFile;
  return base;
}

/** 起一个独立子进程；**永不抛出**（spawn 的同步异常折成 `failure` 文本） */
function spawnChild(
  exe: string,
  args: readonly string[],
  workdir: string,
  env: NodeJS.ProcessEnv = scriptEnv('pwsh'),
): SpawnedChild {
  try {
    return {
      child: spawn(exe, [...args], {
        cwd: workdir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      }),
      failure: null,
    };
  } catch (err) {
    return {
      child: null as unknown as SingleShotChild,
      failure: `无法启动 ${exe}：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 一个独立子进程的**完整生命周期**：收输出（有界）→ 超时/中断杀树 → 兑现一个 `ExecOutcome`。
 *
 * 抽出来是因为 v52 有三条路要它（pwsh 单次、python、node），而这三条路的**超时与输出管理
 * 必须逐字相同**——用户点名的那条判据是"沿用现有基建"：`PWSH_TIMEOUT_MS 60s` +
 * `kill-tree.ts` 的 `taskkill /T /F` + 头 8k 尾 2k + 2 MiB 捕获上限。
 * 三份复制实现迟早会漂成"某一条路上超时杀不掉"或"某一条路截断口径不同"。
 */
function superviseChild(spawned: SpawnedChild, options: {
  exe: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ExecOutcome> {
  if (spawned.failure !== null) {
    return Promise.resolve(emptyOutcome({ stderr: spawned.failure, spawnFailed: true, elapsedMs: 0 }));
  }
  const child = spawned.child;
  // 计时起点在 spawn 之后、注册监听之前（这段差值在微秒级，且它属于"这一趟"）
  const startedAt = Date.now();
  return new Promise<ExecOutcome>((resolve) => {
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
        elapsedMs: Date.now() - startedAt,
        decode: decodeOf(stdout, stderr),
        ...patch,
      }));
    };

    // 同持久会话那条路：收原始字节，读数时再解码（`decodeConsole`）
    child.stdout.on('data', (data: Buffer) => stdout.push(data));
    child.stderr.on('data', (data: Buffer) => stderr.push(data));
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    // 'error' 事件（ENOENT 等）与 spawn 的同步异常是两条路，都要落到 spawnFailed
    child.on('error', (err: Error) => finish({ stderr: err.message, spawnFailed: true }));
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

/** 单次执行：独立进程，隔离干净，不共享任何会话状态 */
function runSingleShot(options: SingleShotOptions): Promise<ExecOutcome> {
  const script = toEncodedCommand(buildSingleShotScript(options.command));
  const spawned = spawnChild(
    options.probe.exe,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script],
    options.workdir,
  );
  return superviseChild(spawned, {
    exe: options.probe.exe,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

// ──────────────────────────────── 临时脚本执行（v52） ────────────────────────────────

/** 一次"写临时文件 → 按语言跑 → 删文件"的全部输入 */
export interface ScriptRunRequest {
  lang: PwshLang;
  /** 脚本正文（整段，多行、引号、中文都不需要转义） */
  script: string;
  workdir: string;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * 非 pwsh 那两档的**托管解释器结论**（宿主注入；见 `LangDepProbe`）。
   * 不给 = 直接走名字链（PATH），与 v52 的行为逐字相同。
   */
  langProbe?: LangDepProbe | undefined;
  /**
   * PowerShell 档要探测出来的 shell；**另两档不用它**（各探各的解释器），可以不传。
   *
   * 为什么是可选而不是必填：python / node 那两档一个 PowerShell 字节都不用——
   * 强制调用方先探一次 PowerShell 会在这台没装 PS7 的机器上白白拒掉两档能力
   * （见 handler 里那段"lazy 探测"的注释）。
   */
  probe?: PowerShellProbe | undefined;
  /**
   * 托管 Python 那份自包含 pip 配置（`<数据Dir>/tools/python/pip.ini`）。
   * **只在 `lang: 'python'` 时**作为 `PIP_CONFIG_FILE` 传进子进程；另两档一个字节都不加。
   * `null` = 没有（没装托管 Python / 文件不存在）⇒ 不设这个变量。
   */
  pipConfigFile?: string | null | undefined;
  onWarning: (message: string) => void;
}

/** 一次脚本执行的结果：`ExecOutcome` + "这次到底用了哪个解释器、文件在哪" */
export interface ScriptRunOutcome extends ExecOutcome {
  /** 实际用的解释器（`C:\...\python.exe` 或 `python`），探测失败时为 null */
  interpreter: string | null;
  /** 解释器的版本行（探测得到时），回执里贴给她看 */
  interpreterVersion: string | null;
  /**
   * 用的是不是**框架托管那一份**（`<数据Dir>/tools/<名字>/` 下那个）。
   * `null` = 这一档没走解释器解析（`pwsh` 档用的是 shell 探测结论）。
   * 回执那一行 `[lang]` 靠它说清"PATH 上那个还是托管那个"。
   */
  interpreterManaged: boolean | null;
  /** 脚本落盘路径（跑完已删除；回执里给出来是为了让她能定位"是哪一段脚本"） */
  scriptPath: string | null;
}

/**
 * 写临时脚本 → 按 `lang` 跑它 → **无论如何删掉它**。
 *
 * 为什么这一档统一走文件（连 `pwsh` 也走）：用户点名的判据是"她不用先把脚本写成文件，
 * 直接把整段代码交给它就能跑"，而**同一个功能在三档之间不该有三种形状**——
 * `pwsh` 档若内联、另两档走文件，回执要分两种写法、临时文件那条清理纪律也只盖一半。
 * 代价是一条 PowerShell 多一次约 1ms 的落盘，换来的是"三档同源"。
 *
 * 删除放在 `finally`：异常路径（超时、中断、解释器起不来、脚本语法错）**一样要删**。
 */
export async function runScriptFile(request: ScriptRunRequest): Promise<ScriptRunOutcome> {
  const base: ScriptRunOutcome = {
    ...emptyOutcome(),
    interpreter: null,
    interpreterVersion: null,
    interpreterManaged: null,
    scriptPath: null,
  };

  const dir = tmpScriptDirOf(request.workdir);
  const scriptPath = tmpScriptPathOf(request.workdir, request.lang);

  // 解释器：pwsh 用本工具探测出来的 shell（必填），另两档按"**PATH 优先、托管兜底**"解析
  let exe: string;
  let version: string | null;
  /** 用的是不是框架托管那一份（回执里要说清，见 `ScriptRunOutcome.interpreterManaged`） */
  let interpreterManaged: boolean | null = null;
  /** python 档这一次要带的 `PIP_CONFIG_FILE`（null = 不带） */
  let managedPipConfig: string | null = null;
  if (request.lang === 'pwsh') {
    const shell = request.probe;
    if (shell === undefined) {
      return { ...base, stderr: '内部错误：pwsh 档缺少 shell 探测结论。', spawnFailed: true };
    }
    exe = shell.exe;
    version = shell.version;
  } else {
    const resolved = await resolveInterpreter(request.lang, request.langProbe);
    if (resolved === null) {
      return {
        ...base,
        // 找不到时的回执（用户 2026-10-16 点名要的三件事都在这一句里）：
        //   ① **试过什么**（`python3 / python`）——不然她只能瞎试；
        //   ② **框架能替你装**（设置页「外部依赖」一键装，装完要复检）——这不是环境定局；
        //   ③ **装好之后能干什么**（`lang:'python'` 里跑 `-m pip install` 自己扩能力）——
        //      那正是用户要 pip 的理由，回执里不说清就等于没人知道这条路存在。
        stderr: `找不到可用的 ${LANG_SPECS[request.lang].label} 解释器（试过：`
          + `${LANG_INTERPRETERS[request.lang].join(' / ')}）。`
          + '这一段脚本没有执行。两条出路：① 改用 lang 的其它取值；'
          + `② 去 GUI 设置页「外部依赖」把它**一键装上**（框架会装到数据目录下并当场复检，不必重启）`
          + (request.lang === 'python'
            ? '——装好之后你就能在 `lang:\'python\'` 里跑 `-m pip install <包>` 给自己扩能力。'
            : '。'),
        spawnFailed: true,
      };
    }
    exe = resolved.exe;
    version = resolved.version;
    interpreterManaged = resolved.managed;
    // 托管结论带回来的 pip 配置**只在真的用托管那一份时**才有值（它是那个解释器旁边那份
    // `pip.ini`）；宿主静态给的（`pythonPipConfigFile`）作为兜底——它只在文件真的存在时才有值。
    managedPipConfig = resolved.pipConfigFile;
  }

  try {
    await mkdir(dir, { recursive: true });
    // PowerShell 的 `.ps1` **必须带 UTF-8 BOM**：不带 BOM 时 PowerShell 按**系统代码页**
    // 解码文件（这台机器是 GBK），于是脚本里的中文在解析期就已经是乱码
    // （v52 实测：`Write-Output "临时脚本档"` 回执里变成 `��ʱ�ű���`）。
    // 这与"命令行里走 base64"是同一件事的两条通道——那条通道从不经过文件编码，
    // 这一条必须显式声明 BOM。python/node 两档不需要（它们的无 BOM 默认就是 UTF-8）。
    //
    // 前后各一句 PowerShell 的话，两句都是 base64 通道里 `SCRIPT_HEADER` /
    // `buildSingleShotScript` 已经有的东西，文件通道必须同样有（否则同一条命令走两条路
    // 会得到不同的编码与不同的退出码）：
    //   · 前置 `[Console]::OutputEncoding=UTF8`：文件头第 3 条，解决 5.1 的中文乱码；
    //   · 后置 `exit $LASTEXITCODE`：`-File` 结束时 pwsh 不会把外部命令的退出码带出来
    //     （实测：`cmd /c "exit 9"` 得到 `[exit code: 0]`），显式 exit 才能传出来。
    const preamble = request.lang === 'pwsh' ? `${SCRIPT_HEADER}\n` : '';
    const epilogue = request.lang === 'pwsh'
      ? '\nif($null -ne $LASTEXITCODE){exit $LASTEXITCODE}\n'
      : '';
    const bom = request.lang === 'pwsh' ? '\uFEFF' : '';
    await writeFile(scriptPath, `${bom}${preamble}${request.script}${epilogue}`, 'utf8');
  } catch (err) {
    return {
      ...base,
      stderr: `临时脚本写不出去（${scriptPath}）：${err instanceof Error ? err.message : String(err)}`,
      spawnFailed: true,
    };
  }

  try {
    const args: string[] = request.lang === 'pwsh'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
      : [scriptPath];
    // 环境按 `lang` 分档：python 档带着自包含的 `PIP_CONFIG_FILE`（**只这一档**），
    // 另两档用不带的。两个来源的优先级：**托管结论带回来的** > 宿主静态给的兜底。
    const pipConfigFile = managedPipConfig ?? request.pipConfigFile ?? null;
    const spawned = spawnChild(exe, args, request.workdir, scriptEnv(request.lang, pipConfigFile));
    const outcome = await superviseChild(spawned, {
      exe,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    return { ...outcome, interpreter: exe, interpreterVersion: version, interpreterManaged, scriptPath };
  } finally {
    await removeTmpScript(scriptPath, request.onWarning);
    await removeTmpDirIfEmpty(dir);
  }
}

/** 探测得到的解释器（进程内按名字缓存；同名共享同一次探测） */
const interpreterCache = new Map<string, Promise<{ exe: string; version: string } | null>>();

function probeInterpreterCached(name: string): Promise<{ exe: string; version: string } | null> {
  let pending = interpreterCache.get(name);
  if (pending === undefined) {
    pending = probeInterpreter(name).then((version) => (version === null ? null : { exe: name, version }));
    interpreterCache.set(name, pending);
  }
  return pending;
}

/** 清空解释器探测缓存（测试用：与 `resetPowerShellProbeCache` 同一条纪律） */
export function resetInterpreterProbeCache(): void {
  interpreterCache.clear();
}

/**
 * 找一个可用解释器：**PATH 优先、托管兜底**（找不到返回 null，由调用方如实报错，不降级）。
 *
 * 顺序就是用户 2026-10-17 的口径（「**Python 和 pip 不应该是默认要求装的，而是有就用
 * PATH 里的。没有的话就要求装。**」）：
 *   ① 机器上本来那一份（名字链 `python3` / `python`，走 PATH）；
 *   ② 一个都没有时才用框架自装目录里那一份（`managedSlot`，一键安装的落点）。
 *
 * 为什么必须先试 PATH 再问托管槽：托管那一份是**框架自己装的**，只在"这台机器什么都没有"
 * 时才是这个人的选择。反过来先试它，就变成"装过一次框架的 python 之后，她原来那个
 * 3.11.5 永远轮不到"——而那正是用户要翻掉的那件事。
 *
 * 两处都试过还是 null ⇒ 调用方如实报"这台机器上没有 python"（绝不偷偷换 PowerShell 去跑）。
 */
async function resolveInterpreter(
  lang: Exclude<PwshLang, 'pwsh'>,
  managed?: LangDepProbe | undefined,
): Promise<ResolvedInterpreter | null> {
  // 宿主那份结论只回答 python（node 不在外部依赖清单里），`lang !== 'python'` 时根本不问。
  // 拿它**只拿两槽候选**，顺序由下面两段定——宿主给"答案"的话，"PATH 优先"就落不了地。
  let slots: LangDepProbeOutcome = { pathSlot: null, managedSlot: null, pipConfigFile: null };
  if (managed !== undefined && lang === 'python') {
    try {
      slots = await managed();
    } catch {
      // 宿主那份结论抛错不该让整档能力不可用：如实退回名字链（下面那段）
    }
  }

  // ① **PATH 优先**：机器上本来就装好的那些（官方安装器 / 商店版 / 系统包的 node）。
  //    第一发用宿主给的那一槽（它可能就是 `deps.paths.python` 指的那个位置），
  //    然后是本工具自己的名字链——`probeInterpreterCached` 只认**真的能跑起来**的，
  //    所以"PATH 上有名字但起不来"会继续往下试，而不是当场判无解。
  const pathNames = slots.pathSlot === null
    ? [...LANG_INTERPRETERS[lang]]
    : [slots.pathSlot, ...LANG_INTERPRETERS[lang]];
  for (const name of pathNames) {
    const found = await probeInterpreterCached(name);
    if (found !== null) return { ...found, pipConfigFile: null, managed: false };
  }

  // ② **托管兜底**：框架装的那一份（`<数据Dir>/tools/python/` 下、复检过的）。
  //    走到这里意味着 PATH 上一个都没起来 —— 它旁边那份 `pip.ini` 这时才该生效。
  if (slots.managedSlot !== null) {
    const found = await probeInterpreterCached(slots.managedSlot);
    if (found !== null) return { ...found, pipConfigFile: slots.pipConfigFile, managed: true };
  }
  return null;
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
  /** v52：这段脚本是什么语言。`pwsh` = 既有那条路（持久会话），另两档走临时文件 */
  lang: PwshLang;
  /** 她是不是**显式**要了持久会话（`lang` 非 pwsh 时的那句拒绝看它，不看缺省值） */
  explicitPersistent: boolean;
}

/**
 * `lang` 取值校验。写在本地而不是加进 `types.ts`：`lang` 目前只有这一件工具在用，
 * 而"取值表只有一处"这条纪律靠的是 `PWSH_LANGS` 本身（`optionalString` + 这张表校验）。
 * 报错文案要把**三个取值都摆出来**——与 timer 的 `action` 同一条口径：给不全她只能瞎试。
 */
function optionalLang(args: Record<string, unknown>): PwshLang {
  const raw = optionalString(args, 'lang', { maxLength: 32 });
  if (raw === undefined) return PWSH_DEFAULT_LANG;
  if ((PWSH_LANGS as readonly string[]).includes(raw)) return raw as PwshLang;
  throw new ToolArgumentError(
    'lang',
    `lang 只能是 ${PWSH_LANGS.join(' / ')} 之一，收到 ${JSON.stringify(raw)}`,
  );
}

export function createPwshTool(options: PwshToolOptions = {}): PwshToolDefinition {
  const destructiveEnabled = options.destructiveEnabled === true;
  const warn = options.onWarning ?? ((): void => undefined);
  const defaultTimeoutMs = options.defaultTimeoutMs ?? PWSH_TIMEOUT_MS;
  const maxBackgroundMs = options.maxBackgroundMs ?? DEFAULT_BACKGROUND_MAX_MS;

  /** 探测结果缓存：进程生命周期内只探一次 */
  let probePromise: Promise<PowerShellProbe> | null = null;
  /** 探测回退的 warning 只随第一次执行回给模型，避免每轮都刷同一句话 */
  let warningDelivered = false;

  let session: PersistentSession | null = null;
  let backgroundSeq = 0;
  /** 托管 Python 那份 `pip.ini` 解析了没有（一次解析、之后记住结论） */
  let pipConfigResolved = false;
  let pipConfigFile: string | null = null;

  /**
   * 托管 Python 的自包含 pip 配置（`<数据Dir>/tools/python/pip.ini`）。
   *
   * **只对 `lang:'python'` 那一档生效**，而且**文件真的在盘上**才算——那时才把它作为
   * `PIP_CONFIG_FILE` 传进那段 python 子进程（见 `scriptEnv`）。三条理由：
   *   · 不设时 pip 读的是**用户级** `%APPDATA%\pip\pip.ini`：那是用户的配置，
   *     框架不去改它，但也不该让"她的 pip 配置是自包含的"这句话落空；
   *   · 文件不存在时不设（给 pip 指一个不存在的配置文件没有任何好处）；
   *   · **一次 stat 的代价，结论记住**：文件是引导步骤写的，装完就不会自己消失。
   */
  const pythonPipConfig = (): string | null => {
    if (pipConfigResolved) return pipConfigFile;
    pipConfigResolved = true;
    const candidate = options.pythonPipConfigFile;
    if (candidate === undefined || candidate === null || candidate === '') return (pipConfigFile = null);
    try {
      pipConfigFile = statSync(candidate).isFile() ? candidate : null;
    } catch {
      pipConfigFile = null;
    }
    return pipConfigFile;
  };

  const probe = (): Promise<PowerShellProbe> => {
    probePromise ??= detectPowerShell(
      options.depsProbe === undefined ? {} : { deps: { probe: options.depsProbe } },
    ).then((result) => {
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
    const args = argsRecord(rawArgs, PWSH_TOOL_NAME);
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
    const lang = optionalLang(args);
    const persistent = optionalBoolean(args, 'persistent', lang === PWSH_DEFAULT_LANG);
    const background = optionalBoolean(args, 'runInBackground', false);
    // 「她是不是**显式**要了持久会话」在这里定一次（`lang` 非 pwsh 时那句拒绝的判据）。
    // 为什么不是 `persistent === true`：缺省值本身在 pwsh 档就是 true，拿它判会把
    // **没提这件事**的调用也拒掉——那是把默认值当成她的要求。
    const explicitPersistent = args['persistent'] !== undefined && args['persistent'] !== null;
    return {
      command,
      workdir,
      explicitWorkdir: requestedWorkdir !== undefined,
      timeoutMs,
      persistent,
      background,
      boundary,
      lang,
      explicitPersistent,
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
    for (const literal of absolutePathLiteralsIn(call.command)) {
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
        'pwsh 是 destructive 工具，默认关闭，当前配置未显式开启，命令未执行。'
        + '请在配置里显式打开后重试（design §4.10 第三级门：有副作用的工具必须在配置里显式开启）。',
        TOOL_ERROR_CODES.destructiveDisabled,
      );
    }

    // 命令黑名单：命中即拒绝，并把原因与替代路径回给模型。
    // v52：判据按语言分组（`screenCommand` 的第二参）——PowerShell 那 13 条语法规则
    // 拿去套 python/node 正文既会漏（`shutil.rmtree` 一句都命不中）又会误伤
    // （正文里那句 `"Remove-Item -Recurse -Force"` 只是字符串）。见 FORBIDDEN_PATTERNS。
    const forbidden = screenCommand(call.command, call.lang);
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

    // `lang` 非 pwsh 时 `persistent` 没有意义：python / node 没有"驻留解释器 + 跨调用变量"
    // 这回事（每一档都是一段独立脚本）。**缺省值本身已经按语言分开**（pwsh 档 true、另两档 false），
    // 所以这里拒的只有一种情形：她**显式**要了持久会话。**静默忽略是最坏的一种**——
    // 她会以为上一次 `lang:python` 里定义的变量还在。
    if (call.lang !== PWSH_DEFAULT_LANG && call.explicitPersistent && call.persistent) {
      return errorResult(
        `lang=${call.lang} 没有持久会话：这一档每次都是一段独立脚本（新进程，不继承上一次的变量与 cwd）。`
        + '要么去掉 persistent，要么把 lang 换回 pwsh（那一档默认复用同一个 shell 会话）。',
        TOOL_ERROR_CODES.invalidArgs,
      );
    }

    // 探测：`lang` 非 pwsh 时**不探 PowerShell**——python / node 那两档一个 PowerShell
    // 字节都不用（临时文件由 node 自己写，解释器也自己探）。这条 laziness 是有意的：
    // 假装"跑 python 也需要先有 PowerShell"会在这台没装 PS7 的机器上白白拒掉两档能力。
    let resolved: PowerShellProbe | undefined;
    if (call.lang === 'pwsh') {
      try {
        resolved = await probe();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(message, TOOL_ERROR_CODES.noRuntime);
      }
    }

    const extra: string[] = [];
    if (resolved !== undefined && resolved.warning !== null && !warningDelivered) {
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

      // 刻意不接 ctx.signal：后台任务的语义就是脱离本 turn 独立跑完。
      // v52 起后台档也走**临时脚本**（与前台三条同源）：脚本写盘 → 跑 → 删，
      // 于是一个后台 python/node 任务与一个前台 python/node 调用是**同一套输出管理、
      // 同一套超时杀树、同一套清理**。后台任务本来就不共享持久会话，改这一档不损失能力。
      void runScriptFile({
        lang: call.lang,
        script: call.command,
        workdir: call.workdir,
        timeoutMs: maxBackgroundMs,
        signal: new AbortController().signal,
        ...(resolved === undefined ? {} : { probe: resolved }),
        // 后台档也带上（它同样是 python 那一段脚本，解释器与 pip 配置该与前台一致）
        ...(options.langProbe === undefined ? {} : { langProbe: options.langProbe }),
        pipConfigFile: pythonPipConfig(),
        onWarning: warn,
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
    /** 临时脚本通道（lang ≠ pwsh）才会填：这次用的是哪个解释器、脚本落在哪 */
    let scriptRun: ScriptRunOutcome | null = null;
    // 走临时脚本档的两种情形：① `lang` 不是 pwsh；② `lang=pwsh` 但她明确不要持久会话
    // （`persistent:false`）。后者从前是"单次 spawn + -EncodedCommand"，v52 起也写临时文件
    // ——用户点名的判据之一是"**三档同源**"：同一个功能不该有三种形状，而临时文件那条
    // "跑完必删"的清理纪律只盖一半就等于没盖（见 runScriptFile 的注释）。
    if (resolved === undefined || !call.persistent) {
      // python / node：写临时文件再跑（引号、换行、中文都不用她转义），跑完必删。
      // 这两档**没有持久会话**——它们的语义是"一段独立脚本"，而 python/node 的
      // "跨调用保持状态"本来就不存在（没有 shell 那样的驻留解释器约定）。
      scriptRun = await runScriptFile({
        lang: call.lang,
        script: call.command,
        workdir: call.workdir,
        timeoutMs: call.timeoutMs,
        signal: ctx.signal,
        ...(resolved === undefined ? {} : { probe: resolved }),
        // 托管解释器结论（python 优先用它；node 档同样走它，只是 pip 配置用不上）
        ...(options.langProbe === undefined ? {} : { langProbe: options.langProbe }),
        // 宿主静态给的兜底 pip 配置（托管结论里带回来的那个优先，见 runScriptFile）
        pipConfigFile: pythonPipConfig(),
        onWarning: warn,
      });
      outcome = scriptRun;
    } else {
      session ??= new PersistentSession(resolved);
      // 会话不在（首次启动或已死）就重建：重建只影响"状态丢失"的告知，不影响命令语义
      let restarted = false;
      if (!session.alive) restarted = session.start(call.workdir);
      // 只有模型显式指定 workdir 时才注入 Set-Location：默认每轮硬切回 workspace 根，
      // 会抹掉会话自己用 Set-Location 建立的 cwd 状态，那就不是持久会话了
      const roundScript = call.explicitWorkdir
        ? buildSessionRoundScript(call.command, call.workdir)
        : call.command;
      outcome = await session.run({
        command: roundScript,
        timeoutMs: call.timeoutMs,
        signal: ctx.signal,
      });
      if (restarted) outcome = { ...outcome, sessionRestarted: true };
    }

    const content = composeContent(outcome);
    const notes: string[] = [];
    if (outcome.sessionRestarted) {
      notes.push(
        '[持久会话已在本次调用前重建：工作目录与变量状态丢失] '
        + '之前的 Set-Location 与变量/函数定义都不再有效，需要的话请重新设置。',
      );
    }
    if (outcome.sessionLost) {
      notes.push(
        '[持久会话在命令执行中终止] 常见原因是命令自身调用了 exit，或会话被外部终止。'
        + '上面是终止前拿到的输出；下一次调用会自动重建会话。',
      );
    }
    // 「这一次到底跑的是什么」贴在最末（见文件头第 1 条）：首行必须留给命令自己的输出。
    //
    // `[shell]` **每一档都贴**（v30 的硬要求："每次调用的回执都说明这次用的是哪个 shell"，
    // 有既有用例钉着）。非 pwsh 档另加一行 `[lang]`：那一档真正执行的是 python/node，
    // 只说 shell 会让她以为这段 python 是被 PowerShell 跑的。
    notes.push(await shellLine());
    if (scriptRun !== null) {
      // 「用的是哪一个 python」由这一行说清（用户 2026-10-16 要路径、2026-10-17 要"哪一份"）：
      // PATH 上那个与托管那个都可能是完整路径，光看路径要人去分辨——所以来源也写出来。
      // `null`（没走解释器解析，或没找到）时不加尾巴：那时路径本身就是全部信息。
      const origin = scriptRun.interpreterManaged === null
        ? ''
        : (scriptRun.interpreterManaged ? '（框架托管那份）' : '（系统 PATH 上那份）');
      // 2026-10-20（R5）：这一行原来的尾巴是
      // `；这一档每次都是新进程，不继承持久会话的 cwd 与变量）`，已删。
      // 它是**常量陈述**（这一档永远是新进程），而 `[lang]` 这一行本来就是"这一段不是 pwsh
      // 跑的"的标记；她照它做的判断是"这段脚本在哪个解释器里跑、临时文件在哪"——两个都还在。
      // 那半句**逐字已经在参数描述里**（`lang` 那一格："pwsh(默认) / python / node；后两档
      // 每次新进程、cwd 不跟 shell 会话"，每次请求都看得到），回执里再说一遍是纯重复。
      // 另有兜底：显式给 `persistent` 又选非 pwsh 档的情形会被当场拒掉（上面那一段
      // `explicitPersistent` 的 errorResult，"新进程，不继承上一次的变量与 cwd"逐字在那儿），
      // 所以"她以为有会话"这条误判有它管，不受这次删减影响。
      notes.push(
        `[lang] ${call.lang} · ${scriptRun.interpreter ?? '解释器未找到'}${origin}`
        + `${scriptRun.interpreterVersion === null ? '' : ` ${scriptRun.interpreterVersion}`}`
        + `（整段脚本写进临时文件执行，跑完已删除：${scriptRun.scriptPath ?? '(未落盘)'}）`,
      );
    }
    const body = `${content}\n${notes.join('\n')}`;

    if (outcome.spawnFailed === true) {
      // 进程没起来与"跑了但退出码非零"是两件事：这里如实说清是环境问题，不是她代码的问题
      return errorResult(
        `这一段脚本没有执行（进程没能启动）。\n${body}\n`
        + '这是环境问题，不是脚本内容的问题：换一个 lang，或请人在这台机器上把缺的那个运行时装上。',
        TOOL_ERROR_CODES.noRuntime,
        extra,
      );
    }
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
    name: PWSH_TOOL_NAME,
    description:
      '把整段脚本交给它跑（多行/引号/中文不用转义）：lang 选 pwsh（默认，保持会话 cwd 与变量）'
      + '/python/node（每次新进程）。工作目录默认是仓库根；超时 60s，输出头 8k 尾 2k。',
    parameters: {
      type: 'object',
      properties: {
        // 「危险命令会被拒并说明原因」这句**从工具描述挪到了这里**（v42）：`description` 那条
        // <60 token 的收紧线（test/tool-catalog.test.ts）当时只剩 7 token 余量，而"列目录用
        // Get-ChildItem"这半句要花 6——两件事放在同一格里必然顶线。挪进参数描述**不省常驻
        // 开销**（参数 schema 同样随每次请求发送），但它是这句话本来就最该在的地方（黑名单
        // 判的就是 command 这一格），也让描述那条线重新有了余量。
        //
        // v52 又挪了一次，同一笔账、同一个方向：新增 `lang` 与「列目录用 Get-ChildItem」
        // 都要留在描述里就会顶线。留哪一句的判据是**她常常要用的那句**：「整段脚本怎么交」
        // 每次调用都要用一次，"列目录用 Get-ChildItem"一个月用不上一次（`safe_read` 传目录
        // 已经能列，v42 并进去的）⇒ 描述里留前者，后者进 `command` 的参数描述。
        command: {
          type: 'string',
          description: '整段脚本正文（可多行）；危险命令会被拒并说明原因。列目录用 Get-ChildItem',
        },
        lang: {
          type: 'string',
          enum: [...PWSH_LANGS],
          // 三个取值写全（`enum` 里也有，但参数描述是她"决定填哪一格"时读到的那一行）。
          // "每次新进程"与"cwd 不跟 shell 会话"是**会用错**的那两格：python/node 没有
          // 持久会话，不说清她会以为上一次 `lang:python` 里定义的变量、或者 shell 里刚
          // `Set-Location` 过的目录，在下一档里还算数——两者都不算数，实测用例钉着。
          description: 'pwsh(默认) / python / node；后两档每次新进程、cwd 不跟 shell 会话',
        },
        workdir: { type: 'string', description: '工作目录；省略则用会话当前目录（首轮=仓库根）' },
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
