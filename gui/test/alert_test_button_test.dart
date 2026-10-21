import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/channels_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 「告警出口」那颗**测试**按钮（`POST /api/commands/webhook-test` 的前端那一半）。
///
/// 来源：docs/repo-cleanliness-audit.md §8（总表 D5）。后端在生产里可用（`notifier` 已注入，
/// src/main.ts:316 → Web；实现见 src/web/server.ts:4564），而界面 0 调用——"改了 webhook 地址
/// 却不知道通不通"。
///
/// **接点为什么在这一页**：出口地址 `alerts.webhookUrl` 这格就在**渠道页**的
/// 「Webhook 与文件监听」配置卡里（gui/lib/pages/channels_page.dart 的 `_hookFields`）。
/// 审计稿把接点写成"设置页外部回调卡"，但那张卡说的是**另一个**通道：`POST /webhook/*` 的
/// **入站**专用凭据（外部投递进来）；而这颗按钮测的是**出站**告警地址——按钮必须摆在地址那一格旁边，
/// 否则人根本看不到自己测的是哪个地址。
///
/// 这一组锁四件事：
///   ① 它只长在有出口地址的那一项上（QQ / OneBot 两卡没有）；
///   ② 点它发 `webhook-test` + 空 body（服务端只认生效配置，短语为 null ⇒ 不带 X-Confirm）；
///   ③ **送达失败也是 HTTP 200**（`{ok:false, reason}`）——此时必须说"没送到 + 原因"，
///      绝不能因为"没抛错"就说成测通了；
///   ④ 出口没配（服务端 400）时原样转达服务端那句话。
class _Post {
  const _Post(this.path, this.body, this.confirm);
  final String path;
  final Map<String, dynamic> body;
  final String? confirm;
}

class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;
  final List<_Post> posts = [];

  /// 下一次 webhook-test 的回包（默认：送达成功）
  Map<String, dynamic> reply = const {
    'ok': true, 'sent': true, 'url': 'https://example.test/hook', 'reason': null,
  };

  /// 非 null 时该命令抛这个错（出口没配 = 服务端 400）
  Object? failWith;

  @override
  Future<dynamic> get(String path) async {
    if (path.startsWith('/api/events')) return routes['/api/events'];
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add(_Post(path, body, confirm));
    final failure = failWith;
    if (failure != null) throw failure;
    return reply;
  }
}

const _hookChannel = 'Webhook 与文件监听';

Map<String, dynamic> _config({String webhookUrl = 'https://example.test/hook'}) => {
      'channels': {
        'qqOfficial': {'enabled': true, 'appIdEnv': 'QQ_BOT_APPID', 'clientSecretEnv': 'QQ_BOT_SECRET'},
        'onebot': {'enabled': false, 'wsUrl': 'ws://127.0.0.1:3001'},
      },
      'alerts': {'webhookUrl': webhookUrl, 'rateLimitMin': 5},
      'web': {'host': '127.0.0.1', 'port': 7788},
    };

void main() {
  // 本机忽略标记会落 ui_state：测试指向临时文件，别踩真实 %APPDATA% 里的状态
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-alert-test.json';
  });

  Future<_FakeApi> pump(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final api = _FakeApi({
      '/api/config': _config(),
      '/api/keys': {
        'qqAppId': {'configured': false, 'mask': null},
        'qqClientSecret': {'configured': false, 'mask': null},
      },
      // 出口地址非空即"这条通道开着"，列表上的状态点取它
      '/api/sessions': {'sessions': <dynamic>[], 'unreadTotal': 0},
      '/api/events': {'events': <dynamic>[]},
    });
    final state = AppState(api: api);
    addTearDown(state.dispose);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ChannelsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return api;
  }

  /// 切到「Webhook 与文件监听」那一项（出口地址所在的配置卡在它的详情里）
  Future<void> selectHook(WidgetTester tester) async {
    await tester.tap(find.text(_hookChannel).first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }

  Finder testBtn() => find.byKey(const ValueKey('alert-test'));

  testWidgets('① 测试按钮只长在「Webhook 与文件监听」的配置卡上', (tester) async {
    await pump(tester);

    // 首屏是 QQ 官方 Bot：它的配置卡上不许有这颗按钮（那条通道与告警出口无关）
    expect(find.text('通道配置'), findsOneWidget);
    expect(testBtn(), findsNothing);
    expect(find.text('测试告警出口'), findsNothing);

    await selectHook(tester);

    expect(testBtn(), findsOneWidget);
    expect(find.text('测试告警出口'), findsOneWidget);
    // 出口地址那一格也在同一张卡里（按钮与它测的地址同屏，人才不会测错对象）
    expect(find.text('告警出口 webhook'), findsOneWidget);
  });

  testWidgets('② 点它：发 webhook-test + 空 body，送达成功给成功回执', (tester) async {
    final api = await pump(tester);
    await selectHook(tester);

    expect(api.posts, isEmpty, reason: '还没点过，一条命令都不该发');

    await tester.tap(testBtn());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(api.posts.length, 1);
    expect(api.posts.single.path, '/api/commands/webhook-test');
    expect(api.posts.single.body, isEmpty,
        reason: '只认生效配置里的出口：请求里带 url 反而会被服务端 400 挡回来');
    expect(api.posts.single.confirm, isNull, reason: 'CONFIRM_PHRASES 里它是 null：不写状态、短语为 null');
    expect(find.textContaining('已送达'), findsOneWidget);
    // 回执要说清送到哪儿了（用整句而不是 textContaining：那个 URL 在配置卡的输入框里也有一份，
    // 只按子串找会一次命中两个）
    expect(find.text('已送达：https://example.test/hook 收到了这条测试消息'), findsOneWidget);
  });

  testWidgets('③ 送达失败也回 200：必须说"没送到 + 原因"，不许说成测通了', (tester) async {
    final api = await pump(tester);
    await selectHook(tester);
    // 服务端的失败形状：HTTP 200 + {ok:false, sent:false, reason}
    api.reply = const {
      'ok': false, 'sent': false, 'url': 'https://example.test/hook', 'reason': '连接被拒绝（ECONNREFUSED）',
    };

    await tester.tap(testBtn());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.textContaining('没送到'), findsOneWidget);
    expect(find.textContaining('连接被拒绝'), findsOneWidget, reason: '原因原样转达，别自己编一句');
    expect(find.textContaining('已送达'), findsNothing, reason: '这是最容易说错的一格：没抛错 ≠ 送到了');
  });

  testWidgets('④ 出口没配（服务端 400）：原样转达服务端那句话', (tester) async {
    final api = await pump(tester);
    await selectHook(tester);
    api.failWith = const ApiError(
      400,
      '生效配置里没有 alerts.webhookUrl：先在管控页保存出口地址，再测',
    );

    await tester.tap(testBtn());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.textContaining('测试失败'), findsOneWidget);
    expect(find.textContaining('先在管控页保存出口地址'), findsOneWidget);
  });
}
