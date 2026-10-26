import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/grant_inbox.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/theme.dart';

/// **待批那一份数据的判据**（`lib/grant_inbox.dart`）+ 壳一级的三处接线
/// （`AppState.pendingGrants` / 左侧「扩展」角标 / `decideGrant` 发出去的 body）。
///
/// 这一份钉的是**判据**，不是画法：
///   · 哪张算**高风险**（白名单：低风险只剩 `mcp-remove` / `skill-remove` 两支）；
///   · 哪些算**待批**（`picked == true && outcome == null`，与扩展页逐字同一条）；
///   · 顺序（最新在最前，同一时刻保持服务端给的先后——不稳定排序会让卡每 10 秒换位）；
///   · 轮询的三条分寸（同内容不通知 / 读失败不清空 / 防重入）。
///
/// 画法在 `test/grant_inbox_overlay_test.dart`（widget）与 `test/grant_inbox_golden_test.dart`（图）。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  /// 按路径给回执（`/api/grants` 的 `items` 就摆在这里）
  final routes = <String, dynamic>{};

  /// 让某条路径读失败（轮询的"读失败不清空"要靠它）
  final failures = <String, Object>{};

  final posts = <Map<String, dynamic>>[];

  /// 记下 GET 了几次（"防重入"与"每拍只读一次"都看它）
  int gets = 0;

  /// post 的回执（批准/驳回那条）
  dynamic reply;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    gets += 1;
    final failure = failures[path];
    if (failure != null) throw failure;
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add(<String, dynamic>{'path': path, ...body});
    return reply ?? {'outcome': 'approved', 'exec': <String, dynamic>{'state': 'ok'}};
  }
}

/// 一张待批的申请单（字段照 `GET /api/grants` 的 items 形状）
Map<String, dynamic> pendingGrant({
  String id = 'g-1',
  String kind = 'mcp-add',
  String name = 'obscura',
  String command = 'node',
  List<dynamic> args = const <dynamic>['C:\\nowhere\\obscura.js'],
  List<dynamic> scriptNames = const <dynamic>[],
  String requestedAt = '2026-02-14T02:00:00.000Z',
  bool picked = true,
  String? outcome,
}) =>
    <String, dynamic>{
      'id': id,
      'kind': kind,
      'name': name,
      'desc': '读本机浏览器历史与当前标签页',
      'command': command,
      'args': args,
      'envKeys': <dynamic>[],
      'scriptNames': scriptNames,
      'fileCount': 0,
      'reason': '想用它看本机浏览器里开着什么',
      'question': '批准加一个 MCP server「$name」？',
      'context': '它会做什么：读本机浏览器历史与当前标签页',
      'askSeq': 7,
      'expiredAt': null,
      'requestedAt': requestedAt,
      'outcome': outcome,
      'outcomeAt': null,
      'rejectReason': null,
      'exec': null,
      'picked': picked,
    };

void main() {
  group('风险分级（白名单：低风险只剩可回滚的两支）', () {
    test('mcp-remove / skill-remove 是低风险（可回滚 / 可移回）', () {
      expect(grantRiskOf(pendingGrant(kind: 'mcp-remove')), GrantRisk.low);
      expect(grantRiskOf(pendingGrant(kind: 'skill-remove')), GrantRisk.low);
    });

    test('mcp-add / skill-install 是高风险（会引入新东西）', () {
      expect(grantRiskOf(pendingGrant(kind: 'mcp-add')), GrantRisk.high);
      expect(grantRiskOf(pendingGrant(kind: 'skill-install')), GrantRisk.high);
    });

    test('认不出的 kind 也是高风险（白名单的意义：将来加第五种 kind 时不默认放行）', () {
      expect(grantRiskOf(pendingGrant(kind: 'hook-add')), GrantRisk.high);
      expect(grantRiskOf(<String, dynamic>{}), GrantRisk.high);
    });

    test('白名单常量本身就是那两支（改这一行 = 改安全边界）', () {
      expect(kLowRiskGrantKinds, <String>{'mcp-remove', 'skill-remove'});
    });
  });

  group('哪些算待批 / 顺序', () {
    test('只留「递了（picked）且还没结局（outcome == null）」的', () {
      expect(isPendingGrant(pendingGrant()), isTrue);
      expect(isPendingGrant(pendingGrant(picked: false)), isFalse,
          reason: '还没被拾取的那些没有 grant/requested，卡上什么都说不出来');
      expect(isPendingGrant(pendingGrant(outcome: 'approved')), isFalse);
      expect(isPendingGrant(pendingGrant(outcome: 'rejected')), isFalse);
    });

    test('最新在最前；同一时刻保持服务端给的先后（不稳定排序会让卡每 10 秒换位）', () {
      final items = <Map<String, dynamic>>[
        pendingGrant(id: 'a', requestedAt: '2026-02-14T01:00:00.000Z'),
        pendingGrant(id: 'b', requestedAt: '2026-02-14T03:00:00.000Z'),
        pendingGrant(id: 'c', requestedAt: '2026-02-14T02:00:00.000Z'),
        pendingGrant(id: 'd', requestedAt: '2026-02-14T03:00:00.000Z'),
      ];
      final ordered = pendingGrantsNewestFirst(items).map((grant) => grant['id']).toList();
      expect(ordered, <String>['b', 'd', 'c', 'a']);
    });

    test('非待批的被剔掉，形状不对的输入不炸', () {
      final ordered = pendingGrantsNewestFirst(<dynamic>[
        pendingGrant(id: 'done', outcome: 'approved'),
        pendingGrant(id: 'keep'),
        'not-a-map',
      ]);
      expect(ordered.map((grant) => grant['id']), <String>['keep']);
      expect(pendingGrantsNewestFirst(null), isEmpty);
      expect(pendingGrantsNewestFirst('nonsense'), isEmpty);
    });
  });

  group('两份清单是不是同一批', () {
    test('id / kind / name 全同 = 同一批（轮询据此决定要不要通知）', () {
      expect(
        samePendingGrants([pendingGrant(id: 'g-1')], [pendingGrant(id: 'g-1')]),
        isTrue,
      );
    });

    test('多一条 / 换了名字 / 换了 kind 都算变了', () {
      expect(samePendingGrants([pendingGrant(id: 'g-1')], <Map<String, dynamic>>[]), isFalse);
      expect(
        samePendingGrants([pendingGrant(id: 'g-1', name: 'a')], [pendingGrant(id: 'g-1', name: 'b')]),
        isFalse,
      );
      expect(
        samePendingGrants(
            [pendingGrant(id: 'g-1', kind: 'mcp-add')], [pendingGrant(id: 'g-1', kind: 'mcp-remove')]),
        isFalse,
      );
    });
  });

  group('轮询（10 秒一拍、复用 GET /api/grants）', () {
    test('间隔默认就是 10 秒（与慢档心跳同一档，见常量注释）', () {
      expect(kGrantPollSeconds, 10);
      final poller = PendingGrantPoller(api: _FakeApi(), onPending: (_) {});
      addTearDown(poller.dispose);
      expect(poller.interval, const Duration(seconds: 10));
    });

    test('start() 立刻读一次；内容没变就不通知', () async {
      final api = _FakeApi()..routes['/api/grants'] = {'items': <dynamic>[pendingGrant()]};
      final seen = <List<Map<String, dynamic>>>[];
      final poller = PendingGrantPoller(api: api, onPending: seen.add);
      addTearDown(poller.dispose);
      poller.start();
      await Future<void>.delayed(Duration.zero);
      expect(poller.reads, 1);
      expect(seen.length, 1, reason: '第一次读到待批 ⇒ 通知一次');
      expect(seen.single.single['id'], 'g-1');
      // 同一份再读一遍：**不通知**（否则右下角那张卡每 10 秒重建一次）
      await poller.refresh();
      expect(poller.reads, 2);
      expect(seen.length, 1);
      poller.stop();
    });

    test('读失败：不清空手上那份，原因记在 lastError（清单不会凭空消失）', () async {
      final api = _FakeApi()..routes['/api/grants'] = {'items': <dynamic>[pendingGrant()]};
      final seen = <List<Map<String, dynamic>>>[];
      final poller = PendingGrantPoller(api: api, onPending: seen.add);
      addTearDown(poller.dispose);
      await poller.refresh();
      expect(poller.last.single['id'], 'g-1');
      api.failures['/api/grants'] = ApiError(500, 'boom');
      await poller.refresh();
      expect(poller.last.single['id'], 'g-1', reason: '读失败不许把屏幕上的卡清掉');
      expect(poller.lastError, isNotNull);
      expect(seen.length, 1, reason: '失败不通知（没有新清单）');
    });

    test('401 只记一笔，不当成"清单空了"（自愈归壳的心跳）', () async {
      final api = _FakeApi()..routes['/api/grants'] = {'items': <dynamic>[pendingGrant()]};
      final poller = PendingGrantPoller(api: api, onPending: (_) {});
      addTearDown(poller.dispose);
      await poller.refresh();
      api.failures['/api/grants'] = const ApiAuthError('凭据不作数了');
      await poller.refresh();
      expect(poller.lastError, 'unauthorized');
      expect(poller.last, isNotEmpty);
    });

    test('防重入：一次读在飞的时候再点一次，不会再打一遍端点', () async {
      final api = _FakeApi()..routes['/api/grants'] = {'items': <dynamic>[]};
      final poller = PendingGrantPoller(api: api, onPending: (_) {});
      addTearDown(poller.dispose);
      // 两条并发的 refresh：第二条让位（判据是 _ticking）
      await Future.wait(<Future<void>>[poller.refresh(), poller.refresh()]);
      expect(api.gets, 1);
      expect(poller.reads, 1);
    });

    // ── 读不出来的单子（2026-10-22）──────────────────────────────
    //
    // 那一档既没有 `grant/requested`（于是 `picked:false`、不进待批队列），又解析不过
    // （于是挂不出卡）。过去它什么都不显示——"人写了单子、框架一声不响"就是这么来的。
    test('malformed 那一段单独读出来、单独通知（不进待批队列）', () async {
      final api = _FakeApi()
        ..routes['/api/grants'] = <String, dynamic>{
          'items': <dynamic>[pendingGrant()],
          'malformed': <dynamic>[
            <String, dynamic>{'id': 'g-bad', 'why': 'kind 只能是 "mcp-add" / "mcp-remove"'},
          ],
        };
      final pending = <List<Map<String, dynamic>>>[];
      final broken = <List<Map<String, dynamic>>>[];
      final poller = PendingGrantPoller(
        api: api,
        onPending: pending.add,
        onMalformed: broken.add,
      );
      addTearDown(poller.dispose);
      await poller.refresh();
      expect(pending.single.single['id'], 'g-1');
      expect(pending.single.length, 1, reason: '读不出来的那张绝不能被并进待批队列（它没有可点的卡）');
      expect(broken.single.single['id'], 'g-bad');
      expect(broken.single.single['why'], contains('mcp-remove'));
      // 同一份再读一遍：两条链都**不通知**（否则每 10 秒重建一次）
      await poller.refresh();
      expect(pending.length, 1);
      expect(broken.length, 1);
      expect(poller.lastMalformed.single['id'], 'g-bad');
    });

    test('读失败：手上的 malformed 也不清空（与待批清单同一条分寸）', () async {
      final api = _FakeApi()
        ..routes['/api/grants'] = <String, dynamic>{
          'items': <dynamic>[],
          'malformed': <dynamic>[<String, dynamic>{'id': 'g-bad', 'why': '文件读不出来'}],
        };
      final poller = PendingGrantPoller(api: api, onPending: (_) {});
      addTearDown(poller.dispose);
      await poller.refresh();
      expect(poller.lastMalformed, hasLength(1));
      api.failures['/api/grants'] = ApiError(500, 'boom');
      await poller.refresh();
      expect(poller.lastMalformed, hasLength(1), reason: '读失败不许让"有一张单读不出来"这句话凭空消失');
    });
  });

  group('AppState · 待批那一格与那次点头', () {
    test('applyPendingGrants 收下清单并通知（三处显示读的是同一份）', () {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      var notified = 0;
      state.addListener(() => notified += 1);
      expect(state.pendingGrantCount, 0);
      state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant(), pendingGrant(id: 'g-2')]);
      expect(state.pendingGrantCount, 2);
      expect(notified, 1, reason: '改了清单要通知（卡 / 角标 / 托盘都靠它重建）');
    });

    test('applyMalformedGrants：独立一格、独立通知，且**不混进**待批清单', () {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      var notified = 0;
      state.addListener(() => notified += 1);
      state.applyMalformedGrants(<Map<String, dynamic>>[
        <String, dynamic>{'id': 'g-bad', 'why': '文件读不出来'},
        <String, dynamic>{'id': '', 'why': '没有 id 的那条要丢掉'},
      ]);
      expect(state.malformedGrants, hasLength(1), reason: '形状不对的条目滤掉（没有 id 就说不清是哪一张）');
      expect(state.malformedGrants.single['id'], 'g-bad');
      expect(state.pendingGrantCount, 0, reason: '它绝不进待批队列（那一档没有可点的卡）');
      expect(notified, 1);
    });

    test('批准：body 里只有 id + decision（批准**不带**理由）', () async {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      final decision = await state.decideGrant('g-1', approve: true, reason: '这段不该被发出去');
      expect(decision.recorded, isTrue);
      expect(decision.outcome, 'approved');
      expect(decision.execState, 'ok');
      expect(api.posts.single, <String, dynamic>{
        'path': '/api/commands/grant-decide',
        'id': 'g-1',
        'decision': 'approve',
      });
    });

    test('驳回：带理由；理由留空也照发（人不该被必填项挡住驳回）', () async {
      final api = _FakeApi()
        ..reply = <String, dynamic>{'outcome': 'rejected', 'exec': <String, dynamic>{'state': 'not-applicable'}};
      final state = AppState(api: api);
      addTearDown(state.dispose);
      final decision = await state.decideGrant('g-2', approve: false, reason: '它会读我的浏览记录');
      expect(decision.outcome, 'rejected');
      expect(api.posts.single['reason'], '它会读我的浏览记录');
      await state.decideGrant('g-3', approve: false);
      expect(api.posts.last['reason'], '', reason: '留空是空串，不是"不发"');
    });

    test('请求没落地：recorded == false 且带原因（卡要留在原地）', () async {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      // 打一个连不上的端口那一下太慢：直接把 post 换成抛错
      final failing = _ThrowingApi();
      final broken = AppState(api: failing);
      addTearDown(broken.dispose);
      final decision = await broken.decideGrant('g-1', approve: true);
      expect(decision.recorded, isFalse);
      expect(decision.error, isNotNull);
      expect(decision.error, contains('boom'));
      expect(api.posts, isEmpty);
    });
  });

  group('左侧「扩展」角标（0 时不显示）', () {
    Future<void> pumpShell(WidgetTester tester, AppState state) async {
      tester.view.physicalSize = const Size(1350, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(MaterialApp(
        theme: IrmiaTheme.light(),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) => HomeShell(state: state),
        ),
      ));
      await tester.pump(const Duration(milliseconds: 300));
    }

    testWidgets('有待批 ⇒ 角标就是那个数', (tester) async {
      final state = AppState(api: _FakeApi());
      addTearDown(state.dispose);
      state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant(), pendingGrant(id: 'g-2')]);
      await pumpShell(tester, state);
      final nav = find.byKey(const ValueKey('nav-extensions'));
      expect(nav, findsOneWidget);
      expect(
        find.descendant(of: nav, matching: find.text('2')),
        findsOneWidget,
        reason: '左侧「扩展」上应挂着 2（右下角那张卡会收起，这是第二处痕迹）',
      );
    });

    testWidgets('没有待批 ⇒ 一个角标都不画（不摆「0」）', (tester) async {
      final state = AppState(api: _FakeApi());
      addTearDown(state.dispose);
      await pumpShell(tester, state);
      final nav = find.byKey(const ValueKey('nav-extensions'));
      expect(nav, findsOneWidget);
      expect(find.descendant(of: nav, matching: find.text('0')), findsNothing);
    });

    testWidgets('批掉之后角标跟着消失（同一份数据驱动）', (tester) async {
      final state = AppState(api: _FakeApi());
      addTearDown(state.dispose);
      state.applyPendingGrants(<Map<String, dynamic>>[pendingGrant()]);
      await pumpShell(tester, state);
      final nav = find.byKey(const ValueKey('nav-extensions'));
      expect(find.descendant(of: nav, matching: find.text('1')), findsOneWidget);
      state.applyPendingGrants(const <Map<String, dynamic>>[]);
      await tester.pump();
      expect(find.descendant(of: nav, matching: find.text('1')), findsNothing);
    });
  });
}

/// post 一定失败的那一份（验 `recorded == false` 那条路）
class _ThrowingApi extends IrmiaApi {
  _ThrowingApi() : super(baseUrl: 'http://127.0.0.1:1');

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    throw ApiError(500, 'boom');
  }

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async => null;
}
