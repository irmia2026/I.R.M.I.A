import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/auth_gate.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/instances.dart';
import 'package:irmia_gui/session_store.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 设置页上的「账号与安全」分区：**改密码**、**结束实例**、**退出登录（清除本机凭据）**（B10）。
///
/// 被测的五件事（按重要性）：
///   ① 两次输入不一致**一个请求都不发**，当场把话说清楚（本地校验，不是让服务端替我们判）；
///   ② **结束实例**走项目既有的 `confirm()`：确认之后**停掉后端**、回到**实例选择页**，
///      而**本机那份凭据留着**（`token=kept`，也不发 `/api/auth/logout`）——用户 2026-10-27
///      的口径：「为什么要作废会话？不能就留在那，如果登回来了就接着吗？」；
///   ③ **退出登录（清除本机凭据）**是安全出口：作废会话 → 清本机凭据 → 停后端，三件都发生
///      （顺序断言），日志 `token=cleared`；
///   ④ 改密码成功之后**本进程就地换上新凭据**（服务端会把全部旧会话作废，不换就是"人刚改完
///      密码就被自己的心跳 401 踢回门上"）；
///   ⑤ 它是设置页**自己的一个分区**（锚点栏里有一项、正文里有一张卡），不在模型卡里。
///
/// 外加一条**文案一致性**的反向断言（两颗按钮不许互相矛盾：一处说"登录状态保留"、
/// 另一处说"退出登录"是两件事，边界要逐字说清）。
///
/// 服务端那两条端点的口径（核对过 src/web/server.ts 的 handleAuth，不是照抄任务描述）：
/// `POST /api/auth/password` 要凭据 + 旧密码，字段是 `password`（新）与 `oldPassword`（旧），
/// 成功时**签发一条新会话**并把旧的全部作废；`POST /api/auth/logout` 要凭据，撤的就是它自己。
/// `POST /api/commands/stop-instance` 要**有效 Bearer** + `X-Confirm: stop-instance`
/// （`handleStopInstance` 里 `auth.authenticate` 一条就够——这也是"关实例不作废会话"的前提：
/// 凭据留着，这条命令就一直是通的）。
void main() {
  const instance = '127.0.0.1:7788#aabbccddeeff0011';

  late Directory tmpDir;
  late _FakeApi api;
  late AppState state;
  late SessionStore store;
  late List<String> lifeLines;

  /// 用例里已经**显式**收掉的 state。
  ///
  /// 为什么需要它：widget 测试收尾会检查"还欠着定时器没有"，而心跳（`startPolling`）是
  /// 一条 periodic 定时器——那条用例必须在用例体里就收掉它。tearDown 再收第二遍会撞上
  /// `dispose` 只能调一次的断言，所以两边共用这一份账。
  final disposed = <AppState>{};

  void closeState(AppState target) {
    if (disposed.add(target)) target.dispose();
  }

  setUp(() {
    tmpDir = Directory.systemTemp.createTempSync('irmia-account-');
    // 凭据与界面状态都落临时目录：别踩真实 %APPDATA%
    sessionsRootOverride = '${tmpDir.path}${Platform.pathSeparator}sessions';
    stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
    // 老界面那份全局凭据也指向临时文件：默认不存在（等价于"全新机器"），要测半升级态的自己写一份
    legacyGuiTokenOverride = '${tmpDir.path}${Platform.pathSeparator}gui-token';
    // 实例登记表同理：登出之后画的是**实例选择页**，它读的是这一份（不设的话会读真实 %APPDATA%）
    instancesFileOverride = '${tmpDir.path}${Platform.pathSeparator}instances.json';
    HttpOverrides.global = null;

    api = _FakeApi();
    store = SessionStore();
    state = AppState(api: api, sessions: store);
    lifeLines = <String>[];
    state.lifeLogSink = lifeLines.add;
    // 摆在"已经进了壳、手上有一张好票"的位置上：这一组测的是进门之后那两件事
    api.instance = instance;
    api.token = 'good-token';
    store.write(instance, 'good-token');
    state.instance = instance;
    state.ready = true;
    state.setPage('settings');
  });

  tearDown(() {
    closeState(state);
    sessionsRootOverride = null;
    stateFileOverride = null;
    legacyGuiTokenOverride = null;
    instancesFileOverride = null;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });

  testWidgets('「账号与安全」是这一页自己的一个分区（锚点栏有它、点了能滚到它那一块）', (tester) async {
    await _pumpShell(tester, state);
    await _wind(tester);

    // 两处 = 锚点栏里的一项 + 正文里那张卡的卡头（模型卡里塞一颗按钮不会有第二处）
    expect(find.text('账号与安全'), findsNWidgets(2));

    // 卡片一开始在视口外面（设置页是长的）；点锚点之后它被滚进视口 —— 这证明它是这一页的
    // 一个**分区**（锚点定位的就是它），而不是贴在别处的按钮
    final card = find.text('账号与安全').last;
    expect(tester.getRect(card).top, greaterThan(900), reason: '一开始它在视口外');
    await tester.tap(find.text('账号与安全').first);
    await _wind(tester);
    expect(tester.getRect(card).top, lessThan(900), reason: '点锚点滚到它那一块');
    expect(tester.getRect(card).top, greaterThan(0), reason: '滚到位（不是滚过头到最底下）');

    // 那三颗按钮 + 实例行都在这一张卡上
    expect(find.byKey(const ValueKey('account-change-open')), findsOneWidget);
    expect(find.byKey(const ValueKey('account-close')), findsOneWidget,
        reason: '结束实例（停后端、凭据留着）');
    expect(find.byKey(const ValueKey('account-logout')), findsOneWidget,
        reason: '退出登录（清除本机凭据）——安全出口');
    expect(find.text('当前实例'), findsOneWidget);
  });

  testWidgets('改密码：两次输入不一致当场拦下，一个请求都不发', (tester) async {
    await _openChangeDialog(tester, state);
    await _fillChange(tester, old: 'old-password', fresh: 'brand-new-password', again: 'brand-new-passwerd');
    await tester.tap(find.byKey(const ValueKey('account-change-submit')));
    await tester.pump();

    expect(find.text('两次输入的密码不一样，请重新输入。'), findsOneWidget, reason: '当场说清是哪里的问题');
    expect(api.authCalls, isEmpty, reason: '两次不一致是本地就能判的事，一个请求都不该发');
    // 只摆着一张对话框 = **确认框没弹**（确认框也是 AlertDialog；校在先、确认在后）
    expect(find.byType(AlertDialog), findsOneWidget, reason: '确认框都不该弹');
    expect(find.byKey(const ValueKey('account-change-submit')), findsOneWidget, reason: '框还开着，人可以就地改');
  });

  testWidgets('改密码：旧密码空着 / 新密码太短，同样一个请求都不发', (tester) async {
    await _openChangeDialog(tester, state);

    await _fillChange(tester, old: '', fresh: 'brand-new-password', again: 'brand-new-password');
    await tester.tap(find.byKey(const ValueKey('account-change-submit')));
    await tester.pump();
    expect(find.text('请输入当前密码。'), findsOneWidget);

    await _fillChange(tester, old: 'old-password', fresh: 'short', again: 'short');
    await tester.tap(find.byKey(const ValueKey('account-change-submit')));
    await tester.pump();
    expect(find.textContaining('新密码至少 $kPasswordMinLength 位'), findsOneWidget);

    expect(api.authCalls, isEmpty, reason: '两条都是本地规矩：不合格就不发请求');
  });

  testWidgets('改密码：确认之后旧密码 + 新密码发出去，并且**就地换上新凭据**（不用重新登录）', (tester) async {
    api.changedToken = 'fresh-session-token';
    await _openChangeDialog(tester, state);
    await _fillChange(tester, old: 'old-password', fresh: 'brand-new-password', again: 'brand-new-password');
    await tester.tap(find.byKey(const ValueKey('account-change-submit')));
    await _wind(tester);

    // 危险操作先过项目既有的 confirm（这一条只证明"确实走了那个框"，配色由 ui_kit_test 钉）
    expect(find.byType(AlertDialog), findsNWidgets(2), reason: '表单 + 确认框');
    // `.hitTestable()`：两颗写着「改密码」的 FilledButton（表单那颗 + 确认框那颗），
    // 表单那颗此刻被确认框的遮罩盖着——点得到的那颗才是确认键
    await tester.tap(find.widgetWithText(FilledButton, '改密码').hitTestable());
    await _wind(tester);

    expect(api.authCalls, ['/api/auth/password']);
    expect(api.authBodies.single, {
      'oldPassword': 'old-password',
      'password': 'brand-new-password',
      'label': 'gui',
    });
    expect(state.api.token, 'fresh-session-token', reason: '内存里那张票要换成新的');
    expect(store.read(instance), 'fresh-session-token',
        reason: '盘上那份也要换：还留着旧票的话，下次开界面第一条请求就是 401');
    expect(state.ready, isTrue, reason: '改密码不该把人踢回门上——他是主动来改的');
    expect(find.text('密码已改；这台界面已经换上新凭据'), findsOneWidget);

    // 收尾：toast 有 4 秒的自动收起，把它走完（否则测试收尾会报 pending timer）
    await tester.pump(IrmiaToast.duration);
    await _wind(tester, 600);
  });

  testWidgets('改密码：旧密码不对时把服务端那句话照原样留在框里，凭据不动', (tester) async {
    api.changeFailure = '当前密码不对。';
    await _openChangeDialog(tester, state);
    await _fillChange(tester, old: 'wrong-password', fresh: 'brand-new-password', again: 'brand-new-password');
    await tester.tap(find.byKey(const ValueKey('account-change-submit')));
    await _wind(tester);
    await tester.tap(find.widgetWithText(FilledButton, '改密码').hitTestable());
    await _wind(tester);

    expect(find.text('当前密码不对。'), findsOneWidget, reason: '服务端那句话最准，照原样显示');
    expect(find.byKey(const ValueKey('account-change-submit')), findsOneWidget, reason: '框不关，人就在那个框上');
    expect(state.api.token, 'good-token', reason: '没改成，票不该被换掉');
    expect(store.read(instance), 'good-token');
    expect(state.ready, isTrue);
  });

  testWidgets('结束实例：灰取消什么也不做（壳还在、凭据还在、一个请求都没发）', (tester) async {
    await _pumpShell(tester, state);
    await _wind(tester);
    await _tapCard(tester, 'account-close');

    expect(find.text('取消'), findsOneWidget, reason: '结束实例必须先过项目既有的确认框');
    // 确认框把"登录状态保留"写在明面上（反向断言在下面那条文案用例里，逐字）
    expect(find.textContaining('登录状态保留'), findsOneWidget);
    await tester.tap(find.text('取消'));
    await _wind(tester);

    expect(api.authCalls, isEmpty, reason: '取消 = 什么都没发生');
    expect(api.commands, isEmpty, reason: '取消 ⇒ 连停实例的命令都不发');
    expect(state.ready, isTrue, reason: '人还在壳里');
    expect(state.api.token, 'good-token');
    expect(store.read(instance), 'good-token', reason: '取消之后本机那份凭据还在');
    expect(find.byKey(const ValueKey('account-close')), findsOneWidget, reason: '人还在那一页上');
  });

  testWidgets('结束实例：确认之后停后端 + 回选择页，而**凭据留着**（不作废会话）', (tester) async {
    await _pumpShell(tester, state);
    await _wind(tester);
    await _tapCard(tester, 'account-close');
    await tester.tap(find.widgetWithText(FilledButton, '结束实例').hitTestable());
    await _wind(tester);

    expect(api.commands, ['/api/commands/stop-instance|stop-instance'],
        reason: '只发这一条：带 X-Confirm 让后端优雅退出');
    expect(api.authCalls, isEmpty, reason: '反向断言：这条路**不许**调 /api/auth/logout（会话不动）');
    expect(state.ready, isFalse, reason: '结束实例之后不回壳里，落到门上');
    expect(state.api.token, isNull, reason: '内存里那张票要清掉');
    expect(store.read(instance), 'good-token',
        reason: '而盘上那份**留着**——回来点一下就能进，不用再输密码');
    expect(state.gate, AuthGateKind.picker, reason: '结束实例 ⇒ 回实例选择页（不是登录页）');
    expect(find.byType(AuthGate), findsOneWidget);
    expect(find.text('还没有登记过实例。新建一台开始用。'), findsOneWidget,
        reason: '登记表这份是空的：选择页如实说，并给"新建实例"');
    expect(find.byKey(const ValueKey('picker-new')), findsOneWidget);
    // 设置页整个收起来了（不是留着一页读不到数据的界面）
    expect(find.text('账号与安全'), findsNothing);
    // 现场那一行：token=kept 是这条路与"彻底登出"的唯一分别
    expect(lifeLines.last, matches(RegExp(r'^\[life\] close instance=.* stop=graceful waited=\d+s token=kept$')));
  });

  testWidgets('退出登录（清除本机凭据）：作废 → 清凭据 → 停实例，三件都发生（顺序断言）', (tester) async {
    await _pumpShell(tester, state);
    await _wind(tester);
    await _tapCard(tester, 'account-logout');
    await tester.tap(find.widgetWithText(FilledButton, '退出登录（清除本机凭据）').hitTestable());
    await _wind(tester);

    expect(api.authCalls, ['/api/auth/logout'], reason: '第一步：先让服务端把这条会话撤掉');
    expect(api.commands, ['/api/commands/stop-instance|stop-instance'],
        reason: '第二步：带 X-Confirm 让后端优雅退出（顺序不许换）');
    expect(api.timeline, <String>['auth /api/auth/logout', 'cmd /api/commands/stop-instance'],
        reason: '三件事的顺序：作废 → 停实例 → 清凭据（清凭据没有请求，落在盘上）');
    expect(state.ready, isFalse, reason: '之后不回壳里，落到门上');
    expect(state.api.token, isNull, reason: '内存里那张票要清掉');
    expect(store.read(instance), isNull, reason: '本实例那份凭据要清掉（session_store.clear）');
    expect(state.gate, AuthGateKind.picker, reason: '落点仍是实例选择页（不是登录页）');
    expect(find.byType(AuthGate), findsOneWidget);
    expect(find.byKey(const ValueKey('picker-new')), findsOneWidget);
    expect(lifeLines.last, matches(RegExp(r'^\[life\] logout instance=.* stop=graceful waited=\d+s token=cleared$')));
  });

  testWidgets('退出登录：服务端没答理（撤销失败）也照样清掉本机凭据', (tester) async {
    api.failLogout = true;
    await _pumpShell(tester, state);
    await _wind(tester);
    await _tapCard(tester, 'account-logout');
    await tester.tap(find.widgetWithText(FilledButton, '退出登录（清除本机凭据）').hitTestable());
    await _wind(tester);

    expect(api.authCalls, ['/api/auth/logout']);
    expect(state.ready, isFalse);
    expect(state.api.token, isNull);
    expect(state.gate, AuthGateKind.picker, reason: '撤销失败不影响"本地登出"这条路');
    expect(store.read(instance), isNull,
        reason: '撤销失败不该把票留在盘上——"登出之后界面还能自己进去"才是真的问题');
  });

  testWidgets('半升级态（凭老共享 token 进来）：卡片说清两条都做不成，出路摆在旁边；退出登录之后门上画"设置密码"', (tester) async {
    // 走**真实的 bootstrap** 那条路把 onLegacyToken 立起来（界面只有这一条路能变成这个状态）：
    // 空手打一条读端点 → 401 auth-uninitialized（这台实例还没设过密码）→ 读老那份全局凭据 → 进门
    const legacy = 'legacy-ui-token-value';
    File(legacyGuiTokenOverride!).writeAsStringSync(legacy);
    api.legacyToken = legacy;
    // 首屏那一趟是**空手**打的（真机就是这样）：手上没有会话票，盘上也没有这个实例的凭据。
    // 不摆干净的话第一条读端点会带着 setUp 里那张票出去，服务端回的是 unauthorized
    // （不是 auth-uninitialized），于是根本走不到"试老凭据"那一步。
    api.token = null;
    store.clear(instance);

    // 换一个干净的 state：这一条就是要真的走一遍 bootstrap（上面的 setUp 摆的是"已经在壳里"）
    closeState(state);
    state = AppState(api: api, sessions: store);
    state.setPage('settings');
    // **不能直接 `await state.bootstrap()`**：widget 测试体跑在假时钟里，而 bootstrap 中途要读
    // 一次 ui-state.json（真文件 I/O）——直接 await 会两边互等，整条用例挂住不返回（实测就是这么挂的）。
    // 改成"喂着 pump 等它落地"：每次 pump 都让真事件循环走一圈，I/O 回执才有机会被排进来。
    unawaited(state.bootstrap());
    for (var i = 0; i < 50 && !state.ready; i++) {
      await tester.pump(const Duration(milliseconds: 20));
    }
    expect(state.onLegacyToken, isTrue, reason: '前提：这一份是老的共享 token');
    expect(state.ready, isTrue, reason: '老凭据仍然能进门（半升级的那条兜底路）');

    await _pumpShell(tester, state);
    await _wind(tester);
    await tester.ensureVisible(find.byKey(const ValueKey('account-change-open')));
    await _wind(tester);

    expect(find.textContaining('服务端不认它开出的"会话"'), findsOneWidget,
        reason: '这一份凭据在服务端没有会话可撤、也没有旧密码可验——两条做不成这件事要写在明面上');
    expect(tester.widget<FilledButton>(find.byKey(const ValueKey('account-change-open'))).onPressed, isNull,
        reason: '这条路上改不了密码：按钮是灰的，理由就在它上面一行');
    expect(find.byKey(const ValueKey('account-setup-password')), findsOneWidget,
        reason: '出路（设置密码）要摆在旁边，不能只留一句"做不成"');

    // 退出登录：服务端对这条路是拒绝（409 legacy-token），本地照样登出；
    // 而 2026-10 之后落点统一是**实例选择页**——"该设密码还是该登录"由**选完实例**、
    // `bootstrap` 重新问一次服务端之后才决定（那一刻手上已经没有实例了，判不了）。
    api.failLogout = true;
    await _tapCard(tester, 'account-logout');
    await tester.tap(find.widgetWithText(FilledButton, '退出登录（清除本机凭据）').hitTestable());
    await _wind(tester);

    expect(state.ready, isFalse);
    expect(state.gate, AuthGateKind.picker, reason: '退出登录 ⇒ 实例选择页');
    expect(find.byKey(const ValueKey('picker-new')), findsOneWidget);
    expect(store.read(instance), isNull, reason: '本机那份凭据照样作废');

    // 收尾：bootstrap 那条路起了心跳定时器（startPolling），显式收掉它
    closeState(state);
  });

  // ───────────────────── ⑥ 文案一致性（反向断言） ─────────────────────

  /// 两颗"离开"的按钮不许互相矛盾：
  ///   · **结束实例**那处只能说"停后端 + 登录状态保留"——出现"已登出 / 退出登录 / 登出"
  ///     就是把两件事说成了一件事（人看了会以为回来要重新输密码）；
  ///   · **退出登录（清除本机凭据）**那处必须自己点明与"结束实例"的差别（它才是"要密码"那条）。
  ///
  /// 判据落在**文案表**上（页面里一个中文字面量都没有，`copy_coverage_test` 钉着这一条），
  /// 所以这里读 `ZhStrings` / `EnStrings` 就是读屏上的字。
  test('文案一致性：关实例只说"结束实例 + 登录状态保留"，一处"登出"字样都不许有', () {
    const zh = ZhStrings();
    // 关实例**这一个动作自己那两句**（按钮/标题 + 确认框正文）——这是"一处说保留一处说作废"
    // 最容易发生的地方，所以逐字反向断言。卡头那句 index（`settingsAccountNote`）不在射程内：
    // 它的职责是把三颗按钮的名字都列出来（见下面单独那一条）。
    final closeCopy = <String>[zh.settingsCloseInstance, zh.settingsCloseInstanceBody].join('\n');
    expect(closeCopy, contains('结束实例'));
    expect(closeCopy, contains('登录状态保留'), reason: '必须说清凭据留着（回来点一下就能进）');
    for (final banned in <String>['已登出', '退出登录', '登出']) {
      expect(closeCopy.contains(banned), isFalse,
          reason: '关实例那处出现了「$banned」——两件事被说成了一件事：$closeCopy');
    }
    // 卡头那句是**索引**：三颗按钮都得点到名（不提"退出登录"的话，安全出口就没人找得到）
    expect(zh.settingsAccountNote, contains('改密码'));
    expect(zh.settingsAccountNote, contains('结束实例'));
    expect(zh.settingsAccountNote, contains('退出登录'));
    // 关实例的**落点**那一屏（选择页）同样不许自相矛盾
    final pickerCopy = <String>[
      zh.pickerBody,
      zh.pickerEnter,
      zh.pickerStartEnter,
      zh.pickerSessionExpired,
    ].join('\n');
    expect(pickerCopy, contains('登录状态保留'), reason: '选择页要说清"回来点一下就进"');
    expect(pickerCopy.contains('作废'), isFalse, reason: '选择页不许再提"会话作废"（那条路已经不作了）');
    expect(pickerCopy.contains('登出'), isFalse);

    // 安全出口那一处：必须点明差别，而且它自己就是"要密码"那条路
    expect(zh.settingsLogout, contains('清除本机凭据'));
    expect(zh.settingsLogoutBody, contains('结束实例'), reason: '要指路到"只是关掉实例"那一颗');
    expect(zh.settingsLogoutBody, contains('密码'), reason: '说清下次要用密码进来');
    expect(zh.settingsCloseInstance, isNot(zh.settingsLogout), reason: '两个动作不许同名');

    // 英文那份同形（少了这几句，英文界面就会把两件事说混）
    const en = EnStrings();
    final enClose = <String>[en.settingsCloseInstance, en.settingsCloseInstanceBody].join('\n');
    expect(enClose.toLowerCase(), contains('sign-in is kept'));
    expect(enClose.toLowerCase().contains('sign out'), isFalse);
    expect(en.settingsLogoutBody, contains('End instance'));
    expect(en.settingsLogoutBody, contains('password'));
    expect(en.pickerBody.toLowerCase(), contains('sign-in is kept'));
  });
}

// ──────────────────────────────── 脚手架 ────────────────────────────────

/// 与 `IrmiaApp` 那个三元同构（`ready` 决定画壳还是画门），壳里落在**设置页**上——
/// 走的是真实链路：`HomeShell` → 页面注册表 → `SettingsPage` → 「账号与安全」分区。
/// 用替身而不是整个 `IrmiaApp`（后者会真去连 127.0.0.1:7788 并装托盘）。
Widget _harness(AppState state) => MaterialApp(
      theme: IrmiaTheme.light(),
      home: ListenableBuilder(
        listenable: state,
        builder: (context, _) => state.ready ? HomeShell(state: state) : AuthGate(state: state),
      ),
    );

/// 走完一段**有限**动画（对话框的进出场 ~150 毫秒）并让挂着的 Future 落地。
///
/// 这里**不能用 `pumpAndSettle`**：壳在屏上时侧栏那个状态点是 `BreathDot`，
/// 它的控制器是 `repeat(reverse: true)`——只要壳在，动画永远不会"停"，
/// `pumpAndSettle` 会一直等到超时（这一组的九条第一次就是这么全红的）。
/// 做法与 settings_page_test.dart 一致：按时间 pump。
Future<void> _wind(WidgetTester tester, [int ms = 400]) async {
  await tester.pump();
  await tester.pump(Duration(milliseconds: ms));
}

Future<void> _pumpShell(WidgetTester tester, AppState state) async {
  tester.view.physicalSize = const Size(1350, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_harness(state));
  await tester.pump(const Duration(milliseconds: 50));
}

/// 点设置页某张卡上的一颗按钮。
///
/// 「账号与安全」是这一页靠下的分区（前面还有六个分区），900 高的视口里它在屏幕外——
/// 不先滚过去的话 `tap` 会因为点不到而失败（那不是界面的毛病，是这一页本来就长）。
Future<void> _tapCard(WidgetTester tester, String key) async {
  final target = find.byKey(ValueKey(key));
  await tester.ensureVisible(target);
  await _wind(tester, 200);
  await tester.tap(target);
  await _wind(tester);
}

/// 进设置页 → 滚到「账号与安全」→ 点开「改密码」那张表单
Future<void> _openChangeDialog(WidgetTester tester, AppState state) async {
  await _pumpShell(tester, state);
  await _wind(tester);
  await _tapCard(tester, 'account-change-open');
}

Future<void> _fillChange(
  WidgetTester tester, {
  required String old,
  required String fresh,
  required String again,
}) async {
  await tester.enterText(find.byKey(const ValueKey('account-old')), old);
  await tester.enterText(find.byKey(const ValueKey('account-new')), fresh);
  await tester.enterText(find.byKey(const ValueKey('account-again')), again);
  await tester.pump();
}

/// API 替身：认证那两条按服务端的形状回，其余端点给最小的可用 JSON，
/// 好让设置页渲染得下去（这一组被测的不是设置页的取数）。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:7788');

  /// 认证端点收到过的路径（**"两次不一致不发请求"那条断言就落在这里**）
  final List<String> authCalls = [];
  final List<Map<String, dynamic>> authBodies = [];

  /// 认证与命令**同一条时间线**（"退出登录三件事的顺序"那条断言比它的下标）。
  ///
  /// 为什么要合起来：`规范`要求的是"作废 → 停实例 → 清凭据"这个**顺序**，两个各自
  /// 独立的列表只能证明"都发生过"，证明不了"先后"。
  final List<String> timeline = [];

  /// 改密码成功时服务端签发的新凭据
  String changedToken = 'changed-token';

  /// 非空 = 改密码失败，抛这一句（服务端的人话）
  String? changeFailure;

  /// true = 登出那条请求连不上（连接类失败）
  bool failLogout = false;

  /// 非空 = 这台实例**还没设过密码**，而这一串是"老界面那份全局凭据"：
  /// 空手打读端点回 401 `auth-uninitialized`，带上这一串就放行——半升级态就是这个现场。
  String? legacyToken;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    final legacy = legacyToken;
    if (legacy != null) {
      if (token == null) {
        throw ApiAuthError('这台实例还没设过密码。请先在界面里设置一个密码。',
            code: 'auth-uninitialized', instance: instance);
      }
      if (token != legacy) {
        throw ApiAuthError('会话凭据无效或已失效。请重新登录。', code: 'unauthorized', instance: instance);
      }
    }
    if (path.startsWith('/api/config')) {
      return <String, dynamic>{
        'dataDir': 'D:/irmia/data',
        'web': {'host': '127.0.0.1', 'port': 7788},
        'timezone': 'Asia/Shanghai',
        'models': {
          'heavy': {'model': 'gpt-4o-mini', 'baseUrl': 'https://api.example.com', 'apiKeyEnv': 'A'},
          'light': {'model': 'gpt-4o-mini-lite', 'baseUrl': 'https://api.example.com', 'apiKeyEnv': 'B'},
        },
        'budget': {
          'stepTools': 8,
          'turnSteps': 30,
          'taskTokens': 120000,
          'dailyTokens': 2000000,
          'softRatio': 0.8,
          'failStreakMax': 3,
        },
        'speak': {'typingEffect': true, 'charsPerMinute': 90},
      };
    }
    if (path.startsWith('/api/keys')) return <String, dynamic>{};
    if (path.startsWith('/api/deps')) {
      return <String, dynamic>{'available': true, 'entries': <dynamic>[]};
    }
    if (path.startsWith('/api/protocol-side')) {
      return <String, dynamic>{'configured': false, 'enabled': false, 'state': 'stopped', 'installed': false};
    }
    if (path.startsWith('/api/persona/file')) return <String, dynamic>{'content': ''};
    // projection / stats/dashboard 这些：给一份最小的壳能渲染的 JSON
    return <String, dynamic>{'lastSeq': 1, 'state': 'idle', 'tiles': {'needsReview': 0}};
  }

  @override
  Future<dynamic> postAuth(String path, Map<String, dynamic> body) async {
    authCalls.add(path);
    authBodies.add(body);
    timeline.add('auth $path');
    if (path == '/api/auth/logout') {
      if (failLogout) throw const SocketException('由于目标计算机积极拒绝，无法连接。');
      return <String, dynamic>{'ok': true, 'instance': instance};
    }
    if (path == '/api/auth/password') {
      final failure = changeFailure;
      if (failure != null) throw ApiError(401, failure);
      // 照服务端 sendSession 的形状：token + instance（改了密码签发的就是这一条）
      return <String, dynamic>{'ok': true, 'token': changedToken, 'instance': instance};
    }
    return <String, dynamic>{'ok': true};
  }

  /// 命令端点收到过的 `路径|X-Confirm`（**登出三步的顺序**那几条断言落在这里）。
  ///
  /// ⚠ 必须把它挡住：不覆盖的话 `AppState.logout` 的第二步会走**真 HTTP** 打到
  /// `127.0.0.1:7788` —— 假时钟里那条真连接永远不会完成（用例挂住），而且真机上
  /// 那个端口上跑着**用户正在用的那个实例**（一次真的 stop-instance 就能把它停掉）。
  final List<String> commands = [];

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    commands.add('$path|${confirm ?? ''}');
    timeline.add('cmd $path');
    if (path == '/api/commands/stop-instance') {
      return <String, dynamic>{'ok': true, 'stopping': true};
    }
    return <String, dynamic>{'ok': true};
  }
}
