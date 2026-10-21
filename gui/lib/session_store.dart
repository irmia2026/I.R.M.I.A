/// 会话凭据的本地存储 —— **一个实例一份文件**。
///
/// ## 它修的是哪个坑（值得写下来，因为这条 bug 的形状很典型）
///
/// 过去 GUI 把凭据存在 `%APPDATA%\Irmia\gui-token`：一个**全局路径**。于是同一台机器上
/// 起第二个实例（换个数据目录、换个端口）时，第二个会把第一个的凭据**覆盖**掉；
/// 第一个界面下一次请求就 401，人就"突然进不去了"——而且看不出为什么，因为什么都没报错。
///
/// 根治办法不是"记住哪个 token 更新"，而是**让两份凭据根本不共用一个位置**：
/// 目录按**实例标识**分，而实例标识由服务端给（`<host>:<port>#<数据目录哈希>`，见
/// src/web/server.ts 的 instanceIdOf）。数据目录只有服务端知道，所以界面必须从
/// 401 的响应体 / 认证响应里把它读回来——那也是 GUI 启动时第一件事要做的。
///
/// ## 纪律
///
/// · **一个文件只放一串 token**（没有 JSON、没有时间戳）：它是凭据不是数据库，
///   越简单的格式越不容易读坏；真读坏了也只等于"要重新登录一次"。
/// · 读写一律**失败静默**：写不进去本次会话内照常能用，读不出来就是"没有凭据"——
///   凭据存储的问题绝不该让界面白屏。
/// · 路径做**白名单净化**（见 [SessionStore.sanitize]）：实例标识里有 `:` 与 `#`，
///   而 Windows 文件名不允许 `:`。净化是确定性的，同一个实例永远映射到同一个文件。
library;

import 'dart:io';

/// 存储根目录覆盖：测试指向临时目录，避免踩到真实 `%APPDATA%`。
///
/// 做法照 `ui_state.dart` 的 `stateFileOverride`：整份测试文件设一次，
/// 所有 `SessionStore` 就都落在那个临时目录里，不必逐个注入。
String? _sessionsRootOverride;

String? get sessionsRootOverride => _sessionsRootOverride;

set sessionsRootOverride(String? path) {
  _sessionsRootOverride = path;
}

/// 会话凭据库：按实例标识分文件。
class SessionStore {
  SessionStore({String? root}) : _root = root;

  final String? _root;

  /// 根目录：`%APPDATA%\Irmia\sessions`（没有 APPDATA 时退到系统临时目录——
  /// 那种环境里"能跑起来"比"存得住"重要）。
  String get root {
    final explicit = _root ?? _sessionsRootOverride;
    if (explicit != null && explicit.isNotEmpty) return explicit;
    final appData = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
    return '$appData${Platform.pathSeparator}Irmia${Platform.pathSeparator}sessions';
  }

  /// 实例标识 → 文件名。**白名单**而不是黑名单：只留下 `[A-Za-z0-9._-]`，
  /// 其余一律换成 `_`。黑名单（"把 `:` 换掉"）迟早漏掉某个平台上的非法字符，
  /// 而这里漏一个就是一个"凭据写不进去、人登不上"的怪故障。
  static String sanitize(String instance) {
    final trimmed = instance.trim();
    if (trimmed.isEmpty) return 'unknown';
    final buffer = StringBuffer();
    for (final rune in trimmed.runes) {
      final ch = String.fromCharCode(rune);
      buffer.write(RegExp(r'[A-Za-z0-9._-]').hasMatch(ch) ? ch : '_');
    }
    // 上限：实例标识本来就短，防的是有人把一整段路径塞进来当标识
    final name = buffer.toString();
    return name.length <= 120 ? name : name.substring(0, 120);
  }

  String pathFor(String instance) =>
      '$root${Platform.pathSeparator}${SessionStore.sanitize(instance)}';

  /// 读该实例的凭据：文件不存在 / 空 / 读不了都回 null（**绝不抛**）。
  String? read(String instance) {
    try {
      final file = File(pathFor(instance));
      if (!file.existsSync()) return null;
      final value = file.readAsStringSync().trim();
      return value.isEmpty ? null : value;
    } catch (_) {
      return null;
    }
  }

  /// 写该实例的凭据。写不进去也**不算错**：本次会话内 token 在内存里，照常能用；
  /// 只是下次开界面要重新登录一次——那比"弹一个红色的保存失败"更接近人真正在意的事。
  void write(String instance, String token) {
    final value = token.trim();
    if (value.isEmpty) return;
    try {
      final file = File(pathFor(instance));
      file.parent.createSync(recursive: true);
      file.writeAsStringSync(value);
    } catch (_) {
      // 见上：静默
    }
  }

  /// 删掉该实例的凭据（登出、或被服务端告知"这张票不作数了"）。
  void clear(String instance) {
    try {
      final file = File(pathFor(instance));
      if (file.existsSync()) file.deleteSync();
    } catch (_) {
      // 删不掉也不影响：内存里那份已经清掉了，401 会让界面回到登录态
    }
  }
}

/// 老界面把凭据存在哪里：`%APPDATA%\Irmia\gui-token`（**一个全局路径**）。
///
/// ## 为什么还要读它（升级期的一次性兜底）
///
/// 这个路径正是本轮修掉的那个坑：**所有实例共用一份**，第二个实例一启动就把第一个的顶掉。
/// 新的存放是"一个实例一份文件"（见上），这里**不再往里写**。
///
/// 但**还得读一次**：半升级状态（界面换成了按会话认证的新版，而后端还是老的按 token 认证，
/// 或者后端换了新版但人还没设过密码）下，用户手上唯一还有效的凭据就是它。不读它，
/// 界面会停在"设置密码"那一屏——那本身没错（设一个就进去了），但如果他此刻**只想先用起来**，
/// 那就等于被升级锁在了门外。读它只是把这条老路留到"设密码那一刻"为止：
/// 一旦设了密码，服务端当场作废 `data/.ui-token`，这个文件也就再也验不过了。
///
/// 读不到 / 空 / 出错一律回 null（与上面同一套"绝不抛"的纪律）。
/// 老界面那份全局凭据的路径覆盖（测试用）：指向临时文件，避免踩真实 `%APPDATA%`。
String? _legacyGuiTokenOverride;

String? get legacyGuiTokenOverride => _legacyGuiTokenOverride;

set legacyGuiTokenOverride(String? path) {
  _legacyGuiTokenOverride = path;
}

String legacyGuiTokenPath() {
  final override = _legacyGuiTokenOverride;
  if (override != null && override.isNotEmpty) return override;
  final appData = Platform.environment['APPDATA'] ?? Directory.systemTemp.path;
  return '$appData${Platform.pathSeparator}Irmia${Platform.pathSeparator}gui-token';
}

String? readLegacyGuiToken() {
  try {
    final file = File(legacyGuiTokenPath());
    if (!file.existsSync()) return null;
    final value = file.readAsStringSync().trim();
    return value.isEmpty ? null : value;
  } catch (_) {
    return null;
  }
}
