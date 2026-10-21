import 'dart:async';

import 'package:flutter/material.dart';

import 'her_name.dart';
import 'window_channel.dart';

/// 自绘标题栏（docs/gui-revision.md ①）：系统标题栏已经被去掉，这条由 Flutter 画。
///
/// 规格来自用户：左侧原有的「图标 + Irmia Agent」整组不要了，标题居中；
/// 右上角两个细线按钮——最小化、关闭（窗口固定尺寸，没有最大化这个状态）。
/// 底色取与侧栏同一个 surfaceContainer，这样顶栏和左栏连成一整块，看着是一个架子。
class IrmiaTitleBar extends StatelessWidget {
  const IrmiaTitleBar({super.key});

  /// 标题栏高度（逻辑像素）
  static const double height = 36;

  /// 标题文字：**产品名**，不是她的名字——两者是两件事（见 her_name.dart 的 kProductName）。
  /// 她的名字在窗口标题（MaterialApp.title）与正文里表达。
  static const String title = kProductName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final isDark = theme.brightness == Brightness.dark;

    // 悬停底色照 Windows 的手感：普通按钮淡淡一层，关闭键变红、图形转白。
    final hoverFill = isDark ? const Color(0x1FFFFFFF) : const Color(0x0F000000);
    const closeFill = Color(0xFFC42B1C);

    return DefaultTextStyle(
      style: theme.textTheme.bodyMedium ?? const TextStyle(),
      child: Container(
        height: height,
        decoration: BoxDecoration(
          color: scheme.surfaceContainer,
          border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
        ),
        child: Stack(
          children: [
            // 拖动区是 Stack 的底层，不是整条标题栏的父级——做成父级的话，按右侧
            // 按钮的手势会先被它收走，点最小化会变成拖窗口。
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                // 按下即拖，与真实标题栏一致（不等 18px 的拖拽阈值）
                onPanDown: (_) => unawaited(WindowChannel.startDragging()),
              ),
            ),
            // 标题不吃命中测试，否则"按在字上"拖不动窗口
            Positioned.fill(
              child: IgnorePointer(
                child: Center(
                  child: Text(
                    title,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0.2,
                      color: scheme.onSurface,
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              right: 0,
              top: 0,
              bottom: 0,
              child: Row(
                children: [
                  _CaptionButton(
                    glyph: _Glyph.minimize,
                    hoverFill: hoverFill,
                    onTap: WindowChannel.minimize,
                  ),
                  _CaptionButton(
                    glyph: _Glyph.close,
                    hoverFill: closeFill,
                    hoverGlyph: Colors.white,
                    onTap: WindowChannel.close,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 窗口按钮：无背景块、无边框，只有悬停时才浮出一层底色
class _CaptionButton extends StatefulWidget {
  const _CaptionButton({
    required this.glyph,
    required this.hoverFill,
    required this.onTap,
    this.hoverGlyph,
  });

  final _Glyph glyph;
  final Color hoverFill;
  final Color? hoverGlyph;
  final Future<void> Function() onTap;

  /// 宽度照 Windows 的窗口按钮（高取标题栏高度，悬停底色才会铺满一角）
  static const double width = 45;

  @override
  State<_CaptionButton> createState() => _CaptionButtonState();
}

class _CaptionButtonState extends State<_CaptionButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => unawaited(widget.onTap()),
        child: Container(
          width: _CaptionButton.width,
          height: IrmiaTitleBar.height,
          color: _hover ? widget.hoverFill : Colors.transparent,
          child: CustomPaint(
            painter: _GlyphPainter(
              glyph: widget.glyph,
              color: _hover
                  ? (widget.hoverGlyph ?? scheme.onSurface)
                  : scheme.onSurfaceVariant,
              dpr: MediaQuery.devicePixelRatioOf(context),
            ),
          ),
        ),
      ),
    );
  }
}

/// 窗口图形：统一 10×10、1px 细线、不填充
enum _Glyph { minimize, close }

class _GlyphPainter extends CustomPainter {
  const _GlyphPainter({required this.glyph, required this.color, required this.dpr});

  final _Glyph glyph;
  final Color color;
  final double dpr;

  /// 图形半边长
  static const double _half = 5;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..strokeCap = StrokeCap.square;

    // 1px 的细线要压在设备像素的中间才不糊（画在整数坐标上会跨两个像素，看起来发灰）
    final cx = _snapCenter(size.width / 2);
    final cy = _snapCenter(size.height / 2);

    switch (glyph) {
      case _Glyph.minimize:
        final left = _snapEdge(cx - _half);
        final right = _snapEdge(cx + _half);
        canvas.drawLine(Offset(left, cy), Offset(right, cy), paint);
      case _Glyph.close:
        canvas.drawLine(
          Offset(cx - _half, cy - _half),
          Offset(cx + _half, cy + _half),
          paint,
        );
        canvas.drawLine(
          Offset(cx - _half, cy + _half),
          Offset(cx + _half, cy - _half),
          paint,
        );
    }
  }

  /// 线条中心：落在设备像素正中
  double _snapCenter(double v) => ((v * dpr).floorToDouble() + 0.5) / dpr;

  /// 线条端点：落在设备像素边界上（方头才切得齐）
  double _snapEdge(double v) => (v * dpr).roundToDouble() / dpr;

  @override
  bool shouldRepaint(_GlyphPainter old) =>
      old.glyph != glyph || old.color != color || old.dpr != dpr;
}
