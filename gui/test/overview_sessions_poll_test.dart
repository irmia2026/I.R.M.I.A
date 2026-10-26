import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';

/// 「外部会话」卡的**未读徽章会自己变**（2026-10-24 用户报的 bug）
///
/// 原话：「这个未读要有退出机制。一旦 `read_channel` 过对应的群聊之后，就不把未读标签取消掉了。
/// 直到再次有未读消息。」
///
/// 查出来的两侧原因各一条，这一份钉**界面那一侧**：这张卡原来只在进页/下拉/从离线回到在线
/// 时读一次 `GET /api/sessions`，页面开着不动就永远不重读——她那边 `read_channel` 写下的
/// `channel/read` 早已在日志里、服务端每次请求都是现折的（`sessionsView()`），
/// 屏幕上那个数字却停在原处。
///
/// 断言的是**这条链路本身**：同一个页面、不点任何东西，只让时间往前走 ⇒ 徽章从 3 变 0。
class _PollingApi extends IrmiaApi {
  _PollingApi({required this.sessionPayloads, this.failAfter = -1})
      : super(baseUrl: 'http://127.0.0.1:1');

  /// 每次 `GET /api/sessions` 依次取一份（用完就固定用最后一份）
  final List<Map<String, dynamic>> sessionPayloads;

  /// 从第几次请求起开始抛错（-1 = 不抛）
  final int failAfter;

  int sessionReads = 0;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/sessions') {
      final nth = sessionReads;
      sessionReads += 1;
      if (failAfter >= 0 && nth >= failAfter) {
        throw const ApiError(500, '主进程没有响应');
      }
      return sessionPayloads[nth.clamp(0, sessionPayloads.length - 1)];
    }
    return switch (path) {
      '/api/stats/dashboard' => {
          'state': 'idle',
          'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': 0, 'cacheHitRate': 0.9},
          'budget': {'tokensToday': 1200},
          'hourly': <dynamic>[],
          'recent': <dynamic>[],
          'suggestions': <dynamic>[],
          'personaIsSeed': false,
          'guardedDays': 3,
          'nextWakeAt': null,
        },
      '/api/projection' => {'needsReview': <dynamic>[]},
      '/api/framework-notes' => {'notes': <dynamic>[], 'count': 0, 'limit': 20},
      _ => null,
    };
  }
}

/// 一份 `/api/sessions` 应答：一个群、`unread` 条没看
Map<String, dynamic> _payload(int unread) => {
      'sessions': [
        {
          'sid': 'qq:group:G001', 'channel': 'qq-official', 'chatType': 'group', 'chatId': 'G001',
          'person': 'OPENID-A', 'name': '技术群', 'messages': 12, 'unread': unread,
          'readUpToSeq': 12 - unread, 'lastText': '在吗', 'lastSeenAt': '2026-10-24T02:00:00.000Z',
        },
      ],
      'contacts': {'qq:group:G001': '技术群'},
      'unreadTotal': unread,
    };

Future<void> _pump(WidgetTester tester, IrmiaApi api) async {
  final state = AppState(api: api);
  addTearDown(state.dispose);
  tester.view.physicalSize = const Size(1400, 1800);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: OverviewPage(state: state))),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  testWidgets('外部会话卡：页面不动，未读徽章也会跟着日志变（3 → 0）', (tester) async {
    final api = _PollingApi(sessionPayloads: [_payload(3), _payload(0)]);
    await _pump(tester, api);

    expect(find.text('技术群'), findsOneWidget);
    expect(find.text('未读 3'), findsOneWidget, reason: '进来时她欠着 3 条');
    expect(find.text('1 个群聊 · 0 个单聊 · 合计 3 条未读'), findsOneWidget);

    // 她在那头 read_channel 了 ⇒ 服务端下一次请求给 0。页面这一侧只需要"再问一次"。
    await tester.pump(const Duration(seconds: 15));
    // 后台那一拍**不许**把卡片打回 loading 态（否则每 15 秒闪一次"正在读…"）
    expect(find.text('正在读外部会话…'), findsNothing, reason: '静默刷新不进加载态');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(api.sessionReads, greaterThanOrEqualTo(2), reason: '轮询真的又读了一次');
    expect(find.text('未读 3'), findsNothing, reason: '读过了 ⇒ 徽章必须消失');
    expect(find.text('1 个群聊 · 0 个单聊 · 合计 0 条未读'), findsOneWidget);
    expect(find.text('技术群'), findsNothing,
        reason: '一条未读都没有时这张卡回到灰字空态（安静是常态）');

    // 再走一拍：还是没有新的 ⇒ 数字不乱跳
    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    expect(find.text('1 个群聊 · 0 个单聊 · 合计 0 条未读'), findsOneWidget);

    // 收尾：把页面拆掉，让那条周期定时器随 dispose 一起停（测试框架会检查悬挂的定时器）
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('外部会话卡：后台刷新失败时保留已经读到的行，不把卡片打成错误态', (tester) async {
    final api = _PollingApi(sessionPayloads: [_payload(3)], failAfter: 1);
    await _pump(tester, api);
    expect(find.text('未读 3'), findsOneWidget);

    await tester.pump(const Duration(seconds: 15));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(api.sessionReads, greaterThanOrEqualTo(2));
    expect(find.textContaining('外部会话读取失败'), findsNothing,
        reason: '一次后台刷新失败不该把已经读数的那一行换成红字（人会以为数据没了）');
    expect(find.text('未读 3'), findsOneWidget, reason: '保留上一次读到的事实，等下一拍再试');

    await tester.pumpWidget(const SizedBox());
  });
}
