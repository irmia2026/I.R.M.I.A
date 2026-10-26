import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/mention_prompt.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 「她被怎么称呼」的四件事（文本提及唤醒的界面那一半）：
///   ① **该不该问**：没问过且名单空着才问（判据抽成纯函数，直接钉住）；
///   ② **卡面**：标题/按钮/说明都是框架写死的常量，返回值是切好的词表，取消 = null；
///   ③ **保存**：走那条专用命令（`POST /api/commands/set-mention-keywords`，body 是数组）；
///   ④ **值会变才写**：`mention-prompt-done` 已是 true 就不再每次启动重写（下面 group ④）。
///
/// 为什么不在 widget 层测"首次进界面会弹"：那条路要读状态文件、问 `/api/config`、再弹卡，
/// 全是真实异步（实测在 widget 测试里很脆）——判据与卡面分别钉住，接线的部分只剩几行。
/// 例外只有 ④：要数"到底写没写盘"，只能把宿主整个挂起来（那两条里卡本身不弹）。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  final posts = <Map<String, dynamic>>[];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async => <String, dynamic>{'ok': true};

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add({'path': path, 'body': body, 'confirm': confirm});
    return <String, dynamic>{'ok': true};
  }

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => const Stream.empty();
}

/// 让卡弹出来：一个按钮触发 [showMentionKeywordsCard]，返回值写进 [result]
Future<void> _pumpCard(
  WidgetTester tester,
  void Function(List<String>?) onResult, {
  List<String> initial = const [],
}) async {
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: Builder(
        builder: (context) => Center(
          child: TextButton(
            onPressed: () async => onResult(await showMentionKeywordsCard(context, initial: initial)),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() {
    // 状态文件指向临时文件：别踩真实 %APPDATA% 里的 ui-state.json
    final path = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-mention-test.json';
    stateFileOverride = path;
  });

  test('该不该问：没问过且名单空着才问', () {
    expect(shouldAskMentionKeywords(askedBefore: false, current: const []), isTrue);
    expect(shouldAskMentionKeywords(askedBefore: true, current: const []), isFalse, reason: '点过「以后再说」就不再问');
    expect(shouldAskMentionKeywords(askedBefore: false, current: const ['弥亚小姐']), isFalse, reason: '已经填过就不打扰');
    expect(shouldAskMentionKeywords(askedBefore: true, current: const ['弥亚小姐']), isFalse);
  });

  testWidgets('卡面：标题与按钮是框架常量，说明说清这几个词干什么用', (tester) async {
    await _pumpCard(tester, (_) {});
    expect(find.text(kMentionCardTitle), findsOneWidget);
    expect(find.text(kMentionCardSaveLabel), findsOneWidget);
    expect(find.text(kMentionCardLaterLabel), findsOneWidget);
    expect(find.text(kMentionCardNote), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('编辑已有名单：回填现值；保存回的是切好的词表', (tester) async {
    List<String>? got;
    await _pumpCard(tester, (value) => got = value, initial: const ['伊尔弥亚', '弥亚小姐']);
    expect(find.text('伊尔弥亚、弥亚小姐'), findsOneWidget, reason: '回填现值，改一个词不用重打一遍');

    await tester.enterText(find.byType(TextField), '伊尔弥亚、弥亚小姐, Irmia  伊尔弥亚');
    await tester.tap(find.text(kMentionCardSaveLabel));
    await tester.pumpAndSettle();
    expect(got, ['伊尔弥亚', '弥亚小姐', 'Irmia'], reason: '去重且保序');
    // 输入控制器是"退场之后再销毁"的（600ms，见 ui_kit 里那段注释）：把那个定时器走完，
    // 否则测试结束时会报"A Timer is still pending"
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets('取消：回 null（调用方据此一个字节都不写）', (tester) async {
    var called = false;
    List<String>? got;
    await _pumpCard(tester, (value) {
      called = true;
      got = value;
    });
    await tester.tap(find.text(kMentionCardLaterLabel));
    await tester.pumpAndSettle();
    expect(called, isTrue);
    expect(got, isNull);
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets('保存走 set-mention-keywords，body 是数组（与其它写配置的命令同一条纪律）', (tester) async {
    final api = _FakeApi();
    final state = AppState(api: api);
    final problem = await state.saveMentionKeywords(const ['弥亚小姐', 'Irmia']);
    expect(problem, isNull);
    expect(api.posts.single['path'], '/api/commands/set-mention-keywords');
    expect(api.posts.single['confirm'], 'set-mention-keywords');
    expect(api.posts.single['body']['keywords'], ['弥亚小姐', 'Irmia']);
  });

  test('词表切分与服务端同一口径：逗号/顿号/空白都是分隔符，去重且保序', () {
    expect(splitMentionKeywords('伊尔弥亚、弥亚小姐, Irmia'), ['伊尔弥亚', '弥亚小姐', 'Irmia']);
    expect(splitMentionKeywords('  伊尔弥亚   伊尔弥亚  '), ['伊尔弥亚']);
    expect(splitMentionKeywords(''), isEmpty);
    expect(splitMentionKeywords('、，  '), isEmpty);
  });

  /// ④ 2026-10-21：`mention-prompt-done` **值会变才写**。
  ///
  /// 从前那段是"每次启动都无条件 saveFlag(true)"：内容一个字节没变也写一次盘
  /// （实测 22:41:26 那次写盘就是这么来的，还会刷新 mtime、把状态文件搅得像是刚改过）。
  /// 这里用原子写的注入点**数写次数**，再对一眼 mtime——两条判据都指向"真的没写"。
  group('④ 已经是 true 就不再重写（值会变才写）', () {
    late Directory tmpDir;
    late String statePath;
    late int writes;

    setUp(() {
      tmpDir = Directory.systemTemp.createTempSync('irmia-mention-prompt-');
      statePath = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
      stateFileOverride = statePath;
      writes = 0;
      // 每次落盘都要经过原子写最后那一步：数它 = 数"写了几次盘"
      stateFileRenameOverride = (tmp, target) async {
        writes += 1;
        await tmp.rename(target.path);
      };
    });

    tearDown(() {
      stateFileRenameOverride = null;
      try {
        tmpDir.deleteSync(recursive: true);
      } catch (_) {
        // 清不掉临时目录不影响断言
      }
    });

    /// 把宿主挂起来，并把 `_maybeAsk` 那条真异步跑到"已经问完配置"为止。
    Future<_KeywordApi> pumpHost(WidgetTester tester) async {
      final api = _KeywordApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      await tester.pumpWidget(MaterialApp(
        home: MentionPromptHost(
          state: state,
          child: const Scaffold(body: Center(child: Text('壳'))),
        ),
      ));
      // 交替推进真实 I/O 与假时钟，直到它把 /api/config 读完（= 判据已经跑到）
      for (var i = 0; i < 40 && api.configGets == 0; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
        await tester.pump();
      }
      // 再给"要不要写那一次"几轮（saveFlag 是真文件 IO）
      for (var i = 0; i < 20; i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 5)));
        await tester.pump();
      }
      return api;
    }

    testWidgets('盘上已是 true ⇒ 零写入，mtime 都不动', (tester) async {
      File(statePath).writeAsStringSync(jsonEncode({'mention-prompt-done': true}));
      final before = File(statePath).lastModifiedSync();
      final beforeBytes = File(statePath).readAsStringSync();

      final api = await pumpHost(tester);

      expect(api.configGets, 1, reason: '判据确实跑到了（不是靠"没来得及"混过去）');
      expect(find.text(kMentionCardTitle), findsNothing, reason: '问过就不再打扰');
      expect(writes, 0, reason: '盘上已经是 true：每次启动都重写的那一笔到此为止');
      expect(File(statePath).lastModifiedSync(), before, reason: '没写 ⇒ mtime 也不该动');
      expect(File(statePath).readAsStringSync(), beforeBytes);
    });

    testWidgets('还是 false 且词表非空 ⇒ 补记一次（值会变才写，恰好一次）', (tester) async {
      File(statePath).writeAsStringSync(jsonEncode({'mention-prompt-done': false}));

      await pumpHost(tester);

      expect(writes, 1, reason: '值从 false 变 true：这一次必须写，而且只写一次');
      expect(
        (await tester.runAsync(() => loadFlag('mention-prompt-done'))) ?? false,
        isTrue,
        reason: '写进去的是"问过了"，下次启动才不会重写',
      );
      expect(jsonDecode(File(statePath).readAsStringSync())['mention-prompt-done'], isTrue);
    });
  });
}

/// 词表非空的假服务：`_maybeAsk` 只有读到"已经有词表"才会走"补记一次就闭嘴"那条分支。
class _KeywordApi extends IrmiaApi {
  _KeywordApi() : super(baseUrl: 'http://127.0.0.1:1');

  int configGets = 0;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/config') {
      configGets += 1;
      return <String, dynamic>{
        'channels': {
          'mentionKeywords': <String>['弥亚小姐'],
        },
      };
    }
    return null;
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async =>
      <String, dynamic>{'ok': true};

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => const Stream.empty();
}
