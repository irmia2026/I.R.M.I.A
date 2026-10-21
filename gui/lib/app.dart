// TODO(i18n): 本文件还有 32 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/app.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'shell/tray.dart';
import 'dart:io';

import 'package:flutter/foundation.dart' show listEquals;
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
// 托盘的「退出全部」与「显示/收进托盘」要直接操作窗口（托盘自己只认菜单，见 shell/tray.dart）
import 'package:window_manager/window_manager.dart';

import 'api.dart';
import 'ask_card.dart';
import 'auth_gate.dart';
// 「退出全部」真的停后端那一步（端口 → pid → taskkill 树），判据与代价见那个文件
import 'backend_stop.dart';
// 「这次是我主动退的，别把我拉回来」（协议见 docs/gui-guard.md §3）
import 'gui_quit.dart';
// 待批的**那一份数据**（风险分级 / 判据 / 顺序 / 轮询）与右下角那一摞卡
// （壳一级：左侧「扩展」角标、托盘首项、右侧通知卡读的都在这两份文件里）
import 'grant_inbox.dart';
import 'grant_inbox_overlay.dart';
import 'her_name.dart';
import 'home.dart';
import 'i18n/app_strings.dart';
import 'i18n/strings_override.dart';
import 'i18n/strings_scope.dart';
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
import 'theme.dart';
import 'title_bar.dart';
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
/// 为什么这么密（0.3~1 秒）：本地回环上一次连接被拒是几毫秒的事，重启后端口通常几秒内就起来；
/// 密一点只是几个毫秒级的本地 syscall，而"她回来了"能早一秒上屏就早一秒。
/// 上限 1 秒是别再密下去：这个窗口里界面还什么都没画出来，打太快没有收益。
const List<double> kGateRetryDelays = [0.3, 0.5, 0.8, 1];

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
/// 而不是等人回来按那颗「重试」。3 秒是慢速与"够快"之间的折中。
const int kGateSlowRetrySeconds = 3;

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
    final port = Platform.environment['IRMIA_WEB_PORT'] ?? '7788';
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:$port'));
    // **不在这里决定画哪一态**：凭据按实例分文件存，而"我是哪个实例"只有服务端知道。
    // 所以先空手问一次（bootstrap），拿回实例标识与 `code` 之后才知道该弹"设置密码"还是"登录"。
    unawaited(state.bootstrap());
    // **托盘接线**（2026-10-04，2026-10-17 改）：菜单五项、四个动作都由这里注入——
    // 托盘自己只认菜单与插件（见 shell/tray.dart 的文件头：两项退出为什么必须分开）。
    // 放在 initState 里而不是 main()：这里拿得到 state.api（凭据也在这一步就位）。
    // 门还没进的时候它也照装：托盘是窗口的财产，不归"登录了没有"管。
    unawaited(IrmiaTray.instance.install(
      actions: TrayActions(
        show: () {
          unawaited(windowManager.show());
          unawaited(windowManager.focus());
        },
        hide: () => unawaited(windowManager.hide()),
        // 与首页那颗「重启前后端」**同一个函数**：请求、三态判据、说的话、等回来的窗口只有一份
        restart: _restartFromTray,
        // 「退出界面」= 老行为：写标记（别让保活把我拉回来）→ 收托盘 → 关窗。后端一个字节都不动
        quitUi: _quitUi,
        // 「退出全部」= 界面 + 后端（含它拉起的协议端）；确认框把硬杀的代价说清
        quitAll: () => unawaited(_quitAll()),
        // 菜单首项「有 N 条待批」：窗口先摆出来，再落到扩展页（那一页能一次看完并逐条批）。
        // 这是**人自己点的**，所以显示 + 聚焦窗口是对的——与通知卡"不许抢焦点"不冲突。
        openPending: () {
          unawaited(windowManager.show());
          unawaited(windowManager.focus());
          state.setPage('extensions');
        },
        // 「有新版本」那一项：显示窗口并落到设置页（「关于」里有检查更新与查看）。
        // **不直接开浏览器**：托盘是原生菜单，点一下就把浏览器拉起来太突然；
        // 真正打开外链只有人工按的那颗「查看」/「检查更新」。
        openUpdate: () {
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
    await IrmiaTray.instance.remove();
    try {
      await windowManager.destroy();
    } catch (err) {
      debugPrint('关窗失败：$err');
    }
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
  AppState({required this.api, SessionStore? sessions}) : sessions = sessions ?? SessionStore() {
    // **401 自愈的接线点**：服务端说这张票不作数时，重读这个实例的凭据文件再试一次。
    // 为什么值得这么做：改了密码（所有旧会话作废）、或在别处登出过之后，人**不该被要求重启界面**。
    api.onUnauthorized = _rereadCredential;
  }

  final IrmiaApi api;
  final SessionStore sessions;

  /// 已进门了吗。false = 画那道门（见 [AuthGate]）。
  bool ready = false;
  /// 门上画哪一态（只在 `ready == false` 时有意义）
  AuthGateKind gate = AuthGateKind.checking;
  /// 门上那行错误（密码不对、两次不一致、连不上…）；空 = 没问题
  String gateError = '';
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
  /// 这也解释了为什么服务端**不需要**另开一条公开的"我是谁"端点：
  /// 「待初始化时只放行设置密码这一条路」那条纪律因此一个字都不用让步。
  Future<void> bootstrap() async {
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
      // 服务端**答了话**（500 之类）：它在那，只是这条路现在不通。这种失败不会随时间自己好，
      // 所以不当成"还在启动"，当场说话（判据见 _onConnectFailure）
      _onConnectFailure(err, connection: false);
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
        _onLegacyToken = false;
        startPolling();
        notifyListeners();
        return;
      } on ApiAuthError catch (err) {
        code = err.code;
        instance = err.instance ?? instance;
      } on ApiError catch (err) {
        _onConnectFailure(err, connection: false);
        return;
      } catch (err) {
        _onConnectFailure(err, connection: true);
        return;
      }
      // 这张票已经**证明**不作数了：从盘上清掉。留着只会让每次开界面都白跑一趟，
      // 也让下面的"自愈重读"每次都拿到同一张废票。
      final current = instance;
      if (current != null) sessions.clear(current);
    }

    // ③ 还没设密码：先试一次**老界面那份全局凭据**（升级期的兜底，见 session_store.dart）。
    // 为什么值得留着这条路：后端口径换了、界面也换了的时候，人手上唯一还有效的东西就是它；
    // 没有它，界面会停在"设置密码"那一屏——设一个当然也能进，但那等于用升级把人挡在门外一次。
    // 它只在"服务端说还没设密码"时才有意义：设过密码之后旧 token 当场作废，试也白试。
    if (code == 'auth-uninitialized') {
      final legacy = readLegacyGuiToken();
      if (legacy != null) {
        api.token = legacy;
        try {
          await api.get('/api/projection');
          _markGateOpen();
          ready = true;
          gateError = '';
          _onLegacyToken = true;
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
          _onConnectFailure(err, connection: false);
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
    // `auth-uninitialized` = 这台实例从来没设过密码 → 弹"设置密码"；其余一律登录态。
    gate = code == 'auth-uninitialized' ? AuthGateKind.setup : AuthGateKind.login;
    gateError = '';
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
    gateAttempt = 0;
    gateWaited = 0;
    gateRetrying = false;
    gateUnreachable = false;
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
    gateError = '';
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

  /// 登出：撤掉服务端那条会话、清掉**本实例**那份凭据、回到门上。
  ///
  /// 顺序有讲究：撤销请求要用手上那张票，所以**先发请求、再清票**——反了就只能本地登出，
  /// 服务端那条会话还活着（那张票被别人捡到照样能用）。
  ///
  /// 但撤销失败**也照样登出**：本机这份凭据已经没人再用了，把它留在盘上才是真的问题
  /// （"登出之后界面还能自己进去"）。失败静默，因为此刻壳正在收起来——弹什么都挂不住；
  /// 而且这件事的后果是明确的：那张票在本地已经不存在了，人下次要用密码重新登录。
  ///
  /// 回到门上的哪一态按**这次是怎么进来的**定：凭老 token（没设过密码）进来的话，
  /// 服务端根本不认这条注销请求（它会回 409 legacy-token：那串东西没有会话可撤），
  /// 这时候画"登录"是个死胡同——那台实例还没有密码，得画"设置密码"。
  Future<void> logout() async {
    try {
      await api.postAuth('/api/auth/logout', {'label': 'gui'});
    } catch (_) {
      // 见上：撤销没成功也不影响"本地登出"这件事，如实继续
    }
    _dashboardTick?.cancel();
    _dashboardTick = null;
    _dropEventsFeed();
    _gateRetry?.cancel();
    _gateRetry = null;
    // 待批那份清单属于"这一次登录"，回门就一起收掉（不然重新进门时会先闪一下旧单子）
    _stopGrantPolling();
    api.token = null;
    final key = instance;
    if (key != null) sessions.clear(key);
    ready = false;
    _thinking = false;
    gate = _onLegacyToken ? AuthGateKind.setup : AuthGateKind.login;
    gateError = '';
    gateAttempt = 0;
    gateWaited = 0;
    gateRetrying = false;
    gateUnreachable = false;
    online = false;
    dotKind = 'offline';
    stateText = '已登出';
    notifyListeners();
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
  Future<void> _enter(String path, String password) async {
    gateBusy = true;
    gateError = '';
    notifyListeners();
    try {
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
        _onLegacyToken = false;
        needsPasswordPrompt = false;
        notifyListeners();
        startPolling();
        return;
      }
    } on ApiAuthError catch (err) {
      // 服务端的话就是最准的话（"密码至少 6 位…"、"密码不对。"），照原样显示
      if (err.instance != null) instance = err.instance;
      gateError = err.message;
    } on ApiError catch (err) {
      gateError = err.message;
    } catch (err) {
      gateError = '连不上本地服务：$err';
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
    gate = err.needsSetup ? AuthGateKind.setup : AuthGateKind.login;
    gateError = err.message;
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
    final poller = _grantPoller ??= PendingGrantPoller(api: api, onPending: applyPendingGrants);
    poller.start();
  }

  /// 收掉那条轮询（回门 / 退场）。[clear] 为真时连手上那份清单一起清掉。
  void _stopGrantPolling({bool clear = true}) {
    _grantPoller?.stop();
    if (clear) pendingGrants = const <Map<String, dynamic>>[];
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
    if (_disposed || !ready || _readingDashboard) return;
    _readingDashboard = true;
    bool changed;
    try {
      changed = await _readDashboard();
    } finally {
      _readingDashboard = false;
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
    if (_readingDashboard) return;
    _readingDashboard = true;
    bool changed;
    try {
      changed = await _readDashboard();
    } finally {
      _readingDashboard = false;
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
