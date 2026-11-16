import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/plugin_view.dart';
import 'package:irmia_gui/theme.dart';

const _tinyPngDataUrl =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

class _FakePluginApi extends IrmiaApi {
  _FakePluginApi(this.getHandler, this.postHandler)
      : super(baseUrl: 'http://127.0.0.1:7788', token: 'test-token');

  final dynamic Function(String path) getHandler;
  final dynamic Function(String path, Map<String, dynamic> body) postHandler;
  final gets = <String>[];
  final posts = <({String path, Map<String, dynamic> body})>[];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    gets.add(path);
    return getHandler(path);
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add((path: path, body: body));
    return postHandler(path, body);
  }
}

void main() {
  testWidgets('PluginViewPage supports tabs, base64 sticker cards, approve/edit/confirm actions, and forms',
      (tester) async {
    tester.view.physicalSize = const Size(1280, 960);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    late _FakePluginApi api;
    api = _FakePluginApi(
      (path) {
        final uri = Uri.parse(path);
        final tab = uri.queryParameters['tab'] ?? 'pending';
        if (tab == 'settings') {
          return {
            'title': '梗百科与表情设置',
            'blocks': [
              {
                'type': 'tabs',
                'active': 'settings',
                'items': [
                  {'id': 'pending', 'label': '待审核 (1)'},
                  {'id': 'settings', 'label': '设置'},
                ],
              },
              {
                'type': 'form',
                'title': '参数调节',
                'action': 'save_settings',
                'submitLabel': '保存配置',
                'fields': [
                  {'key': 'autoLookup', 'label': '自动预查消息里的梗', 'type': 'switch', 'value': true},
                  {'key': 'trollLevel', 'label': '串子程度', 'type': 'slider', 'min': 0, 'max': 100, 'divisions': 10, 'value': 50},
                  {'key': 'nickname', 'label': '称呼', 'type': 'text', 'value': '林芮'},
                ],
              },
            ],
          };
        }
        return {
          'title': '表情包审核台',
          'blocks': [
            {
              'type': 'tabs',
              'active': 'pending',
              'items': [
                {'id': 'pending', 'label': '待审核 (1)'},
                {'id': 'settings', 'label': '设置'},
              ],
            },
            {
              'type': 'grid',
              'title': '待审队列',
              'items': [
                {
                  'title': '猫猫盯',
                  'badge': '无语',
                  'tone': 'warn',
                  'image': _tinyPngDataUrl,
                  'dots': {'filled': 3, 'total': 5},
                  'chips': ['猫猫', '盯'],
                  'actions': [
                    {
                      'label': '通过',
                      'tone': 'ok',
                      'action': 'approve',
                      'params': {'id': 'stk-1'},
                    },
                    {
                      'label': '改分类',
                      'action': 'edit_item',
                      'params': {'id': 'stk-1'},
                      'promptFields': [
                        {
                          'key': 'emotion',
                          'label': '主情绪',
                          'type': 'select',
                          'value': '无语',
                          'options': ['开心', '无语', '得意'],
                        },
                        {
                          'key': 'tags',
                          'label': '标签',
                          'type': 'text',
                          'value': '猫猫,盯',
                        },
                      ],
                    },
                    {
                      'label': '拒绝拉黑',
                      'tone': 'err',
                      'action': 'reject_block',
                      'confirm': '确定拒绝并加入黑名单？',
                      'params': {'id': 'stk-1'},
                    },
                  ],
                },
              ],
            },
          ],
        };
      },
      (path, body) => {'ok': true, 'message': '已执行：${body['action']}'},
    );

    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(
        body: PluginViewPage(
          state: AppState(api: api),
          pluginId: 'linre-stickers',
          viewId: 'stickers',
        ),
      ),
    ));
    await tester.pumpAndSettle();

    expect(find.text('猫猫盯'), findsOneWidget);
    expect(find.byType(Image), findsOneWidget);

    await tester.tap(find.text('通过'));
    await tester.pumpAndSettle();
    expect(api.posts.last.path, '/api/plugin/linre-stickers/ui/stickers');
    expect(api.posts.last.body, {'action': 'approve', 'id': 'stk-1'});

    await tester.tap(find.text('改分类'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('得意'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '坏笑,叉腰');
    await tester.tap(find.text('确定'));
    await tester.pumpAndSettle();
    expect(api.posts.last.body, {
      'action': 'edit_item',
      'id': 'stk-1',
      'emotion': '得意',
      'tags': '坏笑,叉腰',
    });

    await tester.tap(find.text('拒绝拉黑'));
    await tester.pumpAndSettle();
    expect(find.text('确定拒绝并加入黑名单？'), findsOneWidget);
    await tester.tap(find.text('确定'));
    await tester.pumpAndSettle();
    expect(api.posts.last.body, {'action': 'reject_block', 'id': 'stk-1'});

    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    expect(api.gets.last, '/api/plugin/linre-stickers/ui/stickers?tab=settings');
    expect(find.text('保存配置'), findsOneWidget);

    await tester.tap(find.text('自动预查消息里的梗'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('保存配置'));
    await tester.pumpAndSettle();
    expect(api.posts.last.body['action'], 'save_settings');
    expect(api.posts.last.body['autoLookup'], false);
    expect(api.posts.last.body['trollLevel'], 50);
    expect(api.posts.last.body['nickname'], '林芮');
  });
}
