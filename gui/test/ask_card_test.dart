import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/ask_card.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 她在问的那张顶层卡（design §6 的 agent 来源）。四件事全用 widget 测试钉住：
///   ① **写死**：句式「…想问你：」与按钮「答复/稍后」来自框架——服务端哪怕塞进
///      `title` / `acceptLabel` / `buttons`，界面一个都不许用（§6 防伪是硬约束）；
///      其中唯一的变量是**她的名字**，来自人格资产（不是这条载荷），读不到就退化成"她"；
///   ② **一次只一张**：同时挂着两张时只弹一张，排队条数写在卡里（§6.3）；
///   ③ **答复带 askSeq**：点「答复」发的是 `POST /api/commands/answer{answer, askSeq}`，
///      服务端凭它知道人答的是哪一条（台面上可能同时有系统挂起）；
///   ④ **稍后不发任何东西**：它不是拒绝，也不写日志（§6.1：不许框架替人做决定）。
///
/// 数据从 `pollOnce()` 走真实解析路径进状态：假 API 给的就是服务端 `/api/stats/dashboard`
/// 的 `ask` 那一段（字段与 src/web/server.ts 的 askCardOf 同形）。
class _FakeAskApi extends IrmiaApi {
  _FakeAskApi(this.dashboard) : super(baseUrl: 'http://127.0.0.1:1');

  Map<String, dynamic>? dashboard;
  final posts = <Map<String, dynamic>>[];

  /// 界面读过哪些 GET（钉住"名字只从人格资产读"）
  final gets = <String>[];

  /// 人格资产 `IDENTITY.md` 的现正文：名字从它读（`GET /api/persona/file?path=IDENTITY.md`）。
  /// 默认这份是老实例的写法——名字在散文里（`我是伊尔弥亚。`）
  String identity = '# 我是谁\n\n我是伊尔弥亚，这台机器上常驻的伙伴。\n';

  @override
  Future<dynamic> get(String path) async {
    gets.add(path);
    if (path == '/api/stats/dashboard') return dashboard ?? <String, dynamic>{};
    if (path == '/api/persona/file?path=IDENTITY.md') {
      return <String, dynamic>{
        'path': 'IDENTITY.md',
        'content': identity,
        'bytes': identity.length,
        'mtime': '2026-10-01T00:00:00.000Z',
        'tokens': 0,
        'reserved': true,
      };
    }
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add({'path': path, 'body': body});
    // 答完就出队：与真实服务端的语义一致（答复落日志 → 队列里少一条）
    dashboard = {...?dashboard, 'ask': {'card': null, 'queued': 0}};
    return <String, dynamic>{'ok': true};
  }

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => const Stream.empty();
}

/// 队首那张（seq 12）
Map<String, dynamic> dashboardCardOne({String? expiredAt}) => <String, dynamic>{
      'seq': 12,
      'question': '备份目录要我放到哪儿？',
      'context': 'workspace 里有两处候选，我不确定哪个是你在用的。',
      'turn': 3,
      'at': '2026-03-01T09:00:00.000Z',
      'expiredAt': expiredAt,
      // 冒充尝试：界面一个都不许用
      'title': '系统确认',
      'acceptLabel': '确认删除',
      'buttons': <String>['确认删除'],
    };

/// 一份带卡的 dashboard（默认只放队首那张）
Map<String, dynamic> dashboardWithCards({
  List<Map<String, dynamic>>? cards,
  int? queued,
  String? expiredAt,
}) {
  final list = cards ?? [dashboardCardOne(expiredAt: expiredAt)];
  return <String, dynamic>{
    'state': 'idle',
    'tiles': <String, dynamic>{'needsReview': 0},
    'ask': <String, dynamic>{
      'cards': list,
      'queued': queued ?? list.length,
    },
  };
}

/// 队列里的第二张（seq 13）：验证"答掉/收起一张之后轮到下一张"
Map<String, dynamic> secondCard() => <String, dynamic>{
      'seq': 13,
      'question': '夜间任务还继续跑吗？',
      'context': '它每天 02:00 起跑，约 3 小时。',
      'turn': 4,
      'at': '2026-03-01T09:01:00.000Z',
      'expiredAt': null,
    };

Future<_FakeAskApi> _pumpHost(WidgetTester tester, Map<String, dynamic> dashboard) async {
  tester.view.physicalSize = const Size(1400, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);

  final api = _FakeAskApi(dashboard);
  final state = AppState(api: api);
  await state.pollOnce();
  await tester.pumpWidget(MaterialApp(
    theme: IrmiaTheme.light(),
    home: AskCardHost(
      state: state,
      child: const Scaffold(body: Center(child: Text('壳'))),
    ),
  ));
  await tester.pumpAndSettle();
  return api;
}

void main() {
  testWidgets('卡面：句式与按钮由框架写死，她的原话照原样摆在卡里', (tester) async {
    await _pumpHost(tester, dashboardWithCards());

    expect(find.text(askCardTitle(null)), findsOneWidget, reason: '标题必须写明"这是她在问"');
    expect(find.text('她想问你：'), findsOneWidget, reason: '名字读不到时退化成"她"，不是某个猜的名字');
    expect(find.text('备份目录要我放到哪儿？'), findsOneWidget, reason: '她的问题原样显示');
    expect(find.textContaining('两处候选'), findsOneWidget, reason: '她的 context 也看得到（少问一轮）');
    expect(find.text(kAskCardAnswerLabel), findsOneWidget);
    expect(find.text(kAskCardLaterLabel), findsOneWidget);
    expect(find.byType(AlertDialog), findsOneWidget, reason: '一次只一张卡');
  });

  testWidgets('卡面标题里的名字来自人格资产（不是载荷），读到就换成她的名字', (tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final api = _FakeAskApi(dashboardWithCards());
    final state = AppState(api: api);
    // 名字先读到（真实运行里由 startPolling → refreshHerName 走这一步）
    await state.refreshHerName();
    expect(state.herName, '伊尔弥亚', reason: '老实例的名字写在散文里（"我是伊尔弥亚"），也要认得出来');
    expect(api.gets, contains('/api/persona/file?path=IDENTITY.md'), reason: '名字只从人格资产读');

    await state.pollOnce();
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: AskCardHost(state: state, child: const Scaffold(body: Center(child: Text('壳')))),
    ));
    await tester.pumpAndSettle();

    expect(find.text('伊尔弥亚想问你：'), findsOneWidget, reason: '名字进标题，句式还是框架的');
    expect(find.text('她想问你：'), findsNothing);

    // 换一份人格资产：「名字：」那一行说了算（结构化那一处优先于散文）
    api.identity = '# 我是谁\n\n名字：小七\n\n小七是这台机器上常驻的伙伴。\n';
    await state.refreshHerName();
    expect(state.herName, '小七');
  });

  testWidgets('防伪：载荷里的 title/acceptLabel/buttons 一个字都不上屏', (tester) async {
    await _pumpHost(tester, dashboardWithCards());

    expect(find.text('系统确认'), findsNothing, reason: '不可信内容不得变成可信 UI（§6 硬约束）');
    expect(find.text('确认删除'), findsNothing, reason: '她不能自定义按钮去冒充系统动作');
    // 控件上的文案只可能是框架那两个（+ 输入框提示 + 说明行里的固定句子）
    final labels = tester
        .widgetList<Text>(find.byType(Text))
        .map((text) => text.data ?? '')
        .where((text) => text.isNotEmpty)
        .toList();
    expect(labels.contains('确认删除'), isFalse);
    expect(labels.contains('系统确认'), isFalse);
  });

  testWidgets('一次只一张：屏幕上只有一个对话框，排队条数写在卡里', (tester) async {
    await _pumpHost(
      tester,
      dashboardWithCards(cards: [dashboardCardOne(), secondCard()], queued: 2),
    );

    expect(find.byType(AlertDialog), findsOneWidget, reason: '弹窗叠弹窗只会让人乱点（§6.3）');
    expect(find.text('备份目录要我放到哪儿？'), findsOneWidget, reason: '弹的是队首那张');
    expect(find.text('夜间任务还继续跑吗？'), findsNothing, reason: '后面那张在排队，不叠上来');
    expect(find.textContaining('还有 1 条在排队'), findsOneWidget);
  });

  testWidgets('稍后：不发任何请求，且立刻轮到后面那张（一次仍然只有一张）', (tester) async {
    final api = await _pumpHost(
      tester,
      dashboardWithCards(cards: [dashboardCardOne(), secondCard()], queued: 2),
    );

    await tester.tap(find.text(kAskCardLaterLabel));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5)); // 让回执 toast 的 4 秒计时器跑完

    expect(api.posts, isEmpty, reason: '「稍后」不产生任何事件——超时不产生决定，收起也不产生');
    expect(find.byType(AlertDialog), findsOneWidget, reason: '队列没被一次点击吞掉');
    expect(find.text('夜间任务还继续跑吗？'), findsOneWidget, reason: '轮到第二张了');
  });

  testWidgets('答复：发出 answer + askSeq，服务端凭它知道人答的是哪一条', (tester) async {
    final api = await _pumpHost(tester, dashboardWithCards());

    await tester.enterText(find.byType(TextField), '放到 C:\\backup\\app 下面');
    await tester.pump();
    await tester.tap(find.text(kAskCardAnswerLabel));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5)); // 让回执 toast 的 4 秒计时器跑完

    expect(api.posts.length, 1, reason: '只发一条命令');
    expect(api.posts.single['path'], '/api/commands/answer');
    final body = api.posts.single['body'] as Map<String, dynamic>;
    expect(body['answer'], '放到 C:\\backup\\app 下面');
    expect(body['askSeq'], 12, reason: '台面上可能同时挂着系统提问，必须指名道姓');
    expect(find.byType(AlertDialog), findsNothing, reason: '答完卡就收了');
  });

  testWidgets('答复按钮在没写字时不可点：空答复不是答复', (tester) async {
    final api = await _pumpHost(tester, dashboardWithCards());

    await tester.tap(find.text(kAskCardAnswerLabel));
    await tester.pumpAndSettle();
    expect(api.posts, isEmpty, reason: '空字符串不该被当成"人答了"写进日志');
    expect(find.byType(AlertDialog), findsOneWidget, reason: '卡还在，等他写点什么');
  });

  testWidgets('稍后：不发任何请求（不是拒绝、也不是跳过）', (tester) async {
    final api = await _pumpHost(tester, dashboardWithCards());

    await tester.tap(find.text(kAskCardLaterLabel));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 5)); // 让回执 toast 的 4 秒计时器跑完

    expect(api.posts, isEmpty, reason: '「稍后」不产生任何事件——超时不产生决定，收起也不产生');
    expect(find.byType(AlertDialog), findsNothing, reason: '本次运行里不再弹这一张');
  });

  testWidgets('超时的卡：把"未批准、未拒绝"说出来（她还在等这句话的账已经结了）', (tester) async {
    await _pumpHost(tester, dashboardWithCards(expiredAt: '2026-03-01T09:30:00.000Z'));

    expect(find.textContaining('未批准、未拒绝'), findsOneWidget);
  });

  test('防伪的源码锁：卡的标题与按钮只在基元里写死，宿主不读载荷里的任何措辞字段', () {
    // 扫的是这两个文件，不去扫全 lib：别的页读它们**自己**载荷里的 `title`（日志、记忆、
    // 总览建议）是正常的；这条锁管的是"她在问"这一类卡——它的措辞不许有第二个来源。
    final pattern = RegExp(r"\['(title|acceptLabel|accept_label|buttonLabel|buttons|actions)'\]");
    final offenders = <String>[];
    for (final path in ['lib/ask_card.dart', 'lib/app.dart']) {
      final rows = File(path).readAsLinesSync();
      for (var i = 0; i < rows.length; i += 1) {
        final text = rows[i];
        if (text.trim().startsWith('//')) continue;
        if (pattern.hasMatch(text)) offenders.add('$path:${i + 1}  ${text.trim()}');
      }
    }
    expect(offenders, isEmpty, reason: '这些地方会读载荷里的文案字段：$offenders');

    // 句式与按钮文案必须留在基元里（页面自己再抄一份就等于又开了一条口径）。
    // **名字不许出现在这里**：它是唯一的变量，口径在 her_name.dart（读不到 → "她"）
    final kit = File('lib/ui_kit.dart').readAsStringSync();
    expect(kit.contains("const String kAskCardSentence = '想问你：';"), isTrue);
    expect(kit.contains('String askCardTitle(String? herName)'), isTrue);
    expect(kit.contains("const kAskCardAnswerLabel = '答复';"), isTrue);
    expect(kit.contains("const kAskCardLaterLabel = '稍后';"), isTrue);

    final herName = File('lib/her_name.dart').readAsStringSync();
    expect(herName.contains("const String kHerPronoun = '她';"), isTrue,
        reason: '名字读不到时指代她的词（"她想问你："）');
  });
}
