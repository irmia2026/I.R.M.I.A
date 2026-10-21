/// 用**系统默认浏览器**打开一个外链（全仓唯一实现）。
///
/// 为什么要有这一层：设置页的「下载页 / 打开面板」与引导页第 2、3 步的推荐链接是**同一件事**
/// ——把一个地址交给操作系统。各页各写一份 `Process.run` 的下场是"三处的失败措辞、三处的
/// 平台分支、三处各自漂"；这里收成一条，页面只关心"打开哪个地址"。
///
/// 刻意**不引 `url_launcher`**（与 `pubspec.yaml` 的零第三方依赖一致）：Windows 侧它还要
/// 一份平台插件与 CMake 清单，而这个 GUI 开外链只发生在人点一颗按钮的时候，`start` 够用。
/// 见 `docs/gui-guard.md` 与 `settings_page.dart` 里那条同源的注释。
library;

import 'dart:io';

/// 打开一个 URL 的动作。
///
/// 真机 = [openUrlInSystemBrowser]；用例 = 自己录一笔的假函数（见 [externalUrlOpener]）。
typedef ExternalUrlOpener = Future<void> Function(String url);

/// 真机实现：把 URL 交给系统默认浏览器。
///
/// Windows 走 `cmd /c start "" <url>`：`start` 的**第一个带引号的参数是窗口标题**，
/// 那个空串是占位符——少了它，带空格的 URL 会被当成标题、浏览器只收到半截。
/// （本机实测过：不带空标题的写法在 `https://…/a b` 这种地址上会开一个空白页。）
Future<void> openUrlInSystemBrowser(String url) async {
  if (Platform.isWindows) {
    await Process.run('cmd', ['/c', 'start', '', url], runInShell: true);
  } else if (Platform.isMacOS) {
    await Process.run('open', [url]);
  } else {
    await Process.run('xdg-open', [url]);
  }
}

/// 当前生效的打开方式。
///
/// 用例把它换成一个只记账的假函数（姿势与 `ui_state.dart` 的 `stateFileOverride` 同族）：
/// widget 用例里真起浏览器既慢、又会给跑测试的那台机器弹窗，而这里要断言的是
/// "点了之后打开的**确实是那个地址**"，不是"Windows 的 start 怎么拼"。
ExternalUrlOpener externalUrlOpener = openUrlInSystemBrowser;

/// 用系统默认浏览器打开 [url]。
///
/// 返回"这次动作有没有发出去"：`false` 时调用方要把地址**说出来**——那是唯一不靠
/// 外部程序也能让人拿到它的方式（设置页的下载页与协议端登录界面都这么处置）。
Future<bool> openExternalUrl(String url) async {
  try {
    await externalUrlOpener(url);
    return true;
  } catch (_) {
    return false;
  }
}
