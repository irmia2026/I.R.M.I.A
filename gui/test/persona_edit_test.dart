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

/// 人格配置页编辑器（POST /api/commands/persona-edit 的前端那一半）：
/// 用真实 loopback 假服务喂 files / file / history 三段数据，锁住五件事——
/// 未改动即禁用、改动后发对请求、成功有 toast、失败不丢输入、核心人格有警示。
/// 契约形状照 src/web/server.ts 的真实响应写（files 的 reserved/isSeed、编辑回包的 changed）。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, String> contents;
  late List<Map<String, dynamic>> historyEntries;
  Map<String, dynamic>? lastPost;
  bool failSave = false;

  const identityPath = 'IDENTITY.md';
  const relPath = 'RELATIONSHIPS/master.md';
  const coreWarning = '这是核心人格：改动会影响后续所有行为';
  const editedText = '每个字都要留下';

  /// 服务端视角的「可编辑白名单」：顶层四份 + RELATIONSHIPS/ 下一级 .md
  const editablePaths = ['IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md', 'STATE.md', relPath];

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，本组要打真实服务
    HttpOverrides.global = null;
    lastPost = null;
    failSave = false;
    contents = {
      'IDENTITY.md': '# 身份\n\n我是伊尔弥亚。\n',
      'CONSTITUTION.md': '# 章程\n\n第一条：不越权。\n',
      'STYLE.md': '# 语气\n\n克制。\n',
      'STATE.md': '# 状态\n\n待机。\n',
      relPath: '# master\n\n长期协作。\n',
    };
    historyEntries = [
      {'seq': 12, 'ts': '2026-09-01T03:20:00.000Z', 'file': 'STATE.md', 'by': 'agent', 'diffHash': 'a1b2c3d4e5f60718'},
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
                'reserved': entry.key == 'IDENTITY.md' || entry.key == 'CONSTITUTION.md',
                'tokens': 24,
                'proposalCount': 0,
              },
          ],
          'relationships': ['master'],
          'proposals': <String>[],
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
            'reserved': asked == 'IDENTITY.md' || asked == 'CONSTITUTION.md',
          }));
        }
      } else if (path == '/api/persona/history') {
        response.write(jsonEncode({'entries': historyEntries}));
      } else if (path == '/api/commands/persona-edit') {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        lastPost = body;
        if (failSave) {
          response.statusCode = 400;
          response.write(jsonEncode({
            'error': {'code': 'bad-request', 'message': '内容不能为空（人格文件不允许被清空）'},
          }));
        } else {
          // 真写了一笔：正文落盘 + persona/updated 事件进时间线（前端应据此刷新）
          contents[body['file'] as String] = body['content'] as String;
          historyEntries = [
            {'seq': 99, 'ts': '2026-09-02T01:02:03.000Z', 'file': body['file'], 'by': 'human', 'diffHash': 'deadbeefdeadbeef'},
            ...historyEntries,
          ];
          response.write(jsonEncode({
            'ok': true, 'seq': 99, 'type': 'persona/updated', 'file': body['file'], 'changed': true,
            'diffHash': 'deadbeefdeadbeef', 'previousHash': 'cafebabecafebabe',
            'bytes': utf8.encode(body['content'] as String).length,
          }));
        }
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

  /// 交替推进真异步与假时钟：HttpClient 的每一步 await 都要先让真实 I/O 跑完，
  /// 再 pump 把结果落进树——单次「等待 + pump」跑不完整条请求链，因此轮询到目标出现。
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

  /// 轮询到编辑区正文变成指定内容（切换文件后「视图到手」的可判定信号）
  Future<void> pumpUntilEditor(WidgetTester tester, String expected, {int rounds = 80}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      final fields = tester.widgetList<TextField>(find.byType(TextField));
      if (fields.isNotEmpty && fields.first.controller?.text == expected) return;
    }
    fail('等待编辑区内容未变为：$expected');
  }

  /// 收尾：把所有还在飞的请求与 toast 计时器跑完，避免测试结束时报 pending timer
  Future<void> drain(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 400));
  }

  Future<void> pumpPersona(WidgetTester tester, {Size size = const Size(1350, 900)}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: PersonaPage(state: state))),
    );
    // 编辑区出现 = files 与首份 file 都已到手（首屏自动选中第一份）
    await pumpUntil(tester, find.byType(TextField));
    await drain(tester);
  }

  FilledButton saveButton(WidgetTester tester) =>
      tester.widget<FilledButton>(find.widgetWithText(FilledButton, '保存'));

  TextButton revertButton(WidgetTester tester) =>
      tester.widget<TextButton>(find.widgetWithText(TextButton, '恢复原状'));

  TextField editor(WidgetTester tester) => tester.widget<TextField>(find.byType(TextField));

  testWidgets('未改动时「保存」与「恢复原状」都禁用', (tester) async {
    await pumpPersona(tester);

    expect(editor(tester).controller!.text, contents[identityPath], reason: '输入框初始值应等于服务端原文');
    expect(saveButton(tester).onPressed, isNull, reason: '未改动时保存应禁用');
    expect(revertButton(tester).onPressed, isNull, reason: '没有改动可恢复时「恢复原状」应禁用');
    expect(find.text('有未保存的更改'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('改动后保存可用，提交 {file, content}', (tester) async {
    await pumpPersona(tester);

    await tester.enterText(find.byType(TextField), editedText);
    await tester.pump();

    expect(find.text('有未保存的更改'), findsOneWidget, reason: '脏时给出状态提示');
    expect(saveButton(tester).onPressed, isNotNull);
    expect(revertButton(tester).onPressed, isNotNull);

    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pump();
    await pumpUntil(tester, find.text('已保存'));

    expect(lastPost, {'file': identityPath, 'content': editedText});
    await drain(tester);
  });

  testWidgets('保存成功后提示「已保存」，时间线出现新的 persona/updated', (tester) async {
    await pumpPersona(tester);

    await tester.enterText(find.byType(TextField), '$editedText（v2）');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pump();
    await pumpUntil(tester, find.text('已保存'));
    expect(find.text('已保存'), findsOneWidget);

    // 刷新后时间线顶部是新条目：展开它能看到本次改动的指纹
    await pumpUntil(tester, find.text('human'));
    await tester.tap(find.text('human'));
    await tester.pump();
    expect(find.text('deadbeefdeadbeef'), findsOneWidget, reason: '保存后时间线应立刻多一条 persona/updated');
    await drain(tester);
  });

  testWidgets('保存失败时提示错误，编辑内容保留', (tester) async {
    await pumpPersona(tester);
    failSave = true;

    await tester.enterText(find.byType(TextField), editedText);
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pump();
    await pumpUntil(tester, find.textContaining('保存失败'));

    expect(lastPost, {'file': identityPath, 'content': editedText});
    expect(editor(tester).controller!.text, editedText, reason: '失败不能丢用户输入');
    expect(find.text('有未保存的更改'), findsOneWidget, reason: '仍是脏状态，可再次保存');
    expect(saveButton(tester).onPressed, isNotNull);
    await drain(tester);
  });

  testWidgets('改回原文即回到干净态，「恢复原状」丢弃改动', (tester) async {
    await pumpPersona(tester);

    await tester.enterText(find.byType(TextField), editedText);
    await tester.pump();
    expect(find.text('有未保存的更改'), findsOneWidget);

    // 改回服务端原文：脏状态自动消失，按钮回到禁用
    await tester.enterText(find.byType(TextField), contents[identityPath]!);
    await tester.pump();
    expect(find.text('有未保存的更改'), findsNothing);
    expect(saveButton(tester).onPressed, isNull);

    // 再改一次，用「恢复原状」丢回原文
    await tester.enterText(find.byType(TextField), editedText);
    await tester.pump();
    await tester.tap(find.widgetWithText(TextButton, '恢复原状'));
    await tester.pump();
    expect(editor(tester).controller!.text, contents[identityPath]);
    expect(find.text('有未保存的更改'), findsNothing);
    await drain(tester);
  });

  testWidgets('核心人格显示警示，关系档案不显示', (tester) async {
    await pumpPersona(tester);
    expect(find.text(coreWarning), findsOneWidget, reason: 'IDENTITY.md 属于核心人格');

    await tester.tap(find.text('master.md'));
    await tester.pump();
    await pumpUntilEditor(tester, contents[relPath]!);

    expect(find.text(coreWarning), findsNothing, reason: '关系档案不是核心人格');
    expect(find.text('可编辑'), findsOneWidget, reason: '关系档案同样可编辑');
    await drain(tester);
  });

  testWidgets('可编辑的文件行挂铅笔（tooltip「可编辑」）', (tester) async {
    await pumpPersona(tester);

    expect(find.byTooltip('可编辑'), findsNWidgets(editablePaths.length),
        reason: '四份顶层文件 + 一份关系档案都可编辑，各挂一枚铅笔');
    expect(tester.takeException(), isNull);
  });

  testWidgets('有未保存改动时切换文件先确认，取消则留在原文件', (tester) async {
    await pumpPersona(tester);

    await tester.enterText(find.byType(TextField), editedText);
    await tester.pump();
    await tester.tap(find.text('master.md'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.text('放弃未保存的改动？'), findsOneWidget, reason: '切文件要走统一确认框');

    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(editor(tester).controller!.text, editedText, reason: '取消后改动与当前文件都保持原样');
    await drain(tester);
  });
}
