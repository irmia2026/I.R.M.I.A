import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

import 'app.dart';
// 「我要走了」的标记：后端保活靠它把"他主动关的"与"崩了"分开，见 docs/gui-guard.md §3
import 'gui_quit.dart';
// 界面自己的运行日志：卡死时唯一能回答"卡在哪一条请求/哪一页"的东西
import 'gui_log.dart';
import 'i18n/strings_override.dart';
import 'i18n/strings_scope.dart';
import 'shell/tray.dart';
// 「关窗时收进托盘」这个界面偏好（`%APPDATA%/Irmia/ui-state.json`，键 close-to-tray）
import 'ui_state.dart';
// 窗口状态留痕（`[win] focus/visibility/restore`）：与主 isolate 的 `[stall]` 拼在一起读
import 'win_trace.dart';

/// Irmia GUI 入口。
///
/// 窗口尺寸（1350×900）与落位由 windows/runner/main.cpp 设定，见 docs/gui-design.md §2；
/// 标题栏是自绘的（lib/title_bar.dart），见 docs/gui-revision.md ①——自绘要求
/// 「客户区 = 整个窗口」，这条约定由 runner 守着（win32_window.cpp 与
/// flutter_window.cpp 里的 WM_NCCALCSIZE）。
///
/// **关窗行为**（2026-10-21 用户裁决：出厂默认 = 收进托盘、不退出界面）。
///
/// 上一版（2026-10-04）默认是"点 × 就退出界面"，理由是 Windows 11 默认把新出现的托盘图标
/// 收进"隐藏的图标"面板（通知区域那个 `^` 里），用户踩过两次"窗口消失、再也找不回来"。
/// 那条风险今天仍在，但用户 2026-10-21 要的是"出厂默认开启"，所以默认翻了过来：
///   · 没写过这个偏好（新装/新用户）⇒ 关窗收进托盘，界面进程还活着，后端照旧跑；
///   · 显式在设置页关掉它（键 `close-to-tray`，见 ui_state.dart）⇒ 点 × 干净地退出界面；
///   · 托盘**没装成**时无论开关怎么写都不隐藏（见下面 `_CloseToTray` 的第二道保险）——
///     宁可直接退出，也不把界面丢进一个没有入口的黑洞。
///
/// 托盘菜单照旧（显示界面 / 收进托盘 / 重启前后端 / 退出）："收进托盘"作为**显式动作**
/// 永远可用，不受这个偏好影响。
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();

  // 界面自己的运行日志（`%LOCALAPPDATA%\Irmia\gui.log`，滚动上限 2MB）：
  // 2026-10-23「用久了卡死」那场之后加的——那一次只有进程数字，没有任何界面日志，
  // "卡在哪个请求/哪一页"全靠猜。开的时机放在最前面：连窗口起来之前那几步也要留痕。
  // **只在真机上开**：`flutter test` 不调这一处，所以那 800 多条用例不会往用户的
  // `%LOCALAPPDATA%` 里写字（见 gui_log.dart 的"三条分寸"）。
  guiLog.attach();

  // 窗口状态留痕（`[win] focus=true/false`、`[win] visibility=…`）：卡死现场第一件要分清的事
  // 是"窗口当时在不在屏幕上、有没有焦点"——可见却不动才是主 isolate 停了（见 win_trace.dart）。
  // 放在最前面：连 show 之前那几拍（窗口建好、抢焦点）也要留痕。
  WinTrace.instance.attach();

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

  // 关窗收进托盘是界面自己的偏好，**出厂默认开**（kCloseToTrayDefault）：
  // 只有它开着（没被显式关掉）才拦关闭。读盘失败也按默认开处理（失败静默在 ui_state 里）
  // ——与上一版的取舍相反，理由与那两道保险写在文件头与 ui_state.dart 的 kCloseToTrayFlag 上。
  final closeToTrayEnabled = await restoreCloseToTray();
  await windowManager.setPreventClose(closeToTrayEnabled);
  windowManager.addListener(_CloseToTray());

  // 语言：**只在这一处读系统 locale**（理由见 i18n/strings_scope.dart 顶部）。
  // 盘上存的是"用户选了什么"（跟随系统 / 中文 / English），这里把它解析成具体语言
  // 再交给界面——树里拿到的永远是 zh 或 en，widget 测试因此不会跟着机器的系统语言变。
  // 读盘失败一律当「跟随系统」（失败静默在 ui_state 里）。
  final language = await restoreLanguage(
    systemLocale: WidgetsBinding.instance.platformDispatcher.locale,
  );

  // 文案覆盖层（i18n 的第三层，见 lib/i18n/strings_override.dart）：启动读一次
  // `%APPDATA%\Irmia\strings-override.json`。**文件不在 / 读不动 / JSON 坏都只是回默认
  // 文案**，一个都不拦启动；拼错的键在这儿打到控制台（"我改了怎么没变"的唯一线索）。
  // 放在 runApp 之前：首帧就该是用户改过的那份字，不能先闪一下默认文案。
  await loadStringsOverride(language: language);

  // 托盘在 app.dart 里装（那里拿得到命令通道；这里只管窗口）
  runApp(IrmiaApp(initialLanguage: language));
}

/// 关窗 → 按偏好处置：出厂默认**收进托盘**（界面还在，她照常跑），显式关掉才退出界面。
///
/// 真退出走托盘菜单里的那一项；这里只处理"点窗口的 ×"。
class _CloseToTray extends WindowListener {
  @override
  void onWindowClose() {
    // 偏好是开（出厂默认）就隐藏；显式关掉的走下面"退出界面"那一支。
    // 走到这儿的是"开关开着但窗口还是收到关闭事件"的兜底路径。
    if (closeToTray.value && IrmiaTray.instance.installed) {
      // 界面收起来，她不跟着走：agent 是独立进程，界面只是她的一个窗口
      // （`hide()` 不会回一个事件，所以这一下要自己说一声，见 win_trace.dart）
      WinTrace.instance.noteHidden();
      unawaited(windowManager.hide());
      return;
    }
    // **托盘没装成就不许隐藏**（与开关无关）：装不上时"隐藏"等于把界面丢进黑洞
    // ——托盘图标不存在，没有任何入口能把它叫回来，只能去任务管理器。
    // 这一条是默认翻成"开"之后**最要紧的那道保险**：新装的机器上托盘可能起不来。
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
