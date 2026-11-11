import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';

import '../api.dart';
import '../app.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../ui_kit.dart';
import 'mood_kit.dart';
import 'stickers_panel.dart';

/// 情绪页 —— 按 2026-10-31 设计稿重做的那一版。
///
/// 版式（宽窗 2×2 / 窄窗单列）：
///   · 当前心境（hero）：状态词 + 一句人话 + 两个 stat pill + 同心轨道与渐变球；
///     右上角是情绪系统总开关（设计稿没有，用户要求人可开关）；
///   · 情绪构成：六行色点 + 轨道 + 百分比（行序跟 `/api/affect` 的 `emotions` 键序走）；
///   · 心境轨迹：今天 / 近 7 天，自绘折线（虚线网格、渐变面积、平滑曲线、末端圆点）；
///   · 最近的影响：最近 5 条原因，点开是右侧详情浮层；
///   · 页脚一行：情绪不改变工具授权与任务要求。
///
/// 数据只有一条来源：`GET /api/affect`（`history` 是后端按 `affect/appraised` 折出来的轨迹）。
/// 页面**不自己算**情绪：阈值、主导情绪、颜色都只做"读数的解释"，公式在 `src/affect/`。
///
/// 表情包仍在本页第二个 tab（`StickersPanel` 自带左栏与单一滚动区），两件事回答同一个问题：
/// 「她现在用什么表达情绪」。
///
/// 2026-11-03 后端把第六维从「好奇」换成「害羞」（键 `shyness`），并在 `/api/intimacy`
/// 上加了四读数状态机（`phase` / `estrus`）。页面两边都按**后端给的键**渲染：
/// 六维的行序不写死旧键；`phase` / `estrus` 缺失（老后端）时那一行整段不出现。
///
/// 2026-11-02 加第三个 tab「亲密」，2026-11-05 按用户要求**整体向情绪面板靠拢**：
/// 左侧 phase 卡 + 右侧 2×2 读数卡，下方最近变化 / 四色潮汐；所有卡片走情绪页的
/// `_panelFrame` / `MoodPanelTop`（同一 surface、圆角、描边、发丝影），字体与明暗底色
/// 也跟情绪页一致，不再有独立的玫瑰/夜紫主题和 Georgia 编辑风。
/// 数据仍只有一条来源 `GET /api/intimacy`，开关与上限仍走
/// `POST /api/commands/config-update`（`intimacy.enabled` / `intimacy.maxLevel`）。
/// 四条硬规矩：
///   1. 只有点进这个 tab 才会读 `/api/intimacy`（老后端没有这条端点，别让首页多一条红的）；
///   2. 关闭态只留说明 + 开关 + 上限，一个读数都不显示（用户要求）；
///   3. 走势图**至少 2 个点才画**——1 点时画出来是一块灰，情绪页踩过 RangeError；
///   4. `labels` / `estrus` / `afterglow` / `phase` 全按后端字段渲染，前端不二次推导。
class MoodPage extends StatefulWidget {
  const MoodPage({super.key, required this.state});

  final AppState state;

  @override
  State<MoodPage> createState() => _MoodPageState();
}

class _MoodPageState extends State<MoodPage> with WidgetsBindingObserver {
  int _tab = 0; // 0=情绪 1=表情包 2=亲密

  // ── 表情包（数据在这里取，版式归 StickersPanel）──
  Map<String, dynamic>? _stickers;
  String? _stickersError;
  bool _stickersLoading = true;

  // ── 情绪 ──
  _AffectSnapshot? _affect;
  String? _affectError;
  bool _affectInvalid = false;
  bool _affectLoading = true;
  bool _saving = false;
  late int _revision;

  /// 后台静默重取的节拍：SSE 断了、或窗口从托盘里回来时，读数不能停在旧值上
  static const Duration _affectPollEvery = Duration(seconds: 60);
  Timer? _affectPoll;

  /// 请求版次：只让**最后发出**的那条响应上屏（手动、定时、SSE、开关回读可能重叠）
  int _affectEpoch = 0;

  // ── 亲密 ──
  //
  // 与情绪分开一套状态：两条端点的失败互不影响（老后端没有 /api/intimacy 时，
  // 情绪那一屏照常是好的），轮询也只在亲密这个 tab 上跑。
  _IntimacySnapshot? _intimacy;
  String? _intimacyError;
  _IntimacyFailure _intimacyFailure = _IntimacyFailure.none;
  bool _intimacyLoading = false;
  bool _intimacySaving = false;
  int _intimacyEpoch = 0;

  /// 只在 tab==2 上转的节拍（见 [_startIntimacyPoll]）
  static const Duration _intimacyPollEvery = Duration(seconds: 60);
  Timer? _intimacyPoll;

  @override
  void initState() {
    super.initState();
    _revision = widget.state.affectRevision;
    widget.state.addListener(_onStateChange);
    WidgetsBinding.instance.addObserver(this);
    _affectPoll = Timer.periodic(_affectPollEvery, (_) {
      if (!_saving) unawaited(_loadAffect(silent: true));
    });
    unawaited(_loadStickers());
    unawaited(_loadAffect());
  }

  @override
  void dispose() {
    _affectPoll?.cancel();
    _affectPoll = null;
    _intimacyPoll?.cancel();
    _intimacyPoll = null;
    WidgetsBinding.instance.removeObserver(this);
    widget.state.removeListener(_onStateChange);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // 从托盘/最小化回来时立刻重取一次；SSE 断线期间攒下的变化只在这条路上补
    if (state != AppLifecycleState.resumed) return;
    if (!_saving) unawaited(_loadAffect(silent: true));
    if (_tab == 2 && !_intimacySaving) unawaited(_loadIntimacy(silent: true));
  }

  void _onStateChange() {
    if (_revision == widget.state.affectRevision) return;
    _revision = widget.state.affectRevision;
    // 自己写开关时已经在 `_toggleAffect` 里回读，别叠第二条
    if (!_saving) unawaited(_loadAffect(silent: true));
  }

  /// 切 tab：亲密那一条端点是**懒加载**的（见文件头），只在这里开第一枪。
  void _selectTab(int index) {
    if (index == _tab) return;
    setState(() => _tab = index);
    if (index == 2) {
      _startIntimacyPoll();
      unawaited(_loadIntimacy(silent: _intimacy != null));
    } else {
      _stopIntimacyPoll();
    }
  }

  void _startIntimacyPoll() {
    _intimacyPoll ??= Timer.periodic(_intimacyPollEvery, (_) {
      if (_tab == 2 && !_intimacySaving) unawaited(_loadIntimacy(silent: true));
    });
  }

  void _stopIntimacyPoll() {
    _intimacyPoll?.cancel();
    _intimacyPoll = null;
  }

  Future<void> _loadStickers({bool silent = false}) async {
    if (!silent && mounted) setState(() => _stickersLoading = true);
    try {
      final raw = await widget.state.api.get('/api/stickers?pageSize=200');
      if (!mounted) return;
      if (raw is! Map<String, dynamic>) throw const FormatException('invalid stickers response');
      setState(() {
        _stickers = raw;
        _stickersError = null;
        _stickersLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _stickersError = '$err';
        _stickersLoading = false;
      });
    }
  }

  Future<void> _loadAffect({bool silent = false}) async {
    if (!mounted) return;
    final epoch = ++_affectEpoch;
    if (!silent) {
      setState(() {
        _affectError = null;
        _affectInvalid = false;
        if (_affect == null) _affectLoading = true;
      });
    }
    try {
      final raw = await widget.state.api.get('/api/affect');
      // 只认最后发出的那条：晚到的旧响应（定时/手动/SSE 叠在一起时）不许把新读数盖回去
      if (!mounted || epoch != _affectEpoch) return;
      final view = raw is Map ? _AffectSnapshot.parse(Map<String, dynamic>.from(raw)) : null;
      if (view == null) throw const FormatException('invalid affect response');
      setState(() {
        _affect = view;
        _affectError = null;
        _affectInvalid = false;
        _affectLoading = false;
      });
    } catch (err) {
      if (!mounted || epoch != _affectEpoch) return;
      // 静默刷新失败不打断屏幕：旧读数留着，下一拍再试
      if (silent) return;
      setState(() {
        _affectError = '$err';
        _affectInvalid = err is FormatException;
        _affectLoading = false;
      });
    }
  }

  Future<void> _toggleAffect(bool next) async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {
          // 评价器是独立开关（config.affect.evaluatorEnabled，默认 false），而 real-loop 把评价
          // 嵌套在 master 开关内：只开 master 的话一次评价都不会跑。页面这一个开关同时写两个，
          // 关的时候也一起关，避免留下一个空转的评价器。
          'fields': {'affect.enabled': next, 'affect.evaluatorEnabled': next},
        },
        confirm: 'config-update',
      );
      await _loadAffect(silent: true);
      if (!mounted) return;
      setState(() => _saving = false);
      final s = IrmiaStrings.of(context);
      final applied = _affect?.enabled == next;
      IrmiaToast.show(
        context,
        s.affectSaved(next, applied),
        kind: applied ? ToastKind.success : ToastKind.info,
      );
    } catch (err) {
      if (!mounted) return;
      setState(() => _saving = false);
      IrmiaToast.show(context, IrmiaStrings.of(context).affectSaveFailed('$err'), kind: ToastKind.error);
    }
  }

  void _openDetails() {
    final view = _affect;
    if (view == null || !view.hasData) return;
    unawaited(_showDetailSheet(context, view));
  }

  // ── 亲密：读 / 写 / 详情 ──

  Future<void> _loadIntimacy({bool silent = false}) async {
    if (!mounted) return;
    final epoch = ++_intimacyEpoch;
    if (!silent) {
      setState(() {
        _intimacyError = null;
        _intimacyFailure = _IntimacyFailure.none;
        _intimacyLoading = true;
      });
    }
    try {
      final raw = await widget.state.api.get('/api/intimacy');
      if (!mounted || epoch != _intimacyEpoch) return;
      final view = raw is Map
          ? _IntimacySnapshot.parse(Map<String, dynamic>.from(raw))
          : null;
      // 老后端没有这条端点 → get 抛 404；形状不对 → parse 回 null。
      // 两种都落到"读不出来 + 重试"，不伪造一份全 0 的读数。
      if (view == null) {
        throw const FormatException('invalid intimacy response');
      }
      setState(() {
        _intimacy = view;
        _intimacyError = null;
        _intimacyFailure = _IntimacyFailure.none;
        _intimacyLoading = false;
      });
    } catch (err) {
      if (!mounted || epoch != _intimacyEpoch) return;
      if (silent) return; // 静默刷新失败不打断屏幕，下一拍再试
      setState(() {
        _intimacyError = '$err';
        _intimacyFailure = switch (err) {
          ApiAuthError() => _IntimacyFailure.auth,
          ApiError(status: 404) => _IntimacyFailure.unsupported,
          FormatException() => _IntimacyFailure.invalid,
          _ => _IntimacyFailure.load,
        };
        _intimacyLoading = false;
      });
    }
  }

  /// 写一条 `intimacy.*` 配置并立刻回读。**不**用本地 draft 冒充已生效：
  /// 保存后重新 `GET /api/intimacy`，以服务端返回的 enabled / maxLevel 为准。
  Future<void> _postIntimacyFields(Map<String, dynamic> fields) async {
    await widget.state.api.post('/api/commands/config-update', {
      'fields': fields,
    }, confirm: 'config-update');
    await _loadIntimacy(silent: true);
  }

  Future<void> _toggleIntimacy(bool next) async {
    if (_intimacySaving) return;
    setState(() => _intimacySaving = true);
    try {
      await _postIntimacyFields({'intimacy.enabled': next});
      if (!mounted) return;
      setState(() => _intimacySaving = false);
      final s = IrmiaStrings.of(context);
      final applied = _intimacy?.enabled == next;
      IrmiaToast.show(
        context,
        s.intimacySaved(next, applied),
        kind: applied ? ToastKind.success : ToastKind.info,
      );
    } catch (err) {
      if (!mounted) return;
      setState(() => _intimacySaving = false);
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).intimacySaveFailed('$err'),
        kind: ToastKind.error,
      );
    }
  }

  /// 上限三选一：点当前已选中的那档不发请求（「保存」只在真的改了时发生）。
  Future<void> _setIntimacyLevel(String level) async {
    if (_intimacySaving) return;
    if (_intimacy?.maxLevel == level) return;
    setState(() => _intimacySaving = true);
    try {
      await _postIntimacyFields({'intimacy.maxLevel': level});
      if (!mounted) return;
      setState(() => _intimacySaving = false);
      final s = IrmiaStrings.of(context);
      // 回读到的上限没跟上（要重启 / 环境变量覆盖）就说「等待生效」，不谎报已生效
      final applied = _intimacy?.maxLevel == level;
      IrmiaToast.show(
        context,
        s.intimacyLevelSaved(s.intimacyLevel(level), applied),
        kind: applied ? ToastKind.success : ToastKind.info,
      );
    } catch (err) {
      if (!mounted) return;
      setState(() => _intimacySaving = false);
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).intimacySaveFailed('$err'),
        kind: ToastKind.error,
      );
    }
  }

  /// 设置面板的「保存」：一次提交改过的字段，回读后再决定吐司说“已生效”还是“等待生效”。
  /// 返回 false 表示写请求失败（面板保持打开，不假装保存成功）。
  Future<bool> _saveIntimacySettings(bool enabled, String level) async {
    if (_intimacySaving) return false;
    final view = _intimacy;
    final fields = <String, dynamic>{
      if (view == null || view.enabled != enabled) 'intimacy.enabled': enabled,
      if (view == null || view.maxLevel != level) 'intimacy.maxLevel': level,
    };
    if (fields.isEmpty) return true;
    setState(() => _intimacySaving = true);
    try {
      await _postIntimacyFields(fields);
      if (!mounted) return false;
      setState(() => _intimacySaving = false);
      final s = IrmiaStrings.of(context);
      final applied =
          _intimacy?.enabled == enabled && _intimacy?.maxLevel == level;
      IrmiaToast.show(
        context,
        applied ? s.intimacySettingsSaved : s.intimacySettingsPending,
        kind: applied ? ToastKind.success : ToastKind.info,
      );
      return true;
    } catch (err) {
      if (!mounted) return false;
      setState(() => _intimacySaving = false);
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).intimacySaveFailed('$err'),
        kind: ToastKind.error,
      );
      return false;
    }
  }

  void _openIntimacySettings() {
    final view = _intimacy;
    if (view == null) return;
    unawaited(
      _showIntimacySettings(context, view: view, onSave: _saveIntimacySettings),
    );
  }

  void _openIntimacyDetails() {
    final view = _intimacy;
    if (view == null) return;
    unawaited(_showIntimacyDetails(context, view));
  }

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final skin = MoodPanelSkin.of(context);
    final view = _affect;
    final intimacy = _intimacy;
    final onIntimacy = _tab == 2;
    // 页头右上角那一格：有评价才报相对时间；关了说「未开启」；开着但还没评价就留空。
    // 亲密 tab 用同一套口径（它的 updatedAt 是"最近一拍读数"的时刻）。
    final updatedLabel = onIntimacy
        ? (intimacy == null
              ? null
              : !intimacy.enabled
              ? s.moodAffectOff
              : intimacy.updatedAt == null
              ? s.intimacyNoUpdated
              : _agoLabel(s, intimacy.updatedAt!))
        : view == null
        ? null
        : !view.enabled
        ? s.moodAffectOff
        : view.hasData
        ? _updatedLabel(s, view.updatedAt)
        : null;
    final page = Column(
      children: [
        _MoodHeader(
          s: s,
          skin: skin,
          tab: _tab,
          onTab: _selectTab,
          onDetails: onIntimacy
              ? (intimacy == null ? null : _openIntimacySettings)
              : (view?.hasData == true ? _openDetails : null),
          detailTooltip: onIntimacy
              ? s.intimacySettingsTooltip
              : s.moodDetailTooltip,
          updatedLabel: updatedLabel,
          // 亲密这个 tab 的开关在设置面板 / 关闭态卡里（关闭态要"说明 + 开关 + 上限"挨在一起），
          // 页头这一格就留给情绪那两屏——情绪页现有行为一个字都不动。
          showSystem: !onIntimacy,
          systemLabel: s.affectSystem,
          systemOn: view?.enabled == true,
          pending: !onIntimacy &&
              view != null &&
              view.configured != view.enabled,
          saving: onIntimacy ? _intimacySaving : _saving,
          onToggle: (onIntimacy || view == null) ? null : _toggleAffect,
          onRefresh: onIntimacy
              ? () => unawaited(_loadIntimacy())
              : () => unawaited(_loadAffect(silent: true)),
        ),
        Expanded(child: _tabBody(s, skin)),
        if (_tab == 0) _FooterLine(s: s, skin: skin),
      ],
    );
    return Container(
      key: const ValueKey('mood-page-background'),
      // 三个 tab 共用情绪面板的底色（明暗都跟随主题），亲密不再有自己的背景层。
      color: skin.bg,
      child: page,
    );
  }

  Widget _tabBody(AppStrings s, MoodPanelSkin skin) {
    switch (_tab) {
      case 0:
        return _affectBody(s, skin);
      case 1:
        return _stickersBody(s, skin);
      default:
        return _intimacyBody(s, skin);
    }
  }

  Widget _affectBody(AppStrings s, MoodPanelSkin skin) {
    if (_affectLoading && _affect == null) {
      return Center(child: CircularProgressIndicator(strokeWidth: 2, color: skin.primary));
    }
    if (_affect == null) {
      return _ErrorBlock(
        s: s,
        skin: skin,
        message: _affectInvalid ? s.affectInvalidData : s.affectLoadFailed(_affectError ?? ''),
        onRetry: () => unawaited(_loadAffect()),
      );
    }
    return Column(children: [
      if (_affectError != null)
        _InlineError(
          s: s,
          skin: skin,
          message: _affectInvalid ? s.affectInvalidData : s.affectLoadFailed(_affectError ?? ''),
          onRetry: () => unawaited(_loadAffect()),
        ),
      Expanded(child: _grid(s, skin)),
    ]);
  }

  Widget _grid(AppStrings s, MoodPanelSkin skin) {
    final view = _affect;
    final active = view?.hasData == true;
    return LayoutBuilder(builder: (context, constraints) {
      // 宽且够高才摆 2×2：高度不够时宁可单列滚动，也不把卡片压扁（压扁就会溢出）
      final wide = constraints.maxWidth >= 980 && constraints.maxHeight >= 620;
      const pad = EdgeInsets.fromLTRB(26, 14, 26, 4);
      if (wide) {
        return Padding(
          padding: pad,
          child: Column(children: [
            Expanded(
              flex: 118,
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Expanded(flex: 138, child: _hero(s, skin, view)),
                const SizedBox(width: 19),
                Expanded(flex: 100, child: _emotions(s, skin, view, active)),
              ]),
            ),
            const SizedBox(height: 19),
            Expanded(
              flex: 91,
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Expanded(flex: 138, child: _timeline(s, skin, view, active)),
                const SizedBox(width: 19),
                Expanded(flex: 100, child: _factors(s, skin, view, active)),
              ]),
            ),
          ]),
        );
      }
      return SingleChildScrollView(
        padding: pad,
        child: Column(children: [
          SizedBox(height: 372, child: _hero(s, skin, view)),
          const SizedBox(height: 16),
          SizedBox(height: 318, child: _emotions(s, skin, view, active)),
          const SizedBox(height: 16),
          SizedBox(height: 300, child: _timeline(s, skin, view, active)),
          const SizedBox(height: 16),
          SizedBox(height: 300, child: _factors(s, skin, view, active)),
        ]),
      );
    });
  }

  Widget _hero(AppStrings s, MoodPanelSkin skin, _AffectSnapshot? view) => _HeroCard(
        s: s,
        skin: skin,
        view: view,
        onDetails: view?.hasData == true ? _openDetails : null,
      );

  Widget _emotions(AppStrings s, MoodPanelSkin skin, _AffectSnapshot? view, bool active) =>
      _EmotionMixCard(s: s, skin: skin, view: view, active: active);

  Widget _timeline(AppStrings s, MoodPanelSkin skin, _AffectSnapshot? view, bool active) =>
      _TimelineCard(s: s, skin: skin, view: view, active: active);

  Widget _factors(AppStrings s, MoodPanelSkin skin, _AffectSnapshot? view, bool active) => _FactorsCard(
        s: s,
        skin: skin,
        view: view,
        active: active,
        onOpen: view?.hasData == true ? _openDetails : null,
      );

  Widget _stickersBody(AppStrings s, MoodPanelSkin skin) {
    if (_stickersLoading && _stickers == null) {
      return Center(child: CircularProgressIndicator(strokeWidth: 2, color: skin.primary));
    }
    if (_stickersError != null && _stickers == null) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(s.stickersLoadFailed(_stickersError ?? ''),
              style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
          const SizedBox(height: 10),
          TextButton(onPressed: () => unawaited(_loadStickers()), child: Text(s.retry)),
        ]),
      );
    }
    return StickersPanel(
      state: widget.state,
      view: _stickers!,
      onRefresh: () => _loadStickers(silent: true),
    );
  }

  // ── 亲密 tab 的正文 ──

  Widget _intimacyBody(AppStrings s, MoodPanelSkin skin) {
    if (_intimacyLoading && _intimacy == null) {
      return _IntimacySkeleton(s: s, skin: skin);
    }
    final view = _intimacy;
    if (view == null) {
      return _IntimacyErrorState(
        s: s,
        skin: skin,
        title: _intimacyErrorTitle(s),
        body: _intimacyErrorBody(s),
        onRetry: () => unawaited(_loadIntimacy()),
      );
    }
    final hasInlineError = _intimacyFailure != _IntimacyFailure.none;
    return Column(
      children: [
        if (hasInlineError)
          _InlineError(
            s: s,
            skin: skin,
            message: _intimacyErrorBody(s),
            onRetry: () => unawaited(_loadIntimacy()),
          ),
        Expanded(
          child: view.enabled
              ? _intimacyLayout(s, skin, view)
              : _intimacyClosedLayout(s, skin, view),
        ),
      ],
    );
  }

  String _intimacyErrorTitle(AppStrings s) => switch (_intimacyFailure) {
    _IntimacyFailure.unsupported => s.intimacyErrorUnsupportedTitle,
    _IntimacyFailure.auth => s.intimacyErrorAuthTitle,
    _IntimacyFailure.invalid => s.intimacyErrorInvalidTitle,
    _ => s.intimacyErrorLoadTitle,
  };

  String _intimacyErrorBody(AppStrings s) => switch (_intimacyFailure) {
    _IntimacyFailure.unsupported => s.intimacyErrorUnsupportedBody,
    _IntimacyFailure.auth => s.intimacyErrorAuthBody,
    _IntimacyFailure.invalid => s.intimacyErrorInvalidBody,
    _ => s.intimacyLoadFailed(_intimacyError ?? ''),
  };

  Widget _intimacyLayout(
    AppStrings s,
    MoodPanelSkin skin,
    _IntimacySnapshot view,
  ) {
    return LayoutBuilder(
      builder: (context, constraints) {
        // 宽屏左 phase、右四读数；下方 causes/history 不动。
        final wide =
            constraints.maxWidth >= 1000 && constraints.maxHeight >= 720;
        final note = Align(
          alignment: Alignment.centerRight,
          child: Text(
            s.intimacySyncNote,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 9.5, color: skin.mutedSoft),
          ),
        );
        if (wide) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(26, 14, 26, 14),
            child: Column(
              children: [
                note,
                const SizedBox(height: 10),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        flex: 88,
                        child: _IntimacyPhaseCard(
                          s: s,
                          skin: skin,
                          view: view,
                          onDetails: _openIntimacyDetails,
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        flex: 112,
                        child: _IntimacyReadingsPanel(
                          s: s,
                          skin: skin,
                          view: view,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  height: 250,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        flex: 78,
                        child: _IntimacyCausesPanel(
                          s: s,
                          skin: skin,
                          view: view,
                        ),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        flex: 122,
                        child: _IntimacyHistoryPanel(
                          s: s,
                          skin: skin,
                          view: view,
                        ),
                      ),
                    ],
                  ),
                ),
                if (view.configured != view.enabled) ...[
                  const SizedBox(height: 10),
                  _IntimacyPendingNote(text: s.intimacyPending, skin: skin),
                ],
                const SizedBox(height: 10),
                _IntimacyFooter(s: s, skin: skin),
              ],
            ),
          );
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(26, 14, 26, 22),
          child: Column(
            children: [
              note,
              const SizedBox(height: 10),
              // 窄屏顺序：phase → 四读数 → causes → history
              SizedBox(
                height: 360,
                child: _IntimacyPhaseCard(
                  s: s,
                  skin: skin,
                  view: view,
                  onDetails: _openIntimacyDetails,
                ),
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 400,
                child: _IntimacyReadingsPanel(s: s, skin: skin, view: view),
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 260,
                child: _IntimacyCausesPanel(s: s, skin: skin, view: view),
              ),
              const SizedBox(height: 16),
              SizedBox(
                height: 280,
                child: _IntimacyHistoryPanel(s: s, skin: skin, view: view),
              ),
              if (view.configured != view.enabled) ...[
                const SizedBox(height: 10),
                _IntimacyPendingNote(text: s.intimacyPending, skin: skin),
              ],
              const SizedBox(height: 14),
              _IntimacyFooter(s: s, skin: skin),
            ],
          ),
        );
      },
    );
  }

  /// 关闭态：**只**留说明 + 开关 + 上限（用户明确要求，不显示任何读数 / line / causes / history）。
  Widget _intimacyClosedLayout(
    AppStrings s,
    MoodPanelSkin skin,
    _IntimacySnapshot view,
  ) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(26, 14, 26, 22),
      child: Column(
        children: [
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 820),
              child: _IntimacyClosedCard(
                s: s,
                skin: skin,
                view: view,
                saving: _intimacySaving,
                onToggle: _toggleIntimacy,
                onLevel: (level) => unawaited(_setIntimacyLevel(level)),
              ),
            ),
          ),
          const SizedBox(height: 18),
          _IntimacyFooter(s: s, skin: skin),
        ],
      ),
    );
  }
}

// ─────────────────────────────── 页头 / 页脚 ───────────────────────────────

class _MoodHeader extends StatelessWidget {
  const _MoodHeader({
    required this.s,
    required this.skin,
    required this.tab,
    required this.onTab,
    required this.onDetails,
    required this.detailTooltip,
    required this.updatedLabel,
    required this.showSystem,
    required this.systemLabel,
    required this.systemOn,
    required this.pending,
    required this.saving,
    required this.onToggle,
    required this.onRefresh,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final int tab;
  final ValueChanged<int> onTab;
  final VoidCallback? onDetails;

  /// 齿轮的 tooltip（情绪与亲密各说各的）
  final String detailTooltip;

  /// 右上角更新时间：有评价才是相对时间；关了是「未开启」；开着没评价 / 没读到是 null（留空）
  final String? updatedLabel;

  /// 情绪那两屏才在页头摆「情绪系统 + 开关」；亲密那屏的开关在它自己的设置卡里
  final bool showSystem;
  final String systemLabel;
  final bool systemOn;

  /// 配置里的值与当前生效值不同（环境变量覆盖 / 改动尚未生效）时，页头如实挂一句提示
  final bool pending;
  final bool saving;
  final ValueChanged<bool>? onToggle;

  /// 手动静默重取（tooltip 用现成的「重试」；不显示 loading）
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    final onIntimacy = tab == 2;
    final eyebrow = onIntimacy ? s.intimacyPageEyebrow : s.moodPageEyebrow;
    final eyebrowColor = skin.primary.withValues(alpha: 0.8);
    final titleStyle = TextStyle(
      fontSize: 29,
      height: 1.1,
      letterSpacing: 0.5,
      fontWeight: FontWeight.w700,
      color: skin.heading,
    );
    final title = onIntimacy
        ? Text(
            '${s.intimacyHeadingLead}${s.intimacyHeadingAccent}${s.intimacyHeadingTail}',
            key: const ValueKey('intimacy-heading'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: titleStyle,
          )
        : Text(s.moodHeading, style: titleStyle);
    final tagline = Text(
      onIntimacy ? s.intimacyTagline : s.moodTagline,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(fontSize: 12, color: skin.mutedSoft),
    );
    final tabs = _SegmentedTabs(s: s, skin: skin, tab: tab, onTab: onTab);
    final updated = updatedLabel == null
        ? null
        : Text(
            updatedLabel!,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 10, color: skin.mutedSoft),
          );
    final system = !showSystem
        ? null
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                systemLabel,
                style: TextStyle(fontSize: 10, color: skin.mutedSoft),
              ),
              const SizedBox(width: 4),
              SizedBox(
                width: 46,
                height: 28,
                child: FittedBox(
                  fit: BoxFit.contain,
                  child: Switch(
                    value: systemOn,
                    onChanged: saving ? null : onToggle,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                ),
              ),
            ],
          );
    final refresh = _SquareIconButton(
      key: const ValueKey('mood-refresh'),
      icon: Icons.refresh_rounded,
      tooltip: s.retry,
      skin: skin,
      onTap: onRefresh,
    );
    final gear = _SquareIconButton(
      key: const ValueKey('mood-details'),
      icon: Icons.settings_rounded,
      tooltip: detailTooltip,
      skin: skin,
      onTap: onDetails,
    );

    return Padding(
      key: const ValueKey('mood-header'),
      padding: const EdgeInsets.fromLTRB(26, 22, 26, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            eyebrow,
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 2,
              color: eyebrowColor,
            ),
          ),
          const SizedBox(height: 8),
          LayoutBuilder(
            builder: (context, constraints) {
              // 宽窗一行：标题/说明 → 情绪切换 → 更新时间 → 情绪系统+开关 → 刷新 → 齿轮。
              // 亲密页标题更长（「在克制与靠近之间」），阈值单独抬高，窄窗走下面那套换行布局。
              if (constraints.maxWidth >= (onIntimacy ? 1000 : 640)) {
                // 亲密页中英文标题都比「情绪」长；给标题一个上限并按需等比缩小，
                // 说明仍然吃掉剩余空间，tab / 按钮因此始终靠右，不会被标题挤出去。
                final titleMaxWidth = onIntimacy
                    ? math.min(
                        720.0,
                        math.max(260.0, constraints.maxWidth - 480),
                      )
                    : null;
                final headerTitle = titleMaxWidth == null
                    ? title
                    : ConstrainedBox(
                        constraints: BoxConstraints(maxWidth: titleMaxWidth),
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: Alignment.centerLeft,
                          child: title,
                        ),
                      );
                return Row(
                  children: [
                    // 标题固定宽度、说明吃掉剩余空间：tab 与按钮因此始终靠右。
                    // 亲密页标题长，所以另给一个更宽的断点；窄窗走下面那套两行布局。
                    headerTitle,
                    const SizedBox(width: 12),
                    Expanded(child: tagline),
                    const SizedBox(width: 10),
                    tabs,
                    const SizedBox(width: 10),
                    if (updated != null) ...[
                      updated,
                      const SizedBox(width: 10),
                    ],
                    if (system != null) ...[system, const SizedBox(width: 10)],
                    refresh,
                    const SizedBox(width: 10),
                    gear,
                  ],
                );
              }
              // 窄窗：标题一行，控件另起一行靠右并可换行；再窄也不会溢出。
              // 标题包在 FittedBox 里：英文长标题在 400 宽窗口也不会顶出红条。
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: FittedBox(
                          fit: BoxFit.scaleDown,
                          alignment: Alignment.centerLeft,
                          child: title,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(child: tagline),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Wrap(
                      alignment: WrapAlignment.end,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      spacing: 10,
                      runSpacing: 8,
                      children: [
                        tabs,
                        if (updated != null) updated,
                        if (system != null) system,
                        refresh,
                        gear,
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
          if (pending) ...[
            const SizedBox(height: 6),
            Row(
              key: const ValueKey('mood-pending'),
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 1),
                  child: Icon(
                    Icons.info_outline_rounded,
                    size: 12,
                    color: IrmiaTheme.warn,
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    s.affectPending,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 10,
                      height: 1.5,
                      color: IrmiaTheme.warn,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _SegmentedTabs extends StatelessWidget {
  const _SegmentedTabs({required this.s, required this.skin, required this.tab, required this.onTab});

  final AppStrings s;
  final MoodPanelSkin skin;
  final int tab;
  final ValueChanged<int> onTab;

  @override
  Widget build(BuildContext context) {
    // 三个 tab：情绪 / 表情包 / 亲密。亲密的读数是**另一层**（GET /api/intimacy），
    // 但版式与情绪同族，所以并排放在这里而不是新开一页。
    final labels = [s.affectTitle, s.stickerTitle, s.intimacyTitle];
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: skin.tabBg,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: skin.edge),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < labels.length; i++)
          InkWell(
            key: ValueKey('mood-tab-$i'),
            borderRadius: BorderRadius.circular(6),
            onTap: () => onTab(i),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 140),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              decoration: BoxDecoration(
                color: i == tab ? skin.card : Colors.transparent,
                borderRadius: BorderRadius.circular(6),
                boxShadow: i == tab ? skin.tabShadow : null,
              ),
              child: Text(
                labels[i],
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: i == tab ? FontWeight.w600 : FontWeight.w500,
                  color: i == tab ? skin.tabActive : skin.mutedSoft,
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

class _SquareIconButton extends StatelessWidget {
  const _SquareIconButton({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.skin,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final MoodPanelSkin skin;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Tooltip(
      message: tooltip,
      child: Material(
        color: skin.card,
        borderRadius: BorderRadius.circular(11),
        child: InkWell(
          borderRadius: BorderRadius.circular(11),
          onTap: onTap,
          child: Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(11),
              border: Border.all(color: skin.edge),
            ),
            // 禁用态也把图标画出来：半透明到近乎看不见时，页头最右边
            // 会像多了一个空的白色圆角方块（2026-11-04 实机反馈）。
            child: Icon(icon, size: 18, color: enabled ? skin.muted : skin.mutedSoft),
          ),
        ),
      ),
    );
  }
}

class _FooterLine extends StatelessWidget {
  const _FooterLine({required this.s, required this.skin});

  final AppStrings s;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(26, 6, 26, 14),
      child: Row(children: [
        Icon(Icons.info_outline_rounded, size: 13, color: skin.mutedSoft),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            s.moodFooterNote,
            maxLines: 2,
            style: TextStyle(fontSize: 10, height: 1.5, color: skin.mutedSoft),
          ),
        ),
        const SizedBox(width: 12),
        Text(
          s.moodEngineMark,
          style: TextStyle(fontSize: 10, letterSpacing: 0.4, color: skin.mutedSoft.withValues(alpha: 0.85)),
        ),
      ]),
    );
  }
}

// ─────────────────────────────── 当前心境 ───────────────────────────────

class _HeroCard extends StatelessWidget {
  const _HeroCard({
    required this.s,
    required this.skin,
    required this.view,
    required this.onDetails,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _AffectSnapshot? view;
  final VoidCallback? onDetails;

  @override
  Widget build(BuildContext context) {
    final enabled = view?.enabled == true;
    final hasData = view?.hasData == true;
    final dominant = hasData ? _dominantOf(view!) : null;
    // 评价器没开时，master 开着也永远不会产生新评价：空态必须说清是"评价器没开"，
    // 而不是让人以为只是"暂时没有新输入"。
    final evaluatorOn = view?.evaluatorEnabled ?? true;
    final stateText = !enabled
        ? s.moodState('off')
        : !hasData
            ? (evaluatorOn ? s.moodState('quiet') : s.moodEvaluatorOffState)
            : s.moodState(view!.valence >= 0.35
                ? 'positive'
                : view!.valence <= -0.15
                    ? 'low'
                    : 'steady');
    final headlineText = !enabled
        ? s.moodHeadline('off')
        : !hasData
            ? (evaluatorOn ? s.moodNoNewAppraisalTitle : s.moodEvaluatorOffTitle)
            : s.moodHeadline(dominant ?? 'neutral');
    final descText = !enabled
        ? s.moodDescription('off')
        : !hasData
            ? (evaluatorOn ? s.moodNoNewAppraisalBody : s.moodEvaluatorOffBody)
            : s.moodDescription(view!.valence >= 0.15
                ? 'positive'
                : view!.valence <= -0.15
                    ? 'low'
                    : 'warm');
    final orb = _OrbSpace(skin: skin, dominant: dominant, active: hasData);
    // causes 被投影窗口清空时，footer 也从轨迹最后一点取原因（与「最近的影响」同一个口径）
    final causes = hasData ? _causesOf(view!) : const <_CauseView>[];

    return moodPanelFrame(
      skin,
      key: const ValueKey('mood-hero'),
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 18),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        // 开关与更新时间已经移到页头右上角：这里只留卡名，右侧留白
        Row(children: [
          MoodSectionBadge(icon: Icons.favorite_outline_rounded, skin: skin),
          const SizedBox(width: 9),
          Text(s.moodHeroTitle,
              style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: skin.title)),
        ]),
        Expanded(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Expanded(
              flex: 53,
              child: LayoutBuilder(builder: (context, constraints) {
                // 极窄的卡片（单列 + 窄窗）里，说明与间距收一档，否则两枚 stat pill
                // 竖着叠起来会把 hero 的列撑出卡片底边
                final compact = constraints.maxHeight < 250 || constraints.maxWidth < 300;
                final titleSize = constraints.maxWidth < 340 ? 24.0 : 30.0;
                return Padding(
                  padding: const EdgeInsets.only(top: 4, right: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Row(children: [
                        _SignalDot(color: _activeColor(dominant), skin: skin),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            stateText,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: skin.muted),
                          ),
                        ),
                      ]),
                      SizedBox(height: compact ? 6 : 16),
                      GestureDetector(
                        onTap: onDetails,
                        child: Text(
                          headlineText,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: titleSize,
                            height: 1.3,
                            letterSpacing: 0.3,
                            fontWeight: FontWeight.w600,
                            color: skin.heading,
                          ),
                        ),
                      ),
                      SizedBox(height: compact ? 4 : 8),
                      Text(
                        descText,
                        maxLines: compact ? 2 : 3,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.5, height: 1.8, color: skin.muted),
                      ),
                      if (hasData) ...[
                        SizedBox(height: compact ? 8 : 18),
                        Wrap(spacing: 10, runSpacing: 8, children: [
                          _StatPill(
                            skin: skin,
                            compact: compact,
                            label: s.moodValenceLabel,
                            value: _signed(view!.valence),
                            word: s.moodValenceWord(_valenceWord(view!.valence)),
                          ),
                          _StatPill(
                            skin: skin,
                            compact: compact,
                            label: s.moodArousalLabel,
                            value: s.moodArousalValue((view!.arousal.clamp(0, 1) * 100).round()),
                            word: s.moodArousalWord(_arousalWord(view!.arousal)),
                          ),
                        ]),
                      ],
                    ],
                  ),
                );
              }),
            ),
            Expanded(flex: 47, child: orb),
          ]),
        ),
        Container(
          padding: const EdgeInsets.only(top: 12),
          decoration: BoxDecoration(border: Border(top: BorderSide(color: skin.edge))),
          child: Row(children: [
            Icon(Icons.info_outline_rounded, size: 13, color: skin.mutedSoft),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                hasData && causes.isNotEmpty
                    ? s.moodRecentCause(s.affectReason(causes.first.reasonCode))
                    : s.moodNoRecentCause,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 10, color: skin.muted),
              ),
            ),
            if (hasData) ...[
              const SizedBox(width: 8),
              Text(s.moodSettlesOverTime,
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: skin.muted)),
            ],
          ]),
        ),
      ]),
    );
  }
}

class _StatPill extends StatelessWidget {
  const _StatPill({
    required this.skin,
    required this.compact,
    required this.label,
    required this.value,
    required this.word,
  });

  final MoodPanelSkin skin;
  final bool compact;
  final String label;
  final String value;
  final String word;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.symmetric(horizontal: compact ? 9 : 11, vertical: compact ? 6 : 8),
      // 窄卡里两枚 pill 并排才放得下（106×2+10 会超出 217 的 hero 列）
      constraints: BoxConstraints(minWidth: compact ? 96 : 106),
      decoration: BoxDecoration(
        color: skin.chipBg,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: skin.chipBorder),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label, style: TextStyle(fontSize: 10, color: skin.mutedSoft)),
        const SizedBox(height: 4),
        Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(value,
                style: TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.2,
                  color: skin.primary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                )),
            const SizedBox(width: 4),
            Text(word, style: TextStyle(fontSize: 10, color: skin.muted)),
          ],
        ),
      ]),
    );
  }
}

class _SignalDot extends StatelessWidget {
  const _SignalDot({required this.color, required this.skin});

  final Color color;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 13,
      height: 13,
      decoration: BoxDecoration(color: color.withValues(alpha: 0.16), shape: BoxShape.circle),
      child: Center(
        child: Container(
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
      ),
    );
  }
}

/// 同心轨道 + 渐变球体（设计稿 `.orb-space`）。
///
/// 球体**不拦截点击**（`IgnorePointer`）：那张卡的可点区域是标题与右上角的齿轮。
class _OrbSpace extends StatefulWidget {
  const _OrbSpace({required this.skin, required this.dominant, required this.active});

  final MoodPanelSkin skin;
  final String? dominant;
  final bool active;

  @override
  State<_OrbSpace> createState() => _OrbSpaceState();
}

class _OrbSpaceState extends State<_OrbSpace> with SingleTickerProviderStateMixin {
  late final AnimationController _float = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 7),
  );
  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // 设计稿的 `prefers-reduced-motion` 那条：系统要求减少动效时球不浮动（球仍是那个球）
    final reduce = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    if (reduce) {
      _float.stop();
      _float.value = 0.5;
    } else if (!_started) {
      _started = true;
      _float.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    _float.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final (colors, stops) = MoodPalette.orbGradient(widget.dominant);
    return IgnorePointer(
      child: LayoutBuilder(builder: (context, constraints) {
        final base = math.min(constraints.maxWidth, constraints.maxHeight);
        final orb = (base * 0.56).clamp(92.0, 186.0).toDouble();
        final outer = base * 0.98;
        return Stack(
          alignment: Alignment.center,
          children: [
            _orbit(outer, widget.skin.primary.withValues(alpha: 0.10)),
            _orbit(outer * 0.84, widget.skin.primary.withValues(alpha: 0.12)),
            _orbit(outer * 0.65, widget.skin.primary.withValues(alpha: 0.18)),
            Positioned(right: outer * 0.17, top: outer * 0.12, child: _star(4, widget.skin.primary)),
            Positioned(left: outer * 0.14, top: outer * 0.38, child: _star(3, widget.skin.primary)),
            Positioned(right: outer * 0.16, bottom: outer * 0.17, child: _star(3, widget.skin.primary)),
            AnimatedBuilder(
              animation: _float,
              builder: (context, child) => Transform.translate(
                offset: Offset(0, -8 * Curves.easeInOut.transform(_float.value)),
                child: child,
              ),
              child: _Orb(colors: colors, stops: stops, size: orb, active: widget.active),
            ),
          ],
        );
      }),
    );
  }

  Widget _orbit(double size, Color color) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: color)),
      );

  Widget _star(double size, Color color) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(shape: BoxShape.circle, color: color.withValues(alpha: 0.25)),
      );
}

class _Orb extends StatelessWidget {
  const _Orb({required this.colors, required this.stops, required this.size, required this.active});

  final List<Color> colors;
  final List<double> stops;
  final double size;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return Opacity(
      opacity: active ? 1 : 0.5,
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: colors[3].withValues(alpha: 0.26),
              blurRadius: size * 0.22,
              offset: Offset(0, size * 0.1),
            ),
            BoxShadow(
              color: colors[2].withValues(alpha: 0.30),
              blurRadius: size * 0.42,
              spreadRadius: size * 0.05,
            ),
          ],
        ),
        child: ClipOval(
          child: CustomPaint(
            painter: _OrbPainter(colors: colors, stops: stops),
            size: Size.square(size),
          ),
        ),
      ),
    );
  }
}

class _OrbPainter extends CustomPainter {
  _OrbPainter({required this.colors, required this.stops});

  final List<Color> colors;
  final List<double> stops;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width * 0.31, size.height * 0.25);
    final shader = ui.Gradient.radial(
      center,
      size.width * 0.92,
      colors,
      stops,
    );
    final rect = Offset.zero & size;
    canvas.save();
    canvas.clipPath(Path()..addOval(rect));
    canvas.drawRect(rect, Paint()..shader = shader);
    // 内圈：设计稿 `.orb:before`（inset 12% 的细白环，横向压扁、逆时针转 26°）
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.rotate(-26 * math.pi / 180);
    canvas.scale(0.88, 1);
    canvas.drawOval(
      Rect.fromCircle(center: Offset.zero, radius: size.width * 0.38),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1
        ..color = Colors.white.withValues(alpha: 0.42),
    );
    canvas.restore();
    // 高光带：`.orb-sheen`（大椭圆，-33°）
    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.rotate(-33 * math.pi / 180);
    canvas.drawOval(
      Rect.fromCenter(center: Offset.zero, width: size.width * 1.8, height: size.height * 0.56),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = Colors.white.withValues(alpha: 0.62),
    );
    canvas.restore();
    // 顶部左上的柔光
    canvas.drawCircle(
      Offset(size.width * 0.31, size.height * 0.24),
      size.width * 0.30,
      Paint()
        ..shader = ui.Gradient.radial(
          Offset(size.width * 0.31, size.height * 0.24),
          size.width * 0.30,
          [Colors.white.withValues(alpha: 0.64), Colors.white.withValues(alpha: 0)],
        ),
    );
    // 右上角那颗亮点
    canvas.drawCircle(
      Offset(size.width * 0.86, size.height * 0.14),
      2.6,
      Paint()..color = Colors.white.withValues(alpha: 0.9),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _OrbPainter old) => old.colors != colors || old.stops != stops;
}

// ─────────────────────────────── 情绪构成 ───────────────────────────────

class _EmotionMixCard extends StatelessWidget {
  const _EmotionMixCard({required this.s, required this.skin, required this.view, required this.active});

  final AppStrings s;
  final MoodPanelSkin skin;
  final _AffectSnapshot? view;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return moodPanelFrame(
      skin,
      key: const ValueKey('mood-emotions'),
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 16),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        MoodPanelTop(
          icon: Icons.layers_outlined,
          title: s.moodEmotionsTitle,
          caption: s.moodEmotionsCaption,
          skin: skin,
        ),
        const SizedBox(height: 16),
        Expanded(
          child: active
              ? Column(children: [
                  // 行序就是后端这次返回的键序：换维度（curiosity → shyness）不用改页面。
                  // 只有空对象 / 老响应没有可渲染的键时，才回 MoodPalette.emotionOrder 这组兜底。
                  for (final key in view?.emotionKeys ?? MoodPalette.emotionOrder)
                    Expanded(
                      child: _EmotionBar(
                        s: s,
                        skin: skin,
                        emotionKey: key,
                        value: view?.emotions[key] ?? 0,
                      ),
                    ),
                ])
              : Center(
                  child: Text(
                    s.moodEmotionsEmpty,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11.5, height: 1.6, color: skin.mutedSoft),
                  ),
                ),
        ),
        const SizedBox(height: 10),
        Text(s.moodEmotionsNote, style: TextStyle(fontSize: 10, height: 1.5, color: skin.mutedSoft)),
      ]),
    );
  }
}

class _EmotionBar extends StatelessWidget {
  const _EmotionBar({required this.s, required this.skin, required this.emotionKey, required this.value});

  final AppStrings s;
  final MoodPanelSkin skin;
  final String emotionKey;
  final double value;

  @override
  Widget build(BuildContext context) {
    final color = MoodPalette.emotionColor(emotionKey);
    final v = value.clamp(0.0, 1.0).toDouble();
    return Row(children: [
      SizedBox(
        width: 70,
        child: Row(children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(
              color: color,
              shape: BoxShape.circle,
              boxShadow: [BoxShadow(color: color.withValues(alpha: 0.13), spreadRadius: 3)],
            ),
          ),
          const SizedBox(width: 8),
          Flexible(
            child: Text(
              s.moodEmotion(emotionKey),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: skin.ink),
            ),
          ),
        ]),
      ),
      const SizedBox(width: 12),
      Expanded(
        child: SizedBox(
          height: 6,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(99),
            child: Stack(fit: StackFit.expand, children: [
              ColoredBox(color: skin.track),
              TweenAnimationBuilder<double>(
                tween: Tween<double>(begin: 0, end: v),
                duration: const Duration(milliseconds: 550),
                curve: Curves.easeOutCubic,
                builder: (context, animated, _) => Align(
                  alignment: Alignment.centerLeft,
                  child: FractionallySizedBox(
                    widthFactor: animated.clamp(0.0, 1.0),
                    heightFactor: 1,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: color,
                        borderRadius: BorderRadius.circular(99),
                      ),
                    ),
                  ),
                ),
              ),
            ]),
          ),
        ),
      ),
      const SizedBox(width: 12),
      SizedBox(
        width: 40,
        child: Text(
          '${(v * 100).round()}%',
          textAlign: TextAlign.right,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w700,
            color: skin.muted,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ),
    ]);
  }
}

// ─────────────────────────────── 心境轨迹 ───────────────────────────────

class _TimelineCard extends StatefulWidget {
  const _TimelineCard({required this.s, required this.skin, required this.view, required this.active});

  final AppStrings s;
  final MoodPanelSkin skin;
  final _AffectSnapshot? view;
  final bool active;

  @override
  State<_TimelineCard> createState() => _TimelineCardState();
}

class _TimelineCardState extends State<_TimelineCard> {
  bool _week = false;

  @override
  Widget build(BuildContext context) {
    final s = widget.s;
    final skin = widget.skin;
    final now = clock.now();
    final history = widget.active ? (widget.view?.history ?? const <_HistoryPoint>[]) : const <_HistoryPoint>[];
    final points = <_ChartPoint>[];
    final labels = <String>[];
    final fractions = <double>[];
    double? delta;

    if (!_week) {
      final rawToday = <_HistoryPoint>[];
      for (final point in history) {
        final at = DateTime.fromMillisecondsSinceEpoch(point.atMs);
        if (at.year == now.year && at.month == now.month && at.day == now.day) rawToday.add(point);
      }
      // 同一分钟内的相邻评价合并成后一条：时间轴按真实跨度铺开时，
      // 52 秒的两拍会被压到 1–2 像素，连线看上去像一根竖着的"刺"（2026-11-02 现场）。
      // 合并保留**后一条**（最新状态），不会改变首尾与整体走势。
      rawToday.sort((a, b) => a.atMs.compareTo(b.atMs));
      final today = collapseNearbyHistory(rawToday, (point) => point.atMs);
      if (today.length >= 2) {
        final first = today.first.atMs;
        final last = today.last.atMs;
        final span = last - first;
        for (final point in today) {
          final x = span == 0 ? 0.5 : (point.atMs - first) / span;
          points.add(_ChartPoint(x.clamp(0.0, 1.0), point.valence));
        }
        // 采样点固定 5 个（首尾 + 中间三档），但点数少时必须把索引夹进 0..length-1 再去重：
        // 只有 2 个点时 `round(2*0.75)` 会给出 2（越界），整张卡会掉进 ErrorWidget。
        final rawIndexes = <int>{
          0,
          (today.length * 0.25).round(),
          (today.length * 0.5).round(),
          (today.length * 0.75).round(),
          today.length - 1,
        };
        final indexes = rawIndexes
            .map((index) => math.min(math.max(index, 0), today.length - 1))
            .toSet()
            .toList()
          ..sort();
        for (final index in indexes) {
          labels.add(_hourLabel(DateTime.fromMillisecondsSinceEpoch(today[index].atMs)));
          fractions.add(points[index].x);
        }
        delta = today.last.valence - today.first.valence;
      }
    } else {
      final start = DateTime(now.year, now.month, now.day).subtract(const Duration(days: 6));
      final dayValues = <double?>[];
      for (var i = 0; i < 7; i += 1) {
        final day = start.add(Duration(days: i));
        double? value;
        for (final point in history) {
          final at = DateTime.fromMillisecondsSinceEpoch(point.atMs);
          if (at.year == day.year && at.month == day.month && at.day == day.day) value = point.valence;
        }
        dayValues.add(value);
        labels.add(_weekday(s, day.weekday));
        fractions.add(i / 6);
      }
      final filled = <_ChartPoint>[];
      double? firstValue;
      for (var i = 0; i < 7; i += 1) {
        final value = dayValues[i];
        if (value == null) continue;
        firstValue ??= value;
        filled.add(_ChartPoint(i / 6, value));
        delta = value - firstValue;
      }
      if (filled.length >= 2) points.addAll(filled);
      if (filled.length < 2) delta = null;
    }

    final enough = points.length >= 2;
    // 没有评价时不给读数：hero 已经隐藏了 stat pill，这里显示破折号而不是默认的 0.2
    final current = widget.active ? widget.view?.valence : null;
    final flat = delta != null && delta.abs() < 0.005;
    final up = (delta ?? 0) >= 0;

    return moodPanelFrame(
      skin,
      key: const ValueKey('mood-timeline'),
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        MoodPanelTop(
          icon: Icons.show_chart_rounded,
          title: s.moodTimelineTitle,
          skin: skin,
          trailing: _RangeTabs(s: s, skin: skin, week: _week, onChanged: (week) => setState(() => _week = week)),
        ),
        const SizedBox(height: 6),
        Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
          Text(
            current == null ? s.dash : _signed(current),
            style: TextStyle(
              fontSize: 23,
              fontWeight: FontWeight.w700,
              color: skin.statValue,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 9),
          if (delta != null && !flat)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
              decoration: BoxDecoration(
                color: up ? skin.deltaUpBg : skin.deltaDownBg,
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(
                s.moodChartDelta(up, _signed(delta)),
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: up ? MoodPalette.chartDeltaUp : MoodPalette.chartDeltaDown,
                ),
              ),
            )
          else if (delta != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
              decoration: BoxDecoration(
                color: skin.chipBg,
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(s.moodChartFlat,
                  style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: skin.muted)),
            ),
          const SizedBox(width: 9),
          if (current != null)
            Flexible(
              child: Text(
                _week ? s.moodChartInfoWeek : s.moodChartInfoToday,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 10, color: skin.mutedSoft),
              ),
            ),
        ]),
        const SizedBox(height: 6),
        Expanded(
          child: enough
              ? CustomPaint(
                  key: const ValueKey('mood-chart'),
                  painter: _MoodChartPainter(
                    points: points,
                    line: MoodPalette.chartLine,
                    grid: skin.chartGrid,
                    dotFill: skin.card,
                  ),
                  size: Size.infinite,
                )
              : Center(
                  child: Text(
                    _week ? s.moodChartEmptyWeek : s.moodChartEmptyToday,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11.5, color: skin.mutedSoft),
                  ),
                ),
        ),
        const SizedBox(height: 2),
        SizedBox(
          height: 14,
          child: LayoutBuilder(builder: (context, constraints) {
            if (!enough || labels.isEmpty) return const SizedBox.shrink();
            final width = constraints.maxWidth;
            return Stack(clipBehavior: Clip.none, children: [
              for (var i = 0; i < labels.length; i++)
                Positioned(
                  left: (fractions[i] * width - 22).clamp(0.0, math.max(0.0, width - 44)),
                  width: 44,
                  top: 0,
                  child: Text(
                    labels[i],
                    textAlign: TextAlign.center,
                    maxLines: 1,
                    style: TextStyle(fontSize: 10, color: skin.mutedSoft),
                  ),
                ),
            ]);
          }),
        ),
      ]),
    );
  }
}

class _RangeTabs extends StatelessWidget {
  const _RangeTabs({required this.s, required this.skin, required this.week, required this.onChanged});

  final AppStrings s;
  final MoodPanelSkin skin;
  final bool week;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    final labels = [s.moodRangeToday, s.moodRangeWeek];
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: skin.tabBg,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: skin.edge),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 0; i < 2; i++)
          InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: () => onChanged(i == 1),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 140),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
              decoration: BoxDecoration(
                color: (i == 1) == week ? skin.card : Colors.transparent,
                borderRadius: BorderRadius.circular(6),
                boxShadow: (i == 1) == week ? skin.tabShadow : null,
              ),
              child: Text(
                labels[i],
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: (i == 1) == week ? FontWeight.w700 : FontWeight.w500,
                  color: (i == 1) == week ? skin.tabActive : skin.mutedSoft,
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

class _ChartPoint {
  const _ChartPoint(this.x, this.value);

  final double x;
  final double value;
}

/// 同一小段时间内的相邻评价合并成后一条（保留最新值）。
///
/// 时间轴按真实跨度铺开时，两拍只差几十秒会被压到 1–2 像素，连线看上去像一根
/// 竖着的"刺"（2026-11-02 用户截图）。这个函数只做合并，不改首尾与整体走势；
/// 抽成公开纯函数是为了让页面级用例能直接钉住"52 秒两拍 → 一条"。
@visibleForTesting
List<T> collapseNearbyHistory<T>(
  List<T> items,
  int Function(T) atMsOf, {
  int minGapMs = 120000,
}) {
  final out = <T>[];
  for (final item in items) {
    if (out.isNotEmpty && atMsOf(item) - atMsOf(out.last) < minGapMs) {
      out[out.length - 1] = item;
    } else {
      out.add(item);
    }
  }
  return out;
}

class _MoodChartPainter extends CustomPainter {
  _MoodChartPainter({required this.points, required this.line, required this.grid, required this.dotFill});

  final List<_ChartPoint> points;
  final Color line;
  final Color grid;
  final Color dotFill;

  @override
  void paint(Canvas canvas, Size size) {
    const top = 6.0;
    const bottom = 10.0;
    final height = size.height - top - bottom;
    if (height <= 0 || size.width <= 0) return;
    double yFor(double value) => top + (0.8 - value.clamp(-0.8, 0.8)) / 1.6 * height;

    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (final fraction in const [0.22, 0.5, 0.78]) {
      _dashedLine(canvas, Offset(0, top + height * fraction), Offset(size.width, top + height * fraction), gridPaint);
    }

    final offsets = <Offset>[
      for (final point in points) Offset(point.x * size.width, yFor(point.value)),
    ];
    if (offsets.length < 2) return;
    final path = _smoothPath(offsets);
    final area = Path.from(path)
      ..lineTo(offsets.last.dx, size.height)
      ..lineTo(offsets.first.dx, size.height)
      ..close();
    canvas.drawPath(
      area,
      Paint()
        ..shader = ui.Gradient.linear(
          Offset(0, top),
          Offset(0, size.height),
          [MoodPalette.chartAreaTop, MoodPalette.chartAreaBottom],
        ),
    );
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.5
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
    canvas.drawCircle(offsets.last, 4.8, Paint()..color = dotFill);
    canvas.drawCircle(
      offsets.last,
      4.8,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.6,
    );
  }

  Path _smoothPath(List<Offset> offsets) {
    final path = Path()..moveTo(offsets.first.dx, offsets.first.dy);
    for (var i = 0; i < offsets.length - 1; i += 1) {
      final a = offsets[math.max(0, i - 1)];
      final b = offsets[i];
      final c = offsets[i + 1];
      final e = offsets[math.min(offsets.length - 1, i + 2)];
      path.cubicTo(
        b.dx + (c.dx - a.dx) / 6,
        b.dy + (c.dy - a.dy) / 6,
        c.dx - (e.dx - b.dx) / 6,
        c.dy - (e.dy - b.dy) / 6,
        c.dx,
        c.dy,
      );
    }
    return path;
  }

  void _dashedLine(Canvas canvas, Offset from, Offset to, Paint paint) {
    const dash = 3.0;
    const gap = 6.0;
    var x = from.dx;
    while (x < to.dx) {
      final end = math.min(x + dash, to.dx);
      canvas.drawLine(Offset(x, from.dy), Offset(end, to.dy), paint);
      x += dash + gap;
    }
  }

  @override
  bool shouldRepaint(covariant _MoodChartPainter old) =>
      old.points != points || old.line != line || old.grid != grid || old.dotFill != dotFill;
}

// ─────────────────────────────── 最近的影响 ───────────────────────────────

class _FactorsCard extends StatelessWidget {
  const _FactorsCard({
    required this.s,
    required this.skin,
    required this.view,
    required this.active,
    required this.onOpen,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _AffectSnapshot? view;
  final bool active;
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    final current = view;
    final causes = active && current != null ? _causesOf(current) : const <_CauseView>[];
    return moodPanelFrame(
      skin,
      key: const ValueKey('mood-factors'),
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 14),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        MoodPanelTop(
          icon: Icons.chat_bubble_outline_rounded,
          title: s.moodFactorsTitle,
          caption: s.moodFactorsCaption,
          skin: skin,
        ),
        const SizedBox(height: 10),
        Expanded(
          child: causes.isEmpty
              ? Center(
                  child: Text(
                    s.moodFactorsEmpty,
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11.5, height: 1.6, color: skin.mutedSoft),
                  ),
                )
              : Column(children: [
                  for (final cause in causes.take(5)) Expanded(child: _FactorRow(s: s, skin: skin, cause: cause, onTap: onOpen)),
                ]),
        ),
      ]),
    );
  }
}

class _FactorRow extends StatefulWidget {
  const _FactorRow({required this.s, required this.skin, required this.cause, required this.onTap});

  final AppStrings s;
  final MoodPanelSkin skin;
  final _CauseView cause;
  final VoidCallback? onTap;

  @override
  State<_FactorRow> createState() => _FactorRowState();
}

class _FactorRowState extends State<_FactorRow> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final s = widget.s;
    final skin = widget.skin;
    final cause = widget.cause;
    final tone = _toneOf(cause.reasonCode);
    final at = DateTime.fromMillisecondsSinceEpoch(cause.evaluatedAtMs);
    // 不用 InkWell：它需要一层 Material，而 Material 会把环境 DefaultTextStyle 换回
    // 主题的正文样式（页面这一层继承的字体栈就断了）。这里只要一块底色变化，鼠标进出手感一样。
    return MouseRegion(
      cursor: widget.onTap == null ? MouseCursor.defer : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
          decoration: BoxDecoration(
            color: _hovered ? skin.hover : Colors.transparent,
            borderRadius: BorderRadius.circular(11),
          ),
          child: Row(children: [
            Container(
              width: 30,
              height: 30,
              decoration: BoxDecoration(color: tone.bg, borderRadius: BorderRadius.circular(10)),
              child: Icon(tone.icon, size: 15, color: tone.fg),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                Text(
                  s.affectReason(cause.reasonCode),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: skin.ink),
                ),
                const SizedBox(height: 3),
                Text(
                  s.moodFactorMeta(
                    '${_two(at.hour)}:${_two(at.minute)}',
                    s.moodSource(_sourceOf(cause.reasonCode)),
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 9.5, color: skin.mutedSoft),
                ),
              ]),
            ),
            const SizedBox(width: 8),
            Text(
              s.moodFactorEffect(s.moodEmotion(cause.dominantEmotion), _signed(cause.strength)),
              style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w700, color: tone.fg),
            ),
          ]),
        ),
      ),
    );
  }
}

class _FactorTone {
  const _FactorTone({required this.icon, required this.bg, required this.fg});

  final IconData icon;
  final Color bg;
  final Color fg;
}

_FactorTone _toneOf(String reason) => switch (reason) {
      'owner_success' || 'task_success' =>
        const _FactorTone(icon: Icons.check_rounded, bg: MoodPalette.toneGoldBg, fg: MoodPalette.toneGold),
      'new_discovery' =>
        const _FactorTone(icon: Icons.auto_awesome_outlined, bg: MoodPalette.toneGreenBg, fg: MoodPalette.toneGreen),
      'friendly_contact' =>
        const _FactorTone(icon: Icons.chat_bubble_outline_rounded, bg: MoodPalette.tonePurpleBg, fg: MoodPalette.tonePurple),
      'unfriendly_contact' =>
        const _FactorTone(icon: Icons.forum_outlined, bg: MoodPalette.toneRoseBg, fg: MoodPalette.toneRose),
      'task_failure' =>
        const _FactorTone(icon: Icons.report_gmailerrorred_rounded, bg: MoodPalette.toneGrayBg, fg: MoodPalette.toneGray),
      _ => const _FactorTone(icon: Icons.chat_bubble_outline_rounded, bg: MoodPalette.toneBlueBg, fg: MoodPalette.toneBlue),
    };

String _sourceOf(String reason) => switch (reason) {
      'task_success' || 'task_failure' => 'task',
      'new_discovery' => 'discovery',
      'general' => 'general',
      _ => 'chat',
    };

// ─────────────────────────────── 右侧详情浮层 ───────────────────────────────

Future<void> _showDetailSheet(BuildContext context, _AffectSnapshot view) {
  final s = IrmiaStrings.of(context);
  final skin = MoodPanelSkin.of(context);
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: s.moodSheetClose,
    barrierColor: MoodPalette.sheetMask,
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (dialogContext, _, __) => Align(
      alignment: Alignment.centerRight,
      child: SizedBox(
        width: 355,
        height: double.infinity,
        child: Material(
          color: skin.sheetBg,
          child: SafeArea(child: _DetailSheet(s: s, skin: skin, view: view)),
        ),
      ),
    ),
    transitionBuilder: (dialogContext, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
      return SlideTransition(
        position: Tween<Offset>(begin: const Offset(1, 0), end: Offset.zero).animate(curved),
        child: FadeTransition(opacity: animation, child: child),
      );
    },
  );
}

class _DetailSheet extends StatelessWidget {
  const _DetailSheet({required this.s, required this.skin, required this.view});

  final AppStrings s;
  final MoodPanelSkin skin;
  final _AffectSnapshot view;

  @override
  Widget build(BuildContext context) {
    final dominant = _dominantOf(view);
    final causes = _causesOf(view);
    final latest = causes.isEmpty ? null : causes.first;
    final renderLine = view.renderLine?.trim() ?? '';
    final stateTime = view.atMs == null ? s.moodSheetStateTimeMissing : _stateTimeLabel(s, view.atMs!);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 20),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
            child: Text(s.moodSheetTitle,
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: skin.title)),
          ),
          IconButton(
            tooltip: s.moodSheetClose,
            onPressed: () => Navigator.of(context).pop(),
            icon: const Icon(Icons.close_rounded, size: 19),
            color: skin.muted,
          ),
        ]),
        const SizedBox(height: 2),
        Text(s.moodSheetBlurb, style: TextStyle(fontSize: 11, height: 1.8, color: skin.mutedSoft)),
        const SizedBox(height: 14),
        Expanded(
          child: SingleChildScrollView(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              _DetailBlock(
                skin: skin,
                label: s.moodSheetMoodLabel,
                rows: [
                  _DetailRow(skin: skin, label: s.moodSheetValence, value: _signed(view.valence)),
                  _DetailRow(skin: skin, label: s.moodSheetArousal, value: view.arousal.toStringAsFixed(2)),
                  _DetailRow(skin: skin, label: s.moodSheetChangeMode, value: s.moodSheetHalfLife),
                ],
              ),
              _DetailBlock(
                skin: skin,
                label: s.moodSheetPrimaryLabel,
                rows: [
                  _DetailRow(
                    skin: skin,
                    label: dominant == null ? s.moodEmotionsEmpty : s.moodEmotion(dominant),
                    value: dominant == null ? s.dash : (view.emotions[dominant] ?? 0).toStringAsFixed(2),
                  ),
                  _DetailRow(
                    skin: skin,
                    label: s.moodSheetRecentCause,
                    value: latest == null ? s.moodNoRecentCause : s.affectReason(latest.reasonCode),
                    alignEnd: true,
                  ),
                  _DetailRow(skin: skin, label: s.moodSheetSnapshot, value: s.moodSheetSnapshotValue),
                ],
              ),
              // 只读核对区：请求里真实注入的那行情绪 + 投影状态时刻（人不用翻日志就能对账）
              _DetailBlock(
                skin: skin,
                label: s.moodSheetRequestLabel,
                rows: [
                  _DetailRow(
                    skin: skin,
                    label: s.moodSheetRenderLine,
                    value: renderLine.isEmpty ? s.moodSheetRenderLineMissing : renderLine,
                  ),
                  _DetailRow(
                    skin: skin,
                    label: s.moodSheetStateTime,
                    value: stateTime,
                    alignEnd: true,
                  ),
                ],
              ),
              Container(
                width: double.infinity,
                margin: const EdgeInsets.only(top: 14),
                padding: const EdgeInsets.all(15),
                decoration: BoxDecoration(
                  color: skin.soft,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(s.moodSheetPrincipleTitle,
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: skin.primary)),
                  Container(height: 1, color: skin.edge, margin: const EdgeInsets.symmetric(vertical: 8)),
                  Text(s.moodSheetPrincipleBody,
                      style: TextStyle(fontSize: 11, height: 1.8, color: skin.muted)),
                ]),
              ),
            ]),
          ),
        ),
      ]),
    );
  }
}

class _DetailBlock extends StatelessWidget {
  const _DetailBlock({required this.skin, required this.label, required this.rows});

  final MoodPanelSkin skin;
  final String label;
  final List<Widget> rows;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(vertical: 16),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: skin.edge))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(label,
            style: TextStyle(fontSize: 10, letterSpacing: 0.5, color: skin.mutedSoft)),
        const SizedBox(height: 6),
        ...rows,
      ]),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.skin, required this.label, required this.value, this.alignEnd = false});

  final MoodPanelSkin skin;
  final String label;
  final String value;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Text(label, style: TextStyle(fontSize: 12, color: skin.muted)),
        ),
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            value,
            textAlign: alignEnd ? TextAlign.right : TextAlign.left,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: skin.primary,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ),
      ]),
    );
  }
}

// ─────────────────────────────── 亲密（第三个 tab）──────────────────────────────
//
// 2026-11-05 按用户的「整体向情绪面板靠拢」重做视觉：
//   · 一切卡片走情绪页的 `_panelFrame` / `MoodPanelTop`（同一 surface、圆角、描边、发丝影）；
//   · 页面底色与页头跟情绪页完全一致，不再有自己的玫瑰/夜紫背景、光晕、细环；
//   · 字体统一为应用界面字体，不用 Georgia 衬线、英文 kicker、52px 大字；
//   · 四读数保留 2×2，但改成情绪页那种低饱和数据色（青/玫/金/紫），不再整页玫红；
//   · 数据语义不变：labels / level / estrus / afterglow / phase / line / causes / history
//     全部原样读 `/api/intimacy`，关闭态仍然只剩说明 + 开关 + 上限。

/// 读取失败的四类：老后端没有端点 / 认证 / JSON 形状 / 其他网络错误。
enum _IntimacyFailure { none, load, unsupported, auth, invalid }

/// 四格读数的固定顺序：亲密 / 情欲 / 满足 / 克制
const List<String> _intimacyKeys = <String>[
  'intimacy',
  'desire',
  'satisfaction',
  'restraint',
];

/// 阶段词的本地化：四个阶段由后端状态机给定，页面只取名字（不写中文）。
String _phaseLabel(AppStrings s, String phase) => switch (phase) {
  'warm' => s.intimacyPhaseWarm,
  'tense' => s.intimacyPhaseTense,
  'estrus' => s.intimacyPhaseEstrus,
  _ => s.intimacyPhaseCalm,
};

/// 阶段副句：与情绪页的说明句同一档字号/行高，不再用英文衬线 kicker。
String _phaseSub(AppStrings s, String phase) => switch (phase) {
  'estrus' => s.intimacyPhaseEstrusSub,
  'warm' => s.intimacyPhaseWarmSub,
  'tense' => s.intimacyPhaseTenseSub,
  _ => s.intimacyPhaseCalmSub,
};

/// 阶段 badge 的色相：沿用情绪页的低饱和数据色。
Color _phaseTone(String phase) => switch (phase) {
  'estrus' => MoodPalette.toneRose,
  'tense' => MoodPalette.irritation,
  'warm' => MoodPalette.joy,
  _ => MoodPalette.primary,
};

/// 四读数的数据色：低饱和、只用于轨道/数值/图例，不当作页面主题。
Color _intimacyColor(String key) => switch (key) {
  'intimacy' => MoodPalette.warmth,
  'desire' => MoodPalette.toneRose,
  'satisfaction' => MoodPalette.joy,
  'restraint' => MoodPalette.shyness,
  _ => MoodPalette.primary,
};

/// 宽屏左侧 phase 卡：标准 surface 卡 + `MoodPanelTop`，不再有渐变/圆环/光斑。
class _IntimacyPhaseCard extends StatelessWidget {
  const _IntimacyPhaseCard({
    required this.s,
    required this.skin,
    required this.view,
    required this.onDetails,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;
  final VoidCallback onDetails;

  @override
  Widget build(BuildContext context) {
    final phase = view.estrus ? 'estrus' : view.phase;
    final label = _phaseLabel(s, phase);
    final updated = view.updatedAt == null
        ? s.intimacyNoUpdated
        : _agoLabel(s, view.updatedAt!);
    final line = view.line?.trim();
    final badgeColor = _phaseTone(phase);
    return moodPanelFrame(
      skin,
      key: const ValueKey('intimacy-phase-card'),
      padding: const EdgeInsets.fromLTRB(22, 18, 22, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          MoodPanelTop(
            icon: Icons.spa_outlined,
            title: s.intimacyPhaseCardTitle,
            skin: skin,
            trailing: IconButton(
              key: const ValueKey('intimacy-details'),
              tooltip: s.intimacyDetailsTooltip,
              onPressed: onDetails,
              icon: const Icon(Icons.info_outline_rounded, size: 17),
              color: skin.mutedSoft,
              visualDensity: VisualDensity.compact,
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(minWidth: 30, minHeight: 30),
            ),
          ),
          const Spacer(flex: 2),
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _IntimacyPhaseBadge(
                key: ValueKey(
                  view.estrus ? 'intimacy-estrus' : 'intimacy-phase',
                ),
                label: view.estrus ? s.intimacyEstrusBadge : label,
                color: badgeColor,
              ),
              if (view.afterglow)
                _IntimacyPhaseBadge(
                  key: const ValueKey('intimacy-afterglow'),
                  label: s.intimacyAfterglow,
                  color: MoodPalette.toneGold,
                ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            label,
            key: const ValueKey('intimacy-phase-title'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 28,
              height: 1.25,
              fontWeight: FontWeight.w600,
              color: skin.heading,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            _phaseSub(s, phase),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11.5, height: 1.8, color: skin.muted),
          ),
          if (line != null && line.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
              decoration: BoxDecoration(
                color: skin.chipBg,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: skin.chipBorder),
              ),
              child: Text(
                line,
                key: const ValueKey('intimacy-line-text'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 11.5, height: 1.8, color: skin.muted),
              ),
            ),
          ],
          const Spacer(flex: 3),
          Container(
            padding: const EdgeInsets.only(top: 12),
            decoration: BoxDecoration(
              border: Border(top: BorderSide(color: skin.edge)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: _IntimacyMeta(
                    label: s.intimacyLevelMeta,
                    value: s.intimacyLevel(view.level),
                    skin: skin,
                  ),
                ),
                const SizedBox(width: 12),
                _IntimacyMeta(
                  label: s.intimacyUpdatedMeta,
                  value: updated,
                  skin: skin,
                  alignEnd: true,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _IntimacyPhaseBadge extends StatelessWidget {
  const _IntimacyPhaseBadge({
    super.key,
    required this.label,
    required this.color,
  });

  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: color.withValues(alpha: 0.24)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w600,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}

class _IntimacyMeta extends StatelessWidget {
  const _IntimacyMeta({
    required this.label,
    required this.value,
    required this.skin,
    this.alignEnd = false,
  });

  final String label;
  final String value;
  final MoodPanelSkin skin;
  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: alignEnd ? TextAlign.right : TextAlign.left,
          style: TextStyle(fontSize: 10, color: skin.mutedSoft),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          textAlign: alignEnd ? TextAlign.right : TextAlign.left,
          style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: skin.ink),
        ),
      ],
    );
  }
}

/// 宽屏右侧四读数：一张标准卡，里面 2×2 个浅色 tile；仍是「四项读数」结构。
class _IntimacyReadingsPanel extends StatelessWidget {
  const _IntimacyReadingsPanel({
    required this.s,
    required this.skin,
    required this.view,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;

  @override
  Widget build(BuildContext context) {
    return moodPanelFrame(
      skin,
      key: const ValueKey('intimacy-readings'),
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          MoodPanelTop(
            icon: Icons.tune_rounded,
            title: s.intimacyReadingsTitle,
            caption: s.intimacyReadingsCaption,
            skin: skin,
          ),
          const SizedBox(height: 14),
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final single = constraints.maxWidth < 300;
                final cards = [
                  for (var i = 0; i < _intimacyKeys.length; i += 1)
                    _IntimacyMetricTile(
                      s: s,
                      skin: skin,
                      metric: _intimacyKeys[i],
                      value: view.valueOf(_intimacyKeys[i]),
                      label: view.labelOf(_intimacyKeys[i]),
                    ),
                ];
                if (single) {
                  return Column(
                    children: [
                      for (var i = 0; i < cards.length; i += 1) ...[
                        if (i > 0) const SizedBox(height: 10),
                        Expanded(child: cards[i]),
                      ],
                    ],
                  );
                }
                return Column(
                  children: [
                    Expanded(
                      child: Row(
                        children: [
                          Expanded(child: cards[0]),
                          const SizedBox(width: 10),
                          Expanded(child: cards[1]),
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                    Expanded(
                      child: Row(
                        children: [
                          Expanded(child: cards[2]),
                          const SizedBox(width: 10),
                          Expanded(child: cards[3]),
                        ],
                      ),
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _IntimacyMetricTile extends StatelessWidget {
  const _IntimacyMetricTile({
    required this.s,
    required this.skin,
    required this.metric,
    required this.value,
    required this.label,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String metric;
  final double value;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final color = _intimacyColor(metric);
    final bounded = value.clamp(0.0, 100.0);
    return Container(
      key: ValueKey('intimacy-metric-$metric'),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: skin.chipBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: skin.chipBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  boxShadow: [
                    BoxShadow(color: color.withValues(alpha: 0.13), spreadRadius: 3),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  s.intimacyMetric(metric),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: skin.ink,
                  ),
                ),
              ),
              if (label != null) ...[
                const SizedBox(width: 6),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(99),
                    border: Border.all(color: color.withValues(alpha: 0.20)),
                  ),
                  child: Text(
                    label!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w600,
                      color: color,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const Spacer(),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(
                bounded.toStringAsFixed(1),
                style: TextStyle(
                  fontSize: 24,
                  height: 1,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.4,
                  color: color,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
              const SizedBox(width: 4),
              Text(
                '/ 100',
                style: TextStyle(fontSize: 9.5, color: skin.mutedSoft),
              ),
            ],
          ),
          const SizedBox(height: 8),
          _IntimacyTrack(
            value: bounded / 100,
            color: color,
            track: skin.track,
          ),
        ],
      ),
    );
  }
}

class _IntimacyTrack extends StatelessWidget {
  const _IntimacyTrack({
    required this.value,
    required this.color,
    required this.track,
  });

  final double value;
  final Color color;
  final Color track;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 5,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(99),
        child: Stack(
          fit: StackFit.expand,
          children: [
            ColoredBox(color: track),
            TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: 0, end: value.clamp(0.0, 1.0)),
              duration: const Duration(milliseconds: 550),
              curve: Curves.easeOutCubic,
              builder: (context, animated, _) => Align(
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: animated.clamp(0.0, 1.0),
                  heightFactor: 1,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: color,
                      borderRadius: BorderRadius.circular(99),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 最近变化：情绪页「最近的影响」同款卡头 + 30px 图标行；强度保留为行尾小字。
class _IntimacyCausesPanel extends StatelessWidget {
  const _IntimacyCausesPanel({
    required this.s,
    required this.skin,
    required this.view,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;

  @override
  Widget build(BuildContext context) {
    final causes = view.causes.take(5).toList();
    return moodPanelFrame(
      skin,
      key: const ValueKey('intimacy-causes'),
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          MoodPanelTop(
            icon: Icons.bolt_outlined,
            title: s.intimacyCausesTitle,
            caption: s.intimacyCausesCaption,
            skin: skin,
          ),
          const SizedBox(height: 10),
          Expanded(
            child: causes.isEmpty
                ? Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          s.intimacyCausesEmpty,
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 11.5, height: 1.6, color: skin.mutedSoft),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          s.intimacyCausesEmptyHint,
                          textAlign: TextAlign.center,
                          style: TextStyle(fontSize: 10, height: 1.6, color: skin.mutedSoft),
                        ),
                      ],
                    ),
                  )
                : Column(
                    children: [
                      for (final cause in causes)
                        Expanded(
                          child: _IntimacyCauseRow(s: s, skin: skin, cause: cause),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}

class _IntimacyCauseRow extends StatelessWidget {
  const _IntimacyCauseRow({
    required this.s,
    required this.skin,
    required this.cause,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacyCause cause;

  @override
  Widget build(BuildContext context) {
    final at = DateTime.fromMillisecondsSinceEpoch(cause.atMs);
    final strength = cause.strength.clamp(0.0, 100.0);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            decoration: BoxDecoration(
              color: MoodPalette.toneRoseBg,
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(
              Icons.bolt_rounded,
              size: 15,
              color: MoodPalette.toneRose,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Text(
                  s.intimacyCauseLabel(cause.label),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w600,
                    color: skin.ink,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  _agoLabel(s, at),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 9.5, color: skin.mutedSoft),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            s.intimacyStrength(strength.round()),
            maxLines: 1,
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w700,
              color: MoodPalette.toneRose,
            ),
          ),
        ],
      ),
    );
  }
}

/// 情绪潮汐：情绪页图表规范（虚线网格、2px 曲线、末端圆点、发丝图例）。
class _IntimacyHistoryPanel extends StatelessWidget {
  const _IntimacyHistoryPanel({
    required this.s,
    required this.skin,
    required this.view,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;

  @override
  Widget build(BuildContext context) {
    final enough = view.history.length >= 2;
    return moodPanelFrame(
      skin,
      key: const ValueKey('intimacy-history'),
      padding: const EdgeInsets.fromLTRB(22, 20, 22, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          MoodPanelTop(
            icon: Icons.show_chart_rounded,
            title: s.intimacyHistoryTitle,
            caption: s.intimacyHistoryCount(view.history.length),
            skin: skin,
          ),
          const SizedBox(height: 8),
          Expanded(
            child: enough
                ? CustomPaint(
                    key: const ValueKey('intimacy-chart'),
                    painter: _IntimacyChartPainter(
                      series: _intimacySeriesOf(view.history),
                      grid: skin.chartGrid,
                      axis: skin.mutedSoft,
                      dotFill: skin.card,
                    ),
                    size: Size.infinite,
                  )
                : Center(
                    child: Text(
                      s.intimacyHistoryEmpty,
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 11.5, height: 1.6, color: skin.mutedSoft),
                    ),
                  ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 14,
            runSpacing: 5,
            children: [
              for (final key in _intimacyKeys)
                _IntimacyLegendItem(
                  color: _intimacyColor(key),
                  label: s.intimacyMetric(key),
                  skin: skin,
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            s.intimacyHistoryNote,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 9, height: 1.5, color: skin.mutedSoft),
          ),
        ],
      ),
    );
  }
}

class _IntimacyLegendItem extends StatelessWidget {
  const _IntimacyLegendItem({
    required this.color,
    required this.label,
    required this.skin,
  });

  final Color color;
  final String label;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 13,
          height: 2,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(3),
          ),
        ),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(fontSize: 9, color: skin.muted)),
      ],
    );
  }
}

class _IntimacySeries {
  const _IntimacySeries(this.color, this.points);

  final Color color;
  final List<_ChartPoint> points;
}

List<_IntimacySeries> _intimacySeriesOf(List<_IntimacyPoint> history) {
  if (history.length < 2) return const <_IntimacySeries>[];
  final first = history.first.atMs;
  final span = history.last.atMs - first;
  return <_IntimacySeries>[
    for (final key in _intimacyKeys)
      _IntimacySeries(
        _intimacyColor(key),
        <_ChartPoint>[
          for (var i = 0; i < history.length; i += 1)
            _ChartPoint(
              span == 0
                  ? i / (history.length - 1)
                  : ((history[i].atMs - first) / span).clamp(0.0, 1.0),
              (history[i].valueOf(key) / 100).clamp(0.0, 1.0),
            ),
        ],
      ),
  ];
}

class _IntimacyChartPainter extends CustomPainter {
  _IntimacyChartPainter({
    required this.series,
    required this.grid,
    required this.axis,
    required this.dotFill,
  });

  final List<_IntimacySeries> series;
  final Color grid;
  final Color axis;
  final Color dotFill;

  @override
  void paint(Canvas canvas, Size size) {
    const left = 27.0;
    const right = 8.0;
    const top = 8.0;
    const bottom = 17.0;
    final width = size.width - left - right;
    final height = size.height - top - bottom;
    if (width <= 0 || height <= 0) return;

    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (final value in const [0, 25, 50, 75, 100]) {
      final y = top + (100 - value) / 100 * height;
      _dash(canvas, Offset(left, y), Offset(size.width - right, y), gridPaint);
      final label = TextPainter(
        text: TextSpan(
          text: '$value',
          style: TextStyle(
            fontSize: 9,
            color: axis,
            fontFamily: IrmiaTheme.windowsUiFont,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      label.paint(
        canvas,
        Offset(0, (y - label.height / 2).clamp(0.0, size.height - label.height)),
      );
    }

    for (final one in series) {
      if (one.points.length < 2) continue;
      final offsets = <Offset>[
        for (final point in one.points)
          Offset(
            left + point.x.clamp(0.0, 1.0) * width,
            top + (1 - point.value.clamp(0.0, 1.0)) * height,
          ),
      ];
      final path = _smoothPath(offsets);
      canvas.drawPath(
        path,
        Paint()
          ..color = one.color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2
          ..strokeCap = StrokeCap.round
          ..strokeJoin = StrokeJoin.round,
      );
      final last = offsets.last;
      canvas.drawCircle(last, 4, Paint()..color = dotFill);
      canvas.drawCircle(
        last,
        4,
        Paint()
          ..color = one.color
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2,
      );
    }
  }

  void _dash(Canvas canvas, Offset from, Offset to, Paint paint) {
    const dash = 3.0;
    const gap = 5.0;
    final total = (to - from).distance;
    if (total <= 0) return;
    final direction = (to - from) / total;
    var distance = 0.0;
    while (distance < total) {
      final end = math.min(distance + dash, total);
      canvas.drawLine(from + direction * distance, from + direction * end, paint);
      distance = end + gap;
    }
  }

  Path _smoothPath(List<Offset> offsets) {
    final path = Path()..moveTo(offsets.first.dx, offsets.first.dy);
    for (var i = 0; i < offsets.length - 1; i += 1) {
      final a = offsets[math.max(0, i - 1)];
      final b = offsets[i];
      final c = offsets[i + 1];
      final e = offsets[math.min(offsets.length - 1, i + 2)];
      path.cubicTo(
        b.dx + (c.dx - a.dx) / 6,
        b.dy + (c.dy - a.dy) / 6,
        c.dx - (e.dx - b.dx) / 6,
        c.dy - (e.dy - b.dy) / 6,
        c.dx,
        c.dy,
      );
    }
    return path;
  }

  @override
  bool shouldRepaint(covariant _IntimacyChartPainter old) =>
      old.series != series ||
      old.grid != grid ||
      old.axis != axis ||
      old.dotFill != dotFill;
}

class _IntimacyFooter extends StatelessWidget {
  const _IntimacyFooter({required this.s, required this.skin});

  final AppStrings s;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Row(
        children: [
          Icon(Icons.lock_outline_rounded, size: 12, color: skin.mutedSoft),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              s.intimacyFooterPrivate,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 9, letterSpacing: 0.4, color: skin.mutedSoft),
            ),
          ),
          const SizedBox(width: 12),
          Text(
            s.intimacyFooterSync,
            maxLines: 1,
            style: TextStyle(fontSize: 9, letterSpacing: 0.4, color: skin.mutedSoft),
          ),
        ],
      ),
    );
  }
}

/// 关闭态：标准 surface 卡 + 应用按钮/开关；只显示说明 + 开关 + 上限。
class _IntimacyClosedCard extends StatelessWidget {
  const _IntimacyClosedCard({
    required this.s,
    required this.skin,
    required this.view,
    required this.saving,
    required this.onToggle,
    required this.onLevel,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;
  final bool saving;
  final ValueChanged<bool> onToggle;
  final ValueChanged<String> onLevel;

  @override
  Widget build(BuildContext context) {
    final pending = view.configured != view.enabled;
    return moodPanelFrame(
      skin,
      key: const ValueKey('intimacy-closed'),
      padding: const EdgeInsets.fromLTRB(26, 24, 26, 22),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final copy = Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              MoodPanelTop(
                icon: Icons.lock_outline_rounded,
                title: s.intimacySystem,
                skin: skin,
              ),
              const SizedBox(height: 14),
              Text(
                s.intimacyClosedTitle,
                style: TextStyle(
                  fontSize: 20,
                  height: 1.35,
                  fontWeight: FontWeight.w600,
                  color: skin.heading,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                s.intimacyClosedBody,
                style: TextStyle(fontSize: 11.5, height: 1.9, color: skin.muted),
              ),
            ],
          );
          final controls = Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          s.intimacyEnabledLabel,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: skin.ink,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          s.intimacyEnabledNote,
                          style: TextStyle(
                            fontSize: 9.5,
                            height: 1.6,
                            color: skin.mutedSoft,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  SizedBox(
                    width: 46,
                    height: 28,
                    child: FittedBox(
                      fit: BoxFit.contain,
                      child: Switch(
                        key: const ValueKey('intimacy-switch'),
                        value: view.enabled,
                        onChanged: saving ? null : onToggle,
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 18),
              Text(
                s.intimacyLevelLabel,
                style: TextStyle(fontSize: 10, color: skin.mutedSoft),
              ),
              const SizedBox(height: 6),
              _IntimacyLevelPicker(
                s: s,
                skin: skin,
                level: view.maxLevel,
                keyPrefix: 'intimacy-level',
                disabled: saving,
                onPick: onLevel,
              ),
              const SizedBox(height: 7),
              Text(
                s.intimacyMaxLevelNote,
                style: TextStyle(fontSize: 9.5, height: 1.5, color: skin.mutedSoft),
              ),
              if (pending) ...[
                const SizedBox(height: 12),
                _IntimacyPendingNote(text: s.intimacyPending, skin: skin),
              ],
              const SizedBox(height: 14),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.visibility_off_outlined, size: 13, color: skin.mutedSoft),
                  const SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      s.intimacyOffHint,
                      key: const ValueKey('intimacy-off'),
                      style: TextStyle(fontSize: 10, height: 1.6, color: skin.muted),
                    ),
                  ),
                ],
              ),
            ],
          );
          if (constraints.maxWidth >= 620) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: copy),
                const SizedBox(width: 30),
                SizedBox(width: 300, child: controls),
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              copy,
              const SizedBox(height: 22),
              controls,
            ],
          );
        },
      ),
    );
  }
}

class _IntimacyPendingNote extends StatelessWidget {
  const _IntimacyPendingNote({required this.text, required this.skin});

  final String text;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: skin.chipBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: skin.chipBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline_rounded, size: 13, color: IrmiaTheme.warn),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              style: const TextStyle(fontSize: 9.5, height: 1.5, color: IrmiaTheme.warn),
            ),
          ),
        ],
      ),
    );
  }
}

/// 上限三选一：含蓄 / 明显 / 强烈。外观与情绪页 tab 选中态同一套。
class _IntimacyLevelPicker extends StatelessWidget {
  const _IntimacyLevelPicker({
    required this.s,
    required this.skin,
    required this.level,
    required this.keyPrefix,
    required this.onPick,
    this.disabled = false,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String level;
  final String keyPrefix;
  final ValueChanged<String> onPick;
  final bool disabled;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: ValueKey(keyPrefix),
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: skin.tabBg,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: skin.edge),
      ),
      child: Row(
        children: [
          for (final key in _IntimacySnapshot.levels)
            Expanded(
              child: InkWell(
                key: ValueKey('$keyPrefix-$key'),
                borderRadius: BorderRadius.circular(6),
                onTap: disabled ? null : () => onPick(key),
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 140),
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  decoration: BoxDecoration(
                    color: key == level ? skin.card : Colors.transparent,
                    borderRadius: BorderRadius.circular(6),
                    boxShadow: key == level ? skin.tabShadow : null,
                  ),
                  child: Center(
                    child: Text(
                      s.intimacyLevel(key),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        fontWeight: key == level ? FontWeight.w700 : FontWeight.w500,
                        color: key == level ? skin.tabActive : skin.mutedSoft,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _IntimacySettingsDialog extends StatefulWidget {
  const _IntimacySettingsDialog({
    required this.s,
    required this.skin,
    required this.view,
    required this.onSave,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;
  final Future<bool> Function(bool enabled, String level) onSave;

  @override
  State<_IntimacySettingsDialog> createState() => _IntimacySettingsDialogState();
}

class _IntimacySettingsDialogState extends State<_IntimacySettingsDialog> {
  late bool _enabled;
  late String _level;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _enabled = widget.view.enabled;
    _level = widget.view.maxLevel;
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() => _saving = true);
    final ok = await widget.onSave(_enabled, _level);
    if (!mounted) return;
    if (ok) {
      Navigator.of(context).pop();
    } else {
      setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.s;
    final skin = widget.skin;
    final pending = widget.view.configured != widget.view.enabled;
    final maxHeight = math.max(320.0, MediaQuery.sizeOf(context).height - 60);
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      insetPadding: const EdgeInsets.all(20),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 460, maxHeight: maxHeight),
        child: Container(
          key: const ValueKey('intimacy-settings'),
          padding: const EdgeInsets.fromLTRB(22, 20, 22, 18),
          decoration: BoxDecoration(
            color: skin.card,
            borderRadius: BorderRadius.circular(MoodPalette.radius),
            border: Border.all(color: skin.edge),
            boxShadow: skin.shadow,
          ),
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.intimacySettingsTitle,
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: skin.title,
                        ),
                      ),
                    ),
                    IconButton(
                      key: const ValueKey('intimacy-settings-close'),
                      tooltip: s.moodSheetClose,
                      onPressed: _saving ? null : () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close_rounded, size: 18),
                      color: skin.muted,
                    ),
                  ],
                ),
                _SettingsDivider(skin: skin),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              s.intimacyEnabledLabel,
                              style: TextStyle(
                                fontSize: 11.5,
                                fontWeight: FontWeight.w600,
                                color: skin.ink,
                              ),
                            ),
                            const SizedBox(height: 5),
                            Text(
                              s.intimacyEnabledNote,
                              style: TextStyle(fontSize: 9.5, height: 1.6, color: skin.mutedSoft),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Switch(
                        key: const ValueKey('intimacy-settings-switch'),
                        value: _enabled,
                        onChanged: _saving
                            ? null
                            : (value) => setState(() => _enabled = value),
                      ),
                    ],
                  ),
                ),
                _SettingsDivider(skin: skin),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        s.intimacyLevelLabel,
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: skin.ink,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        s.intimacyMaxLevelNote,
                        style: TextStyle(fontSize: 9.5, height: 1.6, color: skin.mutedSoft),
                      ),
                      const SizedBox(height: 10),
                      _IntimacyLevelPicker(
                        s: s,
                        skin: skin,
                        level: _level,
                        keyPrefix: 'intimacy-settings-level',
                        disabled: _saving,
                        onPick: (value) => setState(() => _level = value),
                      ),
                    ],
                  ),
                ),
                _SettingsDivider(skin: skin),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              s.intimacyPrivateScope,
                              style: TextStyle(
                                fontSize: 11.5,
                                fontWeight: FontWeight.w600,
                                color: skin.ink,
                              ),
                            ),
                            const SizedBox(height: 5),
                            Text(
                              s.intimacyPrivateScopeNote,
                              style: TextStyle(fontSize: 9.5, height: 1.6, color: skin.mutedSoft),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(width: 12),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: skin.chipBg,
                          borderRadius: BorderRadius.circular(99),
                          border: Border.all(color: skin.chipBorder),
                        ),
                        child: Text(
                          s.intimacyPrivateOnlyPill,
                          style: TextStyle(fontSize: 9.5, color: skin.muted),
                        ),
                      ),
                    ],
                  ),
                ),
                if (pending) ...[
                  const SizedBox(height: 2),
                  _IntimacyPendingNote(text: s.intimacyPending, skin: skin),
                ],
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      key: const ValueKey('intimacy-settings-cancel'),
                      onPressed: _saving ? null : () => Navigator.of(context).pop(),
                      child: Text(s.cancel),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      key: const ValueKey('intimacy-settings-save'),
                      onPressed: _saving ? null : _save,
                      child: _saving
                          ? const SizedBox(
                              width: 13,
                              height: 13,
                              child: CircularProgressIndicator(strokeWidth: 1.8),
                            )
                          : Text(s.intimacySaveSettings),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SettingsDivider extends StatelessWidget {
  const _SettingsDivider({required this.skin});

  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Container(height: 1, color: skin.edge);
  }
}

class _IntimacyDetailsSheet extends StatelessWidget {
  const _IntimacyDetailsSheet({
    required this.s,
    required this.skin,
    required this.view,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final _IntimacySnapshot view;

  @override
  Widget build(BuildContext context) {
    final line = view.line?.trim();
    final renderLine = view.renderLine?.trim();
    return Padding(
      key: const ValueKey('intimacy-sheet'),
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  s.intimacySheetTitle,
                  style: TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w700,
                    color: skin.title,
                  ),
                ),
              ),
              IconButton(
                key: const ValueKey('intimacy-details-close'),
                tooltip: s.moodSheetClose,
                onPressed: () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close_rounded, size: 19),
                color: skin.muted,
              ),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            s.intimacySheetBlurb,
            style: TextStyle(fontSize: 11, height: 1.8, color: skin.mutedSoft),
          ),
          const SizedBox(height: 14),
          Expanded(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _DetailBlock(
                    skin: skin,
                    label: s.intimacyReadingsTitle,
                    rows: [
                      for (final key in _intimacyKeys)
                        _DetailRow(
                          skin: skin,
                          label: s.intimacyMetric(key),
                          value:
                              '${view.valueOf(key).toStringAsFixed(1)}'
                              '${view.labelOf(key) == null ? '' : ' · ${view.labelOf(key)}'}',
                        ),
                      _DetailRow(
                        skin: skin,
                        label: s.intimacyLevelLabel,
                        value: s.intimacyLevel(view.maxLevel),
                      ),
                      _DetailRow(
                        skin: skin,
                        label: s.intimacyLevelMeta,
                        value: s.intimacyLevel(view.level),
                      ),
                      _DetailRow(
                        skin: skin,
                        label: s.intimacyCurrentPhase,
                        value: _phaseLabel(s, view.estrus ? 'estrus' : view.phase),
                      ),
                      if (view.afterglow)
                        _DetailRow(
                          skin: skin,
                          label: s.intimacyAfterglow,
                          value: s.intimacyAfterglow,
                        ),
                      _DetailRow(
                        skin: skin,
                        label: s.moodSheetStateTime,
                        value: _stateTimeLabel(s, view.atMs),
                        alignEnd: true,
                      ),
                    ],
                  ),
                  _DetailBlock(
                    skin: skin,
                    label: s.intimacyLineLabel,
                    rows: [
                      Text(
                        line == null || line.isEmpty ? s.intimacyLineEmpty : line,
                        key: const ValueKey('intimacy-line-text'),
                        style: TextStyle(fontSize: 12, height: 1.7, color: skin.ink),
                      ),
                    ],
                  ),
                  _DetailBlock(
                    skin: skin,
                    label: s.intimacyRenderLineLabel,
                    rows: [
                      Text(
                        renderLine == null || renderLine.isEmpty
                            ? s.intimacyRenderLineMissing
                            : renderLine,
                        style: TextStyle(fontSize: 11, height: 1.7, color: skin.muted),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 首次加载的骨架：与情绪页同一种 surface 块，不摆任何 0。
class _IntimacySkeleton extends StatelessWidget {
  const _IntimacySkeleton({required this.s, required this.skin});

  final AppStrings s;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return SizedBox.expand(
      key: const ValueKey('intimacy-skeleton'),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= 1000 && constraints.maxHeight >= 720;
          final hero = Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Align(
              alignment: Alignment.centerRight,
              child: Text(
                s.intimacySyncNote,
                style: TextStyle(fontSize: 9.5, color: skin.mutedSoft),
              ),
            ),
          );
          if (wide) {
            return Padding(
              padding: const EdgeInsets.fromLTRB(26, 14, 26, 14),
              child: Column(
                children: [
                  hero,
                  const SizedBox(height: 10),
                  Expanded(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 88, child: _skeletonBlock(radius: 19)),
                        const SizedBox(width: 16),
                        Expanded(
                          flex: 112,
                          child: _skeletonBlock(radius: 19),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 250,
                    child: Row(
                      children: [
                        Expanded(flex: 78, child: _skeletonBlock(radius: 19)),
                        const SizedBox(width: 16),
                        Expanded(flex: 122, child: _skeletonBlock(radius: 19)),
                      ],
                    ),
                  ),
                  const SizedBox(height: 10),
                  _skeletonLine(width: 240),
                ],
              ),
            );
          }
          return SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(26, 14, 26, 22),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                hero,
                const SizedBox(height: 10),
                SizedBox(height: 380, child: _skeletonBlock(radius: 19)),
                const SizedBox(height: 16),
                SizedBox(height: 400, child: _skeletonBlock(radius: 19)),
                const SizedBox(height: 16),
                SizedBox(height: 260, child: _skeletonBlock(radius: 19)),
                const SizedBox(height: 16),
                SizedBox(height: 280, child: _skeletonBlock(radius: 19)),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _skeletonLine({required double width}) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        width: width,
        height: 9,
        decoration: BoxDecoration(
          color: skin.soft,
          borderRadius: BorderRadius.circular(99),
        ),
      ),
    );
  }

  Widget _skeletonBlock({double radius = 19}) {
    return Container(
      decoration: BoxDecoration(
        color: skin.card,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: skin.edge),
        boxShadow: skin.shadow,
      ),
    );
  }
}

/// 首次加载失败 / 404 / 401 / 形状错误：情绪页同款错误卡。
class _IntimacyErrorState extends StatelessWidget {
  const _IntimacyErrorState({
    required this.s,
    required this.skin,
    required this.title,
    required this.body,
    required this.onRetry,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String title;
  final String body;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(26, 20, 26, 24),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: math.max(0, constraints.maxHeight - 44)),
            child: Center(
              child: Container(
                key: const ValueKey('intimacy-error'),
                width: 560,
                padding: const EdgeInsets.fromLTRB(24, 22, 24, 20),
                decoration: BoxDecoration(
                  color: skin.card,
                  borderRadius: BorderRadius.circular(MoodPalette.radius),
                  border: Border.all(color: skin.edge),
                  boxShadow: skin.shadow,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.error_outline_rounded, size: 28, color: IrmiaTheme.danger),
                    const SizedBox(height: 10),
                    Text(
                      title,
                      style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: skin.title),
                    ),
                    const SizedBox(height: 8),
                    Text(body, style: TextStyle(fontSize: 11.5, height: 1.8, color: skin.muted)),
                    const SizedBox(height: 14),
                    TextButton(
                      key: const ValueKey('intimacy-error-retry'),
                      onPressed: onRetry,
                      child: Text(s.retry),
                    ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

Future<void> _showIntimacySettings(
  BuildContext context, {
  required _IntimacySnapshot view,
  required Future<bool> Function(bool enabled, String level) onSave,
}) {
  final s = IrmiaStrings.of(context);
  final skin = MoodPanelSkin.of(context);
  return showDialog<void>(
    context: context,
    barrierColor: MoodPalette.sheetMask,
    builder: (dialogContext) => _IntimacySettingsDialog(
      s: s,
      skin: skin,
      view: view,
      onSave: onSave,
    ),
  );
}

Future<void> _showIntimacyDetails(BuildContext context, _IntimacySnapshot view) {
  final s = IrmiaStrings.of(context);
  final skin = MoodPanelSkin.of(context);
  return showGeneralDialog<void>(
    context: context,
    barrierDismissible: true,
    barrierLabel: s.moodSheetClose,
    barrierColor: MoodPalette.sheetMask,
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (dialogContext, _, __) => Align(
      alignment: Alignment.centerRight,
      child: SizedBox(
        width: 390,
        height: double.infinity,
        child: Material(
          color: skin.sheetBg,
          child: SafeArea(
            child: _IntimacyDetailsSheet(s: s, skin: skin, view: view),
          ),
        ),
      ),
    ),
    transitionBuilder: (dialogContext, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
      return SlideTransition(
        position: Tween<Offset>(begin: const Offset(1, 0), end: Offset.zero).animate(curved),
        child: FadeTransition(opacity: animation, child: child),
      );
    },
  );
}


// ─────────────────────────────── 空态 / 失败 ───────────────────────────────

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.s, required this.skin, required this.message, required this.onRetry});

  final AppStrings s;
  final MoodPanelSkin skin;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 460,
        margin: const EdgeInsets.symmetric(horizontal: 24),
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
        decoration: BoxDecoration(
          color: skin.card,
          borderRadius: BorderRadius.circular(MoodPalette.radius),
          border: Border.all(color: skin.edge),
          boxShadow: skin.shadow,
        ),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.error_outline_rounded, size: 28, color: IrmiaTheme.danger),
          const SizedBox(height: 10),
          Text(message, textAlign: TextAlign.center, style: TextStyle(fontSize: 12, height: 1.6, color: skin.ink)),
          const SizedBox(height: 6),
          TextButton(onPressed: onRetry, child: Text(s.retry)),
        ]),
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.s, required this.skin, required this.message, required this.onRetry});

  final AppStrings s;
  final MoodPanelSkin skin;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(26, 10, 26, 0),
      padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
      decoration: BoxDecoration(
        color: IrmiaTheme.danger.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.28)),
      ),
      child: Row(children: [
        Icon(Icons.error_outline_rounded, size: 15, color: IrmiaTheme.danger),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 11, height: 1.5, color: skin.ink),
          ),
        ),
        TextButton(onPressed: onRetry, child: Text(s.retry)),
      ]),
    );
  }
}

// ─────────────────────────────── 共用小件 / 数据 ───────────────────────────────


class _HistoryPoint {
  const _HistoryPoint({
    required this.atMs,
    required this.valence,
    required this.arousal,
    required this.dominant,
    required this.reasonCode,
    required this.strength,
  });

  final int atMs;
  final double valence;
  final double arousal;
  final String dominant;

  /// 这一拍评价的原因码与主导强度；causes 被投影窗口清空时，「最近的影响」靠它兜底。
  final String reasonCode;
  final double strength;
}

class _CauseView {
  const _CauseView({
    required this.reasonCode,
    required this.dominantEmotion,
    required this.strength,
    required this.evaluatedAtMs,
  });

  final String reasonCode;
  final String dominantEmotion;
  final double strength;
  final int evaluatedAtMs;
}

class _AffectSnapshot {
  const _AffectSnapshot({
    required this.enabled,
    required this.configured,
    required this.evaluatorEnabled,
    required this.updatedAt,
    required this.atMs,
    required this.emotions,
    required this.valence,
    required this.arousal,
    required this.causes,
    required this.history,
    required this.neutral,
    required this.renderLine,
  });

  final bool enabled;
  final bool configured;

  /// 评价器是独立开关（`config.affect.evaluatorEnabled`，默认 false）。它没开时，
  /// 即使 master 开着也永远不会写 `affect/appraised`——空态要如实说这一点。
  final bool evaluatorEnabled;
  final DateTime? updatedAt;

  /// 投影里情绪状态的时刻（epoch ms）；`null` = 还没有评价
  final int? atMs;
  final Map<String, double> emotions;
  final double valence;
  final double arousal;
  final List<_CauseView> causes;
  final List<_HistoryPoint> history;
  final bool neutral;
  final String? renderLine;

  bool get hasData => enabled && updatedAt != null;

  /// 有读数时，六维的行序/键都按后端这次返回的顺序走；空对象才用默认顺序兜底。
  List<String> get emotionKeys =>
      emotions.isEmpty ? MoodPalette.emotionOrder : List<String>.unmodifiable(emotions.keys);

  static _AffectSnapshot? parse(Map<String, dynamic> raw) {
    final enabled = raw['enabled'];
    final configured = raw['configured'];
    final evaluator = raw['evaluatorEnabled'];
    final at = raw['atMs'];
    final emotions = raw['emotions'];
    final mood = raw['mood'];
    final causes = raw['causes'];
    if (enabled is! bool || configured is! bool || emotions is! Map || mood is! Map || causes is! List) {
      return null;
    }
    final updatedRaw = raw['updatedAt'];
    if (updatedRaw != null && updatedRaw is! String) return null;
    final valence = mood['valence'];
    final arousal = mood['arousal'];
    if (valence is! num || arousal is! num) return null;
    final parsedEmotions = <String, double>{};
    for (final entry in emotions.entries) {
      final value = entry.value;
      if (value is num) parsedEmotions['${entry.key}'] = value.toDouble();
    }
    final parsedCauses = <_CauseView>[];
    for (final item in causes) {
      if (item is! Map) continue;
      final reason = item['reasonCode'];
      final dominant = item['dominantEmotion'];
      final strength = item['strength'];
      final evaluated = item['evaluatedAtMs'];
      if (reason is! String || dominant is! String || strength is! num || evaluated is! num) continue;
      parsedCauses.add(_CauseView(
        reasonCode: reason,
        dominantEmotion: dominant,
        strength: strength.toDouble(),
        evaluatedAtMs: evaluated.toInt(),
      ));
    }
    final parsedHistory = <_HistoryPoint>[];
    final history = raw['history'];
    if (history is List) {
      for (final item in history) {
        if (item is! Map) continue;
        final at = item['atMs'];
        final itemValence = item['valence'];
        final itemArousal = item['arousal'];
        final dominant = item['dominant'];
        if (at is! num || itemValence is! num || itemArousal is! num || dominant is! String) continue;
        final reason = item['reasonCode'];
        final strength = item['strength'];
        parsedHistory.add(_HistoryPoint(
          atMs: at.toInt(),
          valence: itemValence.toDouble(),
          arousal: itemArousal.toDouble(),
          dominant: dominant,
          reasonCode: reason is String && reason.isNotEmpty ? reason : 'general',
          strength: strength is num ? strength.toDouble() : 0,
        ));
      }
    }
    parsedHistory.sort((a, b) => a.atMs.compareTo(b.atMs));
    final parsedUpdated = updatedRaw == null ? null : DateTime.tryParse(updatedRaw);
    return _AffectSnapshot(
      enabled: enabled,
      configured: configured,
      // 旧后端不带这个字段：缺省按"开着"处理，避免把"未知"误报成"评价器没开"
      evaluatorEnabled: evaluator is bool ? evaluator : true,
      updatedAt: parsedUpdated,
      atMs: at is num ? at.toInt() : null,
      emotions: parsedEmotions,
      valence: valence.toDouble(),
      arousal: arousal.toDouble(),
      causes: parsedCauses,
      history: parsedHistory,
      neutral: raw['neutral'] == true,
      renderLine: raw['renderLine']?.toString(),
    );
  }
}

/// 影响列表的数据源：投影里的 causes 优先；窗口过期被清空时，用轨迹最后 ≤5 个点兜底。
///
/// 为什么需要兜底：causes 是投影里"按强度保留 24h 内"的一小段窗口，而轨迹是评价事件本身；
/// 77 分钟前的一次评价完全可能已经掉出 causes 却仍在 history 里。两处都不空才算真的没有影响。
List<_CauseView> _causesOf(_AffectSnapshot view) {
  if (view.causes.isNotEmpty) return view.causes;
  return <_CauseView>[
    for (final point in view.history.reversed.take(5))
      _CauseView(
        reasonCode: point.reasonCode,
        dominantEmotion: point.dominant,
        strength: point.strength,
        evaluatedAtMs: point.atMs,
      ),
  ];
}

String? _dominantOf(_AffectSnapshot view) {
  if (view.neutral) return null;
  String? best;
  var strongest = 0.0;
  // 与六维同一口径：只认后端这次返回的键（不写死六维名单）
  for (final entry in view.emotions.entries) {
    if (entry.value > strongest) {
      strongest = entry.value;
      best = entry.key;
    }
  }
  return strongest >= 0.15 ? best : null;
}

Color _activeColor(String? dominant) {
  final (colors, _) = MoodPalette.orbGradient(dominant);
  return colors[3];
}

String _valenceWord(double value) => value >= 0.35
    ? 'high'
    : value <= -0.15
        ? 'low'
        : 'mid';

String _arousalWord(double value) => value >= 0.57
    ? 'high'
    : value < 0.30
        ? 'low'
        : 'mid';

String _updatedLabel(AppStrings s, DateTime? updatedAt) {
  if (updatedAt == null) return s.moodUpdatedJustNow;
  final minutes = clock.now().difference(updatedAt).inMinutes;
  return minutes <= 0 ? s.moodUpdatedJustNow : s.moodUpdatedMinutesAgo(minutes);
}

/// 详情浮层里的「状态时刻」：本地时间 + 页面一贯的相对时间口径。
String _stateTimeLabel(AppStrings s, int atMs) {
  final at = DateTime.fromMillisecondsSinceEpoch(atMs);
  return '${at.year}-${_two(at.month)}-${_two(at.day)} ${_two(at.hour)}:${_two(at.minute)}'
      ' · ${_updatedLabel(s, at)}';
}

String _signed(double value, {int digits = 2}) {
  final normalized = value.abs() < 0.0005 ? 0.0 : value;
  return '${normalized >= 0 ? '+' : ''}${normalized.toStringAsFixed(digits)}';
}

String _two(int value) => value.toString().padLeft(2, '0');

// ─────────────────────────────── 亲密：数据 ───────────────────────────────

/// 一条原因（`causes[]`）。`label` 是后端给的人话，页面只用不改写；`reasonCode` 留着核对。
/// `strength` 按契约是 0..100 的整数化强度，不是概率。
class _IntimacyCause {
  const _IntimacyCause({
    required this.atMs,
    required this.reasonCode,
    required this.strength,
    required this.label,
  });

  final int atMs;
  final String reasonCode;
  final double strength;
  final String label;
}

/// 一拍读数（`history[]`）：四格的时刻是同一个，所以只存一个 `atMs`。
class _IntimacyPoint {
  const _IntimacyPoint({
    required this.atMs,
    required this.intimacy,
    required this.desire,
    required this.satisfaction,
    required this.restraint,
  });

  final int atMs;
  final double intimacy;
  final double desire;
  final double satisfaction;
  final double restraint;

  double valueOf(String key) => switch (key) {
    'intimacy' => intimacy,
    'desire' => desire,
    'satisfaction' => satisfaction,
    _ => restraint,
  };
}

/// `GET /api/intimacy` 的一份读法。
///
/// 与旧版最大的差别是**严进**：契约（`docs/intimacy-panel-api.md`）说 `labels` / `phase` /
/// `estrus` / `afterglow` / 四个读数都是必填，缺一个就回 null，上层落到「数据格式不对」。
/// 这样不会用 0 把四格铺满，也不会用 `desire` / `satisfaction` 反推发情与余韵。
///
/// 兼容性只留一处：`line` / `renderLine` / `updatedAt` 允许为 null（契约本来就是 nullable），
/// 缺字段按 null 处理。
class _IntimacySnapshot {
  const _IntimacySnapshot({
    required this.enabled,
    required this.configured,
    required this.privateOnly,
    required this.maxLevel,
    required this.atMs,
    required this.updatedAt,
    required this.intimacy,
    required this.desire,
    required this.satisfaction,
    required this.restraint,
    required this.level,
    required this.line,
    required this.renderLine,
    required this.phase,
    required this.estrus,
    required this.afterglow,
    required this.labels,
    required this.causes,
    required this.history,
  });

  /// 上限的三个取值（顺序就是界面上从左到右的顺序）
  static const List<String> levels = <String>['subtle', 'obvious', 'strong'];

  /// 状态机的四个阶段（`GET /api/intimacy` 的 `phase`）
  static const List<String> phases = <String>[
    'calm',
    'warm',
    'tense',
    'estrus',
  ];

  final bool enabled;

  /// 配置里的值；与 [enabled] 不同 = 改动还没生效 / 被环境变量覆盖
  final bool configured;

  /// 契约恒为 true（只对用户私聊生效）
  final bool privateOnly;
  final String maxLevel;

  /// 最近一条事件的时刻（epoch ms）
  final int atMs;
  final DateTime? updatedAt;
  final double intimacy;
  final double desire;
  final double satisfaction;
  final double restraint;

  /// 当前生效的档位（可能低于上限）
  final String level;

  /// 后端拼好的动态行；关闭 / 不可渲染时为 null。页面只原样显示。
  final String? line;

  /// 与 [line] 同值的历史兼容字段（只给详情浮层核对用）
  final String? renderLine;

  /// 四读数状态机的阶段，只认契约里的四个值
  final String phase;

  /// 是否发情：**只认后端布尔**，不用 desire 推
  final bool estrus;

  /// 是否余韵：**只认后端布尔**，不用 satisfaction > 0 推
  final bool afterglow;

  /// 四格各自的档位文案（后端给的 `labels`）；不按 maxLevel 二次封顶
  final Map<String, String> labels;
  final List<_IntimacyCause> causes;
  final List<_IntimacyPoint> history;

  double valueOf(String key) => switch (key) {
    'intimacy' => intimacy,
    'desire' => desire,
    'satisfaction' => satisfaction,
    _ => restraint,
  };

  String? labelOf(String key) => labels[key];

  static String? _stringOrNull(dynamic value) {
    if (value == null) return null;
    if (value is! String) return null;
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  static _IntimacySnapshot? parse(Map<String, dynamic> raw) {
    final enabled = raw['enabled'];
    final configured = raw['configured'];
    final privateOnly = raw['privateOnly'];
    if (enabled is! bool || configured is! bool || privateOnly is! bool) {
      return null;
    }

    final maxLevel = raw['maxLevel'];
    final level = raw['level'];
    final phase = raw['phase'];
    if (maxLevel is! String || !levels.contains(maxLevel)) return null;
    if (level is! String || !levels.contains(level)) return null;
    if (phase is! String || !phases.contains(phase)) return null;
    if (raw['estrus'] is! bool || raw['afterglow'] is! bool) return null;

    final at = raw['atMs'];
    if (at is! num || !at.isFinite) return null;

    final updatedRaw = raw['updatedAt'];
    DateTime? updatedAt;
    if (updatedRaw != null) {
      if (updatedRaw is! String) return null;
      updatedAt = DateTime.tryParse(updatedRaw);
      if (updatedAt == null) return null;
    }

    final metrics = <String, double>{};
    for (final key in _intimacyKeys) {
      final value = raw[key];
      if (value is! num || !value.isFinite) return null;
      final metric = value.toDouble();
      if (metric < 0 || metric > 100) return null;
      metrics[key] = metric;
    }

    final rawLabels = raw['labels'];
    if (rawLabels is! Map) return null;
    final labels = <String, String>{};
    for (final key in _intimacyKeys) {
      final value = rawLabels[key];
      if (value is! String) return null;
      final trimmed = value.trim();
      if (trimmed.isEmpty) return null;
      labels[key] = trimmed;
    }

    // line / renderLine 是 nullable；但给了却不是字符串 = 形状不对（别静默吞掉）。
    for (final key in const ['line', 'renderLine']) {
      final value = raw[key];
      if (value != null && value is! String) return null;
    }
    final line = _stringOrNull(raw['line']);
    final renderLine = _stringOrNull(raw['renderLine']);

    final rawCauses = raw['causes'];
    if (rawCauses is! List) return null;
    final causes = <_IntimacyCause>[];
    for (final item in rawCauses) {
      if (item is! Map) continue;
      final causeAt = item['atMs'];
      final strength = item['strength'];
      if (causeAt is! num || !causeAt.isFinite) continue;
      if (strength is! num || !strength.isFinite) continue;
      causes.add(
        _IntimacyCause(
          atMs: causeAt.toInt(),
          reasonCode: item['reasonCode']?.toString() ?? '',
          strength: strength.toDouble().clamp(0.0, 100.0),
          label: item['label']?.toString() ?? '',
        ),
      );
    }
    causes.sort((a, b) => b.atMs.compareTo(a.atMs));

    final rawHistory = raw['history'];
    if (rawHistory is! List) return null;
    final history = <_IntimacyPoint>[];
    for (final item in rawHistory) {
      if (item is! Map) continue;
      final pointAt = item['atMs'];
      if (pointAt is! num || !pointAt.isFinite) continue;
      final values = <double>[];
      var valid = true;
      for (final key in _intimacyKeys) {
        final value = item[key];
        if (value is! num || !value.isFinite) {
          valid = false;
          break;
        }
        final asDouble = value.toDouble();
        if (asDouble < 0 || asDouble > 100) {
          valid = false;
          break;
        }
        values.add(asDouble);
      }
      if (!valid) continue;
      history.add(
        _IntimacyPoint(
          atMs: pointAt.toInt(),
          intimacy: values[0],
          desire: values[1],
          satisfaction: values[2],
          restraint: values[3],
        ),
      );
    }
    history.sort((a, b) => a.atMs.compareTo(b.atMs));
    // 契约最多 400 点；真收到更多时只留最近 400，别让画笔多跑。
    final trimmedHistory = history.length > 400
        ? history.sublist(history.length - 400)
        : history;

    return _IntimacySnapshot(
      enabled: enabled,
      configured: configured,
      privateOnly: privateOnly,
      maxLevel: maxLevel,
      atMs: at.toInt(),
      updatedAt: updatedAt,
      intimacy: metrics['intimacy']!,
      desire: metrics['desire']!,
      satisfaction: metrics['satisfaction']!,
      restraint: metrics['restraint']!,
      level: level,
      line: line,
      renderLine: renderLine,
      phase: phase,
      estrus: raw['estrus'] as bool,
      afterglow: raw['afterglow'] as bool,
      labels: labels,
      causes: causes.take(5).toList(),
      history: trimmedHistory,
    );
  }
}

/// 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前（亲密页专用口径，含"刚刚"这个短说法）
String _agoLabel(AppStrings s, DateTime at) {
  final diff = clock.now().difference(at);
  if (diff.inMinutes < 1) return s.intimacyJustNow;
  if (diff.inMinutes < 60) return s.intimacyMinutesAgo(diff.inMinutes);
  if (diff.inHours < 24) return s.intimacyHoursAgo(diff.inHours);
  return s.intimacyDaysAgo(diff.inDays);
}

String _hourLabel(DateTime at) => '${_two(at.hour)}:00';

String _weekday(AppStrings s, int weekday) => switch (weekday) {
      DateTime.monday => s.schedWeekdayMon,
      DateTime.tuesday => s.schedWeekdayTue,
      DateTime.wednesday => s.schedWeekdayWed,
      DateTime.thursday => s.schedWeekdayThu,
      DateTime.friday => s.schedWeekdayFri,
      DateTime.saturday => s.schedWeekdaySat,
      _ => s.schedWeekdaySun,
    };
