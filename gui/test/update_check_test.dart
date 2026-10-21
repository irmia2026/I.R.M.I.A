/// 更新检查的界面层（`lib/update_check.dart`）与状态（`AppState` 里的那几格）。
///
/// 只测**判据与文案**，不跑后端、不碰网络、不开浏览器：
///   · `UpdateInfo.fromJson` 的解析与四种 status 的语义；
///   · 顶部提醒条：available 可关、required 不可关、文案逐字；
///   · 设置页那一块：按钮、忙碌态、关闭态；
///   · 托盘的"有新版本"那一行（与待批同一条纪律：没有就不摆）；
///   · "×"关掉的是**这一版**（落 ui-state，下一个版本重新出现）。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/external_link.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/shell/tray.dart';
import 'package:irmia_gui/ui_state.dart';
import 'package:irmia_gui/update_check.dart';

UpdateInfo info({
  String status = 'available',
  String? latest = '0.1.0-beta.13',
  bool enabled = true,
  String? minimum,
  String? reason,
}) =>
    UpdateInfo(
      enabled: enabled,
      channel: 'beta',
      currentVersion: '0.1.0-beta.12',
      status: status,
      intervalHours: 12,
      dismissible: status != 'required',
      latestVersion: latest,
      downloadUrl: 'https://irmia.me/releases/beta/setup.exe',
      notesUrl: 'https://irmia.me/releases/beta/',
      minimumVersion: minimum,
      reason: reason,
      checkedAt: '2026-10-21T12:00:00.000Z',
      lastSuccessAt: '2026-10-21T12:00:00.000Z',
      nextAllowedAt: '2026-10-22T00:00:00.000Z',
    );

Widget host(Widget child, {AppLanguage language = AppLanguage.zh}) => MaterialApp(
      theme: ThemeData(useMaterial3: true),
      home: IrmiaStrings(
        strings: stringsFor(language),
        child: Scaffold(body: child),
      ),
    );

void main() {
  setUp(() {
    stateFileOverride =
        '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-update-ui-test.json';
    final file = File(stateFileOverride!);
    if (file.existsSync()) file.deleteSync();
  });

  tearDown(() {
    stateFileOverride = null;
  });

  group('UpdateInfo.fromJson', () {
    test('完整形状逐字段解析', () {
      final parsed = UpdateInfo.fromJson({
        'enabled': true,
        'channel': 'beta',
        'currentVersion': '0.1.0-beta.12',
        'status': 'available',
        'latestVersion': '0.1.0-beta.13',
        'downloadUrl': 'https://irmia.me/x.exe',
        'notesUrl': 'https://irmia.me/notes',
        'minimumVersion': null,
        'reason': 'newer',
        'checkedAt': '2026-10-21T12:00:00.000Z',
        'lastSuccessAt': '2026-10-21T12:00:00.000Z',
        'nextAllowedAt': '2026-10-22T00:00:00.000Z',
        'intervalHours': 12,
        'dismissible': true,
      });
      expect(parsed, isNotNull);
      expect(parsed!.hasUpdate, isTrue);
      expect(parsed.required, isFalse);
      expect(parsed.viewUrl, 'https://irmia.me/notes', reason: '「查看」优先打开发布说明');
      expect(parsed.intervalHours, 12);
    });

    test('形状不对 ⇒ null（界面说"读不到"，不猜）', () {
      expect(UpdateInfo.fromJson(null), isNull);
      expect(UpdateInfo.fromJson('nope'), isNull);
      expect(UpdateInfo.fromJson(<String, dynamic>{}), isNull);
      expect(
        UpdateInfo.fromJson(<String, dynamic>{'status': 'available', 'channel': 'beta'}),
        isNull,
        reason: '缺 currentVersion 就不是一份能显示的现状',
      );
    });

    test('required：dismissible 由服务端说，界面不另算', () {
      final parsed = UpdateInfo.fromJson({
        'enabled': true,
        'channel': 'beta',
        'currentVersion': '0.1.0-beta.12',
        'status': 'required',
        'latestVersion': '0.1.0-beta.14',
        'minimumVersion': '0.1.0-beta.13',
        'dismissible': false,
      });
      expect(parsed!.required, isTrue);
      expect(parsed.dismissible, isFalse);
    });
  });

  test('formatUpdateStamp：ISO → 本地 YYYY-MM-DD HH:mm；解析不了给 —', () {
    expect(formatUpdateStamp(null), '—');
    expect(formatUpdateStamp('not-a-time'), '—');
    expect(
      formatUpdateStamp('2026-10-21T12:34:00.000Z'),
      matches(RegExp(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$')),
      reason: '按本地时区显示，但形状固定（不引 intl）',
    );
  });

  group('顶部提醒条', () {
    testWidgets('available：文案 「有新版本 vX（当前 vY）· 查看」，× 只在 available 时在', (tester) async {
      var dismissed = 0;
      await tester.pumpWidget(host(UpdateBanner(
        info: info(),
        dismissedVersion: '',
        onDismiss: () => dismissed += 1,
      )));
      expect(find.byKey(const ValueKey('update-banner')), findsOneWidget);
      expect(
        find.text('有新版本 v0.1.0-beta.13（当前 v0.1.0-beta.12）· 查看'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('update-banner-view')), findsOneWidget);
      expect(find.byKey(const ValueKey('update-banner-dismiss')), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('update-banner-dismiss')));
      expect(dismissed, 1);
    });

    testWidgets('required：文案说「低于最低可用版本，请先升级」，没有 ×（不可 dismiss）', (tester) async {
      await tester.pumpWidget(host(UpdateBanner(
        info: info(status: 'required', latest: '0.1.0-beta.14', minimum: '0.1.0-beta.13'),
        dismissedVersion: '0.1.0-beta.14',
        onDismiss: () {},
      )));
      expect(
        find.text('有新版本 v0.1.0-beta.14（当前 v0.1.0-beta.12）· 低于最低可用版本，请先升级'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('update-banner-dismiss')),
        findsNothing,
        reason: 'required 不可关：关掉它并不会让版本变新',
      );
    });

    testWidgets('这一版被关过 ⇒ 不再出现；换成新一版 ⇒ 重新出现', (tester) async {
      await tester.pumpWidget(host(UpdateBanner(
        info: info(),
        dismissedVersion: '0.1.0-beta.13',
        onDismiss: () {},
      )));
      expect(find.byKey(const ValueKey('update-banner')), findsNothing);

      await tester.pumpWidget(host(UpdateBanner(
        info: info(latest: '0.1.0-beta.14'),
        dismissedVersion: '0.1.0-beta.13',
        onDismiss: () {},
      )));
      expect(find.byKey(const ValueKey('update-banner')), findsOneWidget);
    });

    testWidgets('没有更新（none / unknown / 关闭）⇒ 什么都不画', (tester) async {
      for (final data in <UpdateInfo?>[
        null,
        info(status: 'none'),
        info(status: 'unknown', reason: 'timeout'),
        info(enabled: false),
      ]) {
        await tester.pumpWidget(host(UpdateBanner(
          info: data,
          dismissedVersion: '',
          onDismiss: () {},
        )));
        expect(find.byKey(const ValueKey('update-banner')), findsNothing);
      }
    });

    testWidgets('英文：同一句话有英文版（i18n 口径）', (tester) async {
      await tester.pumpWidget(host(
        UpdateBanner(info: info(), dismissedVersion: '', onDismiss: () {}),
        language: AppLanguage.en,
      ));
      expect(find.text('Update v0.1.0-beta.13 available (current v0.1.0-beta.12)· View'),
          findsOneWidget);
    });
  });

  group('设置页「关于」里的更新那一块', () {
    testWidgets('按钮、状态、通道与时间都在；点按钮只触发一次 onCheck', (tester) async {
      var checks = 0;
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(),
        busy: false,
        switching: false,
        error: '',
        onCheck: () => checks += 1,
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('更新'), findsOneWidget);
      // 与提示条**同一个 key**：标题逐字相同
      expect(find.text('有新版本 v0.1.0-beta.13（当前 v0.1.0-beta.12）'), findsOneWidget);
      expect(find.textContaining('当前版本：v0.1.0-beta.12'), findsOneWidget);
      expect(find.textContaining('下次允许检查：'), findsOneWidget);
      expect(find.text('通道：beta'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('update-check-now')));
      expect(checks, 1);
      await tester.tap(find.byKey(const ValueKey('update-download')));
      expect(find.byKey(const ValueKey('update-dialog')), findsNothing, reason: 'onDownload 由宿主实现，本组件只回调');
    });

    testWidgets('忙碌：按钮禁用并说「正在检查…」', (tester) async {
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(),
        busy: true,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('正在检查…'), findsOneWidget);
      final button = tester.widget<FilledButton>(find.byKey(const ValueKey('update-check-now')));
      expect(button.onPressed, isNull);
    });

    testWidgets('关闭态：说「已关闭」，按钮不可按', (tester) async {
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(enabled: false),
        busy: false,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('更新检查已在配置里关闭（update.enabled = false）'), findsOneWidget);
      final button = tester.widget<FilledButton>(find.byKey(const ValueKey('update-check-now')));
      expect(button.onPressed, isNull);
    });

    testWidgets('unknown：只说「这次没查到（原因）」，不弹窗', (tester) async {
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(status: 'unknown', latest: null, reason: 'timeout'),
        busy: false,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('这次没查到（超时）'), findsOneWidget);
    });

    testWidgets('500：原因翻成人话「HTTP 500」，不是原始错误码', (tester) async {
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(status: 'unknown', latest: null, reason: 'http-500'),
        busy: false,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('这次没查到（HTTP 500）'), findsOneWidget);
    });

    testWidgets('required：同一句标题 + 「低于最低可用版本…请先升级」，并给出下载入口', (tester) async {
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(status: 'required', latest: '0.1.0-beta.14', minimum: '0.1.0-beta.13'),
        busy: false,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('有新版本 v0.1.0-beta.14（当前 v0.1.0-beta.12）'), findsOneWidget);
      expect(find.text('低于最低可用版本（v0.1.0-beta.13），请先升级'), findsOneWidget);
      expect(find.byKey(const ValueKey('update-download')), findsOneWidget);
    });

    testWidgets('通道不匹配：说「站点上没有这条通道的版本」，不冒充"已是最新"', (tester) async {
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(status: 'none', latest: '0.1.0-beta.13', reason: 'channel-mismatch'),
        busy: false,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: (_) {},
        onDownload: () {},
      )));
      expect(find.text('站点上没有这条通道的版本（通道不匹配）'), findsOneWidget);
      expect(find.text('已是最新版本'), findsNothing);
    });

    testWidgets('点 Stable：只回调一次 onChannel("stable")；切的时候整组分段禁用', (tester) async {
      final picked = <String>[];
      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(),
        busy: false,
        switching: false,
        error: '',
        onCheck: () {},
        onChannel: picked.add,
        onDownload: () {},
      )));
      await tester.tap(find.text('Stable'));
      expect(picked, <String>['stable']);

      await tester.pumpWidget(host(UpdateCheckSection(
        info: info(),
        busy: false,
        switching: true,
        error: '',
        onCheck: () {},
        onChannel: picked.add,
        onDownload: () {},
      )));
      final segmented = tester.widget<SegmentedButton<String>>(
        find.byKey(const ValueKey('update-channel-switch')),
      );
      expect(segmented.onSelectionChanged, isNull);
    });
  });

  group('下载页（GUI 里那个分流弹层）', () {
    testWidgets('平台：就绪的给「GitHub 下载」并真的交给系统浏览器；_pending 灰掉「待上传」', (tester) async {
      final opened = <String>[];
      externalUrlOpener = (url) async => opened.add(url);
      addTearDown(() => externalUrlOpener = openUrlInSystemBrowser);

      final data = info();
      final withPlatforms = UpdateInfo.fromJson({
        'enabled': true,
        'channel': 'beta',
        'currentVersion': '0.1.0-beta.12',
        'status': 'available',
        'latestVersion': '0.1.0-beta.13',
        'releasesUrl': 'https://irmia.me/releases/',
        'platforms': [
          {
            'os': 'win32', 'arch': 'x64', 'kind': 'installer',
            'url': 'https://irmia.me/setup.exe', 'pending': false,
          },
          {
            'os': 'linux', 'arch': 'x64', 'kind': 'installer',
            'url': '', 'pending': true,
          },
        ],
        'mirrors': [{'provider': 'pending'}],
      });
      expect(data, isNotNull);

      await tester.pumpWidget(host(TextButton(
        onPressed: () => unawaited(showUpdateReleaseDialog(tester.element(find.byType(TextButton)), withPlatforms!)),
        child: const Text('open'),
      )));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('update-dialog')), findsOneWidget);
      // 同一句话（与提示条/设置页同一个 key）
      expect(find.text('有新版本 v0.1.0-beta.13（当前 v0.1.0-beta.12）'), findsOneWidget);
      expect(find.text('Windows x64 · 安装包'), findsNothing, reason: 'os 保留站点原值（win32）');
      expect(find.text('win32 x64 · 安装包'), findsOneWidget);
      expect(find.text('GitHub 下载'), findsOneWidget);
      expect(find.text('待上传'), findsOneWidget);
      await tester.tap(find.text('GitHub 下载'));
      await tester.pump();
      expect(opened, <String>['https://irmia.me/setup.exe']);
    });

    testWidgets('网盘未就绪：一个 disabled 的「网盘下载 · 即将开放」', (tester) async {
      final data = UpdateInfo.fromJson({
        'enabled': true,
        'channel': 'beta',
        'currentVersion': '0.1.0-beta.12',
        'status': 'available',
        'latestVersion': '0.1.0-beta.13',
        'mirrors': [{'provider': 'pending'}],
      })!;
      await tester.pumpWidget(host(TextButton(
        onPressed: () => unawaited(showUpdateReleaseDialog(tester.element(find.byType(TextButton)), data)),
        child: const Text('open'),
      )));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      final button = tester.widget<OutlinedButton>(find.byKey(const ValueKey('update-mirror-0')));
      expect(button.onPressed, isNull);
      expect(find.text('网盘下载 · 即将开放'), findsOneWidget);
    });

    testWidgets('网盘就绪：按 provider 出按钮，显示提取码与复制入口', (tester) async {
      final data = UpdateInfo.fromJson({
        'enabled': true,
        'channel': 'beta',
        'currentVersion': '0.1.0-beta.12',
        'status': 'available',
        'latestVersion': '0.1.0-beta.13',
        'mirrors': [
          {'provider': 'baidu', 'url': 'https://pan.baidu.com/s/abc', 'code': 'x7k2'},
          {'provider': 'quark', 'url': 'https://pan.quark.cn/s/def'},
        ],
      })!;
      await tester.pumpWidget(host(TextButton(
        onPressed: () => unawaited(showUpdateReleaseDialog(tester.element(find.byType(TextButton)), data)),
        child: const Text('open'),
      )));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('百度网盘下载'), findsOneWidget);
      expect(find.text('夸克网盘下载'), findsOneWidget);
      expect(find.text('提取码：x7k2'), findsOneWidget);
      expect(find.byKey(const ValueKey('update-copy-code-0')), findsOneWidget);
      expect(find.text('提取码：x7k2').evaluate().isNotEmpty, isTrue);
    });
  });

  group('AppState：提醒的显隐与一次性的"×"', () {
    test('available 显示；关掉之后这一版不再显示；required 无视"关过"', () async {
      final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));
      addTearDown(state.dispose);
      state.updateInfo = info();
      expect(state.showUpdateBanner, isTrue);

      await state.dismissUpdateBanner();
      expect(state.updateDismissedVersion, '0.1.0-beta.13');
      expect(state.showUpdateBanner, isFalse, reason: '这一版看过了');

      // 落盘：下一个进程读回来还是"关过这一版"
      final saved = jsonDecode(File(stateFileOverride!).readAsStringSync()) as Map;
      expect(saved[kUpdateDismissedVersionFlag], '0.1.0-beta.13');

      state.updateInfo = info(status: 'required', latest: '0.1.0-beta.14', minimum: '0.1.0-beta.13');
      expect(state.showUpdateBanner, isTrue, reason: 'required 不可关（即使旧版本关过一次）');
    });

    test('关闭更新（enabled:false）⇒ 不显示任何提醒', () {
      final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));
      addTearDown(state.dispose);
      state.updateInfo = info(enabled: false);
      expect(state.showUpdateBanner, isFalse);
    });

    test('restoreUpdateDismissed 从 ui-state.json 读回', () async {
      File(stateFileOverride!).writeAsStringSync(jsonEncode({kUpdateDismissedVersionFlag: '0.1.0-beta.13'}));
      final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));
      addTearDown(state.dispose);
      await state.restoreUpdateDismissed();
      expect(state.updateDismissedVersion, '0.1.0-beta.13');
    });
  });

  group('托盘：有新版本才多一行（与待批同一条纪律）', () {
    test('没有新版本 ⇒ 菜单里没有 update 项（"已是最新"不占位置）', () {
      final items = trayMenuItems(const ZhStrings());
      expect(items.any((item) => item.key == kTrayKeyUpdate), isFalse);
    });

    test('有新版本 ⇒ 菜单多一项，文案写明版本号；required 换措辞', () {
      final available = trayMenuItems(const ZhStrings(), updateVersion: '0.1.0-beta.13');
      final update = available.firstWhere((item) => item.key == kTrayKeyUpdate);
      expect(update.label, '有新版本 v0.1.0-beta.13 · 查看');

      final required = trayMenuItems(
        const ZhStrings(),
        updateVersion: '0.1.0-beta.14',
        updateRequired: true,
      );
      final requiredItem = required.firstWhere((item) => item.key == kTrayKeyUpdate);
      expect(requiredItem.label, '有新版本 v0.1.0-beta.14 · 请升级');
    });

    test('点它只调 openUpdate（显示窗口 + 落设置页，不自动开浏览器）', () async {
      final calls = <String>[];
      final actions = TrayActions(
        show: () => calls.add('show'),
        hide: () => calls.add('hide'),
        restart: () async => calls.add('restart'),
        quitUi: () => calls.add('quitUi'),
        quitAll: () => calls.add('quitAll'),
        openPending: () => calls.add('openPending'),
        openUpdate: () => calls.add('openUpdate'),
      );
      dispatchTrayMenu(kTrayKeyUpdate, actions);
      await Future<void>.delayed(Duration.zero);
      expect(calls, <String>['openUpdate']);
    });

    test('英文：托盘那一行也翻（i18n 口径）', () {
      final items = trayMenuItems(const EnStrings(), updateVersion: '0.1.0-beta.13');
      final update = items.firstWhere((item) => item.key == kTrayKeyUpdate);
      expect(update.label, contains('0.1.0-beta.13'));
      expect(update.label, contains('Update'));
    });
  });

  test('原因代码 → 人话（中英各一处，绝不把 http-404 直接甩给用户）', () {
    expect(const ZhStrings().updateReasonText('timeout'), '超时');
    expect(const ZhStrings().updateReasonText('http-404'), 'HTTP 404');
    expect(const ZhStrings().updateReasonText('bad-json'), '返回的不是合法 JSON');
    expect(const EnStrings().updateReasonText('timeout'), 'timed out');
    expect(const EnStrings().updateReasonText('http-500'), 'HTTP 500');
    expect(const ZhStrings().updateReasonText('some-future-reason'), 'some-future-reason',
        reason: '未知原因原样保留（不吞成"未知"）');
  });
}
