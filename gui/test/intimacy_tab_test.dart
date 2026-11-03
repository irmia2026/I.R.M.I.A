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

/// 情绪页第三个 tab「亲密」（2026-11-02，后端另一条线同时在做的 `GET /api/intimacy`）。
///
/// 这一屏的契约与三条硬规矩见 `lib/pages/mood_page.dart` 的文件头。用例钉的是：
///   · **懒加载**：没点开这个 tab 之前不去打 `/api/intimacy`（老后端没有这条端点）；
///   · **关闭态只剩说明 + 开关 + 上限**，一个读数都不摆（用户原话）；
///   · **开启态四格读数**（亲密/情欲/满足/克制）、level 与 updatedAt 都在；
///   · **history 只有 1 个点时不许画走势**（情绪页踩过 RangeError，这里再来一条）；
///   · **冷却 / 收住**两句人话；
///   · 开关写 `intimacy.enabled`、上限写 `intimacy.maxLevel`，都走 `config-update`；
///   · 齿轮里的 `line` 原文折叠 / 展开，与 `renderLine` 并排核对；
///   · 文案全走 `AppStrings`（英文那一屏里一个汉字都不许露出来）。
///
/// 相对时间的夹具都刻意落在"整分 + 30 秒"上：widget 用例里的 `clock.now()`
/// 是测试框架的假时钟（比 `DateTime.now()` 慢掉本用例已经跑过的真实耗时），
/// 差个一两秒不该让「N 分钟前」抖成 N±1。
void main() {
  late HttpServer server;
  late AppState state;
  late Map<String, dynamic> intimacy;
  Map<String, dynamic>? lastBody;
  String? lastConfirm;
  int posts = 0;
  int intimacyReads = 0;
  bool failRead = false;
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
    String? phase = 'calm',
    bool estrus = false,
    Map<String, String>? labels,
    int? cooldownUntilMs,
    int? stoppedAtMs,
    String? line,
    String causeLabel = '用户靠近',
    String otherCauseLabel = '隔了很久',
    List<dynamic>? causes,
    List<dynamic>? history,
  }) {
    final now = DateTime.now();
    return <String, dynamic>{
      'enabled': enabled,
      'configured': configured ?? enabled,
      'privateOnly': true,
      'maxLevel': maxLevel,
      'atMs': now.millisecondsSinceEpoch,
      // 5 分 30 秒前：相对时间落在「5 分钟前」中间，差一两秒也不会跳档
      'updatedAt': now.subtract(const Duration(minutes: 5, seconds: 30)).toUtc().toIso8601String(),
      'intimacy': 62.4,
      'desire': 35.0,
      'satisfaction': 71.0,
      'restraint': 48.0,
      'level': level,
      'phase': phase,
      'estrus': estrus,
      'labels': labels,
      'line': line ?? '亲密：想靠近一点。',
      'renderLine': enabled ? '亲密：想靠近一点（明显）。' : null,
      'causes': causes ??
          <dynamic>[
            {
              'atMs': now.subtract(const Duration(minutes: 3, seconds: 30)).millisecondsSinceEpoch,
              'reasonCode': 'owner_close',
              'strength': 0.4,
              'label': causeLabel,
            },
            {
              'atMs': now.subtract(const Duration(minutes: 42, seconds: 30)).millisecondsSinceEpoch,
              'reasonCode': 'long_gap',
              'strength': 0.2,
              'label': otherCauseLabel,
            },
          ],
      'history': history ??
          <dynamic>[
            for (var i = 0; i < 6; i += 1)
              {
                'atMs': now.subtract(Duration(minutes: 10 * (6 - i))).millisecondsSinceEpoch,
                'intimacy': 40.0 + i * 4,
                'desire': 28.0 + i * 3,
                'satisfaction': 55.0 + i,
                'restraint': 66.0 - i * 2,
              },
          ],
      'cooldownUntilMs': cooldownUntilMs,
      'stoppedAtMs': stoppedAtMs,
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
        // 上限就是"最多能到哪一档"：后端按新上限重新折一次，当前档位跟着走
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
    posts = 0;
    intimacyReads = 0;
    failRead = false;
    applyOnPost = true;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      final response = request.response..headers.contentType = ContentType.json;
      if (request.uri.path == '/api/affect') {
        response.write(jsonEncode(affectView()));
      } else if (request.uri.path == '/api/intimacy') {
        intimacyReads += 1;
        if (failRead) {
          response.statusCode = 500;
          response.write(jsonEncode({
            'error': {'code': 'test', 'message': 'read failed'},
          }));
        } else {
          response.write(jsonEncode(intimacy));
        }
      } else if (request.uri.path == '/api/commands/config-update') {
        final body = jsonDecode(await utf8.decoder.bind(request).join()) as Map<String, dynamic>;
        lastBody = body;
        lastConfirm = request.headers.value('x-confirm');
        posts += 1;
        intimacy = apply(body);
        response.write(jsonEncode({'ok': true, 'requiresRestart': !applyOnPost}));
      } else if (request.uri.path == '/api/stickers') {
        response.write(jsonEncode(<String, dynamic>{'items': [], 'counts': {}, 'settings': {}, 'tags': {}}));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({
          'error': {'message': 'not found'},
        }));
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

  Future<void> pumpPage(WidgetTester tester, AppStrings? strings, {Size size = const Size(1280, 900)}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      builder: strings == null
          ? null
          : (context, child) => IrmiaStrings(strings: strings, child: child ?? const SizedBox.shrink()),
      home: Scaffold(
        body: MediaQuery(
          data: MediaQueryData(size: size, disableAnimations: true),
          child: MoodPage(state: state),
        ),
      ),
    ));
    // 情绪那屏先落地（既有的 /api/affect 链不许被这一屏影响）
    await pumpUntil(tester, find.byKey(const ValueKey('mood-header')));
  }

  /// 点开第三个 tab
  Future<void> openIntimacy(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('mood-tab-2')));
    await tester.pump();
  }

  Future<void> drainToast(WidgetTester tester) async {
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 500));
    await tester.pump(const Duration(milliseconds: 300));
  }

  final readings = find.byKey(const ValueKey('intimacy-readings'));
  final settings = find.byKey(const ValueKey('intimacy-settings'));
  final offCard = find.byKey(const ValueKey('intimacy-off'));
  final sheet = find.byKey(const ValueKey('intimacy-sheet'));

  const s = ZhStrings();

  testWidgets('第三个 tab 才读 /api/intimacy：没点开之前一次都不打', (tester) async {
    await pumpPage(tester, null);
    expect(find.byKey(const ValueKey('mood-tab-2')), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('mood-tab-2')), matching: find.text('亲密')),
      findsOneWidget,
    );
    expect(intimacyReads, 0, reason: '懒加载：老后端没有这条端点，别在情绪那一屏就打出错误');

    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(intimacyReads, greaterThanOrEqualTo(1));
    expect(find.text(s.intimacyNote), findsOneWidget);
    expect(find.textContaining('仅用户私聊可见'), findsNothing);
  });

  testWidgets('关闭态：只剩说明 + 开关 + 上限，一个读数都不显示', (tester) async {
    intimacy = intimacyView(enabled: false);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, offCard);

    // 说明 + 开关 + 上限三样都在
    expect(find.text(s.intimacyNote), findsOneWidget);
    expect(tester.widget<Switch>(find.byKey(const ValueKey('intimacy-switch'))).value, isFalse);
    expect(find.byKey(const ValueKey('intimacy-level')), findsOneWidget);
    for (final key in const ['subtle', 'obvious', 'strong']) {
      expect(find.byKey(ValueKey('intimacy-level-$key')), findsOneWidget);
    }
    expect(find.text('含蓄'), findsOneWidget);
    expect(find.text('明显'), findsOneWidget);
    expect(find.text('强烈'), findsOneWidget);
    expect(find.text(s.intimacyOffHint), findsOneWidget);
    // 页头那张更新时间也如实说「未开启」，不摆假时间
    expect(
      find.descendant(of: find.byKey(const ValueKey('mood-header')), matching: find.text('未开启')),
      findsOneWidget,
    );

    // 读数一个都不许露出来
    expect(readings, findsNothing);
    expect(find.byKey(const ValueKey('intimacy-history')), findsNothing);
    expect(find.byKey(const ValueKey('intimacy-causes')), findsNothing);
    expect(find.byKey(const ValueKey('intimacy-chart')), findsNothing);
    expect(find.text('四格读数'), findsNothing);
    expect(find.text('情欲'), findsNothing);
    expect(find.text('满足'), findsNothing);
    expect(find.text('克制'), findsNothing);
    expect(find.text('最近变化'), findsNothing);
    expect(find.text('最近走势'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('开启态：四格读数 + level + updatedAt + 最近变化 + 走势', (tester) async {
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    expect(find.descendant(of: readings, matching: find.text('四格读数')), findsOneWidget);
    expect(find.descendant(of: readings, matching: find.text('0–100')), findsOneWidget);
    // 四格：名字的顺序与数值
    final names = tester
        .widgetList<Text>(find.descendant(of: readings, matching: find.byType(Text)))
        .map((text) => text.data)
        .whereType<String>()
        .toList();
    const order = ['亲密', '情欲', '满足', '克制'];
    final positions = [for (final name in order) names.indexOf(name)];
    expect(positions, everyElement(greaterThanOrEqualTo(0)));
    for (var i = 0; i < positions.length - 1; i += 1) {
      expect(positions[i] < positions[i + 1], isTrue, reason: '四格顺序不对：$positions');
    }
    for (final value in ['62', '35', '71', '48']) {
      expect(find.descendant(of: readings, matching: find.text(value)), findsOneWidget);
    }
    // 旁边是 level 与 updatedAt
    expect(find.descendant(of: readings, matching: find.text(s.intimacyLevelValue('obvious'))), findsOneWidget);
    expect(find.descendant(of: readings, matching: find.text('5 分钟前')), findsOneWidget);
    // 上限说明只说表达明显程度，不再宣称"只影响私聊"
    expect(find.text(s.intimacyLevelNote), findsOneWidget);
    expect(s.intimacyLevelNote.contains('私聊'), isFalse);
    // 状态机：默认 calm → 「平稳」，没有发情标签
    expect(find.byKey(const ValueKey('intimacy-phase')), findsOneWidget);
    expect(find.descendant(of: readings, matching: find.text('平稳')), findsOneWidget);
    expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);

    // 最近变化：label + 相对时间
    final causes = find.byKey(const ValueKey('intimacy-causes'));
    expect(find.descendant(of: causes, matching: find.text('用户靠近')), findsOneWidget);
    expect(find.descendant(of: causes, matching: find.text('3 分钟前')), findsOneWidget);
    expect(find.descendant(of: causes, matching: find.text('隔了很久')), findsOneWidget);
    expect(find.descendant(of: causes, matching: find.text('42 分钟前')), findsOneWidget);

    // 走势：6 个点 → 画折线
    expect(find.byKey(const ValueKey('intimacy-chart')), findsOneWidget);
    expect(find.text(s.intimacyHistoryEmpty), findsNothing);
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('四格档位按后端 labels 原样显示：满足/克制不被 maxLevel 二次封顶', (tester) async {
    intimacy = intimacyView(
      maxLevel: 'subtle',
      level: 'subtle',
      // 这张用例只看四格 labels，不摆 phase chip，免得「平稳」两处重名
      phase: null,
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

    // 四格各自一枚档位：maxLevel=含蓄 也照样显示后端返回的「强烈」，页面不重算、不封顶
    for (final label in ['平稳', '明显']) {
      expect(find.descendant(of: readings, matching: find.text(label)), findsOneWidget);
    }
    expect(find.descendant(of: readings, matching: find.text('强烈')), findsNWidgets(2));
    expect(find.descendant(of: readings, matching: find.text(s.intimacyLevelValue('subtle'))), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('状态机：非 estrus 显示 phase 名；estrus=true 只留「已进入发情」一枚 chip', (tester) async {
    await pumpPage(tester, null);

    Future<void> expectPhase(String phase, String label, {bool estrus = false}) async {
      // 切回情绪再进亲密：每次进 tab 都会静默重取，夹具改了就落到新读数上
      await tester.tap(find.byKey(const ValueKey('mood-tab-0')));
      await tester.pump();
      intimacy = intimacyView(phase: phase);
      await openIntimacy(tester);
      await pumpUntil(tester, find.descendant(of: readings, matching: find.text(label)));
      expect(find.descendant(of: readings, matching: find.text(label)), findsOneWidget);
      if (estrus) {
        // phase=estrus 时只摆「已进入发情」，不再并排一枚「发情」
        expect(find.byKey(const ValueKey('intimacy-phase')), findsNothing);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('intimacy-estrus')),
            matching: find.text(label),
          ),
          findsOneWidget,
        );
      } else {
        expect(find.byKey(const ValueKey('intimacy-phase')), findsOneWidget);
        expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);
      }
      expect(tester.takeException(), isNull);
    }

    await expectPhase('calm', '平稳');
    await expectPhase('warm', '温热');
    await expectPhase('tense', '绷着');
    await expectPhase('estrus', '已进入发情', estrus: true);

    // estrus 由 true 收回 false：phase chip 回来、发情状态消失
    await tester.tap(find.byKey(const ValueKey('mood-tab-0')));
    await tester.pump();
    intimacy = intimacyView(phase: 'warm', estrus: false);
    await openIntimacy(tester);
    await pumpUntil(tester, find.descendant(of: readings, matching: find.text('温热')));
    expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);

    // estrus=true：状态 chip 只保留「已进入发情」这一枚
    await tester.tap(find.byKey(const ValueKey('mood-tab-0')));
    await tester.pump();
    intimacy = intimacyView(phase: 'warm', estrus: true);
    await openIntimacy(tester);
    await pumpUntil(tester, find.byKey(const ValueKey('intimacy-estrus')));
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('intimacy-estrus')),
        matching: find.text('已进入发情'),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('intimacy-phase')), findsNothing);
    expect(find.descendant(of: readings, matching: find.text('温热')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('字段缺失容错：老后端只给 enabled + 四格读数，不崩、不摆状态标签', (tester) async {
    intimacy = <String, dynamic>{
      'enabled': true,
      'intimacy': 40,
      'desire': 20,
      'satisfaction': 30,
      'restraint': 10,
    };
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    expect(find.text('四格读数'), findsOneWidget);
    for (final value in ['40', '20', '30', '10']) {
      expect(find.descendant(of: readings, matching: find.text(value)), findsOneWidget);
    }
    // 老后端没有 phase / estrus：不摆空标签
    expect(find.byKey(const ValueKey('intimacy-phase')), findsNothing);
    expect(find.byKey(const ValueKey('intimacy-estrus')), findsNothing);
    // 没有 history / causes / updatedAt：走势与原因走空态，不画假线
    expect(find.byKey(const ValueKey('intimacy-chart')), findsNothing);
    expect(find.text(s.intimacyNoData), findsOneWidget);
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('回归：history 只有 1 个点 → 不画走势、不崩（只留一句空态）', (tester) async {
    final now = DateTime.now();
    intimacy = intimacyView(history: <dynamic>[
      {
        'atMs': now.subtract(const Duration(minutes: 10)).millisecondsSinceEpoch,
        'intimacy': 55,
        'desire': 30,
        'satisfaction': 60,
        'restraint': 50,
      },
    ]);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    expect(find.byKey(const ValueKey('intimacy-chart')), findsNothing);
    expect(find.text(s.intimacyHistoryEmpty), findsOneWidget);
    expect(find.byType(ErrorWidget), findsNothing);
    expect(tester.takeException(), isNull);

    // 0 个点也一样：空态，不是一块灰
    intimacy = intimacyView(history: <dynamic>[]);
    await tester.pump();
    expect(find.byKey(const ValueKey('intimacy-chart')), findsNothing);
    expect(find.text(s.intimacyHistoryEmpty), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('冷却与收住：两句人话都按相对时间说', (tester) async {
    final now = DateTime.now();
    intimacy = intimacyView(
      // 30 分 30 秒 → 向上取整 31 分钟；10 分 30 秒前 → 「10 分钟前」
      cooldownUntilMs: now.add(const Duration(minutes: 30, seconds: 30)).millisecondsSinceEpoch,
      stoppedAtMs: now.subtract(const Duration(minutes: 10, seconds: 30)).millisecondsSinceEpoch,
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, settings);

    expect(find.text('冷却中，还剩 31 分钟'), findsOneWidget);
    expect(find.text('最近一次收住：10 分钟前'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('冷却已过期 / 没有收住：两句都不出现', (tester) async {
    final now = DateTime.now();
    intimacy = intimacyView(
      cooldownUntilMs: now.subtract(const Duration(minutes: 2)).millisecondsSinceEpoch,
    );
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, settings);

    expect(find.textContaining('冷却中'), findsNothing);
    expect(find.textContaining('最近一次收住'), findsNothing);
  });

  testWidgets('开关：写 intimacy.enabled（X-Confirm: config-update），回读后跟着变', (tester) async {
    intimacy = intimacyView(enabled: false);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, offCard);

    await tester.tap(find.byKey(const ValueKey('intimacy-switch')));
    await tester.pump();
    await pumpUntil(tester, readings);
    expect(lastBody, {
      'fields': {'intimacy.enabled': true},
    });
    expect(lastConfirm, 'config-update');
    expect(tester.widget<Switch>(find.byKey(const ValueKey('intimacy-switch'))).value, isTrue);

    await tester.tap(find.byKey(const ValueKey('intimacy-switch')));
    await tester.pump();
    await pumpUntil(tester, offCard);
    expect(lastBody, {
      'fields': {'intimacy.enabled': false},
    });
    expect(tester.widget<Switch>(find.byKey(const ValueKey('intimacy-switch'))).value, isFalse);
    await drainToast(tester);
  });

  testWidgets('上限：点「强烈」写 intimacy.maxLevel；点当前那档不重复写', (tester) async {
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    await tester.tap(find.byKey(const ValueKey('intimacy-level-strong')));
    await tester.pump();
    await pumpUntil(tester, find.text(s.intimacyLevelValue('strong')));
    expect(lastBody, {
      'fields': {'intimacy.maxLevel': 'strong'},
    });
    expect(lastConfirm, 'config-update');
    expect(posts, 1);

    // 已经是「强烈」了：再点一次不发请求
    await tester.tap(find.byKey(const ValueKey('intimacy-level-strong')));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 120)));
    await tester.pump();
    expect(posts, 1, reason: '点当前档位不该再写一次配置');
    expect(tester.takeException(), isNull);
    await drainToast(tester);
  });

  testWidgets('上限没生效（回执要重启）：吐司不谎报，选中档位也不跳', (tester) async {
    applyOnPost = false;
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    await tester.tap(find.byKey(const ValueKey('intimacy-level-strong')));
    await tester.pump();
    await pumpUntil(tester, find.text('配置已保存，等待生效'));
    expect(lastBody, {
      'fields': {'intimacy.maxLevel': 'strong'},
    });
    // 回读仍是「明显」：读数旁边那枚 chip 与三选一都停在旧值上
    expect(find.descendant(of: readings, matching: find.text(s.intimacyLevelValue('obvious'))), findsOneWidget);
    expect(find.descendant(of: readings, matching: find.text(s.intimacyLevelValue('strong'))), findsNothing);
    await drainToast(tester);
  });

  testWidgets('回执说「尚未生效」时设置卡如实挂起（configured != enabled）', (tester) async {
    intimacy = intimacyView(enabled: true, configured: false);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, settings);
    expect(find.text(s.intimacyPending), findsOneWidget);
  });

  testWidgets('齿轮：详情浮层给出四格、上限、line 原文与 renderLine', (tester) async {
    intimacy = intimacyView(line: '亲密：想靠近一点，但还克制着。');
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);

    await tester.tap(find.byKey(const ValueKey('mood-details')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(sheet, findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('亲密详情')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('原文')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('上限')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('明显')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('亲密：想靠近一点，但还克制着。')), findsOneWidget);
    // 与 renderLine 并排核对（请求侧那一块）
    expect(find.descendant(of: sheet, matching: find.text('请求侧 · REQUEST')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('请求里的亲密行')), findsOneWidget);
    expect(find.descendant(of: sheet, matching: find.text('亲密：想靠近一点（明显）。')), findsOneWidget);

    await tester.tap(find.byIcon(Icons.close_rounded));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('亲密详情'), findsNothing);
  });

  testWidgets('line 原文折叠：长句默认两行 + 「展开全部」，点开是「收起」', (tester) async {
    const longLine = '亲密：想靠近一点，但还克制着，先看用户这一轮想聊什么，再决定要不要把那句更直白的话说出口；'
        '如果他愿意多留一会儿，就把这层再打开一档，否则只停在含蓄这一层。';
    intimacy = intimacyView(line: longLine);
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    await tester.tap(find.byKey(const ValueKey('mood-details')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final fold = find.byKey(const ValueKey('intimacy-line-fold'));
    expect(fold, findsOneWidget);
    expect(find.text(s.expandAll(longLine.length)), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey('intimacy-line-text'))).maxLines, 2);

    await tester.tap(fold);
    await tester.pump();
    expect(find.text(s.collapse), findsOneWidget);
    expect(tester.widget<Text>(find.byKey(const ValueKey('intimacy-line-text'))).maxLines, isNull);
  });

  testWidgets('读不出来：只有一处错误 + 重试，恢复后照常渲染', (tester) async {
    failRead = true;
    await pumpPage(tester, null);
    await openIntimacy(tester);
    await pumpUntil(tester, find.textContaining('亲密状态读取失败'));
    expect(find.text('重试'), findsOneWidget);
    expect(readings, findsNothing);
    // 情绪那一屏不受影响
    expect(find.byKey(const ValueKey('mood-header')), findsOneWidget);

    failRead = false;
    await tester.tap(find.text('重试'));
    await pumpUntil(tester, readings);
    expect(find.textContaining('亲密状态读取失败'), findsNothing);
  });

  testWidgets('窄窗：亲密 tab 不溢出（760 / 520 两档）', (tester) async {
    await pumpPage(tester, null, size: const Size(760, 900));
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    for (final title in ['四格读数', '最近变化', '最近走势']) {
      expect(find.text(title), findsOneWidget);
    }
    expect(tester.takeException(), isNull);

    tester.view.physicalSize = const Size(520, 800);
    await tester.pump();
    expect(readings, findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('英文：亲密那一屏的字全来自 AppStrings（一个汉字都不露）', (tester) async {
    intimacy = intimacyView(causeLabel: 'owner leaned in', otherCauseLabel: 'long silence');
    await pumpPage(tester, const EnStrings());
    await openIntimacy(tester);
    await pumpUntil(tester, readings);
    expect(find.descendant(of: readings, matching: find.text('Readings')), findsOneWidget);
    expect(
      find.descendant(of: readings, matching: find.text(const EnStrings().intimacyLevelValue('obvious'))),
      findsOneWidget,
    );
    expect(find.text('Upper limit'), findsOneWidget);
    expect(find.text('Recent changes'), findsOneWidget);
    expect(find.text('Recent trend'), findsOneWidget);
    expect(find.text(const EnStrings().intimacyNote), findsOneWidget);
    expect(find.textContaining('Owner only'), findsNothing);

    // 整屏不许有汉字（tabs / 读数 / 卡片 / 原因一起看；原因 label 是后端数据，这里给英文）
    final hasCjk = RegExp(r'[\u4e00-\u9fff]');
    final leaked = tester
        .widgetList<Text>(find.byType(Text))
        .map((text) => text.data)
        .whereType<String>()
        .where(hasCjk.hasMatch)
        .toList();
    expect(leaked, isEmpty, reason: '英文界面里露了中文：$leaked');
  });
}
