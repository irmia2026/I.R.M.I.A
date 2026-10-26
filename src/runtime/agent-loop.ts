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

import type { DsClient, DsRequest, DsStreamCallbacks, DsStreamResult } from '../model/ds-client.js';
import { isDsClientError, isReasoningEchoRejection } from '../model/ds-client.ts';
// **400 飞行记录器**（2026-10-22）：把"被拒的那一发"的现场提炼成一条 internal 事件。
// 判据（`serverRejectionOf`）与脱敏/区段口径都在那个模块里，本文件只负责"什么时候写、写哪份"。
import { rejectRecordOf, serverRejectionOf } from '../model/reject-record.ts';
import type { HistoryAppendBaseline, MachineFacts, MaintenanceWindowNote, PinnedWake, RenderChannelContext, RenderImageRef, RenderPersona, RenderedRequest, TurnBlockFacts, UsageFacts } from '../model/render.js';
import { RENDER_VERSION, assertReasoningEchoIntegrity, clipTaskTitle, historyAppendCheckOf, reasoningEchoBudgetOf, render, renderWake, stateBytesOf, wakeTitle } from '../model/render.ts';
import type { ReasoningEchoDropGroup, ReasoningEchoPolicy, ReasoningEchoRepair } from '../model/render.ts';
import { DEFAULT_STATE_BUDGET_BYTES } from '../config/config.ts';
import {
  DEFAULT_CACHE_BREAK_THRESHOLDS, detectCacheBreak,
  type AuditedCall, type CacheBreakThresholds, type ContextBreakdown,
} from '../model/context-audit.ts';
import type { ContactFacts } from '../model/self-brief.ts';
import { renderMentionNote } from '../model/self-brief.ts';
import { sidOf } from '../channel/sessions.ts';
// 待办清单的唯一载体是 STATE 的两节（见 persona/todo-state.ts）：任务卡只从那里读
import { openTodoItems } from '../persona/todo-state.ts';
import type { RelationshipNote } from '../persona/relationship.ts';
import type { EventLog } from '../log/event-log.js';
import type {
  AppEvent, AppEventType, CompactionDecision, IdleReason, MemorySelected, ModelLane, Projection,
  ToolsInventoryChanged, ToolResultStatus, TurnEndReason, WakeSource,
} from '../log/types.js';
import { defaultVisibility, type ContextImageChosen } from '../log/types.ts';
// 「这一轮为什么没开口」的判定与摘录只此一处（纯函数，读侧 CLI 共用同一份）
import { idleReasonFromText } from '../log/idle-reason.ts';
import {
  DEFAULT_HANDOFF_BUDGET_TOKENS, DEFAULT_HANDOFF_FOLD_TOKENS,
  estimateHistoryTokens, estimateMaskedTokens, mechanicalSummaryText,
  renderHandoffNote, type HandoffOptions,
} from '../persona/handoff-note.ts';
import { applyOne, wakeSourceOf } from '../state/fold.ts';
// 全量事件快照（进程级只此一份）：轮首播种的事件源，见 TurnRunner.syncEvents
import { allEventsOf } from '../state/event-snapshot.ts';
// 毒消息保护的阈值与崩溃恢复共用一处：同一条输入反复认领仍没跑完就进死信
//（recover.ts 的 settleClaimedInputs 也用它）——两处各写一个数，迟早会分岔。
import { offloadIfLarge, type BlobOffloadOptions } from '../state/blob-store.ts';
import type {
  ExecutionContext, IsolationConfig, ToolCallRequest, ToolExecutionResult, ToolPlanGate,
} from '../tools/executor.js';
import { executeToolCalls } from '../tools/executor.ts';
import { notedWarningsOf } from '../channel/injection.ts';
import type { WarnExemptJudge } from '../channel/warn-exempt.ts';
import { ASK_HUMAN_BLOCKED_BY, hasPendingPlanAsk, pendingAgentAsks } from './plan-mode.ts';
import type { ListForModelOptions, ToolDefinition, ToolModelSpec } from '../tools/registry.js';
import type { ToolRegistry } from '../tools/registry.js';
// 唯一一把 token 尺（值导入走 .ts）：`budget/consumed` 的输出构成拆分用它量，口径注释见 log/types.ts
import { estimateTokens } from '../tools/registry.ts';
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
 * **step 边界那次图片预取最多花多久**（2026-10-21 加，毫秒）。
 *
 * 为什么是 5 秒：它是"这一拍照旧发"与"下一拍能看见图"之间的全部预算。预取只有两件事
 * ——下载（`attachment-store` 的下载超时默认就是 5 s）与压缩（15 s 的进程）——所以预取
 * **自己的预算本来就不该超过一次下载**；超了就不等，这一拍照旧没有图（保留地址行 +
 * `vision_read` 兜底），留一条 `image/trace` 说明是超时。
 *
 * 判据的落点在循环层（{@link AgentLoopDeps.prewarmStepImages}）：宿主实现挂住不返回，
 * 这一拍也绝不多等。**生产口径就是这 5 秒**，不是可调项——它量的是"一次下载"这个外部事实，
 * 不是手感（用例另走 {@link AgentLoopDeps.prewarmStepTimeoutMs} 的短值，只为不必真等 5 秒）。
 */
export const STEP_PREWARM_TIMEOUT_MS = 5_000;

/**
 * 推理进度上报（`step/reasoning-progress`，2026-10-17 加）的两个节拍窗口，单位毫秒：
 * **本步前 120 秒每 5 秒一条，之后每 15 秒一条**。
 *
 * 依据（不是拍的，是量的）：近两个日志分片里 221 个"有推理的 step"——
 * p50 = 4.5 s、p90 = 16.6 s、p99 = 152.5 s、最大 225.3 s，>60 s 的只占 1.4%。
 * ⇒ 5 秒这一拍对**一半以上的步一条都不发**，洪水只可能出现在尾部；而尾部正是
 * "那一行空着"的现场（用户实测 turn 2115：153 秒里界面手上一个字都没有）。
 * 40 分钟的极端一步：平铺 5 秒是 480 条，这条曲线是 175 条 / 约 30 KB
 * （t=5,10,…,115 共 23 条；之后 t=135,150,…,2400 共 152 条——120 秒那一拍窗口刚切成 15 秒、
 * 距上一条只有 5 秒，于是被跳过，这正是"距上一条够久才发"的应有之义）。
 * 完整理由与"为什么不补尾条"见 `TurnRunner.reasoningProgressReporter`。
 */
export const REASONING_PROGRESS_FAST_MS = 5_000;
export const REASONING_PROGRESS_SLOW_MS = 15_000;
export const REASONING_PROGRESS_FAST_WINDOW_MS = 120_000;

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
  /** 情景档案的**索引**（v78：路径 / 字数 / 小节名；正文由她 safe_read 现取） */
  relationship?: RelationshipNote | null;
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
   * **这条取消是谁要的**（2026-10-16 加，可选）。
   *
   * `AbortSignal` 上只有"被取消了"这一个事实，而取消有两条来路、处置完全相反：
   *   · `'signal'`（缺省 / 关机、宿主取消）—— 输入**退回队列**，下次启动接着做（原口径）；
   *   · `'stop'`（用户在通道里按下 `/stop`）—— 输入**不退回**（`input/discarded{by:'owner'}`），
   *     他要的就是"停下来，别自己重来"。
   *
   * 判据只能由**按下去的那一处**给（`real-loop` 的 `stoppedByOwner`）：循环层从信号上
   * 反推不出这个区别。缺省 ⇒ 一律按 `'signal'`（老宿主、子代理链、测试的行为一个字节不变）。
   */
  signalCause?: () => 'stop' | 'signal';
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
   * （10 次自动 cron 丢 1 次；见 `_ops-light2\REPORT.md` ③）。
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
   * **本轮通道消息的显示名**（v76；v32 那个字段终于接上了线）：谁在哪个会话里说的。
   *
   * 为什么由宿主给：名字的真源在她的别名表与人的联系人表里（`channel/sessions.ts` 的
   * `resolveSessionName`），而渲染层是纯函数（不读盘、不查会话簿）。`real-loop` 每轮算一次
   * （`channelRenderContext()`），**心跳轮 / 非通道轮给 `undefined`**。
   *
   * ⚠ **它只作用于"本轮钉住的那条唤醒"**（见 `render.ts` 的 `RenderInput.channelRender`）：
   * 历史里那些 `wake/channel` 一律按"没有名字"渲染。这不是省事——一份上下文套全部历史会让
   * 通道轮与心跳轮交替时**整段历史逐字节不同**，前缀缓存全 miss（审计 P0）。
   *
   * 缺省 = 不传（子代理、诊断、老宿主）⇒ 渲染与本字段引入前逐字节相同（本轮那条也不带名字）。
   */
  channelRender?: RenderChannelContext | null;
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
   * **每一 step 边界的图片预取**（2026-10-21 加；`real-loop` 注入 `prewarmRecentAttachments`）。
   *
   * 为什么非要做在 step 边界：预取原先只挂在**拍**（`tickOnce`）上，而一整个 turn 会把拍占住
   * ——`tickInFlight` 让 turn 运行期间的到点整拍丢弃（`tickOnce` 里 `runTurn` 是 await 的）。
   * 于是"tick 那次预取之后、下一拍组装之前"到达的图，这一拍的请求里必然还没有字节：
   * 实测 106 个私聊图附件里 **34 个错过首拍**（本轮改动让其中 29 个当拍就进得去；剩下 5 个
   * 卡在原件 >1.5MB 上——压缩那条分支没修，但现在至少留痕了），
   * 而渲染层对"没有字节"是**静默跳过**的（降级正确，但查不出来）。
   *
   * 所以在 `runStep` 的 `await syncEvents()` 之后调它一次，**赶在这一 step 的 `deriveAt` 之前**
   * ——新到的图当拍就能进上下文。约定三条：
   *   · **限"最近 N 张"**（N = `vision.maxContextImages`），不做全量预取；
   *   · **并发 ≤2**，别把"她回一句话"的等待全花在下载上；
   *   · **失败/超时一律降级**：这一拍照旧发（地址行 + `vision_read` 兜底），只留一条
   *     `image/trace`。循环层给它 {@link STEP_PREWARM_TIMEOUT_MS} 的硬顶，绝不阻塞这一拍。
   *
   * 不配/`null` = 不预取（子代理、重放、诊断与既有测试都是这一支，行为与引入它之前逐字相同）。
   * **循环层不 import 真实实现**（与 `memorySelector` / `warnExempt` 同一条纪律：判据与 IO 在宿主）。
   */
  prewarmStepImages?: (() => Promise<void>) | null;
  /**
   * step 预取的硬顶（毫秒；缺省 {@link STEP_PREWARM_TIMEOUT_MS} = 5000）。
   *
   * 只有用例会传短值来钉"超时不阻塞这一拍"这条判据本身（不然一条用例得真等 5 秒）；
   * 生产不配这一格——5 秒是"一次下载"这个外部事实，不是手感。
   */
  prewarmStepTimeoutMs?: number;
  /**
   * **每一 step 边界的申请单拾取**（2026-10-21 加；`real-loop` 注入 `settleGrantsAtStep`）。
   *
   * 为什么非要做在 step 边界（用户的现场症状）：拾取（把 `data/grants/*.json` 变成
   * `grant/requested` + `human/asked`）原来**只挂在拍上**，而一整个 turn 会把拍占住——
   * `tickInFlight` 让 turn 运行期间的到点整拍丢弃。于是她 turn 中途递的单子要等**这一轮说完**
   * 才被拾取，界面三处（右下角卡/角标/托盘）在那段时间里全无。实测等待 57s / 1m47s / 4m57s
   * （那一轮 turn 跑了 348.9s，`runtime/slow-tick skipped=344`）。
   *
   * 约定三条：
   *   · **幂等靠事件状态**（`grant/mcp-grant.ts` 的 `settleGrants`）：宿主实现必须**先重读
   *     当前事件视图再判**——拿 tick 开头那份旧快照去判，同一个 id 会再挂一张 `human/asked`
   *     （重复卡）。`real-loop` 那一侧用 `readAllEvents(log)`（增量快照）做这件事。
   *   · **位置**：`runStep` 在 `syncEvents` 之后、`prewarmStepImages` 之前调它一次——卡是给人的，
   *     先挂出来再去取图；它写下的两条事件从**下一步**的 `syncEvents` 起进她的上下文。
   *   · **失败一律降级**：拾取读不动/写不进只是"卡晚一点出现"，绝不许打断这一轮。
   *
   * 不配/`null` = 不拾取（子代理、重放、诊断与既有测试都是这一支，行为与引入它之前逐字相同）。
   * 循环层不 import 真实实现（与 `prewarmStepImages` / `warnExempt` 同一条纪律：判据与 IO 在宿主）。
   */
  settleGrantsStep?: (() => Promise<void>) | null;
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
   * 顶层那条路（`real-loop`）现在也用它挡第二类事件：**框架指令**——整条就是一条指令的
   * `wake/manual`（`/compact`、`/handoff`、以及打错的那些），以及用户单聊里的 `/stop`。
   * 指令是给框架的，不是对她说的话——她要看见的是指令的**效果**（摘要 / 交接笔记 / 停下来），
   * 不是用户按了哪个按钮（见 `slash-commands.ts` 的 `isFrameworkCommandEvent`）。
   * `replay` 用同一条判据重建，所以重建结果与当时仍然逐字节一致。
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
  /**
   * 召回账（阶段二，2026-10-19；可选）：四态 + 命中词 + 候选数 + token。
   *
   * 缺省 = 这一轮没走召回那条路（`persona.recallEnabled` 关着，或老调用点）。
   * 形状与判据见 `log/types.ts` 的 `MemorySelected.recall`（那里是**唯一**一份定义）。
   */
  recall?: MemorySelectedRecall;
};

/**
 * `memory/selected.recall` 的载荷（从事件类型上取，**不另写一份**：两处各写一份迟早漂开，
 * 而漂开的后果是"账上写的与读的人认的"不是同一个形状）。
 */
export type MemorySelectedRecall = NonNullable<MemorySelected['data']['recall']>;

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
  /**
   * **本轮新输入的钉住位置**（v74，见 `render.ts` 的 `PinnedWake`）：每一步都传，首步与后续步
   * 用**同一个 `beforeSeq`**（这一轮 `turn/start` 的 seq）⇒ 同一条唤醒在一轮之内不挪位置。
   *
   * 与 `wakeEvent` 的分工：`wakeEvent` 只负责"首步那一次"的盖章/提及通知/任务卡标题；
   * 位置与渲染归 `pinnedWake`（它每一步都成立）。缺省 = 老调用点（子代理/诊断/单测），
   * 那时唤醒走 `wakeEvent` 的独立通道、追加在历史末尾（与 v73 逐字节相同）。
   */
  pinnedWake?: PinnedWake | null;
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
  /**
   * **同一 turn 上一步完整的那一层此刻层**（v66 引入，v69 换口径；见 `RenderInput.previousNowLayer`）：
   * 逐字段比对、逐字节不变的那些这一次不发。缺省 null ⇒ 每个字段都发。
   */
  previousNowLayer?: string | null;
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
   * **本轮那一条通道消息的显示名**（v76，必填格；见 `AgentLoopDeps.channelRender`）。
   *
   * 为什么**不是可选**：这正是 2026-10-21 那次审计检出的病——字段在生产者与消费者两头都在，
   * 中间的装配点漏了它，而对象展开让 TS 的多余属性检查失效（`tsc` 0 错）⇒ 静默死字段。
   * 设成必填，"忘记传"就变成**编译错误**，而不是一个跑几个月没人发现的降级。
   *
   * 值域：`null` = 这一轮不是通道轮（心跳/定时器/界面消息），或宿主没算出来；
   * 历史唤醒**永远**按 `null` 渲染（见 `render.ts` 的 `contextFor`）。
   */
  channelRender: RenderChannelContext | null;
  /**
   * 图片取字节的能力（宿主注入，见 AgentLoopDeps.loadImage）：给了它，带图的消息才会
   * 把 `input_image` 真的放进请求。缺省 = 只渲染文字（重放与诊断场景常常没有它）。
   */
  loadImage?: ((ref: RenderImageRef) => ContextImageChosen | null) | null;
  /** 最多几张图片进上下文（见 RenderInput.maxContextImages） */
  maxContextImages?: number;
  /**
   * **思维链回传的上限与范围**（v73，见 `RenderInput.reasoningEcho`）：缺省 = 出厂（总字符硬上限 +
   * 区外照旧全传）。
   *
   * 生产的三条路（运行期 / `replay` / 界面预览）**都不传**；`TurnRunner` 只在**400 自救**那一支
   * 传 `{maxTotalChars: null, outOfRegion: 'keep'}`（连硬上限都不设、区外也全传的"真·全量"）
   * ——所以"同一份日志重建同一份请求"这条承诺照旧成立（自救那一拍的请求会多一格读数，
   * 见 `RenderedRequest.reasoningEchoRepair`）。
   */
  reasoningEcho?: Partial<ReasoningEchoPolicy> | null;
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
    ...(input.pinnedWake === undefined || input.pinnedWake === null
      ? {}
      : { pinnedWake: input.pinnedWake }),
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
    // 本轮那条通道消息的名字（v76；**必填格**，见 RequestDerivation.channelRender）：
    // 渲染层只把它给"本轮钉住的那条唤醒"，历史一个字节都不吃（见 render.ts 的 contextFor）。
    // 这一格就是审计里那个"死字段"的接回点：生产者（real-loop）与消费者（render）之间，
    // 曾经只差这一行；现在它是编译期必填，漏了 tsc 就红。
    channelRender: input.channelRender ?? null,
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
    // 上一步的此刻层（v66）：由 `TurnRunner` 逐 step 现取（见 `previousNow`），
    // 渲染层据此逐字段比对、逐字节不变的那些不发。缺省 null ⇒ 每个字段都发
    // （重放/子代理/诊断那些旧调用点因此与引入这一版之前逐字节相同）。
    previousNowLayer: input.previousNowLayer ?? null,
    // 思维链上限（v73）：生产三条路都不传 ⇒ 出厂（全量 + 总字符硬上限）；
    // 只有 `TurnRunner` 的 400 自救会传"连硬上限都不设"，所以它是唯一会看到不同字节的调用点。
    reasoningEcho: input.reasoningEcho ?? null,
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
  /**
   * 日志快照：render 的唯一事件来源，每个 step 前与日志增量对齐。
   *
   * `readonly` 只锁**这个引用**（数组本身还要 push 增量）；轮首的内容由 {@link syncEvents}
   * 从宿主的进程级快照播种进来——见那里的注释（改前是每轮从 seq 1 重读整份日志）。
   */
  private readonly events: AppEvent[] = [];
  /** 轮首播种做过没有（每轮一个新 runner ⇒ 每轮一次；理由与代价见 {@link syncEvents}） */
  private eventsSeeded = false;
  /**
   * 播种源（`state/event-snapshot` 那份全量快照）**读到哪条 seq**。
   *
   * 为什么不直接拿 `events` 的末条当游标：`eventFilter` 会丢事件（子代理隔离、指令不进上下文），
   * 被丢在尾部的那几条就会让游标停在它们**之前** ⇒ 下一拍重读（幂等，但等于白读一遍）。
   * 游标必须取"播种源读到哪"与"快照末条 seq"里的大者。
   */
  private eventsSeededUpTo = 0;
  private turn = 0;
  private step = 0;
  private spoke = false;
  /**
   * 本 turn **最后一段非空的思维链**（只给 `idleReason.note` 取"她那句话"用，2026-10-19）。
   *
   * 为什么不是 `message/assistant.text`：对外的文本一旦非空就 `spoke = true`（见下面的 `runStep`），
   * 而这一格只在"整拍没开口"时被读——那时 text 一定是空的。沉默轮里能取到的她自己的话只剩推理，
   * 于是它成为唯一来源：**宁可把来源写清楚，也不编一句她没说过的话**。
   * 只存原文、不存摘要：怎么压成一句（单行、≤80 字）由 `log/idle-reason.ts` 一处决定。
   */
  private lastThought: string | null = null;
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
   * **上一步完整的那一层此刻层**（v66 引入；v69 换口径）：给下一步逐字段比对用
   * （`RenderInput.previousNowLayer`）。
   *
   * 为什么放在这里而不是宿主（`real-loop`）：它的生命周期是**一个 turn 的一个 step**，
   * 而 `TurnRunner` 正是"一轮一个实例"的那个东西（`runTurn` 每次新建）——跨 turn 自然重置，
   * 不需要任何人记得清空。宿主那一侧做不到这一点：`deps` 是**每轮装配一次**的，
   * 在那儿存就成了"跨轮残留"，而"上一步"跨了一轮就毫无意义（时刻、步数、任务卡全变了）。
   *
   * 取值口径（v69）：**`RenderedRequest.nowLayerFull`**——上一步"本来该说的每一行"，
   * **未经增量裁剪**。⚠ 不能取 `input` 里那一条此刻层 item（v66 的做法）：那是裁剪后的，
   * 被省掉的字段在下一步的基线里就不存在了 ⇒ 判据落到"上一步没有它 ⇒ 发它" ⇒ 同一行
   * **隔步重发**（实测第 1/3/5 步），"整轮只发一次"永远做不到。
   * 也不是"重新渲染一遍上个时刻"：这一格与真正发出去的那一份同一次调用产出，不落库、不进历史。
   */
  private previousNow = '';

  /**
   * **上一 step 的历史段基线**（v76，P4 中段改写不变量；只在本 turn 内有效）。
   *
   * 为什么放在这里而不是宿主：与 `previousNow` 逐字同一条理由——生命周期是"一个 turn 内的
   * 相邻两步"，`TurnRunner` 一轮一个实例 ⇒ 跨 turn 自然归零（跨轮的位移是压缩，设计内，
   * 且**不该**由这条判据来判）。宿主那一侧存就成了"跨轮残留"，会把每次压缩都报成改写。
   *
   * 取的是 `RenderedRequest.context.history`（那一段的唯一事实来源），判据在
   * `render.ts` 的 {@link historyAppendCheckOf}（跟着渲染层走，不在循环层另写一份）。
   * 破了**只留痕**（写 `render/history-rewrite`），**不拦请求**：图片窗口滑出、补回
   * `MISSING_TOOL_OUTPUT`、压缩移遮蔽点这些形状都在设计内，拦了就是误伤。
   */
  private previousStepHistory: {
    /** 这一步的步号；只有"下一步"（step+1）才拿它当基线 */
    step: number;
    baseline: HistoryAppendBaseline;
  } | null = null;

  /**
   * 本 turn 的**思维链处置账**（v73 引入，v75 改成"每步并进累计、轮收尾写一条"）。
   *
   * v73 那一版是一把布尔锁（`reasoningEchoTraced`）：**第一次**发生处置时写一条，之后整轮不再写。
   * 病在哪（2026-10-21 凌晨那场，逐条可查）：step 1 的修复里几乎总有 `orphanAssistants`
   * （`speak`/`report` 写的那段正文，没有配对的 reasoning）⇒ **锁在 step 1 就被用掉**，
   * 之后每步"再挤掉一个最老的组"**一条都不写**（46 条 prune 事件里没有一条带 `dropped`）
   * ⇒ 事后只能把 39 分钟 / 92% miss 归成 `cause:"unattributable"`。
   *
   * 现在这一格是**累计值**（每步并进去，见 {@link accumulateReasoningEchoTotals}），
   * 在轮收尾由 {@link flushReasoningEchoTrace} 一次性落库——**仍是"一 turn 一条"**（不刷屏），
   * 但内容不再是"第一步那一条"。
   */
  private reasoningEchoTotals: ReasoningEchoTurnTotals | null = null;

  /**
   * 本 turn 已经记过 400 现场的 `(turn, step, code)`（**去重键**，2026-10-22）。
   *
   * 为什么需要它：一次 step 里 400 可能出现两次——第一次抛出来、400 自救那一次重发又被拒
   * （见 `reasoningEchoFallback`）。两次都是"服务端拒了请求"，但**被拒的输入是同一份**渲染
   * 出来的 ⇒ 记两条只是把同一件事抄两遍。判据就是用户定下的那个键：同 `(turn, step, code)`
   * 只记一条。
   *
   * 为什么是 runner 字段而不是模块级：生命周期天然是"一轮"，与 `reasoningEchoTotals` /
   * `previousNow` 同一条纪律（`runTurn` 每轮新建 runner，跨轮自动归零——轮号也会变，
   * 键本来就不同）。放在模块级反而要求"记得清空"。
   */
  private readonly rejectRecorded = new Set<string>();

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
   * **本 runner 上一次记账那一拍的模型**（2026-10-26 加，只服务 `budget/consumed` 的两格留痕）。
   *
   * 为什么需要它：`cacheEstimated` 那一格要说的是"这一拍的命中量**我们算得出来**"——
   * 而"算得出来"的前提是**上一拍是同一个模型**（估算口径是拿同模型上一份 `context` 做前缀
   * 比较，见 `model/context-audit.ts` 的 `estimatePrefixHitOf`）。`previousAuditedCall` 里
   * 没有模型这一格（它是 `AuditedCall`，那边一个字都没改），所以单独记一个。
   * 与 `previousAuditedCall` 同一条纪律：`runTurn` 每轮新建 runner ⇒ 天然是"本 turn"的。
   */
  private previousAuditedModel: string | null = null;

  /**
   * 本轮**模型切换的留痕写过了吗**（2026-10-26 加；`runtime/model-switch` 的唯一写入点）。
   *
   * 为什么需要这一格：判据在 {@link TurnRunner.noteModelSwitch}——第一次 `accountStep` 时拿
   * **轮首快照**里这一条 lane 的上一拍模型与这一拍的比。`this.events` 是轮首快照、**不含本 turn
   * 刚写的那些**，所以同一轮里每拍都会得到同一个结论 ⇒ 没有这一格就会一拍写一条同样的切换。
   * 跨轮不靠它：下一轮的快照里已经有新模型了，本来就比不出来。
   */
  private modelSwitchNoted = false;

  /**
   * **本 turn 最近一笔成功调用的真实/估算输入账**（2026-10-21 加，纯观测）。
   *
   * 它只服务 `compaction/decision` 的两格（`inputTokens` / `estimatedInputTokens`）——
   * 用户要能直接看"估算 200k 时真实是多少"，不必事后重算（重算还缺当时那一份请求上下文）。
   * **不参与任何判据**：压缩判定读 `historyTokens`（估算器的账），拿真实值换算会悄悄挪动阈值。
   *
   * 口径与"哪些算成功"写在 `log/types.ts` 的 `inputTokens` 字段注释里；三类不写
   * （`failed` 调用 / 对端没给 usage / 本轮还没调用过），缺省即"没有读数"，不编 0。
   * 记在 runner 上：`runTurn` 每轮新建 runner ⇒ 天然是"本 turn"的，与 `previousAuditedCall`
   * 同一条纪律。
   */
  private lastSuccessfulCall: { inputTokens: number; estimatedInputTokens: number } | null = null;

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

  /**
   * 本 runner 累计看到的**重试次数**（`DsClient` 的重试是多播的，见 `subscribeRetry`）。
   *
   * 为什么记在 runner 上：`runTurn` 每轮新建一个 runner，而 `DsClient` 是进程级单例——
   * 每一轮订阅一次、这一轮结束时退订（`run()` 的 finally）。于是这一格天然是"本轮"的，
   * 与 `previousAuditedCall`（同一份本轮状态）同一条纪律。
   */
  private retryCount = 0;
  private readonly unsubscribeRetry: (() => void) | null;
  /** 重试计数走的是**订阅通道**吗（否则退回 `error.attempts - 1`，见 `failStep`） */
  private readonly retrySubscribed: boolean;

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
    /**
     * 重试计数通道（2026-10-16 接通，替掉 `accountStep` 里那条 TODO）。
     *
     * `subscribeRetry` 是**多播 + 可退订**的：不能把回调塞进 `DsClient` 的构造参数——
     * 那是进程级的，第一轮的那个闭包会被永久钉在上面（见 `retryListeners` 的注释）。
     * 订阅挂在 runner 上、在 `run()` 的 finally 里摘掉，所以"谁在听"跟着轮次走。
     */
    this.unsubscribeRetry = typeof deps.ds.subscribeRetry === 'function'
      ? deps.ds.subscribeRetry(() => { this.retryCount += 1; })
      : null;
    // 测试替身与子代理链的假客户端没有这个口（它们不是 `DsClient` 实例）：
    // 那时 `failStep` 退回 `error.attempts - 1`——老口径，行为一个字节不变。
    this.retrySubscribed = this.unsubscribeRetry !== null;
  }

  async run(): Promise<TurnEndReason> {
    try {
      return await this.runOnce();
    } finally {
      // 退订重试通道：`DsClient` 是进程级的，不退订就是"每一轮都往这张表上多挂一个闭包"
      // （长跑进程里这就是一条只增不减的内存泄漏，而且后面每一轮的重试都会被重复计数）。
      this.unsubscribeRetry?.();
    }
  }

  private async runOnce(): Promise<TurnEndReason> {
    const reason = await this.runInner();
    // 压缩点：本 turn 已结算，但可见历史仍然超过阈值——把交接笔记写成 compaction/summary，
    // 让它成为下一轮请求里的「早期历史」（闸蔽点后的事件逐字节保留）
    //
    // **计时包住整个收尾段**（BUG-4）：判定 + 交接笔记渲染 + 摘要落盘就是慢拍里"同步扫描"
    // 最可疑的那一段。只计时，不改判据、不动阈值（诊断口径：补刻度之前不要动阈值）。
    const compactStartedAt = Date.now();
    const decision = await this.maybeCompact();
    const compactMs = Date.now() - compactStartedAt;
    /**
     * **思维链处置账的落库点**（v75 的③：挪到**轮收尾**，一 turn 仍然一条）。
     *
     * 为什么是这里（而不是像 v73 那样"第一次发生时就写"）：那一道写法有一把
     * `reasoningEchoTraced` 的锁，而 step 1 的修复几乎总带着 `orphanAssistants`
     * （`speak`/`report` 写的那段正文）⇒ **那一格被 step 1 用掉**，之后每一次"挤掉最老的组"
     * 都不留痕（2026-10-21 凌晨：46 条 prune 事件里没有一条带 `dropped`，那个小时的 92% miss
     * 只能归成 `cause:"unattributable"`）。挪到轮收尾之后，这一条账是**整轮的累计**
     * （`steps` + `totals`），仍然是"一 turn 一条"——不刷屏，也不再漏。
     *
     * 放在 `compaction/decision` **之前**：读日志时"这一轮挤掉了什么"紧挨着"这一轮压没压"，
     * 而两者判的正是同一件事的两面（驱逐的压力 vs 压缩的处置）。
     */
    this.flushReasoningEchoTrace();
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
    // **这一行也带真实读数**（2026-10-21 加，纯观测）：本 turn 最近一笔成功调用的
    // `usage.inputTokens` + 同一笔请求的估算合计。两把尺子摆在同一行，才回答得了
    // 用户那句「估算 200k 时真实是多少」；**不做换算决策**——判据仍然只读 `historyTokens`。
    const lastCall = this.lastSuccessfulCall;
    this.write('compaction/decision', {
      ...decision,
      ...(lastCall === null ? {} : {
        inputTokens: lastCall.inputTokens,
        estimatedInputTokens: lastCall.estimatedInputTokens,
      }),
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

  /**
   * 这次取消算谁的（见 `AgentLoopDeps.signalCause`）。缺省 `'signal'`——
   * 子代理链、诊断与所有既有测试都不传它，行为与引入这一格之前逐字相同。
   */
  private abortCause(): 'stop' | 'signal' {
    return this.deps.signalCause?.() ?? 'signal';
  }

  private async runInner(): Promise<TurnEndReason> {    await this.syncEvents();
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
      if (this.deps.signal?.aborted === true) return this.endTurn({ kind: 'aborted', cause: this.abortCause() });

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
    // **申请单拾取（2026-10-21）**：turn 运行期间 tick 整拍被丢（`tickInFlight`），她中途递的
    // 单子原来要等这一轮说完才被拾取 ⇒ 界面那三处在那段时间里全无（实测 57s / 1m47s / 4m57s）。
    // 位置：紧贴 `syncEvents` —— 拾取写下的两条事件从**下一步**的快照起进她的上下文；
    // 放在图片预取之前：卡是给人的，先挂出来（预取最多要 5 秒）。
    await this.settleGrantsAtStep();
    // **图片预取（2026-10-21）**：紧贴在 `syncEvents` 之后、`deriveAt` 之前——这一拍新到的那张图
    // 因此有字节可注。为什么在这里而不是 tick：一整个 turn 占住拍（见 `prewarmStepImages` 的注释）。
    // 放在 `stepStartedMs` 之前是刻意的：那一段是网络/落盘，不是模型调用，不该混进
    // "这一步花了多久才失败"那个刻度（180s 那批事故全靠它认）。
    await this.prewarmStepImages();
    // **这一 step 的实测起跳点**（2026-10-16 加）：失败路径原来把 `durationMs` 写死 0
    // （`failStep` 里那一行），于是"这一步花了多久才失败"在日志上永远是 0——
    // 而 180s 那批事故全靠这个字段才认出"精确贴着 180s"是**我们自己的定时器**。
    // 计时点取在 `syncEvents` **之后**：那一段是日志 IO，不是模型调用。
    const stepStartedMs = Date.now();
    // 重试计数基线：成功路径原先恒写 0（见 accountStep 的注释）。本轮订阅把所有重试累加，
    // 这里取一次快照，这一 step 的 retryCount = 之后新增的那些。
    const retriesBeforeStep = this.retryCount;
    // **送进这一份请求的输入＝她看见了**：中途插进来的唤醒在这里销账（见 claimDeliveredInputs）
    this.claimDeliveredInputs();
    const step = this.step;
    // now 只取一次：渲染用它，step/start 的 ts 也用它 —— 重建请求时读回这个值即可复现
    const now = this.deps.now();
    const model = this.deps.ds.modelFor(this.lane);
    const wake = this.wakeEvents[0] ?? null;
    /**
     * **本轮新输入的钉住位置**（v74）：每一步都传同一个 `beforeSeq`（本轮 `turn/start` 的 seq）。
     *
     * 为什么不能只在首步传：requeued 的唤醒 seq 在**上一轮**的事件之前，首步把它追加在末尾、
     * 第 2 步按 seq 落回中段 ⇒ 同一轮内历史被改写，上一轮尾巴的 speak 段落被拖到"最后一条 user"
     * 之后（400 的已知形状）。钉住之后它在首步=历史末尾、之后每一步=同一个位置（前缀延长）。
     */
    const pinnedWake: PinnedWake | null = wake === null
      ? null
      : { event: wake, beforeSeq: this.turnStartSeq };
    const wakeEvent = firstStep ? wake : null;
    const softHint = mergeHints(this.deps.budget?.softHint?.(this.projection) ?? null, this.drainHookContext());

    // `let` 而不是 `const`：400 自救会重建一份（全量）请求，后面记账要用**真发出去的那一份**
    let request = this.deriveAt({ wakeEvent, pinnedWake, step, now, model, softHint });
    // 记下**上一步完整的那一层**（v69；v66 起是"真正发出去的那一层"）：下一步据此逐字段
    // 比对、不变的不发。取的是渲染结果里的 `nowLayerFull`（**未经增量裁剪**的原文）——
    // 取裁剪后的那一份，被省掉的字段下一步就会当成"上一步没有它"重发一遍（隔步重发）。
    this.previousNow = request.nowLayerFull;    this.write('step/start', {
      turn: this.turn,
      step,
      model,
      lane: this.lane,
      renderVersion: RENDER_VERSION,
      personaHash: this.deps.persona.personaHash,
      // **本步用的通道显示名**（2026-10-22）：与 `renderVersion` / `personaHash` 同一类指纹——
      // "这一份请求当时装配时，宿主给她配的名字是什么"。值取的就是刚递给 `deriveAt` 的**同一份**
      // （`this.deps.channelRender`，见 `deriveAt` 里那一格），所以重放读它 = 当时那份字节，
      // 不必拿现在的别名表反推（v76 留下的"重建出来的唤醒缺 `session=`/`sid=`"就是反推补不齐的后果）。
      //
      // `null` = 本轮不是通道轮（心跳/定时器/界面消息/子代理）：与"不传"逐字节相同。
      // 老日志没有这一格 ⇒ 读侧按"未记录"处理，走盘上重算的回退（见 `replay` 的
      // `channelRenderForReplay`）。它只作用于**本轮钉住的那条**唤醒，历史段一个字节都不吃它。
      channelRender: this.deps.channelRender ?? null,
    }, { sync: true, ts: now });
    // 思维链自洽的（累计）留痕（v73 引入、v75 改口径）：这一拍**整组丢了谁**（撞硬上限）、
    // 或者**补回了谁**（半截输入）。**每步都并进累计**、轮收尾才落一条
    // （判据与形状见 `model/reasoning-echo` 与 `flushReasoningEchoTrace`）。
    this.traceReasoningEchoRepair(step, request);

    let result: DsStreamResult;
    try {
      // 第二参数是**上游 delta 的口**（`DsStreamCallbacks`，见 ds-client.ts:231-242 与 :917）：
      // 它是"已经生成了多少字"唯一的实时来源——在此之前一个 delta 都不落事件，界面那行
      // 「已想 X 字」在整段落库之前只能是「…」（实测 turn 2115 空了 153 秒）。
      // 接上它只读计数、不碰正文：载荷里没有也不许有正文的任何片段（见 StepReasoningProgress）。
      result = await this.deps.ds.stream(
        toDsRequest(request, this.lane, this.deps.signal),
        this.reasoningProgressReporter(step),
      );
    } catch (error) {
      // **400 飞行记录器**（2026-10-22）：服务端拒了这份请求 ⇒ 先把现场拍下来（internal 事件，
      // 不改行为、不进请求体），再走下面那条既有的 400 自救。位置在**自救之前**是刻意的：
      // 被拒的是**这一份** `request`（`input`/`context` 都在手上），而自救会重建另一份请求——
      // 记录器要记的是"真被服务端拒掉的那一发"，不是"我们后来改成的那一发"。
      this.recordReject(step, error, request);
      // **400 自救（v73 的 D 条，最后一道保险）**：服务端说"reasoning_text 没回传" ⇒ 用
      // **全量、连硬上限都不设**重建这一份请求**再发一次**（只一次）。它不是主修——
      // 主修是"全量回传 + 整组丢 + 装配末端自洽 + 发送前断言"（见 `render.ts` 文件头 v73）。
      const rescued = await this.reasoningEchoFallback({
        error, step, wakeEvent, pinnedWake, now, model, softHint,
        request, retriesBefore: retriesBeforeStep,
      });
      if (rescued === null) {
        return this.failStep(step, error, { firstStep, startedMs: stepStartedMs, retriesBefore: retriesBeforeStep });
      }
      result = rescued.result;
      request = rescued.request;
    }

    // **失败判据的唯一来源**（客户端合同，见 `DsStreamResult.failure` 的注释）：
    // `failure !== null` ⇔ 这次调用没有正常收尾 —— 上游终态 `response.failed` 与"没收到终态"
    // （断流 / 超时 / 调用方中断）两类都落在这一格里。
    // **不要在这里再组合 `status` / `interrupted` 判第二遍**：那正是 2026-10-17 修掉的 P0
    // 的形状——客户端用 status/failure 表达终态失败，循环层只认 interrupted，于是终态 failed
    // 走了"成功收尾"（半截调用被拿去执行、turn 记 completed、输入不退回）。
    const failure = result.failure;
    const failed = failure !== null;
    const text = result.text.length > 0 ? result.text : null;
    // 没跑完的调用一律丢弃（schema §3 / M2-9）：被截断的 arguments 拿去执行就是
    //「拿着半个参数做有副作用的事」——上游终态 failed 与断流同一条纪律。
    const calls: ToolCallRequest[] = failed ? [] : result.toolCalls.map(cloneCall);

    const assistant: Record<string, unknown> = {
      text,
      toolCalls: calls.map(call => ({ callId: call.callId, name: call.name, arguments: call.arguments })),
    };
    // 落库那格沿用既有的 `interrupted` 语义（"已推送的部分，别当完整回答读"）：
    // 终态 failed 同样没说完，标记一致；不新增事件字段 ⇒ 不动 RENDER_VERSION。
    if (failed) assistant['interrupted'] = true;
    this.write('message/assistant', assistant, { sync: true });
    if (text !== null && text.trim() !== '') this.spoke = true;

    if (result.reasoning.length > 0) {
      // 思维链只供复盘（渲染层剥离，缓存铁律 3），丢了不影响正确性：按观测类写入
      this.write('message/reasoning', { turn: this.turn, step, text: result.reasoning }, { sync: false });
      // 沉默轮里"她那句话"的唯一来源（见 lastThought / idleReasonFor）：只记原文，不在这里压
      this.lastThought = result.reasoning;
    }
    this.accountStep(step, result, failed, model, request, this.retryCount - retriesBeforeStep);

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

    if (failed) {
      // 外部取消不是错误（aborted 结局）。其余——含上游终态 `response.failed`——都走既有的
      // error 收尾：`endTurn` 退输入队列（下一轮完整重试）、`budget/consumed.finishReason='failed'`
      // 让 `failStreak` 涨（到阈值告警/暂停唤醒），与 `failStep` 同一个失败处置。
      if (failure.code === 'aborted') return { kind: 'aborted', cause: this.abortCause() };
      /**
       * **非首步的"部分收尾"**（2026-10-18，review 同域那两条之一）：`result.interrupted` = 没等到
       * 上游终态（断流 / 静默超时 / 硬顶），已收的正文、思维链、usage 都已经落库/入账。
       *
       *   · **首步**：这一轮还什么都没做 ⇒ 照旧 `error`、输入退回队列（下一轮是一次完整重试，
       *     0d7b7c8 的设计不变）；
       *   · **非首步**：本轮的工具结果与她说过的话都已经进了上下文，整轮重投只会把同一段活
       *     干第二遍（0d7b7c8 已经在"抛错"那条路上这么判了，这里补的是**有部分输出**那条形状：
       *     它不抛错，于是过去从 `error` 缺省值那里拿到"退回队列"，把整轮白费掉）。
       *
       * 结局记 `incomplete`：不是"说完了"（`completed`），也不是"这一轮作废"（`error`+退回），
       * 且 `endTurn` 只对 `error` 退回输入 ⇒ 这里天然不重投。已收到的部分就是她的输出。
       */
      if (result.interrupted && !firstStep) {
        return { kind: 'incomplete', reason: 'partial', code: failure.code };
      }
      return {
        kind: 'error',
        message: failure.message === '' ? '模型这次没有正常收尾（未收到正常终态）' : failure.message,
        code: failure.code,
      };
    }
    // 输出被截断与"说完了"是两件事（schema §2）：截断优先作为结局，即使本步还带着工具调用
    if (result.incompleteReason === 'max_output_tokens') {
      return { kind: 'max-tokens', outputTokens: result.usage.outputTokens };
    }
    /**
     * 输出被**内容策略**截断（`response.incomplete{reason:'content_filter'}`，2026-10-18，
     * review 同域那两条之二）：与 `max_output_tokens` 同族（上游自己说"没说完"），
     * 但在这一条之前它**落到 `completed`**——`calls.length === 0` 那条分支把"没有工具调用"
     * 当成"说完了"，于是账本与 `turn/end` 都说成功，而那段话其实是被截断的半段。
     * 它不是我们的失败（不进失败刹车，理由与 max-tokens 同），也不许冒充"说完了"。
     */
    if (result.incompleteReason === 'content_filter') {
      return { kind: 'incomplete', reason: 'content_filter' };
    }
    return calls.length === 0 ? { kind: 'completed' } : null;
  }

  /**
   * 思维链自洽的**累计**（v75 的③；`model/reasoning-echo` 的 `kind:'reasoning_echo_prune'`）。
   *
   * 什么时候并进来：这一拍的渲染**丢过整组**（撞硬上限 / 半截状态补不回）、**补回过**思维链、
   * 删过孤儿 reasoning item、或整条没发孤儿正文。四者都是"请求里少了/多了什么"，
   * 事后只有这条账能回答。
   *
   * **每步都并、轮收尾才写**（见 {@link reasoningEchoTotals} 与 {@link flushReasoningEchoTrace}）：
   * v73 那句"一 turn 一条"的理由（丢的是同一批最老的组，每步都写就是刷屏）仍然成立，
   * 所以写库次数没变；变的是**内容**——累计之后，第 2、3 步挤掉的组不会再被那把锁吞掉。
   *
   * `sync: false` 由落库那一侧给（观测类账，与 `budget/consumed` / `tools/inventory-changed` 同档）。
   */
  private traceReasoningEchoRepair(step: number, request: RenderedRequest): void {
    this.reasoningEchoTotals = accumulateReasoningEchoTotals(
      this.reasoningEchoTotals, step, request.reasoningEchoRepair,
    );
  }

  /**
   * **把本轮的思维链处置账写进日志**（v75 的③：唯一写入点，在本轮收尾 `runOnce()` 里）。
   *
   * 形状见 `log/types.ts` 的 `ModelReasoningEcho`：`dropped`/`restored`/`orphanAssistants`
   * 是各步的**并集**，`steps` 是并进来的步数，`totals` 是那几格的累计数。
   * 本轮什么处置都没发生 ⇒ **一条都不写**（不写空壳：`dropped: []` 会被读成"驱逐过"）。
   */
  private flushReasoningEchoTrace(): void {
    const totals = this.reasoningEchoTotals;
    if (totals === null) return;
    this.reasoningEchoTotals = null;
    this.write('model/reasoning-echo', {
      turn: this.turn,
      // 步号取**最后一次发生处置**的那一步（`firstStep` 在 totals 里读得到，这里不另开一格）
      step: totals.lastStep,
      kind: 'reasoning_echo_prune',
      steps: totals.steps,
      ...(totals.dropped.length === 0 ? {} : { dropped: totals.dropped }),
      ...(totals.restored.length === 0 ? {} : { restored: totals.restored }),
      ...(totals.orphanItems === 0 ? {} : { orphanItems: totals.orphanItems }),
      ...(totals.orphanAssistants.length === 0 ? {} : { orphanAssistants: totals.orphanAssistants }),
      // v75：本轮顶破硬上限多少（0 不写——不编一个"没超"的读数）
      ...(totals.overChars === 0 ? {} : { overChars: totals.overChars }),
      totals: {
        steps: totals.steps,
        droppedGroups: totals.dropped.length,
        droppedItems: totals.droppedItems,
        droppedChars: totals.droppedChars,
        restored: totals.restored.length,
        orphanItems: totals.orphanItems,
        orphanAssistants: totals.orphanAssistants.length,
        orphanAssistantChars: totals.orphanAssistantChars,
      },
    }, { sync: false });
  }

  /**
   * **400 飞行记录器**（2026-10-22）：把"被服务端拒掉的那一发"拍成一条 `model/reject-record`。
   *
   * 为什么要有它：在此之前**每次出 400 都只能靠 replay 反推**——重建得出一份请求，但答不出
   * "被拒的是哪一发、它有多大、`最后一条 user` 之后那一段是什么顺序"。而 400 的处置
   * （改渲染 / 换图片 / 改配置）恰恰全看这三样。记录器在拒绝发生的那一刻把它们留成事实。
   *
   * 三件事都在这里定（各有唯一一处实现，别处不重算）：
   *   · **判据**：`serverRejectionOf`——只认 400（`http_400` / status 400），5xx、429、超时都不记（那
   *     不是"这份请求被拒"，重发可能就好了）；
   *   · **去重**：同 `(turn, step, code)` 只记一条（键与理由见 {@link rejectRecorded}）；
   *   · **形状**：`rejectRecordOf`（`model/reject-record.ts`）——`shape` 从渲染层的 `context` 取，
   *     `region` 从**已经造好的 input** 取，`requestId` 从服务端原话里摘，预览一律脱敏。
   *
   * **只写事件、不改行为**：不重试、不拦请求、不碰 `turn/end`。`sync: false` 与
   * `budget/consumed` / `model/reasoning-echo` 同档（观测账：丢了一条下次拒绝还会再记）。
   * 可见性 internal（表里写明）⇒ 一个字节都不进请求体、**不动 `RENDER_VERSION`**。
   */
  private recordReject(step: number, error: unknown, request: RenderedRequest): void {
    const rejection = serverRejectionOf(error);
    if (rejection === null) return;
    const key = `${this.turn}:${step}:${rejection.code}`;
    if (this.rejectRecorded.has(key)) return;
    this.rejectRecorded.add(key);
    this.write('model/reject-record', rejectRecordOf({
      turn: this.turn,
      step,
      code: rejection.code,
      detail: rejection.detail,
      input: request.input,
      context: request.context,
      // 本步之前的事件快照：只用来给工具 item 对 `seq`（`call_id` 是精确的）
      events: this.events,
    }), { sync: false });
  }

  /**
   * **400 自救**（v73 的 D 条：最后一道保险，不是主修）。
   *
   * 判据**只有一处**：`ds-client.ts` 的 `isReasoningEchoRejection(detail)`——它认的是**服务端原话**
   * （"`reasoning_text` … passed back"），别的 400（图片、上下文超限、参数）一个都不走这条路。
   *
   * 动作：用 {@link FULL_REASONING_ECHO}（**连硬上限都不设**）重建这一份请求**再发一次**，
   * 只一次——"重试同样的请求必然同样失败"，所以第二次必须真的不一样（全量回传）。
   * 成功后这一拍照常往下走；失败仍按原样报错（返回 `null` ⇒ 调用方用**第一次**的错误收场）。
   *
   * 留痕：`model/reasoning-echo`（`kind:'reasoning_echo_fallback'`）——放开的条数/字符数、
   * 第二次请求实际回传了多少、以及两次服务端原话。**这条账就是用户要的那行 `reasoning_echo_fallback`**。
   */
  private async reasoningEchoFallback(args: {
    error: unknown;
    step: number;
    wakeEvent: AppEvent | null;
    /** v74：本轮新输入的钉住位置（自救重建必须与第一次**同一位置**，否则自救本身又是一次改写） */
    pinnedWake?: PinnedWake | null;
    now: string;
    model: string;
    softHint: string | null;
    request: RenderedRequest;
    retriesBefore: number;
  }): Promise<{ result: DsStreamResult; request: RenderedRequest } | null> {
    const failure = args.error;
    const known = isDsClientError(failure) ? failure : null;
    const detail = known?.detail ?? null;
    if (!isReasoningEchoRejection(detail)) return null;
    const code = known?.code ?? 'UNKNOWN_MODEL_ERROR';
    // **全量重建**：连 300,000 的总字符硬上限也不设——服务端要的是"完整回传"，
    // 这一支宁可把请求撑大，也不再冒"条目在、思维链缺"的险（它本来就是最后一道保险）。
    const full = this.deriveAt({
      wakeEvent: args.wakeEvent,
      pinnedWake: args.pinnedWake ?? null,
      step: args.step,
      now: args.now,
      model: args.model,
      softHint: args.softHint,
      reasoningEcho: FULL_REASONING_ECHO,
    });
    const before = args.request.reasoningEchoRepair.kept;
    const after = full.reasoningEchoRepair.kept;
    let result: DsStreamResult | null = null;
    let second: { code: string; detail: string } | null = null;
    try {
      result = await this.deps.ds.stream(
        toDsRequest(full, this.lane, this.deps.signal),
        this.reasoningProgressReporter(args.step),
      );
    } catch (error) {
      const knownSecond = isDsClientError(error) ? error : null;
      second = {
        code: knownSecond?.code ?? 'UNKNOWN_MODEL_ERROR',
        detail: clipEchoDetail(knownSecond?.detail ?? (error instanceof Error ? error.message : String(error))),
      };
    }
    this.write('model/reasoning-echo', {
      turn: this.turn,
      step: args.step,
      kind: 'reasoning_echo_fallback',
      // 放开的量 = 全量那一份 − 刚才被拒的那一份（条数与正文字符），这就是"降级到全量回传"的读数
      released: {
        items: Math.max(0, after.items - before.items),
        chars: Math.max(0, after.chars - before.chars),
      },
      echoed: { items: after.items, chars: after.chars },
      original: { code, detail: clipEchoDetail(detail) },
      ...(second === null ? {} : { failed: second }),
    }, { sync: false });
    if (second !== null || result === null) return null;
    return { result, request: full };
  }

  /**
   * 本步的**推理进度读数**（后端 (b) 实时字数）：给 `ds.stream()` 挂一个只管计数的口。
   *
   * 它做什么：在 `onReasoningDelta` 里累加 `delta.length`——**只取长度，delta 原文当场丢掉**，
   * 写出去的那条事件里不许有正文的任何片段（见 `StepReasoningProgress` 的纪律 ①）。
   *
   * 节拍（`chars` 变了、且距上一条够久才发一条；流停住 ⇒ 一条都不发）：
   *   · 本步前 {@link REASONING_PROGRESS_FAST_WINDOW_MS} 之内：≥{@link REASONING_PROGRESS_FAST_MS}；
   *   · 之后：≥{@link REASONING_PROGRESS_SLOW_MS}。依据见那两个常量的注释。
   *
   * **每步归零是天然的**：计数器是本方法的局部量，`runStep` 每个 step 新建一次。
   * **不补尾条**：流一结束，同一次 `runStep` 里紧随其后的 `message/reasoning` 就是真值，
   * 补一条只多字节、还制造"live 后到把 counted 顶掉"的次序风险。
   *
   * **已知偏差（有意留的）**：`DsClient` 内部重试同一次 `stream()` 时本计数器**跨尝试累加**，
   * 而落库的 `result.reasoning` 是**最后一次尝试**的正文 ⇒ 极端下（第一次尝试吐了字之后被掐、
   * 重试成功）这条读数会大于最终落库的 `chars`。由那条真值覆盖修正。不按 attempt 归零的理由
   * （重试通道是进程级多播、不带 lane，别的 lane 的重试会把我们的数误归零）见
   * `StepReasoningProgress` 的"已知偏差"那一节。
   */
  private reasoningProgressReporter(step: number): DsStreamCallbacks {
    const startedMs = Date.parse(this.deps.now());
    let chars = 0;
    let lastReported = -1;
    let lastAtMs = startedMs;
    return {
      onReasoningDelta: (delta: string): void => {
        if (delta.length === 0) return;
        chars += delta.length;
        if (chars === lastReported) return;
        const nowMs = Date.parse(this.deps.now());
        const windowMs = nowMs - startedMs < REASONING_PROGRESS_FAST_WINDOW_MS
          ? REASONING_PROGRESS_FAST_MS
          : REASONING_PROGRESS_SLOW_MS;
        if (nowMs - lastAtMs < windowMs) return;
        lastReported = chars;
        lastAtMs = nowMs;
        // 观测类（`sync: false`），与 message/reasoning 同档：它不承诺外部世界的任何变化。
        // 不必等落盘就能到界面——SSE 尾部泵走 `EventLog.get`，那个函数先查内存缓冲。
        this.write('step/reasoning-progress', { turn: this.turn, step, chars }, { sync: false });
      },
    };
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
   * 本 turn 是否留下了未被答复的**计划审批**挂起。
   *
   * 口径与 plan-mode 的 `scanSuspension` **共用同一份实现**（`hasPendingPlanAsk`：FIFO 配对、
   * `askSeq` 精确配对优先），但只看**本 turn 起点之后**的事件：上个 turn 的挂起是历史，
   * 不该让本 turn 替它买单。配对不按 question 文本——同一批里可能有多件计划各自提问，
   * 而提问文本是同一个界面常量。
   *
   * **她自己的提问不算挂起**（design §6.5：旧实现错在"等"，不在"问"）：`ask_human` 写下的
   * `human/asked{source:'agent'}` 与计划拦截那条是两种来源，前者写完这一轮照常往下走。
   * 少了这层过滤，"她说了一句需要人回答的话"就会把 turn 停在这里——那正是被否掉的旧形态。
   *
   * **申请单那张卡也不算挂起**（2026-10-21）：拾取已经挪到 **step 边界**（`settleGrantsStep`），
   * 她 turn 中途递的单子会在下一步开始前变成 `human/asked{source:'system'}`。那张卡是"用户
   * 有空时看一眼"的待批，不是"她停下来等人"——算进来就会让**任何**中途递单把正在跑的一轮
   * 从下一步起 `blocked` 收尾（她要等一张与手上的活无关的卡）。收窄的判据在
   * `hasPendingPlanAsk`：只认计划审批那一条；投影里的 `waitingHuman` 不受影响
   * （下一轮照旧被"她在等人"那道门拦下，design §4.21）。
   */
  private async humanSuspension(): Promise<boolean> {
    await this.syncEvents();
    return hasPendingPlanAsk(this.events, { afterSeq: this.turnStartSeq });
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
   * 模型调用**返回后**的预算归账（缓存命中拆分对齐 §4.13 观测闭环）。
   *
   * 抛错那条路走 `failStep`（连 usage 都没回来 ⇒ 记 0）；本方法盖的是"调用有返回"的两种：
   * 正常收尾，以及**没跑完**（`failed`：上游终态 failed / 断流 / 超时）。后者有 usage 就照记
   * ——记账口径是"服务端说了多少记多少"，不是"失败了就记 0"（同 `channel/injection-judge.ts`
   * 的 `account`：失败也记，`usage` 缺失才记 0）。`finishReason` 由 {@link finishReasonOf}
   * 从同一个 `failed` 得出，`fold` 据此涨/清零 `failStreak`。
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
    failed: boolean,
    fallbackModel: string,
    request: RenderedRequest,
    retryCount: number,
  ): void {
    const usage = result.usage;
    const inputTokens = usage.inputTokens;
    const cacheHit = Math.max(0, Math.min(usage.cachedTokens, inputTokens));
    const ts = this.deps.now();
    /**
     * 这一拍**实际用的模型**（2026-10-26：从下面 `data` 的字面量里提出来）。
     *
     * 提出来是为了两件事都读**同一个值**：`budget/consumed.model` 与模型切换的留痕
     * （{@link TurnRunner.noteModelSwitch}）——两处各取一次就会出现"账上写 A、切换账写 B"。
     */
    const model = result.model ?? fallbackModel;
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
    // **这一拍属于哪一档价**（纯观测，2026-10-16 加）：判据是**事件时间戳的北京时间**。
    // 取上面那次 `deps.now()` 的同一个值（`ts`）——与 `write` 内部再取一次的那个 `ts` 同源
    // （生产上两者可能差几毫秒，跨档边界那一毫秒不改变结论）；刻意**不**把这个值塞给 `write`，
    // 那会改掉既有 `ts` 的取法。判不出来（`ts` 不是 ISO）⇒ 这一格**不写**，不猜。
    const tier = priceTierOf(ts);
    const data: Record<string, unknown> = {
      turn: this.turn,
      step,
      lane: this.lane,
      model,
      inputTokens,
      outputTokens: usage.outputTokens,
      cacheHitTokens: cacheHit,
      cacheMissTokens: Math.max(0, inputTokens - cacheHit),
      /**
       * **cache 数的两格留痕**（2026-10-26，用户：「如果是不返回缓存命中的模型就我们自己算」）。
       *
       *   · `cacheReported` —— **供方报了命中**（`cacheHit > 0`）。为什么不是"有没有 usage"：
       *     写入侧 `cacheMissTokens = inputTokens − cacheHitTokens` 是**我们自己减的**，
       *     "供方没给缓存字段"与"供方给了、命中 0"在事件上长得一模一样；只有 >0 才证明
       *     供方确实报了命中（判据与理由写在 `log/types.ts` 那一格的注释里）。
       *   · `cacheEstimated` —— 这一拍的命中量**我们算得出来**：供方没报、有真实输入、
       *     且本 runner 上一拍**是同一个模型**（估算口径就是拿同模型上一份 `context` 做前缀
       *     比较，见 `model/context-audit.ts` 的 `estimatePrefixHitOf`）。
       *
       * ⚠ **估算值没有落进事件**，也**不覆盖**上面那两格：读的一侧（`runtime/cache-alert.ts`）
       * 用同一个函数、同两份 `context` 快照算出来的是同一个数（`context` 就在这条事件上）。
       * 两格都是"只增不改"的可选字段：既有事件与引入它们之前逐字节相同。
       */
      cacheReported: cacheHit > 0,
      cacheEstimated: cacheHit === 0 && inputTokens > 0 && this.previousAuditedModel === model,
      // 思维链 token（观测字段，已含在 outputTokens 里，不参与预算算式）。
      // **每次都写**：这一档没产思维链就是 0——见 log/types.ts 的字段注释。
      reasoningTokens: usage.reasoningTokens,
      // 这一拍实际用的协议（协议回退 C-3）：**有就带、没有就不写**（缺省 = 不知道，
      // 不许默认成 'responses'——那会把「没写」读成「用过 Responses」）。
      ...(result.protocol === undefined ? {} : { protocol: result.protocol }),
      // **对端这一拍没给 usage**（四格是补出来的 0，不是真值）：只在真缺时写 `true`。
      // 它是"预算少算"的唯一判据（断流/超时掐掉的那一拍、以及不给 usage 的兼容层）；
      // 给了 usage 的事件与引入这一格之前逐字节相同（只增不改）。
      ...(result.usageMissing === true ? { usageMissing: true as const } : {}),
      // 输出构成拆分（纯观测，两格同一把尺 `estimateTokens`，**每次都写**；口径、三者关系与
      // 实测残差逐字见 log/types.ts 的字段注释）。
      // 量的是**模型这一拍吐出来的**：正文全文 + 每个 `function_call` 的 arguments 之和——
      // 含中断时已收的那半截（它照样计费），所以中断拍这两格与"执行了的调用"对不上是**口径差异**。
      outputTextTokens: estimateTokens(result.text),
      outputToolArgTokens: result.toolCalls.reduce((sum, call) => sum + estimateTokens(call.arguments), 0),
      // 计价档：'peak' 高峰 / 'off' 空闲半价。**没有节假日日历 ⇒ 法定节假日会被误判成 peak**
      // （只按"周一至周五 + 时段"判，见 log/types.ts 的字段注释）。
      ...(tier === null ? {} : { tier }),
      durationMs: result.durationMs,
      /**
       * 这一 step 里发生了几次重试（2026-10-16 接通，原来恒为 0）。
       *
       * 怎么来的：`DsClient` 的重试是多播的（`subscribeRetry`），`TurnRunner` 在构造时订阅、
       * 每 step 取一次差额。**成功路径也要能看见重试**——原来只有抛错那条路带得到
       * `error.attempts`，于是"这一拍重试了 3 次但还是成了"在账本上完全没有痕迹，
       * 而它恰恰是"服务端在抖"最早的信号。
       */
      retryCount: Math.max(0, retryCount),
      finishReason: finishReasonOf(result, failed),
      tokensTodayAccum: this.projection.budget.tokensToday + inputTokens + usage.outputTokens,
      // 归因事实 + 那一格纯观测的 `trust`（宿主给了才有，见上面那段注释）
      context: contextOut,
      // 构造点的**镜像**：读日志的人一眼能看到"这一拍是什么时候装出来的"（ts 是结束时刻）
      ...(request.context.builtAtSeq === undefined ? {} : { contextBuiltAtSeq: request.context.builtAtSeq }),
      // 只在真破坏时出现：没有它就代表"这次与上次的冻结前缀一致"（不是"没查"）
      ...(cacheBreak === null ? {} : { cacheBreak }),
    };
    this.write('budget/consumed', data, { sync: false });
    // 模型切换留痕（2026-10-26，用户：「缓存命中只看窗口内模型。切换模型就重新放。」）：
    // 紧挨着账写，让"这一笔是新模型的开始"和"哪一刻换的"在同一处。
    this.noteModelSwitch(model, ts);
    // 存下这一拍，供**下一步**当基准（唯一写入点，紧挨着上面那条账：两者必须同进同出，
    // 分开放就会漂成"记了一拍、基准是另一拍"——那正是这次修的错）。
    this.previousAuditedCall = audit;
    // 上一拍的模型（`cacheEstimated` 那一格的判据之一：估算只对"同模型上一拍"成立）
    this.previousAuditedModel = model;
    /**
     * **本 turn 最近一笔成功调用的真实输入账**（2026-10-21，只服务 `compaction/decision` 的两格）。
     *
     * 三类不写（缺省 = "没有读数"，绝不编一个 0 冒充）：
     *   · `failed`（上游终态失败 / 断流 / 超时——没正常收尾的那一笔不算"成功调用"）；
     *   · `usageMissing`（对端没给 usage，四格是补出来的 0）；
     *   · 本轮还没调用过（字段保持 null）。
     *
     * `estimatedInputTokens` 是**同一笔请求**的估算合计：`instructions` 与 `tools` 是顶层字段，
     * `context.input.tokens` 是 items 的合计（见 `render.ts` 那一格的注释"合计只数 item 段"）——
     * 三个数相加才是与 `usage.inputTokens` 可比的那一份估算。
     */
    if (!failed && result.usageMissing !== true) {
      this.lastSuccessfulCall = {
        inputTokens,
        estimatedInputTokens: request.context.instructions.tokens
          + request.context.tools.tokens
          + request.context.input.tokens,
      };
    }
  }

  /**
   * 模型调用抛错：分类 → 结局。失败也必须记账，否则 §4.6 的失败刹车永远看不到连续失败。
   *
   * ───────────── 超时型失败的两种结局（2026-10-16 加）─────────────
   *
   * 用户报的那个循环是这么转起来的：180s 总时限掐断一条**正在活跃输出**的流
   * （实测已累积 10 万字符推理）→ `timeout` 在可重试类别里 → 这一轮整轮失败 →
   * `input/requeued` 把输入退回队列 → 下一轮**从第 1 步重跑同一个请求** → 再撞同一堵墙。
   * 现在按"退回到什么状态"分两种（判据是**这是不是本轮第一步**）：
   *
   *   · **首步超时** ⇒ 这一轮**还什么都没做**（没有工具调用、没有任何副作用），退回去
   *     是"再给一次完整机会"，与其它整轮失败走同一条路（`turn-error`）；
   *   · **非首步超时** ⇒ 这一轮**已经花掉的工作不作废**：她的上下文里已经有它的输出与
   *     工具结果，重跑一遍只会把同一段活干第二次（今天那个循环就是这么滚起来的）。
   *     所以这里只把**结局**标成失败，让 turn 走既有失败路径（不做重投）。
   *
   * ⚠️ **两条路都不"原样重发同一个请求"**：重投是**下一轮**的事（那时上一条请求早已结束），
   * 而 `kind` 一律是 `error`（不是 `rate-limited` 那种"服务端让我等一会儿再来"）——
   * 于是"同一秒里再发一次同样的请求"这条路径在超时这一支上根本不存在。
   * 退回的输入照旧累计 `claimCount`；到 `MAX_TURN_ERROR_REQUEUE`（v74-A，整轮失败的重投上限）
   * 或 `MAX_CLAIM_COUNT`（毒消息的全局上限）就进死信（跨重启成立，判据从日志读）。
   */
  private failStep(
    step: number,
    error: unknown,
    context: { firstStep: boolean; startedMs: number; retriesBefore: number } | undefined,
  ): TurnEndReason {
    const known = isDsClientError(error);
    const code = known ? error.code : 'UNKNOWN_MODEL_ERROR';
    // 服务端原话要带出来：400 的响应体里往往写着真正的原因（哪个字段不合法），
    // 只留一句「请求被拒绝」等于把唯一的线索丢掉——上一轮就是靠补上它才查得下去。
    const detail = known ? (error.detail ?? null) : null;
    const base = error instanceof Error ? error.message : String(error);
    const message = detail === null || detail === '' ? base : `${base}；服务端原话：${detail}`;
    // **400 的一种可判别指纹**（2026-10-17 加，纯观测）：判据只认**服务端原话**（`detail`），
    // 不认我们自己拼的文案——它回答的是"服务端说为什么拒"，而 `base` 是我们写的话。
    // 判据唯一实现在 `ds-client.ts` 的 `isReasoningEchoRejection`（大小写/标点/距离都在那里定）；
    // 这里只把结论装进结局，**不改** kind / code / 重试语义 / 退不退输入。
    const reasoningEcho = isReasoningEchoRejection(detail);
    // **实测耗时**（原来写死 0）。缺 context 的调用点（子代理/诊断那几条）退回 0 而不是编一个数。
    const durationMs = context === undefined ? 0 : Math.max(0, Date.now() - context.startedMs);
    // 重试计数：优先取本 step 期间**订阅通道**上的真实次数（`DsClient.subscribeRetry`）；
    // 通道不可用时退回 `error.attempts - 1`——它说的正是"这一条请求在客户端里重试了几次"，
    // 与订阅计数同义（`attempts` 是内层 `withRetry` 耗尽时标上的）。
    // 缺 context 的调用点（子代理/诊断那几条）仍按老口径给这个数，行为与从前逐字相同。
    const retryCount = context === undefined
      ? (known ? Math.max(0, error.attempts - 1) : 0)
      : (this.retrySubscribed ? Math.max(0, this.retryCount - context.retriesBefore) : (known ? Math.max(0, error.attempts - 1) : 0));
    const timeoutKind = known && error.kind === 'timeout' ? code : null;
    // 计价档：失败那一步也判（同一条判据、同一个函数）——它说的是"这次调用落在哪一档"，
    // 与成没成功无关；判不出来就不写这一格（见 log/types.ts 的 `tier` 注释）。
    const tier = priceTierOf(this.deps.now());
    /**
     * 这一拍**实际用的协议**（协议回退 C-3）：`failStep` 是六处写入点里唯一拿不到
     * `DsStreamResult` 的那个——调用**抛了**，结果对象根本不存在。所以只能问客户端
     * "最近一次真发出去的那一发用的是哪套协议"（`DsClient.lastProtocol`，在 `exchange()`
     * 每发一发就更新；口径与 stale 边界写在那条访问器的注释里）。
     *
     * **有就带、没有就不写**：`null` = 本进程还没发过请求；测试替身/没有传输层的 `ds`
     * 连这个属性都没有（`undefined`）。两种都按"不知道"处理，**不默认成 `'responses'`**
     * ——那会把"没写"读成"用过 Responses"（与 `log/types.ts` 的字段口径同源）。
     */
    const protocol = this.deps.ds.lastProtocol;
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
      // 输出构成拆分：一个字都没回来 ⇒ 两格照写 0（与 outputTokens / reasoningTokens 同一条理由）
      outputTextTokens: 0,
      outputToolArgTokens: 0,
      ...(protocol == null ? {} : { protocol }),
      ...(tier === null ? {} : { tier }),
      durationMs,
      retryCount,
      finishReason: 'failed',
      tokensTodayAccum: this.projection.budget.tokensToday,
    }, { sync: false });
    this.write('step/end', { turn: this.turn, step, toolCalls: 0 }, { sync: true });
    this.log.flush();

    if (known && error.kind === 'rate_limited') {
      return { kind: 'rate-limited', retryAfterMs: error.retryAfterMs ?? 0 };
    }
    if (known && error.kind === 'aborted') return { kind: 'aborted', cause: this.abortCause() };
    // 超时型的可读原因：说清**是**超时、是哪只闸（静默 / 硬顶）、以及"退不退"这件事由谁决定。
    // 用户今天看到的是一条 `timeout` 加一次静默重投；现在这一句直接写进 `turn/end.reason.message`。
    if (timeoutKind !== null) {
      const first = context?.firstStep === true;
      const scope = first
        ? '这是本轮第一步：这一轮还什么都没做，输入退回队列，下一轮是完整的一次重试'
        : '这不是第一步：本轮已经做过的事不作废，输入**不退回**、也不原样重发同一个请求';
      return {
        kind: 'error',
        code,
        message: `${message}（超时型失败 · ${scope}）`,
        retry: first ? 'next-turn' : 'none',
      };
    }
    return {
      kind: 'error',
      message,
      code,
      // 只在认得出来时出现：别的 400（图片格式、参数不合法…）与老日志一样，**没有这一格**
      ...(reasoningEcho ? { reasoningEcho: true as const } : {}),
    };
  }

  /**
   * 整轮失败时把输入退回去（2026-10-02 补，用户报的一处洞）：模型/服务端拒了请求
   *（例如缺配对的 tool_call 被 400 打回），这一轮认领的输入不该就此消失——她连"有人叫过我"
   * 都看不到第二次。退回去是"还有一次完整机会"，与崩溃恢复走同一条路（`input/requeued`），
   * 认领次数照样累计；到上限就进死信（毒消息保护：一条必然失败的输入
   * 不该把守护进程拖进"拉起→失败→拉起"的循环）。
   *
   * **v74-A：两类失败分开处置（这是 2026-10-20 那场"她同一句答了三遍"的修法）**
   *   · `isServerRejection(reason)`（服务端**拒了这份请求**：`http_400` / `reasoningEcho` 指纹）
   *     ⇒ **一次都不再投**，直接 `input/dead-letter{reason:'server-rejected'}`。
   *     判据：同一份历史渲染出的还是同一份请求 ⇒ 服务端还会用同一句话拒它，"再试一次"没有意义，
   *     只是把同一句回答再写一遍（现场：一条输入被认领 3 次、她答了 3 次）。
   *   · 其余（超时/断流/上游 failed 等**可能是一次性**的）⇒ 照旧退回，但**有界**：
   *     认领满 {@link MAX_TURN_ERROR_REQUEUE} 次就不再投（`claim-limit`）。
   *     ⚠ 这个界比 `MAX_CLAIM_COUNT`（毒消息的全局上限，3）**更紧**：整轮失败的重投是"同一份
   *     请求重发"，多一次就多付一次完整请求的钱，两次已经用掉了"重试确实可能好"的全部理由。
   *
   * **被用户急停时是唯一的例外**（2026-10-16）：`{kind:'aborted', cause:'stop'}` 意味着
   * 用户按了 `/stop`——他刚刚要求的是"**停下来**"，这时把输入退回队列等于**立刻重投**
   * （下一拍又会开一个 turn 去干同一件活），正是他报的那件事（「我重启了又 tm 重投了」）。
   * 所以那一支走 {@link discardClaimedOnStop}：不退回，记 `input/discarded{by:'owner'}`。
   */
  private endTurn(reason: TurnEndReason): TurnEndReason {
    // `retry: 'none'` = 本轮失败但**不退回输入**（见 TurnEndReason 那一格的注释：
    // 非首步超时走这一支——已经花掉的工作不作废，也不原样重发同一个请求）
    if (reason.kind === 'error' && reason.retry !== 'none') this.requeueOnTurnError(reason);
    if (reason.kind === 'aborted' && reason.cause === 'stop') this.discardClaimedOnStop();
    // 「这一轮为什么没开口」：取一次、只取一次（判据读 this.spoke / this.step / this.lastThought，
    // 它们在收尾之后都不会再变，但把取值留在写之前，读写顺序一眼可查）
    const idleReason = this.idleReasonFor(reason);
    this.write('turn/end', {
      turn: this.turn,
      reason,
      spoke: this.spoke,
      // 可选格：没有理由时**整个不写**（不写 `undefined`，也不写一个空壳冒充"判过了"）
      ...(idleReason === null ? {} : { idleReason }),
    }, { sync: true });
    this.log.flush();
    return reason;
  }

  /**
   * 「这一轮为什么没开口」——`turn/end.idleReason` 的**唯一写入判据**（2026-10-19 加，纯事件层）。
   *
   * 为什么需要它：`turn/end` 早就有了 `spoke`（说过没有）与 `reason`（怎么收的场），但**沉默轮**
   * 里最该有人味的那一格是空的——"你为什么没说话"。外部的 dsh-bili-whale 把这一条列为最值得学的
   * 一条：每个"不作为"都得给一句人话理由，不许只写"跳过"。
   *
   * 判据三条，顺序就是边界：
   *   ① **她开口了 ⇒ 不写**：`spoke=true` 时这一轮不欠解释（她说的那段就是解释）；
   *   ② **只解释 `completed` ⇒ 其余不写**：失败 / 被掐 / 预算撞线 / 等待人审这些结局，
   *      `reason` 已经说清了"谁让它停的、卡在哪"，再标一格是把同一件事说两遍，还会把
   *      "外部原因"误读成"她自己决定不说"；
   *   ③ **纯机械路径（一步都没起）⇒ 只写 code**：`step === 0` 就是"没有输入可认领"的空拍，
   *      这一拍没有任何模型参与、没有一句话存在 ⇒ **不编 note**，只给 `nothing_worth_saying`。
   *
   * 有模型参与时，note 的来源见 {@link lastThought}：沉默轮里 `message/assistant.text` 一定是空的
   * （非空就会把 `spoke` 置真），能取到的她自己的话只剩思维链。**一个字都没有 ⇒ 也只写 code**
   * （`idleReasonFromText` 对空输入给 `nothing_worth_saying`）。
   *
   * 不写这一格的轮次读侧仍能分出来：`completed && !spoke` 却缺这一格 = "未记录"（老日志），
   * 由 `cli.summarizeEvent` 与将来的界面如实显示——**不是错误**。
   */
  private idleReasonFor(reason: TurnEndReason): IdleReason | null {
    if (this.spoke) return null;
    if (reason.kind !== 'completed') return null;
    if (this.step === 0) return { code: 'nothing_worth_saying' };
    return idleReasonFromText(this.lastThought);
  }

  /**
   * 整轮失败 → 退回本轮认领过的输入（`input/requeued{reason:'turn-error'}`），
   * 到上限的进死信（`input/dead-letter`）。**认领次数照旧累计**，所以失败不会无限重试。
   *
   * v74-A：**服务端拒掉的请求一次都不再投**（见 {@link endTurn} 的注释）；
   * 其余失败的上限是 {@link MAX_TURN_ERROR_REQUEUE}（比 `MAX_CLAIM_COUNT` 更紧）。
   * 进死信的那几条会**唤醒她一次**（{@link notifyAbandonedInputs}）：她得知道那句话没走完，
   * 而不是以为"我答过了"。
   */
  private requeueOnTurnError(reason: TurnEndReason): void {
    if (this.claimedCounts.size === 0) return;
    const rejected = isServerRejection(reason);
    const wakeSeqs: number[] = [];
    const claimCounts: number[] = [];
    const sources: WakeSource[] = [];
    const abandoned: Array<{ seq: number; why: 'server-rejected' | 'claim-limit'; claimCount: number }> = [];
    for (const [wakeSeq, countAtClaim] of this.claimedCounts) {
      const nextCount = countAtClaim + 1;
      const event = this.log.get(wakeSeq);
      /**
       * **框架自己的"放弃通报"不在这一套里**（v74-A 的自我保护）：它是一条 `wake/manual{via:'system'}`。
       * 若它也进退回/死信/再通报，通报就会自己生通报（实测：一条通报撞 400 ⇒ 又一条通报 ⇒ …）。
       * 它没走完就**静默作废**（`input/discarded{by:'system'}` 留痕）：它不是用户的输入，丢了不欠谁。
       */
      if (event !== null && event.type === 'wake/manual'
        && (event.data as { via?: string }).via === 'system') {
        this.write('input/discarded', {
          inputSeq: wakeSeq,
          claimCount: nextCount,
          reason: '框架的放弃通报本身没走完：不重投、也不再通报（否则通报会自己生通报）',
          by: 'system',
        }, { sync: true });
        continue;
      }
      if (rejected) {
        this.write('input/dead-letter', {
          inputSeq: wakeSeq,
          claimCount: nextCount,
          lastError: '服务端拒了这份请求（400）；同一份历史重发还是同一份请求，不再自动重试',
          reason: 'server-rejected',
        }, { sync: true });
        abandoned.push({ seq: wakeSeq, why: 'server-rejected', claimCount: nextCount });
        continue;
      }
      if (nextCount >= MAX_TURN_ERROR_REQUEUE) {
        this.write('input/dead-letter', {
          inputSeq: wakeSeq,
          claimCount: nextCount,
          lastError: '整轮失败（模型或服务端拒了请求）反复认领，不再自动重试',
          reason: 'claim-limit',
        }, { sync: true });
        abandoned.push({ seq: wakeSeq, why: 'claim-limit', claimCount: nextCount });
        continue;
      }
      wakeSeqs.push(wakeSeq);
      claimCounts.push(nextCount);
      // `wakeSourceOf` 认不出类型时给 'manual'（它自己的兜底）——这里只是类型上要一个确定值
      sources.push(event === null ? 'manual' : wakeSourceOf(event.type));
    }
    if (wakeSeqs.length > 0) {
      this.write('input/requeued', { wakeSeqs, claimCounts, sources, reason: 'turn-error' }, { sync: true });
    }
    if (abandoned.length > 0) this.notifyAbandonedInputs(abandoned, rejected);
  }

  /**
   * 放弃了一条输入 ⇒ **叫醒她一次**，把那件事说清楚（v74-A）。
   *
   * 为什么必须叫（用户的原话：「让她知道这条没答上，别再答」）：输入被丢进死信之后，
   * 那条话**不会再出现在她的上下文里**——不叫醒她，她只会记得"我好像答过"，而对方那边
   * 可能一个字都没收到；也可能她以为还要再答一遍（现场就是同一句答了三次）。
   *
   * 实现：写一条 `wake/manual{via:'system'}`——界面按"框架通报"渲染（`via` 有值就够，
   * 不需要界面加分支；`chat_page.dart` 的兜底标签会处理不认识的来源）。`dedupeKey` 带上
   * 被放弃的那几个 seq：同一条输入被放弃两次（重放/重启）也只叫一次。
   */
  private notifyAbandonedInputs(
    abandoned: ReadonlyArray<{ seq: number; why: 'server-rejected' | 'claim-limit'; claimCount: number }>,
    rejected: boolean,
  ): void {
    const seqs = abandoned.map(item => item.seq).join(',');
    const why = rejected
      ? '服务端一直拒收我的请求（同一份历史重发还是同一份，试也没用）'
      : `整轮失败重试了 ${MAX_TURN_ERROR_REQUEUE} 次还没走完`;
    this.write('wake/manual', {
      note: `[框架] ${why}，这条输入我先放下了（seq ${seqs}）。`
        + '它不是"已经答过"——对方那边可能什么都没收到；要不要重发由用户决定，别自己再答一遍。',
      via: 'system',
      dedupeKey: `input-abandoned:${seqs}`,
    }, { sync: false });
  }

  /**
   * 用户急停（`/stop`）时，本轮已认领的输入**不退回**，而是记成"用户有意作废"
   *（`input/discarded{by:'owner'}`，2026-10-16 加）。
   *
   * 为什么不是"退回队列"（那是 `endTurn` 里所有其他失败分支的做法）：
   * 用户按 `/stop` 要的正是**现在停、别再自动重来**。退回队列的下一步就是"下一拍再开一个
   * turn 干同一件活"，而他原话里的痛点就是「我重启了又 tm 重投了」。作废是**可逆**的
   * ——事件日志只增不改，他随时可以照 `wakeSeq` 把那条输入重新捡起来，但它**不会自己回来**。
   *
   * 三处用词是刻意的：
   *   · `reason` 写"用户按下 /stop"，不是"失败"——这不是故障，是人的决定；
   *   · `by: 'owner'` 与 `web/server.ts` 那条人工丢弃同形（`input/discarded.by` 的既有取值）；
   *   · **认领次数照抄**（`claimedCounts` 里那个数），与死信那条记录说的是同一个数——
   *     人回看时"它试了几次"不能有两个答案。
   */
  private discardClaimedOnStop(): void {
    if (this.claimedCounts.size === 0) return;
    for (const [wakeSeq, claimCount] of this.claimedCounts) {
      this.write('input/discarded', {
        inputSeq: wakeSeq,
        claimCount,
        reason: '用户按下 /stop：这一轮当场停下，输入不再自动重投（要接着做由人重新入队）',
        by: 'owner',
      }, { sync: true });
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
  private requestEvents(wakeToExclude: AppEvent | null): AppEvent[] {
    // 本轮新输入（首步的 `wakeEvent`，或 v74 起每一步都传的 `pinnedWake`）走**参数通道**，
    // 就不能同时出现在事件流里（见文件头协同契约）——否则它会被渲染两遍（一遍钉住、一遍历史）。
    const wakeSeq = wakeToExclude?.seq;
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

  /**
   * 把 lastSeq 之后的事件增量补进快照。render 的输入必须逐条来自日志，不接受内存态拼装。
   *
   * ═══════════ 轮首那一读：从「重放整份日志」改成「接宿主的全量快照」 ═══════════
   *
   * **改前**（2026-10-21 之前）：新 runner 的 `events` 是空的 ⇒ 第一次调用把 `from` 定成 1
   * ⇒ **整份日志从头重读一遍**。而 `runTurn` 每轮新建一个 TurnRunner（{@link runTurn}），
   * 于是"每轮重放整份事件日志"。真日志副本实测（`_research/_replaycost-bench.mts`，
   * 19.2 万条 / 150.1 MB，数字与复算方式都在那份脚本里）：
   *
   *   · 一轮 2 step 就是 6 次 syncEvents（`1 + 2×2 + 1`：`runInner` 1 次、每 step 2 次
   *     （`runStep` 与它后面的 `humanSuspension`）、`maybeCompact` 1 次），**只有第一次真读盘**；
   *   · 那一次读 **192,881 条 / 150.1 MB / 1.2~1.4 s**（多次实测 1.15~1.44 s，机器状态差）
   *     （其中 IO+切行 699~785 ms、JSON.parse+信封校验 312~584 ms）；
   *   · 读出来的这 192,881 条与**上一轮快照逐条相同（100.0%）**——这一读纯属浪费；
   *   · 按 9k 条/天增长，一个月后这一读就是 ~10 s/轮（外加每轮 ~90 MB 的解析垃圾）。
   *
   * **改后**：轮首只**播种一次**，源是 `state/event-snapshot.ts` 的进程级全量快照
   * （{@link allEventsOf}）——那一份本来就由 `real-loop.mcpIndexSync` 每拍维护、给界面八条
   * 只读端点共用（那条"全量事件只有一份，谁都不许自己再 readAll 一遍"的纪律见该文件头）。
   * 于是整份日志**一个进程只读一遍**，每轮只付一次"引用数组拷贝"（19.2 万条 ≈ 7.5 ms）+
   * 一遍 `eventFilter`（≈ 19.9 ms），之后照旧只补增量。同一份副本上同一件事：
   * **1.38 s → 29.8 ms**（re-read 0 条）；每轮新增堆也从 ~213 MB 降到 2.1 MB（`--expose-gc` 实测）。
   *
   * 三条不许动的语义：
   *   · **拷数组，不共享数组**：播种进来的是**同一个事件对象**（事件是只读的，见 event-snapshot
   *     的纪律：`web/server.ts` 与 `real-loop` 早就共用它们了），但 `this.events` 这个**数组**
   *     必须是 runner 自己的——下面还要往里 push。共享数组会让本 runner 的增量把进程级快照写脏
   *     （同一条事件出现两次，且下一轮读到的"全量"是假的）。
   *   · **`eventFilter` 照旧过**：子代理的隔离视图（`parentCallId === callId`）与主循环的两刀
   *     （顶层事件、指令不进上下文）都在这把刀上。播种走同一条路，隔离语义一个字节不变，
   *     游标另记（见 {@link eventsSeededUpTo}：被丢在尾部的事件不能让游标倒退）。
   *   · **失败就整份重来**：播种途中抛错（日志被关、坏行）时把这一轮已 push 的撤掉、标志复位
   *     ——否则"半份播种 + 满游标"会静默漏事件，那是最难查的那类错。
   */
  private async syncEvents(): Promise<void> {
    if (!this.eventsSeeded) {
      const seed = await allEventsOf(this.log);
      const filter = this.deps.eventFilter;
      const before = this.events.length;
      this.eventsSeeded = true;
      try {
        for (const event of seed) {
          if (filter !== undefined && !filter(event)) continue;
          this.events.push(event);
        }
        this.eventsSeededUpTo = seed.length === 0 ? 0 : seed[seed.length - 1]!.seq;
      } catch (error) {
        // 撤到播种前：宁可下一拍重播一遍，也不许留一份"少了中间几条"的快照
        this.events.length = before;
        this.eventsSeeded = false;
        this.eventsSeededUpTo = 0;
        throw error;
      }
    }
    const last = this.events[this.events.length - 1];
    // 两侧取大（过滤会丢事件，见 eventsSeededUpTo）；空日志与空快照时它仍是 1
    const from = Math.max(last?.seq ?? 0, this.eventsSeededUpTo) + 1;
    for await (const event of this.log.readRange(from)) {
      if (last !== undefined && event.seq <= last.seq) continue;
      // 隔离过滤（子代理）：被挡掉的事件不进快照，于是 render 看到的就是「从空事件序列起」那一份。
      // 它在 seq 上是跳跃的，但 render 只要求按 seq 升序（不要求连续）。
      if (this.deps.eventFilter !== undefined && !this.deps.eventFilter(event)) continue;
      this.events.push(event);
    }
  }

  /**
   * **step 边界的图片预取**（2026-10-21；见 {@link AgentLoopDeps.prewarmStepImages}）。
   *
   * 三条判据都在这里，一处说清：
   *   ① **位置**：`runStep` 在 `syncEvents` 之后、`deriveAt` 之前调它——晚一步这一拍就没图，
   *      早一步事件还没进快照（渲染按快照挑图，挑不到就等于没预取）。
   *   ② **硬顶**：宿主给的 promise 只等 {@link STEP_PREWARM_TIMEOUT_MS}。超时/抛错/同步抛错
   *      一律**降级**：这一拍照旧发（附件那行地址还在，`vision_read` 仍是兜底），只留一条
   *      `image/trace` 说明"五秒没回来"或"它炸了"。
   *   ③ **不甩出未处理的 rejection**：那件事先 `.catch` 成局部变量再 race——超时之后它再
   *      reject 也不会变成 unhandledRejection（全进程都盯着的那条静默崩溃路）。
   */
  private async prewarmStepImages(): Promise<void> {
    const prewarm = this.deps.prewarmStepImages;
    if (prewarm === undefined || prewarm === null) return;
    const budgetMs = this.deps.prewarmStepTimeoutMs ?? STEP_PREWARM_TIMEOUT_MS;
    const startedMs = Date.now();
    let failure: unknown = null;
    // `Promise.resolve().then(...)`：宿主实现**同步**抛错也收成 rejection，与异步失败同一条路
    const work = Promise.resolve().then(() => prewarm()).catch((error: unknown) => {
      failure = error;
    });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, budgetMs);
      });
      await Promise.race([work, deadline]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    const ms = Date.now() - startedMs;
    if (failure !== null) {
      // 抛错也降级：这一拍照旧发，只留一条痕（`line` 是给人读的那一句）
      this.write('image/trace', {
        kind: 'prewarm-failed',
        stage: 'prewarm',
        ref: '',
        ms,
        line: `图片预取失败（不影响这一拍，照旧发）：`
          + `${failure instanceof Error ? failure.message : String(failure)}`,
      }, { sync: false });
      return;
    }
    if (timedOut) {
      this.write('image/trace', {
        kind: 'prewarm-timeout',
        stage: 'prewarm',
        ref: '',
        ms,
        line: `图片预取超过 ${budgetMs}ms 没回来：这一拍照旧发（这张图下一拍再试，`
          + '消息里的地址与 vision_read 都还在）',
      }, { sync: false });
    }
  }

  /**
   * **step 边界的申请单拾取**（2026-10-21；见 {@link AgentLoopDeps.settleGrantsStep}）。
   *
   * 与 `prewarmStepImages` 的差别：这件事是**本地读几个小文件 + 写两条事件**，没有网络等待，
   * 所以不给硬顶；但**失败一律降级**——拾取失败了只是"卡晚一点出现"（下一拍补），绝不许
   * 把这一轮打断。
   */
  private async settleGrantsAtStep(): Promise<void> {
    const settle = this.deps.settleGrantsStep;
    if (settle === undefined || settle === null) return;
    try {
      await settle();
    } catch {
      // 拾取失败 = 下一拍再来：这一轮照常跑（与图片预取的降级同一条纪律）
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
      // 阶段二（2026-10-19）：召回账（四态 + 命中词 + 候选数 + token）。关着开关时这一格
      // 整个不出现 ⇒ 老事件形状逐字节不变（与上面三格同一条纪律）。
      ...(plan.recall === undefined ? {} : { recall: plan.recall }),
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
    /** v74：本轮新输入的钉住位置（每一步都传；见 `RequestDerivation.pinnedWake`） */
    pinnedWake?: PinnedWake | null;
    step: number;
    now: string;
    model: string;
    softHint: string | null;
    /** 思维链上限（v73）：缺省 = 出厂；400 自救那一支传"不限"（见 `reasoningEchoFallback`） */
    reasoningEcho?: Partial<ReasoningEchoPolicy> | null;
  }): RenderedRequest {
    // 本轮新输入走参数通道，就不能同时出现在事件流里（见文件头协同契约）；
    // 框架自己的动作（整理唤醒）**两条路都不进**（见 `requestEvents`）。
    // v74：`pinnedWake` 优先——它每一步都在，位置（`beforeSeq` = 本轮 turn/start）也每一步相同。
    const events = this.requestEvents(args.pinnedWake?.event ?? args.wakeEvent);
    // 进请求的清单是**现取的活值**（不缓存、不从事件读）——它是 `tools` 段失守时唯一的事实来源，
    // 所以在这一行上面比一次指纹、变了就落一条 internal 账（BUG-3）。**只读、不改字节**。
    const options = this.deps.modelVisibility ?? {};
    const tools = this.deps.registry.listForModel(options);
    this.noteToolInventory(tools, options, args.step);
    const rendered = deriveRequest({
      persona: this.deps.persona,
      tools,
      timezone: this.deps.timezone,
      lane: this.lane,
      events,
      wakeEvent: args.wakeEvent,
      ...(args.pinnedWake === undefined || args.pinnedWake === null ? {} : { pinnedWake: args.pinnedWake }),
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
      // 上一步的此刻层（v69：**完整的那一层**，见 `previousNow` 那一格）。空串 = 没有参照 ⇒ 每个字段都发。
      previousNowLayer: this.previousNow === '' ? null : this.previousNow,
      // 本机与用度：宿主在**每个 turn 装配 deps 时**算一次（与 contact 同节奏）——磁盘 statfs
      // 与进程 uptime 是会失败的 IO，不适合每个 step 都做一遍；用度是"今日累计"，一拍一算是够的。
      machine: this.deps.machine ?? null,
      usage: this.deps.usage ?? null,
      // 豁免判据：宿主装配 deps 时给一次（real-loop 的 agentDeps），每步原样转手——
      // 与 contact/machine/usage 同一条纪律：渲染层不读盘，名单的真源在宿主手里。
      warnExempt: this.deps.warnExempt ?? null,
      // 本轮那条通道消息的名字（v76）：宿主每轮算一次、每步原样转手。渲染层只把它给
      // **钉住的那条唤醒**——历史段一个字节都不吃它（见 render.ts 的 contextFor）。
      channelRender: this.deps.channelRender ?? null,
      loadImage: this.deps.loadImage ?? null,
      ...(this.deps.maxContextImages === undefined
        ? {}
        : { maxContextImages: this.deps.maxContextImages }),
      // 思维链上限（v73）：缺省不传 ⇒ 出厂（全量 + 硬上限）；自救那一支显式给"不限"。
      ...(args.reasoningEcho === undefined ? {} : { reasoningEcho: args.reasoningEcho }),
    });
    // **400 自救的那一拍不参与中段改写判据**（v76）：它用"连硬上限都不设"的口径重渲染，
    // 历史段的 reasoning 集合与正常那一拍不同 ⇒ 拿它当基线会把自救本身报成改写，
    // 下一步再比一次就又是误报。`args.reasoningEcho` 只有自救那一支会传（见 deriveAt 的参数注释）。
    if (args.reasoningEcho === undefined) this.noteHistoryAppend(args.step, rendered.context);
    return rendered;
  }

  /**
   * **中段改写不变量**（v76，P4）：同一 turn 内相邻两步，历史段必须只是追加。
   *
   * 判据只有一处（{@link historyAppendCheckOf}，在 `render.ts` 里与 `headHash` 的产出同源）；
   * 这里只负责"拿上一步的基线去比"与"破了留痕"。**不抛、不拦请求**（理由见那个字段的注释）。
   *
   * 为什么基线的步号必须是 `step - 1`：400 自救会在**同一步**里重建请求（`reasoningEchoFallback`），
   * 那不是"相邻两步"。拿同一步的两次渲染相比，会把自救自己报成中段改写。
   */
  private noteHistoryAppend(step: number, context: ContextBreakdown): void {
    const history = context.history;
    const previous = this.previousStepHistory;
    if (previous !== null && previous.step === step - 1) {
      const violation = historyAppendCheckOf(previous.baseline, {
        headHash: history.headHash,
        items: history.items,
        ...(history.headItems === undefined ? {} : { headItems: history.headItems }),
      });
      if (violation !== null) {
        // 留痕写不进去**不许反噬请求**（与 `real-loop.traceImage` 同一条纪律）：这是账，
        // 不是判据的输入。写失败最多少一条证据，不该让这一拍发不出去。
        try {
          this.write('render/history-rewrite', {
            turn: this.turn,
            step,
            ...violation,
          }, { sync: false });
        } catch {
          // 少一条账，不抛
        }
      }
    }
    // 基线**每次都推进**（与 noteToolInventory 同一条纪律：观测不许反过来改变装配行为）
    this.previousStepHistory = {
      step,
      baseline: {
        headHash: history.headHash,
        items: history.items,
        ...(history.headItems === undefined ? {} : { headItems: history.headItems }),
      },
    };
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

  /**
   * **这一条 lane 换模型了就落一条 `runtime/model-switch`**（2026-10-26 加，用户："模型切换本身
   * 要落一条事件"）。
   *
   * 为什么必须有它：缓存命中率是**按模型分账**的（`runtime/cache-alert.ts` 的窗口 = 同一 model
   * 的最近 20 轮），而"换过模型"这件事在日志里**天生没有对应事件**——`budget/consumed.model`
   * 每拍都有，要回答"这个窗口里换过没有、什么时候换的"却得人工逐条比对。有了它，那条
   * `budget/cache-alert` 与"哪一刻重开的窗口"在同一行日志里就对得上。
   *
   * 三条边界：
   *   · **判据是日志，不是内存**：`from` 取**轮首快照**（`this.events`）里这一条 lane 的上一拍
   *     模型——它才是"缓存窗口真正从哪个模型切过来"的那个 from；内存里没有可比对象
   *     （进程刚起时 `previousAuditedModel` 是 null）。
   *   · **一条切换只写一条**：`this.events` 是轮首快照（不含本 turn 刚写的），同一轮里每拍都会
   *     得到同一个结论 ⇒ 由 {@link TurnRunner.modelSwitchNoted} 挡住重复；跨轮不用挡——
   *     下一轮的快照里已经有新模型了。
   *   · **只落账、不进请求体**：可见性 internal（`EVENT_VISIBILITY`），不改 `RENDER_VERSION`。
   *     找不到上一拍（新机器 / 日志刚滚过）⇒ 一个字都不写（没有"从哪来"就没有切换这件事）。
   */
  private noteModelSwitch(model: string, ts: string): void {
    if (this.modelSwitchNoted) return;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event === undefined) continue;
      if (event.type !== 'budget/consumed') continue;
      if (event.parentCallId !== undefined) continue;
      if (event.data.lane !== this.lane) continue;
      const from = event.data.model;
      this.modelSwitchNoted = true;
      if (typeof from !== 'string' || from === '' || from === model) return;
      this.write('runtime/model-switch', { lane: this.lane, from, to: model, ts }, { sync: false, ts });
      return;
    }
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
  /**
   * **回传集合的字符账**（**v75 加，每轮都有**）：`echoChars` = **会回传的总字符**
   * （= 真回传的 `echoCharsKept` + 已被挤掉的），`echoCharsLimit` = 生效上限
   * （`REASONING_ECHO_POLICY.maxTotalChars`；`null` = 出厂没设上限）。
   *
   * 三个数都从 `reasoningEchoBudgetOf`（= `reasoningEchoPlan`）来，与渲染层**同一处判据**：
   * 第二条进门路是 `echoChars > echoCharsLimit`，判据用到的数必须能从日志读回来。
   *
   * ⚠ **判据读 `echoChars`（总量）、不读 `echoCharsKept`**：后者一驱逐一压就"变好看"
   * （被压回上限以内），拿它当压力读会在真正出事的那一刻失去信号——2026-10-21 凌晨那 39 分钟
   * 正是这个形状（`kept` 一直 ≤ 300K，驱逐一直在发生）。
   */
  echoChars: number;
  /** 真正留在请求里的那一份（`echoChars - 被挤掉的`）；只服务观测，不参与判据 */
  echoCharsKept: number;
  echoCharsLimit: number | null;
  /**
   * **哪一条判据把这一拍推过第一道门的**（**v75 加**；`threshold` 时缺席 = 谁都没推）。
   * 见 `log/types.ts` 的 `CompactionDecision.trigger`。
   */
  trigger?: 'history-tokens' | 'echo-chars';
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
  /**
   * **回传字符账**（v75 的第二条触发）：与渲染层**同一处判据**（`reasoningEchoBudgetOf`
   * → `reasoningEchoPlan`），遮蔽点取"已有摘要的覆盖点"（与 `estimateHistoryTokens` 同一份口径：
   * 压在遮蔽点之前的思维链本来就不回传）。
   *
   * 为什么要它（结构性的理由，不是"多一道保险"）：`historyTokens` 是**估算器的 token 账**，
   * 而"回传字符顶穿 300K"是**渲染层的字符账**——两者不是同一把尺（估算器按 1.5 字/token 折算，
   * 实测偏低 1.6× 左右）。2026-10-21 凌晨那 39 分钟里，`historyTokens` 一直没到 200,000 的线，
   * 而回传字符早就顶穿 300K、渲染层每笔都在挤最老的组 ⇒ 压缩线**根本没被叫到**。
   * 把字符这一侧接上压缩线，"顶穿"就从"渲染层每笔微调"变成"一次遮蔽点把它整段移走"。
   */
  const echo = reasoningEchoBudgetOf(events, maxSummaryCoverage(events));
  const echoOver = echo.limit !== null && echo.chars > echo.limit;
  const base = {
    turn, historyTokens, thresholdTokens,
    echoChars: echo.chars, echoCharsKept: echo.kept, echoCharsLimit: echo.limit,
  };

  // ① 进门：**两条路**——可见历史过阈值（老口径），或者回传字符过上限（v75 加）。
  //   没配压缩那一支照旧停在第一道门（它连阈值都没有，压缩这种事对它不成立）。
  if (cfg === null || (!echoOver && historyTokens <= cfg.thresholdTokens)) {
    return { ...base, reason: 'threshold' };
  }
  // 进了门就把"哪条路"记下来：`reason` 只说"第一条拦下它的是谁"，说不出"谁把它推进来的"
  const trigger: 'history-tokens' | 'echo-chars' = echoOver ? 'echo-chars' : 'history-tokens';

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
    return { ...base, trigger, reason: 'monotonic', coveredUpToSeq, previousCoveredUpToSeq };
  }
  const afterTokens = estimateHistoryTokens(events, coveredUpToSeq);
  if (afterTokens > historyTokens) {
    return { ...base, trigger, reason: 'no-shrink', coveredUpToSeq, previousCoveredUpToSeq };
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
  //
  // ⚠ **v75：这条闸门对 `echoOver` 那一支不需要特例**（曾经想加 `!echoOver`，读了数之后删掉了）：
  // `echoChars` 量的正是"遮蔽点之后全部 model 可见思维链"，而闸门量的是同一个窗口里的 token
  // ⇒ `echoChars > 300,000` 必然意味着那个窗口 ≳ 20 万 token，远在 `RECENT_TAIL_TOKENS`（2 万）
  // 之上。加一条"特权分支"只会多一条**走不到、也就测不到**的路（这个仓库对"测不到的分支"的
  // 态度见 `handoff-note.test.ts` 的"两个消费者、同一把尺"那一组）。
  const maskedTokens = estimateMaskedTokens(events, previousCoveredUpToSeq, coveredUpToSeq);
  if (previousCoveredUpToSeq > 0 && maskedTokens < RECENT_TAIL_TOKENS) {
    return { ...base, trigger, reason: 'gate', coveredUpToSeq, previousCoveredUpToSeq, maskedTokens };
  }

  return { ...base, trigger, reason: 'wrote', coveredUpToSeq, previousCoveredUpToSeq, maskedTokens };
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

/**
 * 400 自救用的上限：**连硬上限都不设**（真·全量回传）。
 *
 * 为什么连 300,000 的总字符帽也摘掉：服务端要的是"完整回传"，而这一支只在**已经**被
 * "reasoning_text 没回传"拒过之后才走——此时"少发一点"的风险远大于"请求大一点"的风险。
 * 它由 `TurnRunner.reasoningEchoFallback` 传给 `deriveAt`（见那里的注释）。
 *
 * 2026-10-21（区外开关）：`outOfRegion` 在这里**显式写死 `'keep'`**——自救的默认答案必须是
 * "把能给的都给出去"（区外也传）。别把它改成"跟随配置"：那一格的意义就是排除"少发"这个变量。
 */
const FULL_REASONING_ECHO: { maxTotalChars: null; outOfRegion: 'keep' } = Object.freeze({
  maxTotalChars: null,
  outOfRegion: 'keep',
});

/** 服务端原话进日志的上限（字符）：400 的正文常常几百字，全留会把事件撑大 */
const ECHO_DETAIL_LOG_MAX = 500;

/**
 * 同一输入因**整轮失败**被重投的次数上限（v74-A；认领满这么多次就进死信）。
 *
 * 为什么是 2（不是 `MAX_CLAIM_COUNT` 的 3）：
 *   · 整轮失败的重投 = **同一份请求重发**（历史没变、渲染没变）⇒ 多一次就多付一次完整请求的钱；
 *   · 现场（2026-10-20）那条输入被认领 3 次、她**把同一句答了三遍**，对方还未必收到——
 *     用户的口径是"有界、别再答第三遍"；
 *   · 两次已经用掉"重试确实可能好"的全部理由（第一次失败是偶发、第二次就不是了）。
 * 真因为**服务端拒了这份请求**（400）时这个界都不用等：见 `isServerRejection`，一次都不再投。
 */
const MAX_TURN_ERROR_REQUEUE = 2;

/**
 * 这次整轮失败是不是"**服务端拒了这份请求**"（v74-A；`http_400` 或思维链没回传的指纹）。
 *
 * 为什么这一类不重投：被拒的是**这一份请求**——同一份历史渲染出的还是同一份请求，
 * 重投只会再被同一句话拒一次（现场 33 次自救、每次全量回传，服务端照样 400）。
 * 判据只看已有的字段（不新增判据）：`code === 'http_400'`（客户端对 400 的归类）
 * 或 `reasoningEcho === true`（2026-10-17 落库的指纹，`ds-client.isReasoningEchoRejection` 的结论）。
 */
function isServerRejection(reason: TurnEndReason): boolean {
  return reason.kind === 'error' && (reason.code === 'http_400' || reason.reasoningEcho === true);
}


/** 服务端原话裁到 `ECHO_DETAIL_LOG_MAX`（null ⇒ 空串：事件里不写"不知道"，写空串） */
function clipEchoDetail(detail: string | null): string {
  if (detail === null) return '';
  return detail.length <= ECHO_DETAIL_LOG_MAX ? detail : `${detail.slice(0, ECHO_DETAIL_LOG_MAX)}…`;
}

function toDsRequest(rendered: RenderedRequest, lane: ModelLane, signal: AbortSignal | undefined): DsRequest {
  // **发送前的自洽断言**（v73，防复发的第二道门）：render 之后、`ds.stream` 之前的最后一步。
  // 判据与理由见 `render.ts` 的 `assertReasoningEchoIntegrity`：任何一个 `reasoning` item
  // 缺正文 / 正文为空 ⇒ **抛**，这一份请求发不出去（宁可这一拍失败，也不发半截状态）。
  assertReasoningEchoIntegrity(rendered.input);
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

/**
 * `budget/consumed.finishReason` 的**唯一判据**（`fold` 只看它决定 `failStreak` 涨还是清零）。
 *
 * `failed` 由循环层从客户端合同里**一次**取来（`DsStreamResult.failure !== null`，
 * 见 `runStep` 里那段注释），本函数不再回头看 `status` / `interrupted`：
 *   · 正常收尾 ⇒ `'completed'`；
 *   · 上游说"没说完"的两种（`max_output_tokens` / `content_filter`）各留自己那一档
 *     （它们不是失败，也不该被读成"说完了"；2026-10-18 补 `content_filter`）；
 *   · 外部取消 ⇒ `'aborted'`（不是模型失败，不涨 `failStreak`）；
 *   · 其余没跑完（断流 / 超时 / 上游终态 `failed`）⇒ `'failed'`。
 */
function finishReasonOf(
  result: DsStreamResult,
  failed: boolean,
): 'completed' | 'max_output_tokens' | 'content_filter' | 'failed' | 'aborted' {
  if (result.incompleteReason === 'max_output_tokens') return 'max_output_tokens';
  if (!failed) return result.incompleteReason === 'content_filter' ? 'content_filter' : 'completed';
  return result.failure?.code === 'aborted' ? 'aborted' : 'failed';
}

// ──────────────────── 计价档（高峰 / 空闲）────────────────────

/**
 * 北京时间相对 UTC 的固定偏移：**中国全境单一时区、不实行夏令时**，所以 +8 是个常量，
 * 不需要时区库（`Intl` 也能算，但这里要的是"永不随宿主环境变"）。
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 这一刻属于**计价的哪一档**（`budget/consumed.tier` 的唯一判据，纯函数）：
 *
 *   · `'peak'`（高峰全价）：**周一至周五 09:00–12:00 与 14:00–18:00**（北京时间，左闭右开）；
 *   · `'off'`（空闲半价）：**其余全部**——12:00–14:00 午间、18:00–次日 09:00、周六与周日整天。
 *
 * 实现上只做一件事：把 ISO 时间戳（尾巴带 `Z` 或带 `+08:00` 都吃）**显式 +8 小时**，
 * 再用 `getUTC*` 读北京墙上钟。**刻意不用 `getHours()` / `getDay()`**：那两个读的是**宿主时区**，
 * 同一份日志换台机器、或换个 `TZ` 环境变量就会得出另一个结论——判据不能建立在环境上。
 *
 * ⚠ **没有节假日日历 ⇒ 法定节假日会被误判成 `'peak'`**（调休上班的周六同理会被判成 `'off'`）：
 * 本函数**只按"周一至周五 + 时段"判定**，不含任何节假日表。别拿它当"当天一定全价/一定半价"读
 * ——详见 `log/types.ts` 的 `tier` 字段注释。要精确就得先把日历接进来。
 *
 * 解析不出时间戳（不是 ISO）返回 `null` ⇒ 调用方**不写这一格**（判不出就不猜）。
 */
export function priceTierOf(ts: string): 'peak' | 'off' | null {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const beijing = new Date(ms + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDay(); // 0 = 周日 … 6 = 周六
  if (day === 0 || day === 6) return 'off';
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  const morning = minutes >= 9 * 60 && minutes < 12 * 60;
  const afternoon = minutes >= 14 * 60 && minutes < 18 * 60;
  return morning || afternoon ? 'peak' : 'off';
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

// ──────────────────────── 思维链处置账的**本轮累计**（v75 的③） ────────────────────────

/**
 * 一轮里**每一步**的思维链处置账（`ReasoningEchoRepair`）的累计——`model/reasoning-echo`
 * （`kind:'reasoning_echo_prune'`）的载荷就是从这里来的。
 *
 * 为什么需要"累计"这一层（2026-10-21 凌晨那场，读数逐条）：
 *   · v73 的写法是"第一次发生处置就写一条，之后锁死"（`reasoningEchoTraced`）；
 *   · 而 step 1 的修复里几乎总有 `orphanAssistants`（`speak`/`report` 写的那段正文没有配对的
 *     reasoning）⇒ **锁在 step 1 就被用掉**；
 *   · 于是之后每步"再挤掉一个最老的组"**一条痕迹都不留**——现场 46 条 prune 事件里没有一条带
 *     `dropped`，那 39 分钟的 92% miss 只能写成 `cause:"unattributable"`。
 *
 * 现在的口径：**每步并进累计、轮收尾写一条**（`TurnRunner.flushReasoningEchoTrace`）——
 * 写库次数与 v73 一样（一 turn 一条，不刷屏），但内容不再是"第一步那一条"：
 *   · `dropped` / `restored` / `orphanAssistants` 是各步的**并集**（按 seq 去重、按 seq 升序）；
 *   · `steps` = 并进来的**步数**（"这一轮有几步在挤/补"）；
 *   · `droppedChars` / `droppedItems` = 并集里各组之和（**总字符**，不是第一条的字符数）；
 *   · `orphanItems` 取各步的**最大值**——同一份输入每步数出的是同一个数，求和会把它乘上步数；
 *   · `overChars` 取**最大值**（v75：本轮顶破硬上限多少）。
 *
 * 判据是纯函数（同一批 repair 序列 ⇒ 同一份累计），所以用例可以直接喂三份 repair 复算
 * "一轮里发生 3 次驱逐 ⇒ 读出总条数与总字符"（`test/agent-loop.test.ts` 的 ⑧）。
 */
export interface ReasoningEchoTurnTotals {
  /** 并进来的步数（只数**真发生过处置**的那些步） */
  steps: number;
  /** 第一次发生处置的步号（诊断用：它可能不是 1） */
  firstStep: number;
  /** 最后一次发生处置的步号（写进事件的 `step`） */
  lastStep: number;
  /** 各步丢掉的 assistant 组（并集，按 `assistantSeq` 升序） */
  dropped: ReasoningEchoDropGroup[];
  /** 并集里各组移出的 input item 总数 */
  droppedItems: number;
  /** 并集里各组的思维链正文字符数之和 */
  droppedChars: number;
  /** 各步补回的思维链 seq（并集，升序） */
  restored: number[];
  /** 各步删掉的孤儿 thinking item 数（取最大值，见上） */
  orphanItems: number;
  /** 各步整条没发的 assistant 正文（并集，按 seq 升序） */
  orphanAssistants: Array<{ seq: number; chars: number }>;
  /** 那些正文一共多少字符（并集之和） */
  orphanAssistantChars: number;
  /** 本轮留下的回传总量顶破总字符硬上限多少字符（取最大值；`0` = 没顶破） */
  overChars: number;
}

/** 一组"被丢掉的组"的去重键：同一组在不同步里重复出现（step 2 会再丢一次 step 1 丢的那批） */
function dropGroupKey(group: ReasoningEchoDropGroup): string {
  return `${group.assistantSeq === null ? '-' : String(group.assistantSeq)}|`
    + `${group.reasoningSeqs.join(',')}|${group.why}`;
}

/**
 * 把**一步**的处置账并进本轮累计（v75 的③）。
 *
 * 形态：**累加器**——给了 `totals` 就**原地并进去**再返回同一个对象（省一次分配，且调用点只有
 * `TurnRunner` 一个）；`repair` 只读、不改。判据部分是可复算的纯逻辑（不读时钟、不看日志），
 * 所以用例可以直接喂三份 repair 复算"一轮里发生 3 次驱逐 ⇒ 读出总条数与总字符"。
 *
 * 返回 `null` 表示"这一轮到现在为止没有任何处置"（事件里也就不该出现这一轮）——
 * 空 repair 不会凭空造出一条"驱逐过 0 组"的账（那种读数会被读成"没有驱逐"，与"没写"混成一种形状）。
 */
export function accumulateReasoningEchoTotals(
  totals: ReasoningEchoTurnTotals | null,
  step: number,
  repair: ReasoningEchoRepair,
): ReasoningEchoTurnTotals | null {
  const empty = repair.dropped.length === 0 && repair.restored.length === 0
    && repair.orphanItems === 0 && repair.orphanAssistants.length === 0 && repair.overChars === 0;
  if (empty) return totals;
  const next: ReasoningEchoTurnTotals = totals ?? {
    steps: 0, firstStep: step, lastStep: step,
    dropped: [], droppedItems: 0, droppedChars: 0,
    restored: [], orphanItems: 0, orphanAssistants: [], orphanAssistantChars: 0,
    overChars: 0,
  };
  next.steps += 1;
  next.lastStep = step;
  // ① 丢掉的组：并集（同一步里也不会重复；跨步重复是常态——丢的是"最老的那一批"）
  const seenDropped = new Set(next.dropped.map(dropGroupKey));
  for (const group of repair.dropped) {
    const key = dropGroupKey(group);
    if (seenDropped.has(key)) continue;
    seenDropped.add(key);
    next.dropped.push(group);
    next.droppedItems += group.items;
    next.droppedChars += group.chars;
  }
  next.dropped.sort((a, b) => (a.assistantSeq ?? -1) - (b.assistantSeq ?? -1));
  // ② 补回的思维链：并集 + 升序
  for (const seq of repair.restored) {
    if (!next.restored.includes(seq)) next.restored.push(seq);
  }
  next.restored.sort((a, b) => a - b);
  // ③ 孤儿 item：取最大值（同一份输入每步数出同一个数，求和会乘上步数）
  next.orphanItems = Math.max(next.orphanItems, repair.orphanItems);
  // ④ 整条没发的 assistant 正文：并集（按 seq）
  const seenOrphan = new Set(next.orphanAssistants.map(item => item.seq));
  for (const item of repair.orphanAssistants) {
    if (seenOrphan.has(item.seq)) continue;
    seenOrphan.add(item.seq);
    next.orphanAssistants.push(item);
    next.orphanAssistantChars += item.chars;
  }
  next.orphanAssistants.sort((a, b) => a.seq - b.seq);
  // ⑤ 顶破硬上限的量：取最大值（同一轮里它是同一个值）
  next.overChars = Math.max(next.overChars, repair.overChars);
  return next;
}
