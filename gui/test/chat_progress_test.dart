import 'dart:async';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/chat_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 用户 2026-10-16 三条（与「思考中」那一行同一片区域，一起落的）：
///
///   ① **聊天页默认不自动滚动**——她说话、工具卡片更新都不许把视图拽到底；
///      唯一的例外是**用户自己发消息**（那是他的动作）。
///   ② **「跳到最新」那颗按钮**——①的配套：没有它，默认不滚动就等于"她说了什么
///      人永远不知道"。不在底部时露出来，有新内容时亮一个小点。
///   ③ **工具输出里的 ANSI 装饰要剥掉**——截图里那行 `[32;1mName[0m…`。
///
/// 外加那行进度本身的读数（步号/字数/计时/节流/不移位）。

/// 事件流可控的假 API（其余端点给最小可渲染的形状）。
class _FakeChatApi extends IrmiaApi {
  _FakeChatApi() : super(baseUrl: 'http://127.0.0.1:1');

  final feed = StreamController<Map<String, dynamic>>.broadcast();

  /// 进页面时取的那一页历史（默认空：省掉"滚动到底"那一段，用例自己灌）
  List<Map<String, dynamic>> history = const [];

  int seq = 0;

  /// `/api/stats/dashboard` 的响应（② 的收尾对账要用它）。
  ///
  /// 默认写成"她没在跑、也没有开着的 turn"——**这是本用例集里最该小心的一个默认值**：
  /// `ChatPage` 会拿它去对账（见 `_reconcileThinking`），默认给 `running` 的话
  /// 那些"她不在想"的断言会被对账搅乱。所以默认按空转给，要跑的用例自己换。
  Map<String, dynamic> dashboard = <String, dynamic>{
    'state': 'idle',
    'stateText': '待机',
    'stateNote': '',
    'openTurn': null,
    'tiles': <String, dynamic>{'needsReview': 0},
    'guardedDays': 1,
    'nextWakeAt': null,
    'ask': <String, dynamic>{'card': null, 'queued': 0},
  };

  /// 把实时事件的 seq 指针挪到历史之后（见 [bootChat] 里那段注释）
  void startAfterHistory() {
    var max = 0;
    for (final item in history) {
      final value = item['seq'];
      if (value is num && value.toInt() > max) max = value.toInt();
    }
    seq = max;
  }

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path.startsWith('/api/events?')) {
      return <String, dynamic>{'events': history};
    }
    if (path == '/api/stats/dashboard') return dashboard;
    if (path.startsWith('/api/persona/file')) {
      return <String, dynamic>{'content': '# 我是谁\n\n我是伊尔弥亚。\n'};
    }
    if (path == '/api/sessions') return <String, dynamic>{'contacts': <String, dynamic>{}};
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async =>
      <String, dynamic>{'ok': true};

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => feed.stream;

  /// 灌一条**实时**事件（走 SSE 那条路，`seq` 自增以保证不被去重丢掉）。
  ///
  /// 等的是 `Future.value()` 而不是 `Future.delayed(Duration.zero)`：后者在
  /// `testWidgets` 的假时钟下是一个**永不触发的定时器**——用例会在这里死等，
  /// 表现为整条用例挂到 runner 超时（实测踩到过，一开始还以为是动效不静止）。
  /// `Future.value` 只排一个微任务，`tester.pump()` 就会把它排干。
  Future<void> emit(String type, [Map<String, dynamic> data = const {}]) async {
    seq += 1;
    feed.add(<String, dynamic>{'type': type, 'seq': seq, 'data': data});
    await Future<void>.value();
  }
}

/// 一条她的消息（走 `message/assistant`：那是**能上屏**的那种，见 `_consume`）
Map<String, dynamic> herBubble(int seq, String text) => <String, dynamic>{
      'type': 'message/assistant',
      'seq': seq,
      'ts': '2026-10-16T10:00:00.000Z',
      'data': <String, dynamic>{'text': text, 'toolCalls': <dynamic>[]},
    };

void main() {
  HttpOverrides.global = null;

  setUp(() {
    stateFileOverride = '${Directory.systemTemp.path}/irmia-chat-progress-test.json';
  });

  tearDown(() => stateFileOverride = null);

  /// 起一页聊天：准备好 `AppState`（免掉门那一套），把 [ChatPage] 挂上去。
  ///
  /// 两处**必须**这样摆（都是实测撞出来的）：
  ///   · `Scaffold` 兜住它：这一页里的 `TextField` 要一个 Material 祖先，
  ///     不套就抛 `debugCheckHasMaterial`，而且 Column 会量出天文数字（实测溢出 99507px）；
  ///   · **用例里一律用 `pump(时长)`，不用 `pumpAndSettle`**：那一行的呼吸动效是
  ///     `repeat()` 的——它在的时候永远"settle"不了，`pumpAndSettle` 会一直转到超时。
  ///     （这也正是动效只在那一行**可见**时才跑的理由：藏起来就 `TickerMode` 停掉，
  ///     否则整页都跟着永远不静止。）
  Future<_FakeChatApi> bootChat(
    WidgetTester tester, {
    List<Map<String, dynamic>> history = const [],
  }) async {
    final api = _FakeChatApi()..history = history;
    // **实时事件的 seq 必须接在历史之后**：`_consume` 按 seq 去重（同一条事件从"历史"与
    // "流"两条路进来只画一次），从 1 重新数的话，第一条实时事件会被当成历史里那条
    // 而**整条丢掉**（实测：`added=false`，于是"她说话了"这件事在界面上没有发生）。
    api.startAfterHistory();
    final state = AppState(api: api);
    state.ready = true;
    addTearDown(state.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: IrmiaTheme.light(),
        home: Scaffold(body: ChatPage(state: state)),
      ),
    );
    // 历史那一次读是异步的：给两拍让它落下来（不用 pumpAndSettle，理由见上）
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return api;
  }

  // ─────────────────────────── 那一行进度本身 ───────────────────────────

  group('进度行：读数', () {
    test('用时格式 M:SS：0:07 / 1:20 / 12:03（秒补零、分不补零）', () {
      expect(formatThinkingElapsed(const Duration(seconds: 7)), '0:07');
      expect(formatThinkingElapsed(const Duration(seconds: 80)), '1:20');
      expect(formatThinkingElapsed(const Duration(minutes: 12, seconds: 3)), '12:03');
      expect(formatThinkingElapsed(Duration.zero), '0:00');
      // 超过一小时照走分（61:05 而不是 1:01:05）：多出一个小时位会让那一行变宽
      expect(formatThinkingElapsed(const Duration(hours: 1, minutes: 1, seconds: 5)), '61:05');
      // 时钟被人往后调过也不显示负数
      expect(formatThinkingElapsed(const Duration(seconds: -5)), '0:00');
    });

    test('整行文案紧凑：思考中 · 第 N 步 · 已想 X 字 · 用时', () {
      final p = ThinkingProgress(
        turn: 7,
        step: 3,
        chars: 152,
        since: DateTime.now().subtract(const Duration(seconds: 80)),
        phase: ThinkCharsPhase.counted,
      );
      final line = thinkingLine(p);
      expect(line, contains('思考中'));
      expect(line, contains('第  3 步'), reason: '步号补到两位，避免她走到第 10 步时那行变宽');
      expect(line, contains('152 字'));
      expect(line, contains('用时 1:20'));
    });

    test('正文还没落库时**不报假的 0**：那一格是「…」而不是「已想 0 字」', () {
      // 后端一步跑完才发整段推理正文（agent-loop.ts:1451-1454），所以等待期间
      // 界面手上一个字都没有——这时报 0 就是个假读数（用户截图里那一条）。
      final p = ThinkingProgress(
        turn: 7,
        step: 1,
        chars: 0,
        since: DateTime.now().subtract(const Duration(seconds: 27)),
      );
      final line = thinkingLine(p);
      expect(line, contains('已想'), reason: '那一格还在（位置稳定），只是没数');
      expect(line, contains('…'), reason: '没数就说没数');
      expect(line, isNot(contains('0 字')), reason: '**任何时刻都不许出现「已想 0 字」**');
      expect(line, contains('用时 0:27'), reason: '秒表照走（那是真读数）');
    });

    test('上万的推理正文换成「万字」量级：62854 ⇒ 6.3 万字', () {
      expect(formatThinkingChars(980), '980');
      expect(formatThinkingChars(9999), '9999');
      expect(formatThinkingChars(10000), '1.0 万字');
      expect(formatThinkingChars(62854), '6.3 万字');
      expect(formatThinkingChars(1000000), '100 万字');
    });

    test('这一格报不报数只看 phase：pending 不报，live / counted 都报', () {
      // `live` 是给后端那条 (b) 进度事件留的接口（用户 2026-10-16 已批：
      // "有进度事件就用它、没有就显示落库后的真值"）：界面这一侧只有这一处判据，
      // 将来那条事件落地时**不必改这里**。
      expect(reportsChars(ThinkCharsPhase.pending), isFalse);
      expect(reportsChars(ThinkCharsPhase.live), isTrue);
      expect(reportsChars(ThinkCharsPhase.counted), isTrue);
      // 三态同一个形状：live 与 counted 出来的字长得一模一样（那一行宽度不跳）
      ThinkingProgress at(ThinkCharsPhase phase) => ThinkingProgress(
            turn: 1,
            step: 1,
            chars: 62854,
            since: DateTime.now(),
            phase: phase,
          );
      final live = thinkingLine(at(ThinkCharsPhase.live));
      final counted = thinkingLine(at(ThinkCharsPhase.counted));
      expect(live, counted, reason: '后端进度事件与落库真值在界面上是同一个形状');
      expect(live, contains('6.3 万字'));
    });
  });

  group('进度行：随事件更新 / 停止条件', () {
    testWidgets('turn/start + step/start + reasoning ⇒ 步号与字数上屏；turn/end ⇒ 整行隐藏', (tester) async {
      final api = await bootChat(tester);

      // 她不在想：那一行**一个字都不显示**（不是显示"空闲"）
      expect(find.textContaining('思考中'), findsNothing);

      await api.emit('turn/start', <String, dynamic>{'turn': 7});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsOneWidget, reason: 'turn/start ⇒ 那一行出现');
      expect(find.textContaining('第  0 步'), findsOneWidget);

      await api.emit('step/start', <String, dynamic>{'turn': 7, 'step': 2});
      await api.emit('message/reasoning', <String, dynamic>{'turn': 7, 'step': 2, 'text': '先看目录'});
      await api.emit('message/reasoning', <String, dynamic>{'turn': 7, 'step': 2, 'text': '再看文件'});
      await tester.pump();
      await _settle(tester);
      expect(find.textContaining('第  2 步'), findsOneWidget, reason: '步号来自 step/start');
      // 字数补到四位（`   8`）：所以断言"这几个字都在"，不写死中间有几个空格
      expect(find.textContaining('已想'), findsOneWidget);
      expect(find.textContaining('8 字'), findsOneWidget, reason: '两段推理各 4 字');

      await api.emit('turn/end', <String, dynamic>{'turn': 7});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsNothing, reason: 'turn/end ⇒ 整行隐藏');
    });

    testWidgets('没有 turn/start 的现场（界面中途打开）：reasoning 自己把这一行立起来', (tester) async {
      final api = await bootChat(tester);
      await api.emit('message/reasoning', <String, dynamic>{'turn': 9, 'step': 4, 'text': '接手'});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsOneWidget);
      expect(find.textContaining('第  4 步'), findsOneWidget, reason: '步号由这条事件带着');
      expect(find.textContaining('2 字'), findsOneWidget);
    });

    testWidgets('等待期那一行说「已想 …」**不说「已想 0 字」**；推理落库后换成真读数', (tester) async {
      // 用户 2026-10-16 ① 的原话是「这里不能是实时的吗？」——查清的实情是后端
      // **一步跑完才发整段**（agent-loop.ts:1451-1454），所以等待期界面手上一个字都没有。
      // 这一条钉的就是"没有数时不许报 0、有数时报真数"这条口径。
      //
      // ★ 2026-10-17 起后端补上了那段等待：每 5 秒一条 `step/reasoning-progress`（实时字数），
      // 见下面那一组。但**这一态照旧存在**——它是"这一格此刻**还没有任何读数**"那一小段
      // （那一步的前 5 秒、或者那条事件压根没到）。所以这条用例一个字都没改。
      final api = await bootChat(tester);
      await api.emit('turn/start', <String, dynamic>{'turn': 5});
      await api.emit('step/start', <String, dynamic>{'turn': 5, 'step': 1});
      await _settle(tester);

      // ① 等待期：她确实在想（那一行在），但那格**没有数**
      expect(find.textContaining('思考中'), findsOneWidget, reason: '她确实在想');
      expect(find.textContaining('已想'), findsOneWidget, reason: '那一格的位置还在');
      expect(find.textContaining('已想    … 字'), findsOneWidget, reason: '没数就说没数');
      expect(find.textContaining('0 字'), findsNothing,
          reason: '**用户截图里那个假的「已想 0 字」不许再出现**');

      // ② 那一步的推理落库 ⇒ 同一格换成真读数
      await api.emit('message/reasoning',
          <String, dynamic>{'turn': 5, 'step': 1, 'text': 'x' * 62854});
      await _settle(tester);
      expect(find.textContaining('6.3 万字'), findsOneWidget, reason: '落库后报真数');
      expect(find.textContaining('… 字'), findsNothing, reason: '有数了就不再是占位');
    });

    testWidgets('「用时」自己每秒走——**没有事件也必须动**（那是本机时钟的真读数）', (tester) async {
      // 这一条钉的是 ① 的另一半：那一行过去只在"被认的事件"到达时重画，而实测
      // turn 2115 从 step/start @11:41:57 到那一步的推理 @11:44:30 之间**一条事件都没有**
      // ⇒ 「用时」会整整冻 153 秒（用户截图里那个 0:27 就是这么来的）。
      // 所以那一行必须自带一条每秒节拍（见 `_ThinkingRowState._beat`）。
      //
      // ★ 驯服时钟的写法（否则这条测不了）：`DateTime.now()` 在用例里读的是**真实墙钟**，
      // `tester.pump(3 秒)` 推不动它 ⇒ 读数永远是 0:00，而那正是"看起来像没修好"的假象。
      // 所以把 flutter_test 自己那只**随 pump 前进的假钟**（`binding.clock`，
      // 起点 `DateTime.utc(2015)`、`pump(时长)` 就 elapse 多少）灌进 `clock` 作用域
      // （`ThinkingProgress.elapsed` 读的是 `clock.now()`，见它的注释）。
      await withClock(tester.binding.clock, () async {
        final api = await bootChat(tester);
        await api.emit('turn/start', <String, dynamic>{'turn': 6});
        await api.emit('step/start', <String, dynamic>{'turn': 6, 'step': 1});
        await _settle(tester);
        expect(find.textContaining('用时 0:00'), findsOneWidget, reason: '刚开口那一刻');

        // **一条事件都不发**，只让时间过去三秒
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));
        await tester.pump(const Duration(seconds: 1));

        expect(find.textContaining('用时 0:00'), findsNothing,
            reason: '三秒过去了，读数不该还是 0:00（那就是"冻住了"）');
        expect(find.textContaining('用时 0:03'), findsOneWidget,
            reason: '那一行自己走的秒表：0:00 → 0:03');
      });
    });

    testWidgets('她不在想的时候不空转：那条每秒节拍是停掉的', (tester) async {
      // 代价纪律：藏起来的东西不该继续占着每一帧（与 TickerMode 给呼吸点的理由同一条）。
      final api = await bootChat(tester);
      await api.emit('turn/start', <String, dynamic>{'turn': 8});
      await _settle(tester);
      await api.emit('turn/end', <String, dynamic>{'turn': 8});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsNothing);

      // 这一行没了之后，那条 periodic 定时器必须已经取消——否则这一页会永远有一个
      // pending timer（`flutter test` 会在用例结束时把这种泄漏报出来）。
      await tester.pump(const Duration(seconds: 5));
      expect(find.textContaining('思考中'), findsNothing);
    });

    testWidgets('进入页面时取的历史里那些 turn/reasoning **不算**（否则一进来就报假进度）', (tester) async {
      await bootChat(tester, history: [
        herBubble(1, '上一条'),
        <String, dynamic>{
          'type': 'turn/start',
          'seq': 2,
          'data': <String, dynamic>{'turn': 3},
        },
        <String, dynamic>{
          'type': 'message/reasoning',
          'seq': 3,
          'data': <String, dynamic>{'turn': 3, 'step': 1, 'text': '很久以前想过的一段'},
        },
      ]);
      expect(find.textContaining('思考中'), findsNothing,
          reason: '历史里那一轮早结束了，不该被当成"她正在想"');
    });
  });

  // ─────────── 后端 (b) 实时字数：`step/reasoning-progress`（2026-10-17） ───────────
  //
  // 用户的原话是「让界面那行「已想 X 字」在**推理落库之前**也是真的」。后端补的那条事件
  // 只带 `{turn, step, chars}`——**一个字的正文都没有**；界面这一侧只有**一处**接线
  // （`ChatPageState._trackThinking` 里那个 case），把它接进 [ThinkCharsPhase.live]。
  // 这一组钉三件事：**落库前**那一格真的有数、落库后的真值覆盖它、`turn/end` 照旧整行收掉。
  group('后端 (b) 实时字数：落库前那一格也是真的', () {
    testWidgets('进度事件一到，**推理还没落库**那一行就报出真读数（从「…」变成数）', (tester) async {
      final api = await bootChat(tester);
      await api.emit('turn/start', <String, dynamic>{'turn': 7});
      await api.emit('step/start', <String, dynamic>{'turn': 7, 'step': 1});
      await _settle(tester);
      expect(find.textContaining('已想    … 字'), findsOneWidget, reason: '还没有任何读数：占位');

      // 后端第一拍（它那一步的前 5 秒之后）：只有数字，没有正文
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 7, 'step': 1, 'chars': 1234});
      await _settle(tester);
      expect(find.textContaining('1234 字'), findsOneWidget,
          reason: '**正文一个字都没来过**，但那一格已经是真读数');
      expect(find.textContaining('… 字'), findsNothing, reason: '有数了就不再是占位');

      // 后端的下一拍：读数一路涨（上万换成万字量级，那一行的宽度与 counted 完全同形）
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 7, 'step': 1, 'chars': 62854});
      await _settle(tester);
      expect(find.textContaining('6.3 万字'), findsOneWidget);
      expect(find.textContaining('1234 字'), findsNothing, reason: '换的是读数，不是又加了一行');
    });

    testWidgets('落库后的 counted 覆盖 live（真值优先）；真值到手后旧 live 不许把它拉回去', (tester) async {
      final api = await bootChat(tester);
      await api.emit('turn/start', <String, dynamic>{'turn': 11});
      await api.emit('step/start', <String, dynamic>{'turn': 11, 'step': 1});
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 11, 'step': 1, 'chars': 3000});
      await _settle(tester);
      expect(find.textContaining('3000 字'), findsOneWidget, reason: '落库之前：live 读数');

      // 一步跑完，整段真值落库 ⇒ 那一格换成真数（它是 delta 之和的对账，可能差一点）
      await api.emit('message/reasoning',
          <String, dynamic>{'turn': 11, 'step': 1, 'text': 'x' * 3100});
      await _settle(tester);
      expect(find.textContaining('3100 字'), findsOneWidget, reason: 'counted 覆盖 live');
      expect(find.textContaining('3000 字'), findsNothing);

      // SSE 补拉/后到的旧 live 事件：不许把已经到手的真值拉回去
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 11, 'step': 1, 'chars': 3000});
      await _settle(tester);
      expect(find.textContaining('3100 字'), findsOneWidget, reason: '**真值优先**：旧 live 不许回退');
      expect(find.textContaining('3000 字'), findsNothing);
    });

    testWidgets('turn/end 照旧把那一行整个收掉（不是停在最后一个读数上）', (tester) async {
      final api = await bootChat(tester);
      await api.emit('turn/start', <String, dynamic>{'turn': 15});
      await api.emit('step/start', <String, dynamic>{'turn': 15, 'step': 1});
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 15, 'step': 1, 'chars': 500});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsOneWidget, reason: '有读数的时候那一行当然在');

      await api.emit('turn/end', <String, dynamic>{'turn': 15});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsNothing, reason: 'turn/end ⇒ 整行隐藏');
      expect(find.textContaining('500 字'), findsNothing, reason: '读数也跟着一起收掉');
    });

    testWidgets('没有 turn/start 的现场（界面中途打开/SSE 重连）：由这条事件自己把那一行立起来', (tester) async {
      // 这正是用户截图那个场景：她已经开始想了，页面才打开——流里第一条不是 turn/start。
      // 不立的话这条事件白到手，那一行还是空的，而"她想了很久"恰恰是最该看见的时候。
      final api = await bootChat(tester);
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 21, 'step': 3, 'chars': 800});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsOneWidget, reason: '这条事件把那一轮立起来了');
      expect(find.textContaining('第  3 步'), findsOneWidget, reason: '步号由它带着');
      expect(find.textContaining('800 字'), findsOneWidget);
    });

    testWidgets('`chars: 0` 不是读数：不许点亮那一行，更不许出现「已想 0 字」', (tester) async {
      final api = await bootChat(tester);
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 22, 'step': 1, 'chars': 0});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsNothing, reason: '0 不是读数，立不起来');
      expect(find.textContaining('0 字'), findsNothing, reason: '**任何时刻都不许出现「已想 0 字」**');

      // 反面：同一轮里真来了一个正数 ⇒ 照旧立起来（上一条不是"整条事件被忽略"）
      await api.emit('step/reasoning-progress', <String, dynamic>{'turn': 22, 'step': 1, 'chars': 40});
      await _settle(tester);
      expect(find.textContaining('40 字'), findsOneWidget);
    });
  });

  // ─────────────── ② 待机时"思考中"粘住（用户 2026-10-16 ②） ───────────────
  //
  // 实测根因（不是显示问题，是刷新链的洞）：那一行的显隐**只认事件**，只有 `turn/end`
  // 会让它收掉；而 SSE 重连时断线窗口里那条 `turn/end` 补不回来 ⇒ **它会一直挂着**。
  // 修法是**服务端的话当兜底**：`/api/stats/dashboard` 当次读数说"没有开着的 turn、
  // 也没在跑"（`openTurn == null && thinking == false`）就把那一行收掉——
  // 判据仍旧只有服务端一处，界面不猜时间窗。

  /// 让她"已经在想了一会儿"：把那一行的起点往前拨，越过收尾对账的宽限期
  /// （[thinkingServerGraceMs]）。为什么必须拨：宽限期是抗"新轮误杀"的，
  /// 而这两个用例要测的是"她真的早停了"，所以先把时间往回拨到宽限期之外。
  void ageTheRow(WidgetTester tester) {
    final page = tester.state<ChatPageState>(find.byType(ChatPage));
    page.thinkingStartedAtForTest = clock.now().subtract(
      Duration(milliseconds: thinkingServerGraceMs + 200),
    );
  }

  /// 走一遍**真机那条链**：读一次 dashboard（真机由心跳/事件驱动）⇒ 页面就着这份读数对账。
  ///
  /// 为什么要在用例里显式调这一步：`pollOnce()` 只在**响应真的变了**时才 `notifyListeners`
  /// （那是"不许靠更频繁地整表重建"那条纪律），所以"同一份空转读数读第二遍"不会触发监听。
  /// 这里按真机的次序走：先让 `AppState` 收下服务端的话，再让它去对账。
  Future<void> readDashboardAndReconcile(WidgetTester tester) async {
    final page = tester.state<ChatPageState>(find.byType(ChatPage));
    await page.widget.state.pollOnce();
    page.reconcileThinking();
  }

  // ── 三个点那一格（用户 2026-10-16「停了之后这个思考符号还是存在」） ──
  //
  // 为什么要这几条而不是"断言文字为空"：那一行过去**文字与点是两套显隐**——
  // 文字靠被置成空串，点靠自己的 `Opacity` 呼吸。所以"文字没了"**完全不代表**"点没了"，
  // 实测就是这么翻车的：`turn/end` 之后 `FadeTransition` 冻在 1.000、
  // 三个点的 `Opacity` 还是 `[0.96, 0.73, 0.51]`，屏上只剩"•••"。

  /// 那三个点那一格（`SizedBox(18×16)`，见 [BreathingDots.build]）
  Finder dotsBox() =>
      find.byWidgetPredicate((w) => w is SizedBox && w.width == 18 && w.height == 16);

  /// 那一行当刻**画不画**——判据是"包着点的那一层 `Offstage` 收掉了没有"。
  ///
  /// 这是"一个像素都不留"的**硬判据**：`Offstage` 为真时 Flutter **根本不绘制**那棵子树
  /// （不是"透明度 0、大概看不见"）。比"找得到/找不到那几个点"强：点在树上但被 offstage
  /// 收掉，与"点在树上且真的画出来"必须分得开。
  bool thinkingRowPaints(WidgetTester tester) {
    for (final element in find.byType(Offstage).evaluate()) {
      final w = element.widget as Offstage;
      if (w.offstage) continue; // 收掉了 ⇒ 这一棵不画
      final finder = find.byWidget(w);
      if (find.descendant(of: finder, matching: dotsBox()).evaluate().isNotEmpty) {
        return true;
      }
    }
    return false;
  }

  group('② 待机粘住：服务端说这轮结束了，那一行就收掉', () {
    testWidgets('`turn/end` **丢了**（SSE 断线窗口）⇒ 服务端读数照样把它收掉', (tester) async {
      await withClock(tester.binding.clock, () async {
        final api = await bootChat(tester);
        // 她开口了：本机从事件流知道"她在想"（这一行立起来了）
        api.dashboard = <String, dynamic>{
          'state': 'running',
          'stateText': 'Agent 正在值守',
          'stateNote': '',
          'openTurn': <String, dynamic>{'turn': 12, 'step': 1},
          'tiles': <String, dynamic>{'needsReview': 0},
          'guardedDays': 1,
          'nextWakeAt': null,
          'ask': <String, dynamic>{'card': null, 'queued': 0},
        };
        await api.emit('turn/start', <String, dynamic>{'turn': 12});
        await api.emit('step/start', <String, dynamic>{'turn': 12, 'step': 1});
        await _settle(tester);
        expect(find.textContaining('思考中'), findsOneWidget, reason: '她开口了');

        // 这一轮结束了，但**那条 `turn/end` 事件永远没到**（断线窗口里丢的）。
        // 界面手上只剩一个"她还在想"的本地状态——过去它会一直挂着。
        api.dashboard = <String, dynamic>{
          'state': 'idle',
          'stateText': '待机',
          'stateNote': '',
          'openTurn': null,
          'tiles': <String, dynamic>{'needsReview': 0},
          'guardedDays': 1,
          'nextWakeAt': null,
          'ask': <String, dynamic>{'card': null, 'queued': 0},
        };
        ageTheRow(tester);
        // 事件流外的第二条真相来源：一次 dashboard 读（真机上由心跳/事件驱动）
        await readDashboardAndReconcile(tester);
        await _settle(tester);

        expect(find.textContaining('思考中'), findsNothing,
            reason: '★ 服务端说这一轮已经结束了 ⇒ 那一行必须收掉（不再粘住）');
      });
    });

    testWidgets('她**真的还在跑**时，对账不许把它误杀', (tester) async {
      await withClock(tester.binding.clock, () async {
        final api = await bootChat(tester);
        api.dashboard = <String, dynamic>{
          'state': 'running',
          'stateText': 'Agent 正在值守',
          'stateNote': '',
          'openTurn': <String, dynamic>{'turn': 13, 'step': 2},
          'tiles': <String, dynamic>{'needsReview': 0},
          'guardedDays': 1,
          'nextWakeAt': null,
          'ask': <String, dynamic>{'card': null, 'queued': 0},
        };
        await api.emit('turn/start', <String, dynamic>{'turn': 13});
        await api.emit('step/start', <String, dynamic>{'turn': 13, 'step': 2});
        await _settle(tester);
        ageTheRow(tester);
        await readDashboardAndReconcile(tester);
        await _settle(tester);

        expect(find.textContaining('思考中'), findsOneWidget,
            reason: '服务端说还在跑 ⇒ 那一行一个字都不许动');
      });
    });

    testWidgets('服务端还没确认（宽限期内）不许误杀刚立起来的那一行', (tester) async {
      // 默认 dashboard 就是空转（见 _FakeChatApi.dashboard），而她**刚**开口——
      // 服务端那一拍可能还停在上一轮。没有宽限期的话，这条会闪一下又没。
      //
      // 为什么把窗口放宽：真机 600ms 在假时钟下与"几拍 UI 布局"是同一个尺度
      // （`_settle` 一跑就把 600ms 走完了），于是"窗口内该不该收"根本测不到。
      // 放宽之后就能明确地分两次读：窗口内不许收、推过窗口必须收。
      thinkingServerGraceMsOverride = 5000;
      addTearDown(() => thinkingServerGraceMsOverride = null);
      await withClock(tester.binding.clock, () async {
        final api = await bootChat(tester);
        await api.emit('turn/start', <String, dynamic>{'turn': 14});
        await _settle(tester);
        await readDashboardAndReconcile(tester);
        await _settle(tester);

        expect(find.textContaining('思考中'), findsOneWidget,
            reason: '宽限期内不许把"她刚开口"对账掉（服务端那一拍可能还没跟上）');

        // 把时间推过宽限期：**同一条读数**这次必须落实（她是真的停了）
        await tester.pump(const Duration(seconds: 6));
        await readDashboardAndReconcile(tester);
        await _settle(tester);
        expect(find.textContaining('思考中'), findsNothing,
            reason: '过了宽限期，服务端那句"没在跑"必须落实');
      });
    });
  });

  group('② 整行同进同出：点与文字一起出现、一起消失（用户 2026-10-16 那张截图）', () {
    testWidgets('待机 ⇒ **点也不许留在屏上**（不是"文字没了就算"）', (tester) async {
      // 用户原话：「停了之后这个思考符号还是存在」——截图里文字已经没了，
      // 但输入框上方左侧还孤零零留着"•••"。所以要断言的是**整行不画**，不是"文字为空"。
      final api = await bootChat(tester);

      // 她开口：点与文字**同时在**
      await api.emit('turn/start', <String, dynamic>{'turn': 21});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsOneWidget, reason: '文字在');
      expect(dotsBox(), findsOneWidget, reason: '点在');
      expect(thinkingRowPaints(tester), isTrue, reason: '两样都真的画着');

      // `turn/end` ⇒ **整行收掉**（点必须跟着走）
      await api.emit('turn/end', <String, dynamic>{'turn': 21});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsNothing, reason: '文字没了');
      expect(thinkingRowPaints(tester), isFalse,
          reason: '★ 点也必须不画了——"三个点孤零零留在那儿"正是用户报的那件事');
      // 多看几拍：`Offstage` 的切换不是靠动画等出来的，但给它足够帧数免得漏判
      await tester.pump(const Duration(seconds: 2));
      expect(thinkingRowPaints(tester), isFalse, reason: '两秒之后仍旧一个像素都不留');
    });

    testWidgets('「不许移位」仍然成立：整行不可见时槽位高度不变（几何一个像素都不动）', (tester) async {
      // 用户这一条的**硬要求**（他明写不许造成跳动）：所以"整行不可见"必须是
      // "不画"而不是"把它那一格拆掉"。这里量的是输入框与消息流的矩形。
      //
      // 给两条历史：`CustomScrollView` 只在真有内容时才在树上（空态走的是引导卡），
      // 没有内容可量就没有几何可比。
      final api = await bootChat(tester, history: [herBubble(1, '你好'), herBubble(2, '在的')]);
      await _settle(tester);
      final inputIdle = tester.getRect(find.byType(TextField));
      final scrollIdle = tester.getRect(find.byType(CustomScrollView));

      await api.emit('turn/start', <String, dynamic>{'turn': 22});
      await _settle(tester);
      expect(thinkingRowPaints(tester), isTrue);
      expect(tester.getRect(find.byType(TextField)), inputIdle,
          reason: '那一行出现不许把输入框推下去');
      expect(tester.getRect(find.byType(CustomScrollView)), scrollIdle,
          reason: '也不许挤压消息流');

      await api.emit('turn/end', <String, dynamic>{'turn': 22});
      await _settle(tester);
      expect(thinkingRowPaints(tester), isFalse);
      expect(tester.getRect(find.byType(TextField)), inputIdle,
          reason: '消失时同样不许移位（这正是"不可见"而不是"拆掉那一格"的理由）');
      expect(tester.getRect(find.byType(CustomScrollView)), scrollIdle);
    });

    testWidgets('★ `turn/end` 丢了（断线窗口）⇒ 服务端对账之后**点也必须消失**', (tester) async {
      // 这是上一条修的那条链路的"连点一起验"：对账把整行收掉，点不能自己留着。
      await withClock(tester.binding.clock, () async {
        final api = await bootChat(tester);
        api.dashboard = <String, dynamic>{
          'state': 'running',
          'stateText': 'Agent 正在值守',
          'stateNote': '',
          'openTurn': <String, dynamic>{'turn': 23, 'step': 1},
          'tiles': <String, dynamic>{'needsReview': 0},
          'guardedDays': 1,
          'nextWakeAt': null,
          'ask': <String, dynamic>{'card': null, 'queued': 0},
        };
        await api.emit('turn/start', <String, dynamic>{'turn': 23});
        await api.emit('step/start', <String, dynamic>{'turn': 23, 'step': 1});
        await _settle(tester);
        expect(thinkingRowPaints(tester), isTrue, reason: '她开口了：点与文字都在');

        // 这一轮结束了，但那条 `turn/end` 永远没到
        api.dashboard = <String, dynamic>{
          'state': 'idle',
          'stateText': '待机',
          'stateNote': '',
          'openTurn': null,
          'tiles': <String, dynamic>{'needsReview': 0},
          'guardedDays': 1,
          'nextWakeAt': null,
          'ask': <String, dynamic>{'card': null, 'queued': 0},
        };
        ageTheRow(tester);
        await readDashboardAndReconcile(tester);
        await _settle(tester);

        expect(find.textContaining('思考中'), findsNothing, reason: '文字收掉了');
        expect(thinkingRowPaints(tester), isFalse,
            reason: '★ 点也必须一起收掉（这一条把对账与"整行同进同出"接在一起验）');
      });
    });

    testWidgets('反向：她**真的还在跑**时不许被误杀，点要还在', (tester) async {
      await withClock(tester.binding.clock, () async {
        final api = await bootChat(tester);
        api.dashboard = <String, dynamic>{
          'state': 'running',
          'stateText': 'Agent 正在值守',
          'stateNote': '',
          'openTurn': <String, dynamic>{'turn': 24, 'step': 2},
          'tiles': <String, dynamic>{'needsReview': 0},
          'guardedDays': 1,
          'nextWakeAt': null,
          'ask': <String, dynamic>{'card': null, 'queued': 0},
        };
        await api.emit('turn/start', <String, dynamic>{'turn': 24});
        await api.emit('step/start', <String, dynamic>{'turn': 24, 'step': 2});
        await _settle(tester);
        ageTheRow(tester);
        await readDashboardAndReconcile(tester);
        await _settle(tester);

        expect(thinkingRowPaints(tester), isTrue, reason: '她还在跑 ⇒ 点与文字都不许动');
        expect(find.textContaining('第  2 步'), findsOneWidget);
      });
    });
  });

  group('进度行：节流与不移位', () {
    testWidgets('节流：一帧内 30 条推理只放行少数几次，且字数最终不漏', (tester) async {
      final api = await bootChat(tester);
      await api.emit('turn/start', <String, dynamic>{'turn': 1});
      await _settle(tester);

      // **直接量那一行的重建次数**：它由 `ChatPageState.thinkingNow` 驱动
      // （`_ThinkingRow` 的 ValueListenableBuilder 只听它），所以放行次数就是重建次数。
      // 换个写法去数 widget 的 build 调用很脆，而这个可监听对象是那一行的**唯一**入口。
      var rebuilt = 0;
      tester
          .state<ChatPageState>(find.byType(ChatPage))
          .thinkingNow
          .addListener(() => rebuilt += 1);

      for (var i = 0; i < 30; i += 1) {
        unawaited(api.emit('message/reasoning',
            <String, dynamic>{'turn': 1, 'step': 1, 'text': 'x' * 10}));
      }
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await _settle(tester);

      expect(rebuilt, lessThanOrEqualTo(4),
          reason: '节流窗口 250ms ⇒ 300ms 内最多两拍；30 条事件不许换 30 次重建');
      expect(rebuilt, greaterThan(0), reason: '该放行的还是要放行（不是一路压住）');
      // 300 字一个都不少：节流只压"上屏次数"，不丢更新
      expect(find.textContaining('300 字'), findsOneWidget);
    });

    testWidgets('出现/消失**不移位**：消息流与输入框的几何一个像素都不变', (tester) async {
      final api = await bootChat(tester, history: [herBubble(1, '你好'), herBubble(2, '在的')]);
      final scrollBefore = tester.getRect(find.byType(CustomScrollView));
      final inputBefore = tester.getRect(find.byType(TextField));

      await api.emit('turn/start', <String, dynamic>{'turn': 1});
      await api.emit('message/reasoning', <String, dynamic>{'turn': 1, 'step': 1, 'text': '想一下'});
      await _settle(tester);
      // 那一行真的出现了（否则下面那两条断言可能是"什么都没发生"）
      expect(find.textContaining('思考中'), findsOneWidget);

      expect(tester.getRect(find.byType(CustomScrollView)), scrollBefore,
          reason: '消息流的位置与尺寸不许因为那一行出现而变');
      expect(tester.getRect(find.byType(TextField)), inputBefore,
          reason: '输入框不许被推动（槽位是定高的）');

      await api.emit('turn/end', <String, dynamic>{'turn': 1});
      await _settle(tester);
      expect(find.textContaining('思考中'), findsNothing);
      expect(tester.getRect(find.byType(CustomScrollView)), scrollBefore,
          reason: '消失时同样不许移位');
      expect(tester.getRect(find.byType(TextField)), inputBefore);
    });
  });

  // ─────────────────────────── ① 默认不自动滚动 ───────────────────────────

  group('① 默认不自动滚动', () {
    testWidgets('新内容到达**不改变**滚动位置（人正往回看时不被拽走）', (tester) async {
      // 先灌满一页历史，让列表真的滚得动
      final history = [for (var i = 1; i <= 30; i += 1) herBubble(i, '第 $i 条消息，够长够占地方')];
      final api = await bootChat(tester, history: history);
      await _settle(tester);

      final scrollable = find.byType(Scrollable).first;
      final position = tester.state<ScrollableState>(scrollable).position;
      // 往上翻一段：模拟"人正在往回看"
      position.jumpTo(position.maxScrollExtent - 300);
      await _settle(tester);
      final before = position.pixels;

      // 她连说三句
      await api.emit('message/assistant', <String, dynamic>{
        'text': '我想了一下，这件事可以这么办。',
        'toolCalls': <dynamic>[],
      });
      await api.emit('message/assistant', <String, dynamic>{
        'text': '先说结论，再说理由。',
        'toolCalls': <dynamic>[],
      });
      await _settle(tester);

      expect(position.pixels, before,
          reason: '新内容到达不许改动滚动位置（用户 2026-10-16 ①）');
      expect(find.textContaining('先说结论'), findsNothing,
          reason: '那两句还在视口外（这正是"没被拽到底"的证据）');
    });

    testWidgets('人本来就在底部时跟着走（那是他自己的位置，不是被拽）', (tester) async {
      final history = [for (var i = 1; i <= 30; i += 1) herBubble(i, '第 $i 条消息，够长够占地方')];
      final api = await bootChat(tester, history: history);
      await _settle(tester);
      final scrollable = find.byType(Scrollable).first;
      final position = tester.state<ScrollableState>(scrollable).position;

      await api.emit('message/assistant', <String, dynamic>{
        'text': '最后一句在这儿。',
        'toolCalls': <dynamic>[],
      });
      await _settle(tester);
      expect(position.pixels, closeTo(position.maxScrollExtent, 1),
          reason: '他本来就在底部 ⇒ 跟着走（语义上等于"他一直在看最新"）');
    });
  });

  // ─────────────────────────── ② 跳到最新 ───────────────────────────

  group('② 跳到最新那颗按钮', () {
    /// 那颗按钮。
    ///
    /// **不能按固定的 tooltip 文案找**：有新内容时它的文案会变成
    /// 「有新内容 · 跳到最新」（那正是提示点的语义），按字面量找会在那一瞬间"找不到按钮"。
    /// 所以按两种文案都认。
    Finder jumpButton() => find
        .byWidgetPredicate((w) =>
            w is Tooltip &&
            (w.message == '跳到最新' || w.message == '有新内容 · 跳到最新'))
        .hitTestable();
    Finder jumpButtonAny() => find.byWidgetPredicate((w) =>
        w is Tooltip && (w.message == '跳到最新' || w.message == '有新内容 · 跳到最新'));

    testWidgets('在底部时隐藏；不在底部时出现；有新内容时带一个小提示点', (tester) async {
      final history = [for (var i = 1; i <= 30; i += 1) herBubble(i, '第 $i 条消息，够长够占地方')];
      final api = await bootChat(tester, history: history);
      await _settle(tester);

      expect(jumpButtonAny(), findsNothing, reason: '打开时在底部 ⇒ 不露');

      final scrollable = find.byType(Scrollable).first;
      final position = tester.state<ScrollableState>(scrollable).position;
      position.jumpTo(position.maxScrollExtent - 400);
      await _settle(tester);
      expect(jumpButton(), findsOneWidget, reason: '往上翻 ⇒ 露出按钮');

      // 此刻还没有新内容：**不该**有那个点
      expect(find.byType(Tooltip), findsWidgets);
      expect(_hintDotCount(tester), 0, reason: '没有新内容时不亮提示点');

      // 她说话了 ⇒ 亮一个小点
      await api.emit('message/assistant', <String, dynamic>{
        'text': '新的一句。',
        'toolCalls': <dynamic>[],
      });
      await _settle(tester);
      expect(_hintDotCount(tester), 1, reason: '不在底部 + 有新内容 ⇒ 提示点亮一个');
    });

    testWidgets('点它 ⇒ 平滑滚到底部，提示点随之收掉', (tester) async {
      final history = [for (var i = 1; i <= 30; i += 1) herBubble(i, '第 $i 条消息，够长够占地方')];
      final api = await bootChat(tester, history: history);
      await _settle(tester);
      final scrollable = find.byType(Scrollable).first;
      final position = tester.state<ScrollableState>(scrollable).position;
      position.jumpTo(position.maxScrollExtent - 400);
      await _settle(tester);
      await api.emit('message/assistant', <String, dynamic>{
        'text': '新的一句。',
        'toolCalls': <dynamic>[],
      });
      await _settle(tester);
      expect(_hintDotCount(tester), 1);

      await tester.tap(jumpButton());
      await _settle(tester);

      expect(position.pixels, closeTo(position.maxScrollExtent, 1), reason: '点完到底部');
      expect(jumpButtonAny(), findsNothing, reason: '到底之后按钮自己收起来');
      expect(_hintDotCount(tester), 0, reason: '提示点也收掉');
    });

    testWidgets('按钮不许推动输入框与消息流（它住在那个定高槽里）', (tester) async {
      final history = [for (var i = 1; i <= 30; i += 1) herBubble(i, '第 $i 条消息，够长够占地方')];
      await bootChat(tester, history: history);
      await _settle(tester);
      final inputBefore = tester.getRect(find.byType(TextField));
      final scrollBefore = tester.getRect(find.byType(CustomScrollView));

      final scrollable = find.byType(Scrollable).first;
      final position = tester.state<ScrollableState>(scrollable).position;
      position.jumpTo(position.maxScrollExtent - 400);
      await _settle(tester);
      expect(jumpButton(), findsOneWidget);

      expect(tester.getRect(find.byType(TextField)), inputBefore,
          reason: '按钮出现不许把输入框推下去');
      expect(tester.getRect(find.byType(CustomScrollView)), scrollBefore,
          reason: '也不许挤压消息流');
    });
  });

  // ─────────────────────────── ③ ANSI 剥离 ───────────────────────────

  group('③ 工具输出里的 ANSI 装饰', () {
    test('带 ESC 的 SGR：颜色与加粗剥净', () {
      const esc = '\u001b';
      expect(
        sanitizeToolOutput('$esc[32;1mName$esc[0m $esc[32;1mMode$esc[0m'),
        'Name Mode',
      );
      expect(sanitizeToolOutput('$esc[1;31mERROR$esc[0m: 出错了'), 'ERROR: 出错了');
    });

    test('丢了 ESC 的残渣也剥（用户截图里那一种）', () {
      expect(sanitizeToolOutput('[32;1mName[0m [32;1mMode[0m'), 'Name Mode');
      expect(sanitizeToolOutput('  [0m'), '  ');
    });

    test('CSI 的非 SGR 形态（擦行/移光标）与 OSC 也剥', () {
      const esc = '\u001b';
      expect(sanitizeToolOutput('abc$esc[2Kdef'), 'abcdef');
      expect(sanitizeToolOutput('$esc]0;窗口标题\u0007正文'), '正文');
    });

    test('正样例：服务端写的状态行与正文**一个字都不许动**', () {
      const raw = 'Name Mode\n[stderr] 一句警告\n[exit code: 0]';
      expect(sanitizeToolOutput(raw), raw, reason: '含字母的方括号不是颜色码');
      expect(sanitizeToolOutput('[sh… 后面被截断]'), '[sh… 后面被截断]');
      expect(sanitizeToolOutput('见 [文档](http://x) 这一条'), '见 [文档](http://x) 这一条');
      // markdown 链接正文里恰好出现 `[1m]` 这种形状：只少那两个字符，链接本身不许坏
      expect(sanitizeToolOutput('见 [链接[1m]](http://x)'), '见 [链接]](http://x)');
    });

    test('制表符与换行留着（它们是排版不是装饰），裸控制字符剥掉', () {
      expect(sanitizeToolOutput('a\tb\nc'), 'a\tb\nc');
      expect(sanitizeToolOutput('a\u0008b'), 'ab');
      // 终端里的"回到行首重写"当分隔符看，不许把两段粘成一行
      expect(sanitizeToolOutput('进度 10%\r进度 20%'), '进度 10%\n进度 20%');
      expect(sanitizeToolOutput('win\r\nline'), 'win\nline');
    });

    testWidgets('工具卡片上屏的那段输出里没有颜色码（真走 _consume 那条路）', (tester) async {
      final api = await bootChat(tester);
      await api.emit('tool/call', <String, dynamic>{
        'callId': 'c1',
        'name': 'pwsh',
        'arguments': '{"command":"ls"}',
      });
      await api.emit('tool/result', <String, dynamic>{
        'callId': 'c1',
        'status': 'succeeded',
        'content': '\u001b[32;1mName\u001b[0m [32;1mMode[0m\r\nplain line\n[exit code: 0]',
      });
      await _settle(tester);

      expect(find.textContaining('[32;1m'), findsNothing, reason: '颜色码不许画到界面上');
      expect(find.textContaining('\u001b'), findsNothing);
      expect(find.textContaining('Name Mode'), findsOneWidget);
      expect(find.textContaining('[exit code: 0]'), findsWidgets, reason: '状态行照旧要看得见');
    });
  });
}

/// 给界面几拍把异步的东西落下来：**不用 `pumpAndSettle`**。
///
/// 为什么不能用它：那一行的呼吸动效是 `repeat()` 的，只要它在屏上，这一页就永远不会
/// "静止"——`pumpAndSettle` 会一直泵到超时（实测把一条用例拖到 10 分钟以上才被 runner 收走）。
/// 固定几拍够让"异步请求回来 + setState 落帧 + 220ms 滚动动画走完"这三件事发生。
Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pump(const Duration(milliseconds: 300));
}

/// 数一数屏幕上亮着的提示点（那个 `primary` 小圆点）。
///
/// 按形状认：**恰好 6×6**、里面是圆形 `DecoratedBox`。比按颜色认稳——
/// 颜色在明暗两套主题下不同，而 6 是写死的规格（见 `_jumpHintDot`）。
int _hintDotCount(WidgetTester tester) {
  var count = 0;
  for (final element in find.byType(SizedBox).evaluate()) {
    final box = element.widget as SizedBox;
    if (box.width != 6 || box.height != 6) continue;
    final child = box.child;
    if (child is! DecoratedBox) continue;
    final decoration = child.decoration;
    if (decoration is BoxDecoration && decoration.shape == BoxShape.circle) count += 1;
  }
  return count;
}
