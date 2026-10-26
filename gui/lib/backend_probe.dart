/// **后端到哪一步了**——门前那三档提示与"每 2 秒自动重探一次"共用的唯一读数。
///
/// ## 它存在的理由（真机现场，2026-10-28）
///
/// 用户点「退出登录（清除本机凭据）」⇒ 停实例、清本机票、回选择页；他再想进来时，
/// 登录页把**三种完全不同的情况**混成了一句"连不上"：
///
///   ① 后端根本没起（`SocketException` / 连接被拒 / 超时）；
///   ② 后端**已经 bind、重活没干完**（`503 {starting:true, phase}`）——它其实正在起；
///   ③ 密码错（401）——后端好得很，是密码不对。
///
/// 三件事的下一步动作完全不同：①② 只要等（并且该自动重探），③ 要重输密码。
/// 混成一句的后果不是"话不好听"，而是人对着密码框反复重输，而真正的原因是主进程没在跑；
/// 而且那时候界面**不会自己再试**，16:19:35 后端 ready 之后屏幕上还停着 16:19:05 那句错。
///
/// ## 判据落在哪里
///
/// `GET /api/health`（**不需要凭据**，见 `src/web/preflight.ts`）：就绪前后**同一种形状**，
/// 只换 `status` / `phase`。启动期它答 `200 + {status:'starting', phase}`；其余 `/api` 答
/// `503 + {starting:true, phase}`。所以：
///
///   · 答得出 `status:'starting'`（或 503 + `starting:true`）⇒ [BackendReadiness.starting]；
///   · **答话了**但读不懂 / 没有这条端点（老后端 404、401）⇒ [BackendReadiness.ready]：
///     它在那儿并且回了话，那就不该被说成"没起来"；
///   · 连接类异常（连不上、超时）⇒ [BackendReadiness.down]。
///
/// `phase` 的四个值由服务端定义（`StartupPhase`），**原样带上来**：翻成人话是界面那一层的事
/// （`AppStrings.backendPhaseLabel`，中英语序不同，见 `i18n/app_strings.dart`）。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'api.dart';

/// 门前自动重探的节奏（秒）。
///
/// 三档提示里那句"正在重试…"说的就是这个数，门卡上那行小字"第 N 秒 · 已重试 M 次"也按它计数。
/// 2 秒的依据：回环上一次探测是毫秒级的事，而后端从 bind 到 ready 是几十秒的量级——
/// 2 秒既够快（她一起来就能进门），又不会在门前空转着每秒打一次。
const int kBackendRetrySeconds = 2;

/// 等这么久还没就绪 ⇒ 提示里追加"看 gui.log"那一句（秒）。
///
/// 60 秒与门前宽限窗口（`kGateGraceSeconds`）同一个数：**后端冷启动 35–42 秒**是实测值，
/// 60 秒还没就绪，就不该再让人对着"正在重试"干等了，得给一条去处的线索。
const int kBackendLogHintSeconds = 60;

/// 单次健康探测的时限：回环上要么几毫秒，要么根本没人在听。
const Duration kBackendProbeTimeout = Duration(seconds: 2);

/// 后端"能不能干活"的四档。`unknown` = 还没探过 / 探了但读不懂（不编造结论）。
enum BackendReadiness {
  /// 还没探过（或那一次探测什么也没读到）
  unknown,

  /// 连不上（SocketException / 连接被拒 / 超时）：**后端还没起来**
  down,

  /// 端口在听、重活没干完（`503 {starting:true, phase}`）：**后端正在启动**
  starting,

  /// 就绪（`/api/health` 说 ready，或者它答了话但这一版没有那条端点）
  ready,
}

/// 一次探测的读数：档位 + 服务端自己报的阶段（`events` / `mcp` / `channels` / `ready`）。
class BackendReading {
  const BackendReading(this.readiness, {this.phase = ''});

  /// 就绪的一份（常量，省得每次新建）
  static const BackendReading ready = BackendReading(BackendReadiness.ready);

  /// 连不上的一份
  static const BackendReading down = BackendReading(BackendReadiness.down);

  final BackendReadiness readiness;

  /// 服务端报的阶段名；空串 = 这一版后端不报（老后端 / 读不懂）
  final String phase;

  /// 可以干活了
  bool get isReady => readiness == BackendReadiness.ready;

  @override
  String toString() => 'BackendReading(${readiness.name}${phase.isEmpty ? '' : ' · $phase'})';
}

/// 把一份 `/api/health` 的应答读成 [BackendReading]。
///
/// **答话了**（不论内容）就至少是"它在"：只有 `status:'starting'` 才降一档成 [BackendReadiness.starting]。
/// 这样老后端（没有 `/api/health`，或者它被认证闸挡在后面）不会被人为说成"连不上"。
BackendReading readingOfHealth(Object? raw) {
  if (raw is Map) {
    final status = raw['status'];
    final phase = raw['phase'] is String ? raw['phase'] as String : '';
    if (status == 'starting') {
      return BackendReading(BackendReadiness.starting, phase: phase);
    }
  }
  return BackendReading.ready;
}

/// 探一次"当前这台后端能不能干活"（打 `/api/health`，走 [IrmiaApi] 那套时限与日志）。
///
/// 这个函数**只读不写**：它不动任何状态、不重试、不报错——门那一层拿它的返回值去决定
/// "说哪一档、要不要挂上每 2 秒一拍的重探"（见 `AppState._holdForBackend`）。
Future<BackendReading> probeBackend(IrmiaApi api) async {
  try {
    return readingOfHealth(await api.get('/api/health'));
  } on ApiError catch (err) {
    // `503 {starting:true, phase}`：端口在听、重活没干完。它不是错误，是"正在起"。
    if (err.starting) {
      return BackendReading(BackendReadiness.starting, phase: err.phase);
    }
    // 其余 4xx/5xx（老后端没有这条端点就是 404）：它答话了 ⇒ 不算"连不上"
    return BackendReading.ready;
  } on ApiAuthError {
    // 老后端把 `/api/health` 也挡在认证闸后面：同样是"它在那儿"
    return BackendReading.ready;
  } catch (_) {
    // SocketException / ApiTimeout / 任何"连不上"的形状：类型不同，含义只有一种
    return BackendReading.down;
  }
}

/// 探一台**指定的**实例（选择页等就绪时用：那时手上还没有 `AppState` 的 baseUrl）。
///
/// 与 [probeBackend] 的区别只在"打哪个地址"：这里用裸 `HttpClient`（理由同
/// `instances.dart` 的 `probeInstance`——选择页要同时问几台，不该走当前实例那套认证客户端）。
///
/// **绝不抛**，也**绝不编造阶段**：问不到就是 [BackendReadiness.unknown]（界面上就不显示阶段）。
Future<BackendReading> probeBackendAt(String host, int port) async {
  if (port <= 0 || port > 65535) return const BackendReading(BackendReadiness.unknown);
  final client = HttpClient()..connectionTimeout = kBackendProbeTimeout;
  try {
    final req = await client.getUrl(Uri.parse('http://$host:$port/api/health'));
    final res = await req.close().timeout(kBackendProbeTimeout);
    final text = await res.transform(utf8.decoder).join().timeout(kBackendProbeTimeout);
    Object? decoded;
    try {
      decoded = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      decoded = null;
    }
    if (res.statusCode == 200) return readingOfHealth(decoded);
    if (res.statusCode == 503 && decoded is Map) {
      final phase = decoded['phase'] is String ? decoded['phase'] as String : '';
      return BackendReading(BackendReadiness.starting, phase: phase);
    }
    return const BackendReading(BackendReadiness.unknown);
  } catch (_) {
    // 连不上 / 超时 / 不是 JSON：都是"问不出阶段"，不是"它没在起"
    return const BackendReading(BackendReadiness.unknown);
  } finally {
    client.close(force: true);
  }
}
