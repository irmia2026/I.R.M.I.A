/// 「重启前后端」的**唯一一条路**：首页那颗按钮与托盘那个菜单项都走这里。
///
/// ## 为什么要有这个文件（用户 ①：「有些用户重启仍容易失败，托盘才能重启」）
///
/// 两条路过去各写各的：首页（`pages/overview_page.dart` 的 `_restart`）把服务端回执里的
/// `scriptStarted == false` 判成**失败**、弹红字「重启未能执行」；托盘（`shell/tray.dart`）
/// **根本不判**，只把 `note` 记进日志。于是同一台机器上同一件事有两种观感：
/// 托盘点下去界面自己回来 ⇒ 看起来成功；首页点下去先红一条「重启未能执行」，
/// 几十秒后界面才被链条杀掉又拉回来 ⇒ 看起来失败。
///
/// ## 现场（本机 `data/restart-trace.log`，2026-10-16 那三轮完整重启，逐行原文）
///
/// ```
/// 17:39:13 [回执] 脚本已启动 · GuiExe=… · GuiOnly=False
/// 17:39:54 [实例] 后端已接管 pid=54576 source=lock.json      ← 启动后 41 秒
/// 17:40:28 拉起成功：Start-Process pid 40264
/// 17:40:48 [结束] ok=True backendPid=54576 port=ready …
/// ```
/// 而那次请求的回执等待窗口是 8 秒（`src/web/server.ts` 的 `RESTART_RECEIPT_WAIT_MS`；
/// 命令行里的 `-DelaySeconds 12` 正是它的 8 + 4 秒余量）。**8 秒窗口 < 41 秒事实**
/// ⇒ 每一轮真实重启的 200 回执里 `scriptStarted` 都是 `false`（三轮留痕形状一致）。
///
/// 所以判据不能把「没读到回执」当成「没重启」：
///   · **200 就说明链条发出去了**（服务端只有在 WMI `Win32_Process.Create` 返回 0 之后才回 200；
///     起不来那几种（路径不存在 / WMI 非 0 / 拉起器缺失）都抛 4xx，见 `server.ts:5322-5521`）；
///   · **`scriptOk == true`** 才是"链条自己确认成功"（带真实新 pid 与端口那一档）；
///   · **`scriptOk == false`** 才是"链条自己说失败"；
///   · 其余（`scriptStarted == false` 或 `scriptOk == null`）一律是**已发出、结局未确认**
///     —— 这时该做的是等它回来（[performRestart] 里那段），不是宣布失败。
///
/// 一句话：**判据只能有一份，而且只认链条自己给的三态**（`ok` / 失败原因 / 没读到）。
library;

import 'dart:io' show Platform;

import 'api.dart';
import 'i18n/app_strings.dart';
// 关键动作的留痕（`[input] tap=… page=…`）：卡死时"人最后按的是不是重启"要能看见
import 'stall_watch.dart';
import 'ui_kit.dart';

/// 命令名：服务端 `CONFIRM_PHRASES` 的键，也是 `X-Confirm` 头要带的那半截
const String kRestartCommand = 'restart';

/// 端点
const String kRestartEndpoint = '/api/commands/$kRestartCommand';

/// 请求体：**界面把自己的可执行路径带上**（脚本不该猜界面装在哪；给了路径就必须连界面一起重启）。
Map<String, dynamic> restartPayload({String? guiExe}) => <String, dynamic>{
      'guiExe': guiExe ?? Platform.resolvedExecutable,
    };

/// 发一次重启请求。首页与托盘**共用这一个函数**（同 path、同 body、同确认短语）。
Future<Object?> requestRestart(IrmiaApi api, {String? guiExe}) => api.post(
      kRestartEndpoint,
      restartPayload(guiExe: guiExe),
      confirm: kRestartCommand,
    );

/// 这次重启走到哪一步了（**唯一的一套结局**，两条路都只说这四种之一）。
enum RestartVerdict {
  /// 链条确认成功（`scriptOk == true`，带真实新 pid / 端口那一档）
  confirmed,

  /// 链条自己说失败（`scriptOk == false`，带坏在哪一环）
  failed,

  /// 已发出、结局未确认（`scriptStarted == false` 或 `scriptOk == null`）——**不是失败**
  sent,
}

/// 服务端那条 200 回执的结构化读法（字段以 `src/web/server.ts:5617-5637` 的下发为准）。
class RestartReceipt {
  const RestartReceipt({
    required this.gui,
    required this.started,
    required this.scriptOk,
    required this.backendPid,
    required this.port,
    required this.note,
    required this.path,
  });

  /// 把响应体读成回执。**读不懂的字段一律按"没读到"处理**（老服务端没有这几格）——
  /// 这与"猜一个成功"是相反的做法：说不出来就说不知道。
  factory RestartReceipt.of(Object? result) {
    final map = result is Map ? result : const <String, dynamic>{};
    final rawPid = map['backendPid'];
    final rawOk = map['scriptOk'];
    return RestartReceipt(
      // 老服务端没有 `gui` 这一格 ⇒ 按"界面不在范围内"读：宁可少说，也不替它宣称连界面一起重启了
      gui: map['gui'] == true,
      started: map['scriptStarted'] != false,
      scriptOk: rawOk == true ? true : (rawOk == false ? false : null),
      backendPid: rawPid is num && rawPid > 0 ? rawPid.toInt() : 0,
      port: map['port']?.toString() ?? '',
      note: map['note']?.toString() ?? '',
      path: map['path']?.toString() ?? '',
    );
  }

  /// 界面也在这次动作的范围内（`guiExe` 非空且被服务端接受）
  final bool gui;

  /// 服务端在回执窗口里读到了链条自己写的行（`[实例]` / `[结束]` / `[回执]`）。
  ///
  /// ⚠ **它不是"重启成没成"**：本机实测链条要 28~41 秒才写 `[实例]`，而窗口是 8 秒
  /// （见文件头）。所以它只回答"服务端在窗口里看见了没有"。
  final bool started;

  /// 链条结尾那行的 ok：true = 成功、false = 失败、null = 窗口里没读到
  final bool? scriptOk;

  /// 真实新 pid（0 = 没读到）
  final int backendPid;

  /// 端口那一档（`ready` / `waiting` / `foreign` / `unknown`）
  final String port;

  /// 服务端给人读的那句话（失败原因、成功凭据都在里面）
  final String note;

  /// 走的哪一条：`repo-script` / `packaged-script` / `self-restart`
  final String path;

  /// **判据只有这一处**（见文件头：三态只认链条自己的话）。
  RestartVerdict get verdict {
    if (scriptOk == true) return RestartVerdict.confirmed;
    if (scriptOk == false) return RestartVerdict.failed;
    return RestartVerdict.sent;
  }

  /// 凭据那半句：真实新 pid · 端口那一档（都没有就如实说"没给凭据"）
  String evidence(AppStrings strings) =>
      strings.restartEvidence(backendPid, port == 'ready');
}

/// 回执 → 那句给人看的话 + toast 的语义等级。
///
/// 两条路共用：首页把它交给 toast、托盘也交给 toast（窗口收起来时宿主改成写日志，
/// **话是同一句**）。`refused` 不是回执——那是请求本身没出去。
({RestartVerdict verdict, String message, ToastKind kind}) restartReport(
  AppStrings strings,
  RestartReceipt receipt,
) {
  switch (receipt.verdict) {
    case RestartVerdict.confirmed:
      return (
        verdict: RestartVerdict.confirmed,
        message: strings.restartConfirmed(receipt.evidence(strings)),
        kind: ToastKind.success,
      );
    case RestartVerdict.failed:
      return (
        verdict: RestartVerdict.failed,
        // 服务端那句话本身就是给人读的（带坏在哪一环）；没有就用一句忠实的兜底
        message: strings.restartFailed(
          receipt.note.isEmpty ? strings.restartNoConclusion : receipt.note,
        ),
        kind: ToastKind.error,
      );
    case RestartVerdict.sent:
      return (
        verdict: RestartVerdict.sent,
        message: receipt.gui
            ? strings.restartSentWithGui
            : strings.restartSentBackendOnly,
        kind: ToastKind.info,
      );
  }
}

/// 一次重启的**完整流程**：发请求 → 判结局 → 说一句话 → 等它回来。
///
/// 两条路都调它，所以"判据一套严一套松"这件事在结构上就不可能再发生：
///   · 首页：`say` = `IrmiaToast.show(context, …)`，`online` = `() => state.online`；
///   · 托盘：`say` = 同一条 toast（窗口在）或 `debugPrint`（窗口收着），`online` 同左。
///
/// [alive] 用来在宿主已经不在了（首页被链条杀掉、窗口销毁）时**闭嘴**——
/// 这句话没地方落，说出来也只是在日志里制造噪音。托盘那一路传"界面还活着"。
Future<void> performRestart({
  required IrmiaApi api,
  required AppStrings strings,
  required void Function(String message, ToastKind kind) say,
  required bool Function() online,
  bool Function() alive = _alwaysAlive,
  String? guiExe,
  Duration tick = const Duration(seconds: 1),
  int maxTicks = 90,
}) async {
  // 关键动作留痕：首页那颗按钮、托盘那一项、引导页的「立即重启」都汇到这一行。
  // 名字取按钮上的原话（`strings.trayRestart`），于是日志与屏幕上是同一句。
  traceInput(strings.trayRestart);
  Object? result;
  try {
    result = await requestRestart(api, guiExe: guiExe);
  } on ApiTimeout catch (err) {
    // **没等到回执**，与"没发出去"是两件事（2026-10-24 加，见 api.dart 的 [ApiTimeout]）。
    // 这条端点的语义是"把重启链条发出去"：超时只说明界面没等到那句话，链条很可能已经动了。
    // 说成"重启没能发出"就是在骗人——人会再点一次，于是同一台机器被重启两遍。
    // 所以这里走"已发出、结局未确认"那一支：先说出来，再照旧等后端回来。
    say(strings.restartNoReceipt(err.shortReason), ToastKind.info);
    await awaitBackendBack(
      strings: strings,
      say: say,
      online: online,
      alive: alive,
      tick: tick,
      maxTicks: maxTicks,
    );
    return;
  } catch (err) {
    // 请求没出去 = 一个进程都没动（409 已在重启中 / 400 路径不存在 / WMI 起不来 / 网络）
    say(strings.restartRefused(err.toString()), ToastKind.error);
    return;
  }
  final report = restartReport(strings, RestartReceipt.of(result));
  say(report.message, report.kind);
  // 只有"已发出、结局未确认"才需要等：
  //   · 链条确认成功了 ⇒ 它已经拿真实新 pid 与端口证明过，再等下去只会在"后端根本没断过"
  //     那一支里补一条**红字**，把刚说过的成功又盖掉（自相矛盾，人只会记住红的那条）；
  //   · 链条自己说失败 ⇒ 它已经给出坏在哪一环，等也没有意义。
  if (report.verdict != RestartVerdict.sent) return;
  await awaitBackendBack(
    strings: strings,
    say: say,
    online: online,
    alive: alive,
    tick: tick,
    maxTicks: maxTicks,
  );
}

/// 等后端"断开 → 回来"，并**如实**说等到没等到（最多 [maxTicks] 拍）。
///
/// 判据用的是同一个心跳（`AppState.online`）：服务端断开时转 false、回来后转 true。
/// 三种结局各有各的话，不许互相冒充：
///   · 断过又回来了 ⇒ 「已就绪：后端回来了」；
///   · 一次都没断过 ⇒ 「后端没有断开过：这次请求可能没有生效」；
///   · 等满窗口还没回来 ⇒ 「后端还没回来（等了 N 秒）」+ 指向留痕文件。
Future<void> awaitBackendBack({
  required AppStrings strings,
  required void Function(String message, ToastKind kind) say,
  required bool Function() online,
  bool Function() alive = _alwaysAlive,
  Duration tick = const Duration(seconds: 1),
  int maxTicks = 90,
}) async {
  var sawOffline = false;
  for (var i = 0; i < maxTicks; i += 1) {
    await Future<void>.delayed(tick);
    if (!alive()) return;
    if (!online()) sawOffline = true;
    if (sawOffline && online()) {
      say(strings.restartBackReady, ToastKind.success);
      return;
    }
  }
  if (!alive()) return;
  say(
    sawOffline
        ? strings.restartBackTimeout(maxTicks * tick.inSeconds)
        : strings.restartNeverWentDown,
    ToastKind.error,
  );
}

bool _alwaysAlive() => true;
