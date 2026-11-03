import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/pages/mood_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 情绪页（2026-10-31 设计稿重做）的页面级用例：
///   · 四块卡照实渲染（状态词、stat pill、六维、轨迹、影响）；
///   · 点影响打开右侧详情浮层；
///   · 轨迹没有足够记录时是空态，不画假线；
///   · 关闭 / 开启但无评价两种空态说各自的话；
///   · 接口失败只有一处错误 + 重试；
///   · 右上角开关走 `/api/commands/config-update`（带 `X-Confirm`）。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, dynamic> view;
  Map<String, dynamic>? lastBody;
  String? lastConfirm;
  bool failRead = false;
  bool applyOnPost = true;
  int affectReads = 0;

  Map<String, dynamic> emptyView({bool enabled = true, bool? evaluatorEnabled}) => <String, dynamic>{
        'enabled': enabled,
        'configured': enabled,
        'evaluatorEnabled': evaluatorEnabled ?? enabled,
        'atMs': null,
        'updatedAt': null,
        'emotions': <String, double>{
          'joy': 0,
          'distress': 0,
          'concern': 0,
          'irritation': 0,
          'warmth': 0,
          'shyness': 0,
        },
        'mood': <String, double>{'valence': 0.2, 'arousal': 0.35},
        'causes': <dynamic>[],
        'neutral': true,
        'renderLine': enabled ? '情绪：平稳。' : null,
        'history': <dynamic>[],
      };

  Map<String, dynamic> activeView() {
    final now = DateTime.now();
    final day = DateTime(now.year, now.month, now.day);
    return <String, dynamic>{
      'enabled': true,
      'configured': true,
      'evaluatorEnabled': true,
      'atMs': now.millisecondsSinceEpoch,
      'updatedAt': now.subtract(const Duration(minutes: 85)).toUtc().toIso8601String(),
      'emotions': <String, double>{
        'concern': 0.72,
        'warmth': 0.61,
        'shyness': 0.43,
        'joy': 0.36,
        'distress': 0.12,
        'irritation': 0.08,
      },
      'mood': <String, double>{'valence': 0.18, 'arousal': 0.38},
      'causes': <dynamic>[
        {
          'reasonCode': 'owner_success',
          'dominantEmotion': 'concern',
          'strength': 0.24,
          'evaluatedAtMs': now.subtract(const Duration(minutes: 40)).millisecondsSinceEpoch,
        },
        {
          'reasonCode': 'task_success',
          'dominantEmotion': 'joy',
          'strength': 0.12,
          'evaluatedAtMs': now.subtract(const Duration(minutes: 132)).millisecondsSinceEpoch,
        },
        {
          'reasonCode': 'friendly_contact',
          'dominantEmotion': 'warmth',
          'strength': 0.18,
          'evaluatedAtMs': now.subtract(const Duration(minutes: 314)).millisecondsSinceEpoch,
        },
      ],
      'neutral': false,
      'renderLine': '情绪：平静，带一点牵挂。',
      'history': <dynamic>[
        for (var i = 0; i < 9; i += 1)
          {
            'atMs': day.add(Duration(hours: 8 + i)).millisecondsSinceEpoch,
            'valence': const [0.10, 0.12, 0.09, 0.15, 0.13, 0.21, 0.17, 0.18, 0.18][i],
            'arousal': const [0.30, 0.34, 0.31, 0.36, 0.35, 0.41, 0.38, 0.38, 0.38][i],
            'dominant': 'concern',
            'reasonCode': i.isEven ? 'owner_success' : 'friendly_contact',
            'strength': i.isEven ? 0.24 : 0.18,
          },
      ],
    };
  }

  setUp(() async {
    HttpOverrides.global = null;
    view = activeView();
    lastBody = null;
    lastConfirm = null;
    failRead = false;
    applyOnPost = true;
    affectReads = 0;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final response = request.response..headers.contentType = ContentType.json;
      if (request.uri.path == '/api/affect') {
        affectReads += 1;
        if (failRead) {
          response.statusCode = 500;
          response.write(jsonEncode({'error': {'code': 'test', 'message': 'read failed'}}));
        } else {
          response.write(jsonEncode(view));
        }
      } else if (request.uri.path == '/api/commands/config-update') {
        lastBody = jsonDecode(await utf8.decoder.bind(request).join()) as Map<String, dynamic>;
        lastConfirm = request.headers.value('x-confirm');
        final next = (lastBody!['fields'] as Map)['affect.enabled'] == true;
        view = emptyView(enabled: applyOnPost ? next : false);
        response.write(jsonEncode({'ok': true, 'requiresRestart': !applyOnPost}));
      } else if (request.uri.path == '/api/stickers') {
        response.write(jsonEncode(<String, dynamic>{'items': [], 'counts': {}, 'settings': {}, 'tags': {}}));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': 'not found'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
  });

  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 160}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  Future<void> pumpPage(WidgetTester tester, Finder ready) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(
        body: MediaQuery(
          data: const MediaQueryData(size: Size(1280, 900), disableAnimations: true),
          child: MoodPage(state: state),
        ),
      ),
    ));
    await pumpUntil(tester, ready);
  }

  /// 等真实 HTTP 请求把 `affectReads` 推过 [target]（静默重取不靠界面状态判定）
  Future<void> waitForReads(WidgetTester tester, int target) async {
    for (var i = 0; i < 150 && affectReads < target; i += 1) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    expect(affectReads, greaterThanOrEqualTo(target), reason: '等待 /api/affect 重取超时');
  }

  Future<void> drainToast(WidgetTester tester) async {
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('有数据：四块卡与读数照实渲染，六维顺序与百分比都对', (tester) async {
    await pumpPage(tester, find.text('心境倾向'));

    // hero
    expect(find.text('当前心境'), findsOneWidget);
    expect(find.text('状态稳定'), findsOneWidget);
    expect(find.text('平静，带一点牵挂。'), findsOneWidget);
    final hero = find.byKey(const ValueKey('mood-hero'));
    expect(find.descendant(of: hero, matching: find.text('+0.18')), findsOneWidget);
    expect(find.descendant(of: hero, matching: find.text('38%')), findsOneWidget);
    expect(find.text('最近的变化来自：用户有了进展'), findsOneWidget);
    expect(find.text('随时间自然平复'), findsOneWidget);

    // 开关与更新时间已移到页头右上角：hero 只剩卡名，页头里两样都在
    final header = find.byKey(const ValueKey('mood-header'));
    expect(find.descendant(of: header, matching: find.byType(Switch)), findsOneWidget);
    expect(find.descendant(of: header, matching: find.text('情绪系统')), findsOneWidget);
    expect(find.descendant(of: header, matching: find.text('85 分钟前')), findsOneWidget);
    expect(find.descendant(of: hero, matching: find.byType(Switch)), findsNothing,
        reason: '开关不该还在 hero 卡里');
    expect(find.descendant(of: hero, matching: find.textContaining('分钟前')), findsNothing,
        reason: '更新时间不该还在 hero 卡里');

    // 六维：顺序用渲染顺序钉住（关切 → 温暖 → 害羞 → 喜悦 → 低落 → 烦躁）
    final emotions = find.byKey(const ValueKey('mood-emotions'));
    final names = tester
        .widgetList<Text>(find.descendant(of: emotions, matching: find.byType(Text)))
        .map((text) => text.data)
        .whereType<String>()
        .toList();
    final order = ['关切', '温暖', '害羞', '喜悦', '低落', '烦躁'];
    final positions = [for (final name in order) names.indexOf(name)];
    expect(positions, everyElement(greaterThanOrEqualTo(0)));
    for (var i = 0; i < positions.length - 1; i += 1) {
      expect(positions[i] < positions[i + 1], isTrue, reason: '六维顺序不对：$positions');
    }
    for (final percent in ['72%', '61%', '43%', '36%', '12%', '8%']) {
      expect(find.descendant(of: emotions, matching: find.text(percent)), findsOneWidget);
    }

    // 轨迹：当前值、涨跌、折线、整点标签
    final timeline = find.byKey(const ValueKey('mood-timeline'));
    expect(find.descendant(of: timeline, matching: find.text('+0.18')), findsOneWidget);
    expect(find.descendant(of: timeline, matching: find.text('↑ +0.08')), findsOneWidget);
    expect(find.byKey(const ValueKey('mood-chart')), findsOneWidget);
    expect(find.text('08:00'), findsOneWidget);
    expect(find.text('16:00'), findsOneWidget);

    // 影响：最多 3 条，右侧「情绪 +强度」
    expect(find.text('用户有了进展'), findsOneWidget);
    expect(find.text('关切 +0.24'), findsOneWidget);
    expect(find.text('刚完成的任务'), findsOneWidget);
    expect(find.text('喜悦 +0.12'), findsOneWidget);
    expect(find.text('最近的友善交流'), findsOneWidget);
    expect(find.text('温暖 +0.18'), findsOneWidget);
  });

  testWidgets('六维行序跟后端键序走：换序、换键（shyness）都照后端渲染', (tester) async {
    view = activeView()
      ..['emotions'] = <String, double>{
        'shyness': 0.43,
        'joy': 0.36,
        'irritation': 0.08,
        'concern': 0.72,
        'distress': 0.12,
        'warmth': 0.61,
      };
    await pumpPage(tester, find.text('心境倾向'));

    final emotions = find.byKey(const ValueKey('mood-emotions'));
    final names = tester
        .widgetList<Text>(find.descendant(of: emotions, matching: find.byType(Text)))
        .map((text) => text.data)
        .whereType<String>()
        .toList();
    const order = ['害羞', '喜悦', '烦躁', '关切', '低落', '温暖'];
    final positions = [for (final name in order) names.indexOf(name)];
    expect(positions, everyElement(greaterThanOrEqualTo(0)), reason: '后端键序没被照搬：$names');
    for (var i = 0; i < positions.length - 1; i += 1) {
      expect(positions[i] < positions[i + 1], isTrue, reason: '六维顺序没跟后端走：$positions');
    }
    expect(find.text('好奇'), findsNothing, reason: '旧维度名不该再出现');
    expect(find.descendant(of: emotions, matching: find.text('43%')), findsOneWidget);
  });

  testWidgets('点最近的影响：右侧详情浮层给出数值与设计原则', (tester) async {
    await pumpPage(tester, find.text('用户有了进展'));
    await tester.tap(find.text('用户有了进展'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('状态详情'), findsOneWidget);
    expect(find.text('Valence / 正负倾向'), findsOneWidget);
    expect(find.text('Arousal / 活跃程度'), findsOneWidget);
    expect(find.text('时间半衰期'), findsOneWidget);
    expect(find.text('当前主要情绪 · PRIMARY'), findsOneWidget);
    expect(find.text('设计原则'), findsOneWidget);
    expect(find.text('仅供展示'), findsOneWidget);
    expect(find.text('0.38'), findsWidgets);

    // 底部只读核对区：请求里的情绪行 + 状态时刻（本地时间 + 相对时间）
    expect(find.text('请求侧 · REQUEST'), findsOneWidget);
    expect(find.text('请求里的情绪行'), findsOneWidget);
    expect(find.text('情绪：平静，带一点牵挂。'), findsOneWidget);
    expect(find.text('状态时刻'), findsOneWidget);
    final at = DateTime.fromMillisecondsSinceEpoch(view['atMs'] as int);
    String two(int value) => value.toString().padLeft(2, '0');
    final stamp = '${at.year}-${two(at.month)}-${two(at.day)} ${two(at.hour)}:${two(at.minute)}';
    expect(find.textContaining(stamp), findsOneWidget);
    expect(find.textContaining('刚刚更新'), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('状态详情'), findsNothing);
  });

  testWidgets('详情浮层：renderLine / atMs 为空时，两条空态如实显示', (tester) async {
    view = activeView()
      ..['renderLine'] = null
      ..['atMs'] = null;
    await pumpPage(tester, find.text('用户有了进展'));
    await tester.tap(find.text('用户有了进展'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('请求里的情绪行'), findsOneWidget);
    expect(find.text('未注入（关闭态 / 评价器没开）'), findsOneWidget);
    expect(find.text('状态时刻'), findsOneWidget);
    expect(find.text('还没有评价'), findsOneWidget);
    expect(find.text('情绪：平静，带一点牵挂。'), findsNothing);
  });

  test('今天轨迹：52 秒内两拍合并成后一条，不再出现竖刺', () {
    final merged = collapseNearbyHistory(<Map<String, int>>[
      {'atMs': 0},
      {'atMs': 900000},
      {'atMs': 952000},
    ], (point) => point['atMs']!);
    expect(merged.length, 2);
    expect(merged.last['atMs'], 952000);
  });
  testWidgets('回归：今天恰好 2 个历史点：索引不越界，轨迹照常画', (tester) async {
    final now = DateTime.now();
    final day = DateTime(now.year, now.month, now.day);
    view = activeView()
      ..['history'] = <dynamic>[
        {
          'atMs': day.add(const Duration(hours: 14)).millisecondsSinceEpoch,
          'valence': 0.10,
          'arousal': 0.36,
          'dominant': 'concern',
          'reasonCode': 'friendly_contact',
          'strength': 0.18,
        },
        {
          'atMs': day.add(const Duration(hours: 16)).millisecondsSinceEpoch,
          'valence': 0.18,
          'arousal': 0.38,
          'dominant': 'concern',
          'reasonCode': 'owner_success',
          'strength': 0.24,
        },
      ];
    await pumpPage(tester, find.text('心境倾向'));
    expect(find.byKey(const ValueKey('mood-chart')), findsOneWidget);
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('causes 为空但 history 非空：最近的影响用轨迹最后 5 点兜底', (tester) async {
    final now = DateTime.now();
    final day = DateTime(now.year, now.month, now.day);
    view = activeView()
      ..['causes'] = <dynamic>[]
      ..['history'] = <dynamic>[
        for (final (hour, reason, emotion, strength) in [
          (10, 'friendly_contact', 'warmth', 0.18),
          (12, 'task_success', 'joy', 0.12),
          (14, 'owner_success', 'concern', 0.24),
        ])
          {
            'atMs': day.add(Duration(hours: hour)).millisecondsSinceEpoch,
            'valence': 0.10 + hour / 100,
            'arousal': 0.36,
            'dominant': emotion,
            'reasonCode': reason,
            'strength': strength,
          },
      ];
    await pumpPage(tester, find.text('心境倾向'));

    final factors = find.byKey(const ValueKey('mood-factors'));
    expect(find.descendant(of: factors, matching: find.text('用户有了进展')), findsOneWidget);
    expect(find.descendant(of: factors, matching: find.text('刚完成的任务')), findsOneWidget);
    expect(find.descendant(of: factors, matching: find.text('最近的友善交流')), findsOneWidget);
    expect(find.descendant(of: factors, matching: find.text('关切 +0.24')), findsOneWidget);
    expect(find.descendant(of: factors, matching: find.text('喜悦 +0.12')), findsOneWidget);
    expect(find.descendant(of: factors, matching: find.text('温暖 +0.18')), findsOneWidget);
    expect(find.descendant(of: factors, matching: find.text('还没有新的情绪影响。')), findsNothing);
    // hero 底栏与影响列表同一个兜底口径
    expect(find.text('最近的变化来自：用户有了进展'), findsOneWidget);
  });

  testWidgets('没有足够历史点：今天与近 7 天都只说空态，不画线', (tester) async {
    view = activeView()..['history'] = <dynamic>[];
    await pumpPage(tester, find.text('心境倾向'));
    final timeline = find.byKey(const ValueKey('mood-timeline'));
    expect(find.descendant(of: timeline, matching: find.text('今天还没有足够的记录')), findsOneWidget);
    expect(find.byKey(const ValueKey('mood-chart')), findsNothing);

    await tester.tap(find.text('近 7 天'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.descendant(of: timeline, matching: find.text('近 7 天还没有足够的记录')), findsOneWidget);
    expect(find.byKey(const ValueKey('mood-chart')), findsNothing);
  });

  testWidgets('近 7 天：每天取最后一点，x 轴是最近 7 天的星期', (tester) async {
    final now = DateTime.now();
    final day = DateTime(now.year, now.month, now.day);
    view = activeView()
      ..['history'] = <dynamic>[
        for (var i = 0; i < 7; i += 1)
          {
            'atMs': day.subtract(Duration(days: 6 - i)).add(const Duration(hours: 12)).millisecondsSinceEpoch,
            'valence': -0.2 + i * 0.1,
            'arousal': 0.4,
            'dominant': 'concern',
          },
      ];
    await pumpPage(tester, find.text('心境倾向'));
    await tester.tap(find.text('近 7 天'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const ValueKey('mood-chart')), findsOneWidget);

    // 周几的措辞与日程页共用同一组 getter（两处不各写一套）
    const s = ZhStrings();
    String weekdayOf(int weekday) => switch (weekday) {
          DateTime.monday => s.schedWeekdayMon,
          DateTime.tuesday => s.schedWeekdayTue,
          DateTime.wednesday => s.schedWeekdayWed,
          DateTime.thursday => s.schedWeekdayThu,
          DateTime.friday => s.schedWeekdayFri,
          DateTime.saturday => s.schedWeekdaySat,
          _ => s.schedWeekdaySun,
        };
    for (var i = 0; i < 7; i += 1) {
      expect(find.text(weekdayOf(day.subtract(Duration(days: 6 - i)).weekday)), findsOneWidget);
    }
  });

  testWidgets('关闭态：页头说「未开启」，hero 说清状态，其余卡是空态', (tester) async {
    view = emptyView(enabled: false);
    await pumpPage(tester, find.text('情绪系统现在是关着的。'));
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    final header = find.byKey(const ValueKey('mood-header'));
    expect(find.descendant(of: header, matching: find.text('未开启')), findsOneWidget);
    expect(find.descendant(of: header, matching: find.textContaining('分钟前')), findsNothing,
        reason: '关闭时不许显示假时间');
    expect(find.text('打开后她才会有一层当前情绪，会影响语气与表情包。'), findsOneWidget);
    expect(find.text('心境倾向'), findsNothing);
    expect(find.text('关切'), findsNothing);
    expect(find.text('今天还没有足够的记录'), findsOneWidget);
    expect(find.text('还没有新的情绪影响。'), findsOneWidget);
  });

  testWidgets('开启但无评价（评价器开着）：说「暂时没有新评价」，不伪造读数', (tester) async {
    view = emptyView(enabled: true, evaluatorEnabled: true);
    await pumpPage(tester, find.text(const ZhStrings().moodNoNewAppraisalTitle));
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
    final header = find.byKey(const ValueKey('mood-header'));
    expect(find.descendant(of: header, matching: find.text('未开启')), findsNothing);
    expect(find.descendant(of: header, matching: find.textContaining('分钟前')), findsNothing);
    expect(find.text(const ZhStrings().moodNoNewAppraisalBody), findsOneWidget);
    expect(find.text(const ZhStrings().moodEvaluatorOffTitle), findsNothing);
    expect(find.text('心境倾向'), findsNothing);
    expect(find.text('还没有可显示的情绪维度。'), findsOneWidget);
    expect(find.text('今天还没有足够的记录'), findsOneWidget);
    expect(find.text('还没有新的情绪影响。'), findsOneWidget);
    expect(find.byKey(const ValueKey('mood-chart')), findsNothing);
  });

  testWidgets('开启但无评价（评价器没开）：明说情绪不会更新，开关会一并打开', (tester) async {
    view = emptyView(enabled: true, evaluatorEnabled: false);
    await pumpPage(tester, find.text(const ZhStrings().moodEvaluatorOffTitle));
    expect(find.text(const ZhStrings().moodEvaluatorOffState), findsOneWidget);
    expect(find.text(const ZhStrings().moodEvaluatorOffBody), findsOneWidget);
    expect(find.textContaining('情绪不会更新'), findsOneWidget);
    expect(find.text(const ZhStrings().moodNoNewAppraisalTitle), findsNothing);
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);
  });

  testWidgets('接口失败：只有一处错误文案 + 重试，恢复后照常渲染', (tester) async {
    failRead = true;
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(
        body: MediaQuery(
          data: const MediaQueryData(size: Size(1280, 900), disableAnimations: true),
          child: MoodPage(state: state),
        ),
      ),
    ));
    await pumpUntil(tester, find.textContaining('情绪状态读取失败'));
    expect(find.text('重试'), findsOneWidget);
    expect(find.text('当前心境'), findsNothing);

    failRead = false;
    await tester.tap(find.text('重试'));
    await pumpUntil(tester, find.text('心境倾向'));
    expect(find.text('当前心境'), findsOneWidget);
    expect(find.textContaining('情绪状态读取失败'), findsNothing);
  });

  testWidgets('页头右上角开关：一次写 master + evaluator 两个键，回读后开关跟着变', (tester) async {
    view = emptyView(enabled: false);
    await pumpPage(tester, find.text('情绪系统现在是关着的。'));
    final header = find.byKey(const ValueKey('mood-header'));
    expect(find.descendant(of: header, matching: find.byType(Switch)), findsOneWidget);
    expect(find.descendant(of: header, matching: find.text('未开启')), findsOneWidget);
    await tester.tap(find.descendant(of: header, matching: find.byType(Switch)));
    await tester.pump();
    await pumpUntil(tester, find.text(const ZhStrings().moodNoNewAppraisalTitle));
    // 评价器是独立开关：只写 affect.enabled 的话全新安装永远不会产生情绪
    expect(lastBody, {
      'fields': {'affect.enabled': true, 'affect.evaluatorEnabled': true},
    });
    expect(lastConfirm, 'config-update');
    expect(tester.widget<Switch>(find.byType(Switch)).value, isTrue);

    // 再点一次关掉：两个键一起关，不留空转的评价器
    await tester.tap(find.byType(Switch));
    await tester.pump();
    await pumpUntil(tester, find.text('情绪系统现在是关着的。'));
    expect(lastBody, {
      'fields': {'affect.enabled': false, 'affect.evaluatorEnabled': false},
    });
    expect(tester.widget<Switch>(find.byType(Switch)).value, isFalse);
    expect(find.descendant(of: find.byKey(const ValueKey('mood-header')), matching: find.text('未开启')),
        findsOneWidget);
    await drainToast(tester);
  });

  testWidgets('configured 与 enabled 不一致：页头如实挂起提示；一致时不显示', (tester) async {
    view = activeView()..['configured'] = false; // 生效值来自覆盖：enabled=true 但配置里是 false
    await pumpPage(tester, find.text('心境倾向'));
    expect(find.byKey(const ValueKey('mood-pending')), findsOneWidget);
    expect(find.text(const ZhStrings().affectPending), findsOneWidget);
    expect(find.textContaining('环境变量'), findsOneWidget);
    expect(find.textContaining('尚未生效'), findsOneWidget);

    // 换成一致的状态重新挂一页：提示消失
    view = activeView(); // configured == enabled == true
    await tester.pumpWidget(const SizedBox.shrink());
    await pumpPage(tester, find.text('心境倾向'));
    expect(find.byKey(const ValueKey('mood-pending')), findsNothing);
    expect(find.text(const ZhStrings().affectPending), findsNothing);
  });

  testWidgets('定时静默重取：60 秒到点会再读 /api/affect，且不出现 loading', (tester) async {
    await pumpPage(tester, find.text('心境倾向'));
    final before = affectReads;
    await tester.pump(const Duration(seconds: 60));
    await waitForReads(tester, before + 1);
    expect(find.byType(CircularProgressIndicator), findsNothing, reason: '静默刷新不该显示 loading');
    expect(tester.takeException(), isNull);
  });

  testWidgets('页头刷新按钮：点一下静默重取', (tester) async {
    await pumpPage(tester, find.text('心境倾向'));
    final before = affectReads;
    await tester.tap(find.byKey(const ValueKey('mood-refresh')));
    await waitForReads(tester, before + 1);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('dispose 后定时器取消：不再发 /api/affect 请求', (tester) async {
    await pumpPage(tester, find.text('心境倾向'));
    await tester.pumpWidget(const SizedBox.shrink());
    // 等在飞请求（初始那条早已完成，这里只是保险）落地后再记基线
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
    final afterDispose = affectReads;
    await tester.pump(const Duration(minutes: 3));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 150)));
    await tester.pump();
    expect(affectReads, afterDispose, reason: 'dispose 之后 Timer.periodic 必须已经取消');
  });

  testWidgets('窄窗：页头控件换行不溢出，四块卡变单列', (tester) async {
    tester.view.physicalSize = const Size(760, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(
        body: MediaQuery(
          data: const MediaQueryData(size: Size(760, 900), disableAnimations: true),
          child: MoodPage(state: state),
        ),
      ),
    ));
    await pumpUntil(tester, find.text('心境倾向'));
    for (final title in ['当前心境', '情绪构成', '心境轨迹', '最近的影响']) {
      expect(find.text(title), findsOneWidget);
    }
    final header = find.byKey(const ValueKey('mood-header'));
    expect(find.descendant(of: header, matching: find.byType(Switch)), findsOneWidget);
    expect(find.descendant(of: header, matching: find.text('85 分钟前')), findsOneWidget);
    expect(tester.takeException(), isNull);

    // 再窄一档：页头右侧那组必须换行，不许溢出
    tester.view.physicalSize = const Size(520, 800);
    await tester.pump();
    expect(find.byType(Switch), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
