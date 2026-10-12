import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

/// 「日程」页（一级第三项）——设计稿 `Agent 近期安排 · 周历与清单.html` 那一页。
///
/// ## 一屏里有什么（照设计稿逐块）
/// 页头（eyebrow + 大标题 + 搜索 / 回到本周 / ＋新建安排）→ 四张计数卡 → **左周历 + 右清单**（点一天筛清单、
/// 点一条看详情）→ 选中详情 → 最近的工作记录 → 长期计划入口 → 页脚那句话。
///
/// ## 布局纪律（用户 2026-10-12 的硬要求）：**整页不滚，只有「安排清单」在块内滚**
/// 最外层是 `Column` + `Expanded`，每一块自己管自己的高度：页面里**只有一个 `Scrollable`**
/// （清单那一块的 [ListView]，键 `schedule-list`）。窗口矮的时候**压缩周历行高**
/// （[kMinRowHeight]…[kRowHeight]），而不是让整页长出去；屏再矮就先收起两块附加内容
/// （工作记录 / 长期计划——它们真正的家是日志页与记忆页）。
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
///   · 也**不摊记忆正文**——「长期计划」只做**一个紧凑入口**，只认白名单里的那一个分区
///     （见 [_planSectionTitles]）；`置顶`/`约定与承诺`/`稳定事实`/`观察`/`归档` 连读都不读。
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

class _SchedulePageState extends State<SchedulePage> {
  Map<String, dynamic>? proj;

  /// 会话清单（`GET /api/sessions`）：「到哪儿说」的名字 + 「新建安排」里那个下拉的选项。
  /// 读不到就静默降级（显示原串、下拉只剩"不用"）——它是附加信息，不该把整页拖进错误态。
  List<_Session>? sessions;

  /// 长期计划那**一个分区**（白名单命中的那个；null = 还没读到 / 没有这一格）。
  /// ⚠ 只存命中的那一个——**不存整份 facts**（见类注释"这一页不回答什么"）。
  _FactsSection? planSection;

  /// 读记忆失败的原因（只影响「长期计划」那一块：如实说一句，不假装"没有这一格"）
  String? plansError;

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
    weekStart = _weekStartOf(DateTime.now());
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
    // 两块附加内容各自吃自己的错，但**和主数据一起等**（一次刷新要等人等的就是同一件事）
    final extras = Future.wait([_loadSessions(), _loadPlanSection()]);
    try {
      final data = await api.get('/api/projection');
      if (mounted) {
        setState(() {
          proj = data is Map<String, dynamic> ? data : null;
          error = proj == null ? '返回的数据不是投影' : null;
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

  /// 长期计划：从 `facts.md` 里**只取白名单命中的那一个分区**（最多 3 行）。
  ///
  /// 为什么不整份摊出来（用户 2026-10-12 的批注：「写了不应该进入日程页的内容」）：
  /// 那份文件里有 `置顶（pinned）` / `约定与承诺` / `稳定事实` / `观察` / `归档（已失效/已过期，不注入）`
  /// ——那些是**记忆**，日程页只回答"接下来要发生什么"。所以判据是**白名单**：只有标题命中
  /// [_planSectionTitles] 的那一个分区才有机会上屏，其余分区连读都不读，根本不存在"漏了一格"。
  /// 命不中 ⇒ 如实显示"她还没有单开这一格"。
  Future<void> _loadPlanSection() async {
    try {
      final view = await widget.state.api.get('/api/memory');
      final factsView = view is Map ? view['facts'] : null;
      final path = factsView is Map ? '${factsView['path'] ?? ''}' : '';
      if (path.isEmpty) throw StateError('记忆清单里没有 facts 这一段');
      if (!_hasPlanSection(factsView)) {
        // 清单里就没有这一档：不用再读正文（少一次往返）
        if (mounted) {
          setState(() {
            planSection = null;
            plansError = null;
          });
        }
        return;
      }
      final file = await widget.state.api.get('/api/memory?file=${Uri.encodeComponent(path)}');
      final content = file is Map ? '${file['content'] ?? ''}' : '';
      if (!mounted) return;
      setState(() {
        planSection = _pickPlanSection(content);
        plansError = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        planSection = null;
        plansError = '$err';
      });
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
    final payload = timer['payload'];
    return [
      _titleOf(payload),
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

  /// **用户向、能算出钟点、但钟点不在 08:00–21:00 这一格**里的条目（同样画不出来）。
  /// 有能算的 `cron` 就按它的钟点算（周期条目一整天都在格外的只算一条），否则按 `at`。
  int get _outOfRangeCount => _timers.where((t) {
        if (!_isOwnerFacing(t)) return false;
        final cron = _cronOf(t);
        if (cron.isNotEmpty) {
          final spec = _parseCron(cron);
          if (spec == null) return false; // 算不出 ⇒ 归上面那一类，别数两次
          return spec.hour * 60 + spec.minute < _gridStartMinute ||
              spec.hour * 60 + spec.minute > _gridEndMinute;
        }
        final at = _atOf(t);
        if (at == null) return false;
        final minutes = at.hour * 60 + at.minute;
        return minutes < _gridStartMinute || minutes > _gridEndMinute;
      }).length;

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
    if (timerId.isEmpty || cancellingId != null) return;
    final yes = await confirm(
      context,
      title: '取消这条安排？',
      body: '定时器 $timerId 会被取消：它到点不会再把她叫起来。\n'
          '这次撤销写进日志（timer/cancelled），撤错了只能让她重新排一个。\n'
          // 对齐她的提示词（`PAYLOAD_SHAPE_TEXT` 教过她"改一条用取消 + 重排"）：人这一侧也该知道
          '想改时间或改内容，也走这条路：撤掉这条，再跟她说一句新的（「新建安排」）。',
      confirmLabel: '取消安排',
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
      IrmiaToast.show(context, '已取消 $timerId：到点不会再醒', kind: ToastKind.success);
      await load();
    } catch (err) {
      if (!mounted) return;
      setState(() {
        cancellingId = null;
        actionError = '取消 $timerId 失败：$err';
      });
      IrmiaToast.show(context, '取消失败：$err', kind: ToastKind.error);
    }
  }

  // ──────────────── 新建：顶层卡片的两条路 ────────────────

  /// 「新建安排」：一张**顶层卡片**，两条路（交给她建 / 我直接建）。
  ///
  /// 为什么主推"交给她建"（GUI.md §0 第 2 条）：她排的东西是"给未来的自己的一句话"，而 `why` 是
  /// **她自己的理由**——那正是"到点她读到的是自己想的话"的来处。直接建那条路留着（急用不能堵），
  /// 但它写的是**人的理由**，所以卡面上把这一层差别说在明面上。
  Future<void> _newSchedule() async {
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
        IrmiaToast.show(context, kWakeDedupedNote, kind: ToastKind.info);
      }
      return;
    }

    final built = outcome.built;
    if (built != null) {
      setState(() {
        builtReceipt = '已经排上了：${_builtWhen(built)} · ${built.note}';
        wakeReceipt = null;
      });
      IrmiaToast.show(context, '已排上这条安排', kind: ToastKind.success);
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

  String _builtWhen(_BuiltTimer built) {
    final at = DateTime.tryParse(built.at)?.toLocal();
    final when = at == null ? '（服务端没回时刻）' : _whenStamp(at);
    final cron = built.cron;
    if (cron == null || cron.isEmpty) return when;
    return '周期 ${_cronLabel(cron)}（下一次 $when）';
  }

  // ──────────────── 搜索（纯前端筛清单） ────────────────

  Future<void> _search() async {
    final controller = TextEditingController(text: searchQuery);
    final query = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
        title: const Text('搜索安排', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        content: TextField(
          key: const ValueKey('schedule-search-field'),
          controller: controller,
          autofocus: true,
          onSubmitted: (value) => Navigator.of(dialogContext).pop(value),
          decoration: const InputDecoration(isDense: true, hintText: '标题 / 到点做什么 / 为什么'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(''),
            style: TextButton.styleFrom(
              foregroundColor: Theme.of(dialogContext).colorScheme.onSurfaceVariant,
            ),
            child: const Text('清除'),
          ),
          FilledButton.tonal(
            key: const ValueKey('schedule-search-apply'),
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('搜索'),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        PageHeader(
          // 设计稿那条英文 eyebrow（小字）；标题按它的字号放大，副标题逐字
          eyebrow: 'YOUR TIME, THOUGHTFULLY',
          title: '近期安排',
          titleSize: 26,
          subtitle: '把日程、提醒和她自己的计划放在同一处。',
          action: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                key: const ValueKey('schedule-search'),
                onPressed: () => unawaited(_search()),
                tooltip: '搜索安排',
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.search_rounded, size: 18),
              ),
              const SizedBox(width: 6),
              OutlinedButton(
                key: const ValueKey('schedule-back-week'),
                onPressed: () => setState(() {
                  weekStart = _weekStartOf(DateTime.now());
                  selectedDay = null;
                }),
                child: const Text('回到本周'),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                key: const ValueKey('schedule-propose'),
                onPressed: () => unawaited(_newSchedule()),
                icon: const Icon(Icons.add_rounded, size: 18),
                label: const Text('新建安排'),
              ),
            ],
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(26, 14, 26, 12),
            child: loading
                ? const StateBlock.loading(hint: '正在读她排着的安排…')
                : error != null
                    ? StateBlock.error(
                        message: '读不到日程：$error',
                        hint: '这一页读的是投影 /api/projection 里的 timers：刷新一次试试；'
                            '一直读不到说明主进程那边有问题。',
                        onRetry: () => unawaited(load()),
                      )
                    : _body(),
          ),
        ),
      ],
    );
  }

  /// 不滚的那一版主体：回执（可有）+ 计数卡（定高）+ 工作区（Expanded）+ 页脚（定高）
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
          const SizedBox(height: 8),
          Text(
            // 设计稿页脚那句，逐字；只把她的名字换成**读来的那个**（界面从不写死名字）
            '安排只是一个行动机会 · 到点后${widget.state.herDisplayName}会先确认事情是否仍然值得做',
            textAlign: TextAlign.center,
            style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  /// 工作区：左周历 + 右（清单 ＋ 详情 ＋ 两块附加）。
  ///
  /// ⚠ 这里的**阈值是量出来的、不是猜的**：`Expanded` 把"剩下的高度"给工作区，而右栏的
  /// 清单是 `Expanded`（可以缩到很小），所以真正怕溢出的是那些**定高块**（详情 / 两块附加）。
  /// 高度不够时按顺序让位：先两块附加（它们真正的家是日志页与记忆页），再详情（整页不滚是硬要求）。
  ///
  /// 阈值口径（`available` = 工作区拿到的高度）：
  ///   · ≥ 620：详情（~230）＋ 两块附加（各 ~95）都摆得下，清单还剩一截；
  ///   · 420–620：只留详情（明细还是要能看）；
  ///   · < 420：只剩清单（矮到这一步，别的都摆不下了）。
  Widget _workspace(double available) {
    final showExtras = available >= 620;
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
              if (showExtras) ...[
                const SizedBox(height: 12),
                _plansPanel(),
              ],
            ],
          ),
        ),
      ],
    );
  }

  // ── 分区一：四张计数卡（设计稿的 .summary；都是真数） ──

  Widget _summary() {
    final timers = _timers;
    // 本周 = 今天所在那一周（周一起 7 天），与周历翻到哪一周无关
    final weekStart = _weekStartOf(DateTime.now());
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
            label: '本周安排',
            value: thisWeek.toString().padLeft(2, '0'),
            note: '一次性与周期任务',
            icon: Icons.event_available_rounded,
          ),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: _Stat(
            label: '等待触发',
            value: timers.length.toString().padLeft(2, '0'),
            note: '到点后会重新判断',
            icon: Icons.alarm_rounded,
          ),
        ),
        const SizedBox(width: 13),
        Expanded(
          child: _Stat(
            label: 'Agent 自主工作',
            value: selfWork.toString().padLeft(2, '0'),
            note: '不一定需要联系你',
            icon: Icons.auto_awesome_rounded,
          ),
        ),
        const SizedBox(width: 13),
        const Expanded(
          // 她的"草稿"今天**没有任何存储**（提示词里那句"把想说的话攒成草稿"而已）⇒ 0 是真的 0，
          // 注脚把这件事说白：不是"零条草稿"，是"还没有落盘的地方"
          child: _Stat(
            label: '待分享想法',
            value: '00',
            note: '她的草稿还没有落盘',
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
    final scheme = Theme.of(context).colorScheme;
    final days = [for (var i = 0; i < 7; i += 1) weekStart.add(Duration(days: i))];
    final today = _dayKeyOf(DateTime.now());
    return _Panel(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('周历', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Text('选择一个条目，查看具体安排',
                      style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                ],
              ),
            ),
            _miniButton('schedule-prev-week', Icons.chevron_left_rounded, '上一周',
                () => setState(() {
                      weekStart = weekStart.subtract(const Duration(days: 7));
                      selectedDay = null;
                    })),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
              child: Text('${weekStart.month}月${weekStart.day}日 — ${days.last.day}日',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            ),
            _miniButton('schedule-next-week', Icons.chevron_right_rounded, '下一周',
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
                          _weekdayCn(day.weekday),
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
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(category.label,
                      style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
                ],
              ),
          ],
        ),
        // ⚠ 这里**不再写**"块高按 dur 算 / 分类色按 cat"那两句技术说明（用户 2026-10-12 批注
        // 「此文字无意义可去掉」）。下面两句留着：它们说的是"有 N 条画不到格子里，去清单看"，
        // 是**数据**不是实现说明。
        if (_unplaceableCount > 0)
          Text('画不出这一周的周期条目：$_unplaceableCount 条（在清单里）',
              style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant)),
        if (_outOfRangeCount > 0)
          Text('不在 08:00–21:00 这一格里：$_outOfRangeCount 条（在清单里）',
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
                Text(slot.fromCron ? '${_p2(slot.hour)}:${_p2(slot.minute)} · 周期' : _hhmmOf(slot.hour, slot.minute),
                    maxLines: 1,
                    style: TextStyle(
                        fontSize: 8, fontWeight: FontWeight.w700, color: scheme.onSurfaceVariant)),
              if (titleLines > 0)
                Text(
                  _titleOf(timer['payload']),
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
            Text(_weekdayCn(day.weekday),
                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
            const SizedBox(width: 8),
            Text('${day.month}月${day.day}日',
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
                    Text(_titleOf(payload),
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
                const _Pill('周期'),
                const SizedBox(width: 6),
              ],
              if (category != null) _Pill(category.label, tone: category.of(context)),
            ],
          ),
        ));
      }
    }
    if (rows.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 12),
        child: Text('这一周还没有安排。', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
      );
    }
    final hidden = total - planned;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ...rows,
        if (hidden > 0)
          Text('这一周还有 $hidden 条没摆下，看右边的清单',
              style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
      ],
    );
  }

  // ── 分区三：安排清单（**这一块是整页唯一可滚的地方**） ──

  Widget _listPanel() {
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
                    const Text('安排清单', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(
                      [
                        '接下来要发生的事',
                        if (day != null) '只看 ${_dayLabel(day)}',
                        if (query.isNotEmpty) '匹配「$query」',
                        if (filtered) '${timers.length} 条',
                      ].join(' · '),
                      style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              if (day != null)
                TextButton(
                  key: const ValueKey('schedule-clear-day'),
                  onPressed: () => setState(() => selectedDay = null),
                  style: _linkStyle,
                  child: const Text('看全部'),
                ),
              if (query.isNotEmpty)
                TextButton(
                  key: const ValueKey('schedule-clear-search'),
                  onPressed: () => setState(() => searchQuery = ''),
                  style: _linkStyle,
                  child: const Text('清除搜索'),
                ),
            ],
          ),
        ),
        if (err != null) ...[
          const SizedBox(height: 6),
          StateBlock.error(
            message: err,
            hint: '可能是它已经触发或已经被撤掉了；刷新一次看最新清单。',
            padding: const EdgeInsets.symmetric(vertical: 6),
          ),
        ],
        const SizedBox(height: 8),
        Expanded(
          child: timers.isEmpty
              ? (filtered
                  ? const HintLine('这里没有符合条件的安排。')
                  : GuideBar(
                      key: const ValueKey('schedule-empty'),
                      icon: Icons.event_available_rounded,
                      text: '还没有排着的事。',
                      actionLabel: '新建安排',
                      onAction: () => unawaited(_newSchedule()),
                      hint: '安排只是一次机会——到点她会先确认还值不值得做，不值得就跳过。',
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
                    timer == null ? '选择一个安排' : _titleOf(payload),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, height: 1.35),
                  ),
                ],
              ),
            ),
            if (timer != null) ...[
              if (category != null) ...[
                _Pill(category.label, tone: category.of(context)),
                const SizedBox(width: 6),
              ],
              _Pill(_statusOf(timer), tone: IrmiaTheme.ok),
            ],
          ],
        ),
        const SizedBox(height: 8),
        if (timer == null)
          Text(
            '点清单或周历里的任意一条，看她为什么排它、到点做什么、到哪儿说。'
            '这两格是只读的：它们是她排的时候写进日志里的原话。',
            style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
          )
        else ...[
          _DetailRow(
            label: '执行时间',
            value: at == null
                ? (cron.isEmpty ? '时刻未知' : '周期 ${_cronLabel(cron)}（下一次在服务端重排）')
                : '${_whenStamp(at)}${cron.isEmpty ? '' : ' · 周期 ${_cronLabel(cron)}'}',
          ),
          if (why.isNotEmpty) _DetailRow(label: '为什么安排它', value: why),
          if (note.isNotEmpty) _DetailRow(label: '到点做什么', value: note),
          if (sid.isNotEmpty) _DetailRow(label: '到哪儿说', value: _sidLabel(sid, _nameOfSid)),
          _DetailRow(
            label: '时长',
            value: durExplicit ? '$dur 分钟' : '$dur 分钟（约定值：这条没写 dur）',
            muted: !durExplicit,
          ),
          _DetailRow(
            label: '到点后',
            value: action.isEmpty ? '未写' : _actionLabel(action),
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
                child: const Text('取消安排'),
              ),
            ],
          ),
        ],
      ],
    );
  }

  // ── 分区六：长期计划（**只做入口，不搬记忆正文**） ──

  /// 判据（用户 2026-10-12 的批注「写了不应该进入日程页的内容」）：**日程页只回答"接下来要发生什么"**。
  /// 所以这一块**只认白名单里的那一个分区**（[_planSectionTitles]，最多 3 行 + 一句"还有 N 行"），
  /// 命不中就是一句实话 + 去记忆页的按钮；`置顶`/`约定与承诺`/`稳定事实`/`观察`/`归档` 这些
  /// **连读都不读**——白名单是结构性保证：不是"记得别显示"，是**没有那条路**。
  Widget _plansPanel() {
    final scheme = Theme.of(context).colorScheme;
    final section = planSection;
    final err = plansError;
    return _Panel(
      key: const ValueKey('schedule-plans'),
      padding: const EdgeInsets.fromLTRB(14, 10, 10, 10),
      children: [
        Row(
          children: [
            const Text('长期计划', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
            const SizedBox(width: 8),
            Expanded(
              child: Text('她单开的那一格（这里只读）',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
            ),
            TextButton(
              key: const ValueKey('schedule-goto-memory'),
              onPressed: () => widget.state.setPage('memory'),
              style: _linkStyle,
              child: const Text('去记忆页'),
            ),
          ],
        ),
        if (err != null)
          HintLine('暂未接入：读不到她的记忆（$err）。')
        else if (section == null)
          // 与用户给的那句逐字相同（她的记忆里还没有这一格）
          const HintLine('她还没有单开这一格 · 去记忆页')
        else ...[
          const SizedBox(height: 4),
          Text('## ${section.title}'.substring(3),
              key: const ValueKey('schedule-plan-section'),
              style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600)),
          for (final line in section.items)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text('· $line',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
            ),
          if (section.more > 0)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text('还有 ${section.more} 行，去记忆页',
                  style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
            ),
        ],
      ],
    );
  }

  /// 「交给她建」的回执：只说"话送到了"，**不说"排好了"**（GUI.md §3.3 纪律 4）
  Widget _receiptBlock(ColorScheme scheme, _WakeReceipt value) {
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
              value.deduped ? kWakeDedupedNote : '已经跟她说了一句：『${value.text}』',
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
              child: const Text('去聊天页看她的反应'),
            ),
        ],
      ),
    );
  }

  /// 「我直接建」的回执：这一条**服务端已经回执、也已经进了投影**，所以可以照实说"已经排上了"
  Widget _builtBlock(ColorScheme scheme, String text) {
    return Container(
      key: const ValueKey('schedule-built-receipt'),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.ok.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.ok.withValues(alpha: 0.3)),
      ),
      child: Text(
        '$text —— 这条是你直接排的：她到点会读到你的理由。',
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
  const _Category(this.key, this.label, this.light, this.dark);

  final String key;
  final String label;
  final Color light;
  final Color dark;

  Color of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

const List<_Category> _categories = [
  _Category('work', '工作 / 学习', Color(0xFF8E75D5), Color(0xFFA18AE5)),
  _Category('personal', '陪伴 / 交流', Color(0xFFD779A8), Color(0xFFE8A4C7)),
  _Category('life', '生活习惯', Color(0xFF5D9B8B), Color(0xFF82C4AE)),
  _Category('routine', '周期计划', Color(0xFFC28C4E), Color(0xFFEDC58E)),
];

/// 分类：`payload.cat` 写英文键（`work`）或人话（`工作学习`）都认；**认不出就不涂色**。
_Category? _categoryOf(Object? payload) {
  final raw = _payloadField(payload, 'cat');
  if (raw.isEmpty) return null;
  final text = raw.toLowerCase();
  for (final category in _categories) {
    if (text == category.key || text == category.label) return category;
  }
  for (final category in _categories) {
    final head = category.label.split(' ').first; // 工作 / 学习 → 工作
    if (text.contains(head) || text.contains(category.key)) return category;
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
const Map<String, String> _actionLabels = {
  'self': '自主工作',
  'notify': '提醒你',
  'draft': '存草稿',
};

/// 「新建安排」卡片里那三档的**人这一侧**说法（同一个数据值，换成人话；默认「到点提醒我」）。
/// 为什么两份词：卡片是人在填（"提醒我"），详情面板是读她写的东西（"提醒你"）——
/// 数据值都是 `notify`/`self`/`draft`，不因为文案不同而分叉。
const Map<String, String> _actionChoiceLabels = {
  'notify': '到点提醒我',
  'self': '她自己先做',
  'draft': '先存个草稿',
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

String _actionLabel(String action) => _actionLabels[action] ?? action;

/// `payload.kind` 的人话。**这是"翻译"不是"编"**：`kind` 本来就写在数据里，
/// 而现场那条现存 cron（`{kind:'memory-maintain'}`）没有 `title`/`note`/`why`——
/// 不翻它，那一行就是空白。
const Map<String, String> _kindLabels = {
  'memory-maintain': '每日记忆整理',
  'wait': '她自己等的',
};

String _kindOf(Object? payload) => _payloadField(payload, 'kind');

/// 标题的**退化链**（用户 2026-10-12 定）：`title` → `note` 第一句 → `why` → `kind` 的人话
/// →「未命名安排」。**每一级都是数据里写着的东西**，一级都取不到才用最后那句兜底。
String _titleOf(Object? payload) {
  final title = _payloadField(payload, 'title');
  if (title.isNotEmpty) return title;
  final first = _firstSentence(_noteOf(payload));
  if (first.isNotEmpty) return first;
  final why = _payloadField(payload, 'why');
  if (why.isNotEmpty) return why;
  final kind = _kindOf(payload);
  if (kind.isNotEmpty) return _kindLabels[kind] ?? kind;
  return '未命名安排';
}

/// 一句话里的第一句（"到点做什么"常常是两句话，标题只取第一句）
String _firstSentence(String text) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  if (flat.isEmpty) return '';
  final match = RegExp(r'^[^。！？!?；;]+').firstMatch(flat);
  return (match?.group(0) ?? flat).trim();
}

/// 状态 chip（设计稿 `statusLabel` 里**算得出来的那三档**）：
/// `action==='draft'` ⇒ 待分享草稿；有条目带 `cron` ⇒ 周期任务；其余 ⇒ 待触发。
/// 「已完成 / 已取消」不在这里：投影里只有"还没到点的"（触发即出表），没有终态可显示。
String _statusOf(Map<String, dynamic> timer) {
  if (_actionOf(timer['payload']) == 'draft') return '待分享草稿';
  if (_cronOf(timer).isNotEmpty) return '周期任务';
  return '待触发';
}

// ════════════════════════════════ 长期计划：白名单 ════════════════════════════════

/// 「长期计划」那一格**只认这几个分区标题**（含匹配）。日程页不许出现的分区
/// （`置顶`/`约定与承诺`/`稳定事实`/`观察`/`归档`）**一条都不在这里**——这是结构性保证。
const List<String> _planSectionTitles = ['长期计划', '我提过的', '未认可', '提议'];

/// 记忆清单里有没有这一档（`/api/memory` 的 `facts.sections[]`）——有才去读正文
bool _hasPlanSection(Object? factsView) {
  final sections = factsView is Map ? factsView['sections'] : null;
  if (sections is! List) return false;
  for (final raw in sections.whereType<Map>()) {
    final title = '${raw['title'] ?? ''}'.replaceFirst('## ', '').trim();
    if (_planSectionTitles.any(title.contains)) return true;
  }
  return false;
}

/// `facts.md` 正文里**只挑白名单命中的那一个分区**（最多 [maxItems] 行，多的记进 [more]）。
/// 返回 null = 没有这一格（界面显示"她还没有单开这一格"）。
///
/// ⚠ 这个函数的返回值里**不可能出现别的分区**：它只把命中的那一个装出来。
_FactsSection? _pickPlanSection(String content) {
  const maxItems = 3;
  String? title;
  var items = <String>[];
  var matched = false;

  for (final raw in content.split('\n')) {
    final line = raw.trimRight();
    if (line.startsWith('## ')) {
      if (matched) break; // 命中那一段已经收完，后面的分区连读都不读
      final candidate = line.substring(3).trim();
      if (_planSectionTitles.any(candidate.contains)) {
        matched = true;
        title = candidate;
        items = <String>[];
      }
      continue;
    }
    if (!matched) continue;
    final text = line.trim();
    if (text.isEmpty) continue;
    items.add(text.startsWith('- ') ? text.substring(2).trim() : text);
  }
  if (!matched) return null;
  return _FactsSection(
    title: title ?? '',
    items: items.take(maxItems).toList(),
    more: items.length > maxItems ? items.length - maxItems : 0,
  );
}

/// 命中分区的那几行（[more] = 没摆下的行数）
class _FactsSection {
  const _FactsSection({required this.title, required this.items, required this.more});

  final String title;
  final List<String> items;
  final int more;
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

/// 幂等键撞上时的那句话。**与聊天页逐字相同**（`chat_page.dart:951-955`）
const String kWakeDedupedNote = '这句和刚发过的完全一样，被当成同一条忽略了——过几秒再发一次就行';

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
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _segment(context, '周', !list, const ValueKey('schedule-view-week'), () => onChanged(false)),
          _segment(context, '列表', list, const ValueKey('schedule-view-list'), () => onChanged(true)),
        ],
      ),
    );
  }

  Widget _segment(BuildContext context, String label, bool selected, Key key, VoidCallback onTap) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      key: key,
      onTap: onTap,
      borderRadius: BorderRadius.circular(7),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? scheme.surface : null,
          borderRadius: BorderRadius.circular(7),
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
                          ? '周期 · ${_cronLabel(cron)}'
                          : (at != null
                              ? '${_dayLabel(_dayKeyOf(at))} · ${_hhmm(at)}'
                              : '时刻未知'),
                      style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(height: 4),
                    Text(_titleOf(payload),
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
                        if (!_isOwnerFacing(timer)) const _Pill('她的内务', muted: true),
                        if (category != null) _Pill(category.label, tone: category.of(context)),
                        _Pill(_statusOf(timer), tone: IrmiaTheme.ok),
                        if (kind == 'wait') const _Pill('她自己等的'),
                        if (sid.isNotEmpty) _Pill('到点会说：${_sidLabel(sid, names)}'),
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
  String repeat = '仅一次';
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
    final day = _parseDay(date.text);
    final time = _parseClock(clock.text);
    final note = what.text.trim();
    if (day == null) {
      if (complain) setState(() => error = '「日期」看不懂：写 今天 / 明天 / 后天 或 2026-10-20 都行。');
      return null;
    }
    if (time == null) {
      if (complain) setState(() => error = '「钟点」要写成 20:00 这样（24 小时制）。');
      return null;
    }
    if (note.isEmpty) {
      if (complain) setState(() => error = '「要做什么」要填：她到点看见的就是这一句。');
      return null;
    }
    int? minutes;
    if (dur.text.trim().isNotEmpty) {
      minutes = int.tryParse(dur.text.trim());
      if (minutes == null || minutes <= 0) {
        if (complain) setState(() => error = '「大概多久」填分钟数就行（不填就按半小时算）。');
        return null;
      }
    }
    final when = DateTime(day.year, day.month, day.day, time.$1, time.$2);
    final cron = switch (repeat) {
      '每天' => '${time.$2} ${time.$1} * * *',
      '每周' => '${time.$2} ${time.$1} * * ${when.weekday % 7}',
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
    if (busy) return;
    setState(() => error = null);

    if (!direct) {
      final text = brief.text.trim();
      if (text.isEmpty) {
        setState(() => error = '写一句话再让她排（她读到的就是这一句）。');
        return;
      }
      setState(() => busy = true);
      try {
        // 套一层固定开场：她要能一眼看出这是"排一条安排"的请求
        final sent = await widget.sendWake('请帮我排一条安排：$text');
        if (!mounted) return;
        Navigator.of(context).pop(_ScheduleOutcome.wake(sent.text, deduped: sent.deduped));
      } catch (err) {
        if (!mounted) return;
        setState(() {
          busy = false;
          error = '没能把这句话送到她那里：$err';
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
        error = '这条安排没能排上：$err';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      constraints: const BoxConstraints(minWidth: 400, maxWidth: kDialogMaxWidth + 120),
      title: const Text('新建安排', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      content: SingleChildScrollView(
        // ⚠ 这里允许滚（弹窗自己的内容），与"整页不滚"是两件事：页面那一层没有可滚父级
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '一般更建议交给她建：她会自己写"为什么"，到点先确认还值不值得做。直接建是给你急用的。',
              style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 12),
            SegmentedButton<bool>(
              key: const ValueKey('schedule-path'),
              segments: const [
                ButtonSegment<bool>(value: false, label: Text('交给她建')),
                ButtonSegment<bool>(value: true, label: Text('我直接建')),
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
          child: const Text('稍后'),
        ),
        FilledButton.tonal(
          key: const ValueKey('schedule-send'),
          onPressed: busy ? null : () => unawaited(_submit()),
          child: Text(busy ? '正在送…' : (direct ? '直接建' : '让她排')),
        ),
      ],
    );
  }

  List<Widget> _wakeFields(ColorScheme scheme) => [
        _field(
          id: 'schedule-field-brief',
          controller: brief,
          label: '一句话跟她说',
          hint: '下周一早上九点提醒我看周计划',
        ),
        const SizedBox(height: 8),
        Text('这句话会直接送到她那里，由她来排。',
            style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
      ];

  /// 「我直接建」的两层（用户 2026-10-12 批注：四行输入太散 ⇒ **主次分明**）：
  /// **第一层常显**：什么时候（日期/钟点/重复）+ 要做什么；
  /// **第二层收进「更多选项」**：标题 / 为什么 / 大概多久 / 分类 / 到点后 / 要不要说给谁。
  /// 默认值都摆在控件里（重复＝仅一次、多久＝30、到点后＝提醒我），不再用"不填按 30"这类注释说话。
  List<Widget> _directFields(ColorScheme scheme) {
    final draft = _draft(complain: false);
    // 过去时刻的提醒（不挡提交）：服务端的语义是"已过期的 set 立刻触发一次"
    final past = draft != null && draft.repeat == '仅一次' && draft.when.isBefore(DateTime.now());
    return [
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            flex: 4,
            child: _field(
                id: 'schedule-field-date',
                controller: date,
                label: '哪一天',
                hint: '今天 / 明天 / 2026-10-20'),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 3,
            child: _field(id: 'schedule-field-clock', controller: clock, label: '几点', hint: '20:00'),
          ),
          const SizedBox(width: 10),
          Expanded(
            flex: 3,
            child: _dropdown<String>(
              id: 'schedule-field-repeat',
              label: '要不要重复',
              value: repeat,
              items: const {'仅一次': '只这一次', '每天': '每天', '每周': '每周（就这一天）'},
              onChanged: (value) => setState(() => repeat = value ?? '仅一次'),
            ),
          ),
        ],
      ),
      const SizedBox(height: 12),
      _field(
        id: 'schedule-field-what',
        controller: what,
        label: '要做什么',
        hint: '看一眼汇报材料定稿没有',
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
          label: Text(more ? '收起' : '更多选项（标题、分类、说给谁…）'),
        ),
      ),
      if (more) ...[
        const SizedBox(height: 4),
        _field(
          id: 'schedule-field-title',
          controller: title,
          label: '标题',
          hint: '不填就用"要做什么"那句',
        ),
        const SizedBox(height: 10),
        _field(
          id: 'schedule-field-why',
          controller: why,
          label: '为什么排它',
          hint: '周三要交，我怕忘了',
        ),
        const SizedBox(height: 10),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              flex: 3,
              child: _field(
                  id: 'schedule-field-dur', controller: dur, label: '大概多久（分钟）', hint: '30'),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 4,
              child: _dropdown<String>(
                id: 'schedule-field-cat',
                label: '分类',
                value: cat,
                items: {
                  for (final category in _categories)
                    category.key: category.label.replaceAll(' ', ''),
                },
                onChanged: (value) => setState(() => cat = value),
                nullableLabel: '不分类',
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 4,
              child: _dropdown<String>(
                id: 'schedule-field-action',
                label: '到点后',
                value: action,
                items: _actionChoiceLabels,
                onChanged: (value) => setState(() => action = value),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _dropdown<String?>(
          id: 'schedule-field-sid',
          label: '要不要说给谁',
          value: sid,
          items: {for (final session in widget.sessions) session.sid: session.label},
          onChanged: (value) => setState(() => sid = value),
          nullableLabel: '不用告诉谁',
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
                child: Text('这个时刻已经过去了：落下去她会马上被叫醒一次。',
                    style: TextStyle(fontSize: 11, height: 1.5, color: IrmiaTheme.warn)),
              ),
            ],
          ),
        ),
      Text(
        '建好之后它就是一条真安排：到点她会看见你写的这句。',
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
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  if (t == '今天' || t == '今日') return today;
  if (t == '明天' || t == '明日') return today.add(const Duration(days: 1));
  if (t == '后天') return today.add(const Duration(days: 2));
  final iso = RegExp(r'^(\d{4})-(\d{1,2})-(\d{1,2})$').firstMatch(t);
  if (iso != null) {
    return _dayOf(int.parse(iso.group(1)!), int.parse(iso.group(2)!), int.parse(iso.group(3)!));
  }
  final cn = RegExp(r'^(\d{1,2})月(\d{1,2})日?$').firstMatch(t);
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
  switch (raw.trim()) {
    case '自主工作':
    case 'self':
      return 'self';
    case '提醒':
    case '提醒你':
    case 'notify':
      return 'notify';
    case '存草稿':
    case 'draft':
      return 'draft';
    default:
      return raw.trim();
  }
}

/// `payload.dur`（分钟）：缺省 **30**（约定值——见周历图例下面那句说明）
int _durOf(Object? payload) {
  if (payload is Map) {
    final value = payload['dur'];
    if (value is num && value > 0) return value.toInt();
  }
  return 30;
}

String _sidLabel(String sid, Map<String, String> names) {
  final name = names[sid] ?? '';
  if (name.isEmpty) return sid;
  return '$name（${_sidShort(sid)}）';
}

String _sidShort(String sid) {
  final cut = sid.lastIndexOf(':');
  if (cut < 0 || cut == sid.length - 1) return sid;
  final head = sid.substring(0, cut + 1);
  final tail = sid.substring(cut + 1);
  return '$head${tail.length <= 4 ? tail : tail.substring(0, 4)}…';
}

DateTime _weekStartOf(DateTime day) {
  final midnight = DateTime(day.year, day.month, day.day);
  return midnight.subtract(Duration(days: midnight.weekday - DateTime.monday));
}

String _dayKeyOf(DateTime? day) =>
    day == null ? '' : '${day.year}-${_p2(day.month)}-${_p2(day.day)}';

String _dayLabel(String key) {
  final parts = key.split('-');
  if (parts.length != 3) return key;
  return '${int.tryParse(parts[1]) ?? parts[1]}月${int.tryParse(parts[2]) ?? parts[2]}日';
}

String _whenStamp(DateTime dt) => '${dt.month}月${dt.day}日 · ${_hhmm(dt)}';

String _hhmm(DateTime dt) => '${_p2(dt.hour)}:${_p2(dt.minute)}';

String _p2(int value) => value.toString().padLeft(2, '0');

String _weekdayCn(int weekday) =>
    const ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekday - 1];

/// cron 的人话化。与 [_parseCron] **同一套判据**（能算的就说得出来，算不出的原样给人看）：
/// `M H * * *` ⇒ 每天 HH:MM ／ `M H * * D` ⇒ 每周三 HH:MM ／ `M H * * D,D,…` ⇒ 每周二/四/六 HH:MM
/// ／ `M H * * A-B` ⇒ 每周一至周五 HH:MM ／ 其余（步长、带月/日限定…）⇒ **原样**
/// （线上那条 `0 20 * * 2,4,6` 原来只会显示成一串数字，读的人根本看不出"每周三练"）。
String _cronLabel(String expr) {
  final parts = expr.trim().split(RegExp(r'\s+'));
  if (parts.length != 5) return expr;
  final minute = int.tryParse(parts[0]);
  final hour = int.tryParse(parts[1]);
  if (minute == null || hour == null) return expr;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return expr;
  if (parts[2] != '*' || parts[3] != '*') return expr;
  final time = '${_p2(hour)}:${_p2(minute)}';
  if (parts[4] == '*') return '每天 $time';
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  final words = <String>[];
  for (final token in parts[4].split(',')) {
    final range = RegExp(r'^(\d)-(\d)$').firstMatch(token);
    if (range != null) {
      final from = int.parse(range.group(1)!);
      final to = int.parse(range.group(2)!);
      if (from > to || to > 7) return expr;
      words.add('${names[from % 7]}至周${names[to % 7]}');
      continue;
    }
    final day = int.tryParse(token);
    if (day == null || day < 0 || day > 7) return expr;
    words.add(names[day % 7]);
  }
  if (words.isEmpty) return expr;
  return '每周${words.join('/')} $time';
}
