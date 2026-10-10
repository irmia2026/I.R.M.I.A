/**
 * Irmia Agent — 配置系统（M2 最小子集，对齐 docs/operations.md §1）
 *
 * 与 operations.md §1 的对应关系，逐条落地：
 *   • 单文件、人类可读可编辑 → `config.json`；
 *   • 版本链迁移钩子 → `schemaVersion` 与代码内置 `CONFIG_VERSION` 比较，按序执行
 *     `upgradeHooks`（每钩子随其 targetVersion 恰好触发一次，M6 填链，此处留接口）；
 *   • `configHash` 三指纹之一 → `configHash(config)` 只做 sha256(规范化 JSON)，
 *     与 renderVersion / personaHash 并列作为 `render()` 的确定性输入；
 *   • 密钥不落配置文件 → 文件里只有环境变量 **名**（`apiKeyEnv`），值只在
 *     `readApiKey()` 一处、在真正发起调用的瞬间从进程环境读。
 *
 * 格式决策（有意偏离 operations.md §1 的 TOML）：本期用 **JSON 语法子集**。
 * 理由：Node 自带解析、序列化必然合法（不会写出半截 TOML）、与事件日志同生态；
 * TOML 需要一个零依赖 mini 解析器，那是独立工作量且不影响任何字段语义。
 * 换成 TOML 时只需替换本文件的「读文本 → 文档对象」与「文档对象 → 写文本」两步，
 * 校验层、合并层、迁移层、指纹层全部不动。
 *
 * 注释约定：JSON 没有注释语法，本系统用 **`$` 前缀键** 充当注释（如 `$comment`，
 * 值可以是字符串数组，一行一条）。加载时被递归剔除；写回的默认配置带着它们，
 * 人类读得懂，删掉也不影响运行（`//` 键同样被忽略，照顾手写习惯）。
 *
 * 加载语义（每条都是刻意的）：
 *   • 文件缺失 → 生成带注释的默认配置并原子写回（operations.md §4 首次启动第 3 步）；
 *   • 文件存在但字段缺失 → 逐字段合并默认值，**不自动改写用户文件**（保住他手写的注释与排版）；
 *   • 文件里 JSON 非法 / 字段类型非法 → 抛 ConfigError，绝不静默回退默认
 *     （静默回退会把一次手误变成"配置看起来生效了但其实是默认值"的隐形故障）；
 *   • 版本低于代码 → 先备份原文件再走迁移钩子链；版本高于代码 → 明确报错退出。
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { McpConfigError, parseMcpServers } from '../mcp/client.ts';
import type { McpServerEntry, McpToolAttributes } from '../mcp/client.js';
import { resolveKey, type KeyName } from './keys.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

export const CONFIG_FILE_NAME = 'config.json';

/**
 * 配置 schema 版本。与文件里的 `schemaVersion` 比较决定是否走迁移钩子链。
 * 事件 schema 版本另有其人（src/main.ts 的 SCHEMA_VERSION），两者解耦：
 * 配置变了不影响日志可读性，反之亦然。
 */
export const CONFIG_VERSION = 1;

/** 默认数据目录名（与 main.ts 的 DEFAULT_DATA_DIR_NAME 同义） */
export const DEFAULT_DATA_DIR_NAME = 'data';
/** 默认工作区目录名（operations.md §4：首次启动创建 workspace/） */
export const DEFAULT_WORKSPACE_DIR_NAME = 'workspace';
/** 默认模型与端点：DeepSeek 兼容 /responses 契约（与 src/model/ds-client.ts 对齐） */
export const DEFAULT_MODEL = 'deepseek-chat';
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';
/** 默认密钥环境变量名：配置文件里只放名字，不放值 */
export const DEFAULT_API_KEY_ENV = 'IRMIA_API_KEY';
/** 默认 QQ Bot AppID 环境变量名（与密钥同理：这里只放名字） */
export const DEFAULT_QQ_APP_ID_ENV = 'QQ_BOT_APP_ID';
/** 默认 QQ Bot ClientSecret 环境变量名 */
export const DEFAULT_QQ_CLIENT_SECRET_ENV = 'QQ_BOT_CLIENT_SECRET';
/**
 * 群消息攒批窗口默认 3 分钟：够攒两句上下文，又不至于让人等太久（0 = 每条都唤醒）
 */
export const DEFAULT_QQ_GROUP_BATCH_MINUTES = 3;
/**
 * `ask_human` 之后多久没人答就落一条「未批准、未拒绝」的事实（design §6.1，默认 30 分钟）。
 *
 * 为什么是 30 分钟（而不是跟 plan 挂起那条 24h 一个数量级）：
 *   • 人在机器旁时，一张卡"看到 → 打字 → 提交"是几十秒的事，30 分钟是它的十几二十倍，
 *     足够排除"他正在看但还没答完"；
 *   • 她问的往往是她正卡住的那件事。半小时还没人答，"他不在"就是一条**值得据此换路**的
 *     判断（走 QQ 还是先绕开），再晚就白等了一场；
 *   • 24h 那条是**任务层暂停**（一个资源决定，误判的代价大），这条只是"有没有人在"的事实
 *     判断（误判的代价是她多说一句/多试一条路）：两条不该共用一个数量级。
 *
 * 再说一次它**不是默认动作**：超时不批准、不拒绝、不撤卡，只产生事实（§6.1）。
 */
export const DEFAULT_ASK_HUMAN_TIMEOUT_MIN = 30;
/** 默认 OneBot（NapCat 等协议端）正向 ws 地址：协议端默认监听 3001 */
export const DEFAULT_ONEBOT_WS_URL = 'ws://127.0.0.1:3001';
/** 默认 OneBot access_token 环境变量名（与 QQ 同理：配置里只放名字） */
export const DEFAULT_ONEBOT_ACCESS_TOKEN_ENV = 'ONEBOT_ACCESS_TOKEN';
/** 注释键前缀：以它开头的键在加载时被递归忽略 */
export const COMMENT_PREFIX = '$';
/** 环境变量名形状：用来把「把密钥值误填进 apiKeyEnv」当场抓出来 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * 每日记忆整理的默认 cron（design.md §4.17）：凌晨 4 点——整理是后台自维护动作，
 * 挑一个用户不在场的时刻，避免它和真实输入抢同一批预算与注意力。
 */
export const DEFAULT_MEMORY_MAINTAIN_CRON = '0 4 * * *';
/**
 * `persona/STATE.md` 的字节预算（默认 8 KB）——越过它就在**此刻层**多一行提醒，让**她**去维护。
 *
 * **为什么是 8 KB**（2026-10-05 用户定稿："STATE 如果超预算的话，就加个提醒……将过时内容
 * 移入记忆文件或删除"）：
 *   • 8 KB ≈ 1.8k token，够放**当前任务 + 接着干 + 几条边界**这三样——也就是"下一拍真的要用"
 *     的那点状态。这三个数（1.8k token / 下面那份 16.6 KB）都是实测：目视 `data/persona/STATE.md`
 *     量到 17007 字节，按本仓库的 token 估算口径约 3.8k token/次**每轮都在重发**。
 *   • 现在那份 16.6 KB 里有一批**本不该常驻**的东西，正是这条提醒要她去处理的两类：
 *     `旧账（结论已存 facts.md）`（结论已经有家，正文留在 STATE 只是重复付费）与
 *     `工具常识（已验）`（验过一次的机制知识属于记忆文件，不属于"当前状态"）。
 *   • 定 8 而不是 4：她真的在干活时（当前任务 + 排队 + 边界 + 两条心情）就是 5~7 KB，
 *     压到 4 KB 会逼她为了躲提醒而删掉还在用的东西——那是**为了指标损害质量**。
 *     也不是 16：那等于"什么都不用改"，这条提醒就成了摆设。
 *
 * **它只提醒、不截断**（用户的原话："框架不动她的文件；她看到提醒自己去维护"）：
 * 框架一个字节都不动 `STATE.md`，也不替她搬内容——搬去哪、删什么由她判断。
 * 提醒的措辞与格式见 `src/model/render.ts` 的 `stateBudgetReminder`（唯一一处实现）。
 *
 * 单位是**字节**（照 `write_persona` 里 `Buffer.byteLength` 那套既有口径），不是字符：
 * 这份文件几乎全是中文，一个汉字 3 字节，"多少字"和"多少字节"差三倍。
 *
 * ⚠️ 改这个数要**同时**改 `buildDefaults()` 里 `persona.stateBudgetBytes` 的那个字面量：
 * 出包脚本拿它与这里比对（理由写在那行旁边），只改一处出包会红。
 */
export const DEFAULT_STATE_BUDGET_BYTES = 8 * 1024;

/**
 * `wake.heartbeatTargetMeanMin`（心跳目标均值，分钟）的合理范围：**5~60**。
 *
 * 这是"外层合理性"那一道，不是判据本体：真正的判据是"必须严格落在 heartbeatFloorMin 与
 * heartbeatCeilMin 之间"（见 `checkHeartbeatTargetMean`）——下面这两个数只是把明显荒唐的值
 * （平均 0 分钟、平均 10 小时）挡在门外，让报错信息说得出一个可照抄的范围。
 *
 * 为什么还是留着这一层：下限/上限**可以被使用者改**（例如 floor=1、ceil=120），
 * 而"平均 2 分钟醒一次"或"平均 90 分钟才醒"在语义上已经越过心跳这件事的边界
 * （心跳是呼吸，不是轮询、也不是排班表），所以在交叉校验之外单列一条。
 */
export const HEARTBEAT_TARGET_MEAN_MIN = 5;
export const HEARTBEAT_TARGET_MEAN_MAX = 60;

// ──────────────────────────────── JSON 值类型 ────────────────────────────────

export type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

// ──────────────────────────────── 配置类型 ────────────────────────────────

/** 单条模型路由：模型 id + API 根地址 + 密钥所在的环境变量名 */
export interface ModelLaneConfig {
  /** 模型 id，按 DeepSeek 兼容 /responses 契约发送 */
  model: string;
  /** API 根地址，不含 `/responses` 后缀 */
  baseUrl: string;
  /** **环境变量名**，不是密钥值本身（密钥教义：文件里只有名字） */
  apiKeyEnv: string;
}

export interface ModelsConfig {
  /** 主循环生成（turn 主力） */
  heavy: ModelLaneConfig;
  /** 必要性判断、压缩摘要、守卫分类（便宜模型优先，design.md §4.11） */
  light: ModelLaneConfig;
  /** 降级链备用路由；缺省不启用（不写这一段即代表不用） */
  degraded?: ModelLaneConfig | undefined;
}

/**
 * 三层预算 + 每日额度 + 软阈值 + 连续失败上限（design.md §4.6 的默认值）。
 *
 * ⚠️ `taskTokens` / `dailyTokens` 数的是**非缓存 token**（2026-10-05 起）：
 * `(inputTokens − cacheHitTokens) + outputTokens`——"输入里没命中缓存的那部分 + 输出"，
 * 也就是**真花钱的那部分**。唯一一处定义在 `src/state/fold.ts` 的 `budgetTokensOf`。
 * `stepTools` / `turnSteps` 数的是**次数**，与 token 口径无关。
 */
export interface BudgetConfig {
  /** 单 step 工具调用数上限（**次数**） */
  stepTools: number;
  /** 单 turn step 数上限（**次数**） */
  turnSteps: number;
  /** 单任务累计**非缓存** token 上限 */
  taskTokens: number;
  /** 每日累计**非缓存** token 上限 */
  dailyTokens: number;
  /** 软阈值比例（0-1）：达到 上限×ratio 时先往尾部 developer 消息提示，越过才硬停 */
  softRatio: number;
  /** 连续模型失败上限：超过则告警并进入可恢复暂停 */
  failStreakMax: number;
}

/** 心跳（概率模型，design.md §4.12）与周期任务（design.md §4.17） */
export interface WakeConfig {
  /**
   * 安静下限（分钟，默认 **5**）：安静不足它**绝不**触发心跳。
   *
   * 它是概率模型的硬下界（p 在这一段恒为 0），不是"安全网"——下限以下的概率根本不存在。
   */
  heartbeatFloorMin: number;
  /**
   * 安静上限（分钟，默认 **60**）：安静到点**必然**触发（p 在这一刻为 1）。
   *
   * 上一版这个数只是"退避撞上去的封顶值"，现在是分布自身的支撑上界：尾巴不会再长出去，
   * 也就不会出现"配错一个倍数就静默六小时"。
   */
  heartbeatCeilMin: number;
  /**
   * 抽签节奏（分钟，默认 **1**）：每这么多分钟抽一次签，抽中才触发。
   *
   * 注意它不是"心跳间隔"——心跳间隔是抽签的**结果**。调大 = 触发时刻更粗
   * （只能落在它的整数倍上）；调小只是更细，不会让心跳更频繁。
   */
  heartbeatTickMin: number;
  /**
   * **心跳目标均值**（分钟，默认 **15**）：平均多久醒一次——想改频率就改这一个数。
   *
   * 概率曲线的形状指数 α 不是旋钮：启动时按这个目标均值**反解**出来
   * （`src/wake/heartbeat.ts` 的 `solveHeartbeatAlpha`，用的是与实测同一套 pmf，二分且确定）。
   * 想要平均 30 分钟醒一次就写 30，不需要知道 α 是什么。
   *
   * 校验（写错了当场报配置错，不做"尽力而为"的猜测）：必须**严格**落在安静下限与上限之间
   * （`heartbeatFloorMin` < 本字段 < `heartbeatCeilMin`），且落在 5~60 的合理范围内——
   * 一个比下限还小的"平均"是自相矛盾的（下限那一段根本不触发）。
   * 模型实际能表达的均值区间是 [floor + tick, ceil]：tick 粒度会让"最短均值"变成 floor + tick，
   * 够不着的目标会被解到搜索边界（启动日志与分布摘要里报的解析均值才是实际值）。
   *
   * **启动参数：改完要重启进程才生效**（心跳是启动期建的，《operations.md》§1.3 有可照抄的例子）。
   */
  heartbeatTargetMeanMin: number;
  /**
   * 每日记忆整理的 cron（五段：分 时 日 月 周）。空字符串 = 关闭该任务。
   * 到期以 `wake/timer` 唤醒，real-loop 按 payload.kind 认出这是整理而不是普通 turn。
   */
  memoryMaintainCron: string;
  // ── 已删除的两个字段（2026-10-04，随概率模型一起；别再加回来）──
  //   `heartbeatBaselineMin` 与 `idleBackoffMax` 是旧确定性排程的参数
  //   （间隔 = 基线 × min(2^n, 退避上限) × 压力调制）。新模型里**没有任何地方会读它们**：
  //   间隔不再由基线乘出来，空拍也不再让间隔翻倍。按"不留没人读的配置"的规矩**直接删掉**，
  //   不保留兼容字段——留一个读了不生效的旋钮比没有它更坏（会让人以为自己调过分寸）。
  //   老配置文件里残留的这两个键会被解析器忽略（逐字段读，不认识的键不进结果），
  //   不会报错、也不会假装生效。
}

/** 发言节奏（design.md §4.20 的 speak 三路投递） */
export interface SpeakConfig {
  /**
   * 打字节奏（默认开）：段与段之间按"这一段得打多久"隔开，界面上与 IM 里都是一条条往外蹦。
   *
   * 关掉 = 所有段立刻发完。省的是时间（一次长发言不再占几十秒），代价是没有"人在打字"
   * 的体感——她在 IM 那边会显得像台机器一次吐一整段。
   */
  typingEffect: boolean;
  /**
   * 打字速度（字/分钟，默认 90）。
   *
   * 90 字/分是中文手机输入的常见速度，也是"几十个字要打十几秒"的体感来源。
   * 调大 = 说得更快（更短的总等待），调小 = 更慢更黏。范围 30~600。
   */
  charsPerMinute: number;
  /**
   * **开口之前的"正在输入"**（默认开）。
   *
   * 开：她每次 `speak` 真正说话**之前**，先给通道发一个"正在输入"状态（官方口径 =
   * `msg_type: 6` + `input_notify{input_type:1, input_second:60}`，走 `POST /v2/users/{openid}/messages`）。
   * 一次 speak 至多一次——不是每句话都发。
   *
   * 三条边界，逐条都能让你决定要不要关掉它：
   *   • **仅单聊**：官方只在《发送单聊消息》那一页列了 `msg_type: 6`，群聊页既没有这个
   *     类型、请求体里也没有 `input_notify`。所以群里**一次都不发**（如实跳过，不是失败）。
   *   • ⚠️ **它到底占不占"被动回复 4 次窗口"的计数，官方文档没写**（《消息收发概述》只说
   *     被动回复"每个消息最多回复 4 次"）。这是本仓**未亲验**的一条：真撞上了会表现为
   *     随后那条正文收到 `40034128`（被动回复时间或次数超限）。所以它做成可关，且**失败
   *     绝不影响说话**（发不出去就照旧说，最多 2.5 秒超时）。
   *   • **OneBot 通道没有这条能力**（那套协议里没有等价动作）⇒ 在那条通道上优雅跳过。
   *
   * 关掉 = 一句话都不发（连请求都不发出去）。
   *
   * ⚠️ 这个字段的**声明位置**有讲究（见下面 `SpeakConfig.inputNotify` 那条注释的兄弟版：
   * 它必须写在 `buildDefaults()` 的 `speak:` 段里，而不是这份接口里——`Read-CodeDefaults`
   * 按行序抓字面量，接口里的 `boolean` 会被它读成 `false`）。
   */
  inputNotify: boolean;
}

/** 图片进上下文的两个口径（design.md §4.20 图片两条途径） */
export interface VisionConfig {
  /**
   * 图片直通上下文（默认开）。
   *
   * 开：人在 QQ 上发来的图片会**直接进上下文**（模型亲眼看），最多 `maxContextImages` 张；
   * 同时 `vision_read` 多了一个 `inline` 参数——她可以把某张图从"转述"改成"我要原图"。
   * 关：图片一律不进上下文，只剩消息里的地址与 `vision_read` 的文字转述。
   *
   * 为什么默认开：表情包与截图光靠文字转述经常失真（"一张图"和"她真的看见了"是两件事），
   * 而用户的原话是"聊天发送的图片直接进入上下文"。关掉它是省钱的手段，不是安全需要。
   */
  imagesToContext: boolean;
  /**
   * 最多几张图片同时待在上下文里（默认 2）。
   *
   * 图片每轮请求都要重发一遍，不像工具结果读一次就完了；留太多等于每轮都在为旧图付费。
   */
  maxContextImages: number;
}

export interface ToolsConfig {
  /**
   * destructive 工具的开关，三态（与 src/tools/registry.ts 的 includeDestructive 同构）：
   * false → 一件都不列（默认，安全默认）；true → 全列；数组 → 只列名单内的。
   */
  destructiveEnabled: boolean | string[];
  /**
   * **群聊场景是否硬拒绝本机类工具**（2026-10-04 用户定的两种情景）。
   *
   *   • `false`（默认，**软提醒**）：群聊轮次在上下文里附一句场景提醒，本机类工具照给，
   *     由她判断该不该配合；
   *   • `true`（**硬拒绝**）：群聊场合下本机类工具在执行期直接拒绝（清单仍然恒定，
   *     因为"按场景改清单"会把历史上下文的前缀缓存废掉）。
   */
  groupSceneHardRefusal: boolean;
  /**
   * 计划模式（design.md §4.21）：开启时 destructive 调用**不直接执行**，先落 plan/pending
   * 等人工批准（与 needsReview 的「事后确认」是两条队列）。默认关闭。
   *
   * 与 destructiveEnabled 的分工：后者决定「这类工具能不能被模型看见」，
   * 前者决定「看见了之后能不能直接动手」——两个问题，两道门。
   */
  planMode: boolean;
  /**
   * 被关掉的工具名单（设置界面的开关，design §4.18）。
   *
   * 语义是「从她眼前拿掉」：关掉的工具不进模型请求，也就不会被调用；注册表仍知道它存在
   * （界面要显示一件工具存在但关着），执行到半路时会给出「已在设置里关闭」。
   * 用**禁用名单**而不是启用名单：新版本多出来的工具默认能用，不会因为忘了加名单而静默失效。
   */
  disabled: string[];
  /**
   * 她用 `ask_human` 问了人之后，多久没人答复就落一条「未批准、未拒绝」的事实
   * （`human/expired`，design §6.1）。单位是分钟，默认 [DEFAULT_ASK_HUMAN_TIMEOUT_MIN]。
   *
   * **它不是"默认动作"**：超时不产生任何决定，也不撤卡——只是让她得知"人可能不在机器旁、
   * 或没注意到"，要不要换个方式找人（例如走 QQ）由她判断。**没有"超时怎么办"这类设置**，
   * 因为那等于让某一方替人做决定（design §6.1 明说不设这条）。
   */
  askHumanTimeoutMin: number;
  /**
   * **隔离子代理工具 `task` 的开关（默认 false = 不注册）**，design §4.21。
   *
   * 为什么默认关（与 `rg_search` / `es_search` 那种"本机装了才注册"的条件注册不是一回事）：
   * 那两件的判据在**机器**上（引擎在不在），这一件的判据在**代价**上——
   *
   *   • 工具清单是请求**冻结前缀**的一部分（docs/schema.md §13：模型请求的全部内容可由
   *     model 事件 + 人格资产重建）。多一件 = 每次请求都多付一份 schema 的常驻 token；
   *   • 更要紧的是**前缀一变就是一次缓存 miss**：清单出现在请求最前面，那之后的所有内容
   *     在服务端缓存里整段失效。实测口径（docs/design.md §4.13 缓存三铁律）就是"同签名
   *     命中 85.2%、换签名 41.2%"，所以"加一件工具"从来不是免费的加法；
   *   • 它还是一层**嵌套**能力（子代理有自己的预算与工具集），默认替所有人打开，
   *     等于替他们接受了一种新的花费形态（一次 task 调用可能烧掉几千 token）。
   *
   * 打开之后会发生什么（实测数见 docs/operations.md §1.2）：清单 24 → 25 件、`tools` 段的常驻
   * token +172（它自己那一件），她多一件能把"读一批文件再汇总"这类活整块外包的工具
   * （子代理独立上下文、预算从父扣减、默认不能再下派）。
   *
   * **它是启动期读一次的参数**（装配参数）：改完要重启进程才接管——与 `destructiveEnabled`
   * 同理，清单在进程起来那一刻就定下了。
   */
  taskEnabled: boolean;
}

export interface AlertsConfig {
  /** 通用 webhook 出口：POST JSON `{ level, title, body, ts, fingerprint }`；不配则不出口 */
  webhookUrl?: string | undefined;
  /** 同类告警限流窗口（分钟，design.md §4.12：默认 30） */
  rateLimitMin: number;
}

/**
 * 上下文审计（design §4.13 缓存三铁律的观测面，2026-10-03 加）。
 *
 * **只记 token 与结构事实，不涉及任何价格/货币概念**。两个阈值都是"保守"取向：
 * 宁可少报一次缓存变化，也不要在每个 step 都喊狼来了——归因事实本身每步都记，
 * 哨兵只在**真的失守**时记一条。
 */
export interface ContextAuditConfig {
  /**
   * 空闲判据的时间线（分钟，默认 30）。
   *
   * 比它更久没调用过模型之后，缓存前缀很可能已被服务端回收；但"久"本身不是破坏，
   * 所以还要同时看到命中率塌陷（见 `cacheBreakHitDrop`）才记一条。
   * 取 30 是因为它与心跳基线同量级：短于它的间隔里，命中率掉下去另有原因，不该算在"过期"头上。
   */
  cacheBreakIdleMin: number;
  /**
   * 命中率的相对跌幅门槛（0–1，默认 0.5）：本次命中率比上次**跌掉一半以上**才算塌陷。
   * 取 0.5 是保守值——前缀只掉几条（模型偶尔少命中一点）不该报警。
   */
  cacheBreakHitDrop: number;
}

/**
 * 本地 HTTP 服务（design.md §4.15）——**只有桌面 GUI 一个消费者**。
 *
 * 2026-10 删掉了两样东西，都别再长回来：
 *   • `appMode`（启动时自动唤起 Edge `--app` 窗口）：它存在的唯一理由是那个网页观测台，
 *     而观测台（`web/` 目录、`/` 静态分支）已经整个删除。GUI 是正经的原生窗口，
 *     不需要"拿浏览器假装成一个应用"。（老配置里留着这个键**不会**让进程起不来：
 *     解析器只读它认识的键，多余的一律安静忽略——见 config.ts 顶部的读取纪律。）
 *   • 界面凭据走密码（`data/.auth.json`），不再是 `web.token` 那种共享 token。
 */
export interface WebConfig {
  /** 绑定地址：默认只绑回环 */
  host: string;
  /** 监听端口（默认 7788；改动需重启，不在热更白名单） */
  port: number;
}

/** 联系人表：会话标识（sid）→ 名字 */
export type ContactBook = Record<string, string>;

/**
 * 信任范围（2026-10-04 用户拍板）：她的活动边界有多宽。
 *
 * ⚠️ **与本文件别处的 "trust" 不是一回事**，两个词在仓库里各有所指，别混：
 *   • 这里的 `trust`＝**她的活动范围**（能碰哪些路径、能在哪儿跑命令）；
 *   • `src/runtime/trust.ts` 的 trust＝**这一轮的来源可不可信**（用户 / 客人 / 外部群），
 *     那是按 turn 判的鉴权，与配置无关。
 *
 * 两档，没有第三档：
 *   • `'full'`（默认）＝她能读写**整台电脑**上的文件、也能在**任意目录**跑命令。
 *   • `'workspace'` ＝她**只能在** [TrustConfig.workspaceRoot] 里活动：越界的读写与命令**被拒绝**。
 *     这一档的根默认取**智能体自己的工作根**（配置目录），也就是 fs 工具族今天用的那个根
 *     ——于是"切到 workspace"= 回到今天的行为，"切到 full"= 新放开的那一档。
 *
 * 为什么默认是 full（而不是"安全起见先关起来"）：用户 2026-10-04 的原话——
 * 「**能够触碰整个电脑是默认行为**」。这是**有意的默认**，不是漏洞、也不是还没做完：
 *   • 她是一台无人值守的常驻 agent，"能自己去找、去修、去装"本来就是她存在的方式；
 *     默认把她关进一个空目录，等于出厂就让她大多数本事用不出来。
 *   • 真正的破坏性动作另有**三道门**在挡（design.md §4.10）：destructive 默认关、
 *     pwsh 的命令黑名单、执行期的场景鉴权。信任范围是**边界**，不是唯一一道闸。
 *   • 而"我设过一条边界"这件事必须是真的：所以这个开关要么真的管住全部路径入口，
 *     要么就不该存在——同一个文件里刚删掉过一条**写着边界、其实没人读**的配置
 *     （`paths.workspaceAllowlist`，见 docs/tools-audit.md），不留第二例。
 *
 * **这个开关同时管 fs 工具族与 pwsh**（两条路都要读它，缺一条就是上面那种谎）：
 *   • fs 工具族：`safe_read` / `safe_write` / `edit_file` / `insert_at_line` / `delete_path` /
 *     `list_dir` / `search_in_files` / `rg_search` / `es_search` … 一律经 `resolveInsideRoot`
 *     那一道判定；
 *   • `pwsh`：既管它的 `workdir` 参数，也管命令行里出现的路径（`cd`、重定向、脚本路径）。
 *
 * 它是**启动期读一次**的参数：边界在工具装配与执行器那两处落地，改完要重启进程才接管。
 */
export interface TrustConfig {
  /** 活动边界：`'full'`（默认，整台电脑）| `'workspace'`（只限 [workspaceRoot]） */
  mode: TrustMode;
  /**
   * 「工作目录」的绝对路径——`mode === 'workspace'` 时**唯一**允许她活动的根。
   *
   * **默认 = 智能体自己的工作根（配置目录）**，2026-10-05 定的。为什么是这个根，而不是别的：
   *   • 它正是 **fs 工具族今天用的那个根**（`agent-loop.ts` 的 `deps.workspaceRoot ?? process.cwd()`，
   *     而 real-loop 不传它）——于是两档的语义干净：**`workspace` = 今天的行为**、
   *     `full` = 新放开的那一档（整台电脑）；
   *   • 她的资产都长在配置目录之下：`<dataDir>/workspace/MEMORIES/`（记忆）、`<dataDir>/persona/`
   *     （人格）、`skills/`。默认若取更窄的 `<配置目录>/workspace`，这些**全在边界之外**——
   *     `workspace` 档会变成"连自己的记忆与人格都读不到"，那不是边界是锁门（实测见
   *     `test/trust-boundary.test.ts` 的那组用例）。
   *
   * 它是**派生量**：解析器算出来，界面（`GET /api/config` 直接回这份 config）与执行器
   * （`trustBoundaryRoot`）读的是同一个值。原因：同一条边界在两处各写一个值，就一定会出现
   * "配置说 A、实际拦在 B"——界面显示的路径与执行器拦的路径必须是**同一个来源**。
   * 盘上有显式值时以盘上为准（`pickNonEmptyString`），所以要换根就写 `trust.workspaceRoot`。
   */
  workspaceRoot: string;
}

/** 信任范围的两档（与 [TrustConfig.mode] 同源；界面上的二选一也读它） */
export type TrustMode = 'full' | 'workspace';

/**
 * `trust` 配置 → **工具层的活动边界**（`ToolContext.boundaryRoot`）。**只此一处**。
 *
 *   · `'full'`      → `null`：不设边界（整台电脑）。
 *   · `'workspace'` → `trust.workspaceRoot`：只允许在这个根内活动。
 *
 * 为什么单独一个函数：这条映射会被两处消费（主循环 `real-loop` 的 `agentDeps`、启动日志），
 * 而它一旦被写两遍，就会出现"界面说限在 A、执行器拦在 B"。判读三态的那一半在
 * `tools/boundary.ts` 的 `effectiveBoundaryRoot`（`undefined` = 历史行为），两处合起来才是
 * 完整的决议链：**配置 → 边界 → 判定**。
 */
export function trustBoundaryRoot(trust: TrustConfig): string | null {
  return trust.mode === 'workspace' ? trust.workspaceRoot : null;
}

/**
 * 解析联系人表。非法项一律跳过（人名写错一个字不该让整份配置打不开），
 * 键必须是会话标识形态（含 `:`）—— 否则那多半是写错了地方。
 */
function readContacts(raw: JsonValue | undefined, where: string): ContactBook {
  const out: ContactBook = {};
  if (raw === undefined) return out;
  const obj = objectOr(raw, where);
  for (const [sid, name] of Object.entries(obj)) {
    if (typeof name !== 'string' || name.trim() === '') continue;
    if (!sid.includes(':')) continue;
    out[sid] = name.trim();
  }
  return out;
}

/**
 * 解析 `mcp` 段（2026-10-09 起，2026-10-10 加 `maxInFlight` / `rssSample` 两格）。
 *
 * `servers[]` 的校验规则**不在本文件重写一遍**：直接复用 `mcp/client.ts` 的 `parseMcpServers`
 * ——界面那侧（web/server.ts 的 `mcp-save` / `mcp-test` / `mcpView`）与这里读的是同一份文件，
 * 两处各写一套校验必然漂移（一处收紧、另一处照旧放行，"配了却不生效"就是这么来的）。
 *
 * **非法就抛**（不静默当成空数组）：与 `persona.contacts` / `deps.paths` 同一条纪律
 * ——"我配了却不生效"比"启动时报一句配置错"难查得多。缺 `mcp` 段 / 缺 `servers`
 * 都是**合法的"没声明"**（返回空数组），那才是"优雅降级"要覆盖的那一种。
 *
 * `McpConfigError` 折成 `ConfigError`：调用方只该认一种配置错误类型
 * （它带 `where`，启动期直接打印就能施救）；原始消息逐字保留（它自己带下标定位）。
 *
 * 两个全局格（2026-10-10 加）与 `servers[]` **走同一条纪律**：类型不对当场抛、带 `where`，
 * 并且**缺省不写就是出厂值**（这是"旧配置照旧能跑"的那一半——加格不给旧文件添麻烦）。
 */
function readMcpConfig(raw: JsonValue | undefined): McpConfig {
  const section = raw === undefined || raw === null ? {} : objectOr(raw, 'mcp');
  const out: McpConfig = { servers: [], maxInFlight: 8, rssSample: true, extraLaunchers: [] };
  /**
   * 放行口那一格**必须排在 `servers[]` 前面**（2026-10-10 加）。
   *
   * 为什么顺序是判据而不是风格：`servers[].command` 要过启动器白名单，而白名单的第三个来源
   * 正是这一格（默认表 → `mcp.extraLaunchers` → 环境变量 `IRMIA_MCP_STDIO_ALLOWLIST`）。
   * 先读它 ⇒ "在同一个文件里写了 `extraLaunchers: ["obscura"]` 又写了一条 `obscura` 的
   * server"这份配置**当场合法**——不必先去设一个环境变量、更不必重启。
   * 反过来（先解析 servers）就会得到一句"启动器不在白名单里"，而答案明明写在同一段里。
   */
  const extraRaw = section['extraLaunchers'];
  if (extraRaw !== undefined && extraRaw !== null) {
    if (!Array.isArray(extraRaw)) {
      throw new ConfigError(
        `mcp.extraLaunchers 必须是字符串数组（这台机器上额外放行的 MCP 启动器命令名），`
        + `收到 ${describeValue(extraRaw)}`,
        'mcp.extraLaunchers',
      );
    }
    out.extraLaunchers = extraRaw.map((item, index) => {
      const itemWhere = `mcp.extraLaunchers[${index}]`;
      if (typeof item !== 'string' || item.trim() === '') {
        throw new ConfigError(`${itemWhere} 必须是非空字符串（命令名，如 "obscura"），收到 ${describeValue(item)}`, itemWhere);
      }
      // 与 `launcher-guard.ts` 的 `configAllowedLaunchers` 同一条归一口径（trim + 小写）：
      // 两处不一致会出现"配了却不生效"，而这里归一之后写进 `configHash` 的那份也就是生效的那份
      return item.trim().toLowerCase();
    });
  }
  const serversRaw = section['servers'];
  if (serversRaw !== undefined && serversRaw !== null) {
    try {
      // 第三个参数 = 上面那一格放行口（**同一份文件里的声明当场生效**，见上面那段注释）
      out.servers = parseMcpServers(serversRaw, 'mcp.servers', out.extraLaunchers);
    } catch (err) {
      if (err instanceof McpConfigError) throw new ConfigError(err.message, err.where);
      throw err;
    }
  }
  const maxInFlight = section['maxInFlight'];
  if (maxInFlight !== undefined && maxInFlight !== null) {
    // 正整数：写 0/负数/小数/字符串都当场报错。**不静默改成 0**——那会让所有 MCP 调用一件都发不出去，
    // 而配置看起来"生效了"（与 `maxInFlight` 那一格的逐 server 版本同一条判据）。
    if (typeof maxInFlight !== 'number' || !Number.isInteger(maxInFlight) || maxInFlight < 1) {
      throw new ConfigError(
        `mcp.maxInFlight 必须是 >= 1 的整数（同时在飞的 MCP 请求上限；超限如实拒绝，不排队），`
        + `收到 ${describeValue(maxInFlight)}`,
        'mcp.maxInFlight',
      );
    }
    out.maxInFlight = maxInFlight;
  }
  const rssSample = section['rssSample'];
  if (rssSample !== undefined && rssSample !== null) {
    if (typeof rssSample !== 'boolean') {
      throw new ConfigError(
        `mcp.rssSample 必须是 true / false（是否采那个 server 的 RSS——**整棵进程树**；关掉后 /api/mcp 那几格留空），`
        + `收到 ${describeValue(rssSample)}`,
        'mcp.rssSample',
      );
    }
    out.rssSample = rssSample;
  }
  return out;
}

/** 人格连续性与上下文压缩（design.md §4.11 / §4.13、persona.md §4） */
export interface PersonaConfig {
  /**
   * 可见历史 token 估算阈值：超过就在 turn 结束时写 `compaction/summary`。
   * M5 的临时判定口径——估算见 persona/handoff-note.ts 的 `estimateHistoryTokens`。
   */
  compactionThresholdTokens: number;
  /** 交接笔记总预算（token 估算，persona.md §4：默认 4096） */
  handoffBudgetTokens: number;
  /** 交接笔记里最近 1/4 条目的单条满预算（persona.md §4：默认 1024） */
  handoffFoldTokens: number;
  /**
   * 本机用户的档案标识：GUI 聊天框与 CLI `wake` 发出的手动唤醒会带上它，
   * 于是 `data/persona/RELATIONSHIPS/<owner>.md` 自动注入（persona.md §3 的唤醒路由）。
   *
   * 它是**文件名**，不是昵称展示位：写什么就得有同名文件。默认 `owner`。
   * IM 来的人不走它——那些走 openid / user_id，档案按那串标识命名。
   */
  owner: string;
  /**
   * **框架代管记忆的总开关**（默认 true = 现在这套自带记忆系统）。
   *
   * 开（true，默认）＝框架管记忆：
   *   • 启动时生成 / 重建 `<dataDir>/workspace/MEMORIES/INDEX.md`（指针表：相对路径:行号 + 一行摘要）；
   *   • 每个 turn 的固定块里注入那份索引（见 docs/memory-injection.md §2/§3）；
   *   • 按 `wake.memoryMaintainCron` 跑每日整理：过期流水账并进 `facts.md`、写一篇 `diary/`；
   *   • `facts.md` 的 `!pinned` 分区与条目 TTL 也由框架维护。
   *
   * 关（false）＝框架**不生成索引、不注入任何记忆、不跑整理**：她仍然从装置自述（SELF_BRIEF）
   * 知道 `MEMORIES/`（`facts.md` / `episodes/` / `jargon.md` / `style-notes.md` / `aliases.md`）
   * 与 `diary/` 存在，但**读、写、整理全归她自己**——这正是"仅知晓这些文件存在，并自觉读取、
   * 修改、维护"那条路。代价写在明面上：她可能忘了整理，`facts.md` 会一直长下去，索引也不再更新。
   *
   * 为什么留这个开关：给"只想让 agent 自己管记忆"的人一条干净的路，
   * 而不是逼他去删文件、改 cron、把索引文件写成只读。
   *
   * **不受它影响的两条路**（别以为关掉就全没了）：
   *   • `MEMORIES/aliases.md` 参与"会话认人 / 关注名单"（`src/channel/inbox.ts` 的
   *     `WATCHED_SESSION_SOURCES`）属于**通道侧**，不在这个开关范围；
   *   • `STATE.md`（她当前状态）是**独立的一层**，与本开关无关。
   *
   * 它是一个启动期读一次的开关（装配参数），改完要重启进程才接管。
   */
  memoryEnabled: boolean;
  /**
   * `persona/STATE.md` 的**字节预算**（默认 [DEFAULT_STATE_BUDGET_BYTES] = 8 KB）。
   *
   * 越过它时，框架在**此刻层**（每步都发的那一段）多一行：
   * `[STATE.md] 16.6 KB / 预算 8 KB——预算超限，记得维护，将过时内容移入记忆文件或删除`。
   * 放在那里是因为她**正在动手的地方**就是此刻层：她压下来之后（下一轮量到的新尺寸落回预算内）
   * 那一行自动消失，不需要任何"已读"状态。
   *
   * **只提醒、不截断**（2026-10-05 用户的口径）：框架不动她的文件，也不替她搬内容——
   * 哪一段过时、搬进哪个记忆文件、还是直接删，都是她的判断。这一行的全部作用是把一件
   * "她看不见的成本"摆到她眼前（整份 STATE 每轮重发，见 docs/memory-injection.md §2 的实测）。
   *
   * 为什么它属于 `persona.` 前缀：STATE 是人格资产的一层（persona.md §2），预算的判据与它同源。
   * 与 `memoryEnabled` 一样是**启动期读一次**的参数（渲染输入由宿主装配，改完重启才接管）。
   */
  stateBudgetBytes: number;
  /**
   * 框架维护的联系人表：会话标识（sid）→ 名字（"这个会话是谁"）。
   *
   * 与 `MEMORIES/aliases.md`（她自己认的）分工：这里是**人声明的事实**，优先于她的记录。
   * QQ 不提供单聊/群聊用户的昵称，也没有查成员的接口，所以"这个会话是用户"这类知识
   * 只能从配置来——她拿到的 openid 本身不携带任何身份信息。
   */
  contacts: ContactBook;
}

/** IM 通道（design.md 的落地入口；M9 先接 QQ 官方 Bot API） */
export interface ChannelsConfig {
  /**
   * **她被怎么称呼**（2026-10-02 用户拍板："文本提及也算，关键词匹配就行"）。
   *
   * 群里的人常常不打 @ 而直接喊名字（"弥亚小姐，帮我看看"）——平台不会把这种句子标成
   * "提到了机器人"，所以框架得自己认：正文里出现这几个词，就当作"这条在叫她"，
   * 与 @ 走同一条唤醒路径（进消息流、起 turn）。
   *
   * 分寸：这是**关键词匹配**，不做语义判断（成本为零、行为可预期）。所以填宽了会误唤醒、
   * 填窄了会漏——这件事只能由人来定，也正是它必须可配、且第一次使用时问一次的原因。
   * 空数组 = 只认平台的 @（旧行为）。
   */
  mentionKeywords: string[];
  /**
   * QQ 官方 Bot API 通道（WebSocket 长连接）。默认关闭。
   *
   * 密钥教义照旧：配置文件里只放**环境变量名**，AppID 与 ClientSecret 的值只在真正建连时
   * 从进程环境读（与 readApiKey 同一条纪律）。两者齐备且 enabled 时才起适配器。
   */
  qqOfficial: {
    enabled: boolean;
    /** AppID 所在环境变量名 */
    appIdEnv: string;
    /** ClientSecret 所在环境变量名 */
    clientSecretEnv: string;
    /**
     * 发文本时用**原生 markdown**（`msg_type: 2`）。默认开。
     *
     * 官方文档：`content` 与 `markdown` **互斥**（"传了 markdown 后此字段必须为空"）；
     * 拿不到 markdown 权限的机器人会被服务端拒绝（`40034127`），这里会自动降级为纯文本重发，
     * 所以开着只多花一个失败请求，不会丢话。要不要关，取决于那个机器人有没有权限。
     */
    useMarkdown: boolean;
    /** API 根地址；不写用官方默认 */
    apiBase?: string | undefined;
    /** 凭证地址；不写用官方默认 */
    tokenUrl?: string | undefined;
    /** 网关地址覆盖点（调试/自建代理；不写则 GET {apiBase}/gateway） */
    gatewayUrl?: string | undefined;
    /**
     * 群消息攒批窗口（分钟）。
     *
     * 单聊是「人直接跟你说话」，每句都要及时看；群聊里的一条 @ 往往只是半句话，
     * 回一条就起一个 turn 既贵又容易答错。所以群消息落库后先攒着，等到窗口才起 turn
     * 一起看——看了也不一定说话（要不要发言由她自己定）。0 = 不攒，每条都唤醒。
     */
    groupBatchMinutes: number;
  };
  /**
   * OneBot 11 通道（NapCat / go-cqhttp 等协议端的正向 WebSocket）。默认关闭。
   *
   * 与 QQ 官方通道的差别全在协议侧：这里只连一个本地 ws 端口，没有 AppID/Secret 换取流程；
   * access_token 若协议端开了校验，同样只写**环境变量名**，值在建连时从进程环境读。
   */
  onebot: {
    enabled: boolean;
    /** 协议端正向 ws 地址（如 ws://127.0.0.1:3001） */
    wsUrl: string;
    /** access_token 所在环境变量名 */
    tokenEnv: string;
    /**
     * **由框架拉起的协议端**（可选）。有这一段就由框架负责启动它，并且**接管 wsUrl 与 token**——
     * 两者从协议端自己的配置（`config/onebot.json`）里读，不需要人在两边各填一遍
     *（两边填得不一样是这条链上最难查的故障）。
     *
     * 框架**不下载、不分发**协议端：SnowLuma 是"源码可见非商业许可"，自用可以、随框架分发不行。
     * 所以这里只放一个**人指定的安装目录**；没装就是 not-installed，界面提示去下载。
     *
     * 不写这一段 = 用外部的协议端，行为与以前完全一样。
     */
    managed?: {
      /** 目前只认 snowluma（OneBot 11 协议端） */
      kind: 'snowluma';
      /** 协议端安装目录（绝对路径，或相对 dataDir） */
      dir: string;
      /** 框架启动时自动拉起（默认 true） */
      autoStart?: boolean;
    };
  };
}

/**
 * 外部依赖（docs/design.md §4.18、review.md v30）。
 *
 * 三件外部依赖（pwsh 7 / ripgrep / es.exe）的探测与安装由框架管（`src/deps/`），
 * 这里只留**一个**人工干预的入口：路径。
 *
 * 为什么需要它：`deps.paths.<name>` 是探测三段顺序的**第一段**（用户指定 > 框架自装 > PATH）。
 * 没有它的话，一个人把 rg 装在 `C:\path\to\rg.exe` 而没加 PATH 时，
 * 框架只能告诉他"未安装"——而"我明明装了"是最让人恼火的一类答复。
 * 显式指了却不可用时**不静默落到后两段**：那会变成"我配了却不生效"，
 * 比直接报错难查得多（见 src/deps/probe.ts）。
 */
export interface DepsConfig {
  /** 各依赖的可执行文件路径（绝对路径）；不写 = 走框架自装目录与 PATH */
  paths: {
    pwsh?: string | undefined;
    rg?: string | undefined;
    es?: string | undefined;
  };
}

/**
 * MCP server 的声明面（2026-10-09）。
 *
 * **为什么它到这一版才进 `AppConfig`**：MCP 的声明面过去只活在 `config.json` 里
 * （`real-loop.ts` 的 `declaredMcpServers` 自己读盘、`web/server.ts` 的 `mcpView` 自己读盘），
 * 因为 `McpClientPool` 在生产路径上**从来没有被构造过**——那是"第一次把它接上"，
 * 而接上之后池必须在装配期拿到这份声明面，于是它得有个正经的家（这份配置）。
 *
 * **读盘那条老路仍然保留**（`declaredMcpServers`）：CLI 的 replay / doctor 与不算配置的
 * 测试台没有 `AppConfig`，它们读的是同一份文件。两条路都走 `parseMcpServers`，
 * 校验规则只有一份（下面 `readMcpConfig` 就是这条纪律的落点）。
 *
 * **一个 server 都不声明 = 空数组**（不是"没有这个键"）：`mcp` 入口工具**照旧常驻**，
 * 调用时如实回一句"没有已声明的 server"。工具的有无**不由这份声明面决定**——
 * 清单一变就是一次全 miss（≈9.6 万 token，见 `tools/mcp-entry.ts` 文件头判据 1）。
 */
export interface McpConfig {
  /**
   * `mcp.servers[]`：一个 server 一条，形状见 `McpServerEntry`（`src/mcp/client.ts`）。
   *
   * ⚠️ **这一份声明面进上下文的那一格是"MCP 常驻索引"（v46），而它在重大变化点冻结**
   * （2026-10-10 用户的设计：「增删进入上下文的方式依然还是。追加在末，固定位置，直到上下文
   * 重大变化时归集到正确的索引位置」）：改这里要**重启**才生效（所有字段都如此，
   * 见 `config/watcher.ts` 的空热更白名单），重启就是一次"上下文重大变化"⇒ 索引在这一刻
   * 按**当前这份配置**重建。而运行期里索引那一段的字节**不变**——否则加一个 server
   * 就等于每轮改请求前缀（缓存整段失效）。判据与三个重建触发点写在 `real-loop.mcpIndexSync`
   * 与 `model/render.ts` 的 v46 那一篇，测试在 `test/mcp-index.test.ts`。
   */
  servers: McpServerEntry[];
  /**
   * **整池**同时在飞的 MCP 请求上限（2026-10-10 加，出厂 `DEFAULT_MAX_IN_FLIGHT` = 8）。
   *
   * 语义是硬的：超限**如实拒绝**（回执说"同时在飞的调用已达上限 N 件：这次调用没有发出去，
   * 同时调用太多了"），**不是排队**——排队会引出"唯一在跑的那件在等一件排队的启动"这种死锁面。
   *
   * 两个上限的关系：这一格管**整池总量**（"别同时拉起 N 个别人的进程"，每个 ≈ 一整套 runtime 基线），
   * 逐 server 那一格 `mcp.servers[].maxInFlight`（出厂 4）管"别把同一个 server 打爆"。
   * 今天 `mcp` 与 `task` 都是 exclusive（一次最多一件 MCP 调用在跑），所以这两个数**是兜底不是瓶颈**；
   * 真正要往上调的场景是：**声明的 server 很多、且将来子代理并发起来**（那时同时有好几件在跑）。
   */
  maxInFlight: number;
  /**
   * 池的 **RSS 采样**开关（2026-10-10 加，出厂 **true**）。
   *
   * `true` = 每次成功启动后异步采一次那个 server 的 RSS（进 `mcp/server-resource` 事件，
   * `/api/mcp` 折出"谁在吃内存"）；`false` = 不采，那几格**如实留空**（不是填 0）。
   *
   * **口径是"整棵进程树"**（2026-10-10 第二版）：启动器 + 真 server + conhost 的子/孙进程全都算。
   * 第一版只量根进程，实测会低报 12–21 倍（`uvx mcp-server-time` 6.0 MB vs 整棵树 124.7 MB）；
   * 事件里的 `rssSource` 会说清是哪一种口径（`cim-tree`/`ps-tree` = 整棵树、
   * `tasklist`/`proc`/`ps` = 整棵树读不到时的降级、`unavailable` = 没采到）。判据见 `src/mcp/client.ts`
   * 的 `McpRssSource` / `createMcpRssSampler`。
   *
   * 代价是实的：Windows 上采一次要起一个 PowerShell 读数进程求整棵树（**本机实测中位数 ≈0.95 s**，
   * 降级那条约 0.51 s），仅每个 server 启动时付一次、异步落、不阻塞握手也不进任何一次调用的等待。
   * **环境变量 `IRMIA_MCP_RSS_SAMPLE` 比这一格优先**（命令行临时开关用它）。
   */
  rssSample: boolean;
  /**
   * **额外放行的 MCP 启动器命令名**（2026-10-10 加，出厂空数组）。
   *
   * 这道闸管的是 `servers[].command` 那一格（判据在 `src/mcp/launcher-guard.ts` 的
   * `DEFAULT_STDIO_LAUNCHER_ALLOWLIST`）：命令名必须是已知启动器才肯起进程。
   * 默认表**只放通用启动器**（运行时 / 包管理 / 解释器 / 容器 / 通用壳那一批），
   * 因为它们是"谁的机器上都有、且语义稳定"的那些；**专有工具走这里**——`obscura`、
   * 某个单位内部打包的 `xyz-server.exe`，都只在这台机器上有意义，塞进默认表等于替所有人做主。
   *
   * 语义与 `IRMIA_MCP_STDIO_ALLOWLIST` **逐字相同**（逗号 / 分号分隔也认，大小写不敏感，
   * 路径按文件名那一格判）：两者是**并集**，不是覆盖——**环境变量优先级最高**
   * （它从前的行为一个字节都没改，临时试一次或配置读不到时仍走它）。
   *
   * 顺序（`effectiveLauncherAllowlist`）：默认表 → 这一格 → 环境变量。
   *
   * ⚠️ **为什么这件事值得一道闸**：加一个 server = 在**这台机器上多跑一个不受 `trust.mode`
   * 约束的进程**（那条边界只作用于 fs 族与 `pwsh`，见 `tools/boundary.ts` 与
   * docs/mcp-wiring.md:100-102）。所以这一格**不是"随便填"**：填进去的每一个名字，
   * 都是"我允许配置面用它起一个我管不到的进程"的**显式声明**。放行口只放开"命令名"这一格
   * ——逐启动器禁内联执行（`python -c` / `node -e` / `pwsh -Command` / `cmd /c` /
   * `docker --network host` 那些）与 args/env 控制字符那两层**照旧生效**。
   *
   * **什么时候该用配置、什么时候该进默认表**：默认表只放通用启动器；专有工具走配置。
   * 判断标准是"这个名字对**别人**是不是也是同一个程序、同一个语义"——是，才可能进默认表。
   *
   * **改这一格不需要重启**：它与 `servers[]` 同属声明面热更（`config/watcher.ts` 的
   * `HOT_RELOAD_FIELDS` 里那一项就是 `mcp.servers`，而放行口参与的是**解析**）——
   * 写坏了两者中的任何一个，那份配置都过不了解析 ⇒ 按"保留旧配置继续跑"处置（见 watcher 文件头）。
   */
  extraLaunchers: string[];
}

/** 生效的配置全量。人可读、可 JSON 序列化、无循环引用，可直接参与指纹计算 */
export interface AppConfig {
  /** 配置 schema 版本 */
  schemaVersion: number;
  /** 数据根目录（绝对路径）：事件日志、投影缓存、锁、persona 都在它下面 */
  dataDir: string;
  /** 信任范围（她的活动边界：整台电脑 / 只限工作目录）。默认完全信任，见 TrustConfig */
  trust: TrustConfig;
  models: ModelsConfig;
  budget: BudgetConfig;
  wake: WakeConfig;
  vision: VisionConfig;
  speak: SpeakConfig;
  persona: PersonaConfig;
  tools: ToolsConfig;
  /**
   * MCP 声明面（`mcp.servers[]`）与两格池级参数（`mcp.maxInFlight` / `mcp.rssSample`）。
   * 默认一个 server 都不声明（空数组）；两格池级参数各有出厂值——整池在飞上限 8、RSS 采样开
   *（⚠️ 这里**不写** `字段: 值` 那种形状：`tools/make-config-example.ps1` 的 Read-CodeDefaults
   *  按正则抓"字段默认值"、且**同名只留第一次出现**，写在注释里会让它把注释当成默认值的出处，
   *  `$expect` 的断言就再也盯不住 `buildDefaults` 那一行了）。
   *
   * 它是**启动参数**：`McpClientPool` 在装配期按这份声明面建好，改完要重启进程才接管
   * （界面的 `mcp-save` / `mcp-remove` 回执里也是这么说的 —— `restartRequired: true`）。
   */
  mcp: McpConfig;
  /** 外部依赖（pwsh / rg / es）的用户指定路径；探测的第一段 */
  deps: DepsConfig;
  channels: ChannelsConfig;
  alerts: AlertsConfig;
  /** 上下文审计阈值（缓存破坏哨兵）：默认保守，见 ContextAuditConfig */
  contextAudit: ContextAuditConfig;
  web: WebConfig;
  /** IANA 时区名（operations.md §2：budget/rollover 的"今日"按它解释） */
  timezone: string;
}

// ──────────────────────────────── 错误 ────────────────────────────────

/**
 * 配置错误。带定位信息（字段路径或文件路径），启动期直接打印即可施救。
 * 所有类型/范围问题都走这里，不做"尽力而为"的猜测修正。
 */
export class ConfigError extends Error {
  /** 出错位置：字段路径（如 `budget.softRatio`）或文件路径 */
  readonly where: string;

  constructor(message: string, where: string) {
    super(message);
    this.name = 'ConfigError';
    this.where = where;
  }
}

// ──────────────────────────────── 默认值 ────────────────────────────────

/** 系统时区（拿不到就退 UTC，绝不因为时区探测失败而让进程起不来） */
export function systemTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz !== '' ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * 默认配置（唯一默认值源）。`dir` 是配置所在目录，相对路径字段以它为基准解析成绝对路径。
 * 每次调用都新建对象，调用方改返回值不会污染后续加载。
 */
function buildDefaults(dir: string): AppConfig {
  return {
    schemaVersion: CONFIG_VERSION,
    dataDir: join(dir, DEFAULT_DATA_DIR_NAME),
    // 默认**完全信任**：用户 2026-10-04 的明确决定（"能够触碰整个电脑是默认行为"）。
    // 字面量 'full' 是刻意的：出包脚本按正则从这一行抓默认值（见下面 persona.stateBudgetBytes 那条说明）
    //
    // `workspaceRoot` 的默认是 **`dir`＝配置目录＝智能体自己的工作根**（= fs 工具族今天用的那个根，
    // 也是 `agent-loop.ts` 的 `deps.workspaceRoot ?? process.cwd()`）。2026-10-05 改的，
    // 原来写的是 `<dir>/workspace`，那个默认**是错的**：`workspace` 档下她连自己的
    // `<dataDir>/workspace/MEMORIES/`（记忆）与 `<dataDir>/persona/`（人格资产）都读不到——
    // 记忆与人格都在配置目录之下、而在 `<dir>/workspace` 之外，那不是"只限工作目录"，
    // 是把她锁在门外（实测见 test/trust-boundary.test.ts 的那组用例）。
    // 改完之后两档的语义干净了：**`workspace` 档 = 今天的行为**（与 fs 工具今天用的根同一个），
    // **`full` 档 = 新放开的那一档**（整台电脑）。
    trust: { mode: 'full', workspaceRoot: dir },
    models: {
      heavy: { model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, apiKeyEnv: DEFAULT_API_KEY_ENV },
      light: { model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL, apiKeyEnv: DEFAULT_API_KEY_ENV },
    },
    budget: {
      stepTools: 20,
      // 出厂单 turn 步数上限 = 60（**次数**，与 token 口径无关）：对齐现场 config.json 的实测值
      //（`budget.turnSteps: 60`）。
      //
      // ⚠️ 写**十进制字面量**（不写 `6e1`、也不写算式）：出包脚本 Read-CodeDefaults 按正则抓字段
      // 默认值，算式抓不到就当场拒绝出包（"字段改名了？"）。理由与下面 taskTokens 那条同源。
      turnSteps: 60,
      // 出厂单任务额度 = 5e8 —— **非缓存口径**。
      //
      // 口径 = `(inputTokens − cacheHitTokens) + outputTokens`：**输入里没命中缓存的那部分 + 输出**，
      // 也就是"真花钱的那部分"。旧口径（未扣缓存、含 cacheHit）在真实唤醒的心跳之下是失真的：
      // 心跳每一拍约 4.5 万 input 里约 97% 是缓存命中，旧口径把命中那 97% 也当钱算，
      // 计数器飞快见顶、"预算耗尽"天天响，而真实花销很小。
      //
      // 为什么是 **5e8**（= 日额度 5e7 的 **10 倍**）：**让"日"那一层当主力刹车**。
      // task 撞线 = "这次任务收尾、进待确认"，daily 撞线 = "今天拒绝唤醒"——一整天的量该由日额度管，
      // 所以 task 要比 daily 宽出量级去。这一条与更早的默认（task = daily = 1e8）方向相反，是**有意**的。
      //
      // ⚠️ 写**十进制字面量**（不写 `5e8`、也不写算式）：出包脚本 Read-CodeDefaults 按正则抓字段
      // 默认值，算式抓不到就当场拒绝出包。理由与下面 dailyTokens 那条同源（那条注释里还有一笔账）。
      taskTokens: 500000000,
      // 出厂日额度 = **5e7，非缓存口径**。
      //
      // 为什么是 5e7（不是拍的，是一笔账）：心跳是**真实唤醒**——每一拍都真发一次 heavy 请求，
      // 并且刻意共用同一份冻结前缀去保温供方的前缀缓存（见 design.md §4.12）。于是心跳自己就有
      // 日开销：按现在这套概率分布实测均值约 15 分钟一拍 ⇒ 约 96 拍/天；每拍**非缓存**的部分
      // ≈ 该 turn 第 1 拍的未命中 + 输出 ≈ **0.36 万 + 0.035 万 ≈ 0.4 万 token**
      //（实测分量：一拍里命中约 4.2 万、**未命中约 0.36 万**、输出中位约 350——未命中那一项就是
      // 下面这笔账的乘数。口径、样本量与脚本：`_research/heartbeat-real-wake-audit.mjs`，
      // 结论记在 design.md §4.12）。
      // 于是 ≈ **96 × 0.35 万 ≈ 0.35M/天**——5e7 是它的**约 140 倍**，心跳只占日额度的零头，
      // 剩下的量级全部留给"心跳之上的真实工作"。
      //
      // ⚠️ 这个数**贴不贴**，如实记一笔实测（2026-10-05：00:00→17:13 本地、494 次调用）：
      // 非缓存 2,050,232（miss 1,471,532 + 输出 578,700）。也就是说一个正常工作日 ≈ 2M 量级，
      // 5e7 是它的约 **25 倍**——真正在动的量级是这个，不是心跳本身。
      //
      // ⚠️ 写**十进制字面量**、不写算式（不写 `5e7`、也不写 `5 * 1000 * 1000`）：出包脚本
      // `tools/make-config-example.ps1` 的 Read-CodeDefaults 按正则抓字段默认值，算式抓不到就
      // 当场拒绝出包（"字段改名了？"）。理由与 persona.stateBudgetBytes 那条同源。
      // 测试侧还有一条**反向断言**拦着它被调小（test/config.test.ts），那条断言里的账按新口径重算过。
      dailyTokens: 50000000,
      // 软阈值比例：到 上限×ratio 时先提示她收尾，越过才硬停（`budget-guard.ts`）。
      // **语义不变**（"日软阈值 = 日额度 × ratio"），含义随口径更新：
      //   日那一档：软 5e7 × 0.8 = **4e7 非缓存**，硬 5e7；
      //   task 那一档：软 5e8 × 0.8 = **4e8 非缓存**，硬 5e8。
      // 于是**日那一档是主力刹车**（5e7 < 5e8 ⇒ 日先响）：一个正常日子在她烧到 4e7 时先收到
      // 一句软提示（尾部插播，不改已渲染历史），烧到 5e7 就拒绝唤醒。task 那一层退成"单个任务
      // 跑得太久"的兜底（它比日额度宽 10 倍，正常任务在一天之内撞不到它）。
      // 与更早的默认（task = daily = 1e8，日软阈值 80M 是名义值、真正起作用的是 task 那一层）
      // 方向相反，是有意改的：预算只盯真花钱的那部分，而"一整天"该由日额度管。
      // ⚠️ 这两档都是**启动参数：改完要重启进程才生效**（`config.budget` 整段如此）。
      softRatio: 0.8,
      failStreakMax: 20,
    },
    wake: {
      heartbeatFloorMin: 5,
      heartbeatCeilMin: 60,
      heartbeatTickMin: 1,
      // 目标均值 30 分钟：出厂默认的节奏是"平均每半小时露一次面"。
      // 参考量级：同一套分布形状在 5/60/1/15 那组参数下实测平均约 15 分钟醒一次
      //（中位数 15，5% 分位 8，95% 分位 24）——30 就是把这个节奏放宽一倍，心跳开销也跟着减半。
      // 它同时也是"没写过这个字段的人"的值。
      heartbeatTargetMeanMin: 30,
      memoryMaintainCron: DEFAULT_MEMORY_MAINTAIN_CRON,
    },
    vision: {
      imagesToContext: true,
      maxContextImages: 2,
    },
    speak: {
      typingEffect: true,
      charsPerMinute: 90,
      // 开口前的"正在输入"（`msg_type: 6` + `input_notify`）：出厂**开**。
      // 为什么默认开：它是用户 2026-10-11 点名要做的那一件（「只做正在输入。speak 时触发」），
      // 而且失败不影响说话、群聊自动跳过、不占主动消息配额——开着没有"会坏事"的路径；
      // 唯一未亲验的是"算不算一次被动回复"，那条留给这一格设成假值这个出口。
      //
      // ⚠️ 上面那两句注释**不许写成字面量**（例如写"留给 speak 的那一格设成假"时顺手写成
      // `字段名 + 冒号 + false`）：`tools/make-config-example.ps1` 的 Read-CodeDefaults 按**行序**
      // 抓"第一次出现的 `名字: 字面量`"，注释里那一行会被它当成代码默认值 ⇒ 出包当场报
      // 「出厂值 True ≠ 代码默认值 False」。（2026-10-11 真的这么栽过一次，所以把话留在这里。）
      inputNotify: true,
    },
    persona: {
      // 出厂压缩阈值 = 100000（可见历史估算超过它就压一次）：对齐现场 config.json 的实测值
      //（`persona.compactionThresholdTokens: 100000`）。
      //
      // 为什么现场从 32000 抬到了 100000：32000 太勤——可见历史刚过 3 万 token 就压一次，
      // 摘要本身也要花一次 light 调用，压得太勤反而把"省上下文"变成"多花钱"。
      //
      // ⚠️ 写**十进制字面量**（不写 `1e5`、也不写算式）：出包脚本 Read-CodeDefaults 按正则抓字段
      // 默认值，算式抓不到就当场拒绝出包（"字段改名了？"）。理由与 budget.taskTokens 那条同源。
      compactionThresholdTokens: 100_000,
      handoffBudgetTokens: 4_096,
      handoffFoldTokens: 1_024,
      owner: 'owner',
      // 默认 true = 现在这套自带记忆系统（框架生成索引、每轮注入、每日整理）。
      // 改成 false 是**显式选择**"让她自己管记忆"，不该由一次手误变成默认行为
      memoryEnabled: true,
      // 8 KB ≈ 1.8k token：够放"当前任务 + 接着干 + 几条边界"。理由与实测见上面那条常量
      // ⚠️ 这里写**字面量** 8192（不写 `DEFAULT_STATE_BUDGET_BYTES` 这个标识符）：出包脚本
      // `tools/make-config-example.ps1` 的 Read-CodeDefaults 按正则抓字段默认值，常量表来自
      // `const NAME = 字面量`——上面那条常量是 `8 * 1024`（算式），它解不出来，抓不到就**当场报错**
      // 拒绝出包（"字段改名了？"）。字面量让那条断言照旧生效：改常量忘了改这里，出包就会红。
      stateBudgetBytes: 8192,
      contacts: {},
    },
    tools: {
      destructiveEnabled: false, groupSceneHardRefusal: false, planMode: false, disabled: [],
      askHumanTimeoutMin: DEFAULT_ASK_HUMAN_TIMEOUT_MIN,
      // 默认**关**：见 ToolsConfig.taskEnabled 那一段（清单是冻结前缀的一部分，
      // 加一件 = 一次缓存 miss + 常驻 token，所以要人显式要，而不是默认替所有人付）
      taskEnabled: false,
    },
    // 默认一个 server 都不声明（**不是"没有这个键"**）：`mcp` 入口工具照旧常驻，
    // 调用时如实回"没有已声明的 server"。理由见 McpConfig 的注释与 tools/mcp-entry.ts 判据 1。
    //
    // 两个全局格（2026-10-10 加）的出厂值：
    //   · maxInFlight：整池同时在飞上限（值 = `mcp/client.ts` 的 `DEFAULT_MAX_IN_FLIGHT`）。
    //     ⚠️ 这里写**字面量 8**，不写那个标识符：出包脚本 `tools/make-config-example.ps1` 的
    //     Read-CodeDefaults **只读本文件**，它的常量表来自**本文件里**的 `const NAME = 字面量`
    //     ——`DEFAULT_MAX_IN_FLIGHT` 定义在 `mcp/client.ts`，它解不出来（写了就是"这个字段
    //     在 config.ts 里找不到默认值"，出包当场红）。两处同值由 `test/config.test.ts` 的断言钉住
    //     （与上面 `stateBudgetBytes: 8192` 同一条理由、同一种做法）。
    //   · rssSample：真 = 每个 server 启动后异步采一次它的 RSS（**整棵进程树**）——观测面要的"谁在吃内存"。
    //   · extraLaunchers：额外放行的启动器命令名（出厂空 = 只有默认表 + 环境变量那两格）。
    //     出厂**必须留空**：填一个具体名字等于替使用者放行一个他可能根本没有的程序。
    mcp: { servers: [], maxInFlight: 8, rssSample: true, extraLaunchers: [] },
    // 默认一个路径都不指定：探测的三段顺序里"用户指定"是显式干预，
    // 默认值必须是"没干预"，否则框架自装目录与 PATH 就永远轮不到
    deps: { paths: {} },
    channels: {
      // 默认空：只认平台的 @（旧行为）。第一次使用时界面会问一次，也可以随时在设置里改
      mentionKeywords: [],
      qqOfficial: {
        enabled: false,
        appIdEnv: DEFAULT_QQ_APP_ID_ENV,
        useMarkdown: true,
        clientSecretEnv: DEFAULT_QQ_CLIENT_SECRET_ENV,
        groupBatchMinutes: DEFAULT_QQ_GROUP_BATCH_MINUTES,
      },
      onebot: {
        enabled: false,
        wsUrl: DEFAULT_ONEBOT_WS_URL,
        tokenEnv: DEFAULT_ONEBOT_ACCESS_TOKEN_ENV,
      },
    },
    alerts: { rateLimitMin: 30 },
    contextAudit: {
      cacheBreakIdleMin: 30,
      cacheBreakHitDrop: 0.5,
    },
    web: { host: '127.0.0.1', port: 7788 },
    timezone: systemTimezone(),
  };
}

/** 默认配置（经同一套校验，保证默认值自身合法——默认配置是自检过的配置） */
export function defaultConfig(dir: string): AppConfig {
  return parseAppConfig({}, resolve(dir));
}

// ──────────────────────────────── 文档读取与注释 ────────────────────────────────

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 「她被怎么称呼」最多几个词、每个词多长：填成"整个群名"或贴一整段话都没有意义 */
export const MENTION_KEYWORD_MAX = 20;
export const MENTION_KEYWORD_LEN_MAX = 24;

/**
 * 解析 `channels.mentionKeywords`：**宽容但不猜**。
 *
 * 宽容之处：字符串数组、单个字符串（人可能只填一个词）、带空格的逗号/顿号分隔串，都收。
 * 严格之处：非字符串项直接报错（不静默丢掉——"我配了却不生效"比报错难查得多，见文件头的纪律）；
 * 超长/超数的**截断并报错**：截断是怕它悄悄膨胀成一份没人看的名单，报错是因为那是配置错误。
 */
function parseMentionKeywords(raw: JsonValue | undefined): string[] {
  if (raw === undefined) return [];
  const list: string[] = [];
  if (typeof raw === 'string') {
    list.push(...raw.split(/[,，、\s]+/u));
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw new ConfigError(
          `channels.mentionKeywords 里只允许字符串（这一项是 ${describeValue(item)}）`,
          'channels.mentionKeywords',
        );
      }
      list.push(item);
    }
  } else {
    throw new ConfigError(
      `channels.mentionKeywords 应是字符串数组（或一个逗号分隔的字符串），实际是 ${describeValue(raw)}`,
      'channels.mentionKeywords',
    );
  }
  const out: string[] = [];
  for (const item of list) {
    const word = item.trim();
    if (word === '') continue;
    if ([...word].length > MENTION_KEYWORD_LEN_MAX) {
      throw new ConfigError(
        `channels.mentionKeywords 里的「${word.slice(0, 12)}…」太长（上限 ${MENTION_KEYWORD_LEN_MAX} 字）：`
        + '这里要填的是"她可能被怎么称呼"，不是一整句话',
        'channels.mentionKeywords',
      );
    }
    if (!out.includes(word)) out.push(word);
  }
  if (out.length > MENTION_KEYWORD_MAX) {
    throw new ConfigError(
      `channels.mentionKeywords 最多 ${MENTION_KEYWORD_MAX} 个词（现在 ${out.length} 个）`,
      'channels.mentionKeywords',
    );
  }
  return out;
}

/** 递归剔除注释键（`$` 前缀与 `//`）。未知键保留——向前兼容未来版本的字段 */
export function stripComments(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => stripComments(item));
  if (isPlainObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith(COMMENT_PREFIX) || key === '//') continue;
      out[key] = stripComments(item);
    }
    return out;
  }
  return value;
}

function parseJsonDocument(text: string, path: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`配置文件不是合法 JSON（${path}）：${detail}`, path);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`配置文件顶层必须是 JSON 对象（${path}）`, path);
  }
  return value as JsonObject;
}

/**
 * 把声明面写成**可序列化**的形状（`defaultDocument` 用）。
 *
 * 为什么要逐字段抄一遍而不是 `{...entry}`：`McpServerEntry` 带着 `readonly string[]`
 * 与几个可选字段，它**不是** `JsonValue`（TS 会拦下来，这是好事——它逼这里显式列出
 * 写进文件的每一个字段，于是"哪些字段会落进用户的 config.json"永远是一眼可核对的）。
 */
function mcpServersToJson(servers: readonly McpServerEntry[]): JsonObject[] {
  return servers.map((entry) => {
    const out: JsonObject = { name: entry.name, command: entry.command };
    if (entry.args !== undefined) out['args'] = [...entry.args];
    if (entry.cwd !== undefined) out['cwd'] = entry.cwd;
    if (entry.env !== undefined) out['env'] = { ...entry.env };
    if (entry.disabled !== undefined) out['disabled'] = entry.disabled;
    if (entry.requestTimeoutMs !== undefined) out['requestTimeoutMs'] = entry.requestTimeoutMs;
    if (entry.idleReclaimMs !== undefined) out['idleReclaimMs'] = entry.idleReclaimMs;
    if (entry.toolDefaults !== undefined) out['toolDefaults'] = toolAttributesToJson(entry.toolDefaults);
    if (entry.tools !== undefined) {
      const tools: JsonObject = {};
      for (const [name, attrs] of Object.entries(entry.tools)) tools[name] = toolAttributesToJson(attrs);
      out['tools'] = tools;
    }
    return out;
  });
}

function toolAttributesToJson(attrs: McpToolAttributes): JsonObject {
  const out: JsonObject = {};
  if (attrs.sideEffect !== undefined) out['sideEffect'] = attrs.sideEffect;
  if (attrs.executionMode !== undefined) out['executionMode'] = attrs.executionMode;
  if (attrs.timeoutMs !== undefined) out['timeoutMs'] = attrs.timeoutMs;
  return out;
}

/**
 * 带注释的默认配置文档：内容全部来自 `defaultConfig()`，只有 `$comment` 是手写的。
 * 单一默认值源 + 注释插值，避免"模板与默认值漂移"这种最恶心的配置 bug。
 */
function defaultDocument(dir: string): JsonObject {
  const d = defaultConfig(dir);
  return {
    $comment: [
      'Irmia Agent 配置（M2 最小子集：JSON 语法子集，语义对齐 docs/operations.md §1）',
      '以 "$" 开头的键是注释，加载时忽略；删掉它们不影响运行。',
      '密钥不落配置文件：apiKeyEnv 只写环境变量名，密钥值放进程环境里。',
      '本文件缺失时会自动重建；字段缺失时按默认值补齐，但不会自动改写你写过的文件。',
    ],
    schemaVersion: d.schemaVersion,
    dataDir: d.dataDir,
    models: {
      $comment: [
        'heavy = turn 主循环；light = 必要性判断/摘要/守卫分类；degraded = 降级链备用路由（不写即不启用）。',
        'baseUrl 是 API 根地址（不含 /responses）。',
      ],
      heavy: { model: d.models.heavy.model, baseUrl: d.models.heavy.baseUrl, apiKeyEnv: d.models.heavy.apiKeyEnv },
      light: { model: d.models.light.model, baseUrl: d.models.light.baseUrl, apiKeyEnv: d.models.light.apiKeyEnv },
    },
    budget: {
      $comment: [
        '三层刹车 + 每日额度 + 软阈值（design.md §4.6）。全部跨重启累计。',
        'softRatio：达到 上限×ratio 时先提示模型收尾，越过才硬停。',
        'stepTools 默认 20 / turnSteps 默认 60：这两层数的是**次数**（不是 token）。单 step 最多 20 次工具调用、',
        '  单 turn 最多 60 个 step；它们是防跑飞的兜底，正常任务离它们很远。改完要重启进程才生效。',
        'taskTokens / dailyTokens 的口径是**非缓存**的 token 数 = (input − cacheHit) + output：',
        '  只算输入里没命中缓存的那部分 + 输出，也就是"真花钱的那部分"。命中缓存的那一大截不算，',
        '  因为心跳每拍约 97% 的输入都是缓存命中，按未扣缓存的口径算，计数器会飞快见顶。',
        'dailyTokens 默认 50000000（5e7，单日非缓存预算）：心跳是**真实唤醒**（每拍真发一次请求去保温',
        '  供方的前缀缓存），一天约 96 拍、每拍非缓存约 0.4 万 ⇒ 心跳自己约 0.35M/天，',
        '  5e7 是它的约 140 倍——心跳只占零头，其余留给真实工作。',
        '  参考量级：一个满负荷的工作日实测约 2M 非缓存（494 次调用），5e7 是它的约 25 倍。',
        'taskTokens 默认 500000000（5e8，= 日额度的 10 倍）：让"日"那一层当主力刹车',
        '  （日撞线 = 今天拒绝唤醒、task 撞线 = 这次任务收尾），所以 task 要比 daily 宽出量级去。',
        '⚠️ 这里的额度由你自己定；上面两个是**出厂默认**，改完要重启进程才生效。',
      ],
      stepTools: d.budget.stepTools,
      turnSteps: d.budget.turnSteps,
      taskTokens: d.budget.taskTokens,
      dailyTokens: d.budget.dailyTokens,
      softRatio: d.budget.softRatio,
      failStreakMax: d.budget.failStreakMax,
    },
    wake: {
      $comment: [
        '心跳是**概率**的：安静不足 heartbeatFloorMin 分钟绝不触发，到 heartbeatCeilMin 分钟必然触发，',
        '中间每 heartbeatTickMin 分钟抽一次签，命中概率随安静时间单调上升（design.md §4.12）。',
        '**改频率只需要改 heartbeatTargetMeanMin（目标均值，分钟）**——平均多久醒一次就写多少，',
        '  曲线的形状指数 α 由它在启动时反解出来，不用（也不能）手调。',
        '默认 5 / 60 / 1 / 30 分钟：安静不足 5 分钟绝不触发，到 60 分钟必然触发，中间每 1 分钟抽一次签。',
        'heartbeatTargetMeanMin 必须**严格**落在 heartbeatFloorMin 与 heartbeatCeilMin 之间（否则启动报配置错），',
        '  且落在 5~60 的合理范围内；它与 floor/ceil/tick 一样是**启动参数：改完要重启进程才生效**。',
        'floor / ceil 仍然兜住两端：不管目标均值写多少，安静不足 floor 分钟绝不触发、到 ceil 分钟必然触发。',
        '任何外部事件到达即复位安静计时。',
        'memoryMaintainCron：每日记忆整理的 cron（五段：分 时 日 月 周），默认凌晨 4 点；空串关闭该任务。',
      ],
      heartbeatFloorMin: d.wake.heartbeatFloorMin,
      heartbeatCeilMin: d.wake.heartbeatCeilMin,
      heartbeatTickMin: d.wake.heartbeatTickMin,
      heartbeatTargetMeanMin: d.wake.heartbeatTargetMeanMin,
      memoryMaintainCron: d.wake.memoryMaintainCron,
    },
    vision: {
      $comment: [
        '图片进上下文的两条途径（design.md §4.20）：聊天图片直接进上下文（模型亲眼看），以及 vision_read 的文字转述。',
        'imagesToContext：默认 true。开 = QQ 发来的图片直接进上下文（最多 maxContextImages 张），且 vision_read 可用 inline 参数把指定图放进上下文；关 = 图片一律不进，只剩地址与转述。',
        'maxContextImages：同时待在上下文里的图片张数上限（默认 2）。图片每轮都要重发，留太多等于每轮都为旧图付费。',
      ],
      imagesToContext: d.vision.imagesToContext,
      maxContextImages: d.vision.maxContextImages,
    },
    speak: {
      $comment: [
        '发言节奏（speak 的拆条投递）：段与段之间按"这一段要打多久"隔开，界面与 IM 同一节奏。',
        'typingEffect：默认 true。关掉则所有段立刻发完，没有"人在打字"的体感。',
        'charsPerMinute：打字速度（默认 90 字/分钟，中文手机输入的常见速度）。调大说得更快，范围 30~600。',
        'inputNotify：默认 true。她每次 speak 真正说话**之前**先发一个"正在输入"状态（官方 msg_type=6 + input_notify，一次 speak 至多一次）。',
        '  · **仅单聊**：官方只有单聊接口列了这个能力，群里一次都不发（如实跳过，不是失败）；OneBot 通道没有这条能力，同样跳过。',
        '  · **失败不影响说话**：发不出去就照旧说，最多等 2.5 秒。',
        '  · ⚠️ 它到底算不算一次"被动回复"（单聊那条窗口一共 4 次），**官方文档没写**——本仓未亲验。真撞上会表现为随后那条正文收到 40034128，那种情况把它关掉。',
        '  · 关掉 = 一个请求都不发。',
      ],
      typingEffect: d.speak.typingEffect,
      charsPerMinute: d.speak.charsPerMinute,
      inputNotify: d.speak.inputNotify,
    },
    persona: {
      $comment: [
        '人格连续性与上下文压缩（design.md §4.11/§4.13、persona.md §4）。',
        'compactionThresholdTokens：可见历史估算超过它就在 turn 结束时压缩（写 compaction/summary，历史只遮蔽不重写）。默认 100000：这个量级够一段完整工作留在可见历史里，又远在上下文上限之下；调小会压得更勤（每次压缩自己也要花一次调用）。',
        'handoffBudgetTokens / handoffFoldTokens：交接笔记的总预算与最近条目的单条满预算。',
        'owner：本机用户的档案标识。你在聊天框说话时它会作为 person 注入，于是 persona/RELATIONSHIPS/<owner>.md 自动生效——文件名必须和这里一致（默认 owner）。',
        'memoryEnabled：**框架代管记忆**的总开关，默认 true（框架生成 MEMORIES/INDEX.md、每轮注入索引、每日 4 点整理、并维护 !pinned 与条目 TTL）。',
        '  关掉（false）＝框架不生成索引、不注入任何记忆、不跑整理；她只从装置自述知道 MEMORIES/（facts.md / episodes/ / jargon.md / style-notes.md / aliases.md）与 diary/ 存在，读写维护全归她自己。',
        '  关掉的代价写在明面上：她可能忘了整理、facts.md 会一直长下去、索引不再更新。不受影响的：MEMORIES/aliases.md 参与"会话认人/关注名单"属于通道侧，STATE.md（她当前状态）是独立的一层。',
        'stateBudgetBytes：persona/STATE.md 的**字节预算**，默认 8192（8 KB ≈ 1.8k token）。',
        '  越过它时框架在**此刻层**（每步都发的那一段）多一行「[STATE.md] …——预算超限，记得维护，将过时内容移入记忆文件或删除」，让她自己去把过时内容搬进记忆文件或删掉。',
        '  为什么是 8 KB：够放「当前任务 + 接着干 + 几条边界」这三样（下一拍真的要用）的那点状态；出厂的 STATE.md 实测 17007 字节 ≈ 3.8k token/次，而且是**每轮都在重发**。',
        '  只提醒、不截断：框架不动她的文件，也不替她搬内容。她压回预算内之后那一行自动消失（不需要"已读"）。单位是字节（与 write_persona 的字节口径同源）；改完要重启进程才接管。',
        'contacts：联系人表（会话 sid → 名字）。QQ 不给昵称，也不提供查成员的接口，所以“这个 QQ 会话是用户”只能在这里声明；优先于她自己的 MEMORIES/aliases.md。',
      ],
      compactionThresholdTokens: d.persona.compactionThresholdTokens,
      handoffBudgetTokens: d.persona.handoffBudgetTokens,
      handoffFoldTokens: d.persona.handoffFoldTokens,
      owner: d.persona.owner,
      memoryEnabled: d.persona.memoryEnabled,
      stateBudgetBytes: d.persona.stateBudgetBytes,
      contacts: { ...d.persona.contacts },
    },
    tools: {
      $comment: [
        'destructive 工具开关，三态：false 全关（默认）/ true 全开 / 数组只开名单内的（如 ["pwsh","http_post"]）。',
        '「危险」在系统里的含义是"崩溃后不可自动重试"，不代表开关可以随手打开。',
        'planMode：开启后 destructive 调用先落 plan/pending 等人工批准，批准一次只放行一次。',
        'askHumanTimeoutMin：她用 ask_human 问了人之后多久没人答，就落一条「未批准、未拒绝」的事实'
          + '（human/expired）。它**不是**"超时怎么办"的默认动作——超时不批准、不拒绝、也不撤卡，'
          + '只是让她得知人可能不在机器旁，换不换方式找人是她自己的判断。',
        'taskEnabled：**隔离子代理工具 `task`**（design §4.21），默认 false（不注册）。',
        '  为什么默认关：工具清单是请求**冻结前缀**的一部分——多一件不只是每轮多付一份 schema，'
          + '更是**清单一变就一次缓存 miss**（前缀之后的内容在服务端缓存里整段失效）。所以要人显式要。',
        '  打开后：清单 24 → 25 件；她多一件能把「读一批文件再汇总」「与主线无关的调查」整块外包的工具'
          + '（子代理独立上下文、预算从父扣减、默认不能再下派）。',
        '  它是启动期读一次的参数：改完要重启进程才接管。',
      ],
      destructiveEnabled: d.tools.destructiveEnabled,
      planMode: d.tools.planMode,
      askHumanTimeoutMin: d.tools.askHumanTimeoutMin,
      taskEnabled: d.tools.taskEnabled,
      disabled: [...d.tools.disabled],
    },
    mcp: {
      $comment: [
        'MCP server 声明（design.md §4.19）。**一条一个 server**，形状：',
        '  { "name": "time", "command": "uvx", "args": ["mcp-server-time"] }',
        'name 只允许字母、数字、- 与 _（这个名字调用时用得到，判据 src/mcp/client.ts 的 MCP_NAME_PATTERN）；command 是可执行文件（PATH 里找得到，或写绝对路径）。',
        '⚠️ **command 必须是这一台机器上真起得来的东西**。三种实测能起的写法：`uvx <工具名>`、',
        '  `node <绝对路径>/cli.js`（把那个包落下来、直指入口 js）、任何**绝对路径的 .exe**（原生单文件最省）。',
        '  **不要写 `npx` / `npm` / `pnpm` / `yarn`**：在 Windows 上它们只有 .cmd/.ps1 垫片，而我们的',
        '  启动器是 `spawn(command, args)`、不经 shell ⇒ 起不来的那一刻只有一句 ENOENT；`npx.cmd` 这类',
        '  包装脚本更直接被 Node 同步拒掉（CVE-2024-27980 之后的缓解：必须 shell:true）。这一条的判据与',
        '  "为什么 / 改成什么"整段话在 src/mcp/launcher-guard.ts 的「这一台机器上起不来的形状」那一节',
        '  （**只有一处**），起进程之前就会把它当成回执给出来——所以这里不再骗你写 npx',
        '  （那一行曾经就是 `{"command":"npx"}`）。',
        '⚠️ **command 还要过启动器白名单**（2026-10-09 加，判在任何子进程被拉起之前）：默认只认常见的',
        '  运行时/包管理/解释器/容器启动器（uvx、node、python、pwsh、cmd、docker、npx 那一批），',
        '  且逐启动器禁内联执行（python -c / node -e / pwsh -Command / cmd /c / docker --network host …）；',
        '  白名单在 src/mcp/launcher-guard.ts，要加自定义启动器就设环境变量',
        '  IRMIA_MCP_STDIO_ALLOWLIST=命令名,逗号分隔 再重启（显式放行才算数；内联执行那层放行口关不掉）。',
        '  理由：加一个 server = 在这台机器上多跑一个不受 trust.mode 约束的进程（docs/mcp-wiring.md:100-102）。',
        '可选字段：cwd / env（字符串到字符串）/ disabled:true（保留条目但不起进程，临时停用不必删配置）；',
        '  requestTimeoutMs / idleReclaimMs（逐 server 覆盖超时与空闲回收窗口）；',
        '  maxInFlight（这个 server 上**同时在飞**的请求上限，出厂 4：超限时那次调用**不会发出去**，',
        '    回执如实说"同时调用太多"——这是自保，不排队、不抢占）；',
        '  toolsCache:false（关掉这个 server 的**工具清单落盘缓存**，出厂开）：清单缓存落在',
        '    <dataDir>/mcp-cache/<server>.json，命中时"看一眼它有哪些工具"从一次冷启动变成读一个 json；',
        '    代价是那份清单可能过期 ⇒ 回执里一定会标明"取回于 X、可能已过期"，不会静默；',
        '    command/args/cwd/env 变了（指纹不同）或它起不来时，缓存自动作废、下次真连一次。',
        '  toolDefaults / tools（逐 server、逐工具声明三属性 sideEffect / executionMode / timeoutMs）。',
        '两格**全局**的（与上面那些逐 server 的不同，写在 servers 旁边那一层）：',
        'extraLaunchers（**额外放行的启动器命令名**，出厂空数组）：command 那一道闸的放行口。',
        '  · 默认只认通用启动器（uvx、node、python、pwsh、cmd、docker 那一批）；专有工具（例如 obscura、',
        '    或者某个单位内部打包的 xyz-server.exe）写在这里——它们只在这台机器上有意义，',
        '    塞进默认表等于替所有人做主。默认表只放通用启动器，专有工具走这一格。',
        '  · 语义与环境变量 IRMIA_MCP_STDIO_ALLOWLIST **完全一样**（逗号/分号分隔也认、大小写不敏感、',
        '    按命令名判）：两者是**并集**，而**环境变量优先级最高**（临时试一次走它，行为没变）。',
        '  · ⚠️ 这一格**不是"随便填"**：加一个 server = 在这台机器上多跑一个**不受 trust.mode 约束**的',
        '    进程（那条边界只作用于 fs 族与 pwsh）。填进去的每个名字都是一句显式声明："我允许配置面用它起进程"。',
        '    放行口只放开"命令名"这一格——逐启动器禁内联执行（python -c / node -e / pwsh -Command /',
        '    cmd /c / docker --network host …）与 args/env 控制字符照旧生效。',
        '  · 与 servers 一样**改完不必重启**（声明面热更会连它一起重新校验）；写坏了这一格',
        '    与写坏 servers 一样：那份配置过不了解析 ⇒ **保留旧配置继续跑**，并如实报错。',
        'maxInFlight（整池同时在飞的 MCP 请求上限，出厂 8）：',
        '  · 语义是硬的：超限**如实拒绝**（回执说"同时在飞的调用已达上限 N 件：这次调用没有发出去"），',
        '    **不是排队**——排队会引出"唯一在跑的那件在等一件排队的启动"这种死锁面；',
        '  · 它与逐 server 的 maxInFlight（出厂 4）分工不同：这一格管**整池总量**（别同时拉起 N 个',
        '    别人的进程，每个 ≈ 一整套 runtime 基线），那一格管**别把同一个 server 打爆**；',
        '  · 什么时候往上调：**声明的 server 很多、而且同时有好几件在跑**（子代理并发起来之后是典型场景）',
        '    ——今天 mcp 与 task 都是 exclusive（一次最多一件 MCP 调用在跑），所以出厂值只是兜底、不是瓶颈。',
        'rssSample（是否采那个 server 的 RSS，出厂 true）：',
        '  · true = 每次成功启动后**异步**采一次（进 mcp/server-resource 事件，GET /api/mcp 折出',
        '    "谁在吃内存 / 冷启动多慢 / 回收救回多少"）；**采不到写 unavailable，不是 0**；',
        '  · **口径是"整棵进程树"**（2026-10-10 第二版）：启动器 + 真 server + conhost 那些子/孙进程',
        '    全都算进去。第一版只量根进程，实测低报到危险的程度——`uvx mcp-server-time` 根进程 6.0 MB',
        '    而整棵树 124.7 MB（≈21×）、`uv tool install` 的 shim 6.1 vs 74.9（≈12×）（docs/multi-mcp-memory.md §5.4）；',
        '    事件里那条 rssSource 会说清是哪一种口径：`cim-tree`/`ps-tree` = 整棵树，',
        '    `tasklist`/`proc`/`ps` = 整棵树读不到时的降级（**只量到根进程**），`unavailable` = 没采到。',
        '  · 代价是实的：Windows 上采一次要起一个 PowerShell 读数进程求整棵树（**本机实测中位数 ≈0.95 s**；',
        '    降级那条只量根进程的 tasklist 是 ≈0.51 s），每个 server 启动时付一次、异步落、',
        '    不阻塞握手也不进任何一次调用的等待；',
        '  · 设 false = 不采，那几格**如实留空**；环境变量 IRMIA_MCP_RSS_SAMPLE（0/false/off/no 关、',
        '    1/true/on/yes 开）**比这一格优先**，命令行临时开关用它。',
        '资源观测（2026-10-10 加，第二版同日加了"整棵树"）：每个 server 的**启动耗时 / RSS / 在飞峰值 /',
        '  最近一次回收时间**走 internal 事件（mcp/server-started · mcp/server-resource · mcp/server-stopped）',
        '  落库，界面从 GET /api/mcp 读那几格——想彻底关掉这笔开销就设 rssSample:false',
        '  （或环境变量 IRMIA_MCP_RSS_SAMPLE=0）。',
        '⚠️ 未显式声明三属性的 MCP 工具一律按 **destructive** 算（"server 说自己是只读的"不算数，',
        '  那是崩溃恢复时最不该采信的一句话）⇒ 要调它们得先开 tools.destructiveEnabled；',
        '  真要放行只读的那些，就在这个 server 的 tools 里逐件写 sideEffect:"none"。',
        '**调用走内置的 mcp 工具**（2026-10-09 定的口径）：她的工具清单里不出现 mcp__server__tool，',
        '  三格路由按"填了哪几格"分：**不带 server** 看有哪些 server、**带 server** 看它有哪些工具、',
        '  **server + tool** 就是调用（一次一件）。它**没有 action 参数**——这三条路本来就能从描述里读出来，',
        '  而多一个常驻字段要多花二十几个 token（这一段曾经写成 action=list / action=call，那是个不存在的字段，2026-10-09 改准）。',
        '  好处：一个 server 有几十件工具时，常驻开销是**一件**，清单只在她真要用的那一刻披露。',
        '**改完不必重启**（2026-10-10 起）：这一段是**声明面热更**的那一格——config.json 一改，',
        '  进程当场按新声明重建 MCP 声明面（只重连真变了的那几个 server），并给你发一条通报',
        '  （`wake/manual` · via=mcp）。**唯一**要重启的是另外两格池级参数',
        '  （maxInFlight / rssSample 是建池时的参数，不在热更名单里）。',
        '  出厂留空数组 = 不接任何 MCP server。',
      ],
      servers: mcpServersToJson(d.mcp.servers),
      // 三个全局格照写（`$comment` 里已经把它们讲清楚；值缺席时读盘那一侧按出厂值兜）
      maxInFlight: d.mcp.maxInFlight,
      rssSample: d.mcp.rssSample,
      // 放行口（2026-10-10 加）：出厂空数组。**必须写出这一格**——它是使用者最需要看见的
      // "还有一个地方能放行"的落点；只在注释里说、不给键，等于让人以为得去设环境变量。
      extraLaunchers: [...d.mcp.extraLaunchers],
    },
    deps: {
      $comment: [
        '外部依赖（pwsh 7 / ripgrep / es.exe）的用户指定路径——探测顺序的第一段（用户指定 > 框架自装目录 <dataDir>/tools/<name> > PATH）。',
        '不写就走后两段；写了一个不可用的路径**不会**静默退回 PATH，而是如实报"你指的那个用不了"——"我配了却不生效"是最难查的一类故障。',
        'pwsh 要求主版本 >= 7（powershell.exe 5.1 不算满足，它只是工具的回退项）。rg 与 es 是 rg_search / es_search 的引擎，没装就不注册这两件工具。',
        'rg 与 es 可以在 GUI 设置页「外部依赖」一键安装（下载官方包解压到 <dataDir>/tools/<name>/）；pwsh 7 需要人工安装（winget install Microsoft.PowerShell）。',
      ],
      // 只写出显式指定过的路径：`undefined` 在 JSON 里会被丢掉，写进去反而让模板文件出现空值
      paths: {
        ...(d.deps.paths.pwsh === undefined ? {} : { pwsh: d.deps.paths.pwsh }),
        ...(d.deps.paths.rg === undefined ? {} : { rg: d.deps.paths.rg }),
        ...(d.deps.paths.es === undefined ? {} : { es: d.deps.paths.es }),
      },
    },
    channels: {
      $comment: [
        'IM 通道（M9）：QQ 官方 Bot API 与 OneBot 11（NapCat 等协议端）。enabled=false 时完全不起适配器。',
        'mentionKeywords：**她被怎么称呼**（关键词匹配）。群里的人常不打 @ 直接喊名字，'
          + '正文里出现这几个词就当作"在叫她"，与 @ 走同一条唤醒路径。空数组 = 只认平台的 @。',
        '  这是关键词匹配，不做语义判断：填宽了会误唤醒、填窄了会漏——分寸由人定，界面上可改。',
        '密钥不落配置文件：只写环境变量名（appIdEnv / clientSecretEnv / tokenEnv），值放进程环境里。',
        'QQ：两者齐备且 enabled=true 时才建连；apiBase/tokenUrl/gatewayUrl 不写用官方默认地址。',
        'QQ：AppID/ClientSecret 的值写在 data/.keys.json（界面填）或环境变量里，环境变量优先；'
          + 'groupBatchMinutes 是群消息攒批窗口（单聊不受它影响，每句都及时看）。',
          'useMarkdown：发文本时用原生 markdown（msg_type=2），默认开——她发的报告才能在 QQ 里真正渲染。',
          '  官方口径：content 与 markdown 互斥；拿不到 markdown 权限的机器人会被服务端拒绝，',
          '  这里会自动降级为纯文本重发（只多花一个失败请求，不丢话）。机器人确实没权限时可关掉。',
        'OneBot：连 wsUrl（协议端正向 ws 端口）；tokenEnv 对应的环境变量为空时按“协议端未开校验”匿名连接。',
        'OneBot：managed 段写了就由框架拉起内置协议端（目前只认 snowluma），并且**接管 wsUrl 与 token**——',
        '  两者从协议端自己的 config/onebot.json 里读，不需要两边各填一遍。dir 是它的安装目录（绝对路径，或相对 dataDir）。',
        '  为什么框架不打包它：SnowLuma 是“源码可见非商业许可”，自用可以、随框架分发不行——所以只在这里指向你自己装的目录。',
        '  不写 managed = 用外部的协议端，行为与以前完全一样；autoStart: false 则只登记不自动拉起（界面可手动启停）。',
      ],
      mentionKeywords: [...d.channels.mentionKeywords],
      qqOfficial: {
        enabled: d.channels.qqOfficial.enabled,
        appIdEnv: d.channels.qqOfficial.appIdEnv,
        useMarkdown: d.channels.qqOfficial.useMarkdown,
        clientSecretEnv: d.channels.qqOfficial.clientSecretEnv,
      },
      onebot: {
        enabled: d.channels.onebot.enabled,
        wsUrl: d.channels.onebot.wsUrl,
        tokenEnv: d.channels.onebot.tokenEnv,
        // managed 只在写了的时候带上：它一出现就意味着"框架接管启动"，
        // 归一化时凭空补一个默认值，会把"用外部协议端"悄悄变成"框架接管"
        ...(d.channels.onebot.managed === undefined ? {} : { managed: d.channels.onebot.managed }),
      },
    },
    alerts: {
      $comment: [
        '通用 webhook 出口：POST JSON { level, title, body, ts, fingerprint }；不配 webhookUrl 即只落日志。',
        'rateLimitMin：同类告警限流窗口（分钟）。',
      ],
      rateLimitMin: d.alerts.rateLimitMin,
    },
    contextAudit: {
      $comment: [
        '上下文审计：每个 model call 记一条上下文构成（token，不含任何计价），并在缓存前缀真失守时记一条。',
        'cacheBreakIdleMin：空闲多久之后检查"命中率塌陷"（分钟）。',
        'cacheBreakHitDrop：命中率相对跌幅门槛（0–1），跌掉这么多才算塌陷。',
      ],
      cacheBreakIdleMin: d.contextAudit.cacheBreakIdleMin,
      cacheBreakHitDrop: d.contextAudit.cacheBreakHitDrop,
    },
    timezone: d.timezone,
  };
}

// ──────────────────────────────── 字段校验 ────────────────────────────────

function describeValue(value: JsonValue | undefined): string {
  if (value === undefined) return '缺失';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function objectOr(raw: JsonValue | undefined, where: string): JsonObject {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new ConfigError(`${where} 必须是对象，收到 ${describeValue(raw)}`, where);
  return raw;
}

function pickString(raw: JsonValue | undefined, where: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(`${where} 必须是字符串，收到 ${describeValue(raw)}`, where);
  return raw;
}

function pickNonEmptyString(raw: JsonValue | undefined, where: string, fallback: string): string {
  const text = pickString(raw, where, fallback);
  if (text.trim() === '') throw new ConfigError(`${where} 不能为空字符串`, where);
  return text;
}

function pickNumber(raw: JsonValue | undefined, where: string, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ConfigError(`${where} 必须是有限数字，收到 ${describeValue(raw)}`, where);
  }
  return raw;
}

function pickInt(
  raw: JsonValue | undefined,
  where: string,
  fallback: number,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number {
  const n = pickNumber(raw, where, fallback);
  if (!Number.isInteger(n)) throw new ConfigError(`${where} 必须是整数，收到 ${describeValue(raw)}`, where);
  if (n < min || n > max) {
    throw new ConfigError(`${where} 必须在 ${min}..${max} 之间，收到 ${n}`, where);
  }
  return n;
}

/**
 * cron 表达式（五段：分 时 日 月 周）。空串是合法取值（"显式关闭这个周期任务"），
 * 形状校验只做能在这里判定的部分（段数与字符集）；「永不触发」这类语义判定交给
 * wake/timer-store.ts 的 parseCron（那里才有月份天数与星期的完整语义）。
 */
function pickCron(raw: JsonValue | undefined, where: string, fallback: string): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') throw new ConfigError(`${where} 必须是字符串，收到 ${describeValue(raw)}`, where);
  const text = raw.trim();
  if (text === '') return '';
  const fields = text.split(/\s+/);
  if (fields.length !== 5) {
    throw new ConfigError(`${where} 需要 5 段（分 时 日 月 周），收到 ${fields.length} 段：${text}`, where);
  }
  for (const field of fields) {
    if (!/^[0-9*/,\-]+$/.test(field)) {
      throw new ConfigError(`${where} 的段只允许数字与 * / , - 组合，收到：${field}`, where);
    }
  }
  return text;
}

/** 软阈值比例：必须落在 (0, 1]——写成 8 而不是 0.8 是真实会发生的错误，在这里抓住 */
function pickRatio(raw: JsonValue | undefined, where: string, fallback: number): number {
  const n = pickNumber(raw, where, fallback);
  if (n <= 0 || n > 1) {
    throw new ConfigError(`${where} 是比例，必须落在 (0, 1] 之间（例如 0.8 表示 80%），收到 ${n}`, where);
  }
  return n;
}

function pickBaseUrl(raw: JsonValue | undefined, where: string, fallback: string): string {
  const url = pickNonEmptyString(raw, where, fallback);
  if (!/^https?:\/\//iu.test(url)) {
    throw new ConfigError(
      `${where} 必须以 http:// 或 https:// 开头（收到 ${JSON.stringify(url)}）：这是不含 /responses 后缀的 API 根地址`,
      where,
    );
  }
  return url;
}

/** apiKeyEnv 只接受环境变量名形状——把 `sk-...` 密钥值填进来会当场报错（密钥教义的自检） */
function pickEnvName(raw: JsonValue | undefined, where: string, fallback: string): string {
  const name = pickNonEmptyString(raw, where, fallback);
  if (!ENV_NAME_RE.test(name)) {
    throw new ConfigError(
      `${where} 必须是环境变量名而不是密钥值（收到 ${JSON.stringify(name)}）：密钥不落配置文件，` +
        `这里写 "IRMIA_API_KEY" 这类名字，值放到进程环境里`,
      where,
    );
  }
  return name;
}

/**
 * 信任范围：只认 `'full'` 与 `'workspace'` 两个字面量，**拼错即报错**。
 *
 * 为什么不宽容（比如把 `'Full'` / `'true'` 归一化过去）：这是一条**边界**，它决定
 * "她能不能碰整台电脑"。一个拼错的边界值如果被静默当成某一档，那多半会被当成**更宽**的那档
 * （`'Full'` → 猜成 full），而人以为自己设的是什么完全说不准——"我配了却不生效"里
 * 最难查、后果最重的一类。两档都写得出、写错就停，是这里唯一说得通的分寸。
 *
 * 缺字段 → 默认 `'full'`（与 buildDefaults 同源，见 TrustConfig 里"为什么默认完全信任"）。
 */
function pickTrustMode(raw: JsonValue | undefined, where: string, fallback: TrustMode): TrustMode {
  if (raw === undefined || raw === null) return fallback;
  if (raw === 'full' || raw === 'workspace') return raw;
  throw new ConfigError(
    `${where} 只能是 "full"（完全信任：能读写整台电脑、能在任意目录跑命令）`
      + ` 或 "workspace"（只限工作目录），收到 ${describeValue(raw)}`,
    where,
  );
}

function pickTimezone(raw: JsonValue | undefined, where: string, fallback: string): string {
  const tz = pickNonEmptyString(raw, where, fallback);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ConfigError(
      `${where} 不是合法的 IANA 时区名（收到 ${JSON.stringify(tz)}），例如 "Asia/Shanghai" 或 "UTC"`,
      where,
    );
  }
  return tz;
}

function pickHttpUrlOptional(raw: JsonValue | undefined, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const url = pickNonEmptyString(raw, where, '');
  if (!/^https?:\/\//iu.test(url)) {
    throw new ConfigError(`${where} 必须以 http:// 或 https:// 开头（收到 ${JSON.stringify(url)}）`, where);
  }
  return url;
}

function parseLane(raw: JsonValue | undefined, where: string, base: ModelLaneConfig): ModelLaneConfig {
  if (raw === undefined || raw === null) return { ...base };
  if (!isPlainObject(raw)) throw new ConfigError(`${where} 必须是对象，收到 ${describeValue(raw)}`, where);
  return {
    model: pickNonEmptyString(raw['model'], `${where}.model`, base.model),
    baseUrl: pickBaseUrl(raw['baseUrl'], `${where}.baseUrl`, base.baseUrl),
    apiKeyEnv: pickEnvName(raw['apiKeyEnv'], `${where}.apiKeyEnv`, base.apiKeyEnv),
  };
}

function pickBoolean(raw: JsonValue | undefined, where: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new ConfigError(`${where} 只能是 true / false，收到 ${describeValue(raw)}`, where);
  }
  return raw;
}

/** 工具名名单：逐项非空字符串、去重、保序（与 pickPathList 的去重口径一致，但不做路径解析） */
function pickToolNameList(raw: JsonValue | undefined, where: string, fallback: readonly string[]): string[] {
  if (raw === undefined || raw === null) return [...fallback];
  if (!Array.isArray(raw)) throw new ConfigError(`${where} 必须是字符串数组，收到 ${describeValue(raw)}`, where);
  const seen = new Set<string>();
  const out: string[] = [];
  raw.forEach((item, index) => {
    const itemWhere = `${where}[${index}]`;
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ConfigError(`${itemWhere} 必须是非空字符串工具名，收到 ${describeValue(item)}`, itemWhere);
    }
    const name = item.trim();
    if (seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out;
}

function parseDestructive(
  raw: JsonValue | undefined,
  where: string,
  base: boolean | string[],
): boolean | string[] {
  if (raw === undefined || raw === null) return Array.isArray(base) ? [...base] : base;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      const itemWhere = `${where}[${index}]`;
      if (typeof item !== 'string' || item.trim() === '') {
        throw new ConfigError(`${itemWhere} 必须是非空字符串工具名，收到 ${describeValue(item)}`, itemWhere);
      }
      return item;
    });
  }
  throw new ConfigError(`${where} 只能是 false / true / 工具名数组，收到 ${describeValue(raw)}`, where);
}

/** OneBot 的 wsUrl：只接受 ws:// 与 wss://（它是协议端的正向 WebSocket 端口） */
function pickOneBotWsUrl(raw: JsonValue | undefined, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const url = pickNonEmptyString(raw, where, '');
  if (!/^wss?:\/\//iu.test(url)) {
    throw new ConfigError(
      `${where} 必须以 ws:// 或 wss:// 开头（收到 ${JSON.stringify(url)}）：这里是协议端的正向 WebSocket 端口`,
      where,
    );
  }
  return url;
}

/**
 * `channels.onebot.managed`（可选：由框架拉起的协议端）。
 *
 * 为什么 `dir` 缺失/为空要**报错**而不是回退默认：这一段一出现就意味着"框架接管它的启动"，
 * 而"接管"必须有个目录——凭空补一个默认值只会让框架去拉起一个不存在的路径，
 * 表现是 not-installed，人却以为自己配好了。同理 `kind` 只认 snowluma：写别的名字说明
 * 写这段话的人期待了另一套启动方式，静默降级成 snowluma 是最坏的一种"体贴"。
 *
 * `autoStart` 刻意**只在写了的时候才带上**（undefined = 默认 true，判定在 main.ts）：
 * 补一个显式 true 进配置对象，会让"我没写过它"与"我写了 true"在 `GET /api/config`
 * 与 configHash 里再也分不出来。
 */
function parseOneBotManaged(raw: JsonValue | undefined): ChannelsConfig['onebot']['managed'] {
  if (raw === undefined || raw === null) return undefined;
  const where = 'channels.onebot.managed';
  const obj = objectOr(raw, where);
  const kindRaw = obj['kind'];
  const kind = kindRaw === undefined || kindRaw === null ? 'snowluma' : kindRaw;
  if (kind !== 'snowluma') {
    throw new ConfigError(
      `${where}.kind 目前只认 "snowluma"，收到 ${describeValue(kindRaw)}`,
      `${where}.kind`,
    );
  }
  const dirRaw = obj['dir'];
  if (typeof dirRaw !== 'string' || dirRaw.trim() === '') {
    throw new ConfigError(
      `${where}.dir 必须是非空字符串（协议端安装目录），收到 ${describeValue(dirRaw)}：`
        + '这一段一写就代表框架要拉起它，没有目录就无从拉起',
      `${where}.dir`,
    );
  }
  // 目录**不在这里解析成绝对路径**：与 `deps.paths` 不同，它有"相对 dataDir"的语义
  // （见类型注释），而解析基准是运行期的 dataDir——配置解析期只有 dir（配置文件所在目录），
  // 两者不是一回事。归一化交给写入侧与 main.ts 的 resolveServiceDir。
  const managed: NonNullable<ChannelsConfig['onebot']['managed']> = { kind, dir: dirRaw.trim() };
  const autoStart = obj['autoStart'];
  if (autoStart !== undefined && autoStart !== null) {
    managed.autoStart = pickBoolean(autoStart, `${where}.autoStart`, true);
  }
  return managed;
}

function parseOneBotChannel(raw: JsonValue | undefined, base: ChannelsConfig['onebot']): ChannelsConfig['onebot'] {
  const obj = objectOr(raw, 'channels.onebot');
  const managed = parseOneBotManaged(obj['managed']);
  return {
    enabled: pickBoolean(obj['enabled'], 'channels.onebot.enabled', base.enabled),
    wsUrl: pickOneBotWsUrl(obj['wsUrl'], 'channels.onebot.wsUrl') ?? base.wsUrl,
    tokenEnv: pickEnvName(obj['tokenEnv'], 'channels.onebot.tokenEnv', base.tokenEnv),
    ...(managed === undefined ? {} : { managed }),
  };
}

function parseQqOfficialChannel(raw: JsonValue | undefined, base: ChannelsConfig['qqOfficial']): ChannelsConfig['qqOfficial'] {
  const obj = objectOr(raw, 'channels.qqOfficial');
  const out: ChannelsConfig['qqOfficial'] = {
    enabled: pickBoolean(obj['enabled'], 'channels.qqOfficial.enabled', base.enabled),
    appIdEnv: pickEnvName(obj['appIdEnv'], 'channels.qqOfficial.appIdEnv', base.appIdEnv),
    useMarkdown: pickBoolean(obj['useMarkdown'], 'channels.qqOfficial.useMarkdown', base.useMarkdown),
    clientSecretEnv: pickEnvName(obj['clientSecretEnv'], 'channels.qqOfficial.clientSecretEnv', base.clientSecretEnv),
    // 0 合法（= 不攒批，每条都唤醒），所以下限是 0；上限 1440（一天）——再大就不是「攒一会儿」了
    groupBatchMinutes: pickInt(obj['groupBatchMinutes'], 'channels.qqOfficial.groupBatchMinutes', base.groupBatchMinutes, 0, 1440),
  };
  const apiBase = pickHttpUrlOptional(obj['apiBase'], 'channels.qqOfficial.apiBase');
  if (apiBase !== undefined) out.apiBase = apiBase;
  const tokenUrl = pickHttpUrlOptional(obj['tokenUrl'], 'channels.qqOfficial.tokenUrl');
  if (tokenUrl !== undefined) out.tokenUrl = tokenUrl;
  const gatewayUrl = pickGatewayUrlOptional(obj['gatewayUrl'], 'channels.qqOfficial.gatewayUrl');
  if (gatewayUrl !== undefined) out.gatewayUrl = gatewayUrl;
  return out;
}

/**
 * 网关地址：只接受 ws:// 与 wss://。接受明文 `ws://` 是刻意的（本地调试要连假网关/反向代理），
 * 但本字段只在配置里能写——协议默认值永远是官方的 wss 地址。
 */
function pickGatewayUrlOptional(raw: JsonValue | undefined, where: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const url = pickNonEmptyString(raw, where, '');
  if (!/^wss?:\/\//iu.test(url)) {
    throw new ConfigError(
      `${where} 必须以 ws:// 或 wss:// 开头（收到 ${JSON.stringify(url)}）：网关是 WebSocket 端点，不是 http 地址`,
      where,
    );
  }
  return url;
}

/**
 * 心跳目标均值的**交叉校验**：必须严格落在安静下限与上限之间（floor < target < ceil）。
 *
 * 为什么这是一个**配置错**而不是"夹到区间里"：这个字段的含义是"平均多久醒一次"，
 * 而安静不足 floor 分钟的那一段概率恒为 0——说"我要平均每 3 分钟醒一次，但 5 分钟内绝不触发"
 * 是自相矛盾的，静默地把它夹成 6 分钟会让使用者以为自己调过了一个调不动的旋钮。
 * 消息里必须**同时给出两个边界的值**（floor 与 ceil），否则拿到报错的人还得回去翻配置才知道
 * 该改成什么；顺手把"能填的范围"与"另一条出路（改 floor/ceil）"也说出来。
 *
 * ⚠️ 报出来的"能填的范围"是**两条约束的交**：除了 floor < 目标 < ceil，本字段自身还限定
 * 5~60（见 `HEARTBEAT_TARGET_MEAN_MIN/MAX`）。只报 `floor+1 ~ ceil−1` 会给出一个填进去仍然报错的
 * 范围（例如 floor=20、ceil=90 时那个范围是 21~89，而 61 以上根本过不了外层校验）；
 * 两条约束凑不出任何值时（floor ≥ 60 或 ceil ≤ 5）得如实说"先改 floor / ceil"。
 *
 * 两条边界之外还有一条**退化区间**：ceil ≤ floor（上限写反了，解析器已按"上限 = 下限"夹过）。
 * 那种配置里分布只剩"到点必响"一个点，α 无意义，**不做这条校验**——既有夹取语义一个字不改
 * （见上面 heartbeatCeilMin 的解析：`静默更久才是坏方向`）。
 *
 * `explicit`：使用者在配置里写过这个字段没有。没写过时报错要说明"这是代码默认值"——
 * 否则消息会像是他自己填错了一个他从没碰过的数（例如只把 floor 调到 20 的那种配置）。
 */
function checkHeartbeatTargetMean(wake: WakeConfig, explicit: boolean): void {
  const floor = wake.heartbeatFloorMin;
  const ceil = wake.heartbeatCeilMin;
  const target = wake.heartbeatTargetMeanMin;
  if (!(ceil > floor)) return; // 退化区间：没有中间地带，也就没有"目标均值"可谈
  if (target > floor && target < ceil) return;
  // 两条约束的交：floor < 目标 < ceil **且** 5 ≤ 目标 ≤ 60
  const low = Math.max(floor + 1, HEARTBEAT_TARGET_MEAN_MIN);
  const high = Math.min(ceil - 1, HEARTBEAT_TARGET_MEAN_MAX);
  const range = low <= high
    ? `能填的是 ${low}~${high} 之间的整数分钟（floor < 目标 < ceil，且本字段限定 ${HEARTBEAT_TARGET_MEAN_MIN}~${HEARTBEAT_TARGET_MEAN_MAX}）`
    : `当前 floor / ceil 下**没有任何合法取值**（floor < 目标 < ceil 与"本字段限定 ${HEARTBEAT_TARGET_MEAN_MIN}~${HEARTBEAT_TARGET_MEAN_MAX} 分钟"两条凑不到一起）`;
  const origin = explicit ? '' : `（这个 ${target} 是**代码默认值**，你没在配置里写过 heartbeatTargetMeanMin）`;
  throw new ConfigError(
    `wake.heartbeatTargetMeanMin（心跳目标均值：平均多久醒一次，分钟）= ${target} 必须**严格**落在`
    + `安静下限与上限之间，收到 floor = ${floor}、ceil = ${ceil}${origin}；${range}。两条出路：`
    + `① 把 wake.heartbeatTargetMeanMin 改成上面那个范围里的整数；`
    + `② 或者把 wake.heartbeatFloorMin（现在 ${floor}）调小 / wake.heartbeatCeilMin（现在 ${ceil}）调大。`,
    'wake.heartbeatTargetMeanMin',
  );
}

/**
 * 全量解析：把（已剔注释、已迁移的）文档逐字段合并到默认值上。
 * 缺字段 → 默认值；类型错 → ConfigError。所有相对路径以 `dir` 为基准解析为绝对路径。
 */
function parseAppConfig(doc: JsonObject, dir: string): AppConfig {
  const base = buildDefaults(dir);

  // 下限 0：未版本化的历史配置是「版本 0」，交给迁移链处理，不在这里当成非法值
  const schemaVersion = pickInt(doc['schemaVersion'], 'schemaVersion', base.schemaVersion, 0);
  const dataDir = resolve(dir, pickNonEmptyString(doc['dataDir'], 'dataDir', base.dataDir));
  const timezone = pickTimezone(doc['timezone'], 'timezone', base.timezone);

  const modelsRaw = objectOr(doc['models'], 'models');
  const models: ModelsConfig = {
    heavy: parseLane(modelsRaw['heavy'], 'models.heavy', base.models.heavy),
    light: parseLane(modelsRaw['light'], 'models.light', base.models.light),
  };
  const degradedRaw = modelsRaw['degraded'];
  if (degradedRaw !== undefined && degradedRaw !== null) {
    // 降级链缺省继承 heavy 的连接契约，只覆盖用户写了的字段
    models.degraded = parseLane(degradedRaw, 'models.degraded', models.heavy);
  }

  const budgetRaw = objectOr(doc['budget'], 'budget');
  const budget: BudgetConfig = {
    stepTools: pickInt(budgetRaw['stepTools'], 'budget.stepTools', base.budget.stepTools, 1),
    turnSteps: pickInt(budgetRaw['turnSteps'], 'budget.turnSteps', base.budget.turnSteps, 1),
    taskTokens: pickInt(budgetRaw['taskTokens'], 'budget.taskTokens', base.budget.taskTokens, 1),
    dailyTokens: pickInt(budgetRaw['dailyTokens'], 'budget.dailyTokens', base.budget.dailyTokens, 1),
    softRatio: pickRatio(budgetRaw['softRatio'], 'budget.softRatio', base.budget.softRatio),
    failStreakMax: pickInt(budgetRaw['failStreakMax'], 'budget.failStreakMax', base.budget.failStreakMax, 1),
  };

  const wakeRaw = objectOr(doc['wake'], 'wake');
  const wake: WakeConfig = {
    heartbeatFloorMin: pickInt(
      wakeRaw['heartbeatFloorMin'], 'wake.heartbeatFloorMin', base.wake.heartbeatFloorMin, 1,
    ),
    heartbeatCeilMin: 1,
    heartbeatTickMin: pickInt(
      wakeRaw['heartbeatTickMin'], 'wake.heartbeatTickMin', base.wake.heartbeatTickMin, 1,
    ),
    heartbeatTargetMeanMin: 1,
    memoryMaintainCron: pickCron(
      wakeRaw['memoryMaintainCron'],
      'wake.memoryMaintainCron',
      base.wake.memoryMaintainCron,
    ),
  };
  // 上限低于下限是配置写反了：以下限为准（心跳更快不危险，静默更久才危险）
  wake.heartbeatCeilMin = Math.max(
    wake.heartbeatFloorMin,
    pickInt(wakeRaw['heartbeatCeilMin'], 'wake.heartbeatCeilMin', base.wake.heartbeatCeilMin, 1),
  );
  // 抽签节奏不许超过下限：超过就不是"每分钟抽一次"，而是"下限被推后"，那会改掉分布的支撑下界
  wake.heartbeatTickMin = Math.min(wake.heartbeatTickMin, wake.heartbeatFloorMin);
  // 目标均值：外层先卡一个合理范围（5~60 分钟），"必须落在 (floor, ceil) 里"那条交叉校验在下面
  wake.heartbeatTargetMeanMin = pickInt(
    wakeRaw['heartbeatTargetMeanMin'],
    'wake.heartbeatTargetMeanMin',
    base.wake.heartbeatTargetMeanMin,
    HEARTBEAT_TARGET_MEAN_MIN,
    HEARTBEAT_TARGET_MEAN_MAX,
  );
  checkHeartbeatTargetMean(wake, wakeRaw['heartbeatTargetMeanMin'] !== undefined);

  const visionRaw = objectOr(doc['vision'], 'vision');
  const vision: VisionConfig = {
    imagesToContext: pickBoolean(
      visionRaw['imagesToContext'],
      'vision.imagesToContext',
      base.vision.imagesToContext,
    ),
    // 0 是合法值（= 图片一张都不进上下文），所以下限取 0
    maxContextImages: pickInt(
      visionRaw['maxContextImages'],
      'vision.maxContextImages',
      base.vision.maxContextImages,
      0,
    ),
  };

  const speakRaw = objectOr(doc['speak'], 'speak');
  const speak: SpeakConfig = {
    typingEffect: pickBoolean(speakRaw['typingEffect'], 'speak.typingEffect', base.speak.typingEffect),
    // 打字速度：低于 30 字/分等于每字两秒，一段十几个字就要半分钟——那不是"慢"，是卡住
    charsPerMinute: pickInt(
      speakRaw['charsPerMinute'],
      'speak.charsPerMinute',
      base.speak.charsPerMinute,
      30,
    ),
    inputNotify: pickBoolean(speakRaw['inputNotify'], 'speak.inputNotify', base.speak.inputNotify),
  };

  const personaRaw = objectOr(doc['persona'], 'persona');
  const persona: PersonaConfig = {
    compactionThresholdTokens: pickInt(
      personaRaw['compactionThresholdTokens'],
      'persona.compactionThresholdTokens',
      base.persona.compactionThresholdTokens,
      1,
    ),
    handoffBudgetTokens: pickInt(
      personaRaw['handoffBudgetTokens'],
      'persona.handoffBudgetTokens',
      base.persona.handoffBudgetTokens,
      1,
    ),
    handoffFoldTokens: pickInt(
      personaRaw['handoffFoldTokens'],
      'persona.handoffFoldTokens',
      base.persona.handoffFoldTokens,
      1,
    ),
    owner: pickString(personaRaw['owner'], 'persona.owner', base.persona.owner).trim(),
    // 只收 true / false（`pickBoolean` 的纪律）：写成 "false" 或 0 在这里当场报错，
    // 而不是让"关掉的记忆系统"变成一句没人看见的注释——它是这一层的总开关，含糊不起
    memoryEnabled: pickBoolean(
      personaRaw['memoryEnabled'],
      'persona.memoryEnabled',
      base.persona.memoryEnabled,
    ),
    // 下限 1 KB（比"当前任务 + 接着干"还小的预算必然每轮都在叫，那是噪音不是提醒）、
    // 上限 64 KB（= write_persona 的单文件硬上限 PERSONA_HARD_LIMIT_BYTES：比它还大的预算
    // 永远越不过，写进去只会让人以为自己设了这条线）。单位是字节，理由见字段注释与那条常量
    stateBudgetBytes: pickInt(
      personaRaw['stateBudgetBytes'],
      'persona.stateBudgetBytes',
      base.persona.stateBudgetBytes,
      1024,
      64 * 1024,
    ),
    contacts: readContacts(personaRaw['contacts'], 'persona.contacts'),
  };

  const toolsRaw = objectOr(doc['tools'], 'tools');
  const tools: ToolsConfig = {
    destructiveEnabled: parseDestructive(toolsRaw['destructiveEnabled'], 'tools.destructiveEnabled', base.tools.destructiveEnabled),
    groupSceneHardRefusal: pickBoolean(
      toolsRaw['groupSceneHardRefusal'],
      'tools.groupSceneHardRefusal',
      base.tools.groupSceneHardRefusal,
    ),
    planMode: pickBoolean(toolsRaw['planMode'], 'tools.planMode', base.tools.planMode),
    // 上限 1440 分钟（一天）：比它更大的"等待线"已经失去意义——人一天没露面的可能性比
    // "他还在看这张卡"大得多，那时该发生的是她换个方式找人，而不是把这条线拉长
    askHumanTimeoutMin: pickInt(
      toolsRaw['askHumanTimeoutMin'], 'tools.askHumanTimeoutMin', base.tools.askHumanTimeoutMin, 1, 1440,
    ),
    // 只收非空字符串；去重后保持首次出现顺序（界面开关写入的顺序即名单顺序）
    disabled: pickToolNameList(toolsRaw['disabled'], 'tools.disabled', base.tools.disabled),
    // 隔离子代理（design §4.21）。只收 true / false（`pickBoolean` 的纪律）：它是"要不要
    // 多一件常驻工具"的开关，写成 "false" 或 0 在这里当场报错，而不是让它静默取默认值
    taskEnabled: pickBoolean(toolsRaw['taskEnabled'], 'tools.taskEnabled', base.tools.taskEnabled),
  };

  const depsRaw = objectOr(doc['deps'], 'deps');
  const depsPathsRaw = objectOr(depsRaw['paths'], 'deps.paths');
  const deps: DepsConfig = { paths: {} };
  // 三个键各自独立：只写了 rg 的人不该因为没写 pwsh 而报错（缺字段 = 不干预）
  for (const name of ['pwsh', 'rg', 'es'] as const) {
    const raw = depsPathsRaw[name];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new ConfigError(`deps.paths.${name} 必须是字符串路径，收到 ${describeValue(raw)}`, `deps.paths.${name}`);
    }
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    // 相对路径以配置文件所在目录为基准解析成绝对路径（与 dataDir/paths 同一口径）
    deps.paths[name] = resolve(dir, trimmed);
  }

  const alertsRaw = objectOr(doc['alerts'], 'alerts');
  const alerts: AlertsConfig = {
    rateLimitMin: pickInt(alertsRaw['rateLimitMin'], 'alerts.rateLimitMin', base.alerts.rateLimitMin, 0),
  };
  const webhookUrl = pickHttpUrlOptional(alertsRaw['webhookUrl'], 'alerts.webhookUrl');
  if (webhookUrl !== undefined) alerts.webhookUrl = webhookUrl;

  const channelsRaw = objectOr(doc['channels'], 'channels');
  const channels: ChannelsConfig = {
    mentionKeywords: parseMentionKeywords(channelsRaw['mentionKeywords']),
    qqOfficial: parseQqOfficialChannel(channelsRaw['qqOfficial'], base.channels.qqOfficial),
    onebot: parseOneBotChannel(channelsRaw['onebot'], base.channels.onebot),
  };

  const webRaw = objectOr(doc['web'], 'web');
  // 只读认识的键。老配置里可能还留着 `appMode`（那个网页观测台时代的开关），
  // **安静忽略**：为一个已经删掉的功能让整台实例起不来，是拿人的时间给历史陪葬。
  const web: WebConfig = {
    host: pickString(webRaw['host'], 'web.host', base.web.host) ?? '127.0.0.1',
    port: pickInt(webRaw['port'], 'web.port', base.web.port, 1, 65535) ?? 7788,
  };

  // 上下文审计：只影响"要不要记一条哨兵事件"，与运行行为无关，所以两个阈值都夹在合法区间里
  const auditRaw = objectOr(doc['contextAudit'], 'contextAudit');
  const contextAudit: ContextAuditConfig = {
    // 下限 1 分钟：0 会让"每次调用都算空闲过期"，那不是哨兵是刷屏
    cacheBreakIdleMin: pickInt(
      auditRaw['cacheBreakIdleMin'], 'contextAudit.cacheBreakIdleMin', base.contextAudit.cacheBreakIdleMin, 1,
    ),
    // 0 会让"命中率不涨就算塌陷"，1 则要求跌到 0——两端都没有意义
    cacheBreakHitDrop: pickRatio(
      auditRaw['cacheBreakHitDrop'], 'contextAudit.cacheBreakHitDrop', base.contextAudit.cacheBreakHitDrop,
    ),
  };

  // 信任范围（她的活动边界）。`mode` **只认两个字面量**（见 pickTrustMode：拼错即停，
  // 因为这是一条边界，"我配了却不生效"比"当场报错"难查得多）；`workspaceRoot` 缺省继承
  // 默认值（`<配置目录>/workspace`），运行期**不给人手填**——它是派生量，填错了就会出现
  // "界面说限在工作目录、实际限在别处"这种最难查的错。
  const trustRaw = objectOr(doc['trust'], 'trust');
  const trust: TrustConfig = {
    mode: pickTrustMode(trustRaw['mode'], 'trust.mode', base.trust.mode),
    workspaceRoot: pickNonEmptyString(
      trustRaw['workspaceRoot'], 'trust.workspaceRoot', base.trust.workspaceRoot,
    ),
  };

  // MCP 声明面（2026-10-09）：走 mcp/client.ts 的唯一一套校验（见 readMcpConfig）。
  // 缺 mcp 段 = 合法的"没声明任何 server"，不是错误。
  const mcp: McpConfig = readMcpConfig(doc['mcp']);
  return {
    schemaVersion, dataDir, models, budget, wake, vision, speak, persona, tools, mcp, deps, channels,
    alerts, contextAudit, web, timezone, trust,
  };
}

// ──────────────────────────────── 版本迁移 ────────────────────────────────

/**
 * 迁移钩子：每个钩子负责「targetVersion-1 → targetVersion」这一步，恰好触发一次
 * （operations.md §3 的 upgrade hooks 链）。钩子只改派生配置文档，绝不回头改历史事件。
 */
export interface ConfigUpgradeHook {
  /** 该钩子的目标版本，例如 2 表示"把 1 升到 2" */
  readonly targetVersion: number;
  /** 纯函数：接收旧文档返回新文档；返回 null 表示拒绝迁移（缺信息，需人工介入） */
  readonly upgrade: (doc: JsonObject) => JsonObject | null;
}

/** 内置迁移链：M6 完整迁移链在此登记；M2 只有版本比较与执行器，链为空 */
export const upgradeHooks: readonly ConfigUpgradeHook[] = [];

/** 钩子执行结果：迁移后的文档 + 实际触发过的目标版本序列 */
export interface UpgradeResult {
  doc: JsonObject;
  applied: number[];
}

/**
 * 从 `fromVersion` 按序执行到 `toVersion`。任何一个版本缺钩子就报错——
 * 跳步迁移会让字段语义断层，宁可让人来修。
 */
export function applyUpgradeChain(
  doc: JsonObject,
  fromVersion: number,
  toVersion: number,
  hooks: readonly ConfigUpgradeHook[] = upgradeHooks,
): UpgradeResult {
  let current = doc;
  const applied: number[] = [];
  for (let version = fromVersion + 1; version <= toVersion; version += 1) {
    const hook = hooks.find((candidate) => candidate.targetVersion === version);
    if (hook === undefined) {
      throw new ConfigError(
        `配置版本 ${fromVersion} 升到 ${toVersion} 需要目标版本为 ${version} 的迁移钩子，当前代码里没有登记`,
        'schemaVersion',
      );
    }
    const next = hook.upgrade(current);
    if (next === null) {
      throw new ConfigError(`迁移钩子 v${version} 拒绝迁移这份配置，需要人工处理`, 'schemaVersion');
    }
    // 归一化版本号：钩子漏写 schemaVersion 也不会让后续比较失真
    current = { ...next, schemaVersion: version };
    applied.push(version);
  }
  return { doc: current, applied };
}

// ──────────────────────────────── 规范化与指纹 ────────────────────────────────

/** 规范化：递归排序键、剔除 undefined 成员（等价于 JSON 序列化语义） */
function canonicalize(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: JsonObject = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = canonicalize(item);
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * 规范化 JSON：键序无关的确定性字节串。
 * 同一份配置在任何机器、任何键序下都得到同一串——这是 configHash 能当指纹的前提。
 */
export function canonicalConfigJson(config: unknown): string {
  return JSON.stringify(canonicalize(config));
}

/**
 * 配置指纹：sha256(规范化 JSON) 的完整 hex。
 * 与 renderVersion、personaHash 并列构成 render 的三输入指纹（operations.md §1）：
 * 同一 seq 区间 + 同一三指纹 ⟹ 同一请求体。展示时取前 8 位即可。
 */
export function configHash(config: AppConfig): string {
  return createHash('sha256').update(canonicalConfigJson(config), 'utf8').digest('hex');
}

// ──────────────────────────────── 密钥读取 ────────────────────────────────

/**
 * **唯一**读取密钥值的入口：只在真正发起调用时调用，值不落在配置对象里、
 * 不落在事件日志里（operations.md §1：日志里的密钥引用一律是掩码）。
 * 未配置返回 null，由调用方决定是报错、降级还是提示用户去配。
 *
 * 取值链交给 keys.ts 的 `resolveKey`（环境变量优先 > `data/.keys.json`），
 * 两个参数各说一件事：`lane.apiKeyEnv` 是**环境变量名**（配置里写的名字），
 * `name` 是**受管键名**（没有环境变量时去 `.keys.json` 里读哪一个）。
 * 不传 `dataDir` / `name` 时行为与只看环境变量的历史版本逐字一致，
 * 所以既有调用点与测试的语义没动过。
 */
export function readApiKey(
  lane: Pick<ModelLaneConfig, 'apiKeyEnv'>,
  env: Record<string, string | undefined> = process.env,
  dataDir: string | null = null,
  name: KeyName | null = null,
): string | null {
  return resolveKey(dataDir, name, { env, envName: lane.apiKeyEnv });
}

// ──────────────────────────────── 加载 ────────────────────────────────

export interface LoadConfigOptions {
  /** 迁移钩子链覆盖点（测试与 M6 演进用）；默认取内置 upgradeHooks */
  hooks?: readonly ConfigUpgradeHook[];
}

export interface LoadedConfig {
  /** 生效配置（默认值已合并、路径已解析为绝对路径） */
  config: AppConfig;
  /** 配置文件绝对路径（dir/config.json） */
  path: string;
  /** 本次是否新建了默认配置文件（true 表示目录里原本没有它） */
  createdDefault: boolean;
  /** 本次实际触发过的迁移目标版本；空数组表示未迁移 */
  appliedUpgradeTargets: number[];
  /** configHash(config) 的现成结果 */
  configHash: string;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** 原子写：同目录 tmp → fsync → rename 覆盖（schema §11 的统一写盘规则） */
let tmpSeq = 0;
async function writeFileAtomic(path: string, text: string): Promise<void> {
  // pid + 序号：同进程并发写各自有独立 tmp，最后 rename 的都是完整内容
  const tmp = `${path}.tmp.${process.pid}.${tmpSeq++}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * 加载配置。
 *
 * `dir` 是配置所在目录（config.json 的父目录），也是相对路径字段的解析基准。
 * 文件缺失时生成带注释的默认配置并写回；文件存在时只读不改写。
 */
export async function loadConfig(dir: string, options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const dirAbs = resolve(dir);
  const path = join(dirAbs, CONFIG_FILE_NAME);

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await mkdir(dirAbs, { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(defaultDocument(dirAbs), null, 2)}\n`);
    const config = defaultConfig(dirAbs);
    return {
      config,
      path,
      createdDefault: true,
      appliedUpgradeTargets: [],
      configHash: configHash(config),
    };
  }

  const raw = parseJsonDocument(text, path);
  // raw 已知是对象，剔注释后仍是对象
  const stripped = stripComments(raw) as JsonObject;
  const fromVersion = pickInt(stripped['schemaVersion'], 'schemaVersion', CONFIG_VERSION, 0);

  let doc = stripped;
  let applied: number[] = [];

  if (fromVersion > CONFIG_VERSION) {
    throw new ConfigError(
      `配置版本 ${fromVersion} 高于本程序支持的 ${CONFIG_VERSION}（${path}）：` +
        '这份配置来自更新的代码，用旧程序读它会静默丢字段，请先升级程序',
      path,
    );
  }

  if (fromVersion < CONFIG_VERSION) {
    // 迁移前备份原文件（对齐 milestones.md M6-2：迁移必须可回退）
    const backup = `${path}.bak.v${fromVersion}`;
    await copyFile(path, backup);
    const result = applyUpgradeChain(stripped, fromVersion, CONFIG_VERSION, options.hooks ?? upgradeHooks);
    doc = result.doc;
    applied = result.applied;
  }

  const config = parseAppConfig(doc, dirAbs);
  return { config, path, createdDefault: false, appliedUpgradeTargets: applied, configHash: configHash(config) };
}
