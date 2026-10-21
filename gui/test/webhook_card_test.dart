import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/settings_page.dart';
import 'package:irmia_gui/session_store.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 设置页「外部回调」卡（B9 的界面那一半）：`POST /webhook/*` 的专用凭据——生成 / 轮换。
///
/// 被测的四件事（按重要性）：
///   ① **没配写「生成」、配了写「重新生成」**（判据是 `GET /api/webhook-secret` 的
///      `configured`，不是本地猜的）；
///   ② **重新生成要先确认**（这一档是不可逆的：旧的那份当场失效，还在用的外部脚本开始收 401），
///      灰取消一个请求都不发；
///   ③ **明文只在那张"只显示这一次"的框里出现一次、绝不落本地存储**（不写 ui-state.json、
///      不做"再看一眼"），关掉就再也找不回来；
///   ④ 状态读不到时**只灰这张卡**、且**不摆写入控件**（不在看不见状态的时候盲换钥匙）。
///
/// 服务端那两条端点的口径（核对了 src/web/server.ts 与 src/web/webhook-secret.ts，
/// 不是照抄任务描述）：`GET /api/webhook-secret` 回
/// `{configured, secretId, createdAt, rotatedAt, by, file} + {channel, header, command}`，
/// **不含明文、也不含哈希**；`POST /api/commands/regenerate-webhook-token` 要
/// `X-Confirm: regenerate-webhook-token`，回 `{ok, token, note, secretId, createdAt,
/// action: 'generate'|'rotate', previousSecretId}`，明文只在这一次出现。
void main() {
  /// 服务端签发的那串明文：形状照 base64url（真实长度 32 字节 → 43 字符），
  /// 但它是**测试自己编的**，不是任何真实凭据
  const issuedToken = 'whk-9f3c1a2b4d5e6f708192a3b4c5d6e7f8a1b2c3d4';
  const oldSecretId = 'a1b2c3d4e5f60718';
  const newSecretId = '0f1e2d3c4b5a6978';

  late HttpServer server;
  late AppState state;
  late Directory tmpDir;

  /// 服务端那份凭据的现状（用例直接改它，模拟"还没生成 / 已经有一份"）
  bool configured = false;
  String secretId = oldSecretId;
  String? rotatedAt;
  String by = '';
  /// `/api/webhook-secret` 读不到（500）
  bool secretFails = false;
  /// 生成/轮换那条命令失败（500）
  bool rotateFails = false;
  /// 生成/轮换的回执里**不给明文**（服务端异常形状；界面该如实说，不许假装成功）
  bool replyWithoutToken = false;

  /// 命令通道收到过什么（"先确认才发请求"那条断言就落在这三个上）
  int commandCalls = 0;
  String? commandMethod;
  String? commandPath;
  String? commandConfirm;
  Map<String, dynamic> commandBody = <String, dynamic>{};

  Map<String, dynamic> secretView() => <String, dynamic>{
        'configured': configured,
        'secretId': configured ? secretId : null,
        'createdAt': configured ? '2026-10-04T08:00:00.000Z' : null,
        'rotatedAt': rotatedAt,
        'by': by.isEmpty ? null : by,
        'file': 'D:/irmia/data/.webhook-secret.json',
        'channel': '/webhook/*',
        'header': 'Authorization: Bearer <token>',
        'command': 'regenerate-webhook-token',
      };

  const config = <String, dynamic>{
    'dataDir': 'D:/irmia/data',
    'web': {'host': '127.0.0.1', 'port': 7788},
    'timezone': 'Asia/Shanghai',
    'models': {
      'heavy': {'model': 'gpt-4o-mini', 'baseUrl': 'https://api.example.com', 'apiKeyEnv': 'A'},
      'light': {'model': 'gpt-4o-mini-lite', 'baseUrl': 'https://api.example.com', 'apiKeyEnv': 'B'},
    },
    'budget': {
      'stepTools': 8,
      'turnSteps': 30,
      'taskTokens': 120000,
      'dailyTokens': 2000000,
      'softRatio': 0.8,
      'failStreakMax': 3,
    },
    'speak': {'typingEffect': true, 'charsPerMinute': 90},
  };

  setUp(() async {
    HttpOverrides.global = null;
    tmpDir = Directory.systemTemp.createTempSync('irmia-webhook-');
    stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
    sessionsRootOverride = '${tmpDir.path}${Platform.pathSeparator}sessions';
    // 摆上这个界面**真实的两份本地存储**（偏好 + 会话凭据）：这样"明文没落盘"才不是空断言
    File(stateFileOverride!).writeAsStringSync('{"moreGroupOpen":true}');
    SessionStore().write('127.0.0.1:7788#aabbccddeeff0011', 'good-session-token');
    configured = false;
    secretId = oldSecretId;
    rotatedAt = null;
    by = '';
    secretFails = false;
    rotateFails = false;
    replyWithoutToken = false;
    commandCalls = 0;
    commandMethod = null;
    commandPath = null;
    commandConfirm = null;
    commandBody = <String, dynamic>{};

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/api/webhook-secret') {
        if (secretFails) {
          response.statusCode = 500;
          response.write(jsonEncode({'error': {'message': '凭据状态端点不可用'}}));
        } else {
          response.write(jsonEncode(secretView()));
        }
      } else if (path == '/api/commands/regenerate-webhook-token') {
        commandCalls += 1;
        commandMethod = req.method;
        commandPath = path;
        commandConfirm = req.headers.value('X-Confirm');
        final raw = await utf8.decoder.bind(req).join();
        commandBody = raw.isEmpty ? <String, dynamic>{} : (jsonDecode(raw) as Map<String, dynamic>);
        if (rotateFails) {
          response.statusCode = 500;
          response.write(jsonEncode({'error': {'message': '凭据文件写不进去'}}));
        } else {
          // 照服务端的 rotate()：这个通道永远只有一把钥匙，再调一次就是换掉它
          final action = configured ? 'rotate' : 'generate';
          final previous = configured ? secretId : null;
          configured = true;
          secretId = newSecretId;
          by = 'gui';
          if (action == 'rotate') rotatedAt = '2026-10-04T09:30:00.000Z';
          response.write(jsonEncode(<String, dynamic>{
            'ok': true,
            if (!replyWithoutToken) 'token': issuedToken,
            'note': '这串 token 只显示这一次（盘上只留它的 sha256，日志与事件里都没有原文）：'
                '把它配到调用方的 Authorization: Bearer 头上。',
            'secretId': newSecretId,
            'createdAt': '2026-10-04T08:00:00.000Z',
            'action': action,
            'previousSecretId': previous,
            'instance': '127.0.0.1:7788#aabbccddeeff0011',
          }));
        }
      } else if (path == '/api/config') {
        response.write(jsonEncode(config));
      } else if (path == '/api/keys') {
        response.write(jsonEncode(<String, dynamic>{}));
      } else if (path == '/api/deps') {
        response.write(jsonEncode(<String, dynamic>{'available': true, 'entries': <dynamic>[]}));
      } else if (path == '/api/protocol-side') {
        response.write(jsonEncode(<String, dynamic>{'configured': false, 'enabled': false, 'state': 'stopped'}));
      } else if (path == '/api/projection') {
        response.write(jsonEncode(<String, dynamic>{'lastSeq': 1}));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': '接口不存在'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
    state.ready = true;
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
    stateFileOverride = null;
    sessionsRootOverride = null;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 清不掉临时目录不影响断言
    }
  });

  /// 交替推进真异步与假时钟（照 settings_page_test 的做法）：HttpClient 每一步 await 都要先让
  /// 真实 I/O 跑完，再 pump 把结果落进树——单次"等待 + pump"跑不完整条请求链。
  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 40}) async {
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

  /// 收尾：把还在飞的请求与 toast 计时器跑完，避免测试结束时报 pending timer
  Future<void> drain(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// 把屏上那条 toast 彻底送走（入场动画走完计时器才起跑，一次 pump(4s) 不够）
  Future<void> away(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 600));
  }

  Future<void> tap(WidgetTester tester, Finder target) async {
    await away(tester);
    await tester.ensureVisible(target); // 设置页很长：屏幕外的控件点不到
    await tester.pump();
    await tester.tap(target);
    await tester.pump();
  }

  Future<void> pumpSettings(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1350, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: IrmiaTheme.light(),
        home: Scaffold(body: SettingsPage(state: state)),
      ),
    );
    // 锚点出现 = 配置到手、分区卡片已渲染（三态已越过）
    await pumpUntil(tester, find.text('模型'));
    await drain(tester);
  }

  /// 卡上那颗生成/轮换按钮
  Finder rotateButton() => find.byKey(const ValueKey('webhook-rotate'));

  /// 本地存储里**不许**出现明文：把临时目录下所有文件读一遍
  /// （界面偏好 ui-state.json + 会话凭据都在这里）
  void expectTokenNotOnDisk() {
    final files = tmpDir.listSync(recursive: true).whereType<File>().toList();
    expect(files.length, greaterThanOrEqualTo(2),
        reason: '这一页至少该有偏好与会话凭据两份本地存储（否则这条断言等于没测）');
    for (final file in files) {
      expect(file.readAsStringSync(), isNot(contains(issuedToken)),
          reason: '明文不许落任何本地文件：${file.path}');
    }
  }

  testWidgets('没配时按钮写「生成 webhook 凭据」，卡上摆着状态、curl 例子与"不认界面凭据"那句', (tester) async {
    await pumpSettings(tester);
    await tester.ensureVisible(rotateButton());
    await tester.pump();

    expect(find.text('生成 webhook 凭据'), findsOneWidget);
    expect(find.text('重新生成'), findsNothing);
    // 徽章 + 「当前凭据」那一行的值都说"还没有生成"
    expect(find.text('还没有生成'), findsNWidgets(2));
    expect(find.textContaining('这条通道现在一律 401'), findsOneWidget);
    // 卡底那条例子与那句最容易被踩的话
    expect(find.textContaining('curl -X POST http://127.0.0.1:7788/webhook/alert'), findsOneWidget);
    expect(find.textContaining('不认界面凭据'), findsOneWidget);

    await drain(tester);
  });

  testWidgets('第一次生成：不弹确认（没有任何东西会失效），明文只在那张"只显示这一次"的框里', (tester) async {
    await pumpSettings(tester);
    await tap(tester, rotateButton());
    await pumpUntil(tester, find.byKey(const ValueKey('webhook-token-plain')));
    await drain(tester);

    expect(commandCalls, 1);
    expect(commandMethod, 'POST');
    expect(commandPath, '/api/commands/regenerate-webhook-token');
    expect(commandConfirm, 'regenerate-webhook-token', reason: '命令通道的 X-Confirm 是硬要求');
    expect(commandBody, {'by': 'gui'});

    // 确认框是"灰取消 + 红确认"，它**没**出现（第一次生成没有旧钥匙会失效）
    expect(find.text('取消'), findsNothing, reason: '第一次生成不该先问一遍');

    // 明文在框里，而且只在框里
    expect(find.text(issuedToken), findsOneWidget);
    expect(find.byKey(const ValueKey('webhook-token-done')), findsOneWidget);
    expectTokenNotOnDisk();

    // 复制按钮真的把明文递给了剪贴板（"抄走"不能只靠人眼对着屏幕手敲）
    final copies = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copies.add((call.arguments as Map)['text'] as String);
      }
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));
    await tap(tester, find.byKey(const ValueKey('webhook-token-copy')));
    expect(copies, [issuedToken]);
    await drain(tester);

    // 关掉 = 再也看不到它了（没有"再看一眼"这条路）
    await tap(tester, find.byKey(const ValueKey('webhook-token-done')));
    await drain(tester);
    expect(find.text(issuedToken), findsNothing);
    expectTokenNotOnDisk();

    // 卡上的状态跟着换了：按钮改口「重新生成」，id 是新的那份
    await tester.ensureVisible(rotateButton());
    await tester.pump();
    expect(find.text('重新生成'), findsOneWidget);
    expect(find.textContaining(newSecretId), findsWidgets);
    expect(find.text('上次轮换'), findsOneWidget);
    expect(find.text('从未'), findsOneWidget, reason: '第一次生成之后还没有轮换过');
  });

  testWidgets('重新生成：先确认；灰取消一个请求都不发，红确认才换钥匙，并把"上一份已失效"说在卡上', (tester) async {
    configured = true;
    await pumpSettings(tester);
    await tester.ensureVisible(rotateButton());
    await tester.pump();
    expect(find.text('重新生成'), findsOneWidget);
    expect(find.textContaining(oldSecretId), findsWidgets);

    // ① 灰取消：什么都不发生（尤其**不发请求**——轮换是不可逆的）
    await tap(tester, rotateButton());
    await drain(tester);
    expect(find.text('取消'), findsOneWidget, reason: '重新生成必须先过项目既有的确认框');
    await tap(tester, find.text('取消'));
    await drain(tester);
    expect(commandCalls, 0, reason: '取消 = 一个请求都不发');
    expect(find.textContaining(oldSecretId), findsWidgets, reason: '旧那份还在，卡上没变');

    // ② 红确认：才真的换
    await tap(tester, rotateButton());
    await drain(tester);
    await tap(tester, find.widgetWithText(FilledButton, '重新生成').hitTestable());
    await pumpUntil(tester, find.byKey(const ValueKey('webhook-token-plain')));
    await drain(tester);

    expect(commandCalls, 1);
    expect(commandConfirm, 'regenerate-webhook-token');
    expect(find.text(issuedToken), findsOneWidget);
    expect(find.textContaining('上一份凭据（$oldSecretId）此刻已经失效'), findsOneWidget,
        reason: '一定有外部脚本还没换——这句话要当面说');
    expectTokenNotOnDisk();

    await tap(tester, find.byKey(const ValueKey('webhook-token-done')));
    await drain(tester);
    expect(find.text(issuedToken), findsNothing, reason: '关掉就再也看不到它了');
    await tester.ensureVisible(rotateButton());
    await tester.pump();
    expect(find.textContaining(newSecretId), findsWidgets);
    expect(find.textContaining('上一份已当场失效'), findsOneWidget, reason: '轮换之后卡上留一句');
    expect(find.text('从未'), findsNothing, reason: '轮换过了，不再是"从未"');
    expectTokenNotOnDisk();

    await drain(tester);
  });

  testWidgets('状态读不到：只灰这张卡、不摆写入控件（不在看不见状态的时候盲换钥匙），并且能重试', (tester) async {
    secretFails = true;
    await pumpSettings(tester);
    await drain(tester);

    expect(find.textContaining('凭据状态读取失败'), findsOneWidget);
    expect(rotateButton(), findsNothing, reason: '状态看不见时不给写入控件');
    final retry = find.byKey(const ValueKey('webhook-retry'));
    expect(retry, findsOneWidget);

    // 服务端回来了：点「重试」把状态读回来，写入控件才出现
    secretFails = false;
    await tap(tester, retry);
    await pumpUntil(tester, rotateButton());
    await drain(tester);
    expect(find.text('生成 webhook 凭据'), findsOneWidget);
    expect(find.textContaining('凭据状态读取失败'), findsNothing);
  });

  testWidgets('服务端没回明文：如实说，不假装成功（不弹那张"抄走"的框）', (tester) async {
    replyWithoutToken = true;
    await pumpSettings(tester);
    await tap(tester, rotateButton());
    await drain(tester);

    expect(commandCalls, 1);
    expect(find.byKey(const ValueKey('webhook-token-plain')), findsNothing,
        reason: '没有明文就没有"抄走"这回事');
    expect(find.textContaining('服务端没有回凭据原文'), findsOneWidget);
    // 收尾：toast 走完
    await away(tester);
    await drain(tester);
  });
}
