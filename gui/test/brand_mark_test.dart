import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/theme.dart';

/// IRMIA 图案（[BrandMark] / [HerFace]）的几条约定，逐条钉住：
///
///   ① **资源真的在、而且是纯净的单色 + alpha**：图案是从矢量导出的 PNG，
///      形状全在 alpha 通道里，RGB 只有一个值。带上这条是因为"资源没进 pubspec"
///      或"某次换色把 RGB 弄花了"都属于**不会编译报错**的坏法——只会在界面上
///      表现为一枚隐形/发糊的图标，靠人眼盯容易漏。
///   ② **两档几何各自成套**：`mark-48`（顶栏卡片）与 `mark-16`（小头像的加强版，
///      针尖加粗）。两档都要 1x/2x/3x 齐，且三份是**不同**的位图（同一份拷贝改名
///      在高分屏上会糊）。
///   ③ **按主题选色**：浅色主题取蓝版，深色主题取白版。断言落在真正交给 [Image]
///      的资产路径上，不是注释里。
///   ④ **不拉伸**：图案是 1.2:1 的横宽比（环比星芒宽），任何一处都必须按原始宽高比
///      缩放——`BoxFit.contain`，不是 fill。
///
/// 这里**不**断言图案怎么画：那由 brand/tools 的几何脚本负责，界面只负责选对文件。
void main() {
  /// 从仓库根找到 gui/assets/brand（`flutter test` 的工作目录就是 gui/）
  Directory brandDir() {
    final direct = Directory('assets/brand');
    if (direct.existsSync()) return direct;
    return Directory('gui/assets/brand');
  }

  /// 每一档：1x 文件名 -> 1x 边长。变体目录 -> 倍数。
  /// 1.5x 不是凑数：这台机器就是 150% 缩放，没有它 48 逻辑像素的标识会被放大 1.5 倍。
  const tiers = {
    'mark-48.png': 48,
    'mark-48-blue.png': 48,
    'mark-16.png': 16,
    'mark-16-blue.png': 16,
  };
  const densities = {'': 1, '1.5x/': 1.5, '2.0x/': 2, '3.0x/': 3};

  test('图案资源齐备：两档几何 × 白/蓝 × 1x/1.5x/2x/3x', () {
    final dir = brandDir();
    expect(dir.existsSync(), isTrue, reason: '找不到 assets/brand：${dir.absolute.path}');

    for (final name in tiers.keys) {
      for (final density in densities.keys) {
        final f = File('${dir.path}/$density$name');
        expect(f.existsSync(), isTrue, reason: '缺资源：assets/brand/$density$name');
        expect(f.lengthSync(), greaterThan(0), reason: '资源是空文件：$density$name');
      }
    }

    // 四份必须是不同的位图，不是同一份拷贝改名
    for (final name in tiers.keys) {
      final sizes =
          densities.keys.map((d) => File('${dir.path}/$d$name').lengthSync()).toSet();
      expect(sizes.length, densities.length, reason: '$name 的变体疑似同一份文件');
    }
  });

  test('PNG 是单色 + alpha（形状只在 alpha 里），尺寸就是声明的档位', () {
    // 只读 PNG 头，不引第三方解码库：宽高在 IHDR 里（偏移 16..24）
    int beInt(List<int> b, int at) =>
        (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];

    final dir = brandDir();
    for (final entry in tiers.entries) {
      for (final scale in densities.entries) {
        final path = '${dir.path}/${scale.key}${entry.key}';
        final bytes = File(path).readAsBytesSync();
        expect(bytes.sublist(0, 8), [137, 80, 78, 71, 13, 10, 26, 10],
            reason: '不是 PNG：$path');
        expect(bytes[24], 8, reason: '位深应为 8：$path');
        // 颜色类型 6 = RGBA（图案要透明底，不能是不带 alpha 的 2/0）
        expect(bytes[25], 6, reason: '应为 RGBA（透明底）：$path');
        final want = (entry.value * scale.value).round();
        expect(beInt(bytes, 16), want, reason: '宽度不对：$path');
        expect(beInt(bytes, 20), want, reason: '高度不对：$path');
      }
    }
  });

  /// 取真正交给 [Image] 的资产路径
  String assetOf(WidgetTester tester, Finder finder) {
    final img = tester.widget<Image>(
        find.descendant(of: finder, matching: find.byType(Image)).first);
    final provider = img.image;
    expect(provider, isA<AssetImage>(), reason: '应从 assets 取图');
    return (provider as AssetImage).assetName;
  }

  /// 图案必须按原始宽高比缩放：这一条是用户看着侧栏那枚图案说"比例发扁"之后加的
  void expectNoStretch(WidgetTester tester, Finder finder) {
    final img = tester.widget<Image>(
        find.descendant(of: finder, matching: find.byType(Image)).first);
    expect(img.fit, BoxFit.contain, reason: '图案不许被拉伸（fill 会改变它的宽高比）');
    final box = tester.getSize(find.descendant(of: finder, matching: find.byType(Image)).first);
    expect(box.width, box.height, reason: '图案的画布是正方形，靠 contain 保住图案本身的宽高比');
  }

  /// 每次 pump 用**不同的 key**：同一个 key 时 `pumpWidget` 会复用 element、
  /// 只改 `themeMode` 不会让已经建好的 `Image` 重新选资源（这条踩过一次）。
  var pumpSeq = 0;
  Future<void> pump(WidgetTester tester, ThemeMode mode, Widget child) async {
    await tester.pumpWidget(MaterialApp(
      key: ValueKey('pump-${pumpSeq++}'),
      theme: IrmiaTheme.light(),
      darkTheme: IrmiaTheme.dark(),
      themeMode: mode,
      home: Scaffold(body: Center(child: child)),
    ));
  }

  testWidgets('BrandMark：浅色取蓝版大图，深色取白版', (tester) async {
    await pump(tester, ThemeMode.light, const BrandMark(size: 48));
    expect(assetOf(tester, find.byType(BrandMark)), 'assets/brand/mark-48-blue.png');
    final box = tester.getSize(find.byType(BrandMark));
    expect(box, const Size(48, 48), reason: '外接方框应等于 size（版式要跟原来对齐）');
    expectNoStretch(tester, find.byType(BrandMark));

    await pump(tester, ThemeMode.dark, const BrandMark(size: 48));
    expect(assetOf(tester, find.byType(BrandMark)), 'assets/brand/mark-48.png');
  });

  testWidgets('HerFace 头像：浅色取蓝版小图（加强档），深色取白版', (tester) async {
    await pump(tester, ThemeMode.light, const HerFace(size: 24));
    expect(assetOf(tester, find.byType(HerFace)), 'assets/brand/mark-16-blue.png');
    expect(tester.getSize(find.byType(HerFace)), const Size(24, 24),
        reason: '头像尺寸就是它占的版位');
    expectNoStretch(tester, find.byType(HerFace));

    await pump(tester, ThemeMode.dark, const HerFace(size: 24));
    expect(assetOf(tester, find.byType(HerFace)), 'assets/brand/mark-16.png');
  });

  testWidgets('大头像（空会话页那枚 56）改用大档底图，不许拉小图', (tester) async {
    // 小档只有 16 的底图，56 就是 3.5 倍拉伸；大档才有 48/96/144 那一套
    await pump(tester, ThemeMode.light, const HerFace(size: 56));
    expect(assetOf(tester, find.byType(HerFace)), 'assets/brand/mark-48-blue.png');
    await pump(tester, ThemeMode.dark, const HerFace(size: 56));
    expect(assetOf(tester, find.byType(HerFace)), 'assets/brand/mark-48.png');
  });

  testWidgets('两处都没有"通用字形"了：子树里不该再有 CustomPaint', (tester) async {
    // 原来那枚是「底色块 + paintHerMark 画的灵鹿衔火」= CustomPaint。
    // 图案版只剩一张图。
    await pump(tester, ThemeMode.light, const BrandMark(size: 48));
    expect(find.descendant(of: find.byType(BrandMark), matching: find.byType(CustomPaint)),
        findsNothing);

    await pump(tester, ThemeMode.light, const HerFace(size: 24));
    expect(find.descendant(of: find.byType(HerFace), matching: find.byType(CustomPaint)),
        findsNothing,
        reason: '头像里的字形应已换成图案');
  });

  testWidgets('BrandMark 不给自己加底：没有 decoration 包着', (tester) async {
    await pump(tester, ThemeMode.light, const BrandMark(size: 48));
    expect(
        find.descendant(of: find.byType(BrandMark), matching: find.byType(Container)),
        findsNothing,
        reason: '用户不要圆角底色块');
  });
}
