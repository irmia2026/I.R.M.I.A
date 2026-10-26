import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/pages/schedule_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 「日程」页（一级第三项）——设计稿 `Agent 近期安排 · 周历与清单.html`。
///
/// 这一组锁八件事，每件都分**正反两面**：
///   ① **整页不滚、只有清单滚**（用户 2026-10-12 的硬要求）：页面子树里只许有一个 `Scrollable`
///      （清单那个），条目多时它真的能滚；窗口矮时压的是**周历行高**；
///   ② 四张计数卡都是**真数**（待分享想法没有落盘 ⇒ 00 + 那句注脚，不编）且**压到约 2/3 高**；
///   ③ **这一页是给人看的**（用户 2026-10-12 的批注）：**周历只画用户向的条目**——她自己的内务
///      （`scope:'self'` / 框架内务 kind）不占时间轴，但仍留在清单里、**降级在后 + 灰角标**；
///      缺省（没写 `scope`）按用户向处理；
///   ④ 周历：7 列 + 今天实心圆 + 08:00–21:00 刻度 + 块按 `at` 定位、按 `dur` 撑高；
///      落不到时间轴上的（只有 `cron` 的、时段外的）如实说一句，不猜时刻；
///   ⑤ 清单一行：日期钟点 · 标题（退化链）· 一行说明（缺则整行不出现）· 分类 chip · 状态 chip · 箭头；
///      四条缺省退化各一条：无 `title` / 无 `cat` / 无 `dur` / 无 `action`；
///   ⑥ **现场那条现存 cron**（`t_1791808527244_1` / `0 4 * * *` / `{kind:'memory-maintain'}`）
///      必须渲染成一行人话（`每日记忆整理`），而且它是**她的内务** ⇒ 不上周历；
///   ⑦ 「最近的工作记录」整块与周历底部那两句技术说明**都删掉了**（用户点名）；
///   ⑧ **列表形态不许压到图例上**（用户 2026-10-12 的截图三）：取真实 rect 断言不重叠；
///      「新建安排」两层：常显只有"什么时候 + 要做什么"，其余收进「更多选项」。
///   ⑨ **2026-10-25 的六处删除**（反向断言：文案、整块、「去记忆页」一个都不许上屏）：
///      ① 周历标题下那行 ② 清单标题下那行 ③ 详情那段说明 ④ 整块「长期计划」（含取数）
///      ⑤ 周历底部"不在 08:00-21:00"那行 ⑥ 页脚那句。另有 ⑦：回到本周 = 控件圆角（10）。
///
/// ## 一条纪律：**这一组用例不许依赖"今天是周几/几点"**
///
/// 页面把"现在"读成 `scheduleNow()`（默认真实时钟，见 `schedule_page.dart` 的那个常量），
/// 用例想验哪一天就 `_fixToday(...)` 把它钉死（`tearDown` 统一还原）。夹具里的相对日子一律
/// 走 [_dayAt]——它**锚进当前显示的这一周**，不写 `今天 + N 天`。
///
/// 来头：2026-10-18（周日）那次基线上，`+1/+2/+3 天` 的夹具全跑到下一周去了，
/// 「本周安排」的读数跟着变、还与「Agent 自主工作」撞成同一个 `01`，一次红了 4 条。
/// 现在有两条用例专门盯这件事：注入"周日 / 周一"各跑一遍，读数必须逐项相同。
class _Post {
  const _Post(this.path, this.body);
  final String path;
  final Map<String, dynamic> body;
}

class _FakeApi extends IrmiaApi {
  _FakeApi(this.routes) : super(baseUrl: 'http://127.0.0.1:1');

  final Map<String, dynamic> routes;
  final List<_Post> posts = [];

  /// 这一页读过哪些 GET（反向断言"删了那一块，取数也一起删"用）
  final List<String> gets = [];
  final Map<String, Object> failGet = {};
  final Map<String, Object> failPost = {};
  Map<String, dynamic> wakeReply = <String, dynamic>{'ok': true, 'deduped': false};
  String builtId = 't-human';
  String builtAt = '2026-10-20T12:00:00.000Z';

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    gets.add(path);
    final failure = failGet[path];
    if (failure != null) throw failure;
    if (path.startsWith('/api/memory?file=')) return routes['/api/memory?file'];
    return routes[path];
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    posts.add(_Post(path, body));
    final failure = failPost[path];
    if (failure != null) throw failure;
    if (path == '/api/commands/wake') return wakeReply;
    if (path == '/api/commands/timer-set') {
      // 与生产同形：新那条折进投影（界面重读就看得见），回执给结算过的时刻
      final timers = (routes['/api/projection'] as Map)['timers'] as List;
      timers.add({
        'timerId': builtId,
        'at': builtAt,
        if (body['cron'] != null) 'cron': body['cron'],
        'payload': {
          'why': body['why'] ?? '',
          'note': body['note'] ?? '',
          'sid': body['sid'],
          if (body['title'] != null) 'title': body['title'],
          if (body['cat'] != null) 'cat': body['cat'],
          if (body['dur'] != null) 'dur': body['dur'],
          if (body['action'] != null) 'action': body['action'],
          'by': 'human',
        },
      });
      return {
        'ok': true,
        'timerId': builtId,
        'at': builtAt,
        if (body['cron'] != null) 'cron': body['cron'],
      };
    }
    if (path == '/api/commands/timer-cancel') {
      final timers = (routes['/api/projection'] as Map)['timers'] as List;
      timers.removeWhere((item) => (item as Map)['timerId'] == body['timerId']);
      return {'ok': true, 'timerId': body['timerId']};
    }
    return {'ok': true};
  }
}

String _iso(DateTime local) => local.toUtc().toIso8601String();

String _dayKey(DateTime day) =>
    '${day.year}-${day.month.toString().padLeft(2, '0')}-${day.day.toString().padLeft(2, '0')}';

/// 夹具里的"某天几点"：**锚进当前显示的这一周**（`offset` 天；越过周日就绕回本周的周一）。
///
/// 为什么不是 `今天 + offset`：**周日跑**时 `+1/+2/+3 天` 全都会甩到下一周，「本周安排」
/// 少算几条之余，还会与「Agent 自主工作」撞成同一个 `01` ——2026-10-18（周日）那次基线里
/// 红的正是这些用例。同一条纪律见 [scheduleNow]：**测试不许依赖"今天是周几/几点"**。
DateTime _dayAt(DateTime base, int offset, int hour, int minute) {
  final midnight = DateTime(base.year, base.month, base.day);
  final monday = midnight.subtract(Duration(days: base.weekday - DateTime.monday));
  final dayOffset = (base.weekday - DateTime.monday + offset) % 7;
  return DateTime(monday.year, monday.month, monday.day + dayOffset, hour, minute);
}

/// 把"今天"钉死（[tearDown] 里统一还原成真实时钟）
void _fixToday(DateTime today) => scheduleNow = () => today;

/// 四张计数卡的**大数**（[value] 那一格）：`_Stat` 里依次是 标签 / 大数 / 注脚
String _statValue(WidgetTester tester, String label) {
  final texts = tester
      .widgetList<Text>(find.descendant(
          of: find.byKey(ValueKey('schedule-stat-$label')), matching: find.byType(Text)))
      .toList();
  return texts[1].data ?? '';
}

/// **现场那条现存 cron 的原样**（用户点名的验收样例）
Map<String, dynamic> liveCronTimer() => {
      'timerId': 't_1791808527244_1',
      'cron': '0 4 * * *',
      'payload': {'kind': 'memory-maintain'},
    };

/// 真实形状的数据：现场那条 cron / 七格齐全一条 / 只有 note+why 一条 / cron+at 一条 / 旧形状一条
Map<String, dynamic> _routes({List<dynamic>? timers, String? factsContent}) {
  final now = scheduleNow();
  return {
    '/api/projection': {
      'needsReview': <dynamic>[],
      'timers': timers ??
          [
            liveCronTimer(),
            {
              'timerId': 't-full',
              'at': _iso(_dayAt(now, 0, 20, 30)),
              'payload': {
                'title': '晚间学习复盘',
                'why': '这周想把复习固定在晚上',
                'note': '先看一遍今天学了什么。只整理出值得分享的一条',
                'sid': 'qq:group:G1',
                'cat': 'routine',
                'dur': 60,
                'action': 'draft',
              },
            },
            {
              'timerId': 't-bare',
              'at': _iso(_dayAt(now, 1, 9, 0)),
              'payload': {
                'note': '看一眼汇报材料定稿没有。没定就提醒我',
                'why': '周三要交，我怕忘了',
              },
            },
            {
              'timerId': 't-cron-at',
              'at': _iso(_dayAt(now, 2, 9, 0)),
              'cron': '0 9 * * 2',
              'payload': {'title': '周计划整理', 'cat': 'work', 'dur': 45, 'action': 'self'},
            },
            {
              'timerId': 't-old',
              'at': _iso(_dayAt(now, 3, 17, 30)),
              'payload': '看看邮件回来没有',
            },
          ],
    },
    '/api/stats/dashboard': {
      // ⚠ 这一页**不再读它**（「最近的工作记录」整块按用户批注删掉了）；留着是为了让"多读了一格
      // 也不会崩"这件事仍然成立——真删掉这个键，测试台就测不出"她那一侧多给了数据"的情况。
      'state': 'idle',
      'tiles': {'pending': 0, 'failStreak': 0, 'needsReview': 0, 'cacheHitRate': 0.9},
      'recent': [
        {
          'seq': 1,
          'ts': '2026-10-12T12:00:00.000Z',
          'type': 'message/user',
          'summary': '用户说了一句不该上屏的话',
          'visibility': 'model',
        },
      ],
    },
    '/api/sessions': {
      'sessions': [
        {'sid': 'qq:group:G1', 'name': '弥亚庄园', 'chatType': 'group'},
        {'sid': 'qq:c2c:C9', 'name': '', 'chatType': 'c2c', 'person': 'C9'},
      ],
      'contacts': <dynamic>{},
      'unreadTotal': 0,
    },
    // 记忆清单：**照现场那五个分区**（一个都不许上日程页）
    '/api/memory': {
      'facts': {
        'path': 'MEMORIES/facts.md',
        'bytes': 120,
        'mtime': '2026-10-12T10:00:00.000Z',
        'sections': [
          {'title': '## 置顶（pinned）', 'lines': 4},
          {'title': '## 约定与承诺', 'lines': 6},
          {'title': '## 稳定事实', 'lines': 20},
          {'title': '## 观察', 'lines': 12},
          {'title': '## 归档（已失效/已过期，不注入）', 'lines': 30},
        ],
      },
      'files': <dynamic>[],
      'episodes': <dynamic>[],
      'archive': <dynamic>[],
      'diary': <dynamic>[],
    },
    '/api/memory?file': {
      'content': factsContent ??
          '# Facts\n\n'
              '## 置顶（pinned）\n- 别为了提醒而提醒\n\n'
              '## 约定与承诺\n- 每周一次学习复盘\n\n'
              '## 稳定事实\n- 用户在做无人值守 agent\n\n'
              '## 观察\n- 他夜里更愿意聊技术\n\n'
              '## 归档（已失效/已过期，不注入）\n- 旧口令\n',
    },
  };
}

Future<AppState> _pump(WidgetTester tester, _FakeApi api,
    {Size size = const Size(1600, 1200)}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  final state = AppState(api: api);
  addTearDown(state.dispose);
  await tester.pumpWidget(
    MaterialApp(theme: IrmiaTheme.light(), home: Scaffold(body: SchedulePage(state: state))),
  );
  // 数据各自要跑完 await 链（投影 + 会话名单；长期计划那块 2026-10-25 已删，不再读记忆）
  for (var i = 0; i < 8; i += 1) {
    await tester.pump(const Duration(milliseconds: 20));
  }
  return state;
}

Future<void> _drain(WidgetTester tester) async {
  await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 600));
  await tester.pump(const Duration(milliseconds: 400));
}

Finder _item(String id) => find.byKey(ValueKey('schedule-item-$id'));
Finder _open(String id) => find.byKey(ValueKey('schedule-open-$id'));

/// 周历上的块：键是 `schedule-block-<timerId>-<dayKey>`（周期条目会在它每个该出现的星期几上
/// 各出一块）。这个 finder 按**前缀**匹配那一条的所有块（配合 `findsOneWidget` / `findsNWidgets`）
Finder _block(String id) => find.byWidgetPredicate((widget) {
      final key = widget.key;
      return key is ValueKey<String> && key.value.startsWith('schedule-block-$id-');
    });

/// 某一天那一块（要精确到日子时用它）
Finder _blockOn(String id, DateTime day) =>
    find.byKey(ValueKey('schedule-block-$id-${_dayKey(day)}'));

/// 这一周里"周一 + n 天"（测试里算日子别用 today+n：今天是周日时那会跑到下一周去）
DateTime _weekdayOfThisWeek(int offsetFromMonday) {
  final now = scheduleNow();
  final midnight = DateTime(now.year, now.month, now.day);
  return midnight
      .subtract(Duration(days: midnight.weekday - DateTime.monday))
      .add(Duration(days: offsetFromMonday));
}
Finder _dayCell(DateTime day) => find.byKey(ValueKey('schedule-day-${_dayKey(day)}'));
Finder _pageScrollables() =>
    find.descendant(of: find.byType(SchedulePage), matching: find.byType(Scrollable));
Finder _listScrollable() =>
    find.descendant(of: find.byKey(const ValueKey('schedule-list')), matching: find.byType(Scrollable));
Finder _detailRow(String label) =>
    find.ancestor(of: find.text(label), matching: find.byType(Row)).first;

void main() {
  // 「今天」是注入的：每条用例跑完就还原成真实时钟（**绝不留给下一条用例**）
  tearDown(() => scheduleNow = DateTime.now);

  // ── ① 骨架 ──

  testWidgets('骨架：eyebrow + 大标题「近期安排」+ 三件动作 + 剩下的分区都在', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('YOUR TIME, THOUGHTFULLY'), findsOneWidget, reason: '设计稿那条英文 eyebrow');
    expect(find.text('近期安排'), findsOneWidget, reason: '大标题（导航项仍叫「日程」）');
    expect(find.text('把日程、提醒和她自己的计划放在同一处。'), findsOneWidget);
    expect(find.byKey(const ValueKey('schedule-search')), findsOneWidget);
    expect(find.byKey(const ValueKey('schedule-back-week')), findsOneWidget);
    expect(find.text('新建安排'), findsOneWidget);

    expect(find.text('周历'), findsOneWidget);
    expect(find.text('安排清单'), findsOneWidget);
    expect(find.text('SELECTED PLAN'), findsOneWidget);
    // ①②③④⑤⑥ 2026-10-25 用户点名删掉的六段 / 两块，一句都不许再上屏
    expect(find.text('接下来要发生的事'), findsNothing, reason: '② 清单标题下那行删了');
    expect(find.text('选择一个条目，查看具体安排'), findsNothing, reason: '① 周历标题下那行删了');
    expect(find.textContaining('点清单或周历里的任意一条'), findsNothing, reason: '③ 详情那段说明删了');
    expect(find.text('长期计划'), findsNothing, reason: '④ 整块删了');
    expect(find.textContaining('她单开的那一格'), findsNothing, reason: '④ 整块删了（含右上那句注解）');
    expect(find.text('去记忆页'), findsNothing, reason: '④ 连「去记忆页」也删了');
    expect(find.textContaining('不在 08:00'), findsNothing, reason: '⑤ 周历底部那行删了');
    expect(find.textContaining('安排只是一个行动机会'), findsNothing, reason: '⑥ 页脚那句删了');
    // ⑦ 用户点名删掉的两块：工作记录整块 + 周历底部那两句技术说明
    expect(find.text('最近的工作记录'), findsNothing, reason: '整块删掉了（用户批注"此块无意义可去掉"）');
    expect(find.byKey(const ValueKey('schedule-records')), findsNothing);
    expect(find.textContaining('块高按 payload.dur 算'), findsNothing, reason: '技术说明删掉了');
    expect(find.textContaining('分类色按 payload.cat'), findsNothing, reason: '技术说明删掉了');
    for (final label in ['工作 / 学习', '陪伴 / 交流', '生活习惯', '周期计划']) {
      // 图例一处；`cat=work` 那条的清单 chip 又一处 ⇒ 至少一处
      expect(find.text(label), findsWidgets, reason: '四色图例缺一格：$label');
    }

    await _drain(tester);
  });

  /// ⑦ 「回到本周」：不再是胶囊，圆角 == 控件档（10），高度与隔壁主按钮一致。
  testWidgets('⑦ 回到本周：圆角 == radiusCtl（控件档 10），与「＋新建安排」同高', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    final back = find.byKey(const ValueKey('schedule-back-week'));
    expect(back, findsOneWidget);

    // 按钮的 Material 形状就是它真正画出来的样子（OutlinedButton 从 ButtonStyle 解析来的）
    final shapes = tester
        .widgetList<Material>(find.descendant(of: back, matching: find.byType(Material)))
        .map((m) => m.shape)
        .whereType<RoundedRectangleBorder>()
        .toList();
    expect(shapes, isNotEmpty, reason: '回到本周那层 Material 的形状要量得到');
    for (final shape in shapes) {
      expect(shape.borderRadius, BorderRadius.circular(IrmiaTheme.radiusCtl),
          reason: '⑦ 胶囊形 ⇒ 控件圆角（control = 10）');
    }
    expect((shapes.first.borderRadius as BorderRadius).topLeft.x, 10,
        reason: '控件档就是 10（[Shape.radiusControl]）');

    // 高度与隔壁那颗主按钮逐像素一致（同一套内边距 + 同一份 buttonText）
    final propose = find.byKey(const ValueKey('schedule-propose'));
    expect(tester.getSize(back).height,
        moreOrLessEquals(tester.getSize(propose).height, epsilon: 0.5),
        reason: '次级按钮与主按钮同一行，高度必须一致');

    await _drain(tester);
  });

  testWidgets('② 计数卡压到约 2/3 高：数值与注脚都在，块本身矮下来（用户批注"别占掉半屏"）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    for (final label in ['本周安排', '等待触发', 'Agent 自主工作', '待分享想法']) {
      final card = find.byKey(ValueKey('schedule-stat-$label'));
      expect(card, findsOneWidget, reason: '缺一张卡：$label');
      // 压小之后每张卡都在 74 逻辑像素以内（上一版 ~93：内边距 12 + 23 号数字）。
      // 74 而不是原来的 72：2026-10-17 把「说明」那一档的行高从 M3 的 16 提到 design_tokens
      // 的 12/18（Type.caption），那张卡的注脚因此高了 1 像素。这条断言的意图是"约 2/3 高、
      // 别占掉半屏"，不是钉死某个像素——所以放 2 像素的余量。
      expect(tester.getSize(card).height, lessThan(74), reason: '$label 那张卡还是太大');
      expect(tester.getSize(card).height, greaterThan(45), reason: '$label 被压得看不见了');
    }
    expect(find.text('她的草稿还没有落盘'), findsOneWidget, reason: '注脚要留着');

    await _drain(tester);
  });

  // ── ② 四张计数卡：都是真数 ──

  testWidgets('计数卡：四张都是真数（待分享想法没有落盘 ⇒ 00 + 那句注脚）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('等待触发'), findsOneWidget);
    expect(find.text('05'), findsWidgets, reason: '等待触发 = 投影条数（五条）');
    expect(find.text('一次性与周期任务'), findsOneWidget);
    expect(find.text('到点后会重新判断'), findsOneWidget);
    expect(find.text('Agent 自主工作'), findsOneWidget);
    expect(find.text('不一定需要联系你'), findsOneWidget);
    expect(find.text('待分享想法'), findsOneWidget);
    expect(find.text('她的草稿还没有落盘'), findsOneWidget, reason: '读不到草稿落盘 ⇒ 如实说，不编');
    // 这一版不再有"暂未接入"（用户要真数）
    expect(find.text('暂未接入'), findsNothing);

    await _drain(tester);
  });

  testWidgets('计数卡：Agent 自主工作只数 action=self 的（正反两面）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);
    // 只有 t-cron-at 是 self
    expect(find.text('01'), findsOneWidget, reason: 'self 的只有一条');

    // 反过来：把那条的 action 换掉 ⇒ 回到 00
    final timers = (api.routes['/api/projection'] as Map)['timers'] as List;
    ((timers.firstWhere((t) => (t as Map)['timerId'] == 't-cron-at') as Map)['payload']
        as Map)['action'] = 'notify';
    // 重开一页（这一版没有下拉刷新：整页不滚，没地方挂 RefreshIndicator）
    await tester.pumpWidget(const SizedBox());
    await _pump(tester, api);
    expect(find.text('00'), findsWidgets, reason: '没有 self 之后那张卡回到 00');
    await _drain(tester);
  });

  // ── ③ 整页不滚：只有清单滚（硬要求） ──

  testWidgets('整页不滚：页面子树里只有清单那一个 Scrollable', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(_pageScrollables(), findsOneWidget, reason: '整页不滚：只许有清单那一处可滚动');
    expect(_listScrollable(), findsOneWidget, reason: '那唯一一处就是安排清单');

    await _drain(tester);
  });

  testWidgets('整页不滚：条目放得下时清单也不滚（反过面）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {'timerId': 't-one', 'at': _iso(_dayAt(now, 1, 9, 0)), 'payload': {'title': '只有一条'}},
      {'timerId': 't-two', 'at': _iso(_dayAt(now, 1, 10, 0)), 'payload': {'title': '两条'}},
    ]));
    await _pump(tester, api);

    expect(tester.state<ScrollableState>(_listScrollable()).position.maxScrollExtent, 0,
        reason: '两条放得下 ⇒ 清单不该有多余滚动量');
    expect(_pageScrollables(), findsOneWidget, reason: '整页仍然只有它一个可滚块');

    await _drain(tester);
  });

  testWidgets('只有清单滚：条目多到放不下时，清单真的能滚（反过面）', (tester) async {
    final now = scheduleNow();
    final many = <dynamic>[
      for (var i = 0; i < 20; i += 1)
        {
          'timerId': 't-many-$i',
          'at': _iso(_dayAt(now, 1, 9, i % 60)),
          'payload': {'title': '第 $i 条安排', 'why': '为了把清单撑满'},
        },
    ];
    final api = _FakeApi(_routes(timers: many));
    await _pump(tester, api);

    expect(_pageScrollables(), findsOneWidget, reason: '条目再多，整页也不许多出滚动条');
    final position = tester.state<ScrollableState>(_listScrollable()).position;
    expect(position.maxScrollExtent, greaterThan(0), reason: '20 条放不下 ⇒ 清单要能滚');

    expect(position.pixels, 0);
    await tester.drag(_listScrollable(), const Offset(0, -120));
    await tester.pump();
    expect(tester.state<ScrollableState>(_listScrollable()).position.pixels, greaterThan(0),
        reason: '拖了没动 ⇒ 那一块其实没在滚');

    await _drain(tester);
  });

  testWidgets('窗口矮：压的是周历行高，整页照旧不滚（反过面）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);
    final tallGrid = tester.getSize(find.byKey(const ValueKey('schedule-grid'))).height;
    await _drain(tester);

    final short = _FakeApi(_routes());
    await _pump(tester, short, size: const Size(1400, 620));
    final shortGrid = tester.getSize(find.byKey(const ValueKey('schedule-grid'))).height;

    expect(shortGrid, lessThan(tallGrid), reason: '窗口矮 ⇒ 行高压下去（不是让整页滚）');
    expect(_pageScrollables(), findsOneWidget, reason: '矮窗口也只有一个可滚块（清单）');
    // 矮窗口里只剩清单与详情（前两块附加内容都删了：工作记录上一轮、长期计划这一轮）
    expect(find.byKey(const ValueKey('schedule-records')), findsNothing);
    expect(find.byKey(const ValueKey('schedule-plans')), findsNothing);
    await _drain(tester);
  });

  // ── ④ 周历：刻度 / 今天 / 块定位与块高 ──

  testWidgets('周历：08:00–21:00 刻度、今天实心圆、七天都在', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('08:00'), findsOneWidget);
    expect(find.text('21:00'), findsOneWidget);
    final now = scheduleNow();
    // 显示的永远是"本周"（周一起）——所以按**页面同一算法**算周一，别用 today+i（今天是周日时
    // 会把下周的格子算进来，测试就会假红一次）
    final midnight = DateTime(now.year, now.month, now.day);
    final monday = midnight.subtract(Duration(days: midnight.weekday - DateTime.monday));
    for (var i = 0; i < 7; i += 1) {
      expect(_dayCell(monday.add(Duration(days: i))), findsOneWidget, reason: '第 $i 天的格子不在');
    }
    final primary = IrmiaTheme.light().colorScheme.primary;
    final circles = tester
        .widgetList<Container>(find.descendant(of: _dayCell(now), matching: find.byType(Container)))
        .where((c) {
      final d = c.decoration;
      return d is BoxDecoration && d.shape == BoxShape.circle && d.color == primary;
    });
    expect(circles.length, 1, reason: '今天要高亮成实心圆');

    await _drain(tester);
  });

  testWidgets('周历块：按 at 定位、按 dur 撑高（公式逐字核对）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    final grid = tester.getRect(find.byKey(const ValueKey('schedule-grid')));
    final rowH = grid.height / kGridHours;
    final block = tester.getRect(_block('t-full'));
    // t-full = 今天 20:30、dur=60
    expect(block.top - grid.top, closeTo((20 * 60 + 30 - 8 * 60) / 60 * rowH, 1.0),
        reason: '块的纵坐标 = (钟点 − 08:00) / 60 × 行高');
    expect(block.height,
        closeTo([32.0, 60 / 60 * rowH - 3].reduce((a, b) => a > b ? a : b), 1.5),
        reason: '块高 = max(32, dur / 60 × 行高 − 3)：32 是"钟点 + 一行标题"放得下的下限');
    expect(find.descendant(of: _block('t-full'), matching: find.text('20:30')), findsOneWidget);
    expect(find.descendant(of: _block('t-full'), matching: find.text('晚间学习复盘')), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('④ 用户向的周期条目（只有 cron）**要**画到它那一天上（用户 2026-10-13 的修正）', (tester) async {
    final api = _FakeApi(_routes(timers: [
      // 用户向（没写 scope、不是框架内务）、只有 cron ⇒ 按 cron 算日子画（不再只是"说一句"）
      {'timerId': 't-owner-cron-only', 'cron': '0 9 * * 1', 'payload': {'title': '每周一整理周计划'}},
    ]));
    await _pump(tester, api);

    expect(_blockOn('t-owner-cron-only', _weekdayOfThisWeek(0)), findsOneWidget,
        reason: '周一 09:00 那一块要画出来');
    expect(find.text('09:00 · 周期'), findsOneWidget, reason: '块上标"周期"，与一次性条目分得开');
    expect(find.textContaining('画不出这一周的周期条目'), findsNothing, reason: '它算得出来');

    await _drain(tester);
  });

  testWidgets('④ 有 at 又有 cron 的那条照常画块（两种都兜）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(_block('t-cron-at'), findsOneWidget);
    expect(_item('t-cron-at'), findsOneWidget);

    await _drain(tester);
  });

  // ── ④b 周期条目按 cron 摊到每个星期几上（用户 2026-10-13 的线上反馈） ──

  testWidgets('④b 线上那条原样：「健身 · 每周三练」cron=0 20 * * 2,4,6 ⇒ 周历上三块（不是一块）', (tester) async {
    // 原始读数（seq 88671 的 timer/set，逐字）：at=2026-10-13T12:00:00.000Z · cron=0 20 * * 2,4,6
    // · payload={title:'健身 · 每周三练', cat:'生活习惯', dur:35, action:'提醒', sid, why, note}
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't_1791822816404_1',
        'at': _iso(_weekdayOfThisWeek(1).add(const Duration(hours: 20))), // 周二 20:00（下一次）
        'cron': '0 20 * * 2,4,6',
        'payload': {
          'title': '健身 · 每周三练',
          'cat': '生活习惯',
          'dur': 35,
          'action': '提醒',
          'why': '用户 10-13 凌晨亲口说「每周三次，减减脂肪就好」',
        },
      },
    ]));
    await _pump(tester, api);

    expect(_block('t_1791822816404_1'), findsNWidgets(3), reason: '周二/周四/周六各一块');
    for (final offset in [1, 3, 5]) {
      expect(_blockOn('t_1791822816404_1', _weekdayOfThisWeek(offset)), findsOneWidget,
          reason: '第 ${offset + 1} 天（周二/四/六）那一块不在');
    }
    // 块上跟一次性条目分得开：钟点后面带「周期」
    expect(find.text('20:00 · 周期'), findsNWidgets(3));
    // 清单那一行：cron 说成人话
    expect(find.descendant(of: _item('t_1791822816404_1'), matching: find.text('周期 · 每周二/四/六 20:00')),
        findsOneWidget);
    // 它算得出来 ⇒ 不进"画不出这一周"那一行
    expect(find.textContaining('画不出这一周的周期条目'), findsNothing);

    await _drain(tester);
  });

  testWidgets('④b 反过面：认不出的 cron 一条都不画（宁可少画，不许画错）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      // 带步长、带月/日限定：这两种我们算不出"每周几"⇒ 不画
      {'timerId': 't-step', 'at': _iso(_dayAt(now, 1, 10, 0)), 'cron': '*/5 * * * *', 'payload': {'title': '步长那条'}},
      {'timerId': 't-dom', 'at': _iso(_dayAt(now, 1, 11, 0)), 'cron': '0 9 1 * *', 'payload': {'title': '带日限定的那条'}},
    ]));
    await _pump(tester, api);

    expect(_block('t-step'), findsNothing, reason: '算不出 ⇒ 不画（哪怕它有 at）');
    expect(_block('t-dom'), findsNothing);
    expect(find.textContaining('画不出这一周的周期条目：2 条'), findsOneWidget, reason: '如实说清两条');
    // 两条都还在清单里（清单不丢东西）
    expect(_item('t-step'), findsOneWidget);
    expect(_item('t-dom'), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('④b 支持的那几种形状各一条：每天 / 范围 / 单日；钟点在格外的不画', (tester) async {
    final api = _FakeApi(_routes(timers: [
      {'timerId': 't-daily', 'cron': '30 9 * * *', 'payload': {'title': '每天那条', 'dur': 20}},
      {'timerId': 't-range', 'cron': '0 14 * * 1-5', 'payload': {'title': '工作日那条', 'dur': 20}},
      {'timerId': 't-single', 'cron': '0 18 * * 3', 'payload': {'title': '周三那条', 'dur': 20}},
      {'timerId': 't-night', 'cron': '0 23 * * 4', 'payload': {'title': '深夜那条', 'dur': 20}},
    ]));
    await _pump(tester, api);

    expect(_block('t-daily'), findsNWidgets(7), reason: '每天 ⇒ 七块');
    expect(_block('t-range'), findsNWidgets(5), reason: '周一至周五 ⇒ 五块');
    expect(_block('t-single'), findsNWidgets(1), reason: '单日 ⇒ 一块');
    expect(_blockOn('t-single', _weekdayOfThisWeek(2)), findsOneWidget, reason: '就落在周三那一列');
    expect(_block('t-night'), findsNothing, reason: '23:00 不在 08:00–21:00 这一格里 ⇒ 不画');
    // ⑤ 2026-10-25 删了那行"不在 08:00-21:00 这一格里：N 条"，它连数都不许再报
    expect(find.textContaining('不在 08:00'), findsNothing, reason: '⑤ 这行删了');
    // cron 的人话（范围写成"周一至周五"）
    expect(find.descendant(of: _item('t-range'), matching: find.text('周期 · 每周一至周五 14:00')),
        findsOneWidget);
    expect(find.descendant(of: _item('t-daily'), matching: find.text('周期 · 每天 09:30')), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('④b 周期块点一下照旧选中详情（一周里三块 → 都是同一条）', (tester) async {
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't-thrice',
        'at': _iso(_weekdayOfThisWeek(1).add(const Duration(hours: 20))),
        'cron': '0 20 * * 2,4,6',
        'payload': {'title': '健身 · 每周三练', 'cat': '生活习惯', 'dur': 35, 'action': '提醒'},
      },
    ]));
    await _pump(tester, api);

    await tester.tap(_blockOn('t-thrice', _weekdayOfThisWeek(3)));
    await tester.pump();
    expect(find.descendant(of: find.byKey(const ValueKey('schedule-detail')),
        matching: find.text('健身 · 每周三练')), findsWidgets);
    expect(find.byKey(const ValueKey('schedule-cancel-t-thrice')), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('④b payload.action 两种写法都认（线上写的是人话「自主工作」/「提醒」/「存草稿」）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't-cn-self',
        'at': _iso(_dayAt(now, 1, 9, 0)),
        // 现场那条现存 cron 的 action 就是这个字面量（`"action":"自主工作"`）
        'payload': {'title': '她自己要做的', 'action': '自主工作'},
      },
      {
        'timerId': 't-cn-draft',
        'at': _iso(_dayAt(now, 1, 10, 0)),
        'payload': {'title': '攒着的话', 'action': '存草稿'},
      },
      {
        'timerId': 't-en-self',
        'at': _iso(_dayAt(now, 1, 11, 0)),
        'payload': {'title': '英文键那条', 'action': 'self'},
      },
    ]));
    await _pump(tester, api);

    // 归一化之前：中文写法数不到 ⇒ 这张卡恒为 00（线上就是那样）
    expect(find.text('02'), findsOneWidget, reason: '两条 self（一条中文一条英文键）都算进"自主工作"');
    expect(find.descendant(of: _item('t-cn-draft'), matching: find.text('待分享草稿')), findsOneWidget,
        reason: '中文「存草稿」也要认出待分享草稿');
    await tester.tap(_open('t-cn-self'));
    await tester.pump();
    expect(find.descendant(of: _detailRow('到点后'), matching: find.text('自主工作')), findsOneWidget,
        reason: '详情里照她那一侧的词显示');

    await _drain(tester);
  });

  testWidgets('周历：不在 08:00–21:00 里的也画不出位置（那行读数已删）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {'timerId': 't-night', 'at': _iso(_dayAt(now, 1, 23, 30)), 'payload': {'title': '深夜那条'}},
    ]));
    await _pump(tester, api);

    expect(_block('t-night'), findsNothing);
    // ⑤ 那行"不在 08:00-21:00 这一格里：N 条"删掉了——条目本身还在清单里
    expect(find.textContaining('不在 08:00'), findsNothing, reason: '⑤ 这行删了');
    expect(_item('t-night'), findsOneWidget, reason: '画不出位置 ≠ 没排：它照旧在清单里');

    await _drain(tester);
  });

  // ── ⑤ 清单一行 + 状态/分类 chip ──

  testWidgets('清单一行：日期钟点 · 标题 · 一行说明 · 分类 chip · 状态 chip · 箭头', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('晚间学习复盘'), findsWidgets, reason: 'title 优先');
    expect(find.textContaining('这周想把复习固定在晚上'), findsWidgets, reason: '一行说明 = why');
    expect(find.descendant(of: _item('t-full'), matching: find.text('周期计划')), findsOneWidget,
        reason: 'cat=routine ⇒ 分类 chip');
    expect(find.descendant(of: _item('t-full'), matching: find.text('待分享草稿')), findsOneWidget,
        reason: 'action=draft ⇒ 状态 chip');
    expect(find.descendant(of: _item('t-cron-at'), matching: find.text('周期任务')), findsOneWidget,
        reason: '有 cron ⇒ 周期任务');
    expect(find.descendant(of: _item('t-bare'), matching: find.text('待触发')), findsOneWidget);
    final now = scheduleNow();
    expect(
        find.descendant(
            of: _item('t-full'), matching: find.text('${now.month}月${now.day}日 · 20:30')),
        findsOneWidget);
    // 旧形状（字符串 payload）照旧可读
    expect(find.text('看看邮件回来没有'), findsWidgets);

    await _drain(tester);
  });

  // ── ⑥ 标题退化链与四条缺省 ──

  testWidgets('退化 · 无 title ⇒ 用「到点做什么」的第一句（只取第一句）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.descendant(of: _item('t-bare'), matching: find.text('看一眼汇报材料定稿没有')),
        findsOneWidget, reason: 'note 有两句 ⇒ 标题只取第一句');
    // 第二句没丢：它在详情那一格里（清单的标题只取第一句，这是有意的）
    await tester.tap(_open('t-bare'));
    await tester.pump();
    expect(find.descendant(of: _detailRow('到点做什么'), matching: find.textContaining('没定就提醒我')),
        findsOneWidget, reason: '完整那句在详情里照旧可读');

    await _drain(tester);
  });

  testWidgets('退化 · 无 cat ⇒ 不涂色、不摆分类 chip', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    for (final label in ['工作 / 学习', '陪伴 / 交流', '生活习惯', '周期计划']) {
      expect(find.descendant(of: _item('t-bare'), matching: find.text(label)), findsNothing);
    }
    final neutral = tester
        .widgetList<Container>(find.descendant(of: _item('t-bare'), matching: find.byType(Container)))
        .where((c) {
      final d = c.decoration;
      return d is BoxDecoration && d.color == IrmiaTheme.light().colorScheme.outlineVariant;
    });
    expect(neutral, isNotEmpty, reason: '没写 cat ⇒ 中性色条（不猜一个分类色）');

    await _drain(tester);
  });

  testWidgets('退化 · 无 dur ⇒ 块高按 30 分钟，详情写明这是约定值', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    final grid = tester.getRect(find.byKey(const ValueKey('schedule-grid')));
    final rowH = grid.height / kGridHours;
    expect(tester.getRect(_block('t-bare')).height,
        closeTo([32.0, 30 / 60 * rowH - 3].reduce((a, b) => a > b ? a : b), 1.5),
        reason: '缺省 30 分钟');

    await tester.tap(_open('t-bare'));
    await tester.pump();
    expect(
        find.descendant(
            of: _detailRow('时长'), matching: find.text('30 分钟（约定值：这条没写 dur）')),
        findsOneWidget);

    await _drain(tester);
  });

  testWidgets('退化 · 无 action ⇒ 详情写「未写」，且不计进「Agent 自主工作」', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_open('t-bare'));
    await tester.pump();
    expect(find.descendant(of: _detailRow('到点后'), matching: find.text('未写')), findsOneWidget);
    expect(find.text('01'), findsOneWidget, reason: '自主工作只数 self 那条');

    await _drain(tester);
  });

  testWidgets('⑥★ 退化链最后一级：现场那条现存 cron 渲染成一行人话，且**不上周历**（她是内务）', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('每日记忆整理'), findsOneWidget);
    expect(find.descendant(of: _item('t_1791808527244_1'), matching: find.text('每日记忆整理')),
        findsOneWidget);
    expect(find.descendant(of: _item('t_1791808527244_1'), matching: find.text('周期 · 每天 04:00')),
        findsOneWidget, reason: '只有 cron ⇒ 时间那格给"周期 + 人话化的表达式"');
    expect(find.descendant(of: _item('t_1791808527244_1'), matching: find.text('周期任务')),
        findsOneWidget);
    expect(find.descendant(of: _item('t_1791808527244_1'), matching: find.text('她的内务')),
        findsOneWidget, reason: '框架内务 ⇒ 灰角标（用户：她自己的行动不该占主位）');
    expect(_block('t_1791808527244_1'), findsNothing, reason: '不上周历');
    expect(
        find.descendant(
            of: _item('t_1791808527244_1'), matching: find.textContaining('为什么')),
        findsNothing,
        reason: '它没有 why ⇒ 那一行说明整行不出现（不摆空占位）');

    await _drain(tester);
  });

  testWidgets('全都没有 ⇒ 「未命名安排」（不空白、也不编内容）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {'timerId': 't-empty', 'at': _iso(_dayAt(now, 1, 9, 0)), 'payload': <String, dynamic>{}},
    ]));
    await _pump(tester, api);

    expect(find.text('未命名安排'), findsWidgets);
    await _drain(tester);
  });

  testWidgets('cron 人话化：三种形状各一条，认不出的原样显示（不猜）', (tester) async {
    final api = _FakeApi(_routes(timers: [
      {'timerId': 'c1', 'cron': '0 4 * * *', 'payload': {'title': '每天那条'}},
      {'timerId': 'c2', 'cron': '30 21 * * 6', 'payload': {'title': '每周那条'}},
      {'timerId': 'c3', 'cron': '*/5 * * * *', 'payload': {'title': '认不出的那条'}},
      {'timerId': 'c4', 'cron': '0 9 1 * *', 'payload': {'title': '带月份的那条'}},
    ]));
    await _pump(tester, api);

    expect(find.text('周期 · 每天 04:00'), findsOneWidget);
    expect(find.text('周期 · 每周六 21:30'), findsOneWidget);
    expect(find.text('周期 · */5 * * * *'), findsOneWidget, reason: '认不出的形状原样显示');
    expect(find.text('周期 · 0 9 1 * *'), findsOneWidget, reason: '带月份限定的也原样显示');

    await _drain(tester);
  });

  // ── ⑦ 联动：点一天筛、点一条看详情 ──

  testWidgets('联动：点周历某天 ⇒ 清单只看那天；看全部恢复', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    final now = scheduleNow();
    expect(_item('t-full'), findsOneWidget);
    expect(_item('t-bare'), findsOneWidget);

    await tester.tap(_dayCell(now));
    await tester.pump();
    expect(_item('t-full'), findsOneWidget, reason: '今天那条要看得到');
    expect(_item('t-bare'), findsNothing, reason: '筛到那天之后别天的不出现');
    expect(find.textContaining('只看 ${now.month}月${now.day}日'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('schedule-clear-day')));
    await tester.pump();
    expect(_item('t-bare'), findsOneWidget, reason: '看全部之后回来');

    await _drain(tester);
  });

  testWidgets('联动：点一条 ⇒ 详情给六行 + 取消入口；sid 缺则「到哪儿说」整格不出现', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.text('选择一个安排'), findsOneWidget, reason: '没选时是占位话');

    await tester.tap(_open('t-full'));
    await tester.pump();
    for (final label in ['执行时间', '为什么安排它', '到点做什么', '到哪儿说', '时长', '到点后']) {
      expect(find.text(label), findsOneWidget, reason: '详情缺一行：$label');
    }
    expect(
        find.descendant(
            of: _detailRow('到哪儿说'), matching: find.textContaining('弥亚庄园（qq:group:G1…）')),
        findsOneWidget);
    expect(find.descendant(of: _detailRow('到点后'), matching: find.text('存草稿')), findsOneWidget);
    expect(find.byKey(const ValueKey('schedule-cancel-t-full')), findsOneWidget);

    await tester.tap(_open('t-bare'));
    await tester.pump();
    expect(find.text('到哪儿说'), findsNothing, reason: 'sid 缺 ⇒ 整格不出现');
    expect(find.text('为什么安排它'), findsOneWidget, reason: '别的行照旧');

    await _drain(tester);
  });

  // ── ⑧ 周 / 列表 切换、搜索（都是纯前端） ──

  testWidgets('周/列表 切换：列表形态按天分组，切回周形态又是时间轴', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    expect(find.byKey(const ValueKey('schedule-grid')), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('schedule-view-list')));
    await tester.pump();
    expect(find.byKey(const ValueKey('schedule-grid')), findsNothing, reason: '列表形态不画时间轴');
    expect(find.text('周一'), findsWidgets, reason: '按天分组那几行在');

    await tester.tap(find.byKey(const ValueKey('schedule-view-week')));
    await tester.pump();
    expect(find.byKey(const ValueKey('schedule-grid')), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('搜索：纯前端筛清单（一个请求都不发），清除后恢复', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-search')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('schedule-search-field')), '复盘');
    await tester.tap(find.byKey(const ValueKey('schedule-search-apply')));
    await tester.pumpAndSettle();

    expect(api.posts, isEmpty, reason: '搜索是纯前端的，不该发请求');
    expect(_item('t-full'), findsOneWidget);
    expect(_item('t-bare'), findsNothing, reason: '不匹配的被筛掉');
    expect(find.textContaining('匹配「复盘」'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('schedule-clear-search')));
    await tester.pump();
    expect(_item('t-bare'), findsOneWidget, reason: '清除之后回来');

    await _drain(tester);
  });

  // ── ③ 周历只画用户向的 / 清单排序 ──

  testWidgets('③ 周历只画用户向的：她的内务（scope:self）不上时间轴，但留在清单里、带灰角标', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't-mine',
        'at': _iso(_dayAt(now, 1, 10, 0)),
        'payload': {'scope': 'self', 'title': '自检一遍工具表', 'dur': 60},
      },
      {
        'timerId': 't-owner',
        'at': _iso(_dayAt(now, 1, 15, 0)),
        'payload': {'title': '提醒他合同今天到期', 'cat': 'work', 'dur': 30},
      },
    ]));
    await _pump(tester, api);

    expect(_block('t-owner'), findsOneWidget, reason: '用户向的照旧画在周历上');
    expect(_block('t-mine'), findsNothing, reason: 'scope:self ⇒ 不占时间轴（用户：agent 自己的行动不该占主位）');

    expect(_item('t-mine'), findsOneWidget, reason: '清单里仍要有它（"接下来要发生什么"里也有她的内务）');
    expect(find.descendant(of: _item('t-mine'), matching: find.text('她的内务')), findsOneWidget);
    expect(find.descendant(of: _item('t-owner'), matching: find.text('她的内务')), findsNothing);

    await _drain(tester);
  });

  testWidgets('③ 框架内务（memory-maintain）同样不上周历——即使它带 at（正反两面）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't-chore',
        'at': _iso(_dayAt(now, 1, 11, 0)),
        'cron': '0 4 * * *',
        'payload': {'kind': 'memory-maintain'},
      },
      {
        // 同样是 cron，但内容是替用户记的 ⇒ 用户向（缺省）
        'timerId': 't-owner-cron',
        'cron': '0 9 * * 1',
        'payload': {'title': '每周一整理周计划'},
      },
    ]));
    await _pump(tester, api);

    expect(_block('t-chore'), findsNothing, reason: '框架内务 kind ⇒ 不上时间轴');
    expect(_item('t-chore'), findsOneWidget);
    expect(find.descendant(of: _item('t-chore'), matching: find.text('她的内务')), findsOneWidget);
    // 反面：同样是 cron，但内容是替用户记的 ⇒ 用户向 ⇒ 画到周一那一列上（不再进"画不出"那一行）
    expect(_blockOn('t-owner-cron', _weekdayOfThisWeek(0)), findsOneWidget);
    expect(find.textContaining('画不出这一周的周期条目'), findsNothing);
    expect(find.descendant(of: _item('t-owner-cron'), matching: find.text('她的内务')), findsNothing);

    await _drain(tester);
  });

  testWidgets('③ 清单里用户向在前：她的内务降级排到后面（哪怕投影里她在前）', (tester) async {
    final now = scheduleNow();
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't-mine-first',
        'at': _iso(_dayAt(now, 1, 8, 30)),
        'payload': {'scope': 'self', 'title': '我自己的事（排在最前面）'},
      },
      {
        'timerId': 't-owner-later',
        'at': _iso(_dayAt(now, 1, 20, 0)),
        'payload': {'title': '给用户的事（排在后面）'},
      },
    ]));
    await _pump(tester, api);

    final mineTop = tester.getRect(_item('t-mine-first')).top;
    final ownerTop = tester.getRect(_item('t-owner-later')).top;
    expect(ownerTop, lessThan(mineTop),
        reason: '用户向的要排在她的内务前面（时间上她那条更早也不例外）');

    await _drain(tester);
  });

  testWidgets('⑧ 列表形态不压到图例上：最后一行在图例上方（截图三那个重叠）', (tester) async {
    final now = scheduleNow();
    final many = <dynamic>[
      for (var i = 0; i < 8; i += 1)
        {
          'timerId': 't-list-$i',
          'at': _iso(_dayAt(now, i % 5, 9 + i % 8, 0)),
          'payload': {'title': '列表第 $i 条', 'why': '为了让列表撑满', 'dur': 30},
        },
    ];
    final api = _FakeApi(_routes(timers: many));
    await _pump(tester, api);
    await tester.tap(find.byKey(const ValueKey('schedule-view-list')));
    await tester.pump();

    final legend = tester.getRect(find.byKey(const ValueKey('schedule-legend')));
    // 列表形态里所有可见的那几行都必须在图例**上方**（重叠就是那一次的 bug）
    final rows = find.textContaining('列表第');
    expect(rows, findsWidgets, reason: '列表形态要真的摆出几行');
    for (var i = 0; i < rows.evaluate().length; i += 1) {
      final rect = tester.getRect(rows.at(i));
      expect(rect.bottom, lessThanOrEqualTo(legend.top + 0.5),
          reason: '第 $i 行压到了图例上（rect.bottom=${rect.bottom} > legend.top=${legend.top}）');
    }
    // 而且仍然只有一个可滚块（列表形态没有偷偷加第二条滚动条）
    expect(_pageScrollables(), findsOneWidget);

    await _drain(tester);
  });

  // ── ⑨ 长期计划整块删掉（2026-10-25）：反向断言 ──

  testWidgets('★ ⑥ 处删除：那六段文案 + 整块「长期计划」+「去记忆页」一个都不上屏', (tester) async {
    // 数据里**故意**给全：记忆清单与 facts 正文里都有「长期计划」那一格
    // （删的是界面与取数，不是"假装数据里没有"）
    final api = _FakeApi(_routes(
      factsContent: '# Facts\n\n## 长期计划\n- 每周一次学习复盘\n\n',
    ));
    final sections = ((api.routes['/api/memory'] as Map)['facts'] as Map)['sections'] as List;
    sections.add({'title': '## 长期计划', 'lines': 1});
    await _pump(tester, api);

    const gone = <String, String>{
      '选择一个条目，查看具体安排': '① 周历标题下那行',
      '接下来要发生的事': '② 清单标题下那行',
      '点清单或周历里的任意一条': '③ 详情那段说明（整段）',
      '长期计划': '④ 整块',
      '她单开的那一格': '④ 右上那句注解',
      '去记忆页': '④ 去记忆页',
      '不在 08:00–21:00 这一格里': '⑤ 周历底部那行',
      '安排只是一个行动机会': '⑥ 页脚那句',
    };
    for (final entry in gone.entries) {
      expect(find.textContaining(entry.key), findsNothing,
          reason: '${entry.value}不许再上这一页：「${entry.key}」');
    }
    // 旧实现按这几个键上过屏：键也不许再挂
    expect(find.byKey(const ValueKey('schedule-plans')), findsNothing);
    expect(find.byKey(const ValueKey('schedule-goto-memory')), findsNothing);
    expect(find.byKey(const ValueKey('schedule-plan-section')), findsNothing);
    // 整块删干净的另一半：**取数一起删**（这一页不再读 facts.md /api/memory）
    expect(api.gets.where((path) => path.startsWith('/api/memory')), isEmpty,
        reason: '删了「长期计划」那一块，只服务它的那趟取数也要删');

    await _drain(tester);
  });

  // ── ⑩ 取消（撤） ──

  testWidgets('取消安排：先确认；点「取消」一个请求都不发', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_open('t-full'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-cancel-t-full')));
    await tester.pumpAndSettle();

    expect(find.text('取消这条安排？'), findsOneWidget);
    expect(find.textContaining('撤掉这条，再跟她说一句新的'), findsOneWidget,
        reason: '"想改就走撤 + 重提"这条要对齐她的提示词');
    expect(api.posts, isEmpty, reason: '框还开着，一个请求都不该发');

    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(api.posts, isEmpty);
    expect(_item('t-full'), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('取消安排：确认后发 timer-cancel{timerId}，那一条跟着投影消失', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(_open('t-full'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-cancel-t-full')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '取消安排'));
    await tester.pump();
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(api.posts.length, 1);
    expect(api.posts.single.path, '/api/commands/timer-cancel');
    expect(api.posts.single.body, {'timerId': 't-full'});
    expect(_item('t-full'), findsNothing);
    expect(_item('t-bare'), findsOneWidget, reason: '别的一条都不许被牵连');
    expect(find.textContaining('已取消 t-full'), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('取消失败：原因留在清单上（不是死路）', (tester) async {
    final api = _FakeApi(_routes());
    api.failPost['/api/commands/timer-cancel'] =
        const ApiError(404, '定时器 t-full 不在投影里（可能已触发或已取消）');
    await _pump(tester, api);

    await tester.tap(_open('t-full'));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-cancel-t-full')));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '取消安排'));
    await tester.pump();
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(find.textContaining('取消 t-full 失败'), findsOneWidget);
    expect(_item('t-full'), findsOneWidget);
    await _drain(tester);
  });

  // ── ⑪ 新建安排：两条路 ──

  testWidgets('新建安排 · 交给她建：一句话发出去，回执只说"话送到了"', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    expect(find.textContaining('一般更建议交给她建'), findsOneWidget);
    expect(find.text('我直接建'), findsOneWidget);

    await tester.enterText(
        find.byKey(const ValueKey('schedule-field-brief')), '下周一早上九点提醒我看周计划');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(api.posts.single.path, '/api/commands/wake');
    expect(api.posts.single.body['note'], '请帮我排一条安排：下周一早上九点提醒我看周计划');
    expect(find.textContaining('已经跟她说了一句'), findsOneWidget);
    expect(find.textContaining('已经排上了'), findsNothing, reason: '她还没排，界面不许替她说排好了');
    expect(find.text('05'), findsWidgets, reason: '清单没多也没少');

    await _drain(tester);
  });

  testWidgets('⑧ 新建卡两层：常显只有"什么时候 + 要做什么"，其余在「更多选项」里', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我直接建'));
    await tester.pumpAndSettle();

    // 第一层：三格"什么时候" + 一格"要做什么"
    for (final id in ['date', 'clock', 'repeat', 'what']) {
      expect(find.byKey(ValueKey('schedule-field-$id')), findsOneWidget, reason: '第一层缺：$id');
    }
    // 第二层默认收起（用户批注"四行输入太散"）
    for (final id in ['title', 'why', 'dur', 'cat', 'action', 'sid']) {
      expect(find.byKey(ValueKey('schedule-field-$id')), findsNothing, reason: '$id 该收在"更多选项"里');
    }
    expect(find.textContaining('更多选项'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('schedule-more')));
    await tester.pumpAndSettle();
    for (final id in ['title', 'why', 'dur', 'cat', 'action', 'sid']) {
      expect(find.byKey(ValueKey('schedule-field-$id')), findsOneWidget, reason: '展开后缺：$id');
    }
    // 去技术腔的默认值/文案（用户批注"默认值说明像开发者备注"）
    expect(find.text('不分类'), findsOneWidget, reason: '分类的空选项是人话');
    expect(find.text('到点提醒我'), findsWidgets, reason: '到点后的默认值写在控件里（人这一侧的词）');
    expect(find.text('不用告诉谁'), findsWidgets, reason: '"到哪儿说"的空选项是人话');
    expect(find.textContaining('不填就用"要做什么"那句'), findsOneWidget);
    expect(find.textContaining('建好之后它就是一条真安排：到点她会看见你写的这句。'), findsOneWidget);
    expect(find.textContaining('timer/set'), findsNothing, reason: '卡片里不再出现事件名这类术语');

    await _drain(tester);
  });

  testWidgets('新建安排 · 直接建：七格都带上（at 带时区偏移），回执说"已经排上了"', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我直接建'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const ValueKey('schedule-field-date')), '明天');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-clock')), '09:30');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-what')), '看一眼汇报材料');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-more')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('schedule-field-title')), '交材料');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-why')), '周三要交');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-dur')), '45');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-field-cat')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('工作/学习').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('schedule-field-action')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('到点提醒我').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('schedule-field-sid')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('弥亚庄园').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    for (var i = 0; i < 10; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(api.posts.single.path, '/api/commands/timer-set');
    final body = api.posts.single.body;
    expect(body['note'], '看一眼汇报材料');
    expect(body['why'], '周三要交');
    expect(body['title'], '交材料');
    expect(body['cat'], 'work');
    expect(body['dur'], 45);
    expect(body['action'], 'notify');
    expect(body['sid'], 'qq:group:G1');
    final at = '${body['at']}';
    expect(RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$').hasMatch(at), isTrue,
        reason: '时刻要带时区（TimerStore.set 的硬要求）：$at');
    // `DateTime.parse` 见到偏移会转 UTC，所以转回本地核对"明天 09:30"
    final parsed = DateTime.parse(at).toLocal();
    final want = scheduleNow().add(const Duration(days: 1));
    expect([parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute],
        [want.year, want.month, want.day, 9, 30]);

    expect(find.byKey(const ValueKey('schedule-built-receipt')), findsOneWidget);
    expect(find.textContaining('这条是你直接排的'), findsOneWidget);
    expect(find.text('06'), findsWidgets, reason: '重读投影之后计数卡跟着走（不是本地画的）');
    expect(_item('t-human'), findsOneWidget);

    await _drain(tester);
  });

  testWidgets('新建安排 · 直接建：日期/钟点/内容/时长不合法 ⇒ 一个请求都不发，卡里当场说清', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我直接建'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const ValueKey('schedule-field-date')), '下周某个时候');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-what')), '看一眼材料');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    expect(find.textContaining('「日期」看不懂'), findsOneWidget);
    expect(api.posts, isEmpty);

    await tester.enterText(find.byKey(const ValueKey('schedule-field-date')), '明天');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-clock')), '早上九点');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    expect(find.textContaining('「钟点」要写成 20:00'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('schedule-field-clock')), '09:00');
    await tester.tap(find.byKey(const ValueKey('schedule-more')));
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('schedule-field-dur')), '一会儿');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    expect(find.textContaining('「大概多久」填分钟数'), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('schedule-field-dur')), '30');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-what')), '');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    expect(find.textContaining('「要做什么」要填'), findsOneWidget);
    expect(api.posts, isEmpty, reason: '四档都拦在本地');
  });

  testWidgets('新建安排 · 直接建：已经过去的时刻 ⇒ 当场提醒会"马上"叫醒她一次', (tester) async {
    final api = _FakeApi(_routes());
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我直接建'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('schedule-field-date')), '今天');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-clock')), '00:01');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-what')), '看一眼材料');
    await tester.pump();

    expect(find.textContaining('这个时刻已经过去了'), findsOneWidget);
    await _drain(tester);
  });

  testWidgets('新建安排 · 交给她建：幂等键撞上 ⇒ 照聊天页那句话说明，不说"送到了"', (tester) async {
    final api = _FakeApi(_routes());
    api.wakeReply = <String, dynamic>{'ok': true, 'deduped': true};
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('schedule-field-brief')), '看周计划');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(
      find.descendant(
        of: find.byKey(const ValueKey('schedule-receipt')),
        matching: find.text(const ZhStrings().schedWakeDeduped),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('已经跟她说了一句'), findsNothing);
    expect(find.byKey(const ValueKey('schedule-receipt-chat')), findsNothing);
    await _drain(tester);
  });

  testWidgets('新建安排 · 直接建：服务端拒了 ⇒ 留在卡片里，理由照原样显示', (tester) async {
    final api = _FakeApi(_routes());
    api.failPost['/api/commands/timer-set'] =
        const ApiError(400, '这条安排没能排上：at 不是带时区的 ISO 8601：2026-10-20T09:00:00');
    await _pump(tester, api);

    await tester.tap(find.byKey(const ValueKey('schedule-propose')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('我直接建'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('schedule-field-date')), '明天');
    await tester.enterText(find.byKey(const ValueKey('schedule-field-what')), '看一眼材料');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('schedule-send')));
    await tester.pump();
    for (var i = 0; i < 8; i += 1) {
      await tester.pump(const Duration(milliseconds: 20));
    }

    expect(find.textContaining('这条安排没能排上'), findsOneWidget);
    expect(find.textContaining('带时区'), findsOneWidget, reason: '服务端的原因原样给人看');
    expect(find.byKey(const ValueKey('schedule-built-receipt')), findsNothing);
    expect(find.text('05'), findsWidgets, reason: '清单没多也没少');
    await _drain(tester);
  });

  // ── ⑫ 空态 / 读失败 ──

  testWidgets('空态：没有安排 ⇒ 引导条给路，计数卡是 00，且不摆空表', (tester) async {
    final api = _FakeApi(_routes(timers: <dynamic>[]));
    await _pump(tester, api);

    expect(find.textContaining('还没有排着的事。'), findsOneWidget);
    expect(find.text('安排只是一次机会——到点她会先确认还值不值得做，不值得就跳过。'), findsOneWidget);
    expect(find.text('00'), findsNWidgets(4), reason: '四张卡都是 0（待分享那张也如实是 00）');
    expect(find.byKey(const ValueKey('schedule-list')), findsNothing, reason: '空态不摆空表');
    expect(find.textContaining('周期条目没有具体时刻'), findsNothing);
    expect(_pageScrollables(), findsNothing, reason: '清单没挂 ⇒ 整页一个可滚块都没有');

    await _drain(tester);
  });

  testWidgets('读投影失败：给错误块 + 重试，不摆一份空清单冒充"没有安排"', (tester) async {
    final api = _FakeApi(_routes());
    api.failGet['/api/projection'] = const ApiError(500, '投影端点不可用');
    await _pump(tester, api);

    expect(find.textContaining('读不到日程'), findsOneWidget);
    expect(find.text('重试'), findsOneWidget);
    expect(find.text('安排清单'), findsNothing);
    expect(find.text('新建安排'), findsOneWidget, reason: '入口照旧在');
  });

  // ── ⑨ 时钟注入：不许由"跑测试那台机器的日历"决定结论 ──

  testWidgets('跨周不误画：注入"周日"跑 ⇒ 明天（下周一）那条不进本周、但仍在清单里', (tester) async {
    // 2026-10-18 是周日，它的"明天"是 10-19 周一 = **下一周**（周一~周日算一周）
    _fixToday(DateTime(2026, 10, 18, 9, 0));
    final api = _FakeApi(_routes(timers: [
      {
        'timerId': 't-sunday',
        'at': _iso(DateTime(2026, 10, 18, 20, 30)),
        'payload': {'title': '周日晚上那条'},
      },
      {
        'timerId': 't-next-monday',
        'at': _iso(DateTime(2026, 10, 19, 9, 0)),
        'payload': {'title': '下周一那条'},
      },
    ]));
    await _pump(tester, api);

    expect(_statValue(tester, '本周安排'), '01', reason: '本周（10-12~10-18）只有周日那一条');
    expect(_block('t-sunday'), findsOneWidget, reason: '周日那条照旧画在周历上');
    expect(_block('t-next-monday'), findsNothing, reason: '下周一不在这一周 ⇒ 一个块都不画（宁可少画）');
    expect(_item('t-next-monday'), findsOneWidget,
        reason: '清单不按周筛：「接下来要发生什么」照旧列它');
    expect(find.textContaining('画不出这一周的周期条目'), findsNothing,
        reason: '它没有 cron，只是"不在本周"，不该被说成"画不出"');

    await _drain(tester);
  });

  testWidgets('周日 / 周一双跑：同一份夹具、两种"今天" ⇒ 四张计数卡与画法逐项相同', (tester) async {
    Future<Map<String, String>> run(DateTime today) async {
      _fixToday(today);
      final api = _FakeApi(_routes());
      await _pump(tester, api);
      final out = <String, String>{
        '本周安排': _statValue(tester, '本周安排'),
        '等待触发': _statValue(tester, '等待触发'),
        'Agent 自主工作': _statValue(tester, 'Agent 自主工作'),
        '待分享想法': _statValue(tester, '待分享想法'),
        '画出来的块': [
          for (final id in ['t-full', 't-bare', 't-cron-at', 't-old'])
            _block(id).evaluate().length,
        ].join(','),
      };
      // 卸掉这一棵树：下一种"今天"要重新走 initState（weekStart 是在那儿算的）
      await tester.pumpWidget(const SizedBox());
      return out;
    }

    final sunday = await run(DateTime(2026, 10, 18, 10, 0));
    final monday = await run(DateTime(2026, 10, 19, 10, 0));

    expect(sunday, monday, reason: '读数与"今天是周几"无关——这一条就是 2026-10-18 那次红的根因');
    expect(sunday['本周安排'], '04', reason: '夹具按周锚定 ⇒ 四条都落在本周');
    expect(sunday['Agent 自主工作'], '01', reason: '只有 t-cron-at 是 self');
    expect(sunday['画出来的块'], '1,1,1,1', reason: '四条各一块（periodic 那条也只算它该出现的那天）');

    await _drain(tester);
  });

  // 静态闸门：注入只要漏一处就白搭（新增代码顺手写一句 `DateTime.now()`，上面那条用例也抓不到）
  test('静态闸门：页面里除了 seam 的默认值，一处真实时钟都不许有', () {
    final source = File('lib/pages/schedule_page.dart').readAsStringSync();
    final code = source.replaceAll(RegExp(r'//[^\n]*'), '');
    expect(
      RegExp(r'DateTime\.now\(\)').allMatches(code).length,
      0,
      reason: '页面逻辑一律走 scheduleNow()：真实时钟只许出现在 seam 的默认值那一行，'
          '否则"今天"注入不进去，用例的结论会跟着跑测试那台机器的日历漂',
    );
  });
}
