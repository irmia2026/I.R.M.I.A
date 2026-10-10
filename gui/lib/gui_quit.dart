/// 「这次是我主动退的」标记 —— 界面写给后端的一次握手（协议见 `docs/gui-guard.md` §3）。
///
/// **为什么需要它**：后端有一层保活（`src/runtime/gui-guard.ts`），每一拍按**可执行文件
/// 全路径**问"界面还在吗"。没有这个标记时，「用户点了退出」与「界面崩了/被杀了」在它眼里
/// **是同一个形状**，于是主动关闭会被当成崩溃、被拉回来（上限：最多 6 次，然后永久停手 + 报警）。
/// 这个标记就是**唯一能区分那两件事**的东西：写下去 = 别拉我；没写 = 崩了，该拉就拉。
///
/// **写在哪里**：`%APPDATA%\Irmia\gui-quit.marker`。挑这个目录不是随手：界面**不知道**
/// 后端的 dataDir（权威那份标记在 `<dataDir>/gui-quit.marker`），而 `%APPDATA%\Irmia\`
/// 是**两端都算得出来**的同一个目录（界面本来就往那儿写 `ui-state.json` 与 `sessions\<实例>`），
/// 所以界面写这个标记**一个后端路径都不用知道**，也不用去猜"后端的 node 在哪、脚本在哪"。
///
/// **什么时候写**：只在**确认要退出**的那两条路上写 —— `main.dart` 的关窗回调
/// （`window-close`）与 `shell/tray.dart` 的托盘「退出」（`tray-quit`）。
/// ⚠ **收进托盘/最小化不许写**：那条路上界面进程**还活着**，后端探活照样看得见它；
/// 写了只会留下一个"新鲜"的标记，把此后 5 分钟内**真的**崩掉的那一次压成"他主动退的"，
/// 正好把保活本该救的那一次救没了。标记是给"我要走了"用的，不是给"我看不见了"用的。
///
/// **写不下去就算了**：退出这条路不该被一个标记拦住（后端最坏只是把它当崩溃——
/// 那正是本标记接入之前的老行为）。所以整段吞异常，只落一行日志。
library;

import 'dart:io';

import 'package:flutter/foundation.dart';

/// 告诉后端"这次是我主动退的，别把我拉回来"（协议见 docs/gui-guard.md §3）。
/// 写不下去就算了：退出这条路不该被一个标记拦住（后端只是会把它当崩溃）。
Future<void> markGuiQuit(String reason) async {
  try {
    final dir = Directory('${Platform.environment['APPDATA']}\\Irmia');
    if (!dir.existsSync()) dir.createSync(recursive: true);
    File('${dir.path}\\gui-quit.marker').writeAsStringSync(
      '{"ts":"${DateTime.now().toUtc().toIso8601String()}","pid":$pid,"reason":"$reason"}',
    );
  } catch (error) {
    // 吞掉：**不许**阻断退出（判据是「先写标记、再退出」；写失败只退回"被后端当崩溃"）。
    debugPrint('写主动退出标记失败（这次会被后端当成崩溃）：$error');
  }
}
