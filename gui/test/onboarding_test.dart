import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
// 第 3 步那两把凭据的键名（与「消息适配器」页同一份）：断言里逐字对一次
import 'package:irmia_gui/channel_keys.dart';
// 蓝链的打开方式：用例把它换成只记账的假函数（不起真浏览器）
import 'package:irmia_gui/external_link.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/onboarding.dart';
// 首页「配置引导」那颗按钮的手动通道（与自动判据是两条路）
import 'package:irmia_gui/onboarding_request.dart';
// 信任范围那一步的两档字面量与那个二选一控件都在设置页里（两处共用一份，见 TrustModeChoice）
import 'package:irmia_gui/pages/settings_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 让假服务"真的写下去"：这样第二次读现状时看到的就是改过之后的样子。
///
/// 返回的是**回执里那几个额外字段**（照 src/web/server.ts 的形状）：`set-key` 的
/// `gates` / `changed` / `skipped` 就靠它回给界面 —— 引导页的回执要念"写到了哪几格"，
/// 假的这一份也必须照着真服务端的扇出规则写，否则测的是另一套行为。
Map<String, dynamic> applyCommand(Map<String, dynamic> config, Map<String, dynamic> keys,
    Map<String, String> persona, String path, Map<String, dynamic> body) {
  switch (path) {
    case '/api/commands/set-mention-keywords':
      (config['channels'] as Map<String, dynamic>)['mentionKeywords'] = body['keywords'];
      return const {};
    case '/api/commands/config-update':
      for (final entry in (body['fields'] as Map).entries) {
        final segments = (entry.key as String).split('.');
        Map<String, dynamic> cursor = config;
        for (final segment in segments.take(segments.length - 1)) {
          cursor = cursor[segment] as Map<String, dynamic>;
        }
        cursor[segments.last] = entry.value;
      }
      return const {};
    case '/api/commands/set-key':
      final name = body['name'] as String;
      // 与真服务端的 `planModelKeyWrite` 同一条规则：带 `modelRoutes: true` ⇒ 当前配置里
      // **每一条有密钥格的模型路由**都写（今天 heavy / light）；不带 ⇒ 只写这一格。
      final gates = body['modelRoutes'] == true ? <String>['heavy', 'light'] : <String>[name];
      for (final gate in gates) {
        keys[gate] = {'configured': true, 'mask': 'sk-…t3st'};
      }
      return {'name': name, 'gates': gates, 'changed': gates, 'skipped': const <Object>[]};
    case '/api/commands/persona-edit':
      persona[body['file'] as String] = body['content'] as String;
      return const {};
  }
  return const {};
}

/// 首次启动引导（四步：她叫什么 / API 配置 / 消息适配器 / 人格）：
///   ① **判据**（[shouldShowOnboarding]）——抽成纯函数，直接钉住；
///   ② **四步各写哪条通道、带什么确认短语**——用真实 loopback 假服务记下每一次 POST；
///   ③ **"不再弹"落在 ui-state.json**——走完一次之后，再开一次宿主就不该弹。
///
/// 假服务的响应形状照 src/web/server.ts 的真实回包写（persona/files 的 isSeed、
/// set-key 的 {configured,mask}、persona-edit 的 changed）。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, dynamic> config;
  late Map<String, dynamic> keys;
  late Map<String, String> persona;
  late List<Map<String, dynamic>> posts;

  /// 第 6 步读的那份依赖报告（`GET /api/deps`）：默认**四件都已就位**。
  ///
  /// 为什么默认全就位：本文件钉的是前五步各写哪条通道——第 6 步在这里只该"什么都不做"
  /// （不摆勾选框、一个 dep-install 都不发）。"要装 / 装失败 / 重启窗口"那些形状在
  /// `onboarding_deps_test.dart` 里逐条钉。
  late Map<String, String> depStatus;

  /// 蓝链点开时"系统浏览器"收到的地址（[externalUrlOpener] 的替身记在这里）
  late List<String> openedUrls;

  /// 假服务是否拒绝写命令（用来钉住"失败留在原地、不静默丢"）
  bool failCommands = false;

  /// 种子模板与"人写过的一份"：形状照 src/persona/loader.ts 的 SEEDS 抄——
  /// 种子里那句「名字：（改成她的名字）」是**占位符**，不是她的名字（判据见 her_name.dart）。
  const seedIdentity = '<!-- SEED 填写后删除本行 -->\n'
      '<!-- 她的名字写在下面「名字：」那一行 -->\n'
      '# 我是谁\n\n'
      '名字：（改成她的名字）\n\n'
      '（身份、核心性格。）\n';
  const writtenIdentity = '# 我是谁\n\n我是小七，这台机器上常驻的伙伴。\n';

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，本组要打真实服务
    HttpOverrides.global = null;
    failCommands = false;
    posts = [];
    // 蓝链：只记地址，**不真起浏览器**（真要起的话每个用例都会给这台机器弹窗）
    openedUrls = [];
    externalUrlOpener = (url) async => openedUrls.add(url);
    config = {
      'models': {
        'heavy': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
        'light': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
      },
      'channels': {
        'qqOfficial': {'enabled': false},
        'onebot': {'enabled': false},
        'mentionKeywords': <String>[],
      },
    };
    keys = {
      'heavy': {'configured': false, 'mask': null},
      'light': {'configured': false, 'mask': null},
    };
    persona = {'IDENTITY.md': seedIdentity, 'CONSTITUTION.md': '<!-- SEED -->\n# 行为宪法\n'};
    depStatus = {'pwsh': 'ready', 'rg': 'ready', 'es': 'ready', 'python': 'ready'};

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path.startsWith('/api/commands/')) {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        posts.add({
          'path': path,
          'body': body,
          'confirm': req.headers.value('X-Confirm'),
        });
        if (failCommands) {
          response.statusCode = 400;
          response.write(jsonEncode({
            'error': {'code': 'bad-request', 'message': '测试里故意失败'},
          }));
        } else {
          final extra = applyCommand(config, keys, persona, path, body);
          response.write(jsonEncode({'ok': true, ...extra}));
        }
      } else if (path == '/api/config') {
        response.write(jsonEncode(config));
      } else if (path == '/api/keys') {
        response.write(jsonEncode(keys));
      } else if (path == '/api/persona/files') {
        response.write(jsonEncode({
          'root': 'D:/irmia/data/persona',
          'files': [
            for (final entry in persona.entries)
              {
                'path': entry.key,
                'name': entry.key,
                'bytes': utf8.encode(entry.value).length,
                'mtime': '2026-10-01T00:00:00.000Z',
                'reserved': true,
                'tokens': 20,
                'proposalCount': 0,
                'proposals': 0,
                'isSeed': entry.value.contains('<!-- SEED'),
              },
          ],
          'relationships': <String>[],
          'proposals': <String>[],
        }));
      } else if (path == '/api/persona/file') {
        final asked = req.uri.queryParameters['path'] ?? '';
        response.write(jsonEncode({
          'path': asked,
          'content': persona[asked] ?? '',
          'bytes': 0,
          'mtime': '2026-10-01T00:00:00.000Z',
          'tokens': 0,
          'reserved': true,
        }));
      } else if (path == '/api/deps') {
        // 形状照 src/web/server.ts 的 depsView + src/deps/manager.ts 的 DepReportEntry
        response.write(jsonEncode({
          'available': true,
          'dataDir': 'D:/irmia/data',
          'toolsDir': 'D:/irmia/data/tools',
          'needsAttention': depStatus.values.any((status) => status != 'ready'),
          'generatedAt': '2026-10-20T00:00:00.000Z',
          'entries': [
            for (final entry in depStatus.entries)
              {
                'name': entry.key,
                'label': entry.key,
                'status': entry.value,
                'path': entry.value == 'ready' ? 'C:/tools/${entry.key}.exe' : '',
                'version': entry.value == 'ready' ? '1.2.3' : '',
                'source': 'path',
                'attempts': <String>[],
                'reason': '',
                'purpose': '',
                'impact': '',
                'action': entry.value == 'ready' ? null : 'install',
                'installable': true,
                'manualHint': null,
                'downloadPage': null,
                'minVersion': '7.0',
                'managedDir': 'D:/irmia/data/tools/${entry.key}',
                'pipVersion': null,
                'pipReason': '',
              },
          ],
        }));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': '接口不存在'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    externalUrlOpener = openUrlInSystemBrowser; // 替身用完还回去，别漏给后面的用例
    state.dispose();
    await server.close(force: true);
  });

  /// 状态文件指向每次独立的临时文件：别踩真实 %APPDATA% 里的 ui-state.json，
  /// 也别让上一条用例留下的 `onboarding-done` 把下一条挡住。
  ///
  /// 文件名里带上**进程号**：同一个临时目录里跑两份用例（两个工作区、两个进程同时验这套东西）
  /// 时，两份进程会用同一个路径，先跑的那份把文件占住，后一份连删都删不掉
  /// （实测：`deleteSync` 报 OS Error 32，用例在第一步就挂）。加了 pid 各写各的。
  void useStateFile(String name) {
    final path = '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'irmia-ui-state-$name-$pid.json';
    stateFileOverride = path;
    final file = File(path);
    if (file.existsSync()) file.deleteSync();
    // 删掉 = 没有记录 = `loadFlag` 给 false = "没问过"（三态的第一档）。
    // 真·首次安装就是这种形状，所以本文件那些"首次那条路"的用例删完就能自动弹。
    // 注意别在这里写任何东西：`{...false}` 那种"文件在"的档由末尾三态用例单独钉。
  }

  /// 交替推进真异步与假时钟：HttpClient 每一步都要先让真实 I/O 跑完，再 pump 落进树
  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 80}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  /// 收尾：把还在飞的请求、toast 与"退场后销毁控制器"的定时器跑完。
  ///
  /// 顺序很重要：**先**让真实 I/O 跑完（`runAsync`），**再**把假时钟推过 600ms 那道关
  /// （`disposeLater` 的定时器）——反过来的话，定时器是在推时钟之后才被创建的，测试收尾时
  /// 就会报 "A Timer is still pending"（实测踩到过）。
  Future<void> drain(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
    await tester.pump(const Duration(seconds: 2));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
  }

  /// 用例收尾：把树拆掉（卡片 dispose 会排下"退场后销毁控制器"的定时器），再 flush 一次。
  ///
  /// 为什么不能只用 [drain]：卡还挂在树上时那几个定时器压根没被创建，drain 推完时钟它们才出现，
  /// 测试框架收尾时照样报 "A Timer is still pending"。
  Future<void> closeOut(WidgetTester tester) async {
    await drain(tester);
    await tester.pumpWidget(const SizedBox.shrink());
    await drain(tester);
  }

  /// 把宿主挂起来（与 app.dart 的接线同一层）：引导会自己读现状、自己决定弹不弹
  Future<void> pumpHost(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1350, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: OnboardingHost(
        state: state,
        child: const Scaffold(body: Center(child: Text('壳'))),
      ),
    ));
    await tester.pump();
  }

  /// 只等"卡弹出来了"（弹不出来也不会挂满 80 轮）
  Future<void> expectCardShown(WidgetTester tester) async {
    for (var round = 0; round < 60; round++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (find.text(kOnboardingTitle).evaluate().isNotEmpty) return;
    }
    fail('引导卡没有弹出来');
  }

  Future<void> expectNoCard(WidgetTester tester) async {
    for (var round = 0; round < 25; round++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
    expect(find.text(kOnboardingTitle), findsNothing, reason: '这台机器不该自动弹引导卡');
  }

  /// 点卡脚那颗主按钮（「继续」/「完成」）——步骤条上的标题也是「继续」这几个字，
  /// 所以一律按控件类型定位，不按文字。
  ///
  /// 每一轮都套着 `runAsync`：结算是一次真的 HTTP，不把事件循环放出去跑，按钮点下去
  /// 永远停在"正在结算"，后面的断言会看到一个还没动的界面。
  Future<void> tapPrimary(WidgetTester tester) async {
    await pumpUntil(tester, find.byType(FilledButton));
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    for (var i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
  }

  /// 点一个文字按钮，并等这次点击触发的请求跑完（理由同 [tapPrimary]）。
  ///
  /// 一律在**卡片内部**找（`find.descendant`）：壳上、步骤条上也可能有同名文字，
  /// 点错一个按钮会得到一段看着像"逻辑坏了"的怪异行为——那其实是测试点歪了。
  Future<void> tapAndSettle(WidgetTester tester, Finder target) async {
    final inCard = find.descendant(of: find.byType(Dialog), matching: target);
    await pumpUntil(tester, inCard);
    expect(inCard, findsOneWidget, reason: '卡片里应当只有一个 $target');
    await tester.tap(inCard);
    await tester.pump();
    for (var i = 0; i < 12; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
  }

  /// 第 3 步切到「填写凭据」入口（默认是「扫码创建（推荐）」）。
  ///
  /// 2026-10-23 用户要求两个**并列入口**，扫码排第一 ⇒ 原来那两格凭据要人先点一下
  /// 「填写凭据」才摆出来；这两条旧用例验的是凭据那条路，所以先切过去。
  Future<void> chooseManualCredentials(WidgetTester tester) async {
    await tapAndSettle(tester, find.text(const ZhStrings().onboardingQqEntryManual));
  }

  Map<String, dynamic> postFor(String path) =>
      posts.firstWhere((entry) => entry['path'] == path, orElse: () => <String, dynamic>{});

  /// 最后一次发往这条通道的请求（第一步与第四步都走 persona-edit，得能分开看）
  Map<String, dynamic> lastPostFor(String path) =>
      posts.lastWhere((entry) => entry['path'] == path, orElse: () => <String, dynamic>{});

  /// 信任范围那一步的某一档现在是不是选中的。
  ///
  /// 判据是**屏上真的画出来的那一眼**（[TrustModeChoice] 选中态的描边比未选中粗），
  /// 不是"页面自己记了什么"——这个断言要锁的正是"默认高亮哪一档"。
  /// 与 settings_page_test 里那份同一个读法（两处各留一份：测试文件之间不互相 import）。
  bool trustChoiceSelected(WidgetTester tester, String mode) {
    final box = tester.widget<Container>(
      find
          .descendant(of: find.byKey(ValueKey('trust-mode-$mode')), matching: find.byType(Container))
          .first,
    );
    final border = (box.decoration as BoxDecoration).border as Border;
    return border.top.width > 1;
  }

  int postsOf(String path) => posts.where((entry) => entry['path'] == path).length;

  /// 读状态文件里的开关。
  ///
  /// 必须走 `tester.runAsync`：这是**真的**文件 I/O，而在 testWidgets 的 FakeAsync 区里直接
  /// `await file.readAsString()` 永远不会完成（实测：测试就那么挂住，一条日志都不再打）。
  Future<bool> flagOf(WidgetTester tester, String key) async =>
      (await tester.runAsync(() => loadFlag(key))) ?? false;

  group('判据（纯函数）', () {
    test('人格还是种子模板、且 API 或通道没配好 → 弹', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: false, channelsReady: false),
        isTrue,
      );
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: true, channelsReady: false),
        isTrue,
        reason: 'API 配好了、通道还没开，也还是"没配完"',
      );
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: false, channelsReady: true),
        isTrue,
      );
    });

    test('人格已经写过了 → 不弹（老用户升级到这一版不会被补弹一次）', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: false, apiReady: false, channelsReady: false),
        isFalse,
      );
    });

    test('人格现状读不到 → 不弹（宁可漏弹，也不要拿猜的现状去挡人）', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: null, apiReady: false, channelsReady: false),
        isFalse,
      );
    });

    test('本地记着"走过一次" → 不弹（重启之后仍然管用）', () {
      expect(
        shouldShowOnboarding(askedBefore: true, identityIsSeed: true, apiReady: false, channelsReady: false),
        isFalse,
      );
    });

    test('全配齐了 → 不弹', () {
      expect(
        shouldShowOnboarding(askedBefore: false, identityIsSeed: true, apiReady: true, channelsReady: true),
        isFalse,
      );
    });
  });

  group('读现状', () {
    test('首次启动的机器：人格是种子、API 与通道都没配', () async {
      final signals = await readOnboardingSignals(state);
      expect(signals.identityIsSeed, isTrue);
      expect(signals.apiReady, isFalse);
      expect(signals.channelsReady, isFalse);
      expect(signals.model, 'deepseek-chat');
      expect(signals.baseUrl, 'https://api.deepseek.com');
      expect(signals.identityContent, seedIdentity, reason: '第四步要能接着这份模板改');
      expect(signals.mentionKeywords, isEmpty);
      expect(signals.herName, isNull,
          reason: '种子模板里「名字：（改成她的名字）」是占位符、示例句也不是她——认不出就是认不出');
    });

    test('配好的机器：人格已填写、密钥已配、通道开着 → 三项都就绪', () async {
      persona['IDENTITY.md'] = writtenIdentity;
      // 配好 = **每一条模型路由都有 key**（2026-10-20 改：从前只认 heavy 一格，
      // 于是一个只写进 heavy 的 key 就让这里报"就绪"，而设置页的 light 卡还写着「未配置」）
      keys['heavy'] = {'configured': true, 'mask': 'sk-…t3st'};
      keys['light'] = {'configured': true, 'mask': 'sk-…t3st'};
      (config['channels'] as Map<String, dynamic>)['qqOfficial'] = {'enabled': true};
      final signals = await readOnboardingSignals(state);
      expect(signals.identityIsSeed, isFalse);
      expect(signals.apiKeyGates, <String>['heavy', 'light']);
      expect(signals.apiKeyGatesConfigured, <String>['heavy', 'light']);
      expect(signals.apiReady, isTrue);
      expect(signals.channelsReady, isTrue);
      expect(signals.herName, '小七', reason: '老实例把名字写在散文里（"我是小七"），也要认得出来');
      expect(
        shouldShowOnboarding(
          askedBefore: false,
          identityIsSeed: signals.identityIsSeed,
          apiReady: signals.apiReady,
          channelsReady: signals.channelsReady,
        ),
        isFalse,
      );
    });

    test('只配了 heavy 的机器：不算"API 就绪"，缺的那一格要能看见', () async {
      // 老用户现场（引导页只写 heavy 那一格的年代）——这一条钉住"半个 key 不能叫配好"
      keys['heavy'] = {'configured': true, 'mask': 'sk-…t3st'};
      keys['light'] = {'configured': false, 'mask': null};
      final signals = await readOnboardingSignals(state);
      expect(signals.apiKeyConfigured, isFalse);
      expect(signals.apiReady, isFalse, reason: '设置页那张 light 卡写着「未配置」，这里不能说就绪');
      expect(signals.apiKeyGatesConfigured, <String>['heavy']);
      expect(signals.apiKeyGates, <String>['heavy', 'light'], reason: '格名单照服务端的 KEY_NAMES 来');
    });

    test('名字行说了算：有「名字：」那一行时不去正文里猜', () async {
      persona['IDENTITY.md'] = '# 我是谁\n\n名字：小七（Xiaoqi）\n\n我是伊尔弥亚。\n';
      final signals = await readOnboardingSignals(state);
      expect(signals.herName, '小七', reason: '括号里的是注解；正文里那个旧名字不作数');
    });

    test('人格条目读不到 → identityIsSeed 是 null（判据据此不弹）', () async {
      persona.remove('IDENTITY.md');
      final signals = await readOnboardingSignals(state);
      expect(signals.identityIsSeed, isNull);
      expect(signals.herName, isNull, reason: '读不到正文就没名字可认——界面回退成产品名，不猜');
    });
  });

  group('六步走完', () {
    testWidgets('首次启动：六步各写对各条通道，并落盘"不再弹"', (tester) async {
      useStateFile('onboarding-e2e');

      await pumpHost(tester);
      await expectCardShown(tester);

      // ── 第 1 步：她叫什么（名字 → 人格资产；唤醒词 → 通道配置） ──
      expect(find.text('她叫什么'), findsWidgets);
      expect(find.byType(TextField).evaluate().length, 2, reason: '第 1 步是名字 + 唤醒词两格');
      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      expect(
        (tester.widget<TextField>(find.byType(TextField).at(1))).controller!.text,
        '小七',
        reason: '填了名字，唤醒词框顺手跟着填一份（人没自己写过才同步）',
      );
      await tapPrimary(tester);

      // ① 名字进人格资产：IDENTITY.md 的「名字：」那一行（旧版本快照由服务端落）
      //    模板里已有那一行（占位符），所以是**换掉它**，不是另插一行
      expect(postFor('/api/commands/persona-edit')['body'], {
        'file': 'IDENTITY.md',
        'content': seedIdentity.replaceFirst('名字：（改成她的名字）', '名字：小七'),
      });
      expect(postFor('/api/commands/persona-edit')['confirm'], isNull,
          reason: 'persona-edit 在 CONFIRM_PHRASES 里是 null');
      // ② 唤醒词进通道配置：从名字派生的第一份默认值
      expect(postFor('/api/commands/set-mention-keywords')['body'], {
        'keywords': ['小七'],
      });
      expect(postFor('/api/commands/set-mention-keywords')['confirm'], isNull,
          reason: 'set-mention-keywords 在 CONFIRM_PHRASES 里是 null');
      // 界面上的称呼立刻跟手（宿主重读了人格资产，而不是把输入框里的字当结论）
      expect(state.herName, '小七', reason: '窗口标题 / 侧栏 / 托盘读的就是它');
      await pumpUntil(tester, find.text('API 配置').first);

      // ── 第 2 步：API 配置（模型名默认 deepseek-flash；端点没改 ⇒ 只有模型那一项要写） ──
      expect(find.text(keysRequiredNote), findsNothing, reason: '还没点继续，不该先报缺密钥');
      final fields = find.byType(TextField);
      expect(
        tester.widget<TextField>(fields.at(0)).controller!.text,
        kDefaultModelName,
        reason: '第一次进这一步，模型名预填 deepseek-flash（不空着，也不填后端出厂那个 deepseek-chat）',
      );
      await tester.enterText(fields.at(2), 'sk-test-key');
      await tester.pump();
      await tapPrimary(tester);

      expect(postFor('/api/commands/set-key')['body'], {
        'name': 'heavy',
        'value': 'sk-test-key',
        // 一把 key 要写到**每一档**：不带这一位的话，服务端只写 heavy 那一格，
        // 设置页按格看的 light 就永远写着「未配置」（2026-10-20 用户实测的挫败点）
        'modelRoutes': true,
      });
      expect(postFor('/api/commands/set-key')['confirm'], 'set-key');
      // 预填的就是这一格的值：盘上还是后端出厂默认（deepseek-chat）⇒ 点「继续」时写一次。
      // 2026-10-26 起这一屏只写 model / baseUrl：协议三档撤出引导页（那三档留在设置页），
      // 所以 `models.heavy.protocol` **不许**出现在这次提交里。
      expect(postFor('/api/commands/config-update')['body'], {
        'fields': {
          'models.heavy.model': kDefaultModelName,
          'models.heavy.baseUrl': 'https://api.deepseek.com',
        },
      });
      expect(postFor('/api/commands/config-update')['confirm'], 'config-update');

      // ── 第 3 步：消息适配器 ──
      await pumpUntil(tester, find.text('QQ 官方 Bot API'));
      await tester.tap(find.byType(Checkbox).first);
      await tester.pump();
      await tapPrimary(tester);

      expect(lastPostFor('/api/commands/config-update')['body'], {
        'fields': {'channels.qqOfficial.enabled': true},
      });
      expect(lastPostFor('/api/commands/config-update')['confirm'], 'config-update');

      // ── 第 4 步：人格（清掉模板，写一份真的） ──
      await pumpUntil(tester, find.text('人格').first);
      final personaField = find.byType(TextField).last;
      expect(
        (tester.widget<TextField>(personaField)).controller!.text,
        seedIdentity.replaceFirst('名字：（改成她的名字）', '名字：小七'),
        reason: '第一步写的名字行要跟着进第四步的框——不然在这里换一份正文就把名字冲掉了',
      );
      await tester.enterText(personaField, writtenIdentity);
      await tester.pump();
      await tapPrimary(tester); // 「继续」→ 最后一步

      expect(postsOf('/api/commands/persona-edit'), 2, reason: '第一步一次（名字）、第四步一次（正文）');
      expect(lastPostFor('/api/commands/persona-edit')['body'], {
        'file': 'IDENTITY.md',
        // 框里的首尾空白是手滑，不是人格的一部分；名字行由框架带上（见 her_name.dart）
        'content': '名字：小七\n${writtenIdentity.trim()}',
      });
      expect(lastPostFor('/api/commands/persona-edit')['confirm'], isNull,
          reason: 'persona-edit 在 CONFIRM_PHRASES 里是 null');

      // ── 第 5 步：信任范围（默认档 = 配置默认值，不动它就不写盘） ──
      await pumpUntil(tester, find.text('信任范围').first);
      expect(trustChoiceSelected(tester, kTrustFull), isTrue,
          reason: '默认高亮「完全信任」——与 src/config/config.ts 的默认值同一个字面量');
      expect(trustChoiceSelected(tester, kTrustWorkspace), isFalse);
      expect(find.text('她能读写整台电脑上的文件、也能在任意目录跑命令。'), findsOneWidget);
      expect(find.textContaining('她只能在'), findsOneWidget,
          reason: '两种选择各一句后果说明（只限工作目录那句要把路径念出来）');
      expect(postsOf('/api/commands/config-update'), 2,
          reason: '到这一步为止写过两次：第 2 步的模型名（默认 deepseek-flash）+ 第 3 步的通道开关');
      await tapPrimary(tester); // 「继续」→ 第 6 步（外部依赖）

      expect(postsOf('/api/commands/config-update'), 2,
          reason: '信任范围与盘上那份一致（都是默认的 full）→ 一个字节都不写');

      // ── 第 6 步：外部依赖（四件都已就位 ⇒ 不摆勾选框，一个 dep-install 都不发） ──
      await pumpUntil(tester, find.text(const ZhStrings().onboardingStepDepsTitle).first);
      expect(find.text(const ZhStrings().onboardingDepsAllReady), findsOneWidget,
          reason: '四件都就位时说清"直接点完成"，不摆一个按不动的勾选框');
      expect(find.byKey(const ValueKey('onboarding-deps-install')), findsNothing);
      await tapPrimary(tester); // 「完成」

      expect(postsOf('/api/commands/dep-install'), 0, reason: '都已就位 ⇒ 一次安装都不该发');
      expect(find.text(kOnboardingTitle), findsNothing, reason: '完成之后卡片应关掉');

      // 「不再弹」是落盘的，不是内存里记了一笔
      await drain(tester);
      expect(await flagOf(tester, kOnboardingDoneFlag), isTrue, reason: 'onboarding-done 要写进状态文件');
      final saved = jsonDecode(File(stateFilePath()).readAsStringSync()) as Map<String, dynamic>;
      expect(saved[kOnboardingDoneFlag], isTrue);

      // 再开一次宿主：现状其实还没配完（服务端那份配置是重启后接管的），但本地记着走过一次了
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await pumpHost(tester);
      await expectNoCard(tester);
      await closeOut(tester);
    });

    testWidgets('失败就留在原地：写不进去时卡片不关、原因写在卡上', (tester) async {
      useStateFile('onboarding-fail');
      await pumpHost(tester);
      await expectCardShown(tester);

      failCommands = true;
      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      await tapPrimary(tester);

      expect(find.textContaining('名字没写进去'), findsOneWidget, reason: '失败原因要写在卡上');
      expect(find.text(kOnboardingTitle), findsOneWidget, reason: '没写成就不该往下走');
      await closeOut(tester);
    });

    testWidgets('API 那一步：没密钥会提示（但不拦），照样能往下走', (tester) async {
      useStateFile('onboarding-key');
      await pumpHost(tester);
      await expectCardShown(tester);

      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步：跳过
      expect(find.text('API 配置'), findsWidgets);

      await tapPrimary(tester); // 第 2 步：空着点「继续」
      expect(find.text(keysRequiredNote), findsOneWidget, reason: '缺密钥要说清为什么这一次没写进去');
      expect(postsOf('/api/commands/set-key'), 0, reason: '没填就不该写一把空密钥');
      // 走到第 3 步了：提示是"这一步没写成"，不是"不许往下走"
      expect(find.text('QQ 官方 Bot API'), findsOneWidget, reason: '提示不等于把人锁在这一步');
      expect(find.text(keysRequiredNote), findsOneWidget, reason: '缺的东西仍摆在卡上，等人回头填');
      await closeOut(tester);
    });

    testWidgets('缺密钥不拦「以后再说」：缺的东西只摆在卡上，退出照旧', (tester) async {
      useStateFile('onboarding-key-later');
      await pumpHost(tester);
      await expectCardShown(tester);

      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步：跳过 → 第 2 步（API）
      await tapPrimary(tester); // 空着点「继续」→ 卡上报"还没填密钥"
      expect(find.text(keysRequiredNote), findsOneWidget);

      // 缺一样东西与"写失败"是两件事：前者不该把人锁在卡里
      await tapAndSettle(tester, find.text('以后再说'));
      expect(find.text(kOnboardingTitle), findsNothing, reason: '没填密钥也要能退出去');
      expect(await flagOf(tester, kOnboardingDoneFlag), isTrue);
      await closeOut(tester);
    });

    testWidgets('「以后再说」：填好的照样落盘，卡片关掉', (tester) async {
      useStateFile('onboarding-later');

      await pumpHost(tester);
      await expectCardShown(tester);
      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();

      // 卡头上的关闭键与「以后再说」是同一条路：结算当前这步，再退出
      await tapAndSettle(tester, find.byTooltip(kOnboardingCloseLabel));
      // 关闭 = 把还没结算的几步补写完：除了名字那两条，第 2 步的模型名也要落盘
      // （预填的 deepseek-flash 与盘上的出厂值不同），多一个真往返 ⇒ 再放几轮真实 I/O
      for (var i = 0; i < 12; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
        await tester.pump();
      }
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text(kOnboardingTitle), findsNothing);
      expect(postsOf('/api/commands/persona-edit'), 1, reason: '名字进人格资产');
      expect(postsOf('/api/commands/set-mention-keywords'), 1, reason: '唤醒词也跟着写');
      expect(
          postFor('/api/commands/set-mention-keywords')['body'],
          {
            'keywords': ['小七'],
          },
          reason: '人填过的东西不该因为"没点完成"丢掉');
      // 读状态文件之前先把这一趟还在飞的真 I/O（名字那条 POST、宿主那句 saveFlag 的写盘）跑完：
      // `flagOf` 自己也走 runAsync，两个真 I/O 挤在同一个窗口里会互相等——实测会把用例挂死
      // （flutter_test 的假时钟与真 I/O 交错，一条日志都不再打）。这是本文件既有的姿势：
      // 写完先 drain 再断言（见"四步走完"那条用例）。
      await drain(tester);
      expect(await flagOf(tester, kOnboardingDoneFlag), isTrue);
      await closeOut(tester);
    });

    testWidgets('上一步：回退时不写，回去改完再往前走才写', (tester) async {
      useStateFile('onboarding-back');
      await pumpHost(tester);
      await expectCardShown(tester);

      // 第 1 步不填，直接跳过 → 到第 2 步
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel));
      expect(postsOf('/api/commands/set-mention-keywords'), 0, reason: '跳过 = 一个字节都不写');
      expect(postsOf('/api/commands/persona-edit'), 0, reason: '名字那一步跳过了，人格资产一个字节都不碰');
      expect(find.byType(TextField).evaluate().length, 3, reason: '第 2 步是模型名 / Base URL / 密钥三格');

      // 回退到第 1 步：回退本身不该触发任何写
      await tapAndSettle(tester, find.text(kOnboardingBackLabel));
      expect(posts, isEmpty);
      expect(find.byType(TextField).evaluate().length, 2, reason: '退**一步**就到第 1 步（名字 + 唤醒词），不是一步跳回开头');
      expect(find.text('她叫什么'), findsWidgets);

      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      await tapPrimary(tester);
      expect(postsOf('/api/commands/persona-edit'), 1);
      expect(postsOf('/api/commands/set-mention-keywords'), 1);
      expect(find.byType(TextField).evaluate().length, 3, reason: '改完往前走一步，回到第 2 步');
      await closeOut(tester);
    });

    testWidgets('词表清空 = 只认 @：人自己的决定不会被"名字同步"又填回去', (tester) async {
      useStateFile('onboarding-name-only');
      // 现状里已经有一份词表（老实例的写法）：改名字不该顺手把它覆盖掉，
      // 人要清空它才是"只认 @"这个决定
      (config['channels'] as Map<String, dynamic>)['mentionKeywords'] = <String>['旧名'];
      await pumpHost(tester);
      await expectCardShown(tester);

      await tester.enterText(find.byType(TextField).first, '小七');
      await tester.pump();
      expect(
        (tester.widget<TextField>(find.byType(TextField).at(1))).controller!.text,
        '旧名',
        reason: '已经有词表 = 人做过的决定，名字不覆盖它',
      );

      await tester.enterText(find.byType(TextField).at(1), '');
      await tester.pump();
      await tapPrimary(tester);

      expect(postFor('/api/commands/persona-edit')['body'], {
        'file': 'IDENTITY.md',
        'content': seedIdentity.replaceFirst('名字：（改成她的名字）', '名字：小七'),
      });
      expect(postFor('/api/commands/set-mention-keywords')['body'], {
        'keywords': <String>[],
      }, reason: '清空是人写下的值，原样写进去（空 = 只认平台的 @）');
      await closeOut(tester);
    });

    testWidgets('信任范围那一步：默认高亮完全信任；改选工作目录才写 trust.mode', (tester) async {
      useStateFile('onboarding-trust');
      // 盘上那份就是配置默认值（服务端把 workspaceRoot 一起算出来给界面念）
      (config)['trust'] = {'mode': 'full', 'workspaceRoot': r'C:\path\to\config\workspace'};
      await pumpHost(tester);
      await expectCardShown(tester);

      // 前四步一路往前走（不填、不改）：这一条只看信任范围那一屏（第 5 步）。
      // 第 1~3 步走卡脚的「跳过这一步」（真的一个字都不写），第 4 步走主按钮
      // ——**不能一直按「跳过」**：它在最后一步上等价于「完成」，会把卡直接关掉。
      for (var i = 0; i < 3; i++) {
        await tapAndSettle(tester, find.text(kOnboardingSkipLabel));
      }
      await tapPrimary(tester); // 第 4 步（人格）不填 → 往前走一步到信任范围
      await pumpUntil(tester, find.text('信任范围').first);
      expect(posts, isEmpty, reason: '前四步什么都没填 = 一个字节都没写过');

      // ① **默认高亮「完全信任」**（与 src/config/config.ts 的 buildDefaults 同一个字面量）
      expect(trustChoiceSelected(tester, kTrustFull), isTrue);
      expect(trustChoiceSelected(tester, kTrustWorkspace), isFalse);
      // ② 两种选择各一句后果说明，且受限那档要把路径念出来
      expect(find.text('她能读写整台电脑上的文件、也能在任意目录跑命令。'), findsOneWidget);
      expect(
        find.text(r'她只能在 C:\path\to\config\workspace 里活动；越界的读写与命令会被拒绝。'),
        findsOneWidget,
      );

      // ③ 改选「只限工作目录」：走既有的 config-update 通道，带 X-Confirm
      await tester.tap(find.byKey(const ValueKey('trust-mode-workspace')));
      await tester.pump();
      expect(trustChoiceSelected(tester, kTrustWorkspace), isTrue, reason: '点哪一档就选哪一档');
      expect(trustChoiceSelected(tester, kTrustFull), isFalse);
      await tapPrimary(tester); // 「继续」→ 结算信任范围，走到第 6 步（外部依赖）

      expect(lastPostFor('/api/commands/config-update')['body'], {
        'fields': {'trust.mode': 'workspace'},
      });
      // 改 `trust.mode` 的 `X-Confirm` 必须**同时**含两个短语：命令短语（声明性）+
      // 字段短语 `trust-full-access`（服务端 DANGEROUS_FIELDS 真的在校验它，两个方向都要）。
      // 少了那半截，这一步会吃 400——引导走不到底，而人只会看到一句"信任范围没写进去"。
      expect(lastPostFor('/api/commands/config-update')['confirm'], kTrustConfirm);
      expect(lastPostFor('/api/commands/config-update')['confirm'], contains('trust-full-access'));

      // 第 6 步（外部依赖）：四件都已就位 ⇒ 不摆勾选框、一个 dep-install 都不发
      await pumpUntil(tester, find.text(const ZhStrings().onboardingStepDepsTitle).first);
      expect(find.text(const ZhStrings().onboardingDepsAllReady), findsOneWidget);
      await tapPrimary(tester); // 「完成」

      expect(postsOf('/api/commands/dep-install'), 0);
      expect(find.text(kOnboardingTitle), findsNothing, reason: '完成之后卡片应关掉');
      await closeOut(tester);
    });
  });

  group('强制弹出的判据（环境变量在测试进程里设不了，只钉纯函数）', () {
    test('配好的机器：常规判据说不弹，强制口子说弹；但"走过一次"连强制也拦下', () {
      const configured = (identityIsSeed: false, apiReady: true, channelsReady: true);
      expect(
        shouldShowOnboardingNow(
          askedBefore: false,
          identityIsSeed: configured.identityIsSeed,
          apiReady: configured.apiReady,
          channelsReady: configured.channelsReady,
          forceEnv: null,
        ),
        isFalse,
      );
      expect(
        shouldShowOnboardingNow(
          askedBefore: false,
          identityIsSeed: configured.identityIsSeed,
          apiReady: configured.apiReady,
          channelsReady: configured.channelsReady,
          forceEnv: '1',
        ),
        isTrue,
        reason: '设了 IRMIA_GUI_FORCE_ONBOARDING=1 就能在配好的机器上看这张卡',
      );
      expect(
        shouldShowOnboardingNow(
          askedBefore: true,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
          forceEnv: '1',
        ),
        isFalse,
        reason: '人点过「以后再说」之后，连强制也不该再把卡拍在他脸上',
      );
    });

    testWidgets('配好的机器：宿主不会弹', (tester) async {
      persona['IDENTITY.md'] = writtenIdentity;
      keys['heavy'] = {'configured': true, 'mask': 'sk-…t3st'};
      (config['channels'] as Map<String, dynamic>)['qqOfficial'] = {'enabled': true};
      useStateFile('onboarding-force');

      await pumpHost(tester);
      await expectNoCard(tester);
      await closeOut(tester);
    });
  });

  /// 用户 2026-10-18 提的四条（第 2/3/4 步）。
  ///
  /// ① 第 2 步模型名默认 `deepseek-flash`；
  /// ② 第 2 步那段"密钥只写不读…"的解释删掉，换成推荐语 + 两个蓝链（点了开浏览器）；
  /// ③ 第 3 步一句推荐 + 蓝链到 QQ 开放平台，并且**首次就能填** AppID / AppSecret
  ///    （落盘走「消息适配器」页同一条 set-key）；
  /// ④ 第 4 步那段长解释压成两三句，字数要有上界。
  group('2026-10-18 用户的四条意见（第 2/3/4 步）', () {
    test('① 模型名的默认值：出厂默认与空值都给 deepseek-flash，人选过的原样回填', () {
      expect(kDefaultModelName, 'deepseek-flash');
      expect(initialOnboardingModel(''), kDefaultModelName);
      expect(
        initialOnboardingModel('deepseek-chat'),
        kDefaultModelName,
        reason: '后端出厂值 deepseek-chat = 没人选过模型，这一格要显示推荐值',
      );
      expect(initialOnboardingModel('deepseek-flash'), kDefaultModelName);
      expect(
        initialOnboardingModel('my-own-model'),
        'my-own-model',
        reason: '人自己选过的模型不许被推荐值盖掉',
      );
    });

    testWidgets('① 第 2 步一进来，模型名那格预填的就是 deepseek-flash', (tester) async {
      // 假服务的模型名是后端出厂值 deepseek-chat（= 没人选过），正是"首次进入"的形状
      useStateFile('onboarding-model-default');
      await pumpHost(tester);
      await expectCardShown(tester);

      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步：跳过 → 第 2 步
      await pumpUntil(tester, find.byType(TextField));
      final model = tester.widget<TextField>(find.byType(TextField).first);
      expect(model.controller!.text, kDefaultModelName);
      expect(
        model.controller!.text,
        'deepseek-flash',
        reason: '用户 ①：首次进入时这一格预填的就是它，别空着、别填别的',
      );
      await closeOut(tester);
    });

    testWidgets('② 第 2 步两个蓝链：点了会发起打开，地址逐字对得上', (tester) async {
      useStateFile('onboarding-links');
      await pumpHost(tester);
      await expectCardShown(tester);
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步：跳过 → 第 2 步

      // 用户 ②：那段"密钥只写不读…"的解释删掉了
      expect(find.textContaining('密钥只写不读'), findsNothing);
      expect(find.textContaining('轻量那条 lane'), findsNothing);

      final modelLink = find.byKey(const ValueKey('onboarding-link-deepseek-model'));
      final signupLink = find.byKey(const ValueKey('onboarding-link-deepseek-signup'));
      await pumpUntil(tester, modelLink);
      expect(signupLink, findsOneWidget, reason: '两段话里各有一颗蓝链');
      expect(find.text(const ZhStrings().onboardingApiRecommendLead), findsOneWidget);
      expect(find.text(const ZhStrings().onboardingApiRecommendModel), findsOneWidget);
      expect(find.text(const ZhStrings().onboardingApiRegisterKey), findsOneWidget);

      await tester.ensureVisible(modelLink);
      await tester.pump();
      await tester.tap(modelLink);
      await tester.pump();
      await tester.ensureVisible(signupLink);
      await tester.pump();
      await tester.tap(signupLink);
      await tester.pump();

      expect(
        openedUrls,
        <String>[kDeepSeekPlatformUrl, kDeepSeekSignupUrl],
        reason: '点了哪颗就打开哪个地址（用可注入的 opener 断言，不真起浏览器）',
      );
      expect(kDeepSeekPlatformUrl, 'https://platform.deepseek.com/');
      expect(kDeepSeekSignupUrl, 'https://platform.deepseek.com/sign_up');
      await closeOut(tester);
    });

    testWidgets('③ 第 3 步推荐语里那颗蓝链指向 QQ 开放平台', (tester) async {
      useStateFile('onboarding-qq-link');
      await pumpHost(tester);
      await expectCardShown(tester);
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 2 步 → 第 3 步

      final link = find.byKey(const ValueKey('onboarding-link-qq-open-platform'));
      await pumpUntil(tester, link);
      expect(find.text(const ZhStrings().onboardingChannelRecommendQq), findsOneWidget);
      await tester.ensureVisible(link);
      await tester.pump();
      await tester.tap(link);
      await tester.pump();
      expect(openedUrls, <String>[kQqOpenPlatformUrl]);
      expect(kQqOpenPlatformUrl, 'https://q.qq.com/');
      await closeOut(tester);
    });

    testWidgets('③ 第 3 步就地填 AppID / AppSecret：提交走「消息适配器」同一条 set-key', (tester) async {
      useStateFile('onboarding-qq-credentials');
      await pumpHost(tester);
      await expectCardShown(tester);
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 2 步 → 第 3 步

      await chooseManualCredentials(tester); // 两个入口：这条验的是「填写凭据」那条
      final appId = find.byKey(const ValueKey('onboarding-qq-appid'));
      final appSecret = find.byKey(const ValueKey('onboarding-qq-appsecret'));
      await pumpUntil(tester, appId);
      expect(appSecret, findsOneWidget, reason: '用户 ④：两把凭据首次就在这一页填');
      // 两格都是密钥框（掩码）
      expect(tester.widget<TextField>(appId).obscureText, isTrue);
      expect(tester.widget<TextField>(appSecret).obscureText, isTrue);

      await tester.enterText(appId, '10240001');
      await tester.pump();
      expect(
        tester.widget<Checkbox>(find.byType(Checkbox).first).value,
        isFalse,
        reason: '只填了一把还不算填完（两把齐备才自动勾上）',
      );
      await tester.enterText(appSecret, 's3cr3t-value');
      await tester.pump();
      expect(
        tester.widget<Checkbox>(find.byType(Checkbox).first).value,
        isTrue,
        reason: '两把都填了 ⇒ 自动勾上 QQ 官方 Bot（填完还要人再勾一下，那一步谁都漏）',
      );

      await tapPrimary(tester); // 继续 → 第 4 步（这一步结算时落盘）

      // 落盘走的是「消息适配器」页那同一条 set-key、同一对键名（这里是逐字断言，
      // 与 channels_page 的 _qqSecrets 是同一个来源：channel_keys.dart）
      expect(kQqAppIdKey, 'qqAppId');
      expect(kQqAppSecretKey, 'qqClientSecret');
      final setKeys = posts.where((entry) => entry['path'] == '/api/commands/set-key').toList();
      expect(setKeys, hasLength(2), reason: '两把凭据各写一条，走的是 set-key 不是 config-update');
      expect(setKeys[0]['body'], {'name': 'qqAppId', 'value': '10240001'});
      expect(setKeys[1]['body'], {'name': 'qqClientSecret', 'value': 's3cr3t-value'});
      for (final entry in setKeys) {
        expect(entry['confirm'], 'set-key', reason: '与设置页同一条命令、同一个确认短语');
      }
      expect(lastPostFor('/api/commands/config-update')['body'], {
        'fields': {'channels.qqOfficial.enabled': true},
      }, reason: '开关也一并写进去（填完凭据就自动勾上了）');
      await closeOut(tester);
    });

    testWidgets('③ 已经配置过的凭据不回显：框是空的，只摆服务端给的掩码', (tester) async {
      keys[kQqAppIdKey] = {'configured': true, 'mask': 'qq1…9f3c'};
      useStateFile('onboarding-qq-masked');
      await pumpHost(tester);
      await expectCardShown(tester);
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 2 步 → 第 3 步

      await chooseManualCredentials(tester); // 已配置的掩码摆在「填写凭据」那一支
      final appId = find.byKey(const ValueKey('onboarding-qq-appid'));
      await pumpUntil(tester, appId);
      expect(
        tester.widget<TextField>(appId).controller!.text,
        isEmpty,
        reason: '密钥只写不读：已有的值一个字节都不回显',
      );
      expect(find.text(const ZhStrings().onboardingSecretConfigured('qq1…9f3c')), findsOneWidget);
      // 没配过的那把：占位提示是"它是干什么的"
      expect(find.text(const ZhStrings().onboardingQqAppSecretHint), findsOneWidget);
      await closeOut(tester);
    });

    test('④ 第 4 步的说明压成三句：字数有上界（原来 173 字）', () {
      const beforeChars = 173;
      final after = const ZhStrings().onboardingPersonaHint;
      expect(after.length, lessThanOrEqualTo(88), reason: '现在 80 字：上界钉 88，谁再加回来会红');
      expect(after.length, lessThan(beforeChars), reason: '比原来短');
      expect(
        after.length * 2,
        lessThan(beforeChars),
        reason: '用户要的是"精简"：不到原来的一半才算明显变少',
      );
      // 四条关键信息一条都不许丢（压的是措辞，不是事实）
      expect(after, contains('替换整份文件'));
      expect(after, contains('快照'), reason: '服务端留旧版快照、可回滚');
      expect(after, contains('留空或没改动就不写'));
      expect(after, contains('「名字：」'), reason: '第一步那行名字别删');
      // 英文那份同样不许比中文长太多（en 没有 CJK，长度按字符算）
      final en = const EnStrings().onboardingPersonaHint;
      expect(en.trim(), isNotEmpty);
      expect(RegExp(r'[\u4e00-\u9fff]').hasMatch(en.replaceAll('名字：', '')), isFalse,
          reason: '英文那份里除了 IDENTITY.md 那行标记，不该有别的汉字');
    });
  });

  // ────────────────────────── 密钥写给哪几格（2026-10-20） ──────────────────────────
  //
  // 用户实测的挫败点（原话）：「新用户通过引导页填写了 key，但是实际上 key 只给了 heavy loop，
  // 而没给 light loop。导致用户设置完并不能一下子把 bot 跑起来……默认填了这里就会同时给两个吧」。
  //
  // 根因：引导页保存时**硬编码** `{'name': 'heavy'}`（服务端密钥文件是按格存的：heavy / light），
  // 而设置页的"配没配"是按格读的 ⇒ 填过 key 的机器上，light 那张卡照旧写着「未配置」。
  //
  // 这一组四条，正反各两条：
  //   ① 新用户走引导 ⇒ 两格都在，回执说清写到了哪几格；
  //   ② 一把 key + 同一处 apiKeyEnv ⇒ **只发一次、只写一份**（没有重复条目）；
  //   ③ 老用户只配过 heavy ⇒ 提示说清"只差 light"，再填一次补齐；
  //   ④ 写失败 ⇒ 回执点名哪几格 + 原因，别只说"已配置"。
  group('密钥写到了哪几格（heavy / light 都拿到）', () {
    /// 走到第 2 步（跳过第 1 步）
    Future<void> toApiStep(WidgetTester tester) async {
      await pumpHost(tester);
      await expectCardShown(tester);
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel)); // 第 1 步
      await pumpUntil(tester, find.text('API 配置').first);
    }

    /// 第 2 步的密钥框（第 0/1 格是模型名与 Base URL）
    Finder keyField() => find.byType(TextField).at(2);

    testWidgets('① 新用户填一次 key ⇒ heavy 与 light 两格都拿到，回执念出格名', (tester) async {
      useStateFile('onboarding-key-fanout');
      await toApiStep(tester);

      await tester.enterText(keyField(), 'sk-brand-new-key');
      await tester.pump();
      await tapPrimary(tester); // 结算：写密钥 → 进第 3 步

      // 一次请求就够（人只填了一把 key）；带上 modelRoutes 让服务端写到每一条有格的模型路由
      expect(postsOf('/api/commands/set-key'), 1, reason: '同一个 key 只问一次、只发一次');
      expect(postFor('/api/commands/set-key')['body'], {
        'name': 'heavy',
        'value': 'sk-brand-new-key',
        'modelRoutes': true,
      });
      expect(postFor('/api/commands/set-key')['confirm'], 'set-key');

      // 键存储里**两格都在**（假服务照真服务端的扇出规则写：heavy / light 各一格）
      expect(keys['heavy']?['configured'], isTrue);
      expect(keys['light']?['configured'], isTrue, reason: '这一条正是从前的缺口：light 一格都没写');

      // 回执说清写到了哪几格（不是含糊的"已配置"）
      final receipt = const ZhStrings().onboardingApiKeyWritten('heavy / light');
      expect(find.text(receipt), findsOneWidget, reason: '回执要念出格名，且写完之后一直挂在卡上');
      expect(receipt, contains('heavy'));
      expect(receipt, contains('light'));

      // 再回到第 2 步：占位提示也换成了"写到了哪几格"（不再是"已配置"那种含糊话）
      await tapAndSettle(tester, find.text(kOnboardingBackLabel));
      await pumpUntil(tester, find.text('API 配置').first);
      expect(find.text(const ZhStrings().onboardingApiKeyHintWritten('heavy / light')), findsOneWidget);
      expect(find.text('已配置；粘贴新密钥可覆盖'), findsNothing, reason: '那句含糊话该退场了');
      await closeOut(tester);
    });

    testWidgets('② 一把 key + 同一处 apiKeyEnv ⇒ 写成一份：一次请求、两格同值、没有重复条目', (tester) async {
      useStateFile('onboarding-key-dedup');
      await toApiStep(tester);

      await tester.enterText(keyField(), 'sk-one-and-only');
      await tester.pump();
      await tapPrimary(tester);

      // "只问一次 / 写一份"的两个可观测面：
      //   · 请求只有一条（不是逐格各发一条）——密钥只过网一次；
      //   · 回执里的 gates 恰好是两条路由各一格，没有第三格、没有重复格名。
      expect(postsOf('/api/commands/set-key'), 1);
      final gates = (keys.keys.toList()..sort());
      expect(gates, <String>['heavy', 'light'], reason: '只有两条模型路由各一格，没有多余/重复条目');
      expect(keys['heavy']?['mask'], keys['light']?['mask'], reason: '同一把 key：两格拿到的掩码一致');

      // 重复保存不报错、不新增条目（幂等）
      await tapAndSettle(tester, find.text(kOnboardingBackLabel));
      await pumpUntil(tester, find.text('API 配置').first);
      await tester.enterText(keyField(), 'sk-one-and-only');
      await tester.pump();
      await tapPrimary(tester);
      expect(postsOf('/api/commands/set-key'), 2, reason: '人又点了一次继续 ⇒ 再写一次，但盘上仍是那两格');
      expect(keys.keys.toList()..sort(), <String>['heavy', 'light']);
      await closeOut(tester);
    });

    testWidgets('③ 老用户只配过 heavy ⇒ 提示说清只差 light；再填一次两格齐', (tester) async {
      keys['heavy'] = {'configured': true, 'mask': 'sk-…0ld1'};
      keys['light'] = {'configured': false, 'mask': null};
      useStateFile('onboarding-key-legacy');
      await toApiStep(tester);

      // 占位提示如实说"只有 heavy 有"（老用户一眼看出差哪一格，而不是被当成全都没配）
      expect(
        find.text(const ZhStrings().onboardingApiKeyHintPartial('heavy', 'light')),
        findsOneWidget,
      );

      // 什么都不填就点继续：卡上提醒"只差 light"，并且**不写**任何东西
      await tapPrimary(tester);
      expect(postsOf('/api/commands/set-key'), 0, reason: '没填就不该写');
      expect(
        find.text(const ZhStrings().onboardingApiKeyHintPartial('heavy', 'light')),
        findsOneWidget,
        reason: '缺的那一格要留在卡上，等人回头补',
      );

      // 退回第 2 步填一把 ⇒ 补齐（老用户不用改别的，两格都拿到）
      await tapAndSettle(tester, find.text(kOnboardingBackLabel));
      await pumpUntil(tester, find.text('API 配置').first);
      await tester.enterText(keyField(), 'sk-fill-both');
      await tester.pump();
      await tapPrimary(tester);
      expect(keys['heavy']?['configured'], isTrue);
      expect(keys['light']?['configured'], isTrue, reason: '补齐之后 light 也可用');
      await closeOut(tester);
    });

    testWidgets('④ 写入失败 ⇒ 回执点名哪几格 + 原因，不再只说"已配置"', (tester) async {
      // 模型名与端点都摆成"盘上就是这个值"，让这一步只剩密钥一条写入：
      // 否则先失败的会是 config-update，测出来的就不是密钥那条回执。
      (config['models']['heavy'] as Map<String, dynamic>)['model'] = kDefaultModelName;
      useStateFile('onboarding-key-fail');
      await toApiStep(tester);

      failCommands = true;
      await tester.enterText(keyField(), 'sk-will-fail');
      await tester.pump();
      await tapPrimary(tester);
      failCommands = false;

      // 只有密钥那一条请求（模型没改），并且它失败了
      expect(postsOf('/api/commands/set-key'), 1);
      expect(postsOf('/api/commands/config-update'), 0, reason: '这一步只剩密钥要写');

      // 失败原因里必须点出**本该写的格**（heavy / light），并带上现场那句话
      final expected = const ZhStrings().onboardingApiKeySaveFailed('heavy / light', '测试里故意失败');
      expect(find.text(expected), findsOneWidget, reason: '卡上要把"哪几格没写成"念出来');
      expect(expected, contains('heavy / light'));
      expect(find.text(kOnboardingTitle), findsOneWidget, reason: '没写成就不该往下走');
      await closeOut(tester);
    });
  });

  /// 等"关掉卡之后那次 saveFlag"真的落盘（真 IO + 假时钟，必须交替推进）。
  ///
  /// 这里**不能**直接 `await loadFlag(...)`：`loadFlag` 先 await 写入队列，而那条队列是在
  /// fake-async 区里排的——在 `runAsync` 里 await 它就没人去推假时钟，用例会挂死
  /// （实测：本组②就是这么卡住的）。所以改成"轮询盘上那份文件"：每一轮先放真 IO，
  /// 再 pump 假时钟，直到目标键出现。
  Future<Map<String, dynamic>> waitForStateFile(
    WidgetTester tester, {
    required String key,
    required Object value,
    int rounds = 40,
  }) async {
    var saved = <String, dynamic>{};
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
      final file = File(stateFilePath());
      if (!file.existsSync()) continue;
      try {
        final decoded = jsonDecode(file.readAsStringSync());
        if (decoded is Map<String, dynamic>) saved = decoded;
      } catch (_) {
        continue; // 还没写完（或被重建到一半）：下一轮再看
      }
      if (saved[key] == value) return saved;
    }
    return saved;
  }

  /// 三态判据（2026-10-21 用户补的第四档）：**"没有记录" = 弹，"记录坏了" = 不弹**。
  ///
  ///   · 文件不在 / 键不在 ⇒ false ⇒ **自动通道会弹**（真·首次安装就是这一档）；
  ///   · 文件在且是布尔 ⇒ 原样；
  ///   · JSON 坏 / 读不动 ⇒ null（未知）⇒ **不弹**——记录坏了不等于"从没问过"，
  ///     这是"防误弹"的本意；此时首页「配置引导」那条手动通道照样能开，
  ///     卡头会挂「手动打开 · 不计入首次判据」，人不会误以为"它又自己弹了"。
  group('三态判据：没有记录 ⇒ 会弹；记录坏了 ⇒ 不弹', () {
    test('纯函数：false（没有记录）⇒ 弹；true ⇒ 不弹；null（记录坏了）⇒ 不弹', () {
      expect(
        shouldShowOnboarding(
          askedBefore: false,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
        ),
        isTrue,
        reason: '"没有记录"（文件不在 / 键不在）就是没问过：真·首次安装必须弹',
      );
      expect(
        shouldShowOnboarding(
          askedBefore: true,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
        ),
        isFalse,
      );
      expect(
        shouldShowOnboarding(
          askedBefore: null,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
        ),
        isFalse,
        reason: '记录坏了 = 未知：与 identityIsSeed 读不到同一条口径（宁可不弹）',
      );
      expect(
        shouldShowOnboardingNow(
          askedBefore: null,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
          forceEnv: null,
        ),
        isFalse,
      );
      expect(
        shouldShowOnboardingNow(
          askedBefore: null,
          identityIsSeed: true,
          apiReady: false,
          channelsReady: false,
          forceEnv: '1',
        ),
        isTrue,
        reason: '排障口子只放宽判据："未知"不是"走过一次"，强制那条路仍能开',
      );
    });

    testWidgets('① 文件不在（没有记录）⇒ 自动弹（真·首次安装的形状）；不挂「手动打开」标识', (tester) async {
      useStateFile('onboarding-missing'); // 删掉就走：文件不在 = 没有记录 = 没问过

      await pumpHost(tester);
      await expectCardShown(tester);
      expect(find.text(const ZhStrings().onboardingManualOpenBadge), findsNothing,
          reason: '这是首次那条路（自动弹出），不挂"手动打开"标识');
      expect(find.text(const EnStrings().onboardingManualOpenBadge), findsNothing);
      expect(find.byIcon(Icons.touch_app_rounded), findsNothing);
      expect(File(stateFilePath()).existsSync(), isFalse, reason: '关掉之前不写"问过了"');

      await tester.tap(find.byTooltip(kOnboardingCloseLabel));
      await closeOut(tester);
      final saved = await waitForStateFile(tester, key: kOnboardingDoneFlag, value: true);
      expect(saved[kOnboardingDoneFlag], isTrue, reason: '关掉之后才记"问过了"');
    });

    testWidgets('② 文件在、onboarding-done 键不在 ⇒ false ⇒ 照样自动弹', (tester) async {
      useStateFile('onboarding-key-missing');
      File(stateFilePath()).writeAsStringSync(jsonEncode({'mention-prompt-done': true}));

      await pumpHost(tester);
      await expectCardShown(tester);
      expect(find.text(const ZhStrings().onboardingManualOpenBadge), findsNothing);

      await tester.tap(find.byTooltip(kOnboardingCloseLabel));
      await closeOut(tester);
      final saved = await waitForStateFile(tester, key: kOnboardingDoneFlag, value: true);
      expect(saved[kOnboardingDoneFlag], isTrue);
      expect(saved['mention-prompt-done'], isTrue, reason: '改写要把别人的键留着');
    });

    testWidgets('③ JSON 坏了（记录坏了）⇒ 不自动弹；手动通道照开且挂标识', (tester) async {
      useStateFile('onboarding-broken');
      File(stateFilePath()).writeAsStringSync('{ 这不是 json');

      await pumpHost(tester);
      await expectNoCard(tester);
      expect(File(stateFilePath()).readAsStringSync(), '{ 这不是 json',
          reason: '自动那条路不写盘：坏文件也不会被顺手改成别的');

      // 手动通道是显式动作：判据说不弹也照开
      requestOnboarding();
      await expectCardShown(tester);
      expect(
        find.text(const ZhStrings().onboardingManualOpenBadge),
        findsOneWidget,
        reason: '手动打开要在卡头写清"手动打开 · 不计入首次判据"',
      );
      expect(find.text(const EnStrings().onboardingManualOpenBadge), findsNothing,
          reason: '当前语言是中文，英文那条不该同时出现');

      await tester.tap(find.byTooltip(kOnboardingCloseLabel));
      await closeOut(tester);
      expect(File(stateFilePath()).readAsStringSync(), '{ 这不是 json',
          reason: '手动打开不许补写 onboarding-done');
    });
  });
}
