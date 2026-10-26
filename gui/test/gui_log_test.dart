import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/gui_log.dart';

/// **卡死时能说清"卡在哪"**那一层的用例（2026-10-23「GUI 用久了会卡死」）。
///
/// 现场的缺口是"没有任何界面日志"：`%APPDATA%\Irmia` 空、`%LOCALAPPDATA%\Irmia` 只有
/// setup.log / ui-selftest.log，于是"卡在哪一条请求、卡在哪一页"只能靠猜。
/// 这一份钉三件事：
///   ① 打不开/没打开时**一个字都不写**（写日志不是致命错误，界面不陪葬）；
///   ② 打开了就写得出、带时间戳、到上限会滚（磁盘上最多两份）；
///   ③ 真有一条请求挂住时，日志里会出现那行 `[wait] … oldest="…" … page=…`——
///      它是下一次排障的第一句话。
void main() {
  late Directory dir;
  late String path;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('irmia-gui-log-');
    path = '${dir.path}${Platform.pathSeparator}gui.log';
  });

  tearDown(() {
    // 全局那一份是本文件的用例打开的：每条用例收尾都关上，别让下一个文件继承
    guiLog.detach();
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录删不掉不影响断言
    }
  });

  test('① 没 attach ⇒ write 是空操作（用例跑 800 多遍，不许往用户目录里写字）', () {
    final log = GuiLog();
    log.write('[life] should not land anywhere');
    expect(log.attached, isFalse);
    expect(log.path, isNull);
    expect(File(path).existsSync(), isFalse);
  });

  test('① 打不开目录 ⇒ 静默放弃，write 不抛（磁盘满/被锁时的活路）', () {
    // 让父目录是个**文件**：createSync(recursive: true) 必失败
    final blocker = File('${dir.path}${Platform.pathSeparator}blocker')
      ..writeAsStringSync('x');
    final log = GuiLog();
    log.attach(path: '${blocker.path}${Platform.pathSeparator}gui.log');
    expect(log.attached, isFalse, reason: '打不开就关掉日志，绝不许让界面跟着崩');
    log.write('[life] dropped');
    expect(blocker.existsSync(), isTrue);
    expect(blocker.lengthSync(), 1, reason: '一个字节都没写进去');
  });

  test('② attach ⇒ 建目录、写会话头；每行带可排序的时间戳', () {
    final log = GuiLog();
    log.attach(path: path);
    expect(log.attached, isTrue);
    expect(log.path, path);
    log.write('[net] slow GET /api/stats/dashboard 2.0s');
    log.detach();

    final lines = File(path).readAsLinesSync();
    expect(lines.length, greaterThanOrEqualTo(3)); // 会话头 + 那一行 + 收尾
    expect(lines.first, contains('[life] gui start'));
    // `2026-10-23T18:47:12.431 ` —— 能按字符串排序、能看出秒级间隔
    final stamp = RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} ');
    for (final line in lines) {
      expect(stamp.hasMatch(line), isTrue, reason: '每行都要有时间戳：$line');
    }
    expect(lines.any((l) => l.contains('[net] slow GET /api/stats/dashboard 2.0s')), isTrue);
    expect(lines.last, contains('[life] gui stop'));
  });

  test('② 到上限就滚：当前那份改名 .1，磁盘上最多两份', () {
    final log = GuiLog(maxBytes: 400);
    log.attach(path: path);
    for (var i = 0; i < 40; i += 1) {
      log.write('[net] FAIL GET /api/x#$i after=1.0s error=ApiTimeout');
    }
    log.write('[life] after rotate');
    log.detach();

    final rotated = File('$path.1');
    expect(rotated.existsSync(), isTrue, reason: '超了上限就该滚一份，别让日志无限长');
    expect(File(path).lengthSync(), lessThan(400), reason: '滚完那份从头开始写');
    // 滚过之后新写的那一行必须落在**新的**那份里（不是又追回 .1）
    expect(File(path).readAsLinesSync().any((l) => l.contains('[life] after rotate')), isTrue);
  });

  test('② 滚第二次时只覆盖 .1（不产生 .2/.3 那种无底洞）', () {
    final log = GuiLog(maxBytes: 300);
    log.attach(path: path);
    for (var i = 0; i < 60; i += 1) {
      log.write('[net] FAIL GET /api/y#$i after=1.0s');
    }
    log.write('[life] end');
    log.detach();
    expect(File('$path.1').existsSync(), isTrue);
    expect(File('$path.2').existsSync(), isFalse);
  });

  test('③ 有请求挂住时，日志里出现那行 `[wait]`（下一次排障的第一句话）', () async {
    // 全局那一份：`IrmiaApi` 读的就是它
    guiLog.attach(path: path);
    expect(guiLog.attached, isTrue);

    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) {
      // 收了就不回：正是要抓的那种形状
    });

    final api = IrmiaApi(
      baseUrl: 'http://127.0.0.1:${server.port}',
      requestTimeout: const Duration(seconds: 2),
      // 10 秒那档在真机上合适；用例里缩到 100ms，好让"它会写"这件事本身可验收
      waitDumpInterval: const Duration(milliseconds: 100),
    )..pageProbe = () => 'overview';

    final pending = api.get('/api/stats/dashboard');
    await Future<void>.delayed(const Duration(milliseconds: 450));
    await expectLater(pending, throwsA(isA<ApiTimeout>()));

    final lines = File(path).readAsLinesSync();
    final wait = lines.where((l) => l.contains('[wait] inflight=')).toList();
    expect(wait, isNotEmpty, reason: '有请求在飞就必须留下在飞清单，否则卡死时还是只能猜');
    expect(wait.first, contains('oldest="GET /api/stats/dashboard"'));
    expect(wait.first, contains('page=overview'), reason: '卡在哪一页也要留下');
    // 超时那一刻也要有一行（时长、哪一条）
    expect(lines.any((l) => l.contains('[net] TIMEOUT GET /api/stats/dashboard')), isTrue);
  });

  test('③ 请求正常结束 ⇒ 不写慢/失败行，也不留在飞清单', () async {
    guiLog.attach(path: path);
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      req.response.write('{"ok":true}');
      await req.response.close();
    });
    final api = IrmiaApi(
      baseUrl: 'http://127.0.0.1:${server.port}',
      waitDumpInterval: const Duration(milliseconds: 50),
    );
    await api.get('/api/projection');
    await Future<void>.delayed(const Duration(milliseconds: 120));
    final text = File(path).readAsStringSync();
    expect(text.contains('[net] FAIL'), isFalse);
    expect(text.contains('[net] TIMEOUT'), isFalse);
    expect(text.contains('[wait]'), isFalse, reason: '没有在飞的请求就不该有在飞清单');
  });

  test('时间的统一写法：秒表那一位小数只有一处', () {
    expect(secsOf(const Duration(milliseconds: 1234)), '1.2s');
    expect(secsOf(Duration.zero), '0.0s');
    expect(secsOf(const Duration(seconds: 15)), '15.0s');
  });
}
