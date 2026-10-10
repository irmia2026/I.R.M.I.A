import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../app.dart';
import '../markdown.dart';
import '../theme.dart';
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
/// 直到日志开头那行状态说"没有更早的记录了"。做法与代价见 [_ChatPageState._loadEarlier]
/// 与 [_ChatPageState._anchorKey]。
class ChatPage extends StatefulWidget {
  const ChatPage({super.key, required this.state});
  final AppState state;

  @override
  State<ChatPage> createState() => _ChatPageState();
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
const String kFrameworkNoticeLabel = '框架通报';

/// 框架通报（`wake/manual` 里 `via` 有值的那一类）在卡片头上写什么标签。
///
/// **判据不在这里**——"是不是框架通报"只看 `via` 有没有值，那一处在 [_ChatPageState._consume]
/// 里（`via.isNotEmpty`，一处，别在别处再写第二遍）。这张表只负责"这一种来源叫什么名字"：
/// 认不出来的一律叫 [kFrameworkNoticeLabel]，于是**新增一种 `via` 不必回来改界面**。
///
/// 为什么不反过来（按 via 逐个建容器/版式）：那正是原先把 `via == 'dream'` 写死在分支里的
/// 毛病——`'mcp'` 补上时没人回来改，那条框架通报就落进了"有 note = 用户的话"那一支
/// （用户 2026-10-09 的截图：他自己"说"了一段 MCP 通报）。文案会改、来源会加，
/// 只有"是不是框架通报"这一层是稳定的。
String frameworkNoticeLabel(String via) {
  switch (via) {
    // 界面的 /dream 动作：那条 note 是框架替她拼的整理指令
    case 'dream':
      return '做梦';
    // MCP 声明面被改（加/删/改 server）：正文是"哪些 server 变了、现在几个"
    case 'mcp':
      return 'MCP 声明变更';
    default:
      return kFrameworkNoticeLabel;
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
  /// （见 [_ChatPageState._contacts]）。
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
  /// 由 [_ChatPageState._consume] 在 `channel/topic` 到达时**认领**给最近一张还没拿到话题的卡。
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
  /// （同一个 callId 画成两块，看着像她调了两次）。见 [_ChatPageState._consume]。
  String? toolName;
  String? toolArgs;
  /// 回执到达时写入；null 表示还在跑
  String? toolResult;
  String? toolStatus;
  int? toolDurationMs;
  bool expanded = false;
}

class _ChatPageState extends State<ChatPage> {
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
    // 断线时不发请求（后端没起来，问了也是白问），恢复连接那一刻补一次：
    // 人在离线期间去「会话联系人」填了名字，回来就能看到。
    widget.state.addListener(_onStateChange);
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChange);
    sub?.cancel();
    _retry?.cancel();
    scroll.removeListener(_onScroll);
    scroll.dispose();
    input.dispose();
    inputFocus.dispose();
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && !_contactsLoaded) unawaited(_loadContacts());
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
  /// 为什么留 48 的余量：滚轮一格就是 120，等真的贴到 `minScrollExtent` 才判断的话，
  /// 位置停在顶端不再变化，监听器根本不会被叫到（这是"到顶没反应"的经典原因）。
  void _onScroll() {
    if (!scroll.hasClients) return;
    final position = scroll.position;
    if (position.pixels <= position.minScrollExtent + 48) unawaited(_loadEarlier());
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
    if (_earlierFailed) return '更早的记录读取失败，向上滚动重试';
    if (!_hasEarlier && items.isNotEmpty) return '没有更早的记录了';
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
    try {
      final data = await widget.state.api.get('/api/events?limit=60');
      final events = (data is Map ? (data['events'] as List?) : null) ?? const [];
      // 历史也走同一条消费路径（call/result 照样配对），只是不播进场动画
      items.clear();
      _seenSeqs.clear(); // 与 items 同生共死：重取历史时它们是"新"的
      _earliestSeq = null;
      _olderCount = 0;
      _atHead = false;
      for (final raw in events.whereType<Map>()) {
        _consume(raw.cast<String, dynamic>());
      }
      if (!mounted) return;
      setState(() => loadingHistory = false);
      _scrollToEnd();
    } catch (_) {
      if (mounted) setState(() => loadingHistory = false);
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
    sub = widget.state.api.events().listen(
      (event) {
        final added = _consume(event);
        if (!mounted) return;
        setState(() {});
        // 只有真的添了新东西才滚到底：回执是原地更新的，不该把正在看的人拽走
        if (added) _scrollToEnd();
      },
      onError: (_) {
        // 断线重连：3 秒后重试（SSE 由服务端 Last-Event-ID 补拉）
        _retry?.cancel();
        _retry = Timer(const Duration(seconds: 3), () {
          if (mounted) connectStream();
        });
      },
      onDone: () {
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
            text: frameworkNoticeLabel(via),
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
            text: '手动唤醒',
            detail: person.isEmpty ? null : '来自 $person',
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
          text: manual ? '上下文在此处清空' : '上下文在此处压缩',
          detail: manual ? '到此为止的往来不再计入她的上下文' : '到此为止的往来被交接笔记替代，不再逐条计入',
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
        final where = (data['chatType']?.toString() ?? '') == 'c2c' ? '单聊' : '群聊';
        final by = ((data['by']?.toString() ?? '') == 'model' || fallback?.by == 'model')
            ? '模型判定'
            : '规则命中';
        final source = [
          if (who.isNotEmpty) '来自 $who',
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
        block.toolResult = content.isEmpty ? (errMessage ?? '') : content;
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
          text: '定时任务触发',
          detail: [if (id.isNotEmpty) id, if (at.isNotEmpty) '原定 $at'].join(' · '),
          ts: ts,
        ));
        return true;
      }
      case 'wake/intention': {
        // 意图的正文就是这条提醒的全部意义——不摆出来，人只看到"意图唤醒"四个字
        final content = (data['content']?.toString() ?? '').trim();
        _sink.add(_BubbleItem.text(
          side: 'sys',
          text: '意图唤醒',
          detail: content.isEmpty ? null : content,
          ts: ts,
        ));
        return true;
      }
      case 'wake/job': {
        final id = (data['jobId']?.toString() ?? '').trim();
        _sink.add(_BubbleItem.text(
          side: 'sys',
          text: '后台任务进展',
          detail: id.isEmpty ? null : id,
          ts: ts,
        ));
        return true;
      }
      case 'wake/heartbeat':
        return false; // 心跳不打扰
      case 'human/answered':
        _sink.add(_BubbleItem.text(side: 'sys', text: '人工答复已记录', ts: ts));
        return true;
      case 'review/resolved':
        final ok = data['outcome'] == 'succeeded';
        _sink.add(_BubbleItem.text(side: 'sys', text: ok ? '已标记成功' : '已标记失败', ts: ts));
        return true;
      default:
        return false;
    }
  }

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
      IrmiaToast.show(context, '上下文已清空，后面的对话从零开始', kind: ToastKind.success);
    } catch (err) {
      if (mounted) IrmiaToast.show(context, '清空失败：$err', kind: ToastKind.error);
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
      IrmiaToast.show(context, '叫她去做梦了——整理完会写进记忆，日志页能看到', kind: ToastKind.success);
    } catch (err) {
      if (mounted) IrmiaToast.show(context, '触发失败：$err', kind: ToastKind.error);
    }
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients) {
        scroll.animateTo(
          scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      }
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
    _scrollToEnd();
    try {
      final res = await widget.state.api.post('/api/commands/wake', {'note': text});
      // 幂等键撞上时服务端会静默丢弃（fold 层不写任何事件）——那与"她正在想"在界面上
      // 长得一模一样，所以回执里带了 deduped，这里必须让人看见。
      if (mounted && res is Map && res['deduped'] == true) {
        setState(() => items.removeWhere((e) => e.side == 'me' && e.text == text && e.ts == null));
        IrmiaToast.show(context, '这句和刚发过的完全一样，被当成同一条忽略了——过几秒再发一次就行',
            kind: ToastKind.info);
      }
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('发送失败：$err')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final note = _headNote;
    // 锚点前面那一份（往上翻出来的更早内容）有多长；宽度变化时别让它越界
    final olderCount = _olderCount.clamp(0, items.length);
    return Column(
      children: [
        const PageHeader(title: '聊天', subtitle: '会话、消息来源与人工唤醒'),
        Expanded(
          child: loadingHistory
              ? const Center(child: CircularProgressIndicator())
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
        Container(
          padding: const EdgeInsets.fromLTRB(18, 12, 18, 16),
          child: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: input,
                  focusNode: inputFocus,
                  onSubmitted: (_) => unawaited(send()),
                  decoration: InputDecoration(
                    hintText: '输入消息…（/reset 清空上下文、/dream 叫她整理记忆）',
                    filled: true,
                    fillColor: scheme.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide(color: scheme.outlineVariant),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide(color: scheme.outlineVariant),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(24),
                      borderSide: BorderSide(color: scheme.primary, width: 1.4),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              SizedBox(
                width: 44,
                height: 44,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    padding: EdgeInsets.zero,
                    // 暗主题下：填充与背景相同（透明）+ 一圈白描边；亮主题下：原来那个
                    // `const CircleBorder()` + primary 填充。判据与取值都在 theme.dart 的
                    // IrmiaDarkPair 里，这里不判明暗、也不挑色。
                    shape: scheme.sendButtonShape,
                    backgroundColor: scheme.pairFill,
                  ),
                  onPressed: () => unawaited(send()),
                  child: Icon(Icons.arrow_upward_rounded, size: 20, color: scheme.pairOn),
                ),
              ),
            ],
          ),
        ),
      ],
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
              child: Text('会话尚未开始',
                  style: TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w600, color: scheme.onSurface)),
            ),
            const SizedBox(height: 14),
            GuideBar(
              icon: Icons.chat_bubble_outline_rounded,
              text: '还没有会话记录。',
              actionLabel: '输入消息',
              onAction: onCompose,
              hint: '在下方输入框发送内容后，会话与来源显示在此。',
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
          child: _NoticeCard(item: item, tag: '上下文分界'),
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
          child: _NoticeCard(item: item, tag: '注入预警'),
        ),
      );
    }

    // 框架自己注入的提醒（定时/意图/后台任务/人工答复/标记，以及不带留言的「手动唤醒」）：
    // **不是人说的话**，所以不用气泡——用它自己的一张卡。位置**靠右**（用户明确）：
    // 左边那一列只留"她说的"，其余一切（你打的话、外面递进来的消息、框架的提醒）都在右边。
    if (item.side == 'sys') {
      return Padding(
        padding: EdgeInsets.only(top: continues ? 6 : 14, bottom: 2),
        child: Align(alignment: Alignment.centerRight, child: _NoticeCard(item: item)),
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
    final status = _toolStatus(item.toolStatus, scheme);
    final name = item.toolName ?? 'tool';
    // speak / report 是她**说话**的出口：标签形态，与别的工具分开
    final isSpeech = name == 'speak' || name == 'report';
    // **这一版只改这一格**：卡头上的名字。MCP 调用写成 `<mcp>/<server>/<tool>`
    // （见 [_mcpToolLabel]），别的工具与改之前逐字相同。
    // 版式、字号、参数行、展开方式一概没动——用户看过之后的口径是
    // 「不能复用原来 mcp 的卡片吗？就只改个显示的名字而已」。
    final label = isSpeech ? '<$name>' : _mcpToolLabel(name, item.toolArgs);
    final args = (item.toolArgs ?? '').trim();
    final result = (item.toolResult ?? '').trim();
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
                        _result(scheme, status, result, folding),
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

  Widget _result(ColorScheme scheme, _ToolStatus status, String result, bool folding) {
    if (item.toolStatus == null) {
      return Text('正在执行…', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant));
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
              item.expanded ? '收起' : '展开全部（${result.length} 字）',
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
/// 为什么名字取不到时不退回 openid：见 [_ChatPageState._chanSenderOf]。
class _ChannelBlock extends StatelessWidget {
  const _ChannelBlock({required this.item, required this.sender, required this.onToggle});

  final _BubbleItem item;
  final String sender;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 识别不出的 chatType 不猜（可能是平台新加的会话类型），退回通道名——通道名恒有。
    // `mentionsMe` 参与判词：群里**没 @ 但喊了她的名字**也叫提及（关键词），而它的事件
    // chatType 是普通的 `group`——只看 chatType 的话，这张卡会写成「群聊消息」，
    // 看起来就像"群里的普通消息直接进了对话流"（用户 2026-10-02 正是这么问的）。
    final category = _chatTypeLabel(item.chatType, mentionsMe: item.mentionsMe)
      ?? _channelFallbackLabel(item.channel);
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
                                _adapterLabel(item.channel),
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
                        // 取不到也**不退回 openid**，见 [_ChatPageState._chanSenderOf]。
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
                              item.expanded ? '收起' : '展开全部（${text.length} 字）',
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
                          '已接收：$sender（${_sidOf(item) ?? item.chatId ?? '—'}）',
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
  const _NoticeCard({required this.item, this.tag = '框架提醒'});

  final _BubbleItem item;

  /// 卡头那枚徽章。**上下文分界复用的就是这张卡**（用户 2026-10-02："回到这边，复用卡片"），
  /// 只换标签——同一套壳、同一宽度、同一位置，不再单独养一套分界组件。
  final String tag;

  /// 注入预警专用：徽章换成危险色，正文上方多一行标题（"外部消息里有想指挥她的迹象"）。
  /// 用户 2026-10-02：「注入预警应该更醒目，用危险的颜色」——它是这一列里唯一一件
  /// **框架替她留意到的事**，与"她说了什么/别人说了什么"不是一个量级。
  bool get _isInjection => tag == '注入预警';

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
      key: ValueKey(switch (tag) {
        '框架提醒' => 'notice-card',
        '注入预警' => 'injection-card',
        _ => 'boundary-card',
      }),
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

/// 别名取不到时写什么。**不写 openid**：见 [_ChatPageState._chanSenderOf]。
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
              _ChannelBadge(text: '群聊提及', tone: scheme.primary),
              const Spacer(),
              if (item.ts != null)
                Text(_hhmm(item.ts!),
                    style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(height: 5),
          Text('$sender 里有人提到了你',
              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          const SizedBox(height: 5),
          Text(item.text, style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurface)),
          if (talking.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('那边在聊：$talking',
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
String? _chatTypeLabel(String? chatType, {bool mentionsMe = false}) {
  switch (chatType) {
    case 'c2c':
      return '单聊消息';
    case 'group-at':
      return '群聊提及';
    case 'group':
      return mentionsMe ? '群聊提及' : '群聊消息';
    default:
      return null;
  }
}

/// 这条是从**哪扇门**来的（用户 ⑬ 定：`<单聊消息> - QQ 官方bot（或对应消息适配器名称）`）。
///
/// 与 [_channelFallbackLabel] 不是一回事：那个是**会话类型认不出时**的兜底标记
/// （"QQ 消息"），这个是**恒要显示**的适配器名——屏幕上同时可能有两条通道，
/// 光看"单聊消息"分不出是哪一条送来的。
String _adapterLabel(String? channel) {
  switch (channel) {
    case 'qq-official':
      return 'QQ 官方 Bot';
    case 'onebot':
      return 'OneBot';
    default:
      return channel == null || channel.isEmpty ? '外部通道' : channel;
  }
}

/// 认不出会话类型时的兜底标记：**用通道名说清这条是从哪儿来的**，不编一个具体场景。
///
/// 通道名也认不出（后端加了新通道，或者事件里根本没带）就写「外部消息」——
/// 那时我们确实只知道"它是外面递进来的"。
String _channelFallbackLabel(String? channel) {
  switch (channel) {
    case 'qq-official':
      return 'QQ 消息';
    case 'onebot':
      return 'OneBot 消息';
    default:
      return '外部消息';
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
_ToolStatus _toolStatus(String? status, ColorScheme scheme) {
  switch (status) {
    case null:
      return _ToolStatus(
          color: scheme.primary, icon: Icons.autorenew_rounded, label: '运行中', spinning: true);
    case 'ok':
      return const _ToolStatus(color: IrmiaTheme.ok, icon: Icons.check_rounded, label: '完成');
    case 'error':
      return const _ToolStatus(color: IrmiaTheme.danger, icon: Icons.close_rounded, label: '出错');
    case 'timeout':
      return const _ToolStatus(
          color: IrmiaTheme.warn, icon: Icons.hourglass_bottom_rounded, label: '超时（结果未知）');
    case 'denied':
      return const _ToolStatus(
          color: IrmiaTheme.warn, icon: Icons.shield_outlined, label: '被策略拒绝');
    case 'unknown':
      return const _ToolStatus(
          color: IrmiaTheme.sleep, icon: Icons.help_outline_rounded, label: '结局未知');
    case 'aborted':
      return const _ToolStatus(
          color: IrmiaTheme.sleep, icon: Icons.remove_circle_outline_rounded, label: '未派发');
    case 'over-limit':
      return const _ToolStatus(
          color: IrmiaTheme.warn, icon: Icons.speed_rounded, label: '超出单步上限');
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
  return flat.length > max ? '${flat.substring(0, max)}…' : flat;
}

String _duration(int ms) => ms < 1000 ? '${ms}ms' : '${(ms / 1000).toStringAsFixed(1)}s';

String _hhmm(String iso) {
  final dt = DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return '';
  return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
