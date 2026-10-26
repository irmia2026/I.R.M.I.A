import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';

/// **请求时限的负向验证**（2026-10-23「GUI 用久了会卡死」那一批的验收用例）。
///
/// ## 这一份钉的是什么
///
/// 现场的判据是"进程健康、界面不动"：99 个线程全 Wait、CPU 空闲、`Responding=True`，
/// 而屏幕上那一页永远在转圈。形状只有一个：**某个 await 永远不返回**。
///
/// 旧代码的 `IrmiaApi` 里，`connectionTimeout` 只覆盖 `Socket.startConnect` 那一下
/// （`dart:_http` 的实现如此），于是下面这两条路**一个字节的时限都没有**：
///
///   · `openUrl` / `req.close()`：连接建上了、服务端再也不给响应头 ⇒ 永远等；
///   · `res.transform(utf8.decoder).join()`：响应头给了、body 再也不来 ⇒ 永远等。
///
/// 而上层每一个"等它回来才画"的地方（整页 `loading`、`AppState._readingDashboard`
/// 那道防重入闸、待批轮询的 `_ticking`、聊天页的 `_loadingEarlier`）都靠
/// `finally` 放闸——future 不完，`finally` 就永远不跑，闸就永远关着。
///
/// 所以这里的判据只有一条：**在一个真的"收了请求就不回"的服务端面前，
/// `api.get()` 必须在时限内抛 [ApiTimeout]**（旧代码会挂到用例超时）。
/// 假实现证明不了这件事——真的 socket 才算。
void main() {
  /// 起了几个真的 `HttpServer`
  final servers = <HttpServer>[];

  /// 一个"收了请求再也不回"的服务端：[mode] 决定卡在哪一段。
  Future<Uri> stalled(_StallMode mode) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    servers.add(server);
    server.listen((req) async {
      switch (mode) {
        case _StallMode.beforeHeaders:
          // 什么都不写：连接活着，响应头永远不来（旧代码死在 req.close()）
          break;
        case _StallMode.inBody:
          // 头给了、半截 body 给了，然后闭嘴（旧代码死在读体那一行）
          req.response.headers.contentType = ContentType.json;
          req.response.write('{"events":[');
          await req.response.flush();
          break;
      }
    });
    return Uri.parse('http://127.0.0.1:${server.port}');
  }

  tearDown(() async {
    for (final server in servers) {
      await server.close(force: true);
    }
    servers.clear();
  });

  test('服务端收了请求就不给响应头 ⇒ 时限内抛 ApiTimeout（旧代码永远等）', () async {
    final base = await stalled(_StallMode.beforeHeaders);
    final api = IrmiaApi(
      baseUrl: base.toString(),
      requestTimeout: const Duration(milliseconds: 250),
    );
    final watch = Stopwatch()..start();
    await expectLater(
      api.get('/api/stats/dashboard'),
      throwsA(isA<ApiTimeout>()),
    );
    watch.stop();
    // 250ms 的时限：给足调度余量，但绝不允许它退化成"没有时限"
    expect(watch.elapsed, lessThan(const Duration(seconds: 5)),
        reason: '时限到了就必须抛，不许挂住');
  });

  test('响应头给了、body 再也不来 ⇒ 也在时限内抛（读体那一段同样要有期限）', () async {
    final base = await stalled(_StallMode.inBody);
    final api = IrmiaApi(
      baseUrl: base.toString(),
      requestTimeout: const Duration(milliseconds: 250),
    );
    final watch = Stopwatch()..start();
    await expectLater(
      api.get('/api/events?limit=60'),
      throwsA(isA<ApiTimeout>()),
    );
    watch.stop();
    expect(watch.elapsed, lessThan(const Duration(seconds: 5)));
  });

  test('超时那句话说得清"哪一条、多久"，GET 不说"可能已经生效"', () async {
    final base = await stalled(_StallMode.beforeHeaders);
    final api = IrmiaApi(
      baseUrl: base.toString(),
      requestTimeout: const Duration(milliseconds: 200),
    );
    try {
      await api.get('/api/projection');
      fail('应当抛 ApiTimeout');
    } on ApiTimeout catch (err) {
      expect(err.method, 'GET');
      expect(err.path, '/api/projection');
      expect(err.waitedSeconds, 0, reason: '200ms ⇒ 四舍五入 0 秒；不许算成 1');
      expect(err.mayHaveApplied, isFalse, reason: 'GET 超时什么都没发生，重试就是');
      final text = err.toString();
      expect(text, contains('GET /api/projection'), reason: '必须点名是哪一条');
      expect(text, contains('重试'), reason: '必须给下一步（这次没回来，点重试）');
      expect(text, isNot(contains('可能已经生效')),
          reason: '只读请求不许吓唬人说"可能已经生效"');
    }
  });

  test('写操作超时：话里必须说"可能已经生效"（不许把"不知道"说成"没做成"）', () async {
    final base = await stalled(_StallMode.beforeHeaders);
    final api = IrmiaApi(
      baseUrl: base.toString(),
      requestTimeout: const Duration(milliseconds: 200),
    );
    try {
      await api.post('/api/commands/grant-decide', const {'id': 'x'});
      fail('应当抛 ApiTimeout');
    } on ApiTimeout catch (err) {
      expect(err.mayHaveApplied, isTrue);
      expect(err.toString(), contains('可能已经生效'),
          reason: 'POST 超时等于"不知道成没成"，说成失败会让人再点一次（同一动作做两遍）');
      expect(err.shortReason, contains('POST /api/commands/grant-decide'));
    }
  });

  test('连不上（端口没人听）不是超时：它必须当场失败，别混成 ApiTimeout', () async {
    // 127.0.0.1:1 上没人监听：connect 立刻被拒
    final api = IrmiaApi(
      baseUrl: 'http://127.0.0.1:1',
      requestTimeout: const Duration(seconds: 5),
    );
    await expectLater(
      api.get('/api/projection'),
      throwsA(isNot(isA<ApiTimeout>())),
      reason: '"服务端不在"与"服务端不说话"是两件事：前者要立刻说，后者要等时限',
    );
  });

  test('正常的请求照旧：返回值不变、在飞清单当场清空', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    servers.add(server);
    server.listen((req) async {
      req.response.headers.contentType = ContentType.json;
      req.response.write('{"ok":true}');
      await req.response.close();
    });
    final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
    final result = await api.get('/api/projection');
    expect(result, isA<Map>());
    expect((result as Map)['ok'], isTrue);
    expect(api.inFlightCount, 0, reason: '请求结束必须从在飞清单里拿掉');
    expect(api.pendingRequests, isEmpty);
    expect(api.inFlight.value, 0);
  });

  test('在飞的请求进清单：界面那行小字与日志的 `[wait]` 读的就是它', () async {
    final base = await stalled(_StallMode.beforeHeaders);
    final api = IrmiaApi(
      baseUrl: base.toString(),
      requestTimeout: const Duration(milliseconds: 400),
    );
    final pending = api.get('/api/stats/dashboard');
    // 同步登记：`beginRequest` 在发出任何 IO 之前就跑完了
    expect(api.inFlightCount, 1);
    expect(api.pendingRequests.single.path, '/api/stats/dashboard');
    expect(api.pendingRequests.single.method, 'GET');
    expect(api.inFlight.value, 1);
    await expectLater(pending, throwsA(isA<ApiTimeout>()));
    expect(api.inFlightCount, 0, reason: '超时之后也必须清空（否则那行小字永远挂着）');
    expect(api.inFlight.value, 0);
  });

  group('事件流（长连接）：只有空闲判死，没有总时限', () {
    test('建连成功但一个字节都不来 ⇒ 空闲判死，报"按断线处理"', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      servers.add(server);
      server.listen((req) async {
        req.response.headers.contentType = ContentType.text;
        // 头给了就闭嘴：这条 SSE 是"半死"的（对端还在、数据永远不来）
        await req.response.flush();
      });
      final api = IrmiaApi(
        baseUrl: 'http://127.0.0.1:${server.port}',
        sseIdleTimeout: const Duration(milliseconds: 300),
      );
      final errors = <Object>[];
      final done = Completer<void>();
      api.events().listen(
        (_) {},
        onError: errors.add,
        onDone: () {
          if (!done.isCompleted) done.complete();
        },
      );
      await done.future.timeout(const Duration(seconds: 10));
      expect(errors, hasLength(1), reason: '终态只许给一次（两条重连定时器会互相打架）');
      final err = errors.single;
      expect(err, isA<ApiTimeout>());
      expect((err as ApiTimeout).idle, isTrue);
      expect(err.toString(), contains('按断线处理'),
          reason: '两条调用方都靠 onError 重连，所以这句话要说明"正在重连"');
    });

    test('服务端有心跳（`: hb`）⇒ 空闲判死不误杀：连接一直是活的', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      servers.add(server);
      var closed = false;
      server.listen((req) async {
        req.response.headers.contentType = ContentType.text;
        // 真实服务端（Node 的 `res.write`）每写一次就进 socket；Dart 的 HttpServer
        // 默认会攒着（`bufferOutput`），攒着就等于"没有心跳"——第一次跑这条用例就是
        // 这么红的（服务端写了心跳，客户端一个字节都没收到）。
        req.response.bufferOutput = false;
        req.response.write('retry: 3000\n\n');
        await req.response.flush();
        // 每 100ms 一条心跳注释行（真实服务端是 15 秒一条 `: hb`，见 server.ts）
        final beat = Timer.periodic(const Duration(milliseconds: 100), (_) {
          req.response.write(': hb\n\n');
          unawaited(req.response.flush());
        });
        req.response.done.whenComplete(() {
          beat.cancel();
          closed = true;
        });
      });
      final api = IrmiaApi(
        baseUrl: 'http://127.0.0.1:${server.port}',
        // 空闲窗口 400ms，而心跳 100ms 一条 ⇒ 永远不会被判死
        sseIdleTimeout: const Duration(milliseconds: 400),
      );
      final errors = <Object>[];
      final sub = api.events().listen((_) {}, onError: errors.add);
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      expect(errors, isEmpty, reason: '心跳就是用来证明"这条还活着"的，不许误杀');
      await sub.cancel();
      // 收尾：等那条连接的 done 跑完，别把定时器留到下一个用例
      for (var i = 0; i < 50 && !closed; i += 1) {
        await Future<void>.delayed(const Duration(milliseconds: 20));
      }
    });
  });
}

/// 服务端卡在哪一段
enum _StallMode {
  /// 连上了，响应头永远不来（旧代码死在 `req.close()`）
  beforeHeaders,

  /// 头给了、body 半截（旧代码死在该读体的时候）
  inBody,
}
