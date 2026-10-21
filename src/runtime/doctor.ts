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
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatExact, formatPercent } from '../format/units.ts';
import type { AppEvent, Projection } from '../log/types.js';
import { readEventsReadOnly, type LogScan } from '../log/read-only.ts';
import { readCompactionWarnings } from '../model/compaction-warning.ts';
import { costSegmentsDoctorDetail, formatStamp, readCostSegments } from '../model/cost-segments.ts';
import { inputContentText, render } from '../model/render.ts';
import { sha256Hex } from '../persona/versions.ts';
import { BLOB_ID_PATTERN, blobDirOf, blobIdOf, blobPathOf } from '../state/blob-store.ts';
import { applyEvent, budgetTokensOf, finalizePressure, fold } from '../state/fold.ts';
import { basicProjectionShape, isCacheValid, loadProjectionCacheResult } from '../state/projection-cache.ts';
import { EVENT_LOG_DIR_NAME, TIMER_FILE_NAME } from './recover.ts';
import { LOCK_FILE_NAME } from './instance-lock.ts';
import { cacheAlertDoctorDetail, percentText, planCacheAlerts } from './cache-alert.ts';
import { echoPressureDoctorDetail, planEchoPressure, readEchoPressure } from './reasoning-echo-pressure.ts';

// ──────────────────────────────── 对外类型 ────────────────────────────────

export type DoctorStatus = 'ok' | 'fail' | 'skip' | 'warn' | 'info';

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
  /** `warn` 级（不是不变量失败，而是**运行环境的坏习惯**，例如 `%TEMP%` 落在 C:\Windows\Temp） */
  warnings: number;
  /**
   * `info` 级（**常驻读数**，例如 `OPS-cost-segments` 的段占比）：既不是通过、也不是失败，
   * 它不进退出码、也不该被读成"有毛病"——只是把此刻的形状摆在报告里（判据见
   * `checkCostSegments`）。
   */
  infos: number;
  /** 扫描到的事件总数（报告头部用） */
  events: number;
  badLines: number;
}

// ──────────────────────────────── 主入口 ────────────────────────────────

export async function runDoctor(dataDir: string): Promise<DoctorReport> {
  const scan = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME));
  const events = scan.events;
  const projection = fold(events);
  // `OPS-cache-miss` 的"现在"（理由见 `cacheMissClockOf`）
  const clock = cacheMissClockOf(events);

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
    checkTempDirLocation(),
    checkCacheMiss(events, clock.nowMs, clock.clockNote),
    checkEchoPressure(events),
    // 2026-10-21 加的两条**成本读数**：压缩线现在用到几成 / 最近一次预警是哪一档，
    // 以及"这一段钱花在哪些段上"（段归因）。都不是不变量：一条 ok、一条 info，不进退出码。
    checkCompactionReading(events),
    checkCostSegments(events),
    await checkProjectionCache(dataDir, scan, projection),
  ];

  return {
    dataDir,
    checks,
    failures: checks.filter((check) => check.status === 'fail').length,
    skips: checks.filter((check) => check.status === 'skip').length,
    warnings: checks.filter((check) => check.status === 'warn').length,
    infos: checks.filter((check) => check.status === 'info').length,
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

/**
 * OPS-tempdir：**`os.tmpdir()` 落在哪里**（2026-10-21，外部审计那一件的最后一格）。
 *
 * 为什么这在 doctor 里值一格：`%TEMP%` 落在 `C:\Windows\Temp` 或系统盘根时，本机的
 * 临时文件就与**全机所有程序**的垃圾混在一起——安装器 stage、引导器失败现场、测试夹具
 * 都往那儿扔，谁都不敢清（也查不清是谁的）。审计现场那 5680 个 `irmia-*` / 7.81GB
 * 正是这么攒起来的。这不是一个不变量（数据没错、日志没错），所以判 `warn` 而不是 `fail`：
 * 它不该让 `doctor` 退出码变非 0，但它**必须**在报告里显眼，并给出能照着敲的修法。
 *
 * 只认两条判据（不猜别的"坏习惯"）：`<系统盘>:\Windows\Temp` 与系统盘根 `<系统盘>:\`。
 * 非 Windows 平台直接 `skip`（这条判据是 Windows 的形状）。
 */
export function checkTempDirLocation(): DoctorCheck {  const dir = tmpdir();
  if (process.platform !== 'win32') {
    return {
      id: 'OPS-tempdir',
      title: '临时目录落点',
      status: 'skip',
      detail: `非 Windows（os.tmpdir() = ${dir}）：这条判据只针对 Windows 的共享 TEMP`,
    };
  }
  const normalized = dir.replace(/[\\/]+$/u, '').toLowerCase();
  const systemDrive = (process.env['SystemDrive'] ?? 'C:').toLowerCase().replace(/[\\/]+$/u, '');
  const problem = normalized === `${systemDrive}\\windows\\temp`
    ? `落在 ${systemDrive.toUpperCase()}\\Windows\\Temp（全机共享的临时目录）`
    : normalized === systemDrive
      ? `落在系统盘根 ${systemDrive.toUpperCase()}\\（临时文件会堆在盘根）`
      : '';
  if (problem === '') {
    return { id: 'OPS-tempdir', title: '临时目录落点', status: 'ok', detail: `os.tmpdir() = ${dir}` };
  }
  return {
    id: 'OPS-tempdir',
    title: '临时目录落点',
    status: 'warn',
    detail: `os.tmpdir() = ${dir}，${problem}。建议改到用户自己的临时目录（**新开**终端/重启本程序后生效）：`
      + 'setx TEMP "%LOCALAPPDATA%\\Temp"；setx TMP "%LOCALAPPDATA%\\Temp"',
  };
}

/**
 * `OPS-cache-miss` 的"现在"：**日志末尾时刻**（解析不出来才退回墙钟，并在读数里如实说明）。
 *
 * 为什么不直接用 `Date.now()`：doctor 最常被用在"翻几周前的日志"这个场景上，
 * 而"过去 24 小时的基线"是相对"现在"取的——拿墙钟当现在，那一整段基线就是空的，
 * 这条判据会永远停在 `no-baseline`（"看起来没事"）。日志末尾才是这份数据自己的"现在"。
 */
function cacheMissClockOf(events: readonly AppEvent[]): { nowMs: number; clockNote: string } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const parsed = Date.parse(events[index]!.ts);
    if (Number.isFinite(parsed)) return { nowMs: parsed, clockNote: '' };
  }
  return { nowMs: Date.now(), clockNote: '（日志没有可用时间戳："现在"退回墙钟）' };
}

// ──────────────────────────────── OPS-cache-miss ────────────────────────────────

/**
 * **OPS-cache-miss：缓存未命中率（滑动窗口）**——`warn` 级，**不进退出码**。
 *
 * 这一条回答的是用户 2026-10-21 那个问句：「我注意到**缓存未命中在暴涨**。并且**框架没有任何警告**」
 * 「只是今天明显是大量未命中了，但我并没有看见告警」。
 *
 * ## 它为什么必须是 `warn` 而不是 `fail`
 *
 * 未命中率高**不是数据坏了**：日志一致、投影一致、请求也发得出去，只是每一拍都在重编码前缀，
 * 于是钱多花了 5 倍。这与 `OPS-tempdir`（`%TEMP%` 落在 `C:\Windows\Temp`）是同一档
 * ——"运行环境的坏习惯/代价"，不是不变量失败。`formatDoctor` 的 `!` 行与
 * "不影响退出码"那句话就是给它用的（判据见 `checkTempDirLocation` 的注释）。
 *
 * ## 判据从哪来：**同一个函数**，不是同一段代码抄两遍
 *
 * 走 `runtime/cache-alert.ts` 的 `planCacheAlerts`——与运行期那条 `budget/cache-alert`、
 * 控制台一行、真唤醒**同一条判据**。两处各写一遍的代价是"doctor 说没事、控制台在喊"，
 * 而这个仓库吃过太多次"同一个指标两个阈值"的亏（`render.ts` 的 `cacheHitIsLow` 与
 * `web/server.ts` 的 `CACHE_HIT_LOW` 就是当年为了对齐才互相引用的）。
 *
 * ## 两处与运行期**刻意不同**的地方
 *
 *   · **不去重**（`respectDedupe: false`）：doctor 回答的是"**现在健不健康**"，
 *     不是"要不要再叫一次"。拿 24 小时去重把 doctor 压成 `ok`，等于把一条正在恶化的
 *     现状藏起来——那正是这一整件事的起因；
 *   · **"现在"取日志末尾时刻**，不是墙钟：doctor 读的可能是几周前的日志，
 *     用 `Date.now()` 会让"过去 24 小时的基线"永远是空的（于是永远 `no-baseline`）。
 *     日志解析不出时间戳时才退回墙钟，并在 detail 里如实写"按墙钟"。
 *
 * 读数与那两处**逐字同源**（`cacheAlertReadings`）：同一条判据吐出同一句话，
 * 人不必在两个界面上自己对齐。
 */
export function checkCacheMiss(events: readonly AppEvent[], nowMs: number, clockNote: string): DoctorCheck {
  const title = '缓存未命中率（滑动窗口）';
  const verdicts = planCacheAlerts({ events, nowMs, respectDedupe: false });
  const withReading = verdicts.filter(verdict => verdict.reading !== null);
  if (withReading.length === 0) {
    return { id: 'OPS-cache-miss', title, status: 'skip', detail: '日志里没有 budget/consumed，读不出缓存命中率' };
  }
  const fired = withReading.filter(verdict => verdict.fired);
  // 主行读：先看响了的，再按未命中率取最高的一条（两条 lane 里更贵的那条）
  const primary = (fired.length > 0 ? fired : withReading).reduce((a, b) =>
    (b.reading?.missRatio ?? -1) > (a.reading?.missRatio ?? -1) ? b : a);
  const reading = primary.reading;
  if (reading === null) {
    return { id: 'OPS-cache-miss', title, status: 'skip', detail: '日志里没有 budget/consumed，读不出缓存命中率' };
  }
  // 另一条 lane 的读数也带上：只看最贵的那条会漏掉"另一条刚越线"
  const others = withReading
    .filter(verdict => verdict.reading !== null && verdict.reading.lane !== reading.lane)
    .map(verdict => `${verdict.reading!.lane} ${percentText(verdict.reading!.missRatio)}`);
  const suffixOther = others.length === 0 ? '' : `；另一条 ${others.join('、')}`;
  const detail = cacheAlertDoctorDetail(reading, primary.why) + suffixOther + clockNote;
  if (fired.length > 0) return { id: 'OPS-cache-miss', title, status: 'warn', detail };
  // 没响也要分两种：**判过了但在线内**（ok）与 **判不出来**（skip）。
  // 合成一种会让"样本不够"读起来像"数值健康"——那是 `planCacheAlert` 出口顺序想避免的同一件事。
  const undecidable = primary.why === 'too-few-turns'
    || primary.why === 'no-token-sample'
    || primary.why === 'no-baseline';
  return { id: 'OPS-cache-miss', title, status: undecidable ? 'skip' : 'ok', detail };
}

// ──────────────────────────────── OPS-echo-pressure ────────────────────────────────

/**
 * **OPS-echo-pressure：思维链回传压力**（`回传字符 / 上限`）——`warn` 级，**不进退出码**。
 *
 * 这是 **`OPS-cache-miss` 的上游**，也是 2026-10-21 那场成本暴涨的**根因面**：
 * 回传字符顶穿 `REASONING_ECHO_POLICY.maxTotalChars` 之后，每一笔请求都会挤掉最老的一个
 * assistant 组 ⇒ 历史头部每笔位移 ⇒ 每笔都重编码前缀（实测 92% 未命中、单小时开销翻 3 倍多）。
 * 顶穿之前一定会先在 90% 附近停一阵——**那一段是唯一能救的窗口**，所以这条要单独一行、
 * 而且排在那条结果判据前面读。
 *
 * 两条与运行期**刻意不同**（与 `checkCacheMiss` 逐字同一条理由）：
 *   · **不去重**：doctor 回答"现在健不健康"，不是"要不要再叫一次"；
 *   · **"现在"**：本判据其实**不需要**"现在"——它读的是日志末尾那一份渲染状态
 *     （`readEchoPressure` 只看 `compaction/summary` 与 `model/reasoning-echo`），
 *     所以这里连时钟都不传，`doctor` 跑在几周前的日志上也给同一个答案。
 *
 * `skip` 而不是 `ok` 的两种：没有上限（判据没对象）、没有思维链（比例算不出来）——
 * 与 `ok`（真读过、在线内）分开，否则"没数据"会被读成"很健康"。
 */
export function checkEchoPressure(events: readonly AppEvent[]): DoctorCheck {
  const title = '思维链回传压力（顶穿前兆）';
  const signals = readEchoPressure(events);
  const verdict = planEchoPressure(signals, { nowMs: 0, events, respectDedupe: false });
  const detail = echoPressureDoctorDetail(signals, verdict.ratio, verdict.why);
  if (verdict.fired) return { id: 'OPS-echo-pressure', title, status: 'warn', detail };
  const undecidable = verdict.why === 'no-cap' || verdict.why === 'no-sample';
  return { id: 'OPS-echo-pressure', title, status: undecidable ? 'skip' : 'ok', detail };
}

// ──────────────────────────────── OPS-compaction ────────────────────────────────

/**
 * **OPS-compaction：压缩线的常驻读数**——`ok`（没有读数时 `skip`），**不进退出码**。
 *
 * 它回答用户 2026-10-21 那一问的两个数：**估算线现在用到几成**、**最近一次预警是什么时候哪一档**。
 * 两个数**都是日志里的既成事实**（`compaction/decision` 的 `historyTokens` / `thresholdTokens`
 * 与 `warning.fired/tier`），复算走 `model/compaction-warning.ts` 的同一份
 * `readCompactionWarnings`（运行期判据 + doctor 读数一个口径，别在这里重写一套阈值）。
 *
 * 为什么 `ok` 而不是 `warn`：越到 95% 一档也不等于"坏了"——压缩可能刚好在下一拍就压成，
 * 而"该不该预警"的判据在运行期（那条真唤醒），doctor 只把形状摆出来。真正要人动手的
 * 是 `OPS-cache-miss` / `OPS-echo-pressure` 那两条（warn 级，各有一条成本判据）。
 *
 * 真实/估算那一截（`inputTokens` / `estimatedInputTokens`）只有 2026-10-21 之后的日志才有；
 * 老日志没有就不印——不猜、也不换算（换算会悄悄挪动压缩阈值）。
 */
export function checkCompactionReading(events: readonly AppEvent[]): DoctorCheck {
  const title = '压缩线读数（估算用到几成 / 最近一次预警）';
  const readout = readCompactionWarnings(events);
  const latest = readout.latest;
  if (
    latest === null
    || latest.historyTokens === null
    || latest.thresholdTokens === null
    || latest.thresholdTokens <= 0
  ) {
    return {
      id: 'OPS-compaction',
      title,
      status: 'skip',
      detail: '日志里没有可用的 compaction/decision 读数（还没有跑过压缩点的轮次）',
    };
  }
  const used = latest.historyTokens / latest.thresholdTokens;
  const parts = [
    `估算线用到 ${formatPercent(used)}（${formatExact(latest.historyTokens)} / `
    + `${formatExact(latest.thresholdTokens)}，seq ${latest.seq} · turn ${latest.turn}）`,
  ];
  const fired = readout.lastFired;
  if (fired === null || fired.firedTier === null) {
    parts.push('还没报过压缩预警');
  } else {
    parts.push(
      `最近一次预警 ${formatStamp(fired.ts)} 第 ${fired.firedTier} 档（seq ${fired.seq}）`
      + `；当前周期最高 ${readout.state.lastTier} 档`,
    );
  }
  const real = readout.lastReal;
  if (real !== null && real.real !== null) {
    const ratio = real.real.estimatedInputTokens > 0
      ? real.real.inputTokens / real.real.estimatedInputTokens
      : 0;
    parts.push(
      `真实 ${formatExact(real.real.inputTokens)} / 估算 ${formatExact(real.real.estimatedInputTokens)}`
      + ` = ${ratio.toFixed(2)}×（seq ${real.seq}）`,
    );
  }
  return { id: 'OPS-compaction', title, status: 'ok', detail: parts.join('；') };
}

// ──────────────────────────────── OPS-cost-segments ────────────────────────────────

/**
 * **OPS-cost-segments：段归因的常驻读数**——`info` 级（读不到时 `skip`），**不进退出码**。
 *
 * 它回答"这一段钱花在哪些段上"：`history` / 此刻层 / 固定块 / `instructions` / `tools` /
 * `summary` / `wake` 的占比（用户 2026-10-21 点名的七格），读数来自渲染层每步记下的
 * `budget/consumed.context`（`model/context-audit.ts` 的段事实），聚合只有一处实现
 * （`model/cost-segments.ts`，`tools/cost-segments.ts` 与这里共用）。
 *
 * **为什么是 `info` 而不是 `ok`**：它不是一条"通过/不通过"的判据——占比没有对错，
 * 只有"这一刻长什么样"。写成 `ok` 会让人误以为"检查过了、没问题"，写成 `warn` 会天天报警
 * 把真正的成本告警（`OPS-cache-miss`）淹掉。`info` 在报告里照常显示，但不进
 * `failures` / `warnings`，也**不进退出码**（判据与 `OPS-tempdir` 的 `warn` 同一层理由）。
 */
export function checkCostSegments(events: readonly AppEvent[]): DoctorCheck {
  const title = '段归因（成本按段拆开）';
  const reading = readCostSegments(events);
  const detail = costSegmentsDoctorDetail(reading);
  if (reading.rows === 0) {
    return { id: 'OPS-cost-segments', title, status: 'skip', detail };
  }
  return { id: 'OPS-cost-segments', title, status: 'info', detail };
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
    `事件 ${report.events} 条 · 坏行 ${report.badLines} · 检查项 ${report.checks.length}（✗ ${report.failures}`
      + ` / ! ${report.warnings} / ℹ ${report.infos} / 跳过 ${report.skips}）`,
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
  // `!` 是**运行环境的坏习惯**，不是不变量失败：它不进退出码（判据见 `checkTempDirLocation`），
  // 但"全部通过"这句话旁边必须有一行说明，不能让人把 `!` 读成装饰。
  if (report.warnings > 0) {
    lines.push(`注意：${report.warnings} 项运行环境警告（! 行，不影响退出码）——按那一行的建议改完再跑一次`);
  }
  // `ℹ` 是**常驻读数**（不是通过、也不是失败）：它照常出现在报告里，但不进退出码。
  // 单独一行说明它，否则人会把它读成"有毛病"（与 `!` 行旁边那句话同一条理由）。
  if (report.infos > 0) {
    lines.push(`信息：${report.infos} 项常驻读数（ℹ 行，不影响退出码）——它们是"此刻的形状"，不是结论`);
  }
  return lines;
}

function suffix(check: DoctorCheck): string {
  return check.detail === '' ? '' : ` —— ${check.detail}`;
}

function symbol(status: DoctorStatus): string {
  return status === 'ok'
    ? '✓'
    : status === 'fail'
      ? '✗'
      : status === 'warn'
        ? '!'
        : status === 'info'
          ? 'ℹ'
          : '·';
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
