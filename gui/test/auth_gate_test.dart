import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/auth_gate.dart';
import 'package:irmia_gui/home.dart';
import 'package:irmia_gui/session_store.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_state.dart';

/// 本地认证的两半：**门**（首次设密码 / 登录）与**会话凭据的存放**。
///
/// 这些用例对着的是这轮修的两个真故障：
///   ① 凭据存在一个**全局路径**（`%APPDATA%\Irmia\gui-token`），第二个实例一启动就把第一个顶掉，
///      于是"突然进不去"——回归用例见「两个实例各存一份」；
///   ② 401 之后界面只是把 token 清掉、留一片空白的壳，人只能自己去猜要重启——
///      自愈用例见「401 之后重读凭据再试一次」。
///
/// 界面不认识"数据目录"这件事，实例标识（`host:port#数据目录哈希`）是**服务端**告诉它的
/// （401 与认证响应里都带）；所以这里的假服务端也必须带上它，否则测的就不是真实链路。
void main() {
  late Directory tmpDir;

  setUp(() {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400；自愈那组要打真实服务
    HttpOverrides.global = null;
    tmpDir = Directory.systemTemp.createTempSync('irmia-auth-');
    // 凭据文件与界面状态文件都指向临时目录：别踩真实 %APPDATA%
    sessionsRootOverride = '${tmpDir.path}${Platform.pathSeparator}sessions';
    stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
    // 老界面那份全局凭据也指向临时文件：默认不存在（等价于"全新机器"），
    // 要测半升级兜底的那几条自己写一份
    legacyGuiTokenOverride = '${tmpDir.path}${Platform.pathSeparator}gui-token';
  });

  tearDown(() {
    sessionsRootOverride = null;
    stateFileOverride = null;
    legacyGuiTokenOverride = null;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });

  // ──────────────────────────── ① 凭据存放：一个实例一份 ────────────────────────────

  group('SessionStore', () {
    test('两个实例各存一份，互不覆盖（"第二个实例把第一个顶掉"的回归用例）', () {
      final store = SessionStore();
      const first = '127.0.0.1:7788#aabbccddeeff0011';
      const second = '127.0.0.1:7789#1122334455667788';

      store.write(first, 'token-of-first');
      store.write(second, 'token-of-second');

      expect(store.read(first), 'token-of-first', reason: '第二个实例不该把第一个的凭据顶掉');
      expect(store.read(second), 'token-of-second');
      expect(store.pathFor(first), isNot(store.pathFor(second)));
    });

    test('实例标识里的 : 与 # 被净化成安全文件名，且是确定性的', () {
      expect(SessionStore.sanitize('127.0.0.1:7788#aabbccdd'), '127.0.0.1_7788_aabbccdd');
      // 同一标识永远映射到同一个文件（净化必须是纯函数，否则"换个写法就认不出自己的凭据"）
      expect(SessionStore.sanitize('a:b#c'), SessionStore.sanitize('a:b#c'));
      // 反斜杠、空格、中文路径片段一律换掉：Windows 文件名不允许的字符不该靠"我知道有哪些"
      expect(SessionStore.sanitize(r'C:\data\app'), 'C__data_app');
      expect(SessionStore.sanitize(''), 'unknown');
      expect(SessionStore.sanitize('  '), 'unknown');
      expect(SessionStore.sanitize('x' * 400).length, 120, reason: '超长标识要截断，别拿它当路径');
    });

    test('文件缺失 / 空 / 只有空白都回 null（绝不抛）', () {
      final store = SessionStore();
      const key = '127.0.0.1:7788#aabbccddeeff0011';
      expect(store.read(key), isNull);

      File(store.pathFor(key)).parent.createSync(recursive: true);
      File(store.pathFor(key)).writeAsStringSync('   \n');
      expect(store.read(key), isNull, reason: '空文件等于没有凭据');

      store.clear(key);
      expect(store.read(key), isNull);
    });

    test('写进去会建好父目录；清掉之后读不到', () {
      final store = SessionStore();
      const key = '127.0.0.1:7788#aabbccddeeff0011';
      store.write(key, 'tok');
      expect(File(store.pathFor(key)).existsSync(), isTrue);
      expect(store.read(key), 'tok');
      store.clear(key);
      expect(File(store.pathFor(key)).existsSync(), isFalse);
    });
  });

  // ──────────────────────────── ② 门的两态 ────────────────────────────

  group('门：首次设密码 / 登录', () {
    testWidgets('未初始化（auth-uninitialized）→ 画"设置密码"，两个遮蔽输入框', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..getErrors['/api/projection'] = const ApiAuthError(
          '这台实例还没设密码。请先在界面里设置一个密码。',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      await _pumpGate(tester, state);

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.setup);
      expect(find.text('设置密码'), findsOneWidget);
      expect(find.text('再输一遍'), findsOneWidget);

      // 遮蔽是这个门唯一不能省的东西
      final fields = tester.widgetList<TextField>(find.byType(TextField)).toList();
      expect(fields.length, 2);
      for (final field in fields) {
        expect(field.obscureText, isTrue, reason: '密码框必须遮蔽');
      }
    });

    testWidgets('设过密码但凭据不作数 → 画"登录"，只有一个框', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..getErrors['/api/projection'] = const ApiAuthError(
          '缺少或无效的会话凭据（可能改过密码或已登出）。请重新登录。',
          code: 'unauthorized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      await _pumpGate(tester, state);

      expect(state.gate, AuthGateKind.login);
      expect(find.text('登录'), findsWidgets);
      expect(find.text('设置密码'), findsNothing);
      expect(tester.widgetList<TextField>(find.byType(TextField)).length, 1);
      expect(tester.widget<TextField>(find.byType(TextField)).obscureText, isTrue);
    });

    // ── 2026-10-23：门的判据只认事实（公开的 `/api/auth/state`），401 的 code 只是兜底 ──
    //
    // 现场：`.auth.json` 存在（有密码），界面却画着"设置密码"，底部红字是探测那次的
    // `auth-uninitialized` message；提交设置 → 409 → 表单永远失败 ⇒ 死锁。
    // 这一组钉住三件事：① state 优先于 code；② 探测结果不进红字；③ 站错门时当场换门。

    testWidgets('公开状态端点说"还没设密码" → 设置密码页（哪怕 401 的 code 是 unauthorized）', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..authInitialized = false
        ..getErrors['/api/projection'] = const ApiAuthError(
          '缺少或无效的会话凭据（可能改过密码或已登出）。请重新登录。',
          code: 'unauthorized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      await _pumpGate(tester, state);

      expect(api.authStateCalls, 1, reason: '进门判据要先读公开事实，不能只看 401 的 code');
      expect(state.gate, AuthGateKind.setup);
      expect(find.text('设置密码'), findsOneWidget);
      // 探测结果不是错误：401 那句话不许变成红字（现场就是这么误报的）
      expect(state.gateError, isEmpty);
      expect(find.textContaining('请重新登录'), findsNothing);
      expect(find.byIcon(Icons.error_outline_rounded), findsNothing, reason: '探测结果不该进错误行');
      // 交叉文案：设置页里不该出现"重新登录"
      expect(find.textContaining('重新登录'), findsNothing);
    });

    testWidgets('公开状态端点说"设过密码" → 登录页（哪怕服务端回的是 auth-uninitialized）', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..authInitialized = true
        ..getErrors['/api/projection'] = const ApiAuthError(
          '这台实例还没设密码。请先在界面里设置一个密码。',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      await _pumpGate(tester, state);

      expect(api.authStateCalls, 1);
      expect(state.gate, AuthGateKind.login);
      expect(find.text('设置密码'), findsNothing);
      expect(state.gateError, isEmpty, reason: '401 是分流信号，不是红字');
      // 交叉文案：登录页里不该出现"还没设密码"这类话
      expect(find.textContaining('还没设密码'), findsNothing);
      expect(find.byIcon(Icons.error_outline_rounded), findsNothing);
    });

    testWidgets('设置提交收到 409 already-initialized → 原地切到登录页（不许对着永远失败的表单）', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..authInitialized = false
        ..getErrors['/api/projection'] = const ApiAuthError(
          '这台实例还没设密码。请先在界面里设置一个密码。',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        )
        ..authErrors['/api/auth/setup'] = const ApiAuthError(
          '这台实例已经设过密码了。忘记密码的处理办法：删掉 data/.auth.json 后重启进程，再设一次。',
          code: 'already-initialized',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);
      await state.bootstrap();
      await _pumpGate(tester, state);
      expect(state.gate, AuthGateKind.setup);

      await tester.enterText(find.byType(TextField).at(0), 'irmia-local-pw');
      await tester.enterText(find.byType(TextField).at(1), 'irmia-local-pw');
      await tester.tap(find.text('设置并进入'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.login, reason: '409 = 这台实例已经有密码，该去登录');
      expect(find.text('设置密码'), findsNothing);
      expect(find.text('登录'), findsWidgets);
      expect(state.gateError, isEmpty, reason: '这不是"设置失败"，是站错了门');
      expect(find.text('这台实例已设过密码，请用密码登录。'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline_rounded), findsNothing, reason: '红字那一行不该出现');
      expect(find.textContaining('忘记密码的处理办法'), findsNothing, reason: '服务端 409 原话不进红字');
    });

    testWidgets('登录时服务端说"还没设密码" → 切到设置页（反方向也不让表单白转）', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..authInitialized = true
        ..getErrors['/api/projection'] = const ApiAuthError(
          '缺少或无效的会话凭据（可能改过密码或已登出）。请重新登录。',
          code: 'unauthorized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        )
        ..authErrors['/api/auth/login'] = const ApiAuthError(
          '这台实例还没设密码。请先在界面里设置一个密码。',
          code: 'auth-uninitialized',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);
      await state.bootstrap();
      await _pumpGate(tester, state);
      expect(state.gate, AuthGateKind.login);

      await tester.enterText(find.byType(TextField), 'irmia-local-pw');
      await tester.tap(find.widgetWithText(FilledButton, '登录'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.gate, AuthGateKind.setup, reason: '服务端说还没设密码，就该去设置页');
      expect(state.gateError, isEmpty);
      expect(find.text('再输一遍'), findsOneWidget);
      expect(find.text('这台实例还没有密码，先设一个。'), findsOneWidget);
      expect(find.textContaining('重新登录'), findsNothing, reason: '设置页不该出现"重新登录"');
    });

    testWidgets('两页各说各的：设置页没有"重新登录"，登录页没有"还没设密码"；两页都写明忘记密码怎么办', (tester) async {
      final setupApi = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..authInitialized = false
        ..getErrors['/api/projection'] = const ApiAuthError(
          '这台实例还没设密码。请先在界面里设置一个密码。',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final setupState = AppState(api: setupApi);
      addTearDown(setupState.dispose);
      await setupState.bootstrap();
      await _pumpGate(tester, setupState);

      expect(find.textContaining('忘记密码'), findsOneWidget, reason: '设置页也要说清恢复路径');
      expect(find.textContaining('重新登录'), findsNothing);

      final loginApi = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..authInitialized = true
        ..getErrors['/api/projection'] = const ApiAuthError(
          '缺少或无效的会话凭据（可能改过密码或已登出）。请重新登录。',
          code: 'unauthorized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final loginState = AppState(api: loginApi);
      addTearDown(loginState.dispose);
      await loginState.bootstrap();
      await tester.pumpWidget(_harness(loginState));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.textContaining('忘记密码'), findsOneWidget, reason: '登录页要写明"删掉 .auth.json 重启"这条恢复路径');
      expect(find.textContaining('还没设密码'), findsNothing);
    });

    testWidgets('两次输入不一致：当场拦下，一个请求都不发', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..getErrors['/api/projection'] = const ApiAuthError(
          '还没设密码',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);
      await state.bootstrap();
      await _pumpGate(tester, state);

      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'irmia-local-pw');
      await tester.enterText(fields.at(1), 'irmia-local-pW');
      await tester.tap(find.text('设置并进入'));
      await tester.pump();

      expect(state.gateError, contains('两次输入的密码不一样'));
      expect(find.textContaining('两次输入的密码不一样'), findsOneWidget, reason: '提示要留在卡片上');
      expect(api.authCalls, isEmpty, reason: '本地就能看出的问题不该白跑一趟服务端');
      expect(state.ready, isFalse);
    });

    testWidgets('密码太短：当场拦下并说清几位', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..getErrors['/api/projection'] = const ApiAuthError(
          '还没设密码',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);
      await state.bootstrap();
      await _pumpGate(tester, state);

      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'abc');
      await tester.enterText(fields.at(1), 'abc');
      await tester.tap(find.text('设置并进入'));
      await tester.pump();

      expect(state.gateError, contains('至少 6 位'));
      // 卡片上会出现两处"至少 6 位"：输入框的 hint 与这行错误。断言"错误那一行在"
      // 而不是数字面量出现几次——后者会被无关的文案改动弄红。
      expect(find.textContaining('至少 6 位'), findsWidgets);
      expect(find.textContaining('现在 3 位'), findsOneWidget);
      expect(api.authCalls, isEmpty);
    });

    testWidgets('设密码成功 → 门收起来，主界面出现（当场就是登录态）', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..getErrors['/api/projection'] = const ApiAuthError(
          '还没设密码',
          code: 'auth-uninitialized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        )
        ..authResults['/api/auth/setup'] = {
          'ok': true,
          'token': 'fresh-session-token',
          'sessionId': 'aabbccddeeff0011',
          'createdAt': '2026-10-01T00:00:00.000Z',
          'instance': '127.0.0.1:7788#aabbccddeeff0011',
        };
      final state = AppState(api: api);
      // 这条用例**在用例体内**销毁 state（不是 addTearDown）：进门会起一个 10 秒的轮询定时器，
      // 而 flutter_test 的"还有定时器挂着"检查跑在 tearDown **之前**——晚一步就必然红。
      await state.bootstrap();
      await _pumpGate(tester, state);

      final fields = find.byType(TextField);
      await tester.enterText(fields.at(0), 'irmia-local-pw');
      await tester.enterText(fields.at(1), 'irmia-local-pw');
      await tester.tap(find.text('设置并进入'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.ready, isTrue, reason: '设完密码就是登录态，不该再让人输一遍');
      expect(api.token, 'fresh-session-token');
      expect(find.byType(AuthGate), findsNothing);
      expect(find.byType(HomeShell), findsOneWidget, reason: '门后面就是主界面');

      state.dispose();
    });

    testWidgets('错密码：服务端那句话照原样显示，门还停在登录', (tester) async {
      final api = _FakeApi()
        ..instance = '127.0.0.1:7788#aabbccddeeff0011'
        ..getErrors['/api/projection'] = const ApiAuthError(
          '缺少或无效的会话凭据。请重新登录。',
          code: 'unauthorized',
          instance: '127.0.0.1:7788#aabbccddeeff0011',
        )
        ..authErrors['/api/auth/login'] = const ApiAuthError(
          '密码不对。连续失败后会退避：下一次尝试前要等约 1 秒。',
          code: 'bad-password',
        );
      final state = AppState(api: api);
      addTearDown(state.dispose);
      await state.bootstrap();
      await _pumpGate(tester, state);

      await tester.enterText(find.byType(TextField), 'wrong-password');
      await tester.tap(find.widgetWithText(FilledButton, '登录'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.login);
      expect(find.textContaining('密码不对'), findsOneWidget);
      expect(find.textContaining('等约 1 秒'), findsOneWidget, reason: '退避要如实告诉人，别让他对着转圈猜');
    });
  });

  // ──────────────────── ③ 401 自愈（真 HttpClient + 真凭据文件） ────────────────────

  group('401 自愈', () {
    /// 起一个真的本地 HTTP 服务：自愈那段逻辑活在 `IrmiaApi._send` 里，
    /// 用替身绕过 HTTP 就等于把被测的东西换掉了。
    Future<HttpServer> serve(void Function(HttpRequest req, HttpResponse res) handler) async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) => handler(req, req.response));
      return server;
    }

    void writeAuthError(HttpResponse res, String code, String message, String instance) {
      res.statusCode = 401;
      res.headers.contentType = ContentType.json;
      res.write(jsonEncode({
        'error': {'code': code, 'message': message},
        'instance': instance,
      }));
    }

    test('401 之后重读凭据再试一次：另一次登录把文件重写了 → 就地恢复，不退回登录态', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      final store = SessionStore();
      store.write(instance, 'stale-token');
      var served = 0;

      final server = await serve((req, res) {
        served += 1;
        final auth = req.headers.value(HttpHeaders.authorizationHeader) ?? '';
        if (auth == 'Bearer fresh-token') {
          res.write(jsonEncode({'lastSeq': 0, 'pending': <dynamic>[]}));
        } else {
          writeAuthError(res, 'unauthorized', '会话凭据无效或已失效。请重新登录。', instance);
        }
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}')..instance = instance;
      final state = AppState(api: api, sessions: store);
      addTearDown(state.dispose);
      api.token = 'stale-token';
      // 实例标识平时是 bootstrap 从 401 里学回来的；这条用例直接把它摆好，
      // 好让"重读凭据"知道该去哪个文件读（真实链路由上面的 bootstrap 用例钉着）
      state.instance = instance;

      // "另一个进程重登了"：凭据文件被换成新的
      store.write(instance, 'fresh-token');

      await state.pollOnce();

      expect(served, 2, reason: '第一次 401 → 重读凭据 → 恰好重试一次');
      expect(api.token, 'fresh-token');
      expect(state.online, isTrue);
      expect(state.ready, isFalse, reason: 'pollOnce 本身不切门；门由 bootstrap/登录那几条路维护');
    });

    test('401 且凭据文件里还是那张废票 → 回到登录态（不是白屏，也不是"认证失败"死胡同）', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      final store = SessionStore();
      store.write(instance, 'stale-token');
      var served = 0;

      final server = await serve((req, res) {
        served += 1;
        writeAuthError(res, 'unauthorized', '会话凭据无效或已失效。请重新登录。', instance);
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}')..instance = instance;
      final state = AppState(api: api, sessions: store);
      addTearDown(state.dispose);
      state.ready = true; // 假装已经进了主界面
      state.instance = instance;
      api.token = 'stale-token';

      await state.pollOnce();

      expect(served, 2, reason: '仍然只重试一次，不循环打服务端');
      expect(state.ready, isFalse, reason: '票不作数了就得回门上去');
      expect(state.gate, AuthGateKind.login);
      expect(state.gateError, isEmpty, reason: '401 是分流信号，不是红字那一行里的错误');
      expect(state.gateHint, AuthGateHint.sessionExpired, reason: '要告诉人"再来一次"，但那句是中性提示');
      expect(state.stateText, contains('重新登录'));
      expect(api.token, isNull);
      expect(store.read(instance), isNull, reason: '已证明不作数的票不该留在盘上，让每次开界面都白跑一趟');
    });

    testWidgets('回到登录态时画的是门，而不是一片空白的壳（回归）', (tester) async {
      // 这条**不打网络**：要断言的是"`ready` 变回 false 之后界面画什么"。
      // 真实 401 → 回门那条链路在上面两条 `test` 里已经按 AppState 的口径钉过了；
      // 在 testWidgets 里再跑一次真 HTTP 只会让这条用例又慢又脆。
      final api = _FakeApi()..instance = '127.0.0.1:7788#aabbccddeeff0011';
      final state = AppState(api: api);
      addTearDown(state.dispose);

      // 先确认它确实画得出壳（否则"没有壳"这个断言是空的）
      state.ready = true;
      await _pumpGate(tester, state);
      expect(find.byType(HomeShell), findsOneWidget);

      // 服务端说票不作数了 → 回门
      state.ready = false;
      state.gate = AuthGateKind.login;
      // 换门的原因走中性提示行，**不进红字**（2026-10-23 的口径，见 AppState.gateHint）
      state.gateHint = AuthGateHint.sessionExpired;
      state.gateError = '';
      state.notifyListeners();
      await tester.pump();

      expect(find.byType(HomeShell), findsNothing, reason: '不该把人留在壳里对着空白发呆');
      expect(find.byType(AuthGate), findsOneWidget);
      expect(find.text('登录'), findsWidgets);
      expect(find.textContaining('重新登录'), findsOneWidget);
      expect(find.byIcon(Icons.error_outline_rounded), findsNothing,
          reason: '分流信号不是错误：红字那一行不该出现');
    });

    test('凭据文件缺了 → 启动握手画登录态，而不是崩或白屏', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      final server = await serve((req, res) {
        writeAuthError(res, 'unauthorized', '缺少或无效的会话凭据。请重新登录。', instance);
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = AppState(api: api, sessions: SessionStore());
      addTearDown(state.dispose);

      await state.bootstrap();

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.login);
      expect(state.instance, instance, reason: '实例标识要从 401 里学回来（界面不知道数据目录）');
    });

    test('老服务端没有 /api/auth/state（落进认证闸回 401）→ 问不出来，门退回 401 的 code 分流', () async {
      // 半升级现场：界面已经是新的（会先问 state），服务端还是旧的（这条端点不存在）。
      // 老服务端会把 `/api/auth/state` 当成普通 `/api/*` ⇒ 401。界面必须把"问不出来"
      // 与"它说没设密码"分得开：前者退回 code 分流，后者才画设置页。
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      final server = await serve((req, res) {
        if (req.uri.path == '/api/auth/state') {
          writeAuthError(res, 'unauthorized', '缺少或无效的会话凭据。请重新登录。', instance);
        } else {
          writeAuthError(res, 'auth-uninitialized', '这台实例还没设密码。请先在界面里设置一个密码。', instance);
        }
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = AppState(api: api, sessions: SessionStore());
      addTearDown(state.dispose);

      expect(await api.authState(), isNull, reason: '401 = 老服务端没有这条端点 ⇒ 问不出来，不是"没设密码"');

      await state.bootstrap();
      expect(state.gate, AuthGateKind.setup, reason: '问不出来才用 401 的 code：auth-uninitialized ⇒ 设置页');
      expect(state.gateError, isEmpty);
      expect(state.gateHint, AuthGateHint.none, reason: '正常进门不算"换了门"，不摆提示');
    });

    test('半升级兜底：还没设密码时，老界面那份全局凭据仍能让人进门（并提醒去设密码）', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      // 老界面把凭据写在这个**全局**路径上——正是本轮修掉的那个坑，但升级期还得读它一次
      legacyGuiTokenOverride = '${tmpDir.path}${Platform.pathSeparator}gui-token';
      File(legacyGuiTokenOverride!).writeAsStringSync('legacy-ui-token-value');

      final server = await serve((req, res) {
        final auth = req.headers.value(HttpHeaders.authorizationHeader) ?? '';
        if (auth == 'Bearer legacy-ui-token-value') {
          res.write(jsonEncode({'lastSeq': 0, 'pending': <dynamic>[], 'tiles': {'needsReview': 0}}));
        } else {
          writeAuthError(res, 'auth-uninitialized', '这台实例还没设密码。请先在界面里设置一个密码。', instance);
        }
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = AppState(api: api, sessions: SessionStore());
      addTearDown(state.dispose);

      await state.bootstrap();

      expect(state.ready, isTrue, reason: '半升级状态不该把人挡在门外');
      expect(state.onLegacyToken, isTrue);
      expect(state.needsPasswordPrompt, isTrue, reason: '进得来，但要说一次"现在设个密码"');
      expect(api.token, 'legacy-ui-token-value');
    });

    test('半升级兜底：老凭据已经不作数 → 仍旧画"设置密码"（兜底不能变成绕过）', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      legacyGuiTokenOverride = '${tmpDir.path}${Platform.pathSeparator}gui-token';
      File(legacyGuiTokenOverride!).writeAsStringSync('stale-legacy-token-value');

      final server = await serve((req, res) {
        writeAuthError(res, 'auth-uninitialized', '这台实例还没设密码。请先在界面里设置一个密码。', instance);
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = AppState(api: api, sessions: SessionStore());
      addTearDown(state.dispose);

      await state.bootstrap();

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.setup);
      expect(state.onLegacyToken, isFalse);
      expect(api.token, isNull, reason: '试失败的旧凭据不该留在手上');
    });

    test('「现在设置」：壳收起来、回到门上的设密码态（设密码只有一处实现）', () {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      state.ready = true;
      state.needsPasswordPrompt = true;

      state.openPasswordSetup();

      expect(state.ready, isFalse);
      expect(state.gate, AuthGateKind.setup);
      expect(state.gateError, isEmpty);
    });

    test('「以后再说」：不再打扰，并把这件事记进 ui-state.json', () async {
      final api = _FakeApi();
      final state = AppState(api: api);
      addTearDown(state.dispose);
      state.needsPasswordPrompt = true;

      state.dismissPasswordPrompt();

      expect(state.needsPasswordPrompt, isFalse);
      // 落盘是异步的（ui_state 的写入队列），给它几轮真实 I/O
      var written = false;
      for (var i = 0; i < 40 && !written; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        written = (await loadFlag(kPasswordPromptDoneFlag)) ?? false;
      }
      expect(written, isTrue, reason: '按过「以后再说」之后不该每次开界面都再问一遍');
    });

    test('已存凭据且它有效 → 直接进主界面，不打扰人', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      final store = SessionStore();
      store.write(instance, 'good-token');
      final server = await serve((req, res) {
        final auth = req.headers.value(HttpHeaders.authorizationHeader) ?? '';
        if (auth == 'Bearer good-token') {
          res.write(jsonEncode({'lastSeq': 3, 'state': 'idle', 'tiles': {'needsReview': 0}}));
        } else {
          writeAuthError(res, 'unauthorized', '缺少或无效的会话凭据。请重新登录。', instance);
        }
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = AppState(api: api, sessions: store);
      addTearDown(state.dispose);

      await state.bootstrap();

      expect(state.ready, isTrue, reason: '有有效凭据就不该再弹门');
      expect(api.token, 'good-token');
      expect(state.instance, instance);
    });

    // ── 门前连不上：**可恢复态**，不是一张等着人按重试的错误卡 ──
    //
    // 已查实的现场（2026-10-04）：用户按「重启前后端」，界面先起来、node 还在载入事件日志，
    // 界面打 127.0.0.1:7788 拿到连接被拒，于是停在一张红卡上——**只有人按「重试」才有第二次机会**。
    // 这三条锁的是修好之后的分寸：宽限窗口内只说进度（中性话）、窗口过了才说"确认主进程在运行"、
    // 而且降级之后**仍然在后台慢速重试**（服务端一起来就自己进门，一次按键都不用按）。

    test('连不上本地服务：停在"正在连接"那一屏，并自动重试（不是弹登录框、也不是终态）', () async {
      // 替身抛连接类异常，不真去连一个没人听的端口：这一条测的是门前的状态机，
      // 而真连一个关闭的回环端口在本机要 ~2 秒才失败（Windows 上 SYN 会重试），
      // 那种耗时是环境的怪癖，不该写进断言里
      final api = _FakeApi()..down = true;
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      expect(state.gateAttempt, 1, reason: '这一次是第 1 次尝试');

      expect(state.ready, isFalse, reason: '连不上就不该进壳');
      expect(state.gate, AuthGateKind.checking, reason: '连不上不该被当成"你没凭据"，那是登录态');
      expect(state.gateRetrying, isTrue, reason: '自动重连必须已经挂上');
      expect(state.gateUnreachable, isFalse, reason: '宽限窗口内不算"连不上"，只是还在连');
      expect(state.gateError, isEmpty, reason: '窗口内只说中性话（"本地服务正在启动…"），不喊主进程');

      // 等一拍：第 2 次尝试真的发出去了（后台重试，没人按键）
      await _until(() => state.gateAttempt >= 2);
      expect(state.gateRetrying, isTrue);
      expect(state.gateError, isEmpty, reason: '第 2 次也连不上时，话还是那句中性的');
    });

    testWidgets('门卡上摆的是"正在启动…（第 N 次尝试，已等 Xs）"，且没人按键它自己会再试', (tester) async {
      // 用替身抛一个**连接类**的异常（形状与 SocketException 一致，但不是 HTTP 应答）：
      // 这里要测的是门卡怎么画、计数怎么走，不需要真去连一个不存在的端口
      final api = _FakeApi()..down = true;
      final state = AppState(api: api);
      var stateDisposed = false;
      await state.bootstrap();
      await _pumpGate(tester, state);

      expect(find.text('正在连接本地服务'), findsOneWidget, reason: '窗口内是中性话，不是错误卡');
      expect(find.textContaining('本地服务正在启动…（第 1 次尝试，已等 0s）'), findsOneWidget);
      expect(find.textContaining('确认主进程正在运行'), findsNothing, reason: '窗口没过就不该说这句');
      expect(find.text('立即重试'), findsNothing, reason: '窗口内不摆"重试"：那会让人以为必须按它');

      // 没人按任何键：那一拍（0.3 秒）到点后，门卡上的计数自己往前走了
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pump();
      expect(state.gateAttempt, greaterThanOrEqualTo(2),
          reason: '重试是真的自己发出的，不靠人按键');
      expect(find.textContaining('第 ${state.gateAttempt} 次尝试'), findsOneWidget);
      expect(state.gateError, isEmpty);

      // 收尾：那条重连定时器是活的（这是它的设计），**在被测对象上**显式收掉它。
      // 不这么做的话，widget 测试收尾时会报 "Pending timers"——那是测试自己的账，
      // 不是界面的毛病（真机上 AppState 随窗口一起退场，dispose 里会取消它）。
      state.dispose();
      stateDisposed = true;
      addTearDown(() {
        if (!stateDisposed) state.dispose();
      });
    });

    test('窗口用尽才降级成错误卡，且降级之后仍然慢速重试（不放弃）', () async {
      // 宽限窗口缩到 2 秒，好在用例里把"窗口用尽"走到：真机上它是 60 秒（kGateGraceSeconds）
      gateGraceSecondsOverride = 2;
      addTearDown(() => gateGraceSecondsOverride = null);

      // 同上：替身立刻抛错，等待秒数的推进才是"定时器的节奏"而不是"一次连不上要多久"
      final api = _FakeApi()..down = true;
      final state = AppState(api: api);
      addTearDown(state.dispose);

      await state.bootstrap();
      // 宽限窗口是"真时间"走出来的（重试节奏 0.3~1 秒），所以只能用真等待等它——
      // 这不是"随便睡一会儿"，而是把"没人按键时它也在一拍一拍地试"这件事等出来。
      //
      // 预算 200 次 × 50 毫秒 = 10 秒，远大于窗口（2 秒）+ 退避节奏（≤1 秒）。
      // 曾经把这条判成"预算不够"是**误诊**（实测：这条等 10 秒也不成立）——
      // 真正的原因是重试那一拍被当成了"新的第一轮"，等待秒数每次被重置回 0，
      // 窗口永远走不到头（见 AppState._onConnectFailure 里的说明）。
      // 这件事后来是靠探针逐 100ms 采样查出来的，不是靠加预算。
      await _until(() => state.gateWaited >= 2, tries: 200);

      expect(state.gateUnreachable, isTrue, reason: '窗口过了就该把话说重');
      expect(state.gateError, contains('连不上本地服务'));
      expect(state.gateError, contains('确认主进程正在运行'), reason: '这时候才说"去确认主进程"');
      expect(state.gateError, contains('每 $kGateSlowRetrySeconds 秒仍会自动重试'),
          reason: '"什么都不按也会自己好"必须写出来，否则那颗「立即重试」会盖过这件事');

      // **降级不是放弃**：重试还在跑（只是慢下来），界面还停在门上等。
      //
      // 先证明"慢下来"这一半：宽限窗口内是 0.3~1 秒一拍，窗口过了是
      // `kGateSlowRetrySeconds`（3 秒）。取 1.2 秒这个窗口——快节奏（≤1 秒）在这段时间里
      // 一定又打过一两拍，慢节奏一拍都不该有。这条与下面那条一起，把"退避真的换档了"
      // 钉住：只等"还会再试"的话，一个永远 0.3 秒猛打的实现也能过。
      final attempts = state.gateAttempt;
      await Future<void>.delayed(const Duration(milliseconds: 1200));
      expect(state.gateAttempt, attempts,
          reason: '降级之后那一拍要等 $kGateSlowRetrySeconds 秒，不该还按窗口内的快节奏打');

      // 这里的等待预算必须**大于**慢速重试的节奏（`kGateSlowRetrySeconds` = 3 秒）：
      // 拿 3 秒去等一个 3 秒的定时器就是掷硬币——第一版就是这么偶发红的。
      await _until(() => state.gateAttempt > attempts, tries: 240);
      expect(state.gateAttempt, greaterThan(attempts), reason: '降级之后仍然在后台重试');
      // 措辞不来回跳：重试那一拍**不许**把"确认主进程在运行"擦回中性话再写回来
      // （一擦一写就是卡片每隔几秒换一次口径；真机上一条连接失败要一两秒，跳得更明显）
      expect(state.gateUnreachable, isTrue, reason: '重试那一拍不该把降级撤回去');
      expect(state.gateError, contains('确认主进程正在运行'));
      expect(state.gate, AuthGateKind.checking);
      expect(state.ready, isFalse);
    });

    test('服务端起来了就自动进门——一次按键都不用按', () async {
      // 先占一个端口再放掉：用例拿到的就是一个**此刻没人监听**的端口（真实的重启现场）
      final probe = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final port = probe.port;
      await probe.close(force: true);

      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:$port');
      final state = AppState(api: api, sessions: SessionStore());
      addTearDown(state.dispose);

      await state.bootstrap();
      expect(state.gateRetrying, isTrue);
      expect(state.gateError, isEmpty);

      // "node 载入完了"：同一个端口上开始有人应答（回 401 = 服务在，但手上这张票不作数）
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
      server.listen((req) {
        final res = req.response
          ..statusCode = 401
          ..headers.contentType = ContentType.json
          ..write(jsonEncode({
            'error': {'code': 'unauthorized', 'message': '缺少或无效的会话凭据。请重新登录。'},
            'instance': instance,
          }));
        unawaited(res.close());
      });
      addTearDown(() => server.close(force: true));

      // 没有任何人按键：界面自己重试到服务端应答，并且认出这是"该登录"而不是"还在启动"
      await _until(() => state.gate == AuthGateKind.login, tries: 200);
      expect(state.ready, isFalse, reason: '没人登录过，门还得在');
      expect(state.gateRetrying, isFalse, reason: '握手走通了，门前那套重连该收掉');
      expect(state.gateUnreachable, isFalse);
      expect(state.gateError, isEmpty, reason: '401 那条路由门自己画登录态，不是门前的错误');
      expect(state.gateAttempt, 0, reason: '门开了之后计数归零：下一次门前等待从第 1 次数起');
    });

    testWidgets('进了壳之后断线：心跳从 10 秒加快到 2 秒，恢复后回到 10 秒', (tester) async {
      // 这一条要的是**假时钟**：被测的是"心跳节奏换了没有"，
      // 而用真时间数请求数会被 HttpClient 自己的失败耗时搅浑——实测一次连不上的心跳要 2 秒才失败，
      // 于是"2 秒里打了几次"那种断言测的其实是那个失败耗时，不是节奏。
      // 心跳那条 GET 用替身：`pollOnce` 的 catch 分支正是换节奏的地方，
      // 替身抛错与"主进程没在跑"在这一路上的行为完全一致。
      //
      // 假时钟走 `testWidgets` 自己那一套：测试体本来就跑在 FakeAsync 里，
      // `tester.pump(时长)` = 推进假时钟 + 把到点的定时器与微任务放出来。**不引
      // `package:fake_async`**：它只是 flutter_test 的传递依赖，直接 import 会被
      // `depend_on_referenced_packages` 判为"用了没声明的依赖"，而这一版不动 pubspec。
      final api = _FakeApi();
      final state = AppState(api: api);
      var stateDisposed = false;
      // 摆在"已经进了壳"的位置上：这一条测的是进壳之后的心跳，不是进门那一段
      state.ready = true;

      /// 推进 [seconds] 秒，返回这段时间里心跳打了几拍
      Future<int> beatsIn(int seconds) async {
        final before = api.dashboardCalls;
        await tester.pump(Duration(seconds: seconds));
        return api.dashboardCalls - before;
      }

      // 先按"已经进了壳"的常态起步：心跳是 10 秒一拍
      state.startPolling();
      await tester.pump();
      expect(api.dashboardCalls, 1, reason: '进壳时立刻打第一拍');
      // 10 秒一拍的证据：30 秒里最多 3 拍（2 秒一拍的话这里会是 15 拍）
      expect(await beatsIn(30), lessThanOrEqualTo(3),
          reason: '正常节奏是 $kOnlinePollSeconds 秒一拍，不是快速那一档');

      // 服务端不在了：这一拍（10 秒的节奏上）失败之后必须换成 2 秒
      api.down = true;
      expect(await beatsIn(24), greaterThanOrEqualTo(8),
          reason: '断线期间心跳要加快到 $kOfflinePollSeconds 秒，好让"她回来了"尽早被看见');
      expect(state.online, isFalse);
      expect(state.stateText, '连接中断', reason: '壳里的口径不变：连接中断');
      expect(state.ready, isTrue, reason: '断线不该把人踢回门前（那是"重启中"，不是"进不去"）');

      // 服务端回来：节奏必须调回 10 秒，否则一次重启会让界面永久每 2 秒打一次
      // （40 秒这个窗口把两种节奏分得很开：2 秒会是 19 拍左右，10 秒只有 4 拍）
      api.down = false;
      expect(await beatsIn(6), greaterThanOrEqualTo(1), reason: '恢复那一拍要先真的打出去');
      expect(state.online, isTrue, reason: '服务端一应答就该恢复');
      expect(await beatsIn(40), lessThanOrEqualTo(6),
          reason: '恢复后要回到 $kOnlinePollSeconds 秒一拍');

      // 收尾：心跳是一条 periodic 定时器，假时钟下它是"还欠着的定时器"——在被测对象上显式
      // 收掉它（真机上 AppState 随窗口退场，dispose 里会取消）。不这么做的话，
      // widget 测试收尾会报 "A Timer is still pending"，那是测试自己的账，不是界面的毛病。
      state.dispose();
      stateDisposed = true;
      addTearDown(() {
        if (!stateDisposed) state.dispose();
      });
    });

    test('进了壳再断线：状态话保持"连接中断"，人不被踢回门前（真 HTTP）', () async {
      const instance = '127.0.0.1:7788#aabbccddeeff0011';
      // 这一段要的是**真 HTTP**：被测的是"服务端真的不在了"时壳里的那一态，
      // 用替身绕过 HTTP 就等于把被测的东西换掉了（与上面 401 自愈那组同一条理由）
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((req) {
        final res = req.response..headers.contentType = ContentType.json;
        if (req.headers.value(HttpHeaders.authorizationHeader) == 'Bearer good-token') {
          res.write(jsonEncode({'lastSeq': 1, 'state': 'idle', 'tiles': {'needsReview': 0}}));
        } else {
          res.statusCode = 401;
          res.write(jsonEncode({
            'error': {'code': 'unauthorized', 'message': '缺少或无效的会话凭据。请重新登录。'},
            'instance': instance,
          }));
        }
        unawaited(res.close());
      });

      final store = SessionStore()..write(instance, 'good-token');
      final api = IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}');
      final state = AppState(api: api, sessions: store);
      addTearDown(state.dispose);

      await state.bootstrap();
      expect(state.ready, isTrue, reason: '服务端在这儿，本该进门');
      await _until(() => state.online);

      // 服务端被停掉（重启中）：这一次心跳拿到连接被拒
      await server.close(force: true);
      await state.pollOnce();
      expect(state.online, isFalse, reason: '服务端没了，壳里该显示断线');
      expect(state.stateText, '连接中断', reason: '壳里的口径不变：连接中断');
      expect(state.ready, isTrue, reason: '断线不该把人踢回门前（那是"重启中"，不是"进不去"）');
    });
  });
}

// ──────────────────────────────── 脚手架 ────────────────────────────────

/// 轮询等一个条件成立（真异步）。
///
/// 门前的自动重连是**真定时器**（0.3~1 秒），所以门那几条用例只能用真时间等：
/// 这不是"随便睡一会儿"，而是把"没人按键的时候它自己会再试"这件事等出来。
/// 等不到就 fail——报的是条件，而不是一句"超时了"。
Future<void> _until(bool Function() done, {int tries = 60}) async {
  for (var i = 0; i < tries; i++) {
    if (done()) return;
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  fail('等待条件未成立（等了 ${tries * 50} 毫秒）');
}

/// 与 `IrmiaApp` 里那个三元完全同构：`ready` 决定画壳还是画门。
/// 用替身而不是整个 `IrmiaApp`（后者会真去连 127.0.0.1:7788 并装托盘）——
/// 被测的东西是"门与壳的切换"，不是外壳插件。
Widget _harness(AppState state) => MaterialApp(
      theme: IrmiaTheme.light(),
      home: ListenableBuilder(
        listenable: state,
        builder: (context, _) => state.ready ? HomeShell(state: state) : AuthGate(state: state),
      ),
    );

Future<void> _pumpGate(WidgetTester tester, AppState state) async {
  tester.view.physicalSize = const Size(1350, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(_harness(state));
  await tester.pump(const Duration(milliseconds: 50));
}

/// API 替身：只实现"门"用得到的那两条（`get` 与 `postAuth`），
/// 其余端点回一份最小 JSON，好让主界面渲染得下去。
class _FakeApi extends IrmiaApi {
  _FakeApi() : super(baseUrl: 'http://127.0.0.1:7788');

  /// 事件流（`GET /api/events/stream`）：接上就推一条**与 turn 无关**的帧，然后一直挂着。
  ///
  /// 为什么要推一条而不是给空流：这条链路的"活没活过"是界面那一侧的一个真读数
  /// （`_eventsLive`），而它决定心跳走快档还是宽限档——空流既不结束也不来事件的话，
  /// 界面只会当你"还没接上"，读数就不是真机上那个节奏了。
  /// 挑 `session/start`（框架自己的簿记事件）：它不是 turn 信号，不会另外触发一次重读，
  /// 于是这一条用例量到的仍旧是**心跳**的节拍，不是事件驱动的重读。
  ///
  /// 为什么也不给 `Stream.empty()`：它会立刻 `onDone`，而界面把"流结束了"当成链路断了
  /// ⇒ 挂一条 3 秒的重连定时器 ⇒ 假时钟下的心跳读数里混进了那些重连（实测 30 秒里
  /// 从 3 拍变 7 拍）。真机上这条流本来也不该自己结束（SSE 断了是异常，不是正常收尾）。
  @override
  Stream<Map<String, dynamic>> events({int? lastEventId}) {
    final controller = StreamController<Map<String, dynamic>>();
    controller.onListen = () {
      scheduleMicrotask(() {
        if (!controller.isClosed) {
          controller.add(<String, dynamic>{'type': 'session/start', 'seq': 0, 'data': const {}});
        }
      });
    };
    return controller.stream;
  }

  /// 路径 → 要抛的认证错误（模拟 401）
  final Map<String, ApiAuthError> getErrors = {};
  /// 路径 → 认证端点的成功响应
  final Map<String, Map<String, dynamic>> authResults = {};
  /// 路径 → 认证端点的失败（401 / 400 都走这里）
  final Map<String, ApiAuthError> authErrors = {};
  final List<String> authCalls = [];

  /// `GET /api/auth/state` 的回答：true/false = 服务端如实说；null = 老服务端
  /// （没有这条端点，界面该退回 401 的 code 分流）。默认 null，好让老口径的用例保持原样。
  bool? authInitialized;

  /// `/api/auth/state` 被问过几次（"先问事实再画门"这条链路的读数）
  int authStateCalls = 0;

  /// true = 每次请求都抛一个**连接类**异常（形状与"主进程没在跑"时 dart:io 抛的一样）。
  ///
  /// 为什么需要它：门前那套自动重连要"服务端不在"才能动起来，而真实端口被拒的异常
  /// 每个平台的字面量都不同——测"门卡怎么画"这件事不该依赖那种字面量。
  /// 注意 `_onConnectFailure` 认的是**类型**（非 [ApiError] 即连接类），所以这里只挑类型。
  bool down = false;

  /// true = 只有心跳（`/api/stats/dashboard`）失败。用来单独测"进了壳之后断线"那一路：
  /// 它是 [pollOnce] 的 catch 分支，而"换心跳节奏"就发生在那里。
  bool failDashboard = false;

  /// `/api/stats/dashboard` 被调用了几次（数心跳节奏用）
  int dashboardCalls = 0;

  @override
  Future<dynamic> get(String path, {Duration? timeout}) async {
    if (path == '/api/auth/state') {
      authStateCalls += 1;
      if (down) {
        throw const SocketException('由于目标计算机积极拒绝，无法连接。');
      }
      final failure = getErrors[path];
      if (failure != null) throw failure; // 模拟"老服务端：这条路径也在认证闸后面"
      final known = authInitialized;
      // 没有 initialized 字段 = 问不出来（与"老服务端"同一条路）
      if (known == null) return <String, dynamic>{};
      return <String, dynamic>{'initialized': known};
    }
    if (path == '/api/stats/dashboard') {
      dashboardCalls += 1;
      if (down || failDashboard) {
        throw const SocketException('由于目标计算机积极拒绝，无法连接。');
      }
    }
    if (down) {
      throw const SocketException('由于目标计算机积极拒绝，无法连接。');
    }
    if (path.startsWith('/api/persona/file')) return {'content': ''};
    final error = getErrors[path];
    if (error != null) {
      if (error.instance != null) instance = error.instance;
      throw error;
    }
    return <String, dynamic>{
      'lastSeq': 0,
      'pending': <dynamic>[],
      'state': 'idle',
      'stateText': '就绪',
      'tiles': {'needsReview': 0},
      'files': <dynamic>[],
      'relationships': <dynamic>[],
      'proposals': <dynamic>[],
      'items': <dynamic>[],
      'events': <dynamic>[],
    };
  }

  @override
  Future<dynamic> post(String path, Map<String, dynamic> body, {String? confirm, Duration? timeout}) async {
    return <String, dynamic>{'ok': true};
  }

  @override
  Future<dynamic> postAuth(String path, Map<String, dynamic> body) async {
    authCalls.add(path);
    final error = authErrors[path];
    if (error != null) throw error;
    return authResults[path] ?? <String, dynamic>{'ok': true};
  }
}
