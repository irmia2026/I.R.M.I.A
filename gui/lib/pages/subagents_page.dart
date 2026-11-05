import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../app.dart';
import '../format.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../ui_kit.dart';
import 'mood_kit.dart';

/// 子代理管理页（P3.3，2026-11-05）。
///
/// 入口在「更多 → 子代理」，不新增一级导航；侧栏那一行的角标只算
/// queued / running / interrupted。
///
/// 页面只消费读/控制 API：
///   · `GET /api/subagents?includeArchived=1`（列表；未归档 / 归档两档在本地筛）
///   · `GET /api/subagents/:agentId`（详情与截断后的 lastReport）
///   · `GET /api/subagents/profiles`（Profile 锁态、依赖、技能/MCP 与上下文摘要）
///   · `POST /api/commands/subagent-message|cancel|resume`
///   · `POST /api/commands/subagent-install|verify`（人工确认 + 服务端健康回读）
///   · `GET /api/events`（详情里的历史事件）+ `/api/events/stream`（实时更新）
///
/// 三条硬边界：
///   1. **实时 + 兜底**：SSE 按 `agentId` 过滤，只往当前详情里追加事件；连接断了
///      每 12 秒的轮询仍会读列表/详情，绝不会停在永久转圈上。
///   2. **摘要面**：不显示完整 transcript、工具输出、请求体或 workspace 绝对路径；
///      后端没给的字段（任务原文等）不猜、不补。
///   3. **状态决定操作**：只有 `canResume` 才出现恢复，只有 `canCancel` 才出现取消；
///      已取消 / 已归档的会话不显示消息入口。
///
/// 版式沿用情绪面板：`moodPanelFrame` / `MoodPanelTop` / `MoodPanelSkin` 与同一套
/// 字号、留白、明暗底。宽窗左列表右详情，窄窗单列滚动。
class SubagentsPage extends StatefulWidget {
  const SubagentsPage({super.key, required this.state});

  final AppState state;

  @override
  State<SubagentsPage> createState() => _SubagentsPageState();
}

class _SubagentsPageState extends State<SubagentsPage> {
  static const Duration _pollEvery = Duration(seconds: 12);
  static const Duration _sseRetryEvery = Duration(seconds: 3);
  static const Duration _sseReloadDelay = Duration(milliseconds: 350);

  List<SubagentSummary> _items = const <SubagentSummary>[];
  List<SubagentProfileSummary> _profiles = const <SubagentProfileSummary>[];
  bool? _enabled;
  bool _loading = true;
  bool _refreshing = false;
  bool _profilesLoading = true;
  String? _error;
  String? _profilesError;
  bool _showArchived = false;

  /// 角色包区是「列表 + 选中详情」：窄窗也能用同一份数据，不另做一套卡片。
  String? _selectedProfileId;

  String? _selectedId;
  SubagentDetail? _detail;
  bool _detailLoading = false;
  String? _detailError;
  List<SubagentEvent> _timeline = const <SubagentEvent>[];
  bool _timelineLoading = false;
  String? _timelineError;

  bool _toggleSaving = false;
  bool _acting = false;
  bool _sendingMessage = false;
  bool _restartPending = false;
  final Set<String> _profileBusy = <String>{};

  final TextEditingController _messageCtl = TextEditingController();
  final FocusNode _messageFocus = FocusNode();

  StreamSubscription<Map<String, dynamic>>? _eventsSub;
  Timer? _eventsRetry;
  Timer? _poll;
  Timer? _sseReload;

  int _listEpoch = 0;
  int _detailEpoch = 0;
  int _timelineEpoch = 0;

  @override
  void initState() {
    super.initState();
    _connectEvents();
    unawaited(_loadList(initial: true));
    unawaited(_loadProfiles());
    _poll = Timer.periodic(_pollEvery, (_) {
      if (!mounted) return;
      unawaited(_loadList(silent: true));
      if (_selectedId != null) {
        unawaited(_loadDetail(silent: true));
        unawaited(_loadTimeline(silent: true));
      }
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    _eventsRetry?.cancel();
    _sseReload?.cancel();
    unawaited(_eventsSub?.cancel());
    _messageCtl.dispose();
    _messageFocus.dispose();
    super.dispose();
  }

  // ───────────────────────────── 数据：列表 / Profile ─────────────────────────────

  Future<void> _loadList({bool silent = false, bool initial = false}) async {
    final epoch = ++_listEpoch;
    if (!silent && !initial && mounted) {
      setState(() => _error = null);
    }
    try {
      final raw = await widget.state.api.get(
        '/api/subagents?includeArchived=1',
      );
      if (!mounted || epoch != _listEpoch) return;
      final map = raw is Map
          ? Map<String, dynamic>.from(raw)
          : const <String, dynamic>{};
      final enabled = map['enabled'] == true;
      final rows = map['items'];
      final parsed = <SubagentSummary>[];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map) continue;
          final item = SubagentSummary.tryParse(Map<String, dynamic>.from(row));
          if (item != null) parsed.add(item);
        }
      }
      parsed.sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
      setState(() {
        _enabled = enabled;
        _items = List<SubagentSummary>.unmodifiable(parsed);
        _error = null;
        _loading = false;
        _ensureSelection();
      });
      widget.state.applySubagentOverview(
        enabled: enabled,
        items: rows is List ? rows : const <dynamic>[],
      );
    } catch (err) {
      if (!mounted || epoch != _listEpoch) return;
      // 静默轮询失败时保留旧列表；只有"手上什么都没有"或人手动刷新时才显示错误卡，
      // 否则每 12 秒闪一次红字，反而比不更新更吵。
      if (silent && _items.isNotEmpty) return;
      setState(() {
        _error = '$err';
        _loading = false;
      });
    }
  }

  Future<void> _loadProfiles({bool silent = false}) async {
    if (!silent && mounted) setState(() => _profilesLoading = true);
    try {
      final raw = await widget.state.api.get('/api/subagents/profiles');
      if (!mounted) return;
      final map = raw is Map
          ? Map<String, dynamic>.from(raw)
          : const <String, dynamic>{};
      final rows = map['items'];
      final parsed = <SubagentProfileSummary>[];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map) continue;
          final item = SubagentProfileSummary.tryParse(
            Map<String, dynamic>.from(row),
          );
          if (item != null) parsed.add(item);
        }
      }
      setState(() {
        // `general` 是隐式默认 Profile（设计 §13）：会话行/详情仍照它自己的 label 显示，
        // 但「Profile 摘要」只列专职 Profile，避免同一屏里出现第六个"通用"模板。
        final specialized = parsed
            .where((item) => item.id != 'general')
            .toList(growable: false);
        _profiles = List<SubagentProfileSummary>.unmodifiable(
          specialized.isEmpty ? parsed : specialized,
        );
        // 选中项以 id 为准：安装/校验回读后对象换了、选中不该跳回第一行；
        // 原选中被删或第一次加载时才落到第一项。
        final keep = _selectedProfileId;
        final stillThere =
            keep != null && _profiles.any((item) => item.id == keep);
        _selectedProfileId = stillThere
            ? keep
            : (_profiles.isEmpty ? null : _profiles.first.id);
        _profilesError = null;
        _profilesLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _profilesError = '$err';
        _profilesLoading = false;
      });
    }
  }

  Future<void> _refreshAll() async {
    if (_refreshing) return;
    setState(() {
      _refreshing = true;
      if (_enabled == null) _loading = true;
      _error = null;
    });
    try {
      await Future.wait<void>([
        _loadList(),
        _loadProfiles(),
        if (_selectedId != null) _loadDetail(),
        if (_selectedId != null) _loadTimeline(),
      ]);
    } finally {
      if (mounted) setState(() => _refreshing = false);
    }
  }

  Future<void> _toggleEnabled(bool next) async {
    if (_toggleSaving) return;
    setState(() => _toggleSaving = true);
    try {
      final raw = await widget.state.api.post('/api/commands/config-update', {
        'fields': {'subagents.enabled': next},
      }, confirm: 'config-update');
      final requiresRestart = raw is Map && raw['requiresRestart'] == true;
      await _loadList(silent: true);
      await _loadProfiles(silent: true);
      if (!mounted) return;
      // 生效值以服务端回读为准：`subagents.enabled` 不在热更白名单里，写盘后要重启才生效。
      final applied = _enabled == next;
      setState(() => _restartPending = requiresRestart || !applied);
      final s = IrmiaStrings.of(context);
      IrmiaToast.show(
        context,
        s.subagentsToggleSaved(next, requiresRestart || !applied),
        kind: requiresRestart || !applied ? ToastKind.info : ToastKind.success,
      );
    } catch (err) {
      if (!mounted) return;
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).subagentsToggleFailed('$err'),
        kind: ToastKind.error,
      );
    } finally {
      if (mounted) setState(() => _toggleSaving = false);
    }
  }

  Future<void> _installProfile(SubagentProfileSummary profile) async {
    if (_profileBusy.contains(profile.id)) return;
    final s = IrmiaStrings.of(context);
    final accepted = await confirm(
      context,
      title: s.settingsInstallTitle(profile.label),
      body: profile.description,
      confirmLabel: s.confirm,
    );
    if (!accepted || !mounted) return;
    await _runProfileAction(profile, 'subagent-install');
  }

  Future<void> _verifyProfile(SubagentProfileSummary profile) async {
    if (_profileBusy.contains(profile.id)) return;
    await _runProfileAction(profile, 'subagent-verify');
  }

  Future<void> _runProfileAction(
    SubagentProfileSummary profile,
    String command,
  ) async {
    setState(() => _profileBusy.add(profile.id));
    try {
      await widget.state.api.post('/api/commands/$command', {
        'profileId': profile.id,
      }, confirm: command, timeout: kApiLongRequestTimeout);
      await _loadProfiles();
      if (!mounted) return;
      if (command == 'subagent-install') {
        IrmiaToast.show(
          context,
          IrmiaStrings.of(context).settingsInstalledOk,
          kind: ToastKind.success,
        );
      }
    } catch (err) {
      if (!mounted) return;
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).subagentsActionFailed('$err'),
        kind: ToastKind.error,
      );
    } finally {
      if (mounted) setState(() => _profileBusy.remove(profile.id));
    }
  }

  // ───────────────────────────── 数据：详情 / 时间线 ─────────────────────────────

  void _ensureSelection() {
    final id = _selectedId;
    if (id == null) return;
    if (_items.any((item) => item.agentId == id)) return;
    _selectedId = null;
    _detail = null;
    _detailError = null;
    _timeline = const <SubagentEvent>[];
    _timelineError = null;
    _timelineLoading = false;
    _detailLoading = false;
  }

  void _select(SubagentSummary item, {bool focusMessage = false}) {
    if (_selectedId != item.agentId) {
      setState(() {
        _selectedId = item.agentId;
        _detail = null;
        _detailError = null;
        _timeline = const <SubagentEvent>[];
        _timelineError = null;
      });
      unawaited(_loadDetail());
      unawaited(_loadTimeline());
    }
    if (focusMessage && _canMessage(item.status)) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _messageFocus.requestFocus();
      });
    }
  }

  Future<void> _loadDetail({bool silent = false}) async {
    final id = _selectedId;
    if (id == null) return;
    final epoch = ++_detailEpoch;
    if (!silent && mounted) {
      setState(() {
        _detailLoading = _detail == null;
        _detailError = null;
      });
    }
    try {
      final raw = await widget.state.api.get(
        '/api/subagents/${Uri.encodeComponent(id)}',
      );
      if (!mounted || epoch != _detailEpoch) return;
      final map = raw is Map
          ? Map<String, dynamic>.from(raw)
          : const <String, dynamic>{};
      final summary = SubagentSummary.tryParse(map);
      if (summary == null) {
        throw const FormatException('invalid subagent detail');
      }
      setState(() {
        _detail = SubagentDetail(
          summary: summary,
          lastReport: _stringOrNull(map['lastReport']),
          headError: _stringOrNull(map['headError']),
        );
        _detailLoading = false;
        _detailError = null;
        // 概要用详情回读校正（状态/可恢复性可能在列表那一拍之后变了）
        final index = _items.indexWhere(
          (item) => item.agentId == summary.agentId,
        );
        if (index >= 0) {
          final next = [..._items];
          next[index] = summary;
          _items = List<SubagentSummary>.unmodifiable(next);
        }
      });
    } catch (err) {
      if (!mounted || epoch != _detailEpoch) return;
      if (silent && _detail != null) return;
      setState(() {
        _detailError = '$err';
        _detailLoading = false;
      });
    }
  }

  Future<void> _loadTimeline({bool silent = false}) async {
    final id = _selectedId;
    if (id == null) return;
    final epoch = ++_timelineEpoch;
    if (!silent && mounted) {
      setState(() {
        _timelineLoading = _timeline.isEmpty;
        _timelineError = null;
      });
    }
    try {
      final raw = await widget.state.api.get(
        '/api/events?types=subagent/&types=wake/subagent&limit=200',
      );
      if (!mounted || epoch != _timelineEpoch) return;
      final map = raw is Map
          ? Map<String, dynamic>.from(raw)
          : const <String, dynamic>{};
      final rows = map['events'];
      final parsed = <SubagentEvent>[];
      if (rows is List) {
        for (final row in rows) {
          if (row is! Map) continue;
          final event = SubagentEvent.tryParse(
            Map<String, dynamic>.from(row),
            agentId: id,
          );
          if (event != null) parsed.add(event);
        }
      }
      parsed.sort((a, b) => a.seq.compareTo(b.seq));
      setState(() {
        _timeline = List<SubagentEvent>.unmodifiable(parsed);
        _timelineLoading = false;
        _timelineError = null;
      });
    } catch (err) {
      if (!mounted || epoch != _timelineEpoch) return;
      if (silent && _timeline.isNotEmpty) return;
      setState(() {
        _timelineError = '$err';
        _timelineLoading = false;
      });
    }
  }

  // ───────────────────────────── SSE / 兜底轮询 ─────────────────────────────

  void _connectEvents() {
    if (!mounted) return;
    try {
      _eventsSub = widget.state.api.events().listen(
        _onFeedEvent,
        onError: (_) => _onEventsDown(),
        onDone: _onEventsDown,
        cancelOnError: false,
      );
    } catch (_) {
      _onEventsDown();
    }
  }

  void _onEventsDown() {
    if (!mounted) return;
    unawaited(_eventsSub?.cancel());
    _eventsSub = null;
    _eventsRetry?.cancel();
    _eventsRetry = Timer(_sseRetryEvery, () {
      if (!mounted) return;
      _connectEvents();
      // 断线窗口里可能漏了状态变化：先读一遍，再等流自己追上。
      unawaited(_loadList(silent: true));
      if (_selectedId != null) {
        unawaited(_loadDetail(silent: true));
        unawaited(_loadTimeline(silent: true));
      }
    });
  }

  void _onFeedEvent(Map<String, dynamic> event) {
    final type = event['type']?.toString() ?? '';
    if (!type.startsWith('subagent/') && type != 'wake/subagent') return;
    final rawData = event['data'];
    if (rawData is! Map) return;
    final data = Map<String, dynamic>.from(rawData);
    final agentId = data['agentId']?.toString() ?? '';
    if (agentId.isEmpty) return;
    final id = _selectedId;
    if (id != null && agentId == id) {
      final item = SubagentEvent.tryParse(event, agentId: id);
      if (item != null) {
        final exists = _timeline.any((entry) => entry.seq == item.seq);
        if (!exists) {
          setState(() {
            _timeline = List<SubagentEvent>.unmodifiable(
              [..._timeline, item]..sort((a, b) => a.seq.compareTo(b.seq)),
            );
            _timelineLoading = false;
            _timelineError = null;
          });
        }
      }
    }
    // 事件本身只带局部字段（比如 report 只带 summary/tokens）：状态机与 canCancel /
    // canResume 仍以 API 回读为准。合并成一次 350ms 后的重读，免得一串事件打爆接口。
    _sseReload?.cancel();
    _sseReload = Timer(_sseReloadDelay, () {
      if (!mounted) return;
      unawaited(_loadList(silent: true));
      if (_selectedId != null) {
        unawaited(_loadDetail(silent: true));
        unawaited(_loadTimeline(silent: true));
      }
    });
  }

  // ───────────────────────────── 动作：取消 / 恢复 / 消息 ─────────────────────────────

  SubagentSummary? get _selectedSummary {
    final id = _selectedId;
    if (id == null) return null;
    for (final item in _items) {
      if (item.agentId == id) return item;
    }
    return _detail?.summary;
  }

  bool _canMessage(String status) =>
      status != 'cancelled' && status != 'archived';

  Future<void> _confirmCancel() async {
    final item = _selectedSummary;
    if (item == null || !item.canCancel || _acting) return;
    final s = IrmiaStrings.of(context);
    final ok = await confirm(
      context,
      title: s.subagentsCancelTitle,
      body: s.subagentsCancelBody(_shortId(item.agentId)),
      confirmLabel: s.confirm,
      danger: true,
    );
    if (!ok || !mounted) return;
    await _runAction(
      item,
      command: 'subagent-cancel',
      confirm: 'subagent-cancel',
      kind: _ActionKind.cancel,
    );
  }

  Future<void> _confirmResume() async {
    final item = _selectedSummary;
    if (item == null || !item.canResume || _acting) return;
    final s = IrmiaStrings.of(context);
    final ok = await confirm(
      context,
      title: s.subagentsResumeTitle,
      body: s.subagentsResumeBody(_shortId(item.agentId)),
      confirmLabel: s.subagentsResume,
    );
    if (!ok || !mounted) return;
    await _runAction(
      item,
      command: 'subagent-resume',
      confirm: 'subagent-resume',
      kind: _ActionKind.resume,
    );
  }

  Future<void> _runAction(
    SubagentSummary item, {
    required String command,
    required String confirm,
    required _ActionKind kind,
  }) async {
    setState(() => _acting = true);
    try {
      await widget.state.api.post('/api/commands/$command', {
        'agentId': item.agentId,
      }, confirm: confirm);
      await _loadList(silent: true);
      if (_selectedId == item.agentId) {
        await _loadDetail(silent: true);
        await _loadTimeline(silent: true);
      }
      if (!mounted) return;
      final s = IrmiaStrings.of(context);
      IrmiaToast.show(
        context,
        kind == _ActionKind.cancel
            ? s.subagentsCancelDone()
            : s.subagentsResumeDone(),
        kind: ToastKind.success,
      );
    } catch (err) {
      if (!mounted) return;
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).subagentsActionFailed('$err'),
        kind: ToastKind.error,
      );
    } finally {
      if (mounted) setState(() => _acting = false);
    }
  }

  Future<void> _sendMessage() async {
    final item = _selectedSummary;
    final text = _messageCtl.text.trim();
    if (item == null ||
        text.isEmpty ||
        _sendingMessage ||
        !_canMessage(item.status)) {
      return;
    }
    setState(() => _sendingMessage = true);
    try {
      await widget.state.api.post('/api/commands/subagent-message', {
        'agentId': item.agentId,
        'message': text,
      });
      _messageCtl.clear();
      await _loadList(silent: true);
      if (_selectedId == item.agentId) {
        await _loadDetail(silent: true);
        await _loadTimeline(silent: true);
      }
      if (!mounted) return;
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).subagentsMessageSent(),
        kind: ToastKind.success,
      );
    } catch (err) {
      if (!mounted) return;
      IrmiaToast.show(
        context,
        IrmiaStrings.of(context).subagentsMessageFailed('$err'),
        kind: ToastKind.error,
      );
    } finally {
      if (mounted) setState(() => _sendingMessage = false);
    }
  }

  // ───────────────────────────── 版式 ─────────────────────────────

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final skin = MoodPanelSkin.of(context);
    return Container(
      key: const ValueKey('subagents-page-background'),
      color: skin.bg,
      child: Column(
        children: [
          _SubagentsHeader(
            s: s,
            skin: skin,
            enabled: _enabled == true,
            loading: _loading,
            savingToggle: _toggleSaving,
            refreshing: _refreshing,
            activeCount: _activeCount,
            onToggle: _enabled == null ? null : _toggleEnabled,
            onRefresh: _refreshAll,
          ),
          Expanded(child: _body(s, skin)),
        ],
      ),
    );
  }

  int get _activeCount => _items
      .where(
        (item) =>
            item.status == 'queued' ||
            item.status == 'running' ||
            item.status == 'interrupted',
      )
      .length;

  List<SubagentSummary> get _visibleItems => _showArchived
      ? _items
            .where((item) => item.status == 'archived')
            .toList(growable: false)
      : _items
            .where((item) => item.status != 'archived')
            .toList(growable: false);

  /// 当前选中的角色包；列表被刷新成空时返回 null（详情区一起收掉）。
  SubagentProfileSummary? get _selectedProfile {
    for (final profile in _profiles) {
      if (profile.id == _selectedProfileId) return profile;
    }
    return _profiles.isEmpty ? null : _profiles.first;
  }

  void _selectProfile(SubagentProfileSummary profile) {
    if (profile.id == _selectedProfileId) return;
    setState(() => _selectedProfileId = profile.id);
  }

  Widget _body(AppStrings s, MoodPanelSkin skin) {
    if (_enabled == null && _loading) {
      return _SubagentsSkeleton(skin: skin);
    }
    if (_enabled == null && _error != null) {
      return _FullError(
        s: s,
        skin: skin,
        message: s.subagentsLoadFailed(_error!),
        onRetry: _refreshAll,
      );
    }
    if (_enabled == false) return _disabledBody(s, skin);
    return _enabledBody(s, skin);
  }

  Widget _disabledBody(AppStrings s, MoodPanelSkin skin) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(26, 14, 26, 22),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 900),
              child: Column(
                children: [
                  moodPanelFrame(
                    skin,
                    padding: const EdgeInsets.fromLTRB(22, 20, 22, 18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            MoodSectionBadge(
                              icon: Icons.account_tree_outlined,
                              skin: skin,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                s.subagentsDisabledTitle,
                                style: TextStyle(
                                  fontSize: 15,
                                  fontWeight: FontWeight.w700,
                                  color: skin.heading,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Text(
                          s.subagentsDisabledBody,
                          style: TextStyle(
                            fontSize: 12.5,
                            height: 1.75,
                            color: skin.muted,
                          ),
                        ),
                        if (_restartPending) ...[
                          const SizedBox(height: 10),
                          _RestartNote(s: s, skin: skin),
                        ],
                        const SizedBox(height: 14),
                        Row(
                          children: [
                            Icon(
                              Icons.lock_outline_rounded,
                              size: 14,
                              color: skin.mutedSoft,
                            ),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                s.subagentsSafetyNote,
                                style: TextStyle(
                                  fontSize: 10.5,
                                  height: 1.55,
                                  color: skin.mutedSoft,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                  _profilesPanel(s, skin),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _enabledBody(AppStrings s, MoodPanelSkin skin) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide =
            constraints.maxWidth >= 1000 && constraints.maxHeight >= 620;
        if (wide) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(26, 14, 26, 14),
            child: Column(
              children: [
                _profilesPanel(s, skin),
                const SizedBox(height: 14),
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        flex: 43,
                        child: _sessionsPanel(s, skin, fill: true),
                      ),
                      const SizedBox(width: 16),
                      Expanded(
                        flex: 57,
                        child: _detailPanel(s, skin, fill: true),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          );
        }
        return SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(26, 14, 26, 22),
          child: Column(
            children: [
              _profilesPanel(s, skin),
              const SizedBox(height: 14),
              _sessionsPanel(s, skin, fill: false),
              const SizedBox(height: 14),
              _detailPanel(s, skin, fill: false),
            ],
          ),
        );
      },
    );
  }

  Widget _profilesPanel(AppStrings s, MoodPanelSkin skin) {
    final showCards = _profiles.isNotEmpty;
    final disabled = _enabled != true;
    return moodPanelFrame(
      skin,
      key: const ValueKey('subagents-profiles'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MoodPanelTop(
            icon: Icons.workspaces_outline,
            title: s.subagentsProfilesTitle,
            skin: skin,
            caption: s.subagentsProfilesCaption,
          ),
          const SizedBox(height: 10),
          if (_profilesLoading && !showCards)
            _SkeletonLines(skin: skin, lines: 2)
          else if (_profilesError != null && !showCards)
            _InlineError(
              s: s,
              skin: skin,
              message: s.subagentsProfilesLoadFailed(_profilesError!),
              onRetry: () => unawaited(_loadProfiles()),
            )
          else if (!showCards)
            Text(
              disabled ? s.subagentsProfilesDisabled : s.empty,
              style: TextStyle(
                fontSize: 11.5,
                height: 1.6,
                color: skin.mutedSoft,
              ),
            )
          else
            _ProfileSection(
              s: s,
              skin: skin,
              profiles: _profiles,
              selected: _selectedProfile,
              busy: _profileBusy,
              onSelect: _selectProfile,
              onInstall: _installProfile,
              onVerify: _verifyProfile,
            ),
          if (_profilesError != null && showCards) ...[
            const SizedBox(height: 8),
            _InlineError(
              s: s,
              skin: skin,
              message: s.subagentsProfilesLoadFailed(_profilesError!),
              onRetry: () => unawaited(_loadProfiles()),
            ),
          ],
        ],
      ),
    );
  }

  Widget _sessionsPanel(
    AppStrings s,
    MoodPanelSkin skin, {
    required bool fill,
  }) {
    final visible = _visibleItems;
    final archived = _items.where((item) => item.status == 'archived').length;
    final active = _items.where((item) => item.status != 'archived').length;
    return moodPanelFrame(
      skin,
      key: const ValueKey('subagents-list'),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MoodPanelTop(
            icon: Icons.forum_outlined,
            title: s.subagentsSessionsTitle,
            skin: skin,
            trailing: _CountPill(
              label: _showArchived
                  ? s.subagentsArchivedTab
                  : s.subagentsActiveTab,
              count: _showArchived ? archived : active,
              skin: skin,
            ),
          ),
          const SizedBox(height: 9),
          _ArchiveTabs(
            s: s,
            skin: skin,
            showArchived: _showArchived,
            activeCount: active,
            archivedCount: archived,
            onChanged: (next) {
              if (next == _showArchived) return;
              setState(() {
                _showArchived = next;
                _ensureSelection();
              });
            },
          ),
          if (_restartPending) ...[
            const SizedBox(height: 8),
            _RestartNote(s: s, skin: skin),
          ],
          if (_error != null) ...[
            const SizedBox(height: 9),
            _InlineError(
              s: s,
              skin: skin,
              message: s.subagentsLoadFailed(_error!),
              onRetry: _refreshAll,
            ),
          ],
          const SizedBox(height: 9),
          if (_loading)
            _SkeletonLines(skin: skin, lines: 4)
          else if (visible.isEmpty)
            _EmptyList(s: s, skin: skin, archived: _showArchived)
          else
            _SessionList(
              s: s,
              skin: skin,
              items: visible,
              selectedId: _selectedId,
              fill: fill,
              onSelect: (item) => _select(item),
              onMessage: (item) => _select(item, focusMessage: true),
              onCancel: (item) {
                _select(item);
                unawaited(_confirmCancel());
              },
              onResume: (item) {
                _select(item);
                unawaited(_confirmResume());
              },
            ),
        ],
      ),
    );
  }

  Widget _detailPanel(AppStrings s, MoodPanelSkin skin, {required bool fill}) {
    final summary = _selectedSummary;
    if (summary == null) {
      return moodPanelFrame(
        skin,
        key: const ValueKey('subagent-detail'),
        padding: const EdgeInsets.fromLTRB(18, 16, 18, 18),
        child: SizedBox(
          height: fill ? null : 170,
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.touch_app_outlined, size: 26, color: skin.mutedSoft),
                const SizedBox(height: 9),
                Text(
                  s.subagentsDetailEmpty,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 11.5,
                    height: 1.6,
                    color: skin.mutedSoft,
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final detail = _detail;
    final view = detail?.summary ?? summary;
    final body = <Widget>[
      _DetailHead(s: s, skin: skin, item: view),
      const SizedBox(height: 12),
      _DetailMeta(s: s, skin: skin, item: view),
      if (detail?.headError != null && detail!.headError!.isNotEmpty) ...[
        const SizedBox(height: 8),
        _CodeNote(text: detail.headError!, skin: skin, tone: IrmiaTheme.warn),
      ],
      const SizedBox(height: 14),
      _ReportBlock(
        s: s,
        skin: skin,
        report: detail?.lastReport,
        loading: _detailLoading && detail == null,
        error: _detailError,
        onRetry: () => unawaited(_loadDetail()),
      ),
      const SizedBox(height: 14),
      _TimelineBlock(
        s: s,
        skin: skin,
        events: _timeline,
        loading: _timelineLoading,
        error: _timelineError,
        onRetry: () => unawaited(_loadTimeline()),
      ),
    ];

    final composer = _Composer(
      s: s,
      skin: skin,
      controller: _messageCtl,
      focusNode: _messageFocus,
      blocked: !_canMessage(view.status),
      sending: _sendingMessage,
      onSend: _sendMessage,
    );

    return moodPanelFrame(
      skin,
      key: const ValueKey('subagent-detail'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          MoodPanelTop(
            icon: Icons.subject_rounded,
            title: s.subagentsDetailTitle,
            skin: skin,
            trailing: _DetailActions(
              s: s,
              skin: skin,
              item: view,
              acting: _acting,
              onCancel: () => unawaited(_confirmCancel()),
              onResume: () => unawaited(_confirmResume()),
            ),
          ),
          const SizedBox(height: 12),
          if (fill)
            Expanded(
              child: SingleChildScrollView(
                key: const ValueKey('subagent-detail-scroll'),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: body,
                ),
              ),
            )
          else
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: body,
            ),
          const SizedBox(height: 10),
          composer,
        ],
      ),
    );
  }

  // ───────────────────────────── 小工具 ─────────────────────────────

  static String? _stringOrNull(dynamic value) {
    if (value is! String) return null;
    final text = value.trim();
    return text.isEmpty ? null : text;
  }
}

// ───────────────────────────── 数据模型 ─────────────────────────────

enum _ActionKind { cancel, resume }

class SubagentSummary {
  const SubagentSummary({
    required this.agentId,
    required this.profileId,
    required this.profileLabel,
    required this.status,
    required this.parentTurn,
    required this.parentCallId,
    required this.createdAt,
    required this.updatedAt,
    required this.lastReportPreview,
    required this.tokensUsed,
    required this.tokensLimit,
    required this.canResume,
    required this.canCancel,
  });

  final String agentId;
  final String profileId;
  final String profileLabel;
  final String status;
  final int parentTurn;
  final String? parentCallId;
  final String createdAt;
  final String updatedAt;
  final String? lastReportPreview;
  final int tokensUsed;
  final int tokensLimit;
  final bool canResume;
  final bool canCancel;

  static SubagentSummary? tryParse(Map<String, dynamic> map) {
    final agentId = _text(map['agentId']);
    if (agentId == null) return null;
    final label =
        _text(map['label']) ??
        _text(map['profileLabel']) ??
        _text(map['profileId']) ??
        '—';
    final tokens = map['tokens'];
    var used = 0;
    var limit = 0;
    if (tokens is Map) {
      used = _int(tokens['used']);
      limit = _int(tokens['limit']);
    }
    return SubagentSummary(
      agentId: agentId,
      profileId: _text(map['profileId']) ?? '—',
      profileLabel: label,
      status: _text(map['status']) ?? 'unknown',
      parentTurn: _int(map['parentTurn']),
      parentCallId: _text(map['parentCallId']),
      createdAt: _text(map['createdAt']) ?? '',
      updatedAt: _text(map['updatedAt']) ?? '',
      lastReportPreview: _text(map['lastReportPreview']),
      tokensUsed: used,
      tokensLimit: limit,
      canResume: map['canResume'] == true,
      canCancel: map['canCancel'] == true,
    );
  }

  static String? _text(dynamic value) {
    if (value is! String) return null;
    final text = value.trim();
    return text.isEmpty ? null : text;
  }

  static int _int(dynamic value) => value is num ? value.toInt() : 0;
}

class SubagentDetail {
  const SubagentDetail({
    required this.summary,
    required this.lastReport,
    required this.headError,
  });

  final SubagentSummary summary;
  final String? lastReport;
  final String? headError;
}

class SubagentProfileSummary {
  const SubagentProfileSummary({
    required this.id,
    required this.label,
    required this.description,
    required this.toolCount,
    required this.workspace,
    required this.lane,
    required this.workdir,
    required this.shell,
    required this.reasoningEffort,
    required this.contextLimit,
    required this.compactAt,
    required this.skills,
    required this.mcpServers,
    required this.available,
    required this.locked,
    required this.missing,
  });

  final String id;
  final String label;
  final String description;
  final int toolCount;
  final String workspace;
  final String lane;
  final String workdir;
  final String shell;
  final String reasoningEffort;
  final int contextLimit;
  final double compactAt;
  final List<String> skills;
  final List<String> mcpServers;
  final bool available;
  final bool locked;
  final List<String> missing;

  static SubagentProfileSummary? tryParse(Map<String, dynamic> map) {
    final id = _text(map['id']);
    if (id == null) return null;
    final available = map['available'] == true;
    return SubagentProfileSummary(
      id: id,
      label: _text(map['label']) ?? id,
      description: _text(map['description']) ?? '',
      toolCount: map['toolCount'] is num
          ? (map['toolCount'] as num).toInt()
          : 0,
      workspace: _text(map['workspace']) ?? '—',
      lane: _text(map['lane']) ?? '—',
      workdir: _text(map['workdir']) ?? '—',
      shell: _text(map['shell']) ?? '—',
      reasoningEffort: _text(map['reasoningEffort']) ?? '—',
      contextLimit: map['contextLimit'] is num
          ? (map['contextLimit'] as num).toInt()
          : 0,
      compactAt: map['compactAt'] is num
          ? (map['compactAt'] as num).toDouble()
          : 0,
      skills: _list(map['skills']),
      mcpServers: _list(map['mcpServers']),
      available: available,
      locked: map['locked'] is bool ? map['locked'] as bool : !available,
      missing: _list(map['missing']),
    );
  }

  static List<String> _list(dynamic value) => value is List
      ? List<String>.unmodifiable(value.map((item) => '$item'))
      : const <String>[];

  static String? _text(dynamic value) {
    if (value is! String) return null;
    final text = value.trim();
    return text.isEmpty ? null : text;
  }
}

class SubagentEvent {
  const SubagentEvent({
    required this.seq,
    required this.ts,
    required this.type,
    required this.data,
  });

  final int seq;
  final String ts;
  final String type;
  final Map<String, dynamic> data;

  static SubagentEvent? tryParse(
    Map<String, dynamic> map, {
    required String agentId,
  }) {
    final rawType = map['type']?.toString() ?? '';
    if (rawType != 'wake/subagent' && !rawType.startsWith('subagent/')) {
      return null;
    }
    final rawData = map['data'];
    if (rawData is! Map) return null;
    final data = Map<String, dynamic>.from(rawData);
    if (data['agentId']?.toString() != agentId) return null;
    final type = rawType == 'wake/subagent'
        ? 'wake'
        : rawType.substring('subagent/'.length);
    return SubagentEvent(
      seq: map['seq'] is num ? (map['seq'] as num).toInt() : 0,
      ts: map['ts']?.toString() ?? '',
      type: type,
      data: data,
    );
  }
}

// ───────────────────────────── 页头 ─────────────────────────────

class _SubagentsHeader extends StatelessWidget {
  const _SubagentsHeader({
    required this.s,
    required this.skin,
    required this.enabled,
    required this.loading,
    required this.savingToggle,
    required this.refreshing,
    required this.activeCount,
    required this.onToggle,
    required this.onRefresh,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final bool enabled;
  final bool loading;
  final bool savingToggle;
  final bool refreshing;
  final int activeCount;
  final ValueChanged<bool>? onToggle;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    final title = Text(
      s.subagentsHeading,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(
        fontSize: 29,
        height: 1.1,
        letterSpacing: 0.5,
        fontWeight: FontWeight.w700,
        color: skin.heading,
      ),
    );
    final tagline = Text(
      s.subagentsTagline,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(fontSize: 12, color: skin.mutedSoft),
    );
    final switchControl = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          s.subagentsSystem,
          style: TextStyle(fontSize: 10, color: skin.mutedSoft),
        ),
        const SizedBox(width: 4),
        SizedBox(
          width: 46,
          height: 28,
          child: FittedBox(
            fit: BoxFit.contain,
            child: Switch(
              key: const ValueKey('subagents-enable-switch'),
              value: enabled,
              onChanged: loading || savingToggle ? null : onToggle,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
        ),
      ],
    );
    final refresh = _SquareIconButton(
      key: const ValueKey('subagents-refresh'),
      icon: Icons.refresh_rounded,
      tooltip: s.extRefresh,
      skin: skin,
      onTap: refreshing ? null : onRefresh,
    );
    final active = activeCount > 0
        ? Container(
            key: const ValueKey('subagents-active-count'),
            padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
            decoration: BoxDecoration(
              color: skin.soft,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: skin.edge),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 5,
                  height: 5,
                  decoration: BoxDecoration(
                    color: IrmiaTheme.ok,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 5),
                Text(
                  '$activeCount',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: skin.primary,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          )
        : null;

    return Padding(
      key: const ValueKey('subagents-header'),
      padding: const EdgeInsets.fromLTRB(26, 22, 26, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.subagentsEyebrow,
            style: TextStyle(
              fontSize: 10,
              fontWeight: FontWeight.w800,
              letterSpacing: 2,
              color: skin.primary.withValues(alpha: 0.8),
            ),
          ),
          const SizedBox(height: 8),
          LayoutBuilder(
            builder: (context, constraints) {
              if (constraints.maxWidth >= 680) {
                return Row(
                  children: [
                    title,
                    const SizedBox(width: 12),
                    Expanded(child: tagline),
                    if (active != null) ...[const SizedBox(width: 10), active],
                    const SizedBox(width: 10),
                    switchControl,
                    const SizedBox(width: 10),
                    refresh,
                  ],
                );
              }
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Flexible(child: title),
                      const SizedBox(width: 12),
                      Expanded(child: tagline),
                    ],
                  ),
                  const SizedBox(height: 9),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Wrap(
                      crossAxisAlignment: WrapCrossAlignment.center,
                      alignment: WrapAlignment.end,
                      spacing: 10,
                      runSpacing: 8,
                      children: [
                        if (active != null) active,
                        switchControl,
                        refresh,
                      ],
                    ),
                  ),
                ],
              );
            },
          ),
        ],
      ),
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
    final active = onTap != null;
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
            child: Icon(
              icon,
              size: 18,
              color: active ? skin.muted : skin.mutedSoft,
            ),
          ),
        ),
      ),
    );
  }
}

// ───────────────────────────── Profile 摘要 ─────────────────────────────
//
// 版式取舍（2026-11-05 重排）：1350×900 下列表里有四个角色包，旧实现是 Wrap 网格——
// 可用宽度落在 3 列时第四张卡单独掉一行，右侧/下方一大片空白；卡内又把 locked、
// missing、skills、MCP 与按钮全挤成一列，长 missing 换行后把卡撑高，会话区被顶到屏外。
//
// 现在改成「紧凑列表 + 选中详情」两栏（与下面的会话区同构）：
//   · 列表行固定高度：状态点 + label/id + 一句 description + 状态词，永远单行，不会孤行；
//   · reasoning / context / workdir / skills / MCP / missing 只在详情里各出现一次；
//   · missing、skills、MCP 都是单行 chip，放不下就折成「+N」，点开才换行；
//   · 安装 / 校验固定在详情右上角的操作区，不跟长依赖列表混排。
// 窄窗（< 760）自动折成「列表在上、详情在下」，仍是单列滚动。

class _ProfileSection extends StatelessWidget {
  const _ProfileSection({
    required this.s,
    required this.skin,
    required this.profiles,
    required this.selected,
    required this.busy,
    required this.onSelect,
    required this.onInstall,
    required this.onVerify,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final List<SubagentProfileSummary> profiles;
  final SubagentProfileSummary? selected;
  final Set<String> busy;
  final ValueChanged<SubagentProfileSummary> onSelect;
  final ValueChanged<SubagentProfileSummary> onInstall;
  final ValueChanged<SubagentProfileSummary> onVerify;

  @override
  Widget build(BuildContext context) {
    final current = selected;
    final detail = current == null
        ? null
        : _ProfileDetail(
            key: ValueKey('subagents-profile-detail-${current.id}'),
            s: s,
            skin: skin,
            profile: current,
            busy: busy.contains(current.id),
            onInstall: () => onInstall(current),
            onVerify: () => onVerify(current),
          );
    final list = _ProfileList(
      s: s,
      skin: skin,
      profiles: profiles,
      selectedId: current?.id,
      onSelect: onSelect,
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= 760 && detail != null) {
          return Row(
            key: const ValueKey('subagents-profiles-split'),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 42, child: list),
              const SizedBox(width: 14),
              Expanded(flex: 58, child: detail),
            ],
          );
        }
        return Column(
          key: const ValueKey('subagents-profiles-stack'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            list,
            if (detail != null) ...[const SizedBox(height: 10), detail],
          ],
        );
      },
    );
  }
}

/// 左栏：每个角色包一行，固定高度，扫读只花一眼。
class _ProfileList extends StatelessWidget {
  const _ProfileList({
    required this.s,
    required this.skin,
    required this.profiles,
    required this.selectedId,
    required this.onSelect,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final List<SubagentProfileSummary> profiles;
  final String? selectedId;
  final ValueChanged<SubagentProfileSummary> onSelect;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('subagents-profile-list'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var index = 0; index < profiles.length; index += 1) ...[
          if (index > 0) const SizedBox(height: 6),
          _ProfileRow(
            s: s,
            skin: skin,
            profile: profiles[index],
            selected: profiles[index].id == selectedId,
            onTap: () => onSelect(profiles[index]),
          ),
        ],
      ],
    );
  }
}

class _ProfileRow extends StatelessWidget {
  const _ProfileRow({
    required this.s,
    required this.skin,
    required this.profile,
    required this.selected,
    required this.onTap,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentProfileSummary profile;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final locked = profile.locked;
    final tone = locked ? IrmiaTheme.warn : IrmiaTheme.ok;
    final description = profile.description.isEmpty
        ? profile.id
        : profile.description;
    return Material(
      key: ValueKey('subagents-profile-${profile.id}'),
      color: selected ? skin.soft : Colors.transparent,
      borderRadius: BorderRadius.circular(10),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(9, 7, 8, 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: selected
                  ? skin.primary.withValues(alpha: 0.45)
                  : skin.edge,
            ),
          ),
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            profile.label,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              color: skin.title,
                            ),
                          ),
                        ),
                        const SizedBox(width: 5),
                        Flexible(
                          child: Text(
                            profile.id,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 8.5,
                              color: skin.mutedSoft,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      description,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 10,
                        height: 1.35,
                        color: skin.muted,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 6),
              Text(
                locked
                    ? s.subagentsProfileNeedsInstall
                    : s.subagentsProfileReady,
                maxLines: 1,
                style: TextStyle(
                  fontSize: 9,
                  fontWeight: FontWeight.w600,
                  color: tone,
                ),
              ),
              const SizedBox(width: 1),
              Icon(
                Icons.chevron_right_rounded,
                size: 14,
                color: selected ? skin.primary : skin.mutedSoft,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 右栏：选中角色包的只读详情。
///
/// 所有文案都经由 [AppStrings]；这里不新增任何文案，也不重译后端给的 label/description。
class _ProfileDetail extends StatelessWidget {
  const _ProfileDetail({
    super.key,
    required this.s,
    required this.skin,
    required this.profile,
    required this.busy,
    required this.onInstall,
    required this.onVerify,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentProfileSummary profile;
  final bool busy;
  final VoidCallback onInstall;
  final VoidCallback onVerify;

  @override
  Widget build(BuildContext context) {
    final locked = profile.locked;
    final titleRow = Row(
      children: [
        Flexible(
          child: Text(
            profile.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
              color: skin.title,
            ),
          ),
        ),
        const SizedBox(width: 5),
        Flexible(
          child: Text(
            profile.id,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontFamily: 'monospace',
              fontSize: 9,
              color: skin.mutedSoft,
            ),
          ),
        ),
        const SizedBox(width: 7),
        _ProfileStatusBadge(s: s, locked: locked),
      ],
    );
    final actions = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (busy)
          const Padding(
            padding: EdgeInsets.only(right: 2),
            child: SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(strokeWidth: 1.5),
            ),
          ),
        _profileActionButton(
          context,
          key: ValueKey('subagents-profile-verify-${profile.id}'),
          icon: Icons.verified_outlined,
          label: s.subagentsProfileVerify,
          onPressed: busy ? null : onVerify,
        ),
        if (locked) ...[
          const SizedBox(width: 2),
          _profileActionButton(
            context,
            key: ValueKey('subagents-profile-install-${profile.id}'),
            icon: Icons.download_outlined,
            label: s.settingsInstall,
            onPressed: busy ? null : onInstall,
            primary: true,
          ),
        ],
      ],
    );
    final factStyle = TextStyle(fontSize: 9.5, color: skin.mutedSoft);
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
      decoration: BoxDecoration(
        color: skin.soft.withValues(alpha: 0.42),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: skin.edge),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          LayoutBuilder(
            builder: (context, constraints) {
              if (constraints.maxWidth < 430) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    titleRow,
                    const SizedBox(height: 6),
                    Align(alignment: Alignment.centerRight, child: actions),
                  ],
                );
              }
              return Row(
                children: [
                  Expanded(child: titleRow),
                  const SizedBox(width: 8),
                  actions,
                ],
              );
            },
          ),
          if (profile.description.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(
              profile.description,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10.5, height: 1.45, color: skin.muted),
            ),
          ],
          const SizedBox(height: 6),
          _ProfileFact(
            icon: Icons.widgets_outlined,
            text: s.subagentsProfileMeta(
              profile.toolCount,
              profile.workspace,
              profile.lane,
            ),
            style: factStyle,
          ),
          const SizedBox(height: 2),
          Wrap(
            spacing: 12,
            runSpacing: 2,
            children: [
              _ProfileFact(
                icon: Icons.folder_outlined,
                text: '${profile.workdir} / ${profile.shell}',
                style: factStyle,
              ),
              _ProfileFact(
                icon: Icons.tune_rounded,
                text:
                    '${profile.reasoningEffort} · '
                    '${formatCompact(profile.contextLimit)} tokens · '
                    'compact ${profile.compactAt}',
                style: factStyle,
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(height: 1, color: skin.edge),
          const SizedBox(height: 7),
          _ProfileChipLine(
            key: ValueKey('subagents-profile-skills-${profile.id}'),
            s: s,
            skin: skin,
            label: s.subagentsProfileSkills,
            items: profile.skills,
            tone: skin.primary,
            moreKey: ValueKey('subagents-profile-more-skills-${profile.id}'),
          ),
          const SizedBox(height: 5),
          _ProfileChipLine(
            key: ValueKey('subagents-profile-mcp-${profile.id}'),
            s: s,
            skin: skin,
            label: s.subagentsProfileMcp,
            items: profile.mcpServers,
            tone: skin.primary,
            moreKey: ValueKey('subagents-profile-more-mcp-${profile.id}'),
          ),
          const SizedBox(height: 5),
          if (locked) ...[
            _ProfileChipLine(
              key: ValueKey('subagents-profile-missing-${profile.id}'),
              s: s,
              skin: skin,
              label: s.subagentsProfileMissing,
              items: profile.missing,
              tone: IrmiaTheme.warn,
              warn: true,
              moreKey: ValueKey('subagents-profile-more-missing-${profile.id}'),
            ),
            const SizedBox(height: 5),
            _ProfileStatusHint(
              tone: IrmiaTheme.warn,
              icon: Icons.lock_outline_rounded,
              text: s.subagentsProfileLockedHint,
            ),
          ] else
            _ProfileStatusHint(
              tone: IrmiaTheme.ok,
              icon: Icons.check_circle_outline_rounded,
              text: s.subagentsProfileAvailableHint,
            ),
        ],
      ),
    );
  }
}

Widget _profileActionButton(
  BuildContext context, {
  required Key key,
  required IconData icon,
  required String label,
  required VoidCallback? onPressed,
  bool primary = false,
}) {
  const size = Size(0, 28);
  const padding = EdgeInsets.symmetric(horizontal: 8);
  // 按钮文字不在这里写 textStyle：ButtonStyle.textStyle 不与环境 DefaultTextStyle
  // 合并，写死就等于丢掉主题字体栈（button_typography_test 钉着这一条）。
  const shape = RoundedRectangleBorder(
    borderRadius: BorderRadius.all(Radius.circular(8)),
  );
  final iconWidget = Icon(icon, size: 14);
  final labelWidget = Text(label);
  if (primary) {
    return FilledButton.icon(
      key: key,
      onPressed: onPressed,
      icon: iconWidget,
      label: labelWidget,
      style: FilledButton.styleFrom(
        minimumSize: size,
        padding: padding,
        visualDensity: VisualDensity.compact,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: shape,
      ),
    );
  }
  return TextButton.icon(
    key: key,
    onPressed: onPressed,
    icon: iconWidget,
    label: labelWidget,
    style: TextButton.styleFrom(
      minimumSize: size,
      padding: padding,
      visualDensity: VisualDensity.compact,
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      foregroundColor: MoodPanelSkin.of(context).muted,
      shape: shape,
    ),
  );
}

class _ProfileStatusBadge extends StatelessWidget {
  const _ProfileStatusBadge({required this.s, required this.locked});

  final AppStrings s;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final tone = locked ? IrmiaTheme.warn : IrmiaTheme.ok;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2.5),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: tone.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            locked
                ? Icons.lock_outline_rounded
                : Icons.check_circle_outline_rounded,
            size: 10,
            color: tone,
          ),
          const SizedBox(width: 3),
          Text(
            locked ? s.subagentsProfileLocked : s.subagentsProfileAvailable,
            maxLines: 1,
            style: TextStyle(
              fontSize: 9,
              fontWeight: FontWeight.w700,
              color: tone,
            ),
          ),
        ],
      ),
    );
  }
}

class _ProfileStatusHint extends StatelessWidget {
  const _ProfileStatusHint({
    required this.tone,
    required this.icon,
    required this.text,
  });

  final Color tone;
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 11, color: tone),
        const SizedBox(width: 5),
        Expanded(
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 9.5, height: 1.4, color: tone),
          ),
        ),
      ],
    );
  }
}

/// 详情里的一行事实：图标 + 一段单行文本（meta / workdir / reasoning 共用）。
class _ProfileFact extends StatelessWidget {
  const _ProfileFact({
    required this.icon,
    required this.text,
    required this.style,
  });

  final IconData icon;
  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 10, color: style.color),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: style,
          ),
        ),
      ],
    );
  }
}

/// 单行 chip 行：默认只占一行，放不下的尾巴折成「+N」；点开换成可换行的完整列表。
///
/// 为什么自己量宽度：`Wrap` 只管换行不管行数，`Row` 又会在放不下时溢出。这里用
/// 与 chip 完全相同的 TextStyle 量出每个 chip 的宽度（文本宽 + 12 内边距 + 2 描边），
/// 贪心选能放下的前缀，剩下的收进可点的「+N」chip，这样任何窗口宽度下都只有一行。
class _ProfileChipLine extends StatefulWidget {
  const _ProfileChipLine({
    super.key,
    required this.s,
    required this.skin,
    required this.label,
    required this.items,
    required this.tone,
    this.moreKey,
    this.warn = false,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String label;
  final List<String> items;
  final Color tone;
  final Key? moreKey;
  final bool warn;

  @override
  State<_ProfileChipLine> createState() => _ProfileChipLineState();
}

class _ProfileChipLineState extends State<_ProfileChipLine> {
  static const double _chipHorizontal = 14; // 6 * 2 内边距 + 1 * 2 描边
  static const double _chipGap = 5;
  static const double _safety = 2;

  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final skin = widget.skin;
    final items = widget.items;
    final labelStyle = TextStyle(
      fontSize: 9,
      fontWeight: FontWeight.w700,
      letterSpacing: 0.2,
      color: widget.warn ? IrmiaTheme.warn : skin.muted,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Flexible(
              child: Text(
                widget.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: labelStyle,
              ),
            ),
            const SizedBox(width: 5),
            Text(
              '${items.length}',
              style: TextStyle(
                fontSize: 9,
                fontWeight: FontWeight.w700,
                color: skin.mutedSoft,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            const Spacer(),
            if (_expanded && items.length > 1)
              GestureDetector(
                onTap: () => setState(() => _expanded = false),
                behavior: HitTestBehavior.opaque,
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 2,
                    vertical: 1,
                  ),
                  child: Text(
                    widget.s.subagentsProfileCollapse,
                    style: TextStyle(fontSize: 9, color: skin.primary),
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 3),
        if (items.isEmpty)
          Text('—', style: TextStyle(fontSize: 9, color: skin.mutedSoft))
        else
          LayoutBuilder(
            builder: (context, constraints) {
              final style = _chipStyle(context);
              if (_expanded) {
                return Wrap(
                  spacing: _chipGap,
                  runSpacing: 4,
                  children: [
                    for (final item in items)
                      ConstrainedBox(
                        constraints: BoxConstraints(
                          maxWidth: constraints.maxWidth,
                        ),
                        child: _chip(item, style),
                      ),
                  ],
                );
              }
              return _collapsedLine(context, constraints.maxWidth, style);
            },
          ),
      ],
    );
  }

  Widget _collapsedLine(
    BuildContext context,
    double maxWidth,
    TextStyle style,
  ) {
    final items = widget.items;
    final widths = <double>[
      for (final item in items)
        _measure(context, style, item) + _chipHorizontal,
    ];
    final all = _sumWidths(widths);
    if (all <= maxWidth - _safety) {
      return Row(
        children: [
          for (var index = 0; index < items.length; index += 1) ...[
            if (index > 0) const SizedBox(width: _chipGap),
            _chip(items[index], style),
          ],
        ],
      );
    }
    // 从「尽量多显示」往回收，第一个放得下的前缀就是结果。
    var shown = 0;
    var moreText = widget.s.subagentsProfileMore(items.length);
    for (var candidate = items.length - 1; candidate >= 0; candidate -= 1) {
      final hidden = items.length - candidate;
      final text = widget.s.subagentsProfileMore(hidden);
      var used = _measure(context, style, text) + _chipHorizontal;
      if (candidate > 0) {
        used += _sumWidths(widths.take(candidate).toList(growable: false));
        used += _chipGap;
      }
      if (used <= maxWidth - _safety) {
        shown = candidate;
        moreText = text;
        break;
      }
    }
    return Row(
      children: [
        for (var index = 0; index < shown; index += 1) ...[
          if (index > 0) const SizedBox(width: _chipGap),
          _chip(items[index], style),
        ],
        if (shown > 0) const SizedBox(width: _chipGap),
        _chip(
          moreText,
          style,
          key: widget.moreKey,
          onTap: () => setState(() => _expanded = true),
        ),
      ],
    );
  }

  double _sumWidths(List<double> widths) {
    if (widths.isEmpty) return 0;
    return widths.fold<double>(0, (sum, width) => sum + width) +
        _chipGap * (widths.length - 1);
  }

  TextStyle _chipStyle(BuildContext context) {
    return DefaultTextStyle.of(context).style.merge(
      TextStyle(
        fontSize: 9,
        height: 1.2,
        fontWeight: FontWeight.w500,
        color: widget.tone,
      ),
    );
  }

  double _measure(BuildContext context, TextStyle style, String text) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }

  Widget _chip(String text, TextStyle style, {Key? key, VoidCallback? onTap}) {
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2.5),
      decoration: BoxDecoration(
        color: widget.tone.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: widget.tone.withValues(alpha: 0.32)),
      ),
      child: Text(
        text,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      ),
    );
    if (onTap == null) return chip;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        key: key,
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: chip,
      ),
    );
  }
}

// ───────────────────────────── 会话列表 ─────────────────────────────

class _ArchiveTabs extends StatelessWidget {
  const _ArchiveTabs({
    required this.s,
    required this.skin,
    required this.showArchived,
    required this.activeCount,
    required this.archivedCount,
    required this.onChanged,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final bool showArchived;
  final int activeCount;
  final int archivedCount;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _tab(
          key: const ValueKey('subagents-tab-active'),
          label: s.subagentsActiveTab,
          count: activeCount,
          selected: !showArchived,
          onTap: () => onChanged(false),
        ),
        const SizedBox(width: 6),
        _tab(
          key: const ValueKey('subagents-tab-archived'),
          label: s.subagentsArchivedTab,
          count: archivedCount,
          selected: showArchived,
          onTap: () => onChanged(true),
        ),
      ],
    );
  }

  Widget _tab({
    required Key key,
    required String label,
    required int count,
    required bool selected,
    required VoidCallback onTap,
  }) {
    return Expanded(
      child: Material(
        key: key,
        color: selected ? skin.primary : skin.tabBg,
        borderRadius: BorderRadius.circular(9),
        child: InkWell(
          borderRadius: BorderRadius.circular(9),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Flexible(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                      color: selected ? Colors.white : skin.mutedSoft,
                    ),
                  ),
                ),
                const SizedBox(width: 5),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 5,
                    vertical: 1,
                  ),
                  decoration: BoxDecoration(
                    color: selected
                        ? Colors.white.withValues(alpha: 0.22)
                        : skin.card,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    '$count',
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w700,
                      color: selected ? Colors.white : skin.muted,
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

class _SessionList extends StatelessWidget {
  const _SessionList({
    required this.s,
    required this.skin,
    required this.items,
    required this.selectedId,
    required this.fill,
    required this.onSelect,
    required this.onMessage,
    required this.onCancel,
    required this.onResume,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final List<SubagentSummary> items;
  final String? selectedId;
  final bool fill;
  final ValueChanged<SubagentSummary> onSelect;
  final ValueChanged<SubagentSummary> onMessage;
  final ValueChanged<SubagentSummary> onCancel;
  final ValueChanged<SubagentSummary> onResume;

  @override
  Widget build(BuildContext context) {
    final list = ListView.separated(
      shrinkWrap: !fill,
      physics: fill ? null : const NeverScrollableScrollPhysics(),
      padding: EdgeInsets.zero,
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 8),
      itemBuilder: (context, index) {
        final item = items[index];
        return _SessionRow(
          key: ValueKey('subagent-row-${item.agentId}'),
          s: s,
          skin: skin,
          item: item,
          selected: selectedId == item.agentId,
          onSelect: () => onSelect(item),
          onMessage: () => onMessage(item),
          onCancel: () => onCancel(item),
          onResume: () => onResume(item),
        );
      },
    );
    if (fill) return Expanded(child: list);
    return list;
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    super.key,
    required this.s,
    required this.skin,
    required this.item,
    required this.selected,
    required this.onSelect,
    required this.onMessage,
    required this.onCancel,
    required this.onResume,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentSummary item;
  final bool selected;
  final VoidCallback onSelect;
  final VoidCallback onMessage;
  final VoidCallback onCancel;
  final VoidCallback onResume;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final canMessage = item.status != 'cancelled' && item.status != 'archived';
    return Material(
      color: selected ? skin.soft : skin.chipBg,
      borderRadius: BorderRadius.circular(13),
      child: InkWell(
        borderRadius: BorderRadius.circular(13),
        onTap: onSelect,
        child: Container(
          padding: const EdgeInsets.fromLTRB(11, 9, 8, 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(13),
            border: Border.all(
              color: selected ? skin.primary.withValues(alpha: 0.5) : skin.edge,
            ),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      item.profileLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: skin.title,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  _StatusChip(s: s, skin: skin, status: item.status),
                  const Spacer(),
                  Text(
                    _shortId(item.agentId),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 9,
                      color: skin.mutedSoft,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 5),
              Text(
                item.lastReportPreview ?? s.subagentsNoReport,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 10.8,
                  height: 1.45,
                  color: item.lastReportPreview == null
                      ? skin.mutedSoft
                      : skin.muted,
                ),
              ),
              const SizedBox(height: 7),
              Row(
                children: [
                  _MiniText(
                    icon: Icons.token_outlined,
                    text:
                        '${formatCompact(item.tokensUsed)} / ${formatCompact(item.tokensLimit)}',
                    color: skin.mutedSoft,
                  ),
                  const SizedBox(width: 9),
                  Expanded(
                    child: _MiniText(
                      icon: Icons.schedule_rounded,
                      text: _shortTime(item.updatedAt),
                      color: skin.mutedSoft,
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (canMessage)
                    _RowIconAction(
                      key: ValueKey('subagent-message-action-${item.agentId}'),
                      icon: Icons.chat_bubble_outline_rounded,
                      tooltip: s.subagentsField('message'),
                      color: skin.primary,
                      onTap: onMessage,
                    ),
                  if (item.canCancel)
                    _RowIconAction(
                      key: ValueKey('subagent-cancel-${item.agentId}'),
                      icon: Icons.stop_circle_outlined,
                      tooltip: s.cancel,
                      color: IrmiaTheme.danger,
                      onTap: onCancel,
                    ),
                  if (item.canResume)
                    _RowIconAction(
                      key: ValueKey('subagent-resume-${item.agentId}'),
                      icon: Icons.play_circle_outline_rounded,
                      tooltip: s.subagentsResume,
                      color: moodStatusColor('completed', scheme),
                      onTap: onResume,
                    ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _RowIconAction extends StatelessWidget {
  const _RowIconAction({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.color,
    required this.onTap,
  });

  final IconData icon;
  final String tooltip;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkResponse(
        onTap: onTap,
        radius: 15,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
          child: Icon(icon, size: 16, color: color),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({
    required this.s,
    required this.skin,
    required this.status,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = moodStatusColor(status, scheme);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: tone.withValues(alpha: 0.25)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 5,
            height: 5,
            decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
          ),
          const SizedBox(width: 4),
          Text(
            s.subagentsStatus(status),
            style: TextStyle(fontSize: 9, height: 1.35, color: tone),
          ),
        ],
      ),
    );
  }
}

class _CountPill extends StatelessWidget {
  const _CountPill({
    required this.label,
    required this.count,
    required this.skin,
  });

  final String label;
  final int count;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: TextStyle(fontSize: 10, color: skin.mutedSoft)),
        const SizedBox(width: 4),
        Text(
          '$count',
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w700,
            color: skin.primary,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
      ],
    );
  }
}

class _MiniText extends StatelessWidget {
  const _MiniText({
    required this.icon,
    required this.text,
    required this.color,
  });

  final IconData icon;
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        style: TextStyle(fontSize: 9.5, color: color),
        children: [
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Icon(icon, size: 11, color: color),
          ),
          const TextSpan(text: ' '),
          TextSpan(text: text),
        ],
      ),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }
}

// ───────────────────────────── 详情 ─────────────────────────────

class _DetailActions extends StatelessWidget {
  const _DetailActions({
    required this.s,
    required this.skin,
    required this.item,
    required this.acting,
    required this.onCancel,
    required this.onResume,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentSummary item;
  final bool acting;
  final VoidCallback onCancel;
  final VoidCallback onResume;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      alignment: WrapAlignment.end,
      crossAxisAlignment: WrapCrossAlignment.center,
      spacing: 6,
      runSpacing: 4,
      children: [
        if (item.canCancel)
          TextButton.icon(
            key: const ValueKey('subagent-cancel-confirm'),
            onPressed: acting ? null : onCancel,
            icon: const Icon(Icons.stop_circle_outlined, size: 15),
            label: Text(s.cancel),
            style: TextButton.styleFrom(
              foregroundColor: IrmiaTheme.danger,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(0, 30),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
        if (item.canResume)
          TextButton.icon(
            key: const ValueKey('subagent-resume-confirm'),
            onPressed: acting ? null : onResume,
            icon: const Icon(Icons.play_circle_outline_rounded, size: 15),
            label: Text(s.subagentsResume),
            style: TextButton.styleFrom(
              foregroundColor: skin.primary,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              minimumSize: const Size(0, 30),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
      ],
    );
  }
}

class _DetailHead extends StatelessWidget {
  const _DetailHead({required this.s, required this.skin, required this.item});

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentSummary item;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      item.profileLabel,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                        color: skin.heading,
                      ),
                    ),
                  ),
                  const SizedBox(width: 7),
                  _StatusChip(s: s, skin: skin, status: item.status),
                ],
              ),
              const SizedBox(height: 3),
              Text(
                _shortId(item.agentId),
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 10,
                  color: skin.mutedSoft,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _DetailMeta extends StatelessWidget {
  const _DetailMeta({required this.s, required this.skin, required this.item});

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentSummary item;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 7, 10, 7),
      decoration: BoxDecoration(
        color: skin.chipBg,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: skin.chipBorder),
      ),
      child: Column(
        children: [
          _MetaRow(label: s.subagentsField('agentId'), value: item.agentId),
          _MetaRow(
            label: s.subagentsField('parentTurn'),
            value: '${item.parentTurn}',
          ),
          _MetaRow(
            label: s.subagentsField('createdAt'),
            value: _shortTime(item.createdAt),
          ),
          _MetaRow(
            label: s.subagentsField('updatedAt'),
            value: _shortTime(item.updatedAt),
          ),
          _MetaRow(
            label: s.subagentsField('tokens'),
            value:
                '${formatCompact(item.tokensUsed)} / ${formatCompact(item.tokensLimit)}',
          ),
        ],
      ),
    );
  }
}

class _MetaRow extends StatelessWidget {
  const _MetaRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2.5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 76,
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10, color: scheme.onSurfaceVariant),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 10,
                height: 1.45,
                color: scheme.onSurface,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ReportBlock extends StatelessWidget {
  const _ReportBlock({
    required this.s,
    required this.skin,
    required this.report,
    required this.loading,
    required this.error,
    required this.onRetry,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String? report;
  final bool loading;
  final String? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Subhead(
          icon: Icons.description_outlined,
          text: s.subagentsReportTitle,
          skin: skin,
        ),
        const SizedBox(height: 6),
        if (loading)
          _SkeletonLines(skin: skin, lines: 2)
        else if (error != null)
          _InlineError(
            s: s,
            skin: skin,
            message: s.subagentsDetailLoadFailed(error!),
            onRetry: onRetry,
          )
        else
          Container(
            key: const ValueKey('subagent-last-report'),
            padding: const EdgeInsets.fromLTRB(11, 9, 11, 9),
            decoration: BoxDecoration(
              color: skin.chipBg,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: skin.chipBorder),
            ),
            child: Text(
              report ?? s.subagentsNoReport,
              maxLines: 10,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                height: 1.65,
                color: report == null ? skin.mutedSoft : skin.ink,
              ),
            ),
          ),
      ],
    );
  }
}

class _TimelineBlock extends StatelessWidget {
  const _TimelineBlock({
    required this.s,
    required this.skin,
    required this.events,
    required this.loading,
    required this.error,
    required this.onRetry,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final List<SubagentEvent> events;
  final bool loading;
  final String? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _Subhead(
          icon: Icons.timeline_rounded,
          text: s.subagentsTimelineTitle,
          skin: skin,
        ),
        const SizedBox(height: 6),
        if (loading)
          _SkeletonLines(skin: skin, lines: 2)
        else if (error != null && events.isEmpty)
          _InlineError(
            s: s,
            skin: skin,
            message: s.subagentsTimelineLoadFailed(error!),
            onRetry: onRetry,
          )
        else if (events.isEmpty)
          Text(
            s.subagentsTimelineEmpty,
            style: TextStyle(fontSize: 11, height: 1.5, color: skin.mutedSoft),
          )
        else
          Container(
            key: const ValueKey('subagent-timeline'),
            decoration: BoxDecoration(
              color: skin.chipBg,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: skin.chipBorder),
            ),
            child: Column(
              children: [
                for (var i = 0; i < events.length; i += 1)
                  _TimelineRow(
                    s: s,
                    skin: skin,
                    event: events[i],
                    first: i == 0,
                    last: i == events.length - 1,
                  ),
              ],
            ),
          ),
        if (error != null && events.isNotEmpty) ...[
          const SizedBox(height: 6),
          _InlineError(
            s: s,
            skin: skin,
            message: s.subagentsTimelineLoadFailed(error!),
            onRetry: onRetry,
          ),
        ],
      ],
    );
  }
}

class _TimelineRow extends StatelessWidget {
  const _TimelineRow({
    required this.s,
    required this.skin,
    required this.event,
    required this.first,
    required this.last,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final SubagentEvent event;
  final bool first;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = _eventTone(event.type, scheme);
    final summary = event.data['summary']?.toString().trim();
    final status = event.data['status']?.toString();
    final reason = event.data['reason']?.toString();
    final kind = event.data['kind']?.toString();
    final meta = <Widget>[];
    if (event.type == 'started') {
      final profile = event.data['profileId']?.toString();
      if (profile != null && profile.isNotEmpty) meta.add(_metaChip(profile));
    }
    if (event.type == 'report' && kind != null && kind.isNotEmpty) {
      meta.add(_metaChip(s.subagentsReason(kind)));
    }
    if (event.type == 'finished' && status != null && status.isNotEmpty) {
      meta.add(_metaChip(s.subagentsStatus(status)));
    }
    if ((event.type == 'interrupted' || event.type == 'cancelled') &&
        reason != null &&
        reason.isNotEmpty) {
      meta.add(_metaChip(s.subagentsReason(reason)));
    }
    if (event.type == 'resumed') {
      final count = event.data['resumeCount'];
      if (count is num) meta.add(_metaChip('#${count.toInt()}'));
    }
    if (event.type == 'wake' && status != null && status.isNotEmpty) {
      meta.add(_metaChip(s.subagentsStatus(status)));
    }

    return Padding(
      padding: EdgeInsets.fromLTRB(10, first ? 9 : 6, 10, last ? 9 : 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: tone, shape: BoxShape.circle),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.subagentsEventTitle(event.type),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: skin.title,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      _shortTime(event.ts),
                      style: TextStyle(fontSize: 9, color: skin.mutedSoft),
                    ),
                  ],
                ),
                if (summary != null && summary.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    summary,
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10,
                      height: 1.5,
                      color: skin.muted,
                    ),
                  ),
                ],
                if (meta.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Wrap(spacing: 4, runSpacing: 3, children: meta),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _metaChip(String text) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
    decoration: BoxDecoration(
      color: skin.card,
      borderRadius: BorderRadius.circular(999),
      border: Border.all(color: skin.chipBorder),
    ),
    child: Text(text, style: TextStyle(fontSize: 8.5, color: skin.muted)),
  );

  Color _eventTone(String type, ColorScheme scheme) => switch (type) {
    'started' => IrmiaTheme.ok,
    'report' || 'wake' => scheme.primary,
    'finished' => scheme.primary,
    'interrupted' || 'cancelled' => IrmiaTheme.warn,
    'resumed' => IrmiaTheme.ok,
    _ => scheme.onSurfaceVariant,
  };
}

class _Composer extends StatelessWidget {
  const _Composer({
    required this.s,
    required this.skin,
    required this.controller,
    required this.focusNode,
    required this.blocked,
    required this.sending,
    required this.onSend,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final TextEditingController controller;
  final FocusNode focusNode;
  final bool blocked;
  final bool sending;
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    if (blocked) {
      return Container(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
        decoration: BoxDecoration(
          color: skin.chipBg,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: skin.chipBorder),
        ),
        child: Row(
          children: [
            Icon(Icons.block_rounded, size: 13, color: skin.mutedSoft),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                s.subagentsMessageBlocked,
                style: TextStyle(
                  fontSize: 10,
                  height: 1.5,
                  color: skin.mutedSoft,
                ),
              ),
            ),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          key: const ValueKey('subagent-message-input'),
          controller: controller,
          focusNode: focusNode,
          enabled: !sending,
          minLines: 1,
          maxLines: 3,
          textInputAction: TextInputAction.send,
          onSubmitted: (_) => unawaited(onSend()),
          style: TextStyle(fontSize: 12, color: skin.ink),
          decoration: InputDecoration(
            hintText: s.subagentsMessageHint,
            isDense: true,
            filled: true,
            fillColor: skin.chipBg,
            contentPadding: const EdgeInsets.fromLTRB(10, 9, 10, 9),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: skin.chipBorder),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(10),
              borderSide: BorderSide(color: skin.chipBorder),
            ),
          ),
        ),
        const SizedBox(height: 7),
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton.icon(
            key: const ValueKey('subagent-message-send'),
            onPressed: sending ? null : () => unawaited(onSend()),
            icon: sending
                ? const SizedBox(
                    width: 13,
                    height: 13,
                    child: CircularProgressIndicator(
                      strokeWidth: 1.6,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.send_rounded, size: 14),
            label: Text(s.subagentsSend),
            style: FilledButton.styleFrom(
              minimumSize: const Size(0, 32),
              padding: const EdgeInsets.symmetric(horizontal: 13),
            ),
          ),
        ),
      ],
    );
  }
}

// ───────────────────────────── 空 / 错 / 骨架 ─────────────────────────────

class _FullError extends StatelessWidget {
  const _FullError({
    required this.s,
    required this.skin,
    required this.message,
    required this.onRetry,
  });

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
        key: const ValueKey('subagents-load-error'),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.error_outline_rounded,
              size: 28,
              color: IrmiaTheme.danger,
            ),
            const SizedBox(height: 10),
            Text(
              message,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 12, height: 1.6, color: skin.ink),
            ),
            const SizedBox(height: 6),
            TextButton(onPressed: onRetry, child: Text(s.retry)),
          ],
        ),
      ),
    );
  }
}

class _EmptyList extends StatelessWidget {
  const _EmptyList({
    required this.s,
    required this.skin,
    required this.archived,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final bool archived;

  @override
  Widget build(BuildContext context) {
    return Container(
      key: const ValueKey('subagents-empty'),
      padding: const EdgeInsets.fromLTRB(12, 18, 12, 18),
      decoration: BoxDecoration(
        color: skin.chipBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: skin.chipBorder),
      ),
      child: Column(
        children: [
          Icon(
            archived ? Icons.inventory_2_outlined : Icons.hub_outlined,
            size: 24,
            color: skin.mutedSoft,
          ),
          const SizedBox(height: 8),
          Text(
            archived ? s.subagentsArchivedEmptyTitle : s.subagentsEmptyTitle,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: skin.title,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            archived ? s.subagentsArchivedEmptyBody : s.subagentsEmptyBody,
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: 10.5,
              height: 1.55,
              color: skin.mutedSoft,
            ),
          ),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({
    required this.s,
    required this.skin,
    required this.message,
    required this.onRetry,
  });

  final AppStrings s;
  final MoodPanelSkin skin;
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(9, 5, 3, 5),
      decoration: BoxDecoration(
        color: IrmiaTheme.danger.withValues(alpha: 0.07),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline_rounded, size: 14, color: IrmiaTheme.danger),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              message,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10.5, height: 1.45, color: skin.ink),
            ),
          ),
          TextButton(
            onPressed: onRetry,
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 7),
              minimumSize: const Size(0, 28),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(s.retry, style: const TextStyle(fontSize: 11)),
          ),
        ],
      ),
    );
  }
}

class _RestartNote extends StatelessWidget {
  const _RestartNote({required this.s, required this.skin});

  final AppStrings s;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: IrmiaTheme.warn.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: IrmiaTheme.warn.withValues(alpha: 0.25)),
      ),
      child: Row(
        children: [
          Icon(Icons.restart_alt_rounded, size: 13, color: IrmiaTheme.warn),
          const SizedBox(width: 5),
          Expanded(
            child: Text(
              s.subagentsRestartNote,
              style: TextStyle(fontSize: 9.5, height: 1.4, color: skin.ink),
            ),
          ),
        ],
      ),
    );
  }
}

class _Subhead extends StatelessWidget {
  const _Subhead({required this.icon, required this.text, required this.skin});

  final IconData icon;
  final String text;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Icon(icon, size: 13, color: skin.primary),
        const SizedBox(width: 5),
        Text(
          text,
          style: TextStyle(
            fontSize: 11.5,
            fontWeight: FontWeight.w700,
            color: skin.title,
          ),
        ),
      ],
    );
  }
}

class _CodeNote extends StatelessWidget {
  const _CodeNote({required this.text, required this.skin, required this.tone});

  final String text;
  final MoodPanelSkin skin;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: tone.withValues(alpha: 0.25)),
      ),
      child: Text(
        text,
        style: TextStyle(
          fontFamily: 'monospace',
          fontSize: 9.5,
          color: skin.ink,
        ),
      ),
    );
  }
}

class _SkeletonLines extends StatelessWidget {
  const _SkeletonLines({required this.skin, required this.lines});

  final MoodPanelSkin skin;
  final int lines;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < lines; i += 1)
          Padding(
            padding: EdgeInsets.only(bottom: i == lines - 1 ? 0 : 7),
            child: FractionallySizedBox(
              alignment: Alignment.centerLeft,
              widthFactor: i.isEven ? 0.92 : 0.68,
              child: Container(
                height: 10,
                decoration: BoxDecoration(
                  color: skin.track,
                  borderRadius: BorderRadius.circular(5),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _SubagentsSkeleton extends StatelessWidget {
  const _SubagentsSkeleton({required this.skin});

  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 1000;
        Widget block(double? height) => SizedBox(
          height: height,
          child: Container(
            decoration: BoxDecoration(
              color: skin.card,
              borderRadius: BorderRadius.circular(MoodPalette.radius),
              border: Border.all(color: skin.edge),
            ),
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 120,
                  height: 12,
                  decoration: BoxDecoration(
                    color: skin.track,
                    borderRadius: BorderRadius.circular(6),
                  ),
                ),
                const SizedBox(height: 12),
                for (var i = 0; i < 3; i += 1) ...[
                  FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: i == 1 ? 0.55 : 0.86,
                    child: Container(
                      height: 9,
                      decoration: BoxDecoration(
                        color: skin.track,
                        borderRadius: BorderRadius.circular(5),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
              ],
            ),
          ),
        );
        return Padding(
          key: const ValueKey('subagents-skeleton'),
          padding: const EdgeInsets.fromLTRB(26, 14, 26, 14),
          child: Column(
            children: [
              block(118),
              const SizedBox(height: 14),
              if (wide)
                Expanded(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(flex: 43, child: block(null)),
                      const SizedBox(width: 16),
                      Expanded(flex: 57, child: block(null)),
                    ],
                  ),
                )
              else
                Expanded(child: block(null)),
            ],
          ),
        );
      },
    );
  }
}

// ───────────────────────────── 格式化 ─────────────────────────────

String _shortId(String id) {
  if (id.length <= 14) return id;
  return '${id.substring(0, 12)}\u2026';
}

String _shortTime(String raw) {
  final dt = DateTime.tryParse(raw)?.toLocal();
  if (dt == null) return '—';
  String two(int value) => value.toString().padLeft(2, '0');
  return '${dt.year}-${two(dt.month)}-${two(dt.day)} ${two(dt.hour)}:${two(dt.minute)}';
}
