/// 文案覆盖层：让用户**直接改界面上的字**，不碰代码、不改后端配置。
///
/// 这是 i18n 的**第三层**，不是旁路 hack：
///   1. `app_strings.dart` —— 抽象接口 [AppStrings]（键名编译期检查）+ 两份默认实现
///      （[ZhStrings] / [EnStrings]）；
///   2. `strings_scope.dart` —— 把文案表注入 widget 树的运行时那一半；
///   3. **本文件** —— 覆盖层：同一个 [AppStrings] 接口上的一个装饰器
///      [OverriddenStrings]，页面用 `IrmiaStrings.of(context)` 一行不改就吃到覆盖。
///
/// 解析顺序只有一条：**覆盖值 > `ZhStrings`/`EnStrings` 默认值**（见 [resolveStrings]）。
/// 覆盖文件里没写的键，回默认值；整份文件不存在 / 读不动 / JSON 坏，回默认值且**不崩**。
///
/// ## 文件在哪、长什么样
///
/// `%APPDATA%\Irmia\strings-override.json`（[stringsOverridePath]），两种形状都认：
///
/// ```json
/// { "zh": { "navChat": "闲聊" }, "en": { "navChat": "Gossip" } }   // 分语言段（主形状）
/// ```
/// ```json
/// { "navChat": "闲聊" }                                            // 扁平 = 只覆盖当前语言
/// ```
///
/// 值里的字符串**原样**上屏（不做 Markdown、不做 ${} 插值）。键名就是 [AppStrings] 的
/// getter 名（`navChat`、`settingsLanguage`…），完整清单可以用设置页的
/// 「导出当前文案为模板」拿到（[exportStringsTemplate] 写 `strings-override.template.json`）。
///
/// ## 三条边界（都是刻意的）
///
/// 1. **只有无参 getter 能覆盖**（= [stringsAsMap] 的键，导出模板就是这份清单）。
///    带参句子（`loadFailed(reason)` 那一族）由"前缀 + 参数"拼成，覆盖文件里没有参数
///    可填的位置；写它们的键会被当成不认识的键忽略，并在日志里点出来（不会静默失效）。
/// 2. **未知键只忽略、不崩**：拼错的键会进 [StringsOverrideSnapshot.ignored]，并落到
///    控制台/启动日志（[loadStringsOverride] 里 `debugPrint`），设置页那行状态也报条数。
/// 3. **覆盖文件不进 git、不进包、不改后端**：它是本机的一份"用户自己的文案"，
///    与 `ui-state.json` 同族（界面偏好），跟服务端 `config.json` 没有关系。
///
/// 覆盖层自己的提示文案（设置页那几条）也在 [AppStrings] 里，所以**它们也能被覆盖**：
/// 用户嫌"重新载入文案"这句话不顺眼，改 `stringsOverrideReload` 就行，走的是同一条链。
///
/// ## 重新载入**不重启**
///
/// [loadStringsOverride] 每次产出一个新的不可变快照（[StringsOverrideSnapshot]）灌进
/// [stringsOverrideState]；根的 `MaterialApp` 监听它重建，`IrmiaStrings` 靠
/// [AppStrings.revision] 让读过文案的 widget 跟着重建——整棵树不重建（状态都在），
/// 界面上的字换掉。设置页那颗「重新载入文案」调的就是 [reloadStringsOverride]。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import 'app_strings.dart';

/// 覆盖文件名（放在 `%APPDATA%\Irmia\` 下）
const String kStringsOverrideFileName = 'strings-override.json';

/// 导出的模板文件名（与覆盖文件同目录：照着改、改完另存成 [kStringsOverrideFileName]）
const String kStringsTemplateFileName = 'strings-override.template.json';

/// 覆盖文件路径的测试替身（与 `ui_state.dart` 的 `stateFileOverride` 同族）。
///
/// 用例把它指到临时目录，免得踩真实 `%APPDATA%` 里的那一份；`null` = 用真机路径。
String? stringsOverrideFileOverride;

/// 覆盖文件所在目录：`%APPDATA%\Irmia`（读不到 `%APPDATA%` 时落到系统临时目录）。
String stringsOverrideDir() {
  final override = stringsOverrideFileOverride;
  if (override != null && override.isNotEmpty) return File(override).parent.path;
  final appData = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
  return '$appData${Platform.pathSeparator}Irmia';
}

/// 覆盖文件的完整路径（设置页显示的那一行就是它）
String stringsOverridePath() =>
    '${stringsOverrideDir()}${Platform.pathSeparator}$kStringsOverrideFileName';

/// 导出模板的完整路径（与覆盖文件同目录）
String stringsTemplatePath() =>
    '${stringsOverrideDir()}${Platform.pathSeparator}$kStringsTemplateFileName';

/// 覆盖文件"没生效"的三种结局。
///
/// 存的是**种类**不是那句话：界面上的措辞属于 `AppStrings`（跟着语言走、也能被覆盖），
/// 快照只记"哪一类失败 + 系统给的细节"，渲染时由 [stringsOverrideStatusLine] 拼。
enum StringsOverrideError {
  /// 文件在，但读不出来（权限、被独占、不是 UTF-8 文本…）
  unreadable,

  /// 内容不是合法 JSON
  badJson,

  /// 是 JSON，但顶层既不是 `{ "zh": …, "en": … }` 也不是扁平键值
  badRoot,
}

/// 一次加载的结果（**不可变**）。换它 = 换 [stringsOverrideState] 的值 = 界面重建。
@immutable
class StringsOverrideSnapshot {
  const StringsOverrideSnapshot({
    required this.language,
    required this.revision,
    this.filePath = '',
    this.exists = false,
    this.zh = const <String, String>{},
    this.en = const <String, String>{},
    this.ignored = const <String>[],
    this.errorKind,
    this.errorDetail = '',
  });

  /// 这次加载按哪种语言解释**扁平**形状（分语言段的形状与它无关）。
  ///
  /// 扁平形状的语义是"只覆盖当前语言"（见文件头），所以它必须知道"当前"是哪种；
  /// 解析失败 / 文件不存在时它也记着，好让 [reloadStringsOverride] 不需要再问一遍。
  final AppLanguage language;

  /// 覆盖层的版次（0 = 从未加载过；每次加载 +1）。[AppStrings.revision] 取它。
  final int revision;

  /// 这次读的是哪个文件（绝对路径；文件不存在时也记着，设置页要显示它）
  final String filePath;

  /// 文件在不在（不存在 = 没启用覆盖，不是错误）
  final bool exists;

  /// 中文段的覆盖值（**已过滤**：只含认识的键）
  final Map<String, String> zh;

  /// 英文段的覆盖值（同上）
  final Map<String, String> en;

  /// 没被采用的条目（不认识的键 / 值不是字符串），一条一句**给人读的现场**
  /// （`zh.navChat: unknown key`——文件路径与键名是事实，措辞不进 UI 文案层）。
  final List<String> ignored;

  /// 失败的种类（`null` = 没失败）。失败时 [zh]/[en] 都是空的 ⇒ 回默认文案
  final StringsOverrideError? errorKind;

  /// 失败的细节（系统给的那句话，或 JSON 解析器的说明）；[errorKind] 为 null 时是空串
  final String errorDetail;

  /// 一共生效了几条
  int get total => zh.length + en.length;

  /// 有没有失败
  bool get failed => errorKind != null;

  /// 某种语言这一段（`system` 只会落到 zh 那一份上——真机上它早被解析掉了）
  Map<String, String> forLanguage(AppLanguage language) =>
      language == AppLanguage.en ? en : zh;

  /// 把这一份覆盖套到 [base] 上（空覆盖直接回 base：没配覆盖的机器与加这一层之前等价）
  AppStrings overridesFor(AppStrings base) {
    final overrides = forLanguage(base.language);
    if (overrides.isEmpty) return base;
    return OverriddenStrings(base: base, overrides: overrides, revision: revision);
  }
}

/// 当前覆盖层（**换值 = 通知**：界的根与设置页那行状态都听它）。
///
/// 默认值 = "从没加载过、什么都没覆盖"：不碰盘、不读环境变量，widget 测试因此是确定的。
final ValueNotifier<StringsOverrideSnapshot> stringsOverrideState =
    ValueNotifier<StringsOverrideSnapshot>(
  const StringsOverrideSnapshot(language: AppLanguage.zh, revision: 0),
);

/// 覆盖层的版次计数器（每次 [loadStringsOverride] +1，含失败的那些——状态行要跟着变）
int _generation = 0;

/// **解析顺序**：覆盖值 > `ZhStrings`/`EnStrings` 默认值。
///
/// 这是全仓唯一一处"把覆盖套上去"的地方：`strings_scope.dart` 的 `currentStrings`
/// 与 `app.dart` 的根 `MaterialApp` 都走它，所以页面一行不改就吃到覆盖。
AppStrings resolveStrings(AppLanguage language) =>
    stringsOverrideState.value.overridesFor(stringsFor(language));

/// 从盘上读一次覆盖（**启动时一次**，见 `main.dart`）。
///
/// [language] 只对**扁平**形状有意义（"只覆盖当前语言"的"当前"）。失败一律静默回默认：
/// 文件不存在 / 读不动 / JSON 坏 / 顶层不是对象，都只把 [StringsOverrideSnapshot.errorKind]
/// 填上，**不抛**。未知键进 [StringsOverrideSnapshot.ignored] 并打到控制台。
Future<StringsOverrideSnapshot> loadStringsOverride({
  required AppLanguage language,
}) async {
  final path = stringsOverridePath();
  final revision = ++_generation;

  StringsOverrideSnapshot publish(StringsOverrideSnapshot snapshot) {
    stringsOverrideState.value = snapshot;
    _logSnapshot(snapshot);
    return snapshot;
  }

  final file = File(path);
  if (!await file.exists()) {
    // 没有文件 = 没启用覆盖。这不是错误：界面上照旧显示默认文案。
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
    ));
  }

  String raw;
  try {
    raw = await file.readAsString();
  } catch (err) {
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
      exists: true,
      errorKind: StringsOverrideError.unreadable,
      errorDetail: '$err',
    ));
  }
  // 记事本另存的 UTF-8 可能带 BOM（`\uFEFF`）：jsonDecode 认不出它，先剥掉
  if (raw.startsWith('\uFEFF')) raw = raw.substring(1);

  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (err) {
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
      exists: true,
      errorKind: StringsOverrideError.badJson,
      errorDetail: err is FormatException ? (err.message) : '$err',
    ));
  }
  if (decoded is! Map) {
    return publish(StringsOverrideSnapshot(
      language: language,
      revision: revision,
      filePath: path,
      exists: true,
      errorKind: StringsOverrideError.badRoot,
    ));
  }

  final zh = <String, String>{};
  final en = <String, String>{};
  final ignored = <String>[];
  // 有 zh / en 任意一段就是"分语言"形状；否则整份当扁平（只覆盖 [language] 那一种）
  final sectioned = decoded.containsKey('zh') || decoded.containsKey('en');
  if (sectioned) {
    for (final entry in decoded.entries) {
      final section = '${entry.key}';
      if (section != 'zh' && section != 'en') {
        ignored.add('$section: unknown section (only zh / en)');
        continue;
      }
      final value = entry.value;
      if (value is! Map) {
        ignored.add('$section: section is not an object');
        continue;
      }
      _collect(section, value, section == 'en' ? en : zh, ignored);
    }
  } else {
    _collect(language.languageCode, decoded, language == AppLanguage.en ? en : zh, ignored);
  }

  return publish(StringsOverrideSnapshot(
    language: language,
    revision: revision,
    filePath: path,
    exists: true,
    zh: zh,
    en: en,
    ignored: ignored,
  ));
}

/// 重新读一次覆盖（设置页那颗「重新载入文案」）。**不重启界面**：
/// 换一下 [stringsOverrideState] 的值，根的 `MaterialApp` 与设置页那行状态就跟着重建。
///
/// [language] 省略时沿用上一次加载的语言（启动时由 `main.dart` 给对）。
Future<StringsOverrideSnapshot> reloadStringsOverride({AppLanguage? language}) =>
    loadStringsOverride(language: language ?? stringsOverrideState.value.language);

/// 设置页状态行的那一句话（三态的唯一拼装点；`test/strings_override_test.dart` 钉着它）。
///
/// 线索只有三条：解析失败 / 没有覆盖 / 已加载 N 条。**"有键没被采用"不在这句里**：
/// 它是旁注，页面另起一行（[StringsOverrideSnapshot.ignored] 非空时）。
///
/// [s] 是**当前**那份文案表：失败原因在这里才变成人话（快照只记种类与细节），
/// 所以换语言之后同一份失败记录会跟着换措辞。
String stringsOverrideStatusLine(AppStrings s, StringsOverrideSnapshot snapshot) {
  final reason = switch (snapshot.errorKind) {
    null => null,
    StringsOverrideError.unreadable => s.stringsOverrideUnreadable(snapshot.errorDetail),
    StringsOverrideError.badJson => s.stringsOverrideBadJson(snapshot.errorDetail),
    StringsOverrideError.badRoot => s.stringsOverrideBadRoot,
  };
  if (reason != null) return s.stringsOverrideFailed(reason);
  if (snapshot.total == 0) return s.stringsOverrideNone;
  return s.stringsOverrideLoaded(snapshot.zh.length, snapshot.en.length);
}

/// 把**当前语言**的全部文案导成模板（设置页那颗「导出当前文案为模板」）。
///
/// 写到 [stringsTemplatePath]（与覆盖文件同目录），返回写到的路径。
/// 内容 = **此刻生效**的那一份（含已经生效的覆盖值）——照它改、存成
/// [kStringsOverrideFileName] 就是一份合法的覆盖文件。
///
/// 只导出无参 getter（键表见 [stringsAsMap]）：带参句子没有"一个值"可写（见文件头第一条边界）。
/// 写盘失败时抛 [FileSystemException] 一族的异常，由调用方把它说给人听。
Future<String> exportStringsTemplate({AppLanguage? language}) async {
  final target = language ?? stringsOverrideState.value.language;
  final values = stringsAsMap(resolveStrings(target));
  final path = stringsTemplatePath();
  final file = File(path);
  await file.parent.create(recursive: true);
  // 缩进两格 + 结尾换行：这是给人改的文件，不是机器读的压缩包
  final payload = <String, dynamic>{target.languageCode: values};
  await file.writeAsString('${const JsonEncoder.withIndent('  ').convert(payload)}\n');
  return path;
}

/// 一份文案表的**全部键值**（键 = [AppStrings] 的无参 getter 名）。
///
/// 两个用途：导出模板；以及"这个键认不认识"的判据（[stringOverrideKeys]）。
/// **[AppStrings] 加了新 getter 就必须在这里补一条**——漏了会有
/// `test/strings_override_test.dart` 那条"模板键数 = 接口键数"当场红。
Map<String, String> stringsAsMap(AppStrings s) => <String, String>{
    'retry': s.retry,
    'cancel': s.cancel,
    'confirm': s.confirm,
    'save': s.save,
    'loading': s.loading,
    'error': s.error,
    'empty': s.empty,
    'collapse': s.collapse,
    'settingsLoadingConfig': s.settingsLoadingConfig,
    'navChat': s.navChat,
    'navSettings': s.navSettings,
    'navOverview': s.navOverview,
    'navChannels': s.navChannels,
    'navExtensions': s.navExtensions,
    'navPersona': s.navPersona,
    'navSchedule': s.navSchedule,
    'navMemory': s.navMemory,
    'navLogs': s.navLogs,
    'navMore': s.navMore,
    'overviewConfigGuide': s.overviewConfigGuide,
    'restartSentWithGui': s.restartSentWithGui,
    'restartSentBackendOnly': s.restartSentBackendOnly,
    'restartNoConclusion': s.restartNoConclusion,
    'restartBackReady': s.restartBackReady,
    'restartNeverWentDown': s.restartNeverWentDown,
    'trayShow': s.trayShow,
    'trayHide': s.trayHide,
    'trayRestart': s.trayRestart,
    'trayQuitUi': s.trayQuitUi,
    'trayQuitAll': s.trayQuitAll,
    'quitAllConfirmTitle': s.quitAllConfirmTitle,
    'quitAllConfirmLabel': s.quitAllConfirmLabel,
    'quitAllWorking': s.quitAllWorking,
    'quitAllDone': s.quitAllDone,
    'onboardingManualSaved': s.onboardingManualSaved,
    'onboardingManualNoChanges': s.onboardingManualNoChanges,
    'onboardingManualOpenBadge': s.onboardingManualOpenBadge,
    'onboardingStepNameTitle': s.onboardingStepNameTitle,
    'onboardingStepNameNote': s.onboardingStepNameNote,
    'onboardingStepApiTitle': s.onboardingStepApiTitle,
    'onboardingStepApiNote': s.onboardingStepApiNote,
    'onboardingStepChannelTitle': s.onboardingStepChannelTitle,
    'onboardingStepChannelNote': s.onboardingStepChannelNote,
    'onboardingStepPersonaTitle': s.onboardingStepPersonaTitle,
    'onboardingStepPersonaNote': s.onboardingStepPersonaNote,
    'onboardingStepTrustTitle': s.onboardingStepTrustTitle,
    'onboardingStepTrustNote': s.onboardingStepTrustNote,
    'onboardingApiRecommendLead': s.onboardingApiRecommendLead,
    'onboardingApiRecommendModel': s.onboardingApiRecommendModel,
    'onboardingApiRegisterKey': s.onboardingApiRegisterKey,
    'onboardingApiRecommendJoin': s.onboardingApiRecommendJoin,
    'onboardingChannelRecommendLead': s.onboardingChannelRecommendLead,
    'onboardingChannelRecommendQq': s.onboardingChannelRecommendQq,
    'onboardingChannelRecommendTail': s.onboardingChannelRecommendTail,
    'onboardingQqTileDetail': s.onboardingQqTileDetail,
    'onboardingQqCredentialsTitle': s.onboardingQqCredentialsTitle,
    'onboardingQqAppIdLabel': s.onboardingQqAppIdLabel,
    'onboardingQqAppIdHint': s.onboardingQqAppIdHint,
    'onboardingQqAppSecretLabel': s.onboardingQqAppSecretLabel,
    'onboardingQqAppSecretHint': s.onboardingQqAppSecretHint,
    'onboardingQqCredentialsNote': s.onboardingQqCredentialsNote,
    'onboardingQqEntryScan': s.onboardingQqEntryScan,
    'onboardingQqEntryManual': s.onboardingQqEntryManual,
    'onboardingQqBindIntro': s.onboardingQqBindIntro,
    'onboardingQqBindStart': s.onboardingQqBindStart,
    'onboardingQqBindStarting': s.onboardingQqBindStarting,
    'onboardingQqBindWaitScan': s.onboardingQqBindWaitScan,
    'onboardingQqBindWaiting': s.onboardingQqBindWaiting,
    'onboardingQqBindSuccess': s.onboardingQqBindSuccess,
    'onboardingQqBindSavedNote': s.onboardingQqBindSavedNote,
    'onboardingQqBindRegenerate': s.onboardingQqBindRegenerate,
    'onboardingQqBindTestConnection': s.onboardingQqBindTestConnection,
    'onboardingQqBindTokenTesting': s.onboardingQqBindTokenTesting,
    'onboardingOnebotDetail': s.onboardingOnebotDetail,
    'onboardingStepNameHint': s.onboardingStepNameHint,
    'onboardingKeywordsHint': s.onboardingKeywordsHint,
    'onboardingPersonaHint': s.onboardingPersonaHint,
    'onboardingTrustNoteSame': s.onboardingTrustNoteSame,
    'onboardingTrustNoteChanged': s.onboardingTrustNoteChanged,
    'onboardingStepDepsTitle': s.onboardingStepDepsTitle,
    'onboardingStepDepsNote': s.onboardingStepDepsNote,
    'onboardingDepsInstallLabel': s.onboardingDepsInstallLabel,
    'onboardingDepsAllReady': s.onboardingDepsAllReady,
    'onboardingDepsStatusReady': s.onboardingDepsStatusReady,
    'onboardingDepsStatusMissing': s.onboardingDepsStatusMissing,
    'onboardingDepsItemRunning': s.onboardingDepsItemRunning,
    'onboardingDepsItemOk': s.onboardingDepsItemOk,
    'onboardingDepsRetry': s.onboardingDepsRetry,
    'onboardingDepsUnavailable': s.onboardingDepsUnavailable,
    'onboardingRestartTitle': s.onboardingRestartTitle,
    'onboardingRestartBody': s.onboardingRestartBody,
    'onboardingRestartNow': s.onboardingRestartNow,
    'onboardingRestartLater': s.onboardingRestartLater,
    // 第 2 步：模型探测 / 密钥状态（2026-10-26；协议三档同日撤出引导页）
    'onboardingModelLabel': s.onboardingModelLabel,
    'onboardingModelRequired': s.onboardingModelRequired,
    'onboardingBaseUrlLabel': s.onboardingBaseUrlLabel,
    'onboardingBaseUrlRequired': s.onboardingBaseUrlRequired,
    'onboardingBaseUrlNote': s.onboardingBaseUrlNote,
    'onboardingApiKeyLabel': s.onboardingApiKeyLabel,
    'onboardingApiKeyStatusMissing': s.onboardingApiKeyStatusMissing,
    'onboardingProbeButton': s.onboardingProbeButton,
    'onboardingProbeRunning': s.onboardingProbeRunning,
    'onboardingProbeBaseRequired': s.onboardingProbeBaseRequired,
    'onboardingProbeSearchHint': s.onboardingProbeSearchHint,
    'onboardingProbeNoMatch': s.onboardingProbeNoMatch,
    'onboardingProbeEmptyList': s.onboardingProbeEmptyList,
    'onboardingProbeUnreachable': s.onboardingProbeUnreachable,
    'onboardingProbeUnauthorized': s.onboardingProbeUnauthorized,
    'onboardingProbeNoModels': s.onboardingProbeNoModels,
    'onboardingProbeNoKey': s.onboardingProbeNoKey,
    'chatTitle': s.chatTitle,
    'chatSubtitle': s.chatSubtitle,
    'composerHint': s.composerHint,
    'jumpToLatest': s.jumpToLatest,
    'jumpToLatestNew': s.jumpToLatestNew,
    'earlierFailed': s.earlierFailed,
    'noEarlier': s.noEarlier,
    'historyErrorTitle': s.historyErrorTitle,
    'historyErrorMessage': s.historyErrorMessage,
    'chatEmptyTitle': s.chatEmptyTitle,
    'chatEmptyMessage': s.chatEmptyMessage,
    'chatEmptyAction': s.chatEmptyAction,
    'chatEmptyHint': s.chatEmptyHint,
    'tagFrameworkNotice': s.tagFrameworkNotice,
    'tagFrameworkReminder': s.tagFrameworkReminder,
    'tagInjection': s.tagInjection,
    'tagContextBoundary': s.tagContextBoundary,
    'injectionCardTitle': s.injectionCardTitle,
    'unnamedSender': s.unnamedSender,
    'dash': s.dash,
    'directMessage': s.directMessage,
    'groupMention': s.groupMention,
    'groupMessage': s.groupMessage,
    'chatTypeDirect': s.chatTypeDirect,
    'chatTypeGroup': s.chatTypeGroup,
    'qqOfficialBot': s.qqOfficialBot,
    'externalChannel': s.externalChannel,
    'qqMessage': s.qqMessage,
    'oneBotMessage': s.oneBotMessage,
    'externalMessage': s.externalMessage,
    'byModel': s.byModel,
    'byRule': s.byRule,
    'manualWake': s.manualWake,
    'intentWake': s.intentWake,
    'schedulerFire': s.schedulerFire,
    'backgroundProgress': s.backgroundProgress,
    'eventDream': s.eventDream,
    'eventMcpDeclChanged': s.eventMcpDeclChanged,
    'contextClearedHere': s.contextClearedHere,
    'contextCompactedHere': s.contextCompactedHere,
    'contextClearedHereDetail': s.contextClearedHereDetail,
    'contextCompactedHereDetail': s.contextCompactedHereDetail,
    'humanReplyRecorded': s.humanReplyRecorded,
    'markedOk': s.markedOk,
    'markedFailed': s.markedFailed,
    'toolRunning': s.toolRunning,
    'toolExecuting': s.toolExecuting,
    'toolDone': s.toolDone,
    'toolError': s.toolError,
    'toolTimeout': s.toolTimeout,
    'toolDenied': s.toolDenied,
    'toolUnknown': s.toolUnknown,
    'toolNotDispatched': s.toolNotDispatched,
    'toolOverStepCap': s.toolOverStepCap,
    'thinkingLabel': s.thinkingLabel,
    'thinkingGap': s.thinkingGap,
    'toastContextCleared': s.toastContextCleared,
    'toastDream': s.toastDream,
    'toastDuplicateSend': s.toastDuplicateSend,
    'settingsTitle': s.settingsTitle,
    'settingsSubtitle': s.settingsSubtitle,
    'settingsSectionUi': s.settingsSectionUi,
    'settingsUiNote': s.settingsUiNote,
    'instantApply': s.instantApply,
    'settingsThemeMode': s.settingsThemeMode,
    'themeLight': s.themeLight,
    'themeDark': s.themeDark,
    'settingsCurrentTheme': s.settingsCurrentTheme,
    'settingsThemeNote': s.settingsThemeNote,
    'settingsCloseToTray': s.settingsCloseToTray,
    'settingsCloseToTrayNote': s.settingsCloseToTrayNote,
    'settingsLanguage': s.settingsLanguage,
    'languageFollowSystem': s.languageFollowSystem,
    'settingsLanguageNote': s.settingsLanguageNote,
    'settingsStringsOverride': s.settingsStringsOverride,
    'settingsStringsOverrideNote': s.settingsStringsOverrideNote,
    'stringsOverridePathLabel': s.stringsOverridePathLabel,
    'stringsOverrideOpen': s.stringsOverrideOpen,
    'stringsOverrideReload': s.stringsOverrideReload,
    'stringsOverrideExport': s.stringsOverrideExport,
    'stringsOverrideNone': s.stringsOverrideNone,
    'stringsOverrideBadRoot': s.stringsOverrideBadRoot,
    'settingsAnchorCaption': s.settingsAnchorCaption,
    'settingsNavModel': s.settingsNavModel,
    'settingsNavUi': s.settingsNavUi,
    'settingsNavSpeak': s.settingsNavSpeak,
    'settingsNavDeps': s.settingsNavDeps,
    'settingsNavProtocol': s.settingsNavProtocol,
    'settingsNavWebhook': s.settingsNavWebhook,
    'settingsNavMemory': s.settingsNavMemory,
    'settingsNavTrust': s.settingsNavTrust,
    'settingsNavSystem': s.settingsNavSystem,
    'settingsNavAccount': s.settingsNavAccount,
    'settingsNavAbout': s.settingsNavAbout,
    'overviewSubtitle': s.overviewSubtitle,
    'overviewSectionAdvice': s.overviewSectionAdvice,
    'overviewSectionRecent': s.overviewSectionRecent,
    'overviewPersonaSeedAdvice': s.overviewPersonaSeedAdvice,
    'overviewNoPendingCalls': s.overviewNoPendingCalls,
    'overviewTimerCancelTitle': s.overviewTimerCancelTitle,
    'overviewTimerCancel': s.overviewTimerCancel,
    'overviewDeadDiscardTitle': s.overviewDeadDiscardTitle,
    'overviewDeadDiscardConfirm': s.overviewDeadDiscardConfirm,
    'overviewDeadRequeue': s.overviewDeadRequeue,
    'overviewDeadDiscard': s.overviewDeadDiscard,
    'overviewLoadFailedTitle': s.overviewLoadFailedTitle,
    'overviewMarkSucceeded': s.overviewMarkSucceeded,
    'overviewMarkFailed': s.overviewMarkFailed,
    'overviewTodayUsage': s.overviewTodayUsage,
    'overviewCacheHitRate': s.overviewCacheHitRate,
    'overviewPending': s.overviewPending,
    'overviewFailStreak': s.overviewFailStreak,
    'overviewActFallback': s.overviewActFallback,
    'overviewDeadLettersUnread': s.overviewDeadLettersUnread,
    'overviewUnknownSession': s.overviewUnknownSession,
    'overviewChatTypeDirect': s.overviewChatTypeDirect,
    'overviewChatTypeGroupAt': s.overviewChatTypeGroupAt,
    'overviewChatTypeGroup': s.overviewChatTypeGroup,
    'overviewChatTypeGuild': s.overviewChatTypeGuild,
    'overviewChatTypeUnknown': s.overviewChatTypeUnknown,
    'overviewExternalSessions': s.overviewExternalSessions,
    'overviewExternalSessionsNote': s.overviewExternalSessionsNote,
    'overviewExternalSessionsLoading': s.overviewExternalSessionsLoading,
    'overviewExternalSessionsErrorHint': s.overviewExternalSessionsErrorHint,
    'overviewNoAccumulatedMessages': s.overviewNoAccumulatedMessages,
    'overviewLevelCritical': s.overviewLevelCritical,
    'overviewLevelWarn': s.overviewLevelWarn,
    'overviewLevelInfo': s.overviewLevelInfo,
    'overviewLevelUnknown': s.overviewLevelUnknown,
    'overviewFrameworkNote': s.overviewFrameworkNote,
    'overviewFrameworkNotesLoading': s.overviewFrameworkNotesLoading,
    'overviewFrameworkNotesErrorHint': s.overviewFrameworkNotesErrorHint,
    'overviewNoFrameworkNotes': s.overviewNoFrameworkNotes,
    'overviewTimers': s.overviewTimers,
    'overviewTimersNote': s.overviewTimersNote,
    'overviewNoTimers': s.overviewNoTimers,
    'overviewTimersErrorHint': s.overviewTimersErrorHint,
    'overviewTimerUnknownTime': s.overviewTimerUnknownTime,
    'overviewTimerRecurring': s.overviewTimerRecurring,
    'overviewRecentEmpty': s.overviewRecentEmpty,
    'overviewRecentEmptyAction': s.overviewRecentEmptyAction,
    'overviewRecentEmptyHint': s.overviewRecentEmptyHint,
    'overviewJudgedByRule': s.overviewJudgedByRule,
    'overviewJudgedByModel': s.overviewJudgedByModel,
    'overviewSessionsNotList': s.overviewSessionsNotList,
    'overviewNotesNotList': s.overviewNotesNotList,
    'overviewContextTitle': s.overviewContextTitle,
    'overviewContextLoading': s.overviewContextLoading,
    'overviewContextErrorHint': s.overviewContextErrorHint,
    'overviewContextEmpty': s.overviewContextEmpty,
    'overviewContextNotObject': s.overviewContextNotObject,
    'overviewContextKeepOn': s.overviewContextKeepOn,
    'overviewContextKeepOff': s.overviewContextKeepOff,
    'settingsLaneHeavyLabel': s.settingsLaneHeavyLabel,
    'settingsLaneLightLabel': s.settingsLaneLightLabel,
    'settingsLaneHeavyNote': s.settingsLaneHeavyNote,
    'settingsLaneLightNote': s.settingsLaneLightNote,
    'settingsDepSourceManaged': s.settingsDepSourceManaged,
    'settingsDepSourceSystemPath': s.settingsDepSourceSystemPath,
    'settingsDepVersionUnknown': s.settingsDepVersionUnknown,
    'settingsDepPathUnknown': s.settingsDepPathUnknown,
    'settingsSysHostEmptyError': s.settingsSysHostEmptyError,
    'settingsSysHostLabel': s.settingsSysHostLabel,
    'settingsSysHostNote': s.settingsSysHostNote,
    'settingsSysPortLabel': s.settingsSysPortLabel,
    'settingsSysTimezoneLabel': s.settingsSysTimezoneLabel,
    'settingsSysTimezoneNote': s.settingsSysTimezoneNote,
    'settingsSysStepToolsLabel': s.settingsSysStepToolsLabel,
    'settingsSysStepToolsNote': s.settingsSysStepToolsNote,
    'settingsSysTurnStepsLabel': s.settingsSysTurnStepsLabel,
    'settingsSysTurnStepsNote': s.settingsSysTurnStepsNote,
    'settingsSysTaskTokensLabel': s.settingsSysTaskTokensLabel,
    'settingsSysTaskTokensNote': s.settingsSysTaskTokensNote,
    'settingsSysDailyTokensLabel': s.settingsSysDailyTokensLabel,
    'settingsSysDailyTokensNote': s.settingsSysDailyTokensNote,
    'settingsSysSoftRatioLabel': s.settingsSysSoftRatioLabel,
    'settingsSysSoftRatioNote': s.settingsSysSoftRatioNote,
    'settingsSysFailStreakLabel': s.settingsSysFailStreakLabel,
    'settingsSysFailStreakNote': s.settingsSysFailStreakNote,
    'settingsSysHeartbeatLabel': s.settingsSysHeartbeatLabel,
    'settingsSysHeartbeatNote': s.settingsSysHeartbeatNote,
    'settingsSysCompactionLabel': s.settingsSysCompactionLabel,
    'settingsSysCompactionNote': s.settingsSysCompactionNote,
    'settingsTrustConsequenceWorkspaceUnknown': s.settingsTrustConsequenceWorkspaceUnknown,
    'settingsTrustConsequenceFull': s.settingsTrustConsequenceFull,
    'settingsTrustLabelWorkspace': s.settingsTrustLabelWorkspace,
    'settingsTrustLabelFull': s.settingsTrustLabelFull,
    'settingsWebhookStateNotObject': s.settingsWebhookStateNotObject,
    'settingsProtocolStateNotObject': s.settingsProtocolStateNotObject,
    'settingsDepsReadFailed': s.settingsDepsReadFailed,
    'settingsKeysReadFailed': s.settingsKeysReadFailed,
    'settingsProjectionReadFailed': s.settingsProjectionReadFailed,
    'settingsModelNameRequired': s.settingsModelNameRequired,
    'settingsBaseUrlRequired': s.settingsBaseUrlRequired,
    'settingsNoChanges': s.settingsNoChanges,
    'settingsWrittenModelSettings': s.settingsWrittenModelSettings,
    'settingsWrittenKey': s.settingsWrittenKey,
    'settingsRestartSuffix': s.settingsRestartSuffix,
    'settingsClearKeyBody': s.settingsClearKeyBody,
    'settingsClear': s.settingsClear,
    'settingsKeyCleared': s.settingsKeyCleared,
    'settingsConfigErrorHint': s.settingsConfigErrorHint,
    'settingsConfigUnavailable': s.settingsConfigUnavailable,
    'settingsConfigUnavailableHint': s.settingsConfigUnavailableHint,
    'settingsConfigFallbackNote': s.settingsConfigFallbackNote,
    'settingsModelRestartNote': s.settingsModelRestartNote,
    'settingsKeysNote': s.settingsKeysNote,
    'settingsKeyConfiguredHint': s.settingsKeyConfiguredHint,
    'settingsKeySampleHint': s.settingsKeySampleHint,
    'settingsModelName': s.settingsModelName,
    'settingsBaseUrlNote': s.settingsBaseUrlNote,
    'settingsModelProtocol': s.settingsModelProtocol,
    'settingsModelProtocolAuto': s.settingsModelProtocolAuto,
    'settingsModelProtocolChat': s.settingsModelProtocolChat,
    'settingsModelProtocolResponses': s.settingsModelProtocolResponses,
    'settingsClearKey': s.settingsClearKey,
    'settingsReading': s.settingsReading,
    'settingsStateReadFailed': s.settingsStateReadFailed,
    'settingsNotConfigured': s.settingsNotConfigured,
    'settingsSpeakNote': s.settingsSpeakNote,
    'settingsSpeakTyping': s.settingsSpeakTyping,
    'settingsSpeakTypingNote': s.settingsSpeakTypingNote,
    'settingsSpeakSpeed': s.settingsSpeakSpeed,
    'settingsSpeakSpeedUnit': s.settingsSpeakSpeedUnit,
    'settingsSpeakSpeedNote': s.settingsSpeakSpeedNote,
    'settingsCurrentlyActive': s.settingsCurrentlyActive,
    'settingsSpeakTypingEnabled': s.settingsSpeakTypingEnabled,
    'settingsSpeakTypingDisabled': s.settingsSpeakTypingDisabled,
    'settingsSpeakSpeedRange': s.settingsSpeakSpeedRange,
    'settingsSavedRestartNote': s.settingsSavedRestartNote,
    'settingsSavedLive': s.settingsSavedLive,
    'settingsSavedRestart': s.settingsSavedRestart,
    'settingsDepsAllReady': s.settingsDepsAllReady,
    'settingsDepsNote': s.settingsDepsNote,
    'settingsDepsProbing': s.settingsDepsProbing,
    'settingsDepsInstallLocation': s.settingsDepsInstallLocation,
    'settingsDepReadyManaged': s.settingsDepReadyManaged,
    'settingsDepReadySystem': s.settingsDepReadySystem,
    'settingsDepMismatch': s.settingsDepMismatch,
    'settingsDepMissing': s.settingsDepMissing,
    'settingsDepNoAction': s.settingsDepNoAction,
    'settingsDepInstalling': s.settingsDepInstalling,
    'settingsInstall': s.settingsInstall,
    'settingsDownloadPage': s.settingsDownloadPage,
    'settingsOpenDownloadPage': s.settingsOpenDownloadPage,
    'settingsDownloadAndInstall': s.settingsDownloadAndInstall,
    'settingsStepDownloadFailed': s.settingsStepDownloadFailed,
    'settingsStepExtractFailed': s.settingsStepExtractFailed,
    'settingsStepVerifyFailed': s.settingsStepVerifyFailed,
    'settingsStepInstallFailed': s.settingsStepInstallFailed,
    'settingsUnknown': s.settingsUnknown,
    'settingsRestartRequired': s.settingsRestartRequired,
    'settingsProtocolTitle': s.settingsProtocolTitle,
    'settingsProtocolNote': s.settingsProtocolNote,
    'settingsProtocolErrorHint': s.settingsProtocolErrorHint,
    'settingsProtocolLoading': s.settingsProtocolLoading,
    'settingsProtocolEmpty': s.settingsProtocolEmpty,
    'settingsProtocolEmptyHint': s.settingsProtocolEmptyHint,
    'settingsProtocolEnabled': s.settingsProtocolEnabled,
    'settingsProtocolEnabledNote': s.settingsProtocolEnabledNote,
    'settingsInstallDir': s.settingsInstallDir,
    'settingsInstallDirHint': s.settingsInstallDirHint,
    'settingsSaveDir': s.settingsSaveDir,
    'settingsInstallDirNote': s.settingsInstallDirNote,
    'settingsOneClickInstall': s.settingsOneClickInstall,
    'settingsOneClickInstallNote': s.settingsOneClickInstallNote,
    'settingsOneClickPrerequisite': s.settingsOneClickPrerequisite,
    'settingsInstallRunningNote': s.settingsInstallRunningNote,
    'settingsInstallLogEmpty': s.settingsInstallLogEmpty,
    'settingsInstallLog': s.settingsInstallLog,
    'settingsInstalledNextTitle': s.settingsInstalledNextTitle,
    'settingsInstalledNextBody': s.settingsInstalledNextBody,
    'settingsInstallDirEmpty': s.settingsInstallDirEmpty,
    'settingsEntryFound': s.settingsEntryFound,
    'settingsEntryMissing': s.settingsEntryMissing,
    'settingsEntryPendingRestart': s.settingsEntryPendingRestart,
    'settingsStart': s.settingsStart,
    'settingsStop': s.settingsStop,
    'settingsOpenPanel': s.settingsOpenPanel,
    'settingsProtocolNotAttachedNote': s.settingsProtocolNotAttachedNote,
    'settingsChainProcess': s.settingsChainProcess,
    'settingsChainUnobserved': s.settingsChainUnobserved,
    'settingsChainNoInstance': s.settingsChainNoInstance,
    'settingsChainNotRunning': s.settingsChainNotRunning,
    'settingsChainNoPort': s.settingsChainNoPort,
    'settingsChainSpawned': s.settingsChainSpawned,
    'settingsChainDiscovered': s.settingsChainDiscovered,
    'settingsChainPortOnly': s.settingsChainPortOnly,
    'settingsChainRunning': s.settingsChainRunning,
    'settingsChainOneBotConfig': s.settingsChainOneBotConfig,
    'settingsChainWithToken': s.settingsChainWithToken,
    'settingsChainNoToken': s.settingsChainNoToken,
    'settingsChainPresent': s.settingsChainPresent,
    'settingsChainUnreadable': s.settingsChainUnreadable,
    'settingsChainMissing': s.settingsChainMissing,
    'settingsChainMissingDetail': s.settingsChainMissingDetail,
    'settingsChainAdapter': s.settingsChainAdapter,
    'settingsChainConnected': s.settingsChainConnected,
    'settingsChainReconnecting': s.settingsChainReconnecting,
    'settingsChainNoEndpoint': s.settingsChainNoEndpoint,
    'settingsChainNoEndpointDetail': s.settingsChainNoEndpointDetail,
    'settingsChainDisabled': s.settingsChainDisabled,
    'settingsChainNotAssembled': s.settingsChainNotAssembled,
    'settingsChainNotAssembledDetail': s.settingsChainNotAssembledDetail,
    'settingsChainNoData': s.settingsChainNoData,
    'settingsCredentialLost': s.settingsCredentialLost,
    'settingsConsentPending': s.settingsConsentPending,
    'settingsPasswordUnchanged': s.settingsPasswordUnchanged,
    'settingsCredentialCopied': s.settingsCredentialCopied,
    'settingsCopyCredential': s.settingsCopyCredential,
    'settingsProtocolRestartNote': s.settingsProtocolRestartNote,
    'settingsInstallDirRequired': s.settingsInstallDirRequired,
    'settingsStartRequested': s.settingsStartRequested,
    'settingsStopRequested': s.settingsStopRequested,
    'settingsOneClickFailed': s.settingsOneClickFailed,
    'settingsInstallNoReason': s.settingsInstallNoReason,
    'settingsInstalledOk': s.settingsInstalledOk,
    'settingsInstalledConfigured': s.settingsInstalledConfigured,
    'settingsInstalledNotConfigured': s.settingsInstalledNotConfigured,
    'settingsRestartSuffixParen': s.settingsRestartSuffixParen,
    'settingsGenerated': s.settingsGenerated,
    'settingsNotGenerated': s.settingsNotGenerated,
    'settingsWebhookNote': s.settingsWebhookNote,
    'settingsWebhookLoading': s.settingsWebhookLoading,
    'settingsWebhookCurrent': s.settingsWebhookCurrent,
    'settingsWebhookNotConfiguredNote': s.settingsWebhookNotConfiguredNote,
    'settingsWebhookRotated': s.settingsWebhookRotated,
    'settingsWebhookNever': s.settingsWebhookNever,
    'settingsRegenerate': s.settingsRegenerate,
    'settingsGenerateWebhook': s.settingsGenerateWebhook,
    'settingsWebhookCredentialNote': s.settingsWebhookCredentialNote,
    'settingsRegenerateTitle': s.settingsRegenerateTitle,
    'settingsRegenerateBody': s.settingsRegenerateBody,
    'settingsNoTokenReturned': s.settingsNoTokenReturned,
    'settingsWebhookRotatedNote': s.settingsWebhookRotatedNote,
    'settingsMemoryNote': s.settingsMemoryNote,
    'settingsNotInEffect': s.settingsNotInEffect,
    'settingsMemoryEnableLabel': s.settingsMemoryEnableLabel,
    'settingsMemoryEnableNote': s.settingsMemoryEnableNote,
    'settingsMemoryOn': s.settingsMemoryOn,
    'settingsMemoryOff': s.settingsMemoryOff,
    'settingsMemoryUnaffectedNote': s.settingsMemoryUnaffectedNote,
    'settingsMemoryRestartNote': s.settingsMemoryRestartNote,
    'settingsMemoryDetail': s.settingsMemoryDetail,
    'settingsMemoryCost': s.settingsMemoryCost,
    'settingsMemoryOnSaved': s.settingsMemoryOnSaved,
    'settingsMemoryOffSaved': s.settingsMemoryOffSaved,
    'settingsTrustNote': s.settingsTrustNote,
    'settingsTrustReachLabel': s.settingsTrustReachLabel,
    'settingsTrustReachNote': s.settingsTrustReachNote,
    'settingsTrustWorkspaceUnknownPath': s.settingsTrustWorkspaceUnknownPath,
    'settingsTrustFullValue': s.settingsTrustFullValue,
    'settingsTrustPendingNote': s.settingsTrustPendingNote,
    'settingsTrustRootNote': s.settingsTrustRootNote,
    'settingsTrustBoundaryNote': s.settingsTrustBoundaryNote,
    'settingsTrustRulesDetail': s.settingsTrustRulesDetail,
    'settingsTrustFullTitle': s.settingsTrustFullTitle,
    'settingsTrustFullConfirmTail': s.settingsTrustFullConfirmTail,
    'settingsTrustWorkspaceSaved': s.settingsTrustWorkspaceSaved,
    'settingsTrustFullSaved': s.settingsTrustFullSaved,
    'settingsSystemNote': s.settingsSystemNote,
    'settingsDataDir': s.settingsDataDir,
    'settingsDataDirNote': s.settingsDataDirNote,
    'settingsSystemFootnote': s.settingsSystemFootnote,
    'settingsLiveNow': s.settingsLiveNow,
    'settingsEdit': s.settingsEdit,
    'settingsAccountNote': s.settingsAccountNote,
    'settingsAccountLegacyBadge': s.settingsAccountLegacyBadge,
    'settingsAccountSessionBadge': s.settingsAccountSessionBadge,
    'settingsAccountInstance': s.settingsAccountInstance,
    'settingsAccountInstanceNote': s.settingsAccountInstanceNote,
    'settingsAccountLegacyNote': s.settingsAccountLegacyNote,
    'settingsChangePassword': s.settingsChangePassword,
    'settingsLogout': s.settingsLogout,
    'settingsSetPasswordFirst': s.settingsSetPasswordFirst,
    'settingsPasswordChanged': s.settingsPasswordChanged,
    'settingsLogoutBody': s.settingsLogoutBody,
    'settingsCloseInstance': s.settingsCloseInstance,
    'settingsCloseInstanceBody': s.settingsCloseInstanceBody,
    'gateHintSessionExpired': s.gateHintSessionExpired,
    'gateHintSetupNeeded': s.gateHintSetupNeeded,
    'gateHintAlreadyInitialized': s.gateHintAlreadyInitialized,
    // 门上那三档里只有"看 gui.log"那一句是无参的（①②两档自带端口/阶段，是带参句子）
    'gateBackendLogHint': s.gateBackendLogHint,
    // 实例选择页（2026-10）：无参的那几条可覆盖；带参的（pickerProblemDirNotEmpty 那一族）
    // 与其它带参句子同一条边界——参数没有可填的位置，见文件头第 1 条。
    'pickerTitle': s.pickerTitle,
    'pickerBody': s.pickerBody,
    'pickerLoading': s.pickerLoading,
    'pickerEmpty': s.pickerEmpty,
    'pickerUnreadable': s.pickerUnreadable,
    'pickerRunning': s.pickerRunning,
    'pickerStopped': s.pickerStopped,
    'pickerDefaultBadge': s.pickerDefaultBadge,
    'pickerLogin': s.pickerLogin,
    'pickerStart': s.pickerStart,
    'pickerStarting': s.pickerStarting,
    'pickerEnter': s.pickerEnter,
    'pickerStartEnter': s.pickerStartEnter,
    'pickerEntering': s.pickerEntering,
    'pickerForget': s.pickerForget,
    'pickerSessionExpired': s.pickerSessionExpired,
    'pickerNew': s.pickerNew,
    'pickerDelete': s.pickerDelete,
    'pickerNewNameLabel': s.pickerNewNameLabel,
    'pickerNewDirLabel': s.pickerNewDirLabel,
    'pickerNewCreate': s.pickerNewCreate,
    'pickerNewUseDir': s.pickerNewUseDir,
    'pickerDeleteTitle': s.pickerDeleteTitle,
    'pickerDeleteNote': s.pickerDeleteNote,
    'pickerDeleteKeepDir': s.pickerDeleteKeepDir,
    'pickerDeleteWithDir': s.pickerDeleteWithDir,
    'pickerRename': s.pickerRename,
    'pickerRenameTitle': s.pickerRenameTitle,
    'pickerRenameBody': s.pickerRenameBody,
    'pickerRenameSave': s.pickerRenameSave,
    'pickerProblemNameRequired': s.pickerProblemNameRequired,
    'pickerProblemNoLauncher': s.pickerProblemNoLauncher,
    'pickerProblemLaunchFailed': s.pickerProblemLaunchFailed,
    'pickerProblemPortUnavailable': s.pickerProblemPortUnavailable,
    'pickerProblemRemoveFailed': s.pickerProblemRemoveFailed,
    'pickerProblemRenameFailed': s.pickerProblemRenameFailed,
    // 等就绪那一行是带参句子（秒数 + 阶段），按同一条边界不进这张表；那颗按钮是无参的
    'pickerStopWaiting': s.pickerStopWaiting,
    'settingsAboutNote': s.settingsAboutNote,
    'settingsAboutBadge': s.settingsAboutBadge,
    'settingsVersionLabel': s.settingsVersionLabel,
    'settingsGuardedDays': s.settingsGuardedDays,
    'settingsWatermark': s.settingsWatermark,
    'settingsProjectionFootnote': s.settingsProjectionFootnote,
    'settingsDestructivePolicy': s.settingsDestructivePolicy,
    'settingsModify': s.settingsModify,
    'settingsPolicyNoneOption': s.settingsPolicyNoneOption,
    'settingsPolicyAllOption': s.settingsPolicyAllOption,
    'settingsPolicyListOption': s.settingsPolicyListOption,
    'settingsPolicyListTitle': s.settingsPolicyListTitle,
    'settingsPolicyNoTools': s.settingsPolicyNoTools,
    'settingsDestructiveTitle': s.settingsDestructiveTitle,
    'settingsDestructiveRelaxedBody': s.settingsDestructiveRelaxedBody,
    'settingsDestructiveRestrictedBody': s.settingsDestructiveRestrictedBody,
    'settingsPolicyAll': s.settingsPolicyAll,
    'settingsPolicyListEmpty': s.settingsPolicyListEmpty,
    'settingsPolicyNone': s.settingsPolicyNone,
    'settingsListAnd': s.settingsListAnd,
    'settingsUnknownReason': s.settingsUnknownReason,
    'settingsSeeOfficialDocs': s.settingsSeeOfficialDocs,
    'settingsWebhookCurlTokenPlaceholder': s.settingsWebhookCurlTokenPlaceholder,
    'settingsWebhookCurlSampleText': s.settingsWebhookCurlSampleText,
    'chanSourceQqOfficial': s.chanSourceQqOfficial,
    'chanEventInboundWake': s.chanEventInboundWake,
    'chanEventFile': s.chanEventFile,
    'chanAlertExit': s.chanAlertExit,
    'chanQqAppIdHint': s.chanQqAppIdHint,
    'chanQqAppSecretHint': s.chanQqAppSecretHint,
    'chanOneBotTokenHint': s.chanOneBotTokenHint,
    'chanQqApiBaseLabel': s.chanQqApiBaseLabel,
    'chanQqUrlHint': s.chanQqUrlHint,
    'chanQqTokenUrlLabel': s.chanQqTokenUrlLabel,
    'chanQqGatewayUrlLabel': s.chanQqGatewayUrlLabel,
    'chanQqGatewayHint': s.chanQqGatewayHint,
    'chanOneBotWsLabel': s.chanOneBotWsLabel,
    'chanOneBotWsHint': s.chanOneBotWsHint,
    'chanAlertWebhookLabel': s.chanAlertWebhookLabel,
    'chanAlertWebhookHint': s.chanAlertWebhookHint,
    'chanAlertRateLabel': s.chanAlertRateLabel,
    'chanAlertRateHint': s.chanAlertRateHint,
    'chanEndpointLabel': s.chanEndpointLabel,
    'chanListenLabel': s.chanListenLabel,
    'chanQqTitle': s.chanQqTitle,
    'chanQqHint': s.chanQqHint,
    'chanOneBotHint': s.chanOneBotHint,
    'chanOneBotBlurb': s.chanOneBotBlurb,
    'chanHookTitle': s.chanHookTitle,
    'chanHookHint': s.chanHookHint,
    'chanHookBlurb': s.chanHookBlurb,
    'chanConfigReadFailed': s.chanConfigReadFailed,
    'chanKeysReadFailed': s.chanKeysReadFailed,
    'chanClearSecretBody': s.chanClearSecretBody,
    'chanNothingToSave': s.chanNothingToSave,
    'chanSavedRestartSuffix': s.chanSavedRestartSuffix,
    'chanSavedLiveSuffix': s.chanSavedLiveSuffix,
    'chanReloaded': s.chanReloaded,
    'chanStatusUnknown': s.chanStatusUnknown,
    'chanStatusUnknownNote': s.chanStatusUnknownNote,
    'chanStatusOff': s.chanStatusOff,
    'chanStatusOffNote': s.chanStatusOffNote,
    'chanStatusOn': s.chanStatusOn,
    'chanStatusOnNote': s.chanStatusOnNote,
    'chanStatusNoExit': s.chanStatusNoExit,
    'chanStatusNoExitNote': s.chanStatusNoExitNote,
    'chanStatusExitOn': s.chanStatusExitOn,
    'chanStatusExitOnNote': s.chanStatusExitOnNote,
    'chanPageTitle': s.chanPageTitle,
    'chanPageSubtitle': s.chanPageSubtitle,
    'chanGuideText': s.chanGuideText,
    'chanGuideAction': s.chanGuideAction,
    'chanGuideHint': s.chanGuideHint,
    'chanListHeader': s.chanListHeader,
    'chanReloadAction': s.chanReloadAction,
    'chanConfigAction': s.chanConfigAction,
    'chanConfigUnavailable': s.chanConfigUnavailable,
    'chanConfigUnavailableHint': s.chanConfigUnavailableHint,
    'chanBackToList': s.chanBackToList,
    'chanRecentActivity': s.chanRecentActivity,
    'chanMentionTitle': s.chanMentionTitle,
    'chanMentionNote': s.chanMentionNote,
    'chanMentionEmpty': s.chanMentionEmpty,
    'chanMentionHint': s.chanMentionHint,
    'chanMentionCleared': s.chanMentionCleared,
    'chanContactsTitle': s.chanContactsTitle,
    'chanContactsNote': s.chanContactsNote,
    'chanDetailsLabel': s.chanDetailsLabel,
    'chanContactsDetail': s.chanContactsDetail,
    'chanContactsEmpty': s.chanContactsEmpty,
    'chanGroupSceneLabel': s.chanGroupSceneLabel,
    'chanGroupSceneHard': s.chanGroupSceneHard,
    'chanGroupSceneSoft': s.chanGroupSceneSoft,
    'chanContactsRestartNote': s.chanContactsRestartNote,
    'chanContactHint': s.chanContactHint,
    'chanContactSaveTooltip': s.chanContactSaveTooltip,
    'chanMembersCollapse': s.chanMembersCollapse,
    'chanWarnExempt': s.chanWarnExempt,
    'chanWarnOn': s.chanWarnOn,
    'chanMemberSaveTooltip': s.chanMemberSaveTooltip,
    'chanExemptSessionOn': s.chanExemptSessionOn,
    'chanExemptSessionOff': s.chanExemptSessionOff,
    'chanExemptMemberOn': s.chanExemptMemberOn,
    'chanExemptMemberOff': s.chanExemptMemberOff,
    'chanGroupSceneHardToast': s.chanGroupSceneHardToast,
    'chanGroupSceneSoftToast': s.chanGroupSceneSoftToast,
    'chanNameRequired': s.chanNameRequired,
    'chanContactCleared': s.chanContactCleared,
    'chanConfigTitle': s.chanConfigTitle,
    'chanNeedsRestart': s.chanNeedsRestart,
    'chanConfigNote': s.chanConfigNote,
    'chanConfigDetail': s.chanConfigDetail,
    'chanTestAlert': s.chanTestAlert,
    'chanEnableLabel': s.chanEnableLabel,
    'chanEnableNoteOn': s.chanEnableNoteOn,
    'chanEnableNoteOff': s.chanEnableNoteOff,
    'chanSecretHintConfigured': s.chanSecretHintConfigured,
    'chanNumberHint': s.chanNumberHint,
    'chanNotSetHint': s.chanNotSetHint,
    'chanChannelIdLabel': s.chanChannelIdLabel,
    'chanFeedEmpty': s.chanFeedEmpty,
    'chanSourceExternal': s.chanSourceExternal,
    'chanEventGeneric': s.chanEventGeneric,
    'chanJoinWords': s.chanJoinWords,
    'schedNotProjection': s.schedNotProjection,
    'schedCancelTitle': s.schedCancelTitle,
    'schedCancelPlan': s.schedCancelPlan,
    'schedBuiltToast': s.schedBuiltToast,
    'schedNoServerTime': s.schedNoServerTime,
    'schedSearchTitle': s.schedSearchTitle,
    'schedSearchHint': s.schedSearchHint,
    'schedSearch': s.schedSearch,
    'schedPageTitle': s.schedPageTitle,
    'schedPageSubtitle': s.schedPageSubtitle,
    'schedBackToThisWeek': s.schedBackToThisWeek,
    'schedNewPlan': s.schedNewPlan,
    'schedLoading': s.schedLoading,
    'schedLoadHint': s.schedLoadHint,
    'schedStatThisWeek': s.schedStatThisWeek,
    'schedStatThisWeekNote': s.schedStatThisWeekNote,
    'schedStatWaiting': s.schedStatWaiting,
    'schedStatWaitingNote': s.schedStatWaitingNote,
    'schedStatSelfWork': s.schedStatSelfWork,
    'schedStatSelfWorkNote': s.schedStatSelfWorkNote,
    'schedStatDrafts': s.schedStatDrafts,
    'schedStatDraftsNote': s.schedStatDraftsNote,
    'schedCalendarTitle': s.schedCalendarTitle,
    'schedPrevWeek': s.schedPrevWeek,
    'schedNextWeek': s.schedNextWeek,
    'schedRecurringPill': s.schedRecurringPill,
    'schedWeekEmpty': s.schedWeekEmpty,
    'schedListTitle': s.schedListTitle,
    'schedShowAll': s.schedShowAll,
    'schedClearSearch': s.schedClearSearch,
    'schedActionGoneHint': s.schedActionGoneHint,
    'schedListNoMatch': s.schedListNoMatch,
    'schedListEmpty': s.schedListEmpty,
    'schedListEmptyHint': s.schedListEmptyHint,
    'schedDetailPlaceholder': s.schedDetailPlaceholder,
    'schedFieldWhen': s.schedFieldWhen,
    'schedFieldWhy': s.schedFieldWhy,
    'schedFieldWhat': s.schedFieldWhat,
    'schedFieldWhere': s.schedFieldWhere,
    'schedFieldDuration': s.schedFieldDuration,
    'schedFieldAfter': s.schedFieldAfter,
    'schedUnwritten': s.schedUnwritten,
    'schedSeeChat': s.schedSeeChat,
    'schedChoiceNotify': s.schedChoiceNotify,
    'schedChoiceSelf': s.schedChoiceSelf,
    'schedChoiceDraft': s.schedChoiceDraft,
    'schedKindMemoryMaintain': s.schedKindMemoryMaintain,
    'schedKindWait': s.schedKindWait,
    'schedUntitled': s.schedUntitled,
    'schedStatusDraft': s.schedStatusDraft,
    'schedStatusRecurring': s.schedStatusRecurring,
    'schedStatusWaiting': s.schedStatusWaiting,
    'schedWakeDeduped': s.schedWakeDeduped,
    'schedViewWeek': s.schedViewWeek,
    'schedViewList': s.schedViewList,
    'schedChorePill': s.schedChorePill,
    'schedErrDate': s.schedErrDate,
    'schedErrClock': s.schedErrClock,
    'schedErrWhat': s.schedErrWhat,
    'schedErrDuration': s.schedErrDuration,
    'schedRepeatDaily': s.schedRepeatDaily,
    'schedRepeatWeekly': s.schedRepeatWeekly,
    'schedErrBrief': s.schedErrBrief,
    'schedCardLead': s.schedCardLead,
    'schedPathHer': s.schedPathHer,
    'schedPathDirect': s.schedPathDirect,
    'schedLater': s.schedLater,
    'schedSending': s.schedSending,
    'schedCreateDirect': s.schedCreateDirect,
    'schedLetHerSchedule': s.schedLetHerSchedule,
    'schedFieldBrief': s.schedFieldBrief,
    'schedBriefHint': s.schedBriefHint,
    'schedBriefNote': s.schedBriefNote,
    'schedFieldDay': s.schedFieldDay,
    'schedDayHint': s.schedDayHint,
    'schedFieldClock': s.schedFieldClock,
    'schedFieldRepeat': s.schedFieldRepeat,
    'schedRepeatOnceChoice': s.schedRepeatOnceChoice,
    'schedRepeatWeeklyChoice': s.schedRepeatWeeklyChoice,
    'schedFieldWhatToDo': s.schedFieldWhatToDo,
    'schedWhatHint': s.schedWhatHint,
    'schedMoreOptions': s.schedMoreOptions,
    'schedFieldTitle': s.schedFieldTitle,
    'schedTitleHint': s.schedTitleHint,
    'schedFieldWhyInput': s.schedFieldWhyInput,
    'schedWhyHint': s.schedWhyHint,
    'schedFieldDurationInput': s.schedFieldDurationInput,
    'schedFieldCategory': s.schedFieldCategory,
    'schedNoCategory': s.schedNoCategory,
    'schedFieldSid': s.schedFieldSid,
    'schedNoSid': s.schedNoSid,
    'schedPastWarning': s.schedPastWarning,
    'schedCreateNote': s.schedCreateNote,
    'schedWeekdayMon': s.schedWeekdayMon,
    'schedWeekdayTue': s.schedWeekdayTue,
    'schedWeekdayWed': s.schedWeekdayWed,
    'schedWeekdayThu': s.schedWeekdayThu,
    'schedWeekdayFri': s.schedWeekdayFri,
    'schedWeekdaySat': s.schedWeekdaySat,
    'schedWeekdaySun': s.schedWeekdaySun,
    'schedCatWork': s.schedCatWork,
    'schedCatPersonal': s.schedCatPersonal,
    'schedCatLife': s.schedCatLife,
    'schedCatRoutine': s.schedCatRoutine,
    'schedActionSelf': s.schedActionSelf,
    'schedActionNotify': s.schedActionNotify,
    'schedActionDraft': s.schedActionDraft,
    'extSectionSkills': s.extSectionSkills,
    'extSectionSkillsBlurb': s.extSectionSkillsBlurb,
    'extSectionMcpBlurb': s.extSectionMcpBlurb,
    'extSectionTools': s.extSectionTools,
    'extSectionToolsBlurb': s.extSectionToolsBlurb,
    'extSectionHooksBlurb': s.extSectionHooksBlurb,
    'extSectionPlugins': s.extSectionPlugins,
    'extSectionPluginsBlurb': s.extSectionPluginsBlurb,
    'extPluginInstall': s.extPluginInstall,
    'extPluginInstallTitle': s.extPluginInstallTitle,
    'extPluginSourceDir': s.extPluginSourceDir,
    'extPluginSourceHint': s.extPluginSourceHint,
    'extPluginAbsoluteRequired': s.extPluginAbsoluteRequired,
    'extPluginEmpty': s.extPluginEmpty,
    'extPluginEmptyHint': s.extPluginEmptyHint,
    'extPluginRestartRequired': s.extPluginRestartRequired,
    'extPluginPermissionsLabel': s.extPluginPermissionsLabel,
    'extPluginProblemsLabel': s.extPluginProblemsLabel,
    'extPluginReview': s.extPluginReview,
    'extPluginEnable': s.extPluginEnable,
    'extPluginDisable': s.extPluginDisable,
    'extPluginRestartBody': s.extPluginRestartBody,
    'extPluginInstalledToast': s.extPluginInstalledToast,
    'extBadResponse': s.extBadResponse,
    'extPageSubtitle': s.extPageSubtitle,
    'extListHeader': s.extListHeader,
    'extDataReadFailed': s.extDataReadFailed,
    'extBackToList': s.extBackToList,
    'extRescan': s.extRescan,
    'extNewSkill': s.extNewSkill,
    'extNoSkills': s.extNoSkills,
    'extNoSkillsHint': s.extNoSkillsHint,
    'extPendingTitle': s.extPendingTitle,
    'extPendingHint': s.extPendingHint,
    'extActiveTitle': s.extActiveTitle,
    'extActiveHint': s.extActiveHint,
    'extActiveEmpty': s.extActiveEmpty,
    'extIgnoredTitle': s.extIgnoredTitle,
    'extIgnoredHint': s.extIgnoredHint,
    'extRejectedTitle': s.extRejectedTitle,
    'extRejectedHint': s.extRejectedHint,
    'extGuideSkillPath': s.extGuideSkillPath,
    'extGuideSkillTrust': s.extGuideSkillTrust,
    'extInCatalogBadge': s.extInCatalogBadge,
    'extFieldDescription': s.extFieldDescription,
    'extFieldSkillFile': s.extFieldSkillFile,
    'extFieldSizeHash': s.extFieldSizeHash,
    'extFieldTrustDetail': s.extFieldTrustDetail,
    'extActionRestore': s.extActionRestore,
    'extActionRetire': s.extActionRetire,
    'extActionDelete': s.extActionDelete,
    'extActionConfirm': s.extActionConfirm,
    'extActionIgnore': s.extActionIgnore,
    'extRetireBody': s.extRetireBody,
    'extDisable': s.extDisable,
    'extDeleteBody': s.extDeleteBody,
    'extDelete': s.extDelete,
    'extCreateHint': s.extCreateHint,
    'extFieldSkillName': s.extFieldSkillName,
    'extSkillNameHint': s.extSkillNameHint,
    'extSkillNameInvalid': s.extSkillNameInvalid,
    'extFieldOneLineDesc': s.extFieldOneLineDesc,
    'extOneLineDescHint': s.extOneLineDescHint,
    'extAddServer': s.extAddServer,
    'extUnpreparedTitle': s.extUnpreparedTitle,
    'extUnpreparedHint': s.extUnpreparedHint,
    'extConfigProblems': s.extConfigProblems,
    'extConfigProblemsHint': s.extConfigProblemsHint,
    'extAnsweredTitle': s.extAnsweredTitle,
    'extAnsweredHint': s.extAnsweredHint,
    'extGuideMcp1': s.extGuideMcp1,
    'extGuideMcp2': s.extGuideMcp2,
    'extGuideMcp3': s.extGuideMcp3,
    'extGrantAfterSkillInstall': s.extGrantAfterSkillInstall,
    'extGrantAfterSkillRemove': s.extGrantAfterSkillRemove,
    'extGrantExecOkSkillInstall': s.extGrantExecOkSkillInstall,
    'extGrantExecOkSkillRemove': s.extGrantExecOkSkillRemove,
    'extGrantLabelSkillInstall': s.extGrantLabelSkillInstall,
    'grantInboxSource': s.grantInboxSource,
    'grantInboxRiskSkillInstall': s.grantInboxRiskSkillInstall,
    'grantInboxRiskSkillRemove': s.grantInboxRiskSkillRemove,
    'grantInboxRiskMcpAdd': s.grantInboxRiskMcpAdd,
    'grantInboxRiskMcpRemove': s.grantInboxRiskMcpRemove,
    'grantInboxRiskUnknown': s.grantInboxRiskUnknown,
    'grantInboxHighRiskBadge': s.grantInboxHighRiskBadge,
    'grantInboxApprove': s.grantInboxApprove,
    'grantInboxApproveHighRisk': s.grantInboxApproveHighRisk,
    'grantInboxReject': s.grantInboxReject,
    'grantInboxDetails': s.grantInboxDetails,
    'grantInboxWorking': s.grantInboxWorking,
    'grantInboxCollapseTooltip': s.grantInboxCollapseTooltip,
    'grantInboxExpandTooltip': s.grantInboxExpandTooltip,
    'grantInboxOpenExtensions': s.grantInboxOpenExtensions,
    'grantInboxDetailsClose': s.grantInboxDetailsClose,
    'grantUnreadableTitle': s.grantUnreadableTitle,
    'extNoServers': s.extNoServers,
    'extNoServersHint1': s.extNoServersHint1,
    'extNoServersHint2': s.extNoServersHint2,
    'extDisabledBadge': s.extDisabledBadge,
    'extCollapseServer': s.extCollapseServer,
    'extExpandServer': s.extExpandServer,
    'extNoDesc': s.extNoDesc,
    'extFieldCommand': s.extFieldCommand,
    'extFieldEnv': s.extFieldEnv,
    'extStartingProcess': s.extStartingProcess,
    'extTestConnection': s.extTestConnection,
    'extEditServerTooltip': s.extEditServerTooltip,
    'extDeleteServerTooltip': s.extDeleteServerTooltip,
    'extNoToolDesc': s.extNoToolDesc,
    'extNoChange': s.extNoChange,
    'extTakeEffectNow': s.extTakeEffectNow,
    'extNeedsRestart': s.extNeedsRestart,
    'extEditMcpTitle': s.extEditMcpTitle,
    'extAddMcpTitle': s.extAddMcpTitle,
    'extMcpFormLead': s.extMcpFormLead,
    'extFieldServerName': s.extFieldServerName,
    'extServerNameHint': s.extServerNameHint,
    'extCommandHint': s.extCommandHint,
    'extFieldDesc': s.extFieldDesc,
    'extDescHint': s.extDescHint,
    'extDescNote': s.extDescNote,
    'extFieldArgs': s.extFieldArgs,
    'extArgsHint': s.extArgsHint,
    'extFieldEnvForm': s.extFieldEnvForm,
    'extEnvHint': s.extEnvHint,
    'extFieldTestTimeout': s.extFieldTestTimeout,
    'extTestTimeoutHint': s.extTestTimeoutHint,
    'extEnableSwitchLabel': s.extEnableSwitchLabel,
    'extNameAndCommandRequired': s.extNameAndCommandRequired,
    'extFillCommandFirst': s.extFillCommandFirst,
    'extConnectOk': s.extConnectOk,
    'extConnectFailed': s.extConnectFailed,
    'extProbeNoTools': s.extProbeNoTools,
    'extUnknownReason': s.extUnknownReason,
    'extGotIt': s.extGotIt,
    'extDeleteServerBody': s.extDeleteServerBody,
    'extNoToolRegistry': s.extNoToolRegistry,
    'extNoToolRegistryHint': s.extNoToolRegistryHint,
    'extRefresh': s.extRefresh,
    'extToolsHint1': s.extToolsHint1,
    'extToolsHint2': s.extToolsHint2,
    'extEnableAll': s.extEnableAll,
    'extDisableAll': s.extDisableAll,
    'extOffBadge': s.extOffBadge,
    'extFieldMode': s.extFieldMode,
    'extFieldTimeout': s.extFieldTimeout,
    'extToggleOffMessage': s.extToggleOffMessage,
    'extToggleOnMessage': s.extToggleOnMessage,
    'extAddHook': s.extAddHook,
    'extHooksTitle': s.extHooksTitle,
    'extHooksHint': s.extHooksHint,
    'extHooksEmpty': s.extHooksEmpty,
    'extInvalidEntries': s.extInvalidEntries,
    'extInvalidEntriesHint': s.extInvalidEntriesHint,
    'extHookBoundary1': s.extHookBoundary1,
    'extHookBoundary2': s.extHookBoundary2,
    'extFieldEvent': s.extFieldEvent,
    'extFieldCondition': s.extFieldCondition,
    'extHookToggleOffMessage': s.extHookToggleOffMessage,
    'extHookToggleOnMessage': s.extHookToggleOnMessage,
    'extEditHookTooltip': s.extEditHookTooltip,
    'extDeleteHookTooltip': s.extDeleteHookTooltip,
    'extEditHookTitle': s.extEditHookTitle,
    'extHookDialogNote': s.extHookDialogNote,
    'extFieldExecutionPoint': s.extFieldExecutionPoint,
    'extFieldMatcher': s.extFieldMatcher,
    'extWakeMatcherHint': s.extWakeMatcherHint,
    'extToolMatcherHint': s.extToolMatcherHint,
    'extFieldShellCommand': s.extFieldShellCommand,
    'extShellCommandHint': s.extShellCommandHint,
    'extFieldConditionOptional': s.extFieldConditionOptional,
    'extConditionHint': s.extConditionHint,
    'extFieldTimeoutMs': s.extFieldTimeoutMs,
    'extTimeoutHint': s.extTimeoutHint,
    'extEnableHookSwitch': s.extEnableHookSwitch,
    'extMatcherAndCommandRequired': s.extMatcherAndCommandRequired,
    'extHookSavedToast': s.extHookSavedToast,
    'extHookDeletedToast': s.extHookDeletedToast,
    'extStatusUnknown': s.extStatusUnknown,
    'extReading': s.extReading,
    'extNoReasonGiven': s.extNoReasonGiven,
    'extRestartSuffix': s.extRestartSuffix,
    'extServerNoReason': s.extServerNoReason,
    'extEnabledWord': s.extEnabledWord,
    'extAllOnWord': s.extAllOnWord,
    'extAllOffWord': s.extAllOffWord,
    'extDisabledWord': s.extDisabledWord,
    // 更新检查（2026-10-22）
    'updateView': s.updateView,
    'updateDismiss': s.updateDismiss,
    'updateSectionTitle': s.updateSectionTitle,
    'updateSectionNote': s.updateSectionNote,
    'updateCheckNow': s.updateCheckNow,
    'updateChecking': s.updateChecking,
    'updateUpToDate': s.updateUpToDate,
    'updateDisabled': s.updateDisabled,
    'updateNeverChecked': s.updateNeverChecked,
    'updateNoPage': s.updateNoPage,
    'updateRequiredNotice': s.updateRequiredNotice,
    'updateChannelMismatchText': s.updateChannelMismatchText,
    'updateDownloadTitle': s.updateDownloadTitle,
    'updateDownloadNote': s.updateDownloadNote,
    'updateGitHubDownload': s.updateGitHubDownload,
    'updateNetdiskDownload': s.updateNetdiskDownload,
    'updateNetdiskSoon': s.updateNetdiskSoon,
    'updateBaiduDownload': s.updateBaiduDownload,
    'updateQuarkDownload': s.updateQuarkDownload,
    'updatePendingUpload': s.updatePendingUpload,
    'updateCopyCode': s.updateCopyCode,
    'updateCopied': s.updateCopied,
    'updateReleasePage': s.updateReleasePage,
    'updateChannelSwitchNote': s.updateChannelSwitchNote,
    'settingsProtocolThirdPartyTitle': s.settingsProtocolThirdPartyTitle,
    'settingsProtocolThirdPartyNote': s.settingsProtocolThirdPartyNote,
    'settingsProtocolOfficialProject': s.settingsProtocolOfficialProject,
    'settingsProtocolOfficialSite': s.settingsProtocolOfficialSite,
    'settingsProtocolLicenseRow': s.settingsProtocolLicenseRow,
};

/// 可覆盖的键（懒加载一次：= [AppStrings] 的全部无参 getter）
final Set<String> stringOverrideKeys = stringsAsMap(const ZhStrings()).keys.toSet();

/// 把某一段（zh 或 en）里的键值收进 [target]，认不出的进 [ignored]。
///
/// [ignored] 里的句子是**日志现场**（键名 + 原因），刻意写成 ASCII：真正给人看的那句话
/// 在 `AppStrings` 里（设置页那行状态 + [stringsOverrideIgnored]），这一份只落到控制台。
void _collect(
  String section,
  Map<dynamic, dynamic> raw,
  Map<String, String> target,
  List<String> ignored,
) {
  for (final entry in raw.entries) {
    final key = '${entry.key}';
    final value = entry.value;
    if (value is! String) {
      ignored.add('$section.$key: value is not a string');
      continue;
    }
    if (!stringOverrideKeys.contains(key)) {
      ignored.add('$section.$key: unknown key');
      continue;
    }
    target[key] = value;
  }
}

/// 把这次加载的结局写进控制台 / 启动日志（ASCII：它与界面语言无关，是排障那一份）。
///
/// 为什么值得打：拼错的键**不会**让界面报错（静默忽略是刻意的），于是"我改了怎么没变"
/// 的唯一线索就在这里。文件路径也一并打出来——人常把文件放到另一个 `%APPDATA%` 下。
void _logSnapshot(StringsOverrideSnapshot snapshot) {
  final kind = snapshot.errorKind;
  if (kind != null) {
    debugPrint(
      '[strings-override] ${kind.name}: falling back to built-in text '
      '(${snapshot.errorDetail}) ${snapshot.filePath}',
    );
  } else if (snapshot.total > 0) {
    debugPrint(
      '[strings-override] loaded ${snapshot.total} override(s) '
      '(zh ${snapshot.zh.length} / en ${snapshot.en.length}): ${snapshot.filePath}',
    );
  }
  if (snapshot.ignored.isEmpty) return;
  debugPrint('[strings-override] ${snapshot.ignored.length} entr(y/ies) ignored (startup not affected):');
  for (final item in snapshot.ignored) {
    debugPrint('  - $item');
  }
}

/// 默认文案 + 一层覆盖值。**这就是"同一个 [AppStrings] 接口"的兑现方式**：
/// 页面拿到的还是 [AppStrings]，一行不用改。
///
/// 解析顺序：`overrides[键]` 有值就用它，否则回 [base] 的那一条。能被覆盖的只有
/// **无参 getter**（[stringOverrideKeys]）；带参句子原样委托给 [base]（它们的语序
/// 与参数位置由实现决定，交给用户改等于把两种语言的语序都写死成一种）。
class OverriddenStrings extends AppStrings {
  const OverriddenStrings({
    required this.base,
    required this.overrides,
    this.revision = 0,
  });

  /// 默认文案（[ZhStrings] / [EnStrings] 之一）
  final AppStrings base;

  /// 生效的覆盖值（构造前已过滤：只有认识的键）
  final Map<String, String> overrides;

  /// 覆盖层版次（见 [AppStrings.revision]）
  @override
  final int revision;

  @override
  AppLanguage get language => base.language;

  @override
  String get retry => overrides['retry'] ?? base.retry;

  // 插件平台这批文案是后加的，第一版漏了整组 —— 少一条这个类就编不过
  // （Dart 的非抽象类必须实现全部成员）。按本文件的规矩分开处理：
  //   · 无参 getter 能被人改 => 先看 overrides 再回 base
  //   · 带参句子语序由实现决定 => 原样委托给 base
  @override
  String get extSectionPlugins => overrides['extSectionPlugins'] ?? base.extSectionPlugins;
  @override
  String get extSectionPluginsBlurb => overrides['extSectionPluginsBlurb'] ?? base.extSectionPluginsBlurb;
  @override
  String get extPluginInstall => overrides['extPluginInstall'] ?? base.extPluginInstall;
  @override
  String get extPluginInstallTitle => overrides['extPluginInstallTitle'] ?? base.extPluginInstallTitle;
  @override
  String get extPluginSourceDir => overrides['extPluginSourceDir'] ?? base.extPluginSourceDir;
  @override
  String get extPluginSourceHint => overrides['extPluginSourceHint'] ?? base.extPluginSourceHint;
  @override
  String get extPluginAbsoluteRequired => overrides['extPluginAbsoluteRequired'] ?? base.extPluginAbsoluteRequired;
  @override
  String get extPluginEmpty => overrides['extPluginEmpty'] ?? base.extPluginEmpty;
  @override
  String get extPluginEmptyHint => overrides['extPluginEmptyHint'] ?? base.extPluginEmptyHint;
  @override
  String extPluginSummary(int count) => base.extPluginSummary(count);
  @override
  String extPluginStat(int count) => base.extPluginStat(count);
  @override
  String extPluginState(String state) => base.extPluginState(state);
  @override
  String get extPluginRestartRequired => overrides['extPluginRestartRequired'] ?? base.extPluginRestartRequired;
  @override
  String extPluginContributions(int skills, int hooks, int mcp) => base.extPluginContributions(skills, hooks, mcp);
  @override
  String extPluginVersionHash(String version, String hash) => base.extPluginVersionHash(version, hash);
  @override
  String get extPluginPermissionsLabel => overrides['extPluginPermissionsLabel'] ?? base.extPluginPermissionsLabel;
  @override
  String get extPluginProblemsLabel => overrides['extPluginProblemsLabel'] ?? base.extPluginProblemsLabel;
  @override
  String get extPluginReview => overrides['extPluginReview'] ?? base.extPluginReview;
  @override
  String extPluginReviewTitle(String id) => base.extPluginReviewTitle(id);
  @override
  String extPluginReviewBody(String id, String hash) => base.extPluginReviewBody(id, hash);
  @override
  String get extPluginEnable => overrides['extPluginEnable'] ?? base.extPluginEnable;
  @override
  String get extPluginDisable => overrides['extPluginDisable'] ?? base.extPluginDisable;
  @override
  String extPluginEnableTitle(String id) => base.extPluginEnableTitle(id);
  @override
  String extPluginDisableTitle(String id) => base.extPluginDisableTitle(id);
  @override
  String get extPluginRestartBody => overrides['extPluginRestartBody'] ?? base.extPluginRestartBody;
  @override
  String get extPluginInstalledToast => overrides['extPluginInstalledToast'] ?? base.extPluginInstalledToast;
  @override
  String extPluginConfirmedToast(String id) => base.extPluginConfirmedToast(id);
  @override
  String extPluginRestartToast(String action, String id) => base.extPluginRestartToast(action, id);
  @override
  String extPluginFailed(String reason) => base.extPluginFailed(reason);
  @override
  String extPluginCircuit(String contribution, int count) => base.extPluginCircuit(contribution, count);
  @override
  String extPluginCircuitReason(String reason) => base.extPluginCircuitReason(reason);
  @override
  String extPluginRetryAt(String at) => base.extPluginRetryAt(at);
  @override
  String get cancel => overrides['cancel'] ?? base.cancel;
  @override
  String get confirm => overrides['confirm'] ?? base.confirm;
  @override
  String get save => overrides['save'] ?? base.save;
  @override
  String get loading => overrides['loading'] ?? base.loading;
  @override
  String get error => overrides['error'] ?? base.error;
  @override
  String get empty => overrides['empty'] ?? base.empty;
  @override
  String get collapse => overrides['collapse'] ?? base.collapse;
  @override
  String get settingsLoadingConfig => overrides['settingsLoadingConfig'] ?? base.settingsLoadingConfig;
  @override
  String get navChat => overrides['navChat'] ?? base.navChat;
  @override
  String get navSettings => overrides['navSettings'] ?? base.navSettings;
  @override
  String get navOverview => overrides['navOverview'] ?? base.navOverview;
  @override
  String get navChannels => overrides['navChannels'] ?? base.navChannels;
  @override
  String get navExtensions => overrides['navExtensions'] ?? base.navExtensions;
  @override
  String get navPersona => overrides['navPersona'] ?? base.navPersona;
  @override
  String get navSchedule => overrides['navSchedule'] ?? base.navSchedule;
  @override
  String get navMemory => overrides['navMemory'] ?? base.navMemory;
  @override
  String get navLogs => overrides['navLogs'] ?? base.navLogs;
  @override
  String get navMore => overrides['navMore'] ?? base.navMore;
  @override
  String get overviewConfigGuide => overrides['overviewConfigGuide'] ?? base.overviewConfigGuide;
  @override
  String get restartSentWithGui => overrides['restartSentWithGui'] ?? base.restartSentWithGui;
  @override
  String get restartSentBackendOnly => overrides['restartSentBackendOnly'] ?? base.restartSentBackendOnly;
  @override
  String get restartNoConclusion => overrides['restartNoConclusion'] ?? base.restartNoConclusion;
  @override
  String get restartBackReady => overrides['restartBackReady'] ?? base.restartBackReady;
  @override
  String get restartNeverWentDown => overrides['restartNeverWentDown'] ?? base.restartNeverWentDown;
  @override
  String get trayShow => overrides['trayShow'] ?? base.trayShow;
  @override
  String get trayHide => overrides['trayHide'] ?? base.trayHide;
  @override
  String get trayRestart => overrides['trayRestart'] ?? base.trayRestart;
  @override
  String get trayQuitUi => overrides['trayQuitUi'] ?? base.trayQuitUi;
  @override
  String get trayQuitAll => overrides['trayQuitAll'] ?? base.trayQuitAll;
  @override
  String get quitAllConfirmTitle => overrides['quitAllConfirmTitle'] ?? base.quitAllConfirmTitle;
  @override
  String get quitAllConfirmLabel => overrides['quitAllConfirmLabel'] ?? base.quitAllConfirmLabel;
  @override
  String get quitAllWorking => overrides['quitAllWorking'] ?? base.quitAllWorking;
  @override
  String get quitAllDone => overrides['quitAllDone'] ?? base.quitAllDone;
  @override
  String get onboardingManualSaved => overrides['onboardingManualSaved'] ?? base.onboardingManualSaved;
  @override
  String get onboardingManualNoChanges => overrides['onboardingManualNoChanges'] ?? base.onboardingManualNoChanges;
  @override
  String get onboardingManualOpenBadge => overrides['onboardingManualOpenBadge'] ?? base.onboardingManualOpenBadge;
  @override
  String get onboardingStepNameTitle => overrides['onboardingStepNameTitle'] ?? base.onboardingStepNameTitle;
  @override
  String get onboardingStepNameNote => overrides['onboardingStepNameNote'] ?? base.onboardingStepNameNote;
  @override
  String get onboardingStepApiTitle => overrides['onboardingStepApiTitle'] ?? base.onboardingStepApiTitle;
  @override
  String get onboardingStepApiNote => overrides['onboardingStepApiNote'] ?? base.onboardingStepApiNote;
  @override
  String get onboardingStepChannelTitle => overrides['onboardingStepChannelTitle'] ?? base.onboardingStepChannelTitle;
  @override
  String get onboardingStepChannelNote => overrides['onboardingStepChannelNote'] ?? base.onboardingStepChannelNote;
  @override
  String get onboardingStepPersonaTitle => overrides['onboardingStepPersonaTitle'] ?? base.onboardingStepPersonaTitle;
  @override
  String get onboardingStepPersonaNote => overrides['onboardingStepPersonaNote'] ?? base.onboardingStepPersonaNote;
  @override
  String get onboardingStepTrustTitle => overrides['onboardingStepTrustTitle'] ?? base.onboardingStepTrustTitle;
  @override
  String get onboardingStepTrustNote => overrides['onboardingStepTrustNote'] ?? base.onboardingStepTrustNote;
  @override
  String get onboardingApiRecommendLead => overrides['onboardingApiRecommendLead'] ?? base.onboardingApiRecommendLead;
  @override
  String get onboardingApiRecommendModel => overrides['onboardingApiRecommendModel'] ?? base.onboardingApiRecommendModel;
  @override
  String get onboardingApiRegisterKey => overrides['onboardingApiRegisterKey'] ?? base.onboardingApiRegisterKey;
  @override
  String get onboardingApiRecommendJoin => overrides['onboardingApiRecommendJoin'] ?? base.onboardingApiRecommendJoin;
  @override
  String get onboardingChannelRecommendLead => overrides['onboardingChannelRecommendLead'] ?? base.onboardingChannelRecommendLead;
  @override
  String get onboardingChannelRecommendQq => overrides['onboardingChannelRecommendQq'] ?? base.onboardingChannelRecommendQq;
  @override
  String get onboardingChannelRecommendTail => overrides['onboardingChannelRecommendTail'] ?? base.onboardingChannelRecommendTail;
  @override
  String get onboardingQqTileDetail => overrides['onboardingQqTileDetail'] ?? base.onboardingQqTileDetail;
  @override
  String get onboardingQqCredentialsTitle => overrides['onboardingQqCredentialsTitle'] ?? base.onboardingQqCredentialsTitle;
  @override
  String get onboardingQqAppIdLabel => overrides['onboardingQqAppIdLabel'] ?? base.onboardingQqAppIdLabel;
  @override
  String get onboardingQqAppIdHint => overrides['onboardingQqAppIdHint'] ?? base.onboardingQqAppIdHint;
  @override
  String get onboardingQqAppSecretLabel => overrides['onboardingQqAppSecretLabel'] ?? base.onboardingQqAppSecretLabel;
  @override
  String get onboardingQqAppSecretHint => overrides['onboardingQqAppSecretHint'] ?? base.onboardingQqAppSecretHint;
  @override
  String get onboardingQqCredentialsNote => overrides['onboardingQqCredentialsNote'] ?? base.onboardingQqCredentialsNote;
  @override
  String get onboardingQqEntryScan => overrides['onboardingQqEntryScan'] ?? base.onboardingQqEntryScan;
  @override
  String get onboardingQqEntryManual => overrides['onboardingQqEntryManual'] ?? base.onboardingQqEntryManual;
  @override
  String get onboardingQqBindIntro => overrides['onboardingQqBindIntro'] ?? base.onboardingQqBindIntro;
  @override
  String get onboardingQqBindStart => overrides['onboardingQqBindStart'] ?? base.onboardingQqBindStart;
  @override
  String get onboardingQqBindStarting => overrides['onboardingQqBindStarting'] ?? base.onboardingQqBindStarting;
  @override
  String get onboardingQqBindWaitScan => overrides['onboardingQqBindWaitScan'] ?? base.onboardingQqBindWaitScan;
  @override
  String get onboardingQqBindWaiting => overrides['onboardingQqBindWaiting'] ?? base.onboardingQqBindWaiting;
  @override
  String get onboardingQqBindSuccess => overrides['onboardingQqBindSuccess'] ?? base.onboardingQqBindSuccess;
  @override
  String get onboardingQqBindSavedNote => overrides['onboardingQqBindSavedNote'] ?? base.onboardingQqBindSavedNote;
  @override
  String get onboardingQqBindRegenerate => overrides['onboardingQqBindRegenerate'] ?? base.onboardingQqBindRegenerate;
  @override
  String get onboardingQqBindTestConnection =>
      overrides['onboardingQqBindTestConnection'] ?? base.onboardingQqBindTestConnection;
  @override
  String get onboardingQqBindTokenTesting =>
      overrides['onboardingQqBindTokenTesting'] ?? base.onboardingQqBindTokenTesting;
  @override
  String get onboardingOnebotDetail => overrides['onboardingOnebotDetail'] ?? base.onboardingOnebotDetail;
  @override
  String get onboardingStepNameHint => overrides['onboardingStepNameHint'] ?? base.onboardingStepNameHint;
  @override
  String get onboardingKeywordsHint => overrides['onboardingKeywordsHint'] ?? base.onboardingKeywordsHint;
  @override
  String get onboardingPersonaHint => overrides['onboardingPersonaHint'] ?? base.onboardingPersonaHint;
  @override
  String get onboardingTrustNoteSame => overrides['onboardingTrustNoteSame'] ?? base.onboardingTrustNoteSame;
  @override
  String get onboardingTrustNoteChanged => overrides['onboardingTrustNoteChanged'] ?? base.onboardingTrustNoteChanged;
  @override
  String get onboardingStepDepsTitle => overrides['onboardingStepDepsTitle'] ?? base.onboardingStepDepsTitle;
  @override
  String get onboardingStepDepsNote => overrides['onboardingStepDepsNote'] ?? base.onboardingStepDepsNote;
  @override
  String get onboardingDepsInstallLabel => overrides['onboardingDepsInstallLabel'] ?? base.onboardingDepsInstallLabel;
  @override
  String get onboardingDepsAllReady => overrides['onboardingDepsAllReady'] ?? base.onboardingDepsAllReady;
  @override
  String get onboardingDepsStatusReady => overrides['onboardingDepsStatusReady'] ?? base.onboardingDepsStatusReady;
  @override
  String get onboardingDepsStatusMissing => overrides['onboardingDepsStatusMissing'] ?? base.onboardingDepsStatusMissing;
  @override
  String get onboardingDepsItemRunning => overrides['onboardingDepsItemRunning'] ?? base.onboardingDepsItemRunning;
  @override
  String get onboardingDepsItemOk => overrides['onboardingDepsItemOk'] ?? base.onboardingDepsItemOk;
  @override
  String get onboardingDepsRetry => overrides['onboardingDepsRetry'] ?? base.onboardingDepsRetry;
  @override
  String get onboardingDepsUnavailable => overrides['onboardingDepsUnavailable'] ?? base.onboardingDepsUnavailable;
  @override
  String get onboardingRestartTitle => overrides['onboardingRestartTitle'] ?? base.onboardingRestartTitle;
  @override
  String get onboardingRestartBody => overrides['onboardingRestartBody'] ?? base.onboardingRestartBody;
  @override
  String get onboardingRestartNow => overrides['onboardingRestartNow'] ?? base.onboardingRestartNow;
  @override
  String get onboardingRestartLater => overrides['onboardingRestartLater'] ?? base.onboardingRestartLater;
  @override
  String get chatTitle => overrides['chatTitle'] ?? base.chatTitle;
  @override
  String get chatSubtitle => overrides['chatSubtitle'] ?? base.chatSubtitle;
  @override
  String get composerHint => overrides['composerHint'] ?? base.composerHint;
  @override
  String get jumpToLatest => overrides['jumpToLatest'] ?? base.jumpToLatest;
  @override
  String get jumpToLatestNew => overrides['jumpToLatestNew'] ?? base.jumpToLatestNew;
  @override
  String get earlierFailed => overrides['earlierFailed'] ?? base.earlierFailed;
  @override
  String get noEarlier => overrides['noEarlier'] ?? base.noEarlier;
  @override
  String get historyErrorTitle => overrides['historyErrorTitle'] ?? base.historyErrorTitle;
  @override
  String get historyErrorMessage => overrides['historyErrorMessage'] ?? base.historyErrorMessage;
  @override
  String get chatEmptyTitle => overrides['chatEmptyTitle'] ?? base.chatEmptyTitle;
  @override
  String get chatEmptyMessage => overrides['chatEmptyMessage'] ?? base.chatEmptyMessage;
  @override
  String get chatEmptyAction => overrides['chatEmptyAction'] ?? base.chatEmptyAction;
  @override
  String get chatEmptyHint => overrides['chatEmptyHint'] ?? base.chatEmptyHint;
  @override
  String get tagFrameworkNotice => overrides['tagFrameworkNotice'] ?? base.tagFrameworkNotice;
  @override
  String get tagFrameworkReminder => overrides['tagFrameworkReminder'] ?? base.tagFrameworkReminder;
  @override
  String get tagInjection => overrides['tagInjection'] ?? base.tagInjection;
  @override
  String get tagContextBoundary => overrides['tagContextBoundary'] ?? base.tagContextBoundary;
  @override
  String get injectionCardTitle => overrides['injectionCardTitle'] ?? base.injectionCardTitle;
  @override
  String get unnamedSender => overrides['unnamedSender'] ?? base.unnamedSender;
  @override
  String get dash => overrides['dash'] ?? base.dash;
  @override
  String get directMessage => overrides['directMessage'] ?? base.directMessage;
  @override
  String get groupMention => overrides['groupMention'] ?? base.groupMention;
  @override
  String get groupMessage => overrides['groupMessage'] ?? base.groupMessage;
  @override
  String get chatTypeDirect => overrides['chatTypeDirect'] ?? base.chatTypeDirect;
  @override
  String get chatTypeGroup => overrides['chatTypeGroup'] ?? base.chatTypeGroup;
  @override
  String get qqOfficialBot => overrides['qqOfficialBot'] ?? base.qqOfficialBot;
  @override
  String get externalChannel => overrides['externalChannel'] ?? base.externalChannel;
  @override
  String get qqMessage => overrides['qqMessage'] ?? base.qqMessage;
  @override
  String get oneBotMessage => overrides['oneBotMessage'] ?? base.oneBotMessage;
  @override
  String get externalMessage => overrides['externalMessage'] ?? base.externalMessage;
  @override
  String get byModel => overrides['byModel'] ?? base.byModel;
  @override
  String get byRule => overrides['byRule'] ?? base.byRule;
  @override
  String get manualWake => overrides['manualWake'] ?? base.manualWake;
  @override
  String get intentWake => overrides['intentWake'] ?? base.intentWake;
  @override
  String get schedulerFire => overrides['schedulerFire'] ?? base.schedulerFire;
  @override
  String get backgroundProgress => overrides['backgroundProgress'] ?? base.backgroundProgress;
  @override
  String get eventDream => overrides['eventDream'] ?? base.eventDream;
  @override
  String get eventMcpDeclChanged => overrides['eventMcpDeclChanged'] ?? base.eventMcpDeclChanged;
  @override
  String get contextClearedHere => overrides['contextClearedHere'] ?? base.contextClearedHere;
  @override
  String get contextCompactedHere => overrides['contextCompactedHere'] ?? base.contextCompactedHere;
  @override
  String get contextClearedHereDetail => overrides['contextClearedHereDetail'] ?? base.contextClearedHereDetail;
  @override
  String get contextCompactedHereDetail => overrides['contextCompactedHereDetail'] ?? base.contextCompactedHereDetail;
  @override
  String get humanReplyRecorded => overrides['humanReplyRecorded'] ?? base.humanReplyRecorded;
  @override
  String get markedOk => overrides['markedOk'] ?? base.markedOk;
  @override
  String get markedFailed => overrides['markedFailed'] ?? base.markedFailed;
  @override
  String get toolRunning => overrides['toolRunning'] ?? base.toolRunning;
  @override
  String get toolExecuting => overrides['toolExecuting'] ?? base.toolExecuting;
  @override
  String get toolDone => overrides['toolDone'] ?? base.toolDone;
  @override
  String get toolError => overrides['toolError'] ?? base.toolError;
  @override
  String get toolTimeout => overrides['toolTimeout'] ?? base.toolTimeout;
  @override
  String get toolDenied => overrides['toolDenied'] ?? base.toolDenied;
  @override
  String get toolUnknown => overrides['toolUnknown'] ?? base.toolUnknown;
  @override
  String get toolNotDispatched => overrides['toolNotDispatched'] ?? base.toolNotDispatched;
  @override
  String get toolOverStepCap => overrides['toolOverStepCap'] ?? base.toolOverStepCap;
  @override
  String get thinkingLabel => overrides['thinkingLabel'] ?? base.thinkingLabel;
  @override
  String get thinkingGap => overrides['thinkingGap'] ?? base.thinkingGap;
  @override
  String get toastContextCleared => overrides['toastContextCleared'] ?? base.toastContextCleared;
  @override
  String get toastDream => overrides['toastDream'] ?? base.toastDream;
  @override
  String get toastDuplicateSend => overrides['toastDuplicateSend'] ?? base.toastDuplicateSend;
  @override
  String get settingsTitle => overrides['settingsTitle'] ?? base.settingsTitle;
  @override
  String get settingsSubtitle => overrides['settingsSubtitle'] ?? base.settingsSubtitle;
  @override
  String get settingsSectionUi => overrides['settingsSectionUi'] ?? base.settingsSectionUi;
  @override
  String get settingsUiNote => overrides['settingsUiNote'] ?? base.settingsUiNote;
  @override
  String get instantApply => overrides['instantApply'] ?? base.instantApply;
  @override
  String get settingsThemeMode => overrides['settingsThemeMode'] ?? base.settingsThemeMode;
  @override
  String get themeLight => overrides['themeLight'] ?? base.themeLight;
  @override
  String get themeDark => overrides['themeDark'] ?? base.themeDark;
  @override
  String get settingsCurrentTheme => overrides['settingsCurrentTheme'] ?? base.settingsCurrentTheme;
  @override
  String get settingsThemeNote => overrides['settingsThemeNote'] ?? base.settingsThemeNote;
  @override
  String get settingsCloseToTray => overrides['settingsCloseToTray'] ?? base.settingsCloseToTray;
  @override
  String get settingsCloseToTrayNote => overrides['settingsCloseToTrayNote'] ?? base.settingsCloseToTrayNote;
  @override
  String get settingsLanguage => overrides['settingsLanguage'] ?? base.settingsLanguage;
  @override
  String get languageFollowSystem => overrides['languageFollowSystem'] ?? base.languageFollowSystem;
  @override
  String get settingsLanguageNote => overrides['settingsLanguageNote'] ?? base.settingsLanguageNote;
  @override
  String get settingsStringsOverride => overrides['settingsStringsOverride'] ?? base.settingsStringsOverride;
  @override
  String get settingsStringsOverrideNote => overrides['settingsStringsOverrideNote'] ?? base.settingsStringsOverrideNote;
  @override
  String get stringsOverridePathLabel => overrides['stringsOverridePathLabel'] ?? base.stringsOverridePathLabel;
  @override
  String get stringsOverrideOpen => overrides['stringsOverrideOpen'] ?? base.stringsOverrideOpen;
  @override
  String get stringsOverrideReload => overrides['stringsOverrideReload'] ?? base.stringsOverrideReload;
  @override
  String get stringsOverrideExport => overrides['stringsOverrideExport'] ?? base.stringsOverrideExport;
  @override
  String get stringsOverrideNone => overrides['stringsOverrideNone'] ?? base.stringsOverrideNone;
  @override
  String get stringsOverrideBadRoot => overrides['stringsOverrideBadRoot'] ?? base.stringsOverrideBadRoot;
  @override
  String get settingsAnchorCaption => overrides['settingsAnchorCaption'] ?? base.settingsAnchorCaption;
  @override
  String get settingsNavModel => overrides['settingsNavModel'] ?? base.settingsNavModel;
  @override
  String get settingsNavUi => overrides['settingsNavUi'] ?? base.settingsNavUi;
  @override
  String get settingsNavSpeak => overrides['settingsNavSpeak'] ?? base.settingsNavSpeak;
  @override
  String get settingsNavDeps => overrides['settingsNavDeps'] ?? base.settingsNavDeps;
  @override
  String get settingsNavProtocol => overrides['settingsNavProtocol'] ?? base.settingsNavProtocol;
  @override
  String get settingsNavWebhook => overrides['settingsNavWebhook'] ?? base.settingsNavWebhook;
  @override
  String get settingsNavMemory => overrides['settingsNavMemory'] ?? base.settingsNavMemory;
  @override
  String get settingsNavTrust => overrides['settingsNavTrust'] ?? base.settingsNavTrust;
  @override
  String get settingsNavSystem => overrides['settingsNavSystem'] ?? base.settingsNavSystem;
  @override
  String get settingsNavAccount => overrides['settingsNavAccount'] ?? base.settingsNavAccount;
  @override
  String get settingsNavAbout => overrides['settingsNavAbout'] ?? base.settingsNavAbout;
  @override
  String get overviewSubtitle => overrides['overviewSubtitle'] ?? base.overviewSubtitle;
  @override
  String get overviewSectionAdvice => overrides['overviewSectionAdvice'] ?? base.overviewSectionAdvice;
  @override
  String get overviewSectionRecent => overrides['overviewSectionRecent'] ?? base.overviewSectionRecent;
  @override
  String get overviewPersonaSeedAdvice => overrides['overviewPersonaSeedAdvice'] ?? base.overviewPersonaSeedAdvice;
  @override
  String get overviewNoPendingCalls => overrides['overviewNoPendingCalls'] ?? base.overviewNoPendingCalls;
  @override
  String get overviewTimerCancelTitle => overrides['overviewTimerCancelTitle'] ?? base.overviewTimerCancelTitle;
  @override
  String get overviewTimerCancel => overrides['overviewTimerCancel'] ?? base.overviewTimerCancel;
  @override
  String get overviewDeadDiscardTitle => overrides['overviewDeadDiscardTitle'] ?? base.overviewDeadDiscardTitle;
  @override
  String get overviewDeadDiscardConfirm => overrides['overviewDeadDiscardConfirm'] ?? base.overviewDeadDiscardConfirm;
  @override
  String get overviewDeadRequeue => overrides['overviewDeadRequeue'] ?? base.overviewDeadRequeue;
  @override
  String get overviewDeadDiscard => overrides['overviewDeadDiscard'] ?? base.overviewDeadDiscard;
  @override
  String get overviewLoadFailedTitle => overrides['overviewLoadFailedTitle'] ?? base.overviewLoadFailedTitle;
  @override
  String get overviewMarkSucceeded => overrides['overviewMarkSucceeded'] ?? base.overviewMarkSucceeded;
  @override
  String get overviewMarkFailed => overrides['overviewMarkFailed'] ?? base.overviewMarkFailed;
  @override
  String get overviewTodayUsage => overrides['overviewTodayUsage'] ?? base.overviewTodayUsage;
  @override
  String get overviewCacheHitRate => overrides['overviewCacheHitRate'] ?? base.overviewCacheHitRate;
  @override
  String get overviewPending => overrides['overviewPending'] ?? base.overviewPending;
  @override
  String get overviewFailStreak => overrides['overviewFailStreak'] ?? base.overviewFailStreak;
  @override
  String get overviewActFallback => overrides['overviewActFallback'] ?? base.overviewActFallback;
  @override
  String get overviewDeadLettersUnread => overrides['overviewDeadLettersUnread'] ?? base.overviewDeadLettersUnread;
  @override
  String get overviewUnknownSession => overrides['overviewUnknownSession'] ?? base.overviewUnknownSession;
  @override
  String get overviewChatTypeDirect => overrides['overviewChatTypeDirect'] ?? base.overviewChatTypeDirect;
  @override
  String get overviewChatTypeGroupAt => overrides['overviewChatTypeGroupAt'] ?? base.overviewChatTypeGroupAt;
  @override
  String get overviewChatTypeGroup => overrides['overviewChatTypeGroup'] ?? base.overviewChatTypeGroup;
  @override
  String get overviewChatTypeGuild => overrides['overviewChatTypeGuild'] ?? base.overviewChatTypeGuild;
  @override
  String get overviewChatTypeUnknown => overrides['overviewChatTypeUnknown'] ?? base.overviewChatTypeUnknown;
  @override
  String get overviewExternalSessions => overrides['overviewExternalSessions'] ?? base.overviewExternalSessions;
  @override
  String get overviewExternalSessionsNote => overrides['overviewExternalSessionsNote'] ?? base.overviewExternalSessionsNote;
  @override
  String get overviewExternalSessionsLoading => overrides['overviewExternalSessionsLoading'] ?? base.overviewExternalSessionsLoading;
  @override
  String get overviewExternalSessionsErrorHint => overrides['overviewExternalSessionsErrorHint'] ?? base.overviewExternalSessionsErrorHint;
  @override
  String get overviewNoAccumulatedMessages => overrides['overviewNoAccumulatedMessages'] ?? base.overviewNoAccumulatedMessages;
  @override
  String get overviewLevelCritical => overrides['overviewLevelCritical'] ?? base.overviewLevelCritical;
  @override
  String get overviewLevelWarn => overrides['overviewLevelWarn'] ?? base.overviewLevelWarn;
  @override
  String get overviewLevelInfo => overrides['overviewLevelInfo'] ?? base.overviewLevelInfo;
  @override
  String get overviewLevelUnknown => overrides['overviewLevelUnknown'] ?? base.overviewLevelUnknown;
  @override
  String get overviewFrameworkNote => overrides['overviewFrameworkNote'] ?? base.overviewFrameworkNote;
  @override
  String get overviewFrameworkNotesLoading => overrides['overviewFrameworkNotesLoading'] ?? base.overviewFrameworkNotesLoading;
  @override
  String get overviewFrameworkNotesErrorHint => overrides['overviewFrameworkNotesErrorHint'] ?? base.overviewFrameworkNotesErrorHint;
  @override
  String get overviewNoFrameworkNotes => overrides['overviewNoFrameworkNotes'] ?? base.overviewNoFrameworkNotes;
  @override
  String get overviewTimers => overrides['overviewTimers'] ?? base.overviewTimers;
  @override
  String get overviewTimersNote => overrides['overviewTimersNote'] ?? base.overviewTimersNote;
  @override
  String get overviewNoTimers => overrides['overviewNoTimers'] ?? base.overviewNoTimers;
  @override
  String get overviewTimersErrorHint => overrides['overviewTimersErrorHint'] ?? base.overviewTimersErrorHint;
  @override
  String get overviewTimerUnknownTime => overrides['overviewTimerUnknownTime'] ?? base.overviewTimerUnknownTime;
  @override
  String get overviewTimerRecurring => overrides['overviewTimerRecurring'] ?? base.overviewTimerRecurring;
  @override
  String get overviewRecentEmpty => overrides['overviewRecentEmpty'] ?? base.overviewRecentEmpty;
  @override
  String get overviewRecentEmptyAction => overrides['overviewRecentEmptyAction'] ?? base.overviewRecentEmptyAction;
  @override
  String get overviewRecentEmptyHint => overrides['overviewRecentEmptyHint'] ?? base.overviewRecentEmptyHint;
  @override
  String get overviewJudgedByRule => overrides['overviewJudgedByRule'] ?? base.overviewJudgedByRule;
  @override
  String get overviewJudgedByModel => overrides['overviewJudgedByModel'] ?? base.overviewJudgedByModel;
  @override
  String get overviewSessionsNotList => overrides['overviewSessionsNotList'] ?? base.overviewSessionsNotList;
  @override
  String get overviewNotesNotList => overrides['overviewNotesNotList'] ?? base.overviewNotesNotList;
  @override
  String get overviewContextTitle => overrides['overviewContextTitle'] ?? base.overviewContextTitle;
  @override
  String get overviewContextLoading => overrides['overviewContextLoading'] ?? base.overviewContextLoading;
  @override
  String get overviewContextErrorHint =>
      overrides['overviewContextErrorHint'] ?? base.overviewContextErrorHint;
  @override
  String get overviewContextEmpty => overrides['overviewContextEmpty'] ?? base.overviewContextEmpty;
  @override
  String get overviewContextNotObject =>
      overrides['overviewContextNotObject'] ?? base.overviewContextNotObject;
  @override
  String get overviewContextKeepOn => overrides['overviewContextKeepOn'] ?? base.overviewContextKeepOn;
  @override
  String get overviewContextKeepOff => overrides['overviewContextKeepOff'] ?? base.overviewContextKeepOff;
  @override
  String get settingsLaneHeavyLabel => overrides['settingsLaneHeavyLabel'] ?? base.settingsLaneHeavyLabel;
  @override
  String get settingsLaneLightLabel => overrides['settingsLaneLightLabel'] ?? base.settingsLaneLightLabel;
  @override
  String get settingsLaneHeavyNote => overrides['settingsLaneHeavyNote'] ?? base.settingsLaneHeavyNote;
  @override
  String get settingsLaneLightNote => overrides['settingsLaneLightNote'] ?? base.settingsLaneLightNote;
  @override
  String get settingsDepSourceManaged => overrides['settingsDepSourceManaged'] ?? base.settingsDepSourceManaged;
  @override
  String get settingsDepSourceSystemPath => overrides['settingsDepSourceSystemPath'] ?? base.settingsDepSourceSystemPath;
  @override
  String get settingsDepVersionUnknown => overrides['settingsDepVersionUnknown'] ?? base.settingsDepVersionUnknown;
  @override
  String get settingsDepPathUnknown => overrides['settingsDepPathUnknown'] ?? base.settingsDepPathUnknown;
  @override
  String get settingsSysHostEmptyError => overrides['settingsSysHostEmptyError'] ?? base.settingsSysHostEmptyError;
  @override
  String get settingsSysHostLabel => overrides['settingsSysHostLabel'] ?? base.settingsSysHostLabel;
  @override
  String get settingsSysHostNote => overrides['settingsSysHostNote'] ?? base.settingsSysHostNote;
  @override
  String get settingsSysPortLabel => overrides['settingsSysPortLabel'] ?? base.settingsSysPortLabel;
  @override
  String get settingsSysTimezoneLabel => overrides['settingsSysTimezoneLabel'] ?? base.settingsSysTimezoneLabel;
  @override
  String get settingsSysTimezoneNote => overrides['settingsSysTimezoneNote'] ?? base.settingsSysTimezoneNote;
  @override
  String get settingsSysStepToolsLabel => overrides['settingsSysStepToolsLabel'] ?? base.settingsSysStepToolsLabel;
  @override
  String get settingsSysStepToolsNote => overrides['settingsSysStepToolsNote'] ?? base.settingsSysStepToolsNote;
  @override
  String get settingsSysTurnStepsLabel => overrides['settingsSysTurnStepsLabel'] ?? base.settingsSysTurnStepsLabel;
  @override
  String get settingsSysTurnStepsNote => overrides['settingsSysTurnStepsNote'] ?? base.settingsSysTurnStepsNote;
  @override
  String get settingsSysTaskTokensLabel => overrides['settingsSysTaskTokensLabel'] ?? base.settingsSysTaskTokensLabel;
  @override
  String get settingsSysTaskTokensNote => overrides['settingsSysTaskTokensNote'] ?? base.settingsSysTaskTokensNote;
  @override
  String get settingsSysDailyTokensLabel => overrides['settingsSysDailyTokensLabel'] ?? base.settingsSysDailyTokensLabel;
  @override
  String get settingsSysDailyTokensNote => overrides['settingsSysDailyTokensNote'] ?? base.settingsSysDailyTokensNote;
  @override
  String get settingsSysSoftRatioLabel => overrides['settingsSysSoftRatioLabel'] ?? base.settingsSysSoftRatioLabel;
  @override
  String get settingsSysSoftRatioNote => overrides['settingsSysSoftRatioNote'] ?? base.settingsSysSoftRatioNote;
  @override
  String get settingsSysFailStreakLabel => overrides['settingsSysFailStreakLabel'] ?? base.settingsSysFailStreakLabel;
  @override
  String get settingsSysFailStreakNote => overrides['settingsSysFailStreakNote'] ?? base.settingsSysFailStreakNote;
  @override
  String get settingsSysHeartbeatLabel => overrides['settingsSysHeartbeatLabel'] ?? base.settingsSysHeartbeatLabel;
  @override
  String get settingsSysHeartbeatNote => overrides['settingsSysHeartbeatNote'] ?? base.settingsSysHeartbeatNote;
  @override
  String get settingsSysCompactionLabel => overrides['settingsSysCompactionLabel'] ?? base.settingsSysCompactionLabel;
  @override
  String get settingsSysCompactionNote => overrides['settingsSysCompactionNote'] ?? base.settingsSysCompactionNote;
  @override
  String get settingsTrustConsequenceWorkspaceUnknown => overrides['settingsTrustConsequenceWorkspaceUnknown'] ?? base.settingsTrustConsequenceWorkspaceUnknown;
  @override
  String get settingsTrustConsequenceFull => overrides['settingsTrustConsequenceFull'] ?? base.settingsTrustConsequenceFull;
  @override
  String get settingsTrustLabelWorkspace => overrides['settingsTrustLabelWorkspace'] ?? base.settingsTrustLabelWorkspace;
  @override
  String get settingsTrustLabelFull => overrides['settingsTrustLabelFull'] ?? base.settingsTrustLabelFull;
  @override
  String get settingsWebhookStateNotObject => overrides['settingsWebhookStateNotObject'] ?? base.settingsWebhookStateNotObject;
  @override
  String get settingsProtocolStateNotObject => overrides['settingsProtocolStateNotObject'] ?? base.settingsProtocolStateNotObject;
  @override
  String get settingsDepsReadFailed => overrides['settingsDepsReadFailed'] ?? base.settingsDepsReadFailed;
  @override
  String get settingsKeysReadFailed => overrides['settingsKeysReadFailed'] ?? base.settingsKeysReadFailed;
  @override
  String get settingsProjectionReadFailed => overrides['settingsProjectionReadFailed'] ?? base.settingsProjectionReadFailed;
  @override
  String get settingsModelNameRequired => overrides['settingsModelNameRequired'] ?? base.settingsModelNameRequired;
  @override
  String get settingsBaseUrlRequired => overrides['settingsBaseUrlRequired'] ?? base.settingsBaseUrlRequired;
  @override
  String get settingsNoChanges => overrides['settingsNoChanges'] ?? base.settingsNoChanges;
  @override
  String get settingsWrittenModelSettings => overrides['settingsWrittenModelSettings'] ?? base.settingsWrittenModelSettings;
  @override
  String get settingsWrittenKey => overrides['settingsWrittenKey'] ?? base.settingsWrittenKey;
  @override
  String get settingsRestartSuffix => overrides['settingsRestartSuffix'] ?? base.settingsRestartSuffix;
  @override
  String get settingsClearKeyBody => overrides['settingsClearKeyBody'] ?? base.settingsClearKeyBody;
  @override
  String get settingsClear => overrides['settingsClear'] ?? base.settingsClear;
  @override
  String get settingsKeyCleared => overrides['settingsKeyCleared'] ?? base.settingsKeyCleared;
  @override
  String get settingsConfigErrorHint => overrides['settingsConfigErrorHint'] ?? base.settingsConfigErrorHint;
  @override
  String get settingsConfigUnavailable => overrides['settingsConfigUnavailable'] ?? base.settingsConfigUnavailable;
  @override
  String get settingsConfigUnavailableHint => overrides['settingsConfigUnavailableHint'] ?? base.settingsConfigUnavailableHint;
  @override
  String get settingsConfigFallbackNote => overrides['settingsConfigFallbackNote'] ?? base.settingsConfigFallbackNote;
  @override
  String get settingsModelRestartNote => overrides['settingsModelRestartNote'] ?? base.settingsModelRestartNote;
  @override
  // 带参句子不进覆盖层（语序由实现决定，见本文件头）：原样委托给 base
  String settingsModelRunningNow(String lane, String model, String baseUrl) =>
      base.settingsModelRunningNow(lane, model, baseUrl);
  @override
  String get settingsKeysNote => overrides['settingsKeysNote'] ?? base.settingsKeysNote;
  @override
  String get settingsKeyConfiguredHint => overrides['settingsKeyConfiguredHint'] ?? base.settingsKeyConfiguredHint;
  @override
  String get settingsKeySampleHint => overrides['settingsKeySampleHint'] ?? base.settingsKeySampleHint;
  @override
  String get settingsModelName => overrides['settingsModelName'] ?? base.settingsModelName;
  @override
  String get settingsBaseUrlNote => overrides['settingsBaseUrlNote'] ?? base.settingsBaseUrlNote;
  @override
  String get settingsModelProtocol => overrides['settingsModelProtocol'] ?? base.settingsModelProtocol;
  @override
  String get settingsModelProtocolAuto => overrides['settingsModelProtocolAuto'] ?? base.settingsModelProtocolAuto;
  @override
  String get settingsModelProtocolChat => overrides['settingsModelProtocolChat'] ?? base.settingsModelProtocolChat;
  @override
  String get settingsModelProtocolResponses => overrides['settingsModelProtocolResponses'] ?? base.settingsModelProtocolResponses;
  @override
  String get settingsClearKey => overrides['settingsClearKey'] ?? base.settingsClearKey;
  @override
  String get settingsReading => overrides['settingsReading'] ?? base.settingsReading;
  @override
  String get settingsStateReadFailed => overrides['settingsStateReadFailed'] ?? base.settingsStateReadFailed;
  @override
  String get settingsNotConfigured => overrides['settingsNotConfigured'] ?? base.settingsNotConfigured;
  @override
  String get settingsSpeakNote => overrides['settingsSpeakNote'] ?? base.settingsSpeakNote;
  @override
  String get settingsSpeakTyping => overrides['settingsSpeakTyping'] ?? base.settingsSpeakTyping;
  @override
  String get settingsSpeakTypingNote => overrides['settingsSpeakTypingNote'] ?? base.settingsSpeakTypingNote;
  @override
  String get settingsSpeakSpeed => overrides['settingsSpeakSpeed'] ?? base.settingsSpeakSpeed;
  @override
  String get settingsSpeakSpeedUnit => overrides['settingsSpeakSpeedUnit'] ?? base.settingsSpeakSpeedUnit;
  @override
  String get settingsSpeakSpeedNote => overrides['settingsSpeakSpeedNote'] ?? base.settingsSpeakSpeedNote;
  @override
  String get settingsCurrentlyActive => overrides['settingsCurrentlyActive'] ?? base.settingsCurrentlyActive;
  @override
  String get settingsSpeakTypingEnabled => overrides['settingsSpeakTypingEnabled'] ?? base.settingsSpeakTypingEnabled;
  @override
  String get settingsSpeakTypingDisabled => overrides['settingsSpeakTypingDisabled'] ?? base.settingsSpeakTypingDisabled;
  @override
  String get settingsSpeakSpeedRange => overrides['settingsSpeakSpeedRange'] ?? base.settingsSpeakSpeedRange;
  @override
  String get settingsSavedRestartNote => overrides['settingsSavedRestartNote'] ?? base.settingsSavedRestartNote;
  @override
  String get settingsSavedLive => overrides['settingsSavedLive'] ?? base.settingsSavedLive;
  @override
  String get settingsSavedRestart => overrides['settingsSavedRestart'] ?? base.settingsSavedRestart;
  @override
  String get settingsDepsAllReady => overrides['settingsDepsAllReady'] ?? base.settingsDepsAllReady;
  @override
  String get settingsDepsNote => overrides['settingsDepsNote'] ?? base.settingsDepsNote;
  @override
  String get settingsDepsProbing => overrides['settingsDepsProbing'] ?? base.settingsDepsProbing;
  @override
  String get settingsDepsInstallLocation => overrides['settingsDepsInstallLocation'] ?? base.settingsDepsInstallLocation;
  @override
  String get settingsDepReadyManaged => overrides['settingsDepReadyManaged'] ?? base.settingsDepReadyManaged;
  @override
  String get settingsDepReadySystem => overrides['settingsDepReadySystem'] ?? base.settingsDepReadySystem;
  @override
  String get settingsDepMismatch => overrides['settingsDepMismatch'] ?? base.settingsDepMismatch;
  @override
  String get settingsDepMissing => overrides['settingsDepMissing'] ?? base.settingsDepMissing;
  @override
  String get settingsDepNoAction => overrides['settingsDepNoAction'] ?? base.settingsDepNoAction;
  @override
  String get settingsDepInstalling => overrides['settingsDepInstalling'] ?? base.settingsDepInstalling;
  @override
  String get settingsInstall => overrides['settingsInstall'] ?? base.settingsInstall;
  @override
  String get settingsDownloadPage => overrides['settingsDownloadPage'] ?? base.settingsDownloadPage;
  @override
  String get settingsOpenDownloadPage => overrides['settingsOpenDownloadPage'] ?? base.settingsOpenDownloadPage;
  @override
  String get settingsProtocolThirdPartyTitle =>
      overrides['settingsProtocolThirdPartyTitle'] ?? base.settingsProtocolThirdPartyTitle;
  @override
  String get settingsProtocolThirdPartyNote =>
      overrides['settingsProtocolThirdPartyNote'] ?? base.settingsProtocolThirdPartyNote;
  @override
  String get settingsProtocolOfficialProject =>
      overrides['settingsProtocolOfficialProject'] ?? base.settingsProtocolOfficialProject;
  @override
  String get settingsProtocolOfficialSite =>
      overrides['settingsProtocolOfficialSite'] ?? base.settingsProtocolOfficialSite;
  @override
  String get settingsProtocolLicenseRow =>
      overrides['settingsProtocolLicenseRow'] ?? base.settingsProtocolLicenseRow;
  @override
  String get settingsDownloadAndInstall => overrides['settingsDownloadAndInstall'] ?? base.settingsDownloadAndInstall;
  @override
  String get settingsStepDownloadFailed => overrides['settingsStepDownloadFailed'] ?? base.settingsStepDownloadFailed;
  @override
  String get settingsStepExtractFailed => overrides['settingsStepExtractFailed'] ?? base.settingsStepExtractFailed;
  @override
  String get settingsStepVerifyFailed => overrides['settingsStepVerifyFailed'] ?? base.settingsStepVerifyFailed;
  @override
  String get settingsStepInstallFailed => overrides['settingsStepInstallFailed'] ?? base.settingsStepInstallFailed;
  @override
  String get settingsUnknown => overrides['settingsUnknown'] ?? base.settingsUnknown;
  @override
  String get settingsRestartRequired => overrides['settingsRestartRequired'] ?? base.settingsRestartRequired;
  @override
  String get settingsProtocolTitle => overrides['settingsProtocolTitle'] ?? base.settingsProtocolTitle;
  @override
  String get settingsProtocolNote => overrides['settingsProtocolNote'] ?? base.settingsProtocolNote;
  @override
  String get settingsProtocolErrorHint => overrides['settingsProtocolErrorHint'] ?? base.settingsProtocolErrorHint;
  @override
  String get settingsProtocolLoading => overrides['settingsProtocolLoading'] ?? base.settingsProtocolLoading;
  @override
  String get settingsProtocolEmpty => overrides['settingsProtocolEmpty'] ?? base.settingsProtocolEmpty;
  @override
  String get settingsProtocolEmptyHint => overrides['settingsProtocolEmptyHint'] ?? base.settingsProtocolEmptyHint;
  @override
  String get settingsProtocolEnabled => overrides['settingsProtocolEnabled'] ?? base.settingsProtocolEnabled;
  @override
  String get settingsProtocolEnabledNote => overrides['settingsProtocolEnabledNote'] ?? base.settingsProtocolEnabledNote;
  @override
  String get settingsInstallDir => overrides['settingsInstallDir'] ?? base.settingsInstallDir;
  @override
  String get settingsInstallDirHint => overrides['settingsInstallDirHint'] ?? base.settingsInstallDirHint;
  @override
  String get settingsSaveDir => overrides['settingsSaveDir'] ?? base.settingsSaveDir;
  @override
  String get settingsInstallDirNote => overrides['settingsInstallDirNote'] ?? base.settingsInstallDirNote;
  @override
  String get settingsOneClickInstall => overrides['settingsOneClickInstall'] ?? base.settingsOneClickInstall;
  @override
  String get settingsOneClickInstallNote => overrides['settingsOneClickInstallNote'] ?? base.settingsOneClickInstallNote;
  @override
  String get settingsOneClickPrerequisite => overrides['settingsOneClickPrerequisite'] ?? base.settingsOneClickPrerequisite;
  @override
  String get settingsInstallRunningNote => overrides['settingsInstallRunningNote'] ?? base.settingsInstallRunningNote;
  @override
  String get settingsInstallLogEmpty => overrides['settingsInstallLogEmpty'] ?? base.settingsInstallLogEmpty;
  @override
  String get settingsInstallLog => overrides['settingsInstallLog'] ?? base.settingsInstallLog;
  @override
  String get settingsInstalledNextTitle => overrides['settingsInstalledNextTitle'] ?? base.settingsInstalledNextTitle;
  @override
  String get settingsInstalledNextBody => overrides['settingsInstalledNextBody'] ?? base.settingsInstalledNextBody;
  @override
  String get settingsInstallDirEmpty => overrides['settingsInstallDirEmpty'] ?? base.settingsInstallDirEmpty;
  @override
  String get settingsEntryFound => overrides['settingsEntryFound'] ?? base.settingsEntryFound;
  @override
  String get settingsEntryMissing => overrides['settingsEntryMissing'] ?? base.settingsEntryMissing;
  @override
  String get settingsEntryPendingRestart => overrides['settingsEntryPendingRestart'] ?? base.settingsEntryPendingRestart;
  @override
  String get settingsStart => overrides['settingsStart'] ?? base.settingsStart;
  @override
  String get settingsStop => overrides['settingsStop'] ?? base.settingsStop;
  @override
  String get settingsOpenPanel => overrides['settingsOpenPanel'] ?? base.settingsOpenPanel;
  @override
  String get settingsProtocolNotAttachedNote => overrides['settingsProtocolNotAttachedNote'] ?? base.settingsProtocolNotAttachedNote;
  @override
  String get settingsChainProcess => overrides['settingsChainProcess'] ?? base.settingsChainProcess;
  @override
  String get settingsChainUnobserved => overrides['settingsChainUnobserved'] ?? base.settingsChainUnobserved;
  @override
  String get settingsChainNoInstance => overrides['settingsChainNoInstance'] ?? base.settingsChainNoInstance;
  @override
  String get settingsChainNotRunning => overrides['settingsChainNotRunning'] ?? base.settingsChainNotRunning;
  @override
  String get settingsChainNoPort => overrides['settingsChainNoPort'] ?? base.settingsChainNoPort;
  @override
  String get settingsChainSpawned => overrides['settingsChainSpawned'] ?? base.settingsChainSpawned;
  @override
  String get settingsChainDiscovered => overrides['settingsChainDiscovered'] ?? base.settingsChainDiscovered;
  @override
  String get settingsChainPortOnly => overrides['settingsChainPortOnly'] ?? base.settingsChainPortOnly;
  @override
  String get settingsChainRunning => overrides['settingsChainRunning'] ?? base.settingsChainRunning;
  @override
  String get settingsChainOneBotConfig => overrides['settingsChainOneBotConfig'] ?? base.settingsChainOneBotConfig;
  @override
  String get settingsChainWithToken => overrides['settingsChainWithToken'] ?? base.settingsChainWithToken;
  @override
  String get settingsChainNoToken => overrides['settingsChainNoToken'] ?? base.settingsChainNoToken;
  @override
  String get settingsChainPresent => overrides['settingsChainPresent'] ?? base.settingsChainPresent;
  @override
  String get settingsChainUnreadable => overrides['settingsChainUnreadable'] ?? base.settingsChainUnreadable;
  @override
  String get settingsChainMissing => overrides['settingsChainMissing'] ?? base.settingsChainMissing;
  @override
  String get settingsChainMissingDetail => overrides['settingsChainMissingDetail'] ?? base.settingsChainMissingDetail;
  @override
  String get settingsChainAdapter => overrides['settingsChainAdapter'] ?? base.settingsChainAdapter;
  @override
  String get settingsChainConnected => overrides['settingsChainConnected'] ?? base.settingsChainConnected;
  @override
  String get settingsChainReconnecting => overrides['settingsChainReconnecting'] ?? base.settingsChainReconnecting;
  @override
  String get settingsChainNoEndpoint => overrides['settingsChainNoEndpoint'] ?? base.settingsChainNoEndpoint;
  @override
  String get settingsChainNoEndpointDetail => overrides['settingsChainNoEndpointDetail'] ?? base.settingsChainNoEndpointDetail;
  @override
  String get settingsChainDisabled => overrides['settingsChainDisabled'] ?? base.settingsChainDisabled;
  @override
  String get settingsChainNotAssembled => overrides['settingsChainNotAssembled'] ?? base.settingsChainNotAssembled;
  @override
  String get settingsChainNotAssembledDetail => overrides['settingsChainNotAssembledDetail'] ?? base.settingsChainNotAssembledDetail;
  @override
  String get settingsChainNoData => overrides['settingsChainNoData'] ?? base.settingsChainNoData;
  @override
  String get settingsCredentialLost => overrides['settingsCredentialLost'] ?? base.settingsCredentialLost;
  @override
  String get settingsConsentPending => overrides['settingsConsentPending'] ?? base.settingsConsentPending;
  @override
  String get settingsPasswordUnchanged => overrides['settingsPasswordUnchanged'] ?? base.settingsPasswordUnchanged;
  @override
  String get settingsCredentialCopied => overrides['settingsCredentialCopied'] ?? base.settingsCredentialCopied;
  @override
  String get settingsCopyCredential => overrides['settingsCopyCredential'] ?? base.settingsCopyCredential;
  @override
  String get settingsProtocolRestartNote => overrides['settingsProtocolRestartNote'] ?? base.settingsProtocolRestartNote;
  @override
  String get settingsInstallDirRequired => overrides['settingsInstallDirRequired'] ?? base.settingsInstallDirRequired;
  @override
  String get settingsStartRequested => overrides['settingsStartRequested'] ?? base.settingsStartRequested;
  @override
  String get settingsStopRequested => overrides['settingsStopRequested'] ?? base.settingsStopRequested;
  @override
  String get settingsOneClickFailed => overrides['settingsOneClickFailed'] ?? base.settingsOneClickFailed;
  @override
  String get settingsInstallNoReason => overrides['settingsInstallNoReason'] ?? base.settingsInstallNoReason;
  @override
  String get settingsInstalledOk => overrides['settingsInstalledOk'] ?? base.settingsInstalledOk;
  @override
  String get settingsInstalledConfigured => overrides['settingsInstalledConfigured'] ?? base.settingsInstalledConfigured;
  @override
  String get settingsInstalledNotConfigured => overrides['settingsInstalledNotConfigured'] ?? base.settingsInstalledNotConfigured;
  @override
  String get settingsRestartSuffixParen => overrides['settingsRestartSuffixParen'] ?? base.settingsRestartSuffixParen;
  @override
  String get settingsGenerated => overrides['settingsGenerated'] ?? base.settingsGenerated;
  @override
  String get settingsNotGenerated => overrides['settingsNotGenerated'] ?? base.settingsNotGenerated;
  @override
  String get settingsWebhookNote => overrides['settingsWebhookNote'] ?? base.settingsWebhookNote;
  @override
  String get settingsWebhookLoading => overrides['settingsWebhookLoading'] ?? base.settingsWebhookLoading;
  @override
  String get settingsWebhookCurrent => overrides['settingsWebhookCurrent'] ?? base.settingsWebhookCurrent;
  @override
  String get settingsWebhookNotConfiguredNote => overrides['settingsWebhookNotConfiguredNote'] ?? base.settingsWebhookNotConfiguredNote;
  @override
  String get settingsWebhookRotated => overrides['settingsWebhookRotated'] ?? base.settingsWebhookRotated;
  @override
  String get settingsWebhookNever => overrides['settingsWebhookNever'] ?? base.settingsWebhookNever;
  @override
  String get settingsRegenerate => overrides['settingsRegenerate'] ?? base.settingsRegenerate;
  @override
  String get settingsGenerateWebhook => overrides['settingsGenerateWebhook'] ?? base.settingsGenerateWebhook;
  @override
  String get settingsWebhookCredentialNote => overrides['settingsWebhookCredentialNote'] ?? base.settingsWebhookCredentialNote;
  @override
  String get settingsRegenerateTitle => overrides['settingsRegenerateTitle'] ?? base.settingsRegenerateTitle;
  @override
  String get settingsRegenerateBody => overrides['settingsRegenerateBody'] ?? base.settingsRegenerateBody;
  @override
  String get settingsNoTokenReturned => overrides['settingsNoTokenReturned'] ?? base.settingsNoTokenReturned;
  @override
  String get settingsWebhookRotatedNote => overrides['settingsWebhookRotatedNote'] ?? base.settingsWebhookRotatedNote;
  @override
  String get settingsMemoryNote => overrides['settingsMemoryNote'] ?? base.settingsMemoryNote;
  @override
  String get settingsNotInEffect => overrides['settingsNotInEffect'] ?? base.settingsNotInEffect;
  @override
  String get settingsMemoryEnableLabel => overrides['settingsMemoryEnableLabel'] ?? base.settingsMemoryEnableLabel;
  @override
  String get settingsMemoryEnableNote => overrides['settingsMemoryEnableNote'] ?? base.settingsMemoryEnableNote;
  @override
  String get settingsMemoryOn => overrides['settingsMemoryOn'] ?? base.settingsMemoryOn;
  @override
  String get settingsMemoryOff => overrides['settingsMemoryOff'] ?? base.settingsMemoryOff;
  @override
  String get settingsMemoryUnaffectedNote => overrides['settingsMemoryUnaffectedNote'] ?? base.settingsMemoryUnaffectedNote;
  @override
  String get settingsMemoryRestartNote => overrides['settingsMemoryRestartNote'] ?? base.settingsMemoryRestartNote;
  @override
  String get settingsMemoryDetail => overrides['settingsMemoryDetail'] ?? base.settingsMemoryDetail;
  @override
  String get settingsMemoryCost => overrides['settingsMemoryCost'] ?? base.settingsMemoryCost;
  @override
  String get settingsMemoryOnSaved => overrides['settingsMemoryOnSaved'] ?? base.settingsMemoryOnSaved;
  @override
  String get settingsMemoryOffSaved => overrides['settingsMemoryOffSaved'] ?? base.settingsMemoryOffSaved;
  @override
  String get settingsTrustNote => overrides['settingsTrustNote'] ?? base.settingsTrustNote;
  @override
  String get settingsTrustReachLabel => overrides['settingsTrustReachLabel'] ?? base.settingsTrustReachLabel;
  @override
  String get settingsTrustReachNote => overrides['settingsTrustReachNote'] ?? base.settingsTrustReachNote;
  @override
  String get settingsTrustWorkspaceUnknownPath => overrides['settingsTrustWorkspaceUnknownPath'] ?? base.settingsTrustWorkspaceUnknownPath;
  @override
  String get settingsTrustFullValue => overrides['settingsTrustFullValue'] ?? base.settingsTrustFullValue;
  @override
  String get settingsTrustPendingNote => overrides['settingsTrustPendingNote'] ?? base.settingsTrustPendingNote;
  @override
  String get settingsTrustRootNote => overrides['settingsTrustRootNote'] ?? base.settingsTrustRootNote;
  @override
  String get settingsTrustBoundaryNote => overrides['settingsTrustBoundaryNote'] ?? base.settingsTrustBoundaryNote;
  @override
  String get settingsTrustRulesDetail => overrides['settingsTrustRulesDetail'] ?? base.settingsTrustRulesDetail;
  @override
  String get settingsTrustFullTitle => overrides['settingsTrustFullTitle'] ?? base.settingsTrustFullTitle;
  @override
  String get settingsTrustFullConfirmTail => overrides['settingsTrustFullConfirmTail'] ?? base.settingsTrustFullConfirmTail;
  @override
  String get settingsTrustWorkspaceSaved => overrides['settingsTrustWorkspaceSaved'] ?? base.settingsTrustWorkspaceSaved;
  @override
  String get settingsTrustFullSaved => overrides['settingsTrustFullSaved'] ?? base.settingsTrustFullSaved;
  @override
  String get settingsSystemNote => overrides['settingsSystemNote'] ?? base.settingsSystemNote;
  @override
  String get settingsDataDir => overrides['settingsDataDir'] ?? base.settingsDataDir;
  @override
  String get settingsDataDirNote => overrides['settingsDataDirNote'] ?? base.settingsDataDirNote;
  @override
  String get settingsSystemFootnote => overrides['settingsSystemFootnote'] ?? base.settingsSystemFootnote;
  @override
  String get settingsLiveNow => overrides['settingsLiveNow'] ?? base.settingsLiveNow;
  @override
  String get settingsEdit => overrides['settingsEdit'] ?? base.settingsEdit;
  @override
  String get settingsAccountNote => overrides['settingsAccountNote'] ?? base.settingsAccountNote;
  @override
  String get settingsAccountLegacyBadge => overrides['settingsAccountLegacyBadge'] ?? base.settingsAccountLegacyBadge;
  @override
  String get settingsAccountSessionBadge => overrides['settingsAccountSessionBadge'] ?? base.settingsAccountSessionBadge;
  @override
  String get settingsAccountInstance => overrides['settingsAccountInstance'] ?? base.settingsAccountInstance;
  @override
  String get settingsAccountInstanceNote => overrides['settingsAccountInstanceNote'] ?? base.settingsAccountInstanceNote;
  @override
  String get settingsAccountLegacyNote => overrides['settingsAccountLegacyNote'] ?? base.settingsAccountLegacyNote;
  @override
  String get settingsChangePassword => overrides['settingsChangePassword'] ?? base.settingsChangePassword;
  @override
  String get settingsLogout => overrides['settingsLogout'] ?? base.settingsLogout;
  @override
  String get settingsSetPasswordFirst => overrides['settingsSetPasswordFirst'] ?? base.settingsSetPasswordFirst;
  @override
  String get settingsPasswordChanged => overrides['settingsPasswordChanged'] ?? base.settingsPasswordChanged;
  @override
  String get settingsLogoutBody => overrides['settingsLogoutBody'] ?? base.settingsLogoutBody;
  @override
  String get settingsCloseInstance => overrides['settingsCloseInstance'] ?? base.settingsCloseInstance;
  @override
  String get settingsCloseInstanceBody =>
      overrides['settingsCloseInstanceBody'] ?? base.settingsCloseInstanceBody;
  @override
  String get gateHintSessionExpired => overrides['gateHintSessionExpired'] ?? base.gateHintSessionExpired;
  @override
  String get gateHintSetupNeeded => overrides['gateHintSetupNeeded'] ?? base.gateHintSetupNeeded;
  @override
  String get gateHintAlreadyInitialized => overrides['gateHintAlreadyInitialized'] ?? base.gateHintAlreadyInitialized;
  // ── 实例选择页（2026-10）：无参的可覆盖，带参的只转发（见 stringsAsMap 里那段注释）──
  @override
  String get pickerTitle => overrides['pickerTitle'] ?? base.pickerTitle;
  @override
  String get pickerBody => overrides['pickerBody'] ?? base.pickerBody;
  @override
  String get pickerLoading => overrides['pickerLoading'] ?? base.pickerLoading;
  @override
  String get pickerEmpty => overrides['pickerEmpty'] ?? base.pickerEmpty;
  @override
  String get pickerUnreadable => overrides['pickerUnreadable'] ?? base.pickerUnreadable;
  @override
  String get pickerRunning => overrides['pickerRunning'] ?? base.pickerRunning;
  @override
  String get pickerStopped => overrides['pickerStopped'] ?? base.pickerStopped;
  @override
  String get pickerDefaultBadge => overrides['pickerDefaultBadge'] ?? base.pickerDefaultBadge;
  @override
  String get pickerLogin => overrides['pickerLogin'] ?? base.pickerLogin;
  @override
  String get pickerStart => overrides['pickerStart'] ?? base.pickerStart;
  @override
  String get pickerStarting => overrides['pickerStarting'] ?? base.pickerStarting;
  @override
  String get pickerEnter => overrides['pickerEnter'] ?? base.pickerEnter;
  @override
  String get pickerStartEnter => overrides['pickerStartEnter'] ?? base.pickerStartEnter;
  @override
  String get pickerEntering => overrides['pickerEntering'] ?? base.pickerEntering;
  @override
  String get pickerForget => overrides['pickerForget'] ?? base.pickerForget;
  @override
  String get pickerSessionExpired => overrides['pickerSessionExpired'] ?? base.pickerSessionExpired;
  @override
  String get pickerNew => overrides['pickerNew'] ?? base.pickerNew;
  @override
  String get pickerDelete => overrides['pickerDelete'] ?? base.pickerDelete;
  @override
  String get pickerNewNameLabel => overrides['pickerNewNameLabel'] ?? base.pickerNewNameLabel;
  @override
  String get pickerNewDirLabel => overrides['pickerNewDirLabel'] ?? base.pickerNewDirLabel;
  @override
  String get pickerNewCreate => overrides['pickerNewCreate'] ?? base.pickerNewCreate;
  @override
  String get pickerNewUseDir => overrides['pickerNewUseDir'] ?? base.pickerNewUseDir;
  @override
  String get pickerDeleteTitle => overrides['pickerDeleteTitle'] ?? base.pickerDeleteTitle;
  @override
  String pickerDeleteBody(String name) => base.pickerDeleteBody(name);
  @override
  String pickerForgetBody(String name) => base.pickerForgetBody(name);
  @override
  String get pickerDeleteNote => overrides['pickerDeleteNote'] ?? base.pickerDeleteNote;
  @override
  String get pickerDeleteKeepDir => overrides['pickerDeleteKeepDir'] ?? base.pickerDeleteKeepDir;
  @override
  String get pickerDeleteWithDir => overrides['pickerDeleteWithDir'] ?? base.pickerDeleteWithDir;
  @override
  String get pickerRename => overrides['pickerRename'] ?? base.pickerRename;
  @override
  String get pickerRenameTitle => overrides['pickerRenameTitle'] ?? base.pickerRenameTitle;
  @override
  String get pickerRenameBody => overrides['pickerRenameBody'] ?? base.pickerRenameBody;
  @override
  String get pickerRenameSave => overrides['pickerRenameSave'] ?? base.pickerRenameSave;
  @override
  String get pickerProblemNameRequired => overrides['pickerProblemNameRequired'] ?? base.pickerProblemNameRequired;
  @override
  String get pickerProblemNoLauncher => overrides['pickerProblemNoLauncher'] ?? base.pickerProblemNoLauncher;
  @override
  String get pickerProblemLaunchFailed => overrides['pickerProblemLaunchFailed'] ?? base.pickerProblemLaunchFailed;
  @override
  String get pickerProblemPortUnavailable =>
      overrides['pickerProblemPortUnavailable'] ?? base.pickerProblemPortUnavailable;
  @override
  String get pickerProblemRemoveFailed => overrides['pickerProblemRemoveFailed'] ?? base.pickerProblemRemoveFailed;
  @override
  String get pickerProblemRenameFailed => overrides['pickerProblemRenameFailed'] ?? base.pickerProblemRenameFailed;
  @override
  String pickerProblemDirNotEmpty(String dir) => base.pickerProblemDirNotEmpty(dir);
  @override
  String pickerProblemNotReady(int seconds, String phase, String port) =>
      base.pickerProblemNotReady(seconds, phase, port);
  @override
  String pickerProblemPortTaken(String id) => base.pickerProblemPortTaken(id);
  @override
  String pickerProblemCannotDeleteRunning(String name) => base.pickerProblemCannotDeleteRunning(name);
  @override
  String pickerProblemCannotDeleteDefault(String name) => base.pickerProblemCannotDeleteDefault(name);
  @override
  String pickerStartingNamed(String name) => base.pickerStartingNamed(name);
  @override
  String pickerNewPort(String port) => base.pickerNewPort(port);
  @override
  String pickerDeleteDisabled(String reason) => base.pickerDeleteDisabled(reason);
  @override
  String pickerWaitingReady(int seconds, String phase) => base.pickerWaitingReady(seconds, phase);
  @override
  String get pickerStopWaiting => overrides['pickerStopWaiting'] ?? base.pickerStopWaiting;
  @override
  String get settingsAboutNote => overrides['settingsAboutNote'] ?? base.settingsAboutNote;
  @override
  String get settingsAboutBadge => overrides['settingsAboutBadge'] ?? base.settingsAboutBadge;
  @override
  String get settingsVersionLabel => overrides['settingsVersionLabel'] ?? base.settingsVersionLabel;
  @override
  String get settingsGuardedDays => overrides['settingsGuardedDays'] ?? base.settingsGuardedDays;
  @override
  String get settingsWatermark => overrides['settingsWatermark'] ?? base.settingsWatermark;
  @override
  String get settingsProjectionFootnote => overrides['settingsProjectionFootnote'] ?? base.settingsProjectionFootnote;
  @override
  String get settingsDestructivePolicy => overrides['settingsDestructivePolicy'] ?? base.settingsDestructivePolicy;
  @override
  String get settingsModify => overrides['settingsModify'] ?? base.settingsModify;
  @override
  String get settingsPolicyNoneOption => overrides['settingsPolicyNoneOption'] ?? base.settingsPolicyNoneOption;
  @override
  String get settingsPolicyAllOption => overrides['settingsPolicyAllOption'] ?? base.settingsPolicyAllOption;
  @override
  String get settingsPolicyListOption => overrides['settingsPolicyListOption'] ?? base.settingsPolicyListOption;
  @override
  String get settingsPolicyListTitle => overrides['settingsPolicyListTitle'] ?? base.settingsPolicyListTitle;
  @override
  String get settingsPolicyNoTools => overrides['settingsPolicyNoTools'] ?? base.settingsPolicyNoTools;
  @override
  String get settingsDestructiveTitle => overrides['settingsDestructiveTitle'] ?? base.settingsDestructiveTitle;
  @override
  String get settingsDestructiveRelaxedBody => overrides['settingsDestructiveRelaxedBody'] ?? base.settingsDestructiveRelaxedBody;
  @override
  String get settingsDestructiveRestrictedBody => overrides['settingsDestructiveRestrictedBody'] ?? base.settingsDestructiveRestrictedBody;
  @override
  String get settingsPolicyAll => overrides['settingsPolicyAll'] ?? base.settingsPolicyAll;
  @override
  String get settingsPolicyListEmpty => overrides['settingsPolicyListEmpty'] ?? base.settingsPolicyListEmpty;
  @override
  String get settingsPolicyNone => overrides['settingsPolicyNone'] ?? base.settingsPolicyNone;
  @override
  String get settingsListAnd => overrides['settingsListAnd'] ?? base.settingsListAnd;
  @override
  String get settingsUnknownReason => overrides['settingsUnknownReason'] ?? base.settingsUnknownReason;
  @override
  String get settingsSeeOfficialDocs => overrides['settingsSeeOfficialDocs'] ?? base.settingsSeeOfficialDocs;
  @override
  String get settingsWebhookCurlTokenPlaceholder => overrides['settingsWebhookCurlTokenPlaceholder'] ?? base.settingsWebhookCurlTokenPlaceholder;
  @override
  String get settingsWebhookCurlSampleText => overrides['settingsWebhookCurlSampleText'] ?? base.settingsWebhookCurlSampleText;

  @override
  String expandAll(int chars) => base.expandAll(chars);
  @override
  String loadFailed(String reason) => base.loadFailed(reason);
  @override
  String configReadFailed(String reason) => base.configReadFailed(reason);
  @override
  String restartConfirmed(String evidence) => base.restartConfirmed(evidence);
  @override
  String restartEvidence(int backendPid, bool portReady) => base.restartEvidence(backendPid, portReady);
  @override
  String restartFailed(String reason) => base.restartFailed(reason);
  @override
  String restartRefused(String reason) => base.restartRefused(reason);
  @override
  String restartNoReceipt(String reason) => base.restartNoReceipt(reason);
  @override
  String requestWaiting(String request, int seconds) => base.requestWaiting(request, seconds);
  @override
  String requestTimeout(String request, int seconds, bool maybeDone) =>
      base.requestTimeout(request, seconds, maybeDone);
  @override
  String requestStreamStalled(int seconds) => base.requestStreamStalled(seconds);
  @override
  String gateWaitingBackend(int port) => base.gateWaitingBackend(port);
  @override
  String gateBackendDown(String address) => base.gateBackendDown(address);
  @override
  String gateBackendStarting(String phase) => base.gateBackendStarting(phase);
  @override
  String backendPhaseLabel(String phase) => base.backendPhaseLabel(phase);
  @override
  String gateBackendProgress(int seconds, int retries) => base.gateBackendProgress(seconds, retries);
  @override
  String get gateBackendLogHint => overrides['gateBackendLogHint'] ?? base.gateBackendLogHint;
  @override
  String restartBackTimeout(int seconds) => base.restartBackTimeout(seconds);
  @override
  String quitAllConfirmBody(bool busy) => base.quitAllConfirmBody(busy);
  @override
  String quitAllFailed(String reason) => base.quitAllFailed(reason);
  @override
  String onboardingSecretConfigured(String? mask) => base.onboardingSecretConfigured(mask);
  @override
  String onboardingQqBindAppId(String appId) => base.onboardingQqBindAppId(appId);
  @override
  String onboardingQqBindTokenOk(int expiresIn) => base.onboardingQqBindTokenOk(expiresIn);
  @override
  String onboardingQqBindTokenFailed(String reason) => base.onboardingQqBindTokenFailed(reason);
  @override
  String onboardingQqBindStartFailed(String reason) => base.onboardingQqBindStartFailed(reason);
  @override
  String onboardingQqBindStatusFailed(String reason) => base.onboardingQqBindStatusFailed(reason);
  @override
  String onboardingDepsItemFailed(String reason) => base.onboardingDepsItemFailed(reason);
  @override
  String onboardingDepsSummary(int ok, int failed) => base.onboardingDepsSummary(ok, failed);
  @override
  String onboardingDepsLastRun(int ok, int failed) => base.onboardingDepsLastRun(ok, failed);
  @override
  String onboardingDepsReadFailed(String reason) => base.onboardingDepsReadFailed(reason);
  @override
  String onboardingOpenLinkFailed(String url) => base.onboardingOpenLinkFailed(url);
  @override
  String onboardingChannelSaveFailed(String reason) => base.onboardingChannelSaveFailed(reason);
  @override
  String onboardingSecretsSaveFailed(String reason) => base.onboardingSecretsSaveFailed(reason);
  @override
  String onboardingApiKeyWritten(String gates) => base.onboardingApiKeyWritten(gates);
  @override
  String onboardingApiKeyHintWritten(String gates) => base.onboardingApiKeyHintWritten(gates);
  @override
  String onboardingApiKeyHintPartial(String have, String missing) =>
      base.onboardingApiKeyHintPartial(have, missing);
  @override
  String onboardingApiKeySaveFailed(String gates, String reason) =>
      base.onboardingApiKeySaveFailed(gates, reason);
  @override
  String onboardingApiKeyNoSlot(String routes, String envNames) =>
      base.onboardingApiKeyNoSlot(routes, envNames);
  // ── 第 2 步：模型探测 / 协议三档 / 密钥状态（2026-10-26）─────────────
  @override
  String get onboardingModelLabel => overrides['onboardingModelLabel'] ?? base.onboardingModelLabel;
  @override
  String get onboardingModelRequired => overrides['onboardingModelRequired'] ?? base.onboardingModelRequired;
  @override
  String get onboardingBaseUrlLabel => overrides['onboardingBaseUrlLabel'] ?? base.onboardingBaseUrlLabel;
  @override
  String get onboardingBaseUrlRequired =>
      overrides['onboardingBaseUrlRequired'] ?? base.onboardingBaseUrlRequired;
  @override
  String get onboardingBaseUrlNote => overrides['onboardingBaseUrlNote'] ?? base.onboardingBaseUrlNote;
  @override
  String get onboardingApiKeyLabel => overrides['onboardingApiKeyLabel'] ?? base.onboardingApiKeyLabel;
  @override
  String get onboardingApiKeyStatusMissing =>
      overrides['onboardingApiKeyStatusMissing'] ?? base.onboardingApiKeyStatusMissing;
  @override
  String onboardingApiKeyStatusWritten(String gates) => base.onboardingApiKeyStatusWritten(gates);
  @override
  String onboardingApiKeyStatusPartial(String have) => base.onboardingApiKeyStatusPartial(have);
  @override
  String get onboardingProbeButton => overrides['onboardingProbeButton'] ?? base.onboardingProbeButton;
  @override
  String get onboardingProbeRunning => overrides['onboardingProbeRunning'] ?? base.onboardingProbeRunning;
  @override
  String get onboardingProbeBaseRequired =>
      overrides['onboardingProbeBaseRequired'] ?? base.onboardingProbeBaseRequired;
  @override
  String onboardingProbeDone({
    required int count,
    required bool responsesOk,
    required int? responsesMs,
    required bool chatOk,
    required int? chatMs,
    String? recommended,
  }) =>
      base.onboardingProbeDone(
        count: count,
        responsesOk: responsesOk,
        responsesMs: responsesMs,
        chatOk: chatOk,
        chatMs: chatMs,
        recommended: recommended,
      );
  @override
  String get onboardingProbeSearchHint =>
      overrides['onboardingProbeSearchHint'] ?? base.onboardingProbeSearchHint;
  @override
  String get onboardingProbeNoMatch => overrides['onboardingProbeNoMatch'] ?? base.onboardingProbeNoMatch;
  @override
  String get onboardingProbeEmptyList =>
      overrides['onboardingProbeEmptyList'] ?? base.onboardingProbeEmptyList;
  @override
  String onboardingProbeBadge(String protocol, bool supported) => base.onboardingProbeBadge(protocol, supported);
  @override
  String get onboardingProbeUnreachable =>
      overrides['onboardingProbeUnreachable'] ?? base.onboardingProbeUnreachable;
  @override
  String get onboardingProbeUnauthorized =>
      overrides['onboardingProbeUnauthorized'] ?? base.onboardingProbeUnauthorized;
  @override
  String get onboardingProbeNoModels => overrides['onboardingProbeNoModels'] ?? base.onboardingProbeNoModels;
  @override
  String get onboardingProbeNoKey => overrides['onboardingProbeNoKey'] ?? base.onboardingProbeNoKey;
  @override
  String onboardingProbeFailed(String reason) => base.onboardingProbeFailed(reason);
  @override
  String onboardingProbeOnlyProtocol(String protocol) => base.onboardingProbeOnlyProtocol(protocol);
  @override
  String onboardingProbeWarning(String warning) => base.onboardingProbeWarning(warning);
  @override
  String receivedFrom(String sender, String id) => base.receivedFrom(sender, id);
  @override
  String mentionsYou(String where) => base.mentionsYou(where);
  @override
  String talkingAbout(String what) => base.talkingAbout(what);
  @override
  String fromWho(String who) => base.fromWho(who);
  @override
  String scheduledAt(String at) => base.scheduledAt(at);
  @override
  String thinkingStep(String step) => base.thinkingStep(step);
  @override
  String thinkingChars(String chars) => base.thinkingChars(chars);
  @override
  String thinkingElapsed(String elapsed) => base.thinkingElapsed(elapsed);
  @override
  String compactChars(int chars) => base.compactChars(chars);
  @override
  String toastClearFailed(String reason) => base.toastClearFailed(reason);
  @override
  String toastTriggerFailed(String reason) => base.toastTriggerFailed(reason);
  @override
  String toastSendFailed(String reason) => base.toastSendFailed(reason);
  @override
  String stringsOverrideLoaded(int zh, int en) => base.stringsOverrideLoaded(zh, en);
  @override
  String stringsOverrideFailed(String reason) => base.stringsOverrideFailed(reason);
  @override
  String stringsOverrideUnreadable(String detail) => base.stringsOverrideUnreadable(detail);
  @override
  String stringsOverrideBadJson(String detail) => base.stringsOverrideBadJson(detail);
  @override
  String stringsOverrideIgnored(int count) => base.stringsOverrideIgnored(count);
  @override
  String stringsOverrideExported(String path) => base.stringsOverrideExported(path);
  @override
  String stringsOverrideExportFailed(String reason) => base.stringsOverrideExportFailed(reason);
  @override
  String stringsOverrideOpenFailed(String path) => base.stringsOverrideOpenFailed(path);
  @override
  String overviewAdviceLine(String title, String body) => base.overviewAdviceLine(title, body);
  @override
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp) => base.overviewDeadLetterLine(seq, claimCount, stamp);
  @override
  String overviewPendingCount(int count) => base.overviewPendingCount(count);
  @override
  String overviewTodayUsageTooltip(String exact) => base.overviewTodayUsageTooltip(exact);
  @override
  String overviewTimerCancelBody(String timerId) => base.overviewTimerCancelBody(timerId);
  @override
  String overviewTimerCancelled(String timerId) => base.overviewTimerCancelled(timerId);
  @override
  String overviewTimerCancelFailed(String timerId, String reason) => base.overviewTimerCancelFailed(timerId, reason);
  @override
  String overviewTimerCancelToastFailed(String reason) => base.overviewTimerCancelToastFailed(reason);
  @override
  String overviewMarkFailedToast(String reason) => base.overviewMarkFailedToast(reason);
  @override
  String overviewDeadRequeued(int seq) => base.overviewDeadRequeued(seq);
  @override
  String overviewDeadDiscardBody(int inputSeq) => base.overviewDeadDiscardBody(inputSeq);
  @override
  String overviewDeadDiscarded(int seq) => base.overviewDeadDiscarded(seq);
  @override
  String overviewDeadActionFailed(String verb, int seq, String reason) => base.overviewDeadActionFailed(verb, seq, reason);
  @override
  String overviewDeadActionToastFailed(String verb, String reason) => base.overviewDeadActionToastFailed(verb, reason);
  @override
  String overviewHistoricalBadge(String label) => base.overviewHistoricalBadge(label);
  @override
  String overviewSourceFramework(String? fingerprint) => base.overviewSourceFramework(fingerprint);
  @override
  String overviewSourceChat(String who) => base.overviewSourceChat(who);
  @override
  String overviewQuote(String text) => base.overviewQuote(text);
  @override
  String overviewGroupsCount(int count) => base.overviewGroupsCount(count);
  @override
  String overviewSinglesCount(int count) => base.overviewSinglesCount(count);
  @override
  String overviewOthersCount(int count) => base.overviewOthersCount(count);
  @override
  String overviewUnreadTotal(int count) => base.overviewUnreadTotal(count);
  @override
  String overviewMessagesSeen(int count) => base.overviewMessagesSeen(count);
  @override
  String overviewUnreadBadge(int count) => base.overviewUnreadBadge(count);
  @override
  String overviewTimersWaiting(int count) => base.overviewTimersWaiting(count);
  @override
  String overviewTimerCron(String cron) => base.overviewTimerCron(cron);
  @override
  String overviewTimerPayload(String payload) => base.overviewTimerPayload(payload);
  @override
  String overviewExternalSessionsError(String reason) => base.overviewExternalSessionsError(reason);
  @override
  String overviewFrameworkNotesError(String reason) => base.overviewFrameworkNotesError(reason);
  @override
  String overviewContextTokens(String used, String budget) => base.overviewContextTokens(used, budget);
  @override
  String overviewContextSubline(int percent, String keep, String stamp) =>
      base.overviewContextSubline(percent, keep, stamp);
  @override
  String overviewContextShare(int share) => base.overviewContextShare(share);
  @override
  String overviewContextLegendNumbers(String tokens, int share) =>
      base.overviewContextLegendNumbers(tokens, share);
  @override
  String overviewContextError(String reason) => base.overviewContextError(reason);
  @override
  String settingsSysEmptyError(String label) => base.settingsSysEmptyError(label);
  @override
  String settingsSysIntRequired(String label) => base.settingsSysIntRequired(label);
  @override
  String settingsSysPortRange(String label) => base.settingsSysPortRange(label);
  @override
  String settingsSysMinOne(String label) => base.settingsSysMinOne(label);
  @override
  String settingsSysRatioRequired(String label) => base.settingsSysRatioRequired(label);
  @override
  String settingsSysRatioRange(String label) => base.settingsSysRatioRange(label);
  @override
  String settingsSysMin(String label, int lo) => base.settingsSysMin(label, lo);
  @override
  String settingsSysMax(String label, int hi) => base.settingsSysMax(label, hi);
  @override
  String settingsTrustConsequenceWorkspace(String root) => base.settingsTrustConsequenceWorkspace(root);
  @override
  String settingsSaveFailed(String err) => base.settingsSaveFailed(err);
  @override
  String settingsClearFailed(String err) => base.settingsClearFailed(err);
  @override
  String settingsKeysReadFailedHint(String keysError) => base.settingsKeysReadFailedHint(keysError);
  @override
  String settingsKeyEnvNote(String envName) => base.settingsKeyEnvNote(envName);
  @override
  String settingsSpeakTypingOn(String saved) => base.settingsSpeakTypingOn(saved);
  @override
  String settingsSpeakTypingOff(String saved) => base.settingsSpeakTypingOff(saved);
  @override
  String settingsDepsReadFailedHint(String depsError) => base.settingsDepsReadFailedHint(depsError);
  @override
  String settingsInstallRequestFailed(String err) => base.settingsInstallRequestFailed(err);
  @override
  String settingsOpenedUrl(String url) => base.settingsOpenedUrl(url);
  @override
  String settingsProtocolError(String protocolError) => base.settingsProtocolError(protocolError);
  @override
  String settingsInstallManualRoute(String protocolDownloadUrl) => base.settingsInstallManualRoute(protocolDownloadUrl);
  @override
  String settingsEndpointPoint(String wsUrl) => base.settingsEndpointPoint(wsUrl);
  @override
  String settingsChainListening(String url) => base.settingsChainListening(url);
  @override
  String settingsChainEndpoint(String ws) => base.settingsChainEndpoint(ws);
  @override
  String settingsChainDelivered(String delivered) => base.settingsChainDelivered(delivered);
  @override
  String settingsChainBackoff(String attempts) => base.settingsChainBackoff(attempts);
  @override
  String settingsCredentialCaptured(String user, String masked) => base.settingsCredentialCaptured(user, masked);
  @override
  String settingsCredentialFromLog(String user, String masked) => base.settingsCredentialFromLog(user, masked);
  @override
  String settingsQrLoginAt(String webuiUrl) => base.settingsQrLoginAt(webuiUrl);
  @override
  String settingsManualDownloadGuide(String protocolDownloadUrl) => base.settingsManualDownloadGuide(protocolDownloadUrl);
  @override
  String settingsInstallRequestFailedHint(String err) => base.settingsInstallRequestFailedHint(err);
  @override
  String settingsWebhookErrorHint(String webhookError) => base.settingsWebhookErrorHint(webhookError);
  @override
  String settingsWebhookCurrentValue(String secretId, String createdAt) => base.settingsWebhookCurrentValue(secretId, createdAt);
  @override
  String settingsWebhookBy(String by) => base.settingsWebhookBy(by);
  @override
  String settingsGenerateFailed(String err) => base.settingsGenerateFailed(err);
  @override
  String settingsTrustWorkspaceValue(String root) => base.settingsTrustWorkspaceValue(root);
  @override
  String settingsProjectionReadFailedHint(String projError) => base.settingsProjectionReadFailedHint(projError);
  @override
  String settingsDaysCount(String days) => base.settingsDaysCount(days);
  @override
  String settingsDaysSince(String days, String stamp) => base.settingsDaysSince(days, stamp);
  @override
  String settingsSaved(String written, String restart) => base.settingsSaved(written, restart);
  @override
  String settingsClearKeyTitle(String laneLabel) => base.settingsClearKeyTitle(laneLabel);
  @override
  String settingsKeyConfiguredMask(String mask) => base.settingsKeyConfiguredMask(mask);
  @override
  String settingsDepPipUnavailable(String? reason) => base.settingsDepPipUnavailable(reason);
  @override
  String settingsInstallConfirmBody(String managedDir) => base.settingsInstallConfirmBody(managedDir);
  @override
  String settingsDepReadyToast(String label, String version) => base.settingsDepReadyToast(label, version);
  @override
  String settingsStepErrorToast(String step, String error) => base.settingsStepErrorToast(step, error);
  @override
  String settingsNoDownloadPage(String hint) => base.settingsNoDownloadPage(hint);
  @override
  String settingsOpenUrlFailed(String url, String? hint) => base.settingsOpenUrlFailed(url, hint);
  @override
  String settingsInstalledVersion(String? version) => base.settingsInstalledVersion(version);
  @override
  String settingsWriteErrorNote(String writeError) => base.settingsWriteErrorNote(writeError);
  @override
  String settingsChainSince(String when) => base.settingsChainSince(when);
  @override
  String settingsChainUnreadableDetail(String path) => base.settingsChainUnreadableDetail(path);
  @override
  String settingsProtocolToggled(bool on, bool restart) => base.settingsProtocolToggled(on, restart);
  @override
  String settingsInstallDirSaved(String saved, bool restart) => base.settingsInstallDirSaved(saved, restart);
  @override
  String settingsProtocolActionFailed(bool start, String err) => base.settingsProtocolActionFailed(start, err);
  @override
  String settingsWebhookFileNote(String file) => base.settingsWebhookFileNote(file);
  @override
  String settingsTrustFullBody(String consequence) => base.settingsTrustFullBody(consequence);
  @override
  String settingsPolicyListCount(int count) => base.settingsPolicyListCount(count);
  @override
  String settingsDepsSuggested(int count) => base.settingsDepsSuggested(count);
  @override
  String settingsDepPipReady(String version) => base.settingsDepPipReady(version);
  @override
  String settingsDepPurposeImpact(String purpose, String impact) => base.settingsDepPurposeImpact(purpose, impact);
  @override
  String settingsInstallTitle(String label) => base.settingsInstallTitle(label);
  @override
  String settingsPolicySave(int count) => base.settingsPolicySave(count);
  @override
  String settingsInstallHead(bool ok, String? version, bool configured) =>
      base.settingsInstallHead(ok, version, configured);
  @override
  String get chanSourceQqOfficial =>
      overrides['chanSourceQqOfficial'] ?? base.chanSourceQqOfficial;
  @override
  String get chanEventInboundWake =>
      overrides['chanEventInboundWake'] ?? base.chanEventInboundWake;
  @override
  String get chanEventFile =>
      overrides['chanEventFile'] ?? base.chanEventFile;
  @override
  String get chanAlertExit =>
      overrides['chanAlertExit'] ?? base.chanAlertExit;
  @override
  String get chanQqAppIdHint =>
      overrides['chanQqAppIdHint'] ?? base.chanQqAppIdHint;
  @override
  String get chanQqAppSecretHint =>
      overrides['chanQqAppSecretHint'] ?? base.chanQqAppSecretHint;
  @override
  String get chanOneBotTokenHint =>
      overrides['chanOneBotTokenHint'] ?? base.chanOneBotTokenHint;
  @override
  String get chanQqApiBaseLabel =>
      overrides['chanQqApiBaseLabel'] ?? base.chanQqApiBaseLabel;
  @override
  String get chanQqUrlHint =>
      overrides['chanQqUrlHint'] ?? base.chanQqUrlHint;
  @override
  String get chanQqTokenUrlLabel =>
      overrides['chanQqTokenUrlLabel'] ?? base.chanQqTokenUrlLabel;
  @override
  String get chanQqGatewayUrlLabel =>
      overrides['chanQqGatewayUrlLabel'] ?? base.chanQqGatewayUrlLabel;
  @override
  String get chanQqGatewayHint =>
      overrides['chanQqGatewayHint'] ?? base.chanQqGatewayHint;
  @override
  String get chanOneBotWsLabel =>
      overrides['chanOneBotWsLabel'] ?? base.chanOneBotWsLabel;
  @override
  String get chanOneBotWsHint =>
      overrides['chanOneBotWsHint'] ?? base.chanOneBotWsHint;
  @override
  String get chanAlertWebhookLabel =>
      overrides['chanAlertWebhookLabel'] ?? base.chanAlertWebhookLabel;
  @override
  String get chanAlertWebhookHint =>
      overrides['chanAlertWebhookHint'] ?? base.chanAlertWebhookHint;
  @override
  String get chanAlertRateLabel =>
      overrides['chanAlertRateLabel'] ?? base.chanAlertRateLabel;
  @override
  String get chanAlertRateHint =>
      overrides['chanAlertRateHint'] ?? base.chanAlertRateHint;
  @override
  String get chanEndpointLabel =>
      overrides['chanEndpointLabel'] ?? base.chanEndpointLabel;
  @override
  String get chanListenLabel =>
      overrides['chanListenLabel'] ?? base.chanListenLabel;
  @override
  String get chanQqTitle =>
      overrides['chanQqTitle'] ?? base.chanQqTitle;
  @override
  String get chanQqHint =>
      overrides['chanQqHint'] ?? base.chanQqHint;
  @override
  String get chanOneBotHint =>
      overrides['chanOneBotHint'] ?? base.chanOneBotHint;
  @override
  String get chanOneBotBlurb =>
      overrides['chanOneBotBlurb'] ?? base.chanOneBotBlurb;
  @override
  String get chanHookTitle =>
      overrides['chanHookTitle'] ?? base.chanHookTitle;
  @override
  String get chanHookHint =>
      overrides['chanHookHint'] ?? base.chanHookHint;
  @override
  String get chanHookBlurb =>
      overrides['chanHookBlurb'] ?? base.chanHookBlurb;
  @override
  String get chanConfigReadFailed =>
      overrides['chanConfigReadFailed'] ?? base.chanConfigReadFailed;
  @override
  String get chanKeysReadFailed =>
      overrides['chanKeysReadFailed'] ?? base.chanKeysReadFailed;
  @override
  String chanClearSecretTitle(String label) =>
      base.chanClearSecretTitle(label);
  @override
  String get chanClearSecretBody =>
      overrides['chanClearSecretBody'] ?? base.chanClearSecretBody;
  @override
  String chanClearFailed(String reason) =>
      base.chanClearFailed(reason);
  @override
  String chanNotANumber(String field) =>
      base.chanNotANumber(field);
  @override
  String get chanNothingToSave =>
      overrides['chanNothingToSave'] ?? base.chanNothingToSave;
  @override
  String chanSavedFieldCount(int count) =>
      base.chanSavedFieldCount(count);
  @override
  String chanSavedSecretCount(int count) =>
      base.chanSavedSecretCount(count);
  @override
  String get chanSavedRestartSuffix =>
      overrides['chanSavedRestartSuffix'] ?? base.chanSavedRestartSuffix;
  @override
  String get chanSavedLiveSuffix =>
      overrides['chanSavedLiveSuffix'] ?? base.chanSavedLiveSuffix;
  @override
  String chanSaved(String parts, String suffix) =>
      base.chanSaved(parts, suffix);
  @override
  String get chanReloaded =>
      overrides['chanReloaded'] ?? base.chanReloaded;
  @override
  String chanTestDelivered(String url) =>
      base.chanTestDelivered(url);
  @override
  String chanTestNotDelivered(String reason) =>
      base.chanTestNotDelivered(reason);
  @override
  String chanTestFailed(String reason) =>
      base.chanTestFailed(reason);
  @override
  String get chanStatusUnknown =>
      overrides['chanStatusUnknown'] ?? base.chanStatusUnknown;
  @override
  String get chanStatusUnknownNote =>
      overrides['chanStatusUnknownNote'] ?? base.chanStatusUnknownNote;
  @override
  String get chanStatusOff =>
      overrides['chanStatusOff'] ?? base.chanStatusOff;
  @override
  String get chanStatusOffNote =>
      overrides['chanStatusOffNote'] ?? base.chanStatusOffNote;
  @override
  String get chanStatusOn =>
      overrides['chanStatusOn'] ?? base.chanStatusOn;
  @override
  String get chanStatusOnNote =>
      overrides['chanStatusOnNote'] ?? base.chanStatusOnNote;
  @override
  String chanStatusRunningNote(String at, String suffix) =>
      base.chanStatusRunningNote(at, suffix);
  @override
  String get chanStatusNoExit =>
      overrides['chanStatusNoExit'] ?? base.chanStatusNoExit;
  @override
  String get chanStatusNoExitNote =>
      overrides['chanStatusNoExitNote'] ?? base.chanStatusNoExitNote;
  @override
  String get chanStatusExitOn =>
      overrides['chanStatusExitOn'] ?? base.chanStatusExitOn;
  @override
  String get chanStatusExitOnNote =>
      overrides['chanStatusExitOnNote'] ?? base.chanStatusExitOnNote;
  @override
  String chanStatusHookRunningNote(String tag, String at) =>
      base.chanStatusHookRunningNote(tag, at);
  @override
  String chanFootnoteError(String error) =>
      base.chanFootnoteError(error);
  @override
  String chanFootnoteCount(int count) =>
      base.chanFootnoteCount(count);
  @override
  String get chanPageTitle =>
      overrides['chanPageTitle'] ?? base.chanPageTitle;
  @override
  String get chanPageSubtitle =>
      overrides['chanPageSubtitle'] ?? base.chanPageSubtitle;
  @override
  String get chanGuideText =>
      overrides['chanGuideText'] ?? base.chanGuideText;
  @override
  String get chanGuideAction =>
      overrides['chanGuideAction'] ?? base.chanGuideAction;
  @override
  String get chanGuideHint =>
      overrides['chanGuideHint'] ?? base.chanGuideHint;
  @override
  String get chanListHeader =>
      overrides['chanListHeader'] ?? base.chanListHeader;
  @override
  String get chanReloadAction =>
      overrides['chanReloadAction'] ?? base.chanReloadAction;
  @override
  String get chanConfigAction =>
      overrides['chanConfigAction'] ?? base.chanConfigAction;
  @override
  String get chanConfigUnavailable =>
      overrides['chanConfigUnavailable'] ?? base.chanConfigUnavailable;
  @override
  String get chanConfigUnavailableHint =>
      overrides['chanConfigUnavailableHint'] ?? base.chanConfigUnavailableHint;
  @override
  String get chanBackToList =>
      overrides['chanBackToList'] ?? base.chanBackToList;
  @override
  String get chanRecentActivity =>
      overrides['chanRecentActivity'] ?? base.chanRecentActivity;
  @override
  String get chanMentionTitle =>
      overrides['chanMentionTitle'] ?? base.chanMentionTitle;
  @override
  String get chanMentionNote =>
      overrides['chanMentionNote'] ?? base.chanMentionNote;
  @override
  String get chanMentionEmpty =>
      overrides['chanMentionEmpty'] ?? base.chanMentionEmpty;
  @override
  String get chanMentionHint =>
      overrides['chanMentionHint'] ?? base.chanMentionHint;
  @override
  String chanMentionSaveFailed(String problem) =>
      base.chanMentionSaveFailed(problem);
  @override
  String get chanMentionCleared =>
      overrides['chanMentionCleared'] ?? base.chanMentionCleared;
  @override
  String chanMentionSaved(String words) =>
      base.chanMentionSaved(words);
  @override
  String get chanContactsTitle =>
      overrides['chanContactsTitle'] ?? base.chanContactsTitle;
  @override
  String get chanContactsNote =>
      overrides['chanContactsNote'] ?? base.chanContactsNote;
  @override
  String get chanDetailsLabel =>
      overrides['chanDetailsLabel'] ?? base.chanDetailsLabel;
  @override
  String get chanContactsDetail =>
      overrides['chanContactsDetail'] ?? base.chanContactsDetail;
  @override
  String get chanContactsEmpty =>
      overrides['chanContactsEmpty'] ?? base.chanContactsEmpty;
  @override
  String get chanGroupSceneLabel =>
      overrides['chanGroupSceneLabel'] ?? base.chanGroupSceneLabel;
  @override
  String get chanGroupSceneHard =>
      overrides['chanGroupSceneHard'] ?? base.chanGroupSceneHard;
  @override
  String get chanGroupSceneSoft =>
      overrides['chanGroupSceneSoft'] ?? base.chanGroupSceneSoft;
  @override
  String get chanContactsRestartNote =>
      overrides['chanContactsRestartNote'] ?? base.chanContactsRestartNote;
  @override
  String chanContactLine(String chat, String when) =>
      base.chanContactLine(chat, when);
  @override
  String chanContactNote(String note) =>
      base.chanContactNote(note);
  @override
  String get chanContactHint =>
      overrides['chanContactHint'] ?? base.chanContactHint;
  @override
  String get chanContactSaveTooltip =>
      overrides['chanContactSaveTooltip'] ?? base.chanContactSaveTooltip;
  @override
  String get chanMembersCollapse =>
      overrides['chanMembersCollapse'] ?? base.chanMembersCollapse;
  @override
  String chanMembersExpand(int count) =>
      base.chanMembersExpand(count);
  @override
  String get chanWarnExempt =>
      overrides['chanWarnExempt'] ?? base.chanWarnExempt;
  @override
  String get chanWarnOn =>
      overrides['chanWarnOn'] ?? base.chanWarnOn;
  @override
  String get chanMemberSaveTooltip =>
      overrides['chanMemberSaveTooltip'] ?? base.chanMemberSaveTooltip;
  @override
  String chanMemberNameTooltip(String who) =>
      base.chanMemberNameTooltip(who);
  @override
  String get chanExemptSessionOn =>
      overrides['chanExemptSessionOn'] ?? base.chanExemptSessionOn;
  @override
  String get chanExemptSessionOff =>
      overrides['chanExemptSessionOff'] ?? base.chanExemptSessionOff;
  @override
  String get chanExemptMemberOn =>
      overrides['chanExemptMemberOn'] ?? base.chanExemptMemberOn;
  @override
  String get chanExemptMemberOff =>
      overrides['chanExemptMemberOff'] ?? base.chanExemptMemberOff;
  @override
  String get chanGroupSceneHardToast =>
      overrides['chanGroupSceneHardToast'] ?? base.chanGroupSceneHardToast;
  @override
  String get chanGroupSceneSoftToast =>
      overrides['chanGroupSceneSoftToast'] ?? base.chanGroupSceneSoftToast;
  @override
  String chanToggleFailed(String err) =>
      base.chanToggleFailed(err);
  @override
  String get chanNameRequired =>
      overrides['chanNameRequired'] ?? base.chanNameRequired;
  @override
  String chanMemberSaved(String name) =>
      base.chanMemberSaved(name);
  @override
  String get chanContactCleared =>
      overrides['chanContactCleared'] ?? base.chanContactCleared;
  @override
  String chanContactSaved(String name) =>
      base.chanContactSaved(name);
  @override
  String get chanConfigTitle =>
      overrides['chanConfigTitle'] ?? base.chanConfigTitle;
  @override
  String get chanNeedsRestart =>
      overrides['chanNeedsRestart'] ?? base.chanNeedsRestart;
  @override
  String get chanConfigNote =>
      overrides['chanConfigNote'] ?? base.chanConfigNote;
  @override
  String get chanConfigDetail =>
      overrides['chanConfigDetail'] ?? base.chanConfigDetail;
  @override
  String get chanTestAlert =>
      overrides['chanTestAlert'] ?? base.chanTestAlert;
  @override
  String chanSaveWithCount(int count) =>
      base.chanSaveWithCount(count);
  @override
  String get chanEnableLabel =>
      overrides['chanEnableLabel'] ?? base.chanEnableLabel;
  @override
  String get chanEnableNoteOn =>
      overrides['chanEnableNoteOn'] ?? base.chanEnableNoteOn;
  @override
  String get chanEnableNoteOff =>
      overrides['chanEnableNoteOff'] ?? base.chanEnableNoteOff;
  @override
  String get chanSecretHintConfigured =>
      overrides['chanSecretHintConfigured'] ?? base.chanSecretHintConfigured;
  @override
  String chanSecretHintPaste(String label) =>
      base.chanSecretHintPaste(label);
  @override
  String chanSecretConfigured(String mask) =>
      base.chanSecretConfigured(mask);
  @override
  String get chanNumberHint =>
      overrides['chanNumberHint'] ?? base.chanNumberHint;
  @override
  String get chanNotSetHint =>
      overrides['chanNotSetHint'] ?? base.chanNotSetHint;
  @override
  String chanReadonlyFold(int count) =>
      base.chanReadonlyFold(count);
  @override
  String get chanChannelIdLabel =>
      overrides['chanChannelIdLabel'] ?? base.chanChannelIdLabel;
  @override
  String get chanFeedEmpty =>
      overrides['chanFeedEmpty'] ?? base.chanFeedEmpty;
  @override
  String get chanSourceExternal =>
      overrides['chanSourceExternal'] ?? base.chanSourceExternal;
  @override
  String get chanEventGeneric =>
      overrides['chanEventGeneric'] ?? base.chanEventGeneric;
  @override
  String get chanJoinWords =>
      overrides['chanJoinWords'] ?? base.chanJoinWords;
  @override
  String get schedNotProjection =>
      overrides['schedNotProjection'] ?? base.schedNotProjection;
  @override
  String get schedCancelTitle =>
      overrides['schedCancelTitle'] ?? base.schedCancelTitle;
  @override
  String schedCancelBody(String timerId) =>
      base.schedCancelBody(timerId);
  @override
  String get schedCancelPlan =>
      overrides['schedCancelPlan'] ?? base.schedCancelPlan;
  @override
  String schedCancelled(String timerId) =>
      base.schedCancelled(timerId);
  @override
  String schedCancelFailed(String timerId, String err) =>
      base.schedCancelFailed(timerId, err);
  @override
  String schedCancelFailedShort(String err) =>
      base.schedCancelFailedShort(err);
  @override
  String schedBuilt(String when, String note) =>
      base.schedBuilt(when, note);
  @override
  String get schedBuiltToast =>
      overrides['schedBuiltToast'] ?? base.schedBuiltToast;
  @override
  String get schedNoServerTime =>
      overrides['schedNoServerTime'] ?? base.schedNoServerTime;
  @override
  String schedRecurringWithNext(String label, String when) =>
      base.schedRecurringWithNext(label, when);
  @override
  String get schedSearchTitle =>
      overrides['schedSearchTitle'] ?? base.schedSearchTitle;
  @override
  String get schedSearchHint =>
      overrides['schedSearchHint'] ?? base.schedSearchHint;
  @override
  String get schedSearch =>
      overrides['schedSearch'] ?? base.schedSearch;
  @override
  String get schedPageTitle =>
      overrides['schedPageTitle'] ?? base.schedPageTitle;
  @override
  String get schedPageSubtitle =>
      overrides['schedPageSubtitle'] ?? base.schedPageSubtitle;
  @override
  String get schedBackToThisWeek =>
      overrides['schedBackToThisWeek'] ?? base.schedBackToThisWeek;
  @override
  String get schedNewPlan =>
      overrides['schedNewPlan'] ?? base.schedNewPlan;
  @override
  String get schedLoading =>
      overrides['schedLoading'] ?? base.schedLoading;
  @override
  String schedLoadFailed(String error) =>
      base.schedLoadFailed(error);
  @override
  String get schedLoadHint =>
      overrides['schedLoadHint'] ?? base.schedLoadHint;
  @override
  String get schedStatThisWeek =>
      overrides['schedStatThisWeek'] ?? base.schedStatThisWeek;
  @override
  String get schedStatThisWeekNote =>
      overrides['schedStatThisWeekNote'] ?? base.schedStatThisWeekNote;
  @override
  String get schedStatWaiting =>
      overrides['schedStatWaiting'] ?? base.schedStatWaiting;
  @override
  String get schedStatWaitingNote =>
      overrides['schedStatWaitingNote'] ?? base.schedStatWaitingNote;
  @override
  String get schedStatSelfWork =>
      overrides['schedStatSelfWork'] ?? base.schedStatSelfWork;
  @override
  String get schedStatSelfWorkNote =>
      overrides['schedStatSelfWorkNote'] ?? base.schedStatSelfWorkNote;
  @override
  String get schedStatDrafts =>
      overrides['schedStatDrafts'] ?? base.schedStatDrafts;
  @override
  String get schedStatDraftsNote =>
      overrides['schedStatDraftsNote'] ?? base.schedStatDraftsNote;
  @override
  String get schedCalendarTitle =>
      overrides['schedCalendarTitle'] ?? base.schedCalendarTitle;
  @override
  String get schedPrevWeek =>
      overrides['schedPrevWeek'] ?? base.schedPrevWeek;
  @override
  String schedWeekRange(int month, int day, int endDay) =>
      base.schedWeekRange(month, day, endDay);
  @override
  String get schedNextWeek =>
      overrides['schedNextWeek'] ?? base.schedNextWeek;
  @override
  String schedUnplaceable(int count) =>
      base.schedUnplaceable(count);
  @override
  String schedTimeRecurring(String hour, String minute) =>
      base.schedTimeRecurring(hour, minute);
  @override
  String schedMonthDay(int month, int day) =>
      base.schedMonthDay(month, day);
  @override
  String get schedRecurringPill =>
      overrides['schedRecurringPill'] ?? base.schedRecurringPill;
  @override
  String get schedWeekEmpty =>
      overrides['schedWeekEmpty'] ?? base.schedWeekEmpty;
  @override
  String schedWeekHidden(int hidden) =>
      base.schedWeekHidden(hidden);
  @override
  String get schedListTitle =>
      overrides['schedListTitle'] ?? base.schedListTitle;
  @override
  String schedFilterDay(String day) =>
      base.schedFilterDay(day);
  @override
  String schedFilterQuery(String query) =>
      base.schedFilterQuery(query);
  @override
  String schedFilterCount(int count) =>
      base.schedFilterCount(count);
  @override
  String get schedShowAll =>
      overrides['schedShowAll'] ?? base.schedShowAll;
  @override
  String get schedClearSearch =>
      overrides['schedClearSearch'] ?? base.schedClearSearch;
  @override
  String get schedActionGoneHint =>
      overrides['schedActionGoneHint'] ?? base.schedActionGoneHint;
  @override
  String get schedListNoMatch =>
      overrides['schedListNoMatch'] ?? base.schedListNoMatch;
  @override
  String get schedListEmpty =>
      overrides['schedListEmpty'] ?? base.schedListEmpty;
  @override
  String get schedListEmptyHint =>
      overrides['schedListEmptyHint'] ?? base.schedListEmptyHint;
  @override
  String get schedDetailPlaceholder =>
      overrides['schedDetailPlaceholder'] ?? base.schedDetailPlaceholder;
  @override
  String get schedFieldWhen =>
      overrides['schedFieldWhen'] ?? base.schedFieldWhen;
  @override
  String schedDetailRecurring(String label) =>
      base.schedDetailRecurring(label);
  @override
  String schedDetailTimeSuffix(String label) =>
      base.schedDetailTimeSuffix(label);
  @override
  String get schedFieldWhy =>
      overrides['schedFieldWhy'] ?? base.schedFieldWhy;
  @override
  String get schedFieldWhat =>
      overrides['schedFieldWhat'] ?? base.schedFieldWhat;
  @override
  String get schedFieldWhere =>
      overrides['schedFieldWhere'] ?? base.schedFieldWhere;
  @override
  String get schedFieldDuration =>
      overrides['schedFieldDuration'] ?? base.schedFieldDuration;
  @override
  String schedMinutes(Object? dur) =>
      base.schedMinutes(dur);
  @override
  String schedMinutesDefault(Object? dur) =>
      base.schedMinutesDefault(dur);
  @override
  String get schedFieldAfter =>
      overrides['schedFieldAfter'] ?? base.schedFieldAfter;
  @override
  String get schedUnwritten =>
      overrides['schedUnwritten'] ?? base.schedUnwritten;
  @override
  String schedWakeReceipt(String text) =>
      base.schedWakeReceipt(text);
  @override
  String get schedSeeChat =>
      overrides['schedSeeChat'] ?? base.schedSeeChat;
  @override
  String schedBuiltReceipt(String text) =>
      base.schedBuiltReceipt(text);
  @override
  String get schedChoiceNotify =>
      overrides['schedChoiceNotify'] ?? base.schedChoiceNotify;
  @override
  String get schedChoiceSelf =>
      overrides['schedChoiceSelf'] ?? base.schedChoiceSelf;
  @override
  String get schedChoiceDraft =>
      overrides['schedChoiceDraft'] ?? base.schedChoiceDraft;
  @override
  String get schedKindMemoryMaintain =>
      overrides['schedKindMemoryMaintain'] ?? base.schedKindMemoryMaintain;
  @override
  String get schedKindWait =>
      overrides['schedKindWait'] ?? base.schedKindWait;
  @override
  String get schedUntitled =>
      overrides['schedUntitled'] ?? base.schedUntitled;
  @override
  String get schedStatusDraft =>
      overrides['schedStatusDraft'] ?? base.schedStatusDraft;
  @override
  String get schedStatusRecurring =>
      overrides['schedStatusRecurring'] ?? base.schedStatusRecurring;
  @override
  String get schedStatusWaiting =>
      overrides['schedStatusWaiting'] ?? base.schedStatusWaiting;
  @override
  String get schedWakeDeduped =>
      overrides['schedWakeDeduped'] ?? base.schedWakeDeduped;
  @override
  String get schedViewWeek =>
      overrides['schedViewWeek'] ?? base.schedViewWeek;
  @override
  String get schedViewList =>
      overrides['schedViewList'] ?? base.schedViewList;
  @override
  String schedRecurringLine(String label) =>
      base.schedRecurringLine(label);
  @override
  String get schedChorePill =>
      overrides['schedChorePill'] ?? base.schedChorePill;
  @override
  String schedWillSay(String label) =>
      base.schedWillSay(label);
  @override
  String get schedErrDate =>
      overrides['schedErrDate'] ?? base.schedErrDate;
  @override
  String get schedErrClock =>
      overrides['schedErrClock'] ?? base.schedErrClock;
  @override
  String get schedErrWhat =>
      overrides['schedErrWhat'] ?? base.schedErrWhat;
  @override
  String get schedErrDuration =>
      overrides['schedErrDuration'] ?? base.schedErrDuration;
  @override
  String get schedRepeatDaily =>
      overrides['schedRepeatDaily'] ?? base.schedRepeatDaily;
  @override
  String get schedRepeatWeekly =>
      overrides['schedRepeatWeekly'] ?? base.schedRepeatWeekly;
  @override
  String get schedErrBrief =>
      overrides['schedErrBrief'] ?? base.schedErrBrief;
  @override
  String schedWakePrefix(String text) =>
      base.schedWakePrefix(text);
  @override
  String schedWakeFailed(String err) =>
      base.schedWakeFailed(err);
  @override
  String schedCreateFailed(String err) =>
      base.schedCreateFailed(err);
  @override
  String get schedCardLead =>
      overrides['schedCardLead'] ?? base.schedCardLead;
  @override
  String get schedPathHer =>
      overrides['schedPathHer'] ?? base.schedPathHer;
  @override
  String get schedPathDirect =>
      overrides['schedPathDirect'] ?? base.schedPathDirect;
  @override
  String get schedLater =>
      overrides['schedLater'] ?? base.schedLater;
  @override
  String get schedSending =>
      overrides['schedSending'] ?? base.schedSending;
  @override
  String get schedCreateDirect =>
      overrides['schedCreateDirect'] ?? base.schedCreateDirect;
  @override
  String get schedLetHerSchedule =>
      overrides['schedLetHerSchedule'] ?? base.schedLetHerSchedule;
  @override
  String get schedFieldBrief =>
      overrides['schedFieldBrief'] ?? base.schedFieldBrief;
  @override
  String get schedBriefHint =>
      overrides['schedBriefHint'] ?? base.schedBriefHint;
  @override
  String get schedBriefNote =>
      overrides['schedBriefNote'] ?? base.schedBriefNote;
  @override
  String get schedFieldDay =>
      overrides['schedFieldDay'] ?? base.schedFieldDay;
  @override
  String get schedDayHint =>
      overrides['schedDayHint'] ?? base.schedDayHint;
  @override
  String get schedFieldClock =>
      overrides['schedFieldClock'] ?? base.schedFieldClock;
  @override
  String get schedFieldRepeat =>
      overrides['schedFieldRepeat'] ?? base.schedFieldRepeat;
  @override
  String get schedRepeatOnceChoice =>
      overrides['schedRepeatOnceChoice'] ?? base.schedRepeatOnceChoice;
  @override
  String get schedRepeatWeeklyChoice =>
      overrides['schedRepeatWeeklyChoice'] ?? base.schedRepeatWeeklyChoice;
  @override
  String get schedFieldWhatToDo =>
      overrides['schedFieldWhatToDo'] ?? base.schedFieldWhatToDo;
  @override
  String get schedWhatHint =>
      overrides['schedWhatHint'] ?? base.schedWhatHint;
  @override
  String get schedMoreOptions =>
      overrides['schedMoreOptions'] ?? base.schedMoreOptions;
  @override
  String get schedFieldTitle =>
      overrides['schedFieldTitle'] ?? base.schedFieldTitle;
  @override
  String get schedTitleHint =>
      overrides['schedTitleHint'] ?? base.schedTitleHint;
  @override
  String get schedFieldWhyInput =>
      overrides['schedFieldWhyInput'] ?? base.schedFieldWhyInput;
  @override
  String get schedWhyHint =>
      overrides['schedWhyHint'] ?? base.schedWhyHint;
  @override
  String get schedFieldDurationInput =>
      overrides['schedFieldDurationInput'] ?? base.schedFieldDurationInput;
  @override
  String get schedFieldCategory =>
      overrides['schedFieldCategory'] ?? base.schedFieldCategory;
  @override
  String get schedNoCategory =>
      overrides['schedNoCategory'] ?? base.schedNoCategory;
  @override
  String get schedFieldSid =>
      overrides['schedFieldSid'] ?? base.schedFieldSid;
  @override
  String get schedNoSid =>
      overrides['schedNoSid'] ?? base.schedNoSid;
  @override
  String get schedPastWarning =>
      overrides['schedPastWarning'] ?? base.schedPastWarning;
  @override
  String get schedCreateNote =>
      overrides['schedCreateNote'] ?? base.schedCreateNote;
  @override
  String schedSidWithName(String name, String short) =>
      base.schedSidWithName(name, short);
  @override
  String schedMonthDayRaw(Object month, Object day) =>
      base.schedMonthDayRaw(month, day);
  @override
  String schedWhenStamp(int month, int day, String time) =>
      base.schedWhenStamp(month, day, time);
  @override
  String get schedWeekdayMon =>
      overrides['schedWeekdayMon'] ?? base.schedWeekdayMon;
  @override
  String get schedWeekdayTue =>
      overrides['schedWeekdayTue'] ?? base.schedWeekdayTue;
  @override
  String get schedWeekdayWed =>
      overrides['schedWeekdayWed'] ?? base.schedWeekdayWed;
  @override
  String get schedWeekdayThu =>
      overrides['schedWeekdayThu'] ?? base.schedWeekdayThu;
  @override
  String get schedWeekdayFri =>
      overrides['schedWeekdayFri'] ?? base.schedWeekdayFri;
  @override
  String get schedWeekdaySat =>
      overrides['schedWeekdaySat'] ?? base.schedWeekdaySat;
  @override
  String get schedWeekdaySun =>
      overrides['schedWeekdaySun'] ?? base.schedWeekdaySun;
  @override
  String schedCronDaily(String time) =>
      base.schedCronDaily(time);
  @override
  String schedCronRange(String from, String to) =>
      base.schedCronRange(from, to);
  @override
  String schedCronWeekly(String weekdays, String time) =>
      base.schedCronWeekly(weekdays, time);
  @override
  String get schedCatWork =>
      overrides['schedCatWork'] ?? base.schedCatWork;
  @override
  String get schedCatPersonal =>
      overrides['schedCatPersonal'] ?? base.schedCatPersonal;
  @override
  String get schedCatLife =>
      overrides['schedCatLife'] ?? base.schedCatLife;
  @override
  String get schedCatRoutine =>
      overrides['schedCatRoutine'] ?? base.schedCatRoutine;
  @override
  String get schedActionSelf =>
      overrides['schedActionSelf'] ?? base.schedActionSelf;
  @override
  String get schedActionNotify =>
      overrides['schedActionNotify'] ?? base.schedActionNotify;
  @override
  String get schedActionDraft =>
      overrides['schedActionDraft'] ?? base.schedActionDraft;
  @override
  String get extSectionSkills =>
      overrides['extSectionSkills'] ?? base.extSectionSkills;
  @override
  String get extSectionSkillsBlurb =>
      overrides['extSectionSkillsBlurb'] ?? base.extSectionSkillsBlurb;
  @override
  String get extSectionMcpBlurb =>
      overrides['extSectionMcpBlurb'] ?? base.extSectionMcpBlurb;
  @override
  String get extSectionTools =>
      overrides['extSectionTools'] ?? base.extSectionTools;
  @override
  String get extSectionToolsBlurb =>
      overrides['extSectionToolsBlurb'] ?? base.extSectionToolsBlurb;
  @override
  String get extSectionHooksBlurb =>
      overrides['extSectionHooksBlurb'] ?? base.extSectionHooksBlurb;
  @override
  String get extBadResponse =>
      overrides['extBadResponse'] ?? base.extBadResponse;
  @override
  String get extPageSubtitle =>
      overrides['extPageSubtitle'] ?? base.extPageSubtitle;
  @override
  String get extListHeader =>
      overrides['extListHeader'] ?? base.extListHeader;
  @override
  String get extDataReadFailed =>
      overrides['extDataReadFailed'] ?? base.extDataReadFailed;
  @override
  String extBadStructure(Object? endpoint) =>
      base.extBadStructure(endpoint);
  @override
  String get extBackToList =>
      overrides['extBackToList'] ?? base.extBackToList;
  @override
  String get extRescan =>
      overrides['extRescan'] ?? base.extRescan;
  @override
  String get extNewSkill =>
      overrides['extNewSkill'] ?? base.extNewSkill;
  @override
  String extSkillsSummary(int active, int pending, int tokens) =>
      base.extSkillsSummary(active, pending, tokens);
  @override
  String get extNoSkills =>
      overrides['extNoSkills'] ?? base.extNoSkills;
  @override
  String get extNoSkillsHint =>
      overrides['extNoSkillsHint'] ?? base.extNoSkillsHint;
  @override
  String get extPendingTitle =>
      overrides['extPendingTitle'] ?? base.extPendingTitle;
  @override
  String get extPendingHint =>
      overrides['extPendingHint'] ?? base.extPendingHint;
  @override
  String get extActiveTitle =>
      overrides['extActiveTitle'] ?? base.extActiveTitle;
  @override
  String get extActiveHint =>
      overrides['extActiveHint'] ?? base.extActiveHint;
  @override
  String get extActiveEmpty =>
      overrides['extActiveEmpty'] ?? base.extActiveEmpty;
  @override
  String get extIgnoredTitle =>
      overrides['extIgnoredTitle'] ?? base.extIgnoredTitle;
  @override
  String get extIgnoredHint =>
      overrides['extIgnoredHint'] ?? base.extIgnoredHint;
  @override
  String get extRejectedTitle =>
      overrides['extRejectedTitle'] ?? base.extRejectedTitle;
  @override
  String get extRejectedHint =>
      overrides['extRejectedHint'] ?? base.extRejectedHint;
  @override
  String extRejectedLine(Object? dir, Object? reason) =>
      base.extRejectedLine(dir, reason);
  @override
  String get extGuideSkillPath =>
      overrides['extGuideSkillPath'] ?? base.extGuideSkillPath;
  @override
  String get extGuideSkillTrust =>
      overrides['extGuideSkillTrust'] ?? base.extGuideSkillTrust;
  @override
  String get extInCatalogBadge =>
      overrides['extInCatalogBadge'] ?? base.extInCatalogBadge;
  @override
  String get extFieldDescription =>
      overrides['extFieldDescription'] ?? base.extFieldDescription;
  @override
  String get extFieldSkillFile =>
      overrides['extFieldSkillFile'] ?? base.extFieldSkillFile;
  @override
  String get extFieldSizeHash =>
      overrides['extFieldSizeHash'] ?? base.extFieldSizeHash;
  @override
  String extSizeHash(int bytes, String short) =>
      base.extSizeHash(bytes, short);
  @override
  String get extFieldTrustDetail =>
      overrides['extFieldTrustDetail'] ?? base.extFieldTrustDetail;
  @override
  String get extActionRestore =>
      overrides['extActionRestore'] ?? base.extActionRestore;
  @override
  String get extActionRetire =>
      overrides['extActionRetire'] ?? base.extActionRetire;
  @override
  String get extActionDelete =>
      overrides['extActionDelete'] ?? base.extActionDelete;
  @override
  String get extActionConfirm =>
      overrides['extActionConfirm'] ?? base.extActionConfirm;
  @override
  String get extActionIgnore =>
      overrides['extActionIgnore'] ?? base.extActionIgnore;
  @override
  String extConfirmedToast(String name) =>
      base.extConfirmedToast(name);
  @override
  String extConfirmFailed(String reason) =>
      base.extConfirmFailed(reason);
  @override
  String extIgnoredToast(String name) =>
      base.extIgnoredToast(name);
  @override
  String extRestoredToast(String name) =>
      base.extRestoredToast(name);
  @override
  String extOpFailed(String reason) =>
      base.extOpFailed(reason);
  @override
  String extRetireTitle(String name) =>
      base.extRetireTitle(name);
  @override
  String get extRetireBody =>
      overrides['extRetireBody'] ?? base.extRetireBody;
  @override
  String get extDisable =>
      overrides['extDisable'] ?? base.extDisable;
  @override
  String extDeleteSkillTitle(String name) =>
      base.extDeleteSkillTitle(name);
  @override
  String get extDeleteBody =>
      overrides['extDeleteBody'] ?? base.extDeleteBody;
  @override
  String get extDelete =>
      overrides['extDelete'] ?? base.extDelete;
  @override
  String extDeletedToast(String name) =>
      base.extDeletedToast(name);
  @override
  String extDeleteFailed(String reason) =>
      base.extDeleteFailed(reason);
  @override
  String get extCreateHint =>
      overrides['extCreateHint'] ?? base.extCreateHint;
  @override
  String get extFieldSkillName =>
      overrides['extFieldSkillName'] ?? base.extFieldSkillName;
  @override
  String get extSkillNameHint =>
      overrides['extSkillNameHint'] ?? base.extSkillNameHint;
  @override
  String get extSkillNameInvalid =>
      overrides['extSkillNameInvalid'] ?? base.extSkillNameInvalid;
  @override
  String get extFieldOneLineDesc =>
      overrides['extFieldOneLineDesc'] ?? base.extFieldOneLineDesc;
  @override
  String get extOneLineDescHint =>
      overrides['extOneLineDescHint'] ?? base.extOneLineDescHint;
  @override
  String extSkillCreatedToast(String path) =>
      base.extSkillCreatedToast(path);
  @override
  String extCreateSkillFailed(String reason) =>
      base.extCreateSkillFailed(reason);
  @override
  String get extAddServer =>
      overrides['extAddServer'] ?? base.extAddServer;
  @override
  String extMcpSummary(int servers, int running, int tools, String pendingPart) =>
      base.extMcpSummary(servers, running, tools, pendingPart);
  @override
  String extPendingGrants(int count) =>
      base.extPendingGrants(count);
  @override
  String extUnpreparedGrants(int count) =>
      base.extUnpreparedGrants(count);
  @override
  String get extUnpreparedTitle =>
      overrides['extUnpreparedTitle'] ?? base.extUnpreparedTitle;
  @override
  String get extUnpreparedHint =>
      overrides['extUnpreparedHint'] ?? base.extUnpreparedHint;
  @override
  String get extConfigProblems =>
      overrides['extConfigProblems'] ?? base.extConfigProblems;
  @override
  String get extConfigProblemsHint =>
      overrides['extConfigProblemsHint'] ?? base.extConfigProblemsHint;
  @override
  String get extAnsweredTitle =>
      overrides['extAnsweredTitle'] ?? base.extAnsweredTitle;
  @override
  String get extAnsweredHint =>
      overrides['extAnsweredHint'] ?? base.extAnsweredHint;
  @override
  String get extGuideMcp1 =>
      overrides['extGuideMcp1'] ?? base.extGuideMcp1;
  @override
  String get extGuideMcp2 =>
      overrides['extGuideMcp2'] ?? base.extGuideMcp2;
  @override
  String get extGuideMcp3 =>
      overrides['extGuideMcp3'] ?? base.extGuideMcp3;
  @override
  String extGrantRejectedToast(String suffix) =>
      base.extGrantRejectedToast(suffix);
  @override
  String extGrantApprovedToast(String suffix) =>
      base.extGrantApprovedToast(suffix);
  @override
  String extGrantApprovedFailedToast(String failure) =>
      base.extGrantApprovedFailedToast(failure);
  @override
  String extGrantDecideFailed(String reason) =>
      base.extGrantDecideFailed(reason);
  @override
  String get extGrantAfterSkillInstall =>
      overrides['extGrantAfterSkillInstall'] ?? base.extGrantAfterSkillInstall;
  @override
  String get extGrantAfterSkillRemove =>
      overrides['extGrantAfterSkillRemove'] ?? base.extGrantAfterSkillRemove;
  @override
  String get extGrantExecOkSkillInstall =>
      overrides['extGrantExecOkSkillInstall'] ?? base.extGrantExecOkSkillInstall;
  @override
  String get extGrantExecOkSkillRemove =>
      overrides['extGrantExecOkSkillRemove'] ?? base.extGrantExecOkSkillRemove;
  @override
  String get extGrantLabelSkillInstall =>
      overrides['extGrantLabelSkillInstall'] ?? base.extGrantLabelSkillInstall;
  @override
  String grantInboxActionMcpAdd(String name) => base.grantInboxActionMcpAdd(name);
  @override
  String grantInboxActionMcpRemove(String name) => base.grantInboxActionMcpRemove(name);
  @override
  String grantInboxActionSkillInstall(String name) => base.grantInboxActionSkillInstall(name);
  @override
  String grantInboxActionSkillRemove(String name) => base.grantInboxActionSkillRemove(name);
  @override
  String grantInboxActionUnknown(String name) => base.grantInboxActionUnknown(name);
  @override
  String grantInboxCommand(String command) => base.grantInboxCommand(command);
  @override
  String grantInboxRiskSkillScripts(int count) => base.grantInboxRiskSkillScripts(count);
  @override
  String get grantInboxRiskSkillInstall =>
      overrides['grantInboxRiskSkillInstall'] ?? base.grantInboxRiskSkillInstall;
  @override
  String get grantInboxRiskSkillRemove =>
      overrides['grantInboxRiskSkillRemove'] ?? base.grantInboxRiskSkillRemove;
  @override
  String get grantInboxRiskMcpAdd =>
      overrides['grantInboxRiskMcpAdd'] ?? base.grantInboxRiskMcpAdd;
  @override
  String get grantInboxRiskMcpRemove =>
      overrides['grantInboxRiskMcpRemove'] ?? base.grantInboxRiskMcpRemove;
  @override
  String get grantInboxRiskUnknown =>
      overrides['grantInboxRiskUnknown'] ?? base.grantInboxRiskUnknown;
  @override
  String get grantInboxSource => overrides['grantInboxSource'] ?? base.grantInboxSource;
  @override
  String get grantInboxHighRiskBadge =>
      overrides['grantInboxHighRiskBadge'] ?? base.grantInboxHighRiskBadge;
  @override
  String get grantInboxApprove => overrides['grantInboxApprove'] ?? base.grantInboxApprove;
  @override
  String get grantInboxApproveHighRisk =>
      overrides['grantInboxApproveHighRisk'] ?? base.grantInboxApproveHighRisk;
  @override
  String get grantInboxReject => overrides['grantInboxReject'] ?? base.grantInboxReject;
  @override
  String get grantInboxDetails => overrides['grantInboxDetails'] ?? base.grantInboxDetails;
  @override
  String get grantInboxWorking => overrides['grantInboxWorking'] ?? base.grantInboxWorking;
  @override
  String get grantInboxCollapseTooltip =>
      overrides['grantInboxCollapseTooltip'] ?? base.grantInboxCollapseTooltip;
  @override
  String get grantInboxExpandTooltip =>
      overrides['grantInboxExpandTooltip'] ?? base.grantInboxExpandTooltip;
  @override
  String get grantInboxOpenExtensions =>
      overrides['grantInboxOpenExtensions'] ?? base.grantInboxOpenExtensions;
  @override
  String get grantInboxDetailsClose =>
      overrides['grantInboxDetailsClose'] ?? base.grantInboxDetailsClose;
  @override
  String grantInboxHeader(int count) => base.grantInboxHeader(count);
  @override
  String grantInboxMore(int count) => base.grantInboxMore(count);
  @override
  String grantInboxCollapsed(int count) => base.grantInboxCollapsed(count);
  @override
  String grantInboxFailed(String reason) => base.grantInboxFailed(reason);
  @override
  String get grantUnreadableTitle =>
      overrides['grantUnreadableTitle'] ?? base.grantUnreadableTitle;
  @override
  // 带参句子不参与覆盖（覆盖文件里没有参数位置，见文件头边界 1）
  String grantUnreadableBody(String id, String why) => base.grantUnreadableBody(id, why);
  @override
  String grantUnreadableMore(int count) => base.grantUnreadableMore(count);
  @override
  String trayPendingItem(int count) => base.trayPendingItem(count);
  @override
  String trayPendingTooltip(String name, int count) => base.trayPendingTooltip(name, count);
  @override
  String get extNoServers =>
      overrides['extNoServers'] ?? base.extNoServers;
  @override
  String get extNoServersHint1 =>
      overrides['extNoServersHint1'] ?? base.extNoServersHint1;
  @override
  String get extNoServersHint2 =>
      overrides['extNoServersHint2'] ?? base.extNoServersHint2;
  @override
  String get extDisabledBadge =>
      overrides['extDisabledBadge'] ?? base.extDisabledBadge;
  @override
  String extToolCountBadge(int count) =>
      base.extToolCountBadge(count);
  @override
  String get extCollapseServer =>
      overrides['extCollapseServer'] ?? base.extCollapseServer;
  @override
  String get extExpandServer =>
      overrides['extExpandServer'] ?? base.extExpandServer;
  @override
  String get extNoDesc =>
      overrides['extNoDesc'] ?? base.extNoDesc;
  @override
  String extSelfReportedDesc(String desc) =>
      base.extSelfReportedDesc(desc);
  @override
  String get extFieldCommand =>
      overrides['extFieldCommand'] ?? base.extFieldCommand;
  @override
  String get extFieldEnv =>
      overrides['extFieldEnv'] ?? base.extFieldEnv;
  @override
  String extLastRun(String at, String suffix) =>
      base.extLastRun(at, suffix);
  @override
  String extPidLine(Object? pid) =>
      base.extPidLine(pid);
  @override
  String get extStartingProcess =>
      overrides['extStartingProcess'] ?? base.extStartingProcess;
  @override
  String get extTestConnection =>
      overrides['extTestConnection'] ?? base.extTestConnection;
  @override
  String get extEditServerTooltip =>
      overrides['extEditServerTooltip'] ?? base.extEditServerTooltip;
  @override
  String get extDeleteServerTooltip =>
      overrides['extDeleteServerTooltip'] ?? base.extDeleteServerTooltip;
  @override
  String get extNoToolDesc =>
      overrides['extNoToolDesc'] ?? base.extNoToolDesc;
  @override
  String extToolsAllListed(int count) =>
      base.extToolsAllListed(count);
  @override
  String get extNoChange =>
      overrides['extNoChange'] ?? base.extNoChange;
  @override
  String get extTakeEffectNow =>
      overrides['extTakeEffectNow'] ?? base.extTakeEffectNow;
  @override
  String get extNeedsRestart =>
      overrides['extNeedsRestart'] ?? base.extNeedsRestart;
  @override
  String extMcpToggledToast(String name, String action, String outcome) =>
      base.extMcpToggledToast(name, action, outcome);
  @override
  String extToggleFailed(String reason) =>
      base.extToggleFailed(reason);
  @override
  String get extEditMcpTitle =>
      overrides['extEditMcpTitle'] ?? base.extEditMcpTitle;
  @override
  String get extAddMcpTitle =>
      overrides['extAddMcpTitle'] ?? base.extAddMcpTitle;
  @override
  String get extMcpFormLead =>
      overrides['extMcpFormLead'] ?? base.extMcpFormLead;
  @override
  String get extFieldServerName =>
      overrides['extFieldServerName'] ?? base.extFieldServerName;
  @override
  String get extServerNameHint =>
      overrides['extServerNameHint'] ?? base.extServerNameHint;
  @override
  String get extCommandHint =>
      overrides['extCommandHint'] ?? base.extCommandHint;
  @override
  String get extFieldDesc =>
      overrides['extFieldDesc'] ?? base.extFieldDesc;
  @override
  String get extDescHint =>
      overrides['extDescHint'] ?? base.extDescHint;
  @override
  String get extDescNote =>
      overrides['extDescNote'] ?? base.extDescNote;
  @override
  String get extFieldArgs =>
      overrides['extFieldArgs'] ?? base.extFieldArgs;
  @override
  String get extArgsHint =>
      overrides['extArgsHint'] ?? base.extArgsHint;
  @override
  String get extFieldEnvForm =>
      overrides['extFieldEnvForm'] ?? base.extFieldEnvForm;
  @override
  String get extEnvHint =>
      overrides['extEnvHint'] ?? base.extEnvHint;
  @override
  String get extFieldTestTimeout =>
      overrides['extFieldTestTimeout'] ?? base.extFieldTestTimeout;
  @override
  String get extTestTimeoutHint =>
      overrides['extTestTimeoutHint'] ?? base.extTestTimeoutHint;
  @override
  String get extEnableSwitchLabel =>
      overrides['extEnableSwitchLabel'] ?? base.extEnableSwitchLabel;
  @override
  String get extNameAndCommandRequired =>
      overrides['extNameAndCommandRequired'] ?? base.extNameAndCommandRequired;
  @override
  String extSaveFailed(String reason) =>
      base.extSaveFailed(reason);
  @override
  String extMcpSavedToast(String saved, String outcome, String note) =>
      base.extMcpSavedToast(saved, outcome, note);
  @override
  String get extFillCommandFirst =>
      overrides['extFillCommandFirst'] ?? base.extFillCommandFirst;
  @override
  String extTestFailed(String reason) =>
      base.extTestFailed(reason);
  @override
  String get extConnectOk =>
      overrides['extConnectOk'] ?? base.extConnectOk;
  @override
  String get extConnectFailed =>
      overrides['extConnectFailed'] ?? base.extConnectFailed;
  @override
  String extProbeOk(Object? name, Object? ms) =>
      base.extProbeOk(name, ms);
  @override
  String get extProbeNoTools =>
      overrides['extProbeNoTools'] ?? base.extProbeNoTools;
  @override
  String extProtocolLine(String version, String peer) =>
      base.extProtocolLine(version, peer);
  @override
  String extProbeShutdown(String stages) =>
      base.extProbeShutdown(stages);
  @override
  String get extUnknownReason =>
      overrides['extUnknownReason'] ?? base.extUnknownReason;
  @override
  String extStderrTail(Object? tail) =>
      base.extStderrTail(tail);
  @override
  String get extGotIt =>
      overrides['extGotIt'] ?? base.extGotIt;
  @override
  String extDeleteServerTitle(String name) =>
      base.extDeleteServerTitle(name);
  @override
  String get extDeleteServerBody =>
      overrides['extDeleteServerBody'] ?? base.extDeleteServerBody;
  @override
  String extServerDeletedToast(String name, String outcome) =>
      base.extServerDeletedToast(name, outcome);
  @override
  String get extNoToolRegistry =>
      overrides['extNoToolRegistry'] ?? base.extNoToolRegistry;
  @override
  String get extNoToolRegistryHint =>
      overrides['extNoToolRegistryHint'] ?? base.extNoToolRegistryHint;
  @override
  String get extRefresh =>
      overrides['extRefresh'] ?? base.extRefresh;
  @override
  String extToolsSummary(Object? enabled, int total, Object? policy) =>
      base.extToolsSummary(enabled, total, policy);
  @override
  String get extToolsHint1 =>
      overrides['extToolsHint1'] ?? base.extToolsHint1;
  @override
  String get extToolsHint2 =>
      overrides['extToolsHint2'] ?? base.extToolsHint2;
  @override
  String extGroupSummary(int on, int total, String note) =>
      base.extGroupSummary(on, total, note);
  @override
  String get extEnableAll =>
      overrides['extEnableAll'] ?? base.extEnableAll;
  @override
  String get extDisableAll =>
      overrides['extDisableAll'] ?? base.extDisableAll;
  @override
  String get extOffBadge =>
      overrides['extOffBadge'] ?? base.extOffBadge;
  @override
  String get extFieldMode =>
      overrides['extFieldMode'] ?? base.extFieldMode;
  @override
  String get extFieldTimeout =>
      overrides['extFieldTimeout'] ?? base.extFieldTimeout;
  @override
  String get extToggleOffMessage =>
      overrides['extToggleOffMessage'] ?? base.extToggleOffMessage;
  @override
  String get extToggleOnMessage =>
      overrides['extToggleOnMessage'] ?? base.extToggleOnMessage;
  @override
  String extToolFailureLine(String name, String reason) =>
      base.extToolFailureLine(name, reason);
  @override
  String extAllToggledToast(String state, int count) =>
      base.extAllToggledToast(state, count);
  @override
  String extSomeFailedToast(int count, String first) =>
      base.extSomeFailedToast(count, first);
  @override
  String extRequiredParam(Object? name) =>
      base.extRequiredParam(name);
  @override
  String get extAddHook =>
      overrides['extAddHook'] ?? base.extAddHook;
  @override
  String extHookBoundaryNote(String relative) =>
      base.extHookBoundaryNote(relative);
  @override
  String extHooksSummary(int enabled, int total) =>
      base.extHooksSummary(enabled, total);
  @override
  String get extHooksTitle =>
      overrides['extHooksTitle'] ?? base.extHooksTitle;
  @override
  String get extHooksHint =>
      overrides['extHooksHint'] ?? base.extHooksHint;
  @override
  String get extHooksEmpty =>
      overrides['extHooksEmpty'] ?? base.extHooksEmpty;
  @override
  String get extInvalidEntries =>
      overrides['extInvalidEntries'] ?? base.extInvalidEntries;
  @override
  String get extInvalidEntriesHint =>
      overrides['extInvalidEntriesHint'] ?? base.extInvalidEntriesHint;
  @override
  String get extHookBoundary1 =>
      overrides['extHookBoundary1'] ?? base.extHookBoundary1;
  @override
  String get extHookBoundary2 =>
      overrides['extHookBoundary2'] ?? base.extHookBoundary2;
  @override
  String get extFieldEvent =>
      overrides['extFieldEvent'] ?? base.extFieldEvent;
  @override
  String get extFieldCondition =>
      overrides['extFieldCondition'] ?? base.extFieldCondition;
  @override
  String get extHookToggleOffMessage =>
      overrides['extHookToggleOffMessage'] ?? base.extHookToggleOffMessage;
  @override
  String get extHookToggleOnMessage =>
      overrides['extHookToggleOnMessage'] ?? base.extHookToggleOnMessage;
  @override
  String get extEditHookTooltip =>
      overrides['extEditHookTooltip'] ?? base.extEditHookTooltip;
  @override
  String get extDeleteHookTooltip =>
      overrides['extDeleteHookTooltip'] ?? base.extDeleteHookTooltip;
  @override
  String extHookToggledToast(String state) =>
      base.extHookToggledToast(state);
  @override
  String get extEditHookTitle =>
      overrides['extEditHookTitle'] ?? base.extEditHookTitle;
  @override
  String get extHookDialogNote =>
      overrides['extHookDialogNote'] ?? base.extHookDialogNote;
  @override
  String get extFieldExecutionPoint =>
      overrides['extFieldExecutionPoint'] ?? base.extFieldExecutionPoint;
  @override
  String get extFieldMatcher =>
      overrides['extFieldMatcher'] ?? base.extFieldMatcher;
  @override
  String get extWakeMatcherHint =>
      overrides['extWakeMatcherHint'] ?? base.extWakeMatcherHint;
  @override
  String get extToolMatcherHint =>
      overrides['extToolMatcherHint'] ?? base.extToolMatcherHint;
  @override
  String get extFieldShellCommand =>
      overrides['extFieldShellCommand'] ?? base.extFieldShellCommand;
  @override
  String get extShellCommandHint =>
      overrides['extShellCommandHint'] ?? base.extShellCommandHint;
  @override
  String get extFieldConditionOptional =>
      overrides['extFieldConditionOptional'] ?? base.extFieldConditionOptional;
  @override
  String get extConditionHint =>
      overrides['extConditionHint'] ?? base.extConditionHint;
  @override
  String get extFieldTimeoutMs =>
      overrides['extFieldTimeoutMs'] ?? base.extFieldTimeoutMs;
  @override
  String get extTimeoutHint =>
      overrides['extTimeoutHint'] ?? base.extTimeoutHint;
  @override
  String get extEnableHookSwitch =>
      overrides['extEnableHookSwitch'] ?? base.extEnableHookSwitch;
  @override
  String get extMatcherAndCommandRequired =>
      overrides['extMatcherAndCommandRequired'] ?? base.extMatcherAndCommandRequired;
  @override
  String get extHookSavedToast =>
      overrides['extHookSavedToast'] ?? base.extHookSavedToast;
  @override
  String extDeleteHookBody(int index) =>
      base.extDeleteHookBody(index);
  @override
  String get extHookDeletedToast =>
      overrides['extHookDeletedToast'] ?? base.extHookDeletedToast;
  @override
  String get extStatusUnknown =>
      overrides['extStatusUnknown'] ?? base.extStatusUnknown;
  @override
  String get extReading =>
      overrides['extReading'] ?? base.extReading;
  @override
  String extStatSkills(int active, int pending) =>
      base.extStatSkills(active, pending);
  @override
  String extStatMcp(int servers, int running) =>
      base.extStatMcp(servers, running);
  @override
  String extStatTools(int on, int total) =>
      base.extStatTools(on, total);
  @override
  String extStatHooks(int total, String suffix) =>
      base.extStatHooks(total, suffix);
  @override
  String extPendingPart(int count) =>
      base.extPendingPart(count);
  @override
  String get extNoReasonGiven =>
      overrides['extNoReasonGiven'] ?? base.extNoReasonGiven;
  @override
  String get extRestartSuffix =>
      overrides['extRestartSuffix'] ?? base.extRestartSuffix;
  @override
  String get extServerNoReason =>
      overrides['extServerNoReason'] ?? base.extServerNoReason;
  @override
  String extReasonParen(String reason) =>
      base.extReasonParen(reason);
  @override
  String get extEnabledWord =>
      overrides['extEnabledWord'] ?? base.extEnabledWord;
  @override
  String extSavedWho(String who) =>
      base.extSavedWho(who);
  @override
  String extSavedWhoDisabled(String who) =>
      base.extSavedWhoDisabled(who);
  @override
  String extIndentedNote(String descNote) =>
      base.extIndentedNote(descNote);
  @override
  String extPeerVersion(Object? name, Object? version) =>
      base.extPeerVersion(name, version);
  @override
  String get extAllOnWord =>
      overrides['extAllOnWord'] ?? base.extAllOnWord;
  @override
  String get extAllOffWord =>
      overrides['extAllOffWord'] ?? base.extAllOffWord;
  @override
  String extEnabledPart(int on) =>
      base.extEnabledPart(on);
  @override
  String get extDisabledWord =>
      overrides['extDisabledWord'] ?? base.extDisabledWord;

  // ── 更新检查（2026-10-22）──

  @override
  String get updateView =>
      overrides['updateView'] ?? base.updateView;
  @override
  String get updateDismiss =>
      overrides['updateDismiss'] ?? base.updateDismiss;
  @override
  String get updateSectionTitle =>
      overrides['updateSectionTitle'] ?? base.updateSectionTitle;
  @override
  String get updateSectionNote =>
      overrides['updateSectionNote'] ?? base.updateSectionNote;
  @override
  String get updateCheckNow =>
      overrides['updateCheckNow'] ?? base.updateCheckNow;
  @override
  String get updateChecking =>
      overrides['updateChecking'] ?? base.updateChecking;
  @override
  String get updateUpToDate =>
      overrides['updateUpToDate'] ?? base.updateUpToDate;
  @override
  String get updateDisabled =>
      overrides['updateDisabled'] ?? base.updateDisabled;
  @override
  String get updateNeverChecked =>
      overrides['updateNeverChecked'] ?? base.updateNeverChecked;
  @override
  String get updateNoPage =>
      overrides['updateNoPage'] ?? base.updateNoPage;
  @override
  String updateBannerAvailable(String latest, String current) =>
      base.updateBannerAvailable(latest, current);
  @override
  String updateBannerRequired(String latest, String current) =>
      base.updateBannerRequired(latest, current);
  @override
  String updateCurrentVersion(String version) =>
      base.updateCurrentVersion(version);
  @override
  String updateLatestVersion(String version) =>
      base.updateLatestVersion(version);
  @override
  String updateAvailableText(String latest) =>
      base.updateAvailableText(latest);
  @override
  String updateRequiredText(String minimum) =>
      base.updateRequiredText(minimum);
  @override
  String updateUnknownText(String reason) =>
      base.updateUnknownText(reason);
  @override
  String updateLastChecked(String time) =>
      base.updateLastChecked(time);
  @override
  String updateNextAllowed(String time) =>
      base.updateNextAllowed(time);
  @override
  String updateChannelLabel(String channel) =>
      base.updateChannelLabel(channel);
  @override
  String updateCheckFailed(String reason) =>
      base.updateCheckFailed(reason);
  @override
  String updateReasonText(String reason) =>
      base.updateReasonText(reason);
  @override
  String trayUpdateItem(String latest) =>
      base.trayUpdateItem(latest);
  @override
  String trayUpdateRequiredItem(String latest) =>
      base.trayUpdateRequiredItem(latest);
  @override
  String trayUpdateTooltip(String name, String latest) =>
      base.trayUpdateTooltip(name, latest);
  @override
  String trayUpdateRequiredTooltip(String name, String latest) =>
      base.trayUpdateRequiredTooltip(name, latest);
  @override
  String get updateRequiredNotice =>
      overrides['updateRequiredNotice'] ?? base.updateRequiredNotice;
  @override
  String get updateChannelMismatchText =>
      overrides['updateChannelMismatchText'] ?? base.updateChannelMismatchText;
  @override
  String get updateDownloadTitle =>
      overrides['updateDownloadTitle'] ?? base.updateDownloadTitle;
  @override
  String get updateDownloadNote =>
      overrides['updateDownloadNote'] ?? base.updateDownloadNote;
  @override
  String get updateGitHubDownload =>
      overrides['updateGitHubDownload'] ?? base.updateGitHubDownload;
  @override
  String get updateNetdiskDownload =>
      overrides['updateNetdiskDownload'] ?? base.updateNetdiskDownload;
  @override
  String get updateNetdiskSoon =>
      overrides['updateNetdiskSoon'] ?? base.updateNetdiskSoon;
  @override
  String get updateBaiduDownload =>
      overrides['updateBaiduDownload'] ?? base.updateBaiduDownload;
  @override
  String get updateQuarkDownload =>
      overrides['updateQuarkDownload'] ?? base.updateQuarkDownload;
  @override
  String get updatePendingUpload =>
      overrides['updatePendingUpload'] ?? base.updatePendingUpload;
  @override
  String get updateCopyCode =>
      overrides['updateCopyCode'] ?? base.updateCopyCode;
  @override
  String get updateCopied =>
      overrides['updateCopied'] ?? base.updateCopied;
  @override
  String get updateReleasePage =>
      overrides['updateReleasePage'] ?? base.updateReleasePage;
  @override
  String get updateChannelSwitchNote =>
      overrides['updateChannelSwitchNote'] ?? base.updateChannelSwitchNote;
  @override
  String updateNewVersionTitle(String latest, String current) =>
      base.updateNewVersionTitle(latest, current);
  @override
  String updateExtractCode(String code) =>
      base.updateExtractCode(code);
  @override
  String updatePlatformLine(String os, String arch, String kind) =>
      base.updatePlatformLine(os, arch, kind);
  @override
  String updateKindLabel(String kind) =>
      base.updateKindLabel(kind);
  @override
  String updateSwitched(String channel) =>
      base.updateSwitched(channel);
  @override
  String updateSwitchFailed(String reason) =>
      base.updateSwitchFailed(reason);
}
