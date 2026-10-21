/// 文案的注入与切换（i18n 的运行时那一半）。
///
/// 三件事：
///   1. [IrmiaStrings] —— 一个 `InheritedWidget`，页面用 `IrmiaStrings.of(context)` 取文案；
///   2. [languagePreference] / [effectiveLanguage] —— 两个 `ValueNotifier`：
///      前者是**用户选的**（可能是"跟随系统"），后者是**解析后的具体语言**（永远是 zh/en）。
///      切换语言 = 改这两个 + 落盘，**不重启**：根的 `ValueListenableBuilder` 重建
///      `MaterialApp`，一整棵树跟着换文案；
///   3. 落盘走**既有的界面状态文件** `%APPDATA%/Irmia/ui-state.json`（见 `ui_state.dart`），
///      键 [kLanguageFlag]。**不碰后端 config.json**：语言是界面偏好，不是她的配置。
///
/// ## 为什么不引 `shared_preferences`
///
/// 这个仓库已经有一份零依赖的本机状态文件（`ui_state.dart`，「关窗收进托盘」就存在那儿），
/// 加 `shared_preferences` 等于为**一个字符串**再引入一个平台插件（Windows 侧还要重建
/// CMake 插件列表）。既有机制够用，就不该多一条依赖链。
///
/// ## 为什么「跟随系统」不在 widget 树里解析
///
/// 树里读平台 locale 会让 widget 测试的结果取决于跑测试那台机器的系统语言——本机是
/// 中文，CI 上可能就是英文，同一份用例两种结论。所以解析只发生在**入口**（`main.dart`
/// 调一次 [restoreLanguage]），树里拿到的永远是具体的 zh/en。
library;

import 'package:flutter/widgets.dart';

import '../ui_state.dart';
import 'app_strings.dart';
import 'strings_override.dart';

/// 语言偏好在本机状态文件里的键名。
///
/// 取值就是 [AppLanguage.code]（`system` / `zh` / `en`）。**改它就是改契约**：
/// 老文件里读不到（或读到认不出的值）一律回「跟随系统」，不会把界面卡住。
const String kLanguageFlag = 'language';

/// 用户选的语言偏好（可能是「跟随系统」）。
///
/// 默认 [AppLanguage.system]：设置页的下拉框要显示"我选的是什么"，而不是"现在生效的是什么"。
final ValueNotifier<AppLanguage> languagePreference =
    ValueNotifier<AppLanguage>(AppLanguage.system);

/// **实际生效**的具体语言（永远不是 [AppLanguage.system]）。
///
/// 默认中文：这是界面的作者语言，也让不挂 scope 的 widget 测试有确定的基准。
/// 入口（`main.dart`）在 `runApp` 之前会按盘上的偏好 + 系统 locale 把它定下来。
final ValueNotifier<AppLanguage> effectiveLanguage =
    ValueNotifier<AppLanguage>(AppLanguage.zh);

/// 当前生效的文案表（给 `MaterialApp` 那一层用）。
///
/// **走覆盖层**：`%APPDATA%\Irmia\strings-override.json` 里的值压过默认文案
/// （解析顺序见 `strings_override.dart`）。没覆盖时返回的就是 `const ZhStrings()` /
/// `const EnStrings()` 本身——没配覆盖的机器与加这一层之前逐字节等价。
AppStrings get currentStrings => resolveStrings(effectiveLanguage.value);

/// 切换语言：偏好与生效值一起改，再落盘。
///
/// **同值不发通知**（[ValueNotifier] 自己的语义）：选一个已经选中的语言不会让整棵
/// `MaterialApp` 重建——这条有测试钉着（`test/i18n_test.dart` 的"同值不重建"）。
///
/// [systemLocale] 只在 [preference] 是 `system` 时用得上；树里调用时传
/// `Localizations.maybeLocaleOf(context)` 或省略（省略则沿用当前生效值，即"跟随系统"
/// 在只换主题这类操作里不会因为读不到 locale 而漂回中文）。
Future<void> setLanguage(AppLanguage preference, {Locale? systemLocale}) async {
  languagePreference.value = preference;
  final next = preference == AppLanguage.system && systemLocale == null
      // 没有系统 locale 可选时，"跟随系统"就保持当前这个（不猜）
      ? (effectiveLanguage.value == AppLanguage.system ? AppLanguage.zh : effectiveLanguage.value)
      : preference.resolve(systemLocale);
  effectiveLanguage.value = next;
  await saveString(kLanguageFlag, preference.code);
}

/// 从本机状态文件读回语言偏好，并解析出要生效的具体语言。
///
/// 只在入口调一次（`main.dart`）。读盘失败 → 「跟随系统」（`ui_state.dart` 里失败静默）。
Future<AppLanguage> restoreLanguage({Locale? systemLocale}) async {
  final stored = await loadString(kLanguageFlag);
  final preference = AppLanguage.fromCode(stored);
  languagePreference.value = preference;
  effectiveLanguage.value = preference.resolve(systemLocale);
  return effectiveLanguage.value;
}

/// 把文案表放进子树。**取不到时回中文**（[ZhStrings]）：
///   · 页面被单独 pump 的 widget 测试不必每处都包一层；
///   · 真机上它一定在（见 `app.dart` 的 `MaterialApp.builder`）。
///
/// 兜底这一支**不套覆盖层**：它是"没人注入"的测试姿态，不该因为跑测试那台机器
/// `%APPDATA%` 里恰好有一份 `strings-override.json` 就让结论变掉。真机上永远走注入的那份。
///
/// "同值不重建"落在 [updateShouldNotify]：语言没变、覆盖层版次也没变，就**不**让依赖方重建。
class IrmiaStrings extends InheritedWidget {
  const IrmiaStrings({super.key, required this.strings, required super.child});

  /// 这一层的文案
  final AppStrings strings;

  /// 取文案。**只依赖这一层**，所以语言一变，读过它的 widget 都会重建
  /// （没读过的不重建——这就是"只重画该重画的"）。
  static AppStrings of(BuildContext context) => context
          .dependOnInheritedWidgetOfExactType<IrmiaStrings>()
          ?.strings ??
      const ZhStrings();

  /// **不建立依赖**地取一次当前文案。
  ///
  /// 用途只有一个：事件处理器里把一句界面话**落成历史条目**（聊天页的"手动唤醒"
  /// "上下文在此处清空"那一族）。那些字是那一刻的界面话，之后不该跟着语言变——
  /// 它们已经是"发生过的事"的记录，和她的发言正文同一档。
  ///
  /// 为什么不能用 [of]：它登记依赖，而处理器不在 build 里；在回调里登记依赖会让
  /// 下一次语言切换去重建一个早已不在的调用方。
  static AppStrings read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<IrmiaStrings>()?.strings ?? const ZhStrings();

  @override
  bool updateShouldNotify(IrmiaStrings oldWidget) =>
      oldWidget.strings.language != strings.language ||
      // 语言没变、但覆盖文件重新载入过（版次变了）⇒ 读过文案的 widget 也要重建，
      // 否则「重新载入文案」按下去屏幕上什么都不会变（见 strings_override.dart 文件头）。
      oldWidget.strings.revision != strings.revision;
}
