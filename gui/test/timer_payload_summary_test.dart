import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';

/// 定时器卡片那一行「唤醒内容」的**取词次序**（2026-10-13，timer `payload` 三格约定那一批）。
///
/// 判据：`payload` 从这一版起有了**约定形状** `{why, note, sid}`（见 `src/model/self-brief.ts`
/// 的 `PAYLOAD_SHAPE_TEXT` 与 `src/tools/admin.ts` 的 `timer.payload` 说明），而界面原来对
/// **对象**型 payload 会打出整串 JSON——人看到的是 `{kind: wait, note: …}` 而不是"她写了什么"。
/// 这一版起：**先取 `note`、再取 `why`**（都没有才退回原来的 `toString()`），
/// 旧形状（字符串 / 只有 `kind` 的对象）照旧可读——**缺格不是错误**。
///
/// 四件事各一条：
///   ① 对象带 `note` ⇒ 那一行显示的是 `note`（不是 JSON），且 `sid` 这种字段名一个都不露；
///   ② 只有 `why` ⇒ 显示 `why`（界面看"为什么排它"的唯一入口）；
///   ③ 两格都没有 ⇒ 退回原来的表现（`toString()`），旧形状仍可读；
///   ④ 字符串型 payload 一个字都不变（`wait` 之前那一版的老数据、以及 backfill 之前的历史）。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.timers) : super(baseUrl: 'http://127.0.0.1:1');

  final List<dynamic> timers;

  @override
  Future<dynamic> get(String path) async {
    if (path == '/api/projection') {
      return {'needsReview': <dynamic>[], 'timers': timers};
    }
    if (path == '/api/stats/dashboard') {
      return {
        'state': 'idle',
        'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': 0, 'cacheHitRate': 0.9},
        'budget': {'tokensToday': 1200},
        'hourly': <dynamic>[],
        'recent': <dynamic>[],
        'suggestions': <dynamic>[],
        'personaIsSeed': false,
        'guardedDays': 3,
        'nextWakeAt': null,
      };
    }
    if (path == '/api/sessions') return {'sessions': <dynamic>[], 'contacts': <dynamic>{}, 'unreadTotal': 0};
    return {'notes': <dynamic>[], 'count': 0, 'limit': 20};
  }
}

Future<void> _pump(WidgetTester tester, List<dynamic> timers) async {
  // 页面比视口高：不给足高度的话 ListView 不会把这张卡建出来，finder 就找不到东西
  tester.view.physicalSize = const Size(1400, 1800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final state = AppState(api: _FakeApi(timers));
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: OverviewPage(state: state))),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('① 对象带 note ⇒ 显示 note（不是整串 JSON），sid 这类字段名不露出来', (tester) async {
    await _pump(tester, [
      {
        'timerId': 'tmr-note',
        'at': '2026-10-07T01:00:00.000Z',
        'payload': {
          'why': '他昨天说想让我盯一下这件事',
          'note': '提醒他去看那份合同',
          'sid': 'qq:group:G1',
        },
      },
    ]);

    expect(find.textContaining('提醒他去看那份合同'), findsOneWidget, reason: 'note 才是"到点做什么"，界面先取它');
    expect(find.textContaining('他昨天说想让我盯一下这件事'), findsNothing, reason: '取到 note 之后 why 不重复占一行');
    expect(find.textContaining('{'), findsNothing, reason: '不许把整串 JSON 打给人看');
    expect(find.textContaining('sid'), findsNothing, reason: '字段名不该出现在人看的摘要里');
    expect(find.textContaining('qq:group:G1'), findsNothing, reason: '会话 id 是给她回投用的，不是给人看的');
  });

  testWidgets('② 只有 why ⇒ 显示 why（界面看"为什么排它"的唯一入口）', (tester) async {
    await _pump(tester, [
      {
        'timerId': 'tmr-why',
        'at': '2026-10-07T02:00:00.000Z',
        'payload': {'why': '这条是用户点名要排的', 'sid': null},
      },
    ]);

    expect(find.textContaining('这条是用户点名要排的'), findsOneWidget, reason: 'note 缺格时退到 why');
    expect(find.textContaining('{'), findsNothing);
  });

  testWidgets('③ 两格都没有 ⇒ 退回原来的表现（旧形状仍可读，缺格不是错误）', (tester) async {
    await _pump(tester, [
      {
        'timerId': 'tmr-other',
        'at': '2026-10-07T03:00:00.000Z',
        'payload': {'kind': 'digest'},
      },
    ]);

    // 与改动前逐字相同：对象走 `toString()`
    expect(find.textContaining("{kind: digest}"), findsOneWidget,
        reason: '没有 note/why 的对象照旧走 toString()——旧数据一个字都不用改');
  });

  testWidgets('④ 字符串型 payload 一个字都不变（老数据与 backfill 之前的历史）', (tester) async {
    await _pump(tester, [
      {
        'timerId': 'tmr-string',
        'at': '2026-10-07T04:00:00.000Z',
        'payload': '早上好，先看一眼昨天的账',
      },
    ]);

    expect(find.textContaining('早上好，先看一眼昨天的账'), findsOneWidget);
  });
}
