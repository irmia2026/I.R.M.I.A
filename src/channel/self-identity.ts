/**
 * Irmia Agent — 宿主级的「**我自己**」标识集合（判据只此一处）
 *
 * ──────────────────────────── 它治的是什么病 ────────────────────────────
 *
 * 2026-10-11 用户裁决（逐字）：
 *   「read_channel 是一定可以看见自己的消息的。这是固定设计。我要你解决的是
 *     **onebot 侧把自己给自动注册成了群友**这件事。你对比一下官 bot 那边的结果。」
 *
 * 现场（`_ops-readchannel\REPORT.md` §2）：她一次 speak 的三条气泡，从**平台另一扇门**
 * （同一实体群的 `qq-official` 那一路）被当作"别人发来的消息"推回来，`person` 填的是**她自己的
 * openid**（`00000003…`）。整条入站链路上**没有任何一处**判"这条是不是我自己发的"，于是这条回声
 * 被完整地当成某个群成员说的话：落 `channel/message` → 算未读 → 进群成员档案
 * （`data/group-members.json` 里多出一条 `群友C（群昵称：伊尔弥亚2号）`，与真人网友并列）。
 *
 * ──────────────────────────── 三条纪律（改这里之前先读） ────────────────────────────
 *
 * ① **判据只有一处，不许两个适配器各判各的**。这里收的是"**宿主知道的自己的表示形态**"
 *    （`add` / `values`）与**唯一那个问句**（`isSelfMessage`）。落点只有一个：宿主的通道落库口
 *    （`main.ts` 的 `onChannelMessage`）——两条通道的消息都要经过那里，所以一处判据天然覆盖两扇门。
 *
 * ② **命中 ⇒ 三件事一起不做**：不落 `channel/message`、不注册群成员、不计未读。它们本来就是
 *    同一条路上先后发生的三件（落库 → 折叠会话簿 → 注册），挡在落库口等于三件一起挡。
 *
 * ③ **绝不碰"她看得见自己的消息"这条固定设计**。她说过什么走的是**另一条路**：
 *    `speak`/`report`/`send_media` 成功投递时补的 `speak/sent` 凭据（`admin.ts` 的
 *    `deliverToSession`），`read_channel` 由 `readChannelSpoken` 读它、渲染成行首 `（我）`。
 *    那条路与这里**没有任何交集**：这里丢的是"平台把我说的话推回来"的那个副本，
 *    不是"我说过什么"的凭据。改这里动不了那一行——`test/self-message-gate.test.ts` 正面钉着它。
 *
 * ──────────────────────────── 「自己的标识」从哪来（一律从既有握手里取，不硬编码） ────────────────────────────
 *
 * | 通道 | 形态 | 来源 |
 * |---|---|---|
 * | OneBot | 机器人 QQ 号 | 协议端自己的 `self_id`（每条事件都带）+ 握手/`get_login_info`（`OneBotClient.selfId`） |
 * | 官方 | 机器人 openid | ① 既有握手里的 `GET /v2/users/@me`（`QqGateway.fetchLoginInfo`）；② 群事件 `mentions` 里 `bot: true` 那一条的 openid（按群隔离的那一份，只有平台给得出）；③ 她自己那条回声的 `author.bot === true` |
 *
 * 取不到就**如实降级并留痕**（一条 `log.warn`，一行启动日志），绝不猜、绝不用昵称顶替
 * （昵称谁都能改，见 self-brief"名字不是身份"）。
 *
 * 为什么不做成"适配器各判各的"（那是更小的改动）：官方的 `member_openid` **按群隔离**、
 * OneBot 给的是 QQ 号，两扇门的"自己"形状不同；各判一遍就等于同一条纪律有两个实现，
 * 迟早一扇门改了另一扇没改——而漂移的症状（"群里那个群友又是谁"）从行为上看不出来。
 */

/** 消息里能用来认"这是谁发的"的那几格（两扇门的适配器给的都是同一个形状） */
export interface SelfMessageLike {
  channel?: string;
  person?: string;
}

/**
 * 现读一次"我自己的标识"的取值口（各通道自己回答，见 `SelfIdentity` 的注释）。
 *
 * 为什么是**函数**而不是一份数组：这份认知是**运行期长出来的**——OneBot 的机器人 QQ 号要等
 * WS 打开或首条事件里的 `self_id`；官方的 openid 要么由 `GET /users/@me` 探针给、要么靠群事件里
 * `mentions[bot]` 现学。`main.ts` 建判据的那一刻（`source.start()` 之前）这些**一个都还没有**，
 * 所以判据若拿的是一份启动快照，它整个进程生命周期里都恒假——那是"改了等于没改"。
 */
export type SelfIdProvider = () => readonly string[];

/**
 * 宿主知道的「我自己」标识集合。
 *
 * **两条来源，一份判据**（2026-10-11 修了一处"改了等于没改"的真缺陷，见下面那段）：
 *   • `add`：运行期**学到**一个确凿属于自己的标识时推一次（两条通道的 `onSelfId` 回调接的是它）；
 *   • `providers`：现读口——每次问 `has` 时也向它们要一次，把"适配器此刻知道的"并进来。
 *
 * 为什么两样都要（这是那一处缺陷的修法）：只留 `add` 就得保证**每一个**学到点都记得推
 * （漏一处就是一次静默失效）；只留现读口就得让判据认识两条通道的内部状态。两样都要，
 * 于是"快照"这条路根本不存在：查询那一刻现算。
 */
export class SelfIdentity {
  private readonly ids = new Set<string>();
  private readonly providers: SelfIdProvider[] = [];

  constructor(providers: readonly SelfIdProvider[] = []) {
    this.providers.push(...providers);
  }

  /**
   * 记下一个**确凿**属于我自己的标识。
   *
   * 空白一律不要（空串进了集合会让 `person === ''` 的畸形事件被静默丢掉；
   * 而那种事件本来就该由各自适配器的形状检查处理）。
   */
  add(id: string): boolean {
    const key = id.trim();
    if (key === '') return false;
    if (this.ids.has(key)) return false;
    this.ids.add(key);
    return true;
  }

  has(id: string): boolean {
    const key = id.trim();
    if (key === '') return false;
    if (this.ids.has(key)) return true;
    // 现读口：适配器**这一刻**知道的也算（它们学到的时机会晚于本对象的构造）
    for (const provider of this.providers) {
      for (const known of provider()) {
        if (known.trim() === key) return true;
      }
    }
    return false;
  }

  /**
   * 此刻知道的那几个（诊断/测试读数用；**不打印到日志**里——那是标识不是凭据，
   * 但没有抄进日志的必要）。同样含现读口。
   */
  values(): string[] {
    const out = new Set(this.ids);
    for (const provider of this.providers) {
      for (const known of provider()) {
        const key = known.trim();
        if (key !== '') out.add(key);
      }
    }
    return [...out].sort();
  }

  get size(): number {
    return this.values().length;
  }
}

/**
 * **唯一的那个问句**：这条通道消息是不是我自己发出去的？
 *
 * 两件事缺一不可：
 *   · 有会话坐标（`person` 非空）——问的是"谁发的"，没有发送者就无从谈起；
 *   · 那个发送者在"我自己"的集合里。
 *
 * 集合为空（两个适配器都还没握上手）时恒假 —— 这是刻意的降级方向：
 * **宁可让一次回声漏进来（下一轮它就不再落库了），也绝不因为"认不出自己"而丢掉别人的话**。
 */
export function isSelfMessage(data: SelfMessageLike, self: SelfIdentity): boolean {
  const person = typeof data.person === 'string' ? data.person.trim() : '';
  return person !== '' && self.has(person);
}

/**
 * 一条 `channel/notice`（群里的动静：管理动作、入群退群、撤回、戳一戳……）。
 *
 * **它不是消息**，所以与 `channel/message` 分开成一种事件：那条的语义是"某个人说了句话"
 * （有发言人、进未读、能被 @ ），而这条是"群里发生了一件事"（可能**没有** actor——
 * 平台常常只说"谁被禁言了"，不说谁禁的）。
 *
 * 与 `channel/message` 的两处刻意相同：**internal**（不进上下文、不唤醒，她想看用 read_channel 现取）、
 * **落库不唤醒**。与它的一处刻意不同：**不计未读**（`channel/sessions.ts` 的折叠只认消息——
 * "有 N 条没看"这件事数的必须是**别人的话**，把群公告栏的动静也算进去会让她以为有人在跟她说话）。
 */
export interface ChannelNoticeData {
  /** 通道标识：'onebot' | 'qq-official' | ... */
  channel: string;
  /** 会话 id（群号 / 群 openid / 用户 openid——与 `channel/message.chatId` 同源） */
  chatId: string;
  /**
   * 这条动静**说的那个会话**是群还是单聊（`read_channel` 的框头 `chat=` 要用它）。
   *
   * 只两档，与 `WakeChannel.chatType` 的五档**刻意不同**：notice 只有"群里的事"与"单聊里的事"
   * 两种，而 `group` / `group-at` 那个区分是**消息**的属性（@ 没 @ 她），notice 上没有这回事。
   */
  chatType: 'group' | 'c2c';
  /** 平台的事件类别（OneBot 的 `notice_type`：`group_ban` / `group_admin` / `group_recall`…） */
  noticeType: string;
  /** 平台给的子类（`ban` / `lift_ban` / `set` / `unset` / `leave` / `kick` / `poke`…）；没有就不填 */
  subType?: string;
  /**
   * **平台把这条推给谁**（机器人自己的标识，`self_id` / `user_id`）。
   *
   * 为什么非留不可（这不是冗余）：它区分 **「某个群成员被禁言 600 秒」** 与
   * **「我自己被禁言了」**——后者对她是能干活不能干活的差别。事件里不写死这一档，
   * 渲染时才拿它与"我自己是谁"比（判据仍在宿主那一处，见 renderNoticeLine）。
   */
  selfId?: string;
  /** 事件的操作者（`operator_id` / `user_id`）；**缺失是常态**——平台常常不给 */
  actorId?: string;
  /**
   * 事件**关于谁**（被禁言的人、入群的人、撤回消息的人……）。
   *
   * 与 `actorId` 分开是必须的：`set_group_ban` 那条 notice 里 `user_id` 是**被禁言的人**，
   * 而"谁禁的"在 `operator_id` 里（平台还可能不给）。看着像同一个字段，其实是两个人。
   */
  targetId?: string;
  /** 秒（`group_ban` 的时长；0 或缺失 = 平台没说，渲染时不许编一个数出来） */
  durationSec?: number;
  /** 撤回的是哪一条（`group_recall.message_id`），只作可读化的坐标 */
  messageId?: string;
  /** 群号/群 openid（`group_id` / `group_openid`）——与 `chatId` 可能同值，但它答的是"这事发生在哪个群" */
  groupId?: string;
  /**
   * 平台**没有**给"这是这个会话里的第几条"这回事（notice 不是消息）。
   *
   * 宿主落库时照 `channel/message` 那条既有规则补成**事件 seq**（`msgSeqOf` 同一口径）：
   * 会话簿的折叠与"读到哪了"都按这个字段比大小，留一个恒 0 会让同一个会话里
   * 动静与消息的量纲打架。**不计未读**（折叠那一侧 `accrues` 只认 `channel/message`）。
   */
  msgSeq?: number;
  /** 平台**原样给**的那几个字符串字段（不在上面任何一格里的），按需带一两个；不许凭空造 */
  detail?: Record<string, string>;
}

/** 把一条 notice 折成「时间轴上的一件事」所需的、**与通道无关**的最小形状 */
export interface ChannelNoticeView extends ChannelNoticeData {
  /** 事件落进日志时的 seq（与 `ChannelMessageView.seq` 同源，翻页游标与"新不新"都用它） */
  seq: number;
  ts: string;
}

/**
 * `channel/notice` 的载荷校验（**只认形状**，不认通道）：写事件前用它挡一次畸形数据。
 *
 * 为什么值得有：notice 这条路的**触发者是外部协议端**，而它给什么形状都有过
 * （`notice_type` 缺失、`group_id` 是数字而不是字符串……）。形状不对时**宁可丢**——
 * 一条渲染不出来的事件落在日志里，会让 `read_channel` 每次翻到这里都多一行空的。
 */
export function isChannelNoticeData(value: unknown): value is ChannelNoticeData {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const channel = record['channel'];
  const chatId = record['chatId'];
  const chatType = record['chatType'];
  const noticeType = record['noticeType'];
  return typeof channel === 'string' && channel !== ''
    && typeof chatId === 'string' && chatId !== ''
    && (chatType === 'group' || chatType === 'c2c')
    && typeof noticeType === 'string' && noticeType !== '';
}

/** 从一条 `channel/notice` 事件的载荷里取出视图（`seq`/`ts` 由调用方从事件本身补） */
export function noticeViewOf(data: ChannelNoticeData, seq: number, ts: string): ChannelNoticeView {
  return { ...data, seq, ts };
}

// ──────────────────────────────── notice → 一行「群里发生过什么」 ────────────────────────────────

/**
 * 把一个人显示成名字。**查不到不许编**——名字真源查不出来时退成短标识锚
 * （`…0006`，与 `tools/admin.ts` 的 `makePersonAliaser` 同一档写法：那是全仓"认不出人时怎么称呼"
 * 的唯一口径，这里刻意与它同形，免得同一批里同一个 openid 有两个写法）。
 */
export type NoticeNamer = (id: string, nickname?: string) => string;

/**
 * 这一格 id 该怎么写：**我自己 → `我`；有名字 → 名字；认不出 → 短标识锚 + 一个如实代号**。
 *
 * notice **不带昵称**（只有 `user_id` / `openid`），名字只能走既有真源现查——查不到时
 * **绝不编一个名字**：
 *   · 代号取 `unknown`（`某人` / `某个群成员` / `对方`）：那是"我不知道是谁"的如实说法，不是名字；
 *   · 后面追一句 `（…0006）` —— 与 `makePersonAliaser` 认不出长 openid 时**同一种锚写法**
 *     （同一个 id 在这一屏里因此只有一种写法）。
 *
 * `id` 是空串 = 平台没给这一格：返回空串，由调用点决定整句怎么写（这一层不替它编）。
 */
function whoLabel(
  id: string | undefined,
  namer: NoticeNamer,
  selfIds: ReadonlySet<string>,
  unknown: string,
): string {
  const key = (id ?? '').trim();
  if (key === '') return '';
  if (selfIds.has(key)) return '我';
  const named = namer(key).trim();
  if (named !== '') return named;
  return `${unknown}（${idAnchorOf(key)}）`;
}

/**
 * 认不出人时那个锚：**恒为末尾四位**（`…0006` / `…0999`），与 `tools/admin.ts` 的
 * `makePersonAliaser` 同一种写法。
 *
 * 为什么短标识也补零到四位：同一个群里"…999"与"…0999"看起来像两个不同的锚，
 * 而她按锚对号时对的是**同一个字段的同一段**——形态固定，它就只需要记一次。
 */
function idAnchorOf(id: string): string {
  const tail = id.length <= 4 ? id.padStart(4, '0') : id.slice(-4);
  return `…${tail}`;
}

/**
 * **一条 notice 的逐字行文**（`read_channel` 那一行里"时间"后面的全部内容）。
 *
 * 用户 2026-10-11 点名的目标形状（逐字）：
 *   `[阿岚 开启了全员禁言]` / `[某人 被禁言 600 秒]` / `[某人 被设为管理员]` /
 *   `[某人 加入了群聊]` / `[某人 撤回了一条消息]`
 *
 * 三条纪律：
 *   ① **拿不到的如实不写**（`duration` 缺失就不写秒数、`honor_type` 缺失就只写"获得群荣誉"）——
 *      绝不填一个像样的默认值；
 *   ② **不认识的 `notice_type` 不猜**：返回 `null`，由调用方**整条丢掉**（宁可这一次什么都没显示，
 *      也不把不认识的类别渲染成"某人做了什么"这种编出来的事实）；
 *   ③ 覆盖的是**常见**那几种（下面那个 switch）：协议端之间覆盖度并不一致
 *      （NapCat / Lagrange / SnowLuma 各有一份 `notice_type` 名单），所以"没写进 switch"
 *      与"平台没推"从这一侧看不出区别——这正是"看不到就是看不到"的如实形态。
 */
export function noticeLineText(
  notice: ChannelNoticeData,
  namer: NoticeNamer,
  selfIds: ReadonlySet<string>,
): string | null {
  /** 群里那一位（被禁言/入群/撤回的人）；没名字就是"某个群成员" */
  const member = (id: string | undefined): string => whoLabel(id, namer, selfIds, '某个群成员');
  /** 单聊那一位 / 操作者（`某人`） */
  const somebody = (id: string | undefined): string => whoLabel(id, namer, selfIds, '某人');
  const actor = somebody(notice.actorId);
  const subject = member(notice.targetId);
  const secs = notice.durationSec;
  // 拿不到就**不写**（`''`），不是写 0：0 秒与"平台没说"是两件事
  const duration = secs === undefined ? '' : ` ${secs} 秒`;

  switch (notice.noticeType) {
    case 'group_ban': {
      /**
       * **全员禁言**与"某个人被禁言"的分界是**协议事实**，两条判据任一成立即算：
       *   ① 当事人就是群本身（`user_id === group_id`）——OneBot 11 对全员禁言就是这么发的
       *      （`/set_group_whole_ban` 之下 `user_id` 等于群号、`duration` 为 0）；
       *   ② `duration` 明确给了 **0**——那也是协议里"没有期限"的那个值。
       *
       * ⚠ 反过来**不成立**：`duration` 缺失**不等于**全员禁言。单个人被禁言时协议端完全可能
       * 不给 `duration`，把它读成全员禁言就会把"某人被禁言 600 秒"写成"某人开启了全员禁言"
       * ——那是**编一件没发生的事**（这条注释是写完用例当场被自己的数据咬出来的）。
       */
      const target = (notice.targetId ?? '').trim();
      const group = (notice.groupId ?? '').trim();
      const whole = (target !== '' && target === group) || secs === 0;
      if (notice.subType === 'lift_ban') {
        return whole ? `[${actor === '' ? '某人' : actor} 解除了全员禁言]` : `[${member(notice.targetId)} 被解除禁言]`;
      }
      // 全员禁言那一条的当事人是群本身，摆出来只会是"某个群成员（…6782）"这种噪音 ⇒ 不摆人
      if (whole) return `[${actor === '' ? '某人' : actor} 开启了全员禁言]`;
      // 单个人被禁言：**谁被禁**是 `user_id`，"谁禁的"在 `operator_id` 里（平台可能不给）
      return actor === '' ? `[${member(notice.targetId)} 被禁言${duration}]` : `[${actor} 把 ${member(notice.targetId)} 禁言${duration}]`;
    }
    case 'group_admin':
      return notice.subType === 'unset' ? `[${subject} 被取消管理员]` : `[${subject} 被设为管理员]`;
    case 'group_increase':
      return notice.subType === 'invite' ? `[${subject} 被邀请加入了群聊]` : `[${subject} 加入了群聊]`;
    case 'group_decrease':
      if (notice.subType === 'kick_me') return '[我被移出群聊]';
      return notice.subType === 'kick' ? `[${subject} 被移出群聊]` : `[${subject} 退出了群聊]`;
    case 'group_recall': {
      // 操作者与被撤回的**不是同一个人** ⇒ 平台那一条说的是"谁撤了别人的话"，如实写出来
      if (notice.actorId !== undefined && notice.actorId !== notice.targetId) {
        return `[${actor} 撤回了 ${subject} 的一条消息]`;
      }
      return `[${subject} 撤回了一条消息]`;
    }
    case 'friend_recall':
      return `[${whoLabel(notice.targetId, namer, selfIds, '对方') || '对方'} 撤回了一条私聊消息]`;
    case 'friend_add':
      return `[${somebody(notice.targetId) || '某人'} 把你加为好友]`;
    case 'group_card': {
      const card = (notice.detail?.['card_new'] ?? '').trim();
      // 名片内容也是**平台给的字符串**（不是我编的）；拿不到就只说改了名片
      return card === '' ? `[${subject} 改了群名片]` : `[${subject} 的群名片改为「${card}」]`;
    }
    case 'group_upload':
      // OneBot 的 upload 通知里**没有 operator**：`user_id` 就是上传的那个人 ⇒ 两格都兜住
      return `[${actor || member(notice.targetId) || '某个群成员'} 上传了群文件]`;
    case 'essence':
      return `[${actor || member(notice.targetId) || '某个群成员'} 将一条消息设为精华]`;
    case 'notify': {
      if (notice.subType === 'poke') {
        return `[${actor || '某人'} 戳了戳 ${subject || '某人'}]`;
      }
      if (notice.subType === 'honor') {
        const honor = (notice.detail?.['honor_type'] ?? '').trim();
        return honor === '' ? `[${subject} 获得群荣誉]` : `[${subject} 获得群荣誉：${honor}]`;
      }
      // `notify` 的其他子类（`lucky_king` / `input_status` …）：不猜，整条丢掉
      return null;
    }
    case 'request':
      // 加好友 / 入群申请：`request_type` 由适配器写进 `subType`
      return notice.subType === 'friend'
        ? `[${actor || '某人'} 请求加为好友]`
        : `[${actor || '某人'} 请求加入群聊]`;
    default:
      return null;
  }
}

