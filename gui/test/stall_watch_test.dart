/// **主 isolate 卡顿看门狗**那一层的用例（`gui/lib/stall_watch.dart`）。
///
/// 与 `gui_log_test.dart` 的分工：那边验"网络请求/在飞清单写不写"，这边验
/// "**主 isolate 停了**，另一个 isolate 还写不写得出、写得对不对"。
///
/// 这里的用例**真的 spawn 一个 isolate**（不是只测纯函数）：整件事的价值全在
/// "主 isolate 停住时那一行还落得下去"，而这一点只有真跑起来才证明得了——
/// 纯函数测一万遍也证明不了"卡住时它还在跑"。
///
/// 验收清单逐条对应：
///   ① 心跳正常 3 秒内**不**产生 `[stall]` 行；
///   ② 人为阻塞主 isolate（`sleep` 2.5s）⇒ 日志出现 `[stall] gap≈2.5s`，
///      并且**读文件**能读到它（是看门狗写进了文件，不是主 isolate 事后补的）；
///   ③ 恢复后补一行 `[stall] recovered after …`；
///   ④ `[stall]` 行里带 page 与 last（`[stall]` 那行是拼给人读的现场）；
/// 另外还钉住：卡顿持续期间按 `repeatEvery` 补行、快照的拼法/压平/截断、
/// `[input]` 与 `[win]` 的格式（它们是 `[stall]` 那行的原料）。
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/gui_log.dart';
import 'package:irmia_gui/stall_watch.dart';
import 'package:irmia_gui/win_trace.dart';

/// 时间戳 + 级别前缀（每行都得长这样，否则按字符串排序会乱）
final RegExp _stampedStall = RegExp(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} \[stall\] ');

/// 从一行里取出 `key=<秒>s` 那个数（`gap=3.4s`）
double _seconds(String line, String key) {
  final match = RegExp('$key=([0-9.]+)s').firstMatch(line);
  expect(match, isNotNull, reason: '这一行里没有 $key=<秒>s：$line');
  return double.parse(match!.group(1)!);
}

/// 从 `[stall] recovered after 12.7s` 里取出那个数（它没有 `=`）
double _afterSeconds(String line) {
  final match = RegExp(r'recovered after ([0-9.]+)s').firstMatch(line);
  expect(match, isNotNull, reason: '这一行里没有 recovered after <秒>s：$line');
  return double.parse(match!.group(1)!);
}

void main() {
  late Directory dir;
  late String path;

  setUp(() {
    dir = Directory.systemTemp.createTempSync('irmia-stall-');
    path = '${dir.path}${Platform.pathSeparator}gui.log';
    // 单例里的残留状态归零：日志这时还没 attach，所以这两下**不写盘**，
    // 只把内存里那一态拉回初值（见 win_trace.dart 的"值没变就不写"）
    WinTrace.instance.setFocused(false);
    WinTrace.instance.setVisibility(WinVisibility.visible);
  });

  tearDown(() {
    // 每条用例收尾都停掉看门狗：留着的话它会写到下一条用例的文件里
    StallWatch.instance.stop();
    guiLog.detach();
    guiPageProbe = null;
    lastTraceText = '-';
    try {
      dir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录删不掉不影响断言
    }
  });

  // ───────────────────────── 心跳快照（`[stall]` 那行的原料） ─────────────────────────

  group('快照拼法', () {
    test('没有在飞请求：写 inflight=0，不带 oldest（排除网络就是一条追查路线）', () {
      expect(
        stallSnapshot(page: 'chat', last: '切页 扩展', inflight: 0),
        'page=chat last="切页 扩展" inflight=0',
      );
    });

    test('有在飞请求：带上最老那一条与已等时长（`GET /api/… 3.2s`）', () {
      expect(
        stallSnapshot(
          page: 'overview',
          last: '发送消息',
          inflight: 2,
          oldest: 'GET /api/stats/dashboard',
          oldestAge: const Duration(milliseconds: 3200),
        ),
        'page=overview last="发送消息" inflight=2 '
        'oldest="GET /api/stats/dashboard" 3.2s',
      );
    });

    test('引号与换行压平：一行一条，字段还能按 " 切开', () {
      final snap = stallSnapshot(page: 'chat', last: 'a"b\nc', inflight: 0);
      expect(snap.contains('\n'), isFalse);
      expect(snap, 'page=chat last="a\'b c" inflight=0');
    });

    test('过长截断按 rune 走（不把 emoji 劈成半个代理对）', () {
      final snap = stallSnapshot(page: 'chat', last: '😀' * 200, inflight: 0);
      final value = RegExp(r'last="(.*)" inflight=').firstMatch(snap)!.group(1)!;
      expect(value.runes.length, 81, reason: '80 个字 + 那个省略号');
      expect(value.endsWith('…'), isTrue);
      expect(
        value.runes.every((rune) => rune < 0xD800 || rune > 0xDFFF),
        isTrue,
        reason: '按 code unit 截断会留半个代理对，写盘时就是非法 UTF-8',
      );
      expect(() => utf8.encode(snap), returnsNormally);
    });
  });

  // ───────────────────────── `[input]` / `[page]` ─────────────────────────

  test('`[input]` 一行一个动作：tap 是界面原话、page 是当前页；`last` 跟着换成切页那句', () {
    guiLog.attach(path: path);
    guiPageProbe = () => 'chat';

    traceInput('发送消息');
    tracePage('extensions', label: '扩展');

    final lines = File(path).readAsLinesSync();
    expect(
      lines.any((l) => l.contains('[input] tap=发送消息 page=chat')),
      isTrue,
      reason: '卡死时"最后按的是哪个按钮、在哪一页"只能靠这一行',
    );
    expect(lines.any((l) => l.contains('[page] extensions')), isTrue);
    expect(lastTraceText, '切页 扩展', reason: '`[stall]` 那行的 last= 读的就是它');
  });

  // ───────────────────── 接线：真 AppState 起没起看门狗 ─────────────────────

  test('接线：日志开着时 AppState 自己把看门狗起起来；setPage 记 `[page]` 且 `last` 跟着换', () async {
    guiLog.attach(path: path);
    final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:1'));

    // 构造函数里是 `unawaited(start(...))`（握手是异步的）：等一小下
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(
      StallWatch.instance.running,
      isTrue,
      reason: '真机上就是这条接线：main.dart 先 attach，AppState 一造出来就该有看门狗在跑',
    );

    state.setPage('chat');
    expect(
      File(path).readAsLinesSync().any((l) => l.contains('[page] chat')),
      isTrue,
      reason: '切页那一行照旧要有（它是既有的判据），只是改由 tracePage 写',
    );
    expect(lastTraceText, '切页 聊天', reason: '页名取 PageEntry.label，`[stall]` 那行引用它');

    state.dispose();
    expect(StallWatch.instance.running, isFalse, reason: '退场之后不许还留一条心跳在跑');
  });

  // ───────────────────────── `[win]` 窗口状态 ─────────────────────────
  test('`[win]` 三行：focus / visibility / restore，且值没变就不写', () {
    guiLog.attach(path: path);

    WinTrace.instance.setFocused(true);
    WinTrace.instance.setFocused(true); // 连着两次：值没变，不该再来一行
    WinTrace.instance.setVisibility(WinVisibility.minimized);
    WinTrace.instance.noteHidden();
    WinTrace.instance.noteRestored();

    final lines = File(path).readAsLinesSync();
    expect(lines.where((l) => l.contains('[win] focus=true')).length, 1);
    expect(lines.any((l) => l.contains('[win] visibility=minimized')), isTrue);
    expect(lines.any((l) => l.contains('[win] visibility=hidden')), isTrue);
    expect(lines.any((l) => l.contains('[win] restore')), isTrue, reason: '从托盘回来是单独一件事');
    expect(lines.any((l) => l.contains('[win] visibility=visible')), isTrue);
    expect(WinTrace.instance.visibility, WinVisibility.visible);
  });

  // ───────────────────────── ① 正常心跳：一条 [stall] 都不该有 ─────────────────────────

  test('① 心跳正常 3 秒内不产生 [stall] 行', () async {
    await StallWatch.instance.start(
      logPath: path,
      snapshot: () => stallSnapshot(page: 'chat', last: '切页 扩展', inflight: 0),
    );
    expect(StallWatch.instance.running, isTrue);

    await Future<void>.delayed(const Duration(milliseconds: 3200));

    final text = File(path).existsSync() ? File(path).readAsStringSync() : '';
    expect(
      text.contains('[stall]'),
      isFalse,
      reason: '心跳一拍没落（每 500ms 一拍），就不该有任何 [stall] —— 否则日志会被误报灌满',
    );
  });

  // ────────────────── ②③④ 真把主 isolate 停住：看门狗自己写 ──────────────────

  test('② 主 isolate 停 2.5s ⇒ 文件里出现 [stall] gap≈2.5s（③ 恢复补一行 · ④ 带 page 与 last）', () async {
    await StallWatch.instance.start(
      logPath: path,
      snapshot: () => stallSnapshot(
        page: 'chat',
        last: '切页 扩展',
        inflight: 1,
        oldest: 'GET /api/stats/dashboard',
        oldestAge: const Duration(milliseconds: 3200),
      ),
    );

    // 先让心跳跑起来：看门狗要有"上一拍"才谈得上"多久没拍"
    await Future<void>.delayed(const Duration(milliseconds: 700));

    // **真的把主 isolate 停住**：`sleep` 是同步阻塞，这期间主 isolate 的 Timer
    // 一拍都不会跳（心跳就断在这里）。看门狗在另一个线程上照常跳、照常写盘
    // ——这正是"日志必须由看门狗自己写"那一条的实测。
    sleep(const Duration(milliseconds: 2500));

    expect(
      File(path).existsSync(),
      isTrue,
      reason: '睡醒之后文件就该在：那一行是**卡的时候**写下的，不是事后补的',
    );
    final lines = File(path).readAsLinesSync();
    final stalls = lines.where((l) => l.contains('[stall] gap=')).toList();
    expect(stalls, isNotEmpty, reason: '主 isolate 停了 2.5 秒，看门狗必须自己把它写进文件');
    final first = stalls.first;

    // ④ 现场三格：在哪一页、最后一条动作、有没有请求在飞
    expect(first, contains('page=chat'));
    expect(first, contains('last="切页 扩展"'));
    expect(first, contains('inflight=1'));
    expect(first, contains('oldest="GET /api/stats/dashboard" 3.2s'));
    expect(_stampedStall.hasMatch(first), isTrue, reason: '行首要有可排序的时间戳：$first');

    // ② gap ≈ 真停的时长（门槛 2s + 心跳相位 0.5s + 巡检节拍 0.5s，最多再多约 1s）
    final gap = _seconds(first, 'gap');
    expect(gap, greaterThanOrEqualTo(2.0), reason: '门槛是 2 秒，早于它报就是误报');
    expect(gap, lessThan(4.5), reason: '报出来的必须≈真停的时长（2.5s），不许瞎写');

    // ③ 恢复：心跳接上之后补一行，否则分不清"还卡着"与"卡过一下"
    await Future<void>.delayed(const Duration(milliseconds: 1500));
    final recovered = File(path)
        .readAsLinesSync()
        .where((l) => l.contains('[stall] recovered after'))
        .toList();
    expect(recovered, isNotEmpty, reason: '恢复之后要补一行 recovered after');
    expect(_stampedStall.hasMatch(recovered.last), isTrue);
    final after = _afterSeconds(recovered.last);
    expect(after, greaterThanOrEqualTo(2.0), reason: '恢复那一行报的是这次实际停了多久');
    expect(after, lessThan(6.0));
  });

  test('⑤ 卡顿持续期间按 repeatEvery 补行：gap 一路长大，看得出还在卡', () async {
    await StallWatch.instance.start(
      logPath: path,
      snapshot: () => stallSnapshot(page: 'chat', last: '切页 扩展', inflight: 0),
      // 真机上是 5 秒一档；用例里压到 400ms，好让"它会补行"这件事几百毫秒可验收
      repeatEvery: const Duration(milliseconds: 400),
      checkEvery: const Duration(milliseconds: 200),
    );
    await Future<void>.delayed(const Duration(milliseconds: 400));

    sleep(const Duration(milliseconds: 3500));

    expect(File(path).existsSync(), isTrue, reason: '卡了 3.5 秒，文件里该有东西了');
    final stalls = File(path)
        .readAsLinesSync()
        .where((l) => l.contains('[stall] gap='))
        .toList();
    expect(stalls.length, greaterThanOrEqualTo(2), reason: '一直卡着就要一直报（每 repeatEvery 一行）');
    expect(
      _seconds(stalls.last, 'gap'),
      greaterThan(_seconds(stalls.first, 'gap')),
      reason: 'gap 要跟着长，否则看不出"到底还卡不卡"',
    );
  });

  // ───────────────────────── 手柄本身的两条分寸 ─────────────────────────

  test('手柄：没开就停是空操作；开两次不会起两条心跳', () async {
    StallWatch.instance.stop();
    expect(StallWatch.instance.running, isFalse);

    var beats = 0;
    await StallWatch.instance.start(
      logPath: path,
      beatEvery: const Duration(milliseconds: 60),
      snapshot: () {
        beats += 1;
        return 'page=chat last=- inflight=0';
      },
    );
    expect(StallWatch.instance.running, isTrue);

    // 第二次 start：必须什么都不做（否则两条 Timer 轮流发，日志里全是重复现场）
    await StallWatch.instance.start(
      logPath: path,
      beatEvery: const Duration(milliseconds: 60),
      snapshot: () {
        beats += 1;
        return 'page=chat last=- inflight=0';
      },
    );

    await Future<void>.delayed(const Duration(milliseconds: 420));
    // 一条 Timer 约 7 拍；若起了两条，读数会翻倍
    expect(beats, greaterThanOrEqualTo(3));
    expect(beats, lessThan(11), reason: '起两条心跳了：第二次 start 没有提前返回');
  });

  test('快照自己炸了也照发心跳（一个读数的 bug 不该把"还活着"弄丢）', () async {
    var calls = 0;
    await StallWatch.instance.start(
      logPath: path,
      beatEvery: const Duration(milliseconds: 60),
      snapshot: () {
        calls += 1;
        throw StateError('probe broke');
      },
    );
    await Future<void>.delayed(const Duration(milliseconds: 420));
    expect(calls, greaterThanOrEqualTo(3), reason: '心跳要一直在跳，哪怕快照拼不出来');
    expect(StallWatch.instance.running, isTrue);
    // 卡顿才写盘：心跳照发、没有任何 [stall] 行
    final text = File(path).existsSync() ? File(path).readAsStringSync() : '';
    expect(text.contains('[stall]'), isFalse);
  });
}
