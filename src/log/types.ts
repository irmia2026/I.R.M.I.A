/**
 * Irmia Agent — 事件类型全集
 * 与 docs/schema.md §1-§7 逐字对齐。修改事件形状必须先改 schema 文档。
 *
 * 值导入写 `.ts`、纯类型导入写 `.js`（Node 的 --experimental-strip-types 只擦类型、
 * 不改写路径解析）。这里导入上下文审计的两个**类型**：它们是 `budget/consumed` 上
 * 两个可选字段的形状，TypeScript 会整条擦除，运行期不留依赖。
 */

import type { CacheBreak, ContextBreakdown } from '../model/context-audit.js';
import type { ChannelNoticeData } from '../channel/self-identity.js';
import type { ChannelSelfActionData } from '../channel/self-action.js';

// ──────────────────────────────── 信封 ────────────────────────────────

/** 可见性：model 事件参与上下文渲染；internal 仅作簿记与审计，永不进模型请求 */
export type Visibility = 'model' | 'internal';

export interface EventEnvelope<T extends string = string, D = unknown> {
  /** 全局单调递增序号，允许空洞（崩溃留下的空位）。分配器单例，重启后从日志最大 seq + 1 继续 */
  seq: number;
  /** ISO 8601，带时区 */
  ts: string;
  /** 事件类型，格式为 `<域>/<名词>` */
  type: T;
  /** 事件负载 */
  data: D;
  /** 可见性 */
  visibility: Visibility;
  /** 可选：产生此事件的代码位置，便于排障 */
  origin?: string;
  /** 子代理 turn 链归属标记：指向父 turn 的 task 调用 */
  parentCallId?: string;
}

// ──────────────────────────────── 基础枚举 ────────────────────────────────

export type SideEffect = 'none' | 'idempotent' | 'destructive';

export type ToolResultStatus =
  | 'ok'
  | 'error'
  | 'timeout'
  | 'denied'
  | 'unknown'
  | 'aborted'
  /** 单步工具调用数超上限：本调用未派发（design.md §4.6 单 step 层） */
  | 'over-limit';

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked'; by: string }
  /**
   * `cause` 说的是**谁让它停的**：`user` 她自己的工具（speak 被打断一类）、
   * `signal` 进程信号/宿主取消、`shutdown` 关机序列、`stop` 用户在通道里按了 `/stop`（2026-10-16 加）。
   * 分出 `stop` 是为了让事后读日志的人一眼看出"这一轮是被人掐的"——它与崩溃/关机
   * 在日志上长得一样（都是 aborted），而处置完全不同：人在等一句回执。
   */
  | { kind: 'aborted'; cause: 'user' | 'signal' | 'shutdown' | 'stop' }
  | { kind: 'interrupted' }
  /**
   * **这一轮没能正常说完，但已收到的部分留着、输入不退回**（2026-10-18；两处来源，各带自己的
   * `reason`，观测面上一眼可分）：
   *
   *   · `'content_filter'` —— 上游 `response.incomplete{reason:'content_filter'}`：输出被内容策略
   *     截断。**在这之前它落到 `completed`**（"没有工具调用"被当成"说完了"），账本读起来像成功。
   *     它不是我们的失败（与 `max-tokens` 同族，不进失败刹车）。
   *   · `'partial'` —— **非首步**的断流/静默超时/硬顶（`DsStreamResult.interrupted`）：本轮已经
   *     花掉的工作不作废，整轮不重投。`code` 是客户端报的那只闸
   *     （`timeout_silent` / `timeout_hard_cap` / `stream_interrupted` / …），只在这一档出现。
   *     首步超时**不是**这一档：那一轮还什么都没做 ⇒ 照旧 `error` + 退回队列（一次完整重试）。
   */
  | { kind: 'incomplete'; reason: 'content_filter' | 'partial'; code?: string }
  /**
   * 本轮以失败收尾。`retry` 说的是**这一轮认领的输入要不要退回队列**（2026-10-16 加的**可选**字段，
   * 老日志里整个没有 ⇒ 按缺省读）：
   *   · 缺省 / `'next-turn'` —— 退回去（原口径：整轮失败时输入不该就此消失，还有一次完整机会）；
   *   · `'none'` —— **不退回**：这一轮已经花掉的工作不作废，也不把同一个请求原样重发一遍。
   *     今天用它的只有一处：**非首步超时**（她上下文里已经有这一步之前的输出与工具结果，
   *     重跑一遍等于把同一段活干第二次——用户报的那个循环正是这么滚起来的）。
   * 它只影响"退不退"，不改结局本身（结局仍然是失败、仍然进失败刹车）。
   *
   * ───────── `reasoningEcho`：400 的一种可判别指纹（2026-10-17 加，**可选**、纯观测）─────────
   *
   * `true` = 服务端原话里带着「`reasoning_text` … must be passed back」——思考模式要求把上一轮的
   * 思维链**原样回传**。2026-10-17 之前我们的 `message/reasoning` 是 `visibility:'internal'`
   * （一个 reasoning item 都没回过），于是这条请求被 400 拒掉；**v68 起它改成 model 并按帽回传**
   * （见 `model/render.ts` 的 v68 篇）。这一格是**指纹落地（2026-10-17）之后**才写进去的：
   * 更早那 23 条同名 400 **没有这一格**（那时还没有这个判据，只能从 `message` 里的原话认）；
   * 今后再出现同类 400（包括 v68 之后再出现）照样会带上它。
   * 判据（大小写 / 中间的字符 / 200 字上限）唯一实现在
   * `model/ds-client.ts` 的 `isReasoningEchoRejection`，这里只装结论。
   *
   * **它不改结局**：`kind` 仍是 `error`、`code` 仍是 `http_400`、仍然不重试、输入照旧退回队列
   * （退回本身由 `retry` 那一格管，与本字段无关）。加这一格的唯一理由是**同一个 `http_400`
   * 里混着好几类原因**（实测 57 条：23 条是这条、32 条是图片格式不被接受），而它们的处置
   * 完全不同——没有这一格，事后只看得见一个 `http_400`，两条线索一起丢。
   *
   * 缺省 ⇒ **老日志与"别的 400"**，按缺省读（不是 `false`：没标出来就是不认识，不是"确认不是"）。
   * 它不进请求体（`turn/end` 是 internal 事件），所以**不动 `RENDER_VERSION`**。
   */
  | {
    kind: 'error'; message: string; code: string; retry?: 'next-turn' | 'none';
    /** 400 的一种可判别指纹：思维链没回传（见上面那段）。缺省 = 不认识这一类 */
    reasoningEcho?: true;
  }
  | { kind: 'budget-exhausted'; layer: BudgetLayer }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'max-tokens'; outputTokens: number };

export type BudgetLayer = 'step' | 'turn' | 'task' | 'daily';

export type WakeSource = 'timer' | 'file' | 'webhook' | 'manual' | 'heartbeat' | 'intention' | 'job' | 'channel';

export type ModelLane = 'heavy' | 'light';

// ──────────────────────────────── 生命周期 ────────────────────────────────

export interface SessionStart extends EventEnvelope<'session/start', {
  pid: number; cwd: string; version: string;
  schemaVersion: string;
  configHash: string;
}> {}

export interface SessionEnd extends EventEnvelope<'session/end', {
  reason: 'shutdown' | 'error' | 'signal'; detail?: string;
}> {}

export interface TurnStart extends EventEnvelope<'turn/start', { turn: number }> {}

/**
 * 「这一轮为什么没开口」的理由码（**封闭枚举**；2026-10-19 加，纯事件层）。
 *
 * 它只回答一件事：**`turn/end{completed, spoke:false}` 那一拍，她为什么没说话**。
 *   · `tired` / `unwell` / `busy` —— 她自己的状态（累 / 不舒服 / 在忙）；
 *   · `nothing_worth_saying` —— 没有值得开口的东西（空拍，或模型看完一个字都没吐）；
 *   · `waiting_for_owner` / `quiet_hours` —— 时机不对（在等用户 / 安静时段）；
 *   · `other` —— 认不出来（**读侧也把所有不认识的 code 归到这一档**）。
 *
 * 为什么是**封闭**枚举而不是自由字符串：code 要能被 grep、能按它分组、能进报表；
 * 自由字符串等于没有分类。而"判不出来"这一档必须存在（`other` + 原样保留的 `note`），
 * 否则写侧只能为了凑枚举去编一个假理由——那比没有这一格更糟。
 */
export type IdleReasonCode =
  | 'tired'
  | 'unwell'
  | 'busy'
  | 'nothing_worth_saying'
  | 'waiting_for_owner'
  | 'quiet_hours'
  | 'other';

/**
 * 挂在 `turn/end` 上的**可选**一格：这一轮**没开口**时，她那句理由。
 *
 * 为什么加在 `turn/end` 上而不是新开一种事件：这一格回答的正是 `spoke:false` 留下的那个问题，
 * 它与 `spoke` / `reason` 是同一件事的三面——另起一种事件就得靠 seq 回头配对，而"同一拍的沉默
 * 为什么"本来就该长在同一条记录上。
 *
 * 什么时候有这一格（判据只在 `runtime/agent-loop.ts` 的 `idleReasonFor` 一处）：
 *   · 只有 **`reason.kind === 'completed'` 且 `spoke === false`**（整拍没开口）才写；
 *     别的结局 `reason` 自己已经说清了（失败 / 被掐 / 预算撞线 / 等待人审），再标一格
 *     是把同一件事说两遍；
 *   · **纯机械路径**（一步都没起 ⇒ 没有输入可认领）只有 `code`、**没有 `note`**：
 *     这一拍没有任何人说话，编一句"人话"就是伪造她的理由。
 *
 * 向后兼容：老日志整个没有这一格 ⇒ 读侧（`log/idle-reason.ts` 的 `idleReasonOf`）给 `null`，
 * 显示成"未记录"，**不许当错误**。它**不进请求体**（`turn/end` 是 internal）⇒ 不动
 * `RENDER_VERSION`。
 */
export interface IdleReason {
  /** 理由码（封闭枚举；读侧不认识的一律归 `other`） */
  code: IdleReasonCode;
  /**
   * 她那句话的**开头一截**（单行、≤80 字；口径见 `log/idle-reason.ts`）。
   *
   * 为什么是"她那句话"而不是一句我们写的话：这一格存在的理由就是**可查证**——
   * 原文在 `message/reasoning` 里逐字留着，这里只做线索。写侧判不出 code 时照样保留它
   * （归 `other`），**一个字都不改**。
   */
  note?: string;
}

export interface TurnEnd extends EventEnvelope<'turn/end', {
  turn: number; reason: TurnEndReason; spoke: boolean;
  /**
   * 这一轮为什么没开口（**可选**；2026-10-19 加，纯事件层，形状与判据见上面 `IdleReason`）。
   * 老日志没有这一格 ⇒ 读侧按"未记录"处理，**不是错误**。
   */
  idleReason?: IdleReason;
}> {}

/**
 * 一条通道唤醒的**显示名**（谁在哪个会话里说的）：唤醒正文那三个标签
 * `session=` / `sid=` / `person=` 的素材。
 *
 * 为什么它的类型长在事件层（`log/types`）而不只是渲染层：从 2026-10-22 起它也是
 * **`step/start` 的一格**——"当时装配这一份请求时，宿主给她配的名字是什么"必须**落进日志**，
 * 否则重放只能拿现在的别名表反推（人改过名字之后，那一条就再也对不上）。渲染层仍然只接收
 * 结论（缓存铁律 1：不读文件、不查表），名字真源仍是 `channel/sessions.ts` 的
 * `resolveNameForSid` / `resolvePersonNameFromTables`。
 *
 * 三个字段都可选：解析不出名字就**省略**那一段，绝不编（省略 ≠ 写了空串）。
 */
export interface ChannelRenderContext {
  /** 会话显示名（群名/人名）。没有就省略这一段，不编 */
  sessionLabel?: string;
  /** 会话 sid（与回投地址同形）。填了它她才有一条能直接喂给 speak `to` 的标识 */
  sid?: string;
  /** 发言者显示名（能解析出名字就带名字；解析不出就省，退回 openid） */
  personLabel?: string;
}

export interface StepStart extends EventEnvelope<'step/start', {
  turn: number; step: number; model: string;
  lane: ModelLane;
  renderVersion: string;
  personaHash: string;
  /**
   * **本步渲染时用的通道显示名**（2026-10-22 加；internal ⇒ 不进请求体、不动 `RENDER_VERSION`）。
   *
   * 为什么记在 `step/start` 上：它和 `renderVersion` / `personaHash` 是同一类东西——"这一份
   * 请求当时是怎么装配出来的"的一份指纹。名字的真源是 `config.persona.contacts`、
   * `MEMORIES/aliases.md`（会话别名 + 群成员别名两段）与 `data/group-members.json`，
   * **三样都不在事件里**；不记下来，重放就只能拿"现在这份"反推，人改过名字之后
   * "当时她看到的是谁"永远对不上——而重放的全部价值就是这一条。
   *
   * 值域：
   *   · 对象 = 本轮钉住的那条唤醒是 `wake/channel`、且宿主解析出了上下文（实时唯一的生产者
   *     是 `real-loop.channelRenderContext`，写入口是 `agent-loop.runStep`）；
   *   · `null` = 这一轮不是通道轮（心跳 / 定时器 / 界面消息 / 子代理），与"不传"逐字节相同；
   *   · **老日志没有这一格**（`undefined`）⇒ 读侧按"未记录"处理：重放退回按盘上现在这份
   *     重算，并在报告 notes 里如实说"这是现在这份，不是当时那份"——**不是错误**。
   *
   * 它只作用于**本轮钉住的那条唤醒**（`render.ts` 的 `contextFor`），历史段一个字节都不吃它
   * ——所以"历史段与本轮唤醒类型无关"这条不变量不受这一格影响。
   */
  channelRender?: ChannelRenderContext | null;
}> {}

export interface StepEnd extends EventEnvelope<'step/end', {
  turn: number; step: number; toolCalls: number;
}> {}

/**
 * **本步推理进度的实时读数**（2026-10-17 加；internal）：只喂界面那一行「已想 X 字」。
 *
 * 为什么需要它：推理正文是**一步跑完才发一条整段**（紧随的 `message/reasoning`，见
 * `runtime/agent-loop.ts` 的 `runStep`），上游 `reasoning_text.delta` 在那之前**一个都不落事件**。
 * 实测 turn 2115：`step/start` 之后空了 153 秒才等来那条 62,854 字的正文——那 153 秒里界面手上
 * 一个字都没有，那一格只能显示「…」。这条事件把"到这一刻已经生成了多少字"按节拍漏出来，
 * 让那个读数**在落库之前也是真的**。
 *
 * 三条纪律（改它之前先读）：
 *   ① **载荷里不许有正文，一个字符都不许**：只有 `turn`/`step` 两格定位 + `chars` 一个数。
 *      它不是 `message/reasoning` 的摘要或预览，是个**计数器**。
 *   ② **`chars` 的口径是 UTF-16 码元**（上游 `delta.length` 之和），与 `result.reasoning.length`、
 *      界面 `text.length` 同一把尺——三个数要能对上，否则"实时值"与"落库真值"就差一截。
 *   ③ **刻意 internal**（`EVENT_VISIBILITY` 里**显式写出**，不靠 defaultVisibility 兜底：
 *      让"这条线是有意画的"看得见）。挡住它的**全是既有判据，没有为它加一行剥离代码**：
 *      `model/render.ts` 的 `isModelVisible` 只认 `visibility === 'model'`，而 `renderEvents`
 *      第一步就用它 filter；`state/fold.ts` 的 `applyOne` 走 default 分支（不进投影）。
 *      ⇒ "新事件要不要在 render 里再显式挡一下"的答案是**不用**，别再补一遍。
 *
 * 节拍与体积：有 delta 才判，`chars` 变了且距上一条 ≥5s（本步前 120 秒）/ ≥15s（之后）才发一条；
 * 单条约 178 字节，典型一步 0–3 条，40 分钟的极端一步 175 条 / 约 30 KB。流结束时**不补尾条**
 * ——紧随其后的 `message/reasoning` 才是真值，补一条只多字节、还制造"live 后到"的次序风险。
 *
 * **已知偏差（有意留的）**：`DsClient` 内部重试同一次 `stream()` 时本计数器**跨尝试累加**，
 * 而落库的 `result.reasoning` 是**最后一次尝试**的正文 ⇒ 极端下（第一次尝试吐了字之后被掐、
 * 重试成功）这条读数会大于最终的 `chars`。不改成"按 attempt 归零"的理由：重试通道
 * （`DsClient.subscribeRetry`）是**进程级多播、不带 lane**，别的 lane 的一次重试就会把我们的数
 * 误归零——那个错比这点偏差更贵。偏差由 `message/reasoning` 那条真值覆盖修正。
 */
export interface StepReasoningProgress extends EventEnvelope<'step/reasoning-progress', {
  turn: number; step: number; chars: number;
}> {}

// ──────────────────────────────── 消息 ────────────────────────────────

export interface UserMessage extends EventEnvelope<'message/user', {
  text: string; source: 'human' | 'timer' | 'webhook' | 'file' | 'intention' | 'job';
}> {}

export interface AssistantMessage extends EventEnvelope<'message/assistant', {
  text: string | null;
  toolCalls: Array<{ callId: string; name: string; arguments: string }>;
  interrupted?: boolean;
}> {}

/**
 * 思维链（**v68 起 `visibility:'model'`**；**v73 起渲染层全量回传**，见 `model/render.ts` 的
 * `REASONING_ECHO_POLICY`：不按条数截、不截正文，撞总字符硬上限才**整组丢**）。
 *
 * 这条事件的可见性在 2026-10-17 之前是 `internal`（只供复盘、渲染层剥离），后果是 Responses API
 * 里一个 reasoning item 都没回过：思考模式的服务端直接 400（实测 23 条
 * `The reasoning_text in the thinking mode must be passed back to the API`），而每轮退输入 +
 * `MAX_CLAIM_COUNT=3` 会把整场风暴送进死信。v68 把它改成 model。
 *
 * ⚠ **v68 那套"只回传最近 3 条 / 单条 ≤ 20k、超了截尾"的帽子已被 v73 废止**：它让 assistant 条目
 * 留在请求里、却只带上最近 3 条的 `reasoning_text` —— **条目在、思维链缺**，2026-10-20 撞出
 * "每一轮都 400"（`000000193430.jsonl` 的 turn 2891–2896）。现在的规矩是"要么全发、要么整条不发"。
 *
 * ⚠ 老日志里的这条事件仍是 `internal`（落库那一栏是历史，不改写）⇒ 它们照旧**不进请求**；
 * 新写入的走 `defaultVisibility`，于是自动变成 model。详见 `EVENT_VISIBILITY` 里那一格。
 */
export interface ReasoningMessage extends EventEnvelope<'message/reasoning', {
  turn: number; step: number; text: string;
}> {}

export interface DeveloperMessage extends EventEnvelope<'developer/message', {
  added: string[]; removed: string[];
}> {}

// ──────────────────────────────── 工具调用 ────────────────────────────────

export interface ToolCall extends EventEnvelope<'tool/call', {
  turn: number; step: number; callId: string; name: string;
  arguments: string;
  sideEffect: SideEffect;
}> {}

export interface ToolResult extends EventEnvelope<'tool/result', {
  turn: number; step: number; callId: string;
  /** 引用对应 tool/call 事件的 seq，用于校验配对 */
  callSeq: number;
  status: ToolResultStatus;
  /** 结果全文；超过 blob 阈值时这里只存头部预览 */
  content: string;
  /** 大结果外置：全文在 data/blobs/（内容寻址 sha256 命名） */
  contentRef?: { blobId: string; bytes: number };
  durationMs?: number;
  error?: { message: string; code: string };
}> {}

// ──────────────────────────────── 唤醒与定时器 ────────────────────────────────

export interface WakeTimer extends EventEnvelope<'wake/timer', {
  timerId: string; scheduledAt: string; firedAt: string;
  /**
   * 到期时定时器上挂着的那个 payload，原样带过来。
   *
   * 为什么要放进事件：`at` 型定时器一触发就从表里删掉，认领方若只查表就再也拿不到它——
   * 于是"到点提醒我做什么"这类语义静默丢失（`/dream` 的唤醒也因此跑成了普通 turn）。
   * cron 型条目触发后保留，所以这个洞只在一次性定时器上现形。
   */
  payload?: unknown;
}> {}

export interface WakeFile extends EventEnvelope<'wake/file', {
  path: string; kind: 'created' | 'changed' | 'deleted';
  dedupeKey?: string;
}> {}

export interface WakeWebhook extends EventEnvelope<'wake/webhook', {
  path: string; body: string; headers: Record<string, string>;
  dedupeKey?: string;
}> {}

/**
 * **场景鉴权拒绝了一次工具调用**（2026-10-04，internal）。
 *
 * 为什么只落拒绝、不落放行：放行是常态，落下来会把日志淹掉；而"谁在什么时候试图让她
 * 做什么、被谁拦下"正是无人值守最需要的审计线索（与 injection/flagged 同一条理由：
 * 出了事得查得出框架当时做了什么）。
 */
export interface AuthzDenied extends EventEnvelope<'authz/denied', {
  turn: number;
  step: number;
  /** 被拒的工具名 */
  tool: string;
  /** 场合：owner = 自己家（GUI/用户会话/她自己）；guest = 软件里遇到的人 */
  scenario: 'owner' | 'guest';
  /** 拒绝理由（给她看的那句话，逐字与她收到的回执一致） */
  reason: string;
  code: string;
}> {}

export interface WakeManual extends EventEnvelope<'wake/manual', {
  note: string; dedupeKey?: string;
  /**
   * 带人唤醒：本机用户说话时带上 `config.persona.owner`，于是对应关系档案注入。
   * 缺省 = 不带人（子代理任务文本、外部脚本的裸注入）。
   */
  person?: string;
  /**
   * 这条唤醒是谁让它发生的（`'dream'` = 界面的 /dream 动作；`'mcp'` = MCP 声明面被改）。
   * **两个都不是用户打的话**——是框架替他做的动作留下的通报。
   *
   * 为什么要这个字段：GUI 对 wake/manual 的既有口径是「有 note = 用户在输入框里打的字」
   * → 右侧气泡。而 /dream 的 note 是**框架写的指令**（该做梦了……），拿它当用户说的话
   * 就成了截图里那条蓝气泡（用户 2026-10-04：「同样应该包装成框架卡片」）。
   * 有了标记，界面就能按来源分：用户打的字走气泡，框架的动作用框架卡片。
   *
   * **`'mcp'`（2026-10-09 补）与 `'dream'` 是同一类，但有一处判据上的差别**：
   * `/dream` 那条 note 是**对她说的话**（"该做梦了……"，必须进她的上下文），
   * 而 MCP 这条是**框架给她的通报**（"哪个 server 变了"）——两者都进上下文（都不许被
   * `isSlashCommandEvent` 当成指令吃掉），但界面上都该走框架卡片，谁打的字都不是。
   *
   * 加这个值的时候**界面那一侧还没有分支**（`gui/lib/pages/chat_page.dart` 只认 `'dream'`）：
   * 于是 `'mcp'` 的那条在今天的界面上会落进"有 note = 用户的话"那一支，摆成右侧蓝气泡。
   * 这是**已知的界面滞后**（与 /dream 修之前同一个形状），记在这里免得下一轮当成新 bug 查；
   * 后端这一侧的标记先按契约给上（界面加分支时不必回头改写入侧）。
   */
  /**
   * **`'compact'`（2026-10-09 补）是第三种，而且是唯一一种"没有人按下任何按钮"的**：
   * 自动压缩（`compaction/summary` 落库）之后，框架**主动**叫她一次，告诉她"刚才压过上下文、
   * 手上没做完的事接着做"（写入点见 `real-loop.ts` 的 `handleCompactionWake`）。
   *
   * 三个值的共同点（也是它必须被记下来的理由）与 `'mcp'` 完全一样：**这条 note 不是用户
   * 打的话**——界面上该走框架卡片，`noteUserSpoke` 那条路也要绕开它（否则会把框架通报
   * 写成"他刚说「…」"）。
   *
   * 两处判据上的差别，都影响消费方：
   *   • 与 `'dream'` 不同：`'dream'` 的 note 是**对她说的话**（"该做梦了……"），
   *     这条是**通报**（"刚压过，接着做"）——但两者都进上下文，都不许被
   *     `isSlashCommandEvent` 当成指令吃掉（那个函数按 `via !== undefined` 一刀切，见它实现）；
   *   • 与 `'mcp'` 不同：`'mcp'` 只是通报，`'compact'` 还带一句**要她继续干活**的祈使句。
   *     这不是行文风格问题：压缩正好落在"一轮刚收尾、可能还有没做完的事"的时刻，不叫醒她
   *     就等于让那份交接笔记躺到下一次有人说话为止（用户 2026-10-09 的原话：
   *     「压缩后，应该也进行一次唤醒……**如有中断的工作则继续**」）。
   */
  /**
   * **`'restart'`（2026-10-11 补）是第四种，形状与 `'compact'` 最近**：
   * 上一任**异常退出**（内存不足崩掉 / 没来得及写 `session/end`）之后，本进程起来时
   * 框架**主动**叫她一次，告诉她"我刚被重启过、原因是什么、接着做"（写入点见
   * `real-loop.ts` 的 `announceRestart`；判据只写在那一个方法头里）。
   *
   * 与其余三个值的关系：
   *   • 与 `'compact'` 同：**没有人按下任何按钮**，正文里带祈使句（"接着做"）——重启正好
   *     落在"上一任做到一半就没了"的时刻，不叫醒她，那段断档永远没人解释（用户 2026-10-11
   *     的原话：「她说她没认出来进程在反复重启」「进程重启应当跟 compact 事件一样，
   *     有个通知让 agent 知晓」）；
   *   • 与 `'dream'` / `'mcp'` 同：这条 note **不是用户打的话**——界面上该走框架卡片，
   *     `noteUserSpoke` 那条路要绕开它（否则会把框架通报写成"他刚说「…」"）。
   *
   * **它只在异常退出时出现**：正常重启（她自己请求的、或者拉起器干净换人的）**一个字都不发**，
   * 只留 `runtime/restart` 那条 internal 留痕——判据与理由见 `announceRestart` 的方法头。
   */
  /**
   * **`'compact-soon'`（2026-10-15 补）是第五种，形状与 `'compact'` 互为两面**：
   * `'compact'` 是**压缩之后**告诉她"刚压过、接着做"；这一种是**压缩之前**告诉她
   * "可见历史已到压缩线的 80%，先把还会再用的东西收起来"（用户 2026-10-15 的原话：
   * 「框架的压缩预警，**得让 agent 看见**，知道上下文已过 80%，**考虑整理和记录**」）。
   *
   * 与其余四个值的关系：
   *   • 与 `'compact'` 同：**没有人按下任何按钮**，正文是框架通报 + 带祈使句
   *     （"考虑整理与记录" / "继续手头的工作"）；两处判据（`isSlashCommandEvent` 与
   *     `noteUserSpoke` 的绕行）都靠 `via !== undefined` 一刀切，所以这一种自动沿用；
   *   • 与 `'dream'` / `'mcp'` 同：这条 note **不是用户打的话**（界面该走框架卡片）。
   *
   * **它不受 `maintenanceWindowOf` 那道 6 小时闸约束**：那条闸管的是此刻层那一行提示，
   * 而这一种是**独立的一条真唤醒**（判据与迟滞写在 `real-loop.ts` 的
   * `handleCompactionSoonWarning` 方法头里——一句话：**每个压缩周期每档（80% / 95%）只报一次**）。
   */
  /**
   * **`'self-organize'`（2026-10-20 补）是第六种：空拍提醒她「可以进行自我整理」**。
   *
   * 用户 2026-10-22 的原话（逐字）：「**自我整理提示**：连续两次空拍后提示一次，然后，
   * 再过三个空拍再提示一次，**然后就不提示了**。」所以这一种**一段安静期最多两条**：
   * 第 2 拍一条、第 5 拍一条，之后闭嘴（第 3 条永不出现）。判据、文案与"什么算重置"
   * 都在 `model/self-organize-reminder.ts`（纯模块），写入点是 `real-loop.ts` 的
   * `remindSelfOrganizeIfDue`。
   *
   * 与其余五个值的关系：
   *   • 与 `'compact-soon'` 最近：**没有人按下任何按钮**，是框架主动的一条"可以去做某事"的提醒，
   *     同样不受此刻层那道 6 小时闸约束（那道闸管的是那一行提示，不是这条真唤醒）；
   *   • 与 `'dream'` / `'mcp'` / `'restart'` 同：这条 note **不是用户打的话**——界面按
   *     `via` 有值走框架卡片（认不出来的来源兜底叫「框架通报」），`noteUserSpoke` 那条路
   *     与 `isSlashCommandEvent` 都按 `via !== undefined` 一刀切，自动沿用；
   *   • 与 `'compact'` 不同：正文里**没有祈使句**（"可以整理"而不是"接着做"）——用户要的是
   *     提醒，做不做由她自己判断（判据见那个纯模块的文件头）。
   *
   * ⚠ 它**不改** `render.ts` 的 `MAINTENANCE_IDLE_TICKS`（那边仍是 `6` 拍 + 六小时闸，
   * 产出的是此刻层的「[自主时段]」那一行）：两件事服务两条路，本批一个字节都没动那一条。
   */
  via?: 'dream' | 'mcp' | 'compact' | 'compact-soon' | 'restart' | 'self-organize' | 'system';
}> {}

/**
 * 心跳触发（概率模型，2026-10-04 起；模型与标定见 `src/wake/heartbeat.ts` 文件头）。
 *
 * **为什么 `probability` / `roll` 是必填而不是可选**：用户的口径是"越久没触发概率越高"，
 * 事后要能回答"这一拍为什么现在响"。只有 `quietSeconds` 答不了——同一个安静时长在旧模型里
 * 对应一个固定间隔，在新模型里对应一次抽签。留下当时用的概率与抽到的数，
 * 判据就能被复算：`roll < probability` 才响，而 `probability = q^α` 由安静时长唯一确定。
 * 写成必填还顺带把"忘了带审计字段"变成编译期错误（`HeartbeatSink.emitHeartbeat` 收的是本类型）。
 *
 * `idleTicks` / `pressure` 保留但**不再参与节律**：它们是既有诊断（GUI 状态、压力溯源）的输入，
 * 删掉要动投影缓存与界面，与本次改动无关；这里只把语义钉清楚——节律只由安静时长决定。
 */
export interface WakeHeartbeat extends EventEnvelope<'wake/heartbeat', {
  quietSeconds: number; idleTicks: number; pressure: number;
  /** 触发时安静时长对应的命中概率（`q^α`，q=(安静−下限)/(上限−下限)） */
  probability: number;
  /** 这一次抽到的随机数（[0,1)）：`roll < probability` 才触发 */
  roll: number;
}> {}

export interface WakeIntention extends EventEnvelope<'wake/intention', {
  intentionId: string; content: string;
}> {}

/**
 * 唤醒里带的结果正文上限（**字符**，按码点切，不切坏多字节字符）。
 *
 * 为什么正文要随唤醒一起给她、又为什么必须有上限（2026-10-08 用户的口径：
 * 「后台任务回执、timer 提醒，这类得是真唤醒」——判据是"**真的起 turn，且那一条内容出现在
 * 当轮请求体里**"）：
 *   · 只写一句"任务完成"等于让她再花一次工具调用去捞结果，而"捞"这一步她最容易跳过，
 *     然后按"任务完成了"这个印象说话；
 *   · 但输出可以任意大（实测单条工具输出最长 16.5 KB 正文，任务日志只会更长），而唤醒那一行
 *     **从此留在历史里、之后每轮重发**——不设上限就是每轮都在为一份日志付费。
 *
 * 数定在**事件契约**这一层（契约的读者有两处：产生侧 `runtime/job-manager.ts` 按它切，
 * 渲染侧 `model/render.ts` 按它说"这是开头多少字"）——两处各写一个数必然漂移。
 * 取**开头**：与 blob 预览同一条口径（`blob-store` 的 `previewChars` 也取开头）。
 */
export const JOB_WAKE_EXCERPT_CHARS = 2000;

/**
 * 后台任务完成（`runtime/job-manager.ts` 是唯一写入点）。
 *
 * **它必须是一条"真唤醒"**（2026-10-08 用户的口径：「后台任务回执、timer 提醒，这类得是真唤醒」
 * ——判据是**真的起一个 turn，且那一条内容出现在当轮请求体里**）。所以事件不只带一个 jobId：
 * 结果正文的一截随事件走，渲染层照它进本轮新输入（见 render 的 `wake/job`）。
 *
 * 正文为什么放在**事件里**而不是"让她自己去查"：事件的字节就是她看到的东西，
 * 而查那一步要她再花一次工具调用——实测她更容易跳过它、然后凭"任务完成了"这个印象说话。
 * 放事件里还有个好处：**重放**（`replay`）与界面预览读到的是同一份字节。
 */
export interface WakeJob extends EventEnvelope<'wake/job', {
  jobId: string;
  /** 跑的是什么命令（原文）。她起的任务，回来看见才知道这结果是"什么的结果" */
  command?: string;
  /** 退出码；`null` = 没跑完就被结算（重启孤儿、被杀）——不是 0，别读成成功 */
  exitCode?: number | null;
  /** 结果正文的**开头一截**（上限见 `JOB_WAKE_EXCERPT_CHARS`）；没有输出时缺席 */
  outputExcerpt?: string;
  /** 上面那一截是不是被截过（截了要如实说，否则她拿它当全文） */
  outputTruncated?: boolean;
  /** 结果全文多少字节（截没截都带上：她据此决定要不要读全文） */
  outputBytes?: number;
  /** 全文在哪（本机路径）。要全文就用 `safe_read` 读它 */
  outputFile?: string;
}> {}

/** IM 通道消息（QQ/未来微信/Telegram 统一入口）：外部不可信数据，渲染时包边界标注 */
export interface WakeChannel extends EventEnvelope<'wake/channel', {
  /** 通道标识：'qq-official' | 'onebot' | ... */
  channel: string;
  /** 聊天形态：单聊 / 群聊@ / 群消息 / 频道 */
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  /** 发送者标识（QQ 的 member/user openid） */
  person: string;
  /** 平台给的**昵称/群名片**（只用于显示认人；**不是身份**——身份永远按 id 判） */
  nickname?: string;
  /** 会话标识（群 openid 或用户 openid——speak 回投目标） */
  chatId: string;
  text: string;
  /** 平台消息 id 与序号（被动回复 msg_id + msg_seq 语义） */
  messageId: string;
  msgSeq: number;
  /** 平台原始附件描述（图片/文件等，文本已剥离） */
  /** `text`：平台对这条附件的**转写**（目前只有语音的 `asr_refer_text`）；只作可读化，不是她"听到的" */
  attachments?: Array<{ type: string; url?: string; name?: string; text?: string }>;
  /**
   * 这条是不是 @/提到 了她（适配器给得出就填，给不出就不填）。
   *
   * **判据不看它**：唤醒语义绑在 `chatType === 'group-at'` 上，见 `channel/inbox.ts` 那段——
   * 按它分流会让同一个群里出现"被 @ 但不该醒"与"没被 @ 但该醒"两套说法。
   * 它只是留个线索（比如全量群消息模式下，content 里的 @ 前缀已被官方去掉，这是唯一还看得出指向的字段）。
   */
  mentionsMe?: boolean;
  dedupeKey?: string;
}> {}

/**
 * IM 通道的**普通消息**（不进上下文、不唤醒）：她"知晓"外面有人在说话，要不要看由她定。
 *
 * 与 `wake/channel` 的分工是这个仓库里最要紧的一条线：
 *   • `wake/channel` 是「**叫她**」——被 @、或她自己标记为关注/用户的会话；它进消息流、唤醒 turn；
 *   • `channel/message` 是「**手边那个软件在响**」——群里的普通发言、别人发来的私聊。
 *
 * 为什么后者要**显式写成一条事件**而不是干脆不落库：用户定的模型是"QQ 是她手边一个可以点开的
 * 软件，不是推给她的消息流"。既然她"可以选择看"，那"有多少条没看"就必须是一个**可以算出来的
 * 事实**——而日志是唯一真相源，没落库就没得算。落了它，未读计数、`read_channel` 的最近若干条、
 * 以及"不看也一条不丢"这三件事就有了同一个来源；不落它，未读只能是运行时内存里的一笔糊涂账。
 *
 * **可见性固定 internal**：它不进请求、不唤醒（`wake/channel` 保持原样，那才是"叫她"的那条路）。
 * 她想看就用 `read_channel` 现取——取回来的内容按外部不可信数据处理（见 render 的 external_event）。
 *
 * `msgSeq` 与未读的关系：折叠会话簿时 `readUpToSeq` / `unread` 都按这个字段比大小
 * （见 channel/sessions.ts）。平台给不出真序号时调用方填**事件 seq**（照样单调），契约不变。
 */
export interface ChannelMessage extends EventEnvelope<'channel/message', {
  /** 通道标识：'qq-official' | 'onebot' | ... */
  channel: string;
  /** 聊天形态：单聊 / 群聊@ / 群消息 / 频道 */
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  /** 发言者（平台 openid） */
  person: string;
  /** 平台给的**昵称/群名片**（只用于显示认人；**不是身份**——身份永远按 id 判） */
  nickname?: string;
  /** 会话 id（群 openid 或用户 openid） */
  chatId: string;
  text: string;
  messageId: string;
  msgSeq: number;
  attachments?: Array<{ type: string; url?: string; name?: string }>;
  /** 这条是不是 @/提到 了她。群里的 @ 与普通发言要能分开（适配器给得出就填） */
  mentionsMe?: boolean;
}> {}

/**
 * 群里**发生了一件事**（不是"某个人说了句话"）——管理动作、入群退群、撤回、戳一戳……
 *
 * 2026-10-11 用户点的第二件（诊断报告 §3）：`notice` 这一类事件原先在适配器那一层就丢了
 * （`channel/onebot.ts` 的 `dispatch` 对 `post_type !== 'message'` 只记一行日志），
 * 于是**别人做的管理动作在她那儿一个字都不存在**——她读一个群，看不到半小时前有人开过全员禁言。
 *
 * 与 `channel/message` 的关系（三条刻意相同、一条刻意不同）：
 *   • 相同：**internal**、**不唤醒**、**只记账**（她想看就用 `read_channel` 现取）；
 *   • 不同：**不计未读**。未读数的必须是"**别人的话**"（`channel/sessions.ts` 的折叠只认消息）——
 *     把"某人加入了群聊"算进未读，会让她以为有人在跟她说话。
 *
 * 载荷的形状与"怎么渲染成一行"同源：判据只在 `channel/self-identity.ts`（`ChannelNoticeData` /
 * `noticeLineText`），两条通道（OneBot 的 `notice` / 官方未来的事件）都往那一个形状里填，
 * 渲染也就只有一份。
 */
export interface ChannelNotice extends EventEnvelope<'channel/notice', ChannelNoticeData> {}

/**
 * 她自己的管理动作（「**我做过**」）——平台**不对机器人自己发起的动作发 notice**，所以这条
 * 凭据只能从 **MCP 管理类工具的回执**那一层落（`tools/mcp-entry.ts` 的 `onReceipt`）。
 *
 * 与 `speak/sent`（"我说过什么"）同一性质的一条**她自己的凭据**，答的是"我做过什么"：
 * 没有它，"我设过全员禁言"这件事在她那儿一个字都不存在——`read_channel` 只摆别人的话
 * （`channel/message`）与群里的动静（`channel/notice`），她的动作两样都不是。
 *
 * 可见性/唤醒口径与 `channel/notice` **逐字相同**（internal、不唤醒、不计未读、不进
 * `messages` 总数）：她的出路同样是 `read_channel` 现取——那一行长这样：
 * `（我）：[全员禁言 · <群名> · 开启]（回执 ok）`（与"她说过的话"同族，但方括号里是**做的事**）。
 *
 * 载荷的形状与"记哪几件、怎么渲染"的判据都在 `channel/self-action.ts`（唯一一处）。
 */
export interface ChannelSelfAction extends EventEnvelope<'channel/self-action', ChannelSelfActionData> {}

// ──────────────────── 附件的两个字段口径（两条通道共用，只此一处） ────────────────────

/**
 * 附件的**类型**在各通道上的两种形态（`attachments[].type` 的取值）。
 *
 * 为什么两种都认：这个字段是**适配器**填的，而两条通道拿到的原料不是同一种东西——
 *   • QQ 官方附件里带的是 `content_type`，即 **MIME 型别**（`image/png`）；
 *   • OneBot 的附件来自消息段，段类型是**裸标签**（`image` / `file` / `record` / `video`）。
 * 上游（渲染层挑图、附件预热扫图）原先只认 MIME 前缀，于是 OneBot 发来的图
 * **一条都进不了她的上下文**（只留一行 URL 文本）：她看得见文件名，看不见画面。
 *
 * 边界留在适配器：协议语义该由适配器翻（OneBot 侧的段 → 这里认的两种形态之一），
 * 渲染层只问这一个函数"这是不是一张图"，不自己再写一遍字符串判据。
 */
export function isImageAttachment(attachment: { type?: string }): boolean {
  const type = attachment.type ?? '';
  // `image` 是 OneBot 的段类型；`image/*` 是官方（以及任何讲 MIME 的通道）的内容类型。
  return type === 'image' || type.startsWith('image/');
}

/**
 * 附件地址**能不能真的取到东西**（`attachments[].url` 的取值口径）。
 *
 * 为什么要有这一条：`url` 是给两条下游用的——附件预热与渲染（那一行"临时地址，想看就现在下载"）。
 * OneBot 的段里 `file` 常常只是协议端那边的一个**本地文件名**（`a.jpg`），那种值摆进上下文是
 * **点不开的假地址**，她照着它去 http_download 只会白撞一次——所以这类一律不收。
 *
 * 认两种：`http(s)://`（官方与 OneBot 的常规直链）与 `data:`（内联字节，Node 的 fetch 直接吃它）。
 *
 * **2026-10-07 收窄（P0 的连带修正）**：原先还认 `file://`。它有两个毛病：
 *   ① 它是"协议端与本进程同机"的假设，模型侧（服务端）根本取不到那个路径；
 *   ② 那条路上的降级链在夜里断过一次——本进程按同机路径读得动，服务端读不动，于是载荷
 *      形态出错、整拍 400。
 * 所以 `file://` 从此不进 `url`：附件那行事实里就不该出现一个**只有本进程能用**的地址。
 * 协议端真的只给了本地路径时，让她用 `vision_read`（本机读得动）转述，那条路是通的。
 */
export function isFetchableAttachmentUrl(url: string): boolean {
  return /^(https?:|data:)/iu.test(url.trim());
}

// ──────────────────── 「什么形态的图才进上下文」——唯一一处判据（2026-10-07） ────────────────────

/**
 * 模型**真的认**的图片媒体型别。这份名单不是我们挑的，是服务端的原话：
 * 一次 400 的响应体写着 "Please make sure your image is valid and has one of the following
 * formats: **webp, png, jpeg, and gif**"（现场：turn 885~898 每一拍都是这一条）。
 *
 * 为什么必须是一份**白名单**而不是"`image/` 开头就算"：`attachments[].type` 是适配器填的，
 * 而 OneBot 那边填的是**段类型裸标签** `image`（见上面 `isImageAttachment` 的注释）。
 * 裸标签当 MIME 用会拼出 `data:image;base64,…`——媒体型别没有子型别，模型侧判"unsupported image"
 * 直接 400，而这条消息永远留在历史里 ⇒ **之后每一拍都失败**（历史是只追加的，她自己修不好）。
 * `image/bmp` / `image/tiff` 之类同理会 400：名单外的**一律不进上下文**，改走"给地址 + vision_read"。
 */
export const CONTEXT_IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** 媒体型别的规范写法（小写、去参数、去空白）；不在白名单里给 null。参数如 `image/jpeg; charset=x` 只取前半 */
export function contextImageMediaType(mime: string | undefined | null): string | null {
  if (typeof mime !== 'string') return null;
  const bare = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return CONTEXT_IMAGE_MEDIA_TYPES.includes(bare) ? bare : null;
}

/**
 * 按**字节头**认图片型别（magic number），认不出给 null。
 *
 * 为什么非要有这一条：声明的那一栏不可信，而进请求体的字节是真的。现场那条（seq 45004）声明是
 * 裸标签 `image`、文件名 `.webp`、字节头却是 `RIFF….WEBP`——只信声明就永远拼不出模型认的型别，
 * 只信文件名则等于把"猜"写进协议。字节头是这三者里唯一**既真实又确定**的一栏。
 *
 * 只认白名单里那四种的签名：这个函数的用途就是"这一份到底进不进上下文"，
 * 认出来的型别必须能直接写进 data URL。
 */
export function sniffImageMediaType(bytes: Uint8Array | undefined | null): string | null {
  if (bytes === undefined || bytes === null || bytes.length < 12) return null;
  const ascii = (at: number, length: number): string => {
    let out = '';
    for (let i = at; i < at + length; i += 1) out += String.fromCharCode(bytes[i] ?? 0);
    return out;
  };
  // PNG：89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // JPEG：FF D8 FF（后面是 JFIF / Exif / 原始量化表都有可能，不必再看）
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF：GIF87a / GIF89a
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  // WebP：RIFF….WEBP（第 4~7 字节是长度，不判）
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 进上下文的图片**最终形态**：媒体型别 + 完整 data URL。
 *
 * 两者的关系是硬的：`dataUrl` 的前缀必须**逐字**等于 `data:${mediaType};base64,`——
 * 拼错一个字符就是 400（现场那条病），所以拼装只此一处、判据也是同一个函数给的。
 */
export interface ContextImageChosen {
  /** 进 data URL 的那一栏（白名单之一，来自声明或字节头） */
  mediaType: string;
  dataUrl: string;
}

/**
 * 把一份图片字节拼成能进请求体的 data URL。**拼不出来（型别不在白名单）就给 null。**
 *
 * 优先信字节头（真的那栏），字节头认不出才退回声明（假不了太多的那栏）——顺序反过来的话，
 * 声明是裸标签 `image` 的 OneBot 图片就永远进不去，而它恰恰是这个函数存在的理由。
 * 两边都说不出一个白名单型别时**如实返回 null**：调用方把"没进"的理由写进留痕，
 * 由"给地址 + vision_read"那条路兜底，绝不硬塞一个模型不认的载荷。
 */
export function buildContextImage(
  bytes: Uint8Array,
  declaredMime: string | undefined | null,
): ContextImageChosen | null {
  const mediaType = sniffImageMediaType(bytes) ?? contextImageMediaType(declaredMime);
  if (mediaType === null) return null;
  return { mediaType, dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}` };
}

/** 「这张图为什么没进上下文」——给留痕用的理由码（不是给模型的文案） */
export type ContextImageSkipReason =
  /** 声明与字节都不是白名单里的型别（例如声明 `image`、字节也不是 png/jpeg/gif/webp） */
  | 'unknown-media-type'
  /** 字节在本地取不到（还没下载下来 / 直链已过期） */
  | 'no-local-bytes'
  /** 超过进上下文的字节上限 */
  | 'too-large'
  /** 地址形态不是 http(s)（`file://` 协议端本地路径、`base64://` 未解析的段）——模型取不到 */
  | 'not-http-url'
  /** `data:` 那段内联字节解不出来（不是合法 base64，或声明的型别不在白名单里） */
  | 'data-url-unreadable';

/**
 * 拆一个 `data:` URL（`data:<media-type>;base64,<payload>`）。
 *
 * 为什么要拆：Node 的 `fetch` 能吃 data URL，但"能吃"不等于"能进上下文"——里面的型别是不是
 * 白名单、payload 是不是合法 base64，只有拆开才知道。Model 不认的形态照样 400。
 * 声明的型别不在白名单里就直接判不可用（与 `contextImageMediaType` 同一份名单）。
 * **只认 base64 编码**（这种形态只有它：OneBot 的内联字节就是 `base64://` 翻过来的）。
 */
export function parseImageDataUrl(url: string): { mediaType: string; bytes: Buffer } | null {
  const raw = url.trim();
  if (!/^data:/iu.test(raw)) return null;
  const comma = raw.indexOf(',');
  if (comma === -1) return null;
  const header = raw.slice('data:'.length, comma);
  const payload = raw.slice(comma + 1);
  if (!/;base64$/iu.test(header)) return null;
  const mediaType = contextImageMediaType(header.slice(0, header.length - ';base64'.length));
  if (mediaType === null) return null;
  try {
    const bytes = Buffer.from(payload, 'base64');
    return bytes.byteLength === 0 ? null : { mediaType, bytes };
  } catch {
    return null;
  }
}

/** 地址形态是不是"模型自己能去取"的那一种（http(s) 直链） */
export function isModelFetchableImageUrl(url: string): boolean {
  return /^https?:\/\//iu.test(url.trim());
}

/**
 * 这一刻手上有的信息，**够不够判"这张图许进上下文"**——渲染层挑图用的那一条。
 *
 * 为什么分成两个函数而不是一个带分支的：两个调用点的信息量本来就不一样——
 *   • `remote`（通道发来的附件）：地址与声明都在手上，两条都要过（`contextImageAdmission`）；
 *   • `file`（她自己要求看的那张，`image/attached`）：地址是工作目录内的相对路径，
 *     它本来就不是 http(s)，**地址那一条对它不成立也不该成立**；能判的只有声明。
 * 硬塞进一个函数就得给它编一个假 URL 才跑得通，那是把"判据"写成"跑得通"。
 */
export function contextImageMimeAllowed(mime: string | undefined | null): boolean {
  return contextImageMediaType(mime) !== null;
}

/**
 * 声明这一栏**是不是"这是一张图，型别由字节说了算"**。
 *
 * `image` 是 OneBot 的**段类型裸标签**：它不是格式声明，只是"这一段是图片"。
 * 拿它当 MIME 拼 data URL 正是 2026-10-07 那个 400（`data:image;base64,…`）；
 * 而把它**整条拒掉**又会让 OneBot 的图一张都进不来（P0-2 要修的正是这个）。
 * 两条路的分界因此不在这一栏，而在**字节**：这一栏只负责"值不值得去取字节"，
 * 取回来之后由 `buildContextImage` 按字节头认型别——认不出就不进上下文。
 */
export function isImageSegmentLabel(mime: string | undefined | null): boolean {
  return (mime ?? '').trim().toLowerCase() === 'image';
}

/**
 * **这一张图许不许进上下文**——纯函数、确定性，渲染层挑图与预热层共用同一个结论。
 *
 * 为什么要有这条（2026-10-07 的 P0）：P0-2 把 OneBot 的裸标签 `image` 放进了多模态那条路，
 * 而载荷形态没跟上——拼出来的是 `data:image;base64,…`，模型 400，那条消息从此把**每一拍**都毒死。
 * 判据只写在"能不能进上下文"这一侧是不够的，必须同时是**渲染层挑图时用的那条**：
 * 挑进来又注不进去，会让"最近 N 张"的名额被一张永远注不进去的图占着，后面的好图反而被挤掉。
 *
 * 判据（全部可核对）：
 *   ① 地址必须是 **http(s)**（模型自己取得动），或者是拆得开的 `data:`（内联字节）。
 *      `file://` 是协议端与本进程同机的路径、`base64://` 是没解析的段——两者模型侧都取不到，
 *      它们是"给地址 + vision_read"那条路的材料，不是这一条路的；
 *   ② 声明的型别要么在白名单里（`image/png`…），要么是裸标签 `image`（"这是张图，格式看字节"）。
 *      `image/bmp` 这种**明确的**非白名单声明直接不进——我们没有转换器，硬塞必然 400；
 *   ③ 字节到手时**字节头说了算**（`hasBytes=true`）：认得出白名单型别才进。
 *
 * `hasBytes=false` 表示"此刻还没把字节取到手上"（渲染层在轮首就挑了图，而预热是异步的）：
 * 那时只看①②两条形态判据。真正拼 data URL 的是 {@link buildContextImage}——
 * 它拿不到白名单型别就返回 null，于是**绝不会**有非法载荷进请求体。
 */
export interface ContextImageAdmission {
  /** true = 这一张可以进（前提是宿主真取到了字节、且字节头认得出白名单型别） */
  admitted: boolean;
  /** admitted=false 时的理由（给留痕，给测试断言） */
  reason?: ContextImageSkipReason;
}

export function contextImageAdmission(input: {
  url: string;
  /** 附件声明的内容类型（`attachments[].type`）或 `image/attached` 的 `mime` */
  mime?: string | undefined;
  /** 本地字节取到了没有（渲染层不知道，传 false） */
  hasBytes?: boolean;
  /** 本地字节的型别（取到了才有；与声明冲突时以它为准） */
  byteMediaType?: string | null;
}): ContextImageAdmission {
  const url = input.url.trim();
  // 内联字节（协议端把段里的 `base64://` 翻成 data URL 时）：形态与 http(s) 完全不同，
  // 走它自己那条判据——拆得开、型别在白名单里，才算数（拆不开就不进，理由如实写）
  if (/^data:/iu.test(url)) {
    return parseImageDataUrl(url) === null
      ? { admitted: false, reason: 'data-url-unreadable' }
      : { admitted: true };
  }
  if (!isModelFetchableImageUrl(url)) return { admitted: false, reason: 'not-http-url' };
  // 字节到手时以字节头为准（声明只作兜底）；没到手时只有声明可看。两档合一：
  // 「字节头认得出」或「声明够格」——都不成立才是不进。
  const byteType = input.hasBytes === true ? (input.byteMediaType ?? null) : null;
  const declaredOk = contextImageMimeAllowed(input.mime) || isImageSegmentLabel(input.mime);
  if (byteType !== null || declaredOk) return { admitted: true };
  return { admitted: false, reason: 'unknown-media-type' };
}

/** 理由码 → 一句人话（留痕与测试断言共用；不是给模型的文案） */
export function contextImageSkipText(reason: ContextImageSkipReason): string {
  switch (reason) {
    case 'unknown-media-type':
      return '型别不在模型认的白名单里（webp/png/jpeg/gif）——声明不是 MIME（OneBot 的段类型是裸标签 `image`）'
        + '，字节头也认不出这四种之一';
    case 'no-local-bytes':
      return '本地没有这份字节（还没下载下来，或者那条临时直链已经过期）';
    case 'too-large':
      return '超过进上下文的字节上限（压过一道还是太大）';
    case 'not-http-url':
      return '地址不是 http(s)（`file://` 那种协议端本地路径模型侧取不到）——改用 vision_read 转述';
    case 'data-url-unreadable':
      return '`base64://` / `data:` 那段内联字节解不出来（不是合法的 base64，或声明的型别不在白名单里）'
        + '——改用 vision_read 转述';
  }
}

/**
 * 已读到某个会话的哪一条（她自己调 `read_channel` 时写下的话）。
 *
 * 它是一条**独立事件**而不是给 `channel/message` 打标记：标记要改写已落库的事件（日志只追加，
 * 永远不改写），而"我读到哪了"本来就是随她动作变化的一件事，落在它自己的时刻上才对得上。
 */
export interface ChannelRead extends EventEnvelope<'channel/read', {
  sid: string;
  upToSeq: number;
}> {}

/**
 * 框架对某条外部消息给出的**注入预警**（internal）。
 *
 * 为什么预警要落成事件而不是渲染时现算：渲染层是纯函数（缓存铁律 1），它只能读事件；
 * 而且"当时提示过她什么"必须可复盘——她要是真被人绕进去了，得查得出框架有没有提醒过。
 *
 * **没迹象就不写这条事件**：她不需要知道"这条消息被判过、没问题"，那只是噪音。
 */
export interface InjectionFlagged extends EventEnvelope<'injection/flagged', {
  /** 被判定的是哪条外部消息（与 `channel/message.messageId` 同源，按它把预警贴回那一条） */
  messageId: string;
  sid: string;
  /** 判定来自哪一级：规则短路，还是问了模型 */
  by: 'rule' | 'model';
  /** 一句话理由（给她当材料，不是命令） */
  reason: string;
  /** 原文里最可疑的片段（规则给的是精确片段，模型给的是它自己引的） */
  quotes: string[];
  /** 这条消息是谁发的（预警里要说清"是谁在这么干"，她认人用） */
  person: string;
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
}> {}

/**
 * 框架把一句注入预警**摆到了她眼前**——"示警已发生"的凭据（internal）。
 *
 * 与 `injection/flagged` 是两件事，刻意分开：
 *   • `injection/flagged` 是**判定结论**（谁判的、凭什么、命中了什么）；
 *   • 这条是**示警事实**（框架对她说的那句原话、说的是哪条消息、什么时候说的）。
 *
 * 为什么非要有第二条：预警还有一条"没有判定结论"的路——规则层字面命中、判定超时没跑成、
 * 一批里超出判定上限的那些。那条路今天只在渲染时现拼一句话，"她到底看没看见"就查不出来；
 * 而且那句话是渲染层的文案，GUI 侧（Dart）算不出同一串字节，要**原样**贴出它就只能落成事件。
 */
export interface InjectionNoted extends EventEnvelope<'injection/noted', {
  /** 说的是哪条外部消息（与 `wake/channel` / `channel/message` 的 messageId 同源） */
  messageId: string;
  sid: string;
  /** 说话的人（`person`）与会话类型：预警里必须说清"是谁在这么干" */
  person: string;
  chatType: 'c2c' | 'group-at' | 'group' | 'guild' | 'dm';
  /**
   * 会话显示名（宿主当时解析出来的名字；解析不出就写 sid 那串 id）。
   *
   * 为什么把名字落进事件而不是渲染时再解析：此刻层那段"最近 24 小时谁试探过"要按人列，
   * 而渲染层是纯函数（不查联系人表、不读别名表）。名字是当时的事实，落下来才对得上。
   */
  who: string;
  /** 框架对她说的那句话——**逐字**（GUI 卡片与此刻层历史都引用它，一个字都不改写） */
  note: string;
  /**
   * 判定结论与引文——**给人的那一半**（2026-10-02 用户要求）。
   *
   * 为什么与 `note` 分开：`note` 是**对她说的**，末尾那句"那是别人说的话…怎么看你、要不要理、
   * 要不要点破，都由你"是给她的授权，人不需要看；人要看的是"凭什么叫它有迹象"。
   * 拆开之后，界面上那张卡照运行情况页的样子渲染（结论 + 引文），她那边一个字不改。
   *
   * 规则命中的那一路没有判定结论：`reason` 用规则自己那句"在做什么"，`quotes` 是命中片段。
   */
  reason: string;
  quotes: string[];
  /** 判定来源（有判定时）：规则短路还是问了模型。没有判定结论时不出现 */
  by?: 'rule' | 'model';
}> {}

/**
 * 一个会话"正在聊什么"——信箱模型的中间那层。
 *
 * 三层是配套的：**未读条数**（那里有多少条）、**话题**（在聊什么，就是这条）、
 * **@ 附近的消息**（找我做什么）。只给条数她还得翻才知道值不值得看；有了话题，
 * 她扫一眼会话清单就能决定要不要翻——这才是"可以选择看不看"能落地的样子。
 *
 * 话题由 light 概括后**落成事件**而不是即算即用：渲染层是纯函数（只能读事件），
 * 而且落盘之后"她当时看到的话题是什么"可复盘——万一某个概括失真把她带偏了，查得出来。
 * `fromSeq`/`toSeq` 就是为这件事留的：概括覆盖了哪一段，过没过时一目了然。
 */
export interface ChannelTopic extends EventEnvelope<'channel/topic', {
  sid: string;
  /** 一句话话题 */
  topic: string;
  fromSeq: number;
  toSeq: number;
  count: number;
}> {}

/**
 * 把一张图片放进上下文（她自己要求"我要亲眼看"）。
 *
 * 与 `wake/channel` 的附件是两条来源、同一个出口：渲染层看到这两个事件都会注入
 * `input_image`（见 render.ts 的 imagesOf）。区别在触发者——前者是外部发来的，
 * 后者是她调 `vision_read` 时选了直通模式，明确表示"这张别转述，我要原图"。
 *
 * `key` 是宿主能解析的稳定标识（本地图片路径）。渲染层只负责把它交给注入的 loader，
 * 自己不读字节——render 是纯函数。
 */
export interface ImageAttached extends EventEnvelope<'image/attached', {
  /** 宿主可解析的图片标识（当前就是工作目录内的路径） */
  key: string;
  /** MIME：`image/png` / `image/jpeg` …，用于拼 data URL */
  mime: string;
  /** 原始文件名（只为可读，不参与取字节） */
  name?: string;
  /** 她自己写的一句注解（为什么把这张放进来看） */
  note?: string;
}> {}

/**
 * **一条图片通道的留痕**（internal，2026-10-21）：这张图这次为什么没进上下文 / 预取为什么没成。
 *
 * 为什么必须落成事件：这条链上原本**全是静默**的——预热下载失败只写一行 stdout（重启就没），
 * 压缩失败连 stdout 都没有（`attachment-store` 的压缩器返回 false，没人看），
 * 而渲染层 `loadImage` 拿不到字节时**按设计跳过**（那是正确的降级：不能为了少一张图让请求 400）。
 * 于是一张图从没进过上下文这件事在日志上完全查不出来，实测只能靠"她自己去 http_download"反推。
 *
 * 这不只是排障：留痕是**降级的事实**，而"她看不见的图"与"她看见了却没说"在事后长得一模一样。
 *
 * **internal 是刻意的**（写进 `EVENT_VISIBILITY`）：它是账，不是给她的输入。真正进上下文的
 * 仍是 `input_image` 那一份字节；这条事件一个字节都不进请求体 ⇒ 不动 `RENDER_VERSION`。
 *
 * 与 `image/attached`（她要求看的那张，model 可见）是**两条相反的线**：
 * 那条说"这张要进"，这条说"这张没进 / 没压成"。
 */
export interface ImageTrace extends EventEnvelope<'image/trace', {
  /**
   * 哪一类：
   *   · `skipped`        —— 这张图这次没进上下文（带 {@link reason}）；
   *   · `compress-failed`—— 走了压缩分支但没成（原件还在，进不进由字节数决定）；
   *   · `prewarm-timeout`—— step 边界那次预取超过预算（这一拍照旧发，不阻塞）；
   *   · `prewarm-failed` —— step 边界那次预取直接抛错（同一处置：降级 + 留痕）。
   */
  kind: 'skipped' | 'compress-failed' | 'prewarm-timeout' | 'prewarm-failed';
  /** 撞上的是哪一段：预取（下载/落盘）、渲染取字节（最后一米）、压缩 */
  stage: 'prewarm' | 'render' | 'compress';
  /** **那一行人话**（`skipped` 用的是 `contextImageSkipText(reason)` 的原文，一个字不改写） */
  line: string;
  /**
   * 说的是哪张图：附件那条道是临时直链（原样留着，事后能核对是哪一条消息），
   * `source==='file'` 那条道是工作目录内的路径，压缩那一段是被压的那个本地文件。
   * `prewarm-timeout` / `prewarm-failed` 不针对某一张 ⇒ 空串。
   */
  ref: string;
  /** `kind==='skipped'` 时的理由码（与 `contextImageSkipText` 的入参同源） */
  reason?: ContextImageSkipReason;
  /** 这一次花了多久（`prewarm-*` 两条才有） */
  ms?: number;
}> {}

/**
 * **中段改写的留痕**（v76，P4；internal，纯观测）。
 *
 * 判据在渲染层（`model/render.ts` 的 `historyAppendCheckOf`）：**同一 turn 内相邻两步**，
 * 历史段必须只是追加——条数不减 + 前 `HISTORY_HEAD_ITEMS` 条逐字节不变（`headHash` 相同）。
 * 破了就写这一条，请求**照发**（不抛：图片窗口滑出、`MISSING_TOOL_OUTPUT` 补回、压缩移遮蔽点
 * 这些形状都在设计内，拦了就是误伤）。
 *
 * 为什么必须有它（审计 ②-① 的病历）：2026-10-20 18:55–19:34 那段 8.0% 命中率 / 每笔 ≈235K miss，
 * `history.headHash` **逐笔都在变**，而当时没有任何东西会当场报红——只能靠人事后翻日志对账。
 * 这条事件把"以后再犯"变成**当场可见**：`cli tail` 里紧挨着 `budget/consumed` 那几笔出现，
 * 一眼就能把那个小时的账归因到"某一步改写历史第 N 条"。
 *
 * **internal 是刻意的**（写进 `EVENT_VISIBILITY`）：它是账，不是给她的输入 ⇒ 一个字节都不进
 * 请求体，不改 `RENDER_VERSION`（与 `image/trace` / `tools/inventory-changed` 同一条纪律）。
 */
export interface RenderHistoryRewrite extends EventEnvelope<'render/history-rewrite', {
  turn: number;
  step: number;
  /** 上一步的历史段哈希（前 N 条 item 的 JSON） */
  prevHeadHash: string;
  /** 这一步的历史段哈希 */
  headHash: string;
  /** 上一步历史段的条数 */
  prevItems: number;
  /** 这一步历史段的条数（比 `prevItems` 少 = 条数也在减） */
  items: number;
  /** 第几条 `headItems` 变了（**1 基**，与归因里的 `#1` 同口径）；判不出来是 null */
  firstDiff: number | null;
  /** 人读的一句话（如「历史条数不变（1098 条）但前段被改写，断点在第 3 条」） */
  detail: string;
}> {}

export interface TimerSet extends EventEnvelope<'timer/set', {
  timerId: string;
  at?: string;
  /** 周期语义：与 at 互斥；触发后自动结算下一次 */
  cron?: string;
  payload: unknown;
}> {}

export interface TimerFired extends EventEnvelope<'timer/fired', { timerId: string }> {}
export interface TimerCancelled extends EventEnvelope<'timer/cancelled', { timerId: string }> {}

// ──────────────────────────────── 预算 ────────────────────────────────

export interface BudgetConsumed extends EventEnvelope<'budget/consumed', {
  turn: number; step: number;
  lane: ModelLane; model: string;
  inputTokens: number; outputTokens: number;
  cacheHitTokens: number; cacheMissTokens: number;
  /**
   * **这一拍的 cache 数是不是供方报的**（2026-10-26 加，纯观测·可选）。
   *
   * 判据只有一条，写在 `runtime/agent-loop.ts` 的 `accountStep` 里：`cacheHitTokens > 0`。
   * 为什么是它而不是"有没有 usage"：写入侧 `cacheMissTokens = inputTokens − cacheHitTokens`
   * 是**我们自己减出来的**，所以"供方没给缓存字段"与"供方给了、命中是 0"在事件上**长得一样**
   * （都是 hit=0 / miss=input）。只有 hit>0 才证明供方确实报了缓存命中。
   *
   * ⇒ 读的一侧别把它读成"这条端点支持前缀缓存"：它只说**这一拍**的 0 是不是供方报的。
   * 窗口级的口径（是否需要我们自算）在 `runtime/cache-alert.ts` 的 `cacheCaliberOf`，
   * 那里的判据比这一格宽（还认"每拍命中量恒为一个与上下文规模无关的常数"，现场见
   * `model/context-audit.ts` 的 `estimatePrefixHitOf`）。
   *
   * **可选**：本字段之前写下的 `budget/consumed` 里没有它（只增不改，见 docs/operations.md
   * §3 规则 2）；`failStep` 那条路（调用抛错、一个字都没回来）也**不写**——没有回包就没有
   * "供方报了什么"这件事。
   */
  cacheReported?: boolean;
  /**
   * **这一拍的命中量是我们自算的**（2026-10-26 加，纯观测·可选）：供方没报命中（`hit === 0`）、
   * 有真实输入、且**本 runner 上一拍是同模型** ⇒ 这一拍的命中量可由
   * `model/context-audit.ts` 的 `estimatePrefixHitOf` 从两份 `context` 快照算出来。
   *
   * ⚠ **它只是一个留痕**：`cacheHitTokens` / `cacheMissTokens` **一个字节都不改**（有就用供方）。
   * 估算值本身没有落进这一格——它是两份 `context` 的纯函数，读的一侧（告警）用同一个函数、
   * 同两份快照，算出来的是同一个数（`grep '"cacheEstimated":true'` 就是"哪些拍的命中量
   * 供方没给、而我们可以自算"的清单）。
   *
   * 两处口径差别（刻意写清，免得读的人以为两处矛盾）：
   *   · **事件这一格是"这一拍"**（本 runner 上一拍是不是同模型；跨重启/跨写入点时可能没有基线）；
   *   · **告警那一格是"这个窗口"**（从日志里找同模型上一拍，见 `cache-alert.ts`）。
   * 判据只认日志那一份——事件上的两格是留痕，不是判据。
   */
  cacheEstimated?: boolean;
  /**
   * 这次调用的**思维链 token**（`usage.output_tokens_details.reasoning_tokens`，
   * 即 `DsUsage.reasoningTokens`，解析在 `model/ds-client.ts` 的 `readUsage`）。
   *
   * 它**已经含在 `outputTokens` 里**（官方口径：reasoning 是输出的一部分），所以这个字段
   * **不参与任何预算算式**（`state/fold.ts` 的 `budgetTokensOf` 一个字节都没改）——它是纯粹的
   * **观测数**：回答"这条 lane 的思考到底花了多少、开了思考之后涨了多少"。
   * 挂在这里而不是新开一种事件，与 `context` / `cacheBreak` 同一条理由（硬约束第 4 条）：
   * `budget/consumed` 本来就是**一次模型调用一条**。
   *
   * **写入侧：每次都写**。没有思考（没开思考，或服务端这次没产思维链）就是 `0`——
   * 不留 `undefined`、不省字段，这样按 lane / 按天聚合"思考花了多少"不必判空。
   * 全部写入点：`runtime/agent-loop.ts` 的 `accountStep`（成功）/ `failStep`（失败）、
   * `channel/injection-judge.ts`、`channel/topic.ts`、`persona/assets.ts`（资产挑选）、
   * `persona/memory-maintain.ts`（记忆整理与维护）——两档 lane 的每一条都带。
   *
   * **为什么类型上是可选的（`?`）**：它 2026-10-06 才加，**这段日期之前的老日志里没有这个字段**
   * （只增不改是事件格式的规矩，见 docs/operations.md §3 规则 2；同一事件上的 `context` /
   * `cacheBreak` 是同一体例）。所以**读的一侧对历史事件仍要 `?? 0`**；写入侧由
   * `test/thinking-effort-invariant.test.ts` 钉住"每次都是一个数字"。
   */
  reasoningTokens?: number;
  /**
   * 输出 token 的**构成拆分·第一格**（2026-10-16 加，纯观测）：这一拍**她的话（正文）**
   * 占的输出 token。第二格是 {@link outputToolArgTokens}。
   *
   * ────────── 三者关系（**别把它当恒等式读**）──────────
   *   `outputTokens ≈ outputTextTokens + outputToolArgTokens + reasoningTokens`
   *
   * 三格在口径上**互斥且穷尽**：这一拍的输出只有三种去向——`message` 正文（`DsStreamResult.text`）、
   * `function_call` 的入参 JSON（`result.toolCalls[].arguments`）、思维链（`reasoning`）。
   * 但它**不是恒等式**，两个原因都得写清：
   *   · 前两格是**估的**（`tools/registry.ts` 的 `estimateTokens`：中文约 1.5 字/token、
   *     英文约 4 字符/token），只有 `reasoningTokens` 是**服务端真值**；
   *   · 服务端按它自己的分词器计费，item 的框架字段（`function_call.name` 一类包装）也计在输出里，
   *     而这些不在这三格里。
   *
   * 【实测】（2026-10-16 量 `data/events` 最新 6 个日志里 **1152** 个 `outputTokens>0` 的 heavy 拍，
   * 口径就是本字段：`estimateTokens(text) + Σ estimateTokens(tool/call.arguments) + reasoningTokens`）：
   *   · `(三格之和)/outputTokens` 中位 **0.868**（p10 0.595 / p90 0.973）；
   *   · 残差 `outputTokens − 三格之和` 中位 **+62**、p90 ≤ **+100**；
   *   · 1152 拍里只有 **3** 拍三格之和**略微超过** `outputTokens`（各超 1 token）
   *     ⇒ 估计是**系统性偏低**，不是偏高。
   * 用法结论：拿这三格读「**谁占多少**」（比例、量级、趋势），**不要**拿三格之和去反推
   * `outputTokens`——真值只有 `outputTokens` 自己。
   *
   * ────────── 口径与误差来源（写入侧只有一处：`runtime/agent-loop.ts` 的 `accountStep`）──────────
   * 量的是**模型这一拍吐出来的**：`estimateTokens(result.text)`；中断掉的那一拍量的是**已收到的部分**
   * （它照样计费）。⇒ 中断拍的 `outputToolArgTokens` 可能**大于**日志里 `tool/call` 的入参之和
   * （`agent-loop.ts` 刻意丢弃被截断的 arguments，`message/assistant.toolCalls` 在中断拍是空的）：
   * 那是「**计费的输出**」与「**执行了的调用**」之间的**口径差异**，不是写错了。
   * 误差来源三处，按大小排：① `estimateTokens` 本身是启发式（对中文低估最多；同一把尺的已知偏差
   * 记在 `state/blob-store.ts` 的注释里）；② 服务端分词器与它不同源；③ 上面那条 item 包装字段。
   *
   * **可选**：本字段之前写下的 `budget/consumed` 里没有它（只增不改，见 docs/operations.md §3 规则 2）。
   * 读的一侧按"缺省 = 未知"处理（要当 0 用就显式 `?? 0`），**别把缺字段本身写进任何判据**。
   * 失败的调用（同文件的 `failStep`）照写 `0`：调用抛错 ⇒ 一个字都没回来。
   */
  outputTextTokens?: number;
  /**
   * 输出 token 的**构成拆分·第二格**（2026-10-16 加，纯观测）：这一拍**工具入参 JSON**
   * （`DsStreamResult.toolCalls[].arguments` 的全文，逐个累加）占的输出 token。
   *
   * **三者关系、口径、误差来源与实测逐字见上一条 {@link outputTextTokens}**——两格同一把尺
   * （`estimateTokens`）、同一处写入（`runtime/agent-loop.ts` 的 `accountStep`），
   * 在这里再抄一遍必然漂移。与它**一样是可选**：老日志没有它，`failStep` 照写 `0`。
   */
  outputToolArgTokens?: number;
  /**
   * 这一拍落在**计价的哪一档**（2026-10-16 加，纯观测）：`'peak'` = 高峰全价，`'off'` = 空闲半价。
   *
   * 判据 = **事件时间戳（`ts`）换算到北京时间的墙上钟**（`runtime/agent-loop.ts` 的 `priceTierOf`：
   * 显式 +8 小时后再读 UTC 字段，**不读宿主时区**——`getHours()` 读的是本机时区，
   * 换台机器或换个 TZ 环境变量就会得出另一个结论）：
   *   · `'peak'`：**周一至周五 09:00–12:00 与 14:00–18:00**（左闭右开：09:00:00.000 起、
   *     12:00:00.000 止；14:00:00.000 起、18:00:00.000 止）；
   *   · `'off'`：**其余全部**——12:00–14:00 午间、18:00–次日 09:00、周六与周日整天。
   *
   * ⚠ **没有节假日日历 ⇒ 法定节假日会被误判成 `'peak'`**（调休上班的周六同理会被判成 `'off'`）：
   * 本格**只按「周一至周五 + 时段」判定**，不含任何法定节假日表。**别假装它精确**——
   * 节假日那几天的账要人工剔，或者先把日历接进来才谈得上准。这条既是"把活挪到空闲时段（半价）"
   * 能不能验收的前提，也是它**现在已知的缺口**。
   *
   * **可选**：老日志没有它；时间戳解析不出来时**这一格不写**（判不出就不猜），
   * 读的一侧请按"未知"处理，**不要默认成 `'off'`**（那等于把"不知道"读成"半价"）。
   */
  tier?: 'peak' | 'off';
  /**
   * 这一拍**实际用的协议**（协议回退之后可能与配置里的首选不同）。**可选**：
   * 缺省 = **不知道**（老日志、测试替身、没走传输层的调用点都没有它）——
   * 读的一侧不许默认成 'responses'，那会把"没写"读成"用过 Responses"。
   *
   * 口径：**六处写入点都从 `DsResponse` / `DsStreamResult` 的 `protocol` 原样带过来**
   * （`agent-loop.ts` 的 `accountStep` / `failStep`、`channel/injection-judge.ts`、
   * `channel/topic.ts`、`persona/memory-maintain.ts`、`main.ts` 的 vision 账），
   * 拿不到就**不写这一格**（不是 `null`、不是空串），本模块不自己推断。
   * `failStep` 那条路没有结果对象 ⇒ 唯一来源是 `DsClient.lastProtocol`（最近一次真发出去的协议）。
   * 它**不折投影、不进请求体** ⇒ 不动 `RENDER_VERSION`（判据见 `docs/schema.md`）。
   */
  protocol?: 'responses' | 'chat-completions';
  /**
   * **对端这一发没有给 usage**（连一个字段都没给）：上面那四格 token 是补出来的 0，**不是真值**。
   *
   * 为什么需要这一格（设计 §6.2 / §9.3#20 的落点）：断流/超时/硬顶掐掉的那一拍、以及换到
   * Chat 之后不给 usage 的兼容层，账上都会记 0——过去从日志里**只能看出"这一拍是 0"，
   * 看不出"这 0 是不知道"**，"预算少算"这个问题因此永远答不了。有了它，
   * `grep '"usageMissing":true'` 就是"少算的那几拍"的清单。
   *
   * **只在真缺时写 `true`**（不是 `false`）：给了 usage 的事件与引入这一格之前**逐字节相同**
   * （只增不改，见 docs/operations.md §3 规则 2）。读的一侧必须写 `usageMissing === true`。
   * 口径：来源是 `DsStreamResult.usageMissing` / `DsResponse.usageMissing`（传输层在
   * "一个 usage 字段都没收到"时置位），六处写入点照抄；`failStep` 那一路**不写**
   * （调用抛错 ⇒ 连回包都没有，四格为 0 已由 `finishReason:'failed'` 说清）。
   */
  usageMissing?: true;
  durationMs: number; retryCount: number;
  /**
   * 这次调用是怎么收的（判据唯一实现在 `runtime/agent-loop.ts` 的 `finishReasonOf`）：
   * `'failed'` 让 `failStreak` 涨；其余四档都表示"这不是模型失败"。
   * `'max_output_tokens'` / `'content_filter'` 是上游自己说"没说完"的两种（后一档 2026-10-18 补）：
   * 它们此前（content_filter）会被记成 `'completed'`，读起来像"说完了"。
   */
  finishReason: 'completed' | 'max_output_tokens' | 'content_filter' | 'failed' | 'aborted';
  /**
   * 这次调用的**当日累计（写入方口径，观测字段）**：本条写入之前的**内存投影当日累计**
   * + 本条的 `inputTokens + outputTokens`。
   *
   * ⚠️ 它是**"新口径基线 + 旧口径增量"的混合口径**（2026-10-05 换预算口径时留下的形状）
   * ⇒ **只是观测，任何闸门/判据都不许拿它当预算依据**：预算一律读投影（`state/fold.ts` 的
   * `budgetTokensOf`）。**五处写入一律如此、彼此自洽**，谁都没写错：`runtime/agent-loop.ts`
   * 的 `accountStep`（成功）/ `failStep`（失败，delta 为 0）、`channel/injection-judge.ts`、
   * `channel/topic.ts`、`persona/memory-maintain.ts`。口径与"将来要对齐的话最小改哪一行"
   * 见 `docs/schema.md` §6 这个字段的注释。
   */
  tokensTodayAccum: number;
  /**
   * 这次请求的**上下文归因**（`model/context-audit.ts` 的 `ContextBreakdown`）：
   * instructions / tools / 长期记忆层 / 历史 items / 此刻层 / 本轮输入 / 尾部插播各占多少 token。
   *
   * 为什么挂在预算事件上，而不是新开一种事件（2026-10-03，硬约束第 4 条）：
   * `budget/consumed` 本来就是**一次模型调用一条**，而且它已经在记 `cacheHitTokens` /
   * `cacheMissTokens`——缓存与"这次请求由什么组成"是同一件事的两面。新增类型要动 `AppEvent`
   * 联合、可见性表、fold 与重放四处，收益是零。
   *
   * 归因是**渲染层的纯函数副产物**（段边界只有 `render()` 知道），运行期与重放走同一个
   * `deriveRequest`，所以这个字段可重建、不是"只有运行期才有"的观测。
   *
   * **可选**：本字段是后加的，老日志里没有；`lastAuditedCall` 遇到没有它的调用直接跳过
   * （拿一个没有归因的调用当比对基准只会得到"到处都变了"的假结论）。
   */
  context?: ContextBreakdown;
  /**
   * **请求体构造点**：这次请求渲染时看得见的最大事件 seq（= `context.builtAtSeq` 的镜像）。
   *
   * 为什么在事件上再抄一格（2026-10-10）：读日志的人（和告警排查）第一眼要看的就是"这一拍是什么
   * 时候装出来的"——`ts` 是调用**结束**的时刻，两者能差到 63 秒（实测）。有了它就一眼能看出
   * "上一次调用的构造点之后、这一次的构造点之前"这段窗口里到底发生了什么。
   *
   * **可选**：老日志里没有它（读的一侧退回按 `seq` 切窗口，结论不变）。它不进请求体，
   * 所以**不需要动 `RENDER_VERSION`**（判据：`ds-client.buildRequestBody` 的白名单里没有它）。
   */
  contextBuiltAtSeq?: number;
  /**
   * 缓存破坏哨兵的结论：与上一次被审计的调用做前缀比对，**除此刻层尾巴以外**的部分变了才有。
   *
   * 没有这个字段 = 这次与上次的冻结前缀一致（不是"没查"）。只在真破坏时出现，
   * 所以它能直接当"框架提示"卡上的一条告警看。
   *
   * 2026-10-05 起它还带**归因与分级**（`cause` / `causes` / `silent`，判据在
   * `model/context-audit.ts` 的 `segmentCause`）：预期内的失守（重启、她自己改资产、
   * 工具清单变更、压缩、渲染换代、空闲）只落成普通记录，`silent === true`；
   * **只有归因不明的（`cause: 'unattributable'`）仍然进告警区**。
   * 字段是可选的：老日志没有 `silent` ⇒ 读的一方按"要告警"处理，历史条目一条不丢。
   */
  cacheBreak?: CacheBreak;
}> {}

export interface BudgetRollover extends EventEnvelope<'budget/rollover', { date: string }> {}

export interface BudgetExhausted extends EventEnvelope<'budget/exhausted', {
  layer: BudgetLayer; limit: number; actual: number;
  /** 暂停而不是失败；加预算后可以继续 */
  resumable: true;
}> {}

export interface BudgetToppedUp extends EventEnvelope<'budget/topped-up', {
  layer: BudgetLayer; addedTokens: number; by: string;
}> {}

/**
 * 暂停解除：那条 `budget/exhausted` 记下的可恢复暂停**已经解开**（internal）。
 *
 * 为什么它必须是一条自己的事件（2026-10-04 修的真 bug）：投影里的 `lastExhausted` 是**日志的
 * 折叠结果**——"上限调大 + 重启"只是把同一条 `budget/exhausted` 原样重放一遍，记录照样回来，
 * 于是配置变了、进程也重读了配置，唤醒门仍然拿那条历史记录拦住所有输入（现场：用户发的
 * `wake/manual` 躺在队列里没有 turn 起来；一加注、`budget/topped-up` 刚到，紧接着就
 * `turn/start`）。**解除是一件事，就得落成事件**：只改投影不落库，下一次重启会被日志推翻。
 *
 * 与 `budget/topped-up` 的分工：加注那条路自己就是凭据（`topped-up` 一到，fold 同样清掉该层
 * 记录），所以它不再补写这条；本事件记的是**上限被抬高之后、投影里那条记录还没被清掉**的那一路
 * ——`reason` 说清上限是谁抬起来的，`limit` / `actual` 是**解除那一刻**的两个数
 * （判定用的就是它们；当时撞线的那个数在它前面那条 `budget/exhausted` 里）。
 */
export interface BudgetResumed extends EventEnvelope<'budget/resumed', {
  layer: BudgetLayer;
  /** 解除那一刻的**有效上限** = 基础上限 + 累计人工加注 */
  limit: number;
  /** 解除那一刻的**已用量**（进度一个字节都没被改写） */
  actual: number;
  /**
   * 上限是被谁抬起来的：
   *   - `limit-raised` —— 配置改了（budget.* 是启动参数，重启后生效）；
   *   - `topup`        —— 配置没动，是累计加注把它抬上去的。
   *
   * 正常路径上人工加注走 `budget/topped-up`（那条自己就把记录清了），所以 `topup` 这一档
   * 是给"记录还在、而上限已被加注抬高"的情形兜底（例如投影缓存落后于日志时重建）。
   */
  reason: 'limit-raised' | 'topup';
}> {}

/**
 * 缓存未命中率的**主嫌疑**（`budget/cache-alert.topContributor`）。
 *
 * ⚠ 用户点名的纪律是「**不许编**」：这五个值里**只有一个**是"指认不出来"——
 * `'unknown'`。它不是"没有原因"，是"现有数据指认不出原因"，两者不能混着写。
 * 四条候选各自的判据（含为什么按这个顺序问、为什么用的数是这几个）逐字写在
 * `runtime/cache-alert.ts` 的 `topContributorOf`——**判据只有那一处**，这里只定格取值。
 */
export type CacheAlertContributor =
  /**
   * 思维链回传**已经在驱逐最老的 assistant 组**（2026-10-21 定位的根因）⇒ 历史头部位移
   * ⇒ 每一笔请求的前缀都从被挤掉的那一条起断掉。
   *
   * 判据：窗口覆盖的 seq 区间里出现过 `model/reasoning-echo{kind:'reasoning_echo_prune'}` 且
   * 它的某一条 `dropped[].why === 'maxTotalChars'`（撞的是**总字符硬上限**——2026-10-21 起
   * `why` 只剩它和 `'half-state'` 两个值，判据也从"三个上限"收窄成"总字符 + 轮边界"）。
   * 它排在其他四条**之前**：这是唯一一条"机制名字都对得上"的根因，
   * 而其余四条只是它的表现形式（`history-tail` 是结果、`render-version` 是无辜的巧合）。
   */
  | 'reasoning-echo-eviction'
  /** 窗口里 `context.renderVersion` 换过版 ⇒ 请求体整体不同（必然一次全 miss） */
  | 'render-version'
  /** 窗口里 `context.history.headHash` 变过 ⇒ 历史前段被改写（压缩换遮蔽点 / `input/requeued` 补标记） */
  | 'history-tail'
  /** 窗口里"带思维链的拍"明显变多 ⇒ 回传集合变了（v73 那类改动的指纹） */
  | 'reasoning-echo'
  /** 窗口里平均每拍至少重试一次 ⇒ 服务端在抖 */
  | 'retry'
  /** 四条候选都不成立 ⇒ **不知道**（不猜） */
  | 'unknown';

/**
 * 缓存未命中率告警的载荷（`runtime/cache-alert.ts` 的 `cacheAlertPayloadOf` 是唯一构造点）。
 *
 * ────────── 为什么要一条自己的事件，而不是塞进 `budget/consumed` ──────────
 *
 * 口径不同：`budget/consumed` 是**一次模型调用一条**（硬约束第 4 条要求把"这一次"的事实
 * 挂在它上面），而这一条是**一个滑动窗口一条**——最近 20 轮、同一 lane 分开算，
 * 与任何单次调用不是一对一（20 轮里可能一条都不发，也可能连着发好几拍才发一条）。
 * 塞进 `budget/consumed` 就必须在每一条账上重抄一遍同一份窗口结论，而"哪一条才是判据的
 * 那次触发"反而说不清。⇒ 它必须是独立事件，**与 `budget/resumed` 同一条形状**
 * （"这是一件事，就得落成事件"：只写控制台不落库，重启之后"报过没有"就无从判断）。
 *
 * ────────── 可见性：`internal`（**一个字节都不进她的上下文**） ──────────
 *
 * 她要看见的是那句**人话**（`wake/manual{via:'system'}` 的正文），不是这笔账。
 * 写成 `model` 的代价是每触发一次就多出一条常驻开销，而它对该做的事没有任何信息量
 * （与 `mcp/index` / `skill/index` / `tools/inventory-changed` / `model/reasoning-echo`
 * 逐字同一条纪律）。它**不进请求体 ⇒ 不动 `RENDER_VERSION`**。
 *
 * ────────── 载荷为什么带 `renderVersion` 与 `missRatioBand` ──────────
 *
 * 这两格是**去重键**，不是给人看的读数：24 小时去重的判据是
 * "同 `lane` + 同 `renderVersion` + 同 `missRatioBand` 只报一次"，
 * 而"报过没有"必须**从日志重建**（重启之后照样成立）。只写 `missRatio` 不够：
 * 它是 4 位小数，边界上舍入一次就会挪档，于是去重键必须把档位**显式落库**。
 */
export interface CacheAlertPayload {
  /** 哪条 lane（两条 lane 的"正常值"不是一个数，判据分开算、事件分开落） */
  lane: ModelLane;
  /**
   * **窗口用的是哪个模型的桶**（2026-10-26 加）——窗口从"最近 20 轮"改成
   * "**同一模型**的最近 20 轮"，所以这一格是读数的一部分：同一个 lane 换了模型，
   * 读数就换了一套账，不写模型名的话两行日志根本没法比（现场：`gpt-6.1-sol` 94.6% 与
   * `deepseek-flash` 11.1% 曾被算成同一个数）。文案里必须带上它。
   */
  model: string;
  /**
   * 最近 {@link CACHE_ALERT_WINDOW_TURNS} 档里**出现过的模型**（2026-10-26 加，**仅作诊断**）。
   *
   * 窗口本身只统计 {@link CacheAlertPayload.model} 那一套桶；这一格回答的是"这一段历史上
   * 混过几个模型"——升级前写下的日志、同一轮里切换过模型时都会出现 ≥2 个。
   * **不参与任何判据**（它进载荷是为了让复盘的人一眼看到"这里换过模型"，
   * 而不是让告警按模型个数做判断）。
   */
  modelsInWindow: string[];
  /** 窗口里参与统计的**轮数**（`turn > 0` 的那些轮；无轮号的内部调用各算一轮） */
  windowTurns: number;
  /** 窗口里**输入 token 合计**（Σ`inputTokens`，2026-10-26 加：零命中那一档要报"命中 0 / 输入多少"） */
  windowInputTokens: number;
  /**
   * 窗口里**供方报的命中 token 合计**（2026-10-26 加，**不是**读数用的那个数）。
   *
   * 读数用的命中量在自算那一档是估算值（见 {@link CacheAlertPayload.cacheEstimated}），
   * 这一格永远是 `budget/consumed.cacheHitTokens` 的原样加总——它回答"供方到底报了多少命中"，
   * 文案据此分辨"一次都没命中"（= 0）与"给了一个与上下文无关的常数"（> 0）。
   */
  windowProviderHitTokens: number;
  /** 窗口未命中率 = Σmiss / (Σhit + Σmiss)，0–1，4 位小数；`-1` = 算不出来（分母为 0） */
  missRatio: number;
  /** 基线：窗口**之前** 24 小时内"每轮未命中率"的**中位数**，0–1，4 位小数；`-1` = 没有可比基线 */
  baselineMissRatio: number;
  /**
   * 每轮大约多少**未命中当量 token**（整数）。
   *
   * ⚠ **单位是 token，不是钱**（`estCostUnit` 那一格就是为这件事存在的）。折算口径：
   * `estCostPerTurn = (未命中 + 输出 + 命中 × 1/10) / 窗口轮数`，其中 1/10 来自
   * `docs/design.md:603` 记下的用户分价口径（未命中价约为命中价的 ×10）——
   * 本仓库**不引入价格/货币/计费口径**（四处成文：`model/context-audit.ts:11`、
   * `docs/schema.md:391`、`docs/design.md:603`、`docs/tools-audit.md:403`）。
   * 字段名沿用 `estCostPerTurn` 是契约名；**读的人一律按 token 当量读，别乘任何价钱**。
   */
  estCostPerTurn: number;
  /** `estCostPerTurn` 的单位。字面量，唯一取值 `'miss-equiv-tokens'`——写进数据里，防误读成金额 */
  estCostUnit: 'miss-equiv-tokens';
  /** 主嫌疑（四条可证判据 + "不知道"，判据见 `runtime/cache-alert.ts` 的 `topContributorOf`） */
  topContributor: CacheAlertContributor;
  /** 窗口里最新一拍的 `context.renderVersion`；老日志没有这一格 ⇒ `'unknown'`（**不猜**） */
  renderVersion: string;
  /** 去重档位 = `floor(missRatio / 0.1)`（10 个百分点一档；理由见 `runtime/cache-alert.ts` 文件头 ⑤） */
  missRatioBand: number;
  /**
   * **这一行读数用的是供方给的数**（2026-10-26 加；与 `budget/consumed` 同名那两格同一个词，
   * 但口径是**窗口级**：这一格说"这个窗口的命中量取自供方账目"）。
   *
   * ⚠ 与 `budget/consumed.cacheReported` 的差别写在这里（免得读的人以为两处矛盾）：
   * 那里是"这一拍 hit>0"（逐拍，留痕）；这里是"这个窗口的读数按供方算"（窗口级，判据）。
   */
  cacheReported: boolean;
  /**
   * **这一行读数是按上下文前缀自算的**（2026-10-26 加）。为 `true` 时：
   *   · 该模型的窗口"不返回缓存数据"（供方一次都没报命中，或只报了一个与上下文规模无关的
   *     常数——判据在 `runtime/cache-alert.ts` 的 `cacheCaliberOf`）；
   *   · `missRatio` / `baselineMissRatio` 都由 `model/context-audit.ts` 的
   *     `estimatePrefixHitOf` 逐拍估出来（**供方给的数一个字节都没改**）。
   * 文案必须写明这一档（`cacheAlertReadings` / `cacheAlertWakeNote`），否则同一个百分数会被
   * 当成"供方说的"读——那正是这次要修的病。
   */
  cacheEstimated: boolean;
}

/**
 * 缓存未命中率告警（**internal**，2026-10-22 加）。
 *
 * 用户报的那个现象（原话）：「我注意到**缓存未命中在暴涨**。并且**框架没有任何警告**」
 * 「花费涨到**约 5 倍**，但框架**一声不响**。」（原话里的金额不复述：本仓库不引入价格/货币口径）
 *
 * 判据、五个阈值各自的理由、基线的取法、去重的档位、`topContributor` 的**五条**可证候选
 * **全部**写在 `runtime/cache-alert.ts` 的文件头与方法注释里（唯一一处，本文件不抄第二遍）。
 * 写入点也只有一处：`runtime/real-loop.ts` 的 `handleCostAlerts`——
 * 它在**一轮收尾之后**判一次（那时这一轮新写的 `budget/consumed` 已经落库），
 * 同一处还产出三样东西：这条事件、控制台一行、以及一次真唤醒
 * （`wake/manual{via:'system'}`，正文见 `cacheAlertWakeNote`）。
 */
export interface BudgetCacheAlert extends EventEnvelope<'budget/cache-alert', CacheAlertPayload> {}

// ──────────────────────────────── 策略与运维 ────────────────────────────────

export interface PolicyDenied extends EventEnvelope<'policy/denied', {
  tool: string;
  rule: 'path-allowlist' | 'command-denylist' | 'destructive-disabled' | 'hook';
  reason: string;
  callId: string;
}> {}

export interface LogRepaired extends EventEnvelope<'log/repaired', {
  truncatedBytes: number; lastGoodSeq: number;
}> {}

export interface InstanceTakeover extends EventEnvelope<'instance/takeover', {
  previousPid: number; previousHeartbeatAt: string;
  staleBecause: 'no-heartbeat' | 'pid-gone' | 'pid-reused';
}> {}

export interface InputClaimed extends EventEnvelope<'input/claimed', {
  turn: number; wakeSeqs: number[]; claimCounts: number[];
}> {}

export interface InputDeadLetter extends EventEnvelope<'input/dead-letter', {
  inputSeq: number; claimCount: number; lastError?: string;
  /**
   * 为什么进死信（2026-10-16 加，**可选**：老日志里整个没有这一格）。
   *
   *   · `claim-limit`       —— 认领次数到上限（`MAX_CLAIM_COUNT` / 整轮失败的重投上限），毒消息保护，原口径；
   *   · `stopped-by-owner`  —— 用户在通道里发了 `/stop`，他要求停下来，队列里的输入被清场；
   *   · `server-rejected`   —— **服务端拒了这份请求**（v74-A，2026-10-20 加）：`http_400` /
   *     思维链没回传的指纹。同一份历史渲染出的还是同一份请求 ⇒ 重投只会再被同样的 400 拒一次，
   *     所以**一次都不再投**（现场：一条输入被认领 3 次、她把同一句答了三遍）。
   *
   * 为什么要把它写进事件而不是只靠 `lastError` 那句话：这几类的**下一步动作完全不同**
   * （`claim-limit` 要人去查"这条输入为什么必然失败"、或者丢弃；`server-rejected` 是"请求本身
   * 不合法"，要改的是渲染/协议而不是那条输入；`stopped-by-owner` 只是用户按了停止，随时可以重投），
   * 而界面只能读字段、读不了自由文本。`lastError` 照旧是给人读的原话。
   */
  reason?: 'claim-limit' | 'stopped-by-owner' | 'server-rejected';
}> {}

/**
 * 人把一条死信**丢弃**（不再重投）：`input/dead-letter` 的终局之一（internal）。
 *
 * 为什么是一种自己的事件，而不是"删掉那条死信记录"（2026-10-05 定）：
 * 事件日志是唯一真相源、**只增不改**。一条输入被认领三次仍然失败是**已经发生过的事实**，
 * 抹掉它等于篡改日志；人能做的事只是**决定不再重投**——那是另一件事，就该有另一条事实。
 * 于是投影里它离开死信队列（"现在是什么"变了），日志里那条 `input/dead-letter` 一个字不动。
 *
 * 与 `input/requeued` 的区别只在**结局**：那条是"再给一次机会"（回到 pending），
 * 这条是"到此为止"（输入被有意作废，它的内容不再进入她的上下文）。
 * 两条都销掉同一条死信，所以对同一个 inputSeq 只能有一条真正生效——API 层据此报 404。
 */
export interface InputDiscarded extends EventEnvelope<'input/discarded', {
  /** 被丢弃的那条输入（`input/dead-letter` 里的 inputSeq） */
  inputSeq: number;
  /** 死信形成时的认领次数：留痕用，便于人回看"它到底试了几次" */
  claimCount: number;
  /** 丢弃理由（自由文本；人写的原话进日志，不加工） */
  reason: string;
  /** 谁丢的。今天只有人这条路（API/CLI），字段留出来是为了将来框架自动清场时说得清 */
  by: string;
}> {}

/** 输入退回队列：interrupted turn 认领过的输入重新入队（internal） */
export interface InputRequeued extends EventEnvelope<'input/requeued', {
  wakeSeqs: number[]; claimCounts: number[];
  /** 各输入的来源（恢复流程从原 wake 事件还原） */
  sources: WakeSource[];
  /**
   * 退回原因：`turn-interrupted`（崩溃/中断）、`startup-recovery`（恢复七步补投）、
   * `human-answered`（人审挂起的 turn 得到答复后重入，design §4.21）、
   * `turn-error`（整轮失败：模型/服务端拒了请求——输入不该就此消失，2026-10-02 补）、
   * `human-timeout`（人审挂起超时：那条待答按"未获批准"作废，她手上的活**继续**
   * ——2026-10-22 加，见 `HumanTimedOut`）。
   * 五者的共同语义是「这些输入回到队列里，还有一次完整机会」；差别只在记账。
   */
  reason: 'turn-interrupted' | 'startup-recovery' | 'human-answered' | 'turn-error' | 'human-timeout';
}> {}

/**
 * 人在本机对话流里打的一条**指令**（B1 第二步：`/compact` 与 `/handoff`）。
 *
 * 为什么它必须是一种自己的事件，而不是借用别的信封（2026-10-04 定）：
 *   · `input/claimed` 只说"这条输入被消费了"，说不出是**哪条指令**、带了什么理由；
 *   · `alarm/sent` 是**告警**——它的 title/body/fingerprint 还要被限流、指纹配对与
 *     "已恢复"那一套消费。把指令塞进去，读日志的人分不出"这是一条指令记录"还是
 *     "框架报警了"，而这两种事实的处置完全不同。
 * 一句话：事件日志是唯一真相源，**多出一种事实就该有它自己的类型**。
 * （与 `speak/sent` 补 `text` 那次的分寸相反：那里是同一个事实补字段，这里是多出了一个事实。）
 *
 * visibility 一律 internal：它是**簿记**（谁在什么时候按了哪条），不是给她的输入。
 * 指令的效果落在别的 model 事件上（`compaction/summary`）——她该看见的是那份摘要，
 * 不是"用户按了个按钮"。GUI 侧同样不上屏（chat_page 的映射表里没有它）。
 */
export interface SlashHandled extends EventEnvelope<'slash/handled', {
  /**
   * 认出来的指令种类；`unknown` = 打了斜杠但不在名单里（只回一句话，什么都不做）；
   * `stop` = 用户的急停（2026-10-16 加，见 `runtime/slash-commands.ts` 的 `STOP_RECEIPT`）。
   *
   * 为什么急停也走这一种事件而不是新开一种：它与那两条**逐字同形**——谁按了、按的是哪个词、
   * 带了什么理由、结局是什么、回给用户的那句话是什么。多出一种事件 = 多一处要跟着改的读日志的
   * 地方，而这三种指令在读日志的人眼里是同一件事：**人按了一个按钮，框架办了一件事、回了一句话**。
   */
  kind: 'compact' | 'handoff' | 'unknown' | 'stop';
  /** 打出来的那个词（`unknown` 时是被打错的词——回话要点名） */
  name: string;
  /** 指令后面跟的那句话（理由）；没有就是空串 */
  argument: string;
  /**
   * 落地结果：
   *   · `compacted` —— 真的压了一次（同一批里紧随一条 `compaction/summary`）；
   *   · `empty`     —— 事件流里渲染不出条目，一个字都没改（不写空摘要）；
   *   · `rejected`  —— 不认识的词，只回了一句话，什么都没做；
   *   · `stopped`   —— `/stop`：**确实有活在跑**（流被掐了 / 队列里有输入被清进死信）；
   *   · `idle`      —— `/stop` 时没有在跑的活、队列也空：**什么都没停**。
   *     `stopped` 与 `idle` 分开是刻意的（幂等的落点）：界面据此说清"是停掉了什么"
   *     还是"本来就没在跑"，而回执文案与日志说的是同一件事。
   */
  outcome: 'compacted' | 'empty' | 'rejected' | 'stopped' | 'idle';
  /** 被消费掉的那条输入（`wake/manual` 的 seq）：把"他打了什么"与"我们怎么处理"对上 */
  inputSeq: number;
  /** 遮蔽点；只有 `compacted` 有，且与紧随其后的 `compaction/summary` 是同一个数 */
  coveredUpToSeq?: number;
  /**
   * **回给用户的那句话——逐字**（与 `injection/noted.note` 同一条理由：问"框架当时说了什么"
   * 必须能从日志里查到原话，而不是靠渲染层再拼一遍）。
   *
   * 为什么不能只靠告警那条路：告警事件（`alarm/sent`）只装 `title`，回执正文只在告警文件与
   * webhook 里——日志是唯一真相源，回执本身也得留在日志里。回执同时仍走告警出口送给人
   * （见 `real-loop` 的 `runSlashCommand`）。
   */
  receipt: string;
}> {}

export interface ToolZombie extends EventEnvelope<'tool/zombie', {
  callId: string; name: string; note: string;
}> {}

export interface AlarmSent extends EventEnvelope<'alarm/sent', {
  fingerprint: string; level: 'info' | 'warn' | 'critical'; title: string;
  /**
   * 故障键（`category:stall`、`alert:水位停滞` 这类）：同一次故障的"报警"与"已恢复"靠它配对。
   *
   * 为什么落进事件（2026-10-03）：故障登记原来只在告警出口的内存里，进程一重启就丢，
   * 于是一条已经报出去的故障永远等不到它的"已恢复"（限流窗口却还在，也不会重报）。
   * **可选**字段：普通告警（notify、预算提示）不写它，老日志里也整个没有——
   * `foldStalls` 遇到没有 key 的事件直接跳过，行为与之前逐条一致。
   */
  key?: string;
  /** 这条是恢复通知而不是故障本身（`foldStalls` 据此销账）；同样可选，老日志没有 */
  recovered?: true;
}> {}

export interface ReviewResolved extends EventEnvelope<'review/resolved', {
  callId: string; outcome: 'succeeded' | 'failed' | 'partial'; note: string; by: string;
}> {}

export interface SnapshotCheckpoint extends EventEnvelope<'snapshot/checkpoint', {
  upToSeq: number; file: string;
}> {}

export interface CompactionSummary extends EventEnvelope<'compaction/summary', {
  coveredUpToSeq: number; summary: string;
}> {}

/**
 * **这一拍为什么不压**（压缩判定的留痕，2026-10-09 加；internal）。
 *
 * 为什么必须有它：`maybeCompact` 有四条静默 return（阈值没过 / 遮蔽点回退 / 折叠反而更大 /
 * 收益闸门没过），而"这一拍为什么没压"在日志里**一个字都没有**——出问题时只能靠
 * "很久没见到 `compaction/summary` 了"去反推，而反推不出是哪一条判据拦下的。
 * 先例是 `wake/heartbeat` 把 `probability`/`roll` 落进事件（"这一拍为什么现在响"要能复算）：
 * **判据用到的每一个数都要能从日志里读回来**，而不是只能重跑一遍代码。
 *
 * 一 turn 恰好一条（写入点在 `runtime/agent-loop.ts` 的 `TurnRunner.run()` 收尾，唯一一处），
 * 所以"按 turn 取一行"恒成立，不必去重。
 *
 * 字段口径（**全部来自 `compactionDecision` 这一个函数的同一次求值**，不接受别处再算一遍）：
 *   • `turn`——本 turn 的号（与 `turn/start.turn` 同一个数）；
 *   • `historyTokens`——**算出来的**可见历史估算（`estimateHistoryTokens`，尚未遮蔽）；
 *   • `thresholdTokens`——当时生效的配置阈值；
 *   • `coveredUpToSeq`——本次算出来的遮蔽点（`compactionCoveredUpToSeq` 的结果）；
 *   • `previousCoveredUpToSeq`——闸门的**参照点**：已有摘要的覆盖点（`0` = 还没压过，这一次
 *     就是第一次折叠；判据见 `agent-loop.ts` 的 `maxSummaryCoverage`）。刻意不是
 *     "上一个 turn/end"，也不是"本 turn 起始 seq"——那两个都会让第一次折叠永远压不动；
 *   • `maskedTokens`——④甲 闸门量：`(参照点, 遮蔽点]` 之间的可见历史规模
 *     （`estimateMaskedTokens`），也就是"这次折叠将要改变的字节有多少"；
 *   • `echoChars` / `echoCharsLimit`（**v75 加**）——回传集合的正文字符与它的上限：
 *     **进第一道门有两条路**，这是第二条路的两个数（`echoChars > echoCharsLimit` ⇒ 立即压）；
 *   • `trigger`（**v75 加**）——是**哪一条**把这一拍推过第一道门的（`history-tokens` /
 *     `echo-chars`；`threshold` 那一支缺席 = 谁都没推）。
 *
 * 后四格里 `coveredUpToSeq` / `previousCoveredUpToSeq` / `maskedTokens` **可选**：
 * 阈值没过时后面那几格**根本没算**（那时"遮蔽点在哪"不是一个已经成立的事实），
 * 编一个 0 填进去等于伪造一次判定。缺省即"这一条判据还没走到"。
 *
 * 可见性 internal（写不写在这里、以及"为什么不压"，与她的行事无关，也不该占她的上下文）：
 * 她该看见的是压缩的**效果**——`compaction/summary` 那份交接笔记，以及紧随其后的那条
 * `wake/manual`（`via: 'compact'`）。GUI 侧同样不上屏（chat_page 的映射表里没有它）。
 */
export interface CompactionDecision extends EventEnvelope<'compaction/decision', {
  turn: number;
  /** 算出来的可见历史估算（token） */
  historyTokens: number;
  thresholdTokens: number;
  /**
   * 结论。**取第一条拦下它的判据**，判据的顺序就是 `compactionDecision` 里那五道门
   * （与 `maybeCompact` 原来的静默 return 一一对应）：
   *   · `threshold` —— 可见历史没越过阈值（最常见的一支，绝大多数 turn 都是它）；
   *   · `monotonic` —— 遮蔽点回退（不许把已经不在现场的内容变回现场）；
   *   · `no-shrink` —— 折叠完反而更大（那种"压缩"是纯粹的负收益）；
   *   · `gate`      —— ④甲 收益闸门：新闭合的历史不足一个 recent tail；
   *   · `wrote`     —— **压了**：同一批里必有一条 `compaction/summary`。
   */
  reason: 'threshold' | 'monotonic' | 'no-shrink' | 'gate' | 'wrote';
  /** 本次算出来的遮蔽点；`threshold` 时缺席（没算） */
  coveredUpToSeq?: number;
  /** 已有摘要的覆盖点（`0` = 还没压过）；`threshold` 时缺席 */
  previousCoveredUpToSeq?: number;
  /** ④甲 闸门量：`(previousCovered, covered]` 的可见历史规模；`threshold`/`monotonic`/`no-shrink` 时缺席 */
  maskedTokens?: number;
  /**
   * **回传集合的字符账**（**v75 加，每轮都有**）：`echoChars` = **会回传的总字符**
   * （= 遮蔽点之后、model 可见的思维链正文全部；截与不截都算进来，与渲染层同一处算出）。
   *
   * 为什么它必须每轮都写：v75 给压缩判定加了**第二条触发**——
   * `echoChars > echoCharsLimit` 时**不等 token 阈值**、这一轮收尾就压（见下 `trigger`）。
   * 判据用到的数要能从日志里读回来（本仓库的既有纪律，与 `maintenanceWindow.atMs` 同款），
   * 否则"这一轮为什么突然压了"事后只能靠重算。
   *
   * ⚠ **判据读它（总量）、不读 `echoCharsKept`**：后者一驱逐一压就"变好看"（被压回上限以内），
   * 拿它当压力读会在真正出事的那一刻失去信号——2026-10-21 凌晨那 39 分钟正是这个形状
   * （`kept` 一直 ≤ 300K，而驱逐一直在发生）。
   */
  echoChars?: number;
  /** **真正留在请求里**的那一份（`echoChars` − 已被挤掉的）；只服务观测，不参与判据 */
  echoCharsKept?: number;
  /**
   * 那一刻生效的回传字符上限（`REASONING_ECHO_POLICY.maxTotalChars`）。
   * `null` = 出厂没设上限（那种实例上第二条触发没有对象）。它与 `echoChars` 成对，缺一个都读不出比例。
   */
  echoCharsLimit?: number | null;
  /**
   * **这一拍是"哪一条判据"把它推过第一道门的**（**v75 加**；`threshold` 时缺席 = 谁都没推）。
   *
   * 为什么 `reason` 答不了这个问题：`reason` 记的是"**第一条拦下它**的判据"（threshold /
   * monotonic / no-shrink / gate / wrote），而 v75 起**进门**的条件有两个——`historyTokens`
   * 过阈值，或者 `echoChars` 过回传上限。所以"进去了"这件事得单独有一格：
   *   · `history-tokens` —— 老口径（可见历史估算过 `thresholdTokens`）；
   *   · `echo-chars`    —— **v75 的新口径**：回传字符过 `echoCharsLimit` ⇒ 立即压
   *     （把老 reasoning 用"遮蔽点"一次性移出，而不是让渲染层在轮内一点点挤）。
   *
   * 它出现在**所有**非 `threshold` 的结论上（`wrote`：压了；`monotonic`/`no-shrink`/`gate`：
   * 被别的判据拦下了，但"谁推的门"照样可归因）。
   */
  trigger?: 'history-tokens' | 'echo-chars';
  /**
   * **本轮给出的维护窗口**（2026-10-11 加，可选；internal 观测面）。
   *
   * 为什么寄在这条事件上、而不是另立一个事件类型：它是**每轮恰好一条**的那张留痕
   * （`TurnRunner.run` 收尾写一次），而"这一轮该不该给她一条维护窗口信号"与压缩判定是
   * **同一批材料算出来的**（`historyTokens` / `thresholdTokens` 就是那三个窗口里的第一个）。
   * 一 turn 一行 ⇒ "上一次维护窗口是哪一刻给的"在日志里只有这一处答案（那道 6 小时的闸
   * 就是从它读的，见 `render.ts` 的 `lastMaintenanceWindowAt`），不必把状态记在进程内存里
   * ——重启之后内存里那份就没了，而这道闸恰恰要跨重启成立。
   *
   * **它是 Internal 观测**：`compaction/decision` 本来就不进她的上下文（`visibility: 'internal'`），
   * 所以这一格**不改请求字节、不动 `RENDER_VERSION`**。真正进她上下文的是此刻层那一行
   * （`维护窗口：…`），它在**渲染**那一侧、由宿主算好递进去——两者是同一件事的两面：
   * 这一格回答"框架给过没有"（复盘/限流），那一行是她看到的话。
   *
   * **缺席 = 这一轮没有窗口**（绝大多数轮次都是这一支）：不许写成 `reason: null` 那种占位，
   * 那会把"没给"与"给了但没记"混成一种形状。
   */
  maintenanceWindow?: {
    /** 触发的是哪一条（三个之一；顺序即优先级，见 `render.ts` 的 `maintenanceWindowOf`） */
    reason: 'compaction-soon' | 'late-night' | 'heartbeat-idle';
    /** 这一条作答的时刻（毫秒时间戳）：**那道 6 小时闸的锚点**就是它 */
    atMs: number;
    /** 那一刻算出/给出的当地自然日（`YYYY-MM-DD`，配置时区）——观测用，缺了不影响判据 */
    day?: string;
  };
  /**
   * **压缩预警的账**（2026-10-15 加，生产上每轮都写）：这一轮"该不该叫醒她整理"。
   *
   * 形状的**唯一出处是这里**（事件是契约）；判据、比例与文案在
   * `src/model/compaction-warning.ts`（那边 import 本类型，反向不成立——`log/` 不认识 `model/`）。
   *
   * 为什么必须有它（用户 2026-10-15 的口径：「**得让 agent 看见**」·「把'离 80% 线还有多少 /
   * 这次为什么响或没响'写进 `compaction/decision`」）：那条预警是**一条真唤醒**
   * （`wake/manual{via:'compact-soon'}`），而"没响"的那些轮次在日志里本来一个字都没有——
   * 事后要回答"她这几天为什么没被提醒"就只能靠反推（实测踩过：把此刻层那道 6 小时闸的语义
   * 与这条唤醒混成一件事）。这一格把**判据的三个数**与**结论**就地记下来。
   *
   * **2026-10-21 改成分档**（用户 14:33 那次"突然被压缩、之前没预警"的直接修法）：
   * 原来这里只有一个 `already-warned` 的一刀切——**上一次压缩之后只要报过一次，之后无论历史
   * 涨到多高都永久静默**（实测连续 6 条 `warning.fired=false, why:"already-warned"`，
   * 其中 histTok 170,207 / 175,379 / 179,777 三笔已经贴着 200k 的线）。
   *
   * **2026-10-22 收成"每档只报一次"**（用户原话：「压缩临近变成了每次唤醒都有。80% 提醒
   * 一次、95% 提醒一次就行了」；现场同一档 80 在 07:34 / 08:25 / 09:09 各报了一次）：
   *   · **两档**：跨过 **80% / 95%** 各报**一次**（90 那一档删掉）；
   *   · **同一档报过就永久不再报**（判据里没有时钟；上一版的 `cooldownMs` 已废弃、恒为 0）；
   *   · **重置**：压缩过（`reason='wrote'`）或可见历史掉到阈值 50% 以下 ⇒ 分档状态归零，
   *     下一个压缩周期照样报（`lastTier` = 0）。
   *
   * `why` 的取值就是判据的形状（`planCompactionWarning` 每个 return 各一个），
   * 不是给人看的形容词：
   *   · `fired`           —— 该发 ⇒ 这一轮发了那条唤醒（跨了新档）；
   *   · `below-line`      —— 历史没到 80%（绝大多数轮次都是它；<50% 同时是"重置"的那一行）；
   *   · `already-warned`  —— **本周期这一档已经报过**（或报过更高的一档，不回头补报低档；
   *     永久：她可能正在整理，也可能判断"现在不值得整"，两种都该由她定，框架不该催第二遍）；
   *   · `just-compacted`  —— 本轮压缩判定的结论是 `wrote` ⇒ 刚压过（压缩也是重置点）；
   *   · `unknown`         —— 本轮没算出可见历史（或读数不可用）⇒ 不判。
   *
   * ⚠ `cooldown` 这一格**只出现在 2026-10-22 之前的老日志里**（上一版"同档 30 分钟冷却"
   * 的出口）：本版判据不再产生它，联合类型留着它是为了让老日志读得懂、复算得回。
   *
   * `tier` / `lastTier` / `lastAtMs` / `cooldownMs` 四格是**为了让判据可复算**（把当时的
   * 状态与参数一起落账，事后不必猜"那一拍为什么没报"）：读一行就知道"当时在第几档、
   * 这一档上次报是什么时候"。`lastTier` / `lastAtMs` 记的是**判据读到的上一拍状态**
   * （本行自己造成的重置从下一行起生效）。
   *
   * **它是 internal 观测**（本事件整体不进她的上下文）⇒ 不改请求字节、不动 `RENDER_VERSION`。
   */
  warning?: {
    /** 这一轮有没有真的发出那条唤醒 */
    fired: boolean;
    /** 结论（见上：每个取值对应判据里的一个出口；`cooldown` 只出现在老日志里） */
    why: 'fired' | 'below-line' | 'cooldown' | 'already-warned' | 'just-compacted' | 'unknown';
    /** 判据用的那个**可见历史估算**（与压缩判定同源；没算出来时为 null） */
    historyTokens: number | null;
    /** 当时生效的压缩阈值（配置值；读数不可用时为 null） */
    thresholdTokens: number | null;
    /** 比例（第一档，当前固定 0.8，见 `model/compaction-warning.ts` 的 `COMPACTION_WARNING_RATIO`） */
    ratio: number;
    /** 本拍所处的档位（`0` = 线下；`null` = 本轮没读数，判不出来；`90` 只出现在老日志里） */
    tier: CompactionWarningTier | null;
    /** 本拍之前、当前压缩周期里已经报过的**最高**档（`0` = 一档都没报过） */
    lastTier: CompactionWarningTier;
    /** 上一次真的报出去的毫秒时刻（`null` = 本周期还没报过）。**判据不再读它**（冷却已删），只做账 */
    lastAtMs: number | null;
    /** **已废弃**（2026-10-22 起恒为 0；老日志里是 1800000）：同档冷却已删，判据不读时钟 */
    cooldownMs: number;
  };
  /**
   * **本 turn 最近一笔成功调用的真实输入读数**（2026-10-21 加，纯观测）。
   *
   * 为什么要它：`historyTokens` 是估算器的账（`estimateHistoryTokens`，中文约 1.5 字/token，
   * 实测系统性偏低 ~1.6×），而用户要回答的正是「**估算 200k 时真实是多少**」——两把尺子
   * 摆在同一行上，这件事才不用重算。**不做任何换算决策**：压缩判定仍然只读 `historyTokens`
   * （两把尺子换算会悄悄挪动阈值），这两格只让账可查。
   *
   * 口径：`inputTokens` = 那一笔的 `usage.inputTokens`（服务端说的）；
   * `estimatedInputTokens` = **同一笔**请求的估算合计（`context.instructions.tokens +
   * context.tools.tokens + context.input.tokens`，与 `budget/consumed.context` 同一套段事实）。
   *
   * **缺席 = 本 turn 没有一笔"有真实 usage 的成功调用"**（首步就抛错 / 只失败收尾 / 对端没给
   * usage）：不写一个 0 冒充读数。它不进她的上下文 ⇒ 不改请求字节、不动 `RENDER_VERSION`。
   */
  inputTokens?: number;
  /** 同一笔请求的**估算合计**（见上；与 `inputTokens` 同进同出） */
  estimatedInputTokens?: number;
}> {}

/**
 * **压缩预警的档位**（百分比，`0` = 一档都没到）。
 *
 * 取值只有这四个：档位是**判据的形状**，不是给人看的形容词——事件里的 `tier` / `lastTier`
 * 与 `model/compaction-warning.ts` 的 `warningTierOf` 共用这一份词表。
 *
 * ⚠ **2026-10-22 起判据只产生 `0 / 80 / 95`**（90 那一档删掉，用户：「80% 提醒一次、
 * 95% 提醒一次就行了」）。`90` 留在联合类型里**只为读老日志**（那一版写下的行里 `tier: 90`
 * 仍然要复算得回来）。
 */
export type CompactionWarningTier = 0 | 80 | 90 | 95;

/**
 * **压缩预警那一格的类型**（`CompactionDecision.data.warning`）：形状的唯一出处就是上面那个接口。
 *
 * 单独导出它是为了让**判据模块**（`src/model/compaction-warning.ts`）能拿到它的返回类型，
 * 而不必把 `CompactionDecision` 整个拖进去——判据只需要"它得交回什么形状"这一件事。
 */
export type CompactionWarning = NonNullable<CompactionDecision['data']['warning']>;

export interface PersonaUpdated extends EventEnvelope<'persona/updated', {
  file: string; diffHash: string; by: 'agent' | 'human';
}> {}

export interface ConfigChanged extends EventEnvelope<'config/changed', {
  fields: string[];
  /**
   * **生效配置**的指纹（不是盘上那份的）：这个事件说的是"运行中的进程现在按什么跑"。
   * 盘上那份的新指纹另见命令响应里的 `savedConfigHash`。
   */
  configHash: string;
  /**
   * true = 这次改动**还没生效**，要重启进程才接管（2026-10-04 加）。
   *
   * 为什么必须有这一位：热更白名单现在是空的（见 `config/watcher.ts` 的文件头），
   * 所有字段都走"重启才生效"那条路。不写这一位的话，日志里只有 `config/changed`
   * 一条"配置变了"的事实，而进程其实还在按旧值跑——看日志的人（包括 replay）
   * 会把两者当成同一件事。
   */
  requiresRestart?: boolean;
}> {}

/**
 * 每日整理结果（design.md §4.17）。
 * 四操作枚举是写入路径与存储之间的稳定接口；计数与文件真实动作一一对应（internal，不进上下文）。
 */
export interface MemoryMaintained extends EventEnvelope<'memory/maintained', {
  /** 整理日期（YYYY-MM-DD，与 budget/rollover 同口径） */
  date: string;
  ops: { add: number; update: number; invalidate: number; noop: number };
  /** 被合并的 episode 份数 */
  mergedCount: number;
  /** 已移入 episodes/archive/ 的份数 */
  archivedCount: number;
  /** TTL 过期移入归档区的条目数 */
  expiredCount: number;
  /** 日记文件路径；写失败为 null */
  diaryFile: string | null;
  /** 本任务 light lane 消耗（input+output） */
  lightTokens: number;
}> {}

/**
 * 本轮的**记忆索引注入账**（B2，docs/memory-injection.md §4；2026-10-04 简化）。
 *
 * **为什么它必须是事件**：本仓库的地基是**可重放**——`deriveRequest` 必须能只凭事件日志重建
 * 逐字节相同的请求。而"这一轮到底注入了没有、注入的多大"如果在运行期临时算，事后就没人答得上来
 * （索引文件是她自己随时会改的东西，现在的盘不等于当时那一份）。
 *
 * **只记指纹与规模，不记内容**（2026-10-04 用户的口径：「只看索引，如果需要，heavy 自己去读，
 * 随后跟随 tool call 留在上下文」）：注入的那段索引本身就是从 `MEMORIES/INDEX.md` 渲染出来的，
 * 全文落进事件等于**把同一份东西存两遍**——而它有上限一兆字节量级的风险，日志是 append-only 的。
 * 所以这里留 `indexHash`（当时那份索引文本的指纹，用来事后核对"注进去的是哪一版"）与
 * `entries`（条数，用来判断规模）。要读当时那一版全文，去 `MEMORIES/INDEX.md` 的快照/审计路径，
 * 而不是把它塞进每轮一条的事件里。
 *
 * 它同时回答**这一轮为什么没注入**：心跳轮整轮不注入（`injection: 'heartbeat'`），
 * 只记"注入了"的话，这个问题就永远没人答得上来。
 *
 * 可见性 internal：它是**装配账**（哪一版索引进过请求是日志的事实），不是给她的输入。
 * 真正给她看的是本轮固定块里那段索引本身（见 model/render.ts 的 `TurnBlockFacts`）。
 */
export interface MemorySelected extends EventEnvelope<'memory/selected', {
  /** 归属的 turn（轮首写，所以它的 seq 落在该 turn 的第一个 step/start 之前） */
  turn: number;
  /** 本轮的注入理由：心跳轮不注入；有人跟她说话时注入 */
  injection: 'human' | 'heartbeat';
  /**
   * 当时注入的那段文本的指纹（sha256 十六进制）。
   *
   * **2026-10-15（阶段一）起，它哈希的是"推荐段"**（`【可能相关的记忆】…` 那一段，
   * 见 `persona/memory-select.ts` 的 `renderMemoryRecommendation`）——因为固定块里注入的
   * 就是那一段。在那之前哈希的是整张指针表（`renderMemoryIndex`）。两代事件靠
   * {@link selected} 在不在来区分（老事件没有那一格），**别按"指纹对不上就是重建错了"读**：
   * 指纹始终等于"当时注入的那段文本"的哈希，这一点两代都没变。
   *
   * 它是"注进去的是哪一版"的唯一凭据：索引文件会被重建，事后从盘上读到的是**现在**那份，
   * 与当时未必相同——有指纹才分得清"重建对不上"是因为索引变了还是因为重建错了。
   */
  indexHash: string;
  /** 写这条账时注入的索引条数（规模；不是索引全文） */
  entries: number;
  /**
   * **当时注入的那一段文本本身**（阶段一，2026-10-15；可选）。
   *
   * ⚠ 这一格看起来像在违反上面那条"只记指纹与规模，不记内容"的口径——它不是，理由逐条写清：
   *
   *   · **旧口径为什么能只留指纹**：那时注入的是 `renderMemoryIndex(buildMemoryIndex(dir))`，
   *     是**盘上文件 + 确定性渲染**的函数 ⇒ 重建那两条路（`replay.ts` / `web/server.ts` 的
   *     `buildReplay`）只要 `readMemoryIndexTextReadOnly(dataDir)` 就能逐字节复原。
   *   · **新口径为什么不成立**：注入的是**推荐段**（BM25 挑出来的 6 条 + 条数），它的输入是
   *     **当时的记忆文件**。盘上文件会被她自己改（她天天在写），而 BM25 的语料是"路径 + 摘要"、
   *     查询是**日志里那 5 次输入**——事后**没有任何办法**把当时那份推荐重算出来。
   *     实测过一次：界面预览与运行期请求差了 **488 字节**（`test/channel-wire.test.ts:601` 那条用例
   *     就是因为这个红的），而"预览"的全部价值就是给她（与用户）看她当时到底收到了什么。
   *   · **所以记的是结论、不是素材**：与 {@link assets} 那一格**同一条纪律、同一个理由**
   *     （v34 起 `memory/selected.assets` 就存着"当时那一行渲染好的文本"，因为盘上的
   *     `assets.md` 是她随时会改的、重建算不出当时挑的是哪几条）。这里只是把同一条做法
   *     用在"推荐段"这一行上。
   *   · **代价是有界的、而且是可复算的**：实测 14–16 条的索引上推荐段 **约 190 token / 600 字符**
   *     （真索引 178 条时约 220 token）——每轮一条，日志是 append-only 的。相对"预览会骗人"
   *     这件事，这个价钱是值的（用户 2026-10-04 那条"只看索引"省的是**每轮请求**的开销，
   *     与"账里多一列可再生文本"是两件事）。
   *
   * **缺省 = 老事件**（2026-10-15 之前写的那些）：那时注入的是整张指针表，由盘上 `INDEX.md` +
   * {@link indexHash} 复原（上面第一条那个成立的前提）。读的人按"不在就是老事件"处理，
   * **不许**给它补默认值（补成空串会让"老事件"与"这一轮什么都没注入"变成同一种读法）。
   */
  injected?: string;
  /**
   * 固定块里那一段**实际印出来的**指针（阶段一，2026-10-15；可选）。
   *
   * 形状是 `MEMORIES/facts.md:10` 这种指针，**按展示顺序**（pinned 保底的在前，其余按分数降序）。
   * 它回答的问题是 `indexHash` 回答不了的那一个：**"当时推到她眼前的是哪几条"**。
   * 升级之前这条账只落 `indexHash` + `entries`（条数），而报告 §6 记着那个后果——
   * 事后**无法**逐轮重建"当时那 29 条到底是哪 29 条"（`_ops-bm25\REPORT.md` §6）。
   *
   * 只放指针、不放正文（与 `indexHash` 同一条纪律：账不是载体）。
   * **缺省 = 老事件**（2026-10-15 之前写的那些）：那时注入的是整张指针表，全文可由
   * `MEMORIES/INDEX.md` 的快照/审计路径 + `indexHash` 对回去 ⇒ 不需要也不许给这一格补默认值。
   */
  selected?: string[];
  /**
   * 与 {@link selected} **逐位对应**的 BM25 分数（两位小数；pinned 保底收进来的记 0）。
   *
   * 为什么要落分数：`selected` 说的是"挑了谁"，分数说的是"**为什么是它**"——
   * 没有分数，事后只能说"框架当时觉得相关"，而这是不可核对的。
   */
  scores?: number[];
  /**
   * 这一轮挑选用的**查询指纹**（阶段一，2026-10-15；可选）。
   *
   * 查询 = 用户**最近 5 次输入的聚合**（用户原话那一版的判据）。这里**不落查询原文**：
   * 那 5 条输入本身就是日志里的事件（`wake/manual` / `wake/channel` / `wake/webhook`），
   * 再存一份就是重复存储。落 `seqs` 是为了让"按哪几条挑的"能**精确对回去**；
   * `hash` 是聚合后那段文本的 sha256（判据改了、或那几条被截断了，指纹就对不上）。
   *
   * **缺省 = 老事件**，与 {@link selected} 同一条纪律。
   */
  query?: {
    /** 聚合文本的 sha256（空查询 = 空串） */
    hash: string;
    /** 参与聚合的输入事件 seq（时间序；少于是多少条就多少条） */
    seqs: number[];
    /** 参与聚合的条数 */
    texts: number;
    /** 有没有因为字符上限被截断（如实记，不假装完整） */
    truncated: boolean;
  };
  /**
   * 本任务相关资产那一行（v34，可选；`MEMORIES/assets.md` 里挑出来的 ≤3 条，**已渲染好的文本**）。
   *
   * **为什么搭这条账一起落库**：它渲染在此刻层的任务卡上（`当前任务：…` 后面那一行），
   * 而重放要逐字节重建当时的请求——盘上的清单是她随时会改的文件，"当时挑出了哪几条"只有
   * 事件答得上来（与 `indexHash` 同一条纪律：只记结论，不记清单全文）。
   *
   * 缺省 = 这一轮没有那一行（清单不存在 / 没挑出相关的 / 只有心跳的那一拍 / 老调用点）。
   * 它不是给她的输入（可见性仍是 internal）：真正给她看的是此刻层里那一行本身。
   */
  assets?: string;
  /**
   * **召回账**（阶段二，2026-10-19；可选，`persona.recallEnabled` 关着时整格不出现）。
   *
   * 四态（`state`）各自回答一件不同的事，**只写"没注入"是不够的**：
   *   · `not-triggered` 未触发（`reason` 再细分：没命中词典 / 词典为空（冷启动）/
   *     命中的词刚在上下文里出现过）；
   *   · `no-candidate` 触发但无候选 ⇒ **记忆该写**（话里提到了它，但记忆里没有一条相关的）；
   *   · `truncated` 命中但被预算截断 ⇒ **预算该调**；
   *   · `injected` 正常注入。
   *
   * `hits` 是命中的词典词（可核对"为什么这一轮去回忆了"），`candidates` 是有分的候选条数
   * （与 `injected` 分得开：前者说记忆里有多少相关，后者说推了几条），`tokens` 是实际注入量。
   *
   * internal ⇒ 不进请求体 ⇒ 不改 `RENDER_VERSION`（与 `idleReason` 同一条做法）。
   */
  recall?: {
    state: 'not-triggered' | 'no-candidate' | 'truncated' | 'injected';
    reason?: 'dictionary-empty' | 'no-hit' | 'in-context';
    hits: string[];
    candidates: number;
    injected: number;
    tokens: number;
    /**
     * **指针层**的条数与 token（2026-10-19 第三轮：两级注入的①，与正文分开计量）。
     *
     * 用户的验收线分两条：`a′` = 闲聊轮的指针 token（≤40）、`b′` = U 轮指针里
     * 出现正确条目的比例（≥90%）。这两个数只能靠这一格复算。
     */
    pointer: number;
    pointerTokens: number;
  };
}> {}

/**
 * 一次"按索引指针读记忆"的**访问账**（design §4.17 第 2 条"访问强化"）。
 *
 * **为什么要有它**：§4.17 第 2 条写的是"文件内排序即权重——整理任务把**近期召回命中的**
 * 条目往前提"，但"哪一条被读过、读了几次"这件事在此之前**没有任何地方记**：`tool/call`
 * 里虽然有 `memory_read` 的参数，可那是"她调了哪件工具"的流水，要靠解析工具入参才能
 * 折出访问计数——把排序建在"解析别人的入参"上，等于让整理任务去依赖另一件工具的参数
 * 形状。这条事件是把那份数据放到**fold 能直接消费**的位置上。
 *
 * **只放指针、不放正文**（与 `memory/selected` 同一条纪律）：读到的内容作为**工具结果**
 * 已经留在历史里了，再往事件里存一份就是同一份东西存两遍，而日志是 append-only 的。
 * 这里要回答的问题只有"哪一条、什么时候、被读了几行"。
 *
 * 可见性 internal：它是**账**，不是给她的输入（她这一轮已经拿到正文了，再回一句
 * "你刚读了 facts.md:9"只是把同一件事渲染两遍）。
 */
export interface MemoryRead extends EventEnvelope<'memory/read', {
  /** 归属的 turn（工具在 turn 内执行，所以它落在 turn/start 之后） */
  turn: number;
  /** 相对工作根的 posix 路径（如 `MEMORIES/facts.md`）——与索引里的指针同一写法 */
  path: string;
  /** 条目的起始行号（1 起，与 `safe_read` 回显的行号同一口径） */
  line: number;
  /** 这次一共取了几行 */
  lines: number;
  /** 取到的那一条是不是 `!pinned`（整理时的"重要记忆保护"要用，避免把置顶条目往前提） */
  pinned: boolean;
}> {}

// ──────────────────────────────── 扩展面 ────────────────────────────────

export interface McpServerStarted extends EventEnvelope<'mcp/server-started', {
  name: string; pid: number; tools: string[];
  /**
   * 这次启动时那份工具清单的**名字 + 描述**（2026-10-09 加，评审缺陷 ⑤）。
   *
   * 为什么要多这一格：池在生产上**刻意不拿注册表**（拿了就会把 `mcp__*` 写进 `tools` 段），
   * 于是 `registeredByServer` 只在池内部维护、注册表里一件 MCP 工具都没有 ⇒ 扩展页那三个
   * 字段（`registeredTools` / `toolsCount` / `toolDetails`）**恒为空**，真起过真调过也写
   * "注册工具 0 件"。观测面要的是"它给了什么"，这件事**只有池在启动那一刻知道**，
   * 所以由它经这条 internal 事件带出来（事件不进模型请求，零缓存代价）。
   *
   * 旧日志里没有这一格：读日志的代码必须能读旧形状（`tools` 只有名字）——`mcpView` 两档都认。
   */
  toolDetails?: Array<{ name: string; description: string }>;
  /**
   * 本次启动的耗时（spawn → 握手 + `tools/list`，毫秒）。2026-10-10 加（资源观测）。
   * 旧日志缺这一格 ⇒ 读的人按 null 处理（`mcpView` 就是这么读的）。
   */
  startMs?: number;
}> {}

export interface McpServerStopped extends EventEnvelope<'mcp/server-stopped', {
  name: string; reason: 'idle-reclaim' | 'crashed' | 'shutdown';
  /** 这个进程活了多久（ms）；旧日志缺这一格 */
  uptimeMs?: number;
  /** 整个生命周期里在飞请求的峰值；旧日志缺这一格 */
  inFlightPeak?: number;
  /**
   * 回收前**最后一次采到的** RSS（MB）；没采到就是 null。
   * 口径：它是"最近一次采样"（通常是启动后不久那次），**不是**回收瞬间的内存。
   */
  rssMb?: number | null;
}> {}

/**
 * 资源观测（internal；2026-10-10 加，`src/mcp/client.ts` 的池异步落）。
 *
 * **为什么不塞进 `mcp/server-started`**：RSS 要起一个短命的读数进程（Windows 上是
 * `tasklist`，几十毫秒），塞进启动事件就等于让"启动"这条同步路径去等一个观测。
 * 观测不该拖慢被观测的东西 ⇒ 自己一条事件、异步落。
 *
 * 可见性 internal（走 `defaultVisibility` 的缺省）：它不进请求、零缓存代价；
 * 消费面是 `/api/mcp`（`web/server.ts` 的 `mcpView`）折出来的"谁在吃内存"。
 */
export interface McpServerResource extends EventEnvelope<'mcp/server-resource', {
  name: string; pid: number; sampledAtMs: number;
  rssMb: number | null;
  /** 这个数是怎么来的：`proc`（Linux /proc）/ `tasklist`（Windows）/ `ps` / `unavailable`（没采到） */
  rssSource: 'proc' | 'tasklist' | 'ps' | 'unavailable';
  startMs: number;
  inFlightPeak: number;
}> {}

// ────────────── 工具清单指纹的变化（2026-10-11 加，BUG-3 的观测面） ──────────────

/**
 * **进请求的工具清单换了一版**（internal；`src/runtime/agent-loop.ts` 在构请求处比对指纹）。
 *
 * ──────────────────────────── 它解决的是什么 ────────────────────────────
 *
 * 现场（本机 2026-10-11 03:00:05，seq 78374）：`cacheBreak.class = 'tools'`、`cause =
 * unattributable`、**告警**，而 `tools` 段那次是**真变了**——24 件 → 4 件、5480 → 888 token
 * （−4592）。归因窗口 `(78356, 78370]` 里一条 `mcp/*`、`config/changed`、`skill/*` 都没有，
 * 全 shard 也只有 `mcp/server-started`(78221)、`mcp/index`(78322)、`mcp/server-stopped`(78443)
 * 三条，全在窗口之外 ⇒ 那 20 件工具**被什么摘掉的，日志里一个字都没有**。
 *
 * 根子在"进请求的那份清单"是一个**现取的活值**：`agent-loop` 的 `deriveAt` 每一步都调
 * `registry.listForModel(...)`，而不是从事件里读 ⇒ 只要清单的变化不是上面那四种动作之一
 * （MCP 上下线 / 技能安装 / 配置热更），它在日志里就**天生没有对应事件**。所以这里不比"配置改了没改"，
 * 只比**两拍之间真正进了请求的那份清单本身**：名字集合 + 各自的可见性。
 *
 * ──────────────────────────── 三处纪律 ────────────────────────────
 *
 *   ① **可见性 internal**（`EVENT_VISIBILITY` 里写明，理由与 `mcp/index` 逐字同形）：它是
 *      **装配账**——"这一刻进请求的清单是哪几件"要能事后查，而清单**本身**已经作为 tools 段
 *      进了请求体，再渲染一遍就是同一件事在她眼前出现两遍（纯常驻开销）。
 *   ② **只在真变了时写**：两侧都认得（`before` / `after` 都拿到了）且指纹不同才落一条；
 *      `after` 为空（那份工具表还没接上，例如子代理的隔离视图）时**一个字都不写**——
 *      拿"没接上"当"清单被清空了"，正是观测面伪造事实的那一类错。
 *   ③ **它是 `tools` 段失守的证据**（`context-audit.ts` 的 `inventoryMoved()` 认它）：
 *      缺了它，那一段只能落 `unattributable` 并告警。
 *
 * `added` / `removed` 是**名字**、不是数：现场要回答的问题是"**少了哪 20 件**"，只给
 * `before: 24, after: 4` 的话，人还得自己去两个时刻把清单重建出来对一遍——那正是这次要消灭的成本。
 */
export interface ToolsInventoryChanged extends EventEnvelope<'tools/inventory-changed', {
  /** 上一次写这条账时进请求的件数（指纹里的名字数） */
  before: number;
  /** 这一次进请求的件数 */
  after: number;
  /** 这一次**多出来**的工具名（按进请求的顺序；集合差，重排不算变化） */
  added: string[];
  /** 这一次**少掉**的工具名（现场那 20 件就在这里，一眼看得出少了哪几件） */
  removed: string[];
  /**
   * 指纹的口径（现在是 `name` + 可见性两样）。
   *
   * 为什么要落口径：将来若把描述也折进指纹，旧事件的"没变"与新事件的"没变"就不是同一句话
   * ——读的人得知道这条账是按哪把尺子量的。
   */
  fingerprint: 'name+visibility';
  /**
   * **这一次变化是哪一类**（2026-10-11 加；判据在 `agent-loop.ts` 的 `toolInventoryChangeOf`，
   * 那是唯一看得见两份清单**名字**的地方，所以分类只能在那里定）。
   *
   * 为什么要这一格：`added` / `removed` 只说"少了几件、多了几件"，而**同一种形状可能有三件
   * 完全不同的事**——读账的人拿它决定"要不要去查"：
   *   · `'trust-tier'` —— **信任档换档**（预期内）：两拍分属不同的信任档，清单只发生"父子集"式
   *     的增减。现场就是用户报的那四张卡：`external` 那一档只许 `speak`/`report`/`read_channel`/
   *     `vision_read` 四件，用户/她自己那一档 24 件，来回切时 `tools` 段在两版之间对调。
   *     这是 `render.ts` v44 那篇**有意**写下的取舍，**不是故障**——读账的人看到它就不必再去
   *     翻 `mcp/*` 与 `config/changed`（翻了也没有，本来就不是那两件事）。
   *   · `'mcp'` —— `mcp__*` 那批工具进出清单：MCP 掉线 / 上线。**这是真变化**，要人去查。
   *   · `'registry'` —— 上面两样都不是：工具表本身被换过（注册/注销、禁用开关…）。
   *
   * 与 `visibility` 那两格的分工：那两格是"**当时生效的开关**"（原始输入），这一格是"**据此得出的
   * 结论**"。只落开关不落结论，等于把分类留给每一个事后读日志的人各判一次。
   *
   * **可选**：这一条改动之前写下的账里没有它——读的一侧按 `undefined` = "当时没分类"处理，
   * 绝不当成任何一类（`context-audit.ts` 的 `inventoryTrustShifted` 就是按这个纪律写的）。
   */
  kind?: 'trust-tier' | 'mcp' | 'registry';
  /**
   * 这一刻生效的可见性开关（`agent-loop` 的 `deps.modelVisibility`，缺省 `{}`，原样落库）。
   * 它只影响**哪几件进清单**，所以是上面那份 `added`/`removed` 的注解：落它是为了让
   * "同一批工具、换了一个开关"与"工具表本身换了"能分开读。
   * 两格都缺省（字段不出现）= 那一刻没有开关。`true`/`false` 两种都如实落（不归一）。
   */
  visibility: { includeDestructive?: boolean | string[]; allowOnly?: string[] };
  /** 这一条是哪一轮的第几步（构请求处知道；写在 data 里，重放/复盘时与 turn 归属对得上） */
  turn: number;
  step: number;
}> {}

// ──────────────────────── MCP 常驻索引的快照（2026-10-10 加） ────────────────────────

/**
 * 快照里一个 server 的那一行事实（**写时那一刻**的，不是读时的）。
 *
 * 为什么连这四格一起落进事件、而不是只落渲染好的那段文字：事后要能回答"当时索引里
 * 为什么写的是 3 件工具"。`tools` 与 `toolsFrom` 是同一件事的两半——前者是数，后者是
 * "这个数从哪来"（刚拉的 / 落盘缓存 / 没拿到），只落数不落来源，复盘的结论就会比当时自信。
 */
export interface McpIndexEntry {
  /** server 名（照 `mcp.servers[].name` 原样） */
  name: string;
  /** 配置里写着 `disabled: true`（保留条目但不起进程） */
  disabled: boolean;
  /** 那一刻知道的工具数（`toolsFrom === 'none'` 时是 0，别读成"它一件工具都没有"） */
  tools: number;
  /** 这个数从哪来：`live` = 活连接刚拉的 / `cache` = 落盘清单缓存 / `none` = 都没有 */
  toolsFrom: 'live' | 'cache' | 'none';
  /** `toolsFrom === 'cache'` 时那份清单的取回时刻（epoch ms）；其余为 null */
  cachedAtMs: number | null;
  /**
   * **这个 server 是干什么的**那一句（2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
   *
   * 旧事件**没有这一格**（那时索引行里只有名字 + 状态 + 工具数）⇒ 读的人按"没有那句话"处理，
   * 不许反推、更不许拿 `name` 凑一句。`descFrom` 一起读才读得准：
   *   • `'config'` —— 权威：`config.json` 的 `mcp.servers[].desc`（人或人批过的她写的）；
   *   • `'cache'`  —— **推断**：落盘清单缓存里 server 自报的第一句工具描述（索引行上必须带标注）；
   *   • `'none'`   —— 两处都没有（索引行照实写"配置里没写它做什么"）。
   * 判据与整段理由在 `src/mcp/description.ts` 的文件头（那里是唯一实现）。
   */
  desc?: string;
  descFrom?: 'config' | 'cache' | 'none';
}

/**
 * **MCP 常驻索引的一份快照**（internal；2026-10-10 加）。
 *
 * ──────────────────────────── 它解决的是什么 ────────────────────────────
 *
 * 用户 2026-10-10 的设计原话（逐字）：
 * 「虽然有了入口，但是**还是需要有对应的索引存在**。**mcp 的存在类同 skill**。不过**入口不是
 *  自己读而是我们的统一 mcp 工具**。」「**增删进入上下文的方式依然还是。追加在末，固定位置，
 *  直到上下文重大变化时归集到正确的索引位置。**」
 *
 * 落成两件事，**缺一不可**：
 *   ① **索引常驻**：与技能 catalog 同一类位置（请求头部那段长期记忆层的同一段素材里），
 *      每个 server 一行（名字 + 启用/停用 + 工具数 + 一句"要看它的工具就调 mcp 工具"）。
 *      它只回答"**有哪些 server**"，**一个工具名都不列**——工具清单仍然按需披露
 *      （`mcp` 工具的第二层回执），否则"披露式"就白做了（一份 40 件工具的 server 会把
 *      常驻开销搬回来）。
 *   ② **索引只在重大变化点重建**（"归集"）：增删 server 的那一拍**照旧**走尾部追加
 *      （一条真唤醒，正文进当轮输入），**不动索引那一段的字节**；到下一个重大变化点
 *      （压缩 / 界面 reset 写下的 `compaction/summary`）才用当前配置重建索引。
 *
 * ───────────────── 为什么必须落成事件（这是本类型存在的唯一理由） ─────────────────
 *
 * 若索引每轮都从**实时配置**现渲染，那么"加一个 server"就会立刻改掉请求的**前缀**
 * ——前缀一变，KV 缓存整段失效（本仓库实测口径 ≈9.6 万 token 一轮），而这恰恰与上面
 * 那条"增删只追加在末尾、到重大变化点才归集"的意图相反。
 *
 * ⇒ 索引必须在**重大变化点冻结**。而"冻结"这件事要能被 `render` 看见，就只剩一条路：
 * 它得是**日志里的一条事实**。`render` 是纯函数（缓存铁律 1：不读配置、不读文件、不读时钟），
 * 它只能读事件；把那段文字写进事件之后，"这一轮用的是哪一版索引"与请求体逐字节可复现，
 * 事后（`replay`）也重建得回来——否则重建出来的请求会少一整段。
 *
 * ──────────────────────────── 三处纪律 ────────────────────────────
 *
 * ① **`text` 是逐字节进请求的那段文字本身**（不是"再渲染一次的素材"）。空串 = 那一刻
 *    配置里一个 server 都没有 ⇒ 渲染层**整段不出现**（与技能 catalog 的 null 语义一致）。
 *    存文本而不是"存条目、渲染时再拼"：拼法属于模板，模板改了就得递增 `RENDER_VERSION`
 *    （那正是 `version` 这一格要认出来的事，见下）；存文本之后，"当时是什么字节"与
 *    "现在的模板怎么拼"是两件事，旧快照不会被新模板重新解释一遍。
 * ② **`version` = 写下它时的 `RENDER_VERSION`**。它不是缓存版本号，而是**快照的度量衡**：
 *    渲染模板换了代（`RENDER_VERSION` 变了）⇒ 这份快照与当前模板不是同一把尺子
 *    ⇒ 下一次同步（`real-loop` 的 `mcpIndexSync`）当场重建它，而不是拿旧字节去比新模板。
 *    这一条同时解释了为什么**不需要**为"模板改了"单独写一条重建触发点。
 * ③ **append-only**：快照**只增不改**，永远追加在日志末尾。屏幕上"索引归集到正确位置"
 *    这件事因此不需要改写任何历史——`render` 取**最后一条**快照（它可能在很久以后才出现），
 *    于是"尾部那些追加"自然被新快照覆盖掉语义（那几条 `wake/manual` 仍在历史里，
 *    逐字节不动，这正是"历史不许回改"）。
 *
 * ─────────────────── 什么时候写（`real-loop.mcpIndexSync`，唯一写入点） ───────────────────
 *
 * 判据是"这份快照还代表现在吗"。下面**任一条**成立就重建（并如实写一条新事件）——
 * 这是 `mcpIndexSync` 里 `stale` 的**完整清单**（同序），加判据时必须同时改这一段：
 *   • **首次**：日志里**还没有**任何 `mcp/index`（新进程、或升级上来的老日志）；
 *   • **模板换代**：最后一条的 `version` ≠ 当前 `RENDER_VERSION`；
 *   • **行模板换代**：最后一条的 `descClauseVersion` ≠ 当前 `MCP_INDEX_DESC_CLAUSE_VERSION`
 *     （这一行的拼法变了；它只重建一次——重建出来的带着当前值，下一拍就不再成立）；
 *   • **上下文重大变化**：最后一条的 `seq` **早于**最后一条 `compaction/summary`
 *     （那一刻上下文换过一版 ⇒ 该归集了）；
 *   • **插件组合变化**：最后一条记下的 `pluginRevision` ≠ 当前插件组合摘要——插件隔离/
 *     恢复/卸载会从执行面撤走 server，索引不许还写着已经不能调用的名字（"幽灵 server"）。
 *
 * 空索引另有一支：**首启不写、从非空变空写一条 `text: ''` 的墓碑**（判据与理由在
 * `mcpIndexSync` 的方法头"空配置"那一节；不写会让重建读到上一条非空快照）。
 *
 * 为什么"重大变化点"只认 `compaction/summary`：它是本仓库里**唯一**的"上下文换了一版"的
 * 事实（自动压缩与界面 reset 都写它，人工 `/compact` 也写它），遮蔽点由它唯一确定
 * （`render` 的遮蔽规则）。配置改动**不是**触发点——热更名单今天只有 `mcp.servers` 一项，
 * 而它**刻意不重建本索引**（`config/watcher.ts` 的 `HOT_RELOAD_FIELDS` / `HOT_RELOAD_POLICY`：
 * 声明变化走尾部追加的通报，索引的字节保持不变）；名单外的字段要重启进程才生效，
 * 进程一起就是"配置不动"的那段时间，中间只有工具清单缓存可能被后台刷新；
 * 那件事**必须**走尾部追加、不许改前缀。
 */
export interface McpIndexSnapshot {
  /** 写下它时的 `RENDER_VERSION`（见上：它是快照的度量衡，不是缓存版本号） */
  version: string;
  /**
   * **逐字节进请求的那段文字**。空串 = 那一刻配置里没有 server（渲染层整段不出现）。
   *
   * 为什么全文落事件、而不是像 `memory/selected` 那样只落指纹：那一条的正文（`INDEX.md`）
   * 在盘上另有一份、且**可能很大**（兆字节量级的风险）；这一段是**有界的小文本**
   * （一个 server 一行，server 数是人手配的），而它的**字节本身**就是请求的一部分
   * ——只落指纹的话，重建请求时没人拼得出那几个字节。
   */
  text: string;
  /** 那一刻的 server 事实（审计与复盘的依据，见 [McpIndexEntry]） */
  servers: McpIndexEntry[];
  /**
   * **这一份快照是按哪一版"行模板"写的**（2026-10-11 加；缺这一格 = 第 0 版，即
   * "name —— 状态 + 工具数"那一版，没有 desc 那一截）。
   *
   * 为什么它必须与 `version` 分开：`version` 回答的是"这一串字节是哪一代**渲染模板**写下的"
   * （模板换代 ⇒ 请求体可比性变了 ⇒ `render.ts` 的 `RENDER_VERSION`），而这一格回答的是
   * "这一行**怎么拼**"。两者绝大多数时候一起变，但有一类改动只动后者而**不动模板**：
   * 给索引行补一截（例如这一版加的 `desc`）时，`RENDER_VERSION` 照旧要递（字节真的变了），
   * 可"要不要重建"这件事**只与行模板有关**——分开记之后，`mcpIndexSync` 才能在
   * "行模板换了代、但渲染模板没换"时**也只重建一次**，而不是每一拍都判"旧快照过期"
   * 然后每一拍都重建一遍（那会把索引变成每轮都变的字节）。
   *
   * ⚠ 判据是**双向**的：写的时候要落当前版本，读的时候"缺这一格"要按 0 算
   * （`MCP_INDEX_DESC_CLAUSE_VERSION`，唯一常量在 `persona/assets.ts`）。
   */
  descClauseVersion?: number;
  /**
   * 写下这条快照时的**插件组合摘要**（`PluginRuntimeComposition.revision`，sha256；2026-10-26 加）。
   *
   * 为什么落这一格：它是"这份索引是按哪个执行面写的"的**凭据**。插件隔离/恢复/卸载会从
   * 执行面撤走 MCP server，索引跟着重建之后，排障与重放比对要能回答"当时池里是哪一批"。
   * 它只为可观测：渲染读的是 `text`，这一格**一个字节都不进请求**。
   *
   * ⚠ **老日志没有这一格 ⇒ `undefined`，不许当成"组合为空"**：组合摘要永远是非空 sha256，
   * `undefined` 只表示"这一版没说"，与 `descClauseVersion` 缺省按第 0 版算是同一类兼容处理。
   */
  pluginRevision?: string;
}

export interface McpIndex extends EventEnvelope<'mcp/index', McpIndexSnapshot> {}

/**
 * **技能常驻索引的快照**（internal；2026-10-11 加，与 `mcp/index` 同一套缓存保护）。
 *
 * ──────────────────────────── 它治的是什么 ────────────────────────────
 *
 * 技能 catalog 在此之前是**每 turn 现渲染**的（`real-loop` 的装配处直接问
 * `SkillManager.catalogText()`）。它紧挨着 `instructions` / `tools` 两段常驻前缀——
 * 也就是说：**批准装一个技能 / 删一个技能，下一轮请求的前缀就变了一次**，
 * 从那一刻起整段历史都掉出 KV 缓存（本仓库实测口径 ≈9.6 万 token 一轮）。
 *
 * 用户这一轮的判据：「**skill 索引的进入和退出也要有类似 mcp 的进入和退出那样的缓存保护的机制**」。
 * MCP 那一套（v46）的结论是三条：**索引放在稳定位置**（长期记忆层里紧挨着技能 catalog）、
 * **字节冻结**（只在日志里那条快照上取）、**到重大变化点才归集**（压缩 / reset / 重启）。
 * 这一格就是把技能索引搬进**同一个**机制：与 `mcp/index` 同形状、同一处写入点、
 * 同一组触发点、同一个渲染位置（技能在前、MCP 紧随其后）。
 *
 * ──────────────────────────── 三处纪律（与 `mcp/index` 逐条同形） ────────────────────────────
 *
 * ① **`text` 是逐字节进请求的那段文字本身**（不是"再渲染一次的素材"）。空串 = 那一刻
 *    一个可用技能都没有 ⇒ 渲染层**整段不出现**（`render` 的 `push('skills', …)` 只在非空时出现）。
 * ② **`version` = 写下它时的 `RENDER_VERSION`**：模板换代 ⇒ 旧快照与当前模板不是同一把尺子
 *    ⇒ 下一次同步当场重建，而不是拿旧字节去比新模板。
 * ③ **append-only**：快照只增不改；`render` 取**最后一条**，于是"归集到正确位置"这件事
 *    不需要回改任何历史——此前那些"尾部追加"（申请单结局的唤醒）在历史里逐字节不动。
 *
 * ─────────────────── 什么时候写（`real-loop.skillIndexSync`，唯一写入实现） ───────────────────
 *
 * 与 `mcp/index` 的**同一组**判据（完整清单，同序；加判据时同时改这一段）：① 日志里还没有
 * 快照（首次 / 老日志 / 升级）；② 最后一条快照的 `version` ≠ 当前 `RENDER_VERSION`；
 * ③ 最后一条快照的 seq **早于**最后一条 `compaction/summary`（上下文重大变化 ⇒ 该归集了）；
 * ④ 技能根换代：`SkillManager.packageRevision` ≠ 上次建索引时记下的那个值（插件技能根被
 * 装上/撤走 ⇒ 目录换了，而那批技能由插件包直接放行、不会写 `skill/installed`）。
 * 空索引同样分两种形状：**首启不写、从非空变空写一条 `text: ''` 的墓碑**——不写的话，
 * 重建（`replay` 的 `skillCatalogForReplay`）读到的是上一条非空快照，实时请求里已经不存在的
 * 技能在重建里又冒出来，"同一份日志重建同一份请求"当场作废。
 * **"技能目录变了"刻意不是触发点**：
 * 增删技能要走尾部追加（那条 `wake/manual{via:'grant'}` + 她自己 `safe_read` 正文），
 * 到下一次归集才把那一行进到索引里——否则每加一个技能就改一次前缀，缓存保护等于没做。
 *
 * ⚠ 2026-10-23 起有**两个**写入点，但只有**一份**实现（`skill/index-snapshot.ts` 的
 * `writeSkillIndexSnapshot`）：循环那一支（上面三条判据）与**人工归集**
 * `irmia skill reindex`（"由人发起的一次归集"：信任表修好了、三条判据却一条都不成立时用它）。
 * 两条路写下的 data **逐字段相同**（含键顺序），所以"同一份日志重建同一份请求"照旧成立；
 * `reindex` 不新造事件类型、也不加字段。
 *
 * ⚠ **老日志没有这条事件**（这一版之前写下的轮次）：重建（`replay`）那时**不许**拿它去补，
 * 必须退回当时那条来源（`skillCatalogForRebuild`：同一个 `SkillManager` + 到那一步为止的
 * 信任事件）——否则"同一份日志重建同一份请求"这条承诺当场作废。
 */
export interface SkillIndexSnapshot {
  /** 写下它时的 `RENDER_VERSION`（快照的度量衡，不是缓存版本号） */
  version: string;
  /** **逐字节进请求的那段文字**（`CATALOG_HEADER` + 每个技能一行；空串 = 整段不出现） */
  text: string;
  /**
   * 那一刻进了索引的技能（审计与复盘用：事后要回答"当时索引里为什么有这一行"）。
   *
   * 与 `text` 分开存：文本是请求的一部分（逐字节），事实是给人查的（改了措辞不必动它）。
   * `description` 存的是**截断之后真正进索引的那一句**（同一份字节，不是原文）。
   */
  skills: SkillIndexEntry[];
}

/** 一条进了索引的技能（见 [SkillIndexSnapshot.skills]） */
export interface SkillIndexEntry {
  name: string;
  /** 进索引的那一句（已按单条 token 预算截断；不是 SKILL.md 的原文） */
  description: string;
  /** 这一条的估算 token（`SkillManager.catalog` 算的那一份） */
  tokens: number;
  /** 这一句是被截断过的吗（`true` 时原文更长，正文里才看得到） */
  truncated?: boolean;
}

export interface SkillIndex extends EventEnvelope<'skill/index', SkillIndexSnapshot> {}

export interface SkillInstalled extends EventEnvelope<'skill/installed', {
  name: string; path: string; by: 'agent' | 'human';
  /**
   * SKILL.md 全文的内容哈希（信任门的变更检测凭据）：
   * 确认绑定内容，确认之后又被改动的目录自动退回待确认状态。旧事件可缺该字段。
   */
  contentHash?: string;
}> {}

/**
 * 出厂技能**首次复制到数据目录**的留痕（v79，2026-10-23 现场两条病同源）。
 *
 * ──────────────────────────── 为什么技能要搬家 ────────────────────────────
 * 病①：`SkillManager` 建在 `process.cwd()` 上 ⇒ 技能根 = `<安装根>/skills`；运行环境搬进
 * 安装目录、数据目录另立一处之后，数据目录里一件技能都没有（界面上"没有任何技能"、catalog 0 条）。
 * 病②（更重）：**技能实体住在安装目录里** ⇒ 安装器更新（安装目录被整体替换）⇒ 装的技能全没。
 * 改法：技能实体住在 `<dataDir>/skills/<name>/SKILL.md`（与 `persona/` 同级），安装目录/仓库
 * 里的 `skills/` 退化为**出厂种子**，只在"数据目录里还没有这一份"时复制一次
 * （`skill/seed.ts` 的 `ensureSkillsSeed`）。
 *
 * ──────────────────────────── 为什么这条事实值得一条事件 ────────────────────────────
 * 它解释的是**盘上为什么会多出这几个目录**：下一次启动看到的技能不是人装的、也不是 agent
 * 自沉淀的，而是出厂那份被原样搬过来的。没有这条记录，事后只能靠"内容哈希和安装包里的
 * 一模一样"去猜——而那正是这次事故里最难解释的一句话（"我没装过，它怎么进来的"）。
 * 它同时也是"复制了几件"的唯一凭据：摘要行会随 stdout 滚掉，事件留得住。
 *
 * **它不是信任门**：复制过来的技能照样要 `skill/installed { by: 'human' }` 才进 catalog
 * （内容哈希不变 ⇒ **老日志里那些确认照旧有效**，不需要人重新点一遍——这正是"按内容而不是
 * 按路径"信任的红利）。所以本事件不改变任何裁决，只记事实。
 *
 * 可见性 internal（`EVENT_VISIBILITY` 里写明）：它是**装配账**，不是给她的输入——她知道
 * 自己有哪些技能就够了（catalog），不需要每轮读一遍"这些技能是怎么来的"。
 */
export interface SkillSeeded extends EventEnvelope<'skill/seed', {
  /** 出厂种子根（相对安装根/工作根：`skills`）——不是绝对路径，日志里不该有机器路径 */
  source: string;
  /** 落点（相对 dataDir：`skills`） */
  dest: string;
  /** 复制过去的技能目录名（目录名即技能名，升序） */
  skills: string[];
  /** 复制过去的文件总数（含 references/ assets/ scripts/ 那些随包文件） */
  files: number;
}> {}
export interface PluginInstalled extends EventEnvelope<'plugin/installed', {
  id: string; version: string; contentHash: string; path: string; by: 'human';
}> {}
export interface PluginEnabled extends EventEnvelope<'plugin/enabled', { id: string; contentHash: string }> {}
export interface PluginDisabled extends EventEnvelope<'plugin/disabled', { id: string; contentHash: string }> {}
export interface PluginFailed extends EventEnvelope<'plugin/failed', { id: string; contentHash: string; reason: string }> {}
export interface PluginQuarantined extends EventEnvelope<'plugin/quarantined', {
  id: string; contentHash: string; contributionKind: string; contributionName: string;
  category: string; count: number; retryAt: string; failedAt: string; reason: string;
}> {}
export interface PluginProbeStarted extends EventEnvelope<'plugin/probe-started', {
  id: string; contentHash: string; contributionKind: string; contributionName: string;
  category: string; count: number; probeAt: string;
}> {}
export interface PluginRecovered extends EventEnvelope<'plugin/recovered', {
  id: string; contentHash: string; contributionKind: string; contributionName: string;
  category: string; count: number; recoveredAt: string;
}> {}

// ──────────────────── 申请单：她发起、用户只在界面点批准或驳回（2026-10-11） ────────────────────

/**
 * 她**发起**了一张申请单（internal）。方案稿：`docs/skill-mcp-grant-plan.md` §2。
 *
 * ──────────────────────────── 这条通道解决的是什么 ────────────────────────────
 *
 * 用户 2026-10-11 的原话：「**我希望 skill 和 mcp 都尽量是 agent 自行增删。人类用户只做审批**」。
 * 落成一条五步流水，每一步都有既有形状可用（一处新机制都没造）：
 *
 * ```
 * ① 她发起        写一份**申请单**到 `<dataDir>/grants/<id>.json`（工具入口的回执指路）
 * ② 待批          框架那一拍（`real-loop.settleGrants`）拾取 ⇒ `grant/requested`（本事件）
 *                 + `human/asked{source:'system'}`（她与界面都看得见的那条提问）
 * ③ 用户看        界面把那一条提问摆出来（待批段 / 顶层卡），**只在界面点批准或驳回**
 * ④ 用户点        `POST /api/commands/answer {askSeq, answer:'approve' | 'reject:<理由>'}`
 *                 ——复用既有答复通道（`plan-mode.ts` 的 `answerHuman`），不新开一条
 * ⑤ 框架执行      **框架**按申请单落地（`mcp.servers[]` 走 `withConfigDoc`；技能走回收站那条）
 *                 + 本通道的第二条事件 `grant/resolved` + `wake/manual{via:'grant'}` 叫她一次
 * ```
 *
 * ──────────────────── 三条边界（写在这里，免得下一轮有人放宽） ────────────────────
 *
 * ① **申请单本身不构成任何授权。** 谁能写那个目录谁就能放一张单子进去——所以单子**不是**门，
 *    门仍是人的那一次点击。这一条与"人格提案"那条路同源（提案文件同样不是授权）。
 * ② **她不许直接改 `config.json`**：她只能"申请"。落地那一步由**框架**做，走
 *    `withConfigDoc`（整份文档读出改再写回 → `loadConfig` 复核 → 失败回滚原文 → 文件锁），
 *    且只改 `mcp.servers[]` 那一段。
 * ③ **白名单不因为她申请就放宽**：单子里的 `command` **两面都判**——她发起时判一次
 *    （当场给她一句能读懂的错），框架落地时**再判一次**（单子可能在盘上躺了很久，放行口可能
 *    已经变了）。判据仍是 `parseMcpServers` / `checkStdioLauncher`，一处都没有第二条路。
 */
export interface GrantRequested extends EventEnvelope<'grant/requested', {
  /** 申请单 id（= `<dataDir>/grants/<id>.json` 的文件名，也是 `human/asked` 的 seq 配对对象） */
  id: string;
  kind: GrantKind;
  /** skill = 技能名；mcp = 服务名 */
  name: string;
  /** 谁发起的。今天只有 `'agent'`（人在界面上的动作走既有命令，不经过这条线） */
  by: 'agent';
  /**
   * 内容指纹：`mcp-add` = 那一条 server 声明的规范化指纹（`command` / `args` / `env` / `desc`
   * 五格的 sha256，由 `grant/mcp-grant.ts` 的 `grantContentHash` 现算）；删除类 = 空串。
   * **批准那一刻重算一次**，不一致 ⇒ 这份单子在审阅期间被改过 ⇒ 拒执行（`skipped-stale`）。
   */
  contentHash: string;
  /** 申请单在盘上的落点（相对 dataDir，排障时一眼看得出是哪个文件） */
  path: string;
  /** 她写的一句理由：**为什么想加它 / 为什么该删它**（不可信文本，进卡面前必须洗净） */
  reason: string;
  turn: number;
  /** 人看到的那个问题（= `human/asked.question` 同一串字符串，两处不许各拼一遍） */
  question: string;
  /**
   * 人看到的那段上下（= `human/asked.context` **同一份字节**）。
   *
   * 为什么落进事件而不是让界面自己拼：它是**待批那一段**与**卡面**的同一份素材，
   * 而"这段话里有什么"属于这条通道的口径（风险点、不点会怎样那一句都在里面）。
   * 两处各拼一遍，迟早出现"界面上说他批的是 A、日志说他批的是 B"。
   */
  context: string;
  /**
   * **这条申请单完整的那几格**（2026-10-11：事件就是那张单子的凭据）。
   *
   * 为什么把单子上的字段也落进事件，而不是让界面去读 `<dataDir>/grants/<id>.json`：
   * 这一条事件的用途正是"事后回答**当时申请的是什么**"（方案稿 §4.1 那条判据）。
   * 让 Web 层去读那个文件有两个毛病：① 单子可能在审阅期间被改过（而指纹对不上时
   * **恰恰要拿事件里这一份**去说清"它原来是什么"）；② 那要多一条"读不到文件怎么办"的
   * 分支，而这条路上的每一个分支都得说人话。落进事件之后，`GET /api/grants` 与界面
   * 都**只读事件**——一处真相，没有第二个来源。
   */
  desc: string;
  command: string;
  args: string[];
  /**
   * 环境变量的**键名**（**值一律不落事件**）。
   *
   * 与 `/api/keys` 同一条口径：值里可能有密钥，而事件是会被界面摆出来、被人读的东西。
   * 键名足够回答"它会拿到哪些环境变量"这个问题（详情那段话里也只有键名）。
   */
  envKeys: string[];
  /** 申请单里写着 `enabled: false`（加进去但不起进程） */
  disabled: boolean;
  /**
   * **技能那一支的摘要**（`kind` 是 `skill-*` 时才有；2026-10-11 第二笔加）。
   *
   * 正文与随包文件**不进事件**（可能几十 KB）：事件里只落"指纹 + 摘要"，
   * 内容是 `<dataDir>/grants/<id>.json` 那份申请单里的事。这四格够卡面把风险说清：
   *   · `description` —— frontmatter 那一句（技能**唯一**的触发机制）；
   *   · `bodyBytes`   —— 正文多少字节（`SKILL.md` 那一份，不含 frontmatter）；
   *   · `fileCount`   —— 随包带几个文件；
   *   · `scriptNames` —— **`scripts/` 下那些可执行内容的名字**（方案稿 D8：卡面上单列一行）。
   *     "装技能 = 引入可执行内容"在本机不是假设（`skills/anysearch/scripts/` 里真有一批脚本）。
   */
  skillDescription?: string;
  skillBodyBytes?: number;
  skillFileCount?: number;
  skillScriptNames?: string[];
  /**
   * 挂起它的是哪一条 `human/asked`（**拾取那一刻**就知道了，所以这一格是必填）。
   *
   * 有它 `GET /api/grants` 才配得上"这张单子的卡超时了没有"，也才认得出"人答的是哪一张"。
   * 老事件（2026-10-11 的这一天之内）没有这一格 ⇒ 读的人按 null 处理（当"配不上卡"），
   * **不许**按问题文本去猜。
   */
  askSeq: number;
}> {}

/**
 * 这张申请单的结局（internal）：**人的决定**与**框架执行的结果**分开记。
 *
 * 为什么非要把执行结果也落成事件（而不是"批准=写文件、失败就 500"）：这条通道的落地是**两步**
 * （技能要建目录再写文件；MCP 要改配置再复核），"批了、但没装成"是一个真实存在的结局。
 * 没有这一格，日志会替框架说一句假话——「批准了」读起来像「装上了」（方案稿 §4.1 那条判据）。
 *
 * 幂等靠**事件状态**而不是内存记账：`human/answered` 已经把那张 `human/asked` 出队了，
 * 第二次点批准在 `answerHuman` 那一步就撞「askSeq 不在台面上」⇒ 不会重复落地。
 */
export interface GrantResolved extends EventEnvelope<'grant/resolved', {
  id: string;
  /** 答复的是哪一条 `human/asked`（精确配对，照 [HumanAnswered.askSeq]） */
  askSeq: number;
  kind: GrantKind;
  name: string;
  outcome: 'approved' | 'rejected';
  /** 谁批的（今天恒为 `'human'`） */
  by: string;
  /** 驳回理由。**批准时为 null**；驳回时允许为空串（界面给输入框但不强制填） */
  reason: string | null;
  /**
   * 这一份内容的指纹。
   *
   * 正常结局（人批/人驳）= 批准那一刻**重新算**的请求指纹（与 `grant/requested.contentHash`
   * 不一致 ⇒ `stale`）。**框架当场退回**（`by:'framework'`，判不过 / 重复递单）也写这一格：
   * 写的是那一份被退回内容的指纹（坏文件写文件文本的指纹）——它是**退单幂等**的唯一判据
   * （同一 id 同一指纹退过就跳过；2026-10-21 修，之前每拍再退一条，实测 33 条）。
   */
  contentHash: string;
  /**
   * 框架执行的结果——**这一格是"批了但没装成"与"批了装成了"的分界**。
   *   • `ok`              —— 真落地了（`landed` 那一格说落在哪）；
   *   • `failed`          —— 试了但没成（`failure` 说清为什么）；
   *   • `skipped-stale`   —— 内容在审阅期间被改过，**拒执行**（照人格提案的 `stale-proposal`）；
   *   • `skipped-invalid` —— 落地复核（白名单/名字/存在性）没过，拒执行；
   *   • `not-applicable`  —— 驳回：它压根没有被执行（这一格让"驳回"与"批准但失败"读得开）。
   */
  exec: {
    state: 'ok' | 'failed' | 'skipped-stale' | 'skipped-invalid' | 'not-applicable';
    /** `state !== 'ok'` 时那句话说清楚（进回执，也进她下一拍的上下文） */
    failure?: string;
    /** 真落地的东西：`mcp-add` = server 名；`mcp-remove` = 被移除的名字 */
    landed?: string;
  };
}> {}

/** 申请单能做的四件事（skill 那两件是同一套形状的第二笔，见方案稿 §2.1 与 §8） */
export type GrantKind = 'mcp-add' | 'mcp-remove' | 'skill-install' | 'skill-remove';

export interface HookFired extends EventEnvelope<'hook/fired', {
  hook: 'PreToolUse' | 'PostToolUse' | 'Wake';
  outcome: 'ok' | 'timeout' | 'error';
  pluginId?: string; contentHash?: string; contributionName?: string;
}> {}

export interface SpeakSent extends EventEnvelope<'speak/sent', {
  channel: 'log' | 'notify' | 'reply-url'; chars: number;
  /**
   * 投递到了哪个会话（`log` 路不带：那是本机对话流，没有会话 id）。
   *
   * 与 `text` 一起构成 `read_channel` 认得的那一条凭据：`sid` 说"发到哪儿"、`text` 说"说了什么"。
   * 旧事件只有 `sid`（那时它只用于复盘"她跟谁说过话"）。
   */
  sid?: string;
  /**
   * 这一次发言的**完整文本**（2026-10-04；只有真的发进了某个会话的那一条回执带它）。
   *
   * 为什么非要落在事件里（`read_channel` 的"她自己说过什么"就靠这个字段）：切分是**投递**的
   * 属性，不是内容的属性——一次 `speak` 会被 `chat-split` 切成 N 条气泡，而每段的内容分别在
   * 各自的 `message/assistant` 里、**不带任何会话坐标**。没有这个字段，read_channel 就只能
   * 拿着"本机对话流里的一段话"去猜它发到了哪个会话（`to` 为空时从唤醒派生，逐段对不上）。
   *
   * 为什么挂在 `speak/sent` 上而不是新开一个事件类型：这条回执本来就是"这一跳投递成功了"的
   * 凭据，而它已经带 `sid`（跟谁说过话）——补上"说了什么"是把同一条回执说完整，不是新事实。
   * 新增事件类型要同时动 `AppEvent` 联合、可见性表、fold/重放与 schema 文档，代价大得多，
   * 而语义上并没有多出第二个事实（`sid` 与 `chars` 早在里面了）。
   *
   * **可选**：旧日志没有它——那些发言读不回来（read_channel 只能列"从现在起"的发言），
   * 这不是缺陷，是"日志只增不改"的必然：当年就没记的东西，今天推不出来。
   *
   * 为什么只有**投递成功**的那一条带文本：`channel='log'` 是逐段落的"本机对话流"回执，
   * 它不代表"这话真到了那个会话"（本机那条路永远可用）；`reply-url` 才代表 IM 那一路走通了。
   * 失败/被拒/没接线的发言**不写**它——那种时候"她说出去了"是假的（见 tools/admin.ts）。
   *
   * **2026-10-07：`report` 的正文出站也走这一条**（原来它漏了这个字段）。缺失的代价不是
   * "少一个字段"，而是用户报的那个现象——她 report 完去翻会话，**自己刚报告的那一篇不在
   * `（我）`那一行里**，于是她以为没发出去、再发一遍。判据现在收在 `tools/admin.ts` 的
   * `deliverToSession` / `deliveredToSid` 一处（产生侧与消费侧引同一个实现），
   * `send_media` 也在内（那边的文本是 `［图］` 这类可读摘要）。
   *
   * **待办（2026-10-12 已还）**：本文件头一行写着"修改事件形状必须先改 schema 文档"，
   * 而 `docs/schema.md` 里 `SpeakSent` 一度停在旧形状（`sid?` / `text?` / `spokenParts?` /
   * `turn?` 都还没补）。本次按纪律**已把那一份连同新加的 `messageId?` 一并补进文档**，
   * 这笔待办销掉。
   */
  text?: string;
  /**
   * 这条完整文本在 IM 上被切成了几条气泡（1 = 一次说完）。
   *
   * 它给 `read_channel` 用：她的发言在那边**不切分**（一行一条，省行数），所以行上必须能
   * 说清"这其实是 N 条"——否则她读回来会以为那三句是自己一口气打出来的。
   */
  spokenParts?: number;
  /**
   * 这是**哪一次工具调用**发的（`tool/call.callId`）。
   *
   * 为什么要有它：`read_channel` 要把"一次 speak = 一行"这条要求落准，而"同一 turn 里说了两段"
   * 与"一段被切成两条气泡"在事件上长得一样。仓库里"一次调用"的本征标识就是 `callId`
   * （与 `tool/call` / `tool/result` 同源），用它归并既准又不用另造一个概念。
   */
  callId?: string;
  /** 产生这次发言的 turn 号（复盘用；旧事件没有） */
  turn?: number;
  /**
   * 平台回的**这条消息自己的 id**（2026-10-12 补；来自通道层的 `SendOutcome.messageId`，
   * 经 `tools/admin.ts` 的 `deliverToSession` 落进来）。
   *
   * 为什么要落它：`get_msg` / `delete_msg` 只认平台 `message_id`，而这条回执原先**没有它**
   * ——那个 id 在适配器里就被窄化丢掉了（`onebot.ts` 的 `createOneBotReplyPoster`
   * 只回 `{ok, status}`）。后果是**她删不掉"自己刚发的那条"**：实测 T1308 那一轮，
   * 她扫了两遍原始 jsonl 才凑出 id（事件 77500 那一步），而她自己在事件 77386 里写着
   * 「我发出去的消息——speak/sent 事件里没有 messageId」。
   *
   * **可选**：旧日志没有它，通道也可能给不出（协议端不回 id）——那时 `read_channel` 的
   * `（我）`那一行少一格 `·m<id>`，照旧读得出来。与 `text` 同一条先例：
   * "这不是缺陷，是'日志只增不改'的必然"。
   *
   * 一次发言被切成 N 条气泡时这一格记的是**第一条**（一行一个位置，锚落在她开口的第一条上）。
   */
  messageId?: string;
}> {}

export interface IntentionRaised extends EventEnvelope<'intention/raised', {
  intentionId: string; content: string; triggerAt?: string; condition?: string;
}> {}

export interface IntentionActed extends EventEnvelope<'intention/acted', {
  intentionId: string; turn: number;
}> {}

/**
 * `todo/updated` —— 清单**写进 STATE 两节**的同一拍，记一笔"写的是哪一份"。
 *
 * 2026-10-04 的合并（用户：「state……甚至就应该取代 todo」→「或者说合并」）之后，这条事件的
 * 地位与 `memory/selected` 类似：**它是账，不是载体**。
 *   • 载体：`STATE.md` 的「## 当前任务」/「## 接着干」两节（`persona/todo-state.ts`）；
 *   • 任务卡（此刻层 `未完成计划：`）从**载体**读，不从这条事件读；
 *   • 那为什么还写它：① 旧日志里"她当时的清单"只有这一条线索（那时没有 STATE 快照），
 *     读旧账、回放旧请求都要它；② 观测/界面要能回答"最近一次写入是哪一份"。
 *
 * 可见性 `internal`（不进上下文）：进她上下文的是 STATE 那两节本身。
 */
export interface TodoUpdated extends EventEnvelope<'todo/updated', {
  items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
}> {}

export interface JobStarted extends EventEnvelope<'job/started', {
  jobId: string; command: string; turn: number;
}> {}

export interface JobFinished extends EventEnvelope<'job/finished', {
  jobId: string; exitCode: number | null; outputRef?: string;
}> {}

/**
 * 谁在问（design §6「一张卡，三种来源」落在事件层的两种；第三种"引导"走向导，不落这条线）。
 *
 *   · `system` —— 框架自己问的：目前唯一写入方是计划模式的待批准（question 是固定常量）。
 *     它**挂起 turn**（`turn/end{blocked, by:'ask-human'}` → 答复后重入队）。
 *   · `agent` —— **她问的**（`ask_human` 工具）。它**不挂起**（design §6.5：旧实现错在"等"，
 *     不在"问"）：她写完这条就接着做自己的事，人的答复在下一拍的状态里看到。
 *
 * 缺省按 `system` 读——旧日志里唯一的写入方就是计划模式，重放必须还原成当时那个含义。
 */
export type HumanAskSource = 'system' | 'agent';

/** 来源判定（旧事件没有该字段 = 当时的计划模式）：fold / 渲染 / 挂起判定共用这一份，不各写一套 */
export function humanAskSourceOf(data: { source?: HumanAskSource }): HumanAskSource {
  return data.source === 'agent' ? 'agent' : 'system';
}

export interface HumanAsked extends EventEnvelope<'human/asked', {
  question: string; context: string; turn: number;
  /** 见 [HumanAskSource]；缺省 = 'system'（旧事件） */
  source?: HumanAskSource;
}> {}

export interface HumanAnswered extends EventEnvelope<'human/answered', {
  question: string; answer: string; by: string;
  /**
   * 答复的是哪一条 `human/asked`（那条事件的 seq）。
   *
   * 为什么要有它：台面上可能同时摆着她的提问与一条待批准的计划，FIFO 配对会把"人答的那条"
   * 认成另一条（提问文本也不可靠——计划审批的 question 是同一个常量）。给了它就按它精确配对；
   * 旧事件与 CLI 不带它，退回 FIFO（当时的唯一情形就是只有一条挂着）。
   */
  askSeq?: number;
}> {}

/**
 * 她问的人一直没答（design §6.1：**超时不产生决定，只产生事实**）。
 *
 * 这条事件说的是「**未批准、未拒绝**」——不是拒绝，更不是批准：没有任何一方替人做决定。
 * 她把这件事读成"人可能不在机器旁，或没注意到"，**要不要换个方式找人（例如走 QQ）是她自己的
 * 判断**，框架不替她降级成"那就算了"。卡片本身仍然有效：人回来照样能答（会落 human/answered）。
 *
 * 为什么单开一条类型而不是拿 `human/answered` 顶替：那等于往唯一真相源里写"人答过了"这句假话；
 * 也不能写成 `plan/resolved{expired}`——那条是计划审批的簿记（要 callId/指纹），与提问无关。
 */
export interface HumanExpired extends EventEnvelope<'human/expired', {
  /** 超时的是哪一条 human/asked（seq） */
  askSeq: number;
  question: string;
  turn: number;
  source: HumanAskSource;
  /** 从提问到落这条事实等了多久（毫秒）；timeoutMs 是当时的判定线 */
  waitedMs: number;
  timeoutMs: number;
}> {}

/**
 * **人审挂起超时：框架按"未获批准"处置，并让她继续**（2026-10-22；internal）。
 *
 * 为什么必须是一条自己的事件，而不是拿 `human/expired` 顶替：那条说的是**时间到了**
 * （"人可能不在"，卡仍然有效、人回来照样能答）；这一条说的是**框架把这件事办完了**——
 * 那条待答被作废、挂起解除、她手上的活重新回到队列。两件事分得开，日志才答得出
 * "那天为什么她突然又动起来了"。
 *
 * 与 `human/expired` 的关系：超时那一刻两条一起写（先 expired 记事实，再 timed-out 记处置），
 * 于是"她被告知人可能不在"（§6.1）与"框架没有替人做决定"（§6.1 的另一半）同时成立。
 *
 * 为什么不再写 `budget/exhausted{layer:'task'}`（2026-10-22 拆掉的行为，用户原话
 * 「不要有这种玩意」）：那条暂停会把**整个 agent** 的唤醒门关掉——一次没人答的提问
 * 变成"她再也不干活"。超时的正确后果是这一条：**这件事没被批准，所以它不执行**，
 * 而不是"整台机器停下来等人"。
 *
 * visibility 一律 internal：它是处置的**簿记**；她该看见的是紧随其后的重入队输入
 * 与 `human/expired` 那条事实（model 可见）。
 */
export interface HumanTimedOut extends EventEnvelope<'human/timed-out', {
  /** 超时的是哪一条 human/asked（seq） */
  askSeq: number;
  question: string;
  /** 从提问到落这条处置等了多久（毫秒）；与 `human/expired.waitedMs` 同一个数 */
  waitedMs: number;
}> {}

/**
 * 计划模式：一件 destructive 调用被挂起等人工批准（design.md §4.21「事前」人审）。
 *
 * 它**不写 tool/call 也不写 tool/result**（与 PreToolUse 钩子拒绝同一纪律：没执行的调用不进
 * 两阶段落库，写进去就是「日志说她试过了」）。项目里三条人审通道的分工：
 *   • `plan/pending` —— 事前：还没动手，等批准；
 *   • `tool/result{unknown}` —— 事后：动过手但结局不明，等定性（needsReview）；
 *   • `human/asked` —— 事中：正在做的过程中需要人给一个只有人知道的信息。
 */
export interface PlanPending extends EventEnvelope<'plan/pending', {
  callId: string;
  tool: string;
  /** 原始 arguments 文本：批准后模型按同一份参数重发，指纹匹配凭它 */
  arguments: string;
  turn: number;
  step: number;
}> {}

/**
 * 计划结案：批准 / 拒绝 / 超时。
 * `approved` 会把指纹写进投影的 planApproved（一次执行许可），该许可在对应工具调用真的
 * 落进 `tool/call` 时被消费掉——批准一次只放行一次，不会变成永久开关。
 */
export interface PlanResolved extends EventEnvelope<'plan/resolved', {
  callId: string;
  tool: string;
  /** 调用指纹（`planFingerprint(tool, arguments)`）：批准后的通行证凭它匹配重发的调用 */
  fingerprint: string;
  outcome: 'approved' | 'rejected' | 'expired';
  by: string;
  note?: string;
}> {}

/** 模型降级链状态变化（internal；投影 degraded 字段的事件源） */
export interface ModelDegraded extends EventEnvelope<'model/degraded', {
  lane: ModelLane; reason: string;
}> {}

export interface ModelRestored extends EventEnvelope<'model/restored', {
  lane: ModelLane;
}> {}

/**
 * **协议切换的留痕**（2026-10-21，协议回退 C-3）。internal：它是审计账，不是给她的输入。
 *
 * 为什么单独一种事件而不塞进 `budget/consumed`：一次切换要能在"没有请求成功"的情况下也留痕
 * （两个协议都不通时那一拍根本没有 `budget/consumed`），而"切换"与"一次调用"不是一对一
 * （一次调用可以先 404、再用 Chat 成功 ⇒ 那次调用只有一个 `budget/consumed`，但有一次切换）。
 *
 * 字段口径：
 *   · `lane` / `model`：发现时的 lane 与模型（"哪条 lane 的哪个模型在哪个端点上不支持"）；
 *   · `from` / `to`：协议身份（`'unavailable'` = 两条路都判成不支持）；
 *   · `criterion`：凭什么切的（判据的**哪一条**，唯一实现在 `model/transport/registry.ts`）；
 *   · `evidence`：判据的证据（**端点 url** + 状态码 + 正文片段 ≤200 字符 + 错误码），
 *     **不含密钥、不含完整正文**；
 *   · `firstSeenAt`：这个端点**第一次**被观测到不支持的时刻（RFC3339）。
 * 它**不折投影**、不进她的上下文 ⇒ 不动 `RENDER_VERSION`。
 */
export interface ModelProtocolSwitched extends EventEnvelope<'model/protocol', {
  lane: ModelLane;
  /**
   * 发现这一刻用的模型 id（`SwitchDecision.model`）。
   *
   * 为什么必须有它（2026-10-21 补）：`criterion` + `evidence.status` 只回答"这个**端点**不支持
   * Responses"，答不出"**哪一个模型**在那个端点上不支持"——而同一 baseUrl 上 heavy/light 可以
   * 是两个模型，事后要判断"要不要给这条 lane 换端点"就必须有这一格（设计 §6.2）。
   */
  model: string;
  from: 'responses' | 'chat-completions';
  to: 'responses' | 'chat-completions' | 'unavailable';
  criterion:
    | 'http_404' | 'http_405' | 'http_501' | 'html_body' | 'missing_output_shape' | 'error_names_endpoint'
    | 'chat_http_404' | 'chat_adapter_fault';
  /**
   * 判据的证据。`url` 是**端点**（`baseUrl`，已去尾斜杠）——2026-10-21 补：
   * 只记 `status`，账本答不出"**哪个 baseUrl** 不支持"，而"填错了 baseUrl"正是 `unavailable`
   * 那一档最常见的原因（设计 §6.2 的 evidence 本来就有这一格）。
   */
  evidence: { status: number | null; url: string; bodySnippet: string | null; errorCode: string };
  firstSeenAt: string;
  decidedAt: string;
}> {}

/**
 * **模型切换的留痕**（2026-10-26，缓存告警分桶的配套；internal）。
 *
 * 为什么要单独一条事件（用户的指示："模型切换本身要落一条事件"）：
 * `budget/consumed.model` 每拍都有，**"换过模型"这件事本身**却只能靠人逐条比对才看得出来。
 * 而缓存命中率是**按模型分账**的（`runtime/cache-alert.ts` 的窗口 = 同一 model 的最近 20 轮）——
 * 读告警的人要能一眼回答"这个窗口里换过模型吗、什么时候换的"。有了它，
 * 窗口边界与那条 `budget/cache-alert` 的时间点在同一行日志里就对得上。
 *
 * 为什么不是塞进 `budget/consumed`：切换与"一次调用"不是一对一（一次切换之后的第一拍才带新
 * model），而"切换发生了"这件事在**没有新调用**时也可能成立（配置改完还没跑活）。
 *
 * `from` 取的是**日志里这一条 lane 上一拍的模型**（不是内存里的配置值）：只有它才是
 * "缓存窗口真正从哪个模型切到哪个模型"的那个 from。
 *
 * 可见性 internal、不折投影、不进请求体 ⇒ 不动 `RENDER_VERSION`。
 */
export interface RuntimeModelSwitch extends EventEnvelope<'runtime/model-switch', {
  lane: ModelLane;
  /** 切换前这一条 lane 最后用过的模型（日志里上一拍 `budget/consumed.model`） */
  from: string;
  /** 这一拍起用的模型 */
  to: string;
  /**
   * 切换被观测到的时刻（RFC3339）。**与信封 `ts` 同源**——写进载荷是为了
   * `grep '"type":"runtime/model-switch"'` 一行就读得到，不必回头看信封。
   */
  ts: string;
}> {}

/**
 * 思维链回传的**一次处置**（v73；internal，纯观测）。
 *
 * 两种 `kind`，同一张账——它们是同一件事的两面，所以放一个事件类型里，免得"读日志要查两处"：
 *   · `'reasoning_echo_prune'` —— 装配时撞了硬上限（或发现半截状态）⇒ **整组丢**：
 *     丢了几条、哪些 seq、多少字符、撞的是哪个上限。这是"这一拍为什么少了哪几条"的唯一答案；
 *   · `'reasoning_echo_fallback'` —— 服务端回了"reasoning_text 没回传"的 400 ⇒ 用**全量、
 *     连硬上限都不设**重建请求再发一次（**只一次**）。`released` 是这次自救**放开的条数与字符数**，
 *     `echoed` 是第二次请求实际回传的读数，`original` / `failed` 是两次服务端原话。
 *
 * 为什么它该进日志而不是只打一行 stdout：这是"请求里少了什么、为什么少"的**唯一现场**，
 * 而事后复盘只有事件日志（与 `tools/inventory-changed` 同一条纪律）。
 *
 * 它**不进请求体**（`renderEvents` 的 `default` 分支不认它）⇒ 不改任何请求字节、
 * **不动 `RENDER_VERSION`**——那一代的版本号是为"回传集合变了"递的，不是为这条账。
 */
export interface ModelReasoningEcho extends EventEnvelope<'model/reasoning-echo', {
  turn: number;
  step: number;
  /**
   * 三种 `kind`：
   *   · `'reasoning_echo_prune'` / `'reasoning_echo_fallback'` —— 见上面那段（v73）；
   *   · `'reasoning_echo_pressure'` —— **前兆告警**（2026-10-21/22 加）：`回传字符 / 上限`
   *     已经 ≥ 90%，**再长下去就会开始驱逐**。它不描述一次"处置"，而描述"即将被迫处置"，
   *     所以它另带一格 {@link ModelReasoningEcho.pressure}，其余字段一概不填
   *     （`turn`/`step` 照写，`step` 取本轮最后一步；判据与文案在
   *     `runtime/reasoning-echo-pressure.ts`）。
   *
   * 为什么复用本事件而不是新开一种：用户点名的那条根因（2026-10-21 只读审计、零反例）
   * 就是"回传字符顶穿 `REASONING_ECHO_POLICY.maxTotalChars`"——**同一件事的前兆**长在
   * 同一张账上，`cli tail` 读起来才是"先看到压力、再看到驱逐、再看到账单"，而不是三条互不相认的线。
   */
  kind: 'reasoning_echo_prune' | 'reasoning_echo_fallback' | 'reasoning_echo_pressure';
  /**
   * `'reasoning_echo_pressure'` 的读数（其余两种不写这一格）。
   *
   * 口径（**一个数一个来源，不许凑**）：
   *   · `echoChars` = **会回传的总字符**（= 真回传的 `keptChars` + 已被挤掉的 `droppedChars`）。
   *     它才是"在往上限上撞"的那个数——一旦开始驱逐，`keptChars` 会被压回上限以内，
   *     拿它当压力读就会**在真正出事的那一刻变好看**（这正是这类告警最常见的失效形状）；
   *   · `keptChars` / `droppedChars` / `droppedGroups` = 当前渲染口径（`reasoningEchoPlan`
   *     配出厂策略）实际留下的与已挤掉的；
   *   · `evicted` = **本轮**有没有落过 `kind:'reasoning_echo_prune'`（"本轮"取自日志里最后一条
   *     `turn/end` 的轮号，不是进程内存——重启之后同一个事实照样读得出来）；
   *   · `band` = 去重档位（5 个百分点一档、**100% 封顶**）：封顶是刻意的，否则驱逐一旦开始，
   *     `echoChars` 会随历史只增不减地涨，档位一路上爬 ⇒ 每几分钟报一条，正好变成用户骂的"刷屏"。
   */
  pressure?: {
    /** 会回传的总字符（kept + dropped） */
    echoChars: number;
    /** 实际回传的字符（撞上限之后 ≤ `cap`） */
    keptChars: number;
    /** 那一刻生效的上限（`REASONING_ECHO_POLICY.maxTotalChars`） */
    cap: number;
    /** `echoChars / cap`，4 位小数 */
    ratio: number;
    /** **本轮**是否已发生驱逐 */
    evicted: boolean;
    /** 当前口径下被挤掉的组数 */
    droppedGroups: number;
    /** 当前口径下被挤掉的字符数 */
    droppedChars: number;
    /** 去重档位：`min(floor(ratio / 0.05), 20)` */
    band: number;
  };
  /** `prune`：这一次丢掉的 assistant 组（按 seq 升序） */
  dropped?: Array<{
    /** 这组的 assistant 事件 seq（没有就是 null） */
    assistantSeq: number | null;
    /** 这组丢掉的思维链 seq */
    reasoningSeqs: number[];
    /** 丢掉的思维链正文字符数 */
    chars: number;
    /** 这一组一共移出了几个 input item */
    items: number;
    /**
     * 为什么丢：撞了哪个上限，或者是"半截状态"（有思维链事件但原文为空 / 补不回）。
     *
     * 2026-10-21 起**没有 `'maxItems'`**：那个"最多 N 条"的旋钮连同判据一起删了（服务端判的是
     * 位置，不是条数；见 `src/model/render.ts` 的 `ReasoningEchoPolicy`）。历史日志里可能还留着
     * 它（v68–v75 的事件）——读侧把它当 legacy，**不再产生**。
     */
    why: 'maxTotalChars' | 'half-state';
  }>;
  /** `prune`：被补回的思维链 seq（正常渲染恒空；半截输入被修正时才有） */
  restored?: number[];
  /** `prune`：被删掉的孤儿 thinking item 数（没有事件来源的那种） */
  orphanItems?: number;
  /**
   * `prune`（v74）：因为没有配对 reasoning 而**整条没发**的 assistant 正文。
   *
   * 来源只有一种真实形态：`speak` / `report` 工具写的那一段（`origin:'main'`，事件里没有
   * turn/step、没有任何 reasoning）。它留在请求里就是 400 的一种形状（现场：最新那份请求
   * 133 条 assistant 消息里 112 条是它）⇒ v74 起正文整条不发，**这里记下丢了哪几条、多少字**。
   */
  orphanAssistants?: Array<{ seq: number; chars: number }>;
  /**
   * `prune`（**v75 的③：观测补课**）：这一轮**一共几步**报过"请求里少了/多了什么"。
   *
   * 为什么必须有这一格（2026-10-21 凌晨那场，读数逐条）：旧写法是**一步一条、一步只写一条**
   * （`TurnRunner.reasoningEchoTraced` 那道锁），而 step 1 的修复里几乎总有
   * `orphanAssistants`（`speak`/`report` 写的那段正文）⇒ **那一格被 step 1 用掉**，
   * 之后每一次"挤掉最老的组"**都不留痕**（现场 46 条 prune 事件里没有一条带 `dropped`）
   * ⇒ 事后只能把那个小时的 92% miss 归成 `cause:"unattributable"`。
   * v75 起这一条账**在轮收尾写一次**（`TurnRunner.flushReasoningEchoTrace`），
   * 而每一步的读取都并进 {@link ModelReasoningEcho.totals}——`steps` 就是"并了几步"。
   */
  steps?: number;
  /**
   * `prune`（**v75**）：这一轮**累计**的处置账（**不是只有第一步那一条**）。
   *
   * 一 turn 仍然只有一条事件（理由：每步一条就是刷屏，见 `reasoningEchoTraced` 那段），
   * 但**内容**是整轮的并集 + 累计：`dropped`/`restored`/`orphanAssistants` 是各步的**并集**
   * （按 seq 去重、按 seq 升序），`orphanItems` 取各步的**最大值**（同一份输入每步都数出同一个数，
   * 求和会把它乘上步数），`droppedChars`/`droppedItems` 是并集里各组的和。
   *
   * 读法：`totals.droppedGroups` / `totals.droppedChars` 就是"这一轮一共挤掉几组、多少字符"
   * ——那正是 v75 之前读不出来的两个数（用例：`test/agent-loop.test.ts` 的 ⑧、
   * `test/reasoning-echo.test.ts` 的 ⑦丙）。
   */
  totals?: {
    /** 并进来的步数（= {@link ModelReasoningEcho.steps}，两处同值，读起来不必二选一） */
    steps: number;
    /** 这一轮挤掉的**不同组数**（并集大小） */
    droppedGroups: number;
    /** 这些组一共移出了几个 input item */
    droppedItems: number;
    /** 这些组的思维链正文字符数之和 */
    droppedChars: number;
    /** 补回的思维链条数（并集大小） */
    restored: number;
    /** 删掉的孤儿 thinking item 数（各步最大值） */
    orphanItems: number;
    /** 整条没发的 assistant 正文条数（并集大小） */
    orphanAssistants: number;
    /** 那些正文一共多少字符 */
    orphanAssistantChars: number;
  };
  /**
   * `prune`（**v75**）：这一轮留下的回传总量**顶破**总字符硬上限多少字符（缺席 = 没顶破）。
   *
   * v75 起驱逐边界**在本轮之内不动**（见 `render.ts` 的 `ReasoningEchoPlan.anchorSeq`），
   * 本轮自己新写的思维链照旧全量回传 ⇒ 总量可以在轮内被推过 300K。这是故意的取舍
   * （推一次边界 = 整段前缀 miss 一次），但账要认：这一格与压缩那条新判据
   * （`compaction/decision.trigger = 'echo-chars'`）读的是同一个量。
   */
  overChars?: number;
  /** `fallback`：这次自救放开的量（全量 − 原请求） */
  released?: { items: number; chars: number };
  /** `fallback`：第二次请求实际回传的读数 */
  echoed?: { items: number; chars: number };
  /** 服务端原话（截断到 500）：第一次那条 400 */
  original?: { code: string; detail: string };
  /** 服务端原话（截断到 500）：第二次若也失败 */
  failed?: { code: string; detail: string };
}> {}

/**
 * 「最后一条 user 之后」那一段的**一条**（`ModelRejectRecord.region` 的元素）。
 *
 * 为什么是这几个字段、为什么这么少：
 *   · `type` / `role` —— 服务端判的就是**形状**（v74–v77 的 400 全是"区段第一格是 assistant
 *     正文 / 裸 `function_call` / 思维链缺"）；这两格就是形状的骨架；
 *   · `seq` —— **能精确对上**时指回源事件（今天只有工具 item 凭 `call_id` 对得上）。
 *     **缺 = 指不回去**，不是"没有源事件"（渲染层会合并/改写/补回，事件与 item 不是一一对应）；
 *   · `preview` —— 脱敏后的 ≤40 字符**单行**线索（不含图片 base64、token、绝对路径），
 *     口径唯一实现在 `model/reject-record.ts` 的 `rejectPreviewOf`。
 *
 * 它**不是**一段正文的摘要：要读原文就按 `seq`（或 `turn`/`step` + replay）去看那条事件。
 */
export interface RejectRegionEntry {
  /** input item 的类型（`InputItem` 的四个成员；闭集合，新成员会在这里露出来） */
  type: 'message' | 'reasoning' | 'function_call' | 'function_call_output';
  /** 只有 `message` 有：这条消息是谁说的 */
  role?: 'user' | 'assistant' | 'system' | 'developer';
  /** 能精确对上的源事件 seq（见上面那段：缺 = 指不回去，**不是**没有） */
  seq?: number;
  /** 脱敏后的单行预览（≤40 字符；`model/reject-record.rejectPreviewOf`） */
  preview: string;
}

/**
 * **一次请求被服务端拒掉的飞行记录**（2026-10-22 加；internal，纯观测）。
 *
 * 存在的理由（用户点名的观测缺口）：**每次出 400 都只能靠 replay 反推**。replay 回答得了
 * "请求长什么样"，但回答不了"被拒的是**哪一发**、它有多大、区段里那 12 条按什么顺序排"
 * —— 而 400 的处置（改渲染 / 改图片 / 改配置）恰恰取决于这三样。这条记录在**拒绝发生的那一刻**
 * 把现场拍下来，于是事后读日志的人不必先跑一遍重建。
 *
 * 写入判据只有一处（`runtime/agent-loop.ts` 的 `recordReject`）：
 *   · 只认**服务端拒绝**（`http_400`，判据在 `model/reject-record.ts` 的 `serverRejectionOf`）；
 *   · 同 `(turn, step, code)` **只记一条**（一次 step 最多一条：400 自救的第二发即使也被拒，
 *     记的仍是第一次那份现场——被拒的请求字节是同一份输入渲染出来的）。
 *
 * 三条边界：
 *   · **它不进请求体**：internal ⇒ `render.ts` 的 `isModelVisible` 第一道 filter 就把它挡在外面，
 *     一个字节都不影响请求 ⇒ **不动 `RENDER_VERSION`**；
 *   · **它不改行为**：不重试、不改 `turn/end`、不碰失败刹车——只是"那一步多了一条账"；
 *   · **它脱敏**：见 `RejectRegionEntry.preview` 与 `rejectPreviewOf` 的规则。
 */
export interface ModelRejectRecord extends EventEnvelope<'model/reject-record', {
  turn: number;
  step: number;
  /** 客户端给这次失败的归类（今天的 400 是 `http_400`） */
  code: string;
  /** 服务端原话里的 `request_id`（认不出 = `null`，**不猜**） */
  requestId: string | null;
  /**
   * 这一发的**规模**（三格都是事实，不是估算）：
   *   · `items` —— 真发出去的 input 有几条（`input.length`）；
   *   · `historyItems` / `headHash` —— 渲染层 `context.history` 的读数（历史段有几条、前 8 条
   *     的哈希），**唯一来源是渲染层**，这里只装结论。
   */
  shape: { items: number; historyItems: number; headHash: string };
  /** 「最后一条 user 之后」那一段（最多 12 条，取**前** 12 条；见 `rejectRegionOf`） */
  region: RejectRegionEntry[];
  /**
   * 区段比账里那 12 条更长（**事实**，不是"剩下的不重要"）。
   *
   * 缺省 = 没截（区段 ≤12 条）。出现它 ⇔ 区段真有更多条——读的一侧不许把缺省读成"只有几条"。
   */
  truncated?: true;
}> {}

/**
 * 界面的密码被设上/被改掉（2026-10，本地认证从共享 token 换成密码）。
 *
 * 为什么它该进事件日志（而不是像 `skills-ignored.json` 那样只落盘）：
 * 换密码是**一次能力边界的变更**——它当场废掉所有已经发出去的会话凭据，
 * 也（在老实例上）废掉了那份 `data/.ui-token`。这类"谁在什么时候把门锁换了"的事实，
 * 事后唯一能回答的地方就是日志；写在别处就是第二份真相源。
 *
 * 它**不带任何凭据**：没有密码、没有会话串，只有一个非密钥的会话 id。
 * 可见性 internal——这是本机的运维事实，与她的行事无关，不该占她的上下文。
 */
export interface AuthPasswordSet extends EventEnvelope<'auth/password-set', {
  /** 谁设的（界面/脚本自报的 label，缺省 'local'）：只作展示，不参与判定 */
  by: string;
  /** setup = 首次设密码；change = 改密码（会让全部旧会话失效） */
  action: 'setup' | 'change';
  /** 这次是否把遗留的 `data/.ui-token` 作废了（只有老实例迁移时才是 true） */
  legacyTokenDisabled: boolean;
  /** 这次同时失效了几条旧会话（setup 时恒为 0） */
  sessionsRevoked: number;
}> {}

/**
 * webhook 专用凭据被生成 / 被轮换（2026-10，B9：`/webhook/*` 从"共用界面会话凭据"
 * 收窄成"只认一份专用凭据"）。
 *
 * 为什么它该进事件日志：换钥匙是一次**能力边界的变更**——它当场废掉上一份凭据，
 * 也就当场打断了所有还没换过来的外部投递方（监控、别台机器上的脚本……），
 * 而那些故障现场在别的机器上。事后唯一能回答"谁在什么时候换的、换到第几份"的地方就是日志；
 * 界面上的状态会随下一次生成而变，留不下历史。
 *
 * 它**不带任何凭据**：没有明文（明文只在生成那一次的响应体里），也没有哈希，
 * 只有一个非密钥的 8 字节 `secretId`（标识，可以进日志与界面）。
 * 可见性 internal——本机的运维事实，与她的行事无关，不该占她的上下文。
 */
export interface AuthWebhookTokenRotated extends EventEnvelope<'auth/webhook-token-rotated', {
  /** 谁生成的（界面/脚本自报的 label，缺省 'local' 且截断到 40 字符）：只作展示，不参与判定 */
  by: string;
  /** generate = 这台实例第一次生成；rotate = 覆盖掉上一份（上一份当场失效） */
  action: 'generate' | 'rotate';
  /** 新那份的标识（不是密钥） */
  secretId: string;
  /** 被顶掉的那份的标识（首次生成时 null）——这条事实正是"什么时候换过钥匙" */
  previousSecretId: string | null;
}> {}

// ──────────────────────────── 进程重启（2026-10-11 加）────────────────────────────

/**
 * 上一任进程**是怎么没的**（{@link RuntimeRestart} 的判据输出）。
 *
 * 为什么要把"怎么没的"枚举出来、而不是只写一句话：这一格是**判据的落点**——
 * 要不要叫醒她（见 `RuntimeRestart.wake`）完全由它决定，而"哪个判据命中了"必须能从
 * 日志上读回来（与 `wake/heartbeat` 把 `probability`/`roll` 落进事件同一条理由：
 * 判据的输入要能复算，不能只有一个结论）。
 */
export type RuntimeDeathKind =
  /** 内存不足崩的（Node 的老生代上限被打满）：输出里留着 `JavaScript heap out of memory` 那一行 */
  | 'oom'
  /** 上一任写了 `session/end{reason:'error'}`：**它自己**报的异常退出 */
  | 'error'
  /** 上一任被 kill 掉、没来得及走优雅退出（拉起器/人关的，或者被硬杀） */
  | 'killed'
  /** 上一任既没写 `session/end`、也没有任何可判的痕迹（**包括第一任**——那时没有上一任） */
  | 'unknown';

/**
 * **上一任进程的停机结论**（`runtime/restart` 事件里 `previous` 那一格）。
 *
 * 拆成"事实"与"判据"两半（`endedAt`/`endedReason`/`evidence` 是事实，`death`/`abnormal` 是判据）：
 * 判据会随口径改进而变，而当时那一份**证据**不会——只落结论的话，将来推翻口径就再也复核不了
 * 当时为什么这么判（同一批纪律见 `log/repaired`、`compaction/decision`）。
 */
export interface RuntimeRestartPrevious {
  /** 上一任的 pid；查不到就是 null（老日志**没有** `session/start`，或者这是第一任） */
  pid: number | null;
  /** 上一任是什么时候起的（`session/start.ts`）；查不到就是 null */
  startedAt: string | null;
  /** 它上一次启动跑的是哪个版本号（`session/start.version`）；查不到就是 null */
  version: string | null;
  /** 判据结论（见 [RuntimeDeathKind]） */
  death: RuntimeDeathKind;
  /** true = **异常退出**（该叫她一次）；false = 正常重启（她本来就知道，只留痕） */
  abnormal: boolean;
  /** 上一任停机的那条 `session/end` 的时刻；没写过就是 null（这份"缺失"本身就是判据的输入） */
  endedAt: string | null;
  /** 那条 `session/end` 自己报的原因；没写过就是 null */
  endedReason: 'shutdown' | 'error' | 'signal' | null;
  /**
   * **判据当时看到的原话**（人读的一句话）：OOM 痕迹是哪一行、或者"没找到停机记录"。
   * 空串 = 没有任何可说的证据（第一任、或老日志根本没有痕迹）。
   */
  evidence: string;
}

/**
 * **本进程这次是怎么起来的**（internal；2026-10-11 加）。
 *
 * ──────────────────────────── 它治的是什么 ────────────────────────────
 *
 * 用户 2026-10-11 的原话：「**她说她没认出来进程在反复重启**。**进程重启应当跟 compact
 * 事件一样，有个通知让 agent 知晓**」。
 *
 * 现场（同一天）：后端因为内存不足**反复崩/重启**（512 上限崩一次、2048 上限 167 秒崩一次、
 * 无上限涨到 3.8 GB），而她**完全没意识到**——她的上下文里没有任何"我刚被重启过"的痕迹，
 * 于是把断档读成"没人叫我"。对照面是压缩：`compaction/summary` 之后框架会**真唤醒**她一次
 * （`wake/manual{via:'compact'}`），所以"刚压过、中断的活接着做"是**她知道**的事实。
 *
 * ⇒ 重启要**同一形状**：一条留痕（本事件）+ 一次真唤醒（异常退出时；`wake/manual{via:'restart'}`）。
 *
 * ──────────────────────────── 三处刻意分开的账 ────────────────────────────
 *
 *   ① **留痕与唤醒是两条事件**（与压缩那条路逐字同形）：本事件是**簿记**——"这次是谁拉起的、
 *      上一任怎么没的"要能事后查；给她看的是那条 `wake/manual` 的正文。合成一条的话，
 *      "该不该叫醒她"这个决定就藏进了渲染层，而它是个**判据**，必须留在产生侧。
 *   ② **可见性 internal**（走 `defaultVisibility` 的缺省，也在 `EVENT_VISIBILITY` 里写明）：
 *      它**不进她的上下文**，零缓存代价。若写成 `model`，同一件事会在她眼前出现两遍
 *      （一遍是这条事件自己的渲染、一遍是那条通报），第二遍纯属常驻开销。
 *   ③ **每次启动恰好一条、且每次启动都会写**（正常重启也写，只是不叫醒她）：
 *      "这一任是什么时候起的"是**所有**复盘的第一格；漏掉正常重启那次，日志上就会出现
 *      "pid 换了但没有任何解释"的断口——那正是这次要消灭的东西。
 *
 * 判据（什么算异常退出、要不要叫醒她）只写在**一处**：`real-loop.ts` 那段
 * `runtime/restart` 写入点的方法头。本类型只负责把判据的**输入与结论**如实装下来。
 */
export interface RuntimeRestart extends EventEnvelope<'runtime/restart', {
  /** 本进程的 pid（她"现在跑在哪一任上"的凭据） */
  pid: number;
  /** 本次启动跑的是哪个版本号（与 `session/start.version` 同一处口径：`main.ts` 的 AGENT_VERSION） */
  version: string;
  /** 上一任的停机结论与判据（**第一任**时它也在，只是 pid/death 如实为空/unknown） */
  previous: RuntimeRestartPrevious;
  /**
   * **这次是谁拉起的**（能判就给，判不出就 `unknown`——**不许猜**）：
   *   · `root-script`     —— 仓库脚本 `tools/restart-agent.ps1`（开发机的形状）
   *   · `packaged-script` —— 随包脚本 `restart.ps1`（装出来的那份）
   *   · `self-restart`    —— 框架自己的拉起器（`dist/runtime/restart-worker.js`）
   *   · `ui`              —— 界面上按的重启（服务端发起）
   *   · `external`        —— 显式声明是外部看护拉起的（`IRMIA_LAUNCHED_BY`，见下）
   *   · `unknown`         —— 没有任何痕迹（人手工敲的命令行、别人的看护进程……）
   */
  launchedBy: 'root-script' | 'packaged-script' | 'self-restart' | 'ui' | 'external' | 'unknown';
  /** `launchedBy` 判据当时看到的**原话**（人读；空串 = 没有痕迹） */
  launchedEvidence: string;
  /** 判据用的命令行原文（`process.argv` 拼回来，便于复盘"当时带的是什么参数"） */
  argv: string;
  /**
   * 带没带上限、上限多少（**能读到就给**）。
   * `enabled: false` = V8 报没有上限（命令行没带 `--max-old-space-size`）；
   * `enabled: true` 而 `limitMb` 为 null = 带了参数但读不出那个数（不许猜，如实留空）。
   */
  heapCap: { enabled: boolean; limitMb: number | null };
  /**
   * 这一任起来时**有没有真的叫过她**（`wake/manual{via:'restart'}` 落了没有）。
   *
   * 为什么把它也落进事件：判据（`abnormal`）与动作（叫没叫）是两件事，而"这一任叫过她"
   * 这件事**只需要回答一次**——同一次启动**只喊一次**的去重判据就是它（见写入点：
   * 日志里已经有 `runtime/restart` 就整段跳过；这条事件在，就说明该叫的已经叫了）。
   */
  wake: boolean;
}> {}

// ──────────────────────────── 临时目录兜底扫（2026-10-21 加）────────────────────────────

/**
 * 一轮 `%TEMP%` 兜底扫的账（`src/util/temp-sweep.ts` 跑，启动时一次 + 每日整理那一拍一次）。
 *
 * 为什么要落事件而不只打日志：`%TEMP%` 是**会涨到几个 GB 的地方**，而涨起来的时候人往往
 * 已经不在机器旁了。"上一次扫是什么时候、扫到多少、删了没有"必须是事后查得到的账，
 * 不能只活在那一次的 stdout 里（重启一次就没了）。
 *
 * **它不进上下文、不动 `RENDER_VERSION`**（判据同 `log/idle-reason.ts` 那段：internal 事件
 * 不进请求体）。`mode` 如实记**这一次真的按哪一档跑的**（环境变量写错时调用点会先记一行日志，
 * 事件里落的是修正后的那档）。
 */
export interface TempSwept extends EventEnvelope<'temp/swept', {
  /** 这一次真按哪一档跑的：`dry` = 只报不删（缺省），`on` = 真删；`off` 不会写事件 */
  mode: 'dry' | 'on';
  /** 扫的是哪个目录（`os.tmpdir()` 的值） */
  root: string;
  /** 前缀命中的条目数（含还不够老的） */
  scanned: number;
  /** 够老的候选数（`dry` 下 = "将删"的个数） */
  candidates: number;
  /** 候选占的字节数（目录按递归求和） */
  bytes: number;
  /** 真删掉的个数（`dry` 恒为 0） */
  deleted: number;
  /** 判定为占用（`rename` 试探失败）而跳过的个数 */
  skippedInUse: number;
  /** 删/改回失败的个数（`detail` 里带原因） */
  failures: number;
  /** 读目录失败的原因（空串 = 正常） */
  error: string;
}> {}

// ──────────────────────────── 更新检测（2026-10-22 加）────────────────────────────

/**
 * **一次更新检测的账**（internal）。
 *
 * 它是**给用户的提醒**，不是给她的输入：`visibility:'internal'`（也在 `EVENT_VISIBILITY`
 * 里写明）⇒ 不进请求体、不进她的上下文、不产生 speak/report。她想"看一眼有没有新版本"，
 * 得由用户自己让她去查（`GET /api/update` 是界面那条路，与她无关）。
 *
 * 为什么连**失败**也要写一条：节流判据与"连续失败 3 次后降频"读的是状态文件，但
 * "上一次到底是几点查的、为什么没查到"属于事后复盘的事实——只活在状态文件里就会被
 * 下一次检查覆盖，而事件日志是只增不改的。失败的 `status` 是 `unknown`、`reason` 如实带上
 * （`network` / `timeout` / `http-404` / `bad-json` / `pending` …）；**它不是错误事件**，
 * 也没有任何告警出口读它。
 *
 * `endpoint` 是**脱敏之后**的那个串（只保留 `protocol//host/path`）：query 里可能有站点
 * 给的签名，长期留档的日志与界面都不该看到它（判据在 `update/check.ts` 的
 * `sanitizeEndpoint`，写入点用的是同一个函数）。
 */
export interface UpdateChecked extends EventEnvelope<'update/checked', {
  /** none = 没有更新；available = 有新版本；required = 低于最低可用版本；unknown = 这次没查到 */
  status: 'none' | 'available' | 'required' | 'unknown';
  /** 本进程版本号（与 `session/start.version` 同一处口径） */
  currentVersion: string;
  /** 站点给的最新版号；这次没读到就是 null（**不是空串**：两者在界面上说法不同） */
  latestVersion: string | null;
  /** 这次走的通道 */
  channel: string;
  /** 已脱敏的端点（不含 query/fragment/userinfo） */
  endpoint: string;
  /** 这次检测的时刻（ISO；失败也算一次） */
  checkedAt: string;
  /** 判据落点（见 `update/check.ts` 的 UPDATE_REASONS）：`up-to-date` / `http-500` / `timeout` … */
  reason?: string;
}> {}

// ──────────────────────────────── 联合类型 ────────────────────────────────

export type AppEvent =
  | SessionStart | SessionEnd
  | RuntimeRestart
  | TurnStart | TurnEnd | StepStart | StepEnd | StepReasoningProgress
  | UserMessage | AssistantMessage | ReasoningMessage | DeveloperMessage
  | ToolCall | ToolResult
  | WakeTimer | WakeFile | WakeWebhook | WakeManual | WakeHeartbeat | WakeIntention | WakeJob | WakeChannel
  | ChannelMessage | ChannelNotice | ChannelSelfAction | ChannelRead | ChannelTopic | InjectionFlagged | InjectionNoted
  | ImageAttached | ImageTrace
  | RenderHistoryRewrite
  | TimerSet | TimerFired | TimerCancelled
  | BudgetConsumed | BudgetRollover | BudgetExhausted | BudgetToppedUp | BudgetResumed
  | BudgetCacheAlert
  | PolicyDenied | AuthzDenied | LogRepaired | InstanceTakeover
  | InputClaimed | InputDeadLetter | InputRequeued | InputDiscarded | ToolZombie
  | SlashHandled
  | AlarmSent | ReviewResolved | SnapshotCheckpoint | CompactionSummary | CompactionDecision
  | PersonaUpdated | ConfigChanged | MemoryMaintained | MemorySelected | MemoryRead
  | McpServerStarted | McpServerStopped | McpServerResource | McpIndex | SkillIndex | SkillInstalled | SkillSeeded | SkillSeeded | HookFired | SpeakSent
  | McpServerStarted | McpServerStopped | McpServerResource | McpIndex | SkillIndex | SkillInstalled | HookFired | SpeakSent
  | PluginInstalled | PluginEnabled | PluginDisabled | PluginFailed
  | PluginQuarantined | PluginProbeStarted | PluginRecovered
  | ToolsInventoryChanged
  | GrantRequested | GrantResolved
  | IntentionRaised | IntentionActed | TodoUpdated
  | JobStarted | JobFinished
  | HumanAsked | HumanAnswered | HumanExpired | HumanTimedOut
  | PlanPending | PlanResolved
  | AuthPasswordSet
  | AuthWebhookTokenRotated
  | TempSwept
  | UpdateChecked
  | ModelDegraded | ModelRestored | ModelProtocolSwitched | ModelReasoningEcho | ModelRejectRecord
  | RuntimeModelSwitch;

export type AppEventType = AppEvent['type'];

/** 事件类型 → 默认可见性（写入时必须显式落定，此表用于校验与渲染分类） */
export const EVENT_VISIBILITY: Record<string, Visibility> = {
  // 协议切换的留痕（2026-10-21）：**internal**——审计账（凭什么切、切到哪、首次何时），
  // 不是给她的输入；她该看见的是切换之后那次调用的结果。
  // 不进请求体 ⇒ 不动 RENDER_VERSION。写在这里而不是靠 defaultVisibility 兜底，
  // 是为了让「这条线是有意画的」看得见。
  'model/protocol': 'internal',
  // 模型切换的留痕（2026-10-26）：**internal**——它是审计账（缓存窗口从哪个模型切到哪个模型），
  // 不是给她的输入。写在这里而不是靠 defaultVisibility 兜底，同 `model/protocol` 一条纪律。
  'runtime/model-switch': 'internal',
  'session/start': 'internal', 'session/end': 'internal',
  // 进程重启的留痕（2026-10-11）：**internal，而"叫她"是另一条事件**。
  // 这条是簿记——"这一任是什么时候起的、上一任怎么没的、谁拉起的"；给她看的是紧随其后的
  // 那条 `wake/manual{via:'restart'}`（正文才是对她说的话）。与压缩那一对
  // （`compaction/decision` internal + `wake/manual{via:'compact'}` model）逐字同形。
  // 写成 model 的代价是同一件事在她眼前出现两遍（见 RuntimeRestart 的注释 ②）。
  'runtime/restart': 'internal',
  'turn/start': 'internal', 'turn/end': 'internal',
  'step/start': 'internal', 'step/end': 'internal',
  // 推理进度的实时读数（2026-10-17）：**刻意 internal，写在这里是让"这条线是有意画的"看得见**
  // ——它只喂界面那一行「已想 X 字」，不是给她的输入（正文那条走 `message/reasoning`）。
  // 理由与"为什么不必在 render 里再挡一遍"见 StepReasoningProgress 的注释。
  'step/reasoning-progress': 'internal',
  'message/user': 'model', 'message/assistant': 'model', 'developer/message': 'model',
  // **思维链：v68 起 model**（2026-10-17；这一格是整条修复的开关）。
  // 为什么必须写出来：Responses API 的思考模式**强制要求回传 `reasoning_text`**，缺了整条请求 400
  // （实测 23 条 `The reasoning_text in the thinking mode must be passed back to the API`）。
  // 这条事件从 v1 起一直是 internal（渲染层那个 reasoning 分支因此**一次都没执行过**），
  // 而它一直是 `internal` 时靠"每轮退输入 + `MAX_CLAIM_COUNT=3` 进死信"收场 ⇒ 一场风暴几十轮全灭。
  // **帽子在渲染层，不在这里**（**v73 起语义变了**，2026-10-20）：`model/render.ts` 的
  // `REASONING_ECHO_POLICY` 现在**全量回传**（不按条数截），只留一条总字符硬上限（300,000）；
  // 撞上限时**整组丢**（连 assistant 正文一起），**绝不截一条的思维链**——
  // v68 那种"最近 3 步 / 单条 ≤ 20,000 字符、超了取尾部"的帽子是**错的**：它让 assistant 条目
  // 留在请求里、却只回传最近 3 条的思维链，2026-10-20 撞出每轮 400
  // （`The reasoning_text in the thinking mode must be passed back to the API`）。
  // 依据：官方 Thinking Mode · Tool Calls 要求带 `tools` 的请求**完整回传** `reasoning_content`，
  // 而 Responses API 把 `reasoning` 的明文 content 并入**相邻的 assistant 消息** ⇒ "条目在、
  // 思维链缺"就是那条 400。装配末端的自洽强制见 `render.ts` 的 `enforceReasoningEchoIntegrity`，
  // 发送前的结构断言见 `assertReasoningEchoIntegrity`。
  // **老日志不改写**：已落库的那些 `visibility:'internal'` 照旧不进请求（`reasoningEchoOf` 只认
  // model 可见），所以"同一份老日志重建出同一份请求"这条承诺没有因为这一格而作废。
  // 它进 `input` ⇒ 与 v67 逐字节不可比 ⇒ **同批递增 `RENDER_VERSION` 67 → 68**（v73 是回传集合变了，
  // 又递了一代 72 → 73）。
  'message/reasoning': 'model',
  'tool/call': 'model', 'tool/result': 'model',
  'wake/timer': 'model', 'wake/file': 'model', 'wake/webhook': 'model',
  'authz/denied': 'internal',
  'wake/manual': 'model', 'wake/heartbeat': 'model', 'wake/intention': 'model', 'wake/job': 'model',
  'wake/channel': 'model',
  // 通道普通消息与已读位**刻意不进上下文**：QQ 是"手边一个可以点开的软件"而不是推给她的消息流。
  // 它们不写在这里也走 defaultVisibility 的 internal，写出来是为了让"这条线是有意画的"看得见
  // ——她通过未读计数知晓它存在，想看就用 read_channel 现取（README/review v32 记了这次取舍）。
  'channel/message': 'internal', 'channel/read': 'internal', 'channel/topic': 'internal',
  // 群里的动静（notice：管理动作/入群退群/撤回）与消息**同一条纪律**：internal、不唤醒，
  // 她想看用 read_channel 现取。写出来（而不是靠 defaultVisibility 兜底）是为了让
  // "这条线是有意画的"看得见——理由与上面那三行逐字相同，见 ChannelNotice 的注释。
  'channel/notice': 'internal',
  // 她自己的管理动作（「我做过」，2026-10-11）：与上面那一行**逐字同一条纪律**——internal、
  // 不唤醒、不计未读，她翻会话时用 read_channel 现取。理由见 ChannelSelfAction 的注释。
  'channel/self-action': 'internal',
  // 注入预警同样 internal：它不是给她的输入，而是**贴在**那条外部消息旁边的一句框架话
  // （渲染时按 messageId 关联，见 model/render.ts 的 renderExternalEvent）
  'injection/flagged': 'internal',
  // 「示警已发生」同理：那句话贴在那条消息旁边，GUI 与此刻层历史只是引用它
  'injection/noted': 'internal',
  // 她自己要求放进来的图：与 wake/channel 的附件同一条出口（渲染层注入 input_image）
  'image/attached': 'model',
  // 图片通道的留痕（2026-10-21）：**internal，刻意不进她的上下文**。
  // 它是"这张没进/没压成"的账，不是给她的输入——真正进上下文的是那一步的 input_image。
  // 写成 model 的代价是每张没进的图都会在她眼前多出一行框架话，而她要的是图本身。
  'image/trace': 'internal',
  // 中段改写的留痕（v76，P4）：**internal，刻意不进她的上下文**——它是账（哪一步把历史第几条
  // 改了），不是给她的输入；请求照发。写成 model 的代价是每次图片窗口滑出都在她眼前多一行框架话，
  // 而它不改变"该做什么"。理由与 `image/trace` / `tools/inventory-changed` 逐字同形。
  'render/history-rewrite': 'internal',
  // 抬上限解除暂停：与 session/* 同一条口径——它是**簿记**（谁解的、凭什么解的），
  // 不是给她的输入。她该看见的是"又能干活了"这件事本身（下一次 turn），
  // 而不是框架内部的解扣动作；写出来是为了让"这条线是有意画的"看得见
  'budget/resumed': 'internal',
  // 缓存未命中率告警（2026-10-22）**同样刻意 internal**，理由与上面那几行逐字同形：
  // 它是**账**（最近 20 轮的未命中份额比基线恶化了几倍、主嫌疑是谁），不是给她的输入。
  // 她要看见的是那句人话——紧随其后的 `wake/manual{via:'system'}` 正文（`cacheAlertWakeNote`）。
  // 写成 model 的代价是每触发一次就在她的上下文里多一条常驻读数，而它对"该做什么"没有信息量
  // （与 `mcp/index` / `tools/inventory-changed` / `model/reasoning-echo` 同一条纪律）。
  // ⚠ 它**不进请求体 ⇒ 不动 `RENDER_VERSION`**：`renderEvents` 的 default 分支不认它。
  'budget/cache-alert': 'internal',
  'human/asked': 'model', 'human/answered': 'model',
  // 超时事实同样进上下文：她必须**得知**"人可能不在机器旁、或没注意到"才能自己决定下一步
  // （design §6.1：换个方式找人是她的判断）。写成 internal 等于让这件事只留在日志里，
  // 她下一拍还是以为自己在等人回话——那正是 §6.5 禁止的那种"等"。
  'human/expired': 'model',
  // 超时的**处置**（2026-10-22）：那条待答被作废、挂起解除、她手上的活重新回到队列。
  // internal 是刻意的——它是框架这一侧的簿记，不是给她的输入；她要看见的是 `human/expired`
  // 那条事实（人可能不在）与紧随其后重入队的那几条输入本身。
  // ⚠ 它**不进请求体 ⇒ 不动 `RENDER_VERSION`**（render 的 default 分支不认它）。
  'human/timed-out': 'internal',
  // 计划模式的两次落库都是簿记：可见语义由同批 human/asked（事前提问）与 human/answered
  // （人的答复）承载，plan/* 再进一遍上下文只是同一件事被渲染两次
  'plan/pending': 'internal', 'plan/resolved': 'internal',
  'review/resolved': 'model',
  'compaction/summary': 'model',
  // 压缩判定的留痕（一 turn 一条）：**这一拍为什么不压**。internal 是刻意的——它是判据的
  // 审计账（阈值/遮蔽点/闸门量），不是她的输入；她该看见的是压缩的**效果**（那份摘要，
  // 以及紧随其后那条 wake/manual · via='compact'）。写在这里而不是靠 defaultVisibility 兜底，
  // 是为了让"这条线是有意画的"看得见，也防住将来有人手滑把它写成 model
  //（那会让她每 turn 都读一遍"我这拍为什么没压缩"——纯粹的常驻开销）。
  'compaction/decision': 'internal',
  // MCP 常驻索引的快照（2026-10-10）**刻意 internal，而它进上下文的那段文字照旧进**：
  // 两者是两件事——`mcp/index` 是"这一版索引是什么"的**凭据**（复现与审计用），
  // 给她看的是 `render` 从这条事件里取出来的那段文字（进长期记忆层，与技能 catalog 同段素材）。
  // 若把这条事件写成 model，同一段索引会在她的上下文里出现**两遍**（一遍是渲染出来的段、
  // 一遍是事件自己的渲染），第二遍纯属常驻开销。写在这里而不是靠 defaultVisibility 兜底，
  // 是为了让"这条线是有意画的"看得见。
  'mcp/index': 'internal',
  // 技能常驻索引的快照（2026-10-11）**刻意 internal，理由与上一条逐字同形**：
  // 它是"这一版索引是什么"的凭据（复现与审计用），给她看的是 `render` 从这条事件里取出来的
  // 那段文字（进长期记忆层，与 MCP 索引同段相邻）。写成 model 就等于同一段索引在她眼前出现
  // 两遍，第二遍纯属常驻开销。写在这里而不是靠 defaultVisibility 兜底，是为了让"这条线是有意
  // 画的"看得见——缓存保护的那条线（索引字节只在归集时改）正是靠它成立的。
  'skill/index': 'internal',
  // 出厂技能首次复制进数据目录的留痕（v79）**同样刻意 internal**：它是**装配账**
  // （"这几个技能目录是怎么来的、复制了几件"），不是给她的输入——她该看见的是 catalog
  // 里那几行名称与描述（那由 `skills` 段渲染，与本事件无关）。写在这里而不是靠
  // defaultVisibility 兜底，是为了让"这条线是有意画的"看得见，也防住将来有人手滑把它
  // 写成 model（那会让她每轮读一遍"我的技能是从安装包复制的"——纯粹的常驻开销）。
  // ⚠ 它**不改 `RENDER_VERSION`**：事件不进请求体，渲染口径一个字节都没动。
  'skill/seed': 'internal',
  'plugin/installed': 'internal', 'plugin/enabled': 'internal',
  'plugin/disabled': 'internal', 'plugin/failed': 'internal',
  'plugin/quarantined': 'internal', 'plugin/probe-started': 'internal', 'plugin/recovered': 'internal',
  // 工具清单指纹的变化（2026-10-11，BUG-3）**同样刻意 internal**，理由与上面那条逐字同形：
  // 它是**装配账**（"这一刻进请求的清单是哪几件、比上次少了哪几件"），而清单本身已经作为
  // tools 段进了请求体——再把它作为一条事件渲染一遍，就是同一件事在她眼前出现两遍。
  // 写在这里而不是靠 defaultVisibility 兜底，是为了让"这条线是有意画的"看得见，
  // 也防住将来有人手滑把它写成 model（那会让她每轮都读一遍自己的工具清单）。
  // ⚠ 它**不改 `RENDER_VERSION`**：事件不进请求体，渲染口径一个字节都没动。
  'tools/inventory-changed': 'internal',
  // 思维链回传的处置账（2026-10-20，v73）**同样刻意 internal**，理由与上面两条逐字同形：
  // 它是**装配账**（这一拍丢了哪几组、放开了多少条/多少字符、服务端原话是哪句），而真正进请求的
  // 是那段 input 本身——再渲染一遍就是同一件事在她眼前出现两遍。写在这里而不是靠
  // defaultVisibility 兜底，是为了让"这条线是有意画的"看得见，也防住将来有人手滑把它写成 model
  // （那会让她每轮都读一遍"我这拍为什么少了几条思维链"——纯粹的常驻开销）。
  // ⚠ 它**不改请求字节、不动 `RENDER_VERSION`**：`renderEvents` 的 default 分支不认它。
  'model/reasoning-echo': 'internal',
  // 「这一发请求被服务端拒了」的现场（2026-10-22，400 飞行记录器）**同样刻意 internal**：
  // 它是**排障账**（被拒的是哪一发、有多大、区段那 12 条是什么顺序），不是给她的输入——
  // 她该看见的是"这次没答上"（`turn/end` 的 error + 死信通报），而不是"我们的请求形状长什么样"。
  // 写成 model 的代价不止是常驻 token：那等于把**我们自己的请求字节**当历史回传，下一发再被
  // 服务端判一次（"区段里出现了不该出现的东西"正是 400 的成因）。
  // ⚠ 它**不进请求体 ⇒ 不动 `RENDER_VERSION`**：`renderEvents` 的 default 分支不认它。
  'model/reject-record': 'internal',
  // 申请单的两条都 **internal，刻意不进她的上下文**（2026-10-11）：
  //   · `grant/requested` —— 她**知道**自己递过单子（工具回执当场回了她一句），
  //     而"框架在下一拍把这份单子拾起来了"是簿记，进上下文只是同一件事渲染两遍；
  //   · `grant/resolved` —— 结局**由那条真唤醒（`wake/manual · via='grant'`）告诉她**，
  //     那一条进上下文（note 是框架写给她的话），这两条只是它的凭据（审计与复盘用）。
  // 两件事必须分得开：本表说 model ⇒ 不进请求；凭据是"这一版结局是什么"，
  // 给她的是那句话。写在这里而不是靠 defaultVisibility 兜底，是为了让"这条线是有意画的"看得见。
  'grant/requested': 'internal', 'grant/resolved': 'internal',
  'policy/denied': 'model',
  // 整理留痕只在日志与前端，不进上下文（记忆的秩序由机制保证，不必每轮提醒她一遍）
  'memory/maintained': 'internal',
  // 选材是**装配账**（这一轮往固定块里放了哪几条记忆），不是给她的输入：正文才进上下文，
  // 账本身只服务于"同一份日志重建同一份请求"与事后复盘（B2，docs/memory-injection.md §4）
  'memory/selected': 'internal',
  // 访问账同上：她这一轮已经拿到正文了，再回一句"你刚读了 facts.md:9"只是把同一件事
  // 渲染两遍。它服务的是 design §4.17 第 2 条的访问强化（整理任务据此把常读的往前提）
  'memory/read': 'internal',
  // 换锁是本机的运维事实：她要办事时会撞上"进不去"，但"谁什么时候设了密码"本身
  // 不该占她一拍上下文（与 session/* 同一条口径）
  'auth/password-set': 'internal',
  // webhook 专用凭据的轮换同上：它是本机的运维事实（谁什么时候换了那条通道的钥匙），
  // 但它不改变她能做什么——外部投递进来照旧是一条 wake/webhook
  'auth/webhook-token-rotated': 'internal',
  // 人打的一条指令（`/compact` / `/handoff`）：簿记——谁按了哪条、带了什么理由、落地成什么。
  // 不进上下文：她该看见的是指令的**效果**（紧随其后的 compaction/summary），不是"用户按了按钮"
  // （B1 第二步；写在这里而不是靠 defaultVisibility 兜底，是为了让"这条线是有意画的"看得见）
  'slash/handled': 'internal',
  // 临时目录兜底扫的账（2026-10-21）：内部观测——它回答"上一次扫到多少、删没删"，
  // 一个字节都不该进她的上下文（`%TEMP%` 的清理跟她要做的任何事无关）。
  'temp/swept': 'internal',
  // 更新检测的账（2026-10-22）：**internal，刻意不进她的上下文**——这是给用户的提醒
  // （界面顶部那条、托盘那一行），主角是"这台机器要不要升级"，不是她要做的任何事。
  // 写成 model 的代价是每次检查都在她眼前多一行版本号读数，而它对"该做什么"没有信息量
  // （与 `temp/swept` / `mcp/index` 同一条纪律）。⚠ 它不进请求体 ⇒ 不动 `RENDER_VERSION`。
  'update/checked': 'internal',
  // 其余全部 internal
};

export function defaultVisibility(type: string): Visibility {
  return EVENT_VISIBILITY[type] ?? 'internal';
}

/**
 * **工具侧写入点的可见性判据**：表说 `model` 的事件**必须显式给**——省略即抛。
 *
 * 为什么要它（2026-10-11 修的一类静默失效，两处现场都在工具侧）：
 *   · `vision_read` 的 inline（`image/attached`）：`tools/catalog.ts` 那个 emit 适配层把第三个
 *     参数吃掉，事件落成 internal ⇒ 回执写着"图片已放进你的上下文"，请求体里一张图都没有；
 *   · `speak` / `report` 落下的 `message/assistant`：她自己说过的话没有独立形态进历史。
 * 两处的共同形状是"**事件在日志里、数据也在，只有 visibility 那一栏不对**"——从日志上查不出错，
 * 只能从请求体那一侧看出来。根因是两份口径：上面那张表说 `model`，而这个写入点的默认参数是
 * **恒为 `internal`** 的字面量（`main.ts` 的 `emit`）。于是"省略可见性"这个动作在两侧的含义相反。
 *
 * 判据只此一处：**表说 `model` ⇒ 省略即抛、写 `internal` 也抛**。这不是"多加一道校验"，
 * 而是把"她必须看见"这件事从每个调用点的记性挪到一处——与 `runtime/agent-loop.ts` 那个写入点
 * 同一条纪律（`visibility: defaultVisibility(type)`，"可见性一律走 schema 表，不在写入点手填"）。
 * `internal` 那些类型照旧可省：省略与表同值，写 `internal` 也放行。
 *
 * **反向不在这里管**（表说 internal、写入点却显式给 model）：那一路的后果是"多花常驻 token"
 * 而不是"静默丢失"，代价可见、也退得回来；真发生时有 `cacheBreak` 的归因与此刻层可查。
 * 这条判据要挡的是**看不见的那一种**。
 *
 * 真要写一条不进上下文的 `model` 类型事件时，别在这里绕——先改 `EVENT_VISIBILITY` 那一行
 * 并说清为什么，让"她看不见它"成为一个**写在表上的决定**。
 */
export function resolveEventVisibility(type: string, explicit?: Visibility): Visibility {
  const fallback = defaultVisibility(type);
  if (fallback === 'model') {
    if (explicit !== 'model') {
      throw new Error(
        `事件 ${type} 的缺省可见性是 model（表里写着"她必须看见它"），`
        + `${explicit === undefined ? '而这个写入点省略了可见性' : `却被显式写成 ${explicit}`}——`
        + '那会让它落成 internal：事件在日志里、负载也在，渲染层（isModelVisible）却看不见它。'
        + `这一处要显式写 defaultVisibility('${type}')；`
        + '若它确实不该进上下文，先改 src/log/types.ts 的 EVENT_VISIBILITY 并说清为什么。',
      );
    }
    return 'model';
  }
  return explicit ?? 'internal';
}

// ──────────────────────────────── 归属判定 ────────────────────────────────

/**
 * 顶层事件判定（design §4.21 隔离三件套之二/三）。
 *
 * 子代理链的事件带 `parentCallId`（指向父 turn 里那次 `task` 调用），它们是**另一条 turn 链**：
 * 父层的渲染、状态机与请求重建都不该看见它们——否则父模型会看到"自己"没说过的话、自己没发起的
 * 工具调用，上下文隔离就成了单向的（子代理看不见父，父却看得见子的内脏）。
 *
 * 反向的过滤（子代理只看自己链）由 `childEventFilter` 提供，两处共用这一份判定口径，
 * 避免"运行期一套、重建一套"的漂移。
 */
export function isTopLevelEvent(event: { parentCallId?: string }): boolean {
  return event.parentCallId === undefined;
}

/**
 * 调用指纹：`tool` + 规范化后的 arguments。计划模式的通行证用它匹配「重发的同一个调用」。
 *
 * 规范化 = 解析 JSON 后按键排序重新序列化，于是纯粹的空白/键序差异不会让同一件调用
 * 被认成两件。解析失败退回 trim 后的原文：**批准的判定不能因为参数格式而漂移**，
 * 而一份连 JSON 都解析不出的 arguments 照样要以原样文本参与匹配（它本来就执行不了，
 * 指纹只是把它与批准记录对上）。
 */
export function planFingerprint(tool: string, args: string): string {
  return `${tool} ${canonicalizeArgs(args)}`;
}

function canonicalizeArgs(args: string): string {
  const text = args.trim();
  if (text === '') return '{}';
  try {
    return JSON.stringify(sortKeys(JSON.parse(text) as unknown)) ?? text;
  } catch {
    return text;
  }
}

/** 递归按键排序：数组保序（顺序是语义），对象排序（键序不是语义） */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
  return out;
}

// ──────────────────────────────── 投影 ────────────────────────────────

export interface PendingInput {
  /** 产生它的 wake 事件 seq（内容从日志取） */
  wakeSeq: number;
  source: WakeSource;
  /** 认领次数，interrupted 退回时 +1，达到 3 进死信 */
  claimCount: number;
  dedupeKey?: string;
}

export interface OpenToolCall {
  callId: string; name: string; sideEffect: SideEffect; callSeq: number;
}

export interface ReviewItem { callId: string; name: string; at: string }

/** 计划模式待批准项（plan/pending 折叠；与 needsReview 并列的另一条人审队列） */
export interface PlanReviewItem {
  callId: string;
  tool: string;
  /** 原始 arguments 文本（批准后按它重算指纹） */
  arguments: string;
  turn: number;
  step: number;
  at: string;
}

/** 计划模式已批准、尚未落地的执行许可（plan/resolved{approved} 折叠，tool/call 消费） */
export interface PlanApproval {
  fingerprint: string;
  tool: string;
  callId: string;
  at: string;
}

/** 台面上一条没答复的人类提问（`human/asked` 折叠；出队只看 human/answered） */
export interface HumanAskEntry {
  /** 那条 `human/asked` 的 seq：答复与超时都按它配对，不靠 FIFO 猜 */
  seq: number;
  source: HumanAskSource;
  question: string;
  context: string;
  turn: number;
  at: string;
  /**
   * 落下「未批准、未拒绝」事实的时刻（`human/expired`）；null = 还没到超时线。
   *
   * 它**不把这条提问移出队列**：超时不是决定，人回来照样能答（§6.1）。
   */
  expiredAt: string | null;
}

export interface TimerEntry {
  timerId: string;
  at?: string;
  cron?: string;
  payload: unknown;
}

/**
 * 预算口径的版本号——**累计量与它必须同源**（`Projection.budget.budgetVersion` 存的就是它）。
 *
 * 换口径时**必须 +1**，并同时抬 `state/projection-cache.ts` 的 `PROJECTION_CACHE_VERSION`
 * 与 `state/snapshot.ts` 的 `SNAPSHOT_VERSION`：前者让投影缓存被丢弃，后者让折叠快照被丢弃，
 * 两者缺一，旧口径的累计量就会从另一条恢复路径喂回新进程（现场那次事故走的正是快照那条路）。
 *
 * 记账：
 *   · v1 = **未扣缓存**口径（`inputTokens + outputTokens`，含 cacheHit）；
 *   · v2 = **非缓存**口径（`(inputTokens − cacheHitTokens) + outputTokens`，只算真花钱的那部分）
 *     —— 唯一一处算式在 `state/fold.ts` 的 `budgetTokensOf`。
 *
 * 为什么版本号放在这里而不是 fold.ts：它描述的是**投影的形状**（哪一版累计量），
 * 而投影形状的家是 log/types.ts；fold.ts 只是盖这个章的人（并把它转出去给恢复层读）。
 * `test/budget-snapshot-rebuild.test.ts` 钉住"算式 ↔ 版本号"的配对关系。
 */
export const BUDGET_ACCOUNTING_VERSION = 2;

export interface Projection {
  lastSeq: number;
  /** 投递水位：连续已处理到的位置。推进时跳过空洞 */
  watermark: number;
  /** 待处理输入队列 */
  pending: PendingInput[];
  /** 当前打开的 turn，null 表示空闲 */
  openTurn: { turn: number; step: number } | null;
  /** 有 tool/call 无 tool/result 的调用 */
  openTools: OpenToolCall[];
  /** 待人工确认的调用（status: unknown） */
  needsReview: ReviewItem[];
  /**
   * 计划模式待批准的调用（design §4.21）。与 needsReview **刻意分开**：
   * 那条队列的语义是「动过手、结局不明」（不变量 I6 按 `tool/result{unknown}` 逐条校验），
   * 混进来会让「事前」与「事后」两种人审在同一队列里失去区分。
   */
  planPending: PlanReviewItem[];
  /** 已批准但尚未落地的执行许可（指纹匹配，tool/call 落库即消费） */
  planApproved: PlanApproval[];
  budget: {
    /**
     * 这一份累计是按**哪一版预算口径**折出来的。
     *
     * 存在的理由是一次实测事故（2026-10-05）：投影里的 `tokensToday` / `tokensTask` 是**累计量**，
     * 它们被写进 `data/projection.json` 与 `data/snapshots/*.json` 跨进程复用。口径一换
     * （未扣缓存 → 非缓存），旧账的一半按旧算式、新账的一半按新算式 ⇒ 两套数都不可信，
     * 而刹车照旧拿它判：现场磁盘上冻结着 `tokensToday=29,951,973`，同一份日志按新算式
     * 折出来只有 `2,052,965`，进程却拿前者判"日额度用尽"，她一开始 turn 就被拒。
     *
     * 所以累计量必须**带着口径版本**一起走：`state/projection-cache.ts` 与 `state/snapshot.ts`
     * 校验它，不一致就把整份派生状态丢掉、从事件重放（真相源永远是事件日志）。
     *
     * 它由 `fold` 盖（`emptyProjection()` 就带上），不在别处赋值——累计量与它的口径标签
     * 必须同源，两处各写一遍迟早会对不上。当前值见 {@link BUDGET_ACCOUNTING_VERSION}。
     *
     * 可选是为了让**旧日志/旧缓存**仍然读得进来（老文件里没有这一格）：缺这一格 = 不认识，
     * 载入层按"不可用"处理（重建），而不是猜它是哪一版。
     */
    budgetVersion?: number;
    /**
     * 最近一次 `budget/rollover` 记的是哪一天（`YYYY-MM-DD`，没有则 null）。
     *
     * 存在的理由是一次实测事故：运行时原来只拿**进程内存**里的 `lastRolloverDate` 去重，
     * 而那个字段每次启动都是 null，于是**每启动一次就写一条 rollover**、把当日计数清零一次。
     * 表现是运行情况页的「今日 token」老是 0、缓存命中率显示 `-`（0/0），
     * 而同一页的 hourly 曲线（从事件重算）一切正常——重启三次就归零三次。
     * 记账边界是**事实**，事实以日志为准：折进投影里，运行时读它。
     */
    date: string | null;
    tokensToday: number;
    tokensTodayHeavy: number;
    tokensTodayLight: number;
    cacheHitToday: number;
    cacheMissToday: number;
    tokensTask: number;
    stepsThisTurn: number;
    toolCallsThisStep: number;
  };
  timers: TimerEntry[];
  /** turn → 该 turn 认领的 wakeSeq 列表（input/claimed 折叠；恢复流程据此退回输入） */
  claimedByTurn: Record<number, number[]>;
  /** 意图簿（INTENTIONS.md 的事件镜像；到期判定由调度器读时钟做，fold 只折叠） */
  intentions: Array<{ intentionId: string; content: string; triggerAt?: string; condition?: string }>;
  /**
   * 任务内计划清单（`todo/updated` 折叠）。
   *
   * **2026-10-04 起不再是谁的真相源**：待办清单的唯一载体是 `STATE.md` 的「## 当前任务」/
   * 「## 接着干」两节（`persona/todo-state.ts`），任务卡从那里读（`agent-loop` 的 `taskCard()`）。
   * `todo` 工具照旧落一条 `todo/updated`，于是这一格仍然等于**最近一次写入的那份清单**——
   * 它现在的用途是**读旧日志**（既有日志里只有这条事件，没有 STATE 快照）与观测，
   * **不要拿它当"她现在的待办"**：她可能直接改 STATE（人在界面上也能改），那一改不落事件。
   */
  todoList: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** 运行中的后台任务 */
  jobs: Record<string, { command: string; turn: number; startedAt: string }>;
  /**
   * 台面上还没答复的人类提问，**FIFO**（design §6.3：一次只一张，其余排队）。
   *
   * 它同时装两种来源（见 [HumanAskSource]）：界面只弹队首那一张，答掉/超时之后下一张才浮上来。
   * 「答没答」「超没超时」都只认事件：`human/answered{askSeq}` 出队、`human/expired{askSeq}` 只做
   * 标记**不出队**（超时不产生决定，卡仍然有效——§6.1）。
   */
  humanAsks: HumanAskEntry[];
  /** 执行中挂起等待人答（`human/asked` 未 paired）——**只认系统来源**（计划批准那种挂起） */
  waitingHuman: { question: string; turn: number; at: string } | null;
  /**
   * 各层最近一次 budget/exhausted（paused 派生：存在且无后续 `budget/topped-up` /
   * `budget/resumed`）。
   *
   * `resumable: false` **只在不可恢复的暂停上出现**（正常写入口写的都是 `true`，于是这一位
   * 恒为 undefined）：抬上限那条规则（`BudgetGuard.liftedPauses`）跳过带它的记录——一条不是
   * "预算用尽"的硬停，不该被"上限比已用大了"顺手解开。事件类型里 `resumable` 是字面量 `true`，
   * 所以这一位只有手写日志（或将来真的加了硬停）才会出现；留一位是为了让那种日志不被误放行，
   * 而不是说今天存在这种暂停。
   */
  lastExhausted: Partial<Record<BudgetLayer, {
    at: string; limit: number; actual: number;
    resumable?: false;
  }>>;
  /** dedupe 窗口：最近 1000 个 wake 幂等键（FIFO 淘汰） */
  dedupeKeys: string[];
  /** 最后一次成功的模型调用，用于判断水位是否停滞 */
  lastModelSuccessAt: string | null;
  /** 首事件时刻：总览页"已守护 N 天"的基准 */
  firstEventAt: string | null;
  /** 连续模型失败数 */
  failStreak: number;
  /** 模型降级链状态：非 null 表示正在降级运行 */
  degraded: { lane: ModelLane; since: string; reason: string } | null;
  /** 心跳连续空拍数（连续没有外部事件的拍数；**只用于诊断**——节律由概率模型决定，它不再参与排期） */
  idleTicks: number;
  /** 最近一次唤醒 */
  lastWake: { source: WakeSource; at: string } | null;
  /** 最近一条 assistant 发言截断（前 80 字符） */
  lastAssistantText: string | null;
  /** 最近一条 assistant 发言的时刻（压力计算用，取自事件 ts） */
  lastAssistantAt: string | null;
  /** 死信队列 */
  deadLetters: Array<{ inputSeq: number; claimCount: number; at: string }>;
  /** 最近一次日志归档/备份时刻 */
  lastArchiveAt: string | null;
  /**
   * 压力值（0-1）：由"欠着的事"（待审、挂起输入、到期意图、很久没说话）累加。
   * **不调制心跳节律**（概率模型只看安静时长）；它服务必要性门与诊断。
   */
  pressure: number;
}

export function emptyProjection(): Projection {
  return {
    lastSeq: 0,
    watermark: 0,
    pending: [],
    openTurn: null,
    openTools: [],
    needsReview: [],
    planPending: [],
    planApproved: [],
    budget: {
      budgetVersion: BUDGET_ACCOUNTING_VERSION,
      tokensToday: 0, tokensTodayHeavy: 0, tokensTodayLight: 0,
    date: null,
      cacheHitToday: 0, cacheMissToday: 0,
      tokensTask: 0, stepsThisTurn: 0, toolCallsThisStep: 0,
    },
    timers: [],
    claimedByTurn: {},
    intentions: [],
    todoList: [],
    jobs: {},
    humanAsks: [],
    waitingHuman: null,
    lastExhausted: {},
    dedupeKeys: [],
    lastModelSuccessAt: null,
    firstEventAt: null,
    failStreak: 0,
    degraded: null,
    idleTicks: 0,
    lastWake: null,
    lastAssistantText: null,
    lastAssistantAt: null,
    deadLetters: [],
    lastArchiveAt: null,
    pressure: 0.05,
  };
}
