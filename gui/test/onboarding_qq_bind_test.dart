/*
 * 首次启动引导 · 第 3 步「消息适配器」——**扫码创建 QQ 官方 Bot**（2026-10-23）。
 *
 * 用户原话：「在首次启动引导、消息适配器那页，要可选扫码创建或者填凭据创建。然后 onebot
 * 那里写"配置完成后可自行另行设置"即可。」这份用例钉的就是这句话落成界面之后的样子：
 *
 *   ① **两个并列入口都在**：「扫码创建（推荐）」与「填写凭据」；默认是扫码；
 *   ② 点「扫码创建」→ 打 `POST /api/channels/qq-official/bind/start`，然后**只**把返回的
 *      URL 交给系统浏览器（`externalUrlOpener` 的替身），页面摆出"请在浏览器里用手机 QQ 扫码"；
 *   ③ 轮询到成功 ⇒「绑定成功」+ AppID（AppSecret 只显示"已保存"，不回显）；
 *   ④ 过期 ⇒「二维码过期了，重新生成」，再点一次会重新 start；
 *   ⑤ 「填写凭据」那条照旧：两格 + 一颗「测试连接」（走 `qq-token-test`）；
 *   ⑥ **不会自动打开浏览器以外的东西**：整份用例里唯一的外部动作就是那个 URL。
 *
 * 假服务只回答这份用例要用的几条端点（形状照 `src/web/server.ts` 的真实回包抄）；
 * 扫码的协议与落盘在 Node 侧用例里逐条钉（`test/qq-bind*.test.ts`），这里验的是界面接线。
 */

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/external_link.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/onboarding.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

void main() {
  late HttpServer server;
  late AppState state;

  /// `GET /api/config` 的回包（只要第 3 步用得到的那几格）
  late Map<String, dynamic> config;

  /// `GET /api/keys` 的回包
  late Map<String, dynamic> keys;

  /// 扫码端点被调了几次、请求体是什么
  late List<Map<String, dynamic>> bindStarts;

  /// `GET .../bind/status` 依次回答什么（用完之后一直重复最后一个）
  late List<Map<String, dynamic>> bindStatuses;

  /// 这一组用例里 status 被问了几次（决定回脚本里的哪一条）
  late int statusCalls;

  /// 系统浏览器收到的地址（[externalUrlOpener] 的替身记在这里）
  late List<String> openedUrls;

  /// 所有 `POST /api/commands/*` 的流水（验「测试连接」走的是哪条端点）
  late List<Map<String, dynamic>> posts;

  /// 人格种子（判据靠 `isSeed`：种子还在 + 通道没配 ⇒ 引导卡会弹）
  late Map<String, String> persona;

  const taskId = 'T1';
  const bindUrl =
      'https://q.qq.com/qqbot/openclaw/connect.html?task_id=T1&source=irmia&_wv=2';

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，本组要打真实 loopback
    HttpOverrides.global = null;
    bindStarts = [];
    bindStatuses = [
      {'status': 'pending'},
    ];
    statusCalls = 0;
    openedUrls = [];
    posts = [];
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
    persona = {
      'IDENTITY.md': '<!-- SEED 填写后删除本行 -->\n# 我是谁\n\n名字：（改成她的名字）\n',
      'CONSTITUTION.md': '<!-- SEED -->\n# 行为宪法\n',
    };

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/api/channels/qq-official/bind/start') {
        bindStarts.add({'body': jsonDecode(await utf8.decoder.bind(req).join())});
        response.write(jsonEncode({'ok': true, 'taskId': taskId, 'url': bindUrl}));
      } else if (path == '/api/channels/qq-official/bind/status') {
        final index = statusCalls.clamp(0, bindStatuses.length - 1);
        statusCalls += 1;
        response.write(jsonEncode({'ok': true, ...bindStatuses[index]}));
      } else if (path.startsWith('/api/commands/')) {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        posts.add({
          'path': path,
          'body': body,
          'confirm': req.headers.value('X-Confirm'),
        });
        if (path == '/api/commands/qq-token-test') {
          response.write(jsonEncode({'ok': true, 'expiresIn': 7200}));
        } else {
          response.write(jsonEncode({'ok': true}));
        }
      } else if (path == '/api/config') {
        response.write(jsonEncode(config));
      } else if (path == '/api/keys') {
        response.write(jsonEncode(keys));
      } else if (path == '/api/persona/files') {
        response.write(jsonEncode({
          'root': '/tmp/persona',
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
        response.write(jsonEncode({
          'available': true,
          'dataDir': '/tmp/data',
          'toolsDir': '/tmp/data/tools',
          'needsAttention': false,
          'generatedAt': '2026-10-23T00:00:00.000Z',
          'entries': <Object>[],
        }));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': 'not found'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    externalUrlOpener = openUrlInSystemBrowser; // 替身还回去，别漏给后面的用例
    state.dispose();
    await server.close(force: true);
  });

  void useStateFile(String name) {
    final path = '${Directory.systemTemp.path}${Platform.pathSeparator}'
        'irmia-ui-state-$name-$pid.json';
    stateFileOverride = path;
    final file = File(path);
    if (file.existsSync()) file.deleteSync();
  }

  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 80}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  Future<void> tapAndSettle(WidgetTester tester, Finder target) async {
    final inCard = find.descendant(of: find.byType(Dialog), matching: target);
    await pumpUntil(tester, inCard);
    await tester.tap(inCard);
    await tester.pump();
    for (var i = 0; i < 8; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
  }

  /// 把卡片推进到第 3 步（消息适配器）：前两步都「跳过这一步」
  Future<void> goToChannelStep(WidgetTester tester) async {
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
    for (var round = 0; round < 60; round++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      if (find.text(kOnboardingTitle).evaluate().isNotEmpty) break;
    }
    expect(find.text(kOnboardingTitle), findsOneWidget, reason: '引导卡应当自动弹出来');
    for (var i = 0; i < 2; i++) {
      await tapAndSettle(tester, find.text(kOnboardingSkipLabel));
    }
    await pumpUntil(tester, find.text('QQ 官方 Bot API'));
  }

  /// 点一颗按钮并让那次真实 HTTP 跑完（扫码 start / 测试连接都是真的请求）
  Future<void> tapButton(WidgetTester tester, String key) async {
    final target = find.byKey(ValueKey(key));
    await pumpUntil(tester, target);
    await tester.tap(target);
    await tester.pump();
    for (var i = 0; i < 20; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
  }

  /// 推过 2 秒（= 界面那一拍轮询）并把那次真实请求跑完
  Future<void> tickPoll(WidgetTester tester) async {
    await tester.pump(const Duration(seconds: 2));
    for (var i = 0; i < 25; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 15)));
      await tester.pump();
    }
  }

  /// 收尾：拆树（dispose 会停掉轮询定时器），再 flush 一次
  Future<void> closeOut(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox.shrink());
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.pump(const Duration(seconds: 2));
  }

  const zh = ZhStrings();

  testWidgets('第 3 步两个并列入口都在：默认扫码，填凭据那两格收在第二个入口里', (tester) async {
    useStateFile('qq-bind-entries');
    await goToChannelStep(tester);

    expect(find.text(zh.onboardingQqEntryScan), findsOneWidget, reason: '入口一：扫码创建（推荐）');
    expect(find.text(zh.onboardingQqEntryManual), findsOneWidget, reason: '入口二：填写凭据');
    expect(find.byKey(const ValueKey('onboarding-qq-bind-start')), findsOneWidget,
        reason: '默认落在扫码入口（推荐那条）');
    expect(find.byKey(const ValueKey('onboarding-qq-appid')), findsNothing,
        reason: '两个入口是二选一：扫码那一支不摆凭据表单');
    // OneBot 那一块只有这一句（用户原话）
    expect(find.text(zh.onboardingOnebotDetail), findsOneWidget);
    expect(zh.onboardingOnebotDetail, '配置完成后可自行另行设置。');

    await tapAndSettle(tester, find.text(zh.onboardingQqEntryManual));
    expect(find.byKey(const ValueKey('onboarding-qq-appid')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-qq-appsecret')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-qq-token-test')), findsOneWidget,
        reason: '「填写凭据」旁边那颗「测试连接」');
    expect(find.byKey(const ValueKey('onboarding-qq-bind-start')), findsNothing,
        reason: '切到填凭据之后扫码面板收起来');
    await closeOut(tester);
  });

  testWidgets('点扫码：调用 start、只打开那一个二维码地址，页面摆出"请用手机 QQ 扫码"', (tester) async {
    useStateFile('qq-bind-start');
    await goToChannelStep(tester);

    await tapButton(tester, 'onboarding-qq-bind-start');

    expect(bindStarts, hasLength(1), reason: '点一下 = 一次 start');
    expect(bindStarts.single['body'], <String, dynamic>{}, reason: 'start 不需要参数');
    expect(openedUrls, <String>[bindUrl], reason: '把后端给的二维码地址交给系统浏览器（且只开这一个）');
    final openUri = Uri.parse(openedUrls.single);
    expect(openUri.host, 'q.qq.com', reason: '官方的二维码页：页面自己渲染二维码');
    expect(openUri.queryParameters['task_id'], taskId);
    expect(openUri.queryParameters['source'], 'irmia');
    expect(find.text(zh.onboardingQqBindWaitScan), findsOneWidget);
    expect(find.text(zh.onboardingQqBindWaiting), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-qq-bind-cancel')), findsOneWidget,
        reason: '等待中可以取消（轮询可取消）');

    // 收尾前先取消：把定时器停掉（与用户点「取消」同一条路）
    await tester.tap(find.byKey(const ValueKey('onboarding-qq-bind-cancel')));
    await tester.pump();
    expect(find.byKey(const ValueKey('onboarding-qq-bind-start')), findsOneWidget);
    expect(openedUrls, hasLength(1), reason: '取消不会再开浏览器');
    await closeOut(tester);
  });

  testWidgets('轮询到成功：「绑定成功」+ AppID、AppSecret 只显示"已保存"、连接测试单独一行', (tester) async {
    useStateFile('qq-bind-success');
    bindStatuses = [
      {'status': 'pending'},
      {
        'status': 'success',
        'appId': '10240001',
        'saved': true,
        'enabled': true,
        'connection': {'ok': true, 'expiresIn': 7200},
      },
    ];
    await goToChannelStep(tester);
    await tapButton(tester, 'onboarding-qq-bind-start');

    await tickPoll(tester); // 第一次：还没扫
    expect(find.text(zh.onboardingQqBindWaitScan), findsOneWidget);

    await tickPoll(tester); // 第二次：成功
    expect(find.text(zh.onboardingQqBindSuccess), findsOneWidget);
    expect(find.text(zh.onboardingQqBindAppId('10240001')), findsOneWidget, reason: '显示 AppID');
    expect(find.text(zh.onboardingQqBindSavedNote), findsOneWidget,
        reason: 'secret 只显示"已保存"，不显示值');
    expect(find.text(zh.onboardingQqBindTokenOk(7200)), findsOneWidget,
        reason: '绑定成功 ≠ 一定连得上：连接测试结果单独一行');
    expect(find.textContaining('fake-client-secret'), findsNothing);
    expect(
      tester.widget<Checkbox>(find.byType(Checkbox).first).value,
      isTrue,
      reason: '服务端已经启用：勾选框跟着说实话',
    );
    expect(find.byKey(const ValueKey('onboarding-qq-bind-regenerate')), findsNothing);
    await closeOut(tester);
  });

  testWidgets('过期：「二维码过期了，重新生成」；再点一次会重新 start（并再开一次浏览器）', (tester) async {
    useStateFile('qq-bind-expired');
    bindStatuses = [
      {'status': 'expired'},
    ];
    await goToChannelStep(tester);
    await tapButton(tester, 'onboarding-qq-bind-start');
    await tickPoll(tester);

    final regenerate = find.byKey(const ValueKey('onboarding-qq-bind-regenerate'));
    expect(regenerate, findsOneWidget);
    expect(find.text(zh.onboardingQqBindRegenerate), findsOneWidget);
    expect(find.text(zh.onboardingQqBindSuccess), findsNothing);

    await tapButton(tester, 'onboarding-qq-bind-regenerate');
    expect(bindStarts, hasLength(2), reason: '重新生成 = 再要一个任务');
    expect(openedUrls, hasLength(2), reason: '新二维码也要交给浏览器');
    expect(find.text(zh.onboardingQqBindWaitScan), findsOneWidget);
    await closeOut(tester);
  });

  testWidgets('「填写凭据」：两格照旧，点「测试连接」走 qq-token-test（带框里刚敲的值）', (tester) async {
    useStateFile('qq-bind-token-test');
    await goToChannelStep(tester);
    await tapAndSettle(tester, find.text(zh.onboardingQqEntryManual));

    await tester.enterText(find.byKey(const ValueKey('onboarding-qq-appid')), '10240001');
    await tester.enterText(find.byKey(const ValueKey('onboarding-qq-appsecret')), 'typed-secret');
    await tester.pump();
    await tapButton(tester, 'onboarding-qq-token-test');

    final tested = posts.where((entry) => entry['path'] == '/api/commands/qq-token-test').toList();
    expect(tested, hasLength(1), reason: '「测试连接」走那条只测不写的端点');
    expect(tested.single['body'], {'appId': '10240001', 'clientSecret': 'typed-secret'},
        reason: '刚敲进框里的值直接测，不逼人先保存一次');
    expect(tested.single['confirm'], isNull, reason: 'qq-token-test 不带危险短语（它不写任何状态）');
    expect(find.text(zh.onboardingQqBindTokenOk(7200)), findsOneWidget);
    // 输入框里的人自己敲的值当然还在（那是他自己打的）；这里钉的是**结果行**不回显它
    final result = tester.widget<Text>(
      find.byKey(const ValueKey('onboarding-qq-token-result')),
    );
    expect(result.data, isNot(contains('typed-secret')), reason: '界面上不许回显 secret');
    await closeOut(tester);
  });
}
