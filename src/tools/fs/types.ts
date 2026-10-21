/**
 * Irmia Agent — 文件系工具包：本地类型与助手
 *
 * **契约不在这里**。ToolDefinition / ToolContext / ToolHandlerResult 的真相源是
 * `src/tools/types.ts`（docs/schema.md §10），registry.ts 亦然。本文件只做复出，
 * 绝不另行声明一份——两份同名契约迟早会漂移，而「工具的接口」只能有一个答案。
 *
 * 本文件只负责三件 fs 包自己的事：
 *   1. 复出上游契约（含错误码表与结果构造器），让包内模块只依赖一个入口；
 *   2. 声明本包的配置面（FsToolOptions）与可注入依赖（FsToolDeps）；
 *   3. 定义 fs 域的错误码——上游已有的直接复用其值，fs 特有的按同一风格（E_ 前缀）追加。
 */

import type { SideEffect } from '../../log/types.ts';
import type { TextEncoding } from '../../util/bytes-text.ts';
import {
  errorResult,
  okResult,
  TOOL_ERROR_CODES,
  type ToolContext,
  type ToolDefinition,
  type ToolExecutionMode,
  type ToolHandlerResult,
} from '../types.ts';

// ──────────────────────────────── 上游契约复出 ────────────────────────────────
// 用 `export type` + 值 re-export，类型身份与 tools/types.ts 完全同一，不是副本。

export type { SideEffect, ToolContext, ToolDefinition, ToolExecutionMode, ToolHandlerResult };
export { argsRecord, ToolArgumentError, TOOL_ERROR_CODES } from '../types.ts';

/** 注册表最小契约：只需要一个 register。ToolRegistry 结构上满足它 */
export interface ToolRegistryLike {
  register(tool: ToolDefinition): void;
}

// ──────────────────────────────── 本包配置 ────────────────────────────────

export interface FsToolOptions {
  /**
   * 数据目录绝对路径。省略时由 ctx.workspaceRoot 推导为 `<workspaceRoot>/data`
   * （schema §11 落盘目录）。
   */
  dataDir?: string;
  /**
   * 备份目录绝对路径。省略时优先 `~/.irmia/backups`，取不到 home 时退回
   * `<dataDir>/backups`。
   */
  backupDir?: string;
  /** 每个文件保留的备份份数，默认 10 */
  backupKeep?: number;
  /** ripgrep 可执行文件绝对路径；显式给 null 表示「强制走 fallback」（测试用） */
  ripgrepPath?: string | null;
  /** Everything es.exe 绝对路径；显式给 null 表示「强制走 fallback」（测试用） */
  everythingPath?: string | null;
  /** safe_read 单次返回的字节上限，默认 256 KiB */
  maxReadBytes?: number;
  /** safe_read 单次返回的行数上限，默认 2000 行 */
  maxReadLines?: number;
  /**
   * 写工具族的**单文件字节上限**，默认 20 MiB（`DEFAULT_MAX_EDIT_BYTES`）。
   *
   * 两道门同值：① 目标文件本身超过它 → 拒绝读取，绝不"读一部分写整篇"；
   * ② 这次要落盘的内容超过它 → 拒绝写入。调大它等于接受更大的单次编辑内存占用，
   * 所以只提供"显式调大"，默认值不随环境漂移。
   */
  maxEditBytes?: number;
  /** 递归扫描时跳过的目录名（rg/es 的 TS fallback 共用） */
  skipDirNames?: string[];
  /**
   * 只读区前缀（相对 ctx.workspaceRoot 的路径，如 'skills'）：写工具一律拒绝落在其中的路径。
   *
   * 语义是「模型可读、不可改」：技能目录（design.md §4.19 信任门）属于这类资产——
   * 模型必须能 safe_read 读 SKILL.md 正文（渐进披露第二层），但目录内容只能由人确认后变更。
   * 默认覆盖 skills/ 与 .agents/skills/。
   */
  readOnlyPrefixes?: readonly string[];
  /**
   * 每个只读区前缀 → **一句"那该走哪条路"**（相对前缀，键与前缀同字面量）。
   *
   * 为什么要有它：拒绝的语义是「这里不许这样写」，但**每个只读区各有各的正确通道**
   * ——技能目录只能由人确认后变更，人格资产走 `write_persona`（它记 `persona/updated`
   * 并留人格版本）。把这句写死在 fs 包里，等于让最底层的文件工具去知道 persona 是什么；
   * 交给装配层（`catalog.ts`）传进来，fs 包就只管"这个前缀不许写"这一件事。
   * 没给提示的前缀退回一句通用文案。
   */
  readOnlyHints?: Readonly<Record<string, string>>;
  /**
   * 受保护文件（**绝对路径**，如 `data/hooks.json`）：写工具一律拒绝覆盖。
   *
   * 与 readOnlyPrefixes 的分工：前者是「工作区内的只读资产」（技能目录，相对路径），
   * 后者是「防护自身的定义文件」——钩子配置定义的就是「谁能改我」，agent 能写它
   * 则整道防护形同虚设（design.md §4.19 第 5 条）。读不受限：配置本来就可读。
   */
  protectedPaths?: readonly string[];
}

// ──────────────────────────────── 可注入依赖 ────────────────────────────────

export interface ProcessResult {
  /** 退出码；进程未能启动时为 null */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 启动即失败（ENOENT 之类）或超时被杀 */
  failed: boolean;
  /** 超时被杀 */
  timedOut: boolean;
  /**
   * 这一次输出是**按什么编码解出来的**（可选：注入的替身可以不报）。
   *
   * 为什么必须带出来：`rg` / `es.exe` 的输出里可能有 GBK 文件内容（中文 Windows 的文本
   * 文件十有八九是 cp936）。解码成功时 `lossy` 为 false，回执一个字都不多说；一旦有损，
   * 调用方**必须**把"这份输出按 X 解、N 处无法映射"写进回执——不许装作没事。
   */
  decode?: { encoding: TextEncoding; replaced: number; lossy: boolean } | undefined;
}

export interface RunProcessOptions {
  timeoutMs: number;
  cwd?: string;
  signal?: AbortSignal;
  /** 传给子进程的额外环境变量 */
  env?: Record<string, string>;
}

export interface FsToolDeps {
  now(): Date;
  /** 运行外部命令并收集输出。实现必须保证：AbortSignal 触发或超时后杀掉进程树 */
  runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcessResult>;
  /** 用户主目录，用于定位 `~/.irmia/backups` */
  homeDir(): string;
}

// ──────────────────────────────── 错误码 ────────────────────────────────

/**
 * 给模型的错误消息必须具体、可操作（design.md §4.18 五原则第 5 条）；
 * 给宿主的错误码必须是稳定契约。上游已定义的码不做二次发明，直接引用其值。
 */
export const FS_ERROR_CODES = {
  // 复用 tools/types.ts 的既有码：宿主已能识别，不再新增同义词
  INVALID_ARGS: TOOL_ERROR_CODES.invalidArgs,
  PATH_DENIED: TOOL_ERROR_CODES.unsafePath,
  TOO_LARGE: TOOL_ERROR_CODES.tooLarge,
  WRITE_FAILED: TOOL_ERROR_CODES.writeFailed,
  ABORTED: TOOL_ERROR_CODES.aborted,
  // fs 域扩展：一律 E_ 前缀，与上游同风格，便于宿主按前缀归类
  NOT_FOUND: 'E_NOT_FOUND',
  NOT_A_FILE: 'E_NOT_A_FILE',
  NOT_A_DIRECTORY: 'E_NOT_A_DIRECTORY',
  BINARY_FILE: 'E_BINARY_FILE',
  /**
   * 目标文件已存在，而这次调用的语义是"新建"（`safe_write` 未给 `overwrite`）。
   *
   * 单独一个码而不是复用 INVALID_ARGS：这对宿主是**两件不同的事**——
   * "参数写错了"要模型改参数，"文件已存在"要模型**改主意**（去 safe_edit 改局部，
   * 或明确说"我就是要整体覆盖"）。宿主与观测侧按码分流才不会把后者当成一次调用失误。
   */
  FILE_EXISTS: 'E_FILE_EXISTS',
  AMBIGUOUS_MATCH: 'E_AMBIGUOUS_MATCH',
  NO_MATCH: 'E_NO_MATCH',
  SYNTAX_ERROR: 'E_SYNTAX_ERROR',
  NO_BACKUP: 'E_NO_BACKUP',
  ROLLBACK_FAILED: 'E_ROLLBACK_FAILED',
  SEARCH_FAILED: 'E_SEARCH_FAILED',
  IO_ERROR: 'E_IO_ERROR',
} as const;

export type FsErrorCode = (typeof FS_ERROR_CODES)[keyof typeof FS_ERROR_CODES];

// ──────────────────────────────── 结果构造 ────────────────────────────────

/** `errorResult(message, code)` 的 fs 侧便利包装：调用点按「先码后消息」书写，读起来更像契约 */
export function fail(code: FsErrorCode, message: string, additionalContext?: string[]): ToolHandlerResult {
  return errorResult(message, code, additionalContext);
}

export function ok(content: string, additionalContext?: string[]): ToolHandlerResult {
  return okResult(content, additionalContext);
}

/** 参数不是对象时的统一回复：模型传了字符串或 null 是最常见的工具调用失误 */
export function argsObject(args: unknown, _toolName: string): Record<string, unknown> | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

export function invalidArgs(toolName: string, detail: string): ToolHandlerResult {
  return fail(FS_ERROR_CODES.INVALID_ARGS, `${toolName}: 参数非法——${detail}`);
}

// ──────────────────────────────── 参数读取助手 ────────────────────────────────

export function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? value : null;
}

export function readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function readOptionalBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** 读一个整数参数；非法（非整数/越界）时返回错误说明 */
export function readOptionalInt(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): { value: number | undefined } | { error: string } {
  const raw = args[key];
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { error: `${key} 必须是整数` };
  if (raw < min || raw > max) return { error: `${key} 必须在 [${min}, ${max}] 之间，实际 ${raw}` };
  return { value: raw };
}

// ──────────────────────────────── 杂项 ────────────────────────────────

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 中断检查：工具契约要求每个耗时步骤都响应 signal（design.md §4.5） */
export function aborted(ctx: ToolContext): boolean {
  return ctx.signal.aborted;
}

export const ABORTED_RESULT: ToolHandlerResult = fail(FS_ERROR_CODES.ABORTED, '调用被中断，未继续执行。');
