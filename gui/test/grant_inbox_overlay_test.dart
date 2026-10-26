import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/grant_inbox_overlay.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 右下角**快速审批卡**的验收（用户 2026-10-21：「很多新手小白不知道在哪可以审批」）。
///
/// 五条正面要求（本文件的主体就是它们）：
///   ① 有待批 ⇒ 卡出现在**窗口右下角**（位置是断言，不是"看起来在"）；
///   ② **低风险**（`mcp-remove` / `skill-remove`）点「批准」⇒ **直接**调
///      `grant-decide`，不弹详情；
///   ③ **高风险**（`mcp-add` / `skill-install`）点按钮 ⇒ **一个字节都不发**，
///      先把详情那张完整卡打开（"查看并批准"这个名字就是那个承诺）；
///   ④ 超过三张 ⇒ 只摆最新三张 + 「还有 N 条待批」；
///   ⑤ 没有待批 ⇒ **什么都不画**（连细条都没有）。
///
/// 另外三条硬约束也在这一份里钉住：
///   · **不抢焦点**（⑥ 的第一条）；
///   · 15 秒后**收起成细条但不消失**，点细条还能展开（⑥ 的第二条）；
///   · 提交中有操作中态、失败**保留卡**并写出原因（⑥ 的第三条）。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  /// 发出去的写命令（验"点了到底发了什么、有没有发"）
  final posts = <Map<String, dynamic>>[];

  /// 决定那条请求的回执
  dynamic reply;

  /// 让决定那条请求失败
  Object? decideError;

  /// 卡住请求（验操作中态：按钮禁用 + 「处理中…」）
  Completer<void>? hold;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async => <String, dynamic>{'items': <dynamic>[]};

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add(<String, dynamic>{'path': path, ...body});
    if (hold != null) await hold!.future;
    final failure = decideError;
    if (failure != null) throw failure;
    return reply ?? <String, dynamic>{'outcome': 'approved', 'exec': <String, dynamic>{'state': 'ok'}};
  }
}

Map<String, dynamic> pendingGrant({
  String id = 'g-1',
  String kind = 'mcp-remove',
  String name = 'obscura',
  String command = 'node',
  List<dynamic> args = const <dynamic>['C:\\nowhere\\obscura.js'],
  List<dynamic> scriptNames = const <dynamic>[],
  String requestedAt = '2026-02-14T02:00:00.000Z',
}) =>
    <String, dynamic>{
      'id': id,
      'kind': kind,
      'name': name,
      'desc': '读本机浏览器历史与当前标签页',
      'command': command,
      'args': args,
      'envKeys': <dynamic>[],
      'scriptNames': scriptNames,
      'fileCount': 0,
      'reason': '想用它看本机浏览器里开着什么',
      'question': '批准加一个 MCP server「$name」？',
      'context': '它会做什么：读本机浏览器历史与当前标签页',
      'askSeq': 7,
      'expiredAt': null,
      'requestedAt': requestedAt,
      'outcome': null,
      'outcomeAt': null,
      'rejectReason': null,
      'exec': null,
      'picked': true,
    };

void main() {
  const s = ZhStrings();

  /// 壳的替身（**不是** HomeShell）：这一层要验的是"卡在窗口右下角"，
  /// 而真正那棵树里还有侧栏与页面，位置断言会被它们的宽度带偏。
  Future<void> pumpHost(WidgetTester tester, AppState state, {Widget? child}) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      builder: (context, inner) => IrmiaStrings(
        strings: s,
        child: inner ?? const SizedBox.shrink(),
      ),
      home: Scaffold(
        body: GrantInboxHost(
          state: state,
          child: child ?? const SizedBox.expand(),
        ),
      ),
    ));
    await tester.pump();
  }

  /// 收场：把 toast 那一拍跑完、再拆掉宿主（宿主 dispose 会取消"15 秒收起"那一拍）。
  ///
  /// 不这么做的话，测试收尾会留下 pending timer（本仓的规矩：`grant_inbox_test.dart` 那一族）。
  Future<void> teardownHost(WidgetTester tester) async {
    await tester.pump(IrmiaToast.duration);
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  }

  /// 每一条用例的起手：一个 AppState + 一份假 API
  ({AppState state, _FakeApi api}) makeState() {
    final api = _FakeApi();
    final state = AppState(api: api);
    addTearDown(state.dispose);
    return (state: state, api: api);
  }

  testWidgets('① 有待批 ⇒ 卡出现在窗口右下角（位置断言），三枚按钮都在', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await pumpHost(tester, env.state);

    final card = find.byKey(const ValueKey('grant-inbox-card-g-1'));
    expect(card, findsOneWidget);
    final rect = tester.getRect(card);
    // 右下角 = 距右边 / 下边各 kGrantInboxInset（16）
    expect(rect.right, closeTo(1200 - kGrantInboxInset, 1),
        reason: '卡没贴在窗口右边（right=${rect.right}）');
    expect(rect.bottom, closeTo(800 - kGrantInboxInset, 1),
        reason: '卡没贴在窗口底边（bottom=${rect.bottom}）');
    expect(rect.left, greaterThan(1200 / 2), reason: '卡该在**右半边**，不是页面中间');
    expect(rect.top, greaterThan(800 / 2), reason: '卡该在**下半边**，不是页面上方');

    // ── 尺寸（用户 2026-10-21：「这个弹窗有点太小太丑了，可以稍微放大一点点」）──
    // 340 → 420：一行要放得下「加一个 MCP 服务：playwright」这种句子，别三行字挤成一坨
    final size = tester.getSize(card);
    expect(size.width, greaterThanOrEqualTo(400), reason: '卡宽该 ≥400（实际 ${size.width}）');

    // 三枚按钮同一个最小高度 36（原 30）：一排控件不许一个高一个矮
    for (final key in const <String>[
      'grant-inbox-approve-g-1',
      'grant-inbox-reject-g-1',
      'grant-inbox-details-g-1',
    ]) {
      final height = tester.getSize(find.byKey(ValueKey(key))).height;
      expect(height, greaterThanOrEqualTo(36), reason: '$key 的高度该 ≥36（实际 $height）');
    }

    // ── 层次靠字号与颜色，**不靠加粗**（用户：「字体不要胡乱加粗」）──
    // 标题 15 / w500（上一版是 13 / w600）；w700 在这一张卡上是判据，不是口味
    final title = tester.widget<Text>(find.byKey(const ValueKey('grant-inbox-title-g-1')));
    expect(title.style?.fontWeight, isNot(FontWeight.w700), reason: '标题不许加粗到 w700（"乱加粗"就是这一条）');
    expect(title.style?.fontWeight, FontWeight.w500, reason: '标题该是 w500：比正文重一点，但不喊');
    expect(title.style?.fontSize, 15);
    // 来源 12 / w400 / 更次要色（三条语气：15 主 / 13 次 / 12 弱）
    final source = tester.widget<Text>(find.byKey(const ValueKey('grant-inbox-source-g-1')));
    expect(source.style?.fontWeight, FontWeight.w400);
    expect(source.style?.fontSize, 12);
    expect(source.style?.color, isNot(title.style?.color), reason: '来源要比标题浅一档（靠颜色分层）');

    // 内容三件套：动作 + 名字 / 一行影响 / 来源
    expect(find.text(s.grantInboxActionMcpRemove('obscura')), findsOneWidget);
    expect(find.text(s.grantInboxSource), findsOneWidget);
    // 低风险那一支：按钮就是「批准」（不是「查看并批准」），加「驳回」「详情」
    expect(find.byKey(const ValueKey('grant-inbox-approve-g-1')), findsOneWidget);
    expect(find.text(s.grantInboxApprove), findsOneWidget);
    expect(find.text(s.grantInboxApproveHighRisk), findsNothing);
    expect(find.byKey(const ValueKey('grant-inbox-reject-g-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-inbox-details-g-1')), findsOneWidget);

    await teardownHost(tester);
  });

  testWidgets('② 低风险点「批准」⇒ 直接调 grant-decide，不打开详情', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant(kind: 'skill-remove', name: 'old-skill')]);
    await pumpHost(tester, env.state);

    await tester.tap(find.byKey(const ValueKey('grant-inbox-approve-g-1')));
    await tester.pump();

    expect(env.api.posts, hasLength(1), reason: '低风险点了就该当场发出去');
    expect(env.api.posts.single, <String, dynamic>{
      'path': '/api/commands/grant-decide',
      'id': 'g-1',
      'decision': 'approve',
    });
    expect(find.byType(GrantPendingCard), findsNothing,
        reason: '低风险**不该**先弹详情（那是一键批的唯一例外）');

    await teardownHost(tester);
  });

  testWidgets('③ 高风险点「查看并批准」⇒ 一个字节都不发，先打开详情', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[
      pendingGrant(kind: 'mcp-add', name: 'obscura'),
    ]);
    await pumpHost(tester, env.state);

    // 高风险那一支的按钮文案**单独一句**（这是"点了会先给你看"的承诺）
    expect(find.text(s.grantInboxApproveHighRisk), findsOneWidget);
    expect(find.text(s.grantInboxHighRiskBadge), findsOneWidget, reason: '高风险徽章必须在');

    // ── 命令行那一行：等宽字体 + 优先在 `\` 处折行（用户截图里那条被切成 …\@play | wright\mcp\cli.js）──
    final commandLine = tester.widget<Text>(find.byKey(const ValueKey('grant-inbox-impact-g-1')));
    final family = '${commandLine.style?.fontFamily}'.toLowerCase();
    expect(
      family,
      anyOf(contains('mono'), contains('consolas')),
      reason: '命令行必须是等宽字体（实际 $family）',
    );
    expect(commandLine.style?.fontWeight, FontWeight.w400, reason: '命令行是正文不是标题：w400');
    expect(commandLine.style?.fontSize, 13);
    // 断点落在目录边界上：每个 `\` 后面有一个零宽空格（U+200B）。
    // 用码位造它而不是往源码里贴一个不可见字符：那种字符读代码的人看不见。
    final zeroWidthSpace = String.fromCharCode(0x200B);
    expect(commandLine.data, contains(zeroWidthSpace), reason: r'一条路径要能在 `\` 处断，而不是从路径中间硬切');
    // 全量原文在 tooltip 里，而且**不带**零宽空格（那是排版用的，不是内容）
    expect(
      tester.widgetList<Tooltip>(find.byType(Tooltip)).map((tip) => tip.message),
      contains(s.grantInboxCommand(r'node C:\nowhere\obscura.js')),
      reason: '超过三行省略时，整条命令行要能悬停看到',
    );

    await tester.tap(find.byKey(const ValueKey('grant-inbox-approve-g-1')));
    await tester.pumpAndSettle();

    expect(env.api.posts, isEmpty,
        reason: '高风险**不许一键批**：点了按钮只该打开详情，不该有决定发出去');
    final dialog = find.byType(GrantPendingCard);
    expect(dialog, findsOneWidget, reason: '详情 = 扩展页那张完整卡（同一段代码）');
    // 卡片里的"批准"能按（人看过之后在这里批）
    await tester.tap(find.byKey(const ValueKey('grant-approve-g-1')));
    await tester.pumpAndSettle();
    expect(env.api.posts.single['decision'], 'approve',
        reason: '详情里那一按才是真的批准');
    await tester.pumpAndSettle();
    expect(find.byType(GrantPendingCard), findsNothing, reason: '批完详情该自己关掉');

    await teardownHost(tester);
  });

  testWidgets('③b 高风险那一支连「详情」按钮都走同一个弹窗（不是另开一条路）', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[
      pendingGrant(kind: 'skill-install', name: 'daily-brief', scriptNames: <dynamic>['scripts/brief.py']),
    ]);
    await pumpHost(tester, env.state);

    // 带脚本的装技能：那一行影响必须点出「不会自动执行」（新手最怕的就是这个）
    expect(find.textContaining('不会自动执行'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('grant-inbox-details-g-1')));
    await tester.pumpAndSettle();
    expect(find.byType(GrantPendingCard), findsOneWidget);
    expect(env.api.posts, isEmpty);
    // 关掉详情（× 上写着那句 tooltip）
    await tester.tap(find.byKey(const ValueKey('grant-inbox-details-close')));
    await tester.pumpAndSettle();
    expect(find.byType(GrantPendingCard), findsNothing);

    await teardownHost(tester);
  });

  testWidgets('④ 超过三张 ⇒ 只摆最新三张，多出来的写「还有 N 条待批」', (tester) async {
    final env = makeState();
    // 故意**乱序**喂进去：顺序该由 `applyPendingGrants`（→ pendingGrantsNewestFirst）定，
    // 而不是靠调用方自觉（右下角只取前三条，顺序错了就是把最旧的三条摆给人看）
    env.state.applyPendingGrants(<Map<String, dynamic>>[
      pendingGrant(id: 'g-2', name: 'srv-2', requestedAt: '2026-02-14T02:00:00.000Z'),
      pendingGrant(id: 'g-4', name: 'srv-4', requestedAt: '2026-02-14T04:00:00.000Z'),
      pendingGrant(id: 'g-1', name: 'srv-1', requestedAt: '2026-02-14T01:00:00.000Z'),
      pendingGrant(id: 'g-3', name: 'srv-3', requestedAt: '2026-02-14T03:00:00.000Z'),
    ]);
    await pumpHost(tester, env.state);

    // 最新三张：g-4 / g-3 / g-2（最旧的 g-1 收进"N 条"里）
    expect(find.byKey(const ValueKey('grant-inbox-card-g-4')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-inbox-card-g-3')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-inbox-card-g-2')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsNothing,
        reason: '第四张不该画出来（最多三张）');
    expect(find.text(s.grantInboxMore(1)), findsOneWidget);
    expect(find.text(s.grantInboxHeader(4)), findsOneWidget, reason: '标题上的数仍是**全部**待批');

    // 堆叠里三张竖直排开、右边缘对齐（不是横着一排）
    final top = tester.getRect(find.byKey(const ValueKey('grant-inbox-card-g-4')));
    final middle = tester.getRect(find.byKey(const ValueKey('grant-inbox-card-g-3')));
    expect(middle.top, greaterThan(top.bottom), reason: '三张要**竖着**叠（这是堆叠不是横排）');
    expect(middle.right, closeTo(top.right, 0.5), reason: '右边缘该对齐');

    await teardownHost(tester);
  });

  testWidgets('⑤ 没有待批 ⇒ 什么都不画（连细条都没有）', (tester) async {
    final env = makeState();
    await pumpHost(tester, env.state);

    expect(find.byType(GrantInboxPanel), findsOneWidget);
    expect(find.text(s.grantInboxHeader(0)), findsNothing);
    expect(find.text(s.grantInboxCollapsed(0)), findsNothing);
    expect(find.byKey(const ValueKey('grant-inbox-collapsed')), findsNothing);
    expect(tester.getSize(find.byType(GrantInboxPanel)), Size.zero,
        reason: '没有待批时这一层不占任何面积（不能是"空着的一块"）');

    // 从"有"退回"没有"也一样：批完最后一张之后细条也不该留着
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await tester.pump();
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget);
    env.state.applyPendingGrants(const <Map<String, dynamic>>[]);
    await tester.pump();
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsNothing);
    expect(find.byKey(const ValueKey('grant-inbox-collapsed')), findsNothing);

    await teardownHost(tester);
  });

  testWidgets('⑤b 没有待批、但有一张**读不出来的单子** ⇒ 那条提示要看得见（不静默丢）', (tester) async {
    final env = makeState();
    env.state.applyMalformedGrants(<Map<String, dynamic>>[
      <String, dynamic>{'id': 'remove-obscura-mcp', 'why': 'kind 只能是 "mcp-add" / "mcp-remove"'},
    ]);
    await pumpHost(tester, env.state);

    // 这是"人写了单子、框架一声不响"那条缝：没有卡可点，但**必须**有一句话
    final bar = find.byKey(const ValueKey('grant-inbox-unreadable'));
    expect(bar, findsOneWidget, reason: '读不出来的单子既不在待批队列里、也挂不出卡，不显示就等于吞了');
    expect(find.text(s.grantUnreadableTitle), findsOneWidget);
    expect(find.textContaining('remove-obscura-mcp'), findsOneWidget, reason: '要说清是哪一张');
    expect(find.textContaining('mcp-remove'), findsOneWidget, reason: '原因原样带出来（不译成"未知错误"）');
    expect(tester.getSize(bar).width, greaterThan(0), reason: '它不是"空着的一块"');
    // 位置在右下角（与待批卡同一个落点：它会挡内容，所以必须在人习惯看的那一角）
    final rect = tester.getRect(bar);
    expect(rect.right, closeTo(1200 - kGrantInboxInset, 1));
    expect(rect.bottom, closeTo(800 - kGrantInboxInset, 1));

    // 它**不**进待批队列：没有卡、没有待批计数、也没有可点的批准按钮
    expect(find.byKey(const ValueKey('grant-inbox-card-remove-obscura-mcp')), findsNothing);
    expect(find.text(s.grantInboxHeader(0)), findsNothing);
    expect(find.text(s.grantInboxApprove), findsNothing, reason: '一张读不出来的单子没有可批的东西');

    // 读了之后（服务端把它退回/修好）：这条提示自己消失
    env.state.applyMalformedGrants(const <Map<String, dynamic>>[]);
    await tester.pump();
    expect(find.byKey(const ValueKey('grant-inbox-unreadable')), findsNothing);
    expect(tester.getSize(find.byType(GrantInboxPanel)), Size.zero);

    await teardownHost(tester);
  });

  testWidgets('⑤c 有待批卡 + 读不出来的单子 ⇒ 两件事同时看得见（互不遮蔽）', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    env.state.applyMalformedGrants(<Map<String, dynamic>>[
      <String, dynamic>{'id': 'g-broken', 'why': '文件读不出来（内容不是合法 JSON）'},
    ]);
    await pumpHost(tester, env.state);

    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget, reason: '有单时一定要看到卡');
    expect(find.byKey(const ValueKey('grant-inbox-unreadable')), findsOneWidget, reason: '另一张坏单也不许被卡挡住');

    await teardownHost(tester);
  });

  testWidgets('⑥ 15 秒后收起成细条（不消失），点细条还能展开', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await pumpHost(tester, env.state);
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget);

    // 还没到点：照旧是卡
    await tester.pump(kGrantInboxCollapseAfter - const Duration(seconds: 1));
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget);

    // 到点：卡收成细条，但**细条还在**（人还看得见"有 1 条待批"）
    await tester.pump(const Duration(seconds: 1));
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsNothing);
    final bar = find.byKey(const ValueKey('grant-inbox-collapsed'));
    expect(bar, findsOneWidget, reason: '收起不等于消失');
    expect(find.text(s.grantInboxCollapsed(1)), findsOneWidget);
    // 细条也在右下角（它只是窄了，不是换了个地方）
    final barRect = tester.getRect(bar);
    expect(barRect.right, closeTo(1200 - kGrantInboxInset, 1));
    expect(barRect.bottom, closeTo(800 - kGrantInboxInset, 1));

    // 点细条：再摊开
    await tester.tap(bar);
    await tester.pump();
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget);

    await teardownHost(tester);
  });

  testWidgets('⑥b 收起按钮也能收（人自己收的，不是等 15 秒）', (tester) async {
    final env = makeState();
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await pumpHost(tester, env.state);
    await tester.tap(find.byKey(const ValueKey('grant-inbox-collapse')));
    await tester.pump();
    expect(find.byKey(const ValueKey('grant-inbox-collapsed')), findsOneWidget);
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsNothing);
    await teardownHost(tester);
  });

  testWidgets('⑥c 提交中有操作中态：两枚按钮都禁用，按钮写「处理中…」', (tester) async {
    final env = makeState();
    env.api.hold = Completer<void>();
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await pumpHost(tester, env.state);

    await tester.tap(find.byKey(const ValueKey('grant-inbox-approve-g-1')));
    await tester.pump();

    expect(find.text(s.grantInboxWorking), findsOneWidget);
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('grant-inbox-approve-g-1'))).onPressed,
        isNull, reason: '在飞的时候「批准」要禁用（防连点出两次决定）');
    expect(tester.widget<TextButton>(find.byKey(const ValueKey('grant-inbox-reject-g-1'))).onPressed,
        isNull, reason: '「驳回」也要禁用');

    // 放行：回执到了之后按钮恢复
    env.api.hold!.complete();
    await tester.pumpAndSettle();
    expect(find.text(s.grantInboxWorking), findsNothing);

    await teardownHost(tester);
  });

  testWidgets('⑥d 失败 ⇒ 卡留着并在卡里说出原因（不静默吞掉）', (tester) async {
    final env = makeState();
    env.api.decideError = ApiError(409, 'grant-already-decided');
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await pumpHost(tester, env.state);

    await tester.tap(find.byKey(const ValueKey('grant-inbox-approve-g-1')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget,
        reason: '没记上就不能把卡收掉（否则人以为批了）');
    final failure = find.byKey(const ValueKey('grant-inbox-failure-g-1'));
    expect(failure, findsOneWidget);
    expect(tester.widget<Text>(failure).data, s.grantInboxFailed('grant-already-decided'));
    // 按钮恢复可点（再点一次就行）
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('grant-inbox-approve-g-1'))).onPressed,
        isNotNull);

    await teardownHost(tester);
  });

  testWidgets('⑥e 不抢焦点：卡出现时键盘焦点原地不动', (tester) async {
    final env = makeState();
    final node = FocusNode();
    addTearDown(node.dispose);
    await pumpHost(
      tester,
      env.state,
      child: Focus(focusNode: node, child: const SizedBox.expand()),
    );
    node.requestFocus();
    await tester.pump();
    expect(node.hasFocus, isTrue);

    // 她递了一张单子：卡出现
    env.state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
    await tester.pump();
    expect(find.byKey(const ValueKey('grant-inbox-card-g-1')), findsOneWidget);
    expect(node.hasFocus, isTrue,
        reason: '通知卡不许抢焦点（人可能正在聊天框里打字）');
    // "不抢焦点"的另一半是"不是模态"：卡不是弹窗，屏幕上没有第二层路由
    expect(find.byType(Dialog), findsNothing, reason: '通知卡不是弹窗（不摆模态那一层）');

    await teardownHost(tester);
  });
}
