/// 界面要连的**后端端口**：三级来源，优先级从高到低。
///
/// ## 为什么不再只读环境变量（2026-10-26 的事故）
///
/// 原来只有一行：
/// ```dart
/// final port = Platform.environment['IRMIA_WEB_PORT'] ?? '7788';
/// ```
/// 而环境变量是**继承**来的。事故那天界面连到了 `1580`——一个根本没人听的端口
/// （屏幕上只有 `SocketException … port = 1580`，看不出是谁塞进来的）。后端起没起来、
/// 在哪个端口，**盘上有事实**；环境变量只是别人的记忆，还可能是脏的。
///
/// ## 三级（优先级从高到低）
///
///   ① **后端写的端口文件**：`%LOCALAPPDATA%\Irmia\server.json` →
///      `{"port":7788,"pid":58888,"since":"…"}`。后端在 **bind 成功那一刻**写它、退出时删掉
///      （`src/runtime/server-port-file.ts`）。这是唯一"有人对这件事负责"的一档；
///   ② 环境变量 `IRMIA_WEB_PORT`（保留：启动器 `packaging/start.ps1` 仍然这么传，
///      而且它是升级期唯一的兼容路径——后端还没写过端口文件时只有它有值）；
///   ③ 默认 `7788`（`config.example.json` 的出厂值）。
///
/// **字符串解析失败就当没有**：文件不是 JSON / `port` 不在 1..65535 / 文件读不动
/// ⇒ 顺着往下一档走。一个坏的提示位不许把界面指向一个瞎猜的端口。
///
/// 三档都连不上时界面**不崩**：停在那张"后端还没起来（正在等 :7788）"的卡上，
/// 每 2 秒重试一次（见 `app.dart` 的 `_scheduleGateRetry`），后端一起来就自己进门。
library;

import 'dart:convert';
import 'dart:io';

/// 出厂端口（与 `src/config/config.ts` 的 `web.port` 缺省值同值）
const int kDefaultBackendPort = 7788;

/// 端口文件的名字（与 `src/runtime/server-port-file.ts` 的 `SERVER_PORT_FILE_NAME` 同值）
const String kServerPortFileName = 'server.json';

/// 端口是从哪一档来的（日志里 `source=` 就是这三个词）
enum BackendPortSource {
  /// 后端 bind 成功时写的那份文件
  file,

  /// 环境变量 `IRMIA_WEB_PORT`
  env,

  /// 出厂默认 7788
  defaultPort,
}

/// 端口 + 它的来源（`source` 会原样进日志：`[net] waiting backend port=7788 source=file`）
class BackendPort {
  const BackendPort({required this.port, required this.source, this.pid, this.since});

  final int port;
  final BackendPortSource source;

  /// 端口文件里那个 pid（`source=file` 时才有；界面不再猜"是谁在听"，只是留痕）
  final int? pid;

  /// 端口文件的写入时刻（ISO 字符串；读不到就是 null）
  final String? since;

  /// 日志与界面上的那一档：`file` / `env` / `default`
  String get sourceLabel => switch (source) {
        BackendPortSource.file => 'file',
        BackendPortSource.env => 'env',
        BackendPortSource.defaultPort => 'default',
      };

  /// 从 `http://127.0.0.1:7788` 这样的 baseUrl 反推（测试与老装配点用）
  factory BackendPort.fromBaseUrl(String baseUrl) {
    final parsed = Uri.tryParse(baseUrl);
    final port = parsed?.port ?? 0;
    return BackendPort(
      port: port > 0 ? port : kDefaultBackendPort,
      source: BackendPortSource.defaultPort,
    );
  }

  /// 排障时的一行读数（**ASCII**：这是日志/调试串，不是界面文案——界面那句话走
  /// `AppStrings.gateWaitingBackend`，见 `auth_gate.dart`）。
  @override
  String toString() => 'http://127.0.0.1:$port (source=$sourceLabel${pid == null ? '' : ' pid=$pid'})';
}

/// 端口文件路径：`%LOCALAPPDATA%\Irmia\server.json`；拿不到 `LOCALAPPDATA` ⇒ null。
///
/// 路径口径与后端**只有这一处**（后端那份在 `src/runtime/server-port-file.ts`）。
String? serverPortFilePath(Map<String, String> env) {
  final local = (env['LOCALAPPDATA'] ?? '').trim();
  if (local.isEmpty) return null;
  return '$local${Platform.pathSeparator}Irmia${Platform.pathSeparator}$kServerPortFileName';
}

/// 读端口文件；不存在 / 读不动 / 不是 JSON / 字段不对 ⇒ null（**当没有**，不猜）。
BackendPort? readServerPortFile(String? path) {
  if (path == null || path.isEmpty) return null;
  try {
    final text = File(path).readAsStringSync();
    final decoded = jsonDecode(text);
    if (decoded is! Map) return null;
    final raw = decoded['port'];
    // `jsonDecode` 对整数给 int；`7788.0` 这种（不该出现）按坏文件处理
    if (raw is! int || raw <= 0 || raw > 65535) return null;
    final pid = decoded['pid'];
    final since = decoded['since'];
    return BackendPort(
      port: raw,
      source: BackendPortSource.file,
      pid: pid is int && pid > 0 ? pid : null,
      since: since is String && since.isNotEmpty ? since : null,
    );
  } catch (_) {
    // 读不动 / 半截 JSON（后端正在写）/ 不是 UTF-8：都按"没有这一档"处理
    return null;
  }
}

/// 解析环境变量里的端口；解析不出合法端口 ⇒ null（**当没有**）
BackendPort? parseEnvPort(String? raw) {
  final text = (raw ?? '').trim();
  if (text.isEmpty) return null;
  final port = int.tryParse(text);
  if (port == null || port <= 0 || port > 65535) return null;
  return BackendPort(port: port, source: BackendPortSource.env);
}

/// **三级来源**的唯一判据（纯函数：环境变量与端口文件路径都可注入，便于逐档验）
///
/// `env` 缺省读 `Platform.environment`；`portFilePath` 缺省按 `env` 推。
BackendPort resolveBackendPort({
  Map<String, String>? env,
  String? portFilePath,
}) {
  final environment = env ?? Platform.environment;
  final path = portFilePath ?? serverPortFilePath(environment);
  final fromFile = readServerPortFile(path);
  if (fromFile != null) return fromFile;
  final fromEnv = parseEnvPort(environment['IRMIA_WEB_PORT']);
  if (fromEnv != null) return fromEnv;
  return const BackendPort(port: kDefaultBackendPort, source: BackendPortSource.defaultPort);
}
