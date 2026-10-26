import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/chat_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 聊天页两条数据入口的韧性（REVIEW P1-23 / P1-25）：
///
///   · **SSE 断线重连要带补拉锚点**（最后收到的 seq）。服务端 `openStream` 认
///     `Last-Event-ID`，从 `lastId + 1` 把断线窗口里的事件重发一遍；不传的话那一段
///     永久丢——工具块会永远停在「正在执行…」。
///   · **历史读失败不许静默成「会话尚未开始」**：读不到要说读不到（错误态 + 重试），
///     只有读成功且确实没有记录时才说空态。
///
/// 假 API 每次 `events()` 给一条**新流**：断线 = 关掉上一条，重连 = 多一条，
/// 并把这次收到的 `lastEventId` 记下来当补拉的证据。

class _ReconnectApi extends IrmiaApi {
  _ReconnectApi({this.history = const []}) : super(baseUrl: 'http://127.0.0.1:1');

  /// 进页面时 `/api/events?limit=60` 返回的那一页
  List<Map<String, dynamic>> history;

  /// 非空 ⇒ 历史那一条请求失败（P1-25 的失败态）
  String? historyError;

  /// `/api/events` 被请求了几次（含重试；P1-25 数它）
  int historyCalls = 0;

  /// `events(lastEventId:)` 每次收到的锚点——补拉的证据
  final anchors = <int?>[];

  /// 每条连接一条流（断线 = 关掉最后一条）
  final streams = <StreamController<Map<String, dynamic>>>[];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path.startsWith('/api/events')) {
      historyCalls += 1;
      final error = historyError;
      if (error != null) throw ApiError(500, error);
      return <String, dynamic>{'events': history};
    }
    if (path == '/api/sessions') {
      return <String, dynamic>{'contacts': <String, dynamic>{}};
    }
    return <String, dynamic>{'ok': true};
  }

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    anchors.add(lastEventId);
    final controller = StreamController<Map<String, dynamic>>.broadcast();
    streams.add(controller);
    return controller.stream;
  }

  /// 灌一条实时事件到**当前这条**连接
  Future<void> push(Map<String, dynamic> event) async {
    streams.last.add(event);
    await Future<void>.value();
  }

  /// 断线：关掉当前这条流（ChatPage 的 `onDone` 会在 3 秒后重连）
  Future<void> drop() async {
    await streams.last.close();
    await Future<void>.value();
  }
}

Map<String, dynamic> _evt(int seq, String type, Map<String, dynamic> data) =>
    <String, dynamic>{
      'seq': seq,
      'ts': '2026-10-17T09:00:0${seq % 10}.000Z',
      'type': type,
      'data': data,
    };

Map<String, dynamic> _her(int seq, String text) =>
    _evt(seq, 'message/assistant', <String, dynamic>{'text': text, 'toolCalls': <dynamic>[]});

void main() {
  HttpOverrides.global = null;

  setUp(() {
    stateFileOverride = '${Directory.systemTemp.path}/irmia-chat-resilience-test.json';
  });

  tearDown(() => stateFileOverride = null);

  /// 起一页聊天（`ready = true` 免掉门那一套；不启动轮询，这一页自己管两入口）
  Future<_ReconnectApi> boot(
    WidgetTester tester, {
    List<Map<String, dynamic>> history = const [],
    String? historyError,
  }) async {
    final api = _ReconnectApi(history: history)..historyError = historyError;
    final state = AppState(api: api);
    state.ready = true;
    addTearDown(state.dispose);
    addTearDown(() async {
      for (final controller in api.streams) {
        if (!controller.isClosed) await controller.close();
      }
    });
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ChatPage(state: state)),
    ));
    // 历史那一次读与别名那一条都是异步的：给两拍让它们落下来
    // （不用 pumpAndSettle：这一页的动画在有些场景里永远不静止）
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return api;
  }

  group('P1-23 SSE 重连带补拉锚点', () {
    testWidgets('断线 → 带最后收到的 seq 重连 → 断线窗口里的事件不重不漏', (tester) async {
      final api = await boot(tester, history: [
        _her(1, '历史第一句'),
        _her(2, '历史第二句'),
        _her(3, '历史第三句'),
      ]);

      // 首连：一条事件都还没见过 ⇒ 没有锚点（服务端按"从现在开始"处理）
      expect(api.anchors, hasLength(1));
      expect(api.anchors.first, isNull, reason: '进页面那一刻还没有任何事件可当锚点');

      // 实时到的：一条工具调用（回执还没来）→ 块停在「正在执行…」
      await api.push(_evt(4, 'tool/call', <String, dynamic>{
        'turn': 1,
        'step': 0,
        'callId': 'c1',
        'name': 'read_file',
        'arguments': '{"file_path":"main.log"}',
        'sideEffect': 'none',
      }));
      await api.push(_her(5, '断线前的最后一句'));
      // 最后**收到**的是一条不上屏的事件：锚点说的是"日志走到哪了"，不是"屏上最后一条"
      await api.push(_evt(6, 'step/start', <String, dynamic>{'turn': 1, 'step': 1}));
      await tester.pump();
      expect(find.text('正在执行…'), findsOneWidget, reason: '前提：回执还没到');

      // ── 断线 ──
      await api.drop();
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();

      expect(api.anchors, hasLength(2), reason: '断线之后重连了一次');
      expect(api.anchors.last, 6,
          reason: '★ 重连必须带"最后收到的那条 seq"（不是最后上屏那条）——'
              '不带的话服务端补不了（`src/web/server.ts` 的 openStream 认 Last-Event-ID），'
              '断线窗口里那条工具回执就永远丢了');

      // 服务端补拉：从锚点 + 1 起把断线窗口重发一遍，然后接上新的实时事件
      await api.push(_evt(7, 'tool/result', <String, dynamic>{
        'turn': 1,
        'step': 0,
        'callId': 'c1',
        'callSeq': 4,
        'status': 'ok',
        'content': '读到了日志尾部',
        'durationMs': 120,
      }));
      await api.push(_her(8, '断线后补回来的一句'));
      await tester.pump();

      // **不漏**：断线窗口里那条回执到了，工具块不再停在「正在执行…」
      expect(find.text('完成'), findsOneWidget, reason: '补拉回来的回执要接上原来那个块');
      expect(find.text('正在执行…'), findsNothing, reason: '那块不该永远停在"正在执行"');
      expect(find.textContaining('读到了日志尾部'), findsOneWidget);
      expect(find.text('断线后补回来的一句'), findsOneWidget);

      // **不重**：网络抖动导致服务端把已见过的那条又发一遍 ⇒ 按 seq 去重，屏上仍只有一条
      await api.push(_her(5, '断线前的最后一句'));
      await tester.pump();
      expect(find.text('断线前的最后一句'), findsOneWidget, reason: '同一条 seq 补两遍只画一次');

      // 收掉这一页，别把重连定时器/订阅留给下一条用例
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('补拉来的旧事件不许把锚点往回带（只增不减）', (tester) async {
      final api = await boot(tester, history: [_her(1, '历史一句'), _her(2, '历史二句')]);

      await api.push(_her(10, '最新一句'));
      // 服务端补拉时可能交叠：一条比水位小的旧事件后到
      await api.push(_her(8, '补拉重叠的旧一句'));
      await tester.pump();

      await api.drop();
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      await tester.pump();

      expect(api.anchors.last, 10, reason: '锚点只增不减——否则每补一次都要从头再补一遍');
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  group('P1-25 历史读失败：错误态 + 重试（不是「会话尚未开始」）', () {
    testWidgets('读失败 ⇒ 明确错误态 + 重试入口；点重试会再请求一次并画出来', (tester) async {
      final api = await boot(tester, historyError: '主进程没有响应');

      expect(api.historyCalls, 1);
      expect(find.text(kHistoryErrorTitle), findsOneWidget, reason: '读不到要明说读不到');
      expect(find.textContaining('主进程没有响应'), findsOneWidget, reason: '失败原因照实摆出来');
      expect(find.text('会话尚未开始'), findsNothing,
          reason: '★ "读不到"不许说成"没有"——那句只在读成功且确实为空时才能出现');
      expect(find.byKey(const ValueKey('history-retry')), findsOneWidget, reason: '要能再来一次');

      // 服务端恢复了：点「重试」⇒ 再请求一次，成功之后错误态收掉、内容上屏
      api.historyError = null;
      api.history = [_her(1, '重试之后读到了')];
      await tester.tap(find.byKey(const ValueKey('history-retry')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      expect(api.historyCalls, 2, reason: '重试必须真的再请求一次（过去这里永不重试）');
      expect(find.text(kHistoryErrorTitle), findsNothing, reason: '读成功之后错误态要收掉');
      expect(find.text('重试之后读到了'), findsOneWidget);
      expect(find.text('会话尚未开始'), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('空历史（读成功、确实没有记录）照旧说「会话尚未开始」，不是错误态', (tester) async {
      final api = await boot(tester, history: const []);

      expect(api.historyCalls, 1);
      expect(find.text('会话尚未开始'), findsOneWidget, reason: '这一句只留给真的空历史');
      expect(find.text(kHistoryErrorTitle), findsNothing, reason: '读成功就不许摆错误态');
      expect(find.byKey(const ValueKey('history-retry')), findsNothing, reason: '没有东西要重试');

      await tester.pumpWidget(const SizedBox.shrink());
    });
  });
}
