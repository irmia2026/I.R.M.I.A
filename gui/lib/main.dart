import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';
// 「我要走了」的标记：后端保活靠它把"他主动关的"与"崩了"分开，见 docs/gui-guard.md §3
import 'gui_quit.dart';
import 'shell/tray.dart';
// 「关窗时收进托盘」这个界面偏好（`%APPDATA%/Irmia/ui-state.json`，键 close-to-tray）
import 'ui_state.dart';

/// Irmia GUI 入口。
///
/// 窗口尺寸（1350×900）与落位由 windows/runner/main.cpp 设定，见 docs/gui-design.md §2；
/// 标题栏是自绘的（lib/title_bar.dart），见 docs/gui-revision.md ①——自绘要求
/// 「客户区 = 整个窗口」，这条约定由 runner 守着（win32_window.cpp 与
/// flutter_window.cpp 里的 WM_NCCALCSIZE）。
///
/// **关窗行为**（2026-10-04 用户踩了两次之后改的）：**默认点 × 就退出界面**。
///
/// 原来是无条件"关窗 = 收进托盘"，理由是她是常驻的、界面不该"关掉就没了"。那条理由
/// 本身没错，错在**默认**：Windows 11 默认把新出现的托盘图标收进"隐藏的图标"面板
/// （通知区域那个 `^` 里），用户根本看不见那枚图标——于是"关窗收托盘"在他体验里就是
/// "窗口消失、再也找不回来"，只能靠外部命令 ShowWindow 捞回来。
///
/// 现在：**她（agent）是独立进程，关掉界面不影响她运行**，所以"关窗=退出界面"没有任何
/// 风险（她照常干活，想再看界面重新打开即可），而"关窗=藏起来"在托盘图标不可见时是个陷阱。
/// 想收进托盘的人在设置页把「关窗时收进托盘」打开（键 `close-to-tray`，见 ui_state.dart），
/// 那是**显式选择**：他知道图标可能被系统收到哪里去。
///
/// 托盘菜单照旧（显示界面 / 收进托盘 / 重启前后端 / 退出）："收进托盘"作为**显式动作**
/// 永远可用，不受这个偏好影响。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  // 窗口几何**交回 C++ runner**（windows/runner/main.cpp 的 origin/size 是客户区口径），
  // 这里只负责"把已经建好的窗口显示出来"。
  //
  // ⚠️ `WindowOptions` 里**不要**给 `titleBarStyle`，让它保持 null。原因不是审美：
  //   一旦给了值（哪怕是看着最"正确"的 `TitleBarStyle.hidden`——毕竟标题栏是我们自绘的），
  //   window_manager 就会调 setTitleBarStyle，它 Windows 侧的插件随即在 WM_NCCALCSIZE 里
  //   把客户区四边各削掉 8 物理像素（硬编码、不随 DPI 缩放，见 window_manager_plugin.cpp
  //   的 adjustNCCALCSIZE），Flutter 子窗口因此比窗口小一圈，右侧与底部露出 L 形黑边。
  //   2026-10-04 就是这么黑起来的。runner 侧现在会抢在插件之前认领 WM_NCCALCSIZE
  //   （flutter_window.cpp），但这里仍然不给值——两道锁比一道稳。
  //   也别拿 `TitleBarStyle.normal` 顶替：那个值同样会走 DwmExtendFrameIntoClientArea
  //   （参数全 0），把 runner 为窗口阴影与圆角留的那 1px DWM 边框一并抹掉。
  const options = WindowOptions(title: 'Irmia Agent Framework');
  await windowManager.waitUntilReadyToShow(options, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  // 关窗收进托盘是**用户显式打开的偏好**（默认关）：只有它开着才拦关闭。
  // 读盘失败一律当默认值 false（失败静默在 ui_state 里）——读不到偏好时，
  // "点 × 干净地退出"永远比"点 × 藏起来、人再也找不回"安全。
  final closeToTrayEnabled = await restoreCloseToTray();
  await windowManager.setPreventClose(closeToTrayEnabled);
  windowManager.addListener(_CloseToTray());

  // 托盘在 app.dart 里装（那里拿得到命令通道；这里只管窗口）
  runApp(const IrmiaApp());
}

/// 关窗 → 按偏好处置：默认**退出界面**（她照常跑），开了开关才收进托盘。
///
/// 真退出走托盘菜单里的那一项；这里只处理"点窗口的 ×"。
class _CloseToTray extends WindowListener {
  @override
  void onWindowClose() {
    // 只有**人显式打开**了「关窗时收进托盘」才隐藏。默认关着——见 main() 的说明。
    // 反过来说：没打开开关时这里连拦都不该拦（setPreventClose(false)），走到这儿的是
    // "开关开着但窗口还是收到关闭事件"的兜底路径。
    if (closeToTray.value && IrmiaTray.instance.installed) {
      // 界面收起来，她不跟着走：agent 是独立进程，界面只是她的一个窗口
      unawaited(windowManager.hide());
      return;
    }
    // **托盘没装成就不许隐藏**（与开关无关）：装不上时"隐藏"等于把界面丢进黑洞
    // ——托盘图标不存在，没有任何入口能把它叫回来，只能去任务管理器。
    //
    // 走到这儿才是"真的要退出界面"（上面那一支已经 return）；**先写标记、再退**：
    // 后端保活（gui-guard）拿它把"用户主动关的"与"崩了/被杀了"分开——不写就会被
    // 当成崩溃拉回来，最多 6 次。⚠ 上面"收进托盘"那一支**不许**写（进程还在跑）。
    unawaited(markGuiQuit('window-close'));
    unawaited(windowManager.destroy());
  }
}

/// `dart:async` 的 unawaited，避免为一行 import 引整个包
void unawaited(Future<void> future) {
  future.ignore();
}
