import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/her_name.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/pages/overview_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 壳的布局冒烟：侧边栏（品牌 + 一级六入口 + 底部「更多」折叠组）必须真的渲染出来。
/// 背景：真机截图里侧边栏一度看起来是空白灰带，用测试锁死它的存在。
void main() {
  late Directory tmpDir;

  // 壳的界面状态写文件：测试指向临时路径，别踩真实 %APPDATA% 里的展开态
  setUp(() {
    tmpDir = Directory.systemTemp.createTempSync('irmia-ui-state-');
    stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
  });

  tearDown(() {
    stateFileOverride = null;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });
  /// 指向一个几乎不可能有服务的端口：请求会失败，页面走 error 态，
  /// 但壳本身（侧边栏/品牌区）应当照常渲染——这正是要断言的部分。
  AppState makeState() => AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));

  Future<void> pumpShell(WidgetTester tester, AppState state) async {
    tester.view.physicalSize = const Size(1350, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    // 与 IrmiaApp 同一接法：状态变更驱动壳重建（否则切页不会刷新选中态）
    await tester.pumpWidget(
      MaterialApp(
        theme: IrmiaTheme.light(),
        home: ListenableBuilder(
          listenable: state,
          builder: (context, _) => HomeShell(state: state),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// 真实文件 IO 在 fake async 环境里要靠 runAsync 推进，pump 负责回灌微任务：
  /// 两者交替几轮，ui-state.json 的读写才能真的跑完。
  Future<void> settleIo(WidgetTester tester, {int rounds = 16}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
    }
  }

  testWidgets('侧边栏渲染品牌区、一级六项与「更多」', (tester) async {
    final state = makeState();
    await pumpShell(tester, state);

    // 品牌区显示的是**她的名字**，而这条用例的服务端连不上（端口 1）——读不到名字时
    // 回退成产品名的短写（见 her_name.dart）：空着会让人以为界面坏了，猜一个名字更糟。
    expect(find.text(kProductNameShort), findsOneWidget, reason: '读不到名字时品牌区显示产品名');
    expect(find.text('伊尔弥亚'), findsNothing, reason: '谁都不该再写死这个名字');
    // 六项 = 原五項 + 用户 2026-10 要的「日程」（那条"必须保持五项"的判据已被推翻，
    // 见 app.dart 里 navPages 上方的注释）
    expect(navPages.length, 6, reason: '一级入口应为六项');
    expect(navPages.first.id, 'overview', reason: '首位应是运行情况');
    expect(navPages[2].id, 'schedule', reason: '「日程」应排在聊天与人格配置之间');

    // 导航项：文案可能同时出现在页面标题里（如"运行情况"），至少一个在侧边栏
    for (final page in navPages) {
      expect(find.text(page.label), findsWidgets, reason: '缺少一级入口：${page.label}');
    }

    // 低频项收进折叠组：未展开时不在侧边栏出现
    expect(find.text('更多'), findsOneWidget);
    expect(find.text('日志'), findsNothing, reason: '日志已收进「更多」，不再占一级位置');
    expect(find.text('设置'), findsNothing, reason: '设置只应在「更多」里出现一次');

    // 品牌区只有名字与状态点：那枚图案用户看过之后**去掉了**（干脆去掉），
    // 这里钉住它不会自己长回来。
    expect(find.byType(BrandMark), findsNothing, reason: '侧栏品牌区不该再有图案');

    final brand = tester.getRect(find.text(kProductNameShort));
    expect(brand.width, greaterThan(0), reason: '品牌区被压成 0 宽');
    expect(brand.left, closeTo(22, 0.5),
        reason: '品牌名离窗口左边缘太近（用户："太贴边了"）；应在整列基线 22 上，left=${brand.left}');

    // **整列一条基线**（用户 2026-10-04："导航项要和品牌名对齐"）：
    // 品牌名的左边缘 == 一级导航项图标的左边缘 == 22；
    // 导航项**文字**在图标下游（22 + 图标 19 + 间距 10 = 51 起），与品牌名是两列，不是一根线。
    final firstNav = tester.getRect(find.text(navPages.first.label).first);
    expect(firstNav.left, closeTo(51, 1),
        reason: '一级导航项文字应挂在图标下游（22 + 图标 19 + 间距 10 = 51，left=${firstNav.left}）');
    expect(firstNav.right, lessThanOrEqualTo(230),
        reason: '导航项跑到侧边栏外了（right=${firstNav.right}）');

    // 「更多」那一组（底部二级）与一级共用同一条基线：组标题图标也落在 22 上
    final moreIcon = tester.getRect(
        find.descendant(of: find.ancestor(of: find.text('更多'), matching: find.byType(Row)).first,
            matching: find.byType(Icon)).first);
    expect(moreIcon.left, closeTo(22, 0.5),
        reason: '底部「更多」组的图标没跟主线对齐（left=${moreIcon.left}）');
  });

  testWidgets('默认落在运行情况', (tester) async {
    final state = makeState();
    await pumpShell(tester, state);

    expect(state.pageId, 'overview');
    expect(find.byType(OverviewPage), findsOneWidget, reason: '默认页应是运行情况');
  });

  testWidgets('「更多」展开后二级可达，选中态同步', (tester) async {
    final state = makeState();
    await pumpShell(tester, state);

    await tester.tap(find.text('更多'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('日志'), findsOneWidget, reason: '展开后应出现二级项');
    expect(find.text('设置'), findsOneWidget, reason: '展开后应出现二级项');

    await tester.tap(find.text('日志'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(state.pageId, 'logs');
    expect(tester.takeException(), isNull);

    // 二级项选中时「更多」也要高亮：组标题颜色跟随选中态变为 primary
    // （上一轮把选中态收进了主题 token，用户 2026-10-05 退回了没被圈到的两处之一：
    //  选中项的底与字回到 surfaceContainerHighest + primary。见 test/theme_tokens_test.dart）
    final scheme = IrmiaTheme.light().colorScheme;
    final moreText = tester.widget<Text>(find.text('更多'));
    expect(moreText.style?.color, scheme.primary, reason: '「更多」未跟随二级选中态高亮');
  });

  testWidgets('「更多」展开态落盘，重建后恢复', (tester) async {
    final state = makeState();
    await pumpShell(tester, state);

    await tester.tap(find.text('更多'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('日志'), findsOneWidget, reason: '展开后应出现二级项');

    // 落盘是真实文件 IO：fake async 下要靠 runAsync 推进
    await settleIo(tester);
    final file = File(stateFilePath());
    expect(file.existsSync(), isTrue, reason: '展开态未落盘');
    expect(file.readAsStringSync(), contains('"moreGroupOpen":true'), reason: '展开态内容不对');

    // 重建壳 = 重启：展开态应从状态文件里读回来
    await tester.pumpWidget(const SizedBox());
    await pumpShell(tester, makeState());
    await settleIo(tester);
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.text('日志'), findsOneWidget, reason: '重启后未恢复展开态');
  });

  testWidgets('切换到每页都不崩', (tester) async {
    final state = makeState();
    await pumpShell(tester, state);

    for (final page in allPages) {
      state.setPage(page.id);
      await tester.pump(const Duration(milliseconds: 250));
      expect(tester.takeException(), isNull, reason: '页面渲染抛异常：${page.id}');
      expect(state.pageId, page.id, reason: '切页未生效：${page.id}');
    }
  });
}
