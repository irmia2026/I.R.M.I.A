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

  test('一级七项、其余收进「更多」：顺序与注册表稳定', () {
    // 条数不是判据：一级只放高频功能。2026-11 情绪上移后，人格 / 扩展 / 消息适配器也
    // 移回一级，只把记忆 / 日志 / 设置留在「更多」（见 app.dart 里 navPages 上方的注释）。
    expect(navPages.map((p) => p.id).toList(), [
      'overview',
      'chat',
      'schedule',
      'mood',
      'persona',
      'extensions',
      'channels',
    ]);
    expect(morePages.map((p) => p.id).toList(), ['memory', 'logs', 'settings']);
    expect(allPages.length, navPages.length + morePages.length);
    expect(pageEntryById('persona')?.label, '人格');
    expect(pageEntryById('extensions')?.label, '扩展');
    expect(pageEntryById('channels')?.label, '消息适配器');
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
