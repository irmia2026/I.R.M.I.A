import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/session_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  HttpOverrides.global = null;

  test('A 的迟到 401 不把原 POST 带着 B 的票重发到 B', () async {
    final r = await _Rig.open();
    var credentialReads = 0;
    final reread = r.api.onUnauthorized!;
    r.api.onUnauthorized = () {
      credentialReads += 1;
      return reread();
    };
    final pending = r.api.post('/api/commands/reset-context', {'source': 'A'});
    final request = await r.nextA();
    expect(
      request.headers.value(HttpHeaders.authorizationHeader),
      'Bearer synthetic-a',
    );
    r.adoptB();
    final rejected = expectLater(pending, throwsA(isA<ApiStaleRequest>()));
    await _reply(request, 401, _unauthorized);
    await rejected;

    expect(credentialReads, 0, reason: '旧请求不能触发当前实例的凭据回读');
    expect(r.requestsB, isEmpty);
    r.expectBIntact();
    expect((await r.api.get('/api/fresh'))['servedBy'], 'B');
    expect(r.requestsB, [
      {'method': 'GET', 'path': '/api/fresh', 'auth': 'Bearer synthetic-b'},
    ]);
    expect(r.api.inFlightCount, 0);
  });

  for (final status in [200, 401]) {
    test('AppState 丢弃 A 的迟到 $status，保持 B 的连接和登录状态', () async {
      final r = await _Rig.open();
      final pending = r.state.pollOnce();
      final request = await r.nextA();
      r.adoptB();
      await _reply(
        request,
        status,
        status == 401
            ? _unauthorized
            : {
                'state': 'running',
                'stateText': 'old A state',
                'tiles': {'needsReview': 99},
                'instance': 'instance-a',
                'token': 'old-a-response-token',
              },
      );
      await pending;
      expect(r.requestsB, isEmpty);
      r.expectBIntact();
      expect(r.state.needsReview, 0, reason: 'A 的成功正文不能写进 B 的快照');
    });
  }

  test('凭据回读尚未完成时切实例，不能采纳旧回读结果或重试', () async {
    final r = await _Rig.open();
    r.sessions.write('instance-a', 'refreshed-a');
    final entered = Completer<void>();
    final release = Completer<void>();
    final reread = r.api.onUnauthorized!;
    r.api.onUnauthorized = () async {
      final replacement = await reread();
      entered.complete();
      await release.future;
      return replacement;
    };
    final pending = r.api.get('/api/projection');
    await _reply(await r.nextA(), 401, _unauthorized);
    await entered.future;
    r.adoptB();
    final rejected = expectLater(pending, throwsA(isA<ApiStaleRequest>()));
    release.complete();
    await rejected;
    expect(r.requestsA, hasLength(1));
    expect(r.requestsB, isEmpty);
    r.expectBIntact();
  });

  test('openUrl 等待期间切实例，不能向旧 origin 发送新凭据', () async {
    final r = await _Rig.open();
    final entered = Completer<void>();
    final release = Completer<void>();
    final inner = HttpClient();
    final delayed = _DelayedOpenClient(inner, entered, release);
    await HttpOverrides.runZoned(() async {
      final pending = r.api.get('/api/projection');
      await entered.future.timeout(const Duration(seconds: 5));
      r.adoptB();
      final rejected = expectLater(pending, throwsA(isA<ApiStaleRequest>()));
      release.complete();
      await rejected;
    }, createHttpClient: (_) => delayed);
    expect(r.requestsA, isEmpty, reason: '拿到请求句柄后必须先验代际，再写头或发送');
    expect(r.requestsB, isEmpty);
    r.expectBIntact();
  });

  test('同实例 401 仍用真实 AppState 回读接线，固定地址重试一次', () async {
    final r = await _Rig.open();
    r.sessions.write('instance-a', 'refreshed-a');
    final pending = r.state.pollOnce();
    final first = await r.nextA();
    expect(
      first.headers.value(HttpHeaders.authorizationHeader),
      'Bearer synthetic-a',
    );
    await _reply(first, 401, _unauthorized);
    final retried = await r.nextA();
    expect(retried.uri.path, '/api/stats/dashboard');
    expect(
      retried.headers.value(HttpHeaders.authorizationHeader),
      'Bearer refreshed-a',
    );
    await _reply(retried, 200, {
      'state': 'idle',
      'stateText': 'fresh A',
      'tiles': {'needsReview': 0},
    });
    await pending;
    expect(r.requestsA, hasLength(2));
    expect(r.requestsB, isEmpty);
    expect(r.api.token, 'refreshed-a');
    expect(r.state.online, isTrue);
    expect(r.state.stateText, 'fresh A');
  });

  test('当前实例从 401 学到标识，不会使同实例并发成功请求失效', () async {
    final r = await _Rig.open();
    r.api.instance = null;
    final denied = r.api.get('/api/denied');
    final good = r.api.get('/api/good');
    final first = await r.nextA();
    final second = await r.nextA();
    final byPath = {first.uri.path: first, second.uri.path: second};
    final rejected = expectLater(denied, throwsA(isA<ApiAuthError>()));
    await _reply(byPath['/api/denied']!, 401, _unauthorized);
    await rejected;
    expect(r.api.instance, 'instance-a');
    await _reply(byPath['/api/good']!, 200, {'ok': true});
    expect((await good)['ok'], isTrue);
  });

  test('同实例自愈换票后，其它携带旧票的在途请求不能触发登录门', () async {
    final r = await _Rig.open();
    r.sessions.write('instance-a', 'refreshed-a');
    final healing = r.api.get('/api/heal');
    final old = r.api.get('/api/old');
    final first = await r.nextA();
    final second = await r.nextA();
    final byPath = {first.uri.path: first, second.uri.path: second};
    await _reply(byPath['/api/heal']!, 401, _unauthorized);
    final retry = await r.nextA();
    await _reply(retry, 200, {'ok': true});
    expect((await healing)['ok'], isTrue);
    final rejected = expectLater(old, throwsA(isA<ApiStaleRequest>()));
    await _reply(byPath['/api/old']!, 401, _unauthorized);
    await rejected;
    expect(r.api.token, 'refreshed-a');
    expect(r.requestsA, hasLength(3));
  });

  test('重设相同 token 也使在途请求失效，避免切走再切回时接纳旧响应', () async {
    final r = await _Rig.open();
    final pending = r.api.get('/api/old');
    final request = await r.nextA();
    r.api.token = 'synthetic-a';
    final rejected = expectLater(pending, throwsA(isA<ApiStaleRequest>()));
    await _reply(request, 200, {'ok': true});
    await rejected;
    expect(r.api.inFlightCount, 0);
  });

  for (final useEvents in [false, true]) {
    test('正文失败边界 ${useEvents ? 'SSE' : 'GET'}：旧 401 不能变成当前实例认证错误', () async {
      final r = await _Rig.open();
      final finished = Completer<Object?>();
      if (useEvents) {
        r.api.events().listen(
          (_) {},
          onError: (Object error) {
            if (!finished.isCompleted) finished.complete(error);
          },
          onDone: () {
            if (!finished.isCompleted) finished.complete(null);
          },
        );
      } else {
        unawaited(
          r.api
              .get('/api/old')
              .then<void>(
                finished.complete,
                onError: (Object error) {
                  finished.complete(error);
                },
              ),
        );
      }
      final request = await r.nextA();
      request.response.statusCode = 401;
      request.response.headers.contentType = ContentType.json;
      request.response.write('{"error":');
      await request.response.flush();
      r.adoptB();
      // 非法 UTF-8 令读正文失败；无论停在响应头还是读体 await，都必须丢弃旧请求。
      request.response.add([0xff]);
      try {
        await request.response.close();
      } on HttpException {
        // API 可在观察到换代后先关闭旧连接。
      }
      expect(
        await finished.future.timeout(const Duration(seconds: 5)),
        isA<ApiStaleRequest>(),
      );
      expect(r.requestsB, isEmpty);
      r.expectBIntact();
    });
  }
}

const _unauthorized = {
  'error': {'code': 'unauthorized', 'message': 'old ticket'},
  'instance': 'instance-a',
};

Future<void> _reply(
  HttpRequest request,
  int status,
  Map<String, dynamic> body,
) async {
  request.response.statusCode = status;
  request.response.headers.contentType = ContentType.json;
  request.response.write(jsonEncode(body));
  await request.response.close();
}

class _Rig {
  late final HttpServer a;
  late final HttpServer b;
  late final Directory root;
  late final IrmiaApi api;
  late final SessionStore sessions;
  late final AppState state;
  final requestsA = <HttpRequest>[];
  final requestsB = <Map<String, String?>>[];
  int _nextAIndex = 0;
  Completer<void>? _nextArrival;

  static Future<_Rig> open() async {
    final r = _Rig();
    r.a = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    r.b = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    r.root = Directory.systemTemp.createTempSync('irmia-api-context-');
    r.api = IrmiaApi(
      baseUrl: 'http://127.0.0.1:${r.a.port}',
      token: 'synthetic-a',
    )..instance = 'instance-a';
    r.sessions = SessionStore(root: r.root.path)
      ..write('instance-b', 'synthetic-b');
    r.state = AppState(api: r.api, sessions: r.sessions)
      ..instance = 'instance-a';
    r.a.listen((request) {
      r.requestsA.add(request);
      r._nextArrival?.complete();
      r._nextArrival = null;
    });
    r.b.listen((request) async {
      await request.drain<void>();
      r.requestsB.add({
        'method': request.method,
        'path': request.uri.path,
        'auth': request.headers.value(HttpHeaders.authorizationHeader),
      });
      await _reply(request, 200, {'servedBy': 'B'});
    });
    addTearDown(() async {
      r.state.dispose();
      await r.a.close(force: true);
      await r.b.close(force: true);
      r.root.deleteSync(recursive: true);
    });
    return r;
  }

  Future<HttpRequest> nextA() async {
    if (_nextAIndex == requestsA.length) {
      _nextArrival = Completer<void>();
      await _nextArrival!.future.timeout(const Duration(seconds: 5));
    }
    return requestsA[_nextAIndex++];
  }

  void adoptB() {
    api.baseUrl = 'http://127.0.0.1:${b.port}';
    api.token = 'synthetic-b';
    api.instance = 'instance-b';
    state.instance = 'instance-b';
    state.ready = true;
    state.online = true;
    state.stateText = 'current B';
  }

  void expectBIntact() {
    expect(api.token, 'synthetic-b');
    expect(api.instance, 'instance-b');
    expect(state.instance, 'instance-b');
    expect(state.ready, isTrue);
    expect(state.online, isTrue);
    expect(state.stateText, 'current B');
    expect(sessions.read('instance-b'), 'synthetic-b');
  }
}

/// 仍然使用真实 HttpClient，只把 openUrl 返回句柄的时刻暂停，复现其 await 边界。
class _DelayedOpenClient implements HttpClient {
  _DelayedOpenClient(this.inner, this.entered, this.release);
  final HttpClient inner;
  final Completer<void> entered;
  final Completer<void> release;

  @override
  set connectionTimeout(Duration? value) => inner.connectionTimeout = value;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    final request = await inner.openUrl(method, url);
    entered.complete();
    await release.future;
    return request;
  }

  @override
  void close({bool force = false}) => inner.close(force: force);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
