/**
 * Irmia Agent — 刹车核心（M3，docs/design.md §4.6 全文落地 / docs/milestones.md M3-1..M3-5、M3-8）
 *
 * 职责：没人看着，必须有硬上限。四层，全部从投影读、全部跨重启累计。
 *
 * | 层    | 限制                    | 判定                | 动作                                |
 * |-------|-------------------------|---------------------|-------------------------------------|
 * | step  | 单步工具调用数          | `> stepTools`       | 多余调用记 over-limit，本 step 收束  |
 * | turn  | 单轮步数                | `>= turnSteps`      | 结束本 turn，reason budget-exhausted |
 * | task  | 单任务累计 token        | `>= taskTokens`     | 结束本 turn，进入待确认              |
 * | daily | 每日累计 token          | `>= dailyTokens`    | 拒绝唤醒（唤醒层读 dailyBreach）     |
 *
 * ⚠️ **token 那两档数的是"非缓存"的 token**（2026-10-05 用户换的口径，原话逐字抄在
 * `state/fold.ts` 的 `budgetTokensOf` 里）：
 *
 *     计入预算的 token = (inputTokens − cacheHitTokens) + outputTokens
 *
 * 也就是"输入里没命中缓存的那部分 + 输出"——**只盯真花钱的那部分**。定义**只有一处**
 *（`fold.ts` 的 `budgetTokensOf`），本模块只读投影里折出来的那个数（`tokensTask` /
 * `tokensToday`），自己不重算：判据分两处写，早晚会分岔，而分岔的那天刹车会在错误的时刻停。
 * 换口径之前是"未扣缓存"（含 cacheHit），在真实唤醒的心跳（约 97% 命中）之下计数器飞快见顶。
 * step / turn 两档数的是**次数**（工具调用数 / 步数），与 token 口径无关。
 *
 * 三条不可让步的语义：
 * 1. **消耗从投影读，不在内存里累加**（§4.6「成本必须跨重启累计」）。投影是日志的折叠结果，
 *    `tokensTask` / `tokensToday` / `stepsThisTurn` / `toolCallsThisStep` 全部由 fold 从事件重放，
 *    所以杀进程重启后剩余额度 = 上限 − 已消耗，而不是回到满格。
 * 2. **撞刹车是暂停，不是失败**（§4.6 末条）。写 `budget/exhausted { resumable: true }`、
 *    保存进度、进待机；人工加注（`irmia topup`）或跨天 rollover 就能接着跑，绝不清空重来。
 *    加注是**预算事实**：它先落 `budget/topped-up` 事件，再由 applyTopUpEvent 折成上限增量，
 *    所以有效上限 = 基础上限 + 累计加注（本模块只持有折出来的那个总数）。
 * 3. **软阈值先说话**（§4.6 首条）。达到 `上限 × softRatio` 时先给一句提示，让模型自己收尾，
 *    越过了才硬停。提示由宿主作为**尾部 developer 消息**插播（agent-loop 的 softHint 通道），
 *    不改已渲染历史——否则摧毁 KV cache 前缀。
 *
 * 两种构造形状（同一份实现，双方接口都保留）：
 *   - `new BudgetGuard({ config, projection, emit, now })`：自带事件写入的完整版（判定即落事件）；
 *   - `new BudgetGuard(budgetConfig, { stallMs })`：宿主自己写事件的判定版（real-loop 的用法）。
 *
 * 事件可见性一律走 schema 表（`budget/*` 是 internal）：刹车是簿记，不进模型请求。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfig } from '../config/config.js';
import type { AppEvent, BudgetLayer, Projection, TurnEndReason, Visibility } from '../log/types.js';
import { defaultVisibility } from '../log/types.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 软阈值兜底比例：config.budget.softRatio 缺失或非法时用它（design.md §4.6 的默认口径） */
export const DEFAULT_SOFT_RATIO = 0.85;

/** 水位停滞阈值兜底（毫秒）：有输入进来却超过这么久没有一次成功模型调用 → §4.9 告警 */
export const DEFAULT_STALL_MS = 10 * 60 * 1000;

/** 人工加注看门目录与文件名前缀（CLI 写、真循环拾取后落 budget/topped-up 事件） */
export const TOPUP_WATCH_DIR_NAME = 'topup';
export const TOPUP_FILE_PREFIX = 'topup-';
/** 看门文件名连续撞车的上限（同毫秒多次加注时向后借 1ms） */
const MAX_NAME_ATTEMPTS = 1000;

/**
 * 配置非法时的兜底上限——**只是一条"刹车不许消失"的最后一道**，正常路径永远读 `config.budget`
 * （`main.ts` 装配时把生效配置里的六个数交进来）。
 *
 * ⚠️ **它不等于 `config.ts` 的内置默认值**（别按"两边同义"读）：出厂默认现在是
 * `taskTokens: 500000000` / `dailyTokens: 50000000`（见 config.ts 那两段注释里那笔账），
 * 而这里的兜底值刻意**不跟**——它要回答的问题是"配置整个读不出来时也得有个数能停手"，
 * 而不是"厂值是多少"。两边的值今天在哪一档上都不相等（daily 那一档曾经恰好都是 2M，
 * 那是**巧合，不是同义**，出厂值一改这层巧合就没了）：
 * 拿这里的 500k 当"出厂单任务额度"复述就会得出**错**结论。
 *
 * 行为一个字都没动（那几个数还是老样子）；改的只是这段注释里已经失真的那几句。
 */
const FALLBACK_LIMITS = {
  stepTools: 20,
  turnSteps: 30,
  taskTokens: 500_000,
  dailyTokens: 2_000_000,
  failStreakMax: 5,
} as const;

/** 判定顺序：越靠前越"紧"，多层同时越线时先报它（先停手，再报账） */
const LAYER_ORDER: readonly BudgetLayer[] = ['step', 'turn', 'task', 'daily'];

const LAYER_LABEL: Record<BudgetLayer, string> = {
  step: '单步',
  turn: '单轮',
  task: '单任务',
  daily: '每日',
};

/**
 * 软提示文本：说给模型听的一句话，尾部插播。
 *
 * token 那两档跟着预算口径说话（**"非缓存"**，与此刻层 `用度：` 那一行、与设置页标签同一个词）：
 * 口径换了而提示还按旧口径描述，她就会把"真花钱的那部分"读成"全部 token"——同一个数两个说法，
 * 比不说更糟。措辞用大白话（"非缓存额度"而不是"非缓存口径"）：这句话是说给她听的动作提示，
 * 不是账本术语。
 */
const HINT_TEXT: Record<BudgetLayer, string> = {
  step: '这一步的工具调用快满了，能合并的合并，剩下的拆到后面的步骤',
  turn: '这一轮已经连续行动很多步，手上的事做完就收尾',
  task: '这次任务的非缓存消耗快到上限了，先把手上的阶段收尾并交代还剩什么',
  daily: '今天的非缓存额度快用完了，收尾并交代清楚明天从哪接着干',
};

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 预算配置的形状（config.budget 的结构；judge 只读这六个字段） */
export interface BudgetGuardConfig {
  stepTools: number;
  turnSteps: number;
  taskTokens: number;
  dailyTokens: number;
  softRatio: number;
  failStreakMax: number;
}

/** 撞刹车的事实：层 + 上限 + 实际值（写 budget/exhausted 的三个数） */
export interface BudgetBreach {
  layer: BudgetLayer;
  limit: number;
  actual: number;
}

/** 失败刹车的事实：连续失败数与阈值 */
export interface FailStreakBreach {
  limit: number;
  actual: number;
}

/**
 * 「上限已经高过已用量」的那条暂停记录——抬上限就该解开它（判定与凭据一起给出）。
 *
 * 它是 2026-10-04 那个真 bug 的判据出口：暂停记录留在投影里（`lastExhausted`），而"上限调大 +
 * 重启"只把同一条 `budget/exhausted` 重放一遍，记录照样在——唤醒门据此继续拒绝唤醒。
 * 判据不能看那条历史记录，要看**活的数**（当前有效上限与当刻已用量）；判定在这里，
 * 落 `budget/resumed` 由运行时做（本模块只回答"该不该解"）。
 */
export interface LiftedPause {
  layer: BudgetLayer;
  /** 解除那一刻的有效上限 = 基础上限 + 累计加注 */
  limit: number;
  /** 解除那一刻的已用量（当刻的活数，不是记录里那个旧数） */
  actual: number;
  /** 上限是被谁抬起来的：配置改了，还是累计加注 */
  reason: 'limit-raised' | 'topup';
}

/** 水位停滞的观测（§4.9：有事件进来但一直没被处理） */
export interface StallInfo {
  /** **最早那条待处理输入**已经等了多久（毫秒）——它就是判据里的"停滞时长" */
  waitedMs: number;
  /** 最早那条待处理输入的到达时刻（ISO），来自它自己的 wake 事件 */
  oldestPendingAt: string;
  /** 同时积压的输入条数 */
  pending: number;
}

/**
 * 水位停滞的**观测输入**（纯数据，判据自己不读时钟、不读日志）。
 *
 * 为什么判据要长这样（2026-10-03 修一次实测刷屏）：
 * 原来判的是「距上次成功模型调用的静默时长 > 阈值 **且** pending 非空」。空闲期里静默时长
 * 必然一直在长，于是**任何一条刚到 1 毫秒的输入**都会立刻把它顶过阈值——报警的其实是
 * "空闲被打破的那一瞬间"，而不是"输入卡住了"。实测 seq 16036→16041（心跳进来即报警、
 * 下一秒被领走即"已恢复"）、seq 16137→16142（用户 14:13:22 发来消息，14:13:23 报"停滞 27 分钟"，
 * 14:13:24 她又"恢复"了）都是这一条造成的：每一段正常空闲都稳定产出"警告 + 提示"一对。
 *
 * 现在改成**给输入自己计时**：停滞 = 最早那条待处理的输入已经等了超过阈值，且循环此刻
 * 手上没有活（busy / openTurn）。三条理由：
 *   ① 空闲不再计入——没人在等的时候，时间流逝不是故障，这是本判据唯一该有的"零";
 *   ② 心跳（30 分钟基线）不再能顶出报警：它到达与判停在同一拍，等待时长 ≈ 0；
 *   ③ "卡住"仍然会报：被预算/失败刹车拦住、循环不再领活、工具长挂，输入都会真的等下去。
 */
export interface StallObservation {
  /** 待处理输入条数 */
  pending: number;
  /** 最早那条待处理输入的到达时刻（ISO）；时间戳读不出来时给 null（宁可不报，也不编时长） */
  oldestPendingAt: string | null;
  /** 循环此刻手上有没有活：正在跑一个 turn（`openTurn` 非空 / busy）时为 true */
  busy: boolean;
  /** 当前时刻（调用方给：本模块不读时钟） */
  now: Date;
  /** 阈值（毫秒）：输入等超过它才算停滞 */
  stallMs: number;
}

/**
 * 水位停滞判据：**唯一一份实现**（运行期 real-loop 与 BudgetGuard 的判定入口共用）。
 *
 * 分成 `stallOf`（纯函数）与调用点两处，是为了不再出现"循环报的停滞"与"判定器认为的停滞"
 * 两套口径——这个 bug 本身就是两套口径的产物（旧判据里 `pending` 只要非空就算数，
 * 而"这条输入等了多久"根本没人看）。
 */
export function stallOf(o: StallObservation): StallInfo | null {
  if (o.pending <= 0) return null;
  // 循环手上有活（一个 turn 正在跑）：输入排队是正常的背压，不是停滞
  if (o.busy) return null;
  const oldest = o.oldestPendingAt;
  if (oldest === null) return null;
  const at = Date.parse(oldest);
  if (!Number.isFinite(at)) return null;
  const waitedMs = o.now.getTime() - at;
  if (!(waitedMs > o.stallMs)) return null;
  return { waitedMs, oldestPendingAt: oldest, pending: o.pending };
}

/** 判定版的构造选项 */
export interface BudgetGuardOptions {
  /** 水位停滞阈值（毫秒），默认 DEFAULT_STALL_MS */
  stallMs?: number | undefined;
}

/** 事件写入口（注入）。宿主实现为「分配 seq → append(sync: true) → applyOne」。 */
export type BudgetEmitter = (type: string, data: unknown, visibility: Visibility) => void;

export interface BudgetGuardDeps {
  /** 生效配置的预算段（AppConfig['budget']） */
  config: AppConfig['budget'];
  /** 运行期投影：所有累计值的唯一来源 */
  projection: Projection;
  /** 事件写入口：撞刹车写 budget/exhausted、恢复写 budget/topped-up */
  emit: BudgetEmitter;
  /** 时钟注入（预算层不读环境时钟以外的任何东西，便于测试把时间钉死） */
  now: () => Date;
  /** 覆盖软阈值比例；缺省取 config.softRatio，配置值不在 (0,1] 内则退 DEFAULT_SOFT_RATIO */
  softRatio?: number | undefined;
  /** 水位停滞阈值（毫秒）；仅 stall() 用 */
  stallMs?: number | undefined;
}

/** 一层的瞬时状态（观测与软阈值共用同一份计算，避免两处口径漂移） */
export interface BudgetLayerStatus {
  layer: BudgetLayer;
  /**
   * 已消耗（投影派生：跨重启累计）。单位随层走：
   * step / turn 是**次数**（工具调用数 / 步数），task / daily 是**非缓存 token**
   *（`(input − cacheHit) + output`，唯一一处定义在 `state/fold.ts` 的 `budgetTokensOf`）。
   */
  used: number;
  /** 有效上限 = 基础上限 + 累计人工加注 */
  limit: number;
  /**
   * 有效上限的**构成**：`base` 来自 `config.budget`，`topUp` 来自累计人工加注
   * （`budget/topped-up` 的折叠结果）。两者相加 == {@link limit}。
   *
   * 为什么必须把它算出来、而不是让人拿配置去对：2026-10-05 现场那张告警是
   * 「已用 178734979 / 上限 57000000」，而 `config.json` 里写的是 `taskTokens: 5000000`
   * ——数字对不上不是 bug，是**上限里混着 52M 历史加注**。不把构成摊开，
   * 下一次还是"配置写了 5M、它按 57M 判"这种把人绕晕的账（用户原话：**不许不协调**）。
   */
  composition: {
    /** 配置里那一档（`config.budget.*`，随"改配置 + 重启"变） */
    base: number;
    /** 累计人工加注（`irmia topup` 与跨天 rollover 的 0 加注都折在这里） */
    topUp: number;
  };
  /** used / limit */
  ratio: number;
  /** 已越过硬上限 */
  over: boolean;
  /** 已达软阈值（即使已越线也为真——提示与刹车不互斥） */
  soft: boolean;
}

/** 单步调用的切分结果：allowed 执行，over 记 over-limit 不执行 */
export interface StepCallSplit<T> {
  allowed: T[];
  over: T[];
}

/** 人工加注请求（CLI 写进看门文件的形状） */
export interface TopUpRequest {
  layer: BudgetLayer;
  addedTokens: number;
  by: string;
  ts: string;
}

/** 累计加注量（从 budget/topped-up 事件折叠出的每层增量） */
export type TopUpTotals = Record<BudgetLayer, number>;

// ──────────────────────────────── 加注看门文件 ────────────────────────────────

export function emptyTopUps(): TopUpTotals {
  return { step: 0, turn: 0, task: 0, daily: 0 };
}

/**
 * 把一条事件折进加注累计（纯函数，改原地）。
 * 只认 `budget/topped-up`：跨天 rollover 写的 `addedTokens: 0` 也在其中（加 0，无害）。
 */
export function applyTopUpEvent(totals: TopUpTotals, event: AppEvent): void {
  if (event.type !== 'budget/topped-up') return;
  const { layer, addedTokens } = event.data;
  if (!Number.isFinite(addedTokens) || addedTokens <= 0) return;
  totals[layer] += addedTokens;
}

/**
 * 解析加注看门文件。非法内容返回 null——看门文件是外部输入，
 * 半截 JSON 或写错的层名都不该把循环带崩（跳过并留痕即可）。
 */
export function parseTopUpRequest(raw: string): TopUpRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const doc = value as Record<string, unknown>;
  const layer = doc['layer'];
  const addedTokens = doc['addedTokens'];
  const by = doc['by'];
  const ts = doc['ts'];
  if (typeof layer !== 'string' || !LAYER_ORDER.includes(layer as BudgetLayer)) return null;
  if (typeof addedTokens !== 'number' || !Number.isInteger(addedTokens) || addedTokens < 0) return null;
  if (typeof by !== 'string' || by.trim() === '') return null;
  if (typeof ts !== 'string' || ts.trim() === '') return null;
  return { layer: layer as BudgetLayer, addedTokens, by, ts };
}

/**
 * 写加注看门文件（CLI 侧唯一副作用之一）。文件名 `topup-<epochMillis>.json`，
 * 同毫秒多次加注向后借 1ms，用 `wx` 排他创建——覆盖等于悄悄吞掉一次加注。
 * 与 wake 看门文件同一套纪律：CLI 不持有日志写句柄，加注事实由主循环落成事件。
 */
export function writeTopUpRequest(dataDir: string, request: TopUpRequest, now: Date = new Date()): string {
  const dir = join(dataDir, TOPUP_WATCH_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(request, null, 2)}\n`;

  for (let offset = 0; offset < MAX_NAME_ATTEMPTS; offset += 1) {
    const path = join(dir, `${TOPUP_FILE_PREFIX}${now.getTime() + offset}.json`);
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return path;
  }
  throw new Error(`加注看门文件名连续 ${MAX_NAME_ATTEMPTS} 次撞车，放弃加注`);
}

// ──────────────────────────────── 实现 ────────────────────────────────

export class BudgetGuard {
  /**
   * 生效的六个上限。**每次判定前从 {@link rawLimits} 重解一次**（见 `configure`），
   * 所以调用方把配置改了就立刻按新值判——判据不许留一份"开户时那份配置"的副本。
   */
  private limits: BudgetGuardConfig;
  /**
   * 上限的**原始来源**（`config.budget` 或 `BudgetGuardConfig`）。
   *
   * 为什么留一整份而不是留解析好的 `limits`：口径是"限额实时取自 config"。
   * 主进程重启后本来就会重新装配判定器（配置是启动参数），但**判定器自己**也不许把上限
   * 焊死在构造那一刻——现场那次"配置写了 5M、它按 57M 判"里，57M 有一半就是历史加注，
   * 另一半随时可能被改配置换掉。留原件 + 每次重解，是把这条口径钉在判定层内部。
   */
  private rawLimits: Partial<BudgetGuardConfig>;
  private readonly projection: Projection | null;
  private readonly emit: BudgetEmitter | null;
  private readonly now: () => Date;
  private softRatioValue: number;
  private readonly stallMsValue: number;
  /** 累计人工加注（从事件折叠；setTopUps 载入，addTopUp 增量） */
  private topUps: TopUpTotals = emptyTopUps();

  /** 本进程已写过 budget/exhausted 的层：同一个停顿只写一条事件，不刷屏 */
  private readonly exhaustedWritten = new Set<BudgetLayer>();
  /** 本 turn 已软提示过的层（内存 Set；重启后重提示一次可接受） */
  private readonly hinted = new Set<BudgetLayer>();
  private hintedTurn: number | null = null;
  /** 本进程内最近一次判定撞刹车的时刻（观测用："已暂停多久"） */
  private exhaustedAt: Date | null = null;

  constructor(deps: BudgetGuardDeps);
  constructor(config: BudgetGuardConfig, options?: BudgetGuardOptions);
  constructor(a: BudgetGuardDeps | BudgetGuardConfig, b?: BudgetGuardOptions) {
    const asDeps = 'projection' in a;
    this.rawLimits = (asDeps ? a.config : a) as Partial<BudgetGuardConfig>;
    this.limits = deriveLimits(this.rawLimits);
    this.projection = asDeps ? a.projection : null;
    this.emit = asDeps ? a.emit : null;
    this.now = asDeps ? a.now : (() => new Date());
    this.softRatioValue = asDeps
      ? pickSoftRatio(a.softRatio ?? a.config?.softRatio)
      : pickSoftRatio(this.limits.softRatio);
    const stallOverride = asDeps ? a.stallMs : b?.stallMs;
    this.stallMsValue = pickLimit(stallOverride, DEFAULT_STALL_MS);
  }

  /**
   * 换一份配置（**限额实时取自 config** 的入口）。
   *
   * 调用场景两条，都在宿主那一侧：
   *   · 进程重启后重新装配判定器（`real-loop.makeGuard`）——那时 `rawLimits` 就是新配置；
   *   · 将来 `budget.*` 真的进了热更白名单（今天它不在，见 `config/watcher.ts` 的
   *     `HOT_RELOAD_FIELDS`），宿主在 `config/changed` 回调里调它一次即可。
   *
   * 已经判出去的账**一律不改写**：撞刹车留下的 `budget/exhausted` 是历史事实，
   * 配置改了它也不会变——"暂停解不解"由 `liftedPauses` 拿新的上限与当刻的已用量现判。
   */
  configure(config: Partial<BudgetGuardConfig>): void {
    this.rawLimits = config;
    this.limits = deriveLimits(config);
    this.softRatioValue = pickSoftRatio(config.softRatio);
    // 上限变了就重新武装"本进程已写过"的标记：新上限下这一层可能还要再撞一次，
    // 不重新武装就等于"改完配置之后这一层再也不会报警"
    this.exhaustedWritten.clear();
    this.hinted.clear();
  }

  // ── 判定：单点事实来源（宿主据此写事件与告警，判定层不替它写） ──

  /** 有效上限 = 基础上限 + 该层累计加注 */
  limitOf(layer: BudgetLayer): number {
    return this.limitOfConfig(layer) + this.topUps[layer];
  }

  /** 该层在投影里的已消耗 */
  actualOf(p: Projection, layer: BudgetLayer): number {
    return usedOf(layer, p);
  }

  /** 撞刹车判定：返回第一个越线的层（step → turn → task → daily） */
  breachOf(p: Projection): BudgetBreach | null {
    for (const status of this.statuses(p)) {
      if (status.over) return { layer: status.layer, limit: status.limit, actual: status.used };
    }
    return null;
  }

  /** 日额度层单独判定（§4.6：达到即拒绝唤醒，而不是结束一个 turn 就了事） */
  dailyBreach(p: Projection): BudgetBreach | null {
    const limit = this.limitOf('daily');
    const actual = p.budget.tokensToday;
    return actual >= limit ? { layer: 'daily', limit, actual } : null;
  }

  /** 失败刹车：连续模型失败达阈值（退避重试由模型客户端负责，这里只判定） */
  failBreach(p: Projection): FailStreakBreach | null {
    const limit = this.limits.failStreakMax;
    return p.failStreak >= limit ? { limit, actual: p.failStreak } : null;
  }

  /**
   * 水位停滞（§4.9）：队列里有输入，而**它自己**已经等了超过阈值没人管。
   *
   * 判据在 {@link stallOf}（唯一一份实现）。这里只负责把本判定器配置的阈值填进去——
   * 运行期 real-loop 直接用 `stallOf` 并带自己的 `deps.stallMs`，两条路径共用同一段逻辑。
   */
  stall(o: Omit<StallObservation, 'stallMs'>): StallInfo | null {
    return stallOf({ ...o, stallMs: this.stallMsValue });
  }

  // ── 加注 ──

  /** 单笔加注（真循环拾取看门文件后调用；事件由调用方先落盘） */
  addTopUp(layer: BudgetLayer, addedTokens: number): void {
    if (!Number.isFinite(addedTokens) || addedTokens <= 0) return;
    this.topUps[layer] += Math.trunc(addedTokens);
    this.exhaustedWritten.delete(layer);
    this.hinted.delete(layer);
  }

  /** 启动恢复：载入从日志折叠出的累计加注（跨重启后有效上限不回退） */
  setTopUps(totals: TopUpTotals): void {
    this.topUps = { ...emptyTopUps(), ...totals };
  }

  /** 当前累计加注快照（观测/测试用） */
  topUpTotals(): TopUpTotals {
    return { ...this.topUps };
  }

  // ── 硬刹车（自带事件写入的形状） ──

  /**
   * step 边界判定（agent-loop 在每一步开始前调用）：返回非 null 即结束本 turn，
   * 结局原样落 `turn/end`。构造里带了 emit 时，本方法负责写 `budget/exhausted`
   * ——limit/actual 属于预算实现，循环层凭空填数字就是伪造事实。
   */
  checkBeforeStep(p?: Projection): TurnEndReason | null {
    const proj = this.project(p);
    const breach = this.breachOf(proj);
    if (breach === null) return null;
    this.exhaustedAt = this.now();
    this.writeExhausted(breach, this.projection ?? proj);
    return { kind: 'budget-exhausted', layer: breach.layer };
  }

  /** 四层状态快照（投影派生，纯读取） */
  statuses(p?: Projection): BudgetLayerStatus[] {
    const proj = this.project(p);
    return LAYER_ORDER.map((layer) => {
      const base = this.limitOfConfig(layer);
      const topUp = this.topUps[layer];
      const limit = base + topUp;
      const used = usedOf(layer, proj);
      const ratio = limit > 0 ? used / limit : 0;
      // step 层是"多余调用"语义：恰好用满 20 次不算越线，第 21 次才越线；
      // 其余三层是"额度用尽"语义：到达上限即停。
      const over = layer === 'step' ? used > limit : used >= limit;
      return {
        layer, used, limit, ratio, over, soft: ratio >= this.softRatioValue,
        composition: { base, topUp },
      };
    });
  }

  /**
   * 该层是否处于「撞刹车且未解除」的暂停态。
   * 从投影派生（`lastExhausted` 存在，且其后没有 `budget/topped-up` / `budget/resumed`），
   * 所以跨重启有效。
   *
   * **注意它读的是那条记录**：记录是不是"已经该解开了"由 {@link liftedPauses} 判——运行时
   * 每拍（与启动时）拿它判一次，该解的就落 `budget/resumed` 把记录清掉，本方法随后自然为假。
   */
  isPaused(layer: BudgetLayer, p?: Projection): boolean {
    return this.project(p).lastExhausted[layer] !== undefined;
  }

  /**
   * **抬上限就该解开的暂停**：判据看活的数，不看那条粘在投影里的历史记录（唯一一份实现）。
   *
   * 四条同时成立才算（缺一条都不解）：
   *   ① 记录不是**不可恢复**的（`resumable: false` 的暂停与"预算用尽"不是一回事，
   *      抬上限不该顺手放行它——见 Projection.lastExhausted）；
   *   ② 这条记录确实是**撞线**留下的（`actual >= limit`）。这一条把"人审挂起超时"那类
   *      暂停挡在外面：它写的是当刻的 limit/actual，已用量通常低于上限，解除条件是"人答了"
   *      （`budget/topped-up{by:'human-answer'}`），不是"上限比已用大了"；
   *   ③ **有效上限真的被抬高了**（比记录里那个上限更高）。没有这一条，step / turn 两层会
   *      在每次计数器归零后产出假解除（"上限没变、只是这一步重新开始数了"），而那种记录该由
   *      它自己的语义去清，不该由"抬上限"这条规则顺手写一条 `topup` 出来；
   *   ④ 当刻**仍然越线就不解**（`statuses().over`，四层各自的越线口径）：新上限没有高过已用，
   *      暂停照旧——否则就是"越过硬停照跑"。
   *
   * 返回的 `limit` / `actual` 就是落进 `budget/resumed` 的两个数（解除的凭据），
   * `reason` 说清上限是谁抬起来的：基础上限高过了记录里那个上限 = 配置改了，否则 = 加注累计。
   */
  liftedPauses(p?: Projection): LiftedPause[] {
    const proj = this.project(p);
    const out: LiftedPause[] = [];
    for (const st of this.statuses(proj)) {
      const record = proj.lastExhausted[st.layer];
      if (record === undefined) continue;          // 这一层本来就没暂停
      if (record.resumable === false) continue;    // ① 不可恢复的暂停：不走这条路
      if (record.actual < record.limit) continue;  // ② 不是撞线留下的记录（例如人审挂起）
      if (st.limit <= record.limit) continue;      // ③ 上限没被抬高：不关这条规则的事
      if (st.over) continue;                       // ④ 当刻仍越线：硬停不动
      out.push({
        layer: st.layer,
        limit: st.limit,
        actual: st.used,
        reason: this.limitOfConfig(st.layer) > record.limit ? 'limit-raised' : 'topup',
      });
    }
    return out;
  }

  /** 本进程内最近一次撞刹车的时刻；未撞过返回 null（观测用，不参与判定） */
  lastExhaustedAt(): Date | null {
    return this.exhaustedAt;
  }

  // ── 软阈值 ──

  /**
   * 软阈值提示：消耗/上限 ≥ softRatio 时给出一句提示，未达返回 null。
   * 每个 turn 每层只提示一次（本 turn 是否提示过用内存 Set 判定；重启后重提示一次可接受，
   * 因为提示本身不改状态、可重复消费）。
   * 多层同时达标时合成一条（否则一次只能提示一层，"每层各提示一次"就会漏）。
   */
  softHint(p?: Projection): string | null {
    const proj = this.project(p);
    const turn = proj.openTurn?.turn ?? 0;
    if (this.hintedTurn !== turn) {
      // 换 turn 即重新武装：上一轮的提示不该压住这一轮
      this.hinted.clear();
      this.hintedTurn = turn;
    }
    const hits = this.statuses(proj).filter((st) => st.soft && !this.hinted.has(st.layer));
    if (hits.length === 0) return null;
    for (const st of hits) this.hinted.add(st.layer);
    return composeHint(hits);
  }

  // ── 恢复（自带事件写入的形状） ──

  /**
   * 加预算：写 `budget/topped-up`（fold 据此清掉 lastExhausted，暂停态解除）。
   * 判定版（宿主自己写事件）请直接调 addTopUp + setTopUps。
   *
   * 另一条解除路径（**不经过本方法**）：上限被调大之后由运行时落 `budget/resumed`
   * ——判定在 {@link liftedPauses}，事件由 `real-loop` 写（"没有加注、只是上限变大了"
   * 不该伪造一条 `topped-up`）。
   */
  resume(layer: BudgetLayer, by: string, addedTokens = 0): void {
    this.emit?.(
      'budget/topped-up',
      { layer, addedTokens, by },
      defaultVisibility('budget/topped-up'),
    );
    this.addTopUp(layer, addedTokens);
    this.exhaustedWritten.delete(layer);
    this.hinted.delete(layer);
  }

  // ── 单步层（工具调用数）──

  /** 单步允许的工具调用数 */
  stepCallLimit(): number {
    return this.limitOf('step');
  }

  /**
   * 按单步上限切分一批调用：超限部分不执行，由宿主记 `tool/result { status: 'over-limit' }`。
   * 切分是纯函数（不改状态），事件与结局分别由 noteStepOverflow 与调用方负责。
   */
  limitStepCalls<T>(calls: readonly T[]): StepCallSplit<T> {
    const limit = this.limitOf('step');
    return { allowed: calls.slice(0, limit), over: calls.slice(limit) };
  }

  /**
   * step 层撞刹车：写 `budget/exhausted { layer: 'step' }` 并给出本 step 的结局。
   * 返回的结局交给循环层原样落 `turn/end`——本 step 就地收束，进度不丢。
   */
  noteStepOverflow(actual: number): TurnEndReason {
    const limit = this.limitOf('step');
    const breach: BudgetBreach = { layer: 'step', limit, actual };
    this.exhaustedAt = this.now();
    // 判定版（无投影）也允许：事件由宿主自己写，这里只记账
    this.writeExhausted(breach, this.projection);
    return { kind: 'budget-exhausted', layer: 'step' };
  }

  // ── 内部 ──

  private limitOfConfig(layer: BudgetLayer): number {
    switch (layer) {
      case 'step': return this.limits.stepTools;
      case 'turn': return this.limits.turnSteps;
      case 'task': return this.limits.taskTokens;
      case 'daily': return this.limits.dailyTokens;
    }
  }

  /** 取投影：显式传入优先，其次构造时注入的那一份 */
  private project(p?: Projection): Projection {
    const proj = p ?? this.projection;
    if (proj === null) {
      throw new Error('BudgetGuard 未持有投影：判定版（config 构造）必须显式传入 projection');
    }
    return proj;
  }

  private writeExhausted(breach: BudgetBreach, p: Projection | null): void {
    if (this.emit === null) return;
    if (this.exhaustedWritten.has(breach.layer)) return;
    this.exhaustedWritten.add(breach.layer);
    // 投影里这个停顿已记过账（例如刚恢复回来就再次越线）——不重复写同一条事实
    if (p !== null && p.lastExhausted[breach.layer] !== undefined) return;
    this.emit(
      'budget/exhausted',
      {
        layer: breach.layer,
        limit: breach.limit,
        actual: breach.actual,
        // 暂停而不是失败：加预算后可以继续（schema §6）
        resumable: true,
      },
      defaultVisibility('budget/exhausted'),
    );
  }
}

// ──────────────────────────────── 小工具 ────────────────────────────────

/**
 * 该层在投影里的已消耗。**这里不重算 token 口径**——投影里的 `tokensTask` / `tokensToday`
 * 已经是 `budgetTokensOf`（非缓存口径）折出来的数，本函数只做"层 → 字段"的搬运。
 */
function usedOf(layer: BudgetLayer, p: Projection): number {
  switch (layer) {
    case 'step': return p.budget.toolCallsThisStep;
    case 'turn': return p.budget.stepsThisTurn;
    case 'task': return p.budget.tokensTask;
    case 'daily': return p.budget.tokensToday;
  }
}

function composeHint(hits: readonly BudgetLayerStatus[]): string {
  const head = hits[0];
  if (head === undefined) return '';
  const detail = hits.map((st) => `${LAYER_LABEL[st.layer]} ${st.used}/${st.limit}`).join('、');
  return `${HINT_TEXT[head.layer]}。（预算：${detail}）`;
}

function pickLimit(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/**
 * 从原始配置解出六个生效上限（**唯一一处**：构造与 `configure` 共用）。
 *
 * 非法值一律退 `FALLBACK_LIMITS`：配置是外部输入，一个 `taskTokens: 0` 或字符串
 * 不该让刹车消失，也不该让进程起不来——退到兜底值仍然是个硬上限。
 */
function deriveLimits(config: Partial<BudgetGuardConfig>): BudgetGuardConfig {
  return {
    stepTools: pickLimit(config.stepTools, FALLBACK_LIMITS.stepTools),
    turnSteps: pickLimit(config.turnSteps, FALLBACK_LIMITS.turnSteps),
    taskTokens: pickLimit(config.taskTokens, FALLBACK_LIMITS.taskTokens),
    dailyTokens: pickLimit(config.dailyTokens, FALLBACK_LIMITS.dailyTokens),
    softRatio: pickSoftRatio(config.softRatio),
    failStreakMax: pickLimit(config.failStreakMax, FALLBACK_LIMITS.failStreakMax),
  };
}

/** 软阈值比例的兜底规则（CLI 的 budget 命令也读它：两处各写一遍必然口径漂移） */
export function pickSoftRatio(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1
    ? raw
    : DEFAULT_SOFT_RATIO;
}
