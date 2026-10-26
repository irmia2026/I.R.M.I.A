import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/pages/plugins_panel.dart';
import 'package:irmia_gui/theme.dart';

class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;
  final posts = <({String path, Map<String, dynamic> body, String? confirm})>[];
  final postReplies = <String, dynamic>{};
  Object? pluginsError;
  Completer<dynamic>? pluginsPending;
  Completer<dynamic>? postPending;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/plugins') {
      if (pluginsError != null) throw pluginsError!;
      if (pluginsPending != null) return pluginsPending!.future;
    }
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add((path: path, body: body, confirm: confirm));
    if (postPending != null) return postPending!.future;
    return postReplies[path] ?? {'ok': true};
  }
}

Map<String, dynamic> plugin(
  String state, {
  String id = 'demo',
  String hash = 'abc123def456',
  bool requiresRestart = false,
  List<String> permissions = const ['filesystem.read'],
  List<String> problems = const [],
  Map<String, dynamic>? circuit,
}) =>
    {
      'package': {
        'contentHash': hash,
        'manifest': {
          'id': id,
          'version': '1.2.3',
          'contributions': {
            'skills': ['skills/one', 'skills/two'],
            'hooks': 'hooks.json',
            'mcp': 'mcp.json',
          },
          'permissions': permissions,
        },
      },
      'state': state,
      'problems': problems,
      'requiresRestart': requiresRestart,
      if (circuit != null) 'circuit': circuit,
    };

void main() {
  final emptyRoutes = <String, dynamic>{
    '/api/skills': {'items': <dynamic>[], 'rejected': <dynamic>[], 'ignored': <dynamic>[]},
    '/api/mcp': {'servers': <dynamic>[], 'problems': <dynamic>[]},
    '/api/grants': {'items': <dynamic>[]},
    '/api/tools': {'groups': <dynamic>[], 'tools': <dynamic>[]},
    '/api/hooks': {'entries': <dynamic>[], 'problems': <dynamic>[]},
    '/api/plugins': {'items': <dynamic>[]},
  };

  Future<_FakeApi> pumpPanel(
    WidgetTester tester, {
    dynamic plugins = const <dynamic>[],
    bool narrow = false,
  }) async {
    tester.view.physicalSize = Size(narrow ? 700 : 1400, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = _FakeApi({...emptyRoutes, '/api/plugins': plugins});
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: AppState(api: api))),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(const ValueKey('ext-item-plugins')));
    await tester.pump();
    return api;
  }

  test('parsePluginsResponse accepts the real envelope and documented alternatives only', () {
    final item = plugin('disabled');
    expect(parsePluginsResponse({'items': [item]}), [item]);
    expect(parsePluginsResponse([item]), [item]);
    expect(parsePluginsResponse({'plugins': [item]}), [item]);
    expect(() => parsePluginsResponse({'items': {}}), throwsFormatException);
    expect(() => parsePluginsResponse(null), throwsFormatException);
  });

  testWidgets('empty, loading and error states use the existing Extensions state flow', (tester) async {
    await pumpPanel(tester);
    expect(find.byKey(const ValueKey('plugins-empty')), findsOneWidget);

    final loadingApi = _FakeApi(emptyRoutes)..pluginsPending = Completer<dynamic>();
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: AppState(api: loadingApi))),
    ));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('ext-item-plugins')));
    await tester.pump();
    expect(find.byType(LinearProgressIndicator), findsWidgets);
    expect(find.byKey(const ValueKey('plugins-empty')), findsNothing);
    loadingApi.pluginsPending!.complete({'items': <dynamic>[]});
    await tester.pump();

    final errorApi = _FakeApi(emptyRoutes)..pluginsError = StateError('offline');
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ExtensionsPage(state: AppState(api: errorApi))),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.tap(find.byKey(const ValueKey('ext-item-plugins')));
    await tester.pump();
    expect(find.text('数据读取失败'), findsOneWidget);
    expect(find.textContaining('offline'), findsOneWidget);
  });

  testWidgets('install requires an absolute local directory and sends only install confirmation', (tester) async {
    final api = await pumpPanel(tester);
    await tester.tap(find.byKey(const ValueKey('plugin-install')));
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('plugin-source-dir')), 'relative/plugin');
    await tester.tap(find.byKey(const ValueKey('plugin-install-submit')));
    await tester.pump();
    expect(api.posts, isEmpty);
    expect(find.text('请输入绝对本地目录'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('plugin-source-dir')), r'C:\packages\demo');
    await tester.tap(find.byKey(const ValueKey('plugin-install-submit')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.single.path, '/api/commands/plugin-install');
    expect(api.posts.single.body, {'sourceDir': r'C:\packages\demo'});
    expect(api.posts.single.confirm, 'plugin-install');
    expect(find.textContaining('待审核'), findsWidgets);
  });

  testWidgets('untrusted review shows identity, contributions and permissions before confirm', (tester) async {
    final api = await pumpPanel(tester, plugins: {
      'items': [plugin('untrusted')],
    });
    expect(find.text('demo'), findsOneWidget);
    expect(find.textContaining('1.2.3', findRichText: true), findsWidgets);
    expect(find.textContaining('abc123def456', findRichText: true), findsWidgets);
    expect(find.text('Skills 2 · Hooks 1 · MCP 1'), findsOneWidget);
    expect(find.textContaining('filesystem.read'), findsOneWidget);
    expect(find.byKey(const ValueKey('plugin-enable-demo')), findsNothing);
    expect(find.byKey(const ValueKey('plugin-disable-demo')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('plugin-review-demo')));
    await tester.pump();
    expect(find.textContaining('可信代码'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('plugin-review-confirm')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.single.path, '/api/commands/plugin-confirm');
    expect(api.posts.single.body, {'id': 'demo', 'contentHash': 'abc123def456'});
    expect(api.posts.single.confirm, 'plugin-confirm');
  });

  testWidgets('invalid shows problems and offers no trust or lifecycle action', (tester) async {
    await pumpPanel(tester, plugins: {
      'items': [plugin('invalid', problems: ['content hash mismatch', 'manifest changed'])],
    });
    expect(find.text('content hash mismatch'), findsOneWidget);
    expect(find.text('manifest changed'), findsOneWidget);
    expect(find.byKey(const ValueKey('plugin-review-demo')), findsNothing);
    expect(find.byKey(const ValueKey('plugin-enable-demo')), findsNothing);
    expect(find.byKey(const ValueKey('plugin-disable-demo')), findsNothing);
  });

  testWidgets('disabled enable sends id and hash and reports restart effectiveness', (tester) async {
    final api = await pumpPanel(tester, plugins: {
      'items': [plugin('disabled')],
    });
    api.postReplies['/api/commands/plugin-enable'] = {'ok': true, 'restartRequired': true};
    await tester.tap(find.byKey(const ValueKey('plugin-enable-demo')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('plugin-action-confirm')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.single.path, '/api/commands/plugin-enable');
    expect(api.posts.single.body, {'id': 'demo', 'contentHash': 'abc123def456'});
    expect(api.posts.single.confirm, 'plugin-enable');
    expect(find.textContaining('重启后生效'), findsWidgets);
    expect(find.textContaining('已即时激活'), findsNothing);
  });

  testWidgets('enabled disable uses its own confirmation phrase and pending restart is visible', (tester) async {
    final api = await pumpPanel(tester, plugins: {
      'items': [plugin('enabled', requiresRestart: true)],
    });
    expect(find.text('重启后生效'), findsOneWidget);
    api.postReplies['/api/commands/plugin-disable'] = {'ok': true, 'restartRequired': true};
    await tester.tap(find.byKey(const ValueKey('plugin-disable-demo')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('plugin-action-confirm')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts.single.path, '/api/commands/plugin-disable');
    expect(api.posts.single.body, {'id': 'demo', 'contentHash': 'abc123def456'});
    expect(api.posts.single.confirm, 'plugin-disable');
    expect(find.textContaining('重启后生效'), findsWidgets);
  });

  testWidgets('quarantined and probing expose circuit contribution, count, reason and retry', (tester) async {
    await pumpPanel(tester, plugins: {
      'items': [
        plugin('quarantined', id: 'broken', circuit: {
          'contributionKind': 'mcp',
          'contributionName': 'search',
          'category': 'timeout',
          'count': 3,
          'retryAt': '2026-10-24T12:30:00.000Z',
          'lastError': 'socket timeout',
        }),
        plugin('probing', id: 'recovering', circuit: {
          'contributionKind': 'hooks',
          'contributionName': 'before-tool',
          'count': 4,
          'retryAt': '2026-10-24T12:31:00.000Z',
          'lastError': 'process exited',
        }),
      ],
    });
    expect(find.text('已隔离'), findsOneWidget);
    expect(find.text('正在探测'), findsOneWidget);
    expect(find.textContaining('mcp/search'), findsOneWidget);
    expect(find.textContaining('socket timeout'), findsOneWidget);
    expect(find.textContaining('2026-10-24T12:30:00.000Z'), findsOneWidget);
    expect(find.textContaining('hooks/before-tool'), findsOneWidget);
    expect(find.textContaining('4'), findsWidgets);
  });

  testWidgets('pending plugin action disables actions and prevents duplicate writes', (tester) async {
    final api = await pumpPanel(tester, plugins: {'items': [plugin('disabled')]});
    api.postPending = Completer<dynamic>();
    await tester.tap(find.byKey(const ValueKey('plugin-enable-demo')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('plugin-action-confirm')));
    await tester.pump();
    final button = tester.widget<TextButton>(find.byKey(const ValueKey('plugin-enable-demo')));
    expect(button.onPressed, isNull);
    await tester.tap(find.byKey(const ValueKey('plugin-enable-demo')), warnIfMissed: false);
    expect(api.posts, hasLength(1));
    api.postPending!.complete({'ok': true, 'restartRequired': true});
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(api.posts, hasLength(1));
  });

  testWidgets('narrow layout keeps Plugins in the existing list-to-detail flow', (tester) async {
    await pumpPanel(tester, narrow: true);
    expect(find.byKey(const ValueKey('plugins-empty')), findsOneWidget);
    await tester.tap(find.text('扩展项列表'));
    await tester.pump();
    expect(find.byKey(const ValueKey('ext-item-plugins')), findsOneWidget);
    expect(find.byKey(const ValueKey('plugins-empty')), findsNothing);
  });
}
