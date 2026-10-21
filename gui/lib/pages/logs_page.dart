// TODO(i18n): 本文件还有 5 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/logs_page.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../app.dart';
import '../format.dart';
import '../theme.dart';
import 'page_chrome.dart';

part 'logs_format.dart';
part 'logs_ops.dart';
part 'logs_panels.dart';
part 'logs_rows.dart';
part 'logs_widgets.dart';

/// 日志页 —— 三个 tab：概览 / 事件 / 追踪（与 web/pages/logs.js 同构）。
/// 告警落盘与 doctor 自检并入概览的折叠区（docs/astrbot-benchmark.md §3.4：tab 最多三个）。
/// 数据源：/api/budget · /api/events · /api/alarms · /api/doctor · /api/replay
class LogsPage extends StatefulWidget {
  const LogsPage({super.key, required this.state});
  final AppState state;
  @override
  State<LogsPage> createState() => _LogsPageState();
}

class _LogsPageState extends State<LogsPage> {
  static const _tabs = ['概览', '事件', '追踪'];

  int tab = 0;

  Map<String, dynamic>? budget;
  String budgetRange = 'today';
  bool budgetLoading = true;
  String? budgetError;

  final events = <Map<String, dynamic>>[];
  final picked = <String>{};
  int evLimit = 200;
  int? evCursor;
  int? openSeq;
  bool evLoading = false;
  String? evError;
  /// 事件列表行数收口：默认 8 行，其余点「查看全部」（§3.4）
  bool evAll = false;
  /// 过滤连点会有多个在飞请求：只认最后一次，别让早到的响应覆盖新的
  int evEpoch = 0;

  Map<String, dynamic>? alarms;
  Map<String, dynamic>? alarmCur;
  bool alarmsLoading = false;
  bool curLoading = false;
  String? alarmsError;
  String? curError;

  Map<String, dynamic>? doctor;
  bool doctorLoading = false;
  String? doctorError;

  final turnCtl = TextEditingController();
  final stepCtl = TextEditingController();
  Map<String, dynamic>? replay;
  bool replayLoading = false;
  String? replayError;
  bool showRawJson = false;

  @override
  void initState() {
    super.initState();
    unawaited(loadBudget());
  }

  @override
  void dispose() {
    turnCtl.dispose();
    stepCtl.dispose();
    super.dispose();
  }

  // ─── 取数 ───

  Future<Map<String, dynamic>?> _getJson(String path) async {
    final data = await widget.state.api.get(path);
    return data is Map ? data.cast<String, dynamic>() : null;
  }

  Future<void> loadBudget() async {
    setState(() => budgetLoading = true);
    try {
      final data = await _getJson('/api/budget?range=$budgetRange');
      if (!mounted) return;
      setState(() {
        budget = data;
        budgetError = null;
        budgetLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        budgetError = '$err';
        budgetLoading = false;
      });
    }
  }

  Future<void> loadEvents({bool reset = false, int? fromSeq}) async {
    final epoch = ++evEpoch;
    if (reset) setState(() => evLoading = true);
    final query = <String>['limit=$evLimit'];
    if (picked.isNotEmpty) query.add('types=${Uri.encodeQueryComponent(picked.join(','))}');
    if (fromSeq != null) query.add('from_seq=$fromSeq');
    try {
      final payload = await _getJson('/api/events?${query.join('&')}') ?? const <String, dynamic>{};
      if (!mounted || epoch != evEpoch) return;
      final incoming = _maps(payload['events']);
      setState(() {
        if (reset) {
          events.clear();
          openSeq = null;
          evAll = false;
        }
        final seen = events.map((e) => _int(e['seq'])).toSet();
        for (final ev in incoming) {
          if (seen.add(_int(ev['seq']))) events.add(ev);
        }
        events.sort((a, b) => _int(a['seq']).compareTo(_int(b['seq'])));
        final next = payload['nextBeforeSeq'];
        evCursor = next is num ? next.toInt() : null;
        evError = null;
        evLoading = false;
      });
    } catch (err) {
      if (!mounted || epoch != evEpoch) return;
      setState(() {
        evError = '$err';
        evLoading = false;
      });
    }
  }

  Future<void> loadAlarms() async {
    setState(() => alarmsLoading = true);
    try {
      final data = await _getJson('/api/alarms');
      if (!mounted) return;
      setState(() {
        alarms = data;
        alarmsError = null;
        alarmsLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        alarmsError = '$err';
        alarmsLoading = false;
      });
    }
  }

  Future<void> selectAlarm(String name) async {
    setState(() {
      alarmCur = {'name': name};
      curLoading = true;
      curError = null;
    });
    try {
      final data = await _getJson('/api/alarms?file=${Uri.encodeQueryComponent(name)}');
      if (!mounted) return;
      setState(() {
        alarmCur = data;
        curLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        curError = '$err';
        curLoading = false;
      });
    }
  }

  Future<void> loadDoctor() async {
    setState(() {
      doctorLoading = true;
      doctorError = null;
    });
    try {
      final data = await _getJson('/api/doctor');
      if (!mounted) return;
      setState(() {
        doctor = data;
        doctorLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        doctorError = '$err';
        doctorLoading = false;
      });
    }
  }

  Future<void> runReplay(int turn, int step) async {
    turnCtl.text = '$turn';
    stepCtl.text = '$step';
    setState(() {
      replay = null;
      replayError = null;
      replayLoading = true;
    });
    try {
      final data = await _getJson('/api/replay?turn=$turn&step=$step');
      if (!mounted) return;
      setState(() {
        replay = data;
        replayLoading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        replayError = '$err';
        replayLoading = false;
      });
    }
  }

  // ─── 交互 ───

  /// setState 是 protected 成员：extension 里的状态改动统一走这个入口
  void apply(VoidCallback mutate) => setState(mutate);

  void switchTab(int next) {
    if (next == tab) return;
    setState(() => tab = next);
    if (next == 0) {
      if (budget == null && budgetError == null) unawaited(loadBudget());
      // 告警与自检同属概览：切进来时一并补齐
      if (alarms == null && alarmsError == null) unawaited(loadAlarms());
      if (doctor == null && !doctorLoading && doctorError == null) unawaited(loadDoctor());
    }
    if (next == 1 && events.isEmpty && evError == null) unawaited(loadEvents(reset: true));
  }

  void toggleType(String type) {
    setState(() {
      if (!picked.add(type)) picked.remove(type);
    });
    unawaited(loadEvents(reset: true));
  }

  void clearTypes() {
    setState(picked.clear);
    unawaited(loadEvents(reset: true));
  }

  /// 从 turn 明细跳到事件页：只看这一段的账（与 Web 的 open-turn 同一动作）
  void openTurnFromStats() {
    setState(() {
      picked
        ..clear()
        ..addAll(const ['budget/consumed', 'turn/end']);
      tab = 1;
    });
    unawaited(loadEvents(reset: true));
  }

  void replayFromInput() {
    final turn = int.tryParse(turnCtl.text.trim());
    final step = int.tryParse(stepCtl.text.trim());
    if (turn == null || step == null || turn < 0 || step < 0) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('请先填写 turn 与 step（数字）')));
      return;
    }
    unawaited(runReplay(turn, step));
  }

  void replayFromLast() {
    Map<String, dynamic>? last;
    for (final ev in events.reversed) {
      final data = ev['data'];
      if (data is Map && data['turn'] is num && data['step'] is num) {
        last = ev;
        break;
      }
    }
    if (last == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('暂无带 turn/step 的事件')));
      return;
    }
    final data = _map(last['data']);
    unawaited(runReplay(_int(data['turn']), _int(data['step'])));
  }

  // ─── 骨架 ───

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        PageHeader(
          title: '日志',
          subtitle: '用量、事件日志、告警落盘与请求体重建',
          bottom: _TabBar(labels: _tabs, index: tab, onPick: switchTab),
        ),
        Expanded(
          child: switch (tab) {
            0 => overviewTab(context),
            1 => eventsTab(context),
            _ => traceTab(context),
          },
        ),
      ],
    );
  }
}
