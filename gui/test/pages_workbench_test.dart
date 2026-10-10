import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/channels_page.dart';
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 任务四的版式冒烟 + 渠道页的就地配置：渠道页的「左列表 + 右详情工作台」（窄窗降级）、
/// 扩展页的行尾 icon-only 动作。数据用 IrmiaApi 替身直接喂，不发真实请求：
/// 断言只针对骨架、状态词、提交内容与 tooltip，不依赖后端进程。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  /// 收到的写请求（渠道页的就地配置走 config-update，要断言提交了哪些字段）
  final posts = <({String path, Map<String, dynamic> body, String? confirm})>[];

  @override
  Future<dynamic> get(String path) async {
    if (path.startsWith('/api/events')) return routes['/api/events'];
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    posts.add((path: path, body: body, confirm: confirm));
    return {'ok': true};
  }
}

/// 最近一次 pump 出来的替身：写请求断言都看它
_FakeApi? _lastApi;

void main() {
  // 本机忽略标记会落 ui_state：测试指向临时文件，别踩真实 %APPDATA% 里的状态
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-test.json';
  });

  final config = <String, dynamic>{
    'channels': {
      'qqOfficial': {
        'enabled': true,
        'appIdEnv': 'QQ_BOT_APPID',
        'clientSecretEnv': 'QQ_BOT_SECRET',
        'apiBase': 'https://api.sgroup.qq.com',
        'tokenUrl': 'https://bots.qq.com/app/getAppAccessToken',
        'gatewayUrl': '',
      },
      'onebot': {'enabled': false, 'wsUrl': 'ws://127.0.0.1:3001', 'tokenEnv': 'ONEBOT_TOKEN'},
    },
    'alerts': {'webhookUrl': 'http://127.0.0.1:9000/hook', 'rateLimitMin': 5},
    'web': {'host': '127.0.0.1', 'port': 7788},
  };
  final events = <String, dynamic>{
    'events': [
      {
        'ts': '2026-09-30T02:00:00.000Z',
        'type': 'wake/channel',
        'seq': 12,
        'data': {'channel': 'qq-official', 'chatType': 'group', 'text': '在吗'},
      },
      // 第二条是给「行分隔线只在行之间」那条断言用的（要两行才看得出对比）
      {
        'ts': '2026-09-30T01:00:00.000Z',
        'type': 'wake/channel',
        'seq': 11,
        'data': {'channel': 'qq-official', 'chatType': 'c2c', 'text': '早上好'},
      },
    ],
  };
  final skills = <String, dynamic>{
    'items': [
      {
        'name': 'demo-skill',
        'trust': 'never-confirmed',
        'inCatalog': false,
        'ignored': false,
        'description': '演示技能',
        'skillPath': 'skills/demo-skill/SKILL.md',
        'bytes': 123,
        'contentHash': 'abcdef1234567890',
        'trustDetail': '从未确认',
      },
      {
        'name': 'trusted-skill',
        'trust': 'trusted',
        'inCatalog': true,
        'ignored': false,
        'description': '已生效技能',
        'skillPath': 'skills/trusted-skill/SKILL.md',
        'bytes': 456,
        'contentHash': '0123456789abcdef',
        'trustDetail': '已由 human 确认',
      },
    ],
    'rejected': <dynamic>[],
    'catalogTokens': 321,
    'ignored': <dynamic>[],
  };

  /// MCP 一个服务：折叠态一行，展开态要看到配置与它提供的工具
  final mcp = <String, dynamic>{
    'servers': [
      {
        'name': 'filesystem',
        'command': 'npx',
        'args': ['-y', '@modelcontextprotocol/server-filesystem'],
        'env': {'ROOT': 'D:/work'},
        'disabled': false,
        'state': 'never-started',
        'toolsCount': 1,
        'registeredTools': ['mcp__filesystem__read'],
        'toolDetails': [
          {'name': 'read', 'fullName': 'mcp__filesystem__read', 'description': '读一个文件'},
        ],
      },
    ],
    'problems': <dynamic>[],
    'registeredCount': 1,
    'runningCount': 0,
  };

  /// 工具注册表：**两组**（内置 + MCP）——容器必须按组遍历，将来还要加「computer use 组」
  final tools = <String, dynamic>{
    'groups': [
      {'id': 'builtin', 'label': '内置工具', 'note': '随程序一起来的工具。'},
      {'id': 'mcp:mcpdemo', 'label': 'mcpdemo', 'note': '来自 MCP 服务 mcpdemo 的工具。'},
    ],
    'tools': [
      {
        'name': 'safe_read', 'group': 'builtin', 'enabled': true, 'sideEffect': 'none',
        'executionMode': 'parallel', 'description': '读文件', 'timeoutMs': 1000,
      },
      {
        'name': 'pwsh', 'group': 'builtin', 'enabled': false, 'sideEffect': 'destructive',
        'executionMode': 'exclusive', 'description': '跑命令', 'timeoutMs': 5000,
      },
      {
        'name': 'mcp__mcpdemo__echo', 'group': 'mcp:mcpdemo', 'enabled': true, 'sideEffect': 'destructive',
        'executionMode': 'exclusive', 'description': 'MCP 回显', 'timeoutMs': 5000, 'fromMcp': true,
      },
    ],
    'destructivePolicy': false,
  };

  final hooks = <String, dynamic>{
    'entries': [
      {
        'index': 0, 'hook': 'PreToolUse', 'matcher': 'pwsh', 'command': 'node check.mjs',
        'timeoutMs': 10000, 'enabled': true,
      },
    ],
    'problems': <dynamic>[],
    'relative': 'data/hooks.json',
    'hookPoints': ['PreToolUse', 'PostToolUse', 'Wake'],
    'defaultTimeoutMs': 10000,
    'enabledCount': 1,
    'disabledCount': 0,
  };

  /// 两个通道各一个会话：联系人卡必须**按通道**过滤（用户 ⑤ 指出 OneBot 页曾在列官 Bot 的联系人）
  final sessions = <String, dynamic>{
    'sessions': [
      {
        'sid': 'qq:c2c:OPENID-A', 'channel': 'qq-official', 'chatType': 'c2c', 'chatId': 'OPENID-A',
        'person': 'OPENID-A', 'name': '用户', 'lastSeenAt': '2026-10-01T10:35:42.000Z',
        'lastText': '在吗', 'messages': 3, 'unread': 0, 'readUpToSeq': 3,
      },
      {
        'sid': 'onebot:group-at:90001', 'channel': 'onebot', 'chatType': 'group-at', 'chatId': '90001',
        'person': '10001', 'name': null, 'lastSeenAt': '2026-10-01T09:00:00.000Z',
        'lastText': '早', 'messages': 2, 'unread': 0, 'readUpToSeq': 2,
      },
    ],
  };

  /// 渠道页与扩展页都只读 API：这份路由表覆盖它们会请求的端点
  Map<String, dynamic> routes() => {
        '/api/config': config,
        '/api/events': events,
        '/api/sessions': sessions,
        '/api/keys': {
          'qqAppId': {'configured': false, 'mask': null},
          'qqClientSecret': {'configured': true, 'mask': 'DG5g…7x9Q'},
          'onebotToken': {'configured': false, 'mask': null},
        },
        '/api/skills': skills,
        '/api/mcp': mcp,
        // 扩展页的 `mcp` 那一屏读两个端点（第二个是她的申请单，2026-10-11 加）：
        // 不给它就会走一次 null 响应，那一段被当成"读失败"（实测：这一页 4 条用例一起红）
        '/api/grants': <String, dynamic>{'items': <dynamic>[], 'open': 0},
        '/api/tools': tools,
        '/api/hooks': hooks,
      };

  Future<AppState> pumpPage(
    WidgetTester tester,
    Widget Function(AppState state) build, {
    double width = 1400,
  }) async {
    tester.view.physicalSize = Size(width, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final api = _FakeApi(routes());
    _lastApi = api;
    final state = AppState(api: api);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: build(state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return state;
  }

  testWidgets('渠道页：宽窗左列表三项 + 右详情默认摆首项', (tester) async {
    await pumpPage(tester, (state) => ChannelsPage(state: state));

    // 列表三项各自一行；首项同时在详情里出现一次
    expect(find.text('OneBot 11'), findsOneWidget);
    expect(find.text('Webhook 与文件监听'), findsOneWidget);
    expect(find.text('QQ 官方 Bot API'), findsNWidgets(2), reason: '首项应在列表与详情各出现一次');

    // 行尾 icon-only「配置」：三项各一枚
    expect(find.byTooltip('配置'), findsNWidgets(3));

    // 详情：状态词按实测（QQ 官方有通道事件 → 运行中），配置就地改，活动在下方
    expect(find.textContaining('运行中'), findsWidgets);
    // 用户 ③：配置卡就在本页下面，状态卡上那枚「编辑配置」只是同页滚动，去掉。
    // 进配置区仍有一条路——行尾那枚齿轮（上面已断言三项各一枚）。
    expect(find.text('编辑配置'), findsNothing);
    expect(find.text('通道配置'), findsOneWidget);
    expect(find.text('启用该通道'), findsOneWidget);
    expect(find.text('在吗'), findsOneWidget);
    // 用户 ④：最近活动与上面三张卡同一形态——标题升到 15/w600 用默认前景色
    // （原先 13/onSurfaceVariant，比别的卡低一档，看着像另一套东西）
    final activityTitle = tester.widget<Text>(find.text('最近活动'));
    expect(activityTitle.style?.fontSize, 15, reason: '与「通道配置」同一档标题');
    expect(activityTitle.style?.color, isNull, reason: '用默认前景色，不再自降一档');
    // 卡片里标题已经把上面隔开了：第一行不顶线，行与行之间才有
    expect(tester.widget<Container>(find.byKey(const ValueKey('feed-row-0'))).decoration, isNull);
    expect(tester.widget<Container>(find.byKey(const ValueKey('feed-row-1'))).decoration, isNotNull,
        reason: '行与行之间照旧分隔');
    // AppID / AppSecret 填值（不是环境变量名）：两把密钥的输入框各一个
    expect(find.byKey(const ValueKey('secret-qqAppId')), findsOneWidget);
    expect(find.byKey(const ValueKey('secret-qqClientSecret')), findsOneWidget);
    expect(find.text('已配置 DG5g…7x9Q'), findsOneWidget, reason: '已配置的密钥只显示掩码');
    // 用户 ③：已配置要"提醒明显一点"；用户 ⑥ 定了色与位置——**蓝色、居中**（绿色的那版他说丑）。
    // 这一组假数据正好两个都有：qqClientSecret 已配置、qqAppId 未配置，可以断言对照。
    final configured = tester.widget<TextField>(find.byKey(const ValueKey('secret-qqClientSecret')));
    expect(configured.decoration?.hintStyle?.color, IrmiaTheme.light().colorScheme.primary,
        reason: '已配置的密钥格：提示文字转蓝');
    expect(configured.textAlign, TextAlign.center, reason: '已配置的密钥格：居中');
    expect(configured.decoration?.enabledBorder, isNotNull, reason: '已配置的密钥格：边框也要跟着变');
    final unconfigured = tester.widget<TextField>(find.byKey(const ValueKey('secret-qqAppId')));
    expect(unconfigured.decoration?.hintStyle, isNull, reason: '未配置的密钥格照旧——蓝只留给"已配置"');
    expect(unconfigured.textAlign, TextAlign.start, reason: '未配置就是个普通输入框，跟同页别的字段一样左对齐');
    // 字段说明按用户 ③ 改短：一句一行，只留"留空怎么算 + 收哪种协议"
    expect(find.text('留空用官方地址，只收 http(s)。'), findsNWidgets(2));
    expect(find.text('留空向凭证接口取，只收 ws(s)。'), findsOneWidget);
    // 已有通道启用：顶部不再摆「从这里开始」的引导条
    expect(find.text('配置 QQ 官方'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('渠道页：联系人表**只列本通道的会话**（两台手机互相独立），但摆在看得见的位置', (tester) async {
    // 用户 2026-10-02："我在GUI里没看见联系人表？"（原来埋在通道详情里）→ 提到配置卡之后这一层；
    // 随后又纠正："官bot和onebot相当于两个手机，互相独立，不需要往来"→ 卡片仍然只列**本通道**的会话。
    await pumpPage(tester, (state) => ChannelsPage(state: state));

    expect(find.text('会话联系人'), findsOneWidget, reason: '看得见（不再要逐个通道翻）');
    expect(find.text('qq:c2c:OPENID-A'), findsOneWidget, reason: '官 Bot 那条在自己那一页');
    expect(find.text('onebot:group-at:90001'), findsNothing,
        reason: 'OneBot 的会话不许出现在官 Bot 这一页：两台手机互相独立');

    await tester.tap(find.text('OneBot 11'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('onebot:group-at:90001'), findsOneWidget, reason: '切过来才看得到它自己的');
    expect(find.text('qq:c2c:OPENID-A'), findsNothing, reason: '反过来也一样');
    expect(find.textContaining('还没有通道活动'), findsOneWidget,
        reason: '空态是卡内一行灰字，不再是一块占半张卡的 StateBlock（用户 ⑤）');

    // Webhook 那条是告警出口 + 文件监听，根本不会有会话：不摆这张卡
    await tester.tap(find.text('Webhook 与文件监听'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('会话联系人'), findsNothing);
  });

  testWidgets('渠道页：行尾「配置」就地聚焦配置区，不再跳设置页', (tester) async {
    final state = await pumpPage(tester, (s) => ChannelsPage(state: s));
    await tester.tap(find.byTooltip('配置').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(state.pageId, isNot('settings'), reason: '配置就在本页，不该跳走');
    expect(find.text('通道配置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('渠道页：开关与字段改动只提交差异项，改回原值即回干净', (tester) async {
    await pumpPage(tester, (state) => ChannelsPage(state: state));

    FilledButton saveButton() => tester.widget<FilledButton>(find.byType(FilledButton));
    expect(saveButton().onPressed, isNull, reason: '未改动时「保存」应禁用');

    // 关掉 QQ 官方通道：只有开关这一项进 fields
    await tester.tap(find.byType(Switch).first);
    await tester.pump();
    expect(saveButton().onPressed, isNotNull, reason: '改动后「保存」应可用');
    expect(find.text('有未保存的更改'), findsOneWidget);
    expect(find.text('保存（1 项改动）'), findsOneWidget);

    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final post = _lastApi!.posts.single;
    expect(post.path, '/api/commands/config-update');
    expect(post.confirm, 'config-update', reason: '写配置必须带 X-Confirm');
    // 反向判据：这一笔写的是 `channels.qqOfficial.enabled`，**不是** `trust.mode`，
    // 所以不许带字段短语 `trust-full-access`——那是"改信任范围"专用的门。
    // 无脑给所有 config 提交都加，等于把那条门放宽到"随便谁都能声明"，判据就没了。
    expect(post.confirm, isNot(contains('trust-full-access')),
        reason: '不带 trust.mode 的提交不该带那个字段短语');
    expect(post.body['fields'], {'channels.qqOfficial.enabled': false});

    // 改一个字段：只提交该字段，不带上没动过的项
    await tester.enterText(find.byKey(const ValueKey('field-channels.qqOfficial.apiBase')), 'https://api.example.com');
    await tester.pump();
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(_lastApi!.posts.last.body['fields'], {'channels.qqOfficial.apiBase': 'https://api.example.com'});

    // 填密钥：走 set-key（值写进本机密钥文件），与 config-update 是两条通道
    await tester.enterText(find.byKey(const ValueKey('secret-qqAppId')), '102000000');
    await tester.pump();
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final secretPost = _lastApi!.posts.last;
    expect(secretPost.path, '/api/commands/set-key');
    expect(secretPost.body, {'name': 'qqAppId', 'value': '102000000'});
    expect(secretPost.confirm, 'set-key', reason: '写密钥必须带 X-Confirm');

    // 改回生效值：脏状态自动消失，按钮回到禁用
    await tester.enterText(find.byKey(const ValueKey('field-channels.qqOfficial.apiBase')), 'https://api.sgroup.qq.com');
    await tester.pump();
    expect(saveButton().onPressed, isNull, reason: '改回原值后应重新禁用');
    expect(find.text('有未保存的更改'), findsNothing);

    // 清空一项：提交 null（= 回到默认值），而不是空串——空串会被服务端的配置校验拒掉并回滚
    await tester.enterText(find.byKey(const ValueKey('field-channels.qqOfficial.apiBase')), '');
    await tester.pump();
    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(_lastApi!.posts.last.body['fields'], {'channels.qqOfficial.apiBase': null});
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('渠道页：点「重新加载」丢弃未保存的改动', (tester) async {
    await pumpPage(tester, (state) => ChannelsPage(state: state));

    await tester.tap(find.byType(Switch).first);
    await tester.pump();
    expect(find.text('有未保存的更改'), findsOneWidget);

    await tester.tap(find.text('重新加载'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('有未保存的更改'), findsNothing, reason: '重新加载应回到生效配置');
    expect(tester.widget<Switch>(find.byType(Switch).first).value, isTrue);
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('渠道页：窄窗降级为单独视图，点行进详情、可返回列表', (tester) async {
    await pumpPage(tester, (state) => ChannelsPage(state: state), width: 800);

    // 窄窗首屏只有列表：详情标题与配置卡都不在
    expect(find.text('QQ 官方 Bot API'), findsOneWidget);
    expect(find.text('通道配置'), findsNothing);

    await tester.tap(find.text('QQ 官方 Bot API'));
    await tester.pump();
    expect(find.text('通道配置'), findsOneWidget, reason: '窄窗选行后应切到详情视图');
    expect(find.text('渠道列表'), findsOneWidget, reason: '详情视图要有返回列表的入口');

    await tester.tap(find.text('渠道列表'));
    await tester.pump();
    expect(find.text('通道配置'), findsNothing, reason: '返回后应回到列表视图');
    expect(tester.takeException(), isNull);
  });

  testWidgets('渠道页：没启用任何通道时顶部给引导条，动作落到配置区', (tester) async {
    final disabled = <String, dynamic>{
      'channels': {
        'qqOfficial': {'enabled': false, 'appIdEnv': 'QQ_BOT_APPID', 'clientSecretEnv': 'QQ_BOT_SECRET'},
        'onebot': {'enabled': false, 'wsUrl': 'ws://127.0.0.1:3001', 'tokenEnv': 'ONEBOT_TOKEN'},
      },
      'alerts': <String, dynamic>{},
      'web': {'host': '127.0.0.1', 'port': 7788},
      'paths': <String, dynamic>{},
    };
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final api = _FakeApi({'/api/config': disabled, '/api/events': events, '/api/skills': skills, '/api/mcp': <String, dynamic>{}, '/api/tools': <String, dynamic>{}, '/api/hooks': <String, dynamic>{}});
    _lastApi = api;
    final state = AppState(api: api);
    await tester.pumpWidget(MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: ChannelsPage(state: state))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.textContaining('还没有启用任何消息通道。'), findsOneWidget);
    await tester.tap(find.text('配置 QQ 官方'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('通道配置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('扩展页：左列表四项 + 右详情默认摆首项（技能）', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));

    // 左列四项各一行（详情头里再出现一次「技能」，所以首项是 2 个）
    expect(find.byKey(const ValueKey('ext-item-skills')), findsOneWidget);
    expect(find.byKey(const ValueKey('ext-item-mcp')), findsOneWidget);
    expect(find.byKey(const ValueKey('ext-item-tools')), findsOneWidget);
    expect(find.byKey(const ValueKey('ext-item-hooks')), findsOneWidget);
    expect(find.text('技能'), findsNWidgets(2), reason: '首项应在列表与详情各出现一次');

    // 列表摘要：四项各一行，数字来自实测数据
    expect(find.text('1 已生效 · 1 待确认'), findsOneWidget);
    expect(find.text('1 个服务 · 0 已运行'), findsOneWidget);
    expect(find.text('2 件启用 / 共 3'), findsOneWidget);
    expect(find.text('1 条'), findsOneWidget);

    // 详情是首项（技能）：待确认 / 已生效两段都在，行尾带确认与忽略两枚 icon-only 动作
    expect(find.text('待确认'), findsOneWidget);
    expect(find.text('已生效'), findsOneWidget);
    expect(find.byTooltip('确认：写入 skill/installed，技能进入 catalog'), findsOneWidget);
    expect(find.byTooltip('忽略：收进「已忽略」，不写事件、不进 catalog'), findsOneWidget);
    // 三处添加引导：技能这一项的主动作
    expect(find.text('新建技能'), findsOneWidget);
    expect(find.text('扫描目录'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('扩展页：点第二项切到 MCP 详情（左列表 + 右详情）', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));

    expect(find.text('添加服务'), findsNothing, reason: '默认在技能详情里，MCP 的动作不该出现');
    await tester.tap(find.byKey(const ValueKey('ext-item-mcp')));
    await tester.pump();

    // MCP 详情就位：标题 + 动作 + 服务行（状态点旁写着"从未启动"）
    expect(find.text('添加服务'), findsOneWidget);
    expect(find.textContaining('从未启动'), findsOneWidget);
    expect(find.text('新建技能'), findsNothing, reason: '切过去之后技能那一块就不该还在');

    // 服务行可各自展开：折叠态没有启动命令，展开后配置 + 工具 + 动作都出来
    expect(find.text('启动命令'), findsNothing);
    await tester.tap(find.byTooltip('展开这个服务'));
    await tester.pump();
    expect(find.text('启动命令'), findsOneWidget);
    expect(find.textContaining('npx'), findsWidgets);
    expect(find.text('测试连接'), findsOneWidget);
    expect(find.textContaining('读一个文件'), findsOneWidget, reason: '展开后要能看到它提供的工具');

    // 再点一次折叠回去
    await tester.tap(find.byTooltip('折叠这个服务'));
    await tester.pump();
    expect(find.text('启动命令'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('扩展页：窄窗降级为单独视图，点行进详情、可返回列表', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state), width: 800);

    // 窄窗首屏只有列表：详情头与主动作都不在
    expect(find.byKey(const ValueKey('ext-item-hooks')), findsOneWidget);
    expect(find.text('新建技能'), findsNothing);
    expect(find.text('扩展项列表'), findsNothing);

    await tester.tap(find.byKey(const ValueKey('ext-item-hooks')));
    await tester.pump();
    expect(find.text('添加钩子'), findsOneWidget, reason: '窄窗选行后应切到详情视图');
    expect(find.text('扩展项列表'), findsOneWidget, reason: '详情视图要有返回列表的入口');

    await tester.tap(find.text('扩展项列表'));
    await tester.pump();
    expect(find.text('添加钩子'), findsNothing, reason: '返回后应回到列表视图');
    expect(find.byKey(const ValueKey('ext-item-skills')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('扩展页：内置工具按组分卡，组头有全开/全关，行尾开关写 tool-toggle', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));
    await tester.tap(find.byKey(const ValueKey('ext-item-tools')));
    await tester.pump();

    // 容器按组遍历：两个组各一张卡（将来加 computer use 组时这里一个字都不用改）
    expect(find.byKey(const ValueKey('tool-group-builtin')), findsOneWidget);
    expect(find.byKey(const ValueKey('tool-group-mcp:mcpdemo')), findsOneWidget);
    expect(find.text('内置工具'), findsWidgets);
    expect(find.text('全开'), findsNWidgets(2));
    expect(find.text('全关'), findsNWidgets(2));

    // 行尾开关：一件工具一次 tool-toggle，写的是 config.tools.disabled
    final sw = find.descendant(
      of: find.byKey(const ValueKey('tool-safe_read')),
      matching: find.byType(Switch),
    );
    expect(sw, findsOneWidget);
    await tester.tap(sw);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    final post = _lastApi!.posts.last;
    expect(post.path, '/api/commands/tool-toggle');
    expect(post.body, {'name': 'safe_read', 'enabled': false});
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：新建技能走表单，服务端生成骨架后进「待确认」', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));

    await tester.tap(find.text('新建技能'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const ValueKey('form-name')), findsOneWidget);
    expect(find.byKey(const ValueKey('form-description')), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('form-name')), 'morning-review');
    await tester.enterText(find.byKey(const ValueKey('form-description')), '每天早上整理一遍昨天的进展并落一份摘要');
    await tester.tap(find.text('创建'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final post = _lastApi!.posts.last;
    expect(post.path, '/api/commands/skill-create');
    expect(post.confirm, 'skill-create', reason: '新建技能也要带确认短语');
    expect(post.body, {
      'name': 'morning-review',
      'description': '每天早上整理一遍昨天的进展并落一份摘要',
    });
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：技能名不合规当场拦下，不发请求', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));

    await tester.tap(find.text('新建技能'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byKey(const ValueKey('form-name')), '晨间总结');
    await tester.enterText(find.byKey(const ValueKey('form-description')), '每天早上整理一遍昨天的进展');
    await tester.tap(find.text('创建'));
    await tester.pump();

    expect(find.text('只允许小写字母、数字与连字符'), findsOneWidget, reason: '校验在弹窗里当场说');
    expect(_lastApi!.posts.where((p) => p.path == '/api/commands/skill-create'), isEmpty);
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：添加 MCP 服务的表单提交 name/command/args/env/enabled', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));
    await tester.tap(find.byKey(const ValueKey('ext-item-mcp')));
    await tester.pump();

    await tester.tap(find.text('添加服务'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('添加 MCP 服务'), findsOneWidget);
    expect(find.text('测试连接'), findsOneWidget, reason: '还没保存也要能先试一下');

    // 按 key 定位输入框（hint 是会被改的文案，key 是契约）
    await tester.enterText(find.byKey(const ValueKey('mcp-field-name')), 'demo');
    await tester.enterText(find.byKey(const ValueKey('mcp-field-command')), 'node');
    await tester.enterText(find.byKey(const ValueKey('mcp-field-args')), 'server.mjs\n--root\nD:/work');
    await tester.enterText(find.byKey(const ValueKey('mcp-field-env')), 'ROOT=D:/work');
    await tester.tap(find.text('保存'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final post = _lastApi!.posts.last;
    expect(post.path, '/api/commands/mcp-save');
    expect(post.confirm, 'mcp-save', reason: '加一个 MCP 服务 = 扩大能力边界');
    expect(post.body['name'], 'demo');
    expect(post.body['command'], 'node');
    expect(post.body['args'], ['server.mjs', '--root', 'D:/work']);
    expect(post.body['env'], {'ROOT': 'D:/work'});
    expect(post.body['enabled'], isTrue);
    // v48：那一格"它是干什么的"**照原样发**（这里没填 ⇒ 发空串）。界面**不替人补一句**
    // ——那正是"框架替人编"；空串的后果由服务端回执如实说（"她在索引里只看到名字"）。
    expect(post.body['desc'], '');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：desc 那一格填了就随 mcp-save 一起发（它是她索引里那一句）', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));
    await tester.tap(find.byKey(const ValueKey('ext-item-mcp')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('mcp-add')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byKey(const ValueKey('mcp-field-name')), 'obscura');
    await tester.enterText(find.byKey(const ValueKey('mcp-field-command')), 'node');
    await tester.enterText(
        find.byKey(const ValueKey('mcp-field-desc')), '读本机浏览器历史与当前标签页');
    await tester.tap(find.text('保存'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(_lastApi!.posts.last.body['desc'], '读本机浏览器历史与当前标签页');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：测试连接把超时一起发出去（默认 30s，拉包慢的服务不该被判成不可用）', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));
    await tester.tap(find.byKey(const ValueKey('ext-item-mcp')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('mcp-add')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // 默认值就摆在表单里：服务端那个 8 秒兜底是"宁可快些失败"，给人按的默认值是 30 秒
    expect(find.text('30000'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('mcp-field-name')), 'demo');
    await tester.enterText(find.byKey(const ValueKey('mcp-field-command')), 'npx');
    await tester.enterText(find.byKey(const ValueKey('mcp-field-args')), '-y\n@modelcontextprotocol/server-demo');
    await tester.tap(find.text('测试连接'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final probe = _lastApi!.posts.last;
    expect(probe.path, '/api/commands/mcp-test');
    expect(probe.confirm, 'mcp-test');
    expect(probe.body['command'], 'npx');
    expect(probe.body['args'], ['-y', '@modelcontextprotocol/server-demo']);
    expect(probe.body['timeoutMs'], 30000, reason: '内联测试也要带上超时（首次拉包 30s+ 是常态）');

    // 结果弹层要先收掉：它压在表单上面，「测试连接」那枚按钮这时点不着（layers 挡住命中）
    await tester.tap(find.text('知道了'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // 改成别的值：跟着走，不被界面写死
    await tester.enterText(find.byKey(const ValueKey('mcp-field-timeout')), '45000');
    await tester.pump();
    await tester.tap(find.text('测试连接'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(_lastApi!.posts.last.body['timeoutMs'], 45000);
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：MCP 表单文案按元工具口径（不许再教 mcp__服务名__工具名 那套）', (tester) async {
    // 用户 2026-10-09 拍定：MCP 只有一件内置入口工具 `mcp`——工具**不**注册成
    // `mcp__{server}__{tool}`。这一条锁的是**界面上那句话不许再教废弃的那套**，
    // 以及四件实现里真有的事（空闲回收 / 启动器白名单 / env 继承 / 开关语义）都被说出来。
    await pumpPage(tester, (state) => ExtensionsPage(state: state));
    await tester.tap(find.byKey(const ValueKey('ext-item-mcp')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('mcp-add')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final dialog = find.byType(AlertDialog);
    expect(dialog, findsOneWidget);
    Finder inDialog(String text) =>
        find.descendant(of: dialog, matching: find.textContaining(text));

    // ① 元工具口径：调用走内置的 mcp 工具（不是"每件 MCP 工具进她的清单"）
    expect(inDialog('内置的 mcp 工具'), findsOneWidget);
    // ② 废弃说法一个都不许留在界面上
    expect(inDialog('mcp__'), findsNothing, reason: '工具名不再合成，对话框里不该提 mcp__服务名__工具名');
    expect(inDialog('合成'), findsNothing);
    // ③ 服务名 = 给这个 server 起的名字（调用时用得到），不是"工具名前缀"
    expect(inDialog('调用时用得到'), findsOneWidget);
    // ④ 启动器白名单（加一个 server = 在这台机器上多跑一个进程，command 不是随便填）
    expect(inDialog('白名单'), findsOneWidget);
    // ④′ 示例按"本机真起得来"排：npx 在 Windows 上起不来（只有 .cmd 垫片、启动器不经 shell），
    //     所以它不再排第一个——这一条锁的是提示里先给能起的写法、并明说 npx 起不来。
    //     （长度受 copy_rules_test.dart 的 100 字闸约束：这条提示现在 98 字，超了那条闸会当场拦下。）
    expect(inDialog('uvx …'), findsOneWidget, reason: 'command 提示要先给本机能起的写法');
    expect(inDialog('npx 在 Windows 上起不来'), findsOneWidget, reason: '本机实测起不来的写法要明说，别让人照着试');
    // ⑤ env 是"追加"，不是"只给这些"（池把 entry.env 合进 process.env，client.ts 的 spawner）
    expect(inDialog('继承主进程的环境变量'), findsOneWidget);
    // ⑥ 开关 = 参与/不参与拉起，与"随主进程启动"无关（生产**不** registerAll）
    expect(inDialog('配置留着但不起进程'), findsOneWidget);
    // ⑦ 空闲 5 分钟回收是真机制（src/mcp/client.ts 的 DEFAULT_IDLE_RECLAIM_MS + 扫描器）
    expect(inDialog('空闲 5 分钟回收'), findsOneWidget);

    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 5));
    expect(tester.takeException(), isNull);
  });

  testWidgets('扩展页：忽略清单里指向空气的名字不显示（备忘只增不减，界面不该跟着涨）', (tester) async {
    // 服务端回传的 ignored 里混着一条已经扫描不到的记录：它不该变成一行"已忽略"
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final staleSkills = <String, dynamic>{
      'items': [
        {
          'name': 'demo-skill', 'trust': 'never-confirmed', 'inCatalog': false, 'ignored': true,
          'description': '演示技能', 'skillPath': 'skills/demo-skill/SKILL.md', 'bytes': 1,
          'contentHash': 'abcdef1234567890', 'trustDetail': '从未确认',
        },
      ],
      'rejected': <dynamic>[],
      'catalogTokens': 0,
      'ignored': ['demo-skill', 'deleted-skill'],
    };
    final api = _FakeApi({...routes(), '/api/skills': staleSkills});
    _lastApi = api;
    final state = AppState(api: api);
    await tester.pumpWidget(MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: ExtensionsPage(state: state))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(find.text('已忽略'), findsOneWidget, reason: '真正存在的被忽略技能要照常摆出来');
    expect(find.text('demo-skill'), findsOneWidget);
    expect(find.text('deleted-skill'), findsNothing, reason: '扫不到的记录不该在界面上变成一行"查无此技"');
    expect(find.text('0 已生效 · 0 待确认'), findsOneWidget, reason: '摘要也不该把它算成待确认');
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('扩展页：钩子的开关写 hook-save 并只翻 enabled', (tester) async {
    await pumpPage(tester, (state) => ExtensionsPage(state: state));
    await tester.tap(find.byKey(const ValueKey('ext-item-hooks')));
    await tester.pump();

    expect(find.textContaining('agent 对它只读'), findsOneWidget, reason: '安全边界要写在页面上');
    final sw = find.descendant(
      of: find.byKey(const ValueKey('hook-0')),
      matching: find.byType(Switch),
    );
    expect(sw, findsOneWidget);
    await tester.tap(sw);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final post = _lastApi!.posts.last;
    expect(post.path, '/api/commands/hook-save');
    expect(post.confirm, 'hook-save', reason: '改"谁能改我"必须带确认短语');
    expect(post.body['index'], 0);
    expect(post.body['hook'], 'PreToolUse');
    expect(post.body['matcher'], 'pwsh');
    expect(post.body['enabled'], false);
    await tester.pump(const Duration(seconds: 5));
  });
}
