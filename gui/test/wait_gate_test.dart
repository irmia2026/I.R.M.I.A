import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';

/// **"永远不返回"的反向验证**（2026-10-23「GUI 用久了会卡死」的验收用例）。
///
/// 旧代码在这个形状下是**永久转圈**：`IrmiaApi` 没有整条请求的时限，那个 future
/// 永远不完成 ⇒ 页面 `loading` 永远是 true ⇒ 屏幕上只有一颗转着的圈，
/// 人点哪里都没有反应（而进程健康、`Responding=True`——这正是现场那一份读数）。
///
/// 这一份钉两条：
///   ① **页面这一层**：一次"没回来"的加载必须在时限内落到**可重试的错误态**，
///      而不是一直转圈。用的不是假 API，是**真的 `IrmiaApi` + 一个真的收了请求
///      就不回的服务端**——假实现证明不了时限，真的 socket 才行；
///   ② **壳这一层**：等久了页面顶上要有一行小字说清"在等哪一条、已等多久"，
///      并且那颗「重试」真的能把这一页重新挂起来（重新取数）。
void main() {
  group('① 一次"没回来"的加载 ⇒ 时限内落到可重试的错误态', () {
    late HttpServer server;
    late IrmiaApi api;

    setUp(() async {
      // `flutter_test` 默认把 `HttpClient` 换成"一律回 400"的假实现（免得用例偷偷上网）。
      // 这一组要的恰恰是**真的 socket**（假实现证明不了"永远不返回"），所以关掉它。
      HttpOverrides.global = null;
      // 一个"收了请求就再也不回"的服务端：连接活着、响应头永远不来
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) {
        // 故意什么都不做
      });
      api = IrmiaApi(
        baseUrl: 'http://127.0.0.1:${server.port}',
        // 用例里的时限：300ms 就够把"旧代码永远等"与"新代码到点就抛"分开
        requestTimeout: const Duration(milliseconds: 300),
        connectTimeout: const Duration(seconds: 30),
      );
    });

    tearDown(() async {
      await server.close(force: true);
    });

    testWidgets('运行情况页：先转圈，时限一到就是「无法获取运行数据」+ 重试', (tester) async {
      final state = AppState(api: api);
      addTearDown(state.dispose);
      tester.view.physicalSize = const Size(1400, 1800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: OverviewPage(state: state))),
      );
      await tester.pump();
      // 旧代码就停在这一帧，永远出不去
      expect(find.byType(CircularProgressIndicator), findsOneWidget,
          reason: '刚进页：还在等（这一帧新旧代码一样）');
      expect(find.text('无法获取运行数据'), findsNothing);

      // 让真的 socket 有机会跑一段（假时钟里 IO 不会自己前进）
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      // 推进假时钟 ⇒ 那条 `.timeout(300ms)` 到期
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();

      expect(find.text('无法获取运行数据'), findsOneWidget,
          reason: '时限内必须落到错误态（旧代码在这里还是转圈）');
      expect(find.text('重试'), findsOneWidget, reason: '错误态必须可重试');
      expect(find.byType(CircularProgressIndicator), findsNothing, reason: '不许一边转圈一边报错');

      // 收尾：让那条挂着的连接与它的建连定时器都走完（假时钟里留着会判"定时器泄漏"）
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 31));
    });
  });

  group('② 壳那一层：等久了有一行字，点「重试」把这一页重挂', () {
    testWidgets('等过门槛 ⇒ 状态条出现；点重试 ⇒ 整页重新取数；请求结束 ⇒ 状态条消失',
        (tester) async {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      tester.view.physicalSize = const Size(1400, 1800);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        // 照 `app.dart` 的接线：根上那一层 `ListenableBuilder` 监听 AppState。
        // 少了它，`notifyListeners` 在这里就没有人接（真机上它一定在）。
        ListenableBuilder(
          listenable: state,
          builder: (context, _) =>
              MaterialApp(theme: IrmiaTheme.light(), home: HomeShell(state: state)),
        ),
      );
      await tester.pump();

      // 正常时它一个像素都不占
      expect(find.byKey(const ValueKey('wait-banner')), findsNothing);

      // 手工登记一条"在飞"的请求：这一层是**在飞清单的纯视图**，不需要真开连接
      // （清单与真实请求的接线由 api_timeout_test.dart 用真的挂起的服务端钉着）
      final entry = api.beginRequest('GET', '/api/stats/dashboard');
      await tester.pump();
      // 门槛之内（kSlowRequestHint = 5 秒）还是不出现：几毫秒就回来的请求不该让版面跳
      await tester.pump(const Duration(seconds: 3));
      expect(find.byKey(const ValueKey('wait-banner')), findsNothing,
          reason: '等到 5 秒才说话，别为快请求闪一下');

      // 过门槛：一行小字说清"在等哪一条、已等多久"
      await tester.pump(const Duration(seconds: 3));
      expect(find.byKey(const ValueKey('wait-banner')), findsOneWidget);
      expect(find.textContaining('正在等 GET /api/stats/dashboard'), findsOneWidget);
      expect(find.textContaining('已 6 秒'), findsOneWidget, reason: '秒表要真的在走');

      // 再走两秒：秒数跟着涨（这一行不是一张死图）
      await tester.pump(const Duration(seconds: 2));
      expect(find.textContaining('已 8 秒'), findsOneWidget);

      // 「重试」= 把这一页整页重挂 ⇒ 页面重新 initState ⇒ 重新取数
      final readsBefore = api.dashboardReads;
      await tester.tap(find.byKey(const ValueKey('wait-banner-retry')));
      await tester.pump();
      await tester.pump();
      expect(state.pageEpoch, 1, reason: '重挂计数是页面的 Key，它一变页面就重建');
      expect(api.dashboardReads, greaterThan(readsBefore),
          reason: '重挂必须真的重新取数（否则那颗按钮只是画了一个圈）');

      // 请求自己回来了：状态条必须消失（它不是一个"错误提示"，是"还在等"）
      api.endRequest(entry);
      await tester.pump();
      expect(find.byKey(const ValueKey('wait-banner')), findsNothing);

      await tester.pumpWidget(const SizedBox());
    });
  });
}

/// 一份"立刻就有答案"的假 API：只回答运行情况页要的那几条，什么网络都不碰。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  /// `/api/stats/dashboard` 被读了几次（验"重挂真的重新取数"）
  int dashboardReads = 0;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/stats/dashboard') dashboardReads += 1;
    return switch (path) {
      '/api/stats/dashboard' => <String, dynamic>{
          'state': 'idle',
          'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': 0, 'cacheHitRate': 0.9},
          'budget': {'tokensToday': 0},
          'hourly': <dynamic>[],
          'recent': <dynamic>[],
          'suggestions': <dynamic>[],
          'personaIsSeed': false,
          'guardedDays': 3,
          'nextWakeAt': null,
        },
      '/api/projection' => <String, dynamic>{'needsReview': <dynamic>[]},
      '/api/sessions' => <String, dynamic>{'sessions': <dynamic>[], 'contacts': <String, dynamic>{}},
      '/api/framework-notes' => <String, dynamic>{'notes': <dynamic>[], 'count': 0, 'limit': 20},
      _ => null,
    };
  }
}
