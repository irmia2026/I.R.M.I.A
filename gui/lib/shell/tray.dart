// TODO(i18n): 本文件还有 1 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/shell/tray.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:tray_manager/tray_manager.dart';

import '../her_name.dart';
import '../i18n/app_strings.dart';

/// Irmia GUI 的**托盘**（2026-10-04 用户要的托盘化）。
///
/// 她是常驻的，界面不该"关掉就没了"。所以：
///   • 关窗**出厂默认收进托盘**（界面还在跑、后端不受影响；2026-10-21 用户裁决）。
///     在设置页显式关掉「关窗时收进托盘」之后，点 × 才退出界面
///     ——见 main.dart 的 `_CloseToTray` 与 ui_state.dart 的 [kCloseToTrayFlag] / [kCloseToTrayDefault]；
///   • **菜单五项**（2026-10-17 改）：显示界面 / 收进托盘 / 重启前后端 /
///     **退出界面** / **退出全部（界面 + 后端）**。"收进托盘"作为**显式动作**永远可用，
///     与关窗那个偏好是两件事；
///   • **有待批时多一个首项**（2026-10-21，用户："很多新手小白不知道在哪可以审批"）：
///     菜单最上面写「有 N 条待批」，点它落到**扩展页**。它**只在有待批时才在**——
///     常驻一条「有 0 条待批」等于让人每天都读一遍"没有事"，久了就没人再读这一行了。
///     判据与右下角那张快速审批卡、左侧「扩展」角标同一份（`grant_inbox.dart`）；
///   • **重启只有一条路**：`lib/restart_action.dart` 的 [performRestart] —— 与首页那颗
///     「重启前后端」**同一个函数、同一套三态判据**（改之前两条路一套严一套松，现场见那个文件）；
///   • **退出为什么分成两项**（用户 2026-10-17 ②）：
///     原来的「退出」只 `windowManager.destroy()`，后端照旧在跑——而菜单上那句话是"退出"，
///     人读成"整个应用都退了"。可是"关掉界面、她继续值守"恰恰是这个框架的**常态**
///     （见 main.dart 的说明：她是独立进程），一刀切把它变成"连后端一起退"会把最常用的
///     那个动作变危险。两项各有各的语义、各有各的代价，所以分开摆：
///       · 「退出界面（她继续在后台运行）」= 老行为，**零风险**（后端与协议端都不动）；
///       · 「退出全部（界面 + 后端）」= 真把后端（连同它拉起的协议端）停掉，代价写在确认框里
///         （硬杀：`session/end` 与协议端收尸都会丢，协议端可能要重登一次）。
///     判据：一个"退出"若两件事都做，就没有任何入口能做那件安全的事；反过来若只做安全那件，
///     人就被迫去任务管理器做另一件（正是用户报的毛病）。**两项**是唯一都对得上的形状。
///   • 悬停提示写的是**她的名字**（`persona/IDENTITY.md` 的「名字：」那一行），
///     不再是写死的一个名字：名字读不到时显示产品名（见 [setDisplayName] 与 her_name.dart）。
///
/// 本文件**只认菜单与插件**：窗口怎么显示/隐藏、退出要不要写标记、怎么停后端，
/// 全在宿主（app.dart）注入的 [TrayActions] 里。这样"菜单项 → 哪一个动作"可以用例钉住
/// （[dispatchTrayMenu] 是纯函数），而插件那一层不需要在测试里跑。
class IrmiaTray with TrayListener {
  IrmiaTray._();

  static final IrmiaTray instance = IrmiaTray._();

  /// 宿主注入的动作（都来自 app.dart，本文件不碰窗口、不碰后端）。
  /// 待批那一项（[TrayActions.openPending]）在有待批时才会出现在菜单上。
  TrayActions _actions = const TrayActions(
    show: _noop,
    hide: _noop,
    restart: _noopAsync,
    quitUi: _noop,
    quitAll: _noop,
    openPending: _noop,
  );

  bool _installed = false;

  /// 当前生效的文案（菜单与悬停提示的措辞都从它来）。
  ///
  /// 为什么要在托盘里存一份：菜单是**原生对象**，重画时手上没有 BuildContext；
  /// 而"待批数变了"这件事可能先于任何一次页面重建到达（见 [setPendingCount]）。
  AppStrings _strings = const ZhStrings();

  /// 待批几张（0 = 菜单不摆首项，悬停提示就只是她的名字）。
  int _pendingCount = 0;

  /// 更新检查的托盘口径（2026-10-22）：有新版本时菜单加一行、悬停提示挂一句。
  ///
  /// **只有"有新版本 / 必须升级"才写进菜单**——"已是最新"不占一行，否则人每天都要读
  /// 一遍"没有事"（与待批那条「有 0 条待批」同一条纪律）。`required` 时措辞换成"请升级"。
  String? _updateVersion;
  bool _updateRequired = false;

  /// 悬停提示那一行：待批条数与新版本各挂一句，都没有就只是她的名字。
  ///
  /// 托盘是**关窗之后唯一还看得见的东西**（见文件头）：窗口收起来之后，右下角那张卡
  /// 不在屏幕上了，只有这里还能说出"她递了一张单子"与"有新版本"。
  String get _tooltip {
    var text = _displayName;
    if (_pendingCount > 0) text = _strings.trayPendingTooltip(_displayName, _pendingCount);
    final version = _updateVersion;
    if (version != null) {
      text = _updateRequired
          ? _strings.trayUpdateRequiredTooltip(text, version)
          : _strings.trayUpdateTooltip(text, version);
    }
    return text;
  }

  /// **托盘提示里的名字**（悬停时那行字）。
  ///
  /// 它显示的是她的名字，而名字是异步读来的（`persona/IDENTITY.md`），所以这里先留一个
  /// 回退值：`her_name.dart` 的保守口径——读不到就显示产品名，绝不显示一个像是她名字的东西。
  /// 托盘是**常驻**的（关窗之后它是唯一还看得见的东西），猜错一个名字比空着更糟。
  String _displayName = kProductName;

  /// 托盘**真的装上了**没有。
  ///
  /// 给宿主判断用：装不上（某些精简系统没有通知区域、或 Shell_NotifyIcon 失败）时，
  /// 绝不能把关窗改成"隐藏"——那会让人点一下 X 就再也叫不回界面，只能任务管理器。
  bool get installed => _installed;

  /// 装托盘。`actions` 是四个动作的落点（见 [TrayActions]）；
  /// `strings` 只用来画菜单文字（`refreshMenu` 换了语言再画一遍）。
  Future<void> install({
    required TrayActions actions,
    required AppStrings strings,
    String? displayName,
  }) async {
    _actions = actions;
    _strings = strings;
    if (displayName != null && displayName.trim().isNotEmpty) _displayName = displayName.trim();
    if (_installed) return;

    trayManager.addListener(this);
    await trayManager.setIcon(_iconPath);
    await trayManager.setToolTip(_tooltip);
    await trayManager.setContextMenu(Menu(items: trayMenuItems(
      strings,
      pending: _pendingCount,
      updateVersion: _updateVersion,
      updateRequired: _updateRequired,
    )));
    _installed = true;
  }

  /// 语言换了之后把菜单文字重画一遍（`effectiveLanguage` 一变就调）。
  ///
  /// 为什么值得单独一个方法：菜单是**插件那边的原生对象**，不跟着 Flutter 重建；
  /// 不重画的话"切到 English 了、托盘还是中文"，而这种不一致没人会想到去查。
  Future<void> refreshMenu(AppStrings strings) async {
    _strings = strings;
    if (!_installed) return;
    try {
      await trayManager.setContextMenu(Menu(items: trayMenuItems(
        strings,
        pending: _pendingCount,
        updateVersion: _updateVersion,
        updateRequired: _updateRequired,
      )));
      // 悬停提示里也可能挂着待批数（`名字 · 有 N 条待批`）：它同样是原生对象，一起换掉
      await trayManager.setToolTip(_tooltip);
    } catch (_) {
      // 重画失败不影响托盘还活着：下次 `install`（下一次启动）会画对
    }
  }

  /// **待批数变了**：菜单首项与悬停提示跟着换（`app.dart` 的 `_syncTrayPending` 调它）。
  ///
  /// 三条分寸与 [setDisplayName] 一致：值没变就什么都不做（每 10 秒一次轮询都会调到这里，
  /// 不该每拍都捅一次系统托盘）；托盘没装成就只记下来（[install] 下次用它）；
  /// 系统调用失败就吞掉（一个提示文字换不掉，不值得让界面上报错）。
  Future<void> setPendingCount({required int count, required AppStrings strings}) async {
    _strings = strings;
    final next = count < 0 ? 0 : count;
    final changed = next != _pendingCount;
    _pendingCount = next;
    if (!_installed) return;
    try {
      // 菜单只有"有没有首项 / 首项上那个数"两种变化会改内容：没变就不重画（原生菜单重画会闪）
      if (changed) {
        await trayManager.setContextMenu(Menu(items: trayMenuItems(
          strings,
          pending: _pendingCount,
          updateVersion: _updateVersion,
          updateRequired: _updateRequired,
        )));
      }
      await trayManager.setToolTip(_tooltip);
    } catch (_) {
      // 忽略：与 setDisplayName 同一条口径
    }
  }

  /// **更新状态变了**：菜单加/去一行，悬停提示跟着换（`app.dart` 的 `_syncTrayUpdate` 调它）。
  ///
  /// 三条分寸与 [setPendingCount] 一致：值没变就什么都不做（每次 AppState 通知都会调到这里，
  /// 不该每拍都捅一次系统托盘）；托盘没装成就只记下来；系统调用失败就吞掉。
  /// `version == null` 表示"没有值得提示的版本"（菜单那一行随之消失）。
  Future<void> setUpdate({
    required String? version,
    required bool required,
    required AppStrings strings,
  }) async {
    _strings = strings;
    final next = (version == null || version.trim().isEmpty) ? null : version.trim();
    final changed = next != _updateVersion || (next != null && required != _updateRequired);
    _updateVersion = next;
    _updateRequired = next != null && required;
    if (!_installed || !changed) return;
    try {
      await trayManager.setContextMenu(Menu(items: trayMenuItems(
        strings,
        pending: _pendingCount,
        updateVersion: _updateVersion,
        updateRequired: _updateRequired,
      )));
      await trayManager.setToolTip(_tooltip);
    } catch (_) {
      // 忽略：与 setPendingCount 同一条口径
    }
  }

  /// 她的名字读到（或改了）之后更新托盘提示。
  ///
  /// 三件事：值没变就直接返回（宿主每次轮询都会调到这里，不该每 10 秒捅一次系统托盘）；
  /// 托盘没装成就只记下来（[install] 下次用它）；系统调用失败就吞掉——
  /// 一个提示文字换不掉，不值得让界面上报错，更不该把已经装好的托盘标记成没装。
  Future<void> setDisplayName(String name) async {
    final next = name.trim().isEmpty ? kProductName : name.trim();
    if (next == _displayName) return;
    _displayName = next;
    if (!_installed) return;
    try {
      await trayManager.setToolTip(_tooltip);
    } catch (_) {
      // 忽略：提示文字是锦上添花
    }
  }

  /// 拆掉托盘（退出流程用；托盘是常驻资源，退出前要收干净）
  Future<void> remove() async {
    if (!_installed) return;
    _installed = false;
    try {
      trayManager.removeListener(this);
      await trayManager.destroy();
    } catch (_) {
      // 拆不掉也不该拦住退出
    }
  }

  /// 托盘图标：直接用 runner 里那份应用图标（省得再放一份、两份还会不一致）
  String get _iconPath {
    if (Platform.isWindows) {
      final exeDir = File(Platform.resolvedExecutable).parent.path;
      return '$exeDir${Platform.pathSeparator}data${Platform.pathSeparator}flutter_assets'
          '${Platform.pathSeparator}assets${Platform.pathSeparator}tray.ico';
    }
    return 'assets/tray.ico';
  }

  @override
  void onTrayIconMouseDown() {
    // 左键点图标：显示并聚焦（Windows 上的习惯）
    _actions.show();
  }

  @override
  void onTrayIconRightMouseDown() {
    // **bringAppToFront: true 不是可选项**：Win32 要求托盘菜单的属主窗口先成为前台窗口，
    // 否则菜单点外面不会消失（MSDN 明写）。tray_manager 的默认值是 false，所以必须显式传。
    // 这个参数被标了 deprecated（插件作者说以后会移除），但它是目前**唯一**能让菜单正常
    // 消失的开关；等插件给出替代写法再换，先按下不表（analyze 这行显式豁免，别当没看见）。
    // ignore: deprecated_member_use
    unawaited(trayManager.popUpContextMenu(bringAppToFront: true));
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    dispatchTrayMenu(menuItem.key ?? '', _actions);
  }
}

/// 托盘菜单项的**点击分发**（纯逻辑：不碰插件、不碰窗口，用例可以直接调它钉住"哪一项做哪件事"）。
///
/// 认不出的 key 什么都不做：菜单将来加了项而这里忘了接，症状是"点了没反应"，
/// 比"点了一个不知道是什么的动作"好些。
void dispatchTrayMenu(String key, TrayActions actions) {
  switch (key) {
    case kTrayKeyPending:
      // 有待批时的那一项：把窗口摆出来，落到扩展页（那边能一次看完并逐条批）
      actions.openPending();
      break;
    case kTrayKeyUpdate:
      // 有新版本时的那一项：把窗口摆出来，落到**设置页**（「关于」里有检查更新与查看）。
      // 它**不直接开浏览器**：托盘是原生菜单，"点一下就把浏览器拉起来"太突然；
      // 真正打开外链只有人工按的那颗「查看」（见 update_check.dart 的 UpdateBanner）。
      actions.openUpdate();
      break;
    case kTrayKeyShow:
      actions.show();
      break;
    case kTrayKeyHide:
      actions.hide();
      break;
    case kTrayKeyRestart:
      // 与首页那颗按钮**同一个函数**（见 lib/restart_action.dart）：
      // 请求、三态判据、说的话、等回来的窗口，全部只有一份。
      unawaited(actions.restart());
      break;
    case kTrayKeyQuitUi:
      actions.quitUi();
      break;
    case kTrayKeyQuitAll:
      actions.quitAll();
      break;
  }
}

/// 菜单项 key（字符串：`MenuItem.key` 是 String?，插件那边也是这个值回来）
const String kTrayKeyPending = 'pending';
const String kTrayKeyUpdate = 'update';
const String kTrayKeyShow = 'show';
const String kTrayKeyHide = 'hide';
const String kTrayKeyRestart = 'restart';
const String kTrayKeyQuitUi = 'quit-ui';
const String kTrayKeyQuitAll = 'quit-all';

/// 五个动作的落点（宿主注入；测试里可以给空实现）。
class TrayActions {
  const TrayActions({
    required this.show,
    required this.hide,
    required this.restart,
    required this.quitUi,
    required this.quitAll,
    required this.openPending,
    this.openUpdate = _noop,
  });

  /// 显示并聚焦窗口
  final VoidCallback show;

  /// 收进托盘（界面还在跑）
  final VoidCallback hide;

  /// 重启前后端（与首页那颗按钮同一个函数）
  final Future<void> Function() restart;

  /// 只退出界面（后端继续在后台跑）
  final VoidCallback quitUi;

  /// 退出全部（界面 + 后端）
  final VoidCallback quitAll;

  /// 「有 N 条待批」那一项：显示窗口并落到扩展页
  final VoidCallback openPending;

  /// 「有新版本」那一项：显示窗口并落到设置页（**不自动开浏览器**，见 dispatchTrayMenu）
  final VoidCallback openUpdate;
}

/// 菜单的**内容与措辞**（顺序就是屏幕上从上到下）。纯函数 + 文案表：
/// 中英各一份由 [AppStrings] 给，菜单文字不在这里写死。
///
/// [pending] > 0 时**最上面多一项**「有 N 条待批」（点它去扩展页）；为 0 时菜单与
/// 加这一项之前**逐项相同**——不摆一个「有 0 条待批」占位。
///
/// [updateVersion] 非空时在有新版本/必须升级，多一项「有新版本 vX · 查看」（点它去设置页）；
/// 为 null（已是最新 / 还没查 / 关闭）时**不多任何一项**——理由与待批那条逐字相同。
List<MenuItem> trayMenuItems(
  AppStrings strings, {
  int pending = 0,
  String? updateVersion,
  bool updateRequired = false,
}) =>
    <MenuItem>[
      if (pending > 0)
        MenuItem(key: kTrayKeyPending, label: strings.trayPendingItem(pending)),
      if (updateVersion != null && updateVersion.isNotEmpty)
        MenuItem(
          key: kTrayKeyUpdate,
          label: updateRequired
              ? strings.trayUpdateRequiredItem(updateVersion)
              : strings.trayUpdateItem(updateVersion),
        ),
      MenuItem(key: kTrayKeyShow, label: strings.trayShow),
      MenuItem(key: kTrayKeyHide, label: strings.trayHide),
      MenuItem.separator(),
      MenuItem(key: kTrayKeyRestart, label: strings.trayRestart),
      MenuItem.separator(),
      // **两项退出**：一个只关界面（安全、常用），一个连后端一起（重、有代价）。
      // 措辞里就把区别写清楚——菜单只有一行字的地方，正是最该说准的地方。
      MenuItem(key: kTrayKeyQuitUi, label: strings.trayQuitUi),
      MenuItem(key: kTrayKeyQuitAll, label: strings.trayQuitAll),
    ];

void _noop() {}

Future<void> _noopAsync() async {}

void unawaited(Future<void> future) {
  future.ignore();
}
