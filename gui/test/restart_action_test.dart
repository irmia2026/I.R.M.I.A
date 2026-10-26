import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/restart_action.dart';
import 'package:irmia_gui/shell/tray.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 重启那条路：**一条请求、一套判据、一句话**（首页那颗按钮与托盘那一项共用）。
///
/// 钉住的是 2026-10-17 修掉的病根（现场见 `lib/restart_action.dart` 文件头）：
/// 上一版首页把「服务端没在 8 秒回执窗口里读到链条的 `[实例]`」判成**失败**、弹红字
/// 「重启未能执行」，而本机链条要 28~41 秒才写那行、托盘那一路又根本不判
/// ⇒ 同一件事两条路一套严一套松，人于是只信"托盘才能重启"。
///
/// 这一组用例只碰判据与请求，不重启任何东西（`_FakeApi` 直接喂回执）。
void main() {
  group('回执判据：三态只认链条自己的话', () {
    test('没读到链条回执（scriptStarted=false）⇒ 已发出，**不是失败**', () {
      // 本机三轮真实重启的回执就是这个形状：200 + scriptStarted=false + scriptOk=null
      // + note 里那句"重启未能执行"（服务端照自己的窗口说的，可它并不是事实）
      final receipt = RestartReceipt.of(const <String, dynamic>{
        'ok': true,
        'gui': true,
        'scriptStarted': false,
        'scriptOk': null,
        'backendPid': 0,
        'port': 'unknown',
        'note': '重启未能执行：脚本没有留下回执。',
      });
      expect(receipt.verdict, RestartVerdict.sent, reason: '"没读到"不是"没发生"');

      final report = restartReport(const ZhStrings(), receipt);
      expect(report.kind, ToastKind.info, reason: '红字属于真的失败，不属于还没读到');
      expect(report.message, const ZhStrings().restartSentWithGui);
      expect(report.message.contains('重启未能执行'), isFalse,
          reason: '服务端那句在 8 秒窗口下是误报——界面不该把它当成结论照抄');
    });

    test('链条确认成功 ⇒ 成功，且带上真实新 pid 与端口', () {
      const strings = ZhStrings();
      final receipt = RestartReceipt.of(const <String, dynamic>{
        'ok': true,
        'gui': true,
        'scriptStarted': true,
        'scriptOk': true,
        'backendPid': 54576,
        'port': 'ready',
        'note': '新实例已经接管：真实新 pid 54576 · 端口 127.0.0.1:7788 已就绪',
      });
      expect(receipt.verdict, RestartVerdict.confirmed);
      final report = restartReport(strings, receipt);
      expect(report.kind, ToastKind.success);
      expect(report.message, strings.restartConfirmed('真实新 pid 54576 · 端口已就绪'));
    });

    test('链条自己说失败 ⇒ 失败，并原样带服务端那句原因', () {
      const strings = ZhStrings();
      final receipt = RestartReceipt.of(const <String, dynamic>{
        'gui': false,
        'scriptStarted': true,
        'scriptOk': false,
        'backendPid': 0,
        'port': 'waiting',
        'note': '重启失败：新实例没起来（失败=backend-not-started）',
      });
      expect(receipt.verdict, RestartVerdict.failed);
      final report = restartReport(strings, receipt);
      expect(report.kind, ToastKind.error);
      expect(report.message, '重启失败：重启失败：新实例没起来（失败=backend-not-started）',
          reason: '服务端那句话本身就是给人读的，界面不加工');
    });

    test('老服务端没有那三格 ⇒ 已发出，不说成功也不说失败', () {
      final receipt = RestartReceipt.of(const <String, dynamic>{'ok': true});
      expect(receipt.verdict, RestartVerdict.sent);
      expect(receipt.started, isTrue, reason: '缺字段按"没读到"读，不按失败读');
    });

    test('只重启后端（gui=false）时那句不许说"连界面一起重启了"', () {
      const strings = ZhStrings();
      final receipt = RestartReceipt.of(const <String, dynamic>{
        'gui': false,
        'scriptStarted': false,
      });
      expect(restartReport(strings, receipt).message, strings.restartSentBackendOnly);
    });

    test('凭据那半句：pid 与端口都没有时如实说没给凭据', () {
      expect(const ZhStrings().restartEvidence(0, false), contains('没给凭据'));
      expect(const ZhStrings().restartEvidence(7, true), '真实新 pid 7 · 端口已就绪');
    });
  });

  group('请求：两条路发的是同一个东西', () {
    test('共享请求的 path / body / confirm 逐字', () async {
      final api = _FakeApi();
      await requestRestart(api, guiExe: r'C:\app\irmia_gui.exe');
      expect(api.requests.single.path, '/api/commands/restart');
      expect(api.requests.single.confirm, 'restart', reason: 'X-Confirm 头就是命令名');
      expect(api.requests.single.body, {'guiExe': r'C:\app\irmia_gui.exe'});
    });

    testWidgets('首页那颗「重启前后端」发的请求与共享请求完全相同', (tester) async {
      final api = _FakeApi(receipt: _confirmed());
      await _pumpOverview(tester, api);
      await tester.tap(find.widgetWithText(FilledButton, '重启前后端'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(api.requests, hasLength(1));
      expect(api.requests.single.path, kRestartEndpoint);
      expect(api.requests.single.confirm, kRestartCommand);
      expect(api.requests.single.body, restartPayload(), reason: '界面把自己的可执行路径带上');
      // 成功那句也必须是共享那一句（不是本页自己拼的）
      expect(find.text(const ZhStrings().restartConfirmed('真实新 pid 9001 · 端口已就绪')),
          findsOneWidget);
      // toast 是 4 秒的浮动条：把它那隻定时器跑完，别留到测试收尾（否则报 Timer is still pending）
      await tester.pump(IrmiaToast.duration);
      await tester.pump(const Duration(milliseconds: 500));
    });

    test('托盘「重启前后端」接到的是同一个 performRestart（分发一次、只调 restart）', () async {
      final api = _FakeApi(receipt: _confirmed());
      var restartCalls = 0;
      var otherCalls = 0;
      final actions = TrayActions(
        show: () => otherCalls += 1,
        hide: () => otherCalls += 1,
        restart: () async {
          restartCalls += 1;
          await performRestart(
            api: api,
            strings: const ZhStrings(),
            say: (_, __) {},
            online: () => true,
            guiExe: Platform.resolvedExecutable,
            maxTicks: 0,
          );
        },
        quitUi: () => otherCalls += 1,
        quitAll: () => otherCalls += 1,
        openPending: () => otherCalls += 1,
      );
      dispatchTrayMenu(kTrayKeyRestart, actions);
      await Future<void>.delayed(Duration.zero);

      expect(restartCalls, 1);
      expect(otherCalls, 0, reason: '菜单项只做自己那一件事');
      expect(api.requests, hasLength(1));
      expect(api.requests.single.path, kRestartEndpoint);
      expect(api.requests.single.confirm, kRestartCommand);
      expect(api.requests.single.body, restartPayload());
    });
  });

  group('发出之后：等它回来，并如实说等到没等到', () {
    test('已发出但结局未确认 ⇒ 先报一句中性的，再等后端断开又回来', () async {
      final said = <({String message, ToastKind kind})>[];
      final api = _FakeApi(receipt: const <String, dynamic>{
        'gui': false,
        'scriptStarted': false,
        'scriptOk': null,
      });
      // 第 1 拍（第一次问）在线，第 2 拍断开，第 3 拍回来——"断开过又回来"这一种
      var asked = 0;
      bool online() {
        asked += 1;
        return asked == 1 || asked >= 3;
      }

      await performRestart(
        api: api,
        strings: const ZhStrings(),
        say: (message, kind) => said.add((message: message, kind: kind)),
        online: online,
        tick: Duration.zero,
        maxTicks: 6,
      );

      expect(said.first.kind, ToastKind.info);
      expect(said.first.message, const ZhStrings().restartSentBackendOnly);
      expect(said.last.message, const ZhStrings().restartBackReady);
      expect(said.last.kind, ToastKind.success);
    });

    test('后端一次都没断开过 ⇒ 如实说"这次请求可能没生效"', () async {
      final said = <({String message, ToastKind kind})>[];
      final api = _FakeApi(receipt: const <String, dynamic>{'gui': true, 'scriptStarted': false});
      await performRestart(
        api: api,
        strings: const ZhStrings(),
        say: (message, kind) => said.add((message: message, kind: kind)),
        online: () => true,
        tick: Duration.zero,
        maxTicks: 3,
      );
      expect(said.last.message, const ZhStrings().restartNeverWentDown);
      expect(said.last.kind, ToastKind.error);
    });

    test('请求被拒（409 已在重启中）⇒ 红字 + 原因，且不进入等待', () async {
      final said = <({String message, ToastKind kind})>[];
      final api = _FakeApi(error: const ApiError(409, '已经在重启了（上一次重启还在进行中）'));
      await performRestart(
        api: api,
        strings: const ZhStrings(),
        say: (message, kind) => said.add((message: message, kind: kind)),
        online: () => true,
        tick: Duration.zero,
        maxTicks: 3,
      );
      expect(said, hasLength(1), reason: '请求都没出去，没有任何东西可等');
      expect(said.single.kind, ToastKind.error);
      expect(said.single.message, startsWith('重启没能发出：'));
      expect(said.single.message, contains('已经在重启了'));
    });

    test('链条自己说失败 ⇒ 只报那一句，不再白等 90 秒', () async {
      final said = <({String message, ToastKind kind})>[];
      final api = _FakeApi(receipt: const <String, dynamic>{
        'scriptStarted': true,
        'scriptOk': false,
        'note': '重启失败：失败=backend-not-started',
      });
      await performRestart(
        api: api,
        strings: const ZhStrings(),
        say: (message, kind) => said.add((message: message, kind: kind)),
        online: () => false,
        tick: Duration.zero,
        maxTicks: 5,
      );
      expect(said, hasLength(1));
      expect(said.single.kind, ToastKind.error);
      expect(said.single.message, '重启失败：重启失败：失败=backend-not-started');
    });
  });
}

Map<String, dynamic> _confirmed() => const <String, dynamic>{
      'ok': true,
      'gui': true,
      'scriptStarted': true,
      'scriptOk': true,
      'backendPid': 9001,
      'port': 'ready',
      'note': '新实例已接管',
    };

/// 首页的替身：4 条 GET 给最小数据，POST 全部记录下来
class _FakeApi extends IrmiaApi {
  _FakeApi({this.receipt, this.error}) : super(baseUrl: 'http://127.0.0.1:1');

  final Object? receipt;
  final Object? error;
  final List<({String path, Map<String, dynamic> body, String? confirm})> requests = [];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    switch (path) {
      case '/api/stats/dashboard':
        return <String, dynamic>{
          'state': 'idle',
          'tiles': <String, dynamic>{'pending': 0, 'failStreak': 0, 'needsReview': 0},
          'budget': <String, dynamic>{'tokensToday': 0},
          'hourly': <dynamic>[],
          'recent': <dynamic>[],
          'suggestions': <dynamic>[],
          'personaIsSeed': false,
        };
      case '/api/projection':
        return <String, dynamic>{'needsReview': <dynamic>[]};
      default:
        return null;
    }
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    requests.add((path: path, body: body, confirm: confirm));
    final failure = error;
    if (failure != null) throw failure;
    return receipt;
  }
}

Future<void> _pumpOverview(WidgetTester tester, IrmiaApi api) async {
  final state = AppState(api: api);
  addTearDown(state.dispose);
  tester.view.physicalSize = const Size(1400, 1200);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: OverviewPage(state: state))),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}
