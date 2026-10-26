/**
 * Irmia Agent — 状态折叠
 * 与 docs/schema.md §8 对齐。两条铁律：
 * 1. 纯函数：不读时钟、不读文件、不发请求。同一份事件序列永远折叠出同样的投影。
 *    时间一律取自事件自身携带的 ts（日志内时间），不取环境时钟。
 * 2. 全量与增量一致：fold(全部事件) 必须等于逐条 applyOne 的累积结果。
 */
import type {
  AppEvent, Projection, TimerEntry, WakeSource,
} from '../log/types.js';
// 值导入必须带 .ts：Node 的 --experimental-strip-types 只擦类型、不改写路径解析，
// 写 .js 会 ERR_MODULE_NOT_FOUND（tsc 输出时由 rewriteRelativeImportExtensions 改回 .js）。
import { emptyProjection, humanAskSourceOf, planFingerprint, BUDGET_ACCOUNTING_VERSION } from '../log/types.ts';

/**
 * 预算口径版本——转出去给恢复层（`state/projection-cache.ts` / `state/snapshot.ts`）用：
 * 它校验派生状态里的 `budget.budgetVersion` 与这一份是否相等，不等则整份丢弃、从事件重放。
 *
 * 定义在 `log/types.ts`（投影形状的家），这里只是转出 + 盖章，不另立一份编号。
 */
export { BUDGET_ACCOUNTING_VERSION };

const DEDUPE_WINDOW = 1000;
/** 距上次发言超过此时长（毫秒）计入压力 */
const QUIET_PRESSURE_AFTER_MS = 2 * 60 * 60 * 1000;

/** 全量折叠：从空投影开始应用整个事件序列 */
export function fold(events: Iterable<AppEvent>): Projection {
  const p = emptyProjection();
  for (const e of events) applyEvent(p, e);
  finalizePressure(p);
  return p;
}

/**
 * 按事件归属分派折叠（design §4.21）：顶层事件折本层状态机，子代理链事件只折父层记账。
 *
 * **所有「从日志重建投影」的路径都必须走它**（fold / recover 的流式折叠 / 恢复期补偿写入），
 * 否则「内存投影 = 日志折叠结果」这条铁律会在子代理链上失效——运行期与重建期对同一份日志
 * 算出两个不同的投影，而那正是最查不出来的那类错误。
 *
 * 注意它看的是 `parentCallId`，与「谁在写」无关：子代理自己的隔离投影应当调用 `applyOne`
 * （对它而言本层就是那条链）。
 */
export function applyEvent(p: Projection, e: AppEvent): void {
  if (e.parentCallId !== undefined) applySubagentEvent(p, e);
  else applyOne(p, e);
}

/**
 * 子代理链事件（`parentCallId` 非空）在**父层**投影里的折叠：只认父层必须看见的记账。
 *
 * 两条口径：
 *   - **折**：预算消耗（子代理从父任务额度扣减，§4.21 隔离三件套之二）与刹车留痕——
 *     父的 `checkBeforeStep`、`admitWake` 读的就是它们，缺了就等于子代理在父的账外烧钱；
 *   - **不折**：turn / message / tool 链一律不进本层状态机。子代理的 `turn/start` 若折进来，
 *     父的 `openTurn` 会被顶成子代理的 turn（父的 turn 就永远闭合不了、恢复期还会拿子代理的
 *     认领列表去退输入）；子代理的 `tool/call` 若折进来，父的 `openTools` 会混进一批它没发起过
 *     的悬空调用。
 */
export function applySubagentEvent(p: Projection, e: AppEvent): void {
  if (e.seq > p.lastSeq) p.lastSeq = e.seq;
  if (p.firstEventAt === null) p.firstEventAt = e.ts;

  switch (e.type) {
    case 'budget/consumed':
      applyBudgetConsumed(p, e);
      break;
    case 'budget/exhausted':
      applyBudgetExhausted(p, e);
      break;
    case 'budget/topped-up':
    case 'budget/resumed':
      delete p.lastExhausted[e.data.layer];
      // 解除 task 层暂停 = 那次任务结束 ⇒ 单任务累计归零（见 applyTaskBoundary 的说明）
      applyTaskBoundary(p, e.data.layer);
      break;
    default:
      break; // 归属别的 turn 链，父层无从得知也不需要知道
  }
}

/**
 * **预算口径：只算没命中缓存的那部分**（2026-10-05 用户换的口径）——**唯一一处定义**。
 *
 * 用户原话（逐字抄，这一批的根据）：
 *
 *   > 「另外单日预算改成只算不命中缓存的部分吧。单日非缓存预算 2M，妥善改完，不要不协调。」
 *
 * **为什么换**：心跳改成"真实唤醒"之后，每 5~15 分钟一次 heavy、每次约 4.5 万 input，
 * 而其中**约 97% 是缓存命中**（每一拍刻意共用同一份冻结前缀去保温供方的前缀缓存，
 * 见 docs/design.md §4.12）。旧口径把命中那 97% 也算进预算 ⇒ 计数器飞快见顶、
 * "预算耗尽"天天响，而**真实花销很小**。新口径只盯"真花钱的那部分"。
 *
 * **定义**（`budget.dailyTokens` / `budget.taskTokens` / 投影里的三个累计量 / 所有读数都走这一条）：
 *
 *     计入预算的 token = (inputTokens − cacheHitTokens) + outputTokens
 *
 * 也就是"**输入里没命中缓存的那部分 + 输出**"。两条边界要写清：
 *   · **输出一律计入**：输出没有缓存一说，每一次都按全价计（它本来就是"新生成的那部分"）。
 *   · **只此两项，不含别的**。理由逐条：供方返回的 reasoning / 思维链 token 已经并进
 *     `outputTokens`（本仓库没有第三个计数通道，`DsUsage` 只有 input/output/cached 三个数）；
 *     上下文压缩、记忆整理这些**内部调用**各自是一条 `budget/consumed`（一步一条），
 *     天然按同一口径计入，不需要另设一项；重试失败的调用写的是全 0（`agent-loop.failStep`），
 *     加不加都不改变结果。
 *
 * **它读的是 `inputTokens − cacheHitTokens`，不是事件自带的 `cacheMissTokens`**：
 * 事件是外部输入（手写日志、旧日志都可能自相矛盾——`cacheMissTokens ≠ input − cacheHit`），
 * 判据必须由一个不依赖"别人写对没有"的算式给出。`cacheMissTokens` 照旧折进
 * `cacheMissToday`（它是**记录**，喂"缓存命中率"那条观测），不参与预算判定。
 *
 * **不许在别处再写一遍这个算式**：`runtime/doctor.ts` 的 I7 自检、`web/server.ts` 的
 * 趋势线/按天分桶都引这一个函数（两处各写一遍 = 前一天那个"两套数"的 bug 原样复发）。
 */
export function budgetTokensOf(d: {
  inputTokens: number;
  cacheHitTokens: number;
  outputTokens: number;
}): number {
  const input = Number.isFinite(d.inputTokens) ? Math.max(0, d.inputTokens) : 0;
  const hit = Number.isFinite(d.cacheHitTokens) ? Math.max(0, d.cacheHitTokens) : 0;
  const output = Number.isFinite(d.outputTokens) ? Math.max(0, d.outputTokens) : 0;
  // 命中数不许超过输入数（坏日志里出现过）：夹一下，宁可算 0 也不许算出负数把预算倒着走
  return Math.max(0, input - Math.min(hit, input)) + output;
}

/** `budget/consumed` 的折叠：本层与子代理链共用同一份（两处各写一遍必然口径漂移） */
function applyBudgetConsumed(p: Projection, e: AppEvent & { type: 'budget/consumed' }): void {
  const d = e.data;
  // 四层统一走同一个口径（§4.6）：step/turn 数的是次数，task/daily 数的是这个数
  const total = budgetTokensOf(d);
  if (d.lane === 'heavy') p.budget.tokensTodayHeavy += total;
  else p.budget.tokensTodayLight += total;
  p.budget.tokensToday += total;
  p.budget.cacheHitToday += d.cacheHitTokens;
  p.budget.cacheMissToday += d.cacheMissTokens;
  p.budget.tokensTask += total;
  // 累计量与它的口径标签同源：每一次累加都把版本盖回当前值（见 Projection.budget.budgetVersion）。
  // 从旧快照续算时这一行保证"这份累计是按哪一版折的"永远写的是**当前**这一版——
  // 而恢复层在采信快照之前已经校验过版本，所以这里不会有"半旧半新"的累计被贴上 v2 标签。
  p.budget.budgetVersion = BUDGET_ACCOUNTING_VERSION;
  if (d.finishReason === 'failed') {
    p.failStreak += 1;
  } else {
    p.failStreak = 0;
    p.lastModelSuccessAt = e.ts;
  }
}

/**
 * 「任务」这一层的边界：**task 层暂停被解除 = 那次任务结束 ⇒ `tokensTask` 归零**。
 *
 * 为什么必须有这条（2026-10-05 实测的第二处缺陷）：`tokensTask` 原来**只累加、永不归零**
 * （`docs/review.md` 的「单任务没有边界」一早就记着这条），于是它数的是"这个进程从第一天到
 * 今天一共花了多少"，而不是"这次任务花了多少"。旧口径下它涨得慢、撞线之后靠人工加注续命；
 * 换成非缓存口径也救不了它——现场全量重放出来是 13,443,843，而单任务额度是 5,000,000
 * ⇒ **就算把旧快照全部丢掉、账重算一遍，下一次 turn 照样被立刻拒掉**。
 *
 * 为什么边界取"暂停解除"而不是别的：
 *   · 它是系统里**唯一一个已经存在**的"这次任务到此为止"的事实。撞 task 线即暂停（写
 *     `budget/exhausted{layer:'task'}`），解除只有两条路——人工加注（`budget/topped-up{layer:'task'}`）
 *     或上限被调大（`budget/resumed{layer:'task'}`）。两条都意味着"上一段工作已经交代收尾、
 *     现在开始新的一段"，所以归零点就在那里，判据不需要新造一个事件、也不需要读时钟。
 *   · 「空闲即新任务」那条路**刻意不做**：空闲是渲染层看不到的事实（`lastModelSuccessAt` 只
 *     说明"多久没成功调用"），拿它当任务边界等于让一个观测值去改账，重启一次就可能变一套数。
 *   · `tokensToday` **不跟着归零**：日额度是主力刹车（`dailyTokens` 那一层），
 *     "新任务"不该免掉今天的账。归零只发生在一个任务真的被结清的那一刻。
 *
 * 两条路都走这一个函数：本层（`applyOne`）与子代理链（`applySubagentEvent`）共用同一份——
 * 子代理的消耗折进父层的同一个 `tokensTask`，边界自然也该是同一个（两处各写一遍必然漂移）。
 */
function applyTaskBoundary(p: Projection, layer: string): void {
  if (layer !== 'task') return;
  p.budget.tokensTask = 0;
  p.budget.budgetVersion = BUDGET_ACCOUNTING_VERSION;
}

/**
 * `budget/exhausted` 的折叠：按层记档（同层以最新一次为准），本层与子代理链共用同一份。
 *
 * 这里**只记事实**（谁在哪一刻撞了哪一层的线、当时的两个数），不作判定：暂停该不该解除由
 * `BudgetGuard.liftedPauses`（看活的上限与已用）判定、由运行时落 `budget/resumed` 落定。
 * 投影里留一条记录 = "这一层此刻是暂停的"，所以解除必须是**事件**（见 BudgetResumed 的说明）。
 *
 * `resumable: false` 是唯一会被折进投影的一位（正常路径不写，见 Projection.lastExhausted）：
 * 它是"别拿抬上限的规则来解这条"的凭据，而日志是外部输入（手写/旧日志），不能假定它不会出现。
 */
function applyBudgetExhausted(p: Projection, e: AppEvent & { type: 'budget/exhausted' }): void {
  p.lastExhausted[e.data.layer] = {
    at: e.ts,
    limit: e.data.limit,
    actual: e.data.actual,
    ...(resumableOf(e.data) ? {} : { resumable: false as const }),
  };
}

/** `budget/exhausted.resumable` 的判读：缺省 = 可恢复（schema 上它是字面量 true，这里按外部输入读） */
function resumableOf(data: unknown): boolean {
  return (data as { resumable?: unknown } | null | undefined)?.resumable !== false;
}

/** 增量折叠：运行期把单条新事件应用进既有投影（原地修改） */
export function applyOne(p: Projection, e: AppEvent): void {
  if (e.seq > p.lastSeq) p.lastSeq = e.seq;
  if (p.firstEventAt === null) p.firstEventAt = e.ts;

  switch (e.type) {
    case 'turn/start':
      p.openTurn = { turn: e.data.turn, step: 0 };
      // 单轮步数与单步工具数随新 turn 归零（§4.6 单 turn / 单 step 两层刹车）。
      // 归零不破坏跨重启累计：重启后重放日志，同样的 turn/start 同样把计数压回 0。
      p.budget.stepsThisTurn = 0;
      p.budget.toolCallsThisStep = 0;
      break;
    case 'turn/end': {
      const { turn } = e.data;
      if (p.openTurn?.turn === turn) p.openTurn = null;
      delete p.claimedByTurn[turn];
      break;
    }
    case 'step/start':
      if (p.openTurn && p.openTurn.turn === e.data.turn) p.openTurn.step = e.data.step;
      // 步号即「本 turn 已开始的步数」。无条件赋值：投影若从快照中途开始（没有 turn/start），
      // 刹车也不能因此失效——宁可多算一步，不可少算一步。
      p.budget.stepsThisTurn = e.data.step;
      p.budget.toolCallsThisStep = 0;
      break;

    case 'message/assistant': {
      const text = e.data.text;
      if (text) p.lastAssistantText = text.slice(0, 80);
      p.lastAssistantAt = e.ts;
      p.idleTicks = 0;
      break;
    }
    case 'message/user':
      p.idleTicks = 0;
      break;

    case 'tool/call':
      p.openTools.push({
        callId: e.data.callId, name: e.data.name,
        sideEffect: e.data.sideEffect, callSeq: e.seq,
      });
      // 本步工具调用计数：超限判定（§4.6 单 step 层）与 over-limit 截断都读它
      p.budget.toolCallsThisStep += 1;
      // 计划模式的批准是**一次**执行许可（design §4.21）：同一个指纹的调用真的落进 tool/call
      // 就算消费掉了。不消费就等于把「批准这一件」错记成「以后这类都放行」
      p.planApproved = p.planApproved.filter(
        item => item.fingerprint !== planFingerprint(e.data.name, e.data.arguments),
      );
      break;
    case 'tool/result': {
      p.openTools = p.openTools.filter(t => t.callId !== e.data.callId);
      if (e.data.status === 'unknown') {
        p.needsReview.push({ callId: e.data.callId, name: '', at: e.ts });
      }
      break;
    }

    case 'wake/timer': case 'wake/file': case 'wake/webhook':
    case 'wake/manual': case 'wake/intention': case 'wake/job':
    case 'wake/heartbeat': case 'wake/channel': {
      const key = 'dedupeKey' in e.data ? e.data.dedupeKey : undefined;
      if (key && p.dedupeKeys.includes(key)) break; // 重复幂等键：丢弃
      if (key) pushDedupeKey(p, key);
      p.pending.push({
        wakeSeq: e.seq,
        source: wakeSourceOf(e.type),
        claimCount: 0,
        ...(key ? { dedupeKey: key } : {}),
      });
      p.lastWake = { source: wakeSourceOf(e.type), at: e.ts };
      // 心跳自带空拍数（连续无外部事件的拍数，**仅供诊断**：节律已改由概率模型决定，它不再参与排期）；其余唤醒复位空拍
      p.idleTicks = e.type === 'wake/heartbeat' ? e.data.idleTicks : 0;
      break;
    }

    case 'input/claimed': {
      const { turn, wakeSeqs } = e.data;
      const claimed = new Set(wakeSeqs);
      p.pending = p.pending.filter(x => !claimed.has(x.wakeSeq));
      // **并集，不是覆盖**（2026-10-02）：同一轮可以**分批认领**——turn 进行中被打断时，
      // 那条"已经送到她眼前"的唤醒也要记进这一轮的账，否则它留在 pending 里，
      // 下一轮会被再认领一次，她就得把同一个问题再答一遍（docs/review.md 的「未了结」）。
      // 这份账同时是"turn 异常中断时据以退回输入"的依据，所以覆盖**有害**：
      // 抹掉前半批 = 她真正消化过的输入在恢复时消失（crash-injection.test.ts 正盯着这件事）。
      const already = p.claimedByTurn[turn];
      p.claimedByTurn[turn] = already === undefined || already.length === 0
        ? wakeSeqs
        : [...new Set([...already, ...wakeSeqs])];
      break;
    }
    case 'input/requeued': {
      e.data.wakeSeqs.forEach((wakeSeq, i) => {
        p.pending.push({
          wakeSeq,
          source: e.data.sources[i] ?? 'manual',
          claimCount: e.data.claimCounts[i] ?? 1,
        });
      });
      // 重新入队即"回到队列里"，它同时不可能还算死信（一个输入只有一个当前状态）。
      // 死信的历史不被抹掉——那是日志里 input/dead-letter 事件的职责，投影只回答"现在是什么"。
      const returned = new Set(e.data.wakeSeqs);
      p.deadLetters = p.deadLetters.filter(item => !returned.has(item.inputSeq));
      break;
    }
    case 'input/dead-letter': {
      p.pending = p.pending.filter(x => x.wakeSeq !== e.data.inputSeq);
      p.deadLetters.push({
        inputSeq: e.data.inputSeq, claimCount: e.data.claimCount, at: e.ts,
      });
      break;
    }
    case 'input/discarded': {
      // 人决定不再重投 = 这条死信**已处理**，它离开队列（投影只回答"现在是什么"）。
      // 日志里那条 `input/dead-letter` 一个字都不动——"它曾经是死信、被认领过几次"
      // 是已经发生过的事实，抹掉它才是篡改（见 log/types.ts 的 InputDiscarded 说明）。
      p.deadLetters = p.deadLetters.filter(item => item.inputSeq !== e.data.inputSeq);
      break;
    }

    case 'timer/set': {
      const entry: TimerEntry = {
        timerId: e.data.timerId,
        ...(e.data.at !== undefined ? { at: e.data.at } : {}),
        ...(e.data.cron !== undefined ? { cron: e.data.cron } : {}),
        payload: e.data.payload,
      };
      p.timers = [...p.timers.filter(t => t.timerId !== entry.timerId), entry];
      break;
    }
    case 'timer/cancelled':
      p.timers = p.timers.filter(t => t.timerId !== e.data.timerId);
      break;
    case 'timer/fired': {
      const fired = p.timers.find(t => t.timerId === e.data.timerId);
      if (fired && fired.cron === undefined) {
        p.timers = p.timers.filter(t => t.timerId !== e.data.timerId);
      }
      break;
    }

    case 'budget/consumed': {
      applyBudgetConsumed(p, e);
      break;
    }
    case 'budget/rollover':
      // 记账日期要留下：运行时靠它判断"今天记过没有"。只信进程内存的话，
      // 每次重启都会再写一条 rollover，把当日计数清零一次（见 BudgetState.date 的说明）
      p.budget.date = e.data.date;
      p.budget.tokensToday = 0;
      p.budget.tokensTodayHeavy = 0;
      p.budget.tokensTodayLight = 0;
      p.budget.cacheHitToday = 0;
      p.budget.cacheMissToday = 0;
      // 跨天不清 tokensTask：任务边界是"暂停解除"，不是"换了一天"（见 applyTaskBoundary）
      break;
    case 'budget/exhausted':
      applyBudgetExhausted(p, e);
      break;
    case 'budget/topped-up':
    case 'budget/resumed':
      delete p.lastExhausted[e.data.layer];
      // 解除 task 层暂停 = 那次任务结束 ⇒ 单任务累计归零（见 applyTaskBoundary 的说明）。
      // 两条路（本层 / 子代理链）共用同一个归零点，否则父子对"这次任务花了多少"会有两套数。
      applyTaskBoundary(p, e.data.layer);
      break;

    case 'model/degraded':
      p.degraded = { lane: e.data.lane, since: e.ts, reason: e.data.reason };
      break;
    case 'model/restored':
      if (p.degraded?.lane === e.data.lane) p.degraded = null;
      break;

    case 'review/resolved':
      p.needsReview = p.needsReview.filter(r => r.callId !== e.data.callId);
      break;

    case 'intention/raised':
      p.intentions = [
        ...p.intentions.filter(x => x.intentionId !== e.data.intentionId),
        {
          intentionId: e.data.intentionId,
          content: e.data.content,
          ...(e.data.triggerAt !== undefined ? { triggerAt: e.data.triggerAt } : {}),
          ...(e.data.condition !== undefined ? { condition: e.data.condition } : {}),
        },
      ];
      break;
    case 'intention/acted':
      p.intentions = p.intentions.filter(x => x.intentionId !== e.data.intentionId);
      break;

    case 'todo/updated':
      p.todoList = e.data.items.map(i => ({ ...i }));
      break;

    case 'job/started':
      p.jobs[e.data.jobId] = { command: e.data.command, turn: e.data.turn, startedAt: e.ts };
      break;
    case 'job/finished':
      delete p.jobs[e.data.jobId];
      break;

    case 'human/asked': {
      const source = humanAskSourceOf(e.data);
      p.humanAsks.push({
        seq: e.seq,
        source,
        question: e.data.question,
        context: e.data.context,
        turn: e.data.turn,
        at: e.ts,
        expiredAt: null,
      });
      // `waitingHuman` 是**挂起**语义（design §4.21）：只认系统来源。她自己的提问不挂起（§6.5），
      // 若把它也算进去，必要性门会拿它当"她在等人"而拦住后续输入——等于把"等"从后门放回来。
      syncWaitingHuman(p);
      break;
    }
    case 'human/answered': {
      // 精确配对优先（askSeq），旧事件/CLI 不带它时退回 FIFO——当时的唯一情形就是只有一条挂着
      const index = e.data.askSeq === undefined
        ? 0
        : p.humanAsks.findIndex(ask => ask.seq === e.data.askSeq);
      if (index >= 0 && index < p.humanAsks.length) p.humanAsks.splice(index, 1);
      syncWaitingHuman(p);
      p.idleTicks = 0;
      break;
    }
    case 'human/expired': {
      // 超时**不出队**：它只把"人可能不在"这件事记下来（design §6.1），提问本身仍然有效
      const ask = p.humanAsks.find(item => item.seq === e.data.askSeq);
      if (ask !== undefined) ask.expiredAt = e.ts;
      break;
    }
    case 'human/timed-out': {
      // **处置：作废那条待答**（2026-10-22）。它与 `human/expired` 分工不同——那条记"时间到了"
      // 且卡仍然有效；这条记"框架把这件事结掉了"：提问出队，`waitingHuman` 随之重算，
      // 于是投影里不再有"还有人在等"的残留（她已经被放回去干活了）。
      // 出队之后投影里查不到这条提问 ⇒ 之后人再补答（human/answered{askSeq}）就是一次空配对，
      // 不会把一件已经作废的计划批出去（§6.1：超时不是决定，但它也绝不能被事后当成批准）。
      const index = p.humanAsks.findIndex(item => item.seq === e.data.askSeq);
      if (index >= 0) p.humanAsks.splice(index, 1);
      syncWaitingHuman(p);
      break;
    }

    case 'plan/pending':
      p.planPending.push({
        callId: e.data.callId, tool: e.data.tool, arguments: e.data.arguments,
        turn: e.data.turn, step: e.data.step, at: e.ts,
      });
      break;
    case 'plan/resolved':
      p.planPending = p.planPending.filter(item => item.callId !== e.data.callId);
      if (e.data.outcome === 'approved') {
        p.planApproved.push({
          fingerprint: e.data.fingerprint, tool: e.data.tool, callId: e.data.callId, at: e.ts,
        });
      }
      break;

    case 'snapshot/checkpoint':
      p.lastArchiveAt = e.ts;
      break;

    default:
      // 其余事件（session/*、log/repaired、instance/takeover、policy/denied、
      // config/changed、mcp/*、skill/*（含 v79 的 skill/seed：出厂技能首次复制进数据目录，
      // 纯装配账，投影里没有它的位置）、hook/*、speak/*、tool/zombie、
      // developer/message、step/end、alarm/sent、compaction/summary、persona/updated、
      // image/trace——图片通道的留痕，纯观测，投影里没有它的位置）
      // 不进投影。新增事件类型在此显式落进 default 是有意为之——不允许静默吞掉。
      break;
  }
}

/** 唤醒事件类型 → 来源。web/api（重新入队）与 CLI 都读这一份口径，绝不另写一套 */
export function wakeSourceOf(type: string): WakeSource {
  switch (type) {
    case 'wake/timer': return 'timer';
    case 'wake/file': return 'file';
    case 'wake/webhook': return 'webhook';
    case 'wake/manual': return 'manual';
    // 心跳有自己的来源值：压力结算要靠它把心跳 pending 与真实挂起输入区分开
    case 'wake/heartbeat': return 'heartbeat';
    case 'wake/intention': return 'intention';
    case 'wake/job': return 'job';
    default: return 'manual';
  }
}

/**
 * `waitingHuman` 是**挂起语义**的派生视图：最后一条还没答复的**系统来源**提问。
 *
 * 为什么从队列里重算而不是逐事件赋值：一次答复可能落在另一条提问上（人答的是她问的那条），
 * 那时"挂起还在不在"取决于队列里还剩什么，而不是"刚刚有没有人答过话"。
 * 为什么取最后一条而不是队首：它原来的写法就是"每来一条 human/asked 覆盖一次"，而系统来源
 * 同时只可能有一条真正挂着（计划模式一次拦一件调用），两种取法在真实数据上等价。
 */
function syncWaitingHuman(p: Projection): void {
  for (let i = p.humanAsks.length - 1; i >= 0; i -= 1) {
    const ask = p.humanAsks[i]!;
    if (ask.source !== 'agent') {
      p.waitingHuman = { question: ask.question, turn: ask.turn, at: ask.at };
      return;
    }
  }
  p.waitingHuman = null;
}

function pushDedupeKey(p: Projection, key: string): void {
  p.dedupeKeys.push(key);
  if (p.dedupeKeys.length > DEDUPE_WINDOW) {
    p.dedupeKeys.splice(0, p.dedupeKeys.length - DEDUPE_WINDOW);
  }
}

/**
 * 压力结算（fold 末尾调用一次）。时间一律取日志内参照时刻（最后发言/唤醒/成功调用），
 * 不读环境时钟。底噪 0.05，四路加权，封顶 1。
 * 增量路径下逐条重算不划算，调用方应在批次结束处调用本函数并给出参照时刻（通常是刚写入事件的 ts）。
 */
export function finalizePressure(p: Projection, referenceTs?: string): void {
  const ref = Date.parse(
    referenceTs ?? p.lastWake?.at ?? p.lastModelSuccessAt ?? p.lastAssistantAt ?? p.firstEventAt ?? '',
  ) || 0;
  let pressure = 0.05;
  if (p.needsReview.length > 0) pressure += 0.3;
  // pending 只统计"非心跳"的挂起输入：心跳拍本身就是她自己的呼吸，把它也算成
  // "有输入没回应"会让空转时压力虚高。压力不参与心跳节律（概率模型只看安静时长），
  // 它服务的是必要性门与诊断——压力该由真正欠着的事驱动
  if (p.pending.some(item => item.source !== 'heartbeat')) pressure += 0.2;
  const dueIntentions = p.intentions.filter(
    i => i.triggerAt !== undefined && Date.parse(i.triggerAt) <= ref,
  ).length;
  if (dueIntentions > 0) pressure += 0.25;
  if (p.lastAssistantAt !== null && ref - Date.parse(p.lastAssistantAt) > QUIET_PRESSURE_AFTER_MS) {
    pressure += 0.2;
  }
  p.pressure = Math.min(1, pressure);
}
