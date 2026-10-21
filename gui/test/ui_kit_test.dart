import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';

/// 交互基元的契约测试：toast 单条、确认框返回值、三态渲染、分页回调。
/// 这四个基元被所有页面复用，坏一次就是全站坏，所以在这里把行为锁死。
void main() {
  /// 宿主：与真实壳一致给 MaterialApp + Scaffold
  /// （toast 需要 ScaffoldMessenger，确认框需要 Navigator）。
  Future<void> pumpHost(WidgetTester tester, Widget Function(BuildContext) build) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: IrmiaTheme.light(),
        home: Scaffold(
          body: Builder(builder: (context) => Center(child: build(context))),
        ),
      ),
    );
    await tester.pump();
  }

  group('IrmiaToast', () {
    testWidgets('弹一次只有一条，图标随 kind，4 秒后自己走', (tester) async {
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      IrmiaToast.show(host, '已复制');
      await tester.pump();

      expect(find.byType(SnackBar), findsOneWidget);
      expect(find.text('已复制'), findsOneWidget);
      expect(find.byIcon(Icons.info_outline_rounded), findsOneWidget);
      expect(IrmiaToast.duration, const Duration(seconds: 4));
    });

    testWidgets('连续调用不叠条：只留最新那条', (tester) async {
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      IrmiaToast.show(host, '已复制');
      await tester.pump();
      IrmiaToast.show(host, '已保存', kind: ToastKind.success);
      await tester.pump();
      IrmiaToast.show(host, '写入失败：磁盘只读', kind: ToastKind.error);
      await tester.pump();

      expect(find.byType(SnackBar), findsOneWidget, reason: '同一时刻只应有一条 toast');
      expect(find.text('写入失败：磁盘只读'), findsOneWidget);
      expect(find.text('已复制'), findsNothing, reason: '旧消息不应排队补播');
      expect(find.text('已保存'), findsNothing);
      expect(find.byIcon(Icons.error_outline_rounded), findsOneWidget);

      // 进入动画走完才开始计 4 秒，4 秒后自己退场
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump(IrmiaToast.duration);
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pump();
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('浮动条按内容自适应宽度：短句窄、长句宽，都不超过上限', (tester) async {
      // 用户 ⑫："这个东西……不过太长了，能不能自适应长度和高度？"
      // 以前只给 margin，浮动条会撑满屏宽——七个字的提示也占一整条。
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      // 量的是那块**看得见的底**（SnackBar 外层的尺寸恒等于可用宽度，宽度是给它里面那层
      // SizedBox 的，见 snack_bar.dart 的 `SizedBox(width: width, child: snackBar)`）
      double pillWidth() => tester
          .getSize(find.descendant(of: find.byType(SnackBar), matching: find.byType(Material)).first)
          .width;

      IrmiaToast.show(host, '上下文已清空');
      await tester.pump();
      final short = pillWidth();

      IrmiaToast.show(host, '已保存，重启后生效：这份配置写进了 config.json，进程重启之后才接管');
      await tester.pump();
      final long = pillWidth();

      expect(short, greaterThanOrEqualTo(240), reason: '再短也留个下限，别缩成一条缝');
      expect(short, lessThan(long), reason: '宽度要跟着内容走');
      expect(long, lessThanOrEqualTo(560), reason: '长句封顶，再多就换行（高度自己长）');
    });

    testWidgets('没有 ScaffoldMessenger 时静默跳过，不打断调用方', (tester) async {
      await tester.pumpWidget(
        Directionality(
          textDirection: TextDirection.ltr,
          child: Builder(
            builder: (context) {
              IrmiaToast.show(context, '无处安放');
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.byType(SnackBar), findsNothing);
    });
  });

  group('confirm', () {
    testWidgets('确认返回 true，取消返回 false，对话框最宽 400', (tester) async {
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      final first = confirm(host, title: '删除这条记录', body: '删除后不再出现在列表中。', danger: true);
      await tester.pumpAndSettle();
      expect(find.text('删除这条记录'), findsOneWidget);
      expect(find.text('删除后不再出现在列表中。'), findsOneWidget);
      // 声明层面：约束就是 400
      expect(
        tester.widget<AlertDialog>(find.byType(AlertDialog)).constraints?.maxWidth,
        kDialogMaxWidth,
      );
      // 布局层面：AlertDialog 自身铺满窗口（外层是 Dialog 的 insetPadding），
      // 要量它内部第一层 ConstrainedBox 才是不铺满窗口的对话框本体
      final frame = tester.renderObject<RenderBox>(
        find.descendant(of: find.byType(AlertDialog), matching: find.byType(ConstrainedBox)).first,
      );
      expect(frame.size.width, lessThanOrEqualTo(kDialogMaxWidth), reason: '对话框不应铺满窗口');
      await tester.tap(find.text('确认'));
      await tester.pumpAndSettle();
      expect(await first, isTrue);
      expect(find.byType(AlertDialog), findsNothing);

      final second = confirm(host, title: '断开连接', confirmLabel: '断开');
      await tester.pumpAndSettle();
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(await second, isFalse);
    });

    testWidgets('点外部与按 Esc 都等同取消', (tester) async {
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      final outside = confirm(host, title: '重置设置');
      await tester.pumpAndSettle();
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      expect(await outside, isFalse, reason: '点对话框外部应当取消');
      expect(find.text('重置设置'), findsNothing);

      final escaped = confirm(host, title: '清空日志');
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(await escaped, isFalse, reason: 'Esc 应当取消');
      expect(find.text('清空日志'), findsNothing);
    });
  });

  group('confirmDestructive', () {
    testWidgets('勾选附带后果后才浮出不可撤销警示，勾选态回传给调用方', (tester) async {
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      final options = [
        ConfirmOption(label: '同时删除该扩展的配置'),
        ConfirmOption(
          label: '同时删除该扩展产生的数据',
          note: '删除后不可从备份恢复',
          tone: ConfirmTone.danger,
        ),
      ];

      final pending = confirmDestructive(
        host,
        title: '卸载扩展',
        options: options,
        warning: '卸载后需要重新安装并重新配置。',
      );
      await tester.pumpAndSettle();
      expect(find.text('卸载扩展'), findsOneWidget);
      expect(find.textContaining('操作不可撤销'), findsNothing, reason: '未勾选时不显示警示');

      await tester.tap(find.text('同时删除该扩展产生的数据'));
      await tester.pumpAndSettle();
      expect(find.textContaining('操作不可撤销'), findsOneWidget);
      expect(find.textContaining('卸载后需要重新安装并重新配置。'), findsOneWidget);

      await tester.tap(find.text('确认'));
      await tester.pumpAndSettle();
      expect(await pending, isTrue);
      expect(options[1].selected, isTrue, reason: '勾选项应回传给调用方');
      expect(options[0].selected, isFalse);
    });

    testWidgets('复用同一份 options 时先重置勾选；取消返回 false', (tester) async {
      late BuildContext host;
      await pumpHost(tester, (context) {
        host = context;
        return const SizedBox.shrink();
      });

      final options = [ConfirmOption(label: '同时删除该扩展的配置', selected: true)];

      final first = confirmDestructive(
        host,
        title: '卸载扩展',
        options: options,
        warning: '卸载后需要重新安装。',
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('操作不可撤销'), findsOneWidget, reason: '初始勾选也应有警示');
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(await first, isFalse);

      final second = confirmDestructive(
        host,
        title: '卸载扩展',
        options: options,
        warning: '卸载后需要重新安装。',
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('操作不可撤销'), findsOneWidget, reason: '回到初始勾选态');
      await tester.tap(find.text('确认'));
      await tester.pumpAndSettle();
      expect(await second, isTrue);
      expect(options.single.selected, isTrue);
    });
  });

  group('StateBlock', () {
    testWidgets('加载态：顶部 2px 进度线 + 一句说明', (tester) async {
      await pumpHost(tester, (context) => const StateBlock.loading(hint: '正在读取事件…'));

      final bar = tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator));
      expect(bar.minHeight, 2);
      expect(find.text('正在读取事件…'), findsOneWidget);
      expect(find.byType(StateBlock), findsOneWidget);
    });

    testWidgets('空态：42 图标 + 一句状态 + CTA', (tester) async {
      var tapped = 0;
      await pumpHost(
        tester,
        (context) => StateBlock.empty(
          icon: Icons.inbox_outlined,
          message: '暂无事件记录。',
          hint: '发生操作后事件会实时出现在这里。',
          action: StateBlock.cta('重新加载', () => tapped++),
        ),
      );

      final icon = tester.widget<Icon>(find.byIcon(Icons.inbox_outlined));
      expect(icon.size, kStateBlockIconSize);
      expect(find.text('暂无事件记录。'), findsOneWidget);
      expect(find.text('发生操作后事件会实时出现在这里。'), findsOneWidget);

      await tester.tap(find.text('重新加载'));
      await tester.pump();
      expect(tapped, 1);
    });

    testWidgets('失败态：错误图标 + 文案 + 重试', (tester) async {
      var retried = 0;
      await pumpHost(
        tester,
        (context) => StateBlock.error(
          message: '事件读取失败：连接已中断。',
          hint: '请确认主进程已启动（127.0.0.1:7788）。',
          onRetry: () => retried++,
        ),
      );

      expect(find.byIcon(Icons.error_outline_rounded), findsOneWidget);
      expect(find.text('事件读取失败：连接已中断。'), findsOneWidget);
      expect(find.text('请确认主进程已启动（127.0.0.1:7788）。'), findsOneWidget);

      await tester.tap(find.text('重试'));
      await tester.pump();
      expect(retried, 1);
    });
  });

  group('PagerBar', () {
    testWidgets('计数文案与翻页回调（受控，不自己改页码）', (tester) async {
      final pages = <int>[];
      await pumpHost(
        tester,
        (context) => SizedBox(
          width: 720,
          child: PagerBar(
            page: 2,
            pageSize: 20,
            total: 123,
            onPage: pages.add,
            onPageSize: (_) {},
          ),
        ),
      );

      expect(find.text('第 21-40 条 / 共 123 条'), findsOneWidget);
      expect(find.text('…'), findsNothing, reason: '7 页以内不需要省略号');

      await tester.tap(find.text('3'));
      await tester.pump();
      expect(pages, [3], reason: '点页码回传目标页');

      await tester.tap(find.byTooltip('下一页'));
      await tester.pump();
      expect(pages, [3, 3], reason: 'page 仍是 2，下一页应回传 3');

      await tester.tap(find.byTooltip('上一页'));
      await tester.pump();
      expect(pages.last, 1);
    });

    testWidgets('首页禁用「上一页」，末页禁用「下一页」', (tester) async {
      await pumpHost(
        tester,
        (context) => SizedBox(
          width: 720,
          child: PagerBar(
            page: 1,
            pageSize: 20,
            total: 123,
            onPage: (_) {},
            onPageSize: (_) {},
          ),
        ),
      );
      expect(
        tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.chevron_left_rounded)).onPressed,
        isNull,
      );

      await pumpHost(
        tester,
        (context) => SizedBox(
          width: 720,
          child: PagerBar(
            page: 7,
            pageSize: 20,
            total: 123,
            onPage: (_) {},
            onPageSize: (_) {},
          ),
        ),
      );
      expect(find.text('第 121-123 条 / 共 123 条'), findsOneWidget);
      expect(
        tester.widget<IconButton>(find.widgetWithIcon(IconButton, Icons.chevron_right_rounded)).onPressed,
        isNull,
      );
    });

    testWidgets('页数多时窗口跟随当前页，首尾固定 + 两侧省略号', (tester) async {
      await pumpHost(
        tester,
        (context) => SizedBox(
          width: 720,
          child: PagerBar(
            page: 50,
            pageSize: 10,
            total: 1000,
            onPage: (_) {},
            onPageSize: (_) {},
          ),
        ),
      );

      expect(find.text('第 491-500 条 / 共 1000 条'), findsOneWidget);
      expect(find.text('1'), findsOneWidget);
      expect(find.text('100'), findsOneWidget);
      for (final dot in ['49', '50', '51']) {
        expect(find.text(dot), findsOneWidget, reason: '当前页窗口缺 $dot');
      }
      expect(find.text('…'), findsNWidgets(2));
    });

    testWidgets('每页条数下拉回传新值，且容得下档位外的值', (tester) async {
      final sizes = <int>[];
      await pumpHost(
        tester,
        (context) => SizedBox(
          width: 720,
          child: PagerBar(
            page: 1,
            pageSize: 200,
            total: 500,
            onPage: (_) {},
            onPageSize: sizes.add,
          ),
        ),
      );

      expect(find.text('每页 200 条'), findsOneWidget, reason: '档位外的值也要能显示');
      await tester.tap(find.text('每页 200 条'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('每页 50 条').last);
      await tester.pumpAndSettle();
      expect(sizes, [50]);
    });
  });
}
