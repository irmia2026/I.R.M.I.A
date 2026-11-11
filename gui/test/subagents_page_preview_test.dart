import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/theme.dart';

/// 子代理管理页的**肉眼验收图**：1350×900，light / dark 各一张。
///
/// 不出断言，出 PNG：
///   tmp/subagents-page-light.png
///   tmp/subagents-page-dark.png
///
/// 图里走完整窗口（左侧 220 的侧栏 + 页面），这样截到的内容宽度与用户 1350 宽窗口一致；
/// 只截页面本身会把内容区算宽 220，窄窗下的折行反而验收不到。默认选中「编码」——
/// 它缺 10 项依赖，是旧版被长 missing 撑高的最坏现场。
///
/// 默认 skip：截图依赖本机字体；要出图时显式跑：
///
///     PowerShell:  $env:IRMIA_PREVIEW=1; flutter test test/subagents_page_preview_test.dart
///
/// 数据是固定假数据，只走 P3.1/P4.1 API 的响应形状，不碰真后端。
final bool _enabled = Platform.environment['IRMIA_PREVIEW'] == '1';

const _fontCandidates = <String>[
  r'C:\Windows\Fonts\simhei.ttf',
  r'C:\Windows\Fonts\Deng.ttf',
  r'C:\Windows\Fonts\msyh.ttc',
];

Future<void> _loadFont(String family) async {
  for (final path in _fontCandidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = await file.readAsBytes();
    final loader = FontLoader(family)
      ..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
    await loader.load();
    return;
  }
}

/// 测试环境只有 Ahem；Material 会从 `textTheme` 取默认样式，而主题的三档字只换了
/// 字号/行高，没带 fontFamily。出图时把字体补回 theme 的 textTheme，并给 monospace
/// 也注册一份中文字体，否则列表与 id 会是一排方块。
ThemeData _previewTheme(bool dark) {
  final base = dark ? IrmiaTheme.dark() : IrmiaTheme.light();
  return base.copyWith(
    textTheme: base.textTheme.apply(fontFamily: IrmiaTheme.windowsUiFont),
    primaryTextTheme: base.primaryTextTheme.apply(
      fontFamily: IrmiaTheme.windowsUiFont,
    ),
  );
}

Future<void> _loadIconFont() async {
  final roots = <String?>[
    Platform.environment['FLUTTER_ROOT'],
    () {
      var dir = File(Platform.resolvedExecutable).parent;
      for (var i = 0; i < 8; i += 1) {
        final cache = Directory(
          '${dir.path}${Platform.pathSeparator}bin${Platform.pathSeparator}cache',
        );
        if (cache.existsSync()) return dir.path;
        final parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
      return null;
    }(),
  ];
  for (final root in roots) {
    if (root == null || root.isEmpty) continue;
    final file = File(
      '$root${Platform.pathSeparator}bin${Platform.pathSeparator}cache'
      '${Platform.pathSeparator}artifacts${Platform.pathSeparator}material_fonts'
      '${Platform.pathSeparator}materialicons-regular.otf',
    );
    if (!file.existsSync()) continue;
    final bytes = await file.readAsBytes();
    final loader = FontLoader('MaterialIcons')
      ..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
    await loader.load();
    return;
  }
}

Map<String, dynamic> _item({
  required String id,
  required String profile,
  required String label,
  required String status,
  required bool canCancel,
  required bool canResume,
  String? preview,
  int used = 1200,
  int limit = 8000,
}) {
  const created = '2026-11-05T00:52:00.000Z';
  const updated = '2026-11-05T01:04:00.000Z';
  return <String, dynamic>{
    'agentId': id,
    'profileId': profile,
    'label': label,
    'status': status,
    'parentCallId': 'call-$id',
    'parentTurn': 12,
    'createdAt': created,
    'updatedAt': updated,
    'lastReportPreview': preview,
    'tokens': <String, dynamic>{'used': used, 'limit': limit},
    'canResume': canResume,
    'canCancel': canCancel,
  };
}

final Map<String, dynamic> _selectedItem = _item(
  id: 'sub-7a391e42-6bb8-4f8e-a8f9-1c5d9ad317c2',
  profile: 'research',
  label: '调研',
  status: 'running',
  canCancel: true,
  canResume: false,
  preview: '三组证据已核对，正在补齐来源与未解决项。',
  used: 3240,
  limit: 8000,
);

final List<Map<String, dynamic>> _items = <Map<String, dynamic>>[
  _selectedItem,
  _item(
    id: 'sub-22c4b8de-c7d4-4f0c-9ed5-13f4af216580',
    profile: 'coding',
    label: '编码',
    status: 'queued',
    canCancel: true,
    canResume: false,
    preview: '等待前一个子代理释放并发槽位。',
    used: 0,
    limit: 12000,
  ),
  _item(
    id: 'sub-9a5f3f70-1e7d-45f3-9b5d-1bb2bc42f0a7',
    profile: 'general',
    label: '通用',
    status: 'interrupted',
    canCancel: true,
    canResume: true,
    preview: '已读到配置文件，重启后需要继续核对。',
    used: 1880,
    limit: 8000,
  ),
  _item(
    id: 'sub-1f76d9c4-1f96-4589-9d0a-09f5fd7dcc5b',
    profile: 'docs',
    label: '文档',
    status: 'completed',
    canCancel: false,
    canResume: true,
    preview: '文档草稿已写入自己的 workspace，共 4 节。',
    used: 4630,
    limit: 8000,
  ),
  _item(
    id: 'sub-6da102b0-4c53-4bd7-aaf9-3e8b4057f2bf',
    profile: 'review',
    label: '审查',
    status: 'archived',
    canCancel: false,
    canResume: true,
    preview: '没有发现阻断级问题。',
    used: 2760,
    limit: 8000,
  ),
];

/// P4.1 摘要形状：四个内置角色包，初始状态全部 locked（角色包还没装）。
///
/// missing 按各角色的真实 requires 抄：编码缺 10 项，是旧版把卡片撑高的那一条；
/// 现在它必须只占一行，放不下的收进「+N」。
Map<String, dynamic> _profile({
  required String id,
  required String label,
  required String description,
  required int toolCount,
  String workdir = 'workspace',
  String shell = 'workspace',
  String reasoningEffort = 'max',
  List<String> skills = const <String>[],
  List<String> mcpServers = const <String>[],
  List<String> missing = const <String>[],
}) => <String, dynamic>{
  'id': id,
  'label': label,
  'description': description,
  'toolCount': toolCount,
  'workspace': 'own',
  'lane': 'heavy',
  'workdir': workdir,
  'shell': shell,
  'reasoningEffort': reasoningEffort,
  'contextLimit': 1000000,
  'compactAt': 0.7,
  'skills': skills,
  'mcpServers': mcpServers,
  'available': missing.isEmpty,
  'locked': missing.isNotEmpty,
  'missing': missing,
};

final List<Map<String, dynamic>> _profiles = <Map<String, dynamic>>[
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
    missing: <String>['office', 'human-copywrite', 'markitdown', 'python', 'uvx'],
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

final List<Map<String, dynamic>> _events = <Map<String, dynamic>>[
  _event(1201, 'subagent/started', {
    'agentId': _selectedItem['agentId'],
    'profileId': 'research',
    'parentCallId': 'call-7a39',
    'parentTurn': 12,
    'tokens': {'used': 0, 'limit': 8000},
  }),
  _event(1204, 'subagent/report', {
    'agentId': _selectedItem['agentId'],
    'kind': 'progress',
    'reportId': 'report-1',
    'summary': '已定位三组证据，正在补齐来源链接。',
    'tokens': {'used': 1400, 'limit': 8000},
  }),
  _event(1209, 'subagent/report', {
    'agentId': _selectedItem['agentId'],
    'kind': 'progress',
    'reportId': 'report-2',
    'summary': '四条来源已核对，剩一个未解决项。',
    'tokens': {'used': 3240, 'limit': 8000},
  }),
];

Map<String, dynamic> _event(int seq, String type, Map<String, dynamic> data) =>
    <String, dynamic>{
      'seq': seq,
      'ts': '2026-11-05T01:03:00.000Z',
      'type': type,
      'data': data,
    };

class _PreviewApi extends IrmiaApi {
  _PreviewApi() : super(baseUrl: 'http://127.0.0.1:1');

  final StreamController<Map<String, dynamic>> feed =
      StreamController<Map<String, dynamic>>.broadcast();

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/subagents?includeArchived=1') {
      return <String, dynamic>{'enabled': true, 'items': _items};
    }
    if (path == '/api/subagents/profiles') {
      return <String, dynamic>{'enabled': true, 'items': _profiles};
    }
    if (path.startsWith('/api/subagents/')) {
      final id = Uri.decodeComponent(path.substring('/api/subagents/'.length));
      final item = _items.firstWhere(
        (entry) => entry['agentId'] == id,
        orElse: () => _selectedItem,
      );
      return <String, dynamic>{
        'enabled': true,
        ...item,
        'lastReport':
            '调研结论：\n'
            '1. 三条候选路径都能走通，其中第二条成本最低；\n'
            '2. 现有设计中「恢复」与「重新入队」是同一个动作，界面只显示 canResume；\n'
            '3. 未解决项：归档后的 TTL 清理还没有自动任务，暂时由人保留。',
        'headError': null,
      };
    }
    if (path.startsWith('/api/events')) {
      return <String, dynamic>{'events': _events};
    }
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<dynamic> post(
    String path,
    Map<String, dynamic> body, {
    String? confirm,
    Duration? timeout,
  }) async => <String, dynamic>{'ok': true};

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => feed.stream;
}

void main() {
  setUpAll(() async {
    await _loadFont(IrmiaTheme.windowsUiFont);
    await _loadFont('monospace');
    await _loadIconFont();
  });

  testWidgets(
    '子代理页预览：1350×900 light / dark',
    (tester) async {
      final api = _PreviewApi();
      final state = AppState(api: api);
      state.pageId = 'subagents';
      addTearDown(state.dispose);
      tester.view.physicalSize = const Size(1350, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      // 截完整窗口（左侧 220 的侧栏 + 页面）：与用户 1350×900 的实机一致，
      // 内容区才是真实可用宽度，窄窗折行才验收得到。
      Widget page(ThemeData theme) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: theme,
        home: Scaffold(
          body: RepaintBoundary(
            key: const ValueKey('subagents-preview'),
            child: MediaQuery(
              data: const MediaQueryData(
                size: Size(1350, 900),
                disableAnimations: true,
              ),
              child: DefaultTextStyle.merge(
                style: const TextStyle(
                  fontFamily: IrmiaTheme.windowsUiFont,
                  fontSize: 13,
                ),
                child: HomeShell(state: state),
              ),
            ),
          ),
        ),
      );

      // 选中「编码」：它缺 10 项依赖，正好验收长 missing 只会占一行。
      // 会话区保持未选中——第一屏要同时看到角色状态、会话列表与会话空态。
      Future<void> settlePreview() async {
        var ready = false;
        for (var i = 0; i < 160; i += 1) {
          await tester.pump(const Duration(milliseconds: 20));
          if (find
              .byKey(const ValueKey('subagents-profile-coder'))
              .evaluate()
              .isNotEmpty) {
            ready = true;
            break;
          }
        }
        expect(ready, isTrue, reason: '角色包列表没有加载出来');
        await tester.tap(find.byKey(const ValueKey('subagents-profile-coder')));
        await tester.pump(const Duration(milliseconds: 350));
        expect(
          find.byKey(const ValueKey('subagents-profile-detail-coder')),
          findsOneWidget,
        );
        await tester.pump(const Duration(milliseconds: 350));
      }

      final workspace = Directory.current.path.endsWith('gui')
          ? Directory.current.parent.path
          : Directory.current.path;
      Future<void> capture(String name) async {
        final boundary = tester.renderObject<RenderRepaintBoundary>(
          find.byKey(const ValueKey('subagents-preview')),
        );
        final bytes = await tester.runAsync(() async {
          final image = await boundary.toImage(pixelRatio: 1);
          expect(image.width, 1350);
          expect(image.height, 900);
          final data = await image.toByteData(format: ui.ImageByteFormat.png);
          image.dispose();
          return data!.buffer.asUint8List();
        });
        final target = File(
          '$workspace${Platform.pathSeparator}tmp'
          '${Platform.pathSeparator}subagents-page-$name.png',
        );
        await tester.runAsync(() async {
          await target.parent.create(recursive: true);
          await target.writeAsBytes(bytes!);
        });
        debugPrint('subagents page preview ($name): ${target.path}');
      }

      await tester.pumpWidget(page(_previewTheme(false)));
      await settlePreview();
      await capture('light');
      await tester.pumpWidget(page(_previewTheme(true)));
      await settlePreview();
      await capture('dark');
    },
    skip: !_enabled,
    timeout: const Timeout(Duration(seconds: 90)),
  );
}
