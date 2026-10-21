/**
 * Irmia Agent — **全量事件快照**（按日志实例缓存 + 增量补齐）。
 *
 * ──────────────────────────── 它存在的理由（实测） ────────────────────────────
 *
 * 这份日志在真实规模下是 7.4 万条 / 59 MB，而"把全量事件折进一个数组"这件事被
 * **两条热路径**各自做了一遍：
 *
 *   ① `real-loop.ts` 的 `mcpIndexSync()` —— **每一拍**（`pollMs = 1000`，每秒一次）
 *      `for await (…) log.readAll()` 把全量折进一个**新数组**，并把它留在实例上
 *      （`this.eventView`，给同拍的 `settleGrants` 用）。
 *      实测（`_research/probe-tick-churn.mts`）：**单次 98.4 MB / 500 ms**，
 *      连打 10 拍堆就到 459 MB —— 而 V8 **把堆还给 `heapUsed`、不还给系统**
 *      （`_research/probe-v8-retention.mjs`），于是 RSS 高水位被一路顶上去。
 *      真实事故：带上限 512 MB 的那一轮，**167 秒就 OOM**。
 *   ② `web/server.ts` 的八条只读端点 —— 改前每个请求各读一遍（450~550 ms/请求）。
 *
 * 两边要的是**同一个东西**（"截至此刻的全量事件"），所以只有一份缓存、放在这里，
 * 谁都不许自己再 `readAll()` 一遍。
 *
 * ──────────────────────────── 三条纪律 ────────────────────────────
 *
 * · **只增**：日志是 append-only（seq 单调、分片只追加），所以快照只需补
 *   `upToSeq` 之后的增量。
 * · **只读**：调用方一律照着只读用。类型标 `readonly` 是把这条纪律写进签名里
 *   ——想就地改的人会在编译期被拦下。
 * · **按实例分桶**：生产上一个进程只有一份日志，但测试里同时开着好几份（各自
 *   `mkdtemp`）。用 `WeakMap` 按 `EventLog` 实例分，实例被回收时缓存跟着走。
 *
 * ──────────────────────────── 那 ~90 MB 是**有意**的 ────────────────────────────
 *
 * 实测：7.4 万条解析后常驻约 **88~98 MB**（`_research/probe-mem-blocks.mts`）。
 * 它换掉的是"每秒 / 每请求重读重 parse 59 MB"。2026-10-10 评估过"给它设上限"，
 * **结论是不做**：会让翻老会话、7 天预算、按 seq 定位重放退化成重新读盘（~300 ms 起），
 * 而"端点响应时间不许退步"是硬要求。真要压整体内存，杠杆在**进程级老生代上限**
 * 与"别再白造第二份"（本模块就是后者），见 `docs/operations.md` §4.4。
 */
import type { EventLog } from '../log/event-log.js';
import type { AppEvent } from '../log/types.js';

interface EventSnapshot {
  /** 已同步到的 seq；`0` = 还没读过 */
  upToSeq: number;
  /**
   * 全量事件（seq 升序）。**就地追加**（见下面那段：展开合并每拍白分配一次），
   * 所以这个引用**从建立起一直有效**、只会变长。
   */
  events: readonly AppEvent[];
  /** 正在进行的补齐（并发合流用）；null = 没有在飞的 */
  inflight: Promise<readonly AppEvent[]> | null;
}

const eventSnapshots = new WeakMap<EventLog, EventSnapshot>();

/** 只给测试/诊断用：某份日志当前的快照规模 */
export function snapshotSizeOf(log: EventLog): number {
  return eventSnapshots.get(log)?.events.length ?? 0;
}

/**
 * 取"截至此刻的全量事件"。首次调用全量读盘，此后只读 `upToSeq` 之后的增量。
 *
 * 并发合流：一页界面同时打四条、或 tick 与请求撞在一起时，只留一个在飞的 promise，
 * 后到的等它——否则它们会各读一遍（雷群）。
 *
 * 返回值**只读**：调用方一律照着只读用（`buildReviewEntries` / `pairedRecoveries` /
 * `fold` / `answerHuman` / `mcpIndexOf` …），没有一处就地改它。
 *
 * 同一实例上返回的**数组引用稳定**（没有新增事件时是同一个对象；有新增时也是同一个，
 * 只是尾部多了几条）——但**别依赖它当"变没变"的判据**：日志只增，引用不变不等于内容不变。
 */
export async function allEventsOf(log: EventLog): Promise<readonly AppEvent[]> {
  const existing = eventSnapshots.get(log);
  const snapshot: EventSnapshot = existing ?? { upToSeq: 0, events: [], inflight: null };
  if (existing === undefined) eventSnapshots.set(log, snapshot);

  const latest = log.latestSeq();
  // 正常路径（没有新事件）：零 IO、零 parse，直接给同一份引用
  if (latest <= snapshot.upToSeq) return snapshot.events;
  if (snapshot.inflight !== null) return snapshot.inflight;

  // 日志被换掉/截断（测试里重建日志、或运维换了一份 events/）：从 1 重新读，
  // 不然会把新日志的增量接到旧日志的尾部，拼出一份谁也没写过的历史
  const from = latest < snapshot.upToSeq ? 1 : snapshot.upToSeq + 1;

  const inflight = (async (): Promise<readonly AppEvent[]> => {
    // **就地追加，不用 `[...events, ...fresh]`**。
    //
    // ⚠ 别把这条当成"省了 90 MB"：展开合并复制的是**引用数组**，不是事件对象本身
    // ——7.3 万条时实测只多占 **1.4 MB**（`_research/probe-spread-cost.mjs`）。
    // 仍然改的理由：这条路径**每拍有事件就走一次**，而 RSS 只涨不还 ⇒ 每拍一次
    // 无谓的整段分配，长期就是白交给 V8 的峰值。
    const target: AppEvent[] = from === 1 ? [] : snapshot.events as AppEvent[];
    if (from === 1) snapshot.events = target;
    for await (const event of log.readRange(from)) target.push(event);
    snapshot.upToSeq = target.length > 0 ? target[target.length - 1]!.seq : snapshot.upToSeq;
    return target;
  })();

  snapshot.inflight = inflight;
  try {
    return await inflight;
  } finally {
    snapshot.inflight = null;
  }
}

/**
 * 全量事件（旧调用点的门面）：语义与过去逐字节一致，只是**同一实例上不再每请求/每拍重读**。
 * 保留这个名字是因为十来处调用点读起来仍然是"我要全量"；增量与缓存藏在 {@link allEventsOf} 里。
 */
export async function readAllEvents(log: EventLog): Promise<readonly AppEvent[]> {
  return allEventsOf(log);
}
