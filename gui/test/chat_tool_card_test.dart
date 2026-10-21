import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/chat_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 聊天页那张**工具调用卡片**：**卡还是原来那张卡，只改了名字那一格**。
///
/// 用户的口径，两句一起读：
///   · 先：「对话流里面显示的那个工具调用卡片。要写出调用的是什么服务什么工具，明显点。」
///   · 再看过后：「不能复用原来 mcp 的卡片吗？就只改个显示的名字而已。」
/// ⇒ 版式一律回到改动之前（`_header` 原样、参数行原样、不额外收窄），**唯一差别**是
/// MCP 调用时卡头那个名字写成 `mcp/server/tool`（判据在 `chat_page.dart` 的 [_mcpToolLabel]）。
///
/// 这里钉住三件事：
///   ① MCP 调用 ⇒ 卡头**同时**有 server 名与 tool 名；
///   ② 参数坏 / 缺字段 / 不是 MCP ⇒ **回落成工具名**，不崩、不出现 `undefined`/`null`；
///   ③ 别的工具（`read_file`、`speak`…）与 MCP 的参数行 ⇒ 与改动之前逐字相同。
///
/// 用例里的载荷**照本机 data/events 里的真实事件抄**（seq 71475 / 71466 / 71099 那几条），
/// 不是编的：MCP 走内置的 `mcp` 入口工具，参数是 `{server, tool, args}`。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.history) : super(baseUrl: 'http://127.0.0.1:1');

  final List<Map<String, dynamic>> history;

  @override
  Future<dynamic> get(String path) async {
    if (path.startsWith('/api/events')) {
      final uri = Uri.parse('http://x$path');
      final limit = int.tryParse(uri.queryParameters['limit'] ?? '') ?? 200;
      final fromRaw = uri.queryParameters['from_seq'];
      final sorted = [...history]..sort((a, b) => (a['seq'] as num).compareTo(b['seq'] as num));
      final events = fromRaw == null
          ? (sorted.length <= limit ? sorted : sorted.sublist(sorted.length - limit))
          : sorted.where((e) => (e['seq'] as num) >= int.parse(fromRaw)).take(limit).toList();
      return {'events': events};
    }
    if (path == '/api/sessions') return {'contacts': const <String, dynamic>{}};
    return {'ok': true};
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async =>
      {'ok': true};

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => const Stream.empty();
}

Map<String, dynamic> evt(int seq, String type, Map<String, dynamic> data) => {
      'seq': seq,
      'ts': '2026-10-09T17:55:0$seq.000Z',
      'type': type,
      'data': data,
    };

/// 一次工具调用 + 它的回执（两条事件，界面上是**同一个块**）。
///
/// [seq] 是这对事件的头一个 seq：**同一个流里的 seq 必须各不相同**，否则第二条会被
/// 当成"见过的那一条"跳过（去重按 seq，见 `_ChatPageState._consume`）。
List<Map<String, dynamic>> callPair({
  required String callId,
  required String name,
  required String args,
  String content = '好',
  int seq = 1,
}) =>
    [
      evt(seq, 'tool/call', {
        'turn': 1, 'step': 0, 'callId': callId, 'name': name,
        'arguments': args, 'sideEffect': 'none',
      }),
      evt(seq + 1, 'tool/result', {
        'turn': 1, 'step': 0, 'callId': callId, 'callSeq': seq, 'status': 'ok',
        'content': content, 'durationMs': 12,
      }),
    ];

/// 卡头那个名字：**按屏幕上真渲染出来的文字找**（卡上没有专门的测试定位件——
/// 版式与改动之前逐字相同，名字也就是原来那一枚 `Text`）。
bool hasName(WidgetTester tester, String label) => find.text(label).evaluate().isNotEmpty;

/// 卡上所有 `Text` 的原文。用来把断言**指到名字那一格**上：卡片下面那行参数摘要
/// 是原样渲染 JSON 的（`server=null   tool=null` 这种字面量在改动之前就有，
/// 这里不去改它，也不该拿它当"卡上出现了 null"的证据）。
List<String> textsOnScreen(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((t) => t.data ?? '')
    .where((s) => s.trim().isNotEmpty)
    .toList();

/// 名字那一格：MCP 调用时**只有它**含 `mcp/`
String nameCell(WidgetTester tester) =>
    textsOnScreen(tester).firstWhere((t) => t.contains('mcp/') || t.trim() == 'mcp',
        orElse: () => '');

void main() {
  setUpAll(() {
    stateFileOverride =
        '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-tool-card-test.json';
  });

  /// 每次进页面都给一个新的 Key：同一个测试里连着进两次页面时，
  /// 没有 key 的话 Flutter 会把新树认成"老页面的重建"，`items` 里上一条用例的痕迹还在
  /// （实测：第二次进去卡头还是上一次那个工具名）。
  var pages = 0;

  Future<void> pumpChat(WidgetTester tester, List<Map<String, dynamic>> history) async {
    // 高一点：块多的时候别让它们滚出视口——这是渲染断言，不是滚动断言
    tester.view.physicalSize = const Size(1200, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = AppState(api: _FakeApi(history));
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ChatPage(key: ValueKey('chat-page-${pages++}'), state: state)),
    ));
    await tester.pump();
    await tester.pumpAndSettle();
  }

  /// 主用例：真数据（seq 71475，`obscura` / `browser_navigate`）
  const String realMcpArgs =
      '{"server": "obscura", "tool": "browser_navigate", "args": {"url": "https://example.com/"}}';

  testWidgets('MCP 调用：名字那一格同时写 server 与 tool，卡片其余部分照旧', (tester) async {
    await pumpChat(
      tester,
      callPair(callId: 'c1', name: 'mcp', args: realMcpArgs, content: 'Navigated to example.com'),
    );

    // ① 服务名与工具名同时在卡上
    expect(hasName(tester, 'mcp/obscura/browser_navigate'), isTrue,
        reason: '一眼看出"哪个服务、哪个工具"——只有 mcp 一个词是不够的');
    expect(nameCell(tester), 'mcp/obscura/browser_navigate');
    // ② 卡片其余部分**与改动之前逐字相同**：参数行还是原来那条 key=value 摘要
    //    （没有被收窄成"只剩被调工具的入参"——那是上一版多做的事，用户要的是复用原卡）
    expect(find.textContaining('server=obscura'), findsOneWidget);
    expect(find.textContaining('tool=browser_navigate'), findsOneWidget);
    expect(find.textContaining('args={"url":"https://example.com/"}'), findsOneWidget,
        reason: 'MCP 的 args 那一格照旧原样展开进参数行');
    // ③ 结果行、状态、耗时照旧
    expect(find.textContaining('Navigated to example.com'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);
    expect(find.text('12ms'), findsOneWidget);
  });

  testWidgets('名字就是真事件抄来的那一条：mcp/obscura/browser_markdown', (tester) async {
    // seq 71482 的真实参数（键的顺序与 `args` 在前都不影响）
    await pumpChat(tester, callPair(
      callId: 'c1',
      name: 'mcp',
      args: '{"args": {"max_chars": 300}, "server": "obscura", "tool": "browser_markdown"}',
      content: '# Example Domain',
    ));

    expect(nameCell(tester), 'mcp/obscura/browser_markdown');
    expect(find.textContaining('server=obscura'), findsOneWidget, reason: '参数行照旧');
    expect(find.textContaining('max_chars'), findsOneWidget, reason: '参数行照旧（原样摆 JSON 那几格）');
  });

  testWidgets('调用与它的回执是同一个名字（回执没有第二张卡、也没有第二处拼法）', (tester) async {
    // 顺序反过来喂：先在屏上立那个块的是**回执**（`tool/result` 里没有 name，兜底成 tool），
    // 随后 `tool/call` 才到——往上翻历史时的真实情形。回填之后名字就是完整那一串。
    await pumpChat(tester, [
      evt(1, 'tool/result', {
        'turn': 1, 'step': 0, 'callId': 'c1', 'callSeq': 1, 'status': 'ok',
        'content': 'Navigated to example.com', 'durationMs': 12,
      }),
      evt(2, 'tool/call', {
        'turn': 1, 'step': 0, 'callId': 'c1', 'name': 'mcp',
        'arguments': realMcpArgs, 'sideEffect': 'none',
      }),
    ]);

    expect(hasName(tester, 'mcp/obscura/browser_navigate'), isTrue, reason: '同一个 callId 只该有一个块');
    expect(find.text('tool'), findsNothing, reason: '名字已经回填，兜底那个词不该还在');
  });

  testWidgets('MCP 看清单（只给 server、不给 tool）不拼半个名字：回落成工具名', (tester) async {
    // 真实事件 seq 71466：`{"server": "obscura"}` 是"看它有哪些工具"，不是一次调用
    await pumpChat(tester,
        callPair(callId: 'c1', name: 'mcp', args: '{"server": "obscura"}', content: '共 12 件'));

    expect(hasName(tester, 'mcp'), isTrue, reason: '缺 tool ⇒ 照旧显示工具名');
    expect(nameCell(tester), 'mcp', reason: '名字就是 `mcp` 这一个词，不是半个层级');
    expect(find.textContaining('mcp/'), findsNothing,
        reason: '半个层级（mcp/obscura）看着像一次完整的调用，不许摆出来');
    expect(find.textContaining('server=obscura'), findsOneWidget, reason: '它看了哪个 server 由参数行说');
  });

  // ────────────────────── 兜底：坏参数、缺字段、类型不对 ──────────────────────
  //
  // 每条都要求同一件事：**照旧显示工具名**，不报错、不出现 `undefined`/`null`。

  testWidgets('arguments 不是合法 JSON：回落成工具名，坏原文照旧能看，不崩', (tester) async {
    await pumpChat(tester,
        callPair(callId: 'c1', name: 'mcp', args: '{"server": "obscura", 这里断了', content: '好'));

    expect(hasName(tester, 'mcp'), isTrue);
    expect(find.textContaining('这里断了'), findsOneWidget, reason: '解不出 JSON 时照原样压平（原来就是这个行为）');
    expect(tester.takeException(), isNull);
  });

  testWidgets('缺字段 / 字段不是字符串：回落成工具名，名字上不出现 undefined 或 null', (tester) async {
    final cases = <String, String>{
      '只有 tool': '{"tool": "browser_navigate"}',
      'server 是数字': '{"server": 7, "tool": "browser_navigate"}',
      'server 是空串': '{"server": "  ", "tool": "browser_navigate"}',
      '字段是 null': '{"server": null, "tool": null}',
      '空对象': '{}',
      '空串': '',
      '是个数组': '[1, 2, 3]',
    };
    for (final entry in cases.entries) {
      await pumpChat(tester, callPair(callId: 'c1', name: 'mcp', args: entry.value, content: '好'));

      final cell = nameCell(tester);
      expect(hasName(tester, 'mcp'), isTrue, reason: '${entry.key} ⇒ 照旧显示工具名');
      expect(cell, 'mcp', reason: '${entry.key} ⇒ 名字就是 `mcp` 这一个词');
      expect(cell.contains('undefined'), isFalse, reason: '${entry.key} ⇒ 名字里不许有 undefined');
      expect(cell.contains('null'), isFalse, reason: '${entry.key} ⇒ 名字里不许有 null');
      expect(find.textContaining('mcp/'), findsNothing, reason: '${entry.key} ⇒ 不许拼半个名字');
      expect(tester.takeException(), isNull, reason: '${entry.key} ⇒ 不许崩');
    }
  });

  testWidgets('别的工具照旧：名字与参数行都与改动之前逐字相同', (tester) async {
    await pumpChat(tester, [
      ...callPair(callId: 'c1', name: 'read_file', args: '{"file_path": "main.log"}',
          content: '日志尾部', seq: 1),
      ...callPair(callId: 'c2', name: 'speak', args: '{"text": "在的"}', content: '已发送', seq: 3),
      ...callPair(callId: 'c3', name: 'pwsh', args: '{"command": "ls"}', content: '文件一', seq: 5),
    ]);

    expect(hasName(tester, 'read_file'), isTrue, reason: '非 MCP 工具名字不许多出任何层级');
    expect(hasName(tester, '<speak>'), isTrue, reason: 'speak 仍是标签形态');
    expect(hasName(tester, 'pwsh'), isTrue);
    // 参数摘要逐字照旧（`key=value`）
    expect(find.text('file_path=main.log'), findsOneWidget);
    expect(find.text('command=ls'), findsOneWidget);
    expect(find.textContaining('text=在的'), findsNothing,
        reason: 'speak 的内容马上要以气泡出现，块里不抄第二遍（这一条也没动）');
  });
}
