import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/persona_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 人格页的**提案区**（`POST /api/commands/persona-approve` / `persona-reject` 的前端那一半）。
///
/// 来源：docs/repo-cleanliness-audit.md §8 第 3 条（总表 D2）——两条命令的后端实现与用例都齐
/// （src/web/server.ts 的 `persona-approve` / `persona-reject`，test/web-server.test.ts:948,982），
/// 而界面**0 调用**，可页面文案早就在让用户去批准 / 拒绝（persona_page.dart 的只读提示
/// 「提案请用批准 / 拒绝处理」与树上的「提案 N」徽章）——"说了有出口，却没有出口"。
///
/// 这里锁四件事：
///   ① 只有门口真的有提案的那份文件才出现横幅与两颗按钮（没提案的文件不许长出按钮）；
///   ② 批准：**先确认**，确认后发 `persona-approve {file}`，提案消失、正文换成提案内容；
///   ③ 拒绝：确认框把话说清（人格文件不动），确认后发 `persona-reject {file}`；
///   ④ 确认框点取消 —— 一个请求都不许发。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, String> contents;
  late Map<String, int> proposals;
  late List<Map<String, dynamic>> historyEntries;

  /// 最后一次命令请求：路径 + body（两条命令分开发，所以两张账都要留）
  String? lastCommand;
  Map<String, dynamic>? lastBody;

  const identityPath = 'IDENTITY.md';
  const statePath = 'STATE.md';
  const proposalText = '# 状态\n\n心情：很安静。\n';

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，本组要打真实服务
    HttpOverrides.global = null;
    lastCommand = null;
    lastBody = null;
    contents = {
      identityPath: '# 身份\n\n我是伊尔弥亚。\n',
      statePath: '# 状态\n\n待机。\n',
    };
    // 门口的提案：只有 STATE.md 有一份
    proposals = {statePath: 1};
    // 时间线那一条故意挂在 IDENTITY.md 上：`_TimelineRow` 也逐字渲染 `entry['file']`，
    // 若它也写 STATE.md，`find.text('STATE.md')` 就会同时命中树行与时间线行（点击目标不唯一）。
    historyEntries = [
      {'seq': 12, 'ts': '2026-09-01T03:20:00.000Z', 'file': identityPath, 'by': 'agent', 'diffHash': 'a1b2c3d4e5f60718'},
    ];

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/api/persona/files') {
        response.write(jsonEncode({
          'root': 'D:/irmia/data/persona',
          'files': [
            for (final entry in contents.entries)
              {
                'path': entry.key,
                'name': entry.key.split('/').last,
                'bytes': utf8.encode(entry.value).length,
                'mtime': '2026-09-01T03:20:00.000Z',
                'reserved': entry.key == identityPath,
                'tokens': 24,
                // 契约形状照 server.ts 的 buildPersonaFiles：两个字段都给（历史留下的两种读法）
                'proposalCount': proposals[entry.key] ?? 0,
                'proposals': proposals[entry.key] ?? 0,
              },
          ],
          'relationships': <String>[],
          'proposals': [for (final e in proposals.entries) if (e.value > 0) e.key],
        }));
      } else if (path == '/api/persona/file') {
        final asked = req.uri.queryParameters['path'] ?? '';
        final content = contents[asked];
        if (content == null) {
          response.statusCode = 404;
          response.write(jsonEncode({'error': {'code': 'persona-file-not-found', 'message': '人格文件不存在：$asked'}}));
        } else {
          response.write(jsonEncode({
            'path': asked,
            'content': content,
            'bytes': utf8.encode(content).length,
            'mtime': '2026-09-01T03:20:00.000Z',
            'tokens': 24,
            'reserved': asked == identityPath,
          }));
        }
      } else if (path == '/api/persona/history') {
        response.write(jsonEncode({'entries': historyEntries}));
      } else if (path == '/api/commands/persona-approve') {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        lastCommand = path;
        lastBody = body;
        final file = body['file'] as String;
        // 服务端语义：提案内容写进目标文件、提案文件删掉、写一条 persona/updated
        contents[file] = proposalText;
        proposals[file] = 0;
        historyEntries = [
          {'seq': 40, 'ts': '2026-09-02T01:02:03.000Z', 'file': file, 'by': 'human', 'diffHash': 'feedfacefeedface'},
          ...historyEntries,
        ];
        response.write(jsonEncode({
          'ok': true, 'seq': 40, 'type': 'persona/updated', 'file': file, 'diffHash': 'feedfacefeedface',
        }));
      } else if (path == '/api/commands/persona-reject') {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        lastCommand = path;
        lastBody = body;
        proposals[body['file'] as String] = 0;
        // 拒绝 = 只删提案文件，不写事件（server.ts 里那条注释的口径）
        response.write(jsonEncode({'ok': true, 'file': body['file'], 'diffHash': 'feedfacefeedface', 'rejected': true}));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': '接口不存在'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
  });

  /// 交替推进真异步与假时钟（与 persona_edit_test.dart 同一套：单次「等待 + pump」跑不完
  /// 一条 HttpClient 请求链）。
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

  /// 轮询到编辑区正文变成指定内容（"切换/重读文件已生效"的可判定信号）
  Future<void> pumpUntilEditor(WidgetTester tester, String expected, {int rounds = 80}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      final fields = tester.widgetList<TextField>(find.byType(TextField));
      if (fields.isNotEmpty && fields.first.controller?.text == expected) return;
    }
    fail('等待编辑区内容未变为：$expected');
  }

  /// 轮询到某个目标消失：横幅与徽章的消失都发生在 `loadFiles()` 回来之后，
  /// 而那是 `unawaited` 出去的（toast 先出现、清单后到），所以不能紧跟 toast 就断言。
  Future<void> pumpUntilGone(WidgetTester tester, Finder target, {int rounds = 80}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (target.evaluate().isEmpty) return;
    }
    fail('等待目标消失超时：$target');
  }

  /// 收尾：跑完还在飞的请求与 toast 计时器，避免测试结束时报 pending timer
  Future<void> drain(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> pumpPersona(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1350, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: PersonaPage(state: state))),
    );
    await pumpUntil(tester, find.byType(TextField));
    await drain(tester);
  }

  /// 切到 STATE.md（唯一带提案的那份）
  Future<void> selectState(WidgetTester tester) async {
    await tester.tap(find.text(statePath));
    await tester.pump();
    await pumpUntil(tester, find.text('批准提案'));
    await drain(tester);
  }

  testWidgets('提案区：只有门口有提案的文件显示「批准提案 / 拒绝提案」', (tester) async {
    await pumpPersona(tester);

    // 首屏自动选中 IDENTITY.md（没有提案）：不许长出按钮与横幅。
    //
    // 这里按**横幅的措辞**判（"…份待确认提案：批准会把它写入这份文件"），不能只用「待确认提案」：
    // 时间线卡片那句「N 个待确认提案」是 `files` 的**全局合计**（页面原有的一道口径），
    // 与"当前这份文件门口有几份"不是同一件事。
    expect(find.text('批准提案'), findsNothing);
    expect(find.text('拒绝提案'), findsNothing);
    expect(find.textContaining('份待确认提案：批准会把它写入这份文件'), findsNothing);
    expect(find.textContaining('个待确认提案'), findsOneWidget, reason: '全局合计照旧由时间线那句话负责');

    await selectState(tester);

    expect(find.text('批准提案'), findsOneWidget);
    expect(find.text('拒绝提案'), findsOneWidget);
    expect(
      find.textContaining('$statePath 有 1 份待确认提案'),
      findsOneWidget,
      reason: '横幅要说清是哪份文件、几份提案',
    );
    // 树上的徽章与横幅说的是同一个数（同一个来源：/api/persona/files 的 proposalCount）
    expect(find.text('提案 1'), findsOneWidget);
    await drain(tester);
  });

  testWidgets('批准：先确认，确认后发 persona-approve{file}，横幅消失、正文换成提案内容', (tester) async {
    await pumpPersona(tester);
    await selectState(tester);

    await tester.tap(find.text('批准提案'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('批准这份提案？'), findsOneWidget, reason: '批准会真写人格资产，必须先点头');

    // 对话框里的确认按钮（与横幅那颗同名不同文案：那颗是「批准提案」）
    await tester.tap(find.widgetWithText(FilledButton, '批准'));
    await tester.pump();
    await pumpUntil(tester, find.textContaining('已批准'));

    expect(lastCommand, '/api/commands/persona-approve');
    expect(lastBody, {'file': statePath}, reason: '不带 diffHash：界面没有提案正文可比对，服务端允许留空');
    // 批准后：提案没了（横幅与徽章一起消失），正文换成提案写进去的那一份
    await pumpUntilEditor(tester, proposalText);
    await pumpUntilGone(tester, find.text('批准提案'));
    await pumpUntilGone(tester, find.text('提案 1'));
    expect(find.text('拒绝提案'), findsNothing, reason: '提案已结案，按钮不该还留在那儿');
    await drain(tester);
  });

  testWidgets('拒绝：确认框说清人格文件不动，确认后发 persona-reject{file}', (tester) async {
    await pumpPersona(tester);
    await selectState(tester);

    await tester.tap(find.text('拒绝提案'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('拒绝这份提案？'), findsOneWidget);
    expect(find.textContaining('只删掉那份提案文件'), findsOneWidget, reason: '拒绝的后果要说在明面上');

    await tester.tap(find.widgetWithText(FilledButton, '拒绝'));
    await tester.pump();
    await pumpUntil(tester, find.textContaining('已拒绝'));

    expect(lastCommand, '/api/commands/persona-reject');
    expect(lastBody, {'file': statePath});
    // 人格文件一个字没动（拒绝只删提案）
    expect(contents[statePath], '# 状态\n\n待机。\n');
    await pumpUntilGone(tester, find.text('批准提案'));
    await drain(tester);
  });

  testWidgets('确认框点取消：一个请求都不发，提案原样留着', (tester) async {
    await pumpPersona(tester);
    await selectState(tester);

    await tester.tap(find.text('批准提案'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(lastCommand, isNull, reason: '取消之后不许有任何命令请求');
    expect(find.text('批准提案'), findsOneWidget, reason: '提案还在门口等着');
    expect(tester.takeException(), isNull);
    await drain(tester);
  });
}
