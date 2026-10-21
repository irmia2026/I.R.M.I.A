import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 扩展页 · 技能 · **已生效行的「删除」**（`POST /api/commands/skill-remove` 的前端那一半）。
///
/// 来源：docs/repo-cleanliness-audit.md §8 第 4 条（总表 D3）。后端两个入口都在
/// （`/api/commands/skill-remove`，server.ts:4694；`POST /api/skills/remove`，:2562），
/// `CONFIRM_PHRASES` 的注释甚至逐字把它写成"扩展页 · 技能 · 已生效行的「删除」"
/// （server.ts:330-334），而界面从来没有人调用它。
///
/// 这里锁四件事：
///   ① 已生效的行有两颗按钮（停用 + 删除），**待确认的行没有删除**（那条路上删除没有意义）；
///   ② 点删除要先过确认框，确认框说清"移进回收站、不是 rm -rf"；
///   ③ 确认后发 `skill-remove {name}` 且带危险短语 `X-Confirm: skill-remove`，清单随之重读；
///   ④ 取消则一个请求都不发。
///
/// 替身只覆写 `get` / `post` 两个口（照 extensions_page_test.dart 的 `_FakeApi`），
/// 因为这一页要的正是"发出了哪条命令、带没带短语"。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  /// 发出的命令：path + body + X-Confirm 短语，按顺序记
  final List<({String path, Map<String, dynamic> body, String? confirm})> posts = [];

  @override
  Future<dynamic> get(String path) async => routes[path];

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add((path: path, body: body, confirm: confirm));
    return {'ok': true, 'name': body['name'], 'movedTo': 'data/trash/20261006T101010Z-weather'};
  }
}

void main() {
  // 这一页会写本机忽略集（ui_state）：测试指向临时文件，别踩真实 %APPDATA% 里的状态
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-skill-remove-test.json';
  });

  late _FakeApi api;
  late List<Map<String, dynamic>> items;

  /// 一份技能条目，字段照 `GET /api/skills` 的 items 形状
  Map<String, dynamic> skill(String name, {required bool inCatalog, String trust = 'never-confirmed'}) => {
        'name': name,
        'trust': trust,
        'inCatalog': inCatalog,
        'description': '$name 的说明',
        'skillPath': '$name/SKILL.md',
        'bytes': 120,
        'contentHash': 'abcdef0123456789',
        'trustDetail': '',
        'ignored': false,
      };

  Map<String, dynamic> skillsView() => {
        'items': items,
        'rejected': <dynamic>[],
        'catalogTokens': 24,
        'ignored': <dynamic>[],
      };

  setUp(() {
    items = [
      skill('weather', inCatalog: true, trust: 'trusted'),
      skill('draft-skill', inCatalog: false),
    ];
    api = _FakeApi({
      '/api/skills': skillsView(),
      '/api/mcp': {'servers': <dynamic>[], 'problems': <dynamic>[], 'registeredCount': 0, 'runningCount': 0},
      '/api/tools': {'groups': <dynamic>[], 'tools': <dynamic>[]},
      '/api/hooks': {
        'entries': <dynamic>[], 'problems': <dynamic>[], 'relative': 'data/hooks.json',
        'hookPoints': <String>['PreToolUse'], 'defaultTimeoutMs': 10000,
        'enabledCount': 0, 'disabledCount': 0,
      },
    });
  });

  /// 删除那颗按钮的 tooltip（文案变了就是换了一颗按钮，这条断言该跟着红）
  const deleteTooltip = '删除：把技能目录整份移进回收站（可恢复，不是 rm -rf）';

  Future<void> pumpSkills(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final state = AppState(api: api);
    addTearDown(state.dispose);
    // 先前卸掉上一棵树再开这一页（理由见 extensions_page_test.dart：直接二次 pumpWidget
    // 会把新 AppState 交给原来那个 State，initState 不再跑）
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(const ValueKey('ext-item-skills')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  testWidgets('已生效行有「删除」，待确认行没有（两件事不在同一条路上）', (tester) async {
    await pumpSkills(tester);

    expect(find.byKey(const ValueKey('skill-weather')), findsOneWidget);
    expect(find.byKey(const ValueKey('skill-draft-skill')), findsOneWidget);

    // 「删除」只长在已生效那一行上：待确认的技能还没进 catalog，删它没有意义
    expect(find.byTooltip(deleteTooltip), findsOneWidget, reason: '只有 weather 是已生效的');
    final pendingRow = find.byKey(const ValueKey('skill-draft-skill'));
    expect(find.descendant(of: pendingRow, matching: find.byTooltip(deleteTooltip)), findsNothing);
    // 已生效行的另一颗（停用）还在：删除是**加**上去的，不是替换
    expect(find.byTooltip('停用：从 catalog 里收起来（不改文件，随时可恢复）'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('点删除：先确认（说清是移进回收站），确认后发 skill-remove{name} + 危险短语，清单重读', (tester) async {
    await pumpSkills(tester);

    await tester.tap(find.byTooltip(deleteTooltip));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(find.text('删除技能 · weather'), findsOneWidget, reason: '确认框要点名删的是哪一个');
    expect(find.textContaining('移进回收站'), findsOneWidget);
    expect(find.textContaining('不是 rm -rf'), findsOneWidget, reason: '可恢复这件事必须写在明面上');

    // 确认之前一个请求都不许发
    expect(api.posts, isEmpty);

    // 服务端删掉之后那一行就没了：替身把 items 换掉，页面 load('skills') 会重读
    items = [skill('draft-skill', inCatalog: false)];
    api.routes['/api/skills'] = skillsView();

    await tester.tap(find.widgetWithText(FilledButton, '删除'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(api.posts.length, 1);
    expect(api.posts.single.path, '/api/commands/skill-remove');
    expect(api.posts.single.body, {'name': 'weather'});
    expect(api.posts.single.confirm, 'skill-remove',
        reason: '危险短语（X-Confirm）决定服务端放不放行，漏了它这条命令根本走不通');
    expect(find.textContaining('已删除'), findsOneWidget, reason: '要有回执：删了什么、去哪儿了');
    expect(find.byKey(const ValueKey('skill-weather')), findsNothing, reason: '清单跟着重读，删掉的那一行该消失');
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 4200)); // toast 计时器收尾
  });

  testWidgets('确认框点取消：不发请求，技能还在', (tester) async {
    await pumpSkills(tester);

    await tester.tap(find.byTooltip(deleteTooltip));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.widgetWithText(TextButton, '取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));

    expect(api.posts, isEmpty, reason: '取消之后不许有任何命令请求');
    expect(find.byKey(const ValueKey('skill-weather')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
