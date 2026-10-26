// 本页文案**已经全部**落在 lib/i18n/app_strings.dart（`overview*` 那一族）：页面里不再有
// 中文字面量，`gui/test/copy_coverage_test.dart` 的闸门盯着这件事。加一句话 = 往文案表加一条
// （中英各一处），页面里只许 `IrmiaStrings.of(context).xxx`。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';

import 'package:flutter/material.dart';

import '../app.dart';
import '../format.dart';
// 重启那条路（请求 + 三态判据）与托盘共用一份，见 lib/restart_action.dart 的文件头
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
// 「配置引导」= 请求打开首次引导卡（手动那条通道，不碰首次判据）
import '../onboarding_request.dart';
import '../restart_action.dart';
import '../theme.dart';
// 新写的间距/字号/圆角一律走令牌（本轮新增的「配置引导」按钮就是这么摆的）
import '../theme/design_tokens.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

/// 运行情况页（默认首页）——与 Web 端同构。
/// 状态卡 → **一排三张卡**（今日用量 / 缓存命中率 / 当前上下文构成）→ 建议 →
/// 外部会话 → 框架提示 → 最近事件（默认 8 条）。
///
/// 「外部会话」与「框架提示」两张卡（v33）答的是用户自己的两个问题：
/// **她手边那个软件里攒了多少**（谁来过、她还没看的有几条）、**框架有没有替她留意到什么**
/// （注入预警、告警）。数据分别来自 `GET /api/sessions` 与 `GET /api/framework-notes`，
/// 两张卡**各有自己的三态**——它们读的是附加信息，读不到时该灰的是这张卡，不是整页。
///
/// 「当前上下文构成」那张卡（2026-10-25）答的是第三个问题：**她这一拍的请求有多大、由什么组成**。
/// 数据来自 `GET /api/context/breakdown`（最近一条带 `context` 的 `budget/consumed`），
/// 那根按三组切开的彩色条就是"离压缩线还有多远"的读数。它原来单独占一整行，用户问过
/// 「为什么上下文构成还在这一行？而不是跟用量、命中率在同一行？」之后并进了那一排（见 [_Tiles]）。
///
/// 2026-10-25 三处收敛（用户只留三条）：磁贴回到两枚（「待确认」「连续失败」不画了——那两个数
/// 在「建议」与「最近事件」里各有更该看的地方）、「定时器」整块删掉（与日程页重复，那边有撤销）。
class OverviewPage extends StatefulWidget {
  const OverviewPage({super.key, required this.state});
  final AppState state;

  @override
  State<OverviewPage> createState() => _OverviewPageState();
}

class _OverviewPageState extends State<OverviewPage> {
  Map<String, dynamic>? stats;
  Map<String, dynamic>? proj;
  String? error;
  bool loading = true;

  /// 外部会话（她见过的会话 + 各自的积累）。`null` 有两种含义，靠 [sessionsError] 与
  /// [sessionsLoading] 区分：还在读 / 读失败 / 读到了但是空的。
  List<_SessionRow>? sessions;
  String? sessionsError;
  bool sessionsLoading = true;

  /// 框架提示（注入预警 + 告警）。空列表是**常态**，不是异常。
  List<_FrameworkNote>? notes;
  String? notesError;
  bool notesLoading = true;

  /// 当前上下文构成（最近一次真实请求的 input 由哪几组组成）。
  ///
  /// `null` 有两种含义，靠 [breakdownError] 与 [breakdownLoading] 区分：还在读 / 读失败。
  /// 而"读到了、但一次请求都还没有"是 [_ContextBreakdown.empty]——**不是** `null`：
  /// "没有数"与"数是 0"是两件事（见 `src/web/server.ts` 的 `contextBreakdownView`）。
  _ContextBreakdown? breakdown;
  String? breakdownError;
  bool breakdownLoading = true;

  /// 读「外部会话」的那条轮询（2026-10-24 用户报的 bug）。
  ///
  /// 为什么必须有一条：这张卡上的未读徽章是**那一刻**的事实（服务端每次请求现折日志，
  /// `GET /api/sessions` → `collectSessions`），而这一页原来只在**进页/下拉/从离线回到在线**
  /// 三种时刻读它一次。她那边 `read_channel` 之后写下的 `channel/read` 已经在日志里了，
  /// 可屏幕上的数字还是她读之前那个——用户看到的就是「读过了，未读标签不消失」，
  /// 而且**页面一直开着不动就永远不变**（"直到再次有未读消息"那句话的由来）。
  ///
  /// 间隔取 15 秒（与消息适配器页那条轮询同档）：这个端点是按日志实例缓存的**增量**快照，
  /// 没有新事件时零 IO、零解析，所以刷新它的代价只有一次本地 HTTP；而它答的是"她现在还欠
  /// 多少没看"，慢于十几秒的读数就没有意义了。
  Timer? _sessionsPoll;

  /// 死信动作（重投 / 丢弃）上一次失败的原因。
  ///
  /// 为什么留在页面上而不是只弹一条 toast：toast 四秒就没了，而人真正需要读到的是
  /// **为什么没成**（"seq 42 不在死信队列里"这种话得能对着卡再看一眼）。成功之后
  /// 重新读页面时它自己清掉。
  String? deadActionError;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChange);
    unawaited(load());
    // 进页就读一次（`load()` 里已经带了），之后每 `_sessionsPollEvery` 再读一次：
    // 她读没读那个群，只有这条轮询能把"未读从 X 变 0"送到屏幕上（见 `_sessionsPoll` 的注释）。
    _sessionsPoll = Timer.periodic(_sessionsPollEvery, (_) => unawaited(_loadSessions(silent: true)));
  }

  @override
  void dispose() {
    _sessionsPoll?.cancel();
    _sessionsPoll = null;
    widget.state.removeListener(_onStateChange);
    super.dispose();
  }

  /// 未读徽章那条轮询的间隔（见 `_sessionsPoll`）
  static const Duration _sessionsPollEvery = Duration(seconds: 15);

  void _onStateChange() {
    if (widget.state.online && error != null) unawaited(load());
  }

  Future<void> load() async {
    final api = widget.state.api;
    // 三块附加内容各自吃自己的错（内部 try/catch），但**和主数据一起等**：
    // 下拉刷新等人等的应该是同一件事，而不是主卡先回来、附加卡等一下再跳出来
    final extras = Future.wait([_loadSessions(), _loadNotes(), _loadBreakdown()]);
    try {
      final results = await Future.wait([
        api.get('/api/stats/dashboard'),
        api.get('/api/projection'),
      ]);
      if (mounted) {
        setState(() {
          stats = results[0] is Map<String, dynamic> ? results[0] as Map<String, dynamic> : null;
          proj = results[1] is Map<String, dynamic> ? results[1] as Map<String, dynamic> : null;
          error = null;
          loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          error = err.toString();
          loading = false;
        });
      }
    }
    await extras;
  }

  /// 会话清单：她见过谁、谁那里攒了多少条没看。
  ///
  /// 与 [`/api/stats/dashboard`] 分开取的理由不只是"职责清楚"：这段数据变了不影响状态卡，
  /// 而读失败时**只有这张卡**该灰（卡片自己的三态），整页照常可用。
  ///
  /// `silent` = 轮询发起的那一次（2026-10-24）：不进 loading 态、失败也不把已经读到的行换成
  /// 红字——后台刷新把卡片打回三态里的另外两态，比数字晚十几秒难看得多。人按的「重试」与
  /// 进页那一次照旧走完整三态（`silent: false`）。
  Future<void> _loadSessions({bool silent = false}) async {
    if (mounted && !silent) setState(() => sessionsLoading = true);
    try {
      final data = await widget.state.api.get('/api/sessions');
      final list = data is Map ? data['sessions'] : null;
      if (!mounted) return;
      // 非对象/缺字段当"读失败"而不是"没有会话"：说"没有"是断言，得先真的读到
      final rows = list is List
          ? [for (final item in list) _SessionRow.from(item)]
          : null;
      if (silent && rows == null) return;
      setState(() {
        sessions = rows;
        sessionsError = rows == null ? IrmiaStrings.of(context).overviewSessionsNotList : null;
        sessionsLoading = false;
      });
    } catch (err) {
      if (!mounted || silent) return;
      setState(() {
        sessionsError = err.toString();
        sessionsLoading = false;
      });
    }
  }

  /// 当前上下文构成：最近一次真实请求的 input 由哪几组、各占多少。
  ///
  /// 与另外两块同一条纪律：读失败**只灰这一块**，整页照常（这一页的主数据是状态与用量）。
  /// 收到 `{empty:true}` 是**读到了**（她还没开口过），不是失败；只有"认不出这份响应"
  /// （不是对象、没有 `total`）才进失败态——那时说"没有请求过"就是撒谎。
  Future<void> _loadBreakdown() async {
    if (mounted) setState(() => breakdownLoading = true);
    try {
      final data = await widget.state.api.get('/api/context/breakdown');
      if (!mounted) return;
      final parsed = _ContextBreakdown.from(data);
      setState(() {
        breakdown = parsed;
        breakdownError = parsed == null ? IrmiaStrings.of(context).overviewContextNotObject : null;
        breakdownLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        breakdownError = err.toString();
        breakdownLoading = false;
      });
    }
  }

  /// 框架提示：注入预警与告警。空数组是常态（没有提示 = 一切都好），照样进空态。
  Future<void> _loadNotes() async {
    if (mounted) setState(() => notesLoading = true);
    try {
      final data = await widget.state.api.get('/api/framework-notes');
      final list = data is Map ? data['notes'] : null;
      if (!mounted) return;
      setState(() {
        notes = list is List ? [for (final item in list) _FrameworkNote.from(item)] : null;
        notesError = notes == null ? IrmiaStrings.of(context).overviewNotesNotList : null;
        notesLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        notesError = err.toString();
        notesLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        PageHeader(title: s.navOverview, subtitle: s.overviewSubtitle),
        Expanded(
          child: RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(26, 16, 26, 30),
              children: [
                if (loading) const _Loading() else if (error != null) _ErrorBlock(message: error!, onRetry: load) else ...[
                  _HeroCard(
                    state: widget.state,
                    stats: stats,
                    onRestart: _restart,
                    onConfigGuide: _openConfigGuide,
                    onGoto: _goto,
                  ),
                  if (_reviewItems.isNotEmpty) _ReviewCard(key: _reviewKey, items: _reviewItems, onResolve: _resolve),
                  const SizedBox(height: 16),
                  // 一排三张卡：今日用量 · 缓存命中率 · 当前上下文构成。
                  // 上下文卡原来单独占一整行（`_ContextBoard`），用户 2026-10-25 问
                  // 「为什么上下文构成还在这一行？而不是跟用量、命中率在同一行？」——并进来了。
                  _Tiles(
                    stats: stats,
                    breakdown: breakdown,
                    breakdownError: breakdownError,
                    breakdownLoading: breakdownLoading,
                    onRetryBreakdown: _loadBreakdown,
                  ),
                  if (_advice.isNotEmpty) ...[
                    const SizedBox(height: 18),
                    _SectionTitle(IrmiaStrings.of(context).overviewSectionAdvice),
                    CappedChildren(children: [for (final item in _advice) _adviceCardFor(item)]),
                  ],
                  const SizedBox(height: 16),
                  _ExternalSessionsCard(
                    sessions: sessions,
                    error: sessionsError,
                    loading: sessionsLoading,
                    onRetry: _loadSessions,
                  ),
                  const SizedBox(height: 16),
                  _FrameworkNotesCard(
                    notes: notes,
                    error: notesError,
                    loading: notesLoading,
                    onRetry: _loadNotes,
                  ),
                  const SizedBox(height: 18),
                  _SectionTitle(IrmiaStrings.of(context).overviewSectionRecent),
                  _RecentList(stats: stats, onWake: () => unawaited(_restart())),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  List<Map<String, dynamic>> get _reviewItems {
    final raw = proj?['needsReview'];
    if (raw is! List) return const [];
    return raw.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();
  }

  /// 建议清单（服务端 `DashboardView.suggestions`，结构见 src/web/server.ts:549）。
  List<_Advice> get _advice {
    final out = <_Advice>[];
    final list = stats?['suggestions'];
    if (list is List) {
      for (final s in list.whereType<Map>()) {
        final item = _Advice.from(s);
        if (item.title.isNotEmpty) out.add(item);
      }
    }
    if (stats?['personaIsSeed'] == true) {
      out.add(_Advice(
        id: 'persona-seed',
        title: IrmiaStrings.of(context).overviewPersonaSeedAdvice,
      ));
    }
    return out;
  }

  /// 待确认那张卡的锚点：`goto-review` 的落点就在**本页**（`_ReviewCard` 就在建议上面），
  /// 所以那个动作不是"切页"，而是把那张卡滚进视野。
  final _reviewKey = GlobalKey();

  /// 一张建议卡：把 `act` 翻成一个能按的动作，并把死信那条的两颗按钮接上。
  ///
  /// 三个口径：
  ///   · **认不出的 act 一颗按钮都不摆**（老服务端、或将来新增的动作）：摆一颗不知道去哪儿的
  ///     按钮比不摆更糟；
  ///   · 死信那条**不摆 act 按钮**：它自己有「重投 / 丢弃」两颗按条决定的按钮，服务端给它
  ///     的 `goto-review` 是"去待确认区"的意思，与那两颗按钮挤在同一张卡上只会让人点错；
  ///   · 卡面点击 = 同一个动作；**没有 act 的条目保持老行为**（去人格配置）。
  Widget _adviceCardFor(_Advice item) {
    final act = _actionFor(item);
    final isDeadLetters = item.id == _AdviceCard.kDeadLettersId;
    return _AdviceCard(
      key: ValueKey('advice-${item.id}'),
      advice: item,
      // 死信明细来自投影（`inputSeq` 的唯一来源，见 [_deadLetters]）；
      // 其余几条用不上，传空就是不改样子的老卡片
      deadLetters: _deadLetters,
      error: deadActionError,
      onRequeue: (seq) => unawaited(_requeue(seq)),
      onDiscard: (seq) => unawaited(_discard(seq)),
      onAct: isDeadLetters ? null : act,
      // 死信那条自己有按钮 ⇒ 整卡不再是链接：正在瞄"重投"却点到卡面
      // 会被带去别处（其余几条的卡面点击与它那颗按钮同一个去处）
      onTap: isDeadLetters ? null : (act ?? () => _goto('persona')),
    );
  }

  /// `Suggestion.act` → 动作。四个 id 与服务端的 `buildSuggestions` 一一对应
  /// （src/web/server.ts 的 `Suggestion.act` 注释里逐字写着这四个）。
  ///
  /// 四个去处都在既有页面上，**没有为它新开页面**：
  ///   · `goto-review` → 本页的待确认卡（滚过去）；
  ///   · `open-budget` → 日志页（它的第一个 tab「概览」就是预算面板，见 logs_page.dart:28）；
  ///   · `goto-tools`  → 扩展页的「工具」分组（落点提示走 `AppState.setPage` 的 section）；
  ///   · `goto-persona`→ 人格配置页。
  VoidCallback? _actionFor(_Advice advice) {
    switch (advice.act) {
      case 'goto-review':
        return _gotoReview;
      case 'open-budget':
        return () => _goto('logs');
      case 'goto-tools':
        return () => widget.state.setPage('extensions', section: 'tools');
      case 'goto-persona':
        return () => _goto('persona');
      default:
        return null;
    }
  }

  /// 把待确认卡滚进视野。卡不在（`needsReview` 为空）时**如实说一句**，不假装跳过去了。
  void _gotoReview() {
    final target = _reviewKey.currentContext;
    if (target == null) {
      IrmiaToast.show(context, IrmiaStrings.of(context).overviewNoPendingCalls, kind: ToastKind.info);
      return;
    }
    unawaited(Scrollable.ensureVisible(target, duration: IrmiaTheme.durCard, alignment: 0.08));
  }

  /// 死信明细（`{inputSeq, claimCount, at}`），来自 `GET /api/projection`——本页为了磁贴与
  /// 「待确认」本来就在取它（见 [load]）。
  ///
  /// **`inputSeq` 只能从这里来**：服务端那条建议（`Suggestion`）只有 id / level / title /
  /// body / act，**不带 seq**；而投影里的 `deadLetters[]` 正是折叠结果，`requeue` 与
  /// `discard` 要的就是它。所以这一页拿得到 seq——不必让服务端在建议里再塞一个字段，
  /// 更不必猜一个写死的号。
  ///
  /// 认不出 seq 的条目一律丢掉：按钮得有一个**确定**的号才敢发（见 `_AdviceCard._deadRows`）。
  List<_DeadLetter> get _deadLetters {
    final raw = proj?['deadLetters'];
    if (raw is! List) return const [];
    final out = <_DeadLetter>[];
    for (final item in raw.whereType<Map>()) {
      final dead = _DeadLetter.from(item);
      if (dead.seq > 0) out.add(dead);
    }
    return out;
  }

  /// **重启前后端**（用户 2026-10-04：原来这里是"立即唤醒"，那个功能已经没用了）。
  ///
  /// 2026-10-17 起：请求与判据都在 `lib/restart_action.dart`——**与托盘那一项走同一个函数、
  /// 同一套三态**（改之前两条路一套严一套松，现场与根因见那个文件的文件头）。
  ///
  /// 这里只负责两件界面上的事：把话接到 toast 上、把"她回来了没有"接到 `state.online` 上。
  /// 其余（发哪个请求、什么算成功、等多久、等不到说什么）一律不在本页判断——
  /// 同一件事有两份判据，迟早会有两种说法，而这个坑刚刚才踩过。
  Future<void> _restart() async {
    final strings = IrmiaStrings.read(context);
    await performRestart(
      api: widget.state.api,
      strings: strings,
      say: (message, kind) {
        if (!mounted) return;
        IrmiaToast.show(context, message, kind: kind);
      },
      online: () => widget.state.online,
      alive: () => mounted,
    );
  }

  /// **配置引导**（用户 2026-10-17 ③）：把首次引导那张卡**手动**打开一次。
  ///
  /// 走 `onboarding_request.dart` 那条通道：卡是顶层的东西（`OnboardingHost` 包住整个壳），
  /// 本页只发一个"请打开"的请求。手动打开**不碰** `onboarding-done` 那个首次判据
  /// （见 `onboarding.dart` 的 `_openManually`），所以随时开、随时关，不会把
  /// "第一次启动该弹一次"这件事消费掉，也不会改动任何现有配置（卡里没改过就不写盘）。
  void _openConfigGuide() => requestOnboarding();

  Future<void> _resolve(String callId, String outcome) async {
    try {
      await widget.state.api.post('/api/commands/review-resolve', {
        'callId': callId,
        'outcome': outcome,
        'note': '',
      });
      await load();
    } catch (err) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(IrmiaStrings.of(context).overviewMarkFailedToast('$err'))));
      }
    }
  }

  // ──────────────── 死信队列上那两颗按钮（重投 / 丢弃） ────────────────
  //
  // 这一对是用户 2026-10-05 卡住的那件事：建议卡写着"需要人工决定重投还是丢弃"，
  // 而界面上既没有重投也没有丢弃（他的原话："我在哪里重投？"）。服务端两条命令都已经在
  // 那条通道上（`requeue` 见 src/web/server.ts:3663），界面这边过去只是**没把它们摆出来**。

  /// 重投一条死信 → `POST /api/commands/requeue {inputSeq}`（认领计数由服务端归零）。
  Future<void> _requeue(int inputSeq) => _deadAction(
        inputSeq: inputSeq,
        verb: IrmiaStrings.of(context).overviewDeadRequeue,
        path: '/api/commands/requeue',
        done: IrmiaStrings.of(context).overviewDeadRequeued(inputSeq),
      );

  /// 丢弃一条死信 → `POST /api/commands/discard {inputSeq}`。
  ///
  /// **不可逆，所以先问一次**。确认文案必须把两件事都说清（设计里"丢"从来不等于"抹掉"）：
  /// 这条输入不会被重投、也不会被执行；而它**仍留在事件日志里**——日志是唯一真相源，
  /// 这个动作只是让它退出待处理。
  Future<void> _discard(int inputSeq) async {
    // 文案在**问之前**取好：`confirm` 之后 `context` 已经跨过 await 了
    final s = IrmiaStrings.read(context);
    final yes = await confirm(
      context,
      title: s.overviewDeadDiscardTitle,
      body: s.overviewDeadDiscardBody(inputSeq),
      confirmLabel: s.overviewDeadDiscardConfirm,
      danger: true,
    );
    if (!yes) return; // 取消 = 什么都没决定：一个请求都不发
    await _deadAction(
      inputSeq: inputSeq,
      verb: s.overviewDeadDiscard,
      path: '/api/commands/discard',
      done: s.overviewDeadDiscarded(inputSeq),
      // 短语 = 命令名（`restart` / `set-key` / `skill-remove` 那族的惯例）。服务端若把
      // `discard` 登记成"不需要短语"（与 requeue 同级：只推进状态、不改能力边界），这个头
      // 会被忽略；登记成需要时正好对上（表允许客户端多声明，见 CONFIRM_PHRASES 的注释）。
      phrase: 'discard',
    );
  }

  /// 死信动作的公共路径：发命令 → 成功就重读这一页（队列空了，那条建议自己消失）+ toast；
  /// 失败**留在卡上**（toast 会自己消失，而"为什么没成"得能对着卡再读一遍）。
  Future<void> _deadAction({
    required int inputSeq,
    required String verb,
    required String path,
    required String done,
    String? phrase,
  }) async {
    if (mounted) setState(() => deadActionError = null);
    try {
      await widget.state.api.post(path, {'inputSeq': inputSeq}, confirm: phrase);
      if (!mounted) return;
      IrmiaToast.show(context, done, kind: ToastKind.success);
      await load();
    } catch (err) {
      if (!mounted) return;
      setState(() => deadActionError =
          IrmiaStrings.of(context).overviewDeadActionFailed(verb, inputSeq, '$err'));
      IrmiaToast.show(context, IrmiaStrings.of(context).overviewDeadActionToastFailed(verb, '$err'),
          kind: ToastKind.error);
    }
  }

  void _goto(String pageId) => widget.state.setPage(pageId);
}

class _Loading extends StatelessWidget {
  const _Loading();
  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator()),
      );
}

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.message, required this.onRetry});
  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(IrmiaStrings.of(context).overviewLoadFailedTitle, style: TextStyle(color: IrmiaTheme.danger, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          Text(message, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: () => unawaited(onRetry()),
            child: Text(IrmiaStrings.of(context).retry),
          ),
        ],
      ),
    );
  }
}

class _HeroCard extends StatelessWidget {
  const _HeroCard({
    required this.state,
    required this.stats,
    required this.onRestart,
    required this.onConfigGuide,
    required this.onGoto,
  });
  final AppState state;
  final Map<String, dynamic>? stats;
  final Future<void> Function() onRestart;

  /// 「配置引导」：打开首次引导卡（`OnboardingHost` 那张），可随时关掉
  final VoidCallback onConfigGuide;

  final void Function(String pageId) onGoto;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Row(
        children: [
          // 只放 IRMIA 图案本身（原先是 64 的「圆角底块 + 字形」）。
          // 收到 48：这张卡里 64 的方块偏大，而图案没有底色块托着，同尺寸会比方块显得更满；
          // Row 是居中对齐，右边的文字块与「重启前后端」按钮位置不受影响。
          const BrandMark(size: 48),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 状态词与旁注都**照抄服务端**：
                //   · `stateText` 说当刻在干什么（判据一处，见 src/web/server.ts 的 deriveState）；
                //   · `stateNote` 说"曾经耗尽、现已恢复"这类**已经过去的那件事的下文**。
                // 界面过去自己按 `paused` 拼"已暂停（预算耗尽）"，而那时候她早就跑起来了
                // （用户 2026-10-05 报的假话）。现在这里一个字都不推断。
                Text(state.stateText,
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w600)),
                if (state.stateNote.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Icon(Icons.history_rounded, size: 14, color: scheme.onSurfaceVariant),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(state.stateNote,
                            style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 4),
                Text(state.subText, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          // 两颗按钮：左边「配置引导」（次要动作，描边），右边「重启前后端」（主行动，填充）。
          // 位置照用户 ③ 的原话："重启前后端按钮旁边"。
          //
          // 间距/圆角走 design_tokens（[Space.x2] / [Shape.radiusControl] / [Type.caption]），
          // 不写魔法数字：这一排按钮将来在别的卡片里复用时不至于又各差 1px。
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              OutlinedButton.icon(
                key: const ValueKey('overview-config-guide'),
                onPressed: onConfigGuide,
                icon: const Icon(Icons.school_outlined, size: 16),
                label: Text(IrmiaStrings.of(context).overviewConfigGuide),
                style: OutlinedButton.styleFrom(
                  // 与旁边那颗同一条圆角与内边距规矩。
                  // ⚠ 这里**不许**写 `textStyle:`（`test/button_typography_test.dart` 锁着）：
                  // ButtonStyle.textStyle 不与上下文合并，页面里写一次就让按钮落到兜底字体，
                  // 同一个界面出现两种字形。字号归主题（IrmiaTheme 的 buttonText）管。
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(Shape.radiusControl),
                  ),
                  padding: const EdgeInsets.symmetric(
                    horizontal: Space.x3,
                    vertical: Space.x2,
                  ),
                ),
              ),
              const SizedBox(width: Space.x2),
              FilledButton(
                onPressed: () => unawaited(onRestart()),
                child: Text(IrmiaStrings.of(context).trayRestart),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({super.key, required this.items, required this.onResolve});
  final List<Map<String, dynamic>> items;
  final void Function(String callId, String outcome) onResolve;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(top: 16),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 8),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.warn),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(IrmiaStrings.of(context).overviewPendingCount(items.length),
              style: const TextStyle(color: IrmiaTheme.warn, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          for (final item in items.take(3))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(item['name']?.toString() ?? item['callId']?.toString() ?? '?',
                            style: const TextStyle(fontWeight: FontWeight.w500)),
                        Text(AppState.hhmm(item['at']?.toString() ?? ''),
                            style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                      ],
                    ),
                  ),
                  TextButton(
                    onPressed: () => onResolve(item['callId']?.toString() ?? '', 'succeeded'),
                    child: Text(IrmiaStrings.of(context).overviewMarkSucceeded),
                  ),
                  TextButton(
                    style: TextButton.styleFrom(foregroundColor: IrmiaTheme.danger),
                    onPressed: () => onResolve(item['callId']?.toString() ?? '', 'failed'),
                    child: Text(IrmiaStrings.of(context).overviewMarkFailed),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// **一排三张卡**：今日用量 · 缓存命中率 · 当前上下文构成。
///
/// 2026-10-25 的两次改法都记在这里，免得下一次又"为什么它单独一行"：
///   · 先只留两枚磁贴——「待确认」与「连续失败」两张恒为 0 的 0 值指标卡删掉了。
///     `tiles.pending` / `tiles.failStreak` 两个**数据字段照旧存在**（服务端还在给、
///     别处也还在用），只是这一页不再画它们；
///   · 然后用户问「为什么上下文构成还在这一行？而不是跟用量、命中率在同一行？」
///     —— 原来单独占一整块全宽的上下文看板，现在就是这一排的**第三张卡**
///     （[_ContextTile]，同一个外壳 [_TileShell]、同一圈内边距、同一排的同一高度）。
///
/// **宽度 1 : 1 : 1 —— 三张等宽**（用户 2026-10-25 深夜的最后一版：
///   > 「算了。改成三个卡片等宽吧」）
/// 上一版是 1 : 1 : 2（上下文卡占两格，因为它有三色条 + 三片图例）；收成一格之后，
/// 这张卡挤的时候**按它自己那两条既有规矩收**（图例先砍读数里的 tokens、标签行先让总量，
/// 见 [_ContextTile] 的"挤的时候先动哪里"）——整排的两条缝与三张等宽不变，谁也不单独加宽。
///
/// **高度锚在用量卡的自然高度上**（H = [_tokensTileHeight]）：三张卡的高度**都是 H**，
/// 而 H 只由用量卡的内容决定（主数字 / 标签行 / 折线 / 内边距）。
///
/// 这一条是 2026-10-25 深夜用户打回来的第二次：
///   > 「不对，变太高了。高度还得是原来的。用量、命中率的那个高度」
/// 上一版用 [IntrinsicHeight] 取"三张里最高的那张"，而上下文卡比用量卡多两块东西
/// （三色条 + 一行图例），于是整排被它撑到 189——用量卡与命中率的下半张全是空白。
/// 现在反过来：**先算出用量卡单独渲染时的高度**，把整排 `SizedBox(height: H)` 钉死，
/// 上下文卡的内容自己往这个高度里压（压不进的取舍见 [_ContextTile] 的类注释）。
///
/// 2026-10-25 深夜第五次之后，上下文卡与另两张**同构**（大数字在顶、条与图例贴底），
/// 它压进 H 只剩 1px 余量——那笔账在 [_tokensTileHeight] 的注释里，改字号前先读它。
///
/// 窄窗（内容宽 < [oneRowMinWidth]）折成两行：第一行两张磁贴、第二行上下文卡占满整行，
/// **两行的高度也是 H**（同一棵树里算一次，两行共用）。判据用**内容宽**
/// （`ListView` 扣掉左右各 26 之后那条线）而不是窗口宽——判据与版面是同一个数，
/// 将来改页面留白，折点不会跟着漂。
///
/// 三个 `ValueKey`（`overview-tile-tokens` / `overview-tile-cache` /
/// `overview-tile-context`）与行键 `overview-tiles-row` 是给用例钉版式用的：
/// 数 `_Tile` 的个数、验每张卡的位置与宽度、验上下文卡**在这一排里**而不是另起一整行，
/// 以及验**三张卡的高度都等于用量卡的自然高度 H**（±1px）。
class _Tiles extends StatelessWidget {
  const _Tiles({
    required this.stats,
    required this.breakdown,
    required this.breakdownError,
    required this.breakdownLoading,
    required this.onRetryBreakdown,
  });

  final Map<String, dynamic>? stats;

  /// 「当前上下文构成」那份读数（与另外两张卡同一条纪律：读失败只灰这一张）
  final _ContextBreakdown? breakdown;
  final String? breakdownError;
  final bool breakdownLoading;
  final Future<void> Function() onRetryBreakdown;

  /// 三张卡的键：用例按它们定位"这一排的第几张"
  static const Key tokensTileKey = ValueKey('overview-tile-tokens');
  static const Key cacheTileKey = ValueKey('overview-tile-cache');
  static const Key contextTileKey = ValueKey('overview-tile-context');

  /// 这一排的槽（宽窗三张一行、窄窗第一行两张）：上下文卡必须落在它里面
  static const Key rowKey = ValueKey('overview-tiles-row');

  /// 一行三卡的最小**内容宽**：再窄就折成两行（这张卡的判据一个字没动，三卡等宽之后
  /// 它只是把"一格有多宽"从 1/4 换成 1/3）。
  ///
  /// 内容宽 1000 时一张卡 = (1000 − 24) / 3 ≈ 325：上下文卡的内容区 291，三片图例各 92、
  /// 片里能放字的地方 76——刚好是"组名 + 占比"（tokens 那半截在 1/3 宽里放不下，按既有
  /// 规矩退掉，见 [_ContextLegend]）。再窄就该折成两行第二行占满整行了。
  static const double oneRowMinWidth = 1000;

  /// 卡与卡之间的缝（与页面其它"两张卡并排"的地方同档）
  static const double gap = Space.x3;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final budget = stats?['budget'] as Map<String, dynamic>? ?? const {};
    final tiles = stats?['tiles'] as Map<String, dynamic>? ?? const {};
    final hourly = (stats?['hourly'] as List?) ?? const [];

    final tokens = (budget['tokensToday'] as num?)?.toInt() ?? 0;
    final rate = tiles['cacheHitRate'];

    final tokenSeries = hourly
        .whereType<Map>()
        .map((h) => ((h['tokens'] as num?) ?? 0).toDouble())
        .toList();
    final hitSeries = hourly.whereType<Map>().map((h) {
      final hit = ((h['hit'] as num?) ?? 0).toDouble();
      final miss = ((h['miss'] as num?) ?? 0).toDouble();
      final sum = hit + miss;
      return sum == 0 ? 0.0 : hit / sum;
    }).toList();

    final tokensTile = _Tile(
      key: tokensTileKey,
      // 数字走**唯一那一处**格式化（`format.dart`，与 src/format/units.ts 逐字镜像）：
      // 2705946 在这里与日志页都是 `2.7M`。过去这一行是内联三目（只会 k），
      // 与日志页的 `_num()` 各写一遍——用户报的"同一个数两种写法"就是这么来的。
      value: formatCompact(tokens),
      // 卡面印紧凑写法、悬停给真数：`2705.9k` 那种写法既不统一、也没解决"看不到真数"
      tooltip: s.overviewTodayUsageTooltip(budgetTokensTooltip(tokens)),
      label: s.overviewTodayUsage,
      metric: kBudgetMetricLabel,
      series: tokenSeries,
    );
    final cacheTile = _Tile(
      key: cacheTileKey,
      value: rate == null ? '–' : '${((rate as num) * 100).round()}%',
      label: s.overviewCacheHitRate,
      series: hitSeries,
    );
    final contextTile = _ContextTile(
      key: contextTileKey,
      data: breakdown,
      error: breakdownError,
      loading: breakdownLoading,
      onRetry: onRetryBreakdown,
    );

    return LayoutBuilder(
      builder: (context, constraints) {
        // 一行几张：宽窗三张、窄窗两行。这一条判据同时给出"一张磁贴有多宽"，
        // 而 H 只跟这个宽度有关（量的是同一棵树、同一条宽里的文字）。
        final oneRow = constraints.maxWidth >= oneRowMinWidth;
        final tileWidth = oneRow
            // 三张 + 两条缝：1 : 1 : 1 ⇒ 一格 = 自由空间 / 3（三卡等宽）
            ? (constraints.maxWidth - gap * 2) / 3
            // 两张 + 一条缝：各占一半
            : (constraints.maxWidth - gap) / 2;
        // **这一排的高度只由用量卡决定**（见类注释）：从容器的宽度算出卡宽，
        // 再按那一宽算出用量卡的自然高度。三张卡都在这个高度里，谁也不许撑破它。
        final height = _tokensTileHeight(context, tileWidth);

        if (oneRow) {
          return SizedBox(
            height: height,
            child: Row(
              key: rowKey,
              // stretch ⇔ 三张都拿到**紧的**高度 = height（不等高就露馅在这一个参数上）
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(flex: 1, child: tokensTile),
                const SizedBox(width: gap),
                Expanded(flex: 1, child: cacheTile),
                const SizedBox(width: gap),
                // 三张等宽：这一处不许再是 2（1 : 1 : 2 的旧关系已由用户改掉）
                Expanded(flex: 1, child: contextTile),
              ],
            ),
          );
        }
        // 窄窗：两张磁贴一行（等高 = H），上下文卡换行后**占满整行、高度照样是 H**
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: height,
              child: Row(
                key: rowKey,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Expanded(flex: 1, child: tokensTile),
                  const SizedBox(width: gap),
                  Expanded(flex: 1, child: cacheTile),
                ],
              ),
            ),
            const SizedBox(height: gap),
            SizedBox(height: height, child: contextTile),
          ],
        );
      },
    );
  }
}

/// 三张卡共用的外壳：同一圈圆角、同一道细边、同一层发丝影、同一个内边距。
///
/// 三张并排时，任何一张自己描一遍 chrome 都会立刻显出"它不是这一组的"——
/// 所以外壳只有这一处，[_Tile] 与 [_ContextTile] 都从它长出来。
class _TileShell extends StatelessWidget {
  const _TileShell({required this.child, this.clipBehavior = Clip.none});

  final Widget child;

  /// 折线那张卡传 [Clip.antiAlias]：按**卡片自己的形状**裁，
  /// 于是"线只在卡里"是结构上成立的，不靠"它现在恰好没越界"。
  final Clip clipBehavior;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(Space.x4),
      clipBehavior: clipBehavior,
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: child,
    );
  }
}

/// 磁贴的版式数字：**算高度**（[_tokensTileHeight]）与**画卡片**（[_Tile]）共用这一份。
///
/// 为什么非抽出来不可：整排的高度锚在用量卡的自然高度上（见 [_Tiles]），而那个数只能在
/// build 时算——"算的那一份"与"画的那一份"各写一遍，改一个小数就又是一条黄黑条
/// （算小了 1px 就是 overflow）。这里只放数字，样式在 [_tileValueStyle] 那三个函数里。
abstract final class _TileMetrics {
  /// 卡片内边距（[_TileShell] 的 `EdgeInsets.all`）
  static const double pad = Space.x4;

  /// 外壳那圈细边：`Container` 会把 `BoxDecoration` 的边**算进内边距**，
  /// 所以卡片内容可用高度 = 卡高 − 2 × ([pad] + [border])
  static const double border = 1;

  /// 上下两份内边距 + 细边（卡片内容以外固定的那部分高度）
  static const double chrome = (pad + border) * 2;

  /// 主数字字号（三张卡同一个数、同一档字重 —— 用户要"扫过去读数在一条线上"）
  static const double valueSize = 26;

  /// 主数字与标签行之间的缝
  static const double valueGap = 2;

  /// 标签行字号
  static const double labelSize = 12;

  /// 口径词字号（只有"这个数计入预算"的磁贴才有，比标签再小一档）
  static const double metricSize = 10.5;

  /// 标签与口径词之间的缝
  static const double metricGap = 6;

  /// 标签行与折线之间的缝
  static const double sparkGap = 8;

  /// 折线那一格的高度
  static const double sparkHeight = 24;
}

/// 主数字那一行的样式：26 / w600 / 等宽数字（三张卡**必须**是同一份）
TextStyle _tileValueStyle() => const TextStyle(
      fontSize: _TileMetrics.valueSize,
      fontWeight: FontWeight.w600,
      fontFeatures: [FontFeature.tabularFigures()],
    );

/// 标签行那一行小字：12 / 次要色
TextStyle _tileLabelStyle(Color color) => TextStyle(fontSize: _TileMetrics.labelSize, color: color);

/// 口径词：比标签再小一档、再淡一点
TextStyle _tileMetricStyle(Color color) =>
    TextStyle(fontSize: _TileMetrics.metricSize, color: color.withValues(alpha: 0.85));

/// 「已用 / 压缩线」那一格：11.5 / 等宽数字（数字对齐不跳）。
///
/// 2026-10-25 深夜从上下文卡的第二行挪到**标题行右侧**（用户："上下文卡里那两个都去掉"——
/// 去掉的是主数字与底部副行，这一格留着）：主数字一走，"用了多少 / 压缩线多少"成了这张卡
/// 最该一直在眼前的一个数，跟标题共用一行最省地方。
TextStyle _contextTotalStyle(Color color) => TextStyle(
      fontSize: 11.5,
      fontFamily: 'monospace',
      color: color,
      fontFeatures: const [FontFeature.tabularFigures()],
    );

/// 一行文案在**当前字体栈 / 当前文字缩放**下的自然宽度（不折行）。
///
/// 图例要不要把读数里的 tokens 砍掉，靠这个数与片宽比——**量出来的**，不是拍一个像素阈值。
double _textWidth(BuildContext context, String text, TextStyle style) {
  final painter = _measure(context, text, style, maxLines: 1)..layout();
  final width = painter.width;
  painter.dispose();
  return width;
}

/// 一行文案在**当前字体栈 / 当前文字缩放**下的高度（按 [maxWidth] 折行，折几行算几行）。
///
/// [TextPainter] 与 `Text`（[RenderParagraph]）走的是同一套段落布局，所以这个数与屏幕上
/// 排出来的高度是同一个——测试机的 FlutterTest、真机的雅黑，各按各的度量出数，不写死像素。
double _textHeight(BuildContext context, String text, TextStyle style, {required double maxWidth}) {
  final painter = _measure(context, text, style)..layout(maxWidth: maxWidth);
  final height = painter.height;
  painter.dispose();
  return height;
}

/// 量文案用的段落：样式与 `Text.build` 同一条路（默认样式合并上自己那份）
TextPainter _measure(BuildContext context, String text, TextStyle style, {int? maxLines}) => TextPainter(
      text: TextSpan(text: text, style: DefaultTextStyle.of(context).style.merge(style)),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: maxLines,
    );

/// **用量卡单独渲染时的高度 —— 那一排三张卡的高度锚 H**。
///
/// ```text
/// H = 内边距 16 + 细边 1          ← 上
///   + 主数字 26 那一行的高度
///   + 2                           ← 主数字与标签行之间的缝
///   + 标签行（12 与 10.5 取高的那个）
///   + 8                           ← 标签行与折线之间的缝
///   + 24                          ← 折线那一格
///   + 内边距 16 + 细边 1          ← 下
/// ```
///
/// 为什么不交给 `IntrinsicHeight` 去量（那是上一版的写法，被用户打回来了）：它取的是
/// **三张里最高的那张**——上下文卡比用量卡多两块东西（三色条 + 一行图例），整排就被它
/// 撑到 189。H 只能由用量卡这一棵子树决定，所以这里把它**先算出来**，
/// 再用 `SizedBox(height: H)` 把整排钉死（见 [_Tiles]）。
///
/// 三条必须与 [_Tile] 对齐的细节：
///   · 量的是**同一棵树、同一条宽**（[tileWidth] 是三张卡里一张磁贴的宽度）——
///     [TextPainter] 按同一份样式、同一份文字缩放量，换字体这个数跟着换；
///   · 标签行的两条文案各占一半（`Row` 里两个 `Flexible` 平分扣掉那条缝之后的宽度），
///     **按各自那一半宽**量：极窄的窗里它会折行，折几行就占几行高；
///   · 折线那 [24] **无条件计入**：这一排的高度不该跟着"有没有 24h 数据"上下跳。
///     没数据时那张卡下面空着一格，比整排突然矮一截好（也不会把上下文卡压扁）。
///
/// **上下文卡也压得进这个 H**（2026-10-25 深夜第五次，它的构图改成与另两张同构之后，
/// 见 [_ContextTile] 的类注释）。行高 = 字号 × 22/14，引擎按**整数像素**排行高
/// （26 → 41、12 → 19、11 → 17，实测；`height` 由主题钉死，与字体无关）：
/// ```text
/// 上块：主数字 26 那一行 41 + 缝 2 + 标签行 19（= 12 号字）            = 62
/// 下块：8px 条 + 缝 6 + 图例一行 17（= 11 号字）                      = 31
/// 合计 93 ≤ 内容区 94（= H − 34）⇒ `Spacer` 还剩 **1px**
/// ```
/// **只剩 1px**：这三块里任何一块再长一丁点（字号、缝、图例行高）都会撞上 H。
/// 改这两张卡的字号/缝之前，先按上面那串加一遍。
double _tokensTileHeight(BuildContext context, double tileWidth) {
  final s = IrmiaStrings.of(context);
  final variant = Theme.of(context).colorScheme.onSurfaceVariant;
  final inner = tileWidth - _TileMetrics.chrome;
  // 标签与口径词各占一半：`Row` 里两个 `Flexible` 平分扣掉那条缝之后的宽度
  final half = (inner - _TileMetrics.metricGap) / 2;
  final labelHeight = _textHeight(context, s.overviewTodayUsage, _tileLabelStyle(variant), maxWidth: half);
  final metricHeight = _textHeight(context, kBudgetMetricLabel, _tileMetricStyle(variant), maxWidth: half);
  // 主数字那一行只有一行，高度只跟字号有关：拿一个数字量就够（内容长短不影响行高）
  final valueHeight = _textHeight(context, '0', _tileValueStyle(), maxWidth: inner);
  return _TileMetrics.chrome +
      valueHeight +
      _TileMetrics.valueGap +
      (labelHeight > metricHeight ? labelHeight : metricHeight) +
      _TileMetrics.sparkGap +
      _TileMetrics.sparkHeight;
}

/// 一张磁贴：**主数字 → 标签行 → 24h 折线**。三张卡的第一、二行都按这个排。
///
/// 折线那一格**永远留着**（8 的缝 + 24 高），有没有数据都一样：这一张是整排的**高度锚**，
/// 它的高度由 [_tokensTileHeight] 另算一遍——两份必须逐字对齐，见那里的注释。
class _Tile extends StatelessWidget {
  const _Tile({super.key, required this.value, required this.label, this.series, this.metric, this.tooltip});
  final String value;
  final String label;
  final List<double>? series;

  /// 口径词（"非缓存口径"）：**只在"这个数计入预算"的磁贴上出现**——
  /// 待确认、连续失败那些数不是 token，印口径词就是噪音。
  final String? metric;

  /// 悬停给原始精确值（见 [budgetTokensTooltip]）
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tooltip = this.tooltip;
    final metric = this.metric;
    final body = _TileShell(
      // **折线不许画出卡片**（硬约束）：折线画在卡内右下那一格（24 高的 `CustomPaint`）
      // ——一旦哪一版把它撑到卡边、或笔宽越过边界，画出来的线就会压在圆角外面。
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value, style: _tileValueStyle()),
          const SizedBox(height: _TileMetrics.valueGap),
          Row(
            children: [
              Flexible(child: Text(label, style: _tileLabelStyle(scheme.onSurfaceVariant))),
              if (metric != null) ...[
                const SizedBox(width: _TileMetrics.metricGap),
                Flexible(child: Text(metric, style: _tileMetricStyle(scheme.onSurfaceVariant))),
              ],
            ],
          ),
          // 折线那一格**无条件留着**（8 的缝 + 24 高）：这一张是整排的高度锚，H 由它算
          // 出来（[_tokensTileHeight]），所以"有没有 24h 数据"不许改它的高度——否则数据一到
          // 整排就跳一下、上下文卡跟着被压扁。没数据时这一格就是空的。
          const SizedBox(height: _TileMetrics.sparkGap),
          SizedBox(
            height: _TileMetrics.sparkHeight,
            width: double.infinity,
            child: series == null || series!.isEmpty
                ? null
                : CustomPaint(
                    painter: _SparkPainter(values: series!, color: scheme.primary),
                  ),
          ),
        ],
      ),
    );
    // 悬停才出现的真数：鼠标停在磁贴上即可（不用点、不用进日志页去对账）
    return tooltip == null ? body : Tooltip(message: tooltip, child: body);
  }
}

class _SparkPainter extends CustomPainter {
  _SparkPainter({required this.values, required this.color});
  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) => IrmiaTheme.paintSparkline(canvas, size, values, color);

  @override
  bool shouldRepaint(_SparkPainter old) => old.values != values || old.color != color;
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Text(text,
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
    );
  }
}

/// 一条建议：服务端 `Suggestion`（`src/web/server.ts:549`）的界面形态。
///
/// 为什么不再在取值时拼成一句话（原来的 `'$title：$body'`）：建议里的**动作**随后就丢了，
/// 于是"死信队列非空"那条只留下一段正文——人读完只看到"需要人工决定重投还是丢弃"，
/// 界面上却没有那两颗按钮（用户 2026-10-05："我在哪里重投？"）。这里原样留住结构，
/// 由 [_AdviceCard] 决定摆成什么样。
class _Advice {
  const _Advice({
    required this.id,
    required this.title,
    this.body = '',
    this.act = '',
    this.actLabel = '',
  });

  /// 服务端给的稳定标识（如 `dead-letters`）：界面对某一条做特殊渲染时认它，不认正文措辞
  final String id;

  /// 主行（一句话）
  final String title;

  /// 次行（细节与下一步）
  final String body;

  /// 服务端给的**动作 id**（`Suggestion.act`：`goto-review` / `open-budget` / `goto-tools` /
  /// `goto-persona`，见 src/web/server.ts:564 的注释）；空 = 这条建议没有配套动作。
  ///
  /// 为什么要它：服务端一直在产出这两个字段（五处 `push({... act, actLabel})`），而界面从前**只取
  /// id/title/body**——四个动作因此全是死的，"去处理"只能靠人自己去猜去哪一页
  /// （docs/repo-cleanliness-audit.md 总表 D1）。
  final String act;

  /// 按钮上那三个字（`Suggestion.actLabel`，由服务端定，界面不自己编）
  final String actLabel;

  /// 落在卡面上的那一行：`标题：细节`（没有细节时就只有标题）
  String text(AppStrings s) => body.isEmpty ? title : s.overviewAdviceLine(title, body);

  static _Advice from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    String text(String key) => map[key] == null ? '' : '${map[key]}';
    return _Advice(
      id: text('id'),
      title: text('title'),
      body: text('body'),
      act: text('act'),
      actLabel: text('actLabel'),
    );
  }
}

/// 一条死信（`Projection.deadLetters[]`，见 `src/log/types.ts` 与 `src/state/fold.ts`）。
class _DeadLetter {
  const _DeadLetter({required this.seq, required this.claimCount, required this.at});

  /// 那条输入的 seq——**重投与丢弃都发它**（服务端两条命令的载荷都是 `{inputSeq}`）
  final int seq;

  /// 认领了几次才进的死信（默认阈值 3，见 `runtime/recover.ts` 的 MAX_CLAIM_COUNT）
  final int claimCount;

  /// 进死信的时刻（ISO）
  final String at;

  /// 行首一句：`seq 42 · 认领 3 次 · 09-30 03:12`（时刻读不出来就不摆那一段）
  String line(AppStrings s) =>
      s.overviewDeadLetterLine(seq, claimCount, at.isEmpty ? null : _noteStamp(at));

  static _DeadLetter from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    return _DeadLetter(
      seq: (map['inputSeq'] as num?)?.toInt() ?? 0,
      claimCount: (map['claimCount'] as num?)?.toInt() ?? 0,
      at: map['at'] == null ? '' : '${map['at']}',
    );
  }
}

/// 一条建议卡：一行正文 + （死信那条才有的）每条死信两颗按钮。
class _AdviceCard extends StatelessWidget {
  const _AdviceCard({
    super.key,
    required this.advice,
    this.deadLetters = const [],
    this.error,
    this.onRequeue,
    this.onDiscard,
    this.onAct,
    this.onTap,
  });

  final _Advice advice;

  /// 死信明细：只有 `dead-letters` 那条用得上（它是 `inputSeq` 的唯一来源）
  final List<_DeadLetter> deadLetters;

  /// 上一次动作失败的原因；非空就摆在同一张卡上（toast 会自己消失，这句不会）
  final String? error;

  final void Function(int inputSeq)? onRequeue;
  final void Function(int inputSeq)? onDiscard;

  /// 按 `act` 分派的动作（文案取 `actLabel`）；null = 这条没有可做的动作，不摆按钮。
  final VoidCallback? onAct;

  /// 卡面点击的去处；null = 这张卡不是链接（死信那条自己有按钮）
  final VoidCallback? onTap;

  /// 服务端那条建议的 id（`buildSuggestions` 里写死的 `dead-letters`）
  static const kDeadLettersId = 'dead-letters';

  bool get _isDeadLetters => advice.id == kDeadLettersId;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final body = Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(advice.text(IrmiaStrings.of(context)), style: const TextStyle(fontSize: 13.5)),
          if (onAct != null) ...[
            const SizedBox(height: 6),
            // 按钮文案是**服务端给的**（`actLabel`）：四个动作的名字由产出建议的那一侧定，
            // 界面不另起一套措辞（否则同一件事在日志与卡面上会叫两个名字）。
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton(
                key: ValueKey('advice-act-${advice.id}'),
                onPressed: onAct,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  minimumSize: const Size(0, 30),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(advice.actLabel.isEmpty ? IrmiaStrings.of(context).overviewActFallback : advice.actLabel),
              ),
            ),
          ],
          if (_isDeadLetters) ..._deadRows(context),
        ],
      ),
    );
    final onTap = this.onTap;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(10),
        child: onTap == null
            ? body
            : InkWell(
                borderRadius: BorderRadius.circular(10),
                onTap: onTap,
                child: body,
              ),
      ),
    );
  }

  /// 死信那几行：每条死信摆一个 seq 加两颗按钮（**重投** / **丢弃**）。
  ///
  /// 为什么按条摆而不是全卡只有一对按钮：**决定是按条做的**——两条死信可以一条重投、
  /// 一条丢弃，而一对按钮只有一个 seq 可发。明细拿不到时（投影还没回来、或读失败）只给
  /// 一行灰字：宁可说"没读到"，也不摆一颗点了不知道会动哪条的按钮。
  List<Widget> _deadRows(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final rows = <Widget>[];
    if (deadLetters.isEmpty) {
      rows.add(Padding(
        padding: const EdgeInsets.only(top: 6),
        child: HintLine(IrmiaStrings.of(context).overviewDeadLettersUnread),
      ));
    } else {
      for (final dead in deadLetters) {
        rows.add(Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  dead.line(IrmiaStrings.of(context)),
                  style: TextStyle(
                    fontSize: 12,
                    color: scheme.onSurfaceVariant,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
              const SizedBox(width: 8),
              TextButton(
                key: ValueKey('dead-requeue-${dead.seq}'),
                onPressed: onRequeue == null ? null : () => onRequeue!(dead.seq),
                child: Text(IrmiaStrings.of(context).overviewDeadRequeue),
              ),
              TextButton(
                key: ValueKey('dead-discard-${dead.seq}'),
                style: TextButton.styleFrom(foregroundColor: IrmiaTheme.danger),
                onPressed: onDiscard == null ? null : () => onDiscard!(dead.seq),
                child: Text(IrmiaStrings.of(context).overviewDeadDiscard),
              ),
            ],
          ),
        ));
      }
    }
    final error = this.error;
    if (error != null) {
      rows.add(Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.error_outline_rounded, size: 15, color: IrmiaTheme.danger),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                error,
                key: const ValueKey('advice-action-error'),
                style: const TextStyle(fontSize: 12.5, height: 1.5, color: IrmiaTheme.danger),
              ),
            ),
          ],
        ),
      ));
    }
    return rows;
  }
}

// ──────────────────── 外部会话（GET /api/sessions） ────────────────────

/// 一行外部会话。
///
/// 为什么不直接拿 Map 用：这一行有六七处取值（名字、类型、条数、未读、退路用的 openid），
/// 散着写 `s['field']` 时字段改名只会静默变成 null——界面上就是"少了一句话"，
/// 而没人会为此报错（设置页 `_DepEntry` 记过同一条纪律）。
class _SessionRow {
  const _SessionRow({
    required this.sid,
    required this.chatType,
    required this.messages,
    required this.unread,
    required this.name,
    required this.person,
    required this.chatId,
  });

  final String sid;
  final String chatType;

  /// 这个会话里她一共收到过多少条
  final int messages;

  /// 她还没看的条数（0 = 都看过了）
  final int unread;

  /// 人给这个会话起的名字（`config.persona.contacts`）；没起过就是 null
  final String? name;

  /// 最近跟她说话的人（QQ 给的就是 openid）
  final String person;

  /// 会话本身的 id（群里是群的 openid）
  final String chatId;

  static _SessionRow from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    String text(String key) {
      final value = map[key];
      return value == null ? '' : '$value';
    }

    return _SessionRow(
      sid: text('sid'),
      chatType: text('chatType'),
      messages: (map['messages'] as num?)?.toInt() ?? 0,
      unread: (map['unread'] as num?)?.toInt() ?? 0,
      name: text('name').isEmpty ? null : text('name'),
      person: text('person'),
      chatId: text('chatId'),
    );
  }

  String typeLabel(AppStrings s) => _chatTypeLabel(s, chatType);

  bool get isGroup => chatType == 'group' || chatType == 'group-at';

  /// 行首那个名字：人起的名字 > 平台的 openid。
  ///
  /// 群聊退回**会话的 openid**（`chatId`）而不是最后说话的那位：`person` 是"最近发言的人"，
  /// 拿它当群名等于把门牌换成路人（她会以为那个群就是那个人）。单聊两者本来就是同一个 id。
  String displayName(AppStrings s) {
    if (name != null) return name!;
    for (final candidate in isGroup ? [chatId, person, sid] : [person, chatId, sid]) {
      if (candidate.isNotEmpty) return candidate;
    }
    return s.overviewUnknownSession;
  }
}

/// 会话类型显示词：与频道页 `_chatTypes`、`src/channel/sessions.ts` 的 `CHAT_TYPE_LABELS`
/// 同一套词。认不出的类型原样显示——不猜成"群聊"，那会把频道说成群。
String _chatTypeLabel(AppStrings s, String chatType) => switch (chatType) {
      'c2c' => s.overviewChatTypeDirect,
      'group-at' => s.overviewChatTypeGroupAt,
      'group' => s.overviewChatTypeGroup,
      'guild' => s.overviewChatTypeGuild,
      _ => chatType.isEmpty ? s.overviewChatTypeUnknown : chatType,
    };

/// 「外部会话」卡：她有几个群聊 / 几个单聊 / 合计多少条没看，以及每个会话攒了多少。
///
/// 为什么要有它：QQ 改成"她手边一个可以点开的软件"之后，**没叫醒她的消息**（`channel/message`）
/// 只在她那边的会话清单里可见——人在这块屏幕上原先只看得到"有会话"，看不出"她在漏消息"。
class _ExternalSessionsCard extends StatelessWidget {
  const _ExternalSessionsCard({
    required this.sessions,
    required this.error,
    required this.loading,
    required this.onRetry,
  });

  final List<_SessionRow>? sessions;
  final String? error;
  final bool loading;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final list = sessions ?? const <_SessionRow>[];
    final groups = list.where((row) => row.isGroup).length;
    final singles = list.where((row) => row.chatType == 'c2c').length;
    // 认不出的类型单独报一个数，而不是并进"群聊"：数字对不上时人只会怀疑界面
    final others = list.length - groups - singles;
    final unread = list.fold<int>(0, (sum, row) => sum + row.unread);

    return _Card(
      title: IrmiaStrings.of(context).overviewExternalSessions,
      // 用户 ② 指定的文案：只讲这张卡收什么、消息去哪。
      // 这里原先挂着一句接口限制（"官方接口只推单聊与 @ 她的群消息——群里没 @ 的话到不了这里"），
      // 它是**防误读**用的：不写它，"没有积累的消息"会被读成"她都看过了"，而真相可能是那些话
      // 根本没送到（见 docs/review.md「欠账：信箱在 QQ 官方通道下收不到东西」）。用户要求换成
      // 现在这句，所以那条限制目前不在这张卡上出现——它更像是通道的属性，落点记在修订清单 ②。
      //
      // 2026-10-04 改准：原来是"消息**自动**存入信箱"——那也是我们这一侧单方面做不到的一句，
      // 它把"官方 Bot 先把事件推给我们"这个前提说成了自动成立的事实（用户已确认根因就在平台侧的
      // 权限/订阅设置）。改成"推给我们的"——进信箱这件事我们照旧做，推不推照实说是平台的事。
      note: IrmiaStrings.of(context).overviewExternalSessionsNote,
      children: [
        if (loading)
          StateBlock.loading(hint: IrmiaStrings.of(context).overviewExternalSessionsLoading)
        else if (error != null)
          StateBlock.error(
            message: IrmiaStrings.of(context).overviewExternalSessionsError('$error'),
            hint: IrmiaStrings.of(context).overviewExternalSessionsErrorHint,
            onRetry: () => unawaited(onRetry()),
            padding: _inCardBlockPadding,
          )
        else ...[
          Text(
            [
              IrmiaStrings.of(context).overviewGroupsCount(groups),
              IrmiaStrings.of(context).overviewSinglesCount(singles),
              if (others > 0) IrmiaStrings.of(context).overviewOthersCount(others),
              IrmiaStrings.of(context).overviewUnreadTotal(unread),
            ].join(' · '),
            style: TextStyle(
              fontSize: 12,
              color: scheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 10),
          // 一条未读都没有时**不摆那几行**：剩下的会是一屏"来过 N 条"的零信息行，
          // 而安静是常态、不是异常——摘要行已经答了"她有几个群聊"，这里一句灰字收尾。
          //
          // 2026-10-04 改准：光写"没有积累的消息"会被读成"没有消息"或"她都看过了"，
          // 而真相可能是"**根本没送到**"（docs/review.md:934-939 记过这条；现场就是
          // 平台没推非 @ 群消息）。所以把"信箱里是空的"与"要官方 Bot 先推给我们"一起写出来：
          // 这句话的任务是防误读，宁可长一点，也不能让人把"没送到"当成"没有"。
          if (unread == 0)
            _hintLine(IrmiaStrings.of(context).overviewNoAccumulatedMessages)
          else
            CappedChildren(children: [
              for (var i = 0; i < list.length; i += 1) _SessionLine(row: list[i], divider: i > 0),
            ]),
        ],
      ],
    );
  }
}

/// 一行会话：名字 + 类型徽章 + 来过多少条 + 未读徽章。
class _SessionLine extends StatelessWidget {
  const _SessionLine({required this.row, required this.divider});

  final _SessionRow row;
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: divider ? Border(top: BorderSide(color: scheme.outlineVariant)) : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              row.displayName(IrmiaStrings.of(context)),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              // 有未读的行名字加重：徽章在一行末尾，扫一列时先看到的是名字
              style: TextStyle(fontSize: 13.5, fontWeight: row.unread > 0 ? FontWeight.w600 : FontWeight.w500),
            ),
          ),
          const SizedBox(width: 10),
          _Badge(row.typeLabel(IrmiaStrings.of(context)), tone: scheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Text(
            IrmiaStrings.of(context).overviewMessagesSeen(row.messages),
            style: TextStyle(
              fontSize: 11.5,
              color: scheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          // 0 条不摆徽章：0 不是信息，是噪音（摆上去会让每行都挂个橙点，真正有未读的那行就不显眼了）
          if (row.unread > 0) ...[
            const SizedBox(width: 8),
            _Badge(IrmiaStrings.of(context).overviewUnreadBadge(row.unread), tone: IrmiaTheme.warn),
          ],
        ],
      ),
    );
  }
}

// ──────────────────── 框架提示（GET /api/framework-notes） ────────────────────

/// 一条框架提示：注入预警（外部消息里有想指挥她的迹象）、告警，
/// 以及 2026-10-03 起的上下文审计两类（缓存破坏哨兵 / 上下文归因）。
class _FrameworkNote {
  const _FrameworkNote({
    required this.kind,
    required this.label,
    required this.level,
    required this.title,
    required this.reason,
    required this.quotes,
    required this.by,
    required this.fingerprint,
    required this.sid,
    required this.person,
    required this.chatType,
    required this.name,
    required this.at,
    required this.historical,
  });

  /// `injection` / `alarm` / `cache-break` / `context`。
  ///
  /// **原样保留**后端给的值（不再折成 injection|alarm 两态）：多出来的两类要按各自的语义
  /// 决定来源行怎么写，折掉就分不出来了。认不出的值按"框架自身的一条提示"渲染——
  /// 宁可多显示一条，也别把框架做过的事悄悄吞掉。
  final String kind;

  /// 类别词，由后端给（界面不自己维护第二份词表）
  final String label;

  /// `info` / `warn` / `critical`：几种类别共用一套等级，取色只看它
  final String level;

  /// 一句说明
  final String title;

  /// 判定的理由：注入预警是"为什么觉得它想指挥她"；缓存破坏/上下文归因是这一条的事实摘要
  final String reason;

  /// 外部原文里最可疑的几个片段（后端已截断）
  final List<String> quotes;

  /// 判定来自规则还是模型（只有注入预警有）
  final String? by;

  /// 告警指纹（只有告警有；排障时拿它对上告警目录）
  final String? fingerprint;

  final String sid;
  final String person;
  final String chatType;
  final String? name;
  final String at;

  /// **这一条是历史**（它后来被一条"已恢复"销掉了）。
  ///
  /// 判据来自服务端：`/api/framework-notes` 按 `alarm/sent` 上的 `key` 把"报警"与"已恢复"
  /// 配了对，配上的那条带 `recovered` + `historical`（见 `web/server.ts` 的
  /// `pairedRecoveries`）。界面**不推断**——不跟后续事件比时间、也不看标题里"已恢复"三个字；
  /// 那三个字的判断在服务端一处（配对表），这里只负责把它渲染成"历史"。
  ///
  /// 用户 2026-10-05 的现场：一条 17:33 的「预算耗尽（任务 token）」以"严重"在最上面挂了
  /// 一整天，而它当天就解除了——旧状态没被解除的读感，一半来自这里。
  final bool historical;

  static _FrameworkNote from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    String text(String key) {
      final value = map[key];
      return value == null ? '' : '$value';
    }

    final quotes = map['quotes'];
    final kind = text('kind');
    // 服务端配对过的"已恢复"原始告警：`recovered`（等级降级）与 `historical`（渲染成历史）
    // 一起给。只认 `recovered` 的旧服务端也能用——那时按"提示"渲染，只是不写"历史"两个字。
    final recovered = map['recovered'] == true;
    return _FrameworkNote(
      // 认不出就退回 'alarm' 的老口径（"框架自身的一条提示"），不丢条目
      kind: kind.isEmpty ? 'alarm' : kind,
      label: text('label'),
      // 等级只认服务端给的字段：它标了「已恢复」（`alarm/sent` 的 `recovered`，见
      // src/log/types.ts 与 src/alert/notifier.ts）就按 info 渲染——恢复不是事故，
      // 红色严重留给**还没好的**那件事。界面**不推断**（不跟后续事件比时间、也不看
      // 标题里"已恢复"那三个字）。
      level: recovered ? 'info' : text('level'),
      title: text('title'),
      reason: text('reason'),
      quotes: quotes is List ? [for (final quote in quotes) '$quote'] : const [],
      by: text('by').isEmpty ? null : text('by'),
      fingerprint: text('fingerprint').isEmpty ? null : text('fingerprint'),
      sid: text('sid'),
      person: text('person'),
      chatType: text('chatType'),
      name: text('name').isEmpty ? null : text('name'),
      at: text('at'),
      historical: map['historical'] == true,
    );
  }

  bool get isAlarm => kind == 'alarm';

  /// 这一条讲的是**框架自身**的事（告警 / 缓存破坏 / 上下文归因），还是**某个外部会话**的事（注入预警）。
  ///
  /// 只有注入预警挂在一个会话上；后三类没有会话可指，来源一律照实说"框架自身"。
  bool get fromFramework => kind != 'injection';

  /// 等级词。写出来而不只靠颜色：色盲、截图、单色打印都不能丢信息（copy-guide §二的精神）
  String levelLabel(AppStrings s) => switch (level) {
        'critical' => s.overviewLevelCritical,
        'warn' => s.overviewLevelWarn,
        'info' => s.overviewLevelInfo,
        _ => level.isEmpty ? s.overviewLevelUnknown : level,
      };

  /// 徽章文案：类别 + （告警才有的）等级。其余三类只摆类别词——
  /// 它们各自的等级是固定的（注入预警恒 warn、归因恒 info），再缀一个等级只是噪音。
  ///
  /// **已恢复的那条原始告警写「已恢复 · 历史」**（用户 2026-10-05 的第三条意见）：
  /// 它说的是"这条曾经是严重的事故，现在已经好了"，而不是"现在正严重着"。
  /// 徽章上必须一眼分得出来——否则人扫一眼列表仍然以为那件事还挂着。
  String badgeText(AppStrings s) {
    if (historical) return s.overviewHistoricalBadge(label);
    if (!isAlarm) return label.isEmpty ? s.overviewFrameworkNote : label;
    return label.isEmpty ? levelLabel(s) : '$label · ${levelLabel(s)}';
  }

  /// 等级取色：与设置页徽章同一套语义色，不另造色板；认不出的等级走中性灰。
  ///
  /// **历史条目走中性灰**（哪怕它的 `level` 字段仍是 `critical` 的原值）：
  /// 那个字段说的是"当时它是什么级别"，而现在它已经不是当前问题了。
  /// 用红色画一条早就好了的事故，就是在屏幕上说谎。
  Color tone(ColorScheme scheme) {
    if (historical) return scheme.onSurfaceVariant;
    return switch (level) {
      'critical' => IrmiaTheme.danger,
      'warn' => IrmiaTheme.warn,
      'info' => scheme.primary,
      _ => scheme.onSurfaceVariant,
    };
  }

  /// 来源一行：哪个会话、谁、判定来自哪一级；框架自身的事没有会话。
  /// 名字解析不出就退回 openid（与外部会话卡、与 `render.ts` 同一条纪律：不编名字）。
  String sourceLine(AppStrings s) {
    if (fromFramework) {
      return s.overviewSourceFramework(fingerprint);
    }
    final who = name ?? person;
    final judge = switch (by) {
      'rule' => s.overviewJudgedByRule,
      'model' => s.overviewJudgedByModel,
      _ => '',
    };
    return [
      s.overviewSourceChat(who.isEmpty ? (sid.isEmpty ? s.overviewUnknownSession : sid) : who),
      if (name != null && person.isNotEmpty) person, // 有名字时把 openid 也摆出来，对得上日志
      if (chatType.isNotEmpty) _chatTypeLabel(s, chatType),
      if (judge.isNotEmpty) judge,
    ].join(' · ');
  }
}

/// 「框架提示」卡：框架替她留意到的事——注入预警、告警，以及上下文审计的两类
/// （缓存破坏哨兵 / 每一步的上下文归因）。
///
/// 为什么要它：这几类事都写在事件日志里（`injection/flagged` / `alarm/sent` /
/// `budget/consumed{context,cacheBreak}`），但那是几万条内部簿记中间的两行，人不会去翻。
/// 框架提示了她、或者框架自己出了事，用户得在这块屏幕上看得见。
class _FrameworkNotesCard extends StatelessWidget {
  const _FrameworkNotesCard({
    required this.notes,
    required this.error,
    required this.loading,
    required this.onRetry,
  });

  final List<_FrameworkNote>? notes;
  final String? error;
  final bool loading;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final list = notes ?? const <_FrameworkNote>[];
    // **当前问题排在历史之前**（同组内保持服务端给的时间倒序）。
    //
    // 为什么要有这个分组：服务端按时间倒序给，而"已恢复 · 历史"那条往往比当前问题**更晚**
    // （它刚刚才被销账）——不分组的话它会顶在最上面，人扫一眼看到的仍然是那条旧事故
    // （用户 2026-10-05 报的"还以'严重'挂在最上面"正是这个形状）。
    // 排序只改**顺序**，一条都不删：历史仍在这张卡里，只是沉到当前问题下面。
    final current = [for (final note in list) if (!note.historical) note];
    final history = [for (final note in list) if (note.historical) note];
    final ordered = [...current, ...history];
    return _Card(
      title: IrmiaStrings.of(context).overviewFrameworkNote,
      // 用户 ②：这张卡不要副标题（原来那句是"外部消息里的注入迹象，以及框架自己发出的告警。"）。
      // 每条提示自己带类别徽章与来源，标题已经说清这是什么地方。
      children: [
        if (loading)
          StateBlock.loading(hint: IrmiaStrings.of(context).overviewFrameworkNotesLoading)
        else if (error != null)
          StateBlock.error(
            message: IrmiaStrings.of(context).overviewFrameworkNotesError('$error'),
            hint: IrmiaStrings.of(context).overviewFrameworkNotesErrorHint,
            onRetry: () => unawaited(onRetry()),
            padding: _inCardBlockPadding,
          )
        else if (list.isEmpty)
          // 空是常态：没判出迹象、没发过告警，就是一切照常。摆一张空表反而像漏了什么
          _hintLine(IrmiaStrings.of(context).overviewNoFrameworkNotes)
        else
          CappedChildren(children: [
            for (var i = 0; i < ordered.length; i += 1) _NoteLine(note: ordered[i], divider: i > 0),
          ]),
      ],
    );
  }
}

/// 一条提示：徽章 + 说明 + 来源 + 时刻；注入预警还要把理由与引用片段摆出来。
class _NoteLine extends StatelessWidget {
  const _NoteLine({required this.note, required this.divider});

  final _FrameworkNote note;
  final bool divider;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: BoxDecoration(
        border: divider ? Border(top: BorderSide(color: scheme.outlineVariant)) : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _Badge(note.badgeText(IrmiaStrings.of(context)), tone: note.tone(scheme)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(note.title,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              ),
              const SizedBox(width: 8),
              Text(
                _noteStamp(note.at),
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: scheme.onSurfaceVariant,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ],
          ),
          const SizedBox(height: 5),
          Text(note.sourceLine(IrmiaStrings.of(context)),
              style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant)),
          // 框架说的那句话（reason）与它引的外人原话（quotes）分开摆：
          // "她当时看到了什么"是这段话的全部意义——光有结论没法判断该不该管
          if (note.reason.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(note.reason, style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurface)),
          ],
          for (final quote in note.quotes) _QuoteBlock(text: quote),
        ],
      ),
    );
  }
}

/// 引用片段：外部原文，左侧一条竖线把它与框架的话分开
/// （v32 渲染纪律的界面版：框里是别人的话，框外才是框架的话，归属要一眼分得开）。
class _QuoteBlock extends StatelessWidget {
  const _QuoteBlock({required this.text});

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
        IrmiaStrings.of(context).overviewQuote(text),
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

// ──────────────────── 三块卡共用的零件 ────────────────────

/// 卡片外壳：标题 + 一句说明 + 内容（与设置页 `_SectionCard` 同一形态：
/// surface 底、outlineVariant 描边、radiusCard 圆角、hairline 投影）。
///
/// 原来右端还有一格 `trailing` 读数，只有「当前上下文构成」用它摆 `已用 / 压缩线 tok`；
/// 2026-10-25 那张卡并进三卡一排之后，那个数挪进了卡内的第三行（见 [_ContextTile]）——
/// 于是这一格连同它的参数一起删掉，免得留一个"永远没人传"的口子。
class _Card extends StatelessWidget {
  const _Card({required this.title, required this.children, this.note});

  final String title;

  /// 副标题：一句话说清这张卡收什么。**不写就整块不占高度**——
  /// 「框架提示」那张卡按用户 ② 的要求不摆副标题（条目自带类别徽章，标题已经够用）。
  final String? note;

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final note = this.note;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          if (note != null && note.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(note,
                  style: TextStyle(fontSize: 12.5, height: 1.5, color: scheme.onSurfaceVariant)),
            ),
          const SizedBox(height: 12),
          ...children,
        ],
      ),
    );
  }
}

/// 小圆角徽章：与设置页 `_badge` / 扩展页 `_badge` **同一形态**（12% 淡底、radiusCtl、11px 语义色），
/// 色一律取 `IrmiaTheme` 的四色——两张卡不该长出自己的配色。
class _Badge extends StatelessWidget {
  const _Badge(this.text, {required this.tone});

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

/// 卡内的一行灰字：空态用（实现已收进 ui_kit 的 [HintLine]，与渠道页共用一份）
Widget _hintLine(String text) => HintLine(text);

/// 卡内三态块的内边距：`StateBlock` 默认左右各 26 是给整页用的，卡里再留一次就缩成一条
const _inCardBlockPadding = EdgeInsets.symmetric(vertical: 6);

// ──────────────────── 当前上下文构成（GET /api/context/breakdown） ────────────────────

/// 「当前上下文构成」的读数：**最近一次真实请求**的 input 由哪几组、哪几段组成。
///
/// 服务端形状（`src/web/server.ts` 的 `contextBreakdownView`）：
/// `{at, turn, step, total:{tokens,budgetTokens,ratio}, groups:[{name,tokens,ratio,items}],
///   notes:{keepReasoning,renderVersion}}`；一次请求都没有时是 `{empty:true}`。
///
/// 为什么 `empty` 要单独一格而不是"全零"：`{empty:true}` 说的是"**没有数**"（她还没说过话），
/// 全零说的是"**数是 0**"（请求很小）。前者要写一句话，后者要画一条 0% 的条——两边糊在一起，
/// 人就会以为自己看到的是一个空请求。
class _ContextBreakdown {
  const _ContextBreakdown({
    required this.empty,
    required this.at,
    required this.tokens,
    required this.budgetTokens,
    required this.ratio,
    required this.groups,
    required this.keepReasoning,
  });

  /// `true` = 服务端明确说"还没有请求过"（其余字段都是零值，不许读）
  final bool empty;
  final String at;
  final int tokens;

  /// 压缩线（`persona.compactionThresholdTokens`）：分段条的**分母**
  final int budgetTokens;

  /// `tokens / budgetTokens`：离压缩线还有多远。服务端算好给的，界面不重算——
  /// 两个百分比（"这份请求里谁占得多" / "离压缩线多远"）的分母不是一回事。
  final double ratio;
  final List<_ContextGroup> groups;

  /// 保留历史思维链（出厂口径：区外也全传）
  final bool keepReasoning;

  /// 返回 `null` = **这不是一份这份端点认识的响应**（读失败，而不是"没有数"）
  static _ContextBreakdown? from(Object? raw) {
    if (raw is! Map) return null;
    final map = raw.cast<String, dynamic>();
    if (map['empty'] == true) {
      return const _ContextBreakdown(
        empty: true,
        at: '',
        tokens: 0,
        budgetTokens: 0,
        ratio: 0,
        groups: [],
        keepReasoning: true,
      );
    }
    final total = map['total'] is Map ? (map['total'] as Map).cast<String, dynamic>() : null;
    if (total == null) return null;
    final notes = map['notes'] is Map
        ? (map['notes'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final groups = map['groups'];
    return _ContextBreakdown(
      empty: false,
      at: '${map['at'] ?? ''}',
      tokens: (total['tokens'] as num?)?.toInt() ?? 0,
      budgetTokens: (total['budgetTokens'] as num?)?.toInt() ?? 0,
      ratio: (total['ratio'] as num?)?.toDouble() ?? 0,
      groups: groups is List
          ? [for (final item in groups) _ContextGroup.from(item)]
          : const [],
      keepReasoning: notes['keepReasoning'] == true,
    );
  }
}

/// 一组（系统前缀 / 工具 / 对话）：图例那一行只读三个数——组名、tokens、占比。
///
/// 组内的 `items[]`（人格常驻层 / 历史 / 此刻层…）服务端照旧给，界面**不再解析、不再画**：
/// 用户 2026-10-25 说那一层"太细"。要看到某一段各占多少，去日志页的上下文审计。
class _ContextGroup {
  const _ContextGroup({required this.name, required this.tokens, required this.ratio});

  final String name;
  final int tokens;

  /// 该组 / 合计（三组合计 100%）——与 [_ContextBreakdown.ratio] 的**分母不同**
  final double ratio;

  static _ContextGroup from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    return _ContextGroup(
      name: '${map['name'] ?? ''}',
      tokens: (map['tokens'] as num?)?.toInt() ?? 0,
      ratio: (map['ratio'] as num?)?.toDouble() ?? 0,
    );
  }
}

/// 三组的分段色（用户 2026-10-25 定的三个值）：系统前缀 蓝 · 工具 橙 · 对话 紫。
///
/// 不进 `IrmiaTheme` 的四色，因为这三个是**分段的区分色**、不是语义色（橙在这里不代表警告），
/// 而且只在这条上一处使用。次序与 `contextBreakdownView` 给 `groups` 的次序一致。
const List<Color> _contextSegmentColors = <Color>[
  Color(0xFF5B8DEF),
  Color(0xFFF2A93B),
  Color(0xFF7C6BF0),
];

/// 第 [index] 组的颜色（多于三组时循环取，免得越界）
Color _segmentColor(int index) => _contextSegmentColors[index % _contextSegmentColors.length];

/// 第三张卡：**当前上下文构成**（原来是单独占一整块全宽的「看板」，2026-10-25 并进这一排）。
///
/// 用户原话（逐字）：
///   > 「为什么上下文构成还在这一行？而不是跟用量、命中率在同一行？」
/// 于是它现在与另两张卡**共用同一个外壳**（[_TileShell]），并与它们同一高度（H，见 [_Tiles]）。
///
/// ## 构图：与另两张卡**同一个骨架**（2026-10-25 深夜第五次）
///
///   > 「看起来还是有点不协调，进度条和图例要在底部。然后如果百分比加回来能更协调的话就加上去吧」
///
/// 上一版把三样东西全顶在卡的上半截（标题行 / 条 / 图例），另两张卡却是"大数字在顶、折线在底"，
/// 于是同一排里只有这张卡的重量压在中间。现在它按那三段排（1 : 1 : 1 里的那一格，
/// 内容宽 1348 时约 441px；两处能收的地方见下面"挤的时候先动哪里"）：
/// ```text
/// 84%                                                        ← 主数字位：26 / w600 / 等宽，与另两张同字号同基线
/// 当前上下文构成                            168.2k / 200k tok  ← 标签行：12 次要色（同位置）· 右侧总量 11.5 等宽
///                           （Spacer：中间留白）
/// ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬                 ← 贴底第一行：8px 三色横条（内边距之内、与卡同宽）
/// ● 系统前缀 5%  ● 工具 2%  ● 对话 92%                          ← 贴底最后一行：一行三片图例（11，永远一行）
/// ```
///
/// 图例那行画的是**挤下来的那一档**（只留占比）。tokens 放不放得下由 [_ContextLegend] 按片宽
/// **量**出来，而量出来的数与字体有关：测试字体（FlutterTest，每个字约 1.02em）在 1/3 宽（441，
/// 片里能放字的地方约 114）放不下，整行退到只留占比；真机的微软雅黑（中文 1em、数字约 0.55em）
/// 在同一宽下 `组名 + tokens · 占比` 约 93 ≤ 114，放得下、带着 tokens。**两档都是对的**——
/// 见不见得到 tokens 跟着字体走，不跟着版式走。
///
/// **主数字是"占预算"**（`tokens / 压缩线`，四舍五入取整）：这张卡的正事是"离压缩线还有多远"，
/// 百分比回到卡面之后，它与 1:1 那两张（今日用量 / 命中率）是同一档读数。总量
/// （`168.2k / 200k tok`）仍在标签行右侧（放得下时）：绝对量回答"用了多少"，百分比回答"还差多远"。
///
/// **底对齐靠一个 `Spacer()`**：上块（主数字 + 标签行）按内容自然排，下块（条 + 图例）被
/// `Spacer` 压到卡的内容底沿（内边距 16 + 细边 1 = 17）。两块之间剩下多少就是多少
/// （实测 94 − 93 = **1px**）——**不是写死的缝**：卡高是钉死的 H，写死一个缝就会 overflow
/// （见 [_tokensTileHeight] 里那一串加总）。
///
/// ## 三态同构：同一个槽换内容，不是每态各画一套
///
///   · **正在读**：主数字位一条灰条（26 高）；下块是骨架（8px 灰条 + 图例位置的三片灰条）；
///   · **空**（`{empty:true}`）：主数字位 `—`、标签照旧、底部条画**灰槽**、图例行一句
///     "还没有请求过…"（字号 11 —— 与图例同一档 ⇒ 这一行的高度就是图例那一行的高度）；
///   · **读不到**：主数字位 `—`、贴底最后一行是"一行原因（截断）+ 就地重试"，完整原因与
///     "影响"在整卡悬停里（[_hoverLine]）；这一态**不画条**（没有数就不该有一条假条）。
///
/// ## 挤的时候先动哪里（三卡等宽之后它只有一格的宽，这几条就都在用了）
///
///   ① 图例是**唯一**可能挤的东西：片里放不下"组名 + tokens · 占比"时，先砍掉读数里的
///      tokens、只留占比（[_ContextLegend] 按片宽**量**出来判，不拍像素阈值）；
///   ② 主数字（百分比）与三色横条**不许裁**——它们是这张卡的读数；
///   ③ 标签行里**总量让路**：标题要多少由 [_textWidth] 量出来，剩下的放得下整条总量才画；
///      放不下就**整条不画**（只留标签），不给一个带省略号的半截数——"裁数字"与 ② 同一条纪律。
///      卡再窄（内边距之内连标题都放不下）才轮到标题自己收成省略号，主数字仍然不裁。
///
/// **只留这一份实现**：原来那块全宽的 `_ContextBoard` 已删，页面里不再有第二处画上下文构成。
class _ContextTile extends StatelessWidget {
  const _ContextTile({
    super.key,
    required this.data,
    required this.error,
    required this.loading,
    required this.onRetry,
  });

  final _ContextBreakdown? data;
  final String? error;
  final bool loading;
  final Future<void> Function() onRetry;

  /// 贴底那两行之间的缝：6（用户 2026-10-25：「两者之间缝 6」）
  static const double bottomGap = 6;

  /// 主数字位上"没有数"的那一格：`—`（不是 0 ——"没有数"与"数是 0"是两件事）
  static const String dash = '—';

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final data = this.data;
    // 有数 = 读到了、不是空、也不是读失败。三样之外一律不给读数（见下面那条规矩）。
    // `loading` 先判：数据没到之前哪怕手里还压着上一次的读数也不给（骨架就是骨架）。
    final _ContextBreakdown? loaded =
        loading || error != null || data == null || data.empty ? null : data;
    final body = _TileShell(
      // **上顶下压**：上块（主数字 + 标签行）按内容自然排，下块（条 + 图例）被 `Spacer`
      // 压到卡的内容底沿——三张卡的重心因此一样（另两张也是"大数字在顶、图形在底"）。
      child: LayoutBuilder(
        builder: (context, constraints) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              // 主数字位的高度 = 26 号字那一行（三态共用同一个槽 ⇒ 标签行不跳）
              height: _textHeight(context, '0', _tileValueStyle(), maxWidth: constraints.maxWidth),
              child: Align(alignment: Alignment.centerLeft, child: _valueSlot(context, s, loaded)),
            ),
            const SizedBox(height: _TileMetrics.valueGap),
            _labelRow(context, s, loaded, constraints.maxWidth),
            // **中间留白**：剩下的高度全给这里，上下两块因此各贴一端（底对齐就靠它）
            const Spacer(),
            if (loading)
              _ContextSkeleton(hint: s.overviewContextLoading)
            else ...[
              // 读不到时不画条：没有数就不该有一条假条（那一条留给"一行原因 + 重试"）
              if (error == null) ...[
                _ContextSegmentedBar(
                  // 空态没有组 ⇒ 这段只剩底下的灰槽（"没有数"不许画成"数是 0"）
                  groups: loaded?.groups ?? const <_ContextGroup>[],
                  totalTokens: loaded?.tokens ?? 0,
                  budgetTokens: loaded?.budgetTokens ?? 0,
                ),
                const SizedBox(height: bottomGap),
              ],
              _lastRow(context, s, loaded),
            ],
          ],
        ),
      ),
    );
    // 悬停看全：卡面放不下的那几样（占预算 / 思维链 / 取自哪一拍；已用那一行也在）
    final hover = _hoverLine(s, loaded);
    return hover == null ? body : Tooltip(message: hover, child: body);
  }

  /// 主数字位：有数时是**占预算百分比**（`84%`），空 / 读不到是 `—`，正在读是一条灰条。
  ///
  /// 三态共用同一个槽（槽高见 [build]），所以标签行在三态里都在同一条线上——"同构"不是
  /// 每态各画一遍，而是同一个槽换内容。
  Widget _valueSlot(BuildContext context, AppStrings s, _ContextBreakdown? loaded) {
    if (loading) {
      // 骨架：与主数字同高的一截（不是转圈）。槽是 26 号字那一行，这条灰条在槽里居中
      return Container(
        key: const ValueKey('context-skeleton-value'),
        width: 64,
        height: 26,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(6),
        ),
      );
    }
    return Text(
      // 百分比照端点给的 ratio 取整（界面不拿 tokens 再算一遍：两个百分比的分母不是一回事）
      loaded == null ? dash : s.overviewContextShare((loaded.ratio * 100).round()),
      // 主读数是**一行、不折行**：折了它就是两行（41 → 82），H 立刻装不下
      maxLines: 1,
      softWrap: false,
      style: _tileValueStyle(),
    );
  }

  /// 标签行：**左标题、右总量**（`168.2k / 200k tok`，11.5 等宽）。
  ///
  /// 与另两张卡的标签行同一个位置、同一档字；总量是这张卡最该一直在眼前的绝对量
  /// （"用了多少 / 压缩线多少"）。挤的时候**总量让路**——而且是**整条让**：
  /// 标题的自然宽先量出来，剩下的地方放得下整条总量才画，放不下就一条都不画（只留标签）。
  /// 不画半条：`168.2k / 200k to…` 是一个被裁的数字，与"主数字不许裁"同一条纪律
  /// （用户 2026-10-25 深夜改成三卡等宽之后，一格的宽只够其中一档）。
  /// 主数字那一行不受影响，百分比永远不裁。
  Widget _labelRow(BuildContext context, AppStrings s, _ContextBreakdown? loaded, double inner) {
    final variant = Theme.of(context).colorScheme.onSurfaceVariant;
    final labelStyle = _tileLabelStyle(variant);
    final total = loaded == null
        ? null
        : s.overviewContextTokens(formatCompact(loaded.tokens), formatCompact(loaded.budgetTokens));
    // 标题的自然宽 + 那条缝之后剩下的，才是总量能占的地方
    final room = inner - _textWidth(context, s.overviewContextTitle, labelStyle) - Space.x3;
    // 两档：整条在（`shownTotal` 非空），或整条不在。判据是**量**出来的宽，不是像素阈值。
    final shownTotal =
        total != null && _textWidth(context, total, _contextTotalStyle(variant)) <= room ? total : null;
    return Row(
      children: [
        // 标题吃掉剩下的宽度（总计让路之后它才可能被挤；再窄也只是它自己省略，主数字不动）
        Expanded(
          child: Text(
            s.overviewContextTitle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: labelStyle,
          ),
        ),
        if (shownTotal != null) ...[
          const SizedBox(width: Space.x3),
          Text(
            shownTotal,
            maxLines: 1,
            textAlign: TextAlign.right,
            style: _contextTotalStyle(variant),
          ),
        ],
      ],
    );
  }

  /// **贴底最后一行**：有数时是三片图例、空态是一句人话、读不到时一行原因 + 就地重试。
  ///
  /// 三种内容在同一个位置（卡的内容底沿），所以三态读起来是"同一张卡"，不是三张不同的卡。
  /// 空态那句为什么不用 [HintLine]：它是 12.5/1.6 = 20 高，比图例那一行（11 → 17）高 3
  /// —— 卡高钉死成 H 之后，这 3px 就是一条黄黑条（内容区只剩 1px 余量）。宁可字号跟图例同一档。
  Widget _lastRow(BuildContext context, AppStrings s, _ContextBreakdown? loaded) {
    if (loaded != null) return _ContextLegend(groups: loaded.groups);
    final scheme = Theme.of(context).colorScheme;
    final error = this.error;
    if (error == null) {
      // 空态：一次请求都没有过（`{empty:true}`）。"没有数"不许画成"数是 0"。
      return Text(
        s.overviewContextEmpty,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: _ContextLegend.style(scheme.onSurfaceVariant),
      );
    }
    // 读失败：一行原因（截断）+ 就地重试；影响与完整原因在悬停里（[_hoverLine]）
    return Row(
      children: [
        Flexible(
          child: Text(
            s.overviewContextError(error),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
          ),
        ),
        const SizedBox(width: Space.x1),
        TextButton(
          onPressed: () => unawaited(onRetry()),
          style: TextButton.styleFrom(
            foregroundColor: IrmiaTheme.danger,
            minimumSize: Size.zero,
            padding: const EdgeInsets.symmetric(horizontal: Space.x2, vertical: Space.x1),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: Text(s.retry, style: const TextStyle(fontSize: 12)),
        ),
      ],
    );
  }

  /// 悬停整张卡才出现的那一行（卡面放不下的东西都在这里）。
  ///
  /// 有数时：`168.2k / 200k tok · 占预算 84% · 保留历史思维链：开 · 取自 10-24 12:34 那一拍`
  /// ——两半各自都是文案表里的句子（[AppStrings.overviewContextTokens] /
  /// [AppStrings.overviewContextSubline]），这一版只挪了它们的**位置**，措辞一个字没改。
  /// 读不到时：原因 + 影响（[AppStrings.overviewContextErrorHint] 那一句原来在卡面第三行）。
  ///
  /// [loaded] 就是 [build] 里算出来的"有数"那一份（同一套判据，只算一次）。
  String? _hoverLine(AppStrings s, _ContextBreakdown? loaded) {
    if (loaded != null) {
      return '${s.overviewContextTokens(formatCompact(loaded.tokens), formatCompact(loaded.budgetTokens))}'
          ' · '
          '${s.overviewContextSubline((loaded.ratio * 100).round(), loaded.keepReasoning ? s.overviewContextKeepOn : s.overviewContextKeepOff, _noteStamp(loaded.at))}';
    }
    final error = this.error;
    return error == null ? null : '${s.overviewContextError(error)} · ${s.overviewContextErrorHint}';
  }
}

/// 分段彩色进度条：一根 8px 高的圆角条，按三组占比切成**三段不同颜色**
/// （系统前缀 / 工具 / 对话），最右端到 100% 之间留一条**极淡的剩余槽**。
///
/// ## 每段宽度的算法（只有这一处，别在别处再算一遍）
///
/// ```text
/// 分母 = 压缩线 budgetTokens（没配 = 0 时退回合计，不除零）
/// 第 i 段的 flex = 第 i 组的 tokens
/// 剩余槽的 flex = 分母 − 各组 tokens 之和（<0 时不留槽：已经该压缩了）
/// ```
///
/// 于是第 i 段宽 = 条宽 × (tokens_i / 分母)、剩余槽宽 = 条宽 × ((分母 − 合计) / 分母)，
/// 与"按累计量算位置再相减"是同一个数——但**不需要 `LayoutBuilder`**。
/// 这一排的高度是钉死的（H = 用量卡的自然高度，见 [_Tiles]），条高 8 是图示而不是留白；
/// 用 `Row` 的 flex 表达比例，三段的宽度可以按渲染矩形量（键挂在 `ColoredBox` 上），
/// 也不必为"条有多宽"再套一层布局。
class _ContextSegmentedBar extends StatelessWidget {
  const _ContextSegmentedBar({
    required this.groups,
    required this.totalTokens,
    required this.budgetTokens,
  });

  final List<_ContextGroup> groups;
  final int totalTokens;
  final int budgetTokens;

  /// 条高：8px（用户指定）。再细就看不出是三段，再粗就不像一条读数了
  static const double barHeight = 8;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final spent = groups.fold<int>(0, (sum, group) => sum + group.tokens);
    // 分母：压缩线。没配（0 或负数）时退回合计——宁可铺满一条，也不能除出 NaN
    final configured = budgetTokens > 0 ? budgetTokens : (totalTokens > 0 ? totalTokens : spent);
    final remaining = configured > spent ? configured - spent : 0;
    return ClipRRect(
      borderRadius: BorderRadius.circular(barHeight / 2),
      child: SizedBox(
        height: barHeight,
        width: double.infinity,
        // 底色 = 剩余槽：三段盖在左边，露出来的那一截就是"离压缩线还有多远"
        child: ColoredBox(
          // 键挂在**有 RenderObject 的那一个**上：用例按它量出整条与三段的渲染宽度
          key: const ValueKey('context-segment-track'),
          color: scheme.onSurface.withValues(alpha: 0.07),
          child: Row(
            // stretch：三段自己不写字，高度只能靠这条撑满 8px
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < groups.length; i += 1)
                if (groups[i].tokens > 0)
                  // flex 就是这一组的 token 数：宽度 ∝ tokens / (各组之和 + 剩余)
                  Expanded(
                    flex: groups[i].tokens,
                    child: ColoredBox(key: ValueKey('context-segment-$i'), color: _segmentColor(i)),
                  ),
              if (remaining > 0) Expanded(flex: remaining, child: const SizedBox.shrink()),
            ],
          ),
        ),
      ),
    );
  }
}

/// 条下方那一行图例：**三片并排**（用户 2026-10-25 的 A 方案）——
/// 每片 `圆点 + 组名 + tokens · 占比`，次序与端点给的三组一致。
///
/// 三片**等宽**（`Row` + `Expanded` ×3）：让每片按内容长短各占一段，三组就会挤成一坨、
/// 看不出"这是三组"；等宽之后三片各占一行的三分之一，组名与它的两个数贴在自己那一段里
/// （[_ContextLegendPiece]），扫视时不会串行。
///
/// **永远一行**：它住在 1/3 宽的上下文卡里（内容宽 1348 时约 441px，片里能放字的地方约 114）；
/// 更窄的窗口外层已经折成两行、这张卡占满整行（见 [_Tiles.oneRowMinWidth]），所以这里不必再排第二行。
///
/// **挤的时候先砍读数里的 tokens**（用户 2026-10-25 深夜：「图例是唯一可能与标题行挤的东西，
/// 窄了就把图例读数的 tokens 砍掉（只留百分比），不许溢出」）：
/// 片里放不放得下是**量**出来的——按片宽减掉圆点与两条缝，再把组名与读数的自然宽度加起来比
/// （[_textWidth]，与屏幕上排出来的是同一个数）。放不下就整行一起切到"只留占比"：
/// 组名与占比都保得住，只有 `9.0k` 那一截退场。**不许溢出，也不许裁读数。**
///
/// **字号 11**（随"高度锚在用量卡"一起收的，原来是 11.5）：这一行是 H 里的一块。
class _ContextLegend extends StatelessWidget {
  const _ContextLegend({required this.groups});

  final List<_ContextGroup> groups;

  /// 片与片之间的缝：8（三分之一宽的卡里，比整页的 12 紧一档）
  static const double gap = Space.x2;

  /// 图例字号：11（见类注释）
  static const double fontSize = 11;

  /// 图例的字样式（量宽度与画那一片**必须**是同一份）
  static TextStyle style(Color color) => TextStyle(
        fontSize: fontSize,
        color: color,
        fontFeatures: const [FontFeature.tabularFigures()],
      );

  /// 一片里那一串读数：带 tokens 的 `9.0k · 5%`，或窄下来的 `5%`
  static String numbers(AppStrings s, _ContextGroup group, {required bool withTokens}) {
    final share = (group.ratio * 100).round();
    return withTokens
        ? s.overviewContextLegendNumbers(formatCompact(group.tokens), share)
        : s.overviewContextShare(share);
  }

  @override
  Widget build(BuildContext context) {
    if (groups.isEmpty) return const SizedBox.shrink();
    final s = IrmiaStrings.of(context);
    final legendStyle = style(Theme.of(context).colorScheme.onSurfaceVariant);
    return LayoutBuilder(
      builder: (context, constraints) {
        // 三片等宽：先算出一片有多少地方（扣掉片与片之间的缝）
        final piece = (constraints.maxWidth - gap * (groups.length - 1)) / groups.length;
        // 片里被"圆点 + 两条缝"吃掉的那一截，剩下才是组名与读数分
        final room = piece - _ContextLegendPiece.leading;
        // 三片**一起**决定带不带 tokens：一半带一半不带，一眼看去像少了数据
        final withTokens = groups.every((group) =>
            _textWidth(context, group.name, legendStyle) +
                _textWidth(context, numbers(s, group, withTokens: true), legendStyle) <=
            room);
        return Row(
          children: [
            for (var i = 0; i < groups.length; i += 1) ...[
              if (i > 0) const SizedBox(width: gap),
              // 等宽：三片各占三分之一，不随组名长短变化（片内从左往右贴着自己那一段排）
              Expanded(
                child: _ContextLegendPiece(index: i, group: groups[i], withTokens: withTokens),
              ),
            ],
          ],
        );
      },
    );
  }
}

/// 图例里的一片：`圆点 + 组名 + tokens · 占比`（一行，放不下时先收组名成省略号）。
///
/// 键挂在**片**上（`context-legend-<i>`）：用例按它量三片的位置，验"同一行、从左到右"。
class _ContextLegendPiece extends StatelessWidget {
  const _ContextLegendPiece({
    required this.index,
    required this.group,
    required this.withTokens,
  });

  /// 第几组：颜色与横条第几段同源（`_segmentColor`）
  final int index;
  final _ContextGroup group;

  /// 读数带不带 tokens：窄了只留占比（由 [_ContextLegend] 量片宽统一决定）
  final bool withTokens;

  /// 圆点直径：用户指定 6px（比旧图例的 7px 小一格，一行三片时更像句读、不像标记）
  static const double dotSize = 6;

  /// 圆点与组名之间的缝
  static const double dotGap = Space.x1 + 2;

  /// 组名与读数之间的缝
  static const double nameGap = Space.x1;

  /// 片内"圆点 + 两条缝"占掉的宽度（[_ContextLegend] 判"放不放得下"时先扣掉这一截）
  static const double leading = dotSize + dotGap + nameGap;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final numberStyle = _ContextLegend.style(Theme.of(context).colorScheme.onSurfaceVariant);
    return Row(
      key: ValueKey('context-legend-$index'),
      children: [
        Container(
          width: dotSize,
          height: dotSize,
          decoration: BoxDecoration(color: _segmentColor(index), shape: BoxShape.circle),
        ),
        const SizedBox(width: dotGap),
        // 组名是唯一的弹性件：挤下来先收它，占比（读数）不许被裁
        Flexible(
          child: Text(
            group.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: numberStyle,
          ),
        ),
        const SizedBox(width: nameGap),
        Text(
          _ContextLegend.numbers(s, group, withTokens: withTokens),
          maxLines: 1,
          style: numberStyle,
        ),
      ],
    );
  }
}

/// 加载态的**下半块**（上半块那条"大数字位"的灰条在 [_ContextTile._valueSlot] 里）。
///
/// 骨架条与真条同高（8px）、同宽（铺满内边距之内）；图例那三片也各占三分之一，缝与真图例
/// 同一档（8）。图例那一行的高度**按真图例的字量出来**（[TextPainter]、同一份样式）——
/// 数据到了这里只换内容，条不会上下跳一下。
///
/// 骨架的总高必须落在"有数时下块"的高度里（8 + 6 + 图例一行）：卡高是钉死的（见 [_Tiles]），
/// 骨架比它高就是一次 RenderFlex overflow。
///
/// [hint] 只进语义树（读屏软件念得到），不占版面——骨架本身就是"正在读"的表达。
class _ContextSkeleton extends StatelessWidget {
  const _ContextSkeleton({required this.hint});

  final String hint;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = scheme.onSurface.withValues(alpha: 0.06);
    Widget pill(double height) => Container(
          height: height,
          width: double.infinity,
          decoration: BoxDecoration(
            color: tone,
            borderRadius: BorderRadius.circular(height / 2),
          ),
        );
    // 真图例那一行有多高，这里就留多高：条的位置因此与有数时是同一个 y
    final legendRow = _textHeight(
      context,
      '0',
      _ContextLegend.style(scheme.onSurfaceVariant),
      maxWidth: double.infinity,
    );
    return Semantics(
      key: const ValueKey('context-skeleton'),
      label: hint,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          // 骨架条：与真条同高（8px）、同宽（铺满内边距之内）
          pill(_ContextSegmentedBar.barHeight),
          // 与真条到图例的缝同一档（6）
          const SizedBox(height: _ContextTile.bottomGap),
          // 一行三片：位置与有数时那行图例一档（数据到了只换内容、不换版面）
          SizedBox(
            height: legendRow,
            child: Row(
              children: [
                for (var i = 0; i < 3; i += 1) ...[
                  if (i > 0) const SizedBox(width: _ContextLegend.gap),
                  Expanded(child: pill(9)),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 时刻：今天只给 HH:mm，隔天补上 MM-DD。
/// 框架提示不像"最近事件"那样都在眼前——三天前那条只给钟点会被读成"刚刚"。
String _noteStamp(String iso) {
  final dt = DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return '—';
  final now = DateTime.now();
  final hm = '${_p2(dt.hour)}:${_p2(dt.minute)}';
  final today = dt.year == now.year && dt.month == now.month && dt.day == now.day;
  return today ? hm : '${_p2(dt.month)}-${_p2(dt.day)} $hm';
}

String _p2(int value) => value.toString().padLeft(2, '0');

class _RecentList extends StatelessWidget {
  const _RecentList({required this.stats, required this.onWake});

  final Map<String, dynamic>? stats;
  final VoidCallback onWake;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final events = ((stats?['recent'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .where(_visible)
        .toList()
        .reversed
        .take(kListCap)
        .toList();

    if (events.isEmpty) {
      return GuideBar(
        icon: Icons.history_rounded,
        text: IrmiaStrings.of(context).overviewRecentEmpty,
        actionLabel: IrmiaStrings.of(context).overviewRecentEmptyAction,
        onAction: onWake,
        hint: IrmiaStrings.of(context).overviewRecentEmptyHint,
      );
    }

    return Column(
      children: [
        for (final e in events)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 8),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: scheme.outlineVariant)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(AppState.hhmm(e['ts']?.toString() ?? ''),
                    style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 11.5,
                        color: scheme.onSurfaceVariant)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(e['summary']?.toString() ?? e['type']?.toString() ?? '',
                      style: const TextStyle(fontSize: 13.5)),
                ),
              ],
            ),
          ),
      ],
    );
  }

  /// 镜像与过程不上屏（与 Web 同规则）
  static bool _visible(Map<String, dynamic> e) {
    final type = e['type']?.toString() ?? '';
    if (type == 'message/user') return false;
    if (type == 'turn/start' || type == 'step/start' || type == 'step/end') return false;
    if (type == 'wake/heartbeat') return false;
    final summary = e['summary']?.toString() ?? '';
    if (type == 'turn/end' && summary.contains('completed')) return false;
    if (e['visibility'] != 'model' && type != 'turn/end') return false;
    return true;
  }
}
