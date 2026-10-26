import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 运行情况页那三处收敛，以及「当前上下文构成」这一块。
///
/// 那一批（`backup/ui-rework-20261025-013243`）整块回退之后，用户只留三条：
///   ① 「待确认」「连续失败」两张 0 值磁贴删掉（数据字段照旧在，只是不画）；
///   ② 「定时器」整块删掉（与日程页重复，撤销在那边）；
///   ③ 原来两张卡的位置换成一整块全宽的「当前上下文构成」，**进度条要分颜色**。
///
/// 2026-10-25 夜里用户又提了三条（同一页）：
///   ④ 上下文构成**太细**：三组那三行可折叠明细整块删掉，只留标题 + 右侧总量 + 副行 + 三色横条；
///   ⑤ 图例改成**三片并排一行**（每片 `圆点 + 组名 + tokens + 占比`），不许溢出；
///   ⑥ 磁贴那一排**恰好两张**，折线必须画在自己的卡里。
///
/// 2026-10-25 深夜第三次（本文件这次的重头）—— 用户的原话：
///   > 「为什么上下文构成还在这一行？而不是跟用量、命中率在同一行？」
///   ⑦ 上下文构成并进那一排，**三张卡一行**：今日用量 : 缓存命中率 : 当前上下文构成 = **1 : 1 : 2**
///      （当夜更晚用户又改了口径：「算了。改成三个卡片等宽吧」⇒ 现在是 **1 : 1 : 1**，见 ㉘），
///      **等高**、同一条顶边、同一个外壳；
///   ⑧ 窄窗（内容宽 < 1000）折成两行：第一行两张磁贴、第二行上下文卡**占满整行**；
///   ⑨ 原来那块单独占一整行的全宽看板**连挂载点一起删掉**，只留一份实现（`_ContextTile`）。
///
/// 2026-10-25 深夜第四次（⑩-⑬，用户原话）：
///   > 「不对，变太高了。高度还得是原来的。用量、命中率的那个高度」
///   ⑩ 整排高度**锚在用量卡的自然高度 H 上**，不是"三张里最高的那张"：三卡高度都 = H（±1px）。
///      `IntrinsicHeight` 取最高 ⇒ 上下文卡把整排撑到 189；现在 H 由用量卡单独算出来；
///   ⑪ 卡面只留四行（主数字 / 标签行 / 8px 三色横条 / 一行三片图例）：
///      `168.2k / 200k tok` 与 `占预算 84% · 保留历史思维链：开 · 取自 … 那一拍` 两条**搬进
///      整卡的 tooltip**（悬停可见），卡面不再出现；
///   ⑫ 空 / 读不到 / 正在读三态**也落在 H 里**，内容更少时**在剩下的高度里居中**；
///   ⑬ 窄窗折两行时，上下文卡的高度**仍等于**用量卡的高度。
///
/// ⑦-⑬ 全部用**几何断言**（渲染后的矩形）与**渲染后的高度**，不靠截图：宽窗三卡 `top` 相同 /
/// `left` 递增 / **三卡等宽（±2）** / **三张高度都等于用量卡的自然高度** / 不溢出；窄窗三卡 `top`
/// 只有两种值、上下文卡宽 ≈ 内容宽、**高度仍等于用量卡**；反向：上下文构成只出现在那一排里。
///
/// 2026-10-25 深夜第五次（用例 ㉔-㉗，用户原话）：
///   > 「看起来还是有点不协调，进度条和图例要在底部。然后如果百分比加回来能更协调的话就加上去吧」
///   ⑭ 这张卡与另两张**同构**：主数字（占预算 %，26/w600/等宽）在顶、标签行第二、
///      8px 三色条与三片图例**贴底**；底对齐靠 `Spacer`（条到图例缝 6），卡高仍 = H；
///   ⑮ 三态同构：加载（大数字位一条灰条 + 底部灰条）/ 空（`—` + 灰槽 + 一句人话）/
///      读不到（`—` + 一行原因 + 就地重试）；
///   ⑯ 主数字 = **整数百分比**（`^\d+%$`，四舍五入）；三卡主数字同字号、同基线（top 差 ≤1）；
///   ⑰ 反向：卡面没有"占预算 … 取自 … 那一拍"长句（仍在整卡 tooltip），图例挤了先砍 tokens。
///
/// 2026-10-25 深夜第六次（用例 ㉘，用户原话）：
///   > 「算了。改成三个卡片等宽吧」
///   ⑱ 三张卡**等宽 1 : 1 : 1**（缝仍 12）：上下文卡从 2/4 收到 1/3（内容宽 1348 时 441px），
///      它挤的时候**只用已有的两档**收——图例先砍读数里的 tokens（只留占比）、标签行先整条让掉
///      总量（不画半截数）；主数字（百分比）与三色条永不裁；卡高仍是 H，窄窗阈值仍是内容宽 1000。
class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes, {this.fail = const <String>{}, this.gate})
      : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;

  /// 要抛错的路径（模拟单条端点读不到）
  final Set<String> fail;

  /// 非空时 `GET /api/context/breakdown` 的**第一次**先挂住，直到 [release]——
  /// 用来观察"数据还没到"那一态（骨架条）
  final Completer<void>? gate;

  int breakdownReads = 0;

  void release() => gate?.complete();

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/context/breakdown') {
      final nth = breakdownReads;
      breakdownReads += 1;
      if (gate != null && nth == 0) await gate!.future;
    }
    if (fail.contains(path)) throw const ApiError(500, '主进程没有响应');
    return routes[path];
  }
}

/// 状态与用量：磁贴的数据照旧给全（`tiles.pending` / `failStreak` 都在）——
/// 那两个数现在**只是不画**，不是从数据里删掉。
Map<String, dynamic> _base({List<dynamic> hourly = const <dynamic>[]}) => {
      '/api/stats/dashboard': {
        'state': 'idle',
        'tiles': {'pending': 7, 'failStreak': 4, 'needsReview': 0, 'cacheHitRate': 0.9},
        'budget': {'tokensToday': 1200},
        'hourly': hourly,
        'recent': <dynamic>[],
        'suggestions': <dynamic>[],
        'personaIsSeed': false,
        'guardedDays': 3,
        'nextWakeAt': null,
      },
      // 定时器数据也照旧给：删掉的是那一块界面，不是投影字段
      '/api/projection': {
        'needsReview': <dynamic>[],
        'timers': [
          {
            'timerId': 'tmr-morning',
            'at': '2026-10-26T00:00:00.000Z',
            'payload': {'note': '早八点叫她起床'},
          },
        ],
      },
      '/api/sessions': {'sessions': <dynamic>[], 'contacts': <dynamic>{}, 'unreadTotal': 0},
      '/api/framework-notes': {'notes': <dynamic>[], 'count': 0, 'limit': 20},
    };

/// 24h 序列：两张磁贴那两条折线的数据源（`tokens` 走今日用量，`hit/miss` 走命中率）
List<dynamic> _hourly() => [
      {'hour': '00', 'tokens': 900, 'hit': 90, 'miss': 10},
      {'hour': '01', 'tokens': 1400, 'hit': 80, 'miss': 20},
      {'hour': '02', 'tokens': 700, 'hit': 95, 'miss': 5},
    ];

/// 一份 `/api/context/breakdown` 应答：三组、合计 168.2k、压缩线 200k（= 84.1%）。
///
/// 组的次序与 `src/web/server.ts` 的 `contextBreakdownView` 一致（系统前缀 → 工具 → 对话），
/// 三组之和必须等于 `total.tokens`（168200 = 9000 + 4000 + 155200）。
///
/// **`items[]` 故意照旧给全**：界面 2026-10-25 之后不再画组内明细，但端点还在这份响应里
/// 给它们——⑩ 就是拿"数据里有、屏幕上没有"当反向断言用的。
Map<String, dynamic> _breakdown() => {
      'at': '2026-10-24T04:34:00.000Z',
      'turn': 12,
      'step': 3,
      'total': {'tokens': 168200, 'budgetTokens': 200000, 'ratio': 0.841},
      'groups': [
        {
          'name': '系统前缀',
          'tokens': 9000,
          'ratio': 9000 / 168200,
          'items': [
            {'name': '人格常驻层', 'tokens': 7000},
            {'name': '长期记忆层', 'tokens': 2000},
          ],
        },
        {
          'name': '工具',
          'tokens': 4000,
          'ratio': 4000 / 168200,
          'items': [
            {'name': '工具清单（22 件）', 'tokens': 4000},
          ],
        },
        {
          'name': '对话',
          'tokens': 155200,
          'ratio': 155200 / 168200,
          'items': [
            {'name': '历史', 'tokens': 152000},
            {'name': '此刻层', 'tokens': 3200},
          ],
        },
      ],
      'notes': {'keepReasoning': true, 'renderVersion': '28'},
    };

_FakeApi _api({
  Map<String, dynamic>? breakdown,
  Set<String> fail = const <String>{},
  Completer<void>? gate,
  List<dynamic>? hourly,
}) =>
    _FakeApi({
      ..._base(hourly: hourly ?? const <dynamic>[]),
      '/api/context/breakdown': breakdown ?? _breakdown(),
    }, fail: fail, gate: gate);

/// 页面比视口高：不给足高度的话 ListView 不会把下面那几张卡建出来，finder 就找不到东西
///
/// 默认 1400：**宽窗**（内容宽 1348 ≥ 1000 ⇒ 三卡一行）；窄窗用例传 900（内容宽 848 ⇒ 两行）。
Future<void> _pump(WidgetTester tester, _FakeApi api, {Size size = const Size(1400, 2200)}) async {
  final state = AppState(api: api);
  addTearDown(state.dispose);
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: OverviewPage(state: state))),
  );
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

/// 一条按渲染后矩形量的宽（`context-segment-*` 上的键挂在 `ColoredBox` 上才量得到）
double _widthOf(WidgetTester tester, String key) => tester.getSize(find.byKey(ValueKey(key))).width;

Color _colorOf(WidgetTester tester, String key) => tester.widget<ColoredBox>(find.byKey(ValueKey(key))).color;

/// 图例的第 [index] 片（键挂在**片**上：`圆点 + 组名 + tokens · 占比` 那一行）
Finder _legendPiece(int index) => find.byKey(ValueKey('context-legend-$index'));

/// 三张卡与那一排的键（键都在 `_Tiles` 里）
const _tilesRowKey = ValueKey('overview-tiles-row');
const _tokensTileKey = ValueKey('overview-tile-tokens');
const _cacheTileKey = ValueKey('overview-tile-cache');
const _contextTileKey = ValueKey('overview-tile-context');

Finder get _tokensTile => find.byKey(_tokensTileKey);
Finder get _cacheTile => find.byKey(_cacheTileKey);
Finder get _contextTile => find.byKey(_contextTileKey);
Finder get _tilesRow => find.byKey(_tilesRowKey);

/// 「上下文卡里的一份零件」——横条、图例三片、悬停文案都按这个口径定位
Finder _inContext(Finder matching) => find.descendant(of: _contextTile, matching: matching);

/// 上下文卡**整卡**的悬停文案（`Tooltip.message`）。
///
/// 卡面上现在有四样（主数字 / 标签行 / 三色条 / 图例），`占预算 … 取自 … 那一拍` 这条长句
/// 只在悬停里：卡片自己是一个 `Tooltip`，所以"卡面看不见它"与"悬停看得见它"必须一起验。
///
/// 没有 tooltip 时返回 null（空态 / 加载态没有可说的那两条）。
String? _hoverOf(WidgetTester tester) {
  final tooltips = tester.widgetList<Tooltip>(
    find.descendant(of: _contextTile, matching: find.byType(Tooltip)),
  );
  if (tooltips.isEmpty) return null;
  expect(tooltips, hasLength(1), reason: '上下文卡只挂一个 Tooltip（整卡一个，不是每行一个）');
  return tooltips.single.message;
}

/// **用量卡单独渲染时的自然高度 H**：整排三张卡的高度锚（⑩）。
///
/// 为什么不另造一张用量卡来量：`_Tile` 是页面私有类，用例里命名不到。但"单独渲染时的高度"
/// 与"这棵子树在给定宽度下的固有高度"是同一个数——`getMaxIntrinsicHeight(卡宽)` 问的就是
/// "让这张卡自己决定高度，它要多高"，与父级的 stretch 无关（现在它被拉到 128、固有高度仍是
/// 它自己那份）。所以这一个数就是用户说的"用量卡单独渲染得到 H"。
double _tokensTileHeight(WidgetTester tester) {
  final box = tester.renderObject<RenderBox>(_tokensTile);
  return box.getMaxIntrinsicHeight(box.size.width);
}

/// 卡片的内边距 + 细边（`_TileShell`：16 + 1，上下各一份）——内容区的上下沿
const double _cardInset = 17;

/// 一条折线：`_SparkPainter` 那个 `CustomPaint`。
///
/// `_SparkPainter` 是页面私有类，测试里命名不到它的类型——按 painter 的 `runtimeType`
/// 认它。认错了不会静默：下面的 `findsNWidgets(2)` 立刻红。
Finder _sparkLines() => find.byWidgetPredicate(
      (w) => w is CustomPaint && w.painter != null && '${w.painter.runtimeType}' == '_SparkPainter',
      description: '折线（_SparkPainter 的 CustomPaint）',
    );

/// 图例一片里那颗圆点（片内唯一的圆形 `Container`）
Finder _legendDot(int index) => find.descendant(
      of: _legendPiece(index),
      matching: find.byWidgetPredicate(
        (w) =>
            w is Container &&
            w.decoration is BoxDecoration &&
            (w.decoration! as BoxDecoration).shape == BoxShape.circle,
        description: '圆形 Container（图例的圆点）',
      ),
    );

/// 一层层量：`inner` 必须整个落在 `outer` 里（四条边逐条比，右/下用 `<=`——
/// `Rect.contains` 的右下是开区间，差一个像素就会被判成"越界"）
void _expectInside(Rect inner, Rect outer, String what) {
  expect(inner.left, greaterThanOrEqualTo(outer.left - 0.5), reason: '$what 的左端越出了卡片：$inner vs $outer');
  expect(inner.top, greaterThanOrEqualTo(outer.top - 0.5), reason: '$what 的顶端越出了卡片：$inner vs $outer');
  expect(inner.right, lessThanOrEqualTo(outer.right + 0.5), reason: '$what 的右端越出了卡片：$inner vs $outer');
  expect(inner.bottom, lessThanOrEqualTo(outer.bottom + 0.5), reason: '$what 的底端越出了卡片：$inner vs $outer');
}

void main() {
  // ── ① 两张 0 值磁贴：确实不在了（数据给了也不画）──

  testWidgets('① 磁贴只剩两枚：「待确认」「连续失败」连数据给了都不画', (tester) async {
    await _pump(tester, _api());

    expect(find.text('今日用量'), findsOneWidget);
    expect(find.text('缓存命中率'), findsOneWidget);

    // 反向断言：标签与那两个数都不该出现。数据里 pending=7 / failStreak=4 是故意给的——
    // 删的是"画"这一层，不是数据（字段还在 `tiles` 里，别处还在用）
    expect(find.text('待确认'), findsNothing);
    expect(find.text('连续失败'), findsNothing);
    expect(find.text('7'), findsNothing, reason: '待确认那个数不画了');
    expect(find.text('4'), findsNothing, reason: '连续失败那个数不画了');
  });

  // ── ② 「定时器」整块：确实不在了（投影里给了定时器也不画）──

  testWidgets('② 定时器整块不在了：卡片、行、撤销都不出现（哪怕投影里排着一条）', (tester) async {
    await _pump(tester, _api());

    expect(find.text('定时器'), findsNothing);
    expect(find.text('撤销'), findsNothing);
    // 旧实现按 timerId 上过键（`timer-<id>` / `timer-cancel-<id>`）：两者都不该再有任何命中
    expect(find.byKey(const ValueKey('timer-tmr-morning')), findsNothing);
    expect(find.byKey(const ValueKey('timer-cancel-tmr-morning')), findsNothing);
    // 那一行的唤醒内容也不许漏出来
    expect(find.textContaining('早八点叫她起床'), findsNothing);
  });

  // ── ③ 上下文构成这张卡的四态（并进那一排之后照旧）──

  testWidgets('③-1 加载态是骨架：大数字位一条灰条 + 底部一条灰条，没有读数、没有分段条', (tester) async {
    final gate = Completer<void>();
    final api = _api(gate: gate);
    await _pump(tester, api);

    // 上块：大数字位那一条灰条（在 26 号字这个槽里）
    expect(_inContext(find.byKey(const ValueKey('context-skeleton-value'))), findsOneWidget);
    // 下块：条与图例位置上的骨架
    expect(find.byKey(const ValueKey('context-skeleton')), findsOneWidget);
    expect(_inContext(find.byKey(const ValueKey('context-skeleton'))), findsOneWidget,
        reason: '骨架得长在第三张卡里，不许飘在卡外');
    expect(find.byKey(const ValueKey('context-segment-track')), findsNothing,
        reason: '"还没读到"与"读到了"要分得开：数据没到之前不画条');
    expect(_legendPiece(0), findsNothing);
    // 三态同构：标签行一直都在（加载态也不许空成一张白卡）
    expect(_inContext(find.text('当前上下文构成')), findsOneWidget);
    // 加载不是"没有数"：`—` 只给空态与读失败
    expect(_inContext(find.text('—')), findsNothing);
    // 另两张卡不受影响（"读到没"是这一张自己的事）
    expect(find.text('今日用量'), findsOneWidget);
    expect(find.text('缓存命中率'), findsOneWidget);

    // **同一个槽**：数据到了，标签行还在同一条 y 上（主数字位的高度是三态共用的）
    final labelTop = tester.getRect(_inContext(find.text('当前上下文构成'))).top;

    api.release();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byKey(const ValueKey('context-skeleton')), findsNothing, reason: '数据到了骨架要收干净');
    expect(find.byKey(const ValueKey('context-skeleton-value')), findsNothing);
    expect(find.byKey(const ValueKey('context-segment-track')), findsOneWidget);
    expect(_inContext(find.text('84%')), findsOneWidget, reason: '数据到了主数字位换成百分比');
    expect(tester.getRect(_inContext(find.text('当前上下文构成'))).top, moreOrLessEquals(labelTop, epsilon: 0.5),
        reason: '骨架换成读数，标签行不该上下跳');
  });

  testWidgets('③-2 空态：大数字位 `—`、标签照旧、底部条画灰槽、图例那行是一句人话', (tester) async {
    await _pump(tester, _api(breakdown: {'empty': true}));

    // 主数字位是 `—`（不是 0；也不用磁贴缺值那一格的 `–`）
    expect(_inContext(find.text('—')), findsOneWidget);
    expect(_inContext(find.text('当前上下文构成')), findsOneWidget, reason: '空态标签不变');
    // 底部条画的是**灰槽**：track 在，但一段彩色都没有
    expect(_inContext(find.byKey(const ValueKey('context-segment-track'))), findsOneWidget,
        reason: '空态画灰槽（不是"没有条"）');
    for (var i = 0; i < 3; i += 1) {
      expect(find.byKey(ValueKey('context-segment-$i')), findsNothing, reason: '灰槽里不许有彩色段');
    }
    // 图例那一行是一句人话
    expect(find.text('还没有请求过 —— 她下一次开口后这里会有数'), findsOneWidget);
    expect(_inContext(find.text('还没有请求过 —— 她下一次开口后这里会有数')), findsOneWidget,
        reason: '这句空态必须在上下文卡里');
    expect(find.textContaining('tok'), findsNothing, reason: '空态不给 0 / 0 这种会撒谎的读数');
    expect(find.textContaining('读取失败'), findsNothing, reason: '空不是错，不许走失败态');
  });

  testWidgets('③-3 失败态：主数字位 `—` + 一行原因 + 重试，按了真的重读（另两张卡照常）', (tester) async {
    final fail = <String>{'/api/context/breakdown'};
    final api = _api(fail: fail);
    await _pump(tester, api);

    expect(find.textContaining('上下文构成读取失败'), findsOneWidget);
    expect(_inContext(find.textContaining('上下文构成读取失败')), findsOneWidget,
        reason: '失败文案在这张卡里，不是整页一块');
    expect(_inContext(find.text('—')), findsOneWidget, reason: '读不到时主数字位也是 `—`');
    expect(find.text('重试'), findsOneWidget, reason: '失败态要能就地重试');
    expect(_inContext(find.text('重试')), findsOneWidget);
    expect(find.byKey(const ValueKey('context-segment-track')), findsNothing,
        reason: '读不到时不画条（没有数就不给它一条假条）');
    // 一张卡读失败不拖累整页：状态卡与另外两张卡照常
    expect(find.text('外部会话'), findsOneWidget);
    expect(find.text('框架提示'), findsOneWidget);
    expect(find.text('无法获取运行数据'), findsNothing);
    expect(find.text('今日用量'), findsOneWidget);
    expect(find.text('缓存命中率'), findsOneWidget);

    // 重试 = 真的再发一次（端点回来后这张卡自己长出来）
    fail.clear();
    await tester.tap(find.text('重试'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.textContaining('上下文构成读取失败'), findsNothing);
    expect(_inContext(find.text('—')), findsNothing, reason: '有数了，`—` 收回去');
    expect(_inContext(find.text('84%')), findsOneWidget);
    expect(find.byKey(const ValueKey('context-segment-track')), findsOneWidget);
  });

  testWidgets('③-4 有数据：主数字 84% + 标签行（右总量）+ 贴底的三色条与图例；长句只在悬停里',
      (tester) async {
    await _pump(tester, _api());

    // ① 主数字：占预算百分比，在卡里、在标签行上面
    final big = _inContext(find.text('84%'));
    expect(big, findsOneWidget, reason: '主数字回到卡面：占预算 84%');
    expect(tester.getRect(big).top, lessThan(tester.getRect(_inContext(find.text('当前上下文构成'))).top),
        reason: '主数字在标签行上面');

    // ② 标签行：左标题（12 次要色）、右总量（11.5 等宽）——同一行
    expect(_inContext(find.text('当前上下文构成')), findsOneWidget);
    expect(_inContext(find.text('168.2k / 200k tok')), findsOneWidget, reason: '总量在标签行右侧');
    final title = tester.getRect(_inContext(find.text('当前上下文构成')));
    final total = tester.getRect(_inContext(find.text('168.2k / 200k tok')));
    expect(total.left, greaterThan(title.right), reason: '总量在标题的右边');
    expect(total.center.dy, moreOrLessEquals(title.center.dy, epsilon: 2), reason: '两者同一行');
    expect(tester.widget<Text>(_inContext(find.text('168.2k / 200k tok'))).style?.fontFeatures,
        contains(const FontFeature.tabularFigures()), reason: '总量是读数：等宽数字');

    // ③ 贴底那两行：8px 三色条 + 一行三片图例
    expect(_inContext(find.byKey(const ValueKey('context-segment-track'))), findsOneWidget);
    for (var i = 0; i < 3; i += 1) {
      expect(_legendPiece(i), findsOneWidget);
    }

    // ④ 反向：那两条长句一个字都不在卡面（`占预算 … / 保留历史思维链 / 取自 … 那一拍`）
    expect(find.textContaining('占预算'), findsNothing);
    expect(find.textContaining('保留历史思维链'), findsNothing);
    expect(find.textContaining('那一拍'), findsNothing);

    // 但信息一条都没丢：整卡的悬停里两半都在，逐字就是原来那两句接起来
    final hover = _hoverOf(tester);
    expect(hover, isNotNull);
    expect(hover, contains('168.2k / 200k tok'));
    expect(hover, contains('占预算 84%'));
    expect(hover, contains('保留历史思维链：开'));
    expect(hover, contains('那一拍'), reason: '要说清这是哪一拍取到的数');
    // `取自 <时刻> 那一拍`：时刻是本机时区里的写法（今天只给 HH:mm，隔天补 MM-DD），
    // 所以只钉"有一个钟点"，不钉那个钟点是不是 12:34（用例不该绑测试机的时区）。
    expect(hover, matches(RegExp(r'取自 (\d\d-\d\d )?\d\d:\d\d 那一拍')));
  });

  // ── ④ 分段彩色进度条：三段宽度按渲染后的矩形算 ──

  testWidgets('④ 分段条：三段宽度 = 各组 tokens / 压缩线，三段之和 = 占预算', (tester) async {
    await _pump(tester, _api());

    final track = _widthOf(tester, 'context-segment-track');
    expect(track, greaterThan(0), reason: '条得先真的铺开，比例才有意义');
    expect(tester.getSize(find.byKey(const ValueKey('context-segment-0'))).height, 8,
        reason: '条高 8px（用户指定）');

    final w0 = _widthOf(tester, 'context-segment-0');
    final w1 = _widthOf(tester, 'context-segment-1');
    final w2 = _widthOf(tester, 'context-segment-2');

    // 每段的宽度按"组 tokens / 压缩线 × 条宽"（分母是压缩线，不是合计）
    expect(w0 / track, closeTo(9000 / 200000, 0.002), reason: '系统前缀 9.0k / 压缩线 200k = 4.5%');
    expect(w1 / track, closeTo(4000 / 200000, 0.002), reason: '工具 4.0k / 压缩线 200k = 2.0%');
    expect(w2 / track, closeTo(155200 / 200000, 0.002), reason: '对话 155.2k / 压缩线 200k = 77.6%');

    // 三段之和 = 占预算（84.1%）：右边剩下的 15.9% 就是离压缩线还有多远
    expect((w0 + w1 + w2) / track, closeTo(0.841, 0.002), reason: '三段加起来必须正好到那条线');
    expect(1 - (w0 + w1 + w2) / track, closeTo(1 - 0.841, 0.002), reason: '剩余槽宽 = 1 − 占预算');
  });

  testWidgets('④-2 分段条：三段三个颜色，且与用户指定的三个色值一致', (tester) async {
    await _pump(tester, _api());

    expect(_colorOf(tester, 'context-segment-0'), const Color(0xFF5B8DEF), reason: '系统前缀：蓝');
    expect(_colorOf(tester, 'context-segment-1'), const Color(0xFFF2A93B), reason: '工具：橙');
    expect(_colorOf(tester, 'context-segment-2'), const Color(0xFF7C6BF0), reason: '对话：紫');
  });

  // ── ⑤ 图例：三片，与端点数据一一对上，且与分段同序同色 ──

  testWidgets('⑤ 图例三片的读数逐字来自端点：1/3 宽的卡里退到"只留占比"，组名照旧', (tester) async {
    await _pump(tester, _api());

    // 三卡等宽之后上下文卡只有 1/3 宽（内容宽 1348 时 441，片里能放字的地方约 114）。
    // 测试字体（FlutterTest）每个字约 1.02em ⇒ `组名 + tokens · 占比` 约 146 放不下，
    // 按既有规矩**整行退到只留占比**（另一档见 ⑤-5）。真机的微软雅黑中文 1em、数字约 0.55em
    // ⇒ 同一宽下约 93 ≤ 114 放得下、带着 tokens：这一档跟字体走，所以两种都钉住。
    // 占比逐字来自 `_breakdown()`：5% / 2% / 92%
    const expected = [
      (0, '系统前缀', '5%'),
      (1, '工具', '2%'),
      (2, '对话', '92%'),
    ];
    for (final (index, name, numbers) in expected) {
      final piece = _legendPiece(index);
      expect(find.descendant(of: piece, matching: find.text(name)), findsOneWidget,
          reason: '第 $index 片的组名');
      expect(find.descendant(of: piece, matching: find.text(numbers)), findsOneWidget,
          reason: '第 $index 片的占比');
      expect(find.descendant(of: piece, matching: find.textContaining('·')), findsNothing,
          reason: '第 $index 片还带着 tokens ⇒ 1/3 宽里没按既有规矩收');
    }

    // 反向：组名在整页只出现一次（图例这一处）——明细行删掉之后不许再有第二处
    for (final name in ['系统前缀', '工具', '对话']) {
      expect(find.text(name), findsOneWidget, reason: '"$name" 只剩图例这一处');
    }
  });

  testWidgets('⑤-2 图例的圆点 6px，且与横条三段同色（跟着端点次序走）', (tester) async {
    await _pump(tester, _api());

    const expected = [Color(0xFF5B8DEF), Color(0xFFF2A93B), Color(0xFF7C6BF0)];
    for (var i = 0; i < 3; i += 1) {
      final dot = _legendDot(i);
      expect(dot, findsOneWidget, reason: '第 $i 片只有一颗圆点');
      expect(tester.getSize(dot), const Size(6, 6), reason: '圆点 6px（用户指定）');
      expect((tester.widget<Container>(dot).decoration! as BoxDecoration).color, expected[i],
          reason: '第 $i 片的点与横条第 $i 段同色');
    }
  });

  testWidgets('⑤-3 三片在同一行：y 相同、x 递增、三片等宽、右端不越出卡片', (tester) async {
    await _pump(tester, _api());

    final r0 = tester.getRect(_legendPiece(0));
    final r1 = tester.getRect(_legendPiece(1));
    final r2 = tester.getRect(_legendPiece(2));
    final card = tester.getRect(_contextTile);

    // 同一行 = 三片的顶边在同一条水平线上（不是换行后的两行）
    expect(r0.top, moreOrLessEquals(r1.top, epsilon: 0.5), reason: '第 1、2 片同一行');
    expect(r1.top, moreOrLessEquals(r2.top, epsilon: 0.5), reason: '第 2、3 片同一行');
    // 从左到右
    expect(r0.left, lessThan(r1.left));
    expect(r1.left, lessThan(r2.left));
    // 等宽（`Row` + `Expanded` ×3）：宽度不随内容长短变化
    expect(r0.width, moreOrLessEquals(r1.width, epsilon: 0.5), reason: '三片等宽');
    expect(r1.width, moreOrLessEquals(r2.width, epsilon: 0.5), reason: '三片等宽');
    // 三片都整个落在卡片矩形里（左右各留一个内边距），不溢出
    for (final (i, r) in [(0, r0), (1, r1), (2, r2)]) {
      _expectInside(r, card, '第 $i 片图例');
    }
    expect(tester.takeException(), isNull, reason: '一排三片不许溢出');
  });

  testWidgets('⑤-4 1/3 宽的卡里三片图例不挤：组名不省略、占比不被裁、不溢出', (tester) async {
    await _pump(tester, _api());

    const names = ['系统前缀', '工具', '对话'];
    const shares = ['5%', '2%', '92%'];
    for (var i = 0; i < 3; i += 1) {
      final name = find.descendant(of: _legendPiece(i), matching: find.text(names[i]));
      expect(name, findsOneWidget);
      final para = tester.renderObject<RenderParagraph>(name);
      expect(para.didExceedMaxLines, isFalse,
          reason: '第 $i 片的组名「${names[i]}」被挤成了省略号 —— 三卡等宽之后这一格仍要放得下三片');
      // 读数（占比）整段都在、没有被裁，而且整个落在自己那一片里
      final numbers = find.descendant(of: _legendPiece(i), matching: find.text(shares[i]));
      expect(numbers, findsOneWidget, reason: '第 $i 片的占比是读数，不许被挤掉');
      expect(tester.renderObject<RenderParagraph>(numbers).didExceedMaxLines, isFalse,
          reason: '第 $i 片的占比被裁了');
      _expectInside(tester.getRect(numbers), tester.getRect(_legendPiece(i)), '第 $i 片的占比');
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('⑤-5 够宽的那一档：窄窗里上下文卡占满整行，读数逐字是 `tokens · 占比`', (tester) async {
    // 内容宽 848（窗口 900）折成两行 ⇒ 上下文卡占满整行，片里放得下整条读数。
    await _pump(tester, _api(), size: const Size(900, 2400));

    const expected = [
      (0, '系统前缀', '9.0k · 5%'),
      (1, '工具', '4.0k · 2%'),
      (2, '对话', '155.2k · 92%'),
    ];
    for (final (index, name, numbers) in expected) {
      final piece = _legendPiece(index);
      expect(find.descendant(of: piece, matching: find.text(name)), findsOneWidget,
          reason: '第 $index 片的组名');
      final reading = find.descendant(of: piece, matching: find.text(numbers));
      expect(reading, findsOneWidget, reason: '第 $index 片的 tokens 与占比（够宽时的这一档）');
      expect(tester.renderObject<RenderParagraph>(reading).didExceedMaxLines, isFalse,
          reason: '第 $index 片的读数被裁了 —— 数字不许裁');
    }
    expect(tester.takeException(), isNull);
  });

  // ── ⑥ 图例的占比照抄端点给的 ratio（不是界面上再算一遍）──

  testWidgets('⑥ 图例的占比走端点给的 ratio（不是界面上拿 tokens 再算）', (tester) async {
    final payload = _breakdown();
    // 端点说这三组分别是 50% / 25% / 25%（与 tokens 不成比例）⇒ 界面必须照抄
    (payload['groups'] as List)[0]['ratio'] = 0.5;
    (payload['groups'] as List)[1]['ratio'] = 0.25;
    (payload['groups'] as List)[2]['ratio'] = 0.25;
    await _pump(tester, _api(breakdown: payload));

    // 1/3 宽下读数退到只留占比：50% / 25% / 25% 必须逐字照抄端点的 ratio
    const expected = ['50%', '25%', '25%'];
    for (var i = 0; i < 3; i += 1) {
      expect(find.descendant(of: _legendPiece(i), matching: find.text(expected[i])), findsOneWidget,
          reason: '第 $i 片的占比照抄端点的 ratio，不拿 tokens 重算');
    }
  });

  // ── ⑦ 端点不认识的响应：那是"读失败"，不是"没有数" ──

  testWidgets('⑦ 端点给了个认不出的东西 ⇒ 失败态，不许冒充空态', (tester) async {
    await _pump(tester, _api(breakdown: {'ok': true}));

    expect(find.textContaining('上下文构成读取失败'), findsOneWidget);
    expect(find.textContaining('返回的数据不是上下文构成'), findsOneWidget);
    expect(find.text('还没有请求过 —— 她下一次开口后这里会有数'), findsNothing);
    expect(_inContext(find.text('—')), findsOneWidget, reason: '认不出的响应 = 读失败，主数字位是 `—`');
  });

  // ── ⑧ 等宽数字：卡面上的读数（总量、图例里的占比）都不跳 ──

  testWidgets('⑧ 标题行右上的总量、图例里的占比 都是等宽数字', (tester) async {
    await _pump(tester, _api());
    // 总量（`168.2k / 200k tok`）现在是标题行右侧那一格（见 ③-4），它也是读数
    final total = tester.widget<Text>(_inContext(find.text('168.2k / 200k tok')));
    expect(total.style?.fontFeatures, contains(const FontFeature.tabularFigures()),
        reason: '已用 / 压缩线是读数，数字要等宽（换数时不跳）');
    // 1/3 宽里图例退到只留占比（带 tokens 的那一档见 ⑤-5），两档是同一份字号与数字样式
    final numbers = tester.widget<Text>(find.descendant(
      of: _legendPiece(2),
      matching: find.text('92%'),
    ));
    expect(numbers.style?.fontFeatures, contains(const FontFeature.tabularFigures()),
        reason: '图例的占比也是读数');
    expect(_inContext(find.text('92%')), findsOneWidget);
  });

  // ── ⑨ 读失败只灰这一块（三态互不牵连）──

  testWidgets('⑨ 外部会话读失败时，上下文卡照常出数', (tester) async {
    await _pump(tester, _api(fail: {'/api/sessions'}));

    expect(find.textContaining('外部会话读取失败'), findsOneWidget);
    expect(find.byKey(const ValueKey('context-segment-track')), findsOneWidget);
    expect(find.text('当前上下文构成'), findsOneWidget);
    expect(find.byType(StateBlock), findsOneWidget, reason: '只有外部会话那张卡在三态里');
  });

  // ── ⑩ 明细三行：连展开内容一起删干净（数据里给了 items 也不画）──

  testWidgets('⑩ 三组明细行不存在：可折叠那三行、展开箭头、组内各段都不画', (tester) async {
    await _pump(tester, _api());

    // 旧实现按组名上过键（`context-group-<组名>`）：一个都不该再命中
    for (final name in ['系统前缀', '工具', '对话']) {
      expect(find.byKey(ValueKey('context-group-$name')), findsNothing,
          reason: '「$name」那行可折叠明细不该再渲染');
    }
    // 折叠箭头（旧实现的行首图标）也不该在
    expect(find.byIcon(Icons.expand_more_rounded), findsNothing);
    expect(find.byIcon(Icons.expand_less_rounded), findsNothing);

    // 组内各段：端点在 `items[]` 里照旧给，界面**不解析、不画**（要么折叠着看不见、要么根本没了）
    for (final segment in ['人格常驻层', '长期记忆层', '工具清单（22 件）', '历史', '此刻层']) {
      expect(find.text(segment), findsNothing, reason: '"$segment" 属于删掉的那层明细');
    }
    // 反向的另一半：这一块**只剩**四样——主数字 / 标签行（标题 + 总量）/ 三色条 / 一行图例
    expect(find.text('当前上下文构成'), findsOneWidget);
    expect(find.text('168.2k / 200k tok'), findsOneWidget, reason: '总量在标签行右侧');
    expect(_inContext(find.text('84%')), findsOneWidget, reason: '主数字回来了（用户："百分比加回来"）');
    expect(find.byKey(const ValueKey('context-segment-track')), findsOneWidget);
    for (var i = 0; i < 3; i += 1) {
      expect(_legendPiece(i), findsOneWidget);
    }
    // 底部那两条长句一条都没丢，全在悬停里
    expect(_hoverOf(tester), contains('占预算 84%'));
  });

  // ── ⑪ 磁贴那一排：仍然恰好两张磁贴（"多出一张只有折线的空卡"= 这里红）──

  testWidgets('⑪ 磁贴恰好两张 `_Tile`：不多出第三张（第三张是上下文卡，不是磁贴）', (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    expect(_tokensTile, findsOneWidget);
    expect(_cacheTile, findsOneWidget);
    expect(find.text('今日用量'), findsOneWidget);
    expect(find.text('缓存命中率'), findsOneWidget);

    // `_Tile` 是页面私有类，测试里命名不到那个类型：从**一张确实的磁贴**身上取 runtimeType，
    // 再让 find.byType 去数——"数出几个"与"这一排画了几张磁贴"是同一件事
    final tileType = tester.widget(_tokensTile).runtimeType;
    expect(find.byType(tileType), findsNWidgets(2),
        reason: '磁贴恰好两张（今日用量 / 缓存命中率）；第三张是 `_ContextTile`，不该被数进来');
    expect(tester.widget(_contextTile).runtimeType, isNot(tileType),
        reason: '上下文卡与磁贴是两个类型（各画各的版式，只留一份实现）');
  });

  // ── ⑫ 折线画在自己的卡里：不是独立的一张"只有折线的卡" ──

  testWidgets('⑫ 两条折线都在磁贴卡内部（祖先 = 同一张 _Tile）', (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    final tileType = tester.widget(_tokensTile).runtimeType;
    final tiles = find.byType(tileType);
    final sparks = _sparkLines();

    // 这一页只有两条折线（两张磁贴各一条）：第三条就是"独立的图卡"
    expect(sparks, findsNWidgets(2), reason: '一条折线一张卡，不该有第三条');
    // 两条折线的祖先里都有磁贴卡（合计两处 ⇒ 没有一条画在卡片外面）
    expect(find.ancestor(of: sparks, matching: tiles), findsNWidgets(2),
        reason: '折线的祖先里必须有那张卡；折线独立成卡就会少一处');

    for (final (key, label) in [(_tokensTileKey, '今日用量'), (_cacheTileKey, '缓存命中率')]) {
      final tile = find.byKey(key);
      final inThisCard = find.descendant(of: tile, matching: sparks);
      expect(inThisCard, findsOneWidget, reason: '$label 的折线画在自己的卡里');

      // 折线 → 祖先卡：**只有一张**，而且就是它自己那张（不是邻卡、也不是"卡片外面再套一层"）
      final card = find.ancestor(of: inThisCard, matching: tiles);
      expect(card, findsOneWidget, reason: '$label 的折线只属于一张卡');
      expect(tester.widget(card).key, key, reason: '$label 的折线属于它自己那张卡');
    }
  });

  // ── ⑬ 折线不许画出卡片：按**渲染矩形**断言，外加卡片自己裁形 ──

  testWidgets('⑬ 折线矩形完全落在卡片矩形内，且卡片容器自己 Clip.antiAlias', (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    final tileType = tester.widget(_tokensTile).runtimeType;
    final tiles = find.byType(tileType);
    final sparks = _sparkLines();
    expect(sparks, findsNWidgets(2));

    for (var i = 0; i < sparks.evaluate().length; i += 1) {
      final spark = sparks.at(i);
      final card = find.ancestor(of: spark, matching: tiles);
      final sparkRect = tester.getRect(spark);
      final cardRect = tester.getRect(card);

      // 四条边逐条比（`Rect.contains` 的右/下是开区间，用坐标比较更直白）
      expect(sparkRect.left, greaterThanOrEqualTo(cardRect.left),
          reason: '第 $i 条折线的左端越出了卡片：$sparkRect vs $cardRect');
      expect(sparkRect.top, greaterThanOrEqualTo(cardRect.top),
          reason: '第 $i 条折线的顶端越出了卡片：$sparkRect vs $cardRect');
      expect(sparkRect.right, lessThanOrEqualTo(cardRect.right),
          reason: '第 $i 条折线的右端越出了卡片：$sparkRect vs $cardRect');
      expect(sparkRect.bottom, lessThanOrEqualTo(cardRect.bottom),
          reason: '第 $i 条折线的底端越出了卡片：$sparkRect vs $cardRect');

      // 硬约束：即便以后它真的越界，也**画不出卡片**——卡片容器自己按形状裁
      final clipping = tester
          .widgetList<Container>(find.descendant(of: card, matching: find.byType(Container)))
          .where((c) => c.clipBehavior == Clip.antiAlias)
          .toList();
      expect(clipping, hasLength(1),
          reason: '第 $i 张磁贴的容器缺 Clip.antiAlias：折线一旦越界就会画到圆角外面');
    }
  });

  // ════════════════ ⑦⑧⑨ 三卡一行（2026-10-25 深夜那次） ════════════════

  testWidgets('⑭ 宽窗：三张卡一行 —— 三卡等宽（±2）、top 相同、高度都 = 用量卡自然高度、不溢出',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    final row = tester.getRect(_tilesRow);
    final tokens = tester.getRect(_tokensTile);
    final cache = tester.getRect(_cacheTile);
    final context = tester.getRect(_contextTile);

    // 同一排：三张卡的顶边在同一条水平线上
    expect(tokens.top, moreOrLessEquals(cache.top, epsilon: 0.5), reason: '今日用量与命中率同一排');
    expect(cache.top, moreOrLessEquals(context.top, epsilon: 0.5),
        reason: '上下文卡必须在同一排 —— 它曾经单独占一整行，这里红了就是又分家了');

    // 从左到右
    expect(tokens.left, lessThan(cache.left));
    expect(cache.left, lessThan(context.left));

    // 宽度 1 : 1 : 1（±2px）——用户 2026-10-25 深夜定的关系：
    //   > 「算了。改成三个卡片等宽吧」
    expect(cache.width, moreOrLessEquals(tokens.width, epsilon: 2), reason: '前两张卡等宽（1 : 1）');
    expect(context.width, moreOrLessEquals(tokens.width, epsilon: 2),
        reason: '上下文卡与磁贴等宽（1 : 1 : 1）—— 从 2/4 收到 1/3');
    // 等宽不是"看起来差不多"：一张卡 = (内容宽 − 两条缝) / 3
    expect(tokens.width, moreOrLessEquals((row.width - 24) / 3, epsilon: 1),
        reason: '一张卡 = (内容宽 − 两条缝) / 3（实测 ${tokens.width}，内容宽 ${row.width}）');

    // **高度锚在用量卡的自然高度上**（⑩）：三张卡的高都等于 H，而 H 是**单独渲染一张用量卡**
    // 得到的高度（不是"三张里最高的那张"——上一版就是这么被上下文卡撑到 189 的）。
    final h = _tokensTileHeight(tester);
    expect(tokens.height, moreOrLessEquals(h, epsilon: 1), reason: '用量卡自己就是 H');
    expect(cache.height, moreOrLessEquals(h, epsilon: 1), reason: '命中率卡也是 H');
    expect(context.height, moreOrLessEquals(h, epsilon: 1),
        reason: '上下文卡**必须**压进 H —— 它一高，整排就跟着高（用户：变太高了）');
    // 前两张卡的内容本来就没那么高，H 也不该反过来被它们撑大：
    // 三张卡的高度全部贴着 H，而 H 明显小于上一版的 189
    expect(h, lessThan(189), reason: 'H 就是用量卡自然高度；回到 189 就是又被内容最多的那张带跑了');

    // 这一排铺满内容宽（左右端贴齐），缝都是 12
    expect(tokens.left, moreOrLessEquals(row.left, epsilon: 0.5));
    expect(context.right, moreOrLessEquals(row.right, epsilon: 0.5));
    expect(cache.left - tokens.right, moreOrLessEquals(12, epsilon: 0.5), reason: '卡与卡的缝 12');
    expect(context.left - cache.right, moreOrLessEquals(12, epsilon: 0.5), reason: '卡与卡的缝 12');

    // 上下文卡里的三样零件都整个落在卡矩形里（⑪ 之后卡面只剩它们）
    _expectInside(tester.getRect(find.byKey(const ValueKey('context-segment-track'))), context, '三色横条');
    for (var i = 0; i < 3; i += 1) {
      _expectInside(tester.getRect(_legendPiece(i)), context, '第 $i 片图例');
    }

    expect(tester.takeException(), isNull, reason: '三卡一行不许溢出（黄黑条）');
  });

  testWidgets('⑮ 窄窗 900：折成两行——第一行两张磁贴、第二行上下文卡占满整行（高度仍等于用量卡）',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()), size: const Size(900, 2400));

    final tokens = tester.getRect(_tokensTile);
    final cache = tester.getRect(_cacheTile);
    final context = tester.getRect(_contextTile);
    final row = tester.getRect(_tilesRow);

    // 三张卡只有两种 top：前两张同一行、上下文卡另起一行
    final tops = {tokens.top, cache.top, context.top};
    expect(tops.length, 2, reason: '窄窗必须是两行（三张卡只有两种 top），实际 $tops');
    expect(tokens.top, moreOrLessEquals(cache.top, epsilon: 0.5), reason: '第一行两张磁贴');
    expect(context.top, greaterThan(cache.bottom), reason: '上下文卡在第二行（顶边在第一行底边之下）');

    // 第一行两张磁贴等宽、等高、铺满内容宽
    expect(cache.width, moreOrLessEquals(tokens.width, epsilon: 2), reason: '第一行两张等宽');
    expect(cache.height, moreOrLessEquals(tokens.height, epsilon: 0.5), reason: '第一行两张等高');
    expect(tokens.left, moreOrLessEquals(row.left, epsilon: 0.5));
    expect(cache.right, moreOrLessEquals(row.right, epsilon: 0.5));
    expect(cache.left - tokens.right, moreOrLessEquals(12, epsilon: 0.5));

    // **窄窗里上下文卡的高度仍等于用量卡**（⑬）：折行只改宽度，不改"这一组的高度锚"。
    // 用量卡在窄窗里更宽（418 而不是 331），H 按同一条宽重新算一遍——两张磁贴与它共用。
    final h = _tokensTileHeight(tester);
    expect(tokens.height, moreOrLessEquals(h, epsilon: 1));
    expect(context.height, moreOrLessEquals(tokens.height, epsilon: 1),
        reason: '窄窗折成两行时，上下文卡的高度**仍等于**用量卡高度');

    // 上下文卡占满整行：宽 = 两张磁贴 + 中间那条缝（≈ 内容宽），左右端贴齐
    expect(context.width, moreOrLessEquals(tokens.width + 12 + cache.width, epsilon: 1),
        reason: '上下文卡在窄窗里要占满整行');
    expect(context.left, moreOrLessEquals(tokens.left, epsilon: 0.5));
    expect(context.right, moreOrLessEquals(cache.right, epsilon: 0.5));

    // 卡里的零件仍在一行里、仍在卡内（窄窗只改排法，不丢内容）
    final r0 = tester.getRect(_legendPiece(0));
    final r2 = tester.getRect(_legendPiece(2));
    expect(r0.top, moreOrLessEquals(r2.top, epsilon: 0.5), reason: '窄窗里图例仍是三片一行');
    _expectInside(r0, context, '第 0 片图例');
    _expectInside(tester.getRect(find.byKey(const ValueKey('context-segment-track'))), context, '三色横条');

    expect(tester.takeException(), isNull, reason: '窄窗不许溢出（黄黑条）');
  });

  testWidgets('⑯ 反向：上下文构成只出现在那一排里，页面上没有单独整行的上下文块', (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    // 那一排只有一处；上下文卡是它的后代（宽窗三卡一行）
    expect(_tilesRow, findsOneWidget);
    expect(find.descendant(of: _tilesRow, matching: _contextTile), findsOneWidget,
        reason: '上下文卡长在这一排里；另起一整行 = 这次改版白做');
    // 三卡等宽 ⇒ 它恰好是这一排的三分之一，不是"整行那一块"，也不再是两格（1:1:2 里的 2/4）
    final rowWidth = tester.getSize(_tilesRow).width;
    expect(tester.getSize(_contextTile).width, moreOrLessEquals((rowWidth - 24) / 3, epsilon: 2),
        reason: '上下文卡占这一排的三分之一（三卡等宽），不再是一整行、也不再是两格');

    // 标题只出现一次：下面没有第二份"当前上下文构成"看板
    expect(find.text('当前上下文构成'), findsOneWidget,
        reason: '整页只有卡内那一处标签行；多一处就是旧的那块全宽看板又挂回来了');

    // 只留一份实现：这张卡的运行时类型全页只有一个
    final contextType = tester.widget(_contextTile).runtimeType;
    expect(find.byType(contextType), findsOneWidget);

    // 横条 / 三片图例 都在卡内，且都在那一排里（没有第二份画在别处）
    for (final finder in [
      find.byKey(const ValueKey('context-segment-track')),
      _legendPiece(0),
      _legendPiece(1),
      _legendPiece(2),
    ]) {
      expect(find.descendant(of: _contextTile, matching: finder), findsOneWidget);
      expect(find.descendant(of: _tilesRow, matching: finder), findsOneWidget,
          reason: '这些零件都只出现在那一排的上下文卡里');
    }
    // 总量那一格还在（它没被去掉，只是挪到了标题行右侧）；底部副行只在悬停里
    expect(_hoverOf(tester), contains('占预算'));
    expect(find.textContaining('占预算'), findsNothing);
  });

  testWidgets('⑰ 端点空数据：上下文卡是空态，另两张卡照常出数、照常有折线', (tester) async {
    await _pump(tester, _api(breakdown: {'empty': true}, hourly: _hourly()));

    // 上下文卡：主数字位 `—`、底部画灰槽、图例那行一句人话、不给 tok 读数
    expect(_inContext(find.text('还没有请求过 —— 她下一次开口后这里会有数')), findsOneWidget);
    expect(_inContext(find.text('—')), findsOneWidget, reason: '空态主数字位是 `—`');
    expect(_inContext(find.byKey(const ValueKey('context-segment-track'))), findsOneWidget,
        reason: '空态底部画灰槽');
    expect(find.byKey(const ValueKey('context-segment-0')), findsNothing, reason: '灰槽里没有彩色段');
    expect(find.textContaining('tok'), findsNothing);

    // 另两张卡照常：读数、标签、两条折线、口径词一个不少
    expect(find.text('今日用量'), findsOneWidget);
    expect(find.text('1.2k'), findsOneWidget);
    expect(find.text('缓存命中率'), findsOneWidget);
    expect(find.text('90%'), findsOneWidget);
    expect(find.text('非缓存口径'), findsOneWidget);
    expect(_sparkLines(), findsNWidgets(2));

    // 版式照旧：三张卡还是一排、等高
    final tokens = tester.getRect(_tokensTile);
    final context = tester.getRect(_contextTile);
    expect(context.top, moreOrLessEquals(tokens.top, epsilon: 0.5), reason: '空态也还是同一排');
    expect(context.height, moreOrLessEquals(tokens.height, epsilon: 0.5), reason: '空态也还是等高');
    expect(tester.takeException(), isNull);
  });

  // ═════════ ⑩-⑬ 高度锚在用量卡上（2026-10-25 深夜第四次，用户："变太高了"） ═════════

  testWidgets('⑱ 高度锚定：单独渲染一张用量卡得到 H；三卡那一排的三张高度都 = H（±1）', (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    // ① 单独渲染一张用量卡 = 它的固有高度（同一棵树、同一条宽；stretch 不改固有高度）
    final h = _tokensTileHeight(tester);
    // 实测（测试机字体 FlutterTest，三卡等宽后的一格宽 441）：内边距+细边 34 + 主数字 41 +
    // 缝 2 + 标签行 19 + 缝 8 + 折线 24 = **128**（与 1:1:2 时代的 331 宽同数：那两行小字
    // 在两个宽度下都只有一行）。把这个数写死一条，是给"某天字体/字号变了、高度悄悄跑掉"
    // 留一颗钉子（真要改就给新数，并说明为什么）。
    expect(h, moreOrLessEquals(128, epsilon: 1), reason: '用量卡自然高度 H 的实测值');

    // ② 三卡那一排 ⇒ 三张高度都等于 H
    for (final (finder, name) in [
      (_tokensTile, '今日用量'),
      (_cacheTile, '缓存命中率'),
      (_contextTile, '当前上下文构成'),
    ]) {
      final size = tester.getSize(finder);
      expect(size.height, moreOrLessEquals(h, epsilon: 1), reason: '$name 的高度必须等于 H');
    }
  });

  testWidgets('⑲ 无 24h 数据时 H 不变：整排不跟着数据"呼吸"（折线那 24 无条件算进 H）', (tester) async {
    // 没有 hourly ⇒ 两张磁贴都不画折线。若 H 跟着数据变，这一排会在数据到达时跳一下
    // （上下文卡也会被压扁/撑高）。锚定口径：H 里那 24 一直在，宁可卡下面空一格。
    await _pump(tester, _api(hourly: const <dynamic>[]));
    expect(_sparkLines(), findsNothing, reason: '这一态本来就没有折线');
    final h = _tokensTileHeight(tester);
    expect(h, moreOrLessEquals(128, epsilon: 1), reason: 'H 与有折线时是同一个数');
    expect(tester.getSize(_tokensTile).height, moreOrLessEquals(h, epsilon: 1));
    expect(tester.getSize(_cacheTile).height, moreOrLessEquals(h, epsilon: 1));
    expect(tester.getSize(_contextTile).height, moreOrLessEquals(h, epsilon: 1));
    // 上下文卡照常装得下三色条 + 图例（⑫：不许因为 H 变小把读数挤掉）
    expect(find.byKey(const ValueKey('context-segment-track')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('⑳ 卡面三色条仍在卡里、8px、与卡同宽；图例三片一行不挤（didExceedMaxLines 全 false）',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()));
    final card = tester.getRect(_contextTile);
    final track = tester.getRect(find.byKey(const ValueKey('context-segment-track')));

    // 条：8px 高、在卡内、左右各留一个内边距（16 + 1）
    expect(track.height, 8, reason: '三色横条 8px（用户指定）');
    _expectInside(track, card, '三色横条');
    expect(track.left - card.left, moreOrLessEquals(_cardInset, epsilon: 0.5), reason: '条与卡同宽（内边距之内）');
    expect(card.right - track.right, moreOrLessEquals(_cardInset, epsilon: 0.5));

    // 图例三片：一行、等宽、各自不换行、读数不被裁
    final r0 = tester.getRect(_legendPiece(0));
    final r1 = tester.getRect(_legendPiece(1));
    final r2 = tester.getRect(_legendPiece(2));
    expect(r0.top, moreOrLessEquals(r1.top, epsilon: 0.5));
    expect(r1.top, moreOrLessEquals(r2.top, epsilon: 0.5));
    expect(r1.width, moreOrLessEquals(r0.width, epsilon: 0.5), reason: '三片等宽');

    const names = ['系统前缀', '工具', '对话'];
    // 1/3 宽下是"只留占比"那一档（带 tokens 的一档见 ⑤-5）
    const numbers = ['5%', '2%', '92%'];
    for (var i = 0; i < 3; i += 1) {
      final name = tester.renderObject<RenderParagraph>(
        find.descendant(of: _legendPiece(i), matching: find.text(names[i])),
      );
      expect(name.didExceedMaxLines, isFalse, reason: '第 $i 片的组名被挤成省略号了');
      final nums = tester.renderObject<RenderParagraph>(
        find.descendant(of: _legendPiece(i), matching: find.text(numbers[i])),
      );
      expect(nums.didExceedMaxLines, isFalse, reason: '第 $i 片的占比被裁了 —— 数字不许裁');
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('㉑ 三态（加载 / 空 / 读失败）落在同一个 H 里：上块贴顶、最后一行贴底、标签行不跳',
      (tester) async {
    // 三个态各起一次页面：每一态都验"三张卡等高、上块贴顶、最后一行贴底（内边距 17）、不溢出"。
    // 贴底不是审美：卡高是钉死的，内容少的时候顶部对齐就会在下面留一片空（上一版就是居中）。
    double? labelTop;
    for (final (label, api) in [
      ('加载态', _api(gate: Completer<void>())),
      ('空态', _api(breakdown: {'empty': true})),
      ('读失败', _api(fail: {'/api/context/breakdown'})),
    ]) {
      // 先把上一态的树整棵拆掉：`OverviewPage` 复用同一个 `State`，直接换 api 它接不上
      // （`initState` 只跑一次，页面会卡在上一态里）。
      await tester.pumpWidget(const SizedBox.shrink());
      await _pump(tester, api);
      final h = _tokensTileHeight(tester);
      final card = tester.getRect(_contextTile);
      expect(card.height, moreOrLessEquals(h, epsilon: 1), reason: '$label：上下文卡也得压进 H');
      expect(tester.getSize(_tokensTile).height, moreOrLessEquals(h, epsilon: 1), reason: label);

      // 上块：标签行的顶 = 内容顶 + 主数字位（26 号字那一行）+ 缝 2 ⇒ 三态同一条线
      final labelRect = tester.getRect(_inContext(find.text('当前上下文构成')));
      labelTop ??= labelRect.top;
      expect(labelRect.top, moreOrLessEquals(labelTop, epsilon: 0.5),
          reason: '$label：标签行要在同一条 y 上（主数字位是三态共用的槽）');

      // 下块：最后一行贴着卡的内容底沿
      final part = label == '加载态'
          ? find.byKey(const ValueKey('context-skeleton'))
          : label == '空态'
              ? find.text('还没有请求过 —— 她下一次开口后这里会有数')
              : find.textContaining('上下文构成读取失败');
      expect(_inContext(part), findsOneWidget, reason: '$label：那块提示在卡里');
      final r = tester.getRect(part);
      expect(card.bottom - r.bottom, moreOrLessEquals(_cardInset, epsilon: 1),
          reason: '$label：最后一行要贴底（距卡底 $_cardInset，实测 ${card.bottom - r.bottom}）');
      // 提示在标签行下面（不是同一条线上）
      expect(r.top, greaterThan(labelRect.bottom), reason: '$label：提示在标签行之下');
      expect(tester.takeException(), isNull, reason: '$label 不许溢出');
    }
  });

  testWidgets('㉒ 读失败：主数字位 `—`、一行原因 + 就地重试；原因与影响在悬停里', (tester) async {
    await _pump(tester, _api(fail: {'/api/context/breakdown'}));

    // 卡面：`—` + 一行原因 + 重试按钮（原因原来占两行、影响另占两行）
    expect(_inContext(find.text('—')), findsOneWidget, reason: '读不到时主数字位是 `—`');
    expect(_inContext(find.textContaining('上下文构成读取失败')), findsOneWidget);
    expect(_inContext(find.text('重试')), findsOneWidget);
    expect(find.textContaining('状态与用量不受影响'), findsNothing, reason: '影响说明搬进悬停');
    expect(find.byKey(const ValueKey('context-segment-track')), findsNothing, reason: '不画假条');

    final hover = _hoverOf(tester);
    expect(hover, isNotNull);
    expect(hover, contains('上下文构成读取失败'));
    expect(hover, contains('状态与用量不受影响'), reason: '影响与下一步那句话一个字都没丢');
    expect(tester.takeException(), isNull);
  });

  testWidgets('㉓ 最窄的一档：图例砍 tokens 只留占比、总量整条不画；主数字与组名都不裁', (tester) async {
    // 内容宽 1000（窗口 1052）是"三卡一行"的下沿：三卡等宽 ⇒ 这时上下文卡只有 325 宽，
    // 每片图例分到 92（片里能放字的地方 76）——带 tokens 的读数（测试字体下 `155.2k · 92%`
    // 一百三十多像素）放不下；标签行里"标题 + 总量"（测试字体下 85.8 + 12 + 199.8）也差
    // 几个像素，于是总量整条让路。**这是测试字体口径**：真机雅黑下总量约 96 + 12 + 112 = 220
    // ≤ 291，是放得下的——"整条让路"是量出来的兜底，不是一种固定版式。
    await _pump(tester, _api(hourly: _hourly()), size: const Size(1052, 2200));

    // 三卡仍是一行（下沿之上）
    final tokens = tester.getRect(_tokensTile);
    final context = tester.getRect(_contextTile);
    expect(context.top, moreOrLessEquals(tokens.top, epsilon: 0.5), reason: '1052 仍在宽窗一侧');
    expect(context.height, moreOrLessEquals(_tokensTileHeight(tester), epsilon: 1), reason: '高度仍锚在 H 上');
    expect(context.width, moreOrLessEquals(tokens.width, epsilon: 2), reason: '下沿上仍是三卡等宽');

    // 读数**收成只留占比**：`5%` / `2%` / `92%` 在，tokens 那半截退场
    for (var i = 0; i < 3; i += 1) {
      final piece = _legendPiece(i);
      expect(find.descendant(of: piece, matching: find.textContaining('·')), findsNothing,
          reason: '第 $i 片还带着 tokens ⇒ 说明放不下时没有退到"只留占比"');
    }
    for (final share in ['5%', '2%', '92%']) {
      expect(find.text(share), findsOneWidget, reason: '占比是读数，窄了也得在');
    }
    // 组名三片都还完整（砍的是 tokens，不是组名）
    for (final name in ['系统前缀', '工具', '对话']) {
      final para = tester.renderObject<RenderParagraph>(_inContext(find.text(name)));
      expect(para.didExceedMaxLines, isFalse, reason: '「$name」不该被挤成省略号');
    }

    // 标签行：总量**整条不画**（不是画一个带省略号的半截数），标题照旧、主数字完整
    expect(find.text('168.2k / 200k tok'), findsNothing,
        reason: '一格的宽放不下整条总量 ⇒ 按既有规矩整条让路，只留标签');
    expect(_inContext(find.text('当前上下文构成')), findsOneWidget, reason: '总量让路时标签必须还在');
    expect(tester.renderObject<RenderParagraph>(_inContext(find.text('当前上下文构成'))).didExceedMaxLines,
        isFalse, reason: '标签本身放得下，不该被省略');
    expect(tester.renderObject<RenderParagraph>(_inContext(find.text('84%'))).didExceedMaxLines, isFalse,
        reason: '主数字不许裁');
    // 总量虽然不画了，信息没丢：整卡悬停里还在
    expect(_hoverOf(tester), contains('168.2k / 200k tok'));
    expect(tester.takeException(), isNull, reason: '最窄的那一档不许溢出（黄黑条）');
  });

  // ═════ ㉔-㉗ 与另两张同构（2026-10-25 深夜第五次，用户："进度条和图例要在底部"） ═════

  testWidgets('㉔ 三卡主数字同一档：26 / w600 / 等宽、顶边同一条线（±1），上下文卡是整数百分比',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    final finds = <String, Finder>{
      '今日用量': find.descendant(of: _tokensTile, matching: find.text('1.2k')),
      '缓存命中率': find.descendant(of: _cacheTile, matching: find.text('90%')),
      '当前上下文构成': find.descendant(of: _contextTile, matching: find.text('84%')),
    };
    final rects = <String, Rect>{};
    for (final entry in finds.entries) {
      expect(entry.value, findsOneWidget, reason: '${entry.key} 的主数字');
      rects[entry.key] = tester.getRect(entry.value);
      final style = tester.widget<Text>(entry.value).style;
      expect(style?.fontSize, 26, reason: '${entry.key} 主数字字号与另两张同一档');
      expect(style?.fontWeight, FontWeight.w600, reason: '${entry.key} 主数字字重与另两张同一档');
      expect(style?.fontFeatures, contains(const FontFeature.tabularFigures()),
          reason: '${entry.key} 主数字是等宽数字');
    }

    // 三张卡同一排、同一圈内边距 ⇒ 主数字的顶边（也就是基线）在同一条线上
    final tops = rects.values.map((r) => r.top).toList();
    for (final top in tops) {
      expect(top, moreOrLessEquals(tops.first, epsilon: 1),
          reason: '三卡主数字基线要一致：$rects');
    }

    // 主数字格式：整数百分比（`^\d+%$`）
    final big = tester.widget<Text>(finds['当前上下文构成']!).data!;
    expect(big, '84%');
    expect(RegExp(r'^\d+%$').hasMatch(big), isTrue, reason: '主数字必须是整数百分比，实际「$big」');
  });

  testWidgets('㉔-2 百分比四舍五入取整：ratio 0.5674 ⇒ `57%`（不截断成 56），悬停里也是 57%',
      (tester) async {
    final payload = _breakdown();
    (payload['total'] as Map)['ratio'] = 0.5674;
    await _pump(tester, _api(breakdown: payload));

    expect(_inContext(find.text('57%')), findsOneWidget);
    expect(find.text('56%'), findsNothing, reason: '截断就会变成 56 —— 用户要的是四舍五入');
    expect(_hoverOf(tester), contains('占预算 57%'));
  });

  testWidgets('㉕ 构图：主数字 → 标签行 → 横条 → 图例；图例贴底（17）、横条在其上 6，条高 8',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    final card = tester.getRect(_contextTile);
    final big = tester.getRect(_inContext(find.text('84%')));
    final label = tester.getRect(_inContext(find.text('当前上下文构成')));
    final track = tester.getRect(find.byKey(const ValueKey('context-segment-track')));
    final legend = tester.getRect(_legendPiece(2));

    // 上下次序：主数字 → 标签行 → 横条 → 图例
    expect(big.top, lessThan(label.top), reason: '主数字在标签行上面');
    expect(track.top, greaterThan(label.bottom), reason: '横条确实在标签行下方');
    expect(legend.top, greaterThan(track.bottom), reason: '图例在横条下方（贴底最后一行）');

    // 主数字贴顶：内容顶沿 = 内边距 16 + 细边 1
    expect(big.top - card.top, moreOrLessEquals(_cardInset, epsilon: 1), reason: '主数字贴顶');

    // 贴底：图例那一行距卡底 = 内边距 17（16 + 细边 1）。
    // 用户 ④ 那两条"横条底边距卡底 ≈16"与"图例底边距卡底 ≈16"不可能同时成立（图例在横条
    // 下面）：贴底的是图例，横条紧在它上面 6 —— 这里验的就是这两条。
    expect(card.bottom - legend.bottom, moreOrLessEquals(_cardInset, epsilon: 1),
        reason: '图例贴底（距卡底 ${card.bottom - legend.bottom}）');
    expect(legend.top - track.bottom, moreOrLessEquals(6, epsilon: 1),
        reason: '横条与图例之间的缝 6（实测 ${legend.top - track.bottom}）');
    expect(track.height, 8, reason: '横条 8px');

    // 三卡高度仍 = H（构图改了，高度锚没动）
    final h = _tokensTileHeight(tester);
    expect(card.height, moreOrLessEquals(h, epsilon: 1), reason: '上下文卡仍是 H');
    expect(tester.getSize(_tokensTile).height, moreOrLessEquals(h, epsilon: 1));
    expect(tester.getSize(_cacheTile).height, moreOrLessEquals(h, epsilon: 1));

    // 四样零件都整个落在卡里（不越界、不溢出）
    for (final (r, what) in [(big, '主数字'), (label, '标签行'), (track, '横条'), (legend, '图例')]) {
      _expectInside(r, card, what);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('㉖ 三态同构：加载（大数字位灰条 + 底部灰条）/ 空（`—` + 灰槽 + 人话）/ 错（`—` + 原因 + 重试）',
      (tester) async {
    // ① 加载：大数字位一条灰条、下块是骨架；标签照旧
    final gate = Completer<void>();
    final loadingApi = _api(gate: gate);
    await _pump(tester, loadingApi);
    final loadingCard = tester.getRect(_contextTile);
    final skeletonValue = tester.getRect(_inContext(find.byKey(const ValueKey('context-skeleton-value'))));
    final skeleton = tester.getRect(find.byKey(const ValueKey('context-skeleton')));
    expect(skeletonValue.center.dy, lessThan(skeleton.top), reason: '大数字位的灰条在上块、骨架在下块');
    expect(_inContext(find.text('当前上下文构成')), findsOneWidget, reason: '加载态标签也在（不是一张白卡）');
    expect(skeleton.bottom, moreOrLessEquals(loadingCard.bottom - _cardInset, epsilon: 1),
        reason: '底部那条灰条贴底');
    expect(_inContext(find.text('—')), findsNothing, reason: '加载不是"没有数"');
    expect(tester.takeException(), isNull);

    // ② 空：`—` + 灰槽 + 一句人话
    await tester.pumpWidget(const SizedBox.shrink());
    await _pump(tester, _api(breakdown: {'empty': true}));
    final emptyCard = tester.getRect(_contextTile);
    expect(_inContext(find.text('—')), findsOneWidget);
    final emptyTrack = find.byKey(const ValueKey('context-segment-track'));
    expect(_inContext(emptyTrack), findsOneWidget);
    expect(find.byKey(const ValueKey('context-segment-0')), findsNothing);
    expect(tester.getRect(emptyTrack).height, 8, reason: '灰槽与真条同高');
    final emptyHint = tester.getRect(_inContext(find.text('还没有请求过 —— 她下一次开口后这里会有数')));
    expect(tester.getRect(emptyTrack).top, lessThan(emptyHint.top), reason: '灰槽在那一句上方');
    expect(emptyCard.bottom - emptyHint.bottom, moreOrLessEquals(_cardInset, epsilon: 1),
        reason: '那一句就是图例那一行：贴底');
    expect(tester.takeException(), isNull);

    // ③ 错：`—` + 一行原因 + 就地重试；这一态不画条（没有数就没有假条）
    await tester.pumpWidget(const SizedBox.shrink());
    await _pump(tester, _api(fail: {'/api/context/breakdown'}));
    final errorCard = tester.getRect(_contextTile);
    expect(_inContext(find.text('—')), findsOneWidget);
    expect(find.byKey(const ValueKey('context-segment-track')), findsNothing, reason: '读不到不画条');
    expect(_inContext(find.textContaining('上下文构成读取失败')), findsOneWidget);
    final retryButton = tester.getRect(_inContext(find.byType(TextButton)));
    expect(errorCard.bottom - retryButton.bottom, moreOrLessEquals(_cardInset, epsilon: 1),
        reason: '原因 + 重试那一行贴底（距卡底 ${errorCard.bottom - retryButton.bottom}）');
    expect(tester.takeException(), isNull);
  });

  testWidgets('㉗ 反向：卡面不出现"占预算 … 取自 …"长句；整卡悬停里两半都在（一条信息都没丢）',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    // 卡面：一句都不是
    expect(find.textContaining('占预算'), findsNothing);
    expect(find.textContaining('保留历史思维链'), findsNothing);
    expect(find.textContaining('那一拍'), findsNothing);
    expect(find.textContaining('取自'), findsNothing);

    // 悬停：逐字都在（`已用 / 压缩线` + `占预算` + `思维链` + `那一拍`）
    final hover = _hoverOf(tester);
    expect(hover, isNotNull);
    expect(hover, contains('168.2k / 200k tok · 占预算 84%'));
    expect(hover, matches(RegExp(r'保留历史思维链：开 · 取自 (\d\d-\d\d )?\d\d:\d\d 那一拍')));
  });

  // ═════ ㉘ 三卡等宽（2026-10-25 深夜第六次，用户："算了。改成三个卡片等宽吧"） ═════

  testWidgets('㉘ 三卡等宽：各 = (内容宽 − 两条缝)/3、同 top、高仍是 H；1/3 宽里主数字完整、总量整条在',
      (tester) async {
    await _pump(tester, _api(hourly: _hourly()));

    final row = tester.getRect(_tilesRow);
    final tokens = tester.getRect(_tokensTile);
    final cache = tester.getRect(_cacheTile);
    final context = tester.getRect(_contextTile);
    // 内容宽 1348（窗口 1400 扣左右各 26）⇒ 一格 = (1348 − 24)/3 = 441.3
    final expected = (row.width - 24) / 3;

    // ① 三张一样宽（±2），而且就是那条除法算出来的数（"看起来差不多"不算）
    for (final (r, name) in [
      (tokens, '今日用量'),
      (cache, '缓存命中率'),
      (context, '当前上下文构成'),
    ]) {
      expect(r.width, moreOrLessEquals(tokens.width, epsilon: 2), reason: '$name 与用量卡等宽');
      expect(r.width, moreOrLessEquals(expected, epsilon: 2),
          reason: '$name 的宽应是 (内容宽 − 两条缝)/3 = ${expected.toStringAsFixed(1)}，实测 ${r.width}');
    }

    // ② 同一排（三条顶边同一条线），高仍 = H（用量卡自然高度），三卡一致
    expect(cache.top, moreOrLessEquals(tokens.top, epsilon: 0.5), reason: '三卡同一排');
    expect(context.top, moreOrLessEquals(tokens.top, epsilon: 0.5), reason: '三卡同一排');
    final h = _tokensTileHeight(tester);
    expect(h, moreOrLessEquals(128, epsilon: 1), reason: '三卡等宽之后 H 还是用量卡那 128');
    for (final (r, name) in [
      (tokens, '今日用量'),
      (cache, '缓存命中率'),
      (context, '当前上下文构成'),
    ]) {
      expect(r.height, moreOrLessEquals(h, epsilon: 1), reason: '$name 的高度必须等于 H');
    }

    // ③ 1/3 宽（一格 441，片里能放字的地方约 114）下的收敛：
    //    图例整行退到只留占比（tokens 那半截退场），组名与占比都不裁
    for (final name in ['系统前缀', '工具', '对话']) {
      expect(tester.renderObject<RenderParagraph>(_inContext(find.text(name))).didExceedMaxLines, isFalse,
          reason: '「$name」在 1/3 宽里被挤成省略号了');
    }
    for (var i = 0; i < 3; i += 1) {
      expect(find.descendant(of: _legendPiece(i), matching: find.textContaining('·')), findsNothing,
          reason: '1/3 宽里第 $i 片还带着 tokens ⇒ 没按既有规矩退到只留占比');
    }

    // ④ 主数字完整（不许裁）、总量整条在（放得下 ⇒ 不是省略号）、标签也不必省略
    expect(tester.renderObject<RenderParagraph>(_inContext(find.text('84%'))).didExceedMaxLines, isFalse,
        reason: '主数字（百分比）永远不裁');
    final total = _inContext(find.text('168.2k / 200k tok'));
    expect(total, findsOneWidget, reason: '一格 441 里"标题 + 总量"放得下 ⇒ 总量整条在');
    expect(tester.renderObject<RenderParagraph>(total).didExceedMaxLines, isFalse,
        reason: '总量要显示就得是整条，不许是 `168.2k / 200k to…`');
    expect(
        tester.renderObject<RenderParagraph>(_inContext(find.text('当前上下文构成'))).didExceedMaxLines,
        isFalse,
        reason: '标签放得下，不该被省略');

    // ⑤ 三卡等宽没带来代价：不溢出（黄黑条）
    expect(tester.takeException(), isNull, reason: '三卡等宽这一版不许溢出');
  });
}
