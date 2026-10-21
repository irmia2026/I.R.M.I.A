/// 壳的界面状态持久化：把「更多」折叠组这类纯 UI 偏好写到
/// `%APPDATA%/Irmia/ui-state.json`。
///
/// 零依赖（只用 dart:io + dart:convert，不引 shared_preferences）；
/// 读写一律失败静默——状态文件丢了只是回到默认值，不该影响使用。
/// 做法照 AstrBot `VerticalSidebar.vue` 的 `sidebar_openedItems`：
/// 只记「哪些组是展开的」，读回来缺项即折叠。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

// ValueNotifier：把「关窗时收进托盘」的内存镜像给窗口关闭回调用（那里做不了异步读盘）
import 'package:flutter/foundation.dart';

/// 「关窗时收进托盘」这个偏好在本机状态文件里的键名。
///
/// **出厂默认 true（关窗 = 收进托盘，不退出界面；2026-10-21 用户裁决）**。
/// 键还在、只是缺省值翻了：显式写过的 `false` 照旧优先（"关窗=退出界面"），只有**没写过**
/// 或那份文件读不出来时才落到这个默认值。
///
/// 历史（别把这段删掉，它解释了这一格为什么反复）：2026-10-04 曾改成默认 false，理由是
/// Windows 11 默认把新出现的托盘图标收进"隐藏的图标"面板（通知区域那个 `^` 里）——
/// 于是"关窗收托盘"在用户体验里就是"窗口消失、再也找不回来"（踩过两次）。那条风险今天仍在，
/// 但用户 2026-10-21 明确要的是"出厂就是开"，所以：默认开，同时**保留**下面两道保险——
///   · 托盘**没装成**时 `main.dart` 的关窗回调绝不会隐藏窗口（宁可直接退出，也不把界面丢进黑洞）；
///   · 想回到旧行为的人在设置页关掉这个开关即可（那是显式选择，落盘后下次启动照办）。
const kCloseToTrayFlag = 'close-to-tray';

/// 「关窗时收进托盘」的**出厂默认值**（2026-10-21 用户裁决：默认开启）。
///
/// 单独抽成常量而不是在两处各写一个字面量：内存镜像的初值与"读不到偏好时的回落值"
/// 必须是同一个数，否则会出现"启动第一帧显示开、真正关窗时按关处理"这种鬼现象。
const kCloseToTrayDefault = true;

/// 开关的内存镜像（只读方拿它，写方走 [setCloseToTray]）。
///
/// 为什么要有这个东西而不是每次去问文件：窗口的关闭事件是**同步**回调
/// （window_manager 的 `onWindowClose`），里面来不及做一次异步读盘；
/// 而 main() 启动时已经读过一次盘了。设置页改开关时同步更新它 + 落盘，
/// 于是"设置页打开开关 → 关窗就收进托盘"在同一次运行里也成立。
final ValueNotifier<bool> closeToTray = ValueNotifier<bool>(kCloseToTrayDefault);

/// 改「关窗时收进托盘」：先更新内存镜像（立刻生效），再落盘（下次启动读它）。
Future<void> setCloseToTray(bool value) {
  closeToTray.value = value;
  return saveFlag(kCloseToTrayFlag, value);
}

/// 从状态文件读回「关窗时收进托盘」（读不到即出厂默认 [kCloseToTrayDefault]）。
///
/// 启动时调一次；**结果同时灌进 [closeToTray]**，免得读到的值与内存镜像两处不一致。
Future<bool> restoreCloseToTray() async {
  final value = await loadFlagOr(kCloseToTrayFlag, kCloseToTrayDefault);
  closeToTray.value = value;
  return value;
}

/// 状态文件路径覆盖：测试指向临时文件，避免踩到真实 %APPDATA% 里的状态。
/// 换文件即重开写入队列——旧链上没跑完的写入属于旧文件。
String? _override;

String? get stateFileOverride => _override;

set stateFileOverride(String? path) {
  _override = path;
  _queue = Future<void>.value();
}

/// 当前状态文件路径（Windows 上 `%APPDATA%/Irmia/ui-state.json`）
String stateFilePath() {
  final override = _override;
  if (override != null && override.isNotEmpty) return override;
  final appData = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
  return '$appData${Platform.pathSeparator}Irmia${Platform.pathSeparator}ui-state.json';
}

/// 写入队列：loadFlag/saveFlag 串行落盘，避免并发读改写互相覆盖
Future<void> _queue = Future<void>.value();

/// 读一个布尔开关：**三态**——`true` / `false` / `null`（未知）。
///
/// 分档的口径只有一句：**"没有记录" = false，"记录坏了" = null**。
///   · 文件不在 ⇒ false：还没有任何记录，也就是"从没问过"——真·首次安装就长这样，
///     这时该弹首次引导，不能因为"状态文件还没被创建"就把新用户挡在引导外面；
///   · 文件在、那个键不在 ⇒ false：同上，只是别的键已经写过；
///   · 文件在、键是布尔 ⇒ 原样（true / false）；
///   · 文件在但读不动 / JSON 坏了 / 顶层不是对象 / 值不是布尔 ⇒ null（未知）——
///     这一档才是"防误弹"：记录坏了不等于"从没问过"，把不知道说成没问过就是 fail-open，
///     老用户会被挡一张"首次启动"的卡。
///
/// 调用方自己决定未知算什么：引导判据那边未知 = **不弹**（与 `identityIsSeed == null`
/// 同一条口径，见 onboarding.dart 的 [shouldShowOnboarding]）；「关窗时收进托盘」那种
/// **有出厂默认值**的开关走 [loadFlagOr]，语义不受影响。
Future<bool?> loadFlag(String key) async {
  await _queue;
  try {
    final file = File(stateFilePath());
    // 文件不在 = 没有记录 = 没问过（不是"未知"：首次安装时它本来就不存在）
    if (!await file.exists()) return false;
    final decoded = jsonDecode(await file.readAsString());
    // 文件在但内容不是一份状态对象 ⇒ 记录坏了（未知），别当成"没问过"
    if (decoded is! Map) return null;
    if (!decoded.containsKey(key)) return false;
    final value = decoded[key];
    return value is bool ? value : null;
  } catch (_) {
    // 读不动 / 不是合法 JSON / 不是 UTF-8 文本 ⇒ 记录坏了
    return null;
  }
}

/// 读一个布尔开关，**带出厂默认值**：文件不存在、JSON 坏了、键缺失都回落到 [fallback]。
///
/// 与 [loadFlag] 的分工：那个是三态（缺项 false、读不到 null），调用方自己决定未知算什么；
/// 这个只给**默认该是开**的开关用——今天是「关窗时收进托盘」（[kCloseToTrayDefault]）。
/// 两个函数并存而不是给 [loadFlag] 加个可选参数：那会让 6 处既有调用点都多一个能写错的默认值。
Future<bool> loadFlagOr(String key, bool fallback) async {
  await _queue;
  try {
    final file = File(stateFilePath());
    if (!await file.exists()) return fallback;
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map) return fallback;
    final value = decoded[key];
    return value is bool ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

/// **测试注入点**：原子写的最后一步（把 `*.tmp` 盖到正式文件上）。
///
/// 正常运行时是 null（走 `tmp.rename`）；用例把它换成一个**会抛的桩**，验证
/// "写到一半失败 ⇒ 原文件保持旧内容、不留 `.tmp`"；也可以用它数"到底写了几次"
/// （见 `test/ui_state_test.dart` 与 `test/mention_prompt_test.dart`）。
@visibleForTesting
Future<void> Function(File tmp, File target)? stateFileRenameOverride;

/// 写一个布尔开关：读改写整份文件，失败静默；并发调用按调用顺序串行
Future<void> saveFlag(String key, bool value) {
  final next = _queue.then((_) => _updateState(key, value));
  _queue = next;
  return next;
}

/// 读改写整份状态文件；落盘走 [_writeAtomically]，失败静默。
///
/// 两档失败分开处理：
///   · **原文件读不出来 / JSON 坏了**：这份记录已经没救了，**重建成只含这一次写入的
///     干净 JSON**。不重建的话"记录坏了 ⇒ 未知"会永远持续：读永远读到未知，写也永远
///     写不进去（旧实现直接 catch 掉，坏一次就再也修不回来）；
///   · **写入本身失败**（磁盘满 / 句柄被占）：静默，原文件保持上一份完整内容。
///
/// 为什么要原子写：直接 `writeAsString` 在写到一半时被打断（进程被杀、磁盘满）会留下
/// **半截 JSON**，那正好落进"记录坏了"这一档，所有开关一起丢。同目录 rename 在本地
/// 文件系统上是原子的：要么还是旧的整份，要么已经是新的整份，不存在"两边都不像"的中间态。
Future<void> _updateState(String key, Object value) async {
  try {
    final file = File(stateFilePath());
    final flags = <String, dynamic>{};
    if (await file.exists()) {
      Map<dynamic, dynamic>? existing;
      try {
        final decoded = jsonDecode(await file.readAsString());
        if (decoded is Map) existing = decoded;
      } catch (_) {
        // 坏 JSON / 读不动：当作"没有可用的旧记录"，下面整份重建
      }
      if (existing != null) {
        try {
          flags.addAll(existing.cast<String, dynamic>());
        } catch (_) {
          // 键不是字符串：同一档"记录坏了"，重建（救回来多少留多少，新键照样写）
        }
      }
    }
    flags[key] = value;
    await file.parent.create(recursive: true);
    await _writeAtomically(file, jsonEncode(flags));
  } catch (_) {
    // 写不进去不影响使用：本次会话内照常按内存里的值渲染
  }
}

/// 把整份内容**原子地**写到 [file]：同目录写 `<path>.tmp`，flush 之后 rename 盖过去。
///
/// 任何一步失败都会在 `finally` 里把半截的 `.tmp` 删掉——状态目录里不该留下垃圾；
/// 删不掉也静默（目标是"不留半截"，不是"删文件也不许报错"）。原文件在 rename 成功
/// 之前一个字节都不会动，所以失败时它仍是**上一份完整内容**。
Future<void> _writeAtomically(File file, String body) async {
  final tmp = File('${file.path}.tmp');
  try {
    await tmp.writeAsString(body, flush: true);
    final rename = stateFileRenameOverride ?? _renameOver;
    await rename(tmp, file);
  } finally {
    try {
      if (await tmp.exists()) await tmp.delete();
    } catch (_) {
      // 见上：清不掉不影响"原文件还是旧的整份"这个结局
    }
  }
}

Future<void> _renameOver(File tmp, File target) async {
  await tmp.rename(target.path);
}

/// 读一个**字符串**偏好（语言就是走这条）：文件不存在、JSON 坏了、键缺失都当作 null。
///
/// 为什么不给布尔开关凑合（比如把语言存成一堆 `language-zh = true`）：那是把三态
/// 拍成三张布尔，读的时候还要互斥一遍，读坏一处就自相矛盾。字符串原样存、原样读，
/// 认不出的值由调用方兜底（见 `i18n/strings_scope.dart` 的 `kLanguageFlag`）。
Future<String?> loadString(String key) async {
  await _queue;
  try {
    final file = File(stateFilePath());
    if (!await file.exists()) return null;
    final decoded = jsonDecode(await file.readAsString());
    if (decoded is! Map) return null;
    final value = decoded[key];
    return value is String ? value : null;
  } catch (_) {
    return null;
  }
}

/// 写一个字符串偏好：读改写整份文件，失败静默；并发调用按调用顺序串行
/// （与 [saveFlag] 共用同一条 [_queue]——两处各写一份就会有互相覆盖的窗口）。
Future<void> saveString(String key, String value) {
  final next = _queue.then((_) => _updateState(key, value));
  _queue = next;
  return next;
}
