/**
 * Irmia Agent — 管理工具包（docs/design.md §4.10 / §4.11 / §4.20 / §4.21 / §6）
 *
 * 八件工具（v35 起 `set_timer` / `cancel_timer` / `list_timers` 三件并成一件 `timer`）：
 * write_persona / timer / speak / report / todo / read_channel / send_media / ask_human。
 * 它们的共同点是"改变 Agent 自身、对外发声、问人、或看外面发来的东西"，
 * 而不是读写文件——所以全部走注入的出口（事件写入口、定时器、告警、回投、日志读取），
 * 本模块不直接碰 EventLog，也不自己分配 seq。
 *
 * v27 删掉了两件，都是**参数级审计**（415 次真实调用）之后按实测取舍的：
 *   • `notify` 与 `speak` 重复——speak 的第二路本来就是
 *     `notifier.send({ level, title: 'Irmia 发言', body })`，多一个工具只是多一份
 *     schema 与一次"该用哪个"的犹豫；
 *   • `ask_human` 在无人值守里几乎总是浪费：它挂起一个 turn 等答复（默认 24h），
 *     而她自己的结论是"你常不在，我宁可写文件等你"。**事件留着**
 *     （`human/asked` / `human/answered`）：plan 模式与挂起重入机制依赖它们，
 *     删掉的只是"工具"这一层调用链（提问改由她写进文件/state）。
 *
 * **design §6.5 把 `ask_human` 恢复了，改的是语义而不是机制**：旧实现错在"等"，不在"问"。
 * 现在它写完 `human/asked{source:'agent'}` 就返回，turn 照常往下走（挂起判定只认系统来源），
 * 人的答复在下一拍以 `human/answered` 出现，没人答则落一条「未批准、未拒绝」的 `human/expired`。
 * 问她"要不要换个方式找人"是她的判断，框架不替她降级成"那就算了"。
 *
 * 三条设计纪律：
 *   1. persona/ 只有 write_persona 一个写通道，且 IDENTITY/CONSTITUTION 对 agent 只读、
 *      STYLE 只收提案（proposals/，由人批准生效）
 *      （design.md §4.11：能改写自己核心身份的人格，一次幻觉就会变成别人）。
 *   2. 拒绝必须给模型明确的下一步（design.md §4.10），所以每条拒绝消息都说清了
 *      "为什么"与"改走哪条路"。
 *   3. `emit` 记日志、语义回调触发副作用（刷新人格缓存、更新注入层），两者是不同职责，
 *      不是一个东西的两个名字——宿主刷新 personaHash 靠的是回调，不是解析事件。
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

import type { StoredTimerEntry, TimerSetInput, TimerStore } from '../wake/timer-store.js';
import type { ChannelMessage, Visibility, WakeChannel } from '../log/types.js';
import { contextImageSkipText, defaultVisibility, isImageAttachment, type ContextImageSkipReason } from '../log/types.ts';
// 默认等待线只此一份（config.ts）：回执里说的时长必须与 real-loop 落 human/expired 的判定线同源
import { DEFAULT_ASK_HUMAN_TIMEOUT_MIN } from '../config/config.ts';
// 回投地址的 scheme 与解析口都属于通道层（`qq:<chatType>:<chatId>`、`onebot:<chatType>:<chatId>`），
// 不在这里另造一套：多通道并存时按 wake.channel 选各自命名空间
import { QQ_CHANNEL_NAME, parseReplyUrl as parseQqReplyUrl, replyUrlOf as qqReplyUrlOf } from '../channel/qq-official.ts';
import {
  ONEBOT_CHANNEL_NAME, ONEBOT_REPLY_SCHEME, isOneBotFamilyChannel,
  parseReplyUrl as parseOneBotReplyUrl, replyUrlOf as oneBotReplyUrlOf,
} from '../channel/onebot.ts';
import { CHAT_TYPE_LABELS, channelForNamespace, normalizeSid, parseSid, sessionLabelOf, type SessionEntry } from '../channel/sessions.ts';
// 群里动静（notice）的形状与**逐字行文**都只有一处实现（`noticeLineText`）：这里只负责
// "给它一个查得到名字的口"，不另写一份渲染（两处各写一遍迟早给出两种说法）
import { noticeLineText, type ChannelNoticeView, type NoticeNamer } from '../channel/self-identity.ts';
// 「我做过」那一行的**逐字**也只有一处实现（`selfActionLineText`）；这里只给它一个查群名的口
import { selfActionLineText, type ChannelSelfActionView, type SelfActionNamer } from '../channel/self-action.ts';
import { renderExternalEvent } from '../model/render.ts';
import { normalizePersonaAsset } from '../persona/loader.ts';
// 待办的载体只有一处：`STATE.md` 的两节。解析 / 渲染 / 最小替换都在那个模块里（不在这里另写一份）
import { TODO_SECTIONS, planTodoWrite } from '../persona/todo-state.ts';
import { charCount, splitForChat } from './chat-split.ts';
// 局部替换复用 safe_edit 的编辑内核（匹配 / 消歧 / 行号前缀防呆）：两处各写一套，
// "找不到怎么办、多匹配怎么办"迟早给出两种答案——那种不一致只有她撞上时才会被发现。
import { planEdit } from './fs/edit-core.ts';
// ⚠ 这里**不引** `fs/path-guard.ts` 的 `isInside`：本文件已有一份同语义的本地实现
// （`comparably` + 前缀比较，服务 persona 路径），引第二份只会换来一个重名冲突。
import { expandAliases } from './fs/path-guard.ts';
import { pathAliasesFor } from './fs/env.ts';
import { toErrorMessage } from './fs/types.ts';
import { boundaryDecision, boundaryRootFor, outsideBoundaryReason } from './boundary.ts';
// 「内核真正会访问的那个路径」只有一处实现（`util/real-path.ts`）：persona 边界判定、
// 版本库的工作区映射都用同一把尺子——两处各写一份 realpath 展开，迟早一个展开一个不展开。
import { expandRealPath } from '../util/real-path.ts';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from './types.js';
import {
  TOOL_ERROR_CODES,
  ToolArgumentError,
  argsRecord,
  errorResult,
  errorResultFromThrown,
  okResult,
  optionalString,
  requiredString,
} from './types.ts';

// ──────────────────────────────── 常量 ────────────────────────────────

/** persona 资产只认 Markdown：全部人类可读、可 diff、可人工接管（design.md §4.11） */
export const PERSONA_FILE_SUFFIX = '.md';

/** agent 对这两个文件只读；改名或换路径都绕不过（按顶层资产名判定，大小写不敏感） */
export const PERSONA_PROTECTED_FILES: readonly string[] = ['IDENTITY.MD', 'CONSTITUTION.MD'];

/**
 * 只读直写、但收提案的文件：表达风格由人拍板（写 proposals/STYLE.md 提建议，人批准才生效）。
 *
 * 为什么它不能像 STATE 那样直写：STYLE 进上下文的**最前面**（instructions，最大公共前缀），
 * 它每变一次，下一轮整个请求都要重新落盘一次。而语气这件事不是每三分钟就该变的东西。
 */
export const PERSONA_PROPOSAL_ONLY_FILES: readonly string[] = ['STYLE.MD'];

/** 提案目录名（与 web/server.ts 的 PERSONA_PROPOSAL_DIR 同字面量） */
export const PERSONA_PROPOSAL_DIR = 'proposals';

/**
 * 按需层（STATE / RELATIONSHIPS）单文件软上限：**超了只警告，不拒绝**。
 *
 * 2026-10-17 用户批：**4096 → 2048**，与 `persona.stateBudgetBytes` 的现网口径同一根线
 * （2 KB = 2048 字节）——`write_persona` 的回执与此刻层那行 `预算提醒：` 从此说的是同一个数，
 * 不会再出现"STATE 提醒说 2 KB、写回执说 4 KB"这种两份口径。
 * 判据是**严格大于**（`bytes > onDemandWarnBytes`）：正好 2048 不警告，2049 才警告——
 * 与 `stateBudgetReminder` 的 `stateBytes > budgetBytes` 同一条。
 *
 * 它只改**警告线**，不改工具行为：写不写、写到哪、拒什么（保护文件 / 硬上限 / 后缀）
 * 一个字都没动；回执里的数字由这个常量生成，所以回执不会说谎。
 *
 * ⚠ **`tools` 段那一句也跟着改了（v69）**：`write_persona` 的 `description` 里原来写的是
 * 「按需层超 4KB 警告」，本批一并改成「按需层超 2KB 警告」（等长、`catalogTokens` 不变，
 * 但**字节变了** ⇒ 冻结前缀的字节变 ⇒ 同批递 `RENDER_VERSION` 68 → 69，见 render.ts 文件头）。
 */
export const ONDEMAND_WARN_BYTES = 2048;

/**
 * 单文件硬上限。软上限只提醒，没有硬顶就等于没有上限——按需层每轮都要注入，
 * 一个写坏的 STATE.md 会永久吃掉上下文预算（design.md §4.12）。
 */
export const PERSONA_HARD_LIMIT_BYTES = 64 * 1024;

/** 任务内计划清单上限。清单进投影、进状态层注入，无上限等于给模型一个自杀开关 */
export const MAX_TODO_ITEMS = 50;

/**
 * `ask_human` 两个字段的上限：问题是"一句话问一件事"，context 是给她补背景的。
 *
 * 与人看到的卡片直接相关——超长的问题会把卡撑满（gui-design §9.3 卡片高度贴合内容），
 * 而卡片要留一个输入框给答复。超了直接拒（说清收到了多少字），不做静默截断：
 * 截断过的问题照样弹出去，人读到的就不是她问的那句了。
 */
const ASK_QUESTION_MAX = 500;
const ASK_CONTEXT_MAX = 2000;

/**
 * 未接配置时 `ask_human` 回执里报的超时（与 config.ts 的 `DEFAULT_ASK_HUMAN_TIMEOUT_MIN` 同源，
 * 直接读那个常量而不是再抄一个数：两个值一旦漂移，回执说的时长就与 `human/expired` 的判定线对不上，
 * 而那种不一致只有在她等到第二个时间点时才会被发现）。
 */
const DEFAULT_ASK_HUMAN_TIMEOUT_MS = DEFAULT_ASK_HUMAN_TIMEOUT_MIN * 60_000;

/** 把超时毫秒说成一句人话（回执里给她一个能据此安排下一步的时长） */
function waitBudgetText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60
    ? `${minutes} 分钟内一直没人答复`
    : `约 ${Math.max(1, Math.round(minutes / 60))} 小时内一直没人答复`;
}

export const TODO_STATUSES: readonly TodoItem['status'][] = ['pending', 'in_progress', 'completed'];

const TODO_SINGLE_CONTENT_MAX = 500;
/**
 * 待办清单的载体（`STATE.md`，相对 `personaRoot`）。
 *
 * 为什么把它写成常量而不是散在 handler 里：`todo` 与任务卡读取侧**必须指同一个文件**——
 * 一边写 `STATE.md`、另一边读别的名字，症状是"她记了、但看板永远空着"，而且不报错。
 */
const TODO_CARRIER_FILE = 'STATE.md';
/**
 * speak 的说话风格目标：**描述里那句「N 字内」的唯一来源**（描述由它拼出来，不许在描述里手写一个数）。
 *
 * **25 是用户定的说话风格目标，不是从日志里测出来的分位数。** 他要的是短句、
 * 像打字聊天：一次说一件事、最多两个逗号（描述里那三句就是他的口径）。
 *
 * 所以别拿 `data/events/*.jsonl` 的实测分布来"纠正"这个数。这一处被纠过两次，
 * 两次都是同一个错——把"她多数时候写得更长"当成"这个数不合理"，于是擅自放宽。
 * 实测分布对**提醒该多密**有用（提醒太密会变成每轮重发的噪声），对**目标该定多少**
 * 没有发言权：目标的价值就在于它比现状短，超了说明她该往回收，而不是说明目标该改。
 *
 * 那 469 次调用的 p50=31 / p90=66（口径见 `_research/tools-audit-usage.mjs`）
 * 只解释了一件事：提醒**不能**按"越过目标就发"来判，否则 69% 的调用都在被追一句。
 * 实测走的是 `SPEAK_TEXT_REMIND_MAX`，它与这个数**脱钩**（2026-10-05 用户定：两条线都是 25），
 * 所以要调提醒的密度就单独调那一个常量，别动这个数。
 */
export const SPEAK_TEXT_SUGGESTED_MAX = 25;
/**
 * 提醒线：越过它就追一句，把话头引回上面的说话风格目标。
 *
 * **这条线的作用是纠偏，不是"打脸"**：它是一句提醒，不是一次判错登记。
 * 回执里那句话的用处是让她知道"这么长已经不像我平时说话了"，好把话收短；
 * 说成"你超出了上限"是在数落她，说成"你做不到"更是错的——目标定了就是让她往那儿走。
 *
 * 与建议线**脱钩**（两条线现在都取 25，但不是一个概念，见 SPEAK_TEXT_SUGGESTED_MAX）：
 * 建议线是"往哪儿说"，提醒线是"多长才值得追一句"。分开的唯一理由是**提醒的密度**：
 * 实测 469 次调用里越过 150 字的只有 8 次（1.7%），而按"越过目标就提醒"是 324 次（69%）
 * ——那段话跟着工具结果留在历史里（之后每轮重发），还是每次都在打断她。
 * 用户 2026-10-05 把两条线一起定回 25：他宁愿每次超 25 都被提醒一句，也不要她在长话上失去纠偏。
 *
 * ① **节奏预算**（提醒之外另一条真实边界）：默认 90 字/分 × 一趟总预算 90s ⇒ 约 135 字之后
 *    剩下的段不再等（见 SPEAK_TOTAL_BUDGET_MS）——过了那条线，"像人打字"这个节奏已经做不到了；
 * ② **语域边界**：`report` 实测最短一次 135 字（docs/tools-audit.md §2.6）——再长本来就该走 report。
 */
export const SPEAK_TEXT_REMIND_MAX = 25;
/**
 * speak 的**硬门**：超过它**直接拒绝**（`errorResult`）——不截断、不"提醒之后照发"。
 *
 * 用户 2026-10-05 的原话：「超多少字不截断取消。而是超过 40 字直接拒绝。返回要求重新组织语言，
 * 或是多次调用，或是 report」。所以这一条与上面两条**性质不同**：
 *
 *   • **25**（`SPEAK_TEXT_SUGGESTED_MAX`）= **目标**——她该往哪儿说（越短越好，像打字聊天）；
 *   • **40（本常量）= 硬门**——过了就退回，一个字不发（`text` 那条路根本走不到）；
 *   • **提醒线**（`SPEAK_TEXT_REMIND_MAX`）= **纠偏的密度**——多久追她一句（不阻止发送）。
 *   • **分段**（`chat-split.ts`）= **40 以内的投递形态**——切成几条、按打字节奏一条条发。
 *
 * 三层的分工可以一句话说完：**25 是目标，40 是门，分段是门里的走路方式**。40 以内照旧分段
 * （那是"像人打字"的语义，没有"超过多少就不分段"这回事了——那条 45 字的口径已被用户取消）。
 *
 * **为什么 40 是"拒绝"而不是"截断"**：截断过的话照样发出去，人读到的就不是她想说的那句了
 * （回执与日志还会记着一段被砍过的文本）——那是替她说了半句。拒绝则把决定权还给她：
 * 重说、拆几次、还是改用 `report`，由她判断。拒绝文案必须给出这三条路（她照着就能改）。
 *
 * 判据用 `charCount`（中文计字口径：emoji / 增补平面字符算一个字），与分段、`maxLength`
 * 同一把尺子——用 `text.length` 会把 emoji 数成两个，同一句话带不带表情会落在门的两侧。
 * **边界是精确的**：正好 40 字通过，41 字起拒绝（测试 `test/admin-pwsh.test.ts` 钉住两侧）。
 *
 * `SPEAK_TEXT_HARD_MAX` 仍在、仍是 `requiredString` 的 `maxLength`：那是"别把整篇报告塞进来"
 * 的兜底（schema 层），400 > 40，所以真正会先拦下来的是这一条。
 */
export const SPEAK_TEXT_MAX = 40;
/** 硬上限：只是防它把整篇报告塞进来；稍微超过不拒，只在结果里提醒（那条提醒见 SPEAK_TEXT_REMIND_MAX） */
const SPEAK_TEXT_HARD_MAX = 400;
/** report 的上限：正式内容允许长，与 speak 差三个量级 */
const REPORT_TEXT_MAX = 64000;

/**
 * 逐段发送的节奏：每段之前等「**这一段**要打多久」，第一段也等。
 *
 * 速度由 `config.speak.charsPerMinute` 给（默认 90 字/分钟），所以一条十字的话要隔六七秒、
 * 二十字要隔十三秒——这就是“人一条条打出来”的真实节奏，也是他想要的限流：
 * 她一次只能慢慢说这么多。**第一段同样要等**：她按下的不是"发送"，是"开始打字"。
 *
 * 三个数字一起看：单段封顶 10 秒（不为超长的一条没完没了地等）；一趟总预算 90 秒
 * （超出就把剩下的直接发完，不让工具被自己的节奏拖死），工具超时 120 秒兜底。
 * `speak.typingEffect=false` 时全部立即发出（等待为 0）。测试里 sleep 可注入，不拖慢用例。
 */
const SPEAK_MAX_DELAY_MS = 10_000;
const SPEAK_TOTAL_BUDGET_MS = 90_000;

/** 打断检查的粒度：等待被切成小片，每片看一眼"他是不是又说话了" */
const SPEAK_INTERRUPT_POLL_MS = 100;

/** 发言节奏的缺省值（与 config.ts 的 SpeakConfig 默认一致；未接配置的调用方走这条） */
const DEFAULT_SPEAK_TYPING = { typingEffect: true, charsPerMinute: 90 } as const;

/**
 * 投递失败之后还能不能再试——把平台错误码翻译成一句她能用的判断。
 *
 * 只给判断，不给建议：她要说什么、要不要改道都是她自己的事（用户明确不要提示，
 * 也不要口语）。这里唯一的作用是把她**看不到**的那层信息补上——平台错误码背后的性质。
 *
 * 判据是**错误的性质**：权限类再试多少次都一样；网络类隔一会儿可能就好；剩下的一律按
 * "不必重试"处理（不确定时重试的期望收益低，代价是又一圈工具调用）。
 */
function deliveryAdvice(reason: string, sent: number): string {
  const already = sent > 0 ? `已发出的 ${sent} 条收不回来。` : '';
  if (/40034105|无权限|主动消息/.test(reason)) {
    // 说清是**往这里发**的权限问题，不是"你被禁言了"——否则她会怀疑自己整条发言能力，
    // 而不是只怀疑这条路。用户在群里那轮之后特意点了这一条。
    return `${already}向该会话发送消息时存在权限问题，不必重试。`;
  }
  if (/超时|timeout|ECONN|ETIMEDOUT|socket|network/i.test(reason)) {
    return `${already}疑似网络或对端问题，可稍后再试。`;
  }
  return `${already}原因不明，不必重试。`;
}

/**
 * 可被打断的等待：返回 true = 等满了，false = 等待期间人又开口了。
 *
 * `probe` 是「开口计数」的读取器与**本次发言**的基准值：计数变了就是被打断。
 * 基准每次发言重新取——所以"被打断之后重新组织语言再说一次"能正常说完，
 * 这正是早先用 AbortSignal 时踩的坑（一次打断会把这轮剩下的每次发言都判成被打断）。
 * 没有 probe 时一次睡完（测试与单机调用就是这种情形，逐片睡会平白放大调用开销）。
 */
async function sleepUnlessInterrupted(
  ms: number,
  probe: { epoch: () => number; start: number } | null,
): Promise<boolean> {
  if (probe === null) {
    await sleepFn(ms);
    return true;
  }
  if (probe.epoch() !== probe.start) return false;
  let waited = 0;
  while (waited < ms) {
    const slice = Math.min(SPEAK_INTERRUPT_POLL_MS, ms - waited);
    await sleepFn(slice);
    waited += slice;
    if (probe.epoch() !== probe.start) return false;
  }
  return true;
}


/**
 * 被打断时那段「没来得及发的」怎么摆给她——**多条就编号、`／` 连排**。
 *
 * 为什么逐条编号（用户 2026-10-01 的原设计 + 2026-10-03 的补充）：
 *   • 原设计要的是「哪些内容**因为插话没发出去**」——只说"被取消"或静默丢掉，
 *     她就只能猜自己说到哪儿了，而"重新组织语言"必须建立在"我上一句停在哪"之上；
 *   • 一次 speak 展开成九条气泡、只出去三条是常态（实测那次 9 条）。给一段连着排的文本，
 *     她读不出"第 4 条起没出去"；逐条编号是**能一眼看出**这件事的最省字数的写法。
 *
 * 为什么仍然只用一行、而且不重复已发的内容：这条回执要进她的上下文，而"已经发出去的"
 * 上面那行已经逐字给过了——这里再抄一遍就是同一段话在上下文里出现两次，白花钱还容易让她
 * 把已发的那半截当成没发的重讲一遍（那正是"替她改主意"的一种）。
 *
 * 长度：整段文本本来就有硬上限（`SPEAK_TEXT_HARD_MAX` 400 字），所以这一行最多四百字出头
 * ——比一条群消息还短，不需要额外的截断规则。
 */
function numberedUnreleased(segments: readonly string[]): string {
  if (segments.length === 0) return '（无）';
  // 只有一条时不编号：那是被截断的半句话，加个「1.」既不帮读、又显得像在递清单
  if (segments.length === 1) return segments[0]!;
  return segments.map((text, index) => `${index + 1}. ${text}`).join('／');
}

/** 可注入的 sleep（测试里换成不等待） */
let sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 测试用：把等待换成立即返回，不拖慢用例 */
export function setSleepForTest(fn: ((ms: number) => Promise<void>) | null): void {
  sleepFn = fn ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
}

// 这里原本还有一个「拆分随机源」注入点，给"逗号按概率切"那套用。用户把口径改成
// **逗号全摘全分段**之后，切分不再有随机成分——同一段话每次切出来都一样，
// 于是那个注入点连同 chat-split 里的概率参数一起删掉了。测试不再需要注入随机数。

// ──────────────────────────────── 出口接口（全部注入） ────────────────────────────────

/**
 * 事件写入口：宿主负责分配 seq 并落盘。工具只声明"发生了什么"。
 *
 * `visibility` 省略时由调用方给默认值，显式给出时以它为准。只有确实需要改变渲染行为的
 * 写入点才显式给：`human/asked` 必须是 model——否则模型下一轮看不到自己提过的问题，
 * 也就看不到人的答复（render 按可见性过滤，铁律：visibility 单向承诺）。
 */
export type AdminEventEmitter = (type: string, data: unknown, visibility?: Visibility) => void;

export interface PersonaUpdatedPayload {
  /** 相对 personaRoot 的路径，统一用 `/` 分隔，跨平台一致 */
  file: string;
  /** 新内容的 sha256（hex），用于检测人格漂移 */
  diffHash: string;
  by: 'agent' | 'human';
}

export interface SpeakSentPayload {
  channel: SpeakChannel;
  chars: number;
  /** 投递到了哪个会话（`log` 路不带：那是本机对话流，没有会话 id） */
  sid?: string;
  /**
   * 这次发言的**完整文本**与它被切成了几条气泡（只有"真发进了某个会话"的那条回执带它）。
   *
   * 见 `log/types.ts` 的 `SpeakSent.text`：`read_channel` 要靠它把"她在这个会话里说过什么"
   * 读回来——切分是投递的属性，逐段的 `message/assistant` 里没有会话坐标。
   */
  text?: string;
  spokenParts?: number;
  /**
   * 这是**哪一次工具调用**发的（`tool/call.callId`）：`read_channel` 按它把"一次 speak"归成一行。
   *
   * 为什么不是按 turn 归：同一个 turn 里她可以连着说两段（第一段发完又补一句），那在事件上
   * 与"一段被切成两条气泡"长得一样——按 turn 并会把两段并成一行，而按 `callId` 两段各自一行。
   */
  callId?: string;
  /** 产生这次发言的 turn 号 */
  turn?: number;
  /**
   * 这一次投递出去的那条消息**在平台上的 id**（2026-10-12 补）——`read_channel` 的
   * `（我）`那一行靠它把"我说的这一行"与平台上的那条消息对上。
   *
   * 为什么它必须到这一层：`delete_msg` / `get_msg` 只认平台 `message_id`，而在这条路打通
   * 之前，她**删不掉"自己刚发的那条"**——那个 id 在适配器里就被窄化丢掉了。实测凭据：
   * 事件 77386（T1308/S1）她自己写着「我发出去的消息——speak/sent 事件里没有 messageId」。
   *
   * 一次 speak 会被切成 N 条气泡（N 个 id），这一格记的是**这一段的第一条**（不是最后一条）：
   * 一行只放一个 id，而"她开口的第一条"是这一行最自然的锚（要撤这一段，从它撤起）。
   */
  messageId?: string;
}

export type SpeakChannel = 'log' | 'notify' | 'reply-url';

/**
 * 「这一跳真的送到了那个会话」那一条回执的形状 —— **判据只此一处**。
 *
 * 三个产生点（`speak` 的整段/被打断、`report` 的正文出站、`send_media`）都走这个函数，
 * 消费者（`real-loop.ts` 的 `readChannelSpoken`：`read_channel` 的"她自己说过什么"）读
 * `deliveredToSid`。**两边引的是同一个实现**，所以"写凭据的"与"读凭据的"不可能各认一套。
 *
 * 为什么必须收成一处（2026-10-07 修的真缺陷）：原来这条判据在三处各写了一遍——
 *   • 产生侧：`channel: 'reply-url'` 加不加 `text` 全凭手写（`report` 就漏了 `text`）；
 *   • 消费侧：`channel !== 'reply-url' || text === undefined || sid === undefined`；
 *   • 说明文字：`channel='reply-url'` + `sid` + **带 `text`**。
 * `report` 漏掉 `text` 的代价不是"少一个字段"，而是**她 report 过之后读自己说过什么，
 * 那一篇凭空不在**——日志里明明有那条事件，她一查却查不到（详见 `SENT_CREDENTIAL_NOTE`
 * 与 `report` 里那段注释）。形状由函数返回、类型由返回标注钉住（`text` 是**必填**），
 * 漏字段编译期就红。
 *
 * 为什么 `log` / `notify` 两路不在这里：`log` 是本机对话流（永远可用，不代表话到了那个会话）、
 * `notify` 是告警出口（到她自己的手机，不是那个会话）。只有 `reply-url` 是"IM 那一路走通了"。
 */
export function deliverToSession(input: {
  /** 送到了哪个会话（sid，与 `read_channel` 的 `sid`、唤醒派生的回投地址同形同源） */
  sid: string;
  /** 送出去的**完整文本**（切分是投递的属性：多段气泡也只写这一份整段） */
  text: string;
  /** 这段文本在那边被切成了几条气泡（1 = 一次说完） */
  parts?: number;
  /** `speak/sent.chars`：中文计字口径，与既有回执一致 */
  chars?: number;
  /** 哪一次工具调用发的（`read_channel` 按它归并；`tool/call.callId` 同源） */
  callId?: string;
  /** 产生这次投递的 turn 号（复盘用；兜住旧事件没有 callId 的情形） */
  turn?: number;
  /**
   * 这一次投递出去的那条消息的**平台 id**（2026-10-12 补；通道层 `SendOutcome.messageId`）。
   *
   * 可选，理由与 `SpeakSent.messageId` 逐字同源：旧日志没有它、通道也可能给不出
   *（协议端不回 id）——那时这一格缺席，不是缺陷。
   */
  messageId?: string;
}): SpeakSentPayload {
  return {
    channel: 'reply-url',
    chars: input.chars ?? input.text.length,
    sid: input.sid,
    text: input.text,
    spokenParts: input.parts ?? 1,
    ...(input.callId === undefined ? {} : { callId: input.callId }),
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    // 空串与缺席**分开**：通道层已经把"给不出"归一成缺席了（不带这一格），
    // 这里再兜一次，免得一个 `messageId: ''` 落到日志里被读成"这个 id 是空串"。
    ...(input.messageId === undefined || input.messageId === '' ? {} : { messageId: input.messageId }),
  };
}

/**
 * 这一条 `speak/sent` 是不是"**真的送进了某个会话**"的凭据？是就给出那个 sid，不是给 `null`。
 *
 * 这是 `deliverToSession` 的**唯一**消费判据：`read_channel` 的"我自己的发言"那一折
 * （`real-loop.ts` 的 `readChannelSpoken`）只认它。三个条件缺一不可——
 *   • `channel === 'reply-url'`：本机对话流与告警出口那两条不代表话到了那边；
 *   • `text !== undefined`：没有文本就回答不了"她说过什么"（旧日志里只有 `sid` 的那些回执
 *     属于此列，读不回来是"日志只增不改"的必然，不是缺陷）；
 *   • `sid !== undefined`：没有会话坐标就归不到任何一个会话。
 *
 * 收在这里的收益是**可判定**：想让一类投递进她的"我说过什么"视野，就得让它走
 * `deliverToSession`；而写漏了字段时，这里当场返回 `null`（有 `test/read-channel-spoken.test.ts`
 * 的用例逐条钉着），不会变成"日志里有、她读不到"这种静默的半截接线。
 */
export function deliveredToSid(data: SpeakSentPayload | Record<string, unknown>): string | null {
  if (data['channel'] !== 'reply-url') return null;
  const text = data['text'];
  const sid = data['sid'];
  if (typeof text !== 'string' || text === '') return null;
  return typeof sid === 'string' && sid !== '' ? sid : null;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface NotifyMessage {
  level: 'info' | 'warn' | 'critical';
  title: string;
  body: string;
}

/** 送达结果用可判别联合，而不是 boolean + 可选字符串：调用点无法忘记处理失败原因 */
export type NotifyOutcome = { ok: true } | { ok: false; reason: string };

export interface Notifier {
  send(message: NotifyMessage): Promise<NotifyOutcome>;
}

/**
 * 当前会话 → 回投 URL（M9）：按 `wake.channel` 选通道自己的命名空间（`qq:` / `onebot:`）。
 * 通道名认不出来时退回 QQ 口径（既有行为，也是缺省通道）。
 *
 * ⚠️ 判据是 `isOneBotFamilyChannel`（**覆盖别名实例** `onebot-*`），不是
 * `wake.channel === ONEBOT_CHANNEL_NAME`：通道名可以是别名（`OneBotClientOptions.channelName`），
 * 过去那样写会把别名实例当成非 OneBot ⇒ 造出 `qq:` 命名空间的地址 ⇒ **静默回投不出去**。
 * 与 `channel/media-poster.ts`、`channel/sessions.ts`、`channel/warn-exempt.ts` 共用同一处判据。
 */
export function replyUrlForWake(
  wake: Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId'>,
): string {
  if (isOneBotFamilyChannel(wake.channel)) return oneBotReplyUrlOf(wake);
  return qqReplyUrlOf(wake);
}

export type ReplyUrlAnyParse =
  | { ok: true; channel: string; chatType: string; chatId: string }
  | { ok: false; error: string };

/** 解析回投 URL：按 scheme 前缀分派到对应通道的解析口（“写 url”与“读 url”必须同一口径） */
export function parseReplyUrlAny(url: string): ReplyUrlAnyParse {
  if (url.startsWith(ONEBOT_REPLY_SCHEME)) {
    const parsed = parseOneBotReplyUrl(url);
    return parsed.ok
      ? { ok: true, channel: ONEBOT_CHANNEL_NAME, chatType: parsed.chatType, chatId: parsed.chatId }
      : parsed;
  }
  const parsed = parseQqReplyUrl(url);
  return parsed.ok
    ? { ok: true, channel: QQ_CHANNEL_NAME, chatType: parsed.chatType, chatId: parsed.chatId }
    : parsed;
}

/**
 * 从当前 IM 会话派生回投地址（M9）。
 *
 * 两个字段的语义：
 *   • `url` = `qq:<chatType>:<chatId>` 或 `onebot:<chatType>:<chatId>`：chatType 决定走单聊还是群，
 *     chatId 就是 speak 的回投目标；
 *   • `idempotencyKey` = 本 turn 号：同一 turn 内多次 speak 会多回几条（她的发言本就该都发出去），
 *     而不同 turn 之间绝不会被对端当成同一条去重。
 *
 * 只认 c2c / group-at：其余 chatType（未来的 group / guild）本通道尚未实现，宁可不出回投
 * 也不要构造一个发不出去的 URL。
 */
/**
 * 本轮能否把话发回唤醒来源：speak 第三路与装置自述的联络段**共用的唯一判据**。
 *
 * 「她能说出去」与「提示词告诉她能说出去」必须是同一口径——两处各写一份判定，迟早出现
 * 「提示词说能发、实际发不出去」这种让模型做无效动作的情形。
 *
 * 认 c2c / group / group-at 三种：会话身份归一（2026-10-02）之后群聊一律写 `group`，
 * 而"这条 @ 了我"仍带着 `group-at`；两种都要能回投（群发路径是同一条，差别只在带不带 msg_id）。
 * guild（频道）本通道尚未实现，宁可不出回投也不构造一个发不出去的 URL。
 */
export function replyableWakeChannel(
  wake: WakeChannel['data'] | null,
): Pick<WakeChannel['data'], 'channel' | 'chatType' | 'chatId' | 'messageId'> | null {
  if (wake === null) return null;
  if (wake.chatType !== 'c2c' && wake.chatType !== 'group-at' && wake.chatType !== 'group') return null;
  // 自检：URL 与解析口必须是同一口径（route 换了却忘了改解析的代价是"静默回投到错误地址"）
  return parseReplyUrlAny(replyUrlForWake(wake)).ok ? wake : null;
}

function derivedReplyTargetOf(
  current: (() => WakeChannel['data'] | null) | undefined,
): (ctx: ToolContext) => ReplyTarget | null {
  return (ctx) => {
    const wake = replyableWakeChannel(current?.() ?? null);
    if (wake === null) return null;
    return {
      url: replyUrlForWake(wake),
      idempotencyKey: `turn-${ctx.turn}`,
      // 叫醒她的那条消息，就是平台允许她回复的那条：带上它的 id，这条发言才算**被动回复**
      ...(wake.messageId === '' ? {} : { msgId: wake.messageId }),
    };
  };
}

export interface ReplyTarget {
  url: string;
  /** 幂等键 = turn 号（design.md §4.20），重复回投由对端去重 */
  idempotencyKey: string;
  /**
   * 平台消息 id：带上它，这条发言就是**对那条消息的被动回复**——走平台给的回复窗口，
   * 不消耗主动消息配额、也不需要额外权限。不带它就是**主动消息**：要权限、有配额。
   *
   * 这个字段是一次实测事故补上的。她的群聊发言一直失败于
   * `HTTP 400 code=40034105 主动消息失败, 无权限`，而她明明是被 @" 的那条消息叫醒的。
   * 唤醒事件里 `messageId` 一直都有、适配器也早就实现了 `passive = msgId !== ''`，
   * 只有回投链路（就是这个类型）把它丢了——于是每条回复都被平台判成主动消息。
   * 单聊恰好有主动权限，所以这个问题只在群里现形；她还为此连着重试了五次。
   */
  msgId?: string;
}

export type ReplyOutcome =
  | {
    ok: true;
    status: number;
    /**
     * **话发出去了，但形态与她以为的不一样**（原样来自通道层，`SendOutcome.degraded`）。
     *
     * 首例：机器人没有原生 markdown 权限 → 服务端拒了 markdown → 通道按纯文本重发成功。
     * 这条不是失败，但它**必须进回执**：`ok: true` 只说"到了"，而"这一条的形态变了"关系到
     * 「@ 到底亮没亮」。不说，就是留一个"以为发出去了、其实没 @ 到"的静默失败。
     */
    note?: string;
    /**
     * 平台回的**这条消息**的 id（2026-10-12 补；原样来自通道层 `SendOutcome.messageId`）。
     *
     * 为什么必须从通道层一路带到这里：它是"她刚发出去的那一条"的**唯一坐标**，而在这条路
     * 打通之前它被适配器窄化掉了（`onebot.ts` 的 `createOneBotReplyPoster` 只回
     * `{ok,status}`）——于是 `speak/sent` 里没有 id，`read_channel` 的 `（我）`那一行
     * 永远拿不到它，她**删不掉"自己刚发的那条"**（实测 T1308 那一轮，她为此扫了两遍原始
     * jsonl 才凑出 id，而其中一次白扫）。**可选**：通道给不出（协议端没回 id）时就不带它
     * ——与 `SpeakSent.messageId` 同一条先例（"日志只增不改"）。
     */
    messageId?: string;
  }
  | { ok: false; status?: number; reason: string };
export interface ReplyPoster {
  post(target: ReplyTarget, text: string): Promise<ReplyOutcome>;
}

/**
 * **"正在输入"的投递口**（`speak` 开口之前那一次）。
 *
 * 与 `ReplyPoster` 分成两个口子，不是形式主义——它们对失败的**态度不同**：
 *   • `ReplyPoster` 失败 = **话没送到**，回执必须如实说，她据此决定要不要重说；
 *   • 这个口子失败 = **什么都不影响**，话照旧说（用户 2026-10-11 的口径：「失败绝不影响说话」）。
 * 合成一个口子的话，"正在输入发不出去"迟早会被写进那条投递回执里，读起来就像"她这次没说成"。
 *
 * 三态也是为这件事分的（`sent` / `skipped` / `failed`）：工具层不需要报给模型（那不是她的动作），
 * 但**测试与日志要能分清**"没接这条能力"和"接了但没发成"——差一个词，排障方向差很远。
 */
export type InputNotifyPostResult =
  | { status: 'sent'; channel: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export interface InputNotifyPoster {
  notify(target: ReplyTarget): Promise<InputNotifyPostResult>;
}

/**
 * 通道没接这条能力（或它不是个像样的实现）时，兜底返回的那一个。
 *
 * 为什么工具层还要自己兜一层（`speak` 那边已经 try/catch 了）：注入的实现是**外部代码**
 * （测试替身、将来的第二条通道），一个永远不 resolve 的 `notify` 会把 `speak` 卡在开口之前
 * ——那正是"不许因此让 speak 变慢"这条纪律要挡住的事。所以在**开口前**加一道硬预算。
 */
export const INPUT_NOTIFY_HARD_TIMEOUT_MS = 5_000;

/** 官方文件类型：1=图片 2=视频 3=语音 4=文件（与通道层同一套口径） */
export type MediaFileType = 1 | 2 | 3 | 4;

/**
 * 单个媒体的大小上限（200MB，官方对**文件类**的软限制）：一道"别把内存打爆"的粗线。
 *
 * 为什么这个数落在**工具层**（2026-10-18，review P1-09）：v64 起本机文件是工具层读成字节再交给
 * 投递口的（见 {@link MediaRequest.data}），所以"读之前先 `stat` 判一次"只能发生在这里——
 * 读完整份再判，峰值内存已经付出了（几百 MB 的文件在 OneBot 那条路上还要 base64 + JSON +
 * 掩码，峰值 7–8×，可 OOM 整个进程）。投递口那道门照旧（`channel/media-poster.ts`），
 * 两处引**同一个常量**，不许各写一个数。
 */
export const MEDIA_MAX_BYTES = 200 * 1024 * 1024;

/**
 * 要发的一个媒体：`url`（网络地址）与 `path`（本机文件）二选一。
 *
 * `path` 与 `data` **可以同时在场**，而 `path` 有两处用场（2026-10-18 起是两处）：
 *   · OneBot 的**文件**那条要本机路径（`upload_group_file` / `upload_private_file`，见
 *     `channel/onebot.ts` 的 `oneBotMediaCall`）——只递字节时它报"要一个本机路径"；
 *   · 投递口的**凭据门**只认 `path`（`channel/media-poster.ts` 的 `refuseProtected`）⇒
 *     所以四种 kind 都带它（P1-11：只给文件类时默认的 `kind:image` 整条绕过了那道门）。
 */
export interface MediaRequest {
  fileType: MediaFileType;
  path?: string;
  url?: string;
  name?: string;
  /**
   * 本机字节。**两条路都会填它**：
   *   · 宿主自己的调用方读了文件之后填（原样）；
   *   · v64 起 `send_media` 在**需要按信任边界判一次**时也走这条路：`full` 档允许发工作区外的
   *     文件，而投递口那一层只收 `data\`/仓库根之内的路径 ⇒ 由工具层（唯一知道 `trust.mode`
   *     的地方）把政策判完、把字节读出来，投递口只负责发。**接口没变，填法多了一条**。
   */
  data?: Uint8Array;
}

/**
 * 媒体投递口（`send_media` 用）：宿主注入——工具层不碰网络、不读文件字节。
 *
 * 与 `ReplyPoster` 的分工：那个发**文本**，这个发**媒体**（先上传换 `file_info`、再按
 * `msg_type=7` 发，两步都在宿主那边完成）。没接线时如实报"没有接线"，不假装发过。
 */
export interface MediaPoster {
  post(target: ReplyTarget, media: MediaRequest): Promise<ReplyOutcome>;
}

// ──────────────────────────────── 选项 ────────────────────────────────

export interface AdminToolsOptions {
  /** 定时器存储（注入） */
  timers: TimerStore;
  /** 事件写入口（注入），必填：没有它这些动作就不可复盘 */
  emit: AdminEventEmitter;
  /** 人挌资产根目录（data/persona）；省略时取 `<workspaceRoot>/persona` */
  personaRoot?: string;
  /** 告警出口；未注入时 notify/speak 的第二路如实报"未配置"而不是假装成功 */
  notifier?: Notifier;
  /** 当前 turn 的回投地址；返回 null 表示这一轮没有回投通道 */
  replyTargetOf?: (ctx: ToolContext) => ReplyTarget | null;
  /**
   * 当前 turn 的 IM 会话（M9）：有它时 `replyTargetOf` 缺省就从它派生回投地址
   * （`qq:<chatType>:<chatId>`），无 IM 通道时两者都不配，speak 如实报"本轮无回投地址"。
   */
  currentWakeChannel?: () => WakeChannel['data'] | null;
  /**
   * 发言节奏（`config.speak`）：打字效果开关与速度。不配时用默认（开、90 字/分钟）。
   *
   * 节奏是**体感参数**，所以它落在配置里而不是代码里：有人要"像人在打字"，有人只要
   * 内容尽快到手；速度同理。
   */
  speakTyping?: { typingEffect: boolean; charsPerMinute: number };
  /**
   * 「他刚说了什么」：`speak` 被打断时用它把对方的新话写进回执，她才知道该针对什么
   * 重新组织语言。返回 null 表示这次打断不是人开口造成的（回执就不引用具体内容）。
   *
   * 一并给出那条唤醒的 `wakeSeq`：回执引用的是哪一条，销账就得销哪一条
   * （见 `ToolContext.claimInterruption`）。
   */
  userSpoke?: () => { text: string; wakeSeq: number } | null;
  /** 回投实现，默认用全局 fetch */
  replyPoster?: ReplyPoster;
  /**
   * "正在输入"的投递口（**不配 = 一次都不发**）。
   *
   * 装配层的判据只有一条：`config.speak.inputNotify` 为真才装它。于是"关掉开关就一句话都不发"
   * 这件事发生在**接线层**，而不是在 `speak` 里多写一个 if——工具层因此永远不必知道
   * 有这么个开关，也就不会出现"两个地方各判一次、其中一个漏了"。
   */
  inputNotify?: InputNotifyPoster;
  /** persona 写入后的副作用钩子：刷新人格缓存、重算 personaHash */
  onPersonaUpdated?: (payload: PersonaUpdatedPayload) => void;
  /** 清单变更后的副作用钩子：投影/注入层据此刷新 */
  onTodoUpdated?: (items: readonly TodoItem[]) => void;
  /**
   * IM 消息的读取口（`read_channel` 用）：宿主注入，因为工具层不该自己去翻日志。
   *
   * 返回**时间正序**的那个会话的消息（最近 limit 条）。`sid` 是会话标识，
   * 与会话簿/回投地址同形（`qq:c2c:<openid>`）。
   */
  channelReader?: ChannelReader;
  /**
   * **会话簿**（`read_channel` 不给 `sid` 时列的那一份；v66）。
   *
   * 与会话清单（此刻层那一段）同源：宿主手里的 `sessionBook`（`real-loop.sessions()`）。
   * 为什么要有它：此刻层那张清单是**有窗口的**（私聊常驻、群聊只列她 7 天内回过话或 1 小时内
   * 有人 @ 她的），所以清单末尾会写一句「还有 N 个会话没列」——那时她需要一个"看全部"的出口，
   * 而**不给 sid 的 `read_channel` 就是那个出口**（不新增动作名：工具清单的每一个字节都是
   * 冻结前缀的成本，见 `catalog.ts` 那份预算）。
   *
   * 为什么是取值器而不是快照：`catalog` 先于 `RealLoop` 就位，且会话簿逐拍在长
   * （与 `channelReader` 那几个读取口同一条纪律——工具层不读日志，事实由宿主现取）。
   * 没接线 = 不给 sid 时如实说"这一侧没接上会话簿"，绝不编一份空清单出来。
   */
  channelSessions?: () => readonly ChannelSessionRow[];
  /**
   * 她在这个会话里**说过的话**（`read_channel` 用）：宿主注入，同样是"工具层不读日志"。
   *
   * 与会话清单、未读、话题全都无关——它只服务"她读群时知道自己已经回过什么"这一眼。
   * 没接线时 read_channel 照常可用，只是读不到自己的发言（不假装她没说过）。
   */
  channelSpokenReader?: ChannelSpokenReader;
  /**
   * 这个会话里**发生过的事**（`channel/notice`：管理动作/入群退群/撤回……）——`read_channel` 用。
   *
   * 与 `channelReader` / `channelSpokenReader` 同一条纪律：宿主注入，工具层不读日志。
   * 没接线 = 读不到动静（不是假装没有：这一屏本来就只是那一段日志的回放）。
   *
   * ⚠ 它**不动 `tools` 段的任何一个字节**：notice 只是 `read_channel` 结果里的数据，
   * 而结果进的是 `input`（对话尾部），不进 `instructions`/`tools`（那才是逐字节冻结的前缀）。
   * 所以这一件**不必递 `RENDER_VERSION`**（判据同 `log/types.ts` 那段"事件不改 RENDER_VERSION"）。
   */
  channelNoticeReader?: ChannelNoticeReader;
  /**
   * 这个会话里**她做过什么**（`channel/self-action`）——`read_channel` 用。
   *
   * 平台不对机器人自己发起的动作发 notice，所以这条凭据是从 MCP 管理类工具的回执那一层补的
   * （`tools/mcp-entry.ts` 的 `onReceipt`）。与上面几个读取口同一条纪律：宿主注入，工具层不读日志。
   * 没接线 = 读不到自己的动作（不是假装没有：这一屏本来就只是那一段日志的回放）。
   *
   * ⚠ 与 `channelNoticeReader` 一样**不动 `tools` 段的任何一个字节**：它只是 `read_channel`
   * 结果里的数据（进 `input` 的对话尾部，不进 `instructions`/`tools`）⇒ **不必递 `RENDER_VERSION`**。
   */
  channelSelfActionReader?: ChannelSelfActionReader;
  /**
   * **我自己**那几个标识（宿主注入；`read_channel` 渲染群里动静时用）。
   *
   * 用途只有一处：notice 里说的若是**我自己**（"我被移出群聊"、我被禁言），那一行要写成
   * `我` 而不是一个查不出名字的 id 锚——而"我自己是谁"只有宿主知道（它是两条通道各报一份、
   * 由宿主合成的那一个集合，见 `channel/self-identity.ts`）。
   *
   * **给的是取值器而不是快照**（2026-10-11 修的一处"改了等于没改"）：这份认知是**运行期长出来
   * 的**（OneBot 等 `self_id`、官方等 `/users/@me` 或群里 @ 我的事件），而工具包是在启动时
   * 造好的。收快照 ⇒ 第一次渲染群公告时它还是空集，那一行就永远写成 id 锚。
   *
   * 缺省 = 空集：那一行就按"认不出这个人"如实写（短标识锚），**不猜**。
   */
  selfIds?: () => readonly string[];
  /**
   * 本机时区（IANA 名，`read_channel` 的短时间用）：宿主注入，缺省退回 ISO 原文。
   *
   * 为什么工具层需要它：读回来的每一行都要一个**她不用换算**的时间（`MM-DD HH:MM`）。
   * 与此刻层 `时刻：` 同一条纪律（v26：换算不该由她做），而工具层不读配置，所以由宿主递进来。
   */
  timezone?: string;
  /**
   * 这一轮**叫她的那条消息**是哪一条（宿主注入；没有提及就是 null）。
   *
   * 为什么必须让读取口知道（2026-10-02 用户抓到的一处误导）：v28 之后，群里被提及的那一轮
   * 她**只拿到通知、拿不到正文**，正文靠她自己 `read_channel` 去取；可那条叫她的消息常常
   * 落在"已读位之内"（它是 `wake/channel`，不计入未读，而她之前可能已经读过那一段）——
   * 于是回执写成「没有新消息：你已经读到最新了」，她永远看不到那句原话。截图上就是这个形状。
   * 有了这一个事实，本工具对"叫她的那个会话"一律照给（那条消息必然在最近窗口里）。
   */
  mentionMessage?: () => { sid: string; messageId: string } | null;
  /** 媒体投递口（`send_media` 用）：宿主注入，缺省时那个工具如实报"没有接线" */
  mediaPoster?: MediaPoster;
  /**
   * 单个媒体的大小上限（`send_media` 的"读之前先 `stat`"那道闸）：缺省 {@link MEDIA_MAX_BYTES}。
   *
   * 为什么要留这个口子（2026-10-21）：闸门的**判据**是"超了没超"，而证伪它原本必须造一个
   * 真比 200MB 大的文件——`test/send-media.test.ts` 当年用 `truncate` 造"稀疏文件"，实测在
   * NTFS 上**真分配** 200MB，一次全量测试留下上百个 200MB 的空壳（7.81GB 的来源就是这个夹具）。
   * 上限可注入之后，测试用**几字节**的上限就能同时钉住 `> cap` 与 `== cap` 两侧，一个字节都不浪费。
   *
   * 生产装配层**不传**它（上限仍是 200MB，与投递口 `channel/media-poster.ts` 的 `maxBytes`
   * 引同一个常量）；这里只是把"数"变成参数，不改任何判据。
   */
  mediaMaxBytes?: number;
  /**
   * **发言人**（openid）→ 名字：给 `read_channel` 每行那个"谁"用。
   *
   * 与 `resolveChannelName`（sid → **会话**名）不是一回事——2026-10-02 用户从截图上抓到：
   * 精简那版错把会话名（"测试群聊2"）写成了每行的发言人，于是整列看起来像"群里在说话"，
   * "这句是他说的还是别人说的"根本分不出来。名字的真源仍是联系人表/别名表，
   * 只是要按**那个人**去查（群里发言的人没有自己的键，但有过单聊就查得到）。
   */
  resolvePersonName?: (person: string) => string | null;
  /**
   * 外部内容的渲染器（`read_channel` 用）：默认用 model/render 的 `renderExternalEvent`。
   *
   * 为什么允许替换：那条渲染里含**名字**（谁在哪个群里说的），而名字的真源在宿主手里
   * （她的 `MEMORIES/aliases.md` 与人声明的联系人表）。render 是纯函数，不读文件；
   * 于是名字由宿主算好、通过这个注入点递进来——**而不是**在工具层另写一套渲染。
   */
  renderExternal?: ExternalEventRenderer;
  /**
   * 会话名解析（`read_channel` 的渲染用）：sid → 群名/人名，解析不出返回 null。
   *
   * 只影响"名字带不带得上"，不影响任何判定——所以没接线时 read_channel 照常可用，
   * 只是每条前面少一个名字（她还有 openid 可用，与 speak 的 `to` 同形）。
   */
  resolveChannelName?: ChannelNameResolver;
  /** 按需层软上限，默认 ONDEMAND_WARN_BYTES */
  onDemandWarnBytes?: number;
  /**
   * `ask_human` 的回执里报的等待时长（`config.tools.askHumanTimeoutMin`，毫秒）。
   *
   * 它不改变任何判定——超时事实由 real-loop 按同一份配置落下（`human/expired`）；
   * 这里只是让回执能说清"多久之后你会得知他可能不在"。两处读同一个配置值，不各写一个数。
   */
  askTimeoutMs?: number;
}

export const ADMIN_TOOL_NAMES = [
  'write_persona',
  'timer',
  'speak',
  'report',
  'todo',
  'read_channel',
  // send_media 从 2026-10-03 起就在这个包里注册，但一直没进这份名单——
  // 于是 `byName('send_media')` 在类型上不可达（只有运行期的 Map 认得它）。顺手补齐。
  'send_media',
  'ask_human',
] as const;

export type AdminToolName = (typeof ADMIN_TOOL_NAMES)[number];

/**
 * 合并后的定时器工具名（v35：`set_timer` / `cancel_timer` / `list_timers` 三件并成这一件）。
 *
 * 它是个**对外可见的字面量**：authz 的名单、交接笔记的归类、GUI 的图标表都要跟着它。
 * 别处引用时优先导入这个常量，而不是再抄一遍 `'timer'`。
 */
export const TIMER_TOOL_NAME = 'timer';

/**
 * `timer action=wait` 的**上限**（分钟）：12 小时。防呆，不是能力边界。
 *
 * 为什么要有它（用户 2026-10-08：「上限要写清（例如最长几小时，防呆）」）：
 * `wait` 的全部价值是"**过一会儿再叫我**"——一个拍内的短等（几分钟到几小时）。
 * 没有上限时，一个手滑的 `minutes: 100000` 会排出一条七年后的唤醒：它在表里躺一辈子、
 * 每次 `list` 都占一行，而她要的多半是"明天这时看一眼"（那件事本来就该用 `set` 的 `at`/`cron`，
 * 值也写得更明白）。所以超限**当场报参数错并指路**，不静默夹到上限——
 * 夹掉之后她以为排的是自己说的那个时长，那比报错坏得多。
 *
 * 12 这个数的来历：跨一夜（睡/下班）与跨半天都在里面，而"更长"的等待用 `set` 表达得更准
 * （带时区的绝对时刻、或者 cron 的周期语义）。
 */
export const TIMER_WAIT_MAX_MINUTES = 12 * 60;

/** `wait` 的理由（`reason`）上限：它进的是到点那一轮的上下文，太长等于每轮都在为它付费 */
export const TIMER_WAIT_REASON_MAX = 200;

/**
 * `wait` 排出来的那条定时器的 payload 标记（判"重复 wait"的判据就写在它上面）。
 *
 * 为什么 payload 要有标记而不是"看表里有没有条目"：表里同时躺着 set 布防的、cron 周期的、
 * 以及框架自己排的（记忆整理那种），"她排过一次 wait"必须**认得出来**才谈得上不重复布防。
 *
 * 三个字段各有用处，**一个都不能少**：
 *   · `kind`：这一类条目的身份（`isMemoryMaintainPayload` 认的是另一个 kind，不会串）；
 *   · `note`：到点叫她的**理由**——`render.ts` 的 `wake/timer` 渲染只从 `payload.note` 取
 *     那一句话（复用既有渲染，不另写一套），她到点看见的就是它；
 *   · `sid`：她在**哪个会话**里排的这一条（"同一会话/同一理由不重复布防"的另一半；
 *     没有 IM 会话的那一拍是 null）。
 */
export const TIMER_WAIT_PAYLOAD_KIND = 'wait';

/** 她自报"这是我的内部事"的那一格：`payload.scope === 'self'` ⇒ 不上日程页的周历（v59 约定） */
export const TIMER_SELF_SCOPE = 'self';

/**
 * **框架自己的内务** kind（与"她自己的事"一样**不上日程页的周历**）。
 *
 * 只收"框架替她排的、与人无关的"那一种：
 *   · `memory-maintain` —— 每日记忆整理（常量在 `src/persona/memory-maintain.ts`，
 *     由 `src/runtime/real-loop.ts` 排成每天一次的 cron）。
 *
 * ⚠ **`wait` 不在这里**（`TIMER_WAIT_PAYLOAD_KIND`）：那是"过一会儿叫我"的定时唤醒，内容多半是
 * 替用户记的事（提醒他、约好的事）⇒ 按缺省算**用户向**，照旧上周历。
 * ⚠ 这里的字面量与 `memory-maintain.ts` 的常量**由用例锁住**（`test/timer-payload.test.ts`
 * 断言两者相等），`admin.ts` 不 import persona 那一层——为一个字符串引一条跨层依赖不划算。
 */
export const TIMER_FRAMEWORK_CHORE_KINDS: readonly string[] = ['memory-maintain'];

/**
 * 这一条定时器**是不是给用户看的**（日程页的周历只画用户向的；清单里两类都留、用户向在前）。
 *
 * 判据**黑名单式**（缺省用户向——默认可见比默认隐藏安全），按顺序、先命中先定：
 *   ① `payload.by === 'human'` ⇒ **用户向**（人自己建的，一律算用户向，这条最优先）；
 *   ② `payload.scope === 'self'` ⇒ **她自己的事**；
 *   ③ `payload.kind` 命中 [TIMER_FRAMEWORK_CHORE_KINDS] ⇒ **她自己的事**；
 *   ④ 其余 ⇒ **用户向**（`wait`/`set` 那些多半是"到点提醒用户"的事，没有信号时不该被藏起来）。
 *
 * ⚠ **不看 `payload.action`**：那是"到点做什么动作"（自主工作/提醒/存草稿），与"给谁看"正交——
 * 拿它当判据会把用户的"每周复盘""整理周计划"一起挡在周历外。
 * ⚠ 旧形状（`payload` 是字符串或 null）⇒ 按用户向（缺省口径）。
 * ⚠ GUI 侧有一份**等价实现**（`gui/lib/pages/schedule_page.dart` 的 `_isOwnerFacing`）：界面读的是
 * 同一份投影，但跨语言不能共享代码 ⇒ **两份必须同步改**（各自的用例各钉一遍，判据逐条对齐）。
 */
export function isOwnerFacingTimer(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return true;
  const record = payload as Record<string, unknown>;
  if (record['by'] === 'human') return true;
  if (record['scope'] === TIMER_SELF_SCOPE) return false;
  const kind = record['kind'];
  if (typeof kind === 'string' && TIMER_FRAMEWORK_CHORE_KINDS.includes(kind)) return false;
  return true;
}

/** `payload` 里的一格字符串（读不到给空串）——回执自检与上面那条判据共用 */
function payloadStringField(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return '';
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}
export interface TimerWaitPayload {
  kind: typeof TIMER_WAIT_PAYLOAD_KIND;
  /** 到点叫她的理由（没有理由时空串） */
  note: string;
  /** 她在哪个会话里排的（没有可回投会话时为 null） */
  sid: string | null;
}

/**
 * 这一条定时器表项是不是 `wait` 排的？是就给出它的 payload，不是给 `null`。
 *
 * **判据只此一处**：布防时用它构造、去重时用它识别（`timerWaitPayloadOf` 的两个调用点都在
 * `waitTimerAction` 里）。读的是任意来源的 payload（表里可能是 `set` 的、框架自己排的、
 * 或者是手改 `data/timers.json` 留下的乱七八糟形状），所以每一格都过类型检查——
 * 形状不对一律当"不是 wait"，绝不猜。
 */
export function timerWaitPayloadOf(payload: unknown): TimerWaitPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record['kind'] !== TIMER_WAIT_PAYLOAD_KIND) return null;
  const sid = record['sid'];
  return {
    kind: TIMER_WAIT_PAYLOAD_KIND,
    note: typeof record['note'] === 'string' ? record['note'] : '',
    sid: typeof sid === 'string' && sid !== '' ? sid : null,
  };
}

// ──────────────────────────────── read_channel 的注入点 ────────────────────────────────

/**
 * 会话簿里的一行（`read_channel` 不给 `sid` 时列的就是它；v66）。
 *
 * 字段是**此刻层那张清单要的那几样** + `unread`（她据此决定先看哪个）：
 * 不重造一份投影，只把宿主 `sessionBook`（`channel/sessions.ts` 的 `SessionEntry`）里
 * 对"要不要现在看它"有用的那几格摆出来。
 */
export interface ChannelSessionRow {
  sid: string;
  /** 会话类型显示名（会话口径的 `chatType`：群聊一律 `group`，见 `sidKindOf`） */
  chatType: string;
  /** 她还没看的条数（`SessionEntry.unread`，0 = 那儿没新话） */
  unread: number;
  /** 最近一条消息的时刻（ISO；渲染按本机时区写成 `MM-DD HH:MM`） */
  lastSeenAt: string;
  /**
   * 那个会话里"正在聊什么"（`channel/topic` 折出来的最近一句）。
   *
   * 缺席 = 没有话题（**不是空话题**）：清单不该为一个空串占位。§第四组那道闸之后，
   * "没人理的群"根本不产 `channel/topic` ⇒ 这里自然缺席。
   */
  topic?: string;
  /** 会话显示名（群名/人名；认不出就是 null，由渲染侧退回 sid——不编名字） */
  label?: string;
  /**
   * 「**她上次读到哪**」——`channel/read` 折出来的已读位（`SessionEntry.readUpToSeq`；v67 加）。
   *
   * 为什么把它摆进这一行（2026-10-17）：默认那一屏要从"这一屏最近 limit 条"改成"**上次查看
   * 之后的**"，而"上次查看"必须**跨重启**成立——进程里那份 `readState` 是缓存、重启就空
   *（见 handler 里那段说明）。日志里唯一记着这件事的是 `channel/read {sid, upToSeq}`，
   * 而它启动时就被折进 `sessionBook`（`channel/sessions.ts` 的 `collectSessions`）。
   * 这一格因此是**从日志读回来的账**，不是第二份状态：不新增事件、不动日志 schema、
   * 也不需要在 `AdminToolsOptions` 上多开一个读取口（`channelSessions` 早就接好了）。
   *
   * 量纲是**平台序号**（与 `ChannelMessageView.msgSeq` 同一把尺，见 `msgSeqOf`），
   * 不是事件 seq——换算在 handler 的 `watermarkSeqOf` 里一处做完。
   * 缺席 = 这个会话她一次都没读过（那时照既有的"宁可多给一次"办，见 handler 的 `firstSight`）。
   */
  readUpToSeq?: number;
}

/**
 * 一条读回来的通道消息：**给渲染层看的那几个字段** + 事件自己的一些事实。
 *
 * 与会话簿的 `SessionEntry` 刻意分开：会话簿是**投影**（每个会话一条、只留最近一句），
 * 而这里要的是"这几十条原始消息"——两者不是同一份数据，硬凑在一起会让折叠长出第二种职责。
 */
export interface ChannelMessageView {  sid: string;
  channel: string;
  /** 用契约里那四个字面量而不是 string：渲染要按它判"私聊/群聊"，写宽了就得在渲染里再判一次 */
  chatType: ChannelMessage['data']['chatType'];
  chatId: string;
  /** 发言者（平台 openid） */
  person: string;
  /**
   * 平台给的昵称/群名片：**只用于显示**（认不出 id 时写成「甲（群昵称：…）」）。
   *
   * 用户 2026-10-02 的口径："群昵称应该读，有助于快速识别身份；太长的 id 反而没意义。"
   * 但它**不是身份**：谁都能把自己改成"用户（OWNER）"，所以只作显示、不作判据
   *（判据永远是最左边那个按 id 查出来的名字，见 self-brief"名字不是身份"）。
   */
  nickname?: string;
  text: string;
  messageId: string;
  msgSeq: number;
  /**
   * 这条消息**在点她**（平台 @ 了她，或适配器/关键词判定如实填的"提到了你"）。
   *
   * 为什么它随读回来的每一条一起给（2026-10-08 加；**v67 起筛选口径已换成"上次查看之后的增量"**，
   * 但它照样必须逐条给）：默认那一屏仍要**把提及醒目标出来**（行首 `▶` + 行尾相对年龄，
   * 旧提及还要写明"不是新消息"——用户 2026-10-17 的第二条口径，见 `renderReadBatch`），
   * 而"点没点她"的判据在**宿主**手里——`chatType === 'group-at'` 或 `mentionsMe`，
   * 关键词表也只有宿主有（见 `runtime/real-loop.ts` 的 `mentionedInMessage` 与
   * `channel/inbox.ts` 的分流判据）。工具层**绝不自己重判一遍**：两处各判一次，
   * 迟早"唤醒她的那条"与"她读回来标成提及的那条"不是同一条。
   *
   * 缺席 = 这条不是提及（不是"未知"）：判据只有一条，给不出 true 就是 false。
   */
  mentionsMe?: boolean;
  /**
   * 这条消息**落进日志时的 seq**（`EventLog.nextSeq` 分配，严格单调；宿主不会填别的数）。
   *
   * 为什么视图里需要它、而不是用上面的 `msgSeq`："这个会话自上次读到之后**又来没来过**新消息"
   * 只有它答得对。`msgSeq` 是**平台**的会话内序号，而平台常常给不出（见 `channel/inbox.ts` 的
   * `inboxMsgSeqOf`），官方单聊干脆**恒为 1**——拿它比大小，同一个进程里第二次读单聊必然得出
   * "没有新消息"，哪怕用户刚发了十条（2026-10-05 报的真缺陷）。
   *
   * `msgSeq` 仍然是**未读**的判据（那是"会话里第几条"的语义，见 `channel/sessions.ts`）；
   * 两个数各答各的问题，**别互相顶替**：这里答"新不新"，它答"读到第几条"。
   */
  seq?: number;
  ts: string;
  attachments?: Array<{ type: string; url?: string; name?: string }>;
  /**
   * 这一条消息里**图片**逐张的去向（宿主算好的事实，见 `real-loop` 的
   * `prepareAimedContextImages`）。
   *
   * **有它 = 这一条点名她**（判据在宿主手里，只一处：`imageAimedAtHer`——群聊认 @ / 提及、
   * 私聊无条件）。于是这一条走"点名例外"：图按现有准入装配进上下文（`read_channel` 的
   * handler 写 `image/attached`，渲染层注入 `input_image`）；缺席的那些消息一条都不装配，
   * 那一行只给地址，由她自己决定值不值得看（2026-10-11 用户拍板的两条）。
   *
   * **站位与 `attachments` 里图片的顺序逐个对齐**（只含图、不含文件）——渲染层就是按这个
   * 顺序把状态写进那一行的（见 `renderReadBatch`）。
   */
  contextImages?: ContextImageFact[];
}

/**
 * 一条消息里**一张图**的去向（宿主算好；只出现在点名她的那些消息上）。
 *
 * 三种结局各有一种写法，**没有第四种**（"静默丢掉"不是一种）：
 *   · `ready`   = 宿主已经验过字节与型别（拿渲染 loader 自己那个函数），装配后一定进得去；
 *   · `denied`  = 准入判据挡的，带**理由码**（渲染层用 `contextImageSkipText` 翻成人话——
 *     与预热留痕用的是同一份文案，两处不会各说各的）；
 *   · `over`    = 这一次读的图片名额用完了（上限见 real-loop 的 `READ_CHANNEL_CONTEXT_IMAGE_MAX`）。
 */
export type ContextImageFact =
  | { state: 'ready'; key: string; mime: string; name?: string }
  | { state: 'denied'; reason: ContextImageSkipReason }
  | { state: 'over' };

/**
 * 她自己在这个会话里**说出去的一段话**（由 `speak` 的投递回执 `speak/sent` 归并而来）。
 *
 * 为什么需要单独一类而不是混进 `ChannelMessageView`：她的发言没有发言人、没有平台 messageId、
 * 也不该算进"未读"——它唯一的坐标是事件时刻与"发给哪个 sid"。硬塞进消息形状就得为这些字段
 * 编值，而编出来的值会跟真消息在别处对不上。
 */
export interface ChannelSpoken {
  /** 归并出来的这一段话（一次 speak 的**全部气泡**拼起来；不论几条，read_channel 里只占一行） */
  text: string;
  /** 说出去的时刻（= 投递回执那一刻；时间轴上就按它跟外部消息交错） */
  ts: string;
  /** 那次 speak 把这段话切成了几条气泡（1 = 一次说完）。行上用它说清"这其实是几条" */
  parts: number;
  /** 同一毫秒里跟外部消息排先后用的（事件 seq：投递回执必然排在它消费掉的那条唤醒之后） */
  seq: number;
  /** 同一毫秒里的第二判据：投递那一刻的毫秒。两个相邻 segment 的 ts 可能只差 1ms，用它排稳 */
  atMs: number;
  /**
   * 这段话**在平台上的那条消息 id**（2026-10-12 起才有；`speak/sent` 带上它了）。
   *
   * 为什么现在能有（原来这一类的注释逐字写着"她的发言没有平台 messageId"）：那个 id 一直
   * 在适配器手里，只是被回投那一层窄化丢掉了——`onebot.ts` 的 `createOneBotReplyPoster`
   * 原来只回 `{ok, status}`。补上之后这一格才存在，她**删得掉"自己刚发的那条"**
   * （实测 T1308：她为此扫了两遍原始 jsonl 才凑出 id）。
   *
   * **可选，缺席是常态**：旧日志没有它（`log/types.ts` 的"日志只增不改"先例）、通道也可能
   * 给不出（协议端不回 id）、一次发言被切成 N 条气泡时这一格只记**第一条**
   * （一行一个位置，锚落在她开口的第一条上——与 speak 那边同一个选择）。
   */
  messageId?: string;
}

/** `read_channel` 一行的**四种**来源：外部消息、她说出去的话、群里的一件事（notice）、她做的事（self-action） */
export type ReadChannelItem = ChannelMessageView | ChannelSpoken | ChannelNoticeView | ChannelSelfActionView;

/**
 * 真假判据：这一行是**她自己的管理动作**（「我做过」）而不是谁说的话（2026-10-11 加）。
 *
 * 判据取 `receipt` 在不在——那是这条事件独有的字段（`action` 也有，但 `receipt` 是
 * 载荷校验里必有的那一格，用它更稳）。三个标记**互斥且有序**：
 * `noticeType`（群里的动静）> `receipt`（我做的）> 无标记（别人说的）。
 */
export function isChannelSelfAction(item: ReadChannelItem): item is ChannelSelfActionView {
  // 判 `item` 本身（理由同下面那条）：混进 undefined 时退化成"不是这一类"，而不是抛异常吞掉整屏
  return item !== undefined && item !== null && (item as ChannelSelfActionView).receipt !== undefined;
}

/**
 * 真假判据：这一行是**群里的一件动静**（notice）而不是谁说的话（2026-10-11 加）。
 *
 * 判据取 `noticeType` 在不在——那是 notice 独有的字段（两扇门的适配器都填它，见
 * `channel/self-identity.ts` 的 `ChannelNoticeData`）。与 `isChannelSpoken` 的判据**互斥且互补**：
 * 那个认"没有平台序号"（她的发言），这个认"有事件类别"。
 */
export function isChannelNotice(item: ReadChannelItem): item is ChannelNoticeView {
  // 逐字写三格：几种来源的**固有差别**是"它有什么字段"（notice 有 `noticeType`、
  // 消息有 `msgSeq`、她的发言有 `atMs`）。**不许写 `item.noticeType` 而不判 `item` 本身**：
  // 数组里混进一个 `undefined`（上游某个 `?? []` 没兜住）时，那一句会抛
  // "Cannot read properties of undefined"——而这一层是**渲染**，渲染抛异常的后果是
  // 整屏读不出来（比少一行严重得多）。判 `item` 本身则退化成"这一条不是 notice"。
  return item !== undefined && item !== null && typeof (item as ChannelNoticeView).noticeType === 'string';
}

/**
 * 真假判据：她自己的行**没有平台序号**——`msgSeq` 是"这条是那个会话里的第几条"，只有平台消息有；
 * 她的发言来自 `speak/sent`，天然没有它。用它而不是"看 `person` 在不在"：那个字段将来若有一天
 * 允许缺省（比如平台不给发言人），判据就会把外部消息静默地当成她自己的话——那是读起来完全正常、
 * 却把"谁说的"搞反的错。这个判据只依赖**这两种事件的固有差别**。
 *
 * ⚠ 2026-10-11：notice 与 self-action 也都没有 `msgSeq`，所以这一条**必须先把那两类排掉**——
 * 否则群公告会被渲染成 `（我）：[某人 被禁言 600 秒]`（把别人的动静安到她头上），
 * 她自己的动作也会走进"她说过的话"那一支（自由文本与方括号动作两种形状会混）。
 */
export function isChannelSpoken(item: ReadChannelItem): item is ChannelSpoken {
  return !isChannelNotice(item) && !isChannelSelfAction(item) && (item as ChannelMessageView).msgSeq === undefined;
}

/**
 * 真假判据：这一行是**别人发来的消息**（四类来源里剩下的那一类）。
 *
 * 为什么要有它（v67 加）：`mentionsMe` / `msgSeq` 这两格**只有外部消息有**，而"是不是外部消息"
 * 这一段判断原来在仓里手写了三四遍（`!isChannelSpoken && !isChannelNotice && !isChannelSelfAction`）。
 * 手写的坏处是**类型窄化不了**：`!isChannelSpoken(item)` 只排掉一类，TypeScript 眼里剩下三类，
 * 于是碰 `item.mentionsMe` 就要断言——而断言正是"判据写错也没人拦"的入口。
 * 收成这一处之后，凡是碰这两个字段的地方，编译器都会替我们守着。
 */
export function isExternalMessage(item: ReadChannelItem): item is ChannelMessageView {
  return !isChannelSpoken(item) && !isChannelNotice(item) && !isChannelSelfAction(item);
}

/**
 * 这一行**落进日志时的 seq**（每种来源都有；宿主填不出时退回 0）。
 *
 * 两种用途，同一份判据：
 *   ① 排序的最后一个键——官方单聊的 `msgSeq` **恒为 1**，一批单聊消息在主键与次序键上全部相等，
 *      少了它，同毫秒的顺序就"由实现决定"，而她读到的因果不该随实现变；
 *   ② `read_channel` 判"这个会话有没有新东西"（见 handler 里那句 `fresh`）：
 *      只有事件 seq 答得对这个问题，平台序号答不出（平台常常不给，单聊恒为 1）。
 */
export function eventSeqOf(item: ReadChannelItem): number {
  const raw = isChannelNotice(item) || isChannelSelfAction(item) || isChannelSpoken(item)
    ? item.seq
    : (item as ChannelMessageView).seq;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * 把"她上次读到哪"的**平台序号**换算成**事件 seq**（v67；跨重启那一支的唯一换算处）。
 *
 * 为什么要换算：持久的那笔账（`channel/read.upToSeq`，折进会话簿的 `readUpToSeq`）记的是
 * **平台序号**——那正是"已读"这件事在这仓里的既有量纲（未读计数按它算，见 `sessions.ts` 的
 * `applyChannelMessage`）。而 `read_channel` 判"新不新"用的是**事件 seq**（唯一答得对
 * "这条是不是后来的"的数，见 `eventSeqOf`）。两把尺之间只有这里一处桥。
 *
 * 判据一句话：**取数窗口里"平台序号 ≤ 水位"的最新那一条**——它就是"上次查看"的落点，
 * 它的 `seq` 之后的一切都是新的。
 *
 * 三条边界，都是刻意的：
 *   · 窗口里**一条都不满足** ⇒ 水位比整个窗口还旧 ⇒ 返回 **0**（＝窗口里全是新的）。
 *     宁可多给她看几条，也不能因为"水位太老"就什么都不给；
 *   · **只数外部消息**（`isChannelSpoken` 那一支跳过）：她自己的行与群里的动静没有平台序号这
 *     一回事，拿它们去比水位是把两种量纲混起来；
 *   · 水位 **≤ 0**（没读过 / 宿主没接线）⇒ 0，调用方照 `firstSight` 走"宁可多给一次"。
 */
export function watermarkSeqOf(pool: readonly ReadChannelItem[], mark: number): number {
  if (!(mark > 0)) return 0;
  let best = 0;
  for (const item of pool) {
    if (isChannelSpoken(item) || isChannelNotice(item) || isChannelSelfAction(item)) continue;
    const msgSeq = item.msgSeq;
    if (typeof msgSeq === 'number' && Number.isFinite(msgSeq) && msgSeq <= mark) {
      best = Math.max(best, eventSeqOf(item));
    }
  }
  return best;
}

/**
 * "这一批让她读到了哪一条" → `channel/read.upToSeq`（**那个数的唯一算法**，2026-10-24）。
 *
 * 判据一句话：**外部消息里最大的平台序号**（`msgSeq`）。只数外部消息的理由与 `watermarkSeqOf`
 * 那条纪律同源：她自己的行（`speak/sent`）、群里的动静（`channel/notice`）、她做过的动作
 * （`channel/self-action`）都没有"这个会话里第几条"的语义——拿它们去比水位是把两种量纲混起来。
 *
 * 为什么必须收成一处：这个 bug（用户报的"读过的群未读标签不消失"）的机械原因正是"写入点只有一个
 * 分支有"。现在三处都会写（默认那一屏摆出了东西 / 没有新消息 / 翻页翻到最新），口径必须逐字节
 * 相同，否则"读了却没清"会从其中一处原样漏回来。
 */
export function readMarkOf(items: readonly ReadChannelItem[]): number {
  return items.reduce(
    (max, item) => (isExternalMessage(item) && Number.isFinite(item.msgSeq)
      ? Math.max(max, item.msgSeq)
      : max),
    0,
  );
}

/**
 * 她自己的行首标记（占"谁"那一格）。
 *
 * 措辞的三个约束：① 不能长（每行都是常驻开销，行数才是这个工具的硬预算）；
 * ② **不能跟发言人的昵称混淆**——用户自己就叫"用户（OWNER）"，任何"我"以外的自称都可能
 * 撞上某个群友的群名片；③ 一眼看得出是标注而不是正文。所以取单个"我"字、包在全角括号里：
 * 它占的正是"时间 X："里 X 那一格，而 `（我）` 这种括号形态在这一屏里只可能是标注
 *（昵称要么不带括号（短 id），要么是 `昵称（id …0006）`——括号里永远是一串 id 或"群昵称"前缀）。
 */
export const SELF_SPEAK_LABEL = '（我）';

/**
 * "这一行在点你"的行首标记（默认那一屏里用；往回翻页那一屏不加）。
 *
 * 为什么是 `▶ `（一个半角箭头 + 一个空格）：① 它必须**在行首、与时间同一列之前**——
 * "谁"那一格已经被 `（我）` 占了，标记不能去抢那一格；② 它是**标注不是内容**，
 * 与正文之间隔一个空格，扫一眼就知道"这一行是冲我来的"；③ 不能是 `@`（正文里本来就有
 * 平台的 `@` 前缀，会分不清哪个是框架标的）；④ 别的行一个字都不加，于是
 * "有标记 = 提及"这条判据在整屏里是**单调**的（她不必去数第几列）。
 */
export const MENTION_ROW_MARK = '▶ ';

/**
 * 提及行尾那一格：`【这条提及是 12 分钟前的】` / `【这条提及是 4 天前的——不是新消息】`（v67）。
 *
 * 用户 2026-10-17 的第二条口径原话：「然后她还有**以为有人在前面 at 了自己**的问题。考虑一下
 * **标识提及消息更明显一点**。起码要让她**看懂，不再往前翻了**。」这一格就是"看懂"那两个字：
 * 行首 `▶ ` 只说"这条点了你"，答不了"**多久之前**"；而行里那个 `MM-DD HH:MM`（`shortLocalTime`）
 * 是绝对时刻——要她心算出现在减它，正是这一屏一贯不让她做的事（与 `shortLocalTime` 那条
 * "她不该在自己读数时做换算"同一条纪律）。
 *
 * `stale` = 这条提及落在**水位之内**（她上次查看之前就有了）：那时多写 `——不是新消息`。
 * 为什么这两档必须分得开：她"往前翻"的触发点就是**把一条旧 @ 当成刚叫她的**；而"刚刚"与
 * "4 天前"在纯时刻上看不出来（跨天尤其看不出来）。判据只有一处：调用方给 `stale`
 *（`eventSeqOf(item) <= mentionClock.watermark`，见 `renderReadBatch`）。
 *
 * 措辞为什么不复用 `self-brief.ts` 的 `humanSpan`：那个是**此刻层**的等量级说法（输出 `0 分钟`），
 * 而且没导出；这一格要的是**行内**的"X 前"，且 `≤1 分钟` 要写成"刚刚"（读一屏时最常见的那档，
 * "0 分钟前"读起来像在报一个错）。
 */
export function mentionAgeCellText(tsIso: string, nowMs: number, stale: boolean): string {
  const at = Date.parse(tsIso);
  const span = Number.isFinite(at) && Number.isFinite(nowMs) && nowMs >= at
    ? ageSpanText(nowMs - at)
    : '不知道多久';
  return `【这条提及是${span}的${stale ? '——不是新消息' : ''}】`;
}

/**
 * "多久之前"的行内说法（`刚刚` / `12 分钟前` / `4 天前`）——**只给上面那一格用**。
 *
 * 分档就是给人读的三档：一分钟内是"刚刚"（连"前"都不带，因为它读起来就是"现在"）、
 * 一小时内报分钟、两天内报小时（带余数）、再往上报天。上限只到"天"：这一屏里
 * 超过一天的那几条，她要的判断是"这不是刚发生的"，精确到小时只会让那格更长。
 */
function ageSpanText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes <= 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return minutes % 60 === 0 ? `${hours} 小时前` : `${hours} 小时 ${minutes % 60} 分钟前`;
  }
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * 行尾那个 id 单元的 sigil：`·m<平台消息 id>`（**只对 OneBot 族印**，判据在 `renderReadBatch`）。
 *
 * 为什么是 `·m` 这个形态（三条都是"与既有含义不打架"）：
 *   · **不能用 `#`**：`#` 在这一屏的世界里已经是"平台 message id"——别人引用某条时适配器
 *     写下的前缀逐字是 `[引用 #-754521710]`（`onebot.ts` 的 `quotedPrefix`）。同一个屏里
 *     再用 `#` 当 id sigil，同一个符号就有两个所指。
 *   · **不能用裸数字**：页脚的翻页游标就是**裸 event seq**（`带上 before=76652`），
 *     而 `m` 后面的那个数是**平台 message id**——两个数形状都是整数串，不隔一个字符分不开。
 *   · **不能占既有列**：`▶ `（行首、提及）、`（我）`（"谁"那一格）、`[external_event …]`
 *     （整批框）、`［图］`（附件那一格）都各有其位，所以它**只在行尾**追加。
 * 中圆点 `·` 在这一屏里是既有的"这是标注"符号（见 `pagingFooter` 的 `· OneBot 11 · 群聊`）。
 */
export const MESSAGE_ID_MARK = '·m';

/**
 * 附件那一格里**一张图**的写法（`read_channel` 那一行的唯一实现）。
 *
 * 为什么图必须带上地址（2026-10-11 用户拍板的那条：默认**纯文字 + 给足引用**）：默认那条路
 * 一张图都不装配进上下文，于是这一行就是她唯一的线索——只印一个 `［图］`，她连"这是哪张、
 * 值不值得看"都判不了，更没法自己去看（`vision_read` 要一个**本地文件**：先把地址交给
 * `http_download` 存下来，再读它）。地址就是附件那条事实本身（`attachments[].url`），
 * 与唤醒那条路印的是**同一份**（见 render.ts 的 `renderAttachments`：`[image: 名字] 地址…`）。
 *
 * `fact` 有货 = 这一条**点名她**（判据在宿主，只一处）：那就还要说清**进没进上下文**——
 * 进去了写"已带进上下文"，没进就照实写理由（准入门槛那几条翻人话用的是留痕那一份
 * `contextImageSkipText`；名额用完的写"没带"，框后另有一句报总数）。
 *
 * 三种形态各自的字节（逐字钉在 test/read-channel-images.test.ts 里）：
 *   · 默认那条路：`［图 https://…］`
 *   · 点名 + 进去了：`［图 https://…（已带进上下文）］`
 *   · 点名 + 没进：`［图 https://…（没带进上下文：<理由>）］`
 * 地址缺席（平台没给）时省掉中间那一格，其余一个字不变——不印一个假的空地址。
 */
function imageCellText(
  attachment: { type: string; url?: string; name?: string },
  fact: ContextImageFact | undefined,
): string {
  const url = typeof attachment.url === 'string' ? attachment.url.trim() : '';
  const where = url === '' ? '' : ` ${url}`;
  if (fact === undefined) return `［图${where}］`;
  switch (fact.state) {
    case 'ready':
      return `［图${where}（已带进上下文）］`;
    case 'denied':
      return `［图${where}（没带进上下文：${contextImageSkipText(fact.reason)}）］`;
    case 'over':
      return `［图${where}（没带进上下文：这一次读的图片名额用完了）］`;
  }
}

/**
 * 出站到某个会话**成功之后**回执里的那一句 —— 说清"凭什么能确认它发出去了"。
 *
 * 用户 2026-10-07 报的现象：「report 貌似不进 channel？她老是不知道自己的 report 已经发出去了
 * 导致重复发」。三问的答案是：**消息进了日志，但没有进她"读了能确信"的那条路**。原来只有
 * `speak` 写那种带 `text` 的 `speak/sent`（`read_channel` 的"我说过什么"只认它），
 * `report` 写的那条没有 `text` ⇒ 她 `report` 完去翻会话，**自己那一篇不在里面**，
 * 于是她只能靠"工具回执里那句已送达"相信——而那正是最容易被下一拍读丢的一手信息。
 *
 * 这一句把判据直接摆在她眼前（她是唯一的读者），说三件事：
 *   ① 送达的目标（会话坐标，与外部会话清单上的同一个 sid）；
 *   ② **凭什么能确认**——`read_channel` 里会有一行 `（我）`（= 她被指向去看的那个东西）；
 *   ③ 因此**不用再发一遍**（"重复发"这件事故的直接解药）。
 *
 * 为什么写成常量而不是在 `speak` / `report` 里各拼一遍：两个工具的路由不同、**判据必须同一句**
 * ——她据这句话决定要不要再发。两处各写一遍，迟早一句改了另一句没改，而"她以为没发出去"
 * 这种误判正是这次要修的病害本身。
 *
 * 2026-10-08 用户的口径：「**speak 和 report 工具发送成功的回执应该明确，成功投递，
 * 不必重复发送**」。原来那一句写的是"不用再发一遍"——意思对，但**没有一个她能一眼认出的词**：
 * 她在回执里扫的是"成功没有、要不要再发"，而"已送达凭据"这四个字看起来像一条内部记录。
 * 所以这一句现在**开头就是结论**（`投递成功`），并把用户点名的那四个字原样写进去
 * （`不必重复发送`，逐字，不许改写成"不用再发"——她认的就是这一串）。
 * 失败/被拒那一侧**不许出现它**（`test/delivery-receipt.test.ts` 逐字钉着两侧）。
 *
 * ⚠ **v76 起它不再印进任何回执**（`speak`/`report` 在 v74 就搬走了；`send_media` 这一笔搬）：
 * 这段样板现在住在 `SELF_BRIEF` §2.1（**一次、可命中**），回执里重复一次就是每轮多付一次全价。
 * 常量本身留着：`test/delivery-receipt.test.ts` 拿它当"不许回归"的锚（逐字比对），
 * 而它也是这段判据的**唯一措辞出处**——要改口径，先改这里、再同步 `SELF_BRIEF` 与用例。
 */
export const SENT_CREDENTIAL_NOTE =
  '投递成功（**不必重复发送**）：这个会话的"我说过什么"里已经有这一篇了'
  + '（`read_channel` 里那一行行首是 `（我）`）——它是"已经发出去了"的证据，不是"我想发"。';

/**
 * `speak` 失败回执的那一句（v74，用户 2026-10-20 的**最终口径**：`失败，<原因>`）。
 *
 * **原因必须是中文、能让她判断下一步**，不许印内部栈或英文原文（用户口径）。判据是错误性质，
 * 与 `deliveryAdvice` / `deliveryFailureLines` **同一套正则**——两处各写一份，"权限类不必重试"
 * 就会在某条路上漂成"可稍后再试"。这里只把整句压成一个短语。
 *
 * 已知代价（如实记）：平台原话（`HTTP 400 code=…`）不再进回执，也不再进事件——它是调试信息，
 * 而回执是**每轮被读回**的那一行。要看原话去通道适配器的日志/`speak/sent` 成功的那些回执。
 */
function speakFailureReason(reason: string, sent: number, total: number): string {
  const progress = sent > 0 ? `已发出 ${sent}/${total} 条；` : '';
  if (/40034105|无权限|主动消息|permission|forbidden|403/i.test(reason)) {
    return `${progress}没有权限（平台拒绝），不必重试`;
  }
  if (/401|unauthorized|token|凭据|credential/i.test(reason)) {
    return `${progress}凭据被拒，检查配置后再试`;
  }
  if (/404|not found|不存在|解散|移出/i.test(reason)) {
    return `${progress}会话不存在（可能已解散或被移出）`;
  }
  if (/超时|timeout|ECONN|ETIMEDOUT|socket|network/i.test(reason)) {
    return `${progress}网络或对端问题，可稍后再试`;
  }
  return `${progress}通道拒绝了这次发送（原因不明），不必重试`;
}

/**
 * `send_media` 回执里"这条消息的平台 id"那一句 —— **唯一实现**（2026-10-19 现场）。
 *
 * 为什么必须有它：她发图走 `send_media`，回执从前只写"投递成功"——平台回的 `message_id`
 * 只进了事件（`speak/sent.messageId`），**没进她读到的那段文本** ⇒ 她看不见自己刚发的那条的
 * id。等她想撤回时已经晚了：撤回窗口只有两分钟，而协议端的 `get_group_msg_history`
 * **不返回 bot 自己发的消息**（她拉过一遍，那条一条都拿不到）。所以 id 必须在她**读回执的
 * 那一眼**就在，而不是等她回头翻聊天记录。
 *
 * 形态与 `read_channel` 行尾**同一串**（`MESSAGE_ID_MARK` + id）：两处看到的是同一个字符串，
 * 她不必再判断"这两个是不是一回事"，也不必为了核对它去扫原始 jsonl。
 *
 * 拿不到 id 时**不许沉默**（这一句比正向那句更要紧）：那正是"先答应再发现做不到"的来源。
 * 原先通道给不出 id 时回执里一个字都没有，她只能默认"能撤"，两分钟后才发现不能。
 * 现在当场说破"没返回 id ⇒ 撤回可能做不到"，并把判据（回执里带 `·m<id>` 才算拿得到）与
 * 规矩（发之前先确认，不返回就别承诺）一并写给她——她**下一次**动手之前就知道要确认什么。
 *
 * 官方门那一串 `ROBOT1.0_…` 同样只在这里印（**不进 `read_channel`**：那一屏按通道开关，
 * 理由见 `renderReadBatch` 的 `printIds`）。它今天没有撤回路径，所以正向那句只说"id 是什么、
 * 拿它撤/查"，**不保证撤得掉**——能不能撤是通道能力，不是这一句能替她答的。
 */
export function mediaReceiptIdLine(messageId: string | undefined): string {
  if (messageId === undefined || messageId === '') {
    // 这一句里**一个 `·m` 都不许有**（连"格式长什么样"都不提）：她扫回执时只要看见 `·m`，
    // 就该意味着"id 在这里"。判据写成"写得出那串平台消息 id 才算拿得到"，同一件事、
    // 但不在没有 id 的回执里摆一个像 id 的符号。
    //
    // v76：**这一态保持详细，不许压**（与成功那行的 `平台消息 id：·m<id>` 相反）——
    // "没拿到 id ⇒ 撤回可能做不到"是她下一次动手前必须知道的事，而那一行里每个字都在回答
    // "为什么不行 / 规矩是什么"。样板压缩只压"已经送到"那一侧。
    return '这条**没拿到平台消息 id**：这个通道没返回 id，撤回可能做不到'
      + '（判据：回执里写得出那串平台消息 id 才算拿得到。发之前打算之后撤回，就先确认这一点——不返回就别承诺能撤）。';
  }
  // v76：压到极限——**样板搬进 `SELF_BRIEF` §2.1**（"`·m<id>` 是平台消息 id、与 read_channel
  // 行尾同一个、撤回/核对原话用它"）。回执里只留"它是什么（`id=`）+ 那串 id"。
  // 原来那句尾注（`（与 read_channel 行尾那串同一个：要撤这条、要查这条的原话，用的就是它）。`）
  // 一条回执 29 个字符、历史里 88–121 条 ⇒ 纯浪费（审计 ③-2 第一条的读数）。
  // 形态照审计建议的 `id=·m…`（而不是 `平台消息 id：…`）：固定文字再省 5 个字符，
  // "它是什么"由 `SELF_BRIEF` 那一段负责——**回执是逐轮重发的，提示词只付一次**。
  return `id=${MESSAGE_ID_MARK}${messageId}`;
}

/**
 * 回执里引用她送出去的那段原文时最多引几个字（**中文计字口径**，与 speak 的硬门同一把尺）。
 *
 * 为什么要有这个数：`report` 允许 64000 字，把整篇抄进回执等于把这一篇**再付一次 token**
 * （回执进历史、之后每轮重发）。锚点的用处是"她一眼认得出这是哪一篇"，
 * 一句开头就够；超出的部分在回执里说清"全文多少字、这里只引开头"。
 */
export const SENT_ANCHOR_MAX = 40;

/**
 * 回执里那个**可核对的锚点**：送出去的到底是哪一句/哪一篇（`speak` 与 `report` 共用）。
 *
 * 用户 2026-10-08 的第二条：「送出的是哪一句（可核对的锚点）」。她要能拿这一行去核对自己
 * 刚才说了什么——回执里只有一个"ok"时，她既不知道发出去的是哪一版措辞（分段会摘标点），
 * 也不知道自己有没有说漏。
 *
 * 引的是**实际出站的字节**（`speak` 传切分后拼起来的那一段、`report` 传原样正文），
 * 不是她原本想说的那一份：核对的落点是"那边收到了什么"（`read_channel` 读回来的也是它）。
 *
 * **引用时压成一行、字数按原文算**（两个不同的量，刻意分开）：
 *   · 引文压平空白，因为回执里一行就是一行（多行正文会把结论挤散）；
 *   · 而"全文 N 字"用原文的**中文计字**（`charCount`，与回执上面那条
 *     `日志/前端：… 共 M 字` 同一把尺）——两处各算一次会出现"68 字"与"67 字"并存，
 *     她核对时先要判"哪个数是准的"，那正是这条锚点不该带来的负担。
 *
 * `noun` 只有两个字（`句` / `篇`）：一段聊天话是"这一句"，一篇报告是"这一篇"——
 * 措辞的判据仍然只在这里一处，两个调用点不各写一遍。
 */
export function sentAnchorNote(text: string, noun: '句' | '篇'): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = charCount(text);
  // 截断按**引文**那串判：她看到的就是它，超过 40 字就该说"这里只引开头"
  const clipped = charCount(flat) > SENT_ANCHOR_MAX;
  const head = clipped ? `${[...flat].slice(0, SENT_ANCHOR_MAX).join('')}…` : flat;
  return `送出的就是这一${noun}（可核对）：「${head}」`
    + (clipped ? `（全文 ${chars} 字，这里只引开头）` : '');
}

/**
 * 出站**真的送进了某个会话**之后，回执里那两行 —— `speak` 与 `report` **唯一的共用实现**。
 *
 * 两行各答一个问题，缺一条她就会去重发：
 *   ① **送出去的是哪一句**（`sentAnchorNote`：可核对的锚点）；
 *   ② **凭什么能确认送到了**（`SENT_CREDENTIAL_NOTE`：下一轮 `read_channel` 里读得到，
 *      所以不必重复发送）。
 *
 * 为什么收成一个函数而不是让两个工具各拼两行：用户点名这两句要**逐字一致**
 * （「能共用就共用，别两处各写一套」）——她在两个工具的回执里看到的是同一个判据，
 * 才谈得上"照着它决定要不要再发"。目标（发到哪儿、几条气泡）仍由调用方那一行说，
 * 因为两条路的目标来源本来就不同（`speak` 是回投地址、`report` 还带 HTTP 状态）。
 */
export function sentReceiptLines(input: { text: string; noun: '句' | '篇' }): string[] {
  return [sentAnchorNote(input.text, input.noun), SENT_CREDENTIAL_NOTE];
}

/**
 * 出站**失败/被拒**之后，回执里那两行 —— 同样只有这一处实现（`speak` 与 `report` 共用）。
 *
 * 用户 2026-10-08 的口径：「**失败/被拒 ⇒ 明说不必重试或说明为什么可以重试**
 * （与"成功"明确区分，别含糊）」。三件事必须同时说清：
 *   ① **失败了**（开头就是"失败"，与成功那份开头就是"投递成功"形成对照）；
 *   ② **已经发出去几条收不回来**（`speak` 会断在半路，`report` 是整篇一条）；
 *   ③ **还要不要试**——判断来自 `deliveryAdvice`（平台错误码背后的性质：权限类再试也一样、
 *      网络类可稍后再试、其余按"不必重试"处理）。
 *
 * 判据不在这里另写一份：整段失败与半路失败的分支都走 `deliveryAdvice`，
 * 而"这一篇没送达"这句必须点明**本机那一段不算送达**（否则她会把对话流里那条记录
 * 读成"他已经收到了"）。
 */
export function deliveryFailureLines(input: {
  /** 目标怎么说（`发往 X` / `投递`）；调用方拼好，两条路的目标来源不同 */
  where: string;
  /** 这一次一共要发几条（`speak` = 切出来的段数；`report` = 1） */
  total: number;
  /** 真的送成了几条（收不回来了的那些） */
  sent: number;
  /** 平台/通道给的原因 */
  reason: string;
}): string[] {
  // 整段没发出去（`sent === 0`）时**换一句更直白的话**：分段的账（"第 N 条起"）在一条都没成的时候
  // 读起来像"只差一个数"，而她要的判断是"外面一个字都没有"。所以：
  //   · 半路断的（`sent > 0`）⇒ 照旧报段账（她已经说出去了几句，这个数必须准）；
  //   · 一条都没成、且本来只有一条 ⇒ "这一条没有送达……不等于他收到了"（本机那份不算送达）；
  //   · 一条都没成、本来有多条 ⇒ 也报段账（她从"共 M 条"看得出这是整段失败）。
  //
  // 2026-10-20（R4 的收尾，用户判的）：**两支都要说清"本机对话流那份在、但那不等于他收到了"**。
  // 这句话原来只在"一条都没成"那支里——半路失败那支只报段账。原先那层意思由被删掉的
  // `日志/前端` 行承担（"日志那一份照旧在"），删了之后半路失败的回执就只剩"第 N 条起未发出"，
  // 她会读成"整段都没了"（反过来更糟的误读是"本机有=他收到了"）。所以把**同一句**复用过来，
  // 不新增样板：单条失败那支逐字原文不变，半路失败那支接在同一条后面（**同一串字**，只多一个句号）。
  const localCopyClause = '对话流里那一段只是本机记录，不等于他收到了';
  const head = input.sent > 0 || input.total > 1
    ? `${input.where}失败：第 ${input.sent + 1} 条起未发出（共 ${input.total} 条）。`
      + `${localCopyClause}。${input.reason}`
    : `${input.where}失败：这一条没有送达（${localCopyClause}）。${input.reason}`;
  return [head, deliveryAdvice(input.reason, input.sent)];
}

/**
 * 本轮**没有 IM 会话可发**时的回执 —— `speak` 与 `report` 共用这一句（只有名词不同）。
 *
 * 它不是失败，也**不是成功投递**：本机对话流那一份永远落下了，而 IM 那一跳根本没发生。
 * 所以这一段里**不许出现**"不必重复发送"（那会让她以为外面收到了），但必须给出去路：
 * 要它真的到那边，带 `to` 再发一次——**那不是重发，是第一次发到会话**。
 *
 * 2026-10-20（用户实测：「**这种不能继续缩吗。**」）：原来是三段同义话（跳过+原因 / 只在本机 /
 * 要发就带 `to`），后面还挂着一句"这一轮没写凭据、下一轮翻那个会话看不到"。三段说的是同一层
 * 事实，而它**每次**"没有会话可发"都出现 ⇒ 每轮请求都在为同一句话付一次费。压成一行，
 * 三个信息点一个不少：
 *   ① 跳过 + 原因（没有 IM 会话可发）；
 *   ② **只**落在本机对话流、**不等于他收到了**（"人在界面能看见"是同一件事的另一面：界面就是
 *      这条流；"下一轮翻那个会话看不到"是它的直接推论——没到那边，自然读不回来，不必另说）；
 *   ③ 要发到那边就带 `to` 再发一次。
 * 实测（`estimateTokens`，仓库同一把尺；单条）：104 → 57 字、65 → 34 token。
 */
export function localOnlyNote(noun: '发言' | '报告'): string {
  return `投递：本轮没有 IM 会话可发（跳过）；${noun}只落在本机对话流，不等于他收到了。`
    + '要发到那边，带 `to` 再发一次。';
}

/**
 * 把"她在这个会话里说过的话"与外部消息**按时间轴交错**成一批（read_channel 唯一的合批实现）。
 *
 * 三件事在这里落定，每一条都是刻意的取舍：
 *
 *   ① **一次 speak = 一行**。切分是投递的属性（`chat-split` 会按逗号把一段话切成 N 条气泡），
 *      而 read_channel 的预算是**行数**：一次 151 字的发言在 IM 上发了 13 条，读回来若也占 13 行，
 *      她翻开信箱看到的全是自己刚才说的话。所以**归并发生在宿主那一侧**（`readChannelSpoken`
 *      把一次发言的多条回执拼成一条），到这里 `spoken` 里一项就是一行。
 *   ② **只认真的送到那个会话的那些回执**。判据收在 `deliveredToSid` **一处**（产生侧走
 *      `deliverToSession`，消费侧走它——两边引同一个实现）。本机对话流那条回执
 *      （`channel='log'`）不代表话到了那边；投递失败/被拒时**没有**这条回执
 *      ——"没发出去"就不算"她说过"，否则她会以为自己答过了，而群里其实一个字都没有。
 *      走这条判据的不止 `speak`：`report` 的正文出站与 `send_media` 也在内
 *      （2026-10-07 修的就是 `report` 漏了 `text` 导致它读不回来）。
 *   ③ **不额外扩窗**：`limit` 是这一屏的**总行数**（她的行也算），所以最多还是 limit 行。
 *      这是"她读的是这段时间里发生了什么"的口径——时间轴只有一条，没法把她的行排除在外还保持
 *      先后可读。反过来也挡住了"她的发言把外部消息挤没"：一屏就这么多行，不会因为她说得多而变长。
 *
 * `hits` 由宿主按"最近 limit 条外部消息"取好（时间正序），`spoken` 是同一会话里说过的那些
 * （顺序不要求），这里把两股按时间轴合起来、再压回 limit。
 */
export function mergeChannelSpeech(
  hits: readonly (ChannelMessageView | ChannelNoticeView | ChannelSelfActionView)[],
  spoken: readonly ChannelSpoken[],
  limit: number,
): ReadChannelItem[] {
  return sortByTimeline([...hits, ...spoken]).slice(-limit);
}

/**
 * 同一毫秒里排先后的那个键（`sortByTimeline` 里用；抽出来只为一处实现）。
 *
 * 外部消息用它自己的平台序号（"这条是会话里第几条"，最贴近人的直觉），她的发言用投递那一刻的
 * 毫秒。两个键都过一遍 `Number.isFinite` 兜底：`Date.parse` 认不出的时间戳会给出 NaN，
 * 而比较函数返回 NaN 等于把顺序交给实现——宁可退回"按日志先后排"，也不让她读到随机的因果。
 */
function timelineOrderKeyOf(item: ReadChannelItem): number {
  // 四种来源各用自己的"同毫秒次序键"：她的发言用投递那一刻的毫秒（atMs）、notice 与她自己的
  // 动作都用事件 seq（这两类都没有平台序号这回事）、平台消息用它自己的平台序号（最贴近人的直觉）。
  const raw = isChannelNotice(item) || isChannelSelfAction(item)
    ? item.seq
    : isChannelSpoken(item) ? item.atMs : (item as ChannelMessageView).msgSeq;
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * 按时间轴排序的**唯一实现**（合批、以及"未读那一段怎么排"都走它）。
 *
 * 三个键，依次收窄：
 *   ① 时间（ISO 8601 同带时区，字典序即时间序）；
 *   ② 同一毫秒按 `timelineOrderKeyOf`（她自己刚说的话排在自己被叫醒那条之后）；
 *   ③ 再按**事件 seq**——事件日志的先后就是真相。官方单聊的 `msgSeq` **恒为 1**，一批单聊消息
 *      在主键与次序键上全部相等，少了它，同毫秒的顺序就"由实现决定"，而她读到的因果不该随实现变。
 *
 * 为什么翻页与"未读窗口"也要用它（2026-10-08）：那两处都要在"这一段时间里发生了什么"上切片，
 * 若各自用一套排序，同一批消息在"翻页里的先后"与"合批里的先后"可能不一致——
 * 那是读起来完全正常、因果却反了的错。
 */
export function sortByTimeline(batch: readonly ReadChannelItem[]): ReadChannelItem[] {
  const merged = [...batch];
  merged.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    const ka = timelineOrderKeyOf(a);
    const kb = timelineOrderKeyOf(b);
    if (ka !== kb) return ka - kb;
    return eventSeqOf(a) - eventSeqOf(b);
  });
  return merged;
}

/**
 * 取某个会话的消息（时间正序，最多 `limit` 条）。**宿主注入**：工具层不读日志、不认识 EventLog。
 *
 * `limit` 已由调用点夹到合法区间（1..上限），实现不必再判一次。
 *
 * `before`（可选）是**往回翻页的游标**（事件 seq）：
 *   • 不给 ⇒ 取"现在这儿有什么"（最近 limit 条）——默认那一屏走这条路；
 *   • 给了 ⇒ 取**事件 seq 严格小于它**的最近 limit 条。
 * 两种取法在宿主侧只差一刀 `event.seq >= before`，**没有第二种实现在别处**
 *（`real-loop.readChannelMessages`）。为什么游标是事件 seq 而不是平台序号：
 * 平台序号答不了"这一条在这段历史里的位置"（官方单聊恒为 1、OneBot 没 @ 的群消息也没有），
 * 拿它当游标必然错页——而事件 seq 单调、稳定、跨重启不变，且她上下文里本来就有它。
 *
 * 返回的窗口是"外部消息"的上界：她自己的发言由宿主另外取（`channelSpokenReader`），
 * 工具层负责把两股按时间轴合起来并压回 limit——**合批只有一处实现**（见 `mergeChannelSpeech`）。
 */
export type ChannelReader = (
  sid: string,
  limit: number,
  before?: number,
) => Promise<readonly ChannelMessageView[]>;

/**
 * 她在这个会话里说过的话（宿主注入；只含真的送到这个会话的那些）。
 *
 * 顺序不作要求（合批时由 `mergeChannelSpeech` 按时间轴排）：宿主全量扫日志，
 * 拿到的是"日志里出现的先后"，那与"说出去的先后"在旧事件上不一定一致。
 * 与会话清单、未读、话题全都无关——它只服务 read_channel 的"她已经回过什么"这一眼。
 */
export type ChannelSpokenReader = (sid: string) => Promise<readonly ChannelSpoken[]>;

/**
 * 这个会话里**发生过的事**（`channel/notice`：谁开了全员禁言、谁入群退群、谁撤回了一条……）——
 * 宿主注入，与消息那一路同一个理由（工具层不读日志）。
 *
 * 为什么单开一个口而不是并进 `ChannelReader`：两者的**语义不同**（那条答"谁说了什么"、
 * 这条答"群里出了什么事"），落库时也是两种事件。并进一个口就得在两边各分一次流，
 * 而"哪一条是消息、哪一条是动静"这个判断在这里已经有唯一实现了（`isChannelNotice`）。
 *
 * 顺序不作要求（合批时由 `sortByTimeline` 排）。没接线 = 读不到动静，其余照旧。
 */
export type ChannelNoticeReader = (sid: string, limit: number, before?: number) => Promise<readonly ChannelNoticeView[]>;

/**
 * 这个会话里**她做过什么**（`channel/self-action`：全员禁言、禁言、踢人、改群名、退群……）——
 * 宿主注入，与上面三个读取口同一条纪律（工具层不读日志）。
 *
 * 为什么单开一个口而不是并进 `ChannelNoticeReader`：两者答的是**不同的问题**
 * （那条答"群里出了什么事"、这条答"我做了什么"），落库时也是两种事件、两种渲染。
 * 并进一个口就得在两边各分一次流，而"这一条是谁的"这个判断在这里已经有唯一实现了
 * （`isChannelSelfAction`）。
 *
 * 顺序不作要求（合批时由 `sortByTimeline` 排）。没接线 = 读不到自己的动作，其余照旧。
 */
export type ChannelSelfActionReader = (sid: string, limit: number, before?: number) => Promise<readonly ChannelSelfActionView[]>;

/**
 * 外部内容的渲染器：一条消息 → 一个 `[external_event …]` 包裹。
 *
 * 类型里带上会话条目，是因为名字的解析需要它（联系人表/别名表按 sid 查，而"这个人是谁"
 * 还要看会话簿里最近一条是谁说的）。工具层只负责把数据摆好，不负责猜名字。
 */
export type ExternalEventRenderer = (
  message: ChannelMessageView,
  entry: SessionEntry | null,
) => string;

/**
 * 名字的那个注入点（**只给 read_channel 用**）：sid → 显示名。
 *
 * 与会话渲染的 context 分开，是因为名字的**真源**在宿主手里（`config.persona.contacts`
 * 是"人声明的事实"、`MEMORIES/aliases.md` 是她自己认的），而工具层两样都不该读。
 * 宿主接线时它顺手把"这个会话是谁"的结论递进来；没接线就退回 openid（不编名字）。
 */
export type ChannelNameResolver = (sid: string) => string | null;

/**
 * `read_channel` **不给 `sid`** 那一支的回执（v66）：列会话簿。
 *
 * 为什么是一支而不是另一件工具：此刻层的会话清单**有窗口**（私聊常驻、群聊只列她 7 天内
 * 回过话或 1 小时内有人 @ 她的），于是清单末尾会有一句「还有 N 个会话没列」——那一句必须配
 * 一个真出口，而"看全部会话"与"读某个会话"本来就是同一件事的两个入口（给不给 sid）。
 * 工具清单的每个字节都是冻结前缀的成本，新增一件工具要多付一整条描述的常驻钱。
 *
 * 判据纪律：
 *   · **顺序照宿主给的**（会话簿按最后说话时间倒序，`channel/sessions.ts` 那一条排序），
 *     这里不重排、不截断——"还有 N 个没列"是**此刻层**那张清单的事，这里是全量；
 *   · **没接线就如实说没接线**（不假装"外面一个人都没有"）：这两种回执对她要做的事
 *     完全不同——前者是"这一侧没接上"，后者是"外面真的没人找过你"；
 *   · **一个会话都没有**时明说"还没有任何外部会话"：那是**诚实的**回执（新装的实例就是这样），
 *     不是空结果。空串会被读成"框架没答我"。
 */
function sessionsListResult(
  readSessions: (() => readonly ChannelSessionRow[]) | null,
): ToolHandlerResult {
  if (readSessions === null) {
    return errorResult(
      'read_channel 需要宿主接上会话簿才能列会话（当前进程没有接线）。'
      + '要看某个会话，请给 sid（形如 qq:group:<群 id>）。',
      TOOL_ERROR_CODES.notConfigured,
    );
  }
  let rows: readonly ChannelSessionRow[];
  try {
    rows = readSessions();
  } catch (err) {
    // 读会话簿是**宿主**的动作（工具层不读日志）：它抛了就如实报，并给一条还能走的路
    // （给 sid 照旧能读某个会话）。不吞成"外面没人"——那是两件完全不同的事。
    return errorResult(
      `读会话簿时出错：${err instanceof Error ? err.message : String(err)}。`
      + '要看某个会话可以照旧给 sid（形如 qq:group:<群 id>）。',
      TOOL_ERROR_CODES.notConfigured,
    );
  }
  if (rows.length === 0) {
    return okResult('还没有任何外部会话：没有人从这个方向找过你。有人说话之后它会出现在这里。');
  }
  const unreadTotal = rows.reduce((sum, row) => sum + (row.unread > 0 ? row.unread : 0), 0);
  const lines = rows.map((row) => {
    const kind = CHANNEL_ROW_TYPE_LABELS[row.chatType] ?? row.chatType;
    const name = (row.label ?? '').trim();
    const who = name === '' ? row.sid : `${name}（${row.sid}）`;
    const unread = row.unread > 0 ? `｜${row.unread} 条没看` : '';
    const topic = (row.topic ?? '').trim();
    const talking = topic === '' ? '' : `｜在聊：${topic}`;
    return `- ${kind} · ${who}｜最后 ${shortStamp(row.lastSeenAt)}${unread}${talking}`;
  });
  return okResult(
    `外部会话共 ${rows.length} 个${unreadTotal > 0 ? `（未读合计 ${unreadTotal} 条）` : ''}`
    + '——想看某个会话就给它的 sid：\n'
    + lines.join('\n'),
  );
}

/** 会话类型的显示名（与会话簿那一套词同源：`sidKindOf` 折出来的只有这两档 + 私聊） */
const CHANNEL_ROW_TYPE_LABELS: Record<string, string> = { c2c: '单聊', group: '群聊' };

/** `MM-DD HH:MM`（UTC 切片；本机时区由渲染那一侧负责，这一支只给事实） */
function shortStamp(iso: string): string {
  return iso.slice(5, 16).replace('T', ' ');
}

/** `read_channel` 的条数上限（默认一屏 20 行；上限 100 是"别一次把整段上下文挤掉"那道闸） */
export const READ_CHANNEL_DEFAULT_LIMIT = 20;
export const READ_CHANNEL_MAX_LIMIT = 100;

/**
 * 翻页模式**一页 15 条**（用户 2026-10-08 定了"翻页模式能读到全部消息"这条能力，当时的页大小
 * 是 50 条；2026-10-23 她一句「50 条太多了」把它改成 15 条——见 `model/render.ts` 的 v80）。
 *
 * 它与 `limit` 的分工（别把两个数混起来）：
 *   • `READ_CHANNEL_MAX_LIMIT` 是**硬上限**（100）——她显式要更多的行时夹到它，防的是
 *     "一次拉几千条回来把上下文撑爆"；
 *   • 这个 15 是**一页的默认与建议**（**翻页模式下** `limit` 缺省时就用它，页脚也照它指路）：
 *     翻页是"一屏一屏往回走"，15 行是用户定的一屏；她要更窄（只看几句）或更宽（最多 100）
 *     都由 `limit` 说了算，而**页脚永远照本页实际用的那个数**告诉她下一页怎么翻（口径只有一处）。
 *     ⚠ 缺省的这一档由调用点传进 `readLimit(raw, fallback)`（见那里的说明）：有游标 ⇒ 这个 15，
 *     无游标 ⇒ `READ_CHANNEL_DEFAULT_LIMIT`（20）——两档混用会让页脚说的数与实发条数对不上。
 */
export const READ_CHANNEL_PAGE_SIZE = 15;

/**
 * 往回翻页的游标：**事件 seq**（`ChannelMessageView.seq` / `ChannelSpoken.seq`，
 * 落库时由 `EventLog.nextSeq` 分配，严格单调、重放稳定、跨重启不变）。
 *
 * 语义只有一句：**"这一屏之前"= 事件 seq 严格小于该值的那一段**。于是
 *   • **无重复、无空洞**：seq 严格单调且唯一，`< cursor` 切出来的两页必然不重叠、也不漏；
 *   • **不漂移**：新消息落库只会拿到更大的 seq，改不了"更早那一段"的成员
 *     ——这正是它不能是"页码"的原因（页码会随新消息整体平移，翻第二页时会重读第一页）；
 *   • **跨重启有效**：它写在日志里，不靠进程内存。
 *
 * 给不出来 / 过期（旧日志被裁掉、或者她转抄错了一位）时**必须明确报参数错并指路**，
 * 不许静默给一屏空的——"空"与"到头了"是两件完全不同的事（见 handler 里那两个分支）。
 */
export interface ReadCursor {
  /** 读**事件 seq 小于**它的那些（不含它自己） */
  before: number;
}

/** 翻页游标变成她读得懂的那个数：`before=1234`。写进页脚与参数错误里，**一处实现** */
export function cursorText(before: number): string {
  return `before=${before}`;
}

export interface AdminToolkit {
  readonly tools: readonly ToolDefinition[];
  /** 按工具名取用（宿主注册与测试直接调用） */
  byName(name: AdminToolName): ToolDefinition;
}

// ──────────────────────────────── persona 路径校验 ────────────────────────────────

function normalizeRelative(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 比较用的归一化：Windows 大小写不敏感，路径比较必须与文件系统口径一致 */
function comparably(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function isInside(root: string, target: string): boolean {
  const r = comparably(root);
  const t = comparably(target);
  if (t === r) return true;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * 把相对路径解析到 personaRoot 之内，越界一律拒绝。
 * 三层校验对应 design.md §4.10 第 1 条：①拒绝绝对路径/盘符；②拒绝 `..` 段；
 * ③resolve 后前缀比较，再对**两边都展开**后的真实路径比一次，堵住符号链接逃逸。
 *
 * ── 第三层为什么必须"两边都展开"（2026-10-23 修，现场：`file 的父目录经符号链接指向
 * persona/ 之外：STATE.md`，同一条路径此前一直是能写的）──
 *
 * 原来的写法是 `realpath(parent)` 与**没展开的** `root` 字符串比：persona 根自己经
 * junction 到达时（她的 `data` 根是 `<cwd>/data` → `<安装根>/data` 的链接），
 * parent 的真值是 `<安装根>/data/persona`、root 还是字面的 `<cwd>/data/persona` ⇒
 * **每一次都判成越界**。错的不是"要 realpath"，而是"只 realpath 了一边"。
 *
 * 现在两边走同一把尺子（`util/real-path.ts` 的 `expandRealPath`：最近的存在祖先展开 +
 * 不存在的尾段原样拼回）。**守卫一条都没削弱**：
 *   · 绝对路径 / 盘符 / `..` 上升段 / 空段：上面三条先拦（判据没动）；
 *   · 字面 resolve 后仍在根外：`isInside(root, absolute)` 照旧拦；
 *   · **真逃逸**（`personaRoot/子目录` 是指向 persona 之外的 junction、或目标文件本身
 *     是指向别处的符号链接）：展开后落在 `root` 的真值之外 ⇒ 照旧拦，措辞不变；
 *   · 目标还不存在（新建 STATE.md / 新建 RELATIONSHIPS/*.md）：对最近的存在祖先展开，
 *     "还不存在"不算越界——这一条与原来"父目录不存在 ⇒ 返回 null 放过"同义，只是
 *     现在连"祖先里有链接"也一并看穿了。
 */
function resolvePersonaPath(root: string, relative: string): { absolute: string; display: string } {
  const normalized = normalizeRelative(relative.trim());
  if (normalized === '') {
    throw new ToolArgumentError('file', 'file 不得为空');
  }
  if (isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) {
    throw new ToolArgumentError(
      'file',
      `file 必须是 persona/ 内的相对路径（例如 "STATE.md" 或 "RELATIONSHIPS/alex.md"），不接受绝对路径或盘符：${relative}`,
    );
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ToolArgumentError('file', `file 不得包含 ".." 上升段：${relative}`);
  }
  if (segments.some((segment) => segment === '')) {
    throw new ToolArgumentError('file', `file 含空路径段（重复的 "/"）：${relative}`);
  }

  const absolute = resolve(root, normalized);
  if (!isInside(root, absolute)) {
    throw new ToolArgumentError('file', `file 解析后落在 persona/ 之外：${relative}`);
  }

  // 真实路径复核（**基准根与目标都展开**）：符号链接/junction 可以把"看起来在根内"的路径
  // 指到根外，也可以把"看起来在根外"的根指回根内——两个方向都只有比真值才判得出来。
  const rootReal = expandRealPath(root);
  const targetReal = expandRealPath(absolute);
  if (!isInside(rootReal, targetReal)) {
    throw new ToolArgumentError('file', `file 的父目录经符号链接指向 persona/ 之外：${relative}`);
  }
  return { absolute, display: segments.join('/') };
}

/** 按需层判定：STATE.md 与 RELATIONSHIPS/ 下的资产是"情景层"，大小直接换算成上下文成本 */
function isOnDemandLayer(display: string): boolean {
  return display.toUpperCase() === 'STATE.MD' || display.startsWith('RELATIONSHIPS/');
}

function isProtected(display: string): boolean {
  // 看 basename：改名或换路径都绕不过（`RELATIONSHIPS/IDENTITY.md` 也拦）
  return PERSONA_PROTECTED_FILES.includes(basenameOf(display));
}

/** 是否走提案路径（`proposals/<资产>`）：判定"改哪个资产"要与"走哪条路"分开 */
function isProposalPath(display: string): boolean {
  const head = display.replace(/\\/gu, '/').split('/')[0] ?? '';
  return head.toUpperCase() === PERSONA_PROPOSAL_DIR.toUpperCase();
}

/**
 * 该不该走提案：非提案路径下直写 `STYLE.md` 一类的资产。
 *
 * 保护名单（IDENTITY/CONSTITUTION）与提案名单（STYLE）必须分开判：
 * 前者连提案都不收，后者只是不能直写。
 */
function needsProposal(display: string): boolean {
  if (isProposalPath(display)) return false;
  return PERSONA_PROPOSAL_ONLY_FILES.includes(basenameOf(display));
}

/** basename（大小写不敏感比较用） */
function basenameOf(display: string): string {
  return (display.replace(/\\/gu, '/').split('/').pop() ?? '').toUpperCase();
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 原子写：同目录 `.tmp.<pid>` → fsync → rename 覆盖。
 * persona 是不可删资产，写坏一半等于毁掉人格，所以沿用项目"绝不先删原文件"的一致纪律。
 */
async function writeFileAtomic(path: string, content: string): Promise<number> {
  const tmp = `${path}.tmp.${process.pid}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // 清理失败不影响结论：下一次写入会用同名 tmp 覆盖重建
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return Buffer.byteLength(content, 'utf8');
}

// ──────────────────────────────── 默认回投实现 ────────────────────────────────

const defaultReplyPoster: ReplyPoster = {
  async post(target, text) {
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': target.idempotencyKey,
        },
        body: JSON.stringify({ text, idempotencyKey: target.idempotencyKey }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true, status: response.status };
      return { ok: false, status: response.status, reason: `回投被拒：HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, reason: `回投失败：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

// ──────────────────────────────── 工具工厂 ────────────────────────────────

export function createAdminTools(options: AdminToolsOptions): AdminToolkit {
  const emit = options.emit;
  const timers = options.timers;
  const notifier = options.notifier;
  const replyPoster = options.replyPoster ?? defaultReplyPoster;
  const onDemandWarnBytes = options.onDemandWarnBytes ?? ONDEMAND_WARN_BYTES;
  /**
   * 回投地址的解析顺序：显式 `replyTargetOf` 优先（宿主自己懂路由），否则从当前 IM 会话派生。
   * 派生出来的 URL 是 `qq:<chatType>:<chatId>`——它把"往哪儿回"编码进 admin 的 ReplyTarget，
   * 因为那个接口只有 url 与幂等键两个字段（回投实现在通道侧解析这个 scheme）。
   */
  const replyTargetOf = options.replyTargetOf ?? derivedReplyTargetOf(options.currentWakeChannel);

  /**
   * **开口之前那一次"正在输入"**（用户 2026-10-11 拍板：「只做正在输入。speak 时触发」）。
   *
   * 位置就是全部语义：它在**第一个字出去之前**、在打字停顿之前发出去——对方先看到"正在输入"，
   * 再看到话。所以它必须在循环之前调一次，且**一次 speak 最多一次**（不是每段一条：
   * 那样对方会看到状态反复重启，而且要多花 N 次被动窗口）。
   *
   * 反过来，这条纪律同样硬：**它慢、它失败、它根本不存在，都不许影响说话**。
   * 所以这里有三层兜底，缺一层就会出现"她开口前先卡住"：
   *   ① 没配 `inputNotify`（关着开关）⇒ 立刻返回，一次网络都不发；
   *   ② 注入的实现抛异常/返回 rejected ⇒ catch 掉（这一段只值一行注释：它不改任何结果）。
   *   ③ 注入的实现**永远不 resolve**（外部代码，不可信）⇒ `INPUT_NOTIFY_HARD_TIMEOUT_MS`
   *      到点就往下走。注意 `speak` 的总预算里**不扣**这段：它最多值 5 秒，而 speak 本身
   *      `timeoutMs` 是 120 秒，扣或不扣都不改变"能不能说完"这件事（写在这里是让你知道
   *      这个数有意留白了，不是忘了）。
   *
   * 返回 void：三种结果对 speak 的处理**完全一样**（照旧说话），所以它没有"失败"这个出口。
   * 要观测"到底发没发出去"看**通道侧**那两处：`QqOfficialChannel.snapshot().inputNotify`
   * 的三个计数（attempts/sent/failed，只读、不改事件契约）与失败时那一行 `log.warn`。
   */
  const notifyTypingBeforeSpeaking = async (target: ReplyTarget): Promise<void> => {
    const poster = options.inputNotify;
    if (poster === undefined) return;
    const timerRef: { handle: NodeJS.Timeout | null } = { handle: null };
    try {
      // 结果**有意丢弃**：三种结果对这次发言的处理完全一样（照旧说话），所以这里连一个分支都没有。
      // 留痕在通道侧（`QqOfficialChannel.sendInputNotify` 的 `log.warn` 与 `snapshot().inputNotify`
      // 那两个数）——**不往事件日志里写新类型**：日志类型表（`log/types.ts`）是只读契约，
      // 这条零成本的可选动作不配在它上面开一个新事件。
      await Promise.race([
        poster.notify(target),
        new Promise<void>((resolve) => {
          // ⚠️ **刻意不 unref**（理由与 `channel/input-notify.ts` 里那个计时器逐字相同）：
          // 这一段可能发生在一次**同步流程的最前面**（没有别的活着的句柄），unref 之后事件循环
          // 会在到点之前判空退出，于是这个 Promise 永远不 settle、`speak` 卡在"开口之前"。
          // 宁可多持 5 秒的引用，也不接受"她开口前卡住"这件事有任何一条路径。
          timerRef.handle = setTimeout(() => { resolve(); }, INPUT_NOTIFY_HARD_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // 注入的实现是外部代码：它抛异常也只是"这一次没有正在输入"，一个字都不许冒泡出去
    } finally {
      if (timerRef.handle !== null) clearTimeout(timerRef.handle);
    }
  };

  /**
   * 解析发言目标（speak / report **共用一份**）。
   *
   * 两条路：不带 `to` → 回本轮叫醒她的那个会话；带 `to` → 发到指定会话。
   * sid 与回投地址**同形同源**（`replyUrlForWake` 造的也是 `qq:c2c:<chatId>`），
   * 所以这里只做合法性检查与显示名解析，真正的路由交给通道侧——一份标识两处用，
   * 不能出现"她以为发给了这个人、实际发到了另一个人"这种最难查的错。
   */
  const resolveTarget = (
    requestedTo: string,
    ctx: ToolContext,
  ): { target: ReplyTarget | null; label: string; /** v76：显式 `to` 指向的就是**本轮会话**（见下） */ atCurrent?: boolean; error?: string } => {
    if (requestedTo === '') {
      return { target: replyTargetOf(ctx) ?? null, label: '', atCurrent: true };
    }
    const parsed = parseSid(requestedTo);
    if (parsed === null) {
      return {
        target: null,
        label: '',
        error: `to 不是合法的会话标识：${requestedTo}。`
          + '会话的 sid 就在你上下文里的外部会话清单里（形如 qq:c2c:<会话 id>）。',
      };
    }
    // 显式发给"本轮叫醒她的那个会话"时，它仍然是**对那条消息的回复**——带上 msg_id 走
    // 平台的回复窗口（免费、不需权限）。发给别的会话才是真正的主动消息：那条路要权限、
    // 有配额，正是用户这次在群里撞上的那条路。
    //
    // 比较前两边都**归一**：她可能照旧写法填 `qq:group-at:<id>`（那是归一之前的形态），
    // 而系统这一侧现在一律写 `qq:group:<id>`——不归一就会把"回复当前会话"误判成"主动发消息"，
    // 于是白白多花一次带权限与配额的主动消息。归一之后两种写法都认，路由仍是同一条。
    //
    // v76：这个比较的结论**也用于回执**（`atCurrent`）：指向本轮会话时回执写「本会话」，
    // 不印那串 38 字符的 sid（审计 ③-2：回执是逐轮重发的，sid 只在她发给**别人**时才需要核对）。
    const current = replyableWakeChannel(options.currentWakeChannel?.() ?? null);
    const atCurrent = current !== null
      && normalizeSid(replyUrlForWake(current)) === normalizeSid(requestedTo);
    const passive = atCurrent && current.messageId !== '' ? { msgId: current.messageId } : {};
    return {
      target: { url: requestedTo, idempotencyKey: `turn-${ctx.turn}`, ...passive },
      label: sessionLabelOf({
        channel: channelForNamespace(parsed.namespace),
        chatType: parsed.chatType,
      }),
      atCurrent,
    };
  };

  /**
   * 降级事实那一行（回执用）：`ok: true` 且通道带回了 `note` 时才追加。
   *
   * 说的是**通道自己的形态变化**（例如 markdown 被拒、按纯文本发的），不改投递结果。
   * 正文里的 @ 写法不在这里解释——2026-10-05 起出站正文**一个字都不动**，@ 由她自己按官方
   * 形态写在正文里（docs/design.md §4.20.1），框架没有什么可替她保证的。
   */
  const degradeLineOf = (note: string | undefined): string | null =>
    note === undefined ? null : `提醒：这条的形态被降级了——${note}。`;

  const personaRootOf = (ctx: ToolContext): string =>
    options.personaRoot ?? resolve(ctx.workspaceRoot, 'persona');
  // ── write_persona ──

  const writePersona: ToolDefinition = {
    name: 'write_persona',
    description:
      '改你自己的人格资产（persona/*.md）——persona/ 唯一写通道。'
      + 'IDENTITY.md、CONSTITUTION.md 只读；STYLE.md 只能写 proposals/STYLE.md 提提案；'
      + 'STATE.md、RELATIONSHIPS/*.md 可直接写。给 content 整体替换，或给 old/new 只换那一段'
      + '（改动同样记 persona/updated）；按需层超 2KB 警告。',
    parameters: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'persona/ 内的相对路径，必须 .md，例如 "STATE.md"、"STYLE.md"、"RELATIONSHIPS/alex.md"',
        },
        content: { type: 'string', description: '整体替换：文件完整的新内容（与 old/new 二选一）' },
        old: { type: 'string', description: '局部替换：要被替换的原文（与 new 配对；唯一命中才动手）' },
        new: { type: 'string', description: '局部替换：替换后的新文本（空串 = 删掉这一段）' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 10_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'write_persona');
        const file = requiredString(args, 'file', { maxLength: 512 });

        // 两种形态二选一（P2，2026-10-04）：`content` 整体替换 / `old`+`new` 只换一段。
        //
        // 为什么必须补上第二种：实测 STATE.md 被改 87 次，其中 **62 次（71%）走的是 safe_edit**，
        // 而那条路不写 `persona/updated`、也不进人格版本库——"persona/ 唯一写通道"这句话
        // 从来没在代码里落过。她走 safe_edit 不是不守规矩，是**理性**：改一行要重吐整篇
        // 65~72 行的 STATE.md，输出贵、抄错几率大。只堵洞（见 catalog 的只读区）不加形态，
        // 等于把"审计问题"换成"质量与成本问题"，所以两件必须同批。
        const hasContent = typeof args['content'] === 'string';
        const hasOld = typeof args['old'] === 'string';
        const hasNew = typeof args['new'] === 'string';
        if (hasContent && (hasOld || hasNew)) {
          return errorResult(
            'content 与 old/new 二选一：整体替换给 content，只改一段给 old+new（两个都给我不知道你想怎样）。',
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        if (!hasContent && !hasOld) {
          return errorResult(
            '要写什么没给：整体替换给 content（完整的新内容），只改一段给 old（要被替换的原文）+ new。',
            TOOL_ERROR_CODES.invalidArgs,
          );
        }

        // 四种门（.md / 保护 / 提案）先跑完再碰盘：局部替换要读原文，但读之前就该知道
        // 这个文件到底许不许写——顺序反了，错误消息会变成"读不到"而不是"你不许改"。
        const target = resolvePersonaPath(personaRootOf(ctx), file);
        if (!target.display.toLowerCase().endsWith(PERSONA_FILE_SUFFIX)) {
          return errorResult(
            `persona 资产只接受 ${PERSONA_FILE_SUFFIX} 文件，收到 "${target.display}"。`
            + '若想记录机器可读状态，请写进 workspace/ 而不是 persona/。',
            TOOL_ERROR_CODES.unsafePath,
          );
        }
        if (isProtected(target.display)) {
          return errorResult(
            `${target.display} 是你自己的核心身份/行为宪法，对 agent 只读——写入被拒绝且不会生效。`
            + '它能被自己改写的话，一次幻觉就会把你变成别人。'
            + '如果需要调整，请在回复里说明理由，由人来编辑该文件；'
            + '你自己的状态变化写 STATE.md。',
            TOOL_ERROR_CODES.protectedTarget,
          );
        }
        // STYLE 只能由人拍板：直写被拒，但**提案**收——审批仍在人手上
        if (needsProposal(target.display)) {
          return errorResult(
            `${target.display} 由人拍板，你不能直写。想改就写成提案：`
            + `write_persona 到 ${PERSONA_PROPOSAL_DIR}/${target.display}，说清你想怎么改、为什么。`
            + '人看过觉得对，它才生效（写提案不会改动你现在的说话方式）。'
            + '另一个原因是成本：STYLE 排在上下文最前面，它每变一次，下一轮整个请求都要重新落盘一次。',
            TOOL_ERROR_CODES.protectedTarget,
          );
        }

        // 到这里才取内容：整体替换来自参数，局部替换要读盘再规划。
        // 落盘前统一字节形状（行尾 / BOM / 多余尾部空行）：人格文件不该因为"谁写的"
        // 而产生两种字节——那会让同一份内容在换人编辑后让整个请求重新落盘
        let rawContent: string;
        let editNote = '';
        if (hasContent) {
          rawContent = args['content'] as string;
        } else {
          let original: string;
          try {
            original = await readFile(target.absolute, 'utf8');
          } catch (err) {
            return errorResult(
              `${target.display} 还读不到（${toErrorMessage(err)}）。`
              + '局部替换只改已存在的文件；第一次写这个文件请用 content 给完整内容。',
              TOOL_ERROR_CODES.writeFailed,
            );
          }
          // 匹配 / 消歧 / 行号前缀防呆全部复用 safe_edit 的同一份内核（`planEdit`）：
          // 两处各写一套"找不到怎么办、多匹配怎么办"，迟早给出两种答案。
          const planned = planEdit(original, {
            mode: 'replace',
            old: args['old'] as string,
            new: hasNew ? (args['new'] as string) : '',
          });
          if (!planned.ok) {
            const where = planned.matches === undefined || planned.matches.length === 0
              ? ''
              : `\n命中 ${planned.matches.length} 处：${planned.matches.slice(0, 5).map((m) => `第 ${m.line} 行`).join('、')}`
                + (planned.matches.length > 5 ? ' …' : '')
                + '\n要改的如果不止一处，把 old 写长一点带上前后文让它唯一，或改用 content 整体替换。';
            return errorResult(
              `局部替换没动手：${planned.message}${where}`
              + '\n先 safe_read 确认原文——行首空白与换行符也算内容。',
              planned.code,
            );
          }
          rawContent = planned.text;
          editNote = `\n[局部替换] ${planned.summary}`
            + (planned.fuzzy
              ? '（走的是**缩进容错**：命中的不是逐字相同的那一段，而是缩进差 1~2 格的同一段）'
              : '');
        }
        const content = normalizePersonaAsset(rawContent);

        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > PERSONA_HARD_LIMIT_BYTES) {
          return errorResult(
            `${target.display} 有 ${bytes} 字节，超过单文件硬上限 ${PERSONA_HARD_LIMIT_BYTES}。`
            + '请精简后重写，或把长期内容拆到 workspace/ 的记忆文件里。',
            TOOL_ERROR_CODES.tooLarge,
          );
        }

        await writeFileAtomic(target.absolute, content);

        const diffHash = sha256Hex(content);
        const payload: PersonaUpdatedPayload = { file: target.display, diffHash, by: 'agent' };
        emit('persona/updated', { file: payload.file, diffHash, by: payload.by });
        options.onPersonaUpdated?.(payload);

        const warnings: string[] = [];
        if (isOnDemandLayer(target.display) && bytes > onDemandWarnBytes) {
          warnings.push(
            `已写入 ${target.display}（${bytes} 字节），超过按需层建议上限 ${onDemandWarnBytes} 字节：`
            + '它每轮都会被注入，长期偏大等于持续挤占上下文预算，建议压缩。',
          );
        }
        const head = `已写入 ${target.display}：${bytes} 字节，sha256 ${diffHash.slice(0, 16)}，已记录 persona/updated。`
          + editNote
          + (content === rawContent
            ? ''
            : '\n[已规范化] 行尾统一为 LF、去掉了 BOM 与多余尾部空行。'
              + '人格文件的字节形状要稳定，否则同一份内容换谁写都会让整个请求重新落盘。');
        return okResult(warnings.length === 0 ? head : `${head}\n[警告] ${warnings[0]}`, warnings);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.writeFailed);
      }
    },
  };

  // ── 定时器：一件工具、四个动作（v35 合并；`wait` 于 2026-10-08 补上）──
  //
  // 合并前是三件（`set_timer` / `cancel_timer` / `list_timers`），四天实测合起来只有 8 次调用
  // （set 2 / list 6 / cancel 0），却常驻 269 token（三份 name + description + schema，
  // 每一步请求都在付）。合并的根据与取舍见 docs/tools-audit.md §3.4 与 docs/design.md §4.18。
  //
  // **能力一个都不能丢**，尤其是：
  //   · `list`——她真的在用（三件里调用最多的一件）；
  //   · `cancel`——误排之后唯一的撤销出口（零调用不等于没用：删了它只剩徒手改
  //     `data/timers.json` 一条路，而那是她的核心资产）。
  //   合并的是**入口**，不是能力。
  //
  // **`wait` 是第四个动作，也是最不像"定时器"的那个**（2026-10-08 用户的口径
  // 「timer 提供一个 wait」）：她要表达的其实是"**过一会儿再叫我**"——`set` 要她自己算
  // 一个绝对时刻（还得处理时区），而那正是她一次次算错、或者干脆在原地反复 read_channel 的那件事。
  // 它与 `set` **共用同一张表、同一条唤醒路径**（`wake/timer`），区别只在于"时长"由框架算成 `at`；
  // 语义与上限写在下面对 `waitTimerAction` 的注释里。
  //
  // **名字取中性的 `timer`，不保留 `set_timer`**：动作里"设"只占一个，一件叫 `set_timer`
  // 的工具去 `list` 是名字与动作打架——她得多记一条"列定时器藏在 set_timer 底下"，而
  // `list` 恰恰是其中最常用的。中性的名词对所有动作一视同仁，也让 `action` 读起来自然。
  //
  // **判据只做一处**：`action` 是同一个枚举（下面的 TIMER_ACTIONS）、同一个必填校验
  // （readTimerAction），所有动作共用同一组参数读取（optionalString / requiredString）、
  // 同一个结果出口（okResult / errorResult）与同一个异常兜底（errorResultFromThrown）。
  // 不允许出现"几个分支各说各话"——那种不一致只有她撞上时才会被发现。
  //
  // **action 必填、没有默认动作**：这是合并带来的唯一新失败模式（少写一个字段），
  // 而"默认成 set"会让 `timer {at: …}` 这种漏写静默生效成布防。必填 + 一条说清取值的
  // 报错，比一个猜出来的默认动作安全。（她原来的习惯写法 `set_timer {at: …}` 现在会得到
  // 一句"缺少必填参数 action"，改一次就好。）

  /** 一条调用的四个动作。取值即 `action` 的枚举，报错文案也从它拼出来（不手写第二份） */
  const TIMER_ACTIONS = ['set', 'wait', 'cancel', 'list'] as const;
  type TimerAction = (typeof TIMER_ACTIONS)[number];

  /**
   * 读 `action`：**唯一的动作判据**。缺字段与非法取值分别给一句能照着改的话。
   *
   * 缺字段走 `requiredString`（"缺少必填参数 action"，与全仓其它工具同一条措辞）；
   * 非法取值单独判——`requiredString` 只保证"有个非空字符串"，而 `action=frobnicate`
   * 必须报"只能是 set / wait / cancel / list"，否则她只会看到一句语焉不详的失败。
   */
  const readTimerAction = (args: Record<string, unknown>): TimerAction => {
    const action = requiredString(args, 'action', { maxLength: 16 });
    if (!(TIMER_ACTIONS as readonly string[]).includes(action)) {
      throw new ToolArgumentError(
        'action',
        `timer 的 action 只能是 ${TIMER_ACTIONS.join(' / ')}，收到 ${JSON.stringify(action)}：`
        + 'set 布防、wait 过一会儿叫醒你、cancel 撤销、list 列出当前未触发的。',
      );
    }
    return action as TimerAction;
  };

  /**
   * 读 `wait` 的时长（秒或分）。**读不出一个正整数就当场报参数错**，不猜、不兜底。
   *
   * 猜的代价不是"差一点"：把 `0` 或 `0.5` 兜成 1 秒等于排了一次立刻唤醒，
   * 而她以为排的是半分钟——那种错只有到点之后才会发现，且看起来像"定时器不准"。
   */
  const readWaitAmount = (
    args: Record<string, unknown>,
    field: 'seconds' | 'minutes',
  ): number | undefined => {
    const raw = args[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      throw new ToolArgumentError(
        field,
        `${field} 必须是正整数（单位${field === 'seconds' ? '秒' : '分钟'}），`
        + `收到 ${JSON.stringify(raw)}——例：${field === 'seconds' ? '90' : '10'}。`,
      );
    }
    return raw;
  };

  /**
   * 读 `wait` 的"到点叫我的理由" —— **从既有的 `payload` 读，不新开一个字段**。
   *
   * 为什么不新开 `reason`（2026-10-08 的取舍，两条理由都成立）：
   *   • **它本来就是同一件事**：`set` 的 payload 一直是"到期时回注给未来的你的那个东西"，
   *     而 `render.ts` 的 `wake/timer` 渲染就是从 `payload.note` 取"到点要做什么"那一句。
   *     再开一个字段等于让同一个位置有两个名字（她还得记住"set 用 payload、wait 用 reason"）；
   *   • **工具清单是常驻开销**：多一格 schema 就是每次请求都多付一份
   *     （`test/tool-catalog.test.ts` 那条总量线上是实打实的 token）。
   *
   * 两种写法都收：**一个字符串**（最自然：`payload: "看看邮件回来没有"`）或者
   * **带 `note` 的对象**（与 `set` 的既有写法一致）。其余形状**当场报参数错**——
   * 静默丢掉理由比报错坏得多：她到点会看到一行只有 id 的 `[定时器触发]`，
   * 而以为自己写下的那句话还在。
   */
  const readWaitReason = (raw: unknown): string => {
    if (raw === undefined || raw === null) return '';
    const text = typeof raw === 'string'
      ? raw
      : typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as Record<string, unknown>)['note'] === 'string'
        ? String((raw as Record<string, unknown>)['note'])
        : null;
    if (text === null) {
      throw new ToolArgumentError(
        'payload',
        'wait 的 payload 要写一句"到点叫你的理由"：给字符串（`"看看邮件回来没有"`），'
        + `或者与 set 同形给 \`{"note":"…"}\`。收到 ${safeJson(raw)}。`,
      );
    }
    const trimmed = text.trim();
    if (charCount(trimmed) > TIMER_WAIT_REASON_MAX) {
      throw new ToolArgumentError(
        'payload',
        `wait 的理由 ${charCount(trimmed)} 字，超过上限 ${TIMER_WAIT_REASON_MAX} 字：`
        + '它进的是到点那一轮的上下文，写一句"到点做什么"就够（细节写进 STATE.md，到点再读）。',
      );
    }
    return trimmed;
  };

  /**
   * action=wait：**排一次"到点唤醒我"**（2026-10-08 用户的口径：「timer 提供一个 wait」）。
   *
   * 语义（逐条，判据都在这里）：
   *   • **不是让模型在原地等**——工具立刻返回，框架只是**在同一拍里排了一次唤醒**，
   *     她这一拍该收尾就收尾。原地阻塞会白烧步数与 token，而"反复 read_channel"正是
   *     那样烧出来的（用户报的那个现象）。
   *   • **复用既有的 timer 语义**（同一个 `TimerStore`、同一个 `wake/timer` 事件、同一条
   *     唤醒路径）：不另造一套"等待"机制，也不另建一张表。`list` 看得到它、`cancel` 撤得掉它。
   *   • **payload 只认 `note` 那一格**：`render.ts` 的 `wake/timer` 渲染就是从 payload.note
   *     取"到点要做什么"的那句话——理由给进去，她到点看见的就是它（不另写一套渲染）。
   *   • **同一会话 + 同一理由不重复布防**：判据是**定时器表本身**（`timers.list()` 里
   *     还没触发的那条），不是进程内的另一张表——重启后照样判得出来，而"叠一堆到点唤醒"
   *     恰恰是这条要防的。
   */
  const waitTimerAction = async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolHandlerResult> => {
    const seconds = readWaitAmount(args, 'seconds');
    const minutes = readWaitAmount(args, 'minutes');
    if (seconds === undefined && minutes === undefined) {
      return errorResult(
        'timer 的 action=wait 需要 seconds 或 minutes 之一（多久之后叫醒你）：'
        + `seconds 单位秒、minutes 单位分钟，上限 ${TIMER_WAIT_MAX_MINUTES} 分钟`
        + `（${TIMER_WAIT_MAX_MINUTES / 60} 小时），更远的唤醒用 action=set 带 at 或 cron。`,
        TOOL_ERROR_CODES.invalidArgs,
      );
    }
    if (seconds !== undefined && minutes !== undefined) {
      return errorResult(
        'seconds 与 minutes 二选一：它们是同一个时长的两种单位，两个都给我不知道按哪个算。'
        + '本次没有布防。',
        TOOL_ERROR_CODES.invalidArgs,
      );
    }
    const totalSeconds = seconds ?? (minutes as number) * 60;
    const durationText = seconds === undefined
      ? `${minutes} 分钟`
      : seconds >= 120 ? `${seconds} 秒（约 ${Math.round(seconds / 60)} 分钟）` : `${seconds} 秒`;
    if (totalSeconds / 60 > TIMER_WAIT_MAX_MINUTES) {
      return errorResult(
        `wait 的时长 ${durationText}，超过上限 ${TIMER_WAIT_MAX_MINUTES} 分钟`
        + `（${TIMER_WAIT_MAX_MINUTES / 60} 小时）：那是"排一个远期闹钟"，用 action=set 带 at`
        + '（带时区的 ISO 8601）或 cron 排更合适。本次没有布防。',
        TOOL_ERROR_CODES.invalidArgs,
      );
    }
    const reason = readWaitReason(args['payload']);
    // "同一会话"的判据与 speak 的隐式目标**同一条派生路**（不另造一套"当前会话"的算法）：
    // 没有可回投的会话时是 null（本机/心跳那一拍），那时按"没有会话"这一档去重。
    const sid = replyTargetOf(ctx)?.url ?? null;
    const existing = timers.list().find((entry) => {
      const wait = timerWaitPayloadOf(entry.payload);
      return wait !== null && wait.sid === sid && wait.note === reason;
    });
    if (existing !== undefined) {
      // 如实说"已经有一个到点唤醒了"，**不叠第二条**：她要的是"到点叫我"这件事成立一次，
      // 而不是排 N 个一样的闹钟（到点会被连着叫 N 次，每一次都是一整轮 turn）。
      return okResult(
        `已经有一个到点唤醒了：id=${existing.timerId}，到点 ${existing.at}`
        + (reason === '' ? '' : `，理由「${reason}」`)
        + `——同一个${sid === null ? '理由' : '会话、同一个理由'}不重复布防，本次没有新增。\n`
        + `要改时间就先 action=cancel（timer_id=${existing.timerId}）再 wait；`
        + '要看现在排了什么用 action=list。这一拍照旧收尾就行。',
      );
    }
    // "现在"只有一处：排定时器的那个时钟（`TimerStore.nowMs`，见那里的注释）
    const at = new Date(timers.nowMs() + totalSeconds * 1000).toISOString();
    const payload: TimerWaitPayload = { kind: TIMER_WAIT_PAYLOAD_KIND, note: reason, sid };
    const result = await timers.set({ at, payload });
    if (!result.ok) {
      return errorResult(`定时器未布防：${result.error}`, TOOL_ERROR_CODES.invalidArgs);
    }
    const entry = timers.get(result.id);
    const due = entry === null ? at : entry.at;
    return okResult([
      `到点唤醒已排好：id=${result.id}，${durationText}之后（${due}）以 wake/timer 唤醒你。`,
      reason === ''
        ? '到点你看到的是那一行 [定时器触发]（这条没写理由，只有 id 可认）——'
          + '想留下"到点要做什么"就把那句话填进 payload，它会原样出现在那一行。'
        : `到点你会看到：[定时器触发] ${reason}（计划时刻 ${due}）——那时接着做。`,
      '**这一拍不用等**：现在就收尾（它是框架在同一拍里排的一次唤醒，与心跳、外部事件'
      + '走的是同一条唤醒路径——到点正常叫醒你，不是让你在这里守着）。',
      `撤销用 action=cancel 加 timer_id=${result.id}；看当前排了什么用 action=list。`,
    ].join('\n'));
  };

  /** action=set：布防（at 一次性 / cron 周期，两者给定时以 at 为准——TimerStore 的既有语义） */
  const setTimerAction = async (args: Record<string, unknown>): Promise<ToolHandlerResult> => {
    const at = optionalString(args, 'at', { maxLength: 64 });
    const cron = optionalString(args, 'cron', { maxLength: 128 });
    if (at === undefined && cron === undefined) {
      return errorResult(
        'timer 的 action=set 需要 at 或 cron 至少一个：at 做一次性定时（带时区的 ISO 8601），'
        + 'cron 做周期定时（五段）。只想看现在有哪些定时器就用 action=list。',
        TOOL_ERROR_CODES.invalidArgs,
      );
    }
    const input: TimerSetInput = {
      ...(at === undefined ? {} : { at }),
      ...(cron === undefined ? {} : { cron }),
      ...(args['payload'] === undefined ? {} : { payload: args['payload'] }),
    };
    const result = await timers.set(input);
    if (!result.ok) {
      return errorResult(`定时器未布防：${result.error}`, TOOL_ERROR_CODES.invalidArgs);
    }
    const entry = timers.get(result.id);
    const due = entry === null ? '（表项缺失）' : entry.at;
    const kind = cron === undefined || at !== undefined ? '一次性' : `周期（${cron}）`;
    // 回执自检（v59，用户「set 的回执要能自检」）：排完把**她会写错的那几格**照实回显——
    // 标题 / 时刻（周期）/ 分类 / 是否上日程页。缺格不报错（旧形状照旧），只是把缺省口径说白。
    const stored = entry === null ? undefined : entry.payload;
    const title = payloadStringField(stored, 'title');
    const cat = payloadStringField(stored, 'cat');
    const ownerFacing = isOwnerFacingTimer(stored);
    return okResult([
      `定时器已布防：id=${result.id}，${kind}，下次到期 ${due}。`,
      `自检——标题：${title === '' ? '（没写，日程页用"到点做什么"的第一句）' : title}`
      + ` · 时刻：${due}（${kind}）`
      + ` · 分类：${cat === '' ? '（没写，日程页不涂色）' : cat}`
      + ` · ${ownerFacing
        ? '上日程页的周历（替用户记的那一类）'
        : '不上日程页的周历（你自己的内部事）'}`,
      '撤销用同一条工具的 action=cancel 加这个 id。',
    ].join('\n'));
  };

  /** action=cancel：按 id 撤销。id 不在表里不算错（可能已触发/已取消），但要给出下一步 */
  const cancelTimerAction = async (args: Record<string, unknown>): Promise<ToolHandlerResult> => {
    const timerId = requiredString(args, 'timer_id', { maxLength: 200 });
    const removed = await timers.cancel(timerId);
    if (!removed) {
      return okResult(
        `定时器 ${timerId} 不在表里（可能已触发、已被取消或 id 不对）。`
        + '用同一条工具的 action=list 看当前有哪些。',
      );
    }
    return okResult(`定时器 ${timerId} 已取消并从表里移除。`);
  };

  /** action=list：列出未触发的（含周期条的下一拍），按到期先后——每行都带 id，撤销要用它 */
  const listTimersAction = (args: Record<string, unknown>): ToolHandlerResult => {
    // 这个动作没有自己的参数；多给的字段照旧不认（additionalProperties:false 是 schema 那一侧的事，
    // 这里只确认入参是个对象——判据与另外两个动作同一条入口）
    void args;
    const entries = timers.list();
    if (entries.length === 0) {
      return okResult(
        '当前没有任何未触发的定时器。布防用同一条工具的 action=set（at 一次性 / cron 周期）；'
        + '只想"过一会儿叫我"就用 action=wait（seconds/minutes + reason）。',
      );
    }
    // 回执分两类、用户向的在前（v59，用户「list 的回执要能分辨两类」——她的判断依赖它：
    // 日程页的周历只画用户向的，所以"哪些是给用户的"必须在 list 里一眼看得出，不改任何参数）
    const ownerFacing = entries.filter((entry) => isOwnerFacingTimer(entry.payload));
    const mine = entries.filter((entry) => !isOwnerFacingTimer(entry.payload));
    const blocks = [
      `定时器 ${entries.length} 个（用户向 ${ownerFacing.length} 个在前，你自己的 ${mine.length} 个在后）：`,
    ];
    if (ownerFacing.length > 0) {
      blocks.push(`【给用户的】（日程页的周历会画它们）\n${ownerFacing.map(describeTimer).join('\n')}`);
    }
    if (mine.length > 0) {
      blocks.push(`【你自己的事】（不上日程页的周历）\n${mine.map(describeTimer).join('\n')}`);
    }
    blocks.push('撤销用 action=cancel 加那一行的 id。');
    return okResult(blocks.join('\n'));
  };

  const timer: ToolDefinition = {
    name: TIMER_TOOL_NAME,
    // <60 token（那条收紧线钉着这一件，见 test/tool-catalog.test.ts）：四个动作一句一个，
    // list 列出什么、cancel 拿什么去撤都写在这份说明书里——她看到的就是这一份。
    //
    // **上限那个数、单位、理由怎么写都不写在这里**：总描述是常驻前缀，而"上限是多少、
    // 理由填哪个字段"她只在真去排 `wait` 时才需要——它们写在 `seconds` / `minutes` /
    // `payload` 的参数描述里（参数不进单件描述那份预算，而她两处都看得到：schema 与描述一起进清单）。
    // 同一条纪律见 `read_channel` 的瘦身记录（那件 98/100 距硬门只剩 2 token 的教训）。
    description:
      '定时器：到点以 wake/timer 唤醒你自己（不是提醒用户）。action 四选一：'
      + 'set 布防（at 一次性 / cron 周期）；wait 定时叫醒你；'
      + 'list 列出未触发的（带 id）；cancel 按 id 撤销。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...TIMER_ACTIONS],
          description: 'set 布防 / wait 定时叫醒你 / cancel 撤销 / list 列出未触发的',
        },
        at: { type: 'string', description: 'set：带时区的 ISO 8601 绝对时刻，例 2026-09-30T14:00:00+08:00' },
        cron: { type: 'string', description: 'set：五段 cron（分 时 日 月 周），例 "0 9 * * 1-5"' },
        payload: {
          // 三格约定（v55，2026-10-13）：`set` 的 payload 今天**没有形状**，而 render / list / GUI
          // 三处只读 `note` 一格 ⇒ "为什么排它"与"到点跟谁说"都没有约定。这一句把三格点明，
          // **不加字段、不加参数、不改四个动作的语义**（判据与逐字见 self-brief.ts 的
          // `PAYLOAD_SHAPE_TEXT`，它进的是 `instructions`，与这里**同批**上线）。
          // 再补四格（v57，2026-10-12）：日程页要画"周历的块 / 清单的分类与状态 / 计数卡"，
          // 而投影里只有 `at`/`cron` + 上面那三格 ⇒ 缺的几样**只能由约定补**。同样**只改描述**：
          // 四格都是 `payload` 这个自由 JSON 里的键——不改事件形状、不加参数、不改四个动作的语义。
          // 缺省口径（GUI 侧照它退化，写在这里是为了让她与人看到同一份约定）：
          // `title` 缺 ⇒ 用 `note` 第一句；`cat` 缺 ⇒ 不涂色、不摆分类；`dur` 缺 ⇒ 30 分钟；
          // `action` 缺 ⇒ 不当"自主工作"计。
          // 第五格 `scope`（v59，2026-10-12 用户的裁决「GUI 是给人看的，agent 自己的行动不该占主位」）：
          // 日程页的**周历只画用户向的条目**，所以这一句要教她"什么时候算给用户的"——判据一句话
          // 写在末尾（`isOwnerFacingTimer` 就是照它实现的，两边同批）。**仍然只改描述**。
          // ⚠ 长度纪律：`tools` 段是常驻前缀，**硬门是 `registry.catalogTokens` 那条线**（上界 5500，
          // `test/tool-catalog.test.ts`）；这一句用中文短语，不写"到期时回注……"这类说明书句。
          description: 'set：why（为什么排它）、note（到点做什么）、sid（到哪儿说）、title（一行标题）、'
            + 'cat（工作学习/陪伴交流/生活习惯/周期）、dur（分钟）、action（自主工作/提醒/存草稿）；'
            + '替用户记的（提醒他/约好的事）不写 scope；你自己要做的（记忆整理、复盘、自检）写 '
            // ⚠ 引号形状与提示词那条线**同形**（`scope:'self'`，单引号）：同一个键在两边写成两种引号，
            // 她读起来会以为是两个不同的键（用户 2026-10-12 的统一；只改这一处引号，别的一个字不动）
            + "scope:'self' 就不上日程页的周历。判据：这条是替用户记的，还是我自己要做的。"
            + 'wait：写一句"到点叫你的理由"（字符串）',
        },
        seconds: { type: 'number', description: 'wait：时长，单位秒（与 minutes 二选一）' },
        minutes: {
          type: 'number',
          description: `wait：时长，单位分钟（与 seconds 二选一；`
            + `最长 ${TIMER_WAIT_MAX_MINUTES} = ${TIMER_WAIT_MAX_MINUTES / 60} 小时，更远的用 set 带 at/cron）`,
        },
        timer_id: { type: 'string', description: 'cancel：要撤的那个 id（各动作的回执里都有）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        // 一处入口：参数是对象 → 读出动作 → 分派。四个动作的结果形状因此完全一致
        const args = argsRecord(rawArgs, TIMER_TOOL_NAME);
        const action = readTimerAction(args);
        if (action === 'set') return await setTimerAction(args);
        if (action === 'wait') return await waitTimerAction(args, ctx);
        if (action === 'cancel') return await cancelTimerAction(args);
        return listTimersAction(args);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── speak ──

  const speak: ToolDefinition = {
    name: 'speak',
    description:
      '跟人说话用这个：整段交给它，自动断句发出去。'
      + 'text 必填；要发给别的会话就带 to（sid 见外部会话清单）。例：{text:"在呢"}',
    // 描述不许写长：它进 tools 那一段（请求的缓存前缀），且 `tool-catalog` 有一条
    // **<60 token** 的硬线（本轮口径，与另外六件一起算）。所以分段的细则
    // （顿号不断、成对符号里不断、不足 12 字整段一条）**只写在 `chat-split.ts` 里**，
    // 不往这里塞——那些是她写标点时自然就会写对的规则，不需要她背。
    //
    // **"口语化、允许残缺/倒装/省略"那一句放在 `text` 参数的描述里**（参数不进那份 <60 预算，
    // 这是既有先例）：那句话要说清"这是聊天消息、可以不成句"，两三句才够，塞进总描述会顶破线。
    // 但"**聊天用、不是写正式句子**"这半句必须留在总描述里——她读的第一句就是它。
    //
    // **两个数都由常量拼进来**（`SPEAK_TEXT_SUGGESTED_MAX` 与 `SPEAK_TEXT_MAX`），不许在描述里
    // 手写：描述与判据必须同源。建议线同时是**说话风格目标**（用户定的 25 字、短句、像打字聊天），
    // 不是从实测分布里挑的分位数——别照着日志里的 p90 把它放宽（那一版被纠过，见该常量的注释）。
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            '要说的内容，一句话（自动断句，不必自己拆）。聊天消息：短、口语，'
            + '允许残缺/倒装/省略。'
            + `超 ${SPEAK_TEXT_MAX} 字直接退回（不截断）；长内容用 report。`,
        },
        to: {
          type: 'string',
          // **这里只说"发给谁"**：平台侧的主动/被动、权限、配额那一类机制**不进描述**
          // （2026-10-07 用户的口径：那是过时知识，"本来就不需要知道"）。理由有两层：
          //   ① 它是**通道专属**的，而这里的话对每条通道一起说——OneBot 上"要权限、有配额"
          //      这句是假的（那边发一条就是一条普通消息），她照它行事会少说该说的话；
          //   ② 发不出去时**回执本来就会如实说清原因**，不需要她在动手之前先背一套平台政策。
          // 改这里要连带看 `send_media` 的描述与 self-brief 第 ④ 段（同一件事的三处落点）。
          //
          // v74（R5）：删掉"发不出去时回执会说清原因"那半句——它是**回执的承诺**，不是这个
          // 参数的用法；参数格只回答"填什么"。`to` 本身**绝不能删**（发到指定会话必须有它）。
          description:
            '发给哪个会话（sid 见外部会话清单）；省略 = 回到本轮叫你说话的那个会话。',
        },
        level: {
          type: 'string',
          enum: ['info', 'warn', 'critical'],
          description: '推送级别，默认 info',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    // 120s：里面按人打字的节奏等（一趟最多 90s），再加三路投递的网络时间
    timeoutMs: 120_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'speak');
        const text = requiredString(args, 'text', { maxLength: SPEAK_TEXT_HARD_MAX });
        // **硬门（`SPEAK_TEXT_MAX` 40）：超过就退回，一个字不发。** 用户 2026-10-05 的口径。
        //
        // 拒绝而不是截断：截断过的那半句照样发出去，人读到的就不是她想说的那句了；把它退回去，
        // "重说 / 拆几次 / 改用 report"这三个决定仍在她手里。所以文案给全三条路，并把**收到多少字**
        // 如实报出来（她据此才知道要砍掉多少）——这是"拒绝必须给模型明确的下一步"那条纪律
        // （design.md §4.10）在这一处的落点。
        //
        // 位置刻意在**解析目标之前**：一句话超了门就没有"该不该发、发给谁"的问题了，先判它
        // 才不会白算一轮；也保证被拒时日志里一个字都没落（截断或提醒后照发都做不到这一点）。
        if (charCount(text) > SPEAK_TEXT_MAX) {
          /**
           * 超限回执（2026-10-16 压缩）：**保留**三件她据此行动的事——收到多少字、上限是多少、
           * 三条出路；压掉的是展开的形容（"聊天不必是完整句子，口语、残缺、倒装、省略都行"
           * 那一串与 `text` 参数说明重复；"正式内容允许长、Markdown 原样保留、不按标点切"
           * 与 `report` 的描述重复）。回执每次调用都进上下文，重复的解释只留一处。
           *
           * ⚠ **总描述（`speak.description`）一个字没动**：它在 `tools` 那一段（缓存前缀），
           * 而且离 `<60 token` 的硬门只剩几 token——回执不在那份预算里，压缩只落在这里。
           */
          return errorResult(
            `这段 ${charCount(text)} 字，超过 speak 的上限（一次至多 ${SPEAK_TEXT_MAX} 字）——`
            + '一个字都没发出去。三条路挑一条：\n'
            + `- 压缩成更短的一句（往 ${SPEAK_TEXT_SUGGESTED_MAX} 字左右收）；\n`
            + '- 拆成几次调用：一次说一件事；\n'
            + '- 内容本来就长：改用 report。',
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        // v74（用户 2026-10-20 的最终口径）：越线不再单独追一句"提醒"——回执的两种成功态里
        // 已经写着 `成功，但超25字限制（N 字）`，再追一段解释就是**同一件事说两遍**（而这条
        // 回执是最高频、会被后续 160 多个请求反复读回的一行）。"写短"的指导搬进了
        // `SELF_BRIEF` §2.1 与工具描述（她发之前就能看到），不再靠事后叨叨。
        const level = readNotifyLevel(args);
        const chars = text.length;
        const lines: string[] = [];

        // 目标先解析：它决定这个循环里除了落日志之外还要不要发 IM。
        //   • 不带 `to`：回**本轮叫醒她的那个会话**（有就发，没有就如实说跳过）
        //   • 带 `to`：发到指定会话。指向本轮之外时，通道侧自然走主动消息（QQ 有配额）
        //
        // 解析放在最前面而不是投递前：非法 sid 是明确的参数错误，当场报错、一个字不发
        // （旧代码先花完几十秒打字节奏、把话落进对话流，最后才报"sid 非法"——
        //  那既浪费，又会把本想发给别人的私话留在本机对话流里）。
        const requestedTo = typeof args['to'] === 'string' ? args['to'].trim() : '';
        const resolved = resolveTarget(requestedTo, ctx);
        if (resolved.error !== undefined) {
          return errorResult(resolved.error, TOOL_ERROR_CODES.invalidArgs);
        }
        const target = resolved.target;
        const targetLabel = resolved.label;

        // 第一路 + 第三路：**同一个循环、同一个节奏**。
        //
        // 为什么要合在一起（实测踩过）：拆成两遍循环时，第一遍把 sleep 全花在了日志上，
        // 第二遍才连着 POST 出去——界面上是一条条往外蹦，QQ 那边却是等 speak 快结束了
        // 才一股脑涌出来，两路的时间轴完全错位。IM 上的"打字感"必须和界面同源，
        // 否则同一次发言在两个人眼里是两种样子。
        //
        // 等的时长 = **待发送那一段**的字数 ÷ 打字速度：想成「这条我得打 N 秒才打得完」，
        // 打完才发出去。**第一段也等**——她按下的不是"发送"，是"开始打字"。
        //
        // 说话期间人又开口了（`ctx.interrupt`）就立刻停：已经发出去的收不回来，没发的
        // 一段都不发，并在回执里如实告诉她——那条回执是给她重新组织语言的依据。
        // **分段照旧**：一次发言切成几条、按打字节奏一条条发（`chat-split.ts` 认逗号与句号，
        // 成对符号与代码块有保护、不足 12 字整段一条——细则全在那个模块里，这里不重写一套）。
        // 已经没有"超过多少字就不分段"这回事了：用户 2026-10-05 取消了那条 45 字的口径，
        // 超长改由上面的硬门（`SPEAK_TEXT_MAX` 40）直接拒绝——**门在进 speak 之前**，
        // 走到这里的文本一定在门内，于是"切不切"只剩"该怎么切"。
        const segments = splitForChat(text);
        // **正文原样出站**：一个字都不改、一段都不拦（2026-10-05 用户决定移除"名字 → openid →
        // 官方 @ 串"那一层，原话「我觉得没必要存在」，理由见 `channel/qq-official.ts` 文末那段
        // 注释与 docs/design.md §4.20.1）。`[@1 号]` 这种写法就是普通文字：**照发**——那层便利
        // 曾经因为一个读表路径错误把她整条消息卡住过，一个字都没出去。
        //
        // 本地那份记录也是她的原话（`message/assistant` 与 `speak/sent` 都不动）：
        // 现在连投递走的都是同一份字节，`read_channel` 读回来的与群里看到的一字不差。
        const typing = options.speakTyping ?? DEFAULT_SPEAK_TYPING;
        const perCharMs = typing.typingEffect ? 60_000 / typing.charsPerMinute : 0;
        /** 这一条投递回执的归并键：`read_channel` 按它把一次 speak 归成一行（见 SpeakSentPayload） */
        const spokenKey = { callId: ctx.callId, turn: ctx.turn };
        // 本次发言的插话基准：取的是"我开口那一刻"的计数，之后只有**又**有人开口才算被打断
        const epochOf = ctx.interruptEpoch;
        const probe = epochOf === undefined ? null : { epoch: epochOf, start: epochOf() };
        let waitedMs = 0;
        let sent = 0;
        let emitted = 0;
        let interrupted = false;
        /** IM 那一路的失败原因（null = 没失败）；一旦失败就不再试后面的段，但日志照落 */
        let imFailure: string | null = null;
        /**
         * IM 那一路**真的送成了**的那几段（原样拼起来）。
         *
         * 为什么要攒：这条路的凭据只有一条（"她说出去过"是一个事实，不是 N 个），所以整段/被打断
         * 两个出口都是"发完之后写一条"（见 `deliverToSession`）。攒的是**真送成的那些段**而不是
         * `text` 原文——与 speak"读回来的是那边实际收到的字节"那条口径一致。正常跑完时它就是
         * 整段；中途失败/被打断时它是"收不回来的那半截"（**不补**失败之后没发的那些）。
         */
        const deliveredSegments: string[] = [];
        /**
         * 送出去的那几段**在平台上的 id**（与 `deliveredSegments` 逐个对齐、只记拿得到的）。
         *
         * 为什么要它：`read_channel` 的 `（我）`那一行要能回答"这一行对应平台上哪条"——
         * 少了它，她**删不掉"自己刚发的那条"**（`delete_msg` 只认平台 `message_id`）。
         * 实测凭据是事件 77386（T1308/S1）她自己的话：「我发出去的消息——speak/sent 事件里
         * 没有 messageId」。攒的是**真送成的那些段**（与文本同一个口径），
         * 通道给不出 id 的段不占位——所以两个数组**只保证"顺序一致"，不保证等长**。
         */
        const deliveredMessageIds: string[] = [];
        /**
         * 这一整段话要记的那**一个** id（`read_channel` 里这一段只占**一行**，而一行只有一个行尾位置）。
         *
         * 取**第一条**（不是最后一条）：那一行是"她这一段话"，而"她开口的第一条"是这一行最
         * 自然的锚（要撤这一段，从它撤起）。**同一段被切成 N 条气泡时这是刻意的选择**，
         * 不是漏取——`spokenParts` 已经把"其实是 N 条"说清了。
         *
         * 为什么返回的是"可以径直 `...` 的键对象"而不是裸 `string | undefined`：本仓开着
         * `exactOptionalPropertyTypes`，而 `{ messageId: someStringOrUndefined() }` 的类型是
         * `{messageId: string | undefined}`——那个 `undefined` **不满足** `messageId?: string`，
         * 编译期就红。所以"没有"必须表达成**整个键缺席**，不能表达成"键在、值是 undefined"。
         */
        const deliveredIdKey = (): { messageId?: string } => {
          const id = deliveredMessageIds.find((value) => value !== '');
          return id === undefined ? {} : { messageId: id };
        };
        /** IM 那一路带回来的降级提醒（形态变了，但话发出去了）：要进回执 */
        let imNote: string | null = null;
        /** 一段都没开始发之前不许取消——见循环开头那段说明 */
        let started = false;
        // **开口之前那一次"正在输入"**：一次 speak 至多一次，且在第一个字出去之前
        //（在打字停顿之前）。它绝不改变这次发言的结果——见 `notifyTypingBeforeSpeaking`。
        // 两个条件缺一不可：有目标（没目标就没有会话可显示状态）且**真打算说话**
        //（走到这里说明过了硬门、目标也合法）。被硬门退回的那次一个字都不发，
        // 那就不该先亮一个"正在输入"再什么都不说。
        if (target !== null && segments.length > 0) await notifyTypingBeforeSpeaking(target);
        for (let index = 0; index < segments.length; index += 1) {
          const segment = segments[index]!;
          // 每段开头都回头看一眼"他是不是又开口了"，而不是只在等待里看。
          //
          // 两个**零等待**的口子必须一起堵上：① `typingEffect=false`（等待全为 0）；
          // ② 一趟总预算 90s 用尽之后剩下的段不再等（`waitedMs < SPEAK_TOTAL_BUDGET_MS` 不成立）。
          // 那两个口子上，人插话进来她照样会把后面几段一口气吐完——节奏拦不住，只有这道显式的
          // 判断能拦。判据与轮流询**完全同源**（同一个计数、同一个基准），不会多打断一次。
          //
          // 第一段之前不判（`started`）：计数若在"决定说这段话"之前就变了，那说明这次打断发生在
          // 她开口之前——她还一个字都没出去，该不该说由她想。语义始终是"开口之后又来插话"。
          if (started && probe !== null && probe.epoch() !== probe.start) {
            interrupted = true;
            break;
          }
          if (perCharMs > 0 && waitedMs < SPEAK_TOTAL_BUDGET_MS) {
            const wait = Math.min(SPEAK_MAX_DELAY_MS, Math.round(segment.length * perCharMs));
            if (wait > 0 && waitedMs + wait <= SPEAK_TOTAL_BUDGET_MS) {
              const completed = await sleepUnlessInterrupted(wait, probe);
              waitedMs += wait;
              if (!completed) {
                interrupted = true;
                break;
              }
            }
          }
          // 可见性**必须显式给**（2026-10-11 修的一处静默失效）：`message/assistant` 在 schema
          // 表里是 model，而工具侧写入点省略可见性时会落成 internal ⇒ 她说过的话在历史里没有
          // 独立形态（请求体里只剩 `speak` 那次 function_call 的参数，那不是"我说过什么"的形态）。
          emit('message/assistant', { text: segment, toolCalls: [] }, defaultVisibility('message/assistant'));
          emit('speak/sent', { channel: 'log', chars: segment.length } satisfies SpeakSentPayload);
          emitted += 1;
          started = true;
          // IM 紧跟同一段：本地先落（那一跳永远可用），再发出去（那一跳可能失败）。
          // 发出去的就是这一段本身——逐字节原样，与上面那条日志同一份字节。
          if (target !== null && imFailure === null) {
            const outcome = await replyPoster.post(target, segment);
            if (outcome.ok) {
              sent += 1;
              deliveredSegments.push(segment);
              // 平台回的 id 一并攒下来（通道给不出时是 undefined ⇒ 这一段不占位）
              if (outcome.messageId !== undefined && outcome.messageId !== '') {
                deliveredMessageIds.push(outcome.messageId);
              }
              // 降级事实（例如 markdown 没权限、按纯文本发的）只在回执里说，不改投递结果
              imNote = degradeLineOf(outcome.note) ?? imNote;
            } else imFailure = outcome.reason;
          }
        }

        // 被打断：把"已经说了什么、什么没说"如实摆出来，再说清那不是故障
        if (interrupted) {
          const spoke = options.userSpoke?.() ?? null;
          // 销账：她是**因为看见这条**才被打断的，把它补记进本轮认领账——不记，它就一直
          // 留在待办里，下一轮被重新认领、同一个问题再答一遍（docs/review.md「未了结」）。
          // **只在这个分支里销账**：没被打断说明她没看见它，销了等于把那条消息整个吞掉。
          if (spoke !== null) ctx.claimInterruption?.(spoke.wakeSeq);
          // **已经吐出去的那几条，照样是"她说出去的话"**：收不回来，read_channel 里就该有
          // ——不记的话她会以为自己没说（而群里已经看到了）。只记送成的那些（`sent`），
          // 一个字都不多记；一条都没送成（本地那几段不算"发到那个会话"）就不写这条回执。
          if (target !== null && sent > 0) {
            emit('speak/sent', deliverToSession({
              sid: target.url,
              // 字数按中文计字口径（`charCount`：一个 emoji 算一个）——与整段那条回执同一个算法
              chars: charCount(deliveredSegments.join('')),
              // 攒下来的就是**真送成的那几段**（不补失败之后没发的那些）
              text: deliveredSegments.join(''),
              parts: sent,
              // 这一段的平台 id（拿得到就带；一行只放一个，见 firstMessageIdOfDelivered）
              ...deliveredIdKey(),
              ...spokenKey,
            }) satisfies SpeakSentPayload);
          }
          const said = segments.slice(0, emitted).join('／');
          const unreleased = segments.slice(emitted);
          return okResult([
            spoke === null ? '发言被打断：他刚发来新消息。' : `发言被打断：他刚说「${spoke.text}」。`,
            `- 已经发出去的（收不回来了）：${emitted === 0 ? '一条都没发' : `${emitted} 条——${said}`}`,
            `- 没来得及发的（${unreleased.length} 条）：${numberedUnreleased(unreleased)}`,
            ...(imNote === null ? [] : [`- ${imNote}`]),
            '别把剩下这半截硬接上去。先看他新说的是什么，重新组织语言再开口。',
          ].join('\n'));
        }

        // 2026-10-20（R4）：这里原来还有一行
        // `日志/前端：按聊天节奏发成 N 条（共 N 字，间隔共等 Ns）`，已删。
        // 它是**机械复述**：段数在下面「投递：已送达 …（N 条）」里、字数在锚点那句
        // 「全文 N 字」里（同一把中文计字尺），「间隔共等 Ns」是打字节奏——没有任何一条
        // 能改变她的下一步。删它一条判据都没少（审计 R4：命中 89.4% 的 speak 回执）。
        // ⚠ 别顺手把「投递成功（不必重复发送）」当同类删掉：那一句是 2026-10-08 用户
        // 逐字点名要的判据（`SENT_CREDENTIAL_NOTE`），属 R1，要删得用户改口径。

        // 第二路：主动推送。**合并成一条**——告警出口逐条推会刷屏。
        //
        // v74（用户 2026-10-20 的最终口径）：**成功回执只留"发出去了"这件事本身**——
        // 出口没配时**一个字都不印**（"推送：跳过"也不印：成功的那一行只该回答"到没到"）；
        // 出口配了且送达也不印（成功是常态）；只有**推送失败**才多一行（失败是最需要信息的时候）。
        if (notifier !== undefined) {
          const outcome = await notifier.send({ level, title: 'Irmia 发言', body: text });
          if (outcome.ok) {
            emit('speak/sent', { channel: 'notify', chars } satisfies SpeakSentPayload);
          } else {
            lines.push(`推送失败：${outcome.reason}`);
          }
        }

        if (imFailure !== null) {
          // 失败：**一条信息一行**（用户 2026-10-20 的口径）。这里只留**最关键那一条**：
          // 失败 + 已经出去几条（收不回来的数）+ 平台原话 + 下一步该不该再试。
          // 不再复述"第 N 条起未发出（共 M 条）"那套流程，也不再单起一行说"本机那份只是记录"
          // ——"失败：…"本身就把"外面没到"说死了（代价：那句旧警告不在回执里了，
          // 但它从来不是判据，判据是"失败 / 不必重试"）。
          lines.push(`失败，${speakFailureReason(imFailure, sent, segments.length)}`);
        } else if (target === null) {
          // 说清"跳过的只是 IM 那一跳"：话已经落在对话流里，别让她读成"整条发言失败了"——
          // 实测她读到旧措辞（"本轮无回投地址，跳过"）后以为他收不到，把同一句再说四遍。
          // 与 `report` **同一句**（`localOnlyNote` 里记着为什么这一段不许写"不必重复发送"）。
          lines.push(localOnlyNote('发言'));
        } else if (sent === segments.length) {
          // 三路都发完，逐段落的都是"本机对话流"那份回执；这一条是**IM 那一路走通了**的凭据
          // ——补上整篇文本与段数，`read_channel` 才能把"她在这个会话里说过什么"读回来
          //（逐段的 `message/assistant` 里没有会话坐标，见 log/types.ts 的 SpeakSent.text）。
          //
          // 文本取**实际发出去的那几段拼起来**（不是 `text` 原文）：切分会摘掉逗号句号、
          // 还可能化开破折号，所以"她说的"与"发出去的"不是一个字节串。这里记的是后者
          // ——read_channel 要回答的是"那边到底收到了什么"。代价是相邻两句之间没有标点
          //（原句的句号被摘了），读起来是连着的；宁可她读到自己那口气的原样，也不替她补一个
          // 她没打过的标点（那是往"她说过的话"里加字）。
          const deliveredText = deliveredSegments.join('');
          emit('speak/sent', deliverToSession({
            sid: target.url,
            chars,
            text: deliveredText,
            parts: segments.length,
            // 整段跑完：id 是这一整段第一条气泡的（见 firstMessageIdOfDelivered）
            ...deliveredIdKey(),
            ...spokenKey,
          }) satisfies SpeakSentPayload);
          // v74（用户 2026-10-20 的**最终口径**）：成功回执按**她发出去的正文长度**分两态，
          // 除此之外**一个多余字都不印**：
          //   · 正文 ≤25 字 ⇒ `发送成功`（就这四个字）；
          //   · 正文 >25 字 ⇒ `成功，但超25字限制（N 字）`——**不是失败**，只是告知；
          //   · 不印坐标、不回显正文、不印"不必重复发送"、成功时不印"主动推送：跳过"。
          // "25 字"这条写进了 `SELF_BRIEF` §2.1 与 `speak.description`（她**发之前**就知道该写短）
          // ——回执是最高频、且会被后续 160 多个请求反复读回的一行，规矩写在前两处只付一次。
          // 字数按 **runes**（Unicode 字符）数：中文一个字算 1，emoji 也算 1，不是字节、不是 token。
          const bodyChars = [...text].length;
          lines.push(bodyChars <= SPEAK_TEXT_SUGGESTED_MAX
            ? '发送成功'
            : `成功，但超${SPEAK_TEXT_SUGGESTED_MAX}字限制（${bodyChars} 字）`);
        }
        // 降级提醒单独一行，且**排在投递结论之后**：先答"发没发出去"，再答"发成什么样"。
        // 它只在通道明确带回降级事实时出现（例如 markdown 被拒、按纯文本发的）——
        // 没发生就一个字都不写，免得每一条发言都缀一句"形态正常"的噪音。
        if (imNote !== null) lines.push(imNote);
        // 抬头「发言已处理：」已删（R4）：它对每条回执都一样，是标签不是判据——
        // 成功那一行以「发送成功 / 成功，但超…」开头、失败那一行以「失败，」开头、
        // 被打断那支早就没有抬头，三种情形本来就能一眼分开。
        return okResult(lines.map((line) => `- ${line}`).join('\n'));
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.notConfigured);
      }
    },
  };

  const report: ToolDefinition = {
    name: 'report',
    /**
     * v74（用户口径「desc 只留怎么调，不留该怎么想」）：**指导性内容搬到 `SELF_BRIEF` §2.1**
     * （什么时候用、写多长、别重复发、和 speak 的分工），这里只留：干什么、参数、一行示例。
     * 收益口径如实说：**真正省的是回执**（4 行 → 5–12 字），搬 desc 只是把它压到最小；
     * `catalogTokens` 因此下降，腾出的额度给了 `find` 的 desc（两件同批、总数仍 ≤5500）。
     */
    description:
      '发正式内容用这个：Markdown 原样保留、不切分、不限长。'
      + 'text 必填；要发给别的会话就带 to（sid 见外部会话清单）。例：{text:"**进度**：42 个文件"}',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发的内容（Markdown 原样保留，可长）' },
        to: {
          type: 'string',
          description:
            '发给哪个会话（sid 见上下文的外部会话清单）；省略 = 本机对话流 + 本轮叫你说话的那个会话。'
            + '发不出去时回执会说清原因。',
        },
        level: {
          type: 'string',
          enum: ['info', 'warn', 'critical'],
          description: '推送级别（与 speak 同一套），默认 info',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    timeoutMs: 30_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'report');
        const text = requiredString(args, 'text', { maxLength: REPORT_TEXT_MAX });
        const level = readNotifyLevel(args);
        const chars = text.length;
        const lines: string[] = [];
        // 整段发：不切分、不加工格式。可见性显式给（与 speak 那条同一条理由，见上）
        emit('message/assistant', { text, toolCalls: [] }, defaultVisibility('message/assistant'));
        emit('speak/sent', { channel: 'log', chars } satisfies SpeakSentPayload);
        // 2026-10-20（R4）：这里原来还有一行 `日志/前端：已记录 N 字（整段）`，已删——
        // 「整段、不切分」已经写在工具描述与 `parts: 1` 的凭据里，字数在锚点那句「全文 N 字」
        // 里（同一把中文计字尺）。删它一条判据都没少。
        //
        // v74：第二路（主动推送）与 `speak` 同一口径——出口没配/成功都**不印**（成功是常态、
        // "跳过"不是她要判断的事），只有推送失败才多一行。`report` 是低频工具，但回执同样会被
        // 后续每一轮读回，所以这一格与 `speak` 保持一致。
        if (notifier !== undefined) {
          const outcome = await notifier.send({ level, title: 'Irmia 报告', body: text });
          if (outcome.ok) {
            emit('speak/sent', { channel: 'notify', chars } satisfies SpeakSentPayload);
          } else {
            lines.push(`推送失败，${speakFailureReason(outcome.reason, 0, 1)}`);
          }
        }
        const resolved = resolveTarget(
          typeof args['to'] === 'string' ? args['to'].trim() : '',
          ctx,
        );
        if (resolved.error !== undefined) {
          return errorResult(resolved.error, TOOL_ERROR_CODES.invalidArgs);
        }
        const target = resolved.target;
        // 正文原样出站（与 speak 同一条判据）：报告里写 `[@1 号]` 也好、写官方那一串
        // `<qqbot-at-user id="…" />` 也好，都只是正文的一部分——框架不改写、也不拒发。
        if (target === null) {
          // 与 `speak` 同一句（`localOnlyNote`）：本机那一份到了、IM 那一跳根本没发生，
          // 所以这里**不许**出现"不必重复发送"——要它到那边就带 `to` 再发一次。
          lines.push(localOnlyNote('报告'));
        } else {
          const outcome = await replyPoster.post(target, text);
          if (outcome.ok) {
            // **出站成功的凭据**，与 speak 同一个函数、同一种形状（`deliverToSession` 的注释里
            // 记着判据为什么必须收成一处）。这一条同时解决两件事：
            //   ① 它进 `read_channel` 的"我自己的发言"那一折 ⇒ 她下一次翻这个会话，能读到
            //      **自己刚报告过的那一篇**（行首 `（我）`），不必靠记忆；
            //   ② 它是"发出去了"的**凭据**，不是"我想发"的意图——所以只在 `outcome.ok` 里写。
            //
            // 文本给 `text` 原文（不是任何切分结果）：report 这条路**不切分**，进请求体的就是
            // 这一整串（`test/admin-pwsh.test.ts` 里那条"逐字节进请求体"钉着）；
            // `parts: 1` 说的正是"这一步只有一条"。
            emit('speak/sent', deliverToSession({
              sid: target.url,
              text,
              parts: 1,
              chars,
              callId: ctx.callId,
              turn: ctx.turn,
              // 与 `send_media` 同一条（2026-10-18，review P1-12 顺手那一格）：`outcome.messageId`
              // 是平台回的这条消息 id，过去这里没接 ⇒ `read_channel` 的（我）行同样少了 `·m<id>`。
              // 给不出时这一格缺席（`deliverToSession` 兜空串，理由见它那段注释）。
              ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
            }) satisfies SpeakSentPayload);
            // v74 那句「`report` 照 `speak` 一样」指的是**回执格式与 `speak` 同口径**——短、
            // 不印坐标、不回显正文、不印"不必重复发送"——**不是数值也一样**。
            // `report` **没有 25 字这条建议线**：25 字（`SPEAK_TEXT_SUGGESTED_MAX`）是 `speak` 的
            // **聊天风格目标**（一次说话该多短，像打字聊天），只属于 `speak`；`report` 是发长文的
            // 那一件（`REPORT_TEXT_MAX` 六万四、描述写着"不限长"），对它判长度没有意义。
            // 所以成功回执**固定就是 `发送成功`**：不判长度、不数字数。
            // ⚠ 这里曾经照搬 `speak` 的两态（>25 字 ⇒ `成功，但超25字限制（N 字）`），那是**假话**：
            // 用户截图实证一篇 1293 字的报告被回执判成"超限"，而回执会被后续每个请求读回
            // ⇒ 等于每轮都告诉她"你的报告超限了"。降级 note 仍单独一行（它说的是形态，不是长短）。
            lines.push('发送成功');
            const note = degradeLineOf(outcome.note);
            if (note !== null) lines.push(note);
          } else {
            // 失败/被拒：**不写凭据**（"没发出去"不算"她报告过"）。v74：与 `speak` 同一句
            // `失败，<原因>`——原因中文、能判断下一步，不印英文原文/栈。
            lines.push(`失败，${speakFailureReason(outcome.reason, 0, 1)}`);
          }
        }
        // 抬头「报告已处理：」已删（R4；与 speak 同一条理由：标签不是判据）。
        return okResult(lines.map((line) => `- ${line}`).join('\n'));
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.notConfigured);
      }
    },
  };

  // ── todo ──
  //
  // 2026-10-04 用户的口径（「state……甚至就应该取代 todo」→「或者说合并」）：**别再有第二本账**。
  // 所以这个工具的名字与调用方式一个字节没变（`items` 仍是全量替换），但它现在把清单**写进
  // `STATE.md` 的两节**（`## 当前任务` / `## 接着干`），而不是另起一份投影里的 todoList。
  // 任务卡（此刻层那条 `当前任务：…` + `未完成计划：`）只从这两节渲染——显示单源。
  //
  // 写通道与 `write_persona` **同一条**（`persona/updated` + `onPersonaUpdated`），但落盘前多一道
  // **计划**：`planTodoWrite` 只替换那两节的正文区间，其余字节一个不动；定位不到就如实报错，
  // 绝不退回"整份重写"（那会静默毁掉她写在 STATE 里的别的东西）。
  //
  // ## 描述为什么这么短（这一段是给下一个想把它写详细的人看的）
  //
  // 描述是**常驻开销**（每轮请求都带），而 `registry.register` 有一条 **100 token** 的硬门，
  // 超了直接抛错 → `buildCatalogRegistry` 把这条记进 `problems` 并**跳过这一件工具**。
  // 症状不是"描述长"，而是**她少了一件工具**，只能从"她怎么突然不会记待办了"反推回来
  // （`test/tool-catalog.test.ts` 开篇记着这个坑已经栽过两次：pwsh 119、speak 改措辞后又超）。
  // 而这一件的口径比硬门更紧：它在"七件压到 60 以内"的名单里（`todo` 名列其中）。
  //
  // 所以这里只留三件事：**做什么 / 写到哪两节 / 失败会怎样**。
  //   • 不复述 STATE 的段落结构——那是 `STATE.md` 自己的事（她写它、`write_persona` 改它）；
  //   • 不复述状态字段的枚举——`parameters.items.status` 的 enum 已经写了 pending/in_progress/
  //     completed，回执里也会把清单原样列给她看；
  //   • 不写"每轮注入进度看板"这类背景——任务卡每步都在她眼前，描述里再说一遍纯属重复付费。
  // 改这段之前先量一下：`_research/tool-desc-len.mts`（或直接跑 tool-catalog 那两条用例）。
  const todo: ToolDefinition = {
    name: 'todo',
    description:
      `清单写进 STATE.md 的「## ${TODO_SECTIONS[0]}」「## ${TODO_SECTIONS[1]}」两节`
      + '（全量替换，[] 清空）：第一项进前者，记 `- [ ]`/`- [~]`/`- [x]`。'
      + '只动这两节，其余字节不变；两节不在就报错。',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description:
            '完整清单，按执行顺序排列（全量替换语义）；第一项=当前任务，其余=接着干',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '一条可判定的动作描述' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'todo');
        const items = readTodoItems(args['items']);

        // ① 读出她当前那份 STATE（todo 的载体就在里面）
        const target = resolvePersonaPath(personaRootOf(ctx), TODO_CARRIER_FILE);
        let current: string;
        try {
          current = await readFile(target.absolute, 'utf8');
        } catch (err) {
          return errorResultFromThrown(err, TOOL_ERROR_CODES.writeFailed);
        }

        // ② 规划：只换那两节的正文区间（失败即如实报错，一个字节都不写）
        const plan = planTodoWrite(current, items);
        if (!plan.ok) {
          return errorResult(plan.message, TOOL_ERROR_CODES.invalidArgs);
        }
        if (!plan.changed) {
          // 幂等：同一份清单重复写不该产生一次 persona/updated（那会让下一轮的固定块白失守一次）
          return okResult(
            items.length === 0
              ? '清单已经是空的（STATE 的那两节本来就没有待办，未产生写入）。'
              : `清单没有变化（${items.length} 项，STATE 里已经是这一份，未产生写入）：\n`
                + items.map(describeTodo).join('\n'),
          );
        }

        // ③ 落盘 + 账（与 write_persona 同一条通道：先规范化字节形状，再原子写，再落事件）
        const content = normalizePersonaAsset(plan.text);
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > PERSONA_HARD_LIMIT_BYTES) {
          return errorResult(
            `STATE.md 写入后会有 ${bytes} 字节，超过单文件硬上限 ${PERSONA_HARD_LIMIT_BYTES}。`
            + '请精简清单（或先把 STATE 里已办结的旧账挪进记忆文件）后重试；本次没有写入。',
            TOOL_ERROR_CODES.tooLarge,
          );
        }
        await writeFileAtomic(target.absolute, content);

        const diffHash = sha256Hex(content);
        emit('todo/updated', { items });
        emit('persona/updated', { file: target.display, diffHash, by: 'agent' });
        options.onTodoUpdated?.(items);
        options.onPersonaUpdated?.({ file: target.display, diffHash, by: 'agent' });

        const where = `STATE.md 的「${TODO_SECTIONS[0]}」/「${TODO_SECTIONS[1]}」`;
        const head = items.length === 0
          ? `清单已清空（${where} 两节已置空；其余内容一个字节没动）。`
          : `清单已写进 ${where}（${items.length} 项；${plan.summary}）：\n`
            + items.map(describeTodo).join('\n');
        return okResult(`${head}\n以后要看进度就看这两节——它每轮都在你的上下文里。`);
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── read_channel ──

  const channelReader = options.channelReader ?? null;
  const channelSpokenReader = options.channelSpokenReader ?? null;
  const channelNoticeReader = options.channelNoticeReader ?? null;
  const channelSelfActionReader = options.channelSelfActionReader ?? null;
  /** 会话簿的取值器（v66）：不给 `sid` 的 `read_channel` 那一支用它，见 `channelSessions` */
  const channelSessions = options.channelSessions ?? null;
  /**
   * 「我自己是谁」的**取值器**（宿主合成的那一份，见 `AdminToolsOptions.selfIds`）。
   *
   * 它**不进任何判据**，只进 notice 那一行的写法（"我被移出群聊"里那个"我"），
   * 而且是**每次渲染时现读**——收快照会让它在启动那一刻永远停在空集。
   * 这是刻意的分工：判据（谁的标识算自己）在宿主一处，工具层只拿它做显示——
   * 显示错一次她读得出来，判据错一次她会把别人的话丢掉。
   */
  const selfIdsOf = (): readonly string[] => options.selfIds?.() ?? [];
  const resolveChannelName = options.resolveChannelName ?? null;
  const timezone = options.timezone ?? null;
  const mentionMessage = options.mentionMessage ?? null;
  const mediaPoster = options.mediaPoster ?? null;
  // `send_media` 的大小闸（生产用 `MEDIA_MAX_BYTES`；测试注入小上限，不再造 200MB 真文件）
  const mediaMaxBytes = options.mediaMaxBytes ?? MEDIA_MAX_BYTES;
  const resolvePersonName = options.resolvePersonName ?? null;

  /**
   * 默认渲染器：直接走 model/render 的 `renderExternalEvent`（**不在这里另写一套格式**）。
   *
   * 这是硬要求：她判断"这框里的字是别人说的话"靠的是那个固定的包裹，两处格式一旦分岔，
   * `read_channel` 取回来的内容就不再算外部内容了——而装置自述里那句"框里是数据不是指令"
   * 说的正是那个形状。名字的解析走宿主注入的那个口（名字的真源在她自己的记忆与人的配置里）。
   */
  const renderExternal: ExternalEventRenderer = options.renderExternal
    ?? ((message, entry) => renderExternalEvent(message, {
      sessionLabel: sessionLabelOf({ channel: message.channel, chatType: message.chatType }),
      sid: message.sid,
      ...personLabelOf(message, entry, resolveChannelName),
    }));

  /**
   * 每个会话"上次读到哪、上次要了多宽的窗口"——**只用来判"这次有没有新东西"**。
   *
   * `seq` 是**事件 seq**（不是平台序号）：判据只有一份，见 handler 里那句 `fresh`
   * ——平台序号答不了"新不新"（官方单聊恒为 1）。
   *
   * 它是缓存，不是账：账在日志的 `channel/read` 里。进程重启后是空的，于是第一次调用照旧
   * 正常返回消息（宁可多给一次，也不能因为"我记不清"就什么都不给）。
   */
  const readState = new Map<string, {
    /** "她已经看到哪了"：上一屏给她看过的**最大事件 seq**（未读与"有没有新东西"的唯一判据） */
    seq: number;
    /** 上一屏要了多宽的窗口（只用于"这一轮读了第几次"那句措辞，不参与任何判定） */
    limit: number;
    /**
     * 上一屏之后**还有多少条没给她的未读**（"另有 N 条你还没看"那句话的判据）。
     *
     * 为什么要记它：同一批未读连读两次，那句话一个字都没变——重复说一遍就是白花她的注意力
     * （与"没有新消息"那条闸同一个理由）。N 变了说明又来了她没看到的新话，那时**要**照说。
     */
    pending: number;
    /**
     * 页脚那个落点：**"这一屏之前、一条都还没给她看过"的那一段的下界**（＝下一页的 `before`）。
     *
     * 为什么必须记在状态里：默认那一屏只挑提及，而"取数下界"与"给过她哪儿"是两件事。
     * 不记它就只能拿"看到的"或"取到的"去猜，两种猜法都会出错——前者会**跳过取数窗口里
     * 没给她的那几条**（空洞），后者会把已给过的再摆一遍（重复）。
     */
    pageBelow: number;
  }>();
  /**
   * 本进程里"上一次为她写下的已读位"（`sid → upToSeq`）——**只用来挡住同值的重复写入**。
   *
   * 为什么除了会话簿那一格还要这一格（2026-10-24）：`channel/read` 的语义是"她读到哪了"的
   * **事实**，不是草稿纸。而"这个位置已经记过了"的判据来自**宿主**（`durableReadMark`：会话簿
   * 每拍折一次，CLI 与一部分用例里甚至没接线）。宿主的节奏不该决定日志里会不会多出一串同值记录
   * ——一次"没有新消息"的复读、或者翻页抄了同一个游标，都会往日志里落一条一模一样的账。
   *
   * 它是缓存，不是账：账仍在日志里（重启后靠 `durableReadMark` 那条路兜住）。
   */
  const writtenReadMarks = new Map<string, number>();
  /**
   * 「上次查看读到哪」——**从日志读回来的那一份**（v67，跨重启的唯一来源）。
   *
   * 为什么它必须存在（2026-10-17 用户的第一条口径）：默认那一屏要"只给上次查看之后的新消息"，
   * 而上面那份 `readState` 是**缓存**：进程一重启就空，于是每一次重启都会换回一整屏旧内容
   *（实测代价：458 次 / 491,315 字 = 全部回执的 37.5%）。
   *
   * 账本来就在日志里：`read_channel` 每给她看一批别人的话，就写一条 `channel/read {sid, upToSeq}`
   *（见 handler 里那处 `emit`），而宿主启动时用 `collectSessions` 把它折进会话簿
   *（`channel/sessions.ts`）——`sessionRows()` 每一拍都给得出那一格。所以这里**不新增任何状态**：
   * 只是把"已经折好的那一份"按 sid 取出来。会话簿没接线（CLI 只做请求重建那种）就退回 0，
   * 于是退回"宁可多给一次"——与没读过这个会话同一条路。
   *
   * 量纲是**平台序号**（`ChannelMessageView.msgSeq` 那一把尺），由 `watermarkSeqOf` 换成事件 seq。
   */
  const durableReadMark = (sid: string): number => {
    if (channelSessions === null) return 0;
    try {
      const row = channelSessions().find((it) => it.sid === sid);
      const mark = row?.readUpToSeq ?? 0;
      return Number.isFinite(mark) && mark > 0 ? mark : 0;
    } catch {
      // 读会话簿是**宿主**的动作：它抛了就当作"这次拿不到水位"（退回"宁可多给一次"），
      // 而不是让整次读取失败——她要看的是消息，水位那条路不该把这个动作拖垮。
      return 0;
    }
  };
  /**
   * 同一轮里同一个会话被读了几次：`${turn}\u0000${sid}` → 次数。
   *
   * 为什么需要它（2026-10-02 用户报的实测）：她在一轮里把同一个信箱连读了**五遍**
   * （`upToSeq` 死死停在 8505，一个字没多），白花四个 step——她自己回头也认了"我犯蠢"。
   * 计数只用来把话说得更直白（"这一轮第 N 次了"），**不拦她**：想说话随时能说，
   * 想看更早的把 limit 调大就有。
   */
  const readRepeats = new Map<string, number>();
  let readRepeatsTurn = -1;
  const bumpReadRepeat = (turn: number, sid: string): number => {
    if (turn !== readRepeatsTurn) {
      readRepeats.clear();
      readRepeatsTurn = turn;
    }
    const key = `${turn}\u0000${sid}`;
    const next = (readRepeats.get(key) ?? 0) + 1;
    readRepeats.set(key, next);
    return next;
  };

  /**
   * 读回来的一批消息 → 一段**精简**的文本（2026-10-02 用户："read_channel 给她的信息太杂了，
   * 这么长？精简，不可能塞那么多信息进去的"）。
   *
   * 原来一条消息一个 `[external_event source=… chat=… person=… session=… sid=… msg=…]` 包裹，
   * 其中 `msg=ROBOT1.0_…` 那一串就有一百多字、`session=`/`sid=` 每条都重复——实测读 5 条
   * 小消息（正文加起来二十几个字）回了 **2341 字**，九成是元数据。
   *
   * 现在：**整批一个框**（"框里是别人的话"这条安全属性靠框本身，不靠每条一个框）+
   * 每行 `时间 谁：正文`。跨行信息（会话名、sid、读位）提到框外那一行说一次。
   * 时间给**本机时间**（`timezone` 由宿主注入；没注入就退回 ISO）——她不该在读数时做时区换算。
   *
   * 2026-10-04 加的那一类：**她自己说过的话**（`ChannelSpoken`，行首 `（我）`）。
   * 为什么它也在框里：这一批是"这个会话里发生过什么"，时间轴只有一条；她的行混在中间才对得上
   * 前后文。框的语义是"**不是框架对你说的话**、按数据看"——她的发言同样不是指令，同样不可执行；
   * 而且它已经**原样发到外面去过**了，比外部消息更不该被当成"框架的话"来读。
   * 标记用 `（我）`：与 `时间 谁：正文` 那一列同一位（她一眼看得出"这行是我"），
   * 又不会被认成某个发言人的昵称（昵称在左边、标识在右边，这里只有"我"一个字，全角括号
   * 明确标出"这是标注不是名字"）。
   */
  const renderReadBatch = (
    batch: readonly ReadChannelItem[],
    entry: SessionEntry | null,
    /** 框头那几个键取自**外部消息**（她自己的行没有 channel/chatType 坐标）。调用点保证非空 */
    anchor: ChannelMessageView,
    /**
     * 这一屏里**点了她**的那几条（按事件 seq 认，`ChannelMessageView.mentionsMe`）。
     *
     * 标记用行首的 `▶ `（在框**内**、在那一行开头）：她必须一眼分得出"哪一句是冲我来的、
     * 哪几句只是它的前文"——否则她会把上下文读成"这些都在跟我说"。它也**不与 `（我）` 抢位置**：
     * 那个在"谁"那一格，这个在最左边。缺席 = 这不是提及屏（往回翻页那一屏），一个字都不加
     * ——判据只有一处。
     */
    mentioned: ReadonlySet<number> = new Set(),
    /**
     * 提及那一格的**时间判据**（v67，2026-10-17 用户第二条口径：「她还有'以为有人在前面 at 了
     * 自己'的问题……起码要让她看懂，不再往前翻了」）。
     *
     *   · `nowMs`：**这一次读的时刻**（相对时间的基准）；
     *   · `watermark`：「上次查看到哪」的事件 seq——某条提及 `≤ watermark` 就是**旧提及**
     *     （她上次看之前就有了），那一行必须**在行内点明**，否则她会把一条几天前的 @
     *     当成刚有人叫她（实测：62% 的"被 @ 唤醒后去读"回执里一个 `▶` 都没有，
     *     她只能自己往回想、往前翻）。
     *
     * 判据与行首 `▶` **同一份**（都是 `mentioned` 这个集合）：有标记 ⇒ 有年龄格，一格不多一格不少。
     */
    mentionClock: { nowMs: number; watermark: number },
  ): string[] => {
    // 框的**开头与会话那一份同形**（`[external_event source=… chat=…`）：她认"这是别人说的话"
    // 靠的就是这个开头（装置自述里写着）。整批一个框，所以只写一次；`count=` 说明批里几条
    // ——她自己的行也算在 count 里（count = 这一屏几行，跟她要的 limit 对得上）。
    // 框头用外部消息那一份而不是 batch[0]：一屏可能整屏都是她自己的行（那种情况下没有任何
    // 外部消息可当锚），而 source/chat 这两个键不该因此变成空——它们是这个框的形状。
    const chatLabel = CHAT_TYPE_LABELS[anchor.chatType] ?? anchor.chatType;
    const lines: string[] = [
      `[external_event source=${anchor.channel} chat=${chatLabel} count=${batch.length}]`,
    ];
    // 每行的"谁"按**人**算：认得出名字就给名字，认不出给一个短代号（甲/乙/丙…，同一批内稳定）。
    // 绝不写会话名（那会让"谁说的"消失），也绝不写 openid（32 位乱码认不出是同一个人）。
    const alias = makePersonAliaser(resolvePersonName);
    /**
     * notice 那一行里的名字（**与消息那一行共用同一个别名器**）。
     *
     * 为什么共用：同一个 openid 在同一屏里只能有一种写法——消息行给 `阿岚`、
     * 而下面那件"他开了全员禁言"写成 `…0006`，读起来就是两个人。notice 不带昵称，
     * 所以第二个入参永远是 undefined（那个口留着只为形状一致）。
     */
    const noticeNamer: NoticeNamer = (id) => alias(id);
    /**
     * 她自己的动作那一行里的**那个群怎么称呼**（`[全员禁言 · <这一格> · 开启]`）。
     *
     * 与上面那个别名器**刻意分开**：那个答"**谁**说的"（按人查），这个答"**哪个会话**"
     * （按 sid 查）——两件事在仓里本来就是两个真源（`resolvePersonName` vs
     * `resolveChannelName`），合成一个函数迟早有一边查错表。
     * 查不到就返回 null，由 `selfActionLineText` 写成一个如实锚（`一个群聊（…6782）`）——
     * **不编名字**（编出来的群名比一串 id 危险得多：她会照着那个名字认群）。
     *
     * ⚠ **不用 `sessionLabelOf` 兜底**：那个答的是"这是个什么会话"（`OneBot 11 · 群聊`），
     * 而这一格要的是"**哪个**会话"。拿会话类型填进名字那一格，读起来像"她在一个叫
     * 「OneBot 11 · 群聊」的群里做过事"——同一个 box 里 `whereOf` 已经给一行 `· OneBot 11 · 群聊` 了。
     * 名字真源给不出就让它给出锚，那比一个像名字的东西诚实。
     */
    const actionNamer: SelfActionNamer = (chatSid) => resolveChannelName?.(chatSid) ?? null;
    // 每次渲染现读一次（"我是谁"是运行期长出来的；收快照会让这一行永远写成 id 锚）
    const noticeSelfIds = new Set(selfIdsOf());
    const notes: string[] = [];
    /**
     * 两个**整批**才说一次的计数（逐行缀一句太贵，而这两件都是"整个框"的事）：
     *   · `addressOnly` = 框里有"只给了地址"的图（默认那条路）⇒ 框后指一次"怎么自己看"；
     *   · `overCount`  = 因为**这一次读的名额**没带进来的张数 ⇒ 如实报数（用户要的
     *     「超了如实说'还有 k 张没带'」）。
     */
    let addressOnly = false;
    let overCount = 0;
    /**
     * 这一屏印过几行提及、其中几行**是旧的**（`≤ watermark`）——框后那句说明照它们决定说不说。
     *
     * 为什么是整批两个数而不是逐行各说一遍：那一格的**含义**（`【这条提及是 X 前的】`）
     * 只说一次就够，逐行解释等于把同一句话印 N 遍；而"旧提及"这一档必须**单独成句**说清
     * （用户 2026-10-17 第二条：起码要让她看懂，不再往前翻）——它是这一屏里唯一需要她
     * "别当成刚发生"的东西。
     */
    let mentionRows = 0;
    let staleMentionRows = 0;
    /**
     * 这一屏**印过几个 `·m<id>`**（2026-10-12 加的"每行带 id"，方案 A）。
     *
     * 为什么不是"印了几行"而是"印了几个 id"：它的唯一用途是决定框后那句说明**要不要出现**
     * （一个都没印就不该解释一个没出现的东西）。
     */
    let idCount = 0;
    /**
     * 这一屏要不要印平台消息 id —— **只对 OneBot 族**（`isOneBotFamilyChannel`，覆盖别名实例）。
     *
     * 为什么按通道开关、而不是无条件印：两扇门的 id 是两种完全不同的东西。实测（报告 §1.5，
     * 8494 / 2320 个真实样本）——
     *   • OneBot 的 id 是 6–11 字符的整数串（`-754521710`），**可操作**：`get_msg` / `delete_msg`
     *     都收它（MCP server 侧把字符串自己转整数，见 `onebot11-mcp/src/validate.js`）；
     *   • 官方门的 id 是 **117–137 字符**的 `ROBOT1.0_…`，而**本仓没有任何官方门撤回/删除路径**
     *     ⇒ 印出来是"每行 +30.63 token 换一个她一个工具也用不上的字符串"（一屏 20 行 ≈ +613）。
     * 当年（2026-10-02）把逐条包裹压成整批一个框、顺手压掉 `msg=` 的那个理由，说的正是
     * `ROBOT1.0_…` 那一串；一刀切砍在了两种不同的东西上——这条判据就是把它们分开。
     *
     * 判据**不另写一遍**：`isOneBotFamilyChannel` 已经是全仓"这是不是 OneBot 家族"的唯一实现
     * （`input-notify.ts` / `media-poster.ts` / `sessions.ts` / `warn-exempt.ts` 都用它），
     * 而且它本来就在本文件的 import 里（回投地址那一处）。
     */
    const printIds = isOneBotFamilyChannel(anchor.channel);
    for (const item of batch) {
      const when = shortLocalTime(item.ts, timezone);
      // "点了她的那条"的标记：加在整行最左边（见上面 `mentioned` 的说明）
      const isMention = mentioned.has(eventSeqOf(item));
      const at = isMention ? MENTION_ROW_MARK : '';
      /**
       * 提及行尾那一格（**只有提及行有**）：`【这条提及是 4 天前的】`。
       *
       * 判据两条，都只在这里一处：
       *   · 时间用**相对说法**（与此刻层「在等你答复」「最近一次 …前」同一条纪律：
       *     她不该在自己读数时做减法，`MM-DD HH:MM` 只答"什么时候"，答不了"多久之前"）；
       *   · `≤ watermark` 的那条还要多几个字（`——不是新消息`）：它是**她上次看之前就有的**
       *     旧提及，正是"往前翻"那件事的触发点，必须在同一行说破。
       */
      const mentionTail = isMention
        ? mentionAgeCellText(item.ts, mentionClock.nowMs, eventSeqOf(item) <= mentionClock.watermark)
        : '';
      if (isMention) {
        mentionRows += 1;
        if (eventSeqOf(item) <= mentionClock.watermark) staleMentionRows += 1;
      }
      if (isChannelSpoken(item)) {
        // 她的行：`（我）` 占"谁"那一格，后面是她说的完整文本（一次 speak 的所有气泡拼在一起，
        // 不论几十条都只占这一行）。正文同样压成一行——换行会把"一行一条"这条预算结构打破。
        const spoken = item.text.replace(/\s+/gu, ' ').trim();
        /**
         * 行尾那个 id 单元：**她这一行也印**（与别人的行同一个形态、同一个判据）。
         *
         * 为什么她那边也要（2026-10-12，与"读别人的行"同一件）：她最想撤的恰恰是**自己刚发的
         * 那条**——实测 T1308 那一轮的主线就是"我重复发了、删掉它"，而 `（我）`那一行原先
         * 结构上就没有 id，她只能去扫原始 jsonl。这个 id 来自 `speak/sent.messageId`
         *（回投那一层原样带回来的平台 id）⇒ 与别人的行**同源同形**。
         *
         * 缺席（旧日志 / 通道给不出）就一个字都不加：这一行照旧读得出来。
         */
        const spokenId = printIds && item.messageId !== undefined && item.messageId !== ''
          ? `${MESSAGE_ID_MARK}${item.messageId}`
          : '';
        if (spokenId !== '') idCount += 1;
        lines.push(`${at}${when} ${SELF_SPEAK_LABEL}：${spoken}${spokenId}${mentionTail}`);
        continue;
      }
      if (isChannelNotice(item)) {
        /**
         * 群里的一件动静：`时间 [某人 开启了全员禁言]`——**"谁"那一格留空**（notice 可能没有
         * 操作者，也可能说的不是"谁说了什么"），整件事由 `noticeLineText` 逐字写成方括号里那句。
         *
         * 为什么"谁"那一格留空而不是塞个名字：notice 的行文里**本来就带着人**
         *（"阿岚 开启了全员禁言"），再在前面摆一个 `阿岚：` 就成了同一件事说两遍，
         * 而这一屏每一行都是常驻开销。
         *
         * 认不出来的 `notice_type` ⇒ `noticeLineText` 返回 null ⇒ **整行不摆**
         *（宿主压根不会把那种事件落库，这里是第二道：宁可这一行没有，也不编一件没发生的事）。
         */
        const notice = noticeLineText(item, noticeNamer, noticeSelfIds);
        if (notice === null) continue;
        lines.push(`${at}${when} ${notice}${mentionTail}`);
        continue;
      }
      if (isChannelSelfAction(item)) {
        /**
         * 她自己的管理动作（「我做过」）：`时间 （我）：[全员禁言 · <群名> · 开启]（回执 ok）`。
         *
         * 与"她说过的话"**同族但不混**：两者行首都是 `（我）`（同一个常量，她一眼认得出
         * "这行是我"），区别在后面那一段——那一族是自由文本，这一族是**方括号包住的动作 +
         * 括号里的回执**。判据在 `isChannelSpoken` / `isChannelSelfAction` 里（互斥）。
         *
         * 不认识的 `action` ⇒ `selfActionLineText` 照摆**协议原名**（不编中文动作名）；
         * 名字查不到 ⇒ 那一格写成一个如实锚（`一个群聊（…6782）`）。两条都是"宁可难看，不可编"。
         */
        lines.push(`${at}${when} ${SELF_SPEAK_LABEL}：${selfActionLineText(item, actionNamer)}${mentionTail}`);
        continue;
      }
      const label = alias(item.person, item.nickname);
      // 图片那一格：**逐个**对上宿主给的事实（它只含图、顺序与这里的图一致）。
      // 判据用 `isImageAttachment` 而不是 `a.type === 'image'`：那是全仓"这是不是一张图"的
      // 唯一实现（MIME `image/png` 与 OneBot 的段类型裸标签 `image` 都算），写窄了会让
      // 另一种形态的图掉进"文件"那一格、连地址都拿不到。
      const facts = item.contextImages;
      let imageAt = 0;
      const attach = (item.attachments ?? [])
        .map((a) => {
          if (!isImageAttachment(a)) return `［文件${a.name === undefined ? '' : ` ${a.name}］`}`;
          const fact = facts?.[imageAt];
          imageAt += 1;
          if (fact === undefined) {
            // 默认那条路：这一条没点名她（或图片直通没开）⇒ 只给地址，由她自己决定值不值得看
            if (typeof a.url === 'string' && a.url.trim() !== '') addressOnly = true;
            return imageCellText(a, undefined);
          }
          if (fact.state === 'over') overCount += 1;
          return imageCellText(a, fact);
        })
        .join('');
      const text = item.text.replace(/\s+/gu, ' ').trim();
      /**
       * 行尾那个 id 单元：`·m<平台消息 id>`（**只对 OneBot 族**，判据见上面 `printIds`）。
       *
       * 为什么必须让她拿得到它（2026-10-12，用户反馈"翻来翻去查 msg_id"）：`get_msg` /
       * `delete_msg` 只认平台 `message_id`，而那个 id 原先只在她**读不到结果**的两处现过身
       * ——别人引用某条时的 `[引用 #<id>]`（`onebot.ts` 的 `quotedPrefix`）、以及唤醒包裹头
       * 的 `msg=<id>#<seq>`（`render.ts` 的 `renderExternalEvent`）。她读群这一屏**没有它**，
       * 于是想撤自己刚发的重复消息时只能去 `rg` 原始 jsonl（实测 T1308：11 步里 6~7 步花在
       * "找 id"上，`77931`/`77500` 两次扫盘，前一次白扫）。id 就在她正在读的那一行上，
       * 那 6 步全部消失。
       *
       * 为什么用 `·m` 而不是 `#`：`#` 在她现在的世界里**已经是"平台 message id"**——
       * 别人引用时的前缀逐字是 `[引用 #-754521710]`。同一个屏里用 `#` 当 id sigil，
       * 与那个既有含义直接打架；而页脚翻页游标是**裸 `event seq`**（`带上 before=76652`），
       * 裸数字又会与它撞。`·m` 带字母 sigil：与既有列（`▶ `、`（我）`、`[external_event …]`、
       * `［图］`）都不冲突，且**只在行尾**、不占任何既有列。
       *
       * 为什么 `id === ''` 就不印、而不是印个空的：印成 `…正文·m` 等于摆一个像 id 的坑，
       * 她可能照着它去调工具。空 id 在 OneBot 上不该出现（`readChannelMessages` 填的是
       * `d.messageId`，而适配器对没有 `message_id` 的消息一律 `return null` 不落库），
       * 这里只是"给不出就不摆"这条既有纪律的第二道。
       */
      const idCell = printIds && item.messageId !== '' ? `${MESSAGE_ID_MARK}${item.messageId}` : '';
      if (idCell !== '') idCount += 1;
      lines.push(`${at}${when} ${label}：${attach}${text}${idCell}${mentionTail}`);
      // 判过注入的那条：框架那句话**留在框外**（框里是别人的话，框外才是框架说的话）。
      // 原来每条一个框、预警就挂在各自框外；现在整批一个框，所以它们统一排在框后，
      // 各自带上"哪一条"的坐标——归属没丢，字数省下来了。
      const note = (item as { flaggedNote?: string }).flaggedNote;
      if (typeof note === 'string' && note.trim() !== '') notes.push(`· ${when} ${label}：${note.trim()}`);
    }
    lines.push('[/external_event]');
    /**
     * 行尾那个 `·m<id>` 是什么 —— **框外**说一次（2026-10-12）。
     *
     * 为什么落在这里而不是 `read_channel` 的 `description` 里：`description` 与 `parameters`
     * 属于 `parameters` / `tools` 段，**逐字节进每一条请求**，改它们 = 一次全 miss
     *（≈9.6 万 token）且必须同批递 `RENDER_VERSION` + 用户批（判据见 `mcp-entry.ts:58-61`）。
     * 而这一段是**工具结果**的一部分，只在被调用的那一次付、进的是 `input` ——
     * 与 `mcp-entry.ts` 那句"要加说明就往 `list` 的回执里加"是同一条纪律。
     *
     * 为什么必须说这一句：`·m` 是个**新符号**，而这一屏会永远留在历史里。不说，
     * 她下一次读到 `·m-754521710` 时只能猜"m 后面这串是什么、能不能用、怎么用"——
     * 那正是这次要消掉的那类猜测。两句都只说**事实**：它是什么、它不能用在哪。
     */
    if (idCount > 0) {
      lines.push(`（行尾 ·m 后面那串是这一条的平台消息 id（这一屏 ${idCount} 条带它，别人的` +
        '和你自己发的都在内）：要撤哪条、要查哪条，用的就是它。别猜——猜错就是撤掉别人的话。');
    }
    /**
     * 行首 `▶` 与行尾那格提及年龄 —— **框外**说一次（v67；同 `·m` 那条纪律：新符号必须先解释）。
     *
     * 为什么非说不可（2026-10-17 用户第二条口径）：她的病害是"**以为有人在前面 at 了自己**"，
     * 于是往回想、往前翻。实测 426 次提及唤醒里，62% 的后续读取回执**一个 `▶` 都没有**；
     * 而给了标记的那些，行上只有一个 `MM-DD HH:MM`——那答"什么时候"，**答不了"多久之前"**，
     * 她没法一眼判"这条是刚叫我的，还是几天前就有的"。这一格就是补上那一个判断。
     *
     * 旧提及单说一句（`staleMentionRows > 0` 才出现）：那是唯一会被误当成"刚有人叫我"的东西，
     * 措辞直接说破"不是你上次看过之后的新消息"——**它不在"新的"计数里**（见 handler 那一行）。
     */
    if (mentionRows > 0) {
      lines.push('（行首 ▶ 是"这一条点了你"；行尾【这条提及是 …… 的】是它离现在多久。'
        + (staleMentionRows > 0
          ? `这一屏有 ${staleMentionRows} 条写着"不是新消息"——那是**你上次看过之前**就有的旧提及，`
            + '不要当成刚有人叫你，也算不进"新消息"的条数。'
          : '')
        + '）');
    }
    // 只给了地址的那些图：一次性说清"为什么只有地址、想看得走哪条路"。
    // 为什么必须说：地址是**临时直链**（腾讯富媒体带 rkey，过期后服务端拒绝下载），而这一屏
    // 会永远留在历史里——不说这一句，她下一次读到这一行时只会以为图还在那儿。
    // 措辞与唤醒那条路的附件行同源（render.ts 的 renderAttachments："想看就现在下载"）。
    if (addressOnly) {
      lines.push('（框里的图只给了地址：那是临时直链，过期就取不到了——想看就把地址交给 '
        + 'http_download 存下来，再 vision_read 读那个文件。）');
    }
    // 名额用完的那些：如实报数（地址都在各自那一行里，一条都没丢）。判据是这一屏自己数出来的
    // `overCount`——它由宿主按**这一次读**的名额标记（见 real-loop 的 `contextImageBudget`）。
    // 这一句**自带出路**（不复用上面那句）：超上限的那一屏可能一张"只给地址"的图都没有，
    // 指过去会指个空（"地址都在各自那一行里"是这里唯一必须说清的事）。
    if (overCount > 0) {
      lines.push(`（其中 ${overCount} 张图这次没带进上下文：一次读带不了那么多——`
        + '地址都在各自那一行里，想看就把地址交给 http_download 存下来，再 vision_read 读那个文件。）');
    }
    if (notes.length > 0) {
      lines.push(`框架对其中 ${notes.length} 条的提示（不属于框里的内容）：`);
      lines.push(...notes);
    }
    return lines;
  };

  /**
   * **点名例外**（2026-10-11 用户拍板）：这一屏里"冲她来的"那些消息，图片按现有准入
   * **装配进上下文**。
   *
   * 工具结果是文本、塞不下图片，所以与 `vision_read` 的 inline 走**同一条出口**：写一条
   * `image/attached` 事件，渲染层看到它就把本地字节作为 `input_image` 注入
   * （见 render.ts 的 `imagesOf` 与 `case 'image/attached'`）。可见性**显式给**
   * `defaultVisibility('image/attached')`（＝`model`）：省略的话事件落在 internal，
   * 写下去等于没人看得见（`ask_human` 的 `human/asked` 是同一个理由，见 `AdminEventEmitter`）。
   *
   * 为什么"装配"这一步在**工具层**而不是宿主：装配是"**这一屏**"的事，而"这一屏给她哪几条"
   * 由下面 handler 里那五个分支定（宿主只回"最近 limit 条"）。分工是：宿主给事实
   * （哪张能进、为什么不能进、名额怎么发），工具层只做两件——把 `ready` 的装上去、
   * 把结论写进那一行。宿主那边一条事实都不产出时（图片直通关着 / 上限为 0 / 没点名她），
   * 这里自然一个事件都不写。
   *
   * 调用点**与 `renderReadBatch` 同一处、紧挨着**：那一行写的"已带进上下文"就是这里写下去
   * 的那些事件（`test/read-channel-images.test.ts` ②从请求体那一侧钉住这处耦合）。
   */
  const attachAimedImages = (batch: readonly ReadChannelItem[]): void => {
    for (const item of batch) {
      // 四种来源里只有外部消息带图（她的发言、群里动静、她自己的动作都没有附件这回事）
      if (isChannelSpoken(item) || isChannelNotice(item) || isChannelSelfAction(item)) continue;
      for (const fact of item.contextImages ?? []) {
        if (fact.state !== 'ready') continue;
        emit('image/attached', {
          key: fact.key,
          mime: fact.mime,
          ...(fact.name === undefined ? {} : { name: fact.name }),
          // 留痕那一栏（不渲染进上下文）：这条图不是她自己点名要的（`vision_read` 的 inline），
          // 而是"读这一屏时**点名她的那条**带进来的"——复盘时两件事必须分得开。
          note: `read_channel：${item.sid} 里点名你的那条（${item.messageId}）`,
        }, defaultVisibility('image/attached'));
      }
    }
  };

  const readChannel: ToolDefinition = {
    name: 'read_channel',
    // 描述瘦身（2026-10-06）：当时 98/100 token —— 距硬门只剩 2 token，再顺手加半句话就会
    // `register` 抛错、被 `buildCatalogRegistry` 记进 problems 并**跳过注册**（工具静默少一件，
    // 只能从行为异常反推）。压到 64 的做法是**把 sid/limit 的细节挪进参数描述**
    // （参数不进 `MAX_DESCRIPTION_TOKENS` 那份预算，而她两个都看得到：schema 与描述一起进清单）。
    //
    // 2026-10-08 两条口径改在这里，**细节一律进参数描述**（同一条纪律）：
    //   • 默认那一屏 = **未读里只给"点了她的那些"+每条之前十条**（用户的原话：「未读也是只读提及
    //     和之前十条」）——描述里只说结论（"只给点你的那些和它们之前十条"），
    //     "之前十条""未读装得下就全给""她自己发的那条也带上下文"这三条边界跟着回执与代码注释走
    //     （判据在 handler 里那份"五个分支"上，逐条写清了为什么）；
    //   • 往回翻页 = 给 `before` 游标、每页 15 条、**不改已读位**——细节全在 `before` 的参数描述里。
    // 留在描述里的每一句都仍然是**她据此决定行为**的：读什么、含她自己的话（怎么认）、
    // 已读只按她真看过的那些推进、没有新消息时回什么（并给她出路）。
    //
    // **2026-10-16（v66）：`sid` 从必填变可选**——不给 sid + 不给 before ⇒ **列会话簿**
    // （外面有哪些会话、类型、未读、最后活跃、在聊什么）。为什么要它：此刻层那张清单是
    // **有窗口的**（私聊常驻、群聊只列她 7 天内回过话或 1 小时内有人 @ 她的），清单末尾写着
    // 「还有 N 个会话没列」——那就必须有一个"看全部"的出口，否则那句话是空头支票。
    // **不新增动作名**：工具清单的每个字节都是冻结前缀的成本（`catalog.ts` 那份预算），
    // 而这一支与"读某个会话"本来就是同一件事的两种入口（一个给 sid、一个不给）。
    // 描述仍然 ≤100 token（它是硬门，见上面那段）：加的那半句只写"怎么用"，细节在参数里。
    //
    // ⚠ **2026-10-17（v67）：描述与行为不符，这一处是那次修正的落点**。
    // 行为在 `fceeffe` 已换成"默认只给**上次查看之后**的增量"（见 handler 里
    // `incrementalWindow` 与 `prevSeq` 那两段），而描述还停在 2026-10-08 那版口径
    // （"默认只给未读里点你的那些和它们之前十条"）——**她只能靠描述理解这条能力**，
    // 一句错的描述会让她按旧口径去猜"为什么没给全"、进而往前翻（正是 `fceeffe` 要治的病）。
    // 新描述逐字对齐四件事实，判据在 `test/read-channel-incremental.test.ts` ⑦ 里按**字**钉住：
    //   (a) 默认 = "上次查看之后"的新消息，一条没有就一句话；
    //   (b) 要翻历史是**她自己填参数**（`before`），且**翻历史不改已读**；
    //   (c) 提及行带 `▶` 与相对时间、**旧提及明写"不是新消息"**（措辞见 `renderReadBatch` 框外那句）；
    //   (d) **看过的标已读**（原句保留）。
    // 代价如实说：**84 → 90 token**（硬门 100，余量 10 = `test/tool-catalog.test.ts` 那条
    // "距硬门不足 10 token 就红"的线本身，判据是 `MAX − tokens < 10` ⇒ 10 正好不红）。
    // 腾出来的是"每页 15 条"那半句——它本来就逐字写在 `before` 的参数描述里
    //（参数不进 `MAX_DESCRIPTION_TOKENS` 那份预算，而她两个都看得到）。
    description:
      '看某个会话的消息（**也包括你自己说过的**，行首 `（我）`）。'
      + '不给 sid 则列出全部会话（未读、最后活跃、在聊什么）。'
      + '默认只给**上次查看之后**的新消息，没有就明说，看过的标记已读。'
      + '想看更早的自己给 before，翻历史不改已读。'
      + '提及行带 ▶ 与相对时间、旧的写明"不是新消息"。想接着说就 speak。',
    parameters: {
      type: 'object',
      properties: {
        sid: {
          type: 'string',
          description: '会话标识，形如 qq:group:<群 id>（见外部会话清单）。'
            + '不给它就是"列会话簿"：返回每个会话的类型、未读数、最后活跃与在聊什么',
        },
        before: {
          type: 'number',
          description: '翻页游标：取**比它更早**的那些（seq，从上一屏页脚抄）。'
            + `给了就进翻页模式：一页 ${READ_CHANNEL_PAGE_SIZE} 条、读全部历史、**不改已读**；不给就是上面那个默认`,
        },
        limit: { type: 'number', description: `这一屏最多几行（缺省 ${READ_CHANNEL_DEFAULT_LIMIT}、翻页一页 ${READ_CHANNEL_PAGE_SIZE}、上限 ${READ_CHANNEL_MAX_LIMIT}）；你自己的发言也占行、一次回复只占一行` },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'idempotent',
    timeoutMs: 10_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'read_channel');
        /**
         * **这一次读的时刻**——只用于提及那一行的相对年龄（`【这条提及是 12 分钟前的】`）。
         *
         * 为什么在这里取一次而不是各行各取：一屏里所有行的"多久之前"必须用**同一个基准**，
         * 否则同一屏会出现"3 分钟前"与"4 分钟前"两把尺（读一屏要几百毫秒，跨过边界就会分岔）。
         */
        const readAtMs = Date.now();
        // `sid` 可选（v66）：**缺席 + 没有 before** ⇒ 列会话簿那一支。给了就照旧解析、
        // 照旧在非法时报错——"不给"与"给了一个读不出来的"是两件事，不许混成一件。
        const rawSid = typeof args['sid'] === 'string' ? args['sid'].trim() : '';
        const cursor = readCursor(args['before']);
        if (rawSid === '' && cursor === null) {
          return sessionsListResult(channelSessions);
        }
        const sid = requiredString(args, 'sid', { maxLength: 512 });
        if (channelReader === null) {
          return errorResult(
            'read_channel 需要宿主接上 IM 消息读取口，当前进程没有接线（CLI 只做请求重建与自检）。',
            TOOL_ERROR_CODES.notConfigured,
          );
        }
        const parsed = parseSid(sid);
        if (parsed === null) {
          return errorResult(
            `sid 不是合法的会话标识：${sid}。它就在你上下文的外部会话清单里（形如 qq:group:<群 id>）。`,
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        // 缺省值**按分支给**（2026-10-23，v80 同代补的那一笔）：翻页模式一页 = `READ_CHANNEL_PAGE_SIZE`，
        // 默认那一屏 = `READ_CHANNEL_DEFAULT_LIMIT`。为什么必须分开：默认那一屏的页脚报的就是
        // `READ_CHANNEL_PAGE_SIZE`（"下一页会发多少行"），若这里仍回 20，页脚说 15、实发 20
        // ——她照页脚算翻页节奏就会算错。判据由 `test/read-channel-page.test.ts` ⑩ 钉住
        // （页脚上的数字 == 实发行数）。
        const limit = readLimit(
          args['limit'],
          cursor === null ? READ_CHANNEL_DEFAULT_LIMIT : READ_CHANNEL_PAGE_SIZE,
        );
        /**
         * 写一笔已读位——**这个工具里唯一的写入处**（2026-10-24）。
         *
         * 为什么收成一处：用户报的 bug 原话是「一旦 `read_channel` 过对应的群聊之后，就不把未读
         * 标签取消掉了」。查下来的机械原因是**写入点只有一个分支有**（默认那一屏摆出了东西时），
         * 而另外两条"她同样读过了"的路一笔都不写：
         *   · **没有新消息**那一条（她刚确认过"这儿没有新东西"——这条确认本身就是已读）；
         *   · **翻页翻到了最新**那一页（翻旧话不该动已读，但翻到最新就是读过了）。
         * 界面那一栏算的是 `msgSeq > readUpToSeq` 的条数（`channel/sessions.ts`），已读位不动它
         * 就永远停在旧水位上——实测用户截图上 418 / 1151 / 510 / 392 那几个群全是这个形状。
         *
         * 两条纪律：
         *   • **只增不减**（`applyChannelRead` 同一条）：已读位是一个位置，"推进"只有一种写法；
         *   • **只推到她确实看过的那一段**（各调用点自己算，见 `readMarkOf`）：翻旧话、没摆下的
         *     那些都不许被这一笔顺手标成已读。
         */
        const markReadUpTo = (upToSeq: number): void => {
          if (!(upToSeq > 0)) return;
          writtenReadMarks.set(sid, Math.max(writtenReadMarks.get(sid) ?? 0, upToSeq));
          emit('channel/read', { sid, upToSeq } satisfies ChannelReadPayload);
        };
        /**
         * 同上，但**只在它比已知水位更新时才写**——给两条"她确认过、但可能什么都没推进"的路用
         * （没有新消息 / 翻页翻到最新）。同一个位置不写第二笔：那是事实，不是草稿纸。
         *
         * 已知水位取"会话簿"与"本进程写过"里更高的那个：前者是**账**（跨重启），后者补上
         * 宿主那一拍还没折到的空档（CLI 与一部分用例里会话簿甚至没接线）。
         *
         * 为什么默认那一屏不走这一支：c2c 的平台序号**恒为 1**，那里的"摆出了新消息"与
         * "位置推进了"本来就是两件事（`msgSeq` 推不动，但那一屏确实给过她）。它照旧每次都记。
         */
        const advanceReadUpTo = (upToSeq: number): void => {
          if (!(upToSeq > 0)) return;
          if (upToSeq <= Math.max(durableReadMark(sid), writtenReadMarks.get(sid) ?? 0)) return;
          markReadUpTo(upToSeq);
        };
        // ── ① 翻页模式：给游标 ⇒ 读**全部历史**，一页 15 条；**只翻旧话时一个字都不动已读** ──
        if (cursor !== null) {
          const messages = await channelReader(sid, limit, cursor.before);
          // 游标是**记在日志里的事实**（事件 seq），但"这个会话里没有比它更早的了"与
          // "这个游标根本不属于这个会话/已经过期"从这一侧看不出区别——所以两句话一起给，
          // 并**明确指路**：空结果与"到头了"是两件完全不同的事，不许让它静默地看起来像后者。
          if (messages.length === 0) {
            return okResult(
              `${sid} 里没有比 ${cursorText(cursor.before)} 更早的了。`
              + '——要么你已经翻到头（最早那条就在前面那一屏），要么这个游标不属于这个会话/已经过期。'
              + `想确认现在有什么，就不带 before 读一次（默认那一屏给"上次查看之后"的新消息）。`,
            );
          }
          const spoken = channelSpokenReader === null ? [] : await channelSpokenReader(sid);
          // 群里动静（notice）也按**同一个游标**切：翻页翻的是"这段历史"，不是"别人说的话"
          //（时间轴只有一条，见 mergeChannelSpeech）。没接线就是空。
          const notices = channelNoticeReader === null
            ? []
            : await channelNoticeReader(sid, limit, cursor.before);
          // 她自己的动作（「我做过」）也按同一个游标切：翻页翻的是"这段历史"
          const actions = channelSelfActionReader === null
            ? []
            : await channelSelfActionReader(sid, limit, cursor.before);
          // 她自己的行也按**同一个游标**切：翻页翻的是"这段历史"，不是"别人说的话"
          //（时间轴只有一条，见 mergeChannelSpeech）
          const pool = sortByTimeline([
            ...messages,
            ...notices,
            ...actions,
            ...spoken.filter((item) => eventSeqOf(item) < cursor.before),
          ]);
          const batch = mergeChannelSpeech(
            pool.filter((item): item is ChannelMessageView | ChannelNoticeView | ChannelSelfActionView =>
              !isChannelSpoken(item)),
            pool.filter(isChannelSpoken),
            limit,
          );
          // ⚠️ **翻旧话不 emit `channel/read`、也不动 readState**：往回翻旧消息既不能把已读位置
          // 退回去、也不能把旧消息重新标成未读（"已读"只按"读到最新"推进，见 sessions.ts 的
          // applyChannelRead）。这是用户 2026-10-08 那条口径的落点。
          //
          // **但"翻到了最新"是例外**（2026-10-24 用户报的那个 bug）：原来这一支一刀切"一个字都
          // 不动已读"，于是「她手里那个游标已经指在最新之后（比如抄了上一屏页脚、而那一屏就是
          // 最近的一屏）」时，这一页明明把最新一条摆给她看了，未读标签照旧不退——直到又有新消息
          // 来才跟着动（用户原话：「直到再次有未读消息」）。判据只有一个：
          // **这一页里有没有"该会话最新一条"**。有 ⇒ 推已读位；没有（纯往回翻旧话）⇒ 照旧不推。
          //
          // 判"最新"为什么要再取一次（`limit=1`）：游标是事件 seq，"比游标更早"与"是不是最新"
          // 是两个问题——`before` 只答前一个。这一取只在翻页这一支发生（实测两个月里 23 次），
          // 默认那一屏一次都不多花。
          const newest = await channelReader(sid, 1);
          const newestSeq = newest.length === 0 ? 0 : eventSeqOf(newest[newest.length - 1]!);
          const coversLatest = newestSeq > 0
            && batch.some((item) => isExternalMessage(item) && eventSeqOf(item) >= newestSeq);
          const pagedUpTo = coversLatest ? readMarkOf(batch) : 0;
          if (pagedUpTo > 0) advanceReadUpTo(pagedUpTo);
          //
          // 点名例外**两条路都适用**：翻页看到的那几条里点了她的，图同样按现有准入装配
          // （一次翻页最多带几张由宿主按这次读的名额定，见 real-loop 的 contextImageBudget）。
          attachAimedImages(batch);
          return okResult([
            `${sid} 从 ${cursorText(cursor.before)} 往前 ${batch.length} 条`
            // 回执要如实说这一次到底动没动已读位：动了却说"翻页不改已读"是骗她，
            // 她会据此以为自己还得再读一次（这正是"反复核对"那条路的起点）
            + (pagedUpTo > 0
              ? `（本机时间，正序；**这一页到最新了，已读位已推到 seq=${pagedUpTo}**）· ${whereOf(messages[0]!)}`
              : `（本机时间，正序；**翻页不改已读**）· ${whereOf(messages[0]!)}`),
            // 翻页那一屏**不加提及标记**（`mentioned` 缺席 = 空集）：往回翻是"她主动去看一段历史"，
            // 那一屏里点了她的话不构成"现在有人在叫她"——加了标记反而会把旧 @ 说成新的。
            // 所以年龄格在这里也不出现（`watermark: 0` 让"哪条算旧"这个判据无事可做）。
            ...renderReadBatch(batch, sessionEntryOf(messages[0]!), messages[0]!, undefined, {
              nowMs: readAtMs,
              watermark: 0,
            }),
            // 这一屏之后还有没有更早的？宿主只回"最近 limit 条"，**它不回"是不是到日志开头了"**
            // （`readChannelMessages` 的窗口语义），所以判据取保守的那一侧：这一屏**装满了**
            // （`pool` 有 limit 条以上）就照实说"想接着往回翻"——多说一句的代价是白翻一次，
            // 而少说一句的代价是**她以为到头了**，那一段就再也看不见了。
            pagingFooter({
              nextBefore: eventSeqOf(batch[0]!),
              more: pool.length >= limit,
              // "装不下了"就如实提醒她把 limit 调大——一页 15 条是**默认**，上限是 100
              truncated: pool.length > limit,
              limit,
            }),
          ].join('\n'));
        }
        const messages = await channelReader(sid, limit);
        // 她自己在这个会话里说过的话（`speak` 的投递回执归并而来；没接线就是空）。
        // **它不扩窗**：下面按时间轴插进去之后再压回 limit，所以这一屏最多还是 limit 行
        //（她的发言也占行——见 mergeChannelSpeech 的取舍说明）。
        const spoken = channelSpokenReader === null ? [] : await channelSpokenReader(sid);
        /**
         * 群里发生过的事（`channel/notice`：谁开了全员禁言、谁入群退群、谁撤回了一条……）。
         *
         * **它也不扩窗**（与她的发言同一条规矩）：插进池子、与消息同一条时间轴，
         * 最后一起压回 `limit` 行。她读的那个群"这段时间里发生过什么"就是这一屏。
         */
        const notices = channelNoticeReader === null ? [] : await channelNoticeReader(sid, limit);
        /**
         * 她自己的管理动作（`channel/self-action`：「我做过」）。
         *
         * **它也不扩窗**（与她的发言、群里的动静同一条规矩）：插进池子、与消息同一条时间轴，
         * 最后一起压回 `limit` 行。这是这条事件唯一的存在形式——平台不对她自己的动作发 notice，
         * 没有这一眼，她翻这个群时看不到"我设过全员禁言"。
         */
        const actions = channelSelfActionReader === null ? [] : await channelSelfActionReader(sid, limit);
        /**
         * 「这个会话里什么都没有」的判据**含她自己的动作**（与上一批把 notices 算进来同一个理由）：
         * 只做过事、没人说过话的会话（她刚建的群）读起来不该是"没有新消息"。
         */
        if (messages.length === 0 && notices.length === 0 && actions.length === 0) {
          // 第一句就是结论（2026-10-08 用户的口径）：这个会话里**一条都没有**，所以照实说
          // "没有新消息"，紧接着把两种可能说清（还没有过消息 / sid 写错了一位）——
          // 少了后半句，她只会知道"没有"，不知道该不该去核对 sid。
          return okResult(
            `没有新消息：${sid} 里没有取到消息`
            + '（这个会话可能还没有过消息，或者 sid 写错了一位）。'
            + '外部会话清单上现在有哪些会话，看当前状态层那一段。',
          );
        }
        // 这一屏的候选池：外部消息 + 群里动静 + 她自己的动作 + 她的行，按时间轴（**同一套排序**）
        const pool = sortByTimeline([...messages, ...notices, ...actions, ...spoken]);
        const prev = readState.get(sid);
        /**
         * 「上次查看读到哪」的水位（**事件 seq**）——判据只有这一处（v67，2026-10-17）。
         *
         * 用户 2026-10-17 的第一条口径原话：「`read_channel` 应当默认只展示上次查看以来的新消息。
         * 如果上次以来没有新消息就不展示。除非她自己填参数翻历史。不然每次读取都是大量输入。」
         *
         * 两个来源，按"手上有没有"二选一：
         *   • **本进程里读过**（`readState` 有它）⇒ 用那一格，与这一版之前逐字节相同；
         *   • **本进程第一次读**（含**重启后第一次**）⇒ 从**日志**读回来：会话簿的 `readUpToSeq`
         *     （`channel/read` 折出来的已读位，`collectSessions` 启动时折好），
         *     再由 `watermarkSeqOf` 换算成事件 seq。
         *
         * 为什么要这一步（重启后不再"照给最近一屏"）：实测 1227 次真实调用里 **458 次（37.3%）**
         * 拿回的是一屏**一条新的都没有**的旧内容，合计 491,315 字（占全部回执 **37.5%**）——
         * "宁可多给一次"那条既有取舍正是其中"重启后第一次"那一份的来源。账本来就在日志里，
         * 只是没读过。
         *
         * `readState` 仍然是缓存（它还记着 `pageBelow`/`pending` 这些只服务"下一屏措辞"的东西），
         * 但**"上次查看"这件事从今往后以日志为准**：重启不再把水位归零。
         *
         * 为什么水位用**事件 seq** 而不是 `msgSeq`（2026-10-05 修的真缺陷）：官方**单聊的 msgSeq
         * 恒为 1**（平台不给会话内序号，见 `channel/qq-official.ts` 的实证结论）。同一个进程里第二次
         * 读单聊，"这批最大的 msgSeq"还是 1 ⇒ 回一句"没有新消息"，哪怕用户这中间刚发了十条。
         * 事件 seq 没有这个毛病：新消息落库必得更大的 seq。
         *
         * 这个数**含她自己的凭据**（2026-10-07 修的缺陷，见 `SENT_CREDENTIAL_NOTE`）：她 report
         * 出站成功后的那一篇是一条 `speak/sent`，不是平台消息、原先不进这个数，于是"刚报告过、
         * 回头核对"必然得到「没有新消息」——她要找的那一行永远拿不到，她会据此再发一遍。
         */
        const durableMark = prev === undefined ? durableReadMark(sid) : 0;
        const prevSeq = prev?.seq ?? watermarkSeqOf(pool, durableMark);
        /**
         * 「这个会话她**一次都没读过**」——**两条都拿不到**才算（进程里没有、日志里也没有）。
         *
         * 那时照既有取舍办：把最近一屏给她（宁可多给一次，也别让她两手空空）。
         * 它也是老日志（事件没有 seq 字段、`eventSeqOf` 退回 0）唯一读得出来的路径。
         */
        const firstSight = prev === undefined && durableMark <= 0;
        /**
         * 这一屏取数的下界——**页脚那个游标的两个来源之一**。
         *
         * `< 取数下界` 恰好是"这一屏没覆盖到的那一段"：给过她的一条不重复，没给过的一条不落。
         * 为什么不拿"她看到的最旧那一条"当游标（先写成那样，实测踩到）：默认那一屏只挑提及，
         * "看到的"常常比"取到的"新——按它往回翻会**跳过取数窗口里没给她的那几条**
         * （它们既不在这一屏里、也不在下一页里）。
         *
         * ⚠ **v67 修的一处独立缺陷（2026-10-17；不在用户那两条口径里，是顺手修掉的）**：
         * 原来取的是**整个池子**最旧的那一条（`pool[0]`），而池子里的 `spoken` 是
         * `readChannelSpoken(sid)` 给回来的**她在那个会话里说过的全部**（无 limit、无 before）——
         * 于是 `pool[0]` 常常是她**几天前**的一句 `speak/sent`，页脚与"另有 N 条"从此**永久**
         * 指着那一天。实测（1227 次真实调用）：373 份有可解析页脚的回执里 **288 份（77%）** 的游标
         * 比同一屏的已读标记早 500 个事件以上，最陈旧的早 **119,152** 个事件（约 4–5 天）；
         * **90 次**她真照那个陈旧游标去翻了——`before=45995` 在五天里被抄了 5 次，每次都拿回
         * 同一屏 6566 字的 10-07/10-08 内容（seq 45995 已逐字核对：就是 10-07 的一句 `speak/sent`）。
         * 这正是"她往前翻、把旧提及当新的"那条路的机械原因。
         *
         * 现在取**取数窗口**（宿主这一次交给这一屏的 `messages`/`notices`/`actions`，各自都带窗口）
         * 里最旧的那一条；窗口为空（notice-only 且没接线之类）才退回 `pool[0]`——那条兜底只为
         * "别给 0"，不是为了覆盖她自己的发言。
         */
        const windowItems = [...messages, ...notices, ...actions];
        const fetchFloor = windowItems.length === 0
          ? (pool.length === 0 ? 0 : eventSeqOf(pool[0]!))
          : windowItems.reduce((min, item) => Math.min(min, eventSeqOf(item)), Number.POSITIVE_INFINITY);
        /**
         * 这一批里**最新**的那一条的 seq（含她自己发出去的凭据）——"她是不是已经读到最新了"的判据。
         *
         * 为什么不能用 `fetchFloor` 判这件事（写下这条注释时刚踩到）：取数窗口由 `limit` 决定，
         * 而 `limit` 比整个待读区间窄是常态（默认 20）。这一屏只覆盖"最近 20 条"时，下界**必然**
         * 低于已读位——拿它去比，会把"窗口之外还有没读的旧话"误判成"她没有新消息"
         * （她会得到一句"没有新消息"，而这句话是假的）。
         */
        const newestSeq = pool.reduce((max, item) => Math.max(max, eventSeqOf(item)), 0);
        /**
         * 这一屏的候选：**她上次查看之后的东西**（v67 起这就是"默认那一屏"的全部候选）。
         *
         * 判据两条，都是刻意的：
         *   • **一次都没读过**（`firstSight`）⇒ 全部算候选。这与"宁可多给一次、也别让她两手空空"
         *     那条既有口径同源，也是老日志（事件没有 seq 字段、`eventSeqOf` 退回 0）唯一读得出来的
         *     路径；
         *   • 否则按**事件 seq > `prevSeq`** 取——严格单调、重放稳定，且**无论哪个平台都拿得到**
         *     （`msgSeq` 在官方单聊恒为 1，判不了"新不新"，见上面 `prevSeq` 那段）。
         *
         * `prevSeq` 里**含她自己的凭据**（2026-10-07 修的缺陷，见 `SENT_CREDENTIAL_NOTE`）：
         * 她 report 出站后那一篇是一条 `speak/sent`、不是平台消息；不含它的话，"刚报告过、
         * 回头核对"必然得到「没有新消息」——她要找的那一行永远拿不到，她会据此再发一遍。
         */
        const unread = firstSight ? pool : pool.filter((item) => eventSeqOf(item) > prevSeq);
        /**
         * 往回翻的落点（＝页脚或"没有新消息"那句话里让她填进 `before` 的那个数）。
         *
         * 规则一句话：**"还没给她看过的那一段"从哪里开始**——取"取数下界"与"最旧那条没给她的"
         * 里更早的那个。两者都要，因为两种错都很贵：
         *   • 只看"她看到的最旧那一条" ⇒ 会**跳过取数窗口里没给她的那几条**（既不在这一屏、
         *     也不在下一页 ⇒ 空洞）；
         *   • 只看"最旧那条没给她的" ⇒ 在"全给过了"时会指到自己那条上（下一页把同一批再摆一遍）。
         * 取更早的那个只会让她在下一页**多看几条已经看过的**（无害）；两种错里任何一种都会让她
         * **看不到**那一段（有害）。所以宁可重复，也不许漏。
         *
         * ⚠ v67：**她自己的发言不参与这个下界**（`isChannelSpoken` 那一支跳过）——`fetchFloor`
         * 上那条修的是同一个病害的另一半：她自己的行**本来就走同一条翻页游标**
         *（翻页分支把 `spoken` 按同一个 `before` 切），让它去定下界换不来任何"多看一条"，
         * 只会把游标拽回几天前。
         */
        const unreadFloor = unread.reduce(
          (min, item) => (isChannelSpoken(item) ? min : Math.min(min, eventSeqOf(item))),
          Number.POSITIVE_INFINITY,
        );
        const pageBelow = Math.min(fetchFloor, Number.isFinite(unreadFloor) ? unreadFloor : fetchFloor);
        /**
         * 这一屏之后**还有没有更早的**（页脚照它说"想接着往回翻"还是"到头了"）。
         *
         * 判据取保守的那一侧：取数窗口**装满了**（`limit` 条）就说还有——宿主只回"最近 limit 条"，
         * 它**不回"是不是到日志开头了"**，所以取满时不能替她断言"到头了"。多说一句的代价是白翻一次，
         * 少说一句的代价是**她以为到头了**——那一段就再也看不见了。
         */
        const moreBelow = pool.length >= limit;
        const caller = mentionMessage?.() ?? null;
        const calledThisTurn = caller !== null && caller.sid === sid;
        // ② 真的没有新东西 ⇒ 一句话打发，不把同一段再摆一遍（2026-10-02 用户报的实测：她在一轮里
        //    把同一个信箱连读了五遍、白花四个 step）。**但必须给她出路**（2026-10-08）：
        //    "没有新消息"若不带指路，她会读成"这里什么都没有"，而她要的旧话其实翻得到。
        //
        //    判据是 `unread`（＝"比已读位更新的那些"），**不是** `fetchFloor`：两者在窗口比待读区间
        //    窄时会分道扬镳，而那时"没有新消息"是假的（她会以为外面没人说话）。只有真的
        //    "这一批里最新那条也在已读位之内"才算读到最新——`newestSeq` 就是判它的那个数。
        if (unread.length === 0 && !calledThisTurn) {
          const times = bumpReadRepeat(ctx?.turn ?? 0, sid);
          // 措辞里点明"你自己发出去的那些不算新消息"：她刚 report/说过话、回头核对时，最怕把
          // 「没有新消息」读成"我那一篇不在里面"——那正是"重复发"的触发条件（`SENT_CREDENTIAL_NOTE`）。
          //
          // 2026-10-08 用户的口径：「**read_channel，如果没有消息就直接回执没有新消息**」
          // ——回执的**第一句就是这四个字**（`没有新消息`），句号之前不许再堆任何东西：
          // 她要的是一眼可判的结论，而"这个位置含…"/"另有 N 条…"这类话都会让她怀疑自己漏了什么。
          // 只有**确实还有没给她看的未读**时才允许提数量，而这一支里一条都没有（见下面
          // `display.length === 0` 那一支：那里带 N，这里不带）——两种情形因此措辞可分。
          const mine = spoken.length === 0
            ? ''
            : '；你自己发出去的那些（行首 `（我）`）不算新消息';
          const way = moreBelow
            ? `要看更早的（连没点你的那些）就翻页：带上 ${cursorText(pageBelow)} 重读一次`
              + `（每页 ${READ_CHANNEL_PAGE_SIZE} 条，翻页不改已读）。`
            : '想看更早的没有了——这个会话能看到的就这些。';
          const head = times <= 1
            ? `没有新消息：${sid} 你已经读到最新了（停在 seq=${newestSeq}${mine}）。`
              + `不必再翻一遍——${way}想接着说就直接 speak，回不回、说什么都由你。`
            : `没有新消息：${sid} 这一轮你已经读过它 ${times} 次，再读返回的还是同一段`
              + `（停在 seq=${newestSeq}${mine}）。${way}想说话直接 speak 就行。`;
          // **她刚刚确认过"这儿没有新东西"——这条确认本身就是已读**（2026-10-24 修的 bug：
          // 用户原话「一旦 read_channel 过对应的群聊之后，就不把未读标签取消掉了。直到再次有
          // 未读消息」）。原实现只有"摆出了东西"才写已读位，于是这里的一句话回执什么也不留：
          // 界面那一栏算的是 `msgSeq > readUpToSeq` 的条数，已读位不动它就永远停在旧水位上
          // ——实测用户截图上 418 / 1151 / 510 / 392 那几个群全是这个形状。
          //
          // 推到哪：**这一屏取数窗口里最新那条消息的平台序号**（`readMarkOf(pool)`；窗口就是
          // "最近 limit 条"，所以它就是此刻这个会话的最新）。为什么是安全的：走到这里说明
          // `unread` 一条都没有（＝没有任何东西比她的水位更新），窗口里那些她要么已经看过、
          // 要么本来就压在已读位之内，推到一个她够得着的位置不会把任何一条没给她的话标成已读。
          advanceReadUpTo(readMarkOf(pool));
          return okResult(head);
        }
        /**
         * 这一屏给她什么，**两个分支，判据都写在这里**（她与事后读日志的人都按这几条核对）：
         *
         *   ① **这个会话她一次都没读过**（`firstSight`：进程里没有、日志里也没有已读位）
         *      ⇒ 把最近一屏照给她（"宁可多给一次"那条既有取舍的落点，也是老日志唯一的读法）。
         *      它同时是"叫她的那条"的兜底——`tailWindow` 会从叫她那条往回数（见那边）。
         *   ② 其余**一律走 `incrementalWindow`**：只给"上次查看之后"的（v67 用户的第一条口径），
         *      其中提及与"本轮叫她的那条"不许被 `limit` 挤掉。细节与取舍见那个函数。
         *
         * 为什么把 2026-10-08 那版"未读装得下一屏就全给 / 否则只给提及+前十条"整个换掉：
         * 那一版把默认屏变成了"提及屏"——没被点到的日子她读不到正聊的内容（她自己的绕道姿势是
         * "带上翻页游标读当前在聊的那一屏"，见 2026-10-09 的复盘），而**一条新的都没有**时它还会
         * 照给一整屏旧内容（实测 458 次 / 491,315 字，见 handler 开头 `durableMark` 那段）。
         */
        const digest: DigestView = firstSight
          ? tailWindow(pool, limit, calledThisTurn ? (caller?.messageId ?? null) : null)
          : incrementalWindow(unread, pool, limit, calledThisTurn ? (caller?.messageId ?? null) : null);
        const display = digest.items;
        // ④ **已读只推进到"确实给她看过的那几条"**（用户 2026-10-08 的第二条口径原话：
        //    「不视作已处理。提示她还有没看到的，往上翻页」）。判据是这一屏里最大的一条的事件 seq：
        //      · 没给她的那些（掉在 limit 之外、或本来就没提及）**保持未读**，于是下一次读
        //        她**仍然会被告诉"还有没看到的"**——这正是用户要的；
        //      · 往回翻的那条路上面已经 return 了，碰不到这两行。
        const shownUpTo = display.reduce((max, item) => Math.max(max, eventSeqOf(item)), prevSeq);
        /**
         * 「这一屏之后**还有几条新的没摆下**」——判据是 `unread` 里没出现在屏上的那些（v67）。
         *
         * 与这一版之前的区别（那时数的是"池子里比这一屏更新的、还没给她看的**别人的话**"）：
         *   · **现在数的是"新的"**（四类来源全算：别人的话、她自己的行、群里的动静、她做过的事）。
         *     为什么不再把 notice 与她自己的行排除在外（旧注释的理由是"那句话问的是还有多少
         *     **别人的话**你没看"）：这一句现在问的是"**这一屏没装下什么**"，而它给的那个游标
         *     捞回来的正是这些——两头口径不一致的话，她照着游标翻过去会发现数目对不上
         *     （实测形状：她自己的发言是**无界**的，未读多过一屏时被挤掉的往往正是它们）。
         *   · 措辞因此跟着改成"**条新的**"：一个"新"字对四类来源都成立，"条消息"只对其中一类成立。
         */
        const shownSeqs = new Set(display.map((item) => eventSeqOf(item)));
        const notShown = unread.filter((item) => !shownSeqs.has(eventSeqOf(item))).length;
        /**
         * 那一批"没摆下的新消息"该从哪个游标翻回来（**与页脚那个不是同一个数**）。
         *
         * 取**最旧的那条没摆下的新消息**的下一位（`seq + 1`）。为什么要它、而不是"这一屏最旧那条"
         * 或页脚那个 `pageBelow`：
         *   · 默认那一屏是从**新的一头**往下装的，所以没摆下的恰好是**最旧**的那几条；
         *     翻页是严格向下（`seq < before`），游标必须**高于**它们全部才捞得回来
         *     ——所以取"最旧那条没摆下的"再抬一位，正好把它们连同更早的一段一起给她；
         *   · `pageBelow` 是**取数窗口**的下界（比这一批更早），照它翻会**跳过**这一批
         *     （实测形状：她照着页脚跟过去，却怎么也读不到那句"还有 N 条"说的是哪几条）；
         *   · 拿"这一屏最旧那条"当游标只在"没摆下的全在它下面"时才对——而提及是被**例外**
         *     强行摆进来的（它可能比没摆下的那几条更旧），那时这个前提不成立。
         *
         * 一条都没摆下时（理论上到不了）退回 `pageBelow`——宁可指远，不指空。
         */
        const unshownNew = unread.filter((item) => !shownSeqs.has(eventSeqOf(item)));
        const newestUnshown = unshownNew.at(-1);
        const newCursor = newestUnshown === undefined ? pageBelow : eventSeqOf(newestUnshown) + 1;
        if (display.length > 0) {
          // 已读那笔账的**唯一一处**写入：平台序号（"这条是这个会话里的第几条"），只由**别人**的
          // 消息推进——她自己的发言从不把自己算成未读（见 mergeChannelSpeech ②）。
          // 平台给不出时宿主填的就是事件 seq（`channel/inbox.ts` 的 `msgSeqOf`）。
          //
          // **只推到"这一屏里真的出现过的那几条"**：没给她的那些保持未读（用户 2026-10-08 的
          // 第二条口径）。她自己的行不参与（`isChannelSpoken` 那一支直接跳过）——那从来不是"未读"。
          // 群里动静同样不参与：它没有"这个会话里第几条"的语义（未读只数别人的话）。
          // 这条判据收在 `readMarkOf` 里（另外两条会写已读的路也走它）——一份口径，不是三份。
          markReadUpTo(readMarkOf(display));
        }
        readState.set(sid, {
          seq: Math.max(shownUpTo, prevSeq),
          limit,
          // "还有 N 条没看到"那句的判据：N 没变就不再重复说一遍（同一批连读两次不该把同一句
          // 提示摆两遍）。N 变了（又来了没提及的新话）就照说——那句提示是**新的信息**。
          pending: notShown,
          // 页脚那个落点（见上面 `pageBelow` 的口径说明）：只用于"她下次翻页该填哪个数"，
          // 与判"新不新"的 `seq` 是两件事，所以分开记、只增不减地往前推。
          pageBelow,
        });
        bumpReadRepeat(ctx?.turn ?? 0, sid);

        if (display.length === 0) {
          // **兜底**（v67 起这一支理论上到不了）：默认那一屏要么给出"上次查看之后"的至少一条，
          // 要么给出"本轮叫她的那条"，要么退回最近一屏（见 `incrementalWindow` 的两处兜底）。
          // 留着它是"宁可说一句'没有新消息'，也不要给她一个空框"那道闸——`renderReadBatch`
          // 拿到空批会印出一个 `count=0` 的框，那比一句话难读。
          //
          // 措辞与上面那一支**必须分得开**：那一支是"确实没有新的"（不带数），这一支**一定带数**
          //（走到这里说明 `unread` 非空、只是没摆上）。她把两句话一比就知道是哪种。
          return okResult(
            `没有新消息：${sid} 有 ${notShown} 条新的这一屏摆不下`
            + `——想看就翻页：带上 ${cursorText(newCursor)} 重读一次`
            + `（每页 ${READ_CHANNEL_PAGE_SIZE} 条，翻页不改已读）。`,
          );
        }

        const anchor = display.find((item): item is ChannelMessageView => !isChannelSpoken(item))
          ?? messages[0]!;
        const mineCount = display.filter(isChannelSpoken).length;
        const atCount = display.filter((item) => digest.mentioned.has(eventSeqOf(item))).length;
        // 头一行把这一屏的成分说清：几条在点她、其中她自己的几行——她据此决定要不要接着翻
        //（不报的话，"我说过的话怎么不见了"在下一次读更窄的窗口时会变成一次误判）。
        const composition = (atCount === 0 ? '' : `，其中点你的 ${atCount} 条`)
          + (mineCount === 0 ? '' : `，其中你自己的发言 ${mineCount} 行`);
        /**
         * 头一行（v67 起**先说清"这是增量"**——她照这一行判断"要不要接着往下看"）：
         *   · 一次都没读过 ⇒ 直说"第一次读它，先给最近 N 条"（不谎称"上次看过之后"）；
         *   · 一条新的都没有、只有本轮叫她的那条 ⇒ 直说"没有新的，下面这条是**这一轮叫你的那条**"
         *     ——那一行自带年龄格（`【这条提及是 4 天前的——不是新消息】`），两处一起把
         *     "别把旧 @ 当成刚叫人"这件事说死；
         *   · 其余 ⇒ "上次看过之后 N 条新的（这一屏摆了几条）"。
         */
        const head = firstSight
          ? `${sid} 第一次读它，先给最近 ${display.length} 条${composition}`
            + `（本机时间，正序；已标记读过 seq=${shownUpTo}） · ${whereOf(anchor)}`
          : unread.length === 0
            ? display.length === 1 && atCount === 1
              ? `${sid} 上次看过之后**没有新的**——下面只有这一轮叫你的那条`
                + `（**不是新消息**；本机时间） · ${whereOf(anchor)}`
              : `${sid} 上次看过之后**没有新的**；叫你的那条已经不在最近的 ${limit} 条里了`
                + `——下面给的是最近 ${display.length} 条（本机时间，正序） · ${whereOf(anchor)}`
            : `${sid} 上次看过之后 ${unread.length} 条新的（这一屏摆 ${display.length} 条${composition}）`
              + `（本机时间，正序；已标记读过 seq=${shownUpTo}） · ${whereOf(anchor)}`;
        // 「还有 N 条新消息没摆下」只在"确实有没摆上的新消息"时出现（判据只有 `notShown` 一个）；
        // 与上一屏同一个数就不重复说（除非这一轮是它在叫她——她正要回那句话，这个数有用）。
        //
        // 游标是 `newCursor`（**这一屏最旧的那条新消息**）而**不是**页脚那个 `pageBelow`：
        // 这一批没摆下的就在它下面，照页脚翻会跳过它们（口径见上面 `newCursor` 那段）。
        const pending = notShown > 0 && (notShown !== prev?.pending || calledThisTurn)
          ? `另有 ${notShown} 条新的这一屏没摆下——往上翻页：带上 ${cursorText(newCursor)} 重读一次`
            + `（每页 ${READ_CHANNEL_PAGE_SIZE} 条，翻页不改已读）`
          : null;
        // 点名例外（2026-10-11 用户拍板）：这一屏里点了她的那些，图按现有准入装配进上下文。
        // **必须在 renderReadBatch 之前**：那一行写的"已带进上下文"指的就是这里写下去的事件。
        attachAimedImages(display);
        return okResult([
          head,
          ...renderReadBatch(display, sessionEntryOf(anchor), anchor, digest.mentioned, {
            nowMs: readAtMs,
            watermark: prevSeq,
          }),
          // 默认那一屏**也要给"下一页怎么翻"**（2026-10-08：返回里必须告诉她还有没有更多、
          // 下一页怎么翻；不给的话她只能反复拉同一屏）。游标是这一屏取数的下界：
          // 翻过去正好接上"这一屏之前"的那一段，不重不漏；上面真的没有更早的了就如实说。
          pagingFooter({
            nextBefore: pageBelow,
            more: moreBelow,
            truncated: false,
            limit: READ_CHANNEL_PAGE_SIZE,
          }),
          ...(pending === null ? [] : [pending]),
        ].join('\n'));
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── ask_human（v27 删过，design §6.5 恢复"问"、明确不许"等"） ──
  //
  // 与当年那件的区别只有一个，但正是关键的那个：**它不挂起 turn**。
  // 旧实现写完 `human/asked` 就停在这儿等人答（默认 24h 超时按预算耗尽暂停），无人值守里
  // 几乎总是浪费——她自己的结论是"你常不在，我宁可写文件等你"。现在她写完就接着做自己的事，
  // 人的答复在下一拍的状态里看到（`render` 把 `human/answered` 注入成「人工回答」）。
  //
  // 事件层靠 `source: 'agent'` 把"她问的"与"计划模式问的"分开：只有后者才挂起
  // （agent-loop 的 `hasPendingPlanAsk` 只认计划审批那一条，见 runtime/plan-mode.ts）。

  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_HUMAN_TIMEOUT_MS;

  const askHuman: ToolDefinition = {
    name: 'ask_human',
    description:
      '有件事只有人知道时，把问题留给他（弹一张卡，人回来才看得到）。**不占这一轮**：'
      + '写完继续做你的事，他的答复会在稍后的上下文里出现。问不到人就自己换个方式找人，不必等。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要他回答的那一句（问清一件事，不要塞多件事）' },
        context: { type: 'string', description: '为什么问、你已经查到哪一步（他看得到，用来少问一轮）' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    executionMode: 'parallel',
    sideEffect: 'idempotent',
    timeoutMs: 5_000,
    handler: async (rawArgs, ctx): Promise<ToolHandlerResult> => {
      try {
        const args = argsRecord(rawArgs, 'ask_human');
        const question = requiredString(args, 'question', { maxLength: ASK_QUESTION_MAX });
        const context = optionalString(args, 'context', { maxLength: ASK_CONTEXT_MAX }) ?? '';
        emit('human/asked', {
          question,
          context,
          // turn 从执行上下文来（不是猜的）：卡面、CLI 的 status 与复盘都靠它定位"这是哪一轮问的"
          turn: ctx.turn,
          source: 'agent',
        }, defaultVisibility('human/asked'));
        return okResult(
          '问题已经挂到人审卡上（human/asked，来源 agent）。\n'
          + '**这一轮不会挂起**：你写完就继续做自己的事，或者就此收尾——不要在这里等人回答。\n'
          + '人的答复会以「人工回答」出现在你稍后的上下文里；'
          + `${waitBudgetText(askTimeoutMs)}，会有一条「未批准、未拒绝」的事实告诉你他可能不在机器旁。\n`
          + '要不要换个方式找他（例如走 QQ）由你判断。',
        );
      } catch (err) {
        return errorResultFromThrown(err, TOOL_ERROR_CODES.invalidArgs);
      }
    },
  };

  // ── send_media ──
  //
  // 为什么单独一件工具、而不是给 speak 加参数：官方口径**一条消息只带一个 media**，而她说话
  // 是按标点拆成好几条的（speak 的全部价值就在那个拆法上）。混在一起要么破坏拆句、要么让
  // "图配文"变成一条没有文字的消息。分开两件，各做各的一件事。
  const sendMedia: ToolDefinition = {
    name: 'send_media',
    description:
      '把一个媒体（图片/语音/视频/文件）发给某个会话：本机文件用 path、网上的用 url。'
      + '一次一个文件；要配说明文字就另外调一次 speak。'
      // **"哪条通道发得了媒体"不进描述**（2026-10-07 用户的口径）：那是通道专属的机制，
      // 而这里的话对每条通道一起说。**做不到时不假装**——发不出去就由回执如实说清是哪条通道、
      // 为什么不行；她据此决定要不要换个会话或换个方式，不必先背一张通道能力表。
      + '有通道发不了媒体——回执会如实说明。'
      // v72：能力披露进描述（实测 +31 token，单件 51 → 82，硬门 100 仍过）。它原先只在**回执**里
      // 说，于是"先答应再发现撤不掉"这件事只在她动手**之后**才被纠正；而 `description` 是她动手
      // 之前唯一会读到的常驻文本。判据与回执同源：回执里那串就是 `MESSAGE_ID_MARK` + id
      // （`mediaReceiptIdLine`），`read_channel` 行尾也是同一串 ⇒ 三处同一个串。
      // 代价：`tools` 段换代（v72 那一批），pin 见 `tool-catalog` / `read-channel-incremental` / `send-media`。
      + '想之后撤回的话，发之前先确认这条通道会返回消息 id（回执里带 ·m<id> 才算）：不返回就别承诺能撤。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本机文件路径：相对 data\ 或仓库根解析，且必须落在 data\ 或仓库根之内（与 url 二选一）' },
        url: { type: 'string', description: '网络地址（与 path 二选一）' },
        kind: {
          type: 'string',
          enum: ['image', 'video', 'voice', 'file'],
          description: '媒体类型，默认 image',
        },
        to: { type: 'string', description: '会话 sid（缺省 = 本轮叫你的那个会话）' },
      },
      required: [],
      additionalProperties: false,
    },
    executionMode: 'exclusive',
    sideEffect: 'destructive',
    timeoutMs: 90_000,
    handler: async (rawArgs, ctx) => {
      const args = argsRecord(rawArgs, 'send_media');
      if (mediaPoster === null) {
        return errorResult(
          '这台机器没有装配媒体投递口（没有可发消息的通道），发不出去。',
          TOOL_ERROR_CODES.notConfigured,
        );
      }
      const rawPath = optionalString(args, 'path') ?? '';
      const rawUrl = optionalString(args, 'url') ?? '';
      if ((rawPath === '') === (rawUrl === '')) {
        return errorResult('path 与 url 必须给且只给一个。', TOOL_ERROR_CODES.invalidArgs);
      }
      // **网络地址那一支也过同一道门**（2026-10-18，review P1-11）：url 只收 http(s)。
      // 理由不是洁癖：`file:` / 盘符 / UNC 形态的"url"到了通道层就是一条**本机路径**
      // （OneBot 的消息段把 `file` 原样交给协议端，协议端会在本机读盘），等于绕开凭据门
      // 把本机文件递出去；而 `path` 那条路有信任边界、也有凭据门（`refuseProtected`）。
      // 所以本机文件一律走 `path`，这条判据同时封掉"用 url 形状夹带本机文件"的写法。
      if (rawUrl !== '') {
        let protocol = '';
        try {
          protocol = new URL(rawUrl).protocol;
        } catch {
          protocol = '';
        }
        if (protocol !== 'http:' && protocol !== 'https:') {
          return errorResult(
            'url 只接受 http(s) 地址。本机文件请用 path——那条路会先过信任边界与凭据门，'
            + '本机路径不能当 url 交出去（协议端会照它去读盘）。',
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
      }
      const kind = optionalString(args, 'kind') ?? 'image';
      const fileType: MediaFileType =
        kind === 'image' ? 1 : kind === 'video' ? 2 : kind === 'voice' ? 3 : 4;
      const resolved = resolveTarget(optionalString(args, 'to') ?? '', ctx);
      if (resolved.error !== undefined) {
        return errorResult(resolved.error, TOOL_ERROR_CODES.invalidArgs);
      }
      const target = resolved.target;
      if (target === null) {
        return errorResult(
          '这一轮没有可发消息的会话（本轮不是 IM 唤醒，也没给 to）——媒体没发出去。',
          TOOL_ERROR_CODES.invalidArgs,
        );
      }
      // v64：本机文件先过**与 fs 族同一张别名表**（`MEMORIES/`、`diary/` 落记忆目录）再交给投递口。
      // 判据（用户 2026-10-13）：**具名根在所有工具里语义必须一致（含 send_media）**，而且
      // **回执里印出来的路径形态要能直接喂回任何接受路径的工具**。
      //
      // ② **出站类按"写"处理**（用户 2026-10-13 的裁决）：她实测 `http_download` 能直接写桌面、
      // 而 `send_media` 只认工作区——**两者相反**。统一口径：**往外送东西 = 往盘上写东西**（都离开
      // 她自己的地盘）⇒ `workspace` 档下受边界约束并**明确拒绝 + 说明原因**；`full` 档（默认）
      // **不限制路径**（`send_media` 不再"只认工作区"，与 `http_download` 一致）。
      // 判据落在 `boundaryRootFor('write', ctx)`（与 fs 的写类同一处），**不在投递口那一层**
      // （`channel/media-poster.ts` 的根校验是另一条判据：它保护的是宿主，原样保留）。
      const mediaPath = rawPath === ''
        ? ''
        : expandAliases(rawPath, pathAliasesFor(ctx), ctx.workspaceRoot);
      let outboundBytes: Buffer | null = null;
      let absolute = '';
      if (mediaPath !== '') {
        absolute = isAbsolute(mediaPath) ? mediaPath : resolve(ctx.workspaceRoot, mediaPath);
        const boundary = boundaryRootFor('write', boundaryDecision(ctx).boundary);
        if (boundary !== null) {
          let realBoundary: string;
          let realTarget: string;
          try {
            realBoundary = await realpath(boundary);
            realTarget = await realpath(absolute);
          } catch (err) {
            return errorResult(
              `发不出去：路径解析失败（${toErrorMessage(err)}）。`
              + (boundary === ctx.workspaceRoot
                ? '当前只允许发送工作目录内的文件——要发别处的文件，请让人把 config.json 的 trust.mode 改成 \'full\'。'
                : `当前只允许发送 ${boundary} 之内的文件。`),
              TOOL_ERROR_CODES.invalidArgs,
            );
          }
          if (!isInside(realBoundary, realTarget)) {
            return errorResult(
              outsideBoundaryReason({
                subject: '要发送的文件',
                effective: realTarget,
                boundary: realBoundary,
                implicitBoundary: !boundaryDecision(ctx).explicit,
              }),
              TOOL_ERROR_CODES.invalidArgs,
            );
          }
        }
        // 读成字节再交给投递口：`full` 档下允许发工作区外的文件，而投递口自己只收
        // `data\` 或仓库根之内的路径 ⇒ 由**工具层**（唯一知道 trust.mode 的地方）把政策判完，
        // 投递口只负责"把这份字节发出去"。读不到就如实报，别让上游拿到一个空文件。
        //
        // **读之前先量大小**（2026-10-18，review P1-09）：投递口那道 200MB 门只认 `path`，
        // 而 v64 起我们递的是 `data`（走早退，一次 `stat` 都不跑）⇒ 整份文件先进了内存才谈得上
        // "超没超限"，闸门等于不存在（几百 MB 的文件峰值 7–8×，可 OOM 整个进程）。
        // 这里与投递口引**同一个常量**（`MEDIA_MAX_BYTES`），超了当场拒、一个字节都不读。
        // ⚠️ `stat` 与 `readFile` 之间仍有一个 TOCTOU 窗口（文件在那一瞬长大）：这一瞬漏过去的话，
        // 投递口那一侧的第二道门（按 `data.byteLength` 判）会把它拒掉——但那时内存已经付出了。
        // 所以这条门的定位是"别把内存打爆"的粗线，不是安全边界。
        // 上限可注入（`mediaMaxBytes`，2026-10-21）：生产取 `MEDIA_MAX_BYTES`，测试取几字节
        // ——判据本身逐字不变，变的只是"数从哪儿来"（原来那份 200MB 夹具的来历见该选项的注释）。
        try {
          const info = await stat(absolute);
          if (!info.isFile()) {
            return errorResult(`发不出去：${mediaPath} 不是一个文件。`, TOOL_ERROR_CODES.invalidArgs);
          }
          if (info.size > mediaMaxBytes) {
            return errorResult(
              `发不出去：${mediaPath} 有 ${info.size} 字节，超过单文件上限 ${mediaMaxBytes} 字节；`
              + '这么大的东西没有通道发得了，也不该整份读进内存——请在盘上切开，或换个方式给她。',
              TOOL_ERROR_CODES.invalidArgs,
            );
          }
        } catch (err) {
          return errorResult(
            `发不出去：读不到 ${mediaPath}（${toErrorMessage(err)}）。`,
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
        try {
          outboundBytes = await readFile(absolute);
        } catch (err) {
          return errorResult(
            `发不出去：读不到 ${mediaPath}（${toErrorMessage(err)}）。`,
            TOOL_ERROR_CODES.invalidArgs,
          );
        }
      }
      const media: MediaRequest = {
        fileType,
        ...(rawPath === ''
          ? { url: rawUrl }
          // 本机文件：**字节与路径一起给**（2026-10-17 起；2026-10-18 起**四种 kind 都给**）。
          //   · 字节是各通道的通用来源（OneBot 的图/视频/语音段只认 `base64://`）；
          //   · 路径是 OneBot **文件**那条的硬要求（`upload_*_file` 要本机路径，见
          //     `channel/onebot.ts` 的 `oneBotMediaCall`）——少了它，`kind:file` 永远报"要一个本机路径"；
          //   · 更重要的是：**投递口的凭据门只认 `path`**（`refuseProtected`）。过去只有 `kind:file`
          //     带它 ⇒ 默认的 `kind:image` 把 `.keys.json` 的字节交给通道时那道门一次都没跑
          //     （review P1-11，b8b40e5 的未修完残留）。四种 kind 都带之后，门对每一条都生效。
          //     载荷里多出 `path` **不改任何通道的请求字节**：官方上传只读 `data`/`url`
          //     （`QqMediaInput` 里根本没有 path），OneBot 的图/视频/语音段只认 `url` 或 `base64://`。
          // `name` **仍然只给文件类**：它会被官方写成 `file_name`、被 OneBot 视频段拿去命名，
          // 而图/视频/语音过去没有它 ⇒ 那三格保持逐字节相同（`test/send-media.test.ts` 有回归用例）。
          : {
            data: outboundBytes ?? Buffer.alloc(0),
            path: absolute,
            ...(fileType === 4 ? { name: basename(absolute) } : {}),
          }),
      };
      const outcome = await mediaPoster.post(target, media);
      if (!outcome.ok) {
        // **失败那一路保持详细**（v76 的边界，与成功那行相反）：她要知道"一条都没出去"和原因。
        // 单条媒体只有 0/1 两种可能，所以这里写死 0 条；原因沿用通道原话（那是她判断
        // "换条通道 / 换个会话 / 稍后再试"的唯一依据，压不得）。
        return errorResult(`已发出 0 条 · 发送失败：${outcome.reason}`, TOOL_ERROR_CODES.notConfigured);
      }
      // 同一条凭据判据（`deliverToSession`）：媒体没有正文，`text` 给**这一行的可读摘要**
      // ——它同样是"她发出去过"的事实，`read_channel` 的"我说过什么"里该有一行。
      // 原来这里只写 `{channel,sid,chars:0}`：她发完图去翻会话，那一行不在（与 report 同款病害）。
      emit('speak/sent', deliverToSession({
        sid: target.url,
        text: `［${kind === 'image' ? '图' : kind === 'video' ? '视频' : kind === 'voice' ? '语音' : '文件'}］`,
        parts: 1,
        chars: 0,
        callId: ctx.callId,
        turn: ctx.turn,
        // **平台回的这条消息 id 回填到凭据里**（2026-10-18，review P1-12）：通道层过去在
        // `createChannelMediaPoster` 里把它窄化掉了，于是 `read_channel` 的（我）行没有
        // `·m<id>`，OneBot 的图/视频/语音**撤不掉**（self 回声整条被丢弃，日志里也推不出来）。
        // `kind:file` 走 `upload_*_file`（那个动作回的是 file_id）⇒ 这一格缺席，不是空串。
        ...(outcome.messageId === undefined ? {} : { messageId: outcome.messageId }),
      }) satisfies SpeakSentPayload);
      /**
       * 回执（v76 压到极限）：**一行**，四件事按"她判断下一步"的顺序排——
       * `已发出 N 条`（成功没有）· `投递成功` · 发到哪儿 · 平台消息 id。
       *
       * 判据（2026-10-21 审计 P1，读数在 `_research/KV-AUDIT-2026-10-21.md` ③-2）：
       * 单条成功回执从 **316–336 字符**压到"固定 30 字符 + sid + id"；历史窗口里 121 条
       * ⇒ 常驻从 **39,802 字符 / 15,355 估算 token** 降到约四分之一。
       * **样板不在这里**（"不必重复发送 / `read_channel` 的 `（我）` 行 / id 用来撤回"）：
       * 它搬进了 `SELF_BRIEF` §2.1，一次、可命中——回执是**逐轮重发**的，样板放在这里
       * 等于每条都付一次全价（v74 对 `speak`/`report` 已经这么做过，`send_media` 漏了）。
       *
       * **红检**（防"她以为没发出去 ⇒ 重复发图"复发）：`test/send-media.test.ts` 断言成功回执
       * **必须**出现"已发出 N 条"这层意思 + `投递成功`，且样板**只**在 `SELF_BRIEF` 里出现。
       *
       * 目标：**指向本轮会话**（没给 `to`，或 `to` 就是本轮那个会话）⇒ 印 `本会话`（不占 38 字符的
       * sid）；发给**别的**会话才印 `已发往 <sid>`——那一格是"我以为发给了这个人、其实发到了别人"
       * 的唯一防线，只有跨会话那一路才需要它。
       */
      const where = resolved.atCurrent === true ? '本会话' : `已发往 ${target.url}`;
      return okResult(`已发出 1 条 · 投递成功 · ${where} · ${mediaReceiptIdLine(outcome.messageId)}`);
    },
  };

  const tools: readonly ToolDefinition[] = [
    writePersona,
    timer,
    speak,
    report,
    todo,
    readChannel,
    sendMedia,
    askHuman,
  ];

  const index = new Map<string, ToolDefinition>(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    byName(name: AdminToolName): ToolDefinition {
      const found = index.get(name);
      if (found === undefined) throw new Error(`未知的管理工具：${name}`);
      return found;
    },
  };
}

// ──────────────────────────────── 内部：参数与格式化 ────────────────────────────────

/** `channel/read` 的负载形状（与 log/types.ts 的 ChannelRead.data 同形，这里只写工具侧要用的那份） */
interface ChannelReadPayload {
  sid: string;
  upToSeq: number;
}

/**
 * `read_channel` 的 limit：缺省值**按分支给**——默认那一屏 20（`READ_CHANNEL_DEFAULT_LIMIT`）、
 * 翻页模式（给了 `before`）15（`READ_CHANNEL_PAGE_SIZE`）；上限一律 100。
 *
 * **两个数各管一件事**（2026-10-08 的补充，别把它们混起来；2026-10-23 把缺省这一半补齐）：
 *   • 这里的 20 是**默认那一屏**的行数（v67 起那一屏是"上次查看之后"的增量，再压到 20 行）；
 *   • 翻页那一页是 `READ_CHANNEL_PAGE_SIZE`（15）——**缺省值有两档，由调用点按"有没有游标"选**，
 *     由页脚照本页实际的行数告诉她下一页怎么翻（口径只有一处，见 `pagingFooter`）。
 *
 * ⚠ **缺省值不许一处通用**（v80 那一批修的洞）：原来这里只有 20 一个缺省，于是"给 `before`
 * 不给 `limit`"实发 20 行，而默认那一屏的页脚照 `READ_CHANNEL_PAGE_SIZE` 说"一页 15 条"
 * ——她照页脚算翻页节奏就会算错（每页差 5 条），"页脚上的数字 == 实发行数"这条口径也破了一边。
 * 现在两档分开：无游标 20、有游标 15，页脚说什么、下一屏就真的发多少行。
 *
 * 上限不是"省 token"那么简单：她要是给个 100000，这一条工具结果就会把整段上下文挤掉——
 * 而工具结果是要**逐轮重发**的（不像日志读一次就完了）。宁可让她多调几次，
 * 也不要一次塞进来一份读不完的清单。
 */
function readLimit(raw: unknown, fallback: number = READ_CHANNEL_DEFAULT_LIMIT): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ToolArgumentError('limit', `limit 必须是数字，收到 ${JSON.stringify(raw)}`);
  }
  const value = Math.floor(raw);
  if (value < 1) {
    throw new ToolArgumentError('limit', `limit 至少是 1，收到 ${value}（要清空未读也一样：读一条就标记读了）`);
  }
  return Math.min(value, READ_CHANNEL_MAX_LIMIT);
}

/**
 * 解那个翻页游标（`before`）：**给不出来就当场报参数错并指路**，不静默给空。
 *
 * 为什么这里对字符串也宽容（与 `limit` 那种"非数字就拒"不同）：页脚印给她的正是
 * `before=1234` 这个形态，她原样抄回来是最自然的动作——`"1234"` 与 `1234` 对她来说是同一个
 * 意思，为这个把调用打回去只是白花一个 step。但**只认整串是正整数的**：`"12abc"`、`"1.5"`、
 * 负数、`"0"` 一律拒——它们都不是事件 seq，猜一个值比报错坏得多（猜错就是静默给了另一段历史）。
 */
function readCursor(raw: unknown): ReadCursor | null {
  if (raw === undefined || raw === null) return null;
  const text: unknown = typeof raw === 'string' ? raw.trim() : raw;
  // 空串当"没给"（有些调用方会顺手填一个空字符串）
  if (text === '') return null;
  const numeric = typeof text === 'number' ? text : typeof text === 'string' && /^[0-9]+$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(numeric) || Math.floor(numeric) !== numeric || numeric < 1) {
    throw new ToolArgumentError(
      'before',
      `before 是翻页游标，只认你在上一屏页脚看到的那个正整数的 seq：收到 ${JSON.stringify(raw)}。`
      + '页脚那一行长这样：`（想接着往回翻就带上 before=1234 重读，或者 limit 更大再看远一点）`'
      + '——把那个数原样填进 before 就行。不翻页就别给这个参数（默认那一屏就够了）。',
    );
  }
  return { before: numeric };
}

/** 一屏的**形状**：给她看的那些行、以及其中哪几条是"点了她"的（渲染只认这两样） */
interface DigestView {
  items: ReadChannelItem[];
  /** 这一屏里**点了她**的那些（按事件 seq）；渲染时行首加标记，判据只有这一份 */
  mentioned: ReadonlySet<number>;
}

/**
 * 默认那一屏的取法（**v67 起：只给"上次查看之后的"**）。
 *
 * 用户 2026-10-17 第一条口径原话：「`read_channel` **应当默认只展示上次查看以来的新消息**。
 * **如果上次以来没有新消息就不展示**。**除非她自己填参数翻历史**。不然每次读取都是大量输入。」
 *
 * 这一条**取代**了 2026-10-08 那版"未读里只挑提及 + 每条之前十条"（那版的用意是治刷屏，
 * 但它把"默认那一屏"变成了"提及屏"，于是没被点到的日子她读不到正聊的内容——她自己总结出的
 * 绕道姿势是"带上翻页游标读当前在聊的那一屏"，见 2026-10-09 那一拍的复盘）。
 * 实测代价（1227 次真实调用）：**458 次（37.3%）拿回的是一屏"一条新的都没有"的旧内容，
 * 合计 491,315 字 = 全部回执的 37.5%**。逐条规则：
 *
 *   ① **候选**：`unread`——事件 seq **大于水位**的那些（水位＝上次查看读到哪，见 handler）。
 *      已读过的一条都不再倒一遍；
 *   ② **主体**：候选里**最近的 `limit` 条**（从新的一头往下数）。丢掉的永远是**最旧**的普通
 *      新消息——最新的那几句才是"现在这儿在说什么"；
 *   ③ **三条例外**（都不许被 `limit` 挤掉）：
 *      · **新窗口里点了她的那些**：哪怕它已经掉在 `limit` 条之外，也要摆进来——它是叫她
 *        的那一句，看不见它就等于白叫（v28 的既有口径）；
 *      · **本轮叫她的那条**（`callerMessageId`）：**即使它压在水位之内**也要摆（那时它是一个
 *        **旧提及**，渲染会在同一行写明"不是新消息"）。为什么要它：这一轮就是它在叫她，
 *        而 v28 之后她手里只有通知、没有正文——不给这一行，她会得到一屏与那句原话无关的
 *        新消息（2026-10-02 用户从截图上抓到的正是这个形状），于是往回想、往前翻；
 *      · **她自己刚发出去的那几行**（连同**紧挨着的**她自己的行）：她连着 report 两份、
 *        第二份刚到，只给"新的那一份"时**先发那一份在视图里消失了**——她会以为那一份没发出去，
 *        于是再发一遍（2026-10-07 报的重复发；`SENT_CREDENTIAL_NOTE` 治的就是它，
 *        `test/channel-wire.test.ts` 那条回归用例锁着这个形状）。判据收得很紧：
 *        **只往回带"她自己的行"、且必须挨着**（中间隔着别人的话就断），不拉任何别人的话——
 *        "她这一段话连着读"是这一条例外的全部理由，不是把旧上下文整段倒回来。
 *   ④ **顺序**：时间正序（这一整屏是"这段时间里发生了什么"，倒序读会把因果读反）。
 *
 * 画不出来的那些（掉在 `limit` 之外的新消息）由 handler 如实报数并给出翻页游标。
 *
 * `tailWindow` 那一支只在**两个**地方还活着：这个会话她一次都没读过（宁可多给一次），
 * 以及"叫她的那条已经被这一屏之后的动静挤出取数窗口了"（那时至少给她一段能读的上下文）。
 */
function incrementalWindow(
  unread: readonly ReadChannelItem[],
  pool: readonly ReadChannelItem[],
  limit: number,
  callerMessageId: string | null,
): DigestView {
  /**
   * 必须先占住的两个**例外**（见上面 ③）：新窗口里的提及、以及本轮叫她的那条。
   *
   * 用 Map 而不是数组：**去重按事件 seq**（同一件不会因为既是提及又是 caller 就出现两遍）。
   */
  const kept = new Map<number, ReadChannelItem>();
  const mentionSeqs = new Set<number>();
  for (const item of unread) {
    if (!isExternalMessage(item) || item.mentionsMe !== true) continue;
    mentionSeqs.add(eventSeqOf(item));
    kept.set(eventSeqOf(item), item);
  }
  /**
   * 本轮叫她的那条：**在整池里找**（不是在 `unread` 里）——它压在水位之内是常态
   *（`wake/channel` 不计未读、常常已经被读过一遍了），而"这一轮就是它在叫她"是**独立于水位**
   * 的一件事。判据只有 `callerMessageId` 一个（宿主给的平台 id），不在这里重判"是不是提及"。
   */
  if (callerMessageId !== null) {
    const caller = pool.find((item) => isExternalMessage(item) && item.messageId === callerMessageId);
    if (caller !== undefined) {
      mentionSeqs.add(eventSeqOf(caller));
      kept.set(eventSeqOf(caller), caller);
    }
  }
  /**
   * 她自己**刚发出去**的那几行：把它**紧挨着的**她自己的行一并带上（见上面 ③ 的第三条）。
   *
   * 判据两条，都收得很紧：① 触发点是"她在 `unread` 里"（＝刚发出去、她还没读到过的那几行）；
   * ② 只往两边扩**她自己的行**（`isChannelSpoken`），中间一隔着别人的话就断开——
   * 于是它带回来的永远只是"她这一段连着说的话"，不是旧上下文。
   *
   * ⚠ 必须排在**补足名额之前**：例外是"先占住"，不是"额外追加"——否则一屏会超出 `limit`
   *（写这条时刚踩到：6 行她自己的话 + 8 条新消息 = 14 行，而她要的是 8 行）。
   */
  const unreadSeqs = new Set(unread.map((item) => eventSeqOf(item)));
  for (let i = 0; i < pool.length; i += 1) {
    const item = pool[i]!;
    if (!isChannelSpoken(item) || !unreadSeqs.has(eventSeqOf(item))) continue;
    let back = i;
    while (back > 0 && isChannelSpoken(pool[back - 1]!)) back -= 1;
    let forward = i;
    while (forward + 1 < pool.length && isChannelSpoken(pool[forward + 1]!)) forward += 1;
    for (let k = back; k <= forward; k += 1) kept.set(eventSeqOf(pool[k]!), pool[k]!);
  }
  // 剩下的名额给**最近的新消息**（从新往旧数，凑满 limit 就停）——丢的是最旧的那几条
  for (let i = unread.length - 1; i >= 0 && kept.size < limit; i -= 1) {
    const item = unread[i]!;
    kept.set(eventSeqOf(item), item);
  }
  const items = sortByTimeline([...kept.values()]);
  /**
   * 叫她的那条**不在取数窗口里**（这一拍之后又来了一屏新的，把它挤出去了）且这一屏什么都没攒到
   * ⇒ 退回"最近 limit 件"：她手里至少有一段能读的上下文，而不是一句"没有新消息"。
   * 这一支与"这个会话她一次都没读过"是**两件不同的事**，只是兜底动作相同。
   */
  if (items.length === 0 && callerMessageId !== null) return tailWindow(pool, limit, null);
  const shown = new Set(items.map((item) => eventSeqOf(item)));
  return { items, mentioned: new Set([...mentionSeqs].filter((seq) => shown.has(seq))) };
}

/**
 * "这一轮就是它在叫她"时的那一屏：**取到叫她那条为止的最近 `limit` 件**（含她的行）。
 *
 * 为什么需要它（2026-10-08 的取舍）：v28 之后群里被 @ 的那一轮，她手里**只有通知、没有正文**
 * （正文要她自己 `read_channel` 取）；而"默认只给提及 + 前十条"这条口径下，叫她的那条
 * （`wake/channel`）可能**压在已读位之内**（不计入未读）或比取回来的窗口更早 ⇒ 一条提及都挑不出来，
 * 她会得到一屏与那句原话无关的旧话（2026-10-02 用户从截图上抓到的正是这个形状）。
 *
 * `callerMessageId` 是叫她那条消息的平台 id（`mentionMessage()` 给的）：窗口**从它开始往回数**，
 * 于是"那句原话"必然在这一屏里。认不出它时退回"最近 limit 件"——那仍是她此刻最该看到的几行。
 *
 * **v67 起这一支只在两处活着**（默认那一屏改由 `incrementalWindow` 取，见那边）：
 *   · 这个会话她**一次都没读过**（没有水位可依，"宁可多给一次"是既有取舍）；
 *   · 叫她的那条**已被挤出取数窗口**（`incrementalWindow` 里那一句兜底）。
 *
 * ⚠ v67 修的一处漏：返回的 `mentioned` 原来是**空集**，于是这一支摆出来的那几十行里
 * **一条 `▶` 都没有**——她只知道"有人在某个会话里 @ 了我"（通知里没有正文），却看不出是
 * **哪一行**，只能自己往回想、往前翻。实测：426 次提及唤醒里 162 次她在同会话读了一次，
 * **其中 101 次（62%）回执里一个 `▶` 都没有**。现在按**同一份判据**（`mentionsMe`）把
 * 这一屏里点了她的那些全标出来——窗口里可能不止一条，标全才是 `▶` 那条口径的本意。
 */
function tailWindow(
  pool: readonly ReadChannelItem[],
  limit: number,
  callerMessageId: string | null,
): DigestView {
  const at = callerMessageId === null
    ? -1
    : pool.findIndex((item) => isExternalMessage(item) && item.messageId === callerMessageId);
  const items = at < 0 ? pool.slice(-limit) : pool.slice(Math.max(0, at + 1 - limit), at + 1);
  const mentioned = new Set<number>();
  for (const item of items) {
    if (isExternalMessage(item) && item.mentionsMe === true) mentioned.add(eventSeqOf(item));
  }
  return { items, mentioned };
}

/**
 * 翻页页脚：**"还有没有更多 + 下一页怎么翻"**（用户 2026-10-08：「返回里必须给"还有没有更多 +
 * 下一页怎么翻"」）。
 *
 * 形态固定一行，`before=` 后面那个数就是**下一页的游标**——取法只有一条：这一屏**最旧那一件**的
 * 事件 seq（`<` 是严格比较，所以它自己不会在下一页重复出现）。她只要抄那个数就够了，
 * 不必理解 seq 是什么。
 *
 * 为什么游标是"最旧那一件的事件 seq"而不是页码：新消息落库只会拿到更大的 seq，
 * 改不了"更早那一段"的成员——页码会随新消息整体平移，翻第二页时会重读第一页。
 */
function pagingFooter(input: {
  /** 下一页的游标 */
  nextBefore: number;
  /** 这一屏之前还有没有更早的 */
  more: boolean;
  /** 有没有因为行数上限被截断（截断了就提醒她把 limit 调大） */
  truncated: boolean;
  /** 本页实际用的行数上限（**照它指路**，别拿一个别的数糊弄她） */
  limit: number;
}): string {
  if (!input.more) {
    return `（本机时间；已经翻到头了——${cursorText(input.nextBefore)} 之前没有更早的消息。`
      + '想回到现在就不带 before 读一次。）';
  }
  // ⚠ 2026-10-20（R2 的复核结论）：`，一页 ${input.limit} 条`**不能删**，尽管"一页 15 条"这个
  // 默认值逐字写在 `before` / `limit` 的参数描述里。理由：这一格报的是**本页实际用的行数**
  // （她可以传 `limit:7`，那时"一页 7 条"在参数描述里根本没有），而"页脚照本页实际用的行数
  // 指路（口径只有一处）"有两条用例钉着（`test/read-channel-page.test.ts` ⑦ 的 limit:7 那条、
  // ⑨ 的 15 条那条）。审计把它归成"纯重复"，只对**默认值**成立，对非默认 limit 不成立——
  // 删了会让"这一页到底几行"从回执里消失，属判据而不是样板。
  const wider = input.truncated ? `，或者 limit 更大再看远一点（上限 ${READ_CHANNEL_MAX_LIMIT}）` : '';
  return `（想接着往回翻就带上 ${cursorText(input.nextBefore)} 重读一次，一页 ${input.limit} 条${wider}）`;
}

/** 会话那一份人读标签（"QQ 官方 Bot API · 群聊"）——头一行与页脚共用这一处 */
function whereOf(message: ChannelMessageView): string {
  return sessionLabelOf({ channel: message.channel, chatType: message.chatType });
}

/**
 * 从读回来的消息里拼一个会话条目。
 *
 * 为什么要这一步：名字解析（`resolveSessionName`）吃的是 `SessionEntry`，而 `read_channel`
 * 手里只有原始消息。这里**只填得出名字所需的字段**（sid/个人标识/别名位留空）——
 * 未读与条数那些字段在会话簿里另有权威来源，不在这里编（编一份就会和簿子对不上）。
 */
/**
 * 一行里的短时间：`MM-DD HH:MM`（**本机时间**）。
 *
 * 为什么要它：`read_channel` 是"她随手翻一眼信箱"，而 ISO（`2026-10-02T06:12:14.000Z`）既长
 * 又要她做时区换算——用户 2026-10-02 为此专门要求过"时间别让她换算"（见 render 的 v26）。
 * `timezone` 由宿主注入；没注入或算不出来就退回 ISO 原文（**宁可长，也不给一个错的时间**）。
 */
function shortLocalTime(iso: string, timezone: string | null): string {
  if (timezone === null) return iso;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return iso;
  }
}

/**
 * 一批消息里的发言人别名表：优先宿主给的名字，其次短标识原样，最后退成 甲/乙/丙…
 *
 * 与 topic.ts 里那个同一套思路（同一个问题在两处出现，判定口径也一致）：openid 摆出来是噪音，
 * **会话名摆出来是错误**——那是"哪个群"，不是"谁"。同一批里同一个人始终同一个代号。
 */
function makePersonAliaser(
  nameOf: ((person: string) => string | null) | null,
): (person: string, nickname?: string) => string {
  return (person: string, nickname?: string) => {
    // 权威名字（联系人表 > 她的别名表，都是**按 id 查**）优先。
    //
    // 认不出来时（2026-10-02 用户的口径："官 bot 如果只有 openid 那就 openid 吧，由框架维护别名，
    // 或者她也可以自己写；如果她想知道，就自己去问对方怎么称呼"）：
    //   • 短标识（OneBot 的 QQ 号这种）原样用——那本来就是人能读的号；
    //   • 长 openid 给「甲（id …0006）」：前半是她在一批里认人的代号，括号里是**能对得上号的
    //     id 尾巴**——她想把这个人记进 `MEMORIES/aliases.md`、或者直接问他怎么称呼，都得有个凭据。
    // 两种都不是身份判定：身份永远是最左边那个按 id 查出来的名字（见 self-brief"名字不是身份"）。
    const named = nameOf?.(person) ?? null;
    if (named !== null && named.trim() !== '') return named.trim();
    const nick = (nickname ?? '').trim();
    const isShort = [...person].length <= 12;
    const tail = person.length <= 4 ? person : person.slice(-4);
    // **不用"甲乙丙"这种批内序号**（2026-10-03 她自己在记忆里记下的现象）：那是按"这一批里第几个
    // 出现"编的，换一批就重排——同一个人一会儿丙、一会儿乙、一会儿甲。身份标记必须**只由 id 决定**：
    //   • 本来就短的标识（QQ 号、人名）原样用，不加前缀也不加括号；
    //   • 长 openid 只给尾巴（`…0006`）；有昵称时昵称在前、尾巴做锚（改名不改锚）。
    // 同一个人在哪儿、哪一批里，都是同一个写法。
    if (nick === '') return isShort ? person : `…${tail}`;
    return isShort ? `${nick}（${person}）` : `${nick}（id …${tail}）`;
  };
}

function sessionEntryOf(message: ChannelMessageView): SessionEntry {  return {
    sid: message.sid,
    channel: message.channel,
    chatType: message.chatType,
    chatId: message.chatId,
    person: message.person,
    lastText: '',
    lastSeenAt: message.ts,
    messages: 0,
    label: null,
    readUpToSeq: 0,
    unread: 0,
  };
}

/**
 * 渲染上下文（名字那一半）。
 *
 * 名字的三条来源，按"谁说的算"排序：宿主的解析口（它背后是人声明的联系人表 > 她自己的别名）
 * > 会话条目上的 label > 不给（退回 openid）。**解析不出就不编**：一个编出来的名字比一串
 * openid 危险得多——她会照着那个名字认人。
 */
function personLabelOf(
  message: ChannelMessageView,
  entry: SessionEntry | null,
  resolve: ChannelNameResolver | null,
): { personLabel?: string } {
  const named = resolve?.(message.sid) ?? entry?.label ?? null;
  if (named === null || named === '' || named === message.person) return {};
  return { personLabel: named };
}

function readNotifyLevel(args: Record<string, unknown>): NotifyMessage['level'] {
  const raw = optionalString(args, 'level');
  if (raw === undefined) return 'info';
  if (raw === 'info' || raw === 'warn' || raw === 'critical') return raw;
  throw new ToolArgumentError('level', `level 只能是 info / warn / critical，收到 "${raw}"`);
}

function readTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new ToolArgumentError('items', 'items 必须是数组（全量替换语义；清空请给空数组 []）');
  }
  if (raw.length > MAX_TODO_ITEMS) {
    throw new ToolArgumentError(
      'items',
      `items 最多 ${MAX_TODO_ITEMS} 项，收到 ${raw.length}：清单要进每轮的上下文，超长会持续挤占预算，请拆分为更少的高层步骤。`,
    );
  }
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ToolArgumentError('items', `items[${index}] 必须是 { content, status } 对象`);
    }
    const record = item as Record<string, unknown>;
    const content = requiredString(record, 'content', { maxLength: TODO_SINGLE_CONTENT_MAX });
    const status = record['status'];
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoItem['status'])) {
      throw new ToolArgumentError(
        'items',
        `items[${index}].status 只能是 ${TODO_STATUSES.join(' / ')}，收到 ${JSON.stringify(status)}`,
      );
    }
    return { content, status: status as TodoItem['status'] };
  });
}

function describeTimer(entry: StoredTimerEntry): string {
  const kind = entry.cron === undefined ? '一次性' : `周期 ${entry.cron}`;
  const skipped = entry.skipped > 0 ? `，已跳过 ${entry.skipped} 拍` : '';
  const payload = entry.payload === null || entry.payload === undefined
    ? '（无 payload）'
    : `payload=${safeJson(entry.payload)}`;
  // 每行自己带"是不是给用户的"（v59）：她扫一眼就知道日程页的周历会画哪几行
  const mark = isOwnerFacingTimer(entry.payload) ? '[用户向]' : '[你自己的·不上周历]';
  return `- ${mark} ${entry.timerId} | ${kind} | 下次 ${entry.at}${skipped} | ${payload}`;
}

function describeTodo(item: TodoItem): string {
  const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
  return `${mark} ${item.content}（${item.status}）`;
}

function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value) ?? 'null';
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '（无法序列化）';
  }
}
