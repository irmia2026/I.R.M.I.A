/// 后端端口的三级来源 + "后端还没起来"那一屏（2026-10-26 的事故）。
///
/// 事故现场：用户点「重启前后端」⇒ 界面连到 `1580`（父进程环境变量继承来的脏值），
/// 屏幕上只有 `SocketException … port = 1580`。这一份钉住四件事：
///
///   ① **端口来源三档**：`%LOCALAPPDATA%\Irmia\server.json` > `IRMIA_WEB_PORT` > 7788；
///      文件坏了/字段不对 ⇒ **当没有**（顺着往下一档走，绝不瞎猜一个端口）；
///   ② 连不上时**不崩、不画红字**：门卡上写着"后端还没起来（正在等 :7788）"，自动重试；
///   ③ 日志里有那行 `[net] waiting backend port=7788 source=file|env|default`
///      （事故那天缺的就是"这个端口从哪来"）；
///   ④ 后端起来之后界面**自己进门**（一次按键都不用按）；
///   ⑤ 505/500 那种"它在那并且说不行"仍然是当场说话（别把"还在起"与"真失败"混成一档）。
library;

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/auth_gate.dart';
import 'package:irmia_gui/backend_port.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/theme.dart';

void main() {
  late Directory tmpDir;
  late String serverFile;

  setUp(() {
    tmpDir = Directory.systemTemp.createTempSync('irmia-port-');
    serverFile = '${tmpDir.path}${Platform.pathSeparator}server.json';
  });

  tearDown(() {
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录删不掉不影响断言结论
    }
  });

  // ──────────────────────── ① 三级来源 ────────────────────────

  group('端口三级来源（文件 > 环境变量 > 默认 7788）', () {
    test('① 有 server.json ⇒ 用它（环境变量里那个脏值不许生效）', () {
      File(serverFile).writeAsStringSync(
        '{"port":7801,"pid":58888,"since":"2026-10-26T09:00:00.000Z"}',
      );
      final resolved = resolveBackendPort(
        env: {'LOCALAPPDATA': tmpDir.path, 'IRMIA_WEB_PORT': '1580'},
        portFilePath: serverFile,
      );
      expect(resolved.port, 7801);
      expect(resolved.source, BackendPortSource.file);
      expect(resolved.pid, 58888);
      expect(resolved.sourceLabel, 'file');
    });

    test('② server.json 坏掉（不是 JSON）⇒ 回落环境变量', () {
      File(serverFile).writeAsStringSync('{"port": 78'); // 后端写到一半被杀
      final resolved = resolveBackendPort(
        env: {'LOCALAPPDATA': tmpDir.path, 'IRMIA_WEB_PORT': '7802'},
        portFilePath: serverFile,
      );
      expect(resolved.port, 7802);
      expect(resolved.source, BackendPortSource.env);
      expect(resolved.sourceLabel, 'env');
    });

    test('②b server.json 的形状不对（port 是字符串 / 0 / 超界）⇒ 都当没有', () {
      for (final body in <String>[
        '{"port":"7788"}',
        '{"port":0}',
        '{"port":70000}',
        '{"pid":1}',
        '[]',
        'null',
      ]) {
        File(serverFile).writeAsStringSync(body);
        final resolved = resolveBackendPort(
          env: {'LOCALAPPDATA': tmpDir.path, 'IRMIA_WEB_PORT': '7803'},
          portFilePath: serverFile,
        );
        expect(resolved.source, BackendPortSource.env, reason: '坏文件不许生效：$body');
        expect(resolved.port, 7803, reason: '坏文件必须顺着往下一档走：$body');
      }
    });

    test('③ 两档都没有 ⇒ 默认 7788', () {
      final resolved = resolveBackendPort(
        env: {'LOCALAPPDATA': tmpDir.path},
        portFilePath: serverFile,
      );
      expect(resolved.port, kDefaultBackendPort);
      expect(kDefaultBackendPort, 7788);
      expect(resolved.source, BackendPortSource.defaultPort);
      expect(resolved.sourceLabel, 'default');
    });

    test('③b 文件不存在 + 环境变量是脏值 ⇒ 默认 7788', () {
      final resolved = resolveBackendPort(
        env: {'LOCALAPPDATA': tmpDir.path, 'IRMIA_WEB_PORT': 'abc'},
        portFilePath: serverFile,
      );
      expect(resolved.port, 7788);
      expect(resolved.source, BackendPortSource.defaultPort);
    });

    test('④ 路径口径：`%LOCALAPPDATA%\\Irmia\\server.json`（与后端同一个名字）', () {
      final path = serverPortFilePath({'LOCALAPPDATA': r'C:\fake-localappdata'});
      expect(path, isNotNull);
      expect(path, endsWith('Irmia${Platform.pathSeparator}server.json'));
      expect(path, contains('fake-localappdata'));
      expect(kServerPortFileName, 'server.json');
      expect(serverPortFilePath({}), isNull, reason: '拿不到 LOCALAPPDATA 就不猜一个目录');
    });
  });

  // ──────────────────────── ②③④ 门上的"等后端" ────────────────────────

  group('后端还没起来那一屏', () {
    test('⑤ 连不上：不画红字、写着"后端还没起来（正在等 :7788）"、自动重试', () async {
      final api = _FakeApi()..starting = true;
      final state = AppState(api: api);
      final lines = <String>[];
      state.netLogSink = lines.add;
      addTearDown(state.dispose);

      await state.bootstrap();

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.checking, reason: '不该把"还在起"读成"你没凭据"');
      expect(state.gateRetrying, isTrue);
      expect(state.gateUnreachable, isFalse);
      expect(state.gateError, isEmpty, reason: '503 starting 是"正在起"，不是红字错误');
      // 那行日志：端口 + 来源（事故那天缺的就是"这个端口从哪来"）
      expect(lines, contains('[net] waiting backend port=7788 source=default'));
    });

    testWidgets('⑤b 门卡上摆着那句话，且没有红色错误行', (tester) async {
      final api = _FakeApi()..starting = true;
      final state = AppState(api: api);

      await state.bootstrap();
      await _pumpGate(tester, state);

      expect(find.text('正在连接本地服务'), findsOneWidget, reason: '中性话，不是"连不上"那张错误卡');
      expect(find.textContaining('后端还没起来（正在等 :7788）'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline_rounded), findsNothing, reason: '这一屏不许出现红字错误行');
      expect(find.text('立即重试'), findsNothing, reason: '自动重试中，不该让人以为必须按它');

      // 收掉那条重连定时器（它在真机上本来就会跟着窗口退场，用例里要显式收）。
      // 只在这里收一次：`addTearDown` 里那次会让 dispose 走两遍（ChangeNotifier 会 assert）。
      state.dispose();
    });

    test('⑥ 后端 ready 后自动进门（一次按键都不用按）', () async {
      final api = _FakeApi()..starting = true;
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      expect(state.ready, isFalse);

      // "node 载入完了"：后端开始正常答话（这一拍由门前那条定时器自己打出来）
      api.starting = false;
      await _until(() => state.ready, tries: 200);
      expect(state.ready, isTrue, reason: '后端一好，界面自己进门');
      expect(state.gateRetrying, isFalse, reason: '进门之后门前那套重连该收掉');
      expect(state.gateError, isEmpty);
    });

    test('⑦ 500 那种"它在那并且说不行"仍然当场说话（别与"还在起"混成一档）', () async {
      final api = _FakeApi()..serverError = true;
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      expect(state.gateUnreachable, isTrue);
      expect(state.gateError, contains('连不上本地服务'));
      expect(state.gateRetrying, isFalse, reason: '不会随时间自己好的失败不许自动猛试');
    });

    test('⑧ 重试途中读到后端刚写的端口文件 ⇒ 切过去（只采纳 file 那一档）', () async {
      var calls = 0;
      final api = _FakeApi(port: 7788)..starting = true;
      final state = AppState(
        api: api,
        backendPortResolver: () {
          calls += 1;
          // 第一拍还什么都没有（后端没起来），第二拍起读到后端写下的 7801
          return calls <= 1
              ? const BackendPort(port: 7788, source: BackendPortSource.defaultPort)
              : const BackendPort(port: 7801, source: BackendPortSource.file, pid: 1234);
        },
      );
      final lines = <String>[];
      state.netLogSink = lines.add;
      addTearDown(state.dispose);

      await state.bootstrap();
      expect(state.backendPort, 7788);
      await _until(() => state.backendPort == 7801, tries: 200);
      expect(api.baseUrl, 'http://127.0.0.1:7801', reason: '换端口之后，下一条请求就打到新端口');
      expect(lines.any((line) => line.startsWith('[net] port switched from=7788 to=7801')), isTrue,
          reason: '"界面自己换了端口"这种事必须查得到');
    });

    test('⑧b 重试途中端口文件消失 ⇒ **不**退回环境变量/默认值（继续等原来那个端口）', () async {
      var calls = 0;
      final api = _FakeApi(port: 7801)..starting = true;
      final state = AppState(
        api: api,
        backendPortResolver: () {
          calls += 1;
          return calls <= 1
              ? const BackendPort(port: 7801, source: BackendPortSource.file, pid: 1234)
              : const BackendPort(port: 1580, source: BackendPortSource.env);
        },
      );
      addTearDown(state.dispose);

      await state.bootstrap();
      await Future<void>.delayed(const Duration(milliseconds: 600));
      expect(state.backendPort, 7801, reason: '后端退出时文件被删了：不许因此跳到一个环境变量里的脏端口');
      expect(api.baseUrl, 'http://127.0.0.1:7801');
    });
  });
}

// ──────────────────────────── 用例脚手架 ────────────────────────────

/// 等到条件成立（50ms 一拍）。
///
/// 门前重试是**真定时器**（0.3/0.5/1/2 秒），所以"后端起来之后自己进门"只能用真等待
/// 把它等出来——这不是"随便睡一会儿"，而是等那个设计里的节奏。
Future<void> _until(bool Function() ready, {int tries = 100}) async {
  for (var i = 0; i < tries; i += 1) {
    if (ready()) return;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  fail('等待条件未成立（等了 ${tries * 50} 毫秒）');
}

Widget _harness(AppState state) => MaterialApp(
      theme: IrmiaTheme.light(),
      home: ListenableBuilder(
        listenable: state,
        builder: (context, _) => state.ready ? HomeShell(state: state) : AuthGate(state: state),
      ),
    );

Future<void> _pumpGate(WidgetTester tester, AppState state) async {
  tester.view.physicalSize = const Size(1350, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_harness(state));
  await tester.pump(const Duration(milliseconds: 50));
}

/// 门用的最小 API 替身：只认"还没就绪 / 连不上 / 服务端 500 / 一切正常"这四态。
class _FakeApi extends IrmiaApi {
  _FakeApi({int port = 7788}) : super(baseUrl: 'http://127.0.0.1:$port');

  /// true = 服务端在答 503 + `{starting:true,phase}`（端口在听、重活没干完）
  bool starting = false;

  /// true = 抛一个连接类异常（形状与"主进程没在跑"时 dart:io 抛的一样）
  bool down = false;

  /// true = 服务端答 500（它在那，并且说不行）
  bool serverError = false;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (down) throw const SocketException('由于目标计算机积极拒绝，无法连接。');
    if (starting) {
      throw const ApiError(503, '后端还在启动（阶段 events）', starting: true);
    }
    if (serverError) throw const ApiError(500, '服务端内部错误');
    if (path == '/api/auth/state') return <String, dynamic>{'initialized': true};
    if (path == '/api/stats/dashboard') {
      return <String, dynamic>{
        'lastSeq': 0,
        'pending': <dynamic>[],
        'state': 'idle',
        'stateText': '就绪',
        'tiles': {'needsReview': 0},
      };
    }
    if (path.startsWith('/api/persona/file')) return {'content': ''};
    return <String, dynamic>{
      'lastSeq': 0,
      'pending': <dynamic>[],
      'state': 'idle',
      'stateText': '就绪',
      'tiles': {'needsReview': 0},
      'files': <dynamic>[],
      'relationships': <dynamic>[],
      'proposals': <dynamic>[],
      'items': <dynamic>[],
    };
  }

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

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    if (starting) throw const ApiError(503, '后端还在启动', starting: true);
    return <String, dynamic>{'ok': true};
  }
}
