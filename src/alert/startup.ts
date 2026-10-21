/**
 * Irmia Agent — 启动异常退出告警（docs/design.md §4.9 触发点清单首条、docs/milestones.md M4 交付物 5）
 * 与**启动时补写"已恢复"**（2026-10-05，见下半篇）。
 *
 * 判据只有一个：**恢复流程的补偿清单里出现了「上一次运行异常退出」**。
 * 这条事实由 runtime/recover.ts 第四步（settleOpenTurn）产生——它发现上一个进程留下未闭合的
 * turn 时补写 `turn/end{interrupted}`，并把这句事实记进 repairs。本模块不自己再判定一次
 * 「是否异常退出」：判定分散到第二处，就必然出现一处说异常、一处说正常的两个口径。
 *
 * 交付纪律（§4.9）：
 *   - 级别 warn，走 alert/notifier.ts 的统一出口（文件档永远在，webhook 配了才走）；
 *   - 指纹类别固定为 `startup-recovery`，不带参数——于是「同一类启动告警 30 分钟内只发一次」
 *     对守护脚本有效：反复拉起一个必然崩溃的进程，人只会收到一条，而不是被刷屏。
 *
 * 约定：纯类型导入写 `.js`。零外部依赖：只用 node: 标准库。
 */

import type { NotifyOutcome } from '../tools/admin.js';
import type { AlertInput, AlertNotifier } from './notifier.js';
import type { AppEvent, BudgetLayer } from '../log/types.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 告警类别（指纹的类别段）：同类启动告警共用一个 30 分钟限流窗口 */
export const STARTUP_RECOVERY_CATEGORY = 'startup-recovery';

/**
 * recover 标记异常退出的字样。与 runtime/recover.ts 的 settleOpenTurn 文本契约绑定
 * （`上一次运行异常退出：turn N 补写 turn/end{interrupted}`），该契约由 test/cli-observe.test.ts
 * 用真实 recover 的输出锁定——文案一改，测试立刻红，不会静默失去这条告警。
 */
export const INTERRUPTED_REPAIR_MARK = 'interrupted';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface StartupRecoveryInput {
  /** recover 返回的补偿清单（RecoverResult.repairs） */
  repairs: readonly string[];
  /** 数据目录（写进正文，便于人定位是哪个实例） */
  dataDir?: string | undefined;
  /** 本次启动的进程 pid（写进正文） */
  pid?: number | undefined;
}

// ──────────────────────────────── 判定 ────────────────────────────────

/** 挑出「上一次运行异常退出」相关的补偿项；返回空数组即上次是正常退出，不必告警 */
export function interruptedRepairs(repairs: readonly string[]): string[] {
  return repairs.filter((repair) => repair.includes(INTERRUPTED_REPAIR_MARK));
}

/**
 * 组装启动告警；上次正常退出返回 null（**不制造"出事了"的假事实**）。
 * 正文里把恢复补偿逐条列出来：收到告警的人第一眼要看到的是"系统自己做了什么"，
 * 而不是一句"上次崩了"——补偿清单决定了他是去看 review list 还是直接放心。
 */
export function buildStartupRecoveryAlert(input: StartupRecoveryInput): AlertInput | null {
  const hits = interruptedRepairs(input.repairs);
  if (hits.length === 0) return null;

  const where = input.dataDir === undefined ? '' : `（数据目录 ${input.dataDir}）`;
  const who = input.pid === undefined ? '' : `，本次启动 pid ${input.pid}`;
  const body = [
    `启动时发现上一次运行不是正常退出${where}${who}：${hits.join('；')}。`,
    `本次启动完成 ${input.repairs.length} 项恢复补偿：未闭合的 turn 已按 interrupted 结算，`
      + '被它认领过的输入已退回队列等待重新认领，有副作用的悬空调用一律标为 unknown 并进入待确认。',
    '请用 `irmia review list` 核对 unknown 调用后再用 `irmia review resolve` 结案。',
  ].join('');

  return {
    category: STARTUP_RECOVERY_CATEGORY,
    level: 'warn',
    title: `启动恢复：上一次运行异常退出（补偿 ${input.repairs.length} 项）`,
    body,
    // 刻意不带 params：参数会进指纹，参数一变就绕开限流窗口，等于给刷屏开门
  };
}

/**
 * 发一条启动告警并返回回执；上次正常退出返回 null。
 * 用 alert 而非 fail：异常退出是一次性事实，不是正在持续的故障——fail 会在 notifier 里
 * 登记一个永远等不到「已恢复」的故障窗口。
 */
export async function notifyStartupRecovery(
  notifier: AlertNotifier,
  input: StartupRecoveryInput,
): Promise<NotifyOutcome | null> {
  return (await notifyStartupRecoveryDetailed(notifier, input)).outcome;
}

/** 启动告警的回执：`outcome` 与 {@link notifyStartupRecovery} 同一个，另加一格"是不是被窗口压掉了" */
export interface StartupRecoveryReceipt {
  /** 告警回执；null = 上次正常退出，这一条根本没发 */
  outcome: NotifyOutcome | null;
  /**
   * 这条告警被**限流窗口有意丢弃**了（不是失败）。
   *
   * 为什么要单独一格：被限流时 `outcome.ok` 也是 true（`notifier.ts` 的口径：有意丢弃不算失败），
   * 于是调用方照着 ok 写"已发出"就是在撒谎。窗口内**账照旧**（同一条事实日志里早有一条
   * `alarm/sent`），但**没有再推一条给人**——这两件事必须能分开说。
   */
  suppressed: boolean;
}

/**
 * 同 {@link notifyStartupRecovery}，但把"被窗口压掉了"也如实带出去。
 *
 * 判据不另写一份：notifier 在窗口内会把这条**有意丢弃**并让 `stats().suppressed` 加一，
 * 调用前后差一即是被压。自己再算一遍 `now - last < rateLimitMs` 就会与 notifier 的口径分岔
 * （窗口毫秒由 `setRateLimitMin` 热更，第二份判据必然跟不上）。
 */
export async function notifyStartupRecoveryDetailed(
  notifier: AlertNotifier,
  input: StartupRecoveryInput,
): Promise<StartupRecoveryReceipt> {
  const alert = buildStartupRecoveryAlert(input);
  if (alert === null) return { outcome: null, suppressed: false };
  const before = notifier.stats().suppressed;
  const outcome = await notifier.alert(alert);
  return { outcome, suppressed: notifier.stats().suppressed > before };
}

// ──────────────────────────────── 发告警之前：把限流窗口重建回来 ────────────────────────────────

/**
 * 日志里"能顺序读到事件"的那个口子（真实实现就是 `EventLog.readAll()`）。
 *
 * 为什么声明成结构类型而不是 `EventLog`：这一层只需要读，而 `EventLog` 还带着写句柄、
 * 索引与分片策略——把它当依赖传进来，测试就得先造一份真日志才能验一条排序。
 */
export interface StartupAlertLogSource {
  readAll(): AsyncIterable<AppEvent>;
}

/**
 * **先恢复限流窗口，再发启动告警**（P1-20，2026-10-18）。
 *
 * 病：`notifier.restore(日志)` 原先只发生在真循环的 `warmUp` 里，而启动告警在**那之前**就发了
 * ⇒ "同一类告警 30 分钟内只发一次"这条承诺在**启动告警自己身上**失效。一个必然崩溃的进程被
 * 守护脚本反复拉起时，每重启一次就多一条——而"限流"正是为这种循环准备的。
 *
 * 修：把 `alarm/sent` 先折进窗口（`notifier.restore`，与 `warmUp` 是同一个入口），再发告警。
 * 只挑 `alarm/sent`：`foldAlarms` 与 `foldStalls` 两份状态都只读这一种事件（`notifier.ts`），
 * 所以"读全量再过滤"与"读全量再折"结论逐字相同，而过滤后留在内存里的只有告警那一小截。
 *
 * @returns 折进窗口的 `alarm/sent` 条数（0 = 日志里一条告警都没有，这条路无事可做）
 */
export async function restoreStartupAlertWindow(
  notifier: AlertNotifier,
  log: StartupAlertLogSource,
): Promise<number> {
  const alarms: AppEvent[] = [];
  for await (const event of log.readAll()) {
    if (event.type === 'alarm/sent') alarms.push(event);
  }
  notifier.restore(alarms);
  return alarms.length;
}

// ══════════════════════════════ 启动时补写「已恢复」 ══════════════════════════════

/**
 * 为什么需要这一段（2026-10-05 用户报的现场）：
 *
 * 一条"已恢复"（`alarm/sent{recovered:true}`，标题「已恢复：budget-exhausted」）**只在同一个
 * 进程里条件自然解除时才写**（`notifier.ok` ← `real-loop` 的 `releaseLiftedPauses` / 加注 /
 * healthCheck）。而用户恢复预算走的是**重启 + 改额度**那条路：重启之后上一次那条
 * `budget/exhausted` 由日志重放回来，可那个进程里**再没有任何一刻**会判"它解除了"——
 * 于是运行情况页那张卡上，一条早就解除的"预算耗尽"永远红着。
 *
 * 这一段补的就是那一笔账，判据一条都不新造：
 *   · **哪些故障还没解除**：`foldStalls(events)`（notifier.ts 的既有口径，与 `restore()` 同源）；
 *   · **怎么写"已恢复"**：`notifier.ok(category, 理由)`（与运行期那条路是同一个方法，
 *     `recovered:true` + 故障键配对 + 指纹都照旧）；
 *   · **为什么可以写**：调用方给出"当刻确实不成立"的判据，本模块不放行谎报（见下）。
 */

/**
 * **不许补写的类别**——"已经发生过的历史事实"。
 *
 * 这条线是这一段最重要的分寸：**重启不等于那件事没发生过**。
 *   · `model-failure`（模型连续失败）：投影里的 `failStreak` 是**持久**计数，重启不清零
 *     （见 `state/fold.ts`）。冷启动时它可能是 0，但那是"这个进程还没失败过"，不是
 *     "上一次那串连续失败已经好了"——那串失败真的发生过，给它补一条"已恢复"就是造假事实。
 *   · 其余"外部世界已经改变"的告警（webhook 挂了、通道断了）同理：进程重启不改外部世界。
 *
 * 反过来说，**可以**补写的是「由**进程状态**决定、重启后会重新评估」的那几类：
 * 它们的成立与否只取决于当刻的框架状态（预算有没有越线、队列里有没有人在等），
 * 重启后重新评估一次，评估结论就是真相。判据表见 {@link STARTUP_BACKFILL}。
 */
export const NEVER_BACKFILLED = new Set<string>([
  'model-failure',
  'startup-recovery',
]);

/**
 * 允许在启动时补写「已恢复」的类别及其**当刻是否仍成立**的判据（唯一一份判定表）。
 *
 * 每条判据都必须是"当刻状态"，且**真实不成立时才返回 true**：
 *   · `budget-exhausted`：日志里没有任何一层还停在"撞线且未解除"的暂停态
 *     （判据是 `pausedLayers` 为空，见 {@link pausedLayers}）；
 *   · `stall`：队列里没有"等了超过阈值还没被处理"的输入（`budget-guard.ts` 的 `stallOf`，
 *     运行期用的是同一个函数）。
 *
 * 判据由调用方注入，本模块不自己再实现一遍——第二份判定必然与运行期分岔。
 */
export const STARTUP_BACKFILL: Record<
  string,
  (evidence: StartupBackfillEvidence) => boolean
> = {
  'budget-exhausted': (evidence) => evidence.pausedLayers.length === 0,
  stall: (evidence) => !evidence.stallNow,
};

/** 启动补写要向调用方问的两件"当刻状态"（都是运行期已有的判定，不新造） */
export interface StartupBackfillEvidence {
  /** 当刻还停在"撞线且未解除"的暂停态的预算层（空 = 那一档当刻没有暂停） */
  pausedLayers: readonly BudgetLayer[];
  /** 当刻是否真有水位停滞（有输入等着没人处理） */
  stallNow: boolean;
}

/**
 * 判据的工具：**当刻还停在"撞线且未解除"的预算层**。
 *
 * 判据与 `BudgetGuard.isPaused` 是同一条（`lastExhausted` 里还有没有这一层的记录），
 * 只是它要一份投影而已：
 *   · 记录还在 ⇒ 这一层还停着（**不管它的上限是不是已经被抬高了**——抬高的那一半由
 *     {@link raisedLayers} 说清，两件事分开看，合成一句"不暂停"就说不清是谁解的）；
 *   · 记录没了、而同一条撞线事实还在日志里 ⇒ 后来被 `budget/resumed` 或加注解开了。
 */
export function pausedLayers(projection: {
  lastExhausted: Partial<Record<BudgetLayer, unknown>>;
}): BudgetLayer[] {
  return (Object.keys(projection.lastExhausted) as BudgetLayer[]).sort();
}

/**
 * 判据的工具：**哪些预算层的暂停是被"抬上限"解掉的**——日志里说得出凭据的那种。
 *
 * 与 {@link pausedLayers} 是一对：投影里已经没有这一层的暂停记录，而日志里那条
 * `budget/exhausted` 之后**没有** `budget/topped-up` / `budget/resumed`
 * （`state/fold.ts` 的销账口径，这里逐字复用）——那它只可能是"上限被抬高了"解开的，
 * 要满足"有效上限 > 撞线时那个上限"（`liftedPauses` 判据③的同一个比较）。
 *
 * **认不出的形状一律不认**（宁可漏一句话，也不编）：读不出 layer 的 `budget/exhausted`、
 * 记录里没有上限，都不算。
 */
export function raisedLayers(
  events: Iterable<AppEvent>,
  effectiveLimit: (layer: BudgetLayer) => number,
): BudgetLayer[] {
  const open = new Map<BudgetLayer, number>();
  for (const event of events) {
    if (event.type === 'budget/exhausted') {
      const layer = event.data.layer;
      const limit = event.data.limit;
      if (typeof limit !== 'number' || !Number.isFinite(limit)) continue;
      open.set(layer, limit);
      continue;
    }
    if (event.type === 'budget/topped-up' || event.type === 'budget/resumed') {
      open.delete(event.data.layer);
    }
  }

  const raised: BudgetLayer[] = [];
  for (const [layer, archivedLimit] of open) {
    if (effectiveLimit(layer) > archivedLimit) raised.push(layer);
  }
  return raised.sort();
}

/**
 * 仍未解除的故障类别（`category:xxx` 键 → `xxx`），按类别去重。
 *
 * 口径与 `notifier.ts` 的 `foldStalls` **同一份**：一个故障键有 `alarm/sent` 而其后没有
 * `recovered:true` 的那条，就算"还没销账"。这里只把键名换成类别名，方便按类别查判据表。
 */
export function unresolvedCategories(events: Iterable<AppEvent>): string[] {
  const open = new Set<string>();
  for (const event of events) {
    if (event.type !== 'alarm/sent') continue;
    const key = event.data.key;
    if (key === undefined || key === '') continue;
    const category = categoryOfKey(key);
    if (category === null) continue;
    if (event.data.recovered === true) open.delete(category);
    else open.add(category);
  }
  return [...open].sort();
}

/** 故障键 → 类别：只认运行期 `fail()`/`ok()` 写下的 `category:<类别>` 形状 */
export function categoryOfKey(key: string): string | null {
  const prefix = 'category:';
  if (!key.startsWith(prefix)) return null;
  const category = key.slice(prefix.length);
  return category === '' ? null : category;
}

/**
 * 挑出**这次启动该补写「已恢复」**的类别。
 *
 * 三条同时成立才挑：① 该类别有未解除的告警；② 不在 {@link NEVER_BACKFILLED} 里
 * （历史事实类，重启不为它背书）；③ 它在 {@link STARTUP_BACKFILL} 里有判据，且判据说
 * **当刻确实不成立**。任一条不成立就一个字都不写——**不许为了好看而谎报恢复**。
 */
export function backfillCandidates(
  events: Iterable<AppEvent>,
  evidence: StartupBackfillEvidence,
): string[] {
  return unresolvedCategories(events).filter((category) => {
    if (NEVER_BACKFILLED.has(category)) return false;
    const resolvable = STARTUP_BACKFILL[category];
    if (resolvable === undefined) return false; // 没有判据的类别：不动它（保守）
    return resolvable(evidence);
  });
}

/**
 * 补写「已恢复」，返回**真的写下去了**的类别。
 *
 * 走的是 `releasePending`（不是 `ok`）：这一条账的语义是"**上一个进程留下的**故障，
 * 当刻已经核实过不成立"——`ok()` 只管本进程亲眼看见的恢复，不给历史故障背书
 * （见 notifier.ts 的 `carriedOver`）。
 *
 * 幂等有两层，都不靠内存记账：
 *   · 写下去的那条 `recovered:true` 进日志，`foldStalls` 下一次启动就把这个键销掉
 *     ⇒ 下一次启动 `backfillCandidates` 根本挑不出它，**重复启动不会堆积重复记录**；
 *   · `releasePending` 自己写完之后登记就没了，同一次启动再调是空操作。
 *
 * `reason` 说明这笔账是谁补的——读日志的人要能一眼看出"这不是运行期自然恢复"。
 * 内容由调用方给（它才知道当刻的数），本函数不编数字。
 */
export async function backfillResolvedAlarms(
  notifier: AlertNotifier,
  categories: readonly string[],
  reason: (category: string) => string,
): Promise<string[]> {
  const written: string[] = [];
  for (const category of categories) {
    await notifier.releasePending(category, reason(category));
    written.push(category);
  }
  return written;
}
