/**
 * Irmia Agent — 工具接口层（docs/schema.md §10 严格实现）
 *
 * 只有类型与少量纯函数，不含任何具体工具。这么切分是为了让每个工具文件只依赖接口，
 * 而不是依赖彼此：工具之间不允许互相 import 实现。
 *
 * 刻意不填 `outputSchema`：工具描述与 schema 每次请求都常驻上下文（design.md §4.18
 * 的 2k token 预算），而 DSR 的 Responses API 不消费该字段。字段留在接口里作文档位，
 * 具体工具按需填。
 */

import type { SideEffect } from '../log/types.js';

// ──────────────────────────────── 对外类型（与 schema §10 逐字对齐） ────────────────────────────────

/** 并发模式：parallel 可重叠；exclusive 单独成组，前后是屏障 */
export type ToolExecutionMode = 'parallel' | 'exclusive';

export interface ToolContext {
  callId: string;
  turn: number;
  step: number;
  /** 取消信号。工具必须响应：超时后仍在后台跑的 handler 会制造"日志说没成、现实成了"的假阴性 */
  signal: AbortSignal;
  /**
   * 「有人插话」计数读取器：她发言途中人又开口时，这个计数会加一。
   *
   * 与 `signal` 的分工：那个是"整台机器要停"（进程级，停了就什么都没了），
   * 这个是**只打断这一件事**——别再接着把那半截话说完，因为对方已经开口了。
   * 用**计数**而不是信号，是因为一轮里她可能说好几次话：重说一次要能正常说完，
   * 只有基准之后又来插话才再被打断（详见 real-loop 的 noteUserSpoke）。
   * 现在只有 `speak` 用它（它天然是"慢"工具，会在几十秒里一直占着人）。
   */
  interruptEpoch?: () => number;
  /**
   * 「有人插话」的销账口：**只在她真被打断时**调它，把打断她的那条唤醒（`userSpoke()` 给的
   * `wakeSeq`）补记进本轮的认领账。
   *
   * 为什么非记不可：那条唤醒是在 turn 进行中到的，从没进过本轮开头那一笔记账；
   * 她已经因为看见它而被打断了，账上不留痕，它就会留在待办队列里——
   * 下一轮被重新认领，同一个问题再答一遍（docs/review.md「未了结」）。
   * 账本仍由循环层写，工具只报告"我真被打断了"这个事实。
   */
  claimInterruption?: (wakeSeq: number) => void;
  /** 工作目录白名单根，文件工具必须用它做校验 */
  workspaceRoot: string;
  /**
   * 活动边界根（`config.trust.mode` 的执行形态）。**fs 工具族与 pwsh 的边界都只读它**：
   *
   *   • `undefined` = **保持历史行为**：拿 [workspaceRoot] 当边界。今天所有装配点与测试台都
   *     不传它，因此"默认仍然是受限的"这件事一个字都不用改，也不必靠自觉维护。
   *   • `null` = **不设边界**（`trust.mode: 'full'`，用户的原话"能够触碰整个电脑是默认行为"）：
   *     整台电脑上的文件都能读写、任意目录都能跑命令。
   *   • `string` = 用这个根当边界（`trust.mode: 'workspace'`）：越界的读写与命令**被拒绝**，
   *     且拒绝原因要说清"边界在哪、怎么改"。
   *
   * 它只关"**能在哪儿动**"，不关"**能改什么**"：只读区（`skills/`、`data/persona`）、受保护
   * 文件（钩子配置）、写前备份与回滚在两种模式下**行为一致**（那些判据各自有主，见
   * `fs/edit-core.ts` 的 guardedWrite）。
   *
   * 决议只有一处：`tools/boundary.ts` 的 `effectiveBoundaryRoot`。**不许**在任何工具里再写一遍
   * `ctx.boundaryRoot ?? ctx.workspaceRoot`——这条边界要么真的管住所有路径入口，要么就不该存在。
   */
  boundaryRoot?: string | null;
}

export interface ToolHandlerResult {
  content: string;
  isError?: boolean;
  error?: { message: string; code: string };
  /** 附加给模型但不属于结果的上下文 */
  additionalContext?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
  /** 可选：输出 schema（MCP 支持此字段；DS Responses 不消费，作文档与校验） */
  outputSchema?: Record<string, unknown>;
  executionMode: ToolExecutionMode;
  /** 副作用等级决定崩溃后能否重试，不是文档而是执行路径上的判断依据 */
  sideEffect: SideEffect;
  timeoutMs: number;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolHandlerResult>;
}

// ──────────────────────────────── 错误码 ────────────────────────────────

/**
 * 错误码是给宿主判定的稳定契约（映射 `tool/result.status`），消息是给模型看的。
 * 两者都要具体、可操作，不写"操作失败"这种没有下一步的信息。
 */
export const TOOL_ERROR_CODES = {
  invalidArgs: 'E_INVALID_ARGS',
  notConfigured: 'E_NOT_CONFIGURED',
  unsafePath: 'E_UNSAFE_PATH',
  protectedTarget: 'E_PROTECTED_TARGET',
  tooLarge: 'E_TOO_LARGE',
  writeFailed: 'E_WRITE_FAILED',
  denied: 'E_DENIED_COMMAND',
  destructiveDisabled: 'E_DESTRUCTIVE_DISABLED',
  noRuntime: 'E_NO_RUNTIME',
  timeout: 'E_TIMEOUT',
  aborted: 'E_ABORTED',
  spawnFailed: 'E_SPAWN_FAILED',
  sessionLost: 'E_SESSION_LOST',
} as const;

// ──────────────────────────────── 参数读取 ────────────────────────────────

/**
 * 参数错误独立成类：调用点只需一处 try/catch 就能把"模型的参数写错了"与
 * "工具执行失败"分开——前者是模型可以自己改的，后者不能。
 */
export class ToolArgumentError extends Error {
  readonly field: string;
  readonly code = TOOL_ERROR_CODES.invalidArgs;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ToolArgumentError';
    this.field = field;
  }
}

/** 把 arguments 文本/对象统一取成记录。非对象一律拒绝，避免在校验里散落类型判断 */
export function argsRecord(value: unknown, tool: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolArgumentError('arguments', `${tool} 的参数必须是一个 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

export interface StringArgOptions {
  maxLength?: number;
  /** 允许空串（默认不允许：空串几乎总是模型漏填，早报比晚崩好） */
  allowEmpty?: boolean;
}

function checkStringLength(field: string, text: string, maxLength: number | undefined): void {
  if (maxLength !== undefined && text.length > maxLength) {
    throw new ToolArgumentError(field, `${field} 过长（${text.length} 字符，上限 ${maxLength}）`);
  }
}

export function requiredString(
  source: Record<string, unknown>,
  field: string,
  options: StringArgOptions = {},
): string {
  const value = source[field];
  if (value === undefined || value === null) {
    throw new ToolArgumentError(field, `缺少必填参数 ${field}`);
  }
  if (typeof value !== 'string') {
    throw new ToolArgumentError(field, `${field} 必须是字符串，实际是 ${typeof value}`);
  }
  if (options.allowEmpty !== true && value === '') {
    throw new ToolArgumentError(field, `${field} 不得为空字符串`);
  }
  checkStringLength(field, value, options.maxLength);
  return value;
}

export function optionalString(
  source: Record<string, unknown>,
  field: string,
  options: StringArgOptions = {},
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ToolArgumentError(field, `${field} 必须是字符串，实际是 ${typeof value}`);
  }
  checkStringLength(field, value, options.maxLength);
  return value;
}

export function optionalBoolean(
  source: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  const value = source[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new ToolArgumentError(field, `${field} 必须是布尔值，实际是 ${typeof value}`);
  }
  return value;
}

export interface NumberArgOptions {
  min?: number;
  max?: number;
}

export function optionalInteger(
  source: Record<string, unknown>,
  field: string,
  fallback: number,
  options: NumberArgOptions = {},
): number {
  const value = source[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ToolArgumentError(field, `${field} 必须是整数，实际是 ${JSON.stringify(value)}`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new ToolArgumentError(field, `${field} 不得小于 ${options.min}，实际是 ${value}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new ToolArgumentError(field, `${field} 不得大于 ${options.max}，实际是 ${value}`);
  }
  return value;
}

// ──────────────────────────────── 结果构造 ────────────────────────────────

export function okResult(content: string, additionalContext?: readonly string[]): ToolHandlerResult {
  if (additionalContext === undefined || additionalContext.length === 0) return { content };
  return { content, additionalContext: [...additionalContext] };
}

export function errorResult(
  message: string,
  code: string,
  additionalContext?: readonly string[],
): ToolHandlerResult {
  const result: ToolHandlerResult = {
    content: message,
    isError: true,
    error: { message, code },
  };
  if (additionalContext !== undefined && additionalContext.length > 0) {
    result.additionalContext = [...additionalContext];
  }
  return result;
}

/** 异常 → 失败结果。参数错误与其它错误分开成码，宿主据此区分"模型改参数"与"环境故障" */
export function errorResultFromThrown(err: unknown, fallbackCode: string): ToolHandlerResult {
  if (err instanceof ToolArgumentError) return errorResult(err.message, err.code);
  const message = err instanceof Error ? err.message : String(err);
  return errorResult(message, fallbackCode);
}

// ──────────────────────────────── 文本工具 ────────────────────────────────

/** 单行摘要：去掉换行并压到 n 字符，用于把长内容安全地放进一行结果里 */
export function firstLine(text: string, maxLength = 120): string {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return line.length > maxLength ? `${line.slice(0, maxLength)}…` : line;
}
