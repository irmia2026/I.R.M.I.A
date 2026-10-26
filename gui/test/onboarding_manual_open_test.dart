import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/her_name.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/onboarding.dart';
import 'package:irmia_gui/onboarding_request.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 「配置引导」那颗按钮（用户 2026-10-17 ③）：**随时打开首次引导卡，可随时关掉，
/// 不碰首次判据、也不动现有配置**。
///
/// 三条要钉住的：
///   ① 首页那颗按钮真的在（`overview-config-guide` + 「配置引导」这几个字），点了卡就出现；
///   ② 手动打开**不写** `onboarding-done`——那个标志是"第一次启动该弹一次"的唯一来源，
///      不能被"我来看看"消费掉（[shouldShowOnboarding] 的 askedBefore）；
///   ③ 什么都不改就关掉 ⇒ **一个字节都不写**（零 POST）：这就是"不影响现有配置"。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  final List<({String path, Map<String, dynamic> body, String? confirm})> posts = [];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    switch (path) {
      case '/api/config':
        return <String, dynamic>{
          'models': {
            'heavy': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
          },
          'channels': {
            'qqOfficial': {'enabled': true},
            'onebot': {'enabled': false},
            'mentionKeywords': <String>['小七'],
          },
          'trust': {'mode': 'full', 'workspaceRoot': r'D:\work'},
        };
      case '/api/keys':
        return <String, dynamic>{
          'heavy': {'configured': true, 'mask': 'sk-…abcd'},
        };
      case '/api/persona/files':
        return <String, dynamic>{
          'files': [
            {
              'path': kIdentityFile,
              'name': kIdentityFile,
              'bytes': 80,
              'mtime': '2026-10-01T00:00:00.000Z',
              'reserved': true,
              'tokens': 20,
              'proposalCount': 0,
              'proposals': 0,
              // **不是种子**：这台机器已经配好了 ⇒ 自动那条判据不该弹（正是"老用户"的形状）
              'isSeed': false,
            },
          ],
          'relationships': <String>[],
          'proposals': <String>[],
        };
      case '/api/persona/file?path=IDENTITY.md':
        return <String, dynamic>{
          'path': kIdentityFile,
          'content': '# 我是谁\n\n名字：小七\n\n我是小七，这台机器上常驻的伙伴。\n',
          'bytes': 80,
          'mtime': '2026-10-01T00:00:00.000Z',
          'tokens': 20,
          'reserved': true,
        };
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
    posts.add((path: path, body: body, confirm: confirm));
    return <String, dynamic>{'ok': true};
  }
}

void main() {
  late Directory tmpDir;

  setUp(() {
    tmpDir = Directory.systemTemp.createTempSync('irmia-onboarding-manual-');
    stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
  });

  tearDown(() {
    stateFileOverride = null;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });

  /// 交替推进真异步与假时钟（与 onboarding_test.dart 同一手法）
  Future<void> settle(WidgetTester tester, {int rounds = 30}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
      await tester.pump();
    }
  }

  /// 读 `onboarding-done`。
  ///
  /// ⚠ 必须包在 `runAsync` 里：它是**真文件 IO**，而 `testWidgets` 的假时钟不推进真实事件循环
  /// ——直接 `await loadFlag(...)` 会把这个用例挂死（十分钟也回不来，实测踩到过）。
  Future<bool> flagOf(WidgetTester tester) async =>
      (await tester.runAsync(() => loadFlag(kOnboardingDoneFlag))) ?? false;

  /// 收尾：把 toast 的 4 秒定时器跑完，再拆树（否则报 "A Timer is still pending"）
  Future<void> closeOut(WidgetTester tester) async {
    await tester.pump(IrmiaToast.duration);
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  }

  Future<void> pumpHost(WidgetTester tester, AppState state) async {
    tester.view.physicalSize = const Size(1400, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: OnboardingHost(
        state: state,
        child: const Scaffold(body: Center(child: Text('壳'))),
      ),
    ));
    await settle(tester);
  }

  testWidgets('手动打开：卡片出现，且**不写** onboarding-done；什么都没改就关掉 ⇒ 零 POST',
      (tester) async {
    final api = _FakeApi();
    final state = AppState(api: api);
    addTearDown(state.dispose);

    await pumpHost(tester, state);
    // 前置：这台机器已经配好（人格不是种子）⇒ 自动那条判据本来就不会弹
    expect(find.text(kOnboardingTitle), findsNothing);
    expect(await flagOf(tester), isFalse);

    requestOnboarding();
    await settle(tester);
    expect(find.text(kOnboardingTitle), findsOneWidget, reason: '手动通道要把同一张卡打开');
    expect(find.text('1 / 6'), findsOneWidget, reason: '还是那张六步卡（不是另做一张）');
    // 关掉之前：标志一个字节都没被写过
    expect(await flagOf(tester), isFalse,
        reason: '手动打开不许消费"第一次启动该弹一次"那条判据');

    // 什么都不改，点右上角关闭
    await tester.tap(find.byTooltip(kOnboardingCloseLabel));
    await settle(tester);
    expect(find.text(kOnboardingTitle), findsNothing, reason: '随时能关掉');

    // ③ 不影响现有配置：一条命令都没发（卡里每一格都判"改没改"）
    expect(api.posts, isEmpty, reason: '什么都没改就关掉，不该写任何东西');
    // ② 首次判据照旧：标志仍是 false（将来若人格回到种子模板，自动那条还会弹）
    expect(await flagOf(tester), isFalse);
    // 收尾那句如实说"什么都没改"
    expect(find.text(const ZhStrings().onboardingManualNoChanges), findsOneWidget);

    await closeOut(tester);
  });

  testWidgets('首页「配置引导」按钮：在、点了会打开引导卡', (tester) async {
    final api = _FakeApi();
    final state = AppState(api: api);
    addTearDown(state.dispose);

    tester.view.physicalSize = const Size(1400, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: OnboardingHost(
        state: state,
        child: Scaffold(body: OverviewPage(state: state)),
      ),
    ));
    await settle(tester);

    // 按钮在（文案走 AppStrings，位置在「重启前后端」旁边）
    final guide = find.byKey(const ValueKey('overview-config-guide'));
    expect(guide, findsOneWidget);
    expect(find.text(const ZhStrings().overviewConfigGuide), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '重启前后端'), findsOneWidget);
    expect(find.text(kOnboardingTitle), findsNothing, reason: '没点之前不该自己冒出来');

    await tester.tap(guide);
    await settle(tester);
    expect(find.text(kOnboardingTitle), findsOneWidget, reason: '点了「配置引导」就该看见首次引导卡');

    await tester.tap(find.byTooltip(kOnboardingCloseLabel));
    await settle(tester);
    expect(find.text(kOnboardingTitle), findsNothing);
    expect(api.posts, isEmpty, reason: '只是打开看了看，不该写任何配置');
    expect(await flagOf(tester), isFalse);

    await closeOut(tester);
  });

  /// 用户 2026-10-21：手动打开要给一个**看得见的标识**——否则人看到这张卡，
  /// 会以为"它又自己弹了"（自动那条在这台机器上恒不弹，见 shouldShowOnboarding）。
  testWidgets('手动打开：卡头挂着「手动打开 · 不计入首次判据」那行', (tester) async {
    final api = _FakeApi();
    final state = AppState(api: api);
    addTearDown(state.dispose);

    await pumpHost(tester, state);
    expect(find.text(const ZhStrings().onboardingManualOpenBadge), findsNothing,
        reason: '还没点「配置引导」，卡都没开，标识当然不在');

    requestOnboarding();
    await settle(tester);
    expect(find.text(kOnboardingTitle), findsOneWidget);
    expect(find.text(const ZhStrings().onboardingManualOpenBadge), findsOneWidget,
        reason: '手动通道要在卡头写清"这张卡是手动打开的"');
    expect(find.text(const EnStrings().onboardingManualOpenBadge), findsNothing,
        reason: '当前语言是中文，英文那条不该同时出现');

    await tester.tap(find.byTooltip(kOnboardingCloseLabel));
    await settle(tester);
    await closeOut(tester);
  });
}
