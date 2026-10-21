import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/logs_page.dart';
import 'package:irmia_gui/theme.dart';

/// 日志页「事件」那一屏里的两条**事实类**事件：
///   · `budget/consumed.context`：上下文归因（2026-10-04 起从「框架提示」卡整个移出去了，
///     口径是"归因是事实，事实去日志页看"——日志页就必须真的看得见）；
///   · `budget/resumed`：预算暂停解除（新事件，当时落进了 `default` 分支打成原始 JSON）。
///
/// 这份用例钉三件事，都是"人不该自己去解 JSON"：
///   ① `budget/resumed` 的行摘要是人话（层、已用、有效上限、是谁抬的上限）；
///   ② 带归因的那条 `budget/consumed` 行上缀「归因 X」，点开有**整条等式**（能自己加一遍）；
///   ③ 过滤菜单里有「上下文归因」这个入口（归因不是独立事件类型，落点就是它所在的类型）。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  @override
  Future<dynamic> get(String path) async {
    if (path.startsWith('/api/events')) return routes['/api/events'];
    if (path.startsWith('/api/budget')) return routes['/api/budget'];
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async => {'ok': true};
}

void main() {
  /// 数字按**实测事件**的样子给（data/budget/consumed.context 的形状，见 src/model/context-audit.ts）：
  /// 整条 = 指令 3651 + 工具 4391 + input 段 7694 = 15736
  final events = <String, dynamic>{
    'events': [
      {
        'ts': '2026-10-04T05:00:03.000Z',
        'seq': 41,
        'type': 'budget/consumed',
        'visibility': 'internal',
        'origin': 'runtime/agent-loop',
        'data': {
          'turn': 9,
          'step': 2,
          'lane': 'heavy',
          'model': 'deepseek-flash',
          'inputTokens': 12345,
          'outputTokens': 678,
          'cacheHitTokens': 9000,
          'cacheMissTokens': 3345,
          'durationMs': 4,
          'retryCount': 0,
          'finishReason': 'completed',
          'tokensTodayAccum': 13023,
          'context': {
            'renderVersion': '30',
            'instructions': {'tokens': 3651, 'hash': 'aa'},
            'tools': {'tokens': 4391, 'hash': 'bb', 'count': 25},
            'memory': {'tokens': 1190, 'hash': 'cc', 'items': 1},
            'history': {'tokens': 1164, 'hash': 'dd', 'items': 14, 'headHash': 'ee'},
            'state': {'tokens': 4705, 'hash': 'ff', 'items': 1},
            'now': {'tokens': 627, 'hash': 'gg', 'items': 1},
            'wake': {'tokens': 8, 'hash': 'hh', 'items': 1},
            'hint': {'tokens': 0, 'hash': 'ii', 'items': 0},
            'input': {'items': 18, 'tokens': 7694},
          },
        },
      },
      {
        'ts': '2026-10-04T04:59:00.000Z',
        'seq': 40,
        'type': 'budget/resumed',
        'visibility': 'internal',
        'origin': 'runtime/real-loop',
        'data': {'layer': 'task', 'limit': 400000, 'actual': 120345, 'reason': 'limit-raised'},
      },
    ],
  };

  Future<void> pumpLogs(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = AppState(api: _FakeApi({'/api/budget': <String, dynamic>{}, '/api/events': events}));
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: LogsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    // 概览是默认 tab，事件在第二个
    await tester.tap(find.text('事件'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets('日志页：预算解除是人话，归因行缀一句、点开有整条等式', (tester) async {
    await pumpLogs(tester);

    // ① budget/resumed：不许打成原始 JSON（新增事件时漏掉的那一处）
    expect(
      find.textContaining('task 层暂停已解除：已用 120,345 / 有效上限 400,000（配置里的上限被调大）'),
      findsOneWidget,
      reason: '暂停解除要一行读懂：哪一层、解除那一刻两个数、是谁抬的上限',
    );

    // ② budget/consumed 的行摘要：用量照旧 + 缀一句"归因多大"（15736 → 15.7k）
    expect(find.textContaining('归因 15.7k'), findsOneWidget);

    // 点开那一条 → 读法（整条等式）在原始 JSON 之前
    await tester.tap(find.textContaining('归因 15.7k'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('读法'), findsOneWidget);
    expect(
      find.textContaining('整条 15,736 = 指令 3,651 + 工具 4,391（25 件） + input 段 7,694'),
      findsOneWidget,
      reason: '等式两边按定义相等：想核对的人自己加一遍一定对得上（与 TS 侧 describeContext 同口径）',
    );
    expect(find.textContaining('固定块 4,705'), findsOneWidget, reason: 'B2 之后的记录有这一段');
    expect(find.textContaining('此刻层 627'), findsOneWidget);
  });

  testWidgets('日志页：过滤菜单里有「上下文归因」入口，新事件也在自己的组里', (tester) async {
    await pumpLogs(tester);

    await tester.tap(find.byTooltip('按类型过滤'));
    await tester.pumpAndSettle();

    // 归因不是独立类型（它是 budget/consumed 上的一个字段），入口的落点就是那个类型
    expect(find.text('上下文归因'), findsOneWidget);
    // 新事件按既有分法进「预算」组（菜单里那一项；行上的类型徽章也会有一处，用 descendant 只认菜单里的）
    expect(
      find.descendant(of: find.byType(PopupMenuItem<void>), matching: find.text('budget/resumed')),
      findsOneWidget,
    );
    expect(find.text('预算'), findsOneWidget);
  });
}

