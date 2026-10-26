import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/auth_gate.dart';
import 'package:irmia_gui/backend_probe.dart';
import 'package:irmia_gui/session_store.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 门上的**三档**：连不上 / 正在启动 / 密码不对——各说各的，前两档自动重试（2026-10-28）。
///
/// ## 真机现场（这组用例的来处）
///
/// 用户点「退出登录（清除本机凭据）」⇒ 停实例、清本机票、回选择页；他再想进来时，登录页把
/// 三种完全不同的事混成了一句"连不上"：
///
///   ① 后端根本没起（`SocketException` / 连接被拒 / 超时）；
///   ② 后端**已经 bind、重活没干完**（`503 {starting:true, phase}`）；
///   ③ 密码错（401）。
///
/// 更要命的是**它不会自己再试**：16:19:05–16:19:33 屏幕上一直是"后端还在启动（阶段 channels）"，
/// 16:19:35 后端已经 ready，那句错就停在那儿——人以为"一直连接不上"。
///
/// ## 这七条用例钉住什么
///
///   ① 连接被拒 ⇒ 「后端还没起来（127.0.0.1:7788）。正在重试…」，且**2 秒后自己再探一次**；
///   ② 503 starting(phase=channels) ⇒ 「后端正在启动（阶段：消息通道）。正在重试…」，phase 换文案跟着换；
///   ③ 401 ⇒ 只说「密码不对」，输入框内容保留；
///   ④ 就绪 ⇒ 提示自动消失、按钮恢复可点，而且**没有替人发登录请求**；
///   ⑤ 60 秒仍未就绪 ⇒ 追加"看 gui.log"那一句；
///   ⑥ 设密码页同三档（至少 ①②），按钮先就灰着（不是点了才报错）；
///   ⑦ 反向断言：这几种情况下**不出现**"连不上 / 网络错误"这类笼统字眼。
///
/// 时间全部走 `testWidgets` 的假时钟（`tester.pump(时长)`）：门前那套重探是 1 秒一格的节拍，
/// 真等 60 秒的用例没人会跑第二遍。
void main() {
  /// 服务端告诉界面的实例标识（401 与认证响应都带它）
  const instance = '127.0.0.1:7788#gate000000000000';

  late Directory tmp;

  setUp(() {
    // 凭据文件与界面状态文件都指向临时目录：别踩真实 %APPDATA%
    tmp = Directory.systemTemp.createTempSync('irmia-gate-tiers-');
    sessionsRootOverride = '${tmp.path}${Platform.pathSeparator}sessions';
    stateFileOverride = '${tmp.path}${Platform.pathSeparator}ui-state.json';
    legacyGuiTokenOverride = '${tmp.path}${Platform.pathSeparator}gui-token';
  });

  tearDown(() {
    sessionsRootOverride = null;
    stateFileOverride = null;
    legacyGuiTokenOverride = null;
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });

  /// 与 `IrmiaApp` 里那个三元同构：`ready` 决定画壳还是画门。
  Widget harness(AppState state) => MaterialApp(
        theme: IrmiaTheme.light(),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) =>
              state.ready ? const Text('SHELL') : AuthGate(state: state),
        ),
      );

  Future<void> pumpGate(WidgetTester tester, AppState state) async {
    tester.view.physicalSize = const Size(1350, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(harness(state));
    await tester.pump(const Duration(milliseconds: 50));
  }

  /// 摆到"后端好着、门是登录页"的常态（真机上人就是这么站在那儿的），返回那一台替身。
  Future<(_GateApi, AppState)> onLoginPage(WidgetTester tester) async {
    final api = _GateApi(instance);
    final state = AppState(api: api);
    await state.bootstrap();
    await pumpGate(tester, state);
    expect(state.gate, AuthGateKind.login, reason: '前提：服务端答了话并说"要密码"');
    return (api, state);
  }

  /// 填一个密码再按「登录」。
  ///
  /// 必须先填：空密码在**本地**就被拦下（"请输入密码。"，一条请求都不发），那是另一条规矩，
  /// 与这里要测的"后端到哪一步了"无关。
  Future<void> tapLogin(WidgetTester tester, {String password = 'irmia-local-pw'}) async {
    await tester.enterText(find.byType(TextField), password);
    await tester.tap(find.widgetWithText(FilledButton, '登录'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 20));
  }

  // ───────────────────────── ① 连不上：文案 + 2 秒自动重探 ─────────────────────────

  testWidgets('① 连接被拒：出现"后端还没起来（127.0.0.1:7788）。正在重试…"，2 秒后自动再探一次', (tester) async {
    final (api, state) = await onLoginPage(tester);

    // 后端在页面起来之后没了（重启中 / 被停掉）——现场就是这个形状
    api.mode = BackendReadiness.down;
    await tapLogin(tester);

    expect(find.textContaining('后端还没起来（127.0.0.1:7788）。正在重试…'), findsOneWidget,
        reason: '第①档：说"没起来"，并且明说正在重试（不是一句"连不上"了事）');
    expect(api.authCalls, isEmpty, reason: '探测就没过：**不发登录请求**（密码不允许被自动重发）');
    expect(state.gateWaitingBackend, isTrue);
    expect(find.byKey(const ValueKey('gate-backend-progress')), findsOneWidget,
        reason: '"第 N 秒 · 已重试 M 次"那行小字要在，别让人猜它到底还在试没有');

    // 没人按任何键：2 秒到点后它自己去探了一次
    final probes = api.healthCalls;
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(api.healthCalls, probes + 1, reason: '$kBackendRetrySeconds 秒一拍，自己重探');
    expect(find.textContaining('第 2 秒 · 已重试 1 次'), findsOneWidget, reason: '读数要如实往前走');

    // 重试期间：输入框还是那一个（没被重建 ⇒ 不会清空、不会被抢焦点）
    final field = find.byType(EditableText);
    final before = tester.element(field);
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(tester.element(find.byType(EditableText)), same(before),
        reason: '重试不许把输入框重建（重建就会丢内容、抢焦点）');
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'irmia-local-pw',
        reason: '重试期间不许把输入框清空');
    expect(tester.widget<EditableText>(find.byType(EditableText)).focusNode.hasFocus, isTrue,
        reason: '重试期间不许把焦点抢走（人正停在那一格上）');

    state.dispose();
  });

  // ───────────────────── ② 503 starting：阶段说人话，换阶段跟着换 ─────────────────────

  testWidgets('② 503 starting(phase=channels)：说"后端正在启动（阶段：消息通道）"，phase 换文案跟着变', (tester) async {
    final (api, state) = await onLoginPage(tester);

    api.mode = BackendReadiness.starting;
    api.phase = 'channels';
    await tapLogin(tester);

    expect(find.textContaining('后端正在启动（阶段：消息通道）。正在重试…'), findsOneWidget,
        reason: '第②档：**它是正在起，不是连不上**——阶段要说人话');
    expect(api.authCalls, isEmpty, reason: '这一档同样不发登录请求');

    // 阶段往前走：下一拍自动重探读到新的 phase，那句话跟着换
    api.phase = 'events';
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.textContaining('后端正在启动（阶段：事件回放）。正在重试…'), findsOneWidget,
        reason: 'events 要说成「事件回放」');
    expect(find.textContaining('消息通道'), findsNothing, reason: '旧阶段不许留在屏幕上');

    // 再走一格：mcp ⇒ 外部工具（映射表里剩下的那一档）
    api.phase = 'mcp';
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.textContaining('后端正在启动（阶段：外部工具）'), findsOneWidget);

    state.dispose();
  });

  // ───────────────────────── ③ 401：只说密码不对 ─────────────────────────

  testWidgets('③ 401：只说"密码不对"，输入框内容保留（不许说成"连接不上"）', (tester) async {
    final (api, state) = await onLoginPage(tester);
    api.loginError = const ApiAuthError(
      '密码不对。连续失败后会退避：下一次尝试前要等约 1 秒。',
      code: 'bad-password',
    );

    // 后端好着（缺省就是 ready），只是密码不对
    await tapLogin(tester, password: 'wrong-password');

    expect(api.authCalls, <String>['/api/auth/login'],
        reason: '后端好着 ⇒ 探测通过，且真的发了那一条登录请求');
    expect(find.textContaining('密码不对'), findsOneWidget, reason: '第③档：服务端那句"密码不对"照原样说');
    expect(find.textContaining('连不上'), findsNothing, reason: '密码错与后端无关：一个字都不许提"连不上"');
    expect(find.textContaining('网络错误'), findsNothing);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'wrong-password',
        reason: '密码错时不许清空输入框');
    expect(state.gateWaitingBackend, isFalse, reason: '401 不属于"后端还没就绪"那两档');
    expect(find.byKey(const ValueKey('gate-backend-progress')), findsNothing,
        reason: '这一档没有"正在重试"可言');
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '登录')).onPressed, isNotNull,
        reason: '按钮不许灰着：人马上要重输一次');

    state.dispose();
  });

  // ───────────────────── ④ 就绪：提示自动消失、按钮恢复、不发登录请求 ─────────────────────

  testWidgets('④ 后端就绪：提示自动解除、按钮恢复可点（而且没有替人发登录请求）', (tester) async {
    final (api, state) = await onLoginPage(tester);

    api.mode = BackendReadiness.down;
    await tapLogin(tester);
    expect(find.textContaining('正在重试…'), findsOneWidget, reason: '前提：先落到第①档');
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '登录')).onPressed, isNull,
        reason: '没就绪时那颗按钮是灰的（点它不会有结果）');

    // 后端起来了：下一拍自动重探就把它认出来
    api.mode = BackendReadiness.ready;
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(state.gateWaitingBackend, isFalse, reason: '就绪 ⇒ 那一轮等待结束');
    expect(state.gateError, isEmpty, reason: '提示自己解除');
    expect(find.textContaining('正在重试…'), findsNothing, reason: '屏幕上不许留着那句旧的');
    expect(find.byKey(const ValueKey('gate-backend-progress')), findsNothing);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '登录')).onPressed, isNotNull,
        reason: '按钮恢复可点：人自己点登录');
    expect(api.authCalls, isEmpty, reason: '**不替人发登录请求**：密码不该被自动重发');

    state.dispose();
  });

  // ───────────────────── ⑤ 60 秒仍未就绪：追加"看 gui.log" ─────────────────────

  testWidgets('⑤ 60 秒仍未就绪：提示里追加"后端一直没就绪：看 …gui.log"', (tester) async {
    final (api, state) = await onLoginPage(tester);

    api.mode = BackendReadiness.down;
    await tapLogin(tester);
    expect(find.textContaining('后端一直没就绪'), findsNothing, reason: '60 秒之前不说这一句');

    // 一秒一格地推（门前那套节拍器就是 1 秒一格）：60 秒到点，那句话自己长出来
    for (var i = 0; i < 61; i += 1) {
      await tester.pump(const Duration(seconds: 1));
    }
    await tester.pump();

    expect(find.textContaining('后端一直没就绪'), findsOneWidget, reason: '等满 60 秒就得给一条去处的线索');
    expect(find.textContaining('gui.log'), findsOneWidget);
    expect(find.textContaining('后端还没起来（127.0.0.1:7788）'), findsOneWidget,
        reason: '原话还在（追加，不是替换）');
    expect(find.textContaining('第 61 秒 · 已重试'), findsOneWidget, reason: '秒数与次数一直往前走');

    state.dispose();
  });

  // ───────────────────── ⑥ 设密码页：同三档，按钮先就灰着 ─────────────────────

  testWidgets('⑥ 设密码页：后端没起/正在启动时按钮先就灰着，并说同一套话（不用点了才报错）', (tester) async {
    final api = _GateApi(instance)..initialized = false; // 这台实例还没设过密码
    final state = AppState(api: api);
    await state.bootstrap();
    await pumpGate(tester, state);
    expect(find.text('设置密码'), findsOneWidget, reason: '前提：门画的是设密码那一态');

    // 人切回来的时候后端已经没了：页面**重新进场**（initState 再跑一次）就该当场知道
    api.mode = BackendReadiness.down;
    await tester.pumpWidget(const SizedBox.shrink());
    await pumpGate(tester, state);
    await tester.pump();

    expect(find.textContaining('后端还没起来（127.0.0.1:7788）。正在重试…'), findsOneWidget,
        reason: '① 同一套第①档文案');
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('gate-setup-submit'))).onPressed, isNull,
        reason: '按钮先就灰着：后端没起时点它没有任何结果');
    expect(api.authCalls, isEmpty, reason: '还没点就已经知道不该发请求');

    // ② 后端进入启动期：下一拍自动重探换成第②档，按钮仍然灰着
    api.mode = BackendReadiness.starting;
    api.phase = 'channels';
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(find.textContaining('后端正在启动（阶段：消息通道）。正在重试…'), findsOneWidget,
        reason: '② 设密码页也要说"正在启动 + 阶段"');
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('gate-setup-submit'))).onPressed, isNull);

    // 就绪 ⇒ 灰的那颗自己活过来（人不用重进页面）
    api.mode = BackendReadiness.ready;
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('gate-setup-submit'))).onPressed, isNotNull,
        reason: '后端好了 ⇒ 按钮自己恢复');

    state.dispose();
  });

  // ──────────────── ⑦ 反向断言：三档里都不许出现笼统字眼 ────────────────

  testWidgets('⑦ 反向断言：三种情况下都不出现"连接不上 / 网络错误 / 连不上本地服务"', (tester) async {
    final (api, state) = await onLoginPage(tester);

    void expectNoVagueCopy(String which) {
      for (final vague in <String>['连接不上', '网络错误', '连不上本地服务', '无法连接']) {
        expect(find.textContaining(vague), findsNothing,
            reason: '$which 这一档里不该出现笼统字眼「$vague」——它把三种情况混成了一句');
      }
    }

    // ① 连不上
    api.mode = BackendReadiness.down;
    await tapLogin(tester);
    expectNoVagueCopy('①后端没起');

    // ② 正在启动
    api.mode = BackendReadiness.starting;
    api.phase = 'channels';
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    expectNoVagueCopy('②正在启动');

    // ③ 密码错
    api.mode = BackendReadiness.ready;
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    api.loginError = const ApiAuthError('密码不对。', code: 'bad-password');
    await tapLogin(tester, password: 'whatever');
    expectNoVagueCopy('③密码错');

    state.dispose();
  });
}

/// API 替身：`/api/health` 按 [mode] 回三档之一，认证端点按服务端的形状回。
///
/// ⚠ 所有 `get/post/postAuth` 都被覆盖了：不覆盖的话 `AppState` 会走**真 HTTP**
/// 打到 127.0.0.1:7788——假时钟里那条真连接永远不会完成（用例挂住），而真机上那个端口上
/// 跑着用户正在用的实例。
class _GateApi extends IrmiaApi {
  _GateApi(this.instanceId) : super(baseUrl: 'http://127.0.0.1:7788') {
    instance = instanceId;
  }

  final String instanceId;

  /// 后端此刻那一档（默认就绪：门画成"登录"）
  BackendReadiness mode = BackendReadiness.ready;

  /// `503 {starting:true, phase}` 里的那个阶段
  String phase = '';

  /// `/api/auth/state` 的答案（false ⇒ 门画成"设置密码"）
  bool initialized = true;

  /// 登录端点的失败（401 「密码不对」那一档）
  ApiAuthError? loginError;

  /// `/api/auth/health` 被问过几次（"2 秒后自己再探一次"那条断言读它）
  int healthCalls = 0;

  /// 认证端点被调过哪几次（"不发登录请求"那几条断言读它）
  final List<String> authCalls = <String>[];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/health') {
      healthCalls += 1;
      switch (mode) {
        case BackendReadiness.down:
          // 形状与"主进程没在跑"时 dart:io 抛的一样：门那一层认的是**类型**
          throw const SocketException('由于目标计算机积极拒绝，无法连接。');
        case BackendReadiness.starting:
          // 服务端那一条：503 + {starting:true, phase}（见 src/web/preflight.ts）
          throw ApiError(
            503,
            '后端还在启动（阶段 $phase）：端口已经在听，重活还没干完。',
            starting: true,
            phase: phase,
          );
        case BackendReadiness.ready:
        case BackendReadiness.unknown:
          return <String, dynamic>{'status': 'ready', 'phase': 'ready', 'port': 7788, 'pid': 4321};
      }
    }
    if (path == '/api/auth/state') return <String, dynamic>{'initialized': initialized};
    if (path == '/api/stats/dashboard') {
      return <String, dynamic>{
        'state': 'idle',
        'tiles': <String, dynamic>{'needsReview': 0},
      };
    }
    // 其余（握手那条 `/api/projection`）：手上没票 ⇒ 401，界面据此画门
    throw ApiAuthError(
      '缺少或无效的会话凭据。请重新登录。',
      code: 'unauthorized',
      instance: instanceId,
    );
  }

  @override
  Future<dynamic> postAuth(String path, Map<String, dynamic> body) async {
    authCalls.add(path);
    final failure = loginError;
    if (failure != null) throw failure;
    return <String, dynamic>{'ok': true, 'token': 'session-token', 'instance': instanceId};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body,
          {String? confirm, Duration? timeout}) async =>
      <String, dynamic>{'ok': true};

  /// 事件流：接上就挂着（用例不会走到壳里，但真被订阅了也不许自己结束）
  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    final controller = StreamController<Map<String, dynamic>>();
    controller.onListen = () {
      scheduleMicrotask(() {
        if (!controller.isClosed) {
          controller.add(<String, dynamic>{'type': 'session/start', 'seq': 0, 'data': const {}});
        }
      });
    };
    return controller.stream;
  }
}
