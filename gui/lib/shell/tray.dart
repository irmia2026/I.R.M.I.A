import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:window_manager/window_manager.dart';

import '../gui_quit.dart';
import '../her_name.dart';

/// Irmia GUI 的**托盘**（2026-10-04 用户要的托盘化）。
///
/// 她是常驻的，界面不该"关掉就没了"。所以：
///   • 关窗默认**退出界面**（她照常跑），只有人在设置页显式打开「关窗时收进托盘」才隐藏
///     ——见 main.dart 的 `_CloseToTray` 与 ui_state.dart 的 [kCloseToTrayFlag]；
///   • 托盘菜单三件：显示/隐藏界面、重启前后端、退出——注意菜单里那项**永远可用**，
///     它是**显式动作**（人自己点的"收进托盘"），与关窗那个偏好是两件事；
///   • **重启复用后端那个动作**（`/api/commands/restart`），并把界面自己的可执行路径带过去——
///     与运行情况页那颗按钮同一条路，免得两处各写一份重启逻辑；
///   • 悬停提示写的是**她的名字**（`persona/IDENTITY.md` 的「名字：」那一行），
///     不再是写死的一个名字：名字读不到时显示产品名（见 [setDisplayName] 与 her_name.dart）。
class IrmiaTray with TrayListener {
  IrmiaTray._();

  static final IrmiaTray instance = IrmiaTray._();

  /// 宿主注入的"发命令"能力（复用界面已有的 api 客户端；不注入就只能显示/隐藏）。
  /// 返回的是服务端回执（`Map`），重启那条路要用它来说清楚结局。
  Future<Object?> Function(String command, Map<String, dynamic> payload)? _post;
  VoidCallback? _onQuitRequested;
  /// 服务端对「重启前后端」的回执（见 [install] 的 `onRestartResult`）
  void Function(Object? result)? _onRestartResult;
  bool _installed = false;

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

  /// 装托盘。`post` 给的是 `/api/commands/<name>` 的发送函数（带确认短语）；
  /// `displayName` 是当前已知的她的名字（拿不到就传 [IrmiaTray] 的默认回退值）。
  Future<void> install({
    Future<Object?> Function(String command, Map<String, dynamic> payload)? post,
    VoidCallback? onQuitRequested,
    String? displayName,
    /// 「重启前后端」的服务端回执（那句话是**唯一一处**判据：成功带真实新 pid 与端口、
    /// 失败带原因、未确认就说未确认）。托盘自己不显示它，交给宿主按同一口径处理——
    /// 但绝不能丢：丢了就退回"点了没反应"那种最糟的反馈。
    void Function(Object? result)? onRestartResult,
  }) async {
    _post = post;
    _onQuitRequested = onQuitRequested;
    _onRestartResult = onRestartResult;
    if (displayName != null && displayName.trim().isNotEmpty) _displayName = displayName.trim();
    if (_installed) return;

    trayManager.addListener(this);
    await trayManager.setIcon(_iconPath);
    await trayManager.setToolTip(_displayName);
    await trayManager.setContextMenu(Menu(items: [
      MenuItem(key: 'show', label: '显示界面'),
      MenuItem(key: 'hide', label: '收进托盘'),
      MenuItem.separator(),
      MenuItem(key: 'restart', label: '重启前后端'),
      MenuItem.separator(),
      MenuItem(key: 'quit', label: '退出'),
    ]));
    _installed = true;
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
      await trayManager.setToolTip(_displayName);
    } catch (_) {
      // 忽略：提示文字是锦上添花
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
    unawaited(windowManager.show());
    unawaited(windowManager.focus());
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
    switch (menuItem.key) {
      case 'show':
        unawaited(windowManager.show());
        unawaited(windowManager.focus());
        break;
      case 'hide':
        unawaited(windowManager.hide());
        break;
      case 'restart':
        final post = _post;
        if (post == null) break;
        // 与运行情况页那颗按钮**同一条路**：界面把自己的可执行路径带过去，脚本连界面一起重启。
        //
        // 这里不弹 toast（托盘点击时窗口可能收着，弹在哪儿都没有意义），但**那句结论不能丢**：
        // 服务端回来的 `note` 是唯一一处判据（成功带真实新 pid 与端口、失败带原因、
        // 未确认就说未确认），所以转交给 `_onRestartResult` 由宿主按同一口径显示
        // （见 main.dart：窗口在就显示，收在托盘里就只写进日志——不假装"点了没反应"，
        // 也不在看不见的地方撒谎）。
        unawaited(post('restart', {'guiExe': Platform.resolvedExecutable})
            .then((Object? result) => _onRestartResult?.call(result)));
        break;
      case 'quit':
        // **先写标记、再退**（协议见 docs/gui-guard.md §3）：后端保活按"有没有这个标记"
        // 分"他主动退的"与"崩了/被杀了"，不写就会被当成崩溃拉回来（最多 6 次）。
        // ⚠ 上面 'hide'（收进托盘）那一支**不许**写：界面还在跑，写了会压住真的那次崩溃。
        unawaited(markGuiQuit('tray-quit'));
        _onQuitRequested?.call();
        unawaited(trayManager.destroy());
        unawaited(windowManager.destroy());
        break;
    }
  }
}

void unawaited(Future<void> future) {
  future.ignore();
}
