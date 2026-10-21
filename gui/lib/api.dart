// TODO(i18n): 本文件还有 1 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/api.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// 密码长度下限，与服务端 `src/web/auth.ts` 的 `PASSWORD_MIN_LEN` 同值。
///
/// **两边各留一份常量**是有意的：这一份只为了"在发请求之前就把话说清楚"（少一次
/// 白跑的往返），真正的判据永远在服务端——客户端校验是体验，不是边界。
/// 两边不一致时以服务端为准：它会回一句人话，界面照原样显示。
const int kPasswordMinLength = 6;

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
class IrmiaApi {
  IrmiaApi({required this.baseUrl, this.token});

  final String baseUrl;
  String? token;

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

  /// 常用 GET：解析 JSON；401 抛 ApiAuthError 让上层回登录态
  Future<dynamic> get(String path) async {
    final res = await _send('GET', path);
    return _decode(res);
  }

  /// 命令 POST：body 为 JSON；危险操作可带 confirm 短语（X-Confirm 头）
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm}) async {
    final res = await _send('POST', path, body: body, confirm: confirm);
    return _decode(res);
  }

  /// 资源 PUT：只给「写一份配置资源」用（协议端的 `PUT /api/protocol-side/config`）。
  ///
  /// 为什么与 post 分开而不是复用：那条端点的语义是**可重复提交**（同样的 body 发两遍结果一样），
  /// 而 `/api/commands/*` 那批是"触发一个动作"（唤醒、结案、安装），两者对重试的容忍度不同。
  /// 走同一段 HTTP 通道，只把方法名分开——服务端据此区分的也正是这件事。
  Future<dynamic> put(String path, Map<String, dynamic> body) async {
    final res = await _send('PUT', path, body: body);
    return _decode(res);
  }

  /// 认证端点专用 POST（设密码 / 登录 / 登出 / 改密码）：**不做 401 自愈**。
  ///
  /// 为什么必须关掉自愈：那条自愈的语义是"手上这张票旧了，换一张再来"，而认证端点的 401
  /// 说的恰恰是"你给的密码不对"。拿旧票去重放一次登录请求毫无意义，还会把失败次数
  /// （也就是退避）白推高一格。
  Future<dynamic> postAuth(String path, Map<String, dynamic> body) async {
    final res = await _send('POST', path, body: body, allowRetry: false);
    return _decode(res);
  }

  Future<HttpClientResponse> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    String? confirm,
    bool allowRetry = true,
    bool alreadyRetried = false,
  }) async {
    // connectionTimeout **只管建连那一下**（dart:_http 里它只包在 Socket.startConnect 外面），
    // 不覆盖整条请求——这正是「一键安装」那条同步端点能跑一两分钟而不被掐断的原因。
    // 所以别把它当成"请求超时"：真要给某条请求设总时限，得自己想清楚超时之后服务端还在做什么
    // （安装那条就不能设：回执丢了而东西装好了，是这里最难查的一种故障）。
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
    try {
      final uri = Uri.parse('$baseUrl$path');
      final req = await client.openUrl(method, uri);
      if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
      if (confirm != null) req.headers.set('X-Confirm', confirm);
      if (body != null) {
        req.headers.contentType = ContentType.json;
        req.write(jsonEncode(body));
      }
      final res = await req.close();
      if (res.statusCode == 401) {
        final error = await _authErrorOf(res);
        // 自愈：重读一次凭据再试一遍。**只一次**——第二次还 401 就是"票真的不作数了"。
        if (allowRetry && !alreadyRetried) {
          final replacement = await onUnauthorized?.call();
          if (replacement != null && replacement.trim().isNotEmpty) {
            token = replacement.trim();
            return await _send(
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
      return res;
    } finally {
      // 响应读完后再关：调用方在 _decode 里读流
      client.close();
    }
  }

  /// 把 401 的响应体读成一个人话错误：`{error:{code,message}, instance}`。
  ///
  /// 为什么要费这个劲（而不是像别的状态码那样交给 `_decode`）：这两个字段是**下一步做什么**
  /// 的全部依据——`code` 决定弹"设置密码"还是"登录"，`instance` 决定去读哪个凭据文件。
  Future<ApiAuthError> _authErrorOf(HttpClientResponse res) async {
    String message = 'HTTP 401';
    String? code;
    try {
      final text = await res.transform(utf8.decoder).join();
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

  Future<dynamic> _decode(HttpClientResponse res) async {
    final text = await res.transform(utf8.decoder).join();
    dynamic decoded;
    try {
      decoded = text.isEmpty ? null : jsonDecode(text);
    } catch (_) {
      decoded = text;
    }
    if (res.statusCode >= 400) {
      final message = decoded is Map && decoded['error'] is Map
          ? (decoded['error']['message']?.toString() ?? 'HTTP ${res.statusCode}')
          : 'HTTP ${res.statusCode}';
      throw ApiError(res.statusCode, message);
    }
    return decoded;
  }

  /// SSE 事件流：手工分行解析（data: 一行一条 JSON），断线由调用方重连。
  /// 返回的 Stream 关闭时请求随之取消。
  ///
  /// 认证只走 `Authorization` 头。**没有 `?token=` 那条路**：它当年存在只是因为浏览器的
  /// EventSource 设不了自定义头，而网页界面已经整个删掉了；凭据放进 URL 会被各处日志顺手记下来，
  /// 服务端那边也把这条后门一并关了（test/web-server.test.ts 有用例钉着）。
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    final controller = StreamController<Map<String, dynamic>>();
    HttpClient? client;

    Future<void> start() async {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
      try {
        final req = await client!.getUrl(Uri.parse('$baseUrl/api/events/stream'));
        if (token != null) req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
        req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        if (lastEventId != null) req.headers.set('Last-Event-ID', '$lastEventId');
        final res = await req.close();
        if (res.statusCode == 401) {
          controller.addError(await _authErrorOf(res));
          await controller.close();
          return;
        }
        var buffer = '';
        await for (final chunk in res.transform(utf8.decoder)) {
          buffer += chunk;
          while (true) {
            final idx = buffer.indexOf('\n');
            if (idx < 0) break;
            final line = buffer.substring(0, idx).trimRight();
            buffer = buffer.substring(idx + 1);
            if (!line.startsWith('data:')) continue; // event:/id:/retry: 行进 UI 不需要
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
        if (!controller.isClosed) await controller.close();
      } catch (err) {
        if (!controller.isClosed) {
          controller.addError(err);
          await controller.close();
        }
      }
    }

    controller.onListen = () {
      unawaited(start());
    };
    controller.onCancel = () {
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
  const ApiError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}
