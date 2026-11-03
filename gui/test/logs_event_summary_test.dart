import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/logs_page.dart';
import 'package:irmia_gui/theme.dart';

/// 日志页「事件」屏：情绪/表情包这一族事件**不许再落成裸 JSON**。
///
/// 2026-10-31 补的一批：类型徽章说人话（情绪评价 / 表情包投递…），摘要说「原因 · 主导情绪
/// 强度」「主动 · 标签 · 位置 · 候选 N」这些；文案全在 AppStrings，本用例按中文默认实现断言。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path.startsWith('/api/events')) return routes['/api/events'];
    if (path.startsWith('/api/budget')) return routes['/api/budget'];
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async =>
      {'ok': true};
}

void main() {
  final events = <String, dynamic>{
    'events': [
      {
        'ts': '2026-10-31T09:00:00.000Z',
        'seq': 61,
        'type': 'affect/appraised',
        'visibility': 'internal',
        'data': {
          'reasonCode': 'owner_success',
          'impulse': <String, double>{
            'joy': 0.2,
            'distress': 0,
            'concern': 0.72,
            'irritation': 0,
            'warmth': 0.1,
            'shyness': 0.05,
          },
        },
      },
      {
        'ts': '2026-10-31T08:59:00.000Z',
        'seq': 60,
        'type': 'sticker/sent',
        'visibility': 'internal',
        'data': {
          'source': 'active',
          'tag': '开心',
          'position': 'after',
          'candidates': <String>['a', 'b', 'c'],
        },
      },
      {
        'ts': '2026-10-31T08:58:00.000Z',
        'seq': 59,
        'type': 'sticker/skipped',
        'visibility': 'internal',
        'data': {'reason': 'no-match'},
      },
      {
        'ts': '2026-10-31T08:57:00.000Z',
        'seq': 58,
        'type': 'sticker/harvested',
        'visibility': 'internal',
        'data': {'result': 'pending'},
      },
      {
        'ts': '2026-10-31T08:56:00.000Z',
        'seq': 57,
        'type': 'sticker/tagged',
        'visibility': 'internal',
        'data': {
          'tags': <String>['开心', '猫'],
          'confidence': 0.82,
        },
      },
      {
        'ts': '2026-10-31T08:55:00.000Z',
        'seq': 56,
        'type': 'sticker/reviewed',
        'visibility': 'internal',
        'data': {'action': 'approve'},
      },
    ],
  };

  testWidgets('情绪/表情包事件：类型标签与摘要都是人话', (tester) async {
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
    await tester.tap(find.text('事件'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // 类型标签
    for (final label in ['情绪评价', '表情包投递', '表情包跳过', '表情包采收', '表情包打标', '表情包审核']) {
      expect(find.text(label), findsOneWidget, reason: '类型标签缺了：$label');
    }

    // 摘要：原因 · 主导情绪 强度
    expect(find.textContaining('用户有了进展 · 关切 0.72'), findsOneWidget);
    // 摘要：主动/被动 · 标签 · 位置 · 候选 N
    expect(find.textContaining('主动 · 开心 · 配文后 · 候选 3'), findsOneWidget);
    // 跳过：原因
    expect(find.text('no-match'), findsOneWidget);
    // 采收：结果
    expect(find.text('待审'), findsOneWidget);
    // 打标：标签 / 置信
    expect(find.textContaining('开心 / 猫 · 置信 0.82'), findsOneWidget);
    // 审核：动作
    expect(find.text('批准'), findsOneWidget);
    // 不许出现整段原始 JSON
    expect(find.textContaining('"impulse"'), findsNothing);
  });
}
