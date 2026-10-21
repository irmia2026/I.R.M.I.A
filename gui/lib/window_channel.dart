import 'package:flutter/services.dart';

/// 自绘标题栏与 Windows runner 之间的那条通道（见 docs/gui-revision.md ①）。
///
/// 窗口去掉了系统标题栏，拖动/最小化/关闭系统不再代劳，只能由这边发起。
/// 通道对端在 `windows/runner/flutter_window.cpp`（方法名一一对应）。
///
/// 不在那个 runner 里跑时（单元测试、Web 构建）调用会抛 [MissingPluginException]，
/// 这里全部吞掉：界面照常显示，只是这几下点不动窗口。
class WindowChannel {
  const WindowChannel._();

  static const MethodChannel _channel = MethodChannel('irmia/window');

  /// 开始拖动窗口：按下即调用，等价于点住真实标题栏
  static Future<void> startDragging() => _invoke('startDragging');

  static Future<void> minimize() => _invoke('minimize');

  static Future<void> close() => _invoke('close');

  static Future<void> _invoke(String method) async {
    try {
      await _channel.invokeMethod<void>(method);
    } on MissingPluginException {
      // 没有对端：非 Windows runner
    } on PlatformException {
      // 对端报错（例如窗口已经没了）：不影响界面
    }
  }
}
