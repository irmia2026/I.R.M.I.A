/**
 * Irmia Agent — task 子代理工具（docs/design.md §4.21 子代理段全文、docs/milestones.md M8-1..M8-3）
 *
 * 职责：把一件独立子任务 spin-off 成一个**隔离的执行单元**跑完，把结局（文本摘要）作为父 turn 里
 * 这次 `task` 调用的工具结果交回。它不是"多 Agent 协作"——没有协商、没有共享记忆、没有来回对话，
 * 只有隔离：一个受限的 `AgentLoopDeps` + 同一份 `runTurn` 语义。
 *
 * 隔离三件套（§4.21）在这份实现里的落点：
 *
 * ① **独立上下文**：子代理 `AgentLoopDeps.eventFilter` 只放行 `parentCallId === 本次 task callId`
 *    的事件，于是它的渲染快照**从空事件序列起**（父历史一条都进不来），`instructions` 仍复用人格
 *    常驻层（identity/constitution/style/state），输入 = 任务描述 + 调用方给的必要材料。
 *    归属标记是这条过滤的唯一依据，所以**事后重建**子代理请求与运行期走的是同一份判定
 *    （replay 的 `locateStep` 用同一个 scope 口径），可重建性不被隔离破坏。
 *
 * ② **独立预算**：子代理的投影从父投影的**当前累计**起算（tokensToday / tokensTask / lastExhausted
 *    原样继承），所以它的刹车判的是"父已花的钱 + 自己正在花的钱"——这就是从父任务额度扣减。
 *    反向一侧由 `onEvent` 承担：子代理每条事件落库后立刻折进父投影的记账口径
 *    （fold.applySubagentEvent），父循环的 `checkBeforeStep` / `admitWake` 立刻看得见这笔消耗，
 *    且与"重启后 fold 全量重建"的结论**逐字节一致**。
 *
 * ③ **归属标记**：子代理 turn 链的每条事件都带 `parentCallId`（父 turn 里那次 task 调用的 callId）。
 *    它同时是隔离边界（父的渲染与状态机都不认这些事件）与审计线索（哪条链是谁派出去的）。
 *
 * 结果回投：子代理的结局作为父 turn 中 `task` 调用的工具结果——两阶段落库、unknown 三态、顺序提交
 * 全部由执行器与恢复流程自然承担，本模块**零新增机制**。崩溃语义因此也是免费的：
 * 父 task 调用悬空 ⇒ `sideEffect: 'destructive'` ⇒ recover 结算为 `unknown` 并进待确认；
 * 子代理的开放 turn 由 recover 的 settleChildTurns 补 `turn/end{interrupted}`（M8-3 链）。
 *
 * 嵌套上限（§4.21）：默认 2 层。子代理的可用工具集**默认不含 task 本身**（防递归失控）；
 * 显式把它放进 `allowTools` 时才递归，且第 3 层的调用被拒绝——拒绝理由作为工具结果回给模型，
 * 而不是抛错崩掉父 turn。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import type { DsClient } from '../model/ds-client.js';
import type { EventLog } from '../log/event-log.js';
import type {
  AppEvent, AppEventType, BudgetLayer, ModelLane, Projection, TurnEndReason,
} from '../log/types.js';
import { defaultVisibility, emptyProjection } from '../log/types.ts';
import { applyOne, applySubagentEvent } from '../state/fold.ts';
import type { BlobOffloadOptions } from '../state/blob-store.ts';
import type { IsolationConfig, ToolPlanGate } from '../tools/executor.js';
import type { ListForModelOptions, ToolDefinition, ToolHandlerResult } from '../tools/registry.js';
import { ToolRegistry } from '../tools/registry.ts';
import {
  argsRecord, errorResult, errorResultFromThrown, okResult,
  optionalString, requiredString,
} from '../tools/types.ts';
import type { HookRunner } from '../hook/hooks.js';
import { BudgetGuard } from './budget-guard.ts';
import { runTurn, type AgentLoopBudget, type AgentLoopDeps, type AgentLoopPersona } from './agent-loop.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

const ORIGIN = 'runtime/subagent';

/** 工具名（默认子代理工具集里被排除的就是它：防递归，§4.21） */
export const TASK_TOOL_NAME = 'task';

/** 嵌套上限（design §4.21：2 层）。第 depth > maxDepth 层的调用被拒绝并说明原因 */
export const DEFAULT_MAX_DEPTH = 2;

/**
 * 单次子代理的执行上限。`—` 在 §4.18 的工具表里表示"由子代理自己的预算决定"，
 * 但执行器需要一个非零 timeoutMs 才能拦住完全不响应取消的执行体，所以给一个远大于
 * 任何正常子任务的兜底值。
 */
export const DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;

/** 参数与摘要的长度上限：工具结果会进父的上下文，无上限等于让子代理挤爆父的窗口 */
const MAX_DESCRIPTION_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 16_000;
const MAX_SUMMARY_TEXT_CHARS = 4_000;

/**
 * 未注入判定器时的兜底上限（与 `budget-guard.ts` 的 `FALLBACK_LIMITS` 同值——**那一条才是真源**）。
 * 宿主应当传入按 `config.budget` 构造的判定器；这里兜底的是"没有任何刹车也不能让子代理跑飞"。
 *
 * ⚠️ **这些数不是出厂默认值**：出厂默认现在是 `taskTokens` **5e8** /
 * `dailyTokens` **5e7**（**非缓存口径**：`(input − cacheHit) + output`，唯一一处定义在
 * `state/fold.ts` 的 `budgetTokensOf`；理由与那笔账见 `config.ts` 那两段注释）。
 * 这份兜底**刻意不动**——它答的是"没人给我判定器时拿什么停手"，不是"厂值是多少"。
 * 拿它当厂值复述会得出"单任务 500k / 日 2M"这种**错**结论（daily 那一档曾经恰好同值，
 * 那是巧合：**同一个数、两套含义**——一个是兜底、一个是出厂；出厂值一改，巧合也没了）。
 *
 * 行为一个字都没动（数还是老样子）；改的只是这段注释里那句已经失真的话。
 */
const FALLBACK_LIMITS = {
  stepTools: 20,
  turnSteps: 30,
  taskTokens: 500_000,
  dailyTokens: 2_000_000,
  softRatio: 0.85,
  failStreakMax: 5,
} as const;

export const TASK_ERROR_CODES = {
  /** 嵌套超过上限（M8-3）：原因回给模型，父 turn 继续 */
  depthExceeded: 'E_TASK_DEPTH_EXCEEDED',
  /** 子代理没能跑完（预算耗尽 / 模型失败 / 被取消）：摘要里写清楚发生了什么 */
  incomplete: 'E_TASK_INCOMPLETE',
  /** 宿主没接线（装配期造了工具、调用期却没有运行期依赖）：如实说，不静默降级 */
  notWired: 'E_TASK_NOT_WIRED',
} as const;

// ──────────────────────────────── 对外类型 ────────────────────────────────

/**
 * 刹车判定器。结构上兼容 `runtime/budget-guard.ts` 的 `BudgetGuard`——宿主直接把真循环
 * 那一份传进来即可（它读的投影由本模块显式传给判定方法，所以子代理的账算在子代理的投影上，
 * 而那份投影的基线来自父投影）。
 */
export interface TaskBudgetGuard {
  /** step 边界判定：非 null 即结束子代理的 turn */
  checkBeforeStep(projection: Projection): TurnEndReason | null;
  /** 软阈值提示（尾部 developer 插播） */
  softHint?(projection: Projection): string | null;
  /** 单步工具调用数上限 */
  stepCallLimit?(): number;
  /** 单步超限时的结局（预算实现负责写 budget/exhausted；缺省由本模块补写） */
  noteStepOverflow?(actual: number): TurnEndReason;
  /** 撞刹车的三个数（本模块据此写 budget/exhausted） */
  breachOf?(projection: Projection): { layer: BudgetLayer; limit: number; actual: number } | null;
  /** 该层有效上限（进结局摘要，让父模型知道还剩多少额度） */
  limitOf?(layer: BudgetLayer): number;
}

/**
 * 子代理的**运行期依赖快照**：一次 `task` 调用开始时解析一次，整次运行共用。
 *
 * 为什么要与 `TaskToolDeps` 分开：工具是在**装配期**造的（`tools/catalog.ts` 建注册表那一刻，
 * 那时循环还没建、投影还在折叠、人格刚读盘），而这些东西只有**调用期**才存在。装配期给出的
 * 是取值器（`TaskToolDeps.runtime`），调用期解析成这一份。
 *
 * 每一格都必须与父循环逐字同源——子代理不是"另一台机器上的 agent"，它是同一条链上的一次
 * 分叉：换个投影就变成两本账、换个注册表就变成另一套权限、换个边界就变成"父能写的地方
 * 子代理写不了"。**判据只有一处**：`runtimeOf()`（本文件），装配点只负责把同一个对象递进来。
 */
export interface TaskRuntime {
  /** 事件日志：子代理链的所有写入都经它（工具自带的两笔见 `SubagentRun.write`） */
  log: EventLog;
  /** 模型客户端（子代理跑的是同一份 `runTurn`，只是换了投影与工具集） */
  ds: DsClient;
  /** 父注册表：子代理的工具集是它的子集（默认取父视角可见的工具，去掉 task 本身） */
  registry: ToolRegistry;
  /** 父投影：预算基线与记账回流都走它 */
  projection: Projection;
  /** 人格常驻层：子代理的 instructions 复用它（§4.21 隔离三件套之一） */
  persona: AgentLoopPersona;
  /** 时钟注入（ISO 8601） */
  now: () => string;
  timezone: string;
  /** 刹车判定器（父循环那一份：有效上限含人工加注）；缺省用内置兜底上限 */
  guard?: TaskBudgetGuard | undefined;
  /** 进模型清单的工具口径，与父一致（缺省 `{}`：destructive 默认不列） */
  modelVisibility?: ListForModelOptions | undefined;
  /**
   * 计划模式门（design §4.21）。**必须与父共用同一个实例**：它是"destructive 调用先请人批准"
   * 那道门，子代理手里的工具与父是同一批（含 pwsh / http_post），不传就等于"通过 task 派一个
   * 子代理"成了绕过事前审批的一条路——而那正是这个模式唯一要防的事。
   */
  planGate?: ToolPlanGate | undefined;
  /** 执行点钩子（§4.19）：与父共用一份，子代理内的工具调用同样过钩子 */
  hooks?: HookRunner | undefined;
  /** 子进程隔离配置：与父共用（不响应中断的工具走隔离，超时即杀） */
  isolation?: IsolationConfig | undefined;
  /** 技能 catalog：缺省不带（那是父视角的索引，子代理按需 safe_read 更省） */
  skillCatalog?: string | null | undefined;
  /**
   * 单条工具回执的上限（2026-10-06 加，见 `tools/catalog.ts` 的同名格）：子代理与父循环
   * 用同一把尺。它进的是 `AgentLoopDeps.blobOffload`（唯一写入点 `recordToolResult`），
   * 所以"首入一次性定形、此后不再剪"的性质与父完全一致。
   */
  blobOffload?: BlobOffloadOptions | undefined;
  /** 外部取消（父 turn 的信号）：透传给子代理的模型请求与工具执行 */
  signal?: AbortSignal | undefined;
}

/**
 * 装配期给出的取值器。**注入它 = 该件工具由宿主接线**；不注入就退回下面那几格静态字段
 * （测试台与夹具要的正是后者：它们手上有真的 log/projection，不需要走惰性取值）。
 *
 * 返回 `null` = "这一刻还没有运行期"（比如进程正处在假循环分支）：`task` 会如实报未接线，
 * 而不是拿一份空投影去跑（那会让子代理的账记在一个不存在的父上）。
 */
export type TaskRuntimeResolver = () => TaskRuntime | null;

export interface TaskToolDeps {
  /**
   * 运行期取值器（宿主接线走这条）。给了它，`registry` / `projection` / `persona` / `now` /
   * `timezone` / `log` / `ds` 由它当场给出——装配期不需要提前持有循环对象。
   */
  runtime?: TaskRuntimeResolver | undefined;
  /**
   * **已经解析好的一份运行期**（同一次运行里生嵌套 task 时用）。
   *
   * 为什么需要它：嵌套那一件的 `registry` 与 `projection` 必须换成**本层**的（否则孙代理
   * 会看到父的全部工具、预算也会记在父那一层），而其余几格（log / ds / persona / now /
   * timezone）仍然是同一份。`base` 给的就是后者；[runtime] 给的是前者。
   * 优先级：显式静态字段 > [runtime] > [base]。
   */
  base?: TaskRuntime | undefined;
  /**
   * 父注册表：子代理的工具集是它的**子集**（默认取父视角可见的工具，去掉 task 本身）。
   *
   * 下面七格（registry / projection / persona / now / timezone / log / ds）是**静态形状**，
   * 给测试台与夹具用：它们手上有真的 log/projection/registry，直接传比再包一层取值器清楚。
   * **装配期接线（`tools/catalog.ts`）不传它们**——那一刻循环还没建、投影还在折叠，
   * 传进来只会是假的；那条路一律走 [runtime]。两者都缺 = 工具如实报"未接线"。
   */
  registry?: ToolRegistry | undefined;
  /** 父投影：预算基线与记账回流都走它 */
  projection?: Projection | undefined;
  /** 人格常驻层：子代理的 instructions 复用它（§4.21 隔离三件套之一） */
  persona?: AgentLoopPersona | undefined;
  /** 时钟注入（ISO 8601）；缺省取本机时钟 */
  now?: (() => string) | undefined;
  timezone?: string | undefined;
  /**
   * 工具自己那两笔写入（输入卡 `wake/manual` + 刹车留痕 `budget/exhausted`）用的日志句柄。
   *
   * 它与那五格一样属于**运行期**（装配期还没有日志句柄），所以装配点只走 [runtime]；
   * 这一格是给静态形状（测试台 / 夹具，它们手上有打开的 EventLog）留的。
   */
  log?: EventLog | undefined;
  /**
   * 模型客户端（子代理跑的模型通道）。与 `log` 同一类：**运行期**才存在，装配点只走 [runtime]；
   * 这一格是给静态形状（测试台 / 夹具的模型替身）留的。
   */
  ds?: DsClient | undefined;
  /** 刹车判定器；缺省用内置兜底上限构造一个判定版 BudgetGuard */
  guard?: TaskBudgetGuard;
  /** 进模型清单的工具口径，与父一致（缺省 `{}`：destructive 默认不列） */
  modelVisibility?: ListForModelOptions;
  /**
   * 子代理可用工具名；缺省 = 父视角可见工具 − task（防递归）。
   *
   * 生产装配**不传**它 —— 于是子代理默认拿不到 task，**默认只有 1 层**（见 createTaskTool
   * 的注释与 test/task-tool-wiring.test.ts 的用例）。显式传含 `task` 的名单时才递归，
   * 且到 [maxDepth] 层封顶。
   */
  allowTools?: readonly string[];
  /** 本工具创建的子代理所处层级，默认 1（顶层） */
  depth?: number;
  /** 嵌套上限，默认 DEFAULT_MAX_DEPTH */
  maxDepth?: number;
  /** 执行器超时，默认 DEFAULT_TASK_TIMEOUT_MS */
  timeoutMs?: number;
  /** 子代理 lane，默认 heavy */
  lane?: ModelLane;
  /** 文件类工具的路径白名单根 */
  workspaceRoot?: string;
  /** 外部取消（父 turn 的信号）：透传给子代理的模型请求与工具执行 */
  signal?: AbortSignal;
  /**
   * 执行点钩子（§4.19）：与父共用一份，子代理内的工具调用同样过钩子。
   *
   * 生产装配走 [runtime]（钩子只在循环那一侧）；这一格是给静态形状（测试台 / 夹具）留的。
   */
  hooks?: HookRunner;
  /**
   * 计划模式门（design §4.21）：与父**共用同一个实例**。
   *
   * 为什么必须与父同一份：子代理手里的工具与父是同一批（含 pwsh / http_post / safe_write），
   * 不传它就等于"用 task 派个子代理"能绕过事前人审——而那正是这个模式唯一要防的事。
   * 生产装配走 [runtime]；这一格是给静态形状留的。
   */
  planGate?: ToolPlanGate;
  /** 子进程隔离配置（不响应中断的工具走隔离，超时即杀）；与父共用 */
  isolation?: IsolationConfig;
  /** 技能 catalog：缺省不带（那是父视角的索引，子代理按需 safe_read 更省） */
  skillCatalog?: string | null;
  /**
   * 单条工具回执的上限（2026-10-06 加，见 [TaskRuntime.blobOffload] 与
   * `tools/catalog.ts` 的同名格）：与父循环同一把尺。
   *
   * 生产装配走 [runtime]（`dataDir` 只在宿主手里）；这一格是给静态形状（测试台 / 夹具）留的。
   */
  blobOffload?: BlobOffloadOptions;
  /** 结局摘要的观测出口（宿主可在自己的日志里留一行） */
  onFinish?: (summary: TaskRunSummary) => void;
}

/**
 * 运行期解析。三个来源按**显式程度**取：静态字段 > [TaskToolDeps.runtime] > [TaskToolDeps.base]。
 *
 *   • 测试台 / 夹具：直接给静态字段（它们手上有真的 log / projection / registry）；
 *   • 生产装配：给取值器（装配期拿不到那些东西，见 tools/catalog.ts 的 taskRuntime）；
 *   • **同一次运行里生嵌套 task**：给 `base`（父这一刻的运行期）+ 静态覆盖 registry/projection
 *     ——这一条是"允许递归"能真的走通的关键（见 SubagentRun.buildRegistry）。
 *
 * 必需那七格凑不齐时返回 `null`：调用点据此回"未接线"，不静默降级（见 `unwiredRuntimeResult`）。
 */
function runtimeOf(deps: TaskToolDeps): TaskRuntime | null {
  const fromRuntime = deps.runtime?.() ?? null;
  const fromBase = deps.base ?? null;
  const pick = <T>(explicit: T | undefined, fallback: T | null): T | null =>
    (explicit !== undefined ? explicit : fallback);
  const registry = pick(deps.registry, fromRuntime?.registry ?? fromBase?.registry ?? null);
  const projection = pick(deps.projection, fromRuntime?.projection ?? fromBase?.projection ?? null);
  const persona = pick(deps.persona, fromRuntime?.persona ?? fromBase?.persona ?? null);
  const now = pick(deps.now, fromRuntime?.now ?? fromBase?.now ?? null);
  const timezone = pick(deps.timezone, fromRuntime?.timezone ?? fromBase?.timezone ?? null);
  const log = pick(deps.log, fromRuntime?.log ?? fromBase?.log ?? null);
  const ds = pick(deps.ds, fromRuntime?.ds ?? fromBase?.ds ?? null);
  if (registry === null || projection === null || persona === null || now === null
    || timezone === null || log === null || ds === null) {
    return null;
  }

  const source = fromRuntime ?? fromBase;
  const rt: TaskRuntime = { log, ds, registry, projection, persona, now, timezone };
  const guard = pick(deps.guard, source?.guard ?? null);
  if (guard !== null) rt.guard = guard;
  const modelVisibility = pick(deps.modelVisibility, source?.modelVisibility ?? null);
  if (modelVisibility !== null) rt.modelVisibility = modelVisibility;
  const planGate = pick(deps.planGate, source?.planGate ?? null);
  if (planGate !== null) rt.planGate = planGate;
  const hooks = pick(deps.hooks, source?.hooks ?? null);
  if (hooks !== null) rt.hooks = hooks;
  const isolation = pick(deps.isolation, source?.isolation ?? null);
  if (isolation !== null) rt.isolation = isolation;
  const skillCatalog = pick(deps.skillCatalog, source?.skillCatalog ?? null);
  if (skillCatalog !== null) rt.skillCatalog = skillCatalog;
  // 单条回执上限：与父同一把尺（子代理的上下文同样会被一次大回执吃掉）
  const blobOffload = pick(deps.blobOffload, source?.blobOffload ?? null);
  if (blobOffload !== null) rt.blobOffload = blobOffload;
  const signal = pick(deps.signal, source?.signal ?? null);
  if (signal !== null) rt.signal = signal;
  return rt;
}

/** 运行期缺失时回给模型的理由：说清"这台机器上它现在不可用"，而不是抛错崩掉父 turn */
function unwiredRuntimeResult(): ToolHandlerResult {
  return errorResult(
    'task 工具当前没有接线（宿主没有提供运行期依赖）：这台进程里派不出子代理。'
    + '请自己把这件子任务做完，不要重复调用本工具。',
    TASK_ERROR_CODES.notWired,
  );
}

/** 子代理的结局摘要（工具结果的素材，也是宿主观测的一份事实） */
export interface TaskRunSummary {
  /** 父 turn 里这次 task 调用的 callId（= 子代理链的 parentCallId） */
  callId: string;
  depth: number;
  /** 子代理的 turn 号（与主日志全局唯一） */
  turn: number;
  /** 子代理自己的步数 */
  steps: number;
  reason: TurnEndReason;
  /** 子代理本次消耗与父任务额度 */
  tokens: { used: number; limit: number | null };
  /** 子代理最后一条发言（无发言为 null） */
  text: string | null;
}

// ──────────────────────────────── 归属过滤（与 types/replay 同一口径） ────────────────────────────────

/**
 * 子代理的事件可见性：只有本链自己的事件。父历史、其它子代理、以及运行期插进日志的外部事件
 * （心跳、定时器）全部挡在外面——"独立上下文"不是在提示词里说一句，而是这条过滤。
 */
export function childEventFilter(callId: string): (event: AppEvent) => boolean {
  return (event) => event.parentCallId === callId;
}

/**
 * 子代理的默认工具名单：父视角可见的全部工具，去掉 `task` 本身（§4.21 防递归）。
 * 用 `listForModel` 取名单而不是 `names()`：子代理看到的工具集必须与父的视角口径一致
 * （destructive 默认不列是配置决定，不该被"子代理"这个身份悄悄绕过）。
 */
export function defaultChildToolNames(
  parent: ToolRegistry,
  options: ListForModelOptions = {},
): string[] {
  return parent.listForModel(options)
    .map(spec => spec.name)
    .filter(name => name !== TASK_TOOL_NAME);
}

// ──────────────────────────────── 工厂 ────────────────────────────────

/**
 * 造一件 `task` 工具。声明 `destructive`（父 turn 里这次调用的结局可能是 unknown）与
 * `exclusive`（前后是屏障：子代理在跑的时候不让别的工具调用重叠）。
 *
 * 三层嵌套的**实际**口径（`test/subagent.test.ts` 用测试钉住，别按注释想象）：
 *   • 本工具自己 `depth`（缺省 1）> `maxDepth`（缺省 [DEFAULT_MAX_DEPTH]）时**拒绝**，
 *     理由作为工具结果回给模型——拒绝不抛错，父 turn 照常往下走；
 *   • 子代理的默认名单是 `defaultChildToolNames`（父视角可见工具 − `task`），
 *     所以**默认 1 层**：子代理不能再派子代理；
 *   • 只有显式给它 `allowTools: [..., 'task']` 时才递归，且到第 `maxDepth` 层封顶。
 *     生产装配（`tools/catalog.ts`）不传 `allowTools`，所以今天上限就是 1 层。
 */
export function createTaskTool(deps: TaskToolDeps): ToolDefinition {
  const depth = deps.depth ?? 1;
  const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;

  return {
    name: TASK_TOOL_NAME,
    description:
      '派一个隔离子代理独立完成一件子任务：它看不到你的对话历史，只有你写下的任务描述，'
      + '预算从你这里扣减，跑完把结论交回给你。适合"读一批文件再汇总""与主线无关的调查"'
      + '这类能整块外包的活。任务描述必须自足：目标、验收标准、边界都要写清楚。',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: '子任务的完整描述：要做什么、做到什么算完成、不要碰什么（子代理看不到你的历史）',
        },
        context: {
          type: 'string',
          description: '可选：必要文件内容或背景材料，原样交给子代理（它不会继承你的上下文）',
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: deps.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, TASK_TOOL_NAME);
        const description = requiredString(args, 'description', { maxLength: MAX_DESCRIPTION_CHARS });
        const context = optionalString(args, 'context', { maxLength: MAX_CONTEXT_CHARS });

        // 深度门（§4.21 / M8-3）：拒绝而不是抛错——理由要作为工具结果回到模型手里，
        // 它才知道"这条路走不通，该自己干或换个拆法"。
        if (depth > maxDepth) {
          return errorResult(
            `task 嵌套已达上限：最多 ${maxDepth} 层子代理，本次调用的层级是第 ${depth} 层。`
            + '本层不再下派，请自己把这件子任务做完；如果需要拆分，就把子步骤直接在本层依次执行。',
            TASK_ERROR_CODES.depthExceeded,
          );
        }

        // 运行期依赖在**调用这一刻**解析：装配期造工具时循环还没建（见 TaskRuntime 的注释）
        const rt = runtimeOf(deps);
        if (rt === null) return unwiredRuntimeResult();

        const run = new SubagentRun({
          deps,
          rt,
          depth,
          maxDepth,
          callId: ctx.callId,
          parentTurn: ctx.turn,
          taskText: renderTaskText(description, context),
          workspaceRoot: ctx.workspaceRoot,
          // 边界原样继承父的（三态照带）：子代理的工具与父是同一批，边界也必须同一条
          ...(ctx.boundaryRoot === undefined ? {} : { boundaryRoot: ctx.boundaryRoot }),
          signal: ctx.signal,
        });
        return await run.execute();
      } catch (err) {
        return errorResultFromThrown(err, TASK_ERROR_CODES.incomplete);
      }
    },
  };
}

/** 子代理的输入文本（任务描述 + 必要材料）。分隔线是刻意的：它是模型区分"要求"与"素材"的唯一线索 */
function renderTaskText(description: string, context: string | undefined): string {
  const head = `[子任务]\n${description.trim()}`;
  if (context === undefined || context.trim() === '') return head;
  return `${head}\n\n[必要材料]\n${context.trim()}`;
}

// ──────────────────────────────── 一次子代理运行 ────────────────────────────────

interface SubagentRunOptions {
  deps: TaskToolDeps;
  /** 调用期解析出来的运行期依赖（本次运行共用这一份，逐格与父同源） */
  rt: TaskRuntime;
  depth: number;
  maxDepth: number;
  callId: string;
  parentTurn: number;
  taskText: string;
  workspaceRoot: string;
  /** 活动边界（三态原样继承父的；见 TaskToolDeps.boundaryRoot） */
  boundaryRoot?: string | null;
  signal: AbortSignal | undefined;
}

/**
 * 一次子代理运行的全部状态。它持有的三样东西是隔离的物理形态：
 *   - 自己的**投影**（基线来自父投影的预算累计）；
 *   - 自己的**工具注册表**（父注册表的子集，按需装配嵌套 task）；
 *   - 自己的**日志可见性**（eventFilter + parentCallId）。
 */
class SubagentRun {
  private readonly deps: TaskToolDeps;
  private readonly rt: TaskRuntime;
  private readonly depth: number;
  private readonly maxDepth: number;
  private readonly callId: string;
  private readonly parentTurn: number;
  private readonly taskText: string;
  private readonly workspaceRoot: string;
  /** 活动边界（三态原样携带；undefined = 用 workspaceRoot 当边界） */
  private readonly boundaryRoot: string | null | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly guard: TaskBudgetGuard;
  /** 子代理自己的投影：从父投影的预算累计起算（隔离三件套之二） */
  private readonly projection: Projection;
  private readonly baselineTokensTask: number;
  /** 本链自己的事件计数（摘要用；不依赖父投影——它看不见本链的 turn/step 结构） */
  private steps = 0;
  /** 本链最后一条有内容的发言（摘要里交给父模型的就是它） */
  private lastText: string | null = null;
  /** 分配到的 turn 号（= turnBase + 1，写在摘要里） */
  private turn = 0;

  constructor(options: SubagentRunOptions) {
    this.deps = options.deps;
    this.rt = options.rt;
    this.depth = options.depth;
    this.maxDepth = options.maxDepth;
    this.callId = options.callId;
    this.parentTurn = options.parentTurn;
    this.taskText = options.taskText;
    this.workspaceRoot = options.workspaceRoot;
    this.boundaryRoot = options.boundaryRoot;
    this.signal = options.signal;
    this.guard = options.rt.guard ?? new BudgetGuard({ ...FALLBACK_LIMITS });
    this.projection = childProjectionOf(options.rt.projection);
    this.baselineTokensTask = this.projection.budget.tokensTask;
  }

  async execute(): Promise<ToolHandlerResult> {
    // ① 输入事件：任务描述就是本轮唯一的输入。它带 parentCallId，所以不会进父的待处理队列
    //   （fold 的归属分流），却能被 runTurn 正常认领（认领只看 wakeEvents 参数）。
    const input = this.write('wake/manual', { note: this.taskText });

    // ② turn 号：子代理的事件视图是空的（看不见主日志的 turn），必须由日志高水位给出全局下限，
    //   再与父 turn 取大值——子代理的 turn 永远排在派它的那次调用之后。
    const turnBase = Math.max(await allocateTurnBase(this.rt.log), this.parentTurn);
    this.turn = turnBase + 1;

    // ③ 工具集与子代理循环
    const registry = this.buildRegistry();
    const reason = await runTurn(this.loopDeps(registry, turnBase), [input]);

    // ④ 撞刹车时把事实写下来：判定版 guard 不持有事件写入通道（那是宿主的 emit），
    //   而"哪一层、上限多少、实际多少"只有此刻知道——由本模块补这一条，且只补一次。
    this.settleBreach(reason);

    const summary = this.summarize(reason);
    this.deps.onFinish?.(summary);

    const text = renderSummary(summary);
    return reason.kind === 'completed'
      ? okResult(text)
      : errorResult(text, TASK_ERROR_CODES.incomplete);
  }

  // ── 装配 ──

  private loopDeps(registry: ToolRegistry, turnBase: number): AgentLoopDeps {
    const d = this.deps;
    const rt = this.rt;
    const deps: AgentLoopDeps = {
      log: rt.log,
      ds: rt.ds,
      registry,
      projection: this.projection,
      // 人格常驻层复用（隔离三件套之一）：子代理也是"她"，只是不知道这条线上发生过什么
      persona: rt.persona,
      now: rt.now,
      timezone: rt.timezone,
      lane: d.lane ?? 'heavy',
      workspaceRoot: this.workspaceRoot,
      // 边界与 workspaceRoot 同行（子代理链的边界必须与父**逐字相同**，否则同一次任务里
      // 内外两层的可活动范围会不一样，而她对这件事没有任何可见线索）
      ...(this.boundaryRoot === undefined ? {} : { boundaryRoot: this.boundaryRoot }),
      budget: this.budgetHook(),
      // 上下文隔离：从空事件序列起
      eventFilter: childEventFilter(this.callId),
      // 归属标记：本链的每条事件都带它
      parentCallId: this.callId,
      turnBase,
      // 预算回流：子代理花的钱立刻进父的账（与重启后全量折叠同一份口径）
      onEvent: (event) => {
        applySubagentEvent(rt.projection, event);
        this.noteEvent(event);
      },
    };
    // 其余字段按需透传（exactOptionalPropertyTypes 下不写 undefined）
    if (rt.modelVisibility !== undefined) deps.modelVisibility = rt.modelVisibility;
    if (rt.hooks !== undefined) deps.hooks = rt.hooks;
    if (rt.isolation !== undefined) deps.isolation = rt.isolation;
    if (rt.skillCatalog !== undefined) deps.skillCatalog = rt.skillCatalog;
    // 单条回执上限与父同一把尺：不给它，子代理自己的上下文就没有这条界
    if (rt.blobOffload !== undefined) deps.blobOffload = rt.blobOffload;
    if (this.signal !== undefined) deps.signal = this.signal;
    // 计划模式门**必须与父共用同一个实例**：子代理手里的工具与父是同一批（含 pwsh /
    // http_post / safe_write），不传它就等于"用 task 派一个子代理"能绕过事前人审——
    // 而那正是 planMode 唯一要防的事。executor 的拦截点读的就是这个门。
    if (rt.planGate !== undefined) deps.planGate = rt.planGate;
    // 必要性门刻意不传：子代理必须执行，沉默不是它的权利
    return deps;
  }

  private budgetHook(): AgentLoopBudget {
    const guard = this.guard;
    const hook: AgentLoopBudget = {
      checkBeforeStep: (projection) => guard.checkBeforeStep(projection),
    };
    if (guard.softHint !== undefined) hook.softHint = (projection) => guard.softHint!(projection);
    if (guard.stepCallLimit !== undefined) hook.stepCallLimit = () => guard.stepCallLimit!();
    if (guard.noteStepOverflow !== undefined) {
      hook.onStepOverflow = (actual) => guard.noteStepOverflow!(actual);
    }
    return hook;
  }

  /**
   * 子代理的工具集：父注册表的子集（同名同 def，handler 复用），外加可选的嵌套 task。
   * 嵌套 task 绑定的 `projection` 是**子代理自己的投影**——于是孙代理的预算基线来自子代理，
   * "从父任务额度扣减"这条链是逐层传递的。
   */
  private buildRegistry(): ToolRegistry {
    const d = this.deps;
    const rt = this.rt;
    // 名单默认口径：父视角可见工具 − task。名单取自 `rt.registry`（**父注册表**）——
    // 子代理的工具集是父的子集，这是"同一套权限"的物理形态。
    const names = d.allowTools ?? defaultChildToolNames(rt.registry, rt.modelVisibility ?? {});
    const registry = new ToolRegistry();

    for (const name of names) {
      if (name === TASK_TOOL_NAME) continue; // task 单独装配（要带上层级与自引用注册表）
      const def = rt.registry.get(name);
      if (def === null) continue;
      try {
        registry.register(def);
      } catch {
        // 父注册表里的 def 已过一次校验；这里再失败只可能是同名冲突，跳过即可（不阻断子代理）
      }
    }

    if (names.includes(TASK_TOOL_NAME)) {
      // 显式允许递归时才注册：默认名单里没有 task（§4.21 防递归）。
      // 超限层也照常注册——它必须能被调用，好把"超限"这个理由回给模型。
      //
      // 嵌套那一件的依赖是**这一刻的静态值**，且三格刻意覆盖掉父的取值器：
      //   • `registry` = 本层刚建好的子集（于是孙代理看到的是"本层的工具"，不是父的全部）；
      //   • `projection` = **本层自己的投影**（于是孙代理的预算基线来自本层，逐层传递）；
      //   • `depth` = 本层 + 1（超出 maxDepth 时调用被拒）。
      // 若在这里继续用 `d.runtime`（父的取值器），上面三格会被它整个盖掉——那正是这个 bug
      // 曾经的样子：子代理拿回父注册表，task 又被 `defaultChildToolNames` 滤掉，
      // 表现是"允许递归了却永远只有一层"。所以这里**不传 runtime**。
      const nested = createTaskTool({
        ...d,
        runtime: undefined,
        // 其余几格（log / ds / persona / now / timezone / guard / modelVisibility / planGate /
        // hooks…）由 `base` 原样继承：它们是"这一次运行"的属性，不随层级变
        base: this.rt,
        registry,
        // 孙代理的父投影就是**子代理自己的投影**：预算基线逐层传递
        projection: this.projection,
        depth: this.depth + 1,
        maxDepth: this.maxDepth,
      });
      try {
        registry.register(nested);
      } catch {
        // 同上：嵌套 task 装不上时子代理仍可干活
      }
    }
    return registry;
  }

  // ── 事件写入 ──

  /**
   * 子代理自己写的事件（不是 TurnRunner 写的那些）：输入与刹车留痕。
   * 两条口径：折进**自己的**投影（它就是本层），同时折进父投影的记账口径（父必须看得见）。
   */
  private write(type: AppEventType, data: unknown): AppEvent {
    const event = {
      seq: this.rt.log.nextSeq(),
      ts: this.rt.now(),
      type,
      data,
      visibility: defaultVisibility(type),
      origin: ORIGIN,
      parentCallId: this.callId,
    } as unknown as AppEvent;
    this.rt.log.append(event, { sync: true });
    applyOne(this.projection, event);
    applySubagentEvent(this.rt.projection, event);
    return event;
  }

  /**
   * 撞刹车 → 写 `budget/exhausted`（带归属标记）。判定版 guard 没有事件写入通道，
   * 所以这条事实由本模块补：三个数取自 guard 的判定结果，绝不凭空填。
   */
  private settleBreach(reason: TurnEndReason): void {
    if (reason.kind !== 'budget-exhausted') return;
    const breach = this.guard.breachOf?.(this.projection) ?? null;
    if (breach === null) return;
    // 父层已记过这个停顿就不重复写（同一条事实在日志里只出现一次）
    if (this.rt.projection.lastExhausted[breach.layer] !== undefined) return;
    this.write('budget/exhausted', {
      layer: breach.layer,
      limit: breach.limit,
      actual: breach.actual,
      // 暂停而不是失败：加预算后父循环可以继续（schema §6）
      resumable: true,
    });
  }

  // ── 结局 ──

  private summarize(reason: TurnEndReason): TaskRunSummary {
    const used = this.projection.budget.tokensTask - this.baselineTokensTask;
    const limit = this.guard.limitOf?.('task') ?? null;
    return {
      callId: this.callId,
      depth: this.depth,
      turn: this.turn,
      steps: this.steps,
      reason,
      tokens: { used, limit },
      text: this.lastText,
    };
  }

  /** 观测计数：本链的 step/start 与最后一条有内容的发言 */
  private noteEvent(event: AppEvent): void {
    if (event.type === 'step/start') this.steps += 1;
    if (event.type === 'message/assistant') {
      const text = event.data.text;
      if (text !== null && text.trim() !== '') this.lastText = text;
    }
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/**
 * 子代理的投影：空投影 + 父的**预算累计**（隔离三件套之二）。
 *
 * 继承的只有"钱与失败"这一层记账：tokensToday / tokensTask / cache / lastExhausted / failStreak。
 * turn 结构、待处理输入、开放调用、todo、定时器一律不继承——那些是父那条链的状态，
 * 子代理从头开始（`openTurn` 为 null，等它自己的 turn/start 建立）。
 */
function childProjectionOf(parent: Projection): Projection {
  const child = emptyProjection();
  child.budget.tokensToday = parent.budget.tokensToday;
  child.budget.tokensTodayHeavy = parent.budget.tokensTodayHeavy;
  child.budget.tokensTodayLight = parent.budget.tokensTodayLight;
  child.budget.cacheHitToday = parent.budget.cacheHitToday;
  child.budget.cacheMissToday = parent.budget.cacheMissToday;
  child.budget.tokensTask = parent.budget.tokensTask;
  child.failStreak = parent.failStreak;
  child.lastExhausted = { ...parent.lastExhausted };
  child.degraded = parent.degraded === null ? null : { ...parent.degraded };
  child.lastModelSuccessAt = parent.lastModelSuccessAt;
  child.firstEventAt = parent.firstEventAt;
  return child;
}

/**
 * turn 号高水位：单实例锁保证同一时刻只有一个分配者，所以内存高水位是可靠的。
 * 首次使用时全量扫一次日志取最大值（与 recover 的编号口径同源：日志里的最大 turn + 1），
 * 之后在内存里递增——否则每次 task 调用都要扫一遍全量日志。
 */
const turnHighWater = { value: 0, scanned: false };
let scanning: Promise<void> | null = null;

async function allocateTurnBase(log: EventLog): Promise<number> {
  if (!turnHighWater.scanned) {
    scanning ??= (async () => {
      let max = turnHighWater.value;
      for await (const event of log.readAll()) {
        if (event.type === 'turn/start' && event.data.turn > max) max = event.data.turn;
      }
      turnHighWater.value = max;
      turnHighWater.scanned = true;
    })();
    await scanning;
  }
  const base = turnHighWater.value;
  // 预占：本次子代理必然拿到 base + 1（TurnRunner 的 maxTurn() 在空视图下为 0）
  turnHighWater.value = base + 1;
  return base;
}

/** 结局 → 交给父模型的文本。父模型只该看到"结论 + 代价 + 要不要接着干"，不该看到子代理的内部流水 */
function renderSummary(summary: TaskRunSummary): string {
  const { reason } = summary;
  const lines: string[] = [];
  lines.push(`[子代理结束] 结局：${describeReason(reason)}（第 ${summary.depth} 层，turn ${summary.turn}，${summary.steps} 步）`);
  const limit = summary.tokens.limit === null ? '上限未知' : `本任务上限 ${summary.tokens.limit}`;
  lines.push(`消耗：本次 ${summary.tokens.used} token（${limit}）`);
  if (summary.text !== null && summary.text.trim() !== '') {
    const body = summary.text.length > MAX_SUMMARY_TEXT_CHARS
      ? `${summary.text.slice(0, MAX_SUMMARY_TEXT_CHARS)}…（子代理发言过长，已截断）`
      : summary.text;
    lines.push('子代理的最后发言：');
    lines.push(body);
  } else {
    lines.push('子代理没有留下发言：它的结论只能从工具结果里判断，或重派一次并明确要求它给结论。');
  }
  if (reason.kind !== 'completed') {
    lines.push(
      '提示：这次子代理没有正常收尾。它做过的副作用无法自动撤销——需要接着推进时，'
      + '先把上面这一段当作既成事实，再决定是重派、改派还是自己接手。',
    );
  }
  return lines.join('\n');
}

function describeReason(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed': return '已完成';
    case 'blocked': return `被阻塞（${reason.by}）`;
    case 'aborted': return `已取消（${reason.cause}）`;
    case 'interrupted': return '被中断';
    case 'incomplete': {
      if (reason.reason === 'content_filter') return '输出被内容策略截断（content_filter）';
      return reason.code === undefined ? '未说完（已收部分保留）' : `未说完（已收部分保留 · ${reason.code}）`;
    }
    case 'error': return `出错（${reason.code}：${reason.message}）`;
    case 'budget-exhausted': return `预算耗尽（${reason.layer} 层）`;
    case 'rate-limited': return `被限流（建议 ${reason.retryAfterMs}ms 后重试）`;
    case 'max-tokens': return `输出被截断（${reason.outputTokens} token）`;
  }
}
