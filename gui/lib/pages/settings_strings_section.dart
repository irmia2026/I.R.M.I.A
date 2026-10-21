/// 设置页「界面」卡里的**「文案覆盖」那一格**：i18n 覆盖层的唯一设置入口。
///
/// 为什么单独一个文件（不是一个 `_xxxCell()` 私有方法）：设置页那一份文件正在被
/// "文案全量迁移"那条线大改；把这块独立出来，两边只在设置页里共用**一行调用**
/// （见 `settings_page.dart` 的 `_uiCard`），文件集不重叠，谁都不挡谁。
///
/// 它做的事就四件（都在 `i18n/strings_override.dart` 那一层有对应的实现）：
///   · 显示覆盖文件路径（等宽 + 可选中，手抄/局部复制都行）；
///   · 「打开文案文件」——用 `external_link.dart` 那唯一一条 opener 打开所在目录；
///   · 「重新载入文案」——`reloadStringsOverride()`，**不重启界面**；
///   · 「导出当前文案为模板」——同目录 `strings-override.template.json`，照着改。
/// 外加一行状态：未使用覆盖 / 已加载 N 条 / 解析失败（旁注再报"有几条键没被采用"）。
///
/// 状态的颜色是唯一的视觉判断：失败红、有覆盖绿、没覆盖灰。
library;

import 'dart:async';

import 'package:flutter/material.dart';

// 开外链/开目录全仓只有这一条实现（与引导页推荐链接、设置页下载页同一个 opener）
import '../external_link.dart';
import '../i18n/strings_override.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../theme/design_tokens.dart';
import '../ui_kit.dart';

/// 「文案覆盖」那一格：标签 + 路径 + 三个动作 + 一行状态 + 旁注。
///
/// 视觉上与设置页的 `_FieldCell` 同一套口径（标签 12.5/w500、旁注 11.5/1.6 灰），
/// 内边距与圆角走 design_tokens，不在这里另立一套。
class StringsOverrideSection extends StatelessWidget {
  const StringsOverrideSection({super.key});

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final faint = IrmiaInk.of(context).faint;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          s.settingsStringsOverride,
          style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500),
        ),
        const SizedBox(height: 6),
        // 路径：等宽 + 可选中 ＋ 一颗直接打开的按钮。
        // 开的是**目录**不是文件：文件可能还不存在（第一次用的人得先建/导出模板）。
        Container(
          padding: const EdgeInsets.fromLTRB(Space.x3, Space.x2, Space.x1, Space.x2),
          decoration: BoxDecoration(
            color: scheme.surfaceContainer,
            borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
            border: Border.all(color: scheme.outlineVariant),
          ),
          child: Row(
            children: [
              Expanded(
                child: SelectableText(
                  stringsOverridePath(),
                  key: const ValueKey('strings-override-path'),
                  style: Type.mono(faint),
                ),
              ),
              const SizedBox(width: Space.x2),
              TextButton(
                key: const ValueKey('strings-override-open'),
                onPressed: () => unawaited(_open(context)),
                child: Text(s.stringsOverrideOpen),
              ),
            ],
          ),
        ),
        const SizedBox(height: Space.x2),
        // 两颗动作并排；窄窗自动折行（Wrap，不用 Row：设置页在 900 以下会降一列）
        Wrap(
          spacing: Space.x2,
          runSpacing: Space.x2,
          children: [
            OutlinedButton(
              key: const ValueKey('strings-override-reload'),
              onPressed: () => unawaited(_reload(context)),
              child: Text(s.stringsOverrideReload),
            ),
            OutlinedButton(
              key: const ValueKey('strings-override-export'),
              onPressed: () => unawaited(_export(context)),
              child: Text(s.stringsOverrideExport),
            ),
          ],
        ),
        const SizedBox(height: Space.x2),
        ValueListenableBuilder<StringsOverrideSnapshot>(
          valueListenable: stringsOverrideState,
          builder: (context, snapshot, _) {
            final tone = snapshot.failed
                ? IrmiaTheme.danger
                : snapshot.total > 0
                    ? IrmiaTheme.ok
                    : faint;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  stringsOverrideStatusLine(s, snapshot),
                  key: const ValueKey('strings-override-status'),
                  style: Type.caption.style(color: tone),
                ),
                // 不认识的键另起一行：它是"我改了怎么没变"的答案，但不属于三态之一
                if (snapshot.ignored.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: Space.x1),
                    child: Text(
                      s.stringsOverrideIgnored(snapshot.ignored.length),
                      key: const ValueKey('strings-override-ignored'),
                      style: Type.caption.style(color: IrmiaTheme.warn),
                    ),
                  ),
              ],
            );
          },
        ),
        const SizedBox(height: 6),
        Text(
          s.settingsStringsOverrideNote,
          style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }

  /// 打开覆盖文件所在目录（打不开就把路径说一遍——那是唯一不靠外部程序也能拿到它的方式）
  Future<void> _open(BuildContext context) async {
    final s = IrmiaStrings.read(context);
    final dir = stringsOverrideDir();
    final opened = await openExternalUrl(dir);
    if (!opened && context.mounted) {
      IrmiaToast.show(context, s.stringsOverrideOpenFailed(dir), kind: ToastKind.warn);
    }
  }

  /// 重新读覆盖文件。**不重启界面**：换 notifier 的值，根与这一行状态一起重建。
  ///
  /// 回执直接用状态行那一句（成功/失败同一句，人不用在两处措辞之间对照）。
  Future<void> _reload(BuildContext context) async {
    final s = IrmiaStrings.read(context);
    final snapshot = await reloadStringsOverride(language: effectiveLanguage.value);
    if (!context.mounted) return;
    IrmiaToast.show(
      context,
      stringsOverrideStatusLine(s, snapshot),
      kind: snapshot.failed ? ToastKind.warn : ToastKind.success,
    );
  }

  /// 把**当前语言**的全部文案导出成模板（同目录 `strings-override.template.json`）
  Future<void> _export(BuildContext context) async {
    final s = IrmiaStrings.read(context);
    try {
      final path = await exportStringsTemplate(language: effectiveLanguage.value);
      if (context.mounted) {
        IrmiaToast.show(context, s.stringsOverrideExported(path), kind: ToastKind.success);
      }
    } catch (err) {
      if (context.mounted) {
        IrmiaToast.show(context, s.stringsOverrideExportFailed('$err'), kind: ToastKind.warn);
      }
    }
  }
}
