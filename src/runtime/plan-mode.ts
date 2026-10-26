/**
 * Irmia Agent — 计划模式与人审挂起（docs/design.md §4.21、milestones M8-6 / M8-7）
 *
 * **三条人审通道的分工**（本模块最需要说清的一件事，三条都在「turn 挂起」这个统一形态上收束）：
 *   • **事前** `plan/pending`：destructive 调用被拦下，还没动手，等批准。开关是 `tools.planMode`，
 *     批准凭指纹放行**一次**（许可在对应调用真的落进 `tool/call` 时被消费）。
 *   • **事后** `tool/result{unknown}` → `needsReview`：动过手但结局不明，等人定性。
 *   • **事中** `human/asked`：干到一半需要一个人才知道的信息。它原来的工具入口
 *     `ask_human` 在 v27 被删（无人值守里挂起一轮等 24h 几乎总是浪费），**事件与链路保留**
 *     ——现在这条通道的实际写入方就是本模块的拦截路径（计划待批准）。
 *
 * 三条都落到同一个收尾动作上：turn 以 `{kind:'blocked', by:'ask-human'}` 结束**而不是关掉**，
 * 认领过的输入等 `human/answered` 到达后由 real-loop 经 `input/requeued{reason:'human-answered'}`
 * 送回队列（挂起期间 pending 是空的，不重入队就再也没人叫醒它）。
 *
 * 本模块只做**判定与事件写入**：投影是日志的折叠结果，这里既不持有权威状态，也不执行工具。
 * 执行侧的拦截点在 tools/executor.ts 两阶段落库之前——被拦的调用没有 `tool/call`、没有
 * `tool/result`（与 PreToolUse 钩子拒绝同一纪律：没执行的调用写进两阶段落库就是伪造事实）。
 *
 * 约定：值导入写 `.ts`，纯类型导入写 `.js`。
 */

import type {
  AppEvent, HumanAskSource, Projection, Visibility, WakeSource,
} from '../log/types.js';
import { defaultVisibility, humanAskSourceOf, planFingerprint } from '../log/types.ts';
import { wakeSourceOf } from '../state/fold.ts';
import type { PlanGateCall, ToolPlanDenial, ToolPlanGate } from '../tools/executor.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 人审挂起超时（design §4.21：默认 24h）。超时按 budget-exhausted 同等语义暂停 */
export const DEFAULT_HUMAN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** 计划审批的提问文本（人看到的卡片标题）。写死在常量里：它是「批准」这个动作的界面契约 */
export const PLAN_APPROVAL_QUESTION = '批准执行计划？';

/** agent-loop 挂起 turn 时写进 `turn/end{blocked, by}` 的标记 */
export const ASK_HUMAN_BLOCKED_BY = 'ask-human';

/** 批准信号：`human/answered.answer` 恰好等于它即表示批准（design §4.21） */
export const APPROVE_ANSWER = 'approve';

/** 拒绝信号前缀：answer 以它开头即拒绝，后面的文字是拒绝理由 */
const REJECT_PREFIXES: readonly string[] = ['reject', 'deny', '拒绝'];

/** 调用被拦时回给模型的错误码（只进内存 records：被拦的调用没有 tool/result 可写） */
export const PLAN_PENDING_CODE = 'E_PLAN_PENDING';
export const PLAN_ALREADY_PENDING_CODE = 'E_PLAN_ALREADY_PENDING';

// ──────────────────────────────── 类型 ────────────────────────────────

/** 事件写入口：宿主负责分配 seq 并落盘（与 admin 工具同一条纪律） */
export type PlanEventEmitter = (type: string, data: unknown, visibility: Visibility) => void;

export interface PlanModeOptions {
  /** `config.tools.planMode`。false 时本模块整体退化为直通（零行为变化） */
  enabled: boolean;
  /** 运行期投影：待批队列与已批准许可都从它读（即时性由宿主写入点的 applyOne 保证） */
  projection: Projection;
  emit: PlanEventEmitter;
  now: () => Date;
  /** 人审挂起超时，默认 DEFAULT_HUMAN_TIMEOUT_MS */
  timeoutMs?: number;
}

/** 计划结案的三条出路（与 schema 的 plan/resolved.outcome 同一枚举） */
export type PlanOutcome = 'approved' | 'rejected' | 'expired';

// ──────────────────────────────── 计划模式 ────────────────────────────────

/**
 * 计划模式：destructive 调用的事前审批门。
 *
 * 判定顺序不可颠倒：
 *   ① 开关关着 → 直通（默认口径，系统行为与没有这个模块完全一致）；
 *   ② 调用不是 destructive → 直通（计划模式管的是"做了就回不去"的动作）；
 *   ③ 已批准许可里有同一个指纹 → 直通**一次**（许可在 tool/call 落库时被 fold 消费）；
 *   ④ 待批队列里已有同一件调用 → 不重复落库，只把"还在等"这件事回给模型（人只该被问一次）；
 *   ⑤ 其余 → 落 `plan/pending` + `human/asked` 并拦下。
 */
export class PlanMode implements ToolPlanGate {
  private readonly options: PlanModeOptions;

  constructor(options: PlanModeOptions) {
    this.options = options;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS;
  }

  /**
   * 执行侧拦截点（tools/executor.ts 在写 `tool/call` **之前**调用）。
   * 返回非 null 表示这次调用没有执行，且拦截事实已经落库。
   */
  intercept(input: PlanGateCall): ToolPlanDenial | null {
    const decision = this.decide(input);
    if (decision === null) return null;
    return this.deny(input, decision);
  }

  /** 纯判定：返回 'gate'（首次拦截）/ 'already'（已在待批队列里）/ null（直通） */
  private decide(call: PlanGateCall): 'gate' | 'already' | null {
    if (!this.options.enabled) return null;
    if (call.sideEffect !== 'destructive') return null;

    const fingerprint = planFingerprint(call.tool, call.arguments);
    if (this.options.projection.planApproved.some(item => item.fingerprint === fingerprint)) return null;
    if (this.options.projection.planPending.some(item => this.fingerprintOf(item.tool, item.arguments) === fingerprint)) {
      return 'already';
    }
    return 'gate';
  }

  /** 落库并构造回给模型的文本。两阶段落库都不写：被拦的调用没有 tool/call，也没有 tool/result */
  private deny(call: PlanGateCall, decision: 'gate' | 'already'): ToolPlanDenial {
    if (decision === 'gate') {
      const context = planContext(call);
      this.options.emit('plan/pending', {
        callId: call.callId,
        tool: call.tool,
        arguments: call.arguments,
        turn: call.turn,
        step: call.step,
      }, defaultVisibility('plan/pending'));
      // 人审的挂起信号与计划簿记分两条写：前者承载「有人在等」（model 可见 → 渲染成 developer
      // 注入，也喂给前端卡片与告警），后者是簿记（internal）。少了前者，这一轮就不会挂起。
      // `source: 'system'` 显式写出来：它决定"这一条挂起 turn"（见 openHumanAsks 与 §6 的三种来源）。
      this.options.emit('human/asked', {
        question: PLAN_APPROVAL_QUESTION,
        context,
        turn: call.turn,
        source: 'system',
      }, defaultVisibility('human/asked'));
    }

    const head = decision === 'gate'
      ? `工具 ${call.tool} 的调用没有执行：计划模式把它挂起等人工批准了（已写 plan/pending 与 human/asked）。`
      : `工具 ${call.tool} 的同一件调用已经在待批准队列里，本次不再重复落库（人只该被问一次）。`;
    return {
      content: `${head}\n`
        + `本次调用不会写 tool/call 与 tool/result——它没有执行，写进两阶段落库就是伪造事实。\n`
        + '接下来：人批准（human/answered{answer:\'approve\'}）之后，按**同一份参数**重新发起一次这个调用，'
        + '它会直接执行；批准是一次性的，只放行这一次。'
        + '若人拒绝，答复里会给出理由，请据此改变做法而不是原样重发。',
      code: decision === 'gate' ? PLAN_PENDING_CODE : PLAN_ALREADY_PENDING_CODE,
      message: `计划模式拦截：${call.tool} 待人工批准`,
    };
  }

  /**
   * 结案（批准 / 拒绝 / 超时）。批准会把指纹写进投影的 planApproved——**一次执行许可**，
   * 它在下一次同指纹的 `tool/call` 落库时被消费掉（见 state/fold.ts）。
   */
  resolve(input: {
    callId: string;
    tool: string;
    arguments: string;
    outcome: PlanOutcome;
    by: string;
    note?: string;
  }): void {
    const data: Record<string, unknown> = {
      callId: input.callId,
      tool: input.tool,
      fingerprint: planFingerprint(input.tool, input.arguments),
      outcome: input.outcome,
      by: input.by,
    };
    if (input.note !== undefined && input.note !== '') data['note'] = input.note;
    this.options.emit('plan/resolved', data, defaultVisibility('plan/resolved'));
  }

  private fingerprintOf(tool: string, args: string): string {
    return planFingerprint(tool, args);
  }
}

// ──────────────────────────────── 人审挂起的时间线 ────────────────────────────────

/**
 * 一次人审挂起（计划待批准；v27 之前也可以是 `ask_human` 的提问）的完整线索。
 * `wakeSeqs/claimCounts/sources` 取自该 turn 的 `input/claimed`——答复到达后要按原样重入队。
 */
export interface Suspension {
  turn: number;
  /** 那条 `human/asked` 的 seq：答复按它配对（精确配对优先于 FIFO） */
  askSeq: number;
  /** human/asked 的时刻 */
  askedAt: string;
  question: string;
  wakeSeqs: number[];
  claimCounts: number[];
  sources: WakeSource[];
}

export interface SuspensionScan {
  /** 仍挂着等答复 */
  waiting: Suspension | null;
  /** 人已答复、但输入还没回到队列（real-loop 据此写 input/requeued） */
  answered: { suspension: Suspension; answer: string; at: string } | null;
}

// ──────────────────────────────── 台面上的提问（design §6） ────────────────────────────────

/** 台面上一条没答复的提问（投影 `humanAsks` 的事件侧同形） */
export interface OpenHumanAsk {
  /** 那条 `human/asked` 的 seq */
  seq: number;
  source: HumanAskSource;
  question: string;
  context: string;
  turn: number;
  at: string;
  /** `human/expired` 已落的时刻（人可能不在）；**不出队**——超时不是决定（§6.1） */
  expiredAt: string | null;
}

export interface AskWalkOptions {
  /**
   * 只看 seq **大于**它的事件（agent-loop 用它划"本 turn 起点之后"）。缺省看全部。
   *
   * 窗口外写下的提问不会凭空出现：它本来就没有被这一窗事件答复过——那正是调用方要的口径。
   */
  afterSeq?: number;
}

/**
 * 台面上还没答复的提问，**FIFO**（design §6.3：一次只一张，其余排队）。
 *
 * 出队只有一条路：`human/answered`。给了 `askSeq` 就精确出那一条；没给（旧事件与 CLI 的
 * 简写答复）退回队首——当时的唯一情形就是只有一条挂着。`human/expired` **只标记不出队**：
 * 超时不产生决定，人回来照样能答（§6.1）。
 *
 * 与 `scanSuspension` 的分工：这一份回答"台面上摆着哪几张卡"（含她问的），那一份回答
 * "哪个 turn 还挂着等人"（只认系统来源，因为只有它才挂起）。
 */
export function openHumanAsks(
  events: readonly AppEvent[],
  options: AskWalkOptions = {},
): OpenHumanAsk[] {
  const after = options.afterSeq ?? 0;
  const queue: OpenHumanAsk[] = [];
  for (const event of events) {
    if (event.seq <= after) continue;
    switch (event.type) {
      case 'human/asked':
        queue.push({
          seq: event.seq,
          source: humanAskSourceOf(event.data),
          question: event.data.question,
          context: event.data.context,
          turn: event.data.turn,
          at: event.ts,
          expiredAt: null,
        });
        break;
      case 'human/answered': {
        const index = event.data.askSeq === undefined
          ? 0
          : queue.findIndex(ask => ask.seq === event.data.askSeq);
        if (index >= 0 && index < queue.length) queue.splice(index, 1);
        break;
      }
      case 'human/expired': {
        const ask = queue.find(item => item.seq === event.data.askSeq);
        if (ask !== undefined) ask.expiredAt = event.ts;
        break;
      }
      default:
        break;
    }
  }
  return queue;
}

/** 台面上还没有答复的**她问的**提问（按 FIFO；界面只弹队首那一张） */
export function pendingAgentAsks(
  events: readonly AppEvent[],
  options: AskWalkOptions = {},
): OpenHumanAsk[] {
  return openHumanAsks(events, options).filter(ask => ask.source === 'agent');
}

/**
 * 本窗口里还留着「未答复的**计划审批**提问」吗——挂起 turn 的**唯一口径**（2026-10-21 收窄）。
 *
 * 为什么不再用"所有系统来源提问"：2026-10-21 起申请单的拾取会发生在 **turn 中途**
 * （`agent-loop` 的 `settleGrantsStep`）。那条 `human/asked{source:'system'}` 是"用户有空时
 * 看一眼"的待批卡，**不是**"她这一步停下来等人"的挂起——把它算成挂起，任何一个中途递单都会
 * 让正在跑的一轮在下一步就 `blocked` 收尾（现场读感："她明明还在干活，却突然停了"）。
 * ⇒ 挂起只认计划审批那一条（`PLAN_APPROVAL_QUESTION`）；申请单那张卡不挂起本 turn。
 *
 * ⚠ 与 `admitWake` 的分工没有变：那张卡仍然进投影的 `waitingHuman`（`fold` 按
 * `source:'system'` 算），**下一个 turn** 照旧会被"她在等人"那道门拦下（design §4.21）——
 * 收窄的只是"本 turn 会不会因此挂起"。
 *
 * 将来若出现第三个系统来源提问的写入方，必须在这里明确它算不算挂起（不许默认算）。
 */
export function hasPendingPlanAsk(
  events: readonly AppEvent[],
  options: AskWalkOptions = {},
): boolean {
  return openHumanAsks(events, options)
    .some(ask => ask.source !== 'agent' && ask.question === PLAN_APPROVAL_QUESTION);
}

/**
 * 从事件序列重建「当前的人审挂起」。
 *
 * 为什么需要重建：CLI 的 answer 走的是「先停主进程再写日志」的纪律（与 review resolve 同源：
 * 两个进程各自 nextSeq 必然撞号），所以答复常常是在实例停机期间写下的——重启后必须能从日志
 * 还原出「哪个 turn 挂着、它认领了哪些输入」，否则那些输入就永远回不了队列。
 *
 * 配对优先级：`human/answered.askSeq` 指出的是哪一条就配哪一条；没有它（旧事件/CLI 简写）按
 * **FIFO** 配（human/asked 入队、human/answered 出队）。不按 question 文本配对：同一批里可能
 * 有多件计划各自提问，而 question 是同一个界面常量（人的界面契约，不该为配对而变）。
 *
 * **只有系统来源的提问会挂起**（design §6.5）：她自己的提问（`source:'agent'`）不进这条队列，
 * 于是"她问了一句"与"这一轮停在这儿等人"是两件事——前者写事件、弹卡、继续做，后者才是挂起。
 *
 * 挂起的输入只认「`turn/end{blocked, by:'ask-human'}` 之前那一个 turn 的 input/claimed」——
 * 挂起 turn 之后再没有新 turn，所以队列里最多只有一条真正需要重入的线索。
 */
export function scanSuspension(events: readonly AppEvent[]): SuspensionScan {
  const bySeq = new Map<number, AppEvent>();
  for (const event of events) bySeq.set(event.seq, event);

  const claimed = new Map<number, { wakeSeqs: number[]; claimCounts: number[] }>();
  const queue: Suspension[] = [];
  let answered: SuspensionScan['answered'] = null;

  for (const event of events) {
    switch (event.type) {
      case 'input/claimed': {
        // 同一 turn 可以**分批**认领：turn 开头一笔，中途被她看见的插话各一笔
        // （agent-loop 的 claimInterruption）。所以这里是并集，不是覆盖——
        // 覆盖会漏掉本轮开头那些输入，答复到达后退回队列的就是一份残账：
        // 她重新开一轮时手里少了最初那条话，却以为自己接上了。
        const own = claimed.get(event.data.turn);
        if (own === undefined) {
          claimed.set(event.data.turn, {
            wakeSeqs: [...event.data.wakeSeqs],
            claimCounts: [...event.data.claimCounts],
          });
          break;
        }
        event.data.wakeSeqs.forEach((wakeSeq, i) => {
          if (own.wakeSeqs.includes(wakeSeq)) return;
          own.wakeSeqs.push(wakeSeq);
          own.claimCounts.push(event.data.claimCounts[i] ?? 0);
        });
        break;
      }
      case 'human/asked': {
        if (humanAskSourceOf(event.data) === 'agent') break; // 她的提问不挂起：不进这条队列
        const own = claimed.get(event.data.turn);
        queue.push({
          turn: event.data.turn,
          askSeq: event.seq,
          askedAt: event.ts,
          question: event.data.question,
          wakeSeqs: own?.wakeSeqs ?? [],
          claimCounts: own?.claimCounts ?? [],
          sources: (own?.wakeSeqs ?? []).map(seq => sourceOfWake(bySeq.get(seq))),
        });
        break;
      }
      case 'human/answered': {
        // **配对只认 askSeq 指出的那一条**（2026-10-22 修的真 bug）：过去的写法只允许
        // "答队首"——`askSeq` 指的不是队首就当没配上。而人完全可能**倒着答**：
        // 实测 2026-10-20 17:51 那一批两张单子（`add playwright` / `remove playwright`），
        // 人先批准后递的那张（202194），再批准先递的那张（202192）⇒ 前一条答复被当成
        // "与挂起无关"丢掉，202194 永远留在队列里。24 小时之后 `maybeTimeoutHuman` 就按它
        // 落了`budget/exhausted{layer:'task'}`，把整台机器停到第二天（现场 2026-10-21 17:51）。
        // 现在：给了 askSeq 就精确删那一条（与 fold 的 `human/answered` 同一条口径）。
        const index = event.data.askSeq === undefined
          ? (queue.length > 0 ? 0 : -1)
          : queue.findIndex(item => item.askSeq === event.data.askSeq);
        if (index < 0) break;
        const [answeredAsk] = queue.splice(index, 1);
        answered = { suspension: answeredAsk!, answer: event.data.answer, at: event.ts };
        break;
      }
      case 'input/requeued': {
        // 重入队即「这条挂起已经办完了」：本次挂起线索到此终结（一个输入只有一个当前状态）
        if (answered !== null) {
          const returned = new Set(event.data.wakeSeqs);
          if (answered.suspension.wakeSeqs.some(seq => returned.has(seq))) answered = null;
        }
        break;
      }
      case 'turn/end': {
        // 挂起的 turn 以 blocked 收尾（不是 completed，也不是 interrupted）：这里的线索才算数。
        // 其余 turn 结束方式意味着那次提问已经被落在后面的 turn 里办完了，没有任何输入要重入。
        if (!(event.data.reason.kind === 'blocked' && event.data.reason.by === ASK_HUMAN_BLOCKED_BY)) {
          const turn = event.data.turn;
          for (let i = queue.length - 1; i >= 0; i -= 1) {
            if (queue[i]!.turn === turn) queue.splice(i, 1);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return { waiting: queue[0] ?? null, answered };
}

// 这里从前还有一条 `pendingQuestion(events)`（= `scanSuspension(events).waiting?.question`），
// 注释写着"answer 通道用它填 human/answered.question"——**那句话不实**：答复通道填的是它自己
// 挑中的那一条的 `target.question`（见下面 `applyAnswer` 里的 human/answered），从来不经过它。
// 它全仓 0 引用，2026-10-06 随审计删掉（docs/repo-cleanliness-audit.md §2.2 A7），别再按旧说法加回来。

/** 挂起是否已超过时限。时钟由调用方注入（测试用假时钟），纯函数不读环境时间 */
export function humanTimeoutElapsed(askedAt: string, nowMs: number, timeoutMs: number): boolean {
  const at = Date.parse(askedAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at >= timeoutMs;
}

// ──────────────────────────────── 答复通道（CLI 与 Web 共用） ────────────────────────────────

export interface AnswerInput {
  /** 日志全量事件（proj/planPending 与挂起提问都从它来，绝不看别处） */
  events: readonly AppEvent[];
  /** 答复文本。恰好是 'approve' = 批准；'reject'/'deny'/'拒绝' 开头 = 拒绝 */
  answer: string;
  by: string;
  /** 指定结案哪条待批计划；省略时只在「有且仅有一条」时自动选中 */
  callId?: string;
  /** 指定答复哪一条提问（`human/asked` 的 seq；界面上的卡带着它）。省略时按下面的顺序挑 */
  askSeq?: number;
  now: Date;
  /**
   * 事件写入通道（调用方保证 `sync: true`）。返回新事件的 seq。
   * 两条事件的写入顺序是**先答复后结案**：就算第二步失败，日志里也留着「人答过」这个事实，
   * 计划仍在待批队列里等人再答一次——反过来先结案再写答复，失败时就会出现「批准了但没人答过」。
   */
  write: (type: string, data: unknown, visibility: Visibility) => number;
}

export type AnswerOutcome =
  | { ok: true; answerSeq: number; planResolvedSeq: number | null; planCallId: string | null; planOutcome: PlanOutcome | null }
  | { ok: false; code: 2 | 3; error: string };

/** 答复意图：批准 / 拒绝 / 普通回答（普通回答不改计划状态） */
export function answerIntentOf(answer: string): 'approve' | 'reject' | 'plain' {
  const text = answer.trim();
  if (text.toLowerCase() === APPROVE_ANSWER) return 'approve';
  const lower = text.toLowerCase();
  return REJECT_PREFIXES.some(prefix => lower.startsWith(prefix)) ? 'reject' : 'plain';
}

/**
 * 答复人审：写 `human/answered`，并在答复是批准/拒绝时给待批计划写 `plan/resolved`。
 * CLI（`irmia answer`）与 Web（`POST /api/commands/answer`）共用这一份实现——
 * 两处各写一套必然漂移，而「批准了什么」是最不能漂移的一类事实。
 *
 * 答复对象按三级挑（§6 之后台面上同时可能摆着她问的卡与一条待批准的计划）：
 *   ① 显式 `askSeq`（界面上的卡带着它）——它必须还在台面上，否则如实报错，不猜；
 *   ② 挂起中的系统提问（含"已答复但输入还没回队列"那一次，允许重申）；
 *   ③ 最早一条**她问的**提问——CLI 里打一句答复就是答它（人手上没有 seq 时最自然的那条路）。
 */
export function answerHuman(input: AnswerInput): AnswerOutcome {
  const scan = scanSuspension(input.events);
  const open = openHumanAsks(input.events);
  // 仍在等答复的那次提问，或已答复但输入还没回队列的那次——两者都是合法的配对对象
  const hanging = scan.waiting ?? scan.answered?.suspension ?? null;

  let target: { askSeq: number; question: string; source: HumanAskSource } | null = null;
  if (input.askSeq !== undefined) {
    const found = open.find(ask => ask.seq === input.askSeq);
    if (found !== undefined) target = { askSeq: found.seq, question: found.question, source: found.source };
    else if (hanging !== null && hanging.askSeq === input.askSeq) {
      target = { askSeq: hanging.askSeq, question: hanging.question, source: 'system' };
    } else {
      return {
        ok: false,
        code: 2,
        error: `askSeq=${input.askSeq} 不在台面上（那条提问可能已经被答复）：`
          + '先跑 irmia status 或看 GET /api/projection 的 humanAsks 核对',
      };
    }
  } else if (hanging !== null) {
    target = { askSeq: hanging.askSeq, question: hanging.question, source: 'system' };
  } else if (open[0] !== undefined) {
    target = { askSeq: open[0].seq, question: open[0].question, source: open[0].source };
  }

  if (target === null) {
    return {
      ok: false,
      code: 2,
      error: '当前没有要答复的对象（没有未被答复的 human/asked）：她没在问、也没有待批准的计划。'
        + '先跑 irmia status 或看 GET /api/projection 的 humanAsks 核对',
    };
  }

  const pending = pendingPlans(input.events);
  const intent = answerIntentOf(input.answer);

  let planCallId: string | null = null;
  let planTool: string | null = null;
  let planArguments = '';
  let planOutcome: PlanOutcome | null = null;

  // 计划结案只在她答的是**系统提问**时才谈得上：`approve` 打在她问的卡的答复框里，
  // 那是"回答她的问题"，不是"批准一件破坏性调用"（把两者混起来就是替人批了一件他没看过的调用）
  if (intent !== 'plain' && target.source !== 'agent') {
    if (pending.length === 0) {
      // 没有待批计划时，approve/reject 只是一句普通回答：人可以用它回答挂起中的提问
      planOutcome = null;
    } else {
      const chosen = input.callId === undefined || input.callId === ''
        ? (pending.length === 1 ? pending[0]! : null)
        : pending.find(item => item.callId === input.callId) ?? null;
      if (chosen === null) {
        return {
          ok: false,
          code: 2,
          error: input.callId === undefined || input.callId === ''
            ? `当前有 ${pending.length} 条待批计划，无法判定批准的是哪一条：请用 --callId 指定（`
              + `${pending.map(item => item.callId).join('、')}）`
            : `callId=${input.callId} 不在待批计划里（可能已结案）；先跑 irmia review list 核对`,
        };
      }
      planCallId = chosen.callId;
      planTool = chosen.tool;
      planArguments = chosen.arguments;
      planOutcome = intent === 'approve' ? 'approved' : 'rejected';
    }
  }

  const answerSeq = input.write('human/answered', {
    question: target.question,
    answer: input.answer,
    by: input.by,
    // 精确配对：台面上可能同时摆着她的提问与待批准的计划，FIFO 会把"人答的那条"认成另一条
    askSeq: target.askSeq,
  }, defaultVisibility('human/answered'));

  let planResolvedSeq: number | null = null;
  if (planOutcome !== null && planCallId !== null && planTool !== null) {
    planResolvedSeq = input.write('plan/resolved', {
      callId: planCallId,
      tool: planTool,
      fingerprint: planFingerprint(planTool, planArguments),
      outcome: planOutcome,
      by: input.by,
    }, defaultVisibility('plan/resolved'));
  }

  return { ok: true, answerSeq, planResolvedSeq, planCallId, planOutcome };
}

/**
 * 待批准的调用（从事件折叠出来；不读调用方的投影——CLI 与 Web 各自的投影可能是缓存或快照，
 * 而「批准哪一条」必须只认日志）。
 */
export function pendingPlans(
  events: readonly AppEvent[],
): Array<{ callId: string; tool: string; arguments: string; turn: number; step: number }> {
  const out: Array<{ callId: string; tool: string; arguments: string; turn: number; step: number }> = [];
  for (const event of events) {
    if (event.type === 'plan/pending') {
      out.push({
        callId: event.data.callId,
        tool: event.data.tool,
        arguments: event.data.arguments,
        turn: event.data.turn,
        step: event.data.step,
      });
      continue;
    }
    if (event.type !== 'plan/resolved') continue;
    const index = out.findIndex(item => item.callId === event.data.callId);
    if (index >= 0) out.splice(index, 1);
  }
  return out;
}

// ──────────────────────────────── 内部 ────────────────────────────────

/** 建人审卡片/告警用的调用详情。人（与模型）看到的就是这一段文本 */
function planContext(call: PlanGateCall): string {
  return [
    `工具：${call.tool}（副作用 ${call.sideEffect}，turn ${call.turn} / step ${call.step}，callId ${call.callId}）`,
    `参数：${clip(call.arguments, 800)}`,
    '批准：答复 approve（CLI `irmia answer approve`，Web 卡片上的批准按钮）——批准只放行这一次调用。',
    '拒绝：答复以 reject 开头并给出理由（例：`reject：这个路径我不确认`），她会据此改变做法。',
    `超过 ${Math.round(DEFAULT_HUMAN_TIMEOUT_MS / 3_600_000)} 小时无人答复：任务层按预算耗尽同等语义暂停，可恢复。`,
  ].join('\n');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** wake 事件的来源；不是 wake 事件（或已找不到）时按 manual 兜底（与 fold 同一口径） */
function sourceOfWake(event: AppEvent | undefined): WakeSource {
  if (event === undefined) return 'manual';
  return wakeSourceOf(event.type);
}
