import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';

/// 运行情况页的**定时器卡片**：她排着的唤醒 + 每行的「撤销」
/// （`POST /api/commands/timer-cancel` 的前端那一半）。
///
/// 来源：docs/repo-cleanliness-audit.md §8（总表 D4）。后端与用例都在
/// （src/web/server.ts:4964，载荷 `{timerId}`，先写 `timer/cancelled` 再取消布防），
/// design §4.18 还专门论证过"cancel 是误排之后**唯一**的撤销出口（零调用 ≠ 没用）"
/// （docs/design.md:965-969）——而界面上从前一个入口都没有，误排只能等它到点自己醒。
///
/// 这一组锁四件事：
///   ① 投影里在等的定时器都摆出来（一次性的 `at` 与周期的 `cron` 都在），空态是一行灰字；
///   ② 点「撤销」先出现确认框，**取消一个请求都不发**；
///   ③ 确认后发 `timer-cancel {timerId}`，投影随之少一条、那一行消失，并给 toast；
///   ④ 请求失败时卡上留下原因（toast 会消失，这句不会）。
class _Post {
  const _Post(this.path, this.body, this.confirm);
  final String path;
  final Map<String, dynamic> body;
  final String? confirm;
}

class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  /// 两条 GET 端点的响应体（**会被就地改**：撤销成功之后服务端那份投影也少了一条）
  final Map<String, dynamic> routes;

  final List<_Post> posts = [];

  /// 下一次该路径的 POST 要抛的错
  final Map<String, Object> failPost = {};

  @override
  Future<dynamic> get(String path) async => routes[path];

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add(_Post(path, body, confirm));
    final failure = failPost[path];
    if (failure != null) throw failure;
    // 服务端写完 timer/cancelled 之后投影里那条就没了：界面重读时它自然消失
    if (path == '/api/commands/timer-cancel') {
      final timers = (routes['/api/projection'] as Map)['timers'] as List;
      timers.removeWhere((item) => (item as Map)['timerId'] == body['timerId']);
    }
    return {'ok': true, 'timerId': body['timerId']};
  }
}

/// 真实形状的数据：投影 `timers[]` 的两条（一次性 / 周期），字段照 log/types.ts 的 TimerEntry
Map<String, dynamic> _routes() => {
      '/api/stats/dashboard': {
        'state': 'idle',
        'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': 0, 'cacheHitRate': 0.9},
        'budget': {'tokensToday': 1200},
        'hourly': <dynamic>[],
        'recent': <dynamic>[],
        'suggestions': <dynamic>[],
        'personaIsSeed': false,
        'guardedDays': 3,
        'nextWakeAt': null,
      },
      '/api/projection': {
        'needsReview': <dynamic>[],
        'timers': [
          {
            'timerId': 'tmr-morning',
            'at': '2026-10-07T01:00:00.000Z',
            'payload': '早上好，先看一眼昨天的账',
          },
          {
            'timerId': 'tmr-daily',
            'cron': '0 9 * * *',
            'payload': {'kind': 'digest'},
          },
        ],
      },
      '/api/sessions': {'sessions': <dynamic>[], 'contacts': <dynamic>{}, 'unreadTotal': 0},
      '/api/framework-notes': {'notes': <dynamic>[], 'count': 0, 'limit': 20},
    };

Future<void> _pump(WidgetTester tester, _FakeApi api) async {
  // 页面比视口高：不给足高度的话 ListView 不会把这张卡建出来，finder 就找不到东西
  tester.view.physicalSize = const Size(1400, 1800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final state = AppState(api: api);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: OverviewPage(state: state))),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Finder _card() => find.ancestor(of: find.text('定时器'), matching: find.byType(Container)).first;
Finder _cancelBtn(String id) => find.byKey(ValueKey('timer-cancel-$id'));

void main() {
  testWidgets('① 定时器卡：在等的都摆出来（一次性 + 周期）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('定时器'), findsOneWidget);
    expect(find.text('2 个在等'), findsOneWidget);

    // 两条各一行，按 timerId 定位；一次性的给时刻、周期的给表达式
    expect(find.byKey(const ValueKey('timer-tmr-morning')), findsOneWidget);
    expect(find.byKey(const ValueKey('timer-tmr-daily')), findsOneWidget);
    expect(find.descendant(of: _card(), matching: find.textContaining('周期 0 9 * * *')), findsOneWidget,
        reason: '周期条没有 at，界面要说清它按表达式重复');
    // 唤醒内容要看得见：撤销之前人得知道撤的是哪一件事
    expect(find.textContaining('早上好，先看一眼昨天的账'), findsOneWidget);
    // 每行一颗撤销，还没点过 ⇒ 一条命令都没发
    expect(_cancelBtn('tmr-morning'), findsOneWidget);
    expect(_cancelBtn('tmr-daily'), findsOneWidget);
    expect(api.posts, isEmpty);
  });

  testWidgets('①b 空态：投影里没有定时器时只给一行灰字，不摆空表', (tester) async {
    // 单独一条用例（不与上一条共用一个 tester）：同类型 widget 二次 pumpWidget 会复用
    // 原来那个 State，initState 不再跑——页面会拿着上一份数据装作已经加载完了
    final empty = _FakeApi(_routes());
    ((empty.routes['/api/projection'] as Map)['timers'] as List).clear();
    await _pump(tester, empty);

    expect(find.text('定时器'), findsOneWidget);
    expect(find.text('眼下没有排着的定时器。'), findsOneWidget);
    expect(find.textContaining('个在等'), findsNothing);
    expect(find.text('撤销'), findsNothing);
  });

  testWidgets('② 点「撤销」先确认；取消一个请求都不发', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_cancelBtn('tmr-morning'));
    await tester.pumpAndSettle();

    expect(find.text('撤销这个定时器？'), findsOneWidget);
    expect(find.textContaining('tmr-morning'), findsWidgets, reason: '确认框要点名撤的是哪一个');
    expect(find.textContaining('写进日志'), findsOneWidget, reason: '撤销会留痕这件事要说在明面上');
    expect(api.posts, isEmpty, reason: '框还开着，一个请求都不该发');

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.text('撤销这个定时器？'), findsNothing);
    expect(api.posts, isEmpty, reason: '取消不许留下任何副作用');
    expect(find.byKey(const ValueKey('timer-tmr-morning')), findsOneWidget, reason: '那条定时器还在');
  });

  testWidgets('③ 确认后发 timer-cancel{timerId}，那一行随之消失并给 toast', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_cancelBtn('tmr-morning'));
    await tester.pumpAndSettle();
    // 确认按钮的文案与卡上那颗不同：框里请人再点一次的是"撤销"
    await tester.tap(find.widgetWithText(FilledButton, '撤销'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(api.posts.length, 1);
    expect(api.posts.single.path, '/api/commands/timer-cancel');
    expect(api.posts.single.body, {'timerId': 'tmr-morning'}, reason: '载荷就是 {timerId}（服务端的契约）');
    expect(find.byKey(const ValueKey('timer-tmr-morning')), findsNothing,
        reason: '撤销成功后投影里那条没了，这一行该消失');
    expect(find.byKey(const ValueKey('timer-tmr-daily')), findsOneWidget, reason: '别的定时器一条都不许被牵连');
    expect(find.text('1 个在等'), findsOneWidget);
    expect(find.textContaining('已撤销定时器 tmr-morning'), findsOneWidget);
  });

  testWidgets('④ 撤销失败：卡上留下原因，按钮照旧可按（不是死路）', (tester) async {
    final api = _FakeApi(_routes());
    api.failPost['/api/commands/timer-cancel'] =
        const ApiError(404, '定时器 tmr-morning 不在投影里（可能已触发或已取消）');
    await _pump(tester, api);

    await tester.tap(_cancelBtn('tmr-morning'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '撤销'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(
      find.descendant(of: _card(), matching: find.textContaining('撤销 tmr-morning 失败')),
      findsOneWidget,
      reason: '失败原因要留在**这张卡**上：toast 四秒就没了，而人正盯着它点按钮',
    );
    expect(find.byKey(const ValueKey('timer-tmr-morning')), findsOneWidget, reason: '失败了那条照旧在');
  });
}
