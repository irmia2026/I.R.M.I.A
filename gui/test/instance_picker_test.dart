import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/auth_gate.dart';
import 'package:irmia_gui/backend_port.dart';
import 'package:irmia_gui/backend_probe.dart';
import 'package:irmia_gui/backend_stop.dart';
import 'package:irmia_gui/instance_picker.dart';
import 'package:irmia_gui/instances.dart';
import 'package:irmia_gui/session_store.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// **实例选择页**与"关掉实例 ≠ 作废会话"（2026-10 多实例，2026-10-27 改口径）。
///
/// 用户的原话（逐句落地）：「为什么要作废会话？不能就留在那，如果登回来了就接着吗？」
/// ⇒ 登出 = **关掉这个实例**：后端停、回选择页，但**会话凭据留着**；从选择页点回这一台
/// 应该**直接进去**，只有凭据确实失效（401）才要密码。
///
/// 被测的十一件事（逐条对应验收里的 ①~⑥ 与既有多实例判据）：
///   ① 选择页那一行的按钮按"本机有没有这一台的票"×"它在不在跑"分四句：
///      「进入」/「启动并进入」/「登录」/「启动并登录」；
///   ② 有票 + 在跑 ⇒ 点「进入」**直接进壳**（不打密码门、一条认证请求都不发）；
///   ③ 有票但服务端回 401 ⇒ 清掉那一份 token、该行按钮变「登录」、留一行"登录状态已失效"，
///      人**留在选择页**（不被推到密码门后面）；
///   ④ 关实例：**没有** `/api/auth/logout`、盘上 token 仍在、回选择页、日志 `token=kept`；
///   ⑤ `stop-instance` 失败 ⇒ 退化按端口强停，日志 `stop=killed`（同一行仍是 `token=kept`）；
///   ⑥ 彻底登出（安全出口）：作废 → 停实例 → 清 token，三件都发生（顺序断言）、日志 `token=cleared`；
///   ⑦ 「忘记凭据」：只清本机 token——实例照跑、登记表一个字节都没动、不停实例；
///   ⑧ 切实例：baseUrl 与内存里的 token 都换成新的（旧 token 一次都不许再出现）；
///   ⑨ 新建实例：目录非空要提示、端口从 7788 起找到 7789、就绪后进**首次设密码**；
///   ⑩ 删除：运行中 / 默认实例的删除按钮**不可用**（反向断言）；
///   ⑪ 改名：原名旁的小铅笔 → 对话框 → 写 `nameSource: "manual"`（后端此后永不覆盖）。
///
/// 真机观感（列表在 640 宽卡片里的排布、中日韩字宽）不在射程内；这里断言的是判据与顺序。
void main() {
  late Directory tmp;
  late _FakeApi api;
  late _FakeHost host;
  late AppState state;
  late SessionStore store;
  late List<String> lifeLines;

  /// api 与 host 共用的**一条时间线**（三步的顺序断言就是比它的下标）
  late List<String> timeline;

  const instanceA = '127.0.0.1:7788#aaaaaaaaaaaaaaaa';
  const instanceB = '127.0.0.1:7789#bbbbbbbbbbbbbbbb';

  String instancesFile() => '${tmp.path}${Platform.pathSeparator}instances.json';

  /// 造一份登记表（`entries` 原样写进去）
  void seedInstances(List<Map<String, dynamic>> entries) {
    File(instancesFile()).writeAsStringSync(jsonEncode({'v': 1, 'instances': entries}));
  }

  Map<String, dynamic> entryJson({
    required String id,
    required String name,
    required int port,
    String? dataDir,
    bool isDefault = false,
    String pid = '4321',
  }) =>
      <String, dynamic>{
        'id': id,
        'name': name,
        'dataDir': dataDir ?? '${tmp.path}\\data-$port',
        'host': '127.0.0.1',
        'port': port,
        'pid': int.tryParse(pid) ?? 0,
        'nodeExe': 'D:\\agent\\tools\\node\\node.exe',
        'entry': 'D:\\agent\\app\\dist\\main.js',
        'createdAt': '2026-10-20T00:00:00.000Z',
        'lastStartedAt': '2026-10-20T00:00:00.000Z',
        'lastReadyAt': '',
        'isDefault': isDefault,
      };

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('irmia-picker-');
    instancesFileOverride = instancesFile();
    sessionsRootOverride = '${tmp.path}${Platform.pathSeparator}sessions';
    stateFileOverride = '${tmp.path}${Platform.pathSeparator}ui-state.json';
    HttpOverrides.global = null;
    lifeLines = <String>[];
    // **一条时间线**：api 与 host 往同一个列表里追加，于是"谁先谁后"可以直接比下标
    timeline = <String>[];
    api = _FakeApi(timeline);
    host = _FakeHost(timeline);
    store = SessionStore();
    state = AppState(
      api: api,
      sessions: store,
      backend: const BackendPort(port: 7788, source: BackendPortSource.file),
      instances: host.host,
    );
    state.lifeLogSink = lifeLines.add;
  });

  tearDown(() {
    instancesFileOverride = null;
    sessionsRootOverride = null;
    stateFileOverride = null;
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });

  /// 与 `app.dart` 里那个三元**同构**：`ready` 决定画壳还是画门上的那一态。
  ///
  /// 壳用一个标记（`SHELL`）顶替而不是真 `HomeShell`：后者要打六七个端点，而这一组
  /// 测的是"进没进去 / 停没停"，不是壳里有什么。
  /// 不套 `ListenableBuilder` 的话 `AppState` 的通知就没有人去重建页面（用例会一直看到第一帧）。
  Widget harness() => MaterialApp(
        theme: IrmiaTheme.light(),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) =>
              state.ready ? const Text('SHELL') : InstancePicker(state: state),
        ),
      );

  /// 摆出选择页（门上第三态），并喂几拍让 `refreshInstances` 落地
  Future<void> pumpPicker(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    state.ready = false;
    state.gate = AuthGateKind.picker;
    await tester.pumpWidget(harness());
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }
  }

  /// 把 state 摆在"已经进了壳、手上有一张这一台的票"的位置上
  void insideShell({
    required String id,
    required int port,
    required String token,
    bool running = true,
  }) {
    api.instance = id;
    api.serverInstance = id;
    api.token = token;
    api.goodToken = token;
    store.write(id, token);
    state.instance = id;
    state.ready = true;
    if (running) host.probes[port] = _probeJson(id, '伊尔弥亚', port, isDefault: true);
  }

  // ───────────────────────── ① 四句按钮 ─────────────────────────

  testWidgets('①-空表：只有「新建实例」，并如实说"还没有登记过实例"', (tester) async {
    await pumpPicker(tester);

    expect(find.text('还没有登记过实例。新建一台开始用。'), findsOneWidget);
    expect(find.byKey(const ValueKey('picker-new')), findsOneWidget);
    // 一台都没有 ⇒ 一个打开/删除/忘记凭据的按钮都不该有
    expect(find.text('登录'), findsNothing);
    expect(find.text('启动并登录'), findsNothing);
    expect(find.text('进入'), findsNothing);
    expect(find.text('启动并进入'), findsNothing);
    expect(find.text('忘记凭据'), findsNothing);
    expect(tester.takeException(), isNull);
    state.dispose();
  });

  testWidgets('①-在跑且**没票**：状态词「运行中」、按钮是「登录」（要密码）', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);
    await pumpPicker(tester);

    expect(find.text('伊尔弥亚'), findsOneWidget);
    expect(find.text('127.0.0.1:7788 · 运行中'), findsOneWidget);
    expect(find.text('登录'), findsOneWidget);
    // 没票就没有可忘的东西：那颗小字不出现
    expect(find.text('忘记凭据'), findsNothing);
    expect(find.text('进入'), findsNothing);
    expect(find.text('启动并登录'), findsNothing);
    state.dispose();
  });

  testWidgets('①-未运行且**没票**：状态词「未运行」、按钮是「启动并登录」', (tester) async {
    seedInstances([entryJson(id: instanceB, name: '工作实例', port: 7789, pid: '0')]);
    await pumpPicker(tester);

    expect(find.text('工作实例'), findsOneWidget);
    expect(find.text('127.0.0.1:7789 · 未运行'), findsOneWidget);
    expect(find.text('启动并登录'), findsOneWidget);
    expect(find.text('登录'), findsNothing);
    expect(find.text('忘记凭据'), findsNothing);
    state.dispose();
  });

  testWidgets('①-在跑且**有票**：按钮是「进入」+ 一颗「忘记凭据」小字', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    store.write(instanceA, 'token-A');
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);
    await pumpPicker(tester);

    expect(find.text('127.0.0.1:7788 · 运行中'), findsOneWidget);
    expect(find.text('进入'), findsOneWidget);
    expect(find.byKey(const ValueKey('instance-forget-$instanceA')), findsOneWidget,
        reason: '有票 ⇒ 给一个只清 token 的出口');
    expect(find.text('登录'), findsNothing, reason: '有票就不该再要密码');
    // 一行里挤了四样东西（状态点 / 名字+铅笔 / 「进入」/「忘记凭据」/「删除」）：
    // 排不下会是一条 RenderFlex overflow（真机上也一样难看），这一句就是那道闸
    expect(tester.takeException(), isNull, reason: '行内不许溢出');
    state.dispose();
  });

  testWidgets('①-未运行且**有票**：按钮是「启动并进入」', (tester) async {
    seedInstances([entryJson(id: instanceB, name: '工作实例', port: 7789, pid: '0')]);
    store.write(instanceB, 'token-B');
    await pumpPicker(tester);

    expect(find.text('127.0.0.1:7789 · 未运行'), findsOneWidget);
    expect(find.text('启动并进入'), findsOneWidget);
    expect(find.text('启动并登录'), findsNothing, reason: '有票 ⇒ 拉起之后不用密码');
    // 最挤的一行：「启动并进入」+「忘记凭据」+「删除」同排（溢出的形状与上一条同源）
    expect(tester.takeException(), isNull, reason: '行内不许溢出');
    state.dispose();
  });

  // ─────────────────── ② 有票 + 在跑 ⇒ 直接进壳 ───────────────────

  testWidgets('② 有票且实例在跑：点「进入」直接进壳（不打密码门、零认证请求）', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    store.write(instanceA, 'token-A');
    api.instance = null; // 还没学回来（切过去之后由服务端的 401 自报）
    api.serverInstance = instanceA;
    api.goodToken = 'token-A';
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);
    await pumpPicker(tester);

    expect(find.text('进入'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('instance-open-$instanceA')));
    for (var i = 0; i < 40; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
      if (state.ready) break;
    }

    expect(state.ready, isTrue, reason: '票有效 ⇒ 当场进壳');
    expect(find.text('SHELL'), findsOneWidget, reason: '门上那一屏换成了壳');
    expect(find.text('进入'), findsNothing, reason: '选择页已经收起来了');
    expect(state.gate, isNot(AuthGateKind.login), reason: '一次密码门都不该出现');
    expect(state.gate, isNot(AuthGateKind.setup));
    expect(api.requests, isEmpty, reason: '这条路一个认证/命令请求都不发（只读一次 projection）');
    expect(state.api.token, 'token-A', reason: '用的还是盘上那张票');
    expect(state.instance, instanceA, reason: '实例标识从服务端学回来');
    expect(store.read(instanceA), 'token-A', reason: '票一直在盘上，没被清掉');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ─────────────── ③ 有票但 401 ⇒ 清 token、变「登录」、留在选择页 ───────────────

  testWidgets('③ 票被 401 判掉：清掉那一份、按钮变「登录」、留一行"登录状态已失效"', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    store.write(instanceA, 'stale-token');
    api.serverInstance = instanceA;
    // 服务端认的是另一串：盘上这一份已经不作数了（改过密码 / 在别处退出登录）
    api.goodToken = 'someone-elses-token';
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);
    await pumpPicker(tester);

    expect(find.text('进入'), findsOneWidget, reason: '盘上有票 ⇒ 先按"能直接进"摆');
    await tester.tap(find.byKey(const ValueKey('instance-open-$instanceA')));
    for (var i = 0; i < 40; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
      if (state.pickerSessionExpired.isNotEmpty) break;
    }
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(store.read(instanceA), isNull, reason: '那一份废票要清掉（留着只会每次白跑一趟）');
    expect(api.requests, isEmpty, reason: '票不作数 ≠ 会话要作废：一条 /api/auth/logout 都不许发');
    expect(state.ready, isFalse);
    expect(state.gate, AuthGateKind.picker, reason: '留在选择页，不把人推到密码门后面');
    expect(state.api.token, isNull);
    expect(state.pickerSessionExpired, instanceA);
    expect(find.byKey(const ValueKey('picker-session-expired')), findsOneWidget);
    expect(find.textContaining('登录状态已失效'), findsOneWidget);
    expect(find.text('登录'), findsOneWidget, reason: '这一行的按钮换成「登录」');
    expect(find.text('进入'), findsNothing);
    expect(find.byKey(const ValueKey('instance-forget-$instanceA')), findsNothing,
        reason: '票已经清掉了 ⇒ 没有可忘的东西');
    expect(find.text('127.0.0.1:7788 · 运行中'), findsOneWidget, reason: '实例本身还在跑');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ─────────────────── ④ 关实例：不作废、token 留着 ───────────────────

  testWidgets('④ 关实例：没有 auth/logout、盘上 token 仍在、回选择页（日志 token=kept）', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    insideShell(id: instanceA, port: 7788, token: 'token-A');
    // 端口先应答两拍再消失：这样"等端口消失"这一步在顺序里看得见
    host.alivePlan[7788] = 2;

    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(harness());
    expect(find.text('SHELL'), findsOneWidget, reason: '前提：人此刻在壳里');

    // 后端被停掉之后就不再自述了（下一次判活会读成"未运行"）
    host.probes.clear();
    unawaited(state.closeInstance());
    for (var i = 0; i < 30; i += 1) {
      await tester.pump(const Duration(milliseconds: 300));
      if (state.gate == AuthGateKind.picker && state.pickerBusyId == null) break;
    }
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(api.requests, <String>['stop-instance'],
        reason: '只发 stop-instance：关实例**不作废**会话（auth/logout 一条都没有）');
    expect(timeline.contains('auth/logout'), isFalse, reason: '反向断言：这条路上根本没有登出请求');
    final portWait = timeline.indexWhere((line) => line.startsWith('alive:'));
    expect(portWait, greaterThan(timeline.lastIndexOf('stop-instance')),
        reason: '等端口消失必须排在停机请求**之后**');
    expect(state.gate, AuthGateKind.picker, reason: '关实例 ⇒ 实例选择页');
    expect(state.ready, isFalse);
    expect(find.text('SHELL'), findsNothing, reason: '壳已经收起来了');
    expect(state.api.token, isNull, reason: '内存里那张票要清掉');
    expect(store.read(instanceA), 'token-A', reason: '盘上那一份**留着**（回来点一下就能进）');
    expect(lifeLines.where((line) => line.startsWith('[life] close instance=伊尔弥亚')).length, 1);
    expect(lifeLines.last,
        matches(RegExp(r'^\[life\] close instance=伊尔弥亚 stop=graceful waited=\d+s token=kept$')));
    // 回来那一行：有票 + 未运行 ⇒ 「启动并进入」（不必再输密码）
    expect(find.text('启动并进入'), findsOneWidget, reason: '回来时不必再输密码，先拉起即可');
    expect(find.text('启动并登录'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ─────────────────── ⑤ 优雅停机失败 ⇒ 强停 ───────────────────

  testWidgets('⑤ stop-instance 失败：退化成按端口强停，日志里是 stop=killed', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    insideShell(id: instanceA, port: 7788, token: 'token-A');
    api.failStop = true;
    host.alivePlan[7788] = 1;

    await tester.pumpWidget(harness());
    unawaited(state.closeInstance());
    for (var i = 0; i < 30; i += 1) {
      await tester.pump(const Duration(milliseconds: 300));
      if (state.gate == AuthGateKind.picker) break;
    }

    expect(host.killed, <int>[7788], reason: '优雅停机失败 ⇒ 按端口强停（唯一的退化路径）');
    expect(api.requests, <String>['stop-instance']);
    expect(lifeLines.last, matches(RegExp(r'^\[life\] close instance=.* stop=killed waited=\d+s token=kept$')));
    expect(state.gate, AuthGateKind.picker);
    expect(store.read(instanceA), 'token-A', reason: '硬杀也照样把票留着');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ─────────────────── ⑥ 彻底登出（安全出口） ───────────────────

  testWidgets('⑥ 彻底登出：作废会话 → 停实例 → 清 token（三件都发生，日志 token=cleared）', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    insideShell(id: instanceA, port: 7788, token: 'token-A');
    host.alivePlan[7788] = 2;

    await tester.pumpWidget(harness());
    unawaited(state.logout());
    for (var i = 0; i < 30; i += 1) {
      await tester.pump(const Duration(milliseconds: 300));
      if (state.gate == AuthGateKind.picker) break;
    }

    expect(api.requests, <String>['auth/logout', 'stop-instance'],
        reason: '① 作废会话 → ② 停实例（顺序不许换）');
    expect(timeline.indexOf('auth/logout'), lessThan(timeline.indexOf('stop-instance')));
    expect(state.ready, isFalse);
    expect(state.api.token, isNull, reason: '内存里那张票要清掉');
    expect(store.read(instanceA), isNull, reason: '③ 盘上那一份也要清掉——下次要用密码');
    expect(state.gate, AuthGateKind.picker);
    expect(lifeLines.last,
        matches(RegExp(r'^\[life\] logout instance=伊尔弥亚 stop=graceful waited=\d+s token=cleared$')));
    expect(find.text('登录'), findsOneWidget, reason: '票没了 ⇒ 那一行回到「登录」');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ─────────────────── ⑦ 忘记凭据：只清 token ───────────────────

  testWidgets('⑦ 忘记凭据：只清本机那一份 token——实例照跑、登记表一个字节都不动', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    store.write(instanceA, 'token-A');
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);
    await pumpPicker(tester);
    final before = File(instancesFile()).readAsStringSync();

    expect(find.text('进入'), findsOneWidget, reason: '前提：有票 + 在跑');
    await tester.tap(find.byKey(const ValueKey('instance-forget-$instanceA')));
    await tester.pumpAndSettle();
    expect(find.textContaining('只清掉这台机器上保存的那一份登录凭据'), findsOneWidget,
        reason: '二次确认要写清"只清这一份、不停实例"');
    await tester.tap(find.widgetWithText(FilledButton, '忘记凭据').hitTestable());
    for (var i = 0; i < 20; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
    }

    expect(store.read(instanceA), isNull, reason: '本机这一份清掉');
    expect(api.requests, isEmpty, reason: '不停实例：一条 stop-instance 都没有');
    expect(host.killed, isEmpty, reason: '也没有退化成按端口强拉');
    expect(InstanceBook.load().byId(instanceA), isNotNull, reason: '登记表条目不许动');
    expect(File(instancesFile()).readAsStringSync(), before, reason: '登记表一个字节都不许变');
    expect(state.instancesRunning[instanceA], isTrue, reason: '实例还在跑（判活照旧答得出）');
    expect(find.text('登录'), findsOneWidget, reason: '票没了 ⇒ 按钮变「登录」');
    expect(find.text('忘记凭据'), findsNothing, reason: '没有可忘的东西了');
    expect(lifeLines.last, '[life] forget instance=伊尔弥亚 token=cleared stop=none');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ───────────────────── ⑧ 切实例：token 与 baseUrl ─────────────────────

  testWidgets('⑧ 切换实例：baseUrl 与内存里的 token 都换成新的（旧 token 不被复用）', (tester) async {
    seedInstances([
      entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true),
      entryJson(id: instanceB, name: '工作实例', port: 7789),
    ]);
    // A 是当前这一台（手上有一张 A 的票），B 在跑、盘上有 B 的票
    api.instance = instanceA;
    api.serverInstance = instanceA;
    api.token = 'token-A';
    api.goodToken = 'token-A';
    store.write(instanceA, 'token-A');
    store.write(instanceB, 'token-B');
    state.instance = instanceA;
    state.ready = true;
    host.probes[7789] = _probeJson(instanceB, '工作实例', 7789);
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);

    await tester.pumpWidget(MaterialApp(theme: IrmiaTheme.light(), home: const SizedBox.shrink()));
    final target = InstanceBook.load().byId(instanceB)!;
    // 7789 那台自报的身份（切过去之后，服务端说的就是它自己是谁）
    api.instance = instanceB;
    api.serverInstance = instanceB;
    api.goodToken = 'token-B';
    unawaited(state.openInstance(target));
    for (var i = 0; i < 40; i += 1) {
      await tester.pump(const Duration(milliseconds: 50));
      if (state.ready || state.gate == AuthGateKind.login) break;
    }

    expect(state.api.baseUrl, 'http://127.0.0.1:7789', reason: '换实例 = 换 baseUrl');
    expect(state.instance, instanceB, reason: '实例标识要重新学回来（B 的）');
    expect(state.api.token, 'token-B', reason: '用的是**B 盘上那份**票');
    // 关键的反向断言：切过去之后的每一条请求都不许带着 A 的票
    expect(api.tokensUsed.contains('token-A'), isFalse,
        reason: '切走之后旧 token 一次都不许再出现（实例之间没有编辑权限）');
    expect(state.ready, isTrue, reason: 'B 盘上那张票有效 ⇒ 直接进门');
    expect(api.requests, isEmpty, reason: '有票直接进：一条 auth/命令请求都不发');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ───────────────────── ⑨ 新建实例 ─────────────────────

  testWidgets('⑨ 新建：目录非空先提示；换「用这个目录」→ 端口 7789 → 就绪后进首次设密码', (tester) async {
    seedInstances([entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true)]);
    final occupied = Directory('${tmp.path}${Platform.pathSeparator}工作实例')..createSync();
    File('${occupied.path}${Platform.pathSeparator}keep.txt').writeAsStringSync('x');
    api.instance = instanceA;
    api.initialized = false; // 新实例还没有密码 ⇒ 进门那一态是"设置密码"
    host.freePortValue = 7789;
    host.probes[7789] = _probeJson('127.0.0.1:7789#newnewnewnewnewnew', '工作实例', 7789,
        dataDir: occupied.path);
    await pumpPicker(tester);
    // 展开「新建实例」表单（"用这个目录"那颗按钮只在表单展开时才有）
    await tester.tap(find.byKey(const ValueKey('picker-new')));
    await tester.pump();

    unawaited(state.createInstance(name: '工作实例', dir: occupied.path));
    for (var i = 0; i < 6; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(state.pickerProblem, InstanceGateProblem.dirNotEmpty, reason: '目录已存在且非空：先提示，不覆盖');
    expect(find.textContaining('目录已存在且非空'), findsOneWidget);
    expect(find.byKey(const ValueKey('new-instance-use-dir')), findsOneWidget, reason: '第二条出路摆在旁边');
    expect(host.launched, isEmpty, reason: '提示这一拍一个进程都不许拉');

    unawaited(state.createInstance(name: '工作实例', dir: occupied.path, useExistingDir: true));
    for (var i = 0; i < 40; i += 1) {
      await tester.pump(const Duration(seconds: 1));
      if (state.gate == AuthGateKind.setup) break;
    }

    expect(host.freePortFrom, <int>[7788], reason: '端口从 7788 起向上找');
    expect(host.launched.single.port, 7789, reason: '选中的是第一个空闲端口 7789');
    expect(host.launched.single.dataDir, occupied.path, reason: '数据目录 = 人当场确认的那一个');
    expect(host.launched.single.nodeExe, 'D:\\agent\\tools\\node\\node.exe', reason: 'node 来自登记表');
    expect(host.launched.single.entry, 'D:\\agent\\app\\dist\\main.js', reason: '入口来自登记表');
    expect(state.gate, AuthGateKind.setup, reason: '新实例没设过密码 ⇒ 进首次设密码那扇门');
    expect(state.api.baseUrl, 'http://127.0.0.1:7789', reason: '切到新实例的端口');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });

  // ───────────────────── ⑩ 删除的禁用判据 ─────────────────────

  testWidgets('⑩ 删除：运行中 / 默认实例的按钮不可用，未运行的普通实例可删', (tester) async {
    seedInstances([
      entryJson(id: instanceA, name: '伊尔弥亚', port: 7788, isDefault: true, pid: '0'),
      entryJson(id: instanceB, name: '工作实例', port: 7789),
      entryJson(id: '127.0.0.1:7790#cccccccccccccccc', name: '备用', port: 7790, pid: '0'),
    ]);
    host.probes[7788] = _probeJson(instanceA, '伊尔弥亚', 7788, isDefault: true);
    host.probes[7789] = _probeJson(instanceB, '工作实例', 7789);
    await pumpPicker(tester);

    TextButton buttonOf(String id) => tester.widget<TextButton>(
          find.byKey(ValueKey('instance-delete-$id')),
        );

    expect(buttonOf(instanceB).onPressed, isNull, reason: '运行中的不许删');
    expect(buttonOf(instanceA).onPressed, isNull, reason: '默认实例不许删（它没在跑也不许）');
    expect(buttonOf('127.0.0.1:7790#cccccccccccccccc').onPressed, isNotNull,
        reason: '未运行的普通实例可以删（否则没有任何一台删得掉）');

    // 真的走一遍删除：条目消失、目录默认留着
    final spare = InstanceBook.load().byId('127.0.0.1:7790#cccccccccccccccc')!;
    final dir = Directory(spare.dataDir)..createSync(recursive: true);
    File('${dir.path}${Platform.pathSeparator}memory.md').writeAsStringSync('记忆');
    // `deleteInstance` 里有一次**真文件写**（登记表原子写）：必须放进 `runAsync` 跑，
    // 否则那座假时钟里那个 Future 永远不会完成（用例会挂到 10 分钟超时）
    final removed = await tester.runAsync(() => state.deleteInstance(spare));
    expect(removed, isTrue);
    expect(InstanceBook.load().byId(spare.id), isNull, reason: '条目要从登记表里消失');
    expect(dir.existsSync(), isTrue, reason: '默认不删目录（那里面是她的记忆与人格）');

    state.dispose();
  });

  // ───────────────────── ⑪ 改名（写 manual，后端永不覆盖） ─────────────────────

  testWidgets('⑪ 改名入口：原名旁的小铅笔 → 对话框（预填原名）→ 取消不写盘', (tester) async {
    seedInstances([entryJson(id: instanceB, name: 'data', port: 7789, pid: '0')]);
    await pumpPicker(tester);

    // 名字旁边确实有一个改名入口（不是只有"删除"）
    expect(find.byKey(const ValueKey('instance-rename-$instanceB')), findsOneWidget);
    expect(find.text('data'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('instance-rename-$instanceB')));
    await tester.pumpAndSettle();
    expect(find.text('给实例改名'), findsOneWidget, reason: '点铅笔要弹出改名对话框');
    // 输入框预填原名（人要改的是它，不是从空开始）：`TextFormField` 的 `EditableText` 里读
    final statefulField = find.descendant(
      of: find.byKey(const ValueKey('instance-rename-field')),
      matching: find.byType(EditableText),
    );
    expect(tester.widget<EditableText>(statefulField).controller.text, 'data');

    // 取消：一个字节都不写（名字与来源都还是原来那份）
    await tester.tap(find.byKey(const ValueKey('instance-rename-cancel')));
    await tester.pumpAndSettle();
    final raw = jsonDecode(File(instancesFile()).readAsStringSync()) as Map<String, dynamic>;
    expect((raw['instances'] as List).single['name'], 'data');
    expect((raw['instances'] as List).single.containsKey('nameSource'), isFalse,
        reason: '取消 ⇒ 不改名字、也不写 nameSource');

    state.dispose();
  });

  testWidgets('⑪b 改名写盘：登记表同步为 name + nameSource=manual，别的字段一个字节都不动', (tester) async {
    seedInstances([
      entryJson(id: instanceB, name: 'data', port: 7789, pid: '0'),
      entryJson(id: instanceA, name: '别人的实例', port: 7788, isDefault: true),
    ]);
    await pumpPicker(tester);

    final target = InstanceBook.load().byId(instanceB)!;
    final unaffectedBefore = (jsonDecode(File(instancesFile()).readAsStringSync())
        as Map<String, dynamic>)['instances'] as List;
    final neighbourBefore = Map<String, dynamic>.from(unaffectedBefore.last as Map);

    // `renameInstance` 里有一次**真文件写**（登记表原子写）：放进 `runAsync` 跑，
    // 否则那座假时钟里那个 Future 永远不会完成（同 ⑩ 删除那条的解释）
    final renamed = await tester.runAsync(() => state.renameInstance(target, '  伊尔弥亚  '));
    expect(renamed, isTrue);

    final raw = jsonDecode(File(instancesFile()).readAsStringSync()) as Map<String, dynamic>;
    final rows = (raw['instances'] as List).cast<Map<String, dynamic>>();
    final mine = rows.firstWhere((row) => row['id'] == instanceB);
    expect(mine['name'], '伊尔弥亚', reason: '首尾空白要压掉（名字是一行字）');
    expect(mine['nameSource'], 'manual', reason: '人工改的名字必须落这一格：后端启动时永不覆盖');
    expect(rows.last, neighbourBefore, reason: '别人的条目逐字段不变');

    // 空名字：当场拒（不写盘、页面给"请给实例起个名字"那一句）
    final again = await tester.runAsync(() => state.renameInstance(target, '   '));
    expect(again, isFalse);
    expect(state.pickerProblem, InstanceGateProblem.nameRequired);
    final afterEmpty = jsonDecode(File(instancesFile()).readAsStringSync()) as Map<String, dynamic>;
    expect(((afterEmpty['instances'] as List).firstWhere(
      (row) => (row as Map)['id'] == instanceB,
    ) as Map)['name'], '伊尔弥亚', reason: '空名字不许把已有的名字洗掉');

    state.dispose();
  });
  // ───────────── ⑫ 等就绪：说清等了多少秒、它在哪一步，并且能叫停 ─────────────

  testWidgets('⑫ 等就绪：看得见"已经等了 N 秒，它还在启动（阶段 …）"，并能点「停止等待」', (tester) async {
    seedInstances([entryJson(id: instanceB, name: '工作实例', port: 7789, pid: '0')]);
    store.write(instanceB, 'token-B');
    // 后端自报"还在消息通道那一步"（阶段由服务端说，界面只负责说人话）
    host.healthPhases[7789] = 'channels';
    await pumpPicker(tester);

    expect(find.text('启动并进入'), findsOneWidget, reason: '前提：有票 + 未运行');
    await tester.tap(find.byKey(const ValueKey('instance-open-$instanceB')));
    for (var i = 0; i < 4; i += 1) {
      await tester.pump(const Duration(seconds: 1));
    }
    await tester.pump();

    // 原来这 180 秒里只有一句"正在启动…"：不说等了多少、不说它卡在哪一步
    expect(find.byKey(const ValueKey('picker-waiting')), findsOneWidget);
    expect(find.textContaining('已经等了 '), findsOneWidget, reason: '要让人看见等了多少秒');
    expect(find.textContaining('它还在启动（阶段：消息通道）'), findsOneWidget,
        reason: '阶段要说人话（channels ⇒ 消息通道）');
    expect(find.text('停止等待'), findsOneWidget, reason: '这一段长得像 180 秒，得让人能叫停');

    // 「停止等待」：不再等了，那一行说清"停在哪一步"，而不是只说"超时"
    await tester.tap(find.byKey(const ValueKey('picker-stop-waiting')));
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();

    expect(state.pickerWaiting, isFalse);
    expect(state.pickerProblem, InstanceGateProblem.notReady);
    expect(find.byKey(const ValueKey('picker-stop-waiting')), findsNothing);
    expect(find.byKey(const ValueKey('picker-problem')), findsOneWidget);
    expect(find.textContaining('已经等了'), findsOneWidget, reason: '超时那条也要说等了多久');
    expect(find.textContaining('阶段：消息通道'), findsOneWidget);
    expect(find.textContaining('不再等了'), findsOneWidget);
    expect(find.textContaining('超时'), findsNothing, reason: '不许再只说"超时"');

    await tester.pumpWidget(const SizedBox.shrink());
    state.dispose();
  });
}

/// `/api/instance` 的应答（判活那一条的判据）
Map<String, dynamic> _probeJson(String id, String name, int port,
        {bool isDefault = false, String? dataDir}) =>
    <String, dynamic>{
      'id': id,
      'name': name,
      'dataDir': dataDir ?? 'D:\\agent\\data-$port',
      'port': port,
      'pid': 4321,
      'isDefault': isDefault,
      'runningMs': 1234,
    };

/// 记录过一次拉起调用（"用哪几格起进程"那几条断言读它）
class _Launch {
  _Launch({
    required this.nodeExe,
    required this.entry,
    required this.dataDir,
    required this.port,
  });

  final String nodeExe;
  final String entry;
  final String dataDir;

  /// 交给进程的那个端口（`--port`；多实例的关键一格）
  final int port;
}

/// 外部世界的替身：**一个系统调用都不发**，只记录"问了什么、按什么顺序"。
class _FakeHost {
  _FakeHost(this.log);

  /// 与 `_FakeApi` 共用的时间线（`probe:` / `alive:` / `launch:` / `kill:` / `freePort:`）
  final List<String> log;

  /// 端口 → `/api/instance` 的应答（没有 = 没在跑）
  final Map<int, Map<String, dynamic>> probes = <int, Map<String, dynamic>>{};

  /// 端口 → 后端自报的启动阶段（`/api/health` 的 phase；没有 = 不报阶段）。
  ///
  /// 它只喂"已经等了 N 秒，它还在启动（阶段 …）"那一行——**等就绪的判据仍是 `/api/instance`**。
  final Map<int, String> healthPhases = <int, String>{};

  /// 端口 → 还要应答几拍才消失（`_awaitPortGone` 那条路要能"等两拍"）
  final Map<int, int> alivePlan = <int, int>{};

  final List<_Launch> launched = <_Launch>[];
  final List<int> killed = <int>[];
  final List<int> freePortFrom = <int>[];

  /// `freePort` 的返回值（null = 找不到）
  int? freePortValue;

  /// 下一次 `launch` 返回什么
  bool launchOk = true;

  InstanceHost get host => InstanceHost(
        probe: (host, port) async {
          log.add('probe:$port');
          return InstanceProbe.fromJson(probes[port]);
        },
        // `GET /api/health`：只回答"到哪一步了"（没摆数据 = 这一版不报阶段）
        health: (host, port) async {
          log.add('health:$port');
          final phase = healthPhases[port] ?? '';
          return phase.isEmpty
              ? const BackendReading(BackendReadiness.unknown)
              : BackendReading(BackendReadiness.starting, phase: phase);
        },
        portAlive: (host, port) async {
          log.add('alive:$port');
          final left = alivePlan[port] ?? 0;
          if (left > 0) {
            alivePlan[port] = left - 1;
            return true;
          }
          return false;
        },
        launch: ({
          required String nodeExe,
          required String entry,
          required String dataDir,
          required int port,
        }) async {
          log.add('launch:$dataDir:$port');
          launched.add(_Launch(nodeExe: nodeExe, entry: entry, dataDir: dataDir, port: port));
          return launchOk;
        },
        freePort: (from, host) async {
          freePortFrom.add(from);
          log.add('freePort:$from');
          return freePortValue;
        },
        killPort: (port) async {
          killed.add(port);
          log.add('kill:$port');
          return const BackendStopResult(ok: true, pid: 4321, detail: 'killed');
        },
      );
}

/// API 替身：两条认证/命令端点按服务端的形状回，读端点按"这台实例设没设密码"分流。
///
/// ⚠ 所有 `get/post/postAuth` 都被覆盖了：不覆盖的话 `AppState` 会走**真 HTTP**
/// 打到 `127.0.0.1:7788`——假时钟里那条真连接永远不会完成（用例挂住），而且真机上
/// 那个端口上跑着用户正在用的实例（一次真的 stop-instance 就能把它停掉）。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.log) : super(baseUrl: 'http://127.0.0.1:7788');

  /// 与 host 共用的时间线（请求那几条记成 `auth/logout` / `stop-instance` / `GET <path>`）
  final List<String> log;

  /// **只留命令与认证那两条**的请求序列（时间线里混着 host 的行，顺序断言要比下标）
  List<String> get requests =>
      log.where((line) => line == 'auth/logout' || line == 'stop-instance').toList();

  /// 服务端**自报**的身份（401 响应体里那个 `instance`；与客户端记着的 `api.instance` 是两件事：
  /// 切实例时后者会被清空，而服务端永远说自己是谁）
  String? serverInstance;

  /// 每条请求**实际带出去的** token（"旧 token 不许被复用"那条断言读它）
  final List<String?> tokensUsed = <String?>[];

  bool failStop = false;

  /// 这台实例设过密码吗（false ⇒ bootstrap 走"设置密码"那扇门）
  bool initialized = true;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    log.add('GET $path');
    tokensUsed.add(token);
    if (path == '/api/auth/state') {
      return <String, dynamic>{'initialized': initialized};
    }
    // 手上的票对不对：只有"这一台（serverInstance）的票"才算数（换实例之后旧票必须被拒）
    final good = initialized ? goodToken : null;
    if (good == null || token != good) {
      throw ApiAuthError(
        initialized ? '会话凭据无效或已失效。请重新登录。' : '这台实例还没设过密码。请先在界面里设置一个密码。',
        code: initialized ? 'unauthorized' : 'auth-uninitialized',
        instance: serverInstance,
      );
    }
    return <String, dynamic>{'lastSeq': 1, 'state': 'idle', 'tiles': <String, dynamic>{'needsReview': 0}};
  }

  /// "盘上那份票"现在应该是哪一串（用例按需摆：切到 B 之后就是 `token-B`）
  String? goodToken;

  @override
  Future<dynamic> postAuth(String path, Map<String, dynamic> body) async {
    log.add(path == '/api/auth/logout' ? 'auth/logout' : path);
    tokensUsed.add(token);
    if (path == '/api/auth/logout') return <String, dynamic>{'ok': true, 'instance': instance};
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    log.add(path == '/api/commands/stop-instance' ? 'stop-instance' : 'POST $path');
    tokensUsed.add(token);
    if (path == '/api/commands/stop-instance') {
      if (failStop) throw ApiError(404, '没有注入更新检查宿主');
      return <String, dynamic>{'ok': true, 'stopping': true};
    }
    return <String, dynamic>{'ok': true};
  }
}
