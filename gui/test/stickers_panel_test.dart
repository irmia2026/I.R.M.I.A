import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/stickers_panel.dart';
import 'package:irmia_gui/theme.dart';

class NoIdleHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = super.createHttpClient(context);
    client.idleTimeout = Duration.zero;
    return client;
  }
}

void main() {
  late HttpServer server;
  late AppState state;
  late List<Map<String, dynamic>> items;
  late Map<String, dynamic> settings;
  late List<Map<String, dynamic>> patches;
  late List<Map<String, dynamic>> writes;
  String? lastConfirm;
  Map<String, dynamic>? uploadBody;
  final png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');

  Map<String, dynamic> entry(String id, String status, List<String> tags, {String source = 'owner'}) => {
        'id': id,
        'file': 'cache/$id.png',
        'tags': tags,
        'intensity': 'obvious',
        'status': status,
        'sha256': id.padRight(64, '0'),
        'addedAt': '2026-10-31T04:00:00.000Z',
        'tagSource': 'auto',
        'tagConfidence': 0.96,
        'note': '测试贴图',
        'stats': {'sent': 2, 'lastSentAt': null},
        'packId': 'owner-stickers',
        'packTitle': '默认表情',
        'source': source,
        'imageUrl': '/api/stickers/$id/image',
      };

  Map<String, dynamic> view() {
    final tags = <String, int>{for (final tag in ['开心', '难过', '担心', '生气', '亲近', '好奇', '无语', '得意', '害羞']) tag: 0};
    for (final item in items.where((item) => item['status'] == 'approved')) {
      for (final tag in item['tags'] as List) {
        tags['$tag'] = (tags['$tag'] ?? 0) + 1;
      }
    }
    return {
      'items': items,
      'counts': {
        'approved': items.where((item) => item['status'] == 'approved').length,
        'pending': items.where((item) => item['status'] == 'pending').length,
        'rejected': items.where((item) => item['status'] == 'rejected').length,
        'blocked': items.where((item) => item['status'] == 'blocked').length,
        'sentToday': 0,
      },
      'tags': tags,
      'page': 1,
      'pageSize': 48,
      'total': items.length,
      'totalPages': 1,
      'settings': settings,
    };
  }

  setUp(() async {
    HttpOverrides.global = NoIdleHttpOverrides();
    items = [];
    settings = {'enabled': true, 'harvestEnabled': true, 'harvestProbability': 0.15, 'taggingEnabled': true, 'groups': false, 'passiveProbability': 0.12, 'minTurnsBetween': 4, 'rejectedRetentionDays': 7};
    patches = [];
    writes = [];
    lastConfirm = null;
    uploadBody = null;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      final response = req.response..headers.set(HttpHeaders.connectionHeader, 'close');
      dynamic body;
      if (req.method != 'GET') {
        final text = await utf8.decoder.bind(req).join();
        if (text.trim().isNotEmpty) body = jsonDecode(text);
      }
      if (path == '/api/stickers' && req.method == 'GET') {
        response.write(jsonEncode(view()));
      } else if (path == '/api/stickers' && req.method == 'POST') {
        uploadBody = Map<String, dynamic>.from(body as Map);
        final created = entry('uploaded', 'pending', ['开心']);
        items.add(created);
        response.statusCode = 201;
        response.write(jsonEncode({'entry': created, 'duplicate': false, 'tagging': {'approved': false, 'reason': 'pending'}}));
      } else if (path == '/api/stickers/events') {
        response.write(jsonEncode({'items': [
          {'seq': 2, 'ts': '2026-10-31T04:01:00.000Z', 'type': 'sticker/sent', 'data': {'tag': '开心', 'stickerId': 'one'}},
          {'seq': 1, 'ts': '2026-10-31T04:00:00.000Z', 'type': 'sticker/tagged', 'data': {'stickerId': 'one', 'ok': true}},
        ]}));
      } else if (path == '/api/commands/sticker-harvest') {
        writes.add({'path': path, 'body': body});
        settings['harvestEnabled'] = body['enabled'];
        response.write(jsonEncode({'ok': true, 'enabled': body['enabled'], 'requiresRestart': false}));
      } else if (path == '/api/commands/config-update') {
        writes.add({'path': path, 'body': body, 'confirm': req.headers.value('x-confirm')});
        final fields = (body['fields'] as Map).cast<String, dynamic>();
        for (final field in fields.keys) {
          if (field == 'stickers.enabled') settings['enabled'] = fields[field];
          if (field == 'stickers.tagging.enabled') settings['taggingEnabled'] = fields[field];
          if (field == 'stickers.harvest.probability') settings['harvestProbability'] = fields[field];
          if (field == 'stickers.activeProbability') settings['stickers.activeProbability'] = fields[field];
          if (field == 'stickers.cooldownSeconds') settings['stickers.cooldownSeconds'] = fields[field];
        }
        response.write(jsonEncode({'ok': true, 'requiresRestart': false}));
      } else if (path == '/api/commands/stickers-purge') {
        lastConfirm = req.headers.value('x-confirm');
        items.removeWhere((item) => item['id'] == body['id']);
        response.write(jsonEncode({'count': 1, 'ids': [body['id']]}));
      } else if (path.startsWith('/api/stickers/') && path.endsWith('/image')) {
        response.headers.contentType = ContentType('image', 'png');
        response.add(png);
      } else if (path.startsWith('/api/stickers/') && req.method == 'PATCH') {
        final id = Uri.decodeComponent(path.substring('/api/stickers/'.length));
        patches.add({'id': id, 'body': body});
        final item = items.firstWhere((item) => item['id'] == id);
        for (final key in (body as Map).keys) {
          item[key] = body[key];
        }
        response.write(jsonEncode({'entry': item, 'action': body['status'] == 'approved' ? 'approve' : 'edit'}));
      } else if (path.startsWith('/api/stickers/') && req.method == 'DELETE') {
        final id = Uri.decodeComponent(path.substring('/api/stickers/'.length));
        lastConfirm = req.headers.value('x-confirm');
        final item = items.firstWhere((item) => item['id'] == id);
        item['status'] = 'rejected';
        response.write(jsonEncode(item));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'code': 'not-found', 'message': 'not found'}}));
      }
      await response.close();
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
  });

  Future<void> pumpPanel(
    WidgetTester tester, {
    Map<String, dynamic>? initial,
    StickerFilePicker? picker,
    double height = 1100,
    Size size = const Size(1280, 1100),
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: SizedBox(
        height: height,
        width: double.infinity,
        child: StickersPanel(
          state: state,
          view: initial ?? view(),
          picker: picker ?? () async => StickerFile(bytes: png, mime: 'image/png', name: 'one.png'),
        ),
      )),
    ));
    await tester.pump();
  }

  Future<void> settle(WidgetTester tester) async {
    for (var i = 0; i < 200; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (state.api.inFlightCount == 0) {
        await tester.pump();
        return;
      }
    }
    fail('等待贴纸 API 结束超时：${state.api.pendingRequests}');
  }

  Future<void> tap(WidgetTester tester, Finder finder) async {
    await tester.ensureVisible(finder);
    await tester.pump();
    await tester.tap(finder);
    await tester.pump();
  }

  testWidgets('分组：九标签只显示有库存的分区，计数、来源与使用次数来自接口', (tester) async {
    items = [entry('one', 'approved', ['开心']), entry('two', 'approved', ['亲近'], source: 'collected')];
    await pumpPanel(tester);
    expect(find.text('开心 1'), findsOneWidget);
    expect(find.text('亲近 1'), findsOneWidget);
    expect(find.text('难过 0'), findsNothing);
    expect(find.textContaining('已入库 2'), findsOneWidget);
    expect(find.textContaining('采收'), findsOneWidget);
    expect(find.textContaining('使用 2 次'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  testWidgets('骨架：左侧栏 + 右侧单卡片，上传与刷新只在卡片头', (tester) async {
    items = [entry('one', 'approved', ['开心'])];
    await pumpPanel(tester);
    expect(find.byType(ChoiceChip), findsNothing, reason: '横向 ChoiceChip 不再作为主导航');
    expect(find.byKey(const ValueKey('sticker-side-scroll')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-content-scroll')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-view-title')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-view-count')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-upload')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-refresh')), findsOneWidget);
    expect(find.text('表情包'), findsOneWidget, reason: '标题在左侧栏');
    expect(find.text('全部'), findsOneWidget, reason: '库模式默认显示全部');
  });

  testWidgets('左侧标签只过滤右栏，不改库存，也不发请求', (tester) async {
    items = [entry('one', 'approved', ['开心']), entry('two', 'approved', ['亲近'])];
    await pumpPanel(tester);
    expect(find.byKey(const ValueKey('sticker-card-one')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-card-two')), findsOneWidget);

    await tap(tester, find.byKey(const ValueKey('sticker-filter-tag-亲近')));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const ValueKey('sticker-card-one')), findsNothing);
    expect(find.byKey(const ValueKey('sticker-card-two')), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey('sticker-view-count'))).data, '1');
    expect(patches, isEmpty, reason: '标签筛选只改本地显示');
    expect(writes, isEmpty, reason: '标签筛选不写后端配置');
    expect(items, hasLength(2), reason: '库存一张都不许动');

    await tap(tester, find.byKey(const ValueKey('sticker-filter-all')));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.byKey(const ValueKey('sticker-card-one')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-card-two')), findsOneWidget);
  });

  testWidgets('右栏滚动能到最底部，最后一张卡片可见', (tester) async {
    items = [for (var i = 0; i < 24; i++) entry('s$i', 'approved', ['开心'])];
    await pumpPanel(tester, height: 600);
    final scrollView = tester.widget<SingleChildScrollView>(
      find.byKey(const ValueKey('sticker-content-scroll')),
    );
    final controller = scrollView.controller!;
    expect(controller.position.maxScrollExtent, greaterThan(0), reason: '内容必须真的可滚');

    await tester.drag(find.byKey(const ValueKey('sticker-content-scroll')), const Offset(0, -400));
    await tester.pump(const Duration(milliseconds: 100));
    expect(controller.offset, greaterThan(0));

    controller.jumpTo(controller.position.maxScrollExtent);
    await tester.pump();
    expect(controller.offset, closeTo(controller.position.maxScrollExtent, 1));
    final last = tester.getRect(find.byKey(const ValueKey('sticker-card-s23')));
    expect(last.top, greaterThanOrEqualTo(0));
    expect(last.bottom, lessThanOrEqualTo(600), reason: '滚到底时最后一张应在视口内');
  });

  testWidgets('设置与事件切过去是可滚 ListView，左栏也能独立滚', (tester) async {
    await pumpPanel(tester, height: 260);
    final side = tester.widget<ListView>(find.byKey(const ValueKey('sticker-side-scroll')));
    expect(side.controller!.position.maxScrollExtent, greaterThan(0));

    await tap(tester, find.byKey(const ValueKey('sticker-tab-3')));
    final settings = tester.widget<ListView>(find.byKey(const ValueKey('sticker-content-scroll')));
    expect(settings.controller!.position.maxScrollExtent, greaterThan(0));
    settings.controller!.jumpTo(settings.controller!.position.maxScrollExtent);
    await tester.pump();

    await tap(tester, find.byKey(const ValueKey('sticker-tab-4')));
    await settle(tester);
    final events = tester.widget<ListView>(find.byKey(const ValueKey('sticker-content-scroll')));
    expect(events.controller!.position.maxScrollExtent, greaterThan(0));
  });

  testWidgets('窄窗：卡片 Wrap 不溢出', (tester) async {
    items = [for (var i = 0; i < 6; i++) entry('n$i', 'approved', ['开心'])];
    await pumpPanel(tester, height: 800, size: const Size(760, 800));
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('sticker-card-n0')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-upload')), findsOneWidget);
  });

  testWidgets('审核：批准后调用 PATCH，待审区如实清空', (tester) async {
    items = [entry('one', 'pending', ['开心'])];
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-2')));
    await tap(tester, find.byKey(const ValueKey('sticker-approve-one')));
    await settle(tester);
    expect(patches.single['body'], {'status': 'approved'});
    expect(items.single['status'], 'approved');
    expect(find.text('没有待审贴纸'), findsOneWidget);
  });

  testWidgets('审核：拒绝不直接物理删除，已拒绝区可以恢复', (tester) async {
    items = [entry('one', 'pending', ['开心'])];
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-2')));
    await tap(tester, find.byKey(const ValueKey('sticker-reject-one')));
    await settle(tester);
    expect(items.single['status'], 'rejected');
    await tap(tester, find.byKey(const ValueKey('sticker-restore-one')));
    await settle(tester);
    expect(items.single['status'], 'approved');
    expect(patches.last['body'], {'status': 'approved'});
  });

  testWidgets('批量：选中两张待审后一次审批，按钮不在空选择时误发', (tester) async {
    items = [entry('one', 'pending', ['开心']), entry('two', 'pending', ['亲近'])];
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-2')));
    expect(tester.widget<TextButton>(find.byKey(const ValueKey('sticker-batch-approve'))).onPressed, isNull);
    await tap(tester, find.byKey(const ValueKey('sticker-select-one')));
    await tap(tester, find.byKey(const ValueKey('sticker-select-two')));
    await tap(tester, find.byKey(const ValueKey('sticker-batch-approve')));
    await settle(tester);
    expect(patches.length, 2);
    expect(items.every((item) => item['status'] == 'approved'), isTrue);
    expect(find.text('已处理 2 张'), findsOneWidget);
  });

  testWidgets('上传：选图→打标→预览→确认，批准不会被上传锁吞掉', (tester) async {
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-upload')));
    await settle(tester);
    expect(find.text('测试贴图'), findsOneWidget);
    expect(find.textContaining('打标置信度 96%'), findsOneWidget);
    await tap(tester, find.byKey(const ValueKey('sticker-upload-approve')));
    await settle(tester);
    expect(uploadBody?['mime'], 'image/png');
    expect(uploadBody?['data'], base64Encode(png));
    expect(patches.single['body'], {'status': 'approved'});
    expect(items.single['status'], 'approved');
  });

  testWidgets('删除确认：未确认前不发请求，确认后带 X-Confirm 移入已拒绝', (tester) async {
    items = [entry('one', 'approved', ['开心'])];
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-delete-one')));
    await tester.pump();
    expect(find.text('确认删除这张贴纸？'), findsOneWidget);
    expect(lastConfirm, isNull);
    await tap(tester, find.byKey(const ValueKey('sticker-delete-confirm')));
    await settle(tester);
    expect(lastConfirm, 'sticker-delete');
    expect(items.single['status'], 'rejected');
  });

  testWidgets('空态：没有图时说明出路，不伪造九标签空分区', (tester) async {
    await pumpPanel(tester);
    expect(find.text('还没有贴纸'), findsOneWidget);
    expect(find.textContaining('先上传一张图'), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-upload')), findsOneWidget);
    expect(find.text('开心 0'), findsNothing);
  });

  testWidgets('错误态：坏索引不冒充空库，重试后回到真空态', (tester) async {
    await pumpPanel(tester, initial: {'bad': true});
    expect(find.textContaining('贴纸索引读不出来'), findsOneWidget);
    expect(find.text('还没有贴纸'), findsNothing);
    await tap(tester, find.text('重试'));
    await settle(tester);
    expect(find.text('还没有贴纸'), findsOneWidget);
  });

  testWidgets('设置：三个开关分别写配置，采收专用命令不冒充已生效', (tester) async {
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-3')));
    await tap(tester, find.byKey(const ValueKey('sticker-enabled')));
    await settle(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-harvest-enabled')));
    await settle(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tagging-enabled')));
    await settle(tester);
    expect(writes[0]['confirm'], 'config-update');
    expect(writes[0]['body'], {'fields': {'stickers.enabled': false}});
    expect(writes[1]['body'], {'enabled': false});
    expect(writes[2]['body'], {'fields': {'stickers.tagging.enabled': false}});
    expect(find.byKey(const ValueKey('sticker-harvest-probability')), findsOneWidget);
  });

  testWidgets('设置：两个新控件渲染，缺字段时回默认 100% / 0', (tester) async {
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-3')));
    await tester.pump();
    expect(find.byKey(const ValueKey('sticker-active-probability')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-cooldown-seconds')), findsOneWidget);
    expect(find.text('允许发送频率 100%'), findsOneWidget);
    expect(find.text('熔断间隔（秒）'), findsOneWidget);
    expect(
      tester.widget<TextField>(find.byKey(const ValueKey('sticker-cooldown-seconds'))).controller!.text,
      '0',
    );
  });

  testWidgets('设置：允许发送频率滑块改值后写 config-update', (tester) async {
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-3')));
    final finder = find.byKey(const ValueKey('sticker-active-probability'));
    final slider = tester.widget<Slider>(finder);
    slider.onChanged!(0.4);
    await tester.pump();
    expect(find.text('允许发送频率 40%'), findsOneWidget);
    expect(writes, isEmpty, reason: '拖动过程只改本地显示');
    slider.onChangeEnd!(0.4);
    await settle(tester);
    expect(writes.single['body'], {'fields': {'stickers.activeProbability': 0.4}});
    expect(writes.single['confirm'], 'config-update');
  });

  testWidgets('设置：熔断秒数提交才写，负数与非法值静默回退', (tester) async {
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-3')));
    final finder = find.byKey(const ValueKey('sticker-cooldown-seconds'));
    await tester.enterText(finder, '30');
    await tester.pump();
    expect(writes, isEmpty, reason: '键入过程不发请求');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await settle(tester);
    expect(writes.single['body'], {'fields': {'stickers.cooldownSeconds': 30}});
    expect(writes.single['confirm'], 'config-update');

    await tester.enterText(finder, '-5');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pump();
    expect(writes, hasLength(1), reason: '负数不写');
    expect(tester.widget<TextField>(finder).controller!.text, '30');
  });

  testWidgets('设置：窄窗下两个新控件不溢出', (tester) async {
    await pumpPanel(tester, height: 700, size: const Size(760, 800));
    await tap(tester, find.byKey(const ValueKey('sticker-tab-3')));
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('sticker-active-probability')), findsOneWidget);
    expect(find.byKey(const ValueKey('sticker-cooldown-seconds')), findsOneWidget);
  });

  testWidgets('事件：进入事件区才读取，发送与打标记录可复盘', (tester) async {
    await pumpPanel(tester);
    expect(find.text('sticker/sent'), findsNothing);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-4')));
    await settle(tester);
    expect(find.text('sticker/sent'), findsOneWidget);
    expect(find.text('sticker/tagged'), findsOneWidget);
    expect(find.textContaining('"stickerId":"one"'), findsNWidgets(2));
  });

  testWidgets('标签编辑与停用：标签保持 1–2 个，停用不是删除', (tester) async {
    items = [entry('one', 'approved', ['开心'])];
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tags-one')));
    await tester.pump();
    await tap(tester, find.widgetWithText(FilterChip, '亲近'));
    await tap(tester, find.byKey(const ValueKey('sticker-tags-confirm')));
    await settle(tester);
    expect(patches.first['body'], {'tags': ['开心', '亲近']});
    await tap(tester, find.byKey(const ValueKey('sticker-block-one')).first);
    await settle(tester);
    expect(patches.last['body'], {'status': 'blocked'});
    expect(items.single['status'], 'blocked');
  });

  testWidgets('真机冒烟：临时实例真实库存驱动的管理页与截图', (tester) async {
    final baseUrl = Platform.environment['IRMIA_SMOKE_BASE_URL']!;
    final token = Platform.environment['IRMIA_SMOKE_TOKEN']!;
    final liveState = AppState(api: IrmiaApi(baseUrl: baseUrl, token: token));
    addTearDown(liveState.dispose);
    final raw = await tester.runAsync(() => liveState.api.get('/api/stickers'));
    expect(validStickerView(raw), isTrue);
    final liveView = Map<String, dynamic>.from(raw as Map);
    expect((liveView['counts'] as Map)['approved'], 1);
    expect((liveView['counts'] as Map)['sentToday'], 1);
    tester.view.physicalSize = const Size(1280, 1100);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final font = FontLoader('SmokeCJK')
      ..addFont(Future.value(File('${Platform.environment['WINDIR'] ?? r'C:\Windows'}\\Fonts\\msyh.ttc').readAsBytesSync().buffer.asByteData()));
    await font.load();
    final baseTheme = IrmiaTheme.light();
    await tester.pumpWidget(MaterialApp(
      theme: baseTheme.copyWith(textTheme: baseTheme.textTheme.apply(fontFamily: 'SmokeCJK')),
      home: Scaffold(body: StickersPanel(state: liveState, view: liveView)),
    ));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    await tester.pump();
    expect(find.text('开心 1'), findsOneWidget);
    expect(find.textContaining('已入库 1'), findsOneWidget);
    expect(find.textContaining('今日发送 1'), findsOneWidget);
    await expectLater(find.byType(StickersPanel), matchesGoldenFile('../../tmp/sticker-smoke-panel.png'));
    await tester.pump(const Duration(milliseconds: 1));
  }, skip: Platform.environment['IRMIA_SMOKE_BASE_URL'] == null || Platform.environment['IRMIA_SMOKE_TOKEN'] == null);

  testWidgets('已拒绝彻底删除：独立确认与独立确认短语', (tester) async {
    items = [entry('one', 'rejected', ['开心'])];
    await pumpPanel(tester);
    await tap(tester, find.byKey(const ValueKey('sticker-tab-2')));
    await tap(tester, find.byKey(const ValueKey('sticker-purge-one')));
    await tester.pump();
    expect(find.textContaining('彻底删除后无法恢复'), findsOneWidget);
    await tap(tester, find.byKey(const ValueKey('sticker-delete-confirm')));
    await settle(tester);
    expect(lastConfirm, 'stickers-purge');
    expect(items, isEmpty);
  });
}
