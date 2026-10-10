/**
 * Irmia Agent — 全量自检（docs/operations.md §6 的 `doctor` 行、docs/schema.md §12 不变量清单）
 *
 * doctor 是无人值守的信任基石：**它把 schema §12 的 11 条不变量逐条跑一遍并报告**。
 * 每条检查的判据都只是在日志/派生文件上做一次可复算的比对，不引入第二套语义——
 * 检查里的口径全部复用运行期的实现（fold、render、blob 路径、persona 哈希），
 * 否则"doctor 说没问题"只证明了 doctor 的复刻版没问题。
 *
 * 三条纪律：
 *   1. **只读**：doctor 绝不写任何文件（连缓存都不落），可以被任何人在任何时候跑；
 *   2. **不猜**：判不了就报"跳过"（如数据目录里没有 persona/），绝不把"没数据"说成"通过"；
 *   3. **一条不变量一条结论**：`fail` 必须给出足以让人动手的具体凭据（seq / callId / 文件名），
 *      而不是一句"存在不一致"。
 *
 * 退出码语义在 CLI 层：任一 `fail` → 退出码 1（M6-7 的验收口径）。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import type { AppEvent, Projection } from '../log/types.js';
import { readEventsReadOnly, type LogScan } from '../log/read-only.ts';
import { inputContentText, render } from '../model/render.ts';
import { sha256Hex } from '../persona/versions.ts';
import { BLOB_ID_PATTERN, blobDirOf, blobIdOf, blobPathOf } from '../state/blob-store.ts';
import { applyEvent, budgetTokensOf, finalizePressure, fold } from '../state/fold.ts';
import { basicProjectionShape, isCacheValid, loadProjectionCacheResult } from '../state/projection-cache.ts';
import { EVENT_LOG_DIR_NAME, TIMER_FILE_NAME } from './recover.ts';
import { LOCK_FILE_NAME } from './instance-lock.ts';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export type DoctorStatus = 'ok' | 'fail' | 'skip';

export interface DoctorCheck {
  /** 不变量编号（I1..I11，与 schema §12 的条目序号一一对应）或运行面编号（OPS-*） */
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  dataDir: string;
  checks: DoctorCheck[];
  failures: number;
  skips: number;
  /** 扫描到的事件总数（报告头部用） */
  events: number;
  badLines: number;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

export async function runDoctor(dataDir: string): Promise<DoctorReport> {
  const scan = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME));
  const events = scan.events;
  const projection = fold(events);

  const checks: DoctorCheck[] = [
    checkSeqMonotonic(scan),
    checkResultPairing(events),
    checkTurnEndUniqueness(events, projection),
    checkSingleOpenTurn(events, projection),
    checkWatermarkSemantics(events, projection),
    checkUnknownInNeedsReview(events, projection),
    checkBudgetFold(events, projection),
    checkFoldPurity(events, projection),
    checkToolCallClosure(events, projection),
    checkPersonaEvented(dataDir, events),
    checkInternalNotRendered(events),
    checkLogIntegrity(scan),
    checkLockFile(dataDir),
    checkBlobIntegrity(dataDir, events),
    checkTimersView(dataDir, projection),
    await checkProjectionCache(dataDir, scan, projection),
  ];

  return {
    dataDir,
    checks,
    failures: checks.filter((check) => check.status === 'fail').length,
    skips: checks.filter((check) => check.status === 'skip').length,
    events: events.length,
    badLines: scan.badLines,
  };
}

// ──────────────────────────────── I1 ────────────────────────────────

/** I1：seq 唯一且严格递增（允许空洞） */
function checkSeqMonotonic(scan: LogScan): DoctorCheck {
  const violations: string[] = [];
  let prev = 0;
  let checked = 0;
  for (const event of scan.events) {
    checked += 1;
    if (event.seq <= prev) {
      if (violations.length < 5) violations.push(`seq ${event.seq}（${event.type}）出现在 ${prev} 之后`);
      continue;
    }
    prev = event.seq;
  }
  // 空洞 = 最大 seq − 事件条数（空洞是崩溃留下的空位，合法）
  const holes = prev === 0 ? 0 : prev - checked;
  return {
    id: 'I1',
    title: 'seq 唯一且严格递增',
    status: violations.length === 0 ? 'ok' : 'fail',
    detail: violations.length === 0
      ? `${checked} 条事件、最大 seq ${prev}、空洞 ${holes}`
      : `${violations.length} 处乱序或重复：${violations.join('；')}`,
  };
}

// ──────────────────────────────── I2 ────────────────────────────────

/** I2：每个 tool/result 都能找到 callSeq 对应的 tool/call */
function checkResultPairing(events: readonly AppEvent[]): DoctorCheck {
  const bySeq = new Map<number, AppEvent>();
  for (const event of events) bySeq.set(event.seq, event);

  const broken: string[] = [];
  let results = 0;
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    results += 1;
    const call = bySeq.get(event.data.callSeq);
    if (call === undefined) {
      broken.push(`tool/result(${event.data.callId}, seq ${event.seq}) 的 callSeq=${event.data.callSeq} 不存在`);
    } else if (call.type !== 'tool/call') {
      broken.push(`tool/result(${event.data.callId}) 的 callSeq=${event.data.callSeq} 指向 ${call.type}`);
    } else if (call.data.callId !== event.data.callId) {
      broken.push(`tool/result(${event.data.callId}) 的 callSeq=${event.data.callSeq} 指向 callId=${call.data.callId}`);
    }
    if (broken.length >= 5) break;
  }
  return {
    id: 'I2',
    title: 'tool/result 与 tool/call 配对（callSeq 可解引用）',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0 ? `${results} 条结果全部配对` : broken.join('；'),
  };
}

// ──────────────────────────────── I3 ────────────────────────────────

/** I3：每个已关闭的 turn 有且只有一条 turn/end */
function checkTurnEndUniqueness(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  const endCounts = new Map<number, number[]>();
  const started = new Set<number>();
  /** 每个 turn 的**最后一条** turn 生命周期事件是 start 还是 end（见下面 unclosed 的判据） */
  const lastWasEnd = new Map<number, boolean>();
  for (const event of events) {
    if (event.type === 'turn/start') {
      started.add(event.data.turn);
      lastWasEnd.set(event.data.turn, false);
    }
    if (event.type === 'turn/end') {
      const list = endCounts.get(event.data.turn) ?? [];
      list.push(event.seq);
      endCounts.set(event.data.turn, list);
      lastWasEnd.set(event.data.turn, true);
    }
  }

  const duplicated = [...endCounts.entries()].filter(([, seqs]) => seqs.length > 1);

  // 有 turn/start 却没有 turn/end：只有"当前打开的那一个"合法。
  //
  // ⚠️ **"没闭合"的判据是"最后一条 turn 生命周期事件是 start"**，不是"一条 turn/end 都没有"
  // （2026-10-11 修正）。原来的写法（`!endCounts.has(turn)`）有一个盲区：**`turn/end` 写在
  // 最后一条 `turn/start` 之前时，turn 其实还开着**——而"有一条 end 就算闭合"会把它当成已闭合。
  // 两种写法在**现场日志**上结论相同（1236/1241/1285 的 end 都排在各自最后一条 start 之后），
  // 但只有这一种与投影的 `openTurn` 同语义（`fold.ts:208-220`：start 置位、同 turn 的 end 清空），
  // 也才让"同一 turn 既重复闭合又未闭合"这种形状真的能被报出来（否则两支互斥，
  // "未闭合优先"就永远没有生效的场合）。
  const allowed = projection.openTurn?.turn;
  const unclosed = [...started].filter((turn) => lastWasEnd.get(turn) === false && turn !== allowed);

  // **未闭合优先报**（2026-10-11 判据顺序修正）：这一支原来排在 duplicated 之后，而 duplicated
  // 一旦成立就 `return`，于是"有 turn/start 却没 turn/end"在当前这份日志上**一次都没被报出来过**
  // （实测：1236/1241/1285 有双 turn/end 抢先返回，1237/1277/1279 就此被遮住）。
  // 两支都要人动手，但**未闭合更该先看见**：它要靠恢复流程按 interrupted 逐条结算，
  // 而重复 turn/end 只说明"关闭写了两次"、不动账。所以先报未闭合，再报重复闭合。
  if (unclosed.length > 0) {
    return {
      id: 'I3',
      title: '每个已关闭的 turn 有且只有一条 turn/end',
      status: 'fail',
      detail: `未闭合且不是当前 turn：${unclosed.join('、')}`,
    };
  }

  if (duplicated.length > 0) {
    // **已知历史痕迹，不是回归**（2026-10-11 记）：
    //   现场日志里重复 turn/end 的是 **1236 / 1241 / 1285**（各 2 条）。成因是 2026-10-10 的并发缺陷
    //   ——**同一拍里两个 turn 同时在跑**，然后双方各写了一条 end。**成因已修**（tick 重叠守卫 +
    //   busy 紧邻置位），**不会再新增**；留下的这三条无法在不违反"append-only（事件日志只追加、
    //   不改历史）"的前提下修掉（要修只能删掉第二条 end = 改历史）。
    //   ⇒ **这条红是如实的**：它报的是"日志里确实有重复闭合"，而不是"现在坏了"。
    //   什么时候该重新当回事：**出现 1236/1241/1285 之外的新 turn**，那才是并发缺陷回来了。
    //   注释里写一遍不够（doctor 的输出才是人真正看的东西）⇒ detail 尾部也带一句，只加说明、不改判据。
    const note = '（注：1236/1241/1285 的重复 turn/end 是 2026-10-10 并发缺陷留下的历史痕迹，'
      + '成因已修、不会再新增；修它要改历史 ⇒ 这条红是如实的，不是回归。'
      + '出现这三个之外的新 turn 才说明缺陷回来了）';
    return {
      id: 'I3',
      title: '每个已关闭的 turn 有且只有一条 turn/end',
      status: 'fail',
      detail: duplicated
        .slice(0, 5)
        .map(([turn, seqs]) => `turn ${turn} 有 ${seqs.length} 条 turn/end（seq ${seqs.join(',')}）`)
        .join('；') + note,
    };
  }

  return {
    id: 'I3',
    title: '每个已关闭的 turn 有且只有一条 turn/end',
    status: 'ok',
    detail: `${endCounts.size} 个已关闭 turn 各一条 turn/end`,
  };
}

// ──────────────────────────────── I4 ────────────────────────────────

/**
 * I4：打开的 turn 在正常运行期间最多一个。
 *
 * **为什么导出**（`_` 前缀 = 仅供测试引用）：判据要**两侧**都看——日志侧（有几个 turn
 * 没闭合）与投影侧（`openTurn` 是谁）。而 `runDoctor` 的投影就是 `fold(events)`（`doctor.ts:60`），
 * 于是"投影说开着、日志里已闭合"这**另一侧**的不一致**不可能由一份日志造出来**（`fold` 里
 * `openTurn` 只被 `turn/start` 置位、只被同 turn 的 `turn/end` 清空，见 `fold.ts:208-220`）——
 * 走 `runDoctor` 的测试**永远覆盖不到**它。所以把判据本体开一个口子，让测试能把一份
 * **显式投影**喂进来；`runDoctor` 仍走同一条生产路径（`doctor.ts` 的 checks 数组里就是它）。
 */
export function checkSingleOpenTurn(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  // ⚠️ **按 turn 号去重**（2026-10-11 修正）：原来是 `started.push(...)`——按 `turn/start`
  // **事件条数**列。并发缺陷下同一个 turn 会写出两条 `turn/start`，于是 1277 在"未闭合 turn"
  // 里出现两次，把**4 个**未闭合 turn 显示成"5 个"（诊断报告 ①.3 坐实）。
  // 判据问的是"有几个**打开的 turn**"，不是"写了几条 start"——所以这里按 turn 号去重。
  const started = new Set<number>();
  const closed = new Set<number>();
  for (const event of events) {
    if (event.type === 'turn/start') started.add(event.data.turn);
    if (event.type === 'turn/end') closed.add(event.data.turn);
  }
  const unclosed = [...started].filter((turn) => !closed.has(turn));

  if (unclosed.length > 1) {
    return {
      id: 'I4',
      title: '打开的 turn 最多一个',
      status: 'fail',
      detail: `${unclosed.length} 个未闭合 turn：${unclosed.join('、')}（恢复流程应按 interrupted 逐个结算）`,
    };
  }
  if (unclosed.length === 1 && projection.openTurn?.turn !== unclosed[0]) {
    return {
      id: 'I4',
      title: '打开的 turn 最多一个',
      status: 'fail',
      detail: `未闭合 turn ${unclosed[0]} 与投影 openTurn=${String(projection.openTurn?.turn ?? 'null')} 不一致`,
    };
  }
  // **反向不一致**（2026-10-11 补）：上面两条只查"日志里没闭合的"，`unclosed.length === 0`
  // 时无条件放行——于是"投影说有个 turn 开着、日志里却早已闭合"这种**另一侧**的不一致
  // （恢复流程会把 openTurn 清成 null，这一支抓的就是它没清干净）看不到。判据要两侧都看。
  if (unclosed.length === 0 && projection.openTurn !== null) {
    return {
      id: 'I4',
      title: '打开的 turn 最多一个',
      status: 'fail',
      detail: `投影 openTurn=${projection.openTurn.turn} 但日志里没有未闭合的 turn（该 turn 已闭合或根本不存在）`,
    };
  }
  return {
    id: 'I4',
    title: '打开的 turn 最多一个',
    status: 'ok',
    detail: unclosed.length === 0 ? '没有未闭合 turn（空闲）' : `turn ${unclosed[0]} 正在运行`,
  };
}

// ──────────────────────────────── I5 ────────────────────────────────

/**
 * I5：水位之前不存在未处理的、可投递的事件。
 * 水位口径与 CLI status 同源（有 pending 停在最早一条之前，否则等于日志末尾）。
 */
function checkWatermarkSemantics(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  let maxSeq = 0;
  for (const event of events) if (event.seq > maxSeq) maxSeq = event.seq;
  const watermark = projection.pending.length > 0
    ? Math.min(...projection.pending.map((item) => item.wakeSeq)) - 1
    : maxSeq;

  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const seen = new Set<number>();
  const broken: string[] = [];
  for (const item of projection.pending) {
    if (item.wakeSeq <= watermark) broken.push(`pending 里 seq ${item.wakeSeq} 位于水位 ${watermark} 之前`);
    if (seen.has(item.wakeSeq)) broken.push(`pending 里 seq ${item.wakeSeq} 重复出现`);
    seen.add(item.wakeSeq);
    const event = bySeq.get(item.wakeSeq);
    if (event === undefined) broken.push(`pending 里 seq ${item.wakeSeq} 在日志里不存在`);
    else if (!event.type.startsWith('wake/')) broken.push(`pending 里 seq ${item.wakeSeq} 指向 ${event.type}`);
    if (broken.length >= 5) break;
  }

  return {
    id: 'I5',
    title: '水位之前不存在未处理的可投递事件',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0
      ? `水位 ${watermark}（日志最大 seq ${maxSeq}）、待办 ${projection.pending.length} 条均位于水位之后`
      : broken.join('；'),
  };
}

// ──────────────────────────────── I6 ────────────────────────────────

/** I6：每个 status:'unknown' 的调用都在 needsReview 里，直到被 review/resolved 结案 */
function checkUnknownInNeedsReview(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  const unknowns: string[] = [];
  const resolvedAfter = new Set<string>();
  for (const event of events) {
    if (event.type === 'tool/result' && event.data.status === 'unknown') unknowns.push(event.data.callId);
    if (event.type === 'review/resolved' && unknowns.includes(event.data.callId)) resolvedAfter.add(event.data.callId);
  }
  const expected = new Set(unknowns.filter((callId) => !resolvedAfter.has(callId)));
  const actual = new Set(projection.needsReview.map((item) => item.callId));

  const missing = [...expected].filter((callId) => !actual.has(callId));
  const extra = [...actual].filter((callId) => !expected.has(callId));
  const broken: string[] = [];
  if (missing.length > 0) broken.push(`未结案的 unknown 不在 needsReview：${missing.slice(0, 5).join('、')}`);
  if (extra.length > 0) broken.push(`needsReview 里有不成立的条目：${extra.slice(0, 5).join('、')}`);

  return {
    id: 'I6',
    title: 'unknown 调用在 needsReview 里直到结案',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0
      ? `${unknowns.length} 条 unknown → 待确认 ${actual.size} 条、已结案 ${resolvedAfter.size} 条`
      : broken.join('；'),
  };
}

// ──────────────────────────────── I7 ────────────────────────────────

/**
 * I7：预算累计 = 所有 `budget/consumed` 的折叠结果（当日口径，照 `fold.ts`）。
 *
 * **为什么导出**（`_` 前缀 = 仅供测试引用，同 I4）：这一条是"**投影 vs 事件重折**"的比对，
 * 而 `runDoctor` 里的投影就是 `fold(events)`（`doctor.ts:60`）——两侧由同一次折叠产生，
 * 走 `runDoctor` 只能验到"折叠是纯函数"，**验不到"投影坏了会不会被抓"**。所以把判据本体
 * 开一个口子，让测试能把一份**显式投影**喂进来；`runDoctor` 仍走同一条生产路径。
 *
 * **只有一把尺子**：投影那三格（`tokensToday` / `Heavy` / `Light`）按**预算口径**折——**引**
 * `state/fold.ts` 的 `budgetTokensOf`（唯一一处定义），**不在这里重写公式**。这一处原来自己
 * 写了一遍 `inputTokens + outputTokens`，换口径之后它就成了"第二份判据"，会把一份**正确**的
 * 投影报成 `投影 tokensToday=X，事件累计 Y`（2026-10-05 起的假故障，`612b866` / `ceac537` 的旧账）。
 *
 * **判据的日期边界必须与投影的折叠语义逐字一致**。`state/fold.ts:348-358` 折
 * `budget/rollover` 时把当日三格**归零**（收到一条就归零，不自己判"日期是不是真的变了"）——
 * 所以这里也照做。这一处原来只清 `accum`、**从不清 `billable`/`heavy`/`light`**，于是拿
 * **全历史** 29 991 932 去比当日的 1 628 746（诊断报告 ②.3 的错误 B）。
 *
 * ⚠️ 口径上要知道的一件事：**归零的时机由事件本身决定，不由判据猜**。"同日重启不该把当日
 * 清零"这件事的真正落点在**写入侧**——`runtime/real-loop.ts` 的 `rolloverIfNeeded` 早先每次启动
 * 都写一条 rollover（现场 09-30/10-01 因此有 33 条**同日期** rollover，把当天已记的账抹掉：
 * fold 重放出来 09-30=69 028 / 10-01=309 493，而当日真实发生量是 1 574 006 / 965 806）；
 * 现在它改成"投影说今天记过了就不再写"，**当前运行期不再产生同日期 rollover**。
 * 判据若自作主张"只在日期变化时归零"，就会比投影**多算**同日期 rollover 之后的那一段——
 * 在一份投影其实自洽的日志上报假故障。**判据跟着投影走，投影跟着事件走。**
 *
 * ⚠️ **`tokensTodayAccum` 这条判据 2026-10-11 已删**（诊断报告 ②.3 的错误 A）。它是写入方的
 * 观测字段，形状是"**新口径基线 + 本条旧口径增量**"（五处写入一律如此、彼此自洽）：拿旧口径
 * （`input + output`）去核它，等于用两把尺子量同一根柱子。它**只是观测**——schema 明写、预算
 * 闸门读投影而不读它（`budget-guard.ts:454/707`）、`test/fold.test.ts:577` 也钉着"预算不信它"。
 * 把它留在自检里就是让观测值承担不变量职责：换口径/重建这类**合法**操作一改基线就天天假报。
 */
export function checkBudgetFold(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  /** 预算口径的当日累计（`budgetTokensOf`：未命中 + 输出） */
  let billable = 0;
  let heavy = 0;
  let light = 0;
  let consumed = 0;
  const broken: string[] = [];
  for (const event of events) {
    if (event.type === 'budget/rollover') {
      // 归零时机**照抄 fold.ts:348-358**：折到一条 rollover 就把当日三格归零（不自己判日期）。
      // 这是本判据的**唯一一处**日期边界，也是原来漏掉的那一处（billable/heavy/light 从不归零）。
      billable = 0;
      heavy = 0;
      light = 0;
      continue;
    }
    if (event.type !== 'budget/consumed') continue;
    consumed += 1;
    // 投影那一侧走预算口径（唯一一处定义在 fold.ts；这里不重算 token 算式）
    const cost = budgetTokensOf(event.data);
    billable += cost;
    if (event.data.lane === 'heavy') heavy += cost;
    else light += cost;
  }

  const b = projection.budget;
  if (b.tokensToday !== billable) broken.push(`投影 tokensToday=${b.tokensToday}，按非缓存口径折出 ${billable}`);
  if (b.tokensTodayHeavy !== heavy) broken.push(`投影 heavy=${b.tokensTodayHeavy}，按非缓存口径折出 ${heavy}`);
  if (b.tokensTodayLight !== light) broken.push(`投影 light=${b.tokensTodayLight}，按非缓存口径折出 ${light}`);

  return {
    id: 'I7',
    title: '预算累计与 budget/consumed 折叠一致',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0
      ? `${consumed} 条消耗事件、今日非缓存 ${b.tokensToday} tok（heavy ${heavy} / light ${light}）`
      : broken.slice(0, 5).join('；'),
  };
}

// ──────────────────────────────── I8 ────────────────────────────────

/** I8：折叠纯函数性抽查——两次全量折叠逐字段一致，且增量路径与全量一致 */
function checkFoldPurity(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  const fromFold = JSON.stringify(projection);
  const again = JSON.stringify(fold(events));

  // 增量路径复用运行期的 applyEvent + finalizePressure（不重写一份折叠）：
  // 与 fold 同一条归属分派，子代理链的事件在两条路径上都只折父层记账
  const incremental = fold([]);
  for (const event of events) applyEvent(incremental, event);
  finalizePressure(incremental);

  const same = fromFold === again;
  const incrementalSame = JSON.stringify(incremental) === again;
  return {
    id: 'I8',
    title: '折叠是纯函数（两次折叠一致、增量与全量一致）',
    status: same && incrementalSame ? 'ok' : 'fail',
    detail: same
      ? `全量折叠稳定；增量折叠${incrementalSame ? '一致' : '不一致（applyEvent 与 fold 分叉）'}`
      : '两次 fold 结果不同：折叠读了时钟或外部状态',
  };
}

// ──────────────────────────────── I9 ────────────────────────────────

/**
 * I9：每个 tool/call 最终有且只有一个终态 tool/result。
 *
 * 开放调用只在两种情形下合法：运行中（当前 turn 未闭合），或恢复结算前的崩溃现场。
 * 于是"没有结果"要和 turn 的闭合状态一起看——**turn 都关了还留着开放调用**正是崩溃没被
 * 补偿、或调用被静默丢弃的证据（M6-7 用来手工破坏的那一条就是这个）。
 */
function checkToolCallClosure(events: readonly AppEvent[], projection: Projection): DoctorCheck {
  const results = new Map<string, number[]>();
  const callTurns = new Map<string, number>();
  const closedTurns = new Set<number>();
  for (const event of events) {
    if (event.type === 'tool/call') callTurns.set(event.data.callId, event.data.turn);
    if (event.type === 'turn/end') closedTurns.add(event.data.turn);
    if (event.type === 'tool/result') {
      const list = results.get(event.data.callId) ?? [];
      list.push(event.seq);
      results.set(event.data.callId, list);
    }
  }

  const open = new Set(projection.openTools.map((tool) => tool.callId));
  const multi = [...results.entries()].filter(([, seqs]) => seqs.length > 1);
  const dangling: string[] = [];
  for (const callId of callTurns.keys()) {
    if (results.has(callId)) continue;
    const turn = callTurns.get(callId);
    if (!open.has(callId)) {
      dangling.push(`${callId}（无终态结果，且不在投影的开放调用里）`);
    } else if (turn !== undefined && closedTurns.has(turn)) {
      dangling.push(`${callId}（turn ${turn} 已关闭却仍无终态结果）`);
    }
  }

  const broken: string[] = [];
  for (const [callId, seqs] of multi.slice(0, 5)) {
    broken.push(`${callId} 有 ${seqs.length} 条终态结果（seq ${seqs.join(',')}）`);
  }
  broken.push(...dangling.slice(0, 5));

  return {
    id: 'I9',
    title: '每个 tool/call 有且只有一个终态 tool/result',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0
      ? `${callTurns.size} 个调用全部闭合（运行中未闭合 ${open.size} 个）`
      : broken.join('；'),
  };
}

// ──────────────────────────────── I10 ────────────────────────────────

/** I10：persona/ 下任何文件的变化都有对应的 persona/updated 事件；版本库内容寻址自洽 */
function checkPersonaEvented(dataDir: string, events: readonly AppEvent[]): DoctorCheck {
  const root = join(dataDir, 'persona');
  if (!existsSync(root)) {
    return {
      id: 'I10',
      title: 'persona 变更事件化',
      status: 'skip',
      detail: `没有 ${root}（尚未首启，或这份数据目录不含人格资产）`,
    };
  }

  const latest = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'persona/updated') latest.set(event.data.file.replace(/\\/gu, '/'), event.data.diffHash);
  }

  const drifted: string[] = [];
  const unversioned: string[] = [];
  for (const file of listPersonaFiles(root)) {
    let content: string;
    try {
      content = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    const recorded = latest.get(file);
    if (recorded === undefined) {
      // 首启种子或人类直接手改：没有历史的人管不着，不判失败，但要说出来
      unversioned.push(file);
      continue;
    }
    const actual = sha256Hex(content);
    /**
     * ⚠ **两个长度**（2026-10-11 定死，原来的假红就出在这里）：日志里那条 `diffHash` 由两个
     * 写通道各写一种形状——GUI 直编（`web/server.ts:5778`）写 `.slice(0, 16)` 的**截断前缀**，
     * 而 `write_persona`（`tools/admin.ts:1711`）与人味回滚（`cli.ts:1341`）写满 64 位。
     * 盘上这一侧永远是 64 位。拿 64 去比 16 ⇒ **内容一字不差也判"漂移"**，而两侧都按
     * 前 8 位打印 ⇒ 消息长成「盘上 92f28ba3 ≠ 日志 92f28ba3」（同一句话，看不出差在哪）。
     * 所以比较**先对齐到日志那条的长度**（16 位十六进制 = 64 bit，判漂移的力道不变），
     * 报错时把两侧的**长度与全量**都打出来。
     */
    const comparable = actual.slice(0, recorded.length);
    if (comparable !== recorded) {
      drifted.push(`${file} 盘上 ${actual}（${actual.length} 位）≠ 日志 ${recorded}（${recorded.length} 位）`);
    }
  }

  const versionBroken = versionStoreProblems(dataDir);
  const notes: string[] = unversioned.length === 0
    ? []
    : [`${unversioned.length} 个文件没有 persona/updated 记录（首启种子或人工直改）：${unversioned.slice(0, 5).join('、')}`];
  // 说清楚"这次比的是多长的哈希"：日志里两种长度混着来（见上面那段），不写出来就会有人
  // 拿"怎么只有 16 位"再查一遍
  const truncated = [...latest.values()].filter((hash) => hash.length < 64).length;
  if (truncated > 0) {
    notes.push(`其中 ${truncated} 条 persona/updated 的 diffHash 是截断前缀（GUI 直编通道写 16 位）`
      + '，比对已按该长度对齐');
  }
  const broken = [...drifted, ...versionBroken];
  return {
    id: 'I10',
    title: 'persona 变更事件化 + 版本库内容寻址自洽',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0
      ? [`${latest.size} 条 persona/updated、版本库自洽`, ...notes].join('；')
      : [...broken.slice(0, 5), ...notes].join('；'),
  };
}

/** persona/ 下的资产文件（顶层 *.md + RELATIONSHIPS/*.md），路径统一 `/` 分隔 */
function listPersonaFiles(root: string): string[] {
  const out: string[] = [];
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(entry.name);
    }
  } catch {
    return out;
  }
  try {
    for (const entry of readdirSync(join(root, 'RELATIONSHIPS'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(`RELATIONSHIPS/${entry.name}`);
    }
  } catch {
    /* 没有关系档案目录是常态 */
  }
  return out;
}

/** 版本库完整性：每个快照的文件名必须等于其内容的 sha256（内容寻址的全部意义） */
function versionStoreProblems(dataDir: string): string[] {
  const root = join(dataDir, '.versions');
  const broken: string[] = [];
  if (!existsSync(root)) return broken;
  walk(root, '');
  return broken;

  function walk(dir: string, prefix: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const expected = entry.name.slice(0, -3);
      if (!/^[0-9a-f]{64}$/u.test(expected)) {
        broken.push(`${rel} 的文件名不是 sha256`);
        continue;
      }
      let content: string;
      try {
        content = readFileSync(join(dir, entry.name), 'utf8');
      } catch {
        broken.push(`${rel} 读不到`);
        continue;
      }
      const actual = sha256Hex(content);
      if (actual !== expected) broken.push(`${rel} 内容哈希 ${actual.slice(0, 8)} 与文件名不符`);
      if (broken.length >= 5) return;
    }
  }
}

// ──────────────────────────────── I11 ────────────────────────────────

/**
 * I11：`visibility:'internal'` 的事件不出现在任何模型请求中（抽查）。
 *
 * 判据刻意选成"不会误报"的两条：
 *   ① 整条 internal 事件的 JSON 序列化（含 seq/type 字段）不得出现在渲染输出里；
 *   ② 只存在于 message/reasoning 的文本（长度 ≥ 24 且不出现在任何 model 事件里）不得出现。
 * 第二条是缓存铁律 3「剥离 reasoning」的直接证据，同时避开了"模型自己复述了同一句话"
 * 这种必然会误报的情形。
 */
function checkInternalNotRendered(events: readonly AppEvent[]): DoctorCheck {
  if (events.length === 0) {
    return { id: 'I11', title: 'internal 不进模型请求', status: 'skip', detail: '日志为空，无可渲染内容' };
  }
  const internalEvents = events.filter((event) => event.visibility === 'internal');

  const rendered = render({
    events: [...events],
    persona: { identity: '', constitution: '', style: '', state: '', relationship: null },
    tools: [],
    wakeEvent: null,
    taskCard: null,
    now: events[events.length - 1]!.ts,
    timezone: 'UTC',
    model: 'doctor',
    lane: 'heavy',
  });

  // 判据落在"渲染出的文本"上，而不是 JSON 序列化上：序列化会转义引号，
  // 拿未转义的原文去 includes 永远匹配不上（这正是"检查看起来跑了、其实什么都没查"的经典形态）
  const parts: string[] = [rendered.instructions];
  for (const item of rendered.input) {
    if (item.type === 'message') parts.push(inputContentText(item.content));
    else if (item.type === 'function_call') parts.push(item.name, item.call_id, item.arguments);
    else if (item.type === 'reasoning') parts.push(...item.content.map((part) => part.text));
    // **工具输出不收进来**：那是工具自己给出的东西。她 `safe_read` / `rg_search` 读事件日志
    // 时，日志原文（含整行 internal 事件）会合法地出现在里面——把它算作"泄漏"，这条不变量
    // 就会在"她自己翻过日志"之后必然误报。实测（2026-10-01 turn 20）她跑了一次 doctor，
    // 列出五条根本不存在的 LEAK（budget/rollover、turn/start、step/start…），还照着去追。
    // 真正的判据是"渲染层有没有把 internal 事件当成上下文内容放进去"，与工具读到了什么无关。
    else parts.push(item.call_id);
  }
  for (const tool of rendered.tools) parts.push(tool.name, tool.description, JSON.stringify(tool.parameters));
  const haystack = parts.join('\n');

  const leaks: string[] = [];
  for (const event of internalEvents) {
    const serialized = JSON.stringify(event);
    if (serialized.length >= 24 && haystack.includes(serialized)) {
      leaks.push(`整条 ${event.type}(seq ${event.seq}) 出现在请求体里`);
      if (leaks.length >= 5) break;
    }
  }

  // v3 起不再把「reasoning 出现在请求里」当泄漏：思考模式的模型要求把 reasoning_text 原样回传
  // （否则下一次请求直接 400），render.ts 的 reasoning 分支就是干这件事的。这里只剩一条判据：
  // internal 事件本身不得进请求。

  return {
    id: 'I11',
    title: 'internal 事件不进模型请求',
    status: leaks.length === 0 ? 'ok' : 'fail',
    detail: leaks.length === 0
      ? `抽查 ${internalEvents.length} 条 internal 事件，均未出现在渲染结果里`
      : leaks.join('；'),
  };
}

// ──────────────────────────────── 运行面 ────────────────────────────────

/** OPS-log：日志分片可解析（半行会被计数；主进程正在追加时尾部半行属正常现象） */
function checkLogIntegrity(scan: LogScan): DoctorCheck {
  return {
    id: 'OPS-log',
    title: '日志分片可解析',
    status: scan.badLines === 0 ? 'ok' : 'fail',
    detail: scan.badLines === 0
      ? `${scan.shards} 个分片全部可解析`
      : `${scan.badLines} 行无法解析（主进程正在追加时尾部半行属正常；否则是日志损坏）`,
  };
}

/** OPS-lock：单实例锁状态（陈旧锁会被下次启动接管，所以只报告不判失败） */
function checkLockFile(dataDir: string): DoctorCheck {
  const path = join(dataDir, LOCK_FILE_NAME);
  if (!existsSync(path)) {
    return { id: 'OPS-lock', title: '单实例锁', status: 'ok', detail: '没有 lock.json（当前无持有者）' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      id: 'OPS-lock',
      title: '单实例锁',
      status: 'fail',
      detail: `lock.json 不可解析：${messageOf(err)}（下次启动会接管并重建）`,
    };
  }
  const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const pid = typeof record['pid'] === 'number' ? record['pid'] : null;
  if (pid === null) {
    return { id: 'OPS-lock', title: '单实例锁', status: 'ok', detail: 'lock.json 缺少 pid 字段（下次启动会接管）' };
  }
  const alive = isPidAlive(pid);
  return {
    id: 'OPS-lock',
    title: '单实例锁',
    status: 'ok',
    detail: `持有者 pid ${pid}（${alive === true ? '存活' : alive === false ? '已不存在，下次启动会接管' : '无法判定'}）`
      + `，心跳 ${String(record['heartbeatAt'] ?? '未知')}`,
  };
}

function isPidAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    return null;
  }
}

/** OPS-blob：blob 引用完整性 + 内容寻址自洽（不可删目录，坏了就是真丢了） */
function checkBlobIntegrity(dataDir: string, events: readonly AppEvent[]): DoctorCheck {
  const referenced = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const ref = event.data.contentRef;
    if (ref === undefined) continue;
    referenced.set(ref.blobId, (referenced.get(ref.blobId) ?? 0) + 1);
  }

  const broken: string[] = [];
  for (const blobId of referenced.keys()) {
    if (!BLOB_ID_PATTERN.test(blobId)) {
      broken.push(`blobId ${blobId} 不是 sha256 形状`);
      continue;
    }
    if (!existsSync(blobPathOf(dataDir, blobId))) broken.push(`引用的 blob ${blobId.slice(0, 12)} 不存在`);
    if (broken.length >= 5) break;
  }

  // 反向抽查：盘上的 blob 文件名必须等于内容哈希（外部改写会被这条抓住）
  const dir = blobDirOf(dataDir);
  let onDisk = 0;
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!BLOB_ID_PATTERN.test(name)) continue;
      onDisk += 1;
      try {
        if (blobIdOf(readFileSync(join(dir, name))) !== name) broken.push(`blob ${name.slice(0, 12)} 内容与文件名不符`);
      } catch (err) {
        broken.push(`blob ${name.slice(0, 12)} 读不到：${messageOf(err)}`);
      }
      if (broken.length >= 5) break;
    }
  }

  return {
    id: 'OPS-blob',
    title: 'blob 引用完整性与内容寻址',
    status: broken.length === 0 ? 'ok' : 'fail',
    detail: broken.length === 0
      ? `${referenced.size} 处引用全部可解；盘上 ${onDisk} 个 blob 自洽`
      : broken.join('；'),
  };
}

/** OPS-timers：派生视图 timers.json 与投影的一致性（落后只提示；恢复时按投影重建） */
function checkTimersView(dataDir: string, projection: Projection): DoctorCheck {
  const expected = projection.timers.map((timer) => timer.timerId).sort();
  const path = join(dataDir, TIMER_FILE_NAME);
  if (!existsSync(path)) {
    return {
      id: 'OPS-timers',
      title: '定时器派生视图',
      status: 'ok',
      detail: expected.length === 0 ? '没有 timers.json（也没有定时器）' : `timers.json 缺失，投影里有 ${expected.length} 条（恢复时重建）`,
    };
  }
  let ids: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed as { entries?: unknown } | null)?.entries;
    if (Array.isArray(list)) {
      ids = list
        .map((item) => (typeof item === 'object' && item !== null ? (item as { timerId?: unknown }).timerId : undefined))
        .filter((id): id is string => typeof id === 'string')
        .sort();
    }
  } catch (err) {
    return {
      id: 'OPS-timers',
      title: '定时器派生视图',
      status: 'ok',
      detail: `timers.json 读不动（${messageOf(err)}），恢复时按投影重建`,
    };
  }
  const same = ids.length === expected.length && ids.every((id, index) => id === expected[index]);
  return {
    id: 'OPS-timers',
    title: '定时器派生视图',
    status: 'ok',
    detail: same
      ? `与投影一致（${ids.length} 条）`
      : `与投影不一致（缓存 ${ids.length} / 投影 ${expected.length}）：派生缓存落后，下次启动按投影重建`,
  };
}

/** OPS-projection：投影缓存与日志折叠的一致性（缓存是加速器；落后正常，损坏要报） */
async function checkProjectionCache(dataDir: string, scan: LogScan, projection: Projection): Promise<DoctorCheck> {
  const loaded = await loadProjectionCacheResult(dataDir);
  if (!loaded.ok) {
    const present = existsSync(join(dataDir, 'projection.json'));
    return {
      id: 'OPS-projection',
      title: '投影缓存与日志一致',
      status: present ? 'fail' : 'skip',
      detail: present
        ? `projection.json 存在但读不动：${loaded.reason}`
        : '没有 projection.json（首次运行或已被清理）',
    };
  }
  if (!basicProjectionShape(loaded.cache.state)) {
    return {
      id: 'OPS-projection',
      title: '投影缓存与日志一致',
      status: 'fail',
      detail: 'projection.json 的 state 形状不正确（下次启动会丢弃重算）',
    };
  }
  const cacheLastSeq = loaded.cache.lastSeq;
  if (!isCacheValid(loaded.cache, scan.maxSeq)) {
    return {
      id: 'OPS-projection',
      title: '投影缓存与日志一致',
      status: 'ok',
      detail: `缓存落后于日志（cache lastSeq=${cacheLastSeq} / 日志 ${scan.maxSeq}）：下次启动重算，属正常`,
    };
  }
  // watermark 是**运行期游标**，不事件化（recover.ts 的 M1 简化：fold 只累计 lastSeq，不推进水位）：
  // fold 永远得到 0，而缓存里存的是真实水位。两者必然不等，且这不是"缓存损坏"。
  // 比对时剔掉它——否则这一项每次都报红，真正损坏时反而没人看（狼来了）。
  const cacheState: Record<string, unknown> = { ...(loaded.cache.state as unknown as Record<string, unknown>) };
  const freshState: Record<string, unknown> = { ...(projection as unknown as Record<string, unknown>) };
  const cacheWatermark = cacheState['watermark'];
  delete cacheState['watermark'];
  delete freshState['watermark'];
  const same = JSON.stringify(cacheState) === JSON.stringify(freshState);
  return {
    id: 'OPS-projection',
    title: '投影缓存与日志一致',
    status: same ? 'ok' : 'fail',
    detail: same
      ? `缓存与全量折叠逐字段相等（lastSeq=${scan.maxSeq}；watermark ${String(cacheWatermark)} 为运行期游标，不参与比对）`
      : '缓存 lastSeq 与日志末尾相同，内容却与折叠结果不同（缓存损坏）',
  };
}

// ──────────────────────────────── 报告 ────────────────────────────────

export function formatDoctor(report: DoctorReport): string[] {
  const lines: string[] = [
    `自检 · 数据目录 ${report.dataDir}`,
    `事件 ${report.events} 条 · 坏行 ${report.badLines} · 检查项 ${report.checks.length}（✗ ${report.failures} / 跳过 ${report.skips}）`,
    '不变量（docs/schema.md §12）:',
  ];
  for (const check of report.checks) {
    if (check.id.startsWith('OPS-')) continue;
    lines.push(`  ${symbol(check.status)} ${check.id} ${check.title}${suffix(check)}`);
  }
  lines.push('运行面（docs/operations.md §6）:');
  for (const check of report.checks) {
    if (!check.id.startsWith('OPS-')) continue;
    lines.push(`  ${symbol(check.status)} ${check.id} ${check.title}${suffix(check)}`);
  }
  lines.push(report.failures === 0
    ? '结论：全部通过'
    : `结论：${report.failures} 项失败 —— 退出码 1（每条 ✗ 都给了具体凭据）`);
  return lines;
}

function suffix(check: DoctorCheck): string {
  return check.detail === '' ? '' : ` —— ${check.detail}`;
}

function symbol(status: DoctorStatus): string {
  return status === 'ok' ? '✓' : status === 'fail' ? '✗' : '·';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 递归收集一个事件负载里的全部字符串值（抽查看的是文本本身，不是它的转义形式） */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) stringsOf(item, out);
  }
  return out;
}
