import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/pages/mood_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 情绪页第三个 tab「亲密」（2026-11-04 按设计稿重做）。
///
/// 契约见 `docs/intimacy-panel-api.md`，页面实现见 `lib/pages/mood_page.dart`。
/// 用例钉的是一屏一屏看得见的东西：
///   · **懒加载**：没点开这个 tab 之前不去打 `/api/intimacy`；
///   · **关闭态只剩说明 + 开关 + 上限**，一个读数 / line / causes / history 都不摆；
///   · **开启态**：四格（1 位小数）、后端 labels、level、updatedAt、phase、line；
///   · **afterglow 只认后端布尔**，satisfaction > 0 不画余韵；
///   · **estrus 只认后端布尔**，desire=100 / restraint=0 也不自己推；
///   · **labels 不被 maxLevel 二次封顶**；
///   · 少于 2 个 history 点不画走势；causes 为空只说“还没有新的变化”；
///   · 形状不对 / 404 落到错误态，不伪造 0；
///   · 设置面板保存后重新 GET，`configured != enabled` 说「等待生效」；
///   · 1350 / 760 / 520 三档不溢出；英文界面一个汉字都不露。
///
/// 相对时间的夹具都落在“整分 + 30 秒”上，避免差一两秒把「5 分钟前」抖成 4/6。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, dynamic> intimacy;
  Map<String, dynamic>? lastBody;
  String? lastConfirm;
  int intimacyReads = 0;
  int readStatus = 200;
  Duration readDelay = Duration.zero;
  bool applyOnPost = true;

  Map<String, dynamic> affectView() => <String, dynamic>{
    'enabled': true,
    'configured': true,
    'evaluatorEnabled': true,
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
    'renderLine': null,
    'history': <dynamic>[],
  };

  Map<String, dynamic> intimacyView({
    bool enabled = true,
    bool? configured,
    String maxLevel = 'obvious',
    String level = 'obvious',
    String phase = 'calm',
    bool estrus = false,
    bool afterglow = false,
    Map<String, String>? labels,
    String? line,
    String? renderLine,
    String causeLabel = '用户靠近',
    String otherCauseLabel = '隔了很久',
    List<dynamic>? causes,
    List<dynamic>? history,
    double intimacyValue = 62.4,
    double desire = 35.0,
    double satisfaction = 71.0,
    double restraint = 48.0,
  }) {
    final now = DateTime.now();
    return <String, dynamic>{
      'enabled': enabled,
      'configured': configured ?? enabled,
      'privateOnly': true,
      'maxLevel': maxLevel,
      'atMs': now.millisecondsSinceEpoch,
      // 5 分 30 秒前：相对时间落在「5 分钟前」中间
      'updatedAt': now
          .subtract(const Duration(minutes: 5, seconds: 30))
          .toUtc()
          .toIso8601String(),
      'intimacy': intimacyValue,
      'desire': desire,
      'satisfaction': satisfaction,
      'restraint': restraint,
      'level': level,
      'phase': phase,
      'estrus': estrus,
      'afterglow': afterglow,
      'labels':
          labels ??
          <String, String>{
            'intimacy': '明显',
            'desire': '明显',
            'satisfaction': '强烈',
            'restraint': '明显',
          },
      'line': line ?? '亲密：想靠近一点。',
      'renderLine': renderLine ?? (enabled ? '亲密：想靠近一点（明显）。' : null),
      'causes':
          causes ??
          <dynamic>[
            {
              'atMs': now
                  .subtract(const Duration(minutes: 3, seconds: 30))
                  .millisecondsSinceEpoch,
              'reasonCode': 'owner_close',
              'strength': 40,
              'label': causeLabel,
            },
            {
              'atMs': now
                  .subtract(const Duration(minutes: 42, seconds: 30))
                  .millisecondsSinceEpoch,
              'reasonCode': 'long_gap',
              'strength': 20,
              'label': otherCauseLabel,
            },
          ],
      'history':
          history ??
          <dynamic>[
            for (var i = 0; i < 6; i += 1)
              {
                'atMs': now
                    .subtract(Duration(minutes: 10 * (6 - i)))
                    .millisecondsSinceEpoch,
                'intimacy': 40.0 + i * 4,
                'desire': 28.0 + i * 3,
                'satisfaction': 55.0 + i,
                'restraint': 66.0 - i * 2,
              },
          ],
    };
  }

  /// POST 之后 `GET /api/intimacy` 该读到什么（`applyOnPost = false` = 回执要重启）
  Map<String, dynamic> apply(Map<String, dynamic> body) {
    final fields = body['fields'];
    if (fields is! Map) return intimacy;
    final next = Map<String, dynamic>.from(intimacy);
    if (fields['intimacy.enabled'] is bool) {
      final enabled = fields['intimacy.enabled'] as bool;
      next['enabled'] = applyOnPost ? enabled : intimacy['enabled'];
      next['configured'] = enabled;
      next['renderLine'] = (next['enabled'] == true) ? '亲密：想靠近一点（明显）。' : null;
    }
    if (fields['intimacy.maxLevel'] is String) {
      final level = fields['intimacy.maxLevel'] as String;
      if (applyOnPost) {
        next['maxLevel'] = level;
        // 上限就是“最多能到哪一档”：后端按新上限重新折一次，当前档位跟着走
        next['level'] = level;
      }
    }
    return next;
  }

  setUp(() async {
    HttpOverrides.global = null;
    intimacy = intimacyView();
    lastBody = null;
    lastConfirm = null;
    intimacyReads = 0;
    readStatus = 200;
    readDelay = Duration.zero;
    applyOnPost = true;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final response = request.response..headers.contentType = ContentType.json;
      if (request.uri.path == '/api/affect') {
        response.write(jsonEncode(affectView()));
      } else if (request.uri.path == '/api/intimacy') {
        intimacyReads += 1;
        if (readDelay > Duration.zero) {
          await Future<void>.delayed(readDelay);
        }
        if (readStatus != 200) {
          response.statusCode = readStatus;
          response.write(
            jsonEncode({
              'error': {'code': 'test', 'message': 'read failed'},
            }),
          );
        } else {
          response.write(jsonEncode(intimacy));
        }
      } else if (request.uri.path == '/api/commands/config-update') {
        final body =
            jsonDecode(await utf8.decoder.bind(request).join())
                as Map<String, dynamic>;
        lastBody = body;
        lastConfirm = request.headers.value('x-confirm');
        intimacy = apply(body);
        response.write(
          jsonEncode({'ok': true, 'requiresRestart': !applyOnPost}),
        );
      } else if (request.uri.path == '/api/stickers') {
        response.write(
          jsonEncode(<String, dynamic>{
            'items': [],
            'counts': {},
            'settings': {},
            'tags': {},
          }),
        );
      } else {
        response.statusCode = 404;
        response.write(
          jsonEncode({
            'error': {'message': 'not found'},
          }),
        );
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
  });

  Future<void> pumpUntil(
    WidgetTester tester,
    Finder target, {
    int rounds = 160,
  }) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  Future<void> pumpPage(
    WidgetTester tester,
    AppStrings? strings, {
    Size size = const Size(1350, 900),
    Brightness brightness = Brightness.light,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: brightness == Brightness.dark
            ? IrmiaTheme.dark()
            : IrmiaTheme.light(),
        builder: strings == null
            ? null
            : (context, child) => IrmiaStrings(
                strings: strings,
                child: child ?? const SizedBox.shrink(),
              ),
        home: Scaffold(
          body: MediaQuery(
            data: MediaQueryData(size: size, disableAnimations: true),
            child: MoodPage(state: state),
          ),
        ),
      ),
    );
    await pumpUntil(tester, find.byKey(const ValueKey('mood-header')));
  }

  Future<void> openIntimacy(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('mood-tab-2')));
    await tester.pump();
  }

  /// 切回情绪再点回来，触发一次静默重取，让夹具改动落到屏幕上。
  Future<void> reopenIntimacy(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('mood-tab-0')));
    await tester.pump();
    await openIntimacy(tester);
  }

  Future<void> drainToast(WidgetTester tester) async {
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 300));
  }

  final readings = find.byKey(const ValueKey('intimacy-readings'));
  final closed = find.byKey(const ValueKey('intimacy-closed'));
  final phaseCard = find.byKey(const ValueKey('intimacy-phase-card'));
  final causes = find.byKey(const ValueKey('intimacy-causes'));
  final history = find.byKey(const ValueKey('intimacy-history'));
  final chart = find.byKey(const ValueKey('intimacy-chart'));
  final settings = find.byKey(const ValueKey('intimacy-settings'));
  final details = find.byKey(const ValueKey('intimacy-sheet'));

  Finder inPhase(Finder matching) =>
      find.descendant(of: phaseCard, matching: matching);
  Finder inCauses(Finder matching) =>
      find.descendant(of: causes, matching: matching);

  const s = ZhStrings();

  testWidgets('第三个 tab 才读 /api/intimacy：没点开之前一次都不打', (tester) async {
    await pumpPage(tester, null);
    expect(find.byKey(const ValueKey('mood-tab-2')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('mood-tab-2')),
        matching: find.text('亲密'),
      ),
      findsOneWidget,
    );
    expect(intimacyReads, 0, reason: '懒加载：老后端没有这条端点，别在情绪那一屏就打出错误');

    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(intimacyReads, greaterThanOrEqualTo(1));
    expect(find.text(s.intimacyTagline), findsOneWidget);
    expect(find.text(s.intimacyPageEyebrow), findsOneWidget);
  });

  testWidgets('页头：tab 靠右、情绪/亲密结构一致、标题用情绪页样式', (tester) async {
    await pumpPage(tester, null, size: const Size(1350, 900));
    // 情绪 tab：三个 tab 与刷新/设置都在页头右侧，不能被挤到中间
    expect(find.byKey(const ValueKey('mood-tab-2')), findsOneWidget);
    expect(find.byIcon(Icons.refresh_rounded), findsOneWidget);
    expect(find.byIcon(Icons.settings_rounded), findsOneWidget);
    final emotionTab = tester.getRect(find.byKey(const ValueKey('mood-tab-0')));
    expect(
      emotionTab.center.dx,
      greaterThan(1350 * 0.65),
      reason: '情绪页 tab 应靠右',
    );
    expect(tester.takeException(), isNull);

    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    final intimacyTab = tester.getRect(
      find.byKey(const ValueKey('mood-tab-0')),
    );
    expect(
      intimacyTab.center.dx,
      greaterThan(1350 * 0.65),
      reason: '亲密页 tab 应保持靠右',
    );
    expect(find.byIcon(Icons.settings_rounded), findsOneWidget);
    expect(tester.takeException(), isNull);

    // 标题跟情绪页同一档：应用字体、29 / w700、skin.heading，不再有衬线 / 双色。
    final heading = tester.widget<Text>(
      find.byKey(const ValueKey('intimacy-heading')),
    );
    expect(
      heading.data,
      '${s.intimacyHeadingLead}${s.intimacyHeadingAccent}${s.intimacyHeadingTail}',
    );
    expect(heading.style!.color, MoodPalette.heading);
    expect(heading.style!.fontSize, 29);
    expect(heading.style!.fontWeight, FontWeight.w700);
    expect(heading.style!.fontStyle, isNot(FontStyle.italic));
    final eyebrow = tester.widget<Text>(find.text(s.intimacyPageEyebrow));
    expect(eyebrow.style!.color, MoodPalette.primary.withValues(alpha: 0.8));

    // 窄窗：两个 tab 的页头都不溢出
    tester.view.physicalSize = const Size(520, 800);
    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.tap(find.byKey(const ValueKey('mood-tab-0')));
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('Light 背景与情绪页同一块，卡片回到情绪页 surface 风格', (tester) async {
    await pumpPage(tester, null, size: const Size(1350, 900));
    final emotionBackground = tester
        .widget<Container>(find.byKey(const ValueKey('mood-page-background')))
        .color;
    expect(emotionBackground, MoodPalette.shell);

    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    final intimacyBackground = tester
        .widget<Container>(find.byKey(const ValueKey('mood-page-background')))
        .color;
    expect(intimacyBackground, emotionBackground, reason: 'light 下两页应共用底色');

    // 亲密页不再有自己的背景层；卡片是情绪页同一种 surface。
    expect(find.byKey(const ValueKey('intimacy-backdrop')), findsNothing);
    final phaseCard = tester.widget<Container>(
      find.byKey(const ValueKey('intimacy-phase-card')),
    );
    final phaseDecoration = phaseCard.decoration as BoxDecoration;
    expect(phaseDecoration.color, MoodPalette.card);
    expect(phaseDecoration.gradient, isNull);
    expect(phaseDecoration.border, isNotNull);
    expect(phaseDecoration.boxShadow, isNotNull);

    final tile = tester.widget<Container>(
      find.byKey(const ValueKey('intimacy-metric-intimacy')),
    );
    final tileDecoration = tile.decoration as BoxDecoration;
    expect(tileDecoration.color, MoodPalette.chipBg);
    expect(tileDecoration.gradient, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('首次加载：显示骨架屏，不摆全 0', (tester) async {
    readDelay = const Duration(milliseconds: 250);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await tester.pump();
    expect(find.byKey(const ValueKey('intimacy-skeleton')), findsOneWidget);
    expect(find.text('0.0'), findsNothing);
    expect(readings, findsNothing);

    await pumpUntil(tester, readings);
    expect(find.byKey(const ValueKey('intimacy-skeleton')), findsNothing);
  });

  testWidgets('关闭态：只剩说明 + 开关 + 上限，一个读数都不显示', (tester) async {
    intimacy = intimacyView(enabled: false);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, closed);

    // 说明 + 开关 + 上限三样都在
    expect(find.text(s.intimacyClosedTitle), findsOneWidget);
    expect(find.text(s.intimacyClosedBody), findsOneWidget);
    expect(
      tester
          .widget<Switch>(find.byKey(const ValueKey('intimacy-switch')))
          .value,
      isFalse,
    );
    expect(find.byKey(const ValueKey('intimacy-level')), findsOneWidget);
    for (final key in const ['subtle', 'obvious', 'strong']) {
      expect(find.byKey(ValueKey('intimacy-level-$key')), findsOneWidget);
    }
    expect(find.text('含蓄'), findsOneWidget);
    expect(find.text('明显'), findsOneWidget);
    expect(find.text('强烈'), findsOneWidget);
    expect(find.byKey(const ValueKey('intimacy-off')), findsOneWidget);
    // 页头那张更新时间也如实说「未开启」，不摆假时间
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('mood-header')),
        matching: find.text('未开启'),
      ),
      findsOneWidget,
    );

    // 读数 / line / causes / history 一个都不许露出来
    expect(readings, findsNothing);
    expect(phaseCard, findsNothing);
    expect(history, findsNothing);
    expect(causes, findsNothing);
    expect(chart, findsNothing);
    expect(find.text(s.intimacyReadingsTitle), findsNothing);
    expect(find.text('情欲'), findsNothing);
    expect(find.text('满足'), findsNothing);
    expect(find.text('克制'), findsNothing);
    expect(find.text(s.intimacyCausesTitle), findsNothing);
    expect(find.text(s.intimacyHistoryTitle), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('开启态：四格读数 + labels + level + updatedAt + phase + causes + 走势', (
    tester,
  ) async {
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    expect(find.text(s.intimacyReadingsTitle), findsOneWidget);
    expect(find.text(s.intimacyReadingsCaption), findsOneWidget);
    // 四格：名字的顺序与数值（1 位小数）
    final names = tester
        .widgetList<Text>(
          find.descendant(of: readings, matching: find.byType(Text)),
        )
        .map((text) => text.data)
        .whereType<String>()
        .toList();
    const order = ['亲密', '情欲', '满足', '克制'];
    final positions = [for (final name in order) names.indexOf(name)];
    expect(positions, everyElement(greaterThanOrEqualTo(0)));
    for (var i = 0; i < positions.length - 1; i += 1) {
      expect(
        positions[i] < positions[i + 1],
        isTrue,
        reason: '四格顺序不对：$positions',
      );
    }
    for (final value in ['62.4', '35.0', '71.0', '48.0']) {
      expect(find.text(value), findsOneWidget, reason: '缺读数 $value');
    }
    // 后端 labels 原样显示：三格「明显」+ 一格「强烈」
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-metric-intimacy')),
        matching: find.text('明显'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-metric-satisfaction')),
        matching: find.text('强烈'),
      ),
      findsOneWidget,
    );
    // phase 卡：当前档位（backend level）与最近更新
    expect(inPhase(find.text(s.intimacyLevelMeta)), findsOneWidget);
    expect(inPhase(find.text('明显')), findsWidgets);
    expect(inPhase(find.text('5 分钟前')), findsWidgets);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('intimacy-phase-title')))
          .data,
      '平稳',
    );
    expect(find.byKey(const ValueKey('intimacy-phase')), findsOneWidget);
    expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);
    expect(find.byKey(const ValueKey('intimacy-afterglow')), findsNothing);
    // line 原样显示，最多两行
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('intimacy-line-text')))
          .maxLines,
      2,
    );
    expect(find.text('亲密：想靠近一点。'), findsOneWidget);

    // 最近变化：label + 相对时间 + 强度
    expect(inCauses(find.text('用户靠近')), findsOneWidget);
    expect(inCauses(find.text('3 分钟前')), findsOneWidget);
    expect(inCauses(find.text('隔了很久')), findsOneWidget);
    expect(inCauses(find.text('42 分钟前')), findsOneWidget);
    expect(inCauses(find.text('40 强度')), findsOneWidget);

    // 走势：6 个点 → 画折线
    expect(find.text(s.intimacyHistoryCount(6)), findsOneWidget);
    expect(chart, findsOneWidget);
    expect(find.text(s.intimacyHistoryEmpty), findsNothing);
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('四格 labels 按后端原样显示：满足/克制不被 maxLevel 二次封顶', (tester) async {
    intimacy = intimacyView(
      maxLevel: 'subtle',
      level: 'subtle',
      labels: <String, String>{
        'intimacy': '平稳',
        'desire': '明显',
        'satisfaction': '强烈',
        'restraint': '强烈',
      },
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    // maxLevel=含蓄，也照样显示后端返回的「强烈」，页面不重算、不封顶
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-metric-satisfaction')),
        matching: find.text('强烈'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-metric-restraint')),
        matching: find.text('强烈'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-metric-intimacy')),
        matching: find.text('平稳'),
      ),
      findsOneWidget,
    );
    expect(inPhase(find.text('含蓄')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('afterglow：只有后端布尔为 true 才显示「余韵」，satisfaction>0 不算', (
    tester,
  ) async {
    intimacy = intimacyView(
      phase: 'warm',
      satisfaction: 76.2,
      afterglow: false,
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(find.byKey(const ValueKey('intimacy-afterglow')), findsNothing);

    intimacy = intimacyView(phase: 'warm', satisfaction: 76.2, afterglow: true);
    await reopenIntimacy(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('intimacy-afterglow')));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-afterglow')),
        matching: find.text('余韵'),
      ),
      findsOneWidget,
    );
    // 阶段仍是温热，不是发情
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('intimacy-phase-title')))
          .data,
      '温热',
    );
    expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('estrus：只认后端布尔，desire=100 / restraint=0 也不自己推发情', (tester) async {
    intimacy = intimacyView(
      phase: 'warm',
      desire: 100,
      restraint: 0,
      estrus: false,
      afterglow: false,
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);
    expect(find.byKey(const ValueKey('intimacy-phase')), findsOneWidget);

    intimacy = intimacyView(
      phase: 'estrus',
      desire: 100,
      restraint: 0,
      estrus: true,
    );
    await reopenIntimacy(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('intimacy-estrus')));
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('intimacy-phase-title')))
          .data,
      '发情',
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-estrus')),
        matching: find.textContaining('发情'),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('intimacy-phase')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('causes 为空：说「还没有新的变化」，不是错误；最多 5 条也守住', (tester) async {
    intimacy = intimacyView(causes: <dynamic>[]);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(find.text(s.intimacyCausesEmpty), findsOneWidget);
    expect(find.text(s.intimacyCausesEmptyHint), findsOneWidget);
    expect(find.byType(ErrorWidget), findsNothing);

    final now = DateTime.now();
    intimacy = intimacyView(
      causes: <dynamic>[
        for (var i = 0; i < 6; i += 1)
          {
            'atMs': now
                .subtract(Duration(minutes: 5 * (i + 1)))
                .millisecondsSinceEpoch,
            'reasonCode': 'cause_$i',
            'strength': 90 - i * 10,
            'label': '原因 $i',
          },
      ],
    );
    await reopenIntimacy(tester);
    await pumpUntil(tester, find.text('原因 0'));
    expect(find.text('原因 4'), findsOneWidget);
    expect(find.text('原因 5'), findsNothing, reason: 'causes 最多显示 5 条');
    expect(tester.takeException(), isNull);
  });

  testWidgets('history 少于 2 点：不画走势、不崩，只留一句空态', (tester) async {
    final now = DateTime.now();
    intimacy = intimacyView(
      history: <dynamic>[
        {
          'atMs': now
              .subtract(const Duration(minutes: 10))
              .millisecondsSinceEpoch,
          'intimacy': 55,
          'desire': 30,
          'satisfaction': 60,
          'restraint': 50,
        },
      ],
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(chart, findsNothing);
    expect(find.text(s.intimacyHistoryEmpty), findsOneWidget);

    intimacy = intimacyView(history: <dynamic>[]);
    await reopenIntimacy(tester);
    await pumpUntil(tester, find.text(s.intimacyHistoryCount(0)));
    expect(chart, findsNothing);
    expect(find.text(s.intimacyHistoryEmpty), findsOneWidget);
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('404：说「此版本暂不支持亲密面板」+ 重试；恢复后照常渲染', (tester) async {
    readStatus = 404;
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('intimacy-error')));
    expect(find.text(s.intimacyErrorUnsupportedTitle), findsOneWidget);
    expect(find.text(s.intimacyErrorUnsupportedBody), findsOneWidget);
    expect(readings, findsNothing);

    readStatus = 200;
    await tester.tap(find.byKey(const ValueKey('intimacy-error-retry')));
    await pumpUntil(tester, readings);
    expect(find.byKey(const ValueKey('intimacy-error')), findsNothing);
  });

  testWidgets('401：说「需要本地会话认证」+ 重试', (tester) async {
    readStatus = 401;
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('intimacy-error')));
    expect(find.text(s.intimacyErrorAuthTitle), findsOneWidget);
    expect(find.text(s.intimacyErrorAuthBody), findsOneWidget);
    expect(readings, findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('形状不对：落到「数据格式不对」，不伪造 0', (tester) async {
    intimacy = intimacyView()..remove('afterglow');
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('intimacy-error')));
    expect(find.text(s.intimacyErrorInvalidTitle), findsOneWidget);
    expect(find.text(s.intimacyErrorInvalidBody), findsOneWidget);
    expect(readings, findsNothing);
    expect(find.text('0.0'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('设置面板：保存时一次写 enabled + maxLevel，回读后才算生效', (tester) async {
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    await tester.tap(find.byKey(const ValueKey('mood-details')));
    await tester.pump();
    await pumpUntil(tester, settings);
    expect(
      tester
          .widget<Switch>(
            find.byKey(const ValueKey('intimacy-settings-switch')),
          )
          .value,
      isTrue,
    );
    expect(find.text(s.intimacySettingsTitle), findsOneWidget);
    expect(find.text(s.intimacyPrivateOnlyPill), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('intimacy-settings-switch')));
    await tester.tap(
      find.byKey(const ValueKey('intimacy-settings-level-strong')),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('intimacy-settings-save')));
    await pumpUntil(tester, closed);

    expect(lastBody, {
      'fields': {'intimacy.enabled': false, 'intimacy.maxLevel': 'strong'},
    });
    expect(lastConfirm, 'config-update');
    expect(settings, findsNothing);
    expect(find.byKey(const ValueKey('intimacy-switch')), findsOneWidget);
    await drainToast(tester);
  });

  testWidgets('回执说「尚未生效」时吐司如实挂起，选中档位也不跳', (tester) async {
    applyOnPost = false;
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    await tester.tap(find.byKey(const ValueKey('mood-details')));
    await tester.pump();
    await pumpUntil(tester, settings);
    await tester.tap(
      find.byKey(const ValueKey('intimacy-settings-level-strong')),
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('intimacy-settings-save')));
    await pumpUntil(tester, find.text(s.intimacySettingsPending));

    // 回读仍是「明显」：phase 卡上的档位与设置面板的选中都停在旧值
    expect(inPhase(find.text('明显')), findsWidgets);
    expect(inPhase(find.text('强烈')), findsNothing);
    await drainToast(tester);
  });

  testWidgets('关闭态的开关：写 intimacy.enabled，回读后切到开启态', (tester) async {
    intimacy = intimacyView(enabled: false);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, closed);

    await tester.tap(find.byKey(const ValueKey('intimacy-switch')));
    await tester.pump();
    await pumpUntil(tester, readings);
    expect(lastBody, {
      'fields': {'intimacy.enabled': true},
    });
    expect(lastConfirm, 'config-update');
    // 回读后已切到开启态：关闭态那张卡（连同它的开关）消失，四格读数出现
    expect(find.byKey(const ValueKey('intimacy-switch')), findsNothing);
    expect(readings, findsOneWidget);
    await drainToast(tester);
  });

  testWidgets('configured != enabled：主屏与设置面板都说「等待生效」', (tester) async {
    intimacy = intimacyView(enabled: true, configured: false);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(find.text(s.intimacyPending), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('mood-details')));
    await tester.pump();
    await pumpUntil(tester, settings);
    expect(find.text(s.intimacyPending), findsWidgets);
  });

  testWidgets('phase 卡右上角 info：详情浮层给出四格、level、line 与 renderLine', (
    tester,
  ) async {
    intimacy = intimacyView(
      line: '亲密：想靠近一点，但还克制着。',
      renderLine: '亲密：想靠近一点（明显）。',
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    await tester.tap(find.byKey(const ValueKey('intimacy-details')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(details, findsOneWidget);
    expect(
      find.descendant(of: details, matching: find.text('亲密详情')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: details, matching: find.text('亲密：想靠近一点，但还克制着。')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: details, matching: find.text('亲密：想靠近一点（明显）。')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: details,
        matching: find.text(s.intimacyRenderLineLabel),
      ),
      findsOneWidget,
    );

    await tester.tap(find.byKey(const ValueKey('intimacy-details-close')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(details, findsNothing);
  });

  testWidgets('宽屏 phase 在左、读数在右；窄屏 phase 在上、读数在下，都不溢出', (tester) async {
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(phaseCard, findsOneWidget);
    expect(history, findsOneWidget);

    // 1350 宽：phase 在左、四读数在右；phase 宽度保持原设计（不因换边变窄）。
    final phaseRect = tester.getRect(phaseCard);
    final readingsRect = tester.getRect(readings);
    expect(phaseRect.left, lessThan(readingsRect.left));
    expect(phaseRect.right, lessThan(readingsRect.left));
    expect(phaseRect.width, greaterThan(500));
    // 下方两卡不交换：最近变化仍在左，情绪潮汐仍在右。
    expect(tester.getRect(causes).left, lessThan(tester.getRect(history).left));
    expect(tester.takeException(), isNull);

    tester.view.physicalSize = const Size(760, 900);
    await tester.pump();
    expect(readings, findsOneWidget);
    expect(phaseCard, findsOneWidget);
    expect(
      tester.getTopLeft(phaseCard).dy,
      lessThan(tester.getTopLeft(readings).dy),
      reason: '窄屏顺序应为 phase → 四读数',
    );
    expect(tester.takeException(), isNull);

    tester.view.physicalSize = const Size(520, 800);
    await tester.pump();
    expect(readings, findsOneWidget);
    expect(
      tester.getTopLeft(phaseCard).dy,
      lessThan(tester.getTopLeft(readings).dy),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('窄窗下的关闭态 / 设置面板：可滚动、不溢出', (tester) async {
    intimacy = intimacyView(enabled: false);
    await pumpPage(tester, null, size: const Size(520, 800));
    await openIntimacy(tester);
    await pumpUntil(tester, closed);
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const ValueKey('mood-details')));
    await tester.pump();
    await pumpUntil(tester, settings);
    expect(
      find.byKey(const ValueKey('intimacy-settings-save')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);

    await tester.tap(find.byKey(const ValueKey('intimacy-settings-cancel')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(settings, findsNothing);
  });

  testWidgets('英文：亲密那一屏的字全来自 AppStrings（一个汉字都不露）', (tester) async {
    intimacy = intimacyView(
      labels: <String, String>{
        'intimacy': 'Obvious',
        'desire': 'Obvious',
        'satisfaction': 'Strong',
        'restraint': 'Obvious',
      },
      line: 'Closeness: she wants to come nearer.',
      renderLine: 'Closeness: wants to come nearer (obvious).',
      causeLabel: 'owner leaned in',
      otherCauseLabel: 'long silence',
    );
    await pumpPage(tester, const EnStrings());
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    expect(find.text(const EnStrings().intimacyReadingsTitle), findsOneWidget);
    expect(find.text(const EnStrings().intimacyPhaseCardTitle), findsOneWidget);
    expect(find.text(const EnStrings().intimacyCausesTitle), findsOneWidget);
    expect(find.text(const EnStrings().intimacyHistoryTitle), findsOneWidget);
    expect(find.text(const EnStrings().intimacyTagline), findsOneWidget);
    expect(find.text('Obvious'), findsWidgets);
    expect(find.text('owner leaned in'), findsOneWidget);

    final hasCjk = RegExp(r'[\u4e00-\u9fff]');
    final leaked = tester
        .widgetList<Text>(find.byType(Text))
        .map((text) => text.data)
        .whereType<String>()
        .where(hasCjk.hasMatch)
        .toList();
    expect(leaked, isEmpty, reason: '英文界面里露了中文：$leaked');
  });

  testWidgets('深色主题跟情绪页共用底色与卡片 surface', (tester) async {
    await pumpPage(tester, null, brightness: Brightness.dark);
    final emotionBackground = tester
        .widget<Container>(find.byKey(const ValueKey('mood-page-background')))
        .color;
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    final context = tester.element(find.byKey(const ValueKey('mood-header')));
    final scheme = Theme.of(context).colorScheme;
    final intimacyBackground = tester
        .widget<Container>(find.byKey(const ValueKey('mood-page-background')))
        .color;
    expect(intimacyBackground, emotionBackground);
    expect(intimacyBackground, scheme.surface);
    expect(find.byKey(const ValueKey('intimacy-backdrop')), findsNothing);

    final phaseCard = tester.widget<Container>(
      find.byKey(const ValueKey('intimacy-phase-card')),
    );
    final phaseDecoration = phaseCard.decoration as BoxDecoration;
    expect(phaseDecoration.color, scheme.surfaceContainer);
    expect(phaseDecoration.gradient, isNull);
    expect(phaseDecoration.border, isNotNull);
    expect(phaseDecoration.boxShadow, isNotNull);
    expect(tester.takeException(), isNull);
  });
}
