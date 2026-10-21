/**
 * Irmia Agent — 「**我做过**」：她自己的管理动作（2026-10-11）
 *
 * ──────────────────────────── 这条线治的病 ────────────────────────────
 *
 * 平台**不对机器人自己发起的动作发 notice**（`set_group_whole_ban` / `set_group_ban` /
 * `set_group_kick` / `delete_msg` … 一律只有 API 回执，实测那条回执甚至是 `data: null`）。
 * 于是"我设过全员禁言"这件事在她那儿**一个字都不存在**：`read_channel` 只摆
 * `channel/message`（别人说的）与 `channel/notice`（群里出的动静），她的动作两样都不是。
 * 诊断报告 §3.2 的原话：下一次她翻这个群，看不到自己做过什么，只能靠她自觉写进
 * `MEMORIES/facts.md`。
 *
 * ⇒ 补一条**她自己的凭据**，与 `speak/sent`（"我说过什么"）同一性质，这一条答"**我做过什么**"。
 *
 * ──────────────────────────── 三条纪律 ────────────────────────────
 *
 * ① **判据只此一处**：认不认这个动作（{@link actionRecordOf}）、怎么渲染成一行
 *    （{@link selfActionLineText}）都在这一个文件里。落点在 MCP 入口的回执那一层
 *    （`tools/mcp-entry.ts` 的 `onReceipt`）——**外面那层拿不到参数**
 *    （executor 的 `tool/result` 里只有 `callId/name/status/content`），而"这次到底做了
 *    什么管理动作"必须看参数；那个入口也只**交事实**，判断全在这里。
 *
 * ② **宁可少一行，绝不编一行**（与 `channel/notice` 那条纪律一致）：
 *    · 归不到会话的动作（`delete_msg` 只有 `message_id`、`set_group_add_request` 主键是
 *      一次性 `flag`）**不记**；
 *    · 不是群会话里的事（`send_like` / `set_friend_add_request`）**不记**；
 *    · 参数里没有的那一格**不写**（不写 0、不写"未知"）；
 *    · 不认识的动作**不编一个像样的中文名**——只把**协议原名**照摆；
 *    · 群名查不到时给一个如实锚（`一个群聊（…6782）`），**不许编名字**。
 *
 * ③ **`receipt` 永远来自"我看到的字节"**，不是推测（见 {@link receiptOf}）：
 *    OneBot 成功时回 `data: null`、失败时回 `{"ok": false, "reason": …}`，而 `status` 在
 *    "协议层通了但业务失败"时**仍是 `'ok'`** ⇒ 判据必须是三档：`status` → 回执体的 `ok` → 默认。
 *
 * ──────────────────────────── 与"我说过的话"的关系 ────────────────────────────
 *
 * 两者行首都是 `（我）`（同族），但后面那一段的形状不同、且**判据互斥**：
 *   · 她说过的话（`ChannelSpoken`）：`（我）：<正文>`——自由文本；
 *   · 她做的事（本条）：`（我）：[<动作 · 对象 · 结果>]（回执 …）`——方括号包住的动作 + 括号里的回执。
 * `read_channel` 里那三个标记的顺序是 `noticeType`（动静）> `action`（我做的）> 无（别人说的）。
 */

import { CHAT_TYPE_LABELS, normalizeSid } from './sessions.ts';

/** 「我做过」那条事件的载荷（`channel/self-action`） */
export interface ChannelSelfActionData {
  /** 通道标识（由 MCP server 名推导；**推不出就是空串**——不编一个像样的通道名） */
  channel: string;
  /**
   * 目标会话（`onebot:group:<群号>` 这种；**必有**）。
   *
   * 为什么必有：这条事件的用途是"她翻某个会话时看到自己在那儿做过什么"，
   * 归不到会话的动作**根本不记**（见文件头纪律②）——所以这里不是"可能为空"，
   * 而是"能走到落库这一步就一定有"。
   */
  sid: string;
  /**
   * 会话 id（群号 / 群 openid）——**与 `sid` 分开、两个都要**。
   *
   * `sid` 是"哪个会话"（`channel:chatType:chatId` 的全称），`chatId` 是**拼它用的那一段**：
   * 会话簿的折叠（`channel/sessions.ts` 的 `channelDataOf`）按通道名 + 形态 + `chatId` 现算 sid，
   * 缺了它那条事件**进不了会话簿**（她翻清单时看不到有那么个地方）。冗余是有意的：
   * 两格都由 `actionRecordOf` 一处填出，不会漂。
   */
  chatId: string;
  /** 协议动作名（**原样照抄**，如 `set_group_whole_ban`）；不认识的动作靠它如实呈现 */
  action: string;
  /**
   * 会话形态（这条路上只有群：她的管理动作全部发生在群里）。
   *
   * 为什么必须有它（不是冗余）：`read_channel` 那一屏的框头要写 `chat=群聊`，而它取的是
   * **锚件**的 `chatType`——只有动静或她自己的动作那一屏里，锚件就是这一条；少了这一格
   * 框头会写成 `chat=undefined`（一条看起来像"框架坏了"的假话）。
   * 取值用**会话口径**（`group`，与 `sessions.ts` 的 `sidKindOf` 同源），与消息那一路一致。
   */
  chatType: 'group' | 'c2c';
  /** 哪个 MCP server（`onebot11-mcp`）——出问题时能顺着查 */
  server: string;
  /** 入口里她填的那个工具名（通常与 `action` 同值，但**不假设**） */
  tool: string;
  /** 对谁（`user_id` / `message_id`）；平台没给就不填 */
  target?: string;
  /**
   * 只留**能人读的那几格**（`enable` / `duration` / `card` / `special_title`）。
   *
   * 为什么不通通收下：回执那一路的 `args` 是她的任意输入，而这条事件会随日志长期留存、
   * 每次 `read_channel` 都要读。整份参数抄进去既没有判据价值，也会把"她当时手滑填的东西"
   * 永久留在通道数据里。**自由文本两类刻意不进**：`reason`（拒绝理由，可达 200 字）与
   * `group_name`（新群名，新值已经在渲染那一行里了，抄两遍没有意义）。
   */
  params?: Record<string, string | number | boolean>;
  /** **回执的结论**（不是"我以为"）：`ok` = 平台没报错；`failed` = 有凭据说它没成 */
  receipt: 'ok' | 'failed';
  /** `failed` 时平台给的那句原因（照抄，不加工；拿不到就不写） */
  detail?: string;
  /** 产生这次动作的 turn（复盘用，与 `tool/call.turn` 同源） */
  turn?: number;
  /** 哪一次工具调用（与 `tool/call.callId` 同源） */
  callId?: string;
}

/** 「我做过」折成时间轴上的一件事所需的最小形状（与 `ChannelNoticeView` 同一个成例） */
export interface ChannelSelfActionView extends ChannelSelfActionData {
  /** 事件落进日志时的 seq（翻页游标与"新不新"都用它） */
  seq: number;
  ts: string;
}

/**
 * 载荷形状校验（**只认形状**，不认内容）：读口用它挡畸形数据。
 *
 * 为什么值得有（与 `isChannelNoticeData` 逐字同一个理由）：这条事件的写入者是**回执那一路**，
 * 而"渲染不出来的东西落在日志里"的代价是每一次翻到这儿都多一行空的。形状不对**宁可丢**。
 */
export function isChannelSelfActionData(value: unknown): value is ChannelSelfActionData {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const sid = record['sid'];
  const chatId = record['chatId'];
  const action = record['action'];
  const receipt = record['receipt'];
  const chatType = record['chatType'];
  return typeof sid === 'string' && sid !== ''
    && typeof chatId === 'string' && chatId !== ''
    && typeof action === 'string' && action !== ''
    && (chatType === 'group' || chatType === 'c2c')
    && (receipt === 'ok' || receipt === 'failed');
}

// ──────────────────────────────── 认识的写动作（覆盖清单的唯一出处） ────────────────────────────────

/** 这个动作动的是**整个群**还是**群里某个人**（决定 `user_id` 那一格要不要取） */
type SelfActionScope = 'group' | 'user';

/**
 * **记哪几件**——判据一句话：「改变了这个群（或它在群里的成员）的状态，且参数里带着 `group_id`」。
 *
 * 为什么是这 9 件（清单与理由，逐条）：
 *   · `set_group_whole_ban` / `set_group_ban` / `set_group_kick` / `set_group_admin` —— 改变群或成员在群里的状态；
 *   · `set_group_card` / `set_group_special_title` —— 改变成员在群里的展示与称谓（她看得见结果）；
 *   · `set_group_name` —— 改变整个群的状态，所有人可见；
 *   · `set_group_leave` —— 退群（这条最该有：换过门或重进之后回头看，那一行是唯一的痕迹）；
 *   · `set_group_sign` —— 群打卡（本机 server 的 `readOnly: false` 是它自己的原话，不替它降级）。
 *
 * **刻意不记的 4 件**（两条理由，都不是"忘了"）：
 *   · `delete_msg`：参数只有 `message_id`，**归不到会话**（`channel/message` 里能反查，
 *     但那要为此加一跳日志扫描——本批不做，登记为已知缺口）；
 *   · `set_group_add_request`：主键是一次性句柄 `flag`，**不含 `group_id`**，不猜它属于哪个群；
 *   · `send_like` / `set_friend_add_request`：不是群会话里的事（好友/单聊关系），
 *     摆进某个群那一屏就是噪音。
 *
 * **不认识的动作一律不记**（而不是记一条没有动作名的）：将来 server 加了新的 `set_group_*`，
 * 她就看不到那一行——那是**如实退化**，不是错。
 */
const WRITE_ACTIONS: Readonly<Record<string, { scope: SelfActionScope; label: string }>> = {
  set_group_whole_ban: { scope: 'group', label: '全员禁言' },
  set_group_ban: { scope: 'user', label: '禁言' },
  set_group_kick: { scope: 'user', label: '踢出群聊' },
  set_group_admin: { scope: 'user', label: '管理员' },
  set_group_card: { scope: 'user', label: '改群名片' },
  set_group_special_title: { scope: 'user', label: '专属头衔' },
  set_group_name: { scope: 'group', label: '改群名' },
  set_group_leave: { scope: 'group', label: '退群' },
  set_group_sign: { scope: 'group', label: '群打卡' },
};

/**
 * 进 `params` 的那几格白名单（**闭合词表**，不是"看着办"）。
 *
 * `reason` 与 `group_name` 刻意不在：前者是自由文本（她写的拒绝理由，可达 200 字），
 * 后者是新值而它已经在渲染那一行里了。少抄一份，日志里就少一份用不上的东西。
 */
const PARAM_KEYS = ['enable', 'duration', 'card', 'special_title'] as const;

// ──────────────────────────────── 回执 → 事件载荷 ────────────────────────────────

/** MCP 入口交给我们的那份事实（形状与 `tools/mcp-entry.ts` 的 `McpReceipt` 一一对应） */
export interface SelfActionReceipt {
  server: string;
  tool: string;
  args: unknown;
  /** executor 的结论：`ok` / `error` / `denied` / `timeout`（denied 的调用压根没有回执） */
  status: string;
  content: string;
  isError: boolean;
  turn?: number;
  callId?: string;
}

/**
 * **回执的结论**——三档，逐字如此（`receipt` 永远来自我看到的字节，不推测）：
 *
 *   ① `status !== 'ok'` ⇒ `failed`：这一跳本身没走通（error / timeout / 被取消）。
 *      `denied` 到不了这里——被拦的调用**没有回执**（那是 `executor` 与 MCP 入口三道早返回
 *      共同保证的，本文件的用例正面钉着）。
 *   ② 否则**解析回执体里的 `ok` 字段**：`true` ⇒ `ok`、`false` ⇒ `failed`（并取 `reason`/`message`）。
 *      这一档是必须的：OneBot **成功时回 `data: null`、失败时回 `{"ok": false, "reason": …}`**，
 *      而"协议层通了但业务失败"的 `status` **仍是 `'ok'`** ⇒ 只看 `status` 会把失败写成成功。
 *   ③ 两者都没有（回执体不是 JSON、或没有 `ok` 这一格）⇒ **`ok`**：回执走通了、平台没报错。
 *      **不替平台加戏**，也不写一个我没看到的失败——这是"没结论时按事实的最弱一侧说"。
 */
export function receiptOf(receipt: SelfActionReceipt): { receipt: 'ok' | 'failed'; detail?: string } {
  if (receipt.status !== 'ok') {
    // 这一跳没走通：原因就是回执正文（executor/client 写的是人话），截一段给它
    const detail = clip(receipt.content);
    return { receipt: 'failed', ...(detail === '' ? {} : { detail }) };
  }
  const parsed = parseJsonObject(receipt.content);
  if (parsed !== null && typeof parsed['ok'] === 'boolean') {
    if (parsed['ok']) return { receipt: 'ok' };
    const why = readText(parsed['reason']) || readText(parsed['message']) || readText(parsed['wording']);
    return { receipt: 'failed', ...(why === '' ? {} : { detail: why }) };
  }
  return { receipt: 'ok' };
}

/**
 * 一条回执 → `channel/self-action` 的载荷；**不认识的、归不到会话的、不是群会话里的事一律 `null`**
 * （调用方据此整条丢掉——宁可少一行，绝不编一行）。
 */
export function actionRecordOf(receipt: SelfActionReceipt): ChannelSelfActionData | null {
  const action = receipt.tool.trim();
  const known = WRITE_ACTIONS[action];
  if (known === undefined) return null;
  const args = asRecord(receipt.args);
  const groupId = idText(args['group_id']);
  // 归不到会话 ⇒ 不记（用途就是"她翻某个会话时看到自己做过什么"，没有会话就没有那一屏）
  if (groupId === '') return null;
  const channel = channelOfServer(receipt.server);
  const target = known.scope === 'user' ? idText(args['user_id']) : '';
  const params: Record<string, string | number | boolean> = {};
  for (const key of PARAM_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') params[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    else if (typeof value === 'boolean') params[key] = value;
  }
  const verdict = receiptOf(receipt);
  return {
    channel,
    // 会话口径的形态（`group`）：与 `sidKindOf` 同源——这一条只可能是群里的动作（见上面那格注释）
    chatType: 'group',
    sid: normalizeSid(`${channel}:group:${groupId}`),
    chatId: groupId,
    action,
    server: receipt.server,
    tool: receipt.tool,
    ...(target === '' ? {} : { target }),
    ...(Object.keys(params).length === 0 ? {} : { params }),
    receipt: verdict.receipt,
    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    ...(receipt.turn === undefined ? {} : { turn: receipt.turn }),
    ...(receipt.callId === undefined ? {} : { callId: receipt.callId }),
  };
}

/**
 * MCP server 名 → 通道名（**推不出就给空串**，见下面那句）。
 *
 * 为什么不写死 `'onebot'`：通道名是会话簿与框头（`source=`）读的那一格，写死一个"看起来对"
 * 的值就是在数据里留一句假话。这台机器上的 server 叫 `onebot11-mcp`，认得出；
 * 换个名字或换台机器就**如实空着**——那一格只影响显示，不影响任何判据。
 */
export function channelOfServer(server: string): string {
  if (server.startsWith('onebot')) return 'onebot';
  return '';
}

/**
 * **落一条「我做过」**（回执 → 判据 → 写事件）。宿主（`tools/catalog.ts`）与用例都走这一个口。
 *
 * 为什么把它也放在这里、而不是在调用点写那三行：这条规则里"什么不该记"占了一大半
 * （查询类、归不到会话的、不是群会话里的事），而 **"什么不该记"是判据**。调用点自己写
 * `if (data !== null) emit(...)` 就等于把"先判后写"这个顺序也抄一遍——抄漏一次的症状是
 * 日志里多一条没有动作名的事件。收成一个函数之后，调用点只剩"把事实交出去"。
 *
 * `emit` 的可见性由这里**显式给死 `internal`**（与 `channel/notice` 逐字同一条纪律：
 * 不进请求体、不唤醒、不计未读）——调用点不必、也不许自己挑一个可见性。
 */
export function recordSelfAction(
  receipt: SelfActionReceipt,
  emit: (type: string, data: unknown, visibility: 'model' | 'internal') => void,
): boolean {
  const data = actionRecordOf(receipt);
  if (data === null) return false;
  emit('channel/self-action', data, 'internal');
  return true;
}

// ──────────────────────────────── 渲染：那一行的逐字 ────────────────────────────────

/**
 * 把一个会话 id 显示成人读的样子：**名字真源优先，查不到给如实锚**。
 *
 * 与 `channel/notice` 那一路**共用同一个注入的名字解析口**（`read_channel` 那边递的是
 * 同一个 `resolveChannelName`），所以同一屏里"群"这一格的写法只有一种。
 */
export type SelfActionNamer = (chatId: string) => string | null;

/**
 * **那一行的逐字**（`read_channel` 里"时间"后面的全部内容）。目标形状：
 *
 * ```
 * （我）：[全员禁言 · I.R.M.I.A 内测群 · 开启]（回执 ok）
 * （我）：[禁言 · I.R.M.I.A 内测群 · 600 秒]（回执 ok）
 * （我）：[全员禁言 · I.R.M.I.A 内测群 · 开启]（回执失败：权限不足）
 * （我）：[set_group_sign · I.R.M.I.A 内测群]（回执 ok）        ← 不认识的动作：只摆协议原名
 * ```
 *
 * 三件事刻意：
 *   · **动作那一段永远是方括号里那句**——与"她说过的话"（`（我）：<正文>`）同族但不混；
 *   · **拿不到的格一个字都不写**（`enable` 没给就不说开还是关、`duration` 没给就不写秒数）；
 *   · **不认识的动作不编中文名**，把协议原名照摆——她至少知道"我做过这么一件事、名字是这个"，
 *     而编一个像样的动作名等于在日志里造事实。
 */
export function selfActionLineText(action: ChannelSelfActionData, nameOf: SelfActionNamer): string {
  const where = whereOf(action, nameOf);
  const phrase = phraseOf(action);
  // 认识的：`[动作 · 值 · 对谁 · 群]`（值/对象没有就不出现）；不认识的：`[协议原名 · 群]`
  // "对谁"那一格**只拿得到协议 id**（这是 OneBot 的动作回执，不是消息事件——那边才有昵称），
  // 所以写成 `@<QQ号>`：那是他自己能对得上号的凭据，比一个查不出名字的空格诚实。
  const who = phrase === null ? '' : phrase.who;
  const parts = phrase === null
    ? [action.action, where]
    : [
        phrase.what,
        ...(phrase.value === '' ? [] : [phrase.value]),
        ...(who === '' ? [] : [`@${who}`]),
        where,
      ];
  const tail = action.receipt === 'ok'
    ? '（回执 ok）'
    : `（回执失败${action.detail === undefined || action.detail === '' ? '' : `：${action.detail}`}）`;
  return `[${parts.join(' · ')}]${tail}`;
}

/** 那个群怎么称呼（名字真源 → 查不到给锚；`chatType` 的标签借 sessions 那一份，不另写） */
function whereOf(action: ChannelSelfActionData, nameOf: SelfActionNamer): string {
  const named = nameOf(action.sid)?.trim() ?? '';
  if (named !== '') return named;
  const id = action.sid.slice(action.sid.lastIndexOf(':') + 1);
  const tail = id.length <= 4 ? id.padStart(4, '0') : id.slice(-4);
  const label = CHAT_TYPE_LABELS['group'] ?? '群聊';
  return `一个${label}（…${tail}）`;
}

/**
 * 动作那一句拆成三格：**做什么**（`what`）、**取值**（`value`，没有就空串）、**对谁**（`who`）。
 *
 * 为什么拆开而不是拼成一句：`[全员禁言 · 开启 · <群名>]` 这个形状里"取值"与"对谁"的**位置不同**
 * （禁言是 `[禁言 · 600 秒 · <群名>]`、群名片是 `[改群名片 · 「新名」· <群名>]`，
 * 而参数缺失时**整格消失**）。拼成一句就得在每个分支里各拼一次分隔符——那正是"多一个空格少一个
 * 空格"这种错最容易长出来的地方；交给上面那一行统一 `join`。
 *
 * 返回 `null` = **不认识的 action**：调用方退回协议原名（**绝不编一个像样的中文动作名**）。
 */
function phraseOf(action: ChannelSelfActionData): { what: string; value: string; who: string } | null {
  if (WRITE_ACTIONS[action.action] === undefined) return null;
  const params = action.params ?? {};
  const who = action.target === undefined || action.target === '' ? '' : action.target;
  switch (action.action) {
    case 'set_group_whole_ban':
      // `enable` 没给 ⇒ **整格不出现**（不说开还是关——不编一个方向出来）
      return { what: '全员禁言', value: params['enable'] === true ? '开启' : params['enable'] === false ? '解除' : '', who };
    case 'set_group_ban': {
      // `duration: 0` 是协议里"解除禁言"的那个值（与 notice 那一路**同一判据**）
      const secs = params['duration'];
      if (secs === 0) return { what: '解除禁言', value: '', who };
      return { what: '禁言', value: secs === undefined ? '' : `${secs} 秒`, who };
    }
    case 'set_group_admin':
      return { what: '管理员', value: params['enable'] === false ? '取消' : '设为', who };
    case 'set_group_kick':
      return { what: '踢出群聊', value: '', who };
    case 'set_group_card': {
      const card = params['card'];
      if (typeof card !== 'string') return { what: '改群名片', value: '', who };
      return { what: '改群名片', value: card === '' ? '清除' : `「${card}」`, who };
    }
    case 'set_group_special_title': {
      const title = params['special_title'];
      if (typeof title !== 'string') return { what: '专属头衔', value: '', who };
      return { what: '专属头衔', value: title === '' ? '清除' : `「${title}」`, who };
    }
    case 'set_group_name':
      // 新群名是自由文本，**不进 params**（见 PARAM_KEYS 的注释）；这一行如实说"改了群名"
      return { what: '改群名', value: '', who };
    case 'set_group_leave':
      return { what: '退群', value: '', who };
    case 'set_group_sign':
      return { what: '群打卡', value: '', who };
    default:
      return null;
  }
}

// ──────────────────────────────── 小工具（只在这一层用） ────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // 她常常把 args 当 JSON 字符串递进来（`mcp-entry` 已经解析过一次，这里兜住直调的情形）
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = parseJsonObject(value);
    if (parsed !== null) return parsed;
  }
  return {};
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** id 那一类字段统一成字符串（协议端有时给数字有时给字符串——同一件事不该有两种写法） */
function idText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function readText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return clip(value);
}

/** 原因那一段截断：事件里留的是"能看出为什么"的一截，不是整篇 */
function clip(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`;
}
