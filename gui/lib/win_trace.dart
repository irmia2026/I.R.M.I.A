/// **窗口状态留痕**（`gui.log` 里那些 `[win] …` 行）。
///
/// ## 为什么值得单独三行
///
/// 「窗口在、画面是老的、点不动」这个描述里藏着两种完全不同的现场：
///
///   · 窗口**收在托盘里 / 最小化**时人再看见它，画面当然是老的（它根本没在画），
///     而主 isolate 可能一直在正常跑；
///   · 窗口**可见、有焦点、却一动不动** —— 这才是主 isolate 停了（`stall_watch.dart`
///     的 `[stall]` 行会同时出现）。
///
/// 所以 `[win] focus=` / `[win] visibility=` / `[win] restore` 与 `[stall]` 是**拼在一起读**的：
/// 分开看谁都能自圆其说，合起来才说得清当时窗口在不在屏幕上、有没有焦点。
///
/// ## 谁写这几行
///
/// 两个来源，都收在 [WinTrace] 一个地方：
///
///   · **插件事件**（[WindowListener]）：`onWindowFocus` / `onWindowBlur` /
///     `onWindowMinimize` / `onWindowRestore`——这是窗口自己变的状态，只有系统知道；
///   · **我们自己调的**：`windowManager.show()` / `hide()` 不会回一个事件（没有这个
///     事件名），所以谁调谁就得说一声（[noteShown] / [noteHidden] / [noteRestored]）。
///     托盘那几条路在 `app.dart` 的 `TrayActions` 里，关窗收进托盘在 `main.dart`。
///
/// ## 一条分寸
///
/// **值没变就不写**：`focus=true` 连着来两次（窗口被反复激活）只留第一行。
/// 这几行是"状态变了"的记录，不是事件流水——托盘与页面都可能是连着触发两次的，
/// 按事件记会让人误以为"切了两次"。
library;

import 'package:window_manager/window_manager.dart';

import 'gui_log.dart';

/// 窗口可见性的三态（`[win] visibility=` 的值）。
///
/// 为什么是三种而不是两种：**最小化**与**收进托盘**在日志里必须是两件事——
/// 前者人自己点得回来（任务栏还在），后者只能从托盘菜单回来（入口更窄），
/// 排障时"他从哪个入口回来"正是关键那条线索。
enum WinVisibility {
  /// 在屏幕上（有焦点与否是另一行的事）
  visible,

  /// 收进托盘（`windowManager.hide()`；窗口不在任务栏里）
  hidden,

  /// 最小化（还在任务栏里）
  minimized,
}

/// 窗口状态的最近一态 + 写那三行的唯一入口。
///
/// 全局一份（[instance]）：窗口是**进程级**的，只有一个。
class WinTrace extends WindowListener {
  WinTrace._();

  static final WinTrace instance = WinTrace._();

  /// 最近一次的可见性（初值按"窗口建好就是可见"算——runner 一建好就 show）
  WinVisibility visibility = WinVisibility.visible;

  /// 最近一次的焦点状态
  bool focused = false;

  bool _attached = false;

  /// 挂上 `window_manager` 的事件监听。**只在真机入口（`main.dart`）调一次**。
  ///
  /// 挂不上（插件没初始化/在用例里跑）就静默放弃：窗口状态少三行不影响界面。
  void attach() {
    if (_attached) return;
    try {
      windowManager.addListener(this);
      _attached = true;
    } catch (_) {
      _attached = false;
    }
  }

  /// 拆掉监听（退出流程用，与 [attach] 成对）
  void detach() {
    if (!_attached) return;
    _attached = false;
    try {
      windowManager.removeListener(this);
    } catch (_) {
      // 拆不掉也不该拦住退出
    }
  }

  /// 窗口**从托盘回来**了（人点了托盘「显示界面」/「有 N 条待批」/「有新版本」）。
  ///
  /// 单独一行 `[win] restore`：它回答的是"这个窗口是被谁叫回来的"，
  /// 与"现在可见"是两件事（可见性那一行可能本来就是 visible，那时 [noteShown] 不写）。
  void noteRestored() {
    guiLog.write('[win] restore');
    noteShown();
  }

  /// 我们自己把它显示出来了（不是从托盘恢复的）
  void noteShown() => setVisibility(WinVisibility.visible);

  /// 我们自己把它收起来了（关窗收进托盘 / 托盘「收进托盘」）
  void noteHidden() => setVisibility(WinVisibility.hidden);

  /// 记可见性。值没变就不写（见文件头"一条分寸"）。
  void setVisibility(WinVisibility next) {
    if (visibility == next) return;
    visibility = next;
    guiLog.write('[win] visibility=${next.name}');
  }

  /// 记焦点。值没变就不写。
  void setFocused(bool next) {
    if (focused == next) return;
    focused = next;
    guiLog.write('[win] focus=$next');
  }

  // ── 插件事件（系统告诉我们的那四种） ──

  @override
  void onWindowFocus() => setFocused(true);

  @override
  void onWindowBlur() => setFocused(false);

  @override
  void onWindowMinimize() => setVisibility(WinVisibility.minimized);

  @override
  void onWindowRestore() => setVisibility(WinVisibility.visible);
}
