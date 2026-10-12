import 'dart:async';
import 'shell/tray.dart';
import 'dart:io';

import 'package:flutter/material.dart';

import 'api.dart';
import 'ask_card.dart';
import 'auth_gate.dart';
import 'her_name.dart';
import 'home.dart';
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
import 'session_store.dart';
import 'theme.dart';
import 'title_bar.dart';
import 'ui_state.dart';

/// 「该设密码了」那张卡被按过「以后再说」的事实（与引导、"更多"折叠组同一份 ui-state.json）
const String kPasswordPromptDoneFlag = 'password-prompt-done';

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

/// GUI 外壳与全局状态。页面在 pages/ 下，通过 AppState 拿数据与会话凭据。
/// 结构规格：docs/gui-design.md §3。
class IrmiaApp extends StatefulWidget {
  const IrmiaApp({super.key});

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

  @override
  void initState() {
    super.initState();
    final port = Platform.environment['IRMIA_WEB_PORT'] ?? '7788';
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:$port'));
    // **不在这里决定画哪一态**：凭据按实例分文件存，而"我是哪个实例"只有服务端知道。
    // 所以先空手问一次（bootstrap），拿回实例标识与 `code` 之后才知道该弹"设置密码"还是"登录"。
    unawaited(state.bootstrap());
    // **托盘接线**（2026-10-04）：菜单里的「重启前后端」复用界面这条命令通道，
    // 与运行情况页那颗按钮走同一个后端动作（免得两处各写一份重启逻辑）。
    // 放在 initState 里而不是 main()：这里拿得到 state.api（凭据也在这一步就位）。
    // 门还没进的时候它也照装：托盘是窗口的财产，不归"登录了没有"管。
    unawaited(IrmiaTray.instance.install(
      post: (command, payload) => state.api.post(
        '/api/commands/$command',
        payload,
        confirm: command,
      ),
      // 托盘那条「重启前后端」也要**有反馈**（用户 2026-10-05：「点了没有反馈」）。
      // 托盘点击时窗口可能收着，弹 toast 没有落点；但结论照旧要落地——服务端那句
      // `note` 是**唯一一处**判据（成功带真实新 pid 与端口、失败带原因、未确认就说未确认），
      // 这里原样记下来，不加工、不粉饰（debugPrint 会进 release 日志）。
      onRestartResult: (result) {
        final map = result is Map ? result : const {};
        final note = map['note']?.toString() ?? '重启已发出（服务端没有给出结论）';
        debugPrint('[托盘·重启前后端] $note');
      },
      // 托盘提示里是**她的名字**（读不到时由 her_name.dart 决定显示什么）
      displayName: state.herDisplayName,
    ));
    // 名字是异步读来的（`persona/IDENTITY.md`），读到之后托盘提示也跟着换一次；
    // 每次轮询都会调到这里，而 setDisplayName 在值没变时直接返回（不做无用的系统调用）
    state.addListener(_syncTrayName);
  }

  /// 状态一变就把她的名字同步给托盘（真正的判断在 [IrmiaTray.setDisplayName] 里）
  void _syncTrayName() => unawaited(IrmiaTray.instance.setDisplayName(state.herDisplayName));

  @override
  void dispose() {
    state.removeListener(_syncTrayName);
    state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        return MaterialApp(
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
          // 自绘标题栏画在所有页面之上（含那道门）：窗口已经没有系统标题栏，
          // 这条既是标题也是唯一的拖动区（docs/gui-revision.md ①）。
          builder: (context, child) => Column(
            children: [
              const IrmiaTitleBar(),
              Expanded(child: child ?? const SizedBox.shrink()),
            ],
          ),
          // 门与壳的切换只看 `ready`：它由 bootstrap/登录/设密码/401 自愈四处共同维护，
          // 不在 build 里再算一遍判据（两处判据必然漂移，而漂移的表现就是"白屏"）。
          home: state.ready
              // 四层宿主包住整壳，从外到内：
              //   · OnboardingHost —— 首次启动引导（一次性的，判据见 onboarding.dart）；
              //   · PasswordPromptHost —— 「该设密码了」的首次提示（只对凭老凭据进门的人弹，
              //     见 password_prompt.dart：不弹的话那条老路会一直能用，密码就没人设了）；
              //   · MentionPromptHost —— 「她怎么被称呼」的首次提示；
              //   · AskCardHost —— 她此刻在问的那张卡（每次都来）。
              // 引导放最外层：它是"第一次用的人"最先该看到的东西，而它读的现状（人格种子、
              // 密钥、通道）全都要先有会话凭据——所以它也只能在那道门之后（见 onboarding.dart 顶部）。
              ? OnboardingHost(
                  state: state,
                  child: PasswordPromptHost(
                    state: state,
                    child: MentionPromptHost(
                      state: state,
                      child: AskCardHost(state: state, child: HomeShell(state: state)),
                    ),
                  ),
                )
              : AuthGate(state: state),
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

  Timer? _poll;

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
          // 提醒一次"该设密码了"（按过「以后再说」就不再打扰）
          needsPasswordPrompt = !await loadFlag(kPasswordPromptDoneFlag);
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
    _poll?.cancel();
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
    _poll?.cancel();
    _gateRetry?.cancel();
    _gateRetry = null;
    api.token = null;
    final key = instance;
    if (key != null) sessions.clear(key);
    ready = false;
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
    _poll?.cancel();
    ready = false;
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
    _poll?.cancel();
    unawaited(pollOnce());
    // 名字跟着同一条生命周期的起点读一次（她改名走界面那几条路时会再读，见 refreshHerName）
    unawaited(refreshHerName());
    _pollSeconds = kOnlinePollSeconds;
    _poll = Timer.periodic(Duration(seconds: _pollSeconds), (_) => unawaited(pollOnce()));
  }

  /// 心跳的当前间隔（秒），跟着连接状态走：断线时快、正常时慢（见 [_pollWhile]）
  int _pollSeconds = kOnlinePollSeconds;

  /// 按"现在连得上吗"调整心跳节奏：断线 → [kOfflinePollSeconds]（2 秒），恢复 → [kOnlinePollSeconds]。
  ///
  /// 为什么值得为"重启中"单独加快：壳已经画出来了，而重启期间最要紧的一件事就是
  /// **她回来了没有**——原来 10 秒一拍意味着她其实第 3 秒就起来了，界面还要装作断了 7 秒。
  /// 断线期间这一拍只是一条被立刻拒掉的回环请求（几毫秒），代价可以忽略。
  /// 恢复之后**必须**调回 10 秒：否则一次重启会让界面永久地每 2 秒打一次服务端。
  void _pollWhile({required bool ok}) {
    final want = ok ? kOnlinePollSeconds : kOfflinePollSeconds;
    if (want == _pollSeconds) return;
    _pollSeconds = want;
    _poll?.cancel();
    _poll = Timer.periodic(Duration(seconds: want), (_) => unawaited(pollOnce()));
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

  Future<void> pollOnce() async {
    try {
      final stats = await api.get('/api/stats/dashboard');
      if (stats is Map<String, dynamic>) {
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
        final days = stats['guardedDays'] ?? 0;
        final next = stats['nextWakeAt'];
        subText = '已运行 $days 天'
            '${next is String && next.isNotEmpty ? ' · 下次唤醒 ${hhmm(next)}' : ''}';
        // 她在问的卡跟着同一个轮询走（不另开一条通道：这是全 app 唯一的心跳）
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
      }
      online = true;
      _pollWhile(ok: true);
    } on ApiAuthError catch (err) {
      // 凭据不作数了：**回登录态**（401 自愈已经在 IrmiaApi 里试过一轮重读 + 重试）。
      // 过去这里只是把 token 清掉、留一句状态话，人就卡在一片空白的壳里——那正是"突然进不去"。
      _requireAuth(err);
      return;
    } catch (_) {
      online = false;
      dotKind = 'offline';
      stateText = '连接中断';
      _pollWhile(ok: false);
    }
    notifyListeners();
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
    _poll?.cancel();
    // 门前那条重连定时器也是活的：不收掉的话，退场之后它还打服务端（测试里表现为 pending timer）
    _gateRetry?.cancel();
    super.dispose();
  }
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
