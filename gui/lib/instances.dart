/// **实例登记表**（`%APPDATA%\Irmia\instances.json`）——界面这一半：读、删、判活、拉起。
///
/// ## 真相源在哪
///
/// 盘上那一份是**唯一真相源**，而**写**它的主力是**后端自己**（`src/runtime/instance-registry.ts`：
/// bind 成功那一刻写/更新自己那条，退出时把自己的 pid 清 0）。界面这一侧只做三件事：
///   ① **读**：实例选择页列出来的就是它（名字、端口、数据目录、该用哪个 node 跑哪个入口）；
///   ② **判活**：逐条 `GET http://127.0.0.1:<port>/api/instance`（2 秒超时）——**不猜**
///      "pid 是不是还活着"，直接问那一台；问得通才算运行中；
///   ③ **删除**：只允许删**没在跑**且**非默认**的条目（判据见 [canDelete]），删完把整份文件
///      原子写回去（与后端同一套 `tmp → rename`），**别人的条目逐字段原样保留**。
///
/// ## 为什么界面也要写它
///
/// 有两件事没有后端端点可打，只能由界面直接改这份 JSON：
///   · **删除实例**——那一台已经没在跑了，没人替你办；
///   · **给实例改名**——目标可能根本没在跑（没有进程能接这条命令），而名字又是选择页上
///     唯一的标签。改的时候把 `nameSource` 写成 `manual`，后端此后**永不覆盖**它
///     （见 [InstanceBook.renameById]）。
///
/// 风险与分寸（两件事同一条）：
///   · 只改解出来的**目标那一条**（其余条目由后端自己维护），所以并发窗口极小；
///   · 写之前**现读**一次、只改目标 id、其余条目连未知字段一起原样带回去（[InstanceBook]）；
///   · 原子写（先写 `.tmp` 再 rename）：半截 JSON 会把整张表读废，那比"改不成"严重得多。
///
/// ## 拉起后端（"启动并登录"与"新建实例"共用）
///
/// 用登记表里的 `nodeExe` / `entry` / `dataDir` 拼出那条命令行：
/// `nodeExe` + `--max-old-space-size=1024` + `entry` + `--data-dir` + `dataDir`；
/// 工作目录 = **entry 所在安装根**（安装根下的 `dist/main.js` ⇒ 安装根本身）。
/// 这几格只有后端知道，界面**不猜路径**（`docs/gui-guard.md` 那条纪律）。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'backend_stop.dart';
// `GET /api/health` 的读数（选择页等就绪时那句"还在启动（阶段 …）"读它）
import 'backend_probe.dart';

/// 文件名（与 `src/runtime/instance-registry.ts` 的 `INSTANCES_FILE_NAME` 同值）
const String kInstancesFileName = 'instances.json';

/// 轮询判活的超时（毫秒）：回环上一次 HTTP 要么几毫秒，要么根本没人在听
const Duration kInstanceProbeTimeout = Duration(seconds: 2);

/// 「启动并登录」等就绪的上限：冷启动本机实测 35–42 秒（23 万条事件首折），180 秒是宽限
const int kInstanceReadyTimeoutSeconds = 180;

/// 等端口消失的上限（登出第三步；与产品口径同一个数）
const int kInstanceStopTimeoutSeconds = 20;

/// 新建实例时端口从哪个开始往上找（出厂端口，与 `backend_port.dart` 同值）
const int kFirstInstancePort = 7788;

/// 「结束这个实例」的命令名：服务端 `CONFIRM_PHRASES` 的键，也是 `X-Confirm` 头要带的那半截
/// （与 `src/web/server.ts` 同值）。
const String kStopInstanceCommand = 'stop-instance';

/// 端点（`/api/commands/stop-instance`）
const String kStopInstancePath = '/api/commands/$kStopInstanceCommand';

/// 选择页上一次失败的**种类**。
///
/// 状态层只记种类、不拼句子（`AppState` 没有 BuildContext，而中英的语序不一样）：
/// 页面拿它去 [AppStrings] 取这个语言的那一句。
enum InstanceGateProblem {
  /// 没出错
  none,

  /// 登记表里那条没有可用端口（从来没启动成功过 / 文件被手改坏了）
  noPort,

  /// 那个端口上住着**另一台**实例（id 对不上）：不许连上去（跨实例）
  portTaken,

  /// 没记着拉起它用的 node/entry（登记表缺格）
  noLauncher,

  /// 拉起失败（进程没起来）
  launchFailed,

  /// 等它就绪超时（180 秒）
  notReady,

  /// 7788 起向上找不到空闲端口
  portUnavailable,

  /// 新建表单：名字空着
  nameRequired,

  /// 新建表单：目录已存在且非空（要么换名、要么「用这个目录」）
  dirNotEmpty,

  /// 删除被拒：它还在跑
  cannotDeleteRunning,

  /// 删除被拒：它是默认实例
  cannotDeleteDefault,

  /// 删除失败：写盘没成（登记表现在不可信，别当成删掉了）
  removeFailed,

  /// 改名失败：写盘没成（名字没写进登记表，页面还显示旧的那个）
  renameFailed,
}

/// 新建实例的**默认数据目录**：`<数据目录的父目录>\instances\<名字>`。
///
/// 为什么按"数据目录的父目录"算：本机部署形状是 程序 `<安装根>\app`、数据 `<数据根>\data`
/// （config.json 里显式写着），所以 `<父目录>\instances` = `<数据根>\instances`——与产品口径
/// 那个例子逐字相同。而全新机器（数据目录 = `<安装根>\data`）算出来是 `<安装根>\instances\<名字>`，
/// 也落在同一个安装根里（备份/迁移时不用记第二个地方）。
///
/// [root] 为空（一个已知数据目录都没有）⇒ 只回名字本身：那种时候界面还没有能力猜出一个
/// 像样的绝对路径，与其编一个，不如让人自己填。
String instanceDirUnder(String name, {String root = ''}) {
  final clean = name.trim();
  final base = root.trim();
  if (base.isEmpty) return clean;
  var trimmed = base;
  while (trimmed.endsWith(Platform.pathSeparator) || trimmed.endsWith('/')) {
    trimmed = trimmed.substring(0, trimmed.length - 1);
  }
  return '$trimmed${Platform.pathSeparator}$clean';
}

/// 数据目录 → 它所在的那个 `instances` 根（[instanceDirUnder] 的 `root`）
String instancesRootOf(String dataDir) {
  final trimmed = dataDir.trim();
  if (trimmed.isEmpty) return '';
  final cut = trimmed.lastIndexOf(RegExp(r'[\\/]'));
  // 没有分隔符（`D:` 这种坏值）⇒ 不猜
  if (cut <= 0) return '';
  return '${trimmed.substring(0, cut)}${Platform.pathSeparator}instances';
}

/// 注册表文件的路径覆盖（测试用；做法照 `session_store.dart` 的 `sessionsRootOverride`）
String? _instancesFileOverride;

String? get instancesFileOverride => _instancesFileOverride;

set instancesFileOverride(String? path) {
  _instancesFileOverride = path;
}

/// 登记表路径：`%APPDATA%\Irmia\instances.json`；没有 `APPDATA` 时退到系统临时目录
/// （那种环境里"读得到"比"放得对"重要，与 `session_store.dart` 同一条口径）。
String instancesFilePath({Map<String, String>? env}) {
  final override = _instancesFileOverride;
  if (override != null && override.isNotEmpty) return override;
  final environment = env ?? Platform.environment;
  final appData = (environment['APPDATA'] ?? '').trim();
  final root = appData.isEmpty ? Directory.systemTemp.path : appData;
  return '$root${Platform.pathSeparator}Irmia${Platform.pathSeparator}$kInstancesFileName';
}

/// 一条实例记录（字段与后端那份逐字段同形；界面只用其中几格）。
class InstanceEntry {
  const InstanceEntry({
    required this.id,
    required this.name,
    required this.dataDir,
    required this.host,
    required this.port,
    required this.pid,
    required this.nodeExe,
    required this.entry,
    required this.isDefault,
    this.lastStartedAt = '',
    this.lastReadyAt = '',
  });

  final String id;
  final String name;
  final String dataDir;
  final String host;
  final int port;

  /// 后端写下的 pid；0 = 它自己说"我不在跑"。**它不是判活的依据**（见 [InstanceProbe]）
  final int pid;
  final String nodeExe;
  final String entry;
  final bool isDefault;
  final String lastStartedAt;
  final String lastReadyAt;

  /// 端口那一格能不能用（0 = 从没启动成功过 / 文件被手改坏了）
  bool get hasPort => port > 0 && port <= 65535;

  /// 界面上的地址（`127.0.0.1:7788`）
  String get address => '$host:$port';

  /// 能不能删：**没在跑** + **非默认**。
  ///
  /// `running` 由调用方现问一次（[InstanceProbe]）——`pid` 只是后端的自述，崩溃时它留着一
  /// 个死 pid，拿它当"在跑"会让人永远删不掉一个早就没了的实例；反过来拿它当"没在跑"则会
  /// 删掉一台活着的（那台的后端下次启动会把自己再登记回来，但界面上它"消失"过一次）。
  static bool canDelete({required InstanceEntry entry, required bool running}) =>
      !running && !entry.isDefault;

  @override
  String toString() => 'InstanceEntry($name · $address · pid=$pid${isDefault ? ' · default' : ''})';
}

/// `GET /api/instance` 的应答（**运行中**的那一台自述）。
///
/// 它同时是"判活"的判据：请求成不成（2 秒内）比任何字段都硬——问不通就是没在跑。
/// `id` 要与登记表里那条对上：端口被另一个实例占用时（换过目录、手改过配置），
/// 应答里会是**那一台**的 id，这时候判"不是在跑"才对（界面切过去会连错人）。
class InstanceProbe {
  const InstanceProbe({
    required this.id,
    required this.name,
    required this.dataDir,
    required this.port,
    required this.pid,
    required this.isDefault,
    required this.runningMs,
  });

  final String id;
  final String name;
  final String dataDir;
  final int port;
  final int pid;
  final bool isDefault;
  final int runningMs;

  /// 应答读不懂 / 字段缺失 ⇒ null（**当没在跑**，不猜）
  static InstanceProbe? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'];
    final port = raw['port'];
    if (id is! String || id.isEmpty) return null;
    if (port is! int || port <= 0 || port > 65535) return null;
    final runningMs = raw['runningMs'];
    return InstanceProbe(
      id: id,
      name: raw['name'] is String ? raw['name'] as String : '',
      dataDir: raw['dataDir'] is String ? raw['dataDir'] as String : '',
      port: port,
      pid: raw['pid'] is int ? raw['pid'] as int : 0,
      isDefault: raw['isDefault'] == true,
      runningMs: runningMs is int && runningMs >= 0 ? runningMs : 0,
    );
  }

  /// 这一台是不是登记表里那条（id 对得上才算——端口被别的实例占着时不算）
  bool matches(InstanceEntry entry) => id == entry.id;
}

/// 外部世界的替身口：**真机** = 真起进程 / 真打 HTTP；**用例** = 自己录一笔的假函数。
///
/// 为什么集中在这么一个对象里：选择页要用到的四件事（判活、探端口、拉进程、按端口停）
/// 每一件都会碰系统，而用例要断言的是"**顺序与判据**"（登出三步、stop=killed 的退化、
/// 端口选到 7789）。把四件事收进一个可替换的宿主，`AppState` 与页面一行都不用改。
class InstanceHost {
  const InstanceHost({
    required this.probe,
    required this.portAlive,
    required this.launch,
    required this.freePort,
    required this.killPort,
    this.health,
  });

  /// `GET http://host:port/api/instance`（2 秒超时）；问不通 ⇒ null
  final Future<InstanceProbe?> Function(String host, int port) probe;

  /// `GET http://host:port/api/health`：**它起没起、到哪一步了**（2026-10-28）。
  ///
  /// 只有一件事用它：选择页等一台实例就绪时，那句"已经等了 N 秒，它还在启动（阶段 …）"里
  /// 的阶段。**可选**（null = 不问）——用例里绝不该因为等一个假实例就跑一条真 socket
  /// （`flutter_test` 的假时钟里那种等待永远不会完成，整条用例会挂住）。
  final Future<BackendReading> Function(String host, int port)? health;

  /// TCP 探活（连得上就是还在听）
  final Future<bool> Function(String host, int port) portAlive;

  /// 拉起后端：返回 true = 进程真的起来了（不是"命令发出去了"）。
  /// `port` 是这台实例要听的端口（**必须给**：多实例下 config.json 只有一个 7788）。
  final Future<bool> Function({
    required String nodeExe,
    required String entry,
    required String dataDir,
    required int port,
  }) launch;

  /// 从 [from] 起向上找第一个空闲端口（探测 TCP，**不用系统随机端口**）；找不到 ⇒ null
  final Future<int?> Function(int from, String host) freePort;

  /// 按端口**强停**后端（登出第二步的退化路径；实现是 `backend_stop.dart` 那一套）
  final Future<BackendStopResult> Function(int port) killPort;

  /// 真机那一套
  static InstanceHost real() => InstanceHost(
        probe: probeInstance,
        health: probeBackendAt,
        portAlive: tcpAlive,
        launch: launchBackend,
        freePort: firstFreePort,
        killPort: (port) => stopBackendOnPort(port),
      );

  /// **什么都问不到的一份**（`AppState` 的缺省）。
  ///
  /// 为什么缺省是它而不是 `real()`：`AppState` 被上百条用例构造，任何一条都不该因为
  /// "没注入宿主"而去连本机回环——那种等待在 `flutter_test` 的假时钟里永远不会完成
  /// （真 socket 要真事件循环），整条用例会挂住不返回。真机在
  /// `_IrmiaAppState.initState` 里显式给 [InstanceHost.real]。
  static InstanceHost offline() => InstanceHost(
        probe: (host, port) async => null,
        portAlive: (host, port) async => false,
        launch: ({
          required String nodeExe,
          required String entry,
          required String dataDir,
          required int port,
        }) async =>
            false,
        freePort: (from, host) async => from,
        killPort: (port) async => const BackendStopResult(
          ok: true,
          pid: 0,
          // ASCII：这是给日志/用例看的现场描述，不是界面文案（界面文案在 AppStrings）
          detail: 'offline host: no process was stopped (test environment)',
        ),
      );
}

// ──────────────────────────────── 判活 / 探端口 ────────────────────────────────

/// `GET <host>:<port>/api/instance`：2 秒超时，问不通返回 null（**绝不抛**）。
///
/// 用裸 `HttpClient` 而不是 `IrmiaApi`：这条请求发生在**还没有 baseUrl / 还没有凭据**
/// 的时刻（选择页要同时问好几台），而且它是免凭据端点——走那个带 401 自愈与统一时限的
/// 客户端只会把"问一台不相干的实例"变成"可能触发当前实例的凭据重读"。
Future<InstanceProbe?> probeInstance(String host, int port) async {
  if (port <= 0 || port > 65535) return null;
  final client = HttpClient()..connectionTimeout = kInstanceProbeTimeout;
  try {
    final uri = Uri.parse('http://$host:$port/api/instance');
    final req = await client.getUrl(uri);
    final res = await req.close().timeout(kInstanceProbeTimeout);
    final text = await res.transform(utf8.decoder).join().timeout(kInstanceProbeTimeout);
    if (res.statusCode != 200) return null;
    return InstanceProbe.fromJson(jsonDecode(text));
  } catch (_) {
    // 连不上 / 超时 / 不是 JSON / 端口上是个别的服务：一律当"没在跑"
    return null;
  } finally {
    client.close(force: true);
  }
}

/// 从 [from] 起向上找第一个空闲端口（最多试 50 个）。
///
/// 为什么不用系统分配（`bind(0)`）：端口是**写进登记表**的东西，而登记表要跨重启稳定：
/// 系统随机端口每次启动都不一样，界面上的"127.0.0.1:xxxxx"就成了噪音，用户也没法把它
/// 填进任何别的地方。7788 起向上找是产品口径（见 `kFirstInstancePort`）。
Future<int?> firstFreePort(int from, String host, {int tries = 50}) async {
  for (var offset = 0; offset < tries; offset += 1) {
    final port = from + offset;
    if (port > 65535) return null;
    if (!await tcpAlive(host, port)) return port;
  }
  return null;
}

// ──────────────────────────────── 拉起后端 ────────────────────────────────

/// 入口脚本所在的**安装根**（`<install>/dist/main.js` ⇒ `<install>`；`<install>/main.js` ⇒ `<install>`）。
///
/// 只回答"这一层是不是构建目录"，不猜往上几层——与后端 `installRootOf` 同一条判据
/// （`src/runtime/instance-registry.ts`）。
String installRootOf(String entry) {
  final normalized = entry.replaceAll('/', Platform.pathSeparator);
  final parts = normalized.split(Platform.pathSeparator).where((part) => part.isNotEmpty).toList();
  if (parts.length <= 1) return normalized;
  parts.removeLast(); // 去掉文件名
  if (parts.isNotEmpty && parts.last.toLowerCase() == 'dist') parts.removeLast();
  final root = parts.join(Platform.pathSeparator);
  return root.isEmpty ? Platform.pathSeparator : root;
}

/// 拉起一个后端：返回 true = 进程真的起来了。
///
/// `<nodeExe> --max-old-space-size=1024 <entry> --data-dir <dataDir> --port <port>`，
/// 工作目录 = 安装根。`ProcessStartMode.detached`：**界面退出之后它要继续活着**
/// （它是一台独立的实例，不是界面的子进程；不然"登出=结束实例"之外的所有路都会在关窗时被杀掉）。
///
/// **`--port` 这一格不能省**（2026-10 多实例）：安装根的 `config.json` 只有一个 `web.port`
/// （出厂 7788），第二台实例照它去 bind 必然撞端口。界面选好的那个空闲端口必须**当场交给
/// 进程**——而且只有显式命令行这一条路（不走环境变量：继承来的端口正是 `backend_port.dart`
/// 文件头记的那次事故的形状）。
///
/// 老生代上限取 1024：与 `src/runtime/node-memory.ts` 的策略值同宽（那里是唯一真源，
/// 界面这一侧只是"拉它的时候照同一个数给"——给 512 的话，大日志实例会 OOM）。
Future<bool> launchBackend({
  required String nodeExe,
  required String entry,
  required String dataDir,
  required int port,
}) async {
  if (nodeExe.trim().isEmpty || entry.trim().isEmpty || dataDir.trim().isEmpty) return false;
  if (port <= 0 || port > 65535) return false;
  try {
    final process = await Process.start(
      nodeExe,
      <String>[
        '--max-old-space-size=1024',
        entry,
        '--data-dir',
        dataDir,
        '--port',
        '$port',
      ],
      workingDirectory: installRootOf(entry),
      mode: ProcessStartMode.detached,
    );
    // detached 模式下拿不到输出、也等不到退出：这里只确认"fork 成功"（pid 有效）
    return process.pid > 0;
  } catch (_) {
    return false;
  }
}

// ──────────────────────────────── 读 / 删 / 写 ────────────────────────────────

/// 一次读的结果：**条目 + 原始 JSON**（写回时要把不认识的字段一起带上）。
///
/// 为什么要保留原始 map 而不是"读成 [InstanceEntry] 再写回"：登记表是**后端写的**，
/// 字段会比界面认识的这一版多（版本升级、或者将来加的诊断格）。把不认识的一格丢掉，
/// 等于界面替后端做了一次**破坏性迁移**——那正是"别人的条目被弄丢"的另一种形状。
class InstanceBook {
  InstanceBook({
    required this.path,
    required this.raw,
    required this.entries,
    required this.readable,
    this.missing = false,
  });

  /// 文件路径（`null` = 这台机器上没有 APPDATA，什么都读不到）
  final String path;

  /// 顶层那份 JSON 可写回去的形状（读不出来时是 `{v:1, instances: []}`）
  final Map<String, dynamic> raw;

  /// 解析出来的条目（只认得出 id + dataDir 的那些行）
  final List<InstanceEntry> entries;

  /// 文件在且是合法 JSON（false = 不存在或读不出来；**界面上当"还没有实例"**）
  final bool readable;

  /// 文件根本不在（"还没有实例"那一档；与"有文件但读不出来"分开说）
  final bool missing;

  /// 现读一次（**绝不抛**）：不存在 / 半截 JSON / 顶层不是对象 ⇒ 空表 + `readable: false`。
  static InstanceBook load({String? path}) {
    final file = path ?? instancesFilePath();
    final empty = <String, dynamic>{'v': 1, 'instances': <dynamic>[]};
    String text;
    try {
      final handle = File(file);
      if (!handle.existsSync()) {
        return InstanceBook(path: file, raw: empty, entries: const [], readable: false, missing: true);
      }
      text = handle.readAsStringSync();
    } catch (_) {
      return InstanceBook(path: file, raw: empty, entries: const [], readable: false);
    }
    Object? decoded;
    try {
      decoded = jsonDecode(text);
    } catch (_) {
      // 半截 JSON（后端正在写）或者被手改坏了：当"没有实例"，**不猜、也不修**
      return InstanceBook(path: file, raw: empty, entries: const [], readable: false);
    }
    if (decoded is! Map) {
      return InstanceBook(path: file, raw: empty, entries: const [], readable: false);
    }
    final raw = decoded.cast<String, dynamic>();
    final list = raw['instances'];
    final entries = <InstanceEntry>[];
    if (list is List) {
      for (final item in list) {
        final entry = entryOf(item);
        if (entry != null) entries.add(entry);
      }
    }
    return InstanceBook(path: file, raw: raw, entries: entries, readable: true);
  }

  /// 一行 JSON → [InstanceEntry]；认不出（缺 id / dataDir）⇒ null
  static InstanceEntry? entryOf(Object? item) {
    if (item is! Map) return null;
    final id = item['id'];
    final dataDir = item['dataDir'];
    if (id is! String || id.trim().isEmpty) return null;
    if (dataDir is! String || dataDir.trim().isEmpty) return null;
    final port = item['port'];
    final host = item['host'];
    return InstanceEntry(
      id: id,
      name: item['name'] is String && (item['name'] as String).trim().isNotEmpty
          ? (item['name'] as String).trim()
          : dataDir.split(RegExp(r'[\\/]')).where((part) => part.isNotEmpty).last,
      dataDir: dataDir,
      host: host is String && host.trim().isNotEmpty ? host.trim() : '127.0.0.1',
      port: port is int && port > 0 && port <= 65535 ? port : 0,
      pid: item['pid'] is int && (item['pid'] as int) > 0 ? item['pid'] as int : 0,
      nodeExe: item['nodeExe'] is String ? item['nodeExe'] as String : '',
      entry: item['entry'] is String ? item['entry'] as String : '',
      isDefault: item['isDefault'] == true,
      lastStartedAt: item['lastStartedAt'] is String ? item['lastStartedAt'] as String : '',
      lastReadyAt: item['lastReadyAt'] is String ? item['lastReadyAt'] as String : '',
    );
  }

  /// 按 id 找一条
  InstanceEntry? byId(String? id) {
    if (id == null || id.isEmpty) return null;
    for (final entry in entries) {
      if (entry.id == id) return entry;
    }
    return null;
  }

  /// 拉起新实例要用的那三格（`nodeExe` / `entry` / `dataDir` 从哪来）。
  ///
  /// 优先级：**当前这一条** → 任何一条记着完整三格的 → null（都没有 ⇒ 界面没法拉起后端，
  /// 如实说"没有可用的启动路径"，而不是猜一个 `node`）。
  ({String nodeExe, String entry, String? dataDir})? launcherFor(String? currentId) {
    final ordered = <InstanceEntry>[
      ...entries.where((entry) => entry.id == currentId),
      ...entries.where((entry) => entry.id != currentId),
    ];
    for (final entry in ordered) {
      if (entry.nodeExe.trim().isNotEmpty && entry.entry.trim().isNotEmpty) {
        return (nodeExe: entry.nodeExe, entry: entry.entry, dataDir: entry.dataDir);
      }
    }
    return null;
  }

  /// 删掉一条（按 id），返回写盘成功与否。
  ///
  /// **只删目标那一条**：其余条目（含不认识的字段）原样带回去；写盘走 `tmp → rename`。
  /// 文件读不出来时**不动手**（`readable == false`）：没有可信的底稿就写回去，等于把
  /// 一个可能还有内容的文件覆盖成只剩一条空表——那比"删不掉"严重。
  Future<bool> removeById(String id) async {
    if (!readable) return false;
    final list = raw['instances'];
    if (list is! List) return false;
    final kept = <dynamic>[];
    var removed = 0;
    for (final item in list) {
      final entry = entryOf(item);
      if (entry != null && entry.id == id) {
        removed += 1;
        continue;
      }
      kept.add(item);
    }
    if (removed == 0) return false;
    raw['instances'] = kept;
    return writeAtomically(path, jsonEncode(raw));
  }

  /// 给一条实例**改名**（按 id），并把 `nameSource` 写成 `manual`。
  ///
  /// 为什么界面直接写盘而不是打后端端点：改名针对的可能是**根本没在跑**的那台（没有进程
  /// 可以接这条命令）；而登记表就是盘上唯一真相源，界面这一半本来就负责"删条目"这种
  /// 没人替它办的事（见文件头）。分寸与 [removeById] 相同：现读 → 只改目标那一条 →
  /// 其余条目（含不认识的字段）原样带回去 → `tmp → rename` 原子写。
  ///
  /// **`nameSource` 必须跟着写**：后端在 bind 那一刻有一次"旧条目升级"（名字还是目录末段
  /// ⇒ 用 `persona/IDENTITY.md` 解出来的名字替一次）。只改 `name` 不改来源，下一次重启
  /// 就会被后端当成"当时回落的"再盖掉——用户改的名字就丢了。`manual` 是"永不覆盖"那一档。
  ///
  /// 文件读不出来时**不动手**（同 [removeById]）：没有可信的底稿就写回去，等于把一份
  /// 可能还有内容的文件覆盖成只剩一条。
  Future<bool> renameById(String id, String name) async {
    if (!readable) return false;
    final clean = name.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (clean.isEmpty) return false;
    final list = raw['instances'];
    if (list is! List) return false;
    var renamed = false;
    for (final item in list) {
      if (item is! Map) continue;
      final entry = entryOf(item);
      if (entry == null || entry.id != id) continue;
      item['name'] = clean;
      item['nameSource'] = 'manual';
      renamed = true;
      break;
    }
    if (!renamed) return false;
    return writeAtomically(path, jsonEncode(raw));
  }

  /// 这条实例是不是**默认实例**（界面不许删；与后端 `isDefaultDataDir` 同一条口径）
  bool get hasDefault => entries.any((entry) => entry.isDefault);
}

/// 原子写：同目录 `.tmp` → rename 覆盖（半截 JSON 会把整张表读废）。
///
/// 与后端 `writeFileAtomicSync` 同一条纪律；那层退避重试这里省了：界面上"删除实例"是
/// 一个人点一下的动作，失败就如实说一句、让人再点一次，比在 UI 线程里睡一秒好。
Future<bool> writeAtomically(String path, String body) async {
  final tmp = File('$path.tmp');
  try {
    await tmp.parent.create(recursive: true);
    await tmp.writeAsString(body, flush: true);
    await tmp.rename(path);
    return true;
  } catch (_) {
    try {
      if (await tmp.exists()) await tmp.delete();
    } catch (_) {
      // 清不掉临时文件不影响结论
    }
    return false;
  }
}

