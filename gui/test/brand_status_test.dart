import 'dart:async';
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 左上角那一行字（`gui/lib/home.dart` 的 `_Brand`）与它背后的两件事：
///
///   ① **措辞**（用户 2026-10-16 ①）：她在跑 turn 时这里写「思考中」；
///      非思考时**一个字都不换**（照抄服务端的 `stateText`）。
///   ② **节奏**（用户 2026-10-16 ②）：她那边一动，这句话就跟着动——
///      不再等那 10 秒的慢档，而是由事件流（SSE）当扳机把这一读提前；
///      成串的事件合并成一次读，响应没变就**不通知**（不许靠整表重建变快）。
///
/// 这两件事都落在 [AppState] 上，所以判据类用例直接打状态对象；而"真画出来是什么字"
/// 那一条用 [HomeShell] 做 widget 测试（**不 build、不部署**也能在测试里渲染一遍）。
/// 判据本身是服务端的响应（`openTurn` + `state`），所以假 API 喂的就是
/// `/api/stats/dashboard` 的真实形状（与 `src/web/server.ts` 的 `deriveState` 同形）。

/// 真机上她跑着 turn 时那一段响应：`state:'running'` + `openTurn` 有值，
/// 服务端给的 `stateText` 正是「Agent 正在值守」。
Map<String, dynamic> runningDashboard() => <String, dynamic>{
      'state': 'running',
      'stateText': 'Agent 正在值守',
      'stateNote': '',
      'openTurn': {'turn': 7, 'step': 3},
      'tiles': {'needsReview': 0},
      'guardedDays': 12,
      'nextWakeAt': null,
      'ask': {'card': null, 'queued': 0},
    };

/// 她没在跑（空转）：这里**没有** `openTurn`。
Map<String, dynamic> idleDashboard() => <String, dynamic>{
      'state': 'idle',
      'stateText': '就绪',
      'stateNote': '',
      'openTurn': null,
      'tiles': {'needsReview': 0},
      'guardedDays': 12,
      'nextWakeAt': null,
      'ask': {'card': null, 'queued': 0},
    };

/// 一轮 turn 还开着，但预算撞线被暂停了：`openTurn` 有值，而 `state` 不是 `running`。
///
/// 这一条是"不许把暂停说成在思考"的钉子：判据里 `state == 'running'` 那一半少了，
/// 它就会被错说成「思考中」（而她其实停着等人加注）。
Map<String, dynamic> pausedDashboard() => <String, dynamic>{
      'state': 'paused',
      'stateText': '预算暂停（turn 层）',
      'stateNote': '',
      'openTurn': {'turn': 7, 'step': 3},
      'tiles': {'needsReview': 0},
      'guardedDays': 12,
      'nextWakeAt': null,
      'ask': {'card': null, 'queued': 0},
    };

class _FakeBrandApi extends IrmiaApi {
  _FakeBrandApi(this.dashboard) : super(baseUrl: 'http://127.0.0.1:1');

  Map<String, dynamic> dashboard;

  /// `/api/stats/dashboard` 被读了几次：节奏用例数它
  int dashboardCalls = 0;

  /// 事件流那条链：用例自己往里灌事件（真机上它是 SSE，250ms 一轮的尾部泵）
  final feed = StreamController<Map<String, dynamic>>.broadcast();

  /// `api.events(lastEventId:)` 每次被调用时收到的那个值——**补拉的证据**。
  ///
  /// 第 1 次是进壳那一刻（那时一条事件都还没见过 ⇒ `null`）；之后每次重连都必须是
  /// "最后见过的那条 seq"，否则服务端那条现成的补拉链路（`src/web/server.ts` 的
  /// `openStream`）就永远收不到锚点，断线窗口里的事件也就永远补不回来。
  final eventStreamCalls = <int?>[];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/stats/dashboard') {
      dashboardCalls += 1;
      return dashboard;
    }
    if (path.startsWith('/api/persona/file')) {
      return <String, dynamic>{'content': '# 我是谁\n\n我是伊尔弥亚。\n'};
    }
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async =>
      <String, dynamic>{'ok': true};

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    eventStreamCalls.add(lastEventId);
    return feed.stream;
  }

  /// 灌一条事件进那条流，并把微任务跑完（事件回调是同步的，读是异步的）
  Future<void> emit(String type) async {
    feed.add(<String, dynamic>{'type': type, 'seq': dashboardCalls + 1, 'data': const {}});
    await Future<void>.delayed(Duration.zero);
  }

  /// 灌一条**带指定 seq** 的事件（补拉用例要自己控水位）
  Future<void> emitSeq(int seq, String type) async {
    feed.add(<String, dynamic>{'type': type, 'seq': seq, 'data': const {}});
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  // 用例里不发真请求（IrmiaApi 默认走 flutter_test 的假 HttpClient，真发出去会被断言拦下）
  HttpOverrides.global = null;

  // 真机上这个窗口是 250ms；用例里缩到 50ms，测的是"成串的只重读一次"这条**行为**，
  // 不是那个数字本身（数字的出处写在 app.dart 的 kTurnSignalDebounceMs 上）。
  setUp(() => turnSignalDebounceMsOverride = 50);

  /// 建一个"已经进了壳"的状态：`ready = true` 免掉门那一套，
  /// 起点用手动 `pollOnce()` 而不是 `startPolling()`（后者会挂上那一拍——
  /// 节奏用例用 fakeAsync 自己控时，见下）。
  Future<(AppState, _FakeBrandApi)> boot(Map<String, dynamic> dashboard) async {
    final api = _FakeBrandApi(dashboard);
    final state = AppState(api: api);
    state.ready = true;
    await state.pollOnce();
    return (state, api);
  }

  group('① 左上角那一行字：思考中 / 原措辞', () {
    test('她跑着 turn ⇒ 写「思考中」；服务端原话仍留在 stateText 里', () async {
      final (state, _) = await boot(runningDashboard());
      expect(state.thinking, isTrue, reason: 'openTurn 有值且 state==running ⇒ 她在思考');
      expect(state.stateTextForBrand, '思考中');
      expect(state.stateText, 'Agent 正在值守',
          reason: '换的只是左上这一个窄位置的说法，数据本身照抄服务端');
      state.dispose();
    });

    test('她没在跑 ⇒ 一个字都不换：照抄服务端给的 stateText', () async {
      final (state, _) = await boot(idleDashboard());
      expect(state.thinking, isFalse);
      expect(state.stateTextForBrand, '就绪');
      expect(state.stateTextForBrand, state.stateText);
      state.dispose();
    });

    test('turn 还开着、但预算暂停了 ⇒ 「思考中」不成立（不许把暂停说成在思考）', () async {
      final (state, _) = await boot(pausedDashboard());
      expect(state.thinking, isFalse, reason: '判据里 state == running 那一半不可少');
      expect(state.stateTextForBrand, '预算暂停（turn 层）');
      state.dispose();
    });

    test('turn 结束 ⇒ 当场退回原措辞（不是等 10 秒那一拍）', () async {
      final (state, api) = await boot(runningDashboard());
      expect(state.stateTextForBrand, '思考中');
      api.dashboard = idleDashboard();
      await state.pollOnce();
      expect(state.thinking, isFalse);
      expect(state.stateTextForBrand, '就绪');
      state.dispose();
    });

    test('服务端那两句话之间来回一次，界面跟着来回（不粘住、不在中间态抖）', () async {
      final (state, api) = await boot(idleDashboard());
      expect(state.stateTextForBrand, '就绪');
      api.dashboard = runningDashboard();
      await state.pollOnce();
      expect(state.stateTextForBrand, '思考中');
      api.dashboard = idleDashboard();
      await state.pollOnce();
      expect(state.stateTextForBrand, '就绪');
      state.dispose();
    });

    testWidgets('真画出来：左上那一行字是「思考中」，且不是服务端那句原话', (tester) async {
      stateFileOverride = '${Directory.systemTemp.path}/irmia-brand-test.json';
      final api = _FakeBrandApi(runningDashboard());
      final state = AppState(api: api);
      state.ready = true;
      await state.pollOnce();

      await tester.pumpWidget(
        MaterialApp(
          theme: IrmiaTheme.dark(),
          home: HomeShell(state: state),
        ),
      );
      await tester.pump();

      // 断言只圈在品牌区那一列里（这一页别处也会出现服务端那句话的副本——
      // 总览页大卡就照抄它；这里要钉的是**左上角这一个位置**说的是哪句话）
      final brandColumn = find.ancestor(
        of: find.byType(BreathDot),
        matching: find.byType(Column),
      );
      expect(brandColumn, findsWidgets, reason: '品牌区那一列画出来了');

      expect(
        find.descendant(of: brandColumn.first, matching: find.text('思考中')),
        findsOneWidget,
        reason: '左上角那一行字：她在跑 turn ⇒「思考中」',
      );
      expect(
        find.descendant(of: brandColumn.first, matching: find.text('Agent 正在值守')),
        findsNothing,
        reason: '服务端那句原话不该出现在这个窄位置上',
      );
      state.dispose();
    });
  });

  group('② 思考刷新的反应速度：事件驱动 + 合并 + 变更才通知', () {
    test('思考期按快档走（不是等 10 秒），而事件一到还会再提前插一次', () {
      fakeAsync((async) {
        final api = _FakeBrandApi(idleDashboard());
        final state = AppState(api: api);
        state.ready = true;
        state.startPolling();
        async.flushMicrotasks();
        expect(api.dashboardCalls, 1, reason: '进门那一读');

        // ① 她动了：同一刻那份响应变成 running，事件流把这一读**提前**（不等慢档）
        api.dashboard = runningDashboard();
        unawaited(api.emit('turn/start'));
        async.flushMicrotasks();
        expect(api.dashboardCalls, 2, reason: '事件一到就重读，不等那 10 秒');
        expect(state.stateTextForBrand, '思考中');

        // ② 确认在跑之后，那一拍自己收到快档：4 秒里读数远多于慢档的 0 次
        final atStart = api.dashboardCalls;
        async.elapse(const Duration(seconds: 4));
        async.flushMicrotasks();
        final reads = api.dashboardCalls - atStart;
        expect(reads, greaterThanOrEqualTo(10),
            reason: '4 秒里按 250ms 一拍 ⇒ 十几读；慢档下这里是 0');
        expect(reads, lessThanOrEqualTo(25), reason: '不许变成"能多快就多快"的空转');
        state.dispose();
      });
    });

    test('成串的事件合并成一次重读，且响应没变就**不通知**（不整表重建）', () {
      fakeAsync((async) {
        final api = _FakeBrandApi(runningDashboard());
        final state = AppState(api: api);
        state.ready = true;
        state.startPolling();
        async.flushMicrotasks();

        var notifications = 0;
        state.addListener(() => notifications += 1);
        unawaited(api.emit('turn/start'));
        async.flushMicrotasks();
        async.elapse(const Duration(milliseconds: 300));
        async.flushMicrotasks();
        final before = api.dashboardCalls;
        final seen = notifications;

        // 一步里成串来的三条：窗口内一条都不读，窗口一到只补读一次
        unawaited(api.emit('step/start'));
        unawaited(api.emit('tool/call'));
        unawaited(api.emit('tool/result'));
        async.flushMicrotasks();
        expect(api.dashboardCalls, before, reason: '合并窗口里不立刻读');
        async.elapse(const Duration(milliseconds: 60));
        async.flushMicrotasks();
        expect(api.dashboardCalls, before + 1, reason: '窗口一到只补读一次');
        // 这三条读到的还是同一份 running ⇒ 字一个都没变 ⇒ **不通知**
        expect(notifications, seen, reason: '响应没变化就不该 notifyListeners');
        state.dispose();
      });
    });

    test('她停了：turn/end 一到，措辞就退回原话（仍旧不等慢档）', () {
      fakeAsync((async) {
        final api = _FakeBrandApi(runningDashboard());
        final state = AppState(api: api);
        state.ready = true;
        state.startPolling();
        async.flushMicrotasks();
        unawaited(api.emit('turn/start'));
        async.flushMicrotasks();
        expect(state.stateTextForBrand, '思考中');

        api.dashboard = idleDashboard();
        unawaited(api.emit('turn/end'));
        async.flushMicrotasks();
        // turn/end 走合并窗口那一拍（消息刚落盘，投影跟着变）
        async.elapse(const Duration(milliseconds: 60));
        async.flushMicrotasks();
        expect(state.thinking, isFalse);
        expect(state.stateTextForBrand, '就绪');
        state.dispose();
      });
    });

    test('事件流断了：不再按快档白打，但真相仍旧由响应给（措辞不粘住）', () {
      fakeAsync((async) {
        final api = _FakeBrandApi(runningDashboard());
        final state = AppState(api: api);
        state.ready = true;
        state.startPolling();
        async.flushMicrotasks();
        unawaited(api.emit('turn/start'));
        async.flushMicrotasks();

        // 链路断了：那一拍退到宽限档（3 秒），不是 250ms。
        // 先把合并窗口那一拍走完，读数才对得上（否则那 50ms 会被算进"断线后的白打"）。
        async.elapse(const Duration(milliseconds: 300));
        async.flushMicrotasks();
        unawaited(api.feed.close());
        async.flushMicrotasks();
        final atBreak = api.dashboardCalls;
        async.elapse(const Duration(milliseconds: 1500));
        async.flushMicrotasks();
        expect(api.dashboardCalls - atBreak, lessThanOrEqualTo(1),
            reason: '链断了就别按 250ms 白打');

        // 而她其实早停了：宽限档那一拍照样把真相读回来 ⇒ 措辞当场退回原话
        api.dashboard = idleDashboard();
        async.elapse(const Duration(seconds: 4));
        async.flushMicrotasks();
        expect(api.dashboardCalls, greaterThan(atBreak), reason: '宽限档照旧在读');
        expect(state.stateTextForBrand, '就绪');
        state.dispose();
      });
    });
  });

  group('③ 断线重连要带补拉锚点（用户 2026-10-16 ② 的治本那一半）', () {
    test('事件流记水位：重连时把"最后见过的 seq"当 lastEventId 交出去', () {
      fakeAsync((async) {
        final api = _FakeBrandApi(idleDashboard());
        final state = AppState(api: api);
        state.ready = true;
        state.startPolling();
        async.flushMicrotasks();

        // 进壳那一刻一条事件都还没见过：锚点是 null（服务端会当作"从头开始"）
        expect(api.eventStreamCalls, hasLength(1));
        expect(api.eventStreamCalls.first, isNull, reason: '还没见过任何事件');

        // 见过几条：水位跟着涨
        unawaited(api.emitSeq(41, 'turn/start'));
        unawaited(api.emitSeq(42, 'step/start'));
        async.flushMicrotasks();

        // 断了 ⇒ 3 秒后重连（`_scheduleEventsRetry`）
        unawaited(api.feed.close());
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 4));
        async.flushMicrotasks();

        expect(api.eventStreamCalls, hasLength(2), reason: '断线之后重连了一次');
        expect(api.eventStreamCalls.last, 42,
            reason: '★ 重连必须带"最后见过的那条 seq"——不带的话服务端补不了 '
                '（`src/web/server.ts` 的 openStream 认 Last-Event-ID），'
                '断线窗口里那条 turn/end 就永远丢了');
        state.dispose();
      });
    });

    test('补拉来的**旧**事件不许把水位往回带（否则每补一次都要重补一遍）', () {
      fakeAsync((async) {
        final api = _FakeBrandApi(idleDashboard());
        final state = AppState(api: api);
        state.ready = true;
        state.startPolling();
        async.flushMicrotasks();

        unawaited(api.emitSeq(100, 'step/start'));
        async.flushMicrotasks();
        // 服务端补拉时会把 (锚点, 当前] 那一段**按 seq 升序**重发，但网络抖动下也可能交叠：
        // 这里直接灌一条比水位小的，验证"只增不减"
        unawaited(api.emitSeq(80, 'turn/start'));
        async.flushMicrotasks();

        unawaited(api.feed.close());
        async.flushMicrotasks();
        async.elapse(const Duration(seconds: 4));
        async.flushMicrotasks();

        expect(api.eventStreamCalls.last, 100, reason: '水位只增不减');
        state.dispose();
      });
    });

    test('openTurn 与 thinking 一起暴露：那是"服务端认为这一轮结束了"的判据', () async {
      final api = _FakeBrandApi(runningDashboard());
      final state = AppState(api: api);
      state.ready = true;
      await state.pollOnce();
      expect(state.thinking, isTrue);
      expect(state.openTurn, '7', reason: '服务端说 turn 7 还开着');

      api.dashboard = idleDashboard();
      await state.pollOnce();
      expect(state.thinking, isFalse);
      expect(state.openTurn, isNull, reason: '服务端说没有开着的 turn 了');
      state.dispose();
    });
  });

  // ───────────── ④ 同一份 dashboard 连喂两遍只通知一次（P1-24） ─────────────
  //
  // 代价（REVIEW P1-24）：`_readDashboard` 用 `identical` 比 `ask.cards`，而那个 List
  // 每次从 JSON 解析都是**新建**的 ⇒ 恒判"变了" ⇒ 250ms 快档里每秒 `notifyListeners`
  // 4 次，整棵 `MaterialApp` 跟着重建。修法是**按值比**（`AskCardData` 的 `==` +
  // `listEquals`），所以这一组钉两件事：同值不通知、变了照旧通知。

  /// 真实响应的 `ask` 形状（`src/web/server.ts` 的 `askCardOf`）：`cards` **永远是个
  /// List**，哪怕为空；每次 JSON 解析都会新建一个。这里刻意走这条真实形状——
  /// 只看 `{card: null, queued: 0}` 的老夹具比不出"引用不同但值相同"。
  Map<String, dynamic> withAsk({
    required int seq,
    required String question,
    String context = '最近三天没整理过',
    int queued = 1,
  }) =>
      <String, dynamic>{
        ...idleDashboard(),
        'ask': <String, dynamic>{
          'cards': <dynamic>[
            <String, dynamic>{
              'seq': seq,
              'question': question,
              'context': context,
              'expiredAt': null,
            },
          ],
          'queued': queued,
        },
      };

  group('④ dashboard 变更才通知（P1-24：同一份数据连喂两遍 ⇒ 通知一次）', () {
    test('`ask.cards` 换了新 List 但值没变 ⇒ 第二遍不通知', () async {
      final api = _FakeBrandApi(withAsk(seq: 7, question: '要不要现在整理记忆？'));
      final state = AppState(api: api);
      state.ready = true;
      var notifications = 0;
      state.addListener(() => notifications += 1);

      await state.pollOnce();
      expect(notifications, 1, reason: '第一份读数：从无到有，通知一次');

      await state.pollOnce();
      expect(api.dashboardCalls, 2, reason: '真的读了两遍');
      expect(notifications, 1,
          reason: '同一份数据再喂一遍：cards 是新的 List、值没变 ⇒ 不许通知'
              '（按引用比的话这里恒为 true，250ms 快档里每秒重建整棵树 4 次）');
      state.dispose();
    });

    test('卡真的变了 ⇒ 照旧通知（省重建不等于把变化也吞了）', () async {
      final api = _FakeBrandApi(withAsk(seq: 7, question: '要不要现在整理记忆？'));
      final state = AppState(api: api);
      state.ready = true;
      var notifications = 0;
      state.addListener(() => notifications += 1);

      await state.pollOnce();
      expect(notifications, 1);

      api.dashboard = withAsk(seq: 7, question: '现在要不要整理记忆？');
      await state.pollOnce();
      expect(notifications, 2, reason: '问题那一格变了 ⇒ 必须通知');

      await state.pollOnce();
      expect(notifications, 2, reason: '再喂同一份（第三遍）⇒ 又不通知');
      state.dispose();
    });

    testWidgets('widget 层：同一份读数连喂两遍，订阅它的那棵树只重建一次', (tester) async {
      final api = _FakeBrandApi(withAsk(seq: 7, question: '要不要现在整理记忆？'));
      final state = AppState(api: api);
      state.ready = true;
      var builds = 0;

      await tester.pumpWidget(MaterialApp(
        theme: IrmiaTheme.dark(),
        home: AnimatedBuilder(
          animation: state,
          builder: (context, _) {
            builds += 1;
            return const SizedBox.shrink();
          },
        ),
      ));
      expect(builds, 1, reason: '首帧');

      await state.pollOnce();
      await tester.pump();
      expect(builds, 2, reason: '第一份读数到了 ⇒ 重建一次');

      await state.pollOnce();
      await tester.pump();
      expect(builds, 2, reason: '同一份读数再喂一遍：内容没变 ⇒ 一帧都不多画');

      // 反方向：卡真的变了 ⇒ 那棵树必须重建（省重建不等于把变化吞掉）
      api.dashboard = withAsk(seq: 7, question: '现在要不要整理记忆？');
      await state.pollOnce();
      await tester.pump();
      expect(builds, 3, reason: '值变了 ⇒ 照旧通知、照旧重建');

      // 先把树拆掉再 dispose，免得监听方在 dispose 之后还来 removeListener
      await tester.pumpWidget(const SizedBox.shrink());
      state.dispose();
    });
  });
}
