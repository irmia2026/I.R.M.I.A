import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/pages/subagents_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// P3.3 子代理管理页的页面级验收。
///
/// 端口契约（不碰真后端）：
///   · `/api/subagents?includeArchived=1` / `/api/subagents/:id` / profiles；
///   · `subagent-message` 不带 X-Confirm，cancel/resume 的 confirm 短语是命令名；
///   · SSE 事件按 `agentId` 只进当前详情，列表状态仍以 API 回读为准。
///
/// 这里还钉住四条容易回潮的边界：入口 badge 只算活跃、关闭态不显示会话操作、
/// 详情不显示 workspace 绝对路径，以及 600 宽单列不溢出。
class _Posted {
  _Posted(this.path, this.body, this.confirm);

  final String path;
  final Map<String, dynamic> body;
  final String? confirm;
}

class _FakeSubagentApi extends IrmiaApi {
  _FakeSubagentApi() : super(baseUrl: 'http://127.0.0.1:1');

  bool enabled = true;
  bool failList = false;
  bool failDetail = false;
  bool applyToggle = true;
  bool requiresRestart = false;
  Completer<void>? listGate;

  List<Map<String, dynamic>> items = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> profiles = <Map<String, dynamic>>[];
  List<Map<String, dynamic>> timelineEvents = <Map<String, dynamic>>[];
  final Map<String, String> reports = <String, String>{};
  final List<_Posted> posts = <_Posted>[];
  final List<String> gets = <String>[];
  final StreamController<Map<String, dynamic>> feed =
      StreamController<Map<String, dynamic>>.broadcast();

  int listReads = 0;
  int timelineReads = 0;

  Future<void> close() async {
    await feed.close();
  }

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    gets.add(path);
    if (path == '/api/subagents?includeArchived=1') {
      listReads += 1;
      final gate = listGate;
      if (gate != null) await gate.future;
      if (failList) throw const ApiError(500, 'list failed');
      return <String, dynamic>{'enabled': enabled, 'items': items};
    }
    if (path == '/api/subagents/profiles') {
      return <String, dynamic>{
        'enabled': enabled,
        'items': enabled ? profiles : <dynamic>[],
      };
    }
    if (path.startsWith('/api/subagents/')) {
      if (failDetail) throw const ApiError(500, 'detail failed');
      final id = Uri.decodeComponent(path.substring('/api/subagents/'.length));
      final item = _itemOf(id);
      if (item == null) throw const ApiError(404, 'subagent not found');
      return <String, dynamic>{
        'enabled': enabled,
        ...item,
        'lastReport': reports[id],
        'headError': null,
      };
    }
    if (path.startsWith('/api/events')) {
      timelineReads += 1;
      return <String, dynamic>{'events': timelineEvents};
    }
    throw ApiError(404, 'unexpected GET $path');
  }

  @override
  Future<dynamic> post(
    String path,
    Map<String, dynamic> body, {
    String? confirm,
    Duration? timeout,
  }) async {
    posts.add(_Posted(path, body, confirm));
    if (path == '/api/commands/config-update') {
      final fields = body['fields'];
      if (applyToggle && fields is Map) {
        enabled = fields['subagents.enabled'] == true;
      }
      return <String, dynamic>{'ok': true, 'requiresRestart': requiresRestart};
    }
    if (path == '/api/commands/subagent-install' ||
        path == '/api/commands/subagent-verify') {
      final id = body['profileId']?.toString() ?? '';
      final index = profiles.indexWhere((profile) => profile['id'] == id);
      if (index < 0) throw const ApiError(404, 'profile not found');
      if (path == '/api/commands/subagent-install') {
        profiles[index] = <String, dynamic>{
          ...profiles[index],
          'available': true,
          'locked': false,
          'missing': <dynamic>[],
        };
      }
      return <String, dynamic>{'ok': true, 'profile': profiles[index]};
    }
    final id = body['agentId']?.toString() ?? '';
    if (path == '/api/commands/subagent-message') {
      if (id.isEmpty) throw const ApiError(400, 'missing agentId');
      return <String, dynamic>{'ok': true, 'status': _itemOf(id)?['status']};
    }
    if (path == '/api/commands/subagent-cancel') {
      _patch(id, status: 'cancelled', canCancel: false, canResume: true);
      return <String, dynamic>{'ok': true, 'status': 'cancelled'};
    }
    if (path == '/api/commands/subagent-resume') {
      _patch(id, status: 'queued', canCancel: true, canResume: false);
      return <String, dynamic>{'ok': true, 'status': 'queued'};
    }
    throw ApiError(404, 'unexpected POST $path');
  }

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => feed.stream;

  Map<String, dynamic>? _itemOf(String id) {
    for (final item in items) {
      if (item['agentId'] == id) return item;
    }
    return null;
  }

  void _patch(
    String id, {
    required String status,
    required bool canCancel,
    required bool canResume,
  }) {
    final index = items.indexWhere((item) => item['agentId'] == id);
    if (index < 0) return;
    items[index] = <String, dynamic>{
      ...items[index],
      'status': status,
      'canCancel': canCancel,
      'canResume': canResume,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
  }
}

Map<String, dynamic> _item({
  required String id,
  required String status,
  String profile = 'research',
  String label = '调研',
  required bool canCancel,
  required bool canResume,
  String? preview,
  int used = 1200,
  int limit = 8000,
  bool archived = false,
}) {
  final now = DateTime.now().toUtc().toIso8601String();
  return <String, dynamic>{
    'agentId': id,
    'profileId': profile,
    'label': label,
    'status': archived ? 'archived' : status,
    'parentCallId': 'call-$id',
    'parentTurn': 4,
    'createdAt': now,
    'updatedAt': now,
    'lastReportPreview': preview,
    'tokens': <String, dynamic>{'used': used, 'limit': limit},
    'canResume': canResume,
    'canCancel': canCancel,
    // 服务端 view 不返回 workspace；故意塞一个绝对路径，页面必须完全忽略它。
    'workspace': r'D:\secret\subagent-workspace',
  };
}

Map<String, dynamic> _event(int seq, String type, Map<String, dynamic> data) =>
    <String, dynamic>{
      'seq': seq,
      'ts': '2026-11-05T01:02:03.000Z',
      'type': type,
      'data': data,
    };

Map<String, dynamic> _profile({
  required String id,
  required String label,
  String description = '只读调查、检索与资料归纳。',
  int toolCount = 7,
  String workspace = 'own',
  String lane = 'heavy',
  String workdir = 'workspace',
  String shell = 'workspace',
  String reasoningEffort = 'max',
  int contextLimit = 1000000,
  double compactAt = 0.7,
  List<String> skills = const <String>[],
  List<String> mcpServers = const <String>[],
  List<String> missing = const <String>[],
  bool? available,
}) {
  final isAvailable = available ?? missing.isEmpty;
  return <String, dynamic>{
    'id': id,
    'label': label,
    'description': description,
    'toolCount': toolCount,
    'workspace': workspace,
    'lane': lane,
    'workdir': workdir,
    'shell': shell,
    'reasoningEffort': reasoningEffort,
    'contextLimit': contextLimit,
    'compactAt': compactAt,
    'skills': skills,
    'mcpServers': mcpServers,
    'available': isAvailable,
    'locked': !isAvailable,
    'missing': missing,
    // profiles API 不返回 systemPrompt；塞进来验页面真没读它。
    'systemPrompt': 'TOP SECRET PROFILE PROMPT',
  };
}

/// P4.1 的真实四个角色包（初始状态全部 locked）：用来钉版式，不伪造可用状态。
List<Map<String, dynamic>> _rolePackages() => <Map<String, dynamic>>[
  _profile(
    id: 'researcher',
    label: '调研',
    description: '证据驱动的调研：检索、核对来源、归纳结论与未解决问题。',
    toolCount: 9,
    skills: <String>['auto-deep-research'],
    missing: <String>['auto-deep-research'],
  ),
  _profile(
    id: 'coder',
    label: '编码',
    description: '在项目根实现、修改与自测代码；Serena 提供 LSP，Playwright 用于本地页面验证。',
    toolCount: 8,
    workdir: 'project',
    shell: 'project',
    skills: <String>['dev-workflow', 'review', 'irmia-framework', 'plugin-dev'],
    mcpServers: <String>['serena', 'playwright'],
    missing: <String>[
      'dev-workflow',
      'review',
      'irmia-framework',
      'plugin-dev',
      'serena',
      'playwright',
      'node',
      'npm',
      'git',
      'uvx',
    ],
  ),
  _profile(
    id: 'officer',
    label: '文书',
    description: '文书的整理、撰写与归档：office、human-copywrite 与 MarkItDown。',
    toolCount: 8,
    reasoningEffort: 'high',
    skills: <String>['office', 'human-copywrite'],
    mcpServers: <String>['markitdown'],
    missing: <String>[
      'office',
      'human-copywrite',
      'markitdown',
      'python',
      'uvx',
    ],
  ),
  _profile(
    id: 'design',
    label: '设计',
    description: '视觉评审与设计规格：本地截图、可验收项，不写生产代码。',
    toolCount: 7,
    skills: <String>['design-taste-frontend'],
    mcpServers: <String>['playwright'],
    missing: <String>['design-taste-frontend', 'playwright', 'node', 'npm'],
  ),
];

void main() {
  setUpAll(() {
    stateFileOverride =
        '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-subagents-test.json';
  });

  late _FakeSubagentApi api;
  late AppState state;

  setUp(() {
    api = _FakeSubagentApi();
    state = AppState(api: api);
    try {
      final file = File(stateFileOverride!);
      if (file.existsSync()) file.deleteSync();
    } catch (_) {
      // 临时状态文件清不掉不影响断言
    }
  });

  tearDown(() async {
    state.dispose();
    await api.close();
  });

  Future<void> pumpPage(
    WidgetTester tester, {
    Size size = const Size(1350, 900),
    bool english = false,
    Widget? child,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final app = MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: IrmiaTheme.light(),
      home: Scaffold(body: child ?? SubagentsPage(state: state)),
    );
    await tester.pumpWidget(
      english ? IrmiaStrings(strings: const EnStrings(), child: app) : app,
    );
    await tester.pump();
  }

  Future<void> pumpUntil(
    WidgetTester tester,
    Finder target, {
    int rounds = 80,
  }) async {
    for (var i = 0; i < rounds; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target\n已请求：${api.gets}');
  }

  void seedActive() {
    api.items = <Map<String, dynamic>>[
      _item(
        id: 'sub-aaaaaaaa-1111',
        status: 'running',
        canCancel: true,
        canResume: false,
        preview: '已找到 3 条证据',
      ),
      _item(
        id: 'sub-bbbbbbbb-2222',
        status: 'interrupted',
        label: '通用',
        canCancel: true,
        canResume: true,
      ),
      _item(
        id: 'sub-cccccccc-3333',
        status: 'completed',
        label: '文档',
        canCancel: false,
        canResume: true,
        archived: true,
      ),
    ];
    api.profiles = <Map<String, dynamic>>[
      _profile(id: 'general', label: '通用', toolCount: 6),
      _profile(id: 'research', label: '调研'),
      _profile(id: 'coding', label: '编码', toolCount: 8),
      _profile(id: 'review', label: '审查'),
      _profile(id: 'docs', label: '文档', lane: 'light'),
      _profile(id: 'ops', label: '运维'),
    ];
    api.timelineEvents = <Map<String, dynamic>>[
      _event(1, 'subagent/started', <String, dynamic>{
        'agentId': 'sub-aaaaaaaa-1111',
        'profileId': 'research',
        'parentCallId': 'call-a',
        'parentTurn': 4,
        'tokens': <String, dynamic>{'used': 0, 'limit': 8000},
      }),
      _event(2, 'subagent/report', <String, dynamic>{
        'agentId': 'sub-aaaaaaaa-1111',
        'kind': 'progress',
        'reportId': 'report-a',
        'summary': '已核对第三条证据。',
        'tokens': <String, dynamic>{'used': 1200, 'limit': 8000},
      }),
      _event(3, 'subagent/finished', <String, dynamic>{
        'agentId': 'sub-aaaaaaaa-1111',
        'status': 'completed',
        'summary': '结论已经给出。',
        'steps': 4,
        'turn': 1,
        'tokens': <String, dynamic>{'used': 1600, 'limit': 8000},
      }),
    ];
    api.reports['sub-aaaaaaaa-1111'] = '这是最后报告：三条证据都核对过。';
  }

  testWidgets('会话行操作按钮贴右：时间格不抢 Spacer 的余量', (tester) async {
    seedActive();
    state.pageId = 'subagents';
    await pumpPage(
      tester,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) => HomeShell(state: state),
      ),
    );
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-list')));

    final row = find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111'));
    final action = find.byKey(const ValueKey('subagent-cancel-sub-aaaaaaaa-1111'));
    expect(row, findsOneWidget);
    expect(action, findsOneWidget);
    final gap = tester.getRect(row).right - tester.getRect(action).right;
    expect(gap, lessThan(20), reason: '操作按钮应贴在行尾，不能停在中间（实际右侧余量 $gap）');
  });

  testWidgets('入口 badge：只数活跃，默认未归档，切到归档仍不丢角标', (tester) async {
    seedActive();
    state.pageId = 'subagents';
    await pumpPage(
      tester,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) => HomeShell(state: state),
      ),
    );
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-list')));

    final nav = find.byKey(const ValueKey('nav-subagents'));
    expect(nav, findsOneWidget);
    expect(
      find.descendant(of: nav, matching: find.text('2')),
      findsOneWidget,
      reason:
          'queued/running/interrupted 才进 badge：这里 running + interrupted = 2',
    );
    expect(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('subagent-row-sub-cccccccc-3333')),
      findsNothing,
      reason: '默认只显示未归档',
    );
    expect(
      find.byKey(const ValueKey('subagents-profile-research')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('subagents-profile-general')),
      findsNothing,
      reason: 'Profile 摘要只列五个专职 Profile，general 是隐式默认',
    );

    await tester.tap(find.byKey(const ValueKey('subagents-tab-archived')));
    await tester.pump();
    expect(
      find.byKey(const ValueKey('subagent-row-sub-cccccccc-3333')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
      findsNothing,
    );
    expect(
      find.descendant(of: nav, matching: find.text('2')),
      findsOneWidget,
      reason: '切归档只改列表筛选，不改变活跃角标',
    );

    state.applySubagentOverview(enabled: true, items: const <dynamic>[]);
    await tester.pump();
    expect(
      find.descendant(of: nav, matching: find.text('2')),
      findsNothing,
      reason: '没有活跃会话时不摆「0」角标',
    );
  });

  testWidgets('关闭态：只有说明 + 开关 + Profile 摘要，没有任何会话操作', (tester) async {
    api.enabled = false;
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagents-enable-switch')),
    );

    expect(find.text('子代理未启用'), findsOneWidget);
    expect(find.textContaining('需重启主进程后生效'), findsOneWidget);
    expect(find.byKey(const ValueKey('subagents-list')), findsNothing);
    expect(find.byKey(const ValueKey('subagent-message-input')), findsNothing);
    expect(find.text('Profile'), findsOneWidget);
    expect(find.text('Profile 摘要在启用并重启后显示。'), findsOneWidget);
    expect(tester.takeException(), isNull);

    api.items = <Map<String, dynamic>>[
      _item(
        id: 'sub-agent-1',
        status: 'running',
        canCancel: true,
        canResume: false,
      ),
    ];
    await tester.tap(find.byKey(const ValueKey('subagents-enable-switch')));
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-list')));
    final post = api.posts.singleWhere(
      (p) => p.path == '/api/commands/config-update',
    );
    expect(post.confirm, 'config-update');
    expect((post.body['fields'] as Map)['subagents.enabled'], isTrue);
    expect(
      find.byKey(const ValueKey('subagent-row-sub-agent-1')),
      findsOneWidget,
    );
  });

  testWidgets('启用但空列表：空态可读，profile 摘要来自 API', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    api.profiles = <Map<String, dynamic>>[
      _profile(id: 'research', label: '调研', toolCount: 7),
    ];
    await pumpPage(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-empty')));

    expect(find.text('还没有子代理会话'), findsOneWidget);
    expect(find.text('当她在后台派出子代理时，会话会出现在这里。'), findsOneWidget);
    expect(find.text('7 个工具 · 自建 workspace · 重模型'), findsOneWidget);
    expect(
      find.text('TOP SECRET PROFILE PROMPT'),
      findsNothing,
      reason: 'Profile 摘要不显示 systemPrompt',
    );
    expect(find.byKey(const ValueKey('subagents-active-count')), findsNothing);
  });

  testWidgets('加载时是骨架，不是永久转圈；完成后交给真实内容', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    api.listGate = Completer<void>();
    await pumpPage(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-skeleton')));
    expect(find.byKey(const ValueKey('subagents-empty')), findsNothing);
    api.listGate!.complete();
    api.listGate = null;
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-empty')));
    expect(find.byKey(const ValueKey('subagents-skeleton')), findsNothing);
  });

  testWidgets('读取失败：错误卡 + 重试后恢复列表', (tester) async {
    api.enabled = true;
    api.failList = true;
    api.items = <Map<String, dynamic>>[
      _item(id: 'sub-a', status: 'running', canCancel: true, canResume: false),
    ];
    await pumpPage(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-load-error')));
    expect(find.text('重试'), findsOneWidget);

    api.failList = false;
    await tester.tap(find.text('重试'));
    await pumpUntil(tester, find.byKey(const ValueKey('subagent-row-sub-a')));
    expect(find.byKey(const ValueKey('subagents-load-error')), findsNothing);
  });

  testWidgets('详情：报告、事件时间线按 agentId 过滤，不显示 workspace 路径', (tester) async {
    seedActive();
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await tester.tap(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await pumpUntil(tester, find.byKey(const ValueKey('subagent-timeline')));

    expect(find.text('这是最后报告：三条证据都核对过。'), findsOneWidget);
    expect(find.text('已启动'), findsOneWidget);
    expect(find.text('报告'), findsOneWidget);
    expect(find.text('已结束'), findsOneWidget);
    expect(find.text('已核对第三条证据。'), findsOneWidget);
    expect(find.textContaining(r'D:\secret'), findsNothing);
    // b 的事件不在服务端时间线里；即使有，页面也按 agentId 过滤。
    api.timelineEvents.add(
      _event(9, 'subagent/report', <String, dynamic>{
        'agentId': 'sub-bbbbbbbb-2222',
        'kind': 'progress',
        'summary': '另一个子代理的报告',
        'tokens': <String, dynamic>{'used': 1, 'limit': 10},
      }),
    );
    api.feed.add(
      _event(9, 'subagent/report', <String, dynamic>{
        'agentId': 'sub-bbbbbbbb-2222',
        'kind': 'progress',
        'summary': '另一个子代理的报告',
        'tokens': <String, dynamic>{'used': 1, 'limit': 10},
      }),
    );
    await tester.pump(const Duration(milliseconds: 500));
    expect(find.text('另一个子代理的报告'), findsNothing);
  });

  testWidgets('SSE 实时到达：当前详情的报告立即出现，按 agentId 过滤', (tester) async {
    seedActive();
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await tester.tap(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await pumpUntil(tester, find.byKey(const ValueKey('subagent-timeline')));

    final live = _event(4, 'subagent/report', <String, dynamic>{
      'agentId': 'sub-aaaaaaaa-1111',
      'kind': 'progress',
      'reportId': 'report-live',
      'summary': '实时到达的新进展。',
      'tokens': <String, dynamic>{'used': 1800, 'limit': 8000},
    });
    api.timelineEvents.add(live);
    api.feed.add(live);
    await tester.pump();
    expect(find.text('实时到达的新进展。'), findsOneWidget);
  });

  testWidgets('SSE 不推事件时，12 秒轮询仍会重读列表（断流兜底）', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    await pumpPage(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-empty')));
    final before = api.listReads;
    await tester.pump(const Duration(seconds: 13));
    await tester.pump();
    expect(api.listReads, greaterThan(before), reason: '断流时不能停在第一帧');
  });

  testWidgets('消息：写 agentId/message，不带 X-Confirm，成功提示后清空输入', (tester) async {
    seedActive();
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await tester.tap(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-message-input')),
    );

    await tester.enterText(
      find.byKey(const ValueKey('subagent-message-input')),
      '请继续核查第三条证据',
    );
    await tester.tap(find.byKey(const ValueKey('subagent-message-send')));
    for (var i = 0; i < 30; i += 1) {
      await tester.pump(const Duration(milliseconds: 30));
    }

    final post = api.posts.singleWhere(
      (p) => p.path == '/api/commands/subagent-message',
    );
    expect(post.body['agentId'], 'sub-aaaaaaaa-1111');
    expect(post.body['message'], '请继续核查第三条证据');
    expect(post.confirm, isNull);
    expect(find.text('消息已加入队列。'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(
            find.byKey(const ValueKey('subagent-message-input')),
          )
          .controller!
          .text,
      isEmpty,
    );
  });

  testWidgets('取消 / 恢复都有确认框，X-Confirm 用命令名', (tester) async {
    seedActive();
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await tester.tap(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-cancel-confirm')),
    );

    await tester.tap(find.byKey(const ValueKey('subagent-cancel-confirm')));
    await tester.pump();
    expect(find.text('取消这个子代理？'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '确认'));
    await tester.pumpAndSettle();
    final cancel = api.posts.singleWhere(
      (p) => p.path == '/api/commands/subagent-cancel',
    );
    expect(cancel.confirm, 'subagent-cancel');
    expect(cancel.body['agentId'], 'sub-aaaaaaaa-1111');

    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-resume-confirm')),
    );
    await tester.tap(find.byKey(const ValueKey('subagent-resume-confirm')));
    await tester.pump();
    expect(find.text('恢复这个子代理？'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '恢复'));
    await tester.pumpAndSettle();
    final resume = api.posts.singleWhere(
      (p) => p.path == '/api/commands/subagent-resume',
    );
    expect(resume.confirm, 'subagent-resume');
    expect(resume.body['agentId'], 'sub-aaaaaaaa-1111');
  });

  testWidgets('P4.4 Profile：锁态/依赖/上下文展示，安装确认与验证命令', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    final profile = <String, dynamic>{
      ..._profile(id: 'researcher', label: '调研'),
      'workdir': 'workspace',
      'shell': 'workspace',
      'reasoningEffort': 'max',
      'contextLimit': 1000000,
      'compactAt': 0.7,
      'skills': <dynamic>['auto-deep-research'],
      'mcpServers': <dynamic>[],
      'available': false,
      'locked': true,
      'missing': <dynamic>['auto-deep-research'],
    };
    profile.remove('lane');
    api.profiles = <Map<String, dynamic>>[profile];
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagents-profile-install-researcher')),
    );

    expect(find.text('locked'), findsOneWidget);
    expect(find.textContaining('auto-deep-research'), findsWidgets);
    expect(find.textContaining('1.0M tokens'), findsOneWidget);
    expect(find.textContaining('workspace / workspace'), findsOneWidget);
    expect(find.textContaining('· —'), findsOneWidget, reason: '旧 lane 字段缺席时显示 —');

    await tester.tap(
      find.byKey(const ValueKey('subagents-profile-install-researcher')),
    );
    await tester.pump();
    expect(find.text('安装 调研'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, '确认'));
    await pumpUntil(tester, find.text('available'));
    final install = api.posts.singleWhere(
      (post) => post.path == '/api/commands/subagent-install',
    );
    expect(install.confirm, 'subagent-install');
    expect(install.body['profileId'], 'researcher');

    await tester.tap(
      find.byKey(const ValueKey('subagents-profile-verify-researcher')),
    );
    await tester.pumpAndSettle();
    final verify = api.posts.singleWhere(
      (post) => post.path == '/api/commands/subagent-verify',
    );
    expect(verify.confirm, 'subagent-verify');
    expect(verify.body['profileId'], 'researcher');
    expect(tester.takeException(), isNull);
  });

  testWidgets('窄窗 600×800：角色包折成单列、页头与详情不溢出', (tester) async {
    seedActive();
    await pumpPage(tester, size: const Size(600, 800));
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    expect(
      find.byKey(const ValueKey('subagents-profiles-stack')),
      findsOneWidget,
      reason: '600 宽放不下左右两栏，角色包要折成列表在上、详情在下',
    );
    expect(
      find.byKey(const ValueKey('subagents-profiles-split')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await tester.tap(
      find.byKey(const ValueKey('subagent-row-sub-aaaaaaaa-1111')),
    );
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagent-message-input')),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('1350×900：四个角色包排成同一列，不再出现单卡孤行', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    api.profiles = _rolePackages();
    await pumpPage(tester);
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagents-profiles-split')),
    );

    const ids = <String>['researcher', 'coder', 'officer', 'design'];
    final rects = <Rect>[
      for (final id in ids)
        tester.getRect(find.byKey(ValueKey('subagents-profile-$id'))),
    ];
    for (final rect in rects) {
      expect(
        rect.left,
        moreOrLessEquals(rects.first.left, epsilon: 0.5),
        reason: '四行必须在同一列（旧版 3+1 的孤行网格就错在这里）',
      );
    }
    for (var i = 1; i < rects.length; i += 1) {
      expect(
        rects[i].top,
        greaterThan(rects[i - 1].top),
        reason: '角色包按列表往下排',
      );
    }
    expect(
      find.byKey(const ValueKey('subagents-profile-detail-researcher')),
      findsOneWidget,
      reason: '默认选中第一个角色包，详情就在右栏',
    );
    expect(
      tester.getRect(find.byKey(const ValueKey('subagents-profile-list'))).right,
      lessThanOrEqualTo(
        tester
            .getRect(
              find.byKey(
                const ValueKey('subagents-profile-detail-researcher'),
              ),
            )
            .left,
      ),
      reason: '列表在左、详情在右，两栏不重叠',
    );

    // 点另一个角色，详情跟着换（不重开页面、不改 API 数据）。
    await tester.tap(find.byKey(const ValueKey('subagents-profile-design')));
    await tester.pump();
    expect(
      find.byKey(const ValueKey('subagents-profile-detail-design')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('长 missing 只占一行：放不下的收进 +N，点开才全部展开', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    final longMissing = <String>[
      for (var i = 0; i < 14; i += 1) 'dependency-number-$i-long-name',
    ];
    api.profiles = <Map<String, dynamic>>[
      _profile(
        id: 'coder',
        label: '编码',
        toolCount: 8,
        skills: <String>['dev-workflow', 'review'],
        mcpServers: <String>['serena'],
        missing: longMissing,
      ),
    ];
    await pumpPage(tester);
    final more = find.byKey(
      const ValueKey('subagents-profile-more-missing-coder'),
    );
    await pumpUntil(tester, more);

    expect(
      find.text('dependency-number-13-long-name'),
      findsNothing,
      reason: '收起的 chip 行最多一行，最后一项应在 +N 后面',
    );
    await tester.tap(more);
    await tester.pump();
    expect(find.text('dependency-number-13-long-name'), findsOneWidget);
    expect(find.text('收起'), findsOneWidget);
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('收起'));
    await tester.pump();
    expect(find.text('dependency-number-13-long-name'), findsNothing);
  });

  testWidgets('安装 / 校验固定在详情右上角操作区，不跟 missing 混排', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    api.profiles = _rolePackages();
    await pumpPage(tester);
    final verify = find.byKey(
      const ValueKey('subagents-profile-verify-researcher'),
    );
    final install = find.byKey(
      const ValueKey('subagents-profile-install-researcher'),
    );
    await pumpUntil(tester, verify);

    final verifyRect = tester.getRect(verify);
    final installRect = tester.getRect(install);
    expect(
      (verifyRect.center.dy - installRect.center.dy).abs(),
      lessThan(1),
      reason: '安装/校验并排在同一行',
    );
    final detailRect = tester.getRect(
      find.byKey(const ValueKey('subagents-profile-detail-researcher')),
    );
    expect(detailRect.contains(verifyRect.center), isTrue);
    expect(
      verifyRect.top - detailRect.top,
      lessThan(40),
      reason: '按钮在详情顶部操作区，不跟着下方 chip 走',
    );
    // 锁态：徽标与「缺少依赖」提示同时在场，一眼能看出缺依赖。
    expect(find.text('locked'), findsOneWidget);
    expect(find.text('缺少依赖'), findsOneWidget);
    expect(find.text('缺少依赖：装好角色包后才可以被派工。'), findsOneWidget);
  });

  testWidgets('1350×900 第一屏：四个角色状态与会话空态都在视口内', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    api.profiles = _rolePackages();
    await pumpPage(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-empty')));

    for (final id in <String>['researcher', 'coder', 'officer', 'design']) {
      final rect = tester.getRect(
        find.byKey(ValueKey('subagents-profile-$id')),
      );
      expect(rect.top, greaterThan(0));
      expect(
        rect.bottom,
        lessThanOrEqualTo(900),
        reason: '四个角色包都要在第一屏里，不再把会话区顶到屏外',
      );
    }
    final emptyRect = tester.getRect(
      find.byKey(const ValueKey('subagents-empty')),
    );
    expect(emptyRect.top, greaterThan(0));
    expect(
      emptyRect.bottom,
      lessThanOrEqualTo(900),
      reason: '角色区收紧后，会话空态第一屏就能看到',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('英文界面：页面 chrome 全英文', (tester) async {
    api.enabled = true;
    api.items = <Map<String, dynamic>>[];
    api.profiles = _rolePackages();
    await pumpPage(tester, english: true);
    await pumpUntil(tester, find.byKey(const ValueKey('subagents-empty')));
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('subagents-profiles-split')),
    );
    expect(find.text('Subagents'), findsWidgets);
    expect(find.text('No subagent sessions yet'), findsOneWidget);
    expect(find.text('Active'), findsWidgets);
    expect(find.text('Archived'), findsOneWidget);
    expect(find.text('Profiles'), findsOneWidget);
    // Profile 卡的 chrome 也必须全英文（徽标沿用后端状态字 available/locked）。
    expect(find.text('locked'), findsOneWidget);
    expect(find.text('Verify'), findsOneWidget);
    expect(find.text('Skills'), findsOneWidget);
    expect(find.text('MCP'), findsOneWidget);
    expect(find.text('Missing dependencies'), findsOneWidget);
    expect(find.text('Needs install'), findsWidgets);
  });
}
