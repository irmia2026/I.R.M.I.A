import { allEventsOf } from '../state/event-snapshot.ts';
/**
 * Irmia Agent — 真循环驱动（M2 骨架 + M3 刹车与告警接入）
 *
 * 与 docs/design.md §4.4 对齐：pending 有输入 → 取回 wake 事件 → runTurn → 结算结局。
 * 与 FakeLoop 同形（start/stop/writeProjectionCache），main.ts 按有无 API key 二选一。
 *
 * M3 在这里接上四件事（判定逻辑在 runtime/budget-guard.ts 与 alert/notifier.ts，动作在这里）：
 *   ① **刹车**：`checkBeforeStep` 换成 BudgetGuard 完整版（四层，撞线时由它自己写
 *      `budget/exhausted{resumable:true}`），单步工具数走 `stepCallLimit` / `onStepOverflow`；
 *      撞刹车后进入**可恢复暂停**——pending 一条不动，加注后从原地继续，绝不清空重来（§4.6）。
 *   ② **软阈值先说话**：`softHint` 直连 guard，agent-loop 把它作为尾部 developer 消息插播；
 *      历史段一个字节都不改（KV cache 前缀完好，§4.13）。
 *   ③ **唤醒门**：每日额度撞线、已撞的 task 层刹车未加注、连续模型失败达阈值——三种情况都
 *      **拒绝唤醒**：不写 turn/start、不认领输入、发告警后待机（§4.6 表格 daily 行 + §4.9）。
 *   ④ **告警出口**：预算耗尽 / 连续失败 / 水位停滞（§4.9 触发点清单里的三条）走 alert/notifier；
 *      限流窗口在启动时用 `notifier.restore(日志)` 重建，所以重启不会让一个坏接口重新刷屏（M3-10）。
 *
 * 加注（topup）是暂停的唯一出口：CLI 只写 `<dataDir>/topup/topup-<ts>.json`，本模块下一拍拾取、
 * 先落事件再删文件，然后用"配置上限 + 加注累计"重建判定器——加注抬高上限，已消耗的 token
 * 一个字节都不动（M3-5：进度不丢）。
 *
 * M5 在这里补上心跳（判定逻辑在 wake/heartbeat.ts）：
 *   ⑤ **心跳**：本模块自己持有 Heartbeat（随 start/stop 布防），抽中时写 `wake/heartbeat`。
 *      概率模型：安静 < floor 绝不触发、≥ ceil 必然触发、中间每 tick 抽一次签且命中概率随安静上升；
 *      形状指数 α 不在这里给——按 `wake.heartbeatTargetMeanMin`（目标均值，"平均多久醒一次"）
 *      在构造时反解（`solveHeartbeatAlpha`）；启动摘要会把"目标 ⇒ 解出的 α"报出来。
 *      `noteActivity()` 只在**外部事件**到达时复位——心跳自己不复位，否则概率永远起不来（§4.12）。
 *      心跳拍是**真实唤醒**：它照常进 turn（主力车道 + 与普通回合同一份冻结前缀），
 *      因为"唤醒一次的花费远少于缓存前缀被供方回收的花费"（2026-10-05 用户改口径）。
 *   ⑥ **回复必要性门已拆**（2026-10-05）：它唯一做的事是"调模型之前替她闭嘴=一个请求都不发"，
 *      与被废掉的口径正好相反。原意、为什么废、别再把它接回心跳拍的警告见
 *      docs/design.md 的「试过并废掉的口径：回复必要性门」。
 *
 * M5 在这里补上折叠快照：每天首次 + 每 SNAPSHOT_EVERY_EVENTS 条事件写一次 `data/snapshots/`，
 * 并写 `snapshot/checkpoint` 事件；恢复时 runtime/recover.ts 从最近快照起算（M5-9）。
 */

import { existsSync, readFileSync, readdirSync, statfsSync, unlinkSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { arch, platform as osPlatform, release as osRelease } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getHeapStatistics } from 'node:v8';

import type { AppEvent, BudgetLayer, CompactionWarningTier, PendingInput, Projection, TurnEndReason, WakeChannel } from '../log/types.js';
import type { RuntimeRestart, RuntimeRestartPrevious } from '../log/types.js';
import { isImageAttachment, isTopLevelEvent, defaultVisibility } from '../log/types.ts';
// 申请单那一套（她发起 → 待批 → 用户点 → 框架执行）：唯一实现在 `grant/mcp-grant.ts`
import { settleGrants } from '../grant/mcp-grant.ts';
import {
  contextImageAdmission,
  contextImageSkipText,
  type ContextImageSkipReason,
} from '../log/types.ts';
import { InjectionJudge, type InjectionVerdict } from '../channel/injection-judge.ts';
import {
  injectionNoteOf, noteForFlagged, quotesOfHints, reasonOfHints, scanForInjection, speakerWordsOf,
} from '../channel/injection.ts';
import { TopicSummarizer, isUnattendedGroup } from '../channel/topic.ts';
import type { WakeEmission } from '../wake/sources.js';
import type { EventLog } from '../log/event-log.js';
import type { DsClient } from '../model/ds-client.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  DEFAULT_ASK_HUMAN_TIMEOUT_MIN,
  DEFAULT_WORKSPACE_DIR_NAME,
  trustBoundaryRoot,
  type AppConfig,
} from '../config/config.ts';
import type { PersonaAssets } from '../persona/loader.js';
// 增量事件快照（`allEventsOf` 的门面）：step 边界的拾取**必须**先拿当前视图再判幂等
// （见 `settleGrantsAtStep` 的注释；这一份与 `mcpIndexSync` 用的是同一个按日志实例的缓存）
import { readAllEvents } from '../state/event-snapshot.ts';
import { applyOne, finalizePressure, wakeSourceOf } from '../state/fold.ts';
import { saveProjectionCache } from '../state/projection-cache.ts';
import { writeSnapshot } from '../state/snapshot.ts';
import { runTurn, isHeartbeatTurn, compactionCoveredUpToSeq, handoffOptionsOf, mentionNoticeOf, contactWithWakeStamp, STEP_PREWARM_TIMEOUT_MS, type AgentLoopBudget, type AgentLoopDeps, type CompactionWarning, type TurnTiming } from './agent-loop.ts';
// 回投能力的唯一判据在 tools/admin（speak 第三路用它）：这里读同一个函数，
// 免得「提示词告诉她能发」与「实际能不能发」变成两套口径。
import {
  channelRenderOf, collectSessions as collectSessionsFromLog, normalizeSid, parseAliases, parseMemberAliases,
  resolveNameForSid, resolvePersonNameFromTables, sidOf,
  upsertSession as upsertSessionInto, type SessionAlias as KnownSessionAlias, type SessionEntry as KnownSession,
} from '../channel/sessions.ts';
import type { ChannelMessageView, ChannelSpoken, ContextImageFact } from '../tools/admin.js';
import {
  CONTEXT_IMAGE_HARD_BYTES,
  DEFAULT_ATTACHMENT_TIMEOUT_MS,
  DEFAULT_COMPRESS_TIMEOUT_MS,
  attachmentPath,
  compressedPath,
  ensureAttachment,
  readAttachmentImage,
  readFileImage,
} from '../channel/attachment-store.ts';
import { deliveredToSid, replyableWakeChannel, type ChannelSessionRow } from '../tools/admin.ts';
// 频次窗口那一个数：会话清单用它数条数（渲染层），这里用它剪掉窗口外的素材（内存）——同一个常量
import { SESSION_FREQ_WINDOW_MS, type ContactFacts } from '../model/self-brief.ts';
import type { MachineFacts, MaintenanceWindowNote, RenderChannelContext, RenderImageRef, TurnBlockFacts, UsageFacts } from '../model/render.ts';
import {
  compactionSoonNote,
  compactionWarningRowsOf,
  compactionWarningStateOf,
  planCompactionWarning,
} from '../model/compaction-warning.ts';
import { SELF_ORGANIZE_VIA, planSelfOrganizeReminder, selfOrganizeNote, selfOrganizeTraceOf } from '../model/self-organize-reminder.ts';
import {
  cacheAlertConsoleLine,
  cacheAlertPayloadOf,
  cacheAlertWakeNote,
  planCacheAlerts,
  type CacheAlertReading,
} from './cache-alert.ts';
import {
  echoPressureConsoleLine,
  echoPressureWakeNote,
  planEchoPressure,
  readEchoPressure,
} from './reasoning-echo-pressure.ts';
import { RENDER_VERSION, lastCompactionReading, lastMaintenanceWindowAt, localHourOf, maintenanceWindowOf, mcpIndexOf, skillIndexOf, wakeTitle } from '../model/render.ts';
// 只借一个**类型**（`import type` 在运行时被擦掉）：循环要知道"热更刚刚发生了什么"，
// 而那份账的形状归 watcher（它是唯一生产者）。这不引入运行时依赖，也不让循环认识 watcher。
import type { ConfigReloadOutcome } from '../config/watcher.js';
import {
  ASK_HUMAN_BLOCKED_BY, DEFAULT_HUMAN_TIMEOUT_MS, PlanMode,
  humanTimeoutElapsed, scanSuspension, type Suspension,
} from './plan-mode.ts';
import { relationshipForWake } from '../persona/relationship.ts';
import type { RelationshipNote } from '../persona/relationship.ts';
import { BudgetGuard, DEFAULT_STALL_MS, stallOf, type StallInfo } from './budget-guard.ts';
import { createNotifier, fingerprintOf, type AlertNotifier } from '../alert/notifier.ts';
import {
  backfillCandidates, backfillResolvedAlarms, pausedLayers, raisedLayers, unresolvedCategories,
} from '../alert/startup.ts';
import { Heartbeat, HeartbeatSource, type HeartbeatFiring } from '../wake/heartbeat.ts';
import { holdsGroupBatch } from './group-batch.ts';
import type { SkillManager } from '../skill/skills.js';
// `skill/index` 的**唯一写入实现**：循环（三条判据成立时）与人工归集（`irmia skill reindex`）
// 共用这一份，两条路写下的快照逐字段相同。理由见那个文件的文件头。
import { writeSkillIndexSnapshot } from '../skill/index-snapshot.ts';
import type { HookRunner } from '../hook/hooks.js';
import type { TimerStore } from '../wake/timer-store.js';
import { trustOfBatch, isOwnerLabel, type TurnTrust } from './trust.ts';
import { createAuthzGate, type Scenario } from './authz.ts';
import { GroupMemberBook } from '../channel/group-members.ts';
// 「我自己是谁」的判据实现（**全仓唯一一处**）：群成员登记那一档与宿主的落库口共用它
// （递进来的是同一个 SelfIdentity 实例，见 RealLoopDeps.selfMessages）；
// `channel/notice` 的形状与视图也出自同一处（`readChannelNotices` 是它唯一的读口）
import { isChannelNoticeData, noticeViewOf, type ChannelNoticeView, type SelfIdentity } from '../channel/self-identity.ts';
// 「我做过」的形状与视图（`readChannelActions` 是它唯一的读口；判据在那个模块里只有一处）
import { isChannelSelfActionData, type ChannelSelfActionView } from '../channel/self-action.ts';
// "这是不是我自己"那一刀（判据只有一份，两个落点共用；见 `channel/self-message-gate.ts`）
import { groupMemberGate } from '../channel/self-message-gate.ts';
import { WarnExemptBook, type WarnExemptSubject } from '../channel/warn-exempt.ts';
// `msgSeqOf`：平台给不出消息序号时"补事件 seq"的**唯一判据**（信箱那条路也走它）
import { msgSeqOf } from '../channel/inbox.ts';
import { MEMORY_MAINTAIN_PAYLOAD_KIND, maintainMemory, memoriesDir } from '../persona/memory-maintain.ts';
import {
  MCP_INDEX_DESC_CLAUSE_VERSION, mcpIndexView, probeOnPath, type AssetFactSource,
} from '../persona/assets.ts';
import {
  buildMemoryIndex, emptyMemoryIndex, ensureMemoryIndex, applyIndexBudget, memoryIndexNeighbors,
  type MemoryIndex, type MemoryIndexEntry,
} from '../persona/memory-injection.ts';
import { formatScore } from '../persona/bm25.ts';
import {
  MEMORY_QUERY_INPUT_COUNT, MEMORY_RECOMMEND_TOP_N, buildMemoryQuery, renderMemoryRecommendation,
  selectMemoryRecommendation,
  type MemoryIndexNeighbors, type MemoryQueryFingerprint, type MemoryQueryInput,
  type MemoryRecommendation, type MemoryRecommendationItem,
} from '../persona/memory-select.ts';
import {
  RECALL_MIN_IDF_QUANTILE, buildBodyMatcher, gateRecall, loadRecallDictionaryFile, matchRecall,
  planRecallTurn, recallDictionaryPath, renderRecallPointer, renderRecallSegment, type RecallTrace,
} from '../persona/recall.ts';
import { estimateTokens } from '../tools/registry.ts';
import {
  applyTopUpEvent, emptyTopUps, foldTopUps, parseTopUpRequest, raiseLimits,
  TOPUP_FILE_PREFIX, TOPUP_WATCH_DIR_NAME, type TopUpTotals,
} from './topup.ts';
import {
  COMPACT_EMPTY_RECEIPT, COMPACT_RECEIPT, HANDOFF_EMPTY_RECEIPT, HANDOFF_RECEIPT,
  STOP_IDLE_RECEIPT, STOP_RECEIPT,
  isFrameworkCommandEvent, isSlashCommandEvent, isStopCommandText, parseSlashCommand,
  unknownCommandReply, type SlashCommand,
} from './slash-commands.ts';
import { mechanicalSummaryText, renderHandoffNote } from '../persona/handoff-note.ts';
import { sha256Hex } from '../persona/versions.ts';
import { formatTempSweepLine, tempSweptPayload, type TempSweepReport } from '../util/temp-sweep.ts';
import type { TaskLoopRuntimeDeps } from '../tools/catalog.js';
import type { ToolPlanGate } from '../tools/executor.js';

// ──────────────────────────────── 常量 ────────────────────────────────

/** 告警类别（限流指纹的类别段：同类故障 30 分钟一条，恢复通知单独成指纹） */
const CATEGORY = {
  budget: 'budget-exhausted',
  failStreak: 'model-failure',
  stall: 'stall',
  /** 人审挂起超时（design §4.21）：与预算耗尽分开成类——两类事的救法不同，不该共用限流指纹 */
  human: 'human-timeout',
  /**
   * 用户急停（`/stop`，2026-10-16 加）：**单独成类**，理由与上面那条同源——
   * 它不是故障（`level: 'info'`），与预算耗尽/失败刹车/停滞的处置完全不同；
   * 共用指纹会让"用户按了停止"跟"预算又爆了"互相顶掉限流窗口。人不会连按这个按钮，
   * 限流窗口按类别各自算即可。
   */
  stop: 'owner-stop',
} as const;

/**
 * 水位停滞阈值（毫秒，`DEFAULT_STALL_MS`，见 budget-guard）：**输入自己**等了这么久还没被处理
 * → §4.9 告警。
 *
 * 值仍是 10 分钟（design §4.9 的原口径），但计时起点从"距上次成功模型调用"改成了
 * "最早那条待处理输入的到达时刻"（见 `stallOf`）——所以它与 30 分钟的心跳基线不再冲突：
 * 安静地待着不会累积这个时长，只有真有人在等才会。
 *
 * 唯一要留意的量级约束：它必须明显大于群消息攒批窗口
 * （`channels.qqOfficial.groupBatchMinutes`，默认 3 分钟）——那段时间里输入是**有意**压着的。
 */

/** 失败刹车后的半开冷却（毫秒）：冷却期满放行一次试探，避免坏接口被反复打 */
const DEFAULT_FAIL_COOLDOWN_MS = 30 * 60 * 1000;
/** 单拍最多认领的输入条数（与 M2 一致：一批多条时的边界固定，便于复盘） */
const BATCH_LIMIT = 8;

/**
 * 「到的是哪一档」那一句话的素材——**唯一一处**。
 *
 * `field` 是界面上那几行**字段标签的逐字**（`gui/lib/pages/settings_page.dart` 的 `_SysField`，
 * 「分区七：系统」那张卡）：人拿着告警去设置里找，标签差一个字就等于没说。
 *
 * `scope` 是这一档"数的是什么"的口径。token 那两档用的是仓库里既有的那句话
 * （与界面字段说明、`BUDGET_METRIC_NOTE`、此刻层 `用度：` 那一行同一个口径）：数的是
 * **真花钱的那部分**——输入里没命中缓存的 + 输出；缓存命中的那一大截**不算**
 *（2026-10-05 用户换的口径，逐字原话与唯一定义在 `state/fold.ts` 的 `budgetTokensOf`）。
 * 措辞刻意用大白话**不写术语**：这句话是撞刹车时给人看的，人要知道的是"这数是不是我花的钱"，
 * 不是"非缓存口径"这五个字。次数那两档就如实说数的是次数，不硬套 token 的话。
 */
const BUDGET_LAYER_FACTS: Record<BudgetLayer, { name: string; field: string; scope: string }> = {
  step: {
    name: '步内工具调用',
    field: '预算 · 步内工具调用上限',
    scope: '这一档数的是**工具调用次数**，不是 token',
  },
  turn: {
    name: '单 turn 步数',
    field: '预算 · 单 turn 步数上限',
    scope: '这一档数的是**一个 turn 里跑了几步**，不是 token',
  },
  task: {
    name: '任务 token',
    field: '预算 · 任务 token 上限',
    scope: '这一档数的是**真花钱的那部分**：输入里没命中缓存的 + 输出（缓存命中的那一大截不算在内）',
  },
  daily: {
    name: '每日 token',
    field: '预算 · 每日 token 上限',
    scope: '这一档数的是**真花钱的那部分**：输入里没命中缓存的 + 输出（缓存命中的那一大截不算在内）',
  },
};

/**
 * 告警里的 token 数一律走它：**千位分隔**。
 *
 * 现场那张告警是「已用 178734979 / 上限 57000000」——一串没有分隔的数字，人眼要先数位数
 * 才知道它是不是"两个数量级"的错。带上分隔符（178,734,979）这件事一眼就能看出来。
 * 只做展示，不进事件、不进账（事件里的 limit/actual 仍是原始整数）。
 */
function formatTokens(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * 进主循环上下文的事件（`AgentLoopDeps.eventFilter`）——两刀，判据都在别的模块里：
 *
 *   ① **顶层**（design §4.21）：子代理链（`parentCallId` 非空）是它自己那条 turn 链的内部过程，
 *      进了父请求就等于让父模型看见"自己"没说过的话（`isTopLevelEvent`）；
 *   ② **不是"整条就是一条指令"的 `wake/manual`**（B1 第二步，`isSlashCommandEvent`）：
 *      指令是给框架的，她该看见的是效果而不是按钮。
 *
 * 为什么它是一个模块级函数而不是内联的箭头函数：`replay` 必须用**同一份**口径重建请求
 * （`replay.ts` 的归属过滤里引的是同一个函数），否则"同一份日志重建同一份请求"就断了。
 */
function contextEventFilter(event: AppEvent): boolean {
  if (!isTopLevelEvent(event)) return false;
  return !isFrameworkCommandEvent(event);
}

/**
 * 压缩之后那条唤醒的**正文**（逐字进 `wake/manual.note`，2026-10-09）。
 *
 * 纯函数（入参 → 字符串，不读盘、不读时钟）：同一份判定在任何时刻渲染出同一串字节，
 * 重放与测试因此都能引用同一串字面量，不必各写一遍。
 *
 * 三件事按用户给的口径写，一件不许少：
 *   ① **告知刚压过**：说清"哪些内容不在眼前了"（遮蔽点）与"替代品在哪"（交接笔记）。
 *      替代品的位置是**具体的那一行**，不是一句概念：笔记在 `compaction/summary` 里，
 *      而渲染层把它摆在 input 的**最前面**那段长期记忆层（`renderMemoryLayer`：
 *      `[早期历史摘要 · 覆盖至 seq N]` + 笔记正文）——所以要她"抬头看第一段"。
 *   ② **接着做没做完的事**（用户的原话：「如有中断的工作则继续」）。这句必须是正文里的
 *      祈使句，不能只靠她自己想起来：压缩正好发生在"一轮刚收尾"的时刻，而那一刻她刚
 *      写完的东西已经不在现场了，最容易读成"这一轮结束了、可以歇了"。
 *   ③ **给一条能用的入口**：`safe_read` 读 `data/events/*.jsonl` 按 seq 回查（原始事件）。
 *      不能只给"去看交接笔记"这个概念——`/dream` 与 `job-wake` 两次都是"指了一条够不着的
 *      路"（前者按了没反应、后者让她去找一个不存在的 job 工具），这里按同一把尺子写：
 *      给的是她自己已有的能力（文件工具）+ 一个她真能读到的路径。
 *
 * 为什么两段都带上 `turn`：唤醒是"跳过一段时间"之后到达的，日志读起来（以及重放时）
 * 必须一眼看得出这条通报说的是哪一拍——只写"刚压过"会让事后复盘猜时刻。
 */
export function compactionWakeNote(args: {
  turn: number;
  covered: number;
  previous: number;
  dataDir: string;
}): string {
  const { turn, covered, previous, dataDir } = args;
  const from = previous <= 0 ? '（这是第一次交接）' : `（此前遮蔽到 seq ${previous}）`;
  // 反斜杠归一成正斜杠（`cli.ts` / `doctor.ts` / 记忆层那一族都是这么写的）：她读到的路径
  // 与工具回执、与她自己敲的相对路径同形；`C:\x\data/events` 这种混写只会让她多试一次。
  const eventsPath = `${dataDir.replace(/\\/gu, '/')}/events/*.jsonl`;
  // ⚠ 正文是给人/她读的**纯文本**（渲染层不认 Markdown）：强调用「」或换行，不用 `**`。
  return `【框架通报 · 上下文压缩】turn ${turn} 刚做过一次上下文压缩。
- 你眼前那段往来（遮蔽点前的历史）已经不在现场了，替代品是交接笔记：它就在你这次输入的最前面那段「早期历史摘要 · 覆盖至 seq ${covered}」里，标题是「# 交接笔记」。遮蔽点 seq ${covered}${from}。
- 要看更细的原始记录：用 safe_read 读 ${eventsPath}，按 seq 回查。
- 如果手上还有没做完的事（做到一半的任务、刚起的头、答应过还没交代的），接着做：压缩不会替你结束任何事，这一拍就是给你接着往下做的。`;
}

// ══════════════════════ 进程重启的判据与通报（2026-10-11 加） ══════════════════════

/**
 * 重启的**判据、留痕与通报**——「她说她没认出来进程在反复重启」这一条的落点。
 *
 * ───────────────────────────────── 用户原话 ─────────────────────────────────
 *
 * 「**她说她没认出来进程在反复重启**。**进程重启应当跟 compact 事件一样，有个通知让
 *   agent 知晓**」（2026-10-11）。
 *
 * 现场（同一天）：后端因为内存不足反复崩/重启（512 上限崩一次、2048 上限 167 秒崩一次、
 * 无上限涨到 3.8 GB），而她**完全没意识到**——她的上下文里没有任何"我刚被重启过"的痕迹，
 * 于是把断档读成"没人叫我"。对照面是压缩：`compaction/summary` 之后框架会**真唤醒**她一次
 * （`wake/manual{via:'compact'}`）。所以这条路做成**同一形状**：
 *
 * ```
 * ① 留痕（每次启动都写）  runtime/restart（internal，不进她的上下文、零缓存代价）
 * ② 通报（异常退出才写）  wake/manual{via:'restart'}（model，正文是真唤醒、真起 turn）
 * ```
 *
 * ───────────────────────────── 判据：什么算"异常退出" ─────────────────────────────
 *
 * **判据的优先级就是下面这个顺序**（前一条成立就不看后一条；写在这里、也只写在这里）：
 *
 *   ① `oom`     —— **输出日志里有内存不足的引擎原话**（`JavaScript heap out of memory` /
 *                  `Reached heap limit` / `Ineffective mark-compacts`）。这是**硬件级事实**，
 *                  优先级最高：一个正在 OOM 的进程就算同时留下了别的痕迹，它也是被内存搞死的。
 *   ② `error`   —— 上一任自己写了 `session/end{reason:'error'}`：**它自己报的**异常退出。
 *   ③ `killed`  —— 有 `session/start`、但**没有** `session/end`，而拉起器的留痕里出现了
 *                  "停主进程 / 已接管"：它是被**故意**换掉的（拉起器或人关的），只是没走完
 *                  优雅退出。这一档**不算异常**——人按下按钮时她本来就知道。
 *   ④ `unknown` —— 有 `session/start`、**没有** `session/end`、也没有任何可判的痕迹。
 *                  这一档**算异常**：进程没能写下自己的停机记录（被硬杀、被 OOM killer 带走、
 *                  断电……），而"她不知道"正是这次要治的那件事。**宁可多叫一次，也不许
 *                  再一次让她把断档读成"没人叫我"。**
 *
 * `abnormal = death === 'oom' || death === 'error' || death === 'unknown'`。
 * 第一任（日志里根本没有上一任的 `session/start`）**不算异常**：那是首次安装，没有"断档"可言。
 *
 * ───────────────────────────── 去重：同一次启动只喊一次 ─────────────────────────────
 *
 * 判据是**日志里有没有 `runtime/restart`**（`startupRestartEvent()`）：有 ⇒ 这一任的留痕
 * 已经写过、该叫的也叫过了 ⇒ **整段跳过**。于是它同时挡住两种重复：
 *   · 同一个进程里 `warmUp` 被跑第二次（`ready` 缓存失效、或将来有人再调一次）；
 *   · 进程在同一次启动里重放同一条路径。
 * 重启之后的**新进程**当然会再写一条（那是**另一任**，另一件事），这正是要的。
 *
 * ───────────────────────────── "谁拉起的"怎么判（不猜） ─────────────────────────────
 *
 * 四条可以核对的事实，按优先级：① 拉起器留痕（`data/restart-trace.log`）里的脚本名与
 * 它自己写下的命令行；② `process.argv` 里的拉起器路径（自重启那条路会把自己的参数原样带来）；
 * ③ 环境变量 `IRMIA_LAUNCHED_BY`（给外部看护进程用：显式声明比让框架猜可靠）；
 * ④ 都没有 ⇒ `unknown`——**如实说不知道**，不编一个来源。
 *
 * ───────────────────────────── 老日志（回溯友好） ─────────────────────────────
 *
 * 全部读取都是"读不到就给 null / unknown"：没有 `session/start`（老日志、第一任）、
 * 没有输出日志、留痕不存在——**任何一条缺失都不许抛**。这一条是硬要求：她是活的进程，
 * 启动路径上抛异常等于整个 agent 起不来（与 `machineFacts` 那条纪律同源）。
 */

/** 这次是谁拉起的（能判就给，判不出 `unknown`——**不许猜**） */
export type RestartLauncher = RuntimeRestart['data']['launchedBy'];

/** 外部看护进程显式声明"是我拉起的"的口子（声明比猜可靠；值就是本类型的取值之一） */
export const RESTART_LAUNCHED_BY_ENV = 'IRMIA_LAUNCHED_BY';

/** 输出日志只看**结尾**这么多字节：引擎的致命原话一定在最末尾（不必读整个文件） */
const RESTART_OUTPUT_TAIL_BYTES = 64 * 1024;
/** 一次最多扫几个候选输出日志（拉起器留痕里可能出现好几个路径） */
const RESTART_OUTPUT_SCAN_MAX = 6;
/** 拉起器留痕只看结尾这么多字节：一次重启的那几行就在结尾 */
const RESTART_TRACE_TAIL_BYTES = 64 * 1024;
/**
 * 「留痕里的那次重启就是把我拉起来的那次吗」的窗口（毫秒）。
 *
 * 判据是**留痕文件的 mtime 距离本进程启动多久**（拉起器写留痕与拉起新实例是同一秒的事，
 * 所以窗口只要盖得住启动耗时）。窗口外 ⇒ 那份留痕是**别的时刻**的，不能拿它说这次是谁拉起的。
 * 判不出时间（mtime 读不到）时按"可用"处理：读得到内容却读不到时间时，内容仍是最好的线索。
 */
const RESTART_TRACE_FRESH_MS = 10 * 60 * 1000;

/**
 * 内存不足的**引擎原话**（V8 打给 stderr 的那几行，逐字）。
 *
 * 为什么不用一个宽泛的 `/oom/i`：那会在"日志里正好聊到 OOM 这个词"时误判，
 * 而这条判据的后果是**给她发一条通报**（误报就是一次没来由的打扰）。
 * 这三个字面量都是引擎自己打的，人写不出这种句子。
 */
const OOM_MARKERS: readonly RegExp[] = [
  /JavaScript heap out of memory/u,
  /Reached heap limit/u,
  /Ineffective mark-compacts near heap limit/u,
];

/**
 * 拉起器留痕里"它是被**故意**换掉的"那几句话（逐字取自 `tools/restart-agent.ps1` 的
 * `Write-Trace` 与 `restart-worker.ts` 的 `--old-pid` 那条路）。
 *
 * 为什么认这些字而不是认"有没有 `[结束]`"：`[结束]` 在**失败**时也写（`ok=False`），
 * 而这里要回答的是"旧实例是不是被有意停掉的"——只有"停主进程"与"旧实例 pid="这两句说得清。
 * 它们是留痕的**既定写法**（服务端自己也按行解析同一份文件），不是我们为这条判据新造的格式。
 */
const KILL_TRACE_MARKERS: readonly RegExp[] = [
  /停主进程/u,
  /旧实例 pid=/u,
  /旧实例退出确认/u,
  /已接管/u,
];

/** 当前进程的 pid（唯一一处读它的地方：测试可以覆盖它来摆"上一任"的场景） */
function currentPid(): number {
  return process.pid;
}

/**
 * 从尾部读一段文本（**只读尾部**：输出日志可以是几 MB，整份读进来是白花的内存）。
 * 读不到（文件不在 / 权限不够 / 目录）一律给空串——调用方据此当"没有痕迹"，绝不抛。
 */
function readTailText(path: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(size - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* 关不掉就算了：这一次的读已经结束，别让它把启动拦下 */
      }
    }
  }
}

/**
 * 一个输出日志里有没有 OOM 的引擎原话。**返回那一行**（人读的证据），没有就是 null。
 */
function findOomEvidence(path: string): string | null {
  const tail = readTailText(path, RESTART_OUTPUT_TAIL_BYTES);
  if (tail === '') return null;
  for (const line of tail.split(/\r?\n/u)) {
    for (const marker of OOM_MARKERS) {
      if (marker.test(line)) {
        return `${path}：${line.trim().slice(0, 200)}`;
      }
    }
  }
  return null;
}

/**
 * 拉起器留痕里提到的**输出落点**（新实例的 stdout/stderr 去哪了）。
 *
 * 为什么从留痕里抠而不是写死一个路径：后端 stdout 的落点是**拉起方决定的**
 * （仓库脚本默认 `<安装根>\agent-console.out.log`、随包脚本默认
 * `<dataDir>/restart-backend.log`、自重启那条路用 `--out` 显式给）。写死一个就等于
 * 只在"某一种装法"上有效——而这条路要回答的恰恰是"**这一台**机器上它是怎么起的"。
 * 留痕里那句"完整命令行"把它逐字记着，`>> "<路径>" 2>&1` 就是它。
 */
function logPathsFromTrace(trace: string): string[] {
  const out: string[] = [];
  const quoted = /"([^"\r\n]*\.log)"/giu;
  for (const match of trace.matchAll(quoted)) {
    const path = (match[1] ?? '').trim();
    if (path !== '' && !out.includes(path)) out.push(path);
  }
  return out;
}

/** 上一任的输出日志候选（含"读不到就是没有"的兜底路径；顺序即优先级） */
export function previousOutputCandidates(input: {
  dataDir: string;
  traceText: string;
  env: Record<string, string | undefined>;
}): string[] {
  const out: string[] = [];
  const push = (path: string): void => {
    const trimmed = path.trim();
    if (trimmed === '' || out.includes(trimmed)) return;
    out.push(isAbsolute(trimmed) ? trimmed : join(input.dataDir, trimmed));
  };
  // ① 环境变量：外部看护进程知道后端输出去了哪儿时，显式给（比抠留痕可靠）
  push(input.env['IRMIA_OUT_LOG'] ?? '');
  // ② 拉起器留痕里逐字记着的那个落点（三种拉起方式的实际情况都在这儿）
  for (const path of logPathsFromTrace(input.traceText)) push(path);
  // ③ 随包脚本与自重启那条路的默认值（`packaging/restart.ps1` 的 `-OutLog` 缺省）
  push(join(input.dataDir, 'restart-backend.log'));
  return out;
}

/** 拉起器留痕里那句"完整命令行"（判"是谁拉起的"最硬的一条依据） */
function traceCommandLineOf(trace: string): string {
  const match = /完整命令行（([^\r\n]*)）/u.exec(trace);
  return (match?.[1] ?? '').trim();
}

/**
 * 这次是谁拉起的——**判据只此一处**（纯函数：入参给全，测试不必摆真进程）。
 *
 * 优先级写在 {@link RestartLauncher} 与上面那一段头注释里；这里逐条落实。
 * `traceUsable=false` 表示留痕里的那次重启**不是**把我拉起来的那次（mtime 太旧）⇒ 整条不看。
 */
export function classifyRestartLauncher(input: {
  argv: readonly string[];
  traceText: string;
  traceUsable: boolean;
  env: Record<string, string | undefined>;
}): { launchedBy: RestartLauncher; evidence: string } {
  const argvText = input.argv.join(' ');
  if (input.traceUsable) {
    const command = traceCommandLineOf(input.traceText);
    const haystack = `${command} ${input.traceText}`;
    if (command !== '' && /restart-agent\.ps1/u.test(haystack)) {
      return { launchedBy: 'root-script', evidence: `拉起器留痕：${command}` };
    }
    if (command !== '' && /restart\.ps1/u.test(haystack)) {
      return { launchedBy: 'packaged-script', evidence: `拉起器留痕：${command}` };
    }
    if (/restart-worker\.(js|mjs)/u.test(haystack)) {
      return { launchedBy: 'self-restart', evidence: `拉起器留痕：${command === '' ? '自重启' : command}` };
    }
    // 服务端发起的那条路先写一行 `[发起]`（`web/server.ts` 的 restartTraceLine('发起', …)）
    if (/\[发起\]/u.test(input.traceText)) {
      const line = /\[发起\][^\r\n]*/u.exec(input.traceText)?.[0] ?? '';
      return { launchedBy: 'ui', evidence: `拉起器留痕：${line.trim().slice(0, 200)}` };
    }
  }
  // `process.argv` 里带着拉起器自己的参数 = 自重启那条路（`restart-worker.ts` 转手的就是它）
  if (/restart-worker\.(js|mjs)/u.test(argvText) || argvText.includes('--old-pid')) {
    return { launchedBy: 'self-restart', evidence: `本进程命令行带着拉起器参数：${argvText.slice(0, 200)}` };
  }
  const declared = (input.env[RESTART_LAUNCHED_BY_ENV] ?? '').trim();
  if (declared !== '' && isRestartLauncher(declared)) {
    return { launchedBy: declared, evidence: `环境变量 ${RESTART_LAUNCHED_BY_ENV}=${declared}` };
  }
  return { launchedBy: 'unknown', evidence: input.traceUsable ? '' : '留痕里那次重启不是把我拉起来的那次（时间对不上）' };
}

/** 环境变量里那个值认不认（认不出就退回 unknown，不把它当自由文本塞进事件） */
function isRestartLauncher(value: string): value is RestartLauncher {
  return value === 'root-script' || value === 'packaged-script' || value === 'self-restart'
    || value === 'ui' || value === 'external';
}

/**
 * 判据的结论（{@link RuntimeRestartPrevious}）——**纯函数**：事件、OOM 证据、拉起器线索三样给全。
 *
 * 判据顺序与理由写在上面那段头注释里；这里只落实，不再解释一遍。
 * 参数全部可缺（老日志没有 `session/start`、输出日志读不到）：缺什么就当"没这条证据"。
 */
export function previousRunVerdict(input: {
  events: readonly AppEvent[];
  /** OOM 的引擎原话（`findOomEvidence` 的结论）；没有就是 null */
  oomEvidence: string | null;
  /** 拉起器留痕里"故意换人"的痕迹；没有就是 null */
  killEvidence: string | null;
  /** 上一任的 pid（调用方从 lock.json 读的）；读不到就是 null */
  previousPid: number | null;
}): RuntimeRestartPrevious {
  const sessions: Array<AppEvent & { type: 'session/start' }> = [];
  const ends: Array<AppEvent & { type: 'session/end' }> = [];
  for (const event of input.events) {
    if (event.type === 'session/start') sessions.push(event);
    else if (event.type === 'session/end') ends.push(event);
  }
  const previous = sessions.length >= 2 ? sessions[sessions.length - 2]! : undefined;
  // 上一任的停机记录只在它**之后**才算（当前这一任也写过 session/end 时不能拿它顶替）
  const end = previous === undefined
    ? undefined
    : ends.filter(candidate => candidate.seq > previous.seq).pop();
  const base = {
    pid: previous?.data.pid ?? input.previousPid,
    // `ts` 在**信封**上（`data` 里只有 pid/cwd/version/…）：起始时刻要读信封那一格
    startedAt: previous?.ts ?? null,
    version: previous?.data.version ?? null,
    endedAt: end?.ts ?? null,
    endedReason: end?.data.reason ?? null,
  };
  if (previous === undefined) {
    return { ...base, death: 'unknown', abnormal: false, evidence: '事件日志里没有上一任的 session/start（第一任，或老日志）' };
  }
  if (input.oomEvidence !== null) {
    return { ...base, death: 'oom', abnormal: true, evidence: input.oomEvidence };
  }
  if (end?.data.reason === 'error') {
    return { ...base, death: 'error', abnormal: true, evidence: `上一任自己的停机记录：session/end{reason:'error'}${end.data.detail === undefined ? '' : `（${end.data.detail}）`}` };
  }
  if (end !== undefined) {
    return { ...base, death: 'unknown', abnormal: false, evidence: `上一任写了停机记录：session/end{reason:'${end.data.reason}'}` };
  }
  if (input.killEvidence !== null) {
    return { ...base, death: 'killed', abnormal: false, evidence: input.killEvidence };
  }
  return {
    ...base, death: 'unknown', abnormal: true,
    evidence: '上一任没有留下 session/end（没能走完优雅退出），也没有 OOM 或拉起器的痕迹',
  };
}

/** 本进程的内存上限（V8 报的那个数）——"有没有带上限、上限多少"要能读到 */
export function heapCapOf(argv: readonly string[], heapLimitBytes: number): RuntimeRestart['data']['heapCap'] {
  const enabled = argv.some(arg => arg.startsWith('--max-old-space-size'));
  if (!enabled) return { enabled: false, limitMb: null };
  // V8 的 `heap_size_limit` 是**算出来的**（含命令行那一位），所以它能答"上限是多少"；
  // 而"带没带这个参数"只有 argv 答得出——两个来源各答一半，都不猜。
  const mb = Math.round((heapLimitBytes / (1024 * 1024)) * 100) / 100;
  return { enabled: true, limitMb: Number.isFinite(mb) && mb > 0 ? mb : null };
}

/** 上一任是怎么没的——**一句人话**（通报正文与留痕共用这一份，不各写一遍） */
export function deathReasonText(previous: RuntimeRestartPrevious): string {
  switch (previous.death) {
    case 'oom':
      return '进程崩了，是内存不足（Node 报 "JavaScript heap out of memory"）';
    case 'error':
      return '进程自己报了异常退出（session/end 里写的是 error）';
    case 'killed':
      return '进程被故意换掉的（拉起器/人关的），只是没来得及走完优雅退出';
    case 'unknown':
      return previous.pid === null
        ? '日志里没有上一任的痕迹（这是第一次启动，或者老日志里没有这一条）'
        : '进程没能留下停机记录（被硬杀 / 断电 / 没走完优雅退出），所以说不清具体原因';
  }
}

/**
 * 这一份日志里**本任**的 `runtime/restart` 留痕（没有就是 null）——同一次启动只喊一次的判据。
 *
 * 为什么"有它"就等于"喊过了"：留痕与那条真唤醒是**同一个同步块**里写的（`announceRestart`），
 * 而留痕在前。所以"留痕在、通报不在"只可能是"这一任本来就不该喊"（正常重启），
 * 不可能是"喊漏了"——判据因此既简单又不会把该喊的那次吞掉。
 */
export function startupRestartEvent(events: readonly AppEvent[]): (AppEvent & { type: 'runtime/restart' }) | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === 'runtime/restart') {
      return event as AppEvent & { type: 'runtime/restart' };
    }
  }
  return null;
}

/** 文件的修改时刻（毫秒）；读不到就是 null（**调用方据此当"判不出时间"**，绝不抛） */
function mtimeMsOf(path: string): number | null {
  try {
    const ms = statSync(path).mtimeMs;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/**
 * 重启通报的**正文**（逐字进 `wake/manual.note`，2026-10-11）。
 *
 * 纯函数（入参 → 字符串，不读盘、不读时钟）：同一份判定在任何时刻渲染出同一串字节，
 * 重放与测试因此都能引用同一串字面量（与 `compactionWakeNote` 同一条纪律）。
 *
 * 四件事按用户给的口径写，一件不许少：
 *   ① **告知刚被重启过**（段头就点明，她一眼看得出这不是用户说的话）；
 *   ② **说清上一任怎么没的**（`deathReasonText`）——不知道就如实说不知道，
 *      绝不写"一切正常"这种替实现圆场的话；
 *   ③ **说清现在跑的是哪一版**（她问"我在哪一版上"时这是唯一凭据）；
 *   ④ **两件要她接着做的事**：断档的活接着做；**记忆不受影响**（这一句是用户点名要的：
 *      重启会让上下文里的"刚发生的事"断掉，但数据/记忆/她自己的结论都在盘上、一个字没少）。
 */
export function restartWakeNote(args: {
  pid: number;
  version: string;
  previous: RuntimeRestartPrevious;
  /** 重启那一刻的 ISO 时刻（正文里给一个人读得懂的时刻，省得她再去翻事件） */
  at: string;
}): string {
  const { pid, version, previous, at } = args;
  // ⚠ 正文是给人/她读的**纯文本**（渲染层不认 Markdown）：强调用「」或换行，不用 `**`。
  const lines = [
    '【框架通报 · 进程重启】我刚被重启过（这是一条框架通报，不是用户说的话）。',
    `- 上一任：${deathReasonText(previous)}`
      + `${previous.pid === null ? '' : `（上一任 pid ${previous.pid}`}`
      + `${previous.pid === null || previous.startedAt === null ? '' : `，起于 ${previous.startedAt}`}`
      + `${previous.pid === null ? '' : '）'}。`,
    `- 现在这一任：pid ${pid}，跑的是 ${version}，重启时刻 ${at}。`,
    '- 如果刚才有没做完的活（做到一半的任务、刚起的头、答应过还没交代的），接着做：'
      + '重启只打断了进程，不会替你结束任何事。',
    '- 重启不影响你的记忆与记忆里的结论：盘上的记忆、STATE、日志都还在，一个字都没少。'
      + '你只是"中间断了一小段"，而不是"忘了什么"。',
  ];
  return lines.join('\n');
}

/**
 * **只有真环境才知道、也只该在真启动时读一次**的那几格（{@link restartFacts} 的入参之一）。
 *
 * 为什么拆成两步：`restartFacts` 要是**纯函数**（测试才能不碰盘、不读真进程地摆每一种判据），
 * 而"上一任的输出日志在哪、里面有没有 OOM、拉起器留痕说了什么"必须真去读盘。
 * 读盘那一半全在这里，且**任何失败都退化成"没有这条证据"**——启动路径上不许抛。
 */
export function restartProbeOf(
  dataDir: string,
  now: Date,
): { oomEvidence: string | null; killEvidence: string | null; traceText: string; traceUsable: boolean } {
  const tracePath = join(dataDir, 'restart-trace.log');
  const traceMtimeMs = mtimeMsOf(tracePath);
  const traceText = readTailText(tracePath, RESTART_TRACE_TAIL_BYTES);
  // 留痕在、但它的 mtime 明显早于本次启动 ⇒ 那是**别的时刻**的重启记录，不能用它说这次
  const traceUsable = traceText !== ''
    && (traceMtimeMs === null || now.getTime() - traceMtimeMs <= RESTART_TRACE_FRESH_MS);
  let oomEvidence: string | null = null;
  for (const path of previousOutputCandidates({ dataDir, traceText, env: process.env })
    .slice(0, RESTART_OUTPUT_SCAN_MAX)) {
    oomEvidence = findOomEvidence(path);
    if (oomEvidence !== null) break;
  }
  const killMarker = traceUsable
    ? (KILL_TRACE_MARKERS.map(marker => marker.exec(traceText)?.[0]).find(hit => hit !== undefined) ?? null)
    : null;
  return {
    traceText,
    traceUsable,
    oomEvidence,
    killEvidence: killMarker === null
      ? null
      : `拉起器留痕里出现了「${killMarker}」：旧实例是被**故意**停掉的`,
  };
}

/**
 * **这一次启动的全部事实**（判据的输入与结论，纯函数）——`announceRestart` 只负责落库。
 *
 * 拆出来是为了让四条纪律各自可测：① 异常退出 ⇒ 有通报、正文含"重启"与原因；
 * ② 正常重启 ⇒ 不喊；③ 同一次启动只喊一次（那是 `startupRestartEvent` 的去重）；
 * ④ 老日志里没有这条事件 ⇒ 不许炸（缺什么都当"没有这条证据"）。
 *
 * 判据本身写在文件上半段那段头注释里（**唯一一处**），这里只落实。
 */
export function restartFacts(input: {
  events: readonly AppEvent[];
  argv: readonly string[];
  env: Record<string, string | undefined>;
  now: Date;
  /** 本进程 pid（测试可给一个假数） */
  pid: number;
  /** 本进程版本号（`main.ts` 的 AGENT_VERSION；测试给什么都行） */
  version: string;
  /** `restartProbeOf` 读出来的那几格；测试直接给字面量 */
  oomEvidence: string | null;
  killEvidence: string | null;
  traceText: string;
  traceUsable: boolean;
  /**
   * 上一任的 pid **提示**（`lock.json` 里那个数）：事件日志里查不到上一任时用它。
   * 判据不依赖它（它只是"补一格 pid"），所以缺省 null 不影响任何结论。
   */
  previousPidHint?: number | null;
  /** V8 报的老生代上限（字节）；缺省按本进程现读（测试可给一个数） */
  heapLimitBytes?: number;
}): {
  pid: number;
  version: string;
  previous: RuntimeRestartPrevious;
  launchedBy: RestartLauncher;
  launchedEvidence: string;
  argv: string;
  heapCap: RuntimeRestart['data']['heapCap'];
  /** 要发给她的通报正文；null = **这一任不喊**（正常重启，只留痕） */
  note: string | null;
} {
  const previous = previousRunVerdict({
    events: input.events,
    oomEvidence: input.oomEvidence,
    killEvidence: input.killEvidence,
    previousPid: input.previousPidHint ?? null,
  });
  const launcher = classifyRestartLauncher({
    argv: input.argv,
    traceText: input.traceText,
    traceUsable: input.traceUsable,
    env: input.env,
  });
  return {
    pid: input.pid,
    version: input.version,
    previous,
    launchedBy: launcher.launchedBy,
    launchedEvidence: launcher.evidence,
    argv: input.argv.join(' '),
    heapCap: heapCapOf(input.argv, input.heapLimitBytes ?? getHeapStatistics().heap_size_limit),
    note: previous.abnormal
      ? restartWakeNote({ pid: input.pid, version: input.version, previous, at: input.now.toISOString() })
      : null,
  };
}

/** 文件根本不存在（而不是读到了空文件）——"没有痕迹"与"痕迹是空的"是两件事 */
function fileMissing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch {
    return true;
  }
}

/**
 * 附件预热一次最多回看多少条事件。
 *
 * 它是"重启后补扫"的上限，不是常规路径：平时带游标只看新来的那几条。取 200 是因为
 * 一张图从到达、渲染到真正被认领通常只隔几十条事件；再往前翻既没必要，也白读盘。
 */
const ATTACHMENT_SCAN_WINDOW = 200;

/**
 * 预取的**并发上限**（2026-10-21）：同时在飞的下载/压缩最多两条。
 *
 * 为什么不是全并发：图片成批到达时全量并发会同时开 N 条下载 + N 个 PowerShell 进程，
 * 而这一拍只有 5 秒预算（{@link STEP_PREWARM_TIMEOUT_MS}）——并发 2 是"两条直链同时取"
 * 与"别把她这拍的等待全占满"之间的取中，也是"一次预取最多几张"那个数的自然上界
 * （见 {@link RealLoop.prewarmRecentAttachments} 的 limit）。
 */
const PREWARM_CONCURRENCY = 2;

/** 等待预取的队列上限（URL 条数）：满了丢最老的并留一条 `image/trace`——**别静默丢** */
const PREWARM_BACKLOG_MAX = 32;

/**
 * 一拍/一步的预取预算：比循环层的硬顶少 1 秒（{@link STEP_PREWARM_TIMEOUT_MS}）。
 *
 * 为什么留 1 秒：循环层那个 5 秒是**兜底**（"宿主实现挂住了也不许拖住这一拍"），
 * 而这里的预算要让下载/压缩在兜底之前**自己收住**——差那 1 秒是给进程收尾与落盘留的余量。
 * 两个数不是两套口径：一个从另一个算出来。
 */
const PREWARM_BUDGET_MS = STEP_PREWARM_TIMEOUT_MS - 1_000;

/**
 * 短标签（留痕与 stdout 里那一行用的）：临时直链动辄三四百字符，原样打出来会把一行撑爆。
 * **事件里的 `ref` 存全文**（事后要能核对是哪一条消息），只有给人读的这半句截断。
 */
function shortRefLabel(ref: string): string {
  return ref.length > 72 ? `${ref.slice(0, 72)}…` : ref;
}

/**
 * 有没有本地字节（原件或压缩产物）。
 *
 * 预取**只补没有的那几张**：同一张图在历史里可能出现好几次（表情包重发），
 * 每次都排进队列会白占"最近 N 张"的名额，把真正新到的那张挤掉。
 */
function hasLocalAttachmentBytes(dataDir: string, url: string): boolean {
  try {
    const original = attachmentPath(dataDir, url);
    if (existsSync(original) && statSync(original).size > 0) return true;
    const small = compressedPath(dataDir, url);
    return existsSync(small) && statSync(small).size > 0;
  } catch {
    return false;
  }
}

/**
 * 跑一批异步任务，**同时在飞的绝不超过 `limit` 个**（{@link PREWARM_CONCURRENCY}）。
 *
 * 为什么不是 `Promise.all`：全量并发会在图片成批到达时同时开 N 条下载 + N 个 PowerShell，
 * 而这一拍只有 5 秒预算——并发 2 是"两条直链同时取"与"别把她这拍的等待全占满"之间的取中。
 */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await run(items[index]!);
    }
  });
  await Promise.all(workers);
}

/**
 * 「最近 5 次用户输入」往回最多看多少条事件（阶段一，2026-10-15）。
 *
 * 为什么要有上界：这一步**每 turn 做一次**，而活动分片实测有 12 MB 量级 —— 无上界地往回翻
 * 就等于每轮把日志读一遍。取 2000 的依据是"5 次输入之间的间隔"：她与用户的往来里，
 * 两次开口之间通常隔着几十到几百条事件（工具调用与结果占大头），2000 条足以覆盖到第 5 次；
 * 真不够时**少于是多少条就多少条**（聚合那侧本来就允许不足 5 条），绝不为此把整份日志翻掉。
 */
const RECENT_USER_INPUT_SCAN = 2000;

/**
 * **可见历史**的读取上限（字符；阶段二 ③，2026-10-19）。
 *
 * 这一步只在 `persona.recallEnabled === true` 时跑（一轮一次），用来回答"这个字是不是
 * 刚在上下文里出现过"。取 60000 字的依据：她的压缩线是 200k token，而中文 1 token
 * ≈ 1.5 字 ⇒ 整段可见历史约 30 万字；真实轮次里（含工具结果）能到几十万字，
 * 但这一格只需要"最近聊过什么"，6 万字已经覆盖了几十轮对话。
 * 未覆盖到的那段会**偏向"没在上下文里"⇒ 更容易触发**，方向是安全的（宁可多回忆），
 * 而且报告里有 20k / 60k 两档的敏感性读数。
 */
const VISIBLE_HISTORY_CHARS = 60000;
/**
 * `read_channel` 一次读（一屏 / 一页）最多把几张"点名她"的图片带进上下文（2026-10-11 用户拍板）。
 *
 * 定在 **2**，三条理由：
 *   · 与 `vision.maxContextImages` 的出厂值同一个数（2）——那个数是"同时待在上下文里的图片张数"，
 *     读会话这条路不该比唤醒那条路更大方；
 *   · **图片每轮都要重发一遍**（base64 之后一张动辄几十上百 KB，见 attachment-store 的
 *     `CONTEXT_IMAGE_COMPRESS_ABOVE_BYTES` 那段），多带一张的代价是**每一拍**都付；
 *   · 2 张盖得住"一条消息配一两张图"这个常见形态；要更多时她有自己的路：`vision_read`
 *     （点名要看哪张），何况每张图的地址都留在那一行上。
 *
 * 它只是**这一条路**的上限：真正决定请求体里有几张的是 `vision.maxContextImages`
 * （渲染层那个"从后往前数 N 张"的窗口），所以实际名额取两者的**小**者——见 `contextImageBudget`。
 */
const READ_CHANNEL_CONTEXT_IMAGE_MAX = 2;

/** 每积累这么多事件写一次折叠快照（M5-9 与 design §4.12 的体量盘算：日均 5000 事件即一天一快照） */
export const SNAPSHOT_EVERY_EVENTS = 5000;

// ── 注入判定与话题概括的分寸（v32）──
//
// 两个数字都是"钱与体感"的折中，写在这里而不是散在调用点上：
//   • **一次判定最多等 6 秒**：判定是锦上添花，不能成为她开口的前置条件。攒批窗口本来就
//     让群消息延迟了几分钟，再多等几秒她能忍；而这个上限保证最坏情况不至于把 turn 拖住。
//   • **一批最多判 3 条**：一批里塞十条外部消息时，逐条问模型的代价是几十秒。
//     多出来的那些这一轮不判——它们照样出现在上下文里，字面扫描那一层也照样在渲染时生效
//     （见 model/render.ts 的 renderExternalEvent），只是少了语义那半。
const INJECTION_JUDGE_TIMEOUT_MS = 6_000;
const INJECTION_JUDGE_MAX_PER_BATCH = 3;
/** 去重集合的上界（超出整份丢掉重建：代价是极少数消息被重判一次，而无限增长是内存） */
const INJECTION_JUDGE_SEEN_MAX = 500;

/** 话题概括的门槛：未读够多、且距上次概括够久，才值得花一次 light（见 summarizeChattySessions） */
const TOPIC_MIN_UNREAD = 5;
const TOPIC_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** 一次概括最多喂多少条消息（只概括最近这一段，老消息会把概括糊掉） */
const TOPIC_MAX_MESSAGES = 30;

/** 定时器 payload 是否标识"每日记忆整理"（real-loop 布防/识别与测试共用同一判定） */
/** 读定时器 payload 里的字符串标记（`by: "human"` 这类）；形状不对就给 false */
function readPayloadFlag(payload: unknown, key: string, value: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)[key] === value;
}
export function isMemoryMaintainPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  return (payload as Record<string, unknown>)['kind'] === MEMORY_MAINTAIN_PAYLOAD_KIND;
}

/**
 * 框架代管记忆开着吗？（`config.persona.memoryEnabled`，见 docs/persona.md §3.1）
 *
 * 三处判据**共用这一个函数**（索引注入、每日整理布防、整理 turn 的认领）：它们都在本模块里，
 * 各写一个 `!== false` 迟早会漂成"索引不注入了、但整理照跑"那种半开状态。
 * 重放与界面预览那两条**重建**路径读的是同一个配置字段（`buildReplayReport` / `buildRequestPreview`），
 * 不引这个函数是因为它们手里没有 RealLoop——口径同源，判据同字段，不是第二份实现。
 *
 * 只收 `false` 才算关：缺字段、坏值（配置解析层已拦）一律当**开**——与那个字段的出厂默认一致，
 * 也让所有老调用点（不带这个 deps、老测试）行为不变。
 */
export function memoryHostingEnabled(config: AppConfig): boolean {
  return config.persona.memoryEnabled !== false;
}

/**
 * **阶段二：按"私有词典命中"决定要不要注入、注入哪几条**（`persona.recallEnabled` 关着时不走这里）。
 *
 * 两段式（同一份实现，见 `persona/recall.ts`）：
 *   ① `gateRecall`：话里有没有**这个安装自己的词**、且那个词不在最近几次输入里；
 *   ② `planRecallInjection`：命中才走 BM25 + 近因挑 top-N，带预算硬顶与确定性截断。
 *
 * **三种没注入的情形都要能区分**（四态，进 `memory/selected.recall`）：
 * 未触发（含冷启动 `dictionary-empty`）/ 触发但无候选 / 命中但被预算截断。
 *
 * 预算硬顶的**取值口径**：`maxItems` = 推荐段那条老口径的 6 条；`maxTokens` = **今天这一轮
 * 本来要注入的那段有多少 token**（同一个 `selectMemoryRecommendation` + 同一个渲染器算出来的）。
 * ⇒ "按需注入一次，永远不比今天每轮都注入更贵"。新装（没有条目）时它 = 0 ⇒ 什么都不注入。
 */
export function recallRecommendation(
  entries: readonly MemoryIndexEntry[],
  inputs: readonly MemoryQueryInput[],
  dataDir: string,
  /** **整段可见历史**（③ 的判据）：宿主一轮取一次递进来；缺省 = 退化成"最近几次输入" */
  visibleText = '',
): MemoryRecommendation {
  const query = buildMemoryQuery(inputs);
  /**
   * **一份词典、两个视图**（第三轮）+ **反向索引**（第四轮）：
   *   · 指针层用**全词典**（凡被命名过就摆进目录）；
   *   · 正文层用**强证据子集**（`buildBodyMatcher`：证据加权 ≥10）；
   *   · 指针选条目时先查**名字 → 条目号**的反向索引（`refs`，构建期扫索引行整行正文得到），
   *     查不到才退回"摘要里出现了这个词"——这一步把 b′ 从 67% 抬到 81%（中档）。
   */
  const dict = loadRecallDictionaryFile(recallDictionaryPath(dataDir));
  const bodyMatcher = buildBodyMatcher(dict.candidates);
  const refsByWord = new Map<string, readonly string[]>();
  for (const cand of dict.candidates) if (cand.refs !== undefined && cand.refs.length > 0) refsByWord.set(cand.word, cand.refs);
  const refsOf = (word: string): readonly string[] => refsByWord.get(word) ?? [];
  const recentText = visibleText === '' ? inputs.map((input) => input.text).join('\n') : visibleText;
  // 指针用**原始命中词**（不过上下文滤网）：目录不该因为"刚说过"就不显示
  const rawHits = [...new Set(matchRecall(query.text, dict.matcher).map((h) => h.word))];
  const gate = gateRecall(query.text, bodyMatcher, recentText);
  // 预算：拿"今天这一轮会注入的那一段"当上限（相对量，不新增魔数）
  const baseline = selectMemoryRecommendation(entries, inputs);
  const maxTokens = estimateTokens(renderMemoryRecommendation(baseline));
  // **两级注入**（第三轮）：① 指针层永远在（30–40 token 量级）；② 正文层只在证据门命中时展开。
  const plan = planRecallTurn({
    query: query.text,
    gate,
    entries,
    rawHits,
    refsOf,
    bodyBudget: {
      maxItems: MEMORY_RECOMMEND_TOP_N,
      maxTokens,
      // 相关度下限：本安装词表 idf 分布的 p25（★ 相对量，让"触发但无候选"真的有意义）
      minIdfQuantile: RECALL_MIN_IDF_QUANTILE,
    },
  });
  const injection = plan.body;
  const items: MemoryRecommendationItem[] = injection.items.map((item) => ({
    index: item.index,
    ref: item.ref,
    path: item.path,
    line: item.line,
    summary: item.summary,
    pinned: item.pinned,
    score: item.score,
    via: item.pinned ? 'pinned' : 'bm25',
    matched: item.matched,
  }));
  const pinnedCount = items.filter((item) => item.pinned).length;
  // 固定块里那一段 = 指针行（永远）+ 正文块（命中时才有）。空串 = 这一轮什么都没注入。
  const pointerText = renderRecallPointer(plan.pointer.items);
  const bodyText = injection.items.length === 0 ? '' : renderRecallSegment(gate.hits, injection.items);
  const segment = [pointerText, bodyText].filter((part) => part !== '').join('\n');
  return {
    items,
    counts: { pinned: pinnedCount, bm25: items.length - pinnedCount },
    total: entries.length,
    query,
    segment,
    recall: plan.trace,
  };
}

/**
 * 本轮的记忆索引素材（v32）：**建/读一次**，注入文本与注入账共用这一份。
 *
 * 为什么把它抽成函数（而不是留在 `agentDeps` 里内联）：这是"关掉框架代管记忆"那条路上
 * **唯一会碰盘**的一步。抽出来之后，它可以在真实数据目录上被直接断言——"关掉时不建索引、
 * 不读记忆、注入文本为空"这三件事是**可实测**的，而不是"读代码看起来对"。
 *
 * 关掉时给一份**空索引**（`emptyMemoryIndex`）而不是 null：
 *   • `ensureMemoryIndexSafely()` 会**就地重建** `INDEX.md`——关掉之后框架一个字节都不该再动它；
 *   • `buildMemoryIndex()` 会扫 `facts.md` / `episodes/`——连"扫一眼"都不该发生；
 *   • 注入与账目（`memory/selected` 的指纹与条数）必须以**同一份索引**为准：给一份空索引，
 *     两处自然都是空的，不需要在两侧各加一个 if（那样才有"账上说注入了、请求里却没有"的空间）。
 */
export function memoryIndexPlan(
  config: AppConfig,
  dataDir: string,
  /**
   * 建索引那一步（调用方注入：生产是 `ensureMemoryIndexSafely`，它顺手保证盘上 `INDEX.md`
   * 与记忆文件一致）。`{ full: true }` = **不做预算丢弃**那一档（阶段一要用全量算编号与候选）。
   */
  build: (dir: string, options?: { full?: boolean }) => MemoryIndex,
  /**
   * 推荐段（阶段一，2026-10-15）：查询 = 最近 5 次用户输入的聚合，挑 top-6（pinned 必留）。
   *
   * 入参是**两份条目**（都是同一份全量扫描的产物，见下面 `build(dataDir, { full: true })`）：
   *   · `entries`：全量（编号与候选集都按它算）；
   *   · `kept`：默认档那份（被 900 token 预算截断的，只有 `INDEX.md` 的老读者还用得上）。
   * **缺省 = 不挑**（`text` 为空串）⇒ 注入的那一段整体不出现：老调用点（子代理、诊断、
   * 只读重建）因此逐字节不变，不必各自去造一份"最近 5 次输入"。
   */
  recommend?: (input: {
    entries: readonly MemoryIndexEntry[];
    kept: readonly MemoryIndexEntry[];
  }) => MemoryRecommendation | null,
  /**
   * **索引之外还有什么**（兜底行用，2026-10-15 用户裁决②）：宿主一轮数一次递进来
   * （`memoryIndexNeighbors`，只 `readdirSync` 数份数，不读内容）。
   *
   * **渲染层不读盘**（缓存铁律 1）⇒ "目录里有几份 episodes"这件事只能在宿主数一次、经这里转手。
   * 缺省 = 不接线（子代理、诊断、只读重建、老用例）⇒ 兜底行退回旧文案，
   * 那些调用点的请求字节因此与接线之前**逐字相同**。
   */
  neighbors?: MemoryIndexNeighbors,
): { index: MemoryIndex; text: string; recommendation: MemoryRecommendation | null } {
  if (!memoryHostingEnabled(config)) {
    return { index: emptyMemoryIndex(), text: '', recommendation: null };
  }
  // **一次扫描，两份条目**（`full: true` 跳过预算丢弃那一步，所以不必扫两遍盘）：
  // 预算那份给"老读者"（盘上 INDEX.md 的形态、`memory/selected.entries` 的规模口径），
  // 全量那份给编号与推荐候选集。两份顺序逐字节同源（同一个 `collectIndexEntries`）。
  const built = build(dataDir, { full: true });
  const entries = built.entries;
  const budgeted = applyIndexBudget(entries);
  const recommendation = recommend?.({ entries, kept: budgeted.entries }) ?? null;
  // 兜底行要的那一格**挂上去**（不改挑法、不改条数）：`neighbors` 缺省时整格不出现，
  // 于是 `renderMemoryRecommendation` 走旧文案那一支（见 `recommendationTail`）。
  const withTail: MemoryRecommendation | null = recommendation === null
    ? null
    : (neighbors === undefined ? recommendation : { ...recommendation, neighbors });
  if (withTail === null) {
    // 没有推荐（老调用点）：退回旧口径那一份，`text` 为空 ⇒ 注入段整体不出现。
    // ⚠ 这里**不是**"旧文本还在"：调用点不传 `recommend` 时本来就不该有那段（子代理/诊断）。
    return { index: budgeted, text: '', recommendation: null };
  }
  // ⚠ v30 的"轮内不许重建"在这里也适用：`build(dataDir, …)` 一轮只调一次，推荐是纯函数那一步。
  // 阶段二（2026-10-19）：召回那条路自带**另一段措辞**（`segment`），见 `persona/recall.ts`。
  const text = withTail.segment ?? renderMemoryRecommendation(withTail);
  return { index: budgeted, text, recommendation: withTail };
}

/** 打断 speak 的唤醒类型：**人**开口的那三种。定时器、意图、后台任务、心跳都不算 */
const USER_SPOKE_TYPES: readonly string[] = ['wake/manual', 'wake/channel', 'wake/webhook'];

/**
 * 这条唤醒是不是"有人说话了"？是则给出可写进回执的一句话，否则 null。
 *
 * 本机对话流（`wake/manual`）与消息适配器（`wake/channel`）都算——用户的口径是
 * 「从消息适配器发消息也可打断」。看门目录的文件变化、意图到期、后台任务完成都不算：
 * 那些不是有人在跟她说话，没什么可"重新组织语言"的。
 */
export function userSpokeTextOf(emission: WakeEmission): string | null {
  return userSpokeEventTextOf(emission.type, emission.data);
}

/**
 * 唤醒载荷的 `msgSeq` 兜底：**平台没给（0/缺失）就用事件 seq**（2026-10-07）。
 *
 * 判据与信箱那条**同一个函数**（`channel/inbox.ts` 的 `msgSeqOf`）：平台给了真序号就用它
 * ——那是它自己的编号、量纲不同，**不许覆盖**；没给才退回事件 seq（单调、重放稳定）。
 *
 * 为什么必须有这一条：「这一条你还没看过」的判据是
 * `wakeEvent.data.msgSeq > entry.readUpToSeq`（`agent-loop.ts` 的 `contactWithWakeStamp`），
 * 而 OneBot 的群 @ 与官方全量群消息都落 0 —— `0 > 0` 恒假，于是那一轮的通知里**永远**不出现
 * 「（这一条你还没看过）」，她会读成"又是上一次那条"而不回（报告 §3.4）。
 * 那段代码存在的唯一理由就是修这个毛病（用户 2026-10-02：「她老是觉得自己已经回过了就不回」）。
 *
 * 纯函数、不改入参：带 `msgSeq` 的载荷返回**浅拷贝**，其余原样返回（逐字节不变）。
 * 只认数字型 `msgSeq`——它不是数字就说明这不是一份通道载荷，不碰。
 */
export function withMsgSeqFallback(data: unknown, eventSeq: number): unknown {
  if (data === null || typeof data !== 'object') return data;
  const seq = (data as { msgSeq?: unknown }).msgSeq;
  if (typeof seq !== 'number' || seq > 0) return data;
  // 判据**不在这里重写**：`msgSeqOf` 是那条规则的唯一实现（信箱那条路也走它）
  return { ...(data as Record<string, unknown>), msgSeq: msgSeqOf({ msgSeq: seq }, eventSeq) };
}

/**
 * 这条事件算不算"群里有人在叫她"——**群成员登记的唯一判据**（运行期与重启回填共用这一处）。
 *
 * 判据三条，都是事件里写着的事实：
 *   ① 事件是 `wake/channel`——**"叫她"的那条路**。只认它是有意的：`channel/message` 是信箱那条路
 *      （"手边那个软件在响"），进信箱的东西不该顺手把人登记进档案，否则"谁跟她打过交道"这个
 *      判断会被满群闲话稀释；
 *   ② 出现在群聊里（`group` / `group-at`；`group-at` 本身就是 @ 了她）；
 *   ③ `mentionsMe === true`（平台 @ 了她，或正文里喊了她的名字——适配器算好、如实填的那个标志）。
 *
 * 为什么要抽成一个函数：登记有**两条入口**——运行期每拍那趟 `foldChannelEvents`，与重启时
 * 对已落盘事件的回填（见 `backfillGroupMembers`）。两处各写一遍判据，迟早会漂成
 * "回填进来的人"与"运行期进来的人"不是同一批，而那种偏差从行为上看不出来。
 */
type GroupCallingEvent = AppEvent & {
  type: 'wake/channel';
  data: { person: string; nickname?: string; mentionsMe?: boolean };
};

/**
 * 这条通道消息**是不是在点她**——群成员登记、`read_channel` 的默认那一屏共用这一处。
 *
 * 两个判据都是事件里写着的事实，**顺序无所谓，且都不看通道名**（两条通道同一份）：
 * `chatType === 'group-at'`（平台给的那条消息形态就是"@ 了我"）或 `mentionsMe === true`
 * （适配器如实填的，或宿主按关键词判成的——见 `channel/inbox.ts` 的唤醒判据）。
 *
 * 为什么收成一处（2026-10-08）：`read_channel` 的默认口径是"**只给点了她的那些**"，
 * 而"点了她"这件事在仓库里原先只有一个消费者（`groupMemberCandidateOf`）。
 * 两处各写一遍 `group-at || mentionsMe`，迟早一边改了另一边没改——那时的症状是
 * "档案里登记了这个人、可她读群时看不到那句 @ 她的话"（或反过来），
 * 而这两种偏差从行为上都看不出来。
 *
 * ⚠️ 它**不是**唤醒判据：唤醒还多一条关键词/私聊的分支（`shouldWakeForChannelMessage`）。
 * 这里回答的只是"这条消息指不指向她"，调用方各自接自己那半。
 */
export function mentionedInMessage(data: { chatType?: string; mentionsMe?: boolean }): boolean {
  return data.chatType === 'group-at' || data.mentionsMe === true;
}

/**
 * 这一条消息的图**是不是冲她来的**——`read_channel` 的"点名例外"（2026-10-11 用户拍板）唯一
 * 使用的那条判据（**只此一处**）。是 ⇒ 图按现有准入装配进上下文；不是 ⇒ 一个字都不装配，
 * 那一行只给地址，由她自己决定值不值得看。
 *
 * 两个分支都不是新写的：
 *   · 群聊 ⇒ `mentionedInMessage`（平台 @ 了她，或平台/宿主如实填的"提到了你"）——与
 *     `read_channel` 摆出来的那个 `▶` 是**同一个结论**；关键词那一路也不必在这里重判：
 *     main 落库时就把命中的群消息写成了 `mentionsMe: true`（`main.ts` 的 `onChannelMessage`），
 *     所以它读得到；
 *   · 私聊 ⇒ **无条件**——与唤醒判据 `shouldWakeForChannelMessage` 的第一条**逐字同源**
 *     （"私聊：对方就是在跟她说话"，见 `channel/inbox.ts`）。这一条必须单独写出来：
 *     `mentionedInMessage` 对私聊恒假（私聊里没有"提及"这回事），而用户点名的三种情形里
 *     就有它。
 *
 * ⚠️ 它**不是**新的 @/回复判定，也不改 `mentionedInMessage` 本身：那个函数还管着
 * `read_channel` 那一屏摆哪几条（把私聊也算成"提及"会让每个私聊行都多一个 `▶`），
 * 两件事判据不同，各自接自己那一半（与 `mentionedInMessage` 的注释同一个口径）。
 */
export function imageAimedAtHer(data: { chatType?: string; mentionsMe?: boolean }): boolean {
  return data.chatType === 'c2c' || mentionedInMessage(data);
}

/**
 * 折三格"清单要不要列这个会话"的素材（v66 两格，v67 加第三格）：`spokeAt`（她最后在这个会话里
 * 说话的时刻）、`mentionedAt`（最近一次有人 @/提及她）、`spokeTimes`（她在这个会话里说过话的
 * **全部时刻** —— 频次的素材）。
 *
 * **纯函数、导出**（不是 `RealLoop` 的方法）：重放/界面预览那条路（`replay.ts` 的
 * `contactFactsForReplay`）必须用**同一个函数**折同一批事件——两处各写一遍的代价是
 * "预览里的会话清单"与"当时真发出去的那一份"不是同一份（实测踩到：预览会把一个刚 @ 过她、
 * 但她还没回过的群从清单里滤掉，而当时那一份列着它）。渲染层是纯函数、算不出这三格
 * （素材在事件里），所以判据只能收在这里一处。
 *
 * **幂等**：前两格取最大值，第三格由宿主的**事件序号水位**（`spokeFoldedUpTo`）保证——
 * 同一个事件折两遍不会算两条。这一点是必需的——warmUp 读全量、而 `channelBookSeq` 从 0 起，
 * 重启后下一拍会把同一批事件再折一遍。
 *
 * 判据来源（都不是新写的）：
 *   · 她说过话 ⇒ `speak/sent` + `deliveredToSid`（**真的投递到那个会话**的那些；
 *     与 `readChannelSpoken` 的"我自己的发言"同一个函数）；
 *   · 有人叫她 ⇒ `wake/channel` / `channel/message` 上的 `mentionedInMessage`
 *     （群 @ 或 `mentionsMe`），**私聊不算**——私聊里没有"提及"这回事。
 *
 * `spokeTimes` 为什么是**时刻数组**而不是一个计数（v67，用户要"回复频次最高的前 3 个"）：
 * 频次带**滚动窗口**（`SESSION_FREQ_WINDOW_MS`），而"窗口里的条数"**不是可合并的摘要**——
 * 两批事件各折出一个数，相加会在重折时翻倍、取最大会漏掉另一批，只存进程内存又撑不过重启。
 * 时刻数组按 sid 并起来既幂等（靠序号水位，见上）又能跨重启从日志折出来，窗口判断因此留在
 * **渲染层**（纯函数、可复算：`selfBrief.spokeFreqOf`）。
 *
 * ⚠ 这一格**一件事算一条**：同一个会话同一毫秒里的两条发言是**两条**（频次各算一次）——
 * 所以去重键是事件序号、不是时刻本身。
 */
export function foldSpokeAndMention(events: readonly AppEvent[]): {
  spokeAt: Map<string, number>;
  mentionedAt: Map<string, number>;
  spokeTimes: Map<string, number[]>;
} {
  const spokeAt = new Map<string, number>();
  const mentionedAt = new Map<string, number>();
  /** 她说过话的时刻：一件事一条（同一毫秒的两条不会被并成一条），最后排成升序 */
  const times = new Map<string, number[]>();
  /** 取最大值：同一事件折两遍（重启后的重折）结果必须一样 */
  const bump = (map: Map<string, number>, sid: string, at: number): void => {
    if (!Number.isFinite(at)) return;
    const prev = map.get(sid);
    if (prev === undefined || at > prev) map.set(sid, at);
  };
  for (const event of events) {
    if (event.type === 'speak/sent') {
      const delivered = deliveredToSid(event.data);
      if (delivered === null) continue;
      const sid = normalizeSid(delivered);
      const at = Date.parse(event.ts);
      bump(spokeAt, sid, at);
      if (!Number.isFinite(at)) continue;
      const list = times.get(sid);
      if (list === undefined) times.set(sid, [at]);
      else list.push(at);
      continue;
    }
    if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
    const d = event.data;
    if (d.chatType === 'c2c' || !mentionedInMessage(d)) continue;
    bump(mentionedAt, sidOf(d.channel, d.chatType, d.chatId), Date.parse(event.ts));
  }
  const spokeTimes = new Map<string, number[]>();
  for (const [sid, list] of times) spokeTimes.set(sid, list.sort((a, b) => a - b));
  return { spokeAt, mentionedAt, spokeTimes };
}

/**
 * 两个**升序**的时刻表并起来（v67）：`cutoff` 之前的丢掉。
 *
 * **不在这里去重**：去重是**事件序号水位**那件事（`RealLoop.spokeFoldedUpTo`）——同一毫秒里的
 * 两条发言是两条（频次各算一次），只有"同一个事件被折两遍"才必须合成一条，而那种情况已经被
 * 水位挡在门外。所以这一层只管合并与剪枝，两件事各归各的一处判据。
 *
 * `cutoff` 不是有效数（时钟坏了）时**不剪**：宁可多留几条，也不因为一个坏值把素材清空——
 * 与渲染层"拿不到现在就不按窗口藏会话"同一个取舍。
 */
function mergeSpokeTimes(prev: readonly number[], add: readonly number[], cutoff: number): number[] {
  const out: number[] = [];
  const keep = (at: number): void => {
    if (Number.isFinite(cutoff) && at < cutoff) return;
    out.push(at);
  };
  let i = 0;
  let j = 0;
  while (i < prev.length || j < add.length) {
    const a = i < prev.length ? prev[i]! : Number.POSITIVE_INFINITY;
    const b = j < add.length ? add[j]! : Number.POSITIVE_INFINITY;
    if (a <= b) {
      keep(a);
      i += 1;
    } else {
      keep(b);
      j += 1;
    }
  }
  return out;
}

function groupMemberCandidateOf(event: AppEvent, selfMessages?: SelfIdentity): GroupCallingEvent | null {
  if (event.type !== 'wake/channel') return null;
  const data = event.data;
  if (data.chatType !== 'group' && data.chatType !== 'group-at') return null;
  if (!mentionedInMessage(data)) return null;
  /**
   * **我自己不算群成员**（2026-10-11）。
   *
   * 正经的闸在宿主的落库口（`main.ts` 的 `onChannelMessage`：认出是自己发的就整条不落库，
   * 见 `channel/self-identity.ts`）。这一句是**防线第二道**，挡的是另一条路：
   * `warmUp` 会拿**日志里已有的**事件重折一遍（`backfillGroupMembers` 那一趟）——
   * 判据补上之前落下的那些回声还在日志里，重折一次就会把他自己重新登记成"群友C"。
   *
   * 它与宿主那一处**共用同一个判据实现**（`SelfIdentity.has`），不另写一份字符串比较：
   * 两处各写一遍，迟早一边改了另一边没改，而症状（档案里那个"群友"又是谁）从行为上看不出来。
   */
  if (selfMessages !== undefined && groupMemberGate(data, selfMessages)) return null;
  return event;
}

/*
 * **这里曾经有一个函数**：`declaredMcpServers(config)`（v34 起）——把 `AppConfig.mcp.servers`
 * 读成"配置里声明了哪些 server"，供数字资产事实层核对她的 `[mcp]` 条目。
 *
 * v45 删（2026-10-09 用户拍板取消「light 选取资产」这条机制）：它唯一的生产消费者
 * （`assetFacts()`，跟着那次挑选一起走）没了。**读配置面这件事本身没丢**：同一个 `AppConfig.mcp`
 * 段仍然是 MCP 池与界面 `mcpView` 读的那一份（`config/config.ts` 的 `McpConfig`），
 * 那两处不经过这里。事实层要不要重新接回"声明面"由以后真需要它的那条路决定——
 * 别为了留着这个函数而去找一个调用点。
 */

/**
 * 同一条判据，但吃的是**裸的事件形状**（`type` + `data`）而不是 `WakeEmission`。
 *
 * 为什么要另开一个口（2026-10-03 修一个真 bug）：写「有人开口了」这条事实的**不止
 * WakeSink 一条路**。看门目录与消息适配器走 `RealLoop.wake()`，而界面聊天框与 /dream
 * 是 Web 层直接 `appendSync('wake/manual')` 落库的（`src/web/server.ts`）——
 * 它同样是一条"有人在跟她说话"，却从来没走到 `noteUserSpoke`。
 * 后果实测过一次（用户 17:38 那轮）：他在界面上插了一句话，她正一条条往外发的
 * 8 条气泡照旧发完，speak 卡一直挂到 65 秒后才结束。判据只留一份实现，两个入口共用。
 */
export function userSpokeEventTextOf(type: string, data: unknown): string | null {
  if (!USER_SPOKE_TYPES.includes(type)) return null;
  const record = (data ?? null) as Record<string, unknown> | null;
  const raw = type === 'wake/manual'
    ? (record?.['note'] ?? '')
    : type === 'wake/channel'
      ? (record?.['text'] ?? '')
      : (record?.['body'] ?? '');
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  // 没有文字的消息也要如实说（纯图片、纯表情包都走这里），否则回执会显得莫名其妙
  if (type === 'wake/channel') {
    const attachments = record?.['attachments'];
    const count = Array.isArray(attachments) ? attachments.length : 0;
    return count > 0 ? `（发了 ${count} 个附件，没写字）` : '（一条空消息）';
  }
  return null;
}

// ──────────────────────────────── 对外类型 ────────────────────────────────

/** 平台显示名：她自己就跑在这上面，给一个读得懂的名字比给 `win32` 强 */
const PLATFORM_LABELS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/**
 * 读一个路径所在卷的剩余空间。**任何失败都返回 null**（卷没挂上、路径不存在、权限不够）：
 * 此刻层据此写"未知"，而不是替她判断"磁盘没事"——那是两件完全不同的事。
 */
function readDiskFacts(path: string): { path: string; freeBytes: number; totalBytes: number } | null {
  try {
    const fs = statfsSync(path);
    const freeBytes = fs.bsize * fs.bavail;
    const totalBytes = fs.bsize * fs.blocks;
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0 || freeBytes < 0) return null;
    return { path, freeBytes, totalBytes };
  } catch {
    return null;
  }
}

/**
 * 一次 `/stop` 的结局（回给消息入口那一层用）。
 *
 * 四个字段都是**事实**（不是推断）：`turnStopped` 说当时有没有在跑的活、`cleared` 说清掉了
 * 几条待处理输入、`seq` 是那条 `slash/handled` 留痕（要追"这一刻到底发生了什么"从它查）、
 * `receipt` 是**回给用户的原话**（与日志里那一格逐字相同——两处各写一遍迟早不一样）。
 */
export interface StopOutcome {
  outcome: 'stopped' | 'idle';
  receipt: string;
  /** 当时确实有一轮在跑（掐了它的流） */
  turnStopped: boolean;
  /** 从队列清进死信的输入条数（`reason: 'stopped-by-owner'`） */
  cleared: number;
  /** `slash/handled` 留痕的 seq */
  seq: number;
}

export interface RealLoopDeps {  log: EventLog;
  dataDir: string;
  projection: Projection;
  now: () => Date;
  timezone: string;
  ds: DsClient;
  registry: ToolRegistry;
  persona: PersonaAssets;
  config: AppConfig;
  out?: (line: string) => void;
  /**
   * 本进程的**版本号**（`main.ts` 的 `AGENT_VERSION`，与 `session/start.version` 同一处口径）。
   *
   * 为什么要宿主给而不是循环自己读 `package.json`：版本号的唯一真相源是那一个常量
   * （它的注释写着"改这一个要同步四处"），循环再去盘上读一次就是第五处。
   * 缺省 `'unknown'`——**测试台与嵌入方不传时，通报里如实写"说不出版本"**，不编一个数。
   */
  version?: string;
  /**
   * 重启探测的**读盘那一半**（上一任的输出日志里有没有 OOM、拉起器留痕说了什么）覆盖点。
   *
   * 为什么留这一格：这条路的判据全是"从盘上读痕迹"，而痕迹的种类（OOM 的输出日志、
   * 拉起器留痕、老日志根本没有这些文件）在一个夹具里摆不齐——真去造一份几 MB 的
   * node 输出日志不现实。缺省就是真读盘（`restartProbeOf`），生产行为一个字节不变。
   */
  restartProbe?: (dataDir: string, now: Date) => {
    oomEvidence: string | null;
    killEvidence: string | null;
    traceText: string;
    traceUsable: boolean;
  };
  /** 轮询间隔（毫秒），默认 1000 */
  pollMs?: number;
  /** 刹车判定器覆盖点（测试注入假阈值用）；缺省按 config.budget 构造 */
  guard?: BudgetGuard;
  /** 告警出口覆盖点；缺省按 config.alerts 自建（文件档永远开，webhook 配了才开） */
  notifier?: AlertNotifier;
  /** 水位停滞阈值（毫秒），默认 10 分钟（design §4.9） */
  stallMs?: number;
  /** 失败刹车的半开冷却（毫秒），默认 30 分钟 */
  failCooldownMs?: number;
  /** 心跳覆盖点（测试注入伪时钟/假闹钟用）；缺省按 config.wake 构造 */
  heartbeat?: Heartbeat;
  /** 快照事件间隔，默认 SNAPSHOT_EVERY_EVENTS（测试注入小值以低成本覆盖该判定） */
  snapshotEveryEvents?: number;
  /**
   * 技能管理器（design §4.19）：catalog 注入状态层（渐进披露第 1 层），信任表从日志折叠。
   * 不配则没有技能索引——状态层该段整体不出现。
   */
  skills?: SkillManager;
  /**
   * 执行点钩子（design §4.19）：PreToolUse / PostToolUse 随工具执行走，Wake 跟随唤醒。
   * 不配则三个执行点都不存在——行为与未装钩子时完全一致。
   */
  hooks?: HookRunner;
  /**
   * 数字资产事实层里 `[path]` 条目的就绪探测（v34，见 `persona/assets.ts` 的 `probeOnPath`）。
   *
   * ⚠ **v45 起没有生产消费者**（2026-10-09 用户拍板取消「light 选取资产」这条机制：
   * 原来读它的是 `assetFacts()`，跟着那次挑选一起删了）。**留着**是因为它是事实层的注入点
   * ——`persona/assets.ts` 的 `probeOnPath` 与那套判据照旧在，谁要重开一条"核对就绪"的路，
   * 从这里接手（测试的确定性覆盖点也还在，`test/fixtures/real-wake-rig.ts` 的 `probeAssetPath`）。
   * **缺省 = `probeOnPath`**（真查 PATH，Windows 上按 `PATHEXT` 逐个后缀找；纯 fs、不跑子进程）。
   */
  probeAssetPath?: (command: string) => { found: boolean; path?: string };
  /**
   * 数字资产事实层里 MCP 那一格的覆盖点（v34）：**配置声明了哪些 server**。
   *
   * ⚠ **v45 起没有生产消费者**（与上面 `probeAssetPath` 同一批删的调用点）。留着是把
   * "声明面"这个注入点留住：生产上"配置里声明了哪些 server"的正源是 `AppConfig.mcp.servers`
   * （MCP 池与界面 `mcpView` 读的就是它），哪个窄路径不想带那份配置，从这里给一份只有名字的
   * 列表即可（就绪情况 real-loop 看不到——`McpClientPool` 归宿主）。
   */
  mcpServers?: () => readonly string[];
  /** MCP 池与索引共享的声明面；缺省保持只读内置配置 */
  mcpDeclarations?: () => readonly import('../mcp/client.js').McpServerEntry[];
  /**
   * 插件运行组合的摘要（宿主给）：与上次建索引时记下的值不等 ⇒ **索引该失效**。
   *
   * 为什么这一格必须在：插件隔离/恢复/卸载会**从执行面撤走** MCP server 与技能，
   * 而索引原先只按 `RENDER_VERSION` 与压缩代次判断该不该重建 ⇒ 撤走之后索引仍是旧字节，
   * 模型继续对着池里已不能调用的 server 名发起调用（"幽灵 server"）。
   * 缺省 `undefined` ⇒ 不参与判据（不注入插件平台的实例行为完全不变）。
   */
  pluginRevision?: () => string | undefined;
  /** 一轮结算后、下一批输入前应用插件隔离/恢复 */
  onTurnBoundary?: () => Promise<void>;
  /**
   * **配置热更**：`config.json` 里可热更的那些字段变了之后，由宿主调一次（2026-10-10 加）。
   *
   * 为什么这个口在循环上：`AppConfig` 被**就地**改（见 `config/watcher.ts` 的
   * `applyHotFieldsInPlace`），所以循环不用重建就能看见新值；但"看见新值"与"把
   * **派生出来的那份事实**也跟上"是两件事——今天只有一件派生事实：
   *   · **MCP 常驻索引**（`mcpIndexText`）：它按用户定的口径**只在重大变化点归集**
   *     （见 `mcpIndexSync`：首次 / 模板换代 / `compaction/summary` 之后）。
   *     所以这里**刻意不重建它**（重建一次 = 每轮改请求前缀 = 缓存整段失效）；
   *     这一步留着的价值是**如实说一句**："声明面变了，索引会在下一次重大变化时归集"
   *     ——不说的话，读日志的人会以为热更没生效（而 `config/changed` 只在主进程那条日志里）。
   *   · 池那侧的重建**不在这里**：池归宿主（`main.ts` 的 `McpClientPool.applyDeclarations`），
   *     循环手里没有它，也不该有（披露式的全部价值就是池不与循环耦合）。
   *
   * 缺省不接 = 什么都不做（测试台与"配置不会变"的嵌入方照旧；行为与没有这一格时逐字相同）。
   */
  onConfigReloaded?: (change: ConfigReloadOutcome) => void;
  /**
   * 定时器表：每日记忆整理任务的布防与 payload 识别都读它（design §4.17）。
   * 不注入则不布防该任务，带整理 payload 的唤醒会退化为普通 turn。
   */
  timers?: TimerStore;
  /** 每日整理 cron 覆盖点（测试注入）；缺省读 config.wake.memoryMaintainCron */
  memoryMaintainCron?: string;
  /**
   * **`%TEMP%` 兜底扫**（2026-10-21）：每日整理那一拍顺带跑一次。
   *
   * 为什么是注入而不是循环自己 import：扫描的开关、白名单与 `dry|on` 都是**宿主**的事
   * （`main.ts` 从环境变量读）；循环只负责"整理完之后再扫一次，并把账落进日志与事件"。
   * 不注入 = 这一拍不扫（测试台与嵌入方行为不变，一个字节都不多写）。
   */
  tempSweep?: () => Promise<TempSweepReport>;
  /**
   * 计划模式门覆盖点（测试注入）。缺省按 `config.tools.planMode` 自建。
   * 宿主自建时**必须**与 agent-loop 用的是同一个实例：批准许可存在投影里，
   * 门与闸必须是同一双眼睛。
   */
  planMode?: PlanMode;
  /** 人审挂起超时（毫秒），默认 24h（design §4.21） */
  humanTimeoutMs?: number;
  /**
   * 她问人之后的等待线（毫秒）：超过它没人答就落一条「未批准、未拒绝」的 `human/expired`
   * （design §6.1）。缺省读 `config.tools.askHumanTimeoutMin`，再缺省 30 分钟。
   *
   * 与人审挂起超时（humanTimeoutMs）**刻意是两个数**：那一条是挂起（任务层暂停的资源决定），
   * 这一条只是"人还在不在机器旁"的事实判断——误判的代价差一个量级，不该共用一个数。
   */
  askHumanTimeoutMs?: number;
  /**
   * 当前 turn 的回投目标（M9）：本拍分派给模型的 wake 事件里，**最近一条** `wake/channel`。
   * 返回 null 表示这一轮不是由 IM 通道唤醒的——speak 的第三路就当没有地址，如实报"跳过"。
   *
   * 为什么由 real-loop 提供而不是让 speak 工具自己翻日志："哪条 wake 属于这个 turn"是
   * 循环层的事实（它刚刚把哪批事件交给了模型），只有它知道。
   */
  currentWakeChannel?: () => WakeChannel['data'] | null;
  /**
   * `task`（隔离子代理）的**运行期素材**（design §4.21，装配见 tools/catalog.ts 的 taskRuntime）。
   *
   * 为什么由循环补而不是装配点自己拼：子代理要的里面有三样是**循环的东西**——刹车判定器
   * （活取：加注会把实例换掉）、计划门（与父同一道门，否则子代理成了绕过事前审批的路）、
   * 执行点钩子。其余几样（log / ds / registry / projection / persona / modelVisibility）
   * 由装配点那侧的取值器给，所以这里**只补差集**，不重复搬一遍。
   *
   * 不传 = `task` 没有运行期那一半（工具如实报"未接线"）。`tools.taskEnabled: false` 时
   * 它本来就没注册，两者互不影响。
   */
  taskRuntime?: TaskLoopRuntimeDeps;
  /**
   * **我自己的标识集合**（宿主那一份 `SelfIdentity` 实例；2026-10-11 加）。
   *
   * 用途只有一个：群成员自动登记时把"我自己"挡在外面（`groupMemberCandidateOf`）。
   * 正经的闸在宿主的落库口（自己的消息整条不落库）——这里挡的是 `warmUp` 重折**历史事件**
   * 那一路：判据补上之前落下的那些回声还在日志里，重折一次就会把她自己重新登记成"群友C"。
   *
   * 递的是**同一个实例**（不是副本）：`main.ts` 每收到一条事件都往里补新学到的标识，
   * 而登记的判据要跟着那一刻的认知走。不给 = 这一档判据不生效（测试台与旧装配照旧）。
   */
  selfMessages?: SelfIdentity;
}

/**
 * 挂起线索 + 本进程的答复记账。`answeredAt` 不进 Suspension：Suspension 是能从日志折叠出来的
 * 线索，而这里只是一个「我已经探到答复了」的进程内标记，避免同一件事被反复探测。
 */
interface TrackedSuspension extends Suspension {
  answeredAt: string | null;
}

/**
 * 人审挂起提醒的**指纹参数**（`maybeWarnHumanStall` 的告警与跨重启去重共用这一份）。
 *
 * 为什么要抽出来：发送时用它算指纹，`notifier.restore(日志)` 之后又拿同一个指纹去问
 * "上一个进程提醒过没有"——两处各拼一次，迟早拼成两个指纹，于是每次重启都再催一遍。
 * `stall: '80%'` 让这条提醒与超时处置那条告警（`{askSeq, outcome:'timed-out'}`）分开：
 * "快到了"与"已经按未批准办完了"是两件事，不该互相顶掉限流窗口。
 */
function humanStallParams(askSeq: number): Record<string, string | number | boolean> {
  return { askSeq, stall: '80%' };
}

/** 毫秒 → 小时的人话（4.8 / 6；一位小数，整数不带 `.0`） */
function hoursLabel(ms: number): string {
  const hours = Math.round((ms / 3_600_000) * 10) / 10;
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
}

/** 一句提问的**前 40 字**（告警标题/日志行里够人认出是哪一条；全文在事件与卡片里） */
function questionPreview(question: string): string {
  const flat = question.replace(/[\s\u3000]+/gu, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/**
 * 本批 wake 事件里最近一条 `wake/channel`（M9）。
 *
 * 取"最近一条"而不是"第一条"：同一批里可能攒了几条通道消息（她刚回来时常见），
 * 回投应当回到最后说话的那个会话——那才是她正在回应的人。
 */
function lastChannelWake(events: readonly AppEvent[]): WakeChannel['data'] | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event !== undefined && event.type === 'wake/channel') return event.data;
  }
  return null;
}

/**
 * 组合摘要的短形（诊断文案用）：只取前 8 位。
 *
 * 为什么是 8 位而不是整串：那一行是给人读的（"插件组合变化（a1b2c3d4 → e5f6a7b8）"），
 * 完整 sha256 在这句里不提供任何多出来的信息；要整串时读事件载荷的 `pluginRevision`。
 * `undefined` = 宿主不提供这一格（不接插件平台的实例）——如实写"无"，不编一个值。
 */
function shortRevision(revision: string | undefined): string {
  return revision === undefined ? '无' : revision.slice(0, 8);
}

// ──────────────────────────────── 主体 ────────────────────────────────

export class RealLoop {
  private readonly deps: RealLoopDeps;
  private readonly notifier: AlertNotifier;
  private readonly write: (line: string) => void;
  private readonly pollMs: number;
  private readonly failCooldownMs: number;
  private readonly stallMs: number;
  private readonly failStreakMax: number;
  /** 心跳（design §4.12 概率模型：安静越久命中概率越高）；本模块自己持有，随 start/stop 布防 */
  private readonly heartbeat: Heartbeat;
  private readonly heartbeatSource: HeartbeatSource;
  /** 注入的判定器不重建（测试注入的假阈值必须原地生效） */
  private readonly guardIsInjected: boolean;
  private guard: BudgetGuard;
  /** 人工加注累计（启动时折叠，运行期增量维护；它是"有效上限"的来源） */
  private topUps: TopUpTotals = emptyTopUps();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /**
   * 「上一拍还在飞吗」——**tick 级的重叠保护**（2026-10-11，P1）。
   *
   * 为什么 `busy` 之外还需要它：`busy` 是**turn 级**的判据，而它的检查与置位之间隔着
   * prepare 段的 await（写快照 / 增量扫日志 / slash 命令 / 预算告警）。`setInterval` 到点就
   * `void this.tick()`，某拍被那些 await 拖过 `pollMs` 时下一拍照常重入 ⇒ 两拍都通过 `busy` 判据。
   * 实测后果（本机 16:40–16:45，事件 seq 74122–74414）：**turn 1277 被两个实例同时跑**
   * ——两条 `turn/start turn=1277`、13 个 step 每个都有两份 `step/start`/`step/end`、
   * `read_channel` 同一步两次且全部 10s 超时，turn 号复用、输入被重复认领、越滚越多。
   *
   * 它在**任何 await 之前**同步置位（见 {@link tick}），所以是真正的原子互斥；
   * 而 `busy` 的置位也已提到 prepare 段之前（同一处修的另一半），两者一起才堵住这个缺口。
   */
  private tickInFlight = false;
  private tickCompletion: Promise<void> | null = null;
  /**
   * 本拍进行期间**被守卫吞掉的拍数**。
   *
   * 守卫生效后在飞数必然恒为 1，所以"当时在飞几个"这个读数没有信息量；有信息量的是
   * "这一慢拍里到底压掉了几拍"——它就是重叠曾经发生过的证据，慢拍观测（`runtime/slow-tick`）
   * 每拍清零上报，不做累计（累计数会把"上一次卡顿"混进"这一次"）。
   */
  private tickSkipped = 0;
  /**
   * **上一轮 turn 的收尾计时**（`agent-loop` 的 `onTurnTiming` 回填，见 BUG-4）。
   *
   * 为什么要有这份刻度：慢拍（`runtime/slow-tick`）原来只记 `elapsedMs`，而 131 s / 221 s
   * 这两类现场**分不清是模型往返慢，还是收尾那几个 O(事件数) 的同步扫描把事件循环占死**
   * ——两者都表现为 `elapsedMs` 很大、`busy=false`。有了 `compactMs` 与 `events`，
   * "`turnMs - compactMs` 远大于 `compactMs`"就是模型/工具那一段慢，"`compactMs` 自己几十秒"
   * 才是收尾扫描。**只加观测，不动阈值**（诊断口径：补刻度之前不要动压缩阈值）。
   *
   * 一次 tick 只在真跑过一轮时被写一次（`runTurn` 之前清零）⇒ 慢拍账里的数永远是**本轮**的，
   * 不会把上一拍的读数混进来。
   */
  private lastTurnTiming: TurnTiming | null = null;
  /** 本轮 `runTurn` 的耗时（毫秒）；本轮没跑过 turn 就是 0（与 `lastTurnTiming` 同进同出） */
  private lastTurnMs = 0;
  /** 附件预热扫到哪条事件了（重启后归零，从窗口起点补一次） */
  private attachmentScanSeq = 0;
  /**
   * 等待预取的附件（FIFO，元素是那条临时直链）。
   *
   * 为什么要一个队列而不是"扫到就下"：一次预取只取**最近 maxContextImages 张**（见
   * `prewarmRecentAttachments` 的 limit），更早的那些这一拍不下——但**也不能丢**：
   * 它们是真实到达过的图（下一拍/下一轮还可能被挑中）。队列让"这一拍保最新的、旧的留到下一拍"
   * 成为可能，而上限（`PREWARM_BACKLOG_MAX`）保证它不会无限涨。
   */
  private readonly prewarmPending: string[] = [];
  private readonly prewarmPendingSet = new Set<string>();
  /** 一次预取正在跑（tick 与 step 两边都调它：重叠时后来者直接让路，不排队） */
  private prewarmBusy = false;
  /**
   * 已经留过痕的 `(kind|stage|reason|ref)` 组合。
   *
   * 为什么要去重：渲染层**每一步**都会重新挑图、重新要字节，同一张取不到的图不加去重就是
   * 每步一条 `image/trace`（一晚上几百条，把日志淹了）。留痕的目的是"查得到"，不是"每拍刷屏"。
   * 上限 512：满了整批清一次（清空只会让某些图再留一次痕，不会漏掉"从没留过"的那些）。
   */
  private readonly imageTraceSeen = new Set<string>();
  /**
   * 「有人插话」的**计数**（不是信号）。
   *
   * 为什么用计数而不是 AbortSignal：AbortSignal 一旦 abort 就**永远**是 aborted，而一轮里
   * 她可能说好几次话。实测的后果是她被打断一次之后，这一轮剩下的每一次 speak 都在第一片
   * 等待里被判成"又被打断"——连着十二次一句也没说出去，只能等下个 turn 才开口。
   *
   * 计数表达的是"**自你开口以来，有没有新的插话**"：每次 `noteUserSpoke` 加一，
   * speak 开始时记下当时的值，等待中只要它变了就是被打断；她重新组织语言再开口时
   * 记的是新值，于是能正常说完——除非对方又说话了。
   */
  private interruptEpoch = 0;
  /** 触发打断的那句话（写进 speak 的回执，让她知道该针对什么重新组织语言）**与是哪条唤醒** */
  private userSpokeNote: { text: string; wakeSeq: number } | null = null;
  /**
   * 已经为哪些 turn 发过"压缩后唤醒"（`via: 'compact'`）。
   *
   * 为什么进程内记一份就够、不必落事件：`compaction/decision` **一 turn 恰好一条**
   * （写入点只有 `TurnRunner.run` 一处），而 turn 号单调递增——所以"这个 turn 发过没有"
   * 是一个进程内即可判定的问题，重启后重新开始也只会漏掉那些**早就发过**的 turn
   * （真重启之后那一拍本就不该补发，补发就是对着一段已经翻篇的历史再叫一次）。
   * 见 {@link handleCompactionWake} 的"防抖"那一段。
   */
  private readonly compactWakeTurns = new Set<number>();
  /** 启动预热（重建限流窗口与加注累计）；幂等，只做一次 */
  private ready: Promise<void> | null = null;
  /** 失败刹车的暂停起点（null 表示未暂停） */
  private failPausedAtMs: number | null = null;
  /** 上一次放行试探的时刻（半开冷却判据） */
  private lastFailProbeMs = 0;
  // 跨天记账"上次记的是哪天"曾经存在这里，现在读投影的 budget.date——内存态活不过重启，
  // 而它决定的是"要不要把当日用量清零"，不能凭一个每次启动都为空的字段来判（见 rolloverIfNeeded）
  /** 快照事件间隔（默认 5000 条事件） */
  private readonly snapshotEveryEvents: number;
  /** 快照记账：上次写快照的日期与覆盖到的 seq（本进程态；快照是派生数据，丢了下次触发点再写） */
  private lastSnapshotDate: string | null = null;
  private lastSnapshotSeq = 0;
  /** 技能索引（design §4.19）：每 turn 装配时重扫一次，信任表在启动预热时从日志折叠 */
  /**
   * 群成员档案（自动注册的落点，见 channel/group-members.ts）。
   *
   * 惰性建：只在真的见到群消息时才碰盘——她没有群的时候，这条路径一次文件操作都不该发生。
   */
  private groupMembers: GroupMemberBook | null = null;
  /**
   * 框架预警的豁免名单（见 channel/warn-exempt.ts）。
   *
   * 默认谁都不豁免（预警开着）；用户可以在消息适配器页对**某个单聊**、或**群里某个已注册的人**
   * 开豁免。惰性建：只有真的要判定的那一拍才碰盘。
   */
  private warnExempt: WarnExemptBook | null = null;
  /** 这一批注册里有没有改动（有才落盘，避免每轮都写文件） */
  private groupMembersDirty = false;
  private readonly skills: SkillManager | null;
  /** 下一个可用 turn 号：普通 turn 由 agent-loop 分配，本模块只维护自己的记账口径 */
  private nextTurn = 1;
  /** 每日记忆整理 cron（空串 = 关闭该任务，design §4.17） */
  private readonly memoryMaintainCron: string;
  /** 计划模式门（design §4.21）：destructive 调用的事前审批，与 agent-loop 共用同一个实例 */
  private readonly planMode: PlanMode;
  /** 人审挂起超时（毫秒） */
  private readonly humanTimeoutMs: number;
  /**
   * 她问人之后的等待线（毫秒）。到点只落一条事实，**不撤卡、不做决定**（design §6.1）。
   * 判定线只影响"什么时候告诉她"，不影响任何一方的权力。
   */
  private readonly askHumanTimeoutMs: number;
  /**
   * 挂起中的人审（计划待批准；v27 之后 `human/asked` 的写入方只剩这一条）。本进程态，**事实在日志**：
   * 重启由 warmUp 用 scanSuspension 从日志重建，所以「答复在停机期间写下」那条路照样走得通。
   */
  private suspension: TrackedSuspension | null = null;
  /**
   * 已经为**哪一次挂起**发过"到 80% 了"的提醒（`maybeWarnHumanStall`）。
   *
   * 键 = `ask:<那条提问的 seq>`；拿不到 seq 时退回 `suspend:<turn>@<askedAt>`（同一 turn 的两次
   * 挂起仍然是两件事）。答复到达、或新挂起建立时清空——**同一挂起只提醒一次**，别让那行字
   * 每拍刷一遍。
   *
   * 光靠内存挡不住重启（进程起来又忘了），所以另外查一次限流窗口：`notifier.windows()` 里
   * 有同一个 (类别, askSeq) 指纹 ⇒ 上一个进程已经提醒过（`warmUp` 用日志重建窗口，见那里的
   * `notifier.restore`）。两条判据同一个结论：这条提醒一件事只发一次。
   */
  private humanStallWarnedKey: string | null = null;
  /** 答复探测的增量游标（只扫人审相关事件，不每拍全量重读日志） */
  private humanCursor = 0;
  /**
   * 当前 turn 正在处理的唤醒批次里最近一条通道消息（M9）。
   * 生命周期与批次一致：分派前赋值、turn 收尾后清空——绝不能把它留到下一个 turn
   * （speak 的回投地址一旦指向上一轮的会话，就成了"把她上一条回复发到另一个聊天"的灾难）。
   */
  private wakeChannelData: WakeChannel['data'] | null = null;

  /**
   * 这一拍该进上下文的**MCP 常驻索引文本**（v46；空串 = 那一刻一个 server 都没有）。
   *
   * 为什么记在实例上、而不是让 `agentDeps` 现读日志或现读配置：
   *   • **现读配置**正是用户点名不许的那件事（每轮改前缀 ⇒ 缓存整段失效）；
   *   • 现读日志要 async（`readAll` 是异步迭代器），而 `agentDeps()` 是同步的；
   *   • 记在实例上之后，"本拍用的是哪一版索引"与 `mcp/index` 那条事件**逐字节同源**
   *     ——`mcpIndexSync` 是唯一写入点，它写完就顺手把这份缓存更新成同一串字节。
   *
   * 进程刚起来时它是空串：`warmUp`/第一拍 tickOnce 里的 `mcpIndexSync` 会在**认领任何输入
   * 之前**把它定下来（判据见那个方法），所以第一次请求里就已经是正确的那一版。
   */
  private mcpIndexText = '';

  /**
   * 这一拍该进上下文的**技能常驻索引文本**（2026-10-11；空串 = 那一刻一个可用技能都没有）。
   *
   * 与 `mcpIndexText` **逐个理由同形**（那份注释就是这一份的理由）：它紧挨着 `instructions` /
   * `tools` 两段常驻前缀，若每轮现问 `SkillManager.catalogText()`，那么**批准装一个技能 /
   * 删一个技能**就会把请求前缀改一次（整段历史掉出 KV 缓存，实测口径 ≈9.6 万 token 一轮）。
   * 用户这一轮的判据是「skill 索引的进入和退出也要有类似 mcp 的进入和退出那样的缓存保护的机制」
   * ⇒ 字节只来自日志里那条 `skill/index` 快照，而快照只在下面四个点上重建
   * （`skillIndexSync` 的方法头：首次 / 模板换代 / 压缩之后 / 插件 Skill 根变化）。
   *
   * 记在实例上还有一个**本轮内不许抖动**的用处：`agentDeps()` 一轮调一次，它读的就是这一格
   * ⇒ 同一轮里哪怕中途批了一个技能，这一轮所有 step 用的仍是**同一个**字节串
   * （下一拍归集才会换，那才是"一轮之内只允许变一次"）。
   */
  private skillIndexText = '';
  private skillPackageRootsRevision = -1;
  /** 上次建 MCP 索引时看到的插件组合摘要（`undefined` = 还没建过 / 宿主不提供） */
  private pluginRevisionSeen: string | undefined = undefined;

  /**
   * 信任表折到哪一条了（`skillIndexSync` 的增量折叠用；seq 只增）。
   *
   * 为什么需要它：归集点可能很密（"一个可信技能都没有"那种退化形状下每一拍都走得到重建判据），
   * 每拍全量重折 `skill/installed` 是 O(事件数)。而信任事件很稀疏 ⇒ 记一个水位，
   * 每次只折它之后的。0 表示"这一任还没折过"（第一次会从头折一遍，与 `setTrustEvents` 等价）。
   */
  private skillTrustSeq = 0;

  /**
   * **本拍读过的事件快照**（`mcpIndexSync` 每拍全量读一次日志，顺手留在这里）。
   *
   * 谁用它：`settleGrants`（判"这张申请单拾取过没有"）。它**不能 await**——拾取必须在
   * 同一拍的同步段里跑完（那两条事件里有一条是给人的卡）；而 `EventLog` 没有同步的
   * "读全量"（只有逐条 `get(seq)`，组不出"哪些 id 出现过"这份账）。
   * ⇒ 复用同一拍已经付过的那一次读，而不是为它再读一遍盘。
   *
   * 纪律：**只读**。它是快照，写入点仍然是日志（`appendSync`）——就地改它等于让
   * "本拍的事件"与"盘上的事件"漂开，而后面按它判重的那几处会一起被骗。
   */
  private eventView: readonly AppEvent[] = [];

  /**
   * **本轮的维护窗口信号**（2026-10-11）：轮首算一次，deps 那一格整轮原样转手。
   *
   * 为什么必须在轮首算、且**一轮只算一次**：
   *   · 此刻层那条 `维护窗口：` 是**逐 step 发**的（与 v32 的 STATE 提醒同一层）——它若每个 step
   *     现算，同一轮里就会随时刻/空拍数抖动，前缀从那一行起每一步都失配；
   *   · 判据要的四样材料里有两样是"读日志"（上一条 `compaction/decision` 的 historyTokens 与
   *     上一次窗口的时刻），逐 step 读一遍是白花。
   *
   * 它是**纯观测 + 一句提示**：不改任何判据、不动任何文档（用户的红线："框架只给信号"）。
   */
  private maintenanceWindowNow: MaintenanceWindowNote | null = null;

  /**
   * **用户急停用的那一条中断信号**（`/stop`，2026-10-16 加）。
   *
   * 为什么在实例上、为什么整轮共用一条：`AgentLoopDeps.signal` 这个字段**早就在了**
   * （注释写着"外部取消（shutdown）：透传给模型请求与工具执行"），而生产（`real-loop` 的
   * `agentDeps`）**从来没接过线** —— 所以在此之前，除了"关进程"，没有任何东西能取消一条在飞的模型流。
   * `/stop` 要的正是那件事，于是这里补上这条线。
   *
   * ⚠ **一次 stop 一条新控制器**：`AbortSignal` 一旦 abort 就永远是 aborted，
   * 而这里要的是"这一轮被停掉"、下一轮照常能跑。所以 `abort` 之后**立刻换一条新的**
   * （见 `handleStopCommand` 里那两行），下一轮 `agentDeps` 拿到的是干净的信号。
   * 这也正是 `interruptEpoch` 当初为什么不用 AbortSignal 的那个理由（见它的注释），
   * 区别在于那条是"一次发言"，而这条是"整轮取消"——轮次边界上换一条新的是对的。
   */
  private stopController = new AbortController();

  /**
   * 「本轮的取消是用户按 `/stop` 要的」这一格事实（`/stop` 专用，2026-10-16 加）。
   *
   * 为什么要它：`agent-loop` 从 `AbortSignal` 上**看不出是谁掐的**（所有取消长一个样），
   * 而两条路的处置完全不同——关机/信号取消要让输入退回队列（下次启动还能接着做），
   * 用户急停则**不许退回**（他刚说完"停下来"）。判据只能有一个来源：按下去的那一处。
   * 它在 `agentDeps()` 里被读走、`runTurn` 返回后清掉（见 `stoppableTurn` 的注释）。
   */
  private stoppedByOwner = false;

  /**
   * 界面那条路上"已经掐了流、还没落留痕"的那一次急停（见 `ownerStopCommand` / `consumeStopCommand`）。
   *
   * 为什么需要这一格：界面那条路的两步（`appendSync('wake/manual')` 与 `noteUserSpoke`）
   * 在 `web/server.ts` 里是同一个同步块里的两个调用，中间**不许有 await**
   * （那条纪律是为了 speak 的打断回执，见 `WebServerDeps.noteUserSpoke`）。
   * 所以急停也拆成"先动手、后落痕"两步，而中间那一小段时间需要一个落脚点。
   * 取走即清 ⇒ 同一次按下只会落一条 `slash/handled`（幂等）。
   */
  private pendingStop: { stop: { where: string; text: string }; result: StopOutcome } | null = null;

  /**
   * 界面那条路里"那条 `wake/manual` 的 seq"——两步之间的那一帧把它记下来，
   * 由 `dropStopInput` 摘出队列（它是框架按钮的载体，不是给她的输入）。
   * **只有界面那条路会用到它**（通道那条路根本没落库）。
   *
   * ⚠ 摘的**时机**是这件事的全部难点：必须在载体**已经被折进投影之后**。
   * 判据不是"在哪条路上"、也不是"哪一步的顺序"，而是**投影折没折**——
   * 见 `dropStopInput` 里那段注释（它写清了 `web/server.ts` 的 `appendSync` 三步顺序）。
   */
  private pendingStopWakeSeq: number | null = null;

  /**
   * 预热跑完之前到达的**配置热更通报**（一次重载最多一条，见 `notifyConfigReloaded`）。
   *
   * 为什么需要这一格：热更是**事件驱动**的（文件一变就来），而循环的预热是**第一拍**才跑的
   * ——两者谁先到是不确定的。预热的那趟全量读会把 `mcpIndexText` 定下来，而通报里那句
   * "当前几个 server"该在它之后说。存一格比"加一个 async 排队机制"简单得多，也不会漏：
   * `ConfigWatcher` 的重载是串行的（互斥锁 + 去抖），不会有第二条覆盖第一条。
   */
  private pendingConfigReload: ConfigReloadOutcome | null = null;

  /**
   * 这一刻的**遮蔽点**（`compaction/summary` 的 `coveredUpToSeq`，取最大者；没有就是 0）。
   *
   * v50 用它判"这条输入还在不在她眼前"：**`seq <= 遮蔽点` 的唤醒已经被折进摘要了**——
   * 它的内容不在她眼前，重投它只会造出"一条已经被折掉的通报又插回请求中间"
   * （2026-10-10 现场：`miss=37884`，判据写在 `settleHumanSuspension` 的注释里）。
   *
   * 素材是 `mcpIndexSync` 每拍已经读过的那一份 `eventView`（本拍看到的事件快照），
   * 所以这里**不再读一遍盘**——而且这个判据**只在这一处被问**。
   */
  private coveredPointOf(): number {
    let covered = 0;
    for (const event of this.eventView) {
      if (event.type === 'compaction/summary' && event.data.coveredUpToSeq > covered) {
        covered = event.data.coveredUpToSeq;
      }
    }
    return covered;
  }

  /**
   * 某一轮 `turn/start` 的 seq（查不到给 0）。
   *
   * v50 用它把"重投"分成两类，见 `settleHumanSuspension` 的判据：
   *   · `wake.seq < 该轮 turn/start` ⇒ 这条输入**是上一拍就已经递到她眼前的**（当轮输入）；
   *   · 其余 ⇒ 它是**本轮进行中才插进来的**（`claimInterruption`），从头到尾还没被递过。
   * 素材同样是本拍那份 `eventView`（不额外读盘）。
   */
  private turnStartSeqOf(turn: number): number {
    for (const event of this.eventView) {
      if (event.type === 'turn/start' && event.data.turn === turn) return event.seq;
    }
    return 0;
  }

  /**
   * 会话簿：她认人/认场景的依据（启动时折叠一次，之后每拍并入新来的通道事件）。
   *
   * 为什么**不只在认领唤醒时**并入（v32）：通道消息分两类——叫她来的（`wake/channel`）与只记账的
   * （`channel/message`，internal、不唤醒）。后者永远不会出现在 pending 里，只并入"被认领的那些"
   * 就等于**只有被叫醒过的会话才有未读**，而未读恰恰是"她还没被叫醒"的那种会话才需要的东西。
   * 所以并入点挪到**每拍扫一遍新事件**（见 foldChannelEvents）——判据只有一个：事件类型。
   */
  private sessionBook: KnownSession[] = [];

  /** 上一条已并入会话簿的通道事件 seq（每拍从水位往后扫，按类型过滤，不重扫历史） */
  private channelBookSeq = 0;

  /**
   * `messageId → 那句框架话 + 判定来源`（`injection/flagged` 折出来的）。
   *
   * 为什么要折：渲染与 `read_channel` 都是**按 messageId** 把预警贴回那一条消息旁边的，
   * 而渲染层是纯函数（只能读传进去的东西）。折成映射之后两处查同一份，重启后由
   * warmUp 的全量折叠补齐——不现扫日志，也不给渲染层开一个"自己去翻日志"的口子。
   *
   * v25 起值带上 `by`：示警那一刻要把它落进 `injection/noted`（谁判的：规则还是模型）。
   */
  /** 判定结论（含给人的 reason/quotes）：note 是给她的那句话，其余三个是给界面的 */
  private flaggedNotes = new Map<string, { note: string; by: 'rule' | 'model'; reason: string; quotes: readonly string[] }>();

  /**
   * 已经示过警的外部消息（按 messageId 去重）。
   *
   * 为什么不能只靠"一条消息只会被处理一次"：崩溃恢复会把输入退回队列（`input/requeued`），
   * 重启后同一条可能再走一遍这一拍——不记着，此刻层那段历史就会把它数成两次。
   * 与 `flaggedNotes` 同一条纪律：warmUp 全量补齐、平时按 seq 游标增量并。
   */
  private notedMessageIds = new Set<string>();

  /** 已判过的外部消息（按 messageId 去重：重投与攒批窗口都会让同一条再走一遍判定） */
  private judgedMessageIds = new Set<string>();

  /**
   * 这一轮**叫她的那条消息**（群里被提及/@；没有就是 null）——`read_channel` 靠它知道
   * "这个会话必须照给"（v28 之后她手里只有通知、没有正文，见 admin.ts 的说明）。
   *
   * 由 `foldChannelEvents` 在折叠通道事件时记下最近一条"在叫她"的群消息（判据与唤醒一致：
   * `chatType !== 'c2c'` 且平台 @ 或关键词命中）。
   */
  currentMention(): { sid: string; messageId: string } | null {
    return this.lastMention;
  }

  private lastMention: { sid: string; messageId: string } | null = null;

  /** 会话话题（`channel/topic` 折出来的最近一条）：清单那一行缀的那半句 */
  private channelTopics = new Map<string, string>();

  /**
   * sid → **她最后一次在这个会话里说过话**的时刻（毫秒，v66）。
   *
   * 素材是 `speak/sent` 里真的投递到某个会话的那些（判据 `deliveredToSid`，与 `read_channel`
   * 的「我自己的发言」**同一个函数**）。两处用它：会话清单那行的「最后 …」与"没人理的群"
   * 那道闸（`isUnattendedGroup`：她最后一次发言早于 7 天 ⇒ 不给它跑话题概括）。
   *
   * 折叠口径与 `channelTopics` 同形（warmUp 全量一次 + foldChannelEvents 增量），
   * 而且**取最大值**：同一个事件被折两遍（重启后 warmUp 重读）结果一样，天然幂等。
   */
  private spokeAt = new Map<string, number>();

  /**
   * sid → **她在这个会话里说过话的时刻**（毫秒，升序；一件事占一格，v67）。
   *
   * 与上面 `spokeAt` 同一批判据、同一批事件，区别只在这格留**全部时刻**：会话清单的
   * "回复频次最高的前 3 个"要在**滚动窗口**（`SESSION_FREQ_WINDOW_MS`）里数条数，而
   * "窗口里的条数"不是可合并的摘要（见 `foldSpokeAndMention` 那段）——只有时刻表能既跨重启
   * 从日志折出来、又把窗口判断留给渲染层。
   *
   * **只留窗口内的**：窗口外的时刻既不进频次也没有别的用处，留着只会让内存随日志一起长。
   * 剪枝界限取 `现在 − 窗口`（`this.deps.now()`，与此刻层同一把尺子）：渲染层的窗口以
   * `nowMs` 为锚，而 `nowMs` 永远不早于这一折，所以剪掉的一定在窗口之外——钟偏到未来也
   * 不会把窗口内的素材剪掉。
   */
  private spokeTimes = new Map<string, number[]>();

  /**
   * 已经折进上面那张时刻表的**最大事件 seq**（`-1` = 一条都还没折）。
   *
   * 它管的是"**同一批事件折两遍**"这件事（warmUp 全量之后，`foldChannelEvents` 从
   * `channelBookSeq` 起还会再折一遍）：折之前先按这个水位把已折过的筛掉。
   *
   * 为什么去重键是**序号**而不是"时刻"：时刻是**素材**（同一毫秒里的两条发言就是两条，频次
   * 各算一次），而"这条事件折过没有"是**记账**——两件事用两个键，才不会为了防重折而把
   * 真正的第二条发言吃掉。重启时新实例的水位回到 -1，于是 warmUp 照样把全量日志重折一遍
   * （这就是"跨重启成立"：素材只从日志来，进程内存里没有独一份）。
   */
  private spokeFoldedUpTo = -1;

  /**
   * sid → **最近一次有人 @/提及她**的时刻（毫秒，v66）。
   *
   * 判据**复用** `mentionedInMessage()`（群 @ 或 `mentionsMe`），不另写一套——两处各写一份
   * 迟早漂成"清单说没人叫她、而唤醒列表里明明有"。私聊不算（私聊里没有"提及"这回事，
   * 与 `imageAimedAtHer` / `mentionSidOf` 同一个口径）。
   *
   * 会话清单用它回答"最近 1 小时有人点我的名吗"——是就进清单。
   */
  private mentionedAt = new Map<string, number>();

  /**
   * sid → **上次概括覆盖到的事件 seq**（`channel/topic.toSeq`）。
   *
   * 与 `topicAt` 的分工：那个是"多久之前跑过"（内存里的节流，重启即失忆），这个是"概括到哪了"
   * ——它从日志折出来，所以重启之后仍然有效：同一段没读过的消息不会被反复概括出同一句话。
   */
  private topicSeq = new Map<string, number>();

  /** sid → 上次跑话题概括的时刻（毫秒）：节流用，防止连着几拍重复花 light */
  private topicAt = new Map<string, number>();

  constructor(deps: RealLoopDeps) {
    this.deps = deps;
    this.write = deps.out ?? ((line) => console.log(line));
    this.pollMs = deps.pollMs ?? 1000;
    this.stallMs = deps.stallMs ?? DEFAULT_STALL_MS;
    this.failCooldownMs = deps.failCooldownMs ?? DEFAULT_FAIL_COOLDOWN_MS;
    this.failStreakMax = deps.config.budget?.failStreakMax ?? 5;
    this.snapshotEveryEvents = Math.max(1, Math.trunc(deps.snapshotEveryEvents ?? SNAPSHOT_EVERY_EVENTS));
    this.skills = deps.skills ?? null;
    this.memoryMaintainCron = deps.memoryMaintainCron ?? deps.config.wake.memoryMaintainCron;
    this.humanTimeoutMs = Math.max(1, Math.trunc(deps.humanTimeoutMs ?? DEFAULT_HUMAN_TIMEOUT_MS));
    // 两个超时各读各的：挂起那条缺省 24h（plan 模式的老口径），她提问这条缺省走配置
    // （config.tools.askHumanTimeoutMin，默认 30 分钟）。配置缺失/非法（宿主自己拼的 config）
    // 时退回内置默认而不是算出 NaN——NaN 会让比较恒为假，于是这条事实**永远不落**，
    // 而"功能静默失效"比"报错"难查得多。
    const configuredAskMin = deps.config.tools.askHumanTimeoutMin;
    const askDefaultMs = Number.isFinite(configuredAskMin) && configuredAskMin > 0
      ? configuredAskMin * 60_000
      : DEFAULT_ASK_HUMAN_TIMEOUT_MIN * 60_000;
    this.askHumanTimeoutMs = Math.max(1, Math.trunc(deps.askHumanTimeoutMs ?? askDefaultMs));
    this.planMode = deps.planMode ?? new PlanMode({
      enabled: deps.config.tools.planMode,
      projection: deps.projection,
      // 与 appendSync 同一条通道：先落库再折投影，批准许可才会在本拍就被 gates 看见
      emit: (type, data, visibility) => { this.appendSync(type, data, visibility); },
      now: deps.now,
    });
    this.guardIsInjected = deps.guard !== undefined;
    this.guard = deps.guard ?? this.makeGuard();
    this.heartbeat = deps.heartbeat ?? this.makeHeartbeat();
    this.heartbeatSource = new HeartbeatSource(this.heartbeat, {
      emitHeartbeat: (data) => {
        this.appendSync('wake/heartbeat', data, 'model');
      },
    });
    // **这里曾经构造回复必要性门**（`new NecessityGate({...})`）：2026-10-05 拆掉了。
    // 它唯一的输入类是"仅心跳批次"，而心跳改成了**真实唤醒**（必须发一次 heavy 请求去保温
    // 供方缓存）——门留在链上只会把那条口径重新变成"一个请求都不发"。
    // 原意、为什么废、别再把它接回来的警告：docs/design.md「试过并废掉的口径：回复必要性门」。
    this.notifier = deps.notifier ?? createNotifier({
      config: deps.config.alerts,
      dataDir: deps.dataDir,
      // 告警事件走承诺类落盘：限流窗口的事实来源必须先在盘上（M3-10）
      emit: (type, data, visibility) => {
        this.appendSync(type, data, visibility);
      },
      now: deps.now,
    });
  }

  /**
   * 豁免名单（惰性建：没有豁免的实例一次盘都不碰）+ **每轮 refresh 一次**（口径：改完下一轮生效）。
   *
   * 为什么 refresh 由调用点显式做、而不是判据每次自己 stat：判据在渲染里会被**每条**通道消息问
   * 一次，那里每问一次都 statSync 一遍盘是不可接受的；而"名单改了要立刻生效"的粒度本来就是
   * **轮**（见 channel/warn-exempt.ts 的约束 2）。
   */
  private warnExemptBook(): WarnExemptBook {
    this.warnExempt ??= new WarnExemptBook(this.deps.dataDir);
    return this.warnExempt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.ensureReady();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.write(`[循环] tick 异常：${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.pollMs);
    // 心跳与主轮询无关：它是"没人说话时的呼吸"，随循环一起布防、一起停
    this.heartbeatSource.start();
    const dist = this.heartbeatSource.distribution();
    this.write(
      `[心跳] 已布防：安静 ${Math.round(dist.floorMs / 60_000)} 分钟前不触发、`
      + `${Math.round(dist.ceilMs / 60_000)} 分钟必然触发，每 ${Math.round(dist.tickMs / 60_000)} 分钟抽一次签`
      + `（命中概率随安静上升，均值约 ${Math.round(dist.meanMs / 60_000)} 分钟`
      + `${dist.targetMeanMs === null
        ? ''
        : `；目标均值 ${Math.round(dist.targetMeanMs / 60_000)} 分钟 ⇒ 解出 α = ${dist.alpha.toFixed(4)}`}）`,
    );
    void this.tick();
  }

  /** WakeSink：定时器到期记账（internal） */
  timerFired(timerId: string): void {
    this.appendSync('timer/fired', { timerId }, 'internal');
  }

  /**
   * 本 turn 的回投会话（M9）：speak 的第三路据此把发言回投到 IM 通道。
   * 不是通道唤醒的 turn 返回 null（当真循环未被当作通道宿主的装配用时就是这种情形）。
   */
  wakeChannel(): WakeChannel['data'] | null {
    return this.wakeChannelData;
  }

  /** 已知会话（会话簿）：`list_sessions` 与 `speak`/`report` 的 `to` 都读它 */
  sessions(): readonly KnownSession[] {
    return this.sessionBook;
  }

  /**
   * 会话簿的**工具层形态**（v66）：`read_channel` 不给 `sid` 时列的那一份。
   *
   * 为什么不直接把 `sessionBook` 递出去：那一份是**投影的内部形状**（带 `lastText`、
   * `readUpToSeq`、`messages` 这些"折叠用得上、她看了没用"的格子）。工具层要的是
   * "外面有哪些会话、各有多少没看、最后什么时候响的、在聊什么"——多给几格就是让她
   * 每次列会话都多读几行噪音（这正是这一版在治的东西）。
   *
   * `topic` 从 `channelTopics` 现取（与此刻层那张清单**同一个 map**）：
   * 所以"清单上缀着在聊什么"与"列会话时缀着在聊什么"不可能不一致。
   * 空话题**缺席**（不是空串）：`?? ''` 之后判一次，免得给出去一个空占位。
   */
  sessionRows(): readonly ChannelSessionRow[] {
    return this.sessionBook.map((entry) => {
      const topic = this.channelTopicOf(entry.sid) ?? '';
      const label = this.resolveChannelName(entry.sid);
      return {
        sid: entry.sid,
        chatType: entry.chatType,
        unread: entry.unread,
        lastSeenAt: entry.lastSeenAt,
        ...(topic.trim() === '' ? {} : { topic }),
        ...(label === null ? {} : { label }),
        /**
         * 「她上次读到哪」（v67）：`channel/read` 折出来的已读位，**这里只是把它递出去**。
         *
         * 为什么要递（2026-10-17）：`read_channel` 默认那一屏改成"只给上次查看之后的"，
         * 而"上次查看"必须跨重启成立。进程里那份 `readState` 是缓存（重启就空），
         * 账在日志的 `channel/read` 里——`collectSessions` 启动时把它折进 `sessionBook`，
         * 这里原样带上（`readUpToSeq` 就是那一格，**不另立第二份状态**）。
         *
         * 它**不改**会话清单那一支的渲染：`sessionsListResult` 只按名字取它要的那几格
         *（`unread`/`lastSeenAt`/`topic`/`label`），多带的这一格一个字节都不进回执。
         */
        readUpToSeq: entry.readUpToSeq,
      };
    });
  }

  /**
   * WakeSink：唤醒事件（model，承诺类；返回时已在磁盘上）。
   *
   * **`msgSeq` 在这里兜底补成事件 seq**（2026-10-07，且这条兜底对所有唤醒源生效）：
   * "这条你看过没有"的判据是 `wakeEvent.data.msgSeq > entry.readUpToSeq`
   * （`agent-loop.ts` 的 `contactWithWakeStamp`），而平台**给不出序号**的那几类
   * （OneBot 没带 `message_seq` 的、官方全量群消息）落的是 0 —— `0 > 0` 恒假，
   * 于是 OneBot 群里 @ 她的那一轮通知里**永远**不出现「（这一条你还没看过）」，
   * 她读成"又是上一次那条"就不回了（报告 §3.4；这正是用户 2026-10-02 踩过的那个坑，
   * `agent-loop.ts` 那段代码存在的唯一理由就是修它）。
   *
   * 补法与信箱那条**同一个函数**（`channel/inbox.ts` 的 `msgSeqOf`）：平台给了真序号就用它，
   * 没给就用事件 seq——单调、重放稳定，正是这个判据要的数。两条路填同一个量纲，
   * "信箱积了几条"与"这条你看过没有"因此不可能自相矛盾。
   *
   * 为什么在这里补而不是在 `main.ts` 的落库口：事件 seq 是**这个方法**分配的
   * （`appendSync` → `log.nextSeq()`），在外面拿不到；而补一个已经分配好的数、
   * 再原样交给同一个写入口，比让每个调用方各自拼一遍可靠得多。
   */
  wake(emission: WakeEmission): void {
    /**
     * ───────────── 用户急停的**通道入口**（`/stop`，2026-10-16 加）─────────────
     *
     * 放在**最前面、落库之前**，两件事一次办完：
     *   · 这条 `/stop` **不进队列、不落库**：它是给框架的按钮，不是对她说的话。落库的后果很具体
     *     ——它会在 `pending` 里等下一拍，而下一拍正好被那个长 turn 占着（`busy` 早退），
     *     于是"现在停"变成"等这一轮跑完再停"；而且它还会以一条 user 消息的样子出现在她眼前。
     *   · 判据与动作都在 {@link stopCommandOf} / {@link handleStopCommand} 里（一处）。
     *
     * 注意 seq 的消耗：这里在 `nextSeq()` **之前** return，所以那条被丢掉的输入不占 seq
     * （日志里没有它的位置，正合"它从来没存在过"这件事）。代价是**没有任何留痕**——
     * 留痕落在 `slash/handled{kind:'stop'}` 那一条上（它有 seq），用户按过什么仍然查得到。
     */
    const stop = this.stopCommandOf(emission);
    if (stop !== null) {
      // 掐流 + 清队列（同步、当帧）+ 留痕 + 回执：**四步一次办完**
      this.handleStopCommandOwn(stop);
      return;
    }
    // seq 在这里先取（原来是 `appendSync` 里取的）：`msgSeq` 的兜底要用它，
    // 而"分配即消耗"的 seq 只能取一次——所以先取、再把同一个数交给写入口。
    const seq = this.deps.log.nextSeq();
    const logged = this.appendSync(emission.type, withMsgSeqFallback(emission.data, seq), 'model', seq);
    // 任何外部事件到达即复位安静计时（design §4.12）。心跳自己不走这条路：
    // 它由 HeartbeatSource 直接落库，否则每拍都会把自己复位，命中概率永远起不来。
    this.heartbeat.noteActivity();
    // 有人开口了：她若正在发言，立刻打断（本机对话流与消息适配器都算，见 noteUserSpoke）。
    // 记的是**刚落的这条事件的 seq**：speak 真被打断时要拿它销账（见 claimInterruption）
    const spoke = userSpokeTextOf(emission);
    if (spoke !== null) this.noteUserSpoke(spoke, logged.seq);
  }

  // ── 用户急停（`/stop`） ──

  /**
   * 这条唤醒是不是**用户**按下的 `/stop`（纯判据，不写任何东西）。
   *
   * 返回 null = 不是（照常走唤醒那条路）。返回 `{where, text}` = 是，`where` 只用来说清
   * "他从哪条通道按的"（回执与留痕里各出现一次）。
   *
   * ## 权限判据（**这里就是唯一的判据点**）
   *
   * 三条路各自成一条"这是用户"的证据，一条都不许省：
   *   · `wake/manual` —— **界面那条路已经过了会话凭据**（`/api/commands/*` 的认证在
   *     `web/server.ts` 的入口，`trust.ts:99-102` 也把 `wake/manual` 定为 `owner`）。
   *     所以"它到了这里"就是"本机用户按的"。`via` 有值的不算（框架自己拼的通报，
   *     `/dream` 那一条就是这么来的）。
   *   · `wake/channel` **单聊（c2c）** —— 复用 `trust.ts` 那一套（联系人表里的 sid +
   *     `isOwnerLabel` + 已声明的用户 id）：判据与"她眼里谁是用户"**同源**，
   *     所以不会出现"她被允许回他、但他按不动停止"这种自相矛盾。
   *   · 群聊一律**不认**（`chatType !== 'c2c'` 直接 false）：群里谁都能打 `/stop`，
   *     那是"任何人可以让她的活白干"，不是用户特权。这与 `/compact` 只认本机对话流、
   *     以及 `trust.ts` 对群成员的处置是同一条纪律。
   */
  private stopCommandOf(emission: WakeEmission): { where: string; text: string } | null {
    const data = (emission.data ?? {}) as Record<string, unknown>;
    if (emission.type === 'wake/manual') {
      if (data['via'] !== undefined) return null;
      const note = typeof data['note'] === 'string' ? data['note'] : undefined;
      if (!isStopCommandText('wake/manual', note)) return null;
      return { where: 'GUI', text: (note ?? '').trim() };
    }
    if (emission.type !== 'wake/channel') return null;
    if (data['chatType'] !== 'c2c') return null;
    const channel = typeof data['channel'] === 'string' ? data['channel'] : '';
    const chatId = typeof data['chatId'] === 'string' ? data['chatId'] : '';
    const person = typeof data['person'] === 'string' ? data['person'] : '';
    const text = typeof data['text'] === 'string' ? data['text'] : '';
    if (!isStopCommandText('wake/channel', text)) return null;
    const contacts = this.deps.config.persona.contacts;
    const label = contacts[normalizeSid(sidOf(channel, 'c2c', chatId))];
    const declared = label !== undefined && isOwnerLabel(label, this.deps.config.persona.owner);
    // "已声明的用户 id"那条路（`ownerIds()` 与 `trust.ts` 的群聊分支同源）：
    // 单聊里它兜的是"联系人表还没来得及填、但用户 id 早就声明过"的情形
    const byId = person !== '' && this.ownerIds().has(person);
    if (!declared && !byId) return null;
    return { where: `QQ 单聊（${person === '' ? chatId : person}）`, text: text.trim() };
  }

  /**
   * 执行一次急停。**五步都不许省**（顺序也是刻意的）：
   *
   *   ① **掐流**（最先做）：用户要的是"现在就停"，而这一步是唯一"越快越值钱"的动作；
   *   ② **清队列**：`pending` 里的输入进死信并标 `stopped-by-owner`——它们**不会自己回来**
   *      （这正是用户今天最痛的那件事：「我重启了又 tm 重投了」）；
   *   ③ **作废本轮已认领的输入**：在跑的那一轮被掐之后，`agent-loop` 会按 `turn/end{aborted,stop}`
   *      走 `discardClaimedOnStop`（**不退回**，否则"刚停又重投"）；
   *   ④ **落留痕**：`slash/handled{kind:'stop'}`（回执正文逐字留在 `receipt` 上）；
   *   ⑤ **回执走既有对用户通道**（`notifier.alert`，与 `/compact` 同一条）——**不走她的 speak**：
   *      这是框架的动作，不是她说的话。
   *
   * ## 幂等
   *
   * 没有在跑的活、队列也空 ⇒ `outcome: 'idle'` + 那句"没有在跑的活"。
   * 判据是**当刻的事实**（`pending.length` 与 `busy`），不靠内存记账：
   * 连按两次，第二次必然落在 `idle` 上。
   *
   * ## 同步还是异步
   *
   * 前三步全是同步的（`abort()` 与 `log.append` 都是同步 API），**在入口那一帧就做完了**；
   * 只有告警投递（真的发 webhook）是异步的，它 `void` 出去不阻塞用户那一下。
   * 这条"同步"是刻意的：`wake()` 是消息落库口，它不该因为"发一条告警"而把整条通道卡住。
   */
  private handleStopCommand(stop: { where: string; text: string }): StopOutcome {
    const hadTurn = this.busy;
    // ① 掐流：abort 会让在途的 `fetch`/`read()` 当场抛，`ds-client` 把它分类成 `aborted`
    //    （中断不是错误：已收到的部分照既有 `interrupted` 语义留档）。
    //    **先看看有没有在跑的**再 abort：`AbortController` 一旦 abort 就永远是 aborted 态，
    //    而这一条信号是**整轮共用**的（见 `stopSignal()`），提前 abort 会把下一个 turn
    //    的第一步直接判成"被中断"。没有在跑就不动它。
    if (hadTurn && !this.stopController.signal.aborted) {
      // `stoppedByOwner = true` 是给 `agent-loop` 看的：`failStep` 靠它把这条 `aborted`
      // 标成 `cause:'stop'`（而不是 `'signal'`），`endTurn` 才走"作废本轮输入"那一支。
      this.stoppedByOwner = true;
      this.stopController.abort(new Error('用户按下 /stop'));
      // 立刻换一条新的：`abort` 之后的信号永远是 aborted 态，而下一轮要能照常跑
      // （见 `stopController` 的注释）。换的时机在 abort 之后、任何 await 之前。
      this.stopController = new AbortController();
    }
    // ② 清队列 → 死信（`input/dead-letter{reason:'stopped-by-owner'}`）：原文不会丢，
    //    它在日志里；界面的死信面板可以逐条重投（`requeue`，认领次数归零）或丢弃。
    const cleared = this.deps.projection.pending.length;
    for (const item of [...this.deps.projection.pending]) {
      this.appendSync('input/dead-letter', {
        inputSeq: item.wakeSeq,
        claimCount: item.claimCount,
        lastError: '用户按下 /stop：队列被清空，不再自动重投',
        reason: 'stopped-by-owner',
      }, 'internal');
    }
    /**
     * 留痕与回执**不在这里落**：那两步由 `recordStop` 统一办（`wake()` 那条路紧随其后调它，
     * 界面那条路紧随 `appendSync('wake/manual')` 调它）。这样"按了一次 /stop"在日志里
     * 无论从哪条通道来都只有**一条** `slash/handled`，不会一次按出两条。
     *
     * ⚠ **这里不许先占 seq**（`log.nextSeq()` 只增不减，占了就必须由**紧接着**那一次
     * `append` 用掉）：界面那条路会在两步之间写一条 `wake/manual`，先占就会让留痕的 seq
     * 落在那条之后 ⇒ `EventLog.append` 当场抛"seq 必须严格递增"（这个错实测踩过一次）。
     * 所以 `seq` 先记 0，由 {@link recordStop} 写完留痕后回填（见那里）。
     */
    const stopped = hadTurn || cleared > 0;
    const outcome: 'stopped' | 'idle' = stopped ? 'stopped' : 'idle';
    const receipt = stopped
      ? (cleared > 0 ? `${STOP_RECEIPT}（本次清掉 ${cleared} 条待处理输入）` : STOP_RECEIPT)
      : STOP_IDLE_RECEIPT;
    return { outcome, receipt, turnStopped: hadTurn, cleared, seq: 0 };
  }

  /**
   * **用户急停的公开入口**（给消息入口那一层用：GUI 的 `/api/commands/wake`）。
   *
   * 界面那条路**不经过 `wake()`**（`web/server.ts` 直接 `appendSync('wake/manual')`），
   * 所以判据要在这里再被问一次——但**动作与判据仍然只有一份实现**
   * （{@link stopCommandOf} / {@link handleStopCommand}），界面与 QQ 单聊不会漂成两套口径。
   *
   * 返回 null = "这不是给我的指令"（照常走唤醒那条路，调用方一个字节都不用改）。
   *
   * ## 为什么返回值只是"一份回执"，而不是"这件事办完了"
   *
   * `web/server.ts` 的 `wake` 动作与 `wake/manual` 的落库是**同一个同步块**里的两步
   * （先 `appendSync` 再 `noteUserSpoke`，中间不许有 await——见 `WebServerDeps.noteUserSpoke`）。
   * 所以急停也照这个顺序走：这里只**掐流 + 清队列**（同步、当帧完成），
   * 留痕与回执由紧随其后的 {@link consumeStopCommand} 落——两处共用同一个 `stopCommandOf`，
   * 于是"从界面按"与"从通道按"在日志里长得一模一样。
   */
  ownerStopCommand(type: string, data: unknown): StopOutcome | null {
    const stop = this.stopCommandOf({ type, data } as WakeEmission);
    if (stop === null) return null;
    const result = this.handleStopCommand(stop);
    // 交给紧随其后的那一步（`consumeStopCommand`）：它落留痕、回收执、把回执给界面。
    // 判据用的是**原文**（同一条 note），所以两步认的是同一件事。
    this.pendingStop = { stop, result };
    // `seq` 此刻还是 0（留痕还没落，见 `handleStopCommand` 末尾那段）——
    // 调用方拿它只为把 `consumeStopCommand` 的结果送回前端，回执正文两边逐字相同。
    return result;
  }

  /**
   * 一次办完（`wake()` 那条路：入口就在框架里，不必分两步）。
   *
   * 这条路**没有"两步之间"**：`wake()` 那条 `/stop` 在 `nextSeq()` 之前就 return 了，
   * 那条按钮根本没落库 ⇒ `pendingStopWakeSeq` 是 null，摘除是空操作。照调不误：
   * 摘除的时机由**投影折没折**决定，而不是由"哪条路"决定——两条路各写一遍时机，
   * 迟早又漂成今天这个 bug。
   */
  private handleStopCommandOwn(stop: { where: string; text: string }): StopOutcome {
    const result = this.handleStopCommand(stop);
    const settled = this.recordStop(stop, result);
    this.dropStopInput();
    return settled;
  }

  /**
   * 把"这条急停自己的输入"从队列里摘掉（界面那条路两步之间的那一笔）。
   *
   * 为什么需要它：界面那条路的两步之间会**照常**落一条 `wake/manual`（那条落库动作是既有的
   * 顺序，见 `web/server.ts` 的 `wake` 动作），于是它会被折进 `pending`——而它**不是**给她的输入。
   * 不摘的后果有二：① 队列看起来没被清空（"我按了停止，队列里还有一条"）；
   * ② 下一拍它会作为一个 turn 的输入被送到她眼前。所以摘掉它、并留一条痕。
   *
   * ## 为什么用 `input/claimed{turn:0}` 而不是 `input/discarded`
   *
   * 判据在 `state/fold.ts`：**从 `pending` 里摘除的唯一写入点是 `input/claimed`**
   * （`fold.ts` 的 `case 'input/claimed'`；`input/discarded` 只从 `deadLetters` 里摘，
   * 它服务的场景是"人去死信面板点丢弃"）。用 `input/discarded` 摘 pending 里那条，
   * 在运行期看不出来（下一条 `input/dead-letter` 会顺手把它带走），但在**只折这一条事件**的
   * 路径上（重放、测试）它会**留在队列里**——那种"运行期对、重放不对"的漂移正是最要命的。
   * `turn: 0` 是既有的"这条账不属于某个 turn"口径（`runSlashCommand` 与 `judgeChannelWakes`
   * 两处先例）：它不会让 `claimedByTurn` 长出一个假 turn。
   *
   * 返回"摘掉了几条"（0 = 它本来就不在队列里，例如通道那条路根本没落库）。
   *
   * ## ⚠ 调用时机是这件事的全部难点（2026-10-16 修）
   *
   * **必须在载体已经被折进投影之后调**。界面那条路上载体是 `web/server.ts` 的
   * `appendSync('wake/manual', …, afterAppend)` 落的，而那个 `appendSync` 的顺序是
   * `log.append → afterAppend → applyOne(投影)`——`afterAppend` 里（也就是 `recordStop` 里）
   * 查 `pending` 时载体**还没折进去**，一条也摘不掉。所以现在是**调用方显式调两步**：
   *   ① 落库那一帧：`consumeStopCommand`（判据、留痕、回执）；
   *   ② 投影折完之后：本方法（见 `web/server.ts` 的 `wake` 动作里那句调用）。
   *
   * 顺带满足一条硬约束（既有注释）：`input/claimed` 的 seq 必须**大于**那条 `slash/handled` 的
   * ——放 append 之后正好如此，放之前会让 `log.append` 当场抛"seq 必须严格递增"。
   */
  dropStopInput(): number {
    const wakeSeq = this.pendingStopWakeSeq;
    this.pendingStopWakeSeq = null;
    if (wakeSeq === null) return 0;
    const item = this.deps.projection.pending.find((entry) => entry.wakeSeq === wakeSeq);
    if (item === undefined) return 0;
    this.appendSync('input/claimed', {
      turn: 0,
      wakeSeqs: [wakeSeq],
      claimCounts: [item.claimCount + 1],
    }, 'internal');
    return 1;
  }

  /**
   * 界面那条路专用：**落留痕 + 给出回执**，并把这件急停**作废掉**（返回非 null 时调用方
   * 不许再把它当成"人开口"——它不是对她说的话）。
   *
   * 叫它的地方是 `web/server.ts`（与聊天框里任何一句话同一个调用点）。返回 null =
   * 这一条不是急停（或者已经被 `wake()` 那条路办过了）⇒ 调用方按原样继续。
   *
   * 返回值就是 {@link StopOutcome}（**`seq` 已回填成那条留痕的真实 seq**）：界面据此回话，
   * 所以"回给用户的 seq"与"日志里那条留痕"永远是同一个数。
   *
   * 幂等：`pendingStop` 取走即清，所以"同一条 note 被问两次"只会有一次留痕。
   */
  consumeStopCommand(type: string, data: unknown, wakeSeq?: number): StopOutcome | null {
    const pending = this.pendingStop;
    if (pending === null) return null;
    // 认的还是**原文**：payload 不一致就不是同一条（防"两次调用被凑到一起"）
    const again = this.stopCommandOf({ type, data } as WakeEmission);
    if (again === null || again.text !== pending.stop.text) return null;
    // 界面那条路会把**刚落的那个 seq** 递进来（那条 `wake/manual` 是它写的）：
    // 它现在起**不算给她的输入**，折投影之后由 `dropStopInput` 摘掉（见那里的注释）。
    // 没有 seq（通道那条路：根本没落库）⇒ 什么都不用摘。
    this.pendingStopWakeSeq = wakeSeq ?? null;
    this.pendingStop = null;
    // 结局里的 `stopped` 取的是**按下去那一刻**的快照（`pending.result`），不是此刻重算：
    // 此刻队列里刚被那条 `wake/manual` 动过，拿现在算会把"什么都没停"报成已执行。
    return this.recordStop(pending.stop, pending.result);
  }

  /**
   * 落留痕（`slash/handled{kind:'stop'}`）+ 把回执发给用户，返回**回填了 seq 的**那份结局。
   *
   * **回执走既有那条给用户回话的通道**（`notifier.alert`，与 `/compact` 同一条），
   * **不走她的 `speak`**：这是框架的动作，不是她说的话。
   * 指纹里带上留痕的 seq：**每一次按下都要有回答**（限流把回执吞掉，在界面上就是"按了没反应"，
   * 那是 `/dream` 那次事故的教训）。
   */
  private recordStop(stop: { where: string; text: string }, result: StopOutcome): StopOutcome {
    /**
     * ⚠ **载体的摘除不在这里**——它在 {@link dropStopInput}，由调用方在**投影折完之后**单独调
     * （界面那条路是 `web/server.ts` 的 `wake` 动作，通道那条路见 {@link handleStopCommandOwn}）。
     *
     * 为什么不能顺手在这里调（2026-10-16 修的，位置原来就在这一行）：这条方法跑在
     * `web/server.ts` 的 `afterAppend` 里，而那一步在 `applyOne(投影)` **之前**——
     *
     * ```
     * log.append(event, {sync:true})
     * afterAppend?.(event)                   // ← consumeStopCommand → recordStop 在这里
     * applyOne(this.deps.projection, event)  // ← 载体**到这一步**才进 pending
     * ```
     *
     * 所以在这个位置查 `projection.pending` 时，`pending` 还是**空的那个**（探针实测：在
     * `consumeStopCommand` 返回之后打印 `pending=[]`，紧接着 `applyOne` 之后才是 `[<载体>]`）
     * ⇒ `dropStopInput` 一条都摘不掉，载体留在队列里。而它的 kind 是 `'stop'`——
     * `handleSlashCommands` 若放它过去就会把它当 `/compact` 压一次历史，那正是用户 2026-10-16
     * 报的那个 bug（另一半的判据见 `handleSlashCommands` 里那段注释）。
     *
     * 顺序上还有一条硬约束（既有注释，别动）：`seq` 由**这一次 append 自己取**
     * （不在 `handleStopCommand` 里预占）——界面那条路的两步之间还会写一条 `wake/manual`，
     * 预占的号会被那条先写走 ⇒ append 当场抛"seq 必须严格递增"。
     * 现在的摘除（调用方在投影折完后调）天然满足它：`input/claimed` 的号必定更大。
     */
    const event = this.appendSync('slash/handled', {
      kind: 'stop',
      name: 'stop',
      argument: '',
      outcome: result.outcome,
      // 这条指令**没有**输入事件（入口就拦下了，见 `wake()`）：报 0 而不是编一个 seq，
      // "它从来没进过队列"这件事本身就是这一格的答案。
      inputSeq: 0,
      receipt: result.receipt,
    }, 'internal');
    const settled: StopOutcome = { ...result, seq: event.seq };
    this.write(`[指令] /stop（${stop.where}）→ ${settled.outcome}`
      + `：掐流=${settled.turnStopped ? '是' : '否'}、清队列=${settled.cleared} 条`);
    void this.notifier.alert({
      category: CATEGORY.stop,
      level: 'info',
      title: settled.outcome === 'stopped' ? '已执行 /stop' : '收到 /stop：没有在跑的活',
      body: settled.receipt,
      params: { where: stop.where, cleared: settled.cleared, running: settled.turnStopped ? 1 : 0, seq: settled.seq },
    }).catch(() => { /* 回执投递失败不该反过来影响"已经停下来"这件事 */ });
    return settled;
  }

  /**
   * 有人说话了：如果她正在这一轮里发言，打断这一次发言。
   *
   * 为什么连消息适配器一起算（用户的口径）：她在 QQ 上一条条打着字，对方又发来一条，
   * 那就是**被插话**——不管新话是从聊天框来的还是从 QQ 来的，继续把那半截说完都不对。
   *
   * 打断的语义只是"这一次别接着说"：已经发出去的收不回来，没发的一段都不发，
   * 而 `speak` 的回执会如实告诉她说了几条、剩什么没发、对方刚说了什么。
   * 她重新组织语言**再开口是允许的**——计数只拦"开口期间来的新插话"，
   * 这一点是踩过坑才定死的：早先用 AbortSignal 时，一次打断会把她这一轮剩下的
   * 每一次发言都判成"又被打断"（实测连着十二次一句没发出去）。
   *
   * `wakeSeq` 是那条唤醒自己的 seq：只有真被打断时（见 agent-loop 的 claimInterruption）
   * 才会有人读它。**不能在这里销账**——这个方法在她没发言时同样会跑，
   * 那样会把一条她根本没看见的消息从队列里吞掉。
   */
  private noteUserSpoke(text: string, wakeSeq: number): void {
    this.userSpokeNote = { text, wakeSeq };
    this.interruptEpoch += 1;
  }

  /**
   * 「有一条**人开口**的事件刚落库（seq 是它），你记一下」——给 WakeSink 之外的写入口用。
   *
   * 只有 `src/web/server.ts` 会调它：界面聊天框与 /dream 的 `wake/manual` 是那边直接
   * `appendSync` 落的，没经过 `this.wake()`。不补这一下，那条消息在日志与队列里都齐全，
   * 唯独 `interruptEpoch` 不动——于是她**正在说的那半截话会照旧说完**，正是 17:38 那轮的现象。
   *
   * 判据与 `wake()` 共用 `userSpokeEventTextOf`：不是人开口的（定时器、意图、心跳、后台任务）
   * 返回 null，什么都不做。**必须与落库同一个同步块里调**（调用方见 WebServerDeps.noteUserSpoke）：
   * 中间插进一个 await，speak 的那片 100ms 轮询就可能先跑到，多漏一条气泡出去。
   */
  noteUserSpokeEvent(seq: number, type: string, data: unknown): void {
    const text = userSpokeEventTextOf(type, data);
    if (text !== null) this.noteUserSpoke(text, seq);
  }

  /** 本次打断是被人开口触发的吗？是则给出他说的那句**话**与那条**唤醒**（speak 据此回执与销账） */
  userSpokeNow(): { text: string; wakeSeq: number } | null {
    return this.userSpokeNote;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wakeChannelData = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.heartbeatSource.stop();
    await this.tickCompletion?.catch(() => undefined);
  }

  async writeProjectionCache(): Promise<void> {
    const p = this.deps.projection;
    saveProjectionCache(this.deps.dataDir, p, p.lastSeq);
  }

  /**
   * 跑一拍。定时器回调与测试/宿主的手工驱动走的是同一份逻辑（不查 running），顺序不可调换：
   * 跨天记账 → 拾取加注 → 健康检查（含失败暂停置位）→ 快照判定 → 唤醒门 → 处理输入。
   */
  async tickOnce(): Promise<void> {
    await this.ensureReady();
    this.rolloverIfNeeded();
    this.settleTopUpRequests();
    // 抬上限解除暂停：每一拍再判一次（幂等——写完之后记录就没了，不会再写第二条）。
    // 启动那一次已经覆盖"改配置 + 重启"，这里覆盖运行期上限变化的其余路径（加注看门文件
    // 刚被拾取、判定器被重建……），并保证唤醒门读到的记录与活的上限永远对得上。
    this.releaseLiftedPauses();
    // 旧版本那条"人审挂起超时暂停"是一次性的历史：记录里 actual < limit ⇒ 它不可能来自撞线
    // ⇒ 就地把 task 层那条撤掉（判据与理由见 `releaseLegacyHumanTimeoutPause`）。
    // 用它而不是等 24 小时那条超时：本机现在这条（17:51 那条）就该在启动后第一拍解开。
    this.releaseLegacyHumanTimeoutPause('human-timeout');
    // MCP 常驻索引（v46）：**在任何输入被认领之前**定下本拍的索引版本。
    // 放在这里（而不是 wake 处理那一段）是为了它不依赖"这一拍有没有 pending"：
    // 索引进的是请求头部，任何一条请求（含心跳拍）都得用同一版。
    await this.mcpIndexSync();
    // 技能常驻索引（2026-10-11）：**与上一条同一拍、同一组触发点**（见 `skillIndexSync` 的方法头）。
    // 必须排在它之后：本拍的事件快照由那一条读下，这一条只读不再读盘。
    await this.skillIndexSync();
    await this.healthCheck();
    // 图片附件：每拍补下最近到达的（**包括 turn 进行中到达的那张**——它会立刻出现在她
    // 后续 step 的历史里）。放在 busy 检查之前：她正忙的时候恰恰是图片最容易到场的时候。
    //
    // 2026-10-21：**主路已经挪到 step 边界**（`agent-loop` 每步调 `prewarmStepImages`），
    // 因为一整个 turn 会把这一拍占住（下面 `runTurn` 是 await 的，`tickInFlight` 让 turn
    // 期间的到点整拍丢弃）——挂在拍上的预取在 turn 运行期间根本轮不到。这一条留着覆盖
    // "没人在跑 turn"的空闲期与重启补扫；两条路共用同一个实现与同一个游标。
    await this.prewarmRecentAttachments({ stage: 'tick' });
    // 会话簿与未读：同样放在 busy 之前。她正忙时新来的群消息照样得计入未读——那一轮结束后
    // 她看到的清单要是还停在开跑前的数字，等于每次忙完都少看到几条。
    this.foldChannelEvents();
    // 她问出去、一直没人答的提问（design §6.1）：到点落一条「未批准、未拒绝」的事实。
    // 放在 busy 之前是刻意的——她正在跑的那个长 turn 里，这条事实也要及时出现在她的上下文里
    // （agent-loop 每一步都重新对齐日志），而不是等她忙完才补上。
    await this.settleHumanAsks();
    // 她递的申请单（2026-10-11：MCP 的增删她只能"申请"，用户只在界面点批准或驳回）：
    // 每拍扫一次 `<dataDir>/grants/`，把还没进过日志的单子变成一条待批（`human/asked`
    // 用 **system 来源** = 挂起语义，与计划审批同一个坑位）。
    //
    // 2026-10-21：**主路已经挪到 step 边界**（`agent-loop` 每步在 `syncEvents` 之后调
    // `settleGrantsStep`）——因为一整个 turn 会把这一拍占住（下面 `runTurn` 是 await 的，
    // `tickInFlight` 让 turn 期间的到点整拍丢弃），挂在拍上的拾取在 turn 运行期间根本轮不到：
    // 她中途递的单子要等这一轮说完才挂出来，实测等了 57s / 1m47s / 4m57s（那一轮跑了 348.9s）。
    // 这一条留着覆盖"没人在跑 turn"的空闲期与重启补扫；两条路共用同一个实现与同一套判据。
    //
    // **为什么也在 busy 之前**：空闲期她递的单子，这一拍就该挂出来给人看见
    // （人可能正开着界面）。这一条只在"没人在跑 turn"时执行（turn 期间整拍被丢），所以它
    // 拾取时那一轮要么还没开始、要么已经结束——**不会打断谁**；那张卡若还挂在台面上，
    // 后面的输入照旧被"她在等人"那道门拦下（design §4.21）。
    this.settleGrants();
    // 话痨会话的话题（v32）：门槛在里面（未读 ≥ 5 且距上次 ≥ 10 分钟），不满足时**不发请求**。
    // 同样放在 busy 之前：她正忙的时候恰恰是群里聊得最热的时候，而那时她最需要"在聊什么"。
    //
    // **群里发生提及（@ 或喊她的名字）时门槛让路**（2026-10-02 用户的口径）："发生提及、at 的时候，
    // light 模型会先审计积累消息，然后给出话题 peek，然后告示进入对话流告知 agent"——
    // 提及是"有人在叫她"，这时哪怕只攒了一两条也要给一句"那边在聊什么"，
    // 否则她只能看见被叫的那一句、看不见上下文。
    await this.summarizeChattySessions(this.mentionSidOf(this.deps.projection.pending));
    // ── 手上有活就整拍让路（2026-10-11 修的重叠缺口：置位提到**判据紧邻处**）──
    //
    // 这里原来是"先 await 完 prepare 四件事，再判 busy、再置位"，于是检查与置位之间隔了
    // 四个 await。`setInterval` 到点即 `void this.tick()`，只要某拍被其中一个 await 拖过
    // `pollMs`，下一拍就会在 **busy 还是 false** 的时候重入并一路走到 `runTurn`
    // ⇒ 两个 turn 同时跑（现场：turn 1277 的双实例，见 {@link tickInFlight}）。
    // 现在判据与置位**紧挨着、且在任何 await 之前**，中间再没有让出点。
    // 这与 `tick()` 的 tick 级守卫是**两层**：那一层防"同一拍重入"，这一层防"turn 并存"。
    //
    // **代价（照实写）**：她正忙时下面这四件事这一拍不办，等下一次不忙的拍补办——
    //   · `maybeSnapshot`：快照纯由投影推导，晚一拍写字节完全相同（`:2791` 自己还有
    //     "同一天/满 N 条才写"的门，跳过不改变"会不会写"）；
    //   · `settleHumanSuspension`：答复探测与超时判定都是幂等的（`detectAnswer` 从
    //     `humanCursor` 增量扫、`maybeTimeoutHuman` 判 `lastExhausted`），晚判一拍只让
    //     "重投"和"超时"晚一拍落地；
    //   · `handleSlashCommands`：指令不唤醒 turn，晚一拍执行等于"她说完这轮再压上下文"
    //     （`/compact`、`/handoff` 的语义本来就是"现在压"，不抢这一秒）；
    //   · `admitWake`：**它只判不认领**（`:1990`，全程没有一处消费 pending），跳过它
    //     唯一的后果是这一拍不开新 turn——而 busy 时本来也不允许开。
    //
    // ★ **"四件事会不会丢输入"的结论：不会，没有一件需要就地补最小保护。** 判据一处：
    //   从 pending 里**摘除**的唯一写入点是 `input/claimed`（`state/fold.ts:282`
    //   `p.pending = p.pending.filter(...)`），而它只由"turn 已经开起来了"的两条路写
    //   ——`agent-loop.ts:1663 claimInput`（turn 开头）与 `:1686 claimInterruption`（轮中插话）。
    //   这四件事里没有任何一件写 `input/claimed` 或 `input/dead-letter`（`fold.ts:309` 是
    //   pending 的另一个出口，同样不在这四件里），所以它们**没有"跳过即丢失"的能力**：
    //   跳过只是把"这一拍本来会做的推导/派发"推迟到下一次不忙的拍，pending 原样留着。
    //   （`claimInput` 只在 turn 内被调，而 busy=true ⇒ 本拍根本不会开 turn ⇒ 不存在
    //    "这一拍跳过了认领、输入还在队列里"这种漏接。）
    if (this.busy) return;
    this.busy = true;
    try {
      // 快照判定放在输入处理之前：空转拍也能落每日快照
      await this.maybeSnapshot();
      // 人审挂起（design §4.21）：答复到位就把挂起时认领的输入送回队列（本拍就能接着跑），
      // 超过时限则按预算耗尽同等语义进入可恢复暂停。
      await this.settleHumanSuspension();
      const p = this.deps.projection;
      if (p.pending.length === 0) return;
      // ── 人打的指令（B1 第二步：`/compact` 与 `/handoff`）──
      // 放在攒批门与唤醒门**之前**：指令是框架自己就能办的事（收紧她的上下文 / 写一份交接笔记），
      // 既不该被群消息的攒批窗口压住，也不该被预算暂停拦住——**撞上限时人恰恰更需要它**。
      // ⚠ `/stop` **不在这条路上**：它更早（入口就掐流、清队列、落留痕），
      //    而且 `handleSlashCommands` 里明确把它挡在外面（见那里的注释）。
      await this.handleSlashCommands();
      // 指令已把队列里那几条摘走（input/claimed），可能这一拍就没别的可做了
      if (p.pending.length === 0) return;
      // 群消息攒批（design §4.24）：单聊每句都看，群聊攒够窗口再一起看
      if (this.holdsGroupBatch(p)) return;
      if (!(await this.admitWake())) return;
      // 空拍第二拍 ⇒ 提醒一次"可以进行自我整理"（2026-10-20 用户裁决）。
      // **必须落在下面取 `batch` 之前**：这样那条 note 与这一拍的心跳被**同一轮**认领，
      // 不额外多花一次请求（理由见 `remindSelfOrganizeIfDue` 的方法头）。
      this.remindSelfOrganizeIfDue();

      const batch = p.pending.slice(0, BATCH_LIMIT);
      // 本批开跑前的位置：挂起因时用它把「刚刚落库的 turn/start」读回来（编号不靠猜）
      const beforeSeq = p.lastSeq;
      // 每日记忆整理：机制动作，不走模型 turn（design §4.17）
      const maintainWake = this.memoryMaintainWake(batch);
      if (maintainWake !== null) {
        await this.runMemoryMaintain(maintainWake);
        return;
      }
      const wakeEvents = batch
        .map(item => this.deps.log.get(item.wakeSeq))
        .filter((e): e is AppEvent => e !== null);
      if (wakeEvents.length === 0) return;
      // 会话簿增量（v32）：扫到水位为止，把两种通道事件与已读位都并进去。放在这里而不是
      // 只挑本批的 wakeEvents——见 sessionBook 字段上的注释（只记账的那些永远不会被认领）。
      // 它同时保证了"本批 she 要看的未读"已经算进去（这批之前的事件早在那几拍就并过了）。
      this.foldChannelEvents();
      // 回投目标绑定到本批：仅当这批里确实有通道消息时才拥有回投地址（M9）
      this.wakeChannelData = lastChannelWake(wakeEvents);
      // 注入判定（v32）：**在本轮之前**跑完并落事件——渲染层是纯函数，它只能读事件；
      // 而且"当时提示过她什么"必须可复盘。有风险才写事件，没风险一个字都不写。
      // turn 号此刻还没分配（agent-loop 在自己的 runInner 里才定），所以挂 0——
      // 与 `channel/injection-judge.ts` 的记账同一口径：这条账的用途是观测 light 用量，不是 turn 归属。
      await this.judgeChannelWakes(wakeEvents, 0);
      // 示警落库（v25）：把"框架对她说了这句话"记成事件——GUI 卡片原样贴它，此刻层那段
      // 历史数它，而"她到底看没看见"从此是可查的事实（而不是靠推断渲染时拼了什么）。
      this.noteInjectionWarnings(wakeEvents);
      // **数字资产那一行没有了**（v45，2026-10-09 用户拍板取消「light 选取资产」这条机制）：
      // 这里原来是 `prefetchAssetsLine(wakeEvents)`——轮首读 `MEMORIES/assets.md`、把索引喂给
      // light 挑 ≤3 条、渲染成任务卡上那行「本任务相关资产：…」。理由与替代（她自己照清单读）
      // 写在 `persona/assets.ts` 的文件头；`MEMORIES/assets.md` 一个字节都没动，事实层照旧。
      // 维护窗口（2026-10-11）：**在装配 deps 之前**把这一轮的那一条定下来。
      // 位置在"输入已经认领、turn 号还没分配"那一段之后——它读的是日志里的既有事实
      // （上一条 `compaction/decision` 与投影里的空拍数），而不是本轮还没发生的事。
      //
      // 为什么不放在 `prepareTurn` 更前面：`this.eventView` 是 `mcpIndexSync` 每拍定下的那份
      // **本拍事件快照**（上面那一行已经跑过），放在这之后读到的才是"本拍照旧的事实"，
      // 也才不必自己再全量读一遍日志（那是一次真实的磁盘往返）。
      this.maintenanceWindowNow = this.maintenanceWindowFor();
      let reason: TurnEndReason;
      // 慢拍刻度（BUG-4）：先把上一轮的读数清掉，再量这一轮。**存的是"这一轮"**，
      // 所以 `runtime/slow-tick` 里那几格永远对得上它自己那一段（见 lastTurnTiming 的注释）。
      this.lastTurnTiming = null;
      this.lastTurnMs = 0;
      const turnStartedAt = Date.now();
      try {
        reason = await runTurn(this.agentDeps(wakeEvents), wakeEvents);
      } finally {
        // 无论如何都解绑：下一轮的 speak 不能再回到这一轮的会话里去。
        // 插话计数**不清零**（它只增不减，speak 每次开口时重新取基准值）。
        this.wakeChannelData = null;
        this.userSpokeNote = null;
        // **急停那一格也是本轮的**：它只在"这一轮被用户掐掉"时有意义。
        // 不清的后果很具体：下一次关机（`signal` 取消）会被误判成用户急停，
        // 于是输入被作废而不是退回队列——那是"关机后活丢了"。
        this.stoppedByOwner = false;
        // 计时在 finally 里收口：整轮抛错时这一段照样是"这一拍照它耗了多久"的事实
        // （那种拍的 `compactMs` 仍为 0——收尾根本没跑到，如实缺席，不编一个数）。
        this.lastTurnMs = Date.now() - turnStartedAt;
      }
      this.write(`[循环] turn 结束：${reason.kind}`);
      // 压缩之后**叫醒她一次**（`wake/manual` · `via: 'compact'`，2026-10-09）：压完不叫，
      // 那份交接笔记要等到下一次有人说话才被看见，而"手上没做完的事"就是在这段时间里断掉的。
      // 放在 turn 结束之后、**且不 return**：它是把一条输入放进队列（下一拍起 turn），
      // 本拍剩下的收尾（挂起线索、安静计时、预算告警）一条都不许跳过。
      await this.handleCompactionWake(beforeSeq);
      // 成本告警（2026-10-22，用户：「缓存未命中在暴涨，框架没有任何警告」）：**前兆**（思维链
      // 回传顶到上限）与**结果**（最近 20 轮未命中率相对基线恶化）一次判完，最多叫醒她一次。
      // 位置与 `handleCompactionWake` 并列、**都在 turn 收尾之后**：这一轮新写的事件此刻已经落库，
      // 判据才看得见"刚刚这一轮多贵/多满"。它**不 return**：本拍剩下的收尾一条都不许跳过。
      await this.handleCostAlerts();
      // 人审挂起（design §4.21）：turn 因提问/计划审批而挂起（不是完成、也不是失败）——
      // 记下这条线索。输入已被 input/claimed 摘走，等 human/answered 到达后送回队列。
      if (reason.kind === 'blocked' && reason.by === ASK_HUMAN_BLOCKED_BY) {
        await this.noteSuspension(batch, wakeEvents, beforeSeq);
      }
      // 处理完一批真实事件 = 发生过活动：安静计时复位。心跳批次不复位，概率才长得起来。
      if (wakeEvents.some(event => event.type !== 'wake/heartbeat')) this.heartbeat.noteActivity();
      if (reason.kind === 'budget-exhausted') await this.notifyBudgetExhausted(reason.layer);
      // 思维链没回传的 400（2026-10-17）：与上面那条**同一个处置时机**（turn 收尾之后）、
      // 同一个告警出口。判据是循环层落的指纹（`turn/end.reason.reasoningEcho`），这里不重判。
      // 为什么它非报不可：这条路两个现成刹车都到不了，详见 `notifyReasoningEcho` 的注释。
      if (reason.kind === 'error' && reason.reasoningEcho === true) await this.notifyReasoningEcho(reason);
    } finally {
      try {
        await this.deps.onTurnBoundary?.();
      } catch (error) {
        this.write(`[插件] turn 边界应用失败：${error instanceof Error ? error.message : String(error)}`);
      }
      this.busy = false;
    }
  }

  /**
   * 跑一拍，**并且保证同时只有一拍在飞**（2026-10-11，P1：tick 重叠保护）。
   *
   * ──────────────────────────── 为什么需要这一层 ────────────────────────────
   * `start()` 用的是 `setInterval(() => { void this.tick().catch(...) }, pollMs)`——发射后不管。
   * 原来这里只判 `running`（`:1218`，只有 `stop()` 会置 false），**不判"上一拍还在飞"**。
   * 于是一拍只要跑过 `pollMs`（默认 1000ms），下一拍就叠上来。
   * 而这一拍真的会跑很久：写一次快照是几百 MB 量级（见 `:1933` 那条实测口径
   * "**单次 98.4 MB 堆增量 / 500 ms**"）、`detectAnswer` 要增量扫日志、
   * `handleSlashCommands` 有真 I/O、预算告警要投递。
   *
   * 现场（本机 16:40–16:45，事件 seq 74122–74414，`data/events/000000074108.jsonl`）：
   * 两条 `turn/start turn=1277`、turn 1277 的 13 个 step **每个都有两份** `step/start`/`step/end`、
   * `read_channel` 在同一步里被调两次且**全部 10s 超时**、turn 号被复用、输入被重复认领。
   * 两个实例各自 `executeToolCalls` ⇒ `exclusive` 只在自己那一份里成立（它是**每轮内**的语义），
   * 所以"两个 read_channel"正是这么来的。
   *
   * ──────────────────────────── 为什么守卫必须在**最前面** ────────────────────────────
   * 不能只在 `busy` 那一处加锁：`busy` 的检查与置位之间原本隔着 prepare 段的 await
   * （那段缺口已由 `tickOnce` 里的"判据紧邻置位"补上，是另一半）。这一层要挡的是
   * **连 `tickOnce` 都不许重入**——包括它开头那些"放在 busy 之前、刻意每拍都做"的事
   * （`settleHumanAsks`/`settleGrants`/话痨话题/附件预热），那些也会重入并重复落事件。
   * `tickInFlight` 在**任何 await 之前**同步置位，所以它是真正的原子互斥，没有 TOCTOU 窗口。
   *
   * `tickOnce` 保持 public 且不受守卫影响：测试与宿主手工驱动它时行为与从前**逐字相同**
   * （全仓只有这一处调它，见 `:1757` 的旧口径与 `start()` 的定时器）。
   *
   * ──────────────────────────── 慢拍观测 ────────────────────────────
   * 一拍用满 `pollMs` 就落一条 `runtime/slow-tick`（internal，不进她的上下文，零缓存代价）。
   * 字段：`elapsedMs` 本拍耗时 · `pollMs` 判定用的预算 · `skipped` 本拍期间被吞掉的拍数 ·
   * `busy` 收尾时手上还有没有活。**`skipped` 就是"当时在飞数"的实测替身**：守卫生效后在飞
   * 必然恒为 1，所以有信息量的是"这一慢拍压掉了几拍"——它正是重叠发生过的证据。
   * 写成 internal 而不是 model 是刻意的：它是**框架的账**，不是对她说的话。
   */
  private async tick(): Promise<void> {
    if (!this.running) return;
    // 上一拍还在飞：这一拍整拍丢掉，只记一笔。丢拍是安全的——下一拍会把所有推导重做一遍
    // （判据与理由见 `tickOnce` 里那段"四件事跳过的代价"）。
    if (this.tickInFlight) {
      this.tickSkipped += 1;
      return;
    }
    this.tickInFlight = true;
    const startedAt = Date.now();
    const completion = this.tickOnce();
    this.tickCompletion = completion;
    try {
      await completion;
    } finally {
      if (this.tickCompletion === completion) this.tickCompletion = null;
      // try/finally：`tickOnce` 抛错也一定复位，否则一次异常就把循环永久锁死
      // （外层 `start()` 的 `.catch` 只管报错，不会复位任何标志）。
      this.tickInFlight = false;
      const elapsedMs = Date.now() - startedAt;
      const skipped = this.tickSkipped;
      this.tickSkipped = 0;
      if (elapsedMs >= this.pollMs) {
        try {
          // 刻度（BUG-4）：`turnMs` 为 0 = 这一拍没跑过模型那一轮（prepare / 快照 / 指令那几段），
          // 那种拍的耗时全在 prepare 那一侧；`compactMs` 是 `turnMs` 的**子集**，
          // `events` 是收尾那几个同步扫描的规模输入（读法与口径写在 lastTurnTiming 上）。
          const timing = this.lastTurnTiming;
          const turnMs = this.lastTurnMs;
          this.appendSync('runtime/slow-tick', {
            elapsedMs, pollMs: this.pollMs, skipped, busy: this.busy,
            turnMs,
            // 这一拍没跑过模型那一轮（prepare / 快照 / 指令那几段）⇒ 三格如实为 0：
            // 那种拍的耗时**全在 prepare 那一侧**，不许拿 `elapsedMs` 冒充满 `turnMs`。
            compactMs: timing?.compactMs ?? 0,
            events: timing?.events ?? 0,
            // 事件的**读数口径**与总水位：`events` 是本 runner 可见的那一份快照（子代理链与
            // slash 指令那两类被 eventFilter 挡掉），所以两者一起看才知道这个数是不是全部。
            ...(timing === null ? {} : { eventsThroughSeq: timing.eventsThroughSeq }),
          }, 'internal');
        } catch {
          // 观测不许反过来打断循环：这条账丢了不影响任何判据（它不是承诺类事实）
        }
      }
    }
  }

  // ──────────────────────────────── MCP 常驻索引（v46） ────────────────────────────────

  /**
   * **MCP 常驻索引的快照同步**：把"这一版索引是什么"定下来，并落一条 `mcp/index`。
   *
   * ──────────────────────────── 它解决的是什么 ────────────────────────────
   *
   * 用户 2026-10-10 的设计原话（逐字）：「虽然有了入口，但是**还是需要有对应的索引存在**。
   * **mcp 的存在类同 skill**。不过**入口不是自己读而是我们的统一 mcp 工具**。」
   * 「**增删进入上下文的方式依然还是。追加在末，固定位置，直到上下文重大变化时归集到
   * 正确的索引位置。**」
   *
   * 索引本身由 `render` 摆进**长期记忆层**（与技能 catalog 同段素材、紧挨着它）。
   * 这里管的是**它什么时候变**——这一格错了，整套设计就反过来了：
   * 若渲染时每轮从实时配置现渲染，那么"加一个 server"会**立刻改掉请求前缀**
   * （KV 缓存整段失效，本仓库实测口径 ≈9.6 万 token 一轮），而用户的意图恰恰是
   * "增删只追加在末尾，到重大变化点才归集"。
   *
   * ⇒ **索引必须冻结**：渲染读的是日志里那条快照，而快照只在下面四个点上重建。
   *
   * ──────────────────────────── 四个重建触发点（判据） ────────────────────────────
   *
   * ① **本进程至今没有快照**（老日志、或全新的数据目录）——进程启动就是一次"重大变化"：
   *    它改了渲染模板之外的运行时事实，而**绝大多数配置字段仍然要重启才生效**
   *    （`config/watcher.ts` 的热更白名单今天只有一项 `mcp.servers`，见下），所以
   *    "配置不动的那段时间"大体上等于进程的生命周期；进程一开始定下的索引，在这一整段里
   *    都代表现状。
   * ② **模板换代**：最后一条快照的 `version` ≠ 当前 `RENDER_VERSION` ⇒ 旧字节与当前模板
   *    不是同一把尺子（那一天本来就是一次缓存全 miss，见 `render.ts` 的 v46 那一篇）。
   * ③ **上下文重大变化**：最后一条快照的 seq **早于**最后一条 `compaction/summary`
   *    ——自动压缩与界面 reset（`/api/...` 的 reset，`web/server.ts` 也写这个事件）都算。
   *    这一刻才是用户说的"归集到正确的索引位置"：用**当前配置**重建索引，
   *    此前那些"尾部追加"（server 增删的通报）就自然被新索引覆盖了语义
   *    ——它们在历史里逐字节不动（append-only），只是不再是"唯一知道有它"的那一处。
   * ④ **插件组合变化**（`deps.pluginRevision`，那一格的注释写着它为什么必须在）：
   *    插件隔离/恢复/卸载会**从执行面撤走** MCP server，而声明面只是跟着变——声明面自己
   *    不是触发点（理由与配置热更逐字相同，见下一段）。这一支与热更有一处**本质区别**：
   *    被撤走的 server 已经**不能调用**了，索引却还写着它 ⇒ 模型对着池里不存在的名字
   *    发起调用（"幽灵 server"）。所以组合摘要一变就重建，不等压缩点。
   *    ⚠ 判据是"摘要 ≠ 上次建索引时记下的值"，而那一格必须在**重建当下**就更新
   *    （`pluginRevisionSeen`，与 `skillIndexSync` 的 `skillPackageRootsRevision` 同形）；
   *    忘了更新，同一份新摘要会每拍都判"过期"⇒ 每拍重建一次索引，缓存保护当场作废。
   *
   * **配置改动刻意不是触发点**（`mcp.servers` 热更之后这条判据**照旧成立，而且是刻意的**）：
   * 它不落 `compaction/summary`。热更把活配置就地改了 ⇒ 本方法读到的 `servers` 立刻是新值，
   * 但**索引的字节仍然冻结在快照上**——这正是用户要的那条："增删进入上下文的方式依然还是。
   * 追加在末，固定位置，直到上下文重大变化时归集"。所以热更那一刻**不会**重建索引
   * （重建 = 每轮改请求前缀 = 缓存整段失效，判据见 `config/watcher.ts` 的 `HOT_RELOAD_FIELDS` ①）。
   * 真正会让索引变的是**下一次重大变化**（③）与**重启**（①）。
   *
   * ⚠️ 一处已知的**行为边界**（热更带来的，写在明处）：如果**这个进程从来没写过快照**
   * （`point.seq === 0`，例如 `servers` 原本为空 ⇒ 按下面"空索引"那一节的口径，
   * 之后又在运行期热更加了一个 server），那么下一次 `mcpIndexSync` 会把它当成"首次"落一条
   * `mcp/index`——那一次就是一次请求前缀变化（与重启后首次落快照**同一个代价**）。
   * 不是热更独有的病（重启也走这条路），但热更让它更容易被碰上：**加第一个 server 时**
   * 若不想付这一笔，就在加之前先重启一次（那时会在启动期落好快照）——**未实测**，
   * 依据是这三条判据本身。
   *
   * ─────────────────── 空配置：**首启不写，从非空变空要写墓碑**（这一条有测试钉着） ───────────────────
   *
   * "空索引"是两种形状，判据必须分开：
   *   • **从来没有过快照**（`point.seq === 0`）：`servers` 为空 ⇒ 索引段整段不出现 ⇒
   *     "空快照"与"没有快照"在渲染上**逐字节等价**（都渲染成空）。此时写一条 `mcp/index`
   *     只会在事件流里多一行没人读的东西，却会让"事件序列逐字相同"那类基线
   *     （`test/heartbeat-real-wake.test.ts`）无故变红 ⇒ **不写**，缓存照旧置空串。
   *   • **从非空变空**（`point.seq !== 0 && point.text !== ''`）：这一支**必须写**一条
   *     `text: ''` 的墓碑快照。不写的话，重建（`replay` 的 `mcpIndexOf`）读到的是上一条
   *     非空快照——同一个执行面撤走全部 server 之后，"实时请求里已经没有它、重建又把它
   *     请回来"——同一份日志重建出两份不同的请求，而 append-only 日志的全部意义就是那条承诺。
   *   写完墓碑之后下一拍 `point.text === ''` ⇒ 不会再写，不会每拍刷事件。
   *
   * 返回"这一拍定下的文本"，便于测试直接断言（生产调用点不需要它）。
   */
  /**
   * **本轮那条维护窗口信号**（2026-10-11）——判据在 `render.ts` 的 `maintenanceWindowOf`（纯函数），
   * 这里只负责把**四样材料**凑齐（时钟、事件、投影、时区都在宿主手上，渲染层一样都拿不到）。
   *
   * ## 四样材料，各自为什么从这里取
   *
   *   ① **压缩临近**：读**上一条 `compaction/decision`** 的 `historyTokens` / `thresholdTokens`
   *      （`lastCompactionReading`）——它与压缩判定**同源**（同一个 `estimateHistoryTokens` 的
   *      结论），所以"她说 79%、框架说 81%"这种两套数不会出现。
   *      ⚠ **刻意不在这里现算一遍**（那要把整份事件快照扫一次）：那位用户点名要治的毛病就是
   *      "反复读已经知道的东西"，而 `historyTokens` 每轮收尾**已经算过一次并落了账**。
   *      代价是它读数最多旧一轮（那一轮之后新长出来的历史还没计入）——这是**保守**的那一侧：
   *      只会让窗口晚一拍出现，不会让它提前。
   *   ② **凌晨**：`localHourOf(deps.now(), timezone)` ——与此刻层 `时刻：` 那一行**同一把尺子**
   *      （同一个 `Intl` 口径），"现在几点"与"现在是凌晨"不会各说一套。
   *   ③ **长时间空拍**：`projection.idleTicks`（每命中一拍心跳 +1，任何外部事件到达即归零）。
   *   ④ **上一次窗口是什么时候**：`lastMaintenanceWindowAt(this.eventView)`——从日志里读回来，
   *      不是记在内存里（重启后内存那份就没了，而那道 6 小时的闸恰恰要跨重启成立）。
   *
   * ## 它不是每拍都算（一次都不多算）
   *
   * 它**一轮只算一次**（在装配 deps 之前那一行），而且那两处日志扫描（`lastCompactionReading` /
   * `lastMaintenanceWindowAt`）都是**顺着本拍已经读进来的那份快照走一遍**——不额外读盘、不额外
   * 全量扫（`mcpIndexSync` 每拍已经付过那一次）。与"反复读已经知道的东西"这条毛病正相反：
   * `historyTokens` 本来就是每轮收尾算过一次的结论，这里只把它**读回来**。
   *
   * 失败方向：任何一样材料读不出来（`now` 非法、时区名坏掉）⇒ 少一条窗口，绝不抛错
   * ——它是提示，不是判据，不该有能力打断一轮。
   */
  private maintenanceWindowFor(): MaintenanceWindowNote | null {
    try {
      const now = this.deps.now();
      const nowMs = now.getTime();
      if (!Number.isFinite(nowMs)) return null;
      const local = localHourOf(now.toISOString(), this.deps.timezone);
      // 压缩那一条的两个数：**读上一条 `compaction/decision`**（同源，见方法头 ①）
      const reading = lastCompactionReading(this.eventView);
      const idle = this.deps.projection.idleTicks;

      return maintenanceWindowOf({
        historyTokens: reading.historyTokens,
        compactionThresholdTokens: reading.thresholdTokens,
        localHour: local?.hour ?? null,
        localDay: local?.day ?? null,
        idleTicks: typeof idle === 'number' && Number.isFinite(idle) ? idle : null,
        lastWindowAtMs: lastMaintenanceWindowAt(this.eventView),
      }, nowMs);
    } catch {
      // 提示算不出来就**当没有窗口**（不抛）：它与 `usageAlert` / `machineLine` 同一条纪律——
      // 此刻层宁可少一行，也不许把这一层搞脏。
      return null;
    }
  }

  async mcpIndexSync(): Promise<string> {    // ── **共用那份增量快照，不自己再 `readAll()` 一遍**（2026-10-10 修） ──
    //
    // 这条路径原来每一拍都 `for await (…) log.readAll()` 把**全量**日志折进一个**新数组**。
    // 实测代价（`_research/probe-tick-churn.mts`，7.4 万条 / 59 MB）：
    // **单次 98.4 MB 堆增量 / 500 ms**；而 `pollMs = 1000`（`:910`）⇒ tick **每秒一次**
    // ⇒ 每秒白造 ~98 MB 垃圾。连打 10 拍堆就到 459 MB（探针里还没有并发）。
    //
    // 为什么这会要命：V8 **把堆还给 `heapUsed`、不还给系统**
    // （`_research/probe-v8-retention.mjs`：持有 ~600 MB 再全释放 + GC ⇒ heapUsed 4 MB、
    // **RSS 仍是 1174 MB**）。于是每秒一次的 98 MB churn 把 **RSS 高水位**一路顶上去
    // —— 真实事故：带上限 512 MB 的那一轮 **167 秒就 OOM**（当时日志里只有 225 条事件、
    // 0.1 MB，事件本身完全解释不了那 1.8 GB）。
    //
    // 修法是**只有一份**：`state/event-snapshot.ts` 按 `EventLog` 实例缓存已 parse 的全量事件、
    // 之后只读 `latestSeq()` 之后的增量。单拍成本从 98.4 MB/500 ms 降到"几条新事件"。
    // `web/server.ts` 那八条只读端点读的是**同一个函数**（那份缓存是 2026-10-10 早先为它们加的）。
    const events = await allEventsOf(this.deps.log);
    // 这一份**留给同一拍后面的人用**（`settleGrants`）：它必须在同步段里跑完，不能自己再读一遍
    // 全量日志（那是一次真实的磁盘往返，而这里每拍已经付过一次了）。
    // 它只是"本拍看到的事件快照"——写入点仍然是日志，这里**只读**，谁也不许就地改它。
    this.eventView = events;
    const point = mcpIndexOf(events);
    const version = RENDER_VERSION;
    // 插件组合摘要**只读一次**：判据、重建原因、记下的水位必须是同一个值
    // （宿主那一格是活引用，两次调用之间可能已经变过）。
    const pluginRevisionNow = this.deps.pluginRevision?.();
    // 水位**先按日志里那一条快照对齐**（2026-10-26 修）：`pluginRevisionSeen` 初值是
    // `undefined`，而零插件的实例给的是空组合的 sha256（`e3b0c442…`）⇒ 两者永远不等，
    // 于是**每一次进程启动**都会判一次 stale、写一条字节完全相同的事件，诊断行还写着
    // 「插件组合变化（无 → e3b0c442）」——那是在报一件没发生的事。凭什么把"重启后第一次"说成
    // "组合变了"：重启不改组合，只有装/卸/启/停才改。
    // 对齐之后，第一次启动仍会因别的判据重建（version/descClauseVersion/coveredSeq 任一不成立），
    // 但原因会如实写成那一条；只有**真的**换了组合才报「插件组合变化」。
    if (this.pluginRevisionSeen === undefined && point.seq !== 0) {
      this.pluginRevisionSeen = point.pluginRevision;
    }
    // 两条"该重建"的判据**分开**（判据与理由写在 `MCP_INDEX_DESC_CLAUSE_VERSION` 的注释里）：
    //   • version 换代 ⇒ 渲染模板变了（请求体可比性变了）；
    //   • 行模板版本换代 ⇒ 这一行怎么拼变了。它**只重建一次**：重建出来的快照带着当前值，
    //     下一拍这条判据就不成立了。若把这两条合成一条（只认 version），这一版的生命周期里
    //     "快照 version ≠ 当前 RENDER_VERSION"会**一直**成立 ⇒ 每拍重建一次索引。
    const stale = point.seq === 0
      || point.version !== version
      || point.descClauseVersion !== MCP_INDEX_DESC_CLAUSE_VERSION
      || point.seq < point.coveredSeq
      // 插件组合换了一批 ⇒ 执行面上那几个 server 已经不在了（判据见方法头 ④）
      || this.pluginRevisionSeen !== pluginRevisionNow;
    if (!stale) {
      this.mcpIndexText = point.text ?? '';
      return this.mcpIndexText;
    }
    // 判据一过就记下这一次看到的组合摘要（与 `skillIndexSync` 的 `skillPackageRootsRevision`
    // 同形）：重建之后无论写没写事件，这件事都已经"看过"了 ⇒ 下一拍不该再为它重建一次。
    const pluginRevisionBefore = this.pluginRevisionSeen;
    this.pluginRevisionSeen = pluginRevisionNow;

    const view = mcpIndexView(this.deps.mcpDeclarations?.() ?? this.deps.config.mcp.servers, this.deps.dataDir);
    // 空索引分两种形状（判据见方法头"空配置"那一节）：首启不写；**从非空变空必须写墓碑**
    // ——否则重建会读到上一条非空快照，把已经被撤走的 server 请回请求里。
    if (view.text === '') {
      if (point.seq !== 0 && (point.text ?? '') !== '') {
        this.appendSync('mcp/index', {
          version, text: '', servers: [],
          descClauseVersion: view.descClauseVersion,
          ...(pluginRevisionNow === undefined ? {} : { pluginRevision: pluginRevisionNow }),
        }, 'internal');
        this.write('[MCP] 常驻索引已清空：声明面里已经一个 server 都没有');
      }
      this.mcpIndexText = '';
      return this.mcpIndexText;
    }
    this.appendSync('mcp/index', {
      version, text: view.text, servers: view.servers,
      // 行模板版本一起落（缺这一格的老快照按 0 算 ⇒ 该重建一次，见那个常量的注释）
      descClauseVersion: view.descClauseVersion,
      // 插件组合摘要（只可观测：排障与重放比对用，不参与渲染字节）
      ...(pluginRevisionNow === undefined ? {} : { pluginRevision: pluginRevisionNow }),
    }, 'internal');
    this.mcpIndexText = view.text;
    const reason = point.seq === 0
      ? '首次（日志里还没有快照）'
      : point.version !== version
        ? `模板换代（快照是 v${point.version ?? '?'}）`
        : point.descClauseVersion !== MCP_INDEX_DESC_CLAUSE_VERSION
          ? `索引行模板换代（快照是第 ${point.descClauseVersion} 版，当前第 ${MCP_INDEX_DESC_CLAUSE_VERSION} 版——这一版给行里补了"它是干什么的"那一截）`
          : pluginRevisionBefore !== pluginRevisionNow
            ? `插件组合变化（${shortRevision(pluginRevisionBefore)} → ${shortRevision(pluginRevisionNow)}）`
            : '上下文重大变化后归集';
    this.write(`[MCP] 常驻索引已重建（${reason}）：${view.servers.length} 个 server，`
      + `${view.servers.filter(row => !row.disabled).length} 个启用`);
    return this.mcpIndexText;
  }

  /**
   * **技能常驻索引的快照同步**（2026-10-11）：把"这一版技能索引是什么"定下来，并落一条 `skill/index`。
   *
   * 用户这一轮的判据（逐字）：「skill 索引的进入和退出也要有类似 mcp 的进入和退出那样的
   * 缓存保护的机制」。这一格因此是 `mcpIndexSync` 的**逐条同形**版本：同一拍、同一组触发点、
   * 同一种落库（快照事件）、同一个渲染位置（长期记忆层里技能在前、MCP 紧随其后）。
   * 判据的来龙去脉写在 `mcpIndexSync` 的方法头上，这里只记**技能这一支特有**的三件事：
   *
   *   ① **来源是技能系统自己**：`SkillManager.catalog()`——信任门（`skill/installed`）、单条与总
   *      token 预算、截断全在里面，这里一个字节都不重拼。由此有一条重要推论：**只有过了信任门
   *      的技能才进得来** ⇒ 她"申请了但人还没批"的技能连候选都不是（"批准前不生效"落在这里）。
   *   ② **"技能目录变了"刻意不是触发点**（与"配置改了不是 MCP 索引的触发点"逐字同回事）：
   *      增删技能在上下文里的样子是**尾部追加**（申请单结局那条 `wake/manual{via:'grant'}`，
   *      正文里明说"索引不会立刻改字节"），到**下一次归集**（压缩 / reset / 重启）才把那一行
   *      进到索引里。在这一格按"目录变了"重建，就等于每装一个技能改一次请求前缀
   *      ——缓存保护等于没做（那正是用户这一条要治的毛病）。
   *   ③ **空索引分两种形状**（与 `mcpIndexSync` 同一条口径）：从来没有过快照
   *      （`point.seq === 0`）时不写——一个可用技能都没有时该段整段不出现，空快照与
   *      「没有快照」在渲染上逐字节等价，写它只会在事件流里多一行没人读的东西、让
   *      「事件序列逐字相同」的基线无故变红；而**从非空变空**时必须写一条 `text: ''` 的
   *      墓碑快照——不写的话，重建（`replay` 的 `skillCatalogForReplay`）读到的仍是上一条
   *      非空快照，「实时请求里已经没有了、重建又把它请回来」——同一份日志重建出两份不同的
   *      请求，重放的基础约束当场作废。
   *   ④ **「构建文本 + 写事件」不在这个方法里**（2026-10-23 抽出）：唯一一份实现在
   *      `skill/index-snapshot.ts` 的 `writeSkillIndexSnapshot`——人工归集（`irmia skill
   *      reindex`）走的是同一份，于是两条路写下的快照**逐字段相同**。这一格只负责
   *      「什么时候该重建」（上面那几条判据）与「怎么落库」（`appendSync`）。
   *      那一格正是为「信任表已修好、快照却停在旧字节上」的事故留的人工入口：此时上面几条
   *      判据一条都不成立（version 一致、seq 不小于 coveredSeq、日志里已有快照）⇒
   *      **重启也不会重建**，只能等下一次压缩摘要。
   *   ⑤ **插件技能根换代**（`SkillManager.packageRevision`）：插件的技能根被撤走/换上之后
   *      同一拍就要重建——否则索引里还列着已经读不到的技能名。
   *
   * ⚠ 它**必须排在 `mcpIndexSync` 之后**（两个调用点都是这样：`warmUp` 与 `tickOnce` 的轮首）：
   * 事件快照 `eventView` 由那条先跑时读下，这里只读它、不再自己读一遍盘。
   *
   * 返回"这一拍定下的文本"，便于测试直接断言（生产调用点不需要它）。
   */
  async skillIndexSync(): Promise<string> {
    const point = skillIndexOf(this.eventView);
    const version = RENDER_VERSION;
    // 与 `mcpIndexSync` 的 `stale` 同形，另加插件 Skill 根版本：根变化必须在下一拍重建
    const stale = point.seq === 0
      || point.version !== version
      || point.seq < point.coveredSeq
      || this.skillPackageRootsRevision !== (this.skills?.packageRevision ?? 0);
    if (!stale) {
      this.skillIndexText = point.text ?? '';
      return this.skillIndexText;
    }
    this.skillPackageRootsRevision = this.skills?.packageRevision ?? 0;

    // 信任门的真相源是日志：重建**之前**把**还没折过**的 `skill/installed` 折进来。
    //
    // 为什么非折不可（2026-10-11 实测的洞）：`applyTrustEvent` 只覆盖**本进程自己写的**那条
    // `skill/installed`（`appendSync` 顺手折）。而"用户批准装技能"那条是 **web 层**写的
    // ⇒ 循环里这张表原先要等**下一次进程启动**才认得它：批准装好的技能即使到了归集点也进不了
    // 索引，表现成"装了、批了、重启才看见"。缓存保护要说的是"下一次归集才改字节"，
    // 不是"要重启才生效"——两件事混在一起，人就分不清是设计还是坏了。
    //
    // 为什么是**增量**而不是 `setTrustEvents(全量)`：归集点可能很密（"空索引"那种退化形状下
    // 每一拍都走得到这条判据），全量重折是 O(事件数)；而信任事件很稀疏，折过一次之后大多数拍
    // 一个新事件都没有。`skillTrustSeq` 记"折到哪一条了"。
    for (const event of this.eventView) {
      if (event.seq <= this.skillTrustSeq) continue;
      this.skills?.applyTrustEvent(event);
      this.skillTrustSeq = event.seq;
    }

    const catalog = this.skills?.catalog() ?? null;
    const snapshot = writeSkillIndexSnapshot({
      events: this.eventView,
      catalog,
      write: (data) => this.appendSync('skill/index', data, 'internal'),
    });
    // 缓存跟着定下（空索引也走这条：`text` 就是空串，与 `mcpIndexSync` 那一支同形）
    this.skillIndexText = snapshot.text;
    if (!snapshot.written) {
      if (snapshot.skipped === 'empty') return this.skillIndexText;
      return this.skillIndexText;
    }
    const reason = point.seq === 0
      ? '首次（日志里还没有快照）'
      : point.version !== version
        ? `模板换代（快照是 v${point.version ?? '?'}）`
        : '上下文重大变化后归集';
    this.write(`[技能] 常驻索引已重建（${reason}）：${snapshot.entries} 个技能进索引，`
      + `${snapshot.pending} 个在等信任门`);
    return this.skillIndexText;
  }

  /**
   * **配置热更之后的循环侧收尾**（2026-10-10 加；宿主接在 `RealLoopDeps.onConfigReloaded` 上）。
   *
   * 它**只做一件事**：如实说清"声明面变了，但索引那一段的字节不动"。
   *
   * 三处刻意不做的（每一处都有判据，别顺手加回去）：
   *   • **不重建索引**（不调 `mcpIndexSync`）：索引按用户定的口径**只在重大变化点归集**，
   *     而"改一次配置"不是重大变化。在这里重建就等于每轮改请求前缀——正是 v46 那一版
   *     花了一整版躲开的那件事（≈9.6 万 token 一轮，见 `config/watcher.ts` 的
   *     `HOT_RELOAD_FIELDS` ①）。她要知道"声明变了"，走的是**尾部追加的通报**
   *     （`wake/manual{via:'mcp'}`，由宿主发；这里只写诊断输出）。
   *   • **不落事件**：热更的事实已经由 `ConfigWatcher` 写成 `config/changed`（internal），
   *     再写一条只是把同一件事记两遍；而 `mcp/index` 是**快照**（语义是"这一刻索引是什么"），
   *     拿它当"声明变了"的通知用会把两件事揉在一起。
   *   • **不叫醒她**（不 `appendSync`）：唤醒的写入点是宿主（`main.ts` 的订阅者）——
   *     那里才知道"这次到底变了哪几个 server 的名字"，而通报的正文要的就是那几个名字。
   *
   * 为什么这一句值得写进日志：热更之后**索引与配置会短暂不一致**（索引还是旧的，配置已是新的），
   * 这是设计内的。不说，读日志的人就会以为"热更没生效"。
   *
   * **预热之前的调用会被存起来**（`pendingConfigReload`）：`warmUp` 的第一件事是按日志重建
   * `mcpIndexText`，而"当前有几个 server"这句话该在它之后说（否则那两行与紧接着的预热日志
   * 会对不上）。存起来 → `ensureReady` 在预热跑完时补写。**不做成 async 排队**：这一格只装
   * 一条通报，而配置重载是串行的（`ConfigWatcher` 的互斥锁），不会有第二条挤掉第一条。
   */
  notifyConfigReloaded(change: ConfigReloadOutcome): void {
    if (this.ready === null) {
      this.pendingConfigReload = change;
      return;
    }
    this.noteConfigReload(change);
  }

  private noteConfigReload(change: ConfigReloadOutcome): void {
    const fields = change.fields.join('、');
    this.write(`[配置] 热更已并入：${fields}（循环这一侧读的是同一份就地改过的 AppConfig，无需重建）`);
    if (change.fields.includes('mcp.servers')) {
      const declarations = this.deps.mcpDeclarations?.() ?? this.deps.config.mcp.servers;
      const enabled = declarations.filter(entry => entry.disabled !== true).length;
      this.write(`[MCP] 声明面已热更（当前 ${declarations.length} 个 server，`
        + `${enabled} 个启用）：**常驻索引那一段的字节保持不变**——`
        + '它按既有快照机制在下一次上下文重大变化（压缩 / reset）或重启时归集；'
        + '此刻要她看见的变化走的是尾部追加的那条通报（wake/manual · via=mcp）');
    }
    if (change.requiresRestart.length > 0) {
      this.write(`[配置] 以下字段仍需重启：${change.requiresRestart.join('、')}`);
    }
  }

  // ──────────────────────────────── 压缩后唤醒（2026-10-09） ────────────────────────────────

  /**
   * **压缩完成之后叫醒她一次**（用户 2026-10-09 的原话：「压缩后，应该也进行一次唤醒。
   * 告知 LLM 刚刚进行了压缩。**如有中断的工作则继续**」）。
   *
   * 为什么必须有这一下：压缩把刚跑完那一轮折进交接笔记、也就是说**她眼前的那段上下文刚被
   * 换掉**。不叫醒，`compaction/summary` 落库之后就是一片安静——那份笔记要等到下一次有人
   * 说话（可能是几小时后的心跳、也可能是一整夜之后）才第一次进她的上下文，而"手上没做完的
   * 事"正是在这段安静里断掉的。这一拍的成本是一次请求；不叫的代价是**一件做到一半的活
   * 停在没人知道的地方**。
   *
   * 走的是**既有那条真唤醒路径**（与 MCP 声明变更同一形状）：`appendSync('wake/manual')`
   * → `applyOne` 折进共享投影 → 主循环下一拍认领 ⇒ 真起 turn、`turn/start` 出现、
   * 正文逐字进当轮请求体。**没有新增唤醒类型**，`main.ts` 一行都不用改。
   *
   * 三处刻意不做的：
   *   • **不接 `noteUserSpoke`**：这不是人开口。接了会把框架通报写成"他刚说「…」"，
   *     还会顺手打断她正在说的话（`/dream` 那条踩过同一个坑，见 `noteUserSpokeEvent`）；
   *   • **本拍不自己起 turn**：认领与开跑都归主循环（`tickOnce` 的输入处理那一段）。
   *     这里再跑一次 `runTurn` 就等于绕过唤醒门（预算暂停、日额度、攒批）自己开一条后门；
   *   • **不 `return`**：调用点在 `tickOnce` 的收尾链中间，提前返回会跳过挂起线索与安静计时。
   *
   * **防抖（不许自己叫自己）**：`compaction/decision` 一 turn 恰好一条（写入点只有
   * `TurnRunner.run` 一处），而这里按 `decision.data.turn` 去重——同一个 turn 只发一次。
   * 于是"唤醒那一拍自己又触发了压缩"这件事最多产生**下下拍**的一次新唤醒，且新唤醒必须
   * 来自**新的** `reason: 'wrote'`：它要求遮蔽点严格前移、折叠真的变小、且新闭合的历史
   * ≥ 一个 recent tail（`RECENT_TAIL_TOKENS`，见 `compactionDecision`）。**刚压完再压**
   * 那一段量出来是 0 ⇒ 必被闸门拦下 ⇒ 不可能自激成环。
   *
   * @param beforeSeq 本 turn 开跑前的位置：只在这个区间里找判定（少了它，上一个 turn 的
   *   `wrote` 会被本拍再读一遍，同一件事叫两次）。
   */
  private async handleCompactionWake(beforeSeq: number): Promise<void> {
    let decision: AppEvent & { type: 'compaction/decision' } | null = null;
    for await (const event of this.deps.log.readRange(beforeSeq + 1)) {
      if (event.type === 'compaction/decision' && event.data.reason === 'wrote') {
        decision = event as AppEvent & { type: 'compaction/decision' };
      }
    }
    if (decision === null) return;

    const key = decision.data.turn;
    if (this.compactWakeTurns.has(key)) return; // 同一 turn 不重复发（防抖；见方法头）
    this.compactWakeTurns.add(key);

    const covered = decision.data.coveredUpToSeq ?? 0;
    const previous = decision.data.previousCoveredUpToSeq ?? 0;
    const note = compactionWakeNote({ turn: key, covered, previous, dataDir: this.deps.dataDir });
    // 正文逐字进 `wake/manual.note`（不是"另写一句摘要"）：日志是唯一真相源，
    // 而"框架当时对她说了什么"要能从日志里原样读回来（与 `injection/noted` 同一条理由）。
    this.appendSync('wake/manual', { note, via: 'compact' }, 'model');
    this.write(`[压缩] 已发一次真唤醒（via=compact，turn ${key}，遮蔽至 seq ${covered}）`);
  }

  // ──────────────────── 缓存未命中率告警（2026-10-22） ────────────────────

  /**
   * **成本告警的两个出口，一次判完**（2026-10-22）：
   *
   *   ⓪ **前兆**：思维链回传字符 / 上限 ≥ 90% ⇒ `model/reasoning-echo{kind:'reasoning_echo_pressure'}`
   *      + 控制台一行 + 真唤醒（判据与阈值理由在 `runtime/reasoning-echo-pressure.ts`）；
   *   ① **结果**：最近 20 轮的缓存未命中率 > 25% 且比 24 小时基线高出 ≥2 倍 ⇒
   *      `budget/cache-alert` + 控制台一行 + 真唤醒（判据与五个阈值理由在 `runtime/cache-alert.ts`）。
   *
   * ## 为什么是两条、而且前兆排前面
   *
   * 只读审计（2026-10-21，本机 20.6 万条事件、零反例）把当天那场追到了**一个机制**：
   * 回传思维链顶穿 `REASONING_ECHO_POLICY.maxTotalChars` ⇒ 每一笔挤掉最老的一个 assistant 组
   * ⇒ 历史头部每笔位移 ⇒ 每笔重编码前缀 ⇒ 92% 未命中、单小时开销翻 3 倍多。
   *
   * 两条判据的关系是**因与果**，不是并列：前兆在钱花掉**之前**响，结果判据在钱花掉**之后**响。
   * 所以两条都留（结果是唯一能兜住"别的原因导致的暴涨"的那一条），但**唤醒只发一次**——
   * 同一刻叫两次只会让她以为出了两件事。取前兆那条（可行动、且来得及）。
   *
   * ## 为什么判在**一轮收尾之后**
   *
   * 两条判据的原料都是**这一轮刚写的事件**（`budget/consumed`、`model/reasoning-echo`）——
   * 判早了（`prepareTurn` 段、或 `eventView` 那份本拍开头的快照）就看不到"刚刚这一轮多贵/多满"，
   * 永远慢一轮。所以这里**现读一次全量快照**（`allEventsOf` 是按日志实例缓存的增量快照：
   * 没有新事件时零 IO、零 parse，见 `state/event-snapshot.ts` 的文件头），
   * 而不是拿 `this.eventView` 那份旧快照。
   *
   * 两条判据**共用这一份快照与一次过滤**：前兆那条吃的是"渲染看见的那一份"
   * （`contextEventFilter` 之后——子代理链的事件不在父请求里，混进来会把字符数算大）。
   *
   * ## 五条刻意不做的
   *
   *   · **两条 lane 都成立时只叫一次**：事件与控制台按 lane 各一条（那是两条不同的账），
   *     唤醒取**未命中率更高**的那条 lane 的正文；
   *   · **前兆与结果同时成立也只叫一次**：取前兆（理由见上）；
   *   · **不 `return`**：调用点在 `tickOnce` 的收尾链中间，提前返回会跳过挂起线索与安静计时；
   *   · **不接 `noteUserSpoke`**：这不是人开口（框架通报），理由同 `handleCompactionWake`；
   *   · **不设 `wake/manual.dedupeKey`**：那条键在投影里永久生效，会把"恶化一档该再叫"
   *     变成"这台机器上永远只叫一次"。去重只在两条判据各自的那一处
   *     （`cache-alert.ts` 的 `alreadyReported` / `reasoning-echo-pressure.ts` 的
   *     `echoPressureAlreadyReported`，都从日志里数，重启照样成立）。
   */
  private async handleCostAlerts(): Promise<void> {
    const raw = await allEventsOf(this.deps.log);
    const nowMs = this.deps.now().getTime();
    /** 渲染看见的那一份（前兆判据用它；理由见方法头） */
    const rendered = raw.filter(contextEventFilter);

    // ⓪ 前兆：思维链回传压力
    const pressure = readEchoPressure(rendered);
    const pressureVerdict = planEchoPressure(pressure, { nowMs, events: raw, respectDedupe: true });
    let woke = false;
    if (pressureVerdict.fired) {
      const cap = pressure.cap ?? 0;
      this.appendSync('model/reasoning-echo', {
        // 这两格是事件信封上既有字段（`prune` / `fallback` 也写它们）。压力这条不针对某一步，
        // 取本轮最后一步的读数最贴近"现在"——`readEchoPressure` 就是按这个口径给的。
        turn: pressure.turn,
        step: pressure.step,
        kind: 'reasoning_echo_pressure',
        pressure: {
          echoChars: pressure.echoChars,
          keptChars: pressure.keptChars,
          cap,
          ratio: Math.round(pressureVerdict.ratio * 10_000) / 10_000,
          evicted: pressure.evictedThisTurn,
          droppedGroups: pressure.droppedGroups,
          droppedChars: pressure.droppedChars,
          band: pressureVerdict.band,
        },
      }, 'internal');
      this.write(echoPressureConsoleLine(pressure, pressureVerdict.ratio));
      this.appendSync(
        'wake/manual',
        { note: echoPressureWakeNote(pressure, pressureVerdict.ratio), via: 'system' },
        'model',
      );
      this.write('[成本] 已发一次真唤醒（via=system，前兆：思维链回传压力）');
      woke = true;
    }

    // ① 结果：最近 20 轮的未命中率
    // 两条 lane 分开算、**一趟扫完**（`planCacheAlerts`）：`light` 的正常未命中率与 `heavy`
    // 不是一个数（前者样本少、前缀短），合成一条会被 `heavy` 的大额掩盖，
    // 而"哪条 lane 在烧钱"正是要回答的第一件事。
    const firedMiss: CacheAlertReading[] = [];
    for (const verdict of planCacheAlerts({ events: raw, nowMs, respectDedupe: true })) {
      const reading = verdict.reading;
      if (!verdict.fired || reading === null) continue;
      firedMiss.push(reading);
      this.appendSync('budget/cache-alert', cacheAlertPayloadOf(reading), 'internal');
      this.write(cacheAlertConsoleLine(reading));
    }
    if (firedMiss.length === 0) return;
    // 前兆已经把这一拍的那一次唤醒用掉了 ⇒ 结果判据只记账、不再叫（理由见方法头）
    if (woke) {
      this.write('[成本] 同一拍已有前兆唤醒，结果判据只落账不再叫');
      return;
    }
    const worst = firedMiss.reduce((a, b) => (b.missRatio > a.missRatio ? b : a));
    this.appendSync('wake/manual', { note: cacheAlertWakeNote(worst), via: 'system' }, 'model');
    this.write(`[成本] 已发一次真唤醒（via=system，${worst.lane}）`);
  }

  // ──────────────────────────── 压缩**前**的预警（2026-10-15） ────────────────────────────

  /**
   * **可见历史越过压缩线的 80% ⇒ 叫醒她一次，让她先整理再继续**（用户 2026-10-15 的口径，
   * 逐字见 `model/compaction-warning.ts` 的文件头；判据与文案都在那个纯模块里）。
   *
   * ## 为什么是"一条真唤醒"，不是"此刻层多一行"
   *
   * 用户原话：「到 **0.8 * 200k** 的时候就要有**条框架提醒把她唤醒**」——要的是她**被叫起来**
   * 去整理（"避免压缩导致丢失信息"），而不是"她下一轮碰巧看见一行字"。此刻层那一行是**主动
   * 撞上**（她当时正好在跑别的活），越线之后可能几小时没人叫她，那份提示就一直没机会被她读到。
   *
   * ## 走哪条路：与压缩后那条**逐字同形**，零新机制
   *
   * `appendSync('wake/manual', {note, via:'compact-soon'}, 'model')` → 折投影 → 主循环下一拍
   * 认领 ⇒ 真起 turn、正文逐字进请求体（理由与三处"刻意不做"逐条写在 `handleCompactionWake`
   * 的方法头里，本方法一字不差地沿用）。**没有新增唤醒类型**，`main.ts` 一行都不用改。
   *
   * ## 判在哪一刻：**本轮收尾、`compaction/decision` 落库之前**（本方法由
   * `TurnRunner.run` 在那一行账写下去之前调，结论直接搭在账上）
   *
   * 两个理由：
   *   • **同一个数**：判据要的 `historyTokens` 就是 `compactionDecision` 刚算出来的那个——
   *     与压缩判定逐字同源（用户点名"用与压缩同一个量"，不许另算一份）；
   *   • **不慢一轮**：在每拍 prepare 段判只能读上一轮落账的读数，而**第一拍必然没有读数**
   *     （实测：那一支的结论永远是 `unknown`，等于这条预警在"刚起来"与"刚压过"之后各哑一拍）。
   *
   * ## 迟滞的实质（★ 判据全在 `planCompactionWarning` 里，这里只说为什么）
   *
   * **每档只报一次 + 重置**（2026-10-22，替掉上一版"同档 30 分钟冷却、过了冷却可以再报"
   * ——现场同一档 80 在 07:34 / 08:25 / 09:09 各报一次，用户原话：「压缩临近变成了每次唤醒
   * 都有。80% 提醒一次、95% 提醒一次就行了」）：
   *   · **两档**：跨过 **80% / 95%** 各报**一次**；
   *   · **同一档报过就永久不再报**（判据里**没有时钟**；上一版的 `cooldownMs` 已废弃、恒为 0）；
   *   · **压缩（`wrote`）或历史回落到阈值 50% 以下 ⇒ 分档状态归零**，下个周期重新可报。
   *
   * 状态**从日志里读**（`compactionWarningStateOf(compactionWarningRowsOf(eventView))`，
   * 不是进程内存、也不是"队列里还有没有"）：重启之后那面旗必须照样成立，否则每次重启都会补一条。
   * 也正因如此它天然不刷屏、**不需要第二道时间闸**（与此刻层那道 6 小时的
   * `MAINTENANCE_MIN_GAP_HOURS` 是两件事，本批不动那一条）。
   *
   * ★ **它什么时候真的响**（判据的性质，不是缺陷）：压缩线在 100%，预警线在 80%——
   * 而"越线"与"能压"并不总是同时成立。**越了线但这一拍压不动**（收益闸门 `gate` / 折叠不
   * 变小 `no-shrink` / 遮蔽点回退 `monotonic`）的那些拍，正是这条预警存在的意义：历史已经
   * 贴近上限、而压缩这拍做不了，她该趁现在把要紧的东西收起来。反过来，**第一次越线通常
   * 就伴随一次压缩**（80% 与 100% 之间那 20k 往往在同一轮里走完）⇒ 那一拍记 `just-compacted`、
   * 不重复叫她（她本来就会被 `via:'compact'` 那条叫一次）。
   *
   * ⚠ 它发出去的那条唤醒仍然过 `admitWake()` 那道门（预算暂停 / 日额度 / 连续失败）：被拦下时
   * 事件留在 pending，解禁后照常被认领——与其它唤醒同一条语义，不给自己开后门。
   */
  private handleCompactionSoonWarning(
    historyTokens: number | null,
    reason: string,
    thresholdTokens: number,
  ): CompactionWarning {
    // 分档状态**从日志复算**（重启后同样成立）；判据不看时钟，所以这里不传 `nowMs`
    const progress = this.compactionWarningState();
    const warning = planCompactionWarning({
      historyTokens,
      thresholdTokens,
      reason,
      lastTier: progress.lastTier,
      lastAtMs: progress.lastAtMs,
    });
    if (!warning.fired) return warning;

    // 越过线 ⇒ 当场叫醒她一次（正文里带三个数：现在多少 / 阈值多少 / 百分比）
    this.appendSync('wake/manual', {
      note: compactionSoonNote({ historyTokens: historyTokens!, thresholdTokens }),
      via: 'compact-soon',
    }, 'model');
    this.write(
      `[压缩] 可见历史 ${historyTokens} / 阈值 ${thresholdTokens}`
      + `（${Math.round((historyTokens! / thresholdTokens) * 100)}%）⇒ 已发一次真唤醒`
      + `（via=compact-soon，第 ${warning.tier ?? 0} 档）`,
    );
    return warning;
  }

  /**
   * **从日志复算压缩预警的分档状态**（`lastTier` / `lastAtMs`；不看进程内存）。
   *
   * 读法与两条重置的判据**全在纯模块里**（`compactionWarningStateOf`，与 doctor 的复算同一份），
   * 这里只负责把**本拍看到的事件快照**递进去。三条刻意的选择（与原来那道
   * `warnedSinceLastCompaction` 一脉相承）：
   *   • **不用"队列里有没有一条没被认领的"**：那条提醒被认领的那一刻就从队列里没了，而
   *     "报过没有"必须比队列活得久——实测按队列判会让越线状态**每拍各发一条**（3 拍 3 条）；
   *   • **不记进程内存**：重启之后"报过没有/上次何时"必须照样成立，否则每次重启都会补一条
   *     （同 `lastMaintenanceWindowAt` 那条闸的理由）；
   *   • **压缩与回落都是重置**：`wrote` 之后旗子归零，历史掉到阈值 50% 以下同样归零，
   *     下一次跨 80% 再提醒——旧档位不会跨压缩活下去（**那正是"永久静默"换个形状回来**）。
   */
  private compactionWarningState(): { lastTier: CompactionWarningTier; lastAtMs: number | null } {
    return compactionWarningStateOf(compactionWarningRowsOf(this.eventView));
  }

  // ──────────────────────── 空拍 · 自我整理提醒（2026-10-20） ────────────────────────

  /**
   * **空拍到第二拍提醒一次、到第五拍再提醒一次，之后不再提醒**（用户 2026-10-22 的裁决；
   * 判据、文案、"拍"怎么数、以及为什么不动 `render.ts` 那一条都写在
   * `model/self-organize-reminder.ts` 的文件头）。
   *
   * ## 为什么与心跳**同一轮**，而不是另起一条唤醒
   *
   * 那两拍心跳本来就会真起一个 turn（"心跳是真实唤醒"，2026-10-05 的口径）。
   * 本条在 `tickOnce` 里**取 `batch` 之前**把 note 落库 ⇒ 它和那条 `wake/heartbeat` 被同一轮
   * 认领 ⇒ **一次请求都不用多加**，她在那本来就醒着的一拍里看到"可以整理"。
   * 另起一条唤醒（`compact-soon` 那种写法）在这里要多付一次请求，而这两拍并不缺一次"叫醒"。
   *
   * ## 三条不变量
   *
   *   · **一段安静期最多两次**（第 2 拍、第 5 拍各一次）：计数与"已提示几次"都从日志里读
   *     （`selfOrganizeTraceOf`），不看进程内存、也不看"队列里还有没有"（后者每两拍会各发
   *     一条，`compact-soon` 踩过）；第 3 次**永不出现**（用户原话：「然后就不提示了」）；
   *   · **不是派活**：正文只说"可以"，做不做她定（用户原话："提醒可以进行自我整理"）；
   *   · **失败方向**：判不出来就不发——它是一条提示，不该有能力打断一拍。
   *
   * ⚠ **拍数不用 `projection.idleTicks`**：那个数被每拍的 `message/assistant` 清零
   * （现网 93% 的拍都是 1），按它判这条提醒等于永远不响——实测与理由见那个纯模块的文件头。
   */
  private remindSelfOrganizeIfDue(): void {
    const plan = planSelfOrganizeReminder(selfOrganizeTraceOf(this.eventView));
    if (!plan.fired) return;
    // 第 1 次与第 2 次的正文不同（第二次要说清"这是最后一次"）：分派只有这一处
    this.appendSync('wake/manual', {
      note: selfOrganizeNote(plan.reminderIndex === 2 ? 2 : 1),
      via: SELF_ORGANIZE_VIA,
    }, 'model');
    this.write(
      `[整理] 连续空拍 ${plan.idleBeats} 拍（第 ${plan.reminderIndex} 次提醒的阈值 ${plan.threshold} 拍，`
      + `本段已提醒 ${plan.remindedCount} 次）`
      + ` ⇒ 已发第 ${plan.reminderIndex} 次"可以进行自我整理"提醒（wake/manual · via=${SELF_ORGANIZE_VIA}）`,
    );
  }

  // ──────────────────────────────── 唤醒门 ────────────────────────────────

  /**
   * 唤醒门（design §4.6 表格里"拒绝唤醒"的三条来源）。返回 false 表示本拍不处理任何输入：
   * pending 原样留着，水位原地停住——停摆本身由水位停滞告警兜底（§4.9）。
   */
  private async admitWake(): Promise<boolean> {
    const p = this.deps.projection;

    // ① 连续模型失败达阈值：暂停 + 告警（告警已在 healthCheck 里发过，此处只管拦）
    if (!this.failAdmits()) return false;

    // ② 已撞过的 task 层刹车且未加注：可恢复暂停。turn / step 层不锁循环——它们只结束本 turn，
    //    下一个 turn 从 step 0 重新开始；把它们也当成暂停会让一次刹车永久锁死整个循环。
    if (this.guard.isPaused('task', p)) {
      await this.notifyBudgetExhausted('task');
      return false;
    }

    // ③ 每日额度：拒绝唤醒 + 告警。投影里已记过这个停顿就不再写事件（同一事实只落一条）
    const daily = this.guard.statuses(p).find(st => st.layer === 'daily' && st.over);
    if (daily !== undefined) {
      if (p.lastExhausted['daily'] === undefined) {
        this.appendSync('budget/exhausted', {
          layer: 'daily', limit: daily.limit, actual: daily.used, resumable: true,
        }, 'internal');
      }
      await this.notifyBudgetExhausted('daily');
      return false;
    }

    return true;
  }

  // ──────────────────────────────── 指令（B1 第二步） ────────────────────────────────

  /**
   * 人打进来的指令：`/compact` 与 `/handoff`（解析口径见 `slash-commands.ts` 的文件头）。
   *
   * ⚠ **`/stop` 不归这里管**（它也是斜杠指令，但作用相反）：急停在**入口**就办完了
   * （`isStopCommand` / `handleStopCommand` / `recordStop`——掐流、清队列、留痕、回执），
   * 而且它**绝不该触发压缩**。本循环只放行真会压缩的那两类，判据见循环里那一段注释。
   *
   * **当场执行，不唤醒 turn**：人要的是"现在压一次"或"现在把交接写下来"，不是要她回话。
   * 所以这条路既不写 `turn/start` 也不调模型——它只把那条输入摘出队列、落一条留痕、
   * 把事办掉、回收据。三条边界：
   *
   *   • **只认本机对话流**（`wake/manual`）：`wake/channel` 是外面递进来的话，群里谁都能打
   *     `/compact`——让外部文字决定"她该忘掉什么"是把改她自己上下文的能力交给了外人；
   *   • **不认框架自己拼的那条**（`via: 'dream'`）：那是框架指令（见 web/server.ts 的 dream），
   *     不是人打的字。它的正文万一哪天以斜杠开头，也不该被当成人在按按钮；
   *   • **不认识的词不回给模型**：回一句"没有这个指令 <name>"并列出手上的两个
   *     （不打这句回话就等于让用户以为按钮坏了——`/dream` 那次"按了没反应"的教训）。
   *
   * 返回处理掉的条数（调用方据此判断这一拍还有没有别的活）。
   */
  private async handleSlashCommands(): Promise<number> {
    const pending = this.deps.projection.pending;
    let handled = 0;
    for (const item of pending.slice(0, BATCH_LIMIT)) {
      const wake = this.deps.log.get(item.wakeSeq);
      if (wake === null) continue;
      // 判据只有一份（`isSlashCommandEvent`：只认本机对话流里整条就是指令的那些），
      // 这里再解一次是为了拿到 kind/name/argument——短字符串，多解一次换来的是"两处不会漂移"
      if (!isSlashCommandEvent(wake)) continue;
      const command = parseSlashCommand((wake.data as { note: string }).note);
      if (command === null) continue; // 与上面同一判据，理论上到不了这里
      /**
       * ───────── `/stop` **完全不进这条管线**（2026-10-16 修）─────────
       *
       * `/stop` 是本文件里唯一一条 kind **不是"让她做点什么"、而是"用户自己动手"** 的指令：
       * 它的动作（掐流、清队列）在 {@link handleStopCommand} 里，留痕与回执在
       * {@link recordStop} 里——**在这个循环跑到之前就已经办完了**。它落到这里，只有一种可能：
       * 那条 `wake/manual`（界面那条路落库的"按钮载体"）还在 `pending` 里。
       *
       * 放它过去的后果实测过一次（用户 2026-10-16 报的「新加的 `/stop` 有问题……**触发了上下文
       * 压缩**？」）：`runSlashCommand` 的 `kind === 'unknown' ? null : planSlashCompaction()`
       * 把它**当成可以压缩的那一类**，于是按一次急停顺手压一次历史——
       * 日志实证（`data/events/000000133676.jsonl`）：一条 `/stop` 落出**两条** `slash/handled`
       * （`{outcome:'stopped', inputSeq:0}` + `{outcome:'compacted', inputSeq:136170,
       * coveredUpToSeq:136179}`）外加一条 `compaction/summary`。这是**净损失**：急停是"别再动了"，
       * 它绝不该顺带改掉她的上下文。
       *
       * 判据写成"**只排除那一条不会压缩的**"而不是"只放行会压缩的两条"：
       * `unknown` 必须照旧流下去——它要走 `runSlashCommand` 里那一支"回一句『没有这个指令 <name>』"
       * （`outcome:'rejected'`），那**不是**压缩，把 `unknown` 一起挡掉就等于把用户的打错字变成
       * "按了没反应"，正是 `/dream` 那次事故的教训。所以这里排除的条件恰好是
       * **"这一条不会写 `compaction/summary` 却又不是 unknown"**——今天只有 `stop` 落在这上面，
       * 将来再加"只动手、不动上下文"的指令，它默认也进不来。
       * `/compact` 与 `/handoff` 两条路径**一个字节都不动**。
       *
       * ⚠ 摘除载体**不在这里补**：`dropStopInput` 已经在做（`web/server.ts` 的 `wake` 动作里、
       * 投影折完之后那一句）。这里再摘一次会与它各写一条 `input/claimed`。
       */
      if (command.kind !== 'compact' && command.kind !== 'handoff' && command.kind !== 'unknown') continue;
      await this.runSlashCommand(command, item);
      handled += 1;
    }
    return handled;
  }

  /**
   * 执行一条指令：**消费输入 → 真办事 → 落留痕 → 回收据**。
   *
   * 顺序里有两处是刻意的：
   *   • **先消费再算遮蔽点**：队列里剩下的输入就是"还没轮到她看的那些"，遮蔽点必须停在它们
   *     之前（见 {@link slashCoverFloor}）。反过来的话，这一拍刚到的那句话会被自己人的
   *     `/compact` 一起遮掉；
   *   • **先算计划再落留痕**：`slash/handled.coveredUpToSeq` 要与紧随其后的
   *     `compaction/summary` 是同一个数——两个数对不上，事后读日志就得猜哪个是真的。
   */
  private async runSlashCommand(command: SlashCommand, item: PendingInput): Promise<void> {
    // ① 消费这条输入。指令不唤醒 turn，所以不写 turn/start 与 turn/end，只把它摘出队列。
    //    turn 挂 0 是既有的"这条账不是 turn 归属"口径（与 judgeChannelWakes 的先例一致）。
    //    不摘的后果很具体：下一拍它还在 pending 里，下一个 turn 会把它当普通消息送进模型，
    //    她就得对着 "/compact" 猜用户想干什么——那正是 B1 写明不许发生的事。
    this.appendSync('input/claimed', {
      turn: 0, wakeSeqs: [item.wakeSeq], claimCounts: [item.claimCount],
    }, 'internal');

    // ② 真办事。`unknown` 什么都不做；两条真指令共用**同一条落库路径**（见 planSlashCompaction）
    const plan = command.kind === 'unknown' ? null : await this.planSlashCompaction();
    const outcome = command.kind === 'unknown' ? 'rejected' : plan === null ? 'empty' : 'compacted';
    // 回执在落账**之前**定下来：它要逐字进 `slash/handled`（日志是唯一真相源，
    // 回执不能只活在告警文件里），同时也要发给用户（见下面③）。
    const receipt = command.kind === 'unknown'
      ? unknownCommandReply(command.name)
      : plan === null
        ? (command.kind === 'compact' ? COMPACT_EMPTY_RECEIPT : HANDOFF_EMPTY_RECEIPT)
        : (command.kind === 'compact' ? COMPACT_RECEIPT : HANDOFF_RECEIPT);
    const trace = this.appendSync('slash/handled', {
      kind: command.kind,
      name: command.name,
      argument: command.argument,
      outcome,
      inputSeq: item.wakeSeq,
      ...(plan === null ? {} : { coveredUpToSeq: plan.coveredUpToSeq }),
      receipt,
    }, 'internal');
    if (plan !== null) {
      // 与自动压缩写的是**同一种事件、同一份 payload**（`{coveredUpToSeq, summary}`）。
      // 可见性取 model（与 defaultVisibility('compaction/summary') 同值）：摘要要进她的上下文，
      // 这是"下一个 turn 读得到"的唯一通道（render 的 renderMemoryLayer 只认这个事件）。
      // 信封上的 origin 是 runtime/real-loop（不是 web/api），所以界面把它渲染成
      // 「上下文在此处压缩」而不是人工 reset（见 gui 的 _isManualReset）——这一次确实是压缩。
      this.appendSync('compaction/summary', plan, 'model');
      this.deps.log.flush();
    }

    // ③ 送给人。走**现有回执通道**：告警出口（文件档 + webhook + `alarm/sent` 事件）。
    //    为什么是它而不是别的：框架要"对用户说一句"的既有路径只有两条——`this.write` 只到本机
    //    控制台（她也看不见），而告警出口是唯一一条真能送到人手上的（`notifyBudgetExhausted`、
    //    `settleTopUpRequests`、人审挂起都用它）。用 `alert` 而不是 `fail`：回执不是故障，
    //    `fail` 会登记 stall 并在之后配一条莫名其妙的"已恢复"。
    //    指纹里带上留痕的 seq：**每一次按下都要有回答**——限流把回执吞掉，在界面上就是
    //    "按了没反应"（`/dream` 那次事故的教训）。人不会连按这个按钮，宁可多发一条。
    //
    //    注意 `alarm/sent` 只装 title（回执正文在文件档与 webhook 里）——所以正文另行逐字
    //    落在 `slash/handled.receipt` 上，日志自己就说得清当时回了什么。
    this.write(`[指令] /${command.name} → ${outcome}${plan === null ? '' : `（遮蔽至 seq ${plan.coveredUpToSeq}）`}`);
    await this.notifier.alert({
      category: 'slash-command',
      level: 'info',
      title: command.kind === 'unknown' ? `不认识的指令 /${command.name}` : `已执行 /${command.name}`,
      body: receipt,
      params: { kind: command.kind, seq: trace.seq },
    });
  }

  /**
   * 立刻压一次（`/compact` 与 `/handoff` **共用**这一条）：越过阈值判断，其余照抄自动压缩
   * 那条路（`agent-loop.maybeCompact`）——同一份笔记渲染、同一份遮蔽点口径、同一个事件。
   *
   * 为什么 `/handoff` 也走这里（2026-10-04 接线时才定下的事实，报告里要写清）：
   * 交接笔记**只有**写进 `compaction/summary` 才会被下一个 turn 读到。渲染层只在长期记忆层
   * 里渲染这个事件（`model/render.ts` 的 `renderMemoryLayer`），而且要求 `coveredUpToSeq`
   * 严格大于已有值——不遮蔽就不渲染。所以两条指令的效果都是"写一份交接笔记并把截至此刻的
   * 往来遮蔽掉"，区别只在**人按它的理由**：一个是"接下来要干长活，先把上下文收紧"，
   * 一个是"我要关机器了，把交接写下来"。收据文案按这个事实写（见 slash-commands.ts）。
   */
  private async planSlashCompaction(): Promise<{ coveredUpToSeq: number; summary: string } | null> {
    // 全量读日志。笔记的条目来自**全部**事件，所以这一次读是必要的——它与
    // `runMemoryMaintain` 的 `maxTurnInLog` 同一个量级，而且只在人真的按下指令时发生。
    // 自动压缩那条路用的是 turn 内的增量快照，因为它本来就每步同步一次；这里没有那个快照。
    //
    // **必须过同一把刀**（`contextEventFilter`）：自动压缩喂给笔记的是**过滤后**的事件
    // （agent-loop 的 syncEvents 走 eventFilter），两条路给笔记喂的得是同一种东西。
    // 少这一刀会漏一件很具体的事：笔记会把"用户打了 /handoff 换班"当成一条 user 消息收进去，
    // 而笔记进她的上下文——于是那条指令**绕开 eventFilter 又回到了她眼前**。
    const events: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (contextEventFilter(event)) events.push(event);
    }

    // 遮蔽点先算（顺序与自动压缩那条路刻意一致，见 maybeCompact）
    const covered = compactionCoveredUpToSeq(events, null, this.slashCoverFloor());

    // ── ④甲 收益闸门**只装在自动那条路上**（这是刻意的，不是漏了）──
    //
    // 闸门要回答的是"**这一拍自动压一次划不划算**"：新闭合的历史不足一个 recent tail 时，
    // "省下的"抵不过"整段前缀作废一次"。人工指令问的不是这个——人按下去就是"立刻收紧"，
    // 拒绝他等于把按钮做成摆设；而且那一拍真正要折的往往正是**刚跑完这一轮**的内容
    // （它落在一个已结束的 `turn/end` 之后，从"上一次遮蔽点"起算会被算成 0），
    // 拿自动口径卡他，卡掉的恰好是他想压的那一段。
    //
    // 代价照旧由人承担（一次前缀 miss），收据里写清了；`/compact` 的 receipt 一直就是这么说的。

    const note = renderHandoffNote(events, handoffOptionsOf({
      budgetTokens: this.deps.config.persona.handoffBudgetTokens,
      foldTokens: this.deps.config.persona.handoffFoldTokens,
    }));

    // 一条条目都装不进去 ⇒ **不写**（旧口径，保留）：`coveredUpToSeq` 在这一支上等于
    // `slashCoverFloor()`，而"没有可见历史"时那个值是 0，摘要本来就渲染不出来——
    // 写一条只有标题的空摘要没有替代品可言，如实回一句"什么都没压"更诚实。
    //
    // **④乙 的"摘要不许落空"这一支不在这里**：那一支管的是**遮蔽真的发生了**的时候
    // （有区间被折掉、模型会面对一个空档），见 `maybeCompact` 的机械替代文本。
    // 两者的分界是"这次到底遮没遮东西"（`countMasked > 0`），不是"happens to be 空文本"。
    if (note.included === 0 && this.countMasked(events, 0, covered) === 0) return null;

    // 遮蔽确实发生了、而笔记一条都没装进去（预算为 0、或全被去重合并掉）：落**机械替代文本**。
    // 留白会被读成"那段时间什么都没发生"，然后她按这个印象编下去——reasonix 的
    // `mechanicalFoldDigest` 就是为这一条写的。
    const summary = note.included === 0 || note.text.trim() === ''
      ? mechanicalSummaryText(this.countMasked(events, compactionCoveredUpToSeq(events, null, 0), covered))
      : note.text;

    return { coveredUpToSeq: covered, summary };
  }

  /**
   * 遮蔽区间里的事件条数（机械替代文本要报的那个数）。
   * 与 `estimateMaskedTokens` 同一个范围与可见性判据（两处各写一遍，迟早报的数对不上）。
   */
  private countMasked(events: readonly AppEvent[], fromSeq: number, toSeq: number): number {
    let count = 0;
    for (const e of events) {
      if (e.seq <= fromSeq || e.seq > toSeq) continue;
      if (e.visibility !== 'model') continue;
      if (e.type === 'compaction/summary') continue;
      count += 1;
    }
    return count;
  }

  /**
   * 手动压缩的遮蔽点**下界**（`compactionCoveredUpToSeq` 的 `floorSeq`）：
   * **队列里还没处理的输入不能被遮蔽**——它们还没轮到她看，遮掉就是吞了用户的话
   * （而且不是"进了摘要"，是连摘要都来不及收录：笔记在它们之前就渲染好了）。
   * 队列空了才允许"遮到此刻"（`projection.lastSeq`）——那正是"把到这一刻为止的往来
   * 收紧成一份笔记"的字面意思。
   */
  private slashCoverFloor(): number {
    const pending = this.deps.projection.pending;
    if (pending.length === 0) return this.deps.projection.lastSeq;
    let oldest = Number.POSITIVE_INFINITY;
    for (const item of pending) {
      if (item.wakeSeq < oldest) oldest = item.wakeSeq;
    }
    return Math.max(0, oldest - 1);
  }

  /**
   * 失败刹车放行判定：未达阈值即放行；已达阈值时只在半开冷却期满后放行一次试探——
   * 成功一次投影里的 failStreak 自然归零（fold 的口径），于是暂停自动解除。
   */
  private failAdmits(): boolean {
    if (this.deps.projection.failStreak < this.failStreakMax) return true;
    if (this.failPausedAtMs === null) return false; // 本拍刚进入暂停（healthCheck 已置位）
    const nowMs = this.deps.now().getTime();
    if (nowMs - this.failPausedAtMs < this.failCooldownMs) return false;
    if (nowMs - this.lastFailProbeMs < this.failCooldownMs) return false;
    this.lastFailProbeMs = nowMs;
    return true;
  }

  // ──────────────────────────────── 健康检查与告警 ────────────────────────────────

  /**
   * 每拍检查两条与"活不活"有关的事实（§4.9 触发点清单）：
   *   - 水位停滞：有输入进来却超过阈值没有一次成功模型调用；
   *   - 连续模型失败：达阈值即置暂停位并告警（放行动作在 failAdmits）。
   * 两条都在恢复时发"已恢复"通知（M3-7）：故障期间被限流压制，恢复时恰好说一次。
   */
  private async healthCheck(): Promise<void> {
    const p = this.deps.projection;

    const stall = this.stallReport(p);
    if (stall === null) {
      await this.notifier.ok(CATEGORY.stall, '水位恢复正常：等待中的输入已被处理。');
    } else {
      await this.notifier.fail({
        category: CATEGORY.stall,
        level: 'warn',
        title: `水位停滞：有输入等了 ${Math.floor(stall.waitedMs / 60_000)} 分钟没被处理`,
        body: `最早一条待处理的输入到于 ${stall.oldestPendingAt}，已经等了 ${Math.floor(stall.waitedMs / 60_000)} 分钟`
          + `（队列里现有 ${stall.pending} 条，循环手上没有活）。`
          + '循环可能被预算暂停卡住，或模型侧一直失败。',
        params: { pending: stall.pending > 0 },
      });
    }

    const fail = p.failStreak >= this.failStreakMax ? p.failStreak : null;
    if (fail === null) {
      this.failPausedAtMs = null;
      await this.notifier.ok(CATEGORY.failStreak, '模型调用已恢复成功：连续失败计数归零。');
    } else {
      await this.enterFailPause(fail);
    }
  }

  private async enterFailPause(actual: number): Promise<void> {
    if (this.failPausedAtMs !== null) return; // 已在暂停中：不重复告警（限流是第二道保险）
    this.failPausedAtMs = this.deps.now().getTime();
    await this.notifier.fail({
      category: CATEGORY.failStreak,
      level: 'critical',
      title: `模型连续失败 ${actual} 次：已暂停唤醒`,
      body: `连续 ${actual} 次模型调用失败（阈值 ${this.failStreakMax}）。单次调用的退避重试由模型客户端负责，`
        + `这里按刹车语义暂停唤醒：冷却 ${Math.round(this.failCooldownMs / 60_000)} 分钟后自动试探一次。`,
      params: { actual },
    });
  }

  /**
   * 撞刹车告警（§4.9「撞到任何一层刹车」）。暂停不是失败：正文里给恢复动作。
   *
   * **这是"到上限了"给人看的唯一一句话**——三条路都汇到这里（turn 收尾的结局、
   * task 层暂停、daily 层拒绝唤醒），所以它必须一次说全五件事：
   * **哪一档 + 上限多少 + 已用多少 + 这一档锁没锁住循环 + 两条出路**。
   * 只说"到上限了"等于把人扔在半路：他既不知道该去哪儿调，也不知道还能加注。
   *
   * 两条出路都是**已有的机制**，这里只是把它们说出来：
   *   ① 「设置 → 系统」里改那一档（`budget.stepTools` / `turnSteps` / `taskTokens` / `dailyTokens`，
   *      与界面上那几行的标签逐字对齐——见 {@link BUDGET_LAYER_FACTS}）；它是启动参数，
   *      改完要重启进程才生效；
   *   ② `irmia topup --layer <层> --tokens <N>`（`runtime/topup.ts` 的看门文件，循环下一拍拾取，
   *      不用重启）。加注是**抬高上限**，不是清零消耗——进度一个字节都不动。
   *
   * 标题里也带上"哪一档 + 已用 / 上限"：事件列表只显示标题（正文在告警文件与 webhook 里，
   * 界面「告警」面板读的是文件），只写"预算耗尽"就又回到了"到上限了、没有下一步"。
   * 全文不含任何价格 / 货币口径（只有 token 与次数）。
   */
  private async notifyBudgetExhausted(layer: BudgetLayer): Promise<void> {
    const status = this.guard.statuses(this.deps.projection).find(st => st.layer === layer);
    const used = status?.used ?? 0;
    const limit = status?.limit ?? 0;
    // **上限的构成必须一眼看得出**（用户 2026-10-05：「不许不协调」）：
    // 有效上限 = config.budget 那一档 + 累计人工加注。现场那张告警写着"上限 57000000"、
    // 而 config.json 里是 taskTokens: 5000000 —— 差额 52M 是历史加注，不摊开就只能靠猜。
    // 加注为 0 时不加那段（绝大多数情形），需要时又一定在场。
    const base = status?.composition.base ?? 0;
    const topUp = status?.composition.topUp ?? 0;
    const breakdown = topUp > 0
      ? `（配置 ${formatTokens(base)} + 加注 ${formatTokens(topUp)}）`
      : '';
    const facts = BUDGET_LAYER_FACTS[layer];
    // 这一档锁不锁循环（budget-guard 的四层语义）：step / turn 只结束本 turn，
    // task / daily 会拒绝唤醒。说错这一句，人会以为整个循环死了。
    const state = layer === 'task' || layer === 'daily'
      ? `循环已暂停唤醒：队列里现有 ${this.deps.projection.pending.length} 条输入原地留着（可恢复，不清空重来）。`
      : '这一档只结束当前 turn：下一个 turn 从第 1 步重新开始，循环没有被锁住。';
    await this.notifier.fail({
      category: CATEGORY.budget,
      level: 'critical',
      title: `预算耗尽（${facts.name}）：已用 ${formatTokens(used)} / 上限 ${formatTokens(limit)}${breakdown}`,
      body: `${facts.name}这一档到上限了：已用 ${formatTokens(used)} / 上限 ${formatTokens(limit)}`
        + `。上限的构成：配置「${facts.field}」${formatTokens(base)}`
        + `（${facts.scope}，改完要重启进程才生效）`
        + (topUp > 0
          ? ` + 历史累计加注 ${formatTokens(topUp)}（budget/topped-up 折出来的）。`
          : '（这一档还没有过人工加注）。')
        + state
        + `两条出路：① 去「设置 → 系统」把「${facts.field}」调大`
        + '——已经暂停的层，重启后新上限只要高于已用量，暂停就自动解除'
        + '（会落一条 budget/resumed，说清是谁解的、凭什么解的）；'
        + '新上限仍不高于已用量则照旧停着，那就只剩加注这条路。'
        + `② 加注：irmia topup --layer ${layer} --tokens <N> —— 不用重启，循环下一拍拾取后接着跑。`,
      params: { layer },
    });
  }

  /**
   * 「思维链没回传」的 400 进告警（2026-10-17 加）。
   *
   * ───────── 为什么它必须自己一条告警：这条路**两个现成的刹车都到不了** ─────────
   *
   *   · `FAILURE_STREAK_MAX`（`agent-loop.ts:268`）是**工具目标**连击守卫：`toolTargetOf` 只认
   *     `read_channel` 的 sid，而 400 在**调模型**那一步就断了——这一轮根本没有工具调用，
   *     `admit()` / `settle()` 一次都不会被叫到；
   *   · 模型级失败刹车（`budget.failStreakMax`，本机 `config.json:37` 是 20）也到不了：实测 10-17
   *     的每一轮都是「**第 1 步成功**（In≈97k）→ 第 2 步 400（In=0）」，而 `state/fold.ts` 的
   *     `applyBudgetConsumed` 对**任何非 failed 的 `budget/consumed`** 都把 `failStreak` 归零
   *     ⇒ 它在 0↔1 之间振荡，永远攒不到阈值。
   *   于是 10-17 01:33–02:04 那 22 轮（turn 2151–2174 区间）**一条告警都没有**：全日志只有 3 条
   *   `alarm/sent{model-failure}`，都在 10-05。唯一的兜底是 `MAX_CLAIM_COUNT = 3`
   *   （`recover.ts:65`，同一条输入认领三次后进死信），人看到的是"这一拍又没吭声"。
   *
   * ───────── 走哪条通道：**既有的那一个**，不新造 ─────────
   *
   * `alert/notifier.ts` 的 `fail()`：文件档（`data/alarms/`）+ 配了 webhook 就外发 +
   * `alarm/sent` 事件（界面「告警」面板与框架提示卡读的都是它），与 `budget-exhausted` /
   * `model-failure` / `stall` 同一条路。
   *
   * **刷屏由出口自己的指纹窗口挡**（`notifier.ts` 的 `deliver`：同指纹在
   * `alerts.rateLimitMin`（默认 30 分钟）内只发一条）——所以 `params` 里**只许放稳定的一格**
   * （错误码）。放 turn / 次数 / 时间就等于每次换指纹、绕开窗口，22 连炸会变成 22 张卡。
   *
   * **没有配一条 `ok()` 销账**：这条故障的"恢复"要等思维链回传口径落地（或它再也不撞上），
   * 本进程手里没有"它好了"那一刻的判据——按 notifier 的纪律，编一条"已恢复"就是造假事实。
   *
   * 级别是 `warn` 不是 `critical`：循环没坏（没有暂停、没有刹车，输入照旧退回队列），
   * 但它意味着"她一步都走不完"，值得人看一眼；`critical` 留给真把循环停住的那几条。
   */
  private async notifyReasoningEcho(reason: { code: string; message: string }): Promise<void> {
    // 告警正文是给人看的：服务端原话留头一段就够（全文在 `turn/end.reason.message`）
    const detail = reason.message.length <= 240 ? reason.message : `${reason.message.slice(0, 240)}…`;
    await this.notifier.fail({
      category: 'reasoning-echo',
      level: 'warn',
      title: '模型拒绝请求：思维链没有回传（这一轮走不完）',
      body: '思考模式要求把上一轮的 reasoning_text 原样回传，而我们的 message/reasoning 是 internal '
        + '⇒ 一个 reasoning item 都没回过，这一步被 http_400 拒掉。这一轮以 error 收尾、输入退回队列'
        + '（同一条输入最多认领 3 次后进死信），并且**不会**进模型失败刹车：每一轮第 1 步是成功的，'
        + '会把 failStreak 归零。'
        + `服务端原话：${detail}`,
      // ⚠ 指纹 = 类别 + params：这里只放稳定的一格（见本方法那段注释）
      params: { code: reason.code },
    });
  }

  /**
   * 启动补写「已恢复」：为**由进程状态决定、且当刻确实不成立**的未解除告警补一条销账。
   *
   * 判据一条都不在这里新造（三处都指向既有实现）：
   *   · **哪些还没解除** —— `alert/startup.ts` 的 `unresolvedCategories`（与 notifier 的
   *     `foldStalls` 同一口径）；
   *   · **哪几类可以补** —— 那里面的 `STARTUP_BACKFILL` 表（`budget-exhausted`、`stall`），
   *     以及 `NEVER_BACKFILLED`（"模型连续失败"这类**历史事实**：重启不等于它没发生过，
   *     一个字都不许补——那条判据写在 startup.ts 上）；
   *   · **当刻到底成不成立** —— 预算层用 `raisedLayers`（有效上限已经高过
   *     撞线时那个上限 = 当刻不越线，与 `liftedPauses` 判据③同一个比较）；停滞用
   *     `stallReport()`（运行期那一份判据本身，不另写一遍）。
   *
   * 幂等：写下去的那条 `recovered:true` 进日志，下一次启动 `foldStalls` 就把它销掉了；
   * 同一次启动只调一次（warmUp）。**不谎报**：三条判据缺一条都不写。
   */
  private async backfillResolvedAlarms(
    events: readonly AppEvent[],
    pausedAtStartup: readonly BudgetLayer[],
  ): Promise<void> {
    const pending = unresolvedCategories(events);
    if (pending.length === 0) return;

    // ② 停滞：跑一次运行期那份判据本身（队列里有没有人等超时）。没有这一类告警时不白读盘。
    const stallStillOn = pending.includes(CATEGORY.stall)
      ? this.stallReport(this.deps.projection) !== null
      : false;
    // 当刻**还停着**哪几层：只有 `releaseLiftedPauses` 之后这一读才算数（抬上限解开的层
    // 已经被它从 `lastExhausted` 里清掉；还挂着的就是上限没高过已用量的那些）。
    // `pausedAtStartup`（抬上限之前读的那一份）只进正文——它说得出"上一次停的是哪一层"，
    // 不参与判定（拿它一起判就会把"刚解开的那层"又算成还停着，正好把该补的账挡掉）。
    const pausedNow = pausedLayers(this.deps.projection);

    const candidates = backfillCandidates(events, { pausedLayers: pausedNow, stallNow: stallStillOn });
    if (candidates.length === 0) return;

    const raised = raisedLayers(events, layer => this.guard.limitOf(layer));
    const written = await backfillResolvedAlarms(this.notifier, candidates, (category) => {
      if (category === CATEGORY.budget) {
        return raised.length === 0
          ? `启动时核对：${pausedAtStartup.join('、')} 层那条撞线记录已被后来的 budget/resumed 或加注销掉，`
            + '当刻不再越线。'
          : `启动时核对：撞线的是 ${raised.join('、')} 层，当刻有效上限已高过撞线时那个上限，`
            + '暂停不再成立。';
      }
      return '启动时核对：队列里没有等了超过阈值的输入，水位停滞当刻不成立。';
    });
    for (const category of written) {
      this.write(`[告警] 启动核对：${category} 当刻已不成立，补写一条「已恢复」销账`
        + '（上一次是重启/改配置/加注解开的，进程内没有那一刻可写）');
    }
  }

  /**
   * 抬上限解除暂停（2026-10-04 修的真 bug）：**判据看活的数，不看那条粘在投影里的记录**。
   *
   * 现场：任务层撞线 → 暂停；用户去「设置 → 系统」把上限调大并重启进程，什么都没变——因为
   * `lastExhausted` 是**日志的折叠结果**，重启只是把同一条 `budget/exhausted` 重放一遍，
   * 唤醒门照旧拿它拦住所有输入（那条 `wake/manual` 一直躺着没有 turn 起来），用户只好再加一次注
   * （`budget/topped-up` 一到，紧接着就 `turn/start`）。**配置变了、进程也重读了配置，
   * 却解不开一个"上限不够"造成的暂停——这是判据看错了东西**。
   *
   * 判据在 `BudgetGuard.liftedPauses`（四条：不是不可恢复的暂停、记录确实来自撞线、
   * 有效上限真的被抬高了、当刻不再越线），这里只做两件属于循环层的事：
   *   ① **人审挂起在台上时 task 层先等一等**：那时她本来就不在跑，暂停早解一拍没有任何好处，
   *      而"人还在等人答话"这条线索只有循环层知道（`this.suspension`，由 warmUp 的
   *      scanSuspension 从日志重建）。⚠ 2026-10-22 起人审超时**不再写** task 层暂停了
   *      （超时 = 按未批准处置并让她继续），所以这一条只对"真撞线 + 恰好挂着人审"那种巧合生效；
   *   ② **落事件**：解除是一件事，就得写进日志。只改投影会在下一次重启时被日志推翻
   *      （这正是本 bug 的成因）。
   *
   * 幂等：写完之后 fold 立刻把该层记录删掉，下一拍判据为空，不会再写第二条。
   * 调用点两处：warmUp（"改配置 + 重启"那条路）与每一拍（运行期上限变化的其余路径）。
   */
  private releaseLiftedPauses(): number {
    const p = this.deps.projection;
    let released = 0;
    for (const lifted of this.guard.liftedPauses(p)) {
      if (lifted.layer === 'task' && this.suspension !== null) continue;
      this.appendSync('budget/resumed', {
        layer: lifted.layer,
        limit: lifted.limit,
        actual: lifted.actual,
        reason: lifted.reason,
      }, 'internal');
      released += 1;
      const how = lifted.reason === 'limit-raised'
        ? '上限已调到' : '加注累计已把上限抬到';
      this.write(`[预算] ${lifted.layer} 层暂停已解除（${how} ${lifted.limit} > 已用 ${lifted.actual}）`);
      // 恢复通知走告警出口（与加注同一条口径）：上一个进程报出去的那条故障要有人来销账，
      // 否则人只会在告警面板上一直看见"预算耗尽"，不知道重启之后它已经解开了
      void this.notifier.ok(
        CATEGORY.budget,
        `${lifted.layer} 层预算暂停已解除：${how} ${lifted.limit}，高于当刻已用 ${lifted.actual}。`,
      );
    }
    return released;
  }

  // ──────────────────────────────── 加注 ────────────────────────────────

  /** 拾取 CLI 写下的加注看门文件：先落 `budget/topped-up` 事件，再删文件（顺序反了就是丢加注） */
  private settleTopUpRequests(): void {
    const dir = join(this.deps.dataDir, TOPUP_WATCH_DIR_NAME);
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter(name => name.startsWith(TOPUP_FILE_PREFIX) && name.endsWith('.json'))
        .sort();
    } catch {
      return; // 目录不存在：没人加注过
    }
    for (const name of names) {
      const path = join(dir, name);
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const request = parseTopUpRequest(raw);
      if (request === null) {
        this.write(`[预算] 加注看门文件非法，已跳过：${name}`);
        continue;
      }
      // 走 guard.resume 写事件（预算域的 API）：它同时解除该层的暂停态并重新武装软提示
      this.guard.resume(request.layer, request.by, request.addedTokens);
      this.topUps[request.layer] += request.addedTokens;
      if (!this.guardIsInjected) this.guard = this.makeGuard();
      try {
        unlinkSync(path);
      } catch (err) {
        // 事件已落盘，文件没删掉只会导致下一拍重复加注：宁可重复也不能丢，留痕即可
        this.write(`[预算] 删除加注看门文件失败（下一拍会重复加注）：${String(err)}`);
      }
      this.write(`[预算] 已加注 ${request.layer} 层 ${request.addedTokens}（by ${request.by}），暂停态解除`);
      void this.notifier.ok(CATEGORY.budget, `已人工加注 ${request.layer} 层 ${request.addedTokens} token，恢复运行。`);
    }
  }

  /**
   * 跨天写 budget/rollover（fold 不读时钟，边界由运行时写事件）。
   *
   * **"上次记的是哪天"以投影为准，不是进程内存**。这里原来只看一个内存字段，而它每次启动
   * 都是 null —— 于是每启动一次就写一条 rollover，`fold` 收到它就把当日计数清零一次。
   * 表现是运行情况页的「今日 token」老是 0、缓存命中率显示 `-`（0/0），而同一页的 hourly
   * 曲线（从事件重算、不经过这条路径）一切正常；今天重启三次就归零三次。
   * 记账边界是事实，事实以日志为准——投影就是它的折叠结果。
   */
  private rolloverIfNeeded(): void {
    const today = this.deps.now().toISOString().slice(0, 10);
    // 投影是同步折叠的：写过之后它立刻就是 today，同一进程内也不会重复写
    if (this.deps.projection.budget.date === today) return;
    this.appendSync('budget/rollover', { date: today }, 'internal');
    // 跨天 = 日额度自然恢复：把每日层的暂停一并解除（addedTokens:0 表示不是人工加注）
    if (this.deps.projection.lastExhausted['daily'] !== undefined) {
      this.appendSync('budget/topped-up', { layer: 'daily', addedTokens: 0, by: 'rollover' }, 'internal');
    }
  }

  // ──────────────────────────────── 水位停滞 ────────────────────────────────

  /**
   * 水位停滞：队列里有输入，而**它自己**已经等了超过 stallMs 没人管。
   *
   * 判据与阈值都在 `budget-guard.ts` 的 {@link stallOf}（唯一一份实现）。这里只负责把
   * 「最早那条输入是哪一刻到的」从日志里取出来——pending 里存的是 wakeSeq，到达时刻在它
   * 对应的那条 wake 事件上（与 `holdsGroupBatch` 读 ts 是同一口径）。
   *
   * 三条刻意的否定条件：
   *   • `lastModelSuccessAt === null` 不再是"停滞"：那是"从来没成功过"，由失败刹车负责
   *     （两条判据分工不清就会在冷启动时误报）；
   *   • 循环手上有活（busy / openTurn）时不判：一个跑着工具的长 turn 里积压输入是正常背压；
   *   • 一条到达时刻都读不出来时不判：宁可漏报一次，也不拿当前时刻编一个等待时长。
   */
  private stallReport(p: Projection): StallInfo | null {
    if (p.pending.length === 0) return null;
    let oldestMs = Number.POSITIVE_INFINITY;
    let oldestAt: string | null = null;
    for (const item of p.pending) {
      const event = this.deps.log.get(item.wakeSeq);
      if (event === null) continue;
      const at = Date.parse(event.ts);
      if (Number.isFinite(at) && at < oldestMs) {
        oldestMs = at;
        oldestAt = event.ts;
      }
    }
    return stallOf({
      pending: p.pending.length,
      oldestPendingAt: oldestAt,
      busy: this.busy || p.openTurn !== null,
      now: this.deps.now(),
      stallMs: this.stallMs,
    });
  }

  // ──────────────────────────────── 她问的人没答（design §6.1） ────────────────────────────────

  /**
   * 她问出去、一直没人答的提问：落一条「**未批准、未拒绝**」的事实（`human/expired`）。
   *
   * 四条口径，每条都是刻意的：
   *   ① **超时不产生决定**：不写 `human/answered`（那等于伪造"人答过了"）、不写批准也不写拒绝、
   *      更**不撤卡**——卡还在台面上，人回来照样能答（§6.1："只是未有批准或拒绝动作"）。
   *   ② **只落一次**：判据是投影里的 `expiredAt`（由 `human/expired` 折出来），重启后从日志重建，
   *      所以停机期间不会重复落、进程内也不会。
   *   ③ **只认她问的**（source: 'agent'）：系统/计划那条挂起有自己的 24h 超时与"任务层暂停"，
   *      两条混在一起就是两套语义互相伪造。
   *   ④ **让她得知**：事件可见性 model，渲染成「人可能不在」（model/render.ts）。要不要换个方式
   *      找人是她的判断——本方法一个字都不替她决定。
   *
   * 它跑在 `busy` 检查**之前**（见 tickOnce）：她正在做的那个长 turn 里，这条事实也该及时到位
   * （agent-loop 每一步都会重新对齐日志），而不是等她忙完才出现在下一拍。
   */
  private async settleHumanAsks(): Promise<void> {
    const nowMs = this.deps.now().getTime();
    for (const ask of this.deps.projection.humanAsks) {
      if (ask.source !== 'agent') continue;
      if (ask.expiredAt !== null) continue;
      if (!humanTimeoutElapsed(ask.at, nowMs, this.askHumanTimeoutMs)) continue;
      const askedMs = Date.parse(ask.at);
      this.appendSync('human/expired', {
        askSeq: ask.seq,
        question: ask.question,
        turn: ask.turn,
        source: ask.source,
        // waitedMs 取"此刻 - 提问时刻"而不是超时线本身：事实是"到这一刻还没人答"，
        // 线只是判据。时钟读不出来（ts 坏了）时退回超时线，绝不编一个数
        waitedMs: Number.isNaN(askedMs) ? this.askHumanTimeoutMs : Math.max(0, nowMs - askedMs),
        timeoutMs: this.askHumanTimeoutMs,
      }, 'model');
      this.write(
        `[人审] 她问的「${ask.question.length > 40 ? `${ask.question.slice(0, 40)}…` : ask.question}」`
        + `超过 ${Math.round(this.askHumanTimeoutMs / 60_000)} 分钟`
        + '没人答复：已落一条「未批准、未拒绝」的事实（卡不撤，人回来照样能答）',
      );
    }
  }

  // ──────────────────── 申请单：她发起、用户只在界面点批准或驳回（2026-10-11） ────────────────────

  /**
   * 把 `<dataDir>/grants/` 里**还没进过日志**的单子变成一条待批（②那一拍）。
   *
   * 整套判据在 `grant/mcp-grant.ts` 的 `settleGrants`（那里是唯一实现：幂等、同一件事只问
   * 一次、判不过的当场退回、`human/asked` 用 system 来源）。这一层只做两件**循环侧**的事：
   *   • 把投影里台面上还没答复的提问喂给它（判"同一件事只问一次"要用）；
   *   • 把"写事件"接到 `appendSync` 上——**可见性一律走 schema 表**（同 agent-loop 那条纪律）。
   *
   * ⚠ **`events` 必须是"现在"的视图**：幂等判据（`seen`）就是它。两个调用点各给各的：
   *   · `tickOnce`（每拍）给 `eventView`——那是这一拍开头 `mcpIndexSync` 读下的快照；
   *   · `agent-loop` 的 step 边界给 `settleGrantsAtStep` 现读的那一份（turn 运行期间
   *     `eventView` 不会自己更新，拿旧的判会把同一张单子再挂一张卡）。
   *
   * 它**不异步、不 await**：整件事是"读几个小文件 + 写两条事件"，与 `settleHumanAsks`
   * 同一个量级；而它必须在**任何输入被认领之前**跑完（那两条事件的一部分就是给人的卡）。
   * 需要 await 的那一层（读日志）在外面：`settleGrantsAtStep`。
   */
  private settleGrants(events: readonly AppEvent[] = this.eventView): void {
    const result = settleGrants({
      dataDir: this.deps.dataDir,
      events,
      openAsks: this.deps.projection.humanAsks.map((ask) => ({
        seq: ask.seq, question: ask.question, at: ask.at, expiredAt: ask.expiredAt,
      })),
      write: (type, data) => this.appendSync(type, data, defaultVisibility(type)).seq,
      // turn 号**恒挂 0**（tick 那条路与 step 那条路一样）：这一格是 `scanSuspension`
      // 把「claimed 输入」挂到那次挂起上的凭据，而拾取**不是这一轮的挂起**（见
      // `humanSuspension` 那条收窄）——挂上本轮的 turn 号，重启重建时就会把这一轮认领的
      // 输入绑到一张与手上的活无关的卡上。0 = "不属于任何 turn"（与通道注入判定那条
      // "挂 0"同一口径）；这条账的用途是"这张单子是什么时候递的"，不是 turn 归属。
      turn: 0,
    });
    for (const raised of result.raised) {
      this.write(
        `[申请单] 拾取到一张待批：${raised.data.kind}「${raised.data.name}」`
        + `（id=${raised.data.id}）⇒ 已挂出提问 seq ${raised.data.askSeq}，等人点头`,
      );
    }
    for (const bounced of result.bounced) {
      // 退回**不挂卡**（理由在 `settleGrants` 的判据 ③）：留一行诊断让人查得到
      this.write(`[申请单] ${bounced.id} 当场退回（${bounced.reason}）：${bounced.detail}`);
    }
  }

  /**
   * **step 边界的拾取入口**（循环层经 `agentDeps.settleGrantsStep` 调它一次/步；2026-10-21）。
   *
   * ──────────────────── 为什么必须"先新读一遍事件" ────────────────────
   * `settleGrants` 的幂等判据是"`grant/requested{id}` 在不在事件里"（`seen`）。tick 那条路用的
   * 是 `this.eventView`——**这一拍开头**（`mcpIndexSync`）读下的快照，turn 运行期间它不会自己
   * 更新（`mcpIndexSync` 还没跑下一拍）。于是第一步拾取写下的 `grant/requested` 不在那份快照
   * 里；第二步若还拿它去判，`seen` 就会说"没拾取过" ⇒ **同一个 id 再挂一张 `human/asked`**
   * （界面上就是重复卡）。⇒ 这里显式 `await readAllEvents(this.deps.log)` 再传进去。
   *
   * 代价说明：`readAllEvents` 读的是 `state/event-snapshot.ts` 按日志实例缓存的**增量快照**
   * （与 `mcpIndexSync` 用的是同一个缓存）——新写入的几条事件是一次增量读，
   * 不是每步全量扫盘（那件事的代价见 `event-snapshot.ts` 的文件头）。
   *
   * 失败降级：读日志/写事件抛了就只留一行诊断，**这一轮照常跑**（下一拍补拾取）。
   */
  private async settleGrantsAtStep(): Promise<void> {
    try {
      const events = await readAllEvents(this.deps.log);
      this.settleGrants(events);
    } catch (err) {
      this.write(
        `[申请单] step 边界拾取失败（这一轮照常跑，下一拍补）：`
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ──────────────────────────────── 人审挂起（design §4.21） ────────────────────────────────

  /**
   * 人审挂起的三条出路，每拍在一处结算：
   *   ① **答复到达**：把挂起 turn 认领过的输入写成 `input/requeued{reason:'human-answered'}`
   *      送回队列——它们已被 input/claimed 摘走，不送回去就再也没人叫醒它（挂起期间 pending 是空的）。
   *   ② **到达上限的 80%**：先提醒一次（`maybeWarnHumanStall`，同一挂起只提醒一次）——
   *      现场是 06:32 被问、17:51 才有人发现，中间十几个小时界面上一句话都没有。
   *   ③ **超时未答**：**按"未获批准"处置并让她继续**（2026-10-22 用户裁决「不要有这种玩意」）：
   *      作废那条待答、计划按 expired 结案（绝不执行）、输入重新入队，并留 `human/timed-out`。
   *      ⚠ **不再写 `budget/exhausted`**：那条暂停会把整个 agent 的唤醒门关掉，
   *      一次没人答的提问就变成"她再也不干活"——用户要的恰恰是反过来。
   */
  private async settleHumanSuspension(): Promise<void> {
    const s = this.suspension;
    if (s === null) return;
    if (s.answeredAt === null) s.answeredAt = await this.detectAnswer(s.askedAt);
    if (s.answeredAt === null) {
      // 先判到点：到点就处置（作废 + 重入队，`this.suspension` 会当场被清空）；
      // 没到点才轮得到 80% 的提醒——到点那一拍不必再"提醒"一次。
      await this.maybeTimeoutHuman(s);
      if (this.suspension !== null) await this.maybeWarnHumanStall(s);
      return;
    }
    // 答复到达 ⇒ 这一轮挂起（连同它的提醒账）结束：下一次挂起按新的 askSeq 重新记。
    this.humanStallWarnedKey = null;
    // 旧版本（2026-10-22 之前）会为这条挂起写一条 task 层暂停：答复到了就把它解开。
    // addedTokens:0 = 不是人工加注（与 rollover 解除日额度同一口径，不伪造加注量）。
    const hadPause = this.releaseLegacyHumanTimeoutPause('human-answer');
    // **销账放在判据外面**：80% 那条提醒也是 `CATEGORY.human` 的故障登记，
    // 而它发生时**还没有**暂停——答案到了却不销账，那张"框架提示"卡会一直红着
    // （`ok()` 自己认得"没登记就什么都不写"，所以停在外面不会凭空造一条恢复）。
    void this.notifier.ok(
      CATEGORY.human,
      hadPause
        ? '人审挂起已得到答复：任务层暂停已解除。'
        : '人审挂起已得到答复：到上限的提醒作废。',
    );
    this.requeueSuspendedInputs(s, 'human-answered');
    this.suspension = null;
  }

  /**
   * **超时：按"未获批准"处置，然后让她继续**（2026-10-22 拆掉"自动暂停整个 agent"）。
   *
   * 用户原话：「不要有这种玩意」。一次没人答的提问，正确后果是**这件事不执行**，
   * 而不是"整台机器停下来等人"。所以这里做四件事，一件都不多：
   *   ① `human/expired`（既有事件，model 可见）——事实是"时间到了，人可能不在"（§6.1）；
   *   ② `human/timed-out`（新事件，internal）——处置是"这条待答作废、她继续"；
   *   ③ `plan/resolved{outcome:'expired'}`（既有事件）——计划簿记结案，**批准位一格不写** ⇒
   *      需要批准的动作绝不会因为超时而执行；顺带让"同一件事"下次能重新递单（否则永远
   *      被判成"已经在待批队列里"）；
   *   ④ `input/requeued{reason:'human-timeout'}`——挂起 turn 认领过的输入回队列，她接着干。
   *
   * 判别与预算无关：**不写 `budget/exhausted`**，于是唤醒门（`admitWake` 的
   * `isPaused('task')`）不会被这条路点亮。真撞预算线那条语义一个字不动（那在
   * `BudgetGuard` 里，与这里无关）。
   */
  private async maybeTimeoutHuman(s: TrackedSuspension): Promise<void> {
    const nowMs = this.deps.now().getTime();
    if (!humanTimeoutElapsed(s.askedAt, nowMs, this.humanTimeoutMs)) return;
    const askedMs = Date.parse(s.askedAt);
    // waitedMs 取"那一刻 - 提问时刻"（与 `settleHumanAsks` 同一条口径）：时钟读不出来时
    // 退回超时线本身，绝不编一个数
    const waitedMs = Number.isNaN(askedMs) ? this.humanTimeoutMs : Math.max(0, nowMs - askedMs);

    // ① 事实：时间到了（既有事件；model 可见——她得知道人可能不在，§6.1）
    this.appendSync('human/expired', {
      askSeq: s.askSeq,
      question: s.question,
      turn: s.turn,
      // 只有系统来源的提问会挂起（§6.5）：她自己的提问不挂起，走的是 settleHumanAsks
      source: 'system',
      waitedMs,
      timeoutMs: this.humanTimeoutMs,
    }, 'model');
    // ② 处置：这条待答作废（投影里出队、waitingHuman 清掉），她继续
    this.appendSync('human/timed-out', { askSeq: s.askSeq, question: s.question, waitedMs }, 'internal');
    // ③ 计划簿记结案（expired）：绝不批准，但也不能一直占着"已在待批队列里"那一格
    const expiredPlan = this.expirePendingPlanOf(s, waitedMs);
    // ④ 输入回队列：她接着干（与答复那条共用同一份"还在她上下文里吗"的判据）
    this.requeueSuspendedInputs(s, 'human-timeout');
    // ⑤ 旧版本为这条挂起写过的那条 task 层暂停（若有）就地解开——它已经没有语义了
    this.releaseLegacyHumanTimeoutPause('human-timeout');
    this.suspension = null;
    this.humanStallWarnedKey = null;

    const [hours, limitHours] = [hoursLabel(waitedMs), hoursLabel(this.humanTimeoutMs)];
    this.write(`[人审] 挂起 ${hours} 小时（上限 ${limitHours}）没等到答复：按"未批准"作废这条提问`
      + `${expiredPlan ? '、计划按 expired 结案' : ''}，${s.wakeSeqs.length} 条输入已重新入队（她继续干活）`);
    // 80% 那条提醒到此销账（它登记的是"正在等答复"，现在这件事已经办完了）
    void this.notifier.ok(CATEGORY.human, '到上限仍没人答：已按"未批准"处理并让她继续，提醒作废。');
    // 给用户一条**看得见**的提醒（普通告警：这是已经办完的事实，不是持续中的故障）
    await this.notifier.alert({
      category: CATEGORY.human,
      level: 'warn',
      title: `有一条提问等了 ${hours} 小时没答，已按"未批准"处理并让她继续：${questionPreview(s.question)}`,
      body: `turn ${s.turn} 从 ${s.askedAt} 起的提问「${s.question}」超过了 ${limitHours} 小时的等待上限。`
        + '框架的处置：这条待答作废（未获批准 ⇒ 需要批准的动作**没有执行**，批准位一格没写），'
        + `挂起解除，${s.wakeSeqs.length} 条输入重新放回队列——她继续干活，agent 不会因此停下。`
        + '还想让它执行，就再让她走一次申请/批准；详情见日志页的 human/timed-out。',
      params: { askSeq: s.askSeq, outcome: 'timed-out' },
    });
  }

  /**
   * 计划簿记：挂起那条提问对应的待批计划按 `expired` 结案（**绝不批准**）。
   *
   * 为什么要写这一条：`planApproved` 是"一次执行许可"，超时绝不能碰它；但 `planPending`
   * 里那一条如果留着，`PlanMode.decide` 此后会把同一件调用判成"已经在待批队列里"而拒绝
   * 重新落卡（`already`）——她就再也递不出这张单了。`plan/resolved{expired}` 是既有出口
   * （`PlanOutcome` 本来就有 `'expired'`，见 `plan-mode.ts` 的 `resolve`），结案时不写许可。
   *
   * 配哪一条：`plan/pending` 与 `human/asked` 同一个 turn（一次只拦一件调用，所以最多一条）。
   * 找不到就不写——宁可少一条簿记，也不猜一个 callId。
   */
  private expirePendingPlanOf(s: TrackedSuspension, waitedMs: number): boolean {
    const candidates = this.deps.projection.planPending.filter(item => item.turn === s.turn);
    const plan = candidates[candidates.length - 1];
    if (plan === undefined) return false;
    this.planMode.resolve({
      callId: plan.callId,
      tool: plan.tool,
      arguments: plan.arguments,
      outcome: 'expired',
      by: 'human-timeout',
      note: `人审挂起 ${hoursLabel(waitedMs)} 小时没答：按"未批准"结案（这个调用没有执行，也不会执行）`,
    });
    return true;
  }

  /**
   * 旧版本留下的"人审挂起超时暂停"**一次性解除**（2026-10-22）。
   *
   * 判据只有一条：`task` 层有记录，且**记录里的已用 < 上限**。
   *
   * 为什么这一条就够：预算撞线的口径是"当刻用量 >= 上限"（`BudgetGuard` 每一层同此，
   * step 层是 > ），所以 `actual < limit` 的记录**不可能是撞线**——它只可能是 2026-10-22
   * 之前那次"人审挂起超时按预算耗尽同等语义暂停"（现场 17:51 那条：limit 552000000 /
   * actual 67186217，正是本机现在这条）。真撞线的记录这里一律不碰：那是钱的事，
   * 归加注（`budget/topped-up`）与抬上限（`budget/resumed`）两条既有出口。
   *
   * 为什么解除必须落成事件（而不是只改投影）：投影是日志的折叠结果，重启会把同一条
   * `budget/exhausted` 重放一遍，暂停记录照样回来——那就等于没解。
   *
   * 用的就是既有机制：`budget/topped-up`（加注那条路的事件，fold 据此清掉该层记录），
   * `addedTokens: 0` 表示"不是加注，只是撤掉一条不属于预算的暂停"（与答复解除那条同形）。
   * 幂等：写完 fold 立刻删掉记录，下一次判据为空。
   */
  private releaseLegacyHumanTimeoutPause(by: 'human-answer' | 'human-timeout'): boolean {
    const record = this.deps.projection.lastExhausted['task'];
    if (record === undefined) return false;
    if (record.actual >= record.limit) return false; // 真撞线：不归这条路管
    this.appendSync('budget/topped-up', { layer: 'task', addedTokens: 0, by }, 'internal');
    this.write(`[预算] task 层那条旧记录（limit ${record.limit} / actual ${record.actual}）不是撞线：`
      + `已按"人审挂起超时"那条旧语义撤掉（by ${by}），唤醒门照常放行`);
    void this.notifier.ok(CATEGORY.budget, 'task 层那条"人审超时暂停"已撤掉（它不是预算撞线）。');
    return true;
  }

  /**
   * 把挂起 turn 认领过的输入送回队列（**答复到达与超时处置共用这一份判据**）。
   *
   * ── 重投之前先问一句：这条输入**还在她的上下文里**吗（v50，2026-10-10 修的真 bug）──
   *
   * 判据**只有一条**，落在**一个**点上（就是这里）：把"重投"按它进那一轮的位置分成两类——
   *   · `seq < 该轮 turn/start` ⇒ **上一拍就已经递到她眼前的那条输入**（当轮输入）；
   *   · 其余 ⇒ 本轮进行中才插进来的插话（`claimInterruption`），从头到尾还没被递过。
   * 只有**前一类**才需要再问一句"它还在吗"：**`seq <= 遮蔽点` ⇒ 它已经被
   * `compaction/summary` 折进摘要了**，她的上下文里没有它 ⇒ **不许再插一条**。
   *
   * 现场（逐项对照 1245/14 与 1246/1，本机 03:17）：那条 `input/requeued{human-answered}`
   * 把 `wake/manual`（**上下文压缩通报**，seq 72233）重新入队，而它早在 turn 1245 就被递过、
   * 且已经被后面那次压缩折掉 ⇒ 那一拍的请求里**同一个包裹出现两遍**：一条在历史最前面
   * （`[1]`：标题 + 三行正文 + 遮蔽点），新递的那条**插在历史中间**（`[42]` 附近）
   * ⇒ **它之后的一切错位**，`input=54396 / hit=16512 / miss=37884`（几乎全 miss）。
   * 日志自己的判词是 `cacheBreak.class='history' / cause='unattributable'`——
   * "指纹变了，但两次调用之间没有任何能解释它的事件"，因为那条错位**不是**某条事件的字节
   * 变化，而是**多了一条一模一样的通报**。
   *
   * 为什么这两条合起来就是对的（而且不必再看别的）：
   *   · **被折掉 = 摘要已经替她说过了** ⇒ 重投既改不了她的判断，又白赔一整段前缀；
   *   · **插话那一类照旧重投**：它还没被递过，重投是"第一次给她"（不多不少一条）；
   *   · **没压缩过**（遮蔽点 0）或**遮蔽点在它之前**的，一律照旧——重启打断 / 整轮失败
   *     那两条路要的正是"再给她一次机会"，`crash-injection.test.ts` 与
   *     `plan-askhuman.test.ts` 都盯着这件事。
   * **判据一处**：渲染层不重复判（`render` 照旧只认 `requeuedSeqsOf` 那个集合），
   * `agent-loop` 也不判——"哪条不该再递"是**投递**的决定，只落在这一处。
   */
  private requeueSuspendedInputs(
    s: TrackedSuspension,
    reason: 'human-answered' | 'human-timeout',
  ): void {
    const covered = this.coveredPointOf();
    const turnStartSeq = this.turnStartSeqOf(s.turn);
    const keepSeqs: number[] = [];
    const keepCounts: number[] = [];
    const keepSources: typeof s.sources = [];
    const folded: number[] = [];
    s.wakeSeqs.forEach((seq, i) => {
      const wasCurrentInput = turnStartSeq > 0 && seq < turnStartSeq;
      if (wasCurrentInput && seq <= covered) {
        folded.push(seq);
        return;
      }
      keepSeqs.push(seq);
      keepCounts.push(s.claimCounts[i] ?? 1);
      keepSources.push(s.sources[i] ?? 'manual');
    });

    if (keepSeqs.length > 0) {
      this.appendSync('input/requeued', {
        wakeSeqs: keepSeqs,
        claimCounts: keepCounts,
        sources: keepSources,
        reason,
      }, 'internal');
    }
    // 被折掉的那几条**如实记账**（不静默丢）：投影里它们不再回队列，日志里这一次要说清
    if (folded.length > 0) {
      this.write(`[人审] turn ${s.turn} 的挂起已结（${reason}）：${folded.length} 条输入**不再重投**`
        + `（早已递过、且已被上下文压缩折进摘要——遮蔽点 seq ${covered}：${folded.join('、')}）`
        + `：重投它只会把一条已经折掉的通报插回请求中间（那正是一次整段前缀失守的成因）`);
    }
    this.write(`[人审] turn ${s.turn} 的挂起已结（${reason}）：${keepSeqs.length} 条输入已重新入队`);
  }

  /**
   * **超时前提醒**（2026-10-22）：挂起到达上限的 80% 时发一次告警。
   *
   * 为什么要它：用户的现场是 06:32 被问、17:51 才有人发现——中间十几个小时界面上一句话都没有。
   * 上限的 80% 那条线给的是"还来得及回答"的窗口（默认 24h 上限 ⇒ 19.2h 处喊一声）。
   *
   * 三条口径：
   *   ① **同一挂起只提醒一次**：按 `askSeq` 记账（`humanStallWarnedKey`），重启后靠
   *      `notifier.windows()` 里同一个 (类别, askSeq) 指纹挡住（`warmUp` 用日志重建窗口）。
   *      答复/超时之后清账 ⇒ 下一次挂起重新提醒。
   *   ② **不编数字**：标题里的"已 X 小时"是**实测的已挂起时长**（不是 80% 那条线本身）——
   *      提醒晚到一拍时，它说的是真的等了多久。
   *   ③ **真撞预算线停着时不提醒**：那时她本来就跑不动，提醒也办不成事，
   *      而"预算耗尽"自己有一条 critical 告警。⚠ 2026-10-22 之后人审超时**不写**预算暂停，
   *      所以这一条只对真撞线生效（旧日志里那条"人审超时暂停"会在启动时被撤掉，
   *      见 `releaseLegacyHumanTimeoutPause`）。
   *
   * 用 `notifier.fail` 而不是 `alert`：它是"这条挂起正在发生"的故障登记，答复到达或超时处置时
   * `notifier.ok(CATEGORY.human)` 正好把这条销账。
   */
  private async maybeWarnHumanStall(s: TrackedSuspension): Promise<void> {
    if (this.deps.projection.lastExhausted['task'] !== undefined) return;
    const askedMs = Date.parse(s.askedAt);
    if (Number.isNaN(askedMs)) return; // 时间读不出来就不判：宁可不提醒，也不编一个时长
    const nowMs = this.deps.now().getTime();
    const elapsedMs = nowMs - askedMs;
    // 80% 是"提醒"的判据，上限仍是 humanTimeoutMs（到 100% 由 maybeTimeoutHuman 处置）
    if (elapsedMs * 5 < this.humanTimeoutMs * 4) return;

    const key = s.askSeq >= 1 ? `ask:${s.askSeq}` : `suspend:${s.turn}@${s.askedAt}`;
    if (this.humanStallWarnedKey === key) return;
    if (s.askSeq >= 1) {
      // 跨重启那一半：这个指纹发过 ⇒ 上一个进程已经提醒过同一条提问（别重启一次又催一次）
      const fingerprint = fingerprintOf(CATEGORY.human, humanStallParams(s.askSeq));
      if (this.notifier.windows().has(fingerprint)) {
        this.humanStallWarnedKey = key;
        return;
      }
    }
    this.humanStallWarnedKey = key;

    const [elapsed, limit] = [hoursLabel(elapsedMs), hoursLabel(this.humanTimeoutMs)];
    this.write(`[人审] 挂起已 ${elapsed} 小时（上限 ${limit} 小时）：提醒一次，到点就按"未批准"处理`);
    await this.notifier.fail({
      category: CATEGORY.human,
      level: 'warn',
      title: `人审挂起已 ${elapsed} 小时（上限 ${limit} 小时）：再不理就按"未批准"处理`,
      body: `turn ${s.turn} 从 ${s.askedAt} 起一直在等人回答「${s.question}」，已到 ${limit} 小时上限的 80%。`
        + '到上限就会把这条待答作废（未获批准 ⇒ 需要批准的动作**绝不执行**），'
        + '并且把她放回去继续干活——**不会**因此停下整个 agent。'
        + '现在回答还来得及：irmia answer，或界面上的申请单卡片。',
      // 指纹带上 askSeq：同一条提问只提醒一次，换一条提问是新的一件事
      params: humanStallParams(s.askSeq),
    });
  }

  /**
   * 答复探测（增量扫日志）。返回答复时刻；还没答复返回 null。
   *
   * 为什么不看投影的 waitingHuman：写事件的路径有两条——Web 的 appendSync 会当场折投影，
   * 而 CLI 的 answer 是在停机期间写下的，只有重启后 fold 才看得见。把「人答过了」这件事实
   * 押在某个投影是否被即时更新上，会把停机期的答复误判成「还在等」，然后白暂停一次。
   */
  private async detectAnswer(askedAt: string): Promise<string | null> {
    const asked = Date.parse(askedAt);
    let found: string | null = null;
    for await (const event of this.deps.log.readRange(this.humanCursor + 1)) {
      if (event.seq > this.humanCursor) this.humanCursor = event.seq;
      if (found !== null || event.type !== 'human/answered') continue;
      if (Number.isNaN(asked) || Date.parse(event.ts) >= asked) found = event.ts;
    }
    return found;
  }

  /** turn 因人审挂起而结束：把「谁的输入在等」记成进程态线索（事实本身已在日志里） */
  private async noteSuspension(
    batch: readonly PendingInput[],
    wakeEvents: readonly AppEvent[],
    beforeSeq: number,
  ): Promise<void> {
    // 挂起的那条提问从投影的队列里取（**只认系统来源**：她自己的提问不挂起，§6.5）。
    // 不能再用 waitingHuman 那一份——它是派生视图，取不到 askSeq。
    const ask = [...this.deps.projection.humanAsks].reverse().find(item => item.source !== 'agent') ?? null;
    // 投影没折到 human/asked 时（宿主可以只 append 不折）就从日志把刚写的 turn/start 读回来：
    // turn 号是恢复期退回输入与 replay 定位的键，不能靠猜
    const turn = ask !== null ? ask.turn : await this.turnOfRun(beforeSeq);
    this.suspension = {
      turn,
      // 0 = 这一刻不知道（宿主只 append 不折投影）。它不参与任何判定：答复走 CLI/Web 时
      // 按日志现扫（answerHuman 的 scanSuspension），那里拿得到真实的 seq
      askSeq: ask?.seq ?? 0,
      askedAt: ask?.at ?? this.deps.now().toISOString(),
      question: ask?.question ?? '',
      wakeSeqs: batch.map(item => item.wakeSeq),
      claimCounts: batch.map(item => item.claimCount),
      sources: wakeEvents.map(event => wakeSourceOf(event.type)),
      answeredAt: null,
    };
    // 新挂起 = 新的一件"等答复"：上一次挂起的提醒账不算数（同一 askSeq 仍由键挡着，
    // 但换了提问就必须能重新提醒一次）
    this.humanStallWarnedKey = null;
    this.write(`[人审] turn ${turn} 挂起等答复（${batch.length} 条输入待重入）`);
  }

  /** 刚跑完那个 turn 的编号（从 seq > beforeSeq 的 turn/start 读回） */
  private async turnOfRun(beforeSeq: number): Promise<number> {
    let turn = 0;
    for await (const event of this.deps.log.readRange(Math.max(1, beforeSeq + 1))) {
      if (event.type === 'turn/start' && event.data.turn > turn) turn = event.data.turn;
    }
    return turn;
  }

  // ──────────────────────────────── 折叠快照（M5-9） ────────────────────────────────

  /**
   * 写快照的两个触发点（design §4.12 的体量盘算）：
   *   ① **每天首次**（含启动后第一拍与跨天第一拍）：一天一个基线，冷启动最多重放一天的事件；
   *   ② **每 snapshotEveryEvents 条事件**：跑得猛的实例不必等到第二天。
   *
   * 顺序不可颠倒：**先写快照文件、再写 `snapshot/checkpoint` 事件**。于是事件里的 upToSeq
   * 恒小于该事件自身的 seq，恢复时它会被增量重放一遍（fold 里只更新 lastArchiveAt，结果一致）；
   * 反过来先写事件再写快照，事件声明的 upToSeq 就可能落在快照覆盖范围之外。
   *
   * 写失败只留一行日志：快照是派生数据（可删可重建），它的失败不该拖垮循环。
   */
  private async maybeSnapshot(): Promise<void> {
    const p = this.deps.projection;
    if (p.lastSeq === 0) return; // 还没有任何事件：没有可快照的东西
    const today = this.deps.now().toISOString().slice(0, 10);
    const firstOfDay = this.lastSnapshotDate !== today;
    const enoughEvents = p.lastSeq - this.lastSnapshotSeq >= this.snapshotEveryEvents;
    if (!firstOfDay && !enoughEvents) return;

    try {
      const written = await writeSnapshot(this.deps.dataDir, p);
      // 记账先于写事件：即使下面这条事件写失败，本进程也不会对同一位置反复写快照
      this.lastSnapshotSeq = written.upToSeq;
      this.lastSnapshotDate = today;
      this.appendSync('snapshot/checkpoint', { upToSeq: written.upToSeq, file: written.file }, 'internal');
      this.write(`[快照] 已写 ${written.file}（覆盖至 seq ${written.upToSeq}，${written.bytes} 字节）`);
    } catch (err) {
      this.write(`[快照] 写入失败，本轮跳过（下一个触发点重试）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ──────────────────────────────── 启动预热 ────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (this.ready === null) this.ready = this.warmUp();
    await this.ready;
    // 热更通报在预热跑完之前到达时**存着**（见 `notifyConfigReloaded` 的注释），这里补写：
    // 判据是"预热已经把 `mcpIndexText` 定下来了吗"——没定下来时那两行日志里的"当前几个 server"
    // 会与预热即将定下的索引对不上，读的人会以为热更丢了。
    const queued = this.pendingConfigReload;
    if (queued !== null) {
      this.pendingConfigReload = null;
      this.noteConfigReload(queued);
    }
  }

  /** 从日志重建四样跨重启的东西：告警限流窗口（M3-10）、人工加注累计（M3-5）、技能信任表（§4.19）与 turn 号 */
  private async warmUp(): Promise<void> {
    const events: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) events.push(event);
    this.notifier.restore(events);
    // 会话簿：从两种通道事件（叫她的 / 只记账的）与已读位折叠——
    // warmUp 本来就要读全量日志，顺手算，零额外扫描。
    this.sessionBook = collectSessionsFromLog(events);
    this.channelBookSeq = this.deps.projection.lastSeq;
    // **群成员回填**（2026-10-07 补上那道空档）：`collectSessionsFromLog` 只折会话簿，而运行期
    // 那趟 `foldChannelEvents` 还负责 `registerGroupMembers`（群成员自动档案）。游标一前移，
    // **重启前**到达的那些群 @ 就再也没人折——那些人永远进不了档案，她问"甲是谁"时框架只能
    // 给一串 openid。这里把那段已落盘的事件**只做"成员登记"这一件事**。
    //
    // 为什么不是那两种看起来能用的补法（前一个代理实测过，别再试）：
    //   · 把游标留在 0、让下一拍重折一遍 ⇒ 会话簿的条数与未读是**累加**出来的（applyChannelMessage
    //     在旧值上加），从 0 重折必然翻倍（实测 5 条变 10 条，channel-wire 两条用例红）。
    //     这条回填**一个字都不碰** `sessionBook` / `channelBookSeq` / `channel/read` 口径。
    //   · 在 warmUp 里直接补跑 `registerGroupMembers` ⇒ 那条路会给历史发言人**发占位号**
    //     （群友A、群友B…），而那个名字是持久的（落盘、`personNameOf` 优先读它），于是往后
    //     每一次引用这个人都带着一个"她其实没跟她打过交道"的占位名——那是污染。
    //     回填走的是 `GroupMemberBook.backfill`：**只登记平台给的事实**（id ↔ 昵称、在哪个群
    //     见过），没昵称就留空名，绝不编名字。
    //
    // 两条通道都适用：判据与运行期同源（`backfillGroupMembers` 读的就是 `mentionsMe`），
    // 官方那条给 `username`、OneBot 那条给 `sender.card`/`nickname`；平台没给就如实留空。
    const backfilled = this.backfillGroupMembers(events);
    if (backfilled !== null) {
      backfilled.save();
      this.write(`[群成员] 回填重启前攒下的人：${backfilled.size} 条（只登记平台给的事实，不发占位号）`);
    }
    // 注入预警与话题也在这趟全量读里补齐（内存表重启后是空的，而事件还在盘上）：
    // 预警必须能贴回它那条消息，话题必须能在清单上缀出来——两样都不现扫日志。
    for (const event of events) {
      if (event.type === 'injection/flagged') {
        this.flaggedNotes.set(event.data.messageId, {
          note: noteForFlagged(event.data), by: event.data.by,
          reason: event.data.reason, quotes: event.data.quotes,
        });
      } else if (event.type === 'injection/noted') {
        this.notedMessageIds.add(event.data.messageId);
      } else if (event.type === 'channel/topic' && event.data.topic.trim() !== '') {
        this.channelTopics.set(event.data.sid, event.data.topic);
        this.topicSeq.set(event.data.sid, event.data.toSeq);
      }
    }
    // **她说过话 / 有人叫过她**（v66，v67 加频次的素材）：与上面那份话题同一条路——warmUp 本来
    // 就在读全量日志，顺手折，零额外扫描。前两格取**最大值**、第三格按**事件序号水位**去重，
    // 所以与运行期那条增量折点重复折叠也无害（重启时新实例的水位从 -1 起，warmUp 照样把全量
    // 日志折一遍；而 `channelBookSeq` 若从低位起，下一拍重折同一批事件也不会算两遍）。
    this.foldSpokeAndMentionInto(events);
    // 人审挂起的重建（design §4.21）：答复常常是在实例停机期间写下的（CLI answer 与
    // review resolve 同一条纪律：两个进程各自 nextSeq 必然撞号），所以冷启动必须能从日志
    // 还原出「哪个 turn 挂着、它认领了哪些输入」，否则那些输入永远回不了队列。
    const lastSeq = events.length === 0 ? 0 : events[events.length - 1]!.seq;
    this.humanCursor = lastSeq;
    const hanging = scanSuspension(events);
    if (hanging.waiting !== null) {
      this.suspension = { ...hanging.waiting, answeredAt: null };
      this.write(`[人审] 重启时仍有挂起：turn ${hanging.waiting.turn} 等「${hanging.waiting.question}」（${hanging.waiting.wakeSeqs.length} 条输入待重入）`);
    } else if (hanging.answered !== null) {
      // 答复已写下但输入还没回到队列：直接进入「待重入」状态，下一拍就把它办完
      this.suspension = { ...hanging.answered.suspension, answeredAt: hanging.answered.at };
      this.write(`[人审] 停机期间收到答复（「${hanging.answered.answer}」）：turn ${hanging.answered.suspension.turn} 的输入将重新入队`);
    }
    this.setTopUps(foldTopUps(events));
    // **补写「已恢复」**（2026-10-05 修的真 bug）：上一次那串故障是**重启 + 改额度**解开的，
    // 而这个进程里再没有任何一刻会判"它解除了"（解除动作发生在上一个进程/人手里），
    // 于是运行情况页那条「预算耗尽」永远红着——见 alert/startup.ts 那一篇的现场说明。
    //
    // 先在**抬上限之前**读一次"当时还停着哪几层"：这一份只进补写的正文（它说得出
    // "上一次停的是哪一层"），不参与判定——判定用的是 `releaseLiftedPauses` 之后那一份
    // （见 `backfillResolvedAlarms` 里的 `pausedNow`）。两份都在这一小段里读，
    // 判据只有一处，不存在"两处各判一次"。
    const pausedAtStartup = pausedLayers(this.deps.projection);
    // 抬上限解除暂停：**启动时就判一次**。「设置 → 系统」那四项是启动参数，改完重启才生效，
    // 所以"改配置解暂停"这条路只可能在这里落地（判据看活的有效上限，见 releaseLiftedPauses）。
    // 必须排在 setTopUps 之后：有效上限 = 配置 + 加注累计，两个来源都齐了才能比；
    // 也必须排在 scanSuspension 之后：人审挂起在台上时 task 层要让路。
    this.releaseLiftedPauses();
    // 旧版本那条"人审挂起超时暂停"是一次性的历史：记录里 actual < limit ⇒ 它不可能来自撞线
    // ⇒ 就地把 task 层那条撤掉（判据与理由见 `releaseLegacyHumanTimeoutPause`）。
    // 用它而不是等 24 小时那条超时：本机现在这条（17:51 那条）就该在启动后第一拍解开。
    this.releaseLegacyHumanTimeoutPause('human-timeout');
    // **补写告警的账**（与上面那条 `budget/resumed` 是两件事：那条说"怎么解的"，
    // 这条把"已恢复"补给告警卡）。必须排在 `releaseLiftedPauses` **之后**：那一步会把
    // 抬上限解开的层从 `lastExhausted` 里清掉，清掉之后"当刻还停着哪几层"才是真正的答案
    // （还停着的层 = 上限没高过已用量的那些，见 `pausedLayers`）。
    await this.backfillResolvedAlarms(events, pausedAtStartup);
    // 信任门的真相源是日志：重启后谁被确认过必须原样重建，否则已生效的 skill 会集体掉出 catalog
    this.skills?.setTrustEvents(events);
    for (const event of events) {
      if (event.type === 'turn/start' && event.data.turn >= this.nextTurn) this.nextTurn = event.data.turn + 1;
    }
    // 布防放在最后：它要读定时器表（表由宿主在构造前 load 过），而且只该布一次
    await this.ensureMemoryMaintainTimer();
    // MCP 常驻索引（v46）：**启动也是"重大变化点"**（所有配置字段都要重启才生效，所以
    // "配置不动的那段时间"正好是这个进程的生命周期）⇒ 这里把索引定下来并落一条 `mcp/index`。
    // 放在最后：它要读配置面与落盘缓存，且**必须在第一拍认领输入之前**完成
    // （`ensureReady()` 在 `tickOnce` 的第一行，认领在后面）。
    await this.mcpIndexSync();
    // 技能常驻索引（2026-10-11）：与上一条**同一个"启动也是重大变化点"的判据**，也必须排在
    // `this.skills?.setTrustEvents(events)` 之后——信任表没装好时重建出来的是一条空索引。
    await this.skillIndexSync();
    // 进程重启的**留痕 +（异常退出时的）一次真唤醒**（2026-10-11）。也放在最后：
    // 它要与"上一任是怎么没的"的全部素材对齐（`session/end` 已经折完、`mcp/index` 已落），
    // 而那条 `wake/manual` 与其它唤醒同一条路（`applyOne` 折进共享投影 ⇒ 本拍认领 ⇒ 起 turn），
    // 所以它必须落在 `tickOnce` **认领输入之前**的那一段里——预热正好是那一段。
    this.announceRestart(events);
  }

  /**
   * 本进程起来时：落一条 `runtime/restart` 留痕，**异常退出后**再叫醒她一次。
   *
   * `events` 是 `warmUp` 已经读进内存的那一份全量事件（不再读第二遍盘）。
   *
   * ──────────────────────────── 判据（唯一一处） ────────────────────────────
   *
   * **什么算"异常退出"、要不要叫她**：逐条写在上面那一段头注释里（`oom` / `error` /
   * `killed` / `unknown` 四档，以及 `abnormal` 的算式）。这里只做三件事：
   * ① 把判据的**输入**凑齐（事件流、上一任的输出日志尾部、拉起器留痕、lock 里的旧 pid）；
   * ② 落留痕（**每次都写**——正常重启也写，只是不叫她）；
   * ③ 只有 `abnormal` 才追加那条真唤醒。
   *
   * ──────────────────────────── 去重（同一次启动只喊一次） ────────────────────────────
   *
   * 判据是**日志里有没有 `runtime/restart`**：有 ⇒ 这一任的留痕写过、该叫的也叫过了 ⇒ 整段
   * 返回（`startupRestartEvent` 那一行）。它挡的是"同一个进程里 `warmUp` 被跑第二次"，
   * 以及"有人把这条路接了两遍"——而**下一个进程**当然会再写一条（那是另一任，另一件事）。
   *
   * ──────────────────────────── 绝不拦启动 ────────────────────────────
   *
   * 全部探测都是"读不到就给 null"（见那一族函数的注释），任何一处失败都不许让 agent 起不来。
   */
  private announceRestart(events: readonly AppEvent[]): void {
    // 去重：这一任已经留过痕 ⇒ 什么都不做（见方法头）
    if (startupRestartEvent(events) !== null) return;

    const facts = restartFacts({
      events,
      argv: [...process.argv],
      env: process.env,
      now: this.deps.now(),
      pid: currentPid(),
      version: this.deps.version ?? 'unknown',
      ...(this.deps.restartProbe ?? restartProbeOf)(this.deps.dataDir, this.deps.now()),
      previousPidHint: this.previousPidHint(events),
    });

    const logged = this.appendSync('runtime/restart', {
      pid: facts.pid,
      version: facts.version,
      previous: facts.previous,
      launchedBy: facts.launchedBy,
      launchedEvidence: facts.launchedEvidence,
      argv: facts.argv,
      heapCap: facts.heapCap,
      wake: facts.note !== null,
    }, defaultVisibility('runtime/restart')) as AppEvent & { type: 'runtime/restart' };

    if (facts.note !== null) {
      // 走**既有那条真唤醒路径**（与压缩那条逐字同形，见 `handleCompactionWake`）：
      // `appendSync` 已经把留痕折进共享投影 ⇒ 本拍认领 ⇒ 真起 turn ⇒ 正文逐字进请求。
      // `dedupeKey` 挂在**留痕的 seq** 上（不是时刻）：同一任只可能算出同一个键，
      // 于是即便将来有人把这段接了两遍，队列那层的幂等键也拦得住第二遍。
      this.appendSync('wake/manual', {
        note: facts.note,
        via: 'restart',
        dedupeKey: `runtime-restart#${logged.seq}`,
      }, 'model');
    }
    this.write(
      `[重启] 本进程 pid=${facts.pid}（版本 ${facts.version}）·`
      + ` 上一任 ${facts.previous.pid ?? '未知'} ${facts.previous.death}${facts.previous.abnormal ? '（异常）' : ''}`
      + ` · 由 ${facts.launchedBy} 拉起 · 老生代上限 `
      + `${facts.heapCap.enabled ? `${facts.heapCap.limitMb ?? '未知'} MB` : '未启用'}`
      + `${facts.note === null ? ' · 正常重启：只留痕，不叫她' : ' · 已发一次真唤醒（via=restart）'}`,
    );
  }

  /**
   * 上一任的 pid：事件里查不到时退回 `lock.json` 里那个数。
   *
   * 为什么两处都要看：`session/start` 是**主**来源（它与版本号、起始时刻同一行），
   * 而"这一任之前那个 pid 是谁"在 lock.json 里更权威（写它的与拿锁的是同一个动作）。
   * 两处都读不到就是 null——**第一任与老日志都在这一档**，`previousRunVerdict` 会据此
   * 判"没有上一任的痕迹"（不叫醒她）。
   */
  private previousPidHint(events: readonly AppEvent[]): number | null {
    let seen = 0;
    for (const event of events) {
      if (event.type === 'session/start') seen += 1;
    }
    if (seen >= 2) return null; // 事件里就有上一任，`previousRunVerdict` 会自己取
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.dataDir, 'lock.json'), 'utf8')) as { pid?: unknown };
      return typeof raw.pid === 'number' && raw.pid > 0 && raw.pid !== currentPid() ? raw.pid : null;
    } catch {
      return null;
    }
  }

  // ──────────────────────────────── 每日记忆整理（design §4.17） ────────────────────────────────

  /**
   * 布防每日整理任务（§4.22 的 cron 语义）。幂等靠定时器表本身：重启后表里已有同类条目
   * 就不再注册——否则每启动一次多一个条目，整理任务会越跑越密。
   * cron 只在启动时读一次：它决定"什么时候做后台维护"，不是运行期要热更的开关。
   */
  private async ensureMemoryMaintainTimer(): Promise<void> {
    // 关掉框架代管记忆＝**不布防**（v32，见 docs/persona.md §3.1）：这一步是"框架替她做整理"的
    // 全部入口，布防了就一定会跑。落一行说明，别让人对着空表猜"是没到点还是没布上"。
    //
    // 已布防过的旧条目**不主动撤**：撤表是另一件事（表里可能还有她自己排的别的东西），
    // 而这条路上的双保险在 `memoryMaintainWake`——触发时它同样直接返回 null，整理 turn 不会跑。
    if (!memoryHostingEnabled(this.deps.config)) {
      this.write('[记忆整理] 记忆托管已关（persona.memoryEnabled = false）：每日整理未布防，'
        + '读、写、整理全归她自己');
      return;
    }
    const timers = this.deps.timers;
    if (timers === undefined) return;
    const cron = this.memoryMaintainCron.trim();
    if (cron === '') {
      this.write('[记忆整理] wake.memoryMaintainCron 为空：每日整理任务未布防');
      return;
    }
    const existing = timers.list().find(entry => isMemoryMaintainPayload(entry.payload));
    if (existing !== undefined) {
      this.write(`[记忆整理] 每日整理已在表里（${existing.cron ?? existing.at ?? '无到期时刻'}，id=${existing.timerId}）`);
      return;
    }
    const result = await timers.set({ cron, payload: { kind: MEMORY_MAINTAIN_PAYLOAD_KIND } });
    if (!result.ok) {
      this.write(`[记忆整理] 布防失败（cron=${cron}）：${result.error}`);
      return;
    }
    this.write(`[记忆整理] 已布防每日整理（cron=${cron}，id=${result.id}）`);
  }

  /**
   * **一条唤醒是不是"每日整理"**（判据的唯一一份实现，`memoryMaintainWake` 与注入给循环层的
   * `isFrameworkWake` 都走它）。
   *
   * **先认事件里带的 payload，再回退查表**。只查表是不够的：`at` 型定时器触发后条目就被
   * 删了，`timers.get(timerId)` 拿到 null，于是它的 payload 判不出来——`/dream` 排的唤醒
   * 会跑成普通 turn，她自己 `timer`（action=set）布的"到点提醒我做什么"也一并失效。
   * cron 型条目触发后保留，所以回退那半仍然有用（也兼容旧日志）。
   *
   * ⚠ **`memoryHostingEnabled` 那一格不在这里**：它是"这一拍认不认领"的门（关掉框架代管记忆
   * 时一条都不认领），而本函数只说"这条**是不是**整理唤醒"这个事实。两者混在一起会让
   * 循环层那一侧拿到"关掉时连排除都不做"——那是另一个判据，不该被这里顺手改掉。
   */
  private isMemoryMaintainWake(event: AppEvent): boolean {
    if (event.type !== 'wake/timer') return false;
    if (isMemoryMaintainPayload(event.data.payload)) return true;
    if (this.deps.timers === undefined) return false;
    const entry = this.deps.timers.get(event.data.timerId);
    return entry !== null && isMemoryMaintainPayload(entry.payload);
  }

  /**
   * 本批输入里是不是"每日整理"定时器唤醒：是就把它摘出来单独处理，不混进模型 turn。
   */
  private memoryMaintainWake(batch: readonly PendingInput[]): AppEvent | null {
    // **双保险**（v32）：关掉框架代管记忆时一条都不认领——即便定时器表里、或者旧日志里还留着
    // 整理条目（这一版之前布防的 cron、或者她自己 `/dream` 排的那条）。判据与布防、与索引注入
    // 是同一个函数，不另写一个；返回 null 之后这条唤醒落回普通 turn 的路（她若真要整理，
    // 那是她自己读、自己写的事，框架不替她做）。
    if (!memoryHostingEnabled(this.deps.config)) return null;
    for (const item of batch) {
      const event = this.deps.log.get(item.wakeSeq);
      if (event !== null && this.isMemoryMaintainWake(event)) return event;
    }
    return null;
  }

  /**
   * 跑一次整理。事件骨架与普通 turn 同形（turn/start → input/claimed →
   * memory/maintained → turn/end），崩溃恢复的口径因此完全一致：未闭合时 recover 补
   * turn/end{interrupted} 并把这条唤醒退回队列，下一拍重试整理——episode 已归档则无事可做，天然幂等。
   */
  private async runMemoryMaintain(wake: AppEvent): Promise<void> {
    const p = this.deps.projection;
    // 普通 turn 的号由 agent-loop 分配，这里取"两者较大值"，避免与它撞号（日志仍是唯一真相源）
    const turn = Math.max(this.nextTurn, (await this.maxTurnInLog()) + 1);
    this.nextTurn = turn + 1;
    const item = p.pending.find(candidate => candidate.wakeSeq === wake.seq);
    this.appendSync('turn/start', { turn }, 'internal');
    this.appendSync('input/claimed', {
      turn, wakeSeqs: [wake.seq], claimCounts: [item?.claimCount ?? 0],
    }, 'internal');
    let reason: TurnEndReason = { kind: 'completed' };
    try {
      // **人主动要的那次要 force**（2026-10-04 修的「/dream 按了没反应」）：
      // 常规整理只挑 `episodes/` 里**超过 7 天**的流水账（"过期才并"是设计），而 `/dream`
      // 的语义是"现在就做一次"——不 force 的话，只要没有过期流水账它就安静地空转
      // （`ops` 全 0、`diaryFile: null`），用户那边看起来就是按了没反应。判据用 payload 里的
      // `by: "human"`（web 那条路排的定时器带这个标记，见 web/server.ts 的 dream 动作）。
      const wakePayload = wake.type === 'wake/timer' ? (wake.data as { payload?: unknown }).payload : undefined;
      const requestedByHuman = readPayloadFlag(wakePayload, 'by', 'human');
      const result = await maintainMemory(this.deps.dataDir, {
        ds: this.deps.ds,
        now: this.deps.now,
        log: this.deps.log,
        projection: p,
        turn,
        out: this.write,
        ...(requestedByHuman ? { force: true } : {}),
      });
      this.write(`[记忆整理] ${result.reason}`);
      if (result.diaryFile !== null) this.write(`[记忆整理] 日记：${result.diaryFile}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reason = { kind: 'error', message, code: 'memory-maintain-failed' };
      this.write(`[记忆整理] 失败：${message}`);
    } finally {
      // 无论成败都结清这一 turn：整理是后台维护，一次失败不该卡住恢复流程
      this.appendSync('turn/end', { turn, reason, spoke: false }, 'internal');
    }
    // 每日整理那一拍顺带做一次 `%TEMP%` 兜底扫（2026-10-21）。
    // **放在 turn 之外**：清理是宿主维护，不该改写这一整轮的记忆整理结局，也不该因为整理
    // 失败就跳过（那正是"漏出来的东西没人收"的形状）。它自己吞掉所有异常（见方法注释）。
    await this.runDailyTempSweep();
  }

  /**
   * 每日一次的 `%TEMP%` 兜底扫：**只在这一拍**跑，账落日志与 `temp/swept` 事件。
   *
   * 三条分寸：
   *   · 没注入（测试台/嵌入方）⇒ 什么都不做，一个字节都不多写；
   *   · `off` ⇒ 不落事件（"关掉了"不是一次"扫了零个"的账）；
   *   · 扫失败/落账失败 ⇒ **吞掉**，只写一行日志——每日整理不能因为临时目录读不动而失败。
   */
  private async runDailyTempSweep(): Promise<void> {
    const sweep = this.deps.tempSweep;
    if (sweep === undefined) return;
    try {
      const report = await sweep();
      if (report.mode !== 'off') {
        // 载荷**唯一一处**构造（`tempSweptPayload`）：启动那一拍与这里必须同形，
        // 否则同一种账在日志里长两个样，事后没法按字段比对。
        this.appendSync('temp/swept', tempSweptPayload(report), 'internal');
      }
      this.write(formatTempSweepLine(report));
    } catch (err) {
      this.write(`[临时目录] 兜底扫失败（不拦整理）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 日志里已出现的最大 turn 号（普通 turn 由 agent-loop 分配，本模块只读它来保持编号连续） */
  private async maxTurnInLog(): Promise<number> {
    let max = 0;
    for await (const event of this.deps.log.readAll()) {
      if (event.type === 'turn/start' && event.data.turn > max) max = event.data.turn;
    }
    return max;
  }

  private setTopUps(totals: TopUpTotals): void {
    this.topUps = totals;
    if (this.guardIsInjected) return;
    this.guard = this.makeGuard();
  }

  /**
   * 当前的刹车判定器（`task` 子代理要它）。
   *
   * 为什么必须是**活的**、不能拷一份快照：有效上限含人工加注，而加注（`topup`）会把
   * `this.guard` 整个换掉（见 setTopUps / 跨天 rollover）。装配期拷一份，子代理的刹车就会
   * 一直按加注前的上限算——"我明明加过额度，子代理还是说超了"。
   *
   * 判定器本身是**无状态判定**：`checkBeforeStep(projection)` 只读传进来的那份投影，
   * `breachOf` / `limitOf` 同理，所以父子共用同一个实例不会串账——各自的账在各自的投影里
   * （子代理的投影从父投影的累计起算，见 subagent.ts 的 childProjectionOf）。
   */
  budgetGuard(): BudgetGuard {
    return this.guard;
  }

  /**
   * 判定器工厂：有效上限 = config.budget + 人工加注累计。
   * 加注抬高上限而不是清零消耗，所以"已消耗的 token"这条事实在任何时候都不被改写。
   */
  private makeGuard(): BudgetGuard {
    return new BudgetGuard({
      config: raiseLimits(this.deps.config.budget, this.topUps),
      projection: this.deps.projection,
      emit: (type, data, visibility) => {
        this.appendSync(type, data, visibility);
      },
      now: this.deps.now,
    });
  }

  // ──────────────────────────────── 依赖装配 ────────────────────────────────

  private agentDeps(wakeEvents: readonly AppEvent[]): AgentLoopDeps {
    const d = this.deps;
    // 豁免名单**轮首 refresh 一次**：渲染层那条"旧日志现算"的路（render 的兜底扫描）在这一轮里
    // 会被逐条消息问到，读的正是这份名单——"这一轮按哪份名单渲染"要在这里定死，而不是等某条
    // 消息渲染到一半时才发现盘上刚改过（口径：名单改完**下一轮**生效）。
    this.warnExemptBook().refresh();
    // 场合：最高档 = GUI/本机唤醒、官 bot 上用户 id 的会话（单聊与群聊都算）、她自己。
    // 其余（群里别人、陌生单聊、webhook）都是"软件里遇到的人"→ guest。
    // 本轮可信级别：**只判这一次**（`trustOfTurn`），下面两个消费点各取自己那半边：
    //   · `scenario` → 给 `authzGate` 的场景档：**执行期**那道门，这里要它；
    //   · `trust` → 只进 `budget/consumed.context.trust` 那一格账（纯观测，不进请求体）。
    // **不再有第三个消费点**：工具清单不读它（常量口径，见下面 `modelVisibility` 那段）。
    const trust: TurnTrust = this.trustOfTurn(wakeEvents);
    const scenario: Scenario = trust === 'owner' || trust === 'self' ? 'owner' : 'guest';
    // 本轮固定块的素材（B2）：**在这里读一次**，整轮共用同一份（见 turnBlockFacts）。
    // 读一次是这段代码的全部要点：`deriveRequest` 每步都会重新读 deps，而 deps 里的这份
    // 是**轮首快照**——一轮之内它逐字节不变，"不必每步重新编码"才成立。
    const turnBlock = this.turnBlockFacts();
    // 记忆索引（B2）：也在这里建/读一次。账目与注入用的是**同一份**索引——两处各读一次盘，
    // 就可能在"记忆刚好被改动"的那一拍记下与注进去的版本对不上的指纹。
    //
    // 关掉框架代管记忆时**不建也不读**（v32，docs/persona.md §3.1）：`memoryIndexPlan` 给一份空索引，
    // 于是注入的那段自然为空、账目如实记成"0 条、空指纹"——两处仍然同源，不需要在两侧各加一个
    // if（那样才有"账上说注入了、请求里却没有"的空间）。判据与理由都收在那个函数里。
    //
    // 阶段一（2026-10-15）：注入的那一段**不再是整张指针表**，而是"按最近话题挑的 top-6"
    // （用户原话那一版）。查询 = **最近 5 次用户输入的聚合** —— 那 5 条在这里一次取好，
    // 下面"注入"与"账目"两处**共用同一份**（两处各取一次就会漂成"挑的是一批、账上写的是另一批"）。
    const recentInputs = this.collectRecentUserInputs(wakeEvents);
    // 阶段二 ③（2026-10-19）：**整段可见历史**（不是最近 5 次输入）才是"在上下文里"的判据。
    // 只在开关打开时取（关着时一个字节都不该多读），一轮一次，下面注入与账目共用。
    const visibleHistory = d.config.persona.recallEnabled === true ? this.visibleHistoryText() : '';
    const { index, text: indexText, recommendation } = memoryIndexPlan(
      d.config,
      d.dataDir,
      this.ensureMemoryIndexSafely,
      ({ entries }) => (d.config.persona.recallEnabled === true
        ? recallRecommendation(entries, recentInputs, d.dataDir, visibleHistory)
        : selectMemoryRecommendation(entries, recentInputs)),
      // 兜底行那半句"索引之外还有什么"（2026-10-15 裁决②）：**宿主数一次**（只 readdirSync），
      // 渲染层不读盘。数不到就是 null ⇒ 文案写"若干"，绝不编。
      memoryIndexNeighbors(d.dataDir),
    );
    // 查询指纹：**一次算好**（下面注入账那一格与用例都要它）。空查询（最近 5 次都是空消息）
    // 记空串——"没有查询"与"查询是空串"在这里同义，而空串比一个假哈希诚实。
    const memoryQuery: MemoryQueryFingerprint = (() => {
      const built = recommendation?.query ?? { text: '', seqs: [], texts: 0, truncated: false };
      return { ...built, hash: built.text === '' ? '' : sha256Hex(built.text) };
    })();
    // 心跳轮**不注入**（2026-10-04 用户的口径：只有用户输入时才注入）：索引那一段整段不出现。
    // 判据与注入账用的是同一个 `isHeartbeatTurn`——两处各写一个判据迟早会漂成
    // "账上说没注入、请求里却有"。
    const heartbeatTurn = isHeartbeatTurn(wakeEvents);
    const authzGate = createAuthzGate({
      scenario,
      hardRefusal: d.config.tools.groupSceneHardRefusal === true,
      onDenied: (call) => {
        this.appendSync('authz/denied', {
          turn: call.turn,
          step: call.step,
          tool: call.tool,
          scenario,
          reason: call.reason,
          code: call.code,
        }, 'internal');
      },
    });
    // 场景鉴权 + 计划模式合成的那一道门。**一份实例两处用**（父循环与子代理链）：
    // 门本身无状态（判据读的是传入的 call 与上下文），两处各造一份只会有"其中一处漏了一条
    // 分支"的空间——而那正是"用 task 派个子代理就把审批绕过去"这类洞的成因。
    const toolGate: ToolPlanGate = {
      intercept: (call) => authzGate.intercept(call) ?? this.planMode.intercept(call),
    };
    return {
      log: d.log,
      ds: d.ds,
      registry: d.registry,
      projection: d.projection,
      // persona 用 **getter** 而不是拷快照：deriveRequest 每步都会重新读这些字段，
      // 而本方法每 turn 只装配一次。
      //
      // **state 这一格有两件事要说清**（2026-10-05 核实过，两条注释以前是混着写的）：
      //   ① **她上下文里那份状态**不再走这里——它由 `turnBlock` 携带（宿主轮首读一次的快照，
      //      见本文件 `turnBlockFacts()`）。所以她在 turn 内改 STATE.md，改动**下一轮**才进
      //      她自己的固定块（取舍记在 docs/memory-injection.md §2）；
      //   ② 但**任务卡**（此刻层那条 `当前任务：…` + `未完成计划：`）仍然每步现读这里的
      //      `state`——因为待办清单的载体就是 STATE 的两节（`persona/todo-state.ts`）。
      //      于是这个 getter 不是遗留物：`todo` 工具写完 STATE 会触发 `onPersonaUpdated`
      //      （main.ts 从盘上重载 `d.persona`），同一轮的**下一步**就看得见新清单。
      //      把这一格换成轮首快照，会让"她刚记下的待办下一步就不见了"。
      // 哈希仍取实时值：它是缓存破坏哨兵与 step/start 的指纹，本来就该反映"此刻盘上是什么"。
      persona: {
        get identity() { return d.persona.identity; },
        get constitution() { return d.persona.constitution; },
        get style() { return d.persona.style; },
        get state() { return d.persona.state; },
        get personaHash() { return d.persona.personaHash; },
        relationship: this.relationshipForCurrentWake(),
      },
      // 进模型清单的工具口径（§4.10 第三级门）：destructive 工具有没有「全开」或进名单，
      // 由配置说了算——以前这里恒为空对象，界面上把 destructive 打开也不会有任何效果。
      //
      // **这一行是恒定的**（2026-10-04 用户定稿"工具清单恒定"，2026-10-11 复核后恢复原设计）：
      // **不按信任级、不按会话增减**——`tools` 段只是这一格与注册表的函数，同一份配置下
      // 所有轮次逐字节相同。理由实测：清单随场景变会让它之后那整段历史的前缀缓存失效
      // （同签名命中 85.2% / 换签名 41.2%，最差 2%）。
      //
      // **`trust` 与它无关**（这一点别再改动）：本轮的可信级别不再进这一格。外部来源那几轮
      // 怎么收窄见 `docs/design.md:1029`——**不在工具清单层，在执行期**（`authzGate` +
      // `tools.groupSceneHardRefusal`；软提醒默认 / 硬拒绝由用户在 GUI 选，见
      // `authz.ts:16-18,20` 与 `channels_page.dart` 的"群聊场景"开关）。
      // `runtime/trust.ts` 的 `modelVisibilityFor` 与 `EXTERNAL_TOOL_ALLOWLIST` 都还在
      // （用例也还钉着，见 `test/trust.test.ts`），只是**刻意不调用**：它一旦接回这一行，
      // 清单就又开始按轮次变——那正是这条铁律禁止的事（工具数组只在**版本更新**时变）。
      //
      // ⚠ **曾经在这里接过一次**（`481db36`，v44：`modelVisibilityFor(trust, …)` + 同批
      // `RENDER_VERSION` 43 → 44）。那次是照 `docs/mcp-chain-review.md` 缺陷 ① 的 A1 口径做的，
      // 它按"把清单层白名单接回来"收窄了外部轮次；用户 2026-10-11 的裁决推翻了它
      // （"tool 数组是绝对不动的任何情况都不应该变动"⇒ 只有软提醒/硬拒绝两种选项，由用户在
      // GUI 选）。**不要照那份评审稿的 A1 把它再接回来**——要收窄就动 `authzGate` 那一层。
      modelVisibility: { includeDestructive: d.config.tools.destructiveEnabled },
      // **同一份 `trust` 原样递给账**（2026-10-11 加，纯观测）：只落
      // `budget/consumed.context.trust` 那一格。
      //
      // 为什么不能靠循环层自己反推：它读的是 `modelVisibility`，而上面那一行**已经是常量**
      // ——四档合出来是同一个形状，反推不出是哪一档。而"这一拍到底是用户轮还是外部轮"
      // 正是这张账要回答的问题（判据与场景那半边同源，见 `scenarioOf()`）。
      //
      // ⚠ 它**不进请求体**：`context` 是 `budget/consumed` 的观测面
      //（`ds-client.buildRequestBody` 不碰它），所以这一格**不改字节、不动 `RENDER_VERSION`**。
      trust,
      // 框架内部动作的判定（2026-10-11 加）：**判据只留一份**——就是本模块上面那个
      // `isMemoryMaintainWake`（它内部用的还是布防/认领共用的 `isMemoryMaintainPayload`）。
      // 循环层拿它把"整理唤醒"从轮内认领**与请求体**两条路上都排除掉，好让这条唤醒留在
      // `pending` 里，本 turn 结束后由下一拍的 `tickOnce`（上面 `memoryMaintainWake(batch)`
      // 那一处）正常认走、走整理。详细机制见 `AgentLoopDeps.isFrameworkWake` 那一篇注释。
      //
      // 为什么在这里注入而不是让循环层 import：判据的第二份实现必然与这一份漂开，
      // 而"哪些唤醒是框架自己的"这种判据漂开的后果是**静默的**（唤醒消失或重复认领）。
      isFrameworkWake: (event) => this.isMemoryMaintainWake(event),
      // 活动边界（`config.trust.mode`）：**装配层唯一的消费点**——判据是 config.ts 的
      // `trustBoundaryRoot`（'full' → null 完全信任 / 'workspace' → 只限 trust.workspaceRoot）。
      // 与 workspaceRoot 一样是启动期定下的（它进的是 `AgentLoopDeps`，每 turn 重新装配一次，
      // 但值来自同一份 config，改配置要重启才接管——GUI 的开关也是这么写的）。
      boundaryRoot: trustBoundaryRoot(d.config.trust),
      /**
       * **外部取消**（2026-10-16 接线）：`AgentLoopDeps.signal` 这个字段早就在了
       * （它的注释写着"外部取消（shutdown）：透传给模型请求与工具执行"），而这一格
       * **生产从来没给过** —— 于是除了关进程，没有别的东西能取消一条在飞的模型流。
       * 用户的 `/stop` 需要那件事，所以这里接上（见 `stopController` 的注释）。
       *
       * 缺省行为一个字节都没变：没按 `/stop` 时这条信号永远是未触发态，
       * 它只是被透传到 `DsRequest.signal`（`toDsRequest` 那一步）。
       */
      signal: this.stopController.signal,
      /**
       * 这条取消**是谁要的**（`/stop` 与关机共用同一条信号，处置却相反）：
       * 用户急停 ⇒ 本轮输入**不退回**（他刚说完"停下来"）；关机/宿主取消 ⇒ 照原口径退回队列。
       * 判据只在这一处产出（`stoppedByOwner`），循环层只读它。
       */
      signalCause: () => (this.stoppedByOwner ? 'stop' : 'signal'),
      now: () => d.now().toISOString(),
      timezone: d.timezone,
      budget: this.budgetHook(),
      // 上下文隔离（design §4.21）：主循环的上下文只有顶层事件。子代理链（parentCallId 非空）
      // 是它自己那条 turn 链的内部过程，进了父请求就等于让父模型看见"自己"没说过的话。
      //
      // 第二刀（B1 第二步）：**整条就是一条指令的 `wake/manual` 不进她的上下文**
      // （`/compact`、`/handoff`、以及打错的那些）。判据在 `isSlashCommandEvent`（唯一一份），
      // `replay` 用同一条重建，所以两边看到的仍是同一份事件。理由：指令是给框架的，
      // 不是对她说的话——少了这一刀，打错的 `/clear` 会在下一个 turn 的历史里当成一条
      // user 消息出现在她眼前，她就得去猜"用户是不是想清空什么"（B1 写明不许发生的事）。
      eventFilter: contextEventFilter,
      // 大结果外置（§4.12）：阈值与预览长度走 blob-store 的默认口径（估算 8k token / 2k 字符）
      blobOffload: { dataDir: d.dataDir },
      // **这里曾经接回复必要性门**（`necessityGate: …` → `gateAdmits`）：2026-10-05 拆掉了。
      // 现在**每一条唤醒都照常进 turn**，包括心跳拍——用户要的是"心跳真的发一次请求去保温
      // 供方缓存"（唤醒一次远比缓存前缀被回收便宜）。"开不开口"仍由她在 turn 里自己定。
      // 别再把它接回来：接回来就等于"沉默 = 一个请求都不发"，缓存又会被回收。
      // 见 docs/design.md「试过并废掉的口径：回复必要性门」。
      // 压缩点（persona.md §4、design §4.13 铁律 5）：turn 结束且可见历史估算超过 config 阈值时，
      // 由循环层写一份交接笔记作为 compaction/summary（历史只遮蔽、不改写）
      compaction: {
        thresholdTokens: d.config.persona.compactionThresholdTokens,
        budgetTokens: d.config.persona.handoffBudgetTokens,
        foldTokens: d.config.persona.handoffFoldTokens,
      },
      // 技能索引（§4.19）：与 MCP 索引**同一套缓存保护**（2026-10-11）。
      // ⚠ 它**不是**每 turn 现问 `SkillManager.catalogText()`（那样"批准装一个技能"会立刻改掉
      // 请求前缀 ⇒ 整段历史掉出 KV 缓存）：字节只来自日志里那条 `skill/index` 快照，
      // 由 `skillIndexSync` 在重大变化点（首次 / 模板换代 / 压缩之后）重建。
      // 读的是**实例上那份缓存**：本拍轮首刚更新过，且一轮只读一会 ⇒ 同一轮里不会抖动。
      skillCatalog: this.skillIndexText,
      // MCP 常驻索引（v46）：与技能索引**同段素材**（长期记忆层里紧挨着它）。
      // ⚠ 它**不是**每 turn 现渲染的：字节只来自日志里那条 `mcp/index` 快照
      // （轮首由 `mcpIndexSync` 按"重大变化点"重建），这样"加一个 server"不会改掉请求前缀。
      // 这一格是**实例上那份缓存**（`mcpIndexText`）：`mcpIndexSync` 在同一个 tick 的轮首
      // 刚把它更新过，而本轮认领输入发生在它之后 ⇒ 这里读到的永远是本拍定下的那一份。
      mcpIndex: this.mcpIndexText,
      // 记忆索引（B2）：`MEMORIES/INDEX.md` 的渲染形态——只有指针（路径 + 一行摘要 + !pinned），
      // 正文要她按需 safe_read。每 turn 重建一次索引文件（幂等：内容没变就不写盘），
      // 因为上一轮里她可能刚写过新记忆。见 persona/memory-injection.ts。
      // **心跳轮给空串**（整段不出现）：没人在跟她说话时，连指针表都不注入（用户 2026-10-04 的口径）。
      memoryIndex: heartbeatTurn ? '' : indexText,
      // 本轮固定块（B2）：轮首读一次的状态 / 关系档案。
      // **记忆正文不在这里**（2026-10-04 用户的口径：「只看索引，如果需要，heavy 自己去读，
      // 随后跟随 tool call 留在上下文」）：机制不再替她挑几条正文塞进来，固定块里关于记忆的
      // 只有上面那份索引（指针表）。她需要哪一条就照索引 safe_read——读回来的内容作为工具结果
      // 留在历史里，长期命中前缀缓存；代价是她得自己想起来去读（见 docs/memory-injection.md §5）。
      turnBlock,
      // **「本任务相关资产」那一行不再给了**（v45，2026-10-09 用户拍板取消「light 选取资产」
      // 这条机制）：原来这里传的是轮首挑好的 `this.assetsLine`。删掉的是**值**，不是格子——
      // `assetLine?` 这个字段本身留着，因为它是**逐字节重建旧日志**那条路要用的：
      // `memory/selected.assets`（v34 起搭着记忆索引的账落库）里记着当时那一行，
      // 重放（`runtime/replay.ts` 的 `assetsFromEvents`）与界面预览（`web/server.ts` 的
      // `assetsLineAt`）都从事件取回它——把字段一起删掉就等于**改写历史**（旧日志重放出来会比
      // 当时少一整行，`test/replay.test.ts` 的 v34 用例钉着这件事）。
      // 于是：新的一轮**一个字都不给**（那一行不再出现在请求体里），旧的请求仍重建得回来。
      // 空串 = 整行不出现（渲染层那一条判据在 `render.ts` 的此刻层）。
      assetsLine: '',
      // STATE 预算（v32）：宿主装配 deps 时读一次配置（启动期参数），循环层每步原样转手。
      // 「她的 STATE 有多少字节」不在这里量——deriveRequest 从 `persona.state` 量，
      // 重放与界面预览因此拿到同一个数（三处判据一致，见 agent-loop 的注释）。
      stateBudgetBytes: d.config.persona.stateBudgetBytes,
      // 维护窗口（2026-10-11）：**轮首算好的那一格**（`maintenanceWindowFor` 在 `prepareTurn`
      // 里、装配本方法之前算一次），整轮每个 step 原样转手。
      // 它是纯提示：不进判据、不改任何文件（用户的红线"框架只给信号"）。
      maintenanceWindow: this.maintenanceWindowNow,
      // 压缩预警（2026-10-15）：**不是一个值，是一个判据函数**——`TurnRunner.run` 在写
      // `compaction/decision` 之前调它，它当场判、需要时当场发那条真唤醒，并把结论交回来落账。
      // 为什么不在 prepare 段算成一个值：判据用的那个数（可见历史估算）本来就每轮收尾算过一次
      // ——在收尾判才能与压缩判定**同一个数、同一刻**；在 prepare 判只能读上一轮的读数，
      // 既慢一轮、第一拍还必然是"没有读数"（判不出来）。
      // 绑一下 `this`：这一格是**函数**（不是值），循环层会拿着它直接调——传方法引用会丢上下文
      compactionWarning: (historyTokens, reason, thresholdTokens) =>
        this.handleCompactionSoonWarning(historyTokens, reason, thresholdTokens),
      // 记忆索引注入账（B2）：宿主给"注入了没有 + 当时注入那一段的指纹与条数 + 挑出来的是哪几条"，
      // 循环层在轮首写 `memory/selected` 事件（那一段全文不落事件，见那个事件的注释）。
      // 心跳轮（只有 wake/heartbeat）记 injection:'heartbeat'——那一轮不注入（docs §5）。
      // 阶段一（2026-10-15）：`selected` / `scores` / `query` 三格与那一段**同源**——
      // 它们都由上面同一个 `recommendation` 与同一份 `memoryQuery` 来，不在这里重算。
      memorySelector: ({ wakeEvents: turnWakes }) => this.planMemorySelection(
        { recommendation, text: indexText },
        memoryQuery,
        turnWakes,
      ),
      // 联络方式（装置自述的状态层那一半）：配置事实 + 本轮唤醒来源
      contact: this.contactFacts(),
      // 本机与用度（此刻层 `本机：` / `用度：` 两份素材）：**只能在这里算**——os/fs 与投影都
      // 在宿主手上，而渲染层是纯函数（不读环境值，缓存铁律 1）。一 turn 算一次。
      machine: this.machineFacts(),
      usage: this.usageFacts(),
      // 豁免判据（显式入参那条路）：渲染层"旧日志现算"的兜底扫描要问它。判据仍是
      // `WarnExemptBook.isExempt` 这一处实现，宿主在这里递一次、每步原样转手（渲染不读盘）。
      // 名单只在本方法开头 refresh 一次——粒度就是"轮"（改完下一轮生效）。
      warnExempt: (subject: WarnExemptSubject) => this.warnExemptBook().isExempt(subject),
      // 收尾计时（BUG-4）：循环层只提供这一格，整轮时长由 `tickOnce` 量（它才知道 `runTurn`
      // 是从哪一刻起的）。**纯观测**：压缩判据、遮蔽点、写不写摘要一个都不看它。
      onTurnTiming: (timing) => { this.lastTurnTiming = timing; },
      // 缓存破坏哨兵的阈值（config.contextAudit）：观测阈值，只决定"要不要记一条 cacheBreak"
      cacheBreakThresholds: {
        idleMs: this.deps.config.contextAudit.cacheBreakIdleMin * 60_000,
        hitDrop: this.deps.config.contextAudit.cacheBreakHitDrop,
      },
      // 通道消息的显示名（v32 → v76 才真的接通）：名字的真源在她的别名表与人的联系人表里，
      // render 是纯函数，所以由这里算好递进去。**只服务本轮钉住的那条唤醒**（`wakeEvents[0]`，
      // 与 `agent-loop` 的 `pinnedWake` 同一条；历史一律裸 openid，见 render.ts 的 `contextFor`）
      // ——`AgentLoopDeps` 的必填格让"忘记传给 deriveRequest"变成编译错误
      //（审计 P0 的病根就是那一格静默丢了）。
      channelRender: this.channelRenderContext(wakeEvents[0] ?? null) ?? null,
      // 「有人插话」的计数读取器：speak 开口时取基准，等待中比它有没有变。
      // 用**函数**而不是当前值——打断发生在 speak 执行途中，那一刻的值才是要用的值。
      interruptEpoch: () => this.interruptEpoch,
      // 图片直通（design §4.20 的图片两条途径之一）：把附件引用换成**一份模型认的图片载荷**
      // （型别 + data URL），让模型亲眼看。渲染层拿不到字节，这条能力只能由宿主注入。
      // 关掉（config.vision.imagesToContext=false）就是"一张都不进上下文"——只剩消息里的
      // 地址与 vision_read 的文字转述。
      //
      // 2026-10-07（P0）：这里返回的是 `readAttachmentImage` / `readFileImage` 的结论，
      // **不是**裸 URL 串。旧实现把附件声明直接当 MIME 拼成 `data:image;base64,…`
      // （OneBot 的段类型是裸标签 `image`），模型判 unsupported image ⇒ 400 ⇒ 那条消息
      // 留在历史里，**每一拍都失败**。现在型别由字节头说了算，认不出就不进。
      ...(d.config.vision.imagesToContext
        ? {
          loadImage: (ref: RenderImageRef) => {
            const read = ref.source === 'file'
              // 工作目录内的文件：与文件工具同源（agent-loop 的 workspaceRoot 默认值就是 cwd）。
              // 等"工作根该是什么"定下来之后，这里跟工具一起收口成同一个显式配置。
              ? readFileImage(
                isAbsolute(ref.key) ? ref.key : resolve(process.cwd(), ref.key),
                ref.mime,
                CONTEXT_IMAGE_HARD_BYTES,
              )
              : readAttachmentImage(d.dataDir, ref, CONTEXT_IMAGE_HARD_BYTES);
            // **进不去要有痕**（2026-10-21）：这是"最后一米"，渲染层拿不到字节就**按设计静默跳过**
            // （正确降级：不能为少一张图让请求 400）。可它同时也是"这张图从没进过她的上下文"
            // 唯一说不出口的地方——实测 14 张 >1.5MB 的图永远进不去，日志上一个字都没有。
            // 留痕落事件（internal，不进请求体），同一张同一个理由只留一次（见 `traceImage`）。
            if (!read.ok) {
              this.traceImage({
                kind: 'skipped',
                stage: 'render',
                reason: read.reason,
                ref: ref.key,
              });
              return null;
            }
            return read.image;
          },
        }
        : {}),
      maxContextImages: d.config.vision.imagesToContext ? d.config.vision.maxContextImages : 0,
      // **step 边界的图片预取**（2026-10-21）：循环层每步在 `syncEvents` 之后调它一次。
      // 为什么必须由这一步补：turn 运行期间 tick 整拍被丢（`tickInFlight`），挂在 tick 上的
      // 预取根本轮不到，于是"tick 预取之后、下一拍组装之前"到达的图必然无字节可注。
      // 判据与预算都在实现里（限最近 N 张 / 并发 ≤2 / 4 秒预算），循环层只给 5 秒硬顶。
      prewarmStepImages: () => this.prewarmStepImages(),
      // **step 边界的申请单拾取**（2026-10-21）：与上面那条同一个理由——turn 运行期间 tick
      // 整拍被丢（`tickInFlight`），挂在拍上的 `settleGrants` 轮不到，她中途递的单子要等
      // 这一轮说完才挂出来（实测 57s / 1m47s / 4m57s）。循环层每步在 `syncEvents` 之后调一次。
      // 实现里**先重读事件视图**再判幂等（判据与代价见 `settleGrantsAtStep` 的注释）。
      settleGrantsStep: () => this.settleGrantsAtStep(),
      // 执行点钩子（§4.19）：三个执行点都在循环与执行器内部，装配一次即可全生效
      ...(d.hooks !== undefined ? { hooks: d.hooks } : {}),
      // **场景鉴权门**（2026-10-04 用户定稿）：清单恒定之后，"客人能不能碰这台机器"在这里判。
      // 与 plan 模式共用同一个挂点：场景先判（这是安全问题），过了再看要不要请人批准。
      planGate: toolGate,
      // `task` 子代理（design §4.21）：这一格补的是**只有循环才知道**的那三样，与装配点
      // 那半格子合并后才是一份完整素材（见 tools/catalog.ts 的 taskRuntime）。
      //
      // 三样都必须与父**共用同一个实例**：`planGate` 让子代理内的 destructive 调用照旧
      // 请人批准（不传它 = `task` 成了一条绕过事前审批的路），`guard` 是与父同一个判定器
      // （活取，见 budgetGuard()——加注会把实例换掉），`hooks` 是同一份执行点钩子。
      ...(d.taskRuntime === undefined ? {} : {
        taskRuntime: {
          ...d.taskRuntime,
          guard: this.budgetGuard(),
          planGate: toolGate,
          ...(d.hooks === undefined ? {} : { hooks: d.hooks }),
        },
      }),
    };
  }

  /**
   * 此刻的联络事实（装置自述的状态层那一半，见 model/self-brief.ts）。
   *
   * 三个来源都是事实，不做推测：通道开关读生效配置；告警出口看 webhookUrl 是否为空；
   * 「本轮能否回投」用 admin 的 `replyableWakeChannel`——与 speak 第三路同一个判据，
   * 因此提示词里说能发的时候，speak 一定真的发得出去。
   */
  private contactFacts(): ContactFacts {
    const config = this.deps.config;
    return {
      qqOfficial: config.channels.qqOfficial.enabled,
      onebot: config.channels.onebot.enabled,
      alertWebhook: (config.alerts.webhookUrl ?? '').trim() !== '',
      wakeChannel: replyableWakeChannel(this.wakeChannelData),
      // 外部会话清单：她要指定对象时手里得有 sid，而这是唯一一处告诉她"外面有谁"的地方
      sessions: this.sessionBook,
      // 别名每轮现读：那是她自己维护的文件，改完下一轮就该生效（小文件，一 turn 读一次）
      aliases: this.readAliases(),
      // 联系人表：人声明的事实（谁是用户、这个群是什么），优先于她自己的别名
      contacts: new Map(Object.entries(config.persona.contacts)),
      // 发言人 → 名字：**这一个**判据也交给渲染层（v47），此刻层的「预警：」那一行与点名那句
      // 用它写人名。为什么由宿主注入而不是让渲染层自己查表：名字真源的最后一档要读
      // `data/group-members.json`（渲染层不读盘），而少一档就等于第二份判据——两份判据漂移
      // 的后果正是 2026-10-11 修的那一处（同一份上下文里"用户（阿岚）"与"1234567890"并存）。
      personNameOf: (person: string) => this.personNameOf(person),
      // 本轮唤醒的那条通道消息：只用来判"这轮是不是群里有人 @ 了我"。
      // 取的是**原始唤醒数据**而不是 `replyableWakeChannel` 的结论：那个判据问的是"能不能
      // 回投"（只认 c2c/group-at），而这里问的是"谁点了我的名"——将来的 `group` 全量模式
      // 也该能 @ 她。少一层转手，两个问题就不会被同一个判据绑在一起。
      wakeMessage: this.wakeChannelData,
      // 各会话"在聊什么"（信箱模型的中间那层）：清单那一行缀的半句
      topics: this.channelTopics,
      // 清单的"该不该列这个会话"素材（v66 两格，v67 加第三格）：1 小时内有人 @ 她 / 她回复的
      // 频次（时刻表，窗口由渲染层按 `SESSION_FREQ_WINDOW_MS` 数）。这里只给**折出来的事实**。
      spokeAt: this.spokeAt,
      mentionedAt: this.mentionedAt,
      spokeTimes: this.spokeTimes,
    };
  }

  /**
   * 本机事实（此刻层 `本机：`）：系统平台 · 进程已运行多久 · 工作根 · 磁盘剩余。
   *
   * 为什么由这里算、而不是在 render 里读：渲染层是纯函数（不读 os、不读 fs，缓存铁律 1），
   * 这些值只有宿主拿得到。四项里磁盘那一项最要紧——**存续**：日志、快照、记忆都写在 dataDir
   * 这个卷上，写满就出事，而她得在出事之前看见它。读不到就如实空着，不猜。
   *
   * `uptimeMs` 取的是**本进程**的已运行时间（`process.uptime`）：她据此知道自己重启过没有
   * （重启会打断一个 turn，那是她会困惑的事）。系统开机时长是另一回事，不混进来。
   */
  private machineFacts(): MachineFacts {
    const workspaceRoot = join(this.deps.dataDir, DEFAULT_WORKSPACE_DIR_NAME);
    return {
      platform: `${PLATFORM_LABELS[osPlatform()] ?? osPlatform()} ${osRelease()} ${arch()}`,
      uptimeMs: Math.round(process.uptime() * 1000),
      workspaceRoot,
      // 工作根与 dataDir 在同一个卷上（同一棵树），先问工作根；它还没建出来时退回 dataDir
      disk: readDiskFacts(workspaceRoot) ?? readDiskFacts(this.deps.dataDir),
    };
  }

  /**
   * 用度事实（此刻层 `用度：`）：今日 token 与生效日上限、缓存命中样本、连续失败数。
   *
   * 数全部来自投影（它是日志的折叠结果，不另扫日志）；上限取 `guard.limitOf('daily')`——
   * 那正是刹车实际用的那个数（配置 + 人工加注），所以"占了多少"与她会不会被拒绝唤醒同源。
   * 一拍一算（与 contact 同节奏）：这是"今日累计"，不必精确到每一个 step。
   */
  private usageFacts(): UsageFacts {
    const p = this.deps.projection;
    return {
      tokensToday: p.budget.tokensToday,
      dailyLimit: this.guard.limitOf('daily'),
      cacheHitTokens: p.budget.cacheHitToday,
      cacheMissTokens: p.budget.cacheMissToday,
      failStreak: p.failStreak,
      failStreakMax: this.deps.config.budget?.failStreakMax ?? null,
    };
  }

  /**
   * 把最近到达的图片附件补落到本地（`<dataDir>/blobs/images/<sha256(url)>`）。
   *
   * 为什么不能只在"认领时预热本批唤醒"：图片经常在**她正忙着一个 turn** 的时候到达。
   * 那个 turn 认领的是更早的一条消息，而新到的 `wake/channel` 会立刻作为后续 step 的
   * 历史出现在她眼前（事件流只追加）。实测就是这样：她看见了文件名与临时链接、画面没进来，
   * 只好自己 `http_download` 下来才看到——因为那张图的落盘只覆盖"本轮认领的唤醒"，
   * 而它还在队列里没被认领。
   *
   * 所以扫的是**事件**（带游标，只补新来的），而不是队列：队列里那条迟早会被认领，
   * 但**在她看见它的那一刻**字节就得在。重启后游标归零，从窗口起点补一次。
   *
   * ── 2026-10-21：为什么还有 `stage: 'step'` 这条路 ────────────────────────────
   *
   * 预取原先只挂在**拍**（`tickOnce`）上，而一整个 turn 会把拍占住：`tickInFlight` 让 turn
   * 运行期间的到点**整拍丢弃**（`tickOnce` 里 `runTurn` 是 await 的）。于是"tick 那次预取之后、
   * 下一拍组装之前"到达的图，这一拍的请求里必然还没有字节——实测 106 个私聊图附件里
   * **34 个错过首拍**。现在循环层在每个 step 边界再调一次（`agentDeps` 的 `prewarmStepImages`），
   * 主路因此是 step 边界，tick 这一条留着覆盖"没人在跑 turn"的空闲期（与重启补扫）。
   *
   * ── 三条约束（2026-10-21 加，`stage==='step'` 时最要紧）─────────────────────
   *
   *   • **限最近 N 张**（N = `vision.maxContextImages`）：渲染层只挑最近 N 张，多下的这一拍
   *     根本进不去。更早的**不丢**，进 {@link prewarmPending} 队列等下一拍（上限 32，超了留痕）；
   *   • **并发 ≤2**（{@link PREWARM_CONCURRENCY}）：图片成批到达时别把这一拍的等待全占满；
   *   • **有预算**（`budgetMs`，缺省 {@link PREWARM_BUDGET_MS}）：到点就停，剩下的留给下一拍。
   *     循环层那侧还有 5 秒硬顶兜底（`STEP_PREWARM_TIMEOUT_MS`）——它在实现层挂住时生效。
   *
   * 为什么必须先落盘：QQ 的富媒体是**临时直链**（带 rkey），过期之后服务端拒绝下载，
   * 而那条消息永远留在历史里——直链进上下文等于给那条历史判了无期 400
   * （详见 channel/attachment-store.ts）。失败只意味着这张图这一轮进不了上下文：
   * 消息里的地址还在，她照样能用 http_download 自己取、或者让 vision_read 转述。
   *
   * 2026-10-07（P0）加的两条：
   *   • **形态上就不可能进的图连下都不下**（地址不是 http(s)、型别不在白名单）——它们不是这一条
   *     路的材料，去下载只是白花一次网络与超时，然后留下一行看不出所以然的失败；
   *   • **没进就写清楚为什么**：留痕里那句"这张不进上下文（理由）"是 `not-http-url` /
   *     `unknown-media-type` / `no-local-bytes` / `too-large` 里的一个，逐条对应
   *     `contextImageSkipText` 的人话。不静默丢：地址与文件名照旧在附件那行事实里，
   *     她要用就 vision_read 转述或者自己 http_download。
   *   2026-10-21 起这些留痕**落成 `image/trace` 事件**（此前只有一行 stdout，重启就没）。
   */
  private async prewarmRecentAttachments(
    options: { stage: 'tick' | 'step'; budgetMs?: number } = { stage: 'tick' },
  ): Promise<void> {
    // 名额跟着"同时能待在上下文里的图片张数"走：关掉图片直通（0）时一张都不下
    const limit = this.deps.config.vision.imagesToContext
      ? Math.max(0, this.deps.config.vision.maxContextImages)
      : 0;
    if (limit === 0) return;
    // 重叠让路：tick 与 step 两边都调它，上一趟还在跑时后来者直接走（那一趟最多 4 秒，
    // 下一拍自然补上）。排队反而会积压——预取的目标是"最快的下一次机会"，不是"一个不漏地都跑"。
    if (this.prewarmBusy) return;

    const lastSeq = this.deps.projection.lastSeq;
    if (lastSeq <= this.attachmentScanSeq && this.prewarmPending.length === 0) return;

    // ── 扫新事件：形态上就进不了的当场留痕；能进的进队列（本地已有字节的不占名额）──
    if (lastSeq > this.attachmentScanSeq) {
      // 从游标往后扫，首次（或重启后）最多回看一个窗口——不为了几张图把整份日志翻一遍
      const from = Math.max(this.attachmentScanSeq + 1, lastSeq - ATTACHMENT_SCAN_WINDOW + 1);
      for (let seq = from; seq <= lastSeq; seq += 1) {
        const event = this.deps.log.get(seq);
        if (event === null || event.type !== 'wake/channel') continue;
        for (const attachment of event.data.attachments ?? []) {
          if (typeof attachment.url !== 'string' || attachment.url === '') continue;
          // 判据与渲染层**同一个函数**（MIME `image/png` 与 OneBot 的段类型 `image` 都算图）：
          // 两处各写一份的话，"预热了但没注入"或反之会静默地各错一半。
          if (!isImageAttachment(attachment)) continue;
          // 第二道：**载荷形态**那条判据（也是渲染层挑图时用的同一条）。过了它才值得去下载。
          const admission = contextImageAdmission({ url: attachment.url, mime: attachment.type });
          if (!admission.admitted) {
            const reason = admission.reason ?? 'unknown-media-type';
            const label = shortRefLabel(attachment.url);
            // 形态上就不可能进：不下载、不留半个文件，但**留痕说清是哪一条判据挡的**
            this.write(`[图片] 这张不进上下文（${contextImageSkipText(reason)}）：${label}`);
            this.traceImage({ kind: 'skipped', stage: 'prewarm', reason, ref: attachment.url });
            continue;
          }
          this.enqueuePrewarm(attachment.url);
        }
      }
      this.attachmentScanSeq = lastSeq;
    }

    if (this.prewarmPending.length === 0) return;

    // ── 取"最近 N 张"下（更早的留在队列里，下一拍再说）──
    // 顺序：`prewarmPending` 是到达顺序，取末尾 N 个 = 最新的 N 张（与渲染层挑图同一个窗口）。
    const batch = this.prewarmPending.splice(Math.max(0, this.prewarmPending.length - limit));
    for (const url of batch) this.prewarmPendingSet.delete(url);
    const deadline = Date.now() + (options.budgetMs ?? PREWARM_BUDGET_MS);
    // 预算用完时没轮到的那些**按原顺序**放回队列尾（不能按完成顺序放回：那会打乱"最近"的判据）
    const deferred = new Set<string>();
    this.prewarmBusy = true;
    try {
      await forEachBounded(batch, PREWARM_CONCURRENCY, async (url) => {
        const remaining = deadline - Date.now();
        // 预算用完了：这一张与后面的都留给下一拍（**不是失败**，所以不留"取不回来"的痕）
        if (remaining <= 0) {
          deferred.add(url);
          return;
        }
        const label = shortRefLabel(url);
        // 单张的下载/压缩超时跟着剩余预算走：超预算的活儿不该在这一拍里起。
        // ⚠ 诚实的边界：下载与压缩是**串行**的，各拿"起跑那一刻的剩余" ⇒ 极端情况下
        //   （下载几乎用满 4 秒、随后又起压缩）这件活儿会越过 5 秒在后台继续跑。
        //   允许它跑完是刻意的：**这一拍不等它**（循环层那 5 秒硬顶生效），而它跑完的
        //   产物（.ctx.jpg / 落盘）下一拍就能用；掐掉只会白烧一次进程。
        const outcome = await ensureAttachment(this.deps.dataDir, url, {
          timeoutMs: Math.min(DEFAULT_ATTACHMENT_TIMEOUT_MS, remaining),
          compressTimeoutMs: Math.min(DEFAULT_COMPRESS_TIMEOUT_MS, remaining),
        });
        if (outcome.outcome === 'failed') {
          this.write(`[图片] 附件取不回来（${outcome.reason}）：${label}`);
          // 下载失败按 `no-local-bytes` 记（理由码只有这一套；具体原因写在 line 里）
          this.traceImage({
            kind: 'skipped', stage: 'prewarm', reason: 'no-local-bytes', ref: url,
            line: `${contextImageSkipText('no-local-bytes')}——这次取不回来的原因：${outcome.reason}`,
          });
          return;
        }
        if (outcome.outcome === 'skipped') {
          this.write(`[图片] 这张不进上下文（${outcome.reason}）：${label}`);
          this.traceImage({
            kind: 'skipped', stage: 'prewarm', reason: 'too-large', ref: url,
            line: `${contextImageSkipText('too-large')}——这次的具体读数：${outcome.reason}`,
          });
          return;
        }
        // 压缩失败不算错（原件还在），但**不许噤声**：原因落成一条 image/trace。
        // 实测（2026-10-21 前的数据）：42 个 >400KB 的原件走过这条分支，0 个 .ctx.jpg，
        // 日志里一个字都没有——只能从"产物不存在"反推。
        if (outcome.compressFailure !== undefined) {
          this.write(`[图片] 压缩没成（原件照旧用）：${outcome.compressFailure}｜${label}`);
          this.traceImage({
            kind: 'compress-failed', stage: 'compress', ref: url,
            line: `压缩没成（原件照旧用，压不动不算错）：${outcome.compressFailure}`,
          });
        }
      });
    } finally {
      // 预算用完没轮到的那些按**原顺序**放回队尾：下一拍先取它们（它们仍是"最近 N 张"里
      // 没下完的那部分），而且顺序不能乱——乱了"最近"这个判据就漂了。
      for (const url of batch) {
        if (!deferred.has(url)) continue;
        this.prewarmPending.push(url);
        this.prewarmPendingSet.add(url);
      }
      this.prewarmBusy = false;
    }
  }

  /**
   * 把一条要预取的直链排进队列（去重 + 上限）。
   *
   * 去重两处：同一张图在历史里出现好几次（表情包重发）时只排一次；本地已有字节的直接不排
   * （不然它会白占"最近 N 张"的名额，把真正新到的那张挤到下一拍）。
   * 上限（{@link PREWARM_BACKLOG_MAX}）满了丢**最老**的那条并留一条痕——丢的是"这一拍反正
   * 也轮不到"的那张，但"丢了"这件事必须查得到。
   */
  private enqueuePrewarm(url: string): void {
    if (this.prewarmPendingSet.has(url)) return;
    if (hasLocalAttachmentBytes(this.deps.dataDir, url)) return;
    this.prewarmPending.push(url);
    this.prewarmPendingSet.add(url);
    while (this.prewarmPending.length > PREWARM_BACKLOG_MAX) {
      const dropped = this.prewarmPending.shift();
      if (dropped === undefined) break;
      this.prewarmPendingSet.delete(dropped);
      this.traceImage({
        kind: 'skipped', stage: 'prewarm', reason: 'no-local-bytes', ref: dropped,
        line: `${contextImageSkipText('no-local-bytes')}——预取队列超过 ${PREWARM_BACKLOG_MAX} 条，`
          + '这一张排不进来了（消息里的地址仍在，可用 vision_read 转述）',
      });
    }
  }

  /**
   * 记一条 **`image/trace`**（internal；不进请求体）。
   *
   * 同一 `(kind, stage, reason, ref)` 只留一次（见 {@link imageTraceSeen} 的理由）。
   * 写事件失败**绝不影响渲染/预取**：这是排障用的账，不是任何判据的输入——把它做成
   * "写不进去就抛"等于给渲染层塞一条新的失败路径（`loadImage` 正在 deriveAt 里同步跑）。
   */
  private traceImage(input: {
    kind: 'skipped' | 'compress-failed' | 'prewarm-timeout' | 'prewarm-failed';
    stage: 'prewarm' | 'render' | 'compress';
    ref: string;
    line?: string;
    reason?: ContextImageSkipReason;
    ms?: number;
  }): void {
    const key = `${input.kind}|${input.stage}|${input.reason ?? ''}|${input.ref}`;
    if (this.imageTraceSeen.has(key)) return;
    if (this.imageTraceSeen.size >= 512) this.imageTraceSeen.clear();
    this.imageTraceSeen.add(key);
    try {
      this.appendSync('image/trace', {
        kind: input.kind,
        stage: input.stage,
        ref: input.ref,
        line: input.line ?? contextImageSkipText(input.reason ?? 'no-local-bytes'),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.ms === undefined ? {} : { ms: input.ms }),
      }, 'internal');
    } catch {
      // 留痕写不进去只是少一条账：不把它变成渲染/预取的失败路径
    }
  }

  /**
   * **step 边界的预取入口**（循环层经 `agentDeps.prewarmStepImages` 调它一次/步）。
   *
   * 它只做一件事：带着拍内预算跑一趟预取（见 `prewarmRecentAttachments` 的 stage 注释）。
   * 超时/失败的痕由循环层落（那一侧知道"这一拍照旧发了"这个事实）；这里落的是**逐张**的
   * 留痕（哪张没进、哪张压不动）。
   */
  private async prewarmStepImages(): Promise<void> {
    await this.prewarmRecentAttachments({ stage: 'step' });
  }

  /**
   * 建/读一次索引（幂等）。读盘或写盘失败（磁盘满、权限）时照常按现有文件建一份内存索引，
   * 绝不让这一轮发不出去——记忆索引是**便利**，不是存续的前提；她自己的记忆文件才是真源。
   *
   * `dir` 形参只有一个用处：`memoryIndexPlan` 那条路（v32）把它作为 `build` 的入参递进来，
   * 于是"关掉框架代管记忆＝连扫都不扫"这件事可以在真实数据目录上被直接断言。本类的调用点
   * 传的都是 `this.deps.dataDir`，与原来逐字节等价。
   */
  private ensureMemoryIndexSafely(dir: string = this.deps.dataDir, options: { full?: boolean } = {}): MemoryIndex {
    try {
      ensureMemoryIndex(dir);
    } catch {
      // 写不进去：下面仍按盘上现有内容建索引
    }
    return buildMemoryIndex(dir, options);
  }

  /**
   * 本轮的**记忆索引注入账**（B2，docs/memory-injection.md §4；2026-10-04 简化）。
   *
   * 两件事：
   *   ① **判心跳轮**：本轮唤醒只有 `wake/heartbeat` → 这一轮不注入索引（没人在跟她说话，
   *      没有谁的上下文需要对齐；她要看就按索引 `safe_read`）；
   *   ② **留指纹**：把当时注入的那段索引文本的哈希与条数交出去，循环层落成 `memory/selected`。
   *      索引全文**不落事件**——它就渲染在固定块里，全文再存一份是重复存储（事件是 append-only 的）。
   *
   * 原来这里还要"选哪几条 + 取正文"（`selectMemory` / `readExcerpt` / `renderSelectedMemory`），
   * 用户 2026-10-04 定了口径「只看索引，如果需要，heavy 自己去读，随后跟随 tool call 留在上下文」，
   * 于是整条选材与正文装配都删了——固定块里只留索引。
   *
   * **阶段一（2026-10-15）改的是"注入哪一段"**：固定块里那一段从"整张指针表（29 条 / 890 token）"
   * 换成"框架按最近话题挑的 6 条"（用户原话那一版）。这条账因此多三格：
   * `selected`（实际推给她的指针）/ `scores`（凭什么） / `query`（按哪几条输入挑的）——
   * 升级之前只落 `indexHash` + `entries`，报告 §6 记着那个后果：事后**无法**重建"当时推的是哪几条"。
   * 心跳轮照旧整轮不注入（`injection: 'heartbeat'`），三格一个都不给。
   */
  private planMemorySelection(
    plan: {
      recommendation: MemoryRecommendation | null;
      /** 当时注入的那一段文本（推荐段本身；空串 = 这一轮什么都没注入） */
      text: string;
    },
    query: MemoryQueryFingerprint,
    wakeEvents: readonly AppEvent[],
  ): {
    injection: 'human' | 'heartbeat';
    indexHash: string;
    entries: number;
    injected?: string;
    selected?: string[];
    scores?: number[];
    query?: { hash: string; seqs: number[]; texts: number; truncated: boolean };
    recall?: RecallTrace;
  } {
    const heartbeatTurn = isHeartbeatTurn(wakeEvents);
    // 心跳轮：什么都没注入，所以**没有"注进去的那一版"**——指纹留空串、条数留 0。
    // 此处刻意不算那份没被注入的索引的哈希：算了就等于账上写着一个"当时并不在请求里"的指纹，
    // 事后读日志的人会以为它注进去了（这个洞正是记账要防的那一类）。
    if (heartbeatTurn) return { injection: 'heartbeat', indexHash: '', entries: 0 };
    const recommendation = plan.recommendation;
    const recall = recommendation?.recall;
    if (recommendation === null || plan.text === '') {
      // 没有推荐段（她还没写过任何记忆 / 记忆托管关掉 / 老调用点）：这一轮没注入任何东西。
      // **不许**退回"整张指针表"——那正是这一版要省掉的那 890 token。
      // 条数记 0（不是"索引有 178 条"）：这一格的语义是**注入了多少**，见 `log/types.ts`。
      //
      // ⚠ `injected: ''` **必须写**（哪怕它是空串）：空串是**结论**——"这一轮注入的是没有"。
      // 不写它，重建那两条路（`replay.ts` 的 `memoryIndexTextForRebuild`）就没法把这一轮
      // 与"老格式事件"区分开，只能退回盘上读 `MEMORIES/INDEX.md`——而那份文件**已经不进请求了**，
      // 于是预览会凭空多出整整一段旧索引（实测踩过一次）。老事件之所以还能退回盘上，
      // 是因为它们那时注入的**就是**那份文件（"盘上文件 + 确定性渲染"的函数）。
      //
      // 阶段二：召回**没触发**的那一轮也走这一支——但 `recall` 那一格要留下（四态里
      // "未触发"本身是结论：没触发 / 词典为空 / 命中的词刚在上下文里），一格都不写的话
      // "为什么这一轮没回忆"就永远没人答得上来（与 `idleReason` 同一条做法）。
      return {
        injection: 'human', indexHash: '', entries: 0, injected: '',
        ...(recall === undefined ? {} : { recall }),
      };
    }
    return {
      injection: 'human',
      // 指纹 = **当时注入的那段文本**（就是推荐段 / 召回段本身）：账与请求里那一段永远同一版。
      indexHash: sha256Hex(plan.text),
      // ⚠ **那一段的原文也落库**（`injected`，阶段一）：推荐段是 BM25 按"当时的记忆文件 +
      // 当时那 5 次输入"挑出来的，事后**算不回来**（盘上文件她会改）——而界面预览与 CLI 的重建
      // 要逐字节复原请求。判据与代价逐条写在 `log/types.ts` 的 `injected` 那一格。
      injected: plan.text,
      // 条数 = 这一轮挑给她的条数（= 实现里 `selected.length`；两者用同一个来源，见 `agent-loop`）。
      entries: recommendation.items.length,
      selected: recommendation.items.map((item) => item.ref),
      scores: recommendation.items.map((item) => Number(formatScore(item.score))),
      query: {
        hash: query.hash,
        seqs: [...query.seqs],
        texts: query.texts,
        truncated: query.truncated,
      },
      ...(recall === undefined ? {} : { recall }),
    };
  }

  /**
   * **整段可见历史**（阶段二 ③，2026-10-19）：还在她上下文里的那些消息，拼成一段文本。
   *
   * 为什么不能只用"最近 5 次输入"当"在上下文里"的判据：她的可见历史动辄几十万字
   * （压缩线 200k token），一句话里提到的词很可能**几分钟前刚在这段历史里出现过**——
   * 用 5 条输入判，会把这些判成"没在上下文里"⇒ 误触发。判据要跟着真实的可见窗口走。
   *
   * 口径：
   *   · 从 `lastSeq` 往回走，**遇到 `compaction/summary` 就停**（它之前的已被遮蔽、不在现场）；
   *   · 只收 `message/user` 与 `message/assistant` 的正文（工具结果不收：那是"读到的"，
   *     不是"聊过的"，且体量最大）；
   *   · 按 `VISIBLE_HISTORY_CHARS` 截断（运行期必须有界，一轮一次）。
   *
   * 它**不改任何判据**，只把"上下文"这个词落到实处；开关关着时不会被调用（见 agentDeps）。
   */
  private visibleHistoryText(cap = VISIBLE_HISTORY_CHARS): string {
    const latest = this.deps.projection.lastSeq;
    const parts: string[] = [];
    let chars = 0;
    for (let seq = latest; seq >= 1 && chars < cap; seq -= 1) {
      const event = this.deps.log.get(seq);
      if (event === null) continue; // 崩溃留下的空洞：跳过，不猜
      if (event.type === 'compaction/summary') break; // 再往前已被遮蔽
      if (event.type !== 'message/user' && event.type !== 'message/assistant') continue;
      const text = (event.data as { text?: unknown }).text;
      if (typeof text !== 'string' || text === '') continue;
      parts.push(text);
      chars += text.length;
    }
    return parts.reverse().join('\n');
  }

  /**
   * **最近 5 次用户输入**（阶段一：推荐段的查询来源）。
   *
   * 判据 = 用户原话那一版「BM25 挑选应取用户的最近 5 次输入聚合」。所以"用户输入"这三个字
   * 必须钉在一个**唯一**的实现上：{@link userSpokeEventTextOf}——人开口的那三种唤醒
   * （`wake/manual` 界面消息 / `wake/channel` 消息适配器 / `wake/webhook` 转发进来的话），
   * 与"打断 speak"那条判据是**同一份**（`USER_SPOKE_TYPES`）。心跳、定时器、意图、后台任务
   * 都不是"用户输入"，一个都不算。
   *
   * 取法两条路合并（都不新造判据）：
   *   · **本批唤醒**：手上有现成的对象，也**保证不漏**——本拍刚到的输入在这一格里；
   *   · **日志里往回看**：更早那几次输入（含上一轮之后没被认领的那些）。
   * 两路按 seq 去重、按时间序（= seq 升序）。
   *
   * 边界都是**有界的常量**：往回最多看 {@link RECENT_USER_INPUT_SCAN} 条事件、
   * 单条文本最多取 {@link RAW_INPUT_MAX_CHARS} 字（BM25 那侧还有 `MEMORY_QUERY_*` 两道上限）。
   * 这一步每 turn 做一次，绝不会把 12MB 的活动日志翻一遍。
   */
  private collectRecentUserInputs(wakeEvents: readonly AppEvent[]): MemoryQueryInput[] {
    const found = new Map<number, string>();
    for (const event of wakeEvents) {
      const text = userSpokeEventTextOf(event.type, event.data);
      if (text !== null && text !== '') found.set(event.seq, text);
    }
    const latest = this.deps.projection.lastSeq;
    // 已经凑够 5 条就不翻日志（绝大多数轮次：本批就有输入，而前几次也在本批之前不久）
    const need = MEMORY_QUERY_INPUT_COUNT - found.size;
    if (need > 0) {
      const from = Math.max(1, latest - RECENT_USER_INPUT_SCAN + 1);
      for (let seq = latest; seq >= from && found.size < MEMORY_QUERY_INPUT_COUNT; seq -= 1) {
        if (found.has(seq)) continue;
        const event = this.deps.log.get(seq);
        if (event === null) continue; // 崩溃留下的空洞：跳过，不猜
        const text = userSpokeEventTextOf(event.type, event.data);
        if (text === null || text === '') continue;
        found.set(seq, text);
      }
    }
    return [...found.entries()]
      .sort((a, b) => b[0] - a[0]) // 从新往旧取够 5 条
      .slice(0, MEMORY_QUERY_INPUT_COUNT)
      .map(([seq, text]) => ({ seq, text }))
      .sort((a, b) => a.seq - b.seq); // 再按时间升序交给聚合（"按时间拼接"）
  }

  /**
   * 本轮固定块的素材（B2）：**这一轮里不会再变**的状态与关系档案。
   *
   * 这个函数在 `agentDeps()` 里被调用**一次**（一轮一次），返回的是一份**快照**。
   * 循环层每步原样转手，所以：
   *   • `[当前状态]`（`STATE.md`）在这一轮的任何一步里逐字节相同——不必每步重新编码；
   *   • 她在 turn 内用 `write_persona` 改的 STATE 要到**下一轮**才进上下文。
   *     这是有意的取舍（改前是 getter，同轮立刻可见但每步重发整份 STATE，
   *     实测约 3845 token/步），理由与代价都写在 docs/memory-injection.md §2。
   *
   * 关系档案与此刻层用的是**同一个判据**（`relationshipForCurrentWake`）：
   * 一次唤醒一个人，所以"本轮命中谁"在一轮内是常量。
   *
   * 记忆那一段**不在这里、也不在任何地方**（2026-10-04 用户的口径：只看索引，需要就 heavy
   * 自己去读）：固定块里关于记忆的只有 `memoryIndex` 那份索引（指针表），正文由她 `safe_read`
   * 现取、作为工具结果留在历史里。理由与代价见 docs/memory-injection.md §5。
   */
  private turnBlockFacts(): TurnBlockFacts {
    return {
      state: this.deps.persona.state,
      relationship: this.relationshipForCurrentWake(),
      memory: null,
    };
  }

  /** 读 `MEMORIES/aliases.md`（她给外部会话起的名字）；读不到就当没有，不报错 */
  private readAliases(): Map<string, KnownSessionAlias> {
    return this.readAliasTables().sessions;
  }

  /**
   * 同一份 `aliases.md` 折成**两张表**：会话别名（sid 键）与群成员别名（裸 id 键）。
   *
   * 为什么一次读、两次解析：这两张表来自同一个文件、同一套行解析（`parseAliases` /
   * `parseMemberAliases` 逐字对称），而认人那条路（`personNameFromHumanTables`）两张都要。
   * 各自读一遍文件的话，`read_channel` 那种"一屏几十行、每行查一次名字"的地方会把同一份文件
   * 读两遍——名字是渲染热路径，省下的那次 syscall 是白捡的。
   */
  private readAliasTables(): {
    sessions: Map<string, KnownSessionAlias>;
    members: Map<string, KnownSessionAlias>;
  } {
    try {
      const path = join(memoriesDir(this.deps.dataDir), 'aliases.md');
      const text = readFileSync(path, 'utf8');
      return { sessions: parseAliases(text), members: parseMemberAliases(text) };
    } catch {
      // 读不动 / 没写过：两张空表。她是"还没给谁起过名字"，不是出错——不报、不拦。
      return { sessions: new Map(), members: new Map() };
    }
  }

  // ──────────────────────────────── 会话簿与未读（v32） ────────────────────────────────

  /**
   * 对会叫醒她的那些外部消息跑一次注入判定，有迹象就落 `injection/flagged`。
   *
   * 三条分寸（与用户给的接线口径一致，也决定了它为什么长这样）：
   *   • **只判 `wake/channel`**：群里的普通消息进信箱、不唤醒，也就不必花这次判定
   *     ——判定的钱要花在"她真会看到的那几条"上；
   *   • **有风险才写事件**：判 `risky: false` 时一个字都不落。没迹象还写一条事件，等于
   *     每轮都在日志里留一行"这条消息没问题"，那是纯噪音（而且要她读）；
   *   • **不阻塞、不抛**：判定本身已经有超时与兜底（见 InjectionJudge），这里再包一层
   *     宽度上限与去重——最坏情况是"这次没判出来"，绝不是"她开不了口"。
   *
   * 去重按 `messageId`：同一条消息可能因为重投、或者被攒批窗口重复认领而走两遍这条路，
   * 那次判定已经落过事件了，不必再花一次钱、也不必写第二条一样的预警。
   */
  private async judgeChannelWakes(wakeEvents: readonly AppEvent[], turn: number): Promise<void> {
    // 没有可用的模型通道就不判：`ds` 是必须注入的依赖，但测试与窄路径上给的可能只是个空壳
    // （对象在、`generate` 不在）。一条注入判定绝不该让循环在中途炸掉——宁可不判。
    if (typeof this.deps.ds?.generate !== 'function') return;
    // 豁免名单（用户 2026-10-04 的口径：单聊按会话、群里按人）：豁免 = **不扫描也不提示**。
    // 为什么选"不扫描"而不是"照扫只是不说"：这条判定存在的唯一意义就是提醒她；
    // 人已经判定"这个人可信"之后，再花一次 light 调用算一遍、算完又不告诉她，纯属白花钱，
    // 还会在日志里留下一堆没人看的标记。省掉的正是下面那次 judge。
    const exempt = this.warnExemptBook();
    exempt.refresh();
    const targets = wakeEvents
      .filter((e): e is AppEvent & { type: 'wake/channel' } => e.type === 'wake/channel')
      .filter((e) => !this.judgedMessageIds.has(e.data.messageId))
      .filter((e) => !exempt.isExempt(e.data))
      .slice(0, INJECTION_JUDGE_MAX_PER_BATCH);
    if (targets.length === 0) return;
    // 去重集合的体量：给它一个上界（超出就整份丢掉重建）——它只是"最近判过哪些"，
    // 丢掉重建的代价是极少数消息被重判一次，而无限增长的代价是长跑进程的内存。
    if (this.judgedMessageIds.size > INJECTION_JUDGE_SEEN_MAX) this.judgedMessageIds.clear();
    const judge = new InjectionJudge({
      ds: this.deps.ds,
      now: this.deps.now,
      log: this.deps.log,
      projection: this.deps.projection,
      turn,
      timeoutMs: INJECTION_JUDGE_TIMEOUT_MS,
    });
    for (const event of targets) {
      this.judgedMessageIds.add(event.data.messageId);
      let verdict: InjectionVerdict;
      try {
        verdict = await judge.judge(event.data.text);
      } catch (err) {
        // judge 自己承诺不抛；真抛了也只当没判出来（不拦她开口）
        this.write(`[注入判定] 判定失败，按无迹象处理：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!verdict.risky) continue;
      const d = event.data;
      const note = noteForFlagged(verdict);
      // **当场**写进内存表：本轮渲染按 messageId 取这句话（render 的 channelNotesOf），
      // 而它是纯函数、只看得见事件——所以后面那一趟 noteInjectionWarnings 会把它落成
      // `injection/noted`，两条路给的必须是同一串字节（这里与那里共用 noteForFlagged）。
      // 只等下一拍的 foldChannelEvents 来补，就意味着这一轮她看到的仍是"没有预警"的原文。
      this.flaggedNotes.set(d.messageId, {
        note, by: verdict.by, reason: verdict.reason, quotes: verdict.quotes,
      });
      this.appendSync('injection/flagged', {
        messageId: d.messageId,
        sid: sidOf(d.channel, d.chatType, d.chatId),
        by: verdict.by,
        reason: verdict.reason,
        quotes: verdict.quotes,
        person: d.person,
        chatType: d.chatType,
      }, 'internal');
      // 启动日志里留一行：这是**框架的**动作（不是她的），排障时要知道它发生过
      this.write(`[注入判定] 外部消息 ${d.messageId}（${d.person}）有迹象（${verdict.by}）：${verdict.reason}`);
    }
  }

  /*
   * **这里曾经有三个方法**（v34 起，v45 删）：`prefetchAssetsLine()`（轮首读 `MEMORIES/assets.md`、
   * 把索引喂给 light 挑 ≤3 条、渲染成任务卡上那一行）、`assetFacts()`（聚合技能目录 / MCP 声明 /
   * PATH 探测这份**事实层**）、`assetTaskTitle()`（把"这一轮要做什么"交给 light）。
   *
   * **为什么整块删干净**（2026-10-09 用户拍板取消「light 选取资产」这条机制）：留着一个再也不会
   * 被调用的方法，等于把"框架还会替她挑"这件事留在代码里——下一个读代码的人会先信它。
   * **没删的东西**（有意保留，别跟着一起删）：
   *   • `persona/assets.ts` 的**事实层**（`factOf` / `withFacts` / `indexOf` / `probeOnPath`，
   *     连同历史选型用的 `clipAssetNote` 那一套截断口径）——它服务"有哪些、在哪、就绪没有"，
   *     与挑不挑无关；
   *   • `MEMORIES/assets.md`（她自己的清单，她维护）与那条常驻规矩（"先读说明再用，不许凭名字猜"，
   *     在装置自述第⑰段）——**一个字都没动**；
   *   • `memory/selected.assets` 这条账与 `taskCard.assets` 这一格：**旧日志要逐字节重建**，
   *     见 `agentDeps` 装配处那一篇注释（删的是"值"，不是"格子"）。
   * 连带的 `RealLoopDeps.probeAssetPath` / `mcpServers` 两个覆盖点**留着**（它们是事实层的注入点；
   * 现在**没有生产消费者**——这一点如实记在报告里，不假装它们还在服务什么）。
   */

  /**
   * 把"框架示了警"这件事落成事件（`injection/noted`，v25）——**逐条**，一条消息一次。
   *
   * 为什么要单独立一条（而不是复用 `injection/flagged`）：预警还有一条**没有判定结论**的路
   * ——规则层字面命中、判定超时没跑成、一批里超出判定上限的那些（`INJECTION_JUDGE_MAX_PER_BATCH`）。
   * 那条路今天只在渲染时现拼一句话："她到底看没看见"就永远查不出来；而且 GUI 要**原样**贴出
   * 那句话，那是渲染层的文案，界面侧算不出同一串字节——只有落成事件才贴得出。
   *
   * 为什么在这个时刻写：这一批消息正要进她的上下文（判定已跑完、turn 还没起）。写的时机
   * 与"她看见"是同一刻，而不是判定那一刻——判了却没能送进去（turn 没跑起来）不算示警。
   *
   * 去重按 messageId：重投与攒批窗口会让同一条再走一遍这一拍（见 notedMessageIds）。
   *
   * **豁免闸门（2026-10-04 修的真 bug）**：被豁免的会话/人在这里就 `continue`，一个字都不落
   * ——包括"已经落过 flag 的老消息"再走一遍这一拍的情形（口径：豁免之后不再产生新的警告）。
   * 放在最前面的理由是它与"有没有判定结论"无关：豁免是**不扫描也不提示**，不是"照扫只是不说"。
   * 已经落库的那些 `injection/noted` / `injection/flagged` 一个字都不动（日志只增不改）。
   *
   * **中途到达的消息不走这一拍**（2026-10-04 实测，口径见 docs/operations.md §4.3）：她在跑一个
   * turn 时新来的消息由 agent-loop **中途认领**（`input/claimed`，见 claimDeliveredInputs），
   * 本方法一次都不会为它跑——用户现场那条就是这样（seq 17263 在 turn 380 中途到达，全日志里
   * `injection/noted` 一条都没有）。它的预警只剩渲染层现算那一个出口（`renderExternalEvent`）：
   *   · 豁免的：不扫也不提示；未豁免的：渲染时现算（因此**不进**「最近 24 小时示警 X 次」计数，
   *     且每次渲染重扫一遍字面——纯函数、无 IO，代价可接受）；
   *   · 要给它"补一次判定"就得在折叠那一拍做（异步判定与逐步渲染抢时序），目前**有意不做**。
   */
  private noteInjectionWarnings(wakeEvents: readonly AppEvent[]): void {
    // 判据的唯一实现在 WarnExemptBook；这里与判定层、渲染层问的是同一处
    const exempt = this.warnExemptBook();
    exempt.refresh();
    for (const event of wakeEvents) {
      if (event.type !== 'wake/channel') continue;
      const d = event.data;
      if (exempt.isExempt(d)) continue;
      if (this.notedMessageIds.has(d.messageId)) continue;
      // 判过的用它那句（含语义级），没判过的现扫字面——与渲染层同一个判据、同一段文案。
      // 素材过 `speakerWordsOf`（判据的唯一实现）：转述块里常常是她自己的发言，扫它就会被
      // 当成"这条消息在指挥你"贴回她眼前——与判定入口同一处判据，不另写一份。
      const flagged = this.flaggedNotes.get(d.messageId);
      const hints = flagged === undefined ? scanForInjection(speakerWordsOf(d.text)) : [];
      const note = flagged?.note ?? injectionNoteOf(hints);
      if (note === null) continue;
      this.notedMessageIds.add(d.messageId);
      const sid = sidOf(d.channel, d.chatType, d.chatId);
      this.appendSync('injection/noted', {
        messageId: d.messageId,
        sid,
        person: d.person,
        chatType: d.chatType,
        // 名字是**当时**解析出来的：此刻层那段历史要按人列，而渲染层查不了联系人表。
        // 解析不出就退回那串 id（宁可难看，不可编一个名字）。
        who: this.resolveChannelName(sid) ?? d.person ?? d.chatId,
        note,
        // 给人的那一半：判过的用判定结论，规则命中的用规则自己那句"在做什么"
        reason: flagged?.reason ?? reasonOfHints(hints),
        quotes: [...(flagged?.quotes ?? quotesOfHints(hints))],
        ...(flagged === undefined ? {} : { by: flagged.by }),
      }, 'internal');
    }
  }

  /**
   * 那条外部消息的框架话（渲染层把它附在框外；没判出迹象就是 null）。
   *
   * 查的是 `flaggedNotes`——它在折叠里维护（`foldChannelEvents` 见过 `injection/flagged`
   * 就记一条），所以重启后由 warmUp 的全量折叠补齐，**不现扫日志**。
   */
  private flaggedNoteFor(messageId: string): string | null {
    return this.flaggedNotes.get(messageId)?.note ?? null;
  }

  /**
   * 把新来的通道事件并进会话簿（两种事件 + 已读位，共用 sessions.ts 的一份折叠）。
   *
   * **为什么要扫事件而不是只在认领唤醒时并**：`channel/message` 是 internal、不进 pending，
   * 永远不会出现在本批唤醒里——只在认领时并，那些"只记账"的会话就永远长不出未读，
   * 而未读恰恰是它们唯一的存在形式。
   *
   * 代价被限制在"上一拍水位之后的新事件"上（`channelBookSeq` 游标）：平时每拍几条到几十条，
   * 判一个字符串相等而已；重启后游标归零、由 warmUp 的全量折叠兜住，不会重复计入条数
   * （warmUp 之后把游标设到当刻水位，见那里的注释）。
   */
  /**
   * 从一条通道事件里收群成员（只认群：单聊的人不需要"群成员"这层身份，他有 sid）。
   *
   * 触发条件按用户的口径：**这条消息发生过 @/提及**（@ 了她，或者 @ 了群里别人）。
   * 那时把两类人都注册：发言的人、被 @ 到的人。没 @ 过的普通闲聊不注册——免得把群里
   * 每个冒过泡的人都灌进档案，那反而看不出"谁跟她打过交道"。
   */
  private registerGroupMembers(event: AppEvent): void {
    // **只认 @ 她/提及她**（用户 2026-10-04 的口径）：被 @ 的其他人一概不管。
    // 判据收在 `groupMemberCandidateOf` 里，与回填那趟**同一个函数**——两处各写一遍迟早会漂。
    // 2026-10-11 起那个函数还多一档「这是不是我自己」（判据与宿主落库口共用一份实现）。
    const calling = groupMemberCandidateOf(event, this.deps.selfMessages);
    if (calling === null) return;
    const data = calling.data;
    this.groupMembers ??= new GroupMemberBook(this.deps.dataDir);
    this.groupMembers.refresh();
    // 已经有名字的人（用户手写的联系人表、或她自己在别名表里认过的）**不进档案**：
    // 这里是给"还没名字的人"准备的。实测踩过：用户 35 次在群里 @ 她，全被注册成了群友。
    const isKnown = (openid: string): boolean => this.humanSourceNameOf(openid) !== null;
    const at = event.ts;
    // 发言人：已经有名字的（用户）跳过；昵称有就用（官方只在部分事件里给 username）
    if (isKnown(data.person)) return;
    if (this.groupMembers.register({
      openid: data.person,
      groupSid: sidOf(data.channel, data.chatType, data.chatId),
      ...(data.nickname === undefined || data.nickname === '' ? {} : { nickname: data.nickname }),
      at,
    })) this.groupMembersDirty = true;
  }

  /**
   * 重启后的回填：**对重启前已落盘的事件，只做"成员登记"这一件事**。
   *
   * 与运行期那条路（{@link registerGroupMembers}）的三处**刻意不同**：
   *   ① 用 `GroupMemberBook.backfill` 而不是 `register` —— **不发占位号**。历史消息是过去发生的，
   *      她当时并不在看；给那些人编号（群友A、群友B…）等于替她"认"了一批她没见过的人。
   *      回填只落平台给的事实（id ↔ 昵称、在哪个群见过），没昵称就留空名。
   *   ② **一次性、整趟拼成一批**再落盘（运行期是一条一条 register、末尾统一 save）——
   *      回填之后没有"下一拍"接着折它，攒着不写就等于没回填。
   *   ③ 跑在 `warmUp` 里、只读 `events`（调用方已经为了别的目的读进内存的那一份），
   *      **不碰** `sessionBook` / `channelBookSeq` / `channel/read` —— 会话条数与未读的
   *      口径只属于 `sessions.ts` 那一条线，回填一个字都不改（那正是"游标留 0"那条错路的病根）。
   *
   * 幂等：同一批事件折两遍，第二遍 `backfill` 返回 false ⇒ 不写盘，档案字节不变。
   * 返回 null = 这趟日志里一个"在群里叫过她的人"都没有（**不建档案、不碰盘**，与惰性建同一条纪律）。
   */
  private backfillGroupMembers(events: readonly AppEvent[]): GroupMemberBook | null {
    // 同一个人可能在多个群里叫过她：一趟日志里按 openid 只留**最后**提到的那条（昵称最新、
    // 群归属是最后见到的那个群）。`backfill` 本身对重复条目是幂等的（补缺不覆盖），
    // 这里去重只是让"一批就是一批"这件事在调用点上看得出来。
    const byOpenid = new Map<string, { openid: string; groupSid: string; nickname?: string; at: string }>();
    for (const event of events) {
      const calling = groupMemberCandidateOf(event, this.deps.selfMessages);
      if (calling === null) continue;
      const data = calling.data;
      // 与运行期同一条判据：已经有名字的人（用户、她认过的别名）**不进档案**
      if (this.humanSourceNameOf(data.person)) continue;
      byOpenid.set(data.person, {
        openid: data.person,
        groupSid: sidOf(data.channel, data.chatType, data.chatId),
        ...(data.nickname === undefined || data.nickname === '' ? {} : { nickname: data.nickname }),
        at: event.ts,
      });
    }
    if (byOpenid.size === 0) return null;
    this.groupMembers ??= new GroupMemberBook(this.deps.dataDir);
    this.groupMembers.refresh();
    // 没改动（第二次启动、或那些人早就在档案里）就不写盘：档案的字节不该因为"又启动了一次"而变
    return this.groupMembers.backfill([...byOpenid.values()]) ? this.groupMembers : null;
  }

  private foldChannelEvents(): void {
    const lastSeq = this.deps.projection.lastSeq;
    if (lastSeq <= this.channelBookSeq) return;
    const fresh: AppEvent[] = [];
    for (let seq = this.channelBookSeq + 1; seq <= lastSeq; seq += 1) {
      const event = this.deps.log.get(seq);
      if (event === null) continue; // 崩溃留下的空洞：跳过，不猜
      fresh.push(event);
      if (event.type === 'channel/topic') {
        // 话题只留最近一条：清单那一行只缀得下一句，历史话题在日志里（可复盘）
        if (event.data.topic.trim() !== '') {
          this.channelTopics.set(event.data.sid, event.data.topic);
          this.topicSeq.set(event.data.sid, event.data.toSeq);
        }
        continue;
      }
      if (event.type === 'injection/flagged') {
        this.flaggedNotes.set(event.data.messageId, {
          note: noteForFlagged(event.data), by: event.data.by,
          reason: event.data.reason, quotes: event.data.quotes,
        });
        continue;
      }
      if (event.type === 'injection/noted') {
        this.notedMessageIds.add(event.data.messageId);
        continue;
      }
      if (event.type !== 'wake/channel' && event.type !== 'channel/message' && event.type !== 'channel/read') continue;
      // 这一轮叫她的那条消息（群里被提及/@）：`read_channel` 靠它知道"这个会话必须照给"
      //（v28 之后她手里只有通知、没有正文，而那条又是 wake/channel、不计入未读——见 admin.ts）
      if (event.type === 'wake/channel'
        && event.data.chatType !== 'c2c'
        && event.data.mentionsMe === true) {
        this.lastMention = {
          sid: sidOf(event.data.channel, event.data.chatType, event.data.chatId),
          messageId: event.data.messageId,
        };
      }
      this.sessionBook = upsertSessionInto(this.sessionBook, event);
      // 群成员自动注册（2026-10-04 用户的口径）：**发生过 @/提及**的群消息里，把发言人
      // 本身、以及被 @ 到的人都记进档案——"见过谁"就是这么攒出来的。QQ 官方没有查成员的
      // 接口（要内邀白名单），所以只能靠消息事件。**这一趟也是它唯一的入口**（warmUp 只折
      // 会话簿，所以那里的游标留在 0，让下一拍把历史补折一遍——见 warmUp 那段注释）。
      this.registerGroupMembers(event);
    }
    if (this.groupMembersDirty) {
      this.groupMembers?.save();
      this.groupMembersDirty = false;
    }
    this.channelBookSeq = lastSeq;
    // 她说过话 / 有人叫过她（v66）：与上面那趟同一个游标、同一批事件——折叠判据只有一处
    // （`foldSpokeAndMention`），warmUp 与这里共用。
    this.foldSpokeAndMentionInto(fresh);
  }

  /**
   * 折这一批事件的 `spokeAt` / `mentionedAt` / `spokeTimes`（v66 两格，v67 加第三格）：判据在
   * 导出的纯函数 {@link foldSpokeAndMention} 一处（重放那条路也走它——两处各写一遍会让
   * "预览里的会话清单"与"当时真发出去的那一份"不是同一份）。
   *
   * 两个折点（warmUp 全量 / foldChannelEvents 增量）前两格都取最大值、第三格按**事件序号水位**
   * 去重 ⇒ 重复折叠无害（重启后 warmUp 读全量，而 `channelBookSeq` 从 0 起，下一拍会把同一批
   * 再折一遍）。并顺手剪掉窗口外的素材（内存）。
   */
  private foldSpokeAndMentionInto(events: readonly AppEvent[]): void {
    // 只折**没折过的**那些事件：这一句就是幂等的保证（去重键是 seq，不是时刻——见水位那段）
    const fresh = events.filter((event) => event.seq > this.spokeFoldedUpTo);
    if (fresh.length === 0) return;
    const next = foldSpokeAndMention(fresh);
    for (const event of fresh) {
      if (event.seq > this.spokeFoldedUpTo) this.spokeFoldedUpTo = event.seq;
    }
    for (const [sid, at] of next.spokeAt) {
      const prev = this.spokeAt.get(sid);
      if (prev === undefined || at > prev) this.spokeAt.set(sid, at);
    }
    for (const [sid, at] of next.mentionedAt) {
      const prev = this.mentionedAt.get(sid);
      if (prev === undefined || at > prev) this.mentionedAt.set(sid, at);
    }
    // 频次的素材（v67）：这批事件里的并进来，窗口外的剪掉。第二个循环管的是**这批事件里没有、
    // 但已经滑出窗口**的那些会话——不剪它们，内存就只增不减（那个会话已经不在清单里了）。
    const cutoff = this.deps.now().getTime() - SESSION_FREQ_WINDOW_MS;
    for (const [sid, times] of next.spokeTimes) {
      const merged = mergeSpokeTimes(this.spokeTimes.get(sid) ?? [], times, cutoff);
      if (merged.length === 0) this.spokeTimes.delete(sid);
      else this.spokeTimes.set(sid, merged);
    }
    for (const [sid, times] of [...this.spokeTimes]) {
      if (next.spokeTimes.has(sid)) continue;
      const kept = mergeSpokeTimes(times, [], cutoff);
      if (kept.length === 0) this.spokeTimes.delete(sid);
      else this.spokeTimes.set(sid, kept);
    }
  }

  /**
   * `read_channel` 的读取口：取某个会话的消息（时间正序）。
   *
   * 两种事件都算这个会话的消息——`wake/channel` 是"叫她"的那条、`channel/message` 是只记账的
   * 那条，但对"这个会话里都说过什么"来说它们是同一件事。漏掉前者会让她读到一段缺了 @ 的对话。
   *
   * **两种取法，判据只有 `before` 一个**（与工具层同一条口径，见 tools/admin.ts 的 `ReadCursor`）：
   *   • 不给 `before` ⇒ 取最近 `limit` 条（"现在这儿有什么"）；
   *   • 给了 `before` ⇒ 取**事件 seq 严格小于它**的最近 `limit` 条（往回翻一页）。
   *     判据用事件 seq 而不是平台序号：平台序号**答不了"这一条在这段历史里的位置"**
   *     （官方单聊恒为 1、OneBot 没 @ 的群消息也没有），拿它当游标必然错页。
   *
   * 全量扫日志（不是只扫尾部）：`readTailEvents` 的早停对"按类型过滤"是安全的，但在她读一个
   * 冷清会话时会白读一大片别人的消息。这里取的是**每轮至多一次**的交互式调用（她主动点开），
   * 与"逐轮渲染"不是一个量级的开销，宁可实现简单、结论确定。
   */
  // 公开（不是 private）：这两个是**宿主接口**——main.ts 装配 catalog 时把它们递给
  // `read_channel`（工具层不读日志、不读别名表）。写成 private 就没法从 main 接线，
  // 而在 main 里另写一份"取最近 N 条"等于让同一件事有两份实现（v27/v30 记过同款坑）。
  async readChannelMessages(sid: string, limit: number, before?: number): Promise<ChannelMessageView[]> {
    const hits: ChannelMessageView[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
      const d = event.data;
      if (sidOf(d.channel, d.chatType, d.chatId) !== sid) continue;
      // 游标那一刀在**读完这一条的全部字段之前**：往回翻时绝大多数事件都落在游标之后，
      // 提前跳过它们省下的是每条都要算的预警查表（`flaggedNoteFor`）
      if (before !== undefined && event.seq >= before) continue;
      const flagged = this.flaggedNoteFor(d.messageId);
      hits.push({
        sid,
        channel: d.channel,
        chatType: d.chatType,
        chatId: d.chatId,
        person: d.person,
        // 平台昵称/群名片：**只用于显示**（认人用）；身份永远按 id 判（见 admin 的 ChannelMessageView）
        ...(d.nickname === undefined ? {} : { nickname: d.nickname }),
        text: d.text,
        messageId: d.messageId,
        msgSeq: d.msgSeq,
        // 落库时分配的事件 seq：`read_channel` 判"这个会话有没有新东西"与翻页游标用的都是它
        //（平台序号答不了这两个问题——官方单聊恒为 1，见 tools/admin.ts 的 ChannelMessageView.seq）
        seq: event.seq,
        ts: event.ts,
        ...(d.attachments === undefined ? {} : { attachments: d.attachments }),
        // "这条是不是在点她"：判据与唤醒那条路**同一个**（`group-at` 是平台 @、
        // `mentionsMe` 是适配器/关键词判定如实填的），收进唯一的 `mentionedInMessage`。
        // 为什么要在读的时候就算出来：`read_channel` 默认那一屏**只给提及**，
        // 而工具层拿不到宿主的关键词表（判定是宿主的事，见 channel/inbox.ts）。
        ...(mentionedInMessage(d) ? { mentionsMe: true } : {}),
        // 判过的消息**回放时也要带预警**：那句话她可能正是在"翻旧账"这一刻才看到的，
        // 而预警落在事件里、与她翻不翻无关——这正是把预警落成事件、而不是只在唤醒那一次
        // 渲染里拼一句的理由（换个时刻看同一条消息，结论不该变）。
        ...(flagged === null ? {} : { flaggedNote: flagged }),
      });
    }
    // 取数窗口才是"这一屏的候选"（`slice(-limit)` 就是工具层拿到的那些），所以图片事实
    // 也算在**窗口**上、名额也发在窗口上——不是算在整份日志上（那会为几十条历史白读文件）。
    const window = hits.slice(-limit);
    this.prepareAimedContextImages(window);
    return window;
  }

  /**
   * `read_channel` 的**点名例外**（2026-10-11 用户拍板）：给这一屏里"冲她来的"那些消息算一份
   * "图片能不能进上下文"的事实，挂在 `ChannelMessageView.contextImages` 上交给工具层。
   *
   * 三条判据**一处都不重写**：
   *   · 是不是冲她来的 ⇒ `imageAimedAtHer`；
   *   · 准入 ⇒ `contextImageAdmission`（地址形态 + 声明型别——与唤醒那条路、与预热那条路
   *     是同一个结论）；
   *   · 最后一米 ⇒ `readFileImage`，**渲染层注入 loader 自己那个函数**（见 real-loop 的
   *     `loadImage`/`readAttachmentImage` 与 render.ts 的 imagesOf）：同一个文件、同一个
   *     字节头上限，所以"这里说进得去"就等于"请求体里真有它"，不是两次各判一遍。
   *
   * 这里**只算事实、不装配**：装配（写 `image/attached`）由工具层在"这一屏到底给她哪几条"
   * 定下来之后做——候选窗口与那一屏不是同一集合（工具层那五个分支可能只摆窗口里的一部分）。
   *
   * **不下载**（与预热的明确分工）：字节由 `prewarmRecentAttachments` 每拍取（它扫的正是
   * `wake/channel`，而"冲她来的"消息必然走那条路），这里只读本地已有的那一份。理由是预算：
   * 预热是后台拍的预算（5s 下载 + 15s 压缩），而这是**交互式**的一次读（工具超时 10s，
   * 见 admin 的 read_channel）——在这里现下现压能把一次"翻开看看"拖成超时，那时她连
   * "这一屏有什么"都拿不到。"本地没有字节"照实说（那一行的地址照旧在，她自己 http_download 也行）。
   *
   * ⚠️ **已知的一处重复**（取舍写在这里，不藏着）：点名她的消息本身就是 `wake/channel`，
   * 而唤醒那条路也会把它的图注进上下文（渲染层的图片窗口按"最近 N 张事件"选，**不按内容去重**）。
   * 于是"她读一条刚叫醒她的带图消息"时，同一张图可能进请求体两遍。这里**没有**去重，因为要去重
   * 就得在宿主里再实现一遍那个窗口的挑选规则（"最近 N 张、seq 越过遮蔽点、model 可见"）——
   * 那是第二份判据，迟早与渲染层漂移，而漂移的后果是"行上说带了、请求体里其实没有"。
   * 代价有上限：一次读最多 N 张（上面那个常量），而地址与行数的成本一分没变。
   */
  private prepareAimedContextImages(window: ChannelMessageView[]): void {
    const budget = this.contextImageBudget();
    if (budget <= 0) return;
    let spent = 0;
    for (const item of window) {
      if (!imageAimedAtHer(item)) continue;
      const images = (item.attachments ?? []).filter(isImageAttachment);
      if (images.length === 0) continue;
      const facts: ContextImageFact[] = [];
      for (const image of images) {
        // 名额按**时间正序**发：她是从上往下读这一屏的，先遇到的那几张先带。
        if (spent >= budget) {
          facts.push({ state: 'over' });
          continue;
        }
        const fact = this.contextImageFactOf(image);
        if (fact.state === 'ready') spent += 1;
        facts.push(fact);
      }
      item.contextImages = facts;
    }
  }

  /**
   * 这一次读的图片名额：`vision.imagesToContext` 关着、或 `maxContextImages` 是 0 ⇒ **0**
   * （一条事实都不产出，那一行与默认那条路逐字相同：只给地址）。
   *
   * 为什么两个都要看：`imagesToContext` 是总闸（渲染层连 loader 都不装配），`maxContextImages`
   * 是"同时待在上下文里的图片张数"（渲染层那个从后往前数的窗口）。少看任何一个，这条路都会
   * 说出"已带进上下文"，而请求体里其实没有它。
   */
  private contextImageBudget(): number {
    const vision = this.deps.config.vision;
    if (vision.imagesToContext !== true) return 0;
    return Math.max(0, Math.min(READ_CHANNEL_CONTEXT_IMAGE_MAX, vision.maxContextImages));
  }

  /**
   * 一张图能不能进上下文（判据全是既有实现，见 `prepareAimedContextImages` 的注释）。
   *
   * 两步都必要、不是重复：
   *   ① `readAttachmentImage` 答复"这份字节算不算一张能进上下文的图"，并定下**读哪一份**
   *      （有压缩产物就用它——那是专门为上下文准备的小图；没有才退回原件）；
   *   ② `readFileImage` 拿①选中的那个**文件**再走一遍 loader 那条路（`image/attached` 的 key
   *      只能是本地文件、渲染层就是拿它调这个函数）。①认得出而②读不出，只可能出现在
   *      "字节是内联的 `data:`、而本地并没有落成文件"这种形态上——那时如实报 `no-local-bytes`，
   *      不许说"已带进上下文"。
   */
  private contextImageFactOf(image: { type: string; url?: string; name?: string }): ContextImageFact {
    const url = image.url ?? '';
    const admission = contextImageAdmission({ url, mime: image.type });
    if (!admission.admitted) return { state: 'denied', reason: admission.reason ?? 'unknown-media-type' };
    const viaAttachment = readAttachmentImage(
      this.deps.dataDir,
      { source: 'remote', key: url, mime: image.type },
      CONTEXT_IMAGE_HARD_BYTES,
    );
    if (!viaAttachment.ok) return { state: 'denied', reason: viaAttachment.reason };
    const file = viaAttachment.compressed
      ? compressedPath(this.deps.dataDir, url)
      : attachmentPath(this.deps.dataDir, url);
    const viaFile = readFileImage(file, viaAttachment.image.mediaType, CONTEXT_IMAGE_HARD_BYTES);
    if (!viaFile.ok) return { state: 'denied', reason: viaFile.reason };
    return {
      state: 'ready',
      key: file,
      // 型别取**字节头认出来的那个**（`readFileImage` 的结论）：它就是渲染层拼 data URL 用的那一个，
      // 拿声明那一栏（OneBot 的裸标签 `image`）写进事件只是让 loader 再嗅一遍、结论相同
      mime: viaFile.image.mediaType,
      ...(image.name === undefined || image.name === '' ? {} : { name: image.name }),
    };
  }

  /**
   * `read_channel` 的**第三个**读取口：这个会话里**发生过的事**（`channel/notice`）。
   *
   * 与 `readChannelMessages` 同一个理由由宿主来读（工具层不读日志），也与它同一套游标语义：
   *   • 不给 `before` ⇒ 取最近 `limit` 条；
   *   • 给了 ⇒ 取**事件 seq 严格小于它**的最近 `limit` 条（往回翻一页）。
   *
   * `sid` 是按 **`channel` + 推测的 chatType + `chatId`** 算的：notice 那一侧只有
   * "群"与"单聊"两档（平台给的信息就这么多，见 `ChannelNoticeData.chatType`），
   * 而 sid 的 `qq:group:<id>` / `onebot:group:<id>` 命名空间两边一致——
   * `group` 与 `group-at` 的归一本来就在 `sidKindOf` 里（见 `channel/sessions.ts`）。
   *
   * 拿不准就**不摆**：某个 notice 的 sid 算出来与本会话不同 ⇒ 它不是这个会话里的事，跳过。
   */
  // 公开理由同 `readChannelMessages`（宿主接口：main.ts 把它递给 read_channel）
  async readChannelNotices(sid: string, limit: number, before?: number): Promise<ChannelNoticeView[]> {
    const hits: ChannelNoticeView[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'channel/notice') continue;
      const d = event.data;
      // 形状再判一次：畸形事件（手工改过日志、旧版本写下的）**不进这一屏**——
      // 一条渲染不出来的东西摆进去只会让她读到一行空的
      if (!isChannelNoticeData(d)) continue;
      if (sidOf(d.channel, d.chatType, d.chatId) !== sid) continue;
      // 游标那一刀在读完字段之前（与 readChannelMessages 同一条：翻页时绝大多数事件落在游标之后）
      if (before !== undefined && event.seq >= before) continue;
      hits.push(noticeViewOf(d, event.seq, event.ts));
    }
    return hits.slice(-limit);
  }

  /**
   * `read_channel` 的**第四个**读取口：**她在这个会话里做过什么**（`channel/self-action`）。
   *
   * 与 `readChannelNotices` **逐字同一套**（同一理由由宿主读日志、同一套游标语义、
   * 同一句"拿不准就不摆"）：差别只有事件类型与字段——这条的 sid 是**落库时就写好的**
   * （`actionRecordOf` 从 `group_id` 算出来），所以不必像 notice 那样按 `chatType` 现推，
   * 少一处推测就少一处错的机会。
   *
   * 平台不对机器人自己发起的动作发 notice ⇒ 这条凭据只能从 MCP 回执那一层来
   * （`tools/mcp-entry.ts` 的 `onReceipt` → `channel/self-action.ts`）。
   */
  // 公开理由同 `readChannelMessages`（宿主接口：main.ts 把它递给 read_channel）
  async readChannelActions(sid: string, limit: number, before?: number): Promise<ChannelSelfActionView[]> {
    const hits: ChannelSelfActionView[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'channel/self-action') continue;
      const d = event.data;
      // 畸形事件（手工改过日志、旧版本写下的）不进这一屏：渲染不出来的一行只是噪音
      if (!isChannelSelfActionData(d)) continue;
      if (normalizeSid(d.sid) !== sid) continue;
      if (before !== undefined && event.seq >= before) continue;
      hits.push({ ...d, seq: event.seq, ts: event.ts });
    }
    return hits.slice(-limit);
  }

  /**
   * `read_channel` 的第二个读取口：**她在这个会话里说过的话**（"她读群时知道自己已经回过什么"）。
   *
   * 为什么要宿主来读（2026-10-04）：她说出去的话本身是**逐段**落进 `message/assistant` 的
   * （一次 151 字的发言在 IM 上发了 13 条，内容就在那 13 条里），但那些事件**没有会话坐标**
   * ——同一段历史里混着好几个通道的消息，逐段对上哪个群是不可能的。所以由 `speak` 在**IM 那一路
   * 真发出去**的那一刻补一条带 `sid` 的 `speak/sent`：那是"她说出去过"的凭据（失败/被拒没有它）。
   *
   * 归并成**一次 speak 一行**：切分是投递的属性，而 read_channel 的硬预算是行数——她的 13 条气泡
   * 在那边只占一行（用户 2026-10-04："不过不切分节省行数"）。归并键是 **`callId`**（"一次工具调用"
   * 的本征标识，与 `tool/call` 同源）：一次 speak 的多条气泡并成一行，而同一个 turn 里她连着说的
   * 两段各占一行——按 turn 并会把那两段读成一段。
   *
   * 只认带 `text` 的那些：旧日志（这个字段之前）读不回来——不是缺陷，是"日志只增不改"的必然。
   */
  // 公开理由同 `readChannelMessages`（宿主接口：main.ts 把它递给 read_channel）
  async readChannelSpoken(sid: string): Promise<ChannelSpoken[]> {
    /** 归并键 → 那一段话（旧事件没有 callId 时退回按 turn、再退回"各自一行"） */
    const bySpoken = new Map<string, ChannelSpoken>();
    let counter = 0;
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'speak/sent') continue;
      const d = event.data;
      // 三件闸：**判据只此一处**（`deliveredToSid`，与产生侧 `deliverToSession` 同源）。
      // 只有真的送到某个会话的那条回执算数：本机对话流（`channel='log'`）与告警出口
      // （`notify`）不代表话到了那边；投递失败/被拒的那些根本没有这条回执——"没发出去"
      // 不算"她说过"。
      //
      // 2026-10-07 之前这里是手写的 `d.channel !== 'reply-url' || d.text === undefined …`，
      // 与产生侧那份手写的形状**各写一遍**，于是 `report` 那条漏了 `text` 就在这里被静默丢掉
      // ——她 report 完读"我说过什么"读不到自己那一篇（病害与修法见 `deliverToSession` 的注释）。
      const deliveredSid = deliveredToSid(d);
      if (deliveredSid === null) continue;
      // 归一之后再比：`speak` 的 `to` 与唤醒派生的回投地址同形，但历史日志里可能有
      // `group-at` 那种旧写法（归一之前），不归一会让她的发言在群里凭空消失
      if (normalizeSid(deliveredSid) !== sid) continue;
      // 过完闸才取文本：`deliveredToSid` 已经保证它是非空字符串（类型也据此收窄）
      const text = d.text as string;
      /**
       * 平台回的这条消息 id（2026-10-12 起 `speak/sent` 才带它）。
       *
       * **可选、缺席是常态**：旧日志没有它（"日志只增不改"的必然），通道给不出时也没有。
       * 缺席时这一行照旧读得出来——`（我）`那一行不过是少一格 `·m<id>`。
       */
      const messageId = typeof d.messageId === 'string' && d.messageId !== '' ? d.messageId : undefined;
      const atMs = Date.parse(event.ts);
      const key = d.callId !== undefined
        ? `c\u0000${d.callId}`
        : d.turn === undefined ? `\u0000${counter++}` : `t\u0000${d.turn}`;
      const prev = bySpoken.get(key);
      const parts = d.spokenParts ?? 1;
      // 归并成一行时**保留第一条的 id**（`??` 的次序就是这条纪律：先来的那个锚不动，
      // 只有它缺席才让后来的补上）。理由与 speak 那边取"第一条"同源：
      // 这一行是"她这一段话"，锚要落在她开口的第一条上。
      const mergedMessageId = prev?.messageId ?? messageId;
      bySpoken.set(key, prev === undefined
        // 第一次发言取回执自己的时刻（第一次投递那一刻）
        ? {
            text,
            ts: event.ts,
            parts,
            seq: event.seq,
            atMs,
            // 可选的键只在有值时才摆（`exactOptionalPropertyTypes`：缺席 ≠ 值是 undefined）
            ...(messageId === undefined ? {} : { messageId }),
          }
        // 同一次发言的下一段：接在她那口气后面，时刻推到最后一次（读起来是"这一段说到这时"）
        : {
            text: prev.text + text,
            ts: event.ts,
            parts: prev.parts + parts,
            seq: event.seq,
            atMs,
            ...(mergedMessageId === undefined ? {} : { messageId: mergedMessageId }),
          });
    }
    // 升序交给调用方（read_channel 合批时自己排），这里保持日志顺序即可
    return [...bySpoken.values()];
  }

  /**
   * 会话显示名（sid → 名字）：给人声明的联系人表最高优先，其次是她自己的别名表。
   *
   * 与 `contactFacts` 里那份清单**同一个判据**（`resolveSessionName`）：两处各写一套的代价
   * 是她读消息时看到的名字与清单上的对不上——而名字正是"这条是谁说的"唯一的凭据。
   */
  // 公开的理由同上（宿主接口：read_channel 的渲染要用它解析名字）
  resolveChannelName(sid: string): string | null {
    const contacts = this.deps.config.persona.contacts;
    // 归一之后查（旧联系人表里可能还是 `qq:group-at:<群id>` 的写法）：名字是"这条消息是谁说的"
    // 唯一的凭据，改口径那一刻不该让它失效
    const named = resolveNameForSid(sid, new Map(Object.entries(contacts)), this.readAliases());
    return named === null ? null : named;
  }

  /**
   * 本轮通道消息的渲染上下文（谁在哪个会话里说的）。
   *
   * 只服务本轮那个会话：`render.ts` 的 `channelRender` 是**一个**上下文（渲染层不查会话簿，
   * 它是纯函数），而一段历史里可能混着好几个通道的消息——那些更早的通道事件按"没有名字"渲染
   * （退回 openid）。这是刻意的取舍：给每条历史消息都配上当时的名字，等于让渲染层持有一份
   * 会随她改别名而变的表，缓存前缀就再也稳不住（铁律 1）。本轮那条最重要——她要回的就是它。
   *
   * ⚠ v76：这份上下文**只喂本轮钉住的那条唤醒**（渲染层收口，见 render.ts 的 `contextFor`），
   * 历史一个字节都不吃它；这条纪律的实现不在这一侧，别在这里加"顺便给历史也配一份"。
   *
   * ⚠ **判据必须与"钉住的那条"同源**（v76 接线时抓到的坑）：`agent-loop` 的 `pinnedWake` 是
   * `wakeEvents[0]`，而本类的 `wakeChannelData` 取的是 `lastChannelWake`（回投要回**最后**说话的
   * 那个会话）。同一批里攒了两条通道消息时，拿后者给前者配名字就是**张冠李戴**——名与 openid
   * 对不上，比不配名字更坏。所以这里收成"**只认传进来的那条钉住的唤醒**"：它不是
   * `wake/channel` 就没有上下文（心跳/定时器/界面消息/混合批的头部是心跳，都是这一支）。
   *
   * 心跳轮 / 定时器轮 / 界面消息轮 ⇒ 返回 undefined ⇒ deps 里落 `channelRender: null`
   * ⇒ 渲染与"没有这个字段"逐字节相同。
   */
  private channelRenderContext(pinnedWake: AppEvent | null): RenderChannelContext | undefined {
    if (pinnedWake === null || pinnedWake.type !== 'wake/channel') return undefined;
    // 判据只有一处（`channel/sessions.ts` 的 `channelRenderOf`）：运行期与重放的旧日志回退
    // 路径共用一个函数，两份实现迟早漂成"当时带名字、复盘写成 openid"。
    // 名字表在这里读一次、两段都给它（会话别名 + 群成员别名，同一份 `aliases.md`）。
    const { sessions, members } = this.readAliasTables();
    return channelRenderOf(pinnedWake.data, {
      contacts: new Map(Object.entries(this.deps.config.persona.contacts)),
      aliases: sessions,
      memberAliases: members,
      // 第四档（群成员档案里那个自动占位名）：与 `personNameOf` 的最后一档同源
      groupMemberNameOf: (person) => this.groupMemberName(person),
    });
  }

  /**
   * **第四档**（`data/group-members.json` 里那个自动占位名）——`personNameOf` 的最后一档。
   *
   * 为什么单独抽出来：共享的 `channelRenderOf` 也要这一档（它自己**不读盘**，只收一个
   * `groupMemberNameOf` 入参），而这一档要 `refresh()` + 内存簿；两处各写一遍会把
   * "先刷盘再查"这条顺序漂丢一半。人写的三档仍由 `resolvePersonNameFromTables` 判。
   */
  private groupMemberName(person: string): string | null {
    if (this.groupMembers === null) return null;
    this.groupMembers.refresh();
    return this.groupMembers.nameOf(person);
  }

  /**
   * 会话话题（sid → "在聊什么"）：清单那一行缀的那半句。
   *
   * 由 `channel/topic` 事件折来（`foldChannelEvents`）——概要是 light 跑出来、落成事件的，
   * 渲染层只读结论。**读不到就不缀**：编一个话题比没有话题更坏（她会照着一个不存在的事去接话）。
   */
  private channelTopicOf(sid: string): string | null {
    return this.channelTopics.get(sid) ?? null;
  }

  /**
   * 待办里有没有"群里有人叫她"的那一条：有就返回那个会话的 sid（否则 null）。
   *
   * 判据与 `channel/inbox.ts` 的唤醒判据同源：`group-at`（平台 @）或 `mentionsMe`（关键词命中
   * 或平台 mentions）。**私聊不算**——私聊里没人"提及"她，那是一对一在说话。
   *
   * 从日志里找那几条待办事件（投影的 pending 只有 seq/source，没有消息内容）。
   */
  private mentionSidOf(pending: readonly { wakeSeq: number }[]): string | null {
    const wanted = new Set(pending.map((item) => item.wakeSeq));
    if (wanted.size === 0) return null;
    for (const seq of wanted) {
      const event = this.deps.log.get(seq);
      if (event === null || event.type !== 'wake/channel') continue;
      const d = event.data;
      const mentioned = d.chatType === 'group-at' || d.mentionsMe === true;
      if (mentioned && d.chatType !== 'c2c') return sidOf(d.channel, d.chatType, d.chatId);
    }
    return null;
  }

  /**
   * 话痨会话的话题概括（v32）：**只为"攒够了一批新消息"的会话跑**。
   *
   * 两个阈值都定在这里，理由是它们一起决定"值不值得花一次 light"：
   *   • **未读 ≥ 5**：一两条不构成"话题"（顶多是"有人说了句话"，未读数已经说清了）；
   *   • **距上次概括 ≥ 10 分钟**：群里连着发二十条，不必每拍都重新概括一遍——
   *     话题是给人扫一眼用的，它的价值在"大概在聊什么"，不在实时。
   *
   * `mentionSid`（2026-10-02 加）是用户的口径：**群里有人叫她的时候，未读门槛让路**——
   * "发生提及、at 的时候，light 模型会先审计积累消息，然后给出话题 peek，然后告示进入
   * 对话流告知 agent"。所以那条路上只要攒了 ≥ 1 条就概括；10 分钟那道闸照旧
   * （同一段对话里连着叫两声，第二声不必再花一次 light——话题还是那个话题）。
   *
   * 三条不许：**不许阻塞**（`await` 在每拍里，但失败立刻返回）、**不许抛**（summarize 自己
   * 承诺不抛，这里再包一层）、**不许写假话题**（失败/空串就不落事件，清单上那一行照旧不缀）。
   *
   * 平时只跑一个会话（本轮未读最多的那个）：一次 tick 花一份 light 就够了，剩下的下一拍再说。
   */
  private async summarizeChattySessions(mentionSid: string | null = null): Promise<void> {
    if (typeof this.deps.ds?.generate !== 'function') return;
    const floor = mentionSid === null ? TOPIC_MIN_UNREAD : 1;
    const nowMs = this.deps.now().getTime();
    /**
     * **"没人理的群"这一道闸**（v66）：她 7 天内没在这个群回过话、也没人在群里 @/提及她
     * ⇒ **不给它跑话题概括**（不产 `channel/topic`）。
     *
     * 判据是纯函数 `isUnattendedGroup`（`channel/topic.ts`）——三条全取自投影、可复算：
     * ①最近一次提及早于窗口（或从来没有）②她最后一次发言早于窗口（或从来没有）③未读 > 0。
     * 它**不是** `mentionSid` 那条例外能绕开的：被 @ 到的那一刻 `mentionedAt` 就是"刚刚"，
     * 于是这个群天然落在"有人理"那一侧——两道判据不会互相打架。
     *
     * **消息一条不丢**：未读计数、信箱、`read_channel` 全都不动（这一道闸只掐"要不要花一次
     * light 概括它"）。清单上「在聊：…」只在有 topic 时才出现 ⇒ 那半句自然不缀，不必再删字。
     */
    const attended = (entry: KnownSession): boolean => !isUnattendedGroup(
      entry,
      { spokeAt: this.spokeAt.get(entry.sid), mentionedAt: this.mentionedAt.get(entry.sid) },
      nowMs,
    );
    const wanted = this.sessionBook.filter((entry) => entry.unread >= floor && attended(entry));
    // 提及那条优先（用户在叫她了）；没有提及就照旧挑未读最多的那个
    const candidate = (mentionSid === null ? undefined : wanted.find((entry) => entry.sid === mentionSid))
      ?? wanted.sort((a, b) => b.unread - a.unread)[0];
    if (candidate === undefined) return;
    const lastAt = this.topicAt.get(candidate.sid);
    if (lastAt !== undefined && nowMs - lastAt < TOPIC_MIN_INTERVAL_MS) return;
    // 先记账再跑：概括失败也不该每拍重试同一个会话（那会变成一台烧钱的空转机）
    this.topicAt.set(candidate.sid, nowMs);
    // 上次概括覆盖到哪一条（事件 seq）：它落在日志里，重启后由 warmUp/fold 折回来，
    // 所以"同一段不重复概括"这条在重启之后照样成立（内存里的 topicAt 做不到这一点）
    const sinceSeq = this.topicSeq.get(candidate.sid) ?? 0;
    const messages: AppEvent[] = [];
    for await (const event of this.deps.log.readAll()) {
      if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
      const d = event.data;
      if (sidOf(d.channel, d.chatType, d.chatId) !== candidate.sid) continue;
      // **只收"她还没看过"的那些**（msgSeq > 已读位，与会话簿算未读同一个判据）。
      //
      // 为什么必须这么收（2026-10-02 实测）：原来取"最近 30 条"，而这个群一共只有 28 条
      // ——于是**整个群的历史**（跨 2.5 小时，含前面那些测试串和私密往来）被一起喂了进去，
      // light 给出的概括成了「测试弥亚小姐能否选择不回复消息」这种**元判断**，
      // 而当时真正在说的是"用户要出门补课、让她自己待着"。
      // 话题是"那边**现在**在说什么事"，喂进去的东西必须是**新话**。
      if (d.msgSeq <= candidate.readUpToSeq) continue;
      // 再挡一道：**上次概括过的那一段不重复概括**（用户："每个总结竟然都是一样的，反复刷新？"）。
      // 判据用事件 seq（`channel/topic.toSeq` 记的就是它）：它落在日志里，所以重启之后仍然有效
      // ——原来的节流只有内存里那个 `topicAt`，一重启就归零，于是同一段没读过的消息会被反复
      // 概括出同一句话，白花 light 还让界面上的卡片看起来在"反复刷新"。
      if (event.seq <= sinceSeq) continue;
      messages.push(event);
    }
    // 再按条数收一道口：新话很多时只喂最近这一批（再多只会得一个更糊的概括）
    const recent = messages.slice(-TOPIC_MAX_MESSAGES);
    if (recent.length < floor) return;
    try {
      await new TopicSummarizer({
        ds: this.deps.ds,
        now: this.deps.now,
        log: this.deps.log,
        projection: this.deps.projection,
        turn: 0,
      }).summarize(candidate.sid, recent, { nameOf: (person) => this.personNameOf(person) });
    } catch (err) {
      this.write(`[话题概括] 失败（不影响任何判断）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 发言人（openid）→ 名字：给话题概括用。
   *
   * 名字的真源只有两处（联系人表、她自己的别名表），而**两张表的键都是 sid**——所以能直接
   * 认出来的只有"单聊会话的对方"：`qq:c2c:<openid>` 里的 openid 就是那个人的 id。
   * 群里发言的人没有单独的键，但只要他有过单聊（用户就是这样），两处一拼就认出来了：
   * 用户 11:03 在群里发的那几句，概括里该写"用户（OWNER）"而不是"甲"。
   * 认不出的返回 null，由概括那边退成 甲/乙/丙（不编名字）。
   */
  /** 工具层的口：发言人 → 名字（`read_channel` 每行那个"谁"用） */
  resolvePersonName(person: string): string | null {
    return this.personNameOf(person);
  }

  /**
   * **人写的三处**取名字（用户手写的联系人表、她的会话别名、她的**群成员别名**），
   * 不含群成员档案那条机器攒的。判据只在 `sessions.ts` 的 `resolvePersonNameFromTables` 一处。
   *
   * 群成员别名（`aliases.md` 的 `# 群成员` 段，裸 id）是 2026-10-11 接上的：在那之前，她按
   * 段头那句"只在认人时用"写下的裸 id 行（她真写了六条）**框架一条都没消费**——群里的人
   * **可能从没私聊过她**，而这里原来只会合成 `*:c2c:<id>` 两个键（那要求他先从那扇单聊门
   * 说过话）。缺口的来龙去脉与"它修不到哪些写法"见 `resolvePersonNameFromTables` 的注释。
   */
  private personNameFromHumanTables(person: string): string | null {
    if (person === '') return null;
    const { sessions, members } = this.readAliasTables();
    return resolvePersonNameFromTables(
      person,
      new Map(Object.entries(this.deps.config.persona.contacts)),
      sessions,
      members,
    );
  }

  /**
   * 只从**人写的**那几处取名字，不含群成员档案。
   *
   * 与 `personNameOf` 的区别就是"不含档案"：注册前要用它判断"这人已经有名字了吗"，
   * 若把自己也算进去，就会得出"他已有名字（我刚发的占位号）"而永远不再更新。
   */
  private humanSourceNameOf(person: string): string | null {
    return this.personNameFromHumanTables(person);
  }
  /**
   * **已知是用户的 id**：联系人表里标成用户名字的那条会话的**第三段**（那个 id 本身）。
   *
   * 用户 2026-10-04 定稿：**官 bot 上用户身份的唯一来源就是这一条**，群成员不参与标记
   * （"其他群成员不能标记为用户"）。之所以还要一个集合：同一个 id 出现在群里时，
   * 那一轮也该算最高档——实测他在群里的 member_openid 与单聊 openid 就是同一个值，
   * 所以这条规则天然覆盖了"用户在群里说话"。
   *
   * **2026-10-07：命名空间不再限定 `qq:`**（原来只挑 `parts[1] === 'c2c'` 的键，但**不看**
   * 前缀是什么）。原因是"同一个人在不同通道上有不同的 id"——官方那条路给的是 32 位 openid
   * （`qq:c2c:0000…`），OneBot 那条路给的是**数字 QQ 号**（`onebot:c2c:1234567891`），
   * 两个值永不相等。只认官方那个，后果是**用户在 OneBot 群里被判成 `external`（客人）**：
   * `tools.groupSceneHardRefusal` 打开时她会拒掉本机类工具，或者要他"报一下身份"——
   * 而那是用户（报告 §3.13）。
   *
   * 判据因此只剩两条，与通道无关：**键是 `c2c`（单聊会话）**、**那个名字是用户名字**。
   * 于是用户想在哪条通道上被认出来，就往联系人表里填那一条通道的 id——
   * 这是**人写的声明**（与"其他群成员不能标记为用户"同一条纪律：身份永远由人声明，不由机器猜）。
   */
  private ownerIds(): Set<string> {
    const d = this.deps;
    const ids = new Set<string>();
    for (const [sid, name] of Object.entries(d.config.persona.contacts)) {
      const parts = sid.split(':');
      if (parts[1] === 'c2c' && parts.length >= 3 && isOwnerLabel(name, d.config.persona.owner)) {
        ids.add(parts.slice(2).join(':'));
      }
    }
    return ids;
  }

  /**
   * 这一轮的**可信级别**（`owner` / `self` / `trusted` / `external`）——判据的**唯一入口**。
   *
   * 判据本身在 `runtime/trust.ts` 的 `trustOfBatch`（唤醒批次 + 联系人表 + 用户 id 集合，
   * 三样都在宿主手里），这里只是**组装输入**。
   *
   * **两个消费点，都不碰工具清单**：`agentDeps()` 里 derive 出场合喂 `authzGate`（`owner`/`self`
   * → `owner`，其余 → `guest`），以及把原始档位递给 `budget/consumed.context.trust`（纯观测）。
   * 工具清单是**常量**口径（`agentDeps()` 的 `modelVisibility` 那一段），不读这个结论——
   * 2026-10-04 用户定稿"工具清单恒定"，2026-10-11 裁决把它恢复过来。
   *
   * 认不出来的来源一律 `external`——判据在 `trustOfWake` 的 default 分支，不在这里补默认。
   */
  private trustOfTurn(wakeEvents: readonly AppEvent[]): TurnTrust {
    const d = this.deps;
    return trustOfBatch(
      wakeEvents,
      new Map(Object.entries(d.config.persona.contacts)),
      d.config.persona.owner,
      wakeEvents.length === 0 ? new Set<string>() : this.ownerIds(),
    );
  }

  /**
   * 发言人（`person`）→ 名字：**这一条路是"她眼里这个人叫什么"的唯一判据**。
   *
   * 顺序（人写的永远压过机器攒的）：用户手写的联系人表 > 她的会话别名 > 她的**群成员别名**
   * >（最后一档）群成员档案里那个自动占位名。
   * 前三档在 `sessions.ts` 的 `resolvePersonNameFromTables` 一处判；这里只接最后一档，
   * 因为那一档要读盘（`GroupMemberBook`），而前三档是纯查表。
   *
   * 消费点：唤醒正文的 `personLabel`（`channelRenderContext`）、`read_channel` 每行那个"谁"、
   * 话题概括的 `nameOf`、以及通知行（预警 / 点名）——**都读这一个函数**，所以在同一份上下文里
   * 同一个人只会有一个名字。
   */
  private personNameOf(person: string): string | null {
    // ①②③ 人写的三处（含群成员别名那一档）：认得出就直接用
    const named = this.personNameFromHumanTables(person);
    if (named !== null) return named;
    // ④ 群成员档案（2026-10-04）：群里的人可能**从没私聊过她**，也没有人给她写过名字，
    //    那正是"自动注册"要解决的问题。它是**最后一档**：占位名"群友A（群昵称：用户）"
    //    是机器发的，发了就不改（见 group-members.ts），绝不能压过她自己写的名字。
    //    判据抽在 `groupMemberName`（共享的 `channelRenderOf` 也要这一档，不许写两份）。
    return this.groupMemberName(person);
  }

  // ──────────────────────────────── 心跳与必要性门 ────────────────────────────────

  /**
   * 心跳节律：概率模型（design §4.12）。安静 < floor 绝不触发、≥ ceil 必然触发，
   * 中间每个 tick 抽一次签且命中概率随安静时间单调上升。
   *
   * 四个旋钮：floor / ceil / tick，加上**目标均值**（`wake.heartbeatTargetMeanMin`，
   * "平均多久醒一次"）——曲线的形状指数 α 不在这里给，`Heartbeat` 构造时按目标均值反解
   * （`solveHeartbeatAlpha`，见 src/wake/heartbeat.ts 的文件头）。**没有基线也没有退避倍数**：
   * 旧模型那两个字段已随 `wake.heartbeatBaselineMin` / `wake.idleBackoffMax` 一起删除。
   */
  private makeHeartbeat(): Heartbeat {
    const minutes = (value: number): number | undefined =>
      Number.isFinite(value) && value > 0 ? value * 60_000 : undefined;
    const floorMs = minutes(this.deps.config.wake.heartbeatFloorMin);
    const ceilMs = minutes(this.deps.config.wake.heartbeatCeilMin);
    const tickMs = minutes(this.deps.config.wake.heartbeatTickMin);
    const targetMeanMs = minutes(this.deps.config.wake.heartbeatTargetMeanMin);
    return new Heartbeat({
      projection: this.deps.projection,
      ...(floorMs !== undefined ? { floorMs } : {}),
      ...(ceilMs !== undefined ? { ceilMs } : {}),
      ...(tickMs !== undefined ? { tickMs } : {}),
      ...(targetMeanMs !== undefined ? { targetMeanMs } : {}),
      now: this.deps.now,
      policy: () => this.heartbeatPolicy(),
      onDebug: this.write,
      onFire: (firing) => this.noteHeartbeat(firing),
    });
  }

  /**
   * 节律策略（热更点）：返回 'skip' 表示此刻不心跳。判据只有一条——
   * **队列里已经压着一整批没处理完的输入**时不再往里塞心跳：那种情况下循环本来就要忙起来，
   * 再插心跳只会把真实输入挤到批次之外。策略绝不去读日志做重活（它在定时器回调里跑）。
   */
  private heartbeatPolicy(): 'fire' | 'skip' {
    if (this.deps.projection.pending.length >= BATCH_LIMIT) return 'skip';
    return 'fire';
  }

  /**
   * 群消息攒批门（design §4.24）：pending 里**只有**群聊通道消息、且最早一条还没到窗口时，
   * 本拍不起 turn——群里的一条 @ 常常只是半句话，逐条起 turn 既贵又容易答错。
   *
   * 判据本体在 group-batch.ts 的纯函数里（四种不攒的情形逐条钉在那边）：这里只负责
   * 给它三个输入——队列、日志句柄、当前时刻与窗口。窗口到点不需要额外定时器：
   * 主轮询（pollMs）下一拍这个门就返回 false，积攒的消息一起被认领。
   */
  private holdsGroupBatch(p: Projection): boolean {
    return holdsGroupBatch({
      pending: p.pending,
      getEvent: (seq) => this.deps.log.get(seq),
      nowMs: this.deps.now().getTime(),
      windowMs: this.deps.config.channels.qqOfficial.groupBatchMinutes * 60_000,
    });
  }

  /** 心跳落地：事件已在 HeartbeatSource 里写盘（appendSync），这里只留一行可读的诊断 */
  private noteHeartbeat(firing: HeartbeatFiring): void {
    this.write(`[心跳] 安静 ${firing.quietSeconds}s，命中（p=${firing.probability.toFixed(3)}，`
      + `roll=${firing.roll.toFixed(3)}），空拍 ${firing.idleTicks}，`
      + `压力 ${firing.pressure.toFixed(2)}，下一次抽签 ${Math.round(this.heartbeat.nextDelayMs() / 60_000)} 分钟后`);
  }

  /**
   * **这里曾经是唤醒路由 `gateAdmits`**（必要性门的接线点）：2026-10-05 连门一起拆掉了。
   *
   * 它当年做两件事：① 心跳批次先过门（规则短路优先、light 模型兜底）；② 其余来源直接进 turn。
   * 拆它的原因只有一条但足够：门对心跳拍给出的"沉默"在旧口径里等于**一个请求都不发**，而用户把
   * 心跳改成**真实唤醒**——心跳这一拍就是去保温供方那份 KV 前缀的（唤醒一次的花费远少于前缀被
   * 回收的花费；实测拆之前全库 52 次心跳、走了模型的 0 次）。现在**每一条唤醒都照常进 turn**，
   * "开不开口"由她自己定，所以这里不再需要任何分流——这也是为什么它没有留下一个空壳方法。
   *
   * 原意、为什么废、以及"**别再把它接回心跳拍**"的警告：docs/design.md 的
   * 「试过并废掉的口径：回复必要性门」。心跳拍本身的形状（同一份冻结前缀、heavy 车道、
   * 可审计链 `wake/heartbeat → input/claimed → memory/selected{injection:'heartbeat'} →
   * step/start → budget/consumed{lane:'heavy'}`）在 `test/heartbeat-real-wake.test.ts` 里钉着。
   */

  /** 刹车钩子（agent-loop 每 step 边界调用）：判定与事件写入都在 budget-guard 里 */
  private budgetHook(): AgentLoopBudget {
    return {
      checkBeforeStep: (p) => this.guard.checkBeforeStep(p),
      softHint: (p) => this.guard.softHint(p),
      stepCallLimit: () => this.guard.stepCallLimit(),
      onStepOverflow: (actual) => this.guard.noteStepOverflow(actual),
    };
  }

  /**
   * 唤醒路由（persona.md §3）：本拍首个唤醒若「带人」就注入对应关系档案。
   *
   * 带人的来源有三处：webhook 与 manual 自带 `person` 字段（手动唤醒由 GUI/CLI 填
   * `config.persona.owner`）；**通道消息**（QQ / OneBot）的 `person` 是发送者标识——
   * 私聊是 `user_openid`，群里是 `member_openid`（同一个人的两个不同值，所以同一个人
   * 可能对应两份档案）。文件不存在就当没这个人，不注入也不报错。
   *
   * 判据与事后重放**共用一份实现**（persona/relationship.ts）：两处各写一份的代价不是冗余，
   * 是重放出来的请求与当时对不上，而重放的全部意义就在"一模一样"。
   */
  private relationshipForCurrentWake(): RelationshipNote | null {
    const first = this.deps.projection.pending[0];
    if (!first) return null;
    return relationshipForWake(this.deps.log.get(first.wakeSeq), this.deps.dataDir);
  }

  /** 落一条承诺类事件。**返回它**：调用方偶尔要那个 seq（如"有人开口"要记下是哪条唤醒） */
  private appendSync(
    type: string,
    data: unknown,
    visibility: 'model' | 'internal',
    /**
     * 已经分配好的 seq（省略就现取一个）。
     *
     * 为什么允许外部先取：`wake()` 要在**落库之前**用那个 seq 补 `msgSeq`（见那里的注释），
     * 而 seq 是"分配即消耗"的——先取一次、再把它传进来，才不会有第二个数。
     */
    presetSeq?: number,
  ): AppEvent {
    const event = {
      seq: presetSeq ?? this.deps.log.nextSeq(),
      ts: this.deps.now().toISOString(),
      type, data, visibility,
      origin: 'runtime/real-loop',
    } as unknown as AppEvent;
    this.deps.log.append(event, { sync: true });
    applyOne(this.deps.projection, event);
    finalizePressure(this.deps.projection, event.ts);
    // 信任事件就地折入（不等下一拍）：确认后本拍就能生效，不必重启
    this.skills?.applyTrustEvent(event);
    return event;
  }
}
