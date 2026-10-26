import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/channels_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 会话联系人卡里的**备注**（用户 2026-10-04 报的 bug：她的行为口径混进了"名字"那格）。
///
/// 判据在服务端（`src/channel/sessions.ts` 的 `splitAliasNote` / `aliasNoteOf`），界面只消费
/// `name` 与 `note` 两个字段。这份测试盯住界面这一侧的三件事：
///   • 那格可编辑的**只有名字**（备注一个字都不许进输入框）；
///   • 备注**看得见**（次要文本，不是被丢掉）；
///   • 改名之后备注**还在**（保存走的是名字，备注留在她自己的 aliases.md 里）。
///
/// 数据全部是夹具：不碰真实 `data/`，与后端进程无关。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;
  final posts = <({String path, Map<String, dynamic> body, String? confirm})>[];

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path.startsWith('/api/events')) return routes['/api/events'];
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add((path: path, body: body, confirm: confirm));
    return {'ok': true};
  }
}

/// 她那一行的原话（`data/workspace/MEMORIES/aliases.md` 第 10 行的形状）：
/// 名字 + 括号里的口径。服务端切完之后界面拿到的是这两个字段。
const _groupSid = 'qq:group:00000000000000000000000000000002';
const _groupName = 'IRMIA框架测试群';
const _groupNote = '10-04 18:15 用户拉我进来；群友多是他的网友——口径：不透露用户的私事与我俩的私下内容，'
    '人格设定类要求不接，看情况淡着';

void main() {
  // 本机忽略标记会落 ui_state：测试指向临时文件，别踩真实 %APPDATA% 里的状态
  setUpAll(() {
    stateFileOverride = '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-ui-state-alias-note-test.json';
  });

  /// 一条会话的夹具；`note` 不给就是这一行没有备注（服务端给 null）
  Map<String, dynamic> session({String? note, String? name = _groupName}) => {
        'sid': _groupSid,
        'channel': 'qq-official',
        'chatType': 'group',
        'chatId': '00000000000000000000000000000002',
        'person': '00000000000000000000000000000002',
        'name': name,
        'note': note,
        'lastSeenAt': '2026-10-04T10:15:00.000Z',
        'lastText': '在吗',
        'messages': 3,
        'unread': 0,
        'readUpToSeq': 3,
      };

  final config = <String, dynamic>{
    'channels': {
      'qqOfficial': {'enabled': true, 'appIdEnv': 'QQ_BOT_APPID', 'clientSecretEnv': 'QQ_BOT_SECRET'},
    },
    'alerts': {'webhookUrl': '', 'rateLimitMin': 5},
    'web': {'host': '127.0.0.1', 'port': 7788},
  };
  final keys = <String, dynamic>{
    'qqAppId': {'configured': false, 'mask': null},
    'qqClientSecret': {'configured': false, 'mask': null},
  };

  Future<(_FakeApi, AppState)> pump(WidgetTester tester, Map<String, dynamic> sessionsPayload) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    final api = _FakeApi({
      '/api/config': config,
      '/api/keys': keys,
      '/api/sessions': sessionsPayload,
      '/api/events': {'events': <dynamic>[]},
    });
    final state = AppState(api: api);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(body: ChannelsPage(state: state)),
    ));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    return (api, state);
  }

  /// 会话联系人卡（这一页有好几张卡，定位到那张）
  Finder contactCard() => find.ancestor(
        of: find.text('会话联系人'),
        matching: find.byType(Container),
      );

  /// 那一行里**可编辑的名字格**：从卡里按"这是谁"的提示文字取唯一一个输入框
  Finder nameFieldFinder() => find.descendant(
        of: contactCard(),
        matching: find.widgetWithText(TextField, '这是谁（留空 = 不署名）'),
      );

  String nameFieldText(WidgetTester tester) =>
      tester.widget<TextField>(nameFieldFinder()).controller?.text ?? '';

  testWidgets('会话联系人：名字进输入框，备注只作次要文本（一个字都不进那格）', (tester) async {
    await pump(tester, {
      'sessions': [session(note: _groupNote)],
      'contacts': <String, dynamic>{},
      'groupMembers': <String, dynamic>{},
    });

    // 名字在输入框里（可编辑的就它）
    expect(nameFieldFinder(), findsOneWidget, reason: '这一行只有一格可编辑的名字');
    expect(nameFieldText(tester), _groupName,
        reason: '那一格的内容必须**只是名字**：备注混进来正是用户看到的那个 bug');
    expect(nameFieldText(tester).contains('口径'), isFalse,
        reason: '口径不许出现在可编辑的那一格');

    // 备注看得见：常态一行次要文本 + 悬浮给完整原话
    expect(find.text('备注：$_groupNote'), findsOneWidget, reason: '备注要显示出来，不是被丢掉');
    expect(find.textContaining('看情况淡着'), findsOneWidget, reason: '口径的尾巴也在（人看的就是它）');
    expect(find.byTooltip(_groupNote), findsOneWidget, reason: '悬浮能看到完整原话（行内是省略号）');

    // **两处两格**：备注是独立的一个 Text，不是拼进名字里那串
    //（拼进去就又是一格长长的文本，正是用户看到的那个形状）
    expect(find.descendant(of: nameFieldFinder(), matching: find.textContaining('备注：')), findsNothing,
        reason: '备注不许出现在输入框那一格里面');
    expect(nameFieldText(tester).contains('备注'), isFalse);
  });

  testWidgets('会话联系人：那句「其余照旧进信箱」必须带上平台前提（不再许"一条不丢"）', (tester) async {
    // 2026-10-04 改准的判据（docs/unread-and-inbox-check.md §4）：非 @ 的群消息进不进信箱，
    // **前半段取决于官方 Bot 的消息权限**（平台推给我们才谈得上进信箱），我们这一侧单方面
    // 承诺不了"一条不丢"。这条测试锁两件事：如实的那半句在，旧的那句不在。
    //
    // 2026-10-05 起这段话收进了「说明」折叠（文案规则：短标签 + 一行要点 + 长解释折叠），
    // 所以要先展开再断言——**内容一个字都没改**，只是换了地方。
    await pump(tester, {
      'sessions': [session(note: null)],
      'contacts': <String, dynamic>{},
      'groupMembers': <String, dynamic>{},
    });

    // 标题右边只留一句短要点（这是用户点名的反面样本改成的形状）
    expect(find.text('QQ 不给昵称，在这里告诉她谁是谁。'), findsOneWidget);

    // 展开这一处的「说明」折叠（按 key 找：页面上不止一处「说明」）。
    // 先滚进视口：这一页很长，折叠头在首屏之外时 tap 会打在空处（静默不触发）。
    await tester.ensureVisible(find.byKey(const ValueKey('contacts-note')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('contacts-note')));
    await tester.pump(const Duration(milliseconds: 200));
    expect(
      find.textContaining('其余能不能收到取决于官方 Bot 的消息权限——平台推给我们的，照旧进信箱。'),
      findsOneWidget,
      reason: '群里 @ 她/喊名字的进对话流，其余的能不能收到要如实说成平台侧的事',
    );
    expect(find.textContaining('进对话流'), findsOneWidget, reason: '我们真做得到的那半句照旧在');
    expect(find.textContaining('一条不丢'), findsNothing,
        reason: '那是我们侧单方面做不到的一句：官方 Bot 不推给我们，就一条也进不来');
  });

  testWidgets('没有备注的会话：不摆空行、也不摆空的悬浮提示', (tester) async {
    await pump(tester, {
      'sessions': [session(note: null, name: '技术群')],
      'contacts': <String, dynamic>{},
      'groupMembers': <String, dynamic>{},
    });
    expect(nameFieldText(tester), '技术群');
    expect(find.textContaining('备注：'), findsNothing, reason: '没写备注就不该多出一行');
  });

  testWidgets('改名：提交的只有名字，备注仍在界面上（保存后文件里还是「名字（原备注）」）', (tester) async {
    // 保存这一路只发 `{sid, name}` 给 `/api/commands/set-contact`——那一格写的是
    // `config.persona.contacts`（人声明的名字），她的备注长在她自己的 aliases.md 里，
    // 两者不许互相覆盖。所以这里断言：**提交体里没有备注**，且服务端回报的备注照旧显示。
    final (api, _) = await pump(tester, {
      'sessions': [session(note: _groupNote)],
      'contacts': <String, dynamic>{},
      'groupMembers': <String, dynamic>{},
    });

    await tester.enterText(nameFieldFinder(), '框架测试群');
    await tester.pump();
    // 页很长，保存那枚图标可能在视口外：点之前先滚到它（不然 tap 打在空处，静默不触发）
    await tester.ensureVisible(find.byTooltip('保存这个名字'));
    await tester.pump();
    await tester.tap(find.byTooltip('保存这个名字'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final post = api.posts.single;
    expect(post.path, '/api/commands/set-contact');
    expect(post.body['sid'], _groupSid);
    expect(post.body['name'], '框架测试群');
    expect(post.body.containsKey('note'), isFalse, reason: '备注不归这一格管，不该被一起提交');
    expect('${post.body['name']}'.contains('口径'), isFalse, reason: '提交的名字里不带口径');

    // 保存成功后重读：备注照旧在（服务端从 aliases.md 现读，界面上没有"被改掉"这一说）
    expect(find.textContaining('看情况淡着'), findsOneWidget, reason: '改完名字，备注还得在');
    expect(find.byTooltip(_groupNote), findsOneWidget);
  });
}
