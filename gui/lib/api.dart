// TODO(i18n): 本文件还有 1 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/api.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
//
// 2026-10-24（"GUI 用久了会卡死"那一批）：超时那句话**走文案表**（[AppStrings.requestTimeout]）。
// 这个文件里一条中文字面量都没有——它是传输层，话归 `i18n/app_strings.dart` 管。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart' show ValueNotifier;

import 'gui_log.dart';
import 'i18n/app_strings.dart';
import 'i18n/strings_scope.dart';

/// 密码长度下限，与服务端 `src/web/auth.ts` 的 `PASSWORD_MIN_LEN` 同值。
///
/// **两边各留一份常量**是有意的：这一份只为了"在发请求之前就把话说清楚"（少一次
/// 白跑的往返），真正的判据永远在服务端——客户端校验是体验，不是边界。
/// 两边不一致时以服务端为准：它会回一句人话，界面照原样显示。
const int kPasswordMinLength = 6;

/// **建连**超时。只管 `Socket.startConnect` 那一下（dart:_http 里它只包在那里）。
///
/// 回环地址上它几乎立刻就有结论：要么连上（几毫秒），要么被拒（RST，也是几毫秒）。
/// 所以这个数取得宽一点没有代价——它**不覆盖整条请求**，别拿它当"请求超时"。
const Duration kApiConnectTimeout = Duration(seconds: 10);

/// **一条请求的总时限**：建连 → 发完 body → 服务端把响应头与**响应体**都写完。
///
/// 这个常量是 2026-10-23 那场"用久了卡死"的正面修复。此前的口径是
/// "connectionTimeout 就够了"——那是错的，而且错在最要命的那一段：
///
///   · `connectionTimeout` 只包建连；`openUrl` / `req.close()` / 读响应体
///     （`res.transform(utf8.decoder).join()`）**一个都没有时限**；
///   · 于是"连接建上了、服务端再也没说话"（进程卡在某个 await 里、或半死的 keep-alive
///     连接）这一种故障下，future **永远不会完成**；
///   · 上层每一个"等它回来再画"的地方（整页 `loading`、`_readingDashboard` 那道防重入闸、
///     待批轮询的 `_ticking`、聊天页的 `_loadingEarlier`）就永远出不来——
///     界面表现正是"永久转圈、点了没反应"，而进程本身健康（所以 `Responding=True`）。
///
/// 15 秒的依据：这是本机回环上的请求。最重的几条读端点（`/api/deps` 要跑探测、
/// `/api/protocol-side` 要读盘+探端口、`/api/events?limit=1000`）实测都在 1~3 秒一档，
/// 15 秒已经宽到"不该误杀"，又窄到"人还愿意等"。**已知会跑很久的端点单独放宽**
/// （见 [kApiLongRequestTimeout]），不许把全局这个数往上抬——抬一次，所有页面的
/// "永久 loading" 就跟着变长一次。
const Duration kApiRequestTimeout = Duration(seconds: 15);

/// 已知会跑很久的端点用的总时限（现在只有「一键安装」这一条）。
///
/// 它不是"没有超时"，而是"超时给到足够长"：那条端点实测约 104 秒，且**回执丢了
/// 不代表事情没发生**（服务端照跑）。所以给它一个 10 分钟的天花板——真到那时候
/// 界面必须说出来（"没等到回执"），而不是让按钮永远转下去。
const Duration kApiLongRequestTimeout = Duration(minutes: 10);

/// **事件流（SSE）的空闲判死**：连续这么久一个字节都没收到，就当这条连接已经死了。
///
/// 为什么需要它：`api.events()` 是一条长连接，本来就不该有"总时限"，但长连接会
/// **半死**——对端进程没了/网线断了而这一侧收不到 FIN，读操作永远挂着。那种情况下
/// 界面永远收不到事件（聊天页的工具卡永远停在「正在执行…」、左上角那句"思考中"永远
/// 不消失），而且 `onError`/`onDone` 一次都不会触发，重连逻辑根本没机会跑。
///
/// 45 秒 = 服务端心跳（`src/web/server.ts` 的 `SSE_HEARTBEAT_MS` = 15 秒一条 `: hb`）
/// 的 3 倍。老服务端若没有心跳，界面会每 45 秒重连一次——重连是幂等的（带
/// `Last-Event-ID` 补拉、聊天页按 seq 去重），代价只是多一条请求，比"永远收不到"好得多。
const Duration kSseIdleTimeout = Duration(seconds: 45);

/// 界面上**开始说"正在等某条请求"**的门槛。
///
/// 它比 [kApiRequestTimeout] 小得多是有意的：人不需要等到 15 秒才知道出了事，
/// 5 秒还在等就该有一行小字说清"在等什么"。到点之后界面还有「重试」可按
/// （见 `wait_banner.dart`），不必等超时自己炸出来。
const Duration kSlowRequestHint = Duration(seconds: 5);

/// 一条**在飞**的请求（诊断与界面那行小字共用）。
///
/// 时间戳取 `clock.now()` 而不是 `DateTime.now()`：`flutter_test` 会把 `clock`
/// 接管成随 `tester.pump(时长)` 前进的假时钟，于是"等了 8 秒"这件事在用例里
/// 可以真的被推到 8 秒（与 `chat_page.dart` 的思考计时同一条理由）。
class PendingRequest {
  PendingRequest({required this.method, required this.path, DateTime? startedAt})
      : startedAt = startedAt ?? clock.now();

  final String method;
  final String path;
  final DateTime startedAt;

  /// 已经等了多久
  Duration get elapsed => clock.now().difference(startedAt);

  /// 日志与界面上的那一行（`GET /api/stats/dashboard`）
  String get label => '$method $path';

  @override
  String toString() => label;
}

/// 主进程 API 客户端（规格：docs/gui-design.md §5）。零第三方依赖——只用 dart:io 的 HttpClient。
///
/// ## 认证形态（2026-10 起）
///
/// 一律 `Authorization: Bearer <会话凭据>`。**不用 cookie**：本地网页能把 cookie 顺到你的
/// 本地端口上，而 Bearer 头必须由调用方显式写下（完整理由见 src/web/auth.ts 的文件头）。
/// 凭据由登录/设密码那两条端点签发，界面存在 `%APPDATA%\Irmia\sessions\<实例标识>`
/// （见 session_store.dart）。
///
/// ## 401 自愈
///
/// 服务端可能在任何一次请求上回 401：改了密码（全部旧会话作废）、在别处登出过、
/// 或者另一个进程重登之后把凭据文件重写了。这**不该**让人重启界面。所以：
/// 每条请求遇到 401 时，先问一次 [onUnauthorized]（界面的接线是"重读凭据文件"），
/// 拿到新凭据就**原地重试一次**；第二次还是 401 才把错误抛给上层（上层据此回登录态）。
///
/// 只重试一次是硬性的：401 → 换凭据 → 401 说明"换来的也不对"，
/// 再循环下去就是拿服务端当压力测试机。
///
/// ## 时限（2026-10-24 起，见 [kApiRequestTimeout]）
///
/// **每一条请求都有总时限**，超时抛 [ApiTimeout]（一种可重试的错误），于是上层那些
/// `catch` 一定会跑到、页面一定落到"错误态 + 重试"，而不是永远转圈。两个例外都写在
/// 常量上：[kApiLongRequestTimeout]（一键安装，给足但**不等于没有**）、
/// [kSseIdleTimeout]（长连接只判空闲，不判总时长）。
///
/// ## 在飞清单（[pendingRequests] / [inFlight]）
///
/// 每条请求开始/结束时都会登记，界面上那行"正在等 …（已 N 秒）"（`wait_banner.dart`）
/// 与卡死时的日志（`gui_log.dart` 的 `[wait]` 行）读的都是它。诊断的价值就在这里：
/// 出事时不用再靠猜——清单上写的就是"卡在哪一条"。
class IrmiaApi {
  IrmiaApi({
    required this.baseUrl,
    this.token,
    Duration? connectTimeout,
    Duration? requestTimeout,
    Duration? sseIdleTimeout,
    Duration? waitDumpInterval,
  })  : connectTimeout = connectTimeout ?? kApiConnectTimeout,
        requestTimeout = requestTimeout ?? kApiRequestTimeout,
        sseIdleTimeout = sseIdleTimeout ?? kSseIdleTimeout,
        waitDumpInterval = waitDumpInterval ??
            const Duration(milliseconds: kGuiLogWaitDumpMs);

  /// 服务端根地址（`http://127.0.0.1:7788`）。
  ///
  /// **可变**（2026-10-26）：端口现在有三级来源（后端写的端口文件 > 环境变量 > 默认 7788），
  /// 而"界面先起来、后端后起来"那条路上，界面可能在等待途中读到后端刚写下的端口文件。
  /// 换端口是**下一条请求就生效**的事，所以这一格是字段而不是 final——判据只在
  /// `AppState._adoptPortFromFile` 一处（只采纳"文件"这一档，见那里）。
  String baseUrl;
  String? token;

  /// 建连超时（默认 [kApiConnectTimeout]；用例把它调小以便快速验伪）
  final Duration connectTimeout;

  /// 一条请求的总时限（默认 [kApiRequestTimeout]）
  final Duration requestTimeout;

  /// 事件流的空闲判死（默认 [kSseIdleTimeout]）
  final Duration sseIdleTimeout;

  /// 有请求在飞时，往日志里写一行 `[wait]` 的间隔（默认 [kGuiLogWaitDumpMs]）。
  ///
  /// 做成构造参数只为一个目的：**让"卡住时那行铁证"这件事本身可验收**——用例用 100ms
  /// 就能证明它真的会写，而不必等 10 秒。真机上这个值不该动（10 秒是"密到能抓到现场、
  /// 疏到只写几 KB"的那一档）。
  final Duration waitDumpInterval;

  /// 最近一次从服务端学到的**实例标识**（`<host>:<port>#<数据目录哈希>`）。
  ///
  /// 它只出现在认证响应与 401 的响应体里（服务端把它挂在"进不去的人"能看到的地方，
  /// 见 src/web/server.ts 的 instanceIdOf）。界面拿它去对的地方读自己那份凭据——
  /// 这是"第二个实例把第一个顶掉"那个坑的根治点。
  String? instance;

  /// 401 时的凭据补给口：返回新的会话凭据（界面接线 = 重读凭据文件）。
  ///
  /// 返回 null 表示"手上也没有别的凭据了"——那就别重试，直接把 401 抛上去。
  Future<String?> Function()? onUnauthorized;

  /// 有请求在飞时"当时在哪一页"（排障用；由 `AppState` 接线，传输层不该知道界面的事）。
  String Function()? pageProbe;

  /// 在飞的请求数（界面那一行小字监听它，值没变就不重建）
  final ValueNotifier<int> inFlight = ValueNotifier<int>(0);

  final List<PendingRequest> _pending = <PendingRequest>[];
  Timer? _waitDump;

  /// 当前在飞的请求（最早的在前）——界面那行小字与日志都用它
  List<PendingRequest> get pendingRequests => List<PendingRequest>.unmodifiable(_pending);

  /// 在飞的请求数
  int get inFlightCount => _pending.length;

  /// 在飞最久的那一条（没有就是 null）
  PendingRequest? get oldestPending {
    if (_pending.isEmpty) return null;
    var oldest = _pending.first;
    for (final entry in _pending) {
      if (entry.startedAt.isBefore(oldest.startedAt)) oldest = entry;
    }
    return oldest;
  }

  /// 登记一条"开始等了"的请求，返回它的凭据（结束时交给 [endRequest]）。
  ///
  /// 正常路径由 [get]/[post]/[put]/[postAuth] 自动调用；公开是为了两件事：
  /// ① `wait_banner.dart` 那一层能用手工登记的条目做用例（不必真开一条连接）；
  /// ② 将来若有"不经 HTTP 的等待"（比如等一个本地进程），也能进同一份清单。
  PendingRequest beginRequest(String method, String path) {
    final entry = PendingRequest(method: method, path: path);
    _pending.add(entry);
    inFlight.value = _pending.length;
    if (guiLog.attached && _pending.length == 1) _armWaitDump();
    return entry;
  }

  /// 登记一条"不等了"（成功、失败、超时都要走到这里）。
  void endRequest(PendingRequest entry) {
    if (_pending.remove(entry)) inFlight.value = _pending.length;
    if (_pending.isEmpty) {
      _waitDump?.cancel();
      _waitDump = null;
    }
  }

  /// 有请求在飞时，每 [kGuiLogWaitDumpMs] 记一行在飞清单。
  ///
  /// **只在日志打开时**才排这条定时器：用例里（没 attach）一条定时器都不会多出来
  /// ——`flutter test` 会为"收尾时还挂着的 Timer"直接判红。
  void _armWaitDump() {
    if (!guiLog.attached || _waitDump != null) return;
    _waitDump = Timer(waitDumpInterval, _dumpWaits);
  }

  void _dumpWaits() {
    _waitDump = null;
    if (!guiLog.attached) return;
    final oldest = oldestPending;
    if (oldest == null) return;
    final page = pageProbe?.call() ?? '?';
    guiLog.write(
      '[wait] inflight=${_pending.length} oldest="${oldest.label}" '
      '${secsOf(oldest.elapsed)} page=$page',
    );
    _armWaitDump();
  }

  /// 常用 GET：解析 JSON；401 抛 ApiAuthError 让上层回登录态；**超时抛 [ApiTimeout]**。
  ///
  /// [timeout] 只为"已知会跑很久的端点"放宽（现在的唯一一处是「一键安装」）。
  Future<dynamic> get(String path, {Duration? timeout}) =>
      _send('GET', path, timeout: timeout);

  /// 命令 POST：body 为 JSON；危险操作可带 confirm 短语（X-Confirm 头）
  Future<dynamic> post(String path, Map<String, dynamic> body,
          {String? confirm, Duration? timeout}) =>
      _send('POST', path, body: body, confirm: confirm, timeout: timeout);

  /// 资源 PUT：只给「写一份配置资源」用（协议端的 `PUT /api/protocol-side/config`）。
  ///
  /// 为什么与 post 分开而不是复用：那条端点的语义是**可重复提交**（同样的 body 发两遍结果一样），
  /// 而 `/api/commands/*` 那批是"触发一个动作"（唤醒、结案、安装），两者对重试的容忍度不同。
  /// 走同一段 HTTP 通道，只把方法名分开——服务端据此区分的也正是这件事。
  Future<dynamic> put(String path, Map<String, dynamic> body, {Duration? timeout}) =>
      _send('PUT', path, body: body, timeout: timeout);

  /// 公开的"这台实例设过密码没有"（`GET /api/auth/state`，2026-10-23 加）。
  ///
  /// 为什么需要它：401 的 `code` 也能分流（`auth-uninitialized` / `unauthorized`），但那条
  /// 通道同时承担"分流信号"与"错误播报"两种含义——探测那一次的 message 很容易被当成错误
  /// 显示给人看；更要紧的是它**没有复核通道**：服务端状态在别处变了（密码在另一个进程里
  /// 设上、或凭据文件被重命名做重置）之后，界面只能停在旧判断上，对着一扇永远失败的门
  /// （2026-10-23 的死锁现场，见 `app.dart` 的 `bootstrap`）。
  ///
  /// 返回：true / false = 服务端如实回答；**null = 问不出来**（老服务端没有这条端点、
  /// 应答形状不对、或它落进了旧版本的认证闸里回 401）。null 不是"没设密码"——
  /// 调用方这时要退回 401 的 code 分流。
  ///
  /// 连接类异常**照原样抛**：那是"服务端不在"，与"它答了但我听不懂"是两件事，
  /// 门前那套重连只认前者。
  Future<bool?> authState() async {
    try {
      final res = await get('/api/auth/state');
      if (res is Map) {
        final value = res['initialized'];
        if (value is bool) return value;
      }
      return null;
    } on ApiAuthError {
      // 老服务端没有这条端点：它落进 `/api/*` 的认证闸，回 401。按"问不出来"处理。
      return null;
    } on ApiError {
      // 404 / 405：也是没有这条端点
      return null;
    }
  }

  /// 认证端点专用 POST（设密码 / 登录 / 登出 / 改密码）：**不做 401 自愈**。
  ///
  /// 为什么必须关掉自愈：那条自愈的语义是"手上这张票旧了，换一张再来"，而认证端点的 401
  /// 说的恰恰是"你给的密码不对"。拿旧票去重放一次登录请求毫无意义，还会把失败次数
  /// （也就是退避）白推高一格。
  Future<dynamic> postAuth(String path, Map<String, dynamic> body) =>
      _send('POST', path, body: body, allowRetry: false);

  /// 一条请求的**唯一出口**：时限、登记、日志、401 自愈都在这里收口。
  ///
  /// 时限覆盖的是**整条往返**（建连 → 发 body → 读完响应体）。这一点是要害：
  /// 卡死现场最常见的形状不是"连不上"，而是"连上了、服务端再也不说话"，
  /// 那时候卡住的是读响应体——只给 `openUrl` 加时限一点用都没有。
  ///
  /// 超时后 `client.close(force: true)` 会把 socket 直接掐掉：不掐的话那条半死的连接
  /// 会一直占着，服务端那头也永远不知道对面已经不等了。
  Future<dynamic> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    String? confirm,
    bool allowRetry = true,
    Duration? timeout,
  }) async {
    final limit = timeout ?? requestTimeout;
    final entry = beginRequest(method, path);
    final client = HttpClient()..connectionTimeout = connectTimeout;
    final began = clock.now();
    try {
      final result = await _roundTrip(
        client,
        method,
        path,
        body: body,
        confirm: confirm,
        allowRetry: allowRetry,
      ).timeout(limit);
      final spent = clock.now().difference(began);
      if (guiLog.attached && spent.inMilliseconds >= kGuiLogSlowMs) {
        guiLog.write('[net] slow ${entry.label} ${secsOf(spent)}');
      }
      return result;
    } on TimeoutException {
      // 请求**可能已经落地**（服务端收到了、只是没在时限内答完）：POST/PUT 一律按
      // "可能已经生效"报，那条话（[ApiTimeout.mayHaveApplied]）会顺着 `'$err'`
      // 一路显示到界面上——把"不知道"说成"没做成"是最容易让人点第二次的那种谎。
      final error = ApiTimeout(
        method: method,
        path: path,
        waited: limit,
        mayHaveApplied: method != 'GET',
      );
      if (guiLog.attached) {
        guiLog.write('[net] TIMEOUT ${entry.label} waited=${secsOf(limit)}');
      }
      throw error;
    } catch (err) {
      if (guiLog.attached) {
        final spent = clock.now().difference(began);
        guiLog.write('[net] FAIL ${entry.label} after=${secsOf(spent)} error=$err');
      }
      rethrow;
    } finally {
      endRequest(entry);
      // force：超时那一刻把 socket 掐掉（不留半死连接）；正常路径上响应体已经读完，
      // 强制关闭只是不再复用这条连接——而每条请求本来就新建一个 client。
      client.close(force: true);
    }
  }

  /// 真的一次往返。401 自愈的重试也走这里（同一条时限、同一个 client）。
  Future<dynamic> _roundTrip(
    HttpClient client,
    String method,
    String path, {
    Map<String, dynamic>? body,
    String? confirm,
    bool allowRetry = true,
    bool alreadyRetried = false,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final req = await client.openUrl(method, uri);
    if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    if (confirm != null) req.headers.set('X-Confirm', confirm);
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
    }
    final res = await req.close();
    String text;
    try {
      // 读体也在时限里（外层 `.timeout`）——"服务端答了头、body 再也不来"就死在这一行
      text = await res.transform(utf8.decoder).join();
    } catch (err) {
      // 401 那一路即使读体失败也要回 ApiAuthError（上层据此回门），别把 401 说成"连接断了"
      if (res.statusCode == 401) throw ApiAuthError('HTTP 401', instance: instance);
      rethrow;
    }
    if (res.statusCode == 401) {
      final error = _authErrorOf(text);
      // 自愈：重读一次凭据再试一遍。**只一次**——第二次还 401 就是"票真的不作数了"。
      if (allowRetry && !alreadyRetried) {
        final replacement = await onUnauthorized?.call();
        if (replacement != null && replacement.trim().isNotEmpty) {
          token = replacement.trim();
          return _roundTrip(
            client,
            method,
            path,
            body: body,
            confirm: confirm,
            alreadyRetried: true,
          );
        }
      }
      throw error;
    }
    return _decode(res.statusCode, text);
  }

  /// 把 401 的响应体读成一个人话错误：`{error:{code,message}, instance}`。
  ///
  /// 为什么要费这个劲（而不是像别的状态码那样交给 [_decode]）：这两个字段是**下一步做什么**
  /// 的全部依据——`code` 决定弹"设置密码"还是"登录"，`instance` 决定去读哪个凭据文件。
  ApiAuthError _authErrorOf(String text) {
    String message = 'HTTP 401';
    String? code;
    try {
      final decoded = text.isEmpty ? null : jsonDecode(text);
      if (decoded is Map) {
        final error = decoded['error'];
        if (error is Map) {
          final raw = error['message'];
          if (raw is String && raw.trim().isNotEmpty) message = raw;
          final rawCode = error['code'];
          if (rawCode is String && rawCode.isNotEmpty) code = rawCode;
        }
        final rawInstance = decoded['instance'];
        if (rawInstance is String && rawInstance.isNotEmpty) instance = rawInstance;
      }
    } catch (_) {
      // 读不出来就用手上这两句默认话：界面照样能回登录态，只是提示糙一点
    }
    return ApiAuthError(message, code: code, instance: instance);
  }

  dynamic _decode(int status, String text) {
    dynamic decoded;
    try {
      decoded = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      decoded = text;
    }
    if (status >= 400) {
      final message = decoded is Map && decoded['error'] is Map
          ? (decoded['error']['message']?.toString() ?? 'HTTP $status')
          : 'HTTP $status';
      // "还没就绪"那一档（503 + starting:true）单独标出来：它不是错误，是"还在起"。
      // `phase` 一起带上来（`events` / `mcp` / `channels` / `ready`，见 src/web/preflight.ts）：
      // 界面要把"到哪一步了"说成人话——只说"连不上"会让人以为后端根本没起（2026-10-28 现场）。
      final starting = decoded is Map && decoded['starting'] == true;
      final rawPhase = decoded is Map ? decoded['phase'] : null;
      throw ApiError(
        status,
        message,
        starting: starting,
        phase: rawPhase is String ? rawPhase : '',
      );
    }
    return decoded;
  }

  /// SSE 事件流：手工分行解析（data: 一行一条 JSON），断线由调用方重连。
  /// 返回的 Stream 关闭时请求随之取消。
  ///
  /// 认证只走 `Authorization` 头。**没有 `?token=` 那条路**：它当年存在只是因为浏览器的
  /// EventSource 设不了自定义头，而网页界面已经整个删掉了；凭据放进 URL 会被各处日志顺手记下来，
  /// 服务端那边也把这条后门一并关了（test/web-server.test.ts 有用例钉着）。
  ///
  /// **空闲判死**（2026-10-24 加，见 [kSseIdleTimeout]）：连续 [sseIdleTimeout] 一个字节
  /// 都没收到就 `addError` 并关掉客户端。长连接不能有总时限（它本来就要一直开着），但
  /// 必须能发现"这条已经死了"——半死的连接不会触发 `onError`/`onDone`，界面就永远收不到
  /// 事件、也永远不重连。判死之后两个调用方（`app.dart` 与 `chat_page.dart`）照旧 3 秒后
  /// 重连，并用 `Last-Event-ID` 把断线窗口补回来，所以这一条是**纯增益**。
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    final controller = StreamController<Map<String, dynamic>>();
    HttpClient? client;
    Timer? idle;

    /// 已经给过终态（error/done）了：**只许一次**，否则上层会看到"断线"又看到"结束"，
    /// 两条重连定时器互相打架。
    var settled = false;

    void finish() {
      settled = true;
      idle?.cancel();
      idle = null;
    }

    /// （重新）武装空闲判死。建连、收到响应头、收到每一段数据之后都调一次。
    ///
    /// 它**从建连之前就武装**：卡死现场不止"响应体不来"，还有"连上了但永远不给响应头"
    /// （`req.close()` 就是那样挂住的）。只盯读体那一段会漏掉这一半。
    void armIdle() {
      if (settled) return;
      idle?.cancel();
      idle = Timer(sseIdleTimeout, () {
        if (settled) return;
        finish();
        if (guiLog.attached) {
          guiLog.write('[sse] idle-timeout waited=${secsOf(sseIdleTimeout)}');
        }
        client?.close(force: true);
        if (!controller.isClosed) {
          controller.addError(ApiTimeout(
            method: 'GET',
            path: '/api/events/stream',
            waited: sseIdleTimeout,
            idle: true,
          ));
          unawaited(controller.close());
        }
      });
    }

    Future<void> start() async {
      client = HttpClient()..connectionTimeout = connectTimeout;
      // 建连那一段也纳进空闲判死（见 armIdle 的注释）
      armIdle();
      try {
        final req = await client!.getUrl(Uri.parse('$baseUrl/api/events/stream'));
        if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        if (lastEventId != null) req.headers.set('Last-Event-ID', '$lastEventId');
        final res = await req.close();
        if (res.statusCode == 401) {
          finish();
          String text = '';
          try {
            text = await res.transform(utf8.decoder).join();
          } catch (_) {
            // 读不出来就按裸 401 处理（上层照样回登录态）
          }
          if (!controller.isClosed) {
            controller.addError(_authErrorOf(text));
            await controller.close();
          }
          return;
        }
        if (guiLog.attached) {
          guiLog.write('[sse] open lastEventId=${lastEventId ?? '-'}');
        }
        var buffer = '';
        await for (final chunk in res.transform(utf8.decoder)) {
          armIdle(); // 收到字节 = 这条连接还活着（服务端每 15 秒一条 `: hb`）
          buffer += chunk;
          while (true) {
            final idx = buffer.indexOf('\n');
            if (idx < 0) break;
            final line = buffer.substring(0, idx).trimRight();
            buffer = buffer.substring(idx + 1);
            if (!line.startsWith('data:')) continue; // event:/id:/retry:/`: hb` 行进 UI 不需要
            final payload = line.substring(5).trim();
            if (payload.isEmpty) continue;
            try {
              final parsed = jsonDecode(payload);
              if (parsed is Map<String, dynamic>) controller.add(parsed);
            } catch (_) {
              // 单行坏数据不打断整条流
            }
          }
        }
        if (!settled) {
          finish();
          if (guiLog.attached) guiLog.write('[sse] closed by server');
          if (!controller.isClosed) await controller.close();
        }
      } catch (err) {
        if (!settled) {
          finish();
          if (guiLog.attached) guiLog.write('[sse] error $err');
          if (!controller.isClosed) {
            controller.addError(err);
            await controller.close();
          }
        }
      }
    }

    controller.onListen = () {
      unawaited(start());
    };
    controller.onCancel = () {
      finish();
      client?.close(force: true);
    };
    return controller.stream;
  }
}

/// 服务端返回的"你没凭据/凭据不作数"的**认证错误**。
///
/// `code` 与 `instance` 不是装饰：
///   · `auth-uninitialized` → 这台实例还没设过密码，界面要弹**设置密码**；
///   · `unauthorized`      → 有密码，但手上这张票不作数了，界面要弹**登录**；
///   · `instance`          → 去哪个文件里找自己那份凭据（见 session_store.dart）。
class ApiAuthError implements Exception {
  const ApiAuthError(this.message, {this.code, this.instance});

  final String message;

  /// 服务端给的错误码；读不到时为 null（老服务端 / 非 JSON 响应）
  final String? code;

  /// 服务端给的实例标识；读不到时为 null
  final String? instance;

  /// 还没设过密码（界面该弹"设置密码"而不是"登录"）
  bool get needsSetup => code == 'auth-uninitialized';

  @override
  String toString() => message;
}

class ApiError implements Exception {
  const ApiError(this.status, this.message, {this.starting = false, this.phase = ''});
  final int status;
  final String message;

  /// 服务端回的是"**我还没就绪**"那一档（503 + `{starting:true, phase}`，2026-10-26）。
  ///
  /// 它必须与别的 4xx/5xx 分开：后端先 bind 再折事件（35–42 秒），这一段里每一条数据路由
  /// 都会回这一档——**它不是错误，是"正在起"**。门前的重连据此继续等（中性话、不画红卡），
  /// 而 500 那种"它在那并且说不行"照旧当场说话。
  final bool starting;

  /// 启动阶段（只在 [starting] 时有意义）：`events` / `mcp` / `channels` / `ready`。
  ///
  /// 原样照抄服务端的读数，**不在这里翻成人话**：中英的语序不同，翻译归 `AppStrings`
  /// （见 `backend_probe.dart` 的文件头）。空串 = 这一版服务端不报阶段。
  final String phase;

  @override
  String toString() => message;
}

/// **这次没回来**：一条请求在自己的时限内没有走完（连不上、只给了半条、或者服务端卡住）。
///
/// 它是一等错误，不是"网络错误"的别名，因为界面要对它做一件特定的事：**落到可重试的
/// 错误态**。`ApiError`（服务端答了话但选了失败）与 `ApiAuthError`（凭据不作数）都不该
/// 被重试，而这个必须能重试。
///
/// 两条语义要分清（[mayHaveApplied]）：GET 超时 = 什么都没发生，重试就是；
/// POST/PUT 超时 = **请求可能已经落地**，那时候说"没做成"就是在骗人，人会点第二次，
/// 于是同一个动作做两遍（重启点两遍、安装装两遍）。
class ApiTimeout implements Exception {
  const ApiTimeout({
    required this.method,
    required this.path,
    required this.waited,
    this.mayHaveApplied = false,
    this.idle = false,
  });

  final String method;
  final String path;
  final Duration waited;

  /// 这条请求可能是"发到了、只是没等到回执"（写操作一律按这个方向说）
  final bool mayHaveApplied;

  /// 是长连接的**空闲**判死（不是总时限）
  final bool idle;

  /// 已等的秒数（人话里用的是这个，不是毫秒）
  int get waitedSeconds => (waited.inMilliseconds / 1000).round();

  /// 一行技术原因（`POST /api/commands/restart · 15 s`）。
  ///
  /// 给"外面已经有一句人话前缀"的地方用（例如 `restart_action.dart` 的
  /// [AppStrings.restartNoReceipt]）：那种地方要的是"哪条、多久"，不是整句解释——
  /// 两句话叠在一起就成了"重启没等到回执（…等了 15 秒没有回执…）"那种啰嗦。
  String get shortReason => '$method $path · $waitedSeconds s';

  /// 那句给人看的话。**走文案表**（它是界面话，要跟着语言换）；
  /// 这一层不做拼接——中英的语序不一样，见 `i18n/app_strings.dart` 顶部。
  @override
  String toString() => idle
      ? currentStrings.requestStreamStalled(waitedSeconds)
      : currentStrings.requestTimeout(
          '$method $path',
          waitedSeconds,
          mayHaveApplied,
        );
}
