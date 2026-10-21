import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
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
  Future<dynamic> get(String path) async {
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

  Finder actBtn(String id) => find.byKey(ValueKey('advice-act-$id'));

  testWidgets('① 四个动作各自摆出服务端给的按钮文案', (tester) async {
    await pumpOverview(tester, _routes(suggestions: [
      _advice(id: 'review-stale', title: '3 项待确认已超 3 天', act: 'goto-review', actLabel: '去处理', level: 'warn'),
      _advice(id: 'cache-hit-low', title: '缓存命中率偏低：3.2%', act: 'open-budget', actLabel: '看预算'),
      _advice(id: 'archive-stale', title: '日志已 9 天未归档', act: 'goto-tools', actLabel: '去工具组'),
      _advice(id: 'persona-stale', title: '人格已 30 天没有演化', act: 'goto-persona', actLabel: '看人格'),
    ]));

    expect(actBtn('review-stale'), findsOneWidget);
    expect(actBtn('cache-hit-low'), findsOneWidget);
    expect(actBtn('archive-stale'), findsOneWidget);
    expect(actBtn('persona-stale'), findsOneWidget);
    // 文案就是 actLabel 原文（界面不另编一套：同一件事在日志与卡面上得叫同一个名字）
    for (final label in ['去处理', '看预算', '去工具组', '看人格']) {
      expect(find.text(label), findsOneWidget, reason: '「$label」该原样出现在它的那张卡上');
    }
  });

  testWidgets('② open-budget → 日志页；goto-persona → 人格配置页', (tester) async {
    final state = await pumpOverview(tester, _routes(suggestions: [
      _advice(id: 'cache-hit-low', title: '缓存命中率偏低', act: 'open-budget', actLabel: '看预算'),
      _advice(id: 'persona-stale', title: '人格 30 天没动', act: 'goto-persona', actLabel: '看人格'),
    ]));
    expect(state.pageId, 'overview');

    await tester.tap(actBtn('cache-hit-low'));
    await tester.pump();
    expect(state.pageId, 'logs', reason: '预算面板在日志页的第一个 tab（概览）里');

    await tester.tap(actBtn('persona-stale'));
    await tester.pump();
    expect(state.pageId, 'persona');
  });

  testWidgets('③ goto-tools → 扩展页，且落在「内置工具」那一段（不是页首）', (tester) async {
    final routes = _routes(suggestions: [
      _advice(id: 'archive-stale', title: '日志已 9 天未归档', act: 'goto-tools', actLabel: '去工具组'),
    ]);
    final state = await pumpOverview(tester, routes);

    await tester.tap(actBtn('archive-stale'));
    await tester.pump();
    expect(state.pageId, 'extensions');

    // 真的开一页扩展页（同一个 state）：落点提示会被它取走，直接选到「内置工具」
    tester.view.physicalSize = const Size(1400, 900);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(
      find.text('随程序一起来的工具：按组开关，关掉即从她的清单里拿掉'),
      findsOneWidget,
      reason: '落点提示要生效：详情该停在「内置工具」那一项，而不是默认的「技能」',
    );
    // 取走即清：再进一次这一页时不该又跳一次（用的是左侧导航那条路）
    expect(state.takeSectionFor('extensions'), isNull);
  });

  testWidgets('④ goto-review 的落点在本页：没有待确认卡时如实说一句', (tester) async {
    final state = await pumpOverview(tester, _routes(suggestions: [
      _advice(id: 'review-stale', title: '3 项待确认已超 3 天', act: 'goto-review', actLabel: '去处理', level: 'warn'),
    ]));
    // 投影里 needsReview 是空的 ⇒ 本页没有那张卡可以滚过去
    await tester.tap(actBtn('review-stale'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('现在没有待确认的调用'), findsOneWidget, reason: '不假装跳过去了：卡不在就直说');
    expect(state.pageId, 'overview', reason: '它本来就不该切页');
    await tester.pump(const Duration(seconds: 4)); // toast 计时器收尾
  });

  testWidgets('④b goto-review 的另一半：有待确认卡时滚过去（不切页、也不谎报"没有"）', (tester) async {
    final state = await pumpOverview(
      tester,
      _routes(
        suggestions: [
          _advice(id: 'review-stale', title: '3 项待确认已超 3 天', act: 'goto-review', actLabel: '去处理', level: 'warn'),
        ],
        reviewItems: [
          {'callId': 'call-7', 'name': 'safe_write', 'at': '2026-09-28T02:00:00.000Z'},
        ],
      ),
    );
    // 待确认卡就在本页（建议区上面）：落点是"滚过去"，不是"切页"
    expect(find.text('待确认 1 项'), findsOneWidget);

    await tester.tap(actBtn('review-stale'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('现在没有待确认的调用'), findsNothing, reason: '卡在的时候不许说"没有"');
    expect(state.pageId, 'overview', reason: '落点在本页');
    expect(find.text('待确认 1 项'), findsOneWidget, reason: '那张卡还在原处，只是被滚进了视野');
  });

  testWidgets('⑤ 认不出的 act 一颗按钮都不摆；死信那条也不摆（它自己有重投/丢弃）', (tester) async {
    await pumpOverview(
      tester,
      _routes(
        suggestions: [
          _advice(id: 'whatever', title: '一条还没有动作的建议', act: 'no-such-act', actLabel: '点我'),
          _advice(id: 'dead-letters', title: '死信队列非空（1）', act: 'goto-review', actLabel: '去处理', level: 'warn'),
        ],
        deadLetters: [
          {'inputSeq': 42, 'claimCount': 3, 'at': '2026-10-05T03:12:00.000Z'},
        ],
      ),
    );

    // 认不出的 act：不摆按钮（摆一颗不知道去哪儿的按钮比不摆更糟）
    expect(actBtn('whatever'), findsNothing);
    expect(find.text('点我'), findsNothing);
    // 死信那条：服务端也给 act，但它自己有按条决定的两颗按钮，这里不重复摆
    expect(actBtn('dead-letters'), findsNothing);
    expect(find.byKey(const ValueKey('dead-requeue-42')), findsOneWidget);
    expect(find.byKey(const ValueKey('dead-discard-42')), findsOneWidget);
  });

  testWidgets('⑥ 回归：没有 act 的建议卡不摆按钮，卡面点击仍是老行为（去人格配置）', (tester) async {
    final state = await pumpOverview(tester, _routes(suggestions: [
      // 服务端没有给它 act/actLabel（老形状；本页合成的 `persona-seed` 也是这一类）
      _advice(id: 'legacy-note', title: '一条没有动作的旧建议'),
    ]));

    expect(actBtn('legacy-note'), findsNothing, reason: '没有 act 就没有按钮可摆');
    expect(find.text('去处理'), findsNothing, reason: '别拿兜底文案凭空造一颗按钮出来');

    // 老行为一个字没改：卡面点击去人格配置
    await tester.tap(find.byKey(const ValueKey('advice-legacy-note')));
    await tester.pump();
    expect(state.pageId, 'persona', reason: '没有 act 的卡：点卡面照旧去人格配置');
  });
}
