// TODO(i18n): 本文件还有 32 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/app.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:io' show Directory;
import 'shell/tray.dart';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
// 托盘的「退出全部」与「显示/收进托盘」要直接操作窗口（托盘自己只认菜单，见 shell/tray.dart）
import 'package:window_manager/window_manager.dart';

import 'api.dart';
import 'ask_card.dart';
import 'auth_gate.dart';
// 后端端口的**三级来源**（端口文件 > 环境变量 > 默认 7788）：见那个文件头的事故与取舍
import 'backend_port.dart';
// 「后端到哪一步了」那一个读数（`GET /api/health`）：门上三档提示 + 每 2 秒自动重探共用
import 'backend_probe.dart';
// 「退出全部」真的停后端那一步（端口 → pid → taskkill 树），判据与代价见那个文件
import 'backend_stop.dart';
// 「这次是我主动退的，别把我拉回来」（协议见 docs/gui-guard.md §3）
import 'gui_quit.dart';
// 待批的**那一份数据**（风险分级 / 判据 / 顺序 / 轮询）与右下角那一摞卡
// （壳一级：左侧「扩展」角标、托盘首项、右侧通知卡读的都在这两份文件里）
import 'grant_inbox.dart';
import 'grant_inbox_overlay.dart';
// 界面自己的运行日志（`%LOCALAPPDATA%\Irmia\gui.log`）：卡死时唯一能回答"卡在哪"的东西
import 'gui_log.dart';
import 'her_name.dart';
import 'home.dart';
import 'i18n/app_strings.dart';
import 'i18n/strings_override.dart';
import 'i18n/strings_scope.dart';
// 实例登记表（`%APPDATA%\Irmia\instances.json`）与"拉起/停掉一台实例"的外部世界：
// 选择页的数据层、以及 `AppState` 里「登出 = 结束实例」那三步的判据都在这里。
import 'instances.dart';
import 'mention_prompt.dart';
import 'onboarding.dart';
import 'pages/channels_page.dart';import 'pages/chat_page.dart';
import 'pages/extensions_page.dart';
import 'pages/logs_page.dart';
import 'pages/memory_page.dart';
import 'pages/overview_page.dart';
import 'pages/persona_page.dart';
import 'pages/schedule_page.dart';
import 'pages/settings_page.dart';
import 'password_prompt.dart';
// 重启那条路：首页那颗按钮与托盘那一项**共用这一个函数**（三态判据只有一份）
import 'restart_action.dart';
import 'session_store.dart';
// 主 isolate 卡顿看门狗：卡住时由另一个 isolate 写 `[stall]` 行（见那个文件的文件头）
import 'stall_watch.dart';
import 'theme.dart';
import 'title_bar.dart';
// 窗口状态留痕（`[win] focus/visibility/restore`）：与 `[stall]` 拼在一起才说得清现场
import 'win_trace.dart';
// 更新检查（2026-10-22）：数据模型与两处界面（顶部提醒条 / 设置页那一块）共用同一份解析
import 'update_check.dart';
// toast（托盘那几句的落点）与 confirm（「退出全部」的确认框）
import 'ui_kit.dart';
import 'ui_state.dart';

/// 「该设密码了」那张卡被按过「以后再说」的事实（与引导、"更多"折叠组同一份 ui-state.json）
const String kPasswordPromptDoneFlag = 'password-prompt-done';

/// 顶部更新提醒条被"×"关掉的那一版（键 `update-dismissed-version`，与主题/语言同一份
/// `%APPDATA%/Irmia/ui-state.json`）。
///
/// 存**版本号**而不是布尔：关掉的是"这一版我已经看过了"，下一个版本出现时提醒要重新露头。
/// `required`（低于最低可用版本）不吃这个键——那条不可关，判据在 `UpdateBanner` 里。
const String kUpdateDismissedVersionFlag = 'update-dismissed-version';

/// 启动时连不上本地服务的**重试节奏**（秒）。
///
/// 为什么不是"失败就停在一张错误卡上等人按重试"：「重启前后端」那颗按钮先把主进程停掉、
/// 再拉起界面，而 node 载入事件日志要几秒到几十秒——界面先起来、服务端还没监听，
/// 这是**安排好的顺序**，不是故障。停在错误卡上就等于让每次重启都欠人一次按键。
///
/// 为什么这么密（0.3~2 秒）：本地回环上一次连接被拒是几毫秒的事，重启后端口通常几秒内就起来；
/// 密一点只是几个毫秒级的本地 syscall，而"她回来了"能早一秒上屏就早一秒。
/// 上限 **2 秒**（2026-10-26）：后端冷启动要 35–42 秒（180 MB 事件日志），这条最密到 2 秒
/// 既够快、又不至于在门前空转着打几十次。
const List<double> kGateRetryDelays = [0.3, 0.5, 1, 2];

/// 连着重试多久还没连上，才降级成"连不上"那张错误卡（秒）。
///
/// 60 秒是宽限窗口：正常重启在这个窗口内一定连上了，所以绝大多数情况下人**一次按键都不用按**；
/// 窗口过了才说话，是为了"主进程真的没在跑"时不至于让人对着一个转圈的空屏干等——
/// 那种时候要有人话告诉他去确认主进程。
const int kGateGraceSeconds = 60;

/// 宽限窗口过了之后的**慢速重试**间隔（秒）。
///
/// 为什么降级之后还要继续试：降级只是"改口径"（从"正在启动"改成"可能真的没在跑"），
/// 不是放弃。主进程晚到两分钟也是常有的事（冷启动 + 事件日志大），它一起来界面就该自己进门，
/// 而不是等人回来按那颗「重试」。
///
/// **2 秒**（2026-10-26 从 3 秒改）：与 [kGateRetryDelays] 的最后一档同一个节奏
/// ——"自动每 2 秒重试一次"这句话在门卡上只该有一个数。
const int kGateSlowRetrySeconds = 2;

/// 宽限窗口的覆盖值（秒）；null = 用 [kGateGraceSeconds]。
///
/// 做法照 `session_store.dart` 的 `sessionsRootOverride`：**给测试用**，让"窗口用尽之后
/// 会降级、而且降级之后还在慢速重试"这条能在一秒内测到，而不是让用例真等 60 秒。
/// 真机上没人设它，所以它不是配置项，只是测试的接线柱。
int? gateGraceSecondsOverride;

/// 宽限窗口的实际取值：覆盖优先
int get gateGraceWindowSeconds => gateGraceSecondsOverride ?? kGateGraceSeconds;

/// 壳里断线之后的快轮询间隔（秒）。
///
/// 已经进了壳再断线（重启中）与门前等待是同一件事的两面：都需要"服务端一回来就自己接上"。
/// 2 秒而非 0.3 秒：这时界面是**画着东西**的（页面、侧栏都在），打太快纯属浪费。
const int kOfflinePollSeconds = 2;

/// 正常轮询间隔（秒）
const int kOnlinePollSeconds = 10;

/// 见过 turn 动静、但它还没被**响应**确认成"正在跑"时，下一拍读隔多久（毫秒）：**250ms**。
///
/// 为什么要有这一档（用户 2026-10-16 ②「那个思考反应快一点」）：值守/思考这件事在界面上
/// 只有一个读数（`/api/stats/dashboard`，见 [AppState._readDashboard]），而它原来只跟着
/// 10 秒的心跳走——她第 1 秒就在想、第 8 秒才想到第 3 步，界面上要等最多 10 秒才动一下。
///
/// 为什么 250ms：这不是"把轮询打密"，而是**事件驱动的重读**（见 [AppState._onFeedEvent]）。
/// 后端那条事件流本来就是这个节奏（`src/web/server.ts` 的 `SSE_POLL_MS = 250`：250ms 一轮
/// 从日志尾部泵出来），所以 250ms 是"这一拍不可能比事件本身来得更晚"的下限——比它再小只是
/// 对同一个响应空打。成本本机实测（`GET /api/stats/dashboard`，20 次采样）：
/// **中位 5.1ms / p95 7.5ms / 载荷 5377 B**，中位即最坏约 4 次/秒 ⇒ 服务端约 2% 单核。
const int kTurnReadMs = 250;

/// 见过 turn 动静、但**事件流没在推**（SSE 掉了）时，那一拍的宽限间隔（毫秒）：**3 秒**。
///
/// 为什么落回这一档而不是直接回 10 秒：那一刻界面相信"最近有动静"，而这个判断最后是由
/// **响应**纠正的（`openTurn` 在 [_readDashboard] 里被照抄）。回 10 秒意味着最坏 10 秒后
/// 才知道她其实早停了；3 秒既能把"她停了"及时纠正过来，又不像 250ms 那样在一条坏掉的链路上
/// 白打那么密。这一档正常情况下根本用不到——SSE 是 250ms 一轮的尾部泵，它掉了基本就等于后端没了。
const int kStaleTurnReadMs = 3000;

/// turn 信号钉着那几拍多久算**过期**（毫秒）。
///
/// 这是"最近这一小段有没有动静"的窗口：过了它，那条提示就算旧了（[AppState] 的
/// `turnSignalFreshWithin` 读它）。**它不参与"她在不在思考"的判据**——那句判据永远来自
/// 服务端的响应，这里只是对"链路还活不活"的一个粗判。5 秒是防"服务端投影比事件晚半步"的抖。
const int kTurnSignalHoldMs = 5000;

/// 事件到达后**合并**多久再读一次 dashboard（毫秒）。
///
/// 为什么需要合并：一条 turn 里 `tool/call`、`tool/result`、`step/*` 是成串来的，
/// 一条一变就是几十次请求打在同一个响应上——那正是用户说的"别更频繁地整表重建"。
/// 250ms 是"一帧到两帧"的量级：合并掉同一步里的连串事件，而人不觉得慢。
const int kTurnSignalDebounceMs = 250;

/// turn 信号合并窗口的覆盖值（毫秒）；null = 用 [kTurnSignalDebounceMs]。
///
/// 做法照 `gateGraceSecondsOverride`：**给测试用**，让"事件一到就重读、而且成串的只重读一次"
/// 这条能在几十毫秒内测到，而不是让用例真等 250ms。真机上没人设它。
int? turnSignalDebounceMsOverride;

/// 合并窗口的实际取值：覆盖优先
int get turnSignalDebounceMs => turnSignalDebounceMsOverride ?? kTurnSignalDebounceMs;

/// 这条事件算不算**"她那边有动静"**——只用来决定"要不要提前重读一次 dashboard"。
///
/// 判据只认 turn 自己的那几条（`src/log/types.ts` 的 `EVENT_VISIBILITY` 与 `fold.ts` 的
/// `applyOne` 逐条对得上）：
///   · `turn/start` / `turn/end`：`openTurn` 被置位/清空的那两条（`fold.ts:208-220`）；
///   · `step/start` / `step/end`：`openTurn.step` 跟着走的那两条（`fold.ts:221-227`）；
///   · `message/reasoning` / `message/assistant` / `tool/call` / `tool/result`：
///     turn 活着时成串来的东西，用来"别让一步跑完了界面还不知道"。
///
/// ★ **它不判"她在不在思考"**：那条判据只有一处——[AppState._readDashboard] 里服务端
/// 自己那句话的同一个响应（`openTurn != null && state == 'running'`）。这里多认识一条事件，
/// 最坏的后果只是多读一次 dashboard（读到什么由服务端说），**不会**让"思考中"这句话凭空成立。
/// 反过来漏认一条的后果也只是"这一下没提前读"（10 秒那一拍照旧纠正）。
///
/// 不认通道消息、快照、慢拍告警那些：它们不改左上一行字，理会了就是白白重读整屏。
bool isTurnSignalEvent(String? type) {
  switch (type) {
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
    case 'message/reasoning':
    case 'message/assistant':
    case 'tool/call':
    case 'tool/result':
      return true;
    default:
      return false;
  }
}

/// GUI 外壳与全局状态。页面在 pages/ 下，通过 AppState 拿数据与会话凭据。
/// 结构规格：docs/gui-design.md §3。
class IrmiaApp extends StatefulWidget {
  const IrmiaApp({super.key, this.initialLanguage = AppLanguage.zh});

  /// 启动时生效的语言。**默认中文**（作者语言），入口 [main] 会按盘上的偏好与系统
  /// locale 把它定下来（见 `i18n/strings_scope.dart` 的 `restoreLanguage`）。
  ///
  /// 为什么默认值不是"跟随系统"：语言**不在 widget 树里解析**——树里读平台 locale，
  /// widget 测试的结论就会跟着跑测试那台机器的系统语言变。默认具体中文 ⇒ 任何
  /// `IrmiaApp()` / 单独 pump 的页面在用例里的输出是确定的。
  final AppLanguage initialLanguage;

  @override
  State<IrmiaApp> createState() => _IrmiaAppState();
}

/// 页面条目：导航与页面宿主共用同一份定义（一级六项 + 底部「更多」的二级项），
/// 一律按 id 定位页面而不是下标——增删或重排页面时不会错位。
class PageEntry {
  const PageEntry({
    required this.id,
    required this.label,
    required this.icon,
    required this.builder,
    this.solidIcon,
  });

  final String id;
  final String label;
  final IconData icon;
  final IconData? solidIcon;
  final Widget Function(AppState state) builder;

  /// 选中态图标：未单独指定时与常态一致
  IconData get activeIcon => solidIcon ?? icon;
}

/// 默认落点：运行情况（壳的常驻首页）
const defaultPageId = 'overview';

/// 一级入口：只放高频功能。
///
/// ⚠ 条数与判据的变更史（值得留着，免得下一个人照着旧规矩把「日程」挪走）：
/// `docs/gui-design.md` §3 原来钉的是"**保持五项**"，而用户 2026-10 明确要一页「日程」
/// （设计稿 `Agent 近期安排 · 周历与清单.html`）——**那条判据被推翻了**，现在是六项。
/// 被推翻的只是"五项"这个数；"一级只放高频功能、低频进「更多」"这条仍然有效
/// （所以记忆/日志/设置还在二级）。
final navPages = <PageEntry>[
  PageEntry(
    id: 'overview',
    label: '运行情况',
    icon: Icons.grid_view_outlined,
    solidIcon: Icons.grid_view_rounded,
    builder: (state) => OverviewPage(state: state),
  ),
  PageEntry(
    id: 'chat',
    label: '聊天',
    icon: Icons.chat_bubble_outline_rounded,
    solidIcon: Icons.chat_bubble_rounded,
    builder: (state) => ChatPage(state: state),
  ),
  PageEntry(
    id: 'schedule',
    label: '日程',
    icon: Icons.event_available_outlined,
    solidIcon: Icons.event_available_rounded,
    builder: (state) => SchedulePage(state: state),
  ),
  PageEntry(
    id: 'persona',
    label: '人格配置',
    icon: Icons.person_outline_rounded,
    solidIcon: Icons.person_rounded,
    builder: (state) => PersonaPage(state: state),
  ),
  PageEntry(
    id: 'channels',
    label: '消息适配器',
    icon: Icons.swap_horiz_rounded,
    solidIcon: Icons.swap_horiz_rounded,
    builder: (state) => ChannelsPage(state: state),
  ),
  PageEntry(
    id: 'extensions',
    label: '扩展',
    icon: Icons.extension_outlined,
    solidIcon: Icons.extension_rounded,
    builder: (state) => ExtensionsPage(state: state),
  ),
];

/// 二级入口：低频功能，收进底部「更多」折叠组，不占一级位置
final morePages = <PageEntry>[
  PageEntry(
    id: 'memory',
    label: '记忆',
    icon: Icons.psychology_outlined,
    solidIcon: Icons.psychology_rounded,
    builder: (state) => MemoryPage(state: state),
  ),
  PageEntry(
    id: 'logs',
    label: '日志',
    icon: Icons.article_outlined,
    solidIcon: Icons.article_rounded,
    builder: (state) => LogsPage(state: state),
  ),
  PageEntry(
    id: 'settings',
    label: '设置',
    icon: Icons.settings_outlined,
    solidIcon: Icons.settings_rounded,
    builder: (state) => SettingsPage(state: state),
  ),
];

/// 全量注册表：一级 + 二级，供按 id 定位
final allPages = <PageEntry>[...navPages, ...morePages];

/// 按 id 取页面条目；未知 id 返回 null，由调用方兜底
PageEntry? pageEntryById(String id) {
  for (final page in allPages) {
    if (page.id == id) return page;
  }
  return null;
}

class _IrmiaAppState extends State<IrmiaApp> {
  late final AppState state;

  /// 托盘的 toast 落点。
  ///
  /// 托盘点击是**原生菜单回调**，手上没有 BuildContext；而"重启/退出"的那几句话必须有个落点
  /// （窗口收在托盘里时至少还进日志）。导航器的 context 在 `MaterialApp` 的
  /// `ScaffoldMessenger` 与 `Theme` 之下，`IrmiaToast.show` 拿它就能画出与页里一模一样的那条。
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();

  /// 语言 + 文案覆盖层：**哪一边变了都重建 `MaterialApp`**（都不重启界面）。
  ///
  /// 合成一条 listene 而不是套两层 builder：两者的动作完全一样（换一整棵树、保状态），
  /// 分开监听只多一层缩进。`late final` 保证只订阅一次（build 里造新的会反复订阅/退订）。
  late final Listenable _stringsSources = Listenable.merge(<Listenable>[
    effectiveLanguage,
    stringsOverrideState,
  ]);

  @override
  void initState() {
    super.initState();
    // 入口解析好的语言落进那个全局 notifier（默认中文，见 IrmiaApp.initialLanguage）
    effectiveLanguage.value = widget.initialLanguage;
    /**
     * 端口**三级来源**（2026-10-26）：后端写的端口文件 > 环境变量 > 默认 7788。
     *
     * 事故那天这里只读环境变量，父进程塞进来的 `IRMIA_WEB_PORT=1580` 把界面带到了
     * 一个没人听的端口上（屏幕上只有 `SocketException … port = 1580`）。现在第一档是
     * **盘上的事实**（后端 bind 成功那一刻写的 `%LOCALAPPDATA%\Irmia\server.json`），
     * 环境变量降为第二档。判据与取舍见 `backend_port.dart` 的文件头。
     */
    final backend = resolveBackendPort();
    state = AppState(
      api: IrmiaApi(baseUrl: 'http://127.0.0.1:${backend.port}'),
      backend: backend,
      // 每次门前重试都可以再读一次端口文件（后端起来后会写它）：只采纳"文件"这一档，
      // 绝不在重试中往环境变量/默认值回退——那正是把界面带回错误端口的路。
      backendPortResolver: resolveBackendPort,
      // **真机才注入外部世界**（判活 / 探端口 / 拉起后端 / 按端口强停）。
      // `AppState` 的缺省是一份"什么都问不到"的替身：用例不该因为构造它而去连本机回环
      // （假时钟里等一条真 socket 会挂住不返回）。见 `instances.dart` 的 InstanceHost.offline。
      instances: InstanceHost.real(),
    );
    // **不在这里决定画哪一态**：凭据按实例分文件存，而"我是哪个实例"只有服务端知道。
    // 所以先空手问一次（bootstrap），拿回实例标识与 `code` 之后才知道该弹"设置密码"还是"登录"。
    unawaited(state.bootstrap());
    // **托盘接线**（2026-10-04，2026-10-17 改）：菜单五项、四个动作都由这里注入——
    // 托盘自己只认菜单与插件（见 shell/tray.dart 的文件头：两项退出为什么必须分开）。
    // 放在 initState 里而不是 main()：这里拿得到 state.api（凭据也在这一步就位）。
    // 门还没进的时候它也照装：托盘是窗口的财产，不归"登录了没有"管。
    unawaited(IrmiaTray.instance.install(
      actions: TrayActions(
        // 托盘那几项都是**关键动作**：每一项先记一条 `[input]`（菜单上的原话），
        // 再把窗口状态说清（`[win] restore`）——卡死时"人最后点的是托盘哪一项"就在日志里。
        show: () {
          traceInput(currentStrings.trayShow);
          WinTrace.instance.noteRestored();
          unawaited(windowManager.show());
          unawaited(windowManager.focus());
        },
        hide: () {
          traceInput(currentStrings.trayHide);
          WinTrace.instance.noteHidden();
          unawaited(windowManager.hide());
        },
        // 与首页那颗「重启前后端」**同一个函数**：请求、三态判据、说的话、等回来的窗口只有一份
        // （它自己在入口处记 `[input]`，这里不重复记）
        restart: _restartFromTray,
        // 「退出界面」= 老行为：写标记（别让保活把我拉回来）→ 收托盘 → 关窗。后端一个字节都不动
        quitUi: () {
          traceInput(currentStrings.trayQuitUi);
          _quitUi();
        },
        // 「退出全部」= 界面 + 后端（含它拉起的协议端）；确认框把硬杀的代价说清
        quitAll: () {
          traceInput(currentStrings.trayQuitAll);
          unawaited(_quitAll());
        },
        // 菜单首项「有 N 条待批」：窗口先摆出来，再落到扩展页（那一页能一次看完并逐条批）。
        // 这是**人自己点的**，所以显示 + 聚焦窗口是对的——与通知卡"不许抢焦点"不冲突。
        openPending: () {
          traceInput(currentStrings.trayPendingItem(state.pendingGrantCount));
          WinTrace.instance.noteRestored();
          unawaited(windowManager.show());
          unawaited(windowManager.focus());
          state.setPage('extensions');
        },
        // 「有新版本」那一项：显示窗口并落到设置页（「关于」里有检查更新与查看）。
        // **不直接开浏览器**：托盘是原生菜单，点一下就把浏览器拉起来太突然；
        // 真正打开外链只有人工按的那颗「查看」/「检查更新」。
        openUpdate: () {
          traceInput(currentStrings.trayUpdateItem(state.updateInfo?.latestVersion ?? ''));
          WinTrace.instance.noteRestored();
          unawaited(windowManager.show());
          unawaited(windowManager.focus());
          state.setPage('settings');
        },
      ),
      strings: currentStrings,
      // 托盘提示里是**她的名字**（读不到时由 her_name.dart 决定显示什么）
      displayName: state.herDisplayName,
    ));
    // 名字是异步读来的（`persona/IDENTITY.md`），读到之后托盘提示也跟着换一次；
    // 每次轮询都会调到这里，而 setDisplayName 在值没变时直接返回（不做无用的系统调用）
    state.addListener(_syncTrayName);
    // 待批数变了：托盘悬停提示与菜单首项跟着换（同样是"值没变就什么都不做"）
    state.addListener(_syncTrayPending);
    // 更新状态变了：有新版本时托盘菜单多一行、悬停提示挂一句（"已是最新"不占位置）
    state.addListener(_syncTrayUpdate);
    // 菜单文字是**原生对象**，不跟着 Flutter 重建：语言一变就重画一遍（否则切到 English 之后
    // 托盘还是中文，而这种不一致没人会想到去查）
    effectiveLanguage.addListener(_syncTrayLanguage);
    // 文案覆盖层同理：设置页点「重新载入文案」之后托盘那五项也要换成新的字
    // （它是原生菜单，不会跟着 IrmiaStrings 重建）
    stringsOverrideState.addListener(_syncTrayLanguage);
  }

  /// 状态一变就把她的名字同步给托盘（真正的判断在 [IrmiaTray.setDisplayName] 里）
  void _syncTrayName() => unawaited(IrmiaTray.instance.setDisplayName(state.herDisplayName));

  /// 状态一变就把待批数同步给托盘：首项变成「有 N 条待批」，悬停提示后面挂上条数。
  ///
  /// 托盘是**关窗之后唯一还看得见的东西**（见 shell/tray.dart 的文件头）：人把窗口收进托盘
  /// 之后，右下角那张卡就不在屏幕上了——那时候"她递了一张单子"只能靠托盘说出来。
  void _syncTrayPending() => unawaited(
        IrmiaTray.instance.setPendingCount(count: state.pendingGrantCount, strings: currentStrings),
      );

  /// 把更新状态同步给托盘：有新版本/必须升级时菜单多一行、悬停提示挂一句。
  ///
  /// `required` 与 `available` 在托盘上的区别只在措辞（"请升级" vs "查看"）——
  /// 托盘没有"关掉"这个动作，所以 `dismissible` 不参与这一层。
  void _syncTrayUpdate() {
    final info = state.updateInfo;
    final show = info != null && info.enabled && info.hasUpdate;
    unawaited(IrmiaTray.instance.setUpdate(
      version: show ? info.latestVersion : null,
      required: show && info.required,
      strings: currentStrings,
    ));
  }

  /// 语言或文案覆盖一变就把托盘菜单的文字重画一遍（两边说的是同一句：
  /// 语言换了换措辞，覆盖文件换了换用户自己改的那几个字）
  void _syncTrayLanguage() => unawaited(IrmiaTray.instance.refreshMenu(currentStrings));

  @override
  void dispose() {
    effectiveLanguage.removeListener(_syncTrayLanguage);
    stringsOverrideState.removeListener(_syncTrayLanguage);
    state.removeListener(_syncTrayName);
    state.removeListener(_syncTrayPending);
    state.removeListener(_syncTrayUpdate);
    state.dispose();
    super.dispose();
  }

  // ────────────────────────── 托盘那四个动作 ──────────────────────────

  /// 一个 toast 的落点：**有界面上下文就弹给人看，没有就只写日志**。
  ///
  /// 托盘点击时窗口可能收在托盘里——那时候弹 toast 没有落点，但**那句话不能丢**：
  /// 它与首页那颗按钮说的是同一句（[performRestart] 给的），只是换了个去处。
  void _say(String message, ToastKind kind) {
    final context = _navigatorKey.currentContext;
    debugPrint('[托盘] $message');
    if (context == null) return;
    IrmiaToast.show(context, message, kind: kind);
  }

  /// 托盘「重启前后端」：与首页那颗按钮**同一个函数**（判据一套，不严不松）
  Future<void> _restartFromTray() => performRestart(
        api: state.api,
        strings: currentStrings,
        say: _say,
        online: () => state.online,
        alive: () => mounted,
      );

  /// 托盘「退出界面（她继续在后台运行）」：老行为，一个后端进程都不动。
  ///
  /// **先写标记、再退**（协议见 docs/gui-guard.md §3）：后端保活按"有没有这个标记"分
  /// "他主动退的"与"崩了/被杀了"，不写就会被当成崩溃拉回来（最多 6 次）。
  void _quitUi() {
    unawaited(markGuiQuit('tray-quit'));
    unawaited(_finishQuit());
  }

  /// 托盘「退出全部（界面 + 后端）」。
  ///
  /// 三件事，每一件都有它非做不可的理由：
  ///   ① **先确认**：这是唯一一个会结束后端（连同协议端）的动作，代价要摆在人面前
  ///      （`quitAllConfirmBody`：硬杀丢了什么、她正在跑的那一轮会怎样、协议端要不要重登）；
  ///   ② **真的停后端**（[stopBackendOnPort]：界面正在用的那个端口的监听者 → 它的进程树），
  ///      并**核实端口不再应答**——停不下来就如实报错、**并且不关界面**，
  ///      免得人以为"全退了"而实际上后端还在跑（那正是这次要修的毛病）；
  ///   ③ **先写标记再退**：与「退出界面」同一个握手，否则保活会把界面又拉起来。
  Future<void> _quitAll() async {
    final opened = _navigatorKey.currentContext;
    if (opened == null) {
      // 极端情况（窗口/导航都还没建好）：什么都不做，也不假装退了
      debugPrint('[托盘·退出全部] 拿不到界面上下文，这次不执行');
      return;
    }
    // 确认框必须落在人看得见的地方：托盘点出来时窗口可能收着
    WinTrace.instance.noteRestored();
    unawaited(windowManager.show());
    unawaited(windowManager.focus());
    final strings = currentStrings;
    // 她正在跑一轮时，这一轮会被硬杀打断——这件事要在确认框里说，不许事后才解释
    final busy = state.openTurn != null;
    final yes = await confirm(
      opened,
      title: strings.quitAllConfirmTitle,
      body: strings.quitAllConfirmBody(busy),
      confirmLabel: strings.quitAllConfirmLabel,
      danger: true,
    );
    if (!yes || !mounted) return;
    // 界面用的端口就是后端在听的那个端口（baseUrl 是回环地址，见 initState）
    final port = Uri.parse(state.api.baseUrl).port;
    // 话走 [_say]：它每次现取上下文（拿不到就只进日志），所以这里不用把 context 带过 await
    _say(strings.quitAllWorking, ToastKind.info);
    final result = await stopBackendOnPort(port);
    // 停不下来就**不关界面**：那句失败必须有人看得见，而不是跟着窗口一起消失
    if (!result.ok) {
      _say(currentStrings.quitAllFailed(result.detail), ToastKind.error);
      return;
    }
    debugPrint('[托盘·退出全部] ${currentStrings.quitAllDone}：${result.detail}');
    await markGuiQuit('tray-quit-all');
    await _finishQuit();
  }

  /// 退出流程的收尾：先拆托盘、再关窗（顺序反过来会留一个点不动的托盘图标）
  Future<void> _finishQuit() async {
    guiLog.write('[life] gui quit');
    // 看门狗先停：它写的是同一个文件，`guiLog.detach()` 之后留下的那个 isolate 不该再写
    StallWatch.instance.stop();
    WinTrace.instance.detach();
    await IrmiaTray.instance.remove();
    try {
      await windowManager.destroy();
    } catch (err) {
      debugPrint('关窗失败：$err');
    }
    // 日志最后关：上面两步任何一步抛异常，前面那些现场已经在盘上了
    guiLog.detach();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        // 语言一变就重建 `MaterialApp`（**不重启**）：locale、Material 自带文案、
        // 以及 [IrmiaStrings] 那一层的内容一起换。`ValueListenableBuilder` 在值没变时
        // 不重建——"选一个已经选中的语言"不会白重建一整棵树。
        //
        // 2026-10-21 起这个 listene 换成"语言 **或** 文案覆盖层"（[Listenable.merge]）：
        // 设置页那颗「重新载入文案」改的是 [stringsOverrideState]，语言一个字都没动，
        // 但屏幕上的字必须跟着换——只监听语言的话按下去什么都不会发生。
        return ListenableBuilder(
          listenable: _stringsSources,
          builder: (context, __) {
            final language = effectiveLanguage.value;
            final strings = resolveStrings(language);
            return MaterialApp(
              // 托盘的 toast 落点（见 [_navigatorKey]）：托盘回调没有 context，用它取一条
              navigatorKey: _navigatorKey,
              // 窗口标题 = **她的名字**（读不到时回退成产品名，见 her_name.dart 的口径）。
              // 产品名 `Irmia Agent Framework` 是另一件事：它在自绘标题栏与 C++ runner 里，
              // 与她叫什么无关，所以这里不跟它走。
              //
              // 实测（2026-10-03，release 版跑起来用 GetWindowText 读原生标题）：Windows 上这一行
              // **到不了原生窗口标题**——标题是 main.dart 的 `WindowOptions(title: …)`（产品名）
              // 定的，一直显示 `Irmia Agent Framework`。所以改这里不会动到产品名，也不会像按下
              // 开关那样换掉标题；它是"这个应用对外自称什么"的声明位（别的平台/无障碍会读它），
              // 放着与她的名字一致是对的，但不能拿它当"窗口标题跟配置走"的证据。
              title: herNameOrFallback(state.herName),
              debugShowCheckedModeBanner: false,
              theme: IrmiaTheme.light(),
              darkTheme: IrmiaTheme.dark(),
              themeMode: state.themeMode,
              // ── i18n 的两条线（分工见 i18n/app_strings.dart 顶部）──
              //   · locale + 三个 delegate —— 管 **Material 自己那层文案**（文本框的
              //     剪切/复制/粘贴菜单、滚动条与对话框的无障碍标签、数字日期格式）。
              //     不装它，中文界面里那排菜单永远是英文（现状，2026-10-17 盘点）。
              //   · [IrmiaStrings]（在 builder 里）—— 管**我们自己的文案**，
              //     页面用 `IrmiaStrings.of(context)` 取。
              locale: strings.locale,
              localizationsDelegates: const [
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              supportedLocales: const [Locale('zh', 'CN'), Locale('en', 'US')],
              // 自绘标题栏画在所有页面之上（含那道门）：窗口已经没有系统标题栏，
              // 这条既是标题也是唯一的拖动区（docs/gui-revision.md ①）。
              builder: (context, child) => IrmiaStrings(
                strings: strings,
                child: Column(
                  children: [
                    const IrmiaTitleBar(),
                    Expanded(child: child ?? const SizedBox.shrink()),
                  ],
                ),
              ),
              // 门与壳的切换只看 `ready`：它由 bootstrap/登录/设密码/401 自愈四处共同维护，
              // 不在 build 里再算一遍判据（两处判据必然漂移，而漂移的表现就是"白屏"）。
              home: state.ready
                  // 四层宿主包住整壳，从外到内：
                  //   · OnboardingHost —— 首次启动引导（一次性的，判据见 onboarding.dart）；
                  //   · PasswordPromptHost —— 「该设密码了」的首次提示（只对凭老凭据进门的人弹，
                  //     见 password_prompt.dart：不弹的话那条老路会一直能用，密码就没人设了）；
                  //   · MentionPromptHost —— 「她怎么被称呼」的首次提示；
                  //   · AskCardHost —— 她此刻在问的那张卡（每次都来）；
                  //   · GrantInboxHost —— 右下角那摞待批卡（每次都来，但它**不抢焦点**）。
                  // 引导放最外层：它是"第一次用的人"最先该看到的东西，而它读的现状（人格种子、
                  // 密钥、通道）全都要先有会话凭据——所以它也只能在那道门之后（见 onboarding.dart 顶部）。
                  // 待批卡放在**最内层**（只包住壳）：它不该压住引导、设密码那些必须走完的流程，
                  // 也不该压住她问的那张卡（AskCardHost 是模态，优先级更高）。
                  ? OnboardingHost(
                      state: state,
                      child: PasswordPromptHost(
                        state: state,
                        child: MentionPromptHost(
                          state: state,
                          child: AskCardHost(
                            state: state,
                            child: GrantInboxHost(state: state, child: HomeShell(state: state)),
                          ),
                        ),
                      ),
                    )
                  : AuthGate(state: state),
            );
          },
        );
      },
    );
  }
}

/// 全局状态：会话凭据、状态句、主题、当前页、徽章、以及"进没进门"
class AppState extends ChangeNotifier {
  AppState({
    required this.api,
    SessionStore? sessions,
    BackendPort? backend,
    this.backendPortResolver,
    InstanceHost? instances,
  })  : sessions = sessions ?? SessionStore(),
        instances = instances ?? InstanceHost.offline(),
        backend = backend ?? BackendPort.fromBaseUrl(api.baseUrl) {
    // **401 自愈的接线点**：服务端说这张票不作数时，重读这个实例的凭据文件再试一次。
    // 为什么值得这么做：改了密码（所有旧会话作废）、或在别处登出过之后，人**不该被要求重启界面**。
    api.onUnauthorized = _rereadCredential;
    // 排障接线：卡死时日志里那行 `[wait] … page=…` 要能说出"当时在哪一页"。
    // 传输层不认识页面，所以由这里把读数塞给它（见 gui_log.dart / api.dart 的 `_dumpWaits`）。
    api.pageProbe = () => pageId;
    // 同一个读数口再接给 `[input]` 那一层：它没有 `AppState` 在手（见 stall_watch.dart
    // 的 `guiPageProbe`），而"最后动的是哪个按钮、在哪一页"正是 `[stall]` 行里最要紧的两格。
    guiPageProbe = () => pageId;
    // **主 isolate 卡顿看门狗**（stall_watch.dart）：真卡住时唯一还能说话的是另一个 isolate。
    // 只在日志开着时才起——与 gui_log.dart 的"没打开就什么都不做"是同一条分寸：
    // 用例会造几百个 AppState，一条 isolate 都不该为它们起。
    final logPath = guiLog.path;
    if (guiLog.attached && logPath != null) {
      unawaited(StallWatch.instance.start(logPath: logPath, snapshot: _stallSnapshot));
    }
  }

  /// 心跳快照：**卡住那一刻**"在哪一页、最后一条动作是什么、有没有请求在飞"。
  ///
  /// 它在主 isolate 里每 [kStallBeatEvery] 跑一次，拼好之后把字符串拷贝给看门狗；
  /// 于是卡住时看门狗手上拿的就是"最后一句还活着的话"（见 stall_watch.dart）。
  String _stallSnapshot() {
    final oldest = api.oldestPending;
    return stallSnapshot(
      page: pageId,
      last: lastTraceText,
      inflight: api.inFlightCount,
      oldest: oldest?.label,
      oldestAge: oldest?.elapsed,
    );
  }

  final IrmiaApi api;
  final SessionStore sessions;

  /// 外部世界（判活 / 探端口 / 拉起后端 / 按端口强停）——**唯一**一处分装。
  ///
  /// 默认 [InstanceHost.offline]：**用例里一个系统调用都不发**。真机装配在
  /// `_IrmiaAppState.initState` 里显式给 [InstanceHost.real]。这条默认值是刻意的：
  /// `AppState` 被上百条用例构造，任何一条都不该因为"没注入宿主"而去连本机回环、
  /// 更不该在假时钟里等一条真 socket（那种等待会让用例挂住不返回）。
  final InstanceHost instances;

  /// 当前连的是哪个后端端口、这个端口是哪一档来的（`file` / `env` / `default`）。
  ///
  /// 它是**可变**的：门前重试的每一拍都可以重读一次端口文件（见 [_adoptPortFromFile]）——
  /// 后端晚于界面起来、而且不在默认端口时，界面也能自己找过去。
  BackendPort backend;

  /// 每次重试前重读端口文件的注入口；null = 不重读（用例默认如此）。
  ///
  /// 生产装配（`_IrmiaAppState.initState`）传的是 `resolveBackendPort`。**只在"文件"这一档
  /// 与当前端口不同**时才切换（见 [_adoptPortFromFile]）：重试途中绝不许退到环境变量/默认值
  /// ——那一条正是事故那天把界面带到 1580 的路。
  ///
  /// **可变**（2026-10 多实例）：人从选择页**显式选过一台实例**之后，这一格会被置空
  /// （见 [_adoptInstance]）——`server.json` 是"默认实例"的提示位，选过第二台之后
  /// 它就成了错误来源（它会把界面带回默认实例的端口）。
  BackendPort Function()? backendPortResolver;

  /// 门卡上"正在等 :N"里的 N（与 [api] 的 baseUrl 同源，永远读 [backend]）
  int get backendPort => backend.port;

  /// 已进门了吗。false = 画那道门（见 [AuthGate]）。
  bool ready = false;
  /// 门上画哪一态（只在 `ready == false` 时有意义）
  AuthGateKind gate = AuthGateKind.checking;
  /// 门上那行错误（密码不对、两次不一致、连不上…）；空 = 没问题
  String gateError = '';
  /// 门上的**中性提示**（"现在该去哪一扇门、为什么换了门"）；空 = 不显示。
  ///
  /// 与 [gateError] 分工：`auth-uninitialized` / `unauthorized` 这两条 401 是**分流信号**，
  /// 不是错误，不许进红字那一行——2026-10-23 的现场就是探测那一次的 message 被当成错误
  /// 显示在设置页底部，看着像"这台实例没密码"，而它其实有密码。真正的错误（密码不对、
  /// 两次输入不一致、连不上、服务端拒绝）才走 [gateError]。
  ///
  /// 文案不在这里拼（状态层没有 BuildContext）：这里只记**是哪一种情况**，门那一层
  /// 用 [AuthGateHint] 去 AppStrings 取这个语言的那一句。
  AuthGateHint gateHint = AuthGateHint.none;
  /// 门上有请求在飞（按钮显示"正在…"且禁用，防连点）
  bool gateBusy = false;

  /// 门前那次握手的**第几次尝试**（1 = 第一次，还没重试过）。界面上那句
  /// "第 N 次尝试"读它；进门成功时归零。
  int gateAttempt = 0;
  /// 这次等待已经过了几秒（宽限窗口的进度）。由 [_tickGate] 每秒推一格，
  /// **不读系统时钟**：时钟会被系统对时跳一下，而"已等 Xs"是给人看的进度，不是时间戳。
  int gateWaited = 0;
  /// 还在**自动重连**里（这一轮门前等待进行中）。降级之后它仍然为 true——降级只是换口径，不放弃。
  ///
  /// 它同时是"这次失败是不是重试那一拍发起的"的**唯一判据**（见 [_onConnectFailure]）：
  /// 判据必须落在这条**逻辑状态**上，而不是 `_gateRetry` 那条定时器字段上——后者反映的是
  /// "此刻有没有一条待发的定时器"，而重试那一拍跑起来的时候它必然是空的。
  bool gateRetrying = false;
  /// 宽限窗口用尽、已经降级成"连不上"那张卡
  bool gateUnreachable = false;

  /// 门卡上那句"每 N 秒仍会自动重试"里的 N（口径只有 [kGateSlowRetrySeconds] 一处）
  int get gateSlowRetrySeconds => kGateSlowRetrySeconds;

  // ── 门上那三档：连不上 / 正在启动 / 密码不对（2026-10-28） ──
  //
  // 这三档原来是**一句话**：登录页把"后端没起""后端还在启动""密码错"全说成"连不上"。
  // 后果不是话不好听，而是人对着密码框反复重输——而真正的问题是主进程没在跑；
  // 更糟的是那时候界面**不会自己再试**（真机读数：16:19:05 起一直报"还在启动（阶段 channels）"，
  // 16:19:35 后端已经 ready，屏幕上那句错就一直停在那儿）。
  //
  // 现在的分工：
  //   · ①②（连不上 / 正在启动）⇒ [gateWaitingBackend] 为真，话由 [backendReadiness] 决定，
  //     并且挂上 [kBackendRetrySeconds] 秒一拍的自动重探；**不发登录请求**（密码不许被自动重发）；
  //   · ③（401）⇒ 仍是服务端那句"密码不对"，一个字都不改（它比任何客户端猜的都准），
  //     而且不碰输入框、不挂重探。

  /// 后端此刻到哪一步了（[probeBackend] 的读数；`unknown` = 还没探过）
  BackendReadiness backendReadiness = BackendReadiness.unknown;

  /// 服务端报的启动阶段（`events` / `mcp` / `channels` / `ready`；空 = 这一版不报）
  String backendPhase = '';

  /// 这一轮等待已经过了几秒（门卡上"第 N 秒"读它）
  int backendWaitSeconds = 0;

  /// 这一轮等待里自动重探了几次（门卡上"已重试 M 次"读它）
  int backendRetryCount = 0;

  /// 门上那行话是不是**"后端还没就绪"**这一族（①②两档）。
  ///
  /// 它同时是三件事的判据：要不要自动重探、就绪之后要不要把那句话擦掉、
  /// 以及「设置密码」那颗按钮该不该灰着（③：不能等人点了才报错）。
  bool gateWaitingBackend = false;

  /// 门前自动重探的节拍器（1 秒一格；每 [kBackendRetrySeconds] 格真去探一次）
  Timer? _backendRetry;

  /// 门上那颗主按钮**该不该灰着**：后端没起 / 还在启动时，点它没有任何意义。
  bool get gateBackendBlocked => gateWaitingBackend;

  /// 退场之后**一律不再改状态**：重连那一拍可能正好压在退场上。
  ///
  /// 为什么必须有这道闸：`ChangeNotifier.notifyListeners` 在 dispose 之后会 assert，
  /// 而重试定时器的回调里既改状态又 reinstalls 下一拍——测试收尾与真机退出窗口时
  /// 都会撞上"用了已经 dispose 的对象"。定时器本身在 [dispose] 里已经取消，
  /// 这道闸拦的是"取消之前就已经排队、正在跑"的那一拍。
  bool _disposed = false;

  Timer? _gateRetry;
  /// 服务端给的实例标识（`<host>:<port>#<数据目录哈希>`）：凭据按它分文件存
  String? instance;

  /// 服务端最近一次如实回答的"设过密码没有"（`GET /api/auth/state`）；null = 还不知道
  /// （老服务端没有这条端点 / 应答读不懂）。
  ///
  /// 它只在 401 的 `code` **缺失**时兜底：有 code 的时候，code 就是服务端当场说的那句话。
  /// 这条字段真正的用处是"界面能复核事实"——见 [bootstrap] 与 [_requireAuth]。
  bool? authInitialized;

  String dotKind = 'loading';
  String stateText = '正在连接…';
  String subText = '';

  /// **服务端给的状态旁注**（`/api/stats/dashboard.stateNote`，可以为空）。
  ///
  /// 目前只有一种内容："预算暂停已解除（turn 层）"——**已经过去的那件事的下文**。
  /// 它与 [stateText] 分工不同：状态词说当刻在干什么，旁注说昨天那句话后来怎么了。
  /// 用户 2026-10-05 报的「一直显示预算耗尽」有一半就是这条没有下文（另一半是判据，
  /// 已收到服务端的 `livePausedLayers` 一处）。
  String stateNote = '';
  ThemeMode themeMode = ThemeMode.light;

  /// **她的名字**：`persona/IDENTITY.md` 里 `名字：` 那一行的值，null = 还没读到/还没写。
  ///
  /// 界面上凡是要显示"她叫什么"的地方（窗口标题、侧栏品牌区、托盘提示、"她问你"那张卡的标题）
  /// 一律读它，读不到就按 [herDisplayName] / her_name.dart 里的口径回退——
  /// **绝不**再写死一个名字：写死意味着换个人装这个框架，界面照样管他的 agent 叫伊尔弥亚。
  ///
  /// 名字是异步读来的，所以第一帧通常还没有它（回退值先上屏，读到之后 notifyListeners 换掉）。
  String? herName;

  /// 界面上显示的名字（窗口标题、托盘提示这一族）
  String get herDisplayName => herNameOrFallback(herName);

  /// 侧栏品牌区那一个（位置窄，回退文案见 her_name.dart）
  String get herBrandLabel => herBrandName(herName);

  /// 当前页 id（默认「运行情况」）
  String pageId = defaultPageId;

  /// **当前页的重挂计数**：它进页面的 Key（见 `home.dart` 的 `_PageHost`），一加一就
  /// 整页重建 —— 等于"重新 initState、重新取数"。
  ///
  /// 谁在用：`wait_banner.dart` 那颗「重试」。它要回答的正是"某一页卡在 loading 里、
  /// 再也不动了怎么办"：页面自己那套 `loading` 标志只有它自己的 `catch` 能放掉，
  /// 而从外面**唯一**能做的就是把它重新挂一次。比"要求每一页都自己带超时"可靠得多
  /// ——后者要改六七个页面，而漏掉一页就还是永久转圈。
  int pageEpoch = 0;

  /// 把当前页整页重挂一次（「这次没回来，点重试」的落点）。
  ///
  /// 代价说清楚：页面上没提交的编辑、滚动位置会丢。所以它只挂在**人真的点了**那颗
  /// 按钮上（见 `wait_banner.dart`），不自动触发。
  void reloadCurrentPage() {
    pageEpoch += 1;
    // 「点重试」也是关键动作：卡在 loading 里时，人最后按的那一下就是这一颗
    traceInput(currentStrings.retry);
    guiLog.write('[page] reload $pageId epoch=$pageEpoch');
    notifyListeners();
  }

  int needsReview = 0;
  bool online = false;

  /// **她在思考吗**——界面这一侧唯一的判断（`gui/lib/home.dart` 的左上一行字读它）。
  ///
  /// 判据不是"进程活着"、更不是时间窗，而是**服务端自己那句话的同一个响应里的两个字段**
  /// （`/api/stats/dashboard`，判据本体在 `src/web/server.ts` 的 `deriveState`）：
  ///
  ///   · `openTurn != null`  ← 投影里有一个开着的 turn（`turn/start` 之后、`turn/end` 之前）；
  ///   · `state == 'running'` ← 当刻没有待确认、没有暂停、没有降级。
  ///
  /// 两条同时成立，服务端给的 `stateText` 就是「Agent 正在值守」（`server.ts:1477`）；
  /// 界面把它改说成「思考中」（见 [stateTextForBrand]）——**只改说法，不改判据**：
  /// 界面不自己推断她在不在想，也不拿"最近有没有事件"这种时间窗去猜
  /// （用户 2026-10-16 明确不许猜时间窗）。
  ///
  /// 事件流（[_onFeedEvent]）只能把这句话**提前**一拍说出口，不能凭空把它说成真的：
  /// 它做的只是"别等 10 秒的心跳，现在就重读一次 dashboard"。
  bool get thinking => _thinking;
  bool _thinking = false;

  /// 服务端**当次读数**里那个开着的 turn（`/api/stats/dashboard.openTurn`），没有就是 null。
  ///
  /// 它和 [thinking] 是同一份响应里的两个字段，用处不同：
  ///   · [thinking] 回答"她**正在**想吗"（还要求 `state == 'running'`）；
  ///   · 这一个回答"服务端认为**还有没有**未收尾的 turn"——`null` 就是"这一轮已经结束了"。
  ///
  /// ★ 为什么必须把它单独露出来（用户 2026-10-16 ②「待机时那个思考标志还在」）：
  /// 聊天页那行进度**只认事件**（`turn/end` 一到就收）。而事件流是会断的：SSE 重连时
  /// 断线窗口里那条 `turn/end` 补不回来（那时 `ChatPage.connectStream` 没带 `Last-Event-ID`），
  /// 于是**那一行会一直挂着**——右上那行字却能自己好，因为它的判据取自响应。
  /// 有了这一格，聊天页就能拿**服务端的话**去对账（见 `ChatPageState.reconcileThinking`），
  /// 判据仍然只有服务端一处，界面不自己编"她大概停了"。
  String? get openTurn => _openTurn;
  String? _openTurn;

  /// 左上一行字**实际显示**的那句话：她在想 ⇒「思考中」，否则照抄服务端给的 [stateText]。
  ///
  /// 为什么另开一个 getter 而不是直接改写 [stateText]：`stateText` 是服务端的原话，
  /// 它还有别的读处（总览页那张大卡、设置页那张协议卡都照抄它），那些地方该显示原话。
  /// 换说法只是**左上这一个窄位置**的事（用户 2026-10-16 ①：「左上角不要写"agent 值守中"，
  /// 要写"思考中"」），所以换在这一处，不动数据本身。
  String get stateTextForBrand => _thinking ? '思考中' : stateText;

  /// 事件流里见过 turn 的动静（`turn/start` / `step/*` / `message/reasoning` 那些），
  /// **还没被响应否掉**。
  ///
  /// 它只做一件事：决定 [_scheduleDashboardTick] 下一拍按哪一档打。**不参与 [thinking] 的判据**
  /// ——判据永远来自服务端的响应，它只是"最近这一小段有动静"的一个提示。
  bool _turnSignaled = false;
  /// [_turnSignaled] 是什么时刻被点亮的，用来让提示自己过期（见 [kTurnSignalHoldMs]）
  int _turnSignalAtMs = 0;

  /// **她在问**的那些卡（design §6）：按提问先后排好的一队，界面一次只弹队首那张（§6.3）。
  ///
  /// 空表示台面上没有她没答复的提问。卡上的字：`question`/`context` 是她的原话，
  /// 标题与按钮由界面写死（防伪）——所以这里只搬数据，不做措辞。
  ///
  /// 「稍后」是**本地**动作（不写日志、不产生决定，§6.1），服务端不知道哪几张被收起来了，
  /// 所以它给一串而不是只给队首：只给队首的话，人一按「稍后」就永远轮不到后面那几张。
  List<AskCardData> askCards = const [];
  /// 台面上还没答复的总条数（含 `askCards` 之外没下发的那几件）：左栏角标读它
  int askTotal = 0;

  /// **待批的申请单**（`GET /api/grants` 的 items，只留"她递了、还没结局"那几条，最新在最前）。
  ///
  /// 三处显示读的是**这一份**：[GrantInboxHost] 的右下角卡、`home.dart` 左侧「扩展」角标、
  /// 托盘菜单首项。判据与顺序在 `grant_inbox.dart`（一处实现），这里只存结果。
  ///
  /// 为什么抬到壳一级：那条清单本来只有扩展页的 MCP 分区在 20 秒读一次，而那一页
  /// **只有人切过去时才存在**——"她递了一张单子"于是在屏幕上没有痕迹（见 grant_inbox.dart 文件头）。
  List<Map<String, dynamic>> pendingGrants = const <Map<String, dynamic>>[];

  /// 待批几张（0 = 左侧不显示角标、托盘不摆首项）
  int get pendingGrantCount => pendingGrants.length;

  // ── 更新检查（2026-10-22）──

  /// `GET /api/update` 的现状（`UpdateInfo.fromJson` 是唯一解析点）。
  ///
  /// null = 还没读到（没进门 / 读失败）。**它不参与任何"她"的状态**：这是给用户的提醒，
  /// 与 `stateText` / `openTurn` 那些是两条线。
  UpdateInfo? updateInfo;

  /// 手动检查在飞（设置页那颗按钮显示"正在检查…"并禁用）
  bool updateChecking = false;

  /// 切通道在飞（beta/stable 分段控件禁用；服务端一次请求里写 config + 清节流 + 查一次）
  bool updateSwitching = false;

  /// 读/查失败的那句话（空 = 没问题）。**只在设置页那一行说**，不弹窗、不打扰。
  String updateError = '';

  /// 用户按过"×"的那一版（持久化在 `ui-state.json`；见 [kUpdateDismissedVersionFlag]）
  String updateDismissedVersion = '';

  /// 顶部提醒条要不要显示：有值得提示的版本，且（必须升级 或 这一版没被关过）
  bool get showUpdateBanner {
    final info = updateInfo;
    if (info == null || !info.enabled || !info.hasUpdate) return false;
    if (info.required) return true;
    return updateDismissedVersion != info.latestVersion;
  }

  /// 读回"关掉的是哪一版"（启动时一次；读不到就是空串）
  Future<void> restoreUpdateDismissed() async {
    final saved = await loadString(kUpdateDismissedVersionFlag);
    if (_disposed) return;
    updateDismissedVersion = saved ?? '';
    notifyListeners();
  }

  /// 读一次更新现状（进门时一次 + 事件流说"查过了"时再读一次）。
  ///
  /// 它**不产生任何外部请求**：`GET /api/update` 只读服务端已经落好的状态；
  /// 真正去查的那一下只有服务端的 12h 定时器与设置页那颗按钮。
  Future<void> refreshUpdate() async {
    if (_disposed || !ready) return;
    try {
      final parsed = UpdateInfo.fromJson(await api.get('/api/update'));
      if (_disposed) return;
      updateInfo = parsed;
      updateError = parsed == null ? 'unexpected /api/update response' : '';
    } catch (err) {
      if (_disposed) return;
      // 401 的统一自愈在 [bootstrap] 那条链上；这里只留一句给设置页显示
      updateError = '$err';
    }
    notifyListeners();
  }

  /// 设置页的「检查更新」：**手动检查无视 12h/24h 节流**（服务端那边定的语义）。
  Future<UpdateInfo?> checkUpdateNow() async {
    if (_disposed || !ready || updateChecking) return updateInfo;
    if (updateInfo?.enabled == false) return updateInfo;
    updateChecking = true;
    updateError = '';
    notifyListeners();
    try {
      final raw = await api.post('/api/update/check', const <String, dynamic>{});
      final view = raw is Map ? raw['view'] : null;
      final parsed = UpdateInfo.fromJson(view);
      if (_disposed) return updateInfo;
      if (parsed != null) updateInfo = parsed;
      updateError = parsed == null ? 'unexpected /api/update/check response' : '';
    } catch (err) {
      if (!_disposed) updateError = '$err';
    } finally {
      if (!_disposed) {
        updateChecking = false;
        notifyListeners();
      }
    }
    return updateInfo;
  }

  /// 切通道（`POST /api/update/channel`）：服务端**只写 `update.channel` 这一格**
  /// （保注释、写后 loadConfig 复核 + 回读对拍、失败回滚），然后清节流并立刻查一次；
  /// 响应里已经把 `view` 带回来，所以界面这一侧只需要收下它，不必再 GET 一次。
  ///
  /// 返回 false 的原因分两种：请求失败（`updateError` 有原话）或响应形状不对。
  Future<bool> switchUpdateChannel(String channel) async {
    if (_disposed || !ready || updateSwitching) return false;
    if (channel != 'beta' && channel != 'stable') return false;
    if (updateInfo?.enabled == false) return false;
    updateSwitching = true;
    updateError = '';
    notifyListeners();
    try {
      final raw = await api.post('/api/update/channel', <String, dynamic>{'channel': channel});
      final view = raw is Map ? raw['view'] : null;
      final parsed = UpdateInfo.fromJson(view);
      if (_disposed) return false;
      if (parsed != null) updateInfo = parsed;
      updateError = parsed == null ? 'unexpected /api/update/channel response' : '';
      return parsed != null;
    } catch (err) {
      if (!_disposed) updateError = '$err';
      return false;
    } finally {
      if (!_disposed) {
        updateSwitching = false;
        notifyListeners();
      }
    }
  }

  /// 关掉顶部那条提醒（`required` 不理会：那条不可关，判据与 [UpdateBanner] 同源）
  Future<void> dismissUpdateBanner() async {
    final info = updateInfo;
    final latest = info?.latestVersion;
    if (info == null || latest == null || info.required) return;
    updateDismissedVersion = latest;
    notifyListeners();
    await saveString(kUpdateDismissedVersionFlag, latest);
  }

  /// 读待批清单的那条轮询（与这个 AppState 同一条命：进门起、回门停、退场收）
  PendingGrantPoller? _grantPoller;

  /// 读一次 dashboard 的**下一拍**（不是 `Timer.periodic`：它读的间隔要在每一拍之后重算——
  /// 她开始想的时候立刻降到 [kTurnReadMs]，停下来之后回到 [kOnlinePollSeconds]）。
  ///
  /// 为什么不用两条周期定时器来回切：切换点必须长在"这一拍的结果"上（`openTurn`），
  /// 而两个 `Timer.periodic` 互切至少要记得两处取消，漏一处就是"两条心跳同时打"。
  /// 全 app 就这一条读 dashboard 的链（[startPolling] 起点、[logout]/[dispose]/[_requireAuth]
  /// 收口）——原来那种"10 秒 periodic + 另起一条快档"是两条链打同一个端点。
  Timer? _dashboardTick;

  /// 事件流的订阅（`GET /api/events/stream`）。与日志页/聊天页同一条端点，换个住处而已。
  StreamSubscription<Map<String, dynamic>>? _eventsSub;
  /// 事件流断了之后重连的那一拍
  Timer? _eventsRetry;
  /// 真的收过至少一条事件 = 这条链路**验证过**是通的（决定快档用 250ms 还是宽限档 3 秒）
  bool _eventsLive = false;
  /// 合并窗口的那一拍
  Timer? _turnReadTimer;

  // ── 进门：探测 → 读凭据 → 设密码 / 登录 ──

  /// 启动握手：先问"这台实例是什么状态"，再决定画哪一态、以及去哪个文件读凭据。
  ///
  /// **顺序不能反**——实例标识里含**数据目录的哈希**，那是只有服务端才知道的事实；
  /// 而凭据按实例分文件存（这正是"第二个实例把第一个顶掉"那个坑的根治点）。
  /// 所以第一趟必须空手打，从 401 的响应体里把 `instance` 与 `code` 读回来。
  ///
  /// 门该画哪一态，则**先读公开的事实**（`GET /api/auth/state`，不需要凭据），读不到才用
  /// 401 的 `code` 兜底。2026-10-23 之前只有 code 一条路，于是：探测那一次的 message 会被
  /// 当成红字显示；服务端状态在别处变了（密码在另一个进程里设上、或凭据文件被重命名重置），
  /// 界面也没有第二个地方可以复核——它停在一扇"设置密码"门的后面，提交却永远 409。
  ///
  /// [fromPicker] 为真 = 这一趟是**选择页那一行按下**发起的（盘上有这一台的票）：
  /// 那么"票被服务端判了 401"的落点就不是密码门，而是**回到选择页**——那一行的按钮变
  /// 「登录」，上面留一行"登录状态已失效"（见 [pickerSessionExpired]）。理由：人是点
  /// 那一行进来的，票不作数这件事属于那一行；把他推到密码门后面，他还会以为"整台界面把
  /// 我踢出来了"。没有票的那条路（[fromPicker] 为假）照旧进密码门——那本来就是要密码的。
  Future<void> bootstrap({bool fromPicker = false}) async {
    // 这一趟是谁发起的都无所谓（首屏、重试那一拍、还是人按的那颗「立即重试」），
    // 它只负责把**手上这一拍**打出去：先把待发的那条定时器收掉（这一拍马上就发，
    // 留着它只会多打一次），计数 +1，回到"正在连接"那一屏。
    //
    // 这里**不动门卡上那句话**（[gateError] / [gateUnreachable]）：措辞归
    // [_onConnectFailure] 与 [_tickGate] 管。曾经在这一趟里把两句清掉，后果是降级之后
    // 每一拍都先把"确认主进程在运行"擦掉、失败之后再写回来——卡片每隔几秒在中性与错误话
    // 之间来回跳（真机上一条连接失败要一两秒，跳得更明显）。
    _gateRetry?.cancel();
    _gateRetry = null;
    // 每一拍都先看一眼端口文件（后端起来时会写它）：只采纳"文件"这一档，见 [_adoptPortFromFile]
    _adoptPortFromFile();
    gateAttempt += 1;
    gate = AuthGateKind.checking;
    ready = false;
    notifyListeners();

    // ① 空手探一次。这一趟要的不是数据，是**状态码里的人话**。
    String? code;
    try {
      await api.get('/api/projection');
      // 服务端居然没要凭据：不可能（除非有人在改认证）。当成已进门，别把人卡在门外。
      _markGateOpen();
      ready = true;
      startPolling();
      notifyListeners();
      return;
    } on ApiAuthError catch (err) {
      code = err.code;
      instance = err.instance ?? api.instance;
    } on ApiError catch (err) {
      // 服务端**答了话**：分两种。
      //   · `starting`（503 + `{starting:true,phase}`）——端口在听、重活没干完。**它不是错误**：
      //     后端现在先 bind 再折事件（35–42 秒），这一档恰恰说明"它正在起"，所以按连接类
      //     失败处理（中性话 + 自动重试），别把"还在启动"画成一张红卡；
      //   · 其余 4xx/5xx——它在那并且说不行，不会随时间自己好，当场说话。
      _onConnectFailure(err, connection: err.starting);
      return;
    } catch (err) {
      _onConnectFailure(err, connection: true);
      return;
    }

    // ② 按实例标识去读**自己那份**凭据（全局路径那个坑就是在这里被绕开的）
    final key = instance;
    final stored = key == null ? null : sessions.read(key);
    if (stored != null) {
      api.token = stored;
      try {
        await api.get('/api/projection');
        _markGateOpen();
        ready = true;
        gateError = '';
        gateHint = AuthGateHint.none;
        _onLegacyToken = false;
        authInitialized = true;
        startPolling();
        notifyListeners();
        return;
      } on ApiAuthError catch (err) {
        code = err.code;
        instance = err.instance ?? instance;
      } on ApiError catch (err) {
        // `starting` 与"连接类"同一条处置（后端在起，不是这条路坏了），其余照旧当场说话
        _onConnectFailure(err, connection: err.starting);
        return;
      } catch (err) {
        _onConnectFailure(err, connection: true);
        return;
      }
      // 这张票已经**证明**不作数了：从盘上清掉。留着只会让每次开界面都白跑一趟，
      // 也让下面的"自愈重读"每次都拿到同一张废票。
      final current = instance;
      if (current != null) sessions.clear(current);
      if (fromPicker) {
        // 选择页那行进来的：**留在选择页**（该行按钮变「登录」+ 一行轻提示），
        // 不把人推到密码门后面——票不作数这件事属于那一行（见 [bootstrap] 的文档）。
        _resetForGate(withToken: true);
        gate = AuthGateKind.picker;
        pickerSessionExpired = current ?? key ?? '';
        pickerProblem = InstanceGateProblem.none;
        pickerProblemDetail = '';
        stateText = '';
        notifyListeners();
        // 那一行的按钮要跟着变（这一份 token 已经不在盘上了）
        unawaited(refreshInstances());
        return;
      }
    }

    // ②.5 问一次**公开的事实**：这台实例到底设过密码没有（`GET /api/auth/state`）。
    //
    // 这是 2026-10-23 那场死锁的修复点：门的判据不能再只靠 401 的 `code`。两条理由——
    //   · 那条通道把"分流信号"与"错误播报"混在一起，探测结果会被当红字显示；
    //   · 它没有复核通道。服务端的状态可能在别处变了（密码在另一个进程里设上、`.auth.json`
    //     被重命名做重置），而界面若已经停在某一扇门上，就再没有任何机会发现判据过期了。
    //     现场就是：门上是"设置密码"，实例其实有密码 ⇒ 提交 409 ⇒ 表单永远失败 ⇒ 进不去。
    //
    // 读不到（老服务端没有这条端点）时 [authState] 回 null，此时**才**退回 401 的 code 分流。
    bool? serverInitialized;
    try {
      serverInitialized = await api.authState();
    } catch (err) {
      // 连接类失败：服务端不在。与前面几次探测同一条处置（门前那套自动重连）
      _onConnectFailure(err, connection: true);
      return;
    }
    authInitialized = serverInitialized;
    // 判据只认事实：state 说"没有密码"才算待初始化；问不出来时才看 401 的 code。
    final uninitialized = serverInitialized == false
        || (serverInitialized == null && code == 'auth-uninitialized');

    // ③ 还没设密码：先试一次**老界面那份全局凭据**（升级期的兜底，见 session_store.dart）。
    // 为什么值得留着这条路：后端口径换了、界面也换了的时候，人手上唯一还有效的东西就是它；
    // 没有它，界面会停在"设置密码"那一屏——设一个当然也能进，但那等于用升级把人挡在门外一次。
    // 它只在"服务端说还没设密码"时才有意义：设过密码之后旧 token 当场作废，试也白试。
    if (uninitialized) {
      final legacy = readLegacyGuiToken();
      if (legacy != null) {
        api.token = legacy;
        try {
          await api.get('/api/projection');
          _markGateOpen();
          ready = true;
          gateError = '';
          gateHint = AuthGateHint.none;
          _onLegacyToken = true;
          // 旧 token 只在还没设密码时有效：这条事实同时是"以后该补设一个密码"的判据
          authInitialized = false;
          // 提醒一次"该设密码了"（按过「以后再说」就不再打扰）。
          // `loadFlag` 是三态：这里**未知也要提醒**（读不到状态文件时，提醒一次是安全的一侧；
          // 与引导判据"未知不弹"相反，因为"提醒设密码"漏掉比多提醒一次代价大）。
          needsPasswordPrompt = (await loadFlag(kPasswordPromptDoneFlag)) != true;
          startPolling();
          notifyListeners();
          return;
        } on ApiAuthError {
          // 旧凭据也不作数了（或本来就是坏的）：继续走"设置密码"，这不是错误
        } on ApiError catch (err) {
          _onConnectFailure(err, connection: err.starting);
          return;
        } catch (err) {
          _onConnectFailure(err, connection: true);
          return;
        }
        api.token = null;
      }
    }

    _onLegacyToken = false;
    api.token = null;
    // 走到这里说明**服务端答话了**（要么"还没设密码"、要么"这张票不作数"）：
    // 门前那套"等它起来"的重连该收掉了（门现在是登录/设密码态，不再是等待态）
    _markGateOpen();
    // 门只按**事实**画：待初始化 → "设置密码"；其余一律登录态。判据见上面 `uninitialized`
    // （公开的 state 优先，老服务端才退回 401 的 code）。
    gate = uninitialized ? AuthGateKind.setup : AuthGateKind.login;
    // 探测用的那条 401 是**分流信号，不是错误**：它不进红字那一行（本来就是清的，
    // 写出来是为了把这条纪律钉在代码里）。
    gateError = '';
    gateHint = AuthGateHint.none;
    notifyListeners();
  }

  /// 门开了（任何一条进门的路走通时都调它）：把"门前重连"那一套**全部**收掉。
  ///
  /// 为什么必须收：慢速重试定时器是活的、不受 `ready` 管的——忘了取消它，进壳之后
  /// 它还会每分钟打一次握手（而壳里已经有自己的心跳了，见 [startPolling]），
  /// 表现是"状态句偶尔莫名跳一下"。计数与秒数也一起归零：门再出现时该从第 1 次开始数。
  void _markGateOpen() {
    _gateRetry?.cancel();
    _gateRetry = null;
    // 门前那条"等后端就绪"的节拍器同一条命：进了壳就没有"门上的提示"可言了
    _clearBackendWait();
    // **恢复的那一行**（2026-10-26）：排障时要能从日志里读出"等的是哪个端口、等了多久才通"。
    // 验收那一趟用的就是这两行：`[net] waiting backend port=… source=…` → 这一行。
    if (gateRetrying || gateAttempt > 0) {
      _netLog('[net] backend ready port=$backendPort source=${backend.sourceLabel}'
          ' attempts=$gateAttempt waited=${gateWaited}s');
    }
    gateAttempt = 0;
    gateWaited = 0;
    gateRetrying = false;
    gateUnreachable = false;
    guiLog.write('[gate] open (shell)');
  }

  /// 写一行 `[net]` 日志（真机进 `%LOCALAPPDATA%\Irmia\gui.log`；用例里也能接走，见 [netLogSink]）
  void _netLog(String line) {
    guiLog.write(line);
    netLogSink?.call(line);
  }

  /// **测试注入点**：把 `[net]` 那几行也递给用例（真机上没人设它，日志仍走 `gui.log`）。
  ///
  /// 为什么需要：`guiLog` 是全局单例、要在用例里 attach 才写盘，而 attach 会顺带把
  /// 卡顿看门狗那条 isolate 也拉起来（见构造函数）——为了一行日志把 isolate 起起来不划算。
  @visibleForTesting
  void Function(String line)? netLogSink;

  /// 重试前重读一次端口文件：**只采纳"文件"这一档**（后端 bind 成功那一刻写的那个端口）。
  ///
  /// 三条分寸：
  ///   · 只在解析结果是 `file` 且端口与当前不同时才切换——重试途中绝不退回环境变量/默认值
  ///     （那正是事故那天把界面带到 1580 的路）；后端退出时文件被删掉，这里读到 null，
  ///     于是**继续等原来那个端口**，行为不变；
  ///   · 切换时同步改 `api.baseUrl`（下一条请求立刻打到新端口）；
  ///   · 记一行日志：`[net] port switched …`——"界面自己换了端口"这种事事后必须查得到。
  void _adoptPortFromFile() {
    final resolver = backendPortResolver;
    if (resolver == null) return;
    final fresh = resolver();
    if (fresh.source != BackendPortSource.file) return;
    if (fresh.port == backend.port) {
      backend = fresh; // 端口没变，但 pid/since 可能是新的一份（换实例了）
      return;
    }
    final previous = backend.port;
    backend = fresh;
    api.baseUrl = 'http://127.0.0.1:${fresh.port}';
    _netLog('[net] port switched from=$previous to=${fresh.port} source=file'
        '${fresh.pid == null ? '' : ' pid=${fresh.pid}'}');
  }

  /// 这次是**凭老凭据**进来的（服务端还没设密码）。
  ///
  /// 界面据此做一件事：提醒人**现在设一个密码**。不提醒的话，这条路会一直能用，
  /// 而"首次启动要人设密码"就永远没人去设——升级期一过，这件事就烂在那儿了。
  bool get onLegacyToken => _onLegacyToken;
  bool _onLegacyToken = false;

  /// 要不要弹"该设密码了"那张卡（老凭据进门、且没被按过「以后再说」）
  bool needsPasswordPrompt = false;

  /// 「以后再说」：记下来，不再打扰（与"更多"折叠组、引导同一份 ui-state.json）
  void dismissPasswordPrompt() {
    needsPasswordPrompt = false;
    unawaited(saveFlag(kPasswordPromptDoneFlag, true));
    notifyListeners();
  }

  /// 「现在设置」：回到那道门上的设密码态。
  ///
  /// 为什么是"回到门上"而不是弹一个自己的表单：设密码这件事只有一处实现
  /// （`auth_gate.dart` 的 `_SetupForm`：两次输入校验、密码太短的人话、遮蔽、回车提交），
  /// 再抄一份迟早会跟它长得不一样。代价只是壳先收起来一下。
  void openPasswordSetup() {
    needsPasswordPrompt = false;
    ready = false;
    gate = AuthGateKind.setup;
    // 这条路的唯一入口是"凭老 token 进来的"（那台实例确实还没有密码），顺手把事实记准
    authInitialized = false;
    gateError = '';
    gateHint = AuthGateHint.none;
    notifyListeners();
  }

  /// 改密码（设置页「账号与安全」里那件事）：**旧密码 + 新密码**。
  ///
  /// 端点是 `POST /api/auth/password`，字段口径照服务端：新的叫 `password`、旧的叫 `oldPassword`。
  /// 服务端成功时会**把全部旧会话作废、当场签发一条新的**——所以这一趟必须把新凭据**就地
  /// 换上来**（`api.token` 与盘上那份都换）：不换的话，返回壳里第一条心跳就是 401，
  /// 人刚改完密码就被踢回门上，而他什么都没做错。
  ///
  /// 返回值：成功 = null；失败 = **一句人话**（服务端那句话照原样，与门上的登录同一条纪律——
  /// "当前密码不对"这种话只有服务端说得准）。走 `postAuth`：认证端点的 401 是"你给的密码不对"，
  /// 不是"你的票旧了"，**不能**让它触发 401 自愈（拿旧票重放一次登录请求毫无意义，
  /// 还会把登录退避白推高一格）。
  ///
  /// 两次输入一致与否**不在这里判**：那需要同时看到两个框的内容，是表单自己的规矩
  /// （见 account_security.dart 的对话框）；这里判的是"值本身合不合法"，
  /// 与服务端 `PASSWORD_MIN_LEN` 同一条下限（客户端校验是体验，真正的判据永远在服务端）。
  ///
  /// 半升级态（凭老那份共享 token 进来的会话）改不了密码：服务端对那条路回
  /// 409 legacy-token（"它没有会话可换"），那句话照原样回去显示，人就知道该先去设密码——
  /// 对话框把这条出路也写在明面上（见 `_AccountDialog` 顶部那段）。
  Future<String?> changePassword(String oldPassword, String newPassword) async {
    if (oldPassword.isEmpty) return '请输入当前密码。';
    if (newPassword.length < kPasswordMinLength) {
      return '新密码至少 $kPasswordMinLength 位（现在 ${newPassword.length} 位）。';
    }
    try {
      final result = await api.postAuth('/api/auth/password', {
        'oldPassword': oldPassword,
        'password': newPassword,
        'label': 'gui',
      });
      final token = result is Map ? result['token'] : null;
      final reported = result is Map ? result['instance'] : null;
      if (reported is String && reported.isNotEmpty) instance = reported;
      if (token is! String || token.trim().isEmpty) {
        // 凭据没换到手 = 下一步一定是 401：如实说清，并且提醒出路（重新登录一次）
        return '服务端没有返回新的会话凭据，请重新登录一次。';
      }
      final value = token.trim();
      api.token = value;
      final key = instance;
      if (key != null) sessions.write(key, value);
      notifyListeners();
      return null;
    } on ApiAuthError catch (err) {
      // 服务端的话最准（"当前密码不对。"）：照原样显示
      if (err.instance != null) instance = err.instance;
      return err.message;
    } on ApiError catch (err) {
      return err.message;
    } catch (err) {
      return '连不上本地服务：$err';
    }
  }

  /// **关掉这个实例**（用户 2026-10-27 的口径：「为什么要作废会话？不能就留在那，
  /// 如果登回来了就接着吗？」）。
  ///
  /// 三步，**顺序不许换**：
  ///   ① `POST /api/commands/stop-instance`（`X-Confirm: stop-instance`）—— 让后端
  ///      **优雅退出**（停源 → 关 web → `session/end` → 放锁，**不重启**）；
  ///      这一步失败 ⇒ **退化为按端口强停**（`backend_stop.dart` 那一套），并如实记
  ///      `stop=killed`——硬杀丢什么写在那个文件头里，日志必须看得出来这次是硬杀；
  ///   ② 等端口消失（≤ [kInstanceStopTimeoutSeconds] 秒）——"真的停了"的唯一读数；
  ///   ③ 回**实例选择页**，而**本机那份会话凭据留在原处**
  ///      （`%APPDATA%\Irmia\sessions\<实例标识>`，跨界面重启也在）。
  ///
  /// 与 [logout] 的差别只有一件事——**谁动凭据**：这条路**不作废、不清**。
  /// 为什么不作废：那张票是"这台实例认得出我"的唯一凭据，而关掉实例只是让它**别跑了**。
  /// 作废掉的话，从选择页点回来必然要重新输密码——而人能证明自己是同一个人（盘上那张票
  /// 与关掉之前一模一样）。"保留"也不引入新的暴露面：它本来就存在那儿（[SessionStore]）。
  ///
  /// 留一行现场：`[life] close instance=<名字> stop=graceful|killed waited=Ns token=kept`。
  /// `token=kept` 是**反向**的那一格：见到 `token=cleared` 才是 [logout]（凭据没了）。
  Future<void> closeInstance() async {
    final port = backendPort;
    final name = _instanceNameForLog();
    // 这一台的实例标识与数据目录：凭据文件**不碰**，但数据目录要记住
    // （关掉之后"新建实例"的默认目录按它的父目录算，见 [defaultInstanceDir]）
    final known = instance == null ? null : InstanceBook.load().byId(instance);
    if (known != null) _lastKnownDataDir = known.dataDir;
    // ① 优雅停机；失败就退化为按端口强停（并如实记下来）
    final stop = await _stopBackendNow(port);
    // ② 等端口消失（≤20 秒）
    final waited = await _awaitPortGone(port);
    _lifeLog('[life] close instance=$name stop=$stop waited=${waited}s token=kept');
    // ③ 回选择页。只清**内存**里那张票与壳里的状态；盘上那一份是这条路的全部意义，留着。
    _resetForGate(withToken: true);
    gate = AuthGateKind.picker;
    // 状态词只在壳里显示；选择页那一屏不读它（那一页的话全在 `instance_picker.dart`）
    stateText = '';
    pickerSessionExpired = '';
    pickerProblem = InstanceGateProblem.none;
    pickerProblemDetail = '';
    notifyListeners();
    // 列表要现读一次：刚停掉的那台现在显示"未运行"（有票 ⇒ 按钮变「启动并进入」），
    // 别的实例的活/死也可能变了
    unawaited(refreshInstances());
  }

  /// 停掉这一台的后端（[closeInstance] 与 [logout] 共用那两步，顺序与退化路径只有一份）。
  ///
  /// 返回 `graceful` / `killed`——它进 `[life]` 那行日志，是"这次停得干不干净"的唯一读数。
  /// 两条路失败都**不抛**：停不干净这件事必须如实记下来，但它不该挡住"回选择页"这一步
  /// （停在壳里是对着一片已经死掉的数据，比看见"未运行"糟得多）。
  Future<String> _stopBackendNow(int port) async {
    try {
      await api.post(
        kStopInstancePath,
        const <String, dynamic>{},
        confirm: kStopInstanceCommand,
      );
      return 'graceful';
    } catch (err) {
      guiLog.write('[life] stop-instance failed port=$port error=$err -- falling back to kill-by-port');
      try {
        await instances.killPort(port);
      } catch (killErr) {
        guiLog.write('[life] kill-by-port failed port=$port error=$killErr');
      }
      return 'killed';
    }
  }

  /// **彻底登出**（安全出口：换机器、借人用过、怀疑票泄露时走它）。
  ///
  /// 三步，**顺序不许换**：
  ///   ① `POST /api/auth/logout` —— 作废这个实例的会话（票在服务端真的不认了；
  ///      这一步失败也继续走：一张废票不该挡住"停掉它"）；
  ///   ② `POST /api/commands/stop-instance`（`X-Confirm: stop-instance`）—— 同 [closeInstance]；
  ///   ③ 等端口消失（≤20 秒）→ **清掉本地那份会话 token** → 进**实例选择页**。
  ///
  /// 为什么②能拿到凭据：①刚把这张票作废，而②仍接受"本实例刚刚自己注销的那张票"
  /// （服务端 60 秒宽限，见 `src/web/server.ts` 的 `recentlyLoggedOut`）。没有那一条，
  /// "优雅结束实例"永远只能退化成硬杀。
  ///
  /// 与 [closeInstance] 的唯一差别就是**第③步清不清凭据**：这里清（`token=cleared`），
  /// 那里留（`token=kept`）。两条路的日志逐格同形，排障时一眼分得清是哪一次。
  Future<void> logout() async {
    final port = backendPort;
    final name = _instanceNameForLog();
    // 这一台的实例标识与数据目录：下面要清**它自己**那份凭据文件，也要记住数据目录
    // （登出之后"新建实例"的默认目录要按它的父目录算，见 [defaultInstanceDir]）
    final key = instance;
    final known = key == null ? null : InstanceBook.load().byId(key);
    if (known != null) _lastKnownDataDir = known.dataDir;
    // ① 作废会话（失败静默：本地登出照样成立，见上）
    try {
      await api.postAuth('/api/auth/logout', {'label': 'gui'});
    } catch (_) {
      // 撤销没成功也不影响"本地登出"这件事——票已经没人再用了
    }
    // ② 优雅停机；失败就退化为按 pid 强停（并如实记下来）
    final stop = await _stopBackendNow(port);
    // ③ 等端口消失（≤20 秒），再清本地凭据
    final waited = await _awaitPortGone(port);
    _lifeLog('[life] logout instance=$name stop=$stop waited=${waited}s token=cleared');
    // 盘上那一份**这一台**的凭据要清掉（"登出之后界面还能自己进去"才是真的问题）。
    // 先清文件、再清内存：反过来的话上面那次 `sessions.clear(key)` 就找不到 id 了。
    if (key != null) sessions.clear(key);
    _resetForGate(withToken: true);
    // 回到**实例选择页**（不是登录页：登出之后要选一台实例，或者新建一台）
    gate = AuthGateKind.picker;
    // 状态词只在壳里显示；选择页那一屏不读它（那一页的话全在 `instance_picker.dart`）
    stateText = '';
    pickerSessionExpired = '';
    pickerProblem = InstanceGateProblem.none;
    pickerProblemDetail = '';
    notifyListeners();
    // 列表要现读一次：刚停掉的那台现在显示"未运行"，别的实例的活/死也可能变了
    unawaited(refreshInstances());
  }

  /// 「忘记凭据」（选择页每行那行小字）：**只清本机这一份 token**。
  ///
  /// 三个动作的分界（各自独立，别混）：
  ///   · **关掉实例**（[closeInstance]）—— 后端停，凭据**留着**；
  ///   · **忘记凭据**（这里）—— 凭据清掉，后端**照跑**、登记表条目照留（下次进来要密码）；
  ///   · **彻底登出**（[logout]）—— 作废 + 清凭据 + 停后端，三件一起（安全出口）。
  ///
  /// 返回 false = 本来就没有这一份（没什么可忘的）；页面据此决定要不要报一句话。
  Future<bool> forgetCredential(InstanceEntry entry) async {
    final had = sessions.read(entry.id) != null;
    sessions.clear(entry.id);
    if (pickerSessionExpired == entry.id) pickerSessionExpired = '';
    _lifeLog('[life] forget instance=${entry.name} token=cleared stop=none');
    notifyListeners();
    await refreshInstances();
    return had;
  }

  // ─────────────────────────── 实例：登记表 / 选择页 ───────────────────────────

  /// 登记表读出来的条目（选择页的全部内容）
  List<InstanceEntry> instancesList = const <InstanceEntry>[];

  /// 读盘/判活在飞（页面显示"正在读实例…"并禁用按钮）
  bool instancesLoading = false;

  /// 登记表读得出来吗（false = 文件不在 / 坏了：页面照实说，不假装"一个实例都没有"）
  bool instancesReadable = false;

  /// 登记表文件**根本不在**（"第一次用"那一档；与"有文件但读坏了"分开说）
  bool instancesMissing = false;

  /// 逐条判活的结果（id → 在跑吗）。**问得通才算在跑**（见 `instances.dart` 的 InstanceProbe）
  Map<String, bool> instancesRunning = const <String, bool>{};

  /// 逐条"本机有没有这一台的凭据"（id → 盘上那份 token 在不在）。
  ///
  /// 选择页那几种按钮的**唯一判据**（2026-10-27）：有票 ⇒ 点一下直接进（「进入」/「启动并进入」）；
  /// 没票 ⇒ 走密码门（「登录」/「启动并登录」）。为什么把它算成一份快照（而不是每次 build
  /// 现读盘）：按钮的含义必须与"点下去会发生什么"一致，而一次重建去读 N 个文件是白花的 I/O。
  /// 刷新点只有一处（[refreshInstances]，它本来就在每次回到选择页 / 每个动作之后跑）。
  Map<String, bool> instancesToken = const <String, bool>{};

  /// 这一台在本机**有没有登录凭据**（选择页按钮的判据，见 [instancesToken]）
  bool hasTokenFor(InstanceEntry entry) => instancesToken[entry.id] == true;

  /// 上一次「进入」被服务端判了 401 的那一台（id）；空 = 没有这回事。
  ///
  /// 选择页据此留一行轻提示（"登录状态已失效，需要重新登录"）——它不是错误卡：
  /// 票过期是**正常会发生的**事（改过密码、在别处退出登录、清了 %APPDATA% 的那一份），
  /// 该做的是把那一行的按钮换成「登录」，而不是弹一句红字让人猜。
  String pickerSessionExpired = '';

  /// 选择页正在忙的那一台（`''` = 新建流程；null = 空闲）
  String? pickerBusyId;

  /// 选择页上一次失败的**种类**（页面按它取这个语言的那句话；句子不在状态层拼）
  InstanceGateProblem pickerProblem = InstanceGateProblem.none;

  /// 上一次失败的**细节**（端口号 / 服务端原文）——它是数据，不是句子
  String pickerProblemDetail = '';

  /// 新建表单："这个目录已存在且非空"的那条路径（空 = 没有冲突）。
  ///
  /// 页面据此显示两个动作：换一个名字，或者「用这个目录」。**不自动覆盖**任何目录。
  String createDirConflict = '';

  /// 这一趟新建/启动选中的端口（页面上那句 `127.0.0.1:7789` 读它）
  int? pickerPort;

  // ── 选择页那次「启动并进入」正在等它就绪（2026-10-28） ──
  //
  // 原来只有一句"正在启动…"加一个 180 秒的死等：**不说等了多少、不说它到哪一步**，
  // 超时之后也只说"超时"。人既没法判断"它是不是卡住了"，也没法叫停。
  // 现在这三格撑起那一行读数与那颗「停止等待」。

  /// 正在等一台实例就绪（选择页那一行在转，旁边有一颗「停止等待」）
  bool pickerWaiting = false;

  /// 这一趟已经等了多久（秒）
  int pickerWaitSeconds = 0;

  /// 后端自己报的阶段（`/api/health` 的 phase，原样；空 = 这一版不报 / 问不到）
  String pickerWaitPhase = '';

  /// 人按了「停止等待」（[cancelPickerWait]）：那一趟循环下一次醒来就收工
  bool _pickerWaitCancelled = false;

  /// 最近一次见到的**数据目录**（当前实例那条 / 上一条登出的那条）。
  ///
  /// 只用一件事：给"新建实例"算默认目录——`<它>\..\instances\<名字>`（见 [defaultInstanceDir]）。
  /// 它不是凭据、不是配置，丢了也只是让人手填一次路径。
  String? _lastKnownDataDir;

  /// 一个已知的数据目录（当前实例 → 上次见过的那条 → 默认实例 → 任意一条）；都没有 ⇒ ''
  String get knownDataDir {
    final id = instance;
    if (id != null) {
      final current = InstanceBook.load().byId(id);
      if (current != null && current.dataDir.trim().isNotEmpty) return current.dataDir;
    }
    final remembered = _lastKnownDataDir;
    if (remembered != null && remembered.trim().isNotEmpty) return remembered;
    final book = InstanceBook.load();
    for (final entry in book.entries) {
      if (entry.isDefault) return entry.dataDir;
    }
    if (book.entries.isNotEmpty) return book.entries.first.dataDir;
    return '';
  }

  /// 新建实例的**默认数据目录**（页面那个输入框的初值）
  String defaultInstanceDir(String name) {
    final root = instancesRootOf(knownDataDir);
    return instanceDirUnder(name, root: root);
  }

  /// 日志里的实例名字：登记表里当前那台 → 列表里那台 → 她的名字 → 端口
  String _instanceNameForLog() {
    final id = instance;
    if (id != null) {
      final entry = InstanceBook.load().byId(id);
      if (entry != null) return entry.name;
      for (final row in instancesList) {
        if (row.id == id) return row.name;
      }
    }
    final name = herName;
    if (name != null && name.trim().isNotEmpty) return name.trim();
    return 'port$backendPort';
  }

  /// `[life]` 那一族日志（真机进 gui.log；用例里也能接走，见 [lifeLogSink]）
  void _lifeLog(String line) {
    guiLog.write(line);
    lifeLogSink?.call(line);
  }

  /// **测试注入点**：把 `[life]` 那几行也递给用例（真机上没人设它，日志仍走 `gui.log`）。
  @visibleForTesting
  void Function(String line)? lifeLogSink;

  /// 现读一次登记表 + 逐条判活。**绝不抛**（读不到就是"读不到"，见 [instancesReadable]）。
  ///
  /// 判活是**并行**的（每台 2 秒上限）：一台卡住不该让别的等它；六台实例串行最坏 12 秒，
  /// 而选择页是"人登出之后马上要看的东西"。
  Future<void> refreshInstances() async {
    instancesLoading = true;
    pickerProblem = InstanceGateProblem.none;
    pickerProblemDetail = '';
    // 先把通知推到这个 build 之后：选择页在 `initState` 里就调它，而 `initState` 里
    // `notifyListeners()` 会撞上 "setState() called during build"（那一帧还没画完）。
    // 一个 microtask 就够：build 是同步的，它跑完才会回到事件循环。
    await Future<void>.microtask(() {});
    if (_disposed) return;
    notifyListeners();
    final book = InstanceBook.load();
    final entries = book.entries;
    final running = <String, bool>{};
    // 逐条"本机有没有这一台的票"：与判活一起算完，页面那一帧就拿得到全部判据
    final tokens = <String, bool>{};
    for (final entry in entries) {
      tokens[entry.id] = sessions.read(entry.id) != null;
    }
    if (entries.isNotEmpty) {
      final probes = await Future.wait(entries.map((entry) async {
        if (!entry.hasPort) return null;
        final probe = await instances.probe(entry.host, entry.port);
        // id 对不上 = 那个端口上是**另一台**实例（换过数据目录、或端口被占）：按没在跑处理
        return probe != null && probe.matches(entry) ? probe : null;
      }));
      for (var i = 0; i < entries.length; i += 1) {
        running[entries[i].id] = probes[i] != null;
      }
    }
    instancesLoading = false;
    instancesReadable = book.readable;
    instancesMissing = book.missing;
    instancesList = List<InstanceEntry>.unmodifiable(entries);
    instancesRunning = Map<String, bool>.unmodifiable(running);
    instancesToken = Map<String, bool>.unmodifiable(tokens);
    notifyListeners();
  }

  /// 选一台实例：没在跑就先**拉起来**，然后切过去、进它的门（有票就直接进壳 / 没票就登录）。
  ///
  /// "切过去"这一下是本功能的**隔离判据**（[ _adoptInstance ]）：换 baseUrl、换凭据文件、
  /// **清掉内存里的会话 token 与整份 AppState**——绝不许把 A 的票带去 B。
  ///
  /// 后面那一步分两条路（2026-10-27，用户："如果登回来了就接着吗？"）：
  ///   · 盘上**有这一台的票** ⇒ `bootstrap(fromPicker: true)`：票有效就当场进壳（不打密码门），
  ///     票被服务端判 401 就**留在选择页**（那一行变「登录」+ 一行轻提示）；
  ///   · 盘上**没有票** ⇒ `bootstrap()`：照旧进密码门（设密码 / 登录，由服务端的事实决定）。
  Future<void> openInstance(InstanceEntry entry) async {
    if (pickerBusyId != null) return;
    pickerBusyId = entry.id;
    pickerProblem = InstanceGateProblem.none;
    pickerProblemDetail = '';
    // 新的动作开始：上一次那条"登录状态已失效"的提示到此为止（它是上一个按键的回执）
    pickerSessionExpired = '';
    pickerPort = entry.port;
    // 上一趟等就绪留下的秒数/阶段也是"上一个按键的回执"，别让它挂在新的一行上
    pickerWaitSeconds = 0;
    pickerWaitPhase = '';
    _pickerWaitCancelled = false;
    notifyListeners();
    try {
      if (!entry.hasPort) {
        pickerProblem = InstanceGateProblem.noPort;
        return;
      }
      var probe = await instances.probe(entry.host, entry.port);
      if (probe != null && !probe.matches(entry)) {
        // 端口上住着**另一台**实例：不许"连上去看看"（那就是跨实例）
        pickerProblem = InstanceGateProblem.portTaken;
        pickerProblemDetail = probe.id;
        return;
      }
      if (probe == null) {
        if (!await _startInstance(entry)) return;
        probe = await _awaitInstanceReady(entry);
        if (probe == null) {
          pickerProblem = InstanceGateProblem.notReady;
          pickerProblemDetail = '${entry.port}';
          return;
        }
      }
      _adoptInstance(entry);
      // 现读一次（不用 [instancesToken] 那份快照）：接下来这一趟要怎么走，取决于**此刻**
      // 盘上那份票在不在——而判据只有一处（这里），快照只服务按钮上的字。
      final hasToken = sessions.read(entry.id) != null;
      await bootstrap(fromPicker: hasToken);
    } finally {
      pickerBusyId = null;
      notifyListeners();
    }
  }

  /// 拉起一台已登记的实例（用**它自己**记着的 node/entry/dataDir）
  Future<bool> _startInstance(InstanceEntry entry) async {
    if (entry.nodeExe.trim().isEmpty || entry.entry.trim().isEmpty) {
      pickerProblem = InstanceGateProblem.noLauncher;
      return false;
    }
    final ok = await instances.launch(
      nodeExe: entry.nodeExe,
      entry: entry.entry,
      dataDir: entry.dataDir,
      // 用它自己记着的那个端口：这台实例上次听的就是它（登记表里那一格）
      port: entry.port,
    );
    if (!ok) {
      pickerProblem = InstanceGateProblem.launchFailed;
      pickerProblemDetail = entry.nodeExe;
    }
    return ok;
  }

  /// 等这一台**真的能干活**（`GET /api/instance` 答得出、且 id 对得上），最多 180 秒。
  ///
  /// 为什么以 `/api/instance` 为准而不是"端口能连上"：端口先 bind、重活后干（本机实测
  /// 35–42 秒），能连上的那一刻它还没就绪。**启动期那一层只放行 `/api/health` 与
  /// `/api/auth/state`，其余一律 503** ⇒ 这条端点答得出就等于**它已经就绪**——这正是
  /// "启动并登录"要等的那个时刻（判据见 `src/web/preflight.ts` 的文件头）。
  ///
  /// ## 等的时候要说话（2026-10-28）
  ///
  /// 原来这 180 秒里界面上只有一句"正在启动…"：**不说等了多少秒、不说它卡在哪一步**，
  /// 超时之后也只说"超时"。现在每一拍都把读数摆出去（[pickerWaitSeconds] /
  /// [pickerWaitPhase]，页面拿它显示"已经等了 N 秒，它还在启动（阶段 …）"），
  /// 而且人可以随时按「停止等待」（[cancelPickerWait]）叫停——实例照跑，只是界面不再等。
  Future<InstanceProbe?> _awaitInstanceReady(InstanceEntry entry,
      {int maxSeconds = kInstanceReadyTimeoutSeconds}) async {
    _pickerWaitCancelled = false;
    pickerWaiting = true;
    pickerWaitSeconds = 0;
    pickerWaitPhase = '';
    notifyListeners();
    try {
      for (var second = 0; second < maxSeconds; second += 1) {
        await Future<void>.delayed(const Duration(seconds: 1));
        if (_disposed || _pickerWaitCancelled) return null;
        final probe = await instances.probe(entry.host, entry.port);
        if (probe != null && probe.matches(entry)) return probe;
        if (_disposed || _pickerWaitCancelled) return null;
        pickerWaitSeconds = second + 1;
        pickerWaitPhase = await _readWaitPhase(entry.host, entry.port);
        if (_disposed) return null;
        notifyListeners();
      }
      return null;
    } finally {
      pickerWaiting = false;
      if (!_disposed) notifyListeners();
    }
  }

  /// 问一次那台实例"到哪一步了"（`/api/health` 的 phase）。
  ///
  /// **问不到就回空串**：这一句是给人看的进度，不是判据——判据永远是 `/api/instance`
  /// 答不答得出来。宿主没接这条读口（用例、老装机）时一个请求都不发。
  Future<String> _readWaitPhase(String host, int port) async {
    final reader = instances.health;
    if (reader == null) return '';
    try {
      final reading = await reader(host, port);
      return reading.phase;
    } catch (_) {
      return '';
    }
  }

  /// 「停止等待」：不再等这一台就绪。
  ///
  /// 边上那颗按钮存在的理由：180 秒是一段很长的时间，而人有时候**已经知道**这台起不来了
  /// （端口选错、配置写坏）。让他能叫停，比让他盯着一个只会往前爬的秒数好。
  /// 它**不停实例**（实例照跑，人随时可以再点一次那一行）。
  void cancelPickerWait() {
    if (!pickerWaiting) return;
    _pickerWaitCancelled = true;
    _lifeLog('[life] wait cancelled port=$pickerPort waited=${pickerWaitSeconds}s');
    notifyListeners();
  }

  /// 新建一台实例：选端口 → 拉起 → 等就绪 → 写登记（**后端自己写**）→ 切过去进首次设密码。
  ///
  /// 三条边界（用户确认过）：
  ///   · 目录**已存在且非空** ⇒ 不覆盖，回 [InstanceGateProblem.dirNotEmpty]（页面给两条出路）；
  ///   · 端口**从 7788 起向上找第一个空闲**（探测 TCP，不用系统随机端口）；
  ///   · 登记表由**后端启动时自己写**——界面只负责拉起（见 `instances.dart` 的文件头）。
  Future<void> createInstance({
    required String name,
    String dir = '',
    bool useExistingDir = false,
  }) async {
    if (pickerBusyId != null) return;
    pickerBusyId = '';
    pickerProblem = InstanceGateProblem.none;
    pickerProblemDetail = '';
    createDirConflict = '';
    notifyListeners();
    try {
      final cleanName = name.trim();
      if (cleanName.isEmpty) {
        pickerProblem = InstanceGateProblem.nameRequired;
        return;
      }
      final targetDir = dir.trim().isEmpty ? defaultInstanceDir(cleanName) : dir.trim();
      final folder = Directory(targetDir);
      final exists = folder.existsSync();
      var nonEmpty = false;
      if (exists) {
        try {
          nonEmpty = folder.listSync().isNotEmpty;
        } catch (_) {
          nonEmpty = true; // 读不动就按"有东西"处理：绝不往一个看不见内容的目录里写
        }
      }
      if (nonEmpty && !useExistingDir) {
        createDirConflict = targetDir;
        pickerProblem = InstanceGateProblem.dirNotEmpty;
        pickerProblemDetail = targetDir;
        return;
      }
      final launcher = InstanceBook.load().launcherFor(instance);
      if (launcher == null) {
        pickerProblem = InstanceGateProblem.noLauncher;
        return;
      }
      final port = await instances.freePort(kFirstInstancePort, '127.0.0.1');
      if (port == null) {
        pickerProblem = InstanceGateProblem.portUnavailable;
        return;
      }
      pickerPort = port;
      notifyListeners();
      final ok = await instances.launch(
        nodeExe: launcher.nodeExe,
        entry: launcher.entry,
        dataDir: targetDir,
        // 刚选好的空闲端口：**必须当场交给进程**（安装根的 config.json 只有一个 7788）
        port: port,
      );
      if (!ok) {
        pickerProblem = InstanceGateProblem.launchFailed;
        pickerProblemDetail = launcher.nodeExe;
        return;
      }
      // 新实例的 id 里含数据目录哈希（只有它自己算得出来）：等它登记上来再认领。
      // 等待期间的读数与「停止等待」跟「启动并进入」同一条口径（见 [_awaitInstanceReady]）：
      // 这一趟也是一段几十秒的死等，人也该看得见"等了多久、它到哪一步"。
      final deadline = DateTime.now().add(const Duration(seconds: kInstanceReadyTimeoutSeconds));
      InstanceEntry? created;
      _pickerWaitCancelled = false;
      pickerWaiting = true;
      pickerWaitSeconds = 0;
      pickerWaitPhase = '';
      var elapsed = 0;
      try {
        while (DateTime.now().isBefore(deadline)) {
          await Future<void>.delayed(const Duration(seconds: 1));
          if (_disposed || _pickerWaitCancelled) break;
          elapsed += 1;
          final probe = await instances.probe('127.0.0.1', port);
          if (probe != null && _sameDir(probe.dataDir, targetDir)) {
            created = _entryFor(probe, fallbackName: cleanName, nodeExe: launcher.nodeExe, entry: launcher.entry);
            break;
          }
          pickerWaitSeconds = elapsed;
          pickerWaitPhase = await _readWaitPhase('127.0.0.1', port);
          if (_disposed) break;
          notifyListeners();
        }
      } finally {
        pickerWaiting = false;
        if (!_disposed) notifyListeners();
      }
      if (created == null) {
        pickerProblem = InstanceGateProblem.notReady;
        pickerProblemDetail = '$port';
        return;
      }
      // 切过去：**首次设密码**那扇门由 bootstrap 按服务端的事实决定
      _adoptInstance(created);
      await refreshInstances();
      await bootstrap();
    } finally {
      pickerBusyId = null;
      notifyListeners();
    }
  }

  /// 给一台实例**改名**：写成 `nameSource: "manual"`（后端此后永不覆盖它）。
  ///
  /// 为什么这件事在界面这一半：改名只动登记表，而目标那台**可能根本没在跑**——没有进程
  /// 可以接一条"改名"命令。写盘细节（只改目标那条、其余字段原样保留、原子写）在
  /// `InstanceBook.renameById`。
  ///
  /// 空名字**当场拒**（不写盘）：名字是选择页上唯一认得出来的标签，空串等于让它变回"目录末段"，
  /// 而那是用户刚刚明确不要的东西。
  Future<bool> renameInstance(InstanceEntry entry, String name) async {
    final clean = name.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (clean.isEmpty) {
      pickerProblem = InstanceGateProblem.nameRequired;
      pickerProblemDetail = '';
      notifyListeners();
      return false;
    }
    if (pickerBusyId != null) return false;
    pickerBusyId = entry.id;
    pickerProblem = InstanceGateProblem.none;
    pickerProblemDetail = '';
    notifyListeners();
    try {
      final ok = await InstanceBook.load().renameById(entry.id, clean);
      if (!ok) {
        pickerProblem = InstanceGateProblem.renameFailed;
        return false;
      }
      _lifeLog('[life] rename instance=${entry.name}->$clean id=${entry.id}');
      await refreshInstances();
      return true;
    } finally {
      pickerBusyId = null;
      notifyListeners();
    }
  }

  /// 删除一台实例：**只允许未运行且非默认**（判据在 `InstanceEntry.canDelete`，只有一份）。
  ///
  /// [deleteDir] 为真时连数据目录一起删——**页面默认不删**（"目录还在，要不要一并删？"），
  /// 因为那里面有她的记忆与人格。
  Future<bool> deleteInstance(InstanceEntry entry, {bool deleteDir = false}) async {
    if (pickerBusyId != null) return false;
    pickerBusyId = entry.id;
    pickerProblem = InstanceGateProblem.none;
    notifyListeners();
    try {
      final probe = entry.hasPort ? await instances.probe(entry.host, entry.port) : null;
      final running = probe != null && probe.matches(entry);
      if (!InstanceEntry.canDelete(entry: entry, running: running)) {
        pickerProblem = entry.isDefault
            ? InstanceGateProblem.cannotDeleteDefault
            : InstanceGateProblem.cannotDeleteRunning;
        return false;
      }
      final ok = await InstanceBook.load().removeById(entry.id);
      if (!ok) {
        pickerProblem = InstanceGateProblem.removeFailed;
        return false;
      }
      if (deleteDir) {
        try {
          // **最后一道闸**：绝不往"根目录"上递归删。数据目录是登记表里读来的字符串，
          // 一条被手改坏的记录（`D:\`）在这里就是一场灾难——宁可少删，不可多删。
          if (_isDeletableInstanceDir(entry.dataDir)) {
            final folder = Directory(entry.dataDir);
            if (folder.existsSync()) folder.deleteSync(recursive: true);
          } else {
            guiLog.write('[life] delete instance dir refused (looks like a root): ${entry.dataDir}');
          }
        } catch (err) {
          guiLog.write('[life] delete instance dir failed dir=${entry.dataDir} error=$err');
        }
      }
      _lifeLog('[life] delete instance=${entry.name} dir=${deleteDir ? 'removed' : 'kept'}');
      await refreshInstances();
      return true;
    } finally {
      pickerBusyId = null;
      notifyListeners();
    }
  }

  /// 把界面切到这一台：换 baseUrl、**清掉内存里的票与整份 AppState**。
  ///
  /// 这是"实例之间完全隔离"的落点。三件事一件都不能少：
  ///   ① 收掉所有**属于上一台**的活链路（心跳、事件流、待批轮询、门前重连）；
  ///   ② `api.token = null` + `instance = null`：票从内存里消失（盘上那份属于**那一台**，
  ///      由 `SessionStore` 按实例标识分文件存；这里连 id 都清掉，bootstrap 会从服务端重新学）；
  ///   ③ `backendPortResolver = null`：**显式选过实例之后，端口文件不许再把界面带走**
  ///      （`server.json` 是"默认实例"的提示位；选过第二台之后它就是个错误来源）。
  void _adoptInstance(InstanceEntry entry) {
    _resetForGate(withToken: true);
    backend = BackendPort(port: entry.port, source: BackendPortSource.defaultPort);
    backendPortResolver = null;
    api.baseUrl = 'http://127.0.0.1:${entry.port}';
    api.instance = null;
    pickerPort = entry.port;
    guiLog.write('[life] switch instance=${entry.name} port=${entry.port} dir=${entry.dataDir}');
    notifyListeners();
  }

  /// 把壳里的东西清干净（回门之前那一下）：心跳、事件流、待批、状态句、页面停留位置。
  ///
  /// [withToken] 为真时连**内存里那张票**一起清掉——[closeInstance] / [logout] / "切实例"
  /// 都要清（注意：清的是**内存**那份；盘上那份只有 [logout] 才清）；
  /// 401 自愈那一类（`_requireAuth`）自己有一条更窄的路（它要留着 id 去清盘上那份）。
  void _resetForGate({required bool withToken}) {
    _dashboardTick?.cancel();
    _dashboardTick = null;
    _dropEventsFeed();
    _gateRetry?.cancel();
    _gateRetry = null;
    // 门上"等后端就绪"那一条（门上的三档提示）：回门之前一律停掉，计数器归零
    _clearBackendWait();
    backendReadiness = BackendReadiness.unknown;
    _stopGrantPolling();
    if (withToken) {
      api.token = null;
      instance = null;
    }
    ready = false;
    _thinking = false;
    _openTurn = null;
    online = false;
    dotKind = 'offline';
    stateText = '';
    stateNote = '';
    subText = '';
    askCards = const <AskCardData>[];
    askTotal = 0;
    pendingGrants = const <Map<String, dynamic>>[];
    malformedGrants = const <Map<String, dynamic>>[];
    updateInfo = null;
    herName = null;
    needsPasswordPrompt = false;
    _onLegacyToken = false;
    gateError = '';
    gateHint = AuthGateHint.none;
    gateAttempt = 0;
    gateWaited = 0;
    gateRetrying = false;
    gateUnreachable = false;
    pageId = defaultPageId;
    pageEpoch += 1;
  }

  /// 等 [port] 不再应答（≤ [kInstanceStopTimeoutSeconds] 秒），返回**实际等了几秒**。
  ///
  /// 每 250ms 探一次（TCP，不需要凭据）。这个秒数会进 `[life]` 那行日志：它是"这次停得
  /// 干不干净"的唯一读数——真机上一个优雅退出的后端通常 1~3 秒内端口就没了。
  Future<int> _awaitPortGone(int port, {int timeoutSeconds = kInstanceStopTimeoutSeconds}) async {
    const tickMs = 250;
    final maxTicks = timeoutSeconds * 1000 ~/ tickMs;
    for (var i = 0; i < maxTicks; i += 1) {
      if (!await instances.portAlive('127.0.0.1', port)) {
        return (i * tickMs / 1000).round();
      }
      await Future<void>.delayed(const Duration(milliseconds: tickMs));
      if (_disposed) return (i * tickMs / 1000).round();
    }
    return timeoutSeconds;
  }

  /// 把一条 `/api/instance` 的应答收成登记表条目（新建流程用；后端此刻**可能还没写盘**）
  InstanceEntry _entryFor(
    InstanceProbe probe, {
    required String fallbackName,
    required String nodeExe,
    required String entry,
  }) {
    return InstanceEntry(
      id: probe.id,
      name: probe.name.trim().isEmpty ? fallbackName : probe.name.trim(),
      dataDir: probe.dataDir,
      host: '127.0.0.1',
      port: probe.port,
      pid: probe.pid,
      nodeExe: nodeExe,
      entry: entry,
      isDefault: probe.isDefault,
      lastStartedAt: DateTime.now().toUtc().toIso8601String(),
    );
  }

  /// 两个数据目录是不是同一个（大小写 / 尾部分隔符 / 斜杠写法归一）
  bool _sameDir(String a, String b) {
    String key(String value) {
      var text = value.trim().replaceAll('/', '\\');
      while (text.endsWith('\\')) {
        text = text.substring(0, text.length - 1);
      }
      return text.toLowerCase();
    }

    return key(a) == key(b);
  }

  /// 这个路径像不像"一台实例的数据目录"（"删除实例 → 连目录一起删"的**最后一道闸**）。
  ///
  /// 判据只有两条，都是"明显不是根"的形状：
  ///   · 归一之后至少还有三级（`D:\` / `D:` / `/` 这些一眼就出局）；
  ///   · 不以分隔符结尾（`C:\instances\` 那种写法去掉尾分隔符之后同上一条）。
  /// 它**不判**"是不是真的实例目录"——那做不到也不该做；它只保证"绝不会递归删到一个根"。
  bool _isDeletableInstanceDir(String path) {
    var text = path.trim().replaceAll('/', '\\');
    while (text.endsWith('\\')) {
      text = text.substring(0, text.length - 1);
    }
    if (text.length < 4) return false;
    final separators = text.split('\\').where((part) => part.isNotEmpty).length;
    return separators >= 2;
  }

  /// 启动握手连不上本地服务：**先当成"正在启动"，退避重试，别停在终态**。
  ///
  /// 为什么不直接弹登录框：那会让人以为是密码的问题，去反复重输——而真正的问题是
  /// 主进程没在跑。门的三种画面里，"连不上"和"你没凭据"是两件事。
  ///
  /// 这里与修之前（2026-10-04）的区别只有一条、但后果很大：**它不是终态**。
  /// 「重启前后端」那颗按钮先把主进程停掉、再拉起界面，界面先起来是**安排好的顺序**；
  /// 于是"连接被拒"在那一刻是**预期内的中间态**。原来它一句话就画一张错误卡，
  /// 每次重启都欠人一次按键——所以现在改成：宽限窗口内只显示进度句（中性话），
  /// 窗口用尽才降级成错误卡，而且降级之后仍然在后台慢速重试（见 [_tickGate]）。
  ///
  /// 为什么要分清"连接类失败"与"别的失败"：只有前者会随着时间自己好。服务端回 500、
  /// 回一段读不懂的东西，那是**它在那**并且说不行——这时候每秒重试一万次也不会有变化，
  /// 所以那种失败照旧当场说话、等人看（「重试」那颗按钮留着）。
  /// [connection] 由调用方按**异常类型**判定（见 bootstrap 里那个 `on ApiError` 分支）：
  /// 认类型的判据比认字符串可靠——每个平台抛的连接错误字面量都不一样。
  void _onConnectFailure(Object err, {required bool connection}) {
    // 已经在门里了：这条失败是一只**过期的**重试回执（握手成功那一刻它还在飞）。
    // 不认它——认了就会给已经进壳的界面挂上一条门前的重连定时器（壳里有自己的心跳）。
    if (ready) return;

    gate = AuthGateKind.checking;
    ready = false;
    online = false;
    dotKind = 'offline';
    stateText = '连接中断';

    if (!connection) {
      // 服务端**答了话**（500 之类）：它在那儿，只是这条路现在不通——这种失败不会随时间
      // 自己好，所以不当成"还在启动"：当场把话说重，并且**停掉**自动重连（重试没有意义，
      // 留着只会每 3 秒白打一次）。人按「立即重试」再开始新一轮。
      gateUnreachable = true;
      gateRetrying = false;
      gateError = '连不上本地服务（$err）。确认主进程正在运行，然后重试。';
      notifyListeners();
      return;
    }

    // 这一拍是不是**重试那一拍**发起的：看 [gateRetrying] 这条**逻辑状态**（这一轮等待还在不在），
    // **不看 `_gateRetry` 那条定时器字段**。
    //
    // 为什么（这是那条红测试的根因，探针逐 100ms 采样实测过）：重试那一拍跑起来的时候
    // `_gateRetry` 必然是空的（回调第一件事就是把自己摘掉，见 [_scheduleGateRetry]），
    // 于是拿字段判断会把**每一拍**都当成"新的第一轮"——等待秒数每次被重置回 0，
    // 门卡上的"已等 Xs"在 0/1 之间来回跳，宽限窗口永远走不到头（那句"确认主进程在运行"
    // 永远不出现），退避节奏也永远停在第一档 0.3 秒。
    final continuing = gateRetrying;

    gateRetrying = true;
    if (!continuing) {
      // 新的一轮等待：从第 0 秒数起，并且把话收回中性那一句（此刻还没到"去确认主进程"的时候）
      gateWaited = 0;
      gateUnreachable = false;
      gateError = '';
      /**
       * **等待的那一行日志**（2026-10-26 的事故要求）：
       * `[net] waiting backend port=7788 source=file|env|default`
       *
       * 三样都要有：端口、来源、"在等"这件事。事故那天日志里只有
       * `SocketException … port = 1580`——看得出连不上，看不出**这个端口是从哪来的**，
       * 于是"父进程环境变量被污染"这条根因只能靠猜。来源进日志之后一眼可判：
       * `source=file` 是后端自己写的、`source=env` 是继承来的、`source=default` 是兜底。
       */
      _netLog('[net] waiting backend port=$backendPort source=${backend.sourceLabel}'
          '${backend.pid == null ? '' : ' pid=${backend.pid}'}');
    }
    // 不管是不是新的一轮都要**排下一拍**：这一拍（如果是重试发起的）已经被它自己消费掉了，
    // 不重排就是"只试一次就再也不试"——降级之后那条慢速重试永远等不到。
    _scheduleGateRetry();
    notifyListeners();
  }

  /// 排下一拍重试：宽限窗口内按 [kGateRetryDelays] 的节奏（0.3/0.5/0.8/1…上限 1 秒），
  /// 窗口用尽之后每 [kGateSlowRetrySeconds] 秒来一次。
  ///
  /// 慢速那一档**不取消**：降级只是换口径（把话说重），不是放弃——主进程两分钟后才起来，
  /// 界面也该自己进门。
  void _scheduleGateRetry() {
    _gateRetry?.cancel();
    final index = gateWaited < kGateRetryDelays.length ? gateWaited : kGateRetryDelays.length - 1;
    final seconds = gateWaited < gateGraceWindowSeconds
        ? kGateRetryDelays[index]
        : kGateSlowRetrySeconds.toDouble();
    _gateRetry = Timer(Duration(milliseconds: (seconds * 1000).round()), () {
      // 先把字段收干净再动手：`_tickGate` 会 notifyListeners（可能有人在这上面读状态），
      // 而"这一拍发出去之后"的状态必须自洽——此刻确实没有待发的定时器了，这一条就是它。
      //
      // **`_gateRetry` 是"有没有待发的定时器"，不是"这一轮等待还在不在"**：后者是
      // [gateRetrying]，`_onConnectFailure` 只认它。曾经在这里把已经触发过的 Timer 塞回字段，
      // 好让失败分支"看出这是一次重试"——那样失败分支会以为"已经有定时器在跑"，于是
      // 既不重排也不计数，现象是**只试一次就再也不试**。反过来，把字段一直留着 null
      // 而让失败分支改用字段做判断，现象是**每一拍都被当成新一轮**（见 [_onConnectFailure]）。
      // 两条都实测踩过，所以判据与定时器字段彻底分开。
      _gateRetry = null;
      if (_disposed || !gateRetrying || gate != AuthGateKind.checking || ready) return;
      _tickGate();
      unawaited(bootstrap());
    });
  }

  /// 停在门前时推一格进度（门卡上那句"第 N 次尝试，已等 Xs"读它）。
  ///
  /// 为什么不用一个每秒重建的 Timer.periodic：重试那一拍的间隔本身就是 0.3~1 秒，
  /// 每次重试失败后重排下一拍时顺手 +1 秒即可——多一条定时器只是多一处要记得取消的东西。
  /// 秒数因此是**重试次数**的近似，而不是墙上时钟：这是给人看的进度，不是时间戳
  /// （读系统时钟会被系统对时跳一下，那种跳变不该出现在"已等 Xs"里）。
  ///
  /// 过了宽限窗口就把话改成"确认主进程在运行"那一句（[gateUnreachable]），重试照旧。
  /// 这句话是**单向的**：降级之后每一拍不再把它擦回中性话（[bootstrap] 与
  /// [_onConnectFailure] 都不在重试那一拍里动措辞），人不会看到卡片每隔几秒跳一次措辞。
  void _tickGate() {
    gateWaited += 1;
    if (gateWaited >= gateGraceWindowSeconds && !gateUnreachable) {
      gateUnreachable = true;
      gateError = '连不上本地服务（等了 $gateWaited 秒，主进程一直没有应答）。'
          '确认主进程正在运行；界面每 $kGateSlowRetrySeconds 秒仍会自动重试，它起来就会自己进来。';
    }
    notifyListeners();
  }

  /// 重试启动握手（门上那颗"重试"按钮）。
  ///
  /// 那颗按钮现在**不是唯一的路**了（自动重试一直在跑），留着它是因为降级之后人需要
  /// 一个"我确认过了、现在就再来一次"的动作——比如他刚手动把主进程拉起来。
  Future<void> retryBootstrap() => bootstrap();

  // ──────────────── 门上那三档：谁在计时、何时停（2026-10-28） ────────────────

  /// 门上的设密码/登录页**进场时**问一次"后端现在能不能干活"。
  ///
  /// 为什么要它（③）：那颗「设置密码」不能等人点了才报错——后端没起 / 还在启动时，
  /// 它本来就该是灰的，旁边摆的是同一套三档提示。登录页同样先问一次：
  /// 人站在那儿看到的应当是"后端还没起来，正在重试"，而不是一个看起来很正常的密码框。
  ///
  /// 只在 [gateWaitingBackend] 为假时探（已经在等的那一轮自己会重探，别叠第二条链）。
  Future<void> watchBackend() async {
    if (_disposed || ready || gateWaitingBackend) return;
    final reading = await probeBackend(api);
    if (_disposed || ready) return;
    if (reading.isReady) {
      backendReadiness = BackendReadiness.ready;
      backendPhase = '';
      notifyListeners();
      return;
    }
    _holdForBackend(reading);
    notifyListeners();
  }

  /// 把"后端还没就绪"这一档摆上：读数、话、以及**每 [kBackendRetrySeconds] 秒一拍的重探**。
  ///
  /// 谁在计时：只有这里挂上的那条 1 秒节拍器（[_backendRetry]）；每满 2 秒真去打一次
  /// `/api/health`（见 [_retryBackendProbe]）。
  ///
  /// 何时停：①探到就绪（[_clearBackendWait]）；②进门成功（[_markGateOpen]）；
  /// ③回到"还没进门"的初始态（[_resetForGate]）；④页面退场（[dispose]）。
  ///
  /// **它不发登录请求**：密码不该被自动重发（重试的只是"后端起来了没有"那次探测）。
  void _holdForBackend(BackendReading reading) {
    final already = gateWaitingBackend;
    backendReadiness = reading.readiness;
    if (reading.phase.isNotEmpty) backendPhase = reading.phase;
    gateWaitingBackend = true;
    if (!already) {
      // 新的一轮等待：秒数与次数从 0 数起
      backendWaitSeconds = 0;
      backendRetryCount = 0;
      _netLog('[net] gate backend=${reading.readiness.name} port=$backendPort'
          '${reading.phase.isEmpty ? '' : ' phase=${reading.phase}'}'
          ' retry=${kBackendRetrySeconds}s');
    }
    _refreshBackendMessage();
    _startBackendRetry();
  }

  /// 把那句话按**当前读数 + 已经等了多久**重新算一遍（语言换了、阶段变了、过 60 秒了都要重算）。
  void _refreshBackendMessage() {
    if (!gateWaitingBackend) return;
    final s = currentStrings;
    final main = backendReadiness == BackendReadiness.starting
        ? s.gateBackendStarting(s.backendPhaseLabel(backendPhase))
        : s.gateBackendDown('127.0.0.1:$backendPort');
    // 60 秒还没就绪：加一句去处（不然人只能对着"正在重试…"干等）
    gateError = backendWaitSeconds >= kBackendLogHintSeconds
        ? '$main\n${s.gateBackendLogHint}'
        : main;
  }

  /// 挂上那一条 1 秒节拍器（已经在跑就不重复挂）。
  ///
  /// 为什么是 1 秒一格而不是"2 秒一条 Timer"：界面要显示"第 N 秒"，那就得每秒动一下；
  /// 而重探本身每 2 秒才发一次（[kBackendRetrySeconds]）——两个数在这一条链上各自清楚。
  void _startBackendRetry() {
    if (_backendRetry != null) return;
    _backendRetry = Timer.periodic(const Duration(seconds: 1), (timer) {
      if (_disposed || !gateWaitingBackend) {
        timer.cancel();
        _backendRetry = null;
        return;
      }
      backendWaitSeconds += 1;
      if (backendWaitSeconds % kBackendRetrySeconds == 0) {
        backendRetryCount += 1;
        unawaited(_retryBackendProbe());
      }
      // 每 1 秒都要重算：到 60 秒那一刻那句话要自己长出"看 gui.log"那一行
      _refreshBackendMessage();
      notifyListeners();
    });
  }

  /// 自动重探的那一拍：探到就绪就把提示**自动解除**；还没就绪就更新读数（秒数照走）。
  ///
  /// 探到就绪之后**什么都不做**：不发登录请求。人自己点那颗按钮——密码不该被自动重发。
  Future<void> _retryBackendProbe() async {
    final reading = await probeBackend(api);
    if (_disposed || !gateWaitingBackend) return;
    if (reading.isReady) {
      _clearBackendWait();
      notifyListeners();
      return;
    }
    backendReadiness = reading.readiness;
    if (reading.phase.isNotEmpty) backendPhase = reading.phase;
    _refreshBackendMessage();
    notifyListeners();
  }

  /// 收掉门前那一套等待：定时器停、计数归零、**那行提示自己消失**（后端好了就不再吓人）。
  void _clearBackendWait() {
    _backendRetry?.cancel();
    _backendRetry = null;
    final waited = backendWaitSeconds;
    final retries = backendRetryCount;
    final wasWaiting = gateWaitingBackend;
    gateWaitingBackend = false;
    backendReadiness = BackendReadiness.ready;
    backendPhase = '';
    backendWaitSeconds = 0;
    backendRetryCount = 0;
    if (wasWaiting) {
      // 那行红字是这一族自己写上去的，收的时候也只收自己写的那一句
      gateError = '';
      _netLog('[net] gate backend ready port=$backendPort waited=${waited}s retries=$retries');
    }
  }

  /// 首次设密码：服务端成功后**当场就是登录态**，人不必再输一遍。
  Future<void> setupPassword(String password, String confirmation) async {
    if (password.isEmpty) {
      gateError = '请先设一个密码。';
      notifyListeners();
      return;
    }
    if (password.length < kPasswordMinLength) {
      gateError = '密码至少 $kPasswordMinLength 位（现在 ${password.length} 位）。';
      notifyListeners();
      return;
    }
    if (password != confirmation) {
      gateError = '两次输入的密码不一样，请重新输入。';
      notifyListeners();
      return;
    }
    await _enter('/api/auth/setup', password);
  }

  Future<void> login(String password) async {
    if (password.isEmpty) {
      gateError = '请输入密码。';
      notifyListeners();
      return;
    }
    await _enter('/api/auth/login', password);
  }

  /// 设密码与登录走的是同一条路（两个端点、同样一份响应、同样一次进门）：
  /// 分开写两份的话，"设完密码没进主界面"这类差异迟早出现。
  ///
  /// 失败里有两类是**"你站错门了"**，不是"这次没成"（2026-10-23 的死锁现场）：
  ///   · 设置端点回 409 `already-initialized` —— 这台实例已经有密码 ⇒ 当场切到登录页；
  ///   · 登录端点回 401 `auth-uninitialized` —— 这台实例其实还没设密码 ⇒ 当场切到设置页。
  /// 留在原地就是让人对着一张永远失败的表单，所以这两条**换门**，并把原因写在中性提示行里。
  ///
  /// ## 先探一次后端，再发登录请求（2026-10-28）
  ///
  /// 这一趟的**第一件事**是探"后端能不能干活"（[probeBackend]）——那正是用户说的
  /// "登录请求之前的那次探测"。理由只有一条：后端没起 / 还在启动时，这条登录请求
  /// 既发不出去也证明不了密码；它失败之后界面却只能拿到一句"连不上"，
  /// 于是三种完全不同的事被说成了同一句（真机现场）。
  ///
  /// 探到 ①② 两档 ⇒ **不发登录请求**，把话说成对应的那一档并挂上每 2 秒一拍的自动重探
  /// （[AppState._holdForBackend]）。探到就绪 ⇒ 才真的发。
  ///
  /// 三档的落点：
  ///   · ①连不上 / ②正在启动：`gateError` = 那两句话之一（+ 60 秒后的去处提示）；
  ///   · ③401：`gateError` = 服务端原话（"密码不对。…"），**不碰输入框、不挂重探**。
  Future<void> _enter(String path, String password) async {
    gateBusy = true;
    gateError = '';
    gateHint = AuthGateHint.none;
    notifyListeners();
    try {
      final reading = await probeBackend(api);
      if (_disposed) return;
      if (!reading.isReady) {
        gateBusy = false;
        _holdForBackend(reading);
        notifyListeners();
        return;
      }
      // 后端好了：门前那一套等待到此为止（它只关于"起没起"，与这次密码对不对无关）
      _clearBackendWait();
      final result = await api.postAuth(path, {'password': password, 'label': 'gui'});
      final token = result is Map ? result['token'] : null;
      final reported = result is Map ? result['instance'] : null;
      if (reported is String && reported.isNotEmpty) instance = reported;
      if (token is! String || token.trim().isEmpty) {
        gateError = '服务端没有返回会话凭据，请再试一次。';
      } else {
        final value = token.trim();
        api.token = value;
        final key = instance;
        if (key != null) sessions.write(key, value);
        gateBusy = false;
        _markGateOpen();
        ready = true;
        gateError = '';
        gateHint = AuthGateHint.none;
        _onLegacyToken = false;
        authInitialized = true;
        needsPasswordPrompt = false;
        notifyListeners();
        startPolling();
        return;
      }
    } on ApiAuthError catch (err) {
      if (err.instance != null) instance = err.instance;
      // 401 = **密码**的事，不是后端的事：把"等待"那一族彻底收掉，
      // 否则就绪之后它会把"密码不对"这行字自己擦掉（那比不说更糟）。
      _clearBackendWait();
      if (err.code == 'already-initialized') {
        // 设置页收到的 409：实例已经有密码。留着这扇门 = 永远失败，所以换门。
        authInitialized = true;
        gate = AuthGateKind.login;
        gateError = '';
        gateHint = AuthGateHint.alreadyInitialized;
      } else if (err.code == 'auth-uninitialized') {
        // 反方向（登录页收到"还没设密码"）：同样换门，不让表单白转
        authInitialized = false;
        gate = AuthGateKind.setup;
        gateError = '';
        gateHint = AuthGateHint.setupNeeded;
      } else {
        // 其余才是真错误，服务端那句话最准（"密码不对。"、"密码至少 6 位…"），照原样显示
        gateError = err.message;
      }
    } on ApiError catch (err) {
      // 探测与登录之间后端可能又变了（重启中）：这一档仍是"正在启动"，照 ② 说
      if (err.starting) {
        _holdForBackend(BackendReading(BackendReadiness.starting, phase: err.phase));
      } else {
        _clearBackendWait();
        gateError = err.message;
      }
    } catch (_) {
      // 连接类失败（SocketException / 超时）：③ 之外唯一会自己好的那一档
      _holdForBackend(BackendReading.down);
    }
    gateBusy = false;
    notifyListeners();
  }

  /// 401 自愈的接线点：重读这个实例的凭据文件。
  ///
  /// 每次都重读（哪怕内容看着没变）：另一个进程重登之后会把文件重写掉，
  /// 而"重写"这件事只有在读的那一刻才看得见——缓存一份在内存里就等于把这条路堵死。
  /// 重试**只发生一次**（一次请求一份凭据），第二次还 401 就回登录态。
  Future<String?> _rereadCredential() async {
    final key = instance;
    if (key == null) return null;
    return sessions.read(key);
  }

  /// 服务端说"这张票不作数了"：**回到登录态，而不是白屏**。
  ///
  /// 这是这轮修的另一半：过去这里只是把 token 清掉、写一句"认证失败（token 无效）"，
  /// 于是界面留在壳里、所有页面都读不到数据——人看到的是一片空白，只能自己去猜要重启。
  ///
  /// 2026-10-23 起它**不再往红字那一行写话**：这条 401 是分流信号（去哪一扇门），不是
  /// "刚才那个动作失败了"。现场证据：探测/心跳收到 `auth-uninitialized` 之后，界面上真的
  /// 出现了红字"这台实例还没设密码。请先在界面里设置一个密码。"，而实例其实有密码。
  /// 换门的原因写在 [gateHint]（中性提示），真正的错误留给 [gateError]。
  void _requireAuth(ApiAuthError err) {
    // 快档那一拍与事件流同一条命：凭据都不作数了，它们再打也只是白挨 401
    _dashboardTick?.cancel();
    _dashboardTick = null;
    _dropEventsFeed();
    // 凭据都不作数了：那条读清单的轮询再打也只是白挨 401
    _stopGrantPolling();
    ready = false;
    _thinking = false;
    api.token = null;
    final key = instance;
    if (key != null) sessions.clear(key);
    online = false;
    dotKind = 'offline';
    // 判据优先用服务端当场的 code；code 缺失（老服务端）时才看上次问到的公开事实
    final toSetup = err.needsSetup || (err.code == null && authInitialized == false);
    gate = toSetup ? AuthGateKind.setup : AuthGateKind.login;
    gateError = '';
    gateHint = toSetup ? AuthGateHint.setupNeeded : AuthGateHint.sessionExpired;
    stateText = err.needsSetup ? '还没设置密码' : '会话已失效，请重新登录';
    notifyListeners();
  }

  void startPolling() {
    unawaited(pollOnce());
    // 名字跟着同一条生命周期的起点读一次（她改名走界面那几条路时会再读，见 refreshHerName）
    unawaited(refreshHerName());
    // **只有这一条链在读 dashboard**：下面那一拍自己排下一拍（间隔按"她在不在想"重算，
    // 见 [_sleepAfterRead]）。原来那种"10 秒 periodic + 另起一条快档"的写法会让两条链
    // 同时打同一个端点（快档 250ms 时尤其明显）——同一份响应读两遍，谁都不需要。
    _scheduleDashboardTick(const Duration(seconds: kOnlinePollSeconds));
    _syncEventsFeed();
    // 待批清单：进门就开始读（右下角卡 / 左侧角标 / 托盘首项共用这一份）
    _startGrantPolling();
    // 更新检查：进门读一次现状（**只读 `/api/update`，不发外部请求**）+ 读回"关掉的是哪一版"。
    // 之后由事件流那条 `update/checked` 驱动再读（见 [_onFeedEvent]）——不必另起轮询。
    unawaited(restoreUpdateDismissed());
    unawaited(refreshUpdate());
  }

  /// 起那条读待批清单的轮询（重复调用无副作用：`start()` 自己判重）。
  ///
  /// 为什么**单独一条**、不并进 dashboard 那一拍：那一拍在她"思考中"时会降到 250ms
  /// （见 [kTurnReadMs]），把一条只为了"有没有新单子"的读也按 250ms 打出去纯属浪费——
  /// 而 10 秒对"通知"这件事足够快（与慢档心跳同一档，见 [kGrantPollSeconds] 的理由）。
  void _startGrantPolling() {
    final poller = _grantPoller ??= PendingGrantPoller(
      api: api,
      onPending: applyPendingGrants,
      onMalformed: applyMalformedGrants,
    );
    poller.start();
  }

  /// 收掉那条轮询（回门 / 退场）。[clear] 为真时连手上那份清单一起清掉。
  void _stopGrantPolling({bool clear = true}) {
    _grantPoller?.stop();
    if (clear) {
      pendingGrants = const <Map<String, dynamic>>[];
      malformedGrants = const <Map<String, dynamic>>[];
    }
  }

  /// 把刚读到的一份待批清单收下（轮询回调的入口；用例也用它摆数据）。
  ///
  /// **顺序在这里定一次**（[pendingGrantsNewestFirst]）：轮询那边已经过了一遍，这里再过
  /// 一遍是幂等的，换来的是"任何入口进来的清单都满足『最新在最前』"——右下角那张卡只取
  /// 前三条，顺序错了就是把最旧的三条摆给人看。顺带把形状不对的条目滤掉。
  void applyPendingGrants(List<Map<String, dynamic>> pending) {
    if (_disposed) return;
    pendingGrants = List<Map<String, dynamic>>.unmodifiable(pendingGrantsNewestFirst(pending));
    notifyListeners();
  }

  /// **读不出来的那些申请单**（`GET /api/grants.malformed`，2026-10-22 加）。
  ///
  /// 它是独立的一格、**不进 [pendingGrants]**：那一档没有可点的卡（`picked:false` 且解析不过），
  /// 混进待批队列只会让人点出一句错。界面据它显示一句「有一张单读不出来」——
  /// 那张单在"待批"判据里两样都不满足，过去就是这么消失的。
  List<Map<String, dynamic>> malformedGrants = const <Map<String, dynamic>>[];

  /// 收下一份"读不出来的单子"清单（轮询回调的入口；用例也用它摆数据）。
  void applyMalformedGrants(List<Map<String, dynamic>> malformed) {
    if (_disposed) return;
    malformedGrants = List<Map<String, dynamic>>.unmodifiable(malformedGrantsOf(malformed));
    notifyListeners();
  }

  /// 立刻重读一次待批清单：点了批准/驳回之后走这里——**卡马上消失，不等 10 秒那一拍**。
  ///
  /// 不重读的后果不是"慢一点"，而是"人点了批准、卡还在、于是再点一次"——第二次撞
  /// 服务端的 `grant-already-decided`（409），屏幕上就成了一条莫名其妙的失败。
  Future<void> refreshPendingGrants() async {
    final poller = _grantPoller;
    if (poller == null) return;
    await poller.refresh();
  }

  /// 批准 / 驳回一张待批的申请单（`POST /api/commands/grant-decide`）。
  ///
  /// 与扩展页 `_decideGrant` **同一个端点、同一份 body**：批准不带理由；驳回带（留空照发——
  /// 人不该被一个必填项挡住驳回，回执里服务端会写"驳回了，没有给理由"）。
  /// 回执里那几格如实转述（见 [GrantDecision]）：**"批了"不等于"装上了"**。
  Future<GrantDecision> decideGrant(String id, {required bool approve, String reason = ''}) async {
    try {
      final res = await api.post('/api/commands/grant-decide', {
        'id': id,
        'decision': approve ? 'approve' : 'reject',
        if (!approve) 'reason': reason,
      });
      final exec = res is Map && res['exec'] is Map
          ? (res['exec'] as Map).cast<String, dynamic>()
          : const <String, dynamic>{};
      return GrantDecision(
        recorded: true,
        outcome: res is Map ? '${res['outcome'] ?? ''}' : '',
        execState: '${exec['state'] ?? ''}',
        failure: '${exec['failure'] ?? ''}',
        restartRequired: res is Map && res['restartRequired'] == true,
      );
    } catch (err) {
      // 401 不在这里改门态：README 那条自愈链（api.onUnauthorized）已经在 [bootstrap] 那边
      // 统一处理，这里抢着做只会多一份判据。这一句如实交给调用方，卡留在原地。
      return GrantDecision(recorded: false, error: '$err');
    }
  }

  /// 上一拍读还在路上（见 [_dashboardTickOnce] 的防重入）
  bool _readingDashboard = false;

  /// 这一拍是**什么时候**开始的（[kReadLatchMax] 那道第二道锁的年龄判据）
  DateTime? _readingSince;

  /// 防重入闸**最多**能关多久（`_readingDashboard` 的年龄上限）。
  ///
  /// 为什么需要一道年龄锁：这道闸是 2026-10-23「用久了卡死」的一个**放大器**——
  /// `_readingDashboard` 一旦卡在 true，[_readDashboardSoon] 与 [_dashboardTickOnce]
  /// 都会在门口直接 return，而"排下一拍"在 tick 的**末尾**（`_scheduleDashboardTick`）
  /// ⇒ 心跳**再也不排下一拍**，界面读数就冻在最后一刻，而且再也没有任何一次请求会
  /// 去撞开它。请求现在自带时限（[kApiRequestTimeout]），`finally` 理论上一定能放掉它；
  /// 这一道是"万一那个 future 连时限都没走到"时的兜底——45 秒 = 时限的 3 倍，
  /// 正常路径永远碰不到它。
  static const Duration kReadLatchMax = Duration(seconds: 45);

  /// 这一拍还能不能再进（[true] = 上一拍还在路上，让位）。
  bool get _dashboardReadBusy {
    if (!_readingDashboard) return false;
    final since = _readingSince;
    if (since != null && DateTime.now().difference(since) <= kReadLatchMax) return true;
    // 年龄超了：当成"那一拍已经死了"，放行并留一笔（这条日志本身就是现场证据）
    guiLog.write('[wait] dashboard latch stale ${secsOf(DateTime.now().difference(since ?? DateTime.now()))}');
    _readingDashboard = false;
    _readingSince = null;
    return false;
  }

  /// 当前那两档节奏里的"慢档"取值（秒）：连得上 → [kOnlinePollSeconds]，断线 → [kOfflinePollSeconds]。
  /// 快档（[kTurnReadMs]）不在这里——它由 [_sleepAfterRead] 按当刻那一拍的结果算。
  int _pollSeconds = kOnlinePollSeconds;

  /// 按"现在连得上吗"调整心跳节奏：断线 → [kOfflinePollSeconds]（2 秒），恢复 → [kOnlinePollSeconds]。
  ///
  /// 为什么值得为"重启中"单独加快：壳已经画出来了，而重启期间最要紧的一件事就是
  /// **她回来了没有**——原来 10 秒一拍意味着她其实第 3 秒就起来了，界面还要装作断了 7 秒。
  /// 断线期间这一拍只是一条被立刻拒掉的回环请求（几毫秒），代价可以忽略。
  /// 恢复之后**必须**调回 10 秒：否则一次重启会让界面永久地每 2 秒打一次服务端。
  ///
  /// 它**只重排那一拍**（不再自己另起一条 periodic）：reads 的节奏归 [_sleepAfterRead] 一处管，
  /// 两处各排各的就会在同一刻撞出两条并发读。
  void _pollWhile({required bool ok}) {
    final want = ok ? kOnlinePollSeconds : kOfflinePollSeconds;
    final changed = want != _pollSeconds;
    _pollSeconds = want;
    if (!changed) return;
    _scheduleDashboardTick(Duration(seconds: want));
  }

  // ── turn 信号：别让"她在想"这句话等下一次心跳（用户 2026-10-16 ②） ──

  /// 一条事件流事件 → 要不要把 dashboard 提前读一遍。
  ///
  /// 只认**turn 的动静**（见 [isTurnSignalEvent]），别的（通道消息、快照、慢拍告警…）
  /// 一条都不理会：它们不改左上一行字，理会了就是白白重建一屏。
  void _onFeedEvent(Map<String, dynamic> event) {
    _eventsLive = true;
    // 记下水位：重连时把它当 `Last-Event-ID` 交给服务端补拉（见 [_lastEventSeq]）。
    // **只增不减**：补拉来的旧事件不会把这个水位往回带（否则每补一次都要重补一遍）。
    final seq = event['seq'];
    if (seq is num) {
      final value = seq.toInt();
      if (_lastEventSeq == null || value > _lastEventSeq!) _lastEventSeq = value;
    }
    // 服务端刚查过更新（12h 那一拍或设置页那颗按钮）：把现状读回来。
    // 它**不是** turn 信号——不参与"她在不在想"，也不该触发 dashboard 重读。
    if (event['type']?.toString() == 'update/checked') {
      unawaited(refreshUpdate());
      return;
    }
    if (!isTurnSignalEvent(event['type']?.toString())) return;
    if (_disposed || !ready) return;
    // 新的一段动静（本来没有信号 → 现在有）：**这一下要立刻读**，不能等合并窗口——
    // 她刚开口的那一刻正是最该跟手的一下（之后连串来的事件才走合并）。
    final rising = !_turnSignaled;
    _markTurnSignal();
    if (rising) {
      unawaited(_readDashboardSoon());
      return;
    }
    // 合并窗口：一步里成串来的事件只换一次重读（别一条一变地整表重建）
    if (_turnReadTimer != null) return;
    _turnReadTimer = Timer(Duration(milliseconds: turnSignalDebounceMs), () {
      _turnReadTimer = null;
      if (_disposed) return;
      unawaited(_readDashboardSoon());
    });
  }

  /// 立刻读一次 dashboard（事件驱动的入口）。
  ///
  /// 与那一拍**共用同一段实现**（[_readDashboard]）：多一条读法就多一处口径，
  /// 而"状态词从哪来"这件事只能有一处。
  ///
  /// 读完**要重排下一拍**——这一下正是"快档什么时候开始"的关键：那一拍可能是按慢档
  /// （10 秒）排着的，而这一读刚发现"她在跑"，重排才会把它收到 [kTurnReadMs]。
  /// 不重排的后果是实测出来的：她开始想之后，界面仍旧要等满 10 秒才动第二下
  /// （见 `test/brand_status_test.dart` 的"思考期按快档走"）。
  Future<void> _readDashboardSoon() async {
    if (_disposed || !ready || _dashboardReadBusy) return;
    _readingDashboard = true;
    _readingSince = DateTime.now();
    bool changed;
    try {
      changed = await _readDashboard();
    } finally {
      _readingDashboard = false;
      _readingSince = null;
    }
    if (_disposed || !ready) return;
    if (changed) notifyListeners();
    _scheduleDashboardTick(_sleepAfterRead());
  }

  /// 把"最近有 turn 动静"这条提示点亮（还没点亮才写时刻——每来一条都重写的话，
  /// 一条不断的流就能让提示永不过期，那正好是"靠猜时间窗"的翻版）
  void _markTurnSignal() {
    if (_turnSignaled) return;
    _turnSignaled = true;
    _turnSignalAtMs = DateTime.now().millisecondsSinceEpoch;
  }

  /// 这条提示在 [ms] 之内点亮过没有（见 [kTurnSignalHoldMs]）
  bool _turnSignalFreshWithin(int ms) =>
      _turnSignaled && DateTime.now().millisecondsSinceEpoch - _turnSignalAtMs <= ms;

  /// 服务端说"当刻没有 turn"时，把那条提示收掉（判据永远以响应为准）
  void _clearTurnSignal() => _turnSignaled = false;

  /// 掉线/回门时同时收掉事件流、合并窗口与那句"最近有动静"
  void _dropEventsFeed() {
    _eventsSub?.cancel();
    _eventsSub = null;
    _eventsRetry?.cancel();
    _eventsRetry = null;
    _turnReadTimer?.cancel();
    _turnReadTimer = null;
    _eventsLive = false;
    _clearTurnSignal();
  }

  /// 接上（或重连）事件流。**与心跳同一份生命周期**：进了壳才接、回门就断（见 [_dropEventsFeed]）。
  ///
  /// 为什么界面要多接一条流（而不是把心跳打得更密）：turn 的开始/结束、每一步的推进，
  /// 服务端本来就是**写事件**的，而事件到界面这段链路后端已经做到 250ms 级
  /// （`src/web/server.ts` 的 `SSE_POLL_MS`）。拿现成的推送当扳机、把 dashboard 读快一档，
  /// 比凭空把轮询打密可靠：快档只在 turn 活着时才开，她停下来就是原来的 10 秒。
  void _syncEventsFeed() {
    if (_disposed || !ready || _eventsSub != null) return;
    _eventsSub = api.events(lastEventId: _lastEventSeq).listen(
      _onFeedEvent,
      onError: (_) => _scheduleEventsRetry(),
      onDone: _scheduleEventsRetry,
    );
  }

  /// 事件流里**最后见过的那条 seq**（`null` = 一条都还没见过）。
  ///
  /// ★ 为什么要记它（用户 2026-10-16 ②「待机时那个思考标志还在」，实测根因）：
  /// 服务端**本来就支持断线补拉**（`src/web/server.ts` 的 `openStream`：带 `Last-Event-ID`
  /// 就从 `lastId + 1` 把漏掉的那一段重发一遍），但界面过去**从来不传**它
  /// （`api.events()` 签名里留着这个口子，两处调用都传 `null`）——于是 SSE 一断，
  /// 断线窗口里的事件就**永远补不回来**。而那里面最要命的一条正是 `turn/end`：
  /// 丢了它，聊天页那行「思考中」会一直挂着（它只认这条事件）。
  ///
  /// 补拉是**幂等**的：聊天页按 seq 去重（`_seen`），`AppState` 这一侧只认"有没有动静"。
  int? _lastEventSeq;

  void _scheduleEventsRetry() {
    _eventsSub = null;
    _eventsLive = false;
    if (_disposed || !ready) return;
    _eventsRetry?.cancel();
    _eventsRetry = Timer(const Duration(seconds: 3), () {
      _eventsRetry = null;
      if (_disposed || !ready) return;
      _syncEventsFeed();
    });
  }

  /// 下一拍隔多久读（**每一拍之后都重算**，所以它跟着 `openTurn` 走）。
  ///
  /// 档位与先后（顺序有讲究，见"验证过再快"那一条）：
  ///   · **没连上** ⇒ [kOfflinePollSeconds]（2 秒）：重启期间最要紧的是"她回来了没有"；
  ///   · **事件流没在推**（SSE 掉了）⇒ [kStaleTurnReadMs]（3 秒）：这一刻界面手上只有
  ///     一个"最近有动静"的旧提示，**没有**那条能在 250ms 内告诉她"她想完了"的推送，
  ///     所以不许快——宽限档既能把"她早停了"及时读回来，又不在坏链路上白打；
  ///   · **响应说她在跑**（[thinking]）⇒ [kTurnReadMs]（250ms）：思考这件事要跟手，
  ///     而她的"第几步"也在这条响应里。**这一档要求上面两条都不成立**——也就是说，
  ///     只有在事件流确实活着（"验证过"）的时候才按它打：快档配着推送才叫跟手，
  ///     单靠轮询打 250ms 只是空转（用户 2026-10-16 ②：别靠更频繁的整表重建）；
  ///   · 其余 ⇒ [kOnlinePollSeconds]（10 秒）：
  ///     包括"刚见过动静、但响应还没确认"（下一拍仍按慢档，读到什么由服务端说）。
  Duration _sleepAfterRead() {
    if (!online) return const Duration(milliseconds: kOfflinePollSeconds * 1000);
    if (!_eventsLive) return const Duration(milliseconds: kStaleTurnReadMs);
    if (_thinking) return const Duration(milliseconds: kTurnReadMs);
    return const Duration(milliseconds: kOnlinePollSeconds * 1000);
  }

  /// [_turnSignaled] 在 [ms] 之内点亮过没有（见 [kTurnSignalHoldMs]）。
  ///
  /// **不参与"她在不在思考"的判据**，只回答"这条链路上最近有没有动静"——
  /// 给测试与排查看的读数（判据永远来自服务端的响应）。
  bool turnSignalFreshWithin(int ms) => _turnSignalFreshWithin(ms);

  /// 排下一拍读（[Duration.zero] = 马上）
  void _scheduleDashboardTick(Duration delay) {
    _dashboardTick?.cancel();
    if (_disposed) return;
    _dashboardTick = Timer(delay, () {
      _dashboardTick = null;
      unawaited(_dashboardTickOnce());
    });
  }

  Future<void> _dashboardTickOnce() async {
    if (_disposed || !ready) return;
    // 防重入：事件成串来时 `_readDashboardSoon` 与这一拍可能撞在一起，
    // 而"同一份响应读两遍"没有任何用处（服务端那一份构造是真的要花 5ms 的）。
    // 让位的那一拍不补读：还在路上的那一拍回来时会照常排下一拍。
    // （`_dashboardReadBusy` 带年龄锁，见 [kReadLatchMax]：这道闸不许变成永久关死的那一扇门。）
    if (_dashboardReadBusy) return;
    _readingDashboard = true;
    _readingSince = DateTime.now();
    bool changed;
    try {
      changed = await _readDashboard();
    } finally {
      _readingDashboard = false;
      _readingSince = null;
    }
    if (_disposed || !ready) return;
    if (changed) notifyListeners();
    _scheduleDashboardTick(_sleepAfterRead());
  }

  /// 读一遍 dashboard，把**左上那一行字**与侧栏徽章要的几格写进本对象。
  ///
  /// 返回"这一读有没有真的改变界面"：没有改变就**不通知**——这是"思考期 250ms 一拍"
  /// 不变成"每秒整天重建"的关键（用户 2026-10-16 ② 的硬要求：不许靠更频繁地整表重建）。
  /// 判断只覆盖界面真的读的那几个字段；票数（tokensToday 之类）不在这里，它们由各页自己去读。
  Future<bool> _readDashboard() async {
    Map<String, dynamic>? stats;
    try {
      final data = await api.get('/api/stats/dashboard');
      stats = data is Map<String, dynamic> ? data : null;
    } on ApiAuthError catch (err) {
      // 凭据不作数了：**回登录态**（401 自愈已经在 IrmiaApi 里试过一轮重读 + 重试）。
      if (!_disposed) _requireAuth(err);
      return true;
    } catch (_) {
      final wasOnline = online;
      online = false;
      dotKind = 'offline';
      stateText = '连接中断';
      _thinking = false;
      _clearTurnSignal();
      _pollWhile(ok: false);
      return wasOnline || !_disposed; // 掉线总要让人看见（原来那一拍也是无条件通知）
    }
    if (stats == null) return false;

    final previousOnline = online;
    final previousThinking = _thinking;
    final previousOpenTurn = _openTurn;
    final previousStateText = stateText;
    final previousNote = stateNote;
    final previousSub = subText;
    final previousDot = dotKind;
    final previousReview = needsReview;
    final previousAsks = askCards;
    final previousAskTotal = askTotal;

    final state = stats['state'] as String?;
    final tiles = stats['tiles'];
    needsReview = tiles is Map ? ((tiles['needsReview'] ?? 0) as num).toInt() : 0;
    // 状态词**照抄服务端**（判据一处：`src/web/server.ts` 的 deriveState/livePausedLayers）。
    // 界面过去自己按 `paused` 那张词表拼"已暂停（预算耗尽）"——而那正是用户 2026-10-05
    // 看到的假话：她跑了十几个小时，左上角还写着"已暂停"（判据太松，见服务端的注释）。
    // 界面不再有第二份判断：服务端说 `stateText` 就照它显示；老服务端没这个字段时
    // 才退回词表（半升级态不至于一片空白）。
    final served = stats['stateText'];
    stateText = served is String && served.isNotEmpty
        ? served
        : IrmiaTheme.humanState(state, needsReview: needsReview);
    final note = stats['stateNote'];
    stateNote = note is String ? note : '';
    dotKind = state ?? 'idle';
    // **"她在思考吗"的判据**（界面这一侧唯一的一处）：服务端自己那句话的同一个响应里
    // `openTurn` 有值、且当刻状态就是 `running`——两条都成立时它给的 `stateText` 正是
    // 「Agent 正在值守」（`src/web/server.ts:1474-1483`），界面据此把它改说成「思考中」。
    // 不猜时间窗、不看进程在不在：她没在跑 turn 的时候这里必须是 false。
    _thinking = stats['openTurn'] != null && state == 'running';
    // 服务端当次读数里那个开着的 turn（给聊天页对账用，见 [openTurn] 的注释）：
    // 只认得上号的整数 turn；形状不对（老服务端 / 非对象）**照写成 null**——
    // 它是"服务端认为还有没有未收尾的 turn"，缺字段就是没有，不许拿上一次的值继续糊着。
    final openTurnRaw = stats['openTurn'];
    _openTurn = openTurnRaw is Map && openTurnRaw['turn'] is num
        ? '${(openTurnRaw['turn'] as num).toInt()}'
        : null;
    if (!_thinking) _clearTurnSignal();
    final days = stats['guardedDays'] ?? 0;
    final next = stats['nextWakeAt'];
    subText = '已运行 $days 天'
        '${next is String && next.isNotEmpty ? ' · 下次唤醒 ${hhmm(next)}' : ''}';
    // 她在问的卡跟着同一份响应走（不另开一条通道：这是全 app 唯一的心跳）
    final ask = stats['ask'];
    if (ask is Map) {
      final raw = ask['cards'];
      askCards = raw is List
          ? raw.map(AskCardData.fromJson).whereType<AskCardData>().toList(growable: false)
          : const <AskCardData>[];
      askTotal = ((ask['queued'] ?? askCards.length) as num).toInt();
    } else {
      // 老服务端（没有这个字段）时当作"没有卡"，而不是拿上一次的卡继续弹
      askCards = const <AskCardData>[];
      askTotal = 0;
    }
    online = true;
    _pollWhile(ok: true);
    return !previousOnline ||
        previousThinking != _thinking ||
        previousOpenTurn != _openTurn ||
        previousStateText != stateText ||
        previousNote != stateNote ||
        previousSub != subText ||
        previousDot != dotKind ||
        previousReview != needsReview ||
        previousAskTotal != askTotal ||
        // **按值比，不按引用**：`ask.cards` 每次解析都会新建一个 List，用 `identical`
        // 的话这里恒为 true ⇒ 250ms 快档里每一拍都通知一次，整棵 MaterialApp 跟着重建
        // （每秒 4 次）。`AskCardData` 的 `==` 是逐字段的值相等（见它的实现）。
        !listEquals(previousAsks, askCards);
  }

  /// 读一遍她的名字：`GET /api/persona/file?path=IDENTITY.md`（**复用现成的读端点**，
  /// 不新增服务端接口——理由见 her_name.dart 的文件头）。
  ///
  /// 什么时候读：拿到 token 时（[startPolling]）、引导第 1 步写完名字时、人格配置页保存后。
  /// 为什么不放进 10 秒的轮询里：为了"她在别处改了名字"每 10 秒读一趟人格文件不值——
  /// 那不是一条便宜的状态查询，而是一份会越来越长的人格正文。代价说清楚：从 CLI 或
  /// 她自己的提案改了名字，界面要重开一次才看到（界面上改的会立刻跟手）。
  ///
  /// 读不到时**保持上一次读到的值**，不清空：清空会让侧栏在服务端抖一下的瞬间闪回产品名。
  /// 从来没读到过就是 null，由 her_name.dart 决定显示什么（产品名，不是某个猜的名字）。
  Future<void> refreshHerName() async {
    String? next;
    try {
      final view =
          await api.get('/api/persona/file?path=${Uri.encodeComponent(kIdentityFile)}');
      final content = view is Map ? view['content'] : null;
      if (content is! String) return;
      next = herNameFromIdentity(content);
    } on ApiAuthError {
      // token 失效那一套由 pollOnce 负责说（这里不抢话）
      return;
    } catch (_) {
      return;
    }
    if (next == herName) return;
    herName = next;
    notifyListeners();
  }

  /// 读一遍 dashboard 并把变化通知出去——**对面那几条路共用的入口**。
  ///
  /// 谁在用：`answerAsk`（答掉一张卡之后立刻刷新）、引导/重连那几处显式刷新，
  /// 以及 [_dashboardTickOnce] 那一拍。为什么它们必须共用一段实现：状态词的判据只能有一处，
  /// 而"这一读要不要通知"也只能有一处——过去 `pollOnce` 与 [_readDashboard] 各写一遍同一份
  /// 解析，等于把同一个口径抄了两份，改一处就会漏另一处（那正是"10 秒 periodic 与快档并存"
  /// 当时的代价：同一份响应被两条链各解析一遍）。
  ///
  /// 职责边界：**只读、只通知**；排下一拍由调用方决定（心跳自排，事件驱动不自排）。
  Future<void> pollOnce() async {
    final changed = await _readDashboard();
    if (changed && !_disposed) notifyListeners();
  }

  /// 按注册表 id 切页；未知 id 视为无效操作，保持当前页。
  ///
  /// [section] 可选：目标页要落在**哪一段**（认识的页会消费，见 [takeSectionFor]）。
  /// 为什么需要它：`Suggestion.act` 的四个动作里有一个要落在目标页的某一段
  /// （`goto-tools` → 扩展页的「工具」分组）。只切页的话人落在页首、还得自己找那一段——
  /// 那等于把"去处理"缩水成"去那一页"。
  void setPage(String id, {String? section}) {
    if (pageEntryById(id) == null) return;
    if (section != null) _pendingSection = (page: id, section: section);
    if (pageId == id) {
      // 同一页也要通知一次：落点提示刚写进去，目标页正等这一拍把它取走
      if (section != null) notifyListeners();
      return;
    }
    pageId = id;
    // 排障留痕：卡死时日志里最后一页是哪个页面（`[wait] … page=` 那行读的是同一个值）。
    // `tracePage` 顺带把"切页 <这一页叫什么>"记成 `last`，供 `[stall]` 那行引用。
    tracePage(id, label: pageEntryById(id)?.label);
    notifyListeners();
  }

  /// 跨页跳转的**落点**：`(页面 id, 那一段)`。由目标页取用一次即清——留着的话，
  /// 下一次进这一页会白跳一次（人按的是左侧导航，不是建议卡）。
  ({String page, String section})? _pendingSection;

  /// 目标页取走落点提示；**不是给自己的就留着**（同一个提示只服务一个页面）。
  /// 返回非 null = 这一次要落到那一段。
  String? takeSectionFor(String page) {
    final pending = _pendingSection;
    if (pending == null || pending.page != page) return null;
    _pendingSection = null;
    return pending.section;
  }

  /// 答复她在问的那一条：`POST /api/commands/answer` 带上 `askSeq`。
  ///
  /// 为什么必须带 askSeq：台面上可能同时摆着她问的卡与一条待批准的计划，服务端凭这个 seq
  /// 才知道人答的是哪一条（§6 的一张卡一层含义）。返回 null = 记上了；返回文字 = 失败原因
  /// （卡还在，再答一次即可，不静默吞掉）。
  Future<String?> answerAsk(int askSeq, String answer) async {
    try {
      await api.post('/api/commands/answer', {'answer': answer, 'askSeq': askSeq});
    } on ApiAuthError catch (err) {
      return err.message;
    } catch (err) {
      return '$err';
    }
    // 立刻刷新：答掉一张之后，排队里的下一张该马上浮上来（等 10 秒的轮询会让人以为卡丢了）
    await pollOnce();
    return null;
  }

  void toggleTheme() {
    themeMode = themeMode == ThemeMode.light ? ThemeMode.dark : ThemeMode.light;
    notifyListeners();
  }

  /// 保存「她被怎么称呼」：`POST /api/commands/set-mention-keywords`。
  ///
  /// 返回 null = 写进去了；返回文字 = 失败原因（界面照实弹出来，不静默吞掉）。
  /// 服务端会热更运行期那份判据（`onMentionKeywords`），所以**改完下一句消息就生效**——
  /// 这几个词本来就是要当场试的。
  Future<String?> saveMentionKeywords(List<String> keywords) async {
    try {
      await api.post(
        '/api/commands/set-mention-keywords',
        {'keywords': keywords},
        confirm: 'set-mention-keywords',
      );
    } on ApiAuthError catch (err) {
      return err.message;
    } catch (err) {
      return '$err';
    }
    return null;
  }

  static String hhmm(String iso) {
    final dt = DateTime.tryParse(iso)?.toLocal();
    if (dt == null) return '';
    return '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  }

  @override
  void dispose() {
    _disposed = true;
    // 快档那一拍与事件流也是活的：不收掉的话，退场之后它们还打服务端
    // （测试里表现为 pending timer —— 与下面 `_gateRetry` 同一条理由）
    _dashboardTick?.cancel();
    _dashboardTick = null;
    _dropEventsFeed();
    // 读待批清单那条轮询同理（10 秒一拍，不收掉就是退场之后还在打 `/api/grants`）
    _stopGrantPolling();
    _grantPoller?.dispose();
    _grantPoller = null;
    // 门前那条重连定时器也是活的：不收掉的话，退场之后它还打服务端（测试里表现为 pending timer）
    _gateRetry?.cancel();
    // 门上"等后端就绪"那一条节拍器同理（1 秒一格，不收掉就是退场之后还在探）
    _backendRetry?.cancel();
    _backendRetry = null;
    // 看门狗是进程级的，但它读的是这个 AppState（页面/在飞清单）：这个对象退场之后就不该再读
    StallWatch.instance.stop();
    super.dispose();
  }
}

/// 一次批准/驳回的**回执**（`POST /api/commands/grant-decide` 的响应，逐格转述）。
///
/// 存在的理由只有一条：**"批了"不等于"装上了"**。服务端在批准那一支会当场执行
/// （写配置 / 建目录 / 移回收站），执行结果在 `exec.state` 里：
/// `ok` 才算落地，`failed` / `skipped-*` 都是"决定记上了、但东西没成"。
/// 卡上那一行与 toast 必须把这两种情况分开说（判据在 `pages/extensions_page.dart`
/// 的 `_decideGrant`，与这里同一套口径）。
class GrantDecision {
  const GrantDecision({
    required this.recorded,
    this.outcome = '',
    this.execState = '',
    this.failure = '',
    this.restartRequired = false,
    this.error,
  });

  /// 决定**记上了**吗：false = 请求没落地（卡要留着，人再点一次就行）
  final bool recorded;

  /// `approved` / `rejected`
  final String outcome;

  /// `ok` / `failed` / `skipped-stale` / `skipped-invalid` / `not-applicable`
  final String execState;

  /// 执行失败的原因（`exec.failure`；服务端没给时为空）
  final String failure;

  /// 这份改动要重启主进程才生效（服务端说的，界面不自己猜）
  final bool restartRequired;

  /// [recorded] 为 false 时的原因（网络/接口错误那一句）
  final String? error;
}

/// 她问的那张卡（`/api/stats/dashboard` 的 `ask.card`）。
///
/// 字段只有四个 + 一个超时标记，**没一个能改卡的样子**：标题、按钮、说明全是界面写死的
/// （design §6 防伪——她只能决定问什么）。多出来的字段一律不读：服务端将来加字段时，
/// 界面不会因为"多了个 title/acceptLabel"就把系统口吻交给不可信内容。
class AskCardData {
  const AskCardData({
    required this.seq,
    required this.question,
    required this.context,
    required this.expiredAt,
  });

  /// `human/asked` 的 seq：答复时带回服务端，配对用
  final int seq;
  /// 她的原话（问题）
  final String question;
  /// 她的原话（为什么问、查到哪一步）
  final String context;
  /// 非空 = 已超时无人答（**未批准、未拒绝**：她已收到这条事实，卡仍然有效）
  final String? expiredAt;

  /// **按值相等**（逐字段），不是按引用。
  ///
  /// 为什么要它：`_readDashboard` 判"这一读有没有变化"时比的是「上一份卡」与「这一份卡」。
  /// `ask.cards` 每次从 JSON 解析都会新建一个 List，引用永远不同——用 `identical` 比的话
  /// 每一拍都算"变了"，250ms 快档里就是每秒 4 次 `notifyListeners`、整棵 `MaterialApp` 重建。
  /// 值相等之后，同一份数据喂两遍只通知一次（见 `test/brand_status_test.dart`）。
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AskCardData &&
          other.seq == seq &&
          other.question == question &&
          other.context == context &&
          other.expiredAt == expiredAt;

  @override
  int get hashCode => Object.hash(seq, question, context, expiredAt);

  /// 服务端给的 JSON → 模型；形状不对时返回 null（宁可不弹，也不弹一张字段是猜的卡）
  static AskCardData? fromJson(dynamic raw) {
    if (raw is! Map) return null;
    final seq = raw['seq'];
    final question = raw['question'];
    if (seq is! num || question is! String || question.trim().isEmpty) return null;
    final context = raw['context'];
    final expired = raw['expiredAt'];
    return AskCardData(
      seq: seq.toInt(),
      question: question,
      context: context is String ? context : '',
      expiredAt: expired is String && expired.isNotEmpty ? expired : null,
    );
  }
}

/// 门在 `auth_gate.dart`：**首次设密码 / 登录** 两态。
///
/// 这里过去是 `TokenGate`——一张"粘贴启动时输出的 token"的卡片。它随着本地认证换成密码
/// 一起退休了：用户要的是「不需要 token，首次启动的时候要求用户设置密码就行了」。
/// 门本身（含"这道门防的是什么"那段如实说明）搬去了 auth_gate.dart，视觉沿用同一套。
