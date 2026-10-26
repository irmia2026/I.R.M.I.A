/// **主 isolate 卡顿看门狗**（`gui.log` 里那些 `[stall] …` 行）。
///
/// ## 它要回答的问题（真实现场）
///
/// 用户报「GUI 挂久了会卡住：窗口在、画面是老的、点不动」。现场读数却是：
/// 进程 `Responding=True`、CPU 空闲（5 秒 0.09s）、线程全 Wait、内存稳定——
/// **不是算得慢、不是泄漏，形状是"Dart 主 isolate 被阻塞"**（不再重绘、不再处理输入）。
/// 而 `gui.log` 里只有网络与切页两类行，**没有任何一条能证明"主线程停了多久、停在哪"**。
///
/// 于是有了这个文件。它补的正是那一格：主 isolate 每隔 [kStallBeatEvery] 发一拍心跳，
/// 超过 [kStallGapLimit] 没动静就记一行——**而且这一行是另一个 isolate 写的**。
///
/// ## 为什么必须是另一个 isolate（这是整件事的关键）
///
/// 主 isolate 卡住时，它自己的 `Timer` 回调、`await` 续体、`Future` 完成全都不跑了一
/// **"卡了多久"这件事，卡住的线程自己说不出来**。如果日志由主 isolate 写，那行字只会在
/// 恢复之后才落盘，时间戳就是错的（或者根本等不到那次恢复）。
///
/// 所以：`Isolate.spawn` 起的看门狗**有自己的事件循环、自己的 OS 线程、自己的堆**
/// （[Isolate.spawn] 之间不共享任何可变状态，消息是拷贝过去的）。主 isolate 正跑一个
/// 死循环/timeout 里出不来时，看门狗那一侧的 `Timer.periodic` 照常跳、`writeAsStringSync`
/// 照常落盘。这就是"它不会被主 isolate 卡住"的全部原因，没有别的魔法。
///
/// ## 通信（两个方向各一个 SendPort）
///
/// ```
/// 主 isolate                    看门狗 isolate（debugName: irmia-stall-watch）
///   Isolate.spawn ────────────▶ 收到 config（日志路径 + 门槛 + 节拍）
///   ReceivePort ◀────────────── 回一个自己的 SendPort（握手，只回一次）
///   Timer.periodic(500ms) ────▶ {'cmd':'beat', 'snap': 'page=chat last="…" inflight=1 …'}
///                               · 只存最后一拍（旧的不排队、不累积）
///                               · 距上一拍 > 门槛 ⇒ 写 [stall] gap=…
///                               · 卡顿期间每 5s 再写一行（不刷屏，又看得出持续多久）
///                               · 一拍回来了 ⇒ 写 [stall] recovered after …
///                               · **一拍晚到**（停在 2.0~2.5s 之间就回来了，巡检那一拍
///                                 恰好没撞上）⇒ 补一笔 [stall] gap=… + recovered，
///                                 否则这种短卡顿会一条都不留
///   stop() ───────────────────▶ {'cmd':'bye'} + Isolate.kill(beforeNextEvent)
/// ```
///
/// 两个数各自的含义（读日志时最容易混的一对）：
///
///   · `gap=` 是**写这一行的那一刻**已经停了多久——它只能在"还卡着"的时候写，
///     所以第一条通常是 2.0~2.5s（门槛 + 一个巡检节拍的相位），一直卡就一直长大；
///   · `recovered after` 是**这一停总共多久**（上一拍 → 恢复那一拍），才是"停了多久"的答案。
///
/// 心跳里带的是**已经拼好的一行快照**（[stallSnapshot]）：页面、最后一条动作、
/// 在飞请求数与最老那一条。看门狗侧不做业务判断——它只认识"多久没收到拍"，
/// 因为它的代码越少，越不容易跟着一起坏。
///
/// ## 三条分寸（与 `gui_log.dart` 同一套）
///
///   · **起不来就算了**：不允许 spawn / 握手超时 / 写不动盘，一律静默关掉自己，
///     绝不让界面跟着出事（看门狗是锦上添花，不是功能）；
///   · **日志由看门狗自己写**（同步 append、`flush: true`）：不经主 isolate，也不复用
///     `GuiLog` 那个实例——它的字节计数住在主 isolate 的堆里，看门狗够不着；
///     代价写在这里：看门狗写进去的字节不计入 `GuiLog` 的滚动账本（每行几十字节、
///     一天也只有几条 `[stall]`，对 2MB 的滚动上限没有实际影响）；
///   · **只在日志开着时才起**（`AppState` 构造时判 `guiLog.attached`）：`flutter test`
///     会造几百个 `AppState`，一条 isolate 都不该为它们起。
///
/// ## 行格式（`[stall]` 那几行）
///
/// ```
/// 2026-10-25T03:12:44.101 [stall] gap=3.4s page=chat last="切页 扩展" inflight=1
/// 2026-10-25T03:12:49.103 [stall] gap=8.4s page=chat last="切页 扩展" inflight=1
/// 2026-10-25T03:12:56.802 [stall] recovered after 12.7s
/// ```
///
/// 键名全 ASCII（便于 grep）；`last=` 的值是给人看的那句话（与 `[input]`/`[page]`
/// 行里同一份文案），凌晨三点读日志的人靠它认出"最后动的是哪个按钮"。
///
/// ## 它证明不了什么（写清楚，免得下一次误读）
///
/// `[stall]` **一行都没有**而界面确实死着，那说明卡的**不是 Dart 主 isolate**：
/// 整台 VM 停了（长 GC、调试器暂停）、或者窗口线程/图形栈堵住而 Dart 侧照样在跑。
/// 这一条区分本身就是排障的下一步，所以它比"再记多一点"值钱。
///
/// 反过来，`gap` 大到几分钟甚至几小时（`gap=3600.0s`）时先别当卡死念：那多半是
/// **机器睡了/休眠了**——两个 isolate 一起冻住，醒来之后钟走了、拍没走。
/// 分辨办法就在同一份日志里：睡眠期间不会有任何别的行，醒来后一切照常。
library;

import 'dart:async';
import 'dart:io';
import 'dart:isolate';

import 'gui_log.dart';

/// 心跳间隔：主 isolate 每 500ms 往看门狗发一拍。
const Duration kStallBeatEvery = Duration(milliseconds: 500);

/// 判"停了"的门槛：两拍之间超过 2000ms 没动静。
///
/// 为什么是 2 秒：用户报的"点不动"是**感知级**的（一两秒就看得出来）；而 2 秒也足够
/// 宽，正常的一帧重活、一次同步落盘、一次 `flutter_test` 的 pump 都不会误报。
const Duration kStallGapLimit = Duration(milliseconds: 2000);

/// 卡顿**持续期间**补记一行的间隔：不刷屏（一整晚挂死也只写几 KB），
/// 又看得出"这一停到底多久了"（`gap=` 会一路长大）。
const Duration kStallRepeatEvery = Duration(seconds: 5);

/// 看门狗自己的巡检节拍。比 [kStallGapLimit] 小一档 ⇒ 判定延迟最多一个它。
const Duration kStallCheckEvery = Duration(milliseconds: 500);

// ─────────────────────────── 主 isolate 这一侧 ───────────────────────────

/// 主 isolate 最近一条 `[page]` / `[input]` 的**文案**（心跳快照里的 `last=` 读它）。
///
/// 只在主 isolate 里读写；看门狗拿到的是**拼好的那一行**（拷贝过去的字符串），
/// 不需要（也不该）知道界面发生了什么。
String lastTraceText = '-';

/// 当前页 id 的读数口。`AppState` 在构造时接线（`() => pageId`）——
/// 这一层不该认识界面，与 `IrmiaApi.pageProbe` 是同一条分工。
String Function()? guiPageProbe;

/// 记一条**切页**：`[page] <id>`（这一行本来就有，这里顺带把 `last` 更新掉）。
///
/// [label] 是这一页在界面上叫什么（`PageEntry.label`）——写进 `last=` 给人看的是它，
/// id 留在 `[page]` 那一行里给 grep 用。
void tracePage(String id, {String? label}) {
  final name = (label == null || label.trim().isEmpty) ? id : label.trim();
  lastTraceText = '切页 $name';
  guiLog.write('[page] $id');
}

/// 记一条**被人按下去、并且真的处理了**的动作：`[input] tap=<名> page=<当前页>`。
///
/// 只记结果，不记 hover/滚动/每一次帧回调——那些东西一秒钟能有几十条，记进来就把
/// 出事之前那一段冲掉了。名字取**界面上那句话**（托盘项用 `AppStrings.trayShow` 这一族，
/// 重试用 `AppStrings.retry`）：于是日志与人在屏幕上看到的是同一句话。
void traceInput(String tap) {
  final name = _oneLine(tap);
  lastTraceText = name;
  guiLog.write('[input] tap=$name page=${guiPageProbe?.call() ?? '?'}');
}

/// 心跳快照的**唯一拼法**：一行、键名 ASCII、值里的引号/换行已压平。
///
/// `inflight=0` 也写上：卡死时"一个请求都没在飞"与"有请求在飞"是两条完全不同的
/// 追查路线（前者排除网络，后者九成就是那条请求）。
String stallSnapshot({
  required String page,
  required String last,
  required int inflight,
  String? oldest,
  Duration? oldestAge,
}) {
  final buffer = StringBuffer(
    'page=${_oneLine(page)} last="${_oneLine(last)}" inflight=$inflight',
  );
  final label = oldest == null ? '' : _oneLine(oldest);
  if (inflight > 0 && label.isNotEmpty) {
    buffer.write(' oldest="$label" ${secsOf(oldestAge ?? Duration.zero)}');
  }
  return buffer.toString();
}

/// 压成一行、去掉会破坏日志行结构的字符、太长就截断。
///
/// 引号换成单引号（`last="…"` 那对引号必须成对、且能靠 `"` 切字段），
/// 截断按 **rune** 走（按 code unit 切会把 emoji 劈成半个代理对，写盘时编码就出事）。
String _oneLine(String text, {int max = 80}) {
  final flat = text.replaceAll(RegExp(r'[\r\n\t]+'), ' ').replaceAll('"', "'").trim();
  if (flat.isEmpty) return '-';
  final runes = flat.runes.toList();
  if (runes.length <= max) return flat;
  return String.fromCharCodes(runes.take(max)) + _kEllipsis;
}

/// 截断处的省略号。
///
/// 抽成常量再拼（`copy_coverage_test.dart` 的豁免说明里写着这条口径）：直接写成
/// `'${…}…'` 的话，扫描器看到的字面量是整段格式化串，那一条豁免就对不上了。
const String _kEllipsis = '…';

/// 主 isolate 那一侧的看门狗手柄。
///
/// 整个进程只有一份（[instance]）：心跳是**进程级**的事实，不是某个页面的。
class StallWatch {
  StallWatch();

  /// 全局那一份（`AppState` 起它、`_finishQuit` 停它）。
  static final StallWatch instance = StallWatch();

  SendPort? _toWatch;
  ReceivePort? _fromWatch;
  Isolate? _isolate;
  Timer? _beat;

  /// 这一轮 [start] 有没有被 [stop] 打断（握手是异步的，退出可能正好压在那一段上）
  var _cancelled = false;

  /// 心跳在跳 = 看门狗活着（[start] 完成握手之后才为 true）。
  bool get running => _beat != null;

  /// 起看门狗：spawn isolate → 握手拿它的 SendPort → 开始发心跳。
  ///
  /// [logPath] 是**看门狗自己**要写的那个文件（真机上是 `gui.log` 的路径）；
  /// [snapshot] 在主 isolate 里跑（每一拍一次），抛出异常也不会让心跳停
  /// （换成一行占位快照）。
  ///
  /// 三个时长参数只为让"它会写"这件事**可验收**：用例把门槛/间隔调小就能在几百毫秒内
  /// 证明它真的写，而不必等 2 秒 + 5 秒。真机上不该动它们。
  Future<void> start({
    required String logPath,
    required String Function() snapshot,
    Duration beatEvery = kStallBeatEvery,
    Duration gapLimit = kStallGapLimit,
    Duration repeatEvery = kStallRepeatEvery,
    Duration checkEvery = kStallCheckEvery,
  }) async {
    if (running) return;
    _cancelled = false;
    final from = ReceivePort();
    Isolate? isolate;
    try {
      final ready = Completer<SendPort>();
      from.listen((message) {
        // 握手：看门狗回的第一个（也是唯一一个）东西就是它自己的 SendPort
        if (message is SendPort && !ready.isCompleted) ready.complete(message);
      });
      isolate = await Isolate.spawn<Map<String, Object?>>(
        _stallMain,
        <String, Object?>{
          _kToMain: from.sendPort,
          _kLogPath: logPath,
          _kGapMs: gapLimit.inMilliseconds,
          _kRepeatMs: repeatEvery.inMilliseconds,
          _kCheckMs: checkEvery.inMilliseconds,
        },
        // 线程/isolate 列表里认得出它（真机上排查"多出来那个线程是谁"时有用）
        debugName: 'irmia-stall-watch',
      );
      // 握手给个上限：spawn 成功但对面一句话都不回（极少见）也不能让界面一直等着
      final toWatch = await ready.future.timeout(const Duration(seconds: 3));
      if (_cancelled) {
        // 握手期间被 stop 了（退出流程压在这一小段上）：这一次起来的东西立刻收干净，
        // 别留一条没人管的定时器在退出之后还往日志里发拍
        try {
          from.close();
        } catch (_) {}
        try {
          isolate.kill(priority: Isolate.beforeNextEvent);
        } catch (_) {}
        return;
      }
      _fromWatch = from;
      _isolate = isolate;
      _toWatch = toWatch;
      _beat = Timer.periodic(beatEvery, (_) => _send(snapshot));
      // 立刻先发一拍：握手刚完成就卡住的那一小段也要有"最后一拍"可算
      _send(snapshot);
    } catch (_) {
      // 起不来就静默放弃：界面照跑，只是没有 [stall] 行（见文件头"三条分寸"）
      _beat?.cancel();
      _beat = null;
      _toWatch = null;
      _fromWatch = null;
      try {
        from.close();
      } catch (_) {}
      try {
        isolate?.kill(priority: Isolate.beforeNextEvent);
      } catch (_) {}
      _isolate = null;
    }
  }

  /// 停掉看门狗（退出界面时调）。没起过就什么都不做。
  ///
  /// 先 `bye` 再 kill：`beforeNextEvent` 保证**正在写的那一行写完**才停——
  /// 用 `immediate` 有可能把一行 `[stall]` 劈成半行。
  void stop() {
    // 握手还没完成就退出：让 [start] 那一支自己收尾（见那里的 `_cancelled`）
    _cancelled = true;
    _beat?.cancel();
    _beat = null;
    final port = _toWatch;
    _toWatch = null;
    if (port != null) {
      try {
        port.send(<String, Object?>{_kCmd: _kBye});
      } catch (_) {}
    }
    try {
      _fromWatch?.close();
    } catch (_) {}
    _fromWatch = null;
    try {
      _isolate?.kill(priority: Isolate.beforeNextEvent);
    } catch (_) {}
    _isolate = null;
  }

  /// 发一拍。快照那一段自己炸了也照发（换成占位）——
  /// 一个读数的 bug 不该把"主线程还活着"这件事本身弄丢。
  void _send(String Function() snapshot) {
    final port = _toWatch;
    if (port == null) return;
    String snap;
    try {
      snap = snapshot();
    } catch (_) {
      snap = 'page=? last=- inflight=?';
    }
    try {
      port.send(<String, Object?>{_kCmd: _kBeat, _kSnap: snap});
    } catch (_) {
      // 对面没了（被系统杀掉/已退出）：这一拍丢掉，下一拍照发
    }
  }
}

// ─────────────────────────── 看门狗 isolate 那一侧 ───────────────────────────

/// isolate 之间那几条消息的键名（只有这一处定义，两边都用它）。
const String _kToMain = 'toMain';
const String _kLogPath = 'logPath';
const String _kGapMs = 'gapMs';
const String _kRepeatMs = 'repeatMs';
const String _kCheckMs = 'checkMs';
const String _kCmd = 'cmd';
const String _kSnap = 'snap';
const String _kBeat = 'beat';
const String _kBye = 'bye';

/// 看门狗 isolate 的入口：**外面再包一层 try/catch**。
///
/// 这个函数跑在另一个线程上，任何没接住的异常都只会打印到 stderr 然后让这个 isolate
/// 死掉——但"死掉"本身对主程序是完全无害的（两个 isolate 不共享任何东西）。
/// 仍然包一层：少一条 stderr 噪音，也少一次"这是不是它把界面弄崩的"的误会。
void _stallMain(Map<String, Object?> config) {
  try {
    _runStallWatch(config);
  } catch (_) {
    // 静默关掉自己（见文件头）
  }
}

void _runStallWatch(Map<String, Object?> config) {
  final toMain = config[_kToMain];
  final logPath = config[_kLogPath];
  if (toMain is! SendPort || logPath is! String || logPath.isEmpty) return;
  final gapMs = _intOf(config[_kGapMs]) ?? kStallGapLimit.inMilliseconds;
  final repeatMs = _intOf(config[_kRepeatMs]) ?? kStallRepeatEvery.inMilliseconds;
  final checkMs = _intOf(config[_kCheckMs]) ?? kStallCheckEvery.inMilliseconds;

  final inbox = ReceivePort();
  // 单调时钟：系统对时/改时区都推不动它，"停了多久"必须用它算（不用墙钟）
  final sinceSpawn = Stopwatch()..start();
  Timer? ticker;
  var closed = false;

  /// 最近一拍的内容（**只存最后一条**：中间那些不重要，重要的是"停在哪一句话上"）
  var snap = 'page=? last=- inflight=?';
  /// 上一拍**到达**的时刻（单调，毫秒）。null = 还没收到过第一拍。
  int? lastBeatAt;
  /// 这一轮卡顿里上一次记行的时刻（决定"要不要再写一行"）
  var lastLogAt = 0;
  var stalled = false;

  void shutdown() {
    if (closed) return;
    closed = true;
    try {
      ticker?.cancel();
    } catch (_) {}
    try {
      inbox.close();
    } catch (_) {}
    try {
      sinceSpawn.stop();
    } catch (_) {}
  }

  /// **看门狗自己**往 `gui.log` 里写一行（同步 append）。
  ///
  /// 不用 `GuiLog`：那个对象（连同它的字节计数与滚动账本）住在主 isolate 的堆里，
  /// 这边看不见；而"同步、flush、写完就走"正是这里要的全部。
  /// 写不动（盘满/被锁/目录没了）就关掉自己——一个写不了日志的看门狗没有存在意义。
  void log(String body) {
    if (closed) return;
    try {
      File(logPath).writeAsStringSync(
        '${GuiLog.stamp()} $body\n',
        mode: FileMode.append,
        flush: true,
      );
    } catch (_) {
      shutdown();
    }
  }

  inbox.listen((message) {
    try {
      if (message is! Map) return;
      final cmd = message[_kCmd];
      if (cmd == _kBye) {
        shutdown();
        return;
      }
      if (cmd != _kBeat) return;
      final now = sinceSpawn.elapsedMilliseconds;
      final previous = lastBeatAt;
      // 这一拍与上一拍之间隔了多久：它就是"主 isolate 刚才停了多久"
      final gap = previous == null ? 0 : now - previous;
      lastBeatAt = now;
      if (previous != null && !stalled && gap > gapMs) {
        // 巡检那一拍恰好没撞上（短卡顿：停在 2.0~2.5s 之间就回来了）。
        // 只靠巡检会漏，而"停过一下"同样是现场——这里补一笔，顺带把这次收尾。
        // `snap` 还是**上一拍**的内容（恢复前那一拍），正是要记的那份现场。
        log('[stall] gap=${secsOf(Duration(milliseconds: gap))} $snap');
        log('[stall] recovered after ${secsOf(Duration(milliseconds: gap))}');
        stalled = false;
      } else if (stalled) {
        // 巡检已经报过这一轮：收尾那一行报的是"从上一拍到这一拍"的总时长，
        // 于是"这一次到底停了多久"有准确答案（`gap=` 那几行只是过程读数）。
        log('[stall] recovered after ${secsOf(Duration(milliseconds: gap))}');
        stalled = false;
      }
      final incoming = message[_kSnap];
      if (incoming is String && incoming.isNotEmpty) snap = incoming;
    } catch (_) {
      // 一拍处理失败不影响下一拍
    }
  });

  // 先把 SendPort 交回主 isolate（握手），再开始巡检
  toMain.send(inbox.sendPort);

  ticker = Timer.periodic(Duration(milliseconds: checkMs), (_) {
    try {
      if (closed) return;
      final last = lastBeatAt;
      // 还没收到过第一拍：启动期（isolate 刚起来、主 isolate 还在跑 runApp）不算卡
      if (last == null) return;
      final now = sinceSpawn.elapsedMilliseconds;
      final gap = now - last;
      if (gap <= gapMs) return; // 没过门槛：什么都不写
      if (!stalled) {
        stalled = true;
        lastLogAt = now;
        log('[stall] gap=${secsOf(Duration(milliseconds: gap))} $snap');
        return;
      }
      // 还在卡：隔 repeatMs 再补一行（gap 会一路长大，于是"停了多久"一眼看得出）
      if (now - lastLogAt < repeatMs) return;
      lastLogAt = now;
      log('[stall] gap=${secsOf(Duration(milliseconds: gap))} $snap');
    } catch (_) {
      // 巡检自己出错：这一拍跳过
    }
  });
}

int? _intOf(Object? value) => value is int ? value : null;
