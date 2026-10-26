// 本页文案**已经全部**落在 lib/i18n/app_strings.dart（`sched*` 那一族）：页面里不再有中文
// 字面量，`gui/test/copy_coverage_test.dart` 的闸门盯着这件事。加一句话 = 往文案表加一条
// （中英各一处），页面里只许 `IrmiaStrings.of(context).xxx`。
//
// 还有一组**不是界面文案**的中文留在页面里？——没有：她写在 `payload` / 记忆文件里的那些词
// （分类名、分区标题、动作别名、相对日子、中文正则）整块搬到了 `app_strings.dart` 末尾的
// 「数据」区（`kSchedule*`），这里只引用。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../app.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../theme/design_tokens.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

/// 「日程」页（一级第三项）——设计稿 `Agent 近期安排 · 周历与清单.html` 那一页。
///
/// ## 一屏里有什么（照设计稿逐块，2026-10-25 又删了六处）
/// 页头（eyebrow + 大标题 + 搜索 / 回到本周 / ＋新建安排）→ 四张计数卡 → **左周历 + 右清单**（点一天筛清单、
/// 点一条看详情）→ 选中详情。页脚那句话、周历底部"格外的条目"那行、整块「长期计划」都删掉了
/// （用户这轮点名；见下方"这一页不回答什么"）。
///
/// ## 布局纪律（用户 2026-10-12 的硬要求）：**整页不滚，只有「安排清单」在块内滚**
/// 最外层是 `Column` + `Expanded`，每一块自己管自己的高度：页面里**只有一个 `Scrollable`**
/// （清单那一块的 [ListView]，键 `schedule-list`）。窗口矮的时候**压缩周历行高**
/// （[kMinRowHeight]…[kRowHeight]），而不是让整页长出去；屏再矮就先收起选中详情。
///（从前还能收起"两块附加内容"；2026-10-25 删掉长期计划之后只剩详情一块可让位。）
///
/// ## 数据：只读投影 + `payload` 约定（不新增端点、不改事件形状）
/// `GET /api/projection` 的 `timers` + 每条 `payload` 的七格：既有三格 `why`/`note`/`sid`（v55）
/// 与**本版新约的四格** `title`/`cat`/`dur`/`action`（v57，约定写在 `timer` 工具的 `payload`
/// 描述里：`src/tools/admin.ts`）。四格的**缺省口径**（缺省不猜、不留空）：
///   · `title` 缺 ⇒ `note` 第一句 ⇒ `why` ⇒ `kind` 的人话 ⇒「未命名安排」（见 [_titleOf]）；
///   · `cat` 缺 ⇒ **不涂色**、清单里不摆分类 chip；
///   · `dur` 缺 ⇒ **30 分钟**（周历块高按它算）；
///   · `action` 缺 ⇒ 不按"自主工作"计，详情里写"未写"；
///   · `scope` 写 `self` ⇒ 这是**她自己的内部事**（见 [_isOwnerFacing]）。
///
/// ## 这一页是给人看的（用户 2026-10-12 的批注）
/// 「GUI 的日程视图是给人看的，agent 自己的行动和规划不应该占主位」⇒
///   · **周历只画"用户向"的条目**（[_isOwnerFacing]）：她的内部事（记忆整理、复盘、自检）
///     **不占时间轴**；
///   · **周期条目按 `cron` 摊到它该出现的每一个星期几上**（见 [_slotsInWeek]；线上那条
///     「健身 · 每周三练」是 `cron='0 20 * * 2,4,6'` 一条，只按 `at` 画就只出一块——
///     那是规则使然，不是渲染 bug）；**认不出的 cron 一条都不画**（宁可少画，不许画错）；
///   · 「安排清单」两类都留（那才是"接下来要发生什么"），但她自己的**降级排在后面** + 灰角标；
///   · 也**不摊记忆正文**：整块「长期计划」2026-10-25 删掉了（用户点名）——记忆的家是记忆页，
///     这一页不再读 `facts.md`、也没有"去记忆页"那个入口。
class SchedulePage extends StatefulWidget {
  const SchedulePage({super.key, required this.state});

  final AppState state;

  @override
  State<SchedulePage> createState() => _SchedulePageState();
}

/// 周历的行高：设计稿是 47；窗口矮的时候往 [kMinRowHeight] 压（**不是**让整页滚）
const double kRowHeight = 47;
const double kMinRowHeight = 20;
const int kGridHours = 14; // 08:00–21:00

/// 这一页读"现在"的**唯一入口**（默认真实时钟）。
///
/// 存在的唯一理由：**用例要把"今天"钉死**。凡是"今天 + N 天"这种相对日子，在固定时刻下
/// 算出来的结果才不随"跑测试那天是周几"漂——2026-10-18（周日）那次基线里，正是这件事让
/// 4 条日程用例变红（周日跑时 `+1/+2/+3 天` 全甩到下一周，「本周安排」的读数跟着变）。
///
/// 生产路径永远走默认值 [DateTime.now]；页面里不许再直接写 `DateTime.now()`，
/// 否则注入就漏了那一处（`test/schedule_page_test.dart` 的"周日/周一双跑"会当场抓到）。
@visibleForTesting
DateTime Function() scheduleNow = DateTime.now;

class _SchedulePageState extends State<SchedulePage> {
  Map<String, dynamic>? proj;

  /// 会话清单（`GET /api/sessions`）：「到哪儿说」的名字 + 「新建安排」里那个下拉的选项。
  /// 读不到就静默降级（显示原串、下拉只剩"不用"）——它是附加信息，不该把整页拖进错误态。
  List<_Session>? sessions;

  String? error;
  bool loading = true;

  /// 周历显示的那一周（那一周的周一 00:00）
  late DateTime weekStart;

  /// 点中的那一天（`yyyy-MM-dd`；null = 没筛）
  String? selectedDay;

  /// 选中看详情的那一条（null = 还没选）
  String? selectedId;

  /// 清单里的搜索词（纯前端过滤，不碰服务端）
  String searchQuery = '';

  /// 周历那栏的形态：false = 周（时间轴）/ true = 列表
  bool calendarAsList = false;

  String? cancellingId;
  String? actionError;

  /// 「新建安排」留在这页上的两条回执
  _WakeReceipt? wakeReceipt;
  String? builtReceipt;

  @override
  void initState() {
    super.initState();
    weekStart = _weekStartOf(scheduleNow());
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
    final s = IrmiaStrings.read(context);
    final api = widget.state.api;
    // 附加信息（会话名单）自己吃自己的错，但**和主数据一起等**（一次刷新要等人等的就是同一件事）
    final extras = _loadSessions();
    try {
      final data = await api.get('/api/projection');
      if (mounted) {
        setState(() {
          proj = data is Map<String, dynamic> ? data : null;
          error = proj == null ? s.schedNotProjection : null;
          loading = false;
        });
      }
    } catch (err) {
      if (mounted) {
        setState(() {
          error = '$err';
          loading = false;
        });
      }
    }
    await extras;
  }

  Future<void> _loadSessions() async {
    try {
      final data = await widget.state.api.get('/api/sessions');
      final list = data is Map ? data['sessions'] : null;
      if (!mounted || list is! List) return;
      setState(() => sessions = [for (final item in list) _Session.from(item)]);
    } catch (_) {
      // 静默：名单只是"人认得的那半"，读不到就显示原串
    }
  }

  /// 她排着的安排（投影 `timers`）。认不出 `timerId` 的丢掉；**用户向的排前面**，同一类里按到期时刻、
  /// 只有 `cron`（没有 `at`）的排最后（它们的"下一次"在服务端，界面不猜）。
  /// ⚠ 排序带原始下标做次序（Dart 的 `List.sort` 不稳定）：同一类里顺序可预期。
  List<Map<String, dynamic>> get _timers {
    final raw = proj?['timers'];
    if (raw is! List) return const [];
    final out = [
      for (final item in raw.whereType<Map>())
        if ((item['timerId']?.toString() ?? '').isNotEmpty) item.cast<String, dynamic>(),
    ];
    final indexed = [for (var i = 0; i < out.length; i += 1) (i, out[i])];
    indexed.sort((a, b) {
      final ownerA = _isOwnerFacing(a.$2) ? 0 : 1;
      final ownerB = _isOwnerFacing(b.$2) ? 0 : 1;
      if (ownerA != ownerB) return ownerA - ownerB; // 用户向在前（周历只画这一批）
      final atA = _atOf(a.$2);
      final atB = _atOf(b.$2);
      if (atA == null && atB == null) return a.$1 - b.$1; // 都没时刻：保持投影顺序
      if (atA == null) return 1;
      if (atB == null) return -1;
      final byTime = atA.compareTo(atB);
      return byTime != 0 ? byTime : a.$1 - b.$1;
    });
    return [for (final entry in indexed) entry.$2];
  }

  /// 清单要显示的那几条：点了周历某天就只看那天，再有搜索词就再筛一层（都是纯前端）
  List<Map<String, dynamic>> get _visibleTimers {
    var out = _timers;
    final day = selectedDay;
    if (day != null) out = [for (final t in out) if (_dayKeyOf(_atOf(t)) == day) t];
    final q = searchQuery.trim().toLowerCase();
    if (q.isNotEmpty) {
      out = [
        for (final t in out)
          if (_searchTextOf(t).toLowerCase().contains(q)) t,
      ];
    }
    return out;
  }

  /// 搜索比哪几格：标题 / 到点做什么 / 为什么 / kind（都是人看得见的那几格）
  String _searchTextOf(Map<String, dynamic> timer) {
    final s = IrmiaStrings.of(context);
    final payload = timer['payload'];
    return [
      _titleOf(s, payload),
      _noteOf(payload),
      _payloadField(payload, 'why'),
      _kindOf(payload),
    ].join(' ');
  }

  /// 落不到任何一天上的条目：**用户向、但画不出这一周的日子**。
  ///
  /// 三种都算"画不出"（宁可少画，不许画错）：
  ///   · cron 认不出（步长、名字、带月/日限定的那些形状）⇒ 一条都不画；
  ///   · 压根没有 `at` 也没有 `cron`（数据不完整）；
  ///   · 只有 `at`、而那个 `at` 不在显示的这一周里（翻到别的周时它当然画不出来）。
  /// ⚠ 只数用户向的：周历只画用户向的条目，把她自己的内务也数进去就成了"说了却没画"。
  int get _unplaceableCount => _timers.where((t) {
        if (!_isOwnerFacing(t)) return false;
        final cron = _cronOf(t);
        if (cron.isNotEmpty) return _parseCron(cron) == null;
        return _atOf(t) == null;
      }).length;

  /// sid → 人名（「到哪儿说」那一格用）。读不到名单时是空表（显示原串）。
  Map<String, String> get _nameOfSid {
    final rows = sessions;
    if (rows == null) return const {};
    return {
      for (final row in rows)
        if (row.name.isNotEmpty && row.sid.isNotEmpty) row.sid: row.name,
    };
  }

  Map<String, dynamic>? get _selected {
    final id = selectedId;
    if (id == null) return null;
    for (final timer in _timers) {
      if ('${timer['timerId']}' == id) return timer;
    }
    return null;
  }

  /// **显示的这一周里要画的每一格**（周历与"列表"形态共用这一份，两个视图不许各算一套）。
  ///
  /// 规则（用户 2026-10-13 的裁定）：
  ///   · **有能算的 `cron` ⇒ 按它算**：`M H * * D` / `M H * * D,D` / `M H * * A-B` / `M H * * *`
  ///     在**当前显示的那一周**里各出一块（"每周三练"三条日子 ⇒ 三块，不是一块）；
  ///   · **cron 认不出 ⇒ 一条都不画**（宁可少画，不许画错）——进底部那行说明，绝不瞎摆；
  ///   · **没有 `cron`** ⇒ 用那一个 `at`（一次性条目照旧），落在别周的自然不会出现在本周的列里；
  ///   · 只算**用户向**的条目（她自己的内务不占时间轴）。
  List<_Slot> _slotsInWeek() {
    final weekStart = this.weekStart;
    final out = <_Slot>[];
    for (final timer in _timers) {
      if (!_isOwnerFacing(timer)) continue;
      final cron = _cronOf(timer);
      if (cron.isNotEmpty) {
        final spec = _parseCron(cron);
        if (spec == null) continue; // 算不出 ⇒ 不画
        for (final weekday in spec.weekdays) {
          final day = weekStart.add(Duration(days: weekday - 1));
          out.add(_Slot(
            timer: timer,
            dayKey: _dayKeyOf(day),
            hour: spec.hour,
            minute: spec.minute,
            fromCron: true,
          ));
        }
        continue;
      }
      final at = _atOf(timer);
      if (at == null) continue;
      out.add(_Slot(
        timer: timer,
        dayKey: _dayKeyOf(at),
        hour: at.hour,
        minute: at.minute,
        fromCron: false,
      ));
    }
    return out;
  }

  // ──────────────── 撤：`POST /api/commands/timer-cancel` ────────────────

  /// 取消一条还没触发的安排（事件由服务端的宿主出口写，见 `src/web/server.ts` 的 timer-cancel）
  Future<void> _cancelTimer(String timerId) async {
    final s = IrmiaStrings.read(context);
    if (timerId.isEmpty || cancellingId != null) return;
    final yes = await confirm(
      context,
      title: s.schedCancelTitle,
      body: s.schedCancelBody(timerId),
      confirmLabel: s.schedCancelPlan,
      danger: true,
    );
    if (!yes || !mounted) return;

    setState(() {
      cancellingId = timerId;
      actionError = null;
    });
    try {
      await widget.state.api.post('/api/commands/timer-cancel', {'timerId': timerId});
      if (!mounted) return;
      setState(() {
        cancellingId = null;
        if (selectedId == timerId) selectedId = null;
      });
      IrmiaToast.show(context, s.schedCancelled(timerId), kind: ToastKind.success);
      await load();
    } catch (err) {
      if (!mounted) return;
      setState(() {
        cancellingId = null;
        actionError = s.schedCancelFailed(timerId, '$err');
      });
      IrmiaToast.show(context, s.schedCancelFailedShort('$err'), kind: ToastKind.error);
    }
  }

  // ──────────────── 新建：顶层卡片的两条路 ────────────────

  /// 「新建安排」：一张**顶层卡片**，两条路（交给她建 / 我直接建）。
  ///
  /// 为什么主推"交给她建"（GUI.md §0 第 2 条）：她排的东西是"给未来的自己的一句话"，而 `why` 是
  /// **她自己的理由**——那正是"到点她读到的是自己想的话"的来处。直接建那条路留着（急用不能堵），
  /// 但它写的是**人的理由**，所以卡面上把这一层差别说在明面上。
  Future<void> _newSchedule() async {
    final s = IrmiaStrings.read(context);
    final outcome = await showDialog<_ScheduleOutcome>(
      context: context,
      builder: (_) => _NewScheduleCard(
        sessions: sessions ?? const [],
        sendWake: _sendSchedule,
        createTimer: _createTimer,
      ),
    );
    if (outcome == null || !mounted) return;

    final brief = outcome.brief;
    if (brief != null) {
      setState(() {
        wakeReceipt = _WakeReceipt(text: brief, deduped: outcome.deduped);
        builtReceipt = null;
      });
      if (outcome.deduped) {
        IrmiaToast.show(context, s.schedWakeDeduped, kind: ToastKind.info);
      }
      return;
    }

    final built = outcome.built;
    if (built != null) {
      setState(() {
        builtReceipt = s.schedBuilt(_builtWhen(s, built), built.note);
        wakeReceipt = null;
      });
      IrmiaToast.show(context, s.schedBuiltToast, kind: ToastKind.success);
      // 重读投影，新那条自己出现——界面绝不在本地先画一条（那就是两份真相）
      await load();
    }
  }

  Future<_WakeSent> _sendSchedule(String text) async {
    final res = await widget.state.api.post('/api/commands/wake', {'note': text});
    return _WakeSent(text, deduped: res is Map && res['deduped'] == true);
  }

  /// 「我直接建」那一路：`POST /api/commands/timer-set`（服务端走 `TimerStore.set`，事件由宿主出口写）。
  /// 七格全带上：选填的两格没填就不发，让服务端的缺省口径生效。
  Future<_BuiltTimer> _createTimer(_TimerDraft draft) async {
    final res = await widget.state.api.post('/api/commands/timer-set', {
      if (draft.atIso != null) 'at': draft.atIso!,
      if (draft.cron != null) 'cron': draft.cron!,
      'note': draft.note,
      'why': draft.why,
      if (draft.sid != null) 'sid': draft.sid!,
      if (draft.title.isNotEmpty) 'title': draft.title,
      if (draft.cat != null) 'cat': draft.cat!,
      if (draft.dur != null) 'dur': draft.dur!,
      if (draft.action != null) 'action': draft.action!,
    });
    final map = res is Map ? res : const {};
    return _BuiltTimer(
      timerId: '${map['timerId'] ?? ''}',
      at: '${map['at'] ?? ''}',
      cron: draft.cron,
      note: draft.title.isEmpty ? draft.note : draft.title,
    );
  }

  String _builtWhen(AppStrings s, _BuiltTimer built) {
    final at = DateTime.tryParse(built.at)?.toLocal();
    final when = at == null ? s.schedNoServerTime : _whenStamp(s, at);
    final cron = built.cron;
    if (cron == null || cron.isEmpty) return when;
    return s.schedRecurringWithNext(_cronLabel(s, cron), when);
  }

  // ──────────────── 搜索（纯前端筛清单） ────────────────

  Future<void> _search() async {
    final s = IrmiaStrings.read(context);
    final controller = TextEditingController(text: searchQuery);
    final query = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
        title: Text(s.schedSearchTitle, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        content: TextField(
          key: const ValueKey('schedule-search-field'),
          controller: controller,
          autofocus: true,
          onSubmitted: (value) => Navigator.of(dialogContext).pop(value),
          decoration: InputDecoration(isDense: true, hintText: s.schedSearchHint),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(''),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.onSurfaceVariant,
            ),
            child: Text(s.settingsClear),
          ),
          FilledButton.tonal(
            key: const ValueKey('schedule-search-apply'),
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: Text(s.schedSearch),
          ),
        ],
      ),
    );
    // 退场之后再销毁控制器（`showDialog` 的 Future 在弹出时就 resolve，而输入框还要几十毫秒才摘掉）
    disposeLater(controller);
    if (query == null || !mounted) return;
    setState(() => searchQuery = query.trim());
  }

  // ──────────────── 一屏 ────────────────

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        PageHeader(
          // 设计稿那条英文 eyebrow（小字）；标题按它的字号放大，副标题逐字
          eyebrow: 'YOUR TIME, THOUGHTFULLY',
          title: s.schedPageTitle,
          titleSize: 26,
          subtitle: s.schedPageSubtitle,
          action: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                key: const ValueKey('schedule-search'),
                onPressed: () => unawaited(_search()),
                tooltip: s.schedSearchTitle,
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.search_rounded, size: 18),
              ),
              const SizedBox(width: 6),
              OutlinedButton(
                key: const ValueKey('schedule-back-week'),
                onPressed: () => setState(() {
                  weekStart = _weekStartOf(scheduleNow());
                  selectedDay = null;
                }),
                // ⑦ 用户 2026-10-25：「回到本周」现在是胶囊形 ⇒ 统一成卡片圆角那套的**控件档**
                // （[IrmiaTheme.radiusCtl] = 10）。高度与隔壁「＋新建安排」逐像素一致：
                // 内边距同一套栅格（16/12），字号同一份 buttonText（主题给的）。
                style: OutlinedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: Space.x4, vertical: Space.x3),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
                  ),
                ),
                child: Text(s.schedBackToThisWeek),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                key: const ValueKey('schedule-propose'),
                onPressed: () => unawaited(_newSchedule()),
                icon: const Icon(Icons.add_rounded, size: 18),
                label: Text(s.schedNewPlan),
              ),
            ],
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(26, 14, 26, 12),
            child: loading
                ? StateBlock.loading(hint: s.schedLoading)
                : error != null
                    ? StateBlock.error(
                        message: s.schedLoadFailed('$error'),
                        hint: s.schedLoadHint,
                        onRetry: () => unawaited(load()),
                      )
                    : _body(),
          ),
        ),
      ],
    );
  }

  /// 不滚的那一版主体：回执（可有）+ 计数卡（定高）+ 工作区（Expanded）。
  ///
  /// 页脚那句「安排只是一个行动机会 · 到点后…」2026-10-25 删掉了（用户点名）：
  /// 它是全页最大的一块"解释性"文字，而这一页的每一块已经各自说清了自己是什么。
  Widget _body() {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(
      builder: (context, box) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (wakeReceipt != null || builtReceipt != null) ...[
            if (wakeReceipt != null) _receiptBlock(scheme, wakeReceipt!),
            if (builtReceipt != null) _builtBlock(scheme, builtReceipt!),
            const SizedBox(height: 12),
          ],
          _summary(),
          const SizedBox(height: 14),
          Expanded(child: _workspace(box.maxHeight)),
        ],
      ),
    );
  }

  /// 工作区：左周历 + 右（清单 ＋ 详情）。
  ///
  /// ⚠ 这里的**阈值是量出来的、不是猜的**：`Expanded` 把"剩下的高度"给工作区，而右栏的
  /// 清单是 `Expanded`（可以缩到很小），所以真正怕溢出的是那块**定高块**（详情）。
  /// 高度不够时唯一能让位的就是详情（整页不滚是硬要求）；2026-10-25 删掉长期计划之后，
  /// 从前那档 `≥ 620 才摆两块附加` 的阈值跟着一起删了。
  ///
  /// 阈值口径（`available` = 工作区拿到的高度）：
  ///   · ≥ 420：清单 + 详情；
  ///   · < 420：只剩清单（矮到这一步，明细就摆不下了）。
  Widget _workspace(double available) {
    final showDetail = available >= 420;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(flex: 155, child: _weekPanel()),
        const SizedBox(width: 16),
        Expanded(
          flex: 85,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(child: _listPanel()),
              if (showDetail) ...[
                const SizedBox(height: 12),
                _detailPanel(),
              ],
            ],
          ),
        ),
      ],
    );
  }

  // ── 分区一：四张计数卡（设计稿的 .summary；都是真数） ──

  Widget _summary() {
    final s = IrmiaStrings.of(context);
    final timers = _timers;
    // 本周 = 今天所在那一周（周一起 7 天），与周历翻到哪一周无关
    final weekStart = _weekStartOf(scheduleNow());
    final thisWeek = timers.where((t) {
      final at = _atOf(t);
      if (at == null) return false;
      final key = _dayKeyOf(at);
      return key.compareTo(_dayKeyOf(weekStart)) >= 0 &&
          key.compareTo(_dayKeyOf(weekStart.add(const Duration(days: 6)))) <= 0;
    }).length;
    final selfWork = timers.where((t) => _actionOf(t['payload']) == 'self').length;
    return Row(
      children: [
        Expanded(
          child: _Stat(
            label: s.schedStatThisWeek,
            value: thisWeek.toString().padLeft(2, '0'),
            note: s.schedStatThisWeekNote,
            icon: Icons.event_available_rounded,
          ),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: _Stat(
            label: s.schedStatWaiting,
            value: timers.length.toString().padLeft(2, '0'),
            note: s.schedStatWaitingNote,
            icon: Icons.alarm_rounded,
          ),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: _Stat(
            label: s.schedStatSelfWork,
            value: selfWork.toString().padLeft(2, '0'),
            note: s.schedStatSelfWorkNote,
            icon: Icons.auto_awesome_rounded,
          ),
        ),
        const SizedBox(width: 13),
        Expanded(
          // 她的"草稿"今天**没有任何存储**（提示词里那句"把想说的话攒成草稿"而已）⇒ 0 是真的 0，
          // 注脚把这件事说白：不是"零条草稿"，是"还没有落盘的地方"
          child: _Stat(
            label: s.schedStatDrafts,
            value: '00',
            note: s.schedStatDraftsNote,
            icon: Icons.chat_bubble_outline_rounded,
          ),
        ),
      ],
    );
  }

  // ── 分区二：周历（左栏主体） ──

  /// 周历：一周 7 列 + 08:00–21:00 时间轴；块按 `at` 定位、按 `dur`（缺省 30）撑高。
  ///
  /// **行高由拿到的约束算**（不是猜一个固定 chrome）：网格那一块是 `Expanded`，它先被父级
  /// 定好高度，再在里面按 `高度 / 14` 求行高（夹在 [kMinRowHeight]…[kRowHeight]）。
  /// 这样"窗口矮 ⇒ 行高压下去"是**布局本身的结果**，不靠一处手算的常量——上一版就是手算的
  /// （`chrome = 46+44+…`），真机上量出来差 16px，直接溢出。
  Widget _weekPanel() {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final days = [for (var i = 0; i < 7; i += 1) weekStart.add(Duration(days: i))];
    final today = _dayKeyOf(scheduleNow());
    return _Panel(
      children: [
        Row(
          // 标题只剩一行了（① 删掉下面那行说明）：与右边那排小控件居中对齐
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              // ① 用户 2026-10-25：删掉标题下面那行「选择一个条目，查看具体安排」。
              // 周历本身就用星期行 + 刻度说清了自己是什么，那行只是复述。
              child: Text(s.schedCalendarTitle, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            ),
            _miniButton('schedule-prev-week', Icons.chevron_left_rounded, s.schedPrevWeek,
                () => setState(() {
                      weekStart = weekStart.subtract(const Duration(days: 7));
                      selectedDay = null;
                    })),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
              child: Text(s.schedWeekRange(weekStart.month, weekStart.day, days.last.day),
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            ),
            _miniButton('schedule-next-week', Icons.chevron_right_rounded, s.schedNextWeek,
                () => setState(() {
                      weekStart = weekStart.add(const Duration(days: 7));
                      selectedDay = null;
                    })),
            const SizedBox(width: 8),
            _ViewToggle(
              list: calendarAsList,
              onChanged: (value) => setState(() => calendarAsList = value),
            ),
          ],
        ),
        const SizedBox(height: 8),
        // 星期行：今天那格是实心圆（设计稿的 .day-head.today）
        Row(
          children: [
            const SizedBox(width: 44),
            for (final day in days)
              Expanded(
                child: InkWell(
                  key: ValueKey('schedule-day-${_dayKeyOf(day)}'),
                  onTap: () => setState(
                      () => selectedDay = selectedDay == _dayKeyOf(day) ? null : _dayKeyOf(day)),
                  borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
                  child: Container(
                    padding: const EdgeInsets.symmetric(vertical: 5),
                    decoration: BoxDecoration(
                      color: selectedDay == _dayKeyOf(day)
                          ? scheme.primary.withValues(alpha: 0.12)
                          : null,
                      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
                    ),
                    child: Column(
                      children: [
                        Text(
                          _weekdayLabel(s, day.weekday),
                          style: TextStyle(
                            fontSize: 10.5,
                            color: _dayKeyOf(day) == today ? scheme.primary : scheme.onSurfaceVariant,
                            fontWeight: _dayKeyOf(day) == today ? FontWeight.w700 : null,
                          ),
                        ),
                        const SizedBox(height: 5),
                        Container(
                          width: 24,
                          height: 24,
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: _dayKeyOf(day) == today ? scheme.primary : null,
                            shape: BoxShape.circle,
                          ),
                          child: Text(
                            '${day.day}',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
                              color: _dayKeyOf(day) == today ? scheme.onPrimary : scheme.onSurface,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
        // 网格 / 列表都拿"剩下的高度"（Expanded）：行高与列数从这块约束里算 ⇒ 不会溢出。
        // ⚠ 外面这层 `ClipRect` 是**结构上的兜底**：列表形态的预算万一算漏一行，也只裁自己那一块，
        // 不会压到底下的图例上（用户 2026-10-12 的截图三）。
        Expanded(
          child: ClipRect(
            child: LayoutBuilder(
              builder: (context, box) => calendarAsList
                  ? _calendarList(scheme, days, box.maxHeight)
                  : _timeGrid(
                      scheme,
                      days,
                      // 下限取 8 而不是设计稿那种 20：极矮的窗口里宁可格子很薄，也不许溢出
                      (box.maxHeight / kGridHours).clamp(8.0, kRowHeight),
                    ),
            ),
          ),
        ),
        const SizedBox(height: 8),
        // 四色图例（设计稿的 .calendar-foot）。⚠ 这一块是**定高**的：上面那块（时间轴/列表）
        // 摆不下时只许裁自己——`ClipRect` 兜底，绝不让列表文字压到图例上（用户 2026-10-12 的截图三）
        Wrap(
          key: const ValueKey('schedule-legend'),
          spacing: 14,
          runSpacing: 6,
          children: [
            for (final category in _categories)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: category.of(context),
                      // 图例那颗是**圆点**：正圆走 [Shape.pill]（999 = 按尺寸自己算圆），
                      // 不是"半径 3 的小方块"。见 design_tokens 的三档口径。
                      borderRadius: Shape.pill,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(category.labelOf(s),
                      style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
                ],
              ),
          ],
        ),
        // ⚠ 这里**不再写**"块高按 dur 算 / 分类色按 cat"那两句技术说明（用户 2026-10-12 批注
        // 「此文字无意义可去掉」）。剩下这一句留着：它说的是"有 N 条周期条目画不到格子里，
        // 去清单看"——是**数据**不是实现说明。
        //
        // ⑤⑥ 2026-10-25 用户点名的两行一起删了：
        //   · 「不在 08:00-21:00 这一格里：N 条（在清单里）」；
        //   · 页脚「安排只是一个行动机会 · 到点后…」。
        if (_unplaceableCount > 0)
          Text(s.schedUnplaceable(_unplaceableCount),
              style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
      ],
    );
  }

  Widget _miniButton(String key, IconData icon, String tooltip, VoidCallback onTap) => IconButton(
        key: ValueKey(key),
        onPressed: onTap,
        tooltip: tooltip,
        visualDensity: VisualDensity.compact,
        icon: Icon(icon, size: 18),
      );

  /// 时间轴网格：左边整点刻度 + 7 列（每列是 Stack：整点线 + 按时刻定位的块）
  Widget _timeGrid(ColorScheme scheme, List<DateTime> days, double rowH) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 44,
          child: Column(
            children: [
              for (var i = 0; i < kGridHours; i += 1)
                SizedBox(
                  height: rowH,
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: Text('${_p2(8 + i)}:00',
                        style: TextStyle(fontSize: 9, color: scheme.onSurfaceVariant)),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: Container(
            key: const ValueKey('schedule-grid'),
            height: rowH * kGridHours,
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: scheme.outlineVariant)),
            ),
            child: Row(
              children: [
                for (final day in days) Expanded(child: _dayColumn(scheme, day, rowH)),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _dayColumn(ColorScheme scheme, DateTime day, double rowH) {
    final key = _dayKeyOf(day);
    // 这一格里要画的块 = 本周的槽位里落在这一天的那些（周期条目会在它每一个该出现的星期几上各出一块）
    final slots = [
      for (final slot in _slotsInWeek())
        if (slot.dayKey == key &&
            slot.hour * 60 + slot.minute >= _gridStartMinute &&
            slot.hour * 60 + slot.minute <= _gridEndMinute)
          slot,
    ];
    return Container(
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6))),
      ),
      child: Stack(
        children: [
          Column(
            children: [
              for (var i = 0; i < kGridHours; i += 1)
                Container(
                  height: rowH,
                  decoration: BoxDecoration(
                    border: Border(
                      top: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.5)),
                    ),
                  ),
                ),
            ],
          ),
          for (final slot in slots) _block(scheme, slot, rowH),
        ],
      ),
    );
  }

  /// 一个块：`top` 由**这一格那个时刻**定（一次性那条用它的 `at`；周期条目用它 `cron` 算出来的钟点）、
  /// `高` 由 `dur`（缺省 30）定——位置与高度都是"到点那一刻 + 约定时长"，不是"这段时间她一定在忙"。
  ///
  /// 块里摆几行**按块高算**（`32` 起步，正好放得下"钟点 + 一行标题"；行高被压到很薄时只留钟点）：
  /// 固定的两行标题塞进 26px 的块里会溢出——那是上一版真机上的一条黄黑条。
  /// 周期算出来的块在钟点后面多一个「周期」（用户 2026-10-13：画出来的块要能跟一次性条目区分）。
  Widget _block(ColorScheme scheme, _Slot slot, double rowH) {
    final s = IrmiaStrings.of(context);
    final timer = slot.timer;
    final id = '${timer['timerId']}';
    final category = _categoryOf(timer['payload']);
    final accent = category?.of(context) ?? scheme.onSurfaceVariant;
    final top = math.max(0.0, ((slot.hour * 60 + slot.minute) - _gridStartMinute) / 60 * rowH);
    final gridHeight = rowH * kGridHours;
    final wanted = math.max(32.0, (_durOf(timer['payload']) / 60) * rowH - 3);
    final height = math.min(wanted, math.max(24.0, gridHeight - top));
    const padding = 7.0;
    final inner = height - padding;
    const timeLine = 11.0;
    const titleLine = 12.0;
    final titleLines = inner - timeLine >= titleLine * 2 ? 2 : (inner - timeLine >= titleLine ? 1 : 0);
    return Positioned(
      // 键带 dayKey：同一条周期条目会在好几个星期几上各出一块（键必须唯一）
      key: ValueKey('schedule-block-$id-${slot.dayKey}'),
      top: top,
      left: 2,
      right: 2,
      height: height,
      child: InkWell(
        onTap: () => setState(() => selectedId = id),
        borderRadius: BorderRadius.circular(7),
        child: Container(
          padding: const EdgeInsets.fromLTRB(6, 4, 4, 3),
          decoration: BoxDecoration(
            color: category == null
                ? scheme.surfaceContainer
                : accent.withValues(
                    alpha: Theme.of(context).brightness == Brightness.dark ? 0.22 : 0.16),
            border: Border(left: BorderSide(color: accent, width: 3)),
            borderRadius: BorderRadius.circular(7),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (inner >= timeLine)
                Text(slot.fromCron ? s.schedTimeRecurring(_p2(slot.hour), _p2(slot.minute)) : _hhmmOf(slot.hour, slot.minute),
                    maxLines: 1,
                    style: TextStyle(
                        fontSize: 8, fontWeight: FontWeight.w700, color: scheme.onSurfaceVariant)),
              if (titleLines > 0)
                Text(
                  _titleOf(s, timer['payload']),
                  maxLines: titleLines,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 9.5, fontWeight: FontWeight.w600, height: 1.25),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// 「列表」形态：按天分组，每行 钟点 · 标题 · 说明 · 分类 chip（设计稿的 list-view）。
  ///
  /// ⚠ **它不滚**：这一块在"整页不滚、只有清单滚"的纪律里也算定高块。所以按拿到的
  /// [maxHeight] 只摆放得下的那几行，剩下的**如实说一句**「还有 N 条，看右边的清单」——
  /// 宁可少摆几行并说明，也不给这一栏加第二条滚动条、更不静默截断。
  /// ⚠ **按天分组的表头也算进预算**（用户 2026-10-12 修 bug：上一版只算了条目行 ⇒ 表头把那几行
  /// 顶出预算，压到图例上）。外面还有一层 `ClipRect` 兜底：真算漏了也只裁自己，不压别人。
  /// ⚠ 同样只画用户向的（与时间轴一个判据）。
  Widget _calendarList(ColorScheme scheme, List<DateTime> days, double maxHeight) {
    final s = IrmiaStrings.of(context);
    const rowHeight = 30.0; // 一行（含内边距）的预算
    const headerHeight = 24.0; // 一天的表头（周几 + 日期）
    final budget = (maxHeight / rowHeight).floor();
    final rows = <Widget>[];
    var planned = 0;
    var total = 0;
    for (final day in days) {
      final key = _dayKeyOf(day);
      // 与时间轴同一份槽位（周期条目在它的每个星期几上都出现一次）
      final items = [for (final slot in _slotsInWeek()) if (slot.dayKey == key) slot];
      if (items.isEmpty) continue;
      total += items.length;
      // 这一天的"表头 + 条目"整体摆不下就整天不摆（摆半截更像是画错了）
      if (planned + 1 + items.length > budget) continue;
      planned += 1 + items.length;
      rows.add(SizedBox(
        height: headerHeight,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(_weekdayLabel(s, day.weekday),
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
            const SizedBox(width: 8),
            Text(s.schedMonthDay(day.month, day.day),
                style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
          ],
        ),
      ));
      for (final slot in items) {
        final payload = slot.timer['payload'];
        final category = _categoryOf(payload);
        rows.add(Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 42,
                child: Text(_hhmmOf(slot.hour, slot.minute),
                    style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_titleOf(s, payload),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                    if (_payloadField(payload, 'why').isNotEmpty)
                      Text(_payloadField(payload, 'why'),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
                  ],
                ),
              ),
              // 周期出现的那几行也要跟一次性条目分得开（与块上的「· 周期」同一套语言）
              if (slot.fromCron) ...[
                _Pill(s.schedRecurringPill),
                const SizedBox(width: 6),
              ],
              if (category != null) _Pill(category.labelOf(s), tone: category.of(context)),
            ],
          ),
        ));
      }
    }
    if (rows.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text(s.schedWeekEmpty, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
      );
    }
    final hidden = total - planned;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ...rows,
        if (hidden > 0)
          Text(s.schedWeekHidden(hidden),
              style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
      ],
    );
  }

  // ── 分区三：安排清单（**这一块是整页唯一可滚的地方**） ──

  Widget _listPanel() {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final timers = _visibleTimers;
    final day = selectedDay;
    final query = searchQuery.trim();
    final err = actionError;
    final filtered = day != null || query.isNotEmpty;
    return _Panel(
      padding: const EdgeInsets.fromLTRB(18, 16, 8, 12),
      children: [
        Padding(
          padding: const EdgeInsets.only(right: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(s.schedListTitle, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    // ② 用户 2026-10-25：删掉「安排清单」下面那行「接下来要发生的事」。
                    // 筛选态（只看某天 / 匹配某个词 / 条数）**仍然要有一行**——那是当前读数，
                    // 不是复述；所以这里只在筛选时出现，标题下不再常驻第二行。
                    if (day != null || query.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(
                          [
                            if (day != null) s.schedFilterDay(_dayLabel(s, day)),
                            if (query.isNotEmpty) s.schedFilterQuery(query),
                            s.schedFilterCount(timers.length),
                          ].join(' · '),
                          style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                        ),
                      ),
                  ],
                ),
              ),
              if (day != null)
                TextButton(
                  key: const ValueKey('schedule-clear-day'),
                  onPressed: () => setState(() => selectedDay = null),
                  style: _linkStyle,
                  child: Text(s.schedShowAll),
                ),
              if (query.isNotEmpty)
                TextButton(
                  key: const ValueKey('schedule-clear-search'),
                  onPressed: () => setState(() => searchQuery = ''),
                  style: _linkStyle,
                  child: Text(s.schedClearSearch),
                ),
            ],
          ),
        ),
        if (err != null) ...[
          const SizedBox(height: 6),
          StateBlock.error(
            message: err,
            hint: s.schedActionGoneHint,
            padding: const EdgeInsets.symmetric(vertical: 6),
          ),
        ],
        const SizedBox(height: 8),
        Expanded(
          child: timers.isEmpty
              ? (filtered
                  ? HintLine(s.schedListNoMatch)
                  : GuideBar(
                      key: const ValueKey('schedule-empty'),
                      icon: Icons.event_available_rounded,
                      text: s.schedListEmpty,
                      actionLabel: s.schedNewPlan,
                      onAction: () => unawaited(_newSchedule()),
                      hint: s.schedListEmptyHint,
                    ))
              : ListView.builder(
                  // ⚠ 整页唯一可滚的一处（用例钉着这一条：页面里只许有这一个 Scrollable）
                  key: const ValueKey('schedule-list'),
                  padding: const EdgeInsets.only(right: 10, bottom: 4),
                  itemCount: timers.length,
                  itemBuilder: (context, index) {
                    final timer = timers[index];
                    final id = '${timer['timerId']}';
                    return _AgendaItem(
                      key: ValueKey('schedule-item-$id'),
                      timer: timer,
                      names: _nameOfSid,
                      selected: selectedId == id,
                      divider: index > 0,
                      onTap: () => setState(() => selectedId = selectedId == id ? null : id),
                    );
                  },
                ),
        ),
      ],
    );
  }

  static final ButtonStyle _linkStyle = TextButton.styleFrom(
    padding: const EdgeInsets.symmetric(horizontal: 10),
    minimumSize: const Size(0, 30),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
  );

  // ── 分区四：选中详情（定高，不滚） ──

  Widget _detailPanel() {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final timer = _selected;
    final id = timer == null ? '' : '${timer['timerId']}';
    final payload = timer?['payload'];
    final cron = timer == null ? '' : _cronOf(timer);
    final category = _categoryOf(payload);
    final action = _actionOf(payload);
    final at = timer == null ? null : _atOf(timer);
    final sid = _payloadField(payload, 'sid');
    final why = _payloadField(payload, 'why');
    final note = _noteOf(payload);
    final dur = timer == null ? null : _durOf(payload);
    final durExplicit = payload is Map && payload['dur'] is num;
    return _Panel(
      key: const ValueKey('schedule-detail'),
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('SELECTED PLAN',
                      style: TextStyle(
                          fontSize: 9.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.7,
                          color: scheme.primary)),
                  const SizedBox(height: 5),
                  Text(
                    timer == null ? s.schedDetailPlaceholder : _titleOf(s, payload),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, height: 1.35),
                  ),
                ],
              ),
            ),
            if (timer != null) ...[
              if (category != null) ...[
                _Pill(category.labelOf(s), tone: category.of(context)),
                const SizedBox(width: 6),
              ],
              _Pill(_statusOf(s, timer), tone: IrmiaTheme.ok),
            ],
          ],
        ),
        // ③ 用户 2026-10-25：删掉「选择一个安排」下面那段说明
        // （"点清单或周历里的任意一条…"整段）。没选中时这一格就只留标题，
        // 不再用一段话教人怎么点。
        if (timer != null) ...[
          const SizedBox(height: 8),
          _DetailRow(
            label: s.schedFieldWhen,
            value: at == null
                ? (cron.isEmpty ? s.overviewTimerUnknownTime : s.schedDetailRecurring(_cronLabel(s, cron)))
                : '${_whenStamp(s, at)}${cron.isEmpty ? '' : s.schedDetailTimeSuffix(_cronLabel(s, cron))}',
          ),
          if (why.isNotEmpty) _DetailRow(label: s.schedFieldWhy, value: why),
          if (note.isNotEmpty) _DetailRow(label: s.schedFieldWhat, value: note),
          if (sid.isNotEmpty) _DetailRow(label: s.schedFieldWhere, value: _sidLabel(s, sid, _nameOfSid)),
          _DetailRow(
            label: s.schedFieldDuration,
            value: durExplicit ? s.schedMinutes(dur) : s.schedMinutesDefault(dur),
            muted: !durExplicit,
          ),
          _DetailRow(
            label: s.schedFieldAfter,
            value: action.isEmpty ? s.schedUnwritten : _actionLabel(s, action),
            muted: action.isEmpty,
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              Text(id,
                  style: TextStyle(
                      fontFamily: 'monospace', fontSize: 10.5, color: scheme.onSurfaceVariant)),
              const Spacer(),
              TextButton(
                key: ValueKey('schedule-cancel-$id'),
                onPressed: cancellingId == null ? () => unawaited(_cancelTimer(id)) : null,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  minimumSize: const Size(0, 30),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(s.schedCancelPlan),
              ),
            ],
          ),
        ],
      ],
    );
  }

  /// 「交给她建」的回执：只说"话送到了"，**不说"排好了"**（GUI.md §3.3 纪律 4）
  Widget _receiptBlock(ColorScheme scheme, _WakeReceipt value) {
    final s = IrmiaStrings.of(context);
    return Container(
      key: const ValueKey('schedule-receipt'),
      padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.primary.withValues(alpha: 0.28)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(
              value.deduped ? s.schedWakeDeduped : s.schedWakeReceipt(value.text),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurface),
            ),
          ),
          if (!value.deduped)
            TextButton(
              key: const ValueKey('schedule-receipt-chat'),
              onPressed: () => widget.state.setPage('chat'),
              style: _linkStyle,
              child: Text(s.schedSeeChat),
            ),
        ],
      ),
    );
  }

  /// 「我直接建」的回执：这一条**服务端已经回执、也已经进了投影**，所以可以照实说"已经排上了"
  Widget _builtBlock(ColorScheme scheme, String text) {
    final s = IrmiaStrings.of(context);
    return Container(
      key: const ValueKey('schedule-built-receipt'),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.ok.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.ok.withValues(alpha: 0.3)),
      ),
      child: Text(
        s.schedBuiltReceipt(text),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurface),
      ),
    );
  }
}

// ════════════════════════════════ 约定与常量 ════════════════════════════════

/// 四个分类（`payload.cat`）+ 两种主题下的色值。**色值放本页**（不进 `theme.dart`）：
/// 它们是这一个设计稿的图例色，与 `IrmiaTheme` 那四色语义色不是一回事。
class _Category {
  const _Category(this.key, this.light, this.dark);

  /// 稳定 id（`payload.cat` 写英文键时用它；**永不翻译**）
  final String key;
  final Color light;
  final Color dark;

  /// 界面上的名字（图例 / chip / 下拉项都走它）
  String labelOf(AppStrings s) => switch (key) {
        'work' => s.schedCatWork,
        'personal' => s.schedCatPersonal,
        'life' => s.schedCatLife,
        _ => s.schedCatRoutine,
      };

  Color of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

const List<_Category> _categories = [
  _Category('work', Color(0xFF8E75D5), Color(0xFFA18AE5)),
  _Category('personal', Color(0xFFD779A8), Color(0xFFE8A4C7)),
  _Category('life', Color(0xFF5D9B8B), Color(0xFF82C4AE)),
  _Category('routine', Color(0xFFC28C4E), Color(0xFFEDC58E)),
];

/// 分类：`payload.cat` 写英文键（`work`）或人话（`工作学习`）都认；**认不出就不涂色**。
_Category? _categoryOf(Object? payload) {
  final raw = _payloadField(payload, 'cat');
  if (raw.isEmpty) return null;
  final text = raw.toLowerCase();
  for (final category in _categories) {
    if (text == category.key) return category;
  }
  // 她可能写中文分类名（数据，见 kScheduleCategoryAliases）；也可能写英文键
  for (final entry in kScheduleCategoryAliases.entries) {
    if (!text.contains(entry.key)) continue;
    for (final category in _categories) {
      if (category.key == entry.value) return category;
    }
  }
  for (final category in _categories) {
    if (text.contains(category.key)) return category;
  }
  return null;
}

// ════════════════════════════════ 周历的槽位与 cron ════════════════════════════════

/// 时间轴画的是 08:00–21:00 这一格（两端都算在内）
const int _gridStartMinute = 8 * 60;
const int _gridEndMinute = 21 * 60;

/// 周历里**要画的一格**：哪一条、哪一天、几点、是不是从 `cron` 算出来的周期出现
class _Slot {
  const _Slot({
    required this.timer,
    required this.dayKey,
    required this.hour,
    required this.minute,
    required this.fromCron,
  });

  final Map<String, dynamic> timer;
  final String dayKey;
  final int hour;
  final int minute;

  /// true = 这一格是**周期出现**（块上标"周期"）；false = 一次性那条 `at`
  final bool fromCron;
}

/// 解析**我们自己在用的那几种 cron 形状**，认不出就给 `null`（调用方照"不画"处理）。
///
/// 支持：`M H * * *`（每天）· `M H * * D`（每周某天）· `M H * * D,D,…`（每周几天，线上那条
/// 「健身 · 每周三练」就是 `0 20 * * 2,4,6`）· `M H * * A-B`（范围，如 `1-5`）· 以及它们的组合。
/// **不支持**（⇒ 认不出 ⇒ 不画）：日/月两格不是 `*`、钟点或分钟带 `*`/步长/列表、星期带步长或名字。
/// 判据是"宁可不画"：摆错位置比少摆一块更糟（用户 2026-10-13）。
_CronSpec? _parseCron(String expr) {
  final parts = expr.trim().split(RegExp(r'\s+'));
  if (parts.length != 5) return null;
  if (parts[2] != '*' || parts[3] != '*') return null; // 日/月有限定 ⇒ 算不出"每周几"
  if (!RegExp(r'^\d{1,2}$').hasMatch(parts[0]) || !RegExp(r'^\d{1,2}$').hasMatch(parts[1])) return null;
  final minute = int.parse(parts[0]);
  final hour = int.parse(parts[1]);
  if (minute > 59 || hour > 23) return null;

  final weekdays = <int>{};
  final dayField = parts[4];
  if (dayField == '*') {
    weekdays.addAll(const [1, 2, 3, 4, 5, 6, 7]);
  } else {
    for (final token in dayField.split(',')) {
      final range = RegExp(r'^(\d)-(\d)$').firstMatch(token);
      if (range != null) {
        final from = int.parse(range.group(1)!);
        final to = int.parse(range.group(2)!);
        if (to > 7 || from > to) return null;
        for (var n = from; n <= to; n += 1) {
          weekdays.add(n == 0 ? 7 : n); // cron 的 0/7 都是周日；Dart 的 weekday 里周日是 7
        }
        continue;
      }
      if (!RegExp(r'^\d$').hasMatch(token)) return null; // `*/2` / `MON` 这类认不出
      final n = int.parse(token);
      if (n > 7) return null;
      weekdays.add(n == 0 ? 7 : n);
    }
  }
  if (weekdays.isEmpty) return null;
  return _CronSpec(hour: hour, minute: minute, weekdays: weekdays);
}

/// 解析出来的 cron（只留"画块要用的那三样"）
class _CronSpec {
  const _CronSpec({required this.hour, required this.minute, required this.weekdays});

  final int hour;
  final int minute;

  /// 1=周一 … 7=周日（与 `DateTime.weekday` 同一套编号）
  final Set<int> weekdays;
}

String _hhmmOf(int hour, int minute) => '${_p2(hour)}:${_p2(minute)}';

/// 「到点做什么」的三档（`payload.action`）的人话——**详情面板**用（她那一侧的词）
/// 「新建安排」卡片里那三档的**人这一侧**说法（同一个数据值，换成人话；默认「到点提醒我」）。
/// 为什么两份词：卡片是人在填（"提醒我"），详情面板是读她写的东西（"提醒你"）——
/// 数据值都是 `notify`/`self`/`draft`，不因为文案不同而分叉。
/// 「新建安排」卡片里那三档的人说法（值走文案表；键是数据值，判据只此一处）
Map<String, String> _actionChoiceItems(AppStrings s) => <String, String>{
      'notify': s.schedChoiceNotify,
      'self': s.schedChoiceSelf,
      'draft': s.schedChoiceDraft,
    };

/// **框架自己的内务** kind（与"她自报的内部事"一样**不上周历**）。
/// 目前只有一种：`memory-maintain`（每日记忆整理，`src/persona/memory-maintain.ts` 的常量）。
/// ⚠ `wait` **不在这里**：那是"过一会儿叫我"的定时唤醒，内容多半是替用户记的事 ⇒ 按缺省算用户向。
/// ⚠ 与 `src/tools/admin.ts` 的 `TIMER_FRAMEWORK_CHORE_KINDS` **必须一致**（两份实现、各有用例）。
const List<String> _frameworkChoreKinds = ['memory-maintain'];

/// 这一条**是不是给用户看的**（周历只画用户向的；清单里两类都留、用户向在前）。
///
/// 判据**黑名单式**（缺省用户向——默认可见比默认隐藏安全），按顺序、先命中先定：
///   ① `payload.by === 'human'` ⇒ **用户向**（人自己建的，一律算用户向，这条最优先）；
///   ② `payload.scope === 'self'` ⇒ **她自己的事**；
///   ③ `payload.kind` 命中 [_frameworkChoreKinds] ⇒ **她自己的事**；
///   ④ 其余 ⇒ **用户向**（`wait`/`set` 那些多半是"到点提醒用户"的事，没有信号时不该被藏起来）。
///
/// ⚠ **不看 `payload.action`**：那是"到点做什么动作"，与"给谁看"正交——拿它当判据会把用户的
/// "每周复盘""整理周计划"一起挡在周历外。
/// ⚠ 与 `src/tools/admin.ts` 的 `isOwnerFacingTimer` 是**两份等价实现**（界面读同一份投影，
/// 但跨语言不能共享代码）：**改一处就要改另一处**，两边用例各钉一遍。
bool _isOwnerFacing(Map<String, dynamic> timer) {
  final payload = timer['payload'];
  if (payload is! Map) return true; // 旧形状（字符串/null）：按用户向
  if (payload['by'] == 'human') return true;
  if (payload['scope'] == 'self') return false;
  final kind = payload['kind'];
  if (kind is String && _frameworkChoreKinds.contains(kind)) return false;
  return true;
}

String _actionLabel(AppStrings s, String action) => switch (action) {
      'self' => s.schedActionSelf,
      'notify' => s.schedActionNotify,
      'draft' => s.schedActionDraft,
      _ => action,
    };

/// `payload.kind` 的人话。**这是"翻译"不是"编"**：`kind` 本来就写在数据里，
/// 而现场那条现存 cron（`{kind:'memory-maintain'}`）没有 `title`/`note`/`why`——
/// 不翻它，那一行就是空白。
String _kindLabel(AppStrings s, String kind) => switch (kind) {
      'memory-maintain' => s.schedKindMemoryMaintain,
      'wait' => s.schedKindWait,
      _ => kind,
    };

String _kindOf(Object? payload) => _payloadField(payload, 'kind');

/// 标题的**退化链**（用户 2026-10-12 定）：`title` → `note` 第一句 → `why` → `kind` 的人话
/// →「未命名安排」。**每一级都是数据里写着的东西**，一级都取不到才用最后那句兜底。
String _titleOf(AppStrings s, Object? payload) {
  final title = _payloadField(payload, 'title');
  if (title.isNotEmpty) return title;
  final first = _firstSentence(_noteOf(payload));
  if (first.isNotEmpty) return first;
  final why = _payloadField(payload, 'why');
  if (why.isNotEmpty) return why;
  final kind = _kindOf(payload);
  if (kind.isNotEmpty) return _kindLabel(s, kind);
  return s.schedUntitled;
}

/// 一句话里的第一句（"到点做什么"常常是两句话，标题只取第一句）
String _firstSentence(String text) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.isEmpty) return '';
  final match = RegExp(kScheduleFirstSentencePattern).firstMatch(flat);
  return (match?.group(0) ?? flat).trim();
}

/// 状态 chip（设计稿 `statusLabel` 里**算得出来的那三档**）：
/// `action==='draft'` ⇒ 待分享草稿；有条目带 `cron` ⇒ 周期任务；其余 ⇒ 待触发。
/// 「已完成 / 已取消」不在这里：投影里只有"还没到点的"（触发即出表），没有终态可显示。
String _statusOf(AppStrings s, Map<String, dynamic> timer) {
  if (_actionOf(timer['payload']) == 'draft') return s.schedStatusDraft;
  if (_cronOf(timer).isNotEmpty) return s.schedStatusRecurring;
  return s.schedStatusWaiting;
}

// ════════════════════════════════ 小件 ════════════════════════════════

/// 发出去的那一句话（照原样带回这一页做回执）
class _WakeSent {
  const _WakeSent(this.text, {required this.deduped});

  final String text;

  /// true = 服务端按 5 秒幂等键把它当成同一条丢掉了（**没有送到她手上**）
  final bool deduped;
}

class _WakeReceipt {
  const _WakeReceipt({required this.text, required this.deduped});

  final String text;
  final bool deduped;
}

/// 幂等键撞上时的那句话。**与聊天页逐字相同**：值走文案表（`s.schedWakeDeduped`）。

/// 卡片外壳：与设计稿的 `.panel` 同一形态（surface + hairline 描边 + radiusCard）
class _Panel extends StatelessWidget {
  const _Panel({super.key, required this.children, this.padding});

  final List<Widget> children;
  final EdgeInsets? padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: padding ?? const EdgeInsets.fromLTRB(18, 16, 18, 14),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
    );
  }
}

/// 一张计数卡（设计稿的 `.stat`）：标签 / 大数 / 注脚 + 右上角图标。
/// ⚠ **高度压到设计稿的约 2/3**（用户 2026-10-12 批注「四张计数卡偏大 ⇒ 缩小，别占掉半屏」）：
/// 内边距 12→8、大数 23→17、图标 30→22 —— 数值与注脚都留着，只是不再那么占地方。
class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.note, required this.icon});

  final String label;
  final String value;
  final String note;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: ValueKey('schedule-stat-$label'),
      padding: const EdgeInsets.fromLTRB(13, 6, 10, 6),
      decoration: BoxDecoration(
        color: scheme.surface,
        border: Border.all(color: scheme.outlineVariant),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                        fontSize: 10.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 1),
                Text(value,
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.w700, letterSpacing: -0.4)),
                const SizedBox(height: 1),
                Text(note,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 9.5, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          Container(
            width: 22,
            height: 22,
            decoration: BoxDecoration(
              color: scheme.primary.withValues(alpha: 0.13),
              borderRadius: BorderRadius.circular(7),
            ),
            child: Icon(icon, size: 13, color: scheme.primary),
          ),
        ],
      ),
    );
  }
}

/// 「周 / 列表」切换（设计稿那个小 pill toggle）
class _ViewToggle extends StatelessWidget {
  const _ViewToggle({required this.list, required this.onChanged});

  /// true = 列表形态
  final bool list;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        // 分段控件属于"控件"：圆角走 [Shape.radiusControl]（10），不再是写死的 10/7。
        borderRadius: BorderRadius.circular(Shape.radiusControl),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _segment(context, s.schedViewWeek, !list, const ValueKey('schedule-view-week'), () => onChanged(false)),
          _segment(context, s.schedViewList, list, const ValueKey('schedule-view-list'), () => onChanged(true)),
        ],
      ),
    );
  }

  Widget _segment(BuildContext context, String label, bool selected, Key key, VoidCallback onTap) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      key: key,
      onTap: onTap,
      // 内段 = 外框圆角 − 外框内边距（3），这样两段叠在一起时圆角是"同心的"
      borderRadius: const BorderRadius.all(Radius.circular(Shape.radiusControl - 3)),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? scheme.surface : null,
          borderRadius: const BorderRadius.all(Radius.circular(Shape.radiusControl - 3)),
          boxShadow: selected ? IrmiaTheme.hairline : null,
        ),
        child: Text(
          label,
          style: TextStyle(
            fontSize: 10.5,
            color: selected ? scheme.onSurface : scheme.onSurfaceVariant,
            fontWeight: selected ? FontWeight.w700 : null,
          ),
        ),
      ),
    );
  }
}

/// 清单里的一条（设计稿 `.agenda-item`）：分类色条 + 日期钟点 + 标题 + 一行说明 + chips + 箭头
class _AgendaItem extends StatelessWidget {
  const _AgendaItem({
    super.key,
    required this.timer,
    required this.names,
    required this.selected,
    required this.divider,
    required this.onTap,
  });

  final Map<String, dynamic> timer;
  final Map<String, String> names;
  final bool selected;
  final bool divider;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final payload = timer['payload'];
    final at = _atOf(timer);
    final cron = _cronOf(timer);
    final category = _categoryOf(payload);
    final why = _payloadField(payload, 'why');
    final sid = _payloadField(payload, 'sid');
    final kind = _kindOf(payload);
    return Container(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: divider ? scheme.outlineVariant : Colors.transparent)),
      ),
      child: InkWell(
        key: ValueKey('schedule-open-${timer['timerId']}'),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 9, horizontal: 6),
          decoration: BoxDecoration(
            color: selected ? scheme.primary.withValues(alpha: 0.07) : null,
            borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 3,
                height: 34,
                margin: const EdgeInsets.only(right: 8, top: 2),
                decoration: BoxDecoration(
                  // 没写 cat ⇒ 不涂色（中性色条，不是"猜一个分类"）
                  color: category?.of(context) ?? scheme.outlineVariant,
                  borderRadius: BorderRadius.circular(6),
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      // 周期条目先说**复现规律**（那是它更重要的那一面）：`at` 只是服务端算出来的
                      // 下一次到期，写日期会让人以为它只发生一次——线上那条「每周三练」就这样被读错过
                      cron.isNotEmpty
                          ? s.schedRecurringLine(_cronLabel(s, cron))
                          : (at != null
                              ? '${_dayLabel(s, _dayKeyOf(at))} · ${_hhmm(at)}'
                              : s.overviewTimerUnknownTime),
                      style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 4),
                    Text(_titleOf(s, payload),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            fontSize: 12, fontWeight: FontWeight.w700, height: 1.35)),
                    // 「一行说明」缺就**整行不出现**（用户 2026-10-12：别留空占位）
                    if (why.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
                        child: Text(why,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
                      ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        // 她自己的内务：灰角标（降级但仍留在清单里——"接下来要发生什么"里也有它）
                        if (!_isOwnerFacing(timer)) _Pill(s.schedChorePill, muted: true),
                        if (category != null) _Pill(category.labelOf(s), tone: category.of(context)),
                        _Pill(_statusOf(s, timer), tone: IrmiaTheme.ok),
                        if (kind == 'wait') _Pill(s.schedKindWait),
                        if (sid.isNotEmpty) _Pill(s.schedWillSay(_sidLabel(s, sid, names))),
                      ],
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.only(left: 6, top: 4),
                child: Icon(Icons.chevron_right_rounded,
                    size: 16, color: selected ? scheme.primary : scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 详情里的一行：左标签（定宽）+ 右内容
class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value, this.muted = false});

  final String label;
  final String value;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 68,
            child: Text(label, style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
          ),
          Expanded(
            child: Text(
              value,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11.5,
                height: 1.4,
                color: muted ? scheme.onSurfaceVariant : scheme.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 小圆角 chip（分类 / 状态 / 角标）：与运行情况页那几处同一形态。
/// [muted] = 灰底（"她自己的内务"那枚角标用它：不是错误、也不该抢眼）
class _Pill extends StatelessWidget {
  const _Pill(this.text, {this.tone, this.muted = false});

  final String text;
  final Color? tone;
  final bool muted;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = tone ?? scheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: muted ? scheme.surfaceContainerHighest : color.withValues(alpha: 0.13),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(text,
          style: TextStyle(
            fontSize: 9.5,
            fontWeight: FontWeight.w600,
            color: muted ? scheme.onSurfaceVariant : color,
          )),
    );
  }
}

// ════════════════════════════════ 新建安排（顶层卡片） ════════════════════════════════

/// 「新建安排」**顶层卡片**：两条路（照仓里 ask 卡片那一族的做法——标题与按钮由框架写死、
/// 卡面自己说清后果、顶层模态，而不是一张小表单）。
///
///   · **交给她建**（默认，卡面写明"建议"）：人给一句简要 → `wake`。界面只承诺"话送到了"。
///   · **我直接建**（急用）：人给时刻与七格 → `timer-set`。这条路写的是**人的理由**。
class _NewScheduleCard extends StatefulWidget {
  const _NewScheduleCard({
    required this.sessions,
    required this.sendWake,
    required this.createTimer,
  });

  final List<_Session> sessions;
  final Future<_WakeSent> Function(String brief) sendWake;
  final Future<_BuiltTimer> Function(_TimerDraft draft) createTimer;

  @override
  State<_NewScheduleCard> createState() => _NewScheduleCardState();
}

class _NewScheduleCardState extends State<_NewScheduleCard> {
  bool direct = false;
  bool busy = false;
  String? error;

  /// 「更多选项」是否展开（第二层）。**默认收起**：常显的只有"什么时候"与"要做什么"两件
  /// （用户 2026-10-12 批注：四行输入太散、默认值说明像开发者备注 ⇒ 主次分明）
  bool more = false;

  final brief = TextEditingController();
  final date = TextEditingController();
  final clock = TextEditingController(text: '20:00');
  final title = TextEditingController();
  final what = TextEditingController();
  final why = TextEditingController();
  // 预填 30：把"不填按 30"那句开发者腔的说明变成**看得见的默认值**（她/他可以改）
  final dur = TextEditingController(text: '30');
  String repeat = 'once';
  String? cat;
  // 到点后的默认「提醒我」（人建的多半就是要提醒；她那边缺省是"不写"，界面把默认显式写出来）
  String? action = 'notify';
  String? sid;

  @override
  void dispose() {
    brief.dispose();
    date.dispose();
    clock.dispose();
    title.dispose();
    what.dispose();
    why.dispose();
    dur.dispose();
    super.dispose();
  }

  _TimerDraft? _draft({required bool complain}) {
    final s = IrmiaStrings.read(context);
    final day = _parseDay(date.text);
    final time = _parseClock(clock.text);
    final note = what.text.trim();
    if (day == null) {
      if (complain) setState(() => error = s.schedErrDate);
      return null;
    }
    if (time == null) {
      if (complain) setState(() => error = s.schedErrClock);
      return null;
    }
    if (note.isEmpty) {
      if (complain) setState(() => error = s.schedErrWhat);
      return null;
    }
    int? minutes;
    if (dur.text.trim().isNotEmpty) {
      minutes = int.tryParse(dur.text.trim());
      if (minutes == null || minutes <= 0) {
        if (complain) setState(() => error = s.schedErrDuration);
        return null;
      }
    }
    final when = DateTime(day.year, day.month, day.day, time.$1, time.$2);
    final cron = switch (repeat) {
      'daily' => '${time.$2} ${time.$1} * * *',
      'weekly' => '${time.$2} ${time.$1} * * ${when.weekday % 7}',
      _ => null,
    };
    return _TimerDraft(
      when: when,
      repeat: repeat,
      atIso: cron == null ? _isoWithOffset(when) : null,
      cron: cron,
      title: title.text.trim(),
      note: note,
      why: why.text.trim(),
      cat: cat,
      dur: minutes,
      action: action,
      sid: sid,
    );
  }

  Future<void> _submit() async {
    final s = IrmiaStrings.read(context);
    if (busy) return;
    setState(() => error = null);

    if (!direct) {
      final text = brief.text.trim();
      if (text.isEmpty) {
        setState(() => error = s.schedErrBrief);
        return;
      }
      setState(() => busy = true);
      try {
        // 套一层固定开场：她要能一眼看出这是"排一条安排"的请求
        final sent = await widget.sendWake(s.schedWakePrefix(text));
        if (!mounted) return;
        Navigator.of(context).pop(_ScheduleOutcome.wake(sent.text, deduped: sent.deduped));
      } catch (err) {
        if (!mounted) return;
        setState(() {
          busy = false;
          error = s.schedWakeFailed('$err');
        });
      }
      return;
    }

    final draft = _draft(complain: true);
    if (draft == null) return;
    setState(() => busy = true);
    try {
      final built = await widget.createTimer(draft);
      if (!mounted) return;
      Navigator.of(context).pop(_ScheduleOutcome.built(built));
    } catch (err) {
      if (!mounted) return;
      setState(() {
        busy = false;
        error = s.schedCreateFailed('$err');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      constraints: const BoxConstraints(minWidth: 400, maxWidth: kDialogMaxWidth + 120),
      title: Text(s.schedNewPlan, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      content: SingleChildScrollView(
        // ⚠ 这里允许滚（弹窗自己的内容），与"整页不滚"是两件事：页面那一层没有可滚父级
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              s.schedCardLead,
              style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            SegmentedButton<bool>(
              key: const ValueKey('schedule-path'),
              segments: [
                ButtonSegment<bool>(value: false, label: Text(s.schedPathHer)),
                ButtonSegment<bool>(value: true, label: Text(s.schedPathDirect)),
              ],
              selected: {direct},
              showSelectedIcon: false,
              onSelectionChanged: busy ? null : (value) => setState(() => direct = value.first),
            ),
            const SizedBox(height: 14),
            if (!direct) ..._wakeFields(scheme) else ..._directFields(scheme),
            if (error != null) ...[
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(error!,
                        style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurface)),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: busy ? null : () => Navigator.of(context).pop(),
          style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
          child: Text(s.schedLater),
        ),
        FilledButton.tonal(
          key: const ValueKey('schedule-send'),
          onPressed: busy ? null : () => unawaited(_submit()),
          child: Text(busy ? s.schedSending : (direct ? s.schedCreateDirect : s.schedLetHerSchedule)),
        ),
      ],
    );
  }

  List<Widget> _wakeFields(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    return [
        _field(
          id: 'schedule-field-brief',
          controller: brief,
          label: s.schedFieldBrief,
          hint: s.schedBriefHint,
        ),
        const SizedBox(height: 8),
        Text(s.schedBriefNote,
            style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
      ];
  }

  /// 「我直接建」的两层（用户 2026-10-12 批注：四行输入太散 ⇒ **主次分明**）：
  /// **第一层常显**：什么时候（日期/钟点/重复）+ 要做什么；
  /// **第二层收进「更多选项」**：标题 / 为什么 / 大概多久 / 分类 / 到点后 / 要不要说给谁。
  /// 默认值都摆在控件里（重复＝仅一次、多久＝30、到点后＝提醒我），不再用"不填按 30"这类注释说话。
  List<Widget> _directFields(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    final draft = _draft(complain: false);
    // 过去时刻的提醒（不挡提交）：服务端的语义是"已过期的 set 立刻触发一次"
    final past = draft != null && draft.repeat == 'once' && draft.when.isBefore(scheduleNow());
    return [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 4,
            child: _field(
                id: 'schedule-field-date',
                controller: date,
                label: s.schedFieldDay,
                hint: s.schedDayHint),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 3,
            child: _field(id: 'schedule-field-clock', controller: clock, label: s.schedFieldClock, hint: '20:00'),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 3,
            child: _dropdown<String>(
              id: 'schedule-field-repeat',
              label: s.schedFieldRepeat,
              value: repeat,
              items: {'once': s.schedRepeatOnceChoice, 'daily': s.schedRepeatDaily, 'weekly': s.schedRepeatWeeklyChoice},
              onChanged: (value) => setState(() => repeat = value ?? 'once'),
            ),
          ),
        ],
      ),
      const SizedBox(height: 12),
      _field(
        id: 'schedule-field-what',
        controller: what,
        label: s.schedFieldWhatToDo,
        hint: s.schedWhatHint,
      ),
      const SizedBox(height: 6),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton.icon(
          key: const ValueKey('schedule-more'),
          onPressed: busy ? null : () => setState(() => more = !more),
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            minimumSize: const Size(0, 28),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          icon: Icon(more ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 16),
          label: Text(more ? s.collapse : s.schedMoreOptions),
        ),
      ),
      if (more) ...[
        const SizedBox(height: 4),
        _field(
          id: 'schedule-field-title',
          controller: title,
          label: s.schedFieldTitle,
          hint: s.schedTitleHint,
        ),
        const SizedBox(height: 10),
        _field(
          id: 'schedule-field-why',
          controller: why,
          label: s.schedFieldWhyInput,
          hint: s.schedWhyHint,
        ),
        const SizedBox(height: 10),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 3,
              child: _field(
                  id: 'schedule-field-dur', controller: dur, label: s.schedFieldDurationInput, hint: '30'),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 4,
              child: _dropdown<String>(
                id: 'schedule-field-cat',
                label: s.schedFieldCategory,
                value: cat,
                items: {
                  for (final category in _categories)
                    category.key: category.labelOf(s).replaceAll(' ', ''),
                },
                onChanged: (value) => setState(() => cat = value),
                nullableLabel: s.schedNoCategory,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 4,
              child: _dropdown<String>(
                id: 'schedule-field-action',
                label: s.schedFieldAfter,
                value: action,
                items: _actionChoiceItems(s),
                onChanged: (value) => setState(() => action = value),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _dropdown<String?>(
          id: 'schedule-field-sid',
          label: s.schedFieldSid,
          value: sid,
          items: {for (final session in widget.sessions) session.sid: session.label},
          onChanged: (value) => setState(() => sid = value),
          nullableLabel: s.schedNoSid,
        ),
      ],
      const SizedBox(height: 8),
      if (past)
        Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(Icons.warning_amber_rounded, size: 15, color: IrmiaTheme.warn),
              const SizedBox(width: 6),
              Expanded(
                child: Text(s.schedPastWarning,
                    style: TextStyle(fontSize: 11, height: 1.5, color: IrmiaTheme.warn)),
              ),
            ],
          ),
        ),
      Text(
        s.schedCreateNote,
        style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant),
      ),
    ];
  }

  Widget _field({
    required String id,
    required TextEditingController controller,
    required String label,
    required String hint,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          key: ValueKey(id),
          controller: controller,
          enabled: !busy,
          decoration: InputDecoration(isDense: true, hintText: hint),
          onChanged: (_) => setState(() {}),
        ),
      ],
    );
  }

  Widget _dropdown<T>({
    required String id,
    required String label,
    required T? value,
    required Map<String, String> items,
    required ValueChanged<T?> onChanged,
    String? nullableLabel,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: TextStyle(
                fontSize: 12, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        DropdownButtonFormField<T>(
          key: ValueKey(id),
          initialValue: value,
          isExpanded: true,
          decoration: const InputDecoration(isDense: true),
          items: [
            if (nullableLabel != null) DropdownMenuItem<T>(value: null, child: Text(nullableLabel)),
            for (final entry in items.entries)
              DropdownMenuItem<T>(value: entry.key as T, child: Text(entry.value)),
          ],
          onChanged: busy ? null : onChanged,
        ),
      ],
    );
  }
}

/// 卡片带出来的结果：两条路各一格（null 的那一格表示没走那条路）
class _ScheduleOutcome {
  const _ScheduleOutcome.wake(this.brief, {required this.deduped}) : built = null;

  const _ScheduleOutcome.built(this.built) : brief = null, deduped = false;

  final String? brief;
  final bool deduped;
  final _BuiltTimer? built;
}

/// 「我直接建」要交给服务端的东西（`at` 与 `cron` 二选一，七格按约定）
class _TimerDraft {
  const _TimerDraft({
    required this.when,
    required this.repeat,
    required this.atIso,
    required this.cron,
    required this.title,
    required this.note,
    required this.why,
    required this.cat,
    required this.dur,
    required this.action,
    required this.sid,
  });

  final DateTime when;
  final String repeat;
  final String? atIso;
  final String? cron;
  final String title;
  final String note;
  final String why;
  final String? cat;
  final int? dur;
  final String? action;
  final String? sid;
}

class _BuiltTimer {
  const _BuiltTimer(
      {required this.timerId, required this.at, required this.cron, required this.note});

  final String timerId;
  final String at;
  final String? cron;
  final String note;
}

/// 「日期」那一格：认 今天 / 明天 / 后天 / 2026-10-20 / 10月20日
DateTime? _parseDay(String text) {
  final t = text.trim();
  if (t.isEmpty) return null;
  final now = scheduleNow();
  final today = DateTime(now.year, now.month, now.day);
  final relative = kScheduleDayWords[t];
  if (relative != null) return today.add(Duration(days: relative));
  final iso = RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})$').firstMatch(t);
  if (iso != null) {
    return _dayOf(int.parse(iso.group(1)!), int.parse(iso.group(2)!), int.parse(iso.group(3)!));
  }
  final cn = RegExp(kScheduleCnDayPattern).firstMatch(t);
  if (cn != null) return _dayOf(now.year, int.parse(cn.group(1)!), int.parse(cn.group(2)!));
  return null;
}

DateTime? _dayOf(int year, int month, int day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  final d = DateTime(year, month, day);
  if (d.year != year || d.month != month || d.day != day) return null;
  return d;
}

/// 「钟点」：只认 24 小时制的 HH:mm
(int, int)? _parseClock(String text) {
  final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(text.trim());
  if (m == null) return null;
  final hour = int.parse(m.group(1)!);
  final minute = int.parse(m.group(2)!);
  if (hour > 23 || minute > 59) return null;
  return (hour, minute);
}

/// 本地墙上时刻 → **带时区偏移**的 ISO 8601（`TimerStore.set` 拒收无时区的时刻）
String _isoWithOffset(DateTime local) {
  final offset = local.timeZoneOffset;
  final sign = offset.isNegative ? '-' : '+';
  final abs = offset.abs();
  return '${local.year}-${_p2(local.month)}-${_p2(local.day)}'
      'T${_p2(local.hour)}:${_p2(local.minute)}:00$sign${_p2(abs.inHours)}:${_p2(abs.inMinutes % 60)}';
}

/// 会话清单里的一条（只取两格：`sid` 与"人给它起的名字"）
class _Session {
  const _Session({required this.sid, required this.name});

  final String sid;
  final String name;

  static _Session from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    return _Session(
      sid: map['sid'] == null ? '' : '${map['sid']}',
      name: map['name'] == null ? '' : '${map['name']}',
    );
  }

  String get label => name.isEmpty ? sid : name;
}

// ════════════════════════════════ payload 取值 ════════════════════════════════

DateTime? _atOf(Map<String, dynamic> timer) {
  final raw = timer['at'];
  if (raw == null) return null;
  return DateTime.tryParse('$raw')?.toLocal();
}

String _cronOf(Map<String, dynamic> timer) {
  final raw = timer['cron'];
  return raw == null ? '' : '$raw'.trim();
}

String _payloadField(Object? payload, String key) {
  if (payload is! Map) return '';
  final value = payload[key];
  return value is String ? value.trim() : '';
}

/// 「到点做什么」：`payload.note`；**旧形状（字符串 payload）就是它本身**
String _noteOf(Object? payload) {
  if (payload is String) return payload.trim();
  return _payloadField(payload, 'note');
}

String _actionOf(Object? payload) => _normalizeAction(_payloadField(payload, 'action'));

/// `payload.action` 的**两种写法都认**：描述里教她写人话（`自主工作`/`提醒`/`存草稿`），
/// 而最早那一版界面判的是英文键（`self`/`notify`/`draft`）——线上那条现存 cron 写的就是
/// `"action":"自主工作"`。⇒ 这里统一归一化成英文键，**判据只此一处**：
/// 不认的写法原样返回（详情里照她的字显示，不猜）。
/// ⚠ 这是 v59 审计中发现的一个真 bug：归一化之前，「Agent 自主工作」那张卡对
/// `action:"自主工作"` 的条目**数不到**（线上恒为 00），「待分享草稿」状态也不会亮。
String _normalizeAction(String raw) {
  final trimmed = raw.trim();
  // 她可能写中文（数据，见 kScheduleActionAliases），也可能写英文键
  return kScheduleActionAliases[trimmed] ?? trimmed;
}

/// `payload.dur`（分钟）：缺省 **30**（约定值——见周历图例下面那句说明）
int _durOf(Object? payload) {
  if (payload is Map) {
    final value = payload['dur'];
    if (value is num && value > 0) return value.toInt();
  }
  return 30;
}

String _sidLabel(AppStrings s, String sid, Map<String, String> names) {
  final name = names[sid] ?? '';
  if (name.isEmpty) return sid;
  return s.schedSidWithName(name, _sidShort(sid));
}

String _sidShort(String sid) {
  final cut = sid.lastIndexOf(':');
  if (cut < 0 || cut == sid.length - 1) return sid;
  final head = sid.substring(0, cut + 1);
  final tail = sid.substring(cut + 1);
  return '$head${tail.length <= 4 ? tail : tail.substring(0, 4)}$kEllipsis';
}

DateTime _weekStartOf(DateTime day) {
  final midnight = DateTime(day.year, day.month, day.day);
  return midnight.subtract(Duration(days: midnight.weekday - DateTime.monday));
}

String _dayKeyOf(DateTime? day) =>
    day == null ? '' : '${day.year}-${_p2(day.month)}-${_p2(day.day)}';

String _dayLabel(AppStrings s, String key) {
  final parts = key.split('-');
  if (parts.length != 3) return key;
  return s.schedMonthDayRaw(int.tryParse(parts[1]) ?? parts[1], int.tryParse(parts[2]) ?? parts[2]);
}

String _whenStamp(AppStrings s, DateTime dt) => s.schedWhenStamp(dt.month, dt.day, _hhmm(dt));

String _hhmm(DateTime dt) => '${_p2(dt.hour)}:${_p2(dt.minute)}';

String _p2(int value) => value.toString().padLeft(2, '0');

String _weekdayLabel(AppStrings s, int weekday) => switch (weekday) {
      DateTime.monday => s.schedWeekdayMon,
      DateTime.tuesday => s.schedWeekdayTue,
      DateTime.wednesday => s.schedWeekdayWed,
      DateTime.thursday => s.schedWeekdayThu,
      DateTime.friday => s.schedWeekdayFri,
      DateTime.saturday => s.schedWeekdaySat,
      _ => s.schedWeekdaySun,
    };

/// cron 的人话化。与 [_parseCron] **同一套判据**（能算的就说得出来，算不出的原样给人看）：
/// `M H * * *` ⇒ 每天 HH:MM ／ `M H * * D` ⇒ 每周三 HH:MM ／ `M H * * D,D,…` ⇒ 每周二/四/六 HH:MM
/// ／ `M H * * A-B` ⇒ 每周一至周五 HH:MM ／ 其余（步长、带月/日限定…）⇒ **原样**
/// （线上那条 `0 20 * * 2,4,6` 原来只会显示成一串数字，读的人根本看不出"每周三练"）。
String _cronLabel(AppStrings s, String expr) {
  final parts = expr.trim().split(RegExp(r'\s+'));
  if (parts.length != 5) return expr;
  final minute = int.tryParse(parts[0]);
  final hour = int.tryParse(parts[1]);
  if (minute == null || hour == null) return expr;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return expr;
  if (parts[2] != '*' || parts[3] != '*') return expr;
  final time = '${_p2(hour)}:${_p2(minute)}';
  if (parts[4] == '*') return s.schedCronDaily(time);
  final words = <String>[];
  for (final token in parts[4].split(',')) {
    final range = RegExp(r'^(\d)-(\d)$').firstMatch(token);
    if (range != null) {
      final from = int.parse(range.group(1)!);
      final to = int.parse(range.group(2)!);
      if (from > to || to > 7) return expr;
      words.add(s.schedCronRange(kScheduleWeekdayShort[from % 7], kScheduleWeekdayShort[to % 7]));
      continue;
    }
    final day = int.tryParse(token);
    if (day == null || day < 0 || day > 7) return expr;
    words.add(kScheduleWeekdayShort[day % 7]);
  }
  if (words.isEmpty) return expr;
  return s.schedCronWeekly(words.join('/'), time);
}
