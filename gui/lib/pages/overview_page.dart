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
/// 状态卡 → 磁贴四枚（带 24h 趋势）→ 建议 → 外部会话 → 定时器 → 框架提示 → 最近事件（默认 8 条）。
///
/// 「外部会话」与「框架提示」两张卡（v33）答的是用户自己的两个问题：
/// **她手边那个软件里攒了多少**（谁来过、她还没看的有几条）、**框架有没有替她留意到什么**
/// （注入预警、告警）。数据分别来自 `GET /api/sessions` 与 `GET /api/framework-notes`，
/// 两张卡**各有自己的三态**——它们读的是附加信息，读不到时该灰的是这张卡，不是整页。
///
/// 「定时器」那张卡（2026-10-06）答的是第三个问题：**她接下来什么时候会自己醒**。
/// 数据来自同一份 `/api/projection`（`timers` 是 `timer/set` 折出来的），每行一颗「撤销」——
/// 那是 `timer-cancel` 在界面上唯一的入口（后端一直在，界面从前 0 调用）。
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

  /// 死信动作（重投 / 丢弃）上一次失败的原因。
  ///
  /// 为什么留在页面上而不是只弹一条 toast：toast 四秒就没了，而人真正需要读到的是
  /// **为什么没成**（"seq 42 不在死信队列里"这种话得能对着卡再看一眼）。成功之后
  /// 重新读页面时它自己清掉。
  String? deadActionError;

  /// 正在撤销的定时器 id（非 null 时那一整排「撤销」都禁用——防连点出一串并发写）
  String? cancellingTimer;

  /// 上一次撤销失败的原因（与 [deadActionError] 同一条纪律：失败要能对着卡再读一遍）
  String? timerActionError;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChange);
    unawaited(load());
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChange);
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && error != null) unawaited(load());
  }

  Future<void> load() async {
    final api = widget.state.api;
    // 两张附加卡各自吃自己的错（内部 try/catch），但**和主数据一起等**：
    // 下拉刷新等人等的应该是同一件事，而不是主卡先回来、附加卡等一下再跳出来
    final extras = Future.wait([_loadSessions(), _loadNotes()]);
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
  Future<void> _loadSessions() async {
    if (mounted) setState(() => sessionsLoading = true);
    try {
      final data = await widget.state.api.get('/api/sessions');
      final list = data is Map ? data['sessions'] : null;
      if (!mounted) return;
      setState(() {
        sessions = list is List
            ? [for (final item in list) _SessionRow.from(item)]
            : null;
        // 非对象/缺字段当"读失败"而不是"没有会话"：说"没有"是断言，得先真的读到
        sessionsError = sessions == null ? IrmiaStrings.of(context).overviewSessionsNotList : null;
        sessionsLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        sessionsError = err.toString();
        sessionsLoading = false;
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
                  _Tiles(stats: stats, proj: proj),
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
                  _TimersCard(
                    timers: _timers,
                    busyId: cancellingTimer,
                    actionError: timerActionError,
                    onCancel: (id) => unawaited(_cancelTimer(id)),
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

  /// 她还排着的定时器（投影 `timers`，由 `timer/set` 折出、`timer/cancelled`/`timer/fired` 收掉）。
  ///
  /// 认不出 `timerId` 的条目一律丢掉：撤销按钮得有一个**确定**的号才敢发（与 [_deadLetters]
  /// 丢掉认不出 seq 的那条同一姿势）。
  List<Map<String, dynamic>> get _timers {
    final raw = proj?['timers'];
    if (raw is! List) return const [];
    return [
      for (final item in raw.whereType<Map>())
        if ((item['timerId']?.toString() ?? '').isNotEmpty) item.cast<String, dynamic>(),
    ];
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

  // ──────────────── 定时器卡片上那颗「撤销」 ────────────────

  /// 撤销一个还没触发的定时器 → `POST /api/commands/timer-cancel {timerId}`。
  ///
  /// 服务端的语义（src/web/server.ts:4964）：先写 `timer/cancelled`（真相源）再取消内存里的布防，
  /// 所以撤销之后日志里留得下"这次是谁撤的、撤的是哪一个"；投影里那条随之消失，界面重读就把
  /// 这一行去掉。**先确认一次**：定时器是她自己排的（或人让她排的），误点撤销等于让她少醒一次。
  ///
  /// 它是误排之后**唯一**的撤销出口（design §4.18 论证过"零调用 ≠ 没用"：`cancel` 只是还没到
  /// 那个场景），所以入口必须摆在看得见的地方，而不是只留在 CLI/工具通道里。
  Future<void> _cancelTimer(String timerId) async {
    if (timerId.isEmpty || cancellingTimer != null) return;
    final yes = await confirm(
      context,
      title: IrmiaStrings.of(context).overviewTimerCancelTitle,
      body: IrmiaStrings.of(context).overviewTimerCancelBody(timerId),
      confirmLabel: IrmiaStrings.of(context).overviewTimerCancel,
      danger: true,
    );
    if (!yes || !mounted) return; // 取消 = 什么都没决定：一个请求都不发

    setState(() {
      cancellingTimer = timerId;
      timerActionError = null;
    });
    try {
      await widget.state.api.post('/api/commands/timer-cancel', {'timerId': timerId});
      if (!mounted) return;
      setState(() => cancellingTimer = null);
      IrmiaToast.show(context, IrmiaStrings.of(context).overviewTimerCancelled(timerId),
          kind: ToastKind.success);
      await load();
    } catch (err) {
      if (!mounted) return;
      setState(() {
        cancellingTimer = null;
        timerActionError = IrmiaStrings.of(context).overviewTimerCancelFailed(timerId, '$err');
      });
      IrmiaToast.show(context, IrmiaStrings.of(context).overviewTimerCancelToastFailed('$err'),
          kind: ToastKind.error);
    }
  }

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

class _Tiles extends StatelessWidget {
  const _Tiles({required this.stats, required this.proj});
  final Map<String, dynamic>? stats;
  final Map<String, dynamic>? proj;

  @override
  Widget build(BuildContext context) {
    final budget = stats?['budget'] as Map<String, dynamic>? ?? const {};
    final tiles = stats?['tiles'] as Map<String, dynamic>? ?? const {};
    final hourly = (stats?['hourly'] as List?) ?? const [];

    final tokens = (budget['tokensToday'] as num?)?.toInt() ?? 0;
    final rate = tiles['cacheHitRate'];
    final pending = (tiles['pending'] as num?)?.toInt() ?? 0;
    final fail = (tiles['failStreak'] as num?)?.toInt() ?? 0;

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

    return Row(
      children: [
        Expanded(
          child: _Tile(
            // 数字走**唯一那一处**格式化（`format.dart`，与 src/format/units.ts 逐字镜像）：
            // 2705946 在这里与日志页都是 `2.7M`。过去这一行是内联三目（只会 k），
            // 与日志页的 `_num()` 各写一遍——用户报的"同一个数两种写法"就是这么来的。
            value: formatCompact(tokens),
            // 卡面印紧凑写法、悬停给真数：`2705.9k` 那种写法既不统一、也没解决"看不到真数"
            tooltip: IrmiaStrings.of(context)
                .overviewTodayUsageTooltip(budgetTokensTooltip(tokens)),
            label: IrmiaStrings.of(context).overviewTodayUsage,
            metric: kBudgetMetricLabel,
            series: tokenSeries,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: _Tile(
            value: rate == null ? '–' : '${((rate as num) * 100).round()}%',
            label: IrmiaStrings.of(context).overviewCacheHitRate,
            series: hitSeries,
          ),
        ),
        const SizedBox(width: 12),
        Expanded(child: _Tile(value: '$pending', label: IrmiaStrings.of(context).overviewPending)),
        const SizedBox(width: 12),
        Expanded(child: _Tile(value: '$fail', label: IrmiaStrings.of(context).overviewFailStreak)),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.value, required this.label, this.series, this.metric, this.tooltip});
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
    final body = Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(value,
              style: const TextStyle(
                  fontSize: 26, fontWeight: FontWeight.w600, fontFeatures: [FontFeature.tabularFigures()])),
          const SizedBox(height: 2),
          Row(
            children: [
              Flexible(child: Text(label, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))),
              if (metric != null) ...[
                const SizedBox(width: 6),
                Flexible(
                  child: Text(metric,
                      style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant.withValues(alpha: 0.85))),
                ),
              ],
            ],
          ),
          if (series != null && series!.isNotEmpty) ...[
            const SizedBox(height: 8),
            SizedBox(
              height: 24,
              width: double.infinity,
              child: CustomPaint(
                painter: _SparkPainter(values: series!, color: scheme.primary),
              ),
            ),
          ],
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

// ──────────────────── 两张卡共用的零件 ────────────────────

/// 卡片外壳：标题 + 一句说明 + 内容（与设置页 `_SectionCard` 同一形态：surface 底、
/// outlineVariant 描边、radiusCard 圆角、hairline 投影）。这一页的卡没有右侧动作位。
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

/// 定时器卡片：她排着的唤醒 + 每行的「撤销」。
///
/// 为什么需要这张卡（2026-10-06）：`timer-cancel` 的后端实现与用例都在
/// （src/web/server.ts:4964，`{timerId}`），而界面**从来没有入口**——误排一个定时器之后，
/// 除了等它到点、或者去改盘上的 `timers.json`，没有第三条路。design §4.18 早就论证过
/// "`cancel` 是误排之后唯一的撤销出口，零调用 ≠ 没用"（docs/design.md:965-969）。
///
/// 数据与状态卡同源（同一份 `GET /api/projection`），所以**不另设三态**：整页读失败时
/// 这张卡根本不会出现（上面已经换成错误块）；空态是"她眼下没排任何定时器"，那是常态。
class _TimersCard extends StatelessWidget {
  const _TimersCard({
    required this.timers,
    required this.busyId,
    required this.actionError,
    required this.onCancel,
  });

  final List<Map<String, dynamic>> timers;

  /// 正在撤销的那一条（非 null 时所有行的按钮都禁用）
  final String? busyId;

  /// 上一次撤销失败的原因（null = 没有失败要报）
  final String? actionError;

  final void Function(String timerId) onCancel;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final error = actionError;
    return _Card(
      title: IrmiaStrings.of(context).overviewTimers,
      note: IrmiaStrings.of(context).overviewTimersNote,
      children: [
        if (timers.isEmpty)
          _hintLine(IrmiaStrings.of(context).overviewNoTimers)
        else ...[
          Text(
            IrmiaStrings.of(context).overviewTimersWaiting(timers.length),
            style: TextStyle(
              fontSize: 12,
              color: scheme.onSurfaceVariant,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          if (error != null) ...[
            const SizedBox(height: 6),
            StateBlock.error(
              message: error,
              hint: IrmiaStrings.of(context).overviewTimersErrorHint,
              padding: _inCardBlockPadding,
            ),
          ],
          const SizedBox(height: 6),
          CappedChildren(children: [
            for (var i = 0; i < timers.length; i += 1)
              _TimerLine(
                // 按 timerId 上键：用例与"连点两下撤的是不是同一条"都靠它定位
                key: ValueKey('timer-${timers[i]['timerId'] ?? ''}'),
                timer: timers[i],
                divider: i > 0,
                // 一条在飞时其余也禁用：服务端按 timerId 逐个处理，连点只会得到一串同义请求
                onCancel: busyId == null ? () => onCancel('${timers[i]['timerId'] ?? ''}') : null,
              ),
          ]),
        ],
      ],
    );
  }
}

/// 一行定时器：什么时候醒（`at` / `cron`）+ 它的 id + 唤醒内容 + 「撤销」。
///
/// 时刻走 [_noteStamp]（今天只给 HH:mm、隔天带 MM-DD）——她排的常常是"明天早上"，
/// 只给钟点会被读成"今天"。
class _TimerLine extends StatelessWidget {
  const _TimerLine({super.key, required this.timer, required this.divider, required this.onCancel});

  final Map<String, dynamic> timer;
  final bool divider;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final id = '${timer['timerId'] ?? ''}';
    final at = '${timer['at'] ?? ''}';
    final cron = '${timer['cron'] ?? ''}';
    // 周期条（cron）没有 `at`：它的到期时刻由 TimerStore 每次触发后重排，投影里只有表达式。
    final when = at.isNotEmpty
        ? _noteStamp(at)
        : (cron.isNotEmpty
            ? IrmiaStrings.of(context).overviewTimerCron(cron)
            : IrmiaStrings.of(context).overviewTimerUnknownTime);
    final payload = _timerPayloadText(timer['payload']);

    return Container(
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(
        border: divider ? Border(top: BorderSide(color: scheme.outlineVariant)) : null,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Flexible(
                    child: Text(
                      when,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                    ),
                  ),
                  if (at.isNotEmpty && cron.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    _Badge(IrmiaStrings.of(context).overviewTimerRecurring, tone: scheme.onSurfaceVariant),
                  ],
                ]),
                const SizedBox(height: 2),
                Text(
                  id,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: scheme.onSurfaceVariant),
                ),
                if (payload.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      IrmiaStrings.of(context).overviewTimerPayload(payload),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          TextButton(
            key: ValueKey('timer-cancel-$id'),
            onPressed: onCancel,
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              minimumSize: const Size(0, 30),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(IrmiaStrings.of(context).overviewTimerCancel),
          ),
        ],
      ),
    );
  }
}

/// 唤醒内容的一行摘要：字符串直接用，对象先取 `note`、再取 `why`，别的形状走 `toString()`，过长截断。
/// **不做 JSON 美化**：这里只要"她当时写了什么"的一眼，完整内容在日志里查得到。
///
/// 为什么要先取那两格（2026-10-13，timer `payload` 三格约定那一批）：`payload` 从此刻起有了
/// **约定形状** `{why, note, sid}`（见 `src/model/self-brief.ts` 的 `PAYLOAD_SHAPE_TEXT` 与
/// `src/tools/admin.ts` 的 `timer.payload` 说明）——而原来对**对象**型 payload 会打出整串 JSON
/// （`{kind: wait, note: …, sid: …}`），人看到的是字段名而不是"她写了什么"。
/// `note` 是她写给"到点做什么"的那一格（`render.ts` 渲染 `[定时器触发]` 时读的也是它），
/// `why` 是"为什么排它"（界面看"为什么"的唯一入口）；两格都没有 ⇒ 退回原来的表现（`toString()`），
/// **旧形状照旧可读**（缺格不是错误）。
String _timerPayloadText(Object? payload) {
  if (payload == null) return '';
  final text = payload is String ? payload : _timerPayloadSummary(payload);
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return flat.length <= 80 ? flat : '${flat.substring(0, 79)}$_ellipsis';
}

/// 截断用的省略号：它是标点、不是句式（两种语言都还是它，所以不进文案表）。
const _ellipsis = '…';

/// 对象型 payload 的取词次序：`note` → `why` → `toString()`（都不在才退回）。
/// 单独一个纯函数：取词次序本身就是这一批的判据，用例直接钉它。
String _timerPayloadSummary(Object payload) {
  if (payload is Map) {
    for (final key in const ['note', 'why']) {
      final value = payload[key];
      if (value is String && value.trim().isNotEmpty) return value;
    }
  }
  return '$payload';
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
