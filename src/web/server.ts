/**
 * Irmia Agent — 本地 HTTP 服务（docs/design.md §4.15 / §4.16、docs/frontend.md §4）
 *
 * 一个 Node 原生 `http` 服务，**两条路由，两份互不通用的凭据**（2026-10 起不再有第三条）：
 *   • `/api/*`     —— 桌面界面（GUI）的读写口。全部要求 `Authorization: Bearer <会话凭据>`，
 *                     写命令再按"危险操作表"要求 `X-Confirm: <操作英文标识>`。
 *   • `/webhook/*` —— 外部回调入口（design §4.15：Bearer 校验、body ≤64KB、每源令牌桶）。
 *                     **只认 webhook 专用凭据**（`data/.webhook-secret.json`）：
 *                     界面会话凭据与迁移期那份 `.ui-token` 在这条通道上一律 401。
 *
 * **两份凭据为什么必须分开（B9，2026-10）**：外部系统（监控、别台机器上的脚本、
 * Home Assistant……）只需要"投一条事件进来"，而它们过去只能拿界面会话凭据——那份东西会随
 * "改密码/登出/换机器"失效，且同时能读**整个** `/api/*`（她的记忆、人格、日志、配置掩码）。
 * 于是"给它一条只够投递的最小权限凭据"这件事在当时做不到。专用凭据就是那条最小权限：
 * 权限方向是单向的（能写一条 `wake/webhook`，读不到任何东西），生命周期独立于界面那扇门。
 * 完整的取舍（含"收窄会把已经在用的外部脚本打断"这条代价）写在 `web/webhook-secret.ts`
 * 的文件头与 `docs/operations.md` §4.2。
 *
 * **`web/` 静态目录与网页观测台已整个删除**（用户口径：「web 默认关闭，我们框架不要 web」
 * 「删掉 web」）。这个框架的正式产品**只有 GUI**，没有第二张脸要维护；过去那条
 * `/` → `web/index.html` 的静态分支因此整条移除，`/` 与任何未知路径统一回一句人话
 * （`no-web-ui`），而不是一个让人摸不着头脑的 404。
 *
 * 四条必须说清的口径：
 *
 * **① 写命令 = 事件日志的唯一写通道**。所有 `POST /api/commands/*` 一律
 * `log.nextSeq() → append({sync:true}) → applyOne(投影) → finalizePressure`：先落盘（fsync 返回）
 * 才算命令生效，绝不"改了内存等下一拍"。这与 CLI 的纪律同源（cli.ts 只对 review resolve 真写日志，
 * 因为那里是同一进程里唯一的写者）。
 *
 * **② SSE 只广播、不兜底**。广播靠**轮询 `log.latestSeq()` 的尾部**（不侵入 real-loop 的 append 点：
 * 事件日志只有"已分配 seq"这一个可靠的追加信号，缓冲中的观测事件同样能被 `log.get()` 读到）。
 * 断线补拉凭 `Last-Event-ID`：先补 (lastId, 当前尾部] 的一段，再接实时流；补拉量超过上限时
 * 只补最近一段——前端重连后本来就要全量重拉 `/api/projection`（frontend.md §4），
 * 投影是派生数据，全量覆盖永远安全。
 *
 * **③ 查询函数与 CLI 共用**。budget / review / 事件摘要直接调用 `cli.ts` 的导出
 * （`buildBudgetReport` / `buildReviewEntries` / `summarizeEvent`）——"界面上看到的和命令行看到的
 * 不一样"是这类系统最恶心的故障，唯一的根治办法是不给第二份实现。
 *
 * **④ 密钥不落日志**。webhook 记录的 headers 里 `authorization` / `cookie` 等一律存 `[redacted]`；
 * 界面的凭据（密码哈希 / 会话凭据）只写在 `data/.auth.json`，webhook 专用凭据只写在
 * `data/.webhook-secret.json`（两处盘上都只有 sha256），**三者的原文都不进任何日志**
 * （operations.md §1）。认证的完整口径见 `web/auth.ts` 与 `web/webhook-secret.ts` 的文件头。
 *
 * 约定：值导入写 `.ts`（`--experimental-strip-types` 只擦类型、不改路径解析），纯类型导入写 `.js`。
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync, existsSync, appendFileSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ALERT_DIR_NAME, type AlertNotifier } from '../alert/notifier.ts';
import { buildBudgetReport, buildReviewEntries, summarizeEvent } from '../cli.ts';
import { answerHuman } from '../runtime/plan-mode.ts';
import type { AppConfig, JsonObject, JsonValue } from '../config/config.js';
import { CONFIG_FILE_NAME, MENTION_KEYWORD_LEN_MAX, MENTION_KEYWORD_MAX, configHash, loadConfig } from '../config/config.ts';
import { classifyConfigField, diffConfigFields } from '../config/watcher.ts';
import { resolveRestartShell } from '../runtime/restart-shell.ts';
import { chooseRestartPath, parseRestartPath, restartReasonText, restartTraceLine, backendEntry, BUNDLED_NODE_REL, RESTART_FAILURE_REASONS, type RestartPath } from '../runtime/restart-chain.ts';
import { deriveRequest } from '../runtime/agent-loop.ts';
import { contactFactsForReplay, turnBlockFactsForReplay, warnExemptJudgeOf } from '../runtime/replay.ts';
import { GroupMemberBook } from '../channel/group-members.ts';
import { WarnExemptBook } from '../channel/warn-exempt.ts';
import { installSnowLuma } from '../services/install-snowluma.ts';
import { KEY_NAMES, isKeyName, keyStatus, writeKeyFile, type KeyName } from '../config/keys.ts';
import { groupsForTools, groupIdOfTool, mcpGroupId, mcpServerOfTool } from '../tools/groups.ts';
// 申请单那一套（她发起 → 待批 → 用户点批准/驳回 → 框架执行 → 回执）：
// 唯一实现在 `grant/mcp-grant.ts`（判据、落地、卡面文案、回执与唤醒都在那里）
import {
  GRANT_REJECT_REASON_MAX, applyGrant, grantReceiptLine, grantsResolvedDirOf, grantsDirOf,
  listGrants, readConfiguredServer, wakeForGrant, writeGrantOutcome,
  type GrantApplyResult, type GrantWakeFacts,
} from '../grant/mcp-grant.ts';
// `desc` 那一句的来源与判据（唯一实现：索引行、申请单、界面回执三处读同一份）
import { mcpServerDescOf, sanitizeMcpDescText } from '../mcp/description.ts';
import {
  DEFAULT_HOOK_TIMEOUT_MS, HOOK_CONFIG_FILE_NAME, HOOK_POINTS, hookConfigPath, loadHookConfig,
  parseHookEntry, protectedHookPaths, type HookConfigEntry,
} from '../hook/hooks.ts';
import type { EventLog } from '../log/event-log.js';
import type { AppEvent, BudgetLayer, Projection, WakeSource } from '../log/types.js';
import {
  DEFAULT_PROTOCOL_VERSION, MCP_NAME_PATTERN, MCP_NAME_PREFIX, McpConnection, defaultMcpProcessSpawner,
  parseMcpServers,
} from '../mcp/client.ts';
import type {
  McpConnectionHost, McpProcess, McpServerEntry, McpShutdownReport, McpToolInfo,
} from '../mcp/client.js';
import { aliasNoteOf, collectSessions, normalizeSid, parseAliases, parseMemberAliases, resolveSessionName, sidLookupKeys, type SessionAlias } from '../channel/sessions.ts';
import { readEndpointFromConfig, resolveServiceDir, maskCredential } from '../services/snowluma.ts';
import { loadPersona } from '../persona/loader.ts';
import { readMemoryIndexTextReadOnly } from '../persona/memory-injection.ts';
import {
  DIARY_DIR_NAME,
  EPISODE_ARCHIVE_DIR_NAME,
  EPISODE_DIR_NAME,
  MEMORY_DIR_NAME,
  MEMORY_MAINTAIN_PAYLOAD_KIND,
  diaryDir,
  memoriesDir,
} from '../persona/memory-maintain.ts';
import { ownerPersonOf, relationshipForWake } from '../persona/relationship.ts';
// 待办清单的唯一载体是 STATE 的两节（预览必须与真实请求同源，见 buildReplay 里的任务卡）
import { openTodoItems } from '../persona/todo-state.ts';
import { writePersonaVersion } from '../persona/versions.ts';
import { runDoctor } from '../runtime/doctor.ts';
import type { RenderInput, RenderedRequest } from '../model/render.js';
import { CACHE_HIT_LOW, CACHE_SAMPLE_MIN, clipTaskTitle, inputContentText, render, wakeTitle } from '../model/render.ts';
import {
  CACHE_BREAK_CAUSE_LABEL, CACHE_BREAK_CLASS_LABEL, CACHE_BREAK_LABEL,
} from '../model/context-audit.ts';
import { SKILL_DESCRIPTION_MAX_CHARS, SKILL_FILE_NAME, SkillManager, skillNameProblem } from '../skill/skills.ts';
import { applyOne, budgetTokensOf, finalizePressure, wakeSourceOf } from '../state/fold.ts';
// 全量事件快照：与 `real-loop.ts` 的 `mcpIndexSync()` **共用同一份**（那边每一拍要它）。
// 两份实现会让"每拍 98 MB 的重读"重新长出来，见 event-snapshot.ts 的文件头。
import { readAllEvents } from '../state/event-snapshot.ts';
import { compactTimestamp } from '../tools/fs/text-codec.ts';
import { estimateTokens } from '../tools/registry.ts';
import type { ToolRegistry } from '../tools/registry.js';
import type { TimerStore } from '../wake/timer-store.js';
import type { DepsManager } from '../deps/manager.js';
import { DEP_NAMES, type DepName } from '../deps/probe.ts';
import type { ManagedServiceStatus } from '../services/snowluma.js';
import { AuthStore, UI_TOKEN_FILE } from './auth.ts';
import { WebhookSecretStore, WEBHOOK_SECRET_FILE_NAME } from './webhook-secret.ts';
import { sleepSync, writeFileAtomicSync } from './atomic.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/**
 * 遗留共享 token 的文件名（`<dataDir>/.ui-token`）——**只读、只兼容，不再生成**。
 *
 * 从这里再导出一遍是给老调用方留的路径（测试与脚本过去从 `web/server.ts` 取它）；
 * 真正的读写都在 `web/auth.ts`（口径也写在那儿）。新实例不生成这个文件：
 * 「首次启动要人设密码」这条路上，不该同时挂着第二条能进门的钥匙。
 */
export { UI_TOKEN_FILE };
/** 请求体上限（design §4.15：webhook body ≤64KB；/api 写命令同样约束） */
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024;
/** 事件分页默认批大小（frontend.md §4：200/批） */
export const EVENTS_DEFAULT_LIMIT = 200;
/** 事件分页硬上限：再大就是"把日志拖进浏览器"，那是错的用法 */
export const EVENTS_MAX_LIMIT = 1000;
/** SSE 重连建议间隔（design §4.15 明文 retry: 3000） */
export const SSE_RETRY_MS = 3000;
/** SSE 心跳注释行间隔：防代理/浏览器把空闲连接判死 */
export const SSE_HEARTBEAT_MS = 15_000;
/** SSE 尾部轮询间隔：本地服务，250ms 的延迟人眼不可分辨，CPU 成本可忽略 */
export const SSE_POLL_MS = 250;
/** 单次断线补拉的条数上限：超出就只补最近一段（前端随后重拉投影） */
export const SSE_REPLAY_LIMIT = 1000;
/** 告警文件单次读取上限：告警日志可能有几十 MB，观测面只读头一段（要全文去磁盘看） */
export const ALARM_READ_MAX_CHARS = 200_000;

/**
 * 技能「已忽略」清单的落盘文件（`<dataDir>/skills-ignored.json`）。
 *
 * 为什么不放界面状态（`%APPDATA%/Irmia/ui-state.json`）：同一个界面里的两种待遇是说不通的——
 * 「已确认」写的是事件日志里的 `skill/installed`（换机器、清缓存都还在），
 * 「已忽略」却只活在前端内存里（重启就忘、换台机器又冒出来一堆看过的条目）。
 * 它是**本机的一份界面备忘**，不是 agent 状态，所以进 dataDir 而**不进事件日志**
 * （schema 里没有对应事件类型；往唯一真相源里塞一条近似事件就是脏数据）。
 */
export const SKILLS_IGNORED_FILE = 'skills-ignored.json';

/**
 * 技能回收站目录（`<dataDir>/trash/`，design §8：删除 = 移进来，不是 rm -rf）。
 *
 * 为什么放在 dataDir 而不是技能根里：回收站不是技能——放进 `skills/` 就得跟扫描器解释
 * "这个目录不是技能"（它照旧要读 SKILL.md、照旧会被列进 rejected）。dataDir 是"框架自己的
 * 落盘区"（事件日志、告警、UI token 都在这儿），而"某个技能曾被删掉"是本机的一份存档，
 * 与 `skills-ignored.json` 同一性质：**进 dataDir，不进事件日志**（schema 里没有这种事件类型）。
 */
export const SKILL_TRASH_DIR = 'trash';


/** `mcp-test` 的握手超时上限：测试要拉真进程，但不能让它挂住这条 HTTP 请求 */
export const MCP_TEST_TIMEOUT_MIN_MS = 500;
export const MCP_TEST_TIMEOUT_MAX_MS = 60_000;
export const MCP_TEST_TIMEOUT_DEFAULT_MS = 8_000;

/** `mcp-test` 收尾时给子进程的两级等待（关 stdin → SIGTERM → SIGKILL，与池的关机序列同源） */
const MCP_TEST_SHUTDOWN_STDIN_WAIT_MS = 500;
const MCP_TEST_SHUTDOWN_TERM_WAIT_MS = 1_500;
const MCP_TEST_SHUTDOWN_KILL_GRACE_MS = 300;

/**
 * MCP 声明面被改动时那条唤醒的**幂等时间片**（秒）。
 *
 * 与聊天框/`/dream` 的 5 秒**同源但理由不同**：那两处挡的是"同一条消息被重复提交"，
 * 这里挡的是"同一组改动被重复提交"（界面上连点、客户端重试）——两次提交算**一次**叫醒，
 * 不是每次写盘都吵她一遍（`wake/manual` 的幂等键撞上时 fold 会静默丢弃，不留第二声）。
 * **不同**的改动（改的是别的 server）各有各的键，照旧各叫一次：那是两件事。
 */
const MCP_WAKE_DEDUPE_SLICE_SECONDS = 5;

/** 新技能骨架里「待填写」的正文提示（与 SKILL.md 的渐进披露口径一致：正文永不进上下文） */
const SKILL_TEMPLATE_BODY_HINT = [
  '<!-- 写清：什么时候该用它、按什么顺序做、做到什么算完成。',
  '     这段正文**不会**常驻她的上下文——她判断相关时才会 safe_read 读它，',
  '     所以宁可写细，也别写成一句口号。 -->',
].join('\n');

/** 记忆文件单次读取上限：与告警同一尺度（界面只负责让人看一眼，全文在盘上） */
export const MEMORY_READ_MAX_CHARS = 200_000;

/**
 * 框架提示（运行情况页 ·「框架提示」卡片，v33）的取数口径。
 *
 * 四个数都是**给人看的上限**，不是存储上限：卡片只摆最近几条、每条只带几个短片段。
 * 为什么不给翻页：这两类事本来就稀少（一次注入预警是一次事故，一条告警是一件事），
 * 攒到二十条以上时该看的是告警目录与事件日志本身，不是这张摘要卡。
 */
export const FRAMEWORK_NOTES_LIMIT = 20;
/** `?limit=` 的硬上限：这条端点只服务摘要卡，放开到任意大等于把事件流从这里漏出去 */
export const FRAMEWORK_NOTES_MAX_LIMIT = 100;
/**
 * 上下文归因在卡片里单独占的格数。
 *
 * **2026-10-04 起为 0：归因整个不进这张卡**（用户第二次报"还在刷屏"之后定的口径）。
 * 走过的两步记在这里，免得下次有人又想把它加回来：
 *   ① 最初是"每步一条"（约 500 条/天）——两分钟就把卡刷满，注入预警与真告警全被挤下去；
 *   ② 改成"一轮只留最后一步"——仍然嫌吵：每条占两行（标题 + 整条等式），
 *      而它说的根本不是"提示"。**归因是事实，事实去日志页看**（`budget/consumed.context` 一直在）。
 * 这个常量保留为 0 是为了"想加回来的人先读到这段"。
 */
export const CONTEXT_NOTES_LIMIT = 0;
/** 单条提示里每个引用片段的字数上限：外部原文可能几千字，整段丢出去会把响应撑大，界面也摆不下 */
export const FRAMEWORK_NOTE_QUOTE_MAX_CHARS = 200;
/** 单条提示最多带几个引用片段：判定给的是"最可疑的几处"，再多就是噪音 */
export const FRAMEWORK_NOTE_QUOTES_MAX = 3;
/** 无 from_seq 时"取最新一批"的扫描余量：seq 有空洞且过滤会稀疏，留 20 倍余量 */
const LATEST_SCAN_FACTOR = 20;
/** dashboard 保留的尾部事件窗口：24h 序列与建议规则只需要尾部视图 */
export const DASHBOARD_EVENT_WINDOW = 10_000;

/**
 * 协议端状态的中文说法（v34）。
 *
 * **为什么由服务端给、不让界面自己译**：与 `/api/stats/dashboard` 的 `stateText` 同一条纪律——
 * 界面上看到的与启动日志里说的是同一套词，翻译只做一遍。两处各译一份必然漂移，
 * 而"状态对不上号"是最难查的一类故障。识别不了的状态原样回显（不猜、也不吞）。
 */
export const PROTOCOL_STATE_TEXT: Record<string, string> = {
  'not-installed': '未安装',
  stopped: '已停止',
  starting: '启动中',
  ready: '已就绪',
  failed: '启动失败',
};
/** webhook 令牌桶默认参数：容量 30、每秒回填 1 个 */
export const DEFAULT_WEBHOOK_RATE = { capacity: 30, refillPerSec: 1 } as const;
/** 令牌桶表上限（FIFO 淘汰）：防伪造源 IP 把内存撑爆 */
const MAX_WEBHOOK_BUCKETS = 1024;
/**
 * "webhook 被拒"写进诊断输出的最小间隔（60 秒一条）。
 *
 * 这条通道的门是未认证的（本机任何程序都能敲），每次失败都写一行就等于给了本地进程一个
 * 刷日志的把手。限流的是**日志**，不是请求——未认证的请求本来就一律 401，不受这个数影响。
 */
const WEBHOOK_REJECT_LOG_MS = 60_000;
/** 记录进 `wake/webhook` 时被抹掉的敏感头（密钥不落日志） */
const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key']);
/** 人格常驻层文件名（persona.md §2） */
export const PERSONA_TOP_FILES = ['IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md', 'STATE.md'] as const;
/** 仅人类可改的文件（前端画 🔒；agent 侧由 CONSTITUTION 引导，不在此处拦截） */
export const RESERVED_PERSONA_FILES = new Set(['IDENTITY.md', 'CONSTITUTION.md']);
/** 提案目录名：`<personaRoot>/proposals/<与目标同名的相对路径>` */
export const PERSONA_PROPOSAL_DIR = 'proposals';
/** 与 persona/loader.ts 的 SEED_MARKER 同字面量（种子模板未填写的判据） */
const SEED_MARKER = '<!-- SEED';
/**
 * 建议规则的阈值（frontend.md §3.1）。
 *
 * `CACHE_HIT_LOW` / `CACHE_SAMPLE_MIN` 从 `model/render.ts` 取——那边此刻层的 `用度：`
 * 告警用的是同一个判据（v24）。同一个指标在两个面上给两个阈值，人（和她）就得自己对齐。
 */
const REVIEW_STALE_MS = 3 * 24 * 3600 * 1000;
const ARCHIVE_STALE_MS = 7 * 24 * 3600 * 1000;
const PERSONA_STALE_MS = 30 * 24 * 3600 * 1000;
/**
 * 丢弃死信时那句理由的长度上限（`POST /api/commands/discard` 的 `reason`）。
 * 它进事件、进日志行、进界面——理由要能说清"为什么不再重投"，但不必变成一篇文档；
 * 超限一律 400 报错而不是静默截断（截断过的理由读起来像原话，那是在伪造留痕）。
 */
const DISCARD_REASON_MAX = 500;

/**
 * 危险操作的 `X-Confirm` 短语表（frontend.md §4：短语 = 操作的英文标识，防误触而不防人）。
 * `null` = 该命令不需要确认。**只有改变能力边界的操作才算危险**：手动唤醒、结案、重入队、
 * 取消定时器、批准/拒绝提案都只推进状态，不改变"它能碰什么"——给它们加门只会让人烦。
 * 真正的危险在字段层（见 `DANGEROUS_FIELDS`：把 destructive 总开关打开）。
 *
 * 头的值是**短语列表**（以 ';' 分隔），只要包含所需短语即放行：
 * 这样客户端多声明几个也不影响（`update-config; enable-destructive` 照样工作）。
 */
export const CONFIRM_PHRASES: Record<string, string | null> = {
  wake: null,
  'review-resolve': null,
  answer: null,
  // 申请单的批准/驳回（扩展页「待批」段与顶层批准卡，2026-10-11）：**短语 null**，
  // 与 persona-approve / persona-reject 同级。判据：这条路本身就是"人在看一张卡、点一下"，
  // 「点一下」就是决定——再加一道短语只是让人多点一次。防误触由**卡面说清后果**承担
  // （"批准之后它会写进 mcp.servers[]、重启后生效"那几句就在卡上）。
  'grant-decide': null,
  requeue: null,
  // 丢弃死信（运行情况页 · 死信队列）：**只标记为已处理，不删任何记录**——日志只增不改。
  // 与 requeue 同级（短语 null）：它不动能力边界，只决定"这条不再重投"。
  discard: null,
  'persona-approve': null,
  'persona-reject': null,
  // 本人在 GUI 里直接编辑人格资产（写 persona/ 下的 .md）。与 persona-approve 同级：
  // 写前的旧内容会先落版本快照（可回滚），并写 persona/updated 事件——不绕审计。
  'persona-edit': null,
  'config-update': null,
  'set-contact': null,
  // 群成员改名（消息适配器页）：只写档案里的一行字，不改任何能力边界
  'set-group-member': null,
  // 预警豁免开关（消息适配器页）：只改「哪条消息要过判定」这一项，不动能力边界
  'set-warn-exempt': null,
  // 群聊场景开关（消息适配器页）：软提醒 / 硬拒绝。它改的是「本机类工具在群聊里给不给」，
  // 属于收紧而不是放宽能力边界，与 warn-exempt 同级
  'set-group-scene': null,
  // 重启（运行情况页那颗按钮）：会打断她正在做的事，按危险操作处理——短语 = 命令名，防误触不防人
  restart: 'restart',
  // 「她被怎么称呼」（设置页/消息适配器页）：写 channels.mentionKeywords。它改的是
  // "群里喊她名字算不算在叫她"——不改变能力边界（唤醒仍是同一条路），所以短语 null。
  'set-mention-keywords': null,
  // 工具开关（扩展页 · 工具）：关掉一件工具不改变能力边界，只是把它的名字从清单里拿掉，
  // 所以与 config-update 同级（短语 null）；它写的是 config.tools.disabled。
  'tool-toggle': null,
  // 清空对话历史（聊天窗口的 /reset）：写一条遮蔽摘要，日志不动、只推遮蔽点
  'reset-context': null,
  // 主动做一次梦（聊天窗口的 /dream）：排一条立刻到期的唤醒，让记忆整理走它本来那条路
  // （唤醒队列 → 与普通 turn 同形的骨架）。它不改变任何能力边界，只是把每天本就会发生的
  // 维护提前一次，所以与 reset-context 同级：短语 null。
  dream: null,
  'timer-cancel': null,
  'webhook-test': null,
  // 技能信任门：把某个技能目录标成「由 human 确认」（写 skill/installed）。它只放宽"谁能进
  // catalog"，不放宽"能碰什么"，所以与 persona-approve 同级：短语 null。
  'skill-confirm': null,
  // 本地密钥写入（设置页 · 模型分区）：它不改变 agent 的能力边界，但**写的是密钥**，
  // 且覆盖「下一次启动时用它建连」的那份值——按危险操作处理，短语 = 命令名，防误触不防人。
  'set-key': 'set-key',
  // 技能「已忽略」备忘（扩展页 · 技能）：写 `<dataDir>/skills-ignored.json`，只影响本机界面把
  // 哪条待确认收进「已忽略」——不写事件、不进 catalog、不改变能力边界，与 skill-confirm 同级。
  'skill-ignore': null,
  // 新建技能骨架（扩展页 · 技能 · 新建）：写 `skills/<name>/SKILL.md`。它**不构成信任**——
  // 新目录照旧停在待确认，要过信任门才进 catalog，所以与 skill-confirm 同级（短语 null）。
  'skill-create': null,
  // 删除技能（扩展页 · 技能 · 已生效行的「删除」）：把 `<技能根>/<name>/` **整个移进**
  // `<dataDir>/trash/`（design §8 用户选的可恢复那条，不是 rm -rf）。它是这一族里**唯一动磁盘
  // 真实资产**的动作——技能是用户自己写的东西，她也会写，所以照危险操作处理：短语 = 命令名。
  // 门只防误触（界面按钮点错、脚本里循环调用），不防人；误删的代价由回收站与日志留痕兜住。
  'skill-remove': 'skill-remove',
  // MCP 测试连接（扩展页 · MCP）：会**真起一个子进程**执行配置里的 command。它不写任何状态
  // （成功失败都只回当前这次的结果），但"让本机跑一段配置里的命令"本身值得一次点头，
  // 且 GUI 允许内联一份还没保存的配置来试——那等于"让人在这里跑任意命令"，必须防误触。
  'mcp-test': 'mcp-test',
  // 写 `config.mcp.servers[]`（扩展页 · MCP 的添加/编辑/删除）。MCP 工具默认 `destructive`
  // 且默认 `exclusive`（client.ts 纪律 1：不信任即默认关），加一个 server = 扩大能力边界，
  // 所以与 set-key 同级按危险操作处理，短语 = 命令名。
  'mcp-save': 'mcp-save',
  'mcp-remove': 'mcp-remove',
  // 写 `data/hooks.json`（扩展页 · Hooks 的添加/编辑/开关/删除）。**这份文件定义的是"谁能改我"**：
  // 一条 PreToolUse 钩子能拒绝任何工具调用、能改写参数，PostToolUse 能往上下文里注入文本。
  // 所以它必须像 set-key 一样登记确认短语（防误触不防人）；而 agent 侧的写入口**继续拒绝**——
  // 那条纪律的落点是 protectedHookPaths()（见该函数的注释与扩展页底部的引导条）。
  'hook-save': 'hook-save',
  'hook-remove': 'hook-remove',
  // 外部依赖安装（设置页 · 外部依赖，v30）：**下载并落地一个可执行文件**，agent 之后会调用它。
  // 这比 set-key 更接近能力边界——它落地的是一段会被执行的外部代码，所以照危险操作处理：
  // 短语 = 命令名。来源是固定的官方地址（见 src/deps/manager.ts 的 packageFor），
  // 门挡的是误触（界面按钮点错、脚本里循环调用），不是对抗性攻击。
  'dep-install': 'dep-install',
  // webhook 专用凭据的生成/轮换（B9）：**写一份密钥，且当场作废旧的那份**。按危险操作处理，
  // 与 set-key 同级：门挡的是误触（按钮点错、脚本里循环调用）——轮换一次，所有
  // 还没换凭据的外部投递方**立刻开始收 401**，那是个需要点头的动作，不是一次顺手点击。
  'regenerate-webhook-token': 'regenerate-webhook-token',
};

/**
 * 字段级危险标识：改这些字段等于改"它能碰什么"，因此 `config-update` 必须带上字段短语。
 * 防的是误触：把 destructive 开关顺手打开，那之后她能删你任意路径下的东西。
 *
 * `trust.mode` 按同一条判据够格（2026-10-05 补），**而且两个方向都要短语**：
 *   • 写 `"full"` = 把边界从"只有那个工作目录"放开到**整台电脑**（`config.ts` 的 TrustConfig：
 *     `workspace` 档下越界的读写与命令是**被拒绝**的，不是提醒）——这就是"改它能碰什么"，
 *     而且是往宽的那一边改，最该防误触；
 *   • 写 `"workspace"` = 收紧。**这里刻意不做方向区分**：只给"放宽"加门就得让服务端先读盘上
 *     现值、再判方向，那会变成同一件事的**第二处判据**（现值从哪读、读的是盘上还是生效那份、
 *     并发写怎么算——每一条都能吵），而"改这个字段一律要短语"是一句话能核对完的规则。
 *     代价是收紧那一下也要带短语，方向明确、代价可接受（防误触不防人）。
 */
export const DANGEROUS_FIELDS: Record<string, string> = {
  'tools.destructiveEnabled': 'enable-destructive',
  // 短语名取"最该防的那一件事"（改成完全信任），不取 `trust-mode` 这种中性名：
  // 客户端把它写进 X-Confirm 时，人一眼看得出自己点的这个按钮要放开什么。
  'trust.mode': 'trust-full-access',
};

/**
 * 前后端契约里出现过、但**当前无法诚实实现**的命令：一律 501 + 原因。
 * 不造假事件的理由是硬的：事件日志是唯一真相源，没有对应事件类型的"状态变更"写下去就是脏数据。
 */
export const UNIMPLEMENTED_COMMANDS: Record<string, string> = {
  export: '日志导出属于运维模块（M6）的动作，尚未接到本服务',
  backup: '备份快照属于运维模块（M6）的动作，尚未接到本服务',
  'archive-now': '归档属于运维模块（M6）的动作，尚未接到本服务',
  ping: '端点连通性探测需要模型接入层（DsClient）注入，本服务不持有密钥',
};

/** 静态资源 MIME 表已随 `web/` 一起删除：这个服务不再吐任何文件，只吐 JSON。 */

// ──────────────────────────────── 对外类型 ────────────────────────────────

/**
 * 自由文本里**不许出现**的东西：口令。
 *
 * 服务层已经把口令单独放进 `webuiLogin.credential`，但这条纪律值得再钉一次：那些句子
 * （`detail` / `summary` / `note` / `stateText`）会进日志、进事件摘要、进诊断输出，
 * 任何一次拼接都可能把口令顺进去。所以出响应前扫一遍已知口令。
 *
 * **只扫自由文本，不扫结构化字段**：`credential.password` 那一个格子是**故意**带明文的
 * （本机界面要「复制凭据」，抄的是原文）。第一版把整份视图都扫了，结果连那个格子也变成
 * `***`——复制按钮于是把三个星号交给人（探针当场抓到的）。原则没写错（"不许泄口令"），
 * 是扫的范围错了：**要保护的是"口令不该出现在解释性文字里"，不是"口令不该出现在它自己的格子里"**。
 * 判据写成"这个键是不是解释性文本"而不是"值像不像口令"——后者会随口令形态漂移。
 */
const CREDENTIAL_TEXT_KEYS = new Set(['detail', 'summary', 'note', 'stateText']);

function scrubSecrets<T>(value: T, secrets: readonly string[]): T {
  const live = secrets.filter((secret) => secret.length >= 6);
  if (live.length === 0) return value;
  const walk = (input: unknown, key: string | null): unknown => {
    if (typeof input === 'string') {
      if (key === null || !CREDENTIAL_TEXT_KEYS.has(key)) return input;
      let out = input;
      for (const secret of live) out = out.split(secret).join('***');
      return out;
    }
    if (Array.isArray(input)) return input.map((item) => walk(item, key));
    if (typeof input === 'object' && input !== null) {
      const out: Record<string, unknown> = {};
      for (const [childKey, item] of Object.entries(input as Record<string, unknown>)) {
        out[childKey] = walk(item, childKey);
      }
      return out;
    }
    return input;
  };
  return walk(value, null) as T;
}

/**
 * 内置协议端的接缝（v34）：web 层只认这个形状，实例由 main.ts 建——**运行时只有一个**。
 *
 * 为什么声明成接口而不是直接用 `ManagedProtocolService` 的类型：这几条是 web 层真正用到的
 * 全部能力（读状态 / 启 / 停 / 问入口在哪），而"能拉起一个外部进程"这件事本身不该顺着
 * 类型漂进 HTTP 层。注入点也照 `WebServerDeps.registry` 那种姿势：可选、缺省 = 如实说
 * "本进程没有装配它"，不抛错。
 *
 * `status()` 的形状直接复用服务层的 `ManagedServiceStatus`（含 `endpoint.accessToken`
 * 与 `report.webui.credential.password`）——**这两样都不会进响应体**：
 * token 只报"有没有"，口令只在本机界面那一条路上给（且带来源标注）。
 *
 * **v36 起 `status()` 是异步的**：三档里那一档"进程在不在、在听哪个端口"要真去探
 * （先探端口、再查进程表），而这些事本来就是异步的。同步签名会逼出一个假的"立刻知道"。
 */
export interface ProtocolSideHost {
  status(): Promise<ManagedServiceStatus>;
  start(): Promise<ManagedServiceStatus>;
  stop(): Promise<void>;
  /** 可执行入口的绝对路径；没有 = 还没装（框架不下载它，见 services/snowluma.ts 的许可说明） */
  entryPath(): string | null;
}

/**
 * OneBot 适配器的链路状态（第三档）。
 *
 * 这一档**只有适配器自己知道**（它握着那条 ws），所以从 main.ts 注入一个只读快照函数进来：
 * 协议端那一侧（进程 / 配置）由 `ProtocolSideHost` 回答，适配器这一侧由这里回答，
 * 两句话合成"到底断在哪一环"。
 */
export interface OneBotLinkView {
  /** 通道装没装：没装 = 配置里没开它，这一档不适用（不是故障） */
  enabled: boolean;
  /** 适配器当前连没连上 */
  connected: boolean;
  /** 有没有一个"可以连的地址"（来自协议端配置或手填配置）；false = 没端点可连 */
  hasEndpoint: boolean;
  /** 日志里用的那个地址；有 token 时**已经打过码**（掩码规则在 channel/onebot.ts） */
  target?: string;
  /** 机器人 QQ 号（连上并问到过才有） */
  selfId?: string;
  /** 已重连次数（退避计数；链路活了会清零） */
  reconnectAttempts: number;
  /** 最近一条消息事件的时刻（毫秒）；null = 还没收到过 */
  lastEventAt: number | null;
  /** 已投递的消息条数 */
  delivered: number;
}

/**
 * 「盘上那份 `channels.onebot`」的读法结论（`readSavedOnebot` 的返回值）。
 *
 * `dir` 在这一层就**归一化成绝对路径**（相对路径按 `config.dataDir` 解）：下游三处
 * （状态视图、与内存配置的比较、去它的目录里读 onebot.json）都要用同一个基准，
 * 各解各的迟早会出现"比较用的是相对、读配置用的是绝对"这种查不出来的错。
 */
interface OnebotSavedView {
  enabled: boolean;
  /** 盘上写了 `managed` 才有；没写 = 用外部协议端（不是错误，是默认） */
  managed: { kind: string; dir: string; autoStart: boolean } | null;
  /** 这份结论是不是真从盘上读来的；false = 回落到内存配置（读不到 / 形状不对） */
  fromDisk: boolean;
}

export interface WebServerDeps {
  log: EventLog;
  /** 运行期的投影**引用**（real-loop 原地更新它）；本模块只读不写 */
  projection: Projection;
  config: AppConfig;
  /** 人格根目录，约定为 `<dataDir>/persona`（replay 的当前 personaHash 依赖该约定） */
  personaRoot: string;
  dataDir: string;
  timers: TimerStore;
  now: () => Date;
  /** 工具注册表：`/api/replay` 重建请求体时要工具清单 */
  registry?: ToolRegistry | undefined;
  /**
   * 技能根基准目录（`skills/`、`.agents/skills/` 的父目录）；缺省 `process.cwd()`——
   * 与 CLI 的 `new SkillManager({ baseRoot })` 同一基准，保证"界面看到的"就是"CLI 看到的"。
   */
  skillsRoot?: string | undefined;
  /** 告警出口（保留位：写命令失败时可告警；当前版本不强依赖） */
  notifier?: AlertNotifier | undefined;
  /**
   * 认证库覆盖点（测试用）；缺省自建一个 —— 读 `<dataDir>/.auth.json`，
   * 并兼容 `<dataDir>/.ui-token`（老实例迁移期，完整口径见 `web/auth.ts` 的文件头）。
   *
   * 为什么值得留这个注入口：测试里"现设一次密码"要跑一遍 scrypt（~100ms），
   * 几十条用例叠起来就是十几秒，而它们要验的根本不是密码学（那些由 `test/web-auth.test.ts`
   * 单独立案）。注入一个已知会话，读端点那批用例就能照旧跑。
   */
  auth?: AuthStore | undefined;
  /**
   * 遗留共享 token 覆盖点（测试用）。只在这一层转交给自建的 AuthStore；
   * 给了 `auth` 时它不起作用（认证判据只有一份，在 AuthStore 里）。
   * 显式给 `null` = "这个实例没有旧 token"，不受磁盘上碰巧存在的文件影响。
   */
  uiToken?: string | null | undefined;
  /**
   * webhook 专用凭据库覆盖点（测试用）；缺省自建一个 —— 读
   * `<dataDir>/.webhook-secret.json`（完整口径见 `web/webhook-secret.ts` 的文件头）。
   *
   * 与 `auth` 留同一个注入口的理由一样：测试要的是"这条通道认不认这份凭据"，
   * 而不是再跑一遍随机数生成；注入一份已知凭据，用例就能直接发请求。
   */
  webhookSecret?: WebhookSecretStore | undefined;
  /** 绑定地址（design §4.15：默认只绑回环） */
  host?: string | undefined;
  /** 端口；0 = 由系统挑一个（测试友好） */
  port?: number | undefined;
  /** 诊断输出；缺省 console.log */
  out?: ((line: string) => void) | undefined;
  /** 配置文件路径；缺省 `<cwd>/config.json`（与 main.ts 的 loadConfig 同基准） */
  configPath?: string | undefined;
  /** 人格被批准修改后的回调（宿主据此热更内存里的 PersonaAssets） */
  onPersonaUpdated?: (() => void) | undefined;
  /**
   * 「她被怎么称呼」被改写后的回调（宿主据此热更运行期那份关键词）。
   *
   * 不接这个回调也能改（写盘、下次启动生效），但界面上要如实说"需重启"——
   * 那几个词是要当场试的（填宽了误唤醒、填窄了漏），不能让人改完还得重启一次才知道对不对。
   */
  onMentionKeywords?: ((keywords: readonly string[]) => void) | undefined;
  /** SSE 尾部轮询间隔覆盖点 */
  ssePollMs?: number | undefined;
  /** webhook 令牌桶参数覆盖点 */
  webhookRate?: { capacity: number; refillPerSec: number } | undefined;
  /**
   * 外部依赖管理器（`src/deps/`，v30）。给了它才有 `GET /api/deps` 与 `dep-install`：
   * 两者读的是**同一份缓存结论**，与 rg_search / es_search / pwsh 用的是同一个对象——
   * 所以"点完安装 → 复检 → 刷新缓存"之后，下一次工具调用立刻看到新引擎，不必重启进程。
   *
   * 不注入时这两条路由如实报 501（而不是返回一份"看起来正常"的空报告：
   * 界面上分不清"没有依赖"与"没接上依赖"是最没用的那种观测）。
   */
  deps?: DepsManager | undefined;
  /**
   * 内置协议端（`channels.onebot.managed`，v34）。给了它才有 `GET/POST/PUT /api/protocol-side`：
   * 界面据此启停它、看它的状态、改它的目录。
   *
   * **不注入时那三条路由照常工作**（不是 501）：它们报的是"没配置/没装配"，而这两种
   * 恰恰是最需要显示的常态——设置页要能在什么都没配的时候把人引导到"去下载、填目录"。
   * 与 `deps` 缺省时报 501 的差别在于：那条端点整份数据都来自管理器，而这里
   * 配置与安装事实的一半在盘上，读盘不需要任何实例。
   */
  protocolSide?: ProtocolSideHost | undefined;
  /**
   * OneBot 适配器的链路快照（v36 的第三档）。缺省 = 本进程没装配 OneBot 通道——
   * 那和"通道开着但连不上"是两句不同的话，视图里分开报（`enabled: false` vs `reconnecting`）。
   */
  onebotLink?: (() => OneBotLinkView) | undefined;
  /**
   * 「界面这条 `wake/manual` 就是人开口」的通报口（2026-10-03）。
   *
   * 为什么需要它：`WakeSink.wake()` 才是"外部事件到达"的正门，而本模块的三处 `wake/manual`
   * （聊天框、/dream、webhook 转发）是**直接 appendSync 落库**的——不经过那条路。
   * 缺了这一下，`RealLoop.interruptEpoch` 对界面来的消息一动不动，于是她**正在说的那半截话
   * 会一直说完**：用户 17:38 插了一句「和我的私聊是私有的，没关系」，speak 的 9 条气泡照旧
   * 冒完、工具卡一直显示「运行中」，直到 65 秒后那一步自己结束。
   *
   * 调用时机写在实现里（`afterAppend`）：**与落库同一个同步块**，中间不许有 await——
   * speak 每 100ms 回头看一眼计数，晚一拍就可能多漏一条气泡出去。
   * 不注入时照旧工作（只是没人被通报），CLI 与测试里那种装配不受影响。
   *
   * **MCP 那两条唤醒刻意不走这里**（2026-10-09）：那不是"人开口"，它是框架替他做的动作
   * ——通报"有人开口了"会让打断回执把框架那句通报写成"他刚说「…」"摆给她（/dream 那处
   * 踩过同一个坑，见下面 `'dream'` 分支的注释）。它要的是"真的起一个 turn"，而那条路
   * 不需要本口子：`appendSync` 已经把它折进 `projection.pending`，主循环下一拍自己会认领。
   */
  noteUserSpoke?: ((seq: number, type: string, data: unknown) => void) | undefined;
  /**
   * `self-restart` 走到"旧实例该让位了"时的那一下（缺省见 `WebServer.requestGracefulRestartExit`）。
   *
   * 为什么不默认交给宿主：宿主（`main.ts`）本来就有那条优雅退出路径，只是它的入口是信号
   * （`SIGTERM`/`SIGINT`）而不是"某个 HTTP 命令"。这里**不新增一条退出路径**——
   * 缺省就是触发既有那条信号路径（见实现里的注释），注入点只是为了让测试能断言"退的是哪条路"。
   */
  onRestartExit?: ((path: RestartPath) => void) | undefined;
  /**
   * **配置热更接线是活的吗**（2026-10-11 加）：宿主把 `ConfigWatcher.live` 递进来。
   *
   * 谁用它：`mcp-save` / `mcp-remove` 回执里那一格 `restartRequired`——它的**唯一含义**
   * 就是"这次改动需不需要重启才生效"。而 `mcp.servers` 自从热更落地之后**不需要**重启，
   * 于是这一格不能再写死 `true`（那是假话，界面会照着它让人去重启）。
   *
   * 为什么由宿主给、不由本模块自己判：本模块**没有** `ConfigWatcher`（它在 `main.ts` 里），
   * 自己猜就是第二份判据。缺省 = 没接线 ⇒ 回 `restartRequired: true`（保守那一侧：
   * 说"要重启"顶多多一次重启，说"已生效"而其实没生效是撒谎）。
   * 判据只有一处，见 `ConfigWatcher.live` 的注释（含两个方向各错在哪）。
   */
  configReload?: (() => boolean) | undefined;
}

export interface WebServer {
  readonly server: Server;
  /**
   * 认证库。宿主（main.ts 与界面）靠它问三件事：设过密码没有、旧 token 还在不在、
   * 以及把自己的会话撤销掉。**它不对外吐密码或会话凭据的原文**（那些只在签发响应的
   * 那一次出现），所以把它整份交出去是安全的。
   */
  readonly auth: AuthStore;
  /**
   * webhook 专用凭据库。宿主（main.ts 与界面）靠它问两件事：生成过没有（没有的话
   * `/webhook/*` 一律 401，界面该显示"生成"而不是"重新生成"），以及当前那份的标识与时刻。
   * **它不对外吐凭据原文**（那只在生成响应的那一次出现），所以把它整份交出去是安全的。
   */
  readonly webhookSecret: WebhookSecretStore;
  /** 实际监听端口（listen 前为 0） */
  port(): number;
  /** http://host:port */
  url(): string;
  listen(): Promise<void>;
  close(): Promise<void>;
  /**
   * **让位**（`self-restart` 那一条的收尾，路径链第 ③ 条）。
   *
   * 为什么它得是"优雅退出"而不是 `process.exit()`：新实例等的是**本进程真的消失**
   * （单实例锁与监听端口都只允许一个用户），而 `process.exit()` 会把锁留在盘上、
   * 跳过 `session/end` 与收尾——那正是"重启之后日志断成两截、下次启动还得靠接管陈旧锁"的形状。
   * 所以这里走的是进程**既有的**退出路径（`main.ts` 的 `stop()`：停源 → 关 web → `session/end`
   * → 落缓存 → 停定时器 → 关日志 → **放锁**），一处都不另写。
   *
   * 暴露成接口上的一条，是为了让宿主（以及测试）能**注入**那一下：
   * 生产环境里宿主不接它（缺省走 `SIGTERM` 那条既有信号路径），测试里接一个假的就能
   * 断言"回执发出之后才退、而且退的是既有路径"，而不必真的把测试进程结束掉。
   */
  requestGracefulRestartExit(path: RestartPath): void;
}

/** 统一错误体（design §4.15：`{ "error": { "code", "message" } }`） */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface Suggestion {
  id: string;
  level: 'info' | 'warn';
  /** 主行（一句话） */
  title: string;
  /** 次行（细节与下一步） */
  body: string;
  /** 与 title 同值：服务端日志与第三方消费者不必再学一套字段名 */
  text: string;
  /** 建议卡按钮：前端动作表的 id（goto-review / open-budget / goto-tools / goto-persona） */
  act?: string;
  actLabel?: string;
}

/** 逐小时序列点（总览趋势线与预算弹层共用同一口径） */
export interface HourlyPoint {
  hour: string;
  tokens: number;
  input: number;
  output: number;
  hit: number;
  miss: number;
}

/** 六态状态机（frontend.md §3.1 的顺序即优先级） */
export type DashboardState = 'needs-review' | 'paused' | 'degraded' | 'running' | 'sleeping' | 'idle';

export interface DashboardView {
  generatedAt: string;
  state: DashboardState;
  stateText: string;
  detail: string;
  /**
   * **当刻状态的一句话旁注**（可以为空）——目前只有一种："预算暂停已解除（X 层）"。
   *
   * 为什么它不能并进 `stateText`：状态词说的是**当刻在干什么**（执行中/待机/降级…），
   * 而这句话说的是**已经过去的那件事的下文**。混在一起就会出现用户 2026-10-05 看到的
   * 那种自相矛盾的句子：「已暂停（预算耗尽）」+「Agent 正在值守」同时挂在一个进程上。
   *
   * 判据与 `state` 同源（{@link livePausedLayers}），界面**照抄不推断**。
   */
  stateNote: string;
  guardedDays: number | null;
  nextWakeAt: string | null;
  tiles: {
    watermark: number;
    pending: number;
    tokensToday: number;
    cacheHitRate: number | null;
    needsReview: number;
    /** 计划模式待批准的 destructive 调用（design §4.21 事前人审；与前一项分开计数） */
    planPending: number;
    failStreak: number;
  };
  budget: { tokensToday: number; heavy: number; light: number; cacheHit: number; cacheMiss: number };
  lastWake: { source: WakeSource; at: string } | null;
  openTurn: { turn: number; step: number } | null;
  lastAssistantText: string | null;
  idleTicks: number;
  degraded: { lane: string; since: string; reason: string } | null;
  waitingHuman: { question: string; turn: number; at: string } | null;
  /**
   * **她在问**的那些卡（design §6：agent 来源的人审卡）。
   *
   * `cards` 是**按提问先后排好的队列**（队首在前，最多 [ASK_CARD_MAX] 张）。界面一次只弹一张
   * ——队首那张（§6.3：弹窗叠弹窗只会让人乱点），答掉/收起之后轮到下一张。
   *
   * 为什么给一串而不是只给队首：界面上的「稍后」是**本地**动作（不写日志、不产生决定，§6.1），
   * 服务端不知道哪几张已经被人收起来了。只下发队首的话，人一按「稍后」，队首那张还挂在服务端，
   * 界面就永远轮不到第二张——那不叫排队，叫把后面几张吞了。
   *
   * 这一队**只装她问的**（source: 'agent'）：系统来源那条（计划待批准）有它自己的出口
   * （Web 卡片与 `irmia answer`），把它排进来会让一张本页画不出来的卡永远堵住她的卡。
   *
   * 卡上的**每个字**都在这里定死：`question`/`context` 是她的原话，标题与按钮文案由界面写死
   * （§6 防伪：不许她自定义按钮去冒充系统）。所以这个对象里**没有**任何 label/title 字段。
   */
  ask: {
    cards: Array<{
      seq: number; question: string; context: string; turn: number; at: string; expiredAt: string | null;
    }>;
    /** 台面上还没答复的总条数（含 `cards` 之外没下发的那几件；角标与"还有 N 条"读它） */
    queued: number;
  };
  /**
   * **她的申请单**（2026-10-11：skill / MCP 的增删由她发起、用户只在界面点批准或驳回）。
   *
   * 为什么与 `ask` **分成两个字段**（而不是把待批也塞进那一队）：`ask` 的语义是
   * "**她在问**"（`source: 'agent'`），而待批的语义是"**他在等她点头**"（`source: 'system'`）
   * ——`AskCardHost` 一次只弹一张卡的纪律（§6.3）会把两件事搅在一起：一张本页画不出来的
   * 系统卡堵住她真正在问的那些问题，正是 `askCardOf` 的注释里写着要避免的那种事。
   * ⇒ 界面那一侧按 `open` 自己弹一张**形态不同**的卡（带批准/驳回与理由输入框）。
   *
   * `items` 里已经答复过的那些也一并给（界面按 `outcome` 分两段摆），
   * 因为"她申请过什么、谁批的、批完落地没有"是人回来复查时唯一看得到的地方。
   */
  grants: {
    items: Array<{
      id: string; kind: string; name: string; desc: string;
      command: string; args: readonly string[]; envKeys: readonly string[];
      /** 技能那一支：`scripts/` 下那些可执行内容的名字（MCP 那一支恒为空） */
      scriptNames: readonly string[];
      /** 技能那一支：随包带几个文件 */
      fileCount: number;
      reason: string; question: string; context: string;
      askSeq: number | null; expiredAt: string | null; requestedAt: string | null;
      outcome: 'approved' | 'rejected' | null; outcomeAt: string | null;
      rejectReason: string | null;
      exec: { state: string; failure?: string; landed?: string } | null;
      picked: boolean;
    }>;
    /** 还没答复的（等着人点头）—— 顶层卡的队列读它 */
    open: number;
  };
  deadLetters: number;
  suggestions: Suggestion[];
  /** 最近 24 小时逐小时 token/命中（总览趋势线与预算弹层的数据源） */
  hourly: HourlyPoint[];
  /** 未决人格提案数（人格页徽章） */
  personaProposals: number;
  /** 空态：只有 session/start（总览页换成引导卡） */
  empty: boolean;
  recent: Array<{ seq: number; ts: string; type: string; visibility: string; summary: string }>;
}

export interface EventsPage {
  events: AppEvent[];
  fromSeq: number;
  nextFromSeq: number;
  /** 更早一批的起点（前端"加载更早"的游标）；null = 已经到日志头部 */
  nextBeforeSeq: number | null;
  lastSeq: number;
  hasMore: boolean;
}

/**
 * 预算口径的那一句话（`BudgetView.metricNote`）：服务端一处给出，界面照抄。
 *
 * 口径 = **非缓存**的 token 数 = `(inputTokens − cacheHitTokens) + outputTokens`：
 * 只算输入里没命中缓存的那部分 **+ 输出**，也就是"**真花钱的那部分**"
 * （唯一一处定义在 `state/fold.ts` 的 `budgetTokensOf`）。2026-10-05 用户换的口径，原话逐字：
 *
 *   > 「另外单日预算改成只算不命中缓存的部分吧。单日非缓存预算 2M，妥善改完，不要不协调。」
 *
 * 换之前是"未扣缓存"（cacheHit + cacheMiss 一起算）：心跳每 5~15 分钟一拍、约 97% 的输入
 * 是缓存命中，旧口径把命中那一大截也算进去 ⇒ 计数器飞快见顶、"预算耗尽"天天响，
 * 而真实花销很小。这不是账单价，但至少与"真花钱的那部分"同向——不再是那个吓人的数。
 */
export const BUDGET_METRIC_NOTE =
  '口径：非缓存 token（输入里没命中缓存的那部分 + 输出，即"真花钱的那部分"）；'
  + '命中缓存的那一大截不算在内，与账单上的实际用量仍不是同一个数。';

export interface BudgetView {
  range: 'today' | '7d';
  generatedAt: string;
  limitSource: string;
  /**
   * 预算口径的那一句话，**由服务端一处给出**，界面照抄（2026-10-04 加）。
   *
   * 为什么必须摆在数字旁边：token 那两档数的是**非缓存**的 token
   *（`(input − cacheHit) + output`，2026-10-05 之前的读数是"未扣缓存"、含 cacheHit——
   * 两者在同一个真实分片上差约 25 倍）。口径换了而说明没换，人读到的就是上一套语义。
   * 让每个消费者各写一份措辞，迟早会写出三种说法（这一条与"标签词只有一处"同源）。
   */
  metricNote: string;
  today: {
    tokens: number; heavy: number; light: number; cacheHit: number; cacheMiss: number; hitRate: number | null;
  };
  /** 五档预算阈值（前端画“距硬阈值进度条”直接读它） */
  limits: {
    stepTools: number; turnSteps: number; taskTokens: number; dailyTokens: number; softRatio: number;
  };
  /** limits 的平铺副本：前端有 `d.limits.x ?? d.x` 两种读法，两个都给它 */
  dailyTokens: number;
  softRatio: number;
  taskTokens: number;
  topUps: Record<string, number>;
  layers: Array<{
    layer: BudgetLayer; used: number; limit: number; hardRatio: number;
    softLimit: number; softRatio: number; over: boolean; soft: boolean;
  }>;
  /** 最近 24 小时序列（弹层里的“24 小时”图） */
  hourly: HourlyPoint[];
  /** 按天序列（range=today 为 1 天，7d 为 7 天） */
  daily: Array<{ date: string; tokens: number; heavy: number; light: number; hit: number; miss: number }>;
  /** 最近 20 个 turn 的明细（结论微章 + 输入/输出 + 命中率 + 耗时） */
  turns: BudgetTurnRow[];
  /** 本月估算（页脚）：token 累计 / turn 数 / 单次均价 */
  month: { tokens: number; turns: number; avgPerTurn: number };
}

/** 一个 turn 的预算明细行（从 budget/consumed 与 turn/end 拼出来） */
export interface BudgetTurnRow {
  turn: number;
  input: number;
  output: number;
  hit: number;
  miss: number;
  hitRate: number | null;
  durationMs: number;
  /** 结局种类（turn/end 的 reason.kind）；日志里没找到则为 null */
  reasonKind: string | null;
}

export interface PersonaFileEntry {
  path: string;
  name: string;
  bytes: number;
  mtime: string | null;
  reserved: boolean;
  tokens: number;
  /** 未决提案数（两种读法都保留：前端文件树自己取过 proposals） */
  proposalCount: number;
  proposals: number;
  isSeed: boolean;
}

export interface PersonaFilesView {
  root: string;
  files: PersonaFileEntry[];
  relationships: string[];
  proposals: string[];
}

export interface PersonaHistoryEntry {
  seq: number;
  ts: string;
  file: string;
  by: string;
  diffHash: string;
}

export interface ReplayView {
  turn: number;
  step: number;
  ts: string;
  origin: string | null;
  /** 三指纹的平铺副本：事件里的“当时值”（前端做微章直接读顶层） */
  renderVersion: string;
  personaHash: string;
  configHash: string;
  /** 三指纹徽章的展示面（frontend.md §3.2）：事件里的“当时值” + 当前值，差异即 diff 线索 */
  fingerprints: {
    renderVersion: string;
    personaHash: string;
    configHash: string;
    currentPersonaHash: string;
    personaChanged: boolean;
    configChanged: boolean;
  };
  request: RenderedRequest;
  /** 请求体的角色视图（instructions → system，input 逐项展开）：给页面分色条用 */
  messages: Array<{ role: string; content: string }>;
  usage: {
    lane: string; model: string; inputTokens: number; outputTokens: number;
    cacheHitTokens: number; cacheMissTokens: number; durationMs: number; finishReason: string;
  } | null;
}

// ──────────────────────────────── 内部工具 ────────────────────────────────

/** HTTP 层错误：唯一由 `{error:{code,message}}` 落地的地方 */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function badRequest(message: string, code = 'bad-request'): HttpError {
  return new HttpError(400, code, message);
}

function notFound(message: string, code = 'not-found'): HttpError {
  return new HttpError(404, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把 `patch` 里**真有**的键盖到 `base` 上（递归；`$` 开头的注释键跳过）。
 *
 * 为什么要有这个"覆盖"而不是直接用文件里那份：`config.json` 允许只写它关心的几项，
 * 其余走代码默认（`config.ts` 的教义）。设置页要显示的是**盘上那份**，但它也得显示
 * "你没写、按默认跑"的那些项——所以底用生效配置，覆盖上去的才是文件里真有的值。
 */
function overlayConfig(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('$')) continue;
    const current = base[key];
    base[key] = isRecord(value) && isRecord(current) ? overlayConfig(current, value) : value;
  }
  return base;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内容哈希做幂等键时统一截 16 位：够区分，又短到人能一眼比对 */
function contentKey(prefix: string, text: string): string {
  return `${prefix}-${sha256Hex(text).slice(0, 16)}`;
}

/** seq → ISO 时刻的毫秒数；解析失败返回 NaN（调用方各自决定降级口径） */
function parseTs(ts: string): number {
  return Date.parse(ts);
}

// ──────────────────────────────── 认证取凭据 ────────────────────────────────

/**
 * 共享 token 的**生成**路径已经删除（2026-10：本地认证换成密码，见 `web/auth.ts`）。
 * 这里只留"从请求头里把 Bearer 取出来"这一件事——取法只有一份，
 * 免得 `/api/*` 与 `/webhook/*` 对"什么算一个 Bearer"各有一套理解。
 *
 * 为什么不用 cookie：本地网页能把 cookie 顺到你的端口上，而 Bearer 头必须由调用方显式写下
 * （完整理由写在 `web/auth.ts` 的文件头）。
 */
function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  if (typeof raw !== 'string') return null;
  const matched = /^Bearer\s+(.+)$/iu.exec(raw.trim());
  return matched === null ? null : matched[1]!.trim();
}

// ──────────────────────────────── 响应与请求体 ────────────────────────────────

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  sendJson(res, status, body);
}

/**
 * 实例标识：`<host>:<port>#<数据目录哈希前 16 位>`。
 *
 * 为什么界面需要它（它是这轮修的一个真坑）：GUI 过去把凭据存在
 * `%APPDATA%\Irmia\gui-token` —— 一个**全局路径**。第二个实例一启动就把第一个的凭据顶掉，
 * 于是"突然进不去"。根治办法只有一个：凭据按**实例**分文件存，而界面得先知道
 * "我现在连的是哪一个实例"。host:port 它自己有，**数据目录是服务端才知道的事实**，
 * 所以得由这里告诉它。
 *
 * 为什么可以未经认证就给出去：它是数据目录的**哈希前 16 位**，不是路径本身。
 * 想拿它反推路径，比直接读 `config.json` 难得多；而本地攻击者本来就看得见那个目录。
 * 挂在 401 的响应体里（而不是另开一条"我是谁"的公开端点），是为了让
 * 「未初始化时只放行设置密码这一条路」那条纪律一个字都不用让步。
 *
 * 归一化（去尾部分隔符、Windows 下转小写）是为了让同一条路径的不同写法算出同一个标识——
 * 界面换个写法启动就认不出自己存的凭据，那正是这次要消灭的那类故障。
 */
export function instanceIdOf(host: string, port: number, dataDir: string): string {
  let normalized = resolve(dataDir).replace(/[\\/]+$/u, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return `${host}:${port}#${digest}`;
}

interface BodyReadResult {
  ok: boolean;
  text: string;
  code: string;
  message: string;
}

/**
 * 读请求体并限长。超限后**继续吞掉剩余字节但不保存**——用 break/销毁流会让响应写不回去，
 * 而"撒谎说收到"比"晚半秒回 413"糟糕得多。内存占用恒为 limit 以内。
 */
async function readBody(req: IncomingMessage, limitBytes: number): Promise<BodyReadResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > limitBytes) {
        tooLarge = true;
        continue;
      }
      chunks.push(buf);
    }
  } catch (err) {
    return { ok: false, text: '', code: 'read-error', message: `读取请求体失败：${describeError(err)}` };
  }
  if (tooLarge) {
    return {
      ok: false, text: '', code: 'payload-too-large',
      message: `请求体超过 ${limitBytes} 字节上限`,
    };
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8'), code: '', message: '' };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    throw badRequest(`请求体不是合法 JSON：${describeError(err)}`);
  }
  if (!isRecord(value)) throw badRequest('请求体顶层必须是 JSON 对象');
  return value;
}

// ──────────────────────── 配置文件串行闸（Windows 硬约束） ────────────────────────

/**
 * 配置文件（config.json / hooks.json）的**全局串行闸**：所有读改写都从这里过。
 *
 * 为什么必须有它——这是本轮实测出来的一个真 bug，值得完整记下来：
 *
 *   Windows 的 `MoveFileEx(REPLACE_EXISTING)` 在**目标文件正被另一个句柄打开**时会回
 *   `EPERM`，而不是像 POSIX 那样"先解除链接、句柄继续读旧 inode"。而 `loadConfig` 走的是
 *   **异步** `readFile`（线程池）：它一旦在飞，目标上就有一个读句柄；此时另一条写命令的
 *   `renameSync(tmp, path)` 必然 EPERM——**重试多久都没用**，因为那个读要等线程池回话。
 *   实测：5 条并发 `tool-toggle` 里 4 条 500（`EPERM: rename config.json.tmp.…`），
 *   退避从 60ms 加到 320ms 再到 1s 都是同样的结果；把同一条路径单独拿出来跑
 *   （异步 readFile + rename 并发）重现出**完全一致**的 1 成功 4 失败。
 *
 * 影响面不止扩展页：设置页保存、聊天里 `/reset`、CLI 都可能是那"另一条命令"。
 * 处置上有两条路——把写入也改成异步（退化掉"读改写同步"这条既有设计），
 * 或者**给这些文件一个串行闸**。选后者：闸只包住文件 I/O 那几行，
 * 读改写的同步性质与全部既有代码路径一个字都不用改。
 *
 * 纪律：**任何碰这两个文件的读改写都必须 acquire 它**（包括 `loadConfig` 的复检——
 * 复检留下的读句柄正是卡住下一个写者的东西）。闸是可重入的吗？不是：不要嵌套 acquire。
 *
 * **实现与实例都在 `config/file-lock.ts`**（2026-10-11 搬过去）：这条通道多了第二个写入方
 * ——她申请、人批准之后**框架**往 `mcp.servers[]` 里加/删一条（`grant/mcp-grant.ts` 的
 * `withGrantConfigDoc`）。两个写入方必须排在**同一个队列**里：各自建一把锁就是那个经典洞
 * （两条"读整份文档 → 改 → 写回"交错执行，后写的把先写的整段盖掉）。放在那个文件里、
 * 两边都从它 import 之后，谁重写谁都不影响这一格（这条路上出过一次"整文件重写把
 * `export const configFileLock` 连同一段逻辑一起带走"的事故）。
 */
import { configFileLock } from '../config/file-lock.ts';

// ──────────────────────────────── 原子写 ────────────────────────────────

/**
 * 原子写（临时文件 → fsync → rename 覆盖）**搬去了 `web/atomic.ts`**（2026-10）。
 *
 * 搬家的理由是 `data/.auth.json`：它和 `config.json` 是同一类东西——一份被并发请求读改写的
 * JSON，而它写坏的后果更重（凭据文件坏了 = 人得重新设一次密码）。两份实现会让"保证"漂移，
 * 所以只有一份，两个调用方都用它。这里的纪律不变：**真正的根因是并发的异步读句柄**，
 * 由上面那个 `configFileLock` 处理；`writeFileAtomicSync` 里那层退避兜的是杀软/索引器的偶发。
 */

// ──────────────────────────────── 事件读写辅助 ────────────────────────────────

// 全量事件快照的实现搬去了 `src/state/event-snapshot.ts`（2026-10-10）。
//
// 为什么搬：**同一件事有两个热路径在做**——本文件的八条只读端点，与 `real-loop.ts`
// 的 `mcpIndexSync()`（**每一拍**，`pollMs = 1000`）。后者每拍把全量日志折进一个**新数组**，
// 实测单次 **98.4 MB / 500 ms**（`_research/probe-tick-churn.mts`），而 V8 把堆还给
// `heapUsed`、不还给系统 ⇒ RSS 高水位被一路顶上去（真实事故：带上限 512 MB 那轮 167 秒 OOM）。
// 两份实现必然漂移，所以只留一份、两边共用。

/**
 * 框架提示的条数：缺省 {@link FRAMEWORK_NOTES_LIMIT}，显式传入时夹在 [1, {@link FRAMEWORK_NOTES_MAX_LIMIT}]。
 *
 * 非法值**不报 400**：这是只读摘要，人只是想把卡片调宽一点；为一个查询参数把整张卡打成错误页
 * 不划算（对比 `/api/memory?file=` 那种"参数决定读哪个文件"的端点，那类才必须当场拒绝）。
 */
function frameworkNoteLimit(raw: string | null): number {
  if (raw === null || raw.trim() === '') return FRAMEWORK_NOTES_LIMIT;
  const asked = Number(raw);
  if (!Number.isFinite(asked) || asked < 1) return FRAMEWORK_NOTES_LIMIT;
  return Math.min(Math.floor(asked), FRAMEWORK_NOTES_MAX_LIMIT);
}

/**
 * 引用片段截断：`quotes` 里是**外部原文**，长度不由我们决定（一条群消息可以几千字）。
 * 保留前 N 字并标注还剩多少——与 `render.ts` 的外部正文截断同一口径：
 * 让人知道"后面还有"，而不是误以为就这么多。
 *
 * 同时挡住两种脏数据：`quotes` 不是数组（模型判定的返回值不可全信）、元素不是字符串。
 */
function clipFrameworkQuotes(quotes: unknown): string[] {
  if (!Array.isArray(quotes)) return [];
  const out: string[] = [];
  for (const raw of quotes) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (text === '') continue;
    out.push(
      text.length <= FRAMEWORK_NOTE_QUOTE_MAX_CHARS
        ? text
        : `${text.slice(0, FRAMEWORK_NOTE_QUOTE_MAX_CHARS)}…[还有 ${text.length - FRAMEWORK_NOTE_QUOTE_MAX_CHARS} 字]`,
    );
    if (out.length >= FRAMEWORK_NOTE_QUOTES_MAX) break;
  }
  return out;
}

/**
 * 尾部事件视图：dashboard 的 24h 序列与建议规则只需最近一段，不必每次全量读盘。
 * 首次 sync 从"尾部 DASHBOARD_EVENT_WINDOW 条"起读（seq 有空洞时是估算，注释在案），
 * 之后按 `latestSeq` 增量补齐；保留条数超过窗口就从头部裁掉。
 *
 * 裁剪**用头部下标，不用 `slice(-window)`**。⚠ 老实说这一处的收益也很小：`slice` 复制的
 * 是**引用数组**，1 万条 ≈ 几十 KB（与 `allEventsOf` 那处同一性质，见那里的注释）；
 * 它是"每拍少一次分配"，不是"省下几十 MB"。之所以还是改：dashboard 每次刷新都走这里，
 * 而 RSS 只涨不还，长期就是白交给 V8 的峰值。
 * 用下标时只在"死区比活区还大"时才真压一次，均摊几乎为零；`sync()` 的返回值仍然只含
 * 窗口内那些条（消费方看不见下标）。
 */
class RecentEventView {
  private readonly log: EventLog;
  private readonly window: number;
  private events: AppEvent[] = [];
  /** 逻辑头部：`events[head..]` 才是有效窗口；`head === events.length` = 空 */
  private head = 0;
  private upToSeq = 0;

  constructor(log: EventLog, window: number) {
    this.log = log;
    this.window = window;
  }

  async sync(): Promise<AppEvent[]> {
    const latest = this.log.latestSeq();
    if (latest <= this.upToSeq) return this.head === 0 ? this.events : this.events.slice(this.head);

    const from = this.upToSeq === 0 ? Math.max(1, latest - this.window) : this.upToSeq + 1;
    for await (const event of this.log.readRange(from)) this.events.push(event);
    // 超出窗口的部分只**记账**（推 head），不复制
    const live = this.events.length - this.head;
    if (live > this.window) this.head += live - this.window;
    // 死区比活区还大时才真压一次，免得数组无限长（摊销到每一拍几乎为零）
    if (this.head > 0 && this.head >= this.events.length - this.head) {
      this.events = this.events.slice(this.head);
      this.head = 0;
    }
    this.upToSeq = latest;
    return this.head === 0 ? this.events : this.events.slice(this.head);
  }
}

// ──────────────────────────────── 事件过滤与分页 ────────────────────────────────

interface EventFilters {
  /** 完整类型（`tool/call`）或以 `/` 结尾的前缀（`tool/`） */
  types: string[];
  visibility: 'model' | 'internal' | null;
}

function matchesFilters(event: AppEvent, filters: EventFilters): boolean {
  if (filters.visibility !== null && event.visibility !== filters.visibility) return false;
  if (filters.types.length === 0) return true;
  return filters.types.some((type) => (type.endsWith('/') ? event.type.startsWith(type) : event.type === type));
}

async function collectEvents(
  log: EventLog,
  fromSeq: number,
  filters: EventFilters,
  limit: number,
): Promise<AppEvent[]> {
  const out: AppEvent[] = [];
  for await (const event of log.readRange(fromSeq)) {
    if (!matchesFilters(event, filters)) continue;
    out.push(event);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 从 fromSeq 扫到日志末尾，滚动保留最后 limit 条匹配事件（内存 O(limit)）。
 * 这是"取最新一批"的唯一正确姿势：readRange 只能向后读，而"最新 N 条"必须看完整段尾部窗口才成立。
 */
async function tailMatches(
  log: EventLog,
  fromSeq: number,
  filters: EventFilters,
  limit: number,
): Promise<AppEvent[]> {
  const keep: AppEvent[] = [];
  for await (const event of log.readRange(fromSeq)) {
    if (!matchesFilters(event, filters)) continue;
    keep.push(event);
    if (keep.length > limit) keep.splice(0, keep.length - limit);
  }
  return keep;
}

/** 分页查询（frontend.md §4：200/批；`from_seq` 缺省时给**最新**一批） */
export async function queryEvents(
  log: EventLog,
  query: { fromSeq: number | null; filters: EventFilters; limit: number },
): Promise<EventsPage> {
  const latest = log.latestSeq();
  const limit = query.limit;
  let fromSeq: number;
  let events: AppEvent[];

  if (query.fromSeq === null) {
    // 无 from_seq：尾部窗口内滚动取最后 limit 条。窗口大小是"读多少行"的预算，
    // 不是"收多少条"——过滤稀疏时窗口内可能一条都不匹配，那时才退化全量
    fromSeq = Math.max(1, latest - limit * LATEST_SCAN_FACTOR);
    events = await tailMatches(log, fromSeq, query.filters, limit);
    if (events.length < limit && fromSeq > 1) {
      // 过滤极稀疏：全量扫一次，保证"最新 N 条"名副其实
      // （否则界面会显示一个看起来像没数据的残缺列表）
      fromSeq = 1;
      events = await tailMatches(log, 1, query.filters, limit);
    }
  } else {
    fromSeq = query.fromSeq;
    events = await collectEvents(log, fromSeq, query.filters, limit);
  }

  const lastEventSeq = events.length > 0 ? events[events.length - 1]!.seq : fromSeq - 1;
  // "更早一批"的游标：给最早一条的**前一条** seq，而不是 firstSeq - limit——
  // seq 有空洞、过滤又会稀疏，硬跳一批会跨过永远拉不到的事件；重叠一条由前端按 seq 去重。
  const firstEventSeq = events.length > 0 ? events[0]!.seq : 0;
  return {
    events,
    fromSeq,
    nextFromSeq: lastEventSeq + 1,
    nextBeforeSeq: firstEventSeq > 1 ? firstEventSeq - 1 : null,
    lastSeq: latest,
    hasMore: latest > lastEventSeq,
  };
}

// ──────────────────────────────── dashboard ────────────────────────────────

function hourlyKeys(nowMs: number): string[] {
  const keys: string[] = [];
  for (let i = 23; i >= 0; i--) keys.push(new Date(nowMs - i * 3_600_000).toISOString().slice(0, 13));
  return keys;
}

/**
 * 最近 24 小时的逐小时序列。总览趋势线与预算弹层共用**同一份实现**：
 * 两处各算一遍必然会漂移，而“图表不一样”比“图没数据”更难查。
 *
 * `tokens` / `heavy` / `light` 三格是**预算口径**（非缓存，`budgetTokensOf`，与卡片上那个数同源）；
 * `input` / `output` / `hit` / `miss` 是**原始分量**（照事件原样记，图表想拆开看时用）。
 * 这张图与「今日用量」那张卡必须在同一个口径上——两个数不一样，人只会以为其中之一坏了。
 */
export function buildHourlySeries(events: readonly AppEvent[], nowMs: number): HourlyPoint[] {
  const keys = hourlyKeys(nowMs);
  const buckets = new Map<string, HourlyPoint>();
  for (const key of keys) {
    buckets.set(key, { hour: `${key}:00Z`, tokens: 0, input: 0, output: 0, hit: 0, miss: 0 });
  }
  for (const event of events) {
    if (event.type !== 'budget/consumed') continue;
    const bucket = buckets.get(event.ts.slice(0, 13));
    if (bucket === undefined) continue;
    bucket.input += event.data.inputTokens;
    bucket.output += event.data.outputTokens;
    bucket.tokens += budgetTokensOf(event.data);
    bucket.hit += event.data.cacheHitTokens;
    bucket.miss += event.data.cacheMissTokens;
  }
  return keys.map((key) => buckets.get(key)!);
}

function deriveState(
  p: Projection,
  nowMs: number,
): { state: DashboardState; stateText: string; detail: string; nextWakeAt: string | null; stateNote: string } {
  let nextWakeAt: string | null = null;
  for (const timer of p.timers) {
    if (timer.at === undefined) continue;
    if (nextWakeAt === null || parseTs(timer.at) < parseTs(nextWakeAt)) nextWakeAt = timer.at;
  }

  if (p.needsReview.length > 0) {
    const oldest = p.needsReview.reduce((acc, item) => (parseTs(item.at) < parseTs(acc.at) ? item : acc));
    const days = Math.max(0, Math.floor((nowMs - parseTs(oldest.at)) / 86_400_000));
    return {
      state: 'needs-review',
      stateText: `有 ${p.needsReview.length} 个调用等你确认`,
      detail: `最早一条 ${oldest.callId}（${oldest.at}）${days > 0 ? `，已搁置 ${days} 天` : ''}`,
      nextWakeAt,
      stateNote: '',
    };
  }
  const live = livePausedLayers(p);
  if (live.length > 0) {
    return {
      state: 'paused',
      stateText: `预算暂停（${live.join(' / ')} 层）`,
      detail: `进度已保留，加注后从原地继续（待办 ${p.pending.length} 条）`,
      nextWakeAt,
      stateNote: '',
    };
  }
  if (p.degraded !== null) {
    return {
      state: 'degraded',
      stateText: `降级运行中（${p.degraded.lane}）`,
      detail: `${p.degraded.reason}（自 ${p.degraded.since}）`,
      nextWakeAt,
      stateNote: '',
    };
  }
  // 曾经耗尽、当刻已经不在暂停态：这件事要**说出来**（不然人只记得屏幕上那句"已暂停"，
  // 见 Owner 2026-10-05 的现场）。它是"已经解除的历史"，不是当前故障——所以进 stateNote，
  // 不进 stateText（状态词说的是当刻在干什么）。
  const lifted = pausedRecordLayers(p);
  const stateNote = lifted.length === 0
    ? ''
    : `预算暂停已解除（${lifted.join(' / ')} 层）：当刻没有一层停在撞线状态，照常值守`;
  if (p.openTurn !== null) {
    return {
      state: 'running',
      stateText: 'Agent 正在值守',
      detail: `turn ${p.openTurn.turn} · 第 ${p.openTurn.step} 步`
        + (p.lastAssistantText === null ? '' : ` · ${p.lastAssistantText.slice(0, 30)}`),
      nextWakeAt,
      stateNote,
    };
  }
  if (p.idleTicks >= 4) {
    return {
      state: 'sleeping',
      stateText: '沉睡中',
      detail: `已连续空转 ${p.idleTicks} 拍（安静中：心跳按概率抽签，越久越可能醒）`,
      nextWakeAt,
      stateNote,
    };
  }
  return {
    state: 'idle',
    stateText: '待机',
    detail: p.lastWake === null
      ? '还没有任何唤醒'
      : `最近唤醒 ${p.lastWake.source} @ ${p.lastWake.at}`
        + (nextWakeAt === null ? '' : ` · 下次 ${nextWakeAt}`),
    nextWakeAt,
    stateNote,
  };
}

/** 投影里**还留着** `budget/exhausted` 记录的层（不管那条记录是不是已经过时） */
function pausedRecordLayers(p: Projection): BudgetLayer[] {
  return (Object.keys(p.lastExhausted) as BudgetLayer[])
    .filter((layer) => p.lastExhausted[layer] !== undefined)
    .sort();
}

/**
 * **当刻真的还停着**的预算层（判据一处，界面不自己推断）。
 *
 * 这一条修的是用户 2026-10-05 的现场：「GUI 上还是一直显示预算耗尽」，左上角写着
 * 「已暂停（预算耗尽）」，而她已经跑了十几个小时。
 *
 * 根因不在界面，在**这条判据太松**：`deriveState` 过去把"投影里还有一条 `budget/exhausted`
 * 记录"直接当成"现在暂停着"。而那条记录是**历史事实**，投影不保证它会消失：
 *
 *   · `task` / `daily` 两层由 `BudgetGuard.liftedPauses` 判"抬上限解开"并落 `budget/resumed`
 *     （那条路会 `delete p.lastExhausted[layer]`）；
 *   · **`step` / `turn` 两层没有这条路**——它们数的是当拍计数器（本步工具数、本 turn 步数），
 *     而计数器在 `turn/start` / `step/start` 时归零。于是"某次 turn 走到第 30 步撞线"这条记录
 *     会**永远粘在投影里**（实测：本实例 data/projection.json 里就留着 `turn` 层那条
 *     `limit=30, actual=30`，而它之后的每一个 turn 都从第 1 步重新开始）。
 *
 * 所以判据补一条**用当刻的计数器验一遍**（与 `BudgetGuard` 的越线口径同向）：
 *
 *   · 记录里的层不是 `step` / `turn` ⇒ 照旧算暂停（`task` / `daily` 的解账由运行期那条路走，
 *     服务端不替它判定——判据多一处就必然出现一处说暂停、一处说正常的两个口径）；
 *   · 记录说"不可恢复"（`resumable: false`，人审挂起超时那一类）⇒ 照旧算暂停：
 *     它的解除条件是"人答了"，不是计数器，拿计数器去解它等于谎报解除；
 *   · `turn`：记录里写着撞线时的 `limit`（步数）。当刻本 turn 步数 **小于** 它 ⇒ 那个 turn
 *     已经结束（计数器归零）或新 turn 还没走到那一步 ⇒ 暂停早就不在了。
 *     步数到达上限才算真撞（`budget-guard.ts` 的 `over` 对 turn 层就是 `used >= limit`）。
 *   · `step`：同上，用记录里的 `limit`（当拍工具数上限）。
 *
 * 被这一条除掉的层同时是 {@link pausedRecordLayers} 的成员——于是它进 `stateNote`
 * （"预算暂停已解除"），而不是悄悄消失：人昨天看见的那句话必须有下文。
 */
export function livePausedLayers(p: Projection): BudgetLayer[] {
  // `step` / `turn` 两层的计数器量法，与 `state/fold.ts` 折进投影的两个字段同源：
  //   step  → budget.toolCallsThisStep（step/start 归零、每调一次工具 +1）
  //   turn  → budget.stepsThisTurn（turn/start 归零、step/start 无条件赋成步号）
  const counter = (layer: BudgetLayer): number => {
    if (layer === 'step') return p.budget.toolCallsThisStep;
    if (layer === 'turn') return p.budget.stepsThisTurn;
    return 0;
  };

  return pausedRecordLayers(p).filter((layer) => {
    const record = p.lastExhausted[layer];
    if (record === undefined) return false;
    // 不可恢复的暂停（人审挂起超时）：解除条件是"人答了"，不拿计数器解它
    if (record.resumable === false) return true;
    // 只有 step / turn 两层由**当拍计数器**定生死；task / daily 照旧按投影（运行期那条路的账）
    if (layer !== 'step' && layer !== 'turn') return true;
    return counter(layer) >= record.limit;
  });
}

function buildSuggestions(p: Projection, events: AppEvent[], nowMs: number): Suggestion[] {
  const out: Suggestion[] = [];
  const push = (
    item: { id: string; level: 'info' | 'warn'; title: string; body: string; act: string; actLabel: string },
  ): void => {
    out.push({ ...item, text: item.title });
  };

  if (p.needsReview.length > 0) {
    const oldest = p.needsReview.reduce((acc, item) => (parseTs(item.at) < parseTs(acc.at) ? item : acc));
    if (nowMs - parseTs(oldest.at) > REVIEW_STALE_MS) {
      push({
        id: 'review-stale',
        level: 'warn',
        title: `${p.needsReview.length} 项待确认已超 3 天`,
        body: `最早一条 ${oldest.callId}（${oldest.at}）：有副作用的调用悬着不结案，`
          + '恢复流程只能一直把它当未完成。',
        act: 'goto-review',
        actLabel: '去处理',
      });
    }
  }

  const calls = p.budget.cacheHitToday + p.budget.cacheMissToday;
  if (calls > CACHE_SAMPLE_MIN) {
    const rate = p.budget.cacheHitToday / calls;
    if (rate < CACHE_HIT_LOW) {
      push({
        id: 'cache-hit-low',
        level: 'info',
        title: `缓存命中率偏低：${(rate * 100).toFixed(1)}%`,
        body: `今日 ${p.budget.cacheHitToday} 命中 / ${p.budget.cacheMissToday} 未命中：`
          + '常驻前缀被频繁改写（首部插入、时间戳、非确定性渲染）会让 KV cache 全 miss。',
        act: 'open-budget',
        actLabel: '看预算',
      });
    }
  }

  if (p.lastArchiveAt === null || nowMs - parseTs(p.lastArchiveAt) > ARCHIVE_STALE_MS) {
    push({
      id: 'archive-stale',
      level: 'info',
      title: p.lastArchiveAt === null
        ? '还没有归档过日志'
        : `日志已 ${Math.floor((nowMs - parseTs(p.lastArchiveAt)) / 86_400_000)} 天未归档`,
      body: '没有折叠快照时每次都从日志头部重放，日志越长启动越慢；备份快照也适合异地复制。',
      act: 'goto-tools',
      actLabel: '去工具组',
    });
  }

  if (p.deadLetters.length > 0) {
    push({
      id: 'dead-letters',
      level: 'warn',
      title: `死信队列非空（${p.deadLetters.length}）`,
      body: '认领三次仍失败的输入，需要人工决定重投还是丢弃。',
      act: 'goto-review',
      actLabel: '去处理',
    });
  }

  let lastPersonaAt: number | null = null;
  for (const event of events) {
    if (event.type !== 'persona/updated') continue;
    const at = parseTs(event.ts);
    if (!Number.isFinite(at)) continue;
    if (lastPersonaAt === null || at > lastPersonaAt) lastPersonaAt = at;
  }
  const personaBaseline = lastPersonaAt ?? (p.firstEventAt === null ? null : parseTs(p.firstEventAt));
  if (personaBaseline !== null && nowMs - personaBaseline > PERSONA_STALE_MS) {
    push({
      id: 'persona-stale',
      level: 'info',
      title: '人格已 30 天没有演化',
      body: '她是否还在“长”，看的是 persona/updated 的时间戳：没有新事件意味着 STATE/STYLE 一直没动。',
      act: 'goto-persona',
      actLabel: '看人格',
    });
  }

  return out;
}

/**
 * 重启那条 WMI 命令行的**拼法**（唯一一处，可单测）。
 *
 * 为什么把它单拎出来：用户 2026-10-05 的要求逐字是「带路径的请求**必须有留痕**」，
 * 而"留痕"里最要紧的那一列就是这条命令行——它同时是"脚本会收到什么参数"的唯一凭据
 * （WMI 建的进程没有 stdout，脚本那边的输出无处可去）。
 *
 * ## 2026-10-07：为什么外面必须套 `cmd.exe /c`（这是"点了按钮什么都没发生"的根因）
 *
 * 现场：这里过去直接送 `"<shell>" -NoProfile … -File "<脚本>" …` 给 `Win32_Process.Create`，
 * 返回码 **0**、pid 也有，而脚本**一个字都没执行**——留痕没有新行、`data/lock.json` 里的 pid
 * 从头到尾没变、后端照旧是原来那个进程。
 *
 * 本机对照实测（同一台机器、同一批参数、连续重复多轮，见 `tools/restart-agent.ps1` 的
 * `-ProbeExit` 与文件头那段）：
 *   · `Create('"…\pwsh.exe" -NoProfile … -File "…\restart-agent.ps1" …')`
 *     ⇒ ret=0、有 pid，**子进程立刻消失**，脚本什么都没做；
 *   · `Create('cmd.exe /c ""…\pwsh.exe" … -File "…\restart-agent.ps1" …"')`
 *     ⇒ ret=0，**脚本真的跑了**（留痕写出了 `[回执]`）。
 * 排除了编码（中文参数逐字送达）、`param()` 块、参数个数、引号与 `-File`/`-Command` 之别：
 * 换成本机一个三行的探针脚本，**裸建 pwsh 同样什么都没写**，套 `cmd /c` 就写出来了。
 *
 * 所以现在的形状是三条，缺一条就会退回"静默失败"（三条都是本机实测出来的，不是推断）：
 *   ① 外面套 `cmd.exe /s /c`（`cmd` 是 WMI 一定建得起来的那个；`/s` 让它**无条件**执行
 *      "命令行以引号开头就剥掉首尾引号"那条规则）；
 *   ② 里面的整段再用一对引号包起来——剥完正好是 `<shell> <参数…>`；
 *   ③ 末尾 `>> <日志> 2>&1` 必须写在那对引号**里面**：三点对照实测
 *      · `cmd /c  ""<exe>" "<arg>"" >> log 2>&1`   ⇒ ret=0，命令**根本没被执行**（日志都不生成）；
 *      · `cmd /s /c ""<exe>" "<arg>"" >> log 2>&1` ⇒ ret=0，**同样什么都没执行**；
 *      · `cmd /s /c ""<exe>" "<arg>" >> log 2>&1"` ⇒ ret=0，**命令真的跑了**（日志写出来）。
 *      脚本的输出过去**随 WMI 进程一起消失**，于是"脚本报错"在留痕之外完全看不见——
 *      这正是"失败无声"的另一半。
 *
 * 拼法本身的两条旧实测依据照旧（见 `_research/probe-restart-chain.ps1`）：
 *   · **每个参数各自加引号**：路径带空格时（`C:\Program Files\...`）不加引号会被拆成两截；
 *   · **不用 `--%`**：实测它把带引号的 `-File` 路径当字面量
 *     （`Processing -File '"…"' failed: Illegal characters in path`），
 *     而重启这条路上任何一点不确定都不该引入。
 */
export function restartCommandLine(input: {
  shellExe: string;
  argv: readonly string[];
  /** 脚本自己（cmd 那一层）的 stdout/stderr 落点；空字符串 = 不重定向 */
  scriptLog?: string;
}): string {
  // 重定向写在**外层那对引号里面**：`cmd /s` 会剥掉首尾引号，写在外面就落在引号之外，
  // 于是整条命令行成了"一条带引号却没闭合的命令"——cmd 不报错、也不执行（实证见文件头）。
  let inner = `""${input.shellExe}"`;
  if (input.argv.length > 0) inner += ` ${input.argv.join(' ')}`;
  const log = (input.scriptLog ?? '').trim();
  if (log !== '') inner += ` >> "${log}" 2>&1`;
  inner += '"';
  return `cmd.exe /s /c ${inner}`;
}

/**
 * 从留痕里读**服务端要的那两行**（`[回执]` / `[实例]` / `[结束]`）。
 *
 * 为什么要有解析这一步：脚本的输出过去是"人读的一段中文"，服务端除了"文件变大了吗"
 * 什么也问不出来——于是"起来了"与"起来了但端口没就绪"在响应里长得一模一样。
 * 现在脚本写三行**定形**的机器可读行，这里把它们读成结构；读不到就是 `null`，
 * **绝不猜**（读不到真相时说"没读到"，比编一个"应该没问题"强）。
 */
export function parseRestartTrace(text: string): {
  receipt: boolean;
  /** 这次走的是哪一条（`路径=` / `path=` 那两栏；读不到 = null，绝不猜） */
  path: RestartPath | null;
  backendPid: number;
  port: 'ready' | 'timeout' | 'waiting' | 'unknown';
  guiPid: number;
  ok: boolean | null;
  /** `[结束]` 里 `reason=` 那一栏：**失败坏在哪一环**（机器可读 token；空 = 没读到） */
  reason: string;
} {
  const out = {
    receipt: text.includes('[回执]'),
    path: parseRestartPath(text),
    backendPid: 0,
    port: 'unknown' as 'ready' | 'timeout' | 'waiting' | 'unknown',
    guiPid: 0,
    ok: null as boolean | null,
    reason: '',
  };
  const pid = /\[实例\][^\r\n]*?pid=(\d+)/u.exec(text);
  if (pid !== null) out.backendPid = Number(pid[1]);
  const end = /\[结束\][^\r\n]*/u.exec(text);
  if (end !== null) {
    const line = end[0];
    out.ok = /\bok=True\b/u.test(line);
    const endPid = /\bbackendPid=(\d+)/u.exec(line);
    if (endPid !== null && Number(endPid[1]) !== 0) out.backendPid = Number(endPid[1]);
    const port = /\bport=(\w+)/u.exec(line);
    if (port !== null) out.port = port[1] as 'ready' | 'timeout' | 'waiting' | 'unknown';
    const gui = /\bguiPid=(\d+)/u.exec(line);
    if (gui !== null) out.guiPid = Number(gui[1]);
    const reason = /\breason=([0-9A-Za-z-]+)/u.exec(line);
    if (reason !== null && reason[1] !== undefined) out.reason = reason[1];
  }
  return out;
}

/**
 * 重启回执那句话（**唯一一处**：服务端的响应 `note` 与界面上的 toast 说的是同一件事）。
 *
 * 判据要能把**三种结局**分开（用户 2026-10-07 的原话：「不许用'猜'的确认」）：
 *   · `scriptStarted === false` ⇒ **脚本没跑起来**——那一次重启**没有发生**，
 *     所以绝不能说"正在重启"（那正是过去那种"屏幕上说在重启、实际什么都没发生"）；
 *   · 脚本跑了而 `ok !== true`（进程没起 / 端口没就绪 / 界面没拉起）⇒ **如实说失败与为什么**；
 *   · 脚本跑了且 `ok === true` ⇒ 说成功，并带上**真实新 pid** 与端口就绪这两条凭据。
 *
 * 三态之间不许互相冒充：`ok === null`（没等到结尾那行）走的是"已发出、结局未确认"，
 * 而不是"成功"——那不是猜，是把"我还不知道"如实说出口。
 */
export function restartNote(outcome: {
  gui: boolean;
  scriptStarted: boolean;
  /** 脚本结尾那行的 `ok`（没读到 = null） */
  ok?: boolean | null | undefined;
  /** 真实新 pid（来自 lock.json / 脚本的 `[实例]`），0 = 没拿到 */
  backendPid?: number | undefined;
  /** 端口那一档 */
  port?: 'ready' | 'timeout' | 'waiting' | 'unknown' | undefined;
  /** 脚本报的失败原因（可选；`[结束]` 的 `reason=` 那一栏优先） */
  reason?: string | undefined;
  /**
   * 这次走的是哪一条（`restart-chain.ts` 的优先级链）。
   *
   * 为什么必须写进这句话：三条路径的**失败症状长得一样**（后端没换 pid），
   * 而"它当时想走哪条"是事后第一个要回答的问题——不写，就只能靠现场复现（这次就是这么过来的）。
   * 缺省 null = 老调用方（老脚本、旧事件）不写这一栏，文案里也就不提它。
   */
  path?: RestartPath | null | undefined;
}): string {
  const scope = outcome.gui ? '主进程与界面' : '主进程（界面不在本次动作范围内，它只是重连回来）';
  const where = outcome.path === undefined || outcome.path === null ? '' : `（路径=${outcome.path}）`;
  if (!outcome.scriptStarted) {
    // **哪一环坏的**要有名有姓：self-restart 这一条没有"脚本"，说"没跑脚本"会把人指错方向
    const why = outcome.path === 'self-restart'
      ? restartReasonText('worker-not-started')
      : '脚本没有留下回执（它根本没跑起来）';
    const hint = outcome.path === 'self-restart'
      ? '看 data/restart-script.log（拉起器的输出）与 data/restart-trace.log'
      : '请手动跑一次 restart.ps1（装出来的那份在包根）或 tools/restart-agent.ps1（开发仓库里），'
        + '或看 data/restart-trace.log';
    return `重启未能执行${where}：${why}。**后端没有被重启**——${hint}`;
  }
  if (outcome.ok === false) {
    // 失败也要说清**坏在哪一环**：`reason=` 是机器可读的那一栏，这里翻成人话
    const token = (outcome.reason ?? '').trim();
    const why = token === '' ? '' : `（${restartReasonText(token) === '' ? token : restartReasonText(token)}）`;
    const pid = outcome.backendPid === undefined || outcome.backendPid === 0
      ? '没有拿到新进程 pid'
      : `新进程 pid ${outcome.backendPid}`;
    const port = outcome.port === 'ready' ? '端口已就绪' : `端口未就绪（${outcome.port ?? 'unknown'}）`;
    return `重启失败${where}${why}：${pid} · ${port}——详见 data/restart-trace.log`;
  }
  if (outcome.ok === true) {
    const pid = outcome.backendPid === undefined || outcome.backendPid === 0
      ? '（pid 未读到）'
      : `真实新 pid ${outcome.backendPid}`;
    return `正在重启${scope}${where}：${pid} · 端口已就绪`;
  }
  // self-restart 这一条的结局**天然晚于回执**：新实例要等旧实例退出才起得来，
  // 所以这里要把"链条已经armed"这件事说出口，而不是只说一句"还没确认"。
  const armed = outcome.path === 'self-restart'
    ? '：拉起器已经在跑了，它会等旧实例退出后拉起新实例'
    : '';
  return `重启已发出${outcome.gui ? '（含界面）' : ''}${where}${armed}，但结局还没确认——`
    + '看 data/restart-trace.log 里这次的 `[结束]` 那行';
}

/**
 * 等脚本写下的那行 `[回执]`（最多约 [RESTART_RECEIPT_WAIT_MS] 毫秒）。
 *
 * 为什么要有这一步：`Win32_Process.Create` 的返回码**不能证明脚本跑起来了**。
 * 本仓实测（见 `_research/probe-restart-chain.ps1` 与同一批 WMI 对照实验）：
 *   · 内联 `-Command "Set-Content …"` 经 WMI 跑 → 文件真的写出来了；
 *   · `<shell> -File <脚本>` 经 WMI 跑 → **返回码 0、pid 也有，脚本一个字都没执行**；
 *   · `cmd.exe /c "… > 日志 2>&1"` 那一层被拒时，stderr 只有一句"拒绝访问。"，
 *     而 `Create` 照样返回 0。
 * 也就是"启动失败"可以完全无声。服务端过去只检查返回码 ⇒ 屏幕上说"正在重启"，而
 * 实际上什么都没发生（用户 2026-10-05 的「点了没有反馈」正是这种形状）。
 *
 * 判据很朴素：脚本**第一件事**就是往约定文件追加一行带 `[回执]` 的日志。
 * 文件长度比发起前大了 = 那行写下来了 = 脚本真的在中途跑着。读不到就如实说"没读到"，
 * **不假装成功**（这一条的代价说清：脚本那行日志本身写失败时也会读到"没有回执"——
 * 但那种情况下我们确实没有任何证据说它起来了，如实存疑比谎报成功好）。
 */
/**
 * 等脚本在留痕文件里写下**某一类行**（最多 [RESTART_RECEIPT_WAIT_MS] 毫秒）。
 *
 * 为什么要有这一步：`Win32_Process.Create` 的返回码**不能证明脚本跑起来了**。
 * 本仓实测（见 `_research/probe-restart-chain.ps1` 与同一批 WMI 对照实验，2026-10-07 复现）：
 *   · `"<shell>" -NoProfile … -File <脚本>` 经 WMI 跑 → **返回码 0、pid 也有，脚本一个字都没执行**；
 *   · 换成 `cmd.exe /c ""<shell>" … -File <脚本>"` → 同一个脚本写出了 `[回执]`。
 * 也就是"启动失败"可以完全无声。服务端过去只检查返回码 ⇒ 屏幕上说"正在重启"，而
 * 实际上什么都没发生（用户 2026-10-05 的「点了没有反馈」+ 2026-10-07 的「重启没能确认」）。
 *
 * 判据很朴素：只看**发起之后新增的那段内容**里有没有 `[回执]`（脚本第一件事就写它），
 * 以及有没有 `[结束]`（结尾那行：成功/失败 + 真 pid + 端口那一档）。
 * 读不到就如实说"没读到"，**不假装成功**（这一条的代价说清：脚本那行日志本身写失败时也会
 * 读到"没有回执"——但那种情况下我们确实没有任何证据说它起来了，如实存疑比谎报成功好）。
 *
 * ## 2026-10-07：等多久、等哪一行
 *
 * 过去固定忙等 400ms。实测这个窗口**对谁都不够**：脚本要先被 `cmd` 起、再起 pwsh
 * （两三秒的启动本身就吃掉大半），于是"回执"永远读不到——GUI 那句"重启没能确认"
 * 有一半是**这里太急**造成的，而不是脚本没起来。
 * 现在按 `IRMIA_RESTART_CONFIRM_MS` 给一个默认 [RESTART_RECEIPT_WAIT_MS] 的窗口
 * （起进程要时间，这是等得到的），并且**只等能等到的那一行**：
 *   · `[实例]`（后端已经换了 pid）——后端要被重启时，这一行几秒内必然出现；
 *   · 否则等 `[结束]`——不重启后端时（`-GuiOnly`）端口探测不跑，结尾也就快。
 * 再长就该由界面去说"还没回来"，而不是把 HTTP 响应扣在这儿。
 */
const RESTART_RECEIPT_WAIT_MS = ((): number => {
  const raw = Number(process.env['IRMIA_RESTART_CONFIRM_MS'] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
})();
const RESTART_RECEIPT_STEP_MS = 50;

function waitForScriptReceipt(
  traceLog: string,
  sizeBefore: number,
  /** 等到其中**任意一行**出现就算这一档到了（`[实例]` 几秒内必到；`[结束]` 是收尾那行） */
  markers: readonly string[],
): { started: boolean; text: string } {
  const deadline = Date.now() + RESTART_RECEIPT_WAIT_MS;
  for (;;) {
    let text = '';
    try {
      const size = existsSync(traceLog) ? statSync(traceLog).size : -1;
      if (size > sizeBefore) {
        // 只读新增的那一段：文件是**追加**写的，历史那些行属于过去几次重启
        const fd = openSync(traceLog, 'r');
        try {
          const length = size - sizeBefore;
          const buffer = Buffer.alloc(length);
          readSync(fd, buffer, 0, length, sizeBefore);
          text = buffer.toString('utf8');
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // 读不到就当"还没有"：这一路只问"有没有新内容"，不把读失败当证据
    }
    if (markers.some((marker) => text.includes(marker))) return { started: true, text };
    if (Date.now() >= deadline) return { started: text.includes('[回执]'), text };
    // 忙等 50ms：这条路上不能 await（回执要在这一个请求里给出去）
    const until = Date.now() + RESTART_RECEIPT_STEP_MS;
    while (Date.now() < until) { /* spin */ }
  }
}

/**
 * 端口**现在**有人听吗（TCP 建连，最多等 500ms）。
 *
 * 为什么服务端要自己问一句：脚本结尾那行 `[结束]` 里也有 `port=`，但它要等端口就绪
 * 才写得出来——而界面的这句回执不能在那儿扣 60 秒。所以中间那一档（后端已经换了 pid、
 * 脚本还没确认端口）由这里补上实测：**连得上 = 端口已经在服务**，这一条既是"后端起没起来"
 * 的第二重凭据，也是 `ok=true` 的判据之一（另一重是 lock.json 里换了 pid）。
 *
 * 用系统自带的 `powershell.exe` 走 `TcpClient`：与 `tools/restart-agent.ps1` 里那段
 * **同一个判据**（同一件事不写两份），而且这条路上不能 await（回执要在这一个请求里给出去），
 * `spawnSync` 正好给出一次同步的是/否。这条命令是逐字常量，端口只以数字拼进去，
 * 没有任何外部输入能改变它的形状。
 */
function portListening(host: string, port: number): boolean {
  const script = '$c = New-Object System.Net.Sockets.TcpClient; try { '
    + `$i = $c.BeginConnect('${host}', ${port}, $null, $null); `
    + 'if ($i.AsyncWaitHandle.WaitOne(500, $false) -and $c.Connected) { exit 0 } } catch { } '
    + 'finally { $c.Close() }; exit 1';
  try {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 4000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** 真 pid 的唯一来路：`<dataDir>/lock.json`（她启动后自己写的 {pid, startedAt, heartbeatAt}）。 */
function readLockPid(dataDir: string): number {
  try {
    const lock = JSON.parse(readFileSync(join(dataDir, 'lock.json'), 'utf8')) as { pid?: unknown };
    return typeof lock.pid === 'number' ? lock.pid : 0;
  } catch {
    return 0;
  }
}

/** 重启确认的结论（三态 + 凭据）。**唯一一处**判定，界面文案与事件字段都读它。 */
export interface RestartConfirmation {
  /** 脚本留下了 `[回执]`（它真的跑起来了）。false ⇒ **这次重启没有发生** */
  scriptStarted: boolean;
  /** 后端真的换了个人：从 lock.json / 脚本 `[实例]` 读到的**真实**新 pid（0 = 没拿到） */
  backendPid: number;
  /** ready = 端口在服务；timeout = 脚本等到超时；waiting = 已发出、还没到那一档 */
  port: 'ready' | 'timeout' | 'waiting' | 'unknown';
  /** 脚本结尾那行的 ok（null = 没读到 ⇒ 结局未确认，**不冒充成功**） */
  ok: boolean | null;
  /** 界面新 pid（脚本 `[结束]` 里那一列；0 = 本次不动界面或没读到） */
  guiPid: number;
}

/**
 * **重启确认**（唯一一处）：等脚本的留痕，再把三态判出来。
 *
 * 三条判据各自独立，合起来才敢说"成了"（用户 2026-10-07：「不许用'猜'的确认」）：
 *   ① `[回执]` —— 脚本**跑起来了**吗。读不到就是**没跑**，绝不说"正在重启"；
 *   ② 真实新 pid —— 她真的**换了个人**吗。来源是 `lock.json`（她启动后自己写的）
 *      或脚本那行 `[实例]`；**不是** WMI 返回的那个壳 pid（那是 cmd.exe 的，查无此人）；
 *   ③ 端口 —— 起来了之后**真的能应答**吗。脚本结尾那行给得出就用它；给不出时
 *      （还在等）由服务端自己连一次。
 *
 * 三态之间的区别是这条链路的全部意义（脚本没跑 / 跑了但进程没起 / 起了但端口没就绪）：
 *   · `scriptStarted === false` ⇒ 脚本没跑起来；
 *   · `scriptStarted && ok === false` ⇒ 跑了但失败（pid 或端口那一栏说明是哪一环）；
 *   · `scriptStarted && 新 pid && 端口在服务` ⇒ 成了（哪怕脚本还没写结尾那行——
 *     "她换了 pid 且端口应答"本身就是成品，不是推断）。
 */
function confirmRestart(input: {
  traceLog: string;
  sizeBefore: number;
  guiOnly: boolean;
  previousBackendPid: number;
  host: string;
  port: number;
  dataDir: string;
  /** 等哪一行（见 `waitForScriptReceipt`） */
  markers: readonly string[];
  /**
   * 要不要由服务端自己探一次端口。
   *
   * **`self-restart` 必须关掉它**：那时旧实例（就是本进程）还在监听，
   * 探到的"端口有人在服务"是**旧实例自己**——把它当成"新实例已就绪"就是编事实
   * （用户 2026-10-07：「不许用'猜'的确认」）。这一档的端口结论只能由拉起器写进 `[结束]`。
   */
  probePort: boolean;
}): { receipt: { started: boolean; text: string }; parsed: ReturnType<typeof parseRestartTrace>; confirm: RestartConfirmation } {
  const receipt = waitForScriptReceipt(input.traceLog, input.sizeBefore, input.markers);
  const parsed = parseRestartTrace(receipt.text);
  // 真实新 pid：脚本那两行优先，退到 lock.json（只重启界面时不比基线：那个 pid 本来就该一样）
  let backendPid = parsed.backendPid;
  if (backendPid === 0) {
    const fromLock = readLockPid(input.dataDir);
    if (fromLock !== 0 && (input.guiOnly || fromLock !== input.previousBackendPid)) backendPid = fromLock;
  }
  let port: RestartConfirmation['port'] = parsed.port;
  if (!input.probePort) {
    // 不探：这一档的端口结论只能来自 `[结束]`（读不到就是 unknown，绝不用"我们自己还听着"顶替）
    port = port === 'ready' ? 'ready' : 'waiting';
  } else if (input.guiOnly) {
    // 只重启界面：后端本来就该在服务，端口那一档由服务端自己看
    port = portListening(input.host, input.port) ? 'ready' : 'timeout';
  } else if (port !== 'ready' && backendPid !== 0 && portListening(input.host, input.port)) {
    // 脚本还没到"等端口"那一步，但端口已经在应答了 ⇒ 后端起真的起来了（实测，不是推断）
    port = 'ready';
  }
  const scriptStarted = receipt.started;
  let ok: boolean | null = parsed.ok;
  if (ok === null && scriptStarted && port === 'ready') {
    // 后端换人 + 端口在服务 = 成了（界面那一环没读到时不算失败：脚本会把它写在结尾那行）
    ok = backendPid !== 0 || input.guiOnly;
  }
  return {
    receipt, parsed,
    confirm: { scriptStarted, backendPid, port, ok, guiPid: parsed.guiPid },
  };
}

/**
 * **原始告警 → 它的"已恢复"** 的配对表（`seq` → 恢复那条的说明）。
 *
 * 用户 2026-10-05 的现场：运行情况页最上面那条「预算耗尽（任务 token）：已用 178734979 /
 * 上限 57000000」以"严重"挂了一整天，而它当天就解除了（`budget/resumed{layer:task}` 落了库、
 * `notifier.ok` 也返回成功）。
 *
 * 不配对的根因不是界面：`alarm/sent` 上**除 `recovered` 外没有任何字段**说"这条后来好了"，
 * 于是界面只能把**恢复通知本身**（它带 `recovered: true`）渲染成提示，而**原始那条**照旧是
 * `level: 'critical'`——这正是"旧状态没被解除"的读感来源。
 *
 * 配对用的是数据里本来就有的两个字段（`src/log/types.ts` 的 `AlarmSent`），**不是推断**：
 *
 *   · `key`：故障键（`category:budget-exhausted` 这类）。同一次故障的报警与已恢复**同 key**，
 *     这是 notifier 的既有口径（`foldStalls` 就按它销账）；
 *   · `recovered: true`：这条是恢复通知，不是故障本身。
 *
 * 口径三条：
 *   ① **一次恢复只销一条**（同一个 key 上最早那条还没销的），按日志顺序推进——于是
 *      "报两次、好了一次"仍然剩一条没销的严重告警，与 `foldStalls` 的 count 语义一致；
 *   ② **配对只看它之后**：恢复通知出现在前、原始告警在后（时间倒挂的坏日志）不算数；
 *   ③ **没配对的一律照旧严重**——宁可让一条真没好起来的告警继续红着，
 *      也不许把还没好的事说成"已恢复"（那是造假事实）。
 */
export function pairedRecoveries(events: readonly AppEvent[]): Map<number, string> {
  const pending = new Map<string, number[]>(); // key → 还没被销掉的告警 seq（按出现顺序）
  const paired = new Map<number, string>();
  for (const event of events) {
    if (event.type !== 'alarm/sent') continue;
    const data = event.data;
    // key 是配对用的身份；老日志（没有 key）退回指纹——同类别同参数的告警指纹相同，
    // 仍然配得上；代价是"层"不再参与身份（老日志里 task / daily 会被算作同一个）
    const key = data.key !== undefined && data.key !== '' ? data.key : `fp:${data.fingerprint}`;
    if (data.recovered === true) {
      const original = pending.get(key)?.shift();
      if (original !== undefined) {
        paired.set(original, `已恢复（${event.ts} 的恢复通知，seq ${event.seq}）：${data.title}`);
      }
      continue;
    }
    const list = pending.get(key) ?? [];
    list.push(event.seq);
    pending.set(key, list);
  }
  return paired;
}

/** 总览页的全部数据（frontend.md §3.1：状态机 + 磁贴 + 建议 + 24h 序列） */
export function buildDashboard(input: {
  projection: Projection;
  events: AppEvent[];
  now: Date;
  personaRoot: string;
  /**
   * 申请单目录（`<dataDir>/grants`）：**只有它**能让"她刚写完、还没被拾取"那一小段窗口
   * 在界面上看得见（判据取事件，盘上那份只补这一段，见 `grant/mcp-grant.ts` 的 `listGrants`）。
   * 不给也能算（那一小段窗口就不显示）——所以它是可选参数。
   */
  grantsDir?: string;
}): DashboardView {
  const p = input.projection;
  const nowMs = input.now.getTime();
  const derived = deriveState(p, nowMs);
  const hourly = buildHourlySeries(input.events, nowMs);

  const cacheTotal = p.budget.cacheHitToday + p.budget.cacheMissToday;
  const firstAt = p.firstEventAt === null ? null : parseTs(p.firstEventAt);
  const guardedDays = firstAt === null || !Number.isFinite(firstAt)
    ? null
    : Math.max(0, Math.floor((nowMs - firstAt) / 86_400_000));

  const recent = input.events.slice(-10).map((event) => ({
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    visibility: event.visibility,
    summary: summarizeEvent(event),
  }));

  return {
    generatedAt: input.now.toISOString(),
    state: derived.state,
    stateText: derived.stateText,
    detail: derived.detail,
    stateNote: derived.stateNote,
    guardedDays,
    nextWakeAt: derived.nextWakeAt,
    tiles: {
      watermark: p.watermark,
      pending: p.pending.length,
      tokensToday: p.budget.tokensToday,
      cacheHitRate: cacheTotal > 0 ? p.budget.cacheHitToday / cacheTotal : null,
      needsReview: p.needsReview.length,
      planPending: p.planPending.length,
      failStreak: p.failStreak,
    },
    budget: {
      tokensToday: p.budget.tokensToday,
      heavy: p.budget.tokensTodayHeavy,
      light: p.budget.tokensTodayLight,
      cacheHit: p.budget.cacheHitToday,
      cacheMiss: p.budget.cacheMissToday,
    },
    lastWake: p.lastWake === null ? null : { ...p.lastWake },
    openTurn: p.openTurn === null ? null : { ...p.openTurn },
    lastAssistantText: p.lastAssistantText,
    idleTicks: p.idleTicks,
    degraded: p.degraded === null ? null : { ...p.degraded },
    waitingHuman: p.waitingHuman === null ? null : { ...p.waitingHuman },
    ask: askCardOf(p),
    // 申请单（她递的）：判据取事件，盘上那份只补"还没被拾取"那一段（见 `listGrants` 的注释）
    grants: (() => {
      const items = listGrants(input.grantsDir ?? '', input.events, p.humanAsks);
      return { items, open: items.filter((item) => item.outcome === null && item.picked).length };
    })(),
    deadLetters: p.deadLetters.length,
    suggestions: buildSuggestions(p, input.events, nowMs),
    hourly,
    personaProposals: buildPersonaFiles(input.personaRoot).proposals.length,
    // 空态：一条事件都没有，或只有 session/start（总览页据此换成引导卡）
    empty: p.lastSeq === 0
      || (input.events.length === 1
        && input.events[0]!.type === 'session/start'
        && input.events[0]!.seq === p.lastSeq),
    recent,
  };
}

/**
 * 她在问的卡：按提问先后排好的队列 + 还没答复的总条数（design §6.3「一次只一张，其余排队」）。
 *
 * 判据全部取自投影（它是日志的折叠结果，不另扫日志）：`humanAsks` 里 source 为 agent、
 * 还没被 `human/answered` 出队的那些。`expiredAt` 一并给出来——超时只是"人可能不在"的事实，
 * 卡**不撤**（§6.1），界面据此把"她还在等"这句话说准。
 *
 * 下发条数有上限：dashboard 每十秒被拉一次，而提问条数没有天然上限（一份坏掉的脚本可以让她
 * 连问几十次）。超出部分只计入 `queued`——人答掉前面几张之后，下一拍它们自然浮上来。
 */
const ASK_CARD_MAX = 5;

/**
 * 一张申请单**她发起时**那份内容指纹（`grant/requested.contentHash`）。
 *
 * 为什么执行那一步要把它读回来：批准那一刻要**重算**一次再比（判"这份单子在审阅期间
 * 被改过没有"，照人格提案的 `diffHash` 那条纪律）。读不到（老事件缺这一格）时给空串——
 * 那时判据退化成"不比对内容"，由落地那一步的第二次校验兜住（**宁可照旧执行，也不许
 * 因为读不到凭据就把人批过的事默默丢掉**）。
 */
function requestedHashOf(events: readonly AppEvent[], id: string): string {
  for (const event of events) {
    if (event.type === 'grant/requested' && event.data.id === id) return event.data.contentHash;
  }
  return '';
}

function askCardOf(p: Projection): DashboardView['ask'] {
  const mine = p.humanAsks.filter(ask => ask.source === 'agent');
  return {
    cards: mine.slice(0, ASK_CARD_MAX).map(ask => ({
      seq: ask.seq,
      question: ask.question,
      context: ask.context,
      turn: ask.turn,
      at: ask.at,
      expiredAt: ask.expiredAt,
    })),
    queued: mine.length,
  };
}

// ──────────────────────────────── budget ────────────────────────────────

/**
 * 预算视图。今日/四层判定与 CLI 走**同一个** `buildBudgetReport`（含 BudgetGuard 与加注折叠），
 * 这里只额外做"按天分桶"——那是 7d 视图独有的形状，不属于查询口径。
 */
export function buildBudgetView(input: {
  dataDir: string;
  config: AppConfig;
  /** 只读：这条路上只折叠，不改事件（共享快照直接喂进来，就地改会污染别人） */
  events: readonly AppEvent[];
  now: Date;
  range: 'today' | '7d';
}): BudgetView {
  const report = buildBudgetReport({
    dataDir: input.dataDir,
    budget: input.config.budget,
    events: input.events,
    limitSource: 'file',
  });

  const days = input.range === 'today' ? 1 : 7;
  const dayKeys: string[] = [];
  const dayBuckets = new Map<string, { tokens: number; heavy: number; light: number; hit: number; miss: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(input.now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    dayKeys.push(key);
    dayBuckets.set(key, { tokens: 0, heavy: 0, light: 0, hit: 0, miss: 0 });
  }
  for (const event of input.events) {
    if (event.type !== 'budget/consumed') continue;
    const bucket = dayBuckets.get(event.ts.slice(0, 10));
    if (bucket === undefined) continue;
    // 按天分桶也走**预算口径**（非缓存）：7d 视图与「今日用量」那张卡必须是同一个数
    const total = budgetTokensOf(event.data);
    bucket.tokens += total;
    if (event.data.lane === 'heavy') bucket.heavy += total;
    else bucket.light += total;
    bucket.hit += event.data.cacheHitTokens;
    bucket.miss += event.data.cacheMissTokens;
  }

  // 五档阈值（前端画"距硬阈值进度条"直接读它）
  const limits = {
    stepTools: input.config.budget.stepTools,
    turnSteps: input.config.budget.turnSteps,
    taskTokens: input.config.budget.taskTokens,
    dailyTokens: input.config.budget.dailyTokens,
    softRatio: input.config.budget.softRatio,
  };

  return {
    range: input.range,
    generatedAt: input.now.toISOString(),
    limitSource: report.limitSource,
    metricNote: BUDGET_METRIC_NOTE,
    today: { ...report.today },
    limits,
    dailyTokens: limits.dailyTokens,
    softRatio: limits.softRatio,
    taskTokens: report.taskTokens,
    topUps: { ...report.topUps },
    layers: report.layers.map((layer) => ({ ...layer })),
    hourly: buildHourlySeries(input.events, input.now.getTime()),
    daily: dayKeys.map((key) => ({ date: key, ...dayBuckets.get(key)! })),
    turns: buildTurnRows(input.events),
    month: buildMonth(input.events, input.now),
  };
}

/** 最近 20 个 turn 的明细：预算行合并 + turn/end 的结局。只读聚合，不另存一份账 */
function buildTurnRows(events: readonly AppEvent[], limit = 20): BudgetTurnRow[] {
  interface Acc { input: number; output: number; hit: number; miss: number; durationMs: number; reasonKind: string | null }
  const byTurn = new Map<number, Acc>();
  const ensure = (turn: number): Acc => {
    const existing = byTurn.get(turn);
    if (existing !== undefined) return existing;
    const created: Acc = { input: 0, output: 0, hit: 0, miss: 0, durationMs: 0, reasonKind: null };
    byTurn.set(turn, created);
    return created;
  };
  for (const event of events) {
    if (event.type === 'budget/consumed') {
      const row = ensure(event.data.turn);
      row.input += event.data.inputTokens;
      row.output += event.data.outputTokens;
      row.hit += event.data.cacheHitTokens;
      row.miss += event.data.cacheMissTokens;
      row.durationMs += event.data.durationMs;
    } else if (event.type === 'turn/end') {
      ensure(event.data.turn).reasonKind = event.data.reason.kind;
    }
  }
  return [...byTurn.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([turn, acc]) => {
      const samples = acc.hit + acc.miss;
      return {
        turn,
        input: acc.input,
        output: acc.output,
        hit: acc.hit,
        miss: acc.miss,
        hitRate: samples > 0 ? acc.hit / samples : null,
        durationMs: acc.durationMs,
        reasonKind: acc.reasonKind,
      };
    });
}

/**
 * 本月估算（页脚）：token 累计 / 跨过的 turn 数 / 单次均价。
 * token 走**预算口径**（非缓存，`budgetTokensOf`）——页脚那个数与卡片、趋势线同一套语义。
 */
function buildMonth(events: readonly AppEvent[], now: Date): { tokens: number; turns: number; avgPerTurn: number } {
  const prefix = now.toISOString().slice(0, 7);
  let tokens = 0;
  const turns = new Set<number>();
  for (const event of events) {
    if (event.type !== 'budget/consumed') continue;
    if (!event.ts.startsWith(prefix)) continue;
    tokens += budgetTokensOf(event.data);
    turns.add(event.data.turn);
  }
  return { tokens, turns: turns.size, avgPerTurn: turns.size > 0 ? Math.round(tokens / turns.size) : 0 };
}

// ──────────────────────────────── persona ────────────────────────────────

/** 人格文件相对路径的安全解析：限定 `.md`、拒绝绝对路径与越界 */
/** 告警文件名安全校验：只接受 `data/alarms/` 下的单一文件名（不许目录分隔与相对段） */
function safeAlarmName(raw: string): string {
  const name = raw.trim();
  if (name === '') throw badRequest('缺少 file 参数');
  if (name.includes('\0') || name.includes('/') || name.includes('\\')) {
    throw badRequest('file 只能是 data/alarms/ 下的文件名（不含目录分隔符）');
  }
  if (name === '.' || name === '..') throw badRequest('file 不能是相对路径段');
  return name;
}

function safePersonaRel(rel: string): string {
  const cleaned = rel.trim().replace(/\\/gu, '/');
  if (cleaned === '') throw badRequest('缺少 path 参数');
  if (cleaned.includes('\0')) throw badRequest('路径含非法字符');
  if (isAbsolute(cleaned) || /^[A-Za-z]:/u.test(cleaned)) throw badRequest('path 必须是相对人格根目录的路径');
  if (!cleaned.endsWith('.md')) throw badRequest('人格文件必须是 .md');
  const parts = cleaned.split('/');
  if (parts.some((part) => part === '..' || part === '.')) throw badRequest('path 不允许包含 . 或 ..');
  return parts.join('/');
}

function personaTargetPath(personaRoot: string, rel: string): string {
  const target = resolve(personaRoot, rel);
  const relToRoot = relative(resolve(personaRoot), target);
  if (relToRoot === '' || relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
    throw new HttpError(403, 'forbidden', '路径越界：人格文件必须落在 persona 根目录内');
  }
  return target;
}

/** 人格直编的分区与白名单（GUI 编辑器的后端契约） */
export interface PersonaEditRequest {
  file: string;
  content: string;
}

/** 顶层四个文件属于「系统区」，其余（RELATIONSHIPS/*）属于「档案区」 */
const PERSONA_SYSTEM_FILES = new Set([
  'IDENTITY.md',
  'CONSTITUTION.md',
  'STYLE.md',
  'STATE.md',
]);

/**
 * 校验一次人格直编。规则：
 * - 路径过 safePersonaRel（.md、无 ..、相对人格根）；
 * - 只允许 persona 根下的一级 .md（四个具名文件）或 RELATIONSHIPS/ 下一级 .md；
 * - 拒绝提案目录（PROPOSALS/ 是 agent 的中间产物，不属于直编目标）；
 * - 内容长度上限 64KB（人格是短文本，超了通常是误粘）；非空。
 */
function validatePersonaEdit(payload: Record<string, unknown>): PersonaEditRequest {
  const rawFile = typeof payload['file'] === 'string' ? payload['file'] : '';
  if (rawFile === '') throw badRequest('缺少 file');
  const file = safePersonaRel(rawFile);

  const segs = file.split('/');
  const top = segs[0] ?? '';
  if (top === PERSONA_PROPOSAL_DIR) {
    throw badRequest(`${PERSONA_PROPOSAL_DIR}/ 是 agent 的提案区，不能直编（请用批准/拒绝）`);
  }
  const allowed = segs.length === 1
    ? PERSONA_SYSTEM_FILES.has(file)
    : segs.length === 2 && segs[0] === 'RELATIONSHIPS';
  if (!allowed) {
    throw badRequest(
      '只允许编辑 IDENTITY.md / CONSTITUTION.md / STYLE.md / STATE.md 或 RELATIONSHIPS/<名字>.md',
    );
  }

  const content = typeof payload['content'] === 'string' ? payload['content'] : null;
  if (content === null) throw badRequest('缺少 content');
  if (content.trim() === '') throw badRequest('内容不能为空' + '（人格文件不允许被清空）');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > 64 * 1024) {
    throw badRequest(`内容过大（${bytes} 字节，上限 65536）`);
  }
  return { file, content };
}

interface FileStat {
  bytes: number;
  mtime: string | null;
  content: string | null;
}

/**
 * 工具的入参摘要（名字 + 一句话 + 是否必填）。
 *
 * 为什么不直接把 JSON Schema 丢给界面：那是给模型看的契约，人要看的是
 * 「这件工具能带什么」——比如 speak / report 的 `to`（发给哪个会话）。
 * 之前界面上完全看不到参数，于是「report 有没有 to」只能去翻源码。
 */
function readToolParams(
  schema: Record<string, unknown> | undefined,
): Array<{ name: string; description: string; required: boolean }> {
  if (schema === undefined) return [];
  const props = schema['properties'];
  if (typeof props !== 'object' || props === null) return [];
  const requiredRaw = schema['required'];
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((x): x is string => typeof x === 'string') : [],
  );
  const out: Array<{ name: string; description: string; required: boolean }> = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const desc = typeof raw === 'object' && raw !== null
      ? String((raw as Record<string, unknown>)['description'] ?? '')
      : '';
    out.push({ name, description: desc, required: required.has(name) });
  }
  return out;
}

function statOrNull(path: string): FileStat {  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { bytes: 0, mtime: null, content: null };
    return { bytes: stat.size, mtime: stat.mtime.toISOString(), content: readFileSync(path, 'utf8') };
  } catch {
    return { bytes: 0, mtime: null, content: null };
  }
}

function listProposalFiles(personaRoot: string): string[] {
  const dir = join(personaRoot, PERSONA_PROPOSAL_DIR);
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const path = join(current, name);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (isDir) walk(path, rel);
      else if (name.endsWith('.md')) out.push(rel);
    }
  };
  walk(dir, '');
  return out;
}

export function buildPersonaFiles(personaRoot: string): PersonaFilesView {
  const proposals = listProposalFiles(personaRoot);
  const files: PersonaFileEntry[] = [];

  for (const name of PERSONA_TOP_FILES) {
    const stat = statOrNull(join(personaRoot, name));
    files.push({
      path: name,
      name,
      bytes: stat.bytes,
      mtime: stat.mtime,
      reserved: RESERVED_PERSONA_FILES.has(name),
      tokens: stat.content === null ? 0 : estimateTokens(stat.content),
      proposalCount: proposals.filter((proposal) => proposal === name).length,
      proposals: proposals.filter((proposal) => proposal === name).length,
      isSeed: stat.content !== null && stat.content.includes(SEED_MARKER),
    });
  }

  const relationships: string[] = [];
  const relDir = join(personaRoot, 'RELATIONSHIPS');
  try {
    for (const name of readdirSync(relDir).sort()) {
      if (!name.endsWith('.md')) continue;
      const rel = `RELATIONSHIPS/${name}`;
      relationships.push(name.slice(0, -3));
      const stat = statOrNull(join(personaRoot, rel));
      files.push({
        path: rel,
        name,
        bytes: stat.bytes,
        mtime: stat.mtime,
        reserved: false,
        tokens: stat.content === null ? 0 : estimateTokens(stat.content),
        proposalCount: proposals.filter((proposal) => proposal === rel).length,
        proposals: proposals.filter((proposal) => proposal === rel).length,
        isSeed: false,
      });
    }
  } catch {
    // 关系目录不存在：不是错误（首启由 loader 建，人工删掉也不该让观测页挂掉）
  }

  return { root: personaRoot, files, relationships, proposals };
}

export function readPersonaFileView(personaRoot: string, rel: string): {
  path: string;
  content: string;
  bytes: number;
  mtime: string;
  tokens: number;
  reserved: boolean;
} {
  const safe = safePersonaRel(rel);
  const path = personaTargetPath(personaRoot, safe);
  const stat = statOrNull(path);
  if (stat.content === null) throw notFound(`人格文件不存在：${safe}`, 'persona-file-not-found');
  return {
    path: safe,
    content: stat.content,
    bytes: stat.bytes,
    mtime: stat.mtime ?? '',
    tokens: estimateTokens(stat.content),
    reserved: RESERVED_PERSONA_FILES.has(safe),
  };
}

export function buildPersonaHistory(events: readonly AppEvent[], limit = 200): PersonaHistoryEntry[] {
  const out: PersonaHistoryEntry[] = [];
  for (const event of events) {
    if (event.type !== 'persona/updated') continue;
    out.push({
      seq: event.seq,
      ts: event.ts,
      file: event.data.file,
      by: event.data.by,
      diffHash: event.data.diffHash,
    });
  }
  return out.reverse().slice(0, limit);
}

// ──────────────────────────────── replay ────────────────────────────────

function currentPersonaHashOf(personaRoot: string): string {
  // 复用 loader 的口径（四文件内容 + '\0' 串联的 sha256 前 16 位）。
  // 前提：personaRoot 形如 <dataDir>/persona —— 这是本服务依赖注入的约定（见 deps 注释）。
  try {
    return loadPersona(dirname(resolve(personaRoot))).personaHash;
  } catch {
    return '';
  }
}

/**
 * `MEMORIES/aliases.md` 里的别名（重放用）：读不到就是空表——她还没认过人。
 *
 * 与 CLI 的重放同一条口径（那边是 runtime/replay.ts 的 readAliasesForReplay）：
 * 别名表不在事件里，重放只能取**现在这份**，报告里也如实说了这一点。
 */
function aliasesUnder(dataDir: string): ReadonlyMap<string, SessionAlias> {
  try {
    return parseAliases(readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * 同一份 `aliases.md` 里**群成员那一段**（`裸 id = 名字`）：重放预览要用它。
 *
 * 为什么必须补这一支（2026-10-11，v47 那条线的尾巴）：名字真源有四档（用户手写的联系人表 >
 * 她的会话别名 > 她的**群成员别名** > 群成员档案里那个自动占位名），而重建侧能拿到的只有前三档。
 * 这条预览路径原来只传了前两档（`contacts` + `aliases`），于是**只有群成员别名**的人在这里
 * 解析不出名字 ⇒ 预览的「预警：」「点名：」两行写成裸 openid，而**当时**运行期（`real-loop`
 * 那一侧读同一张表）写的是名字。预览的全部价值就是"她当时到底收到了什么"，
 * 同一句话两个写法等于把复盘证据改掉了——而且不报错。
 *
 * 与 CLI 的重放同一条口径、同一份文件、同一个解析器：那边是 `runtime/replay.ts` 的
 * `readMemberAliasesForReplay`（`parseMemberAliases`），走 `contactFactsForReplay` 的
 * `memberAliases` 入参。判据只有一处（`sessions.ts` 的 `resolvePersonNameFromTables`），
 * 这里只是把第三档**喂进去**——不在这里另写一套查表。
 *
 * 第四档（`data/group-members.json` 的自动占位名）在这一层**拿不到**：它只有运行期那份 host
 * 读盘才有。所以重建侧的名字可能比当时少最后一档，这一条如实记在 `contactFactsForReplay`
 * 的入参注释里，不假装重建过（design §4.13 的重建纪律）。
 */
function memberAliasesUnder(dataDir: string): ReadonlyMap<string, SessionAlias> {
  try {
    return parseMemberAliases(readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8'));
  } catch {
    return new Map();
  }
}

export function buildReplay(input: {
  /** 只读：见 buildBudgetView 的同一句——事件来自共享快照 */
  events: readonly AppEvent[];
  turn: number;
  step: number;
  personaRoot: string;
  config: AppConfig;
  registry: ToolRegistry | null;
}): ReplayView {
  const stepStart = input.events.find(
    (event) => event.type === 'step/start' && event.data.turn === input.turn && event.data.step === input.step,
  );
  if (stepStart === undefined || stepStart.type !== 'step/start') {
    throw notFound(`没有找到 turn ${input.turn} step ${input.step} 的 step/start 事件`, 'replay-not-found');
  }

  const claimed = input.events.find(
    (event) => event.type === 'input/claimed' && event.data.turn === input.turn,
  );
  const wakeSeqs = claimed !== undefined && claimed.type === 'input/claimed' ? claimed.data.wakeSeqs : [];
  const wakeEvent = wakeSeqs.length > 0
    ? [...input.events].reverse().find((event) => event.seq === wakeSeqs[0]) ?? null
    : null;

  const sessionStart = [...input.events].reverse().find((event) => event.type === 'session/start');
  const configHashAt = sessionStart !== undefined && sessionStart.type === 'session/start'
    ? sessionStart.data.configHash
    : '';
  // 本任务相关资产那一行（v34）：**只从事件读**（轮首那条 `memory/selected.assets`）——
  // 与 CLI 的重放（`replay.ts` 的 `assetsFromEvents`）同一个口径。盘上的 `assets.md` 是她
  // 随时会改的文件，从盘上重算就不是"当时那个请求"了；事件里没有（老日志 / 那一轮没挑）
  // 就是空串 = 当时没有那一行。不写这一格，预览会比真实请求少一整行（与 2026-10-05 那次
  // "待办恒为空"是同一类漏：预览自己手拼渲染输入，就一定会漂）。
  const assetsLineAt = (events: readonly AppEvent[], turn: number): string => {
    let found = '';
    for (const event of events) {
      if (event.type !== 'memory/selected' || event.data.turn !== turn) continue;
      const assets = (event.data as { assets?: unknown }).assets;
      if (typeof assets === 'string' && assets.trim() !== '') found = assets;
    }
    return found;
  };

  const persona = loadPersona(dirname(resolve(input.personaRoot)));
  const replayDataDir = dirname(resolve(input.personaRoot));
  // **工具清单恒定**（2026-10-04 用户定稿）：与运行期同一条口径——不再按当轮信任级增减。
  // 清单随场景变会让"它之后那整段历史"的前缀缓存失效（实测同签名 85% vs 换签名 41%），
  // 所以能力收窄挪到了执行期的场景门（runtime/authz.ts）；重建必须跟着一起恒定，
  // 否则复现出来的请求与当时发出去的不是同一份。
  const tools = input.registry === null
    ? []
    : input.registry.listForModel({ includeDestructive: input.config.tools.destructiveEnabled });

  const usageEvents = input.events.filter(
    (event) => event.type === 'budget/consumed'
      && event.data.turn === input.turn && event.data.step === input.step,
  );
  const usageEvent = usageEvents[usageEvents.length - 1];
  const usage = usageEvent !== undefined && usageEvent.type === 'budget/consumed'
    ? {
      lane: usageEvent.data.lane,
      model: usageEvent.data.model,
      inputTokens: usageEvent.data.inputTokens,
      outputTokens: usageEvent.data.outputTokens,
      cacheHitTokens: usageEvent.data.cacheHitTokens,
      cacheMissTokens: usageEvent.data.cacheMissTokens,
      durationMs: usageEvent.data.durationMs,
      finishReason: usageEvent.data.finishReason,
    }
    : null;

  // 任务卡标题：**与运行期、与 CLI 的重建同一处口径**（`wakeTitle`，不是 `summarizeEvent`）。
  // 原来这里用 `summarizeEvent`，而它对 `wake/channel` 落进 default 分支、把整个事件 data
  // **序列化成 JSON** 塞进标题——预览的当前任务因此变成 `{"channel":…}` 一坨机器话，
  // 而真实请求里是 `[external_event …]` 那行人话（agent-loop 的 taskCard 用 wakeTitle）。
  // `summarizeEvent` 是给日志页"一行摘要"用的，不是任务卡口径；两者混用过一次，
  // 代价是预览的任务卡与当时发出去的不是同一串字节。
  const cardTitle = wakeEvent === null ? `turn ${input.turn}` : clipTaskTitle(wakeTitle(wakeEvent));
  const eventsBefore = input.events.filter(
    // 扣掉本轮那条 wake：与运行期同一个契约（首 step 的本轮输入**不在** events 里，见 agent-loop
    // 的协同契约；CLI 的 rebuildRenderedRequest 也是这么过滤的）。不扣就会在重建里出现两遍
    // ——一遍在事件流、一遍在本轮输入（2026-10-02 实测到的重放失真）。
    (event) => event.seq < stepStart.seq && event.seq !== wakeEvent?.seq,
  );
  // 联络事实：与 CLI 的重放共用同一份重建（会话簿/话题折事件，联系人与别名取现在这份）。
  //
  // **会话清单要把本轮那条 wake 一起折**（2026-10-04 补）：`wake/channel` 本身就是一条会话事件
  //（sessions.ts 的 isChannelEvent 认它），运行期是先把它并进会话簿再算 contactFacts 的。
  // 上面那刀把它从事件流里扣掉了，于是预览的「外部会话（想指定对象就用 speak 的 to 填 sid）」
  // 整段消失、只剩"还没有外部会话"——她当时明明有那个会话，预览却说没有。
  // 折进去只影响会话簿/话题这两件"从事件算"的事，不碰 `wakeMessage`（那是另一个字段）。
  const contact = contactFactsForReplay({
    events: wakeEvent === null ? eventsBefore : [...eventsBefore, wakeEvent],
    wakeEvent,
    qqOfficial: input.config.channels.qqOfficial.enabled,
    onebot: input.config.channels.onebot.enabled,
    alertWebhook: (input.config.alerts.webhookUrl ?? '') !== '',
    contacts: new Map(Object.entries(input.config.persona.contacts)),
    aliases: aliasesUnder(replayDataDir),
    // 名字真源的**第三档**（`aliases.md` 的 `# 群成员` 段，裸 id = 名字）：与 CLI 的重放同源
    // （`readMemberAliasesForReplay` → `contactFactsForReplay` 的 `memberAliases`）。
    // 漏了它，只有群成员别名的人在这条预览里写成裸 id，而当时运行期写的是名字（见函数注释）。
    memberAliases: memberAliasesUnder(replayDataDir),
  });
  // **走 `deriveRequest`**（与运行期、与 CLI 的重放同一个函数）：这条路径原来自己手拼渲染输入，
  // 于是少了「会话：」「点名：」这类要从事件/配置算出来的字段——重放出来的请求与当时发出去的不是
  // 同一份，复盘就白做（2026-10-02 修；`asks`/`injection` 也随之由同一个函数从事件算出来）。
  const request = deriveRequest({
    events: eventsBefore,
    persona: {
      identity: persona.identity,
      constitution: persona.constitution,
      style: persona.style,
      state: persona.state,
      personaHash: stepStart.data.personaHash,
    },
    tools: tools.map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
    })),
    wakeEvent,
    taskCard: {
      title: cardTitle,
      turn: input.turn,
      step: input.step,
      // 待办清单：**从她的 STATE 那两节读**，与运行期（agent-loop 的 `taskCard()`）、
      // 与 CLI 的重放（replay.ts 的 `rebuildRenderedRequest`）**同一处实现**。
      //
      // 这一格原来恒为 `[]`：夹具里没有待办，于是"预览比真实请求少整段「未完成计划」"
      // 一直没人发现（2026-10-05 核对时抓到）。待办自 2026-10-04 起只有 STATE 一处载体，
      // 所以这里读的就是 persona.state——预览与真实请求同源，且不新增第二份真相。
      todoOpen: openTodoItems(persona.state ?? ''),
      // 本任务相关资产那一行（v34）：**从事件读**（轮首那条 `memory/selected.assets`），
      // 与 CLI 的重放（replay.ts 的 `assetsFromEvents`）同一个口径——盘上的 `assets.md`
      // 是她随时会改的文件，从盘上重算就不是"当时那个请求"了。
      // 不加这一格，预览会比真实请求少一整行（2026-10-05 那次"待办恒为空"是同一类漏）。
      assets: assetsLineAt(eventsBefore, input.turn),
    },
    now: stepStart.ts,
    timezone: input.config.timezone,
    model: stepStart.data.model,
    lane: stepStart.data.lane,
    // 联络事实：上面按"要把本轮 wake 一起折"的口径算好了，这里只转手
    contact,
    // 豁免判据（2026-10-04 补）：**与运行期、与 CLI 的重放同一处判据**。原来这条预览路径漏了它，
    // 于是对豁免会话，预览里会多出那句规则提示而真实请求没有——"重建与当时逐字节一致"当场作废。
    // dataDir 从 personaRoot 的父目录取，与上面 contactFactsForReplay 的 aliasesUnder 同源
    //（本服务依赖注入的约定：personaRoot 形如 <dataDir>/persona，见 currentPersonaHashOf 的注释）。
    warnExempt: warnExemptJudgeOf(replayDataDir),
    // 记忆索引（**本轮固定块**里那一段，v30 起在块里）：与 CLI 的重建同一条路——**只读**读现在的
    // `MEMORIES/INDEX.md`（重建不建文件，这是那个模块的承诺）。漏了它，预览的固定块里就少索引整段。
    // 2026-10-04 起固定块里关于记忆的**只有**它（用户口径：只看索引，需要就 heavy 自己去读）。
    //
    // **关掉框架代管记忆时给 null**（v32，docs/persona.md §3.1）：判据是 `persona.memoryEnabled`
    // ——与 CLI 的重建（replay.ts 的 `rebuildRenderedRequest` 读同一个字段）、与运行期
    //（real-loop 的 agentDeps）**同一处口径**，三条路谁都不另判一次。盘上那份旧索引留着不管它：
    // 框架不再重建、也不再注入，"预览里还有索引"正是这一行要消掉的那种假象。
    memoryIndex: input.config.persona.memoryEnabled === false
      ? null
      : readMemoryIndexTextReadOnly(replayDataDir),
    // **本轮固定块**（2026-10-04 补）：原来这条预览路径整个漏了它——预览比真实请求少整整一条
    // （`[当前状态]` + 关系档案 + 上面的索引）。装配走与 CLI **同一个函数**，
    // 不在这里另写一份，理由见 turnBlockFactsForReplay 的注释。
    turnBlock: turnBlockFactsForReplay({
      persona: {
        identity: persona.identity,
        constitution: persona.constitution,
        style: persona.style,
        state: persona.state,
        personaHash: persona.personaHash,
        relationship: relationshipForWake(wakeEvent, replayDataDir),
      },
      tools: [],
      timezone: input.config.timezone,
      dataDir: replayDataDir,
    }),
    // 用度是"当时那一刻的累计值"：日志里只有这一 step 自己那笔，所以按它给个下界
    //（此刻层只在告警时才写这一行，重建时给个诚实的近似比给 null 更有用）
    // 口径与运行期同源（`budgetTokensOf`，非缓存）：**预览里那一行必须与当时她那行逐字一样**，
    // 而"一样"的前提是两个数在同一个口径上。
    usage: usage === null ? null : {
      tokensToday: budgetTokensOf(usage),
      dailyLimit: null,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      failStreak: 0,
      failStreakMax: input.config.budget?.failStreakMax ?? null,
    },
    // STATE 预算（v32）：预览要显示的此刻层那一行提醒，阈值取**这次预览用的那份配置**——
    // 与 CLI 重建（replay.ts 从 config.json 读）读的是同一个字段，所以"预览里有没有那一行"
    // 与"她当时看不看得见"不会分岔。
    stateBudgetBytes: input.config.persona.stateBudgetBytes,
  });

  const currentConfigHash = configHash(input.config);
  const currentPersonaHash = currentPersonaHashOf(input.personaRoot);
  return {
    turn: input.turn,
    step: input.step,
    ts: stepStart.ts,
    origin: stepStart.origin ?? null,
    renderVersion: stepStart.data.renderVersion,
    personaHash: stepStart.data.personaHash,
    configHash: configHashAt,
    fingerprints: {
      renderVersion: stepStart.data.renderVersion,
      personaHash: stepStart.data.personaHash,
      configHash: configHashAt,
      currentPersonaHash,
      personaChanged: currentPersonaHash !== stepStart.data.personaHash,
      configChanged: configHashAt !== '' && configHashAt !== currentConfigHash,
    },
    request,
    messages: requestMessages(request),
    usage,
  };
}

/**
 * 请求体的角色视图（页面的角色分色条）：instructions 归 system，input 逐项展开。
 * `request` 本体保持 RenderedRequest 的真相形态不动——多一层展示形状不污染重放证据。
 */
function requestMessages(request: RenderedRequest): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  if (request.instructions !== '') out.push({ role: 'system', content: request.instructions });
  for (const item of request.input) {
    if (item.type === 'message') {
      // 带图的消息在界面上只显示文字部分（base64 塞进预览会把页面拖死），图片留一个占位
      out.push({ role: item.role, content: inputContentText(item.content) });
    } else if (item.type === 'function_call') {
      out.push({ role: 'assistant', content: `[function_call ${item.name}]\n${item.arguments}` });
    } else if (item.type === 'reasoning') {
      // 思维链以 reasoning item 回传（render v3）：排查界面按思维链显示，便于对照模型当时的想法
      out.push({ role: 'reasoning', content: item.content.map((part) => part.text).join('\n') });
    } else {
      out.push({ role: 'tool', content: `[function_call_output ${item.call_id}]\n${item.output}` });
    }
  }
  return out;
}

// ──────────────────────────────── 令牌桶 ────────────────────────────────

interface Bucket {
  tokens: number;
  updatedAt: number;
}

class TokenBucketTable {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
  }

  /** 取一个令牌；不足返回 false（调用方回 429） */
  take(key: string, nowMs: number): boolean {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      if (this.buckets.size >= MAX_WEBHOOK_BUCKETS) {
        // FIFO 淘汰最先插入的一个：桶表只是限流状态，丢一个的代价是"那个源重新拿到满桶"
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      bucket = { tokens: this.capacity, updatedAt: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsedSec = Math.max(0, nowMs - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    bucket.updatedAt = nowMs;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }
}

// ──────────────────────────────── 服务实现 ────────────────────────────────

interface WebhookRate {
  capacity: number;
  refillPerSec: number;
}

class WebServerImpl implements WebServer {
  readonly server: Server;
  readonly auth: AuthStore;

  private readonly deps: WebServerDeps;
  private readonly write: (line: string) => void;
  private readonly host: string;
  private readonly portWanted: number;
  private readonly configPath: string;
  private readonly recent: RecentEventView;
  private readonly buckets: TokenBucketTable;
  private readonly sseClients = new Set<ServerResponse>();
  /** webhook 专用凭据（B9）：`/webhook/*` 的唯一判据，与 `auth` 互不通用 */
  readonly webhookSecret: WebhookSecretStore;

  /** 已广播到的 seq：SSE 只推"新"事件，历史由 /api/events 拉 */
  private pumpedSeq = 0;
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listening = false;
  private closed = false;
  /** webhook 桶表的上一拍时刻，用于惰性回填（这里不用，回填在 take 里逐桶做） */
  private readonly webhookRate: WebhookRate;
  /**
   * 上一次把"webhook 被拒"写进诊断输出的时刻（毫秒）：**限流日志，不是限流请求**。
   *
   * 为什么需要它：这条通道的门是**未认证**的，本机任何程序都能反复敲。每一次都写一行
   * `[webhook] 拒绝…` 等于给了本地进程一个"刷用户的日志文件"的把手（磁盘与信噪比都吃亏）。
   * 60 秒一条足够让排障的人看见"有个老脚本还在用会话凭据"，又不至于把日志淹掉。
   */
  private lastWebhookRejectLogAt = 0;

  constructor(deps: WebServerDeps) {
    this.deps = deps;
    this.write = deps.out ?? ((line) => console.log(line));
    this.host = deps.host ?? '127.0.0.1';
    this.portWanted = deps.port ?? 0;
    this.configPath = deps.configPath ?? join(process.cwd(), CONFIG_FILE_NAME);
    this.recent = new RecentEventView(deps.log, DASHBOARD_EVENT_WINDOW);
    const rate = deps.webhookRate ?? DEFAULT_WEBHOOK_RATE;
    this.webhookRate = { capacity: rate.capacity, refillPerSec: rate.refillPerSec };
    this.buckets = new TokenBucketTable(this.webhookRate.capacity, this.webhookRate.refillPerSec);

    // 认证库：注入了就用注入的（测试），否则读盘自建。
    // `uiToken` 只在自建那条路上起作用——判据只有一份，在 AuthStore 里。
    this.auth = deps.auth ?? new AuthStore({
      dataDir: deps.dataDir,
      now: deps.now,
      out: this.write,
      ...(deps.uiToken !== undefined ? { legacyToken: deps.uiToken } : {}),
    });
    if (this.auth.initialized) {
      this.write('[认证] 已设密码；界面用密码登录，凭据存在 data/.auth.json');
    } else if (this.auth.legacyTokenActive) {
      this.write('[认证] 还没设密码：界面第一次打开会让你设一个。旧的 data/.ui-token 现在仍然可用，设完密码即作废');
    } else {
      this.write('[认证] 还没设密码：界面第一次打开会让你设一个');
    }

    // webhook 专用凭据（B9）：注入了就用注入的（测试），否则读盘自建。
    // **绝不自动生成**：没有外部投递方时它只是一份凭空多出来的秘密（见 webhook-secret.ts）。
    this.webhookSecret = deps.webhookSecret ?? new WebhookSecretStore({
      dataDir: deps.dataDir,
      now: deps.now,
      out: this.write,
    });
    if (this.webhookSecret.configured) {
      this.write(`[webhook] /webhook/* 认专用凭据 ${this.webhookSecret.secretId}（${WEBHOOK_SECRET_FILE_NAME}）：界面会话凭据与 .ui-token 在这条通道上一律 401`);
    } else {
      this.write(`[webhook] 还没生成 webhook 专用凭据：/webhook/* 现在一律 401。要投递先按一次「生成」（POST /api/commands/regenerate-webhook-token），凭据会写在 ${WEBHOOK_SECRET_FILE_NAME}`);
    }

    this.pumpedSeq = deps.log.latestSeq();
    this.server = createServer((req, res) => {
      // route 自己已经兜住所有错误；这里只防水位线以下的意外（同步抛在 route 之外）
      void this.route(req, res).catch((err: unknown) => {
        if (!res.headersSent) sendError(res, 500, 'internal', describeError(err));
        else res.end();
      });
    });
  }

  // ── 生命周期 ──

  /**
   * 让位：`self-restart` 那一条走到"旧实例该退出了"时的那一下。
   *
   * 这条路径上**只有本进程能证明"它已经让位了"**：单实例锁与监听端口都只允许一个用户，
   * 而新实例是拉起器在本进程**真的消失之后**才拉起来的（见 `runtime/restart-worker.ts`）。
   * 所以这里要的是"走既有退出路径"，而不是任何形式的硬杀：
   *
   *   ① 宿主注入了 `onRestartExit` ⇒ 用它（测试用；生产环境的宿主没接）；
   *   ② 否则有 `SIGTERM` 监听者（`main.ts` 在 `runMain` 里一定装了）⇒ 触发那一条既有信号路径：
   *      `stop('signal','SIGTERM')` —— 停源 → 关 web → 落 `session/end` → 收尾 → **放锁**；
   *   ③ 两条都没有（比如 CLI/测试里没装信号处理器）⇒ 如实说一声再退：
   *      留痕里写清"没有优雅退出路径可走"，锁会由下一次启动按 `pid-gone` 接管——
   *      **不假装自己优雅退出了**（这一条与"不许用猜的确认"是同一条纪律）。
   */
  requestGracefulRestartExit(path: RestartPath): void {
    const injected = this.deps.onRestartExit;
    if (injected !== undefined) {
      try {
        injected(path);
      } catch (err) {
        this.write(`[重启] 让位回调抛错（${path}）：${describeError(err)}`);
      }
      return;
    }
    const emitter = process as unknown as {
      listenerCount: (event: string) => number;
      emit: (event: string) => boolean;
    };
    if (emitter.listenerCount('SIGTERM') > 0) {
      this.write('[重启] self-restart：让位——走既有退出路径（SIGTERM → 停源/关 web/session:end/放锁）');
      emitter.emit('SIGTERM');
      return;
    }
    this.write('[重启] self-restart：让位——这个进程没有优雅退出路径可走（没有 SIGTERM 监听者），'
      + '直接退出；单实例锁会由下一次启动按 pid-gone 接管');
    process.exit(0);
  }

  async listen(): Promise<void> {
    if (this.listening) return;
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: unknown): void => {
        rejectListen(err instanceof Error ? err : new Error(String(err)));
      };
      this.server.once('error', onError);
      this.server.listen(this.portWanted, this.host, () => {
        this.server.off('error', onError);
        resolveListen();
      });
    });
    this.listening = true;

    const pollMs = this.deps.ssePollMs ?? SSE_POLL_MS;
    this.pumpTimer = setInterval(() => {
      this.pump();
    }, pollMs);
    this.pumpTimer.unref?.();
    this.heartbeatTimer = setInterval(() => {
      for (const client of this.sseClients) client.write(': hb\n\n');
    }, SSE_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  port(): number {
    const address = this.server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  url(): string {
    return `http://${this.host}:${this.port()}`;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pumpTimer !== null) clearInterval(this.pumpTimer);
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.pumpTimer = null;
    this.heartbeatTimer = null;
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        /* 已经断开的连接不必再管 */
      }
    }
    this.sseClients.clear();
    if (!this.listening) return;
    await new Promise<void>((resolveClose) => {
      this.server.close(() => resolveClose());
      // 保持连接（SSE/keep-alive）会让 close 一直挂着：强制收掉
      this.server.closeAllConnections?.();
    });
    this.listening = false;
  }

  // ── SSE 尾部轮询 ──

  private pump(): void {
    const latest = this.deps.log.latestSeq();
    if (latest <= this.pumpedSeq) return;
    const from = this.pumpedSeq + 1;
    for (let seq = from; seq <= latest; seq++) {
      const event = this.deps.log.get(seq);
      if (event === null) continue; // 崩溃留下的 seq 空洞：跳过，不是错误
      this.broadcast(event);
    }
    this.pumpedSeq = latest;
  }

  private broadcast(event: AppEvent): void {
    if (this.sseClients.size === 0) return;
    const frame = `event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  // ── 路由 ──

  /** 路由壳：任何 HttpError 都在这里落成 `{error:{code,message}}` + 对应状态码 */
  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.dispatch(req, res);
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* 连接已断：错误报告本身也送不出去了 */
        }
        return;
      }
      if (err instanceof HttpError) sendError(res, err.status, err.code, err.message);
      else sendError(res, 500, 'internal', describeError(err));
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers['host'] ?? '127.0.0.1'}`);
    } catch {
      throw badRequest('请求 URL 无法解析');
    }

    const pathname = url.pathname;
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await this.handleApi(req, res, url);
      return;
    }
    if (pathname === '/webhook' || pathname.startsWith('/webhook/')) {
      await this.handleWebhook(req, res, url);
      return;
    }

    // 这里过去是静态资源分支（`/` → `web/index.html`）。`web/` 已整个删除（2026-10）：
    // 这个框架的正式产品只有 GUI，服务端不再吐任何文件。剩下的路径统一回一句**人话**——
    // 一个莫名其妙的 404 会让人以为是"服务没起来"，而事实是"这里从来就没有网页"。
    sendError(
      res,
      404,
      'no-web-ui',
      '本框架不提供网页界面；桌面界面请用 GUI。',
    );
  }

  // ── /api ──

  /**
   * `/api/*` 的认证闸 + 认证端点分流。
   *
   * **待初始化态只放行一条路**：`POST /api/auth/setup`（首次设密码）。除此之外，
   * 所有 `/api/*` 一律 401 并把话说明白（`auth-uninitialized`：还没设密码，请先在界面里设置）——
   * 让人对着一个"缺少或无效的 Bearer token"猜半天，是这类门最没品的失败方式。
   *
   * 界面据此**不需要第二条探测通道**：它随便打一条读端点，401 的 `code` 就告诉了它是
   * "该设密码"还是"该登录"（见 gui/lib/api.dart 的 ApiAuthError.code）。
   */
  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;

    // 认证端点先行：它们在"未认证"这件事上各有各的规矩
    if (path === '/api/auth/setup' || path === '/api/auth/login'
      || path === '/api/auth/logout' || path === '/api/auth/password') {
      await this.handleAuth(req, res, path);
      return;
    }

    // 过去 SSE 在 `?token=` 上开了个后门（EventSource 设不了自定义头）。**现在没有了**：
    // 网页界面整个删掉之后，这条后门的唯一理由（浏览器 EventSource）也不存在了；
    // GUI 用的是 HttpClient，本来就能带 Authorization 头。凭证出现在 URL 里会被各处日志
    // 顺手记下来，能关掉就关掉。
    //
    // 判据只有 `AuthStore.authenticate` 一处（`/webhook/*` 走的是**另一份**凭据，
    // 见 `webhook-secret.ts`）：没有凭据就喂一个空串，
    // 它会如实回答"还没设密码"还是"凭据无效"——这两句话对应界面上的两种门。
    //
    // **webhook 专用凭据进不来这里**（B9）：两份凭据的权限是单向的，它能投事件但读不到
    // 任何东西。反方向的拒绝在 handleWebhook 里，两边都不是"顺带"，是各自的门规。
    const verdict = this.auth.authenticate(bearerOf(req) ?? '');
    if (!verdict.ok) {
      if (verdict.reason === 'uninitialized') {
        this.sendAuthError(res, 401, 'auth-uninitialized', '这台实例还没设密码。请先在界面里设置一个密码。');
        return;
      }
      // 凭据旧了/被撤销了（改了密码、登出过、另一台实例顶掉了）。让界面能分辨这一种，
      // 它才会去重读凭据文件并重试一次（见 gui 的 401 自愈）。
      this.sendAuthError(res, 401, 'unauthorized', '缺少或无效的会话凭据（可能改过密码或已登出）。请重新登录。');
      return;
    }

    // 写命令先分流：路径对了但方法不对应该是 405（而不是"未知接口"）——
    // "这个地址存在，但不是 GET"与"没这个地址"是两件事
    if (path.startsWith('/api/commands/')) {
      if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', '写命令只接受 POST');
      await this.runCommand(path.slice('/api/commands/'.length), req, res);
      return;
    }

    // 技能删除（扩展页 · 技能 · 删除）：技能的读口是 `GET /api/skills`，删除是**同一个对象**的写口，
    // 所以挂在同一条路径的子路径上，而不是另开一族地址。它复用 `/api/commands/*` 那套的**全部**
    // 语义（X-Confirm 危险短语、body 解析、错误形状），因此这里只做"路径 → 命令名"的转接：
    // 实现只有 runCommand 里那一份，不抄第二遍。方法不对就是 405——"这个地址存在，只是不接受 GET"。
    if (path === '/api/skills/remove') {
      if (req.method !== 'POST') {
        throw new HttpError(
          405,
          'method-not-allowed',
          '删除技能只接受 POST /api/skills/remove（头里要带 X-Confirm: skill-remove）',
        );
      }
      await this.runCommand('skill-remove', req, res);
      return;
    }

    // 内置协议端（v34）：一条读、两条启停、一条写配置。三条**共用同一份视图**
    // （buildProtocolSideView）——分开各拼一份响应，界面上的状态与刚做完的动作迟早对不上。
    // 它不走 /api/commands：那套是"事件日志写命令 + X-Confirm 危险短语"的通道，而这里的
    // 动作不写事件（启停一个外部进程不是 agent 的状态，与 set-key / dep-install 同一条理由），
    // 写配置那一半走 withConfigDoc（它自己会落 config/changed）。
    if (path === '/api/protocol-side' || path.startsWith('/api/protocol-side/')) {
      await this.handleProtocolSide(req, res, path);
      return;
    }

    if (req.method === 'GET') {
      switch (path) {
        case '/api/projection':
          sendJson(res, 200, this.deps.projection);
          return;
        case '/api/stats/dashboard': {
          const events = await this.recent.sync();
          sendJson(res, 200, buildDashboard({
            projection: this.deps.projection,
            events,
            now: this.deps.now(),
            personaRoot: this.deps.personaRoot,
            grantsDir: grantsDirOf(this.deps.dataDir),
          }));
          return;
        }
        /**
         * 申请单那一屏（扩展页「待批」段与顶层批准卡的数据源）。
         *
         * 为什么另开一个端点而不是只放在 dashboard 里：这份清单**每次现读**（判据取事件 +
         * 盘上那段窗口），而 dashboard 是十秒一拉的宽屏；待批那段要在**人点完批准之后**
         * 立刻消失（不能等下一次轮询），所以界面对它单独拉一次。
         * 两个端点共用 `listGrants`（一处实现，两处读同一份字节）。
         */
        case '/api/grants': {
          const items = listGrants(
            grantsDirOf(this.deps.dataDir),
            await readAllEvents(this.deps.log),
            this.deps.projection.humanAsks,
          );
          sendJson(res, 200, {
            items,
            open: items.filter((item) => item.outcome === null && item.picked).length,
            dir: grantsDirOf(this.deps.dataDir),
            resolvedDir: grantsResolvedDirOf(this.deps.dataDir),
          });
          return;
        }
        case '/api/events':
          sendJson(res, 200, await this.listEvents(url));
          return;
        case '/api/events/stream':
          this.openStream(req, res, url);
          return;
        case '/api/budget':
          sendJson(res, 200, await this.budgetView(url));
          return;
        // 管控页的配置读取：默认返回**生效配置本体**（前端按点路径取值）；
        // 指纹放在响应头里，保证响应体形状与 config.json 的语义一一对应。
        //
        // `?source=saved` 返回**盘上那份**（2026-10-04 加）：设置页要编辑的是"我保存下来的值"，
        // 不是"现在跑着的值"——两者在"改完要重启才生效"时本来就不同，而过去只有一个来源，
        // 于是人一按保存，界面立刻回读生效配置，把刚写下去的值冲掉（用户报的
        // 「编辑后点保存，前端又会弹回默认的 url」）。盘上那份额外带一个 `$pending` 字段：
        // 哪些字段与生效值不同（= 还没生效），界面据此把话说准。
        //
        // 为什么不把默认那条也改成盘上那份：`/api/config` 另有使用者（引导、频道页、
        // 「她怎么被称呼」），它们问的都是"现在按什么跑"——生效配置才是对的答案。
        case '/api/config': {
          res.setHeader('x-config-hash', configHash(this.deps.config));
          if (url.searchParams.get('source') !== 'saved') {
            sendJson(res, 200, this.deps.config);
            return;
          }
          const saved = this.readSavedConfig();
          res.setHeader('x-config-source', saved.source);
          const pending = saved.source === 'saved'
            ? diffConfigFields(this.deps.config, saved.config)
            : [];
          sendJson(res, 200, {
            ...saved.config,
            $pending: { source: saved.source, restartRequired: pending },
          });
          return;
        }
        // 设置页 · 模型分区：每个受管密钥「配没配」+ 掩码。形状固定为 { configured, mask }——
        // 值永不出这个进程（掩码由 config/keys.ts 的 maskKey 给，短值整体打码）。
        case '/api/keys':
          sendJson(res, 200, this.keysView());
          return;
        // 设置页 · 外部回调：webhook 专用凭据的**状态**（配没配、哪一份、什么时候生成的）。
        //
        // 它刻意不是 `/api/commands/*` 的一员：那套通道的语义是"写一条事件日志"，
        // 而这是一条只读端点（与 `/api/keys` 同形）。**响应里绝不含凭据原文，也不含哈希**——
        // 原文只在生成响应的那一次出现。界面靠 `configured` 决定按钮写「生成」还是「重新生成」。
        case '/api/webhook-secret':
          sendJson(res, 200, {
            ...this.webhookSecret.view(),
            channel: '/webhook/*',
            header: 'Authorization: Bearer <token>',
            command: 'regenerate-webhook-token',
          });
          return;
        // 设置页 · 外部依赖卡片（v30）：三件外部依赖的探测结果、建议动作、自装目录路径。
        // 它读的是与 rg_search/es_search/pwsh 同一份缓存结论——界面上看到的"已就绪"
        // 就是工具真的会用的那个可执行文件
        case '/api/deps':
          sendJson(res, 200, await this.depsView());
          return;
        // 工具组的不变量自检（与 CLI 的 doctor 命令同一个 runDoctor）
        case '/api/doctor': {
          const report = await runDoctor(this.deps.dataDir);
          sendJson(res, 200, {
            dataDir: report.dataDir,
            events: report.events,
            badLines: report.badLines,
            failures: report.failures,
            skips: report.skips,
            items: report.checks.map((check) => ({
              id: check.id,
              title: check.title,
              status: check.status,
              ok: check.status === 'ok',
              detail: check.detail,
            })),
          });
          return;
        }
        case '/api/persona/files':
          sendJson(res, 200, buildPersonaFiles(this.deps.personaRoot));
          return;
        case '/api/persona/file': {
          const rel = url.searchParams.get('path');
          if (rel === null) throw badRequest('缺少 path 查询参数（如 ?path=IDENTITY.md）');
          sendJson(res, 200, readPersonaFileView(this.deps.personaRoot, rel));
          return;
        }
        case '/api/persona/history':
          sendJson(res, 200, { entries: buildPersonaHistory(await readAllEvents(this.deps.log)) });
          return;
        case '/api/replay':
          sendJson(res, 200, await this.replayView(url));
          return;
        // 插件页 · 技能 tab：技能目录 + 信任门裁决（与 CLI 的 `irmia skill list` 同一份 SkillManager）
        // `?rescan=1` 是界面上「扫描目录」按钮的语义（本来就每次现扫，这个参数只是把意图说出口）
        case '/api/skills':
          sendJson(res, 200, await this.skillsView({ rescan: url.searchParams.get('rescan') === '1' }));
          return;
        // 插件页 · MCP tab：配置里声明了什么 + 运行期状态（从 mcp/* 事件折叠）
        case '/api/mcp':
          sendJson(res, 200, await this.mcpView());
          return;
        // 插件页 · Hook tab：data/hooks.json 的真实解析结果（agent 不可改，见 protectedHookPaths）
        //
        // 「能不能改」与「改完什么时候生效」是两件事：这里如实给出 enabled（界面据此画开关），
        // 而生效时机是**进程重启**——HookRunner 在启动时装配一次（main.ts），
        // 这份文件不在热更白名单里，所以界面上写"需重启"，不假装即时生效。
        case '/api/hooks': {
          const file = hookConfigPath(this.deps.dataDir);
          const loaded = loadHookConfig(file);
          sendJson(res, 200, {
            file,
            relative: `data/${HOOK_CONFIG_FILE_NAME}`,
            exists: loaded.exists,
            entries: loaded.entries.map((entry, index) => ({
              index,
              hook: entry.hook,
              matcher: entry.matcher,
              command: entry.command,
              timeoutMs: entry.timeoutMs,
              enabled: entry.enabled !== false,
              ...(entry.if !== undefined ? { if: entry.if } : {}),
            })),
            problems: loaded.problems,
            readOnlyForAgent: protectedHookPaths(this.deps.dataDir),
            hookPoints: [...HOOK_POINTS],
            defaultTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
            // 停用 = 留在文件里但不装配：界面据此把"几条在跑"说清楚
            enabledCount: loaded.entries.filter((entry) => entry.enabled !== false).length,
            disabledCount: loaded.entries.filter((entry) => entry.enabled === false).length,
          });
          return;
        }
        // 数据与日志页 · 日志 tab：<dataDir>/alarms/ 的文件清单与内容（告警落盘，operations.md §2）
        case '/api/alarms':
          sendJson(res, 200, this.alarmsView(url));
          return;
        // 记忆页：workspace/MEMORIES/ 的真实内容（facts 分区 + 其它文件 + episodes/diary 清单）
        case '/api/memory':
          sendJson(res, 200, this.memoryView(url));
          return;
        // 频道页 · 会话联系人：见过的会话（会话簿）+ 现在给它们起了什么名字
        case '/api/sessions':
          sendJson(res, 200, await this.sessionsView());
          return;
        // 运行情况页 · 框架提示（v33）：框架最近替她留意的两类事——外部消息里的注入迹象、
        // 它自己发出的告警。与「外部会话」分两条端点：那是"她那边积累了什么"，
        // 这是"框架看到了什么"——后者可能一条都没有，而两份数据没有共同的生命周期
        case '/api/framework-notes':
          sendJson(res, 200, await this.frameworkNotesView(url));
          return;
        // 插件页 · 工具行为 tab：注册表里的工具清单（三属性徽章的来源）
        case '/api/tools': {
          const registry = this.deps.registry;
          const names = registry?.names() ?? [];
          const disabled = new Set(registry?.disabledNames() ?? []);
          sendJson(res, 200, {
            count: names.length,
            enabledCount: names.length - disabled.size,
            destructivePolicy: this.deps.config.tools.destructiveEnabled,
            // 分组的唯一清单在 tools/groups.ts：内置归一组，MCP 按服务各自成组
            groups: groupsForTools(names).map((group) => ({ id: group.id, label: group.label, note: group.note })),
            tools: names.map((name) => {
              const def = registry?.get(name) ?? null;
              return {
                name,
                group: groupIdOfTool(name),
                enabled: !disabled.has(name),
                description: def?.description ?? '',
                sideEffect: def?.sideEffect ?? 'none',
                executionMode: def?.executionMode ?? 'exclusive',
                timeoutMs: def?.timeoutMs ?? 0,
                fromMcp: name.startsWith(MCP_NAME_PREFIX),
                // 参数名与说明：界面上得看得出"这件工具能带什么"——比如 speak/report 的 `to`。
                // 只给名字与一句话，不给完整 JSON Schema：那属于源码，界面要的是"能干什么"。
                parameters: readToolParams(def?.parameters),
              };
            }),
          });
          return;
        }
        default:
          throw notFound(`未知接口：GET ${path}`, 'unknown-endpoint');
      }
    }

    throw notFound(`未知接口：${req.method ?? '?'} ${path}`, 'unknown-endpoint');
  }

  /**
   * 外部依赖报告（设置页 · 外部依赖卡片的数据源，v30）。
   *
   * 形状刻意"每一行都自解释"：`label`（人认识的名字）、`status`（徽章三态）、
   * `path`/`version`（探测到什么）、`impact`（**没装会怎样**——用户点名要"显式告知建议安装"，
   * 而建议只有在说清代价之后才成立）、`action`（一键装 / 只提示 / 已就绪）、`attempts`（试过哪几处）。
   *
   * 不在这里重新探测：`report()` 读的是管理器缓存，与 rg_search/es_search/pwsh 用的是同一份结论。
   */
  private async depsView(): Promise<Record<string, unknown>> {
    const manager = this.deps.deps;
    if (manager === undefined) {
      return {
        available: false,
        reason: '本进程没有注入外部依赖管理器（WebServerDeps.deps 缺省）：'
          + '无法报告 pwsh / rg / es 的状态，也无法一键安装。',
        entries: [],
      };
    }
    const report = await manager.report(() => this.deps.now());
    return {
      available: true,
      dataDir: report.dataDir,
      toolsDir: report.toolsDir,
      needsAttention: report.needsAttention,
      generatedAt: report.generatedAt,
      entries: report.entries,
    };
  }

  // ──────────────────────── 内置协议端（可选开启的内置服务，v34） ────────────────────────

  /**
   * 协议端的三条路由。
   *
   * 为什么**不挂在 `/api/commands/*`**：那套通道的语义是"写一条事件日志 + 可能带 X-Confirm
   * 危险短语"。而启停一个外部进程**不写任何事件**（与 set-key / dep-install 同一条理由：
   * 事件日志是唯一真相源，schema 里没有对应事件类型的近似事件就是脏数据），
   * 写配置那一半则走 `withConfigDoc`（它自己会落 `config/changed`）。形状不对就是 405：
   * "这个地址存在，但不是这个用法"与"没这个地址"是两件事。
   */
  private async handleProtocolSide(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path === '/api/protocol-side') {
      if (req.method !== 'GET') {
        throw new HttpError(
          405,
          'method-not-allowed',
          '状态只接受 GET；启停用 POST /api/protocol-side/start|stop，写配置用 PUT /api/protocol-side/config',
        );
      }
      sendJson(res, 200, await this.buildProtocolSideView(this.readSavedOnebot(), null));
      return;
    }
    if (path === '/api/protocol-side/start' || path === '/api/protocol-side/stop') {
      if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', `${path} 只接受 POST`);
      // 请求体读掉（内容不用，但必须消费）：keep-alive 上不读干净，下一条请求会读到残留
      await readBody(req, DEFAULT_BODY_LIMIT_BYTES);
      await this.runProtocolSideAction(path.endsWith('/start') ? 'start' : 'stop', res);
      return;
    }
    if (path === '/api/protocol-side/config') {
      if (req.method !== 'PUT') throw new HttpError(405, 'method-not-allowed', '写配置只接受 PUT');
      await this.writeProtocolSideConfig(req, res);
      return;
    }
    if (path === '/api/protocol-side/install') {
      if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', '安装只接受 POST');
      // 请求体读掉（内容不用，但必须消费）：keep-alive 上不读干净，下一条请求会读到残留
      await readBody(req, DEFAULT_BODY_LIMIT_BYTES);
      await this.runProtocolSideInstall(res);
      return;
    }
    throw notFound(`未知接口：${req.method ?? '?'} ${path}`, 'unknown-endpoint');
  }

  /**
   * 一键装协议端：从**官方 Releases** 代下载 lite 包 → 解压到固定的家 → 复检入口在不在。
   *
   * 用户要的是"引导客户安装 snowluma，尽量少让对方配置"，所以这一步把"找 release、下 zip、
   * 解压"三步手工压成一次点击。**包从官方拿、不随框架分发、一个字节不改**——许可 §3 允许
   * 再分发（非商业、附完整许可、不改声明），我们连再分发都算不上；包里自带 LICENSE/EULA，
   * 随包落地正好满足"附完整许可文本"。
   *
   * **刻意不在这里顺手写配置**：写配置有它自己那条路（`PUT /api/protocol-side/config`，
   * 带 `withConfigDoc` 的校验与回滚）。一个端点做两件有副作用的事，出错时说不清是哪一件坏的；
   * 界面按顺序调两次，每一步的成败都能如实告诉人。
   */
  private async runProtocolSideInstall(res: ServerResponse): Promise<void> {
    const lines: string[] = [];
    const outcome = await installSnowLuma({
      dataDir: this.deps.dataDir,
      onProgress: (line) => { lines.push(line); },
    });
    sendJson(res, 200, {
      ok: outcome.ok,
      dir: outcome.dir ?? null,
      version: outcome.version ?? null,
      detail: outcome.detail,
      log: lines,
    });
  }

  /**
   * 手动启停。
   *
   * 三条口径：
   *   · **幂等**：已经在跑再点 start、没跑点 stop，都返回当前状态而不是报错（`changed: false`
   *     让界面能把"点了但什么也没发生"如实说出来，而不是弹一个绿 toast 骗人）。
   *   · **只动协议端，不碰 OneBot 适配器**：适配器是独立的长连接，它自己会重连。
   *     顺手把它停掉等于把"协议端重启一下"升级成"通道掉线且不再回来"——那是两件事。
   *   · **没有实例时如实拒绝并说清为什么**（返回 200 + note，不是 500）：OneBot 适配器是
   *     **启动时**按当时的配置建的，此刻现拉一个协议端，它开的端口没有任何人去连——
   *     界面会显示"已就绪"而消息一条都不来，比明说"要重启"坏得多。
   */
  private async runProtocolSideAction(action: 'start' | 'stop', res: ServerResponse): Promise<void> {
    const host = this.deps.protocolSide;
    if (host === undefined) {
      sendJson(res, 200, await this.buildProtocolSideView(this.readSavedOnebot(), {
        action,
        changed: false,
        note: '本进程启动时没有装配内置协议端（这段配置是启动之后才写下的）：重启进程后它才会被接管。'
          + '在那之前，OneBot 适配器连的是配置里手填的地址与密钥。',
      }));
      return;
    }

    const before = (await host.status()).state;
    let after: ManagedServiceStatus;
    let changed = false;
    let note: string;
    try {
      if (action === 'start') {
        after = await host.start();
        changed = after.state !== before;
        if (after.state === 'ready') {
          const wsUrl = after.endpoint?.wsUrl ?? '';
          note = before === 'ready' ? '它已经在跑了（没有重复拉起）' : `已拉起，OneBot 在 ${wsUrl}`;
        } else if (after.state === 'not-installed') {
          note = '没找到可执行入口：先从 Releases 下载发行包解压，再把那个目录填到上面的「安装目录」。';
        } else if (after.state === 'failed') {
          // 「再点一次启动」在服务层是**不起作用**的（start() 见到已有子进程就直接返回），
          // 所以这里必须给出唯一能走通的那条路，而不是让人对着同一个失败重复点按钮
          note = '没能拉起来（或者它已经在了但端口一直没通）：原因见下面的状态说明。'
            + '要重来一次，先点「停止」再点「启动」——服务层见到已有子进程会直接返回，重复点「启动」不会有任何动作。';
        } else {
          note = `当前状态：${PROTOCOL_STATE_TEXT[after.state] ?? after.state}`;
        }
      } else {
        if (before === 'stopped' || before === 'not-installed') {
          // 已经没在跑就别再去调 stop()：服务层的 stop() 会把状态改写成 "stopped"，
          // 那会把 `not-installed` 这条**给人指路的诊断**（"先去下载"）一起抹掉。
          after = await host.status();
          changed = false;
          note = '它本来就没在跑。';
        } else {
          await host.stop();
          after = await host.status();
          changed = true;
          // 说清"接下来会看到什么"：适配器还在重连，日志里必然出现连不上——
          // 那是预期行为，不是故障（不说的话下一个人会去查一个根本没坏的东西）
          note = '已停止（连同它的子进程一起收掉）。OneBot 适配器没有被停——它会自己重连，'
            + '日志里会看到连不上，那是预期。';
        }
      }
    } catch (err) {
      // 启停异常**不当成 HTTP 错误**：服务层已经把结论写进它自己的状态（那是给人看的原文），
      // 这里只补一句"这次动作抛了"，界面把两份都显示出来就够定位了
      const reason = describeError(err);
      this.write(`[协议端] ${action} 异常：${reason}`);
      sendJson(res, 200, await this.buildProtocolSideView(this.readSavedOnebot(), {
        action,
        changed: false,
        note: `${action === 'start' ? '启动' : '停止'}时抛了异常：${reason}`,
      }));
      return;
    }
    sendJson(res, 200, await this.buildProtocolSideView(this.readSavedOnebot(), { action, changed, note }));
  }

  /**
   * 写 `channels.onebot.managed`（dir / autoStart）与 `channels.onebot.enabled`。
   *
   * 三条纪律：
   *   ① **走现有的配置写入通道**（`withConfigDoc`）：整份文档读出来改再写回（保住人写的 `$comment`）、
   *      写回后立刻 `loadConfig` 复核、失败即回滚，且整段进 `configFileLock`；
   *   ② **落盘前归一化**：`dir` 用 `resolveServiceDir` 解成绝对路径再写——存一个相对路径，
   *      以后的人（与以后的界面）就得先猜它相对谁，而"猜错基准"的表现是"配了却找不到入口"；
   *   ③ **响应里明确"要重启"**：运行中的协议端实例是按**启动时**的配置建的，
   *      这份改动不会让本次进程改变行为。不说这句话，人点完保存就会以为已经生效。
   */
  private async writeProtocolSideConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, DEFAULT_BODY_LIMIT_BYTES);
    if (!body.ok) {
      sendError(res, body.code === 'payload-too-large' ? 413 : 400, body.code, body.message);
      return;
    }
    const payload = parseJsonObject(body.text);

    // 严格收字段：写成 `auto_start` 这类拼错的名字时，宽松处理会静默什么都不做——
    // 而界面上会显示"已保存"。宁可当场 400 并列出它认识的三个名字。
    const allowed = ['dir', 'autoStart', 'enabled'] as const;
    const unknown = Object.keys(payload).filter((key) => !(allowed as readonly string[]).includes(key));
    if (unknown.length > 0) {
      throw badRequest(
        `不认识的字段：${unknown.join(' / ')}。这条端点只接受 ${allowed.join(' / ')}`
        + '（改别的配置项请走 POST /api/commands/config-update）',
        'unknown-field',
      );
    }
    if (Object.keys(payload).length === 0) throw badRequest(`至少要给一个字段：${allowed.join(' / ')}`);

    const rawDir = payload['dir'];
    let dir: string | null = null;
    if (rawDir !== undefined) {
      if (typeof rawDir !== 'string' || rawDir.trim() === '') {
        throw badRequest(`dir 必须是非空字符串路径（协议端安装目录），收到 ${JSON.stringify(rawDir ?? null)}`, 'bad-dir');
      }
      dir = resolveServiceDir(rawDir.trim(), this.deps.config.dataDir);
    }
    const autoStart = readOptionalBool(payload['autoStart'], 'autoStart');
    const enabled = readOptionalBool(payload['enabled'], 'enabled');

    const fields: string[] = [];
    if (enabled !== null) fields.push('channels.onebot.enabled');
    if (dir !== null) fields.push('channels.onebot.managed.dir');
    if (autoStart !== null) fields.push('channels.onebot.managed.autoStart');

    await this.withConfigDoc((doc) => {
      const channels = requireObjectKey(doc, 'channels');
      const onebot = requireObjectKey(channels, 'onebot');
      const before = onebot['managed'];
      if (before !== undefined && before !== null && !isRecord(before)) {
        throw badRequest('config.json 的 channels.onebot.managed 不是对象：先手工修好它再来改', 'config-shape');
      }
      // 只动点到的字段：`managed` 里可能有本端点不认识的键（以后加的），一律原样留着
      const managed: JsonObject = isRecord(before) ? { ...(before as JsonObject) } : {};
      if (dir === null && !isRecord(before)) {
        throw badRequest('还没有 channels.onebot.managed：先给 dir（协议端安装目录），再谈 autoStart');
      }
      if (dir !== null) {
        managed['dir'] = dir;
        // kind 只有一个取值，但**必须写出来**：不写的话解析层会补默认，而人对着一份
        // "没说清是谁"的配置没法判断框架到底会拉起什么
        managed['kind'] = 'snowluma';
      }
      // autoStart 只在显式给了的时候写：默认 true 由判定侧兜（与 config.ts 的类型注释同一口径）
      if (autoStart !== null) managed['autoStart'] = autoStart;
      onebot['managed'] = managed;
      if (enabled !== null) onebot['enabled'] = enabled;
      return managed;
    }, 'channels.onebot');

    const saved = this.readSavedOnebot();
    const view = await this.buildProtocolSideView(saved, null);
    const restartRequired = view['restartRequired'] === true;
    this.write(`[协议端] 配置已写入：${fields.join('、')}`
      + `（${restartRequired ? '需重启进程才生效' : '与当前生效的一致，无需重启'}）`);
    sendJson(res, 200, {
      ...view,
      ok: true,
      fields,
      note: restartRequired
        ? '已写入 config.json。运行中的协议端实例是按**启动时**的配置建的：这份改动要重启进程才接管'
          + '（在那之前，界面上的状态仍是本次启动的那一个）。'
        : '已写入 config.json，且与当前生效的配置一致——不必重启。',
    });
  }

  /**
   * 读**盘上**那份配置，用作设置页的取值来源（`GET /api/config?source=saved`）。
   *
   * 三件事在这里定死：
   *   • **同步读**：异步 readFile 会留下一个在飞的读句柄，而 config.json 的写回是
   *     `rename` 覆盖——那个句柄正好卡住它（与 `readSavedOnebot` 同一个理由、同一个手法）。
   *     只读的一行不需要进 `configFileLock`。
   *   • **以生效配置为底、用盘上真有的值覆盖**：配置文件可以只写它关心的几项（其余走代码默认），
   *     所以"把文件原样丢给界面"会让没写的项显示成空——那不是"盘上那份"的本意。
   *   • **`$` 开头的键不进结果**：那些是配置里的注释键；带进来就会被算成"与生效值不同"，
   *     于是设置页每一行都挂上"尚未生效"。
   *
   * 读不出来（文件不在、不是 JSON、顶层不是对象）时**回落生效配置**并如实标 `memory`——
   * 界面据此可以把"这是盘上那份"与"这是内存那份"分开说，而不是假装读到了。
   */
  private readSavedConfig(): { source: 'saved' | 'memory'; config: AppConfig } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.configPath, 'utf8'));
    } catch {
      return { source: 'memory', config: this.deps.config };
    }
    if (!isRecord(parsed)) return { source: 'memory', config: this.deps.config };
    const base = structuredClone(this.deps.config) as unknown as Record<string, unknown>;
    return { source: 'saved', config: overlayConfig(base, parsed) as unknown as AppConfig };
  }

  /**
   * 读**盘上**那份 `channels.onebot`（人刚保存的就是它）。
   *
   * 为什么不直接用内存里的 `this.deps.config`：那是**进程启动时**读的，界面刚保存完再刷新
   * 就会看到旧值——"我改的东西它又变回去了"是这里最容易犯的错。`GET /api/config` 给的仍是
   * 内存那份（它回答的是"现在生效的是什么"），而两者不一致本身就是要显示的东西：
   * `restartRequired` 就是它们的比较。
   *
   * 读盘用**同步** `readFileSync`（与 mcpView 同一手法）：同步读在同一拍里就关掉了句柄，
   * 不会像 `loadConfig` 的异步 readFile 那样留下一个挡住 `rename` 的在飞句柄——
   * 那正是 `configFileLock` 要治的病，而只读的一行不需要进闸。
   *
   * 读不出来 / 形状不对时回落到内存配置，并如实标 `configSource: 'memory'`（不假装读到的是盘上那份）。
   */
  private readSavedOnebot(): OnebotSavedView {
    const fromMemory = (): OnebotSavedView => {
      const mem = this.deps.config.channels.onebot;
      return {
        enabled: mem.enabled,
        managed: mem.managed === undefined ? null : {
          kind: mem.managed.kind,
          dir: resolveServiceDir(mem.managed.dir, this.deps.config.dataDir),
          autoStart: mem.managed.autoStart !== false,
        },
        fromDisk: false,
      };
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.configPath, 'utf8'));
    } catch {
      return fromMemory();
    }
    if (!isRecord(parsed)) return fromMemory();
    const channels = parsed['channels'];
    const onebot = isRecord(channels) ? channels['onebot'] : undefined;
    if (!isRecord(onebot)) return fromMemory();
    const enabled = onebot['enabled'];
    const managedRaw = onebot['managed'];
    if (typeof enabled !== 'boolean') return fromMemory();
    if (managedRaw === undefined || managedRaw === null) {
      return { enabled, managed: null, fromDisk: true };
    }
    if (!isRecord(managedRaw)) return fromMemory();
    const dirRaw = managedRaw['dir'];
    if (typeof dirRaw !== 'string' || dirRaw.trim() === '') return fromMemory();
    const autoStartRaw = managedRaw['autoStart'];
    if (autoStartRaw !== undefined && typeof autoStartRaw !== 'boolean') return fromMemory();
    const kindRaw = managedRaw['kind'];
    return {
      enabled,
      managed: {
        kind: typeof kindRaw === 'string' && kindRaw !== '' ? kindRaw : 'snowluma',
        dir: resolveServiceDir(dirRaw.trim(), this.deps.config.dataDir),
        autoStart: autoStartRaw !== false,
      },
      fromDisk: true,
    };
  }

  /**
   * 协议端视图：**盘上的配置**与**运行期的实例**合成一份，自包含（界面一次请求就能把整张卡画完）。
   *
   * 五件事在这里定死：
   *   · **`accessToken` 永不出现在响应里**。它是协议端的凭据，界面既不需要也不该拿到；
   *     只给 `hasToken`（"有没有"）。它与 `endpoint.wsUrl` 一起放在 `endpoint` 里，
   *     而 `endpoint.source` 说明这个地址是**活的那个**（正在跑）还是**它配置里写的**（没跑）。
   *   · **v36：一个笼统状态拆成三档**（`process` / `onebotConfig` / `adapter`），每档带自己的判据。
   *     旧口径只有一枚 `state`，于是"进程活着 + 配置缺失"只能被说成"启动失败"——
   *     一句话和事实相反，而人下一步该做什么（去登录 vs 去看日志）全看这一句。
   *     `state` / `stateText` 仍然给（旧界面与旧口径不受影响），但它**不再是唯一的那句话**。
   *   · **`state` 不用猜**：有实例就问它（那是唯一知道真相的人）；没实例就是"没跑"，
   *     并在 `detail` 里说清是"没配置"还是"配置是启动之后才写的"。
   *   · **`detail` 永远非空**：界面靠它解释失败原因，而服务层在 autoStart=false 时
   *     只留下一个空串（它没做错什么，只是没人问过它）——空串在界面上等于"什么都没有"，
   *     这里补一句人话。
   *   · **`restartRequired` 是"盘上那份"与"本进程启动时读到的那份"的比较**，不是
   *     "有没有写过配置"：只写了同样的值就说"不用重启"，人才信这句话。
   *
   * 口令（`webuiLogin.password`）是**唯一一处例外**：它进响应，但只进本机界面，
   * 而且出响应前整份视图还会被 `scrubSecrets` 扫一遍（防的是"哪次拼接把它顺进 detail"）。
   */
  private async buildProtocolSideView(
    saved: OnebotSavedView,
    outcome: { action: 'start' | 'stop'; changed: boolean; note: string } | null,
  ): Promise<Record<string, unknown>> {
    const host = this.deps.protocolSide;
    const status = host === undefined ? null : await host.status();
    const secrets: string[] = [];
    const password = status?.report.webui.credential.password;
    if (typeof password === 'string') secrets.push(password);
    if (status?.endpoint !== undefined) secrets.push(status.endpoint.accessToken);

    // 本进程启动时读到的那份（`deps.config` 在启动时加载一次，之后不再变）
    const boot = this.deps.config.channels.onebot;
    const bootKind = boot.managed?.kind ?? null;
    const bootDir = boot.managed === undefined ? '' : resolveServiceDir(boot.managed.dir, this.deps.config.dataDir);
    const bootAutoStart = boot.managed === undefined ? false : boot.managed.autoStart !== false;

    const savedKind = saved.managed?.kind ?? null;
    const savedDir = saved.managed?.dir ?? '';
    const savedAutoStart = saved.managed === null ? false : saved.managed.autoStart;
    const restartRequired = saved.enabled !== boot.enabled || savedDir !== bootDir
      || savedKind !== bootKind || savedAutoStart !== bootAutoStart;

    const live = status !== null && status.state === 'ready' ? status.endpoint ?? null : null;
    // 只有 ready 才认它报的那个对接点：服务在 stop / 进程死掉之后**仍留着上一次的 endpoint**
    // （它自己的语义，main.ts 只在启动时取一次，不受影响），而一个"没在跑"的东西不该被界面
    // 读成"现在连这儿"。没跑的时候回落到**它自己配置里写的**那个（只读一份文件，不猜端口）：
    // "它打算在哪儿开端口"本身是排障时最有用的一条信息（比如在对着一个外部 NapCat 的时候）
    const fromItsConfig = savedDir === '' ? null : readEndpointFromConfig(savedDir);
    const endpoint = live ?? fromItsConfig;

    const state = status?.state ?? 'stopped';
    const liveEntry = host === undefined ? null : host.entryPath();
    /**
     * `installed` / `entryPath` 问的是"**这个目录**里有没有可执行入口"，而这两个值只能来自
     * 本次进程在用的那个实例——实例认的又是**启动时**那个目录。人刚把目录改成另一个（还没重启）时，
     * 拿旧目录的入口去回答新目录的问题就是一句假话。所以这里是三态：
     *   · 入口落在盘上那个目录里 → true（事实）；
     *   · 实例说没有入口 → false（框架现在确实拉不起来）；
     *   · 入口在**别的**目录里 → `null`＝"不知道"（界面照实说"重启后才核对"）。
     * 不给错的 true：`null` 本身也是有用的信息——它正好解释了为什么点「启动」没有动静。
     *
     * v35 补了**第四种情形**：本进程压根没有实例（host === undefined，配置是启动之后才写下的）。
     * 这时 `liveEntry` 必然是 null，而"实例没给出入口" **不等于** "那个目录里没有入口"——
     * 框架从没看过那个目录。旧写法会回 false，界面于是写"目录里没有可执行入口"，
     * 而人刚刚正是用一键安装把入口装进去的（安装器复检过 index.mjs）：
     * 一句当场自相矛盾的话，足以让人把装好的东西再下一遍。所以这里报 `null`（"不知道"），
     * 把判断留给重启之后那个真正认这个目录的实例。
     * 没配置（`savedDir` 为空）不在此列：那种情况界面走空态，且"没有目录"确实就是"没装"。
     */
    const mismatchedDir = liveEntry !== null && !isUnderDir(liveEntry, savedDir);
    const entryPath = mismatchedDir ? null : liveEntry;
    const unverifiedDir = host === undefined && savedDir !== '';
    const installed: boolean | null = (mismatchedDir || unverifiedDir) ? null : liveEntry !== null;
    const detail = status !== null && status.detail !== ''
      ? status.detail
      : (host === undefined
        ? (saved.managed === null
          ? '未配置内置协议端：框架不拉起它，OneBot 连的是配置里手填的地址与密钥。'
          : '这段配置是本次进程启动之后才写下的：重启进程后框架才会接管它的拉起与对接。')
        : '已停止（本次没有自动拉起：autoStart=false，或者还没点过「启动」）。');

    /**
     * 三档（v36）：每一档自带判据，界面上分开说。
     *
     * 没有实例（host === undefined）时三档里能答的照答：`onebotConfig` 与 `adapter`
     * 压根不依赖实例（一个读盘、一个问适配器），只有 `process` 那一档需要实例——
     * 而没有实例**不等于**没在跑（实测现场正是"进程在跑、只是本次框架没管它"）。
     * 所以那一档如实报 `known: false`（"本进程没在看"），而不是报"没在跑"。
     */
    const report = status?.report ?? null;
    const link = this.deps.onebotLink === undefined ? null : this.deps.onebotLink();
    const processView = report === null
      ? { known: false, running: null as boolean | null, detail: '本进程没有装配协议端实例，这一档没人在看（重启进程后才看得到）。' }
      : {
          known: true,
          running: report.process.running,
          ...(report.process.pid === undefined ? {} : { pid: report.process.pid }),
          ...(report.process.managed === undefined ? {} : { managed: report.process.managed }),
          ...(report.process.startedAt === undefined ? {} : { startedAt: report.process.startedAt }),
          ...(report.process.webuiUrl === undefined ? {} : { webuiUrl: report.process.webuiUrl }),
          detail: report.process.running
            ? `在跑${report.process.pid === undefined ? '' : `（pid ${report.process.pid}`}`
              + `${report.process.startedAt === undefined ? '' : `，${report.process.startedAt} 起`}`
              + `${report.process.pid === undefined ? '' : '）'}`
              + `；实际监听 ${report.process.webuiUrl ?? '（端口未探到）'}`
            : '没在跑',
        };
    const configView = report === null
      ? null
      : {
          present: report.onebotConfig.present,
          ...(report.onebotConfig.endpoint === undefined
            ? {}
            : {
                wsUrl: report.onebotConfig.endpoint.wsUrl,
                hasToken: report.onebotConfig.endpoint.accessToken !== '',
              }),
          ...(report.onebotConfig.path === undefined ? {} : { path: report.onebotConfig.path }),
          ...(report.onebotConfig.unreadable === undefined ? {} : { unreadable: report.onebotConfig.unreadable }),
          detail: report.onebotConfig.present
            ? `在（${report.onebotConfig.path ?? '它的配置'}），端点 ${report.onebotConfig.endpoint?.wsUrl ?? '读不出'}`
            : report.onebotConfig.unreadable === true
              ? `那份文件在（${report.onebotConfig.path ?? '?'}）但读不出端点——要人去修它`
              : '缺失（它登录 QQ 之后才会生成这一份）',
        };
    const adapterView = link === null
      ? { state: 'not-assembled' as const, detail: '本进程没有装配 OneBot 适配器' }
      : {
          state: !link.enabled ? ('disabled' as const)
            : !link.hasEndpoint ? ('no-endpoint' as const)
              : link.connected ? ('connected' as const) : ('reconnecting' as const),
          connected: link.connected,
          hasEndpoint: link.hasEndpoint,
          ...(link.target === undefined ? {} : { target: link.target }),
          ...(link.selfId === undefined ? {} : { selfId: link.selfId }),
          reconnectAttempts: link.reconnectAttempts,
          lastEventAt: link.lastEventAt,
          delivered: link.delivered,
          detail: !link.enabled
            ? '通道没开（config.channels.onebot.enabled=false）'
            : !link.hasEndpoint
              ? '没有可连的端点（协议端的 OneBot 配置还没出现，配置里也没有手填地址）'
              : link.connected
                ? `已连上 ${link.target ?? '端点'}`
                : `重连中（第 ${link.reconnectAttempts} 次）：${link.target ?? '端点'}`,
        };

    /**
     * 三档合成的那一句（界面卡头直接显示它）。
     *
     * 词序是**故意的**：先说进程、再说配置、最后说适配器——那正是"到底断在哪一环"的排查顺序，
     * 也是这次要显示出来的那条链。缺一档就不说那一档（不拿"未知"占位）。
     */
    const summary = [
      processView.known
        ? (processView.running === true ? '进程在跑' : '进程没在跑')
        : '进程未观测',
      configView === null ? null : (configView.present ? 'OneBot 配置在' : 'OneBot 配置缺失'),
      adapterView.state === 'connected' ? '适配器已连上'
        : adapterView.state === 'reconnecting' ? '适配器重连中'
          : adapterView.state === 'no-endpoint' ? '适配器没端点可连'
            : adapterView.state === 'disabled' ? '适配器未启用' : '适配器未装配',
    ].filter((part): part is string => part !== null).join(' · ');

    const view: Record<string, unknown> = {
      // ① 盘上的配置（人刚保存的就是它）
      configured: saved.managed !== null,
      enabled: saved.enabled,
      kind: savedKind,
      dir: savedDir,
      autoStart: savedAutoStart,
      configSource: saved.fromDisk ? 'disk' : 'memory',
      // ② 运行期
      attached: host !== undefined,
      state,
      stateText: PROTOCOL_STATE_TEXT[state] ?? state,
      detail,
      restartRequired,
      // ③ 对接点与登录口
      endpoint: endpoint === null ? null : {
        wsUrl: endpoint.wsUrl,
        hasToken: endpoint.accessToken !== '',
        source: live === null ? 'config' : 'live',
      },
      // WebUI 地址：**进程在跑就给**（v36 改的口径）。
      // 旧口径是"只有 ready / starting 才给"——那等于把"面板开着"绑在"OneBot 端口开着"上，
      // 而实测现场恰恰是前者开着、后者没开：界面于是不给按钮，人连登录都做不到。
      webuiUrl: status?.webuiUrl ?? null,
      // ④ 装没装（三态：true / false / null="配置改了，重启后才核对得出"）
      installed,
      entryPath,
      // ⑤ 三档（v36）：这是"到底断在哪一环"的正式答案
      process: processView,
      onebotConfig: configView,
      adapter: adapterView,
      summary,
      /**
       * 面板的登录口：地址 + 凭据 + 两个门的状态。
       *
       * **口令只在这里出现一次**，且带着 `source`：`stdout` = 本次启动从它的输出里捕到的
       * （权威）；`console-log` = 从框架自己的启动留痕里捞回来的（**可能是上一轮作废的那条**，
       * 所以要标出来）；`none` = 找不回来，界面该说"重启一次让它重新打印"，而不是让人干瞪眼。
       */
      webuiLogin: status === null
        ? null
        : {
            url: status.webuiUrl ?? null,
            open: status.report.webui.open,
            consentRecorded: status.report.webui.consentRecorded,
            mustChangePassword: status.report.webui.mustChangePassword,
            credential: {
              source: status.report.webui.credential.source,
              ...(status.report.webui.credential.user === undefined
                ? {}
                : { user: status.report.webui.credential.user }),
              // 明文口令**只给本机界面**（本服务默认只绑回环 + 有鉴权）；响应出去前还会再扫一遍兜底
              ...(status.report.webui.credential.password === undefined
                ? {}
                : {
                    password: status.report.webui.credential.password,
                    passwordMasked: maskCredential(status.report.webui.credential.password),
                  }),
            },
          },
    };
    if (status?.pid !== undefined) view['pid'] = status.pid;
    if (outcome !== null) {
      view['ok'] = true;
      view['action'] = outcome.action;
      view['changed'] = outcome.changed;
      view['note'] = outcome.note;
    }
    // 兜底：整份视图扫一遍已知口令（detail / note / summary 都是人拼出来的，谁都可能拼错）
    return scrubSecrets(view, secrets);
  }

  private async listEvents(url: URL): Promise<EventsPage> {
    const types = url.searchParams.getAll('types')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value !== '');

    const visibilityRaw = url.searchParams.get('visibility');
    if (visibilityRaw !== null && visibilityRaw !== 'model' && visibilityRaw !== 'internal') {
      throw badRequest(`visibility 只能是 model 或 internal，收到 ${visibilityRaw}`);
    }

    const fromSeqRaw = url.searchParams.get('from_seq');
    let fromSeq: number | null = null;
    if (fromSeqRaw !== null) {
      const parsed = Number(fromSeqRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw badRequest(`from_seq 必须是 >= 1 的整数，收到 ${fromSeqRaw}`);
      }
      fromSeq = parsed;
    }

    const limitRaw = url.searchParams.get('limit');
    let limit = EVENTS_DEFAULT_LIMIT;
    if (limitRaw !== null) {
      const parsed = Number(limitRaw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > EVENTS_MAX_LIMIT) {
        throw badRequest(`limit 必须是 1..${EVENTS_MAX_LIMIT} 的整数，收到 ${limitRaw}`);
      }
      limit = parsed;
    }

    return queryEvents(this.deps.log, {
      fromSeq,
      filters: { types, visibility: visibilityRaw },
      limit,
    });
  }

  private async budgetView(url: URL): Promise<BudgetView> {
    const rangeRaw = url.searchParams.get('range') ?? 'today';
    if (rangeRaw !== 'today' && rangeRaw !== '7d') {
      throw badRequest(`range 只能是 today 或 7d，收到 ${rangeRaw}`);
    }
    // 预算查询与 CLI 同源：全量折叠一次（低频请求，弹层打开时才算）
    const events = await readAllEvents(this.deps.log);
    return buildBudgetView({
      dataDir: this.deps.dataDir,
      config: this.deps.config,
      events,
      now: this.deps.now(),
      range: rangeRaw,
    });
  }

  private async replayView(url: URL): Promise<ReplayView> {
    const turnRaw = url.searchParams.get('turn');
    const stepRaw = url.searchParams.get('step');
    const turn = turnRaw === null ? null : Number(turnRaw);
    const step = stepRaw === null ? null : Number(stepRaw);
    if (turn === null || !Number.isInteger(turn) || turn < 0) {
      throw badRequest('缺少或非法的 turn 参数（如 ?turn=3&step=2）');
    }
    if (step === null || !Number.isInteger(step) || step < 0) {
      throw badRequest('缺少或非法的 step 参数（如 ?turn=3&step=2）');
    }
    return buildReplay({
      events: await readAllEvents(this.deps.log),
      turn,
      step,
      personaRoot: this.deps.personaRoot,
      config: this.deps.config,
      registry: this.deps.registry ?? null,
    });
  }

  // ── SSE ──

  private openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    res.write(`retry: ${SSE_RETRY_MS}\n\n`);

    // 先把"已广播水位"追到日志末尾：既服务已经在连的客户端，也让本次补拉有一个确定的上界
    // （不追水位的话，补拉之后再跑 pump 会把补过的那一段又推一遍）
    this.pump();

    // Last-Event-ID（SSE 标准头）或 ?last_event_id 作为等价入口：补拉后直接接实时流。
    const lastIdRaw = req.headers['last-event-id'] ?? url.searchParams.get('last_event_id');
    const lastIdText = Array.isArray(lastIdRaw) ? lastIdRaw[0] : lastIdRaw;
    let lastId = Number.parseInt(lastIdText ?? '', 10);
    if (!Number.isInteger(lastId) || lastId < 0) lastId = 0;

    // 补拉上界 = 已广播水位（不是日志末尾）：中间那段由 pump 继续推，避免同一条事件发两遍
    const upTo = this.pumpedSeq;
    if (lastId > 0 && lastId < upTo) {
      // 补拉量设上限：超出就只补最近一段——重连后前端本来就要全量重拉 /api/projection，
      // 投影是派生数据，全量覆盖永远安全（frontend.md §4 的 reconcile 两条腿）
      const from = Math.max(lastId + 1, upTo - SSE_REPLAY_LIMIT + 1);
      for (let seq = from; seq <= upTo; seq++) {
        const event = this.deps.log.get(seq);
        if (event === null) continue;
        res.write(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }

    this.sseClients.add(res);
    const drop = (): void => {
      this.sseClients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  // ── /api/auth/*（认证端点） ──

  /**
   * 认证失败的统一出口：`{error:{code,message}, instance}`。
   *
   * 带上 `instance` 是**功能需要**，不是顺手多给：界面要先知道"我在连哪个实例"
   * 才能去对的地方读自己那份会话凭据（见 [instanceIdOf]）。它不含任何凭据。
   */
  private sendAuthError(res: ServerResponse, status: number, code: string, message: string): void {
    sendJson(res, status, {
      error: { code, message },
      instance: instanceIdOf(this.host, this.port(), this.deps.dataDir),
    });
  }

  /** 认证成功（签发/换发会话）的响应：凭据**只在这里出现这一次**，之后盘上只有它的哈希 */
  private sendSession(
    res: ServerResponse,
    issued: { token: string; sessionId: string; createdAt: string },
  ): void {
    sendJson(res, 200, {
      ok: true,
      token: issued.token,
      sessionId: issued.sessionId,
      createdAt: issued.createdAt,
      instance: instanceIdOf(this.host, this.port(), this.deps.dataDir),
    });
  }

  /**
   * 认证四条：设密码 / 登录 / 登出 / 改密码。
   *
   * 它们**不走**上面那道 Bearer 闸（否则"没有凭据"就成了"永远拿不到凭据"），
   * 各自的规矩写在方法体里：
   *   • `setup`    —— 只在**还没设密码**时可用；成功即登录（当场签发会话），不必再输一遍；
   *   • `login`    —— 验密码，带退避（见 `auth.ts` 的 BACKOFF_*）；
   *   • `logout`   —— 要凭据（撤的就是它自己）；没有凭据也无所谓，结果一样是"没登着"；
   *   • `password` —— 要凭据 + 旧密码；成功会让**全部**旧会话失效，并当场签发一条新的。
   *
   * 响应体里只出现会话凭据**这一次**（`token` 字段），盘上只有它的哈希。
   * 日志里一个都不出现。
   */
  private async handleAuth(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'method-not-allowed', `认证端点只接受 POST：${path}`);
    }
    const body = await readBody(req, DEFAULT_BODY_LIMIT_BYTES);
    if (!body.ok) {
      sendError(res, body.code === 'payload-too-large' ? 413 : 400, body.code, body.message);
      return;
    }
    const payload = parseJsonObject(body.text);
    const password = typeof payload['password'] === 'string' ? payload['password'] : '';
    const label = typeof payload['label'] === 'string' ? payload['label'] : 'local';

    if (path === '/api/auth/setup') {
      // 旧 token 在**动作前**才读得到（AuthStore 一作废就置空了）——先取好，落库时用它
      const legacyBefore = this.auth.legacyTokenActive;
      const result = await this.auth.setup(password, label);
      if (!result.ok) {
        this.sendAuthError(res, result.status, result.code, result.message);
        return;
      }
      this.recordPasswordSet('setup', label, 0, legacyBefore);
      this.sendSession(res, result);
      return;
    }

    if (path === '/api/auth/login') {
      // 退避已经在 AuthStore 里等过了（那才是"验之前先等"的唯一落点），这里只落事实
      const result = await this.auth.login(password, label);
      if (!result.ok) {
        this.write(`[认证] 登录失败（${result.code}）`);
        if (result.status === 401) res.setHeader('retry-after', String(Math.ceil(this.auth.backoffMs() / 1000)));
        this.sendAuthError(res, result.status, result.code, result.message);
        return;
      }
      this.sendSession(res, result);
      return;
    }

    // 剩下两条要凭据：先把当前这条会话认出来（认不出就没有"当前会话"可撤/可换）
    const provided = bearerOf(req) ?? '';
    const verdict = this.auth.authenticate(provided);
    if (!verdict.ok) {
      if (verdict.reason === 'uninitialized') {
        this.sendAuthError(res, 401, 'auth-uninitialized', '这台实例还没设密码。请先在界面里设置一个密码。');
        return;
      }
      this.sendAuthError(res, 401, 'unauthorized', '会话凭据无效或已失效。请重新登录。');
      return;
    }
    // 遗留 token 能进 `/api/*`，但它不是一条"会话"，没有可撤销的 id——如实说清而不是假装成功
    if (verdict.via === 'legacy-token') {
      this.sendAuthError(
        res, 409, 'legacy-token',
        '当前用的是旧的共享 token，它没有会话可撤销。请先设置一个密码，之后按会话登录/登出。',
      );
      return;
    }

    if (path === '/api/auth/logout') {
      this.auth.logout(provided);
      sendJson(res, 200, { ok: true, instance: instanceIdOf(this.host, this.port(), this.deps.dataDir) });
      return;
    }

    // 改密码：旧密码 + 新密码。`password` 是新的，旧的在 `oldPassword` 里
    const oldPassword = typeof payload['oldPassword'] === 'string' ? payload['oldPassword'] : '';
    const legacyBefore = this.auth.legacyTokenActive;
    const before = this.auth.sessionCount;
    const result = await this.auth.changePassword(oldPassword, password, label);
    if (!result.ok) {
      if (result.status === 401 && result.code === 'bad-password') this.write('[认证] 改密码失败：当前密码不对');
      this.sendAuthError(res, result.status, result.code, result.message);
      return;
    }
    this.recordPasswordSet('change', label, before, legacyBefore);
    this.sendSession(res, result);
  }

  /**
   * 落一条「密码被设上/被改掉」的**事实**。
   *
   * 为什么它必须进事件日志：换锁是一次能力边界的变更——它当场废掉所有已发出的会话凭据，
   * 也（老实例上）废掉了那份 `data/.ui-token`。事后唯一能回答"谁在什么时候换的锁"的地方
   * 就是日志；写在别处就是第二份真相源（与 `skills-ignored.json` 的取舍正好相反，
   * 那条是界面备忘，这条是事实）。
   *
   * `legacyDisabled` 必须由调用方在**动作之前**取好传进来：AuthStore 里旧 token 一作废就置空了，
   * 落库时再读就永远是 false（这条事实恰好只发生一次，读错了等于没记）。
   */
  private recordPasswordSet(
    action: 'setup' | 'change',
    by: string,
    sessionsRevoked: number,
    legacyDisabled: boolean,
  ): void {
    this.appendSync('auth/password-set', {
      by: by.trim() === '' ? 'local' : by.trim().slice(0, 40),
      action,
      legacyTokenDisabled: legacyDisabled,
      sessionsRevoked,
    }, 'internal');
  }

  /**
   * 落一条「webhook 专用凭据被生成/被轮换」的**事实**。
   *
   * 与 `recordPasswordSet` 同一条理由：换钥匙是一次能力边界的变更——它当场废掉上一份凭据，
   * 也就当场打断了所有还没换过来的外部投递方。事后唯一能回答"谁在什么时候换的、换到第几份"
   * 的地方就是日志（界面上的状态会随下一次生成而变，留不下历史）。
   *
   * **不带任何凭据**：没有明文，也没有哈希，只有一个非密钥的 8 字节 id。
   * 可见性 internal——这是本机的运维事实，与她的行事无关，不该占她的上下文。
   */
  private recordWebhookTokenRotated(
    result: { action: 'generate' | 'rotate'; secretId: string; previousSecretId: string | null },
    by: string,
  ): void {
    this.appendSync('auth/webhook-token-rotated', {
      by: by.trim() === '' ? 'local' : by.trim().slice(0, 40),
      action: result.action,
      secretId: result.secretId,
      previousSecretId: result.previousSecretId,
    }, 'internal');
  }

  // ── /webhook ──

  /**
   * 外部回调入口。**只认 webhook 专用凭据**（`data/.webhook-secret.json`）：
   * 界面会话凭据与迁移期那份 `.ui-token` 在这条通道上一律 401（B9，2026-10）。
   *
   * ## 为什么这条通道要收窄（而不是"加一份凭据、旧的照旧能进"）
   *
   * 加一份凭据但保留旧路，等于这一项什么都没做：外部系统照旧会拿界面会话凭据，
   * 照旧会在用户改密码的那天半夜断掉，照旧能读整个 `/api/*`。**收窄才是要点**——
   * 它换来的是一条真正的最小权限通道：能投一条 `wake/webhook`，读不到任何东西，
   * 也不随界面那扇门开关。
   *
   * ## 代价（真的会发生，所以三处都说了）
   *
   * 今天之前配好的外部脚本**当场开始收 401**。这不是意外，是有意的取舍；能做的就是
   * 让原因查得到：401 的响应体里写明"从今天起只认专用凭据、去哪儿生成"，
   * 服务端诊断输出里落一行（限流 60 秒一条，见 `lastWebhookRejectLogAt`），
   * `docs/operations.md` §4.2 写清怎么拿新凭据。
   *
   * ## 失败答复为什么分四种
   *
   * 把"还没生成过凭据"和"你这份不对"混成一句话，人就得在两件毫不相干的事之间猜：
   * 前者要去界面按一次生成，后者要去改外部脚本。所以四种分开：
   *   · `unconfigured` → `webhook-token-unset`（生成过才有得谈）；
   *   · `missing`      → `unauthorized`（配了凭据但没带）；
   *   · `previous`     → `unauthorized`（带的正是**刚被轮换掉**的那份：最有用的一条线索）；
   *   · `invalid`      → `unauthorized`（别的什么东西；如果它其实是一条**有效会话凭据**，
   *     响应体与日志都会把这句说出来——那正是"老脚本还没换"的典型现场）。
   *
   * 顺序上认证排在最前面（先于令牌桶与 body 读取）：未认证的请求不该消耗任何共享资源，
   * 也不该让"桶满了"这条信息泄露给一个连凭据都没有的调用方。
   */
  private async handleWebhook(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'POST') {
      throw new HttpError(405, 'method-not-allowed', 'webhook 只接受 POST');
    }

    const provided = bearerOf(req) ?? '';
    const verdict = this.webhookSecret.authenticate(provided);
    if (!verdict.ok) {
      this.noteWebhookRejected(req, verdict.reason, provided);
      const failure = this.webhookAuthError(verdict.reason, provided);
      this.sendAuthError(res, 401, failure.code, failure.message);
      return;
    }

    const source = req.socket.remoteAddress ?? 'unknown';
    if (!this.buckets.take(source, this.deps.now().getTime())) {
      res.setHeader('retry-after', '1');
      sendError(res, 429, 'rate-limited', `来源 ${source} 的回调速率超过令牌桶（容量 ${this.webhookRate.capacity}/回填 ${this.webhookRate.refillPerSec} 每秒）`);
      return;
    }

    const body = await readBody(req, DEFAULT_BODY_LIMIT_BYTES);
    if (!body.ok) {
      sendError(res, body.code === 'payload-too-large' ? 413 : 400, body.code, body.message);
      return;
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const text = Array.isArray(value) ? value.join(', ') : value;
      headers[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[redacted]' : text;
    }

    const parsed: Record<string, unknown> = (() => {
      try {
        const value: unknown = JSON.parse(body.text);
        return isRecord(value) ? value : {};
      } catch {
        return {};
      }
    })();
    const explicitKey = typeof parsed['dedupeKey'] === 'string' && parsed['dedupeKey'] !== ''
      ? parsed['dedupeKey']
      : null;

    const event = this.appendSync('wake/webhook', {
      path: url.pathname,
      body: body.text,
      headers,
      // 缺省幂等键 = 内容哈希（design §4.15）：客户端重试与重复通知由此无害
      dedupeKey: explicitKey ?? contentKey('wh', `${url.pathname}\n${body.text}`),
    }, 'model');

    sendJson(res, 200, { ok: true, seq: event.seq, type: event.type });
  }

  /**
   * `/webhook/*` 认证失败的答复文案（四个原因共用一个出口，因为**要说的核心事实是同一句**：
   * "从今天起这条通道只认专用凭据"。分成四份各写一遍，迟早漂移成四种说法）。
   *
   * 只差一句"具体差在哪儿"：没生成过 / 没带 / 带的是上一份 / 带的是别的什么。
   * 而只要调用方**带了东西**、且那东西恰好是一条有效的界面会话凭据，就顺手把这件事点破——
   * 收窄之后最典型的现场就是老脚本还拿着会话凭据（见 `noteWebhookRejected` 关于这不算泄露的说明）。
   */
  private webhookAuthError(reason: string, provided: string): { code: string; message: string } {
    const common = `从今天起 /webhook/* 只认 webhook 专用凭据（data/${WEBHOOK_SECRET_FILE_NAME}）：`
      + '界面会话凭据与迁移期那份 data/.ui-token 都不再放行这条通道。'
      + '请用 POST /api/commands/regenerate-webhook-token 生成一份（响应里的 token 只显示一次）。';
    const isSession = provided !== '' && this.auth.authenticate(provided).ok;
    const sessionHint = isSession
      ? '你带的是一条**有效的界面会话凭据**——它是给 /api/* 用的，这条通道不认它。'
      : '';
    if (reason === 'unconfigured') {
      return {
        code: 'webhook-token-unset',
        message: '这台实例还没有生成 webhook 专用凭据，所以 /webhook/* 现在一律 401。'
          + sessionHint + common,
      };
    }
    if (reason === 'previous') {
      return {
        code: 'unauthorized',
        message: `${common}你带的是**上一份**（已被轮换掉的）凭据，它在轮换的那一刻就失效了：`
          + '请把调用方换成新生成的那一份。',
      };
    }
    return { code: 'unauthorized', message: `${sessionHint}${common}` };
  }

  /**
   * 把一次"webhook 被拒"写成一行诊断输出（**限流 60 秒一条**，见 `lastWebhookRejectLogAt`）。
   *
   * 为什么要顺手认出"这是一条**有效的界面会话凭据**"：收窄之后最典型的现场，就是
   * **一个还没改过来的外部脚本拿着会话凭据在敲**。只说一句"unauthorized"，排障的人得自己
   * 去猜敲门的是谁；说出这一句，答案就在眼前。这不算泄露——调用方本来就得先持有那份会话凭据，
   * 而它拿同一份凭据去打 `/api/projection` 同样能知道它有效。
   */
  private noteWebhookRejected(req: IncomingMessage, reason: string, provided: string): void {
    const nowMs = this.deps.now().getTime();
    if (nowMs - this.lastWebhookRejectLogAt < WEBHOOK_REJECT_LOG_MS) return;
    this.lastWebhookRejectLogAt = nowMs;
    const source = req.socket.remoteAddress ?? 'unknown';
    if (provided !== '' && this.auth.authenticate(provided).ok) {
      this.write(`[webhook] 拒绝 ${source} 的投递：它带的是**有效的界面会话凭据**，而这条通道从今天起只认专用凭据（去界面上生成一份）`);
      return;
    }
    const why = reason === 'unconfigured' ? '还没生成过专用凭据'
      : reason === 'missing' ? '没带凭据'
        : reason === 'previous' ? '带的是上一份（已轮换掉的）凭据'
          : '凭据不对';
    this.write(`[webhook] 拒绝 ${source} 的投递（${why}）：/webhook/* 只认专用凭据`);
  }

  // ── 写命令 ──

  private async runCommand(command: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req, DEFAULT_BODY_LIMIT_BYTES);
    if (!body.ok) {
      sendError(res, body.code === 'payload-too-large' ? 413 : 400, body.code, body.message);
      return;
    }
    const payload = parseJsonObject(body.text);

    // 危险操作确认（frontend.md §4）：短语 = 操作英文标识；字段级的危险在 config-update 里再收紧
    const required = CONFIRM_PHRASES[command];
    if (required === undefined) {
      const reason = UNIMPLEMENTED_COMMANDS[command];
      if (reason !== undefined) {
        throw new HttpError(501, 'not-implemented', `命令 ${command} 尚未实现：${reason}`);
      }
      throw notFound(`未知命令：${command}`, 'unknown-command');
    }
    // X-Confirm 的值是**短语列表**（以 ';' 分隔，如 `update-config; enable-destructive`）：
    // 命令级短语必给，字段级危险短语由 config-update 追加
    const confirmRaw = req.headers['x-confirm'];
    const confirmText = (Array.isArray(confirmRaw) ? confirmRaw.join(';') : (confirmRaw ?? '')).trim();
    const phrases = confirmText.split(';').map((item) => item.trim()).filter((item) => item !== '');
    if (required !== null && !phrases.includes(required)) {
      throw badRequest(
        `该操作为危险操作：请在 X-Confirm 头里原样给出确认短语 ${required}`
        + `（收到 ${confirmText === '' ? '（缺失）' : confirmText}）`,
        'confirm-required',
      );
    }

    const now = this.deps.now();
    switch (command) {
      case 'reset-context': {
        // 清空对话历史：**不删事件**（日志是唯一真相源，删了就没法复盘），而是写一条遮蔽摘要，
        // 把 coveredUpToSeq 推到当前水位——渲染层从此只看这之后的事件，等于给她一个干净的上下文。
        // 下一次请求会全 miss（前缀变了），之后重新落盘并恢复命中。
        const covered = this.deps.projection.lastSeq;
        if (covered === 0) {
          sendJson(res, 200, { ok: true, coveredUpToSeq: 0, note: '还没有历史，无需清空' });
          return;
        }
        const resetEvent = this.appendSync('compaction/summary', {
          coveredUpToSeq: covered,
          summary: '（用户要求清空对话历史，此前的往来不再进入上下文。要接着聊就重新开口。）',
        }, 'internal');
        sendJson(res, 200, {
          ok: true, seq: resetEvent.seq, type: resetEvent.type, coveredUpToSeq: covered,
        });
        return;
      }
      case 'dream': {
        // **梦是她的事，所以这就是一个普通的 turn**（用户 2026-10-04 定的口径）。
        //
        // 原先这里排的是一条"记忆整理"定时器（机制动作、不走模型 turn、`spoke: false`）——
        // 结果是：文件确实被后台写了，但**她本人一动不动**，用户按完 /dream 看不出任何反应。
        // 改成排一条 `wake/manual`：与他在聊天框里说话走**同一条路**（同一套认领、幂等、
        // 崩溃恢复），她会读素材、自己写流水账与日记，想说还能说一句。
        //
        // 日常那次的"机制整理"照旧（每日 cron → memory-maintain），两者分工不变：
        // cron 是后台维护，`/dream` 是"她现在做一次"。
        const note = typeof payload['note'] === 'string' && payload['note'].trim() !== ''
          ? payload['note'].trim()
          : [
            '该做梦了（用户按的）。',
            '把今天过一遍：今天的事写进 `MEMORIES/episodes/<今天>.md`（没有就现在补写；按日期一文件），',
            '再写一篇 `diary/<今天>.md`（第一人称，别写成报告），',
            '顺手把值得长期记住的、或者已经过期的，按你自己的判断处理。',
            '做完想跟用户说一句就说——这条与平时说话一样，用 speak 才发得出去。',
          ].join('');
        const event = this.appendSync('wake/manual', {
          note,
          // 带上来源标记：GUI 据此把它渲染成**框架卡片**（用户 2026-10-04 的口径），
          // 而不是把这条框架指令当成用户说的话摆成蓝气泡。
          via: 'dream',
          person: ownerPersonOf(this.deps.config),
          // 幂等键带上时间片（5 秒）：连点两下算一次，隔一会儿再按一次是真的再做一次梦
          dedupeKey: contentKey('ui-dream', `${Math.floor(this.deps.now().getTime() / 5000)}:${note}`),
        }, 'model');
        // 这里**故意不通报**"人开口了"：这条 note 是框架替 /dream 拼的那段整理指令（`via: 'dream'`，
        // 界面按框架卡片渲染），不是人说的话。打断回执会把对方那句写进去，把这段指令当成"他刚说「…」"
        // 摆给她就成了假事实。用户按 /dream 要停住她的发言时，随手在聊天框里说一句就走通了这条路。
        const queued = this.deps.projection.pending.some((item) => item.wakeSeq === event.seq);
        sendJson(res, 200, {
          ok: true,
          seq: event.seq,
          queued,
          note: queued
            ? '已叫她去整理：这一轮她会读今天的素材、写流水账与日记（想说就会说一句）'
            : '这条与刚排的那次内容相同（5 秒内重复提交），没有重复入队',
        });
        return;
      }
      case 'wake': {
        const note = typeof payload['note'] === 'string' ? payload['note'] : '';
        const explicitKey = typeof payload['dedupeKey'] === 'string' && payload['dedupeKey'] !== ''
          ? payload['dedupeKey']
          : null;
        const event = this.appendSync('wake/manual', {
          note,
          // 带人唤醒：GUI 聊天框说话的是本机用户，带上他的档案标识，
          // 于是 persona/RELATIONSHIPS/<owner>.md 每轮自动注入（persona.md §3）
          person: ownerPersonOf(this.deps.config),
          // 缺省幂等键 = 内容哈希 **+ 时间片**：要挡的是"同一条消息被重复提交"
          // （连点两下、客户端重试），不是"人隔一会儿又把同一句话说了一遍"。
          //
          // 只用内容哈希的后果实测过一次：13:56 与 16:55 都说"呐，弥亚小姐"，
          // 两个 key 完全一样，后一条被 fold 当重复静默丢弃——表现就是**说话她没反应**，
          // 而且没有任何日志、没有任何错误，人只能干等。时间片取 5 秒：
          // 连点落在同一片里，重新开口不会。
          dedupeKey: explicitKey ?? contentKey('ui-wake', `${Math.floor(this.deps.now().getTime() / 5000)}:${note}`),
        }, 'model',
        // 人开口了：她若正在发言，立刻停下没发的那几段（见 WebServerDeps.noteUserSpoke）。
        // 放在这里而不是 handler 末尾：那条"尚未发完"的 speak 正在另一个栈里等着看计数。
        (event) => { this.deps.noteUserSpoke?.(event.seq, event.type, event.data); });
        // 回执里如实说明它**有没有真的进队列**：幂等键撞上时 fold 会静默丢弃，
        // 而“说了没反应”与“她正在想”在界面上长得一模一样（这次事故最难的地方就在这）。
        const queued = this.deps.projection.pending.some((item) => item.wakeSeq === event.seq);
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, note, deduped: !queued });
        return;
      }
      case 'review-resolve': {
        const callId = typeof payload['callId'] === 'string' ? payload['callId'] : '';
        if (callId === '') throw badRequest('缺少 callId');
        const outcome = payload['outcome'];
        if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'partial') {
          throw badRequest('outcome 只能是 succeeded / failed / partial');
        }
        const note = typeof payload['note'] === 'string' ? payload['note'] : '';
        // 与 CLI 同一条校验：拼错的 callId 写成结案事实 = 往唯一真相源里灌假事实
        const known = buildReviewEntries(await readAllEvents(this.deps.log))
          .some((entry) => entry.callId === callId);
        if (!known) {
          throw notFound(
            `callId=${callId} 不在待确认列表里（可能已结案或拼写有误）；先 GET /api/projection 核对`,
            'review-not-found',
          );
        }
        const event = this.appendSync('review/resolved', { callId, outcome, note, by: 'human' }, 'model');
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, callId, outcome });
        return;
      }
      case 'answer': {
        // 答复人审挂起（design §4.21）：与 CLI 的 `irmia answer` 共用同一份实现。
        // 区别只在写入通道——这里在主进程内 appendSync，所以不需要 CLI 那道「主进程未运行」
        // 的探锁（seq 分配器本来就在本进程手里）。
        const answer = typeof payload['answer'] === 'string' ? payload['answer'].trim() : '';
        if (answer === '') {
          throw badRequest('缺少 answer：approve = 批准待批的破坏性计划；reject:<理由> = 拒绝');
        }
        const callId = typeof payload['callId'] === 'string' && payload['callId'] !== ''
          ? payload['callId']
          : undefined;
        // 答复的是哪一条提问（卡片带着它）：台面上可能同时摆着她问的卡与一条待批准的计划，
        // 光靠"最后一条挂起"会把人的答复记到另一条问题上（§6 的一张卡一层含义）
        const askSeqRaw = payload['askSeq'];
        if (askSeqRaw !== undefined && (!Number.isInteger(askSeqRaw) || (askSeqRaw as number) < 1)) {
          throw badRequest(`askSeq 必须是 >= 1 的整数（human/asked 的 seq），收到 ${String(askSeqRaw)}`);
        }
        const by = typeof payload['by'] === 'string' && payload['by'] !== '' ? payload['by'] : 'human';
        const outcome = answerHuman({
          events: await readAllEvents(this.deps.log),
          answer,
          by,
          ...(callId !== undefined ? { callId } : {}),
          ...(askSeqRaw !== undefined ? { askSeq: askSeqRaw as number } : {}),
          now,
          write: (type, data, visibility) => this.appendSync(type, data, visibility).seq,
        });
        if (!outcome.ok) throw badRequest(outcome.error, 'answer-rejected');
        sendJson(res, 200, {
          ok: true,
          seq: outcome.answerSeq,
          planCallId: outcome.planCallId,
          planOutcome: outcome.planOutcome,
          planResolvedSeq: outcome.planResolvedSeq,
        });
        return;
      }
      case 'grant-decide': {
        // 用户在界面上对一张**她的申请单**点头或摇头（2026-10-11）。
        //
        // 这个端点**不新开审批原语**：它内部就是 `answerHuman`（与 `POST /api/commands/answer`
        // 逐字同一份实现）——写 `human/answered`（驳回时理由在 `reject:<理由>` 里）+ 精确配对的
        // `askSeq`。之后才轮到本通道自己的那一步：**框架执行**（`resolveGrant`）。
        //
        // ⚠ 顺序是判据，不能换：**先答复、再执行**。执行失败时日志里仍然留着"人批准过"这个
        // 事实（他确实点了），而"批了但没装成"由 `grant/resolved.exec` 那一格如实说。
        // 反过来（先执行、后答复）一旦答复写失败，就会出现"配置被改了、但没有任何人批准过它"。
        //
        // 幂等靠**事件状态**：`answerHuman` 找不到那张还在台面上的 `human/asked` 就报错
        // （`askSeq 不在台面上`），所以第二次点批准不会重复落地——不靠内存记账。
        const id = typeof payload['id'] === 'string' ? payload['id'].trim() : '';
        if (id === '') throw badRequest('缺少 id（申请单号，就是 data/grants 下那个文件名）');
        const decision = payload['decision'];
        if (decision !== 'approve' && decision !== 'reject') {
          throw badRequest('decision 只能是 approve 或 reject');
        }
        const reasonRaw = typeof payload['reason'] === 'string' ? payload['reason'].trim() : '';
        if (reasonRaw.length > GRANT_REJECT_REASON_MAX) {
          throw badRequest(`理由最多 ${GRANT_REJECT_REASON_MAX} 字，收到 ${reasonRaw.length} 字`);
        }
        if (decision === 'approve' && reasonRaw !== '') {
          throw badRequest('批准不带理由（理由栏目只在驳回时用得到）');
        }

        const events = await readAllEvents(this.deps.log);
        const item = listGrants(grantsDirOf(this.deps.dataDir), events, this.deps.projection.humanAsks)
          .find((row) => row.id === id);
        if (item === undefined) {
          throw notFound(
            `申请单 ${id} 不在清单里（可能已被处理，或还没被拾取）：先 GET /api/grants 核对`,
            'grant-not-found',
          );
        }
        if (item.outcome !== null) {
          throw new HttpError(
            409,
            'grant-already-decided',
            `申请单 ${id} 已经有结局了（${item.outcome}，${item.outcomeAt ?? '时间未知'}）：`
            + '同一个决定只可能有一次终局，这一张不用再点。',
          );
        }
        if (!item.picked || item.askSeq === null) {
          throw new HttpError(
            409,
            'grant-not-picked',
            `申请单 ${id} 还没被框架拾取（${item.requestedAt === null ? '它刚写下来，或它没通过校验' : '缺 askSeq'}）：`
            + '等下一拍（心跳每拍都会扫一次那个目录）再点。',
          );
        }
        /**
         * **第二次点同一张卡 ⇒ 到这里就 409，不进 `answerHuman`。**
         *
         * 为什么非要先拦一道（2026-10-11 实测发现的洞）：`answerHuman` 的幂等判据是"那条
         * `human/asked` 还在不在台面上"（`openHumanAsks`）。**她问的**那些提问答复一次就出队，
         * 那条判据管用；但待批这条路上的提问是 `source: 'system'`——它一旦被某一轮认领、那一轮
         * 因此挂起，`answerHuman` 就会从"挂起中的提问"那一支把它再认下一次
         * （`scan.waiting ?? scan.answered?.suspension`，见 `plan-mode.ts` 的选择顺序）。
         * 实测（`_tmp/dbg-idem.ts`）：第二次点仍然 `ok: true`，又写了一条 `human/answered`。
         * ⇒ 幂等**由这一格自己兜**：`grant/resolved` 已经落过 = 这张卡点过了。
         * 判据是**事件状态**（进程重启之后照样成立），不是内存记账。
         */
        if (events.some((event) => event.type === 'grant/resolved' && event.data.id === id)) {
          throw new HttpError(
            409,
            'grant-already-decided',
            `申请单 ${id} 已经答复过了（一张单子只可能有一次终局）：`
            + '要再看结果就刷新「待批」那一段，它会显示批准/驳回与执行结果。',
          );
        }

        // ① 答复（复用既有通道；`reject:<理由>` 的形状读的是 `answerIntentOf` 的既有判据）
        const answer = decision === 'approve' ? 'approve' : `reject:${reasonRaw}`;
        const outcome = answerHuman({
          events,
          answer,
          by: 'human',
          askSeq: item.askSeq,
          now,
          write: (type, data, visibility) => this.appendSync(type, data, visibility).seq,
        });
        if (!outcome.ok) throw badRequest(outcome.error, 'grant-decide-rejected');

        // ② 执行（**只有批准才执行**；驳回是"不做这件事"，没有可执行的东西）
        const exec: GrantApplyResult = decision === 'approve'
          ? await applyGrant({
            dataDir: this.deps.dataDir,
            configPath: this.configPath,
            id,
            requestedHash: requestedHashOf(events, id),
            // 技能那一支的落地根：与 `skill-create` / `removeSkill` 读的是**同一个**根
            // （`this.deps.skillsRoot ?? process.cwd()`，两处一处口径）
            skillsRoot: this.deps.skillsRoot ?? process.cwd(),
            now: () => now,
          })
          : { state: 'not-applicable' };

        // ③ 留痕：`grant/resolved`（人的决定 + 框架执行的结果，两格分开）
        const resolved = this.appendSync('grant/resolved', {
          id,
          askSeq: item.askSeq,
          kind: item.kind,
          name: item.name,
          outcome: decision === 'approve' ? 'approved' : 'rejected',
          by: 'human',
          // 批准时 null（没有"批准理由"这回事）；驳回时是**人写的那句话**（允许为空串）
          reason: decision === 'approve' ? null : reasonRaw,
          contentHash: requestedHashOf(events, id),
          exec,
        }, 'internal');

        /**
         * ③b **技能装成了 ⇒ 写信任门那条凭据**（`skill/installed{by:'human'}`）。
         *
         * 为什么非写不可：技能目录光是存在**进不了 catalog**——信任门的凭据是日志里那条
         * `skill/installed`（`skill/skills.ts` 的 `trustOf`），而 `by:'human'` 的语义在这里
         * 恰好是对的：**是人批的**。不写它，她下一拍还是看不见这个技能，
         * 而界面上会一直显示"未确认"——那正是"装了但没生效"最难查的形状。
         *
         * 为什么由**框架**写而不是让她自己调 `SkillManager.install`：那一路的语义是
         * `by:'agent'`（记录"它会做什么"），**不构成信任**。人批过的东西就该由框架以人的名义落。
         *
         * 只对 `skill-install` 且 `exec.state === 'ok'` 写：删除不需要确认（目录都没了），
         * 失败/拒执行更不该把一份没落地的东西标成"已确认"。
         */
        let skillInstalledSeq: number | null = null;
        if (item.kind === 'skill-install' && exec.state === 'ok') {
          const manager = new SkillManager({ baseRoot: this.deps.skillsRoot ?? process.cwd() });
          // 凭据的**内容**由技能系统自己算（`buildInstalledData`：名字 + 路径 + 内容哈希）——
          // 这一格不能自己拼：`contentHash` 就是信任门的变更检测凭据，拼错一个字节
          // 就会让这个技能在下一拍变成"确认后已变更"。
          const data = manager.buildInstalledData(item.name, 'human');
          if (data === null) {
            this.write(
              `[web] 申请单 ${id} 落地成功，但 skill/installed 没写成`
              + `（扫描器不认 ${item.name}？）：她下一拍看不见这个技能。`,
            );
          } else {
            // 事件走**本进程的写入通道**（`appendSync`）而不是 `manager.install`：
            // 后者的写入口是装配期注入的 `emit`，web 层这个 manager 手上没有它——
            // 调它等于"记了却没人看见"（那正是最难查的那种静默失效）。
            skillInstalledSeq = this.appendSync('skill/installed', data, 'internal').seq;
          }
        }

        // ④ 结局落一份到她读得到的地方（写不动**不许**影响这次决定：盘已经改好了）
        const facts: GrantWakeFacts = {
          id, kind: item.kind, name: item.name,
          outcome: decision === 'approve' ? 'approved' : 'rejected',
          reason: decision === 'approve' ? null : reasonRaw,
          exec,
        };
        // "要不要重启"走**那一格唯一的那份判据**（`mcpRestartOutcome` 的方法头）：
        // 批准这条路写的就是 `mcp.servers`；驳回时什么都没写 ⇒ `changedAnything: false`
        // （它的第一种情形：没有要生效的东西，不必重启）。
        const restart = this.mcpRestartOutcome({
          changedAnything: exec.state === 'ok',
          appliedFields: ['mcp.servers'],
        });
        const wroteOutcome = writeGrantOutcome(this.deps.dataDir, {
          id,
          outcome: decision === 'approve' ? 'approved' : 'rejected',
          by: 'human',
          at: now.toISOString(),
          reason: facts.reason,
          exec,
          note: '这份文件是框架写的（结局），不是你要交的申请单；申请单在 grants/ 下。',
        });

        // ⑤ 真唤醒（与 `wakeForMcpChange` 同一条路；发不出去也不许把一次成功的落地变成 500）
        const wakeSeq = wakeForGrant({
          facts,
          nowMs: now.getTime(),
          append: (data) => this.appendSync('wake/manual', data, 'model').seq,
          onError: (message) => {
            this.write(`[web] 申请单 ${id} 的结局已落库，但那条唤醒没发出去（落地不受影响）：${message}`);
          },
        });

        sendJson(res, 200, {
          ok: true,
          id,
          outcome: facts.outcome,
          askSeq: item.askSeq,
          answerSeq: outcome.answerSeq,
          resolvedSeq: resolved.seq,
          // 技能装成了的话，信任门那条凭据的 seq（没写就是 null——回执里如实说"没生效"）
          skillInstalledSeq,
          exec,
          // 回执里**如实说**这几件事有没有真的发生（人在界面上会问"她知道了没"）
          outcomeWritten: wroteOutcome,
          woken: wakeSeq !== null,
          wakeSeq,
          // "要不要重启"**不在这里另写一套判据**：`mcp.servers` 那一格的判据全仓只有一处
          // （`mcpRestartOutcome` 的方法头）。批准这条路上写的就是 `mcp.servers`，
          // 所以直接消费它的结论——接线活着时它是 `false`（热更接住了），没接线才是 `true`。
          restartRequired: restart.required,
          restartNote: restart.note,
          receipt: grantReceiptLine(facts),
        });
        return;
      }
      case 'requeue': {
        const inputSeq = Number(payload['inputSeq']);
        if (!Number.isInteger(inputSeq) || inputSeq < 1) {
          throw badRequest(`inputSeq 必须是 >= 1 的整数，收到 ${String(payload['inputSeq'])}`);
        }
        const dead = this.deps.projection.deadLetters.find((item) => item.inputSeq === inputSeq);
        if (dead === undefined) {
          throw notFound(`seq ${inputSeq} 不在死信队列里`, 'dead-letter-not-found');
        }
        const original = this.deps.log.get(inputSeq);
        const source: WakeSource = original === null ? 'manual' : wakeSourceOf(original.type);
        const event = this.appendSync('input/requeued', {
          wakeSeqs: [inputSeq],
          // 人工重入队 = 给一次完整的新机会：认领计数归零（否则下一次失败立刻再进死信）
          claimCounts: [0],
          sources: [source],
          reason: 'startup-recovery',
        }, 'internal');
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, inputSeq, source });
        return;
      }
      case 'discard': {
        // 丢弃死信（`input/discarded`）：**只标记为已处理，不删记录**。
        //
        // 与 requeue 是同一格抽屉的两面（同一形状的载荷 {inputSeq}）：
        //   · requeue  = 再给一次机会（回到 pending）；
        //   · discard  = 到此为止（输入有意作废）。
        // 两条都销掉同一条死信，所以第二条必然撞 404——同一个 inputSeq 只可能有一次终局，
        // 这就是幂等的落点（判据是**当刻的投影**，不靠内存记账）。
        const inputSeq = Number(payload['inputSeq']);
        if (!Number.isInteger(inputSeq) || inputSeq < 1) {
          throw badRequest(`inputSeq 必须是 >= 1 的整数，收到 ${String(payload['inputSeq'])}`);
        }
        const dead = this.deps.projection.deadLetters.find((item) => item.inputSeq === inputSeq);
        if (dead === undefined) {
          throw notFound(`seq ${inputSeq} 不在死信队列里（可能已经重投或丢弃）`, 'dead-letter-not-found');
        }
        const reasonRaw = payload['reason'];
        const reason = typeof reasonRaw === 'string' && reasonRaw.trim() !== ''
          ? reasonRaw.trim()
          : '人工丢弃：不再重投';
        if (reason.length > DISCARD_REASON_MAX) {
          throw badRequest(`reason 最多 ${DISCARD_REASON_MAX} 字，收到 ${reason.length} 字`);
        }
        const byRaw = payload['by'];
        const by = typeof byRaw === 'string' && byRaw.trim() !== '' ? byRaw.trim() : 'human';
        // **留痕**：死信是"已经发生过的事实"，丢弃是"人决定不再重投"——后者落成自己的事件，
        // 前者一个字都不动（`input/dead-letter` 照旧在日志里）。claimCount 从投影里那条记录抄，
        // 不另算一遍：人回看时"它试了几次"要与死信那条说同一个数。
        const event = this.appendSync('input/discarded', {
          inputSeq,
          claimCount: dead.claimCount,
          reason,
          by,
        }, 'internal');
        sendJson(res, 200, {
          ok: true, seq: event.seq, type: event.type, inputSeq, claimCount: dead.claimCount,
        });
        return;
      }
      case 'persona-approve': {
        const file = typeof payload['file'] === 'string' ? payload['file'] : '';
        const diffHash = typeof payload['diffHash'] === 'string' ? payload['diffHash'] : '';
        if (file === '') throw badRequest('缺少 file');
        const safe = safePersonaRel(file);
        const target = personaTargetPath(this.deps.personaRoot, safe);
        const proposalPath = personaTargetPath(
          this.deps.personaRoot,
          `${PERSONA_PROPOSAL_DIR}/${safe}`,
        );
        const proposal = statOrNull(proposalPath);
        if (proposal.content === null) {
          throw notFound(
            `没有找到 ${safe} 的提案文件（${PERSONA_PROPOSAL_DIR}/${safe}）：`
            + '批准的对象必须是 agent 写下的提案，不存在的提案不能"被批准"',
            'proposal-not-found',
          );
        }
        const proposalHash = sha256Hex(proposal.content).slice(0, 16);
        if (diffHash !== '' && diffHash !== proposalHash) {
          throw new HttpError(
            409,
            'stale-proposal',
            `提案内容与你批准的 diffHash 不一致（当前提案 hash ${proposalHash}，收到 ${diffHash}）：`
            + '提案可能在你审阅期间被改写，请重新看一眼',
          );
        }
        writeFileAtomicSync(target, proposal.content);
        try {
          unlinkSync(proposalPath);
        } catch {
          // 目标文件已就位；提案残留只会让"未决提案"计数偏高，留痕不致命
          this.write(`[web] 提案文件删除失败（下次会再次出现在未决列表里）：${proposalPath}`);
        }
        const event = this.appendSync(
          'persona/updated',
          { file: safe, diffHash: proposalHash, by: 'human' },
          'internal',
        );
        this.deps.onPersonaUpdated?.();
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, file: safe, diffHash: proposalHash });
        return;
      }
      case 'config-update': {
        const result = await this.applyConfigUpdate(payload, phrases);
        // 生效那一份**一个字都没变**：热更白名单现在是空的——所有字段都要重启才生效
        // （为什么清空，见 `config/watcher.ts` 的文件头）。所以事件里记的是**生效配置**的指纹，
        // 另加 `requiresRestart: true` 把这层意思说出口。过去这里记的是盘上那份的新指纹，
        // 于是日志里写着"配置变了"，而进程还在按旧的跑——replay 拿它比对时也跟着对不上。
        const effectiveHash = configHash(this.deps.config);
        const event = this.appendSync(
          'config/changed',
          { fields: result.fields, configHash: effectiveHash, requiresRestart: true },
          'internal',
        );
        sendJson(res, 200, {
          ok: true, seq: event.seq, type: event.type,
          fields: result.fields,
          configHash: effectiveHash,
          savedConfigHash: result.configHash,
          requiresRestart: true,
          path: this.configPath,
        });
        return;
      }
      case 'set-mention-keywords': {
        // 「她被怎么称呼」（关键词匹配）：群里的人常不打 @ 直接喊名字，平台不会把那种句子
        // 标成"提到了机器人"——所以由人给几个词，正文里出现就当作在叫她（见 channel/inbox.ts）。
        //
        // 为什么单开一条命令而不是走 config-update：它写的是**数组**，而 config-update 把值
        // 整段替换（点路径语义）——一条错写的请求就能把整份名单换掉；这里把校验做在门口
        // （字符串数组、逐个 trim/去重，超限报错），并且顺带**热更**运行期那份。
        const raw = payload['keywords'];
        if (!Array.isArray(raw)) {
          throw badRequest('缺少 keywords（字符串数组；空数组 = 只认平台的 @）');
        }
        const cleaned: string[] = [];
        for (const item of raw) {
          if (typeof item !== 'string') throw badRequest('keywords 里只允许字符串');
          const word = item.trim();
          if (word === '') continue;
          if (!cleaned.includes(word)) cleaned.push(word);
        }
        if (cleaned.length > MENTION_KEYWORD_MAX) {
          throw badRequest(`最多 ${MENTION_KEYWORD_MAX} 个词（收到 ${cleaned.length} 个）`);
        }
        for (const word of cleaned) {
          if ([...word].length > MENTION_KEYWORD_LEN_MAX) {
            throw badRequest(`「${word.slice(0, 12)}…」太长（上限 ${MENTION_KEYWORD_LEN_MAX} 字）：要填的是"她可能被怎么称呼"`);
          }
        }
        await this.withConfigDoc((doc) => {
          const channels = isRecord(doc['channels']) ? doc['channels'] as JsonObject : {};
          channels['mentionKeywords'] = cleaned;
          doc['channels'] = channels;
          return cleaned;
        }, 'channels.mentionKeywords');
        const event = this.appendSync(
          'config/changed',
          { fields: ['channels.mentionKeywords'], configHash: sha256Hex(JSON.stringify(cleaned)).slice(0, 16) },
          'internal',
        );
        // 热更：回调在的话这一拍就生效（判据读的是运行期那份），不在就如实说"要重启"
        this.deps.onMentionKeywords?.(cleaned);
        sendJson(res, 200, {
          ok: true, seq: event.seq, type: event.type, keywords: cleaned,
          restartRequired: this.deps.onMentionKeywords === undefined,
        });
        return;
      }
      case 'restart': {
        // 运行情况页那颗按钮（原来这里是"立即唤醒"，用户 2026-10-04 说那个没用了，改成重启）。
        //
        // 四条纪律：
        //   • **延迟到"这次回执已经能说清楚"之后才动手**：让 HTTP 回执先发出去，界面不至于
        //     拿到一个断掉的连接（过去写死两秒，而回执要等脚本把新实例的 pid 写出来——
        //     两秒不够，于是界面拿到的是一个断掉的连接 + 一句"重启没能确认"）。
        //     现在的延迟由 `IRMIA_RESTART_DELAY_MS` 给（默认 = 确认窗口 + 4 秒余量）；
        //   • 用 WMI 起**分离**的 `cmd /c` → pwsh 去跑 tools/restart-agent.ps1——本进程不能
        //     自己重启自己，而那条脚本里写着"只杀主进程、不碰 SnowLuma"（协议端登录态杀了
        //     要人重登）。**必须是 `cmd /c` 那一层**：直接建 pwsh 时 `Win32_Process.Create`
        //     返回 0 而脚本一个字都不执行（2026-10-07 的现场，见 `restartCommandLine`）；
        //   • 界面路径由调用方给（`guiExe`）：脚本不该猜界面装在哪。**给了路径就必须留痕**
        //     （见下面那段"留痕"注释：用户 2026-10-05 说按了按钮"没有任何日志痕迹，
        //     无法判断请求有没有带界面路径"）；
        //   • 路径在盘上不存在时**当场拒绝**，绝不悄悄降级成"只重启后端"——
        //     界面按契约带上路径，就是要求连界面一起重启；做不到要说出来
        //     （用户 2026-10-05：「所谓的'重启前后端'也没有重启前端」）。
        const guiRaw = payload['guiExe'];
        const guiExe = typeof guiRaw === 'string' ? guiRaw.trim() : '';
        const guiExeExists = guiExe !== '' && existsSync(guiExe);
        if (guiExe !== '' && !guiExeExists) {
          this.appendSync(
            'config/changed',
            {
              fields: ['restart'], configHash: 'restart-rejected-bad-gui-exe',
              guiExe, guiExeExists: false,
            },
            'internal',
          );
          this.write(`[重启] 拒绝：请求带了 guiExe=${guiExe}，但盘上没有这个文件——`
            + '界面按契约带路径就是要求连界面一起重启，做不到就不装作做到了。一个进程都没动');
          throw badRequest(
            `重启请求带了界面路径，但那个文件不存在：${guiExe}。`
            + '没有重启任何东西（宁可什么都不做，也不把"只重启了后端"说成"重启了前后端"）。',
            'restart-bad-gui-exe',
          );
        }
        const repo = dirname(this.configPath);
        // ── 走哪一条：`restart-chain.ts` 的优先级链（**唯一一处判据**）────────────────
        //
        // 用户 2026-10-07 报的「beta5 内测包重启不了」就出在这一行上：过去这里写死
        // `join(repo, 'tools', 'restart-agent.ps1')`，而**装出来的那份根本没有 `tools\`**
        // ——于是重启必然失败（隔离复现的 pwsh 原话见 `restart-chain.ts` 的文件头）。
        // 现在按"仓库脚本 → 随包脚本 → 自重启"三级挑，**装出来的那份不依赖仓库里才有的东西**。
        const choice = chooseRestartPath(repo, { fileExists: existsSync });
        const selfRestart = choice.path === 'self-restart';
        // 留痕文件：**脚本与这里约定同一个路径**（`<dataDir>/restart-trace.log`）。
        // 为什么由服务端显式传：脚本的默认值只能靠 `-Repo` 推，而 `-Repo` 本身也是别人给的；
        // 两处各推一次就会出现"服务端读 A、脚本写 B"的分岔，而这条留痕的全部意义就是"能对上"。
        const traceLog = join(this.deps.dataDir, 'restart-trace.log');
        const traceLogAt = existsSync(traceLog) ? statSync(traceLog).size : -1;
        // **只重启界面**（`guiOnly: true`）：一个后端进程都不动。
        // 用户 2026-10-07 的第 ③ 条要求是"不许出现没有任何消费者的死路"，而这里还有一层
        // 更要紧的理由：让一个**正在服务这次请求**的后端"重启自己"，响应必然断在半路，
        // 界面就只剩"没反馈"可看。这条分支把那种形状留成一个**明路**：界面单独重开，
        // 后端照旧服务（连接不断、这次响应一定送达），重启的仍然是真的重启。
        const guiOnly = payload['guiOnly'] === true;
        // 请求发起前 lock.json 里的 pid：判"她是不是真的换了个人"的基线（0 = 本来没在跑）。
        const previousBackendPid = ((): number => {
          try {
            const lock = JSON.parse(readFileSync(join(this.deps.dataDir, 'lock.json'), 'utf8')) as { pid?: unknown };
            return typeof lock.pid === 'number' ? lock.pid : 0;
          } catch {
            return 0;
          }
        })();
        // 每个参数各自加引号（路径带空格时也必须是一个参数）。`"pwsh" -File "a b.ps1" -GuiExe "c d.exe"`
        // 在 PowerShell 里逐字对应四条参数，不会把路径拆成两截。
        //
        // 为什么不用 `--%`（逐字传参、听起来更稳）：实测它在**带引号的 `-File` 路径**上反而被
        // 当成字面量（`Processing -File '"…"' failed: Illegal characters in path`），
        // 而重启这条路上任何一点不确定都不该引入。逐参数引号这条路已经在本机验过
        // （见 _research/probe-restart-chain.ps1：`-GuiExe` 那一段完整送达）。
        const q = (value: string): string => `"${value}"`;
        // 脚本自己（cmd 那一层）的 stdout/stderr 落点：过去随 WMI 进程一起消失，
        // 于是"脚本报了错"这件事在留痕之外完全看不见（失败无声的另一半）。
        // 与 -TraceLog 同一个约定：路径由服务端给，脚本不猜。
        const scriptLog = join(this.deps.dataDir, 'restart-script.log');
        // **延迟多久才动手**：这次请求的响应必须先回到界面，否则界面拿到的是一个断掉的连接，
        // 人看到的就是"点了没反馈"。而响应的内容里要带上"脚本有没有起来 / 后端有没有换 pid"
        // ——那要等脚本跑起来、等新实例把自己的 lock 写出来，所以等待窗口比过去（400ms）长。
        // 于是延迟必须**盖过那个窗口**：窗口多少，这里就等多少，再加一段余量给"响应真的送达"。
        // （两端都能用环境变量调：IRMIA_RESTART_CONFIRM_MS / IRMIA_RESTART_DELAY_MS。）
        const delaySeconds = ((): number => {
          const raw = Number(process.env['IRMIA_RESTART_DELAY_MS'] ?? '');
          if (Number.isFinite(raw) && raw > 0) return Math.round(raw / 1000);
          return Math.ceil(RESTART_RECEIPT_WAIT_MS / 1000) + 4;
        })();
        // **绝对路径的入口**：她起不来的一半原因曾经是"相对路径 + 指望工作目录"。
        // 本机实测（2026-10-07）：`Win32_Process.Create` 出来的进程里，`cmd /c cd` 回显的
        // 是传进去的那个目录，而 `node dist/main.js` 就是找不到文件、悄无声息退出——
        // 症状与"按钮点了什么都没发生"一模一样。凡是能被绝对化的路径全部绝对化。
        const nodeEntry = backendEntry(repo);
        // 探回环地址：服务端可能只听 `0.0.0.0` / `::`（那时这两个不是能直接连的地址）。
        // 与 `tools\restart-agent.ps1` 里那段同一个口径（同一件事不写两份判据）。
        const host = this.host === '0.0.0.0' || this.host === '::' ? '127.0.0.1' : this.host;
        const scriptArgv: string[] = [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', q(choice.file),
          '-Repo', q(repo),
          '-NodeEntry', q(nodeEntry),
          ...(guiExe === '' ? [] : ['-GuiExe', q(guiExe)]),
          ...(guiOnly ? ['-GuiOnly'] : []),
          '-TraceLog', q(traceLog),
          '-ScriptLog', q(scriptLog),
          '-DelaySeconds', String(delaySeconds),
        ];
        // 随包脚本多收三条：它要自己探端口（`-Port`/`-ProbeHost`）与新实例输出的落点（`-OutLog`）。
        // **不把这些塞给仓库脚本**：`tools\restart-agent.ps1` 没有这三个参数，
        // 多送一个就会以"找不到参数"直接失败——开发机这条路上不许有任何行为变化。
        //
        // 参数名是 `-ProbeHost` 而不是 `-Host`：`$Host` 是 PowerShell 的**只读自动变量**，
        // 参数名撞上它时脚本在**参数绑定阶段**就退出（正文一个字都不执行，症状与"脚本没起来"
        // 一模一样）——2026-10-08 的隔离端到端就是这么抓到它的。
        if (choice.path === 'packaged-script') {
          scriptArgv.push('-Port', String(this.portWanted));
          scriptArgv.push('-ProbeHost', q(host));
          scriptArgv.push('-OutLog', q(join(this.deps.dataDir, 'restart-backend.log')));
        }
        // 谁来跑这个脚本：`resolveRestartShell` 按"显式指定 → PATH → 标准安装目录 → 系统自带"
        // 四级探测（见 `runtime/restart-shell.ts` 的文件头）。
        //
        // 这里过去写死的是一条本机私事：`existsSync('C:\\path\\to\\pwsh.exe') ? … : 'powershell.exe'`。
        // 它在开发机上永远命中、在任何别人机器上永远不命中——而"WMI 建进程的环境里没有 PATH"
        // 这件事要求我们**给出一个真的存在的绝对路径**，不能靠猜；探测失败时用
        // `powershell.exe`（在 System32 里，WMI 环境也找得到；脚本按 5.1 兼容写，兜底是安全的）。
        //
        // `self-restart` 这一条**不用 shell**：它拉起的是 `runtime\node\node.exe` 跑框架自己的
        // 拉起器（`dist\runtime\restart-worker.js`）——于是"没有 pwsh / 没有脚本"的机器上
        // 这条路照样成立（这正是它存在的理由），而 `cmd.exe /s /c "…"` 那一层照旧不变。
        const workerLog = join(this.deps.dataDir, 'restart-worker.log');
        let command: string;
        if (selfRestart) {
          // 拉起器是随 dist 装配的框架产物：**没有它就不能假装自重启能用**（如实拒绝，见下）。
          if (!existsSync(choice.file)) {
            this.appendSync(
              'config/changed',
              {
                fields: ['restart'], configHash: 'restart-self-worker-missing',
                guiExe, guiExeExists, path: choice.path, worker: choice.file,
              },
              'internal',
            );
            this.write(`[重启] 拒绝：两条脚本都不在（${choice.why}），而自重启的拉起器也没装进来`
              + `（${choice.file}）——一个进程都没动`);
            throw badRequest(
              `这份安装里既没有仓库脚本（tools\\restart-agent.ps1）也没有随包脚本（restart.ps1），`
              + `而自重启的拉起器也不在：${choice.file}。没有重启任何东西`
              + '（这份 dist\\ 不是本版编出来的：拉起器随 dist\\ 一起装配）。',
              'restart-self-worker-missing',
            );
          }
          const nodeExe = existsSync(join(repo, BUNDLED_NODE_REL))
            ? join(repo, BUNDLED_NODE_REL)
            : process.execPath;
          // **发起**这一行先落进留痕（它不是 `[回执]`：回执只能由真的跑起来的那一方写，
          // 所以这一行故意不含 `[回执]`——否则"拉起器到底起没起来"就再也证明不了了）。
          try {
            appendFileSync(traceLog, restartTraceLine('发起',
              `路径=${choice.path} · 由服务端发起 pid=${process.pid} · 拉起器=${choice.file}`
              + ` · 出口=${nodeEntry} · node=${nodeExe}`), 'utf8');
          } catch {
            // 留痕写不下去不算错（重启本身比留痕重要）
          }
          const workerArgv: string[] = [
            q(choice.file),
            '--old-pid', [process.pid, previousBackendPid]
              .filter((pid, index, all) => pid > 0 && all.indexOf(pid) === index).join(','),
            '--root', q(repo),
            '--node', q(nodeExe),
            '--entry', q(nodeEntry),
            '--trace', q(traceLog),
            '--out', q(join(this.deps.dataDir, 'restart-backend.log')),
            '--data-dir', q(this.deps.dataDir),
            '--host', q(host),
            '--port', String(this.portWanted),
            ...(guiExe === '' ? [] : ['--gui-exe', q(guiExe)]),
            ...(guiOnly ? ['--gui-only'] : []),
            '--wait-ms', String(RESTART_RECEIPT_WAIT_MS * 4),
            '--port-wait-ms', String(RESTART_RECEIPT_WAIT_MS * 4),
          ];
          command = restartCommandLine({ shellExe: nodeExe, argv: workerArgv, scriptLog: workerLog });
        } else {
          const shellExe = resolveRestartShell({ env: process.env, fileExists: existsSync });
          command = restartCommandLine({ shellExe, argv: scriptArgv, scriptLog });
        }
        const wmi = `$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance(); $si.ShowWindow = 0; `
          + `$c = ([wmiclass]'Win32_Process').Create('${command.replace(/'/gu, "''")}', '${repo.replace(/'/gu, "''")}', $si); exit $c.ReturnValue`;
        // ── 留痕（2026-10-05 加，用户报"按钮那条路没有任何日志痕迹"）──
        //
        // 按下按钮之后能查到的只有一条 `config/changed{fields:['restart']}`，而它的 hash 是
        // 时间戳——**看不出这次请求有没有带界面路径**。于是"界面到底有没有被重启"在事后
        // 完全无法证伪：脚本的 stdout 随 WMI 进程消失（WMI 建的进程不带控制台），
        // 事件里也没有这个字段。
        //
        // 现在把四件事写下来（两处，同一份内容）：① `guiExe` 的**值**与它在盘上存不存在；
        // ② WMI 实际要执行的**完整命令行**；③ spawn 的结果（WMI 返回码 + stderr）；
        // ④ **脚本有没有真的跑起来**——由脚本自己写的那行 `[回执]` 判定。
        // 一处进事件日志（可查询、可回放），一处进服务端 stdout（本机 console 日志）。
        const trace = (): string => `路径=${choice.path}（${choice.why}）`
          + ` · guiExe=${guiExe === '' ? '（空：只重启后端）' : guiExe}`
          + ` · 盘上存在=${guiExeExists} · 命令行=${command}`;
        const created = spawnSync('powershell.exe', ['-NoProfile', '-Command', wmi], { encoding: 'utf8' });
        const createdDetail = `status=${created.status === null ? '未知' : created.status}`
          + ` stderr=${(created.stderr ?? '').trim()}`;
        if (created.status !== 0) {
          this.write(`[重启] 启动失败：${trace()} · ${createdDetail}`);
          this.appendSync(
            'config/changed',
            {
              fields: ['restart'], configHash: 'restart-failed',
              guiExe, guiExeExists, command, path: choice.path, wmiStatus: created.status,
              wmiError: (created.stderr ?? '').trim(), reason: RESTART_FAILURE_REASONS.wmiFailed,
            },
            'internal',
          );
          throw badRequest(
            `重启没能启动（${choice.path}：WMI 返回码 ${created.status === null ? '未知' : created.status}）：`
            + `${(created.stderr ?? '').trim()}`,
            'restart-failed',
          );
        }
        // **回执判定**：WMI 返回码 0 **不等于脚本跑起来了**。
        //
        // 本仓实测（_research/probe-restart-chain.ps1 + 2026-10-07 的复现）：
        // `Win32_Process.Create` 对一个随后什么都没做的命令**照样返回 0**——
        // 2026-10-07 的现场就是这条：返回码 0、pid 也有，而 `data/restart-trace.log`
        // 一条新行都没有、`data/lock.json` 里的 pid 从头到尾没变（后端根本没被重启）。
        // 直接送 `"…pwsh.exe" -File …` 必失败、套 `cmd.exe /c "…"` 才真的跑起来
        // （见 `restartCommandLine` 的文件头）。
        //
        // 所以这里多问一句**链条自己**：脚本/拉起器第一件事写 `[回执]`，后端换了 pid 时写 `[实例]`，
        // 收尾写 `[结束]`（带真 pid、端口那一档、**走的哪条路径**与失败是哪一环）。读到哪一行就说到哪一步——
        // **三态不许互相冒充**（用户 2026-10-07：「不许用'猜'的确认」）。
        //
        // 等哪一行按路径分：
        //   · 脚本那两条（repo-script / packaged-script）：`[实例]`（后端换了 pid，几秒内必到）
        //     或 `[结束]`（收尾那行），谁先到算谁；
        //   · self-restart：只等拉起器的 `[回执]`——它**必然**比新实例先出现（新实例要等旧实例退出），
        //     所以这一档的响应说的是"已发出、结局未确认"，而 `[实例]`/`[结束]` 由拉起器在
        //     服务端退出之后写进同一份留痕（那时没有 HTTP 连接可用了，但**证据还在盘上**）。
        // 等不到就如实说"结局还没确认"（或"没能执行"），而不是编一个"成功"。
        const { parsed, confirm } = confirmRestart({
          traceLog, sizeBefore: traceLogAt, guiOnly,
          previousBackendPid,
          // 探回环地址：服务端可能只听 `0.0.0.0` / `::`（那时这两个不是能直接连的地址）。
          // 与 `tools/restart-agent.ps1` 里那段同一个口径（同一件事不写两份判据）。
          host,
          port: this.portWanted,
          dataDir: this.deps.dataDir,
          markers: selfRestart ? ['[回执]'] : ['[实例]', '[结束]'],
          // self-restart 时探到的"端口有人在服务"是**旧实例（本进程）自己**——
          // 把它算成"新实例已就绪"就是编事实，所以这一档不探（结论只能来自拉起器的 `[结束]`）。
          probePort: !selfRestart,
        });
        const scriptStarted = confirm.scriptStarted;
        // 真实新 pid：脚本那行 `[实例]`/`[结束]` 是首选；还没有时退到 `data/lock.json`
        // ——它是她启动后自己写的 {pid, startedAt, heartbeatAt}，比任何"壳的 pid"都真。
        const backendPid = confirm.backendPid;
        const outcome = {
          gui: guiExe !== '', scriptStarted,
          ok: confirm.ok, backendPid, port: confirm.port,
          reason: parsed.reason, path: choice.path,
        };
        const note = restartNote(outcome);
        const chainName = selfRestart ? '拉起器' : '脚本';
        const receiptText = scriptStarted ? '已确认' : `**没读到**（${chainName}没起来）`;
        const reasonText = parsed.reason === '' ? '' : ` · 坏在=${parsed.reason}`;
        this.write(`[重启] 已发出：${trace()} · ${createdDetail}`
          + ` · 链条回执=${receiptText}`
          + ` · 真 pid=${backendPid === 0 ? '未读到' : backendPid} · 端口=${confirm.port}`
          + ` · 结尾=${parsed.ok === null ? '未读到' : String(parsed.ok)}`
          + `${reasonText}（${traceLog}）`);
        const event = this.appendSync(
          'config/changed',
          {
            fields: ['restart'], configHash: sha256Hex(String(this.deps.now().getTime())).slice(0, 16),
            // 这几个字段是这次留下的痕：事后要能回答"这次到底带没带界面路径、带了什么、
            // 脚本会收到什么、脚本有没有起来、真 pid 是多少、端口那一档"。
            // 老字段一个不动（`fields` 仍是 `['restart']`），只多几列。
            guiExe, guiExeExists, command, traceLog, scriptStarted,
            backendPid, port: confirm.port, scriptOk: parsed.ok, note,
            // 2026-10-07 加：**这次走的是哪一条**（repo-script / packaged-script / self-restart）。
            // 三条路径的失败症状长得一样（后端没换 pid），而"它当时想走哪条"是事后第一个要回答的
            // 问题——不写，就只能靠现场复现（beta.5 那颗按钮就是这么过来的）。
            restartPath: choice.path, restartFile: choice.file, restartWhy: choice.why,
            ...(parsed.reason === '' ? {} : { restartReason: parsed.reason }),
          },
          'internal',
        );
        // ── self-restart 的收尾：**这个进程现在要优雅退出了** ──────────────────────
        //
        // 三条路径里只有这一条要"旧实例自己让位"：新实例（由拉起器拉起）等的是**本进程消失**
        // （单实例锁与监听端口都只允许一个用户），所以这里必须走**既有退出路径**——
        // 落事件 → `session/end` → 收尾 → **让锁释放**，而不是 `process.exit()` 把锁留在盘上。
        //
        // 延迟与脚本那两条同一个口径（`IRMIA_RESTART_DELAY_MS`）：这次 HTTP 响应必须先回到界面，
        // 否则界面拿到的是一个断掉的连接，人看到的就是"点了没反馈"。
        // 定时器 `unref()`：它不该成为进程继续活着的理由（那正是"锁不释放"的形状）。
        if (selfRestart) {
          const timer = setTimeout(() => {
            this.requestGracefulRestartExit(choice.path);
          }, Math.max(1, delaySeconds) * 1000);
          timer.unref();
        }
        sendJson(res, 200, {
          ok: true,
          seq: event.seq,
          type: event.type,
          // 界面按这两个字段决定 toast 说什么（`gui:false` 时**不许**说"连界面一起重启了"）
          gui: guiExe !== '',
          guiExe,
          // `scriptStarted` 也下发给界面：读到 `false` 时界面说的那句是"**重启未能执行**"
          // （链条根本没跑起来 ⇒ 后端没有被重启），而不是"正在重启"。
          scriptStarted,
          // 三态证据一起下发：真 pid、端口那一档、脚本结尾那行的 ok。界面据此说
          // "成功（真实新 pid …· 端口已就绪）" / "失败（为什么）" / "已发出但结局未确认"。
          backendPid,
          port: confirm.port,
          scriptOk: confirm.ok,
          // 走的哪一条 + 坏在哪一环（界面要能把它显示出来；不写下来就只能靠现场复现）
          path: choice.path,
          ...(parsed.reason === '' ? {} : { reason: parsed.reason }),
          traceLog,
          note,
        });
        return;
      }
      case 'set-group-scene': {
        // 群聊场景：软提醒（默认，框架把风险讲清楚、判断留给她）/ 硬拒绝（本机类工具直接拒）。
        //
        // 与 tool-toggle 同一条纪律：读-改-写整个进 configFileLock，**并且**在同一个临界区里
        // 把内存那份也改掉——real-loop 每轮读的就是内存里这份，所以改完立刻生效、不用重启。
        const hardRefusal = payload['hardRefusal'];
        if (typeof hardRefusal !== 'boolean') {
          throw badRequest('缺少 hardRefusal（true = 硬拒绝，false = 软提醒）');
        }
        await this.withConfigDoc((doc) => {
          const tools = isRecord(doc['tools']) ? doc['tools'] as JsonObject : {};
          tools['groupSceneHardRefusal'] = hardRefusal;
          doc['tools'] = tools;
          (this.deps.config.tools as { groupSceneHardRefusal: boolean }).groupSceneHardRefusal = hardRefusal;
          return hardRefusal;
        }, 'tools.groupSceneHardRefusal');
        const event = this.appendSync(
          'config/changed',
          { fields: ['tools.groupSceneHardRefusal'], configHash: sha256Hex(String(hardRefusal)).slice(0, 16) },
          'internal',
        );
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, hardRefusal });
        return;
      }
      case 'set-warn-exempt': {
        // 框架预警的豁免开关（消息适配器页）。
        //   kind: 'session' —— 单聊按会话豁免（sid）
        //   kind: 'member'  —— 群里按**已注册成员**豁免（groupSid + openid）
        // **群聊整群豁免这条路在这里不存在**：用户定的口径是群里只能按人豁免，
        // 所以不提供 kind: 'group'，界面也不画那个开关。
        const kind = typeof payload['kind'] === 'string' ? payload['kind'] : '';
        const on = payload['on'] !== false; // 缺省视为"开豁免"
        const book = new WarnExemptBook(this.deps.dataDir);
        let changed = false;
        if (kind === 'session') {
          const sid = typeof payload['sid'] === 'string' ? payload['sid'].trim() : '';
          if (sid === '') throw badRequest('缺少 sid（形如 qq:c2c:<openid>）');
          if (!sid.includes(':c2c:')) throw badRequest('只能对单聊会话开豁免（群聊请按成员豁免）');
          changed = book.setSession(sid, on);
        } else if (kind === 'member') {
          const groupSid = typeof payload['groupSid'] === 'string' ? payload['groupSid'].trim() : '';
          const openid = typeof payload['openid'] === 'string' ? payload['openid'].trim() : '';
          if (groupSid === '' || openid === '') throw badRequest('缺少 groupSid 或 openid');
          changed = book.setMember(groupSid, openid, on);
        } else {
          throw badRequest("kind 只能是 'session' 或 'member'");
        }
        if (changed) book.save();
        const event = this.appendSync(
          'config/changed',
          { fields: [`warnExempt.${kind}`], configHash: sha256Hex(String(on)).slice(0, 16) },
          'internal',
        );
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, changed, warnExempt: book.snapshot() });
        return;
      }
      case 'set-group-member': {
        // 群成员改名（消息适配器页 · 会话联系人卡片展开后的每一条）：
        // 写进群成员档案并标成 human —— 从此自动注册不再覆盖他。
        const openid = typeof payload['openid'] === 'string' ? payload['openid'].trim() : '';
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        const groupSid = typeof payload['groupSid'] === 'string' ? payload['groupSid'].trim() : '';
        if (openid === '') throw badRequest('缺少 openid（群成员档案的键，在卡片展开后能看到）');
        if (name === '') throw badRequest('名字不能为空（要清掉一个人，改档案文件即可）');
        const book = new GroupMemberBook(this.deps.dataDir);
        if (groupSid !== '') book.setGroup(openid, groupSid);
        book.setName(openid, name);
        book.save();
        const event = this.appendSync(
          'config/changed',
          { fields: [`groupMembers.${openid}`], configHash: sha256Hex(name).slice(0, 16) },
          'internal',
        );
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, openid, name });
        return;
      }
      case 'set-contact': {
        // 会话联系人（频道页 · 会话列表）：把某个 sid 的名字写进 `config.persona.contacts`。
        //
        // 为什么不走 config-update：contacts 是**映射**，而 config-update 会把嵌套对象
        // 展平成点路径——sid 里带冒号，展平后就成了没有意义的层级（persona.contacts.qq:c2c:X）。
        //
        // 为什么必须有它：QQ 不提供昵称，也没接口查成员，"这个会话是用户"这类知识
        // 只能由人声明；手改 config.json 不是人人都愿意干的事。
        const rawSid = typeof payload['sid'] === 'string' ? payload['sid'].trim() : '';
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (rawSid === '' || !rawSid.includes(':')) {
          throw badRequest('缺少 sid（形如 qq:c2c:<会话 id>；可在频道页的会话列表里看到）');
        }
        // **写入一律用归一形态**（2026-10-02）：sid 的形态已归一（群聊 `qq:group:<群id>`），
        // 这里再写一个 `qq:group-at:` 进去，表里就会同时存在两种写法、下一个人看到两个"同一个群"。
        // 同时清掉同一个会话的旧写法（人给老键改名时不会留下一条僵尸记录）。
        const sid = normalizeSid(rawSid);
        const stale = sidLookupKeys(rawSid).filter((key) => key !== sid);
        let doc: JsonObject;
        try {
          const parsed: unknown = JSON.parse(readFileSync(this.configPath, 'utf8'));
          if (!isRecord(parsed)) throw new Error('顶层不是 JSON 对象');
          doc = parsed as JsonObject;
        } catch (err) {
          throw badRequest(`配置文件不是合法 JSON，拒绝在其上做修改：${describeError(err)}`);
        }
        const persona = isRecord(doc['persona']) ? doc['persona'] as JsonObject : {};
        const contacts: JsonObject = isRecord(persona['contacts']) ? { ...persona['contacts'] as JsonObject } : {};
        for (const key of stale) delete contacts[key];
        if (name === '') delete contacts[sid];
        else contacts[sid] = name;
        persona['contacts'] = contacts;
        doc['persona'] = persona;
        writeFileSync(this.configPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
        const event = this.appendSync(
          'config/changed',
          { fields: [`persona.contacts.${sid}`], configHash: sha256Hex(JSON.stringify(contacts)).slice(0, 16) },
          'internal',
        );
        sendJson(res, 200, {
          ok: true, seq: event.seq, type: event.type, sid, name,
          // 联系人表不在热更白名单（persona. 前缀）——如实告诉界面，不假装已生效
          restartRequired: true, contacts,
        });
        return;
      }
      case 'tool-toggle': {
        // 工具开关（扩展页 · 工具）：关掉的工具从模型清单里拿掉，同时写进 config.tools.disabled。
        // 名单以**注册表为唯一活状态**（配置对象在内存里不会随热更替换），配置只是它的持久化。
        //
        // 两处并发都要挡（实测各踩过一次）：
        //   ① **盘上**：读-改-写必须整个进 `configFileLock`（由 `withConfigDoc` 负责），
        //      否则并发的两条命令会退化成"后写覆盖前写"——不报 500 但静默丢更新；
        //   ② **内存里**：`registry.disabledNames()` 的读取与 `setDisabled` 必须在**同一个临界区**内。
        //      分两拍写就会出现：A 与 B 各自读到同一份旧名单，各加一项，后写的那个把前一个抹掉
        //      （落盘的五条只有最后一条留下）。所以注册表的更新放进 `mutate` 回调里做。
        const toolName = payload['name'];
        const enabled = payload['enabled'];
        if (typeof toolName !== 'string' || toolName.trim() === '') {
          throw badRequest('缺少 name（工具名，例如 "http_download"）');
        }
        if (typeof enabled !== 'boolean') {
          throw badRequest('缺少 enabled（true = 开启，false = 关闭）');
        }
        const registry = this.deps.registry;
        if (registry === undefined || registry.get(toolName) === null) {
          throw badRequest(`注册表里没有这件工具：${toolName}`, 'unknown-tool');
        }
        // 先按**闸内算出来的**名单写配置（服务端会校验并在失败时回滚），
        // 再在同一个临界区里把内存注册表调到同一状态：界面看到的一定是生效的那份，
        // 不会出现「配置说关了、她其实还能用」，也不会出现两条并发把对方抹掉。
        let applied: string[] = [];
        await this.withConfigDoc((doc) => {
          const current = registry.disabledNames();
          const next = enabled
            ? current.filter((name) => name !== toolName)
            : [...new Set([...current, toolName])];
          applied = next;
          registry.setDisabled(next);
          const tools = isRecord(doc['tools']) ? doc['tools'] as JsonObject : {};
          tools['disabled'] = next as JsonValue;
          doc['tools'] = tools;
          return next as unknown as JsonValue;
        }, 'tools.disabled');
        sendJson(res, 200, {
          ok: true, name: toolName, enabled, disabled: applied, path: this.configPath,
        });
        return;
      }
      case 'regenerate-webhook-token': {
        // webhook 专用凭据的生成 / 轮换（B9）：写 `data/.webhook-secret.json`。
        //
        // 三条纪律：
        //   ① **明文只在响应里出现这一次**（`token` 字段）。盘上只有 sha256；日志、事件、
        //      诊断输出里一个字节都不落——与 `/api/auth/*` 签发会话同一条纪律。
        //   ② **当场作废旧的那份**：这个通道永远只有一把钥匙（没有"多把并存"的形态），
        //      rotate() 覆盖的就是它。所以响应与日志都要把"旧值即刻失效"说出口——
        //      一定有外部脚本还没换，而那正是这一次收窄的已知代价（见 handleWebhook 的说明）。
        //   ③ 写一条 `auth/webhook-token-rotated` **事实**事件（internal）：与
        //      `auth/password-set` 同理——"谁在什么时候换掉了这条通道的钥匙"，
        //      事后唯一能回答的地方就是日志。它不带凭据，只带那个非密钥的 id。
        const by = typeof payload['by'] === 'string' ? payload['by'] : 'local';
        const result = this.webhookSecret.rotate(by);
        if (!result.ok) {
          this.write(`[webhook] 生成专用凭据失败（${result.code}）：${result.message}`);
          throw new HttpError(result.status, result.code, result.message);
        }
        this.recordWebhookTokenRotated(result, by);
        this.write(
          `[webhook] 专用凭据已${result.action === 'generate' ? '生成' : '轮换'}（${result.secretId}）：`
          + '/webhook/* 从这一刻起只认它，旧凭据当场失效（还在用旧凭据的调用方会收到 401）',
        );
        sendJson(res, 200, {
          ok: true,
          token: result.token,
          note: '这串 token 只显示这一次（盘上只留它的 sha256，日志与事件里都没有原文）：'
            + '把它配到调用方的 Authorization: Bearer 头上。'
            + '从今天起 /webhook/* 只认这条专用凭据——界面会话凭据与 data/.ui-token 都不再放行；'
            + (result.action === 'rotate'
              ? '上一份凭据此刻已经失效，还在用它的外部脚本会开始收 401，记得一并换掉。'
              : ''),
          secretId: result.secretId,
          createdAt: result.createdAt,
          action: result.action,
          previousSecretId: result.previousSecretId,
          instance: instanceIdOf(this.host, this.port(), this.deps.dataDir),
        });
        return;
      }
      case 'set-key': {
        // 本地密钥写入（设置页 · 模型分区）：写 `data/.keys.json`。**不写事件**——密钥不是 agent
        // 的状态（schema 里没有对应事件类型），而事件日志是唯一真相源，往里塞一条"改了密钥"的
        // 近似事件就是脏数据。命令级 X-Confirm: set-key 已在上面把过门。
        const name = payload['name'];
        if (!isKeyName(name)) {
          throw badRequest(
            `name 只能是 ${KEY_NAMES.join(' / ')} 中的一个，收到 ${JSON.stringify(name ?? null)}`,
            'unknown-key',
          );
        }
        const value = payload['value'];
        if (typeof value !== 'string') {
          throw badRequest('缺少 value（字符串；空串 = 清除该键）');
        }
        await writeKeyFile(this.deps.dataDir, name, value);
        const status = keyStatus(name, { dataDir: this.deps.dataDir, envName: this.keyEnvName(name) });
        sendJson(res, 200, {
          ok: true,
          name,
          configured: status.configured,
          mask: status.mask,
          source: status.source,
        });
        return;
      }
      case 'dep-install': {
        // 外部依赖一键安装（设置页 · 外部依赖，v30）：下载 → 解压到 `<dataDir>/tools/<name>/` →
        // **复检** → 刷新探测缓存。
        //
        // 三条纪律：
        //   ① **不写事件**。装一个外部可执行文件不是 agent 的状态（schema 里没有对应事件类型），
        //      与 set-key 同一条理由：事件日志是唯一真相源，塞近似事件就是脏数据。
        //      命令级 X-Confirm: dep-install 已在上面把过门。
        //   ② **三种失败分开反馈**：outcome.step 直接回给界面（download / extract / verify），
        //      合成一句"安装失败"的代价是用户不知道该重试、该换源、还是该看杀毒软件。
        //   ③ 装完**就地复检并刷新缓存**，所以下一次 rg_search / es_search 立刻就能用，
        //      不必重启进程（这正是"安装后复检"要解决的最后一公里）。
        const manager = this.deps.deps;
        if (manager === undefined) {
          throw new HttpError(
            501,
            'not-implemented',
            'dep-install 需要注入外部依赖管理器（WebServerDeps.deps）：当前进程没有装配 src/deps/，'
            + '无法安装或复检。',
          );
        }
        const rawName = payload['name'];
        if (typeof rawName !== 'string' || rawName.trim() === '') {
          throw badRequest(`缺少 name（只能是 ${DEP_NAMES.join(' / ')} 之一）`, 'unknown-dep');
        }
        const name = rawName.trim() as DepName;
        if (!DEP_NAMES.includes(name)) {
          throw badRequest(`name 只能是 ${DEP_NAMES.join(' / ')} 之一，收到 ${JSON.stringify(rawName)}`, 'unknown-dep');
        }

        this.write(`[依赖] 开始安装 ${name} …`);
        const outcome = await manager.install(name);
        if (!outcome.ok) {
          // 失败也是 200：这不是 HTTP 层面的错误，而是"这次安装没成"，
          // 界面要拿 step 与 details 原样显示给用户（4xx/5xx 会被前端统一弹成"请求失败"）
          this.write(`[依赖] ${name} 安装未完成（${outcome.step}）：${outcome.error}`);
          sendJson(res, 200, {
            ok: false,
            name,
            step: outcome.step,
            error: outcome.error,
            details: outcome.details,
          });
          return;
        }

        // 装完立刻带回新的探测结论：界面不必再问一次 /api/deps 就能把徽章点亮
        const after = await manager.get(name);
        this.write(`[依赖] ${name} 已就绪：${outcome.exePath}（${outcome.version}）`);
        sendJson(res, 200, {
          ok: true,
          name,
          step: outcome.step,
          dir: outcome.dir,
          exePath: outcome.exePath,
          version: outcome.version,
          sourceUrl: outcome.sourceUrl,
          bytes: outcome.bytes,
          details: outcome.details,
          /** 复检后的探测结论（与 /api/deps 的单项同形） */
          probe: {
            status: after.status,
            path: after.path,
            version: after.version,
            source: after.source,
            reason: after.reason,
          },
        });
        return;
      }
      case 'persona-reject': {
        const file = typeof payload['file'] === 'string' ? payload['file'] : '';
        if (file === '') throw badRequest('缺少 file');
        const safe = safePersonaRel(file);
        const proposalPath = personaTargetPath(
          this.deps.personaRoot,
          `${PERSONA_PROPOSAL_DIR}/${safe}`,
        );
        const proposal = statOrNull(proposalPath);
        if (proposal.content === null) {
          throw notFound(`没有找到 ${safe} 的提案文件`, 'proposal-not-found');
        }
        const currentHash = sha256Hex(proposal.content).slice(0, 16);
        const sentHash = typeof payload['diffHash'] === 'string' ? payload['diffHash'] : '';
        if (sentHash !== '' && sentHash !== currentHash) {
          throw new HttpError(409, 'stale-proposal', `提案内容已变（当前 hash ${currentHash}，收到 ${sentHash}）：请重新看一眼再决定`);
        }
        unlinkSync(proposalPath);
        // 拒绝 = 只删提案文件，**不写事件**（frontend.md §3.3 明文）：人格没变，日志里没什么可记
        sendJson(res, 200, { ok: true, file: safe, diffHash: currentHash, rejected: true });
        return;
      }
      case 'persona-edit': {
        // 本人在 GUI 里直接编辑人格资产（persona/ 下的 .md）。
        //
        // 为什么不"直接写文件"：人格改动会改变后续每次请求的 personaHash，属于系统状态变化。
        // 按 schema 的纪律走完整三步——① 旧内容先落版本快照（可回滚）② 原子写入
        // ③ 写 persona/updated 事件。这样 GUI 编辑与 agent 的 write_persona 在同一条审计线上。
        const req = validatePersonaEdit(payload);
        const target = personaTargetPath(this.deps.personaRoot, req.file);
        const before = statOrNull(target);
        const beforeText = before.content ?? '';

        if (beforeText === req.content) {
          sendJson(res, 200, {
            ok: true, file: req.file, changed: false, note: '内容与当前一致，未写入',
          });
          return;
        }

        // ① 旧内容快照（文件不存在则跳过——没有旧版本可存）
        let previousHash: string | null = null;
        if (before.content !== null) {
          previousHash = sha256Hex(beforeText);
          await writePersonaVersion(this.deps.dataDir, req.file, beforeText);
        }

        // ② 原子写入
        mkdirSync(dirname(target), { recursive: true });
        writeFileAtomicSync(target, req.content);

        // ③ 事件
        const diffHash = sha256Hex(req.content).slice(0, 16);
        const event = this.appendSync(
          'persona/updated',
          { file: req.file, diffHash, by: 'human' },
          'internal',
        );
        this.deps.onPersonaUpdated?.();
        sendJson(res, 200, {
          ok: true,
          seq: event.seq,
          type: event.type,
          file: req.file,
          changed: true,
          diffHash,
          previousHash,
          bytes: Buffer.byteLength(req.content, 'utf8'),
        });
        return;
      }
      case 'webhook-test': {
        const notifier = this.deps.notifier;
        if (notifier === undefined) {
          throw new HttpError(501, 'not-implemented', 'webhook-test 需要注入告警出口（notifier）才能发测试消息');
        }
        const configured = this.deps.config.alerts.webhookUrl ?? '';
        if (configured === '') {
          throw badRequest('生效配置里没有 alerts.webhookUrl：先在管控页保存出口地址，再测');
        }
        const asked = typeof payload['url'] === 'string' ? payload['url'] : '';
        if (asked !== '' && asked !== configured) {
          throw badRequest(
            `请求里的 url 与生效配置不一致（生效：${configured}）：`
            + '本命令只用生效配置里的出口发测试消息，改完出口请先保存再测',
          );
        }
        // 走同一个告警出口：测试消息与真告警同一条路，“测通了”才算真通
        const outcome = await notifier.alert({
          category: 'webhook-test',
          level: 'info',
          title: '运维台测试消息',
          body: `这是一条来自本地运维台的测试消息（${this.deps.now().toISOString()}）。收到即说明出口可用。`,
          params: { url: configured },
        });
        sendJson(res, 200, {
          ok: outcome.ok,
          sent: outcome.ok,
          url: configured,
          reason: outcome.ok ? null : (outcome.reason ?? '未送达'),
        });
        return;
      }
      case 'skill-confirm': {
        // 技能信任门放行（frontend.md §3.4 的同族动作）：写 `skill/installed { by: 'human' }`，
        // 这是"技能进 catalog"的**唯一凭据**。拒绝没有事件类型，因此不做近似实现（不写假事件）。
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (name === '') throw badRequest('缺少 name');
        const manager = new SkillManager({ baseRoot: this.deps.skillsRoot ?? process.cwd() });
        const data = manager.buildInstalledData(name, 'human');
        if (data === null) {
          throw notFound(
            `技能 ${name} 不在技能根里（目录不存在、缺 SKILL.md，或 frontmatter 非法）：先 GET /api/skills 核对`,
            'skill-not-found',
          );
        }
        // 确认与忽略是互斥的：一条技能被确认进 catalog 之后还留在「已忽略」清单里，
        // 界面就会把它同时摆进两段（点一下"确认"，行却在另一段里又冒出来）。
        const ignoredAfterConfirm = readIgnoredSkills(this.deps.dataDir);
        if (ignoredAfterConfirm.delete(name)) {
          writeIgnoredSkills(this.deps.dataDir, ignoredAfterConfirm);
        }
        const event = this.appendSync('skill/installed', data, 'internal');
        sendJson(res, 200, {
          ok: true,
          seq: event.seq,
          type: event.type,
          name: data.name,
          path: data.path,
          contentHash: data.contentHash ?? null,
        });
        return;
      }
      case 'skill-ignore': {
        // 待确认技能的「忽略 / 恢复」（扩展页 · 技能）：写 `<dataDir>/skills-ignored.json`。
        //
        // 为什么不是事件、也不是界面状态：忽略是**人的一份备忘**（"这条我看过了"），
        // 既不改变她能用什么（catalog 不动），也不是 agent 的状态（schema 里没有这种事件，
        // 往里塞一条就是脏数据）。而放界面状态的问题在实测里已经出现过——换台机器、
        // 清一次缓存，看过的条目又全冒出来，而同一个界面里的"已确认"却是持久事实。
        //
        // 这份文件**只增不减**（删技能目录是用户的事，备忘留痕无害）：目录被删掉之后
        // 那条记录还在，但 `/api/skills` 只回传"扫描得到的名字"，所以界面上不会出现
        // 一行查无此技的"已忽略"。恢复（`ignored: false`）仍然按名字删得掉。
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (name === '') throw badRequest('缺少 name');
        const ignored = payload['ignored'];
        if (typeof ignored !== 'boolean') throw badRequest('缺少 ignored（true = 收进已忽略，false = 放回待确认）');
        // 只接受"扫得到的技能名"：拼错的名字写进去就是一条谁也恢复不了的僵尸记录
        const known = new SkillManager({ baseRoot: this.deps.skillsRoot ?? process.cwd() })
          .scan().candidates.some((candidate) => candidate.name === name);
        if (!known && ignored) {
          throw notFound(`技能根里没有叫 ${name} 的技能目录：先 GET /api/skills 核对`, 'skill-not-found');
        }
        const set = readIgnoredSkills(this.deps.dataDir);
        if (ignored) set.add(name);
        else set.delete(name);
        writeIgnoredSkills(this.deps.dataDir, set);
        sendJson(res, 200, {
          ok: true,
          name,
          ignored,
          ignoredNames: [...set].sort(),
          file: join(this.deps.dataDir, SKILLS_IGNORED_FILE),
        });
        return;
      }
      case 'skill-create': {
        // 新建技能骨架（扩展页 · 技能 · 新建）：写 `skills/<name>/SKILL.md`。
        //
        // 为什么要有这条命令：官方规范里 frontmatter 是**手写的 YAML 子集**，name 必须与目录同名、
        // description 是唯一的触发机制——这些约束写在文档里没人记得住，让人在界面上填两个字段、
        // 由程序按规范拼出骨架，比丢一句"请去 skills/ 下建目录"有用得多。
        //
        // 三条纪律：
        //   ① 只写**技能根的第一个**（`skills/`）：`.agents/skills/` 是跨客户端约定，不是我们的写入面；
        //   ② 已存在就拒绝，不做覆盖——那可能是一个已经确认过的技能，覆盖等于绕开信任门；
        //   ③ 新目录**停在待确认**：不写 `skill/installed`，要过信任门才进 catalog（与 agent 自沉淀同待遇）。
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        assertSkillName(name);
        const description = typeof payload['description'] === 'string' ? payload['description'].trim() : '';
        if (description === '') {
          throw badRequest('缺少 description（一句话写清它做什么、什么时候用——它是唯一的触发机制）');
        }
        if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
          throw badRequest(`description 超过 ${SKILL_DESCRIPTION_MAX_CHARS} 字符上限（frontmatter 硬线），收到 ${description.length}`);
        }
        const manager = new SkillManager({ baseRoot: this.deps.skillsRoot ?? process.cwd() });
        const root = manager.roots[0];
        if (root === undefined) throw new HttpError(500, 'skills-root-missing', '技能根未配置');
        const dir = join(root, name);
        // 存在判定走 existsSync：statOrNull 是**读文件内容**用的（它对目录返回 bytes 字段），
        // 拿它的字段判存在会把"目录不存在"也当成命中——那正好把新建技能全挡在门外。
        if (existsSync(dir)) {
          throw new HttpError(
            409,
            'skill-exists',
            `技能目录已存在：${join(dir, SKILL_FILE_NAME)}。`
            + '要改它请直接编辑那份文件（改完内容哈希会变，信任门会自动退回待确认）。',
          );
        }
        mkdirSync(dir, { recursive: true });
        const file = join(dir, SKILL_FILE_NAME);
        writeFileAtomicSync(file, skillTemplate(name, description));
        // 回读一次扫描结果：让界面拿到的是**扫描器认下的**事实（inline 拼出来的答案不算数）
        const created = manager.scan().candidates.find((candidate) => candidate.name === name) ?? null;
        sendJson(res, 200, {
          ok: true,
          name,
          // 相对路径按 posix 给（与 /api/skills 的 skillPath 同一口径，界面直接摆）
          file,
          relDir: created?.relDir ?? name,
          skillPath: created?.skillPath ?? `${name}/${SKILL_FILE_NAME}`,
          description,
          // 新目录不构成信任：界面据此把它摆进「待确认」，而不是假装已生效
          inCatalog: false,
          needsConfirm: true,
        });
        return;
      }
      case 'skill-remove': {
        // 删除技能（扩展页 · 技能 · 删除）：把 `<技能根>/<name>/` **整个移进** `<dataDir>/trash/`。
        //
        // 为什么不 rm -rf（design §8 用户选的口径）：技能是用户自己写的资产，她也会写——
        // 不可逆的动作在这个项目里一律要过三道（确认短语、可恢复、日志留痕），技能删除没有理由例外。
        // 两个入口共用这一份实现：`POST /api/commands/skill-remove`（与 hook-remove 同姿势）
        // 与 `POST /api/skills/remove`（技能那条线上的写口）。
        sendJson(res, 200, this.removeSkill(payload['name']));
        return;
      }
      case 'mcp-test': {
        // MCP 测试连接（扩展页 · MCP 的每个服务）：**真起一个进程**、握手、拉 tools/list，然后收掉它。
        //
        // 入参两种写法：
        //   { name }                     —— 用配置里已有的那条（改完配置还没保存时用下面那种）
        //   { name?, command, args, env } —— 内联一份配置，专门给"还没保存先试一下"用。
        // 内联的那份要过 parseMcpServers 校验——界面上的校验与服务端的校验不是一回事，
        // 这里宁可借用配置解析器那一把尺子，也不自己另写一套判断。
        const inlineCommand = typeof payload['command'] === 'string' ? payload['command'].trim() : '';
        const askedName = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        let entry: McpServerEntry | null = null;

        if (inlineCommand !== '') {
          const inlineName = askedName === '' ? 'mcp-test' : askedName;
          let parsed: McpServerEntry[];
          try {
            parsed = parseMcpServers([{
              name: inlineName,
              command: inlineCommand,
              args: Array.isArray(payload['args']) ? payload['args'] : undefined,
              env: isRecord(payload['env']) ? payload['env'] : undefined,
            }]);
          } catch (err) {
            throw badRequest(`内联配置不合法：${describeError(err)}`, 'mcp-config-invalid');
          }
          entry = parsed[0] ?? null;
        } else {
          if (askedName === '') throw badRequest('缺少 name（配置里的服务名），或给出 command 来试一份还没保存的配置');
          let configured: McpServerEntry[] = [];
          try {
            const raw: unknown = JSON.parse(readFileSync(this.configPath, 'utf8'));
            const mcpRaw = isRecord(raw) ? raw['mcp'] : undefined;
            configured = parseMcpServers(isRecord(mcpRaw) ? mcpRaw['servers'] : undefined);
          } catch (err) {
            throw badRequest(`配置里的 mcp.servers 读不出来：${describeError(err)}`, 'mcp-config-invalid');
          }
          entry = configured.find((item) => item.name === askedName) ?? null;
          if (entry === null) {
            throw notFound(
              `${askedName} 不在 config.json 的 mcp.servers[] 里：先「添加服务」保存，或直接填 command 试一份内联配置`,
              'mcp-server-not-found',
            );
          }
        }
        if (entry === null) throw badRequest('这份 MCP 配置解析不出可用的条目');

        const askedTimeout = payload['timeoutMs'];
        const timeoutMs = typeof askedTimeout === 'number' && Number.isFinite(askedTimeout)
          ? Math.min(MCP_TEST_TIMEOUT_MAX_MS, Math.max(MCP_TEST_TIMEOUT_MIN_MS, Math.trunc(askedTimeout)))
          : MCP_TEST_TIMEOUT_DEFAULT_MS;

        // disabled 的 server 也允许测：测的正是"它还能不能起来"，与配置里的停用开关无关
        const probe = await probeMcpServer({ ...entry, disabled: false }, {
          timeoutMs,
          spawner: defaultMcpProcessSpawner,
        });
        sendJson(res, 200, {
          ok: probe.ok,
          name: entry.name,
          command: entry.command,
          args: entry.args ?? [],
          timeoutMs,
          reason: probe.reason,
          failureKind: probe.failureKind,
          protocolVersion: probe.protocolVersion,
          serverInfo: probe.serverInfo,
          tools: probe.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
          toolsCount: probe.tools.length,
          stderrTail: probe.stderrTail,
          durationMs: probe.durationMs,
          // 关机序列的实测阶段：这条命令**不留进程**是它的一条承诺，把证据摊开
          shutdownStages: probe.shutdownStages,
          // 测试不改任何状态：是否已经保存进配置、是否已生效，由界面自己按 name 比对
          saved: askedName !== '' && inlineCommand === '',
          note: '测试用的进程已按关机序列收掉；这次结果不写事件、不改注册表——'
            + '要说"它现在能用"，得看真实运行期（保存配置并重启主进程）。',
        });
        return;
      }
      case 'mcp-save': {
        // 加/改一个 MCP 服务（扩展页 · MCP 的添加与编辑）：写 `config.mcp.servers[]`。
        //
        // 为什么走 applyConfigUpdate 而不是自己写文件：那条路自带"写回后立刻用 loadConfig 复核、
        // 失败即回滚原文件"的纪律（applyConfigUpdate 的三条纪律之②）。MCP 配置写错会让下次启动
        // 整个配置校验失败（parseMcpServers 的类型不对就抛），把非法值留在盘上等于"起不来"。
        //
        // 字段口径：界面用 `enabled`（人的语言），配置里存 `disabled`（client.ts 的既有形状）。
        // 转换只在这一处发生——两处各转一遍迟早会漂移。**未在界面上暴露的字段（cwd / toolDefaults /
        // tools / requestTimeoutMs / idleReclaimMs）原样保留**：编辑一个服务不该顺手删掉它的高级设置。
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (name === '') throw badRequest('缺少 name（服务名，如 filesystem）');
        if (!MCP_NAME_PATTERN.test(name)) {
          throw badRequest(
            `服务名「${name}」不合法：只允许字母、数字、- 与 _（这个名字调用时用得到），`
            + '例如 filesystem 或 my-server',
            'bad-mcp-name',
          );
        }
        const command = typeof payload['command'] === 'string' ? payload['command'].trim() : '';
        if (command === '') throw badRequest('缺少 command（要拉起的可执行程序）');
        const args = payload['args'];
        if (args !== undefined && args !== null) {
          if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
            throw badRequest('args 必须是字符串数组（一行一个参数）');
          }
        }
        const env = payload['env'];
        if (env !== undefined && env !== null) {
          if (!isRecord(env) || Object.values(env).some((value) => typeof value !== 'string')) {
            throw badRequest('env 必须是"变量名 → 字符串值"的对象');
          }
        }
        const enabled = typeof payload['enabled'] === 'boolean' ? payload['enabled'] : true;
        /**
         * **这个 server 是干什么的**（2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
         *
         * 三种形状，判据与理由写在 `mcp/description.ts` 的文件头：
         *   • 字符串（含空串）= 人**明确写了**这一格（空串 = 他选择留空，那就存空串：
         *     "留空"与"没提供这一格"是两件事，前者是决定，后者是旧客户端）；
         *   • `null` = 明确清掉这一格（编辑时把描述删掉）；
         *   • 没给（`undefined`）= **原样保留**已存的那一句（与 cwd / toolDefaults 同一条纪律：
         *     界面上没暴露的字段不该被一次保存顺手抹掉）。
         *
         * **留空不做任何拦截**（人不是模型：他被允许留空），但回执里会如实说
         * "留空之后她在索引里只看到名字"——那句话由 `$descNote` 给，界面上也照摆。
         */
        const descRaw = payload['desc'];
        if (descRaw !== undefined && descRaw !== null && typeof descRaw !== 'string') {
          throw badRequest('desc 必须是字符串（这个服务是干什么的，一句话；可以留空，但不能是别的类型）');
        }

        // 改动前的声明面（**写盘之前**的那一份）：用来判"这次到底变了没有"。
        // 只有变了她才被叫醒一次——"保存"不等于"变了"（见 mcpChangeWakeNoteOf）。
        let beforeServers: readonly Record<string, unknown>[] = [];
        let beforeHadSection = false;
        const listed = await this.withConfigDoc((doc) => {
          beforeServers = snapshotConfigServerList(doc);
          beforeHadSection = hasConfigServerSection(doc);
          // 就地改活数组（见 readConfigServerList 的注释）：回传的也是它，用来报"现在还剩哪些"
          const servers = readConfigServerList(doc);
          const index = servers.findIndex((item) => item['name'] === name);
          const prior: Record<string, unknown> = index >= 0 ? servers[index]! : {};
          const entry: Record<string, unknown> = { ...prior, name, command };
          if (Array.isArray(args)) entry['args'] = args.map((item) => `${item}`);
          else if (args === null) delete entry['args'];
          if (isRecord(env)) entry['env'] = { ...env };
          else if (env === null) delete entry['env'];
          // desc（"它是干什么的"）：三种形状，见上面那段注释。空白串**照存**（= 人选择留空）
          if (typeof descRaw === 'string') entry['desc'] = sanitizeMcpDescText(descRaw);
          else if (descRaw === null) delete entry['desc'];
          // 界面上的开关写进配置的 disabled（false = 参与启动枚举）
          if (enabled) delete entry['disabled'];
          else entry['disabled'] = true;
          if (index >= 0) servers[index] = entry;
          else servers.push(entry);
          return servers as unknown as JsonValue;
        }, 'mcp.servers');
        // 唤醒**在写盘成功之后**才发（`withConfigDoc` 抛错就是回滚，回滚了没有改动可通报）；
        // 用的是盘上**回读**的那一份而不是内存里那句回执：它才是"配置现在是什么"的唯一真相源。
        const afterSave = this.readConfiguredServerList();
        const change = diffMcpDeclarations(beforeServers, afterSave.servers);
        this.wakeForMcpChange(change);
        // 那一句"它是干什么的"存下来之后**到底是什么**（回读盘，不拿内存里那句回执充数）：
        // 界面据此把"留空 ⇒ 她在索引里只看到名字"这句话说准（用户点名的第二件事）
        const savedDesc = mcpServerDescOf(
          readConfiguredServer(this.configPath, name) ?? { name, command },
          this.deps.dataDir,
        );
        /**
         * 这一格问的是"**这次改动在活进程里生效了吗**"，所以输入必须是**净效果**：
         * `change` 只认 `added` / `removed` / `changed`——`unchanged` 不算改动
         * （同内容再存一次没改动任何东西，叫人去重启就是白叫，见 `mcpRestartOutcome` 的第一种情形）。
         * 写过的字段只有 `mcp.servers`（`withConfigDoc` 只落这一条），而它是热更字段 ⇒ 常态是 `false`。
         */
        const restart = this.mcpRestartOutcome({
          changedAnything:
            change.added.length + change.removed.length + change.changed.length > 0,
          appliedFields: ['mcp.servers'],
        });
        sendJson(res, 200, {
          ok: true,
          name,
          enabled,
          servers: (listed as unknown as JsonObject[]).map((item) => item['name']),
          path: this.configPath,
          /**
           * **这次改动需不需要重启才生效**（2026-10-11 改成"按净效果给"）。
           *
           * `mcp.servers` 是**热更字段**（`src/config/watcher.ts` 的 `HOT_RELOAD_FIELDS`）：
           * 这一份文件写完之后，主进程里那个订阅者会按新声明把池跟上 ⇒ **不必重启**。
           * 只有两种情形才回 true：**这次什么都没改**（没东西要生效）之外，
           * 写下的字段里有接不住的（今天 `mcp-save` 没有这种字段），或者热更接线没活。
           *
           * 判据只有一处，见 `mcpRestartOutcome` 的方法头（那里也是"将来加字段要登记的地方"），
           * 这里与界面都不另猜一份。
           */
          restartRequired: restart.required,
          /** 那一格的**人话理由**（界面原样摆）：`false` 时说"已生效"，`true` 时说清为什么 */
          restartNote: restart.note,
          /** 这次保存的净效果：`added` = 新加的，`updated` = 改动/写回，`unchanged` = 一个字节没动 */
          effect: restart.effect,
          desc: savedDesc.text,
          descFrom: savedDesc.source,
          /**
           * 这一格**给人看的一句话**（界面原样摆）。留空**不拦人**（他不是模型，允许留空），
           * 但必须如实说清后果——不写这一句，人就会以为"没填也没什么"，
           * 而她下一次要看这个 server 是干什么的时，索引里只有名字。
           */
          descNote: savedDesc.text === ''
            ? 'desc 留空了：她的**常驻索引里只会有这个名字**（索引那一行会照实写"配置里没写它做什么"）。'
              + '补一句它做什么，索引里就多那一句。'
            : savedDesc.source === 'config'
              ? 'desc 已存进 config.json：她的常驻索引里那一行会带上这一句。'
              : 'desc 是空的，索引里那一行暂时用**它自报的工具描述**顶上（会标"据它自报的工具描述"）。',
          ...mcpWakeReceiptFields(change, beforeHadSection, afterSave),
        });
        return;
      }
      case 'mcp-remove': {
        // 删一个 MCP 服务（扩展页 · MCP 的删除）：写 `config.mcp.servers[]`。
        //
        // 顺带把它留下的禁用名单条目也清掉：`tools.disabled` 里那条 `mcp__{name}__*` 从此
        // 指向一件不存在的工具——留着不会出错，但会让"关掉了什么"这份名单慢慢变成垃圾场。
        // 只有**注册表里确实有的**名字才清（注册表是活状态，配置只是它的持久化，与 tool-toggle 同口径）。
        const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
        if (name === '') throw badRequest('缺少 name（要删除的服务名）');
        let removed = false;
        let beforeServers: readonly Record<string, unknown>[] = [];
        let beforeHadSection = false;
        const listed = await this.withConfigDoc((doc) => {
          beforeServers = snapshotConfigServerList(doc);
          beforeHadSection = hasConfigServerSection(doc);
          const servers = readConfigServerList(doc);
          const index = servers.findIndex((item) => item['name'] === name);
          if (index < 0) return undefined;
          removed = true;
          // splice 就地改数组：删掉的条目因此真的从写回的文档里消失
          servers.splice(index, 1);
          return servers as unknown as JsonValue;
        }, 'mcp.servers');
        if (!removed) {
          throw notFound(`${name} 不在 config.json 的 mcp.servers[] 里（可能已被删除）`, 'mcp-server-not-found');
        }
        const registry = this.deps.registry;
        const stale = (registry?.disabledNames() ?? []).filter((toolName) => mcpServerOfTool(toolName) === name);
        let pruned: string[] = [];
        /** 清禁用名单那一支**真的**写进配置的字段（没写就是空数组，供下面判"要不要重启"） */
        let pruneFields: string[] = [];
        if (stale.length > 0 && registry !== undefined) {
          pruned = registry.disabledNames().filter((toolName) => !stale.includes(toolName));
          const pruneWrite = await this.applyConfigUpdate({ fields: { 'tools.disabled': pruned } }, phrases);
          pruneFields = pruneWrite.fields;
          registry.setDisabled(pruned);
          const pruneEvent = this.appendSync(
            'config/changed',
            { fields: ['tools.disabled'], configHash: sha256Hex(JSON.stringify(pruned)).slice(0, 16) },
            'internal',
          );
          this.write(`[web] mcp-remove 顺带清掉 ${stale.length} 条指向 ${name} 的禁用条目（seq ${pruneEvent.seq}）`);
        }
        // 与 mcp-save 同一条：删服务也是"声明面变了"，所以也叫她一次（同样只叫一次、没删成就不叫）。
        // 放在清禁用名单**之后**：先落完这批写盘，再发那一条唤醒，日志里的因果顺序才读得通。
        const afterRemove = this.readConfiguredServerList();
        const removeChange = diffMcpDeclarations(beforeServers, afterRemove.servers);
        this.wakeForMcpChange(removeChange);
        /**
         * 与 `mcp-save` 同一条判据（见 `mcpRestartOutcome` 的方法头），但**输入不同**：
         * 这条路上写过的字段可能不止一个——删一条声明之后可能**顺带**清掉 `tools.disabled`
         * 里指向它的条目，而那一格**不在热更名单里**（它是工具装配参数，池的 `applyDeclarations`
         * 不管它）⇒ 那一支要如实回 true，并把"为什么"写进 `restartNote`。
         */
        const restart = this.mcpRestartOutcome({
          changedAnything: removeChange.added.length + removeChange.removed.length
            + removeChange.changed.length > 0 || pruneFields.length > 0,
          appliedFields: ['mcp.servers', ...pruneFields],
        });
        sendJson(res, 200, {
          ok: true,
          name,
          servers: (listed as unknown as JsonObject[]).map((item) => item['name']),
          prunedDisabledTools: stale,
          path: this.configPath,
          // 与 `mcp-save` 同一条判据：删服务也是声明面热更，接线活着就不必重启；
          // **例外**是顺带清了 `tools.disabled` 那一支——那一格接不住，如实回 true 并说清为什么。
          restartRequired: restart.required,
          restartNote: restart.note,
          effect: restart.effect,
          /** 这次写命令真的写过哪些字段（点路径）：`tools.disabled` 在里面就说明清了禁用名单 */
          appliedFields: ['mcp.servers', ...pruneFields],
          ...mcpWakeReceiptFields(removeChange, beforeHadSection, afterRemove),
        });
        return;
      }
      case 'hook-save': {
        // 加/改/开关一条钩子（扩展页 · Hooks）：写 `data/hooks.json`。
        //
        // **安全边界**：这份文件定义的是"谁能改我"——一条 PreToolUse 钩子能拒掉任何工具调用、
        // 能改写参数。所以它这一侧只认**人**（X-Confirm: hook-save 已在上面把过门），
        // 而 agent 的写入口继续拒绝（protectedHookPaths() → fs 工具的 guardedWrite）。
        // 这条纪律不能只写在文档里：它是"无人值守时门还在不在"的分界线。
        //
        // 条目级校验复用 parseHookEntry（与装配侧同一把尺子）：界面写得进、启动时被跳过，
        // 是最难查的一类故障——用户以为钩子在跑，其实它从来没生效过。
        const rawHook = typeof payload['hook'] === 'string' ? payload['hook'].trim() : '';
        const matcher = typeof payload['matcher'] === 'string' ? payload['matcher'] : '';
        const command = typeof payload['command'] === 'string' ? payload['command'] : '';
        const entry: JsonObject = { hook: rawHook, matcher, command };
        const timeoutMs = payload['timeoutMs'];
        if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
          entry['timeoutMs'] = Math.trunc(timeoutMs);
        }
        const condition = payload['if'];
        if (typeof condition === 'string' && condition.trim() !== '') entry['if'] = condition.trim();
        if (payload['enabled'] === false) entry['enabled'] = false;
        const askedIndex = payload['index'];
        const index = typeof askedIndex === 'number' && Number.isInteger(askedIndex) && askedIndex >= 0 ? askedIndex : null;
        // 编辑时必须带上原来那条的 `hook`，否则"改第 2 条"在文件被人动过之后就成了"改错一条"
        if (index !== null) entry['hook'] = rawHook;

        const saved = await this.mutateHookConfig((entries) => {
          if (index === null) {
            entries.push(entry);
            return entries.length - 1;
          }
          if (index >= entries.length) {
            throw new HttpError(
              409,
              'hook-index-stale',
              `第 ${index + 1} 条钩子在文件里已经不存在了（可能刚被删过）：刷新一次再改`,
            );
          }
          entries[index] = entry;
          return index;
        });
        sendJson(res, 200, {
          ok: true,
          index: saved.index,
          entries: saved.entries,
          file: hookConfigPath(this.deps.dataDir),
          // 钩子在启动时装配一次（main.ts 的 HookRunner）：写盘 ≠ 生效
          restartRequired: true,
        });
        return;
      }
      case 'hook-remove': {
        // 删一条钩子：写 `data/hooks.json`。与 hook-save 同一条纪律（人可写、agent 只读）。
        const askedIndex = payload['index'];
        const index = typeof askedIndex === 'number' && Number.isInteger(askedIndex) && askedIndex >= 0 ? askedIndex : null;
        if (index === null) throw badRequest('缺少 index（要删的是第几条，从 0 起；GET /api/hooks 里有）');
        const saved = await this.mutateHookConfig((entries) => {
          if (index >= entries.length) {
            throw new HttpError(409, 'hook-index-stale', `第 ${index + 1} 条钩子在文件里已经不存在了：刷新一次再看`);
          }
          const [removed] = entries.splice(index, 1);
          this.write(`[web] hook-remove 删除 ${JSON.stringify(removed?.hook ?? '')}#${index}`);
          return index;
        });
        sendJson(res, 200, {
          ok: true,
          index,
          entries: saved.entries,
          file: hookConfigPath(this.deps.dataDir),
          restartRequired: true,
        });
        return;
      }
      case 'timer-cancel': {
        const timerId = typeof payload['timerId'] === 'string' ? payload['timerId'] : '';
        if (timerId === '') throw badRequest('缺少 timerId');
        const known = this.deps.projection.timers.some((timer) => timer.timerId === timerId);
        if (!known) throw notFound(`定时器 ${timerId} 不在投影里（可能已触发或已取消）`, 'timer-not-found');
        // 先落事件（真相源），再取消内存里的布防：反过来会在事件写失败时留下"日志说还在、实际已被取消"
        const event = this.appendSync('timer/cancelled', { timerId }, 'internal');
        await this.deps.timers.cancel(timerId);
        sendJson(res, 200, { ok: true, seq: event.seq, type: event.type, timerId });
        return;
      }
      default:
        // CONFIRM_PHRASES 里登记过但这里没实现：显式报错，不做"尽力而为"
        throw new HttpError(501, 'not-implemented', `命令 ${command} 已登记但尚未实现`);
    }
  }

  /**
   * 配置热更（frontend.md §3.4：保存 = 一次性提交该组改动 → `config/changed`）。
   *
   * 三条纪律：
   *   ① 只改 `fields` 点到的字段，**保留用户手写的 `$comment` 注释键**（整份文档读出来改再写回）；
   *   ② 写回后立刻用 `loadConfig` 重新校验：非法值必须当场回滚——把非法配置留在盘上，
   *      下一次启动就是"起不来"，而此刻人还在看着界面；
   *   ③ `schemaVersion` 由迁移链管理，任何来自界面的修改一律拒绝。
   */
  private async applyConfigUpdate(
    payload: Record<string, unknown>,
    phrases: readonly string[],
  ): Promise<{ fields: string[]; configHash: string }> {
    const rawFields = payload['fields'];
    if (!isRecord(rawFields) || Object.keys(rawFields).length === 0) {
      throw badRequest('缺少 fields（形如 {"budget.softRatio": 0.8} 或 {"budget":{"softRatio":0.8}}）');
    }

    // 扁平点路径（`budget.softRatio`）与嵌套对象（`{"budget":{"softRatio":0.8}}`）都接受，
    // 内部统一成点路径——前端不必记住哪种写法是对的
    const flat: Array<[string, unknown]> = [];
    const collectFields = (input: Record<string, unknown>, prefix: string): void => {
      for (const [key, value] of Object.entries(input)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (isRecord(value)) collectFields(value, path);
        else flat.push([path, value]);
      }
    };
    collectFields(rawFields, '');

    for (const [path] of flat) {
      if (path.split('.').some((part) => part.startsWith('$'))) {
        throw badRequest(`字段名不允许以 $ 开头（那是配置注释键）：${path}`);
      }
      if (path === 'schemaVersion') {
        throw badRequest('schemaVersion 由配置迁移链管理，不接受来自界面的修改');
      }
      const dangerous = DANGEROUS_FIELDS[path];
      if (dangerous !== undefined && !phrases.includes(dangerous)) {
        // 理由里**点名是哪个字段**（2026-10-05）：危险字段不止一条之后，"需要追加字段短语 X"
        // 这句本身答不出"是我这次改的这个字段危险，还是顺带碰到的别的东西"——而客户端要弹的
        // 那张确认卡上写的就是"你要改的那一项会放开什么"。字段路径是唯一能对上号的坐标。
        throw badRequest(
          `字段级危险操作：改 ${path} 需要 X-Confirm 追加字段短语 ${dangerous}`
          + `（形如 "update-config; ${dangerous}"）`,
          'confirm-required',
        );
      }
    }

    // 过了字段校验就整段进闸：**读 → 改 → 写 → 复核**必须是一个不可分割的临界区。
    // 闸内每次都是"重新读盘再改"，所以并发的另一条命令写下的东西一定被下一条看见
    // ——这正是"排队而不是覆盖"与"后写静默盖掉前写"的分界线（后者比 500 更坏）。
    return await configFileLock(async () => {
      let original: string;
      try {
        original = readFileSync(this.configPath, 'utf8');
      } catch (err) {
        throw new HttpError(500, 'config-unreadable', `读不到配置文件 ${this.configPath}：${describeError(err)}`);
      }

      let doc: JsonObject;
      try {
        const parsed: unknown = JSON.parse(original);
        if (!isRecord(parsed)) throw new Error('顶层不是 JSON 对象');
        doc = parsed as JsonObject;
      } catch (err) {
        throw badRequest(`配置文件不是合法 JSON，拒绝在其上做热更：${describeError(err)}`);
      }

      const fields: string[] = [];
      for (const [path, value] of flat) {
        setJsonPath(doc, path, value as JsonValue);
        fields.push(path);
      }

      writeFileAtomicSync(this.configPath, `${JSON.stringify(doc, null, 2)}\n`);
      try {
        // 复核读也留在闸内：它在目标上留一个异步读句柄，正是卡住下一个写者的东西
        const reloaded = await loadConfig(dirname(this.configPath));
        return { fields, configHash: reloaded.configHash };
      } catch (err) {
        // 校验失败：把原文件写回去（原文本一个字节不动），错误如实抛给界面
        writeFileAtomicSync(this.configPath, original);
        throw badRequest(`配置校验失败，已回滚到改动前的版本：${describeError(err)}`);
      }
    });
  }

  /**
   * 在**整份 config.json 文档**上做一次受校验的修改（mcp-save / mcp-remove 用）。
   *
   * 为什么不是直接调 `applyConfigUpdate`：那条路按点路径写入（`mcp.servers` 会被当成
   * "把整个数组换成这个值"），而增删改数组元素要**先读懂现有条目**再改——
   * 否则编辑一个 server 会把它没在界面上暴露的字段（cwd / toolDefaults / tools）一起抹掉。
   *
   * 纪律与 applyConfigUpdate 完全一致：保留 `$comment` 注释键（整份文档读出来改再写回）、
   * 写回后立刻 `loadConfig` 复核、失败即回滚原文本，**并且整段进 `configFileLock`**
   * （读 → 改 → 写 → 复核是一个临界区，不这么写并发两条命令就会丢更新）。
   *
   * `mutate` 返回 undefined 表示"不改"（调用方据此报 404），此时不写盘。
   */
  private async withConfigDoc(
    mutate: (doc: JsonObject) => JsonValue | undefined,
    path: string,
  ): Promise<JsonValue | undefined> {
    return await configFileLock(async () => {
      let original: string;
      try {
        original = readFileSync(this.configPath, 'utf8');
      } catch (err) {
        throw new HttpError(500, 'config-unreadable', `读不到配置文件 ${this.configPath}：${describeError(err)}`);
      }
      let doc: JsonObject;
      try {
        const parsed: unknown = JSON.parse(original);
        if (!isRecord(parsed)) throw new Error('顶层不是 JSON 对象');
        doc = parsed as JsonObject;
      } catch (err) {
        throw badRequest(`配置文件不是合法 JSON，拒绝在其上做修改：${describeError(err)}`);
      }

      const next = mutate(doc);
      if (next === undefined) return undefined;

      writeFileAtomicSync(this.configPath, `${JSON.stringify(doc, null, 2)}\n`);
      try {
        const reloaded = await loadConfig(dirname(this.configPath));
        // 写命令照旧落一条 config/changed（内部可见性）：配置变了却不在日志里留痕，
        // 事后复盘"她为什么多了一件工具"就无处可查
        const event = this.appendSync(
          'config/changed',
          { fields: [path], configHash: reloaded.configHash },
          'internal',
        );
        this.write(`[web] ${path} 已写入（seq ${event.seq}）`);
      } catch (err) {
        writeFileAtomicSync(this.configPath, original);
        throw badRequest(`配置校验失败，已回滚到改动前的版本：${describeError(err)}`);
      }
      return next;
    });
  }

  /**
   * 改 `data/hooks.json` 并回读一次解析结果。
   *
   * 三条取舍：
   *   ① 文件不存在 = 从空数组开始（不是错误态，`/api/hooks` 也是这么说的）；
   *   ② 顶层若是 `{"hooks":[...]}` 形态，就地改那个数组、**保留其余键**（与配置文档同一条纪律）；
   *   ③ 每条都过 `parseHookEntry` 复核——写进去一条启动时会被跳过的条目，等于让人以为它生效了。
   *
   * 与 config.json 同一条纪律：**整段进 `configFileLock`**。这份文件也会被并发改
   * （界面上连着点两条钩子的开关），而在飞句柄挡住 rename 那件事与文件是哪一个无关。
   */
  private async mutateHookConfig(
    mutate: (entries: JsonObject[]) => number,
  ): Promise<{ index: number; entries: JsonObject[] }> {
    return await configFileLock(() => {
      const file = hookConfigPath(this.deps.dataDir);
      let doc: JsonObject = {};
      let list: JsonObject[] = [];
      const existing = statOrNull(file).content;
      if (existing !== null && existing.trim() !== '') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(existing) as unknown;
        } catch (err) {
          throw badRequest(`${file} 不是合法 JSON，拒绝在其上做修改：${describeError(err)}`, 'hooks-unreadable');
        }
        if (Array.isArray(parsed)) {
          list = parsed.filter(isRecord) as JsonObject[];
        } else if (isRecord(parsed) && Array.isArray(parsed['hooks'])) {
          doc = parsed as JsonObject;
          list = (parsed['hooks'] as unknown[]).filter(isRecord) as JsonObject[];
        } else {
          throw badRequest(`${file} 的顶层必须是数组或 {"hooks": [...]}：当前形态无法安全地改`, 'hooks-shape');
        }
      }

      const index = mutate(list);
      for (const [i, item] of list.entries()) {
        const checked = parseHookEntry(item, i);
        if (typeof checked === 'string') throw badRequest(`钩子条目不合法，未写入：${checked}`, 'hook-invalid');
      }
      const body = list.length === 0 && doc['hooks'] === undefined
        ? '[]'
        : JSON.stringify(doc['hooks'] === undefined ? list : { ...doc, hooks: list }, null, 2);
      writeFileAtomicSync(file, `${body}\n`);
      return { index, entries: list };
    });
  }

  // ── 密钥视图（设置页 · 模型分区） ──

  /**
   * 密钥状态视图：每个受管键「配没配」+ 掩码，**不含值**。
   *
   * 环境变量名以**生效配置**为准（`models.heavy.apiKeyEnv` / `channels.*.appIdEnv` …），
   * 于是「配置里把变量名改了」在界面上立刻看得见；`.keys.json` 里的键名则是受管的五个名字
   * （config/keys.ts 的 KEY_NAMES），不受配置影响。
   */
  private keysView(): Record<string, { configured: boolean; mask: string | null }> {
    const out: Record<string, { configured: boolean; mask: string | null }> = {};
    for (const name of KEY_NAMES) {
      const status = keyStatus(name, { dataDir: this.deps.dataDir, envName: this.keyEnvName(name) });
      out[name] = { configured: status.configured, mask: status.mask };
    }
    return out;
  }

  /** 受管键名 → 生效配置里的环境变量名（配置缺该字段时由 keys.ts 的 KEY_ENV 兜底） */
  private keyEnvName(name: KeyName): string {
    const config = this.deps.config;
    if (name === 'heavy') return config.models.heavy.apiKeyEnv;
    if (name === 'light') return config.models.light.apiKeyEnv;
    if (name === 'qqAppId') return config.channels.qqOfficial.appIdEnv;
    if (name === 'qqClientSecret') return config.channels.qqOfficial.clientSecretEnv;
    return config.channels.onebot.tokenEnv;
  }

  // ── 插件页与数据页的只读视图 ──

  /**
   * 技能视图：目录扫描 → 信任门裁决 → catalog。
   * 与 CLI 的 `irmia skill list` **同一份 SkillManager**：界面看到的 catalog 就是模型看到的 catalog。
   * 信任事件从日志折叠（真相源是 `skill/installed`），本进程不持有第二份状态。
   *
   * 「已忽略」是唯一一份**从盘上读**的界面状态（`<dataDir>/skills-ignored.json`，见该常量注释）：
   * 它按名字回传（`ignored: true` 逐条标 + `ignored: [...]` 汇总），界面据此分三段摆，
   * 而**不参与**信任门裁决——忽略一条不等于批准它，catalog 一个字节都不变。
   *
   * 汇总那一个数组**只回传扫描得到的名字**：那份文件是只增不减的备忘（技能目录被删掉之后
   * 它照旧留着那条记录，见 `skill-ignore` 的注释），而界面不该出现一行"查无此技"。
   * 文件里其余的名字仍然留着（`ignoredOnDisk` 原样回传，只给排障看）——"看过了"这件事
   * 不该因为目录暂时读不到就忘掉。
   */
  private async skillsView(options: { rescan?: boolean } = {}): Promise<Record<string, unknown>> {
    const manager = new SkillManager({ baseRoot: this.deps.skillsRoot ?? process.cwd() });
    manager.setTrustEvents(await readAllEvents(this.deps.log));
    const scan = manager.scan();
    const catalog = manager.catalog();
    const inCatalog = new Set(catalog.entries.map((entry) => entry.name));
    const scanned = new Set(scan.candidates.map((candidate) => candidate.name));
    const onDisk = readIgnoredSkills(this.deps.dataDir);
    // 界面口径：只认扫得到的名字（`ignored` 是 Set，逐条标与汇总两处都用它）。
    // `ignoredOnDisk` 是原样的全量，只给排障看——两者分工不同，别混用。
    const ignored = new Set([...onDisk].filter((name) => scanned.has(name)));
    return {
      roots: scan.roots,
      catalogTokens: catalog.tokens,
      entries: catalog.entries,
      warnings: catalog.warnings,
      rejected: scan.rejected.map((item) => ({ relDir: item.relDir, reason: item.reason })),
      // 扫描时机：清单每次现扫（不缓存），这个布尔只是把「这次是按钮触发的」如实回给界面
      rescanned: options.rescan === true,
      ignored: [...ignored].sort(),
      // 盘上那份备忘的全量（含指向空气的记录）：界面不用它，排障时有用
      ignoredOnDisk: [...onDisk].sort(),
      ignoredFile: join(this.deps.dataDir, SKILLS_IGNORED_FILE),
      items: scan.candidates.map((candidate) => {
        const verdict = manager.trustOf(candidate.name, candidate.contentHash);
        return {
          name: candidate.name,
          relDir: candidate.relDir,
          skillPath: candidate.skillPath,
          rootName: candidate.rootName,
          description: candidate.description,
          bytes: candidate.bytes,
          contentHash: candidate.contentHash,
          trust: verdict.state,
          trustDetail: verdict.detail,
          inCatalog: inCatalog.has(candidate.name),
          ignored: ignored.has(candidate.name),
        };
      }),
    };
  }

  /**
   * 删除一个技能目录：**移进 `<dataDir>/trash/<时间戳>-<技能名>/`**，不是 rm -rf（design §8）。
   *
   * 四道关口，顺序不能换：
   *   ① 名字（`assertSkillName`）：它会被拼成路径，所以先按"这是不是一个目录名"判定——
   *      分隔符、上跳、盘符一律拒。删除的能力不许被一个名字绕过；
   *   ② 位置（`SkillManager#locate`）：两个技能根都找，都没找到就报清楚，**一个文件都不动**；
   *   ③ 落点：回收站里已经有一份同名同时间戳的就拒——那是**另一条**原件，覆盖它等于销毁证据；
   *   ④ 移动：整目录搬走，内容一个字节不改；恢复就是把目录移回原处（响应里带着那句话）。
   *
   * 为什么留痕只落一行 web 日志、**不写事件**：schema 里没有"技能已删除"这种事件类型，
   * 往唯一真相源里塞一条近似事件就是脏数据（与 hook-remove / mcp-remove 同一条理由）。
   *
   * 为什么**不**受只读前缀（`SKILL_READ_ONLY_PREFIXES`）限制：那条纪律管的是**模型**的写工具
   * （技能目录"她可读、不可改"）。删除是**人**在界面上的动作，跟同一个人类已经能做的
   * 新建（skill-create）与确认（skill-confirm）是同一层——把只读前缀套到人头上，
   * 等于用户自己的资产自己动不了，那不是纪律，是失能。
   *
   * 「已忽略」清单（`skills-ignored.json`）**不顺手清理**：那份备忘只增不减是既有口径
   * （见 skill-ignore 的注释），而 `/api/skills` 只回传"扫描得到的名字"，
   * 界面不会因此多出一行"查无此技"。
   */
  private removeSkill(asked: unknown): Record<string, unknown> {
    const name = typeof asked === 'string' ? asked.trim() : '';
    assertSkillName(name);

    const manager = new SkillManager({ baseRoot: this.deps.skillsRoot ?? process.cwd() });
    const found = manager.locate(name);
    if (found === null) {
      throw notFound(
        `技能根里没有叫 ${name} 的目录（两处都找过了：${manager.roots.join('、')}）：`
        + '先在 GET /api/skills 里核对它的 name——目录名即技能名，不是界面上的标题',
        'skill-not-found',
      );
    }

    const trashRoot = join(this.deps.dataDir, SKILL_TRASH_DIR);
    const stamp = compactTimestamp(this.deps.now());
    const target = join(trashRoot, `${stamp}-${name}`);
    if (existsSync(target)) {
      throw new HttpError(
        409,
        'trash-conflict',
        `回收站里已经有这一份了：${target}。同一个时间戳（毫秒）删同名技能才会撞上，多半是重复请求：`
        + '先看一眼那一份要不要留，再决定是删这一次，还是先把那一份移走。',
      );
    }
    // 先建目录再移动：renameSync 不替我们建父目录，而"还没有回收站"是正常状态（从没删过东西）
    mkdirSync(trashRoot, { recursive: true });
    try {
      renameSync(found.dir, target);
    } catch (err) {
      // rename 是原子的：失败时原目录连同内容都还在原处，没有"搬了一半"这种中间态
      throw new HttpError(
        500,
        'skill-move-failed',
        `把 ${found.relDir} 移进回收站失败，原目录未动：${describeError(err)}。`
        + '常见原因：回收站与技能根不在同一个盘（rename 不能跨盘），或那个目录正被别的进程占用。',
      );
    }

    this.write(`[web] skill-remove 把 ${found.relDir} 移进 ${target}（恢复：移回 ${found.dir}）`);
    return {
      ok: true,
      name,
      // relDir 与 /api/skills 的 skillPath 同一口径（相对技能根基准的 posix 路径），界面直接摆
      relDir: found.relDir,
      rootName: found.rootName,
      from: found.dir,
      movedTo: target,
      trashDir: trashRoot,
      restore: `把 ${target} 移回 ${found.dir} 即可恢复（内容一个字节没改）`,
    };
  }

  /**
   * **写盘之后**从 `config.json` 回读那份声明面（判"变了什么"、以及"现在一共几个"用）。
   *
   * 为什么回读盘而不是用内存里那句回执：`withConfigDoc` 的承诺是"写回后立刻 `loadConfig`
   * 复核、失败即回滚"，所以**盘上那一份**才是"配置现在是什么"的唯一真相源；而回执里那串
   * `servers` 是 `mutate` 就地改出来的活数组，回滚时它已经改过了（拿它去比会得出"变了"
   * 这个错结论，然后她收到一条根本没发生的通报）。
   *
   * 读不出来时按**空**算、这一段标记成"没有"：通报正文因此会少一句总数（不编一个数字出来），
   * 但**照发**——声明面确实刚被这次写命令改过，读不到盘是观测面的事，不是"没发生"。
   */
  private readConfiguredServerList(): {
    servers: readonly Record<string, unknown>[];
    hasSection: boolean;
  } {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.configPath, 'utf8')) as unknown;
    } catch {
      return { servers: [], hasSection: false };
    }
    if (!isRecord(raw)) return { servers: [], hasSection: false };
    const doc = raw as JsonObject;
    return { servers: snapshotConfigServerList(doc), hasSection: hasConfigServerSection(doc) };
  }

  /**
   * MCP 声明面变了 ⇒ **发一次真唤醒**（2026-10-09，用户原来的要求）。
   *
   * 用户原话是「添加 mcp 时，就添加时**追加在上下文尾部，发起一次唤醒**，框架提示
   * `[发生mcp添加]` + desc + 工具全文」。单入口工具那一版之后这条要求**简化成**：
   * 加/删/改 MCP 声明时发一次真唤醒，正文里说清"哪些 server 变了"、现在几个、去哪儿看清单
   * ——**不再往上下文尾部塞工具全文**（清单她要时自己用 `mcp` 工具看，那是披露式的设计）。
   *
   * 走的是**既有那条真唤醒路径**，一处新机制都没有：`appendSync('wake/manual', …, 'model')`
   * ——与界面聊天框、`/dream`、`webhook` 转发**同一条路**（同一套认领、幂等、崩溃恢复），
   * 由 `fold` 折进 `projection.pending`，主循环下一拍认领 ⇒ 真起一个 turn。
   *
   * 三条分寸：
   *   · **没有改动就不发**（`mcpChangeWakeNoteOf` 返回 null）：按一下"保存"没改任何东西
   *     也叫醒她，这条通报很快就会变成噪音，而噪音的下场是被整个忽略；
   *   · **一次保存只发一条**：同一次保存里变了几条 server 就合成**一句**（正文把那几个名字列全，
   *     不连发）；再叠一层幂等：**同一组改动**在 5 秒内重复（界面连点、客户端重试）只通报一次。
   *     注意这里**不是**"5 秒内所有改动并成一条"——两次各改一个不同 server 是两件事，
   *     它们各自都该到（实测判据见 `test/mcp-decl-wake.test.ts` 的 ③/③b 两条）；
   *   · **刻意不通报"人开口了"**（不调 `noteUserSpoke`）：这不是人说的话，是框架替他做的动作。
   *     通报了的话，打断回执会把这段框架通报写成"他刚说「…」"摆给她——`/dream` 那处踩过同一个坑。
   */
  /**
   * ═══════════════ **"需要重启"的判据（全仓唯一一处，改这一格先读这里）** ═══════════════
   *
   * 回执里 `restartRequired` 的字面问题只有一个：**这次改动在**本进程**里生效了吗？**
   * 没生效才回 true。它**不是**"改了配置文件没有"，也**不是**"哪个字段变了"——
   * 那两件事都有别的格子回答（`changedServers` / `wake` / `effect` / `appliedFields`）。
   *
   * 今天这个进程里的路径逐条如下（`n` = 这次写命令**真的**动过的字段数）：
   *
   *   · `n === 0`（这次写命令没改动任何东西：按一下保存、值原样写回）
   *     ⇒ **不必重启**。反向那一侧错得更贵：为一次什么都没改的保存叫人去重启，
   *     正是"这句话喊多了就不值钱"的形状（与 `changedServers: []` 同一把尺子）。
   *
   *   · `n > 0` 且热更接线活着（生产：`main.ts` 把 `ConfigWatcher.live` 递进来）
   *     ⇒ **看哪些字段被动过**：只要全部落在 `HOT_RELOAD_FIELDS` 里就不必重启。
   *     判据**不在这里另写一份**，直接读 `classifyConfigField`（`config/watcher.ts`）——
   *     白名单多一项、少一项，这里自动跟着变，不会漂移。
   *
   *   · `n > 0` 且接线**没活**（夹具 / 内嵌方 / `stop()` 之后）
   *     ⇒ **要重启**：那一刻确实没有人在配置变化之后把派生状态跟上，
   *     说"已生效"是撒谎。保守那一侧错得起（顶多多一次重启）。
   *
   * ──────────────────── **今天唯一会回 true 的活路径**（将来若有人加了不走热更的字段，登记在这里） ────────────────────
   *
   * 今天 `mcp-save` / `mcp-remove` 唯一**不是**热更字段的写入是 `mcp-remove` 顺带清掉的
   * `tools.disabled`（那一支：删一个 server ⇒ 把指向它的禁用名单条目一起清掉）。它是
   * **工具装配参数**，池的 `applyDeclarations` 不管它 ⇒ 那个停用状态要重启才换得过来
   * （代价与理由见 `HOT_RELOAD_FIELDS` 的"刻意没放回来的"那一段）。所以那一支如实回 true。
   *
   * 登记规则（照抄 `HOT_RELOAD_FIELDS` 的纪律）：**要在这里加一条，先答出"改了这一格，
   * 活进程里谁接不住"**——答不出来就说明它该进热更名单，而不是该进这张表。
   */
  private mcpRestartOutcome(input: {
    /** 这次写命令**真的**改动了盘上的东西没有（没改就别叫人重启） */
    changedAnything: boolean;
    /** 这次写命令写过的全部字段（点路径），按写入次序 */
    appliedFields: readonly string[];
  }): { required: boolean; note: string; effect: 'added' | 'updated' | 'unchanged' } {
    if (!input.changedAnything) {
      return {
        required: false,
        effect: 'unchanged',
        note: '这次保存没有改动任何东西：没有要生效的东西，也就不必重启。',
      };
    }
    // 接线活着才谈得上"接住了"；没接线时下面那句理由才是真的（见方法头第三种情形）
    const woke = this.deps.configReload !== undefined && this.deps.configReload();
    // 接不住的那些字段：同一次写命令里**可能写了不止一个**（mcp-remove 会顺带写 tools.disabled），
    // 只要有一个不在热更名单里就要重启——盘上变了而进程没跟上，正是这一格要说的那件事。
    // ⚠️ 这一格**永远**按字段算（不许写成 `woke ? 过滤 : []`）：接线没活时"接不住"的
    // 是**全部**写入，把那一支写成空集恰好会把 true 说成 false（这一版第一稿就踩过，
    // 判据的方向感：这一格宁可多说一次重启，也不许漏说）。
    const cold = input.appliedFields.filter((field) => classifyConfigField(field) !== 'hot');
    if (cold.length === 0 && woke) {
      return {
        required: false,
        effect: 'updated',
        note: '已生效：这份声明是热更字段（配置一写，主进程里的订阅者就按新声明把池跟上，'
          + '只重连真变了的那几个）——不必重启进程。',
      };
    }
    const hasTools = cold.includes('tools.disabled');
    return {
      required: true,
      effect: 'updated',
      note: '需要重启主进程才生效：'
        // 两种不同的"接不住"，理由不同（见方法头）：
        // ① 接线没活 ⇒ 这次写下的**全部**字段都没人接管（此刻 `cold` 就是全部写入）；
        // ② 接线活着但里有不走热更的字段 ⇒ 只点名那几个。
        //
        // ⚠️ 这一句**长度是判据的一部分**：界面把它**原样**接在 toast 后面
        // （`gui/lib/pages/extensions_page.dart` 的 `_mcpWriteOutcome`：`'已删除 $name：' + 这一句`），
        // 而 toast 有字数预算（`gui/test/copy_rules_test.dart`：一串文案 100 字上限，
        // 那是"两行 13px 正文"的量）⇒ 两句合计必须留得住。写长了不报错、只是溢出去，
        // 所以别把它扩写成一段说明：这里保持"点名哪一格 + 一句话为什么"。
        + (woke
          ? `它不在热更名单里：${cold.join('、')}——`
          : '这次写下的字段没人在本进程里接管——'
            + `${input.appliedFields.join('、')}（热更接线没活）；`)
        + (hasTools
          ? '禁用名单要重启才与运行中的工具表一致。'
          : '要重启才接管。'),
    };
  }

  private wakeForMcpChange(change: McpDeclChange): void {
    const after = this.readConfiguredServerList();
    const note = mcpChangeWakeNoteOf(change, after.servers.length, after.hasSection);
    if (note === null) return;
    let event: AppEvent;
    try {
      event = this.appendSync('wake/manual', {
        note,
        // 来源标记：界面据此把它渲染成**框架卡片**而不是"用户说的话"（与 /dream 同一格，
        // 见 `WakeManual.via` 的注释；界面那一侧还没加 'mcp' 分支，写在报告里）
        via: 'mcp',
        // **不带 person**：用户自己没开口，带人就会把关系档案注进这一轮（见 WakeManual.person）
        //
        // 幂等键用**改动的身份**（动了哪些 server）而不是正文：正文里带着"现在一共几个"，
        // 拿它当键的话同一串编辑的后几笔会各叫一次（见 mcpChangeIdentityKeyOf 的注释）。
        // 时间片与聊天框/`/dream` 同一套口径（5 秒）：连点几下算一次。
        dedupeKey: contentKey(
          'ui-mcp',
          `${Math.floor(this.deps.now().getTime() / (MCP_WAKE_DEDUPE_SLICE_SECONDS * 1000))}:`
          + mcpChangeIdentityKeyOf(change),
        ),
      }, 'model');
    } catch (err) {
      // 通报发不出去**不许**把一次成功的配置写入变成 500：盘已经写好了，回头再点一次保存
      // 也不会补发（那时声明面已经与盘一致 ⇒ "没变"）。所以这里只留痕，如实说没叫成。
      this.write(`[web] MCP 声明变了，但那条唤醒没发出去（配置写盘不受影响）：${describeError(err)}`);
      return;
    }
    // 回执里那两格由 `mcpWakeReceiptFields` 拼（同一个 note，两处不许各拼一遍）
    this.write(`[web] MCP 声明变了 ⇒ 唤醒 seq ${event.seq}（wake/manual · via=mcp）`);
  }

  /**
   * MCP 视图：声明（`config.json` 的 `mcp.servers[]`）+ 运行期事实（`mcp/*` 事件折叠）。
   * 本进程不持有 `McpClientPool`（它归 real-loop），所以状态**只从事件日志与注册表读**：
   * 没有启动事件就诚实地说"从未启动"，绝不臆造"正在运行"。
   *
   * **工具清单从事件读，注册表只作回退**（2026-10-09 修，评审缺陷 ⑤）：生产上池**刻意不拿
   * 注册表**（拿了就会把 `mcp__*` 写进 `tools` 段，那正是披露式要避开的事），于是注册表里
   * 一件 MCP 工具都没有 ⇒ 这三个字段（`registeredTools` / `toolsCount` / `toolDetails`）
   * **恒为空**：真起过、真调过，扩展页照样写「注册工具 0 件」，也不给工具清单与描述。
   * 事件是 internal（不进模型请求、零缓存代价），而"它给了什么"只有池在启动那一刻知道
   * ⇒ 以 `mcp/server-started` 的 `toolDetails` 为准，注册表那份（真注册过时）优先覆盖描述。
   * 旧日志里没有 `toolDetails` ⇒ 退回 `tools` 那一档（只有名字、没有描述），不许读崩。
   *
   * **清单与进程状态解耦**（2026-10-10 加，用户这一轮："mcp 卡片要显示 server 和工具名称"）：
   * 从"**此刻**注册的那一份"改成"**日志里看到过的那一份**"——回收事件不再把清单清空
   * （清空它换不来诚实：那份清单本来就带着自己的时刻，丢掉它只让人以为"这个服务没有工具"）。
   * `registeredTools` / `toolsCount` / `toolDetails` 三个字段**一起**改口径，免得出现"卡片里
   * 列着工具、页头写着 0 件"这种自相矛盾。另加一组只读的观测字段答"这份清单是什么时候的"：
   * `toolList` / `toolsListAt` / `toolsFrom` / `toolsQuery` / `toolsAgeMs`——界面据此说得出
   * "这是 3 小时前那份清单"，而旧形状（回收即清空）根本读不出这句话，人看到的只有"已停止 · 0 件"。
   */
  private async mcpView(): Promise<Record<string, unknown>> {
    const problems: string[] = [];
    let configured: McpServerEntry[] = [];
    try {
      const raw: unknown = JSON.parse(readFileSync(this.configPath, 'utf8'));
      const mcpRaw = isRecord(raw) ? raw['mcp'] : undefined;
      const serversRaw = isRecord(mcpRaw) ? mcpRaw['servers'] : undefined;
      configured = parseMcpServers(serversRaw);
    } catch (err) {
      problems.push(describeError(err));
    }

    interface SeenTool { name: string; description: string }
    interface Seen {
      state: 'started' | 'stopped';
      ts: string;
      pid: number | null;
      tools: string[];
      /**
       * **日志里最后看到过的**那份工具清单（旧日志为空数组 ⇒ 退回 `tools` 那一档）。
       *
       * 与 `state` 解耦（2026-10-10 加，用户这一轮点名要"每个 server 下面看得到工具名"）：
       * 清单只在启动那一刻进日志，而池默认空闲 5 分钟就回收 ⇒ 人点开这一页时 server 多半
       * **没在跑**。以前 `stopped` 那一支把这份清单清成空数组，于是"它给过哪些工具"在这页上
       * 随回收一起消失，只留下一句"0 件"。清空**换不来诚实**：这份清单本来就带着自己的时刻，
       * 把时刻一起摆出来就是诚实的；把清单丢掉只会让人以为"它没有工具"。
       */
      toolDetails: SeenTool[];
      /** 上面那份清单是哪一次启动时看到的（ISO）；从没启动过就是 null */
      toolsSeenAt: string | null;
      reason: string | null;
      /** 启动耗时（ms）；旧日志没有这一格 ⇒ null（不编） */
      startMs: number | null;
      /** 上一次回收到现在这个进程活了多久（ms）；没有就是 null */
      uptimeMs: number | null;
      /** 在飞峰值（启动那条路上恒为 0，回收那条路上才是整个生命周期的峰值） */
      inFlightPeak: number | null;
      /** 回收前最后一次采到的 RSS（MB）；没采到就是 null */
      rssMb: number | null;
      /** 最近一次资源采样（`mcp/server-resource`，2026-10-10 加） */
      rss: { rssMb: number | null; source: string; sampledAtMs: number | null } | null;
    }
    /**
     * 事件里的一格可能是任何形状（旧日志、手写事件、将来改了字段）——按数据读，不按承诺读。
     * 认不出就是空数组：宁可少显示，也不许把 `[object Object]` 摆到人面前。
     */
    const seenToolsOf = (raw: unknown): SeenTool[] => {
      if (!Array.isArray(raw)) return [];
      const out: SeenTool[] = [];
      for (const item of raw) {
        if (!isRecord(item)) continue;
        const name = item['name'];
        if (typeof name !== 'string' || name === '') continue;
        const description = item['description'];
        out.push({ name, description: typeof description === 'string' ? description : '' });
      }
      return out;
    };
    const latest = new Map<string, Seen>();
    for (const event of await readAllEvents(this.deps.log)) {
      if (event.type === 'mcp/server-started') {
        const data = event.data as unknown as {
          name?: unknown; pid?: unknown; tools?: unknown; toolDetails?: unknown; startMs?: unknown;
        };
        if (typeof data.name !== 'string') continue;
        const tools = Array.isArray(data.tools) ? data.tools.filter((item): item is string => typeof item === 'string') : [];
        const toolDetails = seenToolsOf(data.toolDetails);
        latest.set(data.name, {
          state: 'started',
          ts: event.ts,
          pid: typeof data.pid === 'number' ? data.pid : null,
          // 两档只说一件事：详情缺失（旧日志）时用名字补齐，描述留空
          tools: tools.length > 0 ? tools : toolDetails.map((tool) => tool.name),
          toolDetails: toolDetails.length > 0
            ? toolDetails
            : tools.map((name) => ({ name, description: '' })),
          // 启动事件落库即"清单被拉到过"（握手与 tools/list 都在启动这条路上，
          // 它没成功就压根不会有这条事件）——哪怕清单是空的，也是**问过**了。
          toolsSeenAt: event.ts,
          reason: null,
          startMs: typeof data.startMs === 'number' ? data.startMs : null,
          // 新的这次启动把上一条生命周期的那几个数清掉（它们答的是"上一个进程"，别混着读）
          uptimeMs: null,
          inFlightPeak: null,
          rssMb: null,
          // RSS 采样是**另一条事件**、可能还没落（异步）：沿用这一条之前的采样值没有意义
          //（上一轮那个进程的数），所以清掉——"还没采到"就该显示成没采到
          rss: null,
        });
      } else if (event.type === 'mcp/server-stopped') {
        const data = event.data as unknown as {
          name?: unknown; reason?: unknown; uptimeMs?: unknown; inFlightPeak?: unknown; rssMb?: unknown;
        };
        if (typeof data.name !== 'string') continue;
        const previous = latest.get(data.name);
        latest.set(data.name, {
          state: 'stopped',
          ts: event.ts,
          pid: null,
          tools: [],
          // 清单与它的观看时刻**跟着上一次启动留着**（见 `Seen.toolDetails` 的注释）：
          // 回收带走的只是那个进程，带不走"它给过什么"这条事实。
          toolDetails: previous?.toolDetails ?? [],
          toolsSeenAt: previous?.toolsSeenAt ?? null,
          reason: typeof data.reason === 'string' ? data.reason : null,
          // 回收这条事件把"上一次启动"的观测量收在一处：列表页读 `lastStarted` 那几个字段即得
          startMs: previous?.startMs ?? null,
          uptimeMs: typeof data.uptimeMs === 'number' ? data.uptimeMs : null,
          inFlightPeak: typeof data.inFlightPeak === 'number' ? data.inFlightPeak : null,
          rssMb: typeof data.rssMb === 'number' ? data.rssMb : null,
          rss: previous?.rss ?? null,
        });
      } else if (event.type === 'mcp/server-resource') {
        /**
         * 资源采样（2026-10-10 加）：**它不改 `state`**——采样答的是"那一个进程占了多少内存"，
         * 而"它还在不在跑"由 started/stopped 两条答。改 state 会让一条观测事件
         * 把一个已经回收的 server 说成"正在运行"。
         */
        const data = event.data as unknown as {
          name?: unknown; rssMb?: unknown; rssSource?: unknown; sampledAtMs?: unknown;
        };
        if (typeof data.name !== 'string') continue;
        const previous = latest.get(data.name);
        if (previous === undefined) continue;
        previous.rss = {
          rssMb: typeof data.rssMb === 'number' ? data.rssMb : null,
          source: typeof data.rssSource === 'string' ? data.rssSource : 'unavailable',
          sampledAtMs: typeof data.sampledAtMs === 'number' ? data.sampledAtMs : null,
        };
      }
    }

    const registryNames = this.deps.registry?.names() ?? [];
    const mcpToolNames = registryNames.filter((name) => name.startsWith(MCP_NAME_PREFIX));
    // 工具描述：注册表现取优先（真注册过才有），没有就用事件里那份（server 自报的原话）
    const describe = (name: string): string => this.deps.registry?.get(name)?.description ?? '';
    const servers = configured.map((entry) => {
      const seen = latest.get(entry.name) ?? null;
      const registered = registryNames.filter((name) => name.startsWith(`${MCP_NAME_PREFIX}${entry.name}__`));
      const prefix = `${MCP_NAME_PREFIX}${entry.name}__`;
      // "它是干什么的"那一句（2026-10-11 加）：**声明优先、缓存兜底**，来源一起给出去
      // （界面据此把"这一句是它自报的"与"这一句是配的"分开摆——判据在 `mcp/description.ts`）
      const desc = mcpServerDescOf(entry, this.deps.dataDir);
      // 注册表那一份（有的话）与事件那一份按短名对齐：注册过就用注册表的名字与描述
      const detailed = new Map<string, { name: string; fullName: string; description: string }>();
      for (const full of registered) {
        const short = full.slice(prefix.length);
        detailed.set(short, { name: short, fullName: full, description: describe(full) });
      }
      for (const tool of seen?.toolDetails ?? []) {
        const known = detailed.get(tool.name);
        if (known !== undefined) {
          if (known.description === '') known.description = tool.description;
          continue;
        }
        detailed.set(tool.name, { name: tool.name, fullName: `${prefix}${tool.name}`, description: tool.description });
      }
      const toolDetails = [...detailed.values()];
      /**
       * 事件里那一份（旧日志只有名字 ⇒ 描述留空）补成与注册表那份同一形状：
       * 下面对外只给一种元素形状（`{name, fullName, description}`），界面不必分两档读。
       */
      const enrichSeen = (tools: SeenTool[]): Array<{ name: string; fullName: string; description: string }> =>
        tools.map((tool) => ({
          name: tool.name,
          fullName: `${prefix}${tool.name}`,
          description: tool.description,
        }));
      /**
       * 下面那几格答的是"**它给过哪些工具**"（2026-10-10 加，用户这一轮的原话是
       * "mcp 卡片要显示 server 和工具名称"）。与 `runningNow` 分开的理由是一条判据：
       * **清单是事实，进程状态是另一件事实**——服务被回收（生产常态：空闲 5 分钟）之后
       * 页面上仍然该看得见它的工具名，只是必须说清"这是哪一刻的清单"。
       *
       * 于是 `toolDetails` / `toolsCount` / `registeredTools` 这一组从"此刻注册的那一份"
       * 改成"日志里看到过的那一份"：以前它们被回收事件清空，人点开扩展页（那时多半已经回收）
       * 永远只看到"0 件"。**三个字段口径一起改**是刻意的——只改一个就会出现"卡片里列着工具、
       * 页头写着 0 件"这种自相矛盾，而那一页的全部价值就在"说的和看到的是同一件事"。
       * 描述仍然以注册表现取优先（真注册过时它更新），够不着就用事件里 server 自报的原话。
       *
       * 三格各答一件事，`toolsFrom` 把话说死，界面不必自己猜形状：
       *   · `live`  —— 日志里最后一条是"起来了"，这份清单就是它现在给的；
       *   · `cached`—— 服务已经回收/崩溃，清单是上一次起来时拉的（`toolsListAt` 那一刻）；
       *   · `none`  —— 没有清单（停用 / 从未起来 / 起来过但一件工具都没给，这三者靠
       *                `toolsQuery` 与 `state` 分开）。
       * 顺序有意：先判"有没有清单"（「没看到过」与「问过、是空的」是两件事），再判这份清单新不新。
       * 还有一处**必须**先判在跑：服务此刻在跑、而它这次一件工具都没给（`live` 且空）时，
       * 不能拿上一次那份来充数——"此刻没有"就是此刻的答案，回收之后再回退到旧清单才对。
       */
      const observedTools = toolDetails.length > 0
        ? toolDetails
        : (seen?.state === 'started' ? [] : enrichSeen(seen?.toolDetails ?? []));
      const hasList = seen !== null && seen.toolsSeenAt !== null && observedTools.length > 0;
      const toolsFrom: 'live' | 'cached' | 'none' =
        hasList ? (seen.state === 'started' ? 'live' : 'cached') : 'none';
      /**
       * 清单时刻（ISO）。与"有没有工具"**无关**：拉到过就有时刻（空清单也是问过了），
       * 所以它用 `seen` 那一格而不是 `hasList`——这一格正是"这份清单是何时的答案"。
       */
      const toolsListAt = seen !== null && seen.toolsSeenAt !== null && seen.toolsSeenAt !== ''
        ? seen.toolsSeenAt
        : null;
      const toolList = toolsFrom === 'none' ? [] : observedTools;
      return {
        name: entry.name,
        command: entry.command,
        args: entry.args ?? [],
        // env 与 cwd 原样回传（界面只读摆出来）：人得看得出"这个服务带着什么起来"
        env: entry.env ?? {},
        cwd: entry.cwd ?? null,
        disabled: entry.disabled === true,
        /**
         * "它是干什么的"（那一句会进她的常驻索引）+ 它是哪来的。
         *
         * 三态（`descFrom`）：`config` = 人（或人批过的她）写的声明；`cache` = **它自报的
         * 工具描述**兜底（界面必须把那句"据它自报"摆出来）；`absent` = 两处都没有
         * ⇒ 索引里那一行**只写名字**（界面照实说这一格是空的，不编一句）。
         */
        desc: desc.text,
        descFrom: desc.source,
        descIsDeclared: desc.source === 'config',
        state: entry.disabled === true ? 'disabled' : seen === null ? 'never-started' : seen.state,
        lastAt: seen === null ? null : seen.ts,
        pid: seen === null ? null : seen.pid,
        stopReason: seen === null ? null : seen.reason,
        registeredTools: toolList.map((tool) => tool.fullName),
        toolsCount: toolList.length,
        toolDetails: toolList,
        /**
         * 这一份清单是**什么时候**看到的（2026-10-09 同批加）：清单只在启动那一刻进事件，
         * 而 server 可能早就回收了。人看"它给了什么"时得知道那是哪一刻的答案——空 = 没看到过。
         *
         * ⚠️ 口径（2026-10-10 明确）：与 `toolsListAt` **同一个数**（这一格是它的老名字，
         * 留着不删是因为界面与别处的读法已经在用它）。两处口径以前有一处会打架：清单来自
         * 注册表回退（`toolDetails` 非空）而启动事件里没有可读时刻时，老写法让它为空——
         * 同一张卡上"有清单"与"不知道清单是哪一刻的"两个结论并列。现在只留一个答案。
         */
        toolsSeenAt: toolsListAt,
        // ── 工具清单（2026-10-10 加；界面那张卡的"server → 工具名"两层就吃这几格）──
        /**
         * **日志里最后看到过的那份清单**（与 `runningNow` 无关）：界面据此在回收之后
         * 仍然列得出工具名。拿不到就是空数组，且此时 `toolsFrom === 'none'`。
         */
        toolList,
        /** 这份清单是**哪一刻**看到的（ISO）；`null` = 从没看到过（不是"零件"） */
        toolsListAt,
        toolsFrom,
        /**
         * 这次启动**问过工具清单没有**——把两种"空"分开：
         *   · `ok`    —— 拿到了清单（件数看 `toolList.length`）；
         *   · `empty` —— 起来了、握手过了、`tools/list` 回了空 ⇒ 这个服务当前不提供工具；
         *   · `unknown` —— 启动事件里没有可读的时刻（旧日志的怪形状）：不知道问没问过。
         * 从未起来过的服务不写这三档，`state` 那一格已经说了（旧形状的启动事件照样认成 `ok`）。
         */
        toolsQuery: seen === null ? null
          : seen.toolsSeenAt === null ? 'unknown'
            : toolList.length > 0 ? 'ok' : 'empty',
        /**
         * 这份清单**是多久以前看到的**（ms，按本进程的时钟算）。
         *
         * 为什么由服务端算：界面手里只有时刻字符串，拿它减本机时钟就多一处口径
         * （时钟不同源、页面开久了这行字会过期）。代价写在明处：它是**响应生成那一刻**的年龄，
         * 刷新页面才更新——界面读即刻值，所以不设"要刷新"的陷阱。
         */
        toolsAgeMs: toolsListAt === null ? null : Math.max(0, this.deps.now().getTime() - Date.parse(toolsListAt)),
        // ── 资源观测（2026-10-10 加；全部从 internal 事件折出来，池不在这条链上）──
        /**
         * 最近一次启动耗时（spawn → 握手 + 清单，ms）。
         * 这个数答的是用户这一轮的原问题之一："冷启动到底多慢"——以前只有"启动事件发生在哪一刻"。
         */
        lastStartMs: seen?.startMs ?? null,
        /**
         * 最近一次采样到的 RSS（MB）与它是什么时候采的。
         * `rssSource === 'unavailable'` ⇒ **没采到**（不是 0 MB）；`rssSampledAt` 为空 = 这一轮还没采过。
         *
         * ⚠️ 口径：它是**启动后不久那一次**采样（回收事件里带的是"最后一次采到的"值），
         * **不是**回收瞬间的内存——进程一退出就没有 RSS 可读了。
         */
        rssMb: seen?.rss?.rssMb ?? seen?.rssMb ?? null,
        rssSource: seen?.rss?.source ?? null,
        rssSampledAt: seen?.rss?.sampledAtMs === null || seen?.rss?.sampledAtMs === undefined
          ? null
          : new Date(seen.rss.sampledAtMs).toISOString(),
        /** 上一个进程活了多久（ms）——与"回收理由"一起读才看得出是空闲回收还是起来就崩 */
        uptimeMs: seen?.uptimeMs ?? null,
        /** 在飞请求峰值（回收事件带的才是整个生命周期的峰值） */
        inFlightPeak: seen?.inFlightPeak ?? null,
        /**
         * **最近一次回收时间**（ISO）。它就是 `mcp/server-stopped` 的 `ts`——
         * "回收救回多少内存"要把它与 `rssMb` 一起读（判据：调研稿 §3.2 ④）。
         */
        lastReclaimedAt: seen !== null && seen.state === 'stopped' ? seen.ts : null,
        // 「在跑」的判据是**日志**：最后一次是 started 才算，进程可能早退了。
        // pid 不能当判据——它是当时那个进程的 pid，此刻还成不成立没有任何记录能证明。
        runningNow: entry.disabled !== true && seen !== null && seen.state === 'started',
      };
    });
    // 顶层的两个数（界面页头那一行）：注册表为空时（生产常态）以事件里那份为准——
    // 写"工具 0 件"而每个卡片里列着工具，是最容易让人不再相信这一页的那种自相矛盾。
    const seenToolNames = servers.flatMap((server) => server.registeredTools);
    const effectiveTools = mcpToolNames.length > 0 ? mcpToolNames : seenToolNames;
    return {
      configured: configured.map((entry) => ({
        name: entry.name,
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ?? {},
        disabled: entry.disabled === true,
        // 那一句"它是干什么的"（与 servers[] 里那一格同一份；这里给一份是因为
        // 界面有些地方只读 configured 那一层）
        desc: mcpServerDescOf(entry, this.deps.dataDir).text,
      })),
      servers,
      registeredTools: effectiveTools,
      registeredCount: effectiveTools.length,
      runningCount: servers.filter((server) => server.runningNow).length,
      problems,
    };
  }

  /**
   * 告警落盘视图：`<dataDir>/alarms/` 的文件清单；带 `?file=` 时一并给出该文件内容。
   * 目录不存在 = 还没发过告警（正常态，不是错误），返回空清单让前端走空态。
   */
  private alarmsView(url: URL): Record<string, unknown> {
    const dir = join(this.deps.dataDir, ALERT_DIR_NAME);
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
    } catch {
      names = [];
    }
    const files: Array<{ name: string; bytes: number; mtime: string | null; lines: number }> = [];
    for (const name of names) {
      const stat = statOrNull(join(dir, name));
      if (stat.content === null) continue;
      files.push({
        name,
        bytes: stat.bytes,
        mtime: stat.mtime,
        lines: stat.content === '' ? 0 : stat.content.split('\n').filter((line) => line !== '').length,
      });
    }

    const relative_ = relative(this.deps.dataDir, dir);
    const asked = url.searchParams.get('file');
    if (asked === null) return { dir, relative: relative_, files };

    const safe = safeAlarmName(asked);
    const stat = statOrNull(join(dir, safe));
    if (stat.content === null) throw notFound(`告警文件 ${safe} 不存在（data/${ALERT_DIR_NAME}/ 下）`, 'alarm-not-found');
    const truncated = stat.content.length > ALARM_READ_MAX_CHARS;
    return {
      dir,
      relative: relative_,
      files,
      name: safe,
      bytes: stat.bytes,
      mtime: stat.mtime,
      truncated,
      content: truncated
        ? `${stat.content.slice(0, ALARM_READ_MAX_CHARS)}\n…[已截断：全文 ${stat.content.length} 字符]`
        : stat.content,
    };
  }

  /**
   * 会话联系人：见过的会话（会话簿）+ 当前给它们起的名字 + 各自的未读数。
   *
   * 会话簿由通道事件（`wake/channel` 与只记账的 `channel/message`）折叠而来，web 侧自己扫一遍
   * 日志，不去麻烦 real-loop——这份清单就是人给会话起名字时的可选目标：手打 openid 不现实。
   *
   * 未读也一并给出来：QQ 那边"她没看的有多少"是**只有日志算得出来**的事实（见 channel/sessions.ts），
   * 界面上没有它，人就只能看见"有会话"而看不出"她在漏消息"。
   */
  private async sessionsView(): Promise<Record<string, unknown>> {
    const contacts = new Map(Object.entries(this.deps.config.persona.contacts));
    // 她自己认的人（`MEMORIES/aliases.md`）：读不到就是空表，不是错误。
    // 为什么这里也要读：界面上的名字与她那边的名字必须是同一个来源（`resolveSessionName`），
    // 否则会出现"界面上有名字、她上下文里还是 openid"这种两边不一致
    let aliases: ReadonlyMap<string, SessionAlias> = new Map();
    try {
      aliases = parseAliases(readFileSync(join(this.deps.dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8'));
    } catch {
      // 没有那份文件 = 她还没认过人
    }
    const events = await readAllEvents(this.deps.log);
    const sessions = collectSessions(events).map((entry) => {
      // 走共用查找（联系人 > 别名 > 她自己贴的标签 > openid），且**新旧两种 sid 写法都认**：
      // 会话身份归一之后条目是 `qq:group:<群id>`，而用户手里那张表可能还是 `qq:group-at:<群id>`
      // ——只按一种写法查，会让"我给这个群起过名字"在界面上变成一串 openid（实测踩到）
      const resolved = resolveSessionName(entry, contacts, aliases);
      // 备注（她写在别名名字后面括号里的那段口径）：判据在 `aliasNoteOf` 里，**不在这儿再拼一遍**。
      // 只在"名字真源就是那条别名"时才给——联系人表把人写的名字改掉了，还挂着她给旧名字写的口径，
      // 人会以为那句口径还作数（见 `aliasNoteOf` 的注释）。
      const { note } = aliasNoteOf(entry, contacts, aliases);
      return {
        sid: entry.sid,
        channel: entry.channel,
        chatType: entry.chatType,
        chatId: entry.chatId,
        person: entry.person,
        lastSeenAt: entry.lastSeenAt,
        lastText: entry.lastText,
        messages: entry.messages,
        readUpToSeq: entry.readUpToSeq,
        unread: entry.unread,
        // 没有名字时给 null（界面据此显示"未命名会话"），而不是把 openid 当名字发过去
        name: resolved === entry.person ? null : resolved,
        // 备注是**次要文本**，与名字分开两个字段：界面那格可编辑的只有名字，
        // 混在一起发过去就等于让界面自己再切一次——那正是这次 bug 的形状。
        note,
      };
    });
    return {
      sessions,
      // **必须是普通对象**（不是 Map）：它要经 JSON 出去，而 `JSON.stringify(new Map())` 是 `{}`
      // ——聊天页的名字全靠这个字段，序列化成一个空对象就等于每条通道消息都显示「未命名会话」
      // （2026-10-02 实测踩到：内部用 Map 查名字时顺手把 Map 也塞进了响应体）。
      //
      // **键要归一**：这张表是给界面按 sid 查名字用的，而 sid 的形态在 2026-10-02 归一了
      //（群聊一律 `qq:group:<群id>`）。用户手里那张表却还是归一前填的 `qq:group-at:<群id>`
      // ——原样发出去，界面按 `qq:group:…` 查不到，群聊就一直显示「未命名会话」（实测第二次撞到）。
      contacts: Object.fromEntries([...contacts].map(([sid, name]) => [normalizeSid(sid), name])),
      // **群成员档案**（2026-10-04）：自动注册/人改过的人都在这儿，按群分组给界面用。
      // 与 contacts 分开：那份是"会话"的名字（键是 sid），这份是"群里的人"（键是 openid），
      // 群成员根本不是会话——他没私聊过她，也就没有 sid 可言。
      groupMembers: (() => {
        try {
          const book = new GroupMemberBook(this.deps.dataDir);
          const byGroup: Record<string, Array<{ openid: string; name: string; nickname?: string; source: string }>> = {};
          for (const { openid, entry } of book.all()) {
            const key = entry.groupSid ?? '';
            byGroup[key] = byGroup[key] ?? [];
            byGroup[key].push({
              openid,
              name: entry.name,
              ...(entry.nickname === undefined ? {} : { nickname: entry.nickname }),
              source: entry.source,
            });
          }
          return byGroup;
        } catch {
          // 档案读不动不该让整张会话卡片打不开：如实给空表
          return {};
        }
      })(),
      // **预警豁免名单**（2026-10-04）：单聊按会话、群里按人。界面据此画开关，
      // 默认两边都是空的 = 全都预警（安全的那一侧）。
      // **群聊场景开关**（2026-10-04）：软提醒（默认）/ 硬拒绝。界面据此画那一个开关。
      groupSceneHardRefusal: this.deps.config.tools.groupSceneHardRefusal === true,
      warnExempt: (() => {
        try {
          return new WarnExemptBook(this.deps.dataDir).snapshot();
        } catch {
          return { sessions: [], members: {} };
        }
      })(),
      unreadTotal: sessions.reduce((sum, entry) => sum + entry.unread, 0),
      restartRequiredForChanges: true,
    };
  }

  /**
 * 框架提示（运行情况页 ·「框架提示」卡片的数据源，v33）。
   *
   * 为什么单开一条读端点、而不是让界面去 `/api/events` 自己筛：事件流里这两条混在几万条
   * 内部簿记中间（`step/start`、`budget/consumed`…），界面按类型筛等于把判据复制一份到前端，
   * 两处迟早会分岔。判据留在服务端，端点只吐"给人看的那一份"。
   *
   * 四条口径：
   *   · **自包含**：来源（会话、谁、叫什么）、判定来源、时刻都在这条里，卡片不必再问 `/api/sessions`；
   *   · **引用必须截断**：`quotes` 是外部原文片段，一条长消息能到几千字，见 {@link clipFrameworkQuotes}；
   *   · **空就是空**：没有提示是常态，返回空数组——不是 404、不是 null（对比 `/api/alarms?file=` 的 404：
   *     那是"你指名要的文件不存在"，这里是"最近没什么事"）；
 *   · **不挑新的也不排重**：同一类告警会被限流挡在写入侧（`alarm/sent` 本来就稀疏），
 *     这里如实按时间倒序摆出来，不做"合并相似条目"的聪明事——那会让人看不出发生过几次；
 *   · **"已恢复"要与它的原始那条配对**（2026-10-05 加，见 {@link pairedRecoveries}）：
 *     配上的原始告警不再按当前严重渲染，而是渲染成历史。
 */
private async frameworkNotesView(url: URL): Promise<Record<string, unknown>> {
    const contacts = this.deps.config.persona.contacts;
    const events = await readAllEvents(this.deps.log);
    const limit = frameworkNoteLimit(url.searchParams.get('limit'));

    // 配对表**在倒扫之前整份算出来**：倒扫为了 `?limit=` 小的时候提前停，只看得到日志的尾巴，
    // 而"某条 17:33 的告警后来被销掉了吗"要看它**之后**发生了什么——那可能远在尾巴之外
    // （真实日志里 09:33 那条告警的配对在 09:47，隔着一万四千条事件）。
    const recoveries = pairedRecoveries(events);

    // 从尾部往前扫：要的是"最近若干条"。日志按 seq 追加，seq 序即时间序——
    // 几种类型混着走一遍就是全局时间倒序，不需要再排一次（`?limit=` 小的时候还提前停）
    //
    // **归因不进这张卡**（2026-10-04 用户第二次报"还在刷屏"之后定的口径）：
    // 它先是"每步一条"（约 500 条/天，两分钟刷满一屏），改成"一轮只留最后一步"之后**仍然嫌吵**
    // ——每条都要占两行（标题 + 整条等式），而且它说的根本不是"提示"：**归因是事实，事实去日志页看**
    // （事件 `budget/consumed.context` 一直都在，想核对的人打开日志就能逐条读）。
    // 所以这张卡只留"要人看一眼"的三类：注入预警、告警、缓存破坏，各自拿到完整的 limit。
    //
    // **预期内的缓存失守也不进这张卡**（2026-10-05，用户批准的「让失守提示带上归因」）：
    // 失守这件事本身天天发生，而绝大多数是**我们自己造成的**（重启后端、她自己改 STATE、
    // 工具清单变更、上下文压缩）——它们的代价是预期内的，混进告警区就等于把告警变成背景音。
    // 判据不在这里：`cacheBreak.silent` 由 `model/context-audit.ts` 的 `segmentCause` 算好，
    // 服务端只**照分级展示**（降级的那些一条都不删——它们照旧逐条在日志里，只增不改）。
    const notes: Array<Record<string, unknown>> = [];
    const used: Record<string, number> = { injection: 0, alarm: 0 };
    const quota: Record<string, number> = { injection: limit, alarm: limit };
    const full = (): boolean => Object.keys(quota).every(kind => used[kind]! >= quota[kind]!);

    for (let index = events.length - 1; index >= 0 && !full(); index -= 1) {
      const event = events[index]!;
      if (event.type === 'injection/flagged') {
        if (used['injection']! >= quota['injection']!) continue;
        used['injection'] = used['injection']! + 1;
        const data = event.data;
        notes.push({
          seq: event.seq,
          at: event.ts,
          kind: 'injection',
          label: '注入预警',
          // 等级统一成与告警同一套枚举：界面按 level 取色就够了，不必为两种类别各写一条分支。
          // 注入预警固定 warn——它是"值得看一眼"，不是"出事了"（critical 留给框架自己的告警）
          level: 'warn',
          title: '外部消息里有想指挥她的迹象',
          reason: data.reason,
          quotes: clipFrameworkQuotes(data.quotes),
          // 判定来自规则短路还是问了模型：两者可信度不同，看的人有权知道
          by: data.by,
          fingerprint: null,
          sid: data.sid,
          person: data.person,
          chatType: data.chatType,
          name: contacts[data.sid] ?? null,
        });
        continue;
      }
      if (event.type === 'alarm/sent') {
        if (used['alarm']! >= quota['alarm']!) continue;
        used['alarm'] = used['alarm']! + 1;
        const data = event.data;
        // 这条原始告警后来被"已恢复"销掉了吗（配对判据见 {@link pairedRecoveries}）：
        // 销掉的那条**不再按当前严重渲染**——渲染成"已恢复 · 历史"、等级降到提示。
        // 这是数据里带的配对，不是推断：`alarm/sent` 事件上本来就有 `key` / `recovered`。
        const pair = recoveries.get(event.seq);
        notes.push({
          seq: event.seq,
          at: event.ts,
          kind: 'alarm',
          label: '告警',
          level: data.level,
          title: data.title,
          reason: pair === undefined ? '' : pair,
          quotes: [],
          by: null,
          // 指纹是告警的身份（限流按它算），排障时要拿它对上告警目录里的文件
          fingerprint: data.fingerprint,
          // 告警不来自某个会话：来源是框架自身，字段留 null/空串让界面照实说"框架"
          sid: null,
          person: '',
          chatType: '',
          name: null,
          ...(pair === undefined ? {} : { recovered: true, historical: true }),
        });
        continue;
      }
      // 上下文审计的两类事实都挂在 `budget/consumed` 上（一步一条，见 model/context-audit.ts）。
      // 没有 `cacheBreak` 的那几百条**不进这张卡**——它们不是"框架提示"，只是每次都有的归因事实。
      if (event.type === 'budget/consumed') {
        const data = event.data;
        const cacheBreak = data.cacheBreak;
        if (cacheBreak !== undefined) {
          // 预期内（归因说得清是哪一类自己人干的）：**不进这张卡**——它是日志里的一条普通记录。
          // 老日志没有 `silent` 字段 ⇒ 按"要告警"处理（历史条目一条不丢）。
          if (cacheBreak.silent === true) continue;
          if (used['alarm']! >= quota['alarm']!) continue;
          used['alarm'] = used['alarm']! + 1;
          notes.push({
            seq: event.seq,
            at: event.ts,
            kind: 'cache-break',
            label: CACHE_BREAK_LABEL,
            // 缓存失守是"钱与体感都变差"的事，但循环没坏：warn，不是 critical
            level: 'warn',
            // 标题带上**归因**（2026-10-05）：能走到这里的就是"说不清为什么"的那一类
            title: `缓存前缀失守：${CACHE_BREAK_CLASS_LABEL[cacheBreak.class]}`
              + `${cacheBreak.cause === undefined ? '' : `（${CACHE_BREAK_CAUSE_LABEL[cacheBreak.cause]}）`}`,
            // reason 是**当时记下来的那句话**（渲染/比对同一个纯函数产出），界面原样贴，不加工
            reason: cacheBreak.reason,
            quotes: [],
            by: null,
            fingerprint: null,
            sid: null,
            person: '',
            chatType: '',
            name: null,
          });
        }
        // 归因（`context`）到这里就结束了——**不再进这张卡**（见本函数开头那段口径）。
        // 事件本身照旧落在日志里（`budget/consumed.context`），日志页可以逐条读。
      }
    }

    return { notes, count: notes.length, limit };
  }

  /**
   * 记忆页：`workspace/MEMORIES/` 的真实内容。
   *
   * 为什么需要它：记忆**不进上下文**（design §4.17：她要用就自己 safe_read 读），
   * 所以磁盘是这个系统唯一的真相，而界面上此前**完全没有入口**——人既看不到她有没有记忆，
   * 也看不到她记了什么。facts.md 在这里按分区拆开（标题 + 条目数），其余文件按目录列清单，
   * 点开看原文。
   */
  private memoryView(url: URL): Record<string, unknown> {
    const memDir = memoriesDir(this.deps.dataDir);
    const diary = diaryDir(this.deps.dataDir);

    /**
     * 目录清单（按名倒序：流水账与日记都是按日期命名的，新的在前）。
     *
     * **每条都带上相对 `workspace/` 的 `path`**（2026-10-04 修）：过去这里只给 `name`，
     * 于是"这个文件在哪个子目录"这件事只剩读取端知道，界面只能自己拼——
     * 界面把 `episodes/` 那两组拼成了 `MEMORIES/<name>`，点开就得到一句
     * 「记忆文件 MEMORIES/2026-10-04.md 不存在」（清单里列得出来、点开却说不存在，
     * 是这类"同一份知识存两处"的典型下场）。现在**由列清单的人给出路径**，界面原样用。
     */
    const list = (
      dir: string,
      prefix: string,
    ): Array<{ name: string; path: string; bytes: number; mtime: string | null }> => {
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((name) => !name.startsWith('.') && name.endsWith('.md')).sort().reverse();
      } catch {
        names = [];
      }
      const out: Array<{ name: string; path: string; bytes: number; mtime: string | null }> = [];
      for (const name of names) {
        const stat = statOrNull(join(dir, name));
        if (stat.content === null) continue;
        out.push({ name, path: `${prefix}${name}`, bytes: stat.bytes ?? 0, mtime: stat.mtime });
      }
      return out;
    };

    const factsStat = statOrNull(join(memDir, 'facts.md'));
    const factsContent = factsStat.content ?? '';
    /** 分区：facts.md 的 `## 标题` 与其下的非空行数（原文由 ?file= 取） */
    const sections: Array<{ title: string; lines: number }> = [];
    for (const line of factsContent.split('\n')) {
      if (line.startsWith('## ')) {
        sections.push({ title: line.trim(), lines: 0 });
        continue;
      }
      if (line.trim() !== '' && sections.length > 0) sections[sections.length - 1]!.lines += 1;
    }

    const files = list(memDir, `${MEMORY_DIR_NAME}/`).filter((entry) => entry.name !== 'facts.md');
    const episodes = list(join(memDir, EPISODE_DIR_NAME), `${MEMORY_DIR_NAME}/${EPISODE_DIR_NAME}/`);
    const archive = list(
      join(memDir, EPISODE_DIR_NAME, EPISODE_ARCHIVE_DIR_NAME),
      `${MEMORY_DIR_NAME}/${EPISODE_DIR_NAME}/${EPISODE_ARCHIVE_DIR_NAME}/`,
    );
    const diaries = list(diary, `${DIARY_DIR_NAME}/`);

    const head = {
      dir: memDir,
      // 固定相对路径：memoryView 拼的是字符串，交给 relative() 会被当成相对基准算错
      relative: 'workspace',
      // facts.md 也给 path（与其余三组同一口径）：界面上一处取值、一处使用
      facts: {
        path: `${MEMORY_DIR_NAME}/facts.md`,
        bytes: factsStat.bytes ?? 0,
        mtime: factsStat.mtime,
        sections,
      },
      files,
      episodes,
      archive,
      diary: diaries,
      // 整理节奏：cron 原文（布防与否看启动日志与 timers）
      maintain: { cron: this.deps.config.wake.memoryMaintainCron },
      empty: factsContent === '' && files.length === 0 && episodes.length === 0 && diaries.length === 0,
    };

    const asked = url.searchParams.get('file');
    if (asked === null) return head;

    // 单文件：限制在 workspace/ 之内（记忆文件全在那下面）
    const normalized = asked.replace(/\\/gu, '/').trim();
    if (normalized === '' || normalized.includes('..') || normalized.startsWith('/') || isAbsolute(normalized)) {
      throw badRequest(`记忆文件路径非法：${asked}`);
    }
    const base = resolve(this.deps.dataDir, 'workspace');
    const target = resolve(base, normalized);
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw badRequest(`记忆文件必须落在 workspace/ 之内：${asked}`);
    }
    const stat = statOrNull(target);
    if (stat.content === null) throw notFound(`记忆文件 ${normalized} 不存在`, 'memory-not-found');
    const truncated = stat.content.length > MEMORY_READ_MAX_CHARS;
    return {
      ...head,
      name: normalized,
      bytes: stat.bytes ?? 0,
      mtime: stat.mtime,
      truncated,
      content: truncated
        ? `${stat.content.slice(0, MEMORY_READ_MAX_CHARS)}\n…[已截断：全文 ${stat.content.length} 字符]`
        : stat.content,
    };
  }

  // ── 事件写入（唯一写通道） ──

  /**
   * 命令写事件：seq 分配 → 承诺类落盘（fsync）→ 进投影 → 结算压力。
   * 返回时事件已在磁盘上，命令的"已生效"由此成立（与 real-loop 的 appendSync 同形）。
   *
   * `afterAppend` 在**落库之后、进投影之前**跑，且与落库在同一个同步块里（没有 await）：
   * 「有人开口了」这条通报就是靠它抢在 speak 下一次轮询之前到位的（见 WebServerDeps.noteUserSpoke）。
   * 放在投影之前而不是之后，是因为它描述的是"这条事件刚成为事实"这件事——与投影折没折无关。
   */
  private appendSync(
    type: string,
    data: unknown,
    visibility: 'model' | 'internal',
    afterAppend?: (event: AppEvent) => void,
  ): AppEvent {
    const event = {
      seq: this.deps.log.nextSeq(),
      ts: this.deps.now().toISOString(),
      type,
      data,
      visibility,
      origin: 'web/api',
    } as unknown as AppEvent;
    this.deps.log.append(event, { sync: true });
    afterAppend?.(event);
    applyOne(this.deps.projection, event);
    finalizePressure(this.deps.projection, event.ts);
    return event;
  }
}

/**
 * `child` 是不是落在 `dir` 里面（协议端的入口与安装目录的关系，见 buildProtocolSideView 的 installed 三态）。
 *
 * 两个细节都是实测口径：Windows 上路径**不区分大小写**（`C:\path\to\snowluma` 与
 * `c:\path\to\snowluma` 是同一个目录），
 * 而配置里手打的分隔符正反斜杠都有。比对前统一去掉尾部分隔符、按平台决定要不要小写；
 * 只比前缀是不够的（`C:\path\to\snowluma2` 也以 `C:\path\to\snowluma` 开头），所以要求后面紧跟一个分隔符。
 */
function isUnderDir(child: string, dir: string): boolean {
  if (dir.trim() === '') return false;
  const normalize = (p: string): string => {
    const abs = resolve(p).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const c = normalize(child);
  const d = normalize(dir);
  return c === d || c.startsWith(`${d}\\`) || c.startsWith(`${d}/`);
}

/**
 * 读一个可选的布尔字段（协议端配置写入用）。
 *
 * 三种输入三种待遇，**不互相冒充**：缺省 / null = "这次不动它"（返回 null）；
 * 布尔 = 用它；别的类型（`"true"` 字符串、`1`）当场 400——静默按 truthy 解释，
 * 人会以为"我写的 false 生效了"，实际写进去的是字符串。
 */
function readOptionalBool(raw: unknown, field: string): boolean | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'boolean') {
    throw badRequest(`${field} 只能是 true / false，收到 ${JSON.stringify(raw)}`, 'bad-boolean');
  }
  return raw;
}

/**
 * 取（缺失时新建）文档里的一个对象键。
 *
 * 存在但不是对象时**直接抛**（与 `readConfigServerList` 同一条纪律）：那种形状的 config.json
 * 本来就过不了 `loadConfig`，这台机器根本起不来——这里"尽力而为"地换成一个空对象，
 * 等于把一处响亮的错误悄悄咽掉，还顺手改写了别处的配置。
 */
function requireObjectKey(doc: JsonObject, key: string): JsonObject {
  const current = doc[key];
  if (current === undefined || current === null) {
    const fresh: JsonObject = {};
    doc[key] = fresh;
    return fresh;
  }
  if (!isRecord(current)) {
    throw badRequest(`config.json 的 ${key} 段不是对象：先手工修好它，再来改协议端配置`, 'config-shape');
  }
  return current as JsonObject;
}

/** 点路径写入（`budget.softRatio`）；中间层不是对象就新建一层 */
function setJsonPath(doc: JsonObject, path: string, value: JsonValue): void {
  const parts = path.split('.').filter((part) => part !== '');
  if (parts.length === 0) throw badRequest('字段路径为空');
  let cursor: JsonObject = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cursor[key];
    if (!isRecord(next)) cursor[key] = {};
    cursor = cursor[key] as JsonObject;
  }
  cursor[parts[parts.length - 1]!] = value;
}

// ──────────────────────────── 技能「已忽略」备忘 ────────────────────────────

/**
 * 一个 MCP server 条目**语义上的样子**（比较用；`mcp-save` / `mcp-remove` 的"变没变"判据）。
 *
 * 为什么不直接比较配置文档里那两段 JSON：那样读到的是**存法**，不是**声明**。同一个声明
 * 可以有两种写法（`env: {}` 与不写 `env`；键序不同），而它们对 `McpClientPool` 是同一件事
 * ——界面每次"添加"都带一个空 `env`（见 `extensions_page.dart` 的保存分支），存进去就成了
 * `env: {}`。照字面比，"这次编辑其实改了 command"与"这次只是把空袋子写实了"分不开，
 * 于是**每次保存都叫醒她一次**——正是这一条要防的噪音。
 *
 * 归一化只做三件有依据的事，一件多的都不做：
 *   · 键排序（键序在 JSON 里无意义）；
 *   · 递归丢掉空对象（`{}`：`env`/`tools` 这种"袋子"空着与不写等价）；
 *   · 其余**逐字节留原样**（`false` / `0` / 空字符串都是真声明，一个都不许吞）。
 *
 * 递归是必要的：`toolDefaults` / `tools` 里同样会出现空对象。
 */
function normalizeMcpEntry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeMcpEntry(item));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeMcpEntry(value[key]);
    if (isRecord(normalized) && Object.keys(normalized).length === 0) continue;
    out[key] = normalized;
  }
  return out;
}

/** 一个条目的归一化指纹（比较"同不同"只此一处，两处各写一遍迟早漂移） */
function mcpEntryFingerprint(value: unknown): string {
  return JSON.stringify(normalizeMcpEntry(value));
}

/** 从配置文档里那串**裸**条目里挑出 name 字符串的那些（非对象/无名的交给 `parseMcpServers` 去报） */
function serverNameOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const name = raw['name'];
  return typeof name === 'string' && name !== '' ? name : null;
}

/**
 * 这一次保存**到底改了什么**——净效果，不是"按了几个键"。
 *
 * 为什么按名字两两对比而不是记流水账：同一次保存里 `mcp-save` 只动一条，而"改了什么"
 * 的判据必须与"盘上现在是什么"对得上（写回被回滚时不许留下一条假通报）。
 * 更关键的是**改回原样不算改动**：把 `enabled` 切过去再切回来，声明面与原来逐字节相同，
 * 就没必要叫她（`unchanged` 这一格专门给这条判据留的）。
 *
 * 顺序即事实：`removed` 按"原来在第几个"、`added` / `changed` 按"现在在第几个"
 * ——它们要直接读进给她的那句话里，顺序乱了那句话读起来就像随机抽样。
 */
interface McpDeclChange {
  added: string[];
  removed: string[];
  /** 名字还在、声明变了（command / args / env / enabled 都算，凡进配置的都算） */
  changed: string[];
  /** 名字还在、声明也逐字段相同（**这种不叫醒她**："保存"不等于"变了"） */
  unchanged: string[];
}

function diffMcpDeclarations(before: readonly unknown[], after: readonly unknown[]): McpDeclChange {
  const beforeFp = new Map<string, string>();
  const beforeOrder: string[] = [];
  for (const raw of before) {
    const name = serverNameOf(raw);
    if (name === null) continue;
    beforeFp.set(name, mcpEntryFingerprint(raw));
    beforeOrder.push(name);
  }
  const afterFp = new Map<string, string>();
  const afterOrder: string[] = [];
  for (const raw of after) {
    const name = serverNameOf(raw);
    if (name === null) continue;
    afterFp.set(name, mcpEntryFingerprint(raw));
    afterOrder.push(name);
  }
  const out: McpDeclChange = { added: [], removed: [], changed: [], unchanged: [] };
  for (const name of afterOrder) {
    const prior = beforeFp.get(name);
    if (prior === undefined) out.added.push(name);
    else if (prior === afterFp.get(name)) out.unchanged.push(name);
    else out.changed.push(name);
  }
  for (const name of beforeOrder) {
    if (!afterFp.has(name)) out.removed.push(name);
  }
  return out;
}

/**
 * 这次保存**该不该叫她**、以及该叫什么（给她的那句话的全文）。
 *
 * 两句话的分界（与 `declaredMcpServers` 那一格同口径）：**一个 server 都没变 ⇒ 不叫她**；
 * 变了一条以上 ⇒ 叫一次，正文里把"变了什么"逐字说清。返回 null = 什么也不做。
 */
function mcpChangeWakeNoteOf(change: McpDeclChange, totalAfter: number, hasMcpSection: boolean): string | null {
  const touched = change.added.length + change.removed.length + change.changed.length;
  if (touched === 0) return null;
  // 一句话说清"变了什么"：三段各自成句，空的那段不出现（不写"删除了：无"这种机器腔）
  const what = [
    change.added.length > 0 ? `加了 ${change.added.join('、')}` : '',
    change.removed.length > 0 ? `删了 ${change.removed.join('、')}` : '',
    change.changed.length > 0 ? `改了 ${change.changed.join('、')}` : '',
  ].filter((part) => part !== '').join('，');
  // 一个都没剩时说"现在一个都没有"，而不是"一共 0 个"——后者读起来像个故障码
  const total = totalAfter === 0
    ? '现在一个都没有了'
    : hasMcpSection
      ? `现在一共 ${totalAfter} 个`
      : `现在一共 ${totalAfter} 个（配置里那一段还没写过）`;
  return [
    `你手边的 MCP 声明改了：${what}。${total}。`,
    '要看工具清单就用 `mcp` 工具（不带 server 看有哪些 server）。',
  ].join('\n');
}

/**
 * 这次改动的**身份**（幂等键里那半段）：**动了哪些 server**，不含正文。
 *
 * 为什么不拿正文当键（第一版正是这么写的，探针当场测出）：正文里带着"现在一共几个"，
 * 于是**同一组改动**在两次提交之间会凑出两句不同的话（数字不一定一样）、两个不同的键
 * ⇒ 本该被幂等吃掉的那一次照旧叫醒她。而"动了谁"才是这次改动稳定不变的那部分。
 *
 * ⚠️ 它**不是**"把 5 秒内的所有编辑并成一条"：两次各改一个不同的 server 是两个身份、
 * 两个键，各自都会到（那是两件事，不是同一组改动的重复提交）。
 */
function mcpChangeIdentityKeyOf(change: McpDeclChange): string {
  return [
    `+${[...change.added].sort().join(',')}`,
    `-${[...change.removed].sort().join(',')}`,
    `~${[...change.changed].sort().join(',')}`,
  ].join('|');
}

/**
 * 回执里"叫没叫她"那两格（`mcp-save` / `mcp-remove` 共用）。
 *
 * 为什么要如实回：人在界面上点完保存，下一个问题必然是"她知道了没"。而"没叫她"有两种
 * 完全不同的原因（这次没改动 / 这条通报撞上了幂等时间片），界面与人都得能分辨。
 */
function mcpWakeReceiptFields(
  change: McpDeclChange,
  beforeHadSection: boolean,
  after: { servers: readonly Record<string, unknown>[]; hasSection: boolean },
): { changedServers: string[]; wake: string } {
  const note = mcpChangeWakeNoteOf(change, after.servers.length, after.hasSection);
  const changedServers = [...change.added, ...change.removed, ...change.changed];
  if (note === null) {
    return {
      changedServers,
      wake: beforeHadSection === after.hasSection
        ? '这次声明面没变，没叫她'
        : '这次只补了配置里那段声明的位置，没叫她',
    };
  }
  return {
    changedServers,
    wake: '已按既有那条真唤醒路径（wake/manual）通报她一次：'
      + '与聊天框同一条路（她下一拍真的起一个 turn，正文进那一轮的请求体）；'
      + '同一组改动 5 秒内重复只通报一次，不会连发。',
  };
}

/**
 * `config.json` 里**有没有** `mcp.servers` 这一段（盘上/文档里的事实，不解析、不校验）。
 *
 * 为什么要单独判一次：`readConfigServerList` 会**就地补**出这个键（改配置时需要的副作用），
 * 所以"改完之后一定有这一段"这件事本身不说明原来有没有。而"原来一个都没有"与"原来那段
 * 根本没写过"在她那一格是两句不同的话（见 `declaredMcpServers`），通报里也不能含糊。
 */
function hasConfigServerSection(doc: JsonObject): boolean {
  const mcpRaw = doc['mcp'];
  if (!isRecord(mcpRaw)) return false;
  return Array.isArray((mcpRaw as JsonObject)['servers']);
}

/**
 * 配置文档里那串**声明**的一份浅拷贝（判"变没变"用；`push`/`splice` 改不到它）。
 *
 * 元素是引用，但比较只看**内容**（`mcpEntryFingerprint` 是当场算出来的），所以浅拷贝够用。
 * 缺这一段/形状不对 ⇒ 空数组：这是"还没声明过任何 server"的正常态，不是错误
 * （真错在 `parseMcpServers` 那一层，它在写盘之后会响）。
 */
function snapshotConfigServerList(doc: JsonObject): readonly Record<string, unknown>[] {
  const mcpRaw = doc['mcp'];
  if (!isRecord(mcpRaw)) return [];
  const servers: unknown = (mcpRaw as JsonObject)['servers'];
  if (!Array.isArray(servers)) return [];
  return (servers as unknown[]).filter((item): item is Record<string, unknown> => isRecord(item));
}

/**
 * 取配置文档里 `mcp.servers` 那份**活数组**（就地改它，写回时改的就是它）。
 *
 * 为什么必须返回活引用：`mcp.servers` 是对象数组，`splice`/`push` 只作用于数组本身；
 * 若这里回传一份拷贝，`mcp-remove` 的删除就永远落不到盘上（而 `mcp-save` 的原地赋值
 * 却会生效——那种"一半生效"的 bug 最难查）。所以缺 `servers` 时**先把键补进文档**，
 * 再回传文档里的引用。
 *
 * 形状不对时直接抛：`mcp.servers` 不是数组意味着整份配置本来就过不了 `parseMcpServers`，
 * 那台机器根本起不来——这里"尽力而为"地改成数组，等于把一处响亮的错误悄悄咽掉。
 */
function readConfigServerList(doc: JsonObject): Record<string, unknown>[] {
  const mcpRaw = doc['mcp'];
  let target: JsonObject;
  if (mcpRaw === undefined || mcpRaw === null) {
    target = {};
    doc['mcp'] = target;
  } else if (!isRecord(mcpRaw)) {
    throw badRequest('config.json 的 mcp 段不是对象：先手工修好它再来改服务');
  } else {
    target = mcpRaw as JsonObject;
  }
  const serversRaw = target['servers'];
  if (serversRaw === undefined || serversRaw === null) {
    target['servers'] = [];
    return target['servers'] as unknown as Record<string, unknown>[];
  }
  if (!Array.isArray(serversRaw)) {
    throw badRequest('config.json 的 mcp.servers 不是数组：先手工修好它再来改服务');
  }
  // 非对象元素**不在这里拦**：那是 parseMcpServers 的活（它会给出带下标的原因）。
  // 这里只保证"回来的是对象引用"，让下面的增删改不会改到空气上。
  for (const [index, item] of serversRaw.entries()) {
    if (!isRecord(item)) throw badRequest(`mcp.servers[${index}] 不是对象：先手工修好它再来改服务`);
  }
  return serversRaw as unknown as Record<string, unknown>[];
}

/**
 * 读 `<dataDir>/skills-ignored.json`。形状 `{"<name>": true}`——用映射而不是数组，
 * 是为了让这份文件将来能长出别的字段（比如"忽略时它的 contentHash 是多少"，
 * 那样"被忽略的技能改过之后要不要重新冒出来"就有判据了），而数组会长成一条死路。
 *
 * 三种输入各有归属：文件不存在 = 谁都没忽略过（空集，正常态）；JSON 坏了 = 也不报错，
 * 退回空集（一份界面备忘不该拦住整页数据）；值不是 `true` 的键一律不算数。
 */
function readIgnoredSkills(dataDir: string): Set<string> {
  const file = join(dataDir, SKILLS_IGNORED_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return new Set();
  }
  if (!isRecord(raw)) return new Set();
  const out = new Set<string>();
  for (const [name, value] of Object.entries(raw)) {
    if (value === true && name.trim() !== '') out.add(name);
  }
  return out;
}

/** 写 `<dataDir>/skills-ignored.json`：原子写（临时文件 + rename），键按名排序保证 diff 稳定 */
function writeIgnoredSkills(dataDir: string, names: ReadonlySet<string>): void {
  const file = join(dataDir, SKILLS_IGNORED_FILE);
  const doc: JsonObject = {};
  for (const name of [...names].sort()) doc[name] = true;
  writeFileAtomicSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

// ──────────────────────────── 技能骨架模板 ────────────────────────────

/**
 * SKILL.md 的骨架（frontmatter 只给两个必填字段）。
 *
 * description 用**单行双引号**写：它在 YAML 里是最不容易被写坏的一种形态
 * （`:`、`#`、`-` 开头的值都不会被误解析）。正文那段注释是给人看的提示——
 * 它同时说明了一件容易被忘掉的事：正文不进上下文，写得细不吃常驻预算。
 */
function skillTemplate(name: string, description: string): string {
  const quoted = description.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
  return [
    '---',
    `name: ${name}`,
    `description: "${quoted}"`,
    '---',
    '',
    SKILL_TEMPLATE_BODY_HINT,
    '',
    '## 什么时候用它',
    '',
    '（写清触发场景与关键词：description 决定她**想不想起来**，这里决定她**照着做对不对**。）',
    '',
    '## 步骤',
    '',
    '1. ',
    '',
    '## 算完成',
    '',
    '- ',
    '',
  ].join('\n');
}

/**
 * 技能名的唯一入口校验：目录名即技能名，官方规范只收小写字母、数字与连字符。
 * 判据本体在 `skillNameProblem`（skill/skills.ts）——新建与删除共用同一把尺子，
 * 而删除那侧的判定里还包含"显式挡路径穿越"，理由见该函数的注释。
 */
function assertSkillName(name: string): void {
  const problem = skillNameProblem(name);
  if (problem !== null) throw badRequest(problem, 'bad-skill-name');
}

// ──────────────────────────── MCP 连接探测（测试连接） ────────────────────────────

interface McpProbeOutcome {
  ok: boolean;
  /** 失败原因（人话，含下一步）；成功时为 null */
  reason: string | null;
  /** 失败分类：给界面区分"命令不存在 / 握手超时 / 协议不符" */
  failureKind: 'spawn' | 'timeout' | 'protocol' | 'config' | 'unknown' | null;
  protocolVersion: string | null;
  /** server 握手时自报的身份（`{name, version}`）；未握手为 null */
  serverInfo: { name: string; version: string } | null;
  tools: McpToolInfo[];
  stderrTail: string;
  durationMs: number;
  shutdownStages: string[];
}

/**
 * 探测用一个「不落事件」的宿主。
 *
 * 为什么不复用 `McpClientPool`（client.ts）：池会把生命周期写进 `mcp/server-started` /
 * `mcp/server-stopped`。那是**真实运行期**的事实，而这个进程握手完就被我们收掉了——
 * 往日志里写一条 started 会让扩展页此后显示"已运行"，而它其实只是个测试留下的残影。
 * 事件日志是唯一真相源，宁可这条测试在日志里不留痕（结果直接回给点按钮的人）。
 */
class McpProbeHost implements McpConnectionHost {
  // version 与 `main.ts` 的 AGENT_VERSION 同步（两处必须一起改）
  readonly clientInfo = { name: 'irmia-agent', version: '0.1.0-beta.6' };
  readonly protocolVersion = DEFAULT_PROTOCOL_VERSION;
  readonly progressHardCapMs = 60_000;
  readonly defaultRequestTimeoutMs: number;

  private readonly sink: (line: string) => void;

  constructor(requestTimeoutMs: number, sink: (line: string) => void) {
    this.defaultRequestTimeoutMs = requestTimeoutMs;
    this.sink = sink;
  }

  now(): number {
    return Date.now();
  }

  log(line: string): void {
    this.sink(line);
  }

  syncServerTools(): void {
    // 探测过程**不进注册表**：注册表是"她此刻能用什么"，一次测试不该改变它
  }

  onListChangedRefresh(): void {
    // 探测窗口很短，list_changed 没有下游要同步；下次真启动时池会照常处理
  }

  onConnectionExit(): void {
    // 退出事实由 probe 那一侧按退出码/退出时序判断，这里不再重复记账
  }

  onProtocolViolation(): void {
    this.sink('协议违规：stdout 只允许写合法 JSON-RPC（日志必须走 stderr）');
  }

  gracefulCancel(): void {
    // 探测里没有"取消宽限"这一档：超时即杀，杀掉就完事
  }
}

/**
 * 拉起一个 MCP server、握手、拉 `tools/list`，然后**无条件**按关机序列收掉它。
 *
 * 三条纪律（都来自"这条命令会真的起进程"这件事）：
 *   ① **必须有超时**：握手 + list 共用一份预算，到点就走 kill 路径，绝不吊着 HTTP 请求；
 *   ② **必须能杀掉**：复用池的关机序列（关 stdin → SIGTERM → SIGKILL），不另写一条关停路径；
 *   ③ **失败绝不能带崩主进程**：全程 catch，任何异常都折算成 `ok: false` + 人话原因。
 */
async function probeMcpServer(
  entry: McpServerEntry,
  options: { timeoutMs: number; spawner: (entry: McpServerEntry) => McpProcess },
): Promise<McpProbeOutcome> {
  const startedAt = Date.now();
  const notes: string[] = [];
  const host = new McpProbeHost(options.timeoutMs, (line) => notes.push(line));

  let child: McpProcess;
  try {
    child = options.spawner(entry);
  } catch (err) {
    return {
      ok: false,
      reason: `进程未能启动（${entry.command}）：${describeError(err)}。`
        + '检查 command 是否可执行（绝对路径最稳）、args 有没有写错。',
      failureKind: 'spawn',
      protocolVersion: null,
      serverInfo: null,
      tools: [],
      stderrTail: '',
      durationMs: Date.now() - startedAt,
      shutdownStages: [],
    };
  }

  const conn = new McpConnection(entry, child, host);
  child.onStdout((chunk) => conn.onStdoutChunk(chunk));
  child.onStderr((chunk) => conn.onStderrChunk(chunk));
  child.onExit((code, signal) => conn.onProcessExit(code, signal));

  /** 关机序列（与池的 reap 同一顺序；这里只为"测试完必须不留进程"服务） */
  const reap = async (): Promise<string[]> => {
    const stages: string[] = [];
    conn.closeStdin();
    stages.push('stdin-closed');
    if (await conn.waitExit(MCP_TEST_SHUTDOWN_STDIN_WAIT_MS)) {
      stages.push('exited');
      return stages;
    }
    conn.killProcess('SIGTERM');
    stages.push('sigterm');
    if (await conn.waitExit(MCP_TEST_SHUTDOWN_TERM_WAIT_MS)) {
      stages.push('exited');
      return stages;
    }
    conn.killProcess('SIGKILL');
    stages.push('sigkill');
    if (await conn.waitExit(MCP_TEST_SHUTDOWN_KILL_GRACE_MS)) stages.push('exited');
    return stages;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
  });

  const attempt = (async (): Promise<'done' | 'exited'> => {
    try {
      await conn.handshake();
      return 'done';
    } catch (err) {
      // 起不来的命令（ENOENT）走的是"只有 error 没有 exit"那条路：先等一拍看它是不是已经死了，
      // 死透了就报 spawn 失败而不是握手失败——这是两种完全不同的下一步动作
      if (conn.hasExited) return 'exited';
      throw err;
    }
  })();

  let handshakeError: unknown = null;
  let finished: 'done' | 'exited' | 'timeout' | 'error' = 'error';
  try {
    const raced = await Promise.race([attempt, timeout]);
    finished = raced === 'timeout' ? 'timeout' : raced;
  } catch (err) {
    handshakeError = err;
    finished = 'error';
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  const stderrTail = conn.stderrTail();
  const tools = finished === 'done' ? [...conn.tools] : [];
  const protocolVersion = conn.negotiatedProtocolVersion;
  const shutdownStages = await reap().catch(() => [] as string[]);

  if (finished === 'done') {
    return {
      ok: true,
      reason: null,
      failureKind: null,
      protocolVersion,
      // 上报的 serverInfo 是 server 自己认的名字（与配置里的 name 可能不同，两个都值得看见）
      serverInfo: conn.serverInfo,
      tools,
      stderrTail,
      durationMs: Date.now() - startedAt,
      shutdownStages,
    };
  }
  if (finished === 'timeout') {
    return {
      ok: false,
      reason: `握手超时（${options.timeoutMs}ms）：已按关机序列收掉这个进程。`
        + '常见原因是 server 启动很慢、或者它把日志写到了 stdout（stdout 只允许写 JSON-RPC）。'
        + '可以调大超时再试一次。',
      failureKind: 'timeout',
      protocolVersion,
      serverInfo: null,
      tools,
      stderrTail,
      durationMs: Date.now() - startedAt,
      shutdownStages,
    };
  }
  if (finished === 'exited') {
    return {
      ok: false,
      reason: `进程起来就退了（${entry.command}）：命令不存在、args 不对，或它自己启动失败。`
        + `${stderrTail === '' ? '它没有往 stderr 写任何东西。' : `stderr 尾部：${stderrTail}`}`,
      failureKind: 'spawn',
      protocolVersion: null,
      serverInfo: null,
      tools: [],
      stderrTail,
      durationMs: Date.now() - startedAt,
      shutdownStages,
    };
  }
  return {
    ok: false,
    reason: `握手失败：${describeError(handshakeError)}`
      + `${stderrTail === '' ? '' : `；stderr 尾部：${stderrTail}`}`,
    failureKind: handshakeError instanceof Error && handshakeError.name === 'McpProtocolError' ? 'protocol' : 'unknown',
    protocolVersion,
    serverInfo: null,
    tools: [],
    stderrTail,
    durationMs: Date.now() - startedAt,
    shutdownStages,
  };
}

// ──────────────────────────────── 工厂 ────────────────────────────────

/**
 * 建服务（不监听）。认证库在这里落定：注入了就用注入的，否则读
 * `<dataDir>/.auth.json`（并兼容老实例的 `.ui-token`）——口径只有一份，在 `web/auth.ts`。
 */
export function createWebServer(deps: WebServerDeps): WebServer {
  return new WebServerImpl(deps);
}

/** 建服务并监听（测试与宿主都用这个入口） */
export async function startWebServer(deps: WebServerDeps): Promise<WebServer> {
  const server = createWebServer(deps);
  await server.listen();
  return server;
}
