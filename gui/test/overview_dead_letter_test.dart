import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';

/// 「建议」卡上那条死信建议：**重投 / 丢弃**两颗按钮（用户 2026-10-05："我在哪里重投？"）。
///
/// 这一组锁四件事，判据一条都不放宽：
///   ① 死信建议出现时，**两颗按钮都在**（seq 来自 `/api/projection` 的 `deadLetters[]`）；
///   ② 点「重投」发出的请求 = `POST /api/commands/requeue` + `{inputSeq}`（命令载荷契约）；
///   ③ 点「丢弃」**先出现确认框**；取消一个请求都不发，确认才发 `discard`；
///   ④ 请求失败时**卡上**有错误提示，且文案里带着失败原因。
class _Post {
  const _Post(this.path, this.body, this.confirm);
  final String path;
  final Map<String, dynamic> body;
  final String? confirm;
}

class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  /// 两条 GET 端点的响应体（**会被就地改**：动作成功之后服务端那份投影也变了）
  final Map<String, dynamic> routes;

  /// 发出去的命令，按顺序记下来（断言路径与载荷用）
  final List<_Post> posts = [];

  /// 下一次该路径的 POST 要抛的错（按路径配）
  final Map<String, Object> failPost = {};

  @override
  Future<dynamic> get(String path) async => routes[path];

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add(_Post(path, body, confirm));
    final failure = failPost[path];
    if (failure != null) throw failure;
    // 服务端写完事件之后投影跟着变：重投/丢弃成功 = 这条死信离开队列 ⇒ 那条建议也消失
    if (path == '/api/commands/requeue' || path == '/api/commands/discard') {
      (routes['/api/projection'] as Map)['deadLetters'] = <dynamic>[];
      (routes['/api/stats/dashboard'] as Map)['suggestions'] = <dynamic>[];
    }
    return {'ok': true};
  }
}

/// 真实形状的数据：`suggestions` 里那条 `dead-letters`（服务端 `buildSuggestions` 的原文），
/// 投影里的一条死信——**`inputSeq` 只在这里**（建议自己不带 seq）。
Map<String, dynamic> _routes({int seq = 42, int claimCount = 3}) => {
      '/api/stats/dashboard': {
        'state': 'idle',
        'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': 0, 'cacheHitRate': 0.9},
        'budget': {'tokensToday': 1200},
        'hourly': <dynamic>[],
        'recent': <dynamic>[],
        'suggestions': [
          {
            'id': 'dead-letters',
            'level': 'warn',
            'title': '死信队列非空（1）',
            'body': '认领三次仍失败的输入，需要人工决定重投还是丢弃。',
            'text': '死信队列非空（1）',
            'act': 'goto-review',
            'actLabel': '去处理',
          },
        ],
        'personaIsSeed': false,
        'guardedDays': 3,
        'nextWakeAt': null,
      },
      '/api/projection': {
        'needsReview': <dynamic>[],
        'deadLetters': [
          {'inputSeq': seq, 'claimCount': claimCount, 'at': '2026-10-05T03:12:00.000Z'},
        ],
      },
      '/api/sessions': {'sessions': <dynamic>[], 'contacts': <dynamic>{}, 'unreadTotal': 0},
      '/api/framework-notes': {'notes': <dynamic>[], 'count': 0, 'limit': 20},
    };

Future<void> _pump(WidgetTester tester, _FakeApi api) async {
  // 页面比视口高：不给足高度的话 ListView 不会把建议卡建出来，finder 就找不到东西
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

/// 建议卡里那颗按钮（按 seq 定位：一张卡上可能有好几条死信）
Finder _requeueBtn(int seq) => find.byKey(ValueKey('dead-requeue-$seq'));
Finder _discardBtn(int seq) => find.byKey(ValueKey('dead-discard-$seq'));
Finder _card() => find.byKey(const ValueKey('advice-dead-letters'));

void main() {
  testWidgets('① 死信建议行：两颗按钮都在，seq 来自投影里的 deadLetters', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    // 那句建议原样在（标题 + 细节），人读到的还是同一句话
    expect(find.text('死信队列非空（1）：认领三次仍失败的输入，需要人工决定重投还是丢弃。'), findsOneWidget);

    // 判据 ①：重投与丢弃**都在**，而且就在这张卡里
    expect(_requeueBtn(42), findsOneWidget);
    expect(_discardBtn(42), findsOneWidget);
    expect(find.descendant(of: _card(), matching: find.text('重投')), findsOneWidget);
    expect(find.descendant(of: _card(), matching: find.text('丢弃')), findsOneWidget);

    // seq 只能来自 /api/projection：卡上把它摆出来（人得知道自己动的是哪一条）
    expect(find.descendant(of: _card(), matching: find.textContaining('seq 42')), findsOneWidget);
    expect(find.descendant(of: _card(), matching: find.textContaining('认领 3 次')), findsOneWidget);

    // 还没点过，一条命令都没发
    expect(api.posts, isEmpty);
  });

  testWidgets('② 点「重投」：POST /api/commands/requeue + {inputSeq}，成功后卡刷新并给 toast', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_requeueBtn(42));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // 判据 ②：路径与载荷就是契约本身（两条命令的载荷都是 {inputSeq}）
    expect(api.posts.length, 1);
    expect(api.posts.single.path, '/api/commands/requeue');
    expect(api.posts.single.body, {'inputSeq': 42});

    // 成功后卡跟着服务端重算：队列空了，那条建议自己消失（人看到的是"处理掉了"）
    expect(find.textContaining('死信队列非空'), findsNothing, reason: '投影里没有死信了，建议就不该还挂着');
    expect(_requeueBtn(42), findsNothing);

    // 反馈走全局 toast（照既有风格）
    expect(find.textContaining('已重投 seq 42'), findsOneWidget);
  });

  testWidgets('③ 点「丢弃」：先出现确认框；取消不发请求，确认才发 discard', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_discardBtn(42));
    await tester.pumpAndSettle();

    // 判据 ③ a：先问一句才动手（不可逆的动作不许一点就走）
    expect(find.text('丢弃这条死信？'), findsOneWidget);
    // 确认文案必须说清两件事：不会被执行、记录仍在日志里
    expect(find.textContaining('seq 42 不会被重投，也不会被执行'), findsOneWidget);
    expect(find.textContaining('仍留在事件日志里'), findsOneWidget);
    expect(api.posts, isEmpty, reason: '框还开着，一个请求都不该发');

    // 取消 = 什么都没决定
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.text('丢弃这条死信？'), findsNothing);
    expect(api.posts, isEmpty, reason: '取消不许留下任何副作用');
    expect(_discardBtn(42), findsOneWidget, reason: '那条死信还在，按钮也在');

    // 再来一次，这回确认（确认按钮的文案与卡上那颗不同：框里请人再点一次的是"确认丢弃"）
    await tester.tap(_discardBtn(42));
    await tester.pumpAndSettle();
    await tester.tap(find.text('确认丢弃'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(api.posts.length, 1);
    expect(api.posts.single.path, '/api/commands/discard');
    expect(api.posts.single.body, {'inputSeq': 42});
    expect(find.textContaining('已丢弃 seq 42'), findsOneWidget);
    expect(find.textContaining('死信队列非空'), findsNothing);
  });

  testWidgets('④ 请求失败：卡上留下原因（toast 会消失，这句不会）', (tester) async {
    final api = _FakeApi(_routes());
    api.failPost['/api/commands/requeue'] =
        const ApiError(404, 'seq 42 不在死信队列里');
    await _pump(tester, api);

    await tester.tap(_requeueBtn(42));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final error = find.byKey(const ValueKey('advice-action-error'));
    expect(error, findsOneWidget, reason: '失败必须在卡上留下可读的一句，不能只有一个四秒的 toast');
    expect(
      find.descendant(of: _card(), matching: error),
      findsOneWidget,
      reason: '那句提示得在**这张卡**上：人正盯着它点按钮',
    );
    expect(
      tester.widget<Text>(error).data,
      allOf(contains('重投'), contains('seq 42 不在死信队列里')),
      reason: '文案要带失败原因要素，光说"失败了"没法判断下一步',
    );

    // 失败了也不能让人无路可走：按钮照旧在，数据照旧在
    expect(_requeueBtn(42), findsOneWidget);
    expect(_discardBtn(42), findsOneWidget);
    expect(find.textContaining('死信队列非空'), findsOneWidget);
  });

  testWidgets('建议里没有 seq 时：只说"没读到明细"，不摆一颗不知道会动哪条的按钮', (tester) async {
    final routes = _routes();
    (routes['/api/projection'] as Map)['deadLetters'] = <dynamic>[];
    final api = _FakeApi(routes);
    await _pump(tester, api);

    expect(find.textContaining('死信队列非空'), findsOneWidget, reason: '建议是服务端给的，照旧摆出来');
    expect(find.text('没读到死信明细，刷新一次再看看。'), findsOneWidget);
    expect(find.text('重投'), findsNothing);
    expect(find.text('丢弃'), findsNothing);
  });
}
