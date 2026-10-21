import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/backend_stop.dart';

/// 「退出全部」里真正停后端那一步：**端口 → pid → 杀进程树 → 核实端口不再应答**。
///
/// 判据只有一条：**界面正在用的那个端口的监听者就是后端**（不猜 node 在哪、脚本在哪，
/// 见 `lib/backend_stop.dart` 文件头）。所以这组用例分两层：
///   · 纯函数与替身：netstat 原文怎么读、`taskkill` 收到什么、什么算成功；
///   · 一次真机集成（只在 Windows 上跑）：起一个**真的**监听者，用同一段代码把它停掉，
///     确认端口真的不应答了——不碰用户正在跑的那个后端（端口是随机挑的空闲端口）。
void main() {
  group('netstat 原文怎么读（纯函数）', () {
    // 本机 `netstat -ano -p tcp` 的真实形状（缩进、IPv6、ESTABLISHED 那些行都在）
    const sample = '活动连接\r\n'
        '\r\n'
        '  协议  本地地址          外部地址        状态           PID\r\n'
        '  TCP    127.0.0.1:7788         0.0.0.0:0              LISTENING       2168\r\n'
        '  TCP    [::1]:7788             [::]:0                 LISTENING       2168\r\n'
        '  TCP    127.0.0.1:7788         127.0.0.1:51000        ESTABLISHED     2168\r\n'
        '  TCP    127.0.0.1:7789         0.0.0.0:0              LISTENING       4242\r\n'
        '  TCP    0.0.0.0:17788          0.0.0.0:0              LISTENING       9999\r\n'
        '  UDP    0.0.0.0:7788           *:*                                    7777\r\n';

    test('只认监听那些行：ESTABLISHED / UDP / 别的端口 / 前缀相同的端口都不算', () {
      final listeners = listenersOnPort(sample, 7788);
      expect(listeners.map((line) => line.pid).toSet(), <int>{2168});
      expect(listeners.map((line) => line.address).toList(),
          <String>['127.0.0.1:7788', '[::1]:7788']);
    });

    test('17788 不会被当成 7788（: port 的冒号是判据的一部分）', () {
      expect(listenersOnPort(sample, 7788).any((line) => line.pid == 9999), isFalse);
      expect(listenersOnPort(sample, 17788).single.pid, 9999);
    });

    test('端口上没人听 ⇒ 空列表（界面据此说"本来就没在跑"）', () {
      expect(listenersOnPort(sample, 5555), isEmpty);
    });
  });

  group('停后端（命令与探活都是替身）', () {
    test('端口上没人应答 ⇒ 算成功、一个进程都不动', () async {
      final run = _Runner();
      final result = await stopBackendOnPort(
        7788,
        run: run.call,
        probe: (host, port) async => false,
      );
      expect(result.ok, isTrue);
      expect(result.pid, 0);
      expect(result.detail, contains('本来就没在跑'));
      expect(run.calls, isEmpty, reason: '没人在听就别去 taskkill');
    });

    test('找到监听者 ⇒ taskkill /PID n /T /F，端口不应答才算成功', () async {
      final run = _Runner(netstatPid: 2168);
      // 第一次问"还在吗"= 在；taskkill 之后 = 不在
      var probed = 0;
      final result = await stopBackendOnPort(
        7788,
        run: run.call,
        probe: (host, port) async => probed++ == 0,
        poll: Duration.zero,
      );
      expect(result.ok, isTrue);
      expect(result.pid, 2168);
      expect(run.calls.map((call) => call.args).toList(), <List<String>>[
        <String>['-ano', '-p', 'tcp'],
        <String>['/PID', '2168', '/T', '/F'],
      ]);
      expect(run.calls.last.exe, 'taskkill');
      expect(result.detail, contains('不再应答'));
    });

    test('taskkill 返回 0 但端口还在应答 ⇒ 失败（退出码不是判据）', () async {
      final run = _Runner(netstatPid: 2168);
      final result = await stopBackendOnPort(
        7788,
        run: run.call,
        probe: (host, port) async => true,
        poll: Duration.zero,
        confirmWindow: Duration.zero,
      );
      expect(result.ok, isFalse);
      expect(result.detail, contains('仍在应答'));
    });

    test('端口上的 pid 就是这个界面进程 ⇒ 不碰它', () async {
      final run = _Runner(netstatPid: 31337);
      final result = await stopBackendOnPort(
        7788,
        run: run.call,
        probe: (host, port) async => true,
        ownPid: 31337,
      );
      expect(result.ok, isFalse);
      expect(result.pid, 31337);
      expect(run.calls.where((call) => call.exe == 'taskkill'), isEmpty,
          reason: '杀掉自己等于让"退出全部"变成"界面莫名其妙消失"');
    });

    test('netstat 里找不到监听者（有人在应答但不是 TCP 监听）⇒ 什么都不动', () async {
      final run = _Runner(netstatPid: 0);
      final result = await stopBackendOnPort(
        7788,
        run: run.call,
        probe: (host, port) async => true,
      );
      expect(result.ok, isFalse);
      expect(result.detail, contains('找不到监听它的进程'));
      expect(run.calls.where((call) => call.exe == 'taskkill'), isEmpty);
    });
  });

  test('真机集成：随机端口上起一个真监听者，用同一段代码把它停掉', () async {
    // 起一个 PowerShell 的 TcpListener 当"后端"（它监听、然后什么都不做）
    final port = await _freePort();
    final listener = await Process.start('powershell.exe', <String>[
      '-NoProfile',
      '-Command',
      r'$l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, ' '$port' r'); '
          r'$l.Start(); Start-Sleep -Seconds 120',
    ]);
    addTearDown(() {
      try {
        listener.kill();
      } catch (_) {
        // 已经被 stopBackendOnPort 杀掉了
      }
    });

    // 等它真的听起来（最多 15 秒）
    var up = false;
    for (var i = 0; i < 60 && !up; i += 1) {
      up = await tcpAlive('127.0.0.1', port);
      if (!up) await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    expect(up, isTrue, reason: '替身监听者没起来，后面的断言就没有意义');

    final result = await stopBackendOnPort(
      port,
      probe: tcpAlive,
      confirmWindow: const Duration(seconds: 10),
    );
    expect(result.ok, isTrue, reason: '结果：${result.detail}');
    expect(result.pid, isPositive);
    expect(result.pid, listener.pid,
        reason: '被停掉的那个 pid 就是我们起的监听者（powershell 自己就是监听者，不是它的壳）');
    expect(await tcpAlive('127.0.0.1', port), isFalse, reason: '端口必须真的不应答了');
  }, skip: !Platform.isWindows);

  test('端口上没人在听时，真机探活也如实说"没在跑"', () async {
    final port = await _freePort();
    final result = await stopBackendOnPort(port, probe: tcpAlive);
    expect(result.ok, isTrue);
    expect(result.pid, 0);
  }, skip: !Platform.isWindows);
}

/// 命令替身：记下每一次调用，并按"netstat 里那个 pid"回答
class _Runner {
  _Runner({this.netstatPid = 2168});

  final int netstatPid;
  final List<({String exe, List<String> args})> calls = [];

  Future<ProcessResult> call(String exe, List<String> args) async {
    calls.add((exe: exe, args: args));
    if (exe == 'netstat') {
      final stdout = netstatPid == 0
          ? ''
          : '  TCP    127.0.0.1:7788         0.0.0.0:0              LISTENING       $netstatPid\r\n';
      return ProcessResult(1, 0, stdout, '');
    }
    return ProcessResult(2, 0, '', '');
  }
}

/// 找一个当前没人用的端口（bind 完就放开，紧接着被监听者占用）
Future<int> _freePort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}
