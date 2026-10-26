/**
 * Irmia Agent — 默认工具集装配（main.ts 与 cli.ts 共用的一份清单）
 *
 * 存在的唯一理由：**工具清单是 render 的输入之一**，而 render 是"可重建"承诺的核心
 * （docs/schema.md §13：模型请求的全部内容可由 model 事件 + 人格资产重建）。
 * 事后重建（`replay <turn> <step>`、`doctor` 的 internal 抽查）必须与运行期拿到**同一份**
 * 工具说明，否则重建出来的输入与当时不一致，而"重建不一致"这件事是查不出来的——
 * 它看起来永远像"模型当时就是这么看到的"。
 *
 * 因此装配顺序、注册选项、视角（`listForModel` 的 destructive 开关）都在这里落定一处：
 *   buildFsTools → createNetTools → createVisionTools → createAdminTools → buildShellTools
 * 与 docs/design.md §4.10 的第四级（按需工具）一致。main.ts 只是调用方之一。
 *
 * 零外部依赖：只用 node: 标准库。
 */

import { dirname, join } from 'node:path';

import type { TimerStore } from '../wake/timer-store.js';
import type { JobManager } from '../runtime/job-manager.js';
import type { EventLog } from '../log/event-log.js';
import type { AppEvent, Projection } from '../log/types.js';
import type { WakeChannel, MemoryRead } from '../log/types.js';
// 值导入：vision 的 emit 适配层要**显式**给出可见性（见下面那一处注释）
import { defaultVisibility } from '../log/types.ts';
import type { DepsManager } from '../deps/manager.js';
import type { DsClient, DsResponse } from '../model/ds-client.js';
import type { MediaPoster, AdminEventEmitter, ChannelNameResolver, ChannelNoticeReader, ChannelReader, ChannelSelfActionReader, ChannelSessionRow, ChannelSpokenReader, InputNotifyPoster, Notifier, PersonaUpdatedPayload, ReplyPoster } from './admin.js';
import type { ToolDefinition } from './types.js';
import type { ListForModelOptions, ToolModelSpec } from './registry.js';
import type { IsolationConfig, ToolPlanGate } from './executor.js';
import type { BlobOffloadOptions } from '../state/blob-store.js';
import type { HookRunner } from '../hook/hooks.js';
import type { VisionModelClient } from './vision.js';
import type { AgentLoopPersona } from '../runtime/agent-loop.js';
import type { TaskBudgetGuard, TaskToolDeps } from '../runtime/subagent.js';
import { createTaskTool, TASK_TOOL_NAME } from '../runtime/subagent.ts';
import { createAdminTools } from './admin.ts';
import { createNetTools } from './net.ts';
import { ANYSEARCH_SKILL_DIR, createWebSearchTool } from './web-search.ts';
import { createPwshTool, LANG_INTERPRETERS, type LangDepProbeOutcome } from './pwsh.ts';
import {
  DEP_SPECS,
  isManagedHit,
  managedInterpreterOf,
  pathInterpreterSlotOf,
} from '../deps/probe.ts';
import { defaultDepFs } from '../deps/manager.ts';
import { buildFsTools, DEFAULT_READ_ONLY_PREFIXES } from './fs/index.ts';
import { createVisionTools } from './vision.ts';
import { createMemoryReadTool } from './memory-tools.ts';
import { createMcpEntryTool, type McpEntryClient } from './mcp-entry.ts';
// 「我做过」的判据（认不认这个动作 / 怎么渲染）**只有那一处**：这里只把回执交给它
import { recordSelfAction } from '../channel/self-action.ts';
// 申请单目录（`<dataDir>/grants`）：只用于 `mcp` 入口回执里那句指路，不进 `tools` 段
import { grantsDirOf } from '../grant/mcp-grant.ts';
import { ToolRegistry } from './registry.ts';
import { TimerStore as TimerStoreClass } from '../wake/timer-store.ts';

// ──────────────────────────────── 只读区 ────────────────────────────────

/**
 * 人格资产在**工作根口径**下的路径（相对 `ctx.workspaceRoot` = 仓库根）。
 *
 * 为什么是字面量而不是从 `dataDir` 拼：`readOnlyPrefixOf` 比的是 `guarded.relPath`
 * （相对工作根），而 personaRoot 是 `<dataDir>/persona`。两者只有在 dataDir 恰好是
 * `<仓库根>/data` 时才重合——那是本仓库的约定（`config.ts` 的默认值就是它），
 * 而且 `write_persona` 的落点与它必须一致才有意义。改这两处之一时，另一处要一起看。
 */
export const PERSONA_READ_ONLY_PREFIX = 'data/persona';

/**
 * 技能资产在**工作根口径**下的第二种写法（`<工作根>/data/skills`）。v79 技能搬进数据目录
 * 之后才有这一条，判据与上一条**逐字同形**（只在默认布局下与 `<dataDir>/skills` 重合）。
 *
 * 为什么非有它不可：别名表把 `skills/` 接到 `<dataDir>/skills`，**但别名不接管
 * `data/skills/…` 这种写法**（首段是 `data`）——别名+只读区只堵住了模型实际会写的那一个
 * 前缀，而"数据目录里的技能"现在是真资产；少了这一条，`safe_write data/skills/<name>/SKILL.md`
 * 就成了唯一一条**改得动技能目录**的路（design §4.19 要求的是"可读、不可改"）。
 */
export const SKILLS_DATA_READ_ONLY_PREFIX = 'data/skills';

// ──────────────────────────────── 选项 ────────────────────────────────

export interface ToolCatalogOptions {
  /** 数据目录：fs 工具白名单根、vision 缓存、admin 的 personaRoot 都以它为准 */
  dataDir: string;
  /** 定时器存储（admin 的 `timer` 工具用；CLI 只读场景传一份不布防的实例即可） */
  timers: TimerStore;
  /** 事件写入口（admin 工具的唯一出口；没有它这些动作不可复盘） */
  emit: AdminEventEmitter;
  /** 模型通道（vision 工具用）。不传时给一个"未接线"实现：注册可用，调用即报错 */
  visionClient?: VisionModelClient;
  /** persona 写入后的副作用钩子（刷新人格缓存、重算 personaHash） */
  onPersonaUpdated?: (payload: PersonaUpdatedPayload) => void;
  /**
   * pwsh 的破坏性命令开关。**调用方不传时 false**（安全兜底，与 design.md §4.10 第三级门一致）；
   * 生产装配传的是 `config.tools.destructiveEnabled`，它的出厂默认是 `true`（2026-10-21 用户裁决）。
   */
  destructiveEnabled?: boolean;
  /**
   * `task`（隔离子代理工具，design §4.21）注不注册。**默认 false = 不注册**。
   *
   * 为什么默认不开（理由与 `grep` / `find` 那两件**不一样**）：那两件是"本机装了才
   * 存在"，判据在机器上；这一件的判据在**代价**上——工具清单是请求**冻结前缀**的一部分
   * （docs/schema.md §13：模型请求的全部内容可由 model 事件 + 人格资产重建），
   * 多一件 = 每次请求都多付一份 schema（常驻 token），而且**清单变化的那个 turn 必然是一次
   * 缓存 miss**（前缀变了，服务端缓存整段失效）。它是一件"加了就再也拿不掉"的常驻开销，
   * 所以要人显式要，而不是默认替所有人付。
   *
   * 打开之后会发生什么（实测数见 docs/operations.md §1.2）：清单 24 → 25 件、`tools` 段
   * +172 token（它自己那一件：name 1 + desc 76 + params 95）、她多一件能"整块外包"的工具
   * （子代理独立上下文、预算从父扣、默认不能再下派）。
   */
  taskEnabled?: boolean;
  /**
   * `task` 的运行期依赖（装配期给**取值器**，调用期才解析）。
   *
   * 为什么必须惰性：装配顺序上"建注册表"在"建 RealLoop / 拿到投影与人格"之前，而子代理要的
   * registry / projection / persona 三样都在循环那一侧。取值器让装配点不必提前持有循环对象，
   * 也让 `task` 在被调用那一刻拿到**当时**的账（不是装配那一刻的快照）。
   *
   * 不传 = `task` 即使被要求打开也造不出来（那时 `onNote` 里会如实说明），
   * 因为一个没有运行期的 `task` 只会把"未接线"当成工具结果回给她。
   */
  taskRuntime?: TaskToolRuntimeResolver;
  /**
   * MCP 入口（`mcp` 工具，2026-10-09 用户拍板：「增加一个内置 mcp 工具。此后 mcp 都从此工具调用。」）。
   *
   * **给了它就一定注册、无条件常驻**——这是这一件与 `task` / `grep` 那一类**相反**的地方：
   *   · `task` 是条件注册（它只是"多一件能力"，不加也不缺什么）；
   *   · `mcp` 是**唯一入口**：不注册 = 她一件 MCP 工具都没有（没有第二条路可走）。
   *     而"按有没有声明 server 决定注不注册"这条判据在这里是**有害**的：声明面一变就改
   *     `tools` 段 ⇒ 一次全 miss ≈ 9.6 万 token（实测见 `render.ts` 的 v42/v43 记录）。
   *     所以"一个 server 都没声明"也照旧常驻，调用时由工具自己如实回一句"没有已声明的 server"。
   *
   * 不传 = 这个进程里没有 MCP 池（CLI 的 replay / doctor、没有 key 的假循环分支、测试台）：
   * 那时**不注册** `mcp`，因为一件"永远报未接线"的入口只会让她反复试一条不存在的路。
   */
  mcpClient?: McpEntryClient | undefined;
  /**
   * MCP 入口那件的**危险动作开关**（`config.tools.destructiveEnabled`）。
   *
   * 为什么它是取值器而不是快照：同一份值在 `main.ts` 已经读了一次（`destructiveTools`），
   * 而它决定的是"这一刻允不允许动危险动作"——取值器让宿主将来支持热更时不必回头改这里。
   * 披露式下**这是唯一还管得住 MCP 的那道门**（MCP 的工具不进注册表，`registry` 的
   * destructive 过滤够不着它们），理由与代价见 `tools/mcp-entry.ts` 的文件头那张表。
   */
  mcpDestructiveEnabled?: (() => unknown) | undefined;
  /**
   * 她递**申请单**的那个目录（`<dataDir>/grants`，2026-10-11 加）。
   *
   * 它**只影响 `mcp` 入口回执里那一句指路**（"没有 server 时你可以自己加一个"那一段），
   * **不进 `tools` 段**——描述与参数表一个字节都没动。
   *
   * 三态：
   *   • 不传 ⇒ 缺省 `<dataDir>/grants`（生产那条路）；
   *   • 给一个字符串 ⇒ 用它（宿主自己知道那个目录在哪时）；
   *   • **给 `null`** ⇒ 明说"这一处不知道那个目录在哪"（测试台 / 离线装配）：
   *     回执退回改前那句"走界面「扩展 → MCP」"，**不编一个不存在的地方让她去写单子**。
   */
  mcpGrantsDir?: string | null | undefined;
  /**
   * 单条工具回执的上限（blob 外置），**与主循环同一把尺**。
   * `mcp` 的清单披露与 `task` 的子代理回执都读它——这两条路都会产生"可能很长"的结果。
   */
  blobOffload?: BlobOffloadOptions | undefined;
  /**
   * 外部依赖管理器（`src/deps/`，v30）。**探测只做一次**的来源：
   *   · `buildFsTools` 用它决定 grep / find 注不注册（没装就不注册）；
   *   · pwsh 工具用它拿默认 shell（探测到的 pwsh 7，可能是 PATH/自装目录/用户指定）。
   * 不传时各处各自兜底探测——CLI 只读场景（replay / doctor）也就能白拿一份缓存。
   */
  deps?: DepsManager | undefined;
  /**
   * 装配期的如实告知出口（启动日志）。**条件注册的工具不出现时不能无声无息**：
   * 用户点名要"保留没有时如实告知"——注册层面拿掉它，日志里必须说清为什么。
   */
  onNote?: ((message: string) => void) | undefined;
  /**
   * 受保护配置文件（绝对路径，如 `data/hooks.json`）：fs 写入口一律拒绝（design.md §4.19 第 5 条）。
   * 这类文件定义的是「谁能改我」——agent 能写它就等于没有门，因此拦在写入点而不是提示词里。
   */
  protectedPaths?: readonly string[];
  /**
   * `memory_read` 的访问账出口（design §4.17 第 2 条"访问强化"）。
   *
   * 拿到的是**完整的 `memory/read` payload（含 turn）**，宿主直接 `emit('memory/read', data)` 即可
   * ——turn 由工具层从 `ctx.turn` 交出来，所以这里不需要"当前是哪一轮"这种跨层状态。
   *
   * 不传时 `memory_read` 照常注册、只是不记账。**但那时必须有人在别处说清楚**：
   * §4.17 第 2 条一直"设计里有、实现里没有"，别让这条通道又变成那样。
   */
  memoryReadRecorder?: (data: MemoryRead['data']) => void;
  /**
   * `vision_read` 的**用量账出口**（2026-10-11 加，与上面 `memoryReadRecorder` 同形同一条纪律）。
   *
   * 拿到的是**整个 `DsResponse`**（含 `usage`），宿主据此记一条
   * `budget/consumed{lane:'light', origin:'tools/vision'}`——字段与 `channel/topic.ts` 那一段
   * 逐字段同形（那里是既有的 light 记账写法）。
   *
   * 为什么必须由宿主接：`ToolContext` 里没有 `log` / `nextSeq()`，而 vision 的事件出口只有
   * `image/attached` 一种（"vision 只该有写这一种事件的能力"）⇒ **它自己一条账都写不出来**。
   * 这正是 2026-10-11 之前的状态：64 次真实模型请求、一条账都没有（真发出去的次数是工具
   * 自报的 `fresh` 字段数出来的，见 `_ops-light2\REPORT.md` ②）。
   *
   * 不传时 `vision_read` 照常注册、只是不记账。**但那时必须有人在别处说清楚**——这正是
   * 上面那一格注释的原话，也是这一格存在的理由。
   */
  visionRecorder?: (response: DsResponse, turn: number, step: number) => void;
  /**
   * 后台任务管理器（design §4.21 jobs）。传了它，pwsh 的 `runInBackground` 才能用。
   * 不传时后台模式被拒绝并说明原因（不静默降级成前台阻塞）。
   *
   * 用 getter 而不是直接传 JobManager：装配顺序上「建注册表」与「建 JobManager」
   * 互相依赖，惰性取回调让两者都不需要知道对方的构造时刻。
   */
  jobs?: () => JobManager | null;
  /**
   * 告警出口（speak 的第二路）：不传时 speak 如实报"未配置告警出口"，而不是假装成功。
   *
   * v27 之后它只服务 speak / report 这一条路——独立的 `notify` 工具删掉了
   * （与 speak 重复：model 侧有两个"推一条给人"的入口，实测都走 speak）。
   */
  notifier?: Notifier;
  /**
   * 当前 turn 的回投会话（M9）：由宿主提供（真循环给的是本拍分派的 wake/channel），
   * 返回 null 表示这一轮没有可回投的 IM 会话——speak 的第三路如实报"跳过"。
   *
   * 用回调而不是快照：speak 在 turn 中途被调用，那一瞬的值才是要用的值。
   */
  currentWakeChannel?: () => WakeChannel['data'] | null;
  /** 回投实现（默认全局 fetch）；接了 IM 通道时换成通道自己的发送器 */
  replyPoster?: ReplyPoster;
  /**
   * "正在输入"的投递口（`config.speak.inputNotify` 为真时由宿主装配）。
   *
   * 不传 = `speak` 一次都不发那个状态——"关掉开关"这条路径因此在**接线层**就断了，
   * 工具层不必再判一遍（也就没有"两处判据、漏一处"的余地）。
   */
  inputNotify?: InputNotifyPoster;
  /**
   * 图片直通是否开启（`config.vision.imagesToContext`）。
   *
   * 它决定 `vision_read` 的 `inline` 参数能不能用：开了才有"把原图放进上下文"这条路
   * （写一条 `image/attached` 事件，渲染层注入 input_image）；关掉时如实报不可用，
   * 而不是写一条没人看的事件让她以为"我看见了"。
   */
  visionImagesToContext?: boolean;
  /** 发言节奏（`config.speak`）：打字效果开关与速度，交给 speak */
  speakTyping?: { typingEffect: boolean; charsPerMinute: number };
  /**
   * 「他刚说了什么」：speak 被人插话打断时，用它把对方的新话写进回执。
   * 用回调而不是快照——打断发生在 speak 执行途中，那一刻的值才是要用的值。
   * 一并给出那条唤醒的 `wakeSeq`（speak 据此销账，见 `ToolContext.claimInterruption`）。
   */
  userSpoke?: () => { text: string; wakeSeq: number } | null;
  /**
   * IM 消息读取口（`read_channel` 用）：工具层不读日志，所以由宿主把它递进来。
   * 不传时 read_channel 照常注册，但一调就如实报"宿主没接线"（而不是假装读到空）。
   */
  channelReader?: ChannelReader;
  /**
   * **会话簿**（`read_channel` 不给 `sid` 时列的那一份；v66）。
   *
   * 与 `channelReader` 同一条纪律：宿主注入，工具层不读日志、也不维护会话簿。
   * 这是**取值器**（不是快照）：会话簿逐拍在长，而 catalog 先于 RealLoop 就位
   * （与 `selfIds` / `userSpoke` 同一形状）。
   */
  channelSessions?: () => readonly ChannelSessionRow[];
  /**
   * 她在这个会话里**说过的话**（`read_channel` 用）：宿主注入。
   *
   * 与 `channelReader` 分开是因为来源不同：一个是别人发来的消息（`wake/channel` /
   * `channel/message`），一个是她自己的投递回执（`speak/sent` 带 text 的那条）。
   * 不传时 read_channel 照常可用，只是读不到自己的发言。
   */
  channelSpokenReader?: ChannelSpokenReader;
  /**
   * 这个会话里**发生过的事**（`channel/notice`：管理动作/入群退群/撤回……）——`read_channel` 用。
   *
   * 与上面两个读取口同一条纪律：宿主注入，工具层不读日志。不传时 read_channel 照常可用，
   * 只是读不到群里动静（**不假装没有**：这一屏本来就是那一段日志的回放）。
   */
  channelNoticeReader?: ChannelNoticeReader;
  /**
   * 这个会话里**她做过什么**（`channel/self-action`：「我做过」）——`read_channel` 用。
   *
   * 与上面几个读取口同一条纪律：宿主注入，工具层不读日志。不传时 read_channel 照常可用，
   * 只是读不到她自己的管理动作（**不假装没有**：这条凭据是从 MCP 回执补的，
   * 没有它她下一次翻那个群就看不到"我设过全员禁言"）。
   */
  channelSelfActionReader?: ChannelSelfActionReader;
  /**
   * **我自己**那几个标识（`read_channel` 渲染群里动静时用）。
   *
   * 用途只一处：notice 里说的若是**我自己**（"我被移出群聊"），那一行要写成 `我`
   * 而不是一个查不出名字的 id 锚。递的是宿主那一份判据对象（`channel/self-identity.ts` 的
   * `SelfIdentity`）——**现读**，因为"我是谁"是运行期长出来的。
   */
  selfIds?: () => readonly string[];
  /**
   * 会话名解析（`read_channel` 的渲染用）：sid → 名字。
   *
   * 与 `render.ts` 的 `channelRender` 是同一件事的两个入口（一个给旧消息回放、一个给本轮唤醒），
   * 名字的真源只有一处——宿主知道她的别名表和人声明的联系人表，工具层两样都不读。
   */
  resolveChannelName?: ChannelNameResolver;
  /** 这一轮叫她的那条消息（提及/@；read_channel 对那个会话一律照给，见 admin.ts） */
  mentionMessage?: () => { sid: string; messageId: string } | null;
  /** 媒体投递口（`send_media` 用）：宿主注入 */
  mediaPoster?: MediaPoster;
  /** 发言人（openid）→ 名字：read_channel 每行那个"谁"（不是会话名） */
  resolvePersonName?: (person: string) => string | null;
  /**
   * 本机时区（IANA 名）：`read_channel` 每行那个短时间用它（`MM-DD HH:MM`，她不用自己换算）。
   * 与此刻层 `时刻：` 同一条纪律（v26）；工具层不读配置，所以由宿主递进来。
   */
  timezone?: string;
  /**
   * `ask_human` 回执里报的等待时长（`config.tools.askHumanTimeoutMin`，毫秒）。
   * 不传时走工具自己的兜底默认——超时事实的落库在 real-loop，两处读同一个配置值。
   */
  askHumanTimeoutMs?: number;
}

/**
 * `task` 的运行期素材（装配点逐格给；缺任何一格就读不到"当时"）。
 *
 * 一个字段都不在这里**推导**：工具层不读配置、不读循环——registry / projection / persona /
 * guard / planGate 各自的主都在别处（注册表在 buildCatalogRegistry、投影与人格在 main.ts、
 * 判定器与计划门在 RealLoop）。这里只是把它们递到调用那一刻。
 */
export interface TaskToolRuntimeDeps {
  /** 父注册表（`buildCatalogRegistry` 造的那一个：MCP 上线的新工具也在里面） */
  registry: ToolRegistry;
  /** 父投影（`recovery.projection`）：预算基线与记账回流都走它 */
  projection: Projection;
  /** 人格常驻层（与主循环**同一个对象**，main.ts 的 onPersonaUpdated 就地在它身上改字段） */
  persona: AgentLoopPersona;
  /** 事件日志（子代理链的写入经它） */
  log: EventLog;
  /** 模型客户端（与主循环同一个；子代理换车道靠 `lane` 参数，不换客户端） */
  ds: DsClient;
  /** 时钟注入；缺省 = 工具内置兜底（本机时钟的 ISO 串） */
  now?: (() => string) | undefined;
  /** 本机时区（与 read_channel 那条同源：config.timezone） */
  timezone?: string | undefined;
  /** 父循环那一份刹车判定器（有效上限含人工加注）。不传 = 用工具内置兜底上限 */
  guard?: TaskBudgetGuard | undefined;
  /** 进模型清单的口径，与父一致（real-loop 给的是 `{includeDestructive: config.tools.destructiveEnabled}`） */
  modelVisibility?: ListForModelOptions | undefined;
  /** 计划模式门（与父共用同一个实例，见 subagent.ts 的 TaskRuntime.planGate） */
  planGate?: ToolPlanGate | undefined;
  hooks?: HookRunner | undefined;
  isolation?: IsolationConfig | undefined;
  skillCatalog?: string | null | undefined;
  /**
   * 单条工具回执的上限（2026-10-06 加）：子代理和父循环**必须用同一把尺**。
   *
   * 不传的后果很具体：子代理自己的上下文没有这条上限，一次 `pwsh` 的真实输出
   * （实测最长单条 16.5 KB 正文）或一次 `safe_read` 的大文件回执就把它自己的窗口吃掉，
   * 而它连"结果被截断了、全文在哪"都看不到。父循环的同一条上限见
   * `agent-loop.ts` 的 `blobOffload`（唯一写入点 `recordToolResult`）。
   */
  blobOffload?: BlobOffloadOptions | undefined;
}

/**
 * 运行期素材里**只有循环才知道**的那一半（`RealLoopDeps.taskRuntime` 的形状）：
 * 刹车判定器、计划门、执行点钩子、隔离配置、技能索引、时钟。
 *
 * 它**与宿主那半格子合并后**才是一份完整素材：装配点给 log / ds / registry / projection /
 * persona / modelVisibility（那些在装配期或者稍后就有），循环给这一半。两半用同一个键名，
 * 合并规则是"循环的覆盖装配点的"（见 real-loop 的 agentDeps）——因为循环给的都是**活**的东西
 * （判定器实例会被加注换掉），谁都不可能比它更知道"现在"。
 */
export type TaskLoopRuntimeDeps = Partial<TaskToolRuntimeDeps>;

/**
 * 运行期取值器。返回 `null` = 这一刻没有运行期（假循环分支、CLI 只读路径）：`task` 会如实
 * 报"未接线"，而不是拿一份空投影去跑（那会把子代理的账记在一个不存在的父上）。
 */
export type TaskToolRuntimeResolver = () => TaskToolRuntimeDeps | null;

/** 未接线的模型通道：把"CLI 里调不动 vision"变成一条可读的错误，而不是一个静默的空实现 */
export function unwiredVisionClient(): VisionModelClient {
  return {
    generate: () => Promise.reject(new Error(
      'vision 工具需要模型通道，当前进程没有接线（CLI 只做请求重建与自检，不发起模型调用）',
    )),
  };
}

// ──────────────────────────────── 装配 ────────────────────────────────

/**
 * 默认工具集的工具定义清单（顺序即断言顺序：render 的 tools 数组按注册顺序序列化，
 * 顺序变了就是一次缓存前缀变更，必须是有意为之）。
 *
 * async 的唯一来源是 fs 那一族：find 要探测到 es.exe 才注册（见 fs/index.ts），
 * 而"清单里有哪几件"必须落定之后才谈得上顺序。
 */
export async function buildToolCatalog(options: ToolCatalogOptions): Promise<ToolDefinition[]> {
  const visionClient = options.visionClient ?? unwiredVisionClient();
  const adminKit = createAdminTools({
    timers: options.timers,
    emit: options.emit,
    personaRoot: join(options.dataDir, 'persona'),
    ...(options.notifier !== undefined ? { notifier: options.notifier } : {}),
    ...(options.onPersonaUpdated !== undefined ? { onPersonaUpdated: options.onPersonaUpdated } : {}),
    // 回投接线（M9）：有 IM 通道时 speak 的第三路才有地址；没有就如实跳过
    ...(options.currentWakeChannel === undefined ? {} : { currentWakeChannel: options.currentWakeChannel }),
    ...(options.replyPoster === undefined ? {} : { replyPoster: options.replyPoster }),
    // "正在输入"（2026-10-11）：只在宿主装了它时才有这一下。**与 replyPoster 分开传**——
    // 它们的失败语义完全不同（见 admin.ts 里 InputNotifyPoster 那段注释）。
    ...(options.inputNotify === undefined ? {} : { inputNotify: options.inputNotify }),
    // 发言节奏与"他刚说了什么"：都只服务 speak（见 admin.ts）
    ...(options.speakTyping === undefined ? {} : { speakTyping: options.speakTyping }),
    ...(options.userSpoke === undefined ? {} : { userSpoke: options.userSpoke }),
    // read_channel 的两个注入点（v32）：消息从日志里来、名字从她的别名表与人的联系人表来。
    // 两样都在宿主的视野里，工具层只接收结论。
    ...(options.channelReader === undefined ? {} : { channelReader: options.channelReader }),
    // 会话簿（v66）：`read_channel` 不给 sid 时列的那一份。取的是**同一个口**
    // （`RealLoop.sessions()`，此刻层那张清单也读它）⇒ 两处不可能各说各的会话。
    ...(options.channelSessions === undefined ? {} : { channelSessions: options.channelSessions }),
    // 她自己在这个会话里说过的话（2026-10-04）：同一个来源（日志里的投递回执），
    // 只是读法不同——它不参与未读与话题，只让 read_channel 能摆出"我已经回过什么"。
    ...(options.channelSpokenReader === undefined ? {} : { channelSpokenReader: options.channelSpokenReader }),
    // 群里发生过的事（2026-10-11）：同一个来源（日志），只是**另一种事件**——
    // 她读一个群时，那一行 `[阿岚 开启了全员禁言]` 就走这个口进来
    ...(options.channelNoticeReader === undefined ? {} : { channelNoticeReader: options.channelNoticeReader }),
    // 她自己的管理动作（「我做过」，2026-10-11）：同一个来源（日志）、**第四种事件**——
    // 她翻一个群时那一行 `（我）：[全员禁言 · <群名> · 开启]（回执 ok）` 就走这个口进来
    ...(options.channelSelfActionReader === undefined ? {} : { channelSelfActionReader: options.channelSelfActionReader }),
    // 「我自己是谁」（2026-10-11）：notice 那一行里说"我"的时候要用它。递的是**取值器**而不是快照：
    // 这份认知是运行期长出来的（OneBot 等 self_id、官方等 /users/@me 或群里 @ 我的事件）
    ...(options.selfIds === undefined ? {} : { selfIds: options.selfIds }),
    ...(options.resolveChannelName === undefined ? {} : { resolveChannelName: options.resolveChannelName }),
    // read_channel 每行那个短时间要本机时区（与此刻层 `时刻：` 同一条纪律：换算不该由她做）
    ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
    ...(options.mentionMessage === undefined ? {} : { mentionMessage: options.mentionMessage }),
    ...(options.mediaPoster === undefined ? {} : { mediaPoster: options.mediaPoster }),
    ...(options.resolvePersonName === undefined ? {} : { resolvePersonName: options.resolvePersonName }),
    // ask_human 的回执要说清"多久之后你会得知他可能不在"：这个数字与 real-loop 落 human/expired
    // 用的是同一个配置值，两处各写一个数必然漂移
    ...(options.askHumanTimeoutMs === undefined ? {} : { askTimeoutMs: options.askHumanTimeoutMs }),
  });

  return [
    ...await buildFsTools({
      dataDir: options.dataDir,
      // 受保护文件（钩子配置等）的绝对路径：fs 写入口据此拒绝，读不受限
      ...(options.protectedPaths !== undefined ? { protectedPaths: options.protectedPaths } : {}),
      // 依赖探测的唯一来源：两件搜索工具注册与否都照它的结论（没装就不注册）
      ...(options.deps !== undefined ? { deps: options.deps } : {}),
      ...(options.onNote !== undefined ? { onNote: options.onNote } : {}),
      // ── 人格资产只读（P2，2026-10-04）──
      //
      // 实测：STATE.md 被改 87 次，其中 62 次（71%）走 `safe_edit`——那条路**不写
      // `persona/updated`、也不进人格版本库**（版本快照落在 workspace scope，
      // `irmia persona log/diff/rollback` 读的是 persona scope，看不见）。
      // "persona/ 只有 write_persona 一个写通道"这句话写了好几个版本，但从来没在代码里落过：
      // fs 包不知道 persona 的存在，只读区的默认值只有 skills/ 与 .agents/skills/。
      //
      // 现在把它真正拦在写入口（拦截点早就在 `guardedWrite` 的第零步，只是没登记这个前缀）。
      // **必须与 write_persona 的局部替换形态同批上线**：只堵洞不加形态，等于把她从
      // "改一行"逼成"重写整篇 65 行的 STATE.md"——那是拿审计问题换质量与成本问题。
      //
      // 前缀是**相对 ctx.workspaceRoot（仓库根）**的路径，与 `personaRootOf` 的落点同源；
      // P1 的别名表把 `persona/STATE.md` 也改写到同一处，所以两种写法都拦得住。
      //
      // v79：技能搬进数据目录（`<dataDir>/skills`，与 persona/ 同级）之后多登记一条同形状的
      // 前缀 `data/skills`——任务（1）写在 `SKILLS_DATA_READ_ONLY_PREFIX` 的注释里：
      // 别名表接的是 `skills/`，`data/skills/…` 这种写法别名不管，只读区必须自己覆盖。
      readOnlyPrefixes: [...DEFAULT_READ_ONLY_PREFIXES, PERSONA_READ_ONLY_PREFIX, SKILLS_DATA_READ_ONLY_PREFIX],
      readOnlyHints: {
        [PERSONA_READ_ONLY_PREFIX]:
          '人格资产请用 write_persona 改（给 content 整体替换，或给 old/new 只换那一段）——'
          + '它才会记 persona/updated 并留下人格版本；用通用文件工具改，那条改动在人格时间线里是隐形的。',
        [SKILLS_DATA_READ_ONLY_PREFIX]:
          '技能目录（数据目录里的那一份）模型可读、不可改：读正文用 safe_read（skills/<name>/SKILL.md）；'
          + '要改内容请由人修改后重新确认技能（改动会让内容哈希失配、自动退回待确认）。',
      },
    }),
    ...createNetTools(
      // 出网写入类（http_post / http_download）是 destructive 工具：§4.10 的第三级门要求
      // 「配置里显式开启才注册」。开关接的是 config.tools.destructiveEnabled。
      //
      // 两个开关都要拨：以前这里只传了 enablePost，于是 http_download 无论配置怎么写都不存在
      // ——而她是会收到图片的（QQ 富媒体给的是**临时直链**），手里没有下载工具时她只能
      // 自己拼 pwsh 的 Invoke-WebRequest，或者干脆回一句"图加载不出来"（实测两次都是后者）。
      options.destructiveEnabled === true ? { enablePost: true, enableDownload: true } : {},
    ),
    // 联网搜索（v52，用户裁决「web_search 要做就做好做强大」）。
    //
    // **无条件常驻**（与 `mcp` 那件同一条判据，与 `task` 相反）：它不是"多一件能力"，
    // 而是那条**她一直在手搓的路**的固化——`skills/anysearch/` 的四条 CLI 今天没一条
    // 干净可用（py 缺 requests、js 被 `type:module` 顶成 ESM、ps1 撞证书吊销），
    // 她真正跑通的是手写 `curl --ssl-no-revoke` 直打端点。
    // 条件注册在这里是有害的：判据（技能装没装）一变就改 `tools` 段 ⇒ 一次全 miss ≈9.6 万 token。
    // 技能目录不在时它照旧注册、照旧能用（端点支持匿名，只是配额低），回执里如实说来源。
    createWebSearchTool({
      ...(options.onNote === undefined ? {} : { onWarning: options.onNote }),
      // 技能根：v79 起技能实体住在**数据目录**（`<dataDir>/skills`，与 persona/ 同级）——
      // 那份 `.env` 也在这一份里（种子是整份复制的，`.env` 跟着过去）。
      // 读了它才有"技能文档里那份 .env 快路径"；读不到就是匿名档，不报错。
      // 目录名只有一处（`web-search.ts` 的 `ANYSEARCH_SKILL_DIR`），不在这里再写一遍字面量。
      // ⚠ 以前这里拼的是 `process.cwd()`（安装根/仓库根）：技能搬家之后那已经是**出厂种子**，
      // 照旧读它会出"改了数据目录里那份 `.env` 却不生效"——所以这一格跟着 baseRoot 一起搬。
      skillRoot: join(options.dataDir, ...ANYSEARCH_SKILL_DIR.split('/')),
    }),
    ...createVisionTools({
      dsClient: visionClient,
      dataDir: options.dataDir,
      // 图片直通的另一半（design §4.20）：`inline` 模式要写一条 image/attached 事件，
      // 因为工具结果只能是文本、塞不下图片。事件出口在这里包一层——vision 只该有
      // 写这一种事件的能力，不该拿到任意写权限。
      //
      // **可见性必须由这一层给**（2026-10-11 修的一处静默失效）：vision 的窄接口
      // （`vision.ts` 的 `VisionToolOptions.emit`）里根本没有 visibility 这一格——它只该写
      // 这一种事件，所以"该给什么可见性"这个问题只能落在这个适配层，而答案在 schema 表里
      // （`image/attached` = model）。原先是 `(type, data) => options.emit(type, data)`：
      // 第三个参数被这一层吃掉，事件落成 internal，渲染层（`isModelVisible`）不看它
      // ⇒ **回执写着"图片已放进你的上下文"，请求体里一张图都没有**（实测：input_image = 0）。
      emit: (type, data) => options.emit(type, data, defaultVisibility(type)),
      imagesToContext: options.visionImagesToContext === true,
      // 用量账（2026-10-11）：同上一条纪律——工具层只交事实（原样的 `DsResponse` 与 `ctx` 里的
      // turn/step），账本由宿主写。
      // 不传就整格不出现（`onUsage` 是可选回调，与"不记账"逐字节同义，不必编一个空函数）。
      ...(options.visionRecorder === undefined
        ? {}
        : { onUsage: (response, turn, step) => options.visionRecorder!(response, turn, step) }),
    }),
    // `memory_read`（用户的原话：「读记忆时能指定读对应索引的记忆，而不是用 read 工具，
    // 导致反复把 state、memory 的全文读入」）。放在这里而不是 fs 族里：它的根是
    // `<dataDir>/workspace/MEMORIES`（不是工作根），判据也不是"路径在不在白名单里"。
    // 访问账包一层：工具层只该有"写这一种事件"的能力，与上面 vision 那条同一条纪律。
    createMemoryReadTool({
      dataDir: options.dataDir,
      ...(options.memoryReadRecorder === undefined
        ? {}
        : { onAccess: (data) => options.memoryReadRecorder!(data) }),
    }),
    ...buildTaskTools(options),
    // MCP 入口（唯一一件）：见 `mcpClient` 的注释——给了接线就无条件常驻，不给就不注册。
    // 放在 `task` 之后、shell 之前：位置只是"加进去那一次"的字节，此后不再变（v43 定的）。
    ...(options.mcpClient === undefined
      ? []
      : [createMcpEntryTool({
        client: options.mcpClient,
        blobOffload: options.blobOffload ?? { dataDir: options.dataDir },
        // 申请单目录（只影响**回执文本**里的指路：没有 server 时那段"你可以自己加一个"）。
        // 缺省给 `<dataDir>/grants`；显式给 `null` = **没接线**（测试台/离线装配），
        // 回执退回"去界面加"那句——不编一个不存在的地方让她去写单子。
        ...(options.mcpGrantsDir === null
          ? {}
          : { grantsDir: options.mcpGrantsDir ?? grantsDirOf(options.dataDir) }),
        ...(options.mcpDestructiveEnabled === undefined
          ? {}
          : { destructiveEnabled: options.mcpDestructiveEnabled }),
        /**
         * 「**我做过**」（2026-10-11）：一次真执行的回执 → 一条 `channel/self-action`。
         *
         * 平台不对机器人自己发起的动作发 notice，所以"我设过全员禁言"这件事只能从回执补。
         * 这里只做**一件事**：把事实交给 `actionRecordOf` 判——它不认（查询类、归不到会话的、
         * 不是群会话里的事）就返回 null，**一个字节都不写**。判据只有那一处。
         *
         * 可见性显式给 `internal`：与 `channel/notice` 逐字同一条纪律（不进请求体、不唤醒、
         * 不计未读）。**不递 `RENDER_VERSION`**——它不进 `instructions`/`tools`，只进
         * `read_channel` 的结果（那是 `input` 的对话尾部）。
         */
        onReceipt: (receipt) => {
          // 判据只有一处（`self-action.ts`）：它不认就返回 false，**一个字节都不写**
          recordSelfAction(receipt, options.emit);
        },
      })]),
    // `adminKit.tools` 里**剔除 `ask_human`**（断装配，2026-10-15 用户裁决第二版）。
    //
    // 用户原话（逐字）：
    // > 「我让你移除的 ask_human 貌似没移除？（**移除入口，也不再进入任何请求**，相关内容
    // > **只作为保留在仓库中的死代码**）」
    //
    // ⇒ 与 v52 那次"代码级隐藏"（`HIDDEN_FROM_MODEL`）的差别只有一句，但那一句是全部：
    //   隐藏只是**不列进模型清单**——`registry.get('ask_human')` 仍然非 null，
    //   于是执行期那条路（`executor` 只按名字查注册表，**不看 visibility**）**依然可达**：
    //   实测直接调它的 handler 会照旧写下 `human/asked{source:'agent'}`。
    //   现在从**装配**这一层就不放它进去 ⇒ 注册表里没有它 ⇒ 执行期不可达（`get` 返回 null）。
    //
    // **实现一个字没删**：`createAdminTools` 里那件仍原样保留（`ADMIN_TOOL_NAMES` 也照旧列着），
    //   所以 `test/human-ask.test.ts` / `test/plan-askhuman.test.ts` 走 `admin.byName('ask_human')`
    //   那条路**一条用例都不用改**——这正是"死代码保留"的可执行定义。
    //   `human/asked` 事件、审批卡、申请单（`mcp-grant`）那条链路与它**共用同一套事件**，
    //   一个字不动（那半边是活的）。
    ...adminKit.tools.filter((tool) => tool.name !== 'ask_human'),
    ...buildShellTools(options),
  ];
}

/**
 * `task` 工具族：**条件注册**，默认一件都不注册（见 [ToolCatalogOptions.taskEnabled]）。
 *
 * 为什么不做成"永远注册、只是默认不进模型清单"：登记在注册表里的东西**会被别处看见**——
 * 界面的工具开关（`GET /api/tools` 列的是已注册清单）会多出一件"存在但关着"的 `task`，
 * 而 destructive 的总开关一开，它就会从"注册了但没列"变成"列出来了"（`listForModel` 的
 * 判据是 sideEffect）。那条路上 `tools.destructiveEnabled: true` 会**顺带**把子代理能力
 * 打开——"加一件能力"从来不该是另一个开关的副作用。所以判据只有一处：用户显式写了
 * `tools.taskEnabled: true`。
 *
 * 不注册时**必须说话**：条件注册的工具不出现不能无声无息（与 grep / find 同一
 * 条纪律，用户的原话"没有时如实告知"）。它缺省就不在，所以只在"用户要了却没接上"时出声。
 */
function buildTaskTools(options: ToolCatalogOptions): ToolDefinition[] {
  if (options.taskEnabled !== true) return [];

  const runtime = options.taskRuntime;
  if (runtime === undefined) {
    // 用户要了、装配点却没给取值器：那是接线不全（编程错误），不是"机器上没装"。
    // 照旧把工具造出来并让它如实报"未接线"——她至少能知道这条路为什么走不通，
    // 而不是反复重试一件永远不存在的东西。启动日志里同步说明白。
    options.onNote?.('[工具] task 已按配置打开，但宿主没有提供运行期依赖：本进程里它一调就会报「未接线」');
  } else {
    options.onNote?.('[工具] task 已注册（隔离子代理；每次请求多付一份 schema 的常驻 token）');
  }

  // 五格静态形状（registry / projection / persona / log / ds）**刻意一个都不传**：
  // 装配期确实拿不到它们（循环还没建、投影还在折叠、日志句柄在 main.ts 手里），
  // 传进来只会是假的。实际读的全是下面这条运行期取值器——`runtimeOf` 给了它就原样返回。
  //
  // `resolve` 那一跳只为让类型收窄：取值器在闭包里被调用，而"上面已经判过 undefined"
  // 这件事 TypeScript 不会替闭包记住。
  const resolve = runtime;
  const deps: TaskToolDeps = {
    runtime: resolve === undefined
      ? () => null
      : () => {
        const rt = resolve();
        if (rt === null) return null;
        return {
          log: rt.log,
          ds: rt.ds,
          registry: rt.registry,
          projection: rt.projection,
          persona: rt.persona,
          now: rt.now ?? (() => new Date().toISOString()),
          // 时区缺省跟装配点那条（config.timezone）：它与父循环读的是同一个值
          timezone: rt.timezone ?? options.timezone ?? 'UTC',
          ...(rt.guard === undefined ? {} : { guard: rt.guard }),
          ...(rt.modelVisibility === undefined ? {} : { modelVisibility: rt.modelVisibility }),
          ...(rt.planGate === undefined ? {} : { planGate: rt.planGate }),
          ...(rt.hooks === undefined ? {} : { hooks: rt.hooks }),
          ...(rt.isolation === undefined ? {} : { isolation: rt.isolation }),
          ...(rt.skillCatalog === undefined ? {} : { skillCatalog: rt.skillCatalog }),
          // 单条回执上限与父同一把尺（见 TaskToolRuntimeDeps.blobOffload）。
          // 装配点给得出 dataDir（本函数的 options 里就有），所以这里兜一层：
          // 循环那半格子没给时也仍然有界——**"没配就没有界"正是子代理那条路原来的洞**。
          blobOffload: rt.blobOffload ?? { dataDir: options.dataDir },
        };
      },
  };

  return [createTaskTool(deps)];
}

/**
 * shell 工具族：**只有 `pwsh` 一件**。
 *
 * v27 删掉了它的别名 `run_command`。那个别名当年是为对齐 design §4.21 的措辞而加的
 * （把「后台任务」说出口），代价是两份**完全相同的参数 schema**（151 token）常驻，
 * 外加一次"两个名字选哪个"的犹豫。实测 66 次后台调用里 0 次走 `run_command`
 * ——她一直用 `pwsh` 的 `runInBackground`。措辞对齐的价值落不到调用行为上，
 * 于是参数级审计之后按实测取舍：留下有实测使用的那一个。
 */
function buildShellTools(options: ToolCatalogOptions): ToolDefinition[] {
  const jobs = options.jobs?.() ?? null;
  const destructiveEnabled = options.destructiveEnabled === true;

  const pwsh = createPwshTool({
    destructiveEnabled,
    // 注入了管理器才提供回调与落盘目录；否则后台模式被明确拒绝（不静默降级成前台）
    ...(jobs !== null ? { jobs: jobs.callbacks, jobsDir: jobs.jobsDir } : {}),
    // v30：默认 shell 是**探测到的 pwsh 7**（可能是 PATH、自装目录或用户指定的完整路径）。
    // 探测结论来自依赖管理器的那份缓存——启动路径上不会再为 pwsh 单独起一次进程。
    ...(options.deps === undefined
      ? {}
      : { depsProbe: async () => {
        const probe = await options.deps!.get('pwsh');
        return {
          ok: probe.status === 'ready',
          path: probe.path,
          version: probe.version,
          reason: probe.reason,
        };
      } }),
    /**
     * 2026-10-16（Python 成为第 4 件外部依赖）/ 2026-10-17 翻正：`lang:'python'` 那一档
     * 现在是「**PATH 优先 · 托管兜底**」。
     *
     * 与上面 `depsProbe` 同一条分工：`src/deps/` 回答"本机有没有 python、在哪"，
     * 工具拿这个结论办事。**这里给的是两个候选槽**，不是"答案"——
     *   · `pathSlot`：机器上本来那一份（PATH 上的裸名，或 `deps.paths.python` 指的路径）；
     *   · `managedSlot`：框架自装目录 `<数据Dir>/tools/python/` 里那一份（一键安装的落点）。
     * 谁先用由 `tools/pwsh.ts` 的 `resolveInterpreter` 定（**PATH 先试**）——上一版是宿主
     * 直接给赢家、工具照办（那是"托管优先"）；用户 2026-10-17 把口径翻了过来：
     * > 「**Python 和 pip 不应该是默认要求装的，而是有就用 PATH 里的。没有的话就要求装。**」
     * 两槽都给，工具那一侧才能在"PATH 上那个起不来"时**如实说清**、并知道兜底那一份在哪。
     *
     * `pipConfigFile` **只在真的用托管那一份时**才给（`isManagedHit`）。
     * 上一版是无条件按 `probe.path` 旁边算一份——PATH 优先之后那样会把托管的那份 `pip.ini`
     * 盖到**系统 python** 头上（污染她的 pip 配置）。它只对 python 档生效（作为
     * `PIP_CONFIG_FILE`），另两档一个字节都不加。
     */
    ...(options.deps === undefined
      ? {}
      : { langProbe: async (): Promise<LangDepProbeOutcome> => {
        const probe = await options.deps!.get('python');
        const managedDir = options.deps!.managedDir('python');
        const managedSlot = managedInterpreterOf(
          DEP_SPECS.python.candidates,
          managedDir,
          defaultDepFs.exists,
          defaultDepFs.listDir,
        );
        return {
          pathSlot: pathInterpreterSlotOf(probe, LANG_INTERPRETERS.python),
          managedSlot,
          // 托管那份自包含 pip 配置（引导步骤写在解释器旁边）只在**用托管那一份**时带上；
          // 系统那份旁边没有我们的 pip.ini，硬塞过去会改掉她自己的 pip 配置
          pipConfigFile: isManagedHit(probe, managedDir) && probe.path !== ''
            ? pipConfigPathOf(options.deps!, probe.path)
            : null,
        };
      } }),
  });

  return [pwsh];
}

/**
 * 托管 pip 配置的路径（`<数据Dir>/tools/python/pip.ini`）。
 *
 * 判据**不是**"托管目录在哪"——那样要在这里重算一遍 `<数据Dir>`（tools 层不该知道它），
 * 而是"**探测到的那个解释器旁边**"：`probe.path` 是托管目录里的 `python.exe`，
 * 它旁边就是引导步骤写的 `pip.ini`。用户自己指定路径（`deps.paths.python`）时，
 * 那个 `pip.ini` 不存在也没关系——工具侧会 `statSync` 一次，文件不在就不设这个环境变量。
 *
 * 用 `dirname` 而不是自己切字符串：探测到的可能是 `C:\...\python.exe`（原生）
 * 也可能是 `python`（PATH 上的裸名）——后者的 `dirname` 是 `.`，于是回退到托管目录。
 */
function pipConfigPathOf(deps: { managedDir(name: 'python'): string }, exePath: string): string {
  const dir = exePath.includes('\\') || exePath.includes('/') ? dirname(exePath) : deps.managedDir('python');
  return join(dir, 'pip.ini');
}

export interface CatalogRegistryResult {
  registry: ToolRegistry;
  /** 注册失败的工具族（描述超预算等）；CLI 重建时如实报告，不假装清单齐全 */
  problems: string[];
}

/**
 * **代码级**不进模型清单的工具名单。
 *
 * ──────────────────────────── 2026-10-15：**名单已空，机制留着** ────────────────────────────
 *
 * 这里曾经是 `['ask_human']`（v52，用户裁决「不再进入工具数组，但是项目内代码保留」）。
 * 2026-10-15 用户把口径推到底：
 * > 「我让你移除的 ask_human 貌似没移除？（**移除入口，也不再进入任何请求**，相关内容
 * > **只作为保留在仓库中的死代码**）」
 * ⇒ 那件现在走的是**断装配**那条路（`buildToolCatalog` 里 `adminKit.tools.filter(...)`，
 * 见那一处的注释）：注册表里根本没有它，`registry.get('ask_human')` 返回 null。
 *
 * **这份名单与那套机制一个字都没删**，理由是它治的病还在：`setHidden` 这条路**粘得住**
 * `main.ts` 的 `setDisabled(config.tools.disabled)` 那次整份覆盖（两份存储，见 `registry.ts`
 * 的 `hidden` 那一格）——下一个人要"临时把某件从她眼前拿掉、但保留可调用"时，就该用它。
 * 名单为空 ⇒ `setHidden([])` 是空操作，生产行为与引入这份名单之前逐字节相同。
 */
export const HIDDEN_FROM_MODEL: readonly string[] = [];

/**
 * 装配一个可用的注册表。
 *
 * 两种失败的处置刻意不同：
 *   - **整套装配失败**（工厂函数抛错）→ 直接抛出：那是编程错误，静默返回空注册表会让
 *     "模型一件工具都没有"变成一件需要从行为异常里反推的事；
 *   - **单件注册失败**（描述 token 超预算 §4.18、名字非法等）→ 记为 problems 并跳过其余。
 *     一件文案超预算不该让整机起不来（真实实例的 register 是启动路径上的硬断言），
 *     但也绝不能静默：调用方必须把 problems 打出来，否则就是悄悄少了一件能力。
 *
 * 装配的最后一步固定是 `setHidden(HIDDEN_FROM_MODEL)`（见那个常量的注释）：**生产与
 * CLI 重建/测试走的是同一个函数**，所以"她看到的清单里有哪几件"在这条路上只有一个答案。
 */
export async function buildCatalogRegistry(options: ToolCatalogOptions): Promise<CatalogRegistryResult> {
  const registry = new ToolRegistry();
  const problems: string[] = [];
  for (const def of await buildToolCatalog(options)) {
    try {
      registry.register(def);
    } catch (err) {
      problems.push(`${def.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  registry.setHidden(HIDDEN_FROM_MODEL);
  return { registry, problems };
}

/**
 * CLI 只读场景的注册表：不布防定时器、不写事件（emit 是空实现）、模型通道未接线。
 * 用途只有一个——拿到与运行期同形的 `listForModel` 结果去做请求重建与自检。
 */
export function buildOfflineCatalogRegistry(dataDir: string): Promise<CatalogRegistryResult> {
  return buildCatalogRegistry({
    dataDir,
    timers: new TimerStoreClass(join(dataDir, 'timers.json')),
    emit: () => undefined,
  });
}

/**
 * 交给模型的工具说明。`includeDestructive` 三态透传 registry 语义：
 * 不传 = 一件破坏性工具都不列（与真实循环的默认视角一致），
 * 这正是 `replay` 需要复现的那个视角。
 */
export async function catalogToolSpecs(
  dataDir: string,
  options: { includeDestructive?: boolean | readonly string[] } = {},
): Promise<{ specs: ToolModelSpec[]; problems: string[] }> {
  const { registry, problems } = await buildOfflineCatalogRegistry(dataDir);
  const includeDestructive = options.includeDestructive;
  const specs = includeDestructive === undefined
    ? registry.listForModel({})
    : registry.listForModel({ includeDestructive });
  return { specs, problems };
}
