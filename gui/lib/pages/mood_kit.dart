// 情绪面板的共用版式件（2026-11-05 从 `mood_page.dart` 抽出）。
//
// 为什么单独成文件：`子代理` 是第二个「后台/亲密」类页面，用户明确要求它**沿用情绪面板**
// 的 surface / 圆角 / 描边 / 发丝影、字号与明暗两套底色，不要另造一套主题。把 `_Skin`、
// `_panelFrame`、`_PanelTop`、`_SectionBadge` 搬到这里之后，两个页面拿的是同一份数值：
// 改一处两边一起动，不会再出现"情绪页暖、子代理页冷"的两个表面。
//
// 这里只放版式件，不放页面数据，也不包一层 Theme：明暗仍由 `Theme.of(context)` 决定。
import 'package:flutter/material.dart';

import '../theme.dart';

/// 设计稿的取色在亮色模直接落常量；暗色模换一套可读的底与字（形状与色相语言不变）。
class MoodPanelSkin {
  const MoodPanelSkin({
    required this.bg,
    required this.card,
    required this.ink,
    required this.heading,
    required this.title,
    required this.muted,
    required this.mutedSoft,
    required this.edge,
    required this.primary,
    required this.soft,
    required this.track,
    required this.chipBg,
    required this.chipBorder,
    required this.tabBg,
    required this.tabActive,
    required this.hover,
    required this.sheetBg,
    required this.statValue,
    required this.deltaUpBg,
    required this.deltaDownBg,
    required this.chartGrid,
    required this.shadow,
    required this.tabShadow,
  });

  final Color bg;
  final Color card;
  final Color ink;
  final Color heading;
  final Color title;
  final Color muted;
  final Color mutedSoft;
  final Color edge;
  final Color primary;
  final Color soft;
  final Color track;
  final Color chipBg;
  final Color chipBorder;
  final Color tabBg;
  final Color tabActive;
  final Color hover;
  final Color sheetBg;
  final Color statValue;
  final Color deltaUpBg;
  final Color deltaDownBg;
  final Color chartGrid;
  final List<BoxShadow> shadow;
  final List<BoxShadow> tabShadow;

  static MoodPanelSkin of(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    if (theme.brightness == Brightness.light) {
      return const MoodPanelSkin(
        bg: MoodPalette.shell,
        card: MoodPalette.card,
        ink: MoodPalette.ink,
        heading: MoodPalette.heading,
        title: MoodPalette.title,
        muted: MoodPalette.muted,
        mutedSoft: MoodPalette.mutedSoft,
        edge: MoodPalette.edge,
        primary: MoodPalette.primary,
        soft: MoodPalette.primarySoft,
        track: MoodPalette.track,
        chipBg: MoodPalette.chipBg,
        chipBorder: MoodPalette.chipBorder,
        tabBg: Color(0xFFF4F7FA),
        tabActive: Color(0xFF5E82A8),
        hover: MoodPalette.hover,
        sheetBg: MoodPalette.sheetBg,
        statValue: Color(0xFF4A6E91),
        deltaUpBg: MoodPalette.chartDeltaUpBg,
        deltaDownBg: MoodPalette.chartDeltaDownBg,
        chartGrid: MoodPalette.chartGrid,
        shadow: MoodPalette.cardShadow,
        tabShadow: <BoxShadow>[
          BoxShadow(
            color: Color(0x12445A75),
            blurRadius: 4,
            offset: Offset(0, 1),
          ),
        ],
      );
    }
    return MoodPanelSkin(
      bg: scheme.surface,
      card: scheme.surfaceContainer,
      ink: scheme.onSurface,
      heading: scheme.onSurface,
      title: scheme.onSurface,
      muted: scheme.onSurfaceVariant,
      mutedSoft: scheme.onSurfaceVariant,
      edge: scheme.outlineVariant,
      primary: scheme.primary,
      soft: scheme.surfaceContainerHighest,
      track: scheme.surfaceContainerHighest,
      chipBg: scheme.surfaceContainer,
      chipBorder: scheme.outlineVariant,
      tabBg: scheme.surfaceContainerHighest,
      tabActive: scheme.primary,
      hover: scheme.surfaceContainerHighest,
      sheetBg: scheme.surfaceContainer,
      statValue: scheme.primary,
      deltaUpBg: scheme.surfaceContainerHighest,
      deltaDownBg: scheme.surfaceContainerHighest,
      chartGrid: scheme.outlineVariant,
      shadow: const <BoxShadow>[
        BoxShadow(
          color: Color(0x40000000),
          blurRadius: 30,
          offset: Offset(0, 12),
        ),
      ],
      tabShadow: const <BoxShadow>[
        BoxShadow(
          color: Color(0x33000000),
          blurRadius: 4,
          offset: Offset(0, 1),
        ),
      ],
    );
  }
}

class MoodPanelTop extends StatelessWidget {
  const MoodPanelTop({
    super.key,
    required this.icon,
    required this.title,
    required this.skin,
    this.caption,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final MoodPanelSkin skin;
  final String? caption;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        MoodSectionBadge(icon: icon, skin: skin),
        const SizedBox(width: 9),
        Text(
          title,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w700,
            color: skin.title,
          ),
        ),
        const Spacer(),
        if (trailing != null)
          trailing!
        else if (caption != null)
          Flexible(
            child: Text(
              caption!,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 10, color: skin.mutedSoft),
            ),
          ),
      ],
    );
  }
}

class MoodSectionBadge extends StatelessWidget {
  const MoodSectionBadge({super.key, required this.icon, required this.skin});

  final IconData icon;
  final MoodPanelSkin skin;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 23,
      height: 23,
      decoration: BoxDecoration(
        color: skin.soft,
        borderRadius: BorderRadius.circular(7),
      ),
      child: Icon(icon, size: 14, color: skin.primary),
    );
  }
}

Widget moodPanelFrame(
  MoodPanelSkin skin, {
  Key? key,
  required Widget child,
  required EdgeInsets padding,
}) => Container(
  key: key,
  decoration: BoxDecoration(
    color: skin.card,
    borderRadius: BorderRadius.circular(MoodPalette.radius),
    border: Border.all(color: skin.edge),
    boxShadow: skin.shadow,
  ),
  child: Padding(padding: padding, child: child),
);

/// 状态点的取色（只跟状态名有关，不另造色表）。
Color moodStatusColor(String status, ColorScheme scheme) => switch (status) {
  'running' || 'waiting' || 'reporting' => IrmiaTheme.ok,
  'queued' => IrmiaTheme.warn,
  'interrupted' => IrmiaTheme.warn,
  'completed' => scheme.primary,
  'cancelled' || 'archived' => scheme.onSurfaceVariant,
  _ => scheme.onSurfaceVariant,
};
