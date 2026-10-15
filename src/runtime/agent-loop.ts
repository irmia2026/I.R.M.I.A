/**
 * Irmia Agent — 循环引擎（turn / step 双层，M2 核心整合件）
 *
 * 依据：docs/design.md §4.4（循环引擎伪码与 TurnEndReason 枚举）、§4.6（软/硬双阈值）、
 * §4.11（沉默是正常动作）、§4.13（render 协同与五条缓存铁律）、
 * docs/schema.md §2 / §3 / §6 / §12 / §13。
 *
 * 职责范围：从「一批已落库的唤醒输入」走到「一个结构化的 turn 结局」。它自己不做的事：
 * 调度（何时唤醒）、刹车（阈值判定）、工具实现、恢复补偿（runtime/recover.ts）。
 *
 * 三条必须守住的语义：
 * 1. **日志是唯一真相源**：本文件不持有任何权威状态。投影只是日志的折叠结果，
 *    写入一律「先 append（承诺类 fsync）→ 再 applyOne」，与 runtime/loop.ts 同一条纪律。
 * 2. **两条写入节奏**（§4.1）：承诺类（turn/start、input/claimed、message/*、tool/*、
 *    step/*、turn/end）逐条 fsync；观测类（budget/consumed、tool/zombie）进缓冲，
 *    在 step 边界 flush()。承诺类丢一条就是「现实变了但日志没有」。
 * 3. **请求可重建**（M2-2）：step 内 `now` 只取一次，step/start 的 ts 与渲染用的 now
 *    是同一个值。重建请求 = 取「seq < step/start.seq 的事件」+ 该 step 认领的首条 wake
 *    + step/start.ts 作为 now，交给 deriveRequest()——与运行期走同一份派生代码。
 *
 * 与 render 的两条协同契约（不写清就会踩缓存铁律）：
 * - `events` 参数**不含**本轮作为 `wakeEvent` 传入的那条事件。否则同一输入被渲染两次
 *   （事件流一次 + 尾部新输入一次），且相邻两步的请求不再构成前缀关系，KV cache 全 miss。
 * - `wakeEvent` 只在 turn 的首 step 传。后续 step 的 wake 事件已在事件流里按 seq 渲染。
 *
 * 一批多条唤醒输入的取舍：render 每轮只接受一个 `wakeEvent`，所以只有批内首条走参数通道，
 * 其余仍留在事件流里按 seq 渲染——信息不丢，代价是首步的输入顺序与日志顺序不完全一致。
 * 单条唤醒（定时器、CLI 注入、webhook 的主流形态）不受影响，前缀关系完好。
 *
 * 对给定接口的构造性补充（全部可选，默认值即安全默认）：
 * - `lane` / `modelVisibility` / `workspaceRoot` / `signal` / `isolation`：
 *   executeToolCalls 必须拿到 workspaceRoot 与（可选的）隔离配置，模型请求必须知道 lane，
 *   外部取消（shutdown）必须能从循环外传进来。缺了它们，本模块无法被真实宿主装配。
 *
 * M2 明确留到后续的边界（都在此声明，避免"看着像做完了"）：
 * - 软阈值提示（§4.6）只做尾部插播，**不落库**：因此带软提示的那一次请求不可逐字节重建。
 *   M3 落地预算时才有正式记录通道。不带软提示的请求（默认路径）严格可重建。
 *   Hook 的附加上下文（§4.19）走同一条尾部通道（两者合并成一条 developer 消息），
 *   因此同样属于「不可逐字节重建」的那一类：注入内容是执行期事实，不进日志正文。
 * - 撞刹车时本模块只返回结局，不写 `budget/exhausted`——limit/actual 属于预算实现，
 *   循环层凭空填数字就是伪造事实（M3 的 budget 钩子写它）。
 * - 大工具结果外置 blob（§4.12）已接：`blobOffload` 配上后，超阈值的结果先写
 *   `data/blobs/`（内容寻址），事件的 content 只留头部预览 + `contentRef`。
 *   不配则全文入日志（默认口径，M2 的最小宿主行为不变）。
 * - 事件快照按 render 的契约持有全量事件；长日志下的内存有界化（快照起点 + 分片）
 *   与上下文压缩（§4.13 遮蔽点）同批做，M2 不做。
 * - `budget/consumed.retryCount` 恒为 0：成功路径没有重试计数通道（DsClient 只把 attempts
 *   挂在外抛错误上），M3 接 onRetry 回填。
 *
 * 约定：值导入写 `.ts`（Node 的 --experimental-strip-types 只擦类型、不改写路径解析），
 * 纯类型导入写 `.js`。
 */

import type { DsClient, DsRequest, DsStreamResult } from '../model/ds-client.js';
import { isDsClientError } from '../model/ds-client.ts';
import type { MachineFacts, MaintenanceWindowNote, RenderImageRef, RenderPersona, RenderedRequest, TurnBlockFacts, UsageFacts } from '../model/render.js';
import { RENDER_VERSION, clipTaskTitle, render, renderWake, stateBytesOf, wakeTitle } from '../model/render.ts';
import { DEFAULT_STATE_BUDGET_BYTES } from '../config/config.ts';
import {
  DEFAULT_CACHE_BREAK_THRESHOLDS, detectCacheBreak,
  type AuditedCall, type CacheBreakThresholds,
} from '../model/context-audit.ts';
import type { ContactFacts } from '../model/self-brief.ts';
import { renderMentionNote } from '../model/self-brief.ts';
import { sidOf } from '../channel/sessions.ts';
// 待办清单的唯一载体是 STATE 的两节（见 persona/todo-state.ts）：任务卡只从那里读
import { openTodoItems } from '../persona/todo-state.ts';
import type { EventLog } from '../log/event-log.js';
import type {
  AppEvent, AppEventType, CompactionDecision, MemorySelected, ModelLane, Projection,
  ToolsInventoryChanged, ToolResultStatus, TurnEndReason, WakeSource,
} from '../log/types.js';
import { defaultVisibility, type ContextImageChosen } from '../log/types.ts';
import {
  DEFAULT_HANDOFF_BUDGET_TOKENS, DEFAULT_HANDOFF_FOLD_TOKENS,
  estimateHistoryTokens, estimateMaskedTokens, mechanicalSummaryText,
  renderHandoffNote, type HandoffOptions,
} from '../persona/handoff-note.ts';
import { applyOne, wakeSourceOf } from '../state/fold.ts';
// 毒消息保护的阈值与崩溃恢复共用一处：同一条输入反复认领仍没跑完就进死信
//（recover.ts 的 settleClaimedInputs 也用它）——两处各写一个数，迟早会分岔。
import { MAX_CLAIM_COUNT } from './recover.ts';
import { offloadIfLarge, type BlobOffloadOptions } from '../state/blob-store.ts';
import type {
  ExecutionContext, IsolationConfig, ToolCallRequest, ToolExecutionResult, ToolPlanGate,
} from '../tools/executor.js';
import { executeToolCalls } from '../tools/executor.ts';
import { notedWarningsOf } from '../channel/injection.ts';
import type { WarnExemptJudge } from '../channel/warn-exempt.ts';
import { ASK_HUMAN_BLOCKED_BY, hasPendingSystemAsk, pendingAgentAsks } from './plan-mode.ts';
import type { ListForModelOptions, ToolDefinition, ToolModelSpec } from '../tools/registry.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookRunner } from '../hook/hooks.js';
// 本轮可信级别的**唯一来源**（`runtime/trust.ts` 的 `trustOfBatch`）：循环层不判它、只把它记进账
import type { TurnTrust } from './trust.js';

// ──────────────────────────────── 常量 ────────────────────────────────

const ORIGIN = 'runtime/agent-loop';

// ──────────────────── 工具软提醒：连续重复调用（唯一一处实现） ────────────────────

/**
 * 同参数连续调用到第几次开始提醒（"超过 3 次" = 第 4 次，严格大于）。
 *
 * 判据（全部只在本节实现，别在别处再数一遍）：
 *   · 数的是**同一 turn 内**的**连续**调用，从最近一次"换了工具名"起算；
 *   · 同参数 = 工具名 + `canonicalArgumentsOf`（键排序、去 undefined；**字符串大小写与空白不归一**
 *     ——没有依据说明 `a` 与 `A` 是同一个参数，把不同的参数当同一个就变成误报）；
 *   · 本阈值与 {@link REPEAT_TOOL_THRESHOLD} **各算各的**，两条同时命中只提醒一次。
 */
export const REPEAT_SAME_ARGS_THRESHOLD = 3;

/** 同工具（参数不计）连续调用到第几次开始提醒（"超过 5 次" = 第 6 次，严格大于） */
export const REPEAT_TOOL_THRESHOLD = 5;

/**
 * 提醒的**间隔**：第一次跨过阈值之后，至少再隔这么多次调用才提醒下一次（不是每次都提醒）。
 *
 * 为什么必须有它：这是**常驻进她上下文**的东西，每一次后续调用都插一句就是刷屏——刷屏的提示
 * 等于没有提示。所以现场读数是「同一串同参数的第 4、7、10…次各一句」（两条阈值都跨过时也
 * 只算一句；第 5、6 次没有第二句，第 6 次那句并进第 7 次）。
 *
 * "至少"两个字是 ⑥b 那条用例逼出来的：两条阈值各有各的跨点，若各按各的间隔复算，同一次调用
 * 会被两条判据同时判成"该提醒"，紧接着的下一次又被另一条判成"该提醒"——第 6、7 次连着两句，
 * 正是这条规则要防的。所以间隔按**上次真提醒的位置**算（见 {@link RepeatGuard.reminderDueAt}）。
 */
export const REPEAT_REMINDER_STRIDE = 3;

/** 一次调用的连续重复计数（纯事实，由 {@link RepeatGuard} 维护） */
export interface RepeatCount {
  /** 工具名 */
  tool: string;
  /** 规范化入参 */
  argsKey: string;
  /** 同工具连续第几次（含本次） */
  toolRepeats: number;
  /** 其中同参数连续第几次（含本次） */
  sameArgRepeats: number;
}

/**
 * 连续重复调用的计数器（**turn 级状态**：判据就是"同一 turn 内、同一串连续调用"）。
 *
 * 为什么是一个类而不是"在 recordToolResult 里数一数"：调用顺序在 `executeCalls` 里**成批推进**
 * （同一步的并行调用各自落库，交接顺序由执行器的提交链保证），所以顺序判据必须在**执行之前**
 * 由唯一一处算定——在这里。落库那一侧只负责把算好的那句话贴到回执上。
 */
class RepeatGuard {
  private tool: string | null = null;
  private argsKey = '';
  private toolRepeats = 0;
  private sameArgRepeats = 0;
  /** 本 turn 记过的调用次数（提醒间隔以它为坐标） */
  private calls = 0;
  /** 上一次真提醒发生在第几次调用（0 = 还没提醒过） */
  private remindedAtCall = 0;

  /** 记一次调用，返回它此刻的连续重复计数（换了工具名即重新起算） */
  note(tool: string, argsKey: string): RepeatCount {
    this.calls += 1;
    if (tool !== this.tool) {
      this.tool = tool;
      this.argsKey = argsKey;
      this.toolRepeats = 1;
      this.sameArgRepeats = 1;
    } else {
      this.toolRepeats += 1;
      this.sameArgRepeats = argsKey === this.argsKey ? this.sameArgRepeats + 1 : 1;
      this.argsKey = argsKey;
    }
    return { tool, argsKey, toolRepeats: this.toolRepeats, sameArgRepeats: this.sameArgRepeats };
  }

  /**
   * 本次调用该不该提醒（唯一判据）。**两条阈值各算各的**：
   *   · 同参数：`sameArgRepeats >= REPEAT_SAME_ARGS_THRESHOLD + 1`（第 4 次起）；
   *   · 同工具：`toolRepeats >= REPEAT_TOOL_THRESHOLD + 1`（第 6 次起）。
   *
   * 跨过之后按 {@link REPEAT_REMINDER_STRIDE} 的间隔复用，且间隔从**上一次真提醒**起算——
   * 两条阈值都到点时也只算一句（同一句提示不必说两遍），且两句之间至少隔 `STRIDE - 1` 次调用。
   * 读数是「同一串同参数」：第 4、7、10… 次（第 5、6 次不带第二句；第 6 次那句并进第 7 次）。
   */
  reminderDueAt(count: RepeatCount): boolean {
    const crossedSameArgs = count.sameArgRepeats > REPEAT_SAME_ARGS_THRESHOLD;
    const crossedTool = count.toolRepeats > REPEAT_TOOL_THRESHOLD;
    if (!crossedSameArgs && !crossedTool) return false;
    // 最近一次提醒之后还不足间隔：不提醒（这一句就是"别刷屏"）
    if (this.remindedAtCall !== 0 && this.calls - this.remindedAtCall < REPEAT_REMINDER_STRIDE) return false;
    this.remindedAtCall = this.calls;
    return true;
  }
}

/**
 * 规范化的入参：递归排序对象键、丢掉 `undefined`，数组保序（顺序是参数的一部分）。
 *
 * **刻意不做**的三件事：不折叠大小写、不裁剪空白、不解析数字/字符串的等价（`"1"` ≠ `1`）——
 * 没有依据说明那些是不同的写法表达了同一个意图，而归一过头会把"不同的参数"判成"同一个参数"，
 * 于是提醒在她**正在换参数试探**的时候响起来，正好把该提示的场景变成误报。
 *
 * 入参不是合法 JSON 时退**原文**：原文相同 = 每次都拿着同一份（含坏掉的）参数在试，算同参数；
 * 原文不同 = 判不出来，宁可不算同参数。`tool/call` 落的就是这份原文（schema §4）。
 */
export function canonicalArgumentsOf(rawArguments: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return rawArguments;
  }
  return canonicalValue(parsed);
}

function canonicalValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(',')}]`;
  const doc = value as Record<string, unknown>;
  const parts: string[] = [];
  // 键排序：`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 是同一个参数（JSON 对象无序）
  for (const key of Object.keys(doc).sort()) {
    // 丢掉 undefined：它等于"这个键不在"，JSON 里本来也表达不出来
    if (doc[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalValue(doc[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * 软提醒的正文（**逐字**：这是进她上下文的东西，措辞改动要当成行为改动看）。
 *
 * 五件必须说清的事，缺一件这句提示就会误导她：
 *   ① 这是连续第几次调这个工具、其中同参数几次（她据此判断"我是不是卡住了"）；
 *   ② 重复调用过多，考虑检查参数或重新决定策略（软提醒的唯一诉求）；
 *   ③ **两条正当出路**：需要等 ⇒ `timer wait`；需要重新想 ⇒ 直接停下重新规划。
 *      没有这两句，她收到"别重复"之后只剩"硬着头皮再试一次"这一条路；
 *   ④ **豁免说明**：逐个处理不同目标（多文件 `safe_read`、逐个 `safe_check`）也会命中"同工具"，
 *      那是**有意的重复**，不是错——不说这句她会以为自己违规了；
 *   ⑤ 短：它随那一步的结果常驻上下文。
 */
export function repeatCallReminder(count: RepeatCount): string {
  return `[框架提示] 这是连续第 ${count.toolRepeats} 次调用 \`${count.tool}\``
    + `（其中同参数 ${count.sameArgRepeats} 次）。重复调用工具过多，考虑检查参数或重新决定策略：`
    + '需要等就用 `timer wait`，需要重新想就直接停下重新规划。'
    + '（如果你是在逐个处理不同的目标，忽略这条。）';
}

// ──────────────────── 同一个目标的失败连击：一轮内拒绝再调它（唯一一处实现） ────────────────────

/**
 * 同一个目标**连续**失败/超时到第几次起就拒绝再调它（连续 `3` 次 ⇒ 第 4 次起拒）。
 *
 * 为什么要有这条硬守卫（2026-10-10 的事故）：`read_channel` 在一个消息量很大的群上会**结构性**
 * 超时（`admin.ts` 给它 `timeoutMs: 10_000`），她一轮里把 `limit` 换了 20 次（6/8/10/12）反复
 * 重试，自己也说了"停了停了，我刚才钻死循环了"，**然后又调了一次**。
 *
 * 软提醒（{@link repeatCallReminder}）为什么拦不住它：软提醒只数**调用次数**、从不看结果，
 * 而她每一次都"改了参数"——`sameArgRepeats` 每次都回到 1，那两句提示在她读来正是
 * "再换个参数试试"的意思。所以判据必须换成"**同一个目标连续失败了几次**"。
 *
 * 为什么是 3：允许的每一次都真付一次超时代价（`read_channel` 10 s、`pwsh` 60 s），而同一个目标上
 * **连续**三次超时已经不是抖动、是结构问题（目标不可达，或那个会话就是读不出来）。取 1 会把偶发
 * 抖动误杀；取更大等于把"再烧三次 10 秒"当默认。
 */
export const FAILURE_STREAK_MAX = 3;

/**
 * **"什么算同一个目标"的唯一判据**——工具层与循环层都不许再判一遍。
 *
 * 返回 `null` = 这件工具**没有"目标"这个概念**，失败连击守卫不管它。2026-10-10 的口径是只做
 * `read_channel` 这一条路，所以这里**只认它**：别的工具的名字/参数/描述一个字都不碰，也不给它们
 * 猜一个"目标"（猜错就是误杀，而误杀比漏拦贵得多）。
 *
 * 为什么只认 `read_channel` 的 `sid`：它的失败是**冲着那个会话**去的——同一个 sid 上换 `limit`、
 * 换 `before` 都还是"再读一次同一个群"，那正是要拦的那件事。而"同一件工具"这个粒度太粗：
 * 她一轮里读十个不同的会话是**正当的**，不该被算成一串失败。
 *
 * 判不出来就返回 `null`（不是合法 JSON、不是对象、`sid` 不是非空字符串）：**判不出来就不拦**——
 * 判据只往"确定是同一个目标"那一侧收，宁可少拦一次也不误杀。
 */
export function toolTargetOf(tool: string, rawArguments: string): string | null {
  if (tool !== 'read_channel') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const sid = (parsed as Record<string, unknown>)['sid'];
  return typeof sid === 'string' && sid !== '' ? sid : null;
}

/**
 * 拒绝那一次的**回执正文**（逐字：这是进她上下文的东西，措辞改动要当成行为改动看）。
 *
 * 三件必须说清的事，缺一件这句回执就会误导她：
 *   ① **是哪个目标、这一轮已经连续失败几次**——她据此知道"不是我参数没调对"（这正是现场那句
 *      "缩小参数范围"的错处：它把结构性超时归因到参数上，于是她一次次改 `limit`）；
 *   ② **别再试了**（唯一诉求——"换个参数再来一次"正是这一版要掐掉的行为）；
 *   ③ **两条出路**：换做法，或如实报告用户。不给她"硬着头皮再试一次"这条路，也不许她
 *      假装这件事办成了。
 */
export function failureStreakRefusal(tool: string, target: string, streak: number): string {
  return `工具 ${tool} 在 ${target} 这个目标上这一轮已经连续失败 ${streak} 次，别再试了——`
    + '换做法，或如实报告用户。';
}

/** 派发前的裁决：拒的那一支带上理由要用的两个数（否则调用点得自己再算一遍） */
export type FailureStreakVerdict =
  | { refused: false }
  | { refused: true; target: string; streak: number };

/**
 * **同一个目标**的失败连击计数（turn 级状态：判据是"这一轮内、同一件工具 + 同一个目标"）。
 *
 * 为什么是一个类、而不是"在落回执那里数一数"：判"该不该拒"必须发生在**派发之前**（否则又白付
 * 一次 10 s 超时），而"已经失败几次"要等结果回来才知道 ⇒ 派发前问一次、结果落地时记一次，
 * 两处必须读同一份状态。而"什么算同一个目标"只有 {@link toolTargetOf} 一处实现（那是本类唯一的
 * 分桶依据，工具层不参与判断）。
 *
 * 三条"不许误杀"的纪律（与 2026-10-10 的口径逐条对应）：
 *   · **换目标不算**：按 (工具, 目标) 分桶，她一轮里读十个会话互不影响，别的工具压根不进桶；
 *   · **只有真失败/超时累加**：`ok` 清零；`denied` / `aborted` / `over-limit` / `unknown` 这些
 *     **框架侧**的终态既不累加也不清零（"这次没派发"不等于"这个目标试过又失败了"）；
 *   · **成功即清零**（`failed.delete`）。
 *
 * **第四条（2026-10-10 接上「进展判据」）：有进展就说这一串连击结束了 ⇒ 计数重置为 1。**
 *
 * "有进展"的判据是 {@link FailureStreakGuard.settle} 里那一句（**唯一一处**）：
 * **这一轮里有没有一次工具调用真的办成了**（`status:'ok'`），与它落在哪个工具/哪个目标上无关。
 * 为什么是这个而不是"这一轮 assistant 产出变多了"（另一种口径：数一数这一段的 assistant 条数
 * 有没有涨）——**在本仓它恒为真**：`stepOnce` 每一步都写一条 `message/assistant`，连"只发一个失败
 * 调用"的那一步也写。照它重置等于把守卫删掉，而现场那种"一轮 58 次、每一步都还有一句话"的死循环
 * 恰恰是最需要守卫的时候。判据必须落在一件**真的改变了她处境**的事上：与投影 `failStreak` 的既有
 * 口径同源（`state/fold.ts` 的 `budget/consumed`：模型调用成功 ⇒ `failStreak = 0`）——"成功即进展"
 * 是本仓已经用过一次的判据，不新造一套。
 *
 * 重置为 **1**（不是 0、也不是"这次失败不算"）：刚落的这一次失败就是**新一轮的第一笔**——抹成 0
 * 等于"这次失败没发生过"，"连续"两个字就没了意义（另一套实现的口径同此）。
 */
class FailureStreakGuard {
  /** key → 已结算的**连续**失败次数 */
  private readonly failed = new Map<string, number>();
  /**
   * key → **本批**已放行、结果还没回来的次数。
   *
   * 为什么需要它：一次 `executeCalls` 里的多个调用**全都在任何结果回来之前**过判据（同一步里
   * `executionMode: 'parallel'` 的还会并发跑）。只看已结算的失败数，一批 4 个同目标的调用会一起
   * 放行——守卫就变成"一次多要几个"可以绕过的东西。
   *
   * 为什么它**只在批内**有效（每批 {@link beginBatch} 清空）：它是**预扣**，不是事实。若那批调用
   * 其实都成功了，预扣留着就会在下一次调用上变成误杀。它绝不跨批存活，所以不可能泄漏成假计数。
   */
  private batch = new Map<string, number>();
  /**
   * 本 turn 已结算的结果笔数（给下面两个"发生在第几笔"的坐标当尺子）。
   *
   * 为什么用笔数而不是时间戳：判据要能在测试里**逐笔复现**（同一串事件永远得到同一个结论），
   * 而时钟在渲染层与投影层都是禁读的——这里读一次就会让"同一份日志 ⇒ 同一个结论"这条承诺作废。
   */
  private settled = 0;
  /** 最近一次**有进展**（一次 `ok`）发生在第几笔；`0` = 这一轮还没有过 */
  private progressedAt = 0;
  /** key → 这个目标**上一次失败**发生在第几笔（没有过就不在表里）：用来判"失败之后有没有进展" */
  private readonly failedAt = new Map<string, number>();

  /** 一批调用开始（`executeCalls` 每次进它一次）：丢掉上一批的预扣 */
  beginBatch(): void {
    this.batch = new Map();
  }

  /**
   * 派发前问一次（唯一判据）。`streak` 回的是"已结算失败 + 本批已放行"——它就是回执里报给她的 N。
   *
   * 拒的那一支**不预扣**：拒了就没有"在途"，而 `failed` 已经 ≥ 上限，于是这一轮里后续每一次
   * 到同一个目标都会被拒（"这一轮内拒绝再调它"）。
   */
  admit(tool: string, rawArguments: string): FailureStreakVerdict {
    const target = toolTargetOf(tool, rawArguments);
    if (target === null) return { refused: false };
    const key = `${tool}\u0000${target}`;
    const streak = (this.failed.get(key) ?? 0) + (this.batch.get(key) ?? 0);
    if (streak >= FAILURE_STREAK_MAX) return { refused: true, target, streak };
    this.batch.set(key, (this.batch.get(key) ?? 0) + 1);
    return { refused: false };
  }

  /**
   * 结果落地时记一笔。`status` 是**执行器**给的终态，这里只查表、不在循环层重判"这算不算失败"
   * （重判就是又一处判据）。
   *
   * 认的是**实际执行的那份参数**：PreToolUse 钩子改写过的调用连 `tool/call` 落的都是改写后的
   * 那一份，失败当然也该记在改写后的目标上。
   *
   * `status === 'ok'` 那一句就是**「有进展」的唯一判据**（见类头第四条）：
   *   · 它必须放在下面那个"没有目标就返回"**之前**——一次成功无论落在什么工具上都说明这一轮在
   *     往前走（`safe_read` 读到了文件、`speak` 把话说出去了都算），而**没有"目标"概念的工具有很多**，
   *     放在后面等于把它们全漏掉；
   *   · 框架侧的终态到不了这里（钩子/计划模式拦下的调用不写 `tool/call`、不回调 `onToolResult`；
   *     `over-limit` 由循环层自己写事件、同样不走这里）⇒ 它们**既不算进展也不算失败**，
   *     这一条不是靠 if 拦出来的，是**没有路径能到**。
   */
  settle(tool: string, rawArguments: string, status: ToolResultStatus): void {
    this.settled += 1;
    if (status === 'ok') this.progressedAt = this.settled;

    const target = toolTargetOf(tool, rawArguments);
    if (target === null) return;
    const key = `${tool}\u0000${target}`;
    if (status === 'ok') {
      this.failed.delete(key);
      return;
    }
    if (status === 'timeout' || status === 'error') {
      // 有进展（这个目标上一次失败之后，这一轮里办成过一件事）⇒ 重置为 1；无进展 ⇒ 照旧 +1。
      // 现场那种形状（58 次全是同一个目标的超时，中间没有任何一次成功）走的是 +1 那一支，
      // 所以"连续 3 次 ⇒ 第 4 次拒"的拒绝语义**没有被放宽**。
      const progressed = this.progressedAt > (this.failedAt.get(key) ?? 0);
      this.failed.set(key, progressed ? 1 : (this.failed.get(key) ?? 0) + 1);
      this.failedAt.set(key, this.settled);
    }
  }
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 人格资产：渲染需要的三常驻层 + 状态层，外加进 step/start 的指纹 */
export interface AgentLoopPersona {
  identity: string;
  constitution: string;
  style: string;
  state: string;
  /** 人格资产内容哈希（step/start 留档；重放时据此取对应版本） */
  personaHash: string;
  /** 情景档案：唤醒路由命中时注入 */
  relationship?: { who: string; content: string } | null;
}

/** 刹车钩子（M3 实现于 runtime/budget-guard.ts，循环层只调用） */
export interface AgentLoopBudget {
  /** step 边界判定：返回非 null 即结束本 turn（结局原样落 turn/end） */
  checkBeforeStep: (projection: Projection) => TurnEndReason | null;
  /** 软阈值提示（§4.6）：非空则作为尾部 developer 消息插播到本次请求末尾 */
  softHint?: (projection: Projection) => string | null;
  /** 单步工具调用数上限（§4.6 单 step 层）；不传即不限制 */
  stepCallLimit?: () => number;
  /**
   * 单步超限时的结局：预算实现写 budget/exhausted 并给出 reason。
   * 不传时循环层只做收束、返回 budget-exhausted(step)，不凭空写预算事件。
   */
  onStepOverflow?: (actual: number) => TurnEndReason;
}

/**
 * **压缩预警的账**（2026-10-15）：`compaction/decision` 上新增的那一格。
 *
 * 取别名而不是另写一份接口：形状的**唯一出处**是 `log/types.ts` 里的 `CompactionDecision`
 * （事件是契约，改了那里两处一起变）。这里只给它一个短名字，免得调用点写一长串下标类型。
 */
export type CompactionWarning = NonNullable<CompactionDecision['data']['warning']>;

export interface AgentLoopDeps {
  /** 事件写入：本模块所有落库都经它（承诺类 sync: true） */
  log: EventLog;
  /** 模型客户端 */
  ds: DsClient;
  /** 工具注册表：listForModel 供给请求，executionMode/sideEffect 供给执行器 */
  registry: ToolRegistry;
  /** 运行期投影：每条新事件写入后立即 applyOne 维护 */
  projection: Projection;
  persona: AgentLoopPersona;
  /** 时钟注入（运行期允许读时钟；fold 与 render 都不读） */
  now: () => string;
  /** 时区标识，进状态层时间上下文 */
  timezone: string;
  /** 刹车钩子；不传即无刹车（M2 的默认口径） */
  budget?: AgentLoopBudget;
  /** 主循环 lane（§4.12 任务-模型两级路由），默认 heavy */
  lane?: ModelLane;
  /** 文件类工具的路径白名单根；默认 process.cwd() */
  workspaceRoot?: string;
  /**
   * 活动边界根（`config.trust.mode` 的执行形态，见 `tools/types.ts` 的 `ToolContext.boundaryRoot`）：
   * `undefined` = 用 [workspaceRoot] 当边界（历史行为）；`null` = 不设边界；string = 只限该根。
   *
   * 它在**装配层**由 `trustBoundaryRoot(config.trust)` 算出（real-loop 与子代理各转手一次），
   * 循环层只负责透传给执行器——循环层不读配置，与 `workspaceRoot` 同一条纪律。
   */
  boundaryRoot?: string | null;
  /** 外部取消（shutdown）：透传给模型请求与工具执行 */
  signal?: AbortSignal;
  /**
   * 「有人插话」计数读取器：返回一个**只增不减**的计数，本 turn 里人每开口一次加一。
   *
   * 为什么不是 AbortSignal：信号一旦触发就永远是触发态，而她一轮里可能说好几次话——
   * 实测后果是打断一次之后，这一轮剩下的每一次 speak 都被判成"又被打断"。
   * 计数让"重新组织语言再开口"成为可能：新的一次发言取新基准，只有基准之后**又来**了
   * 插话才算被打断。目前只有 `speak` 消费它。
   */
  interruptEpoch?: () => number;
  /** 进模型清单的工具口径；默认 {}，即 destructive 工具默认不列（§4.10 第三级门） */
  modelVisibility?: ListForModelOptions;
  /**
   * **本轮的可信级别**（`owner` / `self` / `trusted` / `external`），2026-10-11 加。
   *
   * 唯一的用处是**观测**：`accountStep` 把它落进 `budget/consumed.context.trust`
   * ——这一格**一个字节都不进请求体**（`context` 本来就不进，见 `ContextBreakdown.trust`），
   * 所以它**不改任何判据、也不动 `RENDER_VERSION`**。
   *
   * 为什么必须由宿主给、循环层自己不判：判据在 `runtime/trust.ts` 的 `trustOfBatch` 一处，
   * 而它要的是**唤醒批次 + 联系人表 + 用户 id 集合**——那三样都在宿主手里（`real-loop` 的
   * `trustOfTurn`）。循环层不读配置、不读联系人表（与 `workspaceRoot` / `boundaryRoot` /
   * `contact` / `machine` 同一条纪律：**渲染与循环都不读盘**，事实由宿主递进来）。
   *
   * **缺省 ⇒ 事件里那一格不出现**（不是"编一个 owner"）：子代理链、诊断、以及所有既有
   * 测试都不传它——它们的请求字节与事件形状因此与引入这一格之前**逐字节相同**。
   *
   * ⚠ 它与 `modelVisibility` 是**同一个判定的两半**（`real-loop.agentDeps` 里两行紧挨着，
   * 都读那一个 `trust` 局部量）：清单按它收紧，账按原样记它。两处读同一份结论，
   * 所以日志里那一格**必然**能解释清单为什么是那一版——这正是它存在的理由。
   */
  trust?: TurnTrust;
  /**
   * 「这条唤醒是**框架自己的动作**、不是给人的输入」的判定，由宿主注入（2026-10-11 加）。
   *
   * **为什么需要它**：`claimDeliveredInputs()` 的判据是"送进这一份请求的输入＝她看见了"，
   * 而它原先只看 `pending` 的 seq（到没到、本 turn 记过没有），**一个字节都不看 payload**。
   * 于是每日记忆整理的唤醒（`{kind:'memory-maintain'}`）在 turn 跑着的时候到达时被当普通输入
   * 销账 + 送进请求体：turn 正常跑完 ⇒ 没有安全网 ⇒ **那条唤醒永久消失**。
   * 实测 10-08 那一天：`memory/maintained` 全窗口唯一缺的就是它，`diary/2026-10-08.md` 永久没有
   * （10 次自动 cron 丢 1 次；见 `D:\IrmiaAgent\_ops-light2\REPORT.md` ③）。
   *
   * **为什么是回调、不是在这里 import 业务常量**：判据只该有一份。整理唤醒的判据住在
   * `runtime/real-loop.ts`（`isMemoryMaintainPayload`，布防/认领两处共用），循环层 import
   * 业务模块会把它变成第三份实现——那正是"两处记一套，迟早漂"的老形状。
   * 与 `memoryHostingEnabled` 的注释同一条纪律：判据由上层注入。
   *
   * **缺省 = 一条都不排除**：子代理链、诊断、以及所有既有测试都不传它，
   * 行为与引入这一格之前逐字节相同。
   */
  isFrameworkWake?: (event: AppEvent) => boolean;
  /** 子进程隔离配置，原样透传给执行器（不响应中断的工具走隔离，超时即杀） */
  isolation?: IsolationConfig;
  /**
   * 单条工具回执的上限（design §4.12 磁盘经济学、schema §4 的 contentRef）：配上即开启，
   * 不配即全文入日志（M2 口径——最小宿主与单元测试不需要 blob 目录）。
   * 判定与写入在 state/blob-store.ts，这里只负责"先落 blob、再写事件"的顺序。
   *
   * **上限有两个维度**（2026-10-06：{@link BlobOffloadOptions.thresholdTokens} 估算 21k +
   * {@link BlobOffloadOptions.maxBytes} 64 KiB，取小），它们一起构成"一条回执最多进多少
   * 上下文"的界。**定形只发生在 {@link TurnRunner.recordToolResult} 这一处、这一刻**：
   * 事件一旦写下，后续任何维护（压缩、交接、恢复）都不回来改它——"扫历史发现超限再剪一次"
   * 那条路本仓没有，也**不许有**（可见前缀每轮都变 = 缓存永远命不中；先例见 blob-store 的文件头）。
   *
   * @see BlobOffloadOptions —— 三个上限都可覆盖；生产走默认值（`real-loop` 的 agentDeps）。
   */
  blobOffload?: BlobOffloadOptions;
  /** 压缩触发（M5 临时口径，persona.md §4 / design.md §4.13）；不传即不压缩 */
  compaction?: AgentLoopCompaction;
  /**
   * 本轮的**收尾计时**（2026-10-11 加，BUG-4；纯观测，缺省 = 不报）。
   *
   * 为什么需要它：`runtime/slow-tick` 只记了"这一拍总共多久"（实测有 131 s 与 221 s 的），
   * 而诊断明确写了"没有刻度可判"——分不清**模型往返慢**与**收尾的同步扫描把事件循环占死**
   * （`maybeCompact` 里的 `renderHandoffNote` / `countMaskedEvents` / `estimateMaskedTokens`
   * 都声称 O(事件数)，而那一刻日志已到 7.8 万条）。两者都表现为 `elapsedMs` 很大、`busy=false`。
   *
   * 刻度的分工（**判据一个都不动**，只加观测）：
   *   · `turnMs`    —— 整轮（`run()` 从头到尾，含压缩那一段）；
   *   · `compactMs` —— **收尾那一段**（`maybeCompact`：判定 + 交接笔记渲染 + 摘要落盘），
   *     恒 ≤ `turnMs`。它与 `turnMs - compactMs` 一比，"花钱在等模型"与"花钱在自己扫日志"就分开了；
   *   · `events`    —— 那一刻日志的事件条数（那几个扫描的**规模输入**，也是本仓涨势的读数）。
   *
   * 它**不参与任何判据**：压缩阈值、遮蔽点、写不写摘要，一个都不看它（诊断的口径是
   * "补刻度之前不要动阈值"，这里只补刻度）。回调抛错也不许影响这一轮——调用点包了 try。
   */
  onTurnTiming?: (timing: TurnTiming) => void;
  /**
   * 技能 catalog 文本（design §4.19 渐进披露第 1 层）。缺省/null 表示没有可用技能，
   * 状态层该段整体不出现；SKILL.md 正文永不在此——模型按需自己 safe_read（M7-4）。
   */
  skillCatalog?: string | null;
  /**
   * MCP 索引文本（v46：与技能 catalog **同源同性质**的状态层素材，见 render.ts 的
   * `RenderInput.mcpIndex` 与 `mcp/index` 事件）。
   *
   * **它必须来自日志里那条快照**，不许每轮从实时配置现渲染：这一段在请求头部（最大公共前缀
   * 的第一格），现渲染会让"加一个 server"立刻改掉前缀——而用户的设计是"增删只追加在末尾、
   * 到重大变化点才归集"。判据与三种重建触发点写在 `real-loop` 的 `mcpIndexSync` 上。
   *
   * 循环层只转手（与 `skillCatalog` 同一条纪律）；缺省/null/空串 = 该段整体不出现
   * （老日志、子代理、诊断都是这一支 ⇒ 渲染结果与引入它之前逐字节相同）。
   */
  mcpIndex?: string | null;
  /**
   * 记忆索引文本（B2：`MEMORIES/INDEX.md` 的渲染形态，见 docs/memory-injection.md §3）。
   *
   * 由**宿主**读盘并组装（索引文件是机制生成的，正文不在里面——只有路径 + 一行摘要 + `!pinned`）；
   * 循环层只转手，与 `skillCatalog` / `contact` 同一条纪律。缺省/null 表示本次没有索引，
   * 长期记忆层里那一段整体不出现（重放与子代理就是这种情形）。
   */
  memoryIndex?: string | null;
  /**
   * 本轮固定块的素材（B2，见 render.ts 的 `TurnBlockFacts`）：历史之后、此刻层之前那一段。
   *
   * **素材在一轮开始时定下**（宿主读一次 `STATE.md` / 关系档案；记忆那一半只有索引，
   * 走下面的 `memoryIndex`），循环层每步原样转手——「一轮之内逐字节不变」这条契约的落点就在这里。
   * 缺省 = 整块不出现（子代理、重放、诊断）。
   */
  turnBlock?: TurnBlockFacts | null;
  /**
   * 本任务相关资产那一行（v34；`persona/assets.ts` 渲染好的文本）。
   *
   * ⚠ **v45 起没有生产写入方**（2026-10-09 用户拍板取消「light 选取资产」这条机制）：
   * `real-loop` 不再读 `MEMORIES/assets.md`、不再跑那一次 light、也不再传值（传的恒为空串）；
   * 于是此刻层任务卡里**不会有那一行**。
   *
   * **这一格为什么不连根拔掉**：它是**逐字节重建旧日志**那条路要用的——
   * `memory/selected.assets`（v34 起搭着记忆索引的账落库）里记着当时那一行，
   * 重放（`runtime/replay.ts` 的 `assetsFromEvents`）与界面预览（`web/server.ts` 的
   * `assetsLineAt`）都从**事件**取回它，再经这里转手给渲染层。删掉这一格就等于改写历史。
   *
   * 缺省/null/空串 = 整行不出现（v45 起生产上恒为这一支：渲染结果与引入它之前逐字节相同）。
   */
  assetsLine?: string | null;
  /**
   * `persona/STATE.md` 的**字节预算**（v32；`config.persona.stateBudgetBytes`，默认 8 KB）。
   *
   * 循环层只转手：越过它时此刻层多一行提醒（措辞与格式见 `render.ts` 的 `stateBudgetReminder`），
   * 由她自己去把过时内容搬进记忆文件或删掉——**框架不截断、不改她的文件**（用户口径）。
   * 缺省取 `DEFAULT_STATE_BUDGET_BYTES`：漏传时按出厂口径判，而不是"永不提醒"。
   */
  stateBudgetBytes?: number;
  /**
   * **维护窗口那条信号**（2026-10-11，此刻层 `维护窗口：` 那一行）。
   *
   * 宿主在轮首算一次（`real-loop` 的 `maintenanceWindowFor` → `render.ts` 的
   * `maintenanceWindowOf`），循环层只把那一格**原样转手**——判据要的时钟、事件、投影与
   * "上一次窗口"，渲染层一样都拿不到（缓存铁律 1：它不读环境值、不读时钟）。
   *
   * **一轮之内它是常量**：所以此刻层这一行不会逐 step 抖，前缀照旧命得中。
   * 缺省/`null` = 这一轮不是窗口 ⇒ **整行不出现**（子代理、重放、诊断，以及绝大多数轮次）。
   */
  maintenanceWindow?: MaintenanceWindowNote | null;
  /**
   * **本轮那条压缩预警的账**（2026-10-15）：宿主在 prepare 段判完"这一拍该不该叫醒她整理"，
   * 把结论（`{fired, why, historyTokens, thresholdTokens, ratio}`）搭在 `compaction/decision`
   * 上落库。循环层**只转手**——判据要的事件快照与投影都在宿主手里。
   *
   * 与 `maintenanceWindow` 同一条纪律：**internal 观测**，不改请求字节、不动 `RENDER_VERSION`。
   * 缺省 = 宿主没判（子代理、诊断）⇒ 那一格不写（不填一个 `fired:false` 冒充"判过了"）。
   *
   * ⚠ 它**不是一个算好的值，是一个判据函数**：本 turn 的可见历史估算刚刚算出来（就在
   * `maybeCompact()` 的结论里），所以由循环层**在写那一行账之前**当场调它——判据与压缩判定
   * 因此是**同一个数、同一刻**。它需要时可以自己发一条真唤醒（`wake/manual{via:'compact-soon'}`）。
   */
  compactionWarning?: ((historyTokens: number | null, reason: string, thresholdTokens: number) => CompactionWarning) | null;
  /**
   * 本轮的**记忆索引注入账**（B2，docs/memory-injection.md §4）：给一个函数，循环层在**轮首**
   * 调它一次，把结论写成 `memory/selected` 事件（索引全文不落事件）。
   *
   * 它**不再产生进上下文的文本**（2026-10-04 简化）：固定块里那段索引由 `memoryIndex` 直接给,
   * 要读正文是她自己 `safe_read` 的事（用户口径见 §5）。
   *
   * 为什么由循环层调、而不是宿主自己写好：turn 号在这里才分配（`turn/start` 刚落下），
   * 而事件必须带上正确的 turn 才能被 `deriveRequest`/重放按 turn 取回。
   * 宿主只提供**纯函数**（判据 + 取正文），落库这一步交给唯一写入点，与 `compaction/summary`
   * 同一条纪律：循环层不自己算业务判据，宿主不自己分配 seq。
   *
   * 不配 = 那一轮不注入记忆（子代理、诊断、老调用点），固定块里也就没有记忆那一段。
   */
  memorySelector?: MemorySelector | null;
  /**
   * 此刻的联络事实（design §4.13 状态层素材，见 model/self-brief.ts）：启用了哪些通道、
   * 告警出口在不在、本轮能不能把话发回唤醒来源。不配即该段整体不出现——
   * 子代理就属于这种情形：发言是主循环的事，它不需要知道往哪儿发。
   */
  contact?: ContactFacts | null;
  /**
   * 本机事实（此刻层 `本机：` 一行的素材，见 MachineFacts）：磁盘余量、进程已运行多久、工作根。
   *
   * 由**宿主**算好（real-loop 读 os/fs 一次），循环层只转手——渲染层不读环境值，这是与
   * `contact` / `skillCatalog` 同一条纪律。不配即该行写"未知"（子代理、重放、诊断都是这种情形）。
   */
  machine?: MachineFacts | null;
  /** 用度事实（此刻层 `用度：` 一行的素材，见 UsageFacts）：投影折叠结论 + 生效日上限。不配即"未知" */
  usage?: UsageFacts | null;
  /**
   * 「这条通道消息豁免吗」——规则层那条**渲染期现算**的出口要问的判据，由宿主传（2026-10-04）。
   *
   * 为什么必须有它：规则命中变成警告有两个出口——唤醒路径落 `injection/noted`（在 real-loop
   * 里判），以及 `renderExternalEvent` 的兜底扫描（**渲染时**现算）。用户现场踩到的那条消息
   * 走的正是后者：她跑到一半时消息才到、被中途认领，于是没有任何落库的结论可读。
   * 判据**只有一处实现**（`channel/warn-exempt.ts` 的 `WarnExemptBook.isExempt`）；这里只把
   * 宿主给的那个函数一路传到 `RenderInput`——渲染层不读盘、不判据，只用它（缓存铁律 1）。
   *
   * 不配 = 谁都不豁免（预警开着是安全的那一侧；子代理、诊断、旧调用点都是这一支）。
   */
  warnExempt?: WarnExemptJudge | null;
  /**
   * 图片取字节的能力（design §4.20 图片两条途径）：给了它，带图的消息才会把
   * `input_image` 放进请求——QQ 发来的图片因此"直接进上下文"，而不是只留一条地址。
   *
   * 由宿主注入（real-loop 用 channel/attachment-store 的 readAttachmentImage）。给的是
   * **一份能进请求体的图片**（型别 + data URL），不是裸 URL 串——型别与 data URL 前缀必须
   * 逐字一致，而拼装只此一处（见 `ContextImageChosen` 的注释：拼错就是 400）。
   * 不配 = 一条图片都不进上下文，只剩文字与 `vision_read` 的转述：子代理与重放就是这种情形。
   */
  loadImage?: ((ref: RenderImageRef) => ContextImageChosen | null) | null;
  /** 最多几张图片进上下文（默认 IMAGE_INJECT_MAX = 2；0 = 关掉图片直通） */
  maxContextImages?: number;
  /**
   * 执行点钩子（design §4.19）：Wake 点在唤醒注入，PreToolUse/PostToolUse 由执行器调用。
   * 不配即无钩子，行为与 M2 完全一致。
   */
  hooks?: HookRunner;
  /**
   * 上下文隔离（design §4.21 子代理）：只有通过过滤的事件才进本 turn 的渲染快照。
   * 子代理用它把父历史与外部事件挡在请求之外——过滤之后事件流就是「从空事件序列起」的那一份，
   * 与「换一个 scoped 日志句柄」相比，它不动日志本身的语义（seq 分配与 append 仍是全局单一）。
   * 不传即全部可见：顶层 turn 的默认口径，与未引入子代理时逐字节一致。
   *
   * 顶层那条路（`real-loop`）现在也用它挡第二类事件：**整条就是一条指令的 `wake/manual`**
   * （`/compact`、`/handoff`、以及打错的那些）。指令是给框架的，不是对她说的话——她要看见的是
   * 指令的**效果**（摘要 / 交接笔记），不是用户按了哪个按钮（见 `slash-commands.ts` 的
   * `isSlashCommandEvent`）。`replay` 用同一条判据重建，所以重建结果与当时仍然逐字节一致。
   */
  eventFilter?: (event: AppEvent) => boolean;
  /**
   * 子代理 turn 链归属标记（schema §1 `parentCallId`）：本 TurnRunner 写下的每条事件都带上它。
   * 顶层不传 → 事件里不出现该字段（零成本保持既有事件形状与字节序）。
   */
  parentCallId?: string;
  /**
   * turn 号下限（schema §2 编号规则）。子代理在隔离的事件视图里跑，`maxTurn()` 看不见主日志里
   * 已有的 turn；不给下限，子代理就会从 1 重新开始编号，与主日志重号——而 `replay <turn>`、
   * 恢复期的认领退回都按 turn 定位。给了它，子代理的 turn 与主日志全局唯一。
   */
  turnBase?: number;
  /**
   * 事件落库观察口（每条事件 append 之后、折进投影之后调用一次）。
   * 子代理用它把「属于自己链的事件」同步折进父投影的记账口径（预算消耗必须立刻被父的刹车看见），
   * 与「重启后 fold 全量重建」的结论保持同一份事实。
   */
  onEvent?: (event: AppEvent) => void;
  /**
   * 计划模式门（design §4.21）：destructive 调用在两阶段落库之前被拦下等人工批准，
   * 被拦的调用没有 tool/call、没有 tool/result，只有 plan/pending 与 human/asked。
   * 不配即无计划模式，行为与没这个机制时完全一致。
   */
  planGate?: ToolPlanGate;
  /**
   * 缓存破坏哨兵的阈值（`config.contextAudit`）。不给即用保守默认（空闲 30 分钟 + 命中率跌半）。
   *
   * 它是**观测**阈值，不改变任何运行行为：最坏情况只是多记或少记一条 `budget/consumed.cacheBreak`。
   * 之所以由宿主递进来而不是循环层读配置：本模块与 config 解耦（测试与子代理都不带配置）。
   */
  cacheBreakThresholds?: CacheBreakThresholds;
}

/**
 * 压缩触发配置：`thresholdTokens` 是可见历史估算阈值，其余字段原样交给交接笔记算法。
 * M5 的临时口径是「turn 结束 + 历史超过阈值」；真实的 token 计数与预算归账仍由预算层负责。
 */
export type AgentLoopCompaction = HandoffOptions & { thresholdTokens: number };

// ──────────────────────────────── 请求派生（M2-2） ────────────────────────────────

/**
 * 本轮的**记忆索引注入账**（B2）：宿主给结论，事件由循环层在轮首写。
 *
 * 为什么是"注入一个纯函数"而不是让宿主自己写事件：turn 号只有循环层知道（`turn/start` 刚落下），
 * 而事件必须带正确的 turn 才能被按 turn 取回。宿主给结论，循环层落库——与 `compaction/summary`
 * 同一条分工。
 *
 * 2026-10-04 简化：不再"选哪几条 + 取正文"（用户定的口径是「只看索引，如果需要，heavy 自己去读」），
 * 所以这里只回**注入了没有**与**当时那份索引的指纹 / 条数**——索引全文不落事件。
 *
 * 2026-10-15（阶段一）：固定块里注入的那一段从"整张指针表"换成"按最近话题挑的 top-6"，
 * 于是这里**多回三样**——`selected`（推给她的指针）/ `scores`（凭什么）/ `query`（按哪几条输入挑的）。
 * 三者都是**可选**的（老调用点与老事件没有它们），全文照旧不落事件。
 */
export type MemorySelector = (input: {
  /** 本轮的唤醒事件（判"是不是心跳轮"就看它） */
  wakeEvents: readonly AppEvent[];
  /** 已分配的本轮 turn 号 */
  turn: number;
}) => {
  /** 'human' = 有人在跟她说话；'heartbeat' = 只有心跳（那一轮**不注入**索引） */
  injection: 'human' | 'heartbeat';
  /** 当时注入的那段索引文本的指纹（"注进去的是哪一版"的唯一凭据） */
  indexHash: string;
  /** 注入的索引条数（规模；不是索引全文） */
  entries: number;
  /**
   * **当时注入的那一段文本本身**（阶段一，2026-10-15；可选）。
   *
   * 为什么要落原文（而不是只落指纹）：推荐段是 BM25 按"当时的记忆文件 + 当时那 5 次输入"
   * 挑出来的，事后**算不回来**（盘上文件她会改）——而界面预览与 CLI 的重建要逐字节复原请求。
   * 与 `assets` 那一格**同一条纪律**（那一格从 v34 起就存着"当时那一行渲染好的文本"）。
   * 代价与完整判据写在 `log/types.ts` 的 `injected` 那一格。
   *
   * **缺省 = 老事件**（那时注入的是整张指针表，由盘上 `INDEX.md` + `indexHash` 复原）。
   */
  injected?: string;
  /**
   * 固定块里**实际推给她的**指针，按展示顺序（阶段一，2026-10-15；可选）。
   *
   * **缺省 = 老事件**（那时注入的是整张指针表，没有"挑出来的几条"这回事）——
   * 读的人必须按"不在就是没有"处理，别补默认值。
   */
  selected?: string[];
  /** 与 {@link selected} 逐位对应的 BM25 分数（pinned 保底收进来的记 0） */
  scores?: number[];
  /** 这一轮挑选用的查询指纹（不落查询原文：那几条输入本身就是日志里的事件） */
  query?: { hash: string; seqs: number[]; texts: number; truncated: boolean };
  /**
   * 本任务相关资产那一行（v34；`MEMORIES/assets.md`，空串 = 这一轮没有）。
   *
   * **为什么搭这条账一起落库**：那一行进的是此刻层任务卡，而重放要能**逐字节**重建当时的请求
   * ——盘上的 `assets.md` 是她随时会改的文件，"当时的清单挑出了哪几条"只有事件答得上来。
   * 与 `indexHash` 同一条纪律：只记结论（那一行渲染好的文本），不记清单全文。
   *
   * 可选：不传 = 这一轮没有那一行（老调用点、子代理、诊断都走这一支，事件形状与之前一致）。
   *
   * ⚠ **v45 起这一格只由"重建"那一侧用**（2026-10-09 取消「light 选取资产」这条机制）：
   * 运行期不再产生那一行（`real-loop` 的 `planMemorySelection` 不再给 `assets`），所以**新写的
   * 事件里不会有这一格**；而这个字段、以及"事件里有它就照样渲染"这条读法**一个字都没删**——
   * 旧日志（v34–v44 那些轮）重放/预览时仍然逐字节重建得出当时那一行。见 `render.ts` 的 v45 那一篇。
   */
  assets?: string;
};

/**
 * 本轮是不是"只有心跳"（没有人在跟她说话）。
 *
 * 判据在 `wake/heartbeat` 这个事件类型上（唤醒源类型是既有依据，不另造一套）。
 * 一个 turn 可以认领多条输入，所以是"**全部**都是心跳"才算心跳轮：
 * 混着一条真人消息时，那就是有人在说话，记忆照注入。
 */
export function isHeartbeatTurn(wakeEvents: readonly AppEvent[]): boolean {
  return wakeEvents.length > 0 && wakeEvents.every((event) => event.type === 'wake/heartbeat');
}

/**
 * 一轮的**收尾计时**（BUG-4 的观测面；见 {@link AgentLoopDeps.onTurnTiming}）。
 *
 * 纯观测：这三个数**不进请求体、不参与任何判据**，只是把"这一轮的时间花在哪"记下来。
 * `turnMs` 不在这里——整轮的总时长只有调用方（`real-loop` 的 `tickOnce`）量得到，
 * 它把本对象与自己的读数合起来落成 `runtime/slow-tick` 的那几格。
 */
export interface TurnTiming {
  /** 收尾那一段（`maybeCompact`：判定 + 交接笔记渲染 + 摘要落盘）的耗时，毫秒 */
  compactMs: number;
  /** 那一刻本 runner 可见的事件条数（那几个同步扫描的**规模输入**） */
  events: number;
  /** 上面那些事里最后一条的 seq（0 = 一条都没有；与 `events` 一起看才知道读数是不是那一份快照） */
  eventsThroughSeq: number;
}

/**
 * 请求派生输入。全部字段都能从日志 + 人格资产取回：
 * `now` 取该 step 的 `step/start.ts`，`events` 取 seq 小于该 step/start 的日志快照，
 * `wakeEvent` 取该 turn 认领的首条输入（仅首 step）。
 */
export interface RequestDerivation {
  persona: AgentLoopPersona;
  /** 进模型清单的工具（registry.listForModel 的结果） */
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  timezone: string;
  lane: ModelLane;
  events: readonly AppEvent[];
  /** 本轮新输入；必须不在 events 里（见文件头协同契约） */
  wakeEvent: AppEvent | null;
  taskCard: {
    title: string;
    turn: number;
    step: number;
    todoOpen: readonly string[];
    /**
     * 本任务相关资产那一行（v34，`MEMORIES/assets.md`，由 real-loop 在轮首算好）：
     * 渲染层只排版、缺省即整行不出现。见 `persona/assets.ts` 与 `RenderInput.taskCard.assets`。
     */
    assets?: string;
  } | null;
  now: string;
  model: string;
  /** 软阈值提示：尾部插播，不落库（见文件头 M2 边界） */
  softHint?: string | null;
  /** 技能 catalog（状态层素材，见 AgentLoopDeps.skillCatalog） */
  skillCatalog?: string | null;
  /**
   * MCP 索引（**与技能 catalog 同段素材**，见 AgentLoopDeps.mcpIndex）：只回答"有哪些 server"，
   * 工具清单按需（`mcp` 工具）。重建时必须给**当时那一版**（`replay` 从 `mcp/index` 事件取）。
   */
  mcpIndex?: string | null;
  /** 记忆索引（长期记忆层素材，见 AgentLoopDeps.memoryIndex） */
  memoryIndex?: string | null;
  /** 本轮固定块（见 AgentLoopDeps.turnBlock）：**一轮之内逐字节不变**的那一段 */
  turnBlock?: TurnBlockFacts | null;
  /**
   * `persona/STATE.md` 的字节预算（v32，见 AgentLoopDeps.stateBudgetBytes）：此刻层那行
   * 「STATE 超预算」提醒的阈值。缺省 = `DEFAULT_STATE_BUDGET_BYTES`（出厂 8 KB）——
   * 重放与预览都从**当时生效的那份配置**里取同一个数，所以三处判据一致。
   */
  stateBudgetBytes?: number;
  /**
   * **本轮那条维护窗口信号**（2026-10-11，见 AgentLoopDeps.maintenanceWindow / RenderInput）：
   * 宿主在轮首算好递进来，循环层每步原样转手。缺省 = 不是窗口 ⇒ 此刻层那一行整行不出现。
   */
  maintenanceWindow?: MaintenanceWindowNote | null;
  /** 联络事实（状态层素材，见 AgentLoopDeps.contact） */
  contact?: ContactFacts | null;
  /** 本机事实（此刻层 `本机：` 素材，见 AgentLoopDeps.machine）：宿主算好，循环层只转手 */
  machine?: MachineFacts | null;
  /** 用度事实（此刻层 `用度：` 素材，见 AgentLoopDeps.usage）：投影 + 生效上限，宿主算好 */
  usage?: UsageFacts | null;
  /**
   * 「这条通道消息豁免吗」的判据（见 AgentLoopDeps.warnExempt）：重建与运行期都要带着它，
   * 否则"同一批事件"在两边会渲染出不同的字节（一边贴了那句规则提示、一边没贴）。
   */
  warnExempt?: WarnExemptJudge | null;
  /**
   * 图片取字节的能力（宿主注入，见 AgentLoopDeps.loadImage）：给了它，带图的消息才会
   * 把 `input_image` 真的放进请求。缺省 = 只渲染文字（重放与诊断场景常常没有它）。
   */
  loadImage?: ((ref: RenderImageRef) => ContextImageChosen | null) | null;
  /** 最多几张图片进上下文（见 RenderInput.maxContextImages） */
  maxContextImages?: number;
}

/**
 * 从「日志快照 + 位置」算出模型请求。运行期与事后重建走同一份代码，
 * 所以「同一批事件渲染出同一字节串」这件事是可执行的断言，而不是承诺。
 */
/**
 * 本轮输入是不是"群里有人提到了你"——是的话给出那句**框架通知**（正文不进她的上下文）。
 *
 * 用户 2026-10-02 的设计：「被卡片 wake，只知道群有人提及，不知道说了什么，然后点进去看了话题，
 * 才回话……这才是正确的设计」。所以：
 *   • 文案**复用 `renderMentionNote`**（此刻层「点名：」用的同一份）——一处措辞，两处出现
 *     会立刻分岔，而"谁在哪个群叫了你、那边在聊什么、不看也不会丢"这几句是设计口径；
 *   • 只在**群里**成立（私聊本来就该直接看到话），判据是 `contact.wakeMessage` 的
 *     `chatType !== 'c2c'` 加上"平台 @ 或关键词命中"（与此刻层一致）；
 *   • 判过注入的那条**不换**（`render` 侧按 note 判）：那种消息她必须亲眼看原话。
 *
 * v34 起**导出**：宿主挑"本任务相关资产"时要用**同一个口径**的标题（提及那一轮通知里带着
 * 那一句「那边在聊：…」，比 `{"channel":"qq-official",…}` 那一坨 JSON 更能说明"要做什么"）。
 * 两处各写一份判据，迟早会漂成"挑资产时看的是 A、任务卡上写的是 B"。
 */
export function mentionNoticeOf(
  contact: ContactFacts | null,
  wakeEvent: AppEvent | null,
): { messageId: string; text: string } | null {
  if (contact === null || wakeEvent === null || wakeEvent.type !== 'wake/channel') return null;
  const text = (renderMentionNote(contact) ?? '').trim();
  if (text === '') return null;
  return { messageId: wakeEvent.data.messageId, text };
}

/**
 * 给联络事实补上"叫她的那一条是什么时候到的"（本机时间，'15:16'）。
 *
 * 渲染层不格式化时间（时区是配置事实），宿主这里算好；重放走同一条路，所以重建得回来。
 *
 * v34 起**导出**：宿主挑"本任务相关资产"的标题要用**同一条路**算出来的 contact
 * （提及那一轮通知只在补过 `wakeMessage` 的 contact 上成立）——见 `mentionNoticeOf`。
 */
export function contactWithWakeStamp(
  contact: ContactFacts | null,
  wakeEvent: AppEvent | null,
  timezone: string,
): ContactFacts | null {
  if (contact === null || contact.wakeMessage === undefined || contact.wakeMessage === null) return contact;
  if (wakeEvent === null || wakeEvent.type !== 'wake/channel') return contact;
  if (contact.wakeMessage.atLabel !== undefined && contact.wakeMessage.isNew !== undefined) return contact;
  // **叫她的这一条她自己看过没有**：未读只数 `channel/message`，而叫醒她的是 `wake/channel`
  // ——它压根不计入未读，所以"未读 0"绝不等于"没有新的叫"（2026-10-02 实测：她把新的提及当成
  // 了上一轮那条旧消息，选择不回复）。判据与未读同源：msgSeq 落在她已读位之后。
  const entry = (contact.sessions ?? []).find((item) =>
    item.sid === sidOf(wakeEvent.data.channel, wakeEvent.data.chatType, wakeEvent.data.chatId));
  const isNew = entry === undefined ? undefined : wakeEvent.data.msgSeq > entry.readUpToSeq;
  const ms = Date.parse(wakeEvent.ts);
  if (!Number.isFinite(ms)) {
    return isNew === undefined
      ? contact
      : { ...contact, wakeMessage: { ...contact.wakeMessage, isNew } };
  }
  let atLabel = '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    atLabel = `${get('hour')}:${get('minute')}`;
  } catch {
    return isNew === undefined
      ? contact
      : { ...contact, wakeMessage: { ...contact.wakeMessage, isNew } };
  }
  return { ...contact, wakeMessage: { ...contact.wakeMessage, atLabel, ...(isNew === undefined ? {} : { isNew }) } };
}

export function deriveRequest(input: RequestDerivation): RenderedRequest {
  const persona: RenderPersona = {
    identity: input.persona.identity,
    constitution: input.persona.constitution,
    style: input.persona.style,
    state: input.persona.state,
    relationship: input.persona.relationship ?? null,
  };
  // 群里"有人提到了你"那一轮：本轮输入换成**框架通知**（正文她自己 read_channel 取）。
  // 在这里算，与 `asks`/`injection` 同一条纪律：渲染层不读 contact、也不扫日志，
  // 而"这一轮是不是被点名"只有拿得到 contact 的人知道——replay 走同一个函数，所以重建得回来。
  //
  // **它同时是任务卡标题的来源**（v35 收敛，2026-10-06）：提及那一轮"她真正看到的那句话"
  // 就是这一句，所以标题也用它。判据只留这一处，是因为一条真 bug 的形状——同一个标题原先
  // 有三处各推一次：
  //   • `agent-loop` 的 `taskCard()` 换过一次，用的是**没盖章**的 `this.deps.contact`，
  //     于是标题与本轮新输入差着「（15:16 到的这一条）（这一条你还没看过）」两小段；
  //   • `replay` 的 `locateStep` 压根没换——重放/界面预览的任务卡标题直接成了**正文原文**，
  //     违反 v28（"通知进、正文不进"；修前它侥幸没被发现，因为那时标题是整个
  //     `[external_event …]` 包裹，而 80 字的裁剪正好把包裹头切掉、正文还没轮到）；
  //   • 挑资产那一侧（`real-loop` 的 `assetTaskTitle`）用的是盖章版——三种口径里唯一对的那个。
  // 收敛到本函数之后，**运行期 / CLI 重放 / 界面预览**三条渲染路径同源（后两条都走本函数）。
  const mentionNotice = mentionNoticeOf(
    contactWithWakeStamp(input.contact ?? null, input.wakeEvent, input.timezone),
    input.wakeEvent,
  );
  const rendered = render({
    events: [...input.events],
    persona,
    tools: input.tools,
    wakeEvent: input.wakeEvent,
    taskCard: input.taskCard === null
      ? null
      : {
        // 提及那一轮：标题就是那句通知——与上面给"本轮新输入"的是**同一串字节**
        //（裁剪口径同 `clipTaskTitle`：调用方给的标题本来就是它裁过的）。
        // 其余轮次原样转手（`wakeTitle` 的一行摘要：任务卡标题该是人写的那句话本身）。
        title: mentionNotice === null ? input.taskCard.title : clipTaskTitle(mentionNotice.text),
        turn: input.taskCard.turn,
        step: input.taskCard.step,
        todoOpen: [...input.taskCard.todoOpen],
        // 数字资产那一行（v34）：原样转手——它不是渲染层能算出来的东西（要读清单文件、
        // 还要一次 light 选取），所以只有在宿主给了且非空时才带上这个字段。
        ...(input.taskCard.assets === undefined || input.taskCard.assets === ''
          ? {}
          : { assets: input.taskCard.assets }),
      },
    now: input.now,
    timezone: input.timezone,
    model: input.model,
    lane: input.lane,
    // 技能索引：与 events/persona 并列的渲染输入，重放走同一份 deriveRequest 才不会漂移
    skillCatalog: input.skillCatalog ?? null,
    // MCP 索引（v46）：**与技能索引同段素材、同一个位置**（长期记忆层里紧挨着它）。
    // 它的字节只有一处来源——日志里那条 `mcp/index` 快照（见 AgentLoopDeps.mcpIndex）。
    mcpIndex: input.mcpIndex ?? null,
    // 记忆索引（B2）：进**本轮固定块**（指针表，v30 起；v29 时在长期记忆层）。它同 deriveRequest
    // 的其它素材一样由调用方给——重放时从盘上读 INDEX.md，与当时同源。心跳轮给空串（不注入）。
    memoryIndex: input.memoryIndex ?? null,
    // 本轮固定块（B2）：历史之后、此刻层之前，**一轮之内逐字节不变**（v31 起只在第 1 步发）。
    // 素材由调用方在轮首定下（real-loop 的 turnBlockFacts），循环层每步原样转手；
    // 重放时同一份素材由人格资产重建（replay.ts）——记忆那一段不在其中（只给索引，见 §5）。
    turnBlock: input.turnBlock ?? null,
    // STATE 预算提醒（v32）：**在这里量**（`persona.state` 的 UTF-8 字节数）——三条路
    // （运行期 agent-loop、重放 replay、界面预览 web）都走本函数，所以"多少字节"只有一个答案。
    // 渲染层照旧不读文件系统；而量的是**进上下文的那份文本**（规范化之后），盘上 CRLF/BOM
    // 多出来的那一截是幻影字节，不该把一份其实没超的 STATE 报成超限（见 stateBytesOf 的注释）。
    stateBytes: stateBytesOf(persona.state),
    stateBudgetBytes: input.stateBudgetBytes ?? DEFAULT_STATE_BUDGET_BYTES,
    // 维护窗口（2026-10-11）：**原样转手**——判据不在这里（渲染层是纯函数，它不读时钟、
    // 不读事件、不自己记"上次窗口是什么时候"），宿主轮首算一次，每个 step 拿到的是同一条。
    // 缺省 = 不是窗口 ⇒ 此刻层那一行整行不出现（重放/子代理/诊断都是这一支）。
    maintenanceWindow: input.maintenanceWindow ?? null,
    contact: contactWithWakeStamp(input.contact ?? null, input.wakeEvent, input.timezone),
    // 本机与用度：与 contact 同一条纪律——**渲染层不读环境值**，所以磁盘余量、进程已运行多久、
    // 今日用量这些只能由拿得到 os/fs/投影的调用方算好递进来；缺省（重放、子代理、诊断）时
    // 此刻层那两行写"未知"，不抛也不编。
    machine: input.machine ?? null,
    usage: input.usage ?? null,
    // 豁免判据（见 AgentLoopDeps.warnExempt）：**显式传**给渲染入参——渲染层不读盘、不判据，
    // 只用这个函数（唯一实现仍是 WarnExemptBook.isExempt）。缺省 = 谁都不豁免：子代理、诊断、
    // 以及不带它的旧调用点都走这一支，渲染结果与引入它之前逐字节相同。
    warnExempt: input.warnExempt ?? null,
    // 她问出去、还没答复的提问（design §6）：此刻层那段小结的素材。**在这里算**（不放进
    // render）：渲染层不扫日志，而"哪几条还没被 human/answered 配对"只有事件算得出来；
    // 放这里还让 replay 白拿同一份结论——重建与当时逐字节一致靠的就是这一点。
    asks: pendingAgentAsks(input.events).map(ask => ({
      question: ask.question,
      askedAt: ask.at,
      turn: ask.turn,
      expiredAt: ask.expiredAt,
    })),
    // 最近 24 小时被示过警的人（此刻层 `预警：` 那段历史）：同样在这里从事件算——渲染层不扫日志，
    // 而"框架提醒过她几次"是跨多轮的事实，只有拿得到事件的人算得出来。replay 走同一个函数，
    // 所以重建出来的这一段与当时逐字节一致（与 `machine`/`usage` 那种瞬时值不同）。
    injection: notedWarningsOf(input.events, Date.parse(input.now)),
    // 群里"有人提到了你"那一轮：本轮输入换成**框架通知**（正文她自己 read_channel 取）。
    // 算在函数开头那一处，**任务卡的标题也从它取**（v35 收敛：判据只留一份，别在这里再换一次）。
    mentionNotice,
    // 图片：渲染层拿不到字节，靠注入的 loader 换 data URL（重放时常常没有 loader，
    // 那条历史就退化成文字——这是有意的：重放要的是"当时说了什么"，不是把图再传一遍）
    loadImage: input.loadImage ?? null,
    ...(input.maxContextImages === undefined ? {} : { maxContextImages: input.maxContextImages }),
    // 尾部插播（软阈值提示 / 钩子注入）：**交给渲染层追加**（铁律 2「只追加」不变）。
    // 为什么挪进去：上下文归因要把 input 的每一段都数清楚，插播是最后一段——在装配点之外
    // 追加，归因的"合计"就会比真正的请求少一段（2026-10-03）。
    softHint: input.softHint ?? null,
  });
  return rendered;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

/**
 * 跑一个 turn：认领一批输入 → step 循环（模型 → 工具）→ 返回结构化结局。
 *
 * 契约：`wakeEvents` 必须**已写入日志**（seq 有效）并由调用方折进投影——本模块不替调用方
 * 分配 seq，也不会重写它们。已在本 turn 之前被认领的输入不在队列里，认领次数按投影取。
 */
export async function runTurn(deps: AgentLoopDeps, wakeEvents: readonly AppEvent[]): Promise<TurnEndReason> {
  const runner = new TurnRunner(deps, wakeEvents);
  return runner.run();
}

// ──────────────────────────────── 实现 ────────────────────────────────

/**
 * 一轮 turn 的执行者（**导出只为测试留一个缝**，见下）。
 *
 * 生产入口是 {@link runTurn}（它每轮新建一个本类实例）。这里导出类本身，是因为有两件观测上的
 * 事实**只能在类的方法上验证**，而它们都关乎"慢拍到底慢在哪"（BUG-4，诊断要求把
 * "模型慢"与"收尾的同步扫描占死"分开）：
 *   · **收尾那一段的计时口径**：`compactMs` 必须真的包住 `maybeCompact`（判定 + 交接笔记渲染
 *     + 摘要落盘），而不是包住别的东西。要钉住它，得能让那一段**变慢**；
 *   · **`events` 的读数口径**：它是"本 runner 可见的那一份快照条数"，不是日志里的总条数。
 *
 * 测试用 `TurnRunner.prototype.maybeCompact` 临时换成一个"慢"的等价物来钉第一件事
 * （`test/slow-tick-timing.test.ts`）——**不导出就没有这个缝**，那两个刻度只能靠读代码相信。
 * 它**不改任何判据**：换掉的是测试进程里的一份方法，生产路径一个字都没动。
 */
export class TurnRunner {
  private readonly deps: AgentLoopDeps;
  private readonly wakeEvents: AppEvent[];
  private readonly log: EventLog;
  private readonly projection: Projection;
  private readonly lane: ModelLane;
  private readonly workspaceRoot: string;
  /** 活动边界（`boundaryRoot` 三态原样携带：undefined = 用 workspaceRoot 当边界） */
  private readonly boundaryRoot: string | null | undefined;
  /** 日志快照：render 的唯一事件来源，每个 step 前与日志增量对齐 */
  private readonly events: AppEvent[] = [];
  private turn = 0;
  private step = 0;
  private spoke = false;
  /** 本 turn 的 turn/start 事件 seq：压缩事件（compaction/summary）的闸蔽点 */
  private turnStartSeq = 0;
  /**
   * 本 turn 认领过的输入 → **认领当时**的累计次数（`input/claimed.claimCounts[i]` 那个值）。
   *
   * 为什么要留一份：整轮失败时要把它们退回去，而退回要写"下一次的认领次数"——投影的 pending
   * 里已经没有它们了（认领即从 pending 删除），所以只能在认领那一刻记下来。
   */
  private readonly claimedCounts = new Map<number, number>();
  /** 本 turn 中途插进来、已经被送进某一份请求的唤醒 seq（避免重复落账，见 claimDeliveredInputs） */
  private readonly claimedMidTurn = new Set<number>();
  /**
   * 钩子产生、尚未注入的附加上下文（design §4.19 第 4 条）。
   * 与软阈值提示同一条尾部 developer 通道：只追加，不改已渲染历史。
   */
  private readonly hookContext: string[] = [];
  /**
   * 本 turn 的**连续重复调用**计数（工具软提醒）。判据是"同一 turn 内、从最近一次换了工具名起算"，
   * 所以它是一份 turn 级状态：turn 换一个 `TurnRunner` 实例（`runTurn` 每次新建），跨 turn 自然重置。
   *
   * 计数在 {@link executeCalls} 里按调用顺序推进（唯一一处），提醒文本按 callId 暂存在
   * {@link repeatReminders}，由 {@link recordToolResult} 贴到那一条回执的正文末尾。
   */
  private readonly repeatGuard = new RepeatGuard();
  /** callId → 该次回执末尾要追加的软提醒（`executeCalls` 写入，`recordToolResult` 取走即删） */
  private readonly repeatReminders = new Map<string, string>();
  /**
   * 本 turn 的**同一个目标失败连击**计数（失败连击守卫）。
   *
   * turn 级状态的理由同 {@link repeatGuard}：`runTurn` 每次新建一个 `TurnRunner`，跨 turn 自然
   * 重置——"这一轮内拒绝再调它"里的"这一轮"就是它。派发前问（{@link executeCalls}）、结果落地
   * 时记（{@link recordToolResult}），两处读的是这一份。
   */
  private readonly failureGuard = new FailureStreakGuard();

  /**
   * **本 runner 上一次记账的那一拍**（`accountStep` 末尾存）。
   *
   * 为什么必须是它、而不是从 `this.events` 现取（2026-10-11 修，BUG-2）：
   * `this.events` 是**轮首对齐的日志快照**（`syncEvents` 每次从最后一条的 seq+1 增量读），
   * 而 `budget/consumed` 由本 runner 自己 `write` 出来——`write` 只 `append` + 折投影，
   * **不回填快照**。于是基准恒等于"上一轮开始前日志里的最后一条 `budget/consumed`"，
   * 也就是**上一轮的那一拍**（现场：turn 1302 的第 3 步取到 turn 1300 的 step 1，
   * 于是 00:27:38 / 00:30:36 / 00:30:52 三拍**共用同一个 prev**，diff 逐字段相同）。
   * 换成这一格之后，"与上一次真实请求比对"这句话在 turn 内才真的成立。
   *
   * 归因窗口仍然用 `this.events`（它要的是"两次调用之间发生了什么"，日志才是真源）。
   * 跨 turn 的边界由 `context-audit.detectCacheBreak` 的跨轮判据兜住（本字段每轮归零）。
   */
  private previousAuditedCall: AuditedCall | null = null;

  /**
   * 模块级：**上一次构请求时进模型的那份工具清单指纹**（BUG-3 的观测面，2026-10-11 加）。
   *
   * 为什么是模块级而不是 runner 字段：清单的变化**天然发生在轮边界之间**（registry 由宿主在
   * 每轮装配 deps 时给，`runTurn` 每轮新建一个 runner），记在 runner 上等于每轮都从"没有基线"
   * 重新开始 ⇒ 永远比不出变化。与 `compactWakeTurns`（real-loop）、`memWarnedOnce`（persona）
   * 同一条：**进程内即可判定的观测基线**，重启后重新开始也是对的（新进程第一次构请求本来就没有
   * 可比的前一拍）。
   *
   * **为什么连 registry 一起记**：指纹只有在"比的是**同一张工具表**"时才有意义。
   * 生产里 registry 是进程级单例，这一格于是就是"上一次构请求时的清单"；而换个 registry
   * （子代理的隔离视图、诊断、测试各造一张表）就是换了一张表 —— 那时**没有基线**才对，
   * 拿上一张表的读数去比会凭空报一条"少了 N 件"（本用例第一版正是这么红的：
   * 上一个套件的 registry 与这一套的 registry 不是同一张，却共用了同一格基线）。
   * 于是基线按 registry 实例归属：不是同一个实例 ⇒ 从"没有基线"重新开始。
   *
   * 它**只服务观测**：不参与任何请求装配、不进请求体、丢了不影响任何判据。
   */
  private static lastToolInventory: { registry: ToolRegistry; lines: ToolInventoryLine[] } | null = null;

  constructor(deps: AgentLoopDeps, wakeEvents: readonly AppEvent[]) {
    this.deps = deps;
    this.wakeEvents = dedupeBySeq(wakeEvents);
    this.log = deps.log;
    this.projection = deps.projection;
    this.lane = deps.lane ?? 'heavy';
    this.workspaceRoot = deps.workspaceRoot ?? process.cwd();
    // 活动边界：**原样**透传（`undefined` 也是有效值——它表示"用 workspaceRoot 当边界"）。
    // 这里刻意不做 `?? workspaceRoot` 这种归一：三态的判读只允许发生在 tools/boundary.ts，
    // 循环层一旦掺一脚，就又多出一个"哪一处说了算"的问题。
    this.boundaryRoot = deps.boundaryRoot;
  }

  async run(): Promise<TurnEndReason> {
    const reason = await this.runInner();
    // 压缩点：本 turn 已结算，但可见历史仍然超过阈值——把交接笔记写成 compaction/summary，
    // 让它成为下一轮请求里的「早期历史」（闸蔽点后的事件逐字节保留）
    //
    // **计时包住整个收尾段**（BUG-4）：判定 + 交接笔记渲染 + 摘要落盘就是慢拍里"同步扫描"
    // 最可疑的那一段。只计时，不改判据、不动阈值（诊断口径：补刻度之前不要动阈值）。
    const compactStartedAt = Date.now();
    const decision = await this.maybeCompact();
    const compactMs = Date.now() - compactStartedAt;
    // 判定的留痕：**每 turn 一行**（连"为什么不压"一起）。写在这里而不是各条 return 之前——
    // 判据只允许有一个出口，见 {@link compactionDecision}。`sync: false`（观测类）：它不是承诺，
    // 丢了下次拿同一份日志还能再算一遍，不值得一次 fsync。
    //
    // **维护窗口那一条搭在这张账上**（2026-10-11）：它本来就是"这一轮该不该给她一条维护窗口
    // 信号"的另一面，而这道账一 turn 恰好一条 ⇒ "上一次窗口是哪一刻给的"在日志里只有这一处
    // 答案（那道 6 小时的闸就是从它读的，见 render.ts 的 `lastMaintenanceWindowAt`）。
    // 这一格**不进她的上下文**（本事件是 internal ⇒ 不改请求字节、不动 `RENDER_VERSION`）。
    const window = this.deps.maintenanceWindow ?? null;
    // **压缩预警那一条也搭在这张账上**（2026-10-15）：与维护窗口同一条理由——它一 turn 恰好
    // 一条，而"这一拍为什么叫/没叫她整理"只有这一处答案。同样是 internal ⇒ 不动请求字节。
    //
    // ★ 判在**这一刻**（而不是每拍 prepare）：`decision.historyTokens` 就是本 turn 刚算出来的
    //   那个数，交给判据就是"与压缩同一个量、同一刻"；判据需要时当场发那条真唤醒。
    const warning = this.deps.compactionWarning?.(
      decision.historyTokens ?? null,
      decision.reason,
      decision.thresholdTokens,
    ) ?? null;
    this.write('compaction/decision', {
      ...decision,
      ...(window === null ? {} : {
        maintenanceWindow: {
          reason: window.reason,
          atMs: window.atMs,
          // 当地自然日（观测用；算不出来就不写这一格——不编一个日子）
          ...(window.day === null || window.day === '' ? {} : { day: window.day }),
        },
      }),
      // 缺省 = 宿主没判 ⇒ 那一格不写（不填一个 `fired:false` 冒充"判过了"）
      ...(warning === null ? {} : { warning }),
    }, { sync: false });
    // 收尾计时交给宿主（缺省不报）。**包 try**：观测不许反过来打断一轮——它连判据都不参与。
    try {
      this.deps.onTurnTiming?.({
        compactMs,
        events: this.events.length,
        eventsThroughSeq: this.events[this.events.length - 1]?.seq ?? 0,
      });
    } catch { /* 观测回调抛错不影响本轮结局（见 onTurnTiming 的注释） */ }
    return reason;
  }

  private async runInner(): Promise<TurnEndReason> {
    await this.syncEvents();
    // turn 号 = 日志中已出现的最大 turn + 1（§2 编号规则），绝不回退复用旧号。
    // 子代理的事件视图是隔离的（看不见主日志已有的 turn），全局下限由 turnBase 给出。
    this.turn = Math.max(this.maxTurn(), this.deps.turnBase ?? 0) + 1;
    const start = this.write('turn/start', { turn: this.turn }, { sync: true });
    // 压缩的闸蔽点就用本 turn 的起始 seq（§4.13：闸蔽段由 coveredUpToSeq 唯一确定）
    this.turnStartSeq = start.seq;
    // 上一轮中途插入的唤醒记在集合里；新的一轮重新开始记（它只用来防同一轮重复落账）
    this.claimedMidTurn.clear();

    const claimed = this.claimInput();
    // 没有输入可认领：无事可做。仍写 turn/start + turn/end，让"空拍"在日志里有据可查
    if (claimed.wakeSeqs.length === 0) return this.endTurn({ kind: 'completed' });

    // Wake 钩子（design §4.19）：唤醒时注入附加输入，排进本 turn 的尾部 developer 通道。
    //
    // 2026-10-05 起这里**没有回复必要性门了**：那道门（`runtime/necessity-gate.ts`）已拆——它
    // 做的唯一一件事是"在调模型之前替她决定闭嘴"，而"闭嘴"在旧口径里等于**一个请求都不发**。
    // 用户把心跳改成**真实唤醒**（唤醒一次的花费远少于缓存前缀被供方回收的花费；心跳这一拍
    // 就是去保温供方那份 KV 前缀的），那条口径被整体否掉。**"开不开口"仍由她自己定**
    // （`speak` / `turn/end.spoke`），但"调模型"照做。理由、实测与警告见
    // docs/design.md 的「试过并废掉的口径：回复必要性门」。
    const wakeText = this.wakeText();
    const injected = await this.runWakeHooks(wakeText);
    if (injected !== null) this.hookContext.push(injected);

    // 记忆选材（B2）：写在第一个 step/start 之前（轮首），所以
    // `deriveRequest`/重放按 `seq < step/start.seq` 取得到它。
    this.selectMemoryForTurn();

    let firstStep = true;
    for (;;) {
      // 刹车优先于智能：每 step 边界重新判定（§4.6）
      const verdict = this.deps.budget?.checkBeforeStep(this.projection) ?? null;
      if (verdict !== null) return this.endTurn(verdict);
      if (this.deps.signal?.aborted === true) return this.endTurn({ kind: 'aborted', cause: 'signal' });

      this.step += 1;
      const outcome = await this.runStep(firstStep);
      firstStep = false;
      if (outcome !== null) return this.endTurn(outcome);
    }
  }

  // ── 单步 ──

  /** 返回非 null 表示本 turn 到此结束；null 表示带上工具结果继续下一步 */
  private async runStep(firstStep: boolean): Promise<TurnEndReason | null> {
    // 重新对齐日志：本 step 的请求必须由日志派生（别人写进来的事件也要看得见）
    await this.syncEvents();
    // **送进这一份请求的输入＝她看见了**：中途插进来的唤醒在这里销账（见 claimDeliveredInputs）
    this.claimDeliveredInputs();
    const step = this.step;
    // now 只取一次：渲染用它，step/start 的 ts 也用它 —— 重建请求时读回这个值即可复现
    const now = this.deps.now();
    const model = this.deps.ds.modelFor(this.lane);
    const wakeEvent = firstStep ? (this.wakeEvents[0] ?? null) : null;
    const softHint = mergeHints(this.deps.budget?.softHint?.(this.projection) ?? null, this.drainHookContext());

    const request = this.deriveAt({ wakeEvent, step, now, model, softHint });
    this.write('step/start', {
      turn: this.turn,
      step,
      model,
      lane: this.lane,
      renderVersion: RENDER_VERSION,
      personaHash: this.deps.persona.personaHash,
    }, { sync: true, ts: now });

    let result: DsStreamResult;
    try {
      result = await this.deps.ds.stream(toDsRequest(request, this.lane, this.deps.signal));
    } catch (error) {
      return this.failStep(step, error);
    }

    // 中断只留「已推送的部分」（schema §3 / M2-9）：文本落库，toolCalls 一律丢弃——
    // 被截断的 arguments 拿去执行就是「拿着半个参数做有副作用的事」。
    const interrupted = result.interrupted === true;
    const text = result.text.length > 0 ? result.text : null;
    const calls: ToolCallRequest[] = interrupted ? [] : result.toolCalls.map(cloneCall);

    const assistant: Record<string, unknown> = {
      text,
      toolCalls: calls.map(call => ({ callId: call.callId, name: call.name, arguments: call.arguments })),
    };
    if (interrupted) assistant['interrupted'] = true;
    this.write('message/assistant', assistant, { sync: true });
    if (text !== null && text.trim() !== '') this.spoke = true;

    if (result.reasoning.length > 0) {
      // 思维链只供复盘（渲染层剥离，缓存铁律 3），丢了不影响正确性：按观测类写入
      this.write('message/reasoning', { turn: this.turn, step, text: result.reasoning }, { sync: false });
    }
    this.accountStep(step, result, interrupted, model, request);

    // 单步刹车（§4.6 单 step 层）：超出上限的调用不执行，返回值是被拦下的条数
    let overLimit = 0;
    if (calls.length > 0) overLimit = await this.executeCalls(step, calls);

    this.write('step/end', { turn: this.turn, step, toolCalls: calls.length }, { sync: true });
    // 观测类事件（budget/consumed、tool/zombie）在 step 边界统一落盘
    this.log.flush();

    // 人审挂起（design §4.21）：本 step 里落下了 human/asked（v27 之后只有计划模式拦截这一个写入方）——
    // turn 到此**挂起**而不是收尾。结局是 blocked：输入没丢、也没失败，它在等一个人说话。
    // 认领过的输入由 real-loop 在 human/answered 到达后写成 input/requeued 送回队列。
    // 判定读日志而不是投影：工具经注入的 emit 写事件，宿主折不折投影不由本模块决定。
    if (await this.humanSuspension()) return { kind: 'blocked', by: ASK_HUMAN_BLOCKED_BY };

    // 单步工具调用数超限（§4.6 单 step 层）：多余调用已记 over-limit，本 step 就地收束。
    // 结局由预算实现给出（它负责写 budget/exhausted）——循环层不写那个事件。
    if (overLimit > 0) {
      return this.deps.budget?.onStepOverflow?.(calls.length)
        ?? { kind: 'budget-exhausted', layer: 'step' };
    }

    if (interrupted) {
      const code = result.failure?.code ?? 'stream_interrupted';
      if (code === 'aborted') return { kind: 'aborted', cause: 'signal' };
      return {
        kind: 'error',
        message: result.failure?.message ?? '流式输出在完成前中断，本轮内容不完整',
        code,
      };
    }
    // 输出被截断与"说完了"是两件事（schema §2）：截断优先作为结局，即使本步还带着工具调用
    if (result.incompleteReason === 'max_output_tokens') {
      return { kind: 'max-tokens', outputTokens: result.usage.outputTokens };
    }
    return calls.length === 0 ? { kind: 'completed' } : null;
  }

  // ── 压缩（交接笔记 → compaction/summary） ──

  /**
   * 压缩触发（milestones.md M5-2、persona.md §4、design.md §4.13 铁律 5）：
   * turn 结束且可见历史 token 估算超过阈值时，把交接笔记写成 `compaction/summary`。
   *
   * **遮蔽点取本 turn 自己的 `turn/end`**（2026-10-06 改；原口径是"上一个已结束 turn 的
   * `turn/end`"）。交接是在 turn 收尾之后发生的，所以刚跑完的这一轮可以一起折进笔记；
   * 而把它留在现场恰恰是这笔账上最贵的一项：实测 2026-10-06 21:40 那次交接，
   * 留在现场的就是本 turn 的 43,832 token 可见历史，交接后第一次调用为它付了 72,096 未命中
   * （交接前那次只花 1,656）。改后同一个交接点的请求体不再含这一段。
   *
   * 这条改动**不放松**"不能劈开他问的那句与她答的那段"那条纪律：遮蔽点仍然是 `turn/end`
   * （不是 turn/start，也不是任意 seq），只是取**刚结束的那个** turn 而不是再往前一个。
   * 硬前提是**笔记必须覆盖到新的遮蔽点**（`renderHandoffNote` 的收录范围就是喂进去的那批
   * 事件，而这里喂的是含本 turn 在内的全量快照）——否则被遮蔽的内容会既不在笔记里、
   * 也不在历史里，那是真丢信息。回归测试钉住了这一条（test/handoff-note.test.ts 的
   * "笔记必须覆盖新的遮蔽点"）。
   *
   * 另外两条纪律不变：历史只可遮蔽、不可改写（老摘要留在现场，渲染取最大的 coveredUpToSeq，
   * 于是新摘要把老摘要自己也遮蔽进去，见 §13 遮蔽规则）。
   *
   * **2026-10-09 改：判据收成一处、每 turn 留痕一行。** 这个方法原来有五条静默 return
   * （没配压缩 / 阈值没过 / 遮蔽点回退 / 折叠反而更大 / 闸门没过），"这一拍为什么不压"在
   * 日志里一个字都没有。现在判定搬进 {@link compactionDecision} 这个**纯函数**（判据只在那里
   * 写一遍），它回一份完整结论；本方法只做"结论是 wrote 就落摘要"这一件事，结论再由
   * {@link TurnRunner.run} 写成一条 `compaction/decision`（一 turn 一行——连不压的那些拍也写，
   * 否则"为什么没压"照样是个沉默）。
   *
   * **`covered` / `priorCovered` 一律从结论里读，不在这里重算**：重算一次就多出一份判据，
   * 而两份判据迟早在某个边界上给出两个数（留痕那一行与摘要里报的条数对不上，事后读日志
   * 就得猜哪个是真的）。
   *
   * 本方法自己**不写留痕事件**：留痕在 `run()` 里写，于是"一 turn 一行"与"这一拍压没压"
   * 是两个独立的事实，不会因为将来多一条 return 就又漏一条账。
   */
  private async maybeCompact(): Promise<CompactionDecisionView> {
    // 本 step 自己写下的事件（`message/assistant`、`tool/result`…以及**本 turn 的 `turn/end`**）
    // 要先进快照：阈值判定与遮蔽点都只认日志，不认内存态拼装。
    // **这一句不能省**（2026-10-09 把判据搬进 `compactionDecision` 时省掉过，代价很具体）：
    // `endTurn` 的 `write` 只落库、不推快照，所以少了它，判定看到的是**少了 `turn/end`** 的那份
    // 快照 ⇒ `compactionCoveredUpToSeq` 的 ② 找不到本 turn 的结束点、退回本 turn 的
    // `turn/start` seq ⇒ 遮蔽点落在**这一轮的唤醒之前**：叫醒她的那句话被遮掉，而她对那句话的
    // 回答留在现场（正是 §4.13 那条"不能劈开他问的那句与她答的那段"要防的东西）。
    // 回归用例：`test/compaction-decision-wake.test.ts` 的遮蔽点那两条。
    await this.syncEvents();
    // 判定**只算一次**，而且是在一处算的（见 {@link compactionDecision}）：这里拿到的是结论，
    // 它同时喂给 ① 这条留痕事件、② 下面写摘要要用的 covered/priorCovered。
    const decision = compactionDecision({
      events: this.events,
      turn: this.turn,
      turnStartSeq: this.turnStartSeq,
      cfg: this.deps.compaction ?? null,
    });
    if (decision.reason !== 'wrote') return decision;

    // 笔记：渲染不出来（或空）时**落机械替代文本**，不许留空。
    // 留白会被读成"那段时间什么都没发生"，然后她按这个印象编下去（reasonix 的
    // mechanicalFoldDigest 就是为这一条写的）。所以 `summary` 字段在任何路径上都非空。
    //
    // 报的条数用**与闸门同一个参照点**（`previousCoveredUpToSeq`）：那句"有 N 条往来被折进来了"
    // 说的必须是"这一段里有多少条"，参照点换个值就会报一个对不上的数。
    // 这两个数**从结论里读**，不在这里重算——重算就会与留痕那一行写成两个数（两份判据）。
    const priorCovered = decision.previousCoveredUpToSeq ?? 0;
    const covered = decision.coveredUpToSeq ?? 0;
    // `deps.compaction` 在这里必非空：结论能走到 `wrote`，只可能是 `compactionDecision` 里
    // `cfg !== null` 那一支——类型系统看不出这层关系（它只看见一个属性），所以这里断言。
    const note = renderHandoffNote(this.events, handoffOptionsOf(this.deps.compaction!));
    const summary = note.text.trim() === ''
      ? mechanicalSummaryText(countMaskedEvents(this.events, priorCovered, covered))
      : note.text;

    this.write('compaction/summary', { coveredUpToSeq: covered, summary }, { sync: true });
    this.log.flush();
    return decision;
  }

  // ── 工具执行 ──

  private async executeCalls(step: number, calls: readonly ToolCallRequest[]): Promise<number> {
    // 单步刹车：超限部分不执行（§4.6「停止本 step」）。返回值＝被拦下的调用数。
    const limitOf = this.deps.budget?.stepCallLimit;
    const limit = limitOf === undefined ? calls.length : Math.max(0, Math.trunc(limitOf()));
    const allowed = limit >= calls.length ? [...calls] : calls.slice(0, limit);
    const over = limit >= calls.length ? [] : calls.slice(limit);

    // 超限部分照样两阶段落库：只写 tool/call 不写 tool/result，恢复流程会把它当成
    // 「执行到一半崩溃」——那是伪造事实。over-limit 明说“未派发”。
    for (const call of over) {
      const callSeq = this.recordToolCall(step, call, this.deps.registry.get(call.name));
      this.write('tool/result', {
        turn: this.turn,
        step,
        callId: call.callId,
        callSeq,
        status: 'over-limit',
        content: `单步工具调用数超过上限（${limit} 次），本次调用未执行。把剩下的动作拆到后面的步骤里再发。`,
        durationMs: 0,
      }, { sync: true });
    }

    if (allowed.length === 0) return over.length;

    // ── 失败连击守卫（同一个目标，一轮内）：**派发之前**判，判完就不派发 ──
    //
    // 位置与下面的软提醒同一条纪律：判据必须在执行**之前**由唯一一处按调用顺序算定（一步里多个
    // 调用的完成顺序是并发的，放到结果那一侧数，"连续"就会取决于谁先跑完）。
    // 被拒的那一次**不派发**——`read_channel` 一次超时是 10 s，白付这一笔正是守卫要省的东西。
    //
    // 落库形状与 `over-limit` 完全一致（两阶段：先 `tool/call` 再 `tool/result`）：这次调用**她确实
    // 发过**，日志里就该有那一笔；只是框架没派发它。
    //
    // status 为什么是 `'error'` 而不是新造一个：渲染层 `case 'error'` 打的是
    // `工具执行错误：${error?.message ?? content}`（`model/render.ts` 的 `renderToolOutput`），
    // 于是**回执正文原样进她的上下文**。这一条非将就不可——`timeout` 那条路的渲染会**丢掉
    // content**（同一个 switch 的 `case 'timeout'` 只打一句固定文本），所以拒绝若走 timeout 形状，
    // 她根本看不到"别再试了"。新造一种 status 则要同时动 log/types、render、handoff-note 三处
    // 的穷举分支，为一个回执改那么多地方不划算。
    //
    // **这一条不带 `error` 对象**（2026-10-10 的判据）：`error.message` 一给，渲染打的就是它，
    // `content` 那一段反而成了没被读到的那一份；而拒绝回执**必须原样可见**的正是 `content`。
    // 于是这里只写 `content`（`error?.message ?? content` 取的就是它），`handoff-note.ts` 同一条
    // 表达式也取到同一句话。辨识"这是守卫拒的、不是工具报的"靠正文那句固定前缀
    // （`failureStreakRefusal`：`工具 X 在 Y 这个目标上这一轮已经连续失败 N 次，别再试了——`）
    // ——**不再另造一个错误码**：一个只在这一处写、没人读的 code 就是死代码。
    this.failureGuard.beginBatch();
    const ready: ToolCallRequest[] = [];
    for (const call of allowed) {
      const verdict = this.failureGuard.admit(call.name, call.arguments);
      if (!verdict.refused) {
        ready.push(call);
        continue;
      }
      const callSeq = this.recordToolCall(step, call, this.deps.registry.get(call.name));
      this.write('tool/result', {
        turn: this.turn,
        step,
        callId: call.callId,
        callSeq,
        status: 'error',
        content: failureStreakRefusal(call.name, verdict.target, verdict.streak),
        durationMs: 0,
      }, { sync: true });
    }
    if (ready.length === 0) return over.length;

    // 工具软提醒（连续重复调用）：**计数在这个位置**、按 ready 的**调用顺序**推进。
    //
    // 为什么在这里而不是在 `recordToolResult` 里"数回执"：那一步是并发的（一组 parallel 调用
    // 各自跑完提交），在那里数就会让"连续"取决于谁先跑完——同一批同样的调用，两次运行可能
    // 得出不同的第 N 次。执行之前、按模型给的顺序算一次，判据才是确定的、可测的。
    //
    // 只数 ready：超限那部分**未派发**（上面已记 over-limit），被守卫拒的那部分同样**没派发**
    // ——"她调了"与"框架派发了"是两件事，重复计数只认后者（否则"连续第 N 次"里会混进根本没跑过
    // 的那些，提醒里的数字就不再是"她真的试了几次"）。
    for (const call of ready) {
      const count = this.repeatGuard.note(call.name, canonicalArgumentsOf(call.arguments));
      if (this.repeatGuard.reminderDueAt(count)) {
        this.repeatReminders.set(call.callId, repeatCallReminder(count));
      }
    }

    const ctx: ExecutionContext = {
      registry: this.deps.registry,
      turn: this.turn,
      step,
      workspaceRoot: this.workspaceRoot,
      // 活动边界（trust.mode）：与 workspaceRoot 一起进 ExecutionContext，执行器原样放进
      // 每个 ToolContext。**条件展开**是必要的：`undefined` 与"不存在"在这里必须同义
      // （exactOptionalPropertyTypes 下显式赋 undefined 与缺省不是一回事，而语义上是一回事）。
      ...(this.boundaryRoot === undefined ? {} : { boundaryRoot: this.boundaryRoot }),
      // 两阶段落库：call 先拿 seq，result 引用它（§4.5）。两者都是承诺类。
      onToolCall: (call, def) => this.recordToolCall(step, call, def),
      onToolResult: (call, result, callSeq) => this.recordToolResult(step, call, result, callSeq),
      onToolZombie: (call, note) => { this.recordZombie(call, note); },
      // 钩子拒绝的落库通道：被拦的调用不进 tool/call，但「碰过一道门且被拒」必须留痕
      onPolicyDenied: (call, rule, reason) => { this.recordPolicyDenied(call, rule, reason); },
      // 钩子附加文本回流：与 Wake 注入同一条尾部 developer 通道
      onHookContext: (text) => { this.hookContext.push(text); },
    };
    if (this.deps.hooks !== undefined) ctx.hooks = this.deps.hooks;
    if (this.deps.planGate !== undefined) ctx.planGate = this.deps.planGate;
    if (this.deps.signal !== undefined) ctx.signal = this.deps.signal;
    // 有人插话的计数读取器：turn 级，整轮共用一条（speak 是唯一消费它的工具）
    // 销账口与它同门：没有计数器的装配（子代理链、单机调用）根本判不出"被打断"，
    // 也就没有"她已经看见了这条"这件事可记。
    if (this.deps.interruptEpoch !== undefined) {
      ctx.interruptEpoch = this.deps.interruptEpoch;
      ctx.claimInterruption = (wakeSeq) => { this.claimInterruption(wakeSeq); };
    }
    if (this.deps.modelVisibility !== undefined) ctx.modelVisibility = this.deps.modelVisibility;
    if (this.deps.isolation !== undefined) ctx.isolation = this.deps.isolation;
    await executeToolCalls(ready, ctx);
    return over.length;
  }

  private recordToolCall(step: number, call: ToolCallRequest, def: ToolDefinition | null): number {
    const event = this.write('tool/call', {
      turn: this.turn,
      step,
      callId: call.callId,
      name: call.name,
      // 原始 JSON 文本照原样落库，解析失败也不例外（schema §4）
      arguments: call.arguments,
      // 未注册的名字不轻信：按 destructive 记账，恢复期就不会给它自动重试的待遇
      sideEffect: def?.sideEffect ?? 'destructive',
    }, { sync: true });
    return event.seq;
  }

  private async recordToolResult(
    step: number,
    call: ToolCallRequest,
    result: ToolExecutionResult,
    callSeq: number,
  ): Promise<void> {
    const data: Record<string, unknown> = {
      turn: this.turn,
      step,
      callId: call.callId,
      callSeq,
      status: result.status,
      content: result.content,
      durationMs: result.durationMs,
    };
    if (result.error !== undefined) data['error'] = result.error;

    // 失败连击守卫的**记账口**：就放在回执定形这一处（同一次调用只会到这里一次——被 PreToolUse
    // 钩子或计划模式拦下的那些连 `tool/call` 都没有，执行器也不会回调 `onToolResult`，所以这里
    // 记下的每一笔都对应一次**真派发过**的调用）。status 由执行器给出，守卫只查表。
    //
    // 放在 blob 外置与软提醒**之前**：那两件都可能抛（外置要写盘），而计数该在结果一到就落定，
    // 不能因为回执排版失败就漏记——漏记的后果是守卫少算一次、下一轮继续白付超时。
    this.failureGuard.settle(call.name, call.arguments, result.status);

    // 单条回执的上限（§4.12，2026-10-06 加）：**先写 blob 再写事件**——事件里只有预览，
    // blob 没落盘就等于丢全文。两个维度取小（估算 21k token / 64 KiB，见 BlobOffloadOptions）。
    //
    // **这是唯一的定形点**：`tool/result` 一旦写下，可见字节就冻结了。压缩、交接、恢复
    // 都不回来改它——不许加"扫历史、发现超限、再截短"那种维护（那会让前缀每轮都变）。
    //
    // 只对 status:'ok' 外置：渲染层仅在该分支消费 contentRef（见 model/render.ts 的
    // renderToolOutput），给别的状态挂 contentRef 会得到"看着完整、其实被截断"的假象。
    // 内建默认值（不配 blobOffload 也生效）：**子代理那条路曾经就是"没有界"的**——
    // 它不传 blobOffload，于是一次大回执能把它自己的上下文吃满而它连"被截了"都不知道。
    const offload = this.deps.blobOffload ?? null;
    if (result.status === 'ok' && result.content.length > 0 && offload !== null) {
      const outcome = await offloadIfLarge(result.content, offload);
      data['content'] = outcome.content;
      if (outcome.contentRef !== undefined) data['contentRef'] = outcome.contentRef;
    }

    // 工具软提醒（连续重复调用）落点：**追加在这一条 tool/result 的正文末尾**。
    //
    // 为什么是这里（而不是走 softHint 那条尾部 developer 通道）：
    //   · 她当场就看得到——贴在"那一次调用的回执"上，与它描述的事实同一段；
    //   · 只进这一次、只进这一条：softHint 是**请求级**的，而这一步之后本 turn 还有若干步，
    //     挂在那儿的提示会在同一轮里反复重播，变成常驻开销（用户明确否掉了这条）；
    //   · 它**落库**（内容在事件里定形，见下），所以重放/界面预览看到的是同一句话。
    //
    // **为什么必须在写事件之前贴、而不是"渲染时现算"**：重放不重跑工具，它只有日志。
    // 现算就得在渲染层再数一遍连续调用——那正是"判据分两处写"的形状（两处迟早分岔）。
    // 贴进 content 之后判定与文本同源，`deriveRequest` 那条重建路径不用改一行。
    // 这不违反「事件写下即定形」：定形的**时刻**就是这里，此后无人再回来改它。
    //
    // 放在 blob 外置**之后**：万一这一次回执大到被外置，content 只剩头部预览，
    // 提醒若在之前追加就会被截掉——它是这一条回执里唯一"框架对她说的话"，不能被截。
    const reminder = this.repeatReminders.get(call.callId);
    if (reminder !== undefined) {
      this.repeatReminders.delete(call.callId);
      data['content'] = `${String(data['content'] ?? result.content)}\n\n${reminder}`;
    }

    this.write('tool/result', data, { sync: true });
  }

  private recordZombie(call: ToolCallRequest, note: string): void {
    this.write('tool/zombie', { callId: call.callId, name: call.name, note }, { sync: false });
  }

  /**
   * PreToolUse 的拒绝落库（design §4.19 第 5 条 / schema §4）：`rule` 恒为 'hook'——
   * 枚举里没有「第几条钩子」这一档，具体命中哪条由执行器回给模型的文本带出。
   */
  private recordPolicyDenied(call: ToolCallRequest, rule: string, reason: string): void {
    const detail = rule === 'hook' ? reason : `${reason}（命中 ${rule}）`;
    this.write('policy/denied', {
      tool: call.name,
      rule: 'hook',
      reason: detail,
      callId: call.callId,
    }, { sync: true });
  }

  // ── 人审挂起（design §4.21） ──

  /**
   * 本 turn 是否留下了未被答复的**人审挂起**。
   *
   * 口径与 plan-mode 的 `scanSuspension` **共用同一份实现**（`hasPendingSystemAsk`：FIFO 配对、
   * `askSeq` 精确配对优先），但只看**本 turn 起点之后**的事件：上个 turn 的挂起是历史，
   * 不该让本 turn 替它买单。配对不按 question 文本——同一批里可能有多件计划各自提问，
   * 而提问文本是同一个界面常量。
   *
   * **她自己的提问不算挂起**（design §6.5：旧实现错在"等"，不在"问"）：`ask_human` 写下的
   * `human/asked{source:'agent'}` 与计划拦截那条是两种来源，前者写完这一轮照常往下走。
   * 少了这层过滤，"她说了一句需要人回答的话"就会把 turn 停在这里——那正是被否掉的旧形态。
   */
  private async humanSuspension(): Promise<boolean> {
    await this.syncEvents();
    return hasPendingSystemAsk(this.events, { afterSeq: this.turnStartSeq });
  }

  // ── 钩子（design §4.19） ──

  /**
   * Wake 点：唤醒到达时问一次钩子要不要注入附加输入。本方法**不抛**——
   * 钩子故障不能成为「醒不来」的理由；`HookRunner` 已把故障折成无决定，这里是双保险。
   */
  private async runWakeHooks(wakeText: string): Promise<string | null> {
    const hooks = this.deps.hooks;
    if (hooks === undefined) return null;
    try {
      const result = await hooks.wake({
        text: wakeText,
        sources: wakeSources(this.wakeEvents),
        turn: this.turn,
      });
      return result.context;
    } catch {
      return null;
    }
  }

  /** 取走待注入的钩子上下文（取走即清空：同一条文本只注入一次，重复注入只是噪音） */
  private drainHookContext(): string | null {
    if (this.hookContext.length === 0) return null;
    const text = this.hookContext.join('\n\n');
    this.hookContext.length = 0;
    return text;
  }

  // ── 记账 ──

  /**
   * 模型调用成功返回后的预算归账（缓存命中拆分对齐 §4.13 观测闭环）。
   *
   * 用量里还带上 `reasoningTokens`（思维链 token，2026-10-06 起落库）：它**已经含在
   * `outputTokens` 里**，所以只是观测——账本口径一个字都没改（`state/fold.ts` 不看它）。
   *
   * 同一条事件上还挂两笔**上下文事实**（2026-10-03；不新增事件类型，见 context-audit.ts）：
   *   · `context`：这次请求的上下文构成（渲染层的副产物，段边界只有它知道）；
   *   · `cacheBreak`：与**上一次被审计的调用**做前缀比对的结论，只在真失守时出现。
   *     2026-10-05 起它多带一份**归因**（`cause` / `causes` / `silent`，判据见
   *     `context-audit.ts` 的 `segmentCause`）：预期内的失守（重启、她改资产、工具清单、
   *     压缩、渲染换代、空闲）降级成普通记录，只有"无法归因"仍然告警——用户那次的原话是
   *     「预期内的代价和真正的异常混在同一条告警里 ⇒ 告警常态化 ⇒ 人就不看了」。
   * 两次比对之间没有额外的请求，所以"一步一条"既是归因的粒度，也是哨兵的粒度。
   *
   * ⚠️ **本方法写下的 `tokensTodayAccum` 是观测字段，别拿它当预算依据**（2026-10-11 写准）：
   * 它的形状是"**本条之前的内存投影当日累计（新口径 `budgetTokensOf` 折出来的）+ 本条
   * `inputTokens + outputTokens`（旧口径增量）**"——2026-10-05 换预算口径时基线换了、delta
   * 没换，于是这个字段**天生是混合口径**。全仓**五处写入一律如此、彼此自洽**（本方法
   * 成功路径、`failStep` 失败路径写全 0、`channel/injection-judge.ts:203`、`channel/topic.ts:188`、
   * `persona/memory-maintain.ts:719`），所以**谁也别说谁写错了**。
   * **一切预算读数走投影**（`state/fold.ts` 的 `budgetTokensOf`），任何闸门/判据都不许拿这个
   * 字段当依据——doctor 的 I7 原来核它，2026-10-05 起天天假报，2026-10-11 已把那条判据删掉。
   * 真正要对齐的话，最小改法是上面那 5 处一起改成
   * `this.projection.budget.tokensToday + budgetTokensOf({ inputTokens, cacheHitTokens: cacheHit, outputTokens: usage.outputTokens })`，
   * 代价是同时要改三支钉住"in+out 累进"的断言（`test/task-tool-wiring.test.ts:423`、
   * `test/subagent.test.ts:352-353`、`test/memory-maintain.test.ts:228`）+ `docs/schema.md` §6 的注释；
   * **本轮刻意不做**（收益只有字段语义好看，代价是动运行期写入式子）。
   */
  private accountStep(
    step: number,
    result: DsStreamResult,
    interrupted: boolean,
    fallbackModel: string,
    request: RenderedRequest,
  ): void {
    const usage = result.usage;
    const inputTokens = usage.inputTokens;
    const cacheHit = Math.max(0, Math.min(usage.cachedTokens, inputTokens));
    const ts = this.deps.now();
    // 基准 = **本 runner 上一次记账的那一拍**（见 {@link TurnRunner.previousAuditedCall}）。
    // 刻意**不再**从 `this.events` 现取：那是轮首对齐的日志快照，而 `budget/consumed` 由本 runner
    // 自己写、不回填快照 ⇒ 取到的是**上一轮**那一拍（00:30 三拍共用同一 prev 的根）。
    const previous = this.previousAuditedCall;
    const audit: AuditedCall = {
      context: request.context,
      ts,
      cacheHitTokens: cacheHit,
      cacheMissTokens: Math.max(0, inputTokens - cacheHit),
      // 轮号只服务固定块的"形状差异"判据（块只在每轮第 1 步发，跨轮的块哈希本就不可比）
      turn: this.turn,
      // **请求体构造点**（= `context.builtAtSeq`）：这条请求渲染时看得见的最大事件 seq。
      // 事件窗口优先用它（见 `context-audit.detectCacheBreak`）——`seq` / `ts` 是调用**结束**的时刻，
      // 在飞久的调用会把真正的原因挡在窗口外，那正是 2026-10-09 两次误报"原因不明"的机制。
      ...(request.context.builtAtSeq === undefined
        ? {}
        : { builtAtSeq: request.context.builtAtSeq }),
    };
    // 第 4 个参数是**事件序列**：归因要用"两次调用之间发生了什么"（重启 / 她改了资产 / 工具清单 /
    // 压缩）来解释每一段指纹为什么变，判据只在 `context-audit.ts` 一处（见 `segmentCause`）。
    // 这里传的是同一份日志快照——重放走同一条路，所以归因也是可复算的，不是运行期才有的观测。
    const cacheBreak = detectCacheBreak(previous, audit, this.deps.cacheBreakThresholds, this.events);
    // **本轮可信级别进账**（2026-10-11 加，纯观测）：它解释"这一拍的工具清单为什么是那一版"——
    // `external` 那一档只看得见 `speak`/`report`/`read_channel`/`vision_read` 四件，用户/她自己
    // 那一档 24 件，来回切时 `tools` 段在两版之间对调、其后一切重算。在此之前日志里没有这一格，
    // 事后只能从 `wake/*` 反推 ⇒ 现场表现为一句"原因不明"。
    //
    // ⚠ **它不进请求体、也不改任何判据**：`context` 整体不进请求（`ds-client.buildRequestBody`
    // 只发 model / input / instructions / tools / …），所以加它不必动 `RENDER_VERSION`。
    // 宿主没给（子代理链、诊断、既有测试）⇒ **字段不出现**，事件形状与引入它之前逐字节相同。
    const contextOut = this.deps.trust === undefined
      ? request.context
      : { ...request.context, trust: this.deps.trust };
    const data: Record<string, unknown> = {
      turn: this.turn,
      step,
      lane: this.lane,
      model: result.model ?? fallbackModel,
      inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitTokens: cacheHit,
      cacheMissTokens: Math.max(0, inputTokens - cacheHit),
      // 思维链 token（观测字段，已含在 outputTokens 里，不参与预算算式）。
      // **每次都写**：这一档没产思维链就是 0——见 log/types.ts 的字段注释。
      reasoningTokens: usage.reasoningTokens,
      durationMs: result.durationMs,
      // 成功路径没有重试计数通道（DsClient 只把 attempts 挂在外抛错误上）；M3 接 onRetry 回填
      retryCount: 0,
      finishReason: finishReasonOf(result, interrupted),
      tokensTodayAccum: this.projection.budget.tokensToday + inputTokens + usage.outputTokens,
      // 归因事实 + 那一格纯观测的 `trust`（宿主给了才有，见上面那段注释）
      context: contextOut,
      // 构造点的**镜像**：读日志的人一眼能看到"这一拍是什么时候装出来的"（ts 是结束时刻）
      ...(request.context.builtAtSeq === undefined ? {} : { contextBuiltAtSeq: request.context.builtAtSeq }),
      // 只在真破坏时出现：没有它就代表"这次与上次的冻结前缀一致"（不是"没查"）
      ...(cacheBreak === null ? {} : { cacheBreak }),
    };
    this.write('budget/consumed', data, { sync: false });
    // 存下这一拍，供**下一步**当基准（唯一写入点，紧挨着上面那条账：两者必须同进同出，
    // 分开放就会漂成"记了一拍、基准是另一拍"——那正是这次修的错）。
    this.previousAuditedCall = audit;
  }

  /** 模型调用抛错：分类 → 结局。失败也必须记账，否则 §4.6 的失败刹车永远看不到连续失败 */
  private failStep(step: number, error: unknown): TurnEndReason {
    const known = isDsClientError(error);
    const code = known ? error.code : 'UNKNOWN_MODEL_ERROR';
    // 服务端原话要带出来：400 的响应体里往往写着真正的原因（哪个字段不合法），
    // 只留一句「请求被拒绝」等于把唯一的线索丢掉——上一轮就是靠补上它才查得下去。
    const detail = known ? (error.detail ?? null) : null;
    const base = error instanceof Error ? error.message : String(error);
    const message = detail === null || detail === '' ? base : `${base}；服务端原话：${detail}`;
    this.write('budget/consumed', {
      turn: this.turn,
      step,
      lane: this.lane,
      model: this.deps.ds.modelFor(this.lane),
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      // 调用抛错 ⇒ 服务端连 usage 都没回来，思考 token 只能是 0（字段照写，不留空）
      reasoningTokens: 0,
      durationMs: 0,
      retryCount: known ? Math.max(0, error.attempts - 1) : 0,
      finishReason: 'failed',
      tokensTodayAccum: this.projection.budget.tokensToday,
    }, { sync: false });
    this.write('step/end', { turn: this.turn, step, toolCalls: 0 }, { sync: true });
    this.log.flush();

    if (known && error.kind === 'rate_limited') {
      return { kind: 'rate-limited', retryAfterMs: error.retryAfterMs ?? 0 };
    }
    if (known && error.kind === 'aborted') return { kind: 'aborted', cause: 'signal' };
    return { kind: 'error', message, code };
  }

  private endTurn(reason: TurnEndReason): TurnEndReason {
    // **整轮失败时把输入退回去**（2026-10-02 补，用户报的一处洞）：模型/服务端拒了请求
    //（例如缺配对的 tool_call 被 400 打回），这一轮认领的输入不该就此消失——她连"有人叫过我"
    // 都看不到第二次。退回去是"还有一次完整机会"，与崩溃恢复走同一条路（`input/requeued`），
    // 认领次数照样累计；到 MAX_CLAIM_COUNT 就进死信（毒消息保护：一条必然失败的输入
    // 不该把守护进程拖进"拉起→失败→拉起"的循环）。
    if (reason.kind === 'error') this.requeueOnTurnError();
    this.write('turn/end', { turn: this.turn, reason, spoke: this.spoke }, { sync: true });
    this.log.flush();
    return reason;
  }

  /**
   * 整轮失败 → 退回本轮认领过的输入（`input/requeued{reason:'turn-error'}`），
   * 到上限的进死信（`input/dead-letter`）。**认领次数照旧累计**，所以失败不会无限重试。
   */
  private requeueOnTurnError(): void {
    if (this.claimedCounts.size === 0) return;
    const wakeSeqs: number[] = [];
    const claimCounts: number[] = [];
    const sources: WakeSource[] = [];
    for (const [wakeSeq, countAtClaim] of this.claimedCounts) {
      const nextCount = countAtClaim + 1;
      if (nextCount >= MAX_CLAIM_COUNT) {
        this.write('input/dead-letter', {
          inputSeq: wakeSeq,
          claimCount: nextCount,
          lastError: '整轮失败（模型或服务端拒了请求）反复认领，不再自动重试',
        }, { sync: true });
        continue;
      }
      const event = this.log.get(wakeSeq);
      wakeSeqs.push(wakeSeq);
      claimCounts.push(nextCount);
      // `wakeSourceOf` 认不出类型时给 'manual'（它自己的兜底）——这里只是类型上要一个确定值
      sources.push(event === null ? 'manual' : wakeSourceOf(event.type));
    }
    if (wakeSeqs.length > 0) {
      this.write('input/requeued', { wakeSeqs, claimCounts, sources, reason: 'turn-error' }, { sync: true });
    }
  }

  // ── 输入认领 ──

  private claimInput(): { wakeSeqs: number[]; claimCounts: number[] } {
    const wakeSeqs: number[] = [];
    const claimCounts: number[] = [];
    for (const event of this.wakeEvents) {
      // 认领次数取自投影的 pending 项（interrupted 退回时 +1），首次为 0。
      // 投影里找不到也照常认领：认领是"这批输入归本 turn"，不该依赖投影的瞬时状态。
      const item = this.projection.pending.find(p => p.wakeSeq === event.seq);
      wakeSeqs.push(event.seq);
      claimCounts.push(item?.claimCount ?? 0);
    }
    if (wakeSeqs.length === 0) return { wakeSeqs, claimCounts };
    this.write('input/claimed', { turn: this.turn, wakeSeqs, claimCounts }, { sync: true });
    // 记下"认领当时的次数"：整轮失败时要按它算出退回时的次数（见 requeueOnTurnError）
    for (const [i, seq] of wakeSeqs.entries()) this.claimedCounts.set(seq, claimCounts[i] ?? 0);
    return { wakeSeqs, claimCounts };
  }

  /**
   * 中途插话的销账：她**看见**了一条打断她的输入，把它补记到本轮账上。
   *
   * 为什么账要能分批记：认领本来是 turn 开始时记一次（`claimInput`），而中途到的唤醒从没进过
   * 那一笔；她因为看见它才被打断，可它一直留在待办里——`turn/end` 只清账上的那些，
   * 于是它下一轮又被认领，同一个问题再答一遍（docs/review.md「未了结」的实测事故）。
   *
   * 为什么由 speak 的打断分支触发、而不是"有人开口"就销账：`noteUserSpoke` 在她没发言时
   * 同样会跑，在那里销账会把一条她根本没看见的消息整个吞掉——比重复回答严重得多。
   *
   * 前提（fold 侧）：`claimedByTurn[turn]` 已是**并集**。否则这条补记会抹掉本轮原有的账，
   * 而那份账是"turn 异常中断时据以退回输入"用的——抹掉它等于丢掉她真正消化过的输入。
   */
  private claimInterruption(wakeSeq: number): void {
    const item = this.projection.pending.find(p => p.wakeSeq === wakeSeq);
    const count = item?.claimCount ?? 0;
    this.claimCountsSeen(wakeSeq, count);
    this.write('input/claimed', {
      turn: this.turn,
      wakeSeqs: [wakeSeq],
      claimCounts: [count],
    }, { sync: true });
  }

  /** 记下这次认领的次数（整轮失败时按它算退回次数）——只增不改：同一 seq 反复认领时留最早那个 */
  private claimCountsSeen(wakeSeq: number, count: number): void {
    if (!this.claimedCounts.has(wakeSeq)) this.claimedCounts.set(wakeSeq, count);
  }

  /**
   * 中途插进来的唤醒：**进了这一份请求就销账**（2026-10-02 修）。
   *
   * 为什么不能只在 speak 的打断分支销账（那是原先的唯一入口）：那个分支要求"这条插话正好
   * 撞在她开口的那一下"。实测撞到的却是另一种：他说话时她正在想、正在跑工具，于是她
   * **先看到、再开口**——这一轮她答了，账却没销，下一轮那条唤醒又被认领一次，同一个问题
   * 再答一遍（样本：`wake/channel` seq 7969 在 turn 168 里已经答过，却在 turn 169 的
   * `input/claimed` 里又出现一次；见 docs/review.md）。
   *
   * 为什么用"进了请求"当判据，而不是"有人开口"就销账：`noteUserSpoke` 在她**没看见**那条消息时
   * 也会跑，在那里销账会把一条她根本没看到的话整个吞掉——比重复回答严重得多。而"这一份请求里
   * 有它"是确凿的看见：在那之后她才可能决定理不理、答不答，那正是账本该记的事。
   *
   * 只认本 turn 开始之后到的（`wakeSeq > turnStartSeq`）：开轮那一批已经由 `claimInput` 记过。
   * 也只在**没有被本 turn 记过**时写（`claimedMidTurn`），免得同一批重复落账。
   */
  private claimDeliveredInputs(): void {
    const latest = this.events[this.events.length - 1]?.seq ?? 0;
    const judge = this.deps.isFrameworkWake;
    const fresh = this.projection.pending
      .filter(item => item.wakeSeq > this.turnStartSeq
        && item.wakeSeq <= latest
        && !this.claimedMidTurn.has(item.wakeSeq)
        // **框架自己的动作不许被轮内领走**（2026-10-11）：判据不是"到没到"而是"这是什么"。
        // 它必须留在 `pending` 里 —— 本 turn 结束后的下一拍，`real-loop.tickOnce` 的
        // `memoryMaintainWake(batch)` 会照常在开轮**之前**把它认走、走整理（那条路一直在，
        // 缺的只是"别在半路把它摘掉"，见 `AgentLoopDeps.isFrameworkWake`）。
        //
        // 不写 `input/claimed` 还意味着"turn 异常中断时的退回"完全不涉及它
        // （`claimedByTurn[turn]` 里没有它）⇒ 两条失败路径都安全。
        //
        // 事件取不到（日志里没有这条 seq）⇒ 不排除：那种 pending 项已经被别的路径处理过，
        // 这里"什么都没判出来"，退回改动之前的形状最安全。
        && !this.isFrameworkWakeSeq(judge, item.wakeSeq));
    if (fresh.length === 0) return;
    for (const item of fresh) {
      this.claimedMidTurn.add(item.wakeSeq);
      this.claimCountsSeen(item.wakeSeq, item.claimCount);
    }
    this.write('input/claimed', {
      turn: this.turn,
      wakeSeqs: fresh.map(item => item.wakeSeq),
      claimCounts: fresh.map(item => item.claimCount),
    }, { sync: true });
  }

  /**
   * 这一条 pending 对应的唤醒，是不是**框架自己的动作**（判据由宿主注入，见 `isFrameworkWake`）。
   *
   * 事件取不到 ⇒ `false`（不排除）：那种 pending 项已经被别的路径处理过，
   * 这里"什么都没判出来"，退回改动之前的形状最安全。
   */
  private isFrameworkWakeSeq(judge: ((event: AppEvent) => boolean) | undefined, wakeSeq: number): boolean {
    if (judge === undefined) return false;
    const event = this.deps.log.get(wakeSeq);
    return event !== null && judge(event);
  }

  /**
   * 交给渲染层的事件流：**框架自己的动作一条都不进**（2026-10-11）。
   *
   * 为什么光"不认领"还不够（这一条是实测出来的，不是推的）：`this.events` 是整条日志的快照，
   * 而 `renderEvents` 会把每一条 `wake/*` 渲染成历史里的一行——所以只把那条整理唤醒留在
   * `pending` 里，她**照样**在下一步的请求体里看见 `[定时器触发] t_…`（那一行只是从"本轮新输入"
   * 挪到了"历史"里）。10-08 的代价正是"她看见了"那一半：她会自己动手把账补上（花的是 heavy 的钱）。
   * 判据与认领那一侧**同一个函数**（`isFrameworkWake`）：一条唤醒要么整条都不进她的上下文，
   * 要么就照旧当普通输入——不存在"进了上下文但没销账"这种半吊子状态。
   *
   * 只在这一处过滤，**不动 `this.events` 本身**：它是"日志快照"，重放（`deriveRequest` 从日志
   * 重算）与它读的是同一份，改它等于改写历史。
   */
  private requestEvents(wakeEvent: AppEvent | null): AppEvent[] {
    // 本轮新输入走 wakeEvent 参数，就不能同时出现在事件流里（见文件头协同契约）
    const wakeSeq = wakeEvent?.seq;
    const judge = this.deps.isFrameworkWake;
    return this.events.filter((event) => event.seq !== wakeSeq
      && !(judge !== undefined && judge(event)));
  }

  /** 唤醒文本（Wake 钩子的入参）：与请求体里"本轮新输入"那一格**同一串字节** */
  private wakeText(): string {
    const payloads = this.timerPayloads();
    // 提及那一轮：钩子与请求体看到的必须是**同一份文本**（否则"紧急信息由钩子带进来"这类判断
    // 会按着一段她已经看不到的话来做）。所以这里也换成那句通知。
    //
    // **必须走 `contactWithWakeStamp`**（2026-10-06 修）：请求体那一格是 `deriveRequest` 用
    // **盖章过**的 contact 算出来的，这里原先拿的是**没盖章**的 `this.deps.contact`——于是钩子
    // 看到的那句通知少了「（10:00 到的这一条）（这一条你还没看过）」两小段，与它自己这条注释
    // 说的"同一份文本"不符。同一处判据只留一份：两边都走 `contactWithWakeStamp` + `mentionNoticeOf`。
    const notice = mentionNoticeOf(
      contactWithWakeStamp(this.deps.contact ?? null, this.wakeEvents[0] ?? null, this.deps.timezone),
      this.wakeEvents[0] ?? null,
    );
    return this.wakeEvents
      .map((event) => (notice !== null && event.type === 'wake/channel'
        && event.data.messageId === notice.messageId
        ? notice.text
        : renderWake(event, payloads)))
      .filter(text => text !== '')
      .join('\n');
  }

  private taskCard(step: number): { title: string; turn: number; step: number; todoOpen: string[]; assets?: string } {
    const first = this.wakeEvents[0];
    // 标题用 wakeTitle（人读摘要），不是 renderWake（给模型看的带来源标注版）：
    // 否则任务卡会写成「[界面消息] 看一眼日志」
    //
    // **提及那一轮的换法不在这里**（v35 收敛，2026-10-06）：那是"这一轮她到底看到哪句话"的判据，
    // 归 `deriveRequest()` 一处管——它手上才有**盖章过**的 contact。原先在这里另换一次，
    // 用的是没盖章的那份，于是标题与本轮新输入差着两小段；重放那一侧更是完全没换，
    // 标题直接成了正文原文。这里只给"其余轮次"的标题（`wakeTitle`）。
    // 提及那一轮的结果：`taskCard.title` 会被 `deriveRequest` 换成那句通知。
    const title = first === undefined
      ? ''
      : clipTaskTitle(wakeTitle(first, this.timerPayloads()));
    // 本任务相关资产那一行（v34）：**只在有任务卡时**才存在，且整轮原样转手（deps 里那份是
    // 轮首算好的，见 real-loop 的 agentDeps）。她 turn 内改了 STATE 不影响它——它说的不是状态，
    // 是"这件事可能用得上哪几件工具"，一轮之内本来就不会变。
    const assets = (this.deps.assetsLine ?? '').trim();
    return {
      title,
      turn: this.turn,
      step,
      // 待办**只从 STATE 那两节读**（2026-10-04 合并：todo 工具写的就是那两节）。
      //
      // 为什么不再读 `projection.todoList`：投影那份曾经是第二本账，`todo` 工具现在不写它了
      // （写 STATE + 落 persona/updated），继续读它会得到一个**停在旧内容上**的看板——
      // 那正是"两处记一套"的另一种形态，而且更难发现（界面看着有清单，其实是上一版的）。
      //
      // 为什么每次现取而不缓存：`deps.persona` 在运行期是 getter（real-loop），而 `todo` 写完
      // 会触发 `onPersonaUpdated` → 从盘上重载 STATE → 同一轮的后续 step 立刻看得见新清单。
      // 这与固定块取轮首快照那条纪律**不冲突**：任务卡在此刻层（逐 step 变），它本来就该是最新的。
      todoOpen: openTodoItems(this.deps.persona.state ?? ''),
      ...(assets === '' ? {} : { assets }),
    };
  }

  /** timerId → 最近一条 timer/set 的 payload（wake/timer 本身不带 payload，与渲染层同源） */
  private timerPayloads(): Map<string, unknown> {
    const map = new Map<string, unknown>();
    for (const event of this.events) {
      if (event.type === 'timer/set') map.set(event.data.timerId, event.data.payload);
      if (event.type === 'timer/cancelled') map.delete(event.data.timerId);
    }
    return map;
  }

  // ── 日志快照 ──

  /** 把 lastSeq 之后的事件增量补进快照。render 的输入必须逐条来自日志，不接受内存态拼装。 */
  private async syncEvents(): Promise<void> {
    const last = this.events[this.events.length - 1];
    const from = last === undefined ? 1 : last.seq + 1;
    for await (const event of this.log.readRange(from)) {
      if (last !== undefined && event.seq <= last.seq) continue;
      // 隔离过滤（子代理）：被挡掉的事件不进快照，于是 render 看到的就是「从空事件序列起」那一份。
      // 它在 seq 上是跳跃的，但 render 只要求按 seq 升序（不要求连续）。
      if (this.deps.eventFilter !== undefined && !this.deps.eventFilter(event)) continue;
      this.events.push(event);
    }
  }

  private maxTurn(): number {
    let max = 0;
    for (const event of this.events) {
      if (event.type === 'turn/start' && event.data.turn > max) max = event.data.turn;
    }
    return max;
  }

  /**
   * 轮首的**记忆索引注入账**（B2）：调宿主给的纯函数，把结论**写成事件**。
   *
   * 为什么要落库（`memory/selected`，internal）：事后重建请求时，"这一轮注入了没有、注入的是哪一版
   * 索引"只能靠事件知道（docs/memory-injection.md §4）。运行期临时算一份，重建就得再算一遍，
   * 而重算要看**现在**的索引文件——那就不是"当时那个请求"了。
   *
   * 2026-10-04 起它**只是账**：固定块里那段索引由 `deps.memoryIndex` 直接给（运行期与重放同源），
   * 这里不再产生进上下文的文本——原来那一半（"选中的正文"）按用户的口径删掉了，见
   * {@link MemorySelector} 的注释。
   *
   * 心跳轮（`isHeartbeatTurn`）：宿主会回 `injection: 'heartbeat'`——没人在跟她说话，索引不注入。
   * 事件照写：这样"为什么这一轮她没看见索引"在日志里是有答案的，而不是一个沉默。
   *
   * v34 起这条账顺带带上**本任务相关资产那一行**（`assets`，可选）：理由同 `indexHash`——
   * 盘上的 `assets.md` 与那份索引一样是她随时会改的，重建要逐字节复原就必须有当时的结论。
   */
  private selectMemoryForTurn(): void {
    const selector = this.deps.memorySelector;
    if (selector === undefined || selector === null) return;
    const plan = selector({ wakeEvents: this.wakeEvents, turn: this.turn });
    // 事件先写：写完之后它才在快照里（seq 小于第一个 step/start），账目与请求同源
    this.write('memory/selected', {
      turn: this.turn,
      injection: plan.injection,
      indexHash: plan.indexHash,
      entries: plan.entries,
      // ── 阶段一（2026-10-15）：**"挑出来的 id 列表 + 查询指纹 + 命中分数"** ──────────
      // 升级之前这条账只落 `indexHash` + `entries`，而实测报告 §6 记着那个后果：
      // 事后**无法**逐轮重建"当时推到她眼前的是哪几条"。
      //
      // ⚠ **缺省 = 老事件**（2026-10-15 之前那些）：那时固定块里注入的是整张指针表，
      // 没有"挑出来的几条"这回事。所以这三格是**可选**的，读的人必须按"不在就是没有"处理
      // （别给它们补默认值：补成 `[]` 会让"老事件"与"这一轮一条都没挑出来"变成同一种读法）。
      // 与 `assets` 那一格同一条纪律：不写空字段，老事件的形状因此逐字节不变。
      ...(plan.injected === undefined ? {} : { injected: plan.injected }),
      ...(plan.selected === undefined ? {} : { selected: plan.selected }),
      ...(plan.scores === undefined ? {} : { scores: plan.scores }),
      ...(plan.query === undefined ? {} : { query: plan.query }),
      // 空串 = 这一轮没有那一行：不写空字段（老事件的形状因此逐字节不变）
      ...(plan.assets === undefined || plan.assets === '' ? {} : { assets: plan.assets }),
    }, { sync: true });
  }

  /**
   * 这一刻的固定块素材：宿主给的状态 / 关系档案。
   *
   * 每次 `deriveRequest` 都重新装配一份（`TurnBlockFacts` 是个小对象），但**内容**在一轮之内
   * 逐字节相同——状态与关系来自 deps（轮首定下）。
   * **记忆那一段不在这里**（2026-10-04）：机制不再替她挑正文塞进固定块，块里关于记忆的只有
   * `deps.memoryIndex` 那份索引（指针表）。理由与代价见 docs/memory-injection.md §5。
   *
   * 没有宿主素材时返回 null：整块不出现（子代理与诊断就是这种情形）。
   */
  private turnBlockNow(): TurnBlockFacts | null {
    return this.deps.turnBlock ?? null;
  }

  private deriveAt(args: {
    wakeEvent: AppEvent | null;
    step: number;
    now: string;
    model: string;
    softHint: string | null;
  }): RenderedRequest {
    // 本轮新输入走 wakeEvent 参数，就不能同时出现在事件流里（见文件头协同契约）；
    // 框架自己的动作（整理唤醒）**两条路都不进**（见 `requestEvents`）。
    const events = this.requestEvents(args.wakeEvent);
    // 进请求的清单是**现取的活值**（不缓存、不从事件读）——它是 `tools` 段失守时唯一的事实来源，
    // 所以在这一行上面比一次指纹、变了就落一条 internal 账（BUG-3）。**只读、不改字节**。
    const options = this.deps.modelVisibility ?? {};
    const tools = this.deps.registry.listForModel(options);
    this.noteToolInventory(tools, options, args.step);
    return deriveRequest({
      persona: this.deps.persona,
      tools,
      timezone: this.deps.timezone,
      lane: this.lane,
      events,
      wakeEvent: args.wakeEvent,
      taskCard: this.taskCard(args.step),
      now: args.now,
      model: args.model,
      softHint: args.softHint,
      skillCatalog: this.deps.skillCatalog ?? null,
      // MCP 索引（v46）：与技能索引同段素材。**整轮原样转手**（deps 装配点上定下，
      // 而它的字节来自日志里那条 `mcp/index` 快照——一轮之内、两次重大变化之间都不会变）。
      mcpIndex: this.deps.mcpIndex ?? null,
      memoryIndex: this.deps.memoryIndex ?? null,
      // 本轮固定块：deps 里那一份是**轮首定下**的（宿主装配 deps 时算一次），
      // 每步原样转手——她 turn 内改了 STATE 要等下一轮才在自己的上下文里看见，
      // 换来的是一轮之内这一段逐字节不变（docs/memory-injection.md §2 的取舍）。
      // 记忆那一段**不在这里**（2026-10-04）：固定块里关于记忆的只有上面那份索引（`memoryIndex`），
      // 正文要她自己 `safe_read`（用户口径见 docs/memory-injection.md §5）。
      turnBlock: this.turnBlockNow(),
      // STATE 预算（v32）：宿主装配 deps 时给一次（`config.persona.stateBudgetBytes`），
      // 每步原样转手。字节数不在这里传——它在 deriveRequest 里从 `persona.state` 量，
      // 于是运行期/重放/预览三条路量的是同一份文本、用同一个函数（stateBytesOf）。
      stateBudgetBytes: this.deps.stateBudgetBytes ?? DEFAULT_STATE_BUDGET_BYTES,
      // 维护窗口（2026-10-11）：**轮首定下、每步原样转手**（与 machine/usage 同节奏）。
      // 不在这里现算的理由是硬纪律：渲染层不读时钟、不读事件（缓存铁律 1），
      // 而判据要的正是"现在几点 + 上一条压缩判定读到多少 token + 上次窗口是什么时候"。
      maintenanceWindow: this.deps.maintenanceWindow ?? null,
      contact: this.deps.contact ?? null,
      // 本机与用度：宿主在**每个 turn 装配 deps 时**算一次（与 contact 同节奏）——磁盘 statfs
      // 与进程 uptime 是会失败的 IO，不适合每个 step 都做一遍；用度是"今日累计"，一拍一算是够的。
      machine: this.deps.machine ?? null,
      usage: this.deps.usage ?? null,
      // 豁免判据：宿主装配 deps 时给一次（real-loop 的 agentDeps），每步原样转手——
      // 与 contact/machine/usage 同一条纪律：渲染层不读盘，名单的真源在宿主手里。
      warnExempt: this.deps.warnExempt ?? null,
      loadImage: this.deps.loadImage ?? null,
      ...(this.deps.maxContextImages === undefined
        ? {}
        : { maxContextImages: this.deps.maxContextImages }),
    });
  }

  /**
   * **进请求的工具清单变了就落一条账**（BUG-3，2026-10-11 加）。
   *
   * 为什么必须有这一下：清单是**现取的活值**（上面那行 `listForModel`），不是从事件读的，
   * 所以"清单变了几件"这件事在日志里**天生没有对应事件**——除非它恰好是 `mcp/server-started`
   * / `skill/installed` / `config/changed{tools,mcp}` 之一。现场（本机 03:00:05，seq 78374）
   * 那 20 件工具就是这么消失在观测之外的：`tools` 段真变了（24 件 → 4 件），窗口里一条证据都没有
   * ⇒ 落 `unattributable` ⇒ 告警，而事后复盘翻遍日志也答不出"少了哪 20 件"。
   *
   * 三条边界：
   *   · **只落账、不参与装配**：它一个字都不进请求体（可见性 internal，见 `EVENT_VISIBILITY`），
   *     也**不改 `RENDER_VERSION`**（渲染口径没动）；
   *   · **只在真变了时写**（判据在 {@link toolInventoryChangeOf} 一处）：第一次构请求没有可比对象、
   *     清单空、换了一张工具表（不是同一个 registry 实例）、或那份清单表还没接上（子代理 / 诊断的
   *     隔离视图）时**一个字都不写**；
   *   · **比对的是清单本身**（名字 + 各自可见性），不是配置：配置没动而清单动了，照样记。
   */
  private noteToolInventory(
    tools: readonly ToolModelSpec[],
    options: ListForModelOptions,
    step: number,
  ): void {
    const registry = this.deps.registry;
    const previous = TurnRunner.lastToolInventory;
    // 换了 registry 实例 ⇒ 没有基线（见 lastToolInventory 的注释：那不是"清单变了"，是换了一张表）
    const baseline = previous !== null && previous.registry === registry ? previous.lines : null;
    const next = toolInventoryLines(tools, options);
    const changed = toolInventoryChangeOf(baseline, next, options);
    // 基线**每次都推进**（包括"还没接上 / 换了张表"那几种）：观测不许反过来改变任何装配行为。
    TurnRunner.lastToolInventory = { registry, lines: next };
    if (changed === null) return;
    const data: ToolsInventoryChanged['data'] = { ...changed, turn: this.turn, step };
    this.write('tools/inventory-changed', data, { sync: false });
  }

  /** 唯一写入点：分配 seq → append（承诺类 fsync）→ 立即折进投影 */
  private write(type: AppEventType, data: unknown, options: { sync: boolean; ts?: string }): AppEvent {
    const event = {
      seq: this.log.nextSeq(),
      ts: options.ts ?? this.deps.now(),
      type,
      data,
      // 可见性一律走 schema 表，不在写入点手填，避免两处口径漂移
      visibility: defaultVisibility(type),
      origin: ORIGIN,
      // 子代理链归属（§4.21 隔离三件套之三）：顶层不传 → 字段不出现，事件形状与之前完全一致
      ...(this.deps.parentCallId !== undefined ? { parentCallId: this.deps.parentCallId } : {}),
    } as unknown as AppEvent;
    this.log.append(event, { sync: options.sync });
    applyOne(this.projection, event);
    this.deps.onEvent?.(event);
    return event;
  }
}

// ──────────────────── 工具清单指纹（BUG-3 的观测面，唯一一份口径） ────────────────────

/**
 * 清单里的一行：**这件工具叫什么 + 它这一次是怎么进来的**。
 *
 * 为什么要带上"怎么进来的"：同一批工具、换一个可见性开关，进请求的清单就可能整体不同
 * （`includeDestructive: false` → 危险的那几件全不列；`allowOnly` → 只剩白名单里的几件）。
 * 只比名字的话，"开关换了"与"工具表换了"在账上是一个形状，而这两件事的处置完全不同
 * （前者是设计内的取舍、后者可能是 MCP 掉了）。带上它，"少了哪 20 件、为什么会少"一次读得出。
 */
interface ToolInventoryLine {
  name: string;
  /** `only` = 走了严格白名单；`visible` = 常规可见；`destructive-on` = 危险工具被显式打开 */
  via: 'only' | 'visible' | 'destructive-on';
}

/**
 * 进请求的清单 → 指纹行（**纯函数**：给同一份清单永远给同一串，重放与测试引同一份口径）。
 *
 * 顺序**照 `listForModel` 给的顺序**（注册顺序）——`added` / `removed` 也按它列，
 * 于是"少了哪几件"读起来与请求体里的顺序对得上。
 */
function toolInventoryLines(
  tools: readonly ToolModelSpec[],
  options: ListForModelOptions,
): ToolInventoryLine[] {
  const allowOnly = options.allowOnly;
  const destructive = options.includeDestructive;
  return tools.map((tool) => {
    let via: ToolInventoryLine['via'] = 'visible';
    if (allowOnly !== undefined) via = 'only';
    else if (destructive === true
      || (Array.isArray(destructive) && destructive.includes(tool.name))) via = 'destructive-on';
    return { name: tool.name, via };
  });
}

/**
 * 两次指纹的差（**纯函数**）。`null` = 不比（三种情形，见 {@link TurnRunner.noteToolInventory}）：
 *   · `before` 为空 —— 还没有基线（本进程第一次构请求；重启后重新开始也是对的）；
 *   · `after` 为空  —— 进请求的清单一件都没有。**空清单不是"清单被清空"的证据**：子代理与诊断
 *     走的是隔离视图，`listForModel` 在它们那里本来就可能一件都不给 ⇒ 拿它报"少了 N 件"就是伪造事实；
 *   · 两边逐行相同 —— 没变，一个字都不写（观测面的第一纪律：不许刷屏）。
 *
 * 判据是**集合差**（按名字），不是数组逐位比：清单重排不该报成"变了"——进请求的字节若因此不同，
 * 那是 `tools` 段哈希的事（哨兵照旧报），不必在这里再记一条。
 */
function toolInventoryChangeOf(
  before: readonly ToolInventoryLine[] | null,
  after: readonly ToolInventoryLine[],
  options: ListForModelOptions,
): Omit<ToolsInventoryChanged['data'], 'turn' | 'step'> | null {
  if (before === null || before.length === 0 || after.length === 0) return null;
  const beforeNames = new Set(before.map((line) => line.name));
  const afterNames = new Set(after.map((line) => line.name));
  const removed = before.filter((line) => !afterNames.has(line.name)).map((line) => line.name);
  const added = after.filter((line) => !beforeNames.has(line.name)).map((line) => line.name);
  // 名字集合没变时还要比可见性：同一件工具从"常规可见"变成"白名单进来的"也是清单换版
  const viaChanged = before.some((line) => after.find((other) => other.name === line.name)?.via !== line.via);
  if (removed.length === 0 && added.length === 0 && !viaChanged) return null;
  return {
    before: before.length, after: after.length, added, removed,
    fingerprint: TOOL_FINGERPRINT,
    // **分类在这一行定**（2026-10-11 加）：它是"这一次变化是哪一类"的结论，判据在
    // `toolInventoryKindOf` 一处——事后读日志的人手里只有这条事件，分类必须自带。
    kind: toolInventoryKindOf(before, after, removed, added, options),
    visibility: toolVisibilityOf(options),
  };
}

/**
 * 工具清单指纹的口径常量（与 `log/types.ts` 的 `fingerprint` 那格是同一句话）。
 */
const TOOL_FINGERPRINT = 'name+visibility' as const;

/**
 * MCP 工具名的命名空间前缀，**逐字与 `mcp/client.ts` 的 `MCP_NAME_PREFIX` 同值**。
 *
 * 为什么不 import 那一个：本文件是观察面的**分类**（`toolInventoryKindOf`），而 `mcp/client.ts`
 * 是一个会拉进 `child_process` / `node:fs` / 启动器守卫的**运行期大模块**——为了一个字符串
 * 常量把它整条链拖进循环层不合适。两处漂移的代价只是"分类落回 `registry`"（仍然不告警、
 * 仍然留痕），不是判据分岔；而真实的前缀只可能是一种写法（`mcp__{server}__{tool}`，
 * design §4.18 原则 2），改它等于改协议。
 */
const MCP_NAME_PREFIX = 'mcp__';

/**
 * **这一次清单变化是哪一类**（2026-10-11 加；判据只在这一处，落在事件的 `kind` 上）。
 *
 * 三分类，读账的人拿它决定"要不要去查"（口径写在 `log/types.ts` 的 `kind` 那一格）：
 *   · `'mcp'`       —— `removed` / `added` 里有 `mcp__*`：MCP 掉线或上线。**真变化**，要人去查；
 *   · `'trust-tier'`—— **信任档换档**（预期内）：同一条 `RENDER_VERSION` 下、清单只发生
 *     父子集式的增减（一边是另一边的子集），且**不是** MCP 那批。现场就是用户报的那四张卡：
 *     外部轮只许四件、用户/她自己那一轮 24 件，来回切。`render.ts` v44 那篇有意写下的取舍；
 *   · `'registry'`  —— 上面两样都不是：工具表本身被换过（注册/注销/禁用开关）。
 *
 * 为什么"父子集"是这个判据的核心（而不是件数变没变）：**换档只动哪些件进清单、不动工具表**，
 * 所以它必然表现为"一个名字集合包含在另一个里"（收窄 ⇒ 只减不增；放开 ⇒ 只增不减）。
 * 而"换了一张表"通常会**同时**增删（现场：件数一样、内容换了），落 `'registry'`。
 *
 * ⚠ 判据刻意**不读配置**：`visibility` 那两格是"当时的开关"（原始输入），拿它反推类别等于把
 * 结论建在输入的形状上——同一份开关在不同工具表下会得出不同的类别。这里只比**两份清单的
 * 名字集合**（也就是这条账本来就记着的东西），`visibility` 只用来回答"这次换的是不是白名单那一档"。
 */
function toolInventoryKindOf(
  before: readonly ToolInventoryLine[],
  after: readonly ToolInventoryLine[],
  removed: readonly string[],
  added: readonly string[],
  options: ListForModelOptions,
): NonNullable<ToolsInventoryChanged['data']['kind']> {
  // ① MCP 那批进出清单 ⇒ 掉线/上线（真变化）——先判它，免得被"父子集"这一条盖过去
  if ([...removed, ...added].some((name) => name.startsWith(MCP_NAME_PREFIX))) return 'mcp';
  const beforeNames = new Set(before.map((line) => line.name));
  const afterNames = new Set(after.map((line) => line.name));
  // ② 父子集式增减 ⇒ 换档。两种方向都算：
  //    · 收窄（外部轮那份四件 ⊂ 用户轮那份 24 件）：只减不增；
  //    · 放开（回到用户轮那份）：只增不减。
  const narrowed = added.length === 0 && removed.length > 0
    && after.every((line) => beforeNames.has(line.name));
  const widened = removed.length === 0 && added.length > 0
    && before.every((line) => afterNames.has(line.name));
  // 换档是**可见性开关**造成的 ⇒ 必然有一侧是严格白名单（`allowOnly`，`via === 'only'`）。
  // 两侧都没有白名单、却只有单方向的增/减：那更像注册表被动过（注册/注销/禁用开关）⇒ 落 `'registry'`。
  const allowListed = options.allowOnly !== undefined
    || before.some((line) => line.via === 'only') || after.some((line) => line.via === 'only');
  if (allowListed && (narrowed || widened)) return 'trust-tier';
  return 'registry';
}

/**
 * 这一刻生效的可见性开关 → 事件要的那一格（`readonly` 的那些数组在这里**拷一份**：
 * 事件是要落盘的 JSON，原样挂着调用方的只读引用等于让日志跟着别人的内存走）。
 * 缺省（没给）⇒ 字段不出现，与 `data` 里其它可选格同一条纪律。
 */
function toolVisibilityOf(options: ListForModelOptions): ToolsInventoryChanged['data']['visibility'] {
  const destructive = options.includeDestructive;
  return {
    // 三态如实落（两个分支都要，不许归一）：`boolean` 原样，名单**拷一份**——
    // 事件是要落盘的 JSON，挂着调用方的只读引用等于让日志跟着别人的内存走。
    ...(destructive === undefined ? {} : {
      includeDestructive: typeof destructive === 'boolean' ? destructive : [...destructive],
    }),
    ...(options.allowOnly === undefined ? {} : { allowOnly: [...options.allowOnly] }),
  };
}

// ──────────────────────────────── 压缩点（唯一一份口径） ────────────────────────────────

/**
 * 压缩判定的**结论**：一份纯数据，喂给两个消费方——留痕事件（`compaction/decision`）
 * 与"结论是 `wrote` 就落摘要"（{@link TurnRunner} 的 `maybeCompact`）。
 *
 * 为什么要把结论做成一等值、而不是"判据散在五处 return 里"：
 *   · **一 turn 一行留痕**要求"每一条出口都带着同一批字段"，散着写就一定会漏（加第六条
 *     判据时最容易忘的就是补账）；
 *   · 产线要能回答"这一拍为什么不压"——`reason` 直接给结论，那几格数给它证据；
 *   · 事后重放/测试可以只调这一个函数，不必跑一遍 turn。
 *
 * `historyTokens` / `thresholdTokens` 恒有；后三格只在判据真的走到那一步时才有（见
 * {@link CompactionDecision} 的字段口径）——阈值没过时"遮蔽点在哪"还不是一个成立的事实，
 * 编一个 0 填进去就是伪造一次判定。
 */
export interface CompactionDecisionView {
  turn: number;
  historyTokens: number;
  thresholdTokens: number;
  reason: CompactionDecision['data']['reason'];
  coveredUpToSeq?: number;
  /**
   * 闸门的**参照点**：已有摘要的覆盖点（`0` = 还没压过，这一次就是第一次折叠）。
   *
   * 刻意**不是** `compactionCoveredUpToSeq` 的返回值：那一个在没有摘要、且本 turn 还没结束时
   * 会退回本 turn 的 `turn/start` seq（见 `compactionCoveredUpToSeq` 的 ②）。拿它当参照点，
   * 闸门量出来的就只是"本 turn 自己的那一小段"，于是**第一次折叠会被永远拦下**
   * ——2026-10-09 把判据搬进这个函数时踩的正是这一下，`test/compaction-decision-wake.test.ts`
   * 的"第一次折叠"那两条现在正面钉着它。
   */
  previousCoveredUpToSeq?: number;
  /** ④甲 闸门量：`(参照点, 遮蔽点]` 之间的可见历史规模；`threshold`/`monotonic`/`no-shrink` 时缺席 */
  maskedTokens?: number;
}

/**
 * 已有摘要的覆盖点（`0` = 还没压过）。
 *
 * 与 {@link compactionCoveredUpToSeq} 的 ① **同一份判据**——只取摘要的 `coveredUpToSeq`，
 * 不掺"上一个 `turn/end`"、也不掺"本 turn 起始 seq"。闸门的参照点必须是"上一次交接折到哪"，
 * 而不是"上一轮跑到哪"：两者在没有摘要时相差极大（前者 0、后者是本 turn 的起始），
 * 混用会把整段累积的可见历史（正是把阈值推过线的那批料）排除在度量之外，
 * 于是闸门永远说"不够"——**第一次折叠再也压不动**。
 */
function maxSummaryCoverage(events: readonly AppEvent[]): number {
  let covered = 0;
  for (const event of events) {
    if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > covered) {
      covered = event.data.coveredUpToSeq;
    }
  }
  return covered;
}

/** 判定所需的全部输入：事件快照 + 本 turn 的 `turn/start` seq + 配置（`null` = 没配压缩） */
export interface CompactionDecisionInput {
  events: readonly AppEvent[];
  turn: number;
  /**
   * 本 turn 的 `turn/start` seq（`compactionCoveredUpToSeq` 的 ② 用它排除/纳入本 turn）。
   * 没有进行中的 turn 时传 `null`——那时 ② 取日志里最后一条 `turn/end`。
   */
  turnStartSeq: number | null;
  /** `null` 与"没有这一格"同义：压缩没配（子代理等宿主不要求压缩），判定停在第一道门 */
  cfg: HandoffOptions & { thresholdTokens: number } | null;
}

/**
 * **压缩判定**（唯一一份判据，2026-10-09 从 `maybeCompact` 里搬出来；纯函数、不写事件）。
 *
 * 五道门，顺序就是原来的顺序（判据一个字都没改，改的只是"结论怎么被看见"）：
 *   ① `threshold` —— 没配压缩，或可见历史估算没越过阈值；
 *   ② `monotonic` —— 遮蔽点回退（不许把已经不在现场的内容变回现场）；
 *   ③ `no-shrink` —— 折叠完反而更大（那种"压缩"是纯粹的负收益）；
 *   ④ `gate`      —— ④甲 收益闸门：新闭合的历史不足一个 recent tail；
 *   ⑤ `wrote`     —— 五道全过：**压**。
 *
 * 为什么门与门之间的数是**惰性算**的（每道门里现算那几个数）：每一条 `estimateMaskedTokens`
 * 都要把整份快照扫一遍，而绝大多数 turn 会在①就返回——把五道门要的数全提前算好，等于
 * 每 turn 白扫四遍全量事件。惰性算的代价是"字段要可选"（见结论类型的注释），换来的是
 * 绝大多数拍只做一次 `estimateHistoryTokens`。
 *
 * **首次折叠不受闸门管**（见 {@link CompactionDecision} 与 `RECENT_TAIL_TOKENS` 的注释）：
 * 判据是参照点（`previousCoveredUpToSeq`）为 0 时不算闸门——但那一格的数照旧算出来写进结论
 * （留痕要能回答"参照点当时是几"），只是不参与拦截。
 */
export function compactionDecision(input: CompactionDecisionInput): CompactionDecisionView {
  const { events, turn, turnStartSeq, cfg } = input;
  const historyTokens = estimateHistoryTokens(events);
  // 没配压缩时阈值这一格没有真值可言：写 0 会读成"阈值 0 却不压"，那是假话
  const thresholdTokens = cfg?.thresholdTokens ?? 0;
  const base = { turn, historyTokens, thresholdTokens };

  // ① 阈值（含"没配压缩"那一支：它连阈值都没有，归在同一个结论里）
  if (cfg === null || historyTokens <= cfg.thresholdTokens) return { ...base, reason: 'threshold' };

  // ② 遮蔽点：**本 turn 的 `turn/end`**（`includeInFlightTurn`，2026-10-06 改）。
  // 交接发生在 turn 收尾之后，所以把刚跑完的这一轮一起折进笔记是安全的——而留着它
  // 才是真正贵的那一笔：实测 2026-10-06 21:40 那次，留在现场的正是本 turn 的
  // 44,281 token 可见历史（真实 72,096 token，估算低估 1.63×），交接后第一次调用
  // 因此付了 72,096 未命中。
  const coveredUpToSeq = compactionCoveredUpToSeq(events, turnStartSeq, 0, true);
  // 参照点 = **已有摘要的覆盖点**（不是上面那个函数的返回值，理由见结论类型的字段注释）
  const previousCoveredUpToSeq = maxSummaryCoverage(events);

  // ── ④乙 物理上界与单调性（**与甲是两件事，各管各的**）──
  //
  // 这一条不判"划不划算"，只判"这次折叠本身是不是一个合法的、不退步的动作"：
  //   • 遮蔽点不得回退（回退 = 把已经不在现场的内容又变回现场，可见前缀凭空变长）；
  //   • 折叠的结果不得比折叠前更大（那种"压缩"把请求撑大，是纯粹的负收益）。
  // 两条都现场可判、失败了就**什么都不动**（不写摘要、不改上下文）——退化成
  // "这一拍不压"，下一拍照旧按阈值再来一次。真正的硬上界（整个请求放不放得下）不在这里，
  // 那是 budget-guard 与渲染层的事（见 docs/design.md 的请求装配）。
  // 只算一次写进结论：{@link TurnRunner} 的 maybeCompact 不再重算（重算 = 第二份判据）。
  if (coveredUpToSeq < previousCoveredUpToSeq) {
    return { ...base, reason: 'monotonic', coveredUpToSeq, previousCoveredUpToSeq };
  }
  const afterTokens = estimateHistoryTokens(events, coveredUpToSeq);
  if (afterTokens > historyTokens) {
    return { ...base, reason: 'no-shrink', coveredUpToSeq, previousCoveredUpToSeq };
  }

  // ── ④甲 收益闸门 ──
  //
  // 量的东西：**已有摘要的覆盖点之后、本次要折进去的那一段**（`previousCoveredUpToSeq → covered`）。
  //
  // 参照点必须取**已有摘要的覆盖点**，不能取"上一个 `turn/end`"：
  // 两者不是一回事——没有摘要时 `turn/end` 也在，可那时还没有"上一次交接"，拿它当参照
  // 会把整段累积的可见历史（正是把阈值推过线的那批料）排除在度量之外，闸门就永远说"不够"。
  // （这一条走了两次弯路才定下来，两次的实测数都留在 `_research/probe-handoff-mask.mts` 的输出里。）
  //
  // 为什么不量"整条还没折的可见历史"：那会把**还留在现场的尾部**也算进来，于是任何一次
  // 折叠都"够本"，闸门等于没装。要的是 reasonix 那句"新闭合的历史 ≥ 一个 recent tail"：
  // 刚折完立刻再折（那一段是 0）必须被拦住。
  //
  // **第一次折叠不受它管**（参照点为 0）：没有"上一次交接"就没有"新闭合的历史"；
  // 这一次折叠的收益是**整条历史**（阈值刚被它推过），拿增量卡它只会让第一次永远压不动。
  // 闸门量照旧算出来（留痕要能回答"参照点当时是几、量出来多少"），但参照点为 0 时不拦。
  const maskedTokens = estimateMaskedTokens(events, previousCoveredUpToSeq, coveredUpToSeq);
  if (previousCoveredUpToSeq > 0 && maskedTokens < RECENT_TAIL_TOKENS) {
    return { ...base, reason: 'gate', coveredUpToSeq, previousCoveredUpToSeq, maskedTokens };
  }

  return { ...base, reason: 'wrote', coveredUpToSeq, previousCoveredUpToSeq, maskedTokens };
}

/**
 * 交接的**收益闸门**（2026-10-06 加）：新闭合的历史不足一个 recent tail 就不写摘要。
 *
 * 先例与理由逐字来自 reasonix（`compact_projection.go:431-436`）：
 * 「Every checkpoint costs the whole prefix cache, so a second one waits for a tail's worth of
 * new closed history — otherwise a small window folds every few rounds and **spends more than
 * the fold frees**.」
 *
 * 为什么这条判据必须有（我们的实测）：`data/events` 里 54 次压实中**有 6 次的新闭合量是 0**
 * （seq 709 / 820 / 5389 / 5623 / 5753 / 17720 —— 刚写完一条摘要，紧接着又写一条），
 * 每一次都付了一整段前缀的 miss，换回来的可见历史却只有几个 token。中位数是 32,693，
 * 所以 20,000 这条线只拒掉明显不划算的那些（54 次里拒 22 次，其中包含全部 6 次"新闭合 = 0"）。
 *
 * 20,000 这个数怎么来的（**不引入新配置旋钮**，用户不喜欢旋钮）：它是
 * `DEFAULT_HANDOFF_BUDGET_TOKENS`（4096）的约 5 倍，也是现场阈值 100,000 的 1/5。
 * 直白说：**"这次要折进去的新东西"至少得有半本笔记那么厚，才值得把整段前缀作废一次**。
 * 取 32,000（= foldTokens 默认值 = 出厂阈值）会拒掉 24/54，对"一天干几件长活"的节奏过紧；
 * 取 5,000 只拒 16/54，又会放过 5,111 那种明显不划算的（实测 seq 819→830）。
 */
export const RECENT_TAIL_TOKENS = 20_000;

/**
 * 压缩的**遮蔽点**：三者取大。自动压缩（{@link TurnRunner.maybeCompact}）与人在消息里
 * 打的那条 `/compact` / `/handoff`（`runtime/real-loop.ts`）**共用这一份**——
 * 两处各算一遍，迟早会出现"同一份日志、两个遮蔽点"。
 *
 * ① **已有摘要的 `coveredUpToSeq`**（`0` = 还没压过）：摘要可以再压缩——更早的摘要本身也被
 *    新摘要遮蔽，所以取最大者；
 * ② **某个已结束 turn 的 `turn/end`**（理由见下，那段话是这块最值钱的东西，逐字保留）；
 * ③ `floorSeq`：调用方给的**下界**（返回值至少到它）。人工指令用它把"还没被处理的输入"
 *    挡在遮蔽之外——少了这一条，一次 `/compact` 会把队列里还没轮到的消息一起吞掉。
 *
 * **单调性（④ 甲）**：返回值是 `max(①, ②, ③)`，所以遮蔽点**只可能收紧、不可能回退**；
 * 而 ① 又把"上一份摘要已经遮到哪"永久记在日志里 ⇒ **退役的边界不会被复活**（reasonix 的
 * `economics tightens a live boundary, never revives a retired one`）。这条性质由
 * `test/handoff-mask-window.test.ts` 的单调性用例正面钉住，不靠"读代码看起来是这样"。
 *
 * @param inFlightTurnStartSeq 本 turn 的 `turn/start` seq（自动压缩在 turn 收尾时调用）。
 *   人工指令没有"正在进行的 turn"，传 `null`——那时 ② 取**日志里最后一条** `turn/end`。
 *   两者都没有（一条 `turn/end` 都没写过）时 ② 为 0，遮蔽点由 ①③ 决定。
 * @param includeInFlightTurn ② 要不要把**本 turn 自己的 `turn/end`** 也算进来。
 *
 *   自动压缩传 `true`（2026-10-06 改）：它在 `turn/end` **写完之后**才跑，所以"本 turn"
 *   已经是一个完整闭合的 turn 了，把它折进笔记是安全的；而把它留在现场正是最贵的一笔
 *   ——实测 21:40 那次交接，交接后第一次调用的 72,096 未命中里，44,281（可见历史）
 *   对应真实的 72,096 token（估算低估 1.63×），全是这一轮自己的内容。
 *
 *   人工指令（`inFlightTurnStartSeq === null`）用不到这个开关：它本来就取日志里最后一条
 *   `turn/end`，没有"进行中的 turn"要排除。
 */
export function compactionCoveredUpToSeq(
  events: readonly AppEvent[],
  inFlightTurnStartSeq: number | null,
  floorSeq = 0,
  includeInFlightTurn = false,
): number {
  // ① 已有摘要的最大 coveredUpToSeq
  let covered = 0;
  for (const event of events) {
    if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > covered) {
      covered = event.data.coveredUpToSeq;
    }
  }

  // ② 遮蔽点：**一个已经结束的 turn 的 `turn/end` seq**（没有就退回本 turn 起始 seq）。
  //
  // 为什么不能再用本 turn 的 `turn/start.seq`（2026-10-02 修）：**叫醒她的那条输入在
  // `turn/start` 之前**——`wake/channel` 先落盘，循环才开这一轮。于是"遮蔽到本 turn 起始"
  // 会把**他的那句话遮掉、把她对那句话的回答留在现场**（回答的 seq 更大）。留下的半段读起来
  // 像她在自言自语，而接下来的新消息看起来像"新的问题"——用户实测到的那句
  // "每次上下文压缩后她又把已经回复过的东西再回复一遍"就是这么来的（样本见 review.md）。
  //
  // 取 `turn/end` 之后，"他问的那句"与"她答的那段"要么一起进笔记、要么一起留在现场，
  // 永远不会被劈开。
  //
  // 2026-10-06：`includeInFlightTurn` 让自动压缩取**刚结束的那一个** turn/end（而不是再往前
  // 一个）。劈不开的性质与上面一样（仍然是 turn 边界），语义仍然是"每一个结束了的 turn
  // 要么整轮进笔记、要么整轮留在现场"——变的只是"折叠的追认点往后挪了一轮"。
  let end = 0;
  for (const event of events) {
    if (event.type !== 'turn/end') continue;
    // 排除本 turn：只有"本 turn 还没结束"时才需要排除。`includeInFlightTurn` 的那条路
    // 由调用时机保证（turn/end 已经写下去了），所以这里不排除。
    if (!includeInFlightTurn && inFlightTurnStartSeq !== null && event.seq >= inFlightTurnStartSeq) continue;
    if (event.seq > end) end = event.seq;
  }
  // 自动压缩的旧口径：一条已结束的 turn 都没有时退回本 turn 起始 seq（它必然 > 0，
  // 所以摘要一定渲染得出来）。人工指令没有这个退回——它由 floorSeq 兜底。
  if (inFlightTurnStartSeq !== null && end === 0) end = inFlightTurnStartSeq;

  return Math.max(covered, end, floorSeq);
}

/**
 * 交接笔记的渲染参数：总预算与单条满预算的缺省值**只有这一处**。
 * 人工指令与自动压缩共用（两个调用点各写一遍 `?? 默认值`，迟早漂移成两个数）。
 */
export function handoffOptionsOf(cfg: HandoffOptions): HandoffOptions {
  return {
    ...cfg,
    budgetTokens: cfg.budgetTokens ?? DEFAULT_HANDOFF_BUDGET_TOKENS,
    foldTokens: cfg.foldTokens ?? DEFAULT_HANDOFF_FOLD_TOKENS,
  };
}

/**
 * 遮蔽区间里的**事件条数**（机械替代文本要报的那个数）。
 *
 * 与 `estimateMaskedTokens` 同一个范围、同一套可见性判据，只是数条数不数 token——
 * 两处各写一遍范围判据，迟早出现"文本说 42 条、实际折了 43 条"。
 */
function countMaskedEvents(events: readonly AppEvent[], fromSeq: number, toSeq: number): number {
  let count = 0;
  for (const e of events) {
    if (e.seq <= fromSeq || e.seq > toSeq) continue;
    if (e.visibility !== 'model') continue;
    if (e.type === 'compaction/summary') continue;
    count += 1;
  }
  return count;
}

// ──────────────────────────────── 小工具 ────────────────────────────────

function toDsRequest(rendered: RenderedRequest, lane: ModelLane, signal: AbortSignal | undefined): DsRequest {
  const request: DsRequest = {
    lane,
    model: rendered.model,
    input: rendered.input,
    instructions: rendered.instructions,
    tools: rendered.tools,
    /**
     * 思考强度：**用户的口径（2026-10-06）——heavy 一律 `high`，且不提供更改**
     * （五处 light 各自写死 `low`：`channel/injection-judge.ts`、`channel/topic.ts`、
     * `persona/assets.ts`、`persona/memory-maintain.ts` ×2、`tools/vision.ts`；
     * 两档都不受任何配置影响）。
     *
     * 为什么把它**写出来**（原先这个字段是缺席的）：官方文档写着"思考模式默认打开、
     * effort 默认为 `high`"——也就是说字段缺席时**恰好**也是 high（`deepseek-flash` 是思考模式
     * 模型，日志里那几千条 `message/reasoning` 就是证据）。但那是**别人的默认值**，不是我们的
     * 承诺：服务端改一次默认、或这个字段哪天被漏掉，她的思考强度就会无声地变，而账本上看不出来。
     * 写死之后它只由这一行决定——`test/thinking-effort-invariant.test.ts` 钉着这一行发出去的
     * 实际值，同时钉着"配置面里没有能改它的旋钮"。
     */
    reasoning: { effort: lane === 'light' ? 'low' : 'high' },
  };
  if (signal !== undefined) request.signal = signal;
  return request;
}

function finishReasonOf(
  result: DsStreamResult,
  interrupted: boolean,
): 'completed' | 'max_output_tokens' | 'failed' | 'aborted' {
  if (result.incompleteReason === 'max_output_tokens') return 'max_output_tokens';
  if (result.failure !== null) return result.failure.code === 'aborted' ? 'aborted' : 'failed';
  if (interrupted) return 'aborted';
  if (result.status === 'failed') return 'failed';
  return 'completed';
}

function cloneCall(call: { callId: string; name: string; arguments: string }): ToolCallRequest {
  return { callId: call.callId, name: call.name, arguments: call.arguments };
}

/**
 * 两条尾部提示合并成一条 developer 消息（铁律 2「只追加」不变）：
 * 钩子注入在前（它是内容），软阈值提示在后（它是刹车警告，放最后一行才读得到）。
 * 两者都是「本次请求临时插播、不落库」的同一种性质，共用 softHint 通道是刻意的（design §4.19 第 4 条）。
 */
function mergeHints(budgetHint: string | null, hookHint: string | null): string | null {
  const hook = hookHint === null || hookHint === '' ? null : hookHint;
  const budget = budgetHint === null || budgetHint === '' ? null : budgetHint;
  if (hook === null) return budget;
  if (budget === null) return hook;
  return `${hook}\n\n${budget}`;
}

/** 本批唤醒的来源（`wake/<source>` 的 source 段）：Wake 钩子的 matcher 匹配的就是它 */
function wakeSources(events: readonly AppEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    if (!event.type.startsWith('wake/')) continue;
    const source = event.type.slice('wake/'.length);
    if (!out.includes(source)) out.push(source);
  }
  return out;
}

function dedupeBySeq(events: readonly AppEvent[]): AppEvent[] {
  const seen = new Set<number>();
  const out: AppEvent[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  return out;
}
