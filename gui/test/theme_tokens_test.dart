import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// **暗主题那两处**——用户 2026-10-05 圈的范围（两句，第二句把范围又收了一格）：
///
///   > 「暗主题时。发送按钮和气泡改成白色描边不就行了。改其他的干嘛？」
///   > 「怎么把亮主题时的蓝色改掉了。我不是让你改暗主题的吗？」
///   > 「暗色主题的气泡和发送按钮是改成**只有白色描边**。**蓝色全部去掉**哦。
///   >  **底色和背景相同即可**。」
///
/// 这一份测试钉三件事：
///   ① **暗模那两处只有一圈白描边**：填充与背景相同（透明）、**不再有那个蓝**、
///      字/图标走正常前景、描边是 1px 的白；
///   ② **亮模那两处与用户动手前逐字节相同**：还是原来的蓝填充、一圈描边都没有；
///   ③ **没被圈到的两处回到原值**：侧栏选中项（`surfaceContainerHighest` + `primary`）、
///      工具行「出错」（写死的 `IrmiaTheme.danger`）——明暗两模都要与改动前一致。
///
/// **删掉了上一轮那批断言**（四处都要换成主题 token、四处都要过 WCAG 4.5:1、
/// "新 token 必须比旧值好"）：判据本身没错，错的是范围——用户只要那两处的形态，
/// 不要四处换配色。所以这里收窄到那两处，并且**判据比原来更紧**：不是"token 定义对就算过"，
/// 而是断言屏幕上那个控件真的要到了那一圈白（气泡的 `BoxDecoration.border`、
/// 按钮 Material 的形状），以及**原来那个蓝真的没了**。
///
/// 分工：这一份管 token 与侧栏选中项；气泡、发送键、工具行「出错」三处**在屏幕上**的实测
/// 在 `test/chat_page_test.dart`（同一批判据的页面侧）。
void main() {
  // WCAG 相对亮度比：这里只用来钉"白描边在暗底上真的看得见"这一条。
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();

  double luminance(Color c) =>
      0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);

  double contrast(Color a, Color b) {
    final la = luminance(a);
    final lb = luminance(b);
    return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
  }

  final light = IrmiaTheme.light().colorScheme;
  final dark = IrmiaTheme.dark().colorScheme;

  group('暗主题：气泡与发送键只有一圈白描边（蓝填充去掉、底色 = 背景）', () {
    test('判据只有一处：暗模要、亮模不要', () {
      expect(dark.darkPairOutlined, isTrue);
      expect(light.darkPairOutlined, isFalse,
          reason: '亮主题一个色都不许动，包括不许加边');
    });

    test('填充：暗模透明（＝与背景相同）、亮模还是那个蓝', () {
      expect(dark.pairFill, Colors.transparent,
          reason: '用户："底色和背景相同即可"——内容区背景是 dawn 渐变，只有透明真的等于它');
      expect(dark.pairFill, isNot(dark.primary), reason: '**蓝色全部去掉**：不许还是那个蓝底');
      expect(dark.pairFill, isNot(light.primary));
      expect(light.pairFill, light.primary, reason: '亮主题照旧：原来的蓝，一个色都没动');
      expect(dark.pairFill, isNot(dark.secondaryContainer),
          reason: '上一轮那套 secondaryContainer 一族也不许回来');
    });

    test('前景：暗模是主题的白（正常前景）、亮模还是 onPrimary', () {
      expect(dark.pairOn, dark.onSurface);
      expect(light.pairOn, light.onPrimary);
      expect(dark.pairOn, isNot(dark.primary), reason: '别再是蓝底白字那种配对');
    });

    test('气泡那一圈：1px、四边同色、只在暗模出现', () {
      final border = dark.bubbleHairline;
      expect(border, isA<Border>(), reason: '气泡描边就是这个 getter 给的');
      final b = border! as Border;
      for (final side in <BorderSide>[b.top, b.right, b.bottom, b.left]) {
        expect(side.color, dark.pairOn, reason: '四边要同色，别描出半圈');
        expect(side.width, IrmiaTheme.hairlineWidth);
        expect(side.width, 1.0, reason: '用户要的是"细"：1 逻辑像素');
      }
      expect(light.bubbleHairline, isNull,
          reason: '亮主题一个像素都不加——用户原来的气泡就是没有描边的');
    });

    test('发送键那一圈：1px、圆形，只在暗模出现', () {
      final shape = dark.sendButtonShape;
      expect(shape, isA<CircleBorder>(), reason: '发送键是圆的，描边长在形状自己身上');
      final side = (shape as CircleBorder).side;
      expect(side.color, dark.pairOn);
      expect(side.width, IrmiaTheme.hairlineWidth);
      expect(side.width, 1.0);

      expect(light.sendButtonShape, const CircleBorder(),
          reason: '亮主题就是用户原来那个 `const CircleBorder()`');
      expect((light.sendButtonShape as CircleBorder).side, BorderSide.none,
          reason: '亮主题的 side 必须是 none——不是"淡淡的边"，是压根没有');
    });

    test('这个"白"是主题给的（最接近白的那一档），没新写死十六进制', () {
      expect(dark.pairOn, dark.onSurface,
          reason: '白从 ColorScheme 取；要更白就改主题的 onSurface，别在这里塞 Color(0x…)');
      expect(contrast(dark.pairOn, dark.surface), greaterThanOrEqualTo(4.5),
          reason: '描边要跟底色分得开，否则加了等于没加：'
              '${contrast(dark.pairOn, dark.surface).toStringAsFixed(2)}:1');
    });
  });

  group('回退：没被圈到的两处，明暗两模都与改动前一致', () {
    /// 侧栏「聊天」选中项在某一套主题下的实测取色：返回 (那一项的底色, 那一项的字色)。
    Future<(Color?, Color?)> navSelectedOf(WidgetTester tester, ThemeData theme) async {
      tester.view.physicalSize = const Size(1400, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final tmpDir = Directory.systemTemp.createTempSync('irmia-theme-token-');
      stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
      addTearDown(() {
        stateFileOverride = null;
        try {
          tmpDir.deleteSync(recursive: true);
        } catch (_) {
          // 临时目录清不掉不影响断言
        }
      });

      final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));
      state.setPage('chat');
      await tester.pumpWidget(MaterialApp(
        theme: theme,
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) => HomeShell(state: state),
        ),
      ));
      await tester.pump(const Duration(milliseconds: 300));

      // 按 key 找侧栏那一项：页面上同名的文字不止一处（一级导航项 + 页头标题）。
      final navItem = find.byKey(const ValueKey('nav-chat'));
      expect(navItem, findsOneWidget, reason: '侧栏那一项要有自己的定位件');

      final fills = tester
          .widgetList<Material>(find.descendant(of: navItem, matching: find.byType(Material)))
          .map((m) => m.color)
          .toList();
      expect(fills, hasLength(1), reason: '这一项自己的那层底：实测 $fills');
      expect(fills.single, theme.colorScheme.surfaceContainerHighest,
          reason: '选中项的底必须回到改动前的 surfaceContainerHighest');

      final labels = tester
          .widgetList<Text>(find.descendant(of: navItem, matching: find.text('聊天')))
          .map((t) => t.style?.color)
          .toList();
      expect(labels, hasLength(1));
      expect(labels.single, theme.colorScheme.primary,
          reason: '选中项的字必须回到改动前的 primary——**这才是用户说的"亮主题时的蓝色"**');
      return (fills.single, labels.single);
    }

    testWidgets('亮模：底 = surfaceContainerHighest、字 = primary', (tester) async {
      final (fill, tone) = await navSelectedOf(tester, IrmiaTheme.light());
      expect(fill, IrmiaTheme.light().colorScheme.surfaceContainerHighest);
      expect(tone, IrmiaTheme.light().colorScheme.primary);
      expect(tone, isNot(IrmiaTheme.light().colorScheme.onSecondaryContainer),
          reason: '上一轮那套 secondaryContainer 一族的字色不许再出现');
    });

    testWidgets('暗模：同一对取值（回退与主题无关，两模一样）', (tester) async {
      final (fill, tone) = await navSelectedOf(tester, IrmiaTheme.dark());
      expect(fill, IrmiaTheme.dark().colorScheme.surfaceContainerHighest);
      expect(tone, IrmiaTheme.dark().colorScheme.primary);
      expect(tone, isNot(IrmiaTheme.dark().colorScheme.onSecondaryContainer),
          reason: '上一轮那套 secondaryContainer 一族的字色不许再出现');
    });

    test('工具行「出错」那一档是界面常量：不随主题漂移', () {
      // 页面侧的实测（'出错' 那枚字的颜色）在 chat_page_test.dart；这里钉口径：
      // 四色是界面常量（见 IrmiaTheme.ok 那一段的说明），明暗两模同一个值。
      expect(IrmiaTheme.danger, const Color(0xFFE03131));
      expect(IrmiaTheme.danger, isNot(dark.onErrorContainer),
          reason: '上一轮那个"深色模浅红"是 errorContainer 一族的字色，不许再被当成出错档');
      expect(IrmiaTheme.danger, isNot(light.onErrorContainer));
      expect(IrmiaTheme.danger, isNot(dark.errorContainer));
    });
  });
}
