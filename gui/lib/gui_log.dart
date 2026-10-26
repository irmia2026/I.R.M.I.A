/// 界面**自己的运行日志**（`%LOCALAPPDATA%\Irmia\gui.log`）。
///
/// ## 为什么必须有这个文件（2026-10-23 那场"用久了卡死"）
///
/// 用户报「GUI 用久了会卡死，比如现在就卡死了」。现场只拿到进程数字：
/// 99 个线程全 Wait、CPU 空闲、进程 `Responding=True`、内存不动——**形状是"某个 await
/// 永远不返回"，但界面这一侧一个字节的日志都没有**（`%APPDATA%\Irmia` 空、
/// `%LOCALAPPDATA%\Irmia` 只有 setup.log / ui-selftest.log），于是"卡在哪一个请求、
/// 卡在哪一页"全靠猜。这个文件就是为了下一次不用猜。
///
/// ## 只记"能回答卡在哪"的那几行（这是它敢常开的原因）
///
/// 心跳每 10 秒一次、思考期 250ms 一次——把每条请求都记下来，2MB 半天就转没了，
/// 转掉的那一份恰好是出事之前那一段。所以：
///   · 成功且不慢的请求**一条都不记**（常规心跳不进日志）；
///   · 失败 / 超时 / 慢于 [kGuiLogSlowMs] 的请求，各记一行（含耗时）；
///   · 有请求"在飞"时，每 [kGuiLogWaitDumpMs] 记一行**在飞清单**（`[wait] ...`）——
///     真卡死时，最后那几行就是铁证：卡在哪个请求、已经等了多久、当时在哪一页；
///   · 页面切换、门态（登录/设密码/进壳）、连上/断开、事件流开合，各记一行。
///
/// ## 三条分寸
///
///   · **没打开就什么都不做**（[attach] 之前 [write] 是空操作）：`flutter test`
///     会跑 831 条用例、每条都造几个 `IrmiaApi`，绝不能让它们往用户的
///     `%LOCALAPPDATA%` 里写字（那既是污染，也可能撞上文件占用）。真机入口
///     （`main.dart`）在 `runApp` 之前 [attach] 一次；
///   · **写日志不许影响界面**：任何异常都吞掉并自动关掉日志（磁盘满/被杀毒锁住时，
///     界面照常跑，只是没有日志）；
///   · **滚动上限 2MB**（[kGuiLogMaxBytes]）：超了就把当前这份改名成 `gui.log.1`
///     （覆盖上一份）再从头写，所以磁盘上最多两份、合计 4MB。
///
/// 行格式（**键名全 ASCII，便于 grep**；给人读的中文一律留在界面上，不在这里）：
///
/// ```
/// 2026-10-23T18:47:12.431 [net] FAIL GET /api/stats/dashboard after=15.0s error=...
/// 2026-10-23T18:47:12.500 [wait] inflight=1 oldest="GET /api/stats/dashboard" 12.3s page=overview
/// ```
///
/// ## 2026-10-25 补的那一批（"主线程停了多久"）
///
/// 上一版只有网络与切页两类行，**说不清"主线程停了多久、停在哪"**——现场明明是
/// 主 isolate 被阻塞（窗口在、画面是老的、点不动，而 CPU 空闲）。补了三类：
///
/// ```
/// 2026-10-25T03:12:44.101 [stall] gap=3.4s page=chat last="切页 扩展" inflight=1
/// 2026-10-25T03:12:56.802 [stall] recovered after 12.7s
/// 2026-10-25T03:12:40.004 [input] tap=发送消息 page=chat
/// 2026-10-25T03:12:39.771 [win] visibility=hidden
/// ```
///
///   · `[stall] …` 由**另一个 isolate** 写（`stall_watch.dart`）：它不经这个类，也不经主
///     isolate——主 isolate 卡住时正是它在说话。**它写进去的字节不计入这里的滚动账本**
///     （每行几十字节、一天也就几条，对 [kGuiLogMaxBytes] 没有实际影响）；
///   · `[input]` 是"被人按下去并且真的处理了"的关键动作（发送、重试、重启、托盘菜单项），
///     只记结果、不记 hover/滚动；`[page]` 照旧记切页。这两类的**文案**（`tap=` 的值、
///     `last=` 引用的那句）取自界面上的原话，所以这里会出现中文——它是给人读的现场，
///     不是给 grep 的键名（键名仍然是 ASCII）；
///   · `[win]` 是窗口的可见性与焦点（`win_trace.dart`）：与 `[stall]` 拼在一起才分得清
///     "窗口不在屏幕上"（画面当然是老的）与"窗口在、却一动不动"（主 isolate 停了）。
library;

import 'dart:convert';
import 'dart:io';

/// 单个日志文件的滚动上限（2 MiB）。
const int kGuiLogMaxBytes = 2 * 1024 * 1024;

/// 胜过这个耗时的请求记一行（毫秒）。**它不是超时**：超过它只是"慢得值得留痕"，
/// 而真正的超时在 `api.dart`（[kApiRequestTimeout]）。
const int kGuiLogSlowMs = 1000;

/// 有请求在飞时，隔多久记一行在飞清单（毫秒）。10 秒足够密到"卡死那一刻"，
/// 又足够疏到一整晚的挂机也只写几 KB。
const int kGuiLogWaitDumpMs = 10000;

/// 日志路径的覆盖口（用例用：写临时文件，不碰用户的 `%LOCALAPPDATA%`）。
String? guiLogPathOverride;

/// 这份日志的落点（真机路径；被 [guiLogPathOverride] 覆盖时以覆盖为准）。
String guiLogDefaultPath() {
  final base = Platform.environment['LOCALAPPDATA'];
  if (base == null || base.trim().isEmpty) {
    // 没有 LOCALAPPDATA（非 Windows / 精简环境）：退到临时目录，仍然有日志可看
    return '${Directory.systemTemp.path}${Platform.pathSeparator}irmia-gui.log';
  }
  return '$base\\Irmia\\gui.log';
}

/// 全局那一份（`IrmiaApi`/`AppState` 直接用它，不必层层注入）。
final GuiLog guiLog = GuiLog();

/// 一行一条、可滚动、打不开就静默关掉的日志本。
class GuiLog {
  GuiLog({this.maxBytes = kGuiLogMaxBytes});

  /// 滚动上限（字节）
  final int maxBytes;

  bool _attached = false;
  String? _path;
  int _bytes = 0;

  /// 打开了没有（没打开时 [write] 是空操作）
  bool get attached => _attached;

  /// 实际在写的那个文件；没打开时为 null（排障时界面上要能说出这个路径）
  String? get path => _path;

  /// 打开日志：建目录、量一下上次那份有多大、写一行会话头。
  ///
  /// 只在真机入口（`main.dart`）调一次；用例不调（所以用例不会碰真机的日志文件）。
  /// 打不开（权限/磁盘满/路径奇怪）时**静默放弃**：写不了日志不是致命错误。
  void attach({String? path}) {
    if (_attached) return;
    try {
      final target = path ?? guiLogPathOverride ?? guiLogDefaultPath();
      File(target).parent.createSync(recursive: true);
      _path = target;
      _attached = true;
      _bytes = 0;
      _rotateIfNeeded();
      write('[life] gui start pid=$pid');
    } catch (_) {
      _attached = false;
      _path = null;
    }
  }

  /// 收尾：写一行结束标记再关掉（托盘退出/关窗销毁时调）。
  void detach() {
    if (_attached) write('[life] gui stop pid=$pid');
    _attached = false;
  }

  /// 写一行。**自带时间戳**；没 [attach] 过就什么都不做。
  ///
  /// 刻意用同步写：真卡死时事件循环可能正堵着，异步落盘那一笔会跟着一起丢，
  /// 而这一笔恰恰是最要紧的那一笔。
  ///
  /// 滚动**在写之前**判断（[maxBytes] 到顶就先把当前这份改名成 `.1`）：
  /// 于是"当前那份"里永远是**完整**的最近若干行，不会出现"刚写进去的一行被搬走"。
  void write(String line) {
    if (!_attached || _path == null) return;
    final text = '${stamp()} $line\n';
    final bytes = utf8.encode(text).length;
    if (_bytes > 0 && _bytes + bytes > maxBytes) _rotate();
    try {
      File(_path!).writeAsStringSync(text, mode: FileMode.append, flush: true);
      _bytes += bytes;
    } catch (_) {
      // 写不动了（磁盘满/被锁）：关掉自己，界面不陪葬
      _attached = false;
    }
  }

  /// 把当前这份改名成 `<path>.1`（覆盖上一份），下一行开始写新文件。
  void _rotate() {
    final target = _path;
    if (target == null) return;
    final old = File('$target.1');
    try {
      if (old.existsSync()) old.deleteSync();
      File(target).renameSync(old.path);
    } catch (_) {
      // 改名失败（被占用/被权限挡住）：就地清空——宁可丢掉旧的那一半，
      // 也不要让文件无限长（无限长最后会拖垮写盘）。
      try {
        File(target).writeAsStringSync('');
      } catch (_) {
        _attached = false;
      }
    }
    _bytes = 0;
  }

  /// 打开时看一眼前一份：它若已经超过上限（上次退出时正好写满），先滚掉再开始。
  void _rotateIfNeeded() {
    final target = _path;
    if (target == null) return;
    final file = File(target);
    int size;
    try {
      size = file.existsSync() ? file.lengthSync() : 0;
    } catch (_) {
      return;
    }
    if (size >= maxBytes) {
      _rotate();
    } else {
      _bytes = size;
    }
  }

  /// 这一行的时间戳：本地时间、毫秒精度、可排序（`2026-10-23T18:47:12.431`）。
  ///
  /// 不用 `toIso8601String()` 的原样输出：它带微秒、`T`/`Z` 的口径也随实现变，
  /// 而排障时要的是"能按字符串排序、能看出秒级间隔"。
  static String stamp([DateTime? at]) {
    final t = at ?? DateTime.now();
    String two(int v) => v.toString().padLeft(2, '0');
    String three(int v) => v.toString().padLeft(3, '0');
    return '${t.year.toString().padLeft(4, '0')}-${two(t.month)}-${two(t.day)}'
        'T${two(t.hour)}:${two(t.minute)}:${two(t.second)}.${three(t.millisecond)}';
  }
}

/// 秒级耗时的统一写法（`12.3s`）：日志里到处要比"等了多久"，写法只能有一处。
String secsOf(Duration d) => '${(d.inMilliseconds / 1000).toStringAsFixed(1)}s';
