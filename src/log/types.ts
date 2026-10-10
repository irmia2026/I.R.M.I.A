/**
 * Irmia Agent — 事件类型全集
 * 与 docs/schema.md §1-§7 逐字对齐。修改事件形状必须先改 schema 文档。
 *
 * 值导入写 `.ts`、纯类型导入写 `.js`（Node 的 --experimental-strip-types 只擦类型、
 * 不改写路径解析）。这里导入上下文审计的两个**类型**：它们是 `budget/consumed` 上
 * 两个可选字段的形状，TypeScript 会整条擦除，运行期不留依赖。
 */

import type { CacheBreak, ContextBreakdown } from '../model/context-audit.js';

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
  | { kind: 'aborted'; cause: 'user' | 'signal' | 'shutdown' }
  | { kind: 'interrupted' }
  | { kind: 'error'; message: string; code: string }
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

export interface TurnEnd extends EventEnvelope<'turn/end', {
  turn: number; reason: TurnEndReason; spoke: boolean;
}> {}

export interface StepStart extends EventEnvelope<'step/start', {
  turn: number; step: number; model: string;
  lane: ModelLane;
  renderVersion: string;
  personaHash: string;
}> {}

export interface StepEnd extends EventEnvelope<'step/end', {
  turn: number; step: number; toolCalls: number;
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

/** 思维链留存（internal；只供复盘，渲染层剥离——缓存铁律 3） */
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
  via?: 'dream' | 'mcp' | 'compact' | 'restart';
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
  durationMs: number; retryCount: number;
  finishReason: 'completed' | 'max_output_tokens' | 'failed' | 'aborted';
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
   * `turn-error`（整轮失败：模型/服务端拒了请求——输入不该就此消失，2026-10-02 补）。
   * 四者的共同语义是「这些输入回到队列里，还有一次完整机会」；差别只在记账。
   */
  reason: 'turn-interrupted' | 'startup-recovery' | 'human-answered' | 'turn-error';
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
  /** 认出来的指令种类；`unknown` = 打了斜杠但不在名单里（只回一句话，什么都不做） */
  kind: 'compact' | 'handoff' | 'unknown';
  /** 打出来的那个词（`unknown` 时是被打错的词——回话要点名） */
  name: string;
  /** 指令后面跟的那句话（理由）；没有就是空串 */
  argument: string;
  /**
   * 落地结果：
   *   · `compacted` —— 真的压了一次（同一批里紧随一条 `compaction/summary`）；
   *   · `empty`     —— 事件流里渲染不出条目，一个字都没改（不写空摘要）；
   *   · `rejected`  —— 不认识的词，只回了一句话，什么都没做。
   */
  outcome: 'compacted' | 'empty' | 'rejected';
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
 *     （`estimateMaskedTokens`），也就是"这次折叠将要改变的字节有多少"。
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
}> {}

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
   * 当时注入的那段索引文本的指纹（sha256 十六进制）。
   *
   * 它是"注进去的是哪一版"的唯一凭据：索引文件会被重建，事后从盘上读到的是**现在**那份，
   * 与当时未必相同——有指纹才分得清"重建对不上"是因为索引变了还是因为重建错了。
   */
  indexHash: string;
  /** 写这条账时注入的索引条数（规模；不是索引全文） */
  entries: number;
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
 * 判据是"这份快照还代表现在吗"，两个条件**任一**成立就重建（并如实写一条新事件）：
 *   • 日志里**还没有**任何 `mcp/index`（首次、或升级上来的老日志）；
 *   • 最后一条 `mcp/index` 的 `version` ≠ 当前 `RENDER_VERSION`，或者它的 `seq` **早于**
 *     最后一条 `compaction/summary`（那一刻上下文重大变化过 ⇒ 该归集了）。
 *
 * 为什么"重大变化点"只认 `compaction/summary`：它是本仓库里**唯一**的"上下文换了一版"的
 * 事实（自动压缩与界面 reset 都写它，人工 `/compact` 也写它），遮蔽点由它唯一确定
 * （`render` 的遮蔽规则）。配置改动**不是**触发点——今天所有字段都要重启才生效
 * （`config/watcher.ts` 的热更白名单是空的），进程一起就是"配置不动"的那段时间，
 * 中间只有工具清单缓存可能被后台刷新；那件事**必须**走尾部追加、不许改前缀。
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
}

export interface McpIndex extends EventEnvelope<'mcp/index', McpIndexSnapshot> {}

export interface SkillInstalled extends EventEnvelope<'skill/installed', {
  name: string; path: string; by: 'agent' | 'human';
  /**
   * SKILL.md 全文的内容哈希（信任门的变更检测凭据）：
   * 确认绑定内容，确认之后又被改动的目录自动退回待确认状态。旧事件可缺该字段。
   */
  contentHash?: string;
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
  /** 批准那一刻**重新算**的指纹（与 `grant/requested.contentHash` 不一致 ⇒ `stale`） */
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
   * **待办（本次没做，留给用户定）**：本文件头一行写着"修改事件形状必须先改 schema 文档"，
   * 而 `docs/schema.md` 里 `SpeakSent` 仍停在旧形状——本次按纪律没有动 `docs/`，
   * 下一次碰 schema 文档时要把 `sid?` / `text?` / `spokenParts?` / `turn?` 一并补上。
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

// ──────────────────────────────── 联合类型 ────────────────────────────────

export type AppEvent =
  | SessionStart | SessionEnd
  | RuntimeRestart
  | TurnStart | TurnEnd | StepStart | StepEnd
  | UserMessage | AssistantMessage | ReasoningMessage | DeveloperMessage
  | ToolCall | ToolResult
  | WakeTimer | WakeFile | WakeWebhook | WakeManual | WakeHeartbeat | WakeIntention | WakeJob | WakeChannel
  | ChannelMessage | ChannelRead | ChannelTopic | InjectionFlagged | InjectionNoted
  | ImageAttached
  | TimerSet | TimerFired | TimerCancelled
  | BudgetConsumed | BudgetRollover | BudgetExhausted | BudgetToppedUp | BudgetResumed
  | PolicyDenied | AuthzDenied | LogRepaired | InstanceTakeover
  | InputClaimed | InputDeadLetter | InputRequeued | InputDiscarded | ToolZombie
  | SlashHandled
  | AlarmSent | ReviewResolved | SnapshotCheckpoint | CompactionSummary | CompactionDecision
  | PersonaUpdated | ConfigChanged | MemoryMaintained | MemorySelected | MemoryRead
  | McpServerStarted | McpServerStopped | McpServerResource | McpIndex | SkillInstalled | HookFired | SpeakSent
  | GrantRequested | GrantResolved
  | IntentionRaised | IntentionActed | TodoUpdated
  | JobStarted | JobFinished
  | HumanAsked | HumanAnswered | HumanExpired
  | PlanPending | PlanResolved
  | AuthPasswordSet
  | AuthWebhookTokenRotated
  | ModelDegraded | ModelRestored;

export type AppEventType = AppEvent['type'];

/** 事件类型 → 默认可见性（写入时必须显式落定，此表用于校验与渲染分类） */
export const EVENT_VISIBILITY: Record<string, Visibility> = {
  'session/start': 'internal', 'session/end': 'internal',
  // 进程重启的留痕（2026-10-11）：**internal，而"叫她"是另一条事件**。
  // 这条是簿记——"这一任是什么时候起的、上一任怎么没的、谁拉起的"；给她看的是紧随其后的
  // 那条 `wake/manual{via:'restart'}`（正文才是对她说的话）。与压缩那一对
  // （`compaction/decision` internal + `wake/manual{via:'compact'}` model）逐字同形。
  // 写成 model 的代价是同一件事在她眼前出现两遍（见 RuntimeRestart 的注释 ②）。
  'runtime/restart': 'internal',
  'turn/start': 'internal', 'turn/end': 'internal',
  'step/start': 'internal', 'step/end': 'internal',
  'message/user': 'model', 'message/assistant': 'model', 'developer/message': 'model',
  'tool/call': 'model', 'tool/result': 'model',
  'wake/timer': 'model', 'wake/file': 'model', 'wake/webhook': 'model',
  'authz/denied': 'internal',
  'wake/manual': 'model', 'wake/heartbeat': 'model', 'wake/intention': 'model', 'wake/job': 'model',
  'wake/channel': 'model',
  // 通道普通消息与已读位**刻意不进上下文**：QQ 是"手边一个可以点开的软件"而不是推给她的消息流。
  // 它们不写在这里也走 defaultVisibility 的 internal，写出来是为了让"这条线是有意画的"看得见
  // ——她通过未读计数知晓它存在，想看就用 read_channel 现取（README/review v32 记了这次取舍）。
  'channel/message': 'internal', 'channel/read': 'internal', 'channel/topic': 'internal',
  // 注入预警同样 internal：它不是给她的输入，而是**贴在**那条外部消息旁边的一句框架话
  // （渲染时按 messageId 关联，见 model/render.ts 的 renderExternalEvent）
  'injection/flagged': 'internal',
  // 「示警已发生」同理：那句话贴在那条消息旁边，GUI 与此刻层历史只是引用它
  'injection/noted': 'internal',
  // 她自己要求放进来的图：与 wake/channel 的附件同一条出口（渲染层注入 input_image）
  'image/attached': 'model',
  // 抬上限解除暂停：与 session/* 同一条口径——它是**簿记**（谁解的、凭什么解的），
  // 不是给她的输入。她该看见的是"又能干活了"这件事本身（下一次 turn），
  // 而不是框架内部的解扣动作；写出来是为了让"这条线是有意画的"看得见
  'budget/resumed': 'internal',
  'human/asked': 'model', 'human/answered': 'model',
  // 超时事实同样进上下文：她必须**得知**"人可能不在机器旁、或没注意到"才能自己决定下一步
  // （design §6.1：换个方式找人是她的判断）。写成 internal 等于让这件事只留在日志里，
  // 她下一拍还是以为自己在等人回话——那正是 §6.5 禁止的那种"等"。
  'human/expired': 'model',
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
