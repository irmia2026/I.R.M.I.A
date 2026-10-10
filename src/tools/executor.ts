/**
 * Irmia Agent — 工具执行池（docs/design.md §4.5、docs/schema.md §4 / §10、docs/review.md 缺陷 1 与缺陷 6）
 *
 * 语义照搬 DSH 的 executeToolCalls，四个不可让步的点：
 * 1. **两阶段落库**：执行前先写 `tool/call` 拿 seq，执行后写 `tool/result` 引用那个 seq。
 *    两个写入都是承诺类（write + fsync 后才继续），否则会出现 review.md 缺陷 1 的
 *    「隐形执行」：副作用已经发生，日志里连 call 都没有。落库由调用方注入的回调完成。
 * 2. **只提交连续前缀**：第 3 个调用先干完也必须等 1、2 的结果都落库才提交。
 *    这样日志里工具顺序恒等于模型调用顺序，复盘不会错位。
 * 3. **exclusive 是屏障**：单独成组，前后不并发。用于有全局副作用、
 *    或结果会改变工具注册表的操作；`executionMode` 每次启动一组前重新读。
 * 4. **超时记为结果，不是崩溃**：写 `status: 'timeout'` 让循环继续跑。但执行体必须被杀/
 *    被丢弃——迟到的完成一律不落库，并记 `tool/zombie`（缺陷 6：不许制造「日志说没成、
 *    现实成了」的假阴性）。不响应信号的工作负载可以走子进程隔离，超时即杀进程树。
 * 5. **执行点钩子**（design §4.19）：PreToolUse 在**两阶段落库之前**跑——被拒绝的调用连
 *    `tool/call` 都不写（写进去等于「日志说她试过了」，那是伪造事实），改写后的参数才是
 *    落库与执行的那一份；PostToolUse 在结果产生之后跑，只能补上下文，改不了结果。
 *    钩子故障（超时/崩溃/输出非法）一律折算成「无决定」，不阻塞主流程。
 * 6. **计划模式门**（design §4.21）：与 PreToolUse 同层、同样在两阶段落库之前。destructive
 *    调用在 `tools.planMode` 开启时被拦下并落 `plan/pending` + `human/asked`，
 *    **没有 tool/call、没有 tool/result**；模型重发同一件调用（指纹相同）时凭批准许可放行。
 *
 * 并发度默认 4（不是 DSH 的 10）：本机场景下并发太高会把机器与外部接口打爆，也不利于排查。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import type { SideEffect, ToolResultStatus } from '../log/types.js';
import type { ListForModelOptions, ToolRegistry } from './registry.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from './types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 滚动池并发度（design §4.5） */
export const MAX_CONCURRENCY = 4;

/** kill 之后仍观察迟到输出的窗口（毫秒）：kill 与管道关闭之间到达的数据即迟到副作用迹象 */
export const DEFAULT_ZOMBIE_GRACE_MS = 100;

/** 隔离子进程输出截断：头 8k + 尾 2k（design §4.18 pwsh 输出纪律） */
const OUTPUT_HEAD_CHARS = 8000;
const OUTPUT_TAIL_CHARS = 2000;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 模型发起的一次工具调用。与 AssistantMessage.data.toolCalls 元素同形 */
export interface ToolCallRequest {
  callId: string;
  name: string;
  /** 原始 JSON 文本：解析失败也照原样落库（schema §4），这里不做任何预清洗 */
  arguments: string;
}

/** 执行终态 + 耗时，供调用方落 `tool/result`（status 与 durationMs 是事件的字段） */
export interface ToolExecutionResult extends ToolHandlerResult {
  status: ToolResultStatus;
  durationMs: number;
}

/** 一次调用的完整执行记录（按调用顺序返回，测试与观测直接可用） */
export interface ToolCallExecution {
  call: ToolCallRequest;
  /**
   * 对应 `tool/call` 事件的 seq；**0 表示本次调用没有落 tool/call**：
   * 要么被 PreToolUse 钩子拒绝（日志里只有 policy/denied），要么被计划模式拦下
   * （日志里只有 plan/pending + human/asked）。两种情况下都不写 tool/result。
   */
  callSeq: number;
  result: ToolExecutionResult;
}

/** 阶段一：先落 `tool/call` 并返回它的 seq。调用方负责 fsync（review.md 缺陷 1） */
export type ToolCallRecorder = (
  call: ToolCallRequest,
  def: ToolDefinition | null,
) => number | Promise<number>;

/** 阶段二：后落 `tool/result`，引用 callSeq。调用方按提交顺序串行收到 */
export type ToolResultRecorder = (
  call: ToolCallRequest,
  result: ToolExecutionResult,
  callSeq: number,
) => void | Promise<void>;

/** 迟到副作用迹象：写 `tool/zombie` 事件并告警（缺陷 6 / milestones M2-11） */
export type ToolZombieRecorder = (
  call: ToolCallRequest,
  note: string,
  callSeq: number,
) => void | Promise<void>;

// ──────────────────────────────── 执行点钩子（design §4.19 Hook） ────────────────────────────────
//
// 钩子是**外部逻辑介入执行点**的通道，因此它的接口只有两个方向：
//   • 进来的只有「这次调用是什么」（不含宿主内部状态）——钩子是外部进程，给它的是可序列化事实；
//   • 出去的只有「决定与附加文本」——钩子不能改结果、不能改日志形状、不能改执行顺序。
//
// 三条契约由实现方（src/hook/hooks.ts 的 HookRunner）保证，执行器只按接口调用：
//   1. **绝不抛**：钩子超时/崩溃/输出非法一律折算成"无决定"，主流程继续（§4.19 第 2 条）。
//   2. **PreToolUse 早于两阶段落库**：拒绝的调用连 `tool/call` 都不写（§4.19 第 5 条 / schema §4 不变量）。
//   3. **PostToolUse 只能补上下文**：工具已经执行，`deny` 在那里没有回滚含义，只取附加文本。

/** PreToolUse / PostToolUse 的入参：解析后的调用事实 */
export interface ToolHookRequest {
  callId: string;
  tool: string;
  /** 解析后的入参对象；解析失败时执行器不会调用钩子（无从匹配） */
  input: unknown;
  turn: number;
  step: number;
}

/** PostToolUse 看到的结果摘要（工具已执行，钩子改不了它） */
export interface ToolResultView {
  status: string;
  isError: boolean;
  content: string;
  durationMs: number;
}

/** 钩子决定。`deny` 只在 PreToolUse 有意义；`updatedInput` 只在 PreToolUse 被采纳 */
export interface ToolHookDecision {
  decision: 'allow' | 'deny';
  /** 拒绝理由：原样进 `policy/denied.reason` 与回给模型的文本 */
  reason?: string;
  /** 命中规则的诊断标签（`policy/denied.rule` 恒为 'hook'，这里只是给人看） */
  rule?: string;
  /** 改写后的入参：采纳后执行与 `tool/call` 落库都用它的 JSON 文本（日志必须与现实一致） */
  updatedInput?: unknown;
  /** 附加给后续上下文（已按上限截断）；经 onHookContext 交给调用方注入 */
  additionalContext?: string;
}

/**
 * 工具执行点钩子的最小契约。实现见 `src/hook/hooks.ts` 的 `HookRunner`。
 * 结构上兼容即可（本模块不 import 钩子模块，依赖方向保持「扩展依赖内核」）。
 */
export interface ToolCallHook {
  beforeToolCall(request: ToolHookRequest): Promise<ToolHookDecision>;
  afterToolCall?(request: ToolHookRequest, result: ToolResultView): Promise<ToolHookDecision>;
}

/** 钩子拒绝的落库通道：写 `policy/denied{rule:'hook'}`。不传则只记结果，不写事件。
 * `rule` 恒为 schema §7 枚举里的 `'hook'`——枚举里没有「第几条钩子」这一档，
 * 命中哪一条由实现并入 `reason`（否则落库的事件会被一个不在枚举里的值污染）。*/
export type PolicyDeniedRecorder = (
  call: ToolCallRequest,
  rule: string,
  reason: string,
) => void | Promise<void>;

/**
 * 钩子附加上下文回流：调用方负责把它注入后续上下文
 * （agent-loop 走与软阈值提示同款的尾部 developer 通道，§4.19 第 4 条）。
 */
export type HookContextSink = (text: string, point: 'PreToolUse' | 'PostToolUse') => void;

// ──────────────────────────────── 计划模式门（design §4.21） ────────────────────────────────
//
// 与钩子同层、同一条纪律：**两阶段落库之前**判定，被拦的调用不进日志的 tool/call。
// 区别在于职责：钩子是「外部规则说不」，计划模式门是「这件事还没拿到人的批准」。
// 接口刻意保持结构最小（本模块不 import plan-mode，依赖方向仍是「扩展依赖内核」）。

/** 计划模式门看到的一次调用事实 */
export interface PlanGateCall {
  callId: string;
  tool: string;
  /** 原始 arguments 文本：批准许可按「工具 + 规范化参数」的指纹匹配重发的调用 */
  arguments: string;
  turn: number;
  step: number;
  /** 工具声明的副作用等级；未注册的名字按 destructive 记账（与 tool/call 落库同一保守口径） */
  sideEffect: SideEffect;
}

/** 调用被拦时的回话（`content` 给模型，`code/message` 进执行记录的 error 字段） */
export interface ToolPlanDenial {
  content: string;
  code: string;
  message: string;
}

/**
 * 计划模式门。`intercept` 返回非 null 表示这次调用**没有执行**，而且实现必须已经把拦截
 * 事实写进日志（plan/pending + human/asked）——本模块不替它写，也不替它猜。
 */
export interface ToolPlanGate {
  intercept(call: PlanGateCall): ToolPlanDenial | null;
}

// ──────────────────────────────── 子进程隔离 ────────────────────────────────

/** 交给子进程执行的任务：命令 + 参数，stdin 默认喂入本次调用的 arguments 原文 */
export interface IsolatedTask {
  command: string;
  args: readonly string[];
  cwd?: string;
  stdin?: string;
}

/**
 * 子进程句柄抽象。默认实现包 `node:child_process`；测试可注入替身，
 * 用来确定性地验证「杀后迟到输出 → zombie」这条路径。
 */
export interface IsolatedProcess {
  readonly pid: number | undefined;
  /** 注册数据回调。kill 之后到达的数据同样会送到这里——那正是要观测的迟到输出 */
  onData(handler: (chunk: string, stream: 'stdout' | 'stderr') => void): void;
  /** 进程退出（含被信号终止）或启动失败（code 为 null） */
  onClose(handler: (code: number | null) => void): void;
  /** 立即终止：先杀直接子进程，Windows 上再用 taskkill 兜底杀进程树 */
  kill(): void;
}

export type IsolatedSpawner = (task: IsolatedTask) => IsolatedProcess;

export interface IsolationConfig {
  /** 返回非 null 表示该调用必须走子进程（不响应 AbortSignal 的工作负载） */
  resolve: (def: ToolDefinition | null, call: ToolCallRequest) => IsolatedTask | null;
  /** 起进程的方式，默认 defaultIsolatedSpawner */
  spawn?: IsolatedSpawner;
  /** kill 之后的迟到输出观察窗口，默认 DEFAULT_ZOMBIE_GRACE_MS */
  zombieGraceMs?: number;
}

// ──────────────────────────────── 批次上下文 ────────────────────────────────

export interface ExecutionContext {
  registry: ToolRegistry;
  turn: number;
  step: number;
  /** 工作目录白名单根，原样传给每个 ToolContext */
  workspaceRoot: string;
  /**
   * 活动边界根（`config.trust.mode` 的执行形态）：原样透传给每个 ToolContext 的 `boundaryRoot`。
   * `undefined` = 用 `workspaceRoot` 当边界（历史行为）；`null` = 不设边界；string = 只限该根。
   * 执行器**不解读**它——判读只有一处（`tools/boundary.ts`），这里只是搬运。
   */
  boundaryRoot?: string | null;
  /** 承诺类落库：tool/call */
  onToolCall: ToolCallRecorder;
  /** 承诺类落库：tool/result（按提交顺序串行调用） */
  onToolResult: ToolResultRecorder;
  onToolZombie?: ToolZombieRecorder;
  /** 外部取消（shutdown）。已取消则调用不派发；派发后到达则中止执行体并记 aborted */
  signal?: AbortSignal;
  /**
   * 「有人插话」计数读取器（turn 级）：人每开口一次加一，透传给工具的 `ctx.interruptEpoch`。
   * 与 `signal` 不同，它**不中止执行体、也不改结局**——只是让慢工具（speak）自己收手。
   */
  interruptEpoch?: () => number;
  /**
   * 「有人插话」的销账口（turn 级）：speak **只在她真被打断时**调它，把那条"她已经看见了"
   * 的唤醒补记进本轮的 `input/claimed`。账本由循环写，工具不碰日志——
   * 销账要挂在**当前这个 turn** 上，而 turn 号只有循环自己知道。
   */
  claimInterruption?: (wakeSeq: number) => void;
  /** 滚动池并发度，默认 MAX_CONCURRENCY */
  maxConcurrency?: number;
  /** 与模型清单一致的口径：未知工具回话时列的可用工具按它过滤 */
  modelVisibility?: ListForModelOptions;
  /** 子进程隔离配置；不传则全部在进程内执行 */
  isolation?: IsolationConfig;
  /** 执行点钩子（PreToolUse / PostToolUse，design §4.19）；不配即无钩子，行为与 M2 完全一致 */
  hooks?: ToolCallHook;
  /** 钩子拒绝的落库通道：写 `policy/denied{rule:'hook'}`（承诺类写入，失败即整批中止） */
  onPolicyDenied?: PolicyDeniedRecorder;
  /** 钩子附加文本的回流通道：调用方把它注入后续上下文 */
  onHookContext?: HookContextSink;
  /**
   * 计划模式门（design §4.21）：不配即无计划模式，行为与没这个机制时完全一致。
   * 配了但开关关着时由实现自己直通（判定权在实现，不在调用方）。
   */
  planGate?: ToolPlanGate;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

/**
 * 执行一批工具调用。返回值按**调用顺序**给出全部终态，调用方通常只看日志。
 *
 * 分组：每次启动一组前重新读 `executionMode`；parallel 组只吃「连续的 parallel 前缀」，
 * 碰到 exclusive 就停下让它单独成组——这样 exclusive 的前后天然是屏障（M2-5）。
 */
export async function executeToolCalls(
  calls: readonly ToolCallRequest[],
  ctx: ExecutionContext,
): Promise<ToolCallExecution[]> {
  const maxConcurrency = Math.max(1, Math.trunc(ctx.maxConcurrency ?? MAX_CONCURRENCY));
  const records: ToolCallExecution[] = [];
  let next = 0;

  while (next < calls.length) {
    const head = calls[next]!;
    const mode = ctx.registry.executionMode(head.name);
    const group = mode === 'parallel' ? takeParallelPrefix(calls, next, ctx.registry) : [head];
    const groupRecords = await runGroup(group, ctx, maxConcurrency);
    for (const record of groupRecords) records.push(record);
    next += group.length;
  }

  return records;
}

/**
 * 连续 parallel 前缀。逐个重读模式而不是把剩余调用一次切完：
 * 组内成员的模式也可能因为前一个成员改注册表而变化（schema §10）。
 */
function takeParallelPrefix(
  calls: readonly ToolCallRequest[],
  start: number,
  registry: ToolRegistry,
): ToolCallRequest[] {
  const group: ToolCallRequest[] = [];
  for (let i = start; i < calls.length; i++) {
    const call = calls[i]!;
    if (registry.executionMode(call.name) !== 'parallel') break;
    group.push(call);
  }
  return group.length > 0 ? group : [calls[start]!];
}

/**
 * 一组调用的滚动池：并发执行，按顺序提交。
 *
 * 两个串行链各自解决一个问题：
 * - `recordChain`：保证 `tool/call` 的落库顺序恒等于调用顺序，即使注入的 onToolCall 是异步的；
 * - `commitChain`：保证 `tool/result` 串行提交，且提交游标只在「连续前缀齐了」时才推进。
 */
async function runGroup(
  group: readonly ToolCallRequest[],
  ctx: ExecutionContext,
  maxConcurrency: number,
): Promise<ToolCallExecution[]> {
  const slots = new Array<ToolExecutionResult | undefined>(group.length);
  /** tool/call 的 seq。undefined = 本调用被 PreToolUse 拒绝，压根没有 tool/call（不参与提交链） */
  const callSeqs = new Array<number | undefined>(group.length);
  /** 钩子改写后的调用：落库与返回都以它为准（未改写时与 group[i] 同一个对象） */
  const effectiveCalls = new Array<ToolCallRequest | undefined>(group.length);
  const running = new Set<Promise<void>>();
  let started = 0;
  let committed = 0;
  let recordChain: Promise<void> = Promise.resolve();
  let commitChain: Promise<void> = Promise.resolve();
  // 放进对象里持有：闭包（在途任务的 rejection 回调）里赋值的裸 let 会被控制流分析收窄成 never
  const state: { failure: { error: unknown } | null } = { failure: null };

  const commitReady = async (): Promise<void> => {
    while (committed < group.length) {
      const call = effectiveCalls[committed] ?? group[committed]!;
      const result = slots[committed];
      // 连续前缀断在这里：后面的调用即使早就干完，也必须等这一位落库
      if (result === undefined) break;
      const callSeq = callSeqs[committed];
      // 被钩子拒绝的调用没有 tool/call，因而也没有 tool/result（日志里只有 policy/denied）：
      // 原位跳过，不打断前缀推进
      if (callSeq !== undefined) await ctx.onToolResult(call, result, callSeq);
      committed += 1;
    }
  };

  const pumpCommit = (): Promise<void> => {
    commitChain = commitChain.then(() => commitReady());
    return commitChain;
  };

  const startOne = (index: number): void => {
    const call = group[index]!;
    const task = (async (): Promise<void> => {
      // 阶段零：PreToolUse 钩子（design §4.19）。它必须在**两阶段落库之前**——
      // 被拒绝的调用连 tool/call 都不写（写进去就等于「日志说她试过了」，那是伪造事实），
      // 改写后的参数也必须先落定，否则 tool/call 记的是一份没执行过的参数。
      const gate = await applyPreToolUse(call, ctx);
      if (gate.kind === 'denied') {
        slots[index] = gate.result;
        return;
      }
      const effective = gate.call;
      effectiveCalls[index] = effective;
      // 计划模式门（design §4.21）：必须在写 tool/call **之前**——被拦的调用没有执行，
      // 写进去就是「日志说她试过了」；而且 tool/call 落库会消费批准许可，先写会把许可白花掉。
      // 这里不 catch：拦截落库失败（承诺类写入炸了）与钩子拒绝同性质，整批中止比默默放行安全。
      const planned = applyPlanGate(effective, ctx);
      if (planned !== null) {
        slots[index] = planned;
        return;
      }
      // 阶段一：tool/call 先落库并 fsync（由调用方保证），失败即整批中止
      const recorded = recordChain.then(() => ctx.onToolCall(effective, ctx.registry.get(effective.name)));
      recordChain = recorded.then(() => undefined, () => undefined);
      const callSeq = await recorded;
      callSeqs[index] = callSeq;
      // 阶段二：执行（可并发）
      const result = await executeOne(effective, callSeq, ctx);
      // 阶段三：PostToolUse 钩子：工具已落地，钩子只能补上下文，改不了结果
      slots[index] = await applyPostToolUse(effective, result, ctx);
    })();

    const done: Promise<void> = task.then(
      () => {
        running.delete(done);
      },
      (error: unknown) => {
        running.delete(done);
        state.failure ??= { error };
      },
    );
    running.add(done);
  };

  while (started < group.length || running.size > 0) {
    while (started < group.length && running.size < maxConcurrency) {
      startOne(started);
      started += 1;
    }
    if (running.size > 0) await Promise.race([...running]);
    await pumpCommit();
    // 落库回调（承诺类写入）失败 = 日志层故障：整批中止，不吞掉
    if (state.failure !== null) {
      await commitChain.catch(() => undefined);
      throw state.failure.error;
    }
  }
  await pumpCommit();

  const records: ToolCallExecution[] = [];
  for (let i = 0; i < group.length; i++) {
    // callSeq 为 0 = 本次调用被钩子拒绝（无 tool/call，日志里只有 policy/denied）
    records.push({
      call: effectiveCalls[i] ?? group[i]!,
      callSeq: callSeqs[i] ?? 0,
      result: slots[i]!,
    });
  }
  return records;
}

// ──────────────────────────────── 执行点钩子 ────────────────────────────────

/**
 * PreToolUse：两阶段落库之前的判定（design §4.19 第 1 / 4 条）。
 *
 * 三条分支：
 *   • 放行（未配钩子、参数不是合法 JSON、钩子无决定）→ 原样返回；
 *   • 拒绝 → 写 `policy/denied{rule:'hook'}`，本次调用**没有** tool/call，也没有 tool/result；
 *   • 改写参数 → 后续执行与落库都用改写后的 JSON 文本（日志与现实必须一致）。
 *
 * 钩子故障（超时、崩溃、输出非法、实现违背契约抛错）一律折算成放行：钩子永远不能成为
 * 可用性瓶颈（§4.19 第 2 条），这条 catch 是它的最后一道落实。
 */
async function applyPreToolUse(
  call: ToolCallRequest,
  ctx: ExecutionContext,
): Promise<{ kind: 'allow'; call: ToolCallRequest } | { kind: 'denied'; result: ToolExecutionResult }> {
  const hook = ctx.hooks;
  if (hook === undefined) return { kind: 'allow', call };

  const startedAt = Date.now();
  // 参数不是合法 JSON 时钩子无从匹配（`if` 是入参过滤器）：交给执行体回可读错误，不拦在这里
  const parsed = parseArguments(call.arguments);
  if (!parsed.ok) return { kind: 'allow', call };

  let decision: ToolHookDecision;
  try {
    decision = await hook.beforeToolCall({
      callId: call.callId,
      tool: call.name,
      input: parsed.value,
      turn: ctx.turn,
      step: ctx.step,
    });
  } catch {
    return { kind: 'allow', call };
  }

  if (decision.additionalContext !== undefined && ctx.onHookContext !== undefined) {
    ctx.onHookContext(decision.additionalContext, 'PreToolUse');
  }

  if (decision.decision === 'deny') {
    const tag = decision.rule ?? 'hook';
    // rule 恒为 'hook'（schema §7 枚举）：命中哪一条钩子并入 reason，输出契约只认枚举值
    const detail = denyReason(tag, decision.reason ?? '钩子没有给出理由');
    // 承诺类落库：失败必须外抛（吞掉就等于「拒绝发生了但日志里没有」，与缺陷 1 同性质）
    await ctx.onPolicyDenied?.(call, 'hook', detail);
    return { kind: 'denied', result: deniedResult(call, tag, detail, Date.now() - startedAt) };
  }

  if (decision.updatedInput !== undefined) {
    const text = JSON.stringify(decision.updatedInput);
    if (typeof text === 'string') {
      return { kind: 'allow', call: { callId: call.callId, name: call.name, arguments: text } };
    }
  }
  return { kind: 'allow', call };
}

/**
 * PostToolUse：工具已执行，钩子只能补上下文（§4.19 第 4 条）。
 * 结果原样返回——`deny` 在这里没有回滚含义，采纳它才是伪造事实。
 */
async function applyPostToolUse(
  call: ToolCallRequest,
  result: ToolExecutionResult,
  ctx: ExecutionContext,
): Promise<ToolExecutionResult> {
  const hooks = ctx.hooks;
  // 必须保持方法调用形式（不能把 afterToolCall 取出来单独调）：实现是带 this 的类实例，
  // 解构调用会在钩子内部炸出 TypeError，而下面那个 catch 会让它变成一次静默的"没生效"。
  if (hooks === undefined || hooks.afterToolCall === undefined) return result;

  try {
    const parsed = parseArguments(call.arguments);
    const decision = await hooks.afterToolCall(
      {
        callId: call.callId,
        tool: call.name,
        input: parsed.ok ? parsed.value : null,
        turn: ctx.turn,
        step: ctx.step,
      },
      {
        status: result.status,
        isError: result.isError === true,
        content: result.content,
        durationMs: result.durationMs,
      },
    );
    if (decision.additionalContext !== undefined && ctx.onHookContext !== undefined) {
      ctx.onHookContext(decision.additionalContext, 'PostToolUse');
    }
  } catch {
    // 钩子故障吞掉：结果已经产生，钩子不能反过来影响它
  }
  return result;
}

/** 命中标签并入拒绝理由：`policy/denied.rule` 只能取枚举值，具体是哪条钩子要能查得到 */
function denyReason(tag: string, reason: string): string {
  return tag === 'hook' ? reason : `${reason}（命中 ${tag}）`;
}

/** 被钩子拒绝的调用：没有 tool/call，只有一条 policy/denied + 回给模型的这段文本 */
function deniedResult(
  call: ToolCallRequest,
  rule: string,
  reason: string,
  durationMs: number,
): ToolExecutionResult {
  return {
    status: 'denied',
    content:
      `工具 ${call.name} 的调用被 PreToolUse 钩子拦下了（命中规则 ${rule}）：${reason}。`
      + '本次调用没有执行，日志里记的是 policy/denied{rule:\'hook\'}，不是 tool/call。'
      + '要推进这件事：按上面的理由换做法或改参数后重新发起；'
      + '如果这条规则本身不该拦，钩子配置对 agent 只读，需要人工改配置文件后重启。',
    isError: true,
    error: { message: `被 PreToolUse 钩子拒绝：${reason}`, code: 'HOOK_DENIED' },
    durationMs,
  };
}

// ──────────────────────────────── 计划模式门 ────────────────────────────────

/**
 * 计划模式的拦截（design §4.21）：destructive 调用没有拿到人工批准就不执行。
 *
 * 与钩子拒绝共用「没有 tool/call、没有 tool/result」这条形状（调用方据 callSeq === 0 识别），
 * 但落的是 plan/pending + human/asked：被拦的原因不同，人看到的界面也不该是同一个。
 */
function applyPlanGate(call: ToolCallRequest, ctx: ExecutionContext): ToolExecutionResult | null {
  const gate = ctx.planGate;
  if (gate === undefined) return null;
  const startedAt = Date.now();
  const denial = gate.intercept({
    callId: call.callId,
    tool: call.name,
    arguments: call.arguments,
    turn: ctx.turn,
    step: ctx.step,
    sideEffect: ctx.registry.get(call.name)?.sideEffect ?? 'destructive',
  });
  if (denial === null) return null;
  return {
    status: 'denied',
    content: denial.content,
    isError: true,
    error: { message: denial.message, code: denial.code },
    durationMs: Date.now() - startedAt,
  };
}

// ──────────────────────────────── 单次调用 ────────────────────────────────

async function executeOne(
  call: ToolCallRequest,
  callSeq: number,
  ctx: ExecutionContext,
): Promise<ToolExecutionResult> {
  const startedAt = Date.now();
  const def = ctx.registry.get(call.name);

  // 未知工具：不执行，回一条带可用清单的错误结果，让模型能改道（M2-8）
  if (def === null) {
    return {
      status: 'error',
      content: unknownToolMessage(call.name, ctx),
      isError: true,
      error: { message: `未知工具 ${call.name}`, code: 'UNKNOWN_TOOL' },
      durationMs: Date.now() - startedAt,
    };
  }

  // 外部取消（shutdown）：未派发即记 aborted，不启动执行体（schema §4 的 aborted 语义）
  if (ctx.signal?.aborted === true) {
    return abortedResult(call, startedAt, '进程取消请求到达时该调用尚未派发');
  }

  // 参数解析：失败也照原样落库（tool/call 里已是原文），只回可读错误，绝不崩进程（M2-7）
  const parsed = parseArguments(call.arguments);
  if (!parsed.ok) {
    return {
      status: 'error',
      content:
        `工具 ${call.name} 的 arguments 不是合法 JSON：${parsed.message}。`
        + `原始文本：${clip(call.arguments, 200)}。`
        + '请把整次调用重发一次，arguments 用一个合法 JSON 对象；原文已照原样落库，复盘时可查。',
      isError: true,
      error: { message: `arguments 不是合法 JSON：${parsed.message}`, code: 'INVALID_JSON_ARGUMENTS' },
      durationMs: Date.now() - startedAt,
    };
  }

  const isolated = ctx.isolation?.resolve(def, call) ?? null;
  if (isolated !== null) return runIsolated(call, callSeq, def, isolated, ctx, startedAt);
  return runInProcess(call, callSeq, def, parsed.value, ctx, startedAt);
}

/** 进程内执行：超时用 AbortController 打断，不响应的 handler 记 zombie */
async function runInProcess(
  call: ToolCallRequest,
  callSeq: number,
  def: ToolDefinition,
  args: unknown,
  ctx: ExecutionContext,
  startedAt: number,
): Promise<ToolExecutionResult> {
  const timeoutController = new AbortController();
  const upstream: AbortSignal[] = [timeoutController.signal];
  if (ctx.signal !== undefined) upstream.push(ctx.signal);
  const link = linkSignals(upstream);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, def.timeoutMs);

  const toolCtx: ToolContext = {
    callId: call.callId,
    turn: ctx.turn,
    step: ctx.step,
    signal: link.signal,
    // 「有人插话」计数读取器原样透传：它是 turn 级的（整轮共用），不是每次调用新建的
    ...(ctx.interruptEpoch === undefined ? {} : { interruptEpoch: ctx.interruptEpoch }),
    // 销账口同样原样透传（speak 真被打断时用它；见 ExecutionContext.claimInterruption）
    ...(ctx.claimInterruption === undefined ? {} : { claimInterruption: ctx.claimInterruption }),
    workspaceRoot: ctx.workspaceRoot,
    // 活动边界随 workspaceRoot 一起进 ToolContext。缺省时**不放这个键**：`boundaryRoot === undefined`
    // 与"没有这个字段"在工具层必须完全同义（那是"用 workspaceRoot 当边界"的历史默认）。
    ...(ctx.boundaryRoot === undefined ? {} : { boundaryRoot: ctx.boundaryRoot }),
  };
  // 包一层 Promise.resolve().then：handler 同步抛错也变成 rejection，走同一条错误路径
  const running: Promise<ToolHandlerResult> = Promise.resolve().then(() => def.handler(args, toolCtx));

  try {
    const outcome = await Promise.race([
      running.then(
        (value) => ({ kind: 'done' as const, value }),
        (error: unknown) => ({ kind: 'threw' as const, error }),
      ),
      waitForAbort(link.signal).then(() => ({ kind: 'aborted' as const })),
    ]);

    if (timedOut) {
      // 超时结果优先于迟到的完成：迟到的 resolve 一律丢弃（design §4.5）
      if (outcome.kind === 'done') {
        noteZombie(ctx, call, callSeq,
          `工具 ${def.name} 的返回与超时同时到达，该结果已丢弃（迟到完成，副作用可能已经发生）`);
      } else {
        observeLateSettle(running, ctx, call, callSeq);
      }
      return timeoutResult(call, def, startedAt);
    }
    if (outcome.kind === 'aborted') {
      return abortedResult(call, startedAt, '取消信号在派发后到达，执行体已收到 abort');
    }
    if (outcome.kind === 'threw') {
      const message = errorText(outcome.error);
      return {
        status: 'error',
        content: `工具 ${def.name} 执行失败：${message}。这通常是参数或环境不满足它的前提；调整后可以再试一次。`,
        isError: true,
        error: { message, code: 'TOOL_HANDLER_ERROR' },
        durationMs: Date.now() - startedAt,
      };
    }
    return completedResult(def, outcome.value, startedAt);
  } finally {
    clearTimeout(timer);
    link.dispose();
  }
}

/**
 * 子进程隔离执行：超时即杀（含进程树），杀后窗口内的任何输出都记 zombie。
 * 这条路径不经过 handler——handler 只在进程内路径被调用，隔离任务由 IsolationConfig.resolve 给出。
 */
async function runIsolated(
  call: ToolCallRequest,
  callSeq: number,
  def: ToolDefinition,
  task: IsolatedTask,
  ctx: ExecutionContext,
  startedAt: number,
): Promise<ToolExecutionResult> {
  const isolation = ctx.isolation!;
  const spawner = isolation.spawn ?? defaultIsolatedSpawner;
  const graceMs = isolation.zombieGraceMs ?? DEFAULT_ZOMBIE_GRACE_MS;

  const plan: IsolatedTask = task.stdin === undefined ? { ...task, stdin: call.arguments } : task;
  let proc: IsolatedProcess;
  try {
    proc = spawner(plan);
  } catch (error) {
    const message = errorText(error);
    return {
      status: 'error',
      content: `隔离子进程未能启动（${plan.command}）：${message}。这台机器上可能没有这个命令，或者路径不可执行。`,
      isError: true,
      error: { message, code: 'ISOLATION_SPAWN_FAILED' },
      durationMs: Date.now() - startedAt,
    };
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let killedAt: number | null = null;
  let timedOut = false;
  let killReason = '';

  const exitReached = new Promise<number | null>((resolve) => proc.onClose(resolve));

  proc.onData((chunk, stream) => {
    if (stream === 'stdout') stdoutChunks.push(chunk);
    else stderrChunks.push(chunk);
    if (killedAt !== null) {
      // kill 之后仍到达输出：迟到副作用迹象（review.md 缺陷 6 / M2-11）
      noteZombie(ctx, call, callSeq,
        `隔离子进程在被终止（${killReason}）后仍产生 ${stream} 输出：${clip(chunk.trim(), 120)}`);
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killedAt = Date.now();
    killReason = `超时 ${def.timeoutMs}ms`;
    proc.kill();
  }, def.timeoutMs);
  const onExternalAbort = (): void => {
    if (killedAt === null) {
      killedAt = Date.now();
      killReason = '外部取消';
      proc.kill();
    }
  };
  ctx.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    // 等退出：正常完成时立刻返回；超时后由 kill 触发退出；kill 无效则由兜底窗口收尾并记 zombie
    const exit = await Promise.race([
      exitReached.then((code) => ({ settled: true as const, code })),
      sleep(def.timeoutMs + graceMs).then(() => ({ settled: false as const, code: null as number | null })),
    ]);
    if (!exit.settled) {
      noteZombie(ctx, call, callSeq,
        `隔离子进程在${killReason || '终止'}之后仍未退出（超过 ${graceMs}ms）：可能免疫终止，副作用需人工确认`);
    } else if (killedAt !== null) {
      // 杀后宽限期：kill 前写入管道、kill 后才到达的输出会落进这里
      await sleep(graceMs);
    }

    if (timedOut) return timeoutResult(call, def, startedAt);
    if (killedAt !== null) return abortedResult(call, startedAt, `隔离子进程已终止（${killReason}）`);

    const stdout = clipOutput(stdoutChunks.join(''));
    const stderr = clipOutput(stderrChunks.join(''));
    if (exit.code === 0) {
      return {
        status: 'ok',
        content: stdout.length > 0 ? stdout : '（隔离子进程没有输出）',
        durationMs: Date.now() - startedAt,
      };
    }
    return {
      status: 'error',
      content:
        `隔离子进程以退出码 ${exit.code ?? 'null'} 结束（可能是启动失败或异常终止）。`
        + `${stderr.length > 0 ? ` stderr：${stderr}` : ' stderr 为空。'}`
        + `${stdout.length > 0 ? ` stdout：${stdout}` : ''}`,
      isError: true,
      error: { message: `隔离子进程退出码 ${exit.code ?? 'null'}`, code: 'ISOLATION_EXIT_NONZERO' },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 默认隔离子进程实现：stdio 走管道，kill 时 Windows 上用 taskkill 兜底杀进程树 */
export const defaultIsolatedSpawner: IsolatedSpawner = (task) => {
  const hasStdin = task.stdin !== undefined;
  const child: ChildProcess = spawn(task.command, [...task.args], {
    cwd: task.cwd ?? process.cwd(),
    stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handlers: Array<(chunk: string, stream: 'stdout' | 'stderr') => void> = [];
  const emit = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const handler of handlers) handler(text, stream);
  };
  child.stdout?.on('data', emit('stdout'));
  child.stderr?.on('data', emit('stderr'));
  if (hasStdin) child.stdin?.end(task.stdin);

  return {
    pid: child.pid,
    onData(handler) {
      handlers.push(handler);
    },
    onClose(handler) {
      child.once('close', (code) => handler(code));
      // 启动失败（命令不存在等）只发 error 不发 close：统一折算成「退出码未知」
      child.once('error', () => handler(null));
    },
    kill() {
      killProcessTree(child);
    },
  };
};

/** 杀进程树：先直接杀，Windows 上再 taskkill /T /F 兜底（design §4.18 pwsh 超时杀树） */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // 已经退出了：忽略
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // taskkill 不可用不影响直接 kill 的结果
    }
  }
}

// ──────────────────────────────── 结果构造 ────────────────────────────────

function completedResult(
  def: ToolDefinition,
  value: ToolHandlerResult,
  startedAt: number,
): ToolExecutionResult {
  // handler 契约被违背（返回了非对象）时给可读错误，不让上层在 undefined.content 上炸
  if (typeof value !== 'object' || value === null || typeof value.content !== 'string') {
    return {
      status: 'error',
      content: `工具 ${def.name} 的 handler 没有返回合法的 ToolHandlerResult（content 必须是字符串）。这是工具实现的问题，不是调用参数的问题。`,
      isError: true,
      error: { message: 'handler 返回值不符合 ToolHandlerResult', code: 'TOOL_BAD_RESULT' },
      durationMs: Date.now() - startedAt,
    };
  }
  const isError = value.isError === true || value.error !== undefined;
  const result: ToolExecutionResult = {
    status: isError ? 'error' : 'ok',
    content: value.content,
    durationMs: Date.now() - startedAt,
  };
  if (isError) result.isError = true;
  if (value.error !== undefined) result.error = value.error;
  if (value.additionalContext !== undefined) result.additionalContext = value.additionalContext;
  return result;
}

/**
 * 超时回执（**全工具共用这一处**：谁的 `timeoutMs` 到了都是这一句）。
 *
 * 口径（2026-10-10 改）：**同一个目标别再重试**。原话是"超时不会中断本轮循环；要推进这件事，
 * 请缩小参数范围、拆成更小的调用，或先确认目标是否可达"——那句话把超时**归因到参数上**，
 * 于是读它的人（或她）照着去"缩小范围"，而现场那次 `read_channel`（消息量很大的群、
 * `timeoutMs: 10_000`）根本不是参数问题：她把 `limit` 换了 20 次（6/8/10/12），一次次超时。
 * 归因错了，出路就错了；所以改口径时把"再试一次"这条路**收掉**，只留两条真出路：
 * 换做法，或如实报告用户。
 *
 * ⚠ 这一句进的是**事件**（日志/重放/界面读它）。**模型那侧读的不是它**：同一条 `tool/result`
 * 到了渲染层由 `model/render.ts` 的 `renderToolOutput` 按 status 分发，`case 'timeout'` 打的是
 * 一句固定文本、**把这里的 `content` 整个丢掉**。要真改她读到的口径，两处得一起改；
 * 只改这里等于只改了留痕。回归用例：`test/tool-failure-streak.test.ts` 的 ④ 逐字钉这一句。
 */
function timeoutResult(
  call: ToolCallRequest,
  def: ToolDefinition,
  startedAt: number,
): ToolExecutionResult {
  return {
    status: 'timeout',
    content:
      `工具 ${call.name} 超过 ${def.timeoutMs}ms 没有返回，已记为超时结果。`
      + '超时不会中断本轮循环；同一个目标别再重试（超时通常不是参数问题）——'
      + '要么换做法，要么如实报告用户。',
    isError: true,
    error: { message: `工具 ${call.name} 执行超时（${def.timeoutMs}ms）`, code: 'TOOL_TIMEOUT' },
    durationMs: Date.now() - startedAt,
  };
}

function abortedResult(
  call: ToolCallRequest,
  startedAt: number,
  detail: string,
): ToolExecutionResult {
  return {
    status: 'aborted',
    content: `工具 ${call.name} 的调用被取消：${detail}。这次调用没有产出结论，需要时请重新发起。`,
    isError: true,
    error: { message: `调用被取消：${detail}`, code: 'TOOL_ABORTED' },
    durationMs: Date.now() - startedAt,
  };
}

function unknownToolMessage(name: string, ctx: ExecutionContext): string {
  const available = ctx.registry
    .listForModel(ctx.modelVisibility ?? {})
    .map((spec) => spec.name);
  const list = available.length > 0 ? available.join('、') : '（当前没有可用工具）';
  return `未知工具 ${name}：注册表里没有这个名字。可用工具：${list}。`
    + '请改用清单里的工具；如果它本该由某个扩展提供，先确认那个扩展是否已装上。';
}

// ──────────────────────────────── 小工具 ────────────────────────────────

function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const text = raw.trim();
  // 空白参数按空对象处理：模型发无参调用时可能给空串，这不是错误
  if (text === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { ok: false, message: errorText(cause) };
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * 组合信号：任一上游 abort 则输出 abort。不用 AbortSignal.any 是为了不依赖具体
 * 类型定义版本，并且能显式 dispose（长跑进程里监听器泄漏是真实的资源问题）。
 */
function linkSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const attached: AbortSignal[] = [];
  const onAbort = (): void => controller.abort();
  let disposed = false;

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    attached.push(signal);
  }

  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const signal of attached) signal.removeEventListener('abort', onAbort);
    },
  };
}

/** 超时之后仍在跑的 handler：迟到 settle 丢弃并记 zombie（缺陷 6 的「假阴性」防线） */
function observeLateSettle(
  running: Promise<ToolHandlerResult>,
  ctx: ExecutionContext,
  call: ToolCallRequest,
  callSeq: number,
): void {
  void running.then(
    () => {
      noteZombie(ctx, call, callSeq,
        `工具 ${call.name} 在超时之后仍然完成，副作用可能已经发生（handler 未响应 AbortSignal，结果已丢弃）`);
    },
    (error: unknown) => {
      noteZombie(ctx, call, callSeq,
        `工具 ${call.name} 在超时之后仍然抛出错误：${errorText(error)}（handler 未响应 AbortSignal）`);
    },
  );
}

/** 记录迟到副作用线索。它本身失败不影响主路径：这条路径是告警，不是结果 */
function noteZombie(
  ctx: ExecutionContext,
  call: ToolCallRequest,
  callSeq: number,
  note: string,
): void {
  const recorder = ctx.onToolZombie;
  if (recorder === undefined) return;
  try {
    void Promise.resolve(recorder(call, note, callSeq)).catch(() => undefined);
  } catch {
    // 回调同步抛错：吞掉，主路径继续
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 长输出截断：头 8k + 尾 2k，并给出「怎么拿全文」的下一步（design §4.18 五原则第 4 条） */
function clipOutput(text: string): string {
  if (text.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) return text;
  const head = text.slice(0, OUTPUT_HEAD_CHARS);
  const tail = text.slice(-OUTPUT_TAIL_CHARS);
  const dropped = text.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS;
  return `${head}\n…（共 ${text.length} 字符，中间 ${dropped} 字符已截断；要全文请让工具把结果写进文件，再用只读工具分段读）…\n${tail}`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
