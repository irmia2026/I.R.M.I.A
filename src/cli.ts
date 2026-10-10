/**
 * Irmia Agent — CLI（docs/operations.md §6 的 M1–M4 子集：wake / topup / status）
 *
 * `status` 的输出即 milestones.md M4-7 的验收面：水位、待办数、今日消耗、待确认数、锁信息
 * 五要素齐全——四要素来自投影（日志只读折叠），锁信息来自 data/lock.json。
 *
 * 一条硬纪律：**CLI 不持事件日志写句柄，除非确认没有第二个写者**。主进程已经在跑，两个进程各自
 * 分配 seq 必然撞号（撞号的日志下次启动会被 EventLog.open 判为「重复 seq」而拒绝启动，
 * 等于一次 CLI 操作把整个实例搞停）。因此：
 *   `wake` 只往看门目录写文件，由主进程的 manual 源拾取转成 `wake/manual`；
 *   `topup` 同理——写 `<dataDir>/topup/topup-<ts>.json`，由真循环拾取后落成 `budget/topped-up`；
 *   `review resolve` 是人给一次事故定性，事件必须当场进日志（不能等下一拍），所以它**真的写日志**：
 *     写之前先探锁，主进程活着就拒绝（退出码 3）——这是「不撞号」与「立即落盘」两条要求的唯一交集；
 *   `status` / `tail` / `review list` / `budget` 全部只读：扫描分片而不调用 EventLog.open——
 *     那会触发末行自愈，在主进程正追加时截断它的行是不可接受的副作用。
 *
 * 于是 CLI 的副作用清单只有三个：写 `watch/wake-<ts>.json`、写 `topup/topup-<ts>.json`、
 * 在无人持锁时写一条 `review/resolved`。
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { AppEvent, BudgetLayer, Projection, TurnEndReason, WakeSource } from './log/types.js';
import { defaultVisibility } from './log/types.ts';
import { CONFIG_FILE_NAME, defaultConfig, loadConfig, type BudgetConfig } from './config/config.ts';
import { DEFAULT_DATA_DIR_NAME } from './main.ts';
import { EventLog } from './log/event-log.ts';
import {
  readEventsReadOnly, readRangeEvents, readTailEvents, type LogScan, type TailScan,
} from './log/read-only.ts';
import { writePersonaAsset } from './persona/loader.ts';
import { ownerPersonOf } from './persona/relationship.ts';
import {
  diffLines, diffStats, formatDiffLines, isDiffHashPrefix, listPersonaVersions, normalizePersonaFile,
  readPersonaVersion, resolveDiffHashPrefix, sha256Hex, versionPathOf, writePersonaVersion,
  type DiffLine, type DiffStats,
} from './persona/versions.ts';
import {
  buildReplayReport, formatReplaySummary, formatRequestDiff, jsonBytes as jsonBytesOf,
} from './runtime/replay.ts';
import { formatDoctor, runDoctor } from './runtime/doctor.ts';
import { BudgetGuard, pickSoftRatio } from './runtime/budget-guard.ts';
import { LOCK_FILE_NAME } from './runtime/instance-lock.ts';
import {
  jobOutputBytes, readJobHistory, readJobIndex, readJobOutput, type JobRecord,
} from './runtime/job-manager.ts';
import { EVENT_LOG_DIR_NAME } from './runtime/recover.ts';
import { SkillManager, type SkillTrustState } from './skill/skills.ts';
import { foldTopUps, writeTopUpRequest, type TopUpRequest, type TopUpTotals } from './runtime/topup.ts';
import { answerHuman, type AnswerOutcome } from './runtime/plan-mode.ts';
import { isCacheValid, loadProjectionCacheResult, PROJECTION_CACHE_FILE } from './state/projection-cache.ts';
import { fold } from './state/fold.ts';
import { formatWithExact } from './format/units.ts';
import { WAKE_FILE_PREFIX, WAKE_WATCH_DIR_NAME } from './wake/sources.ts';

// 只读扫描的唯一实现在 log/read-only.ts：CLI 与 doctor 共用，避免"两套解析各说各话"
export type { LogScan, TailScan };

// ──────────────────────────────── 常量 ────────────────────────────────

export const USAGE: readonly string[] = [
  '用法：irmia <命令>',
  '  wake --note "..." [--dedupe-key K]   注入一次手动唤醒（写看门文件，主进程拾取）',
  '  topup --layer <L> --tokens N [--by B] 人工加注预算，解除该层暂停（L = step|turn|task|daily）',
  '  status [--json]                       打印水位 / 待办 / 今日消耗 / 待确认 / 锁',
  '  tail [--type T] [--limit N]           打印日志尾部事件（T 是类型前缀：tool/ wake/ budget/ …）',
  '  review list                           打印待确认调用明细（callId / 名称 / 时刻 / turn / step）',
  '  review resolve <callId> --outcome <succeeded|failed|partial> [--note "..."] [--by B]',
  '                                        给人给的定性落成 review/resolved 事件（要求主进程未运行）',
  '  answer <文本> [--callId <id>] [--by B] 答复人审（她问的卡或待批准的计划；approve = 批准待批计划）',
  '                                        要求主进程未运行，重启后输入自动重入队；',
  '                                        台面上只有一条提问时可以不带 --askSeq',
  '  answer <文本> --askSeq <n> [--by B]   指定答复哪一条提问（seq 见 status 的"她在问"那段）',
  '  budget [--today]                      打印 heavy/light 消耗、缓存命中率、距软/硬阈值比例',
  '  jobs [--list] [--json]                列出后台任务（含上一个进程跑过的；有运行中/丢失时退出码 1）',
  '  jobs <jobId> [--full] [--out F]       查看某个任务的输出（默认尾部 200 行；--out 导出到文件）',
  '  persona log [--json]                  人格演化时间线（persona/updated 倒序：时刻 · 文件 · 谁改的）',
  '  persona diff <file> [--full]          当前内容与上一版本快照的行级差异（读 data/.versions/）',
  '  persona rollback <file> <diffHash> [--by B]',
  '                                        按版本库快照回滚人格文件并记 persona/updated{by:human}',
  '  skill list                            列出技能目录与其信任状态（已生效 / 待确认 / 被拒绝）',
  '  skill confirm <name> [--by B]         人类确认一个技能：写 skill/installed{by:human}（要求主进程未运行）',
  '  replay <turn> <step> [--out F] [--diff]',
  '                                        重建该次模型请求体（日志 + 三指纹）；--diff 与当前口径并排对照',
  '  export --from <seq> --to <seq> [--out F]',
  '                                        导出 seq 区间的日志段（JSONL，可用于复盘与取证）',
  '  doctor [--json]                       全量自检 schema §12 的 11 条不变量 + 运行面；有 ✗ 退出码 1',
  '  --help                                打印本帮助',
];

/** 看门文件名撞车时的重试上限（同毫秒多次注入） */
const MAX_NAME_ATTEMPTS = 1000;
/** tail 默认输出条数（人眼看着够用，机器请用 --limit） */
const DEFAULT_TAIL_LIMIT = 20;
/** 摘要单行上限：超出截断，保证一条事件恒占一行 */
const SUMMARY_MAX_CHARS = 100;

/**
 * 层序（越靠前越"紧"）与中文标签，与 budget-guard.ts 同口径。
 */
const BUDGET_LAYERS: readonly BudgetLayer[] = ['step', 'turn', 'task', 'daily'];
const LAYER_LABEL: Record<BudgetLayer, string> = {
  step: '单步', turn: '单轮', task: '单任务', daily: '每日',
};
/**
 * 四层的单位。`step`/`turn` 数的是**次数**，`task`/`daily` 数的是 token——后两档必须写清是
 * **非缓存** token（`state/fold.ts` 的 `budgetTokensOf` 是唯一口径定义）：CLI 是给人读的，
 * 数与单位必须一起说清——只写 `token` 会让人以为那是全部 token（换口径前它确实是）。
 */
const LAYER_UNIT: Record<BudgetLayer, string> = {
  step: '次工具调用', turn: '步', task: '非缓存 token', daily: '非缓存 token',
};

// ──────────────────────────────── 对外类型 ────────────────────────────────

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
}

export interface CliContext {
  dataDir: string;
  now?: () => Date;
  /** 配置目录（config.json 的父目录）；缺省 process.cwd()。测试与嵌入方注入用 */
  cwd?: string;
  /** 预算上限覆盖点（测试注入小阈值用）；缺省读 config.json，读不到用内置默认 */
  budget?: BudgetConfig;
}

export interface StatusReport {
  dataDir: string;
  events: { shards: number; maxSeq: number; badLines: number };
  /** 投影缓存与日志的一致性：命中 / 过期 / 缺失 / 损坏 */
  cache: { state: 'hit' | 'stale' | 'missing' | 'corrupt'; lastSeq: number | null };
  /** 今日消耗（M4-7 五要素之一；operations.md §6 要求 hit/miss 分列） */
  budget: {
    tokensToday: number;
    tokensTodayHeavy: number;
    tokensTodayLight: number;
    cacheHitToday: number;
    cacheMissToday: number;
  };
  watermark: number;
  pending: { total: number; bySource: Record<string, number> };
  openTurn: { turn: number; step: number } | null;
  timers: { total: number; nextAt: string | null };
  needsReview: number;
  deadLetters: number;
  /**
   * **她在问**、还没答复的提问（design §6）：队首一张 + 后面排队的条数。
   *
   * 为什么放进 status：`answer --askSeq` 要有一个能查到 seq 的地方，而"她问了什么"本来
   * 就是运维最该一眼看到的三件事之一（与待确认、挂起并列）——它不影响水位，但影响人什么时候
   * 走过去答一句。
   */
  asks: {
    card: { seq: number; question: string; at: string; expiredAt: string | null } | null;
    queued: number;
  };
  lock: {
    present: boolean;
    pid: number | null;
    startedAt: string | null;
    heartbeatAt: string | null;
    /** pid 探活；null = 锁文件没有可用 pid */
    alive: boolean | null;
  };
}

export interface WakeNoteInput {
  note: string;
  dedupeKey?: string;
  /**
   * 带人唤醒：本机用户戳她时写 `config.persona.owner`，于是对应关系档案注入。
   * `--person ""` 显式关掉（脚本注入不需要“某个人”在场）。
   */
  person?: string;
}

// ──────────────────────────────── tail / review / budget 类型 ────────────────────────────────

export type ReviewOutcome = 'succeeded' | 'failed' | 'partial';

export interface ReviewEntry {
  callId: string;
  /** 发起该调用的工具名；日志里找不到 tool/call 时为 null（不编造名字） */
  name: string | null;
  /** 该调用进入待确认的时刻（tool/result 事件的 ts） */
  at: string;
  /** 归属 turn / step；恢复期补写的 unknown 结果可能只有 turn，找不到则为 null */
  turn: number | null;
  step: number | null;
}

export interface ResolveReviewInput {
  callId: string;
  outcome: ReviewOutcome;
  note: string;
  by: string;
}

/** 结案结果：ok=false 时 code 即进程退出码（2 参数/目标错，3 主进程在跑） */
export type ResolveReviewResult =
  | { ok: true; seq: number }
  | { ok: false; code: number; error: string };

export interface BudgetLayerReport {
  layer: BudgetLayer;
  used: number;
  /** 有效硬上限 = 配置上限 + 人工加注累计（加注抬高上限，不清零消耗） */
  limit: number;
  /** 已用 / 硬上限 */
  hardRatio: number;
  /** 软阈值 = 硬上限 × softRatio */
  softLimit: number;
  /** 已用 / 软阈值 */
  softRatio: number;
  over: boolean;
  soft: boolean;
}

export interface BudgetReport {
  dataDir: string;
  /**
   * 今日累计：**非缓存口径**（2026-10-05 用户换的：`(input − cacheHit) + output`，
   * "真花钱的那部分"；唯一一处定义在 `state/fold.ts` 的 `budgetTokensOf`）。
   * `heavy` / `light` 是同一个口径按 lane 分列；`cacheHit` / `cacheMiss` 是**原始分量**
   *（照事件原样折，喂"缓存命中率"那条观测），别拿它们去和 `tokens` 对账——`tokens` 不含命中那部分。
   */
  today: {
    tokens: number;
    heavy: number;
    light: number;
    cacheHit: number;
    cacheMiss: number;
    /** 命中率 = hit/(hit+miss)；两者都是 0 时为 null——"没有样本"与"0% 命中"是两件事 */
    hitRate: number | null;
  };
  /** 单任务累计（非缓存口径，同上） */
  taskTokens: number;
  topUps: TopUpTotals;
  layers: BudgetLayerReport[];
  /** 上限来源：config.json / 内置默认 / 调用方注入 */
  limitSource: 'file' | 'default' | 'injected';
}

// ──────────────────────────────── 只读扫描 ────────────────────────────────

/**
 * 全量只读扫描（实现见 log/read-only.ts）：不修复、不截断、不写盘。
 * 主进程此刻正在追加时，最坏情况是读到写了一半的尾行——计入 badLines，不影响其余事件。
 */

/**
 * 缓存新鲜度。判定条件直接复用 state/projection-cache.ts 的 isCacheValid
 * （唯一条件：缓存 lastSeq 与日志末尾严格相等），避免两处口径漂移。
 */
async function readCacheState(dataDir: string, logMaxSeq: number): Promise<StatusReport['cache']> {
  const loaded = await loadProjectionCacheResult(dataDir);
  if (!loaded.ok) {
    // 读失败要区分「文件不在」与「文件在但读不懂」：后者是需要人看一眼的损坏
    const present = existsSync(join(dataDir, PROJECTION_CACHE_FILE));
    return { state: present ? 'corrupt' : 'missing', lastSeq: null };
  }
  const cache = loaded.cache;
  return { state: isCacheValid(cache, logMaxSeq) ? 'hit' : 'stale', lastSeq: cache.lastSeq };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但没有信号权限，仍按存活处理
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockFile(path: string): StatusReport['lock'] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { present: false, pid: null, startedAt: null, heartbeatAt: null, alive: null };
  }
  const empty: StatusReport['lock'] = { present: true, pid: null, startedAt: null, heartbeatAt: null, alive: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (typeof value !== 'object' || value === null) return empty;
  const obj = value as Record<string, unknown>;
  const pid = obj['pid'];
  const startedAt = obj['startedAt'];
  const heartbeatAt = obj['heartbeatAt'];
  const pidValue = typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  return {
    present: true,
    pid: pidValue,
    startedAt: typeof startedAt === 'string' ? startedAt : null,
    heartbeatAt: typeof heartbeatAt === 'string' ? heartbeatAt : null,
    alive: pidValue === null ? null : isPidAlive(pidValue),
  };
}

/**
 * 状态报告。水位与待办由**日志只读折叠**得出（权威），缓存只用来报告"是否命中"——
 * 于是删掉 projection.json 或缓存过期时 status 仍然说得对，只是慢一点。
 */
export async function buildStatusReport(dataDir: string): Promise<StatusReport> {
  const scan = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME));
  const projection: Projection = fold(scan.events);
  const cache = await readCacheState(dataDir, scan.maxSeq);
  const lock = readLockFile(join(dataDir, LOCK_FILE_NAME));

  const bySource: Record<string, number> = {};
  for (const item of projection.pending) {
    const source: WakeSource = item.source;
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  // 与 runtime/loop.ts 的 advanceWatermark 同口径：有未消化输入就停在最早一条之前，
  // 否则水位 = 日志最大 seq（空洞跳过）
  const watermark = projection.pending.length > 0
    ? Math.min(...projection.pending.map((item) => item.wakeSeq)) - 1
    : scan.maxSeq;

  let nextAt: string | null = null;
  for (const timer of projection.timers) {
    const at = timer.at;
    if (at === undefined) continue;
    if (nextAt === null || Date.parse(at) < Date.parse(nextAt)) nextAt = at;
  }

  return {
    dataDir,
    events: { shards: scan.shards, maxSeq: scan.maxSeq, badLines: scan.badLines },
    cache,
    // 今日消耗只从投影读：它是「最近一条 budget/rollover 之后的 budget/consumed 之和」，
    // 折叠口径在 fold.ts，CLI 不另算一份（M4-7 与前端仪表盘共用同一组查询语义）
    budget: {
      tokensToday: projection.budget.tokensToday,
      tokensTodayHeavy: projection.budget.tokensTodayHeavy,
      tokensTodayLight: projection.budget.tokensTodayLight,
      cacheHitToday: projection.budget.cacheHitToday,
      cacheMissToday: projection.budget.cacheMissToday,
    },
    watermark,
    pending: { total: projection.pending.length, bySource },
    openTurn: projection.openTurn === null ? null : { ...projection.openTurn },
    timers: { total: projection.timers.length, nextAt },
    needsReview: projection.needsReview.length,
    deadLetters: projection.deadLetters.length,
    asks: statusAsksOf(projection),
    lock,
  };
}

const CACHE_LABEL: Record<StatusReport['cache']['state'], string> = {
  hit: '命中',
  stale: '过期',
  missing: '缺失',
  corrupt: '损坏',
};

/**
 * status 的"她在问"那一段：只认她问的（source: 'agent'）。
 *
 * 系统来源那条（计划待批准）走的是**挂起**：它已经把 turn 停在那儿了，`待确认`/水位那几行
 * 本来就会露出来；把两种来源混成一行会让"她是问了一句"与"整台机器停着等人"看起来一样。
 */
function statusAsksOf(projection: Projection): StatusReport['asks'] {
  const mine = projection.humanAsks.filter((ask) => ask.source === 'agent');
  const head = mine[0];
  return {
    card: head === undefined
      ? null
      : { seq: head.seq, question: head.question, at: head.at, expiredAt: head.expiredAt },
    queued: Math.max(0, mine.length - 1),
  };
}

export function formatStatus(report: StatusReport): string[] {
  const cache = report.cache.state === 'hit'
    ? `命中（lastSeq=${report.cache.lastSeq ?? '?'}）`
    : `${CACHE_LABEL[report.cache.state]}（缓存 lastSeq=${report.cache.lastSeq ?? '无'} / 日志 ${report.events.maxSeq}）`;

  const dist = Object.entries(report.pending.bySource)
    .map(([source, count]) => `${source}×${count}`)
    .join('、');

  const lock = !report.lock.present
    ? '未持有（无 lock.json）'
    : report.lock.alive === false
      ? `陈旧记录（pid ${report.lock.pid ?? '?'} 已不存在，下次启动会接管）`
      : `持有者 pid ${report.lock.pid ?? '?'}（心跳 ${report.lock.heartbeatAt ?? '未知'}）`;

  const lines = [
    `状态 · 数据目录 ${report.dataDir}`,
    `事件日志: 最大 seq ${report.events.maxSeq} / 分片 ${report.events.shards} 个 / 坏行 ${report.events.badLines}`,
    `投影缓存: ${cache}`,
    `今日非缓存消耗: ${tokenCell(report.budget.tokensToday)}（hit ${formatWithExact(report.budget.cacheHitToday)} / miss ${formatWithExact(report.budget.cacheMissToday)}；heavy ${formatWithExact(report.budget.tokensTodayHeavy)} / light ${formatWithExact(report.budget.tokensTodayLight)}）`,
    `水位: ${report.watermark} · 待办 ${report.pending.total}${dist === '' ? '' : `（${dist}）`} · 待确认 ${report.needsReview} · 死信 ${report.deadLetters}`,
    `openTurn: ${report.openTurn === null ? '空闲' : `#${report.openTurn.turn}（step ${report.openTurn.step}）`}`,
    `定时器: ${report.timers.total} 个${report.timers.nextAt === null ? '' : ` · 最近到期 ${report.timers.nextAt}`}`,
    `锁: ${lock}`,
  ];
  // 她在问的那一段只在真有人等答复时才出现：她**不挂起**（design §6.5），所以它不会被
  // "待办/openTurn"那几行带出来——人得有一行能看见"她问了、还没人答"
  if (report.asks.card !== null) {
    const card = report.asks.card;
    // 超时那条事实说的是「未批准、未拒绝」（§6.1）：这里照原样写出来，不写成"已拒绝"
    const state = card.expiredAt === null ? '' : `（已超时无人答：未批准、未拒绝 · ${card.expiredAt}）`;
    lines.push(
      `她在问: #${card.seq} ${clip(card.question, 60)}${state}`
      + `${report.asks.queued > 0 ? ` · 另有 ${report.asks.queued} 条排队` : ''}`
      + `（答：irmia answer --askSeq ${card.seq} "..."）`,
    );
  }
  return lines;
}

// ──────────────────────────────── 事件摘要（tail 用） ────────────────────────────────

/** 摘要压成单行并截断：一条事件恒占一行，人才能顺着 tail/grep 一路看下去 */
function clip(text: string, max: number = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s*\r?\n\s*/gu, ' ⏎ ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** turn/end 的结局：reason 是判别联合，逐种展开比 JSON 一坨强得多 */
function describeTurnEnd(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed': return 'completed';
    case 'blocked': return `blocked(${reason.by})`;
    case 'aborted': return `aborted(${reason.cause})`;
    case 'interrupted': return 'interrupted';
    case 'error': return `error(${reason.code}: ${clip(reason.message, 40)})`;
    case 'budget-exhausted': return `budget-exhausted(${reason.layer})`;
    case 'rate-limited': return `rate-limited(${reason.retryAfterMs}ms)`;
    case 'max-tokens': return `max-tokens(${reason.outputTokens})`;
  }
}

/**
 * 一条事件 → 一行摘要。穷举全部事件类型而不是 JSON.stringify：
 * 摘要的第一读者是凌晨三点被告警叫起来的人，`${name}(${callId}) [destructive]` 一眼就懂，
 * `{"turn":3,"step":2,"callId":"call_1",…}` 还得他自己在脑子里解一遍。
 */
export function summarizeEvent(event: AppEvent): string {
  const raw = (event as { data: unknown }).data;
  switch (event.type) {
    case 'session/start':
      return `pid ${event.data.pid} · v${event.data.version} · schema ${event.data.schemaVersion}`;
    case 'session/end':
      return event.data.detail === undefined
        ? event.data.reason
        : `${event.data.reason}：${clip(event.data.detail, 60)}`;
    case 'turn/start': return `turn ${event.data.turn}`;
    case 'turn/end':
      return `turn ${event.data.turn} · ${describeTurnEnd(event.data.reason)} · ${event.data.spoke ? '发过言' : '未发言'}`;
    case 'step/start':
      return `turn ${event.data.turn} step ${event.data.step} · ${event.data.model}（${event.data.lane}）`;
    case 'step/end': return `turn ${event.data.turn} step ${event.data.step} · 工具 ${event.data.toolCalls} 次`;
    case 'message/user': return `[${event.data.source}] ${clip(event.data.text)}`;
    case 'message/assistant': {
      const text = event.data.text;
      const calls = event.data.toolCalls.length;
      const head = text === null || text === '' ? '（无文本）' : clip(text);
      return calls === 0 ? head : `${head} · 工具调用 ${calls} 个`;
    }
    case 'message/reasoning': return clip(event.data.text);
    case 'developer/message': return `+${event.data.added.length} 条 / -${event.data.removed.length} 条`;
    case 'tool/call':
      return `${event.data.name}(${event.data.callId}) [${event.data.sideEffect}] ${clip(event.data.arguments, 50)}`;
    case 'tool/result': {
      const error = event.data.error;
      const tail = error === undefined ? '' : `：${clip(error.message, 40)}`;
      return `${event.data.callId} · ${event.data.status}${tail}`;
    }
    case 'tool/zombie': return `${event.data.name}(${event.data.callId})：${clip(event.data.note)}`;
    case 'wake/timer': return `定时器 ${event.data.timerId}（计划 ${event.data.scheduledAt}）`;
    case 'wake/file': return `${event.data.kind} ${event.data.path}`;
    case 'wake/webhook': return `${event.data.path} · ${clip(event.data.body, 60)}`;
    case 'wake/manual': return `手动唤醒：${clip(event.data.note)}`;
    case 'wake/heartbeat':
      return `空闲 ${event.data.quietSeconds}s · idleTicks ${event.data.idleTicks} · 压力 ${event.data.pressure.toFixed(2)}`;
    case 'wake/intention': return `${event.data.intentionId}：${clip(event.data.content, 60)}`;
    case 'wake/job': return `后台任务 ${event.data.jobId}`;
    case 'timer/set': {
      const at = event.data.at;
      const cron = event.data.cron;
      const when = at !== undefined ? `@ ${at}` : cron !== undefined ? `cron ${cron}` : '无到期时刻';
      return `${event.data.timerId} ${when}`;
    }
    case 'timer/fired': return event.data.timerId;
    case 'timer/cancelled': return event.data.timerId;
    case 'budget/consumed': {
      const d = event.data;
      return `${d.lane} ${d.inputTokens + d.outputTokens} tok（in ${d.inputTokens} / out ${d.outputTokens}`
        + ` · hit ${d.cacheHitTokens} / miss ${d.cacheMissTokens}）· ${d.finishReason}`;
    }
    case 'budget/rollover': return `跨天记账 ${event.data.date}`;
    case 'budget/exhausted':
      return `${event.data.layer} 撞线 ${event.data.actual} / 上限 ${event.data.limit}${event.data.resumable ? '（可恢复）' : ''}`;
    case 'budget/topped-up': return `${event.data.layer} +${event.data.addedTokens}（by ${event.data.by}）`;
    // 暂停解除（2026-10-04）：两个数都是**解除那一刻**的（有效上限 = 基础上限 + 累计加注；
    // 当时撞线的那个数不在这里，它在解除之前那条 budget/exhausted 里）。这句话是排障时
    // "谁把它解开的、凭什么"的唯一答案，所以不许落进 default 打成原始 JSON。
    case 'budget/resumed':
      return `${event.data.layer} 暂停已解除：已用 ${event.data.actual} / 有效上限 ${event.data.limit}`
        + `（${event.data.reason === 'limit-raised' ? '上限被调大' : '加注抬高了上限'}）`;
    case 'policy/denied':
      return `${event.data.tool} · ${event.data.rule} · ${clip(event.data.reason, 60)}`;
    case 'log/repaired':
      return `截断 ${event.data.truncatedBytes} 字节 · 最后完整 seq ${event.data.lastGoodSeq}`;
    case 'instance/takeover':
      return `接管前任 pid ${event.data.previousPid}（${event.data.staleBecause}）`;
    case 'input/claimed': return `turn ${event.data.turn} 认领 ${event.data.wakeSeqs.length} 条`;
    case 'input/requeued': return `退回 ${event.data.wakeSeqs.length} 条（${event.data.reason}）`;
    case 'input/dead-letter': return `seq ${event.data.inputSeq} 认领 ${event.data.claimCount} 次 · 转死信`;
    // 丢弃是死信的**终局**（不再重投）：这句话要能回答"谁丢的、凭什么丢的、它试过几次"
    case 'input/discarded':
      return `seq ${event.data.inputSeq} 已丢弃（认领 ${event.data.claimCount} 次 · by ${event.data.by}`
        + `）：${clip(event.data.reason, 60)}`;
    case 'alarm/sent':
      return `[${event.data.level}] ${event.data.title}（fp ${event.data.fingerprint}）`;
    case 'review/resolved':
      return `${event.data.callId} · ${event.data.outcome}`
        + `${event.data.note === '' ? '' : ` · ${clip(event.data.note, 50)}`}`;
    case 'snapshot/checkpoint': return `截至 seq ${event.data.upToSeq} · ${event.data.file}`;
    case 'compaction/summary':
      return `覆盖至 seq ${event.data.coveredUpToSeq} · ${clip(event.data.summary, 50)}`;
    case 'persona/updated': return `${event.data.file}（by ${event.data.by}）`;
    case 'config/changed': return event.data.fields.join('、');
    case 'mcp/server-started':
      return `${event.data.name} · pid ${event.data.pid} · ${event.data.tools.length} 件工具`;
    case 'mcp/server-stopped': return `${event.data.name} · ${event.data.reason}`;
    case 'skill/installed': return `${event.data.name}（by ${event.data.by}）`;
    case 'hook/fired': return `${event.data.hook} · ${event.data.outcome}`;
    case 'speak/sent': return `${event.data.channel} · ${event.data.chars} 字`;
    case 'intention/raised': return `${event.data.intentionId}：${clip(event.data.content, 60)}`;
    case 'intention/acted': return `${event.data.intentionId} · turn ${event.data.turn}`;
    case 'todo/updated': return `清单 ${event.data.items.length} 项`;
    case 'job/started':
      return `${event.data.jobId} · turn ${event.data.turn} · ${clip(event.data.command, 50)}`;
    case 'job/finished':
      return `${event.data.jobId} · 退出码 ${event.data.exitCode === null ? '未知' : event.data.exitCode}`;
    case 'human/asked':
      // 来源不同，日志里那行字就该不同：她问的不挂起（design §6.5），写成"等待"会让人读成 turn 停着
      return `${event.data.source === 'agent' ? '她问' : '挂起等答'} turn ${event.data.turn}：${clip(event.data.question, 60)}`;
    case 'human/answered': return `${clip(event.data.answer, 60)}（by ${event.data.by}）`;
    case 'human/expired':
      return `未批准、未拒绝：${clip(event.data.question, 40)}（等了 ${Math.round(event.data.waitedMs / 60_000)} 分钟没人答）`;
    case 'model/degraded': return `${event.data.lane} · ${clip(event.data.reason, 60)}`;
    case 'model/restored': return `${event.data.lane} 已恢复`;
    case 'auth/password-set':
      return `${event.data.action === 'setup' ? '首次设密码' : '改密码'}（by ${event.data.by}）`
        + `${event.data.legacyTokenDisabled ? ' · 旧 token 已停用' : ''}`
        + `${event.data.sessionsRevoked > 0 ? ` · 失效 ${event.data.sessionsRevoked} 条旧会话` : ''}`;
    // 新增事件类型在此显式落进 default，和 fold.ts 同一态度：不静默吞掉，但也绝不因此崩
    default: return clip(JSON.stringify(raw) ?? String(raw));
  }
}

// ──────────────────────────────── tail：读日志尾部 ────────────────────────────────

export function formatTail(scan: TailScan, type: string | null): string[] {
  const filter = type === null ? '' : ` · 过滤 ${type}*`;
  const lines = [`日志尾部 ${scan.events.length} 条${filter}（读取最近 ${scan.shardsRead} 个分片）`];
  for (const event of scan.events) {
    lines.push(`${event.ts} · ${event.seq} · ${event.type} · ${summarizeEvent(event)}`);
  }
  if (scan.events.length === 0) lines.push('（没有匹配的事件）');
  if (scan.badLines > 0) {
    lines.push(`（跳过 ${scan.badLines} 行无法解析的内容：尾部不完整，或分片正在被主进程写入）`);
  }
  return lines;
}

// ──────────────────────────────── review：待确认调用 ────────────────────────────────

/**
 * 待确认明细从两处拼出来，缺一不可：
 *   ① 投影的 needsReview —— 谁还没结案（口径在 fold.ts：`tool/result{unknown}` 进，`review/resolved` 出）；
 *   ② 日志的 tool/call 与 tool/result —— 名字与归属的 turn/step 不在投影里（投影只存 callId）。
 * 投影回答"是否待确认"，日志回答"这是什么调用"；不为了少读一次日志去改投影形状。
 */
export function buildReviewEntries(events: readonly AppEvent[]): ReviewEntry[] {
  const projection = fold(events);
  const names = new Map<string, string>();
  const sites = new Map<string, { turn: number; step: number }>();
  for (const event of events) {
    if (event.type === 'tool/call') {
      names.set(event.data.callId, event.data.name);
    } else if (event.type === 'tool/result' && event.data.status === 'unknown') {
      sites.set(event.data.callId, { turn: event.data.turn, step: event.data.step });
    }
  }
  return projection.needsReview.map((item) => {
    const site = sites.get(item.callId);
    return {
      callId: item.callId,
      name: names.get(item.callId) ?? (item.name === '' ? null : item.name),
      at: item.at,
      turn: site?.turn ?? null,
      step: site?.step ?? null,
    };
  });
}

export function buildReviewList(dataDir: string): ReviewEntry[] {
  return buildReviewEntries(readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME)).events);
}

export function formatReviewList(entries: readonly ReviewEntry[]): string[] {
  const lines = [`待确认调用 ${entries.length} 条`];
  if (entries.length === 0) {
    lines.push('  （无：有副作用的悬空调用会在启动恢复时标为 unknown 并出现在这里）');
    return lines;
  }
  entries.forEach((entry, index) => {
    const turn = entry.turn === null ? 'turn ?' : `turn ${entry.turn}`;
    const step = entry.step === null ? 'step ?' : `step ${entry.step}`;
    lines.push(
      `  ${index + 1}) ${entry.callId} · ${entry.name ?? '（日志里没有对应的 tool/call）'}`
      + ` · ${entry.at} · ${turn} · ${step}`,
    );
  });
  lines.push('结案：irmia review resolve <callId> --outcome succeeded|failed|partial [--note "..."]');
  return lines;
}

/**
 * 结案并写 `review/resolved`（承诺类：fsync 返回后才算结案）。
 *
 * 写前两道闸门，缺一不可：
 *   ① **探锁**：主进程活着就拒绝写（退出码 3）。两个进程各自 nextSeq 必然撞号，
 *      而撞号的日志会让下一次启动在 EventLog.open 阶段直接拒绝启动——用一次 CLI 操作
 *      把整个实例搞停，比"这一条晚点结案"严重得多；
 *   ② **校验 callId**：不在待确认列表里就报错（退出码 2）。拼错的 id 写成一条结案事实，
 *      等于往唯一真相源里灌假事实，此后再没人能分辨。
 */
export async function resolveReview(
  dataDir: string,
  input: ResolveReviewInput,
  now: Date = new Date(),
): Promise<ResolveReviewResult> {
  const lock = readLockFile(join(dataDir, LOCK_FILE_NAME));
  if (lock.alive === true) {
    return {
      ok: false,
      code: 3,
      error: `主进程正在运行（pid ${lock.pid ?? '?'}）：此刻写日志会让两个进程的 seq 撞号，`
        + '日志下次启动会被判为「重复 seq」而拒绝启动。请先优雅停掉主进程，'
        + '或在主进程里结案后再来',
    };
  }

  const target = buildReviewList(dataDir).find((entry) => entry.callId === input.callId);
  if (target === undefined) {
    return {
      ok: false,
      code: 2,
      error: `callId=${input.callId} 不在待确认列表里（可能已结案或拼写有误）；`
        + '先跑 irmia review list 核对',
    };
  }

  const log = await EventLog.open(join(dataDir, EVENT_LOG_DIR_NAME));
  try {
    const event = {
      seq: log.nextSeq(),
      ts: now.toISOString(),
      type: 'review/resolved',
      data: { callId: input.callId, outcome: input.outcome, note: input.note, by: input.by },
      visibility: defaultVisibility('review/resolved'),
      origin: 'cli',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return { ok: true, seq: event.seq };
  } finally {
    log.close();
  }
}

// ──────────────────────────────── answer：答复人审挂起（design §4.21） ────────────────────────────────

export interface AnswerCliInput {
  /** 答复文本：恰好 `approve` = 批准待批的 destructive 计划；`reject…` / `拒绝…` 开头 = 拒绝 */
  answer: string;
  by: string;
  /** 指定结案哪条待批计划（待批多于一条时必须给） */
  callId?: string;
  /** 指定答复哪一条提问（`human/asked` 的 seq）；省略时挑挂起中的那条，再退到最早一条她问的 */
  askSeq?: number;
}

/** 失败码与 review resolve 同源：1 = 环境/写入故障，2 = 参数或状态不对，3 = 主进程在跑 */
export type AnswerCliResult = AnswerOutcome | { ok: false; code: 1 | 2 | 3; error: string };

/**
 * 答复人审挂起：写 `human/answered`，答复是批准/拒绝时再写 `plan/resolved`。
 *
 * 两道闸门与 `review resolve` 同源，缺一不可：
 *   ① **探锁**：主进程活着就拒绝写（退出码 3）。两个进程各自 nextSeq 必然撞号，
 *      而撞号的日志会让下一次启动直接拒启——用一次 CLI 操作把实例搞停，代价太大；
 *   ② **校验**：没有挂起的提问、或指定的 callId 不在待批队列里，一律报错（退出码 2）。
 *      拼错的答复写成事实，与拼错的结案同性质：往唯一真相源里灌假事实。
 *
 * 停机期间写下的答复不会丢：real-loop 启动时用 `scanSuspension` 从日志重建挂起线索，
 * 下一拍就把挂起 turn 认领过的输入写回队列（`input/requeued{reason:'human-answered'}`）。
 */
export async function answerSuspension(
  dataDir: string,
  input: AnswerCliInput,
  now: Date = new Date(),
): Promise<AnswerCliResult> {
  const lock = readLockFile(join(dataDir, LOCK_FILE_NAME));
  if (lock.alive === true) {
    return {
      ok: false,
      code: 3,
      error: `主进程正在运行（pid ${lock.pid ?? '?'}）：此刻写日志会让两个进程的 seq 撞号，`
        + '日志下次启动会被判为「重复 seq」而拒绝启动。请先优雅停掉主进程，'
        + '或在 Web 卡片 / POST /api/commands/answer 里答复（那条路在主进程内写，不撞号）',
    };
  }

  const events = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME)).events;
  const log = await EventLog.open(join(dataDir, EVENT_LOG_DIR_NAME));
  try {
    return answerHuman({
      events,
      answer: input.answer,
      by: input.by,
      ...(input.callId !== undefined && input.callId !== '' ? { callId: input.callId } : {}),
      ...(input.askSeq !== undefined ? { askSeq: input.askSeq } : {}),
      now,
      write: (type, data, visibility) => {
        const event = {
          seq: log.nextSeq(),
          ts: now.toISOString(),
          type,
          data,
          visibility,
          origin: 'cli',
        } as unknown as AppEvent;
        log.append(event, { sync: true });
        return event.seq;
      },
    });
  } finally {
    log.close();
  }
}

// ──────────────────────────────── skill：任务知识包（design §4.19） ────────────────────────────────

/** 技能清单条目：人类确认界面的数据面 */
export interface SkillListEntry {
  name: string;
  relDir: string;
  /** `trusted` = 已生效（进 catalog）；其余均为待确认原因 */
  state: SkillTrustState;
  detail: string;
  /** 已生效条目进 catalog 的估算 token；未生效为 null */
  tokens: number | null;
}

export interface SkillListReport {
  entries: SkillListEntry[];
  rejected: Array<{ relDir: string; reason: string }>;
  catalogTokens: number;
}

/**
 * 技能清单（只读）：扫描技能根，并用日志里折叠出的信任表裁决每个技能的生效状态。
 * 与运行期同一口径（同一份 SkillManager），所以「CLI 看到的」就是「模型看到的」。
 */
export function buildSkillList(dataDir: string, baseRoot: string = process.cwd()): SkillListReport {
  const events = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME)).events;
  const manager = new SkillManager({ baseRoot });
  manager.setTrustEvents(events); // 信任门的真相源是日志，折叠口径只有一处
  const catalog = manager.catalog();

  const entries: SkillListEntry[] = [
    ...catalog.entries.map((entry) => ({
      name: entry.name,
      relDir: entry.skillPath.replace(/\/SKILL\.md$/u, ''),
      state: 'trusted' as const,
      detail: `已生效（catalog ≈ ${entry.tokens} token${entry.truncated ? '，已截断' : ''}）`,
      tokens: entry.tokens,
    })),
    ...catalog.pending.map((item) => ({
      name: item.name,
      relDir: item.relDir,
      state: item.state,
      detail: item.detail,
      tokens: null,
    })),
  ];

  return {
    entries,
    rejected: catalog.rejected.map((item) => ({ relDir: item.relDir, reason: item.reason })),
    catalogTokens: catalog.tokens,
  };
}

export function formatSkillList(report: SkillListReport): string[] {
  const lines = [`技能 ${report.entries.length} 个（catalog 估算 ${report.catalogTokens} token）`];
  if (report.entries.length === 0) {
    lines.push('  （无：skills/ 与 .agents/skills/ 下没有通过校验的技能目录）');
  }
  for (const entry of report.entries) {
    lines.push(`  ${entry.state === 'trusted' ? '✓' : '·'} ${entry.name} · ${entry.relDir} · ${entry.detail}`);
  }
  if (report.rejected.length > 0) {
    lines.push('被拒绝的目录：');
    for (const item of report.rejected) lines.push(`  ✗ ${item.relDir}：${item.reason}`);
  }
  lines.push('确认：irmia skill confirm <name> [--by B]（写入 skill/installed{by:human} 后才进 catalog）');
  return lines;
}

export interface ConfirmSkillInput {
  name: string;
  /** 谁按的手（只进输出与事件 origin，不改变 by 的枚举语义） */
  by: string;
}

export type ConfirmSkillResult =
  | { ok: true; seq: number; contentHash: string }
  | { ok: false; code: number; error: string };

/**
 * 人类确认：把 `skill/installed { by: 'human' }` 写进日志（信任门的唯一凭据）。
 *
 * 与 `review resolve` 同款两道闸门：① 探锁（主进程活着就拒绝写，seq 撞号会让下次启动拒启）；
 * ② 校验技能真的存在且合规，绝不写一条指向空气的确认。确认绑定 SKILL.md 的内容哈希，
 * 之后内容被改动会自动退回待确认（design §4.19）。
 */
export async function confirmSkill(
  dataDir: string,
  input: ConfirmSkillInput,
  now: Date = new Date(),
  baseRoot: string = process.cwd(),
): Promise<ConfirmSkillResult> {
  const lock = readLockFile(join(dataDir, LOCK_FILE_NAME));
  if (lock.alive === true) {
    return {
      ok: false,
      code: 3,
      error: `主进程正在运行（pid ${lock.pid ?? '?'}）：此刻写日志会让两个进程的 seq 撞号，`
        + '日志下次启动会被判为「重复 seq」而拒绝启动。请先优雅停掉主进程再确认',
    };
  }

  const manager = new SkillManager({ baseRoot });
  const payload = manager.buildInstalledData(input.name, 'human');
  if (payload === null) {
    return {
      ok: false,
      code: 2,
      error: `技能 ${input.name} 不在可确认清单里（目录不存在、frontmatter 非法或名字与目录不一致）；`
        + '先跑 irmia skill list 核对',
    };
  }

  const log = await EventLog.open(join(dataDir, EVENT_LOG_DIR_NAME));
  try {
    const event = {
      seq: log.nextSeq(),
      ts: now.toISOString(),
      type: 'skill/installed',
      data: payload,
      visibility: defaultVisibility('skill/installed'),
      origin: `cli(${input.by})`,
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return { ok: true, seq: event.seq, contentHash: payload.contentHash ?? '' };
  } finally {
    log.close();
  }
}

// ──────────────────────────────── budget：投影派生 ────────────────────────────────

/**
 * 预算报告。四层判定直接走 BudgetGuard（与刹车判定同一条路径）：
 * CLI 自己再算一遍比例，就必然与刹车出现口径漂移——这种漂移没人会发现，
 * 直到刹车在错误的时刻停下。人工加注用 foldTopUps 折成有效上限，与真循环 makeGuard 完全一致。
 */
export function buildBudgetReport(input: {
  dataDir: string;
  budget: BudgetConfig;
  events: readonly AppEvent[];
  limitSource: BudgetReport['limitSource'];
}): BudgetReport {
  const projection = fold(input.events);
  const guard = new BudgetGuard(input.budget);
  guard.setTopUps(foldTopUps(input.events));
  const softRatio = pickSoftRatio(input.budget.softRatio);

  const layers = guard.statuses(projection).map((status) => {
    const softLimit = status.limit * softRatio;
    return {
      layer: status.layer,
      used: status.used,
      limit: status.limit,
      hardRatio: status.ratio,
      softLimit,
      softRatio: softLimit > 0 ? status.used / softLimit : 0,
      over: status.over,
      soft: status.soft,
    };
  });

  const b = projection.budget;
  const cacheTotal = b.cacheHitToday + b.cacheMissToday;
  return {
    dataDir: input.dataDir,
    today: {
      tokens: b.tokensToday,
      heavy: b.tokensTodayHeavy,
      light: b.tokensTodayLight,
      cacheHit: b.cacheHitToday,
      cacheMiss: b.cacheMissToday,
      hitRate: cacheTotal > 0 ? b.cacheHitToday / cacheTotal : null,
    },
    taskTokens: b.tokensTask,
    topUps: guard.topUpTotals(),
    layers,
    limitSource: input.limitSource,
  };
}

// 千分位那个函数（formatCount）随本次"单位格式只有一处"合并进 format/units.ts 的
// formatExact —— 保留第二份实现正是"同一个数两种写法"的来源。


/**
 * token 数的当行读法：紧凑写法 + 口径词 + **原始精确值**。
 *
 * `2.7M 非缓存 token（2,705,946）`——紧凑写法让量级一眼可读，括号里的真数让人能对账。
 * 与界面同一条纪律（用户的原话："别让人看不到真实数"），单位格式走
 * `format/units.ts` 的唯一实现（CLI 与 web/server.ts 引同一份，界面那侧是它的 Dart 镜像）。
 */
function tokenCell(value: number): string {
  return `${formatWithExact(value)} 非缓存 token`;
}

function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatBudget(report: BudgetReport, options: { today: boolean }): string[] {
  const lines = [`预算 · 数据目录 ${report.dataDir}`];
  if (report.limitSource === 'default') {
    lines.push('（没读到 config.json，硬上限用内置默认值——与主进程生效的配置可能不同）');
  }
  lines.push(
    `今日非缓存消耗: ${tokenCell(report.today.tokens)}`
    + `（heavy ${formatWithExact(report.today.heavy)} · light ${formatWithExact(report.today.light)}）`,
  );
  const hit = report.today.hitRate === null ? '无样本' : formatRatio(report.today.hitRate);
  lines.push(
    `缓存: 命中 ${formatWithExact(report.today.cacheHit)} / 未命中 ${formatWithExact(report.today.cacheMiss)}`
    + ` · 命中率 ${hit}`,
  );
  lines.push(`单任务非缓存累计: ${tokenCell(report.taskTokens)}`);

  const topped = BUDGET_LAYERS.filter((layer) => report.topUps[layer] > 0)
    .map((layer) => `${layer} +${formatWithExact(report.topUps[layer])}`);
  lines.push(`人工加注: ${topped.length === 0 ? '无' : topped.join('、')}`);

  const shown = options.today ? report.layers.filter((layer) => layer.layer === 'daily') : report.layers;
  lines.push(options.today ? '今日非缓存口径（仅每日层）:' : '四层阈值（软阈值 = 硬上限 × softRatio）:');
  for (const layer of shown) {
    const flag = layer.over ? ' · 已越线' : layer.soft ? ' · 已达软阈值' : '';
    lines.push(
      `  ${LAYER_LABEL[layer.layer]}(${layer.layer}): 已用 ${formatWithExact(layer.used)} / 硬上限 `
      + `${formatWithExact(layer.limit)} ${LAYER_UNIT[layer.layer]}（${formatRatio(layer.hardRatio)}）`
      + ` · 软阈值 ${formatWithExact(layer.softLimit)}（${formatRatio(layer.softRatio)}）${flag}`,
    );
  }
  return lines;
}

/**
 * 取生效的预算上限。**只在 config.json 已存在时读它**：loadConfig 在文件缺失时会顺手写一份
 * 默认配置（那是启动期行为），CLI 在别人的目录里凭空造配置不是观测命令该干的事。
 * 配置非法也不拦观测：人要的是"现在花了多少"，退回内置默认并标明来源即可。
 */
async function loadBudgetLimits(cwd: string): Promise<{ budget: BudgetConfig; source: 'file' | 'default' }> {
  if (!existsSync(join(cwd, CONFIG_FILE_NAME))) {
    return { budget: defaultConfig(cwd).budget, source: 'default' };
  }
  try {
    const loaded = await loadConfig(cwd);
    return { budget: loaded.config.budget, source: 'file' };
  } catch {
    return { budget: defaultConfig(cwd).budget, source: 'default' };
  }
}

// ──────────────────────────────── 注入手动唤醒 ────────────────────────────────

/**
 * 取生效配置里的本机用户标识（读不到就用内置默认）。
 * 与 loadBudgetLimits 同一条纪律：**只在 config.json 已存在时读**，不在别人的目录里凭空造配置。
 */
async function ownerPersonFor(cwd: string | undefined): Promise<string> {
  const dir = cwd ?? process.cwd();
  if (!existsSync(join(dir, CONFIG_FILE_NAME))) return ownerPersonOf(defaultConfig(dir));
  try {
    return ownerPersonOf((await loadConfig(dir)).config);
  } catch {
    return ownerPersonOf(defaultConfig(dir));
  }
}

/**
 * 写看门文件。文件名固定为 `wake-<epochMillis>.json`；同毫秒多次注入时向后借 1ms，
 * 用 `wx` 排他创建，绝不覆盖既有文件（覆盖等于悄悄吞掉一次唤醒）。
 */
export function writeWakeNote(dataDir: string, input: WakeNoteInput, now: Date = new Date()): string {
  const dir = join(dataDir, WAKE_WATCH_DIR_NAME);
  mkdirSync(dir, { recursive: true });

  const payload: Record<string, unknown> = { note: input.note, ts: now.toISOString(), pid: process.pid };
  if (input.dedupeKey !== undefined) payload['dedupeKey'] = input.dedupeKey;
  // 带人唤醒：写进去就会命中 persona/RELATIONSHIPS/<person>.md（persona.md §3）
  if (input.person !== undefined && input.person !== '') payload['person'] = input.person;
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  for (let offset = 0; offset < MAX_NAME_ATTEMPTS; offset++) {
    const path = join(dir, `${WAKE_FILE_PREFIX}${now.getTime() + offset}.json`);
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
  throw new Error(`看门文件名连续 ${MAX_NAME_ATTEMPTS} 次撞车，放弃注入`);
}

// ──────────────────────────────── persona：演化时间线 / 差异 / 回滚 ────────────────────────────────

export interface PersonaLogEntry {
  seq: number;
  ts: string;
  file: string;
  diffHash: string;
  by: 'agent' | 'human';
  /** 版本库里有没有这份内容；null = 只有事件、内容已不可考 */
  snapshotPath: string | null;
}

/**
 * 把日志里那串 `diffHash` 解成**版本库文件名**（永远是满 64 位）。
 *
 * 为什么必须解一次：2026-10-11 之前 GUI 直编那条通道往事件里写的是 **16 位截断前缀**
 * （见 `samePersonaContent` 那段），而版本库的快照文件名永远是满 64 位
 * （`versions.ts` 的 `writePersonaVersion` 用 `sha256Hex(content)`；`doctor.ts` 的
 * `versionStoreProblems` 也要求文件名是 64 位）⇒ 直接拿事件里那串去拼路径，会把**明明在库**
 * 的快照报成"版本库无此快照／内容不可考"。解一次前缀（与 `persona rollback <前缀>` 同一套
 * 语义：**唯一匹配**才算数），命中多个就不猜——宁可说"不可考"，也别指错一个版本。
 *
 * `known` 由调用方按文件缓存（一个文件只列一次目录，别在事件循环里反复 readdir）。
 */
function resolveStoredHash(known: readonly string[], diffHash: string): string | null {
  if (known.includes(diffHash)) return diffHash;
  const matched = known.filter((item) => item.startsWith(diffHash));
  return matched.length === 1 ? matched[0]! : null;
}

/** 人格演化时间线：`persona/updated` 倒序（最近改的排最前） */
export function buildPersonaLog(dataDir: string): PersonaLogEntry[] {
  const events = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME)).events;
  const knownByFile = new Map<string, readonly string[]>();
  const storedHashesOf = (file: string): readonly string[] => {
    const cached = knownByFile.get(file);
    if (cached !== undefined) return cached;
    const list = listPersonaVersions(dataDir, file).map((item) => item.diffHash);
    knownByFile.set(file, list);
    return list;
  };
  const out: PersonaLogEntry[] = [];
  for (const event of events) {
    if (event.type !== 'persona/updated') continue;
    const file = event.data.file.replace(/\\/gu, '/');
    // 目录里的文件名才是内容地址（满 64 位）；事件里那串可能只是它的前缀
    const stored = resolveStoredHash(storedHashesOf(file), event.data.diffHash);
    const path = stored === null ? null : versionPathOf(dataDir, file, stored);
    out.push({
      seq: event.seq,
      ts: event.ts,
      file,
      diffHash: event.data.diffHash,
      by: event.data.by,
      snapshotPath: path !== null && existsSync(path) ? path : null,
    });
  }
  return out.reverse();
}

export function formatPersonaLog(entries: readonly PersonaLogEntry[], options: { json: boolean }): string[] {
  if (options.json) return [JSON.stringify(entries, null, 2)];
  const lines = [`人格演化 ${entries.length} 条（倒序，最近在前）`];
  if (entries.length === 0) {
    lines.push('  （还没有任何 persona/updated：它由 write_persona 与 persona rollback 写入）');
    return lines;
  }
  for (const entry of entries) {
    const snapshot = entry.snapshotPath === null ? ' · 版本库无此快照' : ' · 快照在库';
    lines.push(`  ${entry.ts} · seq ${entry.seq} · ${entry.file} · by ${entry.by} · ${entry.diffHash.slice(0, 8)}${snapshot}`);
  }
  lines.push('查看差异：irmia persona diff <file>；回滚：irmia persona rollback <file> <diffHash>');
  return lines;
}

export interface PersonaDiffReport {
  file: string;
  /** 盘上当前内容的哈希 */
  currentHash: string;
  /** 当前内容是否与日志最近一条 persona/updated 一致 */
  currentEvented: boolean;
  /** 对照版本（上一份内容不同的记录）；null = 没有更早版本 */
  previous: { diffHash: string; seq: number; ts: string; by: 'agent' | 'human'; snapshotPath: string | null } | null;
  previousBytes: number | null;
  currentBytes: number;
  lines: DiffLine[];
  stats: DiffStats;
  notes: string[];
}

export type PersonaDiffResult =
  | { ok: true; report: PersonaDiffReport }
  | { ok: false; code: number; error: string };

/**
 * 当前内容 vs 上一版本快照。
 *
 * "上一版本"的判据：该文件在日志里**最后一条内容与当前不同的** persona/updated。
 * 这样两种现实都对：当前内容已被记录（取更早那条），或当前被人直接改过（取最后那条记录）——
 * 后者恰好等于"人手动改了文件"，diff 出来就是人改了什么。
 */
/**
 * 日志里那条 `diffHash` 与"盘上重算的 sha256"说的是不是**同一份内容**。
 *
 * ⚠ **两个长度**（2026-10-11 定死）：GUI 直编那条通道写的曾是 `.slice(0, 16)` 的**截断前缀**
 * （`web/server.ts` 的 `persona-edit`；同日起改成写满 64 位，历史那 16 位按 append-only 不动），
 * 而 `write_persona`（`tools/admin.ts`）与人味回滚写满 64 位；盘上重算的永远是 64 位。
 * 拿 64 位去比 16 位 ⇒ **内容一字不差也判"不一致"**，而且下游会把**最近那条**当成"上一版本"，
 * diff 出来的"上一版"就是当前版（一条假 diff + 两句假注）。比较一律**先对齐到日志那条的长度**：
 * 16 位十六进制 = 64 bit，"是不是同一份内容"的力道不变（与 `runtime/doctor.ts` 的 I10 同一口径）。
 */
function samePersonaContent(diffHash: string, actualSha256: string): boolean {
  return actualSha256.slice(0, diffHash.length) === diffHash;
}

export function buildPersonaDiff(dataDir: string, rawFile: string): PersonaDiffResult {
  let file: string;
  try {
    file = normalizePersonaFile(rawFile);
  } catch (err) {
    return { ok: false, code: 2, error: describeError(err) };
  }

  const currentPath = join(dataDir, 'persona', file);
  if (!existsSync(currentPath)) {
    return { ok: false, code: 2, error: `没有这个人格文件：${currentPath}` };
  }
  let currentText: string;
  try {
    currentText = readFileSync(currentPath, 'utf8');
  } catch (err) {
    return { ok: false, code: 2, error: `${currentPath} 读不到：${describeError(err)}` };
  }
  const currentHash = sha256Hex(currentText);

  const history = readEventsReadOnly(join(dataDir, EVENT_LOG_DIR_NAME)).events.filter(
    (event): event is AppEvent & { type: 'persona/updated' } =>
      event.type === 'persona/updated' && event.data.file.replace(/\\/gu, '/') === file,
  );
  const latest = history[history.length - 1] ?? null;
  const currentEvented = latest !== null && samePersonaContent(latest.data.diffHash, currentHash);
  const previousEntry = [...history].reverse().find((event) => !samePersonaContent(event.data.diffHash, currentHash)) ?? null;

  const notes: string[] = [];
  if (previousEntry === null) {
    notes.push('日志里没有该文件更早的内容记录（首次 diff，或它从未经 write_persona / rollback 改过）');
  }
  if (!currentEvented) {
    notes.push('当前内容与日志最近一条 persona/updated 不一致：可能是人工直改，或改动未经事件记录');
  }

  let previousText: string | null = null;
  let previousBytes: number | null = null;
  let previous: PersonaDiffReport['previous'] = null;
  if (previousEntry !== null) {
    // 版本库里的文件名是满 64 位内容地址；事件里那串对 GUI 直编写下的历史记录只有 16 位
    // ⇒ 解一次前缀再拼路径（不这么做会把**在库**的快照说成"内容不可考"）
    const stored = resolveStoredHash(
      listPersonaVersions(dataDir, file).map((item) => item.diffHash),
      previousEntry.data.diffHash,
    );
    const snapshotPath = stored === null ? null : versionPathOf(dataDir, file, stored);
    const exists = snapshotPath !== null && existsSync(snapshotPath);
    previousText = stored === null ? null : readPersonaVersion(dataDir, file, stored);
    previousBytes = previousText === null ? null : Buffer.byteLength(previousText, 'utf8');
    previous = {
      // 报**解出来的**那个（能直接喂给 `persona rollback`）；解不出才退回事件里那串
      diffHash: stored ?? previousEntry.data.diffHash,
      seq: previousEntry.seq,
      ts: previousEntry.ts,
      by: previousEntry.data.by,
      snapshotPath: exists ? snapshotPath : null,
    };
    if (previousText === null) {
      notes.push(`版本库里缺 ${previousEntry.data.diffHash.slice(0, 8)} 的快照（内容不可考）：只有事件记录，无法逐行比对`);
    }
  }

  const lines = previousText === null ? [] : diffLines(previousText, currentText);
  return {
    ok: true,
    report: {
      file,
      currentHash,
      currentEvented,
      previous,
      previousBytes,
      currentBytes: Buffer.byteLength(currentText, 'utf8'),
      lines,
      stats: previousText === null ? { added: 0, removed: 0, same: 0 } : diffStats(lines),
      notes,
    },
  };
}

export function formatPersonaDiff(report: PersonaDiffReport, options: { full: boolean }): string[] {
  const lines: string[] = [`人格差异 · ${report.file}`];
  lines.push(`  当前：sha256 ${report.currentHash.slice(0, 16)} · ${report.currentBytes} 字节`
    + `${report.currentEvented ? '（与日志最近一条 persona/updated 一致）' : '（日志里没有对应记录）'}`);
  if (report.previous === null) {
    // 两种"没有对照"要分开说：内容**已被记录**（只是没有更早的一版）与"日志里压根没有记录"
    // ——用同一句话盖住两种现实，读的人会以为自己的改动没被记下来
    lines.push(report.currentEvented
      ? '  对照：无（日志里只有当前这一版：没有更早的版本可比）'
      : '  对照：无（没有更早的版本记录）');
  } else {
    lines.push(`  对照：sha256 ${report.previous.diffHash.slice(0, 16)} · ${report.previousBytes ?? '?'} 字节`
      + ` · 来自 seq ${report.previous.seq} @ ${report.previous.ts}（by ${report.previous.by}）`);
    lines.push(`  快照：${report.previous.snapshotPath ?? '（版本库缺这份内容）'}`);
  }
  if (report.lines.length === 0) {
    lines.push('  （没有可比对的行：见下面的注）');
  } else {
    lines.push(`  差异：+${report.stats.added} / -${report.stats.removed} / 共 ${report.lines.length} 行`
      + '（左列旧行号，右列新行号）');
    for (const line of formatDiffLines(report.lines, options.full ? { maxLines: Number.MAX_SAFE_INTEGER, contextLines: Number.MAX_SAFE_INTEGER } : {})) {
      lines.push(`  ${line}`);
    }
  }
  for (const note of report.notes) lines.push(`  注：${note}`);
  return lines;
}

export type PersonaRollbackBy = 'human' | 'agent';

export interface PersonaRollbackOptions {
  by?: PersonaRollbackBy;
  now?: Date;
}

export type PersonaRollbackResult =
  | {
    ok: true;
    file: string;
    filePath: string;
    diffHash: string;
    bytes: number;
    eventSeq: number;
    /** 回滚前的内容哈希（回滚本身也要可回滚：它已被归档进版本库） */
    previousHash: string | null;
    /** 回滚前的内容是否是这次才写进版本库的 */
    archived: boolean;
  }
  | { ok: false; code: number; error: string };

/**
 * 按版本库快照回滚人格文件，并写 `persona/updated { by: 'human' }`（承诺类：fsync 返回后才算生效）。
 *
 * 写前两道闸门与 review resolve 同源：
 *   ① **探锁**：主进程活着就拒绝（退出码 3）。两个写者各自 nextSeq 必然撞号，撞号的日志会让
 *      下一次启动在 EventLog.open 阶段直接拒绝启动——用一次人肉回滚把整个实例搞停，代价太大；
 *   ② **目标必须存在且与当前不同**：版本库里没有该 diffHash（或它正好等于当前内容）就报错
 *      （退出码 2）。猜一个版本去回滚，是"用一次误操作改变人格"。
 *
 * 顺序：先归档当前内容（内容寻址、幂等）→ 再原子写回文件 → 最后写事件。
 * 反过来的话，事件会先声明一个尚未落盘的人格版本。
 */
export async function rollbackPersona(
  dataDir: string,
  rawFile: string,
  hashPrefix: string,
  options: PersonaRollbackOptions = {},
): Promise<PersonaRollbackResult> {
  let file: string;
  try {
    file = normalizePersonaFile(rawFile);
  } catch (err) {
    return { ok: false, code: 2, error: describeError(err) };
  }

  const lock = readLockFile(join(dataDir, LOCK_FILE_NAME));
  if (lock.alive === true) {
    return {
      ok: false,
      code: 3,
      error: `主进程正在运行（pid ${lock.pid ?? '?'}）：此刻写日志会让两个进程的 seq 撞号，`
        + '日志下次启动会被判为「重复 seq」而拒绝启动。请先优雅停掉主进程再回滚',
    };
  }

  const filePath = join(dataDir, 'persona', file);
  // "回滚到当前内容"要在查版本库之前拦住：版库里当然没有当前内容（它还没被归档），
  // 若等到前缀解析失败才报错，人会以为是版本库坏了——那是个误导性的提示
  const currentText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const currentHash = currentText === null ? null : sha256Hex(currentText);
  if (
    currentHash !== null
    && isDiffHashPrefix(hashPrefix)
    && currentHash.startsWith(hashPrefix.trim().toLowerCase())
  ) {
    return { ok: false, code: 2, error: `${file} 当前内容就是 ${hashPrefix.trim().slice(0, 8)}，无需回滚` };
  }

  const resolved = resolveDiffHashPrefix(dataDir, file, hashPrefix);
  if (!resolved.ok) {
    const candidates = resolved.candidates.length === 0 ? '' : `；候选：${resolved.candidates.map((h) => h.slice(0, 12)).join('、')}`;
    return { ok: false, code: 2, error: resolved.reason + candidates };
  }

  const content = readPersonaVersion(dataDir, file, resolved.diffHash);
  if (content === null) {
    return {
      ok: false,
      code: 2,
      error: `版本库里读不到 ${file} 的 ${resolved.diffHash.slice(0, 8)} 快照（事件记录存在但内容缺失）`,
    };
  }

  let previousHash: string | null = null;
  let archived = false;
  if (currentText !== null) {
    previousHash = currentHash;
    if (previousHash === resolved.diffHash) {
      return { ok: false, code: 2, error: `${file} 当前内容就是 ${resolved.diffHash.slice(0, 8)}，无需回滚` };
    }
    // 回滚前的内容也留一份快照：否则这次回滚本身不可逆（人总会想再改回去）
    const written = await writePersonaVersion(dataDir, file, currentText);
    archived = written.created;
  }

  const bytes = await writePersonaAsset(dataDir, file, content);

  const now = options.now ?? new Date();
  const by: PersonaRollbackBy = options.by ?? 'human';
  const log = await EventLog.open(join(dataDir, EVENT_LOG_DIR_NAME));
  try {
    const event = {
      seq: log.nextSeq(),
      ts: now.toISOString(),
      type: 'persona/updated',
      data: { file, diffHash: resolved.diffHash, by },
      visibility: defaultVisibility('persona/updated'),
      origin: 'cli',
    } as unknown as AppEvent;
    log.append(event, { sync: true });
    return { ok: true, file, filePath, diffHash: resolved.diffHash, bytes, eventSeq: event.seq, previousHash, archived };
  } finally {
    log.close();
  }
}

// ──────────────────────────────── export：导出 seq 区间 ────────────────────────────────

export interface ExportReport {
  from: number;
  to: number;
  count: number;
  /** 区间内跳过的坏行（主进程正在追加时可能出现） */
  badLines: number;
  shardsRead: number;
  /** JSONL 正文：每行一条事件，与日志分片同格式（可直接 grep/jq） */
  body: string;
}

/**
 * 导出 `[from, to]` 的日志段，输出与分片同格式的 JSONL。
 * 刻意不重新序列化/改写字段：导出的东西必须能被当作日志片段直接读回，
 * 否则"取证"就变成了一份无法自证的报告。
 */
export function buildExport(dataDir: string, from: number, to: number): ExportReport {
  const scan = readRangeEvents(join(dataDir, EVENT_LOG_DIR_NAME), from, to);
  const body = scan.events.length === 0
    ? ''
    : `${scan.events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  return { from, to, count: scan.events.length, badLines: scan.badLines, shardsRead: scan.shardsRead, body };
}

/** 写输出文件（`--out`）。显式 UTF-8：导出物是要长期保存的文本，不该受平台默认编码摆布 */
function writeOutputFile(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ──────────────────────────────── 参数解析与分发 ────────────────────────────────

type WakeArgsParse = { ok: true; value: WakeNoteInput } | { ok: false; error: string };

function parseWakeArgs(args: readonly string[]): WakeArgsParse {
  let note: string | null = null;
  let dedupeKey: string | undefined;
  let person: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--note') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: '--note 缺少值' };
      note = value;
      i += 1;
    } else if (arg === '--dedupe-key') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: '--dedupe-key 缺少值' };
      dedupeKey = value;
      i += 1;
    } else if (arg === '--person') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: '--person 缺少值（写 --person "" 表示不带人）' };
      person = value;
      i += 1;
    } else {
      return { ok: false, error: `无法识别的参数：${arg}` };
    }
  }

  if (note === null) return { ok: false, error: '缺少 --note "..."' };
  const value: WakeNoteInput = { note };
  if (dedupeKey !== undefined) value.dedupeKey = dedupeKey;
  if (person !== undefined) value.person = person;
  return { ok: true, value };
}

type TopUpArgsParse = { ok: true; value: Omit<TopUpRequest, 'ts'> } | { ok: false; error: string };

const TOPUP_LAYERS: readonly BudgetLayer[] = ['step', 'turn', 'task', 'daily'];

/**
 * 加注参数：`--layer` 与 `--tokens` 必填。层名与数量都不做“尽力而为”的容错——
 * 把 task 写成 tsak 时应当报错，而不是默默加到一个没人看的层上。
 */
function parseTopUpArgs(args: readonly string[]): TopUpArgsParse {
  let layer: BudgetLayer | null = null;
  let addedTokens: number | null = null;
  let by = 'human';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--layer' || arg === '--tokens' || arg === '--by') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: `${arg} 缺少值` };
      i += 1;
      if (arg === '--layer') {
        if (!TOPUP_LAYERS.includes(value as BudgetLayer)) {
          return { ok: false, error: `--layer 只能是 ${TOPUP_LAYERS.join('|')}，收到 ${value}` };
        }
        layer = value as BudgetLayer;
      } else if (arg === '--tokens') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
          return { ok: false, error: `--tokens 必须是非负整数，收到 ${value}` };
        }
        addedTokens = n;
      } else {
        by = value;
      }
    } else {
      return { ok: false, error: `无法识别的参数：${arg}` };
    }
  }

  if (layer === null) return { ok: false, error: '缺少 --layer <step|turn|task|daily>' };
  if (addedTokens === null) return { ok: false, error: '缺少 --tokens N' };
  return { ok: true, value: { layer, addedTokens, by } };
}

type TailArgsParse =
  | { ok: true; value: { limit: number; type?: string | undefined } }
  | { ok: false; error: string };

/** tail 参数：`--limit` 必须 >= 1（`--limit 0` 是"我什么都不要看"，那是把命令用错地方了） */
function parseTailArgs(args: readonly string[]): TailArgsParse {
  let limit = DEFAULT_TAIL_LIMIT;
  let type: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--limit' || arg === '--type') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: `${arg} 缺少值` };
      i += 1;
      if (arg === '--limit') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          return { ok: false, error: `--limit 必须是 >= 1 的整数，收到 ${value}` };
        }
        limit = n;
      } else {
        type = value;
      }
    } else {
      return { ok: false, error: `无法识别的参数：${arg}` };
    }
  }
  return type === undefined ? { ok: true, value: { limit } } : { ok: true, value: { limit, type } };
}

const REVIEW_OUTCOMES: readonly ReviewOutcome[] = ['succeeded', 'failed', 'partial'];

type ReviewResolveParse = { ok: true; value: ResolveReviewInput } | { ok: false; error: string };

/** `review resolve <callId> --outcome <o> [--note "..."] [--by B]`：outcome 不做"尽力而为"的猜测 */
function parseReviewResolveArgs(args: readonly string[]): ReviewResolveParse {
  let callId: string | null = null;
  let outcome: ReviewOutcome | null = null;
  let note = '';
  let by = 'human';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--outcome' || arg === '--note' || arg === '--by') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: `${arg} 缺少值` };
      i += 1;
      if (arg === '--outcome') {
        if (!REVIEW_OUTCOMES.includes(value as ReviewOutcome)) {
          return { ok: false, error: `--outcome 只能是 ${REVIEW_OUTCOMES.join('|')}，收到 ${value}` };
        }
        outcome = value as ReviewOutcome;
      } else if (arg === '--note') {
        note = value;
      } else {
        by = value;
      }
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `无法识别的参数：${arg}` };
    } else if (callId === null) {
      callId = arg;
    } else {
      return { ok: false, error: `多余的参数：${arg}` };
    }
  }

  if (callId === null) return { ok: false, error: '缺少 <callId>' };
  if (outcome === null) return { ok: false, error: '缺少 --outcome <succeeded|failed|partial>' };
  return { ok: true, value: { callId, outcome, note, by } };
}

type AnswerArgsParse = { ok: true; value: AnswerCliInput } | { ok: false; error: string };

/**
 * `answer <文本> [--answer <文本>] [--askSeq <n>] [--callId <id>] [--by B]`。
 * 位置参数与 `--answer` 二选一：`irmia answer approve` 是最常用的一条，不该逼人写全称；
 * 但文本里带空格或 `--` 前缀时用 `--answer` 才不会被当成参数。
 *
 * `--askSeq` 是**答复哪一条提问**（`human/asked` 的 seq，见 `irmia status` 的"她在问"那段）。
 * 台面上同时摆着她问的卡与一条待批准的计划时，它是唯一说得清"我答的是哪一条"的办法；
 * 只有一条时不必写（answerHuman 会挑挂起中的那条，再退到最早一条她问的）。
 */
function parseAnswerArgs(args: readonly string[]): AnswerArgsParse {
  let answer: string | null = null;
  let callId: string | null = null;
  let askSeq: number | null = null;
  let by = 'human';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--answer') {
      const value = args[i + 1];
      if (value === undefined || value === '') return { ok: false, error: '--answer 需要一段文本' };
      if (answer !== null) return { ok: false, error: '答复给了两次（--answer 与位置参数只能用一个）' };
      answer = value;
      i += 1;
    } else if (arg === '--askSeq') {
      const value = args[i + 1];
      const parsed = value === undefined ? Number.NaN : Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: `--askSeq 需要一个 >= 1 的整数（human/asked 的 seq），收到 ${String(value)}` };
      }
      askSeq = parsed;
      i += 1;
    } else if (arg === '--callId') {
      const value = args[i + 1];
      if (value === undefined || value === '') return { ok: false, error: '--callId 需要一个 callId' };
      callId = value;
      i += 1;
    } else if (arg === '--by') {
      const value = args[i + 1];
      if (value === undefined || value === '') return { ok: false, error: '--by 需要一个署名' };
      by = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `无法识别的参数：${arg}` };
    } else if (answer === null) {
      answer = arg;
    } else {
      return { ok: false, error: `多余的参数：${arg}（文本含空格时用 --answer "..." 整体给出）` };
    }
  }

  if (answer === null || answer.trim() === '') {
    return { ok: false, error: '缺少答复文本：`irmia answer approve`，或 --answer "..."' };
  }
  return {
    ok: true,
    value: {
      answer,
      by,
      ...(callId !== null ? { callId } : {}),
      ...(askSeq !== null ? { askSeq } : {}),
    },
  };
}

type BudgetArgsParse = { ok: true; value: { today: boolean } } | { ok: false; error: string };

function parseBudgetArgs(args: readonly string[]): BudgetArgsParse {
  let today = false;
  for (const arg of args) {
    if (arg === '--today') today = true;
    else return { ok: false, error: `无法识别的参数：${arg}` };
  }
  return { ok: true, value: { today } };
}

/** 按关键字取帮助行：USAGE 的索引会随行数变动，错误提示不该跟着改数字 */
function usageFor(keyword: string): string {
  return USAGE.find((line) => line.includes(keyword)) ?? '';
}

type SkillConfirmParse = { ok: true; value: ConfirmSkillInput } | { ok: false; error: string };

function parseSkillConfirmArgs(args: readonly string[]): SkillConfirmParse {
  let name: string | null = null;
  let by = 'human';
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === undefined) continue;
    if (token === '--by') {
      const value = args[i + 1];
      if (value === undefined || value === '') return { ok: false, error: '--by 需要一个值' };
      by = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--')) return { ok: false, error: `无法识别的参数：${token}` };
    if (name !== null) return { ok: false, error: `多余的参数：${token}` };
    name = token;
  }
  if (name === null || name === '') return { ok: false, error: '缺少技能名（skill confirm <name>）' };
  return { ok: true, value: { name, by } };
}

type PersonaLogParse = { ok: true; json: boolean } | { ok: false; error: string };

function parsePersonaLogArgs(args: readonly string[]): PersonaLogParse {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else return { ok: false, error: `无法识别的参数：${arg}` };
  }
  return { ok: true, json };
}

type PersonaDiffParse = { ok: true; file: string; full: boolean } | { ok: false; error: string };

function parsePersonaDiffArgs(args: readonly string[]): PersonaDiffParse {
  let file: string | null = null;
  let full = false;
  for (const arg of args) {
    if (arg === '--full') full = true;
    else if (arg.startsWith('--')) return { ok: false, error: `无法识别的参数：${arg}` };
    else if (file === null) file = arg;
    else return { ok: false, error: `多余的参数：${arg}` };
  }
  if (file === null) return { ok: false, error: '缺少 <file>（例如 STATE.md）' };
  return { ok: true, file, full };
}

type PersonaRollbackParse =
  | { ok: true; file: string; hashPrefix: string; by: PersonaRollbackBy }
  | { ok: false; error: string };

/** 回滚参数：`<file> <diffHash>` 两个位置参数必填；`--by` 只接受 human/agent（与 schema 同域） */
function parsePersonaRollbackArgs(args: readonly string[]): PersonaRollbackParse {
  const positional: string[] = [];
  let by: PersonaRollbackBy = 'human';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--by') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: '--by 缺少值' };
      if (value !== 'human' && value !== 'agent') return { ok: false, error: `--by 只能是 human|agent，收到 ${value}` };
      by = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `无法识别的参数：${arg}` };
    } else if (positional.length < 2) {
      positional.push(arg);
    } else {
      return { ok: false, error: `多余的参数：${arg}` };
    }
  }
  const file = positional[0];
  const hashPrefix = positional[1];
  if (file === undefined) return { ok: false, error: '缺少 <file>（例如 STATE.md）' };
  if (hashPrefix === undefined) return { ok: false, error: '缺少 <diffHash>（先跑 persona log 取前 8 位即可）' };
  return { ok: true, file, hashPrefix, by };
}

type ReplayParse =
  | { ok: true; turn: number; step: number; out: string | null; diff: boolean }
  | { ok: false; error: string };

function parseReplayArgs(args: readonly string[]): ReplayParse {
  const positional: number[] = [];
  let out: string | null = null;
  let diff = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--out') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: '--out 缺少值' };
      out = value;
      i += 1;
    } else if (arg === '--diff') {
      diff = true;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `无法识别的参数：${arg}` };
    } else {
      const value = Number(arg);
      if (!Number.isInteger(value) || value < 1) {
        return { ok: false, error: `<turn> 与 <step> 必须是 >= 1 的整数，收到 ${arg}` };
      }
      positional.push(value);
    }
  }
  const turn = positional[0];
  const step = positional[1];
  if (turn === undefined || step === undefined) return { ok: false, error: '缺少 <turn> <step>（见 irmia tail --type step/）' };
  return { ok: true, turn, step, out, diff };
}

type ExportParse =
  | { ok: true; from: number; to: number; out: string | null }
  | { ok: false; error: string };

function parseExportArgs(args: readonly string[]): ExportParse {
  let from: number | null = null;
  let to: number | null = null;
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--from' || arg === '--to' || arg === '--out') {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, error: `${arg} 缺少值` };
      i += 1;
      if (arg === '--out') {
        out = value;
      } else {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) {
          return { ok: false, error: `${arg} 必须是 >= 1 的整数，收到 ${value}` };
        }
        if (arg === '--from') from = number;
        else to = number;
      }
    } else {
      return { ok: false, error: `无法识别的参数：${arg}` };
    }
  }
  if (from === null) return { ok: false, error: '缺少 --from <seq>' };
  if (to === null) return { ok: false, error: '缺少 --to <seq>' };
  if (to < from) return { ok: false, error: `--to (${to}) 必须不小于 --from (${from})` };
  return { ok: true, from, to, out };
}

type DoctorParse = { ok: true; json: boolean } | { ok: false; error: string };
function parseDoctorArgs(args: readonly string[]): DoctorParse {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else return { ok: false, error: `无法识别的参数：${arg}` };
  }
  return { ok: true, json };
}

export function resolveDataDir(): string {
  return process.env['IRMIA_DATA_DIR'] ?? join(process.cwd(), DEFAULT_DATA_DIR_NAME);
}

// ──────────────────────────────── jobs（后台任务观测） ────────────────────────────────

/** 输出查看默认打印的最大行数（人眼够用；要全文用 --full） */
const DEFAULT_JOB_OUTPUT_LINES = 200;

type JobsParse =
  | { ok: true; mode: 'list'; json: boolean }
  | { ok: true; mode: 'show'; jobId: string; full: boolean; out: string | null }
  | { ok: false; error: string };

/** 参数表：`--list` 强制列表；只给 `--json`/`--out` 而无 jobId 也走列表（`--out` 时把列表写文件） */
function parseJobsArgs(args: readonly string[]): JobsParse {
  let json = false;
  let list = false;
  let full = false;
  let out: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--list') list = true;
    else if (arg === '--json') json = true;
    else if (arg === '--full') full = true;
    else if (arg === '--out') {
      const value = args[i + 1];
      if (value === undefined || value === '') return { ok: false, error: '--out 需要一个文件路径' };
      out = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `无法识别的参数：${arg}` };
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) return { ok: false, error: `多余的参数：${positional[1]}` };
  const jobId = positional[0];
  if (list || jobId === undefined) {
    if (full) return { ok: false, error: '--full 只对 jobs <jobId> 有意义' };
    return { ok: true, mode: 'list', json };
  }
  return { ok: true, mode: 'show', jobId, full, out };
}

const JOB_STATUS_LABEL: Record<JobRecord['status'], string> = {
  running: '运行中',
  finished: '已完成',
  lost: '已丢失',
};

function formatJobList(records: readonly JobRecord[]): string[] {
  if (records.length === 0) {
    return ['没有后台任务记录（data/jobs/ 为空）。后台任务由 pwsh 的 runInBackground 创建。'];
  }
  const lines = [`后台任务 ${records.length} 个（按启动时刻升序）：`];
  for (const record of records) {
    const exit = record.exitCode === undefined || record.exitCode === null
      ? ''
      : ` 退出码 ${record.exitCode}`;
    const blob = record.output?.blob === undefined ? '' : ` 全文 ${record.output.blob.bytes} 字节已外置`;
    lines.push(
      `  [${JOB_STATUS_LABEL[record.status]}] ${record.jobId}${exit}${blob}`
      + `  ${record.startedAt}  turn ${record.turn}  ${clip(record.command, 60)}`,
    );
  }
  return lines;
}

/** 输出正文按行截断：默认给尾部（失败信息通常在末尾），`--full` 给全文 */
function tailLines(text: string, maxLines: number): { text: string; omitted: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, omitted: 0 };
  return { text: lines.slice(lines.length - maxLines).join('\n'), omitted: lines.length - maxLines };
}

async function formatJobShow(dataDir: string, jobId: string, full: boolean): Promise<{ lines: string[]; exitCode: number }> {
  const records = await readJobHistory(dataDir);
  const record = records.find((item) => item.jobId === jobId) ?? null;
  if (record === null) {
    return { lines: [`没有名为 ${jobId} 的后台任务。用 jobs --list 看全部。`], exitCode: 1 };
  }
  const bytes = record.output === undefined ? null : await jobOutputBytes(record.output.file);
  const header = [
    `任务 ${record.jobId}（${JOB_STATUS_LABEL[record.status]}）`,
    `  命令：${record.command === '' ? '(未记录)' : record.command}`,
    `  turn ${record.turn}  起 ${record.startedAt}${record.finishedAt === undefined ? '' : `  止 ${record.finishedAt}`}`,
    `  退出码：${record.exitCode === undefined ? '(未知)' : String(record.exitCode)}`
      + `  输出文件：${record.output?.file ?? '(未记录)'}${bytes === null ? '' : `（${bytes} 字节）`}`,
  ];
  if (record.output?.blob !== undefined) {
    header.push(`  外置全文：blobs/${record.output.blob.blobId}（${record.output.blob.bytes} 字节）`);
  }

  const output = await readJobOutput(dataDir, record);
  if (!output.ok) {
    header.push('  输出：读取失败（文件可能已被清理）；事件日志里的 job/finished 仍是权威记录。');
    return { lines: header, exitCode: record.status === 'finished' ? 0 : 1 };
  }
  const sliced = full ? { text: output.text, omitted: 0 } : tailLines(output.text, DEFAULT_JOB_OUTPUT_LINES);
  header.push(`  输出（来源：${output.from === 'blob' ? '外置 blob' : '输出文件'}）`
    + `${sliced.omitted > 0 ? `，省略前 ${sliced.omitted} 行（--full 打印全文）` : ''}：`);
  header.push(...sliced.text.replace(/\n$/u, '').split('\n'));
  const exitCode = record.status === 'finished' ? 0 : 1;
  return { lines: header, exitCode };
}

export async function runCli(argv: readonly string[], io: CliIO, ctx: CliContext): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    for (const line of USAGE) io.out(line);
    return 0;
  }

  if (command === 'status') {
    const report = await buildStatusReport(ctx.dataDir);
    if (rest.includes('--json')) io.out(JSON.stringify(report, null, 2));
    else for (const line of formatStatus(report)) io.out(line);
    return 0;
  }

  if (command === 'wake') {
    const parsed = parseWakeArgs(rest);
    if (!parsed.ok) {
      io.err(`wake: ${parsed.error}`);
      io.err(usageFor('wake --note'));
      return 2;
    }
    // 默认带本机用户的档案标识：人戳她 = 人说话，于是关系档案自动注入。
    // 要“无人格”的纯注入（脚本用途）就写 --person ""。
    const person = parsed.value.person ?? await ownerPersonFor(ctx.cwd);
    const input: WakeNoteInput = { note: parsed.value.note };
    if (parsed.value.dedupeKey !== undefined) input.dedupeKey = parsed.value.dedupeKey;
    if (person !== '') input.person = person;
    const path = writeWakeNote(ctx.dataDir, input, (ctx.now ?? (() => new Date()))());
    io.out(`已写看门文件：${path}`);
    io.out(person === ''
      ? '主进程下一拍会把它转成 wake/manual 事件（不带人，不注入关系档案）'
      : `主进程下一拍会把它转成 wake/manual 事件（带人：${person} → RELATIONSHIPS/${person}.md）`);
    return 0;
  }

  if (command === 'topup') {
    const parsed = parseTopUpArgs(rest);
    if (!parsed.ok) {
      io.err(`topup: ${parsed.error}`);
      io.err(usageFor('topup --layer'));
      return 2;
    }
    const now = (ctx.now ?? (() => new Date()))();
    const path = writeTopUpRequest(ctx.dataDir, { ...parsed.value, ts: now.toISOString() }, now);
    io.out(`已写加注看门文件：${path}`);
    io.out('主进程下一拍会把它转成 budget/topped-up 事件，并解除该层的可恢复暂停');
    return 0;
  }

  if (command === 'tail') {
    const parsed = parseTailArgs(rest);
    if (!parsed.ok) {
      io.err(`tail: ${parsed.error}`);
      io.err(usageFor('tail ['));
      return 2;
    }
    const scan = readTailEvents(join(ctx.dataDir, EVENT_LOG_DIR_NAME), parsed.value);
    for (const line of formatTail(scan, parsed.value.type ?? null)) io.out(line);
    return 0;
  }

  if (command === 'skill') {
    const sub = rest[0];
    const subArgs = rest.slice(1);

    if (sub === 'list') {
      if (subArgs.length > 0) {
        io.err(`skill list: 无法识别的参数：${subArgs.join(' ')}`);
        io.err(usageFor('skill list'));
        return 2;
      }
      for (const line of formatSkillList(buildSkillList(ctx.dataDir, ctx.cwd ?? process.cwd()))) io.out(line);
      return 0;
    }

    if (sub === 'confirm') {
      const parsed = parseSkillConfirmArgs(subArgs);
      if (!parsed.ok) {
        io.err(`skill confirm: ${parsed.error}`);
        io.err(usageFor('skill confirm'));
        return 2;
      }
      const result = await confirmSkill(
        ctx.dataDir,
        parsed.value,
        (ctx.now ?? (() => new Date()))(),
        ctx.cwd ?? process.cwd(),
      );
      if (!result.ok) {
        io.err(`skill confirm: ${result.error}`);
        return result.code;
      }
      io.out(`已确认技能 ${parsed.value.name}（by ${parsed.value.by}）`);
      io.out(`skill/installed 已落盘（seq=${result.seq}，fsync 完成，contentHash ${result.contentHash.slice(0, 8)}）`);
      io.out('下一轮 turn 起它会出现在状态层的技能索引里；改动 SKILL.md 会重新退回待确认。');
      return 0;
    }

    io.err(sub === undefined
      ? 'skill: 缺少子命令（list | confirm <name>）'
      : `skill: 未知子命令 ${sub}`);
    io.err(usageFor('skill list'));
    return 2;
  }

  if (command === 'review') {
    const sub = rest[0];
    const subArgs = rest.slice(1);

    if (sub === 'list') {
      if (subArgs.length > 0) {
        io.err(`review list: 无法识别的参数：${subArgs.join(' ')}`);
        io.err(usageFor('review list'));
        return 2;
      }
      for (const line of formatReviewList(buildReviewList(ctx.dataDir))) io.out(line);
      return 0;
    }

    if (sub === 'resolve') {
      const parsed = parseReviewResolveArgs(subArgs);
      if (!parsed.ok) {
        io.err(`review resolve: ${parsed.error}`);
        io.err(usageFor('review resolve'));
        return 2;
      }
      const result = await resolveReview(ctx.dataDir, parsed.value, (ctx.now ?? (() => new Date()))());
      if (!result.ok) {
        io.err(`review resolve: ${result.error}`);
        return result.code;
      }
      io.out(`已结案：${parsed.value.callId} → ${parsed.value.outcome}`);
      io.out(`review/resolved 已落盘（seq=${result.seq}，fsync 完成，by ${parsed.value.by}）`);
      return 0;
    }

    io.err(sub === undefined
      ? 'review: 缺少子命令（list | resolve <callId> --outcome <...>）'
      : `review: 未知子命令 ${sub}`);
    io.err(usageFor('review list'));
    return 2;
  }

  if (command === 'jobs') {
    const parsed = parseJobsArgs(rest);
    if (!parsed.ok) {
      io.err(`jobs: ${parsed.error}`);
      io.err(usageFor('jobs [--list]'));
      return 2;
    }

    if (parsed.mode === 'list') {
      // 列表读的是 data/jobs/ 的索引（含上一个进程跑过的任务），不写任何事件——
      // CLI 是观测面，不是第二个控制面（design §4.16 的权限模型）
      const records = await readJobHistory(ctx.dataDir);
      if (parsed.json) {
        io.out(JSON.stringify(records, null, 2));
        return 0;
      }
      for (const line of formatJobList(records)) io.out(line);
      return 0;
    }

    const detail = await formatJobShow(ctx.dataDir, parsed.jobId, parsed.full);
    const text = detail.lines.join('\n');

    if (parsed.out !== null) {
      // 导出到文件（复盘取证用）：写盘失败必须是显式失败，不能只少了一行输出
      try {
        writeFileSync(parsed.out, `${text}\n`, 'utf8');
      } catch (err) {
        io.err(`jobs: 无法写入 ${parsed.out}：${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      io.out(`已写入 ${parsed.out}（${text.length} 字符）`);
      return 0;
    }

    for (const line of detail.lines) io.out(line);
    return detail.exitCode;
  }

  if (command === 'answer') {
    const parsed = parseAnswerArgs(rest);
    if (!parsed.ok) {
      io.err(`answer: ${parsed.error}`);
      io.err(usageFor('answer'));
      return 2;
    }
    const result = await answerSuspension(ctx.dataDir, parsed.value, (ctx.now ?? (() => new Date()))());
    if (!result.ok) {
      io.err(`answer: ${result.error}`);
      return result.code;
    }
    io.out(`已答复人审（by ${parsed.value.by}）：human/answered 已落盘（seq=${result.answerSeq}，fsync 完成）`);
    if (result.planResolvedSeq !== null) {
      io.out(`plan/resolved 已落盘（seq=${result.planResolvedSeq}）：${result.planCallId} → ${result.planOutcome}`);
      io.out(result.planOutcome === 'approved'
        ? '批准只放行这一次：实例醒来后会按同一份参数重发这件调用并执行。'
        : '拒绝已记档；她看到答复理由后会改做法，不会原样重发。');
    }
    io.out('实例下次启动/下一拍会把挂起 turn 认领的输入重新入队（input/requeued{reason:human-answered}）');
    return 0;
  }

  if (command === 'budget') {
    const parsed = parseBudgetArgs(rest);
    if (!parsed.ok) {
      io.err(`budget: ${parsed.error}`);
      io.err(usageFor('budget'));
      return 2;
    }
    const events = readEventsReadOnly(join(ctx.dataDir, EVENT_LOG_DIR_NAME)).events;
    const limits = ctx.budget === undefined
      ? await loadBudgetLimits(ctx.cwd ?? process.cwd())
      : { budget: ctx.budget, source: 'injected' as const };
    const report = buildBudgetReport({
      dataDir: ctx.dataDir,
      budget: limits.budget,
      events,
      limitSource: limits.source,
    });
    for (const line of formatBudget(report, { today: parsed.value.today })) io.out(line);
    return 0;
  }

  if (command === 'persona') {
    const sub = rest[0];
    const subArgs = rest.slice(1);

    if (sub === 'log') {
      const parsed = parsePersonaLogArgs(subArgs);
      if (!parsed.ok) {
        io.err(`persona log: ${parsed.error}`);
        io.err(usageFor('persona log'));
        return 2;
      }
      for (const line of formatPersonaLog(buildPersonaLog(ctx.dataDir), { json: parsed.json })) io.out(line);
      return 0;
    }

    if (sub === 'diff') {
      const parsed = parsePersonaDiffArgs(subArgs);
      if (!parsed.ok) {
        io.err(`persona diff: ${parsed.error}`);
        io.err(usageFor('persona diff'));
        return 2;
      }
      const result = buildPersonaDiff(ctx.dataDir, parsed.file);
      if (!result.ok) {
        io.err(`persona diff: ${result.error}`);
        return result.code;
      }
      for (const line of formatPersonaDiff(result.report, { full: parsed.full })) io.out(line);
      return 0;
    }

    if (sub === 'rollback') {
      const parsed = parsePersonaRollbackArgs(subArgs);
      if (!parsed.ok) {
        io.err(`persona rollback: ${parsed.error}`);
        io.err(usageFor('persona rollback'));
        return 2;
      }
      const now = (ctx.now ?? (() => new Date()))();
      const result = await rollbackPersona(ctx.dataDir, parsed.file, parsed.hashPrefix, { by: parsed.by, now });
      if (!result.ok) {
        io.err(`persona rollback: ${result.error}`);
        return result.code;
      }
      io.out(`已回滚 ${result.file} → ${result.diffHash.slice(0, 8)}（${result.bytes} 字节）`);
      if (result.archived) io.out(`回滚前的内容已归档进版本库：${result.previousHash?.slice(0, 8) ?? '?'}（可再次回滚回去）`);
      io.out(`persona/updated 已落盘（seq=${result.eventSeq}，fsync 完成，by ${parsed.by}）`);
      return 0;
    }

    io.err(sub === undefined
      ? 'persona: 缺少子命令（log | diff <file> | rollback <file> <diffHash>）'
      : `persona: 未知子命令 ${sub}`);
    io.err(usageFor('persona log'));
    return 2;
  }

  if (command === 'replay') {
    const parsed = parseReplayArgs(rest);
    if (!parsed.ok) {
      io.err(`replay: ${parsed.error}`);
      io.err(usageFor('replay <turn>'));
      return 2;
    }
    const result = await buildReplayReport(ctx.dataDir, parsed.turn, parsed.step, { cwd: ctx.cwd ?? process.cwd() });
    if (!result.ok) {
      io.err(`replay: ${result.error}`);
      return 2;
    }
    const report = result.report;
    for (const line of formatReplaySummary(report)) io.out(line);

    if (parsed.out !== null) {
      const path = isAbsolute(parsed.out) ? parsed.out : join(ctx.cwd ?? process.cwd(), parsed.out);
      writeOutputFile(path, `${JSON.stringify(report.request, null, 2)}\n`);
      io.out(`请求体已导出：${path}（${jsonBytesOf(report.request)} 字节）`);
      return 0;
    }

    if (parsed.diff) {
      io.out('并排对照（左 = 当时口径重建，右 = 当前时刻重渲染）:');
      for (const line of formatRequestDiff(report.diff)) io.out(line);
      return 0;
    }

    io.out('请求体（JSON）:');
    io.out(JSON.stringify(report.request, null, 2));
    return 0;
  }

  if (command === 'export') {
    const parsed = parseExportArgs(rest);
    if (!parsed.ok) {
      io.err(`export: ${parsed.error}`);
      io.err(usageFor('export --from'));
      return 2;
    }
    const report = buildExport(ctx.dataDir, parsed.from, parsed.to);
    // 头信息走 stderr：stdout 必须能被原样重定向成一份日志片段
    io.err(`导出 seq ${report.from}..${report.to}：${report.count} 条事件`
      + `（读了 ${report.shardsRead} 个分片${report.badLines === 0 ? '' : `，跳过 ${report.badLines} 行坏内容`}）`);
    if (parsed.out === null) {
      for (const line of report.body.split('\n')) {
        if (line !== '') io.out(line);
      }
      return 0;
    }
    const path = isAbsolute(parsed.out) ? parsed.out : join(ctx.cwd ?? process.cwd(), parsed.out);
    writeOutputFile(path, report.body);
    io.err(`已写出：${path}`);
    return 0;
  }

  if (command === 'doctor') {
    const parsed = parseDoctorArgs(rest);
    if (!parsed.ok) {
      io.err(`doctor: ${parsed.error}`);
      io.err(usageFor('doctor'));
      return 2;
    }
    const report = await runDoctor(ctx.dataDir);
    if (parsed.json) io.out(JSON.stringify(report, null, 2));
    else for (const line of formatDoctor(report)) io.out(line);
    // M6-7 的验收口径：任一 ✗ → 退出码非 0
    return report.failures > 0 ? 1 : 0;
  }

  io.err(`未知命令：${command}`);
  for (const line of USAGE) io.err(line);
  return 2;
}

// ──────────────────────────────── 入口 ────────────────────────────────

function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return moduleUrl === pathToFileURL(entry).href;
}

if (isDirectRun(import.meta.url)) {
  const io: CliIO = {
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  };
  runCli(process.argv.slice(2), io, { dataDir: resolveDataDir() }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      io.err(`[致命] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
