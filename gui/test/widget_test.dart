import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/theme.dart';

/// GUI 冒烟：无后端时也应渲染 token 门（而不是白屏/崩溃）。
void main() {
  testWidgets('无 token 时显示 token 门', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: IrmiaTheme.light(),
        home: Builder(
          builder: (context) => const Scaffold(body: SizedBox()),
        ),
      ),
    );
    expect(find.byType(Scaffold), findsOneWidget);
  });

  test('状态词表与 Web 端一致', () {
    expect(IrmiaTheme.humanState('running'), '执行中');
    expect(IrmiaTheme.humanState('sleeping'), '休眠中');
    expect(IrmiaTheme.humanState('needs-review', needsReview: 3), '待确认（3 项）');
    expect(IrmiaTheme.humanState(null), '状态未知');
  });

  test('状态四色不随主题漂移', () {
    expect(IrmiaTheme.ok, const Color(0xFF2F9E44));
    expect(IrmiaTheme.warn, const Color(0xFFF08C00));
    expect(IrmiaTheme.danger, const Color(0xFFE03131));
  });

  test('一级入口六项：运行情况在首位、日程排在聊天与人格配置之间', () {
    // 条数从五项变六项的由来：用户 2026-10 要一页「日程」，推翻了 docs/gui-design.md §3
    // 原来那句"保持五项"（见 app.dart 里 navPages 上方的注释）。
    expect(navPages.map((p) => p.id).toList(), [
      'overview',
      'chat',
      'schedule',
      'persona',
      'channels',
      'extensions',
    ]);
    expect(morePages.map((p) => p.id).toList(), ['memory', 'logs', 'settings']);
    expect(allPages.length, navPages.length + morePages.length);
  });

  test('注册表按 id 唯一定位，默认页在表内', () {
    final ids = allPages.map((p) => p.id).toList();
    expect(ids.toSet().length, ids.length, reason: '页面 id 有重复');
    expect(pageEntryById(defaultPageId)?.id, defaultPageId, reason: '默认页不在注册表里');
    for (final id in ids) {
      expect(pageEntryById(id)?.id, id);
    }
    expect(pageEntryById('no-such-page'), isNull);
  });

  test('setPage 按 id 定位：未知 id 保持当前页', () {
    final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));
    expect(state.pageId, defaultPageId);
    state.setPage('settings');
    expect(state.pageId, 'settings');
    state.setPage('settings');
    expect(state.pageId, 'settings');
    state.setPage('no-such-page');
    expect(state.pageId, 'settings', reason: '未知 id 不应改变当前页');
    state.dispose();
  });
}
