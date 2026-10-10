import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// MCP 与 Hooks 两个页签的空态（用户 ⑰：空态与它下面那张解释卡"太不协调太丑"）。
///
/// 这三条锁钉的是**形态**，不是文案：
///   ① 空态里不再有那枚与页头重复的按钮——页头那枚现在是唯一入口（「消息适配器」页同一条规矩）；
///   ② 空态与"有内容时的卡片"**同一个矩形**（同左沿、同右沿、同顶边）：空态收成了卡内一行，
///      不再是封在 560 宽里、图标 + 居中文字 + 按钮的一大块；
///   ③ 底部那条「从这里开始」并进了空态（不再两块摞着），有内容时它照旧在。
///
/// 写这一组之前先确认过新形态是对的（真机截图 + 与同页「技能」页签有内容时的版式对照），
/// 不是把断言改绿——所以这里断言的是"空态落在哪张卡里、和谁同宽"，不是"有没有某句话"。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  /// 记下发出去的写命令（2026-10-11 加：待批那一段的批准/驳回要验"发了什么"）
  final posts = <Map<String, dynamic>>[];

  @override
  Future<dynamic> get(String path) async => routes[path];

  /// 写命令的替身：**不发网络**，只记一笔并按 `postReplies` 回一份回执。
  ///
  /// 为什么要它：批准/驳回这条路的两处分寸都在**发出去的 body** 上（批准不带 reason、
  /// 驳回带、留空也照发），而那件事只有"把这次请求记下来"才验得了。
  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add({'path': path, ...body});
    return postReplies[path] ?? {'ok': true};
  }

  final postReplies = <String, dynamic>{};
}

void main() {
  // 本机忽略标记会落 ui_state：测试指向临时文件，别踩真实 %APPDATA% 里的状态
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-empty-test.json';
  });

  final skills = <String, dynamic>{
    'items': <dynamic>[],
    'rejected': <dynamic>[],
    'catalogTokens': 0,
    'ignored': <dynamic>[],
  };
  final tools = <String, dynamic>{'groups': <dynamic>[], 'tools': <dynamic>[]};

  /// 申请单那一屏（2026-10-11：`mcp` 页签读两个端点，第二个就是它）。
  /// 默认**一张申请单都没有**——绝大多数用例验的是"服务卡长什么样"，与待批无关。
  final grantsEmpty = <String, dynamic>{'items': <dynamic>[], 'open': 0};

  /// 一张**待批**的申请单（她递的、还没人点）：判据与字段来源见 `GET /api/grants`。
  final grantsPending = <String, dynamic>{
    'items': [
      {
        'id': 'g-1',
        'kind': 'mcp-add',
        'name': 'obscura',
        'desc': '读本机浏览器历史与当前标签页',
        'command': 'node',
        'args': ['C:\\nowhere\\obscura.js'],
        'envKeys': <dynamic>[],
        'reason': '想用它看本机浏览器里开着什么',
        'question': '批准加一个 MCP server「obscura」？',
        'context': '它会做什么：读本机浏览器历史与当前标签页\n不点会怎样：超时只落一条「未批准、未拒绝」的事实。',
        'askSeq': 7,
        'expiredAt': null,
        'requestedAt': '2026-02-14T02:00:00.000Z',
        'outcome': null,
        'outcomeAt': null,
        'rejectReason': null,
        'exec': null,
        'picked': true,
      },
    ],
    'open': 1,
  };

  /// 一张**已驳回**的申请单（回看那一段的素材：驳回理由要看得见）
  final grantsDone = <String, dynamic>{
    'items': [
      {
        ...(grantsPending['items'] as List).first as Map<String, dynamic>,
        'outcome': 'rejected',
        'outcomeAt': '2026-02-14T02:30:00.000Z',
        'rejectReason': '它会读我的浏览记录，我不想让它常驻',
        'exec': {'state': 'not-applicable'},
      },
    ],
    'open': 0,
  };

  final mcpEmpty = <String, dynamic>{
    'servers': <dynamic>[],
    'problems': <dynamic>[],
    'registeredCount': 0,
    'runningCount': 0,
  };
  final mcpOne = <String, dynamic>{
    'servers': [
      {
        'name': 'filesystem',
        'command': 'npx',
        'args': ['-y', '@modelcontextprotocol/server-filesystem'],
        'env': <String, dynamic>{},
        'disabled': false,
        'state': 'never-started',
        'toolsCount': 0,
        'registeredTools': <dynamic>[],
        'toolDetails': <dynamic>[],
        // v48：那一句"它是干什么的"与它的来源（声明 = `config`）
        'desc': '按目录读写本机文件',
        'descFrom': 'config',
      },
    ],
    'problems': <dynamic>[],
    'registeredCount': 0,
    'runningCount': 0,
  };

  /// 同一个服务，但配置里**没写** desc（老配置的样子 ⇒ 索引里只有名字）
  final mcpNoDesc = <String, dynamic>{
    'servers': [
      {
        ...(mcpOne['servers'] as List).first as Map<String, dynamic>,
        'desc': '',
        'descFrom': 'absent',
      },
    ],
    'problems': <dynamic>[],
    'registeredCount': 0,
    'runningCount': 0,
  };

  final hooksEmpty = <String, dynamic>{
    'entries': <dynamic>[],
    'problems': <dynamic>[],
    'relative': 'data/hooks.json',
    'hookPoints': ['PreToolUse', 'PostToolUse', 'Wake'],
    'defaultTimeoutMs': 10000,
    'enabledCount': 0,
    'disabledCount': 0,
  };
  final hooksOne = <String, dynamic>{
    ...hooksEmpty,
    'entries': [
      {
        'index': 0,
        'hook': 'PreToolUse',
        'matcher': 'pwsh',
        'command': 'node check.mjs',
        'timeoutMs': 10000,
        'enabled': true,
      },
    ],
    'enabledCount': 1,
  };

  /// 开一页扩展页并切到指定页签。宽窗（1400）：左列表与右详情同屏，点行只是换详情。
  Future<_FakeApi> pumpTab(
    WidgetTester tester, {
    required Map<String, dynamic> mcp,
    required Map<String, dynamic> hooks,
    required String tab,
    Map<String, dynamic>? grants,
  }) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final api = _FakeApi({
      '/api/skills': skills,
      '/api/mcp': mcp,
      '/api/tools': tools,
      '/api/hooks': hooks,
      // `mcp` 这一屏读两个端点（第二个是她的申请单）：不给它，页面会走一次 null 响应
      // 并把 `grants` 那一段当"读失败"（实测：整页 7 条用例一起红）
      '/api/grants': grants ?? grantsEmpty,
    });
    final state = AppState(api: api);
    // 先前卸掉上一棵树，再开这一页。同一个用例里连着开两页做"空态 ⟷ 有内容"的对照时，
    // 直接二次 `pumpWidget` 只是把新的 AppState 交给**原来那个** State——元素按类型原地复用，
    // `initState` 不再跑，页面就拿着上一份数据装作已经加载完了（第 3、4 条曾因此红）。
    // 卸掉才是注释里那句"开一页"，与 `shell_layout_test.dart` 的"重建壳 = 重启"同一招。
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(ValueKey('ext-item-$tab')));
    await tester.pump();
    return api;
  }

  /// 页头那枚「钩子条目」卡（空态与有内容时都是它）——按标题文字找它最近的 Container：
  /// 标题与这张卡之间没有别的 Container，所以 `.first` 就是卡片本身。
  Finder hooksCard() =>
      find.ancestor(of: find.text('钩子条目'), matching: find.byType(Container)).first;

  /// 卡里不许再长按钮：按钮是页头的事（`ButtonStyleButton` 用谓词匹配，`byType` 不认子类）
  final anyButton = find.byWidgetPredicate((widget) => widget is ButtonStyleButton);

  /// 页头那枚实心按钮：按**子类**找，因为页头是 `FilledButton.icon` 建的——它的运行时类型是
  /// `_FilledButtonWithIcon extends FilledButton`，而 `find.byType` 只认精确类型，
  /// `find.widgetWithText(FilledButton, …)` 在这儿一枚都找不到（就是上面 `anyButton` 那条注释说的事）。
  /// 要钉的语义不变：屏幕上那一处文字，落在一枚实心按钮里。
  Finder filledWith(String text) =>
      find.ancestor(of: find.text(text), matching: find.bySubtype<FilledButton>());

  testWidgets('MCP 空态：一张卡里一行现状 + 解释，页头那枚是唯一入口', (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp');

    final empty = find.byKey(const ValueKey('mcp-empty'));
    expect(empty, findsOneWidget, reason: '空态是一张卡（与服务卡同壳），不是跟卡片不同宽的一大块');

    // 页头那枚在，且是那个动作在这一屏上的唯一一枚
    expect(find.text('添加服务'), findsOneWidget, reason: '页头那枚按钮是唯一入口');
    expect(filledWith('添加服务'), findsOneWidget);
    expect(find.descendant(of: empty, matching: anyButton), findsNothing,
        reason: '空态自己再长一枚按钮，就是用户圈出来的"同一个动作一屏两次"');
    expect(find.descendant(of: empty, matching: find.text('添加服务')), findsNothing,
        reason: '空态里不再出现那枚按钮的文字');

    // 那一大块居中提示整块撤掉（不是缩小、不是改文案）
    expect(find.byType(StateBlock), findsNothing);
    expect(find.byType(HintLine), findsNWidgets(3), reason: '现状一行 + 并进来的两句解释');

    // 现状与解释在**同一张卡**里，且解释确实落在卡片矩形之内
    final cardRect = tester.getRect(empty);
    expect(find.descendant(of: empty, matching: find.textContaining('还没有配置 MCP 服务')), findsOneWidget);
    for (final line in ['还没有配置 MCP 服务', '按需拉起', '按 destructive 处理']) {
      // 限定在卡内找（上一行就是这么写的）：页头那行分区简介里也有"按需拉起"这四个字，
      // 同一屏两处，不限定范围会一次命中两个，`getRect` 当场抛 ambiguous。
      // 要钉的语义没变——这一句落在卡片矩形之内，没跑到卡外去。
      final lineRect = tester.getRect(find.descendant(of: empty, matching: find.textContaining(line)));
      expect(cardRect.contains(lineRect.center), isTrue, reason: '「$line」不该跑到卡外去');
    }
    expect(find.text('从这里开始'), findsNothing, reason: '解释并进来了，就不再单独摞一条引导卡');
    expect(tester.takeException(), isNull);
  });

  testWidgets('Hooks 空态：还是「钩子条目」那张卡，卡里一行提示，页头那枚是唯一入口', (tester) async {
    await pumpTab(tester, mcp: mcpOne, hooks: hooksEmpty, tab: 'hooks');

    expect(find.text('钩子条目'), findsOneWidget, reason: '空态用的就是有内容时那张卡（连标题都不变）');
    final card = hooksCard();
    expect(find.text('添加钩子'), findsOneWidget, reason: '页头那枚按钮是唯一入口');
    expect(filledWith('添加钩子'), findsOneWidget);
    expect(find.descendant(of: card, matching: anyButton), findsNothing);
    expect(find.descendant(of: card, matching: find.text('添加钩子')), findsNothing);

    expect(find.byType(StateBlock), findsNothing);
    expect(find.byType(HintLine), findsOneWidget);

    // 现状与"钩子能做什么"这一句解释同处一行（原在底部「从这里开始」里）
    final line = find.textContaining('还没有配置钩子');
    expect(find.descendant(of: card, matching: line), findsOneWidget);
    expect(find.descendant(of: card, matching: find.textContaining('拒绝工具调用')), findsOneWidget);
    expect(tester.getRect(card).contains(tester.getRect(line).center), isTrue);
    expect(find.text('从这里开始'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('空态与"有内容时的卡片"同左沿、同右沿、同顶边（两个页签各比一次）', (tester) async {
    // MCP：空态 ⟷ 第一张服务卡（服务卡与空态共用一个外壳，矩形该一模一样）
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp');
    final mcpEmptyRect = tester.getRect(find.byKey(const ValueKey('mcp-empty')));
    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'mcp');
    final mcpCardRect = tester.getRect(find.byKey(const ValueKey('mcp-filesystem')));
    expect(mcpEmptyRect.left, closeTo(mcpCardRect.left, 0.5));
    expect(mcpEmptyRect.right, closeTo(mcpCardRect.right, 0.5));
    expect(mcpEmptyRect.width, closeTo(mcpCardRect.width, 0.5));
    expect(mcpEmptyRect.top, closeTo(mcpCardRect.top, 0.5), reason: '都从摘要行下面那条线开始，不是垂直居中悬浮');

    // Hooks：空态 ⟷ 有条目时那张卡（同一个标题、同一个矩形）
    await pumpTab(tester, mcp: mcpOne, hooks: hooksEmpty, tab: 'hooks');
    final hooksEmptyRect = tester.getRect(hooksCard());
    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'hooks');
    final hooksFilledRect = tester.getRect(hooksCard());
    expect(hooksEmptyRect.left, closeTo(hooksFilledRect.left, 0.5));
    expect(hooksEmptyRect.right, closeTo(hooksFilledRect.right, 0.5));
    expect(hooksEmptyRect.width, closeTo(hooksFilledRect.width, 0.5));
    expect(hooksEmptyRect.top, closeTo(hooksFilledRect.top, 0.5));

    // 两个页签的空态同左沿同宽：四个页签的第一个方块落在同一条线上
    expect(mcpEmptyRect.left, closeTo(hooksEmptyRect.left, 0.5));
    expect(mcpEmptyRect.right, closeTo(hooksEmptyRect.right, 0.5));
    expect(tester.takeException(), isNull);
  });

  testWidgets('有内容时底部那条「从这里开始」照旧（空态只是把它并进去了，没删）', (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'hooks');
    expect(find.byKey(const ValueKey('hook-0')), findsOneWidget);
    expect(find.text('从这里开始'), findsOneWidget, reason: '有内容时引导条照旧摆在最下面');

    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'mcp');
    expect(find.text('从这里开始'), findsOneWidget);
    expect(find.byKey(const ValueKey('mcp-filesystem')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // ── MCP 卡片：server → 工具名（用户 2026-10-10："mcp 卡片要显示 server 和工具名称"） ──
  //
  // 这一组钉的是**层级与如实**，不是文案：
  //   ① 工具名列在服务名下面（缩进一层），名字与描述都在，描述过长有可见的截断标记；
  //   ② 清单是**哪一刻的**必须写在卡片上——服务空闲 5 分钟就回收，不写时刻就是把旧答案当新答案；
  //   ③ 四种空各说各的（拉过是空的 / 已停用 / 从未启动 / 记录不完整），不许都写成"0 件"；
  //   ④ 界面与主进程是两个可执行文件：后端还是上一版（没有 `toolList` 那几格）时，
  //      卡片照旧列得出名字——按 `toolDetails` 回退。

  /// 新后端那一份 server 形状（`toolList` / `toolsFrom` / `toolsListAt` / `toolsQuery` / `toolsAgeMs`）
  Map<String, dynamic> mcpServer(
    String name, {
    required String state,
    bool disabled = false,
    List<Map<String, dynamic>> tools = const [],
    String from = 'none',
    String listAt = '',
    String query = '',
    int? ageMs,
    String stopReason = '',
    int declaredCount = 0,
  }) =>
      {
        'name': name,
        'command': 'node',
        'args': ['server.mjs'],
        'env': <String, dynamic>{},
        'disabled': disabled,
        'state': disabled ? 'disabled' : state,
        'stopReason': stopReason,
        'toolsCount': declaredCount,
        'registeredTools': [for (final tool in tools) 'mcp__${name}__${tool['name']}'],
        'toolDetails': tools,
        'toolList': tools,
        'toolsFrom': from,
        'toolsListAt': listAt,
        'toolsQuery': query,
        'toolsAgeMs': ageMs,
        'runningNow': state == 'started',
      };

  /// 展开一张服务卡（点标题行那枚展开箭头）
  Future<void> expandCard(WidgetTester tester, String name) async {
    await tester.tap(find.byTooltip('展开这个服务'));
    await tester.pump();
    expect(find.byKey(ValueKey('mcp-$name-tools')), findsOneWidget);
  }

  testWidgets('MCP 卡片：工具名列在服务名下（缩进一层），描述过长有可见的截断标记', (tester) async {
    final long = 'Get the current page content as text ${'x' * 200}';
    final one = <String, dynamic>{
      'servers': [
        mcpServer('obscura',
            state: 'started',
            from: 'live',
            listAt: '2026-10-09T17:55:40.728Z',
            query: 'ok',
            ageMs: 0,
            declaredCount: 2,
            tools: [
              {'name': 'browser_navigate', 'fullName': 'mcp__obscura__browser_navigate', 'description': '打开一个地址并等它加载完'},
              {'name': 'browser_snapshot', 'fullName': 'mcp__obscura__browser_snapshot', 'description': long},
            ]),
      ],
      'problems': <dynamic>[],
      'registeredCount': 2,
      'runningCount': 1,
    };
    await pumpTab(tester, mcp: one, hooks: hooksOne, tab: 'mcp');
    await expandCard(tester, 'obscura');

    // 名字与描述都在（服务名那一行是卡片的标题，工具名在它下面）
    expect(find.text('browser_navigate'), findsOneWidget);
    expect(find.text('打开一个地址并等它加载完'), findsOneWidget);
    expect(find.byKey(const ValueKey('mcp-obscura-tool-browser_snapshot')), findsOneWidget);
    // 长描述被截断，且截断**看得见**（界面上有一个「…」，不是靠 hover）
    expect(find.textContaining('…'), findsWidgets);
    // 清单是哪个服务的：标题里带件数与取清单的时刻
    expect(find.textContaining('它提供的工具（2 件'), findsOneWidget);
    // 服务名做小标题、工具名在它下面缩进一层（层级：server → tool）
    final card = find.byKey(const ValueKey('mcp-obscura'));
    final nameX = tester.getTopLeft(find.text('browser_navigate')).dx;
    final serverX = tester.getTopLeft(find.textContaining('obscura  ·')).dx;
    expect(nameX, greaterThan(serverX), reason: '工具名要缩进在服务名右边——层级一眼看清');
    expect(tester.getTopLeft(find.text('打开一个地址并等它加载完')).dx, greaterThan(nameX),
        reason: '描述排在工具名右边（同一行的第二栏）');
    // 折叠态那行摘要也报件数（不必先展开才知道它有多少工具）
    expect(find.descendant(of: card, matching: find.textContaining('工具 2 件')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('MCP 卡片：回收之后仍列得出工具名，并如实说是哪一刻取的', (tester) async {
    final stale = <String, dynamic>{
      'servers': [
        mcpServer('obscura',
            state: 'stopped',
            stopReason: 'idle-reclaim',
            from: 'cached',
            listAt: '2026-10-09T17:55:40.728Z',
            query: 'ok',
            ageMs: 3 * 86400000,
            declaredCount: 1,
            tools: [
              {'name': 'browser_navigate', 'fullName': 'mcp__obscura__browser_navigate', 'description': '打开一个地址'},
            ]),
      ],
      'problems': <dynamic>[],
      'registeredCount': 1,
      'runningCount': 0,
    };
    await pumpTab(tester, mcp: stale, hooks: hooksOne, tab: 'mcp');

    // 折叠态就说得出"上一次运行时的工具 1 件 · 上次取于 …"
    expect(find.textContaining('上次运行时的工具 1 件'), findsOneWidget);
    await expandCard(tester, 'obscura');
    expect(find.text('browser_navigate'), findsOneWidget,
        reason: '服务回收了，但"它给过什么"不该跟着消失');
    expect(find.textContaining('这份清单已经放了 3 天'), findsOneWidget,
        reason: '清单可能过期这件事必须在界面上看得出来');
    expect(tester.takeException(), isNull);
  });

  testWidgets('MCP 卡片：四种空各说各的（别都写成「0 件」）', (tester) async {
    final cases = <String, Map<String, dynamic>>{
      // 起来过、握手过了，tools/list 回了空 ⇒ "它当前不提供工具"
      'empty': mcpServer('quiet', state: 'started', from: 'none', query: 'empty',
          listAt: '2026-10-09T17:55:40.728Z', ageMs: 0),
      // 停用：配置事实，清单也不会更新
      'disabled': mcpServer('off', state: 'never-started', disabled: true),
      // 从未启动过
      'never': mcpServer('cold', state: 'never-started'),
      // 起来了、但没有可读的清单记录（老日志的怪形状）
      'unknown': mcpServer('odd', state: 'started', from: 'none', query: 'unknown'),
    };
    final expectations = <String, String>{
      'empty': '这个服务当前不提供工具',
      'disabled': '已停用：工具清单不会更新',
      'never': '从未启动过，还没有工具清单',
      'unknown': '日志里没有可读的启动记录',
    };
    for (final entry in cases.entries) {
      final view = <String, dynamic>{
        'servers': [entry.value],
        'problems': <dynamic>[],
        'registeredCount': 0,
        'runningCount': entry.key == 'empty' || entry.key == 'unknown' ? 1 : 0,
      };
      await pumpTab(tester, mcp: view, hooks: hooksOne, tab: 'mcp');
      expect(find.textContaining(expectations[entry.key]!), findsOneWidget,
          reason: '「${entry.key}」这一种空要有自己那句如实的话');
      // 断言限定在这张卡里：页头那行「工具 0 件」数的是**此刻注册的**，它写 0 是对的
      // （服务没在跑、注册表里就没有它的工具）。要钉的是卡片里那句空态不许偷懒。
      final card = find.byKey(ValueKey('mcp-${entry.value['name']}'));
      expect(find.descendant(of: card, matching: find.textContaining('0 件')), findsNothing,
          reason: '四种不同的空不许都写成「0 件」——人正是靠这句话决定要不要点测试连接');
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('MCP 卡片：后端还是上一版（没有 toolList）时按 toolDetails 回退，照旧列得出名字', (tester) async {
    final legacy = <String, dynamic>{
      'servers': [
        {
          'name': 'demo',
          'command': 'node',
          'args': <dynamic>[],
          'env': <String, dynamic>{},
          'disabled': false,
          'state': 'started',
          // 老后端只给这三格
          'toolsCount': 1,
          'registeredTools': <dynamic>['mcp__demo__read'],
          'toolDetails': [
            {'name': 'read', 'fullName': 'mcp__demo__read', 'description': '读一个文件'},
          ],
        },
      ],
      'problems': <dynamic>[],
      'registeredCount': 1,
      'runningCount': 1,
    };
    await pumpTab(tester, mcp: legacy, hooks: hooksOne, tab: 'mcp');
    await expandCard(tester, 'demo');
    expect(find.text('read'), findsOneWidget);
    expect(find.text('读一个文件'), findsOneWidget, reason: '描述也要跟着老字段一起读出来');
    expect(find.textContaining('它提供的工具（1 件'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  // ──────────────────── 申请单（她发起 · 用户只做审批，2026-10-11） ────────────────────

  testWidgets('待批那一段：她递的申请单摆在服务卡**之前**，两枚按钮 + 那句"它是干什么的"',
      (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp', grants: grantsPending);

    final card = find.byKey(const ValueKey('grant-g-1'));
    expect(card, findsOneWidget, reason: '她递的单子必须在这一屏看得到（那是要人动手的事）');
    // 卡上的字**全部由界面写死**（design §6 防伪）：标题、按钮、那句说明都不是她的原话
    expect(find.descendant(of: card, matching: find.text('她想加一个 MCP 服务')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-approve-g-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-reject-g-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-reason-g-1')), findsOneWidget, reason: '驳回要能写理由');
    // 「它是干什么的」摆在卡上（用户这一轮抱怨的正是"审批时看不出它是干什么的"）
    expect(find.descendant(of: card, matching: find.text('读本机浏览器历史与当前标签页')), findsOneWidget);
    // 她的原话只有"她写的理由"那一行
    expect(find.descendant(of: card, matching: find.textContaining('她写的理由：')), findsOneWidget);

    // 待批排在服务卡之前：空态卡在它下面
    final pendingY = tester.getTopLeft(card).dy;
    final emptyY = tester.getTopLeft(find.byKey(const ValueKey('mcp-empty'))).dy;
    expect(pendingY, lessThan(emptyY), reason: '要人动手的事排在她自己的服务卡之前');
    expect(tester.takeException(), isNull);
  });

  testWidgets('驳回：理由随请求发出去；留空也照发（人不该被一个必填项挡住驳回）', (tester) async {
    final api = await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp', grants: grantsPending);

    // ① 写了理由
    await tester.enterText(find.byKey(const ValueKey('grant-reason-g-1')), '它会读我的浏览记录');
    await tester.tap(find.byKey(const ValueKey('grant-reject-g-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.length, 1, reason: '驳回就是一次写命令');
    expect(api.posts.first['path'], '/api/commands/grant-decide');
    expect(api.posts.first['id'], 'g-1');
    expect(api.posts.first['decision'], 'reject');
    expect(api.posts.first['reason'], '它会读我的浏览记录');

    // ② 留空：照发（服务端那边说的是"人驳回了，没有给理由"）
    await tester.enterText(find.byKey(const ValueKey('grant-reason-g-1')), '');
    await tester.tap(find.byKey(const ValueKey('grant-reject-g-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.length, 2);
    expect(api.posts[1]['reason'], '', reason: '留空也照发——不许拿"必填"挡住驳回');
    expect(tester.takeException(), isNull);
  });

  testWidgets('批准：**不带**理由（没有"批准理由"这回事）', (tester) async {
    final api = await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp', grants: grantsPending);
    await tester.enterText(find.byKey(const ValueKey('grant-reason-g-1')), '这段字不该跟着批准发出去');
    await tester.tap(find.byKey(const ValueKey('grant-approve-g-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.length, 1);
    expect(api.posts.first['decision'], 'approve');
    expect(api.posts.first.containsKey('reason'), isFalse,
        reason: '理由栏目只属于驳回；批准带理由会被服务端当场拒（400）');
    expect(tester.takeException(), isNull);
  });

  testWidgets('已答复那一段：批准/驳回与执行结果分得开（"批了但没装成"不许读成"装上了"）',
      (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp', grants: grantsDone);
    expect(find.byKey(const ValueKey('grant-done-g-1')), findsOneWidget);
    expect(find.text('已驳回'), findsOneWidget);
    expect(find.textContaining('驳回理由：它会读我的浏览记录'), findsOneWidget);
    // 待批那一段不该还在（那一条已经有结局了）
    expect(find.byKey(const ValueKey('grant-g-1')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  // ──────────────────── 那一句"它是干什么的"（v48） ────────────────────

  testWidgets('服务卡上摆出那句话：配了 desc 就原样，没配就**照实说**这一格是空的', (tester) async {
    await pumpTab(tester, mcp: mcpOne, hooks: hooksOne, tab: 'mcp');
    expect(find.text('按目录读写本机文件'), findsOneWidget,
        reason: '人在这里看到的应该就是她在索引里看到的那一句');

    await pumpTab(tester, mcp: mcpNoDesc, hooks: hooksOne, tab: 'mcp');
    expect(find.textContaining('没写它做什么'), findsOneWidget, reason: '照实说这一格是空的，不编一句');
    expect(find.textContaining('她在索引里只看到这个名字'), findsOneWidget,
        reason: '要让人知道**后果**，否则他不会去补这一格');
    expect(tester.takeException(), isNull);
  });

  testWidgets('添加服务那张表单有 desc 一格，且写明了"留空之后她在索引里只看到名字"', (tester) async {
    await pumpTab(tester, mcp: mcpEmpty, hooks: hooksOne, tab: 'mcp');
    await tester.tap(find.byKey(const ValueKey('mcp-add')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final field = find.byKey(const ValueKey('mcp-field-desc'));
    expect(field, findsOneWidget, reason: '人手工加时也要能填这一格（用户原话："或者人添加时直接填写 desc"）');
    expect(find.textContaining('留空也能保存'), findsOneWidget, reason: '留空要如实说后果，但不拦人');
  });
}
