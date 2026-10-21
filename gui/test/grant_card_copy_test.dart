import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
// `GrantPendingCard` / `GrantDoneRow` 是 `extensions_page.dart` 的 part
// （`extensions_kit.dart` 头一行就是 `part of 'extensions_page.dart'`）：只能从库入口 import。
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';

/// 申请单卡片上那三句"GUI 假话"的回归闸门（2026-10-21）。
///
/// 三处都是肉眼验出来的，且都不是"措辞不好"，而是**说了一件没发生的事**：
///
///   ① 待批卡右下角原来固定写「批准之后由框架写进 config.json 的 mcp.servers[]」——
///      技能那两支**根本不写 config.json**：装 = 建目录 + 写一条信任门凭据，
///      删 = 整目录移进回收站（`data/trash/`）。
///   ② 已审批行的首字原来是 `kind == 'mcp-add' ? '加' : '删'` ⇒ `skill-install`
///      那一行显示成「删 xxx」——装技能的单子被读成"删"。
///   ③ `execText` 的 ok 态原来固定是「框架已写进配置」——对技能两支同样是假话。
///
/// MCP 那两支的**文案逐字不许变**：这里用**原文常量**钉住（下面 `kMcpAfter` /
/// `kMcpExecOk` / `'加'` / `'删'` 都是从迁移前的源码抄下来的原串），
/// 谁顺手改了 MCP 的话，这份用例当场红。
const _mcpAfter = '批准之后由框架写进 config.json 的 mcp.servers[]（失败会回滚原文件）';
const _mcpExecOk = '框架已写进配置';
const _skillAfterInstall = '批准之后装进技能根 skills/<名字>；不会自动执行，要她读才会读';
const _skillAfterRemove = '批准之后整目录移进回收站（data/trash/），可移回';
const _skillExecOkInstall = '框架已装进技能根';
const _skillExecOkRemove = '已移进回收站';

/// 一张待批的申请单（只给卡片真会读的那几格；`GET /api/grants` 的 items 形状）
Map<String, dynamic> _pending({
  required String id,
  required String kind,
  required String name,
  List<String> scriptNames = const <String>[],
}) =>
    <String, dynamic>{
      'id': id,
      'kind': kind,
      'name': name,
      'desc': '每天早上收一份简报',
      'command': '',
      'args': <dynamic>[],
      'envKeys': <dynamic>[],
      'scriptNames': scriptNames,
      'reason': '想每天固定做一次',
      'context': '',
      'expiredAt': null,
      'requestedAt': '2026-02-14T02:00:00.000Z',
      'outcome': null,
      'outcomeAt': null,
      'rejectReason': null,
      'exec': null,
      'picked': true,
    };

/// 一张已经有结局的申请单（`exec` 那一格是框架落地的结果）
Map<String, dynamic> _done({
  required String id,
  required String kind,
  required String name,
  String state = 'ok',
  Map<String, dynamic> extra = const <String, dynamic>{},
}) =>
    <String, dynamic>{
      ..._pending(id: id, kind: kind, name: name),
      'outcome': 'approved',
      'outcomeAt': '2026-02-14T02:10:00.000Z',
      'exec': <String, dynamic>{'state': state, ...extra},
    };

void main() {
  /// 卡片放进真实主题里；[strings] 就是 `app.dart` 那一层的注入（默认回中文）。
  ///
  /// 画布给得宽（1800）：widget test 用的是测试字库 Ahem，**每个字符都按 fontSize 全宽**画
  /// （中文与英文一视同仁），一句 90 字的英文会占掉 1000+ px——那与真机（12px 正文里
  /// 拉丁字母约 6px 宽）不是一个尺度。这一份用例验的是**文案与分支**，版面由
  /// `grant_card_golden_test.dart` 那 4 张图（真字体）验，所以这里不为字库的宽度假象改布局。
  Future<void> pumpCard(WidgetTester tester, Widget card,
      {AppStrings strings = const ZhStrings()}) async {
    tester.view.physicalSize = const Size(1800, 1400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      builder: (context, inner) =>
          IrmiaStrings(strings: strings, child: inner ?? const SizedBox.shrink()),
      home: Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: card,
        ),
      ),
    ));
    await tester.pump();
  }

  Future<void> pumpPending(WidgetTester tester, Map<String, dynamic> grant,
      {AppStrings strings = const ZhStrings()}) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await pumpCard(
      tester,
      GrantPendingCard(
        grant: grant,
        reasonController: controller,
        onApprove: () async {},
        onReject: () async {},
      ),
      strings: strings,
    );
  }

  testWidgets('① 待批卡右下角：技能两支各说各的落地，MCP 那支逐字照旧', (tester) async {
    // 装：建目录 + 信任门凭据。**不许**再写 config.json。
    await pumpPending(tester, _pending(id: 's-1', kind: 'skill-install', name: 'daily-brief'));
    expect(find.text(_skillAfterInstall), findsOneWidget);
    expect(find.text(_mcpAfter), findsNothing, reason: '装技能不写 config.json，这句话在这里就是假话');

    // 删：整目录移进回收站（可移回）。
    await pumpPending(tester, _pending(id: 's-2', kind: 'skill-remove', name: 'old-skill'));
    expect(find.text(_skillAfterRemove), findsOneWidget);
    expect(find.text(_mcpAfter), findsNothing, reason: '删技能走回收站，不写 config.json');

    // MCP：原文一字不改（这一支才是真的写 config.json）。
    for (final kind in <String>['mcp-add', 'mcp-remove']) {
      await pumpPending(tester, _pending(id: 'g-1', kind: kind, name: 'demo'));
      expect(find.text(_mcpAfter), findsOneWidget, reason: '$kind 那句必须逐字未变');
      expect(find.text(_skillAfterInstall), findsNothing);
      expect(find.text(_skillAfterRemove), findsNothing);
    }

    // 英文：同一张卡换成 English 就换句子（新文案确实走了 i18n，不是页面里写死的）
    await pumpPending(tester, _pending(id: 's-1', kind: 'skill-install', name: 'daily-brief'),
        strings: const EnStrings());
    expect(find.text(const EnStrings().extGrantAfterSkillInstall), findsOneWidget);
    expect(find.text(_skillAfterInstall), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('②③ 已审批行：skill-install 是"装"＋"框架已装进技能根"，MCP 两支照旧', (tester) async {
    // 装技能：首字是"装"（这里曾经显示成"删 daily-brief"）
    await pumpCard(tester, GrantDoneRow(grant: _done(id: 's-1', kind: 'skill-install', name: 'daily-brief')));
    expect(find.text('装 daily-brief'), findsOneWidget);
    expect(find.text('删 daily-brief'), findsNothing, reason: '装技能的单子不许读成"删"');
    expect(find.text(_skillExecOkInstall), findsOneWidget);
    expect(find.text(_mcpExecOk), findsNothing, reason: '装技能不写配置，ok 态不许说"写进配置"');

    // 删技能：仍是"删"，但落地那句换成回收站
    await pumpCard(tester, GrantDoneRow(grant: _done(id: 's-2', kind: 'skill-remove', name: 'old-skill')));
    expect(find.text('删 old-skill'), findsOneWidget);
    expect(find.text(_skillExecOkRemove), findsOneWidget);
    expect(find.text(_mcpExecOk), findsNothing);

    // MCP 两支：首字"加"/"删"、ok 态"框架已写进配置"，逐字未变
    await pumpCard(tester, GrantDoneRow(grant: _done(id: 'g-1', kind: 'mcp-add', name: 'demo')));
    expect(find.text('加 demo'), findsOneWidget);
    expect(find.text(_mcpExecOk), findsOneWidget);

    await pumpCard(tester, GrantDoneRow(grant: _done(id: 'g-2', kind: 'mcp-remove', name: 'demo')));
    expect(find.text('删 demo'), findsOneWidget);
    expect(find.text(_mcpExecOk), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  test('三条新文案：中英各一份（中文逐字等于验收口径，英文里没有汉字）', () {
    const zh = ZhStrings();
    const en = EnStrings();

    expect(zh.extGrantAfterSkillInstall, _skillAfterInstall);
    expect(zh.extGrantAfterSkillRemove, _skillAfterRemove);
    expect(zh.extGrantExecOkSkillInstall, _skillExecOkInstall);
    expect(zh.extGrantExecOkSkillRemove, _skillExecOkRemove);
    expect(zh.extGrantLabelSkillInstall, '装');

    // 五条之间有区分：删技能不许与装技能同一句、ok 态不许与 MCP 那句同一句
    expect(zh.extGrantAfterSkillInstall, isNot(zh.extGrantAfterSkillRemove));
    expect(zh.extGrantExecOkSkillInstall, isNot(zh.extGrantExecOkSkillRemove));
    expect(zh.extGrantExecOkSkillInstall, isNot(_mcpExecOk));
    expect(zh.extGrantExecOkSkillRemove, isNot(_mcpExecOk));

    final english = <String, String>{
      'extGrantAfterSkillInstall': en.extGrantAfterSkillInstall,
      'extGrantAfterSkillRemove': en.extGrantAfterSkillRemove,
      'extGrantExecOkSkillInstall': en.extGrantExecOkSkillInstall,
      'extGrantExecOkSkillRemove': en.extGrantExecOkSkillRemove,
      'extGrantLabelSkillInstall': en.extGrantLabelSkillInstall,
    };
    for (final entry in english.entries) {
      expect(entry.value.trim(), isNotEmpty, reason: '${entry.key} 的英文是空串——英文界面这一句会消失');
      expect(RegExp(r'[\u4e00-\u9fff]').hasMatch(entry.value), isFalse,
          reason: '${entry.key} 的英文里混进了汉字：${entry.value}');
    }
    expect(en.extGrantAfterSkillInstall, isNot(zh.extGrantAfterSkillInstall));
    expect(en.extGrantAfterSkillRemove, isNot(zh.extGrantAfterSkillRemove));
    expect(en.extGrantExecOkSkillInstall, isNot(zh.extGrantExecOkSkillInstall));
    expect(en.extGrantExecOkSkillRemove, isNot(zh.extGrantExecOkSkillRemove));
  });
}
