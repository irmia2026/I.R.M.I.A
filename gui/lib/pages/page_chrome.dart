// TODO(i18n): 本文件还有 4 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/page_chrome.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'package:flutter/material.dart';

import '../theme.dart';

/// 页面骨架四件套（依据 docs/astrbot-benchmark.md §3.3 引导头 / §3.4 降复杂度）：
/// 统一页头 · 空态引导条 · 行数收口 · 技术字段折叠。
/// 各页只做数据分派，版式与文案骨架在此收口，避免逐页各写一套。

/// 列表默认行数：超出部分收进「查看全部」
const kListCap = 8;

/// 页头：标题 + 一句名词化副标题（说明这页干什么）；右侧可挂动作，下方可挂分段控件。
///
/// [eyebrow] 与 [titleSize] 是**可选**的（默认不出现/沿用 20）：日程页照设计稿要一条英文小字
/// 加一个更大的标题，而其余各页版式不动——所以做成参数而不是改默认值。
class PageHeader extends StatelessWidget {
  const PageHeader({
    super.key,
    required this.title,
    required this.subtitle,
    this.action,
    this.bottom,
    this.eyebrow,
    this.titleSize,
  });

  final String title;
  final String subtitle;
  final Widget? action;
  final Widget? bottom;

  /// 标题上方那条小字（全大写英文那种 eyebrow）；null = 不占高度
  final String? eyebrow;

  /// 标题字号；null = 20（既有各页的版式）
  final double? titleSize;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(26, 22, 26, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (eyebrow != null) ...[
                      Text(
                        eyebrow!,
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.1,
                          color: scheme.primary,
                        ),
                      ),
                      const SizedBox(height: 7),
                    ],
                    Text(title,
                        style: TextStyle(
                            fontSize: titleSize ?? 20, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 4),
                    Text(subtitle, style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
                  ],
                ),
              ),
              if (action != null) action!,
            ],
          ),
          if (bottom != null) ...[const SizedBox(height: 16), bottom!],
        ],
      ),
    );
  }
}

/// 空态引导条，固定句式：[图标] 还没有 X。从这里开始：[按钮]
/// hint 补一句下一步说明（可选），tone 用于失败类引导
class GuideBar extends StatelessWidget {
  const GuideBar({
    super.key,
    required this.icon,
    required this.text,
    required this.actionLabel,
    required this.onAction,
    this.hint,
    this.tone,
  });

  final IconData icon;

  /// 状态句，以「还没有 X。」结尾；「从这里开始：」由本组件补足
  final String text;
  final String actionLabel;
  final VoidCallback onAction;
  final String? hint;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final color = tone ?? scheme.primary;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 10, 12, 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: color.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 2,
            children: [
              Icon(icon, size: 16, color: color),
              Text('$text从这里开始：',
                  style: TextStyle(fontSize: 13, height: 1.5, color: scheme.onSurface)),
              TextButton(
                onPressed: onAction,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  minimumSize: const Size(0, 30),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(actionLabel),
              ),
            ],
          ),
          if (hint != null)
            Padding(
              padding: const EdgeInsets.only(left: 24, top: 2),
              child: Text(hint!,
                  style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant)),
            ),
        ],
      ),
    );
  }
}

/// 行数收口：超过 cap 行时只摆前 cap 行，底部给「查看全部（N 行）」
class CappedChildren extends StatefulWidget {
  const CappedChildren({super.key, required this.children, this.cap = kListCap});

  final List<Widget> children;
  final int cap;

  @override
  State<CappedChildren> createState() => _CappedChildrenState();
}

class _CappedChildrenState extends State<CappedChildren> {
  bool expanded = false;

  @override
  Widget build(BuildContext context) {
    final all = widget.children;
    if (all.length <= widget.cap) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: all);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ...(expanded ? all : all.sublist(0, widget.cap)),
        Align(
          alignment: Alignment.centerLeft,
          child: _Toggle(
            label: expanded ? '收起' : '查看全部（${all.length} 行）',
            open: expanded,
            onTap: () => setState(() => expanded = !expanded),
          ),
        ),
      ],
    );
  }
}

/// 技术字段折叠：watermark / seq / diffHash / 配置点路径等默认收起，点「详情」才显示
class DetailFold extends StatefulWidget {
  const DetailFold({super.key, required this.child, this.label = '详情', this.initialOpen = false});

  final Widget child;
  final String label;
  final bool initialOpen;

  @override
  State<DetailFold> createState() => _DetailFoldState();
}

class _DetailFoldState extends State<DetailFold> {
  late bool open = widget.initialOpen;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Toggle(
          label: open ? '收起${widget.label}' : widget.label,
          open: open,
          onTap: () => setState(() => open = !open),
        ),
        if (open)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(top: 6),
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
              border: Border.all(color: scheme.outlineVariant),
            ),
            child: widget.child,
          ),
      ],
    );
  }
}

/// 详情区内的键值行：标签左、等宽值右
class DetailRow extends StatelessWidget {
  const DetailRow({super.key, required this.label, required this.value, this.labelWidth = 96});

  final String label;
  final String value;
  final double labelWidth;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: labelWidth,
            child: Text(label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              value,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 11.5,
                height: 1.5,
                color: scheme.onSurface,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 折叠开关：文字按钮 + 方向箭头，各页共用一套手感
class _Toggle extends StatelessWidget {
  const _Toggle({required this.label, required this.open, required this.onTap});

  final String label;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return TextButton.icon(
      onPressed: onTap,
      icon: Icon(open ? Icons.expand_less_rounded : Icons.unfold_more_rounded, size: 16),
      label: Text(label, style: const TextStyle(fontSize: 12.5)),
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        minimumSize: const Size(0, 30),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
    );
  }
}
