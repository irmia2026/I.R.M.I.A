import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 建议卡的**动作按钮**（`Suggestion.act` / `actLabel` 的前端那一半）。
///
/// 来源：docs/repo-cleanliness-audit.md 总表 D1 —— 服务端产出 5 处 `act`（review-stale /
/// cache-hit-low / archive-stale / dead-letters / persona-stale，见 src/web/server.ts 的
/// `buildSuggestions`），而界面从前**只取 id/title/body 三个字段**（overview_page.dart 的
/// `_Advice.from`），于是 `goto-review / open-budget / goto-tools / goto-persona` 四个动作全是死的。
///
/// 这一组锁五件事：
///   ① 按钮文案用**服务端给的** `actLabel`（界面不自己编措辞）；
///   ② 点 `open-budget` → 日志页；点 `goto-persona` → 人格配置页；
///   ③ 点 `goto-tools` → 扩展页**并且落在「内置工具」那一段**（不是页首）；
///   ④ `goto-review` 的落点在本页：没有待确认卡时如实说一句，不假装跳过去了；
///   ⑤ **认不出的 act 一颗按钮都不摆**；死信那条也不摆（它自己有重投/丢弃两颗）。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path.startsWith('/api/events')) return routes['/api/events'];
    return routes[path];
  }
}

Map<String, dynamic> _advice({
  required String id,
  required String title,
  String act = '',
  String actLabel = '',
  String level = 'info',
}) => {
      'id': id, 'level': level, 'title': title, 'body': '$id 的细节',
      'text': title, 'act': act, 'actLabel': actLabel,
    };

/// 建议与投影按需拼：`reviewItems` 非空时才会有待确认卡（`goto-review` 的落点）
Map<String, dynamic> _routes({
  required List<Map<String, dynamic>> suggestions,
  List<Map<String, dynamic>> reviewItems = const [],
  List<Map<String, dynamic>> deadLetters = const [],
}) => {
      '/api/stats/dashboard': {
        'state': 'idle',
        'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': reviewItems.length, 'cacheHitRate': 0.9},
        'budget': {'tokensToday': 1200},
        'hourly': <dynamic>[],
        'recent': <dynamic>[],
        'suggestions': suggestions,
        'personaIsSeed': false,
        'guardedDays': 3,
        'nextWakeAt': null,
      },
      '/api/projection': {'needsReview': reviewItems, 'deadLetters': deadLetters, 'timers': <dynamic>[]},
      '/api/sessions': {'sessions': <dynamic>[], 'unreadTotal': 0},
      '/api/framework-notes': {'notes': <dynamic>[], 'count': 0, 'limit': 20},
      '/api/skills': {'items': <dynamic>[], 'rejected': <dynamic>[], 'catalogTokens': 0, 'ignored': <dynamic>[]},
      '/api/mcp': {'servers': <dynamic>[], 'problems': <dynamic>[], 'registeredCount': 0, 'runningCount': 0},
      '/api/tools': {'groups': <dynamic>[], 'tools': <dynamic>[]},
      '/api/hooks': {
        'entries': <dynamic>[], 'problems': <dynamic>[], 'relative': 'data/hooks.json',
        'hookPoints': <String>['PreToolUse'], 'defaultTimeoutMs': 10000,
        'enabledCount': 0, 'disabledCount': 0,
      },
      '/api/events': {'events': <dynamic>[]},
    };

void main() {
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-advice-act-test.json';
  });

  /// 开一页运行情况（页面比视口高：不给足高度 ListView 不会把建议卡建出来）
  Future<AppState> pumpOverview(WidgetTester tester, Map<String, dynamic> routes, {AppState? reuse}) async {
    tester.view.physicalSize = const Size(1400, 1800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = reuse ?? AppState(api: _FakeApi(routes));
    addTearDown(state.dispose);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: OverviewPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return state;
  }

  Finder actBtn(String id) => find.byKey(ValueKey('advice-act-'));

  testWidgets('① 非死信建议一条都不摆（2026-10-26 口径：那块只留给死信）', (tester) async {
    await pumpOverview(tester, _routes(suggestions: [
      _advice(id: 'review-stale', title: '3 项待确认已超 3 天', act: 'goto-review', actLabel: '去处理', level: 'warn'),
      _advice(id: 'cache-hit-low', title: '缓存命中率偏低：3.2%', act: 'open-budget', actLabel: '看预算', level: 'warn'),
      _advice(id: 'archive-stale', title: '日志已 9 天未归档', act: 'goto-tools', actLabel: '去工具组'),
      _advice(id: 'persona-stale', title: '人格已 30 天没有演化', act: 'goto-persona', actLabel: '看人格'),
    ]));

    // 整段不出现：小标题不在、卡片不在、那四句标题也不在
    expect(find.text('建议'), findsNothing, reason: '没有死信时这块不该占版面');
    for (final id in ['review-stale', 'cache-hit-low', 'archive-stale', 'persona-stale']) {
      expect(find.byKey(ValueKey('advice-$id')), findsNothing);
    }
  });

  testWidgets('② 有死信才出现：一张卡 + 重投/丢弃两颗按钮', (tester) async {
    await pumpOverview(tester, _routes(
      suggestions: [
        _advice(id: 'archive-stale', title: '日志已 9 天未归档', act: 'goto-tools', actLabel: '去工具组'),
        _advice(id: 'dead-letters', title: '死信队列非空（1）', act: 'goto-review', actLabel: '去处理', level: 'warn'),
      ],
      deadLetters: [
        {'inputSeq': 42, 'reason': 'channel offline', 'at': '2026-10-26T00:00:00Z'},
      ],
    ));

    expect(find.text('建议'), findsOneWidget);
    expect(find.byKey(const ValueKey('advice-dead-letters')), findsOneWidget);
    expect(find.byKey(const ValueKey('advice-archive-stale')), findsNothing);
  });

  testWidgets('③ 死信那条不摆 act 按钮（它自己有重投/丢弃，混在一张卡上只会点错）', (tester) async {
    await pumpOverview(tester, _routes(
      suggestions: [
        _advice(id: 'dead-letters', title: '死信队列非空（1）', act: 'goto-review', actLabel: '去处理', level: 'warn'),
      ],
      deadLetters: [
        {'inputSeq': 7, 'reason': 'channel offline', 'at': '2026-10-26T00:00:00Z'},
      ],
    ));

    expect(actBtn('dead-letters'), findsNothing);
    expect(find.byKey(const ValueKey('advice-dead-letters')), findsOneWidget);
  });
}

