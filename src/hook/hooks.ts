/**
 * Irmia Agent — Hook 执行点扩展（docs/design.md §4.19 Hook 段，里程碑 M7-5）
 *
 * 存在的理由：不写代码就能让**外部逻辑介入执行点**。三个点是循环内的收敛结论——
 * `PreToolUse`（工具执行前，可拒/可改写参数）、`PostToolUse`（工具执行后，可补上下文）、
 * `Wake`（唤醒到达时，可注入附加输入）。Claude Code 有 33 个钩子事件，核心就是这三类
 * （循环内两点 + 输入前一点），其余是特定时机，本模块与其对齐核心而非枚举全部。
 *
 * 协议照抄 Claude Code 实证语义（design §4.19 第 1-5 条），这些不是风格问题，是语义问题：
 *
 *   1. **退出码**：stdin 收 JSON 上下文；`0` = 成功无决定；`2` = 阻塞/拒绝（唯一强制通道）；
 *      **其他（含 1）= 非阻塞错误，主流程继续**。文档写死的陷阱就是 exit 1 不阻塞——
 *      想拒必须 exit 2。
 *   2. **超时丢弃输出且不阻塞**：钩子永远不能成为可用性瓶颈。超时即杀（含进程树），
 *      迟到的 stdout/退出码一律不看——"卡住的钩子当门禁"是官方点名的反模式。
 *   3. **匹配器带可选 `if` 入参过滤**（如 `pwsh(rm *)`）：不匹配就不 fork——
 *      每次调用都付一次进程启动开销是不可接受的。
 *   4. **输出通道**：`permissionDecision` / `updatedInput` / `additionalContext` /
 *      `systemMessage`；注入文本上限 10k 字符（超出的部分截断，不静默丢弃）。
 *   5. **防篡改**：无人值守没有 trust 对话框，钩子配置对 agent **只读**——它是"谁能改我"的
 *      定义，agent 能改它就等于没有任何门。路径白名单排除由 `protectedHookPaths()` 给出，
 *      写入口（fs 工具的 guardedWrite）据此拒绝。
 *
 * 两个绝不让步的性质：
 *   • **本模块永不抛**：超时、崩溃、非法 JSON、命令不存在、实现方违约——一律折算成"无决定"。
 *     调用方（executor / agent-loop）不需要 try/catch 就能安全使用它。
 *   • **决定必须落在日志里**：PreToolUse 的拒绝由执行器写 `policy/denied{rule:'hook'}`；
 *     每次执行点无论成败都写一条 `hook/fired`（internal）。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。本模块零外部依赖，只用 node: 标准库。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { killProcessTree } from '../process/kill-tree.ts';
import { decodeText, utf8ConsoleEnv } from '../util/bytes-text.ts';
import type { Projection } from '../log/types.js';
import type {
  ToolHookDecision, ToolHookRequest, ToolResultView,
} from '../tools/executor.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 配置文件在数据目录下的名字：`data/hooks.json`（对 agent 只读） */
export const HOOK_CONFIG_FILE_NAME = 'hooks.json';

/** 条目没写 timeoutMs 时的兜底（毫秒）。Claude Code 默认 600s 太长，无人值守场景要短 */
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

/** `additionalContext` / `systemMessage` 注入文本的字符上限（design §4.19 第 4 条） */
export const MAX_HOOK_CONTEXT_CHARS = 10_000;

/** 钩子 stdout/stderr 的收集上限：钩子不是输出通道，超过这个量说明它写错了 */
const MAX_HOOK_OUTPUT_CHARS = 1 << 20;

/** 拒绝理由/诊断行里的单段文本上限 */
const MAX_HOOK_REASON_CHARS = 2_000;

/** 三个执行点，顺序即文档顺序 */
export const HOOK_POINTS = ['PreToolUse', 'PostToolUse', 'Wake'] as const;

// ──────────────────────────────── 类型 ────────────────────────────────

export type HookPoint = (typeof HOOK_POINTS)[number];

/** 执行结果分类（与 `hook/fired.outcome` 同构，schema §7） */
export type HookOutcome = 'ok' | 'timeout' | 'error';

/** 一条钩子配置（`data/hooks.json` 的数组元素） */
export interface HookConfigEntry {
  /** 执行点 */
  hook: HookPoint;
  /**
   * 正则匹配串：PreToolUse / PostToolUse 对**工具名**，Wake 对**唤醒来源**
   * （timer / file / webhook / manual / heartbeat / intention / job）。
   * 非锚定匹配（`Edit|Write` 即正则本身）。
   */
  matcher: string;
  /**
   * 可选的入参过滤表达式：形如 `工具名(参数通配)` 或纯 `参数通配`（如 `rm *`）。
   * 不匹配就**不 fork 进程**（design §4.19 第 3 条）。工具名部分锚定全匹配，参数部分搜索式匹配。
   */
  if?: string;
  /** shell 命令串（与 Claude Code 的 command 同形：交给系统 shell 执行） */
  command: string;
  /** 单条超时（毫秒），超时即杀且丢弃输出 */
  timeoutMs: number;
  /** 可选的条目级工作目录；缺省沿用 runner */
  cwd?: string;
  /** 宿主附加的插件身份，仅用于故障归因 */
  plugin?: { id: string; contentHash: string; contributionName: string };
  /**
   * false = 保留这条配置但**不装配**（临时停用一条钩子不必把它的命令行删掉）。
   *
   * 为什么是"缺省即启用"而不是显式 `enabled: true`：`data/hooks.json` 最早是手写的，
   * 已有的那份文件里没有这个键；缺省即启用才能让老配置一个字节不动地继续生效。
   * 装配侧（HookRunner）据此过滤，见 main.ts。
   */
  enabled?: boolean;
}

export interface HookConfigLoadResult {
  entries: HookConfigEntry[];
  /** 被跳过的条目及原因：一条坏配置不该让整份配置失效，但也绝不能静默 */
  problems: string[];
  /** 配置文件是否存在 */
  exists: boolean;
}

/** `hook/fired` 的故障归因载荷；内置 Hook 不带插件字段 */
export interface HookFiredRecord {
  hook: HookPoint;
  outcome: HookOutcome;
  pluginId?: string;
  contentHash?: string;
  contributionName?: string;
}

/** 钩子看到的投影摘要：只给可序列化的事实，不给宿主内部对象 */
export interface ProjectionDigest {
  lastSeq: number;
  openTurn: { turn: number; step: number } | null;
  pendingCount: number;
  stepsThisTurn: number;
  tokensToday: number;
  todoOpen: number;
  failStreak: number;
  idleTicks: number;
  pressure: number;
  degraded: string | null;
}

/** 写进钩子 stdin 的 JSON 上下文 */
export interface HookPayload {
  hook: HookPoint;
  ts: string;
  cwd: string;
  projection: ProjectionDigest | null;
  callId?: string;
  tool?: string;
  input?: unknown;
  turn?: number;
  step?: number;
  wake?: { text: string; sources: string[] };
  result?: { status: string; isError: boolean; content: string; durationMs: number };
}

/** 钩子 stdout 的 JSON 输出（Claude Code 同款字段名） */
export interface HookDecisionPayload {
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
  systemMessage?: string;
}

/** Wake 点的注入结果 */
export interface HookInjection {
  /** 注入后续上下文的文本（已截断）；null = 没有注入 */
  context: string | null;
  /** 是否有钩子以 exit 2 强制（Wake 点：已发生的唤醒不能被撤销，这里只是如实标记） */
  blocked: boolean;
}

export interface WakeHookInput {
  /** 本次唤醒的渲染文本（与必要性门看到的同一份） */
  text: string;
  /** 唤醒来源（`wake/<source>` 的 source 部分） */
  sources: readonly string[];
  turn: number;
  step?: number;
}

// ──────────────────────────────── 子进程抽象 ────────────────────────────────

export interface HookTask {
  /** shell 命令串 */
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * 钩子子进程句柄。默认实现包 `node:child_process`；测试注入替身以确定性验证
 * 「超时丢弃输出」「if 不匹配不 fork」这些只能靠计数证明的性质。
 */
export interface HookProcess {
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  onClose(handler: (code: number | null) => void): void;
  write(data: string): void;
  endInput(): void;
  kill(): void;
}

export type HookSpawner = (task: HookTask) => HookProcess;

/**
 * 杀进程树（v28 起收口到 `src/process/kill-tree.ts`）：钩子可能自己拉子进程，
 * 只杀父进程会留下谁都管不到的孤儿——那条纪律的实现在那一处，这里只转发。
 */
function killHookTree(child: ChildProcess): void {
  killProcessTree(child, { forceTree: true });
}

/** 默认钩子 spawner：shell 执行命令串，stdin 一次性写入 JSON 后关闭 */
export const defaultHookSpawner: HookSpawner = (task) => {
  const child: ChildProcess = spawn(task.command, {
    cwd: task.cwd,
    shell: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 钩子的输出是要被判读的文本：让子进程按 UTF-8 写（见 util/bytes-text.ts）。
    // **不在这里合并 `process.env`**：`task.env` 默认就是 `process.env`（见 HookEngine 的
    // `options.env ?? process.env`），注入替身时那些用例要的是"只给这一份"。
    env: utf8ConsoleEnv(task.env),
  });

  const outHandlers: Array<(chunk: string) => void> = [];
  const errHandlers: Array<(chunk: string) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  let pending = '';
  let closed = false;

  // **收原始字节、在 close 时一次解码**（2026-10-18 收口）：钩子是用户自己的脚本，
  // 中文 Windows 上它往管道里写的很可能是 GBK（cp936）字节。原来的
  // `buf.toString('utf8')` 会在字节变字符串那一刻把非法字节换成 U+FFFD，之后再无补救；
  // 而且逐块解码还会把跨块的多字节字符切成两半。钩子本来就只是"跑完读输出"，
  // 攒字节再判一次是最简单也最准的做法（与 pwsh 的 BoundedText 同一思路）。
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  child.stdout?.on('data', (buf: Buffer) => {
    if (!closed) outChunks.push(buf);
  });
  child.stderr?.on('data', (buf: Buffer) => {
    if (!closed) errChunks.push(buf);
  });
  const settle = (code: number | null): void => {
    if (closed) return;
    closed = true;
    const out = decodeText(Buffer.concat(outChunks)).text;
    const err = decodeText(Buffer.concat(errChunks)).text;
    if (out !== '') for (const handler of outHandlers) handler(out);
    if (err !== '') for (const handler of errHandlers) handler(err);
    for (const handler of closeHandlers) handler(code);
  };
  child.once('close', settle);
  // 启动失败（命令不存在等）只有 error 没有 close：统一折算成「退出码未知」
  child.once('error', () => settle(null));

  return {
    onStdout(handler) {
      outHandlers.push(handler);
    },
    onStderr(handler) {
      errHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    write(data) {
      pending += data;
    },
    endInput() {
      try {
        child.stdin?.end(pending);
      } catch {
        // 管道已关：钩子不读 stdin 也能跑
      }
    },
    kill() {
      killHookTree(child);
    },
  };
};

// ──────────────────────────────── 配置 ────────────────────────────────

/** `data/hooks.json` 的绝对路径 */
export function hookConfigPath(dataDir: string): string {
  return join(dataDir, HOOK_CONFIG_FILE_NAME);
}

/**
 * 受保护路径（对 agent 只读）：钩子配置定义的是「谁能改我」，agent 能写它就等于没有门。
 * 交给 fs 工具的写入口（`FsToolOptions.protectedPaths`）拦死；读不受限。
 */
export function protectedHookPaths(dataDir: string): string[] {
  return [hookConfigPath(dataDir)];
}

/**
 * 解析钩子配置。顶层可以是数组，也可以是 `{ hooks: [...] }`（便于将来放进主配置段）。
 * 单条非法只跳过它自己并把原因记进 problems——一份配置里一条写错不该让整机失去全部钩子。
 */
export function parseHookConfig(raw: unknown): HookConfigLoadResult {
  const problems: string[] = [];
  const entries: HookConfigEntry[] = [];

  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['hooks']) ? raw['hooks'] : null;
  if (list === null) {
    return { entries, problems: ['钩子配置的顶层必须是数组，或 { "hooks": [...] }'], exists: true };
  }

  list.forEach((item, index) => {
    const parsed = parseHookEntry(item, index);
    if (typeof parsed === 'string') problems.push(parsed);
    else entries.push(parsed);
  });
  return { entries, problems, exists: true };
}

/** 读取并解析 `data/hooks.json`。文件不存在 = 没配钩子（正常态，不是错误） */
export function loadHookConfig(file: string): HookConfigLoadResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { entries: [], problems: [], exists: false };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      entries: [],
      problems: [`${file} 不是合法 JSON：${errorText(error)}；修好前一条钩子都不生效`],
      exists: true,
    };
  }
  return parseHookConfig(raw);
}

/**
 * 解析一条钩子条目（第 index 条，where 用 `hooks[N]` 定位）。返回配置对象或问题描述。
 *
 * **导出**给 web 层的 `hook-save` 复用：GUI 写进 `data/hooks.json` 的条目必须与装配侧
 * 过同一把尺子——两份校验迟早会漂移，而"界面写得进、启动时被跳过"是最难查的一类故障。
 */
export function parseHookEntry(item: unknown, index: number): HookConfigEntry | string {
  const where = `hooks[${index}]`;
  if (!isRecord(item)) return `${where} 不是对象`;
  const hook = item['hook'];
  if (typeof hook !== 'string' || !(HOOK_POINTS as readonly string[]).includes(hook)) {
    return `${where}.hook 只能是 PreToolUse / PostToolUse / Wake，收到 ${JSON.stringify(hook)}`;
  }
  const matcher = item['matcher'];
  if (typeof matcher !== 'string' || matcher === '') {
    return `${where}.matcher 不能为空（它是"要不要为这次调用付进程开销"的唯一开关）`;
  }
  try {
    new RegExp(matcher);
  } catch (error) {
    return `${where}.matcher 不是合法正则：${errorText(error)}`;
  }
  const command = item['command'];
  if (typeof command !== 'string' || command.trim() === '') {
    return `${where}.command 不能为空`;
  }
  const condition = item['if'];
  if (condition !== undefined && (typeof condition !== 'string' || condition.trim() === '')) {
    return `${where}.if 若给出必须是形如 "工具名(参数通配)" 的非空字符串`;
  }
  const timeout = item['timeoutMs'];
  let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
      return `${where}.timeoutMs 必须是正整数毫秒`;
    }
    timeoutMs = timeout;
  }

  const entry: HookConfigEntry = {
    hook: hook as HookPoint,
    matcher,
    command,
    timeoutMs,
  };
  if (typeof condition === 'string') entry.if = condition;
  if (item['cwd'] !== undefined) {
    if (typeof item['cwd'] !== 'string' || item['cwd'].trim() === '') return `${where}.cwd 必须是非空路径`;
    entry.cwd = item['cwd'];
  }
  // 只有显式 `false` 才算停用：缺省与 true 都是启用（老配置里没有这个键）
  if (item['enabled'] === false) entry.enabled = false;
  return entry;
}

// ──────────────────────────────── 入参过滤表达式 ────────────────────────────────

/** `if` 表达式的编译结果 */
export interface HookCondition {
  /** 工具名/来源的锚定 glob（null = 不限） */
  subject: RegExp | null;
  /** 入参文本的搜索式 glob（null = 不限） */
  arg: RegExp | null;
}

/** glob → 正则片段（`*` 跨一切字符，`?` 单字符，其余转义）——这里的"参数"不是路径 */
function globToPattern(glob: string): string {
  let out = '';
  for (const ch of glob) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** 解析 `工具名(参数通配)` 或纯 `参数通配`；返回 null 表示空表达式（视为不限） */
export function parseHookCondition(expression: string): HookCondition | null {
  const text = expression.trim();
  if (text === '') return null;
  const call = /^([^()\s]+)\s*\(([\s\S]*)\)$/.exec(text);
  if (call === null) return { subject: null, arg: new RegExp(globToPattern(text)) };
  const [, subject, arg] = call;
  return {
    subject: new RegExp(`^(?:${globToPattern(subject as string)})$`),
    arg: new RegExp(globToPattern((arg as string).trim())),
  };
}

/** 入参的可搜索文本：JSON 原文 + 全部字符串值（`rm *` 要能匹配 `{"command":"rm -rf x"}`） */
export function argSearchText(input: unknown): string {
  const parts: string[] = [];
  const serialized = JSON.stringify(input ?? null);
  if (typeof serialized === 'string') parts.push(serialized);
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (isRecord(value)) for (const item of Object.values(value)) walk(item, depth + 1);
  };
  walk(input, 0);
  return parts.join('\n');
}

/** 条件匹配：subject（工具名/唤醒来源）＋ arg（入参文本）两段都过才算命中 */
export function conditionMatches(condition: HookCondition | null, subject: string, argText: string): boolean {
  if (condition === null) return true;
  if (condition.subject !== null && !condition.subject.test(subject)) return false;
  if (condition.arg !== null && !condition.arg.test(argText)) return false;
  return true;
}

// ──────────────────────────────── 截断 ────────────────────────────────

/** 注入文本截断：超上限时截断并**明说**截了多少（静默截断会让人以为钩子什么都没说） */
export function clipHookContext(text: string, max = MAX_HOOK_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（钩子输出共 ${text.length} 字符，已按 ${max} 字符上限截断）`;
}

// ──────────────────────────────── 投影摘要 ────────────────────────────────

/** 从投影取一份可进 JSON 的摘要（钩子是外部进程，拿不到也不该拿到宿主的内部对象） */
export function digestProjection(projection: Projection): ProjectionDigest {
  return {
    lastSeq: projection.lastSeq,
    openTurn: projection.openTurn === null
      ? null
      : { turn: projection.openTurn.turn, step: projection.openTurn.step },
    pendingCount: projection.pending.length,
    stepsThisTurn: projection.budget.stepsThisTurn,
    tokensToday: projection.budget.tokensToday,
    todoOpen: projection.todoList.filter((item) => item.status !== 'completed').length,
    failStreak: projection.failStreak,
    idleTicks: projection.idleTicks,
    pressure: projection.pressure,
    degraded: projection.degraded === null ? null : projection.degraded.reason,
  };
}

// ──────────────────────────────── 运行器 ────────────────────────────────

export interface HookRunnerOptions {
  entries?: readonly HookConfigEntry[];
  /** 子进程工作目录，默认 process.cwd() */
  cwd?: string;
  /** 子进程环境，默认 process.env */
  env?: NodeJS.ProcessEnv;
  /** 起进程的方式，默认 defaultHookSpawner */
  spawn?: HookSpawner;
  /** `hook/fired` 的写入通道；不传即不记（CLI 只读场景） */
  emit?: (fired: HookFiredRecord) => void;
  /** 人可读诊断行；不传即静默 */
  onNote?: (text: string) => void;
  /** 投影摘要提供者：每次 fork 前现取（投影是活的，不缓存） */
  digest?: () => ProjectionDigest | null;
  /** 时钟注入（payload.ts 与诊断行用） */
  now?: () => Date;
}

/** 一条编译后的钩子：正则与条件只编译一次 */
interface CompiledHook {
  raw: HookConfigEntry;
  point: HookPoint;
  matcher: RegExp;
  condition: HookCondition | null;
  tag: string;
}

/** 一次子进程运行的原始结果 */
interface HookRunOutcome {
  outcome: HookOutcome;
  /** 退出码；null = 未能启动或被杀后未报码 */
  exitCode: number | null;
  decision: HookDecisionPayload | null;
  /** 供拒绝理由 / 注入用的文本（stdout 优先，其次 stderr） */
  text: string;
  note: string;
}

interface PointRun {
  compiled: CompiledHook;
  outcome: HookOutcome;
  exitCode: number | null;
  decision: HookDecisionPayload | null;
  text: string;
}

/**
 * HookRunner：三个执行点的统一实现。
 *
 * 结构上满足 `ToolCallHook`（executor 的挂点契约），所以装配方直接把它塞进
 * `ExecutionContext.hooks` 与 `AgentLoopDeps.hooks` 即可，不需要适配层。
 */
export class HookRunner {
  entries: readonly HookConfigEntry[];
  private compiled: CompiledHook[];
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawner: HookSpawner;
  private readonly emit: (fired: HookFiredRecord) => void;
  private readonly onNote: (text: string) => void;
  private readonly digest: () => ProjectionDigest | null;
  private readonly now: () => Date;

  constructor(options: HookRunnerOptions = {}) {
    this.entries = options.entries ?? [];
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.spawner = options.spawn ?? defaultHookSpawner;
    this.emit = options.emit ?? (() => undefined);
    this.onNote = options.onNote ?? (() => undefined);
    this.digest = options.digest ?? (() => null);
    this.now = options.now ?? (() => new Date());

    this.compiled = [];
    this.rebuild();
  }

  setEntries(entries: readonly HookConfigEntry[]): void {
    this.entries = entries;
    this.rebuild();
  }

  private rebuild(): void {
    this.compiled = [];
    this.entries.forEach((entry, index) => {
      try {
        this.compiled.push({
          raw: entry,
          point: entry.hook,
          matcher: new RegExp(entry.matcher),
          condition: entry.if === undefined ? null : parseHookCondition(entry.if),
          // 诊断标签：policy/denied.rule 恒为 'hook'（schema 枚举），这里只用于回给模型的文本
          tag: `${entry.hook}#${index}(${entry.matcher})`,
        });
      } catch {
        // 构造期已有的解析失败（loadHookConfig 会报 problem）在这里静默跳过，不影响其余钩子
      }
    });
  }

  /** 已装配的钩子条数 */
  get size(): number {
    return this.compiled.length;
  }

  /** 各执行点是否有钩子（用于装配期决定要不要留挂点） */
  has(point: HookPoint): boolean {
    return this.compiled.some((hook) => hook.point === point);
  }

  // ── PreToolUse ──

  /** 工具执行前判定（executor 的挂点；同步语义：执行器会 await 它的决定） */
  async beforeToolCall(request: ToolHookRequest): Promise<ToolHookDecision> {
    return this.runPreToolUse(request);
  }

  /** 语义化别名：与 `beforeToolCall` 同一实现 */
  async preToolUse(request: ToolHookRequest): Promise<ToolHookDecision> {
    return this.runPreToolUse(request);
  }

  private async runPreToolUse(request: ToolHookRequest): Promise<ToolHookDecision> {
    const matched = this.select('PreToolUse', request.tool, argSearchText(request.input));
    if (matched.length === 0) return { decision: 'allow' };

    const payload: HookPayload = {
      hook: 'PreToolUse',
      ts: this.now().toISOString(),
      cwd: this.cwd,
      projection: this.digest(),
      callId: request.callId,
      tool: request.tool,
      input: request.input,
      turn: request.turn,
      step: request.step,
    };

    const injections: string[] = [];
    let updatedInput: unknown;
    let hasUpdatedInput = false;

    for (const compiled of matched) {
      const run = await this.fire('PreToolUse', compiled, payload);
      if (run.outcome !== 'ok') continue; // 超时/错误：丢弃输出，主流程继续
      const decision = run.decision;

      // exit 2 = 阻塞/拒绝（唯一强制通道）；exit 1 之类不阻塞，已在 fire 里折算成 error
      if (run.exitCode === 2) {
        const reason = firstNonEmpty(run.text, decision?.permissionDecisionReason ?? '') ?? '钩子以退出码 2 拒绝';
        return deny(compiled.tag, reason);
      }
      if (decision === null) continue;
      if (decision.permissionDecision === 'deny') {
        const reason = firstNonEmpty(decision.permissionDecisionReason ?? '', run.text) ?? '钩子返回 permissionDecision=deny';
        return deny(compiled.tag, reason);
      }
      if (decision.updatedInput !== undefined) {
        updatedInput = decision.updatedInput;
        hasUpdatedInput = true;
      }
      collectText(injections, decision);
    }

    const result: ToolHookDecision = { decision: 'allow' };
    if (hasUpdatedInput) result.updatedInput = updatedInput;
    const context = clipHookContext(injections.join('\n\n'));
    if (context !== '') result.additionalContext = context;
    return result;
  }

  // ── PostToolUse ──

  /** 工具执行后补上下文（executor 的挂点）。工具已落地：这里的 deny 没有回滚含义 */
  async afterToolCall(request: ToolHookRequest, result: ToolResultView): Promise<ToolHookDecision> {
    return this.runPostToolUse(request, result);
  }

  /** 语义化别名：与 `afterToolCall` 同一实现 */
  async postToolUse(request: ToolHookRequest, result: ToolResultView): Promise<ToolHookDecision> {
    return this.runPostToolUse(request, result);
  }

  private async runPostToolUse(request: ToolHookRequest, result: ToolResultView): Promise<ToolHookDecision> {
    const matched = this.select('PostToolUse', request.tool, argSearchText(request.input));
    if (matched.length === 0) return { decision: 'allow' };

    const payload: HookPayload = {
      hook: 'PostToolUse',
      ts: this.now().toISOString(),
      cwd: this.cwd,
      projection: this.digest(),
      callId: request.callId,
      tool: request.tool,
      input: request.input,
      turn: request.turn,
      step: request.step,
      result: {
        status: result.status,
        isError: result.isError,
        // 结果正文不进钩子：钩子是来补上下文的，把全文再喂一遍等于把它当第二个模型用
        content: clip(result.content, MAX_HOOK_REASON_CHARS),
        durationMs: result.durationMs,
      },
    };

    const injections: string[] = [];
    for (const compiled of matched) {
      const run = await this.fire('PostToolUse', compiled, payload);
      if (run.outcome !== 'ok') continue;
      const decision = run.decision;
      if (run.exitCode === 2) {
        const text = firstNonEmpty(run.text, decision?.permissionDecisionReason ?? '');
        if (text !== null) injections.push(`[${compiled.tag} exit 2] ${text}`);
        continue;
      }
      if (decision === null) continue;
      collectText(injections, decision);
    }

    const context = clipHookContext(injections.join('\n\n'));
    return context === '' ? { decision: 'allow' } : { decision: 'allow', additionalContext: context };
  }

  // ── Wake ──

  /**
   * 唤醒时注入附加输入。语义：注入的文本既进必要性门（门要能看到它），
   * 也进本 turn 的尾部 developer 通道（agent-loop 负责落地）。
   * 已发生的唤醒撤不回来，所以这里的 exit 2 只如实标记 `blocked`。
   */
  async wake(input: WakeHookInput): Promise<HookInjection> {
    const matched = this.select('Wake', input.sources.length > 0 ? input.sources : ['manual'], input.text);
    if (matched.length === 0) return { context: null, blocked: false };

    const payload: HookPayload = {
      hook: 'Wake',
      ts: this.now().toISOString(),
      cwd: this.cwd,
      projection: this.digest(),
      wake: { text: input.text, sources: [...input.sources] },
      turn: input.turn,
    };
    if (input.step !== undefined) payload.step = input.step;

    const injections: string[] = [];
    let blocked = false;
    for (const compiled of matched) {
      const run = await this.fire('Wake', compiled, payload);
      if (run.outcome !== 'ok') continue;
      const decision = run.decision;
      if (run.exitCode === 2) {
        blocked = true;
        const text = firstNonEmpty(run.text, decision?.permissionDecisionReason ?? '');
        if (text !== null) injections.push(`[${compiled.tag} exit 2] ${text}`);
        continue;
      }
      if (decision === null) continue;
      collectText(injections, decision);
    }

    const context = clipHookContext(injections.join('\n\n'));
    return { context: context === '' ? null : context, blocked };
  }

  // ── 执行 ──

  /** 命中判断：matcher 对主体，`if` 对主体＋入参。全程零进程开销 */
  private select(point: HookPoint, subject: string | readonly string[], argText: string): CompiledHook[] {
    const subjects = typeof subject === 'string' ? [subject] : subject;
    const hit: CompiledHook[] = [];
    for (const compiled of this.compiled) {
      if (compiled.point !== point) continue;
      const matched = subjects.some((item) => {
        compiled.matcher.lastIndex = 0;
        return compiled.matcher.test(item) && conditionMatches(compiled.condition, item, argText);
      });
      if (matched) hit.push(compiled);
    }
    return hit;
  }

  /** 跑一条钩子并记 `hook/fired`。本方法**不抛**：所有故障都折算成 outcome */
  private async fire(point: HookPoint, compiled: CompiledHook, payload: HookPayload): Promise<PointRun> {
    const run = await this.runOne(compiled, payload);
    try {
      this.emit({ hook: point, outcome: run.outcome,
        ...(compiled.raw.plugin === undefined ? {} : {
          pluginId: compiled.raw.plugin.id, contentHash: compiled.raw.plugin.contentHash,
          contributionName: compiled.raw.plugin.contributionName,
        }) });
    } catch {
      // 事件通道故障不影响判定（它本身是观测）
    }
    if (run.note !== '') this.onNote(`[${compiled.tag}] ${run.note}`);
    return {
      compiled,
      outcome: run.outcome,
      exitCode: run.exitCode,
      decision: run.decision,
      text: run.text,
    };
  }

  /** 单条钩子的子进程生命周期：写 stdin → 等退出或超时 → 解析。超时即杀且丢弃输出 */
  private async runOne(compiled: CompiledHook, payload: HookPayload): Promise<HookRunOutcome> {
    let handle: HookProcess;
    try {
      handle = this.spawner({ command: compiled.raw.command, cwd: compiled.raw.cwd ?? this.cwd, env: this.env });
    } catch (error) {
      return {
        outcome: 'error',
        exitCode: null,
        decision: null,
        text: '',
        note: `钩子未能启动：${errorText(error)}（非阻塞，主流程继续）`,
      };
    }

    let stdout = '';
    let stderr = '';
    handle.onStdout((chunk) => {
      if (stdout.length < MAX_HOOK_OUTPUT_CHARS) stdout += chunk;
    });
    handle.onStderr((chunk) => {
      if (stderr.length < MAX_HOOK_OUTPUT_CHARS) stderr += chunk;
    });
    const exit = new Promise<{ code: number | null }>((resolve) => {
      handle.onClose((code) => resolve({ code }));
    });

    try {
      handle.write(`${JSON.stringify(payload)}\n`);
      handle.endInput();
    } catch {
      // stdin 写不进去：钩子若不读 stdin 仍可正常跑
    }

    const settled = await Promise.race([
      exit.then((value) => ({ kind: 'exit' as const, code: value.code })),
      sleep(compiled.raw.timeoutMs).then(() => ({ kind: 'timeout' as const, code: null as number | null })),
    ]);

    if (settled.kind === 'timeout') {
      try {
        handle.kill();
      } catch {
        // 已经退出
      }
      // 不等进程真的死：超时的那一刻输出就作废，等待等于把钩子的故障传染给主流程
      return {
        outcome: 'timeout',
        exitCode: null,
        decision: null,
        text: '',
        note: `超过 ${compiled.raw.timeoutMs}ms 未退出，已杀进程并丢弃输出（不阻塞主流程）`,
      };
    }

    const code = settled.code;
    const stdoutText = stdout.trim();
    const stdoutClipped = clip(stdoutText, MAX_HOOK_REASON_CHARS);
    // 退出码 2 的理由约定写在 stderr（Claude Code 同款）；没有 stderr 才退回 stdout 文本
    const stderrClipped = clip(stderr.trim(), MAX_HOOK_REASON_CHARS);
    const reasonText = firstNonEmpty(stderrClipped, stdoutClipped) ?? '';

    let decision: HookDecisionPayload | null = null;
    let parseProblem = '';
    if (stdoutText !== '') {
      const parsed = parseDecision(stdoutText);
      if (parsed.ok) decision = parsed.value;
      else parseProblem = parsed.message;
    }

    if (code === 0) {
      if (parseProblem !== '') {
        return {
          outcome: 'error',
          exitCode: code,
          decision: null,
          text: stdoutClipped,
          note: `stdout 不是合法 JSON 决定：${parseProblem}（非阻塞，输出已丢弃）`,
        };
      }
      return { outcome: 'ok', exitCode: code, decision, text: stdoutClipped, note: '' };
    }
    if (code === 2) {
      return { outcome: 'ok', exitCode: code, decision, text: reasonText, note: 'exit 2：阻塞/拒绝（唯一强制通道）' };
    }
    return {
      outcome: 'error',
      exitCode: code,
      decision: null,
      text: reasonText,
      note: `退出码 ${code === null ? 'null（未能启动或被杀）' : code}：非阻塞错误，主流程继续`,
    };
  }
}

// ──────────────────────────────── 纯函数助手 ────────────────────────────────

function deny(tag: string, reason: string): ToolHookDecision {
  return { decision: 'deny', rule: tag, reason: clip(reason.trim(), MAX_HOOK_REASON_CHARS) };
}

/** additionalContext 与 systemMessage 都是"钩子想说的话"：一起注入，system 带前缀以区分来源 */
function collectText(sink: string[], decision: HookDecisionPayload): void {
  if (typeof decision.additionalContext === 'string' && decision.additionalContext.trim() !== '') {
    sink.push(decision.additionalContext.trim());
  }
  if (typeof decision.systemMessage === 'string' && decision.systemMessage.trim() !== '') {
    sink.push(`[hook:system] ${decision.systemMessage.trim()}`);
  }
}

function firstNonEmpty(...values: string[]): string | null {
  for (const value of values) {
    if (value.trim() !== '') return value.trim();
  }
  return null;
}

function parseDecision(text: string): { ok: true; value: HookDecisionPayload } | { ok: false; message: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
  if (!isRecord(raw)) return { ok: false, message: '顶层不是 JSON 对象' };
  const decision: HookDecisionPayload = {};
  const permission = raw['permissionDecision'];
  if (permission !== undefined) {
    if (permission !== 'allow' && permission !== 'deny' && permission !== 'ask') {
      return { ok: false, message: 'permissionDecision 只能是 allow / deny / ask' };
    }
    decision.permissionDecision = permission;
  }
  if (typeof raw['permissionDecisionReason'] === 'string') {
    decision.permissionDecisionReason = raw['permissionDecisionReason'];
  }
  if (raw['updatedInput'] !== undefined) decision.updatedInput = raw['updatedInput'];
  if (typeof raw['additionalContext'] === 'string') decision.additionalContext = raw['additionalContext'];
  if (typeof raw['systemMessage'] === 'string') decision.systemMessage = raw['systemMessage'];
  return { ok: true, value: decision };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
