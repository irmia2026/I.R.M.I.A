import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/pages/chat_page.dart';
import 'package:irmia_gui/pages/settings_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/theme/design_tokens.dart';
import 'package:irmia_gui/ui_state.dart';

/// i18n 与设计令牌的六条承诺（2026-10-17 落地的那一套）。
///
///   ① **切了就变**：`effectiveLanguage` 一改，屏幕上的关键文案立刻换（不重启、不重进页面）；
///   ② **同值不重建**：选一个已经选中的语言不会白重建整棵树；
///   ③ **默认仍是中文**：没有 scope 时 `IrmiaStrings.of` 回中文、`IrmiaApp()` 默认中文——
///      既有那 39 份用例断的全是中文，这一条是它们不红的根；
///   ④ **中文与页面里的常量逐字相同**：`kUnnamedSender` 那一族是既有用例的锚，
///      文案表不许与它们漂；
///   ⑤ **落盘**：选择写进 `ui-state.json`（`language` 键），下次启动读回来；
///   ⑥ **「跟随系统」只在入口解析**：树里拿到的永远是 zh/en，测试结论与机器的系统语言无关。
///
/// 外加设计令牌的数值表（间距/三档字/形状/动效/对比度）。
///
/// 真机观感（字体栈、DPI、中英混排的换行、深浅色下的实际观感）**不在**这份用例的射程内。
void main() {
  setUp(() {
    effectiveLanguage.value = AppLanguage.zh;
    languagePreference.value = AppLanguage.system;
    stateFileOverride =
        '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-i18n-test.json';
    try {
      final file = File(stateFileOverride!);
      if (file.existsSync()) file.deleteSync();
    } catch (_) {
      // 临时文件清不掉不影响断言
    }
  });

  tearDown(() {
    effectiveLanguage.value = AppLanguage.zh;
    languagePreference.value = AppLanguage.system;
    stateFileOverride = null;
  });

  group('① 切了就变', () {
    testWidgets('聊天页：页头与输入框提示跟着 effectiveLanguage 换', (tester) async {
      // 假 API：**不接真实 SSE**。真的 IrmiaApi 带一条"断了就重连"的定时器链，用例收尾会一直等它
      // （本仓 chat_page_test.dart 的 _FakeApi 也是这么做的）。
      final state = AppState(api: _FakeApi());
      addTearDown(state.dispose);

      // 与 app.dart 同样的接线：语言 notifier → IrmiaStrings → 页面
      await tester.pumpWidget(
        ValueListenableBuilder<AppLanguage>(
          valueListenable: effectiveLanguage,
          builder: (context, language, _) => MaterialApp(
            theme: IrmiaTheme.light(),
            builder: (context, child) => IrmiaStrings(
              strings: stringsFor(language),
              child: child ?? const SizedBox.shrink(),
            ),
            home: Scaffold(body: ChatPage(state: state)),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('聊天'), findsOneWidget, reason: '默认中文：页头标题');
      expect(find.text('会话、消息来源与人工唤醒'), findsOneWidget);
      expect(
        find.text('输入消息…（/reset 清空上下文、/dream 叫她整理记忆）'),
        findsOneWidget,
        reason: '输入框提示',
      );

      effectiveLanguage.value = AppLanguage.en;
      await tester.pump();

      expect(find.text('Chat'), findsOneWidget, reason: '切到英文之后标题就该是 Chat');
      expect(find.text('聊天'), findsNothing, reason: '旧的那句不许留在屏幕上');
      expect(find.text('Conversations, message sources, manual wake-up'), findsOneWidget);
      expect(
        find.text('Type a message… (/reset clears context, /dream asks her to tidy up memory)'),
        findsOneWidget,
      );
    });

    testWidgets('语言选择器：点 English 当场生效（不重启）', (tester) async {
      // 不 pump 整个设置页（那一页要配置/密钥/依赖四条端点），只验选择器本身的接线：
      // 一个 SegmentedButton<AppLanguage> + setLanguage，值来自全局 notifier。
      await tester.pumpWidget(
        ValueListenableBuilder<AppLanguage>(
          valueListenable: languagePreference,
          builder: (context, preference, _) {
            final s = stringsFor(
              preference == AppLanguage.system ? effectiveLanguage.value : preference,
            );
            return MaterialApp(
              theme: IrmiaTheme.light(),
              builder: (context, child) => IrmiaStrings(
                strings: s,
                child: child ?? const SizedBox.shrink(),
              ),
              home: Scaffold(
                body: Builder(
                  builder: (context) => Column(
                    children: [
                      Text(IrmiaStrings.of(context).settingsLanguage),
                      SegmentedButton<AppLanguage>(
                        key: const ValueKey('language-switch'),
                        segments: [
                          ButtonSegment(
                            value: AppLanguage.system,
                            label: Text(IrmiaStrings.of(context).languageFollowSystem),
                          ),
                          ButtonSegment(value: AppLanguage.zh, label: Text(AppLanguage.zh.endonym)),
                          ButtonSegment(value: AppLanguage.en, label: Text(AppLanguage.en.endonym)),
                        ],
                        selected: {preference},
                        showSelectedIcon: false,
                        // 这里**不调 setLanguage**：它里面要落盘（真 IO），而 widget 用例跑在
                        // fake-async 里，await 真 IO 会挂住（落盘本身由 ⑤ 那两条纯 test 钉着）。
                        // 这两行就是 setLanguage 的动作面：偏好 + 生效值，同一个 tick 里一起改。
                        onSelectionChanged: (picked) {
                          languagePreference.value = picked.first;
                          effectiveLanguage.value = picked.first.resolve(const Locale('zh', 'CN'));
                        },
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );
      await tester.pump();

      expect(find.text('语言'), findsOneWidget);
      expect(find.text('跟随系统'), findsOneWidget);
      // 两条语言名**各自用自己的语言写**：切到英文之后还认得出哪个是中文
      expect(find.text('中文'), findsOneWidget);
      expect(find.text('English'), findsOneWidget);

      await tester.tap(find.text('English'));
      // 不用 pumpAndSettle：这一屏上线就带着常驻动画（呼吸点/进度），settle 永远不会到
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Language'), findsOneWidget, reason: '选中 English 之后当场变英文');
      expect(find.text('Follow system'), findsOneWidget);
      expect(find.text('语言'), findsNothing, reason: '旧的标签不许留在屏幕上');
      expect(effectiveLanguage.value, AppLanguage.en);

      // 切回来：中文那一项仍然写着"中文"（自称不翻译）
      await tester.tap(find.text('中文'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('语言'), findsOneWidget);
      expect(effectiveLanguage.value, AppLanguage.zh);
    });
  });

  group('② 同值不重建', () {
    testWidgets('把语言设成当前值：不发通知、不重建', (tester) async {
      var builds = 0;
      await tester.pumpWidget(
        ValueListenableBuilder<AppLanguage>(
          valueListenable: effectiveLanguage,
          builder: (context, language, _) {
            builds += 1;
            return IrmiaStrings(strings: stringsFor(language), child: const SizedBox.shrink());
          },
        ),
      );
      await tester.pump();
      // 先让可能还脏着的那一帧落地，再记基线：
      // 否则"同值没重建"会跟"上一帧本来就没画完"混在一起
      await tester.pump();
      final baseline = builds;

      // 注意：**这里不调 `setLanguage`**。它要落盘（真 IO），而 widget 用例跑在 fake-async 里，
      // await 真 IO 会一直挂着（落盘与读回由 ⑤ 那两条纯 test 钉着）。
      // 这两行就是 `setLanguage` 的动作面：偏好 + 生效值。
      languagePreference.value = AppLanguage.zh;
      effectiveLanguage.value = AppLanguage.zh; // 同值 ⇒ ValueNotifier 不通知
      await tester.pump();
      expect(builds, baseline, reason: '同值不该重建');

      // 反过来：真的变了就要重建（否则"同值不重建"可以靠"永远不重建"骗过去）
      effectiveLanguage.value = AppLanguage.en;
      await tester.pump();
      expect(builds, greaterThan(baseline), reason: '值变了必须重建');
    });

    testWidgets('IrmiaStrings 的语言没变时不通知依赖方', (tester) async {
      final counter = _BuildCounter();
      // **必须是同一个实例**：每次 pump 都造一个新的 _Probe，
      // 父级换 widget 时它本来就会被重建，那样就测不出 InheritedWidget 有没有通知
      final probe = _Probe(counter: counter);
      await tester.pumpWidget(
        IrmiaStrings(strings: const ZhStrings(), child: MaterialApp(home: probe)),
      );
      await tester.pump();
      expect(counter.builds, 1);

      // 换一层 IrmiaStrings，但语言还是中文 ⇒ updateShouldNotify = false ⇒ 不重建
      await tester.pumpWidget(
        IrmiaStrings(strings: const ZhStrings(), child: MaterialApp(home: probe)),
      );
      await tester.pump();
      expect(counter.builds, 1, reason: '语言没变，依赖方不该重建');

      await tester.pumpWidget(
        IrmiaStrings(strings: const EnStrings(), child: MaterialApp(home: probe)),
      );
      await tester.pump();
      expect(counter.builds, 2, reason: '语言变了，依赖方必须重建');
    });
  });

  group('③ 默认仍是中文（既有用例不红的根）', () {
    testWidgets('没有 scope 时 of() 回中文', (tester) async {
      late AppStrings got;
      await tester.pumpWidget(MaterialApp(
        home: Builder(builder: (context) {
          got = IrmiaStrings.of(context);
          return const SizedBox.shrink();
        }),
      ));
      expect(got.language, AppLanguage.zh);
      expect(got.navChat, '聊天');
    });

    test('IrmiaApp 的默认语言是中文', () {
      expect(const IrmiaApp().initialLanguage, AppLanguage.zh);
    });

    test('两份实现的自称、locale 与语言枚举对得上', () {
      expect(const ZhStrings().locale, const Locale('zh'));
      expect(const EnStrings().locale, const Locale('en'));
      expect(const ZhStrings().language, AppLanguage.zh);
      expect(const EnStrings().language, AppLanguage.en);
    });
  });

  group('④ 中文与页面里的常量逐字相同（不许漂）', () {
    const zh = ZhStrings();

    test('聊天页那四个对外可见的常量', () {
      expect(zh.tagFrameworkNotice, kFrameworkNoticeLabel);
      expect(zh.historyErrorTitle, kHistoryErrorTitle);
      expect(zh.injectionCardTitle, kInjectionCardTitle);
      expect(zh.unnamedSender, kUnnamedSender);
      // 三个具名标签之间的区分也要在：它们不许写成同一句
      expect(zh.tagInjection, isNot(zh.tagFrameworkReminder));
      expect(zh.tagContextBoundary, isNot(zh.tagFrameworkReminder));
    });

    test('框架通报的三种来源（dream / mcp / 兜底）', () {
      expect(frameworkNoticeLabel('dream'), '做梦');
      expect(frameworkNoticeLabel('mcp'), 'MCP 声明变更');
      expect(frameworkNoticeLabel('unknown-via'), '框架通报');
      expect(frameworkNoticeLabel('dream', strings: const EnStrings()), 'Dream');
      expect(
        frameworkNoticeLabel('unknown-via', strings: const EnStrings()),
        'Framework notice',
      );
    });

    test('设置页 11 个分区标签与 _anchors 里的常量逐字相同', () {
      const ids = <String>[
        'model',
        'ui',
        'speak',
        'deps',
        'protocol',
        'webhook',
        'memory',
        'trust',
        'system',
        'account',
        'about',
      ];
      const expected = <String>[
        '模型',
        '界面',
        '发言',
        '外部依赖',
        '协议端',
        '外部回调',
        '记忆',
        '信任范围',
        '系统',
        '账号与安全',
        '关于',
      ];
      for (var i = 0; i < ids.length; i += 1) {
        expect(settingsNavLabel(zh, ids[i]), expected[i], reason: '${ids[i]} 的分区名漂了');
      }
      // 英文那份不许空、也不许回落成中文
      for (final id in ids) {
        final en = settingsNavLabel(const EnStrings(), id);
        expect(en.trim(), isNotEmpty);
        expect(_hasCjk(en), isFalse, reason: '英文那份里出现了汉字：$id → $en');
      }
    });

    test('字数短写：中文按万、英文按 k，同一份实现', () {
      expect(formatThinkingChars(980), '980');
      expect(formatThinkingChars(62854), '6.3 万字');
      expect(const EnStrings().compactChars(62854), '62.9k');
      expect(const EnStrings().compactChars(980), '980');
      expect(const EnStrings().compactChars(125000), '125k');
    });

    test('思考那一行的四个格子：中文与迁移前逐字相同', () {
      final p = ThinkingProgress(
        turn: 3,
        step: 7,
        chars: 62854,
        since: DateTime.now(),
        phase: ThinkCharsPhase.counted,
      );
      // 注意「6.3 万字 字」这个叠字：**迁移前就是这样**（已想 $chars 字，而 chars 自带『万字』），
      // 这一轮只搬不改口径——顺手改掉它就等于偷偷改了她的读数。
      expect(thinkingLine(p), '思考中　第  7 步　已想 6.3 万字 字　用时 0:00');
      final en = thinkingLine(p, strings: const EnStrings());
      expect(en.contains('Thinking'), isTrue);
      expect(en.contains('step  7'), isTrue);
      expect(en.contains('62.9k chars'), isTrue);
      expect(_hasCjk(en), isFalse, reason: '英文那行不许漏汉字');
    });
  });

  group('⑤ 落盘与读回', () {
    test('setLanguage 写 ui-state.json，restoreLanguage 读回来', () async {
      await setLanguage(AppLanguage.en);
      expect(languagePreference.value, AppLanguage.en);
      expect(effectiveLanguage.value, AppLanguage.en);

      final raw = jsonDecode(File(stateFileOverride!).readAsStringSync()) as Map;
      expect(raw[kLanguageFlag], 'en', reason: '键名与取值都要落盘');

      // 模拟"下次启动"：内存回到默认，再读盘
      effectiveLanguage.value = AppLanguage.zh;
      languagePreference.value = AppLanguage.system;
      final restored = await restoreLanguage();
      expect(restored, AppLanguage.en);
      expect(languagePreference.value, AppLanguage.en,
          reason: '偏好也要读回来，否则下拉框会跳回"跟随系统"');
    });

    test('盘上是认不出的值 → 跟随系统（不把界面卡住）', () async {
      File(stateFileOverride!).writeAsStringSync('{"language":"klingon"}');
      final restored = await restoreLanguage(systemLocale: const Locale('zh', 'CN'));
      expect(languagePreference.value, AppLanguage.system);
      expect(restored, AppLanguage.zh);
    });
  });

  group('⑥「跟随系统」只在入口解析', () {
    test('认得出的系统语言：zh→中文、en→English', () {
      expect(AppLanguage.system.resolve(const Locale('zh', 'CN')), AppLanguage.zh);
      expect(AppLanguage.system.resolve(const Locale('en', 'US')), AppLanguage.en);
      expect(AppLanguage.system.resolve(const Locale('zh', 'TW')), AppLanguage.zh);
    });

    test('认不出的系统语言落到中文（作者语言，最小惊讶）', () {
      expect(AppLanguage.system.resolve(const Locale('ja', 'JP')), AppLanguage.zh);
      expect(AppLanguage.system.resolve(null), AppLanguage.zh);
    });

    test('具体语言不受系统影响', () {
      expect(AppLanguage.zh.resolve(const Locale('en', 'US')), AppLanguage.zh);
      expect(AppLanguage.en.resolve(const Locale('zh', 'CN')), AppLanguage.en);
    });

    test('AppLanguage.fromCode 认不出的值回「跟随系统」', () {
      expect(AppLanguage.fromCode('en'), AppLanguage.en);
      expect(AppLanguage.fromCode('zh'), AppLanguage.zh);
      expect(AppLanguage.fromCode('system'), AppLanguage.system);
      expect(AppLanguage.fromCode(null), AppLanguage.system);
      expect(AppLanguage.fromCode(''), AppLanguage.system);
    });
  });

  group('⑦ 带参英文句子（settings_page 状态行 / 吐司真会显示的那 13 条）', () {
    test('13 条都有真句子：非空、无占位残留、参数原样落地', () {
      const en = EnStrings();
      // 键 → (喂进去的参数, 英文实现吐出来的那一句)。
      // 这 13 条曾经在 `EnStrings` 里是 `=> '';`（或直接回传 elapsed）：英文界面整句消失，
      // 而中文那份一直是好句子——所以断言按"英文"这一侧来，中文不动。
      final cases = <String, (List<String>, String)>{
        'thinkingElapsed': (
          ['0:07'],
          en.thinkingElapsed('0:07'),
        ),
        'settingsChainListening': (
          ['http://127.0.0.1:19117'],
          en.settingsChainListening('http://127.0.0.1:19117'),
        ),
        'settingsChainEndpoint': (
          ['ws://127.0.0.1:3001/ws'],
          en.settingsChainEndpoint('ws://127.0.0.1:3001/ws'),
        ),
        'settingsChainDelivered': (
          ['3'],
          en.settingsChainDelivered('3'),
        ),
        'settingsChainBackoff': (
          ['2'],
          en.settingsChainBackoff('2'),
        ),
        'settingsQrLoginAt': (
          ['http://127.0.0.1:19117'],
          en.settingsQrLoginAt('http://127.0.0.1:19117'),
        ),
        'settingsWebhookCurrentValue': (
          ['whk_abc123', '2026-09-28 10:00'],
          en.settingsWebhookCurrentValue('whk_abc123', '2026-09-28 10:00'),
        ),
        'settingsWebhookBy': (
          ['gui'],
          en.settingsWebhookBy('gui'),
        ),
        'settingsGenerateFailed': (
          ['HTTP 500'],
          en.settingsGenerateFailed('HTTP 500'),
        ),
        'settingsTrustWorkspaceValue': (
          [r'D:\work\agent'],
          en.settingsTrustWorkspaceValue(r'D:\work\agent'),
        ),
        'settingsProjectionReadFailedHint': (
          ['socket closed'],
          en.settingsProjectionReadFailedHint('socket closed'),
        ),
        'settingsDaysCount': (
          ['7'],
          en.settingsDaysCount('7'),
        ),
        'settingsDaysSince': (
          ['7', '2026-09-28'],
          en.settingsDaysSince('7', '2026-09-28'),
        ),
      };

      for (final entry in cases.entries) {
        final (args, value) = entry.value;
        expect(value.trim(), isNotEmpty,
            reason: '${entry.key} 的英文是空串——英文界面这一句会整句消失');
        expect(_hasCjk(value), isFalse,
            reason: '${entry.key} 的英文里混进了汉字：$value');
        // 占位残留：`{0}` 那种模板，以及没被插值吃掉的 `$`
        expect(value.contains(r'$'), isFalse,
            reason: '${entry.key} 的英文里留着 \$（插值没落地）：$value');
        expect(value.contains('{') || value.contains('}'), isFalse,
            reason: '${entry.key} 的英文里留着花括号占位：$value');
        // 参数必须原样进句子：英文那句不能把读数弄丢
        for (final arg in args) {
          expect(value.contains(arg), isTrue,
              reason: '${entry.key} 把参数 $arg 丢了：$value');
        }
        // 也不许把参数原样回传：`thinkingElapsed` 的老实现就是 `=> elapsed`，
        // 那样"非空"照样过，但那一格既没有句式也没有单位——整句消失的另一种形状。
        if (args.length == 1) {
          expect(value, isNot(equals(args.single)),
              reason: '${entry.key} 把参数原样回传了，读数没有句式：$value');
        }
      }

      // 单数不能写成 `1 days` / `1 messages`：设置页开张第一天就会看到
      expect(en.settingsDaysCount('1'), '1 day');
      expect(en.settingsDaysSince('1', '2026-09-28'), '1 day (since 2026-09-28)');
      expect(en.settingsChainDelivered('1'), 'received 1 message');
    });
  });

  group('设计令牌', () {
    test('间距只有六档，且 snap 就近（相等时向小取）', () {
      expect(Space.scale, <double>[4, 8, 12, 16, 24, 32]);
      expect(Space.snap(5), 4);
      expect(Space.snap(6), 4, reason: '6 到 4 与到 8 一样远，向小取（宁可紧一点，信息密度优先）');
      expect(Space.snap(9), 8);
      expect(Space.snap(13), 12);
      expect(Space.snap(20), 16, reason: '20 到 16 与到 24 一样远，向小取');
      expect(Space.snap(2), 4);
    });

    test('三档字就是 20/28 · 14/22 · 12/18', () {
      expect(Type.title.size, 20);
      expect(Type.title.height, 28);
      expect(Type.body.size, 14);
      expect(Type.body.height, 22);
      expect(Type.caption.size, 12);
      expect(Type.caption.height, 18);
      // TextStyle.height 是倍数：交给 Material 之前必须换算过
      expect(Type.body.style().height, closeTo(22 / 14, 1e-9));
    });

    test('TextTheme 真的落了那三档', () {
      final theme = IrmiaTheme.light();
      expect(theme.textTheme.titleLarge?.fontSize, 20);
      expect(theme.textTheme.titleLarge?.height, closeTo(28 / 20, 1e-9));
      expect(theme.textTheme.bodyMedium?.fontSize, 14);
      expect(theme.textTheme.bodyMedium?.height, closeTo(22 / 14, 1e-9));
      expect(theme.textTheme.bodySmall?.fontSize, 12);
      expect(theme.textTheme.bodySmall?.height, closeTo(18 / 12, 1e-9));
    });

    test('形状：三档圆角（卡片 16 / 控件 10 / 正圆 999）+ 弹窗跟卡片同值 / 一套阴影', () {
      expect(Shape.radiusCard, 12);
      expect(Shape.radiusControl, 10);
      expect(Shape.radiusPill, 999);
      // 12 是控件的派生档（+2），只给聊天页那条输入框与发送键
      expect(Shape.radiusControlLarge, 12);
      expect(Shape.radiusControlLarge, Shape.radiusControl + 2);
      expect(IrmiaTheme.radiusCard, Shape.radiusCard);
      expect(IrmiaTheme.radiusCtl, Shape.radiusControl);
      expect(IrmiaTheme.radiusCtlLarge, Shape.radiusControlLarge);
      expect(IrmiaTheme.radiusPill, Shape.radiusPill);
      expect(Shape.shadows, hasLength(1));
      final dialog = IrmiaTheme.light().dialogTheme;
      expect(
        (dialog.shape! as RoundedRectangleBorder).borderRadius,
        BorderRadius.circular(Shape.radiusCard),
        reason: '弹窗原来吃 M3 默认的 28，与卡片不是一个形',
      );
      // 页面里的按钮（描边那一族）也不许再是胶囊：形状必须就是控件圆角
      final outlined = IrmiaTheme.light().outlinedButtonTheme.style!;
      final shape = outlined.shape!.resolve(<WidgetState>{})! as RoundedRectangleBorder;
      expect(shape.borderRadius, BorderRadius.circular(Shape.radiusControl),
          reason: 'M3 的 OutlinedButton 默认是 StadiumBorder（胶囊）——收口后一律 control');
    });

    test('动效常量：120/180/240/1500/2400，两条曲线', () {
      expect(Motion.fast, const Duration(milliseconds: 120));
      expect(Motion.base, const Duration(milliseconds: 180));
      expect(Motion.slow, const Duration(milliseconds: 240));
      expect(Motion.highlight, const Duration(milliseconds: 1500));
      expect(Motion.drift, const Duration(milliseconds: 2400));
      expect(IrmiaTheme.durPage, Motion.base);
      expect(IrmiaTheme.durCard, Motion.slow);
    });

    test('语义色：文字三档在两套主题下都不低于 WCAG AA 4.5:1', () {
      for (final palette in <Palette>[Palette.light, Palette.dark]) {
        final ink = IrmiaInk.fromPalette(palette);
        final tiers = <String, Color>{'主': ink.ink, '次': ink.secondary, '弱': ink.faint};
        for (final entry in tiers.entries) {
          final ratio = _contrast(entry.value, palette.bg);
          expect(
            ratio,
            greaterThanOrEqualTo(4.5),
            reason: '${palette == Palette.light ? '浅' : '深'}色主题的文字·${entry.key} '
                '对底色只有 ${ratio.toStringAsFixed(2)}:1',
          );
        }
      }
    });

    test('语义色挂到了 ThemeData 上（IrmiaInk 取得到）', () {
      for (final theme in <ThemeData>[IrmiaTheme.light(), IrmiaTheme.dark()]) {
        final ink = theme.extension<IrmiaInk>();
        expect(ink, isNotNull, reason: 'extensions 里没挂 IrmiaInk');
        expect(ink!.faint, isNot(ink.ink));
      }
    });
  });
}

/// 只回一份空历史的最小 API：页面画得出来（空态），又不带任何真实定时器。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:1');

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async =>
      path.startsWith('/api/events') ? <String, dynamic>{'events': <dynamic>[]} : <String, dynamic>{'ok': true};

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async =>
      <String, dynamic>{'ok': true};

  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) => const Stream.empty();
}
/// 递增计数（跨 rebuild 保留：State 持有它，widget 可以换实例）
class _BuildCounter {
  int builds = 0;
}

/// 只做一件事：每次 build 计一次数，并**读一次文案表**（那样才登记依赖）
class _Probe extends StatelessWidget {
  const _Probe({required this.counter});

  final _BuildCounter counter;

  @override
  Widget build(BuildContext context) {
    counter.builds += 1;
    return Text(IrmiaStrings.of(context).navChat);
  }
}

bool _hasCjk(String text) => RegExp(r'[\u4e00-\u9fff]').hasMatch(text);

double _luminance(Color color) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
