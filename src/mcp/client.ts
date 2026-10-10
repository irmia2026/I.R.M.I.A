/**
 * Irmia Agent — MCP stdio 客户端池（docs/design.md §4.19 MCP 段、docs/milestones.md M7-1/2/3/8）
 *
 * 第一版只支持本地子进程（远程 SSE/HTTP 明确不做：那是面向独立进程多客户端场景的方案，
 * 对"随用随起"的子进程是过度设计）。协议实现是**官方规范的最小子集**：
 *
 *   initialize 握手（protocolVersion + capabilities + clientInfo，回包逐项校验）
 *     → notifications/initialized
 *     → tools/list（进程启动时一次并缓存，notifications/tools/list_changed 触发刷新）
 *     → tools/call → notifications/cancelled
 *     → 每请求超时（progress 通知可重置时钟，但有硬上限）
 *
 * roots / sampling / elicitation **一律不声明**：不声明则 server 不会发对应请求。
 * server 若仍然发来未声明能力的请求，一律回 -32601 method not found（规范要求的兜底）。
 *
 * 四条纪律（全部来自规范原文与设计文档）：
 *
 * 1. **默认不信任**：MCP 工具默认 `sideEffect: 'destructive'`，配置里显式降级才改。
 *    **annotations（readOnlyHint 等）一律不可信**——三属性以我方注册表为准，
 *    annotations 只作参考提示收着看。理由很直白："server 说自己是只读的"，
 *    恰好是崩溃恢复时最不该采信的一句话；而 sideEffect 决定的是"崩溃后能不能自动重试"，
 *    猜错一次就是副作用重复执行。
 *
 * 2. **随用随起、空闲回收**：首次调用拉起子进程，空闲 5 分钟回收。回收按官方关机序列
 *    执行：关 stdin → 等待退出 → 超时 SIGTERM → 再超时 SIGKILL（两级超时可配）。
 *    协议错误重启走的也是同一条序列——关停路径只有一条，才不会有第二条没人测过的路径。
 *
 * 3. **stdout 纯净**：server 的 stdout 只允许写合法 JSON-RPC（日志必须走 stderr）。
 *    收到非 JSON-RPC 行 → 记协议错误并重启该 server 进程；stderr 一律捕获为日志。
 *    消息按换行分隔，绝不内嵌换行（JSON.stringify 天然把 \n 转义，另有断言兜底）。
 *
 * 4. **超时即杀、崩溃不传染**：所有失败都折算成工具结果（isError），绝不抛穿主循环。
 *    `isError: true` → status 'error'（由执行器的 completedResult 映射）；
 *    `content[]` 超阈值走 blob 外置（§4.12 磁盘经济学，复用 state/blob-store.ts）。
 *
 * 生命周期事件经注入的 emit 落 `mcp/server-started` / `mcp/server-stopped`（internal）。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`（Node 的类型剥离只擦类型、不改写路径解析）。
 * 零外部依赖：只用 node: 标准库。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { killProcessTree } from '../process/kill-tree.ts';
import type { SideEffect } from '../log/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition, ToolExecutionMode, ToolHandlerResult } from '../tools/types.js';
import { MAX_DESCRIPTION_TOKENS, estimateTokens } from '../tools/registry.ts';
import { errorResult, okResult } from '../tools/types.ts';
// 启动器白名单（唯一一套判据：config.ts / web 层的内联声明都从 parseMcpServers 走它）
import { checkStdioLauncher, unstartableLauncherReason } from './launcher-guard.ts';
// `servers[].desc` 的洗净（唯一实现；索引渲染那一侧读的是同一份口径，见 `mcp/description.ts`）
import { sanitizeMcpDescText } from './description.ts';
// 外置指针文案的**唯一实现**（与工具结果那条路共用；两处各拼一遍必然漂移）
import { blobPointerText } from '../model/render.ts';
import {
  DEFAULT_BLOB_PREVIEW_CHARS, DEFAULT_BLOB_THRESHOLD_TOKENS, offloadIfLarge,
} from '../state/blob-store.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 工具名命名空间前缀（design §4.18 原则 2：MCP 工具自带 mcp__{server}__ 前缀） */
export const MCP_NAME_PREFIX = 'mcp__';
/** 合成名上限：与 src/tools/registry.ts 的 NAME_MAX_LENGTH 对齐（超限的注册会被拒） */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;
/** 规范允许的服务器名与工具名字符集（其余字符合成出来的名字毫无可读性，宁可拒绝） */
export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

/** 缺省协议版本与可接受的回包版本（回包版本不在列表里即判定不兼容） */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** clientInfo（握手时上报；server 侧日志靠它辨认调用方）。version 与 main.ts 的 AGENT_VERSION 同步 */
export const DEFAULT_CLIENT_INFO: { readonly name: string; readonly version: string } = {
  name: 'irmia-agent',
  version: '0.1.0-beta.7',
};

/** 每请求软超时：progress 通知可重置这个时钟 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** 每请求硬上限：progress 再多也不能把请求续到天荒地老 */
export const DEFAULT_PROGRESS_HARD_CAP_MS = 600_000;
/**
 * 单件 MCP 工具交给执行器的 `timeoutMs`（执行器级超时先到，得到 status `'timeout'`）。
 *
 * **值 = 池自己的每请求软超时**（2026-10-09 对齐，评审缺陷 ⑦）。为什么是**这个数**：
 * 两个时钟管的是同一件事的两半——执行器那条门量的是"这次工具调用整体等多久"
 * （`mcp-entry.ts` 把 `timeoutMs` 交给执行器，`executor.ts` 到点就杀并把调用记成超时），
 * 池那条软超时量的是"这条 JSON-RPC 请求等多久"（progress 通知可续，硬上限 600s）。
 * 两者**必须同源**，否则短的那个说了算：
 *   · 执行器 60s < 池 120s 时，一个需要 70 秒的正常 MCP 操作（跑测试、装东西、查一个大仓库）
 *     **永远做不完**——每次都在 60 秒被砍、`notifications/cancelled` 发出去、500ms 宽限内
 *     server 不收敛就按关机序列**杀掉整个进程**，下次重头再来；
 *   · 而"60 秒"这个数字在文档里找不到出处（`render.ts` 那条注释说的是别的门，与超时无关）。
 * **为什么不反过来把池的软超时降到 60s**：池那条路本来就把 120s 当作"一次请求的正常上限"
 * （progress 还能把它续到 600s），把 60s 那道执行器级门调到与它齐平才是**放宽回正常语义**；
 * 降池那条会同时砍掉 `list` 那一屏的冷启动余量（起进程 + 握手 + 分页拉清单都在这条时钟里）。
 * 逐 server 要更短/更长仍然可配：`McpServerEntry.tools[].timeoutMs` / `toolDefaults.timeoutMs`
 * 优先于这个缺省（`resolveToolAttributes`）。
 */
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;
/** 空闲回收窗口（design §4.19 纪律 2：5 分钟） */
export const DEFAULT_IDLE_RECLAIM_MS = 5 * 60 * 1000;

// ── 崩溃退避（2026-10-10 加；形状抄 Kubernetes 的容器重启退避，见 docs/multi-mcp-orchestration.md §4）──

/**
 * 连续启动失败之后**第一次**等多久才允许再拉起同一个 server。
 *
 * 依据：K8s 的 kubelet 对退出容器做指数退避重启，序列 **10s → 20s → 40s → …**。
 * 为什么必须有：今天一个"起来就崩"的 server（配置错、token 过期、command 写错）
 * **每一次调用都要付一次启动 + 一次崩溃**，而且没有任何次数上限（`startCounts` 只增不判）。
 */
export const DEFAULT_BACKOFF_BASE_MS = 10_000;
/** 退避的封顶：再怎么连续失败，间隔也不会超过它（K8s 同值 300s） */
export const DEFAULT_BACKOFF_CAP_MS = 300_000;
/**
 * 退避重置窗口：上一次**成功启动**之后稳定运行满这么久，连续失败计数就归零。
 *
 * **刻意等于 `DEFAULT_IDLE_RECLAIM_MS`**（不是巧合，是取舍）：两个数都答"多久没动静算另一次
 * 生命周期"，多一个要记的常量只会让下一个人猜"为什么是 7 分钟"。K8s 那条是 10 分钟，我们按
 * 自己的回收窗口取 5 分钟（`docs/multi-mcp-orchestration.md` D1-b 的建议）。
 */
export const DEFAULT_BACKOFF_RESET_MS = DEFAULT_IDLE_RECLAIM_MS;

// ── 在飞上限（背压；2026-10-10 加）──

/**
 * 同一个 server 上同时在飞的请求上限（`mcp.servers[].maxInFlight` 可逐 server 覆盖）。
 *
 * `pending` 原本是一个**无上限**的 Map：并发 N 个调用会同时挂住，无队列、无背压。
 * 今天被 `mcp` 的 `exclusive`（`tools/mcp-entry.ts`）意外挡住了，但那是工具层的巧合，
 * 不是池层的保证——子代理并发的那天它就会露出来。
 *
 * 超限**如实拒绝**（不是排队，也不是抢占）：排队会引入一个新的死锁面
 * （唯一在跑的调用在等一个排队的启动），而"直接说清、让她稍后再试"是没有死锁面的那一档。
 */
export const DEFAULT_MAX_IN_FLIGHT_PER_SERVER = 4;
/**
 * 整池同时在飞的 MCP 请求上限（**不是**上限的乘积：它管的是"总共有多少件在跑"）。
 *
 * 为什么两个上限都要：per-server 那个保护"别把同一个 server 打爆"，池级那个保护
 * "别同时拉起 N 个别人的进程"（每个 ≈ 一整套 runtime 基线 + 启动耗时）。
 * 池级上限是**宿主接线面**（`McpClientPoolOptions.maxInFlight`）：`main.ts` 那一格现在不传，
 * 走这个默认值。
 */
export const DEFAULT_MAX_IN_FLIGHT = 8;

// ── 工具清单落盘缓存（2026-10-10 加）──

/**
 * 工具清单缓存的目录名（在 `dataDir` 下）与文件版本。
 *
 * 为什么落盘：`toolsCache` 只在内存里，进程一退就没；而"她只是看一眼有哪些工具"
 * 走的是 `listTools(requireConnected:true)` ⇒ **必须起进程**。空闲回收 5 分钟之后
 * **下一次看还要再付一次**（起进程 ≈ 0.07–0.8 s + 一整套 runtime 基线 ≈ 46 MB）。
 * 落盘之后命中就是读一个 json（毫秒级）。
 *
 * ⚠️ 缓存**必须能看出它旧**：回执里会带上"取回于 X、可能已过期"
 *（判据：`docs/multi-mcp-orchestration.md` L1 风险 1；实现见 `tools/mcp-entry.ts`）。
 */
export const MCP_TOOLS_CACHE_VERSION = 1;
export const MCP_TOOLS_CACHE_DIR = 'mcp-cache';
/** 关机序列的第一级等待：关 stdin 之后等它自己走 */
export const DEFAULT_SHUTDOWN_STDIN_WAIT_MS = 2_000;
/** 关机序列的第二级等待：SIGTERM 之后等它走 */
export const DEFAULT_SHUTDOWN_TERM_WAIT_MS = 5_000;
/** SIGKILL 之后仍留一点观察窗口（用于如实记录"没退出"这件事） */
export const DEFAULT_SHUTDOWN_KILL_GRACE_MS = 500;
/** 取消宽限：发出 notifications/cancelled 后等 server 收敛的时间，逾期判定连接失效 */
export const DEFAULT_CANCEL_GRACE_MS = 500;
/**
 * `tools/list` 分页的**页数上限**（2026-10-09 加，评审缺陷 ③）。
 *
 * 为什么必须有：`nextCursor` 是 server 给的字符串，一个坏实现（或一个真有几千件工具的 server）
 * 能让这条循环一直跑下去。20 页对"工具数超一页"的 server（官方 filesystem / github 那一类）
 * 是绰绰有余的余量；到顶不是静默截断——回执里会写"还有更多"（`McpToolsListSummary.truncated`）。
 */
export const MAX_TOOLS_LIST_PAGES = 20;
/** 单行字符上限：超长且不见换行即判定 stdout 不是"换行分隔的 JSON-RPC" */
export const MAX_STDOUT_LINE_CHARS = 1_048_576;

// ──────────────────────────────── 错误 ────────────────────────────────

/** 工具层错误码（与 tools/types.ts 的 TOOL_ERROR_CODES 同风格，供宿主判定） */
export const MCP_ERROR_CODES = {
  notConfigured: 'E_MCP_NOT_CONFIGURED',
  disabled: 'E_MCP_DISABLED',
  spawnFailed: 'E_MCP_SPAWN_FAILED',
  handshakeFailed: 'E_MCP_HANDSHAKE_FAILED',
  protocol: 'E_MCP_PROTOCOL',
  rpc: 'E_MCP_RPC_ERROR',
  timeout: 'E_MCP_TIMEOUT',
  aborted: 'E_MCP_ABORTED',
  stopped: 'E_MCP_SERVER_STOPPED',
  toolError: 'E_MCP_TOOL_ERROR',
  badContent: 'E_MCP_BAD_CONTENT',
  /** 在飞上限到了：这一次**没有发出去**（自保，不是 server 坏了） */
  overloaded: 'E_MCP_OVERLOADED',
} as const;

/** stdout 不是合法 JSON-RPC（或违背换行分隔纪律）：这条错误必然导致该 server 进程被重启 */
export class McpProtocolError extends Error {
  readonly server: string;
  readonly detail: string;

  constructor(server: string, detail: string) {
    super(`MCP server ${server} 协议错误：${detail}`);
    this.name = 'McpProtocolError';
    this.server = server;
    this.detail = detail;
  }
}

/** 每请求超时（软超时或硬上限到达）；两种情形都要发 notifications/cancelled */
export class McpRequestTimeoutError extends Error {
  readonly server: string;
  readonly method: string;
  readonly timeoutMs: number;
  /** true = 撞到 progress 硬上限（progress 已经救不回这个请求） */
  readonly hardCap: boolean;

  constructor(server: string, method: string, timeoutMs: number, hardCap: boolean) {
    super(
      hardCap
        ? `MCP server ${server} 的 ${method} 请求撞到硬上限（progress 通知已无法续期）：${timeoutMs}ms`
        : `MCP server ${server} 的 ${method} 请求超时：${timeoutMs}ms`,
    );
    this.name = 'McpRequestTimeoutError';
    this.server = server;
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.hardCap = hardCap;
  }
}

/** 调用被取消（执行器超时或宿主关停把 AbortSignal 打过来） */
export class McpAbortedError extends Error {
  readonly server: string;
  readonly method: string;

  constructor(server: string, method: string, detail: string) {
    super(`MCP server ${server} 的 ${method} 调用被取消：${detail}`);
    this.name = 'McpAbortedError';
    this.server = server;
    this.method = method;
  }
}

/** server 用 JSON-RPC error 回的失败（协议层错误，不是工具层 isError） */
export class McpRpcError extends Error {
  readonly server: string;
  readonly code: number;
  readonly data: unknown;

  constructor(server: string, method: string, code: number, message: string, data: unknown) {
    super(`MCP server ${server} 的 ${method} 返回 JSON-RPC 错误 ${code}：${message}`);
    this.name = 'McpRpcError';
    this.server = server;
    this.code = code;
    this.data = data;
  }
}

/** server 进程已退出（在途请求全部作废） */
export class McpServerExitedError extends Error {
  readonly server: string;
  readonly code: number | null;
  readonly signal: string | null;

  constructor(server: string, code: number | null, signal: string | null) {
    super(`MCP server ${server} 的进程已退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）`);
    this.name = 'McpServerExitedError';
    this.server = server;
    this.code = code;
    this.signal = signal;
  }
}

/** 连接被主动关停（回收/关停/重启），在途请求随之作废 */
export class McpServerStoppedError extends Error {
  readonly server: string;
  readonly reason: McpStopReason;

  constructor(server: string, reason: McpStopReason) {
    super(`MCP server ${server} 已停止（${reason}），在途请求作废`);
    this.name = 'McpServerStoppedError';
    this.server = server;
    this.reason = reason;
  }
}

/**
 * 在飞上限到了：这一次请求**没有发出去**。
 *
 * 它与"调用失败"是两件事，所以有独立的错误类型与错误码（`MCP_ERROR_CODES.overloaded`）：
 * server 没有坏、配置没有错、上一次调用也没有失败——只是**同时**要它干的事太多了。
 * 因此它**不计入崩溃退避**（那是"它坏了"的记账，这是"我们问得太急"）。
 */
export class McpOverloadedError extends Error {
  readonly server: string;
  readonly scope: 'server' | 'pool';
  readonly limit: number;
  readonly inFlight: number;

  constructor(server: string, scope: 'server' | 'pool', limit: number, inFlight: number) {
    super(`MCP server ${server} 在飞请求已达上限（${scope === 'pool' ? '整池' : '该 server'} ${inFlight}/${limit}）`);
    this.name = 'McpOverloadedError';
    this.server = server;
    this.scope = scope;
    this.limit = limit;
    this.inFlight = inFlight;
  }
}

/**
 * 这个 server 正在**崩溃退避**窗口里：`ensureReady` 直接拒绝，不退化成"再起一次"。
 *
 * 为什么要有独立类型：`startFailureText` 要给它一句完全不同的话（"它刚连续失败 N 次、
 * 到 X 之前不会再拉起它"），而"未能启动：<裸原因>"那句话会让读的人以为这是**一次新的故障**。
 */
export class McpBackoffError extends Error {
  readonly server: string;
  /** 连续失败次数（含触发这次退避的那一次） */
  readonly failures: number;
  /** 退避窗口结束时刻（epoch ms）：到这一刻之前不会再拉起它 */
  readonly retryAtMs: number;
  readonly retryInMs: number;
  /** 最近一次失败的原因（原样带出，人要看的是它） */
  readonly cause: string;

  constructor(server: string, failures: number, retryAtMs: number, retryInMs: number, cause: string) {
    super(`MCP server ${server} 正在崩溃退避（连续失败 ${failures} 次，${retryInMs}ms 后可重试）：${cause}`);
    this.name = 'McpBackoffError';
    this.server = server;
    this.failures = failures;
    this.retryAtMs = retryAtMs;
    this.retryInMs = retryInMs;
    this.cause = cause;
  }
}

/** 配置层错误：解析 mcp.servers[] 时的问题一律带定位信息，不做"尽力而为"的猜测修正 */
export class McpConfigError extends Error {
  readonly where: string;

  constructor(message: string, where: string) {
    super(message);
    this.name = 'McpConfigError';
    this.where = where;
  }
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** MCP 工具的三属性显式声明（未声明即取默认：destructive / exclusive / DEFAULT_MCP_TOOL_TIMEOUT_MS） */
export interface McpToolAttributes {
  sideEffect?: SideEffect;
  executionMode?: ToolExecutionMode;
  timeoutMs?: number;
}

/** 一个 stdio MCP server 的配置（对齐 design §4.19：mcp.servers[] = { name, command, args }） */
export interface McpServerEntry {
  name: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** true = 配置里保留条目但不起进程（临时停用一个 server 不必删配置） */
  disabled?: boolean;
  /** 该 server 全部工具的默认三属性（缺省 destructive / exclusive / 与每请求软超时同源，120s） */
  toolDefaults?: McpToolAttributes;
  /** 逐工具显式声明（键：工具短名或 mcp__{server}__{tool} 全名）——显式降级走这里 */
  tools?: Record<string, McpToolAttributes>;
  /** 逐 server 覆盖每请求软超时 */
  requestTimeoutMs?: number;
  /** 逐 server 覆盖空闲回收窗口 */
  idleReclaimMs?: number;
  /**
   * 逐 server 覆盖"同时在飞的请求上限"（缺省 `DEFAULT_MAX_IN_FLIGHT_PER_SERVER` = 4）。
   *
   * 超限**如实拒绝**（`E_MCP_OVERLOADED`），不排队——排队的代价见那个常量的注释。
   * 这一格是**现场可配**的（`mcp.servers[]` 里写 `maxInFlight`），改完要重启进程。
   */
  maxInFlight?: number;
  /**
   * 逐 server 关掉工具清单落盘缓存（缺省开）。
   *
   * 关掉 = 每次"看它有哪些工具"都真起一次进程（旧行为）。留着这一格是因为缓存有**陈旧**
   * 这一面代价，而"我宁可贵一点也要每次都准"是一个正当的选择。
   */
  toolsCache?: boolean;
  /**
   * **这个 server 是干什么的**（一句话；2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
   *
   * 用户原话：「她刚加入的 obscura，**索引内容质量低**。我觉得这东西得**要求 LLM 弄懂了加的
   * 是什么、用于什么，再自主填写**才对。（或者人添加时直接填写 desc）」
   *
   * 它进的是**常驻索引那一行**：`- obscura —— <desc> —— 启用，已见 3 件工具`
   * （渲染与判据在 `mcp/description.ts` 与 `persona/assets.ts` 的 `mcpIndexLineOf`；
   * 这一格**不进 `tools` 段**——它是索引的素材，不是工具的 schema）。
   *
   * **可选**：老配置没有这一格照旧可用（缺了索引行只写"配置里没写它做什么"，不编一句）。
   * 这一格**不参与** `entryFingerprint`（那是 command/args/cwd/env 的散列，判"这份清单缓存
   * 还作不作数"）：改一句描述不该让工具清单缓存作废——那与"清单变了没有"无关。
   */
  desc?: string;
}

export type McpStopReason = 'idle-reclaim' | 'crashed' | 'shutdown';

/** 关机序列的阶段（顺序即事实，测试与排障都靠它） */
export type McpShutdownStage = 'stdin-closed' | 'exited' | 'sigterm' | 'sigkill';

export interface McpShutdownReport {
  name: string;
  reason: McpStopReason;
  stages: McpShutdownStage[];
}

export interface McpServerStartedData {
  name: string;
  pid: number;
  tools: string[];
  /**
   * 这份清单的**名字 + 描述**（2026-10-09 加，评审缺陷 ⑤）。
   *
   * `tools` 只有名字，而扩展页要摆的是"这个服务提供了什么"——只有名字人看不出它是干什么的。
   * 观测面（`web/server.ts` 的 `mcpView`）**读不到池的注册表**（生产上刻意不给池注册表，
   * 否则 `mcp__*` 会进 `tools` 段），所以详情只能经这条 internal 事件出去（不进模型请求）。
   * 旧日志缺这一格 ⇒ 读的人按 `tools` 那一档回退（`mcpView` 两档都认）。
   */
  toolDetails: Array<{ name: string; description: string }>;
  /**
   * 本次启动的耗时（spawn → 握手 + `tools/list` 完成，毫秒）。
   *
   * 2026-10-10 加（资源观测）。**它是这一版唯一能回答"冷启动到底多慢"的数**：
   * 以前只有 `mcp/server-started` 的 `ts`，而那是"事件落库的时刻"，
   * 分不出"起进程慢"还是"清单页数多"。旧日志缺这一格 ⇒ 读的人按 null 处理。
   */
  startMs?: number;
}

export interface McpServerStoppedData {
  name: string;
  reason: McpStopReason;
  /**
   * 这个进程活了多久（毫秒）：`mcp/server-started` 到这一次回收之间。
   *
   * 与 `reason` 一起才读得出"是空闲回收救回了内存"还是"它起来就崩了"——
   * 后者会连着触发崩溃退避（见 `McpBackoffError`）。旧日志缺这一格。
   */
  uptimeMs?: number;
  /** 整个生命周期里在飞请求的峰值（它的注释在 `McpServerResourceData`） */
  inFlightPeak?: number;
  /**
   * 回收前**最后一次采到的** RSS（MB）；没采到过就是 null。
   *
   * 口径警告：这是"最近一次采样"，通常是启动后不久那一次，**不是**回收瞬间的内存
   *（进程一退出就没有 RSS 可读了；为了它去阻塞关机序列不值得）。要更准就得在回收前
   * 同步采一次——那会把每一次回收都拖慢一个读数进程（Windows 上整棵树那条路实测 ≈0.95s）。
   * 另外这一格跟着采样时的口径走：`mcp/server-resource` 里那条 `rssSource` 说什么口径，
   * 这里就是什么口径（整棵树 / 只有根进程）。
   */
  rssMb?: number | null;
}

/**
 * 资源观测（internal 事件；2026-10-10 加）。
 *
 * **为什么不塞进 `mcp/server-started`**：RSS 要起一个短命的外部读数进程（Windows 上是
 * `tasklist`，≈ 几十毫秒），把它塞进启动事件就等于让"启动"这条同步路径去等一个观测；
 * 而观测**不该拖慢被观测的东西**。所以它自己一条事件、异步落，读的人按名字与时间对上。
 *
 * 落点：`/api/mcp`（`web/server.ts` 的 `mcpView`）折这三条事件给出每 server 的
 * RSS / 启动耗时 / 在飞峰值 / 最近一次回收时间。事件是 internal ⇒ 不进请求、零缓存代价。
 */
export interface McpServerResourceData {
  name: string;
  pid: number;
  /** 采样时刻（epoch ms）——`ts` 是落库时刻，两者在异步采样下不是一回事 */
  sampledAtMs: number;
  /** 采样到的 RSS（MB）；采不到就是 null（见 `rssSource`） */
  rssMb: number | null;
  /**
   * 这个数是怎么来的（**口径在这一格上，别猜**）：`cim-tree` / `ps-tree` = **整棵树的和**、
   * `tasklist` / `proc` / `ps` = **只量到根进程**（降级口径）、`unavailable` = 没采到。
   *
   * 为什么非写不可：**"没采到"与"是 0 MB"必须分得开**，否则读的人会把一次失败读成
   * "这个 server 几乎不占内存"；而"整棵树"与"只有根进程"在启动器形态下差 12–21 倍
   * （判据与实测数见 `McpRssSource` 的注释）——**这两种误读都会让资源账看起来很小**。
   */
  rssSource: McpRssSource;
  /**
   * `rssMb` 是**几个进程**加出来的：`1` = 只量到根进程（降级口径）、`>1` = 真的是一棵树；
   * 没采到就是 null。与 `rssSource` 一起构成那笔账的口径。
   */
  rssProcesses: number | null;
  /** 本次启动耗时（与 `mcp/server-started` 的 `startMs` 同一个数，放这里方便一条事件读全） */
  startMs: number;
  /** 到这个采样点为止，这个连接上同时在飞的请求峰值 */
  inFlightPeak: number;
}

/** 生命周期事件出口（宿主把它接到事件日志上；mcp/* 是 internal） */
export type McpEventEmitter = (
  type: 'mcp/server-started' | 'mcp/server-stopped' | 'mcp/server-resource',
  data: McpServerStartedData | McpServerStoppedData | McpServerResourceData,
) => void;

/** 单个 server 的运行期快照（CLI/前端观测用；不暴露内部句柄） */
export interface McpServerStatus {
  name: string;
  /**
   * 配置里被标为 `disabled:true`（`mcp.servers[].disabled`）——**"停用"这个判定的唯一出处**。
   *
   * 入口工具（`tools/mcp-entry.ts` 的 `readyWord`）要说清"这个服务被停用了，调用不会拉起它"，
   * 而它手上只有这份快照：`entry.disabled` 是私有的，池的停用语义又都发生在**调用那一刻**
   * （`registerAll` 跳过它、`listTools` 拒、`callTool` 回 `E_MCP_DISABLED`）——那一刻之前
   * 没有任何东西能告诉她"这个 server 是关着的"。快照里不写这一格，入口就只能自己再判一遍
   * （读配置 / 匹配错误文本），两处判据必然漂移。
   */
  disabled: boolean;
  running: boolean;
  pid: number | null;
  ready: boolean;
  protocolVersion: string | null;
  tools: string[];
  /** 在途请求数 */
  inFlight: number;
  /** tools/list 次数：>1 说明发生过 list_changed 刷新或进程重启 */
  listCount: number;
  protocolErrors: number;
  /** 曾经成功启动过几次（随用随起 + 空闲回收会把它加上去） */
  starts: number;
  lastUsedAtMs: number | null;
  // ── 资源观测（2026-10-10 加；都是"已知就填、不知道就 null"，不编） ──
  /** 最近一次成功启动的耗时（spawn → 握手 + 清单，ms）；没起过就是 null */
  lastStartMs: number | null;
  /** 最近一次采样到的 RSS（MB）——**整棵进程树的和**（口径看 `rssSource` 与 `rssProcesses`） */
  rssMb: number | null;
  /** 那个 RSS 是怎么来的（`cim-tree`/`ps-tree` = 整棵树；`tasklist`/`proc`/`ps` = 只剩根进程；`unavailable` = 没采到，不是 0） */
  rssSource: McpRssSource;
  /** `rssMb` 是几个进程加出来的（`1` = 只有根进程；null = 没采到） */
  rssProcesses: number | null;
  /** 这个连接（或上一个连接）里在飞请求的峰值 */
  inFlightPeak: number;
  /** 最近一次被回收（空闲回收 / 崩溃 / 关停）的时刻（epoch ms）；没回收过就是 null */
  lastReclaimedAtMs: number | null;
  /** 最近一次回收的理由（与 `mcp/server-stopped` 的 `reason` 同源） */
  lastStopReason: McpStopReason | null;
  // ── 崩溃退避（2026-10-10 加） ──
  /** 连续启动失败次数（成功稳定运行满 `DEFAULT_BACKOFF_RESET_MS` 之后归零） */
  consecutiveFailures: number;
  /** 退避窗口结束时刻（epoch ms）；不在退避里就是 null */
  backoffUntilMs: number | null;
}

/**
 * 一次**声明面热更**净效果的账（2026-10-10 加，`ConfigWatcher` → `McpClientPool.applyDeclarations`）。
 *
 * 四处消费同一份账，所以它必须是**结构化的**而不是一句日志文本：给她的通报（`via:'mcp'` 那条
 * `wake/manual`）、诊断输出、热更事件、以及测试断言。
 *
 * 三个名字数组的顺序即事实：`added` / `changed` 按**新声明里的次序**、`removed` 按**旧声明里的
 * 次序**——它们要直接读进给她的那句话里（顺序乱了那句话读起来就像随机抽样）。
 */
export interface McpDeclarationChange {
  added: string[];
  removed: string[];
  /** 名字还在、声明变了（command / args / cwd / env / disabled / 三属性 / 两格覆盖都算） */
  changed: string[];
  /** 名字还在、声明也逐字段相同（**这种不重连、不通报**："文件动过"不等于"声明变了"） */
  unchanged: string[];
}

/**
 * 一条声明**内容**的指纹（键序无关：同一份声明怎么写都算出同一个值）。
 *
 * 与 `McpClientPool.entryFingerprint` 的分工（**两件事，别合并**）：
 *   · 这一份判"**声明变没变**"——它决定要不要重连、要不要通报她；
 *   · 那一份判"**工具清单落盘缓存还能不能用**"（口径见它的注释）。
 * 两处要的精度不同（这里要的是"逐字段等价"，那里要的是"影响清单的那几格"），
 * 而 `entryFingerprint` 只认 command/args/cwd/env 四格 ⇒ 拿它当这里的判据会让
 * "只改了 `disabled` / `toolDefaults`"这种真变化被读成"没变"。
 */
export function mcpEntryContentKey(entry: McpServerEntry, includeDesc = true): string {
  const defaults = entry.toolDefaults ?? {};
  // `env` 与 `tools` 两个映射**按键排序**后再进指纹：同一份声明的键序不同不该算出两个指纹
  // ——否则"把 env 的两行调个位置再保存一次"会被读成声明变更（白重连一次、还白叫她一次）。
  const env = entry.env ?? {};
  const envPairs = Object.keys(env).sort().map((key) => [key, env[key]] as const);
  const tools = entry.tools ?? {};
  const toolPairs = Object.keys(tools).sort().map((key) => {
    const attrs = tools[key] ?? {};
    return [
      key,
      attrs.sideEffect ?? null,
      attrs.executionMode ?? null,
      attrs.timeoutMs ?? null,
    ] as const;
  });
  return JSON.stringify({
    name: entry.name,
    command: entry.command,
    args: entry.args ?? [],
    cwd: entry.cwd ?? null,
    env: envPairs,
    disabled: entry.disabled === true,
    // `desc`（"它是干什么的"，2026-10-11 那条线加的）**只是索引那一行的一格**：
    // 它进 `mcpEntryContentKey`（于是"只改了 desc"照旧算一次声明变更、会通报她），
    // 但**不进** `mcpEntryConnectionKey`（不值得为一句说明把活着的连接收掉重连）。
    desc: includeDesc ? entry.desc ?? null : null,
    requestTimeoutMs: entry.requestTimeoutMs ?? null,
    idleReclaimMs: entry.idleReclaimMs ?? null,
    maxInFlight: entry.maxInFlight ?? null,
    toolsCache: entry.toolsCache ?? null,
    toolDefaults: [
      defaults.sideEffect ?? null,
      defaults.executionMode ?? null,
      defaults.timeoutMs ?? null,
    ],
    tools: toolPairs,
  });
}

/**
 * **这份声明值不值得把活着的连接收掉重连**（`applyDeclarations` 用它决定收谁）。
 *
 * 它比 `mcpEntryContentKey` **少一格 `desc`**：说明文字只影响索引那一行的渲染，
 * 与"那个进程怎么起、起成什么样"无关 ⇒ 为它重连一次是白付一次冷启动
 * （还要把在飞调用打断）。除 `desc` 之外两者逐字相同——同一个函数带上
 * `includeDesc = false` 就是它，所以"少哪一格"只有一处可改，不会两边漂。
 */
export function mcpEntryConnectionKey(entry: McpServerEntry): string {
  return mcpEntryContentKey(entry, false);
}

/** 子进程句柄抽象：默认真用 node:child_process，测试可注入替身做确定性关机序列断言 */
export interface McpProcess {
  readonly pid: number | undefined;
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  /** 写一行（含结尾换行）；stdin 已关闭时抛错 */
  write(line: string): void;
  closeStdin(): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type McpProcessSpawner = (entry: McpServerEntry) => McpProcess;

export interface McpClientPoolOptions {
  servers: readonly McpServerEntry[];
  emit: McpEventEmitter;
  /** 数据目录：blob 外置落 <dataDir>/blobs/ */
  dataDir: string;
  /** 工具注册目标；不传则只维护内部清单（CLI 重建场景不落注册表） */
  registry?: ToolRegistry;
  clientInfo?: { name: string; version: string };
  protocolVersion?: string;
  /** 每请求软超时（progress 通知可重置），默认 120s */
  requestTimeoutMs?: number;
  /** 每请求硬上限，默认 10 分钟 */
  progressHardCapMs?: number;
  /** `tools/list` 分页的页数上限，默认 `MAX_TOOLS_LIST_PAGES`（20） */
  maxToolsListPages?: number;
  /** 空闲回收窗口，默认 5 分钟 */
  idleReclaimMs?: number;
  /**
   * 整池同时在飞的 MCP 请求上限，默认 `DEFAULT_MAX_IN_FLIGHT`（8）。
   *
   * ⚠️ **这一格是宿主接线面，今天没有从 `config.json` 接过来**（`main.ts` 建池时不传它，
   * 于是走默认值）——本轮改动的授权范围不含 `main.ts`。逐 server 那一格
   * （`mcp.servers[].maxInFlight`）是现场可配的，缺省值同源。
   */
  maxInFlight?: number;
  /** 同一 server 在飞上限的**池级缺省**（逐 server 可覆盖），默认 `DEFAULT_MAX_IN_FLIGHT_PER_SERVER`（4） */
  maxInFlightPerServer?: number;
  /** 工具清单落盘缓存总开关，默认开（逐 server 可用 `entry.toolsCache` 覆盖） */
  toolsCache?: boolean;
  /** 崩溃退避的三个数（默认见 `DEFAULT_BACKOFF_*` 常量）；测试用它们把窗口压小 */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  backoffResetMs?: number;
  /**
   * RSS 采样器；给 `null` = 关掉采样（事件里就不会有 `mcp/server-resource`）。
   * 缺省按平台实现（Linux `/proc`、Windows `tasklist`、其它 unix `ps`）。
   * **三级优先**（显式这一格 > 环境变量 `IRMIA_MCP_RSS_SAMPLE` > 配置 > 出厂开）见 `resolveRssSampler`。
   */
  rssSampler?: McpRssSampler | null;
  /**
   * 配置里那一格（`config.json` 的 `mcp.rssSample`，出厂 true）：是否采那个 server 进程的 RSS。
   *
   * 与 `rssSampler` 的区别：这一格是**配置意见**（宿主从 `config.json` 递进来，`main.ts` 那一行），
   * 环境变量比它优先；`rssSampler` 是**显式注入**（测试与"这条线自己决定"的宿主），优先级最高。
   */
  rssSample?: boolean;
  /** 关 stdin 之后的等待，默认 2s */
  shutdownStdinWaitMs?: number;
  /** SIGTERM 之后的等待，默认 5s */
  shutdownTermWaitMs?: number;
  /** SIGKILL 之后的观察窗口，默认 500ms */
  shutdownKillGraceMs?: number;
  /** 取消宽限，默认 500ms */
  cancelGraceMs?: number;
  /** blob 外置阈值（估算 token），默认 8000 */
  blobThresholdTokens?: number;
  /** blob 预览字符数，默认 2000 */
  blobPreviewChars?: number;
  /** MCP 工具进注册表的默认 timeoutMs（执行器级），默认与每请求软超时同源（120s） */
  toolTimeoutMs?: number;
  /** 起进程的方式，默认 defaultMcpProcessSpawner */
  spawner?: McpProcessSpawner;
  /** 日志出口（stderr、协议错误、注册问题）；默认丢弃，绝不写 stdout */
  onLog?: (line: string) => void;
  now?: () => number;
}

/**
 * RSS 采样的来源（`unavailable` = 没采到；见 `McpServerResourceData.rssSource`）。
 *
 * **口径在这一格上，别猜**（2026-10-10 第二版：从"一个进程"改成"一整棵树"）：
 *   · `cim-tree` / `ps-tree` = **整棵树的和**（启动器 + 真 server + conhost 那些子/孙进程全都算）。
 *     Windows 走 `Win32_Process` 的 `ParentProcessId` 建父子表再自根向下求和；其它平台走
 *     `ps -Ao pid=,ppid=,rss=`。**这才是"这个 server 占了多少内存"该看的数**。
 *   · `tasklist` / `proc` / `ps` = **只量到根进程那一个**（整棵树读不到时的降级口径）。
 *     实测过这笔低报有多大：`uvx mcp-server-time` 根进程 6.0 MB vs 整棵树 124.7 MB（≈21×）、
 *     `uv tool install` 的 shim 6.1 vs 74.9（≈12×）——见 docs/multi-mcp-memory.md §5.4。
 *     读的人看到这三个值时要知道：**它只代表根进程**，不等于这个 server 的账。
 *   · `unavailable` = 没采到（平台不支持 / 进程已经没了 / 读失败；**不是 0 MB**）。
 */
export type McpRssSource =
  | 'cim-tree' | 'ps-tree' | 'tasklist' | 'proc' | 'ps' | 'unavailable';

export interface McpRssSample {
  rssMb: number | null;
  source: McpRssSource;
  /**
   * 这个和是**几个进程**加出来的（`1` = 只量到根进程，也就是降级口径）。
   *
   * 为什么要把这个数带上：`rssMb` 单看是分不出"整棵树"与"只有一个进程"的，
   * 而这两种口径在启动器形态下差 12–21 倍（见 `McpRssSource`）。不知道就不写这一格。
   */
  processes?: number;
}

/** 采样子进程的 RSS（注入点：测试给替身，`null` = 关掉采样） */
export type McpRssSampler = (pid: number) => Promise<McpRssSample>;

// ──────────────────────────────── JSON-RPC 线格式 ────────────────────────────────
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 把 epoch ms 写成给人看的时刻（**一律标 UTC**）。
 *
 * 为什么不用本机时区：池的这一层**拿不到 `config.timezone`**（那是宿主的装配面，
 * 池的构造参数里没有它）。写一个"看起来像本地时间但其实是我猜的时区"比写 UTC 更坏——
 * 排障的人会把 8 小时的差读成"它三点就该重启了怎么没重启"。
 */
function formatClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 解析一行 stdout。三种形态各有归属：请求（server → client）、通知、响应。
 * 返回失败即"非 JSON-RPC 行"——那正是 design §4.19 纪律 3 要重启 server 的情形。
 */
function parseJsonRpcLine(line: string): { ok: true; message: JsonRpcMessage } | { ok: false; detail: string } {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (err) {
    return { ok: false, detail: `不是合法 JSON（${errorText(err)}）：${clip(line, 120)}` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, detail: `不是 JSON-RPC 对象：${clip(line, 120)}` };
  }
  const record = value as Record<string, unknown>;
  if (record['jsonrpc'] !== '2.0') {
    return { ok: false, detail: `缺少 jsonrpc:"2.0"：${clip(line, 120)}` };
  }
  const hasMethod = typeof record['method'] === 'string';
  const hasId = typeof record['id'] === 'number' || typeof record['id'] === 'string';
  if (!hasMethod && !hasId) {
    return { ok: false, detail: `既不是请求/通知也不是响应（无 method 也无 id）：${clip(line, 120)}` };
  }
  return { ok: true, message: record as unknown as JsonRpcMessage };
}

/** initialize 回包校验结果 */
interface InitializeOutcome {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
}

/**
 * 校验 initialize 回包（design §4.19："initialize 握手（protocolVersion+capabilities+clientInfo → 校验回包）"）。
 * 校验不通过即判定该 server 不可用——宁可这个 server 不上线，也不带着半懂的协议状态发请求。
 */
function validateInitializeResult(result: unknown, requested: string, server: string): InitializeOutcome {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new McpProtocolError(server, 'initialize 的 result 不是对象');
  }
  const record = result as Record<string, unknown>;
  const version = record['protocolVersion'];
  if (typeof version !== 'string') {
    throw new McpProtocolError(server, 'initialize 回包缺少 protocolVersion');
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    throw new McpProtocolError(
      server,
      `initialize 回包协议版本 ${version} 不在支持列表（${SUPPORTED_PROTOCOL_VERSIONS.join(' / ')}）；`
      + `本次请求的是 ${requested}`,
    );
  }
  const serverInfo = asRecord(record['serverInfo']);
  const serverName = serverInfo['name'];
  if (typeof serverName !== 'string' || serverName === '') {
    throw new McpProtocolError(server, 'initialize 回包缺少 serverInfo.name');
  }
  const versionText = serverInfo['version'];
  return {
    protocolVersion: version,
    serverInfo: { name: serverName, version: typeof versionText === 'string' ? versionText : 'unknown' },
    capabilities: asRecord(record['capabilities']),
  };
}

/** tools/list 里的单件工具（只取我们真会用的字段） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

/**
 * 一次 `tools/list` 的**如实小结**（页数 / 件数 / 有没有截断）。
 *
 * 为什么要有它：分页这件事最坏的结果不是"少几件"，而是"她被告知某件工具不存在"——
 * 一份不完整的清单**必须**能一路传到回执里。所以这份小结由 `fetchToolsPages` 产出、
 * 由 `refreshTools` 落进连接、由入口的第二层回执原样带上。
 */
export interface McpToolsListSummary {
  /** 真的发了几次 `tools/list`（含最后一页） */
  pages: number;
  /** 收集到的件数 */
  tools: number;
  /** true = **没取全**（撞页数上限，或游标回环）——回执里必须说出来 */
  truncated: boolean;
  /** 截断时那个还没取的游标（供人排查；不截断时为 null） */
  nextCursor: string | null;
}

/**
 * 一份工具清单**是从哪儿来的**（2026-10-10 加；披露式入口的第二层回执靠它说清"这份清单旧不旧"）。
 *
 * 为什么非要有这一格：落盘缓存让"看一眼有哪些工具"从一次冷启动（0.07–0.8 s + ~46 MB）
 * 变成读一个 json，代价是**这份清单可能已经不是它现在的样子了**。回执里不许静默——
 * 她必须能读出"这是什么时候取的、可能过期"，否则缓存就从优化变成了"照旧清单行事而不知道它旧"。
 */
export interface McpToolsSourceInfo {
  /**
   * `live` = 这次真连上拉的（最新）；`cache` = 从落盘缓存供的（可能过期）；
   * `none` = 既没连着也没有缓存（这次**没有**清单可说，不是"它一件工具都没有"）。
   */
  source: 'live' | 'cache' | 'none';
  /** 清单取回时刻（epoch ms）；`none` 时为 null */
  fetchedAtMs: number | null;
  /** `cache` 时 = 距今多久；其余为 0 */
  ageMs: number;
  /** `cache` 时 = 缓存文件路径（排障用）；其余为 null */
  cachePath: string | null;
  /** 这份清单**可能已经过期**（只有 `cache` 是 true）——回执里必须说出来 */
  mayBeStale: boolean;
  /**
   * 这个 server 当前的**崩溃退避**状态（不在退避里就是 null）。
   *
   * 为什么挂在清单来源上：缓存命中时**根本不会去起进程**，于是退避这件事在那条路上
   * 一声不响；而"它刚连续失败 N 次、到 X 之前不会重试"正是她该知道的那一句。
   */
  backoff: { failures: number; retryAtMs: number; retryInMs: number } | null;
}

/**
 * 落盘缓存的形状（`<dataDir>/mcp-cache/<server>.json`）。
 *
 * 内容刻意只留"回执要用到的三样"：名字、描述、schema —— 外加**取回时间**与 **server 指纹**。
 * `annotations` **不缓存**：它只作参考提示（`buildToolDefinition` 的注释），
 * 而缓存里少一样东西就少一样会过期的数据。
 */
export interface McpToolsCacheFile {
  version: number;
  server: string;
  /**
   * server 指纹：`command` / `args` / `cwd` / `env` 的 SHA-256。
   * 指纹变了 ⇒ 这份缓存**作废**（配置变了，清单不再代表当前这个 server）。
   */
  fingerprint: string;
  /** 取回时刻（epoch ms，池的 `nowFn`） */
  fetchedAtMs: number;
  /** 取回时刻（ISO，给人看；与 `fetchedAtMs` 是同一刻的两种写法） */
  fetchedAt: string;
  /** 那一份清单"取全了没有"（页数 / 件数 / 有没有截断）——回执里那句"还有更多"靠它 */
  listSummary: McpToolsListSummary;
  tools: McpToolInfo[];
}

/**
 * 校验 tools/list 回包。列表里不合法（名字不符合规范字符集）的条目跳过并记日志：
 * 一件坏工具不该让整个 server 的其它工具都上不了线。
 */
function validateToolsList(
  result: unknown,
  server: string,
  log: (line: string) => void,
): McpToolInfo[] {
  const record = asRecord(result);
  const raw = record['tools'];
  if (!Array.isArray(raw)) {
    throw new McpProtocolError(server, 'tools/list 回包缺少 tools 数组');
  }
  const tools: McpToolInfo[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const name = entry['name'];
    if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) {
      log(`MCP server ${server} 的 tools/list 里有工具名不合法（${JSON.stringify(name)}）：已跳过该工具`);
      continue;
    }
    const info: McpToolInfo = { name };
    const description = entry['description'];
    if (typeof description === 'string') info.description = description;
    if (entry['inputSchema'] !== undefined) info.inputSchema = entry['inputSchema'];
    if (entry['outputSchema'] !== undefined) info.outputSchema = entry['outputSchema'];
    if (entry['annotations'] !== undefined) info.annotations = entry['annotations'];
    tools.push(info);
  }
  return tools;
}

// ──────────────────────────────── 描述预算 ────────────────────────────────

/**
 * 把描述裁进单件预算（registry 的 MAX_DESCRIPTION_TOKENS）。
 * 工具清单是随每次请求发送的常驻开销（design §4.18），MCP 工具的描述由外部 server 提供，
 * 我们对它没有编辑权——裁断比拒绝注册更合理：能力可用，代价受限。
 */
export function fitDescription(text: string, limit: number = MAX_DESCRIPTION_TOKENS): string {
  if (estimateTokens(text) <= limit) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(`${text.slice(0, mid)}…`) <= limit) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

/** 合成注册表里的工具名（唯一定义点，测试与排障都按它算名字） */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_NAME_PREFIX}${server}__${tool}`;
}

// ──────────────────────────────── 子进程默认实现 ────────────────────────────────

/**
 * 默认起进程：stdio 三管道，不继承任何标准流（stdout 只属于协议）。
 *
 * **起进程之前先判一次"这一台机器上根本起不来的形状"**（2026-10-10 加）：`npx` / `npx.cmd`
 * 这一批在 Windows 上换来的是一句裸 ENOENT / EINVAL，而读回执的人既不知道"为什么"、
 * 也不知道"那该写什么"。判据**只有一处**（`launcher-guard.ts` 的 `unstartableLauncherReason`），
 * 这里只负责把它抛出去——两条调用路都吃得到：池的 `startConnection` 与界面「测试连接」的
 * `probeMcpServer`（web/server.ts 那条路直接收 `spawner` 抛出来的错，不用各写一份文案）。
 *
 * 为什么判在**这里**、而不是 `checkLauncherSpec` 那道配置闸里：那一道是**平台无关的形状/策略**
 * 判据，且它的失败是**整机装配期**的硬错误——同一条 `npx` 声明在 Linux/macOS 上是合法的
 * （那边 npx 真能起），而在 Windows 上"一个 server 起不来"也不该让整台机器起不来
 * （`registerAll` 那条纪律：一个坏扩展不该让整机起不来）。平台事实就在起进程这一刻判。
 */
export const defaultMcpProcessSpawner: McpProcessSpawner = (entry) => {
  const childEnv = entry.env === undefined ? process.env : { ...process.env, ...entry.env };
  const unstartable = unstartableLauncherReason(entry.command, process.platform, childEnv);
  if (unstartable !== null) throw new Error(unstartable);
  const child = spawn(entry.command, [...(entry.args ?? [])], {
    cwd: entry.cwd ?? process.cwd(),
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return wrapChildProcess(child);
};

function wrapChildProcess(child: ChildProcess): McpProcess {
  const stdoutHandlers: Array<(chunk: string) => void> = [];
  const stderrHandlers: Array<(chunk: string) => void> = [];
  const exitHandlers: Array<(code: number | null, signal: string | null) => void> = [];
  let settled = false;
  /**
   * stdin 是否已经不可写。
   *
   * 为什么必须自己记这个位：server 进程先退出时，往它的 stdin 写会**异步**触发
   * `EPIPE` / `ERR_STREAM_WRITE_AFTER_END`——那是 `stdin` 上的 'error' 事件，
   * 而 EventEmitter 的 'error' 没有监听者就是**未捕获异常**，直接把宿主进程掀翻。
   * 实测踩到过：`mcp-test` 打一个"起来就退"的 server（比如命令不存在），
   * 结果整台机器陪它一起挂——这与 §4.19 纪律 4「失败绝不抛穿主循环」是直接的冲突。
   *
   * 所以：给 stdin 挂一个吞掉错误的监听者，并把失败折算成"写不进去"→ 由调用方
   * 按 McpServerExitedError 收尾（`request()` 的 catch 已经处理这条路）。
   */
  let stdinClosed = false;

  /** 退出只上报一次：'exit' 与 'error' 谁先到都算数，后到的忽略 */
  const emitExit = (code: number | null, signal: string | null): void => {
    if (settled) return;
    settled = true;
    for (const handler of exitHandlers) handler(code, signal);
  };

  child.stdout?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const handler of stdoutHandlers) handler(text);
  });
  child.stderr?.on('data', (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const handler of stderrHandlers) handler(text);
  });
  child.stdin?.on('error', () => {
    stdinClosed = true;
  });
  child.once('exit', (code, signal) => emitExit(code, signal));
  // 起不来（命令不存在等）只发 error 不发 exit：统一折算成"退出码未知"
  child.once('error', () => emitExit(null, null));

  return {
    pid: child.pid,
    onStdout(handler) {
      stdoutHandlers.push(handler);
    },
    onStderr(handler) {
      stderrHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    write(line) {
      const stdin = child.stdin;
      if (stdinClosed || stdin === null || stdin.destroyed) throw new Error('stdin 已关闭，无法写入');
      // 写失败（对端已退出）会异步触发 stdin 的 'error'：那个监听者只置位，
      // 这里不做别的——把失败折算成异常是下一行的事，绝不让 stream 的错误跑成未捕获异常
      stdin.write(line, 'utf8');
    },
    closeStdin() {
      try {
        child.stdin?.end();
      } catch {
        // 已经关了：关机序列继续往下一步走
      }
    },
    kill(signal) {
      // Windows 上 `child.kill('SIGTERM')` 对不响应信号的进程无效（实测：一个忽略 stdin
      // 关闭的 server 在 SIGTERM 之后照旧活着），所以 SIGKILL 那一级必须走进程树终止
      // ——与钩子执行器共用同一份实现（src/process/kill-tree.ts）。
      if (signal === 'SIGKILL') {
        killProcessTree(child);
        return;
      }
      try {
        child.kill(signal);
      } catch {
        // 已经退出：关机序列的下一步会读到 exited
      }
    },
  };
}

// ──────────────────────────────── 连接 ────────────────────────────────

interface PendingRequest {
  id: number;
  method: string;
  startedAt: number;
  /** 硬上限的绝对时刻（progress 重置也不能越过它） */
  hardDeadline: number;
  timeoutMs: number;
  progressToken: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  detachAbort: (() => void) | null;
  done: boolean;
}

/**
 * 连接与池的协作面。连接需要"记录日志、同步注册表、上报异常退出"三种能力，
 * 但不需要池的全部公开 API——窄接口让连接类不依赖池的具体实现。
 *
 * **导出**给 web 层的 `mcp-test` 复用：那条命令要单独拉起一个进程做握手探测、
 * 又**不能**把生命周期写进事件日志（那会让扩展页此后显示"已运行"），
 * 于是它实现这个接口的一个"不落事件"版本，而不是复刻一遍连接逻辑。
 */
export interface McpConnectionHost {
  readonly clientInfo: { name: string; version: string };
  readonly protocolVersion: string;
  readonly progressHardCapMs: number;
  readonly defaultRequestTimeoutMs: number;
  /**
   * `tools/list` 分页的页数上限（可选；缺省 `MAX_TOOLS_LIST_PAGES`）。
   *
   * 放在 host 上而不是连在这里写死：它是**池级策略**（与超时、回收窗口同一类），
   * 而连接只该知道"怎么把一页拉下来"。web 层那个 `mcp-test` 探测宿主不实现它 ⇒ 走缺省。
   */
  readonly maxToolsListPages?: number;
  /**
   * 同一 server 在飞上限的池级缺省（`entry.maxInFlight` 优先）。
   * 可选：探测宿主（`web/server.ts` 的 `McpProbeHost`）不实现它 ⇒ 走连接自己的缺省。
   */
  readonly maxInFlightPerServer?: number;
  now(): number;
  log(line: string): void;
  syncServerTools(conn: McpConnection): void;
  onListChangedRefresh(conn: McpConnection): void;
  onConnectionExit(conn: McpConnection, code: number | null, signal: string | null): void;
  onProtocolViolation(conn: McpConnection, detail: string): void;
  gracefulCancel(conn: McpConnection, requestId: number, reason: string): void;
  /**
   * 把刚取回来的清单落盘（可选口子：**探测宿主刻意不接它**）。
   *
   * 为什么探测宿主不接：`web/server.ts` 的 `mcp-test` 探的是**界面上还没保存的草稿配置**，
   * 拿它去写缓存等于"一次测试把一份没生效的配置的清单记成了现状"。
   */
  cacheTools?(conn: McpConnection, tools: readonly McpToolInfo[], summary: McpToolsListSummary): void;
}

/**
 * 一个 server 进程的连接：握手、请求表、超时时钟、stdout 行解析、关机序列。
 * 生命周期由池持有；连接自己不知道"空闲多久"这类池级策略。
 */
export class McpConnection {
  readonly entry: McpServerEntry;
  private readonly host: McpConnectionHost;
  private readonly process: McpProcess;

  private nextRequestId = 1;
  private stdoutBuffer = '';
  private stderrLines: string[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  /** 已作废请求的迟到响应 id：不当作协议错误，只当作"这个 server 不配合取消"的证据 */
  private readonly lateResponses = new Set<number>();

  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private exitWaiters: Array<() => void> = [];
  private shuttingDown = false;
  private shutdownTask: Promise<McpShutdownReport> | null = null;
  private stopReported = false;

  private readyFlag = false;
  private toolsCache: McpToolInfo[] = [];
  /** 最近一次 tools/list 的如实小结（页数 / 件数 / 有没有截断）——回执与日志共读这一份 */
  private toolsListSummaryRef: McpToolsListSummary = {
    pages: 0, tools: 0, truncated: false, nextCursor: null,
  };
  private capabilitiesCache: Record<string, unknown> = {};
  private protocolVersionValue: string | null = null;
  private serverInfoValue: { name: string; version: string } | null = null;
  private annotationsCache = new Map<string, unknown>();
  private listCountValue = 0;
  private protocolErrorCount = 0;
  private progressCount = 0;
  private lastUsedAtMs: number;
  /** 这个进程是什么时候起来的（`reap` 用它算 `uptimeMs`） */
  private readonly startedAtMs: number;
  /** 清单最后一次**真从 server 取回来**的时刻（活连接那一档的 `source.fetchedAtMs`） */
  private toolsFetchedAtMsValue = 0;
  /** 这个连接上同时在飞的请求峰值（资源观测；池级在飞上限只管"别打爆"，它管"看到过多少"） */
  private inFlightPeakValue = 0;

  constructor(entry: McpServerEntry, process: McpProcess, host: McpConnectionHost) {
    this.entry = entry;
    this.process = process;
    this.host = host;
    this.lastUsedAtMs = host.now();
    this.startedAtMs = host.now();
  }

  // ── 只读视图 ──

  get serverName(): string {
    return this.entry.name;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get ready(): boolean {
    return this.readyFlag && !this.exited && !this.shuttingDown;
  }

  /**
   * 连接不再可用：协议已不可信（stdout 违规），或某个请求已失控（进了取消宽限）。
   * 这两种情形下继续复用会把请求-响应时序搞脏，而"脏时序"是查不出来的。
   * 置位后后续调用会重新拉起进程，旧进程由关机序列收掉。
   */
  markUnusable(): void {
    this.readyFlag = false;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  get listCount(): number {
    return this.listCountValue;
  }

  get protocolErrors(): number {
    return this.protocolErrorCount;
  }

  get annotations(): ReadonlyMap<string, unknown> {
    return this.annotationsCache;
  }

  get tools(): readonly McpToolInfo[] {
    return this.toolsCache;
  }

  get lastUsed(): number {
    return this.lastUsedAtMs;
  }

  /** 进程起来的时刻（epoch ms）——`mcp/server-stopped.uptimeMs` 的减数 */
  get startedAt(): number {
    return this.startedAtMs;
  }

  /** 清单最后一次真取回的时刻（epoch ms）；没取过是 0 */
  get toolsFetchedAtMs(): number {
    return this.toolsFetchedAtMsValue;
  }

  /** 这个连接上同时在飞请求的峰值 */
  get inFlightPeak(): number {
    return this.inFlightPeakValue;
  }

  /**
   * 这个 server 上同时在飞的请求上限（逐 server 声明 > 池级缺省 > 常量缺省）。
   * 它只在 `request()` 一处判定——那是"一条 JSON-RPC 真要发出去"的唯一出口。
   */
  get maxInFlight(): number {
    const declared = this.entry.maxInFlight;
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
      return Math.trunc(declared);
    }
    const fallback = this.host.maxInFlightPerServer;
    return typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0
      ? Math.trunc(fallback)
      : DEFAULT_MAX_IN_FLIGHT_PER_SERVER;
  }

  get capabilities(): Record<string, unknown> {
    return this.capabilitiesCache;
  }

  /** 握手后协商出来的协议版本（未握手为 null） */
  get negotiatedProtocolVersion(): string | null {
    return this.protocolVersionValue;
  }

  /**
   * 握手时 server 自报的身份（未握手为 null）。
   * 与配置里的 `name` 是**两个不同的东西**：那个是"我们怎么叫它"，这个是"它怎么称呼自己"。
   * 排查"配错了 command"时后者的价值更大——它证明对面确实是我们以为的那个 server。
   */
  get serverInfo(): { name: string; version: string } | null {
    return this.serverInfoValue;
  }

  effectiveRequestTimeoutMs(fallback: number): number {
    return Math.max(1, this.entry.requestTimeoutMs ?? fallback);
  }

  /**
   * 最近一次 `tools/list` 的小结（页数 / 件数 / 有没有截断）。
   *
   * **它是回执的事实来源**：披露式入口的第二层要把"这次是不是全的"如实告诉她——
   * 一份不完整的清单配上"它有：a、b"那句，等于把"没取到"说成"不存在"（评审缺陷 ③）。
   */
  get toolsListSummary(): McpToolsListSummary {
    return this.toolsListSummaryRef;
  }

  effectiveIdleReclaimMs(fallback: number): number {
    return Math.max(1, this.entry.idleReclaimMs ?? fallback);
  }

  /** 记一次使用：空闲回收只看它 */
  touch(): void {
    this.lastUsedAtMs = this.host.now();
  }

  get shutdownStarted(): boolean {
    return this.shuttingDown;
  }

  get shutdownReport(): Promise<McpShutdownReport> | null {
    return this.shutdownTask;
  }

  attachShutdown(task: Promise<McpShutdownReport>): void {
    this.shutdownTask = task;
  }

  hasRespondedLate(requestId: number): boolean {
    return this.lateResponses.has(requestId);
  }

  /** 关机开始的统一入口：后续到达的退出事件不再重复上报 */
  beginShutdown(cause: Error): void {
    this.shuttingDown = true;
    this.failAllPending(cause);
  }

  markStopReported(): boolean {
    if (this.stopReported) return false;
    this.stopReported = true;
    return true;
  }

  stderrTail(maxChars = 300): string {
    const text = this.stderrLines.join('\n').trim();
    return text === '' ? '' : clip(text, maxChars);
  }

  // ── 进程事件 ──

  onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const index = this.stdoutBuffer.indexOf('\n');
      if (index < 0) break;
      const raw = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim() === '') continue;
      this.onStdoutLine(line);
      if (this.exited) return;
    }
    if (this.stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
      const sample = clip(this.stdoutBuffer.slice(0, 160), 160);
      this.stdoutBuffer = '';
      this.protocolViolation(
        `单行超过 ${MAX_STDOUT_LINE_CHARS} 字符仍未见换行（消息必须按行分隔）：${sample}`,
      );
    }
  }

  onStderrChunk(chunk: string): void {
    // stderr 是 server 的日志通道：捕获为日志，不参与协议
    for (const line of chunk.split(/\r?\n/u)) {
      const text = line.trim();
      if (text === '') continue;
      this.stderrLines.push(text);
      if (this.stderrLines.length > 50) this.stderrLines = this.stderrLines.slice(-50);
      this.host.log(`[mcp:${this.serverName}] ${text}`);
    }
  }

  onProcessExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitInfo = { code, signal };
    const waiters = [...this.exitWaiters];
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();

    const cause = new McpServerExitedError(this.serverName, code, signal);
    this.failAllPending(cause);
    if (this.shuttingDown) return;
    const tail = this.stderrTail();
    this.host.log(
      `MCP server ${this.serverName} 进程退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）`
      + `${tail === '' ? '' : `；stderr 尾部：${tail}`}`,
    );
    this.host.onConnectionExit(this, code, signal);
  }

  // ── stdout 派发 ──

  private onStdoutLine(line: string): void {
    const parsed = parseJsonRpcLine(line);
    if (!parsed.ok) {
      this.protocolViolation(parsed.detail);
      return;
    }
    const message = parsed.message;

    if (typeof message.method === 'string') {
      if (message.id === undefined) {
        this.onNotification(message.method, message.params);
        return;
      }
      // server → client 的请求：我们不声明 roots/sampling/elicitation，所以不该来（§4.19）
      this.host.log(
        `MCP server ${this.serverName} 发来未声明能力的请求 ${message.method}：`
        + 'roots/sampling/elicitation 一律不声明，已回 method not found',
      );
      this.writePayload({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}（客户端未声明该能力）` },
      });
      return;
    }

    if (typeof message.id !== 'number') {
      this.protocolViolation(`响应 id 不是数字（客户端只用数字 id）：${clip(line, 120)}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      // 迟到/重复响应：不是协议错误（我们的取消语义允许它出现），记下来当"server 守约"的证据
      this.lateResponses.add(message.id);
      this.host.log(`MCP server ${this.serverName} 的响应 id ${message.id} 没有在途请求（迟到或重复）：已丢弃`);
      return;
    }
    if (message.error !== undefined && message.error !== null) {
      const err = asRecord(message.error);
      const code = typeof err['code'] === 'number' ? err['code'] : -32000;
      const text = typeof err['message'] === 'string' ? err['message'] : 'server 未给出错误消息';
      this.settle(pending, {
        kind: 'error',
        error: new McpRpcError(this.serverName, pending.method, code, text, err['data']),
      });
      return;
    }
    this.settle(pending, { kind: 'result', value: message.result });
  }

  private onNotification(method: string, params: unknown): void {
    switch (method) {
      case 'notifications/tools/list_changed':
        this.host.log(`MCP server ${this.serverName} 通知 tools/list_changed：刷新工具清单`);
        this.host.onListChangedRefresh(this);
        return;
      case 'notifications/progress':
        this.onProgress(params);
        return;
      case 'notifications/cancelled':
        // server 侧取消：我们不主动向 server 发请求（roots/sampling 都没声明），这里只记日志
        this.host.log(`MCP server ${this.serverName} 发来 notifications/cancelled：已忽略（客户端未发起可取消的请求）`);
        return;
      default:
        this.host.log(`MCP server ${this.serverName} 的通知 ${method} 在最小子集之外：已忽略`);
    }
  }

  /** progress 重置软超时时钟，但绝不允许越过硬上限 */
  private onProgress(params: unknown): void {
    const record = asRecord(params);
    const rawToken = record['progressToken'] ?? asRecord(record['_meta'])['progressToken'];
    const token = typeof rawToken === 'string'
      ? rawToken
      : typeof rawToken === 'number' ? String(rawToken) : null;
    if (token === null) return;
    let target: PendingRequest | undefined;
    for (const pending of this.pending.values()) {
      if (pending.progressToken === token) {
        target = pending;
        break;
      }
    }
    if (target === undefined) return;
    this.progressCount += 1;
    if (this.host.now() >= target.hardDeadline) {
      // 硬上限已到：progress 不再续命，立刻按超时收尾
      this.timeoutPending(target);
      return;
    }
    if (target.timer !== null) clearTimeout(target.timer);
    this.armTimeout(target);
  }

  private protocolViolation(detail: string): void {
    this.protocolErrorCount += 1;
    // 协议不可信：立刻不许再被复用，否则下一次调用会在这个坏连接上继续发请求
    this.markUnusable();
    this.failAllPending(new McpProtocolError(this.serverName, detail));
    this.host.onProtocolViolation(this, detail);
  }

  // ── 握手 ──

  /**
   * 握手：initialize → 校验回包 → notifications/initialized → tools/list（一次并缓存）。
   * 失败会抛出，由池负责关掉这个进程并把失败如实告诉调用方。
   */
  async handshake(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: this.host.protocolVersion,
      // 刻意声明空能力：roots/sampling/elicitation 不声明，server 就不会发对应请求
      capabilities: {},
      clientInfo: { name: this.host.clientInfo.name, version: this.host.clientInfo.version },
    }, { timeoutMs: this.effectiveRequestTimeoutMs(this.host.defaultRequestTimeoutMs) });

    const outcome = validateInitializeResult(result, this.host.protocolVersion, this.serverName);
    this.protocolVersionValue = outcome.protocolVersion;
    this.serverInfoValue = outcome.serverInfo;
    this.capabilitiesCache = outcome.capabilities;

    this.writeNotification('notifications/initialized', {});
    this.readyFlag = true;

    if (outcome.capabilities['tools'] === undefined) {
      this.host.log(`MCP server ${this.serverName} 未声明 tools 能力：按规范不发 tools/list，该 server 无工具`);
      this.toolsCache = [];
      return;
    }
    await this.refreshTools();
  }

  /** 拉一次 `tools/list` 并刷新缓存（启动时一次；list_changed 与重连后再来一次） */
  async refreshTools(): Promise<void> {
    const list = await this.fetchToolsPages();
    // **先落盘再抛**：失败时也把"已经取到的那些"留在连接上——半份清单是一件**事实**，
    // 藏起来只会让调用方以为"一件都没有"（那与"没取全"是两句不同的话）。
    // 抛出去的那句话里带着"这是不完整的清单"，所以这不构成"把半份当全份"。
    this.toolsCache = list.tools;
    this.toolsListSummaryRef = list.summary;
    this.listCountValue += 1;
    this.toolsFetchedAtMsValue = this.host.now();
    this.annotationsCache = new Map<string, unknown>();
    for (const info of list.tools) {
      if (info.annotations !== undefined) this.annotationsCache.set(info.name, info.annotations);
    }
    this.host.log(
      `MCP server ${this.serverName} 的工具清单：${list.summary.tools} 件 / ${list.summary.pages} 页`
      + (list.summary.truncated ? '（**已截断**——它还有下一页，见页数上限）' : '（已取全）'),
    );
    this.host.syncServerTools(this);
    // 落盘（**先落缓存再抛**，与"先落盘再抛"同一条理由）：半份清单也是一份**事实**，
    // 而"上一次真取到的是什么"正是缓存要答的那个问题。抛出去的那句话里带着"这是不完整的清单"。
    this.host.cacheTools?.(this, list.tools, list.summary);
    if (list.error !== null) throw list.error;
  }

  /**
   * 把 `tools/list` 的**所有页**拉全（2026-10-09 修，评审缺陷 ③）。
   *
   * 修前的形状（实测，探针 `_research/mcp-pagination-probe.mts`）：只发一次请求、`params:{}`、
   * 回包的 `nextCursor` **静默丢弃**。假 server 两页 `[alpha,beta]+nextCursor` / `[gamma]`
   * ⇒ 真客户端只拿到 `alpha,beta`，`gamma` 消失，**零告警**；更坏的是入口的"名字核对"用同一份
   * 缓存 ⇒ 她调 `gamma` 会被告知「没有名为 gamma 的工具」——**一条自信的错误事实**。
   *
   * 三条纪律：
   *   ① **带上 cursor 重发**直到回包里没有 `nextCursor`；
   *   ② **页数上限**（`pageLimit`，缺省 `MAX_TOOLS_LIST_PAGES` = 20）：到顶就停下并**如实说
   *      "还有更多"**（`truncated` + `nextCursor`），绝不静默截断；
   *   ③ **中途失败如实报**：已经取到的页**保留**（`tools` 是"我看到过什么"的事实）并把错误放在
   *      `error` 里交回 `refreshTools`——由它**先落盘再抛**（点名"卡在第几页、已经取到几件"）。
   *      半份清单绝不许被当成完整清单，也绝不静默只给第一页。
   *
   * 为什么不让一个坏游标把我们拖死：cursor 是 server 给的字符串，回到同一个值就是死循环
   * ⇒ 用 `seen` 认出来并**如实说**（`truncated`），比无限重发安全。
   */
  private async fetchToolsPages(): Promise<{
    tools: McpToolInfo[]; summary: McpToolsListSummary; error: McpProtocolError | null;
  }> {
    const pageLimit = Math.max(1, this.host.maxToolsListPages ?? MAX_TOOLS_LIST_PAGES);
    const collected: McpToolInfo[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 1; ; page += 1) {
      const params: Record<string, unknown> = cursor === null ? {} : { cursor };
      let result: unknown;
      try {
        result = await this.request('tools/list', params, {
          timeoutMs: this.effectiveRequestTimeoutMs(this.host.defaultRequestTimeoutMs),
        });
      } catch (err) {
        // 第一页失败 = 整个 list 失败（与修前同形：抛出去，由握手/刷新那条路处理）；
        // 第二页起失败 = **半份清单**，必须点名"卡在第几页、已经取到几件"
        if (collected.length === 0) throw err;
        return {
          tools: collected,
          summary: { pages: page - 1, tools: collected.length, truncated: true, nextCursor: cursor },
          error: new McpProtocolError(
            this.serverName,
            `tools/list 分页在第 ${page} 页失败（cursor=${JSON.stringify(cursor)}）：${errorText(err)}；`
            + `已经取到 ${collected.length} 件（这是**不完整**的清单，别把它当成全部）`,
          ),
        };
      }
      // 校验**逐页**做（一件坏工具不该让整个 server 的其它工具都上不了线，原本就是这么设计的）
      collected.push(...validateToolsList(result, this.serverName, (line) => this.host.log(line)));
      const next = asRecord(result)['nextCursor'];
      const nextCursor = typeof next === 'string' && next !== '' ? next : null;
      if (nextCursor === null) {
        return {
          tools: collected,
          summary: { pages: page, tools: collected.length, truncated: false, nextCursor: null },
          error: null,
        };
      }
      if (page >= pageLimit) {
        this.host.log(
          `MCP server ${this.serverName} 的工具清单超过 ${pageLimit} 页：已停在 ${collected.length} 件，`
          + '**后面还有**（nextCursor 非空）。要做完就调大页数上限，或者把那个 server 的工具收窄一点。',
        );
        return {
          tools: collected,
          summary: { pages: page, tools: collected.length, truncated: true, nextCursor },
          error: null,
        };
      }
      if (seen.has(nextCursor)) {
        this.host.log(
          `MCP server ${this.serverName} 的 tools/list 游标回环（又给了 ${JSON.stringify(nextCursor)}，第 ${page} 页）：`
          + `已停在 ${collected.length} 件，**这可能是半份清单**。`,
        );
        return {
          tools: collected,
          summary: { pages: page, tools: collected.length, truncated: true, nextCursor },
          error: null,
        };
      }
      seen.add(nextCursor);
      cursor = nextCursor;
    }
  }

  // ── 请求 ──

  /**
   * 调用一个工具：request 包一层，带上 progress token。
   * token 直接取请求 id 的字符串形式——一个请求一个 token，progress 通知才能精确对上是哪个请求。
   */
  async callToolInternal(
    toolName: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    this.touch();
    return await this.request('tools/call', { name: toolName, arguments: args }, {
      timeoutMs: options.timeoutMs,
      // 带上 progressToken：server 才会发 notifications/progress，时钟重置才有依据
      useProgress: true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  private request(
    method: string,
    params: Record<string, unknown> | undefined,
    options: { timeoutMs?: number; hardCapMs?: number; signal?: AbortSignal; useProgress?: boolean },
  ): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new McpServerExitedError(this.serverName, this.exitInfo?.code ?? null, this.exitInfo?.signal ?? null));
    }
    if (this.shuttingDown) {
      return Promise.reject(new McpServerStoppedError(this.serverName, 'shutdown'));
    }
    /**
     * **在飞上限**（背压；2026-10-10 加）。
     *
     * 为什么判在这里：这是"一条 JSON-RPC 真要写进那个进程的 stdin"的唯一出口，
     * 于是它是唯一一个**不会漏**的判点（在调用点判就会漏掉握手、清单、通知那几条路）。
     * 超限**直接拒**（不进 `pending`、不排队）：排队会引出"唯一在跑的那件在等一件排队的启动"
     * 这种死锁面，而"如实说清、让她稍后再试"没有那个面。
     *
     * 不会自锁：同一连接上的握手与 `tools/list` 是**顺序**发的（`handshake` 里 await 完一步
     * 才发下一步），所以上限 ≥ 1 时它们永远排得进去；而新连接建立时 `pending` 一定是空的。
     */
    if (this.pending.size >= this.maxInFlight) {
      return Promise.reject(new McpOverloadedError(this.serverName, 'server', this.maxInFlight, this.pending.size));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const startedAt = this.host.now();
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.effectiveRequestTimeoutMs(this.host.defaultRequestTimeoutMs));
    // 硬上限不低于软超时：否则时钟永远到不了软超时，"progress 可重置"就没有意义
    const hardCapMs = Math.max(timeoutMs, options.hardCapMs ?? this.host.progressHardCapMs);
    const progressToken = options.useProgress === true ? String(id) : null;
    const body: Record<string, unknown> = { ...(params ?? {}) };
    if (progressToken !== null) body['_meta'] = { progressToken };

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        method,
        startedAt,
        hardDeadline: startedAt + hardCapMs,
        timeoutMs,
        progressToken,
        timer: null,
        resolve,
        reject,
        detachAbort: null,
        done: false,
      };
      this.pending.set(id, pending);
      if (this.pending.size > this.inFlightPeakValue) this.inFlightPeakValue = this.pending.size;
      this.armTimeout(pending);

      const signal = options.signal;
      if (signal !== undefined) {
        if (signal.aborted) {
          this.settle(pending, {
            kind: 'error',
            error: new McpAbortedError(this.serverName, method, '信号在派发前已置位'),
          });
          return;
        }
        const onAbort = (): void => {
          this.writeNotification('notifications/cancelled', { requestId: id, reason: 'aborted' });
          this.settle(pending, {
            kind: 'error',
            error: new McpAbortedError(this.serverName, method, '调用方取消了这次请求'),
          });
          this.host.gracefulCancel(this, id, 'aborted');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      try {
        this.writePayload({ jsonrpc: '2.0', id, method, params: body });
      } catch (err) {
        this.settle(pending, {
          kind: 'error',
          error: new McpServerExitedError(this.serverName, this.exitInfo?.code ?? null, this.exitInfo?.signal ?? null),
        });
        this.host.log(`MCP server ${this.serverName} 的 ${method} 写入失败：${errorText(err)}`);
      }
    });
  }

  private armTimeout(pending: PendingRequest): void {
    const now = this.host.now();
    const nextAt = Math.min(now + pending.timeoutMs, pending.hardDeadline);
    const delay = Math.max(0, nextAt - now);
    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (pending.done) return;
      this.timeoutPending(pending);
    }, delay);
  }

  private timeoutPending(pending: PendingRequest): void {
    const hardCapHit = this.host.now() >= pending.hardDeadline;
    this.settle(pending, {
      kind: 'error',
      error: new McpRequestTimeoutError(this.serverName, pending.method, pending.timeoutMs, hardCapHit),
    });
    // 超时即杀的第一半：先把取消告诉 server（规范要求的通知）
    this.writeNotification('notifications/cancelled', {
      requestId: pending.id,
      reason: hardCapHit ? 'hard-timeout' : 'timeout',
    });
    // 第二半在池里：宽限内不配合取消的连接判定失效，走关机序列换掉它
    this.host.gracefulCancel(this, pending.id, hardCapHit ? 'hard-timeout' : 'timeout');
  }

  private settle(pending: PendingRequest, outcome: { kind: 'result'; value: unknown } | { kind: 'error'; error: Error }): void {
    if (pending.done) return;
    pending.done = true;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.timer = null;
    pending.detachAbort?.();
    pending.detachAbort = null;
    this.pending.delete(pending.id);
    if (outcome.kind === 'result') pending.resolve(outcome.value);
    else pending.reject(outcome.error);
  }

  private failAllPending(cause: Error): void {
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, { kind: 'error', error: cause });
    }
  }

  private writeNotification(method: string, params: Record<string, unknown>): void {
    try {
      this.writePayload({ jsonrpc: '2.0', method, params });
    } catch (err) {
      this.host.log(`MCP server ${this.serverName} 的 ${method} 通知写入失败：${errorText(err)}`);
    }
  }

  /** 一条消息一行，绝不内嵌换行（design §4.19 stdio 纪律） */
  private writePayload(payload: Record<string, unknown>): void {
    const line = JSON.stringify(payload);
    if (line.includes('\n')) {
      throw new McpProtocolError(this.serverName, 'JSON-RPC 消息里出现了未转义的换行');
    }
    this.process.write(`${line}\n`);
  }

  // ── 关机序列 ──

  closeStdin(): void {
    this.process.closeStdin();
  }

  killProcess(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.process.kill(signal);
  }

  /** 等退出：已退出立刻返回 true；否则等事件或超时 */
  waitExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    const ms = Math.max(0, timeoutMs);
    return new Promise<boolean>((resolve) => {
      const remove = (): void => {
        const index = this.exitWaiters.indexOf(waiter);
        if (index >= 0) this.exitWaiters.splice(index, 1);
      };
      const waiter = (): void => {
        clearTimeout(timer);
        remove();
        resolve(true);
      };
      const timer = setTimeout(() => {
        remove();
        resolve(this.exited);
      }, ms);
      this.exitWaiters.push(waiter);
    });
  }
}

// ──────────────────────────────── 池 ────────────────────────────────

/**
 * MCP 客户端池：配置里注册若干 stdio server，按需拉起、缓存工具清单、空闲回收、统一关机。
 *
 * 池对外的三条使用路径：`registerAll()`（宿主启动期枚举并注册工具）、
 * `callTool()`（工具 handler 的唯一入口）、`shutdown()`（宿主关停）。
 * 任何失败都折算成结果或日志，绝不抛穿主循环——这是"崩溃不传染"的落点。
 */
export class McpClientPool implements McpConnectionHost {
  readonly clientInfo: { name: string; version: string };
  readonly protocolVersion: string;
  readonly progressHardCapMs: number;
  readonly defaultRequestTimeoutMs: number;
  readonly maxToolsListPages: number;

  private readonly entries = new Map<string, McpServerEntry>();
  private readonly connections = new Map<string, McpConnection>();
  private readonly starting = new Map<string, Promise<McpConnection>>();
  private readonly registeredByServer = new Map<string, string[]>();
  private readonly startCounts = new Map<string, number>();
  /**
   * 崩溃退避的账（2026-10-10 加）：连续失败次数 + 退避窗口结束时刻。
   * 只增不判的 `startCounts` 是"起过几次"的账，这一份才是"它现在坏不坏"的账。
   */
  private readonly failures = new Map<string, { count: number; nextAllowedAtMs: number; lastCause: string }>();
  /** 每个 server 上一次**成功启动**的时刻（退避重置的基准：稳定运行满 `backoffResetMs` 就清零） */
  private readonly lastStartOkAt = new Map<string, number>();
  /** 资源观测的账（进 `status()` 与 `mcp/server-resource`，不进请求） */
  private readonly resourceStats = new Map<string, {
    startMs: number | null; rssMb: number | null; rssSource: McpRssSource; rssProcesses: number | null;
    inFlightPeak: number; lastReclaimedAtMs: number | null; lastStopReason: McpStopReason | null;
  }>();
  /** 整池在飞（池级背压的计数器；进出成对，见 `callTool`） */
  private inFlightTotal = 0;
  private readonly registryRef: ToolRegistry | undefined;
  private readonly emitEvent: McpEventEmitter;
  private readonly dataDir: string;
  private readonly defaultIdleReclaimMs: number;
  private readonly maxInFlight: number;
  readonly maxInFlightPerServer: number;
  private readonly toolsCacheEnabled: boolean;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly backoffResetMs: number;
  private readonly sampleRss: McpRssSampler | null;
  private readonly shutdownStdinWaitMs: number;
  private readonly shutdownTermWaitMs: number;
  private readonly shutdownKillGraceMs: number;
  private readonly cancelGraceMs: number;
  private readonly blobThresholdTokens: number;
  private readonly blobPreviewChars: number;
  private readonly toolTimeoutMs: number;
  private readonly spawnProcess: McpProcessSpawner;
  private readonly logLine: (line: string) => void;
  private readonly nowFn: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(options: McpClientPoolOptions) {
    this.clientInfo = options.clientInfo ?? { ...DEFAULT_CLIENT_INFO };
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.progressHardCapMs = Math.max(1, options.progressHardCapMs ?? DEFAULT_PROGRESS_HARD_CAP_MS);
    this.defaultRequestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    this.maxToolsListPages = Math.max(1, options.maxToolsListPages ?? MAX_TOOLS_LIST_PAGES);
    this.defaultIdleReclaimMs = Math.max(1, options.idleReclaimMs ?? DEFAULT_IDLE_RECLAIM_MS);
    this.maxInFlight = Math.max(1, options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT);
    this.maxInFlightPerServer = Math.max(1, options.maxInFlightPerServer ?? DEFAULT_MAX_IN_FLIGHT_PER_SERVER);
    this.toolsCacheEnabled = options.toolsCache !== false;
    this.backoffBaseMs = Math.max(1, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
    this.backoffCapMs = Math.max(this.backoffBaseMs, options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS);
    this.backoffResetMs = Math.max(1, options.backoffResetMs ?? DEFAULT_BACKOFF_RESET_MS);
    // 采不采 RSS：三级优先（显式注入 > 环境变量 > 配置 > 出厂开），判据见 `resolveRssSampler`
    this.sampleRss = resolveRssSampler({
      ...(options.rssSampler === undefined ? {} : { rssSampler: options.rssSampler }),
      ...(options.rssSample === undefined ? {} : { rssSample: options.rssSample }),
    });
    this.shutdownStdinWaitMs = Math.max(0, options.shutdownStdinWaitMs ?? DEFAULT_SHUTDOWN_STDIN_WAIT_MS);
    this.shutdownTermWaitMs = Math.max(0, options.shutdownTermWaitMs ?? DEFAULT_SHUTDOWN_TERM_WAIT_MS);
    this.shutdownKillGraceMs = Math.max(0, options.shutdownKillGraceMs ?? DEFAULT_SHUTDOWN_KILL_GRACE_MS);
    this.cancelGraceMs = Math.max(0, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    this.blobThresholdTokens = Math.max(0, options.blobThresholdTokens ?? DEFAULT_BLOB_THRESHOLD_TOKENS);
    this.blobPreviewChars = Math.max(0, options.blobPreviewChars ?? DEFAULT_BLOB_PREVIEW_CHARS);
    this.toolTimeoutMs = Math.max(1, options.toolTimeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS);
    this.spawnProcess = options.spawner ?? defaultMcpProcessSpawner;
    this.logLine = options.onLog ?? (() => undefined);
    this.nowFn = options.now ?? (() => Date.now());
    this.emitEvent = options.emit;
    this.dataDir = options.dataDir;
    this.registryRef = options.registry;

    for (const entry of options.servers) {
      const issue = validateEntry(entry);
      if (issue !== null) {
        this.logLine(`MCP 配置问题（已跳过该 server）：${issue}`);
        continue;
      }
      if (this.entries.has(entry.name)) {
        this.logLine(`MCP 配置里 server 名 ${entry.name} 重复：只保留第一条`);
        continue;
      }
      this.entries.set(entry.name, entry);
    }
  }

  // ── 对外 API ──

  /**
   * 启动期枚举：把每个 server 拉起一次、拉清单、注册工具，然后交给空闲回收管。
   * 单个 server 起不来只记日志并跳过——一个坏扩展不该让整机起不来。
   */
  async registerAll(): Promise<McpServerStatus[]> {
    for (const entry of this.entries.values()) {
      if (entry.disabled === true) continue;
      try {
        await this.ensureReady(entry.name);
      } catch (err) {
        this.logLine(
          `MCP server ${entry.name} 启动失败：${errorText(err)}`
          + '（该 server 的工具未注册，其余 server 不受影响）',
        );
      }
    }
    return this.status();
  }

  /** 运行期快照（CLI/前端观测） */
  status(): McpServerStatus[] {
    const out: McpServerStatus[] = [];
    for (const entry of this.entries.values()) {
      const conn = this.connections.get(entry.name);
      // 连接没了（回收过 / 从没起过）也要把**上一个连接**的观测留下：那些数是"它上次是什么样"，
      // 抹掉它们等于"回收一次观测就归零"，而那正是用户这一轮要看的账（回收救回了多少）。
      const stat = this.resourceStats.get(entry.name);
      const failure = this.failures.get(entry.name);
      out.push({
        name: entry.name,
        // 停用的判据**只在这一处**求值（`entry.disabled` 是配置解析的产物）：入口那一屏照着
        // 这一格说"已停用"，不再自己读配置，也不去猜 `E_MCP_DISABLED` 的文本。
        disabled: entry.disabled === true,
        running: conn !== undefined && !conn.hasExited,
        pid: conn?.pid ?? null,
        ready: conn?.ready ?? false,
        protocolVersion: conn === undefined ? null : conn.negotiatedProtocolVersion,
        tools: conn === undefined ? [] : conn.tools.map((tool) => tool.name),
        inFlight: conn?.inFlight ?? 0,
        listCount: conn?.listCount ?? 0,
        protocolErrors: conn?.protocolErrors ?? 0,
        starts: this.startCounts.get(entry.name) ?? 0,
        lastUsedAtMs: conn === undefined ? null : conn.lastUsed,
        lastStartMs: stat?.startMs ?? null,
        rssMb: stat?.rssMb ?? null,
        rssSource: stat?.rssSource ?? 'unavailable',
        rssProcesses: stat?.rssProcesses ?? null,
        inFlightPeak: conn?.inFlightPeak ?? stat?.inFlightPeak ?? 0,
        lastReclaimedAtMs: stat?.lastReclaimedAtMs ?? null,
        lastStopReason: stat?.lastStopReason ?? null,
        consecutiveFailures: failure?.count ?? 0,
        backoffUntilMs: failure !== undefined && failure.nextAllowedAtMs > this.nowFn()
          ? failure.nextAllowedAtMs
          : null,
      });
    }
    return out;
  }

  /** 已注册进注册表的 MCP 工具全名（含对外不可见的 destructive） */
  toolNames(): string[] {
    const names: string[] = [];
    for (const list of this.registeredByServer.values()) names.push(...list);
    return names;
  }

  /**
   * **声明面热更**（2026-10-10 加）：把一份新的 `mcp.servers[]` 接进这个活着的池，
   * 按 server 粒度算出"加了 / 删了 / 改了 / 没变"，并且**只动变化的那几个**。
   *
   * ──────────────────── 为什么是这个粒度（别整个池重来） ────────────────────
   *
   * 一个池里通常只有一两个 server，但"重来"的代价从来不是那两行循环：它会
   *   ① 把**正在飞的调用**打断（那是别人的工作，热更配置不该掀桌子）；
   *   ② 把每个 server 的账（`startCounts` / 退避 / 资源观测 / 工具清单缓存）清成零
   *      ——于是"只加了一个 server"会让另一个的运维账全部从头开始，界面上的历史凭空消失；
   *   ③ 让"没变的那几个"白付一次冷启动。
   * 所以这里按 `mcpEntryContentKey` 逐个比：只有**新声明**（`added`）与**声明变了**（`changed`）
   * 需要重连，`removed` 需要收掉，`unchanged` 一个字节都不动。
   *
   * ──────────────────── 它不管的三件事（都归调用方） ────────────────────
   *
   *   · **不读盘、不解析、不校验**：`servers` 必须是**已经过 `parseMcpServers` 的那一份**
   *     （调用方 `config.ts` 的 `loadConfig` 就是这么给的）。这一层再做一遍校验等于第二套判据，
   *     而"配置坏了怎么办"的答案只有一个：**那份配置根本进不来**（`ConfigWatcher` 保留旧配置继续跑），
   *     于是池里永远不会出现"半份坏声明"。
   *   · **不碰 `config.json`**：它只改这个池的内存表（盘上那份由写入者负责）。
   *   · **不通报、不唤醒**：给她的那句话由调用方拼（它才知道当前一共几个 server、
   *     以及这一轮叫什么名字），这里只回一份结构化的净效果账。
   *
   * ──────────────────── 两条账的口径（刻意与 `shutdown` 不同） ────────────────────
   *
   *   · **没变的那几个保留全部状态**（上面第 ② 条）；
   *   · **变了 / 删掉的那几个把重连的账清干净**：`failures` / `lastStartOkAt` 抹掉——
   *     否则一个"旧声明连续崩了 3 次"的 server 在改好声明之后仍然在退避里，
   *     表现为"我明明改对了却还要等 300 秒"（退避管的是"这份声明起不来"，
   *     声明一换那份账就不再代表现在）。`startCounts` 与资源观测**留着**（那是历史，不是判定）。
   *
   * 收连接时**在飞请求照旧走各自的超时/取消**：`reap` 的第一段是关 stdin（优雅退出），
   * 所以"正在跑的一件"有机会自己跑完；收不掉也只是一行日志（`reapOne` 的隔离纪律）。
   */
  async applyDeclarations(servers: readonly McpServerEntry[]): Promise<McpDeclarationChange> {
    const next = new Map<string, McpServerEntry>();
    const nextKeys = new Map<string, string>();
    for (const entry of servers) {
      // 与构造期同一条纪律：名字不合法 / 重复只跳过它自己，绝不因此把池搞坏
      const issue = validateEntry(entry);
      if (issue !== null) {
        this.logLine(`MCP 配置问题（已跳过该 server）：${issue}`);
        continue;
      }
      if (next.has(entry.name)) {
        this.logLine(`MCP 配置里 server 名 ${entry.name} 重复：只保留第一条`);
        continue;
      }
      next.set(entry.name, entry);
      nextKeys.set(entry.name, mcpEntryContentKey(entry));
    }

    const change: McpDeclarationChange = { added: [], removed: [], changed: [], unchanged: [] };
    const previous = new Map(this.entries);
    // 顺序即事实：按新声明里的次序报 added / changed / unchanged（见 McpDeclarationChange 注释）
    for (const [name, key] of nextKeys) {
      const prior = previous.get(name);
      if (prior === undefined) {
        change.added.push(name);
        continue;
      }
      if (mcpEntryContentKey(prior) === key) {
        change.unchanged.push(name);
        continue;
      }
      change.changed.push(name);
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) change.removed.push(name);
    }

    /**
     * **要收掉重连的那几个** ≠ **报成"变了"的那几个**（2026-10-11 拆开）。
     *
     * 差别只有一格：`desc`（"它是干什么的"）。它进 `mcpEntryContentKey` ⇒ 只改说明也算一次
     * 声明变更（要通报她，索引那一行确实会变）；但它**不进** `mcpEntryConnectionKey`
     * ⇒ 不值得为一句说明把活着的连接收掉（那要白付一次冷启动，还会打断在飞调用）。
     * 判据只有 `mcpEntryConnectionKey` 一处（它是"contentKey 去掉 desc"），别在这里另写一套。
     */
    const toDrop = [
      ...change.removed,
      ...change.changed.filter((name) => {
        const prior = previous.get(name);
        const after = next.get(name);
        if (prior === undefined || after === undefined) return true;
        return mcpEntryConnectionKey(prior) !== mcpEntryConnectionKey(after);
      }),
    ];
    // 先把**要收掉的**收掉，再换表：收不掉的那些照旧留在池里（宁可与旧声明一致，
    // 也不留一个"配置说删了、进程还在跑"的孤儿）
    for (const name of toDrop) {
      await this.reapOneByName(name, 'crashed');
    }

    this.entries.clear();
    for (const [name, entry] of next) this.entries.set(name, entry);

    // 收掉的那几个：重连的账清干净（口径见方法头）。**只动真正收掉的**——
    // 一个只改了 `desc` 的 server 收都没收，它的退避账与清单缓存就不该被清
    // （清了等于"一句说明的编辑顺手抹掉它起不来的记录"，下一个人会以为它一直好好的）。
    for (const name of toDrop) {
      this.failures.delete(name);
      this.lastStartOkAt.delete(name);
      this.invalidateToolsCache(name, 'mcp.servers[] 声明面热更');
    }
    // 名字被删掉的那几个还会留一份清单缓存与观测账：缓存按"配置变了"作废（见上），
    // 观测账留在 `resourceStats` 里（它是历史；`status()` 只遍历**当前**的 entries，
    // 所以界面上不会再摆出这个已删的 server——它的事实留在事件流里，那才是历史该待的地方）。
    for (const name of change.removed) {
      this.registeredByServer.delete(name);
      this.startCounts.delete(name);
      this.resourceStats.delete(name);
      this.starting.delete(name);
    }
    return change;
  }

  /**
   * 某个 server 的某件工具**生效的三属性**（披露式入口按它判"这次是不是危险动作"）。
   *
   * 复用 `buildToolDefinition` 的同一个解析器（`resolveToolAttributes`）——披露式下工具
   * **不进注册表**，入口那条路就只能自己问一句；两处各写一套判定必然漂移，
   * 而漂移的方向恰好是"以为它只读、其实 destructive"。
   *
   * 逐工具 `timeoutMs` 取的是**执行器级**缺省（`toolTimeoutMs`，与每请求软超时同源，120s），
   * 与注册表里那一件一致。
   */
  resolveAttributes(serverName: string, toolName: string): Required<McpToolAttributes> | null {
    const entry = this.entries.get(serverName);
    if (entry === undefined) return null;
    return resolveToolAttributes(entry, toolName, this.toolTimeoutMs);
  }

  /**
   * 披露式入口要的那一件：**某个 server 现在有哪些工具**（`mcp` 工具的第二层）。
   *
   * 与 `callTool` 的两处刻意不同：
   *   1. **它会把工具注册进注册表**（`syncServerTools` 挂在连接建立之后，见 `startConnection`）。
   *      所以调用方**不许把 registry 交给池**——披露式的全部价值就是"MCP 的工具不进 `tools` 段"，
   *      池里带着 registry 就会把它们列进去（用户在 2026-10-09 拍定的口径）。
   *      这一条由 `main.ts` 的装配点保证：披露式下构造池时**不传 `registry`**。
   *   2. **它抛出**（`callTool` 是"永不抛出"）。理由：这一件的调用方是"取清单"而不是"执行动作"，
   *      "取不到"必须能被如实转达成一句给模型的话，而不是伪装成一份空清单
   *      （空清单与连不上是两句完全不同的话）。
   *
   * `requireConnected` 的两种用法：`true` = 起进程、握手、拉清单（`list` 那一屏）；
   * 缺省 = **只在已经连着的时候白拿一份**（调用路径上的"名字对得上吗"那一跳用这个——
   * 一次工具调用不该因为多看一眼清单就多付一次冷启动）。
   *
   * `timeoutMs` **收下但不用**：握手与 tools/list 走连接自己的每请求软超时
   * （`McpConnection.effectiveRequestTimeoutMs`）。刻意不把它塞进去——冷启动是"起一个别人的进程"，
   * 用"一次 tools/call 多久算久"去卡它，只会把"起不来"误报成"超时"。参数留着是为了
   * 调用方不必按分支改形状（它同时服务 `callTool` 那条路）。
   *
   * `onSummary`（2026-10-09 加）：把"这份清单取全了没有"（页数 / 件数 / 有没有截断）交给调用方。
   * 用回调而不是改返回形状：`McpToolInfo[]` 是既有契约（多处消费），而"取全没有"只有入口那一屏要。
   */
  async listTools(
    serverName: string,
    options: {
      requireConnected?: boolean; timeoutMs?: number;
      onSummary?: (summary: McpToolsListSummary) => void;
      /** 这份清单是**从哪儿来的**（活连接 / 落盘缓存 / 都没有）——回执那句"旧不旧"靠它 */
      onSource?: (info: McpToolsSourceInfo) => void;
    } = {},
  ): Promise<McpToolInfo[]> {
    const entry = this.entries.get(serverName);
    if (entry === undefined) {
      throw new Error(`MCP server ${serverName} 不在配置里（mcp.servers[]）`);
    }
    if (entry.disabled === true) {
      throw new Error(`MCP server ${serverName} 在配置里被标为 disabled`);
    }

    const live = this.connections.get(serverName);
    if (live !== undefined && !live.hasExited && live.ready) {
      // 活连接优先：它是**最新**的那一份，缓存再好也只是"某一次的快照"
      options.onSummary?.(live.toolsListSummary);
      options.onSource?.({
        source: 'live', fetchedAtMs: live.toolsFetchedAtMs, ageMs: 0, cachePath: null,
        mayBeStale: false, backoff: this.backoffOf(serverName),
      });
      return [...live.tools];
    }

    if (options.requireConnected !== true) {
      /**
       * **缓存优先于"再起一次"**（2026-10-10，缺口 ①）。
       *
       * 这一档的语义是"**能白拿就白拿**"：调用路径上的"名字对得上吗"那一跳、以及入口
       * 第二层的"看一眼有哪些工具"都用它。以前这里直接 `return []`——那正是
       * "把没连上说成没有工具"的口子（`docs/multi-mcp-orchestration.md` §2.2 ①）。
       * 现在改成：有缓存就给缓存（**并如实标出来源**），没有才回空数组、
       * 由调用方决定要不要真起一次（`source: 'none'` 把这两种情形分开）。
       */
      const cached = this.readToolsCache(entry);
      if (cached !== null) {
        options.onSummary?.(cached.listSummary);
        options.onSource?.({
          source: 'cache',
          fetchedAtMs: cached.fetchedAtMs,
          ageMs: Math.max(0, this.nowFn() - cached.fetchedAtMs),
          cachePath: this.toolsCachePath(entry.name),
          mayBeStale: true,
          backoff: this.backoffOf(serverName),
        });
        return [...cached.tools];
      }
      // 既没连着也没有缓存：**这不是"它一件工具都没有"**，如实交回"没有清单来源"
      options.onSource?.({
        source: 'none', fetchedAtMs: null, ageMs: 0, cachePath: null,
        mayBeStale: false, backoff: this.backoffOf(serverName),
      });
      return [];
    }

    let conn: McpConnection;
    try {
      conn = await this.ensureReady(serverName);
    } catch (err) {
      // 与 `callTool` 同一句话（`startFailureText`）：起不来时她要看到的是
      // "哪个 server、检查什么、修好之后会怎样"，而不是一句裸的进程退出码
      throw new Error(this.startFailureText(serverName, err));
    }
    options.onSummary?.(conn.toolsListSummary);
    options.onSource?.({
      source: 'live', fetchedAtMs: conn.toolsFetchedAtMs, ageMs: 0, cachePath: null,
      mayBeStale: false, backoff: this.backoffOf(serverName),
    });
    return [...conn.tools];
  }

  /**
   * 调用一个 MCP 工具。**永不抛出**：所有失败都折算成给模型看的结果文本 +
   * 稳定的错误码（宿主据此判定，模型据此改道）。
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ToolHandlerResult> {
    const entry = this.entries.get(serverName);
    if (entry === undefined) {
      return errorResult(
        `MCP server ${serverName} 不在配置里（mcp.servers[]）：先确认名字拼写，或把它加进配置再重试。`,
        MCP_ERROR_CODES.notConfigured,
      );
    }
    if (entry.disabled === true) {
      return errorResult(
        `MCP server ${serverName} 在配置里被标为 disabled：要调用它请先在配置里启用。`,
        MCP_ERROR_CODES.disabled,
      );
    }

    // 池级在飞上限（背压）：超限**如实拒绝**，不排队（排队的死锁面见 `DEFAULT_MAX_IN_FLIGHT_PER_SERVER`）。
    // 计数放在这里而不是 `request()` 里：这里才是"一次完整的 MCP 动作"的边界
    //（起进程 + 握手 + 调用都算一件），而 `request` 只看见一条 JSON-RPC。
    if (this.inFlightTotal >= this.maxInFlight) {
      return errorResult(
        this.overloadText(serverName, 'pool', this.maxInFlight, this.inFlightTotal),
        MCP_ERROR_CODES.overloaded,
      );
    }

    this.inFlightTotal += 1;
    try {
      return await this.callToolInner(serverName, toolName, args, options);
    } finally {
      this.inFlightTotal -= 1;
    }
  }

  /** `callTool` 的主体（在池级在飞计数之内跑；拆出来只为了让计数一定配对） */
  private async callToolInner(
    serverName: string,
    toolName: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ToolHandlerResult> {
    let conn: McpConnection;
    try {
      conn = await this.ensureReady(serverName);
    } catch (err) {
      return errorResult(this.startFailureText(serverName, err), MCP_ERROR_CODES.spawnFailed);
    }

    const timeoutMs = options.timeoutMs ?? conn.effectiveRequestTimeoutMs(this.defaultRequestTimeoutMs);
    const argumentsValue = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
    try {
      const result = await conn.callToolInternal(toolName, argumentsValue, {
        timeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return await this.renderToolResult(conn, toolName, result);
    } catch (err) {
      return this.mapCallError(conn, toolName, err, timeoutMs);
    }
  }

  /**
   * 启动失败的**唯一措辞**（`callTool` 与 `listTools` 共用）。
   *
   * 为什么抽出来：披露式入口取清单走的是 `listTools`，它原来只把 `ensureReady` 抛出来的
   * 一句话往上带（"进程已退出（code=null）"），**丢掉了下面这句可操作的话**——
   * 而"哪个 server、哪一步失败、要不要重试"正是回执里最要紧的三件事。
   * 两处各写一遍必然漂移（工具那条路改了、清单那条路没改），所以只留一处。
   */
  private startFailureText(serverName: string, err: unknown): string {
    // 崩溃退避要一句**完全不同**的话：说"未能启动：<裸原因>"会让人以为这是一次新故障，
    // 而事实是"同一个故障、我刻意停手了、到点之前不会再试"。
    if (err instanceof McpBackoffError) {
      return `MCP server ${serverName} 刚刚连续启动失败 ${err.failures} 次（最近一次：${err.cause}），`
        + `现在在退避：约 ${Math.ceil(err.retryInMs / 1000)} 秒后（${formatClock(err.retryAtMs)}）才会再拉起它。`
        + '这不是新故障，是同一个故障——**改完再等**比反复重试有用：'
        + '先照上面那句检查 command/args/cwd/env 与它的 stderr；'
        + '`mcp.servers[]` 是启动参数，改完要重启进程才生效。';
    }
    return `MCP server ${serverName} 未能启动：${errorText(err)}。`
      + '检查 command/args 是否可执行、stderr 里有没有报错；修好后重试即可（调用会重新拉起它）。';
  }

  /**
   * 在飞上限那一句（**唯一措辞**：`McpOverloadedError` 的映射与池级闸口共用，两处不许各写一遍）。
   *
   * 三条都必须在里面：**谁满的**（哪个 server / 还是整池）、**这次没有发出去**
   * （不是失败、不是它坏了）、**怎么办**（稍后再试 / 调大哪一格）。
   */
  private overloadText(serverName: string, scope: 'server' | 'pool', limit: number, inFlight: number): string {
    const scopeText = scope === 'pool'
      ? `整池同时在飞的 MCP 调用已达上限 ${limit} 件（现在 ${inFlight} 件）`
      : `MCP server ${serverName} 同时在飞的调用已达上限 ${limit} 件`;
    const how = scope === 'pool'
      ? '等前面那几件跑完再试（多半是不同的 server 在一起跑）。'
      : `等它把手上这几件做完再试；若这是常态，就把这个 server 的 maxInFlight 调大`
        + '（`mcp.servers[]` 里那一格，改完要重启进程）。';
    return `${scopeText}：**这次调用没有发出去**——同时调用太多了，不是它坏了，也不是配置错了。${how}`;
  }

  /** 主动扫一次空闲回收（测试与宿主手动触发都走它；定时器只是它的调用者） */
  async reclaimIdle(): Promise<McpShutdownReport[]> {
    const reports: McpShutdownReport[] = [];
    const now = this.nowFn();
    for (const conn of [...this.connections.values()]) {
      if (conn.hasExited || conn.inFlight > 0) continue;
      if (now - conn.lastUsed < conn.effectiveIdleReclaimMs(this.defaultIdleReclaimMs)) continue;
      reports.push(...await this.reapOne(conn, 'idle-reclaim'));
    }
    return reports;
  }

  /** 宿主关停：停掉扫描定时器，按关机序列逐个收掉子进程 */
  async shutdown(): Promise<McpShutdownReport[]> {
    this.shuttingDown = true;
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    const reports: McpShutdownReport[] = [];
    for (const conn of [...this.connections.values()]) {
      reports.push(...await this.reapOne(conn, 'shutdown'));
    }
    this.connections.clear();
    return reports;
  }

  /**
   * 收一个连接，**收不掉也不许传染**（2026-10-10 加，B⑤ 核实出来的一个真缺口）。
   *
   * 修前的形状：`reclaimIdle` / `shutdown` 里直接 `await this.reap(...)`，一个连接在关机序列里
   * 抛了（进程句柄坏掉、注入的替身抛错、平台相关的 kill 异常），**循环就断在那里**——
   * 后面的 server 一个都不会被回收：空闲的那些继续占着内存，退出时留下一串孤儿进程。
   * 这与纪律 4「崩溃不传染」是同一个道理：一个 server 的问题不许扩到别的 server 上。
   *
   * 失败的连接**照样不出现在 reports 里**（那份报告是"已经停掉的"的凭据，不是"试过的"）——
   * 但日志里必须有一行说清是谁没停掉，否则"少了一个进程"就没人看得见。
   */
  private async reapOne(conn: McpConnection, reason: McpStopReason): Promise<McpShutdownReport[]> {
    try {
      return [await this.reap(conn, reason)];
    } catch (err) {
      this.logLine(
        `MCP server ${conn.serverName} 回收失败（${reason}）：${errorText(err)}`
        + '——已跳过它，继续回收其余 server（它可能留了一个孤儿进程，请人工确认）',
      );
      return [];
    }
  }

  /**
   * 按**名字**回收（`applyDeclarations` 用）：名字没连着就什么都不做。
   *
   * 为什么不复用 `reapOne`：它的第一个参数是 `McpConnection`，而"这个 server 现在有没有连接"
   * 恰好是调用方不该猜的那件事（热更路径上它可能从没被拉起过、也可能刚被空闲回收掉）。
   * 隔离纪律与 `reapOne` **完全一致**（那里是唯一实现，这里只做一次查表）。
   */
  private async reapOneByName(name: string, reason: McpStopReason): Promise<McpShutdownReport[]> {
    const conn = this.connections.get(name);
    if (conn === undefined) return [];
    return await this.reapOne(conn, reason);
  }

  // ── 连接建立 ──

  private async ensureReady(name: string): Promise<McpConnection> {
    const entry = this.entries.get(name);
    if (entry === undefined) throw new Error(`MCP server ${name} 未配置`);
    if (entry.disabled === true) throw new Error(`MCP server ${name} 已被禁用`);

    /**
     * **崩溃退避的唯一判点**（2026-10-10 加）。
     *
     * 为什么必须在**这里**：`ensureReady` 是"要那个进程活着"的唯一入口
     *（`callTool` / `listTools(requireConnected:true)` / `registerAll` 都经过它）。
     * 在各调用点各判一遍，迟早漏掉一条（今天已经有两条路）。
     *
     * 判在**起进程之前**：一个"起来就崩"的 server（配置错、token 过期）以前是
     * **每一次调用都付一次启动 + 一次崩溃**，且没有任何次数上限。
     */
    const backoff = this.backoffOf(name);
    if (backoff !== null) {
      const failure = this.failures.get(name);
      throw new McpBackoffError(
        name,
        failure?.count ?? 0,
        backoff.retryAtMs,
        backoff.retryInMs,
        failure?.lastCause ?? '（没有记下原因）',
      );
    }

    const live = this.connections.get(name);
    if (live !== undefined && live.ready) {
      live.touch();
      return live;
    }
    const inFlight = this.starting.get(name);
    if (inFlight !== undefined) {
      const conn = await inFlight;
      conn.touch();
      return conn;
    }
    const task = this.startConnection(entry);
    this.starting.set(name, task);
    try {
      const conn = await task;
      conn.touch();
      return conn;
    } finally {
      this.starting.delete(name);
    }
  }

  private async startConnection(entry: McpServerEntry): Promise<McpConnection> {
    const startedAtMs = this.nowFn();
    let process: McpProcess;
    try {
      process = this.spawnProcess(entry);
    } catch (err) {
      const failure = new Error(`进程未能启动（${entry.command}）：${errorText(err)}`);
      this.noteStartFailure(entry.name, failure);
      throw failure;
    }

    const conn = new McpConnection(entry, process, this);
    this.connections.set(entry.name, conn);
    process.onStdout((chunk) => conn.onStdoutChunk(chunk));
    process.onStderr((chunk) => conn.onStderrChunk(chunk));
    process.onExit((code, signal) => conn.onProcessExit(code, signal));

    try {
      await conn.handshake();
    } catch (err) {
      // 握手失败 = 这个进程不可用：按关机序列收掉，不留半开的连接
      await this.reap(conn, 'crashed').catch(() => undefined);
      // 在飞上限那一条**不算启动失败**：它答的是"我们问得太急"，不是"它起不来"。
      // 记进去会变成"因为并发高所以这个 server 被退避"——那是两件事被搅在一起。
      if (!(err instanceof McpOverloadedError)) this.noteStartFailure(entry.name, err);
      throw err;
    }

    const startMs = Math.max(0, this.nowFn() - startedAtMs);
    this.startCounts.set(entry.name, (this.startCounts.get(entry.name) ?? 0) + 1);
    // 成功了：记下"这一刻它是好的"——连续失败计数在**稳定运行满 `backoffResetMs`** 之后才清零
    // （K8s 那条"连续正常 10 分钟后重置"的同形：不立刻清零，是为了让"起来就崩"仍然累计，
    //   而一个真跑了一段时间才崩的 server 不该被算成连续失败）。
    this.lastStartOkAt.set(entry.name, this.nowFn());
    this.recordStat(entry.name, { startMs, inFlightPeak: conn.inFlightPeak });
    this.syncServerTools(conn);
    this.emitEvent('mcp/server-started', {
      name: entry.name,
      pid: process.pid ?? 0,
      tools: conn.tools.map((tool) => tool.name),
      // 详情一并带上（评审缺陷 ⑤）：观测面读不到池的注册表，"它给了什么"只有这一刻知道。
      // 描述原样给（不裁）：扩展页是人看的，与 `tools` 段那份 token 预算无关（事件是 internal）。
      toolDetails: conn.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
      startMs,
    });
    this.ensureSweeper();
    // 资源观测**异步**落（绝不拖慢启动这条同步路径）：事件自己一条，见 `McpServerResourceData`。
    this.sampleResourceAsync(entry.name, conn, startMs);
    return conn;
  }

  private ensureSweeper(): void {
    if (this.sweeper !== null || this.shuttingDown) return;
    // 扫描周期取回收窗口的 1/4（夹在 10ms..5s 之间）：窗口越短越要勤扫，但别扫成忙等
    const period = Math.max(10, Math.min(5_000, Math.floor(this.defaultIdleReclaimMs / 4)));
    this.sweeper = setInterval(() => {
      void this.reclaimIdle().catch((err) => {
        this.logLine(`MCP 空闲回收扫描异常：${errorText(err)}`);
      });
    }, period);
    // 不阻止进程退出：扫描器是维护性任务，不该成为"进程退不掉"的理由
    this.sweeper.unref?.();
  }

  // ── 崩溃退避（2026-10-10 加）──

  /**
   * 记一次**启动失败**（spawn 抛错 / 握手失败）。
   *
   * 口径（2026-10-10 定）：**只有"起不来"进这本账**。刻意**不**记的三类：
   *   · 在飞上限拒绝（`McpOverloadedError`）——那是"我们问得太急"，不是"它坏了"；
   *   · 被取消 / 超时驱动的回收——那是"它太慢"，退避只会让它更慢；
   *   · **起来之后才崩**（`onConnectionExit` / 协议违规）——它与"起不来"是两件事：
   *     前者已经有一条如实的事件与回执（`mcp/server-stopped{crashed}` + 那句"下次调用会自动
   *     重新拉起它"），把它也塞进退避会让**一次偶发崩溃**变成"接下来 10 秒连试都不试"。
   *     "起来就崩"那个形状仍然会被这本账抓住：它崩在握手窗口里（`tools/list` 也在窗口内），
   *     那条路走的是 `startConnection` 的 catch。
   */
  private noteStartFailure(name: string, err: unknown): void {
    const now = this.nowFn();
    const previous = this.failures.get(name);
    // 重置：上一次成功启动之后**稳定运行满 `backoffResetMs`** ⇒ 这一次失败算第一次
    //（K8s 的"连续正常 10 分钟后重置退避"同形；不这么做的话，一个跑了三天才崩一次的
    //  server 会因为很久以前的三次失败直接吃 300s 封顶）
    const lastOk = this.lastStartOkAt.get(name);
    const stable = lastOk !== undefined && now - lastOk >= this.backoffResetMs;
    const count = stable || previous === undefined ? 1 : previous.count + 1;
    const delay = Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** (count - 1));
    this.failures.set(name, { count, nextAllowedAtMs: now + delay, lastCause: errorText(err) });
    // 起不来 ⇒ 那份落盘清单**也不再代表现在**（判据见 `invalidateToolsCache` 的注释）
    this.invalidateToolsCache(name, `启动失败：${errorText(err)}`);
    this.logLine(
      `MCP server ${name} 连续启动失败第 ${count} 次：${errorText(err)}（退避 ${Math.round(delay / 1000)}s，`
      + `到 ${formatClock(now + delay)} 之前不再拉起它）`,
    );
  }

  /**
   * 这个 server 现在在不在退避窗口里（不在就是 null）——唯一判据，回执与 `ensureReady` 共用
   */
  private backoffOf(name: string): { failures: number; retryAtMs: number; retryInMs: number } | null {
    const failure = this.failures.get(name);
    if (failure === undefined) return null;
    const retryInMs = failure.nextAllowedAtMs - this.nowFn();
    if (retryInMs <= 0) return null;
    return { failures: failure.count, retryAtMs: failure.nextAllowedAtMs, retryInMs };
  }

  // ── 资源观测（2026-10-10 加；全部走 internal 事件，不进请求）──

  private recordStat(
    name: string,
    patch: Partial<{
      startMs: number | null; rssMb: number | null; rssSource: McpRssSource; rssProcesses: number | null;
      inFlightPeak: number; lastReclaimedAtMs: number | null; lastStopReason: McpStopReason | null;
    }>,
  ): void {
    const current = this.resourceStats.get(name) ?? {
      startMs: null, rssMb: null, rssSource: 'unavailable' as McpRssSource, rssProcesses: null,
      inFlightPeak: 0, lastReclaimedAtMs: null, lastStopReason: null,
    };
    this.resourceStats.set(name, { ...current, ...patch });
  }

  /**
   * 异步采一次 RSS 并落一条 `mcp/server-resource`。**绝不抛、绝不阻塞启动**：
   * 观测读不到就是 `unavailable`（与"0 MB"分得开），那不是一次故障。
   *
   * 采的是**整棵树**（`rssMb` = 启动器 + 真 server + conhost 那些子/孙进程的和），
   * 口径随 `rssSource` / `rssProcesses` 一起落库——见 `McpRssSource`。
   */
  private sampleResourceAsync(name: string, conn: McpConnection, startMs: number): void {
    const sampler = this.sampleRss;
    if (sampler === null) return;
    const pid = conn.pid;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return;
    const peak = conn.inFlightPeak;
    void (async () => {
      let sample: McpRssSample = { rssMb: null, source: 'unavailable' };
      try {
        sample = await sampler(pid);
      } catch {
        sample = { rssMb: null, source: 'unavailable' };
      }
      // 采样期间那个进程可能已经被回收了：那就**不落事件**（别把上一个进程的数贴到新连接上）
      if (this.connections.get(name) !== conn) return;
      const processes = sample.processes ?? null;
      this.recordStat(name, {
        rssMb: sample.rssMb, rssSource: sample.source, rssProcesses: processes, startMs,
      });
      this.emitEvent('mcp/server-resource', {
        name,
        pid,
        sampledAtMs: this.nowFn(),
        rssMb: sample.rssMb,
        rssSource: sample.source,
        rssProcesses: processes,
        startMs,
        inFlightPeak: peak,
      });
    })();
  }

  // ── 工具清单落盘缓存 ──

  /** 缓存文件路径（server 名已过 `MCP_NAME_PATTERN`：不可能带路径分隔符） */
  private toolsCachePath(name: string): string {
    return join(this.dataDir, MCP_TOOLS_CACHE_DIR, `${name}.json`);
  }

  /**
   * server 指纹：`command` / `args` / `cwd` / `env` 的 SHA-256。
   *
   * 抄的是 avelino/mcp 的"按 config 哈希失效"（见 `docs/multi-mcp-orchestration.md` §4）：
   * 配置变了 ⇒ 这份清单不再代表当前这个 server ⇒ 缓存作废、下次真连一次。
   * `env` 的键**排序**后参与哈希：同一份 env 的两种写法不该算出两个指纹。
   */
  private entryFingerprint(entry: McpServerEntry): string {
    const env = entry.env ?? {};
    const envPairs = Object.keys(env).sort().map((key) => [key, env[key]] as const);
    const canonical = JSON.stringify({
      command: entry.command,
      args: entry.args ?? [],
      cwd: entry.cwd ?? null,
      env: envPairs,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * 读一份可用的缓存（不可用就返回 null，**绝不抛**）。
   *
   * 返回 null 的五种情形都是"这份缓存不能代表现在"：总开关关了 / 这个 server 关了 /
   * 文件不在 / 读不动或不是合法 JSON / 形状与版本对不上 / **指纹变了**。
   * 缓存是**加速器**，任何一步不成立都只是"退化成真连一次"，不是错误。
   */
  private readToolsCache(entry: McpServerEntry): McpToolsCacheFile | null {
    if (!this.cacheEnabledFor(entry)) return null;
    if (!MCP_NAME_PATTERN.test(entry.name)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.toolsCachePath(entry.name), 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.logLine(`MCP server ${entry.name} 的工具清单缓存不是合法 JSON：按"没有缓存"处理（下次真连一次会覆盖它）`);
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record['version'] !== MCP_TOOLS_CACHE_VERSION) return null;
    if (record['server'] !== entry.name) return null;
    if (record['fingerprint'] !== this.entryFingerprint(entry)) {
      this.logLine(`MCP server ${entry.name} 的配置变了（command/args/cwd/env 指纹不同）：上次那份工具清单缓存已作废`);
      return null;
    }
    const fetchedAtMs = record['fetchedAtMs'];
    if (typeof fetchedAtMs !== 'number' || !Number.isFinite(fetchedAtMs)) return null;
    if (!Array.isArray(record['tools'])) return null;
    const tools: McpToolInfo[] = [];
    for (const item of record['tools']) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const tool = item as Record<string, unknown>;
      const name = tool['name'];
      // 缓存里的名字**照旧过一遍字符集**：文件是可以被人手改的，而"从缓存喂进去的名字"
      // 与"server 报上来的名字"在入口那边没有区别（回执直接摆出去）
      if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) continue;
      const info: McpToolInfo = { name };
      if (typeof tool['description'] === 'string') info.description = tool['description'];
      if (tool['inputSchema'] !== undefined) info.inputSchema = tool['inputSchema'];
      if (tool['outputSchema'] !== undefined) info.outputSchema = tool['outputSchema'];
      tools.push(info);
    }
    const summary = asRecord(record['listSummary']);
    const pages = typeof summary['pages'] === 'number' ? summary['pages'] : 1;
    const truncated = summary['truncated'] === true;
    const nextCursor = typeof summary['nextCursor'] === 'string' ? summary['nextCursor'] : null;
    return {
      version: MCP_TOOLS_CACHE_VERSION,
      server: entry.name,
      fingerprint: record['fingerprint'] as string,
      fetchedAtMs,
      fetchedAt: typeof record['fetchedAt'] === 'string' ? record['fetchedAt'] : new Date(fetchedAtMs).toISOString(),
      listSummary: { pages, tools: tools.length, truncated, nextCursor },
      tools,
    };
  }

  private cacheEnabledFor(entry: McpServerEntry): boolean {
    if (!this.toolsCacheEnabled) return false;
    return entry.toolsCache !== false;
  }

  /**
   * 落盘（`host.cacheTools` 的实现；2026-10-10 加）。**永不抛**：
   * 写不进去只是"下次还得真连一次"，不该让一次正常的清单刷新多出一句错误。
   */
  cacheTools(conn: McpConnection, tools: readonly McpToolInfo[], summary: McpToolsListSummary): void {
    const entry = conn.entry;
    if (!this.cacheEnabledFor(entry)) return;
    if (!MCP_NAME_PATTERN.test(entry.name)) return;
    const now = this.nowFn();
    const payload: McpToolsCacheFile = {
      version: MCP_TOOLS_CACHE_VERSION,
      server: entry.name,
      fingerprint: this.entryFingerprint(entry),
      fetchedAtMs: now,
      fetchedAt: new Date(now).toISOString(),
      listSummary: { ...summary },
      // 只留回执真要用的三样（名字 / 描述 / schema）：annotations 刻意不缓存——
      // 它只作参考提示，而缓存里少一样东西就少一样会过期的数据。
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      })),
    };
    try {
      mkdirSync(join(this.dataDir, MCP_TOOLS_CACHE_DIR), { recursive: true });
      const path = this.toolsCachePath(entry.name);
      writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (err) {
      this.logLine(`MCP server ${entry.name} 的工具清单缓存写不进去（不影响本次调用）：${errorText(err)}`);
    }
  }

  /**
   * 作废一份缓存（**唯一理由：这个 server 现在起不来了**）。
   *
   * 为什么"起不来"要连缓存一起废掉：缓存答的是"它有什么工具"，而它现在连进程都起不来——
   * 照旧供那份清单，等于把"它现在坏了"藏在一份看起来很正常的清单后面。
   * 删掉之后入口那一屏会如实说"还没起过 / 起不来"，而不是端出一份旧清单。
   */
  private invalidateToolsCache(name: string, why: string): void {
    const entry = this.entries.get(name);
    if (entry === undefined || !this.cacheEnabledFor(entry)) return;
    try {
      rmSync(this.toolsCachePath(name), { force: true });
      this.logLine(`MCP server ${name} 的工具清单缓存已作废（${why}）：下次会真连一次重新取`);
    } catch {
      // 删不掉不影响判定：读那一侧还有指纹与来源时间两道门
    }
  }

  // ── 工具注册 ──

  /** 把一个 server 的清单同步进注册表（新增注册、变更替换、消失卸载） */
  syncServerTools(conn: McpConnection): void {
    this.registeredByServer.set(conn.serverName, this.registerToolsOf(conn));
  }

  private registerToolsOf(conn: McpConnection): string[] {
    const registry = this.registryRef;
    const names: string[] = [];
    for (const info of conn.tools) {
      const def = this.buildToolDefinition(conn, info);
      if (def === null) continue;
      names.push(def.name);
      if (registry === undefined) continue;
      try {
        registry.register(def, { replace: true });
      } catch (err) {
        this.logLine(`MCP 工具 ${def.name} 注册失败：${errorText(err)}`);
      }
    }
    // 刷新后消失的工具必须卸载：清单是模型的输入，残留条目会让它去调一个不存在的工具
    const previous = this.registeredByServer.get(conn.serverName) ?? [];
    for (const name of previous) {
      if (names.includes(name)) continue;
      if (registry === undefined) continue;
      if (registry.unregister(name)) {
        this.logLine(`MCP server ${conn.serverName} 的工具 ${name} 已从注册表卸载（清单刷新后消失）`);
      }
    }
    return names;
  }

  /**
   * 由 MCP 清单构造我方工具定义。**annotation 只作参考**：
   * readOnlyHint 之类的自我声明不参与三属性判定（server 说只读，不等于崩溃后可以自动重试）。
   */
  private buildToolDefinition(conn: McpConnection, info: McpToolInfo): ToolDefinition | null {
    const entry = conn.entry;
    const name = mcpToolName(entry.name, info.name);
    if (name.length > MCP_TOOL_NAME_MAX_LENGTH) {
      this.logLine(
        `MCP 工具 ${name} 名字超长（${name.length} > ${MCP_TOOL_NAME_MAX_LENGTH}）：已跳过该工具`,
      );
      return null;
    }
    const attributes = resolveToolAttributes(entry, info.name, this.toolTimeoutMs);
    const rawDescription = info.description ?? `MCP server ${entry.name} 提供的工具 ${info.name}`;
    const def: ToolDefinition = {
      name,
      description: fitDescription(`${rawDescription}（MCP:${entry.name}）`),
      parameters: asSchema(info.inputSchema),
      executionMode: attributes.executionMode,
      // 不信任即默认关：未显式声明的 MCP 工具一律 destructive（design §4.19 纪律 1）
      sideEffect: attributes.sideEffect,
      timeoutMs: attributes.timeoutMs,
      handler: (args, ctx) => this.callTool(entry.name, info.name, args, { signal: ctx.signal }),
    };
    if (info.outputSchema !== undefined && typeof info.outputSchema === 'object' && info.outputSchema !== null) {
      def.outputSchema = asSchema(info.outputSchema);
    }
    return def;
  }

  // ── 结果渲染 ──

  private async renderToolResult(conn: McpConnection, toolName: string, result: unknown): Promise<ToolHandlerResult> {
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      return errorResult(
        `MCP 工具 ${toolName} 的返回不是对象（不符合规范）：原始值 ${clip(JSON.stringify(result) ?? 'undefined', 200)}`,
        MCP_ERROR_CODES.badContent,
      );
    }
    const record = result as Record<string, unknown>;
    const parts = Array.isArray(record['content']) ? record['content'] : [];
    let text = parts.map(renderContentPart).filter((part) => part !== '').join('\n\n');
    if (text === '' && record['structuredContent'] !== undefined) {
      text = safeJson(record['structuredContent']);
    }
    if (text === '') {
      text = record['isError'] === true
        ? '（MCP 工具报告失败，但没有给出内容）'
        : '（MCP 工具没有返回内容）';
    }

    // 大结果外置（design §4.12）：MCP 的 content[] 可能是一整篇文档，不能直接塞进上下文。
    // 上限（估算 21k token / 64 KiB 取小）与父循环**同一份**（blob-store 的默认值）。
    // 指针文案引 `blobPointerText`（唯一实现）——以前这里自己拼了一遍，改口径时两处必然漂移。
    const offloaded = await offloadIfLarge(text, {
      dataDir: this.dataDir,
      thresholdTokens: this.blobThresholdTokens,
      previewChars: this.blobPreviewChars,
    });
    const body = offloaded.contentRef === undefined
      ? offloaded.content
      : `${offloaded.content}\n${blobPointerText(offloaded.contentRef)}`;

    if (record['isError'] === true) {
      return errorResult(body, MCP_ERROR_CODES.toolError);
    }
    return okResult(body);
  }

  private mapCallError(conn: McpConnection, toolName: string, err: unknown, timeoutMs: number): ToolHandlerResult {
    const name = conn.serverName;
    if (err instanceof McpOverloadedError) {
      // 在飞上限：**这次调用没有发出去**（不是它坏了）。措辞与池级闸口共用一处
      return errorResult(this.overloadText(name, err.scope, err.limit, err.inFlight), MCP_ERROR_CODES.overloaded);
    }
    if (err instanceof McpRequestTimeoutError) {
      return errorResult(
        `MCP 工具 ${toolName}（server ${name}）${err.hardCap ? '撞到 progress 硬上限' : `超过 ${timeoutMs}ms 未返回`}：`
        + '已发出 notifications/cancelled，并在逾期的取消宽限后回收该 server 进程。'
        + '重试会重新拉起 server；若反复超时，请缩小参数范围或检查这个 server 自身的日志。',
        MCP_ERROR_CODES.timeout,
      );
    }
    if (err instanceof McpAbortedError) {
      return errorResult(
        `MCP 工具 ${toolName}（server ${name}）的调用被取消：已发出 notifications/cancelled，没有产出结论，需要时请重新发起。`,
        MCP_ERROR_CODES.aborted,
      );
    }
    if (err instanceof McpRpcError) {
      return errorResult(
        `MCP 工具 ${toolName}（server ${name}）返回 JSON-RPC 错误 ${err.code}：${err.message}`,
        MCP_ERROR_CODES.rpc,
      );
    }
    if (err instanceof McpProtocolError) {
      return errorResult(
        `MCP server ${name} 违反 stdio 纪律（${err.detail}）：该进程已被重启。`
        + 'server 的 stdout 只允许写合法 JSON-RPC，日志必须走 stderr。',
        MCP_ERROR_CODES.protocol,
      );
    }
    if (err instanceof McpServerExitedError) {
      return errorResult(
        `MCP server ${name} 的进程已退出（code=${err.code ?? 'null'}）：这次调用没有结论。`
        + '下次调用会自动重新拉起它；若反复退出，请看它的 stderr 日志。',
        MCP_ERROR_CODES.stopped,
      );
    }
    if (err instanceof McpServerStoppedError) {
      return errorResult(
        `MCP server ${name} 已停止（${err.reason}）：这次调用没有结论，重试会重新拉起它。`,
        MCP_ERROR_CODES.stopped,
      );
    }
    return errorResult(
      `MCP 工具 ${toolName}（server ${name}）调用失败：${errorText(err)}`,
      MCP_ERROR_CODES.rpc,
    );
  }

  // ── 协作面（McpConnectionHost）──

  now(): number {
    return this.nowFn();
  }

  log(line: string): void {
    this.logLine(line);
  }

  /** 收到 tools/list_changed：刷新清单（调用路径上不做重复 list，刷新只在这里发生） */
  onListChangedRefresh(conn: McpConnection): void {
    void conn.refreshTools().catch((err) => {
      this.logLine(`MCP server ${conn.serverName} 刷新工具清单失败：${errorText(err)}`);
    });
  }

  /** 连接异常退出（非主动关停）：从池里摘掉并如实上报 crashed */
  onConnectionExit(conn: McpConnection, code: number | null, signal: string | null): void {
    this.detach(conn);
    if (conn.shutdownStarted) return;
    if (!conn.markStopReported()) return;
    // **刻意不进退避账**：这是"起来之后崩"，不是"起不来"（判据见 `noteStartFailure`）。
    // 一次偶发崩溃不该让接下来 10 秒连试都不试——那会把"重试即可"变成"等一会儿再说"。
    this.emitEvent('mcp/server-stopped', { name: conn.serverName, reason: 'crashed' });
    this.logLine(
      `MCP server ${conn.serverName} 异常退出（code=${code ?? 'null'}，signal=${signal ?? 'null'}）后已从池中摘除：`
      + '下次调用会自动重新拉起它',
    );
  }

  /** stdout 协议违规：先让在途请求失败，再按关机序列重启这个进程（§4.19 纪律 3） */
  onProtocolViolation(conn: McpConnection, detail: string): void {
    this.logLine(
      `MCP server ${conn.serverName} 协议错误：${detail}。`
      + 'server 的 stdout 只允许写合法 JSON-RPC（日志走 stderr）；按纪律重启该进程。',
    );
    // 同上：协议违规是"坏了"，但它答的是"起来之后坏了"——重启由关机序列承担，
    // 不进"连续启动失败"那本账（那条账管的是"根本起不来"）
    void this.reap(conn, 'crashed').catch(() => undefined);
  }

  /**
   * 取消宽限：发出 cancelled 之后给 server 一点收敛时间。宽限内没有回应（也不退出）的连接
   * 判定失效——这就是"超时即杀"的落点：不配合取消的 server 不能留在池里继续接调用。
   */
  gracefulCancel(conn: McpConnection, requestId: number, reason: string): void {
    void this.runGracefulCancel(conn, requestId, reason);
  }

  private async runGracefulCancel(conn: McpConnection, requestId: number, reason: string): Promise<void> {
    // 一旦发出取消，这个连接就不再接新调用：它的时序已经不是"每个请求都有响应"的干净状态
    conn.markUnusable();
    const deadline = this.nowFn() + this.cancelGraceMs;
    for (;;) {
      if (conn.hasExited || conn.hasRespondedLate(requestId)) return;
      const remaining = deadline - this.nowFn();
      if (remaining <= 0) break;
      await sleep(Math.min(25, remaining));
    }
    if (conn.hasExited || conn.hasRespondedLate(requestId)) return;
    this.logLine(
      `MCP server ${conn.serverName} 在取消宽限 ${this.cancelGraceMs}ms 内既未回应 id ${requestId} 的取消也未退出`
      + `（${reason}）：判定该连接失效，按关机序列回收`,
    );
    await this.reap(conn, 'crashed').catch(() => undefined);
  }

  // ── 关机序列 ──

  /**
   * 从池里摘掉这个连接。**只在表里仍然是它时才删**：旧连接的关机序列可能还在跑，
   * 而期间同名的新连接已经建立（协议违规重启、超时回收后重试都走这条），
   * 无条件 delete 会把刚起来的新连接一起抹掉。
   */
  private detach(conn: McpConnection): void {
    if (this.connections.get(conn.serverName) === conn) {
      this.connections.delete(conn.serverName);
    }
  }

  /**
   * 官方关机序列（唯一一条关停路径）：
   * 关 stdin → 等待退出 → 超时 SIGTERM → 再等待 → 超时 SIGKILL。
   * 两级等待都可配；返回的 stages 是顺序事实，测试与排障直接断言它。
   */
  async reap(conn: McpConnection, reason: McpStopReason): Promise<McpShutdownReport> {
    const existing = conn.shutdownReport;
    if (existing !== null) return existing;

    const task = (async (): Promise<McpShutdownReport> => {
      const stages: McpShutdownStage[] = [];
      conn.beginShutdown(new McpServerStoppedError(conn.serverName, reason));

      conn.closeStdin();
      stages.push('stdin-closed');

      if (await conn.waitExit(this.shutdownStdinWaitMs)) {
        stages.push('exited');
      } else {
        conn.killProcess('SIGTERM');
        stages.push('sigterm');
        if (await conn.waitExit(this.shutdownTermWaitMs)) {
          stages.push('exited');
        } else {
          conn.killProcess('SIGKILL');
          stages.push('sigkill');
          if (await conn.waitExit(this.shutdownKillGraceMs)) stages.push('exited');
          else {
            this.logLine(
              `MCP server ${conn.serverName} 在 SIGKILL 之后仍未退出：可能免疫终止，请人工确认它有没有遗留副作用`,
            );
          }
        }
      }

      this.detach(conn);
      if (conn.markStopReported()) {
        /**
         * 回收事实一并带出四个数（2026-10-10 加）：活了多久、在飞峰值、最后采到的 RSS、
         * 以及**这一次回收的时刻**（就是这条事件的 `ts`，`mcpView` 折它做"最近一次回收时间"）。
         *
         * 为什么 `rssMb` 取"最近一次采样"而不是此刻现采：进程此刻正在退出，现采要往关机序列
         * 里塞一次读数（Windows 上是一个 `tasklist` 子进程）——为了一个观测量去拖慢关停不划算。
         * 口径如实写在字段注释里，读的人不会把它当成"回收瞬间的内存"。
         */
        const stat = this.resourceStats.get(conn.serverName);
        this.recordStat(conn.serverName, {
          lastReclaimedAtMs: this.nowFn(),
          lastStopReason: reason,
          inFlightPeak: conn.inFlightPeak,
          startMs: stat?.startMs ?? null,
        });
        this.emitEvent('mcp/server-stopped', {
          name: conn.serverName,
          reason,
          uptimeMs: Math.max(0, this.nowFn() - conn.startedAt),
          inFlightPeak: conn.inFlightPeak,
          rssMb: stat?.rssMb ?? null,
        });
      }
      return { name: conn.serverName, reason, stages };
    })();

    conn.attachShutdown(task);
    return task;
  }
}

// ──────────────────────────────── 纯函数辅助 ────────────────────────────────

/** 三属性解析：显式声明优先，其次 server 默认，最后是不信任的兜底 */
export function resolveToolAttributes(
  entry: McpServerEntry,
  toolName: string,
  defaultTimeoutMs: number,
): Required<McpToolAttributes> {
  const explicit = entry.tools?.[toolName] ?? entry.tools?.[mcpToolName(entry.name, toolName)] ?? {};
  const defaults = entry.toolDefaults ?? {};
  const merged: Required<McpToolAttributes> = {
    sideEffect: explicit.sideEffect ?? defaults.sideEffect ?? 'destructive',
    executionMode: explicit.executionMode ?? defaults.executionMode ?? 'exclusive',
    timeoutMs: explicit.timeoutMs ?? defaults.timeoutMs ?? defaultTimeoutMs,
  };
  if (merged.timeoutMs <= 0) merged.timeoutMs = defaultTimeoutMs;
  return merged;
}

function asSchema(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return Object.keys(record).length === 0 ? { type: 'object', properties: {} } : record;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 把 content[] 的一段渲染成给模型看的文本（图片/资源只给定位信息，不塞 base64） */
function renderContentPart(part: unknown): string {
  if (typeof part !== 'object' || part === null) return safeJson(part);
  const record = part as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : 'unknown';
  switch (type) {
    case 'text': {
      const text = record['text'];
      return typeof text === 'string' ? text : safeJson(record);
    }
    case 'image':
    case 'audio': {
      const mime = typeof record['mimeType'] === 'string' ? record['mimeType'] : 'unknown';
      const data = typeof record['data'] === 'string' ? record['data'].length : 0;
      return `[${type} 内容：mimeType=${mime}，base64 长度 ${data}（本版不落盘二进制）]`;
    }
    case 'resource': {
      const resource = asRecord(record['resource']);
      const uri = typeof resource['uri'] === 'string' ? resource['uri'] : 'unknown';
      const mime = typeof resource['mimeType'] === 'string' ? ` mimeType=${resource['mimeType']}` : '';
      const text = typeof resource['text'] === 'string' ? `\n${resource['text']}` : '';
      return `[内嵌资源：${uri}${mime}]${text}`;
    }
    case 'resource_link': {
      const uri = typeof record['uri'] === 'string' ? record['uri'] : 'unknown';
      return `[资源链接：${uri}]`;
    }
    default:
      return safeJson(record);
  }
}

/**
 * 默认的 RSS 采样器：量**这一棵进程树**的和（2026-10-10 第二版；第一版只量根进程那一个）。
 *
 * 为什么不是"直接读子进程的内存"：Node **没有**跨平台读别的进程 RSS 的 API
 *（`process.memoryUsage()` 只答自己）。所以要读就得走 OS。
 *
 * **为什么必须是一棵树**（第一版的实测缺陷）：启动器形态下真正吃内存的是它的子/孙进程，
 * 只量 `conn.pid` 会低报到危险的程度——本机实测 `uvx mcp-server-time` 根进程 **6.0 MB vs
 * 整棵树 124.7 MB（≈21×）**、`uv tool install` 出来的 shim **6.1 vs 74.9（≈12×）**；
 * 只有 `node <绝对路径>.js` 与原生 `.exe` 才是准的（差一个 conhost 的 8 MB）。
 * 一个"看起来很小"的数比没有观测更危险 ⇒ 改成按 `ParentProcessId` 建父子表、自根向下求和。
 *
 * 两条路与它们的**实测成本**（本机：Windows 10.0.26200 / node v22.19.0 / execFile 直读不经 shell）：
 *   · **Windows 整棵树**：`powershell.exe -NoProfile -NonInteractive -Command "Get-CimInstance
 *     -Query 'SELECT ProcessId,ParentProcessId,WorkingSetSize FROM Win32_Process' | …"`
 *     —— **实测中位数 ≈ 0.95 s**（3 次 1025/948/906 ms；同样三条命令的变体都在 0.9–1.1 s，
 *     PowerShell 自身的启动占大头）。对比第一版那条单进程 `tasklist`（实测 484/495/509/517/527 ms）
 *     只贵一倍，换来的是 12–21 倍的准确度 ⇒ **这个取舍是划算的**。附带一条：`pwsh` 7 反而更慢
 *     （1119/1148/1158 ms），而 `powershell.exe` 5.1 是每台 Windows 都有的 ⇒ 用它。
 *   · **其它平台整棵树**：`ps -Ao pid=,ppid=,rss=`（一次读全表再求和）。第一版在 Linux 上是
 *     读 `/proc/<pid>/status`（微秒级、但只有根进程）；换成 `ps` 多花几毫秒换整棵树。
 *     ⚠️ **本机是 Windows，Linux/macOS 这条 `ps` 路与下面 `/proc` 的降级路都没有在本机实测**
 *     （只有纯函数部分有测试；别把这里的量级当已验证的数）。
 *   · **降级路**（整棵树读不到：没有 PowerShell / CIM 被策略挡 / 超时 / 输出变了）：
 *     退回第一版的**单进程**读法（Windows `tasklist`、Linux `/proc`、其它 `ps`），
 *     并把 `source` 如实标成不带 `-tree` 的那一个 ⇒ 读的人分得出"这是整棵树"还是"只有根进程"。
 *
 * 三条纪律（第二版照旧）：
 *   ① **只读**：不改那个进程的任何东西，也不加信号；
 *   ② **失败就是 `unavailable`**（不是 0）：进程可能已经退出、平台可能没有那条命令、
 *      输出可能因为语言/区域而不同——答不出来就如实说答不出来；
 *   ③ **永不抛**：观测失败绝不该影响被观测的那条路。
 *
 * 还有一条硬纪律（成本那一段的结论）：**在启动路径之后异步落**（`sampleResourceAsync`），
 * 绝不阻塞握手、也绝不进任何一次调用的等待——Windows 上这笔开销是**秒级**的。
 *
 * **想彻底不要这笔开销**：环境变量 `IRMIA_MCP_RSS_SAMPLE=0`（命令行临时开关）或配置
 * `mcp.rssSample: false`（判据与优先级见 `resolveRssSampler`）。关掉之后那几格**如实留空**
 * （不是填 0），也不再有 `mcp/server-resource` 事件。
 */
export const defaultMcpRssSampler: McpRssSampler = createMcpRssSampler();

/**
 * 只量**根进程那一个**的采样器（第一版口径；今天两个用途）：
 *   ① `defaultMcpRssSampler` 在整棵树读不到时的降级路（`source` 会如实标成 `tasklist` / `proc` / `ps`）；
 *   ② 测试里的对照（"只有单进程形态时，两口径的差就是那一份 conhost"）。
 */
export const singleProcessMcpRssSampler: McpRssSampler = createMcpRssSampler({ singleProcessOnly: true });

/**
 * 造一个采样器。三格注入点只为**可测**存在（生产用缺省值）：
 *   · `platform`：让 Windows 上的测试也能走一遍"其它平台"那条分支；
 *   · `runCapture`：让"命令跑不通"（超时/没有 PowerShell）与"输出长什么样"都能确定性复现；
 *   · `readFile`：Linux `/proc` 那条降级路。
 */
export function createMcpRssSampler(options: {
  platform?: NodeJS.Platform;
  runCapture?: McpRssProbe['runCapture'];
  readFile?: McpRssProbe['readFile'];
  /** true = 只量根进程（见 `singleProcessMcpRssSampler`） */
  singleProcessOnly?: boolean;
} = {}): McpRssSampler {
  const probe: McpRssProbe = {
    platform: options.platform ?? process.platform,
    runCapture: options.runCapture ?? defaultRunCapture,
    readFile: options.readFile ?? ((path) => readFileSync(path, 'utf8')),
  };
  return async (pid: number): Promise<McpRssSample> => {
    if (!Number.isInteger(pid) || pid <= 0) return { rssMb: null, source: 'unavailable' };
    if (options.singleProcessOnly !== true) {
      const tree = await sampleTreeRss(pid, probe);
      if (tree !== null) return tree;
    }
    return sampleSingleProcessRss(pid, probe);
  };
}

/**
 * 池的 RSS 采样开关：三级优先（2026-10-10 加，第二版）。
 *
 * 优先级从高到低：
 *   ① `options.rssSampler`（**显式注入**：测试与"这条线自己决定"的宿主用；`null` = 硬关）；
 *   ② 环境变量 `IRMIA_MCP_RSS_SAMPLE`（命令行临时开关，**比配置优先**）；
 *   ③ 配置 `mcp.rssSample`（`options.rssSample`）；
 *   ④ 出厂缺省：**开**。
 *
 * 环境变量是**三态**：只有明写 `0/false/off/no`（关）或 `1/true/on/yes`（开）才算数，
 * 没写 / 写错值都是"没说" ⇒ 交给配置。这一条是刻意的：一个拼错的开关不该悄悄把观测关掉
 * （那是"我配了却不生效"的另一种形状），也不该把用户显式关掉的观测打开。
 */
export function rssSampleEnvOverride(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = (env['IRMIA_MCP_RSS_SAMPLE'] ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes') return true;
  return null;
}

/** 按三级优先算出这台机器这次到底采不采 RSS（判据见 `rssSampleEnvOverride` 的注释） */
export function resolveRssSampler(
  options: { rssSampler?: McpRssSampler | null; rssSample?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): McpRssSampler | null {
  if (options.rssSampler !== undefined) return options.rssSampler;
  const override = rssSampleEnvOverride(env);
  if (override !== null) return override ? defaultMcpRssSampler : null;
  if (options.rssSample === false) return null;
  return defaultMcpRssSampler;
}

/** 跑一条只读命令并把 stdout 收回来（不经过 shell；**短超时默认 2s**，失败即 reject，由调用方兜） */
function runCapture(command: string, args: readonly string[], timeoutMs = SINGLE_SAMPLE_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err !== null) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

/** 缺省的读数出口（函数声明：模块加载期 `createMcpRssSampler()` 就会取它，不能落在 TDZ 里） */
function defaultRunCapture(command: string, args: readonly string[], timeoutMs?: number): Promise<string> {
  return runCapture(command, args, timeoutMs ?? SINGLE_SAMPLE_TIMEOUT_MS);
}

/**
 * `tasklist /FO CSV` 一行的**最后一格**里的 KB 数。
 *
 * 为什么是"把非数字全部丢掉"而不是按逗号切：内存那一格是 `"46,616 K"`，而**千位分隔符跟着区域走**
 *（有的区域是 `46.616 K`）。两种写法的小数部分都只是分组符，丢掉之后剩下的数字**就是 KB**
 *（`tasklist` 只印整数 KB）。进程不存在时那一格是本地化的提示文本（没有数字）⇒ 返回 null。
 */
function lastCsvFieldKb(stdout: string): number | null {
  const line = stdout.split(/\r?\n/u).map((item) => item.trim()).find((item) => item !== '');
  if (line === undefined) return null;
  const fields = line.split('","');
  const last = (fields[fields.length - 1] ?? '').replace(/"/gu, '');
  const digits = last.replace(/[^0-9]/gu, '');
  if (digits === '') return null;
  const kb = Number.parseInt(digits, 10);
  return Number.isFinite(kb) && kb > 0 ? kb : null;
}

// ──────────────────────── 整棵进程树的 RSS（2026-10-10 第二版） ────────────────────────

/**
 * 采样时要用到的"外部世界"（三格都能注入：生产用缺省值，测试拿它把另一条分支走通）。
 *
 * 为什么做成一个结构而不是直接调 `execFile`/`readFileSync`：这台机器是 Windows，而 Linux /
 * macOS 那两条分支、以及"读数命令跑不通"的降级分支**在 Windows 上永远走不到**——
 * 有了注入点，它们至少能被确定性地走一遍（纯函数那部分更是哪个平台都能测）。
 */
export interface McpRssProbe {
  platform: NodeJS.Platform;
  /** 跑一条只读命令并收 stdout（缺省 `execFile` 直读、不经 shell） */
  runCapture: (command: string, args: readonly string[], timeoutMs?: number) => Promise<string>;
  /** 读一个文本文件（缺省 `readFileSync`；Linux `/proc` 那条降级路用它） */
  readFile: (path: string) => string;
}

/** 字节 → MB（`tasklist`/`ps` 给的是 KB，CIM 给的是字节） */
const MB_PER_BYTE = 1 / (1024 * 1024);
const KB_PER_MB = 1 / 1024;

/**
 * 单进程那条路的超时：2s（第一版就是它，`tasklist` 实测 0.5s，够）。
 *
 * 整棵树那条路单独给 5s：本机实测 ≈0.95s，但 PowerShell 在忙机器上会更慢——
 * **超时的后果只是降级**（退回只量根进程，`source` 如实标成 `tasklist`/`proc`/`ps`），
 * 不是"采不到"：观测宁可窄一点，也不该因为一次读数超时就整格留空。
 */
const SINGLE_SAMPLE_TIMEOUT_MS = 2_000;
const TREE_SAMPLE_TIMEOUT_MS = 5_000;

/**
 * Windows 整棵树：**一条命令**把 `pid / ppid / 工作集` 全要回来，父子表在 JS 里建。
 *
 * 三点取舍（都是量过之后定的）：
 *   · **WQL 只取三列**（`SELECT ProcessId,ParentProcessId,WorkingSetSize`）：本机实测与
 *     "取全表再插值"同档（948 vs 1000 ms），但少传一堆用不上的字段；
 *   · **`powershell.exe` 而不是 `pwsh`**：本机 pwsh 7 反而更慢（1119/1148/1158 vs 1025/948/906 ms），
 *     而 Windows PowerShell 5.1 每台 Windows 都有（`pwsh` 7 只是我们的外部依赖之一，可能没装）；
 *   · **`tasklist` 做不到这件事**：它不输出 `ParentProcessId`（CSV 七列里没有它），
 *     所以"按父子关系求和"必须走 CIM/WMI。`tasklist` 只留在降级那条路上量根进程。
 */
export const WINDOWS_TREE_RSS_COMMAND =
  'Get-CimInstance -Query "SELECT ProcessId,ParentProcessId,WorkingSetSize FROM Win32_Process"'
  + ' | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize)" }';

/** 其它平台整棵树：`ps -Ao pid=,ppid=,rss=`（`rss` 单位 KB；`pid=` 这种写法去掉表头） */
export const POSIX_TREE_RSS_ARGS: readonly string[] = ['-Ao', 'pid=,ppid=,rss='];

/** 父子表里的一行（`rssBytes` 已经归一成字节：CIM 本来就是字节，`ps` 的 KB 在这一层乘上去） */
export interface McpProcessRssRow {
  pid: number;
  ppid: number;
  rssBytes: number;
}

/** `pid,ppid,bytes` 三列表（`WINDOWS_TREE_RSS_COMMAND` 的输出）⇒ 行数组；坏行丢掉，绝不抛 */
export function parseCimProcessTable(stdout: string): McpProcessRssRow[] {
  const rows: McpProcessRssRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const parts = line.trim().split(',');
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0] ?? '', 10);
    const ppid = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const bytes = Number.parseInt(parts[2] ?? '', 10);
    rows.push({ pid, ppid, rssBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0 });
  }
  return rows;
}

/** `pid ppid rss(KB)` 三列表（`ps -Ao pid=,ppid=,rss=` 的输出）⇒ 行数组；坏行丢掉，绝不抛 */
export function parsePsProcessTable(stdout: string): McpProcessRssRow[] {
  const rows: McpProcessRssRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 3) continue;
    const pid = Number.parseInt(parts[0] ?? '', 10);
    const ppid = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const kb = Number.parseInt(parts[2] ?? '', 10);
    rows.push({ pid, ppid, rssBytes: Number.isFinite(kb) && kb > 0 ? kb * 1024 : 0 });
  }
  return rows;
}

/**
 * 自 `rootPid` 向下求**这一棵子树**的和（纯函数：哪个平台都能测）。
 *
 * 三条不能省的：
 *   · **只算子树**：别的进程（包括我们自己的宿主）不算进来——`ppid` 表里 root 的兄弟不该被加；
 *   · **防环**：`ppid` 表是外部数据，`A→B→A` 这种（或者自己指向自己）不能把循环变成死循环；
 *   · **root 不在表里 ⇒ null**：那说明这条读数没覆盖到它（进程已经退了 / 输出被截断），
 *     这时**别拿"0 个进程的和"冒充一个数**，让调用方降级或答 `unavailable`。
 */
export function sumProcessTree(
  rows: readonly McpProcessRssRow[],
  rootPid: number,
): { rssBytes: number; processes: number } | null {
  const children = new Map<number, McpProcessRssRow[]>();
  let root: McpProcessRssRow | null = null;
  for (const row of rows) {
    if (row.pid === rootPid) {
      if (root === null) root = row;
      continue;
    }
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row]);
    else siblings.push(row);
  }
  if (root === null) return null;
  const seen = new Set<number>([rootPid]);
  const stack: McpProcessRssRow[] = [root];
  let rssBytes = 0;
  let processes = 0;
  while (stack.length > 0) {
    const row = stack.pop();
    if (row === undefined) break;
    rssBytes += row.rssBytes;
    processes += 1;
    for (const child of children.get(row.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      stack.push(child);
    }
  }
  return { rssBytes, processes };
}

/** 整棵树那条路；**任何失败都返回 null**（由调用方降级到单进程口径），永不抛 */
async function sampleTreeRss(pid: number, probe: McpRssProbe): Promise<McpRssSample | null> {
  try {
    if (probe.platform === 'win32') {
      const stdout = await probe.runCapture(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TREE_RSS_COMMAND],
        TREE_SAMPLE_TIMEOUT_MS,
      );
      const sum = sumProcessTree(parseCimProcessTable(stdout), pid);
      return sum === null
        ? null
        : { rssMb: sum.rssBytes * MB_PER_BYTE, source: 'cim-tree', processes: sum.processes };
    }
    const stdout = await probe.runCapture('ps', POSIX_TREE_RSS_ARGS, TREE_SAMPLE_TIMEOUT_MS);
    const sum = sumProcessTree(parsePsProcessTable(stdout), pid);
    return sum === null
      ? null
      : { rssMb: sum.rssBytes * MB_PER_BYTE, source: 'ps-tree', processes: sum.processes };
  } catch {
    return null;
  }
}

/** 只量根进程那一个（第一版口径；也是整棵树读不到时的降级路），永不抛 */
async function sampleSingleProcessRss(pid: number, probe: McpRssProbe): Promise<McpRssSample> {
  try {
    if (probe.platform === 'linux') {
      const status = probe.readFile(`/proc/${pid}/status`);
      const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
      if (match === null) return { rssMb: null, source: 'unavailable' };
      return { rssMb: Number(match[1]) * KB_PER_MB, source: 'proc', processes: 1 };
    }
    if (probe.platform === 'win32') {
      const stdout = await probe.runCapture(
        'tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], SINGLE_SAMPLE_TIMEOUT_MS,
      );
      const kb = lastCsvFieldKb(stdout);
      return kb === null
        ? { rssMb: null, source: 'unavailable' }
        : { rssMb: kb * KB_PER_MB, source: 'tasklist', processes: 1 };
    }
    const stdout = await probe.runCapture(
      'ps', ['-o', 'rss=', '-p', String(pid)], SINGLE_SAMPLE_TIMEOUT_MS,
    );
    const kb = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(kb)
      ? { rssMb: kb * KB_PER_MB, source: 'ps', processes: 1 }
      : { rssMb: null, source: 'unavailable' };
  } catch {
    return { rssMb: null, source: 'unavailable' };
  }
}

function validateEntry(entry: McpServerEntry): string | null {  if (typeof entry.name !== 'string' || !MCP_NAME_PATTERN.test(entry.name)) {
    return `server 名 ${JSON.stringify(entry.name)} 不合法（只允许字母数字与 _-，长度 1-128）`;
  }
  if (typeof entry.command !== 'string' || entry.command.trim() === '') {
    return `server ${entry.name} 的 command 必须是非空字符串`;
  }
  if (entry.args !== undefined && !Array.isArray(entry.args)) {
    return `server ${entry.name} 的 args 必须是字符串数组`;
  }
  return null;
}

// ──────────────────────────────── 配置解析 ────────────────────────────────

function describeValue(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 解析 `mcp.servers[]`（design §4.19：`{ name, command, args }` 起，其余为可选）。
 * 与 config.ts 同一条纪律：类型不对就抛，绝不静默回退默认——
 * 手误静默成默认值，等于"配置看起来生效了但其实没生效"。
 *
 * **启动器那一层（2026-10-09 加）**：`command` / `args` / `env` 还要过
 * `checkStdioLauncher`（`src/mcp/launcher-guard.ts`：白名单 + 逐启动器禁内联执行 +
 * 控制字符 + env 形状，另有两个显式放行口）。
 * 为什么放在**这里**：这是**唯一一个所有入口都经过的口**（`config.ts` 的 `readMcpConfig`、
 * `web/server.ts` 的 `mcpView` 与 `mcp-test` 的内联声明都调它）⇒ 校验规则只有一份，
 * "界面上的校验"与"服务端的校验"不会变成两套；而且它**判在任何子进程被拉起之前**
 * （这条纪律抄自 AstrBot 的同名函数，见 `launcher-guard.ts` 的出处说明）。
 *
 * `extraLaunchers`（2026-10-10 加）是**配置里那一格放行口**（`mcp.extraLaunchers`）：
 * 缺省 `[]` = 只有默认表 + 环境变量放行口（与这一格存在之前**逐字相同**的行为）。
 * 调用方是 `config.ts` 的 `readMcpConfig`——它先把 `extraLaunchers` 读出来再解析 `servers[]`，
 * 于是"同一份文件里写的放行"当场对这个文件里的 server 生效（不必重启、也不必先设环境变量）。
 * 其它调用方（界面的内联声明 / `mcpView`）**不传它**：它们判的是"这份声明在**本进程**里
 * 能不能起"，而本进程生效的那份放行口由 `config.ts` 那条路管（两处各判一次必然漂移）。
 */
export function parseMcpServers(
  raw: unknown,
  where = 'mcp.servers',
  extraLaunchers: readonly string[] | undefined = undefined,
): McpServerEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new McpConfigError(`${where} 必须是数组，收到 ${describeValue(raw)}`, where);
  }
  const out: McpServerEntry[] = [];
  raw.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new McpConfigError(`${itemWhere} 必须是对象，收到 ${describeValue(item)}`, itemWhere);
    }
    const record = item as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || !MCP_NAME_PATTERN.test(name)) {
      throw new McpConfigError(
        `${itemWhere}.name 必须匹配 ^[A-Za-z0-9_-]{1,128}$（只允许字母、数字、- 与 _；这个名字调用时用得到），`
        + `收到 ${describeValue(name)}`,
        `${itemWhere}.name`,
      );
    }
    const command = record['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      throw new McpConfigError(`${itemWhere}.command 必须是非空字符串`, `${itemWhere}.command`);
    }
    const entry: McpServerEntry = { name, command };
    const args = record['args'];
    if (args !== undefined && args !== null) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
        throw new McpConfigError(`${itemWhere}.args 必须是字符串数组`, `${itemWhere}.args`);
      }
      entry.args = args as string[];
    }
    // 它是干什么的（2026-10-11 加）：**只认非空字符串**，其余形状当没写（老配置缺这一格照旧可用）。
    // 洗成一行（去控制字符、压空白）之后再存：这一格会逐字节进索引那段常驻文本，换行是唯一
    // 能破坏"一行一个 server"那个结构的字符（同 `mcp-entry.ts` 的 sanitizeToolField 第一条）。
    const desc = record['desc'];
    if (typeof desc === 'string' && desc.trim() !== '') entry.desc = sanitizeMcpDescText(desc);
    const cwd = record['cwd'];
    if (typeof cwd === 'string' && cwd !== '') entry.cwd = cwd;
    const env = record['env'];
    if (env !== undefined && env !== null) {
      if (typeof env !== 'object' || Array.isArray(env)) {
        throw new McpConfigError(`${itemWhere}.env 必须是字符串到字符串的对象`, `${itemWhere}.env`);
      }
      const envRecord: Record<string, string> = {};
      for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
        if (typeof value !== 'string') {
          throw new McpConfigError(`${itemWhere}.env.${key} 必须是字符串`, `${itemWhere}.env.${key}`);
        }
        envRecord[key] = value;
      }
      entry.env = envRecord;
    }
    if (record['disabled'] === true) entry.disabled = true;
    const requestTimeoutMs = record['requestTimeoutMs'];
    if (typeof requestTimeoutMs === 'number' && Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0) {
      entry.requestTimeoutMs = Math.trunc(requestTimeoutMs);
    }
    const idleReclaimMs = record['idleReclaimMs'];
    if (typeof idleReclaimMs === 'number' && Number.isFinite(idleReclaimMs) && idleReclaimMs > 0) {
      entry.idleReclaimMs = Math.trunc(idleReclaimMs);
    }
    // 在飞上限（2026-10-10 加）：正整数；写 0/负数/非数就当没写（**不静默改成 0**——
    // 那会让这个 server 一个请求都发不出去，而配置看起来是"生效了"）
    const maxInFlight = record['maxInFlight'];
    if (typeof maxInFlight === 'number' && Number.isInteger(maxInFlight) && maxInFlight > 0) {
      entry.maxInFlight = maxInFlight;
    }
    // 清单落盘缓存（2026-10-10 加）：只认布尔；其它形状当没写（默认开，见 `McpServerEntry.toolsCache`）
    if (record['toolsCache'] === false) entry.toolsCache = false;
    else if (record['toolsCache'] === true) entry.toolsCache = true;
    const toolDefaults = parseToolAttributes(record['toolDefaults'], `${itemWhere}.toolDefaults`);
    if (toolDefaults !== null) entry.toolDefaults = toolDefaults;
    const tools = record['tools'];
    if (tools !== undefined && tools !== null) {
      if (typeof tools !== 'object' || Array.isArray(tools)) {
        throw new McpConfigError(`${itemWhere}.tools 必须是"工具名 → 三属性"的对象`, `${itemWhere}.tools`);
      }
      const map: Record<string, McpToolAttributes> = {};
      for (const [tool, value] of Object.entries(tools as Record<string, unknown>)) {
        const parsed = parseToolAttributes(value, `${itemWhere}.tools.${tool}`);
        if (parsed !== null) map[tool] = parsed;
      }
      entry.tools = map;
    }
    // 启动器白名单（**判在任何子进程被拉起之前**）：理由与判据见 `launcher-guard.ts`。
    // 放在最后判：先让上面那些"类型不对"的错照旧按字段报出来（错误定位更准），
    // 形状对了之后才轮到"这个形状能不能起"。
    // 第四个参数 = 配置文件里那一格放行口（`mcp.extraLaunchers`，见本函数注释）；
    // 第五个参数不传 ⇒ 环境变量那格走 `process.env`（最高优先，行为与从前逐字相同）。
    const launcherProblem = checkStdioLauncher(command, entry.args, entry.env, process.env, extraLaunchers);
    if (launcherProblem !== null) {
      throw new McpConfigError(`${itemWhere}.command：${launcherProblem}`, `${itemWhere}.command`);
    }
    out.push(entry);
  });
  return out;
}

function parseToolAttributes(raw: unknown, where: string): McpToolAttributes | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpConfigError(`${where} 必须是对象`, where);
  }
  const record = raw as Record<string, unknown>;
  const attrs: McpToolAttributes = {};
  const sideEffect = record['sideEffect'];
  if (sideEffect !== undefined && sideEffect !== null) {
    if (sideEffect !== 'none' && sideEffect !== 'idempotent' && sideEffect !== 'destructive') {
      throw new McpConfigError(`${where}.sideEffect 只能是 none/idempotent/destructive`, `${where}.sideEffect`);
    }
    attrs.sideEffect = sideEffect;
  }
  const executionMode = record['executionMode'];
  if (executionMode !== undefined && executionMode !== null) {
    if (executionMode !== 'parallel' && executionMode !== 'exclusive') {
      throw new McpConfigError(`${where}.executionMode 只能是 parallel/exclusive`, `${where}.executionMode`);
    }
    attrs.executionMode = executionMode;
  }
  const timeoutMs = record['timeoutMs'];
  if (timeoutMs !== undefined && timeoutMs !== null) {
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new McpConfigError(`${where}.timeoutMs 必须是正整数毫秒`, `${where}.timeoutMs`);
    }
    attrs.timeoutMs = timeoutMs;
  }
  return attrs;
}
