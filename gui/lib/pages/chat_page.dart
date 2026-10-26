// TODO(i18n): 本文件还有 6 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/chat_page.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:convert';

// `ValueListenable` / `ValueNotifier`：那一行进度只重画自己，靠的就是它
// （见 ChatPageState.thinkingNow —— 换 setState 会把整页重建）
// （`FontFeature` 那个等宽数字特性由 material.dart 一并带出来，不用另 import `dart:ui`）
import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../app.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../markdown.dart';
// 关键动作留痕（`[input] tap=… page=…`）：卡死时"人最后按的是不是发送键"要能看见
import '../stall_watch.dart';
import '../theme.dart';
import '../theme/design_tokens.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

/// 聊天页 —— 与 Web 端同一套气泡语义：
/// 她在左（整段直出）、你在右（实心蓝）、系统行居中灰字、**工具调用是一个块**；
/// 她的话经 SSE 实时到。界面提示（空态/占位/错误）走 copy-guide 专业语气；她的人口吻属人格资产，不在此列。
///
/// **发言不逐字**：一开始做过打字机，看着就是难受。她的节奏来自 speak 逐条发
/// （彼此真的按打字速度隔开），不来自把一句完整的话一个字一个字挤出来——后者只是慢。
///
/// **历史能一直往上翻**（修订清单 ⑮）：界面上不再只有最近一屏，滚到顶会再往前取一页，
/// 直到日志开头那行状态说"没有更早的记录了"。做法与代价见 [ChatPageState._loadEarlier]
/// 与 [ChatPageState._anchorKey]。
class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.state});
  final AppState state;

  @override
  State<ChatPage> createState() => ChatPageState();
}

/// 右侧那一列的卡片宽度：**通道卡、框架提醒卡、上下文分界卡共用**。
///
/// 用户 ⑬ 补记："太短了，应该和这个一样长"——他要的是右侧那一列**看起来齐**，
/// 所以这是"这一列的属性"，不是某张卡自己的属性。上一轮那支按内容量宽度的
/// `_channelCardWidth` 就此作废：量出来的宽度让同一列出现好几种长度，正是这次要修的东西。
/// 420 是框架提醒卡原来的宽度，两类卡都听它；正文超过 420 自己换行，**不再随内容变**。
const double _kSideCardWidth = 420;

/// 往上翻历史时一次取多少条**原始事件**（不是"能上屏几条"）。
///
/// 服务端 `limit` 的上限是 1000（`EVENTS_MAX_LIMIT`），但一页别拉太多：一屏装不下，
/// 白读一堆；而 200 条原始事件里能上屏的通常只有几十条（mirror / reasoning / step/ 这些不上屏）。
/// 与 Web 端每批 200 同档（`web/pages/logs.js` 的 BATCH）。
const int _kHistoryPage = 200;

/// 认不出来的框架通报也叫这个名字（[frameworkNoticeLabel] 的兜底）。
///
/// 它是一条**兜底**而不是一个"待补的洞"：新来源（`via: 'compact'` 之类）第一次出现时，
/// 界面照旧把它摆成框架卡片，只是标签先落到这个词——**界面一行都不用改**。
///
/// i18n：这个常量是**中文那一份的字面值**，留给既有用例与其它引用点；界面渲染走
/// `s.tagFrameworkNotice`（见 [frameworkNoticeLabel]）。两处不许漂——`test/i18n_test.dart`
/// 有一条钉着"`ZhStrings` 与这些常量逐字相同"。
const String kFrameworkNoticeLabel = '框架通报';

/// 历史**读失败**时那一屏的标题。
///
/// 与空态的「会话尚未开始」是两句话：那句说"读成功、确实没有记录"，这句说"没读到"。
/// 对外可见（用例按这句话断言错误态真的出现了）。界面渲染走 `s.historyErrorTitle`。
const String kHistoryErrorTitle = '会话记录读取失败';

/// 「思考中」那一行槽位的高度（逻辑像素）。
///
/// 为什么要它：那一行出现/消失时**不许推动别的元素**（用户 2026-10-16 明写），
/// 所以它住在一个**定高的常驻槽位**里——不在想的时候那里就是一个空槽。
/// 取 20 的依据：那一行正文走主题的 `bodySmall`（本机 12px、行高 1.2 ⇒ 约 14.4），
/// 加一点上下呼吸留白就是 20；再高会在"她不在想"的整段时间里白占纵向空间，
/// 再低则会在某些字体缩放下把字挤到贴着输入框。
const double _kThinkingSlotHeight = 20;

/// 「跳到最新」那颗按钮的直径。26 的依据：它是**低调**的浮动按钮（用户 2026-10-16 ②），
/// 与输入框那颗 44 的发送按钮不是一级——但小到这个尺寸仍然一眼认得出是个按钮。
/// 命中区不由它决定：外层的 `IconButton` 自带 48 的最小命中区（见 [ChatPageState._thinkingSlot]）。
const double _kJumpButtonSize = 26;

/// 「服务端说这一轮结束了」那道对账的宽限期（毫秒）：**600**。
///
/// 为什么需要它（见 [ChatPageState.reconcileThinking]）：`turn/start` 是**本机**先从事件流
/// 看到的，而"她确实在跑"这件事要等下一次 `GET /api/stats/dashboard` 的响应才成立
/// （那份响应的节奏见 `gui/lib/app.dart` 的 `kTurnReadMs`＝250ms）。若不等这一下，
/// 一条刚落下的 `turn/start` 会立刻撞上"上一拍响应里 `openTurn` 还是 null"而被误杀，
/// 那一行就会在"她刚开口"的瞬间闪一下又没。
///
/// 为什么是 600：够放下**两次** dashboard 读数（250ms × 2 ＝ 500ms）再加一次网络开销；
/// 同时它**不是**"猜她多久会停"——真相仍旧只有服务端那一份响应说了算，这个窗口只决定
/// "这一读要等多久才算数与她对上"，所以它小到不掩盖任何事实。
const int kThinkingServerGraceMs = 600;

/// 宽限期的**覆盖值**（毫秒）；null = 用 [thinkingServerGraceMs]。
///
/// 做法照 `gui/lib/app.dart` 的 `turnSignalDebounceMsOverride`：**给测试用**。
/// 为什么用例侧需要一个覆盖口子：真机 600ms 的窗口在 `tester.pump` 的假时钟下
/// 与"几拍 UI 布局"是同一个尺度——用例要先让那一行立起来（那几拍就把 600ms 走完了），
/// 于是"宽限期内该不该收"这条**没法用真值测到**。把窗口放宽，用例就能明确地
/// 分两次读：一次在窗口内（不许收）、一次把时间推过窗口（必须收）。真机上没人设它。
int? thinkingServerGraceMsOverride;

/// 宽限期的实际取值：覆盖优先
int get thinkingServerGraceMs => thinkingServerGraceMsOverride ?? kThinkingServerGraceMs;

/// 「在底部」的容差（像素）。
///
/// 为什么不判 `pixels >= maxScrollExtent` 那么死：惯性滚动与 `animateTo` 收尾都会停在
/// 差几个像素的地方，判死的话"我明明在底部"也会亮着提示点。取 24 是半行文字的高度——
/// 小于它，人眼仍旧觉得"这就是最新"；大于它就会把"往上翻了一屏还亮着"当成在底部。
const double _kAtBottomSlack = 24;

/// 框架通报（`wake/manual` 里 `via` 有值的那一类）在卡片头上写什么标签。
///
/// **判据不在这里**——"是不是框架通报"只看 `via` 有没有值，那一处在 [ChatPageState._consume]
/// 里（`via.isNotEmpty`，一处，别在别处再写第二遍）。这张表只负责"这一种来源叫什么名字"：
/// 认不出来的一律叫 [kFrameworkNoticeLabel]，于是**新增一种 `via` 不必回来改界面**。
///
/// 为什么不反过来（按 via 逐个建容器/版式）：那正是原先把 `via == 'dream'` 写死在分支里的
/// 毛病——`'mcp'` 补上时没人回来改，那条框架通报就落进了"有 note = 用户的话"那一支
/// （用户 2026-10-09 的截图：他自己"说"了一段 MCP 通报）。文案会改、来源会加，
/// 只有"是不是框架通报"这一层是稳定的。
String frameworkNoticeLabel(String via, {AppStrings strings = const ZhStrings()}) {
  switch (via) {
    // 界面的 /dream 动作：那条 note 是框架替她拼的整理指令
    case 'dream':
      return strings.eventDream;
    // MCP 声明面被改（加/删/改 server）：正文是"哪些 server 变了、现在几个"
    case 'mcp':
      return strings.eventMcpDeclChanged;
    default:
      return strings.tagFrameworkNotice;
  }
}

enum _ItemKind { text, tool, channel, mention, boundary, injection }

/// 会话流里的一条：文本气泡、**一次工具调用**、**一条从消息适配器进来的消息**，
/// 或**一处上下文分界**（人工 reset / 系统压缩）。
///
/// 工具调用独立成类型的原因：`tool/call` 与 `tool/result` 是两条事件，人看到的却是
/// 一件事——所以回执到达时不是再添一行，而是**原地**把那个块从「运行中」变成结果。
///
/// 通道消息独立成类型（而不是塞进 `side: 'them'` 的气泡）：它不是"谁说的话"，
/// 是**外面递进来的一条输入**，形态与工具调用同类。见 [_ChannelBlock] 的说明。
class _BubbleItem {
  _BubbleItem.text({required this.side, required this.text, this.ts, this.detail})
      : kind = _ItemKind.text,
        quotes = const [],
        mentionsMe = false,
        mentionSid = null,
        channel = null,
        chatType = null,
        chatId = null,
        callId = null,
        toolName = null,
        toolArgs = null;

  _BubbleItem.tool({
    required this.callId,
    required String name,
    required this.toolArgs,
    this.ts,
  })  : kind = _ItemKind.tool,
        side = 'tool',
        text = name,
        quotes = const [],
        mentionsMe = false,
        mentionSid = null,
        channel = null,
        chatType = null,
        chatId = null,
        detail = null,
        toolName = name;

  /// 通道消息：`channel` / `chatType` / `chatId` 是拼 sid 用的三件套，**别在这里就把
  /// 发送者名字定下来**——名字来自 `/api/sessions`，那张表是单独取、可能后到的
  /// （见 [ChatPageState._contacts]）。
  _BubbleItem.channel({
    required this.text,
    required this.channel,
    required this.chatType,
    required this.chatId,
    this.ts,
    this.mentionsMe = false,
  })  : kind = _ItemKind.channel,
        side = 'channel',
        quotes = const [],
        mentionSid = null,
        callId = null,
        detail = null,
        toolName = null,
        toolArgs = null;

  /// 群里有人叫她（@ 或喊她的名字）——**框架注入的提醒卡**，不是通道消息卡。
  ///
  /// 用户 2026-10-02 的口径：这种时候界面上该是一张"框架提醒"——写着"某群聊发生了提及"，
  /// 外加 light 给的那句话题结论（"那边在聊什么"）。理由是它与"外面递进来一条消息"是两种
  /// 语义：这是**框架替她留意到、带上下文的告示**，也是她这一轮要接的那件事。
  _BubbleItem.mention({
    required this.text,
    required this.chatType,
    this.chatId,
    this.mentionSid,
    this.ts,
  })  : kind = _ItemKind.mention,
        side = 'injection',
        quotes = const [],
        mentionsMe = true,
        channel = null,
        callId = null,
        detail = null,
        toolName = null,
        toolArgs = null;

  /// 上下文分界：`compaction/summary` 那一条在流里的位置（修订清单 ⑮）。
  ///
  /// 它不是谁说的话、也不是一次工具调用，而是**上下文的一次分界**（人工 reset 或系统压缩），
  /// 所以单独一种条目，渲染时复用框架提醒那张卡、只换标签（[_NoticeCard]）。文案在 [_consume] 里按来源分两种。
  _BubbleItem.boundary({required this.text, this.detail, this.ts})
      : kind = _ItemKind.boundary,
        quotes = const [],
        mentionsMe = false,
        mentionSid = null,
        side = 'boundary',
        channel = null,
        chatType = null,
        chatId = null,
        callId = null,
        toolName = null,
        toolArgs = null;

  /// 注入预警：框架对**某一条外部消息**给出的判定（`injection/noted`，design §6.6）。
  ///
  /// 它不是谁说的话，所以不用气泡——与上下文分界同一张卡、只换标签（[_NoticeCard]），
  /// 也同一侧（靠右）。
  ///
  /// **这张卡是给人看的**（2026-10-02 用户改的口径）：摆的是"凭什么叫它有迹象"——
  /// 判定结论（`reason`）+ 它引的外人原话（`quotes`），与运行情况页那张框架提示同一个样子、
  /// 同一个危险色。框架**对她说**的那句话（`note`，结尾那句"…都由你"是给她的授权）不进这张卡：
  /// 人不需要读给她的话，那只会把"分析"淹掉。
  _BubbleItem.injection({
    required this.text,
    this.detail,
    this.ts,
    this.quotes = const [],
  })  : kind = _ItemKind.injection,
        side = 'injection',
        mentionsMe = false,
        mentionSid = null,
        channel = null,
        chatType = null,
        chatId = null,
        callId = null,
        toolName = null,
        toolArgs = null;

  final _ItemKind kind;
  final String side; // 'her' | 'me' | 'channel' | 'sys' | 'tool' | 'boundary'
  final String text;
  final String? ts;

  /// 注入预警卡里那几段**外人原话**（`injection/noted.quotes`）：与运行情况页同一形态
  /// ——左边一条竖线，一眼分得开"框架的结论"与"别人说了什么"。
  final List<String> quotes;

  /// 通道消息（kind == channel 时有效）：这条**在叫她**吗——平台 @ 或关键词命中名字。
  /// 判词用它（见 [_chatTypeLabel]），卡上那行说明也用它。
  final bool mentionsMe;

  /// 提及卡自己那一次的 light 话题结论（**不是**"这个会话最新的话题"）。
  ///
  /// 为什么必须是"自己那一次"：话题是逐条事件写下来的，一张卡只该记它被叫的那一次算出来的
  /// 结论；读"最新"的话，新话题一来旧卡也跟着改——那不是刷新，是改写当时看到过的东西。
  /// 由 [ChatPageState._consume] 在 `channel/topic` 到达时**认领**给最近一张还没拿到话题的卡。
  String? topic;

  /// 提及卡（kind == mention 时有效）：那个会话的 sid 与类型。
  ///
  /// 这张卡是**框架注入的提醒**（用户 2026-10-02）："某群聊发生了提及" + light 的话题结论，
  /// 而**不是**一条"群里的普通消息"——所以它单独成一种条目，不复用通道卡。
  final String? mentionSid;

  /// 把 sid 拆成"通道命名空间 + chatType + chatId"（提及卡只有 sid 也认得出场合）
  static String? sidOfRaw(Map<String, dynamic> data) {
    final channel = data['channel']?.toString();
    final chatType = data['chatType']?.toString();
    final chatId = data['chatId']?.toString();
    if (channel == null || chatType == null || chatId == null) return null;
    if (chatType.isEmpty || chatId.isEmpty) return null;
    final ns = channel == 'onebot' ? 'onebot' : 'qq';
    final kind = chatType == 'group-at' ? 'group' : chatType;
    return '$ns:$kind:$chatId';
  }

  /// 框架提醒那张卡的第二行（"人类可能希望关注的信息"，用户 ⑬）：定时器是谁、计划几点、
  /// 意图的正文、后台任务的 id、手动唤醒来自谁。没有可说的就留空，不硬凑。
  /// 上下文分界卡也用它（"往上的对话不再计入"那一句）。
  final String? detail;

  // 通道消息（kind == channel 时有效）：通道名 + 会话类型 + 会话 id
  final String? channel;
  final String? chatType;
  final String? chatId;

  // 工具块（kind == tool 时有效）
  final String? callId;

  /// 名字与参数**不是 final**：往上翻历史时可能"回执先到、调用后到"——回执落在先取到的那一页，
  /// 对应的 `tool/call` 在更早那一页里，那时回填这两个字段，而不是再立一个块
  /// （同一个 callId 画成两块，看着像她调了两次）。见 [ChatPageState._consume]。
  String? toolName;
  String? toolArgs;
  /// 回执到达时写入；null 表示还在跑
  String? toolResult;
  String? toolStatus;
  int? toolDurationMs;
  bool expanded = false;
}

class ChatPageState extends State<ChatPage> {
  final items = <_BubbleItem>[];

  /// messageId → 判定结论（`injection/flagged` 折出来的）。**不上屏**，只给示警卡当回退：
  /// 早于 2026-10-02 的 `injection/noted` 事件里没有 `reason`/`quotes`，没有这张表，
  /// 那几条卡会整张消失（判过的事不该在界面上凭空不见）。
  final _flaggedByMessage = <String, ({String reason, List<String> quotes, String by})>{};

  /// sid → light 给出的话题结论（`channel/topic` 折出来的）。**不上屏**：它属于提及卡上那一行
  /// （"那边在聊什么"）。后到的结论也能补上——卡在读这张表，`setState` 一来就重画。
  final _topicBySid = <String, String>{};
  final scroll = ScrollController();
  final input = TextEditingController();
  final inputFocus = FocusNode();
  StreamSubscription<Map<String, dynamic>>? sub;
  Timer? _retry;
  bool loadingHistory = true;

  /// 历史读失败的原因（null = 没失败）。
  ///
  /// **必须与"空历史"分开**：读不到时 `items` 也是空的，过去两者都落到「会话尚未开始」，
  /// 于是把"读不到"说成了"没有"，而且**再也没有第二次请求**。有了它，空态只在读成功
  /// 之后才说；读失败时显式落到错误态 + 一个重试入口（见 [loadHistory] 与 [build]）。
  String? _historyError;

  /// 她这一轮跑到哪儿了——**只喂「思考中」那一行**（见 [_thinkingSlot]）。
  ///
  /// 为什么走 `ValueNotifier` 而不是 `setState`：这一行的读数**一条 turn 里能变几十次**
  /// （每段推理、每一步），而 `setState` 会把整页重建（消息流里几千个 widget 都在那一棵树上）。
  /// 用户这一条的硬要求就是"只让这一行重建"⇒ 变化只走这个可监听对象，
  /// 由 [ThinkingRow] 自己订阅它（见 [_publishThinking]）。
  ///
  /// **公开**（state 类是私有的，所以挂在 widget 上给用例读，见 [ChatPage.thinking]）：
  /// 节流用例要数"那一行被放行了多少次"，而这是它唯一的入口。
  final thinkingNow = ValueNotifier<ThinkingProgress?>(null);

  /// 正在攒的那一份（未被节流放行的都先落在这里）
  ThinkingProgress? _pendingThinking;

  /// 那一行**这一次出现**的时刻（本机时钟）；不在想的时候是 null。
  ///
  /// 只给 [reconcileThinking] 的宽限期用：`turn/start` 是本机先看到的，服务端那份响应
  /// 可能还停在上一拍，没有宽限期的话"她刚开口"会被对账误杀。
  DateTime? _thinkingStartedAt;

  /// 测试接线柱：把"这一行是什么时候立起来的"往前拨，越过那个宽限期。
  ///
  /// 为什么需要它：宽限期是**抗新轮误杀**的（真机上是 600ms），而"她早停了、
  /// `turn/end` 又丢了"这条要测的场景必须**先等过它**——用例里没有别的办法把那一行
  /// 的时间往回拨（`DateTime` 只能靠时钟，而时钟一走，那些"刚开口"的断言就跟着变了）。
  /// **真机上没人设它**，所以它不是配置项，与 `gui/lib/app.dart` 的
  /// `turnSignalDebounceMsOverride` / `gateGraceSecondsOverride` 同一条先例。
  set thinkingStartedAtForTest(DateTime? value) => _thinkingStartedAt = value;

  /// 上一份**放行上屏**的时刻（本机单调时钟，毫秒）——节流窗口的起点
  int _thinkingShownAtMs = 0;

  /// 节流窗口到了之后补一次的那一拍（见 [_kThinkingThrottleMs]）
  Timer? _thinkingFlush;

  /// 视图**此刻在不在最底部**（在 [_kAtBottomSlack] 的容差内）。
  ///
  /// 它是「跳到最新」那颗按钮要不要露出来的判据，也是"新内容该不该亮提示点"的一半。
  /// 初值 false：首帧还没有 `ScrollMetrics`（`hasClients` 为假），量不出来就别假装在底部；
  /// [_onScroll] 第一次真跑起来就会把它纠正。
  bool _atBottom = false;

  /// 不在底部时又来了新内容 ⇒ 那颗按钮上亮一个小点。
  ///
  /// 清掉的时机只有两个：人点了「跳到最新」，或者他自己滚回了底部（`_onScroll` 里）。
  /// **不因"又来了更新的内容"而重置**——它说的是"你有没看的东西"，不是"刚刚又来了"。
  bool _jumpHint = false;

  /// 上一次量到的滚动范围（判"内容变长了"用；见 [_onScroll] 里那段）
  double _lastMaxExtent = 0;

  /// 帧后补量已经排上了没有（见 [_remeasureAfterGrowth]）
  bool _remeasureQueued = false;

  /// 正在量（[_onScroll] 的防重入闸：它可能由帧后回调触发，而它自己又会 `setState`）
  bool _inScrollMeasure = false;

  /// 列表的**锚点**：进页面时那一屏（`CustomScrollView` 的 `center`，见 [build]）。
  ///
  /// 为什么需要它：往上翻历史是**往前面插内容**，而普通列表插内容会把下面的一切往下推——
  /// 人正看着的那句话就跑了。把这一屏声明成 `center`，它在视口里的位置就与
  /// **它前面的内容有多少无关**：更早的内容插在它前面，屏幕上什么都不动。
  /// ⑮ 那条"往前面插内容时不能跳屏"是硬要求，与其事后算偏移量（惰性列表的高度只能估），
  /// 不如让布局自己保证——这是 Flutter 给前置插入准备的现成机制。
  final _anchorKey = GlobalKey();

  /// 已加载事件里**最小的 seq**（界面上最老那条所在的位置），也是往上翻的游标。
  /// 见 [_loadEarlier]：服务端只有向后读的 `from_seq`。
  int? _earliestSeq;

  /// 已经画过的 seq（修订 ⑳）：同一条事件可能从两条路进来——进页面时取的历史与 SSE 流，
  /// 或者翻页时两页的接缝。**去重按 seq**（日志的单调号），不按内容：
  /// 内容相同的两条真事件该各画一次。清屏（重新取历史）时这个集合要一起清，
  /// 否则同一批事件会被判成"见过"而整屏空白。
  final _seenSeqs = <int>{};

  /// 事件流里**最后见过的那条 seq**（null = 一条都还没见过）——断线重连的补拉锚点。
  ///
  /// 为什么要记它：服务端**本来就支持断线补拉**（`src/web/server.ts` 的 `openStream`：
  /// 带 `Last-Event-ID` 就从 `lastId + 1` 把漏掉的那一段重发一遍），而这里过去一次都没传，
  /// 于是断线窗口里的事件**永久丢**——里面最要命的是工具回执（块永远停在「正在执行…」）
  /// 与 `turn/end`。做法照 `gui/lib/app.dart` 的 `_lastEventSeq`（同一份口径）。
  ///
  /// **只增不减**：补拉来的旧事件、往上翻出来的更早一页，都不许把锚点往回带，
  /// 否则每补一次都要从头再补一遍。
  int? _lastEventSeq;

  /// `items` 里前多少条是"往上翻"翻出来的：它们住在锚点**前面**那个 sliver 里。
  int _olderCount = 0;

  /// 已经翻到日志开头了（拿到过 `seq 1`，或者再往前一页空手而归）。
  bool _atHead = false;
  bool _loadingEarlier = false;
  bool _earlierFailed = false;

  /// 一次"往上翻"要插到流**前面**：那批事件先画进这个临时列表，画完再整体插到 `items` 头部。
  /// 直接往 `items` 末尾追加会把这批更早的内容排到流尾，顺序就错了。
  List<_BubbleItem>? _prependSink;

  /// 会话别名（`config.persona.contacts`，键是 sid）：`GET /api/sessions` 的 `contacts`。
  ///
  /// 为什么不随每条通道消息去问一次：一条 turn 能进来几十条事件，而这张表是人手工填的、
  /// 几小时才动一次。进页面取一次 + 断线恢复时补一次就够了（见 [_loadContacts]）。
  Map<String, String> _contacts = const {};

  /// 别名表**取到过没有**。空表有两种（"人还没起过名字"和"这次没读到"），
  /// 前者要显示「未命名会话」、后者要重试——用长度分辨不出来。
  bool _contactsLoaded = false;

  @override
  void initState() {
    super.initState();
    unawaited(loadHistory());
    connectStream();
    // 滚到顶就自动往前翻一页（见 [_onScroll]）
    scroll.addListener(_onScroll);
    // 输入框聚焦时那圈描边要换成主色（见 [_composer]）：FocusNode 的变化**不进** setState
    // 的常规路径，必须自己挂一个监听。只重画这一页（页面本来就随输入重建）。
    inputFocus.addListener(_onFocusChange);
    // 断线时不发请求（后端没起来，问了也是白问），恢复连接那一刻补一次：
    // 人在离线期间去「会话联系人」填了名字，回来就能看到。
    widget.state.addListener(_onStateChange);
  }

  /// 输入框聚焦态变了 ⇒ 重画一次（那一圈描边是"当前焦点"的直接读数，见 [_composer]）
  void _onFocusChange() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChange);
    sub?.cancel();
    _retry?.cancel();
    _thinkingFlush?.cancel();
    thinkingNow.dispose();
    scroll.removeListener(_onScroll);    scroll.dispose();
    input.dispose();
    inputFocus.removeListener(_onFocusChange);
    inputFocus.dispose();
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && !_contactsLoaded) unawaited(_loadContacts());
    reconcileThinking();
  }

  /// 那一行收掉：清账 + 收掉待发的那一拍 + 立刻隐藏（**唯一**的收口，两条路共用）。
  ///
  /// 两条路：① 事件流里那条 `turn/end`（正常路径）；② 服务端读数说这一轮已经结束
  /// （[reconcileThinking]：`turn/end` **没到**时的兜底）。走同一个出口，
  /// 免得"哪条路该不该取消那个 250ms 补发"变成两处各判一次。
  void _endThinking() {
    _pendingThinking = null;
    _thinkingStartedAt = null;
    _thinkingFlush?.cancel();
    _thinkingFlush = null;
    _publishThinking(null, force: true);
  }

  /// 服务端读数说"这一轮已经结束了" ⇒ 把那一行收掉（`turn/end` **丢了**时的兜底）。
  ///
  /// ★ 为什么必须有这一条（用户 2026-10-16 ②「待机时那个思考标志还在」，实测根因）：
  /// 那一行的显隐**只认事件**——只有 `turn/end` 会让它收掉。而事件流是会断的：
  /// SSE 重连时断线窗口里那条 `turn/end` **补不回来**（`api.events()` 只在调用方显式传
  /// `lastEventId` 时才带 `Last-Event-ID`，而过去两处调用都没传；服务端的补拉链路本来是
  /// 现成的，见 `src/web/server.ts` 的 `openStream`）。于是一条丢掉的 `turn/end` 会让
  /// 那一行**永远挂着**——而左上那行字（判据取自响应）却能自己好，这就是"两处不一致"的来源。
  ///
  /// 判据仍然**只有服务端一处**：`openTurn == null`（服务端认为没有未收尾的 turn）
  /// **且** `thinking == false`（它没在跑）。界面不猜时间窗、不看进程在不在。
  ///
  /// 为什么要那个短宽限期（[thinkingServerGraceMs]）：`turn/start` 是**本机**先看到的，
  /// 服务端那份响应可能还停在上一拍（`openTurn == null`）——没有宽限期的话，
  /// 她刚开口那 250ms 里那一行会被这条对账**误杀**成"没在想"。
  ///
  /// 公开（而不是私有）：`ChatPageState` 是公开类型，用例要能驱动"服务端那一读之后
  /// 这一页怎么对账"这条链（见 `test/chat_progress_test.dart` 的 ② 那一组）。
  void reconcileThinking() {
    final pending = _pendingThinking;
    if (pending == null) return;
    final state = widget.state;
    // 服务端说"还在跑" ⇒ 一点都不用动（哪怕本地这一行的读数偏小）
    if (state.thinking || state.openTurn != null) return;
    // 服务端说"没在跑、也没有开着的 turn"：先给它一个短宽限期再落实
    final startedAt = _thinkingStartedAt;
    if (startedAt == null) return;
    if (clock.now().difference(startedAt) < Duration(milliseconds: thinkingServerGraceMs)) {
      return;
    }
    if (!mounted) return;
    _endThinking();
    setState(() {});
  }

  /// `_consume` 往哪儿落：平时是 `items` 末尾，往上翻的那一批落进 [_prependSink]。
  List<_BubbleItem> get _sink => _prependSink ?? items;

  /// 还有没有更早的。seq 1 是日志的头（`/api/events` 的 `from_seq` 最小就是 1）。
  bool get _hasEarlier => !_atHead && (_earliestSeq ?? 1) > 1;

  /// 滚到顶就往前翻——**没有"加载更早"按钮**。
  ///
  /// 为什么选自动而不是按钮：用户这一条的原话是"上写滚动后我发现，不能查看全部历史"，
  /// 缺的正是**往上滚这个动作本身该有结果**。按钮要他先滚到顶、再找按钮、再点一下，
  /// 中间那一步在长列表里最容易被忽略（按钮会随内容滚出屏幕）。往上插内容不跳屏由
  /// [_anchorKey] 保证，所以"滚到头 → 内容变多"可以做到无感；到没到头这件事交给
  /// 列表上方那行状态说（[_historyNote]）。
  ///
  /// 视图此刻贴没贴到底部（**[_kAtBottomSlack] 容差内**）。
  ///
  /// 判据只有这一处：`pixels` 与 `maxScrollExtent` 的差。容差不是"宽松"而是**必需**——
  /// 惯性滚动与 `animateTo` 收尾都停在差几个像素的地方；判成等号的话，
  /// 一个明明在看最新的人会被当成"他翻上去了"（于是提示点亮着不走）。
  ///
  /// 还没有 `ScrollMetrics`（首帧、或列表短到滚不动）时算**在底部**：
  /// 那时候没有"上面还有没看的"这回事，按钮不该露出来。
  bool _atBottomNow() {
    if (!scroll.hasClients) return true;
    final position = scroll.position;
    return position.pixels >= position.maxScrollExtent - _kAtBottomSlack;
  }

  /// 内容新增了一条之后补量一次（下一帧）。
  ///
  /// **为什么光靠 [_onScroll] 不够**（实测撞出来的一个真 bug）：`ScrollPosition` 只在
  /// **位置真的变了**的时候通知监听器。列表短到滚不动时（内容还没超出一屏）位置永远是 0，
  /// 于是她说话、内容长出来，`_onScroll` 一次都不会被叫到——那颗按钮上的提示点就永远不亮。
  /// 而"她刚开口那几句"恰好就是这种时候。
  ///
  /// 也不能只靠"`maxScrollExtent` 变大了"来判新增：内容装得下时它压根不变（上面那一条），
  /// 而装得下正是"她刚开始说话"的常态。所以**新增这件事由调用方直接告诉它**，
  /// 不靠量出来的差值反推。
  ///
  /// 排到帧后而不是当帧量：`_consume` 只是往列表里塞了数据，新内容的布局要等这一帧画完
  /// 才知道。
  void _remeasureAfterAdded() {
    if (_remeasureQueued) return;
    _remeasureQueued = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        _remeasureQueued = false;
        return;
      }
      // **先量完再放闸**：`_onScroll` 自己会 `setState`，而 `setState` 会让这一页重画、
      // 内容可能又长了一点点——闸在这里就放下的话，那一拍会撞上防重入直接返回，
      // 于是"内容变长了"这件事量不到（实测：提示点因此永远不亮）。
      _onScroll(added: true);
      _remeasureQueued = false;
    });
  }

  /// 量一次"在不在底部 / 内容长没长"，并按结果更新那颗按钮。
  ///
  /// 两侧入口都走这里：用户滚动（[scroll] 的监听器，[added] 为 false）与
  /// 内容新增（[_remeasureAfterAdded]，[added] 为 true）。
  /// 两条都要——只看滚动会漏掉"列表短到滚不动"那一段（见上），只看新增则漏掉
  /// "人自己滚上去/滚回来"。
  ///
  /// [added] = 这一次量之前确实多了一条内容：人不在底部 ⇒ 该亮提示点。
  /// 不这么传的话只能靠 `maxScrollExtent` 变大来猜，而"装得下"时它不变（那正是最常见的一段）。
  ///
  /// 为什么留 48 的余量（这一段是既有的）：滚轮一格就是 120，等真的贴到 `minScrollExtent`
  /// 才判断的话，位置停在顶端不再变化，监听器根本不会被叫到（"到顶没反应"的经典原因）。
  void _onScroll({bool added = false}) {
    // 帧后补量那一拍是从 `setState` 里排出来的，而它自己又可能 `setState`：
    // 加一道闸，免得在布局期间绕回来（那会抛 "setState during build"）
    if (_inScrollMeasure) return;
    _inScrollMeasure = true;
    try {
      final position = scroll.hasClients ? scroll.position : null;
      if (position != null &&
          position.pixels <= position.minScrollExtent + 48) {
        unawaited(_loadEarlier());
      }
      // 量不到滚动范围（列表空着、或短到没有 Scrollable）⇒ 按"在底部"算：
      // 那时候没有"上面还有没看的"这回事
      final maxExtent = position?.maxScrollExtent ?? 0;
      final pixels = position?.pixels ?? maxExtent;
      final grew = maxExtent > _lastMaxExtent + 1;
      _lastMaxExtent = maxExtent;
      final atBottom = pixels >= maxExtent - _kAtBottomSlack;
      // 人自己滚回底部 = 他把东西看完了 ⇒ 收掉那个提示点（与"点了跳到最新"同一条出口）
      final hint = atBottom ? false : (_jumpHint || grew || added);
      if (atBottom == _atBottom && hint == _jumpHint) return; // 只在真的变了才重画
      setState(() {
        _atBottom = atBottom;
        _jumpHint = hint;
      });
    } finally {
      _inScrollMeasure = false;
    }
  }

  /// 列表上方那行状态（**不是一条消息**，所以不加壳、不成卡）。null = 没有话说。
  ///
  /// 为什么摆在**流里面、而且是第一条**：它出现/消失时不能把屏幕推走。
  /// 在锚点**前面**插一行（或从那里删一行）不会动到锚点及它后面的一切（见 [_anchorKey]）；
  /// 摆在滚动区外面当一条常驻横条就不一样了——它一出现就把整个列表往下推 30 像素，
  /// 而那正好发生在"人滚到顶"的那一刻（实测：同一句话在加载前后差了 36 像素）。
  ///
  /// 代价如实说：它只在人真的滚到最上面时才看得见（那正是需要它的时候）。
  String? get _headNote {
    final s = IrmiaStrings.read(context);
    if (_earlierFailed) return s.earlierFailed;
    if (!_hasEarlier && items.isNotEmpty) return s.noEarlier;
    return null;
  }

  /// 那一行状态长什么样：居中的一句小灰字。
  ///
  /// 不做成卡片、也不靠右：它**不是一条消息**，是列表自己的边界读数——
  /// "左边留她说的、其余靠右"那条规矩管的是事件（谁说的、谁递进来的），不管列表的边。
  Widget _noteRow(String text) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
        child: Center(
          child: Text(
            text,
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 11.5, color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
        ),
      );

  Future<void> loadHistory() async {
    // 别名与历史一起取：两者到齐才画得对（边到边画会让卡片先显示「未命名会话」再翻名字）
    unawaited(_loadContacts());
    // 重试入口：先把上一轮的错误态收掉、回到 loading（第一拍本来就在 loading 里，不额外重建）
    if (_historyError != null) {
      setState(() {
        _historyError = null;
        loadingHistory = true;
      });
    }
    try {
      final data = await widget.state.api.get('/api/events?limit=60');
      final events = (data is Map ? (data['events'] as List?) : null) ?? const [];
      // 历史也走同一条消费路径（call/result 照样配对），只是不播进场动画
      items.clear();
      _seenSeqs.clear(); // 与 items 同生共死：重取历史时它们是"新"的
      // 补拉锚点同理：这一份历史要是比上一份短，旧锚点会让重连从半空开始
      _lastEventSeq = null;
      _earliestSeq = null;
      _olderCount = 0;
      _atHead = false;
      for (final raw in events.whereType<Map>()) {
        _consume(raw.cast<String, dynamic>());
      }
      if (!mounted) return;
      setState(() {
        loadingHistory = false;
        _historyError = null;
      });
      // 进页面那一次**只在底部**（不是每次来新内容都跟）：人刚打开这一页，
      // 他要看的就是最新那几句。之后一律不自动跟随（见 [_jumpToLatest]）。
      _jumpToLatest();
    } catch (err) {
      // 读不到 **不是**"没有"：留住原因、显式落到错误态，等人在那里点「重试」。
      // 过去这一格只写 `loadingHistory = false`，于是界面把"读不到"说成「会话尚未开始」，
      // 而且永远不再请求第二次——那是把一种故障说成了一种事实。
      if (mounted) {
        setState(() {
          loadingHistory = false;
          _historyError = '$err';
        });
      }
    }
  }

  /// 往上翻一页。
  ///
  /// **服务端只有向后读的游标**（`src/web/server.ts` 的 `listEvents`：认 `types` / `visibility`
  /// / `from_seq` / `limit` 四个查询参数，没有 `before` / `since` / 按 seq 取上界那种）。
  /// `from_seq=N&limit=L` 的语义是"从 seq ≥ N 起按升序取**前** L 条"（`collectEvents`），
  /// 所以"更早一页"= 从**当前最老那条往前退一页**开始，再向**后**读一页。本机日志 seq 连续
  /// （5745 条、1..5745 实测无缺口），于是这一页正好接在当前最老那条的前面。
  ///
  /// `limit` 的服务端上限是 1000，这里按 [_kHistoryPage] 取 200：一页够翻几屏，
  /// 又不至于一次拉全量（本机此刻 5700+ 条）——那是几十 MB 的 JSON 与几千个 widget。
  Future<void> _loadEarlier() async {
    final oldest = _earliestSeq;
    if (_loadingEarlier || oldest == null || oldest <= 1 || _atHead) return;
    setState(() {
      _loadingEarlier = true;
      _earlierFailed = false;
    });
    try {
      var cursor = oldest - _kHistoryPage < 1 ? 1 : oldest - _kHistoryPage;
      final older = <Map<String, dynamic>>[];
      int? firstSeq;
      // seq 有空洞时第一页的末尾会够不到"当前最老那条"，顺着往前再补一页。
      // 本机无洞（实测），这一圈一次都没跑过；留着是因为服务端的注释明说 seq 可能有洞。
      for (var round = 0; round < 4; round++) {
        final data =
            await widget.state.api.get('/api/events?from_seq=$cursor&limit=$_kHistoryPage');
        final raw = (data is Map ? (data['events'] as List?) : null) ?? const [];
        final batch = raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
        if (batch.isEmpty) break;
        var last = cursor - 1;
        for (final event in batch) {
          final seq = event['seq'];
          if (seq is! num) continue;
          last = seq.toInt();
          // 已经在屏上的（seq 不比最老那条小）不再画第二遍
          if (last < oldest) older.add(event);
          firstSeq ??= last;
        }
        if (last + 1 >= oldest) break; // 接上了
        cursor = last + 1;
      }
      if (!mounted) return;
      if (older.isEmpty) {
        // 一条都没拿到：seq 1 之前没有事件了
        setState(() {
          _atHead = true;
          _loadingEarlier = false;
        });
        return;
      }
      final sink = <_BubbleItem>[];
      _prependSink = sink;
      try {
        for (final event in older) {
          _consume(event);
        }
      } finally {
        _prependSink = null;
      }
      setState(() {
        items.insertAll(0, sink);
        _olderCount += sink.length;
        if (firstSeq != null && firstSeq <= 1) _atHead = true;
        _loadingEarlier = false;
      });
    } catch (_) {
      // 静默降级成"那行状态说一声"：这是一页历史，读不到不该把整页拖进错误态
      if (mounted) {
        setState(() {
          _loadingEarlier = false;
          _earlierFailed = true;
        });
      }
    }
  }

  void connectStream() {
    sub?.cancel();
    // **补拉锚点**：把最后收到的那条 seq 交给服务端（见 [_lastEventSeq]）。
    // 服务端据此从 `lastId + 1` 重发到尾部，断线窗口里的事件因此还能到——
    // 不传的话那一段永久丢，工具块会永远停在「正在执行…」。
    sub = widget.state.api.events(lastEventId: _lastEventSeq).listen(
      (event) {
        // 她跑到哪儿了：**只在这条实时链路上采**，不走 [_consume]。
        // 理由是实测出来的那条：`loadHistory()` 与 [_loadEarlier] 也调 `_consume`，
        // 把采集挂进去的话，一进页面就会拿**历史里那些** turn/reasoning 事件算出一份
        // 假的"她正在想第 N 步、已想 X 字"（翻页时更糟：翻到哪一年的旧账就报哪一年）。
        _trackThinking(event);
        // **先量位置、再吃事件**：`_consume` 会把内容变长，而内容一变长，
        // "离底部还有多远"就跟着变大——那时候再量，一个本来贴在底部的人会被误判成
        // "他往上翻了"（于是第一次来新内容就不再跟随了）。所以这一读必须在前面。
        final wasAtBottom = _atBottomNow();
        final added = _consume(event);
        if (!mounted) return;
        setState(() {});
        // **不自动滚动**（用户 2026-10-16 ①）：她说话、回执原地更新、工具卡片刷新，
        // 一律不许把视图拽到底——人正在往回看的时候被拽走，正是他要修的那件事。
        // 新内容到达这件事改由「跳到最新」那颗按钮说（不在底部时亮一个小点，见 [_onScroll]）。
        // 只剩"他本来就在看最新"这一种情况跟着走：那是他自己停在底部的选择，跟着滚不打扰他。
        if (added && wasAtBottom) _jumpToLatest();
        // 内容新增了一条：下一帧补量一次（列表短到滚不动时 `_onScroll` 不会被叫到，
        // 那正是"她刚开口"的时候——见 [_remeasureAfterAdded]）
        if (added) _remeasureAfterAdded();
      },
      onError: (_) {
        // 断线重连：3 秒后重连，并把最后收到的 seq 当 `Last-Event-ID` 交出去
        // （见 [_lastEventSeq]），服务端据此补发断线窗口里漏掉的那一段。
        _retry?.cancel();
        _retry = Timer(const Duration(seconds: 3), () {
          if (mounted) connectStream();
        });
      },
      onDone: () {
        // 同上：正常收流也走同一条重连路，锚点照旧带上（补拉是幂等的，按 seq 去重）
        _retry?.cancel();
        _retry = Timer(const Duration(seconds: 3), () {
          if (mounted) connectStream();
        });
      },
    );
  }

  /// 会话别名表（`config.persona.contacts`）：进页面取一次，断线恢复时补一次。
  ///
  /// **取不到就静默降级**：这一页的主线是会话流本身，别名只是一行字——为它把整页拖进
  /// 错误态（或者让卡片显示不出来）是本末倒置。失败时留个 [_contactsLoaded] = false，
  /// 连接恢复时自然会再来一次，不额外排轮询。
  Future<void> _loadContacts() async {
    try {
      final data = await widget.state.api.get('/api/sessions');
      final raw = data is Map ? data['contacts'] : null;
      if (!mounted) return;
      setState(() {
        // 非对象一律当"没读到"：一个畸形的返回不该把已经显示出来的名字抹掉
        if (raw is Map) {
          _contacts = {
            for (final entry in raw.entries) '${entry.key}': '${entry.value}',
          };
          _contactsLoaded = true;
        }
      });
    } catch (_) {
      // 静默：下次连接恢复时会再试（不在这里排重试定时器——别为一行字加一个心跳）
    }
  }

  /// 一条通道消息在界面上该写谁发的：**别名**（人在「消息适配器 → 会话联系人」里填的那个）。
  ///
  /// 这里刻意**不退回 openid**（用户的硬要求）：那串字符既不是名字也不是给人认的，
  /// 摆在卡片上只会让人误以为它是个人名。取不到就显示 [kUnnamedSender]——让"这个人还没起
  /// 名字"这件事自己看得出来，也顺带成了去那一页填一下的理由。
  String _chanSenderOf(_BubbleItem item) {
    final sid = _sidOf(item);
    if (sid == null) return kUnnamedSender;
    // 新旧两种写法都试（与后端 `sidLookupKeys` 同口径）：联系人表里可能还留着归一之前的
    // `qq:group-at:<群id>`——只查一种写法，群聊就会显示「未命名会话」（实测撞到过两次）
    final name = _contacts[sid] ?? _contacts[_legacySidOf(sid)];
    return name == null || name.isEmpty ? kUnnamedSender : name;
  }

  /// 事件 → 流里的一条（与 Web chat.js 同一张映射表；镜像与过程不上屏）。
  ///
  /// 返回 true 表示**新增了一条**——回执是原地更新已有块的，不该把正在看的人拽到末尾。
  bool _consume(Map<String, dynamic> event) {
    // 事件处理器里取文案：**不登记依赖**（read 而不是 of）。这些字是"发生过的事"
    // 的记录，落进 items 之后就不再跟着语言变——与她的发言正文同一档。
    final s = IrmiaStrings.read(context);
    // 往上翻的游标：**每条事件都记**，包括不上屏的那些——翻的是日志的位置，
    // 不是"画了几条"。少记一条就会在下一页里把它重复画出来。
    final seq = event['seq'];
    if (seq is num) {
      final value = seq.toInt();
      // **见过的不再画第二遍**（修订 ⑳）：用户截图里同一条「上下文在此处清空 06:52」
      // 出现了两次。工具块靠"同一 callId 不立第二块"自保，别的条目没有这层保护——
      // 历史那一份与流里那一份（或翻页接缝）会各画一遍。闸门放在最前面：
      // 连游标都不必再更新，那条早就记过了。
      if (!_seenSeqs.add(value)) return false;
      // 断线补拉的锚点（见 [_lastEventSeq]）：每条事件都记、只增不减
      if (_lastEventSeq == null || value > _lastEventSeq!) _lastEventSeq = value;
      if (_earliestSeq == null || value < _earliestSeq!) _earliestSeq = value;
    }
    final data = (event['data'] as Map?)?.cast<String, dynamic>() ?? const {};
    final ts = event['ts']?.toString();
    switch (event['type']) {
      case 'message/assistant':
        final text = (data['text']?.toString() ?? '').trim();
        if (text.isEmpty) return false;
        _sink.add(_BubbleItem.text(side: 'her', text: text, ts: ts));
        return true;
      case 'message/user':
        return false; // 唤醒输入的渲染镜像，不上屏
      case 'wake/manual': {
        final note = (data['note']?.toString() ?? '').trim();
        // **判据只有这一处：`via` 有值 = 框架通报**——框架替他做的那个动作留下的通报
        // （界面的 /dream、MCP 声明面被改……）。用户自己在输入框里打的话从来不经过这一格：
        // 看门文件那条路（`src/wake/sources.ts`）只搬 note / dedupeKey / person，压根没有 via。
        //
        // 为什么**不按 via 的值分流**：原先这里写死成 `via == 'dream'`，2026-10-09 补上
        // `'mcp'` 时就漏了一次——那条通报落进下面"有 note = 用户的话"那一支，被摆成右侧
        // 蓝气泡（用户当天截的图：他自己"说"了一段 MCP 通报）。**文案会改、来源会加**，
        // 只有"是不是框架通报"这一层是稳定的；以后再加 `'compact'`（压缩通报）这类
        // **不必回来改界面**：一样走同一张框架卡，标签由 [frameworkNoticeLabel] 兜底。
        // 往这里加分支之前先读这一段：这一格只该有这一个判断。
        final via = (data['via']?.toString() ?? '').trim();
        if (via.isNotEmpty) {
          _sink.add(_BubbleItem.text(
            side: 'sys',
            text: frameworkNoticeLabel(via, strings: s),
            detail: note.isEmpty ? null : note,
            ts: ts,
          ));
          return true;
        }
        // 空 note = 界面上按了「立即唤醒」：那是**框架的动作**，不是谁说的话 → 走提醒卡（靠右）。
        // 有 note = 用户在输入框里打的话 → 仍是他自己的右侧气泡：人说的话才用气泡。
        if (note.isEmpty) {
          // 谁按的这一下也算信息（`person` 是用户时更该说清）
          final person = (data['person']?.toString() ?? '').trim();
          _sink.add(_BubbleItem.text(
            side: 'sys',
            text: s.manualWake,
            detail: person.isEmpty ? null : s.fromWho(person),
            ts: ts,
          ));
          return true;
        }
        final mine = _BubbleItem.text(side: 'me', text: note, ts: ts);
        // 乐观渲染去重：你刚发的那句话已上屏，wake 回显是同一句话。
        // 只跟**这次要落的那一份**比：往上翻历史时拿屏上的气泡去比，会把一句老话误删。
        if (_sink.any((e) => e.side == 'me' && e.text == mine.text)) return false;
        _sink.add(mine);
        return true;
      }
      case 'wake/channel': {
        // 通道消息**不是她的气泡**：它是外面递进来的一条输入，靠右、成卡片（修订清单 ⑬）。
        // 发送者名字这里不解析——别名表可能还没到，等到渲染时再按 sid 查一次。
        //
        // **群里有人叫她（@ 或喊名字）时走另一种卡**（用户 2026-10-02 的口径）：
        // 那是"框架注入的提醒"——"某群聊发生了提及"+ light 给出的话题结论，
        // 而不是一条"群里的普通消息"。私聊与群里的非提及（理论上不会进这条流）照旧用通道卡。
        final chatType = data['chatType']?.toString();
        final mentioned = chatType == 'group-at' || data['mentionsMe'] == true;
        if (mentioned && chatType != 'c2c') {
          _sink.add(_BubbleItem.mention(
            text: data['text']?.toString() ?? '',
            chatType: chatType,
            chatId: data['chatId']?.toString(),
            mentionSid: _BubbleItem.sidOfRaw(data),
            ts: ts,
          ));
          return true;
        }
        _sink.add(_BubbleItem.channel(
          text: data['text']?.toString() ?? '',
          channel: data['channel']?.toString(),
          chatType: chatType,
          chatId: data['chatId']?.toString(),
          mentionsMe: data['mentionsMe'] == true,
          ts: ts,
        ));
        return true;
      }
      case 'channel/topic': {
        // light 给出的话题结论：缀在**它自己那一次**的提及卡上。**不上屏**——它属于那张卡的一行，
        // 单独摆出来就成了"框架在自言自语"。位置天然正确：概括就在叫她那一条之后写。
        //
        // **只缀一次、只缀最近那一张**（2026-10-02 用户：「有了新话题，旧的卡片也变了？」）：
        // 原来卡是在渲染时读"这个会话最新的话题"，于是新话题一来，之前每一张提卡都跟着改
        // ——把当时那张卡的内容改掉了，等于改写历史。现在按事件顺序**认领**：
        // 这张话题属于"它之前最后一张还没拿到话题的提及卡"，认领过就不再看别人。
        final sid = data['sid']?.toString() ?? '';
        final topic = (data['topic']?.toString() ?? '').trim();
        if (sid != '' && topic != '') {
          _topicBySid[sid] = topic;
          // 归**最近那一张**提及卡：真实链路上话题就是它触发的那次概括写下来的（紧跟在被叫
          // 那一条之后）。同一张卡后来的新结论覆盖旧的（那是同一个"当时"）；而**更早的卡不动**
          // ——它们各自有自己那一次的话题，或者就没有（用户 2026-10-02 报过"旧卡片也变了"）。
          for (var i = items.length - 1; i >= 0; i -= 1) {
            final candidate = items[i];
            if (candidate.kind != _ItemKind.mention || candidate.mentionSid != sid) continue;
            candidate.topic = topic;
            break;
          }
        }
        return false;
      }
      case 'compaction/summary': {
        // 上下文的一处分界（修订清单 ⑮）。**位置天然正确**：它就是流里那两条事件之间的一条，
        // 所以只在这里添一张卡，别往末尾插（那会把它挪到"最新"的位置上，正好说反）。
        final manual = _isManualReset(event);
        _sink.add(_BubbleItem.boundary(
          text: manual ? s.contextClearedHere : s.contextCompactedHere,
          detail: manual ? s.contextClearedHereDetail : s.contextCompactedHereDetail,
          ts: ts,
        ));
        return true;
      }
      case 'injection/flagged': {
        // 判定结论（谁判的、凭什么、引了哪几句）——**不上屏**，只记进内存表。
        // 为什么留着它：`injection/noted` 的 `reason`/`quotes` 是 2026-10-02 才加的，
        // 那之前落库的示警事件只有给她的 `note`；没有这张表，那几条卡会**整张消失**
        // （判过的事不该在界面上凭空不见）。示警那条优先用自己的字段，缺了才回退到这里。
        final messageId = data['messageId']?.toString() ?? '';
        if (messageId.isEmpty) return false;
        final rawQuotes = data['quotes'];
        _flaggedByMessage[messageId] = (
          reason: (data['reason']?.toString() ?? '').trim(),
          quotes: rawQuotes is List
              ? rawQuotes.map((quote) => '$quote'.trim()).where((quote) => quote.isNotEmpty).toList()
              : const <String>[],
          by: data['by']?.toString() ?? '',
        );
        return false;
      }
      case 'injection/noted': {
        // 框架对某条外部消息给出的判定（v25；2026-10-02 改成"给人看的那一半"）。
        // **位置天然正确**：它就是流里紧跟在
        // 那条通道消息之后的一条事件，所以只在这里添一张卡——不往末尾插（那会把它挪到
        // "最新"的位置上，而它说的是一条已经翻上去的消息）。
        //
        // 摆出来的三样都来自服务端：判定结论（`reason`）、引文（`quotes`）、判定来源（`by`）。
        // **框架对她说的那句话（`note`）不进这张卡**（用户：这张卡是给人看的，
        // 只需要像运行情况里那样有分析就行）——它仍然逐字留在事件里、也仍然是她看到的那句话。
        // 卡头那句标题是这里的常量：与 ask 卡同一条防伪口径，别人发的消息改不动框架说的话长什么样。
        final messageId = data['messageId']?.toString() ?? '';
        final fallback = _flaggedByMessage[messageId];
        final reason = (data['reason']?.toString() ?? '').trim().isEmpty
            ? (fallback?.reason ?? '')
            : (data['reason']?.toString() ?? '').trim();
        final rawQuotes = data['quotes'];
        final own = rawQuotes is List
            ? rawQuotes.map((quote) => '$quote'.trim()).where((quote) => quote.isNotEmpty).toList()
            : const <String>[];
        final quotes = own.isNotEmpty ? own : (fallback?.quotes ?? const <String>[]);
        if (reason.isEmpty && quotes.isEmpty) return false;
        final who = (data['who']?.toString() ?? '').trim();
        final person = (data['person']?.toString() ?? '').trim();
        final where = (data['chatType']?.toString() ?? '') == 'c2c'
            ? s.chatTypeDirect
            : s.chatTypeGroup;
        final by = ((data['by']?.toString() ?? '') == 'model' || fallback?.by == 'model')
            ? s.byModel
            : s.byRule;
        final source = [
          if (who.isNotEmpty) s.fromWho(who),
          where,
          if (person.isNotEmpty && person != who) person,
          by,
        ].join(' · ');
        _sink.add(_BubbleItem.injection(text: reason, detail: source, ts: ts, quotes: quotes));
        return true;
      }
      case 'tool/call': {
        // 她动了什么手：一个块，不是一行。call 与 result 是两条事件，人看到的是一件事。
        final name = (data['name']?.toString() ?? '').trim();
        if (name.isEmpty) return false;
        final callId = data['callId']?.toString();
        // 同一个 callId 只该有一个块。往上翻历史时会撞上"回执先到、调用后到"：
        // 孤立回执已经按下面的兜底立过一个块（名字只能是「tool」，回执里没有 name），
        // 现在把真名字与参数补上去，而不是再立一块。
        final existing = _findToolBlock(callId);
        if (existing != null) {
          if (existing.toolName == null || existing.toolName == 'tool') existing.toolName = name;
          existing.toolArgs ??= data['arguments']?.toString();
          return false;
        }
        _sink.add(_BubbleItem.tool(
          callId: callId,
          name: name,
          toolArgs: data['arguments']?.toString(),
          ts: ts,
        ));
        return true;
      }
      case 'tool/result': {
        // 回执**原地**更新那个块——不新起一行，否则工具一多就散成一堆碎行
        final callId = data['callId']?.toString();
        var block = _findToolBlock(callId);
        // 孤立回执（call 落在历史窗口之外）：照样摆一个块，不留白
        if (block == null) {
          final fallback = (data['name']?.toString() ?? '').trim();
          block = _BubbleItem.tool(
            callId: callId,
            name: fallback.isEmpty ? 'tool' : fallback,
            toolArgs: null,
            ts: ts,
          );
          _sink.add(block);
        }
        block.toolStatus = data['status']?.toString();
        // 内容为空时拿 error.message 顶上：失败原因才是人最想看的，不能只写「出错」
        final content = (data['content']?.toString() ?? '').trim();
        final errMessage = (data['error'] as Map?)?['message']?.toString();
        // **上屏前剥掉终端装饰**（用户 2026-10-16 ③：截图里那行 `[32;1mName[0m…`）。
        // 剥在**入口**而不是画的时候：折叠态与展开态读的是同一份 `toolResult`，
        // 只修一处的话"展开全部"里那串颜色码照旧露着（而且它还算进"共 N 字"）。
        block.toolResult = sanitizeToolOutput(content.isEmpty ? (errMessage ?? '') : content);
        final ms = data['durationMs'];
        block.toolDurationMs = ms is num ? ms.toInt() : null;
        return false;
      }
      case 'wake/timer': {
        // 「人类可能希望关注的信息」（用户 ⑬）：是哪个定时器、原定几点。两者都缺就不写。
        final id = (data['timerId']?.toString() ?? '').trim();
        final at = _hhmm(data['scheduledAt']?.toString() ?? '');
        _sink.add(_BubbleItem.text(
          side: 'sys',
          text: s.schedulerFire,
          detail: [if (id.isNotEmpty) id, if (at.isNotEmpty) s.scheduledAt(at)].join(' · '),
          ts: ts,
        ));
        return true;
      }
      case 'wake/intention': {
        // 意图的正文就是这条提醒的全部意义——不摆出来，人只看到"意图唤醒"四个字
        final content = (data['content']?.toString() ?? '').trim();
        _sink.add(_BubbleItem.text(
          side: 'sys',
          text: s.intentWake,
          detail: content.isEmpty ? null : content,
          ts: ts,
        ));
        return true;
      }
      case 'wake/job': {
        final id = (data['jobId']?.toString() ?? '').trim();
        _sink.add(_BubbleItem.text(
          side: 'sys',
          text: s.backgroundProgress,
          detail: id.isEmpty ? null : id,
          ts: ts,
        ));
        return true;
      }
      case 'wake/heartbeat':
        return false; // 心跳不打扰
      case 'human/answered':
        _sink.add(_BubbleItem.text(side: 'sys', text: s.humanReplyRecorded, ts: ts));
        return true;
      case 'review/resolved':
        final ok = data['outcome'] == 'succeeded';
        _sink.add(_BubbleItem.text(side: 'sys', text: ok ? s.markedOk : s.markedFailed, ts: ts));
        return true;
      default:
        return false;
    }
  }

  // ── 「思考中 · 第 N 步 · 已想 X 字 · 用时 M:SS」那一行（用户 2026-10-16「加一行紧凑进度」） ──
  //
  // 三样读数**各有出处**，一处都不许自己算：
  //   · 步号 ← `step/start` 的 `data.step`（`src/log/types.ts` 的 StepStart，服务端就在这条里给步号）；
  //   · 字数 ← `message/reasoning` 的 `data.text` 长度累加（ReasoningMessage{ turn, step, text }）。
  //     ★ 这条事件是 `internal` 可见性，但 **SSE 不过滤 visibility**（`src/web/server.ts` 的
  //     `pump()`/`broadcast()` 把每条都广播出去；`EVENT_VISIBILITY` 只管"进不进她的上下文"），
  //     所以界面收得到——本机实测确认过这一点，累计字数才有数据源；
  //   · 计时 ← `turn/start` 到达的那一刻（本机时钟起算，不读服务端时间戳：
  //     它是"这一轮已经想了多久"的读数，跟人手机上那个秒表同一条口径）。
  // 停止：`turn/end` 到达 ⇒ 整行隐藏（不是显示"空闲"）。

  /// 节流窗口：**最多 4 次/秒**。
  ///
  /// 为什么是 250ms：一条 turn 里 `message/reasoning` 是**成串**来的（每段推理一条），
  /// 一步里几十条很常见。一条一变的话，这一行每秒要重画几十次——而它显示的
  /// "已想 X 字 / 用时 M:SS"这两格**每秒变一次就够了**（字数跳一个字、秒数跳一秒，
  /// 人眼都跟不上更快的）。250ms 同时是后端那条 SSE 尾部泵的节奏（`SSE_POLL_MS`），
  /// 比它更快也没有新数据可看。
  ///
  /// 代价如实说：她刚开口那一下最多晚 250ms 上屏（那一拍由 [_thinkingFlush] 补齐，
  /// 不会丢）。
  static const _kThinkingThrottleMs = 250;

  /// 一条实时事件 → 更新那一行（**只在这条链路上采**，见 [connectStream] 的注释）
  void _trackThinking(Map<String, dynamic> event) {
    final type = event['type']?.toString();
    if (type == null) return;
    final data = (event['data'] as Map?)?.cast<String, dynamic>() ?? const {};
    switch (type) {
      case 'turn/start': {
        final turn = _intOf(data['turn']) ?? 0;
        // 同一轮的重复 start 不清账（SSE 重连会由服务端补拉，见 Last-Event-ID）
        if (_pendingThinking != null && _pendingThinking!.turn == turn) return;
        _pendingThinking = ThinkingProgress(turn: turn, step: 0, chars: 0, since: clock.now());
        break;
      }
      case 'step/start': {
        final current = _pendingThinking;
        if (current == null) return;
        // 步号**单调不减**：SSE 补拉时旧事件可能后到，回退会让那行数字往回跳
        final step = _intOf(data['step']) ?? current.step;
        if (step <= current.step) return;
        // **每步重置字数**（用户 2026-10-16 ① 的后端口径）：推理正文是**按步**发的一条，
        // 所以"已想 X 字"说的是**这一步**想了多少——不重置的话它会一路累加到几十万字，
        // 那个数不对应任何一件事（她这一步实际生成了多少，才是可核对的读数）。
        _pendingThinking = current.copyWith(
          step: step,
          chars: 0,
          phase: ThinkCharsPhase.pending,
        );
        break;
      }
      case 'message/reasoning': {
        final text = data['text']?.toString() ?? '';
        final current = _pendingThinking;
        if (current == null) {
          // 没有 `turn/start` 的现场：界面是在一轮中途打开的、或者 SSE 重连只补到了
          // 后面这一段（那时流里第一条就不是 turn/start）。**由这条事件自己把这一轮立起来**
          // ——不然"她在想"这件事整轮都不会上屏，而那恰好是最该看见的时候。
          //
          // 代价说清楚：计时从**这一刻**起算，所以这个读数会比她真实那一轮偏小
          // （前面那段我们没看见，编不出来）。宁可偏小也不给一个假的大数。
          // 而**字数不受影响**：这条事件带的就是那一步推理的**整段正文**
          // （后端一步只发一条，见 [ThinkCharsPhase] 的注释），所以它是真读数。
          if (text.isEmpty) return;
          _pendingThinking = ThinkingProgress(
            turn: _intOf(data['turn']) ?? 0,
            step: _intOf(data['step']) ?? 0,
            chars: text.length,
            since: clock.now(),
            phase: ThinkCharsPhase.counted,
          );
          break;
        }
        // 步号**单调递增**：补拉来的旧事件不许把它往回带。
        // 字数只在**同步**里累加：跨步的旧事件不许把上一步的字数加到这一步头上。
        final eventStep = _intOf(data['step']);
        final sameStep = eventStep == null || eventStep == current.step;
        // ★ 实时读数（[ThinkCharsPhase.live]）**不是能往上加的底数**：它说的不是"已经落库了多少正文"，
        // 而是后端对**同一整段**正文的进度估计（delta 之和，见 `step/reasoning-progress`）。
        // 能当底数的只有**已经落库的正文**（[ThinkCharsPhase.counted] 那一态）；
        // 否则 3000（live）+ 3100（这一步的真值）= 6100 就成了一个比真值还大的假读数
        // ——而这一格的全部意义就是"这个数是真的"。（后端一步只发一条，这条累加是给
        // 重复/补拉留的冗余；补拉那条另由 `_consume` 按 seq 去重。）
        final base = sameStep && current.phase != ThinkCharsPhase.live ? current.chars : 0;
        final chars = base + text.length;
        final step = eventStep == null || eventStep <= current.step ? current.step : eventStep;
        _pendingThinking = current.copyWith(
          chars: chars,
          step: step,
          // 收到正文 ⇒ 这一格**有真数**了（哪怕这一段是补拉来的上一段的尾巴）
          phase: ThinkCharsPhase.counted,
        );
        break;
      }
      case 'turn/end':
        // 这一轮结束：整行隐藏（不是显示"空闲"）。同步收掉待发的那一拍，
        // 否则它会在一轮结束之后再把这一行点亮 250ms
        _endThinking();
        return;
      // 后端 (b) 的实时读数（`step/reasoning-progress`，2026-10-17）：推理正文**落库之前**
      // 那一段唯一能让「已想 X 字」是真的东西。载荷只有 `{turn, step, chars}`——**一个字的正文都没有**，
      // 所以这一格显示的是"到这一刻生成了多少字"，不是她想过的任何一句话。
      //
      // 它就是 [ThinkCharsPhase.live] 留的那个口：**只在这一处接线**，那一行的文案、宽度补位
      // 与 250ms 节流一个字都不动（[thinkingLine] 只看 `phase != pending`）。
      case 'step/reasoning-progress': {
        final chars = _intOf(data['chars']) ?? 0;
        // 0 不是读数：那一格宁可说「…」。沿用"任何时刻都不许出现「已想 0 字」"那条口径。
        if (chars <= 0) return;
        final step = _intOf(data['step']);
        final current = _pendingThinking;
        if (current == null) {
          // 这一轮是**中途打开**的（或 SSE 重连只补到了后面这一段）：没有 `turn/start`。
          // 照上面 `message/reasoning` 那条的先例，**由它自己把这一轮立起来**——不然这条事件
          // 白到手，那一行还是空的，而"她想了很久"恰恰是最该看见的时候。
          // 代价与那条逐字相同：计时从这一刻起算，宁可偏小也不编一个假的大数。
          _pendingThinking = ThinkingProgress(
            turn: _intOf(data['turn']) ?? 0,
            step: step ?? 0,
            chars: chars,
            since: clock.now(),
            phase: ThinkCharsPhase.live,
          );
          break;
        }
        // **真值优先**：`message/reasoning` 已经把这一步的真数落下来了，就不许被一条实时读数顶回去
        // （补拉时旧事件可能后到；两边的数也可能差一点：它是 delta 之和，真值是落库的整段）。
        if (current.phase == ThinkCharsPhase.counted) return;
        // 步号单调：跨步的旧事件不许把上一步的字数搬到这一步头上（与上面那条同一条口径）
        if (step != null && step != current.step) return;
        _pendingThinking = current.copyWith(chars: chars, phase: ThinkCharsPhase.live);
        break;
      }
      default:
        return;
    }
    // 这一行**新出现**的时刻（对账那道宽限期的起点，见 [reconcileThinking]）。
    // 只在"本来没有 → 现在有"那一下记，不每来一条事件重写：否则一条不断的流会让
    // 宽限期永远不过期，那正好是"靠猜时间窗"的翻版。
    _thinkingStartedAt ??= clock.now();
    _publishThinking(_pendingThinking);
  }

  /// 把攒下的那一份放行上屏（**节流**：[_kThinkingThrottleMs] 之内最多一次）。
  ///
  /// 被压住的那一次**不丢**：排一拍在窗口末尾补发（[_thinkingFlush]），
  /// 所以"她刚开口"那一下最多晚 250ms，而不是被合并掉。
  void _publishThinking(ThinkingProgress? next, {bool force = false}) {
    if (next == null) {
      thinkingNow.value = null;
      _thinkingShownAtMs = 0;
      return;
    }
    if (force) {
      _thinkingShownAtMs = clock.now().millisecondsSinceEpoch;
      thinkingNow.value = next;
      return;
    }
    final now = clock.now().millisecondsSinceEpoch;
    final wait = _kThinkingThrottleMs - (now - _thinkingShownAtMs);
    if (wait <= 0) {
      _thinkingShownAtMs = now;
      thinkingNow.value = next;
      return;
    }
    _thinkingFlush?.cancel();
    _thinkingFlush = Timer(Duration(milliseconds: wait), () {
      _thinkingFlush = null;
      final pending = _pendingThinking;
      if (pending == null) return; // 这一轮已经结束了
      _thinkingShownAtMs = clock.now().millisecondsSinceEpoch;
      thinkingNow.value = pending;
    });
  }

  int? _intOf(Object? value) => value is num ? value.toInt() : null;

  /// 「跳到最新」那颗按钮（用户 2026-10-16 ②）。
  ///
  /// 它为什么**必须**存在：①把自动滚动关掉之后，没有它就是"她说了什么，人永远不知道"
  /// （用户的原话就是这一层意思）——这一颗是那一条的配套，不是装饰。
  ///
  /// 形态：圆形、`surfaceContainer` 底 + `outlineVariant` 细描边 + `onSurfaceVariant` 箭头。
  /// 三个都是**现有主题 token**（明暗两套都有值），一个新颜色都没造——
  /// 用户这一条的要求是"低调"：它是辅助读数，不该跟主按钮抢注意力（发送键用的是 `primary` 填充）。
  ///
  /// 为什么底色是 `surfaceContainer` 而不是透明：这一页的背景就是 `surface`，
  /// 透明填充会让箭头孤零零地浮在消息流上方、看不出是个可点的东西。`surfaceContainer`
  /// 是**同一套里最浅的那一层**（本页别处也用它托图标按钮，见对话卡那几处），
  /// 抬一层就够"这是个按钮"，离"抢眼"还很远。
  ///
  /// 尺寸 26（见 [_kJumpButtonSize]）：比输入框那颗 44 小一档，明确不是一级动作。
  /// 命中区不受它限制——`IconButton` 自带 Material 的最小命中尺寸（48），
  /// 而外层槽位 `clipBehavior: Clip.none` 让它不被 20 高的槽裁掉。
  Widget _jumpToLatestButton() {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    return Tooltip(
      message: _jumpHint ? s.jumpToLatestNew : s.jumpToLatest,
      child: SizedBox(
        width: _kJumpButtonSize,
        height: _kJumpButtonSize,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            IconButton(
              // 内边距归零，把按钮画满这 26：默认的 padding 会把它缩成一个小图标
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
              style: IconButton.styleFrom(
                backgroundColor: scheme.surfaceContainer,
                side: BorderSide(color: scheme.outlineVariant),
                shape: const CircleBorder(),
              ),
              onPressed: _jumpToLatest,
              icon: Icon(Icons.arrow_downward_rounded, size: 15, color: scheme.onSurfaceVariant),
            ),
            if (_jumpHint) _jumpHintDot(scheme),
          ],
        ),
      ),
    );
  }

  /// 那颗按钮上的**小提示点**（不在底部、而且有新内容到达时才亮）。
  ///
  /// 用主题强调色 `primary` 的小细点，**不用红点**：红在这一页的语义是"出错"
  /// （工具失败、注入预警），拿它说"有新消息"会让人以为出了事。
  ///
  /// 位置：贴在按钮右上角外侧一点。画在 26×26 的盒子里、**不占额外布局**——
  /// 它亮起来也不会把箭头挤小、不会把那一行撑高（`Positioned` 不影响尺寸）。
  Widget _jumpHintDot(ColorScheme scheme) => Positioned(
        right: 1,
        top: 1,
        child: SizedBox(
          // 立**尺寸**而不是给 `Container` 加 border 约束：`Container` 会把 border 算进
          // 自己的 constraints（6+border 不等于 6），于是这个点的实际大小取决于描边怎么写。
          // 定死 6 + 里面画一个带描边的圆，外面量到的就恒是 6。
          width: 6,
          height: 6,
          child: DecoratedBox(
            decoration: BoxDecoration(
              color: scheme.primary,
              shape: BoxShape.circle,
              // 一圈底色的描边：小点落在按钮边缘时不会与描边糊成一团
              border: Border.all(color: scheme.surface, width: 1),
            ),
          ),
        ),
      );

  /// 找同一个 callId 已经画出来的那个工具块：回执要找它（原地更新），
  /// 往上翻时后到的 `tool/call` 也要找它（回填名字与参数，见上面那条注释）。
  ///
  /// 两处都要找：往上翻的那一批落在 [_prependSink] 里，而孤立的回执块可能在
  /// 已经在屏上的 `items` 里（它属于"更晚取到的那一页"）。
  _BubbleItem? _findToolBlock(String? callId) {
    if (callId == null || callId.isEmpty) return null;
    for (final list in [_sink, if (_prependSink != null) items]) {
      for (final item in list.reversed) {
        if (item.kind == _ItemKind.tool && item.callId == callId) return item;
      }
    }
    return null;
  }

  /// 清空上下文：服务端写一条遮蔽摘要。
  ///
  /// **不撤屏上已有的气泡**（用户 2026-10-02："reset后就清理了屏幕，然后原本应该留着的
  /// 过往记录被清掉了。难道不是应该往下移到空屏吗？"）。原来这里 `items.clear()`，
  /// 后果有三：① 人刚翻上去看过的往来一下子没了；② 屏上只剩随之而来的那张分界，
  /// 列表短于视口，空白全堆在下面；③ 分界落到了"最上面一条"的位置，看着像新会话开始，
  /// 而它其实是一道**往下走的分界线**。现在过往留在分界上方，分界自己往下走，
  /// 新往来在它下面一句句长出来。
  ///
  /// 事件日志本来就不删（唯一真相源，也是以后复盘得回话的地方）；屏上也不必删。
  Future<void> _resetContext() async {
    try {
      await widget.state.api.post('/api/commands/reset-context', const {});
      if (!mounted) return;
      IrmiaToast.show(context, IrmiaStrings.read(context).toastContextCleared, kind: ToastKind.success);
    } catch (err) {
      if (mounted) IrmiaToast.show(context, IrmiaStrings.read(context).toastClearFailed('$err'), kind: ToastKind.error);
    }
  }

  /// 叫她做一次梦（记忆整理）：服务端排一条唤醒，整理在下一拍跑完会落一条
  /// `memory/maintained`，日志页看得到结果。
  ///
  /// 为什么不像 /reset 那样在本地做什么：整理是后台任务，写的是 MEMORIES/ 下的文件，
  /// 界面这边只需要把"我叫过她"这件事说清楚，结果由日志与记忆页呈现。
  Future<void> _dream() async {
    try {
      await widget.state.api.post('/api/commands/dream', const {});
      if (!mounted) return;
      IrmiaToast.show(context, IrmiaStrings.read(context).toastDream, kind: ToastKind.success);
    } catch (err) {
      if (mounted) IrmiaToast.show(context, IrmiaStrings.read(context).toastTriggerFailed('$err'), kind: ToastKind.error);
    }
  }

  /// **唯一**会滚到底的那条路（用户 2026-10-16 ①）。
  ///
  /// 默认不自动跟随：她说话、工具卡片更新、往上翻历史——一律**不许**把视图拽走
  /// （原话：「chat 界面，不要 agent 一说话就往下滚动到最新。改成默认不自动滚动」）。
  /// 所以这里只被两处调：**用户自己发消息**（`send`：那是他的动作，符合直觉），
  /// 以及他按了「跳到最新」那颗按钮。
  ///
  /// 平滑而不是瞬间跳：滚动位置本身是"我正在看哪儿"的读数，瞬移会让人失去方位感
  /// （`animateTo` + `easeOut` 与这颗按钮的语义一致：它是"带我过去"，不是"刷新"）。
  void _jumpToLatest() {
    // 提示点与"在底部"当场结清：这是人的意图，不等滚动结束那几帧。
    // （帧后那次补量会把 `_atBottom` 按真实位置再校准一遍——滚到底之后它仍旧是 true。）
    if (_jumpHint || !_atBottom) {
      setState(() {
        _jumpHint = false;
        _atBottom = true;
      });
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !scroll.hasClients) return;
      scroll.animateTo(
        scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
      );
    });
  }

  /// 流里第 [index] 条（两个 sliver 共用一份实现：索引是**全局**的，
  /// 于是"上一条是谁"在 sliver 交界处也照样算得对——连续间距不该在交界处断掉）。
  ///
  /// 左右 20 的留白挪到了每一行上：`center` 必须挂在 viewport 的直接子 sliver 上，
  /// 那一层不能再套 SliverPadding（套了就找不到这个 key）。
  Widget _row(BuildContext context, int index, int olderCount) {
    final item = items[index];
    final prev = index > 0 ? items[index - 1] : null;
    // **锚点那一条（index == olderCount）永远算"另起一段"**：它原先是这一段的第一条
    // （上面留 16），往上翻历史时它前面会多出人来——间距若跟着变成 4，屏幕上的东西就
    // 平移 12 像素（实测就是这么来的）。它恰好是"人正看着的那一条"，所以这里钉死。
    // 代价：翻页的接缝处是 16 而不是 4，看着像一次分段——比跳屏好得多。
    final continues =
        index != olderCount && prev != null && prev.side == item.side && item.side != 'sys';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20),
      child: _BubbleRow(
        item: item,
        continues: continues,
        onToggle: () => setState(() => item.expanded = !item.expanded),
        // 名字在这里查：别名表可能比这条消息晚到（见 _loadContacts）
        sender: _chanSenderOf(item),
        // 话题同理——light 的结论可能比那条消息晚到，晚到也照旧画得出来（读的是现成的表）
        // 话题由 `channel/topic` 那一条**认领**给这张卡（见 _consume），这里只取它自己的那一份：
        // 读"会话最新的话题"会让新话题把旧卡也改掉（用户 2026-10-02 报过）
        topic: item.topic,
      ),
    );
  }

  Future<void> send() async {
    final text = input.text.trim();
    if (text.isEmpty) return;
    // 关键动作留痕：**在 await 之前**记（卡死正好发生在这条请求上时，日志里要有这一行；
    // 等它回来再记就晚了——那正是"卡在哪"最需要的那一笔）
    traceInput('发送消息');
    input.clear();
    // 斜杠命令：/reset 清空上下文（日志不动，只把遮蔽点推到当前水位）
    if (text == '/reset') {
      await _resetContext();
      return;
    }
    // 斜杠命令：/dream 立刻叫她去整理记忆（合并流水账 / 修剪事实 / 写日记）
    if (text == '/dream') {
      await _dream();
      return;
    }
    // 乐观渲染：先上屏，wake/manual 事件回来时由去重逻辑跳过重复
    setState(() => items.add(_BubbleItem.text(side: 'me', text: text)));
    // **用户自己发消息 ⇒ 滚到底一次**（用户 2026-10-16 ① 定的唯一例外）：
    // 他把话递出去了，接下来该看的就是她那一边的回应，停在半截没有意义。
    _jumpToLatest();
    try {
      final res = await widget.state.api.post('/api/commands/wake', {'note': text});
      // 幂等键撞上时服务端会静默丢弃（fold 层不写任何事件）——那与"她正在想"在界面上
      // 长得一模一样，所以回执里带了 deduped，这里必须让人看见。
      if (mounted && res is Map && res['deduped'] == true) {
        setState(() => items.removeWhere((e) => e.side == 'me' && e.text == text && e.ts == null));
        IrmiaToast.show(context, IrmiaStrings.read(context).toastDuplicateSend,
            kind: ToastKind.info);
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(IrmiaStrings.read(context).toastSendFailed('$err'))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    final note = _headNote;
    // 锚点前面那一份（往上翻出来的更早内容）有多长；宽度变化时别让它越界
    final olderCount = _olderCount.clamp(0, items.length);
    return Column(
      children: [
        PageHeader(title: s.chatTitle, subtitle: s.chatSubtitle),
        Expanded(
          child: loadingHistory
              ? const Center(child: CircularProgressIndicator())
              // 读失败 ≠ 没有历史：**只有在真的读成功之后**才允许说「会话尚未开始」
              // （见 [ChatPageState._historyError] 与 [_HistoryErrorState]）
              : _historyError != null && items.isEmpty
                  ? _HistoryErrorState(
                      error: _historyError!,
                      // 「点重试」是关键动作：卡在错误态里时，人最后按的就是这一颗
                      onRetry: () {
                        traceInput(s.retry);
                        unawaited(loadHistory());
                      },
                    )
                  : items.isEmpty
                      ? _EmptyGuide(onCompose: inputFocus.requestFocus)
                      : CustomScrollView(
                      controller: scroll,
                      // 锚点：这一屏在视口里的位置固定，往上插内容时屏幕不动（见 _anchorKey）
                      center: _anchorKey,
                      slivers: [
                        // 列表顶上那点留白（原来是 ListView 的 padding）。它待在内容最前面
                        // 不动；顺带给"短会话"留出一点可滚的余量——[_onScroll] 靠位置变化触发，
                        // 一条都滚不动的列表就永远叫不到它。
                        const SliverToBoxAdapter(child: SizedBox(height: 18)),
                        // 往上翻出来的更早内容（最后一格可能是那行状态）：它们住在锚点**前面**。
                        //
                        // **倒着放**：锚点前面那个 sliver 是**反向生长**——它的 child 0 贴着锚点，
                        // 索引越大越靠上。顺放会看到历史整个倒过来（实测：seq 240 跑到 226 上面，
                        // dy 107 vs 807）。所以这里按"从锚点往上"给：items[olderCount-1] … items[0]，
                        // 那行状态排在最后（= 整个列表的最上面）。
                        SliverList(
                          delegate: SliverChildBuilderDelegate(
                            (context, index) {
                              if (note != null && index == olderCount) return _noteRow(note);
                              return _row(context, olderCount - 1 - index, olderCount);
                            },
                            childCount: olderCount + (note == null ? 0 : 1),
                          ),
                        ),
                        // 锚点：进页面时那一屏 + 之后实时到的。
                        // `center` 认的是 viewport 直接子 sliver 的 key，所以 key 挂在这一层。
                        SliverList(
                          key: _anchorKey,
                          delegate: SliverChildBuilderDelegate(
                            (context, index) => _row(context, olderCount + index, olderCount),
                            childCount: items.length - olderCount,
                          ),
                        ),
                        const SliverToBoxAdapter(child: SizedBox(height: 12)),
                      ],
                    ),
        ),
        // **给「思考中」那一行留的定高槽位**（用户 2026-10-16「加一行紧凑进度」）。
        //
        // 为什么是"常驻的空槽"而不是"出现时插一行"：用户这一条明写「不许造成跳动：
        // 出现/消失时其它元素不许移位」。插一行会把输入框与整个消息流往下推 20 像素，
        // 而这件事在"她开口/收口"的瞬间正好发生——那正是人盯着屏幕的时候。
        // 同样的理由这一页已经吃过一次（见 [_headNote] 的注释：实测差了 36 像素）。
        //
        // 所以高度**恒定**：不在想的时候这里就是一个 20 像素的空槽（代价如实说：
        // 常驻占 20px 纵向空间），在想的时候内容在里面淡入——几何一个字都不变。
        //
        // 槽里住两样东西（同一行、左右两端）：
        //   · 左：「思考中 · 第 N 步 · 已想 X 字 · 用时 M:SS」（[ThinkingRow]，只重画自己）；
        //   · 右：「跳到最新」那颗按钮（[_jumpToLatestButton]）。
        // 两样都**在输入框上方的槽内**、贴右留 18 与输入框同一条基线——所以既不挡住
        // 输入框，也不压住消息内容（槽本来就在滚动区外面）。
        SizedBox(
          height: _kThinkingSlotHeight,
          child: Padding(
            // 左边与输入框那条基线对齐（输入框在下面那个 Container 的 18 padding 里）
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Row(
              children: [
                Expanded(
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: ThinkingRow(progress: thinkingNow),
                  ),
                ),
                // 贴右那一格是**定宽**的：它不出现时留在原地的也是一个 26 宽的空气泡，
                // 所以「思考中」那一行的可用宽度在按钮出现/消失时一个字都不变。
                SizedBox(
                  width: _kJumpButtonSize,
                  child: Center(
                    child: _atBottom ? null : _jumpToLatestButton(),
                  ),
                ),
              ],
            ),
          ),
        ),
        _composer(scheme),
      ],
    );
  }

  /// 输入条的几何（2026-10-25 用户：「输入框和发送按钮做得更好看一点。圆角不要那么大了。」
  /// 紧接一句「发送按钮改圆角矩形。」）
  ///
  /// 三档圆角见 `theme/design_tokens.dart` 的 [Shape]；这一条用的是**大控件档**
  /// [Shape.radiusControlLarge]（= 控件 10 + 2 = 12），输入框与发送键同一个数：
  ///   · 输入框：**高 52**、左右内边距 16、圆角 12；底色 `surfaceContainerLowest`、
  ///     边框 `outlineVariant` 1px，**聚焦时换主色**（1.4px，见 [Shape.focusWidth]）；
  ///     占位文案不动（`s.composerHint`），空串时 `send()` 自己忽略，所以没有禁用态要画；
  ///   · 发送键：**40×40 圆角矩形、半径 12**（从前是 44 的正圆），与输入框垂直居中对齐；
  ///     填充/前景仍走 [IrmiaDarkPair]（亮模蓝底白箭、暗模透明底 + 一圈白描边）——
  ///     形状变了，那一套取色口径一个字都没动。
  ///
  /// 为什么描边/底色画在**外面这层 `BoxDecoration`** 而不是 `InputDecoration`：
  /// 用例要按渲染矩形与 `BoxDecoration` 直接量"圆角 12 / 高 52"（`InputDecoration` 里那份
  /// `OutlineInputBorder` 与真实画出来的框不是同一个对象），
  /// 而且聚焦色只需要改这一层。`TextField` 自己的 decoration 因此是**无边框 + 不填充**。
  Widget _composer(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    final radius = BorderRadius.circular(IrmiaTheme.radiusCtlLarge);
    final focused = inputFocus.hasFocus;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 12, 18, 16),
      child: Row(
        children: [
          Expanded(
            child: Container(
              key: const ValueKey('chat-composer-field'),
              height: _kComposerFieldHeight,
              padding: const EdgeInsets.symmetric(horizontal: Space.x4),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerLowest,
                borderRadius: radius,
                border: Border.all(
                  color: focused ? scheme.primary : scheme.outlineVariant,
                  width: focused ? Shape.focusWidth : Shape.hairline,
                ),
              ),
              child: TextField(
                controller: input,
                focusNode: inputFocus,
                onSubmitted: (_) => unawaited(send()),
                decoration: InputDecoration(
                  hintText: s.composerHint,
                  filled: false,
                  isDense: true,
                  border: InputBorder.none,
                  enabledBorder: InputBorder.none,
                  focusedBorder: InputBorder.none,
                  contentPadding: EdgeInsets.zero,
                ),
              ),
            ),
          ),
          const SizedBox(width: 10),
          _sendButton(scheme, radius),
        ],
      ),
    );
  }

  /// 发送键：40×40 的圆角矩形（半径 12），填充/前景/描边全部来自 [IrmiaDarkPair]。
  ///
  /// 描边那一圈**不在这里判明暗**：`scheme.sendButtonShape` 是"暗模白描边 / 亮模不描边"的
  /// 唯一判据（见 theme.dart 的四条边界），这里只把它翻成 `BoxDecoration` 好让用例按渲染矩形
  /// 与装饰直接量。
  Widget _sendButton(ColorScheme scheme, BorderRadius radius) {
    final shape = scheme.sendButtonShape;
    final side = shape is RoundedRectangleBorder ? shape.side : BorderSide.none;
    final border = side.style == BorderStyle.none || side.width == 0
        ? null
        : Border.fromBorderSide(side);
    return Semantics(
      // 与从前那颗 FilledButton 同一层语义：它是个按钮（读屏与键盘焦点要用）
      button: true,
      child: Material(
        type: MaterialType.transparency,
        child: Ink(
          key: const ValueKey('chat-send'),
          width: _kSendButtonSize,
          height: _kSendButtonSize,
          decoration: BoxDecoration(
            color: scheme.pairFill,
            borderRadius: radius,
            border: border,
          ),
          child: InkWell(
            onTap: () => unawaited(send()),
            borderRadius: radius,
            child: Center(
              child: Icon(Icons.arrow_upward_rounded, size: 20, color: scheme.pairOn),
            ),
          ),
        ),
      ),
    );
  }
}

/// 输入框那一格的定高（52）：比普通按钮高一档，所以它的圆角用大控件档 12。
const double _kComposerFieldHeight = 52;

/// 发送键的边长（40×40，圆角矩形）
const double _kSendButtonSize = 40;

/// 她这一轮跑到哪儿了——喂「思考中 · 第 N 步 · 已想 X 字 · 用时 M:SS」那一行。
///
/// 每个字段的出处见 [ChatPageState._trackThinking]。**不可变**：每次更新换一个新对象，
/// 于是 `ValueNotifier` 认得出"变了"（原地改字段的话它比较的是同一个引用，那一行不会重画）。
@immutable
class ThinkingProgress {
  const ThinkingProgress({
    required this.turn,
    required this.step,
    required this.chars,
    required this.since,
    this.phase = ThinkCharsPhase.pending,
  });

  /// 第几轮（`turn/start` 的 `turn`）——只用来认"换了一轮没有"，不显示
  final int turn;

  /// 第几步（`step/start` 的 `step`）
  final int step;

  /// 这一轮的推理正文字数。**它的口径由 [phase] 标着**（见 [ThinkCharsPhase]：
  /// 待生成时这里是 0，而那一格显示的是占位而不是这个 0）。
  final int chars;

  /// 这一轮开始想的时刻（`turn/start` 到达那一刻，本机时钟）
  final DateTime since;

  /// 这个字数是"还没生成"还是"已经落库的真值"（见 [ThinkCharsPhase]）
  final ThinkCharsPhase phase;

  ThinkingProgress copyWith({int? step, int? chars, ThinkCharsPhase? phase}) => ThinkingProgress(
        turn: turn,
        step: step ?? this.step,
        chars: chars ?? this.chars,
        since: since,
        phase: phase ?? this.phase,
      );

  /// 已经想了多久（至少 0：本机时钟被人改过也不显示负数）。
  ///
  /// ★ 读 `clock.now()` 而**不是** `DateTime.now()`（2026-10-16 为「用时每秒走」这条改的）：
  /// 两者在真机上**完全等价**（`clock` 包默认就转发到 `DateTime.now()`），差别只在用例里——
  /// `flutter_test` 会把 `clock.now()` 接管成一只**随 `tester.pump(时长)` 前进的假时钟**，
  /// 而 `DateTime.now()` 读的是真实墙钟、`pump` 推不动它。
  /// 没有这一改，"那一行每秒自己走"就**没法用用例钉住**（只能靠真窗口肉眼看），
  /// 而那正是这次要修的东西。代价：多一个显式声明的 dev 依赖（见 pubspec.yaml 的注释）。
  Duration get elapsed {
    final value = clock.now().difference(since);
    return value.isNegative ? Duration.zero : value;
  }

  @override
  bool operator ==(Object other) =>
      other is ThinkingProgress &&
      other.turn == turn &&
      other.step == step &&
      other.chars == chars &&
      other.since == since &&
      other.phase == phase;

  @override
  int get hashCode => Object.hash(turn, step, chars, since, phase);
}

/// 「已想 X 字」那一格**此刻说的是什么数**（用户 2026-10-16 ①）。
///
/// ★ 为什么需要这个字段（查清的事实，不是猜的）：
/// 后端的推理正文是**一步跑完才发一条整段**（`src/runtime/agent-loop.ts:1451-1454`：
/// `await this.deps.ds.stream(...)` 返回之后才写 `message/reasoning`，`text` 是整段
/// `result.reasoning`；上游 `src/model/ds-client.ts:913` 那些 `reasoning_text.delta`
/// **一个都不写进事件日志**）。所以在她想的那 153 秒里（实测 turn 2115：
/// `step/start` @11:41:57 → 那条 62,854 字的 `message/reasoning` @11:44:30），
/// 界面手上**一个字都没有**。
///
/// 旧写法把"手上 0 个字"直接念成「已想 0 字」——那是个**读数**，而它不真。
/// 现在按"这个数是怎么来的"分三态，**只有 [counted] / [live] 才报数**。
///
/// ★ 三态里的 [live] 是**给后端那条 (b) 留的接口**（用户 2026-10-16 已批：
/// "那一格改成**有进度事件就用它**、没有就显示落库后的真值"）：
/// 将来后端每 N 秒发一条只含"已生成多少字"的 internal 事件时，界面**只改一处**——
/// 在那个事件的 handler 里把 `phase` 置成 [live]、把 `chars` 置成它给的字数；
/// [thinkingLine] 与这一格的样子**一个字都不用动**（它只看 `phase != pending`）。
/// 在那条事件落地之前，[live] 永远不会出现，界面照旧走 [pending] → [counted]。
enum ThinkCharsPhase {
  /// 这一步的推理正文**还没落库**：她确实在想，但"已经想了多少字"此刻**无从得知**
  /// （后端还没有任何一条带正文、也没发过进度事件）。这一态下那一格显示「…」，不显示 0。
  pending,

  /// **后端进度事件给的实时字数**（那条 (b) 还没落地，所以这一态暂时不会出现）。
  /// 它说的是"到这一刻已经生成了多少字"，会**一路涨**——与 [counted] 的区别只是"谁给的"。
  live,

  /// 这一步的推理正文**已经落库**（收到过一条 `message/reasoning`）：
  /// [ThinkingProgress.chars] 是**真读数**（各条 `text.length` 之和），
  /// 且它是**这一步的最终值**（那一步已经跑完了）。
  counted,
}

/// 把字数写成给人看的短写：`980` / `6.2 万字` / `112 万字`。
///
/// 为什么上万就换单位：一步推理实测能到 6 万字以上（turn 2115 step 1 = 62,854 字），
/// 五位数会把那一行撑宽、而"62,854"对人眼不是个能一眼读懂的量级。
/// 保留一位小数（`6.2 万字`）：量级一眼可读，又不至于把 61,000 与 69,000 说成同一个数。
///
/// i18n：口径**按语言不同**（中文按"万"分档、英文按"k"分档），实现在
/// `AppStrings.compactChars`；这里保留原来的签名给既有用例，等价于中文那份。
String formatThinkingChars(int chars) => const ZhStrings().compactChars(chars);


/// 把时长写成 `M:SS`（例：`0:07` / `1:20` / `12:03`）。
///
/// 为什么是这个形状：它是**读数**不是文案——秒一直走，超一小时也照走（`61:05` 而不是
/// `1:01:05`），这样那一行永远不会因为多出一个小时位而变宽。分不补零、秒补零，
/// 于是宽度只在 9:59→10:00 那一次变一格，而数字是等宽的（见 [ThinkingRow]），
/// 不会左右抖。
String formatThinkingElapsed(Duration d) {
  final total = d.inSeconds < 0 ? 0 : d.inSeconds;
  final minutes = total ~/ 60;
  final seconds = total % 60;
  return '$minutes:${seconds.toString().padLeft(2, '0')}';
}

/// 那一行自己：**只重画这一行**（用户 2026-10-16：「只让这一行重建」）。
///
/// 数据从 [ChatPageState.thinkingNow] 来（本对象自己订阅它），
/// 所以消息流那一棵树不参与——这是"不整页 setState"的落点。
///
/// 出现/消失：**尺寸恒定**。外层的槽位（[ChatPage] 的 `_thinkingSlot`）是定高的，
/// 这一行**从不改自己的尺寸**，所以输入框与消息流的几何**一个像素都不动**
/// （用户这一条的硬要求：不许造成跳动）。
///
/// ★ **整行同进同出**（用户 2026-10-16 ②「停了之后这个思考符号还是存在」，实测根因）：
/// 上一版把"隐藏"做成了两件**互相独立**的事——
///   · 文字由外层的 `AnimatedOpacity(opacity: showing ? 1 : 0)` 淡出；
///   · 三个点 [`BreathingDots`] 有**自己的** `AnimationController`，逐点画 `Opacity(0.25…1)`。
/// 而那个淡出被**冻在了 1.000**（实测：`turn/end` 之后 `FadeTransition.opacity.value == 1.000`
/// 一路不变，三个点的 `Opacity` 还是 `[0.96, 0.73, 0.51]` ⇒ 屏上就只剩"•••"）。
/// 为什么冻住：淡出与"把点的动效停掉"是**同一个 `TickerMode` 开关**驱动的
/// （旧代码是 `TickerMode(enabled: showing)` **包着** `AnimatedOpacity`）——
/// 一藏起来，那个把透明度从 1 推到 0 的 ticker 当场被自己关掉，于是它永远走不到 0。
/// 文字看着"没了"只是因为它的内容被置成了空串（不是被淡出的）。
///
/// 现在的写法（三条，缺一不可）：
///   ① **一个** [AnimationController] 驱动**整行**（点、间距、文字）的淡入淡出；
///   ② [Offstage] 兜底：`offstage: opacity == 0` ⇒ 隐藏时整棵子树**一个像素都不画**
///      （不靠"透明度是 0 所以大概看不见"这种推断；它同时是 [Look] 那条"不许移位"的保证——
///      这一行不参与尺寸计算，外层定高槽位兜着几何）；
///   ③ 点的呼吸动效由 [BreathingDots.running] 显式起停，**不再借 `TickerMode`**——
///     那条开关与①的淡出抢同一个 ticker，正是这一版要甩掉的坑。
class ThinkingRow extends StatefulWidget {
  const ThinkingRow({super.key, required this.progress});

  final ValueListenable<ThinkingProgress?> progress;

  @override
  State<ThinkingRow> createState() => _ThinkingRowState();
}

class _ThinkingRowState extends State<ThinkingRow> with SingleTickerProviderStateMixin {
  /// 每秒一格：只为把「用时」推着走（[ThinkingProgress.elapsed] 读的是本机时钟）
  Timer? _tick;

  /// 当刻那一份进度（`null` = 她不在想）。**订阅式读进字段**，理由见类注释那条机关。
  ThinkingProgress? _progress;

  /// 整行的淡入淡出（**唯一**的显隐驱动）
  late final AnimationController _fade = AnimationController(
    vsync: this,
    duration: IrmiaTheme.durCard,
    value: widget.progress.value == null ? 0 : 1,
  );

  /// 淡出到底了没有——只有它到 0 才允许 [Offstage] 收掉绘制
  bool _atRest = false;

  @override
  void initState() {
    super.initState();
    _progress = widget.progress.value;
    _atRest = _progress == null;
    _fade.addStatusListener(_onFadeStatus);
    widget.progress.addListener(_onProgress);
    _syncTicker();
  }

  @override
  void dispose() {
    widget.progress.removeListener(_onProgress);
    _fade.removeStatusListener(_onFadeStatus);
    _fade.dispose();
    _tick?.cancel();
    super.dispose();
  }

  /// 淡出结束时收掉绘制（`dismissed` = 停在 0）
  void _onFadeStatus(AnimationStatus status) {
    final rest = status == AnimationStatus.dismissed;
    if (rest != _atRest && mounted) setState(() => _atRest = rest);
  }

  /// 进度变了：收下新值 + 起停秒表 + 推动整行的淡入淡出 + 重画
  void _onProgress() {
    if (!mounted) return;
    final showing = widget.progress.value != null;
    setState(() => _progress = widget.progress.value);
    _syncTicker();
    if (showing) {
      // 淡入：**立刻**把 offstage 拿掉（那是"要画了"），透明度由控制器推上去
      if (_atRest) setState(() => _atRest = false);
      _fade.forward();
    } else {
      _fade.reverse();
    }
  }

  /// 看得见就走秒、看不见就停
  void _syncTicker() {
    final showing = _progress != null;
    if (showing == (_tick != null)) return;
    if (showing) {
      _tick = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() {});
      });
    } else {
      _tick?.cancel();
      _tick = null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 字号/颜色**都从主题来**（不硬编码尺寸）：与消息流里那几行小字
    // （`_noteRow` / `_headNote`）同一档——那是这一页已有的"读数"长相。
    final base = Theme.of(context).textTheme.bodySmall ?? const TextStyle(fontSize: 12);
    final style = base.copyWith(
      // 次要文本：明暗两套都不用挑色（`onSurfaceVariant` 在 IrmiaTheme 里两套都有值）
      color: scheme.onSurfaceVariant,
      height: 1.2,
      // **数字等宽**（用户 2026-10-16 的排版要求：字数跳动时那行别左右抖）。
      // 用 OpenType 的 `tnum` 特性而不是换字体：字号/字形跟着主题那套字体栈走，
      // 只把数字换成同宽的字形——`0:07` → `0:08`、`9 字` → `10 字` 时宽度不变。
      // 代价如实说：这一页的字体是 `Microsoft YaHei UI`（`IrmiaTheme.windowsUiFont`），
      // 它认不认 `tnum` 要**在真窗口里看**才知道（见报告里"没实测清单"）——
      // 不认也只是退化成原来那样，不会画错。
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    // **不用 `ValueListenableBuilder`**：它内部缓存 `child`，`value` 没变时不会重建那个
    // `Text` ——而"每秒那一拍"正好就是 value 没变、只有时间过去了（见类注释那条机关）。
    // 这里直接在 `build` 里建树：每一次 `setState`（进度变 / 秒表到点）都真的重算一次
    // `thinkingLine`，而它读 `clock.now()`，所以「用时」真的在走。
    final value = _progress;
    final showing = value != null;
    return AnimatedBuilder(
      // 整行（点 + 间距 + 文字）**同一个**透明度：这就是"同进同出"
      animation: _fade,
      builder: (context, child) {
        final opacity = _fade.value;
        return Offstage(
          // ★ 隐藏时**不画任何东西**（见类注释的②）：`opacity == 0` 才是"真的没了"，
          // 而不是"透明度是 0、大概看不见"。`offstage` 不参与尺寸与绘制 ⇒ 几何照旧由
          // 外层那个定高槽位兜着（"不许移位"这条不受影响）。
          offstage: _atRest || opacity == 0,
          child: Opacity(
            opacity: opacity,
            child: child,
          ),
        );
      },
      // `child` 只在这里建一次：每秒那一拍不重建这棵子树，只有透明度在动
      child: IgnorePointer(
        child: Row(
          children: [
            // 点的呼吸动效由它自己按 `running` 起停（不再借 `TickerMode`：那条开关
            // 正是上一版把淡出冻在 1.000 的原因，见类注释）
            BreathingDots(running: showing),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                value == null ? '' : thinkingLine(value),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: style,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 那一行的正文（单独拎出来是为了能直接对字符串做用例）。
///
/// 全角空格分隔而不是 `·`：四个读数里有两处是"标签 + 数字"，用 `·` 会让分隔符与
/// "第 N 步"里的字挤成一片；全角空格在中文小字里既分得开、又不抢眼（不新造符号）。
///
/// ★ 「已想 X 字」那一格的**两态**（用户 2026-10-16 ①「这里不能是实时的吗？」）：
/// 后端一步跑完才发整段推理正文，所以等待期间**没有数可报**。那时显示「已想 …」
/// （明确说"还没数"），收到那一步的 `message/reasoning` 之后才显示真数
/// （`6.2 万字`）。**任何时刻都不显示「已想 0 字」**——那是个假读数。
/// 这一格**报不报数**：只有"有数"那两态才显示字数，[ThinkCharsPhase.pending] 显示占位。
bool reportsChars(ThinkCharsPhase phase) => phase != ThinkCharsPhase.pending;

String thinkingLine(ThinkingProgress p, {AppStrings strings = const ZhStrings()}) {
  // 步号与字数补到固定宽度：她一步里字数会一直涨（`48` → `152`），
  // 不补的话那一行的长度会一跳一跳地变——配上等宽数字，补位让"抖"降到只剩进制那一次
  final step = p.step.toString().padLeft(2, ' ');
  final chars = reportsChars(p.phase)
      // 有数就报数（`live` 是后端进度事件给的，`counted` 是落库后的真值——同一格同一形状）
      ? strings.compactChars(p.chars).padLeft(4, ' ')
      // 没数就说没数：`…` 是"还没生成"，不是 0
      : '   …';
  // 四个格子 + 语言各自的分隔符（中文全角空格、英文半角双空格），语序也在 strings 里
  return [
    strings.thinkingLabel,
    strings.thinkingStep(step),
    strings.thinkingChars(chars),
    strings.thinkingElapsed(formatThinkingElapsed(p.elapsed)),
  ].join(strings.thinkingGap);
}

/// 进行中指示：**三个点依次淡入淡出**（用户 2026-10-16：「克制的进行中指示」）。
///
/// 为什么不是旋转 spinner：转圈是"未知等待"的语法（网络请求、加载中），
/// 而这里发生的事**有进度**（步号、字数、秒数都在走），转圈会和那三个读数打架；
/// 而且转圈在低帧率下会明显地"一格一格"。
///
/// 为什么是 1.5 秒一轮、相位差 0.18：慢到不像在催人，又快到"它是活的"一眼看得出来；
/// 相位差小于 0.15 时三个点看起来是一起闪，大于 0.25 就散成了三件不相干的事。
/// 透明度只在 0.25↔1.0 之间走（不闪到全透明）：那是呼吸，不是闪烁。
///
/// ★ 动效的起停**由 [running] 显式控制**（用户 2026-10-16 ② 的修法之一）。
/// 上一版是把这一格包在 `TickerMode(enabled: showing)` 里"顺手"停掉的——那条开关与
/// 父级那个淡出抢**同一个** ticker，结果淡出被自己关掉、冻在 1.000，三个点就留在了屏上
/// （见 [ThinkingRow] 的类注释）。所以这里不借 `TickerMode`：看得见才 `repeat()`，
/// 看不见就 `stop()`（停在原地即可——整行的透明度已经是 0，它画不画都一样，
/// 但**不转**这条纪律要保住：屏幕上看不见的东西不该继续占着每一帧）。
class BreathingDots extends StatefulWidget {
  const BreathingDots({super.key, required this.running});

  /// 要不要转。`false` ⇒ 控制器停住（不占帧），不是把自己藏起来。
  final bool running;

  @override
  State<BreathingDots> createState() => _BreathingDotsState();
}

class _BreathingDotsState extends State<BreathingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1500),
  );

  @override
  void initState() {
    super.initState();
    if (widget.running) _controller.repeat();
  }

  @override
  void didUpdateWidget(BreathingDots old) {
    super.didUpdateWidget(old);
    if (old.running == widget.running) return;
    if (widget.running) {
      _controller.repeat();
    } else {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// 第 [index] 个点在进度 [t]（0..1 循环）时的透明度
  static double _opacityAt(double t, int index) {
    final phase = (t + index * 0.18) % 1.0;
    // 前 40% 淡入、后 60% 淡出（不对称：亮起来快一点，落下去慢一点，看着更"呼吸"）
    final wave = phase < 0.4 ? phase / 0.4 : 1 - (phase - 0.4) / 0.6;
    return 0.25 + 0.75 * wave.clamp(0.0, 1.0);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      // 与那一行小字（bodySmall 约 16px）等高：槽位的高度就按它定，行内不再撑高
      width: 18,
      height: 16,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) => Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (var i = 0; i < 3; i += 1)
              Opacity(
                opacity: _opacityAt(_controller.value, i),
                child: Container(
                  width: 4,
                  height: 4,
                  decoration: BoxDecoration(
                    color: scheme.onSurfaceVariant,
                    shape: BoxShape.circle,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// 历史**读失败**时那一屏：说清"没读到"，并给一个能再来一次的入口。
///
/// 为什么不复用 [_EmptyGuide] 那句「会话尚未开始」：那是**读成功、确实没有记录**。
/// 读失败是另一种事实——重试就可能好，说成"还没有"等于把故障说成了现状。
/// 所以这里带 [error] 原文（排障要看得出是哪一种失败）与一颗「重试」。
class _HistoryErrorState extends StatelessWidget {
  const _HistoryErrorState({required this.error, required this.onRetry});

  /// 失败原因（异常原文；给人排障，不是给她的口吻）
  final String error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    final detail = error.trim();
    return Center(
      key: const ValueKey('history-error'),
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 40, color: IrmiaTheme.danger),
            const SizedBox(height: 16),
            Text(s.historyErrorTitle,
                style: TextStyle(
                    fontSize: 15, fontWeight: FontWeight.w600, color: scheme.onSurface)),
            const SizedBox(height: 8),
            Text(detail.isEmpty ? s.historyErrorMessage : detail,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant)),
            const SizedBox(height: 18),
            OutlinedButton.icon(
              key: const ValueKey('history-retry'),
              onPressed: onRetry,
              icon: const Icon(Icons.refresh_rounded, size: 16),
              label: Text(s.retry),
            ),
          ],
        ),
      ),
    );
  }
}

/// 空会话引导：界面提示走专业语气，下一步动作直接落在输入框上
class _EmptyGuide extends StatelessWidget {
  const _EmptyGuide({required this.onCompose});

  final VoidCallback onCompose;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Center(child: HerFace(size: 56, radius: 18)),
            const SizedBox(height: 16),
            Center(
              child: Text(s.chatEmptyTitle,
                  style: TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w600, color: scheme.onSurface)),
            ),
            const SizedBox(height: 14),
            GuideBar(
              icon: Icons.chat_bubble_outline_rounded,
              text: s.chatEmptyMessage,
              actionLabel: s.chatEmptyAction,
              onAction: onCompose,
              hint: s.chatEmptyHint,
            ),
          ],
        ),
      ),
    );
  }
}

/// 一条气泡，或者一个工具块，或者一张通道消息卡片。
///
/// 没有打字机了：她的节奏感来自 speak 逐条发（彼此真的按打字速度隔开几秒），
/// 不来自把一句完整的话拆成一个字一个字往外挤——后者只是慢，而且难看。
class _BubbleRow extends StatelessWidget {
  const _BubbleRow({
    required this.item,
    required this.continues,
    required this.onToggle,
    required this.sender,
    this.topic,
  });

  final _BubbleItem item;
  final bool continues;
  final VoidCallback onToggle;

  /// 通道消息的发送者别名（非通道消息用不到）
  final String sender;

  /// 提及卡上那一行"那边在聊什么"（`channel/topic` 的结论；还没概括出来就是 null）
  final String? topic;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);

    if (item.kind == _ItemKind.tool) {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(
          alignment: Alignment.centerLeft,
          child: _ToolBlock(item: item, onToggle: onToggle),
        ),
      );
    }

    // 通道消息：靠右的卡片。与「手动唤醒」那种靠右气泡在同一个流里，但一眼分得开——
    // 那一类是实心蓝气泡（你说的话），这一类是带徽章的浅色卡（外面递进来的输入）。
    if (item.kind == _ItemKind.channel) {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(
          alignment: Alignment.centerRight,
          child: _ChannelBlock(item: item, sender: sender, onToggle: onToggle),
        ),
      );
    }

    // 上下文分界：**靠右的一张卡，复用框架提醒那张**（用户 2026-10-02："回到这边，复用卡片"）。
    //
    // 形态走过三版，前两版的理由都留着：先做成靠右的卡 → 用户想要"居中的小胶囊" → 胶囊的位置
    // 怎么调他都不满意，最后一句是"既然位置不好调，那么还是这样吧"（指回右侧那张卡）。
    // 回头看，中间那条"接缝不站队"是**多余的顾虑**：讲的是它不必挤进左右分列，
    // 而右侧那一列已经有两类卡，再多一类并不增加认知负担。按用户的话：复用。
    // 位置由事件自己的位置决定——它就在流里那两条之间（见 _consume）。
    if (item.kind == _ItemKind.boundary) {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(
          alignment: Alignment.centerRight,
          child: _NoticeCard(item: item, tag: s.tagContextBoundary, cardKey: 'boundary-card'),
        ),
      );
    }

    // 群里有人叫她（@ 或喊名字）——**框架注入的提醒卡**（用户 2026-10-02）：
    // "某群聊发生了提及" + light 的话题结论。它不是通道消息卡，所以单独一条分支。
    if (item.kind == _ItemKind.mention) {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(
          alignment: Alignment.centerRight,
          child: _MentionNoticeCard(
            item: item,
            sender: sender,
            topic: topic,
          ),
        ),
      );
    }

    // 注入预警（v25）：**靠右的一张卡**，与上下文分界同一形态、只换标签。
    // 位置由事件自己的位置决定——它紧跟在那条通道消息之后（见 _consume）。
    if (item.kind == _ItemKind.injection) {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(
          alignment: Alignment.centerRight,
          child: _NoticeCard(item: item, tag: s.tagInjection, cardKey: 'injection-card'),
        ),
      );
    }

    // 框架自己注入的提醒（定时/意图/后台任务/人工答复/标记，以及不带留言的「手动唤醒」）：
    // **不是人说的话**，所以不用气泡——用它自己的一张卡。位置**靠右**（用户明确）：
    // 左边那一列只留"她说的"，其余一切（你打的话、外面递进来的消息、框架的提醒）都在右边。
    if (item.side == 'sys') {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(
            alignment: Alignment.centerRight,
            child: _NoticeCard(
              item: item,
              tag: s.tagFrameworkReminder,
              cardKey: 'notice-card',
            )),
      );
    }

    final isMe = item.side == 'me';
    final bubble = Container(
      constraints: const BoxConstraints(maxWidth: 460),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        // 用户自己那条气泡：亮主题＝原来那个主色实心；暗主题＝**蓝去掉**，填充与背景相同
        // （透明）+ 一圈白描边。判据与取值都在 theme.dart 的 IrmiaDarkPair 里。
        color: isMe ? scheme.pairFill : scheme.surface,
        borderRadius: BorderRadius.only(
          topLeft: const Radius.circular(16),
          topRight: const Radius.circular(16),
          bottomLeft: Radius.circular(isMe ? 16 : 4),
          bottomRight: Radius.circular(isMe ? 4 : 16),
        ),
        // 她的气泡本来就有 outlineVariant 那一圈，**两模都不动**；只有用户那条在暗主题下
        // 多这一圈白（亮主题下 `bubbleHairline` 就是 `null`，与动手前逐字节相同）。
        border: isMe ? scheme.bubbleHairline : Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // 这条分支原来挂的是「会话来源：QQ」那句灰字——只有通道消息会用它，而通道消息
          // 现在是靠右的卡片（_ChannelBlock），气泡上不再需要一行来源说明。
          //
          // **她的与用户的都走同一套 MD 渲染**（用户 2026-10-05："该实现简单的 MD 渲染了"）：
          // 字面的 `**粗体**`、反引号在气泡里不该再出现。渲染不改变文本本身——选中复制
          // 拿到的仍是原文（见 markdown.dart 的三条纪律）。
          MarkdownText(
            item.text,
            base: TextStyle(
              fontSize: 14.5,
              height: 1.65,
              // 暗主题下气泡底是透明的，字走正常前景（主题的白）；亮主题＝原来的 onPrimary
              color: isMe ? scheme.pairOn : scheme.onSurface,
            ),
          ),
        ],
      ),
    );

    return Padding(
      padding: EdgeInsets.only(top: continues ? 4 : 16),
      child: Row(
        mainAxisAlignment: isMe ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (!isMe) ...[
            // 每条消息左边那枚小头像：底还是那个圆（原来那枚的字形换成了 IRMIA 图案），
            // 直径 28 → 24 是为了容下图案：图案在圆里占 62.5%，28 的圆就只有 17.5 给图案，
            // 小尺寸那一档图案的针尖在这个尺寸下已经要糊了。
            const HerFace(size: 24),
            const SizedBox(width: 8),
          ],
          Flexible(child: bubble),
          if (isMe) const SizedBox(width: 8),
        ],
      ),
    );
  }
}

// ──────────────────────────────── 工具调用块 ────────────────────────────────

/// 一次工具调用在界面上长什么样：卡片 + 左侧状态色条 + 名字 + 参数 + 结果。
///
/// 名字那一格写的是**她调的谁家的哪一件**：MCP 调用摆成 `mcp/server/tool`
/// （判据在 [_mcpToolLabel] 一处），别的工具照旧只写工具名。
///
/// 三条约束：
///   ① **一个块，不是一行**：她的动作是成串的，行会把它们散成一堆碎字。
///   ② **原地变身**：跑的时候转圈，回执到了原地换成结果与耗时，不新起一条。
///   ③ **不抢视线**：工具是过程不是内容——字号比正文小、色比正文淡，
///      整块只有左侧那条色条是彩色的，扫一眼就知道成没成。
class _ToolBlock extends StatelessWidget {
  const _ToolBlock({required this.item, required this.onToggle});

  final _BubbleItem item;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    final status = _toolStatus(item.toolStatus, scheme, s);
    final name = item.toolName ?? 'tool';
    // speak / report 是她**说话**的出口：标签形态，与别的工具分开
    final isSpeech = name == 'speak' || name == 'report';
    // **这一版只改这一格**：卡头上的名字。MCP 调用写成 `<mcp>/<server>/<tool>`
    // （见 [_mcpToolLabel]），别的工具与改之前逐字相同。
    // 版式、字号、参数行、展开方式一概没动——用户看过之后的口径是
    // 「不能复用原来 mcp 的卡片吗？就只改个显示的名字而已」。
    final label = isSpeech ? '<$name>' : _mcpToolLabel(name, item.toolArgs);
    final args = (item.toolArgs ?? '').trim();
    // 入口（`_consume`）已经剥过一次；这里再剥一次是**兜底**：`toolResult` 也可能由
    // 别处写进来（`_findToolBlock` 那条往上翻的回填路），漏一处就会在界面上重新露出颜色码。
    // 对已经干净的正文它是一个恒等变换（正则都不匹配），代价可以忽略。
    final result = sanitizeToolOutput(item.toolResult ?? '').trim();
    final folding = result.length > 180 || result.contains('\n');

    return TweenAnimationBuilder<double>(
      // 进场：淡入 + 轻微上移（历史恢复时一次性跑完，不刺眼）
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, 6 * (1 - t)), child: child),
      ),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 600),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          border: Border.all(color: scheme.outlineVariant),
          boxShadow: IrmiaTheme.hairline,
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // 状态色条：整块的“体温”（跑=蓝、成=绿、挂=红）
                AnimatedContainer(
                  duration: const Duration(milliseconds: 240),
                  width: 3,
                  color: status.color,
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(12, 9, 12, 10),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _header(scheme, status, label, name, isSpeech),
                        // 参数：speak / report 不显示——它们的内容马上就要以气泡出现，
                        // 在块里再抄一遍只是重复；别的工具显示成 key=value 的可读摘要。
                        if (!isSpeech && args.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            _argsSummary(args),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 11,
                              color: scheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                        const SizedBox(height: 8),
                        _result(scheme, status, result, folding, s),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _header(ColorScheme scheme, _ToolStatus status, String label, String name, bool isSpeech) {
    return Row(
      children: [
        Icon(_toolIcon(name), size: 14, color: scheme.onSurfaceVariant),
        const SizedBox(width: 6),
        Text(
          label,
          style: TextStyle(
            fontFamily: isSpeech ? 'monospace' : null,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
            color: scheme.onSurface,
          ),
        ),
        const SizedBox(width: 8),
        // 状态徽标：换状态时淡入淡出，不是硬切
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 200),
          child: Row(
            key: ValueKey(item.toolStatus ?? 'running'),
            mainAxisSize: MainAxisSize.min,
            children: [
              if (status.spinning)
                SizedBox(
                  width: 11,
                  height: 11,
                  child: CircularProgressIndicator(strokeWidth: 1.6, color: status.color),
                )
              else
                Icon(status.icon, size: 13, color: status.color),
              const SizedBox(width: 4),
              Text(status.label,
                  style: TextStyle(
                      fontSize: 11.5, color: status.color, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
        if (item.toolDurationMs != null) ...[
          const SizedBox(width: 6),
          Text(_duration(item.toolDurationMs!),
              style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
        ],
        const Spacer(),
        if (item.ts != null)
          Text(_hhmm(item.ts!),
              style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
      ],
    );
  }

  Widget _result(ColorScheme scheme, _ToolStatus status, String result, bool folding, AppStrings s) {
    if (item.toolStatus == null) {
      return Text(s.toolExecuting, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant));
    }
    if (result.isEmpty) {
      return Text(status.label, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant));
    }
    // **回退**：出错这一档的底/字曾经被改成主题的 error token（`errorFill/On`），
    // 用户 2026-10-05 只圈了"发送按钮和气泡"两处、并问"改其他的干嘛"——所以它回到
    // 原样：正文一律 `onSurface`，没有那块红色的底。别在这里再"优化"配色。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        AnimatedSize(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          alignment: Alignment.topLeft,
          child: Text(
            item.expanded ? result : _oneline(result, 240),
            maxLines: item.expanded ? null : 3,
            overflow: item.expanded ? TextOverflow.clip : TextOverflow.ellipsis,
            style: TextStyle(
              fontFamily: 'monospace',
              fontSize: 11.5,
              height: 1.5,
              color: scheme.onSurface,
            ),
          ),
        ),
        if (folding) ...[
          const SizedBox(height: 5),
          GestureDetector(
            onTap: onToggle,
            child: Text(
              item.expanded ? s.collapse : s.expandAll(result.length),
              style: TextStyle(fontSize: 11, color: scheme.primary, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ],
    );
  }
}

// ─────────────────────────── 通道消息卡片（左） ───────────────────────────

/// 一条从消息适配器进来的消息在界面上长什么样：**靠右的卡片**，与工具块同一套壳
/// （surface 底 + outlineVariant 描边 + radiusCard 圆角 + 发丝影）。
///
/// 为什么不是她的气泡（修订清单 ⑬）：气泡的形状本身在说"这是**这个人**说的一句话"，
/// 而通道消息不是谁在界面里说的——它是**外面递进来的一条输入**，和工具调用是同一类东西
/// （外面来的东西摆右边）。挂在她的气泡上还会读成"她刚说了这么一句"，正好说反。
///
/// 为什么名字取不到时不退回 openid：见 [ChatPageState._chanSenderOf]。
class _ChannelBlock extends StatelessWidget {
  const _ChannelBlock({required this.item, required this.sender, required this.onToggle});

  final _BubbleItem item;
  final String sender;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    // 识别不出的 chatType 不猜（可能是平台新加的会话类型），退回通道名——通道名恒有。
    // `mentionsMe` 参与判词：群里**没 @ 但喊了她的名字**也叫提及（关键词），而它的事件
    // chatType 是普通的 `group`——只看 chatType 的话，这张卡会写成「群聊消息」，
    // 看起来就像"群里的普通消息直接进了对话流"（用户 2026-10-02 正是这么问的）。
    final category = _chatTypeLabel(item.chatType, mentionsMe: item.mentionsMe, s: s)
      ?? _channelFallbackLabel(item.channel, s);
    // 色条说的是"这条冲谁来"：@ 她 / 喊她的名字 / 单聊是**点名找她**（主色），群里的背景音用灰。
    // 工具块那条色条说的是状态（跑/成/挂）——同一种形状，两种含义，位置与粗细一致。
    final directed = item.chatType == 'c2c' || item.chatType == 'group-at' || item.mentionsMe;
    final bar = directed ? scheme.primary : IrmiaTheme.sleep;
    final text = item.text.trim();
    final folding = text.length > 180 || text.contains('\n');

    return TweenAnimationBuilder<double>(
      // 与工具块同一支进场动画：淡入 + 轻微上移
      tween: Tween(begin: 0, end: 1),
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      builder: (context, t, child) => Opacity(
        opacity: t,
        child: Transform.translate(offset: Offset(0, 6 * (1 - t)), child: child),
      ),
      child: Container(
        key: const ValueKey('channel-card'),
        // 宽度取右侧那一列的常数（见 _kSideCardWidth）：**不再按内容量**。
        // 短句也占满一列宽，右边那一列才齐——这正是用户 ⑬ 补记要的"一样长"。
        width: _kSideCardWidth,
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          border: Border.all(color: scheme.outlineVariant),
          boxShadow: IrmiaTheme.hairline,
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(width: 3, color: bar),
                Expanded(
                  child: Padding(
                    // 上下 8：卡片高度贴合内容（用户 ⑮："空白太多"）。上 9 下 10 那种
                    // 不对称是上一轮随手写的，短卡上看得出来偏下。
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(Icons.forum_outlined, size: 14, color: scheme.onSurfaceVariant),
                            const SizedBox(width: 6),
                            _ChannelBadge(
                              text: category,
                              tone: directed ? scheme.primary : scheme.onSurfaceVariant,
                            ),
                            const SizedBox(width: 8),
                            // 这扇门是谁（用户 ⑬ 定：`<单聊消息> - QQ 官方bot（或对应消息适配器名称）`）：
                            // 屏幕上同时可能有两条通道，光看"单聊消息"分不出是哪一条送来的。
                            //
                            // 用 Expanded 而不是 Flexible+Spacer：两者 flex 都是 1，会把余量**对半分**，
                            // 名字只拿到一半就被省略号截掉（实测「QQ 官方 Bot」变成「QQ 官方 ⋯」）。
                            // 卡片宽度定死（420）之后，Expanded 也正好把时刻顶到右边。
                            Expanded(
                              child: Text(
                                _adapterLabel(item.channel, s),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                              ),
                            ),
                            const SizedBox(width: 8),
                            if (item.ts != null)
                              Text(_hhmm(item.ts!),
                                  style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
                          ],
                        ),
                        const SizedBox(height: 5),
                        // 发送者：**别名**（人在「消息适配器 → 会话联系人」里填的那个）。
                        // 取不到也**不退回 openid**，见 [ChatPageState._chanSenderOf]。
                        Text(
                          sender,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: scheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 2),
                        // 正文按外部不可信数据原样显示：不渲染 markdown（Text 本来也不会），
                        // 也不因为里面写了什么就换版式——它只是一个字符串。
                        // 长文与工具块同一个收口：折三行 + 「展开全部（N 字）」。
                        //
                        // 为什么不是 `SelectableText`（⑬ 原本用的那个）：它内部是 EditableText，
                        // `maxLines` 会漏进 `IntrinsicHeight` 的固有高度——**单行正文也按三行占位**
                        // （实测 66 逻辑像素 vs 22），这 44 像素的空白就是用户 ⑮ 圈出来的那一段。
                        // `SelectionArea + Text` 一样能选中复制，而固有高度是真实排版高度。
                        AnimatedSize(
                          duration: const Duration(milliseconds: 200),
                          curve: Curves.easeOutCubic,
                          alignment: Alignment.topLeft,
                          child: SelectionArea(
                            child: Text(
                              item.expanded ? text : _oneline(text, 240),
                              maxLines: item.expanded ? null : 3,
                              overflow: item.expanded ? TextOverflow.clip : TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 13.5, height: 1.6, color: scheme.onSurface),
                            ),
                          ),
                        ),
                        if (folding) ...[
                          const SizedBox(height: 5),
                          GestureDetector(
                            onTap: onToggle,
                            child: Text(
                              item.expanded ? s.collapse : s.expandAll(text.length),
                              style: TextStyle(
                                  fontSize: 11, color: scheme.primary, fontWeight: FontWeight.w600),
                            ),
                          ),
                        ],
                        // 已接收：会话（会话 id）。用户 ⑬ 要的一行"回执"——**这条不是他填的别名**，
                        // 所以 id 可以出现：它的用处是排障时能把界面这一条对上日志里的那一条
                        // （别名是给人认的，id 是给日志对的，两回事）。
                        //
                        // 正文与这一行之间留 5（不是 6 也不是 0）：用户 ⑮ 说"消息正文和下面的
                        // 信息适当保持距离可以保证美观"——留一口气，但不留出一行的空。
                        const SizedBox(height: 5),
                        Text(
                          s.receivedFrom(sender, _sidOf(item) ?? item.chatId ?? s.dash),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ─────────────────────── 上下文分界卡片（靠右） ───────────────────────

/// 这条 `compaction/summary` 是**人工 reset** 还是**系统自动压缩**。
///
/// 两者写的是同一种事件、同一份 payload（`{coveredUpToSeq, summary}`，见 `src/log/types.ts`
/// 的 `CompactionSummary`）——payload 自己说不清是谁要求的。分得开的是**信封**：
///
/// | | origin | visibility | summary |
/// | --- | --- | --- | --- |
/// | 人工 reset（`POST /api/commands/reset-context`，src/web/server.ts） | `web/api` | `internal` | 固定的 36 字那句 |
/// | 系统压缩（agent 每 turn 结束的 `maybeCompact`，src/runtime/agent-loop.ts） | `runtime/agent-loop` | `model` | 几 KB 的交接笔记 |
///
/// 本机日志实测（data/events 全量 5745 条里 18 条人工 / 9 条自动）：两个信号**没有一条例外**，
/// 而且各自独立成立（自动压缩那条必须 `model` 可见，否则摘要进不了她的上下文）。
/// 判不出来时按"压缩"渲染——那 9 条的正文都是交接笔记，形状与人工那句完全不同；
/// 以后要是多出第三个写入者，这里会把它画成压缩（宁可少说，不可说反）。
bool _isManualReset(Map<String, dynamic> event) {
  final origin = event['origin']?.toString() ?? '';
  final visibility = event['visibility']?.toString() ?? '';
  return origin == 'web/api' || visibility == 'internal';
}

// ─────────────────────── 框架提醒卡片（靠右） ───────────────────────

/// 框架自己注入的一句话（定时任务触发 / 意图唤醒 / 后台任务进展 / 人工答复已记录 /
/// 已标记成功失败 / 手动唤醒）：**不是人说的话**，所以不用气泡，用它自己的一张卡。
///
/// 为什么也靠右（用户 2026-10-02 明确）：左边那一列**只留"她说的"**，其余一切都在右边——
/// 你打的话、外面递进来的通道消息、框架的提醒。这样"哪句是她的"一眼就分得出来，
/// 而三种"不是她说的"内部再靠形状分（气泡 / 通道卡 / 提醒卡）。
class _NoticeCard extends StatelessWidget {
  const _NoticeCard({required this.item, required this.tag, this.cardKey = 'notice-card'});

  final _BubbleItem item;

  /// 卡头那枚徽章。**上下文分界复用的就是这张卡**（用户 2026-10-02："回到这边，复用卡片"），
  /// 只换标签——同一套壳、同一宽度、同一位置，不再单独养一套分界组件。
  final String tag;

  /// 注入预警专用：徽章换成危险色，正文上方多一行标题（"外部消息里有想指挥她的迹象"）。
  /// 用户 2026-10-02：「注入预警应该更醒目，用危险的颜色」——它是这一列里唯一一件
  /// **框架替她留意到的事**，与"她说了什么/别人说了什么"不是一个量级。
  /// 定位件（用例按它找卡）。**与标签分开**：标签会随语言变，定位件不许变。
  final String cardKey;

  bool get _isInjection => cardKey == 'injection-card';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final detail = (item.detail ?? '').trim();
    // **回退**：注入预警那根字曾经被换成主题的 error token，用户没要这一处——
    // 回到原来那个写死的危险色 `IrmiaTheme.danger`（#E03131）。
    final tone = _isInjection ? IrmiaTheme.danger : scheme.onSurfaceVariant;
    return Container(
      // 三种标签共用一个组件，但定位件保留三个名字：分界那一条的用例按 boundary-card 找、
      // 提醒那一条按 notice-card 找、注入预警按 injection-card 找——合并组件不该顺手把
      // 别人的定位件拆掉。
      key: ValueKey(cardKey),
      // 不再是一行小灰字（用户 ⑬："有点小且单薄，放点人类可能希望关注的信息"）：
      // 卡片 + 徽章 + 第二行细节，与通道卡片同一族的体量。
      // 宽度与通道卡**同一个常数**（用户 ⑮："应该和这个一样长"——右边那一列要齐）。
      width: _kSideCardWidth,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 9),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        // 注入预警的描边也用危险色（淡一档）：一眼看得出这张卡不一样，而不必读字
        border: Border.all(
          color: _isInjection ? tone.withValues(alpha: 0.45) : scheme.outlineVariant,
        ),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(
                _isInjection ? Icons.gpp_maybe_outlined : Icons.auto_awesome_outlined,
                size: 13,
                color: tone,
              ),
              const SizedBox(width: 6),
              _ChannelBadge(text: tag, tone: tone),
              const Spacer(),
              if (item.ts != null)
                Text(_hhmm(item.ts!),
                    style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
            ],
          ),
          if (_isInjection) ...[
            const SizedBox(height: 5),
            Text(kInjectionCardTitle,
                style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ],
          const SizedBox(height: 6),
          // 「框架提醒」卡正文与气泡**同一套 MD 渲染**（用户 2026-10-05）：注入预警、
          // 告警、定时提醒这些现在也是字面的 `**`。同一套渲染器意味着同一份纪律
          // （不改文本本身 / 规则外原样 / 未闭合退化），不需要第二处判据。
          MarkdownText(
            item.text,
            base: TextStyle(fontSize: 12.5, color: scheme.onSurface),
          ),
          for (final quote in item.quotes) _InjectionQuote(text: quote),
          if (detail.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(
              detail,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }
}

/// 注入预警卡的标题：**界面常量**（与 ask 卡同一条防伪口径）——别人发的消息改不动它，
/// 与运行情况页「框架提示」里那一行逐字相同（两处说的是同一件事，措辞不该分叉）。
/// 注入预警卡上的标题（中文那份的字面值；界面走 s.injectionCardTitle）。
/// 用例按这个常量断言「标题是界面常量，与运行情况页同一句」。
const kInjectionCardTitle = '外部消息里有想指挥她的迹象';

/// 引用片段：外部原文。左侧一条竖线把它与框架的结论分开
/// （§6 渲染纪律的界面版：框里是别人的话，框外才是框架的话，归属要一眼分得开）。
class _InjectionQuote extends StatelessWidget {
  const _InjectionQuote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 5),
      padding: const EdgeInsets.fromLTRB(8, 5, 8, 5),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        border: Border(left: BorderSide(color: scheme.outlineVariant, width: 2)),
      ),
      child: Text(
        '「$text」',
        style: TextStyle(
          fontFamily: 'monospace',
          fontSize: 11.5,
          height: 1.5,
          color: scheme.onSurfaceVariant,
        ),
      ),
    );
  }
}

/// 类别徽章：与运行情况页 / 日志页那些 `_Badge` **同一形态**（12% 淡底、radiusCtl、
/// 11px w500 语义色）。收在页面里而不是提进 ui_kit：本页只用这一枚，提上去会让另外
/// 六处私有 `_badge` 与它并存，反而多出一种"该用哪个"的选择。
class _ChannelBadge extends StatelessWidget {
  const _ChannelBadge({required this.text, required this.tone});

  final String text;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: tone)),
    );
  }
}

/// 别名取不到时写什么。**不写 openid**：见 [ChatPageState._chanSenderOf]。
/// 发送者兜底名（中文那份的字面值；界面走 s.unnamedSender）。
const kUnnamedSender = '未命名会话';

/// 提及卡（群里有人叫她）：**框架注入的提醒**，不是通道消息。
///
/// 用户 2026-10-02 的口径：「此处应当是一个卡片。属于框架注入的提醒。某群聊发生了提及，
/// 以及 light loop 给出的简单话题结论」，随后又划掉了一版里的说明行：
/// 「GUI 是给人看的，就不必要显示了这么说了，这里放 light 的话题摘要」——
/// 所以卡上只有三件事，**没有一个字是给她看的内部口径**：
///   ① 卡头徽章「群聊提及」（界面常量，与 ask 卡同一条防伪口径）；
///   ② 「<会话名> 里有人提到了你」；
///   ③ 那边在聊什么（light 的 `channel/topic` 结论；还没概括出来就**不写这一行**，绝不编）。
/// 被叫的那句话原样附在里面：人得看得见"到底是什么话把她叫醒的"。
class _MentionNoticeCard extends StatelessWidget {
  const _MentionNoticeCard({required this.item, required this.sender, this.topic});

  final _BubbleItem item;
  final String sender;
  final String? topic;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    final talking = (topic ?? '').trim();
    return Container(
      key: const ValueKey('mention-card'),
      width: _kSideCardWidth,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 9),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        // 与「框架提醒」同一族，但描边用主色淡一档：这是"叫她了"，不是背景音
        border: Border.all(color: scheme.primary.withValues(alpha: 0.35)),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Icon(Icons.alternate_email, size: 13, color: scheme.primary),
              const SizedBox(width: 6),
              _ChannelBadge(text: s.groupMention, tone: scheme.primary),
              const Spacer(),
              if (item.ts != null)
                Text(_hhmm(item.ts!),
                    style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(height: 5),
          Text(s.mentionsYou(sender),
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          const SizedBox(height: 5),
          Text(item.text, style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurface)),
          if (talking.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(s.talkingAbout(talking),
                style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant)),
          ],
        ],
      ),
    );
  }
}

/// 会话类型 → 类别标记。认不出返回 null，由调用方拿通道名兜底（不猜）。
///
/// `mentionsMe` 参与判词：群里**没 @ 但正文里喊了她的名字**（关键词提及）也叫提及——
/// 它的事件 `chatType` 是普通的 `group`，只看 chatType 就会写成「群聊消息」，
/// 看起来像"群里的普通消息直接进了对话流"。
String? _chatTypeLabel(String? chatType, {bool mentionsMe = false, AppStrings s = const ZhStrings()}) {
  switch (chatType) {
    case 'c2c':
      return s.directMessage;
    case 'group-at':
      return s.groupMention;
    case 'group':
      return mentionsMe ? s.groupMention : s.groupMessage;
    default:
      return null;
  }
}

/// 这条是从**哪扇门**来的（用户 ⑬ 定：`<单聊消息> - QQ 官方bot（或对应消息适配器名称）`）。
///
/// 与 [_channelFallbackLabel] 不是一回事：那个是**会话类型认不出时**的兜底标记
/// （"QQ 消息"），这个是**恒要显示**的适配器名——屏幕上同时可能有两条通道，
/// 光看"单聊消息"分不出是哪一条送来的。
String _adapterLabel(String? channel, AppStrings s) {
  switch (channel) {
    case 'qq-official':
      return s.qqOfficialBot;
    case 'onebot':
      return 'OneBot';
    default:
      return channel == null || channel.isEmpty ? s.externalChannel : channel;
  }
}

/// 认不出会话类型时的兜底标记：**用通道名说清这条是从哪儿来的**，不编一个具体场景。
///
/// 通道名也认不出（后端加了新通道，或者事件里根本没带）就写「外部消息」——
/// 那时我们确实只知道"它是外面递进来的"。
String _channelFallbackLabel(String? channel, AppStrings s) {
  switch (channel) {
    case 'qq-official':
      return s.qqMessage;
    case 'onebot':
      return s.oneBotMessage;
    default:
      return s.externalMessage;
  }
}

/// 这条通道消息的 sid。拼法**必须与后端 `sidOf` 一致**（src/channel/sessions.ts）：
/// 命名空间 `onebot → 'onebot'`、其余 → `'qq'`，于是 `sid = '<命名空间>:<chatType>:<chatId>'`。
///
/// 拼错了不会报错，只会让每一条通道消息都显示「未命名会话」——所以缺字段时返 null，
/// 由渲染处走那条中性文案，而不是硬拼一个查不到的键。
String? _sidOf(_BubbleItem item) {
  // 提及卡只有 sid（它没有"通道消息三件套"那三样——那条路的事件不进通道卡）
  final known = item.mentionSid;
  if (known != null && known.isNotEmpty) return known;
  final channel = item.channel;
  final chatType = item.chatType;
  final chatId = item.chatId;
  if (channel == null || chatType == null || chatId == null) return null;
  if (chatType.isEmpty || chatId.isEmpty) return null;
  // **@ 与否不是会话身份**（2026-10-02 会话身份归一，src/channel/sessions.ts 的 sidKindOf）：
  // 群里 @ 过她的那条算 `group-at`，其余算 `group`，而归一之后两者是**同一个会话**——
  // 这里不归一，那些 @ 过的消息就会显示「未命名会话」（查不到键），名字明明填过。
  final kind = chatType == 'group-at' ? 'group' : chatType;
  return '${channel == 'onebot' ? 'onebot' : 'qq'}:$kind:$chatId';
}

/// 归一形态的 sid → 它的旧写法（联系人表里可能还是那一份）。不是群聊就返回原串。
///
/// 与后端 `sessions.ts` 的 `sidLookupKeys` 同一个口径：**改口径不该让人已经写下的东西变成废纸**。
String _legacySidOf(String sid) {
  final at = sid.indexOf(':');
  final second = at < 0 ? -1 : sid.indexOf(':', at + 1);
  if (second <= at + 1) return sid;
  final namespace = sid.substring(0, at);
  final kind = sid.substring(at + 1, second);
  final chatId = sid.substring(second + 1);
  return kind == 'group' ? '$namespace:group-at:$chatId' : sid;
}

class _ToolStatus {
  const _ToolStatus({
    required this.color,
    required this.icon,
    required this.label,
    this.spinning = false,
  });

  final Color color;
  final IconData icon;
  final String label;
  final bool spinning;
}

/// 回执状态 → 颜色 / 图标 / 状态词。null 表示还没回执（正在跑）。
///
/// **出错那一档回到写死的 `IrmiaTheme.danger`**（#E03131）：上一轮它被换成了主题的
/// `errorOn`（深色模浅红），理由是深色底上的对比度；用户 2026-10-05 只圈了气泡与发送键
/// 两处，并问"改其他的干嘛"——所以这里原样退回。四色在明暗两模下都不随主题漂移
/// （见 [IrmiaTheme.ok] 那一段的说明），要动它得先问用户。
_ToolStatus _toolStatus(String? status, ColorScheme scheme, AppStrings s) {
  switch (status) {
    case null:
      return _ToolStatus(
          color: scheme.primary, icon: Icons.autorenew_rounded, label: s.toolRunning, spinning: true);
    case 'ok':
      return _ToolStatus(color: IrmiaTheme.ok, icon: Icons.check_rounded, label: s.toolDone);
    case 'error':
      return _ToolStatus(color: IrmiaTheme.danger, icon: Icons.close_rounded, label: s.toolError);
    case 'timeout':
      return _ToolStatus(
          color: IrmiaTheme.warn, icon: Icons.hourglass_bottom_rounded, label: s.toolTimeout);
    case 'denied':
      return _ToolStatus(
          color: IrmiaTheme.warn, icon: Icons.shield_outlined, label: s.toolDenied);
    case 'unknown':
      return _ToolStatus(
          color: IrmiaTheme.sleep, icon: Icons.help_outline_rounded, label: s.toolUnknown);
    case 'aborted':
      return _ToolStatus(
          color: IrmiaTheme.sleep, icon: Icons.remove_circle_outline_rounded, label: s.toolNotDispatched);
    case 'over-limit':
      return _ToolStatus(
          color: IrmiaTheme.warn, icon: Icons.speed_rounded, label: s.toolOverStepCap);
    default:
      return _ToolStatus(color: IrmiaTheme.sleep, icon: Icons.circle_outlined, label: status);
  }
}

/// 工具名 → 图标。认不出的（MCP 接入的、以后新增的）走通用图标，不猜。
IconData _toolIcon(String name) {
  if (name == 'speak') return Icons.chat_bubble_outline_rounded;
  if (name == 'report') return Icons.article_outlined;
  switch (name) {
    case 'safe_read':
    case 'read_blob':
      return Icons.description_outlined;
    case 'rg_search':
    case 'es_search':
      return Icons.search_rounded;
    case 'safe_edit':
    case 'safe_write':
    case 'multi_edit':
      return Icons.edit_note_rounded;
    case 'safe_rollback':
      return Icons.history_rounded;
    case 'http_get':
    case 'http_post':
      return Icons.public_rounded;
    case 'vision_read':
    case 'vision_query':
      return Icons.image_outlined;
    case 'pwsh':
      return Icons.terminal_rounded;
    case 'timer':
    // v35 把定时器三件并成一件 `timer`；旧名留在表里是因为**历史日志**里的工具名还是它们
    // （消息列表要照旧渲染旧记录），不是给新调用用的。
    case 'set_timer':
    case 'cancel_timer':
    case 'list_timers':
      return Icons.timer_outlined;
    case 'todo':
      return Icons.checklist_rounded;
    case 'write_persona':
      return Icons.badge_outlined;
    default:
      return Icons.extension_outlined;
  }
}

/// MCP 入口工具的名字（`src/tools/mcp-entry.ts` 的 `MCP_ENTRY_TOOL_NAME`）。
///
/// **判据就是它**：她的工具清单里没有 `mcp__{server}__{tool}` 那一批（那是注册表形态），
/// 一次 MCP 调用落到日志里恒是 `name: 'mcp'` + `arguments: {server, tool, args}`
/// （本机 data/events 实测：`{"server": "obscura", "tool": "browser_navigate", "args": {...}}`）。
const String _kMcpEntryName = 'mcp';

/// 名字里那两枚斜杠（`mcp/obscura/browser_navigate`）。
///
/// 用户 2026-10-10 看过第一版之后的口径：「不能复用原来 mcp 的卡片吗？就只改个显示的名字而已」
/// ——所以这里**只是一个名字**：短、朴素、不加样式。斜杠与 `mcp__{server}__{tool}`
/// 那种命名空间写法同源（读起来就是一条路径），也不必解释一个新记号。
const String _kMcpLabelSep = '/';

/// 卡头上那个名字：**`mcp` 才拆**，其余工具原样返回（与改动之前逐字相同）。
///
/// 「原来那张卡片 + 只改名字」：这张卡片的版式、字号、参数行、展开方式一概没动，
/// 这里只决定名字那一格印什么字。
///
/// 兜底是**照旧显示工具名**：`arguments` 不是合法 JSON、缺 `server` / `tool`、
/// 或者那两格不是字符串（数字、null、空串）⇒ 返回 `mcp`，不报错、也不会显示 `undefined` / `null`。
/// 只拆到一半（只给 `server`，那是"看它有哪些工具"而不是调用）也**不拼半个层级**：
/// `mcp/obscura` 看着像一次完整的调用。
///
/// server 与 tool 都是外部 server 给的不可信字符串：这里只做"拼成一行名字"，
/// 不改变它们的字符，也不额外截断——版式该不该收由卡片那一行自己管。
String _mcpToolLabel(String name, String? arguments) {
  if (name != _kMcpEntryName) return name;
  final raw = (arguments ?? '').trim();
  if (raw.isEmpty) return name;
  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (_) {
    return name; // 不是合法 JSON：当没这回事，照旧显示工具名
  }
  if (decoded is! Map) return name;
  final server = _asText(decoded['server']);
  final tool = _asText(decoded['tool']);
  if (server == null || tool == null) return name;
  return '$name$_kMcpLabelSep$server$_kMcpLabelSep$tool';
}

/// 一格字符串字段。非字符串（数字、对象、null）与空白串都不算有值——
/// **认不出就不写**，不把 `undefined` / `null` 摆到名字上。
String? _asText(Object? value) {
  if (value is! String) return null;
  final text = value.trim();
  return text.isEmpty ? null : text;
}

/// 参数压成一行可读文本（`key=value  key2=value2`）。
///
/// 直接把 JSON 原文摆出来是浪费——工具参数的意义在“对哪个文件、跑什么命令”，
/// 不在引号与括号。解不出 JSON 就照原样压平（多行命令、手写参数都能看）。
String _argsSummary(String args) {
  if (args.isEmpty || args == '{}') return '';
  try {
    final decoded = jsonDecode(args);
    if (decoded is Map && decoded.isNotEmpty) {
      return decoded.entries.map((e) => '${e.key}=${_short(e.value)}').join('   ');
    }
  } catch (_) {
    // 不是 JSON：当纯文本处理
  }
  return _oneline(args, 110);
}

String _short(Object? value) {
  final text = value is String ? value : jsonEncode(value);
  return _oneline(text, 60);
}

/// 压成一行并限长（折叠态用：工具结果的信息密度比排版好看重要）
String _oneline(String text, int max) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.length <= max) return flat;
  return '${_headByRunes(flat, max)}…';
}

/// 取前 [max] 个**字符**，绝不切开一个代理对（surrogate pair）。
///
/// `substring` 按 UTF-16 码元切：`max` 正好落在一个 emoji / 生僻字的中间时，
/// 结果里会留一个孤立的高代理——Flutter 画它就是一个"豆腐块"。
/// 这不是理论问题：她的输出里 emoji 与中文都不少，而 240 这个常数又恰好会切到。
String _headByRunes(String text, int max) {
  if (text.length <= max) return text;
  final runs = text.runes.toList(growable: false);
  if (runs.length <= max) return text;
  return String.fromCharCodes(runs.take(max));
}

String _duration(int ms) => ms < 1000 ? '${ms}ms' : '${(ms / 1000).toStringAsFixed(1)}s';

// ─────────────────────────── 工具输出里的终端装饰（ANSI） ───────────────────────────

/// 完整的 ANSI 转义序列（**带 ESC**）。
///
/// 三支，都是终端里真实存在的形态：
///   · `\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)` —— OSC（如设置窗口标题 `ESC]0;…BEL`），
///     它用 BEL 或 `ESC \` 收尾，**不吃掉后面正常文字**；
///   · `\u001b\[[0-9;?]*[ -/]*[@-~]` —— CSI：SGR（颜色/加粗，`m` 收尾）与光标/擦除
///     （`H` / `J` / `K` …）都在这一支里。**不限 `m`**：`ESC[2K` 这种只是没有颜色，
///     留在正文里一样是乱码；
///   · `\u001b[@-Z\\-_]` —— 两字符的 Fe 转义（`ESC c` 复位之类）。
final RegExp _ansiEscapeRe =
    RegExp('\u001b\\][^\u0007\u001b]*(?:\u0007|\u001b\\\\)|\u001b\\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\\\-_]');

/// **丢了 ESC 的** SGR 残渣：`[32;1m` / `[0m` 这种形式。
///
/// 为什么非要单独认它：用户截图里那行就是 `[32;1mName[0m[32;1mMode[0m…`——**前面没有 ESC**。
/// 产生它的现场很常见：着色在管道里被谁剥掉了控制字符、或者输出经过了只认 `\u001b[` 的
/// 清洗（`src/tools/pwsh.ts:560` 的 `ANSI_RE` 只管 CLIXML 那一支，正文不走它）。
/// 只认带 ESC 的那一支的话，人看到的仍是一屏 `[32;1m`。
///
/// 判据（这条决定了它会不会误伤正文）：**参数全是数字/分号、以 `m` 收尾**，
/// 且**左边不是 `]`**。
///
/// 最后那半条是实测补上的，而且**不能收紧到"左边必须是空白"**：
/// 着色输出里最常见的正是紧贴文字的那个复位码（`Name[0m`、`Mode[0m`）——
/// 按空白卡的话它们全都漏掉，用户截图里那行就修不干净（实测：第一批样例里
/// `[0m` 一个都没剥掉）。
///
/// 所以只挡一种形状：`[1m](url)`——markdown 链接正文的结尾 `]` 后面紧跟自己那一对方括号。
/// 实测不加它时 `see [docs](http://x) and [1m]` 会被吃掉两个字符。
///
/// 于是 `[exit code: 0]`、`[stderr]`、`[sh…` 一个都不匹配（含字母、或不以 `m` 结尾），
/// 而她真的想看的正文照旧留着。
final RegExp _bareSgrRe = RegExp(r'(?<!\])\[[0-9;]{1,16}m');

/// 裸控制字符：退格、响铃、`\r`（`\t` / `\n` 留给排版）。
///
/// 它们不带 ESC 也能进正文（终端里 `\b` 是"擦掉一格"），原样画出来是一个方块或一段空白。
final RegExp _bareControlRe = RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]');

/// 工具输出上屏前**剥掉终端装饰**（用户 2026-10-16 ③）。
///
/// 做什么：把 ANSI 转义序列（SGR 颜色/加粗、光标控制、OSC）与裸控制字符去掉，
/// 换行与制表符留着（它们是排版，不是装饰）。
///
/// 边界：剥的是**装饰**，不是内容——`[exit code: 0]`、`[stderr]` 这类服务端写的状态行
/// 一个字都不动（见 [_bareSgrRe] 的判据）。真要吃不准的形态（例如她输出的 markdown
/// 里恰好有 `[1m`），代价也只是少显示两个字符，不会把正文吃掉。
///
/// 为什么不改服务端：那是另一条线（`src/**`），而且这是**显示**层的事——
/// 日志里留着原始字节是对的（复盘时要看得见她到底收到了什么），
/// 只有"画给人看"这一层该剥。服务端现有那条 `ANSI_RE`（`src/tools/pwsh.ts:560`）
/// 只覆盖 CLIXML 那一支，正文不走它。
String sanitizeToolOutput(String raw) {
  if (raw.isEmpty) return raw;
  // **顺序有讲究**：`\r` 必须先折成换行，再剥控制字符。
  // 反过来的话它已经被当控制字符删掉了，`进度 10%\r进度 20%` 会被粘成一行看不懂的东西
  // （终端里那个 `\r` 是"回到行首重写"，当分隔符看才对）。
  final normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  return normalized
      .replaceAll(_ansiEscapeRe, '')
      .replaceAll(_bareSgrRe, '')
      .replaceAll(_bareControlRe, '');
}

String _hhmm(String iso) {
  final dt = DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return '';
  return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
