/// 界面文案表（i18n）。
///
/// ## 为什么是自建表，不是 `intl` + codegen
///
/// 这个界面的规模：全部硬编码中文字符串字面量 **1760 条**（`gui/lib/**` 里含 CJK 的
/// 字符串字面量，去掉注释行后统计），分布在 32 个文件；最重的三处是 settings_page 435、
/// extensions_page 234、channels_page 160。**一个使用者**，Windows 桌面端，没有复数、
/// 没有性别、没有 RTL、没有日期格式分叉。
///
/// codegen 方案（`flutter gen-l10n` / ARB）买到的是：编译期检查键名、复数规则、按 locale
/// 拆文件、与 `intl` 的日期数字格式联动。代价是：一条命令链（`l10n.yaml` + `flutter
/// gen-l10n` + 生成物进 VCS 或进 build）＋ 每次加一句话都要重新生成。
///
/// 本轮选择：**一个 abstract class + 两份实现**。理由按重要性排：
///   1. **键名照样编译期检查**——`EnStrings` 不实现某个 getter，`flutter analyze` 直接报错。
///      这是 codegen 唯一真正给到我们的东西，而抽象类本来就给；
///   2. **没有生成步骤**：改一句文案 = 改一个文件，`flutter test` 立刻能跑；
///   3. 复数/RTL/日期格式本轮都用不上；真要用时（比如英文的 "1 message" / "3 messages"）
///      加一个 `String nMessages(int n)` 就是，不需要换框架。
///
/// 唯一加依赖的地方是 `flutter_localizations`：它提供的 `MaterialLocalizations` 中文文案
/// 我们自己造不出来（文本框的剪切/复制/粘贴菜单、日期与滚动条的无障碍标签都在那个包里）。
/// 见 `pubspec.yaml` 的注释与 `app.dart` 的 `localizationsDelegates`。
///
/// ## 三件**不许**进这张表的东西
///
/// 1. **她的人设文案**（`persona/IDENTITY.md`、`onboarding.dart` 的人格种子、
///    `persona_page.dart` 的默认人格正文）——那是她要成为谁，是内容，换语言也不该换；
/// 2. **她的发言与记忆正文**（聊天页的气泡、`memory_page.dart` 的记忆条目、
///    工具结果、事件日志的 `detail`）——那是她说过的话，界面无权翻译；
/// 3. **她说话的口吻**（`docs/copy-guide.md` 的语气词、`her_name.dart` 的回退名）——
///    "她怎么称呼人"是她的风格，不是 UI 的一层皮。名字是**数据**（`IDENTITY.md` 里那一行）。
///
/// ## 怎么加一句话
///
/// ```dart
/// // 1. 在 AppStrings 里加一个 getter（带参数就写成方法）
/// String get save;            // 2. ZhStrings 与 EnStrings 各实现一次，漏了 analyze 会报
/// ```
///
/// 页面里取用：`final s = IrmiaStrings.of(context);` 然后 `Text(s.save)`。
/// **不要在页面里写中文**——迁移没做完的页面在文件头挂了 `TODO(i18n)`，见
/// `docs/i18n-migration.md` 的清单。
library;

import 'dart:ui' show Locale;

/// 一种语言的可选值（持久化到 `ui-state.json` 的就是 [code]）。
enum AppLanguage {
  /// 跟随系统（`system`）
  system('system'),

  /// 中文（`zh`）
  zh('zh'),

  /// English（`en`）
  en('en');

  const AppLanguage(this.code);

  /// 落盘的取值。**改它就是改契约**：老配置文件里读不到就当 [system]。
  final String code;

  /// 从盘上读回：认不出的值一律回 [system]（读坏不该把界面卡住）
  static AppLanguage fromCode(String? code) {
    for (final value in AppLanguage.values) {
      if (value.code == code) return value;
    }
    return AppLanguage.system;
  }

  /// 具体语言码（`system` 已经由 [resolve] 解析过，这里只给 zh/en）
  String get languageCode => this == AppLanguage.en ? 'en' : 'zh';

  /// 语言选择器上的名字。
  ///
  /// **每一条都用自己的语言写**（中文那项写"中文"、英文那项写"English"）——
  /// 切到英文之后还看得见"中文"，才能切回来。这是唯一一处不做翻译的文案。
  String get endonym => switch (this) {
        AppLanguage.system => 'system',
        AppLanguage.zh => '中文',
        AppLanguage.en => 'English',
      };

  /// 把「跟随系统」解析成具体语言。
  ///
  /// [systemLocale] 由**入口**（`main.dart`）给一次，widget 树里再也不用读平台 locale——
  /// 这样 widget 测试的默认语言是确定的（中文），不会因为跑测试的机器是英文系统而全红。
  ///
  /// 认不出系统的语言时**落到中文**：这是界面的作者语言，也是"跟随系统"在没有更好
  /// 依据时的最小惊讶选择（不会因为一次系统设置变化就把整个界面变成看不懂的字）。
  AppLanguage resolve(Locale? systemLocale) {
    if (this != AppLanguage.system) return this;
    final code = (systemLocale?.languageCode ?? '').toLowerCase();
    if (code == 'en') return AppLanguage.en;
    return AppLanguage.zh;
  }
}

/// 全部界面文案。**两份实现必须一一对应**（漏一个 `flutter analyze` 就报）。
///
/// 命名口径：`<区域><东西>`，比如 `chatEmptyTitle`、`settingsLanguage`。
/// 参数用命名位置参数（`String expandAll(int chars)`），不要拼接——
/// 英文语序与中文不同，页面里拼字符串就等于把语序写死成中文。
abstract class AppStrings {
  const AppStrings();

  /// 这份文案属于哪种具体语言（`system` 不会出现在实现里）
  AppLanguage get language;

  /// 对应的 `Locale`（交给 `MaterialApp.locale`）
  Locale get locale => Locale(language.languageCode);

  /// **覆盖层的版次**（0 = 这一份是默认文案，没有任何覆盖）。
  ///
  /// 只有 `OverriddenStrings`（见 `i18n/strings_override.dart`）会给出非 0 值。
  /// 它存在的唯一理由：语言没变、但用户点了「重新载入文案」——那时
  /// `IrmiaStrings.updateShouldNotify` 必须让读过文案的 widget 重建，否则按下按钮
  /// 屏幕上什么都不会变（见 `i18n/strings_scope.dart`）。
  int get revision => 0;

  // ── 通用（三态、按钮）────────────────────────────────────────────────
  /// 重试
  String get retry;

  /// 取消
  String get cancel;

  /// 确认
  String get confirm;

  /// 保存
  String get save;

  /// 加载中（区块三态的默认那句）
  String get loading;

  /// 出错了（区块三态没有具体原因时的兜底）
  String get error;

  /// 没有内容（空态兜底）
  String get empty;

  /// 折叠：收起
  String get collapse;

  /// 展开全部（N 字）
  String expandAll(int chars);

  /// "加载失败"的通用前缀（后面接原因）
  String loadFailed(String reason);

  /// 设置页正在读配置
  String get settingsLoadingConfig;

  /// 配置读取失败：<原因>
  String configReadFailed(String reason);

  // ── 等待与超时（2026-10-24，「GUI 用久了会卡死」那一批）──────────────
  //
  // 这一组回答的是"卡住了"这件事本身：**在等哪条请求、等了多久、等不到了怎么办**。
  // 它们必须落在文案表里（而不是 `api.dart` 里拼字符串），因为它们是给人读的界面话，
  // 而 `api.dart` 是传输层——那一层连"现在是什么语言"都不该知道，它只把
  // [request] 这样的原样串（`GET /api/stats/dashboard`）交过来，语序由这里定。
  //
  // ⚠ 这一族会原样显示在界面 chrome 上（红字/状态条），所以**不许带 Markdown 记号**
  // （`copy_rules_test.dart` 钉着）；要强调就靠语序，不靠星号。

  /// 状态条那行小字：正在等 [request]（已 [seconds] 秒）
  String requestWaiting(String request, int seconds);

  /// 这条请求自己的时限到了、没回来。[maybeDone] = 写操作，**可能已经生效**
  String requestTimeout(String request, int seconds, bool maybeDone);

  /// 事件流（长连接）连续 [seconds] 秒一个字节都没有：按断线处理，正在重连
  String requestStreamStalled(int seconds);

  // ── 壳 / 侧栏 ──────────────────────────────────────────────────────
  /// 页面名：聊天
  String get navChat;

  /// 页面名：设置
  String get navSettings;

  /// 页面名：运行情况
  String get navOverview;

  /// 页面名：通道
  String get navChannels;

  /// 页面名：扩展
  String get navExtensions;

  /// 页面名：人格
  String get navPersona;

  /// 页面名：日程
  String get navSchedule;

  /// 页面名：记忆
  String get navMemory;

  /// 页面名：日志
  String get navLogs;

  /// 侧栏"更多"折叠组
  String get navMore;

  // ── 运行情况 / 重启 / 托盘（2026-10-17 加）────────────────────────
  //
  // 这一组是"重启与退出"那两件事的**全部界面话**。它们之所以在文案表里而不在页面里：
  // 首页那颗「重启前后端」与托盘那个菜单项**走同一条路**（见 lib/restart_action.dart），
  // 两边说的话必须是同一句——各写一份的话术迟早会说成两件事。

  /// 运行情况页那颗「配置引导」按钮（打开首次引导卡，可随时关掉）
  String get overviewConfigGuide;

  /// 重启：链条自己确认成功。[evidence] 是 [restartEvidence] 那半句凭据
  String restartConfirmed(String evidence);

  /// 重启：回执里那两截凭据（真实新 pid、端口那一档）；都没有时如实说"没给凭据"
  String restartEvidence(int backendPid, bool portReady);

  /// 重启：已发出、结局未确认（**不是失败**，见 restart_action.dart 文件头）
  String get restartSentWithGui;

  /// 重启：已发出、只重启后端（界面不在本次动作范围内）
  String get restartSentBackendOnly;

  /// 重启：链条自己说失败。[reason] 是服务端那句原因
  String restartFailed(String reason);

  /// 重启：请求本身没发出去（409 已在重启中 / 路径不存在 / 网络）
  String restartRefused(String reason);

  /// 重启：没读到任何一种结论时的一句兜底
  String get restartNoConclusion;

  /// 重启：请求发出去了，可是**没等到回执**（超时）。它不是"没发出"——
  /// 那台机器可能已经在重启了，所以说的话必须往"先去看看"那一侧倒。
  String restartNoReceipt(String reason);

  /// 等后端回来：回来了
  String get restartBackReady;

  /// 等后端回来：等满窗口还没回来（[seconds] = 实际等了多少秒）
  String restartBackTimeout(int seconds);

  /// 等后端回来：它一次都没断开过（这次请求可能没生效）
  String get restartNeverWentDown;

  /// 托盘：显示界面
  String get trayShow;

  /// 托盘：收进托盘
  String get trayHide;

  /// 托盘：重启前后端（与首页那颗按钮同一个动作）
  String get trayRestart;

  /// 托盘：**只退出界面**（后端继续在后台跑）
  String get trayQuitUi;

  /// 托盘：**退出全部**（界面 + 后端一起）
  String get trayQuitAll;

  /// 退出全部：确认框标题
  String get quitAllConfirmTitle;

  /// 退出全部：确认框正文。[busy] = 她正在跑一轮（这一轮会被打断）
  String quitAllConfirmBody(bool busy);

  /// 退出全部：确认框那颗按钮
  String get quitAllConfirmLabel;

  /// 退出全部：正在停后端
  String get quitAllWorking;

  /// 退出全部：停后端失败（[reason] 是现场那句话）
  String quitAllFailed(String reason);

  /// 退出全部：都退了（写进日志的那一句）
  String get quitAllDone;

  /// 手动打开引导卡后：人改过东西，已保存
  String get onboardingManualSaved;

  /// 手动打开引导卡后：什么都没改
  String get onboardingManualNoChanges;

  /// 手动打开引导卡时，卡头那行**可见标识**（与"首次启动自己弹出来"区分开）
  String get onboardingManualOpenBadge;

  // ── 首次引导（六步卡）─────────────────────────────────────────────
  //
  // 六步的标题与说明都在这一组：标题同时是步骤条上的标签（一处措辞，两处显示）。
  //
  // 第 2、3 步的推荐语**拆成两段**（前缀 + 链接文字，必要时再加一段后缀）：点开外链那一段
  // 要单独上色成蓝链，而两种语言的语序不同——把"带链接的一句话"整句塞进一条文案，页面就
  // 只能去猜链接从哪个字开始。所以链接文字自己是一条，页面只负责把它们排进同一行（Wrap）。

  /// 第 1 步的标题
  String get onboardingStepNameTitle;

  /// 第 1 步的说明（名字框**上方**那一行；第 3 轮压成一行）
  String get onboardingStepNameNote;

  /// 第 2 步的标题
  String get onboardingStepApiTitle;

  /// 第 2 步的说明
  String get onboardingStepApiNote;

  /// 第 3 步的标题
  String get onboardingStepChannelTitle;

  /// 第 3 步的说明（凭据就在下面填）
  String get onboardingStepChannelNote;

  /// 第 4 步的标题
  String get onboardingStepPersonaTitle;

  /// 第 4 步的说明
  String get onboardingStepPersonaNote;

  /// 第 5 步的标题
  String get onboardingStepTrustTitle;

  /// 第 5 步的说明
  String get onboardingStepTrustNote;

  /// 第 2 步推荐语的前半句（后面紧跟 [onboardingApiRecommendModel] 那颗蓝链）
  String get onboardingApiRecommendLead;

  /// 第 2 步推荐语里的第一个蓝链：DeepSeek 的模型
  String get onboardingApiRecommendModel;

  /// 第 2 步第二个蓝链：注册账号并获取 API Key
  String get onboardingApiRegisterKey;

  /// 第 2 步两句推荐语**之间**那个连接词（第 3 轮把两行合成一行，靠它连成一句）
  String get onboardingApiRecommendJoin;

  /// 第 3 步推荐语的前半句（后面紧跟 [onboardingChannelRecommendQq] 那颗蓝链）
  String get onboardingChannelRecommendLead;

  /// 第 3 步推荐语里的蓝链：QQ 官方 Bot
  String get onboardingChannelRecommendQq;

  /// 第 3 步推荐语的收尾（蓝链后面那几个字）
  String get onboardingChannelRecommendTail;

  /// 第 3 步 QQ 官方 Bot 那一项的说明（凭据就在下面填）
  String get onboardingQqTileDetail;

  /// 第 3 步两把凭据的小标题
  String get onboardingQqCredentialsTitle;

  /// AppID 输入框上方的标签
  String get onboardingQqAppIdLabel;

  /// AppID 输入框的占位提示
  String get onboardingQqAppIdHint;

  /// AppSecret 输入框上方的标签
  String get onboardingQqAppSecretLabel;

  /// AppSecret 输入框的占位提示
  String get onboardingQqAppSecretHint;

  /// 密钥格已配置时的提示。[mask] 是服务端给的掩码（空 = 服务端没给，别显示一对空括号）
  String onboardingSecretConfigured(String? mask);

  /// 凭据那两格下面的说明（填完会自动勾上 QQ 官方 Bot）
  String get onboardingQqCredentialsNote;

  // ── 第 3 步：扫码创建 QQ 官方 Bot（2026-10-23）──────────────────
  //
  // 两个并列入口：**扫码创建（推荐）** 与 **填写凭据**。扫码那一支走
  // `POST /api/channels/qq-official/bind/start` → 系统浏览器打开二维码页 →
  // 每 2 秒查一次 `/bind/status`；成功即「绑定成功」+ AppID，过期则重新生成。
  // 这里只有界面话；二维码、AppID、服务端给的原因都是**数据**，不进文案表。

  /// 入口一：扫码创建（推荐）
  String get onboardingQqEntryScan;

  /// 入口二：填写凭据（原有的 AppID / AppSecret 表单）
  String get onboardingQqEntryManual;

  /// 扫码面板的说明：扫完会自动创建并落盘
  String get onboardingQqBindIntro;

  /// 那颗「扫码创建」按钮
  String get onboardingQqBindStart;

  /// 正在向 QQ 申请二维码（进行中的第一态）
  String get onboardingQqBindStarting;

  /// 二维码已经在浏览器里打开：请在浏览器里用手机 QQ 扫码
  String get onboardingQqBindWaitScan;

  /// 等待中（下方那行小字：每 2 秒查一次）
  String get onboardingQqBindWaiting;

  /// 成功那一句（官方 UI 文案照抄：「绑定成功」）
  String get onboardingQqBindSuccess;

  /// 成功下面那行：AppID 与 AppSecret 已保存并启用（secret 只显示"已保存"）
  String get onboardingQqBindSavedNote;

  /// 过期/超时那颗按钮
  String get onboardingQqBindRegenerate;

  /// 「测试连接」按钮
  String get onboardingQqBindTestConnection;

  /// 「测试连接」进行中
  String get onboardingQqBindTokenTesting;

  /// 绑定成功之后显示 AppID
  String onboardingQqBindAppId(String appId);

  /// 连接测试通过（[expiresIn] 秒）
  String onboardingQqBindTokenOk(int expiresIn);

  /// 连接测试没通过（[reason] 是服务端/网络给的原因）
  String onboardingQqBindTokenFailed(String reason);

  /// 发起扫码失败（[reason] 是服务端/网络给的原因）
  String onboardingQqBindStartFailed(String reason);

  /// 查扫码状态失败（[reason] 是服务端/网络给的原因）
  String onboardingQqBindStatusFailed(String reason);

  /// 第 3 步 OneBot 那一项的那**一句**（用户 2026-10-23：只写这一句，不做任何自动流程）
  String get onboardingOnebotDetail;

  /// 第 1 步名字框**下面**那一行（写哪儿 / 快照能回滚 / 界面上的称呼就是它）
  String get onboardingStepNameHint;

  /// 第 1 步唤醒词框**下面**那一行（分隔符 / 同平台 @ 那条路 / 清空 = 只认 @）
  String get onboardingKeywordsHint;

  /// 第 4 步正文框下面那段说明（2026-10-18 精简过；第 3 轮再压成一行）
  String get onboardingPersonaHint;

  /// 第 5 步那句边界说明（**与盘上那份一致**时）：一屏不会写盘，之后在设置页能改
  String get onboardingTrustNoteSame;

  /// 第 5 步那句边界说明（**与盘上那份不同**时）：写完要重启才接管
  String get onboardingTrustNoteChanged;

  // ── 第 6 步：外部依赖（用户第 3 轮 ⑤）───────────────────────────
  //
  // 一屏说清三件事：不装会怎样（点名四件）、现在各件什么状态、装不装（一个勾选框）。
  // 装的过程与结局也在这几条里：进行中 / 成功 / 失败原因 / 汇总 / 重试 / 上次的结果。

  /// 第 6 步的标题（步骤条上也用它）
  String get onboardingStepDepsTitle;

  /// 第 6 步的说明：不装的话哪几件工具用不了（点名四件）
  String get onboardingStepDepsNote;

  /// 勾选框：下载并安装这些外部依赖
  String get onboardingDepsInstallLabel;

  /// 四件都已就位时的说明（此时不摆勾选框，直接点「完成」）
  String get onboardingDepsAllReady;

  /// 一件依赖的现状：就位
  String get onboardingDepsStatusReady;

  /// 一件依赖的现状：未就位
  String get onboardingDepsStatusMissing;

  /// 一件依赖正在装
  String get onboardingDepsItemRunning;

  /// 一件依赖装好了
  String get onboardingDepsItemOk;

  /// 一件依赖没装成。[reason] 是服务端给的阶段 + 原因
  String onboardingDepsItemFailed(String reason);

  /// 一轮装完的汇总：成功 N / 失败 M
  String onboardingDepsSummary(int ok, int failed);

  /// 失败之后那颗「重试」
  String get onboardingDepsRetry;

  /// 复查：上一次装完的结果（同一页再打开时摆出来）
  String onboardingDepsLastRun(int ok, int failed);

  /// 读不到 `/api/deps` 时的那句话（[reason] 是现场那句话）
  String onboardingDepsReadFailed(String reason);

  /// 服务端没装配依赖管理器（`available: false`）时的那句话
  String get onboardingDepsUnavailable;

  /// 装完那个顶层窗口：标题
  String get onboardingRestartTitle;

  /// 装完那个顶层窗口：一句原因（装完要重启才生效）
  String get onboardingRestartBody;

  /// 装完那个顶层窗口：「立即重启」
  String get onboardingRestartNow;

  /// 装完那个顶层窗口：「稍后」
  String get onboardingRestartLater;

  /// 外链没打开时把地址说出来
  String onboardingOpenLinkFailed(String url);

  /// 第 3 步：通道开关没写进去。[reason] 是现场那句话
  String onboardingChannelSaveFailed(String reason);

  /// 第 3 步：AppID / AppSecret 没写进去。[reason] 是现场那句话
  String onboardingSecretsSaveFailed(String reason);

  // ── 第 2 步：密钥写到了**哪几格**（2026-10-20，用户实测的挫败点）──
  //
  // 从前的措辞只有一句「已配置」：人看不出这把 key 到底进了 heavy / light 里的哪一格，
  // 而设置页是按格显示"配没配"的。所以这一组每句都要求把**格名**念出来（`heavy / light`），
  // 格名由服务端的 `set-key` 回执给（`gates`），界面不自己猜。

  /// 写成功：这把 key 现在在哪几格（[gates] 例如 `heavy / light`）
  String onboardingApiKeyWritten(String gates);

  /// 密钥框的占位提示：已经写过时，说清写到了哪几格（替代从前那句含糊的"已配置"）
  String onboardingApiKeyHintWritten(String gates);

  /// 密钥框的占位提示：只有一部分格有 key（老用户只配过 heavy 的现场）
  String onboardingApiKeyHintPartial(String have, String missing);

  /// 写失败：[gates] 是这一趟**本该**写的格，[reason] 是现场那句话
  String onboardingApiKeySaveFailed(String gates, String reason);

  /// 配置里有这条路由，但密钥文件里没有它的格子（今天只有 degraded）：只能用环境变量给
  String onboardingApiKeyNoSlot(String routes, String envNames);

  // ── 第 2 步：模型探测 / 协议三档 / 密钥状态（2026-10-26）─────────────
  //
  // 这一组是「探测」按钮那一屏的全部界面话。**分档文案必须各自独立**：不可达、密钥无效、
  // 没有 /models 是三件不同的事，合成一句"探测失败"人就不知道该改哪里。
  // 服务端回来的 warnings / message 是**数据**，不进这里；页面只负责按 `code` 选一句。

  /// 模型名输入框上方的标签
  String get onboardingModelLabel;

  /// 模型名为空时点「继续」：这一格不能空
  String get onboardingModelRequired;

  /// Base URL 输入框上方的标签
  String get onboardingBaseUrlLabel;

  /// Base URL 为空时点「继续」：这一格不能空
  String get onboardingBaseUrlRequired;

  /// Base URL 下面那行说明（API 根地址，不含 /responses）
  String get onboardingBaseUrlNote;

  /// API Key 输入框上方的标签
  String get onboardingApiKeyLabel;

  /// API Key 的状态：一格都没有
  String get onboardingApiKeyStatusMissing;

  /// API Key 的状态：已经写到这几格（[gates] 例如 `heavy / light`）
  String onboardingApiKeyStatusWritten(String gates);

  /// API Key 的状态：只有这几格有（老用户只配过 heavy 的现场）
  String onboardingApiKeyStatusPartial(String have);

  /// 「探测」按钮
  String get onboardingProbeButton;

  /// 探测中（结果区那一行；按钮同时转圈）
  String get onboardingProbeRunning;

  /// 探测前 Base URL 空着：就地红字，不发请求
  String get onboardingProbeBaseRequired;

  /// 探测完成那一行。`count` 个模型；两套协议各自 supported/latency；`recommended` 可为 null。
  ///
  /// 为什么把四个读数一起传进来而不是让页面拼：中英文的语序不同（"23 个模型" vs
  /// "23 models"），页面拼字符串就会把某一种语言拼成翻译腔。
  String onboardingProbeDone({
    required int count,
    required bool responsesOk,
    required int? responsesMs,
    required bool chatOk,
    required int? chatMs,
    String? recommended,
  });

  /// 搜索模型输入框的提示
  String get onboardingProbeSearchHint;

  /// 搜不到任何模型
  String get onboardingProbeNoMatch;

  /// 端点通了，但 `/models` 是空列表（与"搜索没命中"分开说）
  String get onboardingProbeEmptyList;

  /// 每个模型行右侧的协议徽章（[protocol] = `Responses` / `Chat`）
  String onboardingProbeBadge(String protocol, bool supported);

  /// 失败分档：网络不可达 / DNS / 超时
  String get onboardingProbeUnreachable;

  /// 失败分档：401 / 403（密钥无效）
  String get onboardingProbeUnauthorized;

  /// 失败分档：404 / 不是 JSON / 没有 data[]（只能手填模型名）
  String get onboardingProbeNoModels;

  /// 失败分档：还没有可用的 API Key
  String get onboardingProbeNoKey;

  /// 失败兜底（服务端给了别的 code / 请求本身失败）
  String onboardingProbeFailed(String reason);

  /// 探测结论：这个端点**只**支持一种协议（[protocol] = `Responses` / `Chat Completions`）。
  ///
  /// 一句**事实陈述**，不是"建议去选某一档"：引导页 2026-10-26 起不再问协议
  /// （那三档留在设置页），所以这里只报实测结果，不给选择建议。
  String onboardingProbeOnlyProtocol(String protocol);

  /// 服务端 warnings 那一行（橙色小字；[warning] 是服务端原话）
  String onboardingProbeWarning(String warning);

  // ── 聊天页 ────────────────────────────────────────────────────────
  /// 页头标题
  String get chatTitle;

  /// 页头副标题
  String get chatSubtitle;

  /// 输入框提示
  String get composerHint;

  /// 跳到最新
  String get jumpToLatest;

  /// 有新内容时跳到最新
  String get jumpToLatestNew;

  /// 更早的记录读失败了
  String get earlierFailed;

  /// 没有更早的记录
  String get noEarlier;

  /// 会话记录读取失败（标题）
  String get historyErrorTitle;

  /// 会话记录读取失败（正文）
  String get historyErrorMessage;

  /// 会话尚未开始（空态标题）
  String get chatEmptyTitle;

  /// 还没有会话记录。（空态正文）
  String get chatEmptyMessage;

  /// 输入消息（空态 CTA）
  String get chatEmptyAction;

  /// 空态提示
  String get chatEmptyHint;

  /// 标签：框架通报
  String get tagFrameworkNotice;

  /// 标签：框架提醒
  String get tagFrameworkReminder;

  /// 标签：注入预警
  String get tagInjection;

  /// 标签：上下文分界
  String get tagContextBoundary;

  /// 注入卡标题
  String get injectionCardTitle;

  /// 未命名会话（发送者兜底）
  String get unnamedSender;

  /// `已接收：<发送者>（<id>）`
  String receivedFrom(String sender, String id);

  /// 占位符"—"
  String get dash;

  /// <来源>里有人提到了你
  String mentionsYou(String where);

  /// 那边在聊：<内容>
  String talkingAbout(String what);

  /// 单聊消息
  String get directMessage;

  /// 群聊提及
  String get groupMention;

  /// 群聊消息
  String get groupMessage;

  /// 单聊 / 群聊（事件行里的会话类型）
  String get chatTypeDirect;

  /// 群聊
  String get chatTypeGroup;

  /// QQ 官方 Bot
  String get qqOfficialBot;

  /// 外部通道（认不出通道名时的兜底）
  String get externalChannel;

  /// QQ 消息
  String get qqMessage;

  /// OneBot 消息
  String get oneBotMessage;

  /// 外部消息（最空的那句兜底）
  String get externalMessage;

  /// 模型判定
  String get byModel;

  /// 规则命中
  String get byRule;

  /// 来自 <谁>
  String fromWho(String who);

  /// 手动唤醒
  String get manualWake;

  /// 意图唤醒
  String get intentWake;

  /// 定时任务触发
  String get schedulerFire;

  /// 原定 <时间>
  String scheduledAt(String at);

  /// 后台任务进展
  String get backgroundProgress;

  /// 做梦（事件行的动作名）
  String get eventDream;

  /// MCP 声明变更
  String get eventMcpDeclChanged;

  /// 上下文在此处清空
  String get contextClearedHere;

  /// 上下文在此处压缩
  String get contextCompactedHere;

  /// 清空分界的说明
  String get contextClearedHereDetail;

  /// 压缩分界的说明
  String get contextCompactedHereDetail;

  /// 人工答复已记录
  String get humanReplyRecorded;

  /// 已标记成功
  String get markedOk;

  /// 已标记失败
  String get markedFailed;

  /// 工具状态：运行中
  String get toolRunning;

  /// 工具状态：正在执行…
  String get toolExecuting;

  /// 工具状态：完成
  String get toolDone;

  /// 工具状态：出错
  String get toolError;

  /// 工具状态：超时（结果未知）
  String get toolTimeout;

  /// 工具状态：被策略拒绝
  String get toolDenied;

  /// 工具状态：结局未知
  String get toolUnknown;

  /// 工具状态：未派发
  String get toolNotDispatched;

  /// 工具状态：超出单步上限
  String get toolOverStepCap;

  /// 思考那一行的四个格子：`思考中` / `第 N 步` / `已想 M 字` / `用时 X`。
  ///
  /// 不做成一句模板：中文用全角空格分隔、英文用半角双空格，语序也不同
  /// （英文是 "Thinking  step 3  6.2k chars  0:07"）。拼装那一处见 chat_page 的
  /// `thinkingLine()`，它只负责补位对齐（那是个读数，不是文案）。
  String get thinkingLabel;

  /// 第 N 步
  String thinkingStep(String step);

  /// 已想 M 字
  String thinkingChars(String chars);

  /// 用时 X
  String thinkingElapsed(String elapsed);

  /// 四个格子之间的分隔符
  String get thinkingGap;

  /// 字数给人看的短写（中文按"万"分档、英文按"k"分档）
  String compactChars(int chars);

  /// toast：上下文已清空
  String get toastContextCleared;

  /// toast：清空失败：<原因>
  String toastClearFailed(String reason);

  /// toast：叫她去做梦了
  String get toastDream;

  /// toast：触发失败：<原因>
  String toastTriggerFailed(String reason);

  /// toast：重复发送被忽略
  String get toastDuplicateSend;

  /// toast：发送失败：<原因>
  String toastSendFailed(String reason);

  // ── 设置页 ────────────────────────────────────────────────────────
  /// 页头标题
  String get settingsTitle;

  /// 页头副标题
  String get settingsSubtitle;

  /// 分区：界面
  String get settingsSectionUi;

  /// 界面卡的说明
  String get settingsUiNote;

  /// 即时生效
  String get instantApply;

  /// 明暗模式
  String get settingsThemeMode;

  /// 亮
  String get themeLight;

  /// 暗
  String get themeDark;

  /// 当前主题
  String get settingsCurrentTheme;

  /// 明暗模式的旁注
  String get settingsThemeNote;

  /// 关窗时收进托盘
  String get settingsCloseToTray;

  /// 关窗行为的旁注
  String get settingsCloseToTrayNote;

  /// 语言
  String get settingsLanguage;

  /// 跟随系统
  String get languageFollowSystem;

  /// 语言的旁注
  String get settingsLanguageNote;

  // ── 设置页：文案覆盖（i18n 覆盖层自己的界面话，2026-10-21 加）──────────
  //
  // 这一组是**覆盖层自己的提示文案**：它们走同一条覆盖链——用户可以用覆盖文件
  // 把这组话本身也改掉（见 `i18n/strings_override.dart` 的解析顺序）。
  // 三态（未使用 / 已加载 / 解析失败）与三条回执（导出成功、导出失败、打不开路径）
  // 各有其位；状态行的拼装固定在一处（`stringsOverrideStatusLine`），页面只负责摆颜色。

  /// 设置页「界面」卡：字段名「文案覆盖」
  String get settingsStringsOverride;

  /// 文案覆盖的旁注（改哪个文件、哪些句子改不了）
  String get settingsStringsOverrideNote;

  /// 「覆盖文件」这一行的标签
  String get stringsOverridePathLabel;

  /// 按钮：打开文案文件（所在目录）
  String get stringsOverrideOpen;

  /// 按钮：重新载入文案（不重启界面）
  String get stringsOverrideReload;

  /// 按钮：把当前语言的全部文案导出成模板
  String get stringsOverrideExport;

  /// 状态：没有覆盖，用的是默认文案
  String get stringsOverrideNone;

  /// 状态：已加载 N 条覆盖（zh a / en b）
  String stringsOverrideLoaded(int zh, int en);

  /// 状态：解析失败：<原因>
  String stringsOverrideFailed(String reason);

  /// 失败原因的一支：覆盖文件读不出来（detail 是系统给的那句话）
  String stringsOverrideUnreadable(String detail);

  /// 失败原因的一支：JSON 格式不对（detail 是 `FormatException` 的说明）
  String stringsOverrideBadJson(String detail);

  /// 失败原因的一支：JSON 顶层不是对象（既不是分语言段、也不是扁平键值）
  String get stringsOverrideBadRoot;

  /// 状态旁注：有 N 条键没被采用（不认识的键，或值不是字符串）
  String stringsOverrideIgnored(int count);

  /// 回执：模板已写到 <路径>
  String stringsOverrideExported(String path);

  /// 回执：模板写不出去：<原因>
  String stringsOverrideExportFailed(String reason);

  /// 回执：这个路径打不开：<路径>
  String stringsOverrideOpenFailed(String path);

  /// 分区一/二…的锚点小标题
  String get settingsAnchorCaption;

  /// 设置页左侧分区：模型
  String get settingsNavModel;

  /// 设置页左侧分区：界面
  String get settingsNavUi;

  /// 设置页左侧分区：发言
  String get settingsNavSpeak;

  /// 设置页左侧分区：外部依赖
  String get settingsNavDeps;

  /// 设置页左侧分区：协议端
  String get settingsNavProtocol;

  /// 设置页左侧分区：外部回调
  String get settingsNavWebhook;

  /// 设置页左侧分区：记忆
  String get settingsNavMemory;

  /// 设置页左侧分区：信任范围
  String get settingsNavTrust;

  /// 设置页左侧分区：系统
  String get settingsNavSystem;

  /// 设置页左侧分区：账号与安全
  String get settingsNavAccount;

  /// 设置页左侧分区：关于
  String get settingsNavAbout;
  // ── 运行情况页 ─────────────────────────────────────────────────────
  /// 当前状态、用量与待确认项
  String get overviewSubtitle;

  /// 建议（分区小标题）
  String get overviewSectionAdvice;

  /// 最近事件（分区小标题）
  String get overviewSectionRecent;

  /// 人格资产未初始化：IDENTITY.md 仍为模板，先补全身份与语气。
  String get overviewPersonaSeedAdvice;

  /// 现在没有待确认的调用
  String get overviewNoPendingCalls;

  /// 撤销这个定时器？
  String get overviewTimerCancelTitle;

  /// 撤销（定时器的按钮与确认框）
  String get overviewTimerCancel;

  /// 丢弃这条死信？
  String get overviewDeadDiscardTitle;

  /// 确认丢弃
  String get overviewDeadDiscardConfirm;

  /// 重投（死信）
  String get overviewDeadRequeue;

  /// 丢弃（死信）
  String get overviewDeadDiscard;

  /// 无法获取运行数据
  String get overviewLoadFailedTitle;

  /// 标记成功
  String get overviewMarkSucceeded;

  /// 标记失败
  String get overviewMarkFailed;

  /// 今日用量（磁贴标签）
  String get overviewTodayUsage;

  /// 缓存命中率
  String get overviewCacheHitRate;

  /// 待确认（磁贴标签）
  String get overviewPending;

  /// 连续失败
  String get overviewFailStreak;

  /// 建议卡上没有动作名时的兜底按钮
  String get overviewActFallback;

  /// 没读到死信明细，刷新一次再看看。
  String get overviewDeadLettersUnread;

  /// 未知会话（名字解析不出来时的兜底）
  String get overviewUnknownSession;

  /// 单聊（会话类型词）
  String get overviewChatTypeDirect;

  /// 群聊@（会话类型词）
  String get overviewChatTypeGroupAt;

  /// 群聊（会话类型词）
  String get overviewChatTypeGroup;

  /// 频道（会话类型词）
  String get overviewChatTypeGuild;

  /// 类型未知（会话类型词）
  String get overviewChatTypeUnknown;

  /// 外部会话（卡片标题）
  String get overviewExternalSessions;

  /// 经由消息适配器添加的会话。平台推给我们的消息存入信箱，由 Agent 自行查看。
  String get overviewExternalSessionsNote;

  /// 正在读外部会话…
  String get overviewExternalSessionsLoading;

  /// 状态与用量不受影响；读到数据后这张卡会自己出现。
  String get overviewExternalSessionsErrorHint;

  /// 没有积累的消息（信箱里是空的；群里没 @ 她的消息，要官方 Bot 先推给我们才进得来）。
  String get overviewNoAccumulatedMessages;

  /// 严重（等级词）
  String get overviewLevelCritical;

  /// 警告（等级词）
  String get overviewLevelWarn;

  /// 提示（等级词）
  String get overviewLevelInfo;

  /// 未知等级
  String get overviewLevelUnknown;

  /// 框架提示（卡片标题与兜底徽章）
  String get overviewFrameworkNote;

  /// 正在读框架提示…
  String get overviewFrameworkNotesLoading;

  /// 运行不受影响；注入预警与告警仍照常记录在事件日志里。
  String get overviewFrameworkNotesErrorHint;

  /// 没有需要你知道的事。
  String get overviewNoFrameworkNotes;

  /// 定时器（卡片标题）
  String get overviewTimers;

  /// 她自己布防的唤醒（timer 工具的 action=set）。到点会把她叫起来，撤销只对还没触发的那些有效。
  String get overviewTimersNote;

  /// 眼下没有排着的定时器。
  String get overviewNoTimers;

  /// 可能是它已经触发或已经被撤掉了；刷新一次看最新清单。
  String get overviewTimersErrorHint;

  /// 时刻未知（定时器读不出时间时）
  String get overviewTimerUnknownTime;

  /// 周期（定时器重复标记）
  String get overviewTimerRecurring;

  /// 还没有事件记录。
  String get overviewRecentEmpty;

  /// 立即唤醒（空态的按钮）
  String get overviewRecentEmptyAction;

  /// 唤醒或外部消息写入后，这里列出最近发生的事。
  String get overviewRecentEmptyHint;

  /// 规则判定（注入预警的判据来源）
  String get overviewJudgedByRule;

  /// 模型判定（注入预警的判据来源）
  String get overviewJudgedByModel;

  /// 返回的数据不是会话清单
  String get overviewSessionsNotList;

  /// 返回的数据不是提示清单
  String get overviewNotesNotList;

  /// 「当前上下文构成」那块看板的标题
  String get overviewContextTitle;

  /// 那块看板的加载态（骨架条旁边的一行灰字）
  String get overviewContextLoading;

  /// 那块看板读不到时的下半句：影响 / 下一步
  String get overviewContextErrorHint;

  /// 一次请求都还没有时的空态（"没有数"与"数是 0"是两件事）
  String get overviewContextEmpty;

  /// 返回的数据不是上下文构成（读失败，而不是"没有数"）
  String get overviewContextNotObject;

  /// 「保留历史思维链」的两格：开 / 关
  String get overviewContextKeepOn;
  String get overviewContextKeepOff;

  /// 建议卡的一行：`标题：细节`
  String overviewAdviceLine(String title, String body);

  /// 一条死信的行首：`seq 42 · 认领 3 次 · 09-30 03:12`（[stamp] 为 null 时只到"次"）
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp);

  /// `待确认 N 项`
  String overviewPendingCount(int count);

  /// `今日用量 <真数>`（磁贴的 tooltip）
  String overviewTodayUsageTooltip(String exact);

  /// 撤销定时器的确认框正文
  String overviewTimerCancelBody(String timerId);

  /// `已撤销定时器 <id>：到点不会再醒`
  String overviewTimerCancelled(String timerId);

  /// `撤销 <id> 失败：<原因>`
  String overviewTimerCancelFailed(String timerId, String reason);

  /// `撤销失败：<原因>`
  String overviewTimerCancelToastFailed(String reason);

  /// `标记失败：<原因>`
  String overviewMarkFailedToast(String reason);

  /// `已重投 seq <n>：它回到队列，下一拍重新认领`
  String overviewDeadRequeued(int seq);

  /// 丢弃死信的确认框正文
  String overviewDeadDiscardBody(int inputSeq);

  /// `已丢弃 seq <n>：它不会再被执行，日志里仍留着那条输入`
  String overviewDeadDiscarded(int seq);

  /// `<动作> seq <n> 失败：<原因>`（动作名由页面给：重投 / 丢弃）
  String overviewDeadActionFailed(String verb, int seq, String reason);

  /// `<动作>失败：<原因>`
  String overviewDeadActionToastFailed(String verb, String reason);

  /// 已恢复 · 历史（[label] 为空时只有后半句拼进来）
  String overviewHistoricalBadge(String label);

  /// 来源：框架自身（有指纹时缀在后面）
  String overviewSourceFramework(String? fingerprint);

  /// 来源：<会话或人>
  String overviewSourceChat(String who);

  /// 引用外部原话：`「…」`
  String overviewQuote(String text);

  /// `N 个群聊`
  String overviewGroupsCount(int count);

  /// `N 个单聊`
  String overviewSinglesCount(int count);

  /// `N 个其它`
  String overviewOthersCount(int count);

  /// `合计 N 条未读`
  String overviewUnreadTotal(int count);

  /// `来过 N 条`
  String overviewMessagesSeen(int count);

  /// `未读 N`
  String overviewUnreadBadge(int count);

  /// `N 个在等`
  String overviewTimersWaiting(int count);

  /// `周期 <cron>`
  String overviewTimerCron(String cron);

  /// `唤醒内容：<摘要>`
  String overviewTimerPayload(String payload);

  /// `外部会话读取失败：<原因>`
  String overviewExternalSessionsError(String reason);

  /// `框架提示读取失败：<原因>`
  String overviewFrameworkNotesError(String reason);

  /// 看板右上那一格：`<已用> / <压缩线> tok`
  String overviewContextTokens(String used, String budget);

  /// 看板的副行：`占预算 <p>% · 保留历史思维链：<开/关> · 取自 <时刻> 那一拍`
  String overviewContextSubline(int percent, String keep, String stamp);

  /// 图例每一片右侧的占比：`<占比>%`
  ///
  /// 2026-10-25 夜里用户把图例改成"三片并排一行"：组名、tokens、占比各是一段文字
  /// （`overviewContextLegend` 那条"拼成一句"的 key 随之删掉——它的分隔符 `·` 正是
  /// 竖排/换行时最难看的那个字符）。
  String overviewContextShare(int share);

  /// 图例一片里那两个数：`<tokens> · <占比>%`
  ///
  /// 2026-10-25 夜里第二次改版：那张卡从"占一整行"变成"跟用量、命中率同一排"——先是
  /// 1:1:2 里的 2/4（约 660px），当夜用户又说「改成三个卡片等宽吧」，于是收成 1:1:1 的
  /// 一格（内容宽 1348 时约 441px）。三片各约 130，片里放不下这一整条时按既有规矩退到
  /// 只留占比（[AppStrings.overviewContextShare]）——所以这条文案是"够宽才出现"的那一档。
  /// 中间那个分隔符归文案管（英文可能不是 `·`），所以不在页面里拼。
  String overviewContextLegendNumbers(String tokens, int share);

  /// `上下文构成读取失败：<原因>`
  String overviewContextError(String reason);

  /// 主循环（heavy）
  String get settingsLaneHeavyLabel;
  /// 轻量（light）
  String get settingsLaneLightLabel;
  /// turn 主循环使用的模型
  String get settingsLaneHeavyNote;
  /// 必要性判断、压缩摘要与守卫分类使用的模型
  String get settingsLaneLightNote;
  /// 框架托管
  String get settingsDepSourceManaged;
  /// 系统 PATH
  String get settingsDepSourceSystemPath;
  /// 版本未知
  String get settingsDepVersionUnknown;
  /// 路径未知
  String get settingsDepPathUnknown;
  /// 监听地址不能为空：空值等于监听所有网卡，未保存
  String get settingsSysHostEmptyError;
  /// $label不能为空，未保存
  String settingsSysEmptyError(String label);
  /// $label要填整数，未保存
  String settingsSysIntRequired(String label);
  /// $label要在 1~65535 之间，未保存
  String settingsSysPortRange(String label);
  /// $label最小是 1，未保存
  String settingsSysMinOne(String label);
  /// $label要填小数（0.8 表示 80%），未保存
  String settingsSysRatioRequired(String label);
  /// $label是比例，要落在 0~1 之间（不含 0），未保存
  String settingsSysRatioRange(String label);
  /// $label最小是 $lo，未保存
  String settingsSysMin(String label, int lo);
  /// $label最大是 $hi，未保存
  String settingsSysMax(String label, int hi);
  /// 监听地址
  String get settingsSysHostLabel;
  /// 本机用就填 127.0.0.1；端口 1~65535。留空等于监听所有网卡，会被拦下。
  String get settingsSysHostNote;
  /// 端口
  String get settingsSysPortLabel;
  /// 时区
  String get settingsSysTimezoneLabel;
  /// IANA 名称，例如 Asia/Shanghai。预算的「今日」按它切分。
  String get settingsSysTimezoneNote;
  /// 预算 · 步内工具调用上限
  String get settingsSysStepToolsLabel;
  /// 单个 step 里最多调几次工具。
  String get settingsSysStepToolsNote;
  /// 预算 · 单 turn 步数上限
  String get settingsSysTurnStepsLabel;
  /// 一个 turn 最多走多少步。
  String get settingsSysTurnStepsNote;
  /// 预算 · 任务 token 上限
  String get settingsSysTaskTokensLabel;
  /// 单个任务累计上限；填原值，20M 这类简写不接受。口径是非缓存 token（真花钱的那部分），不是账单上的用量。
  String get settingsSysTaskTokensNote;
  /// 预算 · 每日 token 上限
  String get settingsSysDailyTokensLabel;
  /// 每日累计上限，按上面的时区切分。口径同上一行：只数没命中缓存的那部分。
  String get settingsSysDailyTokensNote;
  /// 预算 · 软阈值
  String get settingsSysSoftRatioLabel;
  /// 0~1 的小数：0.8 就是 80%。到这一线先提示收尾，越过才硬停。
  String get settingsSysSoftRatioNote;
  /// 预算 · 连续失败上限
  String get settingsSysFailStreakLabel;
  /// 连续失败这么多次就告警并进入暂停。
  String get settingsSysFailStreakNote;
  /// 心跳间隔 · 平均（分钟）
  String get settingsSysHeartbeatLabel;
  /// 她平均多久自己醒一次——越大越省 token，越小越常醒。两端仍由上下限兜住：不因这个数改变，安静不足下限不会醒、到了上限必然会醒。
  String get settingsSysHeartbeatNote;
  /// 上下文 · 压缩线（token 估算）
  String get settingsSysCompactionLabel;
  /// 可见历史攒到这么多 token（估算）就折成一篇交接笔记，压缩只遮蔽、不删除。单位是估算器读数，不是供方计数（估算比供方偏低约 1.65~1.66 倍）。填原值：200000 这类写法不接受；调小 = 压得更勤，而每次压缩自己也要花一次调用…
  String get settingsSysCompactionNote;
  /// 她只能在配置里的工作目录（trust.workspaceRoot）中活动；越界的读写与命令会被拒绝。
  String get settingsTrustConsequenceWorkspaceUnknown;
  /// 她只能在 $root 里活动；越界的读写与命令会被拒绝。
  String settingsTrustConsequenceWorkspace(String root);
  /// 她能读写整台电脑上的文件、也能在任意目录跑命令。
  String get settingsTrustConsequenceFull;
  /// 只限工作目录
  String get settingsTrustLabelWorkspace;
  /// 完全信任
  String get settingsTrustLabelFull;
  /// 凭据状态读取失败（响应不是对象）
  String get settingsWebhookStateNotObject;
  /// 协议端状态读取失败（响应不是对象）
  String get settingsProtocolStateNotObject;
  /// 依赖报告读取失败
  String get settingsDepsReadFailed;
  /// 密钥状态读取失败
  String get settingsKeysReadFailed;
  /// 运行数据读取失败
  String get settingsProjectionReadFailed;
  /// 模型名不能为空，未保存
  String get settingsModelNameRequired;
  /// Base URL 不能为空，未保存
  String get settingsBaseUrlRequired;
  /// 没有需要保存的改动
  String get settingsNoChanges;
  /// 模型设置
  String get settingsWrittenModelSettings;
  /// 密钥
  String get settingsWrittenKey;
  /// ，进程重启后生效
  String get settingsRestartSuffix;
  /// 保存失败：$err
  String settingsSaveFailed(String err);
  /// 清除后需重新填写；来自环境变量的值不受影响。
  String get settingsClearKeyBody;
  /// 清除
  String get settingsClear;
  /// 已清除本地密钥
  String get settingsKeyCleared;
  /// 清除失败：$err
  String settingsClearFailed(String err);
  /// 模型密钥与系统信息需要生效配置才能显示。请确认主进程已启动。
  String get settingsConfigErrorHint;
  /// 配置不可用。
  String get settingsConfigUnavailable;
  /// 本地服务 /api/config 未返回配置内容。
  String get settingsConfigUnavailableHint;
  /// 密钥状态读取失败（$keysError）。密钥徽章不可用，模型名与 Base URL 仍可保存。
  String settingsKeysReadFailedHint(String keysError);
  /// 读不到 config.json，这一页显示的是当前生效的那份（保存仍会写进文件）。
  String get settingsConfigFallbackNote;
  /// 上面有改动还没生效：模型名、端点与协议是启动参数，要重启进程才接管——在那之前跑的还是启动时那份。保存本身是成功的，框里显示的就是盘上那份。
  String get settingsModelRestartNote;
  /// 现在跑的是 $lane=$model @ $baseUrl
  ///
  /// **运行期**那条读数的句式（2026-10-21）：里面三个值全部来自服务端**生效配置**
  /// （`GET /api/config` 不带 `source=saved`），不是本页正在编辑的盘上那份。
  /// 它与输入框并排摆着，就是为了让"我刚存的值"与"它此刻真正在用的值"同屏可见。
  String settingsModelRunningNow(String lane, String model, String baseUrl);
  /// 密钥只写不读：本页显示的始终是掩码，完整值仅在建立连接时读取一次。保存写入 config.json 与 data/.keys.json，进程重启后接管（环境变量优先于文件）。
  String get settingsKeysNote;
  /// 已配置；粘贴新密钥可覆盖
  String get settingsKeyConfiguredHint;
  /// sk-…
  String get settingsKeySampleHint;
  /// 模型名
  String get settingsModelName;
  /// API 根地址，不含 /responses。
  String get settingsBaseUrlNote;
  /// 协议
  String get settingsModelProtocol;
  /// 先按 Responses；探测到不支持才切（推荐）
  String get settingsModelProtocolAuto;
  /// 强制走 Chat（没有"必须回传思维链"的要求 ⇒ 更不容易 400，但思维链展示更少）
  String get settingsModelProtocolChat;
  /// 强制走 Responses（对方不支持时会直接失败，不自动切）
  String get settingsModelProtocolResponses;
  /// 环境变量 $envName 优先；它没有值时使用此处的值（写入 data/.keys.json，只写不读）。
  String settingsKeyEnvNote(String envName);
  /// 清除密钥
  String get settingsClearKey;
  /// 读取中…
  String get settingsReading;
  /// 状态读取失败
  String get settingsStateReadFailed;
  /// 未配置
  String get settingsNotConfigured;
  /// 她说话时的节奏：一条条往外蹦、每条之间隔多久。只影响投递手感，不影响说话内容。
  String get settingsSpeakNote;
  /// 打字节奏
  String get settingsSpeakTyping;
  /// 开着：按“这段话要打多久”逐条发出，像人在打字（对方也随时能插话打断）。关掉：一次发完，内容尽快到手。
  String get settingsSpeakTypingNote;
  /// 打字速度
  String get settingsSpeakSpeed;
  /// 字/分钟
  String get settingsSpeakSpeedUnit;
  /// 默认 90（中文手机输入的常见速度）。调大说得更快、等待更短；范围 30~600。
  String get settingsSpeakSpeedNote;
  /// 当前生效
  String get settingsCurrentlyActive;
  /// $saved 字/分钟 · 逐条发
  String settingsSpeakTypingOn(String saved);
  /// $saved 字/分钟 · 一次发完
  String settingsSpeakTypingOff(String saved);
  /// 已开启打字节奏（重启后接管）
  String get settingsSpeakTypingEnabled;
  /// 已关闭打字节奏（重启后接管）
  String get settingsSpeakTypingDisabled;
  /// 打字速度要在 30~600 之间
  String get settingsSpeakSpeedRange;
  /// 已保存（重启后接管）
  String get settingsSavedRestartNote;
  /// 已保存，立刻生效（不用重启）
  String get settingsSavedLive;
  /// 已保存，重启后生效
  String get settingsSavedRestart;
  /// 全部就绪
  String get settingsDepsAllReady;
  /// 建议安装的外部依赖，可由框架一键安装。
  String get settingsDepsNote;
  /// 依赖报告读取失败（$depsError）。装不了也看不见状态时，先在命令行确认主进程已启动。
  String settingsDepsReadFailedHint(String depsError);
  /// 正在探测本机的 pwsh / ripgrep / es.exe / python …
  String get settingsDepsProbing;
  /// 安装位置：<数据目录>/tools/<名字>/。装完立即生效——探测结论会在安装后复检并刷新，下一次工具调用用的就是新引擎。
  String get settingsDepsInstallLocation;
  /// 已就绪·托管
  String get settingsDepReadyManaged;
  /// 已就绪·系统
  String get settingsDepReadySystem;
  /// 版本不符
  String get settingsDepMismatch;
  /// 未安装
  String get settingsDepMissing;
  /// 无需操作
  String get settingsDepNoAction;
  /// 安装中…
  String get settingsDepInstalling;
  /// 安装
  String get settingsInstall;
  /// 下载页
  String get settingsDownloadPage;
  /// 打开下载页
  String get settingsOpenDownloadPage;
  /// 下载并安装
  String get settingsDownloadAndInstall;
  /// 安装请求失败：$err
  String settingsInstallRequestFailed(String err);
  /// 下载失败
  String get settingsStepDownloadFailed;
  /// 解压失败
  String get settingsStepExtractFailed;
  /// 装完复检没通过
  String get settingsStepVerifyFailed;
  /// 安装失败
  String get settingsStepInstallFailed;
  /// 已用默认程序打开 $url
  String settingsOpenedUrl(String url);
  /// 未知
  String get settingsUnknown;
  /// 需重启
  String get settingsRestartRequired;
  /// 协议端（可选）
  String get settingsProtocolTitle;
  /// 可选：由框架拉起的 OneBot 协议端，背后是一个真实 QQ 号。它与官方 Bot 各是一条独立的入站通道，装不装都不影响另一条。
  String get settingsProtocolNote;
  /// 协议端状态读取失败：$protocolError
  String settingsProtocolError(String protocolError);
  /// 这张卡读不到不影响其它设置。先确认主进程已启动，再点重试；在读到状态之前，这里不提供开关、目录与一键安装——那等于让你在看不到当前值的情况下写它。
  String get settingsProtocolErrorHint;
  /// 正在读取协议端状态…
  String get settingsProtocolLoading;
  /// 还没配置内置协议端。
  String get settingsProtocolEmpty;
  /// 不开也照常用：官方 Bot 那条通道不受影响。要用这条路，点下面的「一键安装」把装与配一次做完。
  String get settingsProtocolEmptyHint;
  /// 启用内置协议端
  String get settingsProtocolEnabled;
  /// 框架启动时自动连接；关闭后可在双端手动填写和配置。
  String get settingsProtocolEnabledNote;
  /// 安装目录
  String get settingsInstallDir;
  /// <协议端安装目录>
  String get settingsInstallDirHint;
  /// 保存目录
  String get settingsSaveDir;
  /// 协议端安装目录（绝对路径）。Lite 包解压后入口 index.mjs 就在这一层，没有 dist/ 子目录；「一键安装」会自动填好。
  String get settingsInstallDirNote;
  /// 一键安装
  String get settingsOneClickInstall;
  /// 从 SnowLuma 官方 Release 下载 Lite 包；自动下载失败时，自行下载并填写安装目录。此包不随框架分发，不得用于商业使用。
  String get settingsOneClickInstallNote;
  /// 使用前提：本机已登录 QQ 客户端（Bot 账号）。
  String get settingsOneClickPrerequisite;
  /// 正在从官方 Releases 下载并解压。要下 4.6 MB，视网速可能要一两分钟——先别急，也别再点一次。分步记录（下到哪一步、下多大）会在这一步结束时一次性列出来：这条端点是同步请求，不是流，中间插不进进度行。
  String get settingsInstallRunningNote;
  /// 手动出路：从 $protocolDownloadUrl 下载发行包，解压后把那个目录填到下面的「安装目录」，再点「保存目录」、打开开关——效果与一键安装一样，只是这几步由你做。
  String settingsInstallManualRoute(String protocolDownloadUrl);
  /// 过程记录：（这次没有——失败发生在动手之前）
  String get settingsInstallLogEmpty;
  /// 过程记录：
  String get settingsInstallLog;
  /// 已经装好了。下一步：先重启服务，再扫码。
  String get settingsInstalledNextTitle;
  /// ① 重启服务：运行中的协议端实例是按启动时的配置建的，重启之后它才会按刚写好的配置被拉起（框架不替你重启——重启自己失败就什么都不剩了）。\n② 再扫码：重启后这张卡上会出现「打开面板」，点开在那边先读并同意用户协议与隐私政策（那是法律性质…
  String get settingsInstalledNextBody;
  /// （还没填安装目录）
  String get settingsInstallDirEmpty;
  /// 已找到可执行入口
  String get settingsEntryFound;
  /// 目录里没有可执行入口
  String get settingsEntryMissing;
  /// 入口要重启后才核对
  String get settingsEntryPendingRestart;
  /// 对接点：$wsUrl
  String settingsEndpointPoint(String wsUrl);
  /// 启动
  String get settingsStart;
  /// 停止
  String get settingsStop;
  /// 打开面板
  String get settingsOpenPanel;
  /// 本次进程启动时还没读到这段配置：框架现在不持有它的实例，「启动/停止」要等重启进程之后才有效。
  String get settingsProtocolNotAttachedNote;
  /// ① 进程
  String get settingsChainProcess;
  /// 未观测
  String get settingsChainUnobserved;
  /// 本进程没有实例，这一档没人在看
  String get settingsChainNoInstance;
  /// 没在跑
  String get settingsChainNotRunning;
  /// 没有监听到它的面板端口
  String get settingsChainNoPort;
  /// 本次进程拉起
  String get settingsChainSpawned;
  /// 本次进程之前就在跑
  String get settingsChainDiscovered;
  /// 只探到端口
  String get settingsChainPortOnly;
  /// 在跑
  String get settingsChainRunning;
  /// 监听 $url
  String settingsChainListening(String url);
  /// ② OneBot 配置
  String get settingsChainOneBotConfig;
  /// 带 token
  String get settingsChainWithToken;
  /// 无 token（协议端未开校验）
  String get settingsChainNoToken;
  /// 在
  String get settingsChainPresent;
  /// 端点 $ws
  String settingsChainEndpoint(String ws);
  /// 读不出
  String get settingsChainUnreadable;
  /// 缺失
  String get settingsChainMissing;
  /// 未登录 QQ：这一份是登录之后才生成的
  String get settingsChainMissingDetail;
  /// ③ 适配器
  String get settingsChainAdapter;
  /// 已连上
  String get settingsChainConnected;
  /// 已收 $delivered 条
  String settingsChainDelivered(String delivered);
  /// 重连中
  String get settingsChainReconnecting;
  /// 第 $attempts 次退避
  String settingsChainBackoff(String attempts);
  /// 没端点可连
  String get settingsChainNoEndpoint;
  /// 协议端的 OneBot 配置还没出现，配置里也没有手填地址
  String get settingsChainNoEndpointDetail;
  /// 未启用
  String get settingsChainDisabled;
  /// 未装配
  String get settingsChainNotAssembled;
  /// 本进程没有 OneBot 适配器
  String get settingsChainNotAssembledDetail;
  /// 这一档没有数据
  String get settingsChainNoData;
  /// 初始凭据（本次启动从它的输出里捕到，用户 $user / 口令 $masked）
  String settingsCredentialCaptured(String user, String masked);
  /// 初始凭据（从框架自己的启动留痕里捞回来的：用户 $user / 口令 $masked；若它之后又重启过，这条就作废了）
  String settingsCredentialFromLog(String user, String masked);
  /// 初始凭据找不回来：它只在启动时往自己的输出里打一次（关掉程序就没了）。要拿到一条可用的，就让框架重启它一次（那一次的输出会被捕获并显示在这里）。
  String get settingsCredentialLost;
  /// 协议与隐私政策还没同意——面板解锁之前，接入 QQ 的入口是锁着的。
  String get settingsConsentPending;
  /// 初始口令还没改：两个门里第一个就是改密，面板会一直要求你先改它。
  String get settingsPasswordUnchanged;
  /// 扫码登录在 $webuiUrl 里做（框架不代管 QQ 登录态）。
  String settingsQrLoginAt(String webuiUrl);
  /// 凭据已复制（用户 + 口令）
  String get settingsCredentialCopied;
  /// 复制凭据
  String get settingsCopyCredential;
  /// 也可以自己来：从 $protocolDownloadUrl 下载发行包解压，把那个目录填在上面。这条路在一键安装失败、或者你想自己控制版本时用；框架也从同一个地址代下载，不随框架分发它（许可是"源码可见非商业"，自用没问题）。
  String settingsManualDownloadGuide(String protocolDownloadUrl);
  /// 第三方组件：SnowLuma
  String get settingsProtocolThirdPartyTitle;
  /// SnowLuma 是独立第三方项目，由 SnowLumaDevs 开发与维护：本项目只是代为从官方 Releases 下载、解压并托管它的进程，不修改它的任何文件。使用须遵守其 EULA 与 LICENSE，且仅限非商业用途。
  String get settingsProtocolThirdPartyNote;
  /// 官方项目
  String get settingsProtocolOfficialProject;
  /// 官方站点
  String get settingsProtocolOfficialSite;
  /// 许可（EULA / LICENSE）
  String get settingsProtocolLicenseRow;
  /// 改动已写入 config.json，但要重启进程才接管：运行中的协议端实例是按启动时那份配置建的。重启之前，这里显示的状态仍是本次启动的那一个。
  String get settingsProtocolRestartNote;
  /// 安装目录不能为空
  String get settingsInstallDirRequired;
  /// 已请求启动
  String get settingsStartRequested;
  /// 已请求停止
  String get settingsStopRequested;
  /// 安装请求失败：$err（请求没走到安装那一步，先确认主进程在跑）
  String settingsInstallRequestFailedHint(String err);
  /// 一键安装失败：原因见卡片
  String get settingsOneClickFailed;
  /// 安装失败，服务端没有给出原因（回执里没有 detail）
  String get settingsInstallNoReason;
  /// 已装好
  String get settingsInstalledOk;
  /// 已装好并用它配好了；重启一下就能用
  String get settingsInstalledConfigured;
  /// 已装好，但自动配置没写成：见卡片里的说明
  String get settingsInstalledNotConfigured;
  /// （重启进程后接管）
  String get settingsRestartSuffixParen;
  /// 已生成
  String get settingsGenerated;
  /// 还没有生成
  String get settingsNotGenerated;
  /// 外部系统往这台实例投递用的专用凭据（POST /webhook/*）。
  String get settingsWebhookNote;
  /// 凭据状态读取失败（$webhookError）。状态看不见时先别按"重新生成"：轮换不可逆（旧的那份当场失效），而此刻你并不知道有没有人在用它。
  String settingsWebhookErrorHint(String webhookError);
  /// 正在读取 webhook 凭据状态…
  String get settingsWebhookLoading;
  /// 当前凭据
  String get settingsWebhookCurrent;
  /// 凭据 $secretId · 生成于 $createdAt
  String settingsWebhookCurrentValue(String secretId, String createdAt);
  /// 这条通道现在一律 401（没有凭据就没人投得进来）。按下面的按钮生成一份。
  String get settingsWebhookNotConfiguredNote;
  /// 上次轮换
  String get settingsWebhookRotated;
  /// 从未
  String get settingsWebhookNever;
  /// 发起方：$by
  String settingsWebhookBy(String by);
  /// 重新生成
  String get settingsRegenerate;
  /// 生成 webhook 凭据
  String get settingsGenerateWebhook;
  /// /webhook/* 不认界面凭据（也不认迁移期那份 data/.ui-token）：这条通道只认上面那份专用凭据。它是给外部系统的——投得进来，读不到 /api/* 上的任何东西。
  String get settingsWebhookCredentialNote;
  /// 重新生成 webhook 凭据
  String get settingsRegenerateTitle;
  /// 上一份会当场失效：已经在用它的外部脚本会立刻开始收 401——记得把新凭据一起换过去。新凭据只显示一次。
  String get settingsRegenerateBody;
  /// 服务端没有回凭据原文，请再按一次；若反复如此，去看主进程日志
  String get settingsNoTokenReturned;
  /// 上一份已当场失效（还在用它的外部脚本会开始收 401）。
  String get settingsWebhookRotatedNote;
  /// 生成失败：$err
  String settingsGenerateFailed(String err);
  /// 长期记忆（MEMORIES/ 与 diary/）由谁维护：框架替你管，还是她自己读、自己写、自己整理。
  String get settingsMemoryNote;
  /// 尚未生效
  String get settingsNotInEffect;
  /// 让框架自动管记忆（关掉 = 她只知道自己有这些文件，读、写、整理全归她）
  String get settingsMemoryEnableLabel;
  /// 开着：框架生成并维护 MEMORIES/INDEX.md，每轮把索引注入固定块，并每日整理一次。
  String get settingsMemoryEnableNote;
  /// 框架自动管记忆（每轮注入索引、每日整理）
  String get settingsMemoryOn;
  /// 她自己管（框架不生成、不注入、不整理）
  String get settingsMemoryOff;
  /// 不受这个开关影响的两条路：MEMORIES/aliases.md 参与「会话认人 / 关注名单」属于通道侧；STATE.md（她当前状态）是独立的一层。
  String get settingsMemoryUnaffectedNote;
  /// 这一项是进程启动时读的：保存写进 config.json，重启后接管。关掉不会删任何文件。
  String get settingsMemoryRestartNote;
  /// 关掉之后框架不生成、不注入、不整理，但她照旧能自己读写那些文件。为什么留这个开关：给只想让 agent 自己管记忆的人一条干净的路。每日整理的时间点由 wake.memoryMaintainCron 定（默认每日一次）：过期的流水账并进 f…
  String get settingsMemoryDetail;
  /// 代价：她可能忘记整理，facts.md 会一直长下去，索引也不再更新——这些都归她自己。
  String get settingsMemoryCost;
  /// 已改为框架自动管记忆（重启后接管）
  String get settingsMemoryOnSaved;
  /// 已改为她自己管记忆（重启后接管）
  String get settingsMemoryOffSaved;
  /// 她的活动边界：整台电脑，或只有一个工作目录。越界就是拒绝，不是提醒。
  String get settingsTrustNote;
  /// 她能碰到多远
  String get settingsTrustReachLabel;
  /// 两档各自管什么写在选项里，改哪一档就按哪一档的后果算。
  String get settingsTrustReachNote;
  /// 只限工作目录（路径未读到）
  String get settingsTrustWorkspaceUnknownPath;
  /// 只限工作目录 · $root
  String settingsTrustWorkspaceValue(String root);
  /// 完全信任（整台电脑）
  String get settingsTrustFullValue;
  /// 上面选的那一档还没生效：盘上已经写下了，但正跑着的这个进程用的仍是启动时读到的那份——重启后接管。在那之前，她照旧按当前生效的那一档活动。
  String get settingsTrustPendingNote;
  /// 工作目录由服务端算出来（默认 <配置目录>/workspace），界面上不手填：同一条边界写两个值，就一定会出现"配置说 A、实际拦在 B"。
  String get settingsTrustRootNote;
  /// 它是边界，不是提醒：越界的读写与命令一律被拒绝。
  String get settingsTrustBoundaryNote;
  /// 它管 fs 工具族（safe_read / safe_write / safe_edit / rg_search 等）与 pwsh：前者经同一条路径判定，后者的 workdir 与命令行里的路径一起受管。它与 destructive 开关、…
  String get settingsTrustRulesDetail;
  /// 改成完全信任
  String get settingsTrustFullTitle;
  /// 这是一条边界，撤掉它她是真的能做到上面这些事。确定吗？
  String get settingsTrustFullConfirmTail;
  /// 已改为只限工作目录；越界的读写与命令会被拒绝（重启进程后接管）
  String get settingsTrustWorkspaceSaved;
  /// 已改为完全信任（重启进程后接管）
  String get settingsTrustFullSaved;
  /// 监听地址、时区、六条预算与心跳都是这个进程的启动参数：在这里改，保存写进 config.json，重启后生效。压缩线那一行例外——它写完立刻生效（服务端在同一个临界区里也改了内存那份）。
  String get settingsSystemNote;
  /// 数据目录
  String get settingsDataDir;
  /// 启动时定下的路径：事件日志、人格资产与密钥都在它下面，换它等于让下一个进程从空目录开始。
  String get settingsDataDirNote;
  /// 数据目录在这里改不了（它决定她的全部身家落在哪，且进程启动时就定下了）；其余字段保存后重启进程生效——压缩线那一行除外，它保存完就当拍接管。
  String get settingsSystemFootnote;
  /// 立刻生效
  String get settingsLiveNow;
  /// 编辑
  String get settingsEdit;
  /// 进来这个界面用的凭据：改密码与登出。
  String get settingsAccountNote;
  /// 旧的共享 token
  String get settingsAccountLegacyBadge;
  /// 会话凭据
  String get settingsAccountSessionBadge;
  /// 当前实例
  String get settingsAccountInstance;
  /// 凭据按实例分文件存（%APPDATA%\\Irmia\\sessions）：同一台机器上开第二个实例不会把这一份顶掉。
  String get settingsAccountInstanceNote;
  /// 这一份用的是旧的共享 token（这台实例还没设过密码），服务端不认它开出的"会话"：改密码与退出登录都做不成（结束实例不受影响）。先设置一个密码，之后按会话登录/退出登录。
  String get settingsAccountLegacyNote;
  /// 改密码
  String get settingsChangePassword;
  /// 退出登录（清除本机凭据）
  String get settingsLogout;
  /// 先去设置密码
  String get settingsSetPasswordFirst;
  /// 密码已改；这台界面已经换上新凭据
  String get settingsPasswordChanged;
  /// 退出登录这条路（与「结束实例」的区别写在这里）：作废会话、清本机凭据、停后端——下次要用密码进来。
  String get settingsLogoutBody;
  /// 结束实例（设置页那颗按钮 / 它的确认框标题）
  String get settingsCloseInstance;
  /// 结束实例的确认框正文：停后端、回选择页，**登录状态保留**——回来点「进入」就能进。
  String get settingsCloseInstanceBody;
  /// 门上那句中性提示：会话凭据失效了，请重新登录（不是错误，是"该走哪一扇门"）。
  String get gateHintSessionExpired;
  /// 门上那句中性提示：这台实例还没有密码，先设一个。
  String get gateHintSetupNeeded;
  /// 门前等待那一屏的第二半句："后端还没起来（正在等 :7788）"（2026-10-26）。
  String gateWaitingBackend(int port);
  // ── 门上那三档（2026-10-28：连不上 / 正在启动 / 密码不对，各说各的）──
  /// ①「连不上」那一档：后端还没起来（[address] 形如 `127.0.0.1:7788`），界面会自动重探。
  String gateBackendDown(String address);
  /// ②「正在启动」那一档：端口在听、重活没干完。[phase] 是 [backendPhaseLabel] 翻过的人话
  /// （空串 = 这一版后端不报阶段）。
  String gateBackendStarting(String phase);
  /// 服务端报的启动阶段 → 人话：`events` 事件回放 · `mcp` 外部工具 · `channels` 消息通道 ·
  /// `ready` 就绪；认不出的原样显示（将来后端加了新阶段，界面不该吞掉它）。
  String backendPhaseLabel(String phase);
  /// 门前那行小字：`第 N 秒 · 已重试 M 次`（别再让人猜"它到底还在试没有"）。
  String gateBackendProgress(int seconds, int retries);
  /// 60 秒仍未就绪时追加的那一句（给一条去处的线索）。
  String get gateBackendLogHint;
  // ── 实例选择页（2026-10，多实例：结束实例 → 回到这里选一台 / 新建一台）──
  /// 页标题
  String get pickerTitle;
  /// 页说明（上一台实例已经结束：后端停了，但登录状态保留——点「进入」就直接回来；实例之间完全隔离）
  String get pickerBody;
  /// 正在读实例列表…
  String get pickerLoading;
  /// 还没有登记过实例（空表）
  String get pickerEmpty;
  /// 读不出实例列表（文件不在或已损坏）——只能新建
  String get pickerUnreadable;
  /// 列表里那一行的状态词：运行中
  String get pickerRunning;
  /// 列表里那一行的状态词：未运行
  String get pickerStopped;
  /// 默认实例的徽章
  String get pickerDefaultBadge;
  /// 没票（或票已失效）那台的按钮：要走密码门
  String get pickerLogin;
  /// 没票且未运行那台的按钮：先拉起，再走密码门
  String get pickerStart;
  /// 正在启动…
  String get pickerStarting;
  /// 有票且运行中那台的按钮：点一下直接进壳（不打密码门）
  String get pickerEnter;
  /// 有票但未运行那台的按钮：先拉起，再拿票直接进
  String get pickerStartEnter;
  /// 正在进入…（有票、正在验票那一拍）
  String get pickerEntering;
  /// 忘记凭据（每行的小字动作 / 它的确认框标题）：只清本机 token，不停实例
  String get pickerForget;
  /// 「登录状态已失效，需要重新登录」那一行轻提示（票被服务端判了 401 之后）
  String get pickerSessionExpired;
  /// 新建实例（按钮 / 表单标题）
  String get pickerNew;
  /// 删除（按钮）
  String get pickerDelete;
  /// 新建表单：名字
  String get pickerNewNameLabel;
  /// 新建表单：数据目录
  String get pickerNewDirLabel;
  /// 新建表单：创建
  String get pickerNewCreate;
  /// 「目录已存在且非空」那条路上的第二个动作
  String get pickerNewUseDir;
  /// 删除确认框标题
  String get pickerDeleteTitle;
  /// 删除确认框正文（带参数：要删的那台的名字）
  String pickerDeleteBody(String name);
  /// 「忘记凭据」的确认框正文（带参数：那台实例的名字）——只清本机 token 这一条边界
  String pickerForgetBody(String name);
  /// 删除确认框里的说明（只删条目 vs 连目录一起删，后者不可恢复）
  String get pickerDeleteNote;
  /// 删除确认框：只删条目（默认，目录留着）
  String get pickerDeleteKeepDir;
  /// 删除确认框：连数据目录一起删
  String get pickerDeleteWithDir;
  /// 改名（名字旁那个小铅笔的提示 / 按钮）
  String get pickerRename;
  /// 改名对话框标题
  String get pickerRenameTitle;
  /// 改名对话框正文（说清"改过之后后端不再覆盖"这条语义）
  String get pickerRenameBody;
  /// 改名对话框：保存
  String get pickerRenameSave;
  /// 出错：名字空着
  String get pickerProblemNameRequired;
  /// 出错：登记表里没有可用的启动路径（node / 入口）
  String get pickerProblemNoLauncher;
  /// 出错：后端没能启动
  String get pickerProblemLaunchFailed;
  /// 出错：7788 起找不到空闲端口
  String get pickerProblemPortUnavailable;
  /// 出错：删不掉（实例列表文件写不进去）
  String get pickerProblemRemoveFailed;
  /// 出错：改不了名（实例列表文件写不进去）
  String get pickerProblemRenameFailed;
  /// 出错（带参数）：目录已存在且非空
  String pickerProblemDirNotEmpty(String dir);
  /// 出错（带参数）：等就绪超时——说清"等了多久、它到哪一步"，而不是只说"超时"
  String pickerProblemNotReady(int seconds, String phase, String port);
  /// 出错（带参数）：那个端口上住着另一台实例
  String pickerProblemPortTaken(String id);
  /// 出错（带参数）：它在跑，先结束它再删
  String pickerProblemCannotDeleteRunning(String name);
  /// 出错（带参数）：默认实例不能删
  String pickerProblemCannotDeleteDefault(String name);
  /// 正在启动某台实例（带参数：它的名字）
  String pickerStartingNamed(String name);
  /// 「将使用端口 :7789」（新建表单里那行读数）
  String pickerNewPort(String port);
  /// 删除按钮为什么是灰的（带参数：运行中 / 默认）
  String pickerDeleteDisabled(String reason);
  /// 选择页正在等一台实例就绪（带参数：已等秒数 / 阶段人话；phase 空串 = 不报阶段）
  String pickerWaitingReady(int seconds, String phase);
  /// 等待期间那颗按钮：「停止等待」
  String get pickerStopWaiting;
  /// 门上那句中性提示：这台实例已设过密码，请用密码登录（设置页收到 409 之后换门）。
  String get gateHintAlreadyInitialized;
  /// 界面版本与运行期投影数据。
  String get settingsAboutNote;
  /// Flutter 原生界面
  String get settingsAboutBadge;
  /// 版本
  String get settingsVersionLabel;
  /// 守护天数
  String get settingsGuardedDays;
  /// 事件水位
  String get settingsWatermark;
  /// 运行数据读取失败（$projError），守护天数与事件水位不可用。
  String settingsProjectionReadFailedHint(String projError);
  /// 守护天数与事件水位取自运行期投影（GET /api/projection），为实测值。
  String get settingsProjectionFootnote;
  /// $days 天
  String settingsDaysCount(String days);
  /// $days 天（自 $stamp）
  String settingsDaysSince(String days, String stamp);
  /// destructive 工具策略
  String get settingsDestructivePolicy;
  /// 修改
  String get settingsModify;
  /// 全关（一件都不给她看）
  String get settingsPolicyNoneOption;
  /// 全开（清单里全给）
  String get settingsPolicyAllOption;
  /// 按名单（只给勾中的那几件）
  String get settingsPolicyListOption;
  /// 按名单开放
  String get settingsPolicyListTitle;
  /// 没拿到工具清单（注册表可能还没起来）——先去「扩展 · 工具」看一眼再回来。
  String get settingsPolicyNoTools;
  /// 修改 destructive 工具策略
  String get settingsDestructiveTitle;
  /// 这会让她能看到并调用会改动本机的工具（写文件、跑命令等）。确定吗？
  String get settingsDestructiveRelaxedBody;
  /// 改回受限档：她将看不到 destructive 工具（更安全）。确定吗？
  String get settingsDestructiveRestrictedBody;
  /// 全开
  String get settingsPolicyAll;
  /// 按名单（空）
  String get settingsPolicyListEmpty;
  /// 全关
  String get settingsPolicyNone;
  // ── 设置页：手写的那几条（拼接 / 插值表达式 / 语序）──────────────
  /// 列表连接词（`written.join('与')`）：中文用「与」，英文用 " and "
  String get settingsListAnd;

  /// `已保存 <写入了什么><重启后缀>`
  String settingsSaved(String written, String restart);

  /// `清除密钥 · <哪条 lane>`
  String settingsClearKeyTitle(String laneLabel);

  /// `已配置 <掩码>`
  String settingsKeyConfiguredMask(String mask);

  /// pip 不可用那一行（[reason] 为 null 时不带括号）
  String settingsDepPipUnavailable(String? reason);

  /// 一键安装依赖前的确认框正文
  String settingsInstallConfirmBody(String managedDir);

  /// `<依赖名> 已就绪（<版本>）`
  String settingsDepReadyToast(String label, String version);

  /// `<阶段>：<原因>`
  String settingsStepErrorToast(String step, String error);

  /// `这一项没有下载页；装法：<提示>`
  String settingsNoDownloadPage(String hint);

  /// `打不开浏览器，地址是 <url>（<提示>）`
  String settingsOpenUrlFailed(String url, String? hint);

  /// `已装好 <版本>`
  String settingsInstalledVersion(String? version);

  /// 「装好了但自动配置没写成」那张说明
  String settingsWriteErrorNote(String writeError);

  /// `<时刻> 起`（协议端进程那一档的证据）
  String settingsChainSince(String when);

  /// `那份文件在（<路径>）但端点解析失败——要人去修它`
  String settingsChainUnreadableDetail(String path);

  /// 内置协议端开关的回执（开着 / 关掉 + 重启后缀）
  String settingsProtocolToggled(bool on, bool restart);

  /// `已保存安装目录：<路径><重启后缀>`
  String settingsInstallDirSaved(String saved, bool restart);

  /// `<启动|停止>请求失败：<原因>`
  String settingsProtocolActionFailed(bool start, String err);

  /// webhook 凭据文件那一行
  String settingsWebhookFileNote(String file);

  /// `改成完全信任之后：<后果>`
  String settingsTrustFullBody(String consequence);

  /// `按名单（N 项）`
  String settingsPolicyListCount(int count);

  /// 未知原因（服务端没给 error 时的兜底）
  String get settingsUnknownReason;

  /// 见官方文档（没有 manualHint 时的兜底）
  String get settingsSeeOfficialDocs;

  /// curl 例子里的凭据占位符
  String get settingsWebhookCurlTokenPlaceholder;

  /// curl 例子里的示例正文
  String get settingsWebhookCurlSampleText;

  /// `建议安装 N 项`
  String settingsDepsSuggested(int count);

  /// `pip <版本>（她可以自己 pip install 扩能力）`
  String settingsDepPipReady(String version);

  /// `<它是干什么的>。<没有它会怎样>`
  String settingsDepPurposeImpact(String purpose, String impact);

  /// `安装 <依赖名>`
  String settingsInstallTitle(String label);

  /// `保存（N 件）`
  String settingsPolicySave(int count);
  /// `已装好 <版本>，并用它配好了；重启一下就能用。` / `…，但自动配置那一步没成。`（失败时是「安装失败」）
  String settingsInstallHead(bool ok, String? version, bool configured);

  // ── 通道页（channels_page.dart） ────────────────────────────────────────────

  /// QQ 官方
  String get chanSourceQqOfficial;

  /// 入站唤醒
  String get chanEventInboundWake;

  /// 文件事件
  String get chanEventFile;

  /// 告警出口
  String get chanAlertExit;

  /// 开放平台管理端的机器人 ID。
  String get chanQqAppIdHint;

  /// 换取 access_token 的密钥。
  String get chanQqAppSecretHint;

  /// 协议端开了校验时必填。
  String get chanOneBotTokenHint;

  /// API 根地址
  String get chanQqApiBaseLabel;

  /// 留空用官方地址，只收 http(s)。
  String get chanQqUrlHint;

  /// 凭证地址
  String get chanQqTokenUrlLabel;

  /// 网关覆盖地址
  String get chanQqGatewayUrlLabel;

  /// 留空向凭证接口取，只收 ws(s)。
  String get chanQqGatewayHint;

  /// 协议端 ws 地址
  String get chanOneBotWsLabel;

  /// 协议端正向 WebSocket 端口，必须 ws:// 或 wss://。
  String get chanOneBotWsHint;

  /// 告警出口 webhook
  String get chanAlertWebhookLabel;

  /// 留空 = 告警只落日志、不对外发送。
  String get chanAlertWebhookHint;

  /// 同类告警限流窗口
  String get chanAlertRateLabel;

  /// 单位分钟。
  String get chanAlertRateHint;

  /// 连接端点 host:port
  String get chanEndpointLabel;

  /// 入站监听地址
  String get chanListenLabel;

  /// QQ 官方 Bot API
  String get chanQqTitle;

  /// AppID 与 AppSecret 在下面直接填值（存在本机 data/.keys.json，不进 config.json）；两者齐…
  String get chanQqHint;

  /// 协议端（NapCat / go-cqhttp）的正向 WebSocket；access_token 在下面直接填值。
  String get chanOneBotHint;

  /// 协议端正向 WebSocket
  String get chanOneBotBlurb;

  /// Webhook 与文件监听
  String get chanHookTitle;

  /// 出口地址为空时告警仅写入日志。
  String get chanHookHint;

  /// 告警出口 · 入站监听
  String get chanHookBlurb;

  /// 配置读取失败
  String get chanConfigReadFailed;

  /// 密钥状态读取失败
  String get chanKeysReadFailed;

  /// 清除密钥 · $label
  String chanClearSecretTitle(String label);

  /// 清除后需重新填写。
  String get chanClearSecretBody;

  /// 清除失败：$reason
  String chanClearFailed(String reason);

  /// $field 需要填数字，未保存
  String chanNotANumber(String field);

  /// 没有需要保存的改动
  String get chanNothingToSave;

  /// $count 项参数
  String chanSavedFieldCount(int count);

  /// $count 项密钥
  String chanSavedSecretCount(int count);

  /// ，进程重启后接管
  String get chanSavedRestartSuffix;

  /// ，下次建连时生效
  String get chanSavedLiveSuffix;

  /// 已保存$parts$suffix
  String chanSaved(String parts, String suffix);

  /// 已按生效配置重新加载
  String get chanReloaded;

  /// 已送达：${url.isEmpty ? '告警出口' : url} 收到了这条测试消息
  String chanTestDelivered(String url);

  /// 没送到${reason.isEmpty ? '：出口没有应答' : '：$reason'}
  String chanTestNotDelivered(String reason);

  /// 测试失败：$reason
  String chanTestFailed(String reason);

  /// 状态未知
  String get chanStatusUnknown;

  /// 生效配置尚未读取，通道状态未知。
  String get chanStatusUnknownNote;

  /// 未启用
  String get chanStatusOff;

  /// 已在配置中关闭，适配器不会建立连接。
  String get chanStatusOffNote;

  /// 已启用
  String get chanStatusOn;

  /// 尚无通道事件。
  String get chanStatusOnNote;

  /// 最近一条通道事件 $at$suffix。
  String chanStatusRunningNote(String at, String suffix);

  /// 未配置出口
  String get chanStatusNoExit;

  /// 出口地址为空，告警仅写入日志，不对外发送。
  String get chanStatusNoExitNote;

  /// 出口已配置
  String get chanStatusExitOn;

  /// 尚无触发记录：入站唤醒与文件事件均为空。
  String get chanStatusExitOnNote;

  /// 最近一条 $tag $at。
  String chanStatusHookRunningNote(String tag, String at);

  /// 通道活动读取失败（$error）。状态按配置文件判定。
  String chanFootnoteError(String error);

  /// 通道活动取自最近 50 条通道相关事件（实收 $count 条），状态据此判定。
  String chanFootnoteCount(int count);

  /// 消息适配器
  String get chanPageTitle;

  /// 入站通道、告警出口与文件监听
  String get chanPageSubtitle;

  /// 还没有启用任何消息通道。
  String get chanGuideText;

  /// 配置 QQ 官方
  String get chanGuideAction;

  /// 通道开关与端点参数都在本页的「通道配置」卡里改：写进 config.json，进程重启后接管。
  String get chanGuideHint;

  /// 渠道
  String get chanListHeader;

  /// 重新加载
  String get chanReloadAction;

  /// 配置
  String get chanConfigAction;

  /// 配置不可用
  String get chanConfigUnavailable;

  /// 本地服务 /api/config 未返回配置内容。
  String get chanConfigUnavailableHint;

  /// 渠道列表
  String get chanBackToList;

  /// 最近活动
  String get chanRecentActivity;

  /// 她怎么被称呼
  String get chanMentionTitle;

  /// 群里不打 @ 直接喊这几个词时，框架把那些话当作"在叫她"，与 @ 一样推到她面前。
  String get chanMentionNote;

  /// 现在只认平台的 @：群里不打 @ 直接喊她名字的那些话，她听不见。
  String get chanMentionEmpty;

  /// 改完立刻生效（下一句消息就按新名单判），不用重启。
  String get chanMentionHint;

  /// 没写进去：$problem
  String chanMentionSaveFailed(String problem);

  /// 已设为"只认 @ 叫她"
  String get chanMentionCleared;

  /// 记下了：$words
  String chanMentionSaved(String words);

  /// 会话联系人
  String get chanContactsTitle;

  /// QQ 不给昵称，在这里告诉她谁是谁。
  String get chanContactsNote;

  /// 说明
  String get chanDetailsLabel;

  /// 群聊里只有 @ 她或喊她的名字才会进对话流；其余能不能收到取决于官方 Bot 的消息权限——平台推给我们的，照旧进信箱。在群里 @ …
  String get chanContactsDetail;

  /// 还没有会话跟她说过话。等有人先来一句，这里就会列出那个会话。
  String get chanContactsEmpty;

  /// 群聊场景
  String get chanGroupSceneLabel;

  /// 硬拒绝：本机类工具不给
  String get chanGroupSceneHard;

  /// 软提醒：讲清风险，判断留给她
  String get chanGroupSceneSoft;

  /// 改完需要重启主进程才生效（联系人表不在热更名单里）。
  String get chanContactsRestartNote;

  /// $chat｜最后 $when
  String chanContactLine(String chat, String when);

  /// 备注：$note
  String chanContactNote(String note);

  /// 这是谁（留空 = 不署名）
  String get chanContactHint;

  /// 保存这个名字
  String get chanContactSaveTooltip;

  /// 收起群成员
  String get chanMembersCollapse;

  /// 展开群成员（$count）
  String chanMembersExpand(int count);

  /// 框架预警：已豁免
  String get chanWarnExempt;

  /// 框架预警：开
  String get chanWarnOn;

  /// 保存这个名字（下一轮生效）
  String get chanMemberSaveTooltip;

  /// 给 $who 起个名字
  String chanMemberNameTooltip(String who);

  /// 已豁免这个单聊的框架预警
  String get chanExemptSessionOn;

  /// 已恢复这个单聊的框架预警
  String get chanExemptSessionOff;

  /// 已豁免这个人的框架预警
  String get chanExemptMemberOn;

  /// 已恢复这个人的框架预警
  String get chanExemptMemberOff;

  /// 群聊场景已切到硬拒绝：她不能在群聊里动这台机器
  String get chanGroupSceneHardToast;

  /// 群聊场景已切回软提醒：框架提醒她，判断留给她
  String get chanGroupSceneSoftToast;

  /// 切换失败：$err
  String chanToggleFailed(String err);

  /// 名字不能为空
  String get chanNameRequired;

  /// 已记为「$name」——下一轮她就这么叫他
  String chanMemberSaved(String name);

  /// 已清除这个会话的名字
  String get chanContactCleared;

  /// 已记为「$name」——重启主进程后她就用这个名字认人
  String chanContactSaved(String name);

  /// 通道配置
  String get chanConfigTitle;

  /// 需重启
  String get chanNeedsRestart;

  /// 写入 config.json，重启后接管；清空一项 = 回到默认值。
  String get chanConfigNote;

  /// 密钥类字段直接填值：它存本机密钥文件，不进 config.json。环境变量优先于这些文件。
  String get chanConfigDetail;

  /// 测试告警出口
  String get chanTestAlert;

  /// 保存（$count 项改动）
  String chanSaveWithCount(int count);

  /// 启用该通道
  String get chanEnableLabel;

  /// 重启后建立连接并开始收消息。
  String get chanEnableNoteOn;

  /// 关闭状态：适配器不建立连接。
  String get chanEnableNoteOff;

  /// 已配置；粘贴新值可覆盖
  String get chanSecretHintConfigured;

  /// 粘贴$label
  String chanSecretHintPaste(String label);

  /// 已配置 $mask
  String chanSecretConfigured(String mask);

  /// 数字
  String get chanNumberHint;

  /// 未设置
  String get chanNotSetHint;

  /// 只读项（$count 项）
  String chanReadonlyFold(int count);

  /// 通道 id
  String get chanChannelIdLabel;

  /// 还没有通道活动——收到消息、唤醒或回投成功时才会有记录。
  String get chanFeedEmpty;

  /// 外部
  String get chanSourceExternal;

  /// 事件
  String get chanEventGeneric;

  /// 、
  String get chanJoinWords;
  // ── 日程页（schedule_page.dart） ────────────────────────────────────────────

  /// 返回的数据不是投影
  String get schedNotProjection;

  /// 取消这条安排？
  String get schedCancelTitle;

  /// 定时器 $timerId 会被取消：它到点不会再把她叫起来。\n这次撤销写进日志（timer/cancelled），撤错了只能让她重…
  String schedCancelBody(String timerId);

  /// 取消安排
  String get schedCancelPlan;

  /// 已取消 $timerId：到点不会再醒
  String schedCancelled(String timerId);

  /// 取消 $timerId 失败：$err
  String schedCancelFailed(String timerId, String err);

  /// 取消失败：$err
  String schedCancelFailedShort(String err);

  /// 已经排上了：$when · $note
  String schedBuilt(String when, String note);

  /// 已排上这条安排
  String get schedBuiltToast;

  /// （服务端没回时刻）
  String get schedNoServerTime;

  /// 周期 $label（下一次 $when）
  String schedRecurringWithNext(String label, String when);

  /// 搜索安排
  String get schedSearchTitle;

  /// 标题 / 到点做什么 / 为什么
  String get schedSearchHint;

  /// 搜索
  String get schedSearch;

  /// 近期安排
  String get schedPageTitle;

  /// 把日程、提醒和她自己的计划放在同一处。
  String get schedPageSubtitle;

  /// 回到本周
  String get schedBackToThisWeek;

  /// 新建安排
  String get schedNewPlan;

  /// 正在读她排着的安排…
  String get schedLoading;

  /// 读不到日程：$error
  String schedLoadFailed(String error);

  /// 这一页读的是投影 /api/projection 里的 timers：刷新一次试试；一直读不到说明主进程那边有问题。
  String get schedLoadHint;

  /// 本周安排
  String get schedStatThisWeek;

  /// 一次性与周期任务
  String get schedStatThisWeekNote;

  /// 等待触发
  String get schedStatWaiting;

  /// 到点后会重新判断
  String get schedStatWaitingNote;

  /// Agent 自主工作
  String get schedStatSelfWork;

  /// 不一定需要联系你
  String get schedStatSelfWorkNote;

  /// 待分享想法
  String get schedStatDrafts;

  /// 她的草稿还没有落盘
  String get schedStatDraftsNote;

  /// 周历
  String get schedCalendarTitle;

  /// 上一周
  String get schedPrevWeek;

  /// $month月$day日 — $endDay日
  String schedWeekRange(int month, int day, int endDay);

  /// 下一周
  String get schedNextWeek;

  /// 画不出这一周的周期条目：$count 条（在清单里）
  String schedUnplaceable(int count);

  /// $hour:$minute · 周期
  String schedTimeRecurring(String hour, String minute);

  /// $month月$day日
  String schedMonthDay(int month, int day);

  /// 周期
  String get schedRecurringPill;

  /// 这一周还没有安排。
  String get schedWeekEmpty;

  /// 这一周还有 $hidden 条没摆下，看右边的清单
  String schedWeekHidden(int hidden);

  /// 安排清单
  String get schedListTitle;

  /// 只看 $day
  String schedFilterDay(String day);

  /// 匹配「$query」
  String schedFilterQuery(String query);

  /// $count 条
  String schedFilterCount(int count);

  /// 看全部
  String get schedShowAll;

  /// 清除搜索
  String get schedClearSearch;

  /// 可能是它已经触发或已经被撤掉了；刷新一次看最新清单。
  String get schedActionGoneHint;

  /// 这里没有符合条件的安排。
  String get schedListNoMatch;

  /// 还没有排着的事。
  String get schedListEmpty;

  /// 安排只是一次机会——到点她会先确认还值不值得做，不值得就跳过。
  String get schedListEmptyHint;

  /// 选择一个安排
  String get schedDetailPlaceholder;

  /// 执行时间
  String get schedFieldWhen;

  /// 周期 $label（下一次在服务端重排）
  String schedDetailRecurring(String label);

  ///  · 周期 $label
  String schedDetailTimeSuffix(String label);

  /// 为什么安排它
  String get schedFieldWhy;

  /// 到点做什么
  String get schedFieldWhat;

  /// 到哪儿说
  String get schedFieldWhere;

  /// 时长
  String get schedFieldDuration;

  /// $dur 分钟
  String schedMinutes(Object? dur);

  /// $dur 分钟（约定值：这条没写 dur）
  String schedMinutesDefault(Object? dur);

  /// 到点后
  String get schedFieldAfter;

  /// 未写
  String get schedUnwritten;

  /// 已经跟她说了一句：『$text』
  String schedWakeReceipt(String text);

  /// 去聊天页看她的反应
  String get schedSeeChat;

  /// $text —— 这条是你直接排的：她到点会读到你的理由。
  String schedBuiltReceipt(String text);

  /// 到点提醒我
  String get schedChoiceNotify;

  /// 她自己先做
  String get schedChoiceSelf;

  /// 先存个草稿
  String get schedChoiceDraft;

  /// 每日记忆整理
  String get schedKindMemoryMaintain;

  /// 她自己等的
  String get schedKindWait;

  /// 未命名安排
  String get schedUntitled;

  /// 待分享草稿
  String get schedStatusDraft;

  /// 周期任务
  String get schedStatusRecurring;

  /// 待触发
  String get schedStatusWaiting;

  /// 这句和刚发过的完全一样，被当成同一条忽略了——过几秒再发一次就行
  String get schedWakeDeduped;

  /// 周
  String get schedViewWeek;

  /// 列表
  String get schedViewList;

  /// 周期 · $label
  String schedRecurringLine(String label);

  /// 她的内务
  String get schedChorePill;

  /// 到点会说：$label
  String schedWillSay(String label);

  /// 「日期」看不懂：写 今天 / 明天 / 后天 或 2026-10-20 都行。
  String get schedErrDate;

  /// 「钟点」要写成 20:00 这样（24 小时制）。
  String get schedErrClock;

  /// 「要做什么」要填：她到点看见的就是这一句。
  String get schedErrWhat;

  /// 「大概多久」填分钟数就行（不填就按半小时算）。
  String get schedErrDuration;

  /// 每天
  String get schedRepeatDaily;

  /// 每周
  String get schedRepeatWeekly;

  /// 写一句话再让她排（她读到的就是这一句）。
  String get schedErrBrief;

  /// 请帮我排一条安排：$text
  String schedWakePrefix(String text);

  /// 没能把这句话送到她那里：$err
  String schedWakeFailed(String err);

  /// 这条安排没能排上：$err
  String schedCreateFailed(String err);

  /// 一般更建议交给她建：她会自己写"为什么"，到点先确认还值不值得做。直接建是给你急用的。
  String get schedCardLead;

  /// 交给她建
  String get schedPathHer;

  /// 我直接建
  String get schedPathDirect;

  /// 稍后
  String get schedLater;

  /// 正在送…
  String get schedSending;

  /// 直接建
  String get schedCreateDirect;

  /// 让她排
  String get schedLetHerSchedule;

  /// 一句话跟她说
  String get schedFieldBrief;

  /// 下周一早上九点提醒我看周计划
  String get schedBriefHint;

  /// 这句话会直接送到她那里，由她来排。
  String get schedBriefNote;

  /// 哪一天
  String get schedFieldDay;

  /// 今天 / 明天 / 2026-10-20
  String get schedDayHint;

  /// 几点
  String get schedFieldClock;

  /// 要不要重复
  String get schedFieldRepeat;

  /// 只这一次
  String get schedRepeatOnceChoice;

  /// 每周（就这一天）
  String get schedRepeatWeeklyChoice;

  /// 要做什么
  String get schedFieldWhatToDo;

  /// 看一眼汇报材料定稿没有
  String get schedWhatHint;

  /// 更多选项（标题、分类、说给谁…）
  String get schedMoreOptions;

  /// 标题
  String get schedFieldTitle;

  /// 不填就用"要做什么"那句
  String get schedTitleHint;

  /// 为什么排它
  String get schedFieldWhyInput;

  /// 周三要交，我怕忘了
  String get schedWhyHint;

  /// 大概多久（分钟）
  String get schedFieldDurationInput;

  /// 分类
  String get schedFieldCategory;

  /// 不分类
  String get schedNoCategory;

  /// 要不要说给谁
  String get schedFieldSid;

  /// 不用告诉谁
  String get schedNoSid;

  /// 这个时刻已经过去了：落下去她会马上被叫醒一次。
  String get schedPastWarning;

  /// 建好之后它就是一条真安排：到点她会看见你写的这句。
  String get schedCreateNote;

  /// $name（$short）
  String schedSidWithName(String name, String short);

  /// $month月$day日
  String schedMonthDayRaw(Object month, Object day);

  /// $month月$day日 · $time
  String schedWhenStamp(int month, int day, String time);

  /// 周一
  String get schedWeekdayMon;

  /// 周二
  String get schedWeekdayTue;

  /// 周三
  String get schedWeekdayWed;

  /// 周四
  String get schedWeekdayThu;

  /// 周五
  String get schedWeekdayFri;

  /// 周六
  String get schedWeekdaySat;

  /// 周日
  String get schedWeekdaySun;

  /// 每天 $time
  String schedCronDaily(String time);

  /// $from至周$to
  String schedCronRange(String from, String to);

  /// 每周$weekdays $time
  String schedCronWeekly(String weekdays, String time);

  /// 工作 / 学习
  String get schedCatWork;

  /// 陪伴 / 交流
  String get schedCatPersonal;

  /// 生活习惯
  String get schedCatLife;

  /// 周期计划
  String get schedCatRoutine;

  /// 自主工作
  String get schedActionSelf;

  /// 提醒你
  String get schedActionNotify;

  /// 存草稿
  String get schedActionDraft;
  // ── 扩展页（extensions_page.dart） ────────────────────────────────────────────

  /// 技能
  String get extSectionSkills;

  /// 任务知识包：一份 SKILL.md 说明什么时候用它、怎么用
  String get extSectionSkillsBlurb;

  /// 外部工具服务：按需拉起一个可执行程序，工具都从内置的 mcp 工具走
  String get extSectionMcpBlurb;

  /// 内置工具
  String get extSectionTools;

  /// 随程序一起来的工具：按组开关，关掉即从她的清单里拿掉
  String get extSectionToolsBlurb;

  /// 执行点钩子：PreToolUse / PostToolUse / Wake 三处可插入外部命令
  String get extSectionHooksBlurb;

  String get extSectionPlugins;
  String get extSectionPluginsBlurb;
  String get extPluginInstall;
  String get extPluginInstallTitle;
  String get extPluginSourceDir;
  String get extPluginSourceHint;
  String get extPluginAbsoluteRequired;
  String get extPluginEmpty;
  String get extPluginEmptyHint;
  String extPluginSummary(int count);
  String extPluginStat(int count);
  String extPluginState(String state);
  String get extPluginRestartRequired;
  String extPluginContributions(int skills, int hooks, int mcp);
  String extPluginVersionHash(String version, String hash);
  String get extPluginPermissionsLabel;
  String get extPluginProblemsLabel;
  String get extPluginReview;
  String extPluginReviewTitle(String id);
  String extPluginReviewBody(String id, String hash);
  String get extPluginEnable;
  String get extPluginDisable;
  String extPluginEnableTitle(String id);
  String extPluginDisableTitle(String id);
  String get extPluginRestartBody;
  String get extPluginInstalledToast;
  String extPluginConfirmedToast(String id);
  String extPluginRestartToast(String action, String id);
  String extPluginFailed(String reason);
  String extPluginCircuit(String contribution, int count);
  String extPluginCircuitReason(String reason);
  String extPluginRetryAt(String at);

  /// 响应格式无法识别
  String get extBadResponse;

  /// 技能、MCP 服务、内置工具与执行点钩子
  String get extPageSubtitle;

  /// 扩展项
  String get extListHeader;

  /// 数据读取失败
  String get extDataReadFailed;

  /// 本地服务 /api/$endpoint 的响应不是预期结构。
  String extBadStructure(Object? endpoint);

  /// 扩展项列表
  String get extBackToList;

  /// 扫描目录
  String get extRescan;

  /// 新建技能
  String get extNewSkill;

  /// $active 已生效 · $pending 待确认 · catalog $tokens token
  String extSkillsSummary(int active, int pending, int tokens);

  /// 还没有安装技能。
  String get extNoSkills;

  /// 技能是一个目录：skills/‹name›/SKILL.md。扫描到之后要过信任门（在这里确认）才进 catalog。
  String get extNoSkillsHint;

  /// 待确认
  String get extPendingTitle;

  /// 未经确认不会进入 catalog——描述写得再好，她这会儿也看不见它。
  String get extPendingHint;

  /// 已生效
  String get extActiveTitle;

  /// 已进 catalog：她每一轮都能看到这些名字与描述。
  String get extActiveHint;

  /// 还没有已确认的技能——待确认的那些确认之后会出现在这里。
  String get extActiveEmpty;

  /// 已忽略
  String get extIgnoredTitle;

  /// 仅本机备忘（落 data/skills-ignored.json）：不写事件、不进 catalog，换台机器不会跟着走。
  String get extIgnoredHint;

  /// 被拒绝的目录
  String get extRejectedTitle;

  /// frontmatter 非法或重名：这些目录她读不到，修好 SKILL.md 后重新扫描即可。
  String get extRejectedHint;

  /// $dir：$reason
  String extRejectedLine(Object? dir, Object? reason);

  /// 技能就在 ‹项目根›/skills/‹name›/SKILL.md：目录名即技能名（小写字母、数字、连字符）。
  String get extGuideSkillPath;

  /// 扫描之后要过信任门——只有你在这里点「确认」写下 skill/installed，它才进 catalog。
  String get extGuideSkillTrust;

  /// 已进 catalog
  String get extInCatalogBadge;

  /// 描述
  String get extFieldDescription;

  /// 技能文件
  String get extFieldSkillFile;

  /// 体积与指纹
  String get extFieldSizeHash;

  /// $bytes 字节 · $short
  String extSizeHash(int bytes, String short);

  /// 信任详情
  String get extFieldTrustDetail;

  /// 恢复：重新列回待确认
  String get extActionRestore;

  /// 停用：从 catalog 里收起来（不改文件，随时可恢复）
  String get extActionRetire;

  /// 删除：把技能目录整份移进回收站（可恢复，不是 rm -rf）
  String get extActionDelete;

  /// 确认：写入 skill/installed，技能进入 catalog
  String get extActionConfirm;

  /// 忽略：收进「已忽略」，不写事件、不进 catalog
  String get extActionIgnore;

  /// 已确认：$name 已进入 catalog
  String extConfirmedToast(String name);

  /// 确认失败：$reason
  String extConfirmFailed(String reason);

  /// 已忽略：$name（仅本机备忘）
  String extIgnoredToast(String name);

  /// 已放回待确认：$name
  String extRestoredToast(String name);

  /// 操作失败：$reason
  String extOpFailed(String reason);

  /// 停用技能 · $name
  String extRetireTitle(String name);

  /// 停用 = 收进「已忽略」，她下一轮就不再看到它（catalog 里没有它）。技能文件一个字节都不动，想放回来点「恢复」即可。
  String get extRetireBody;

  /// 停用
  String get extDisable;

  /// 删除技能 · $name
  String extDeleteSkillTitle(String name);

  /// 整个目录会移进回收站（‹dataDir›/trash/），「不是 rm -rf」：内容一个字节不改，把那一份移回原处就恢复。删掉之后…
  String get extDeleteBody;

  /// 删除
  String get extDelete;

  /// 已删除：$name 已移进回收站（内容未改，可移回恢复）
  String extDeletedToast(String name);

  /// 删除失败：$reason
  String extDeleteFailed(String reason);

  /// 会在 skills/‹名字›/SKILL.md 生成一份符合规范的骨架，然后停在待确认——确认之前她看不到它。名字只能用英文小写、数…
  String get extCreateHint;

  /// 技能名
  String get extFieldSkillName;

  /// 如 morning-review
  String get extSkillNameHint;

  /// 只允许小写字母、数字与连字符
  String get extSkillNameInvalid;

  /// 一句话描述
  String get extFieldOneLineDesc;

  /// 写清它做什么、什么时候该用它——这是她唯一能看到的触发条件
  String get extOneLineDescHint;

  /// 已生成 ${path.isEmpty ? 'SKILL.md' : path}，在「待确认」里等你的确认
  String extSkillCreatedToast(String path);

  /// 新建失败：$reason
  String extCreateSkillFailed(String reason);

  /// 添加服务
  String get extAddServer;

  /// $servers 个服务 · $running 已运行 · 工具 $tools 件$pendingPart
  String extMcpSummary(int servers, int running, int tools, String pendingPart);

  /// 待批：她递来的申请单（$count）
  String extPendingGrants(int count);

  /// 还没有进入待批（$count）
  String extUnpreparedGrants(int count);

  /// 这些申请单还没被框架拾取
  String get extUnpreparedTitle;

  /// 框架每一拍扫一次申请单目录。刚写完的等下一拍；一直停在这里的多半是没通过校验——那一拍会落一条结局（驳回理由在「已答复」那一段里），…
  String get extUnpreparedHint;

  /// 配置问题
  String get extConfigProblems;

  /// 已声明但读不出来：修好 config.json 的 mcp.servers 后重新加载。
  String get extConfigProblemsHint;

  /// 已答复的申请单
  String get extAnsweredTitle;

  /// 她递过的单子与它们的结局。批准之后由框架写 config.json；"批准了但没装成"会如实写在这一行里（那与"被驳回"是两件事）。
  String get extAnsweredHint;

  /// 一个 MCP 服务就是一个可执行程序：主进程按需拉起它、空闲 5 分钟回收，所以"没在跑"是常态。
  String get extGuideMcp1;

  /// 工具默认不信任（sideEffect = destructive）：要在 config.json 里为它显式声明才降级，配置改完要重…
  String get extGuideMcp2;

  /// 她可以自己发起增删（写一份申请单，见上面「待批」那一段）——你在这里点批准或驳回即可。
  String get extGuideMcp3;

  /// 已驳回$suffix——她下一拍会收到这条决定
  String extGrantRejectedToast(String suffix);

  /// 已批准并写进配置$suffix
  String extGrantApprovedToast(String suffix);

  /// 已批准，但执行没成功：$failure
  String extGrantApprovedFailedToast(String failure);

  /// 没能记下这个决定：$reason
  String extGrantDecideFailed(String reason);

  /// 批准之后装进技能根 skills/<名字>；不会自动执行，要她读才会读（skill-install 那一支）
  String get extGrantAfterSkillInstall;

  /// 批准之后整目录移进回收站（data/trash/），可移回（skill-remove 那一支）
  String get extGrantAfterSkillRemove;

  /// 框架已装进技能根（skill-install 的执行结果 ok 态）
  String get extGrantExecOkSkillInstall;

  /// 已移进回收站（skill-remove 的执行结果 ok 态）
  String get extGrantExecOkSkillRemove;

  /// 装（已审批那一行的首字，只服务 skill-install；MCP 那两支仍是"加"/"删"）
  String get extGrantLabelSkillInstall;

  // ── 右下角「待批」通知卡（2026-10-21：新手找不到在哪审批） ────────────
  //
  // 这一族只服务 `lib/grant_inbox_overlay.dart`：卡面、折叠成细条后的那一行、以及
  // 超过三张时的溢出那一行。与上面 `extGrant*` 的分工：那些是**扩展页里那张完整卡**
  // 的说法（含"批准之后会发生什么"的长句），这里是"一眼看懂 + 两个按钮"——
  // 句子必须短，而**高风险那一条的按钮文案单独一句**（见 [grantInboxApproveHighRisk]）。
  //
  // 为什么动词按 kind 分成四个方法而不是"动词 + 名字"两段拼：语序因语言而异
  // （英文 `Add an MCP server: x` / 中文 `加一个 MCP 服务：x`），拼字符串就是把语序写死。

  /// 加一个 MCP 服务：$name
  String grantInboxActionMcpAdd(String name);

  /// 删掉 MCP 服务：$name
  String grantInboxActionMcpRemove(String name);

  /// 装一个技能：$name
  String grantInboxActionSkillInstall(String name);

  /// 删掉技能：$name
  String grantInboxActionSkillRemove(String name);

  /// 她递了一张申请单：$name（认不出的 kind 的兜底：不猜它是加还是删）
  String grantInboxActionUnknown(String name);

  /// 命令：$command（MCP 那一支的"一行风险/影响"就是它）
  String grantInboxCommand(String command);

  /// 带 $count 个可执行脚本；不会自动执行（脚本数 > 0 的 skill-install 用这一句）
  String grantInboxRiskSkillScripts(int count);

  /// 不会自动执行：批准只是把目录装进来，她读的时候才用到（脚本数 = 0 的 skill-install）
  String get grantInboxRiskSkillInstall;

  /// 整目录移进回收站（data/trash/），可移回（skill-remove）
  String get grantInboxRiskSkillRemove;

  /// 它会拉起一个本机进程（启动命令没写时的那一句，参数在详情里）
  String get grantInboxRiskMcpAdd;

  /// 从 config.json 的 mcp.servers[] 里删掉这一条（mcp-remove）
  String get grantInboxRiskMcpRemove;

  /// 这张单子要做什么，只有详情里说得清（认不出的 kind）
  String get grantInboxRiskUnknown;

  /// 这份单子是她自己写的（来源那一行）
  String get grantInboxSource;

  /// 高风险徽章（只有高风险那几张才有）
  String get grantInboxHighRiskBadge;

  /// 批准（低风险：点了就直接生效）
  String get grantInboxApprove;

  /// 查看并批准（**高风险专用**：点了先开详情，在详情里再批）
  String get grantInboxApproveHighRisk;

  /// 驳回
  String get grantInboxReject;

  /// 详情（打开扩展页那张完整卡）
  String get grantInboxDetails;

  /// 处理中…（按钮的操作中态；两枚按钮同时禁用，防连点）
  String get grantInboxWorking;

  /// 收起（待批还在，点一下再展开）——折叠成细条之前那个按钮的 tooltip
  String get grantInboxCollapseTooltip;

  /// 展开（细条的 tooltip：点它就把那一摞卡再摊开）
  String get grantInboxExpandTooltip;

  /// 打开扩展页（超过三张时「还有 N 条待批」那一行的 tooltip）
  String get grantInboxOpenExtensions;

  /// 关掉详情（详情弹窗右上角那枚 ×）
  String get grantInboxDetailsClose;

  /// 待批 · $count 条（堆叠上面那一行，点击收起）
  String grantInboxHeader(int count);

  /// 还有 $count 条待批（超过三张时的溢出那一行；点它去扩展页）
  String grantInboxMore(int count);

  /// $count 条待批（收起之后那条细条上唯一的字）
  String grantInboxCollapsed(int count);

  /// 没记下这个决定：$reason（卡留在原地，原因写在卡里）
  String grantInboxFailed(String reason);

  /// **有一张申请单读不出来**（2026-10-22）：那一档在"待批"判据里两样都不满足
  /// （没有 `grant/requested` 事件 ⇒ `picked:false`；解析不过 ⇒ 连卡都挂不出来）。
  /// 它是唯一会在"一条待批都没有"时也显示出来的那一行——"有东西等你"不许静默。
  String get grantUnreadableTitle;

  /// 那句话的正文：哪一张、为什么读不出来（原因原样来自服务端的 `grantFileProblems`）
  String grantUnreadableBody(String id, String why);

  /// 读不出来的还有几张（跟在正文后面；语序因语言而异，所以整句归文案表）
  String grantUnreadableMore(int count);

  // ── 托盘上的待批提示（2026-10-21）──────────────────────────────
  //
  // 托盘是**关窗之后唯一还看得见的东西**：有待批时悬停提示与菜单首项都要写出来，
  // 点首项直接落到扩展页（与右下角那张卡同一件事，只是入口不同）。

  /// 有 $count 条待批（托盘菜单首项）
  String trayPendingItem(int count);

  /// $name · 有 $count 条待批（托盘悬停提示；名字还是她的名字，待批数挂在后面）
  String trayPendingTooltip(String name, int count);

  /// 还没有配置 MCP 服务。点页头那枚按钮加一个，填一段启动命令即可。
  String get extNoServers;

  /// 一个服务就是一个可执行程序：主进程按需拉起、空闲 5 分钟回收，所以「没在跑」是常态。
  String get extNoServersHint1;

  /// 它的工具默认按 destructive 处理，在 config.json 里显式声明才降级；改完要重启主进程才接管。
  String get extNoServersHint2;

  /// 已停用
  String get extDisabledBadge;

  /// $count 件工具
  String extToolCountBadge(int count);

  /// 折叠这个服务
  String get extCollapseServer;

  /// 展开这个服务
  String get extExpandServer;

  /// （没写它做什么——她在索引里只看到这个名字）
  String get extNoDesc;

  /// $desc（它自报的）
  String extSelfReportedDesc(String desc);

  /// 启动命令
  String get extFieldCommand;

  /// 环境变量
  String get extFieldEnv;

  /// 最近一次运行记录：$at$suffix
  String extLastRun(String at, String suffix);

  /// 日志里的 pid：$pid
  String extPidLine(Object? pid);

  /// 正在拉起进程…
  String get extStartingProcess;

  /// 测试连接
  String get extTestConnection;

  /// 编辑这个服务
  String get extEditServerTooltip;

  /// 删除这个服务
  String get extDeleteServerTooltip;

  /// （这个服务没给描述）
  String get extNoToolDesc;

  /// 清单是完整的：$count 件全在上面。
  String extToolsAllListed(int count);

  /// 配置本来就是这样，没有改动
  String get extNoChange;

  /// 已生效，不用重启
  String get extTakeEffectNow;

  /// 需要重启主进程才生效
  String get extNeedsRestart;

  /// $name 已$action：$outcome
  String extMcpToggledToast(String name, String action, String outcome);

  /// 切换失败：$reason
  String extToggleFailed(String reason);

  /// 编辑 MCP 服务
  String get extEditMcpTitle;

  /// 添加 MCP 服务
  String get extAddMcpTitle;

  /// 一个服务 = 一段启动命令。保存写进 config.json 的 mcp.servers[]，写完即生效：调用走内置的 mcp 工具…
  String get extMcpFormLead;

  /// 服务名
  String get extFieldServerName;

  /// 给这个服务起的名字，调用时用得到（只允许字母、数字、- 与 _，如 filesystem）
  String get extServerNameHint;

  /// 要拉起的程序：uvx … 或 node D:\\…\\cli.js（绝对路径 .exe 也行）。启动器须在白名单里（node、uvx…
  String get extCommandHint;

  /// desc（它是干什么的）
  String get extFieldDesc;

  /// 一句话：这个服务是干什么的、你打算用它做什么（例如：读本机浏览器历史与当前标签页）
  String get extDescHint;

  /// 这一句会进她的常驻索引（一个服务一行）。留空也能保存——那样她在索引里只看到名字。
  String get extDescNote;

  /// args（一行一个）
  String get extFieldArgs;

  /// 每个参数占一行：-y 一行、包名一行
  String get extArgsHint;

  /// env（一行一个 KEY=VALUE）
  String get extFieldEnvForm;

  /// 可选：这几行之外，它还会继承主进程的环境变量
  String get extEnvHint;

  /// 测试连接超时（毫秒）
  String get extFieldTestTimeout;

  /// 首次拉包可能要 30s 以上；只影响这个对话框里的「测试连接」（500–60000），不写进配置
  String get extTestTimeoutHint;

  /// 启用这个服务（关掉 = 配置留着但不起进程，调用也不会拉起它）
  String get extEnableSwitchLabel;

  /// 服务名与 command 都得填
  String get extNameAndCommandRequired;

  /// 保存失败：$reason
  String extSaveFailed(String reason);

  /// $saved：$outcome$note
  String extMcpSavedToast(String saved, String outcome, String note);

  /// 先填 command 再测
  String get extFillCommandFirst;

  /// 测试失败：$reason
  String extTestFailed(String reason);

  /// 连接成功
  String get extConnectOk;

  /// 连接失败
  String get extConnectFailed;

  /// $name 起来了、握手通过、工具清单取回来了（${ms}ms）。
  String extProbeOk(Object? name, Object? ms);

  /// 它声明了 tools 能力但清单是空的：这个服务当前不提供工具。
  String get extProbeNoTools;

  /// 协议版本 $version$peer
  String extProtocolLine(String version, String peer);

  /// 进程已收掉（$stages）——不留后台进程。
  String extProbeShutdown(String stages);

  /// 未知原因
  String get extUnknownReason;

  /// 它的 stderr 尾部：$tail
  String extStderrTail(Object? tail);

  /// 知道了
  String get extGotIt;

  /// 删除 MCP 服务 · $name
  String extDeleteServerTitle(String name);

  /// 从 config.json 的 mcp.servers[] 里删掉这一条。她的 mcp 工具里不再有这个服务。程序本体不会被卸载。
  String get extDeleteServerBody;

  /// 已删除 $name：$outcome
  String extServerDeletedToast(String name, String outcome);

  /// 还没有工具注册表。
  String get extNoToolRegistry;

  /// 注册表由运行期装配；本进程读到空清单时不会有条目。MCP 服务的工具不在这个清单里：走内置的 mcp 工具按需看。
  String get extNoToolRegistryHint;

  /// 刷新
  String get extRefresh;

  /// $enabled 件启用 / 共 $total 件 · destructive：$policy
  String extToolsSummary(Object? enabled, int total, Object? policy);

  /// 关掉一件工具不改变能力边界，只是把它的名字从她的清单里拿掉——她下一轮就看不见它了。
  String get extToolsHint1;

  /// destructive 类工具本身还有一道独立的开关（tools.destructiveEnabled），这里关不掉那一道。
  String get extToolsHint2;

  /// $on / $total 件启用$note
  String extGroupSummary(int on, int total, String note);

  /// 全开
  String get extEnableAll;

  /// 全关
  String get extDisableAll;

  /// 已关闭
  String get extOffBadge;

  /// 并发模式
  String get extFieldMode;

  /// 超时
  String get extFieldTimeout;

  /// 关闭：从她的工具清单里拿掉
  String get extToggleOffMessage;

  /// 开启：放回她的工具清单
  String get extToggleOnMessage;

  /// $name：$reason
  String extToolFailureLine(String name, String reason);

  /// $state（$count 件）
  String extAllToggledToast(String state, int count);

  /// 有 $count 件没改成：$first
  String extSomeFailedToast(int count, String first);

  /// $name（必填）
  String extRequiredParam(Object? name);

  /// 添加钩子
  String get extAddHook;

  /// $relative 定义的是「谁能改我」：agent 对它只读（写入口被路径守卫拒绝），只有你在这里能改。这类操作都要求确认短语，改…
  String extHookBoundaryNote(String relative);

  /// $enabled 条生效 / 共 $total 条
  String extHooksSummary(int enabled, int total);

  /// 钩子条目
  String get extHooksTitle;

  /// 按文件顺序执行；一条钩子的超时不会阻塞主流程（超时即杀、输出丢弃）。
  String get extHooksHint;

  /// 还没有配置钩子。点页头那枚按钮加一条：钩子可以拒绝工具调用，也可以改写参数。
  String get extHooksEmpty;

  /// 无效条目
  String get extInvalidEntries;

  /// 无效条目不影响其余配置生效，但需要修掉——它现在一条都不会跑。
  String get extInvalidEntriesHint;

  /// 这条线画在"谁能改我"上：钩子能拒绝工具调用、能改写参数，所以 agent 永远改不了这份文件。
  String get extHookBoundary1;

  /// 从界面写它要带确认短语（X-Confirm: hook-save / hook-remove），写完重启主进程才装配。
  String get extHookBoundary2;

  /// 事件
  String get extFieldEvent;

  /// 触发条件
  String get extFieldCondition;

  /// 停用：保留命令行，但不装配它
  String get extHookToggleOffMessage;

  /// 启用：重启后装配它
  String get extHookToggleOnMessage;

  /// 编辑这条钩子
  String get extEditHookTooltip;

  /// 删除这条钩子
  String get extDeleteHookTooltip;

  /// 已$state这条钩子——重启主进程后装配
  String extHookToggledToast(String state);

  /// 编辑钩子
  String get extEditHookTitle;

  /// 钩子会在执行点上跑一条外部命令：stdin 收一段 JSON 上下文，退出码 2 = 拒绝（唯一强制通道），其他非零码不阻塞主流程。…
  String get extHookDialogNote;

  /// 执行点
  String get extFieldExecutionPoint;

  /// matcher（正则）
  String get extFieldMatcher;

  /// 对唤醒来源匹配：timer|file|webhook|manual|heartbeat
  String get extWakeMatcherHint;

  /// 对工具名匹配：safe_edit|safe_write
  String get extToolMatcherHint;

  /// command（交给系统 shell）
  String get extFieldShellCommand;

  /// 如 node scripts/check.mjs
  String get extShellCommandHint;

  /// 触发条件（可选）
  String get extFieldConditionOptional;

  /// 如 pwsh(rm *)，不匹配就不起进程
  String get extConditionHint;

  /// 超时（毫秒）
  String get extFieldTimeoutMs;

  /// 超时即杀并丢弃输出，不阻塞主流程
  String get extTimeoutHint;

  /// 启用（关掉 = 留在文件里但不装配）
  String get extEnableHookSwitch;

  /// matcher 与 command 都得填
  String get extMatcherAndCommandRequired;

  /// 已写入 data/hooks.json——重启主进程后装配
  String get extHookSavedToast;

  /// 从 data/hooks.json 里删掉第 $index 条。删掉之后它就不再参与任何执行点——想临时收起来用「停用」即可，不必删…
  String extDeleteHookBody(int index);

  /// 已删除——重启主进程后生效
  String get extHookDeletedToast;

  /// 状态未知
  String get extStatusUnknown;

  /// 读取中…
  String get extReading;

  /// $active 已生效 · $pending 待确认
  String extStatSkills(int active, int pending);

  /// $servers 个服务 · $running 已运行
  String extStatMcp(int servers, int running);

  /// $on 件启用 / 共 $total
  String extStatTools(int on, int total);

  /// $total 条$suffix
  String extStatHooks(int total, String suffix);

  ///  · 待批 $count
  String extPendingPart(int count);

  /// （没有写理由）
  String get extNoReasonGiven;

  /// ；这份改动要重启主进程才生效
  String get extRestartSuffix;

  /// （服务端没有给原因）
  String get extServerNoReason;

  /// （$reason）
  String extReasonParen(String reason);

  /// 启用
  String get extEnabledWord;

  /// 已保存$who
  String extSavedWho(String who);

  /// 已保存$who（停用状态）
  String extSavedWhoDisabled(String who);

  /// 　$descNote
  String extIndentedNote(String descNote);

  ///  · 对面自称 $name $version
  String extPeerVersion(Object? name, Object? version);

  /// 已全开
  String get extAllOnWord;

  /// 已全关
  String get extAllOffWord;

  ///  · $on 条生效
  String extEnabledPart(int on);

  /// 停用（状态说法；按钮那个走 extDisable）
  String get extDisabledWord;

  // ── 更新检查（2026-10-22；文案口径见 docs/update-check.md §5）──────────────

  /// 有新版本 v$latest（当前 v$current）· 查看
  String updateBannerAvailable(String latest, String current);

  /// 有新版本 v$latest（当前 v$current）· 低于最低可用版本，请升级
  String updateBannerRequired(String latest, String current);

  /// 查看
  String get updateView;

  /// 关闭这条提示
  String get updateDismiss;

  /// 更新
  String get updateSectionTitle;

  /// 只 GET 一个静态 JSON…（隐私说明；三种界面都读这一条）
  String get updateSectionNote;

  /// 检查更新
  String get updateCheckNow;

  /// 正在检查…
  String get updateChecking;

  /// 已是最新版本
  String get updateUpToDate;

  /// 更新检查已在配置里关闭（`update.enabled = false`）
  String get updateDisabled;

  /// 还没检查过
  String get updateNeverChecked;

  /// 这一版没有可打开的页面
  String get updateNoPage;

  /// 当前版本：v$version
  String updateCurrentVersion(String version);

  /// 最新版本：v$version
  String updateLatestVersion(String version);

  /// 有新版本 v$latest
  String updateAvailableText(String latest);

  /// 低于最低可用版本（v$minimum），请升级
  String updateRequiredText(String minimum);

  /// 这次没查到（$reason）
  String updateUnknownText(String reason);

  /// 上次检查：$time
  String updateLastChecked(String time);

  /// 下次允许检查：$time
  String updateNextAllowed(String time);

  /// 通道：$channel
  String updateChannelLabel(String channel);

  /// 检查更新失败：$reason
  String updateCheckFailed(String reason);

  /// `status` 的机器判据 → 人话（`timeout` / `http-404` / `bad-shape` …）
  String updateReasonText(String reason);

  /// 托盘菜单：有新版本 v$latest · 查看
  String trayUpdateItem(String latest);

  /// 托盘菜单（强制升级）：有新版本 v$latest · 请升级
  String trayUpdateRequiredItem(String latest);

  /// 托盘悬停：$name · 有新版本 v$latest
  String trayUpdateTooltip(String name, String latest);

  /// 托盘悬停（强制升级）：$name · 需要升级到 v$latest
  String trayUpdateRequiredTooltip(String name, String latest);

  // ── 更新检查：三处共用的那几句（提示条 / 设置页 / 下载页必须同一个 key）──────

  /// 有新版本 v$latest（当前 v$current）——**三处都读这一条**
  String updateNewVersionTitle(String latest, String current);

  /// 低于最低可用版本，请先升级（`required` 的提示条后半句与设置页状态都读它）
  String get updateRequiredNotice;

  /// 站点上没有这条通道的版本（通道不匹配）——`none` 里唯一需要人多看一眼的那一种
  String get updateChannelMismatchText;

  /// 下载
  String get updateDownloadTitle;

  /// 只打开链接，不自动下载、不静默安装。
  String get updateDownloadNote;

  /// GitHub 下载
  String get updateGitHubDownload;

  /// 网盘下载
  String get updateNetdiskDownload;

  /// 即将开放
  String get updateNetdiskSoon;

  /// 百度网盘下载
  String get updateBaiduDownload;

  /// 夸克网盘下载
  String get updateQuarkDownload;

  /// 待上传
  String get updatePendingUpload;

  /// 提取码：$code
  String updateExtractCode(String code);

  /// 复制提取码
  String get updateCopyCode;

  /// 已复制
  String get updateCopied;

  /// 官方发布页
  String get updateReleasePage;

  /// $os $arch · $kind（下载页里那一行平台说明；`kind` 走 [updateKindLabel]）
  String updatePlatformLine(String os, String arch, String kind);

  /// `installer` / `portable` / `update` → 人话；未知值原样返回
  String updateKindLabel(String kind);

  /// 切通道会清掉 12/24 小时的节流并立刻查一次。
  String get updateChannelSwitchNote;

  /// 已切到 $channel 通道并立刻检查
  String updateSwitched(String channel);

  /// 切换通道失败：$reason
  String updateSwitchFailed(String reason);
}

/// 中文（**作者语言**，也是所有既有测试断言的基准）。
///
/// ⚠ 改这里等于改界面：每一条都要与迁移前的字面量**逐字相同**，否则那一页的
/// widget 测试会红（它们断的是屏幕上的中文）。
class ZhStrings extends AppStrings {
  const ZhStrings();

  @override
  AppLanguage get language => AppLanguage.zh;

  @override
  String get retry => '重试';
  @override
  String get cancel => '取消';
  @override
  String get confirm => '确认';
  @override
  String get save => '保存';
  @override
  String get loading => '正在加载…';
  @override
  String get error => '出错了';
  @override
  String get empty => '没有内容';
  @override
  String get collapse => '收起';
  @override
  String expandAll(int chars) => '展开全部（$chars 字）';
  @override
  String loadFailed(String reason) => '加载失败：$reason';
  @override
  String get settingsLoadingConfig => '正在读取配置…';
  @override
  String configReadFailed(String reason) => '配置读取失败：$reason';
  @override
  String requestWaiting(String request, int seconds) => '正在等 $request（已 $seconds 秒）';
  @override
  String requestTimeout(String request, int seconds, bool maybeDone) => maybeDone
      ? '$request 等了 $seconds 秒没有回执。这次动作可能已经生效——先去那一页看看，再决定要不要重试。'
      : '$request 等了 $seconds 秒没有回音。这次没回来，点「重试」再来一次。';
  @override
  String requestStreamStalled(int seconds) =>
      '事件流 $seconds 秒一个字节都没有，按断线处理（正在重连，断线期间的事件会补回来）。';

  @override
  String get navChat => '聊天';
  @override
  String get navSettings => '设置';
  @override
  String get navOverview => '运行情况';
  @override
  String get navChannels => '通道';
  @override
  String get navExtensions => '扩展';
  @override
  String get navPersona => '人格';
  @override
  String get navSchedule => '日程';
  @override
  String get navMemory => '记忆';
  @override
  String get navLogs => '日志';
  @override
  String get navMore => '更多';

  // ── 运行情况 / 重启 / 托盘 ──
  @override
  String get overviewConfigGuide => '配置引导';
  @override
  String restartConfirmed(String evidence) => '重启已确认：$evidence';
  @override
  String restartEvidence(int backendPid, bool portReady) {
    final parts = <String>[
      if (backendPid > 0) '真实新 pid $backendPid',
      if (portReady) '端口已就绪',
    ];
    return parts.isEmpty ? '服务端没给凭据（pid 与端口都没读到）' : parts.join(' · ');
  }

  @override
  String get restartSentWithGui =>
      '重启已发出：界面与后端都会重启——界面会先关掉，请等它自己回来（本机约 1~2 分钟）';
  @override
  String get restartSentBackendOnly =>
      '重启已发出：后端断开后约 20~90 秒回来（界面不在本次动作范围内，它只是重连）';
  @override
  String restartFailed(String reason) => '重启失败：$reason';
  @override
  String restartRefused(String reason) => '重启没能发出：$reason';
  @override
  String get restartNoConclusion => '重启已发出，但服务端没有给出结论';
  @override
  String restartNoReceipt(String reason) =>
      '重启请求已经发出去了，但没等到回执（$reason）。先别急着再点一次：那台机器可能正在重启，'
      '界面会自己重连回来说它好没好。';
  @override
  String get restartBackReady => '已就绪：后端回来了';
  @override
  String restartBackTimeout(int seconds) =>
      '后端还没回来（等了 $seconds 秒）：看一眼 data/restart-trace.log';
  @override
  String get restartNeverWentDown => '后端没有断开过：这次请求可能没生效';

  @override
  String get trayShow => '显示界面';
  @override
  String get trayHide => '收进托盘';
  @override
  String get trayRestart => '重启前后端';
  @override
  String get trayQuitUi => '退出界面（她继续在后台运行）';
  @override
  String get trayQuitAll => '退出全部（界面 + 后端）';
  @override
  String get quitAllConfirmTitle => '退出全部？';
  @override
  String quitAllConfirmBody(bool busy) =>
      '会把后端一起结束（连同它拉起的协议端），然后关掉这个界面。\n'
      '${busy ? '她现在正跑着一轮：这一轮会被打断，下次启动按恢复流程结算。\n' : ''}'
      'Windows 上没有能从外部送达的优雅停机，所以这是硬杀：'
      '协议端的登录态可能要你在 WebUI 里重登一次。\n'
      '只想关界面（她继续在后台跑）请用托盘里的「退出界面」。';
  @override
  String get quitAllConfirmLabel => '退出全部';
  @override
  String get quitAllWorking => '正在结束后端…';
  @override
  String quitAllFailed(String reason) => '后端没停下来：$reason（界面没关，免得你以为已经全退了）';
  @override
  String get quitAllDone => '已退出全部：界面与后端都结束了';

  @override
  String get onboardingManualSaved => '引导走完了，改过的那几步已经写进去';
  @override
  String get onboardingManualNoChanges => '这次只是打开看了看：什么都没改，也没写任何东西';
  @override
  String get onboardingManualOpenBadge => '手动打开 · 不计入首次判据';

  // ── 首次引导（六步卡） ──
  //
  // 第 1、4、5 步的那几段说明在**第 3 轮**（2026-10-20）全部压成**一行**：
  // 一行里说清最关键的因果，但写哪儿、什么时候生效、"别删什么"一句都不许丢。
  // 字数的上界由 `test/onboarding_copy_one_line_test.dart` 钉着，`\n` 也由它拦。
  @override
  String get onboardingStepNameTitle => '她叫什么';
  @override
  String get onboardingStepNameNote =>
      '名字是她的身份，下面那份词表决定群里喊哪些词算在叫她（不打 @ 也算）。';
  @override
  String get onboardingStepNameHint =>
      '写进 persona/IDENTITY.md 的「名字：」那一行（旧版本有快照，人格配置页能回滚），界面上的称呼就是它。';
  @override
  String get onboardingKeywordsHint =>
      '逗号或顿号隔开，正文里出现就算在叫她（同平台的 @）；填了名字会自动跟一份，清空 = 只认 @。';
  @override
  String get onboardingStepApiTitle => 'API 配置';
  @override
  String get onboardingStepApiNote => '她用的是哪家模型。写进 config.json 与 data/.keys.json，进程重启后接管。';
  @override
  String get onboardingStepChannelTitle => '消息适配器';
  @override
  String get onboardingStepChannelNote => '她从哪个通道收消息。QQ 官方 Bot 的 AppID 与 AppSecret 就填在下面。';
  @override
  String get onboardingStepPersonaTitle => '人格';
  @override
  String get onboardingStepPersonaNote => '她是谁。这一段写进 persona/IDENTITY.md，是她的常驻人格。';
  @override
  String get onboardingStepTrustTitle => '信任范围';
  @override
  String get onboardingStepTrustNote => '她能碰到多远：整台电脑，还是只有一个工作目录。二选一，默认完全信任。';
  @override
  String get onboardingApiRecommendLead => '我们推荐您使用 ';
  @override
  String get onboardingApiRecommendModel => 'DeepSeek 的模型';
  @override
  String get onboardingApiRecommendJoin => '，';
  @override
  String get onboardingApiRegisterKey => '点击注册账号并获取 API Key';
  @override
  String get onboardingChannelRecommendLead => '我们推荐您使用 ';
  @override
  String get onboardingChannelRecommendQq => 'QQ 官方 Bot';
  @override
  String get onboardingChannelRecommendTail => ' 作为消息适配器';
  @override
  String get onboardingQqTileDetail => '官方开放平台那条通道：可以扫码创建，也可以直接填 AppID / AppSecret（只写不读）。';
  @override
  String get onboardingQqCredentialsTitle => 'QQ 官方 Bot 凭据（存在本机 data/.keys.json，不进 config.json）';
  @override
  String get onboardingQqAppIdLabel => 'AppID';
  @override
  String get onboardingQqAppIdHint => '开放平台管理端的机器人 ID。';
  @override
  String get onboardingQqAppSecretLabel => 'AppSecret';
  @override
  String get onboardingQqAppSecretHint => '换取 access_token 的密钥。';
  @override
  String onboardingSecretConfigured(String? mask) =>
      mask == null || mask.isEmpty ? '已配置；粘贴新值可覆盖' : '已配置（$mask）；粘贴新值可覆盖';
  @override
  String get onboardingQqCredentialsNote => '填完两个凭据会自动勾上 QQ 官方 Bot；也可以先跳过，之后在「消息适配器」页里补。';
  @override
  String get onboardingQqEntryScan => '扫码创建（推荐）';
  @override
  String get onboardingQqEntryManual => '填写凭据';
  @override
  String get onboardingQqBindIntro => '用手机 QQ 扫码：会自动创建官方 Bot，并把 AppID / AppSecret 写进本机。';
  @override
  String get onboardingQqBindStart => '扫码创建';
  @override
  String get onboardingQqBindStarting => '正在向 QQ 申请二维码…';
  @override
  String get onboardingQqBindWaitScan => '请在浏览器里用手机 QQ 扫码。';
  @override
  String get onboardingQqBindWaiting => '等待扫码…（每 2 秒查一次，可以取消）';
  @override
  String get onboardingQqBindSuccess => '绑定成功';
  @override
  String get onboardingQqBindSavedNote => 'AppID 与 AppSecret 已保存并启用（写入 data/.keys.json；通道配置重启后生效）。';
  @override
  String get onboardingQqBindRegenerate => '二维码过期了，重新生成';
  @override
  String get onboardingQqBindTestConnection => '测试连接';
  @override
  String get onboardingQqBindTokenTesting => '正在测试连接…';
  @override
  String onboardingQqBindAppId(String appId) => 'AppID：$appId';
  @override
  String onboardingQqBindTokenOk(int expiresIn) => '连接测试通过：access_token 已换取（有效期 $expiresIn 秒）。';
  @override
  String onboardingQqBindTokenFailed(String reason) => '连接测试没通过：$reason';
  @override
  String onboardingQqBindStartFailed(String reason) => '扫码创建没发起成功：$reason';
  @override
  String onboardingQqBindStatusFailed(String reason) => '查扫码状态失败：$reason';
  @override
  String get onboardingOnebotDetail => '配置完成后可自行另行设置。';
  @override
  String get onboardingPersonaHint =>
      '写上去 = 替换整份文件（服务端留快照，人格配置页能回滚）；开头「名字：」那行别删，留空或没改动就不写。';
  @override
  String get onboardingTrustNoteSame =>
      '这是边界不是提醒：越界的读写与命令会被拒（fs 与 pwsh 都管），与盘上一致、这屏不写盘；之后在设置页「信任范围」里能改。';
  @override
  String get onboardingTrustNoteChanged =>
      '这是边界不是提醒：越界的读写与命令会被拒（fs 与 pwsh 都管），点「完成」写进 config.json、重启后接管；之后在设置页「信任范围」里能改。';
  @override
  String get onboardingStepDepsTitle => '外部依赖';
  @override
  String get onboardingStepDepsNote =>
      '不装的话有些工具用不了：pwsh 的工具、rg 的 grep、es 的 find、python 那条 lane。';
  @override
  String get onboardingDepsInstallLabel => '下载并安装这些外部依赖';
  @override
  String get onboardingDepsAllReady => '四件依赖都已就位，直接点「完成」即可。';
  @override
  String get onboardingDepsStatusReady => '就位';
  @override
  String get onboardingDepsStatusMissing => '未就位';
  @override
  String get onboardingDepsItemRunning => '进行中…';
  @override
  String get onboardingDepsItemOk => '成功';
  @override
  String onboardingDepsItemFailed(String reason) => '失败：$reason';
  @override
  String onboardingDepsSummary(int ok, int failed) => '成功 $ok / 失败 $failed';
  @override
  String get onboardingDepsRetry => '重试';
  @override
  String onboardingDepsLastRun(int ok, int failed) => '上次装完：成功 $ok / 失败 $failed';
  @override
  String onboardingDepsReadFailed(String reason) => '读不到依赖状态：$reason';
  @override
  String get onboardingDepsUnavailable => '这台服务端没装配依赖管理器，装不了，直接点「完成」即可。';
  @override
  String get onboardingRestartTitle => '需要重启';
  @override
  String get onboardingRestartBody => '依赖装完了，要重启界面才会生效。';
  @override
  String get onboardingRestartNow => '立即重启';
  @override
  String get onboardingRestartLater => '稍后';
  @override
  String onboardingOpenLinkFailed(String url) => '打不开浏览器，地址是 $url';
  @override
  String onboardingChannelSaveFailed(String reason) => '通道开关没写进去：$reason';
  @override
  String onboardingSecretsSaveFailed(String reason) => 'AppID / AppSecret 没写进去：$reason';
  @override
  String onboardingApiKeyWritten(String gates) => '密钥已写入 $gates';
  @override
  String onboardingApiKeyHintWritten(String gates) => '已写入 $gates；粘贴新密钥可覆盖';
  @override
  String onboardingApiKeyHintPartial(String have, String missing) =>
      '只有 $have 有密钥；再填一次会一并写给 $missing';
  @override
  String onboardingApiKeySaveFailed(String gates, String reason) =>
      '$gates 都没写进去（密钥文件是一次原子写，一格都没落）：$reason';
  @override
  String onboardingApiKeyNoSlot(String routes, String envNames) =>
      '$routes 没有自己的密钥格（data/.keys.json 只认 heavy / light）：要用它请设环境变量 $envNames';

  // ── 第 2 步：模型探测 / 协议三档 / 密钥状态（2026-10-26）─────────────

  @override
  String get onboardingModelLabel => '模型名';
  @override
  String get onboardingModelRequired => '模型名不能为空，未保存';
  @override
  String get onboardingBaseUrlLabel => 'Base URL';
  @override
  String get onboardingBaseUrlRequired => 'Base URL 不能为空，未保存';
  @override
  String get onboardingBaseUrlNote => 'API 根地址，不含 /responses。';
  @override
  String get onboardingApiKeyLabel => 'API Key';
  @override
  String get onboardingApiKeyStatusMissing => '未配置';
  @override
  String onboardingApiKeyStatusWritten(String gates) => '已写入 $gates';
  @override
  String onboardingApiKeyStatusPartial(String have) => '只写入 $have';
  @override
  String get onboardingProbeButton => '探测';
  @override
  String get onboardingProbeRunning => '正在探测…';
  @override
  String get onboardingProbeBaseRequired => '先填 Base URL';
  @override
  String onboardingProbeDone({
    required int count,
    required bool responsesOk,
    required int? responsesMs,
    required bool chatOk,
    required int? chatMs,
    String? recommended,
  }) {
    String segment(String name, bool ok, int? ms) =>
        '$name ${ms == null ? '—' : '${ms}ms'} ${ok ? '✓' : '✗'}';
    final tail = recommended == null ? '' : ' · 推荐 $recommended';
    return '探测完成：$count 个模型 · ${segment('Responses', responsesOk, responsesMs)}'
        ' · ${segment('Chat', chatOk, chatMs)}$tail';
  }

  @override
  String get onboardingProbeSearchHint => '搜索模型…';
  @override
  String get onboardingProbeNoMatch => '没有匹配的模型';
  @override
  String get onboardingProbeEmptyList => '这个端点没有返回模型；模型名只能手填。';
  @override
  String onboardingProbeBadge(String protocol, bool supported) => '$protocol ${supported ? '✓' : '✗'}';
  @override
  String get onboardingProbeUnreachable => '探测失败：连不上这个端点（网络不可达或超时）。可以继续手填模型名。';
  @override
  String get onboardingProbeUnauthorized => '探测失败：密钥无效（401/403）。检查 API Key 后重试，或继续手填模型名。';
  @override
  String get onboardingProbeNoModels => '探测失败：该端点没有 /models，只能手填模型名。';
  @override
  String get onboardingProbeNoKey => '探测失败：还没有可用的 API Key。先填上密钥再探测，或继续手填模型名。';
  @override
  String onboardingProbeFailed(String reason) => '探测失败：$reason';
  @override
  String onboardingProbeOnlyProtocol(String protocol) => '该端点只支持 $protocol';
  @override
  String onboardingProbeWarning(String warning) => '注意：$warning';

  @override
  String get chatTitle => '聊天';
  @override
  String get chatSubtitle => '会话、消息来源与人工唤醒';
  @override
  String get composerHint => '输入消息…（/reset 清空上下文、/dream 叫她整理记忆）';
  @override
  String get jumpToLatest => '跳到最新';
  @override
  String get jumpToLatestNew => '有新内容 · 跳到最新';
  @override
  String get earlierFailed => '更早的记录读取失败，向上滚动重试';
  @override
  String get noEarlier => '没有更早的记录了';
  @override
  String get historyErrorTitle => '会话记录读取失败';
  @override
  String get historyErrorMessage => '没能从主进程取到会话记录。';
  @override
  String get chatEmptyTitle => '会话尚未开始';
  @override
  String get chatEmptyMessage => '还没有会话记录。';
  @override
  String get chatEmptyAction => '输入消息';
  @override
  String get chatEmptyHint => '在下方输入框发送内容后，会话与来源显示在此。';
  @override
  String get tagFrameworkNotice => '框架通报';
  @override
  String get tagFrameworkReminder => '框架提醒';
  @override
  String get tagInjection => '注入预警';
  @override
  String get tagContextBoundary => '上下文分界';
  @override
  String get injectionCardTitle => '外部消息里有想指挥她的迹象';
  @override
  String get unnamedSender => '未命名会话';
  @override
  String receivedFrom(String sender, String id) => '已接收：$sender（$id）';
  @override
  String get dash => '—';
  @override
  String mentionsYou(String where) => '$where 里有人提到了你';
  @override
  String talkingAbout(String what) => '那边在聊：$what';
  @override
  String get directMessage => '单聊消息';
  @override
  String get groupMention => '群聊提及';
  @override
  String get groupMessage => '群聊消息';
  @override
  String get chatTypeDirect => '单聊';
  @override
  String get chatTypeGroup => '群聊';
  @override
  String get qqOfficialBot => 'QQ 官方 Bot';
  @override
  String get externalChannel => '外部通道';
  @override
  String get qqMessage => 'QQ 消息';
  @override
  String get oneBotMessage => 'OneBot 消息';
  @override
  String get externalMessage => '外部消息';
  @override
  String get byModel => '模型判定';
  @override
  String get byRule => '规则命中';
  @override
  String fromWho(String who) => '来自 $who';
  @override
  String get manualWake => '手动唤醒';
  @override
  String get intentWake => '意图唤醒';
  @override
  String get schedulerFire => '定时任务触发';
  @override
  String scheduledAt(String at) => '原定 $at';
  @override
  String get backgroundProgress => '后台任务进展';
  @override
  String get eventDream => '做梦';
  @override
  String get eventMcpDeclChanged => 'MCP 声明变更';
  @override
  String get contextClearedHere => '上下文在此处清空';
  @override
  String get contextCompactedHere => '上下文在此处压缩';
  @override
  String get contextClearedHereDetail => '到此为止的往来不再计入她的上下文';
  @override
  String get contextCompactedHereDetail => '到此为止的往来被交接笔记替代，不再逐条计入';
  @override
  String get humanReplyRecorded => '人工答复已记录';
  @override
  String get markedOk => '已标记成功';
  @override
  String get markedFailed => '已标记失败';
  @override
  String get toolRunning => '运行中';
  @override
  String get toolExecuting => '正在执行…';
  @override
  String get toolDone => '完成';
  @override
  String get toolError => '出错';
  @override
  String get toolTimeout => '超时（结果未知）';
  @override
  String get toolDenied => '被策略拒绝';
  @override
  String get toolUnknown => '结局未知';
  @override
  String get toolNotDispatched => '未派发';
  @override
  String get toolOverStepCap => '超出单步上限';
  @override
  String get thinkingLabel => '思考中';
  @override
  String thinkingStep(String step) => '第 $step 步';
  @override
  String thinkingChars(String chars) => '已想 $chars 字';
  @override
  String thinkingElapsed(String elapsed) => '用时 $elapsed';
  @override
  String get thinkingGap => '　';
  @override
  String compactChars(int chars) {
    if (chars < 10000) return '$chars';
    final wan = chars / 10000;
    // `100.0 万字` 这种写法很别扭：到 100 万就只留整数位（原 formatThinkingChars 的口径）
    if (wan >= 100) return '${wan.round()} 万字';
    return '${wan.toStringAsFixed(1)} 万字';
  }
  @override
  String get toastContextCleared => '上下文已清空，后面的对话从零开始';
  @override
  String toastClearFailed(String reason) => '清空失败：$reason';
  @override
  String get toastDream => '叫她去做梦了——整理完会写进记忆，日志页能看到';
  @override
  String toastTriggerFailed(String reason) => '触发失败：$reason';
  @override
  String get toastDuplicateSend => '这句和刚发过的完全一样，被当成同一条忽略了——过几秒再发一次就行';
  @override
  String toastSendFailed(String reason) => '发送失败：$reason';

  @override
  String get settingsTitle => '设置';
  @override
  String get settingsSubtitle => '运行情况、通道、人格与本地参数';
  @override
  String get settingsSectionUi => '界面';
  @override
  String get settingsUiNote => '主题偏好与关窗行为；仅本地生效，不写入配置。';
  @override
  String get instantApply => '即时生效';
  @override
  String get settingsThemeMode => '明暗模式';
  @override
  String get themeLight => '亮';
  @override
  String get themeDark => '暗';
  @override
  String get settingsCurrentTheme => '当前主题';
  @override
  String get settingsThemeNote => '仅本地偏好，即时生效；不写入配置、不影响渲染指纹。';
  @override
  String get settingsCloseToTray => '关窗时收进托盘（不退出界面）';
  @override
  String get settingsCloseToTrayNote =>
      '托盘图标若被系统收进"隐藏的图标"面板，关窗后会找不到界面；关掉此项则点 × 直接退出（她照常运行）。';
  @override
  String get settingsLanguage => '语言';
  @override
  String get languageFollowSystem => '跟随系统';
  @override
  String get settingsLanguageNote => '界面文字的语言，即时生效；不写入配置、不影响她的说话方式。';

  @override
  String get settingsStringsOverride => '文案覆盖';
  @override
  String get settingsStringsOverrideNote =>
      '改上面那个文件就能改界面上的字：没写的仍用默认文案；带参数的句子（如「加载失败：…」）暂时不参与覆盖。'
      '点「重新载入文案」立刻生效，不用重启界面。';
  @override
  String get stringsOverridePathLabel => '覆盖文件';
  @override
  String get stringsOverrideOpen => '打开文案文件';
  @override
  String get stringsOverrideReload => '重新载入文案';
  @override
  String get stringsOverrideExport => '导出当前文案为模板';
  @override
  String get stringsOverrideNone => '未使用覆盖（默认文案）';
  @override
  String stringsOverrideLoaded(int zh, int en) => '已加载 ${zh + en} 条覆盖（zh $zh / en $en）';
  @override
  String stringsOverrideFailed(String reason) => '解析失败：$reason';
  @override
  String stringsOverrideUnreadable(String detail) => '读不出来（$detail）';
  @override
  String stringsOverrideBadJson(String detail) => 'JSON 格式不对（$detail）';
  @override
  String get stringsOverrideBadRoot =>
      '顶层不是 JSON 对象（应为 {"zh": {…}, "en": {…}} 或 {"键": "文案"}）';
  @override
  String stringsOverrideIgnored(int count) => '有 $count 条键没被采用（不认识的键或值不是字符串，详情见启动日志）';
  @override
  String stringsOverrideExported(String path) => '模板已写到：$path';
  @override
  String stringsOverrideExportFailed(String reason) => '模板写不出去：$reason';
  @override
  String stringsOverrideOpenFailed(String path) => '打不开：$path';

  @override
  String get settingsAnchorCaption => '分区';
  @override
  String get settingsNavModel => '模型';
  @override
  String get settingsNavUi => '界面';
  @override
  String get settingsNavSpeak => '发言';
  @override
  String get settingsNavDeps => '外部依赖';
  @override
  String get settingsNavProtocol => '协议端';
  @override
  String get settingsNavWebhook => '外部回调';

  @override
  String get settingsNavMemory => '记忆';
  @override
  String get settingsNavTrust => '信任范围';

  @override
  String get settingsNavSystem => '系统';
  @override
  String get settingsNavAccount => '账号与安全';

  @override
  String get settingsNavAbout => '关于';
  // ── 运行情况页 ──
  @override
  String get overviewSubtitle => '当前状态、用量与待确认项';
  @override
  String get overviewSectionAdvice => '建议';
  @override
  String get overviewSectionRecent => '最近事件';
  @override
  String get overviewPersonaSeedAdvice => '人格资产未初始化：IDENTITY.md 仍为模板，先补全身份与语气。';
  @override
  String get overviewNoPendingCalls => '现在没有待确认的调用';
  @override
  String get overviewTimerCancelTitle => '撤销这个定时器？';
  @override
  String get overviewTimerCancel => '撤销';
  @override
  String get overviewDeadDiscardTitle => '丢弃这条死信？';
  @override
  String get overviewDeadDiscardConfirm => '确认丢弃';
  @override
  String get overviewDeadRequeue => '重投';
  @override
  String get overviewDeadDiscard => '丢弃';
  @override
  String get overviewLoadFailedTitle => '无法获取运行数据';
  @override
  String get overviewMarkSucceeded => '标记成功';
  @override
  String get overviewMarkFailed => '标记失败';
  @override
  String get overviewTodayUsage => '今日用量';
  @override
  String get overviewCacheHitRate => '缓存命中率';
  @override
  String get overviewPending => '待确认';
  @override
  String get overviewFailStreak => '连续失败';
  @override
  String get overviewActFallback => '去处理';
  @override
  String get overviewDeadLettersUnread => '没读到死信明细，刷新一次再看看。';
  @override
  String get overviewUnknownSession => '未知会话';
  @override
  String get overviewChatTypeDirect => '单聊';
  @override
  String get overviewChatTypeGroupAt => '群聊@';
  @override
  String get overviewChatTypeGroup => '群聊';
  @override
  String get overviewChatTypeGuild => '频道';
  @override
  String get overviewChatTypeUnknown => '类型未知';
  @override
  String get overviewExternalSessions => '外部会话';
  @override
  String get overviewExternalSessionsNote => '经由消息适配器添加的会话。平台推给我们的消息存入信箱，由 Agent 自行查看。';
  @override
  String get overviewExternalSessionsLoading => '正在读外部会话…';
  @override
  String get overviewExternalSessionsErrorHint => '状态与用量不受影响；读到数据后这张卡会自己出现。';
  @override
  String get overviewNoAccumulatedMessages => '没有积累的消息（信箱里是空的；群里没 @ 她的消息，要官方 Bot 先推给我们才进得来）。';
  @override
  String get overviewLevelCritical => '严重';
  @override
  String get overviewLevelWarn => '警告';
  @override
  String get overviewLevelInfo => '提示';
  @override
  String get overviewLevelUnknown => '未知等级';
  @override
  String get overviewFrameworkNote => '框架提示';
  @override
  String get overviewFrameworkNotesLoading => '正在读框架提示…';
  @override
  String get overviewFrameworkNotesErrorHint => '运行不受影响；注入预警与告警仍照常记录在事件日志里。';
  @override
  String get overviewNoFrameworkNotes => '没有需要你知道的事。';
  @override
  String get overviewTimers => '定时器';
  @override
  String get overviewTimersNote => '她自己布防的唤醒（timer 工具的 action=set）。到点会把她叫起来，撤销只对还没触发的那些有效。';
  @override
  String get overviewNoTimers => '眼下没有排着的定时器。';
  @override
  String get overviewTimersErrorHint => '可能是它已经触发或已经被撤掉了；刷新一次看最新清单。';
  @override
  String get overviewTimerUnknownTime => '时刻未知';
  @override
  String get overviewTimerRecurring => '周期';
  @override
  String get overviewRecentEmpty => '还没有事件记录。';
  @override
  String get overviewRecentEmptyAction => '立即唤醒';
  @override
  String get overviewRecentEmptyHint => '唤醒或外部消息写入后，这里列出最近发生的事。';
  @override
  String get overviewJudgedByRule => '规则判定';
  @override
  String get overviewJudgedByModel => '模型判定';
  @override
  String get overviewSessionsNotList => '返回的数据不是会话清单';
  @override
  String get overviewNotesNotList => '返回的数据不是提示清单';
  @override
  String get overviewContextTitle => '当前上下文构成';
  @override
  String get overviewContextLoading => '正在读上下文构成…';
  @override
  String get overviewContextErrorHint => '状态与用量不受影响；读到数据后这块会自己出现。';
  @override
  String get overviewContextEmpty => '还没有请求过 —— 她下一次开口后这里会有数';
  @override
  String get overviewContextNotObject => '返回的数据不是上下文构成';
  @override
  String get overviewContextKeepOn => '开';
  @override
  String get overviewContextKeepOff => '关';
  @override
  String overviewAdviceLine(String title, String body) => '$title：$body';
  @override
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp) =>
      'seq $seq · 认领 $claimCount 次${stamp == null ? '' : ' · $stamp'}';
  @override
  String overviewPendingCount(int count) => '待确认 $count 项';
  @override
  String overviewTodayUsageTooltip(String exact) => '今日用量 $exact';
  @override
  String overviewTimerCancelBody(String timerId) =>
      '定时器 $timerId 会被取消：它到点不会再把她叫起来。\n'
      '这次撤销写进日志（timer/cancelled），撤错了只能让她重新排一个。';
  @override
  String overviewTimerCancelled(String timerId) => '已撤销定时器 $timerId：到点不会再醒';
  @override
  String overviewTimerCancelFailed(String timerId, String reason) => '撤销 $timerId 失败：$reason';
  @override
  String overviewTimerCancelToastFailed(String reason) => '撤销失败：$reason';
  @override
  String overviewMarkFailedToast(String reason) => '标记失败：$reason';
  @override
  String overviewDeadRequeued(int seq) => '已重投 seq $seq：它回到队列，下一拍重新认领';
  @override
  String overviewDeadDiscardBody(int inputSeq) =>
      'seq $inputSeq 不会被重投，也不会被执行——它就此退出待处理。\n'
      '这次决定会写进日志：那条输入本身仍留在事件日志里，日后可以查。';
  @override
  String overviewDeadDiscarded(int seq) => '已丢弃 seq $seq：它不会再被执行，日志里仍留着那条输入';
  @override
  String overviewDeadActionFailed(String verb, int seq, String reason) => '$verb seq $seq 失败：$reason';
  @override
  String overviewDeadActionToastFailed(String verb, String reason) => '$verb失败：$reason';
  @override
  String overviewHistoricalBadge(String label) =>
      label.isEmpty ? '已恢复 · 历史' : '$label · 已恢复 · 历史';
  @override
  String overviewSourceFramework(String? fingerprint) =>
      fingerprint == null ? '来源：框架自身' : '来源：框架自身 · $fingerprint';
  @override
  String overviewSourceChat(String who) => '来源：$who';
  @override
  String overviewQuote(String text) => '「$text」';
  @override
  String overviewGroupsCount(int count) => '$count 个群聊';
  @override
  String overviewSinglesCount(int count) => '$count 个单聊';
  @override
  String overviewOthersCount(int count) => '$count 个其它';
  @override
  String overviewUnreadTotal(int count) => '合计 $count 条未读';
  @override
  String overviewMessagesSeen(int count) => '来过 $count 条';
  @override
  String overviewUnreadBadge(int count) => '未读 $count';
  @override
  String overviewTimersWaiting(int count) => '$count 个在等';
  @override
  String overviewTimerCron(String cron) => '周期 $cron';
  @override
  String overviewTimerPayload(String payload) => '唤醒内容：$payload';
  @override
  String overviewExternalSessionsError(String reason) => '外部会话读取失败：$reason';
  @override
  String overviewFrameworkNotesError(String reason) => '框架提示读取失败：$reason';
  @override
  String overviewContextTokens(String used, String budget) => '$used / $budget tok';
  @override
  String overviewContextSubline(int percent, String keep, String stamp) =>
      '占预算 $percent% · 保留历史思维链：$keep · 取自 $stamp 那一拍';
  @override
  String overviewContextShare(int share) => '$share%';
  @override
  String overviewContextLegendNumbers(String tokens, int share) => '$tokens · $share%';
  @override
  String overviewContextError(String reason) => '上下文构成读取失败：$reason';
  @override
  String get settingsLaneHeavyLabel => '主循环（heavy）';
  @override
  String get settingsLaneLightLabel => '轻量（light）';
  @override
  String get settingsLaneHeavyNote => 'turn 主循环使用的模型';
  @override
  String get settingsLaneLightNote => '必要性判断、压缩摘要与守卫分类使用的模型';
  @override
  String get settingsDepSourceManaged => '框架托管';
  @override
  String get settingsDepSourceSystemPath => '系统 PATH';
  @override
  String get settingsDepVersionUnknown => '版本未知';
  @override
  String get settingsDepPathUnknown => '路径未知';
  @override
  String get settingsSysHostEmptyError => '监听地址不能为空：空值等于监听所有网卡，未保存';
  @override
  String settingsSysEmptyError(String label) => '$label不能为空，未保存';
  @override
  String settingsSysIntRequired(String label) => '$label要填整数，未保存';
  @override
  String settingsSysPortRange(String label) => '$label要在 1~65535 之间，未保存';
  @override
  String settingsSysMinOne(String label) => '$label最小是 1，未保存';
  @override
  String settingsSysRatioRequired(String label) => '$label要填小数（0.8 表示 80%），未保存';
  @override
  String settingsSysRatioRange(String label) => '$label是比例，要落在 0~1 之间（不含 0），未保存';
  @override
  String settingsSysMin(String label, int lo) => '$label最小是 $lo，未保存';
  @override
  String settingsSysMax(String label, int hi) => '$label最大是 $hi，未保存';
  @override
  String get settingsSysHostLabel => '监听地址';
  @override
  String get settingsSysHostNote => '本机用就填 127.0.0.1；端口 1~65535。留空等于监听所有网卡，会被拦下。';
  @override
  String get settingsSysPortLabel => '端口';
  @override
  String get settingsSysTimezoneLabel => '时区';
  @override
  String get settingsSysTimezoneNote => 'IANA 名称，例如 Asia/Shanghai。预算的「今日」按它切分。';
  @override
  String get settingsSysStepToolsLabel => '预算 · 步内工具调用上限';
  @override
  String get settingsSysStepToolsNote => '单个 step 里最多调几次工具。';
  @override
  String get settingsSysTurnStepsLabel => '预算 · 单 turn 步数上限';
  @override
  String get settingsSysTurnStepsNote => '一个 turn 最多走多少步。';
  @override
  String get settingsSysTaskTokensLabel => '预算 · 任务 token 上限';
  @override
  String get settingsSysTaskTokensNote => '单个任务累计上限；填原值，20M 这类简写不接受。口径是非缓存 token（真花钱的那部分），不是账单上的用量。';
  @override
  String get settingsSysDailyTokensLabel => '预算 · 每日 token 上限';
  @override
  String get settingsSysDailyTokensNote => '每日累计上限，按上面的时区切分。口径同上一行：只数没命中缓存的那部分。';
  @override
  String get settingsSysSoftRatioLabel => '预算 · 软阈值';
  @override
  String get settingsSysSoftRatioNote => '0~1 的小数：0.8 就是 80%。到这一线先提示收尾，越过才硬停。';
  @override
  String get settingsSysFailStreakLabel => '预算 · 连续失败上限';
  @override
  String get settingsSysFailStreakNote => '连续失败这么多次就告警并进入暂停。';
  @override
  String get settingsSysHeartbeatLabel => '心跳间隔 · 平均（分钟）';
  @override
  String get settingsSysHeartbeatNote => '她平均多久自己醒一次——越大越省 token，越小越常醒。两端仍由上下限兜住：不因这个数改变，安静不足下限不会醒、到了上限必然会醒。';
  @override
  String get settingsSysCompactionLabel => '上下文 · 压缩线（token 估算）';
  @override
  String get settingsSysCompactionNote =>
      '可见历史攒到这么多 token（估算）就折成一篇交接笔记，压缩只遮蔽、不删除。'
      '单位是估算器读数，不是供方计数（估算比供方偏低约 1.65~1.66 倍）。'
      '填原值：200000 这类写法不接受；调小 = 压得更勤，而每次压缩自己也要花一次调用。'
      '改完立刻生效，不用重启。';
  @override
  String get settingsTrustConsequenceWorkspaceUnknown => '她只能在配置里的工作目录（trust.workspaceRoot）中活动；越界的读写与命令会被拒绝。';
  @override
  String settingsTrustConsequenceWorkspace(String root) => '她只能在 $root 里活动；越界的读写与命令会被拒绝。';
  @override
  String get settingsTrustConsequenceFull => '她能读写整台电脑上的文件、也能在任意目录跑命令。';
  @override
  String get settingsTrustLabelWorkspace => '只限工作目录';
  @override
  String get settingsTrustLabelFull => '完全信任';
  @override
  String get settingsWebhookStateNotObject => '凭据状态读取失败（响应不是对象）';
  @override
  String get settingsProtocolStateNotObject => '协议端状态读取失败（响应不是对象）';
  @override
  String get settingsDepsReadFailed => '依赖报告读取失败';
  @override
  String get settingsKeysReadFailed => '密钥状态读取失败';
  @override
  String get settingsProjectionReadFailed => '运行数据读取失败';
  @override
  String get settingsModelNameRequired => '模型名不能为空，未保存';
  @override
  String get settingsBaseUrlRequired => 'Base URL 不能为空，未保存';
  @override
  String get settingsNoChanges => '没有需要保存的改动';
  @override
  String get settingsWrittenModelSettings => '模型设置';
  @override
  String get settingsWrittenKey => '密钥';
  @override
  String get settingsRestartSuffix => '，进程重启后生效';
  @override
  String settingsSaveFailed(String err) => '保存失败：$err';
  @override
  String get settingsClearKeyBody => '清除后需重新填写；同一个环境变量下的几格会一起清空（同名的只能同值）；来自环境变量的值不受影响。';
  @override
  String get settingsClear => '清除';
  @override
  String get settingsKeyCleared => '已清除本地密钥';
  @override
  String settingsClearFailed(String err) => '清除失败：$err';
  @override
  String get settingsConfigErrorHint => '模型密钥与系统信息需要生效配置才能显示。请确认主进程已启动。';
  @override
  String get settingsConfigUnavailable => '配置不可用。';
  @override
  String get settingsConfigUnavailableHint => '本地服务 /api/config 未返回配置内容。';
  @override
  String settingsKeysReadFailedHint(String keysError) => '密钥状态读取失败（$keysError）。密钥徽章不可用，模型名与 Base URL 仍可保存。';
  @override
  String get settingsConfigFallbackNote => '读不到 config.json，这一页显示的是当前生效的那份（保存仍会写进文件）。';
  @override
  String get settingsModelRestartNote => '上面有改动还没生效：模型名、端点与协议是启动参数，要重启进程才接管——在那之前跑的还是启动时那份。保存本身是成功的，框里显示的就是盘上那份。';
  @override
  String settingsModelRunningNow(String lane, String model, String baseUrl) =>
      '现在跑的是 $lane=$model @ $baseUrl';
  @override
  String get settingsKeysNote => '密钥只写不读：本页显示的始终是掩码，完整值仅在建立连接时读取一次。保存写入 config.json 与 data/.keys.json，进程重启后接管（环境变量优先于文件）。';
  @override
  String get settingsKeyConfiguredHint => '已配置；粘贴新密钥可覆盖';
  @override
  String get settingsKeySampleHint => 'sk-…';
  @override
  String get settingsModelName => '模型名';
  @override
  String get settingsBaseUrlNote => 'API 根地址，不含 /responses。';
  @override
  String get settingsModelProtocol => '协议';
  @override
  String get settingsModelProtocolAuto => '先按 Responses；探测到不支持才切（推荐）';
  @override
  String get settingsModelProtocolChat => '强制走 Chat（没有"必须回传思维链"的要求 ⇒ 更不容易 400，但思维链展示更少）';
  @override
  String get settingsModelProtocolResponses => '强制走 Responses（对方不支持时会直接失败，不自动切）';
  @override
  String settingsKeyEnvNote(String envName) => '环境变量 $envName 优先；它没有值时使用此处的值（写入 data/.keys.json，只写不读）。';
  @override
  String get settingsClearKey => '清除密钥';
  @override
  String get settingsReading => '读取中…';
  @override
  String get settingsStateReadFailed => '状态读取失败';
  @override
  String get settingsNotConfigured => '未配置';
  @override
  String get settingsSpeakNote => '她说话时的节奏：一条条往外蹦、每条之间隔多久。只影响投递手感，不影响说话内容。';
  @override
  String get settingsSpeakTyping => '打字节奏';
  @override
  String get settingsSpeakTypingNote => '开着：按“这段话要打多久”逐条发出，像人在打字（对方也随时能插话打断）。关掉：一次发完，内容尽快到手。';
  @override
  String get settingsSpeakSpeed => '打字速度';
  @override
  String get settingsSpeakSpeedUnit => '字/分钟';
  @override
  String get settingsSpeakSpeedNote => '默认 90（中文手机输入的常见速度）。调大说得更快、等待更短；范围 30~600。';
  @override
  String get settingsCurrentlyActive => '当前生效';
  @override
  String settingsSpeakTypingOn(String saved) => '$saved 字/分钟 · 逐条发';
  @override
  String settingsSpeakTypingOff(String saved) => '$saved 字/分钟 · 一次发完';
  @override
  String get settingsSpeakTypingEnabled => '已开启打字节奏（重启后接管）';
  @override
  String get settingsSpeakTypingDisabled => '已关闭打字节奏（重启后接管）';
  @override
  String get settingsSpeakSpeedRange => '打字速度要在 30~600 之间';
  @override
  String get settingsSavedRestartNote => '已保存（重启后接管）';
  @override
  String get settingsSavedLive => '已保存，立刻生效（不用重启）';
  @override
  String get settingsSavedRestart => '已保存，重启后生效';
  @override
  String get settingsDepsAllReady => '全部就绪';
  @override
  String get settingsDepsNote => '建议安装的外部依赖，可由框架一键安装。';
  @override
  String settingsDepsReadFailedHint(String depsError) => '依赖报告读取失败（$depsError）。装不了也看不见状态时，先在命令行确认主进程已启动。';
  @override
  String get settingsDepsProbing => '正在探测本机的 pwsh / ripgrep / es.exe / python …';
  @override
  String get settingsDepsInstallLocation => '安装位置：<数据目录>/tools/<名字>/。装完立即生效——探测结论会在安装后复检并刷新，下一次工具调用用的就是新引擎。';
  @override
  String get settingsDepReadyManaged => '已就绪·托管';
  @override
  String get settingsDepReadySystem => '已就绪·系统';
  @override
  String get settingsDepMismatch => '版本不符';
  @override
  String get settingsDepMissing => '未安装';
  @override
  String get settingsDepNoAction => '无需操作';
  @override
  String get settingsDepInstalling => '安装中…';
  @override
  String get settingsInstall => '安装';
  @override
  String get settingsDownloadPage => '下载页';
  @override
  String get settingsOpenDownloadPage => '打开下载页';
  @override
  String get settingsDownloadAndInstall => '下载并安装';
  @override
  String settingsInstallRequestFailed(String err) => '安装请求失败：$err';
  @override
  String get settingsStepDownloadFailed => '下载失败';
  @override
  String get settingsStepExtractFailed => '解压失败';
  @override
  String get settingsStepVerifyFailed => '装完复检没通过';
  @override
  String get settingsStepInstallFailed => '安装失败';
  @override
  String settingsOpenedUrl(String url) => '已用默认程序打开 $url';
  @override
  String get settingsUnknown => '未知';
  @override
  String get settingsRestartRequired => '需重启';
  @override
  String get settingsProtocolTitle => '协议端（可选）';
  @override
  String get settingsProtocolNote => '可选：由框架拉起的 OneBot 协议端，背后是一个真实 QQ 号。它与官方 Bot 各是一条独立的入站通道，装不装都不影响另一条。';
  @override
  String settingsProtocolError(String protocolError) => '协议端状态读取失败：$protocolError';
  @override
  String get settingsProtocolErrorHint => '这张卡读不到不影响其它设置。先确认主进程已启动，再点重试；在读到状态之前，这里不提供开关、目录与一键安装——那等于让你在看不到当前值的情况下写它。';
  @override
  String get settingsProtocolLoading => '正在读取协议端状态…';
  @override
  String get settingsProtocolEmpty => '还没配置内置协议端。';
  @override
  String get settingsProtocolEmptyHint => '不开也照常用：官方 Bot 那条通道不受影响。要用这条路，点下面的「一键安装」把装与配一次做完。';
  @override
  String get settingsProtocolEnabled => '启用内置协议端';
  @override
  String get settingsProtocolEnabledNote => '框架启动时自动连接；关闭后可在双端手动填写和配置。';
  @override
  String get settingsInstallDir => '安装目录';
  @override
  String get settingsInstallDirHint => '<协议端安装目录>';
  @override
  String get settingsSaveDir => '保存目录';
  @override
  String get settingsInstallDirNote => '协议端安装目录（绝对路径）。Lite 包解压后入口 index.mjs 就在这一层，没有 dist/ 子目录；「一键安装」会自动填好。';
  @override
  String get settingsOneClickInstall => '一键安装';
  @override
  String get settingsOneClickInstallNote => '从 SnowLuma 官方 Release 下载 Lite 包；自动下载失败时，自行下载并填写安装目录。此包不随框架分发，不得用于商业使用。';
  @override
  String get settingsOneClickPrerequisite => '使用前提：本机已登录 QQ 客户端（Bot 账号）。';
  @override
  String get settingsInstallRunningNote =>
      '正在从官方 Releases 下载并解压。要下 4.6 MB，视网速可能要一两分钟——先别急，也别再点一次。'
      '分步记录（下到哪一步、下多大）会在这一步结束时一次性列出来：'
      '这条端点是同步请求，不是流，中间插不进进度行。';
  @override
  String settingsInstallManualRoute(String protocolDownloadUrl) => '手动出路：从 $protocolDownloadUrl 下载发行包，解压后把那个目录填到下面的「安装目录」，再点「保存目录」、打开开关——效果与一键安装一样，只是这几步由你做。';
  @override
  String get settingsInstallLogEmpty => '过程记录：（这次没有——失败发生在动手之前）';
  @override
  String get settingsInstallLog => '过程记录：';
  @override
  String get settingsInstalledNextTitle => '已经装好了。下一步：先重启服务，再扫码。';
  @override
  String get settingsInstalledNextBody =>
      '① 重启服务：运行中的协议端实例是按启动时的配置建的，重启之后它才会按刚写好的配置被拉起'
      '（框架不替你重启——重启自己失败就什么都不剩了）。\n'
      '② 再扫码：重启后这张卡上会出现「打开面板」，点开在那边先读并同意用户协议与隐私政策'
      '（那是法律性质的同意，要你自己按），再接入 QQ 并扫码；'
      '首次登录要用它启动时打印的初始凭据——那句话现在就显示在按钮下面（口令打码），'
      '旁边有「复制凭据」。扫码接的是你本机的 QQ 客户端，框架不代管登录态。';
  @override
  String get settingsInstallDirEmpty => '（还没填安装目录）';
  @override
  String get settingsEntryFound => '已找到可执行入口';
  @override
  String get settingsEntryMissing => '目录里没有可执行入口';
  @override
  String get settingsEntryPendingRestart => '入口要重启后才核对';
  @override
  String settingsEndpointPoint(String wsUrl) => '对接点：$wsUrl';
  @override
  String get settingsStart => '启动';
  @override
  String get settingsStop => '停止';
  @override
  String get settingsOpenPanel => '打开面板';
  @override
  String get settingsProtocolNotAttachedNote => '本次进程启动时还没读到这段配置：框架现在不持有它的实例，「启动/停止」要等重启进程之后才有效。';
  @override
  String get settingsChainProcess => '① 进程';
  @override
  String get settingsChainUnobserved => '未观测';
  @override
  String get settingsChainNoInstance => '本进程没有实例，这一档没人在看';
  @override
  String get settingsChainNotRunning => '没在跑';
  @override
  String get settingsChainNoPort => '没有监听到它的面板端口';
  @override
  String get settingsChainSpawned => '本次进程拉起';
  @override
  String get settingsChainDiscovered => '本次进程之前就在跑';
  @override
  String get settingsChainPortOnly => '只探到端口';
  @override
  String get settingsChainRunning => '在跑';
  @override
  String settingsChainListening(String url) => '监听 $url';
  @override
  String get settingsChainOneBotConfig => '② OneBot 配置';
  @override
  String get settingsChainWithToken => '带 token';
  @override
  String get settingsChainNoToken => '无 token（协议端未开校验）';
  @override
  String get settingsChainPresent => '在';
  @override
  String settingsChainEndpoint(String ws) => '端点 $ws';
  @override
  String get settingsChainUnreadable => '读不出';
  @override
  String get settingsChainMissing => '缺失';
  @override
  String get settingsChainMissingDetail => '未登录 QQ：这一份是登录之后才生成的';
  @override
  String get settingsChainAdapter => '③ 适配器';
  @override
  String get settingsChainConnected => '已连上';
  @override
  String settingsChainDelivered(String delivered) => '已收 $delivered 条';
  @override
  String get settingsChainReconnecting => '重连中';
  @override
  String settingsChainBackoff(String attempts) => '第 $attempts 次退避';
  @override
  String get settingsChainNoEndpoint => '没端点可连';
  @override
  String get settingsChainNoEndpointDetail => '协议端的 OneBot 配置还没出现，配置里也没有手填地址';
  @override
  String get settingsChainDisabled => '未启用';
  @override
  String get settingsChainNotAssembled => '未装配';
  @override
  String get settingsChainNotAssembledDetail => '本进程没有 OneBot 适配器';
  @override
  String get settingsChainNoData => '这一档没有数据';
  @override
  String settingsCredentialCaptured(String user, String masked) => '初始凭据（本次启动从它的输出里捕到，用户 $user / 口令 $masked）';
  @override
  String settingsCredentialFromLog(String user, String masked) => '初始凭据（从框架自己的启动留痕里捞回来的：用户 $user / 口令 $masked；若它之后又重启过，这条就作废了）';
  @override
  String get settingsCredentialLost => '初始凭据找不回来：它只在启动时往自己的输出里打一次（关掉程序就没了）。要拿到一条可用的，就让框架重启它一次（那一次的输出会被捕获并显示在这里）。';
  @override
  String get settingsConsentPending => '协议与隐私政策还没同意——面板解锁之前，接入 QQ 的入口是锁着的。';
  @override
  String get settingsPasswordUnchanged => '初始口令还没改：两个门里第一个就是改密，面板会一直要求你先改它。';
  @override
  String settingsQrLoginAt(String webuiUrl) => '扫码登录在 $webuiUrl 里做（框架不代管 QQ 登录态）。';
  @override
  String get settingsCredentialCopied => '凭据已复制（用户 + 口令）';
  @override
  String get settingsCopyCredential => '复制凭据';
  @override
  String settingsManualDownloadGuide(String protocolDownloadUrl) =>
      '也可以自己来：从 $protocolDownloadUrl 下载发行包解压，把那个目录填在上面。'
      '这条路在一键安装失败、或者你想自己控制版本时用；框架也从同一个地址代下载，不随框架分发它'
      '（许可是"源码可见非商业"，自用没问题）。';
  @override
  String get settingsProtocolThirdPartyTitle => '第三方组件：SnowLuma';
  @override
  String get settingsProtocolThirdPartyNote =>
      'SnowLuma 是独立第三方项目，由 SnowLumaDevs 开发与维护：本项目只是代为从官方 Releases 下载、'
      '解压并托管它的进程，不修改它的任何文件。'
      '使用须遵守其 EULA 与 LICENSE，且仅限非商业用途。';
  @override
  String get settingsProtocolOfficialProject => '官方项目';
  @override
  String get settingsProtocolOfficialSite => '官方站点';
  @override
  String get settingsProtocolLicenseRow => '许可（EULA / LICENSE）';
  @override
  String get settingsProtocolRestartNote => '改动已写入 config.json，但要重启进程才接管：运行中的协议端实例是按启动时那份配置建的。重启之前，这里显示的状态仍是本次启动的那一个。';
  @override
  String get settingsInstallDirRequired => '安装目录不能为空';
  @override
  String get settingsStartRequested => '已请求启动';
  @override
  String get settingsStopRequested => '已请求停止';
  @override
  String settingsInstallRequestFailedHint(String err) => '安装请求失败：$err（请求没走到安装那一步，先确认主进程在跑）';
  @override
  String get settingsOneClickFailed => '一键安装失败：原因见卡片';
  @override
  String get settingsInstallNoReason => '安装失败，服务端没有给出原因（回执里没有 detail）';
  @override
  String get settingsInstalledOk => '已装好';
  @override
  String get settingsInstalledConfigured => '已装好并用它配好了；重启一下就能用';
  @override
  String get settingsInstalledNotConfigured => '已装好，但自动配置没写成：见卡片里的说明';
  @override
  String get settingsRestartSuffixParen => '（重启进程后接管）';
  @override
  String get settingsGenerated => '已生成';
  @override
  String get settingsNotGenerated => '还没有生成';
  @override
  String get settingsWebhookNote => '外部系统往这台实例投递用的专用凭据（POST /webhook/*）。';
  @override
  String settingsWebhookErrorHint(String webhookError) => '凭据状态读取失败（$webhookError）。状态看不见时先别按"重新生成"：轮换不可逆（旧的那份当场失效），而此刻你并不知道有没有人在用它。';
  @override
  String get settingsWebhookLoading => '正在读取 webhook 凭据状态…';
  @override
  String get settingsWebhookCurrent => '当前凭据';
  @override
  String settingsWebhookCurrentValue(String secretId, String createdAt) => '凭据 $secretId · 生成于 $createdAt';
  @override
  String get settingsWebhookNotConfiguredNote => '这条通道现在一律 401（没有凭据就没人投得进来）。按下面的按钮生成一份。';
  @override
  String get settingsWebhookRotated => '上次轮换';
  @override
  String get settingsWebhookNever => '从未';
  @override
  String settingsWebhookBy(String by) => '发起方：$by';
  @override
  String get settingsRegenerate => '重新生成';
  @override
  String get settingsGenerateWebhook => '生成 webhook 凭据';
  @override
  String get settingsWebhookCredentialNote => '/webhook/* 不认界面凭据（也不认迁移期那份 data/.ui-token）：这条通道只认上面那份专用凭据。它是给外部系统的——投得进来，读不到 /api/* 上的任何东西。';
  @override
  String get settingsRegenerateTitle => '重新生成 webhook 凭据';
  @override
  String get settingsRegenerateBody => '上一份会当场失效：已经在用它的外部脚本会立刻开始收 401——记得把新凭据一起换过去。新凭据只显示一次。';
  @override
  String get settingsNoTokenReturned => '服务端没有回凭据原文，请再按一次；若反复如此，去看主进程日志';
  @override
  String get settingsWebhookRotatedNote => '上一份已当场失效（还在用它的外部脚本会开始收 401）。';
  @override
  String settingsGenerateFailed(String err) => '生成失败：$err';
  @override
  String get settingsMemoryNote => '长期记忆（MEMORIES/ 与 diary/）由谁维护：框架替你管，还是她自己读、自己写、自己整理。';
  @override
  String get settingsNotInEffect => '尚未生效';
  @override
  String get settingsMemoryEnableLabel => '让框架自动管记忆（关掉 = 她只知道自己有这些文件，读、写、整理全归她）';
  @override
  String get settingsMemoryEnableNote => '开着：框架生成并维护 MEMORIES/INDEX.md，每轮把索引注入固定块，并每日整理一次。';
  @override
  String get settingsMemoryOn => '框架自动管记忆（每轮注入索引、每日整理）';
  @override
  String get settingsMemoryOff => '她自己管（框架不生成、不注入、不整理）';
  @override
  String get settingsMemoryUnaffectedNote => '不受这个开关影响的两条路：MEMORIES/aliases.md 参与「会话认人 / 关注名单」属于通道侧；STATE.md（她当前状态）是独立的一层。';
  @override
  String get settingsMemoryRestartNote => '这一项是进程启动时读的：保存写进 config.json，重启后接管。关掉不会删任何文件。';
  @override
  String get settingsMemoryDetail =>
      '关掉之后框架不生成、不注入、不整理，但她照旧能自己读写那些文件。'
      '为什么留这个开关：给只想让 agent 自己管记忆的人一条干净的路。'
      '每日整理的时间点由 wake.memoryMaintainCron 定（默认每日一次）：'
      '过期的流水账并进 facts.md，另写一篇 diary/。'
      'facts.md 的 !pinned 分区与条目 TTL 也归框架维护。';
  @override
  String get settingsMemoryCost => '代价：她可能忘记整理，facts.md 会一直长下去，索引也不再更新——这些都归她自己。';
  @override
  String get settingsMemoryOnSaved => '已改为框架自动管记忆（重启后接管）';
  @override
  String get settingsMemoryOffSaved => '已改为她自己管记忆（重启后接管）';
  @override
  String get settingsTrustNote => '她的活动边界：整台电脑，或只有一个工作目录。越界就是拒绝，不是提醒。';
  @override
  String get settingsTrustReachLabel => '她能碰到多远';
  @override
  String get settingsTrustReachNote => '两档各自管什么写在选项里，改哪一档就按哪一档的后果算。';
  @override
  String get settingsTrustWorkspaceUnknownPath => '只限工作目录（路径未读到）';
  @override
  String settingsTrustWorkspaceValue(String root) => '只限工作目录 · $root';
  @override
  String get settingsTrustFullValue => '完全信任（整台电脑）';
  @override
  String get settingsTrustPendingNote => '上面选的那一档还没生效：盘上已经写下了，但正跑着的这个进程用的仍是启动时读到的那份——重启后接管。在那之前，她照旧按当前生效的那一档活动。';
  @override
  String get settingsTrustRootNote => '工作目录由服务端算出来（默认 <配置目录>/workspace），界面上不手填：同一条边界写两个值，就一定会出现"配置说 A、实际拦在 B"。';
  @override
  String get settingsTrustBoundaryNote => '它是边界，不是提醒：越界的读写与命令一律被拒绝。';
  @override
  String get settingsTrustRulesDetail =>
      '它管 fs 工具族（safe_read / safe_write / safe_edit / rg_search 等）与 pwsh：'
      '前者经同一条路径判定，后者的 workdir 与命令行里的路径一起受管。'
      '它与 destructive 开关、pwsh 命令黑名单是各自独立的三道门——这一条管的是范围，'
      '不代替那两道。\n'
      '为什么默认完全信任：她是一台无人值守的常驻 agent，"能自己去找、去修、去装"本来'
      '就是她存在的方式；默认把她关进一个空目录，等于出厂就让她大多数本事用不出来。';
  @override
  String get settingsTrustFullTitle => '改成完全信任';
  @override
  String get settingsTrustFullConfirmTail => '这是一条边界，撤掉它她是真的能做到上面这些事。确定吗？';
  @override
  String get settingsTrustWorkspaceSaved => '已改为只限工作目录；越界的读写与命令会被拒绝（重启进程后接管）';
  @override
  String get settingsTrustFullSaved => '已改为完全信任（重启进程后接管）';
  @override
  String get settingsSystemNote => '监听地址、时区、六条预算与心跳都是这个进程的启动参数：在这里改，保存写进 config.json，重启后生效。压缩线那一行例外——它写完立刻生效（服务端在同一个临界区里也改了内存那份）。';
  @override
  String get settingsDataDir => '数据目录';
  @override
  String get settingsDataDirNote => '启动时定下的路径：事件日志、人格资产与密钥都在它下面，换它等于让下一个进程从空目录开始。';
  @override
  String get settingsSystemFootnote => '数据目录在这里改不了（它决定她的全部身家落在哪，且进程启动时就定下了）；其余字段保存后重启进程生效——压缩线那一行除外，它保存完就当拍接管。';
  @override
  String get settingsLiveNow => '立刻生效';
  @override
  String get settingsEdit => '编辑';
  @override
  String get settingsAccountNote => '进来这个界面用的凭据：改密码、结束实例、退出登录（清除本机凭据）。';
  @override
  String get settingsAccountLegacyBadge => '旧的共享 token';
  @override
  String get settingsAccountSessionBadge => '会话凭据';
  @override
  String get settingsAccountInstance => '当前实例';
  @override
  String get settingsAccountInstanceNote => '凭据按实例分文件存（%APPDATA%\\Irmia\\sessions）：同一台机器上开第二个实例不会把这一份顶掉。';
  @override
  String get settingsAccountLegacyNote =>
      '这一份用的是旧的共享 token（这台实例还没设过密码），服务端不认它开出的"会话"：改密码与退出登录都做不成（结束实例不受影响）。'
      '先设置一个密码，之后按会话登录/退出登录。';
  @override
  String get settingsChangePassword => '改密码';
  @override
  String get settingsLogout => '退出登录（清除本机凭据）';
  @override
  String get settingsSetPasswordFirst => '先去设置密码';
  @override
  String get settingsPasswordChanged => '密码已改；这台界面已经换上新凭据';
  @override
    String get settingsLogoutBody => '退出登录：清掉本机保存的凭据、停掉它的后端进程，然后回到实例选择页'
        '——下次进来要重新登录（用密码）。只是关掉实例、保留登录状态的话，用「结束实例」。';
  @override
  String get settingsCloseInstance => '结束实例';
  @override
  String get settingsCloseInstanceBody => '结束实例：停掉它的后端进程（不再跑心跳、不再收消息），回到实例选择页。'
      '登录状态保留——下次从选择页点「进入」就直接回来，不用输密码。';
  @override
  String get gateHintSessionExpired => '会话凭据已失效，请重新登录。';
  @override
  String get gateHintSetupNeeded => '这台实例还没有密码，先设一个。';
  @override
  String get gateHintAlreadyInitialized => '这台实例已设过密码，请用密码登录。';
  @override
  String gateWaitingBackend(int port) => '后端还没起来（正在等 :$port）';
  @override
  String gateBackendDown(String address) => '后端还没起来（$address）。正在重试…';
  @override
  String gateBackendStarting(String phase) => phase.trim().isEmpty
      ? '后端正在启动。正在重试…'
      : '后端正在启动（阶段：${phase.trim()}）。正在重试…';
  @override
  String backendPhaseLabel(String phase) => switch (phase.trim()) {
        'events' => '事件回放',
        'mcp' => '外部工具',
        'channels' => '消息通道',
        'ready' => '就绪',
        final other => other,
      };
  @override
  String gateBackendProgress(int seconds, int retries) => '第 $seconds 秒 · 已重试 $retries 次';
  @override
  String get gateBackendLogHint => '后端一直没就绪：看 %LOCALAPPDATA%\\Irmia\\gui.log';
  // ── 实例选择页（2026-10）──
  @override
  String get pickerTitle => '选择实例';
  @override
  String get pickerBody => '上一台实例已经结束：后端进程停了（不再跑心跳、不再收消息），登录状态保留——点「进入」就直接回来。'
      '在这里选一台继续，或者新建一台。实例之间完全隔离：各自的数据、各自的密码、各自的编辑权限。';
  @override
  String get pickerLoading => '正在读实例列表…';
  @override
  String get pickerEmpty => '还没有登记过实例。新建一台开始用。';
  @override
  String get pickerUnreadable => '读不出实例列表（文件不在或已损坏）：可以新建一台，其余实例不受影响。';
  @override
  String get pickerRunning => '运行中';
  @override
  String get pickerStopped => '未运行';
  @override
  String get pickerDefaultBadge => '默认';
  @override
  String get pickerLogin => '登录';
  @override
  String get pickerStart => '启动并登录';
  @override
  String get pickerStarting => '正在启动…';
  @override
  String get pickerEnter => '进入';
  @override
  String get pickerStartEnter => '启动并进入';
  @override
  String get pickerEntering => '正在进入…';
  @override
  String get pickerForget => '忘记凭据';
  @override
  String get pickerSessionExpired => '登录状态已失效，需要重新登录。';
  @override
  String get pickerNew => '新建实例';
  @override
  String get pickerDelete => '删除';
  @override
  String get pickerNewNameLabel => '名字';
  @override
  String get pickerNewDirLabel => '数据目录';
  @override
  String get pickerNewCreate => '创建';
  @override
  String get pickerNewUseDir => '用这个目录';
  @override
  String get pickerDeleteTitle => '删除实例';
  @override
  String pickerDeleteBody(String name) => '删除「$name」？';
  @override
  String pickerForgetBody(String name) => '忘记「$name」的凭据？只清掉这台机器上保存的那一份登录凭据：'
      '实例还在跑，登记表里的条目也不动。下次进来要用密码。';
  @override
  String get pickerDeleteNote =>
      '默认只删登记表里的这一条，数据目录留在盘上。连目录一起删会把里面的记忆与人格一起删掉，不能恢复。';
  @override
  String get pickerDeleteKeepDir => '只删条目';
  @override
  String get pickerDeleteWithDir => '连目录一起删';
  @override
  String get pickerRename => '改名';
  @override
  String get pickerRenameTitle => '给实例改名';
  @override
  String get pickerRenameBody =>
      '这是选择页上显示的名字。改过之后它就算人工改的：后端启动时不会再拿人格文件里的名字覆盖它。';
  @override
  String get pickerRenameSave => '保存';
  @override
  String get pickerProblemNameRequired => '请给实例起个名字。';
  @override
  String get pickerProblemNoLauncher =>
      '实例列表里没有可用的启动路径（node 与入口脚本）：没法拉起后端——先把那台实例启动一次，它会自己把路径写进登记表。';
  @override
  String get pickerProblemLaunchFailed => '后端没能启动：进程没起来（检查 node 与入口脚本的路径）。';
  @override
  String get pickerProblemPortUnavailable => '从 7788 起找不到空闲端口：先停掉别的实例再试。';
  @override
  String get pickerProblemRemoveFailed => '删不掉：实例列表文件写不进去（可能被占用）。再试一次。';
  @override
  String get pickerProblemRenameFailed => '改不了名：实例列表文件写不进去（可能被占用）。名字还是原来那个，再试一次。';
  @override
  String pickerProblemDirNotEmpty(String dir) => '目录已存在且非空：$dir。换个名字，或者选择「用这个目录」。';
  @override
  String pickerProblemNotReady(int seconds, String phase, String port) =>
      '已经等了 $seconds 秒，它还在启动${phase.trim().isEmpty ? '' : '（阶段：${phase.trim()}）'}：'
      '不再等了（:$port）——看它的日志。';
  @override
  String pickerWaitingReady(int seconds, String phase) =>
      '已经等了 $seconds 秒，它还在启动${phase.trim().isEmpty ? '' : '（阶段：${phase.trim()}）'}';
  @override
  String get pickerStopWaiting => '停止等待';
  @override
  String pickerProblemPortTaken(String id) => '那个端口上住着另一台实例（$id）：没有连它——实例之间不许串。';
  @override
  String pickerProblemCannotDeleteRunning(String name) => '「$name」正在运行：先登录进去结束它，再回来删。';
  @override
  String pickerProblemCannotDeleteDefault(String name) => '「$name」是默认实例：不能删（数据目录还在用）。';
  @override
  String pickerStartingNamed(String name) => '正在启动「$name」…（首次启动要几十秒）';
  @override
  String pickerNewPort(String port) => '将使用端口 :$port';
  @override
  String pickerDeleteDisabled(String reason) => '不能删：$reason';
  @override
  String get settingsAboutNote => '界面版本与运行期投影数据。';
  @override
  String get settingsAboutBadge => 'Flutter 原生界面';
  @override
  String get settingsVersionLabel => '版本';
  @override
  String get settingsGuardedDays => '守护天数';
  @override
  String get settingsWatermark => '事件水位';
  @override
  String settingsProjectionReadFailedHint(String projError) => '运行数据读取失败（$projError），守护天数与事件水位不可用。';
  @override
  String get settingsProjectionFootnote => '守护天数与事件水位取自运行期投影（GET /api/projection），为实测值。';
  @override
  String settingsDaysCount(String days) => '$days 天';
  @override
  String settingsDaysSince(String days, String stamp) => '$days 天（自 $stamp）';
  @override
  String get settingsDestructivePolicy => 'destructive 工具策略';
  @override
  String get settingsModify => '修改';
  @override
  String get settingsPolicyNoneOption => '全关（一件都不给她看）';
  @override
  String get settingsPolicyAllOption => '全开（清单里全给）';
  @override
  String get settingsPolicyListOption => '按名单（只给勾中的那几件）';
  @override
  String get settingsPolicyListTitle => '按名单开放';
  @override
  String get settingsPolicyNoTools => '没拿到工具清单（注册表可能还没起来）——先去「扩展 · 工具」看一眼再回来。';
  @override
  String get settingsDestructiveTitle => '修改 destructive 工具策略';
  @override
  String get settingsDestructiveRelaxedBody => '这会让她能看到并调用会改动本机的工具（写文件、跑命令等）。确定吗？';
  @override
  String get settingsDestructiveRestrictedBody => '改回受限档：她将看不到 destructive 工具（更安全）。确定吗？';
  @override
  String get settingsPolicyAll => '全开';
  @override
  String get settingsPolicyListEmpty => '按名单（空）';
  @override
  String get settingsPolicyNone => '全关';
  // ── 设置页：手写的那几条 ──
  @override
  String get settingsListAnd => '与';
  @override
  String settingsSaved(String written, String restart) => '已保存$written$restart';
  @override
  String settingsClearKeyTitle(String laneLabel) => '清除密钥 · $laneLabel';
  @override
  String settingsKeyConfiguredMask(String mask) => '已配置 $mask';
  @override
  String settingsDepPipUnavailable(String? reason) =>
      'pip：不可用${reason == null ? '' : '（$reason）'}';
  @override
  String settingsInstallConfirmBody(String managedDir) =>
      '会从官方地址下载压缩包并解压到 $managedDir，然后立即复检。'
      '装好后 agent 就能用它（rg_search / es_search 会随之注册；'
      'Python 还会顺带引导 pip，让她能自己 pip install 扩能力）。';
  @override
  String settingsDepReadyToast(String label, String version) => '$label 已就绪（$version）';
  @override
  String settingsStepErrorToast(String step, String error) => '$step：$error';
  @override
  String settingsNoDownloadPage(String hint) => '这一项没有下载页；装法：$hint';
  @override
  String settingsOpenUrlFailed(String url, String? hint) =>
      '打不开浏览器，地址是 $url${hint == null ? '' : '（$hint）'}';
  @override
  String settingsInstalledVersion(String? version) => '已装好${version == null ? '' : ' $version'}';
  @override
  String settingsWriteErrorNote(String writeError) =>
      '自动配置没写成：$writeError。装好的目录已经替你填在下面的「安装目录」里，'
      '点一下「保存目录」、再把「启用内置协议端」打开就行（同样是重启后接管）。';
  @override
  String settingsChainSince(String when) => '$when 起';
  @override
  String settingsChainUnreadableDetail(String path) => '那份文件在（$path）但端点解析失败——要人去修它';
  @override
  String settingsProtocolToggled(bool on, bool restart) =>
      '${on ? '已开启' : '已关闭'}内置协议端${restart ? '（重启进程后接管）' : ''}';
  @override
  String settingsInstallDirSaved(String saved, bool restart) =>
      '已保存安装目录：$saved${restart ? '（重启进程后接管）' : ''}';
  @override
  String settingsProtocolActionFailed(bool start, String err) =>
      '${start ? '启动' : '停止'}请求失败：$err';
  @override
  String settingsWebhookFileNote(String file) =>
      '凭据文件：$file（盘上只有它的 sha256：原文只在你按下按钮那一次出现在屏幕上，'
      '之后再没人读得回来）。';
  @override
  String settingsTrustFullBody(String consequence) => '改成完全信任之后：$consequence';
  @override
  String settingsPolicyListCount(int count) => '按名单（$count 项）';
  @override
  String get settingsUnknownReason => '未知原因';
  @override
  String get settingsSeeOfficialDocs => '见官方文档';
  @override
  String get settingsWebhookCurlTokenPlaceholder => '<专用凭据>';
  @override
  String get settingsWebhookCurlSampleText => '磁盘快满了';
  @override
  String settingsDepsSuggested(int count) => '建议安装 $count 项';
  @override
  String settingsDepPipReady(String version) => 'pip $version（她可以自己 pip install 扩能力）';
  @override
  String settingsDepPurposeImpact(String purpose, String impact) => '$purpose。$impact';
  @override
  String settingsInstallTitle(String label) => '安装 $label';
  @override
  String settingsPolicySave(int count) => '保存（$count 件）';
  @override
  String settingsInstallHead(bool ok, String? version, bool configured) => ok
      ? '已装好${version == null ? '' : ' $version'}${configured ? '，并用它配好了；重启一下就能用。' : '，但自动配置那一步没成。'}'
      : '安装失败';

  @override
  String get chanSourceQqOfficial => 'QQ 官方';
  @override
  String get chanEventInboundWake => '入站唤醒';
  @override
  String get chanEventFile => '文件事件';
  @override
  String get chanAlertExit => '告警出口';
  @override
  String get chanQqAppIdHint => '开放平台管理端的机器人 ID。';
  @override
  String get chanQqAppSecretHint => '换取 access_token 的密钥。';
  @override
  String get chanOneBotTokenHint => '协议端开了校验时必填。';
  @override
  String get chanQqApiBaseLabel => 'API 根地址';
  @override
  String get chanQqUrlHint => '留空用官方地址，只收 http(s)。';
  @override
  String get chanQqTokenUrlLabel => '凭证地址';
  @override
  String get chanQqGatewayUrlLabel => '网关覆盖地址';
  @override
  String get chanQqGatewayHint => '留空向凭证接口取，只收 ws(s)。';
  @override
  String get chanOneBotWsLabel => '协议端 ws 地址';
  @override
  String get chanOneBotWsHint => '协议端正向 WebSocket 端口，必须 ws:// 或 wss://。';
  @override
  String get chanAlertWebhookLabel => '告警出口 webhook';
  @override
  String get chanAlertWebhookHint => '留空 = 告警只落日志、不对外发送。';
  @override
  String get chanAlertRateLabel => '同类告警限流窗口';
  @override
  String get chanAlertRateHint => '单位分钟。';
  @override
  String get chanEndpointLabel => '连接端点 host:port';
  @override
  String get chanListenLabel => '入站监听地址';
  @override
  String get chanQqTitle => 'QQ 官方 Bot API';
  @override
  String get chanQqHint => 'AppID 与 AppSecret 在下面直接填值（存在本机 data/.keys.json，不进 config.json）；两者齐备才建连。';
  @override
  String get chanOneBotHint => '协议端（NapCat / go-cqhttp）的正向 WebSocket；access_token 在下面直接填值。';
  @override
  String get chanOneBotBlurb => '协议端正向 WebSocket';
  @override
  String get chanHookTitle => 'Webhook 与文件监听';
  @override
  String get chanHookHint => '出口地址为空时告警仅写入日志。';
  @override
  String get chanHookBlurb => '告警出口 · 入站监听';
  @override
  String get chanConfigReadFailed => '配置读取失败';
  @override
  String get chanKeysReadFailed => '密钥状态读取失败';
  @override
  String chanClearSecretTitle(String label) =>
      '清除密钥 · $label';
  @override
  String get chanClearSecretBody => '清除后需重新填写。';
  @override
  String chanClearFailed(String reason) =>
      '清除失败：$reason';
  @override
  String chanNotANumber(String field) =>
      '$field 需要填数字，未保存';
  @override
  String get chanNothingToSave => '没有需要保存的改动';
  @override
  String chanSavedFieldCount(int count) =>
      '$count 项参数';
  @override
  String chanSavedSecretCount(int count) =>
      '$count 项密钥';
  @override
  String get chanSavedRestartSuffix => '，进程重启后接管';
  @override
  String get chanSavedLiveSuffix => '，下次建连时生效';
  @override
  String chanSaved(String parts, String suffix) =>
      '已保存$parts$suffix';
  @override
  String get chanReloaded => '已按生效配置重新加载';
  @override
  String chanTestDelivered(String url) =>
      "已送达：${url.isEmpty ? '告警出口' : url} 收到了这条测试消息";
  @override
  String chanTestNotDelivered(String reason) =>
      "没送到${reason.isEmpty ? '：出口没有应答' : '：$reason'}";
  @override
  String chanTestFailed(String reason) =>
      '测试失败：$reason';
  @override
  String get chanStatusUnknown => '状态未知';
  @override
  String get chanStatusUnknownNote => '生效配置尚未读取，通道状态未知。';
  @override
  String get chanStatusOff => '未启用';
  @override
  String get chanStatusOffNote => '已在配置中关闭，适配器不会建立连接。';
  @override
  String get chanStatusOn => '已启用';
  @override
  String get chanStatusOnNote => '尚无通道事件。';
  @override
  String chanStatusRunningNote(String at, String suffix) =>
      '最近一条通道事件 $at$suffix。';
  @override
  String get chanStatusNoExit => '未配置出口';
  @override
  String get chanStatusNoExitNote => '出口地址为空，告警仅写入日志，不对外发送。';
  @override
  String get chanStatusExitOn => '出口已配置';
  @override
  String get chanStatusExitOnNote => '尚无触发记录：入站唤醒与文件事件均为空。';
  @override
  String chanStatusHookRunningNote(String tag, String at) =>
      '最近一条 $tag $at。';
  @override
  String chanFootnoteError(String error) =>
      '通道活动读取失败（$error）。状态按配置文件判定。';
  @override
  String chanFootnoteCount(int count) =>
      '通道活动取自最近 50 条通道相关事件（实收 $count 条），状态据此判定。';
  @override
  String get chanPageTitle => '消息适配器';
  @override
  String get chanPageSubtitle => '入站通道、告警出口与文件监听';
  @override
  String get chanGuideText => '还没有启用任何消息通道。';
  @override
  String get chanGuideAction => '配置 QQ 官方';
  @override
  String get chanGuideHint => '通道开关与端点参数都在本页的「通道配置」卡里改：写进 config.json，进程重启后接管。';
  @override
  String get chanListHeader => '渠道';
  @override
  String get chanReloadAction => '重新加载';
  @override
  String get chanConfigAction => '配置';
  @override
  String get chanConfigUnavailable => '配置不可用';
  @override
  String get chanConfigUnavailableHint => '本地服务 /api/config 未返回配置内容。';
  @override
  String get chanBackToList => '渠道列表';
  @override
  String get chanRecentActivity => '最近活动';
  @override
  String get chanMentionTitle => '她怎么被称呼';
  @override
  String get chanMentionNote => '群里不打 @ 直接喊这几个词时，框架把那些话当作"在叫她"，与 @ 一样推到她面前。';
  @override
  String get chanMentionEmpty => '现在只认平台的 @：群里不打 @ 直接喊她名字的那些话，她听不见。';
  @override
  String get chanMentionHint => '改完立刻生效（下一句消息就按新名单判），不用重启。';
  @override
  String chanMentionSaveFailed(String problem) =>
      '没写进去：$problem';
  @override
  String get chanMentionCleared => '已设为"只认 @ 叫她"';
  @override
  String chanMentionSaved(String words) =>
      '记下了：$words';
  @override
  String get chanContactsTitle => '会话联系人';
  @override
  String get chanContactsNote => 'QQ 不给昵称，在这里告诉她谁是谁。';
  @override
  String get chanDetailsLabel => '说明';
  @override
  String get chanContactsDetail => '群聊里只有 @ 她或喊她的名字才会进对话流；其余能不能收到取决于官方 Bot 的消息权限——平台推给我们的，照旧进信箱。在群里 @ 过她的人会自动登记到那个群下面（她再看到就不只是 openid）——'
      '展开可以改名。她自己记的备注（写在名字后括号里的那段）只在这里显示，不算名字、也改不动——那一格保存的是名字，备注留在她自己的记忆里。';
  @override
  String get chanContactsEmpty => '还没有会话跟她说过话。等有人先来一句，这里就会列出那个会话。';
  @override
  String get chanGroupSceneLabel => '群聊场景';
  @override
  String get chanGroupSceneHard => '硬拒绝：本机类工具不给';
  @override
  String get chanGroupSceneSoft => '软提醒：讲清风险，判断留给她';
  @override
  String get chanContactsRestartNote => '改完需要重启主进程才生效（联系人表不在热更名单里）。';
  @override
  String chanContactLine(String chat, String when) =>
      '$chat｜最后 $when';
  @override
  String chanContactNote(String note) =>
      '备注：$note';
  @override
  String get chanContactHint => '这是谁（留空 = 不署名）';
  @override
  String get chanContactSaveTooltip => '保存这个名字';
  @override
  String get chanMembersCollapse => '收起群成员';
  @override
  String chanMembersExpand(int count) =>
      '展开群成员（$count）';
  @override
  String get chanWarnExempt => '框架预警：已豁免';
  @override
  String get chanWarnOn => '框架预警：开';
  @override
  String get chanMemberSaveTooltip => '保存这个名字（下一轮生效）';
  @override
  String chanMemberNameTooltip(String who) =>
      '给 $who 起个名字';
  @override
  String get chanExemptSessionOn => '已豁免这个单聊的框架预警';
  @override
  String get chanExemptSessionOff => '已恢复这个单聊的框架预警';
  @override
  String get chanExemptMemberOn => '已豁免这个人的框架预警';
  @override
  String get chanExemptMemberOff => '已恢复这个人的框架预警';
  @override
  String get chanGroupSceneHardToast => '群聊场景已切到硬拒绝：她不能在群聊里动这台机器';
  @override
  String get chanGroupSceneSoftToast => '群聊场景已切回软提醒：框架提醒她，判断留给她';
  @override
  String chanToggleFailed(String err) =>
      '切换失败：$err';
  @override
  String get chanNameRequired => '名字不能为空';
  @override
  String chanMemberSaved(String name) =>
      '已记为「$name」——下一轮她就这么叫他';
  @override
  String get chanContactCleared => '已清除这个会话的名字';
  @override
  String chanContactSaved(String name) =>
      '已记为「$name」——重启主进程后她就用这个名字认人';
  @override
  String get chanConfigTitle => '通道配置';
  @override
  String get chanNeedsRestart => '需重启';
  @override
  String get chanConfigNote => '写入 config.json，重启后接管；清空一项 = 回到默认值。';
  @override
  String get chanConfigDetail => '密钥类字段直接填值：它存本机密钥文件，不进 config.json。环境变量优先于这些文件。';
  @override
  String get chanTestAlert => '测试告警出口';
  @override
  String chanSaveWithCount(int count) =>
      '保存（$count 项改动）';
  @override
  String get chanEnableLabel => '启用该通道';
  @override
  String get chanEnableNoteOn => '重启后建立连接并开始收消息。';
  @override
  String get chanEnableNoteOff => '关闭状态：适配器不建立连接。';
  @override
  String get chanSecretHintConfigured => '已配置；粘贴新值可覆盖';
  @override
  String chanSecretHintPaste(String label) =>
      '粘贴$label';
  @override
  String chanSecretConfigured(String mask) =>
      '已配置 $mask';
  @override
  String get chanNumberHint => '数字';
  @override
  String get chanNotSetHint => '未设置';
  @override
  String chanReadonlyFold(int count) =>
      '只读项（$count 项）';
  @override
  String get chanChannelIdLabel => '通道 id';
  @override
  String get chanFeedEmpty => '还没有通道活动——收到消息、唤醒或回投成功时才会有记录。';
  @override
  String get chanSourceExternal => '外部';
  @override
  String get chanEventGeneric => '事件';
  @override
  String get chanJoinWords => '、';
  @override
  String get schedNotProjection => '返回的数据不是投影';
  @override
  String get schedCancelTitle => '取消这条安排？';
  @override
  String schedCancelBody(String timerId) =>
      '定时器 $timerId 会被取消：它到点不会再把她叫起来。\n这次撤销写进日志（timer/cancelled），撤错了只能让她重新排一个。\n想改时间或改内容，也走这条路：'
      '撤掉这条，再跟她说一句新的（「新建安排」）。';
  @override
  String get schedCancelPlan => '取消安排';
  @override
  String schedCancelled(String timerId) =>
      '已取消 $timerId：到点不会再醒';
  @override
  String schedCancelFailed(String timerId, String err) =>
      '取消 $timerId 失败：$err';
  @override
  String schedCancelFailedShort(String err) =>
      '取消失败：$err';
  @override
  String schedBuilt(String when, String note) =>
      '已经排上了：$when · $note';
  @override
  String get schedBuiltToast => '已排上这条安排';
  @override
  String get schedNoServerTime => '（服务端没回时刻）';
  @override
  String schedRecurringWithNext(String label, String when) =>
      '周期 $label（下一次 $when）';
  @override
  String get schedSearchTitle => '搜索安排';
  @override
  String get schedSearchHint => '标题 / 到点做什么 / 为什么';
  @override
  String get schedSearch => '搜索';
  @override
  String get schedPageTitle => '近期安排';
  @override
  String get schedPageSubtitle => '把日程、提醒和她自己的计划放在同一处。';
  @override
  String get schedBackToThisWeek => '回到本周';
  @override
  String get schedNewPlan => '新建安排';
  @override
  String get schedLoading => '正在读她排着的安排…';
  @override
  String schedLoadFailed(String error) =>
      '读不到日程：$error';
  @override
  String get schedLoadHint => '这一页读的是投影 /api/projection 里的 timers：刷新一次试试；一直读不到说明主进程那边有问题。';
  @override
  String get schedStatThisWeek => '本周安排';
  @override
  String get schedStatThisWeekNote => '一次性与周期任务';
  @override
  String get schedStatWaiting => '等待触发';
  @override
  String get schedStatWaitingNote => '到点后会重新判断';
  @override
  String get schedStatSelfWork => 'Agent 自主工作';
  @override
  String get schedStatSelfWorkNote => '不一定需要联系你';
  @override
  String get schedStatDrafts => '待分享想法';
  @override
  String get schedStatDraftsNote => '她的草稿还没有落盘';
  @override
  String get schedCalendarTitle => '周历';
  @override
  String get schedPrevWeek => '上一周';
  @override
  String schedWeekRange(int month, int day, int endDay) =>
      '$month月$day日 — $endDay日';
  @override
  String get schedNextWeek => '下一周';
  @override
  String schedUnplaceable(int count) =>
      '画不出这一周的周期条目：$count 条（在清单里）';
  @override
  String schedTimeRecurring(String hour, String minute) =>
      '$hour:$minute · 周期';
  @override
  String schedMonthDay(int month, int day) =>
      '$month月$day日';
  @override
  String get schedRecurringPill => '周期';
  @override
  String get schedWeekEmpty => '这一周还没有安排。';
  @override
  String schedWeekHidden(int hidden) =>
      '这一周还有 $hidden 条没摆下，看右边的清单';
  @override
  String get schedListTitle => '安排清单';
  @override
  String schedFilterDay(String day) =>
      '只看 $day';
  @override
  String schedFilterQuery(String query) =>
      '匹配「$query」';
  @override
  String schedFilterCount(int count) =>
      '$count 条';
  @override
  String get schedShowAll => '看全部';
  @override
  String get schedClearSearch => '清除搜索';
  @override
  String get schedActionGoneHint => '可能是它已经触发或已经被撤掉了；刷新一次看最新清单。';
  @override
  String get schedListNoMatch => '这里没有符合条件的安排。';
  @override
  String get schedListEmpty => '还没有排着的事。';
  @override
  String get schedListEmptyHint => '安排只是一次机会——到点她会先确认还值不值得做，不值得就跳过。';
  @override
  String get schedDetailPlaceholder => '选择一个安排';
  @override
  String get schedFieldWhen => '执行时间';
  @override
  String schedDetailRecurring(String label) =>
      '周期 $label（下一次在服务端重排）';
  @override
  String schedDetailTimeSuffix(String label) =>
      ' · 周期 $label';
  @override
  String get schedFieldWhy => '为什么安排它';
  @override
  String get schedFieldWhat => '到点做什么';
  @override
  String get schedFieldWhere => '到哪儿说';
  @override
  String get schedFieldDuration => '时长';
  @override
  String schedMinutes(Object? dur) =>
      '$dur 分钟';
  @override
  String schedMinutesDefault(Object? dur) =>
      '$dur 分钟（约定值：这条没写 dur）';
  @override
  String get schedFieldAfter => '到点后';
  @override
  String get schedUnwritten => '未写';
  @override
  String schedWakeReceipt(String text) =>
      '已经跟她说了一句：『$text』';
  @override
  String get schedSeeChat => '去聊天页看她的反应';
  @override
  String schedBuiltReceipt(String text) =>
      '$text —— 这条是你直接排的：她到点会读到你的理由。';
  @override
  String get schedChoiceNotify => '到点提醒我';
  @override
  String get schedChoiceSelf => '她自己先做';
  @override
  String get schedChoiceDraft => '先存个草稿';
  @override
  String get schedKindMemoryMaintain => '每日记忆整理';
  @override
  String get schedKindWait => '她自己等的';
  @override
  String get schedUntitled => '未命名安排';
  @override
  String get schedStatusDraft => '待分享草稿';
  @override
  String get schedStatusRecurring => '周期任务';
  @override
  String get schedStatusWaiting => '待触发';
  @override
  String get schedWakeDeduped => '这句和刚发过的完全一样，被当成同一条忽略了——过几秒再发一次就行';
  @override
  String get schedViewWeek => '周';
  @override
  String get schedViewList => '列表';
  @override
  String schedRecurringLine(String label) =>
      '周期 · $label';
  @override
  String get schedChorePill => '她的内务';
  @override
  String schedWillSay(String label) =>
      '到点会说：$label';
  @override
  String get schedErrDate => '「日期」看不懂：写 今天 / 明天 / 后天 或 2026-10-20 都行。';
  @override
  String get schedErrClock => '「钟点」要写成 20:00 这样（24 小时制）。';
  @override
  String get schedErrWhat => '「要做什么」要填：她到点看见的就是这一句。';
  @override
  String get schedErrDuration => '「大概多久」填分钟数就行（不填就按半小时算）。';
  @override
  String get schedRepeatDaily => '每天';
  @override
  String get schedRepeatWeekly => '每周';
  @override
  String get schedErrBrief => '写一句话再让她排（她读到的就是这一句）。';
  @override
  String schedWakePrefix(String text) =>
      '请帮我排一条安排：$text';
  @override
  String schedWakeFailed(String err) =>
      '没能把这句话送到她那里：$err';
  @override
  String schedCreateFailed(String err) =>
      '这条安排没能排上：$err';
  @override
  String get schedCardLead => '一般更建议交给她建：她会自己写"为什么"，到点先确认还值不值得做。直接建是给你急用的。';
  @override
  String get schedPathHer => '交给她建';
  @override
  String get schedPathDirect => '我直接建';
  @override
  String get schedLater => '稍后';
  @override
  String get schedSending => '正在送…';
  @override
  String get schedCreateDirect => '直接建';
  @override
  String get schedLetHerSchedule => '让她排';
  @override
  String get schedFieldBrief => '一句话跟她说';
  @override
  String get schedBriefHint => '下周一早上九点提醒我看周计划';
  @override
  String get schedBriefNote => '这句话会直接送到她那里，由她来排。';
  @override
  String get schedFieldDay => '哪一天';
  @override
  String get schedDayHint => '今天 / 明天 / 2026-10-20';
  @override
  String get schedFieldClock => '几点';
  @override
  String get schedFieldRepeat => '要不要重复';
  @override
  String get schedRepeatOnceChoice => '只这一次';
  @override
  String get schedRepeatWeeklyChoice => '每周（就这一天）';
  @override
  String get schedFieldWhatToDo => '要做什么';
  @override
  String get schedWhatHint => '看一眼汇报材料定稿没有';
  @override
  String get schedMoreOptions => '更多选项（标题、分类、说给谁…）';
  @override
  String get schedFieldTitle => '标题';
  @override
  String get schedTitleHint => '不填就用"要做什么"那句';
  @override
  String get schedFieldWhyInput => '为什么排它';
  @override
  String get schedWhyHint => '周三要交，我怕忘了';
  @override
  String get schedFieldDurationInput => '大概多久（分钟）';
  @override
  String get schedFieldCategory => '分类';
  @override
  String get schedNoCategory => '不分类';
  @override
  String get schedFieldSid => '要不要说给谁';
  @override
  String get schedNoSid => '不用告诉谁';
  @override
  String get schedPastWarning => '这个时刻已经过去了：落下去她会马上被叫醒一次。';
  @override
  String get schedCreateNote => '建好之后它就是一条真安排：到点她会看见你写的这句。';
  @override
  String schedSidWithName(String name, String short) =>
      '$name（$short）';
  @override
  String schedMonthDayRaw(Object month, Object day) =>
      '$month月$day日';
  @override
  String schedWhenStamp(int month, int day, String time) =>
      '$month月$day日 · $time';
  @override
  String get schedWeekdayMon => '周一';
  @override
  String get schedWeekdayTue => '周二';
  @override
  String get schedWeekdayWed => '周三';
  @override
  String get schedWeekdayThu => '周四';
  @override
  String get schedWeekdayFri => '周五';
  @override
  String get schedWeekdaySat => '周六';
  @override
  String get schedWeekdaySun => '周日';
  @override
  String schedCronDaily(String time) =>
      '每天 $time';
  @override
  String schedCronRange(String from, String to) =>
      '$from至周$to';
  @override
  String schedCronWeekly(String weekdays, String time) =>
      '每周$weekdays $time';
  @override
  String get schedCatWork => '工作 / 学习';
  @override
  String get schedCatPersonal => '陪伴 / 交流';
  @override
  String get schedCatLife => '生活习惯';
  @override
  String get schedCatRoutine => '周期计划';
  @override
  String get schedActionSelf => '自主工作';
  @override
  String get schedActionNotify => '提醒你';
  @override
  String get schedActionDraft => '存草稿';
  @override
  String get extSectionSkills => '技能';
  @override
  String get extSectionSkillsBlurb => '任务知识包：一份 SKILL.md 说明什么时候用它、怎么用';
  @override
  String get extSectionMcpBlurb => '外部工具服务：按需拉起一个可执行程序，工具都从内置的 mcp 工具走';
  @override
  String get extSectionTools => '内置工具';
  @override
  String get extSectionToolsBlurb => '随程序一起来的工具：按组开关，关掉即从她的清单里拿掉';
  @override
  String get extSectionHooksBlurb => '执行点钩子：PreToolUse / PostToolUse / Wake 三处可插入外部命令';
  @override
  String get extSectionPlugins => 'Plugins';
  @override
  String get extSectionPluginsBlurb => '按整包哈希审核 Skills、Hooks 与 MCP 贡献；人工启停在重启后生效';
  @override
  String get extPluginInstall => '安装插件';
  @override
  String get extPluginInstallTitle => '从本地目录安装插件';
  @override
  String get extPluginSourceDir => '插件目录（绝对路径）';
  @override
  String get extPluginSourceHint => r'例如 C:\packages\demo 或 /home/me/demo';
  @override
  String get extPluginAbsoluteRequired => '请输入绝对本地目录';
  @override
  String get extPluginEmpty => '还没有安装插件';
  @override
  String get extPluginEmptyHint => '先安装本地目录，再审核整包哈希与权限；安装本身不会信任或启用插件。';
  @override
  String extPluginSummary(int count) => '$count 个插件包';
  @override
  String extPluginStat(int count) => '$count 个插件包';
  @override
  String extPluginState(String state) => switch (state) {
        'untrusted' => '待审核',
        'disabled' => '已停用',
        'enabled' => '已启用',
        'invalid' => '无效',
        'quarantined' => '已隔离',
        'probing' => '正在探测',
        _ => state,
      };
  @override
  String get extPluginRestartRequired => '重启后生效';
  @override
  String extPluginContributions(int skills, int hooks, int mcp) => 'Skills $skills · Hooks $hooks · MCP $mcp';
  @override
  String extPluginVersionHash(String version, String hash) => '版本 $version · 哈希 $hash';
  @override
  String get extPluginPermissionsLabel => '权限';
  @override
  String get extPluginProblemsLabel => '问题';
  @override
  String get extPluginReview => '审核并信任';
  @override
  String extPluginReviewTitle(String id) => '审核插件 $id';
  @override
  String extPluginReviewBody(String id, String hash) =>
      '请核对 $id 的整包哈希 $hash、贡献与权限。插件贡献属于可信代码，不是安全沙箱；确认只绑定这一个哈希。';
  @override
  String get extPluginEnable => '启用';
  @override
  String get extPluginDisable => '停用';
  @override
  String extPluginEnableTitle(String id) => '启用插件 $id？';
  @override
  String extPluginDisableTitle(String id) => '停用插件 $id？';
  @override
  String get extPluginRestartBody => '人工启停只写入下一份生效状态，重启主进程后才接管；不会立即改变当前贡献。';
  @override
  String get extPluginInstalledToast => '已安装，等待审核；安装不代表已信任或启用';
  @override
  String extPluginConfirmedToast(String id) => '$id 的当前哈希已确认，仍需单独启用';
  @override
  String extPluginRestartToast(String action, String id) => '$id 已$action，重启后生效';
  @override
  String extPluginFailed(String reason) => '插件操作失败：$reason';
  @override
  String extPluginCircuit(String contribution, int count) => '故障贡献 $contribution · 连续失败 $count 次';
  @override
  String extPluginCircuitReason(String reason) => '故障原因：$reason';
  @override
  String extPluginRetryAt(String at) => '下次重试：$at';
  @override
  String get extBadResponse => '响应格式无法识别';
  @override
  String get extPageSubtitle => '技能、本地插件、MCP 服务、内置工具与执行点钩子';
  @override
  String get extListHeader => '扩展项';
  @override
  String get extDataReadFailed => '数据读取失败';
  @override
  String extBadStructure(Object? endpoint) =>
      '本地服务 /api/$endpoint 的响应不是预期结构。';
  @override
  String get extBackToList => '扩展项列表';
  @override
  String get extRescan => '扫描目录';
  @override
  String get extNewSkill => '新建技能';
  @override
  String extSkillsSummary(int active, int pending, int tokens) =>
      '$active 已生效 · $pending 待确认 · catalog $tokens token';
  @override
  String get extNoSkills => '还没有安装技能。';
  @override
  String get extNoSkillsHint => '技能是一个目录：skills/<name>/SKILL.md。扫描到之后要过信任门（在这里确认）才进 catalog。';
  @override
  String get extPendingTitle => '待确认';
  @override
  String get extPendingHint => '未经确认不会进入 catalog——描述写得再好，她这会儿也看不见它。';
  @override
  String get extActiveTitle => '已生效';
  @override
  String get extActiveHint => '已进 catalog：她每一轮都能看到这些名字与描述。';
  @override
  String get extActiveEmpty => '还没有已确认的技能——待确认的那些确认之后会出现在这里。';
  @override
  String get extIgnoredTitle => '已忽略';
  @override
  String get extIgnoredHint => '仅本机备忘（落 data/skills-ignored.json）：不写事件、不进 catalog，换台机器不会跟着走。';
  @override
  String get extRejectedTitle => '被拒绝的目录';
  @override
  String get extRejectedHint => 'frontmatter 非法或重名：这些目录她读不到，修好 SKILL.md 后重新扫描即可。';
  @override
  String extRejectedLine(Object? dir, Object? reason) =>
      '$dir：$reason';
  @override
  String get extGuideSkillPath => '技能就在 <项目根>/skills/<name>/SKILL.md：目录名即技能名（小写字母、数字、连字符）。';
  @override
  String get extGuideSkillTrust => '扫描之后要过信任门——只有你在这里点「确认」写下 skill/installed，它才进 catalog。';
  @override
  String get extInCatalogBadge => '已进 catalog';
  @override
  String get extFieldDescription => '描述';
  @override
  String get extFieldSkillFile => '技能文件';
  @override
  String get extFieldSizeHash => '体积与指纹';
  @override
  String extSizeHash(int bytes, String short) =>
      '$bytes 字节 · $short';
  @override
  String get extFieldTrustDetail => '信任详情';
  @override
  String get extActionRestore => '恢复：重新列回待确认';
  @override
  String get extActionRetire => '停用：从 catalog 里收起来（不改文件，随时可恢复）';
  @override
  String get extActionDelete => '删除：把技能目录整份移进回收站（可恢复，不是 rm -rf）';
  @override
  String get extActionConfirm => '确认：写入 skill/installed，技能进入 catalog';
  @override
  String get extActionIgnore => '忽略：收进「已忽略」，不写事件、不进 catalog';
  @override
  String extConfirmedToast(String name) =>
      '已确认：$name 已进入 catalog';
  @override
  String extConfirmFailed(String reason) =>
      '确认失败：$reason';
  @override
  String extIgnoredToast(String name) =>
      '已忽略：$name（仅本机备忘）';
  @override
  String extRestoredToast(String name) =>
      '已放回待确认：$name';
  @override
  String extOpFailed(String reason) =>
      '操作失败：$reason';
  @override
  String extRetireTitle(String name) =>
      '停用技能 · $name';
  @override
  String get extRetireBody => '停用 = 收进「已忽略」，她下一轮就不再看到它（catalog 里没有它）。技能文件一个字节都不动，想放回来点「恢复」即可。';
  @override
  String get extDisable => '停用';
  @override
  String extDeleteSkillTitle(String name) =>
      '删除技能 · $name';
  @override
  String get extDeleteBody => '整个目录会移进回收站（<dataDir>/trash/），「不是 rm -rf」：内容一个字节不改，把那一份移回原处就恢复。删掉之后她下一轮就看不到它了——只想让她暂时看不到，用「停用」。';
  @override
  String get extDelete => '删除';
  @override
  String extDeletedToast(String name) =>
      '已删除：$name 已移进回收站（内容未改，可移回恢复）';
  @override
  String extDeleteFailed(String reason) =>
      '删除失败：$reason';
  @override
  String get extCreateHint => '会在 skills/<名字>/SKILL.md 生成一份符合规范的骨架，然后停在待确认——确认之前她看不到它。名字只能用英文小写、数字与连字符（目录名即技能名）。';
  @override
  String get extFieldSkillName => '技能名';
  @override
  String get extSkillNameHint => '如 morning-review';
  @override
  String get extSkillNameInvalid => '只允许小写字母、数字与连字符';
  @override
  String get extFieldOneLineDesc => '一句话描述';
  @override
  String get extOneLineDescHint => '写清它做什么、什么时候该用它——这是她唯一能看到的触发条件';
  @override
  String extSkillCreatedToast(String path) =>
      "已生成 ${path.isEmpty ? 'SKILL.md' : path}，在「待确认」里等你的确认";
  @override
  String extCreateSkillFailed(String reason) =>
      '新建失败：$reason';
  @override
  String get extAddServer => '添加服务';
  @override
  String extMcpSummary(int servers, int running, int tools, String pendingPart) =>
      '$servers 个服务 · $running 已运行 · 工具 $tools 件$pendingPart';
  @override
  String extPendingGrants(int count) =>
      '待批：她递来的申请单（$count）';
  @override
  String extUnpreparedGrants(int count) =>
      '还没有进入待批（$count）';
  @override
  String get extUnpreparedTitle => '这些申请单还没被框架拾取';
  @override
  String get extUnpreparedHint => '框架每一拍扫一次申请单目录。刚写完的等下一拍；一直停在这里的多半是没通过校验——那一拍会落一条结局（驳回理由在「已答复」那一段里），文件本身不会被删。';
  @override
  String get extConfigProblems => '配置问题';
  @override
  String get extConfigProblemsHint => '已声明但读不出来：修好 config.json 的 mcp.servers 后重新加载。';
  @override
  String get extAnsweredTitle => '已答复的申请单';
  @override
  String get extAnsweredHint => '她递过的单子与它们的结局。批准之后由框架写 config.json；"批准了但没装成"会如实写在这一行里（那与"被驳回"是两件事）。';
  @override
  String get extGuideMcp1 => '一个 MCP 服务就是一个可执行程序：主进程按需拉起它、空闲 5 分钟回收，所以"没在跑"是常态。';
  @override
  String get extGuideMcp2 => '工具默认不信任（sideEffect = destructive）：要在 config.json 里为它显式声明才降级，配置改完要重启主进程才接管。';
  @override
  String get extGuideMcp3 => '她可以自己发起增删（写一份申请单，见上面「待批」那一段）——你在这里点批准或驳回即可。';
  @override
  String extGrantRejectedToast(String suffix) =>
      '已驳回$suffix——她下一拍会收到这条决定';
  @override
  String extGrantApprovedToast(String suffix) =>
      '已批准并写进配置$suffix';
  @override
  String extGrantApprovedFailedToast(String failure) =>
      '已批准，但执行没成功：$failure';
  @override
  String extGrantDecideFailed(String reason) =>
      '没能记下这个决定：$reason';
  @override
  String get extGrantAfterSkillInstall =>
      '批准之后装进技能根 skills/<名字>；不会自动执行，要她读才会读';
  @override
  String get extGrantAfterSkillRemove => '批准之后整目录移进回收站（data/trash/），可移回';
  @override
  String get extGrantExecOkSkillInstall => '框架已装进技能根';
  @override
  String get extGrantExecOkSkillRemove => '已移进回收站';
  @override
  String get extGrantLabelSkillInstall => '装';
  @override
  String grantInboxActionMcpAdd(String name) => '加一个 MCP 服务：$name';
  @override
  String grantInboxActionMcpRemove(String name) => '删掉 MCP 服务：$name';
  @override
  String grantInboxActionSkillInstall(String name) => '装一个技能：$name';
  @override
  String grantInboxActionSkillRemove(String name) => '删掉技能：$name';
  @override
  String grantInboxActionUnknown(String name) => '她递了一张申请单：$name';
  @override
  String grantInboxCommand(String command) => '命令：$command';
  @override
  String grantInboxRiskSkillScripts(int count) => '带 $count 个可执行脚本；不会自动执行，批准只把它装进技能根。';
  @override
  String get grantInboxRiskSkillInstall => '不会自动执行：批准只是把它装进技能根（skills/），她读的时候才用到。';
  @override
  String get grantInboxRiskSkillRemove => '整目录移进回收站（data/trash/），可移回。';
  @override
  String get grantInboxRiskMcpAdd => '批准后写进配置（config.json 的 mcp.servers[]），它会拉起一个本机进程。';
  @override
  String get grantInboxRiskMcpRemove => '从配置里删掉这一条（config.json 的 mcp.servers[]）。';
  @override
  String get grantInboxRiskUnknown => '这张单子要做什么，只有详情里说得清。';
  @override
  String get grantInboxSource => '这份单子是她自己写的';
  @override
  String get grantInboxHighRiskBadge => '高风险';
  @override
  String get grantInboxApprove => '批准';
  @override
  String get grantInboxApproveHighRisk => '查看并批准';
  @override
  String get grantInboxReject => '驳回';
  @override
  String get grantInboxDetails => '详情';
  @override
  String get grantInboxWorking => '处理中…';
  @override
  String get grantInboxCollapseTooltip => '收起（待批还在，点一下再展开）';
  @override
  String get grantInboxExpandTooltip => '展开待批卡（批准、驳回都在这上面）';
  @override
  String get grantInboxOpenExtensions => '打开扩展页';
  @override
  String get grantInboxDetailsClose => '关掉详情';
  @override
  String grantInboxHeader(int count) => '待批 · $count 条';
  @override
  String grantInboxMore(int count) => '还有 $count 条待批';
  @override
  String grantInboxCollapsed(int count) => '$count 条待批';
  @override
  String grantInboxFailed(String reason) => '没记下这个决定：$reason';
  @override
  String get grantUnreadableTitle => '有一张申请单读不出来';
  @override
  String grantUnreadableBody(String id, String why) => '$id：$why';
  @override
  String grantUnreadableMore(int count) => '（还有 $count 张）';
  @override
  String trayPendingItem(int count) => '有 $count 条待批';
  @override
  String trayPendingTooltip(String name, int count) => '$name · 有 $count 条待批';
  @override
  String get extNoServers => '还没有配置 MCP 服务。点页头那枚按钮加一个，填一段启动命令即可。';
  @override
  String get extNoServersHint1 => '一个服务就是一个可执行程序：主进程按需拉起、空闲 5 分钟回收，所以「没在跑」是常态。';
  @override
  String get extNoServersHint2 => '它的工具默认按 destructive 处理，在 config.json 里显式声明才降级；改完要重启主进程才接管。';
  @override
  String get extDisabledBadge => '已停用';
  @override
  String extToolCountBadge(int count) =>
      '$count 件工具';
  @override
  String get extCollapseServer => '折叠这个服务';
  @override
  String get extExpandServer => '展开这个服务';
  @override
  String get extNoDesc => '（没写它做什么——她在索引里只看到这个名字）';
  @override
  String extSelfReportedDesc(String desc) =>
      '$desc（它自报的）';
  @override
  String get extFieldCommand => '启动命令';
  @override
  String get extFieldEnv => '环境变量';
  @override
  String extLastRun(String at, String suffix) =>
      '最近一次运行记录：$at$suffix';
  @override
  String extPidLine(Object? pid) =>
      '日志里的 pid：$pid';
  @override
  String get extStartingProcess => '正在拉起进程…';
  @override
  String get extTestConnection => '测试连接';
  @override
  String get extEditServerTooltip => '编辑这个服务';
  @override
  String get extDeleteServerTooltip => '删除这个服务';
  @override
  String get extNoToolDesc => '（这个服务没给描述）';
  @override
  String extToolsAllListed(int count) =>
      '清单是完整的：$count 件全在上面。';
  @override
  String get extNoChange => '配置本来就是这样，没有改动';
  @override
  String get extTakeEffectNow => '已生效，不用重启';
  @override
  String get extNeedsRestart => '需要重启主进程才生效';
  @override
  String extMcpToggledToast(String name, String action, String outcome) =>
      '$name 已$action：$outcome';
  @override
  String extToggleFailed(String reason) =>
      '切换失败：$reason';
  @override
  String get extEditMcpTitle => '编辑 MCP 服务';
  @override
  String get extAddMcpTitle => '添加 MCP 服务';
  @override
  String get extMcpFormLead => '一个服务 = 一段启动命令。保存写进 config.json 的 mcp.servers[]，写完即生效：调用走内置的 mcp 工具（它按需拉起这个服务，默认空闲 5 分钟回收）。';
  @override
  String get extFieldServerName => '服务名';
  @override
  String get extServerNameHint => '给这个服务起的名字，调用时用得到（只允许字母、数字、- 与 _，如 filesystem）';
  @override
  String get extCommandHint => '要拉起的程序：uvx … 或 node D:\\…\\cli.js（绝对路径 .exe 也行）。启动器须在白名单里（node、uvx、python），不许内联执行；npx 在 Windows 上起不来';
  @override
  String get extFieldDesc => 'desc（它是干什么的）';
  @override
  String get extDescHint => '一句话：这个服务是干什么的、你打算用它做什么（例如：读本机浏览器历史与当前标签页）';
  @override
  String get extDescNote => '这一句会进她的常驻索引（一个服务一行）。留空也能保存——那样她在索引里只看到名字。';
  @override
  String get extFieldArgs => 'args（一行一个）';
  @override
  String get extArgsHint => '每个参数占一行：-y 一行、包名一行';
  @override
  String get extFieldEnvForm => 'env（一行一个 KEY=VALUE）';
  @override
  String get extEnvHint => '可选：这几行之外，它还会继承主进程的环境变量';
  @override
  String get extFieldTestTimeout => '测试连接超时（毫秒）';
  @override
  String get extTestTimeoutHint => '首次拉包可能要 30s 以上；只影响这个对话框里的「测试连接」（500–60000），不写进配置';
  @override
  String get extEnableSwitchLabel => '启用这个服务（关掉 = 配置留着但不起进程，调用也不会拉起它）';
  @override
  String get extNameAndCommandRequired => '服务名与 command 都得填';
  @override
  String extSaveFailed(String reason) =>
      '保存失败：$reason';
  @override
  String extMcpSavedToast(String saved, String outcome, String note) =>
      '$saved：$outcome$note';
  @override
  String get extFillCommandFirst => '先填 command 再测';
  @override
  String extTestFailed(String reason) =>
      '测试失败：$reason';
  @override
  String get extConnectOk => '连接成功';
  @override
  String get extConnectFailed => '连接失败';
  @override
  String extProbeOk(Object? name, Object? ms) =>
      '$name 起来了、握手通过、工具清单取回来了（${ms}ms）。';
  @override
  String get extProbeNoTools => '它声明了 tools 能力但清单是空的：这个服务当前不提供工具。';
  @override
  String extProtocolLine(String version, String peer) =>
      '协议版本 $version$peer';
  @override
  String extProbeShutdown(String stages) =>
      '进程已收掉（$stages）——不留后台进程。';
  @override
  String get extUnknownReason => '未知原因';
  @override
  String extStderrTail(Object? tail) =>
      '它的 stderr 尾部：$tail';
  @override
  String get extGotIt => '知道了';
  @override
  String extDeleteServerTitle(String name) =>
      '删除 MCP 服务 · $name';
  @override
  String get extDeleteServerBody => '从 config.json 的 mcp.servers[] 里删掉这一条。她的 mcp 工具里不再有这个服务。程序本体不会被卸载。';
  @override
  String extServerDeletedToast(String name, String outcome) =>
      '已删除 $name：$outcome';
  @override
  String get extNoToolRegistry => '还没有工具注册表。';
  @override
  String get extNoToolRegistryHint => '注册表由运行期装配；本进程读到空清单时不会有条目。MCP 服务的工具不在这个清单里：走内置的 mcp 工具按需看。';
  @override
  String get extRefresh => '刷新';
  @override
  String extToolsSummary(Object? enabled, int total, Object? policy) =>
      '$enabled 件启用 / 共 $total 件 · destructive：$policy';
  @override
  String get extToolsHint1 => '关掉一件工具不改变能力边界，只是把它的名字从她的清单里拿掉——她下一轮就看不见它了。';
  @override
  String get extToolsHint2 => 'destructive 类工具本身还有一道独立的开关（tools.destructiveEnabled），这里关不掉那一道。';
  @override
  String extGroupSummary(int on, int total, String note) =>
      '$on / $total 件启用$note';
  @override
  String get extEnableAll => '全开';
  @override
  String get extDisableAll => '全关';
  @override
  String get extOffBadge => '已关闭';
  @override
  String get extFieldMode => '并发模式';
  @override
  String get extFieldTimeout => '超时';
  @override
  String get extToggleOffMessage => '关闭：从她的工具清单里拿掉';
  @override
  String get extToggleOnMessage => '开启：放回她的工具清单';
  @override
  String extToolFailureLine(String name, String reason) =>
      '$name：$reason';
  @override
  String extAllToggledToast(String state, int count) =>
      '$state（$count 件）';
  @override
  String extSomeFailedToast(int count, String first) =>
      '有 $count 件没改成：$first';
  @override
  String extRequiredParam(Object? name) =>
      '$name（必填）';
  @override
  String get extAddHook => '添加钩子';
  @override
  String extHookBoundaryNote(String relative) =>
      '$relative 定义的是「谁能改我」：agent 对它只读（写入口被路径守卫拒绝），只有你在这里能改。这类操作都要求确认短语，改完要重启主进程才装配。';
  @override
  String extHooksSummary(int enabled, int total) =>
      '$enabled 条生效 / 共 $total 条';
  @override
  String get extHooksTitle => '钩子条目';
  @override
  String get extHooksHint => '按文件顺序执行；一条钩子的超时不会阻塞主流程（超时即杀、输出丢弃）。';
  @override
  String get extHooksEmpty => '还没有配置钩子。点页头那枚按钮加一条：钩子可以拒绝工具调用，也可以改写参数。';
  @override
  String get extInvalidEntries => '无效条目';
  @override
  String get extInvalidEntriesHint => '无效条目不影响其余配置生效，但需要修掉——它现在一条都不会跑。';
  @override
  String get extHookBoundary1 => '这条线画在"谁能改我"上：钩子能拒绝工具调用、能改写参数，所以 agent 永远改不了这份文件。';
  @override
  String get extHookBoundary2 => '从界面写它要带确认短语（X-Confirm: hook-save / hook-remove），写完重启主进程才装配。';
  @override
  String get extFieldEvent => '事件';
  @override
  String get extFieldCondition => '触发条件';
  @override
  String get extHookToggleOffMessage => '停用：保留命令行，但不装配它';
  @override
  String get extHookToggleOnMessage => '启用：重启后装配它';
  @override
  String get extEditHookTooltip => '编辑这条钩子';
  @override
  String get extDeleteHookTooltip => '删除这条钩子';
  @override
  String extHookToggledToast(String state) =>
      '已$state这条钩子——重启主进程后装配';
  @override
  String get extEditHookTitle => '编辑钩子';
  @override
  String get extHookDialogNote => '钩子会在执行点上跑一条外部命令：stdin 收一段 JSON 上下文，退出码 2 = 拒绝（唯一强制通道），其他非零码不阻塞主流程。这份配置对 agent 只读。';
  @override
  String get extFieldExecutionPoint => '执行点';
  @override
  String get extFieldMatcher => 'matcher（正则）';
  @override
  String get extWakeMatcherHint => '对唤醒来源匹配：timer|file|webhook|manual|heartbeat';
  @override
  String get extToolMatcherHint => '对工具名匹配：safe_edit|safe_write';
  @override
  String get extFieldShellCommand => 'command（交给系统 shell）';
  @override
  String get extShellCommandHint => '如 node scripts/check.mjs';
  @override
  String get extFieldConditionOptional => '触发条件（可选）';
  @override
  String get extConditionHint => '如 pwsh(rm *)，不匹配就不起进程';
  @override
  String get extFieldTimeoutMs => '超时（毫秒）';
  @override
  String get extTimeoutHint => '超时即杀并丢弃输出，不阻塞主流程';
  @override
  String get extEnableHookSwitch => '启用（关掉 = 留在文件里但不装配）';
  @override
  String get extMatcherAndCommandRequired => 'matcher 与 command 都得填';
  @override
  String get extHookSavedToast => '已写入 data/hooks.json——重启主进程后装配';
  @override
  String extDeleteHookBody(int index) =>
      '从 data/hooks.json 里删掉第 $index 条。删掉之后它就不再参与任何执行点——想临时收起来用「停用」即可，不必删。';
  @override
  String get extHookDeletedToast => '已删除——重启主进程后生效';
  @override
  String get extStatusUnknown => '状态未知';
  @override
  String get extReading => '读取中…';
  @override
  String extStatSkills(int active, int pending) =>
      '$active 已生效 · $pending 待确认';
  @override
  String extStatMcp(int servers, int running) =>
      '$servers 个服务 · $running 已运行';
  @override
  String extStatTools(int on, int total) =>
      '$on 件启用 / 共 $total';
  @override
  String extStatHooks(int total, String suffix) =>
      '$total 条$suffix';
  @override
  String extPendingPart(int count) =>
      ' · 待批 $count';
  @override
  String get extNoReasonGiven => '（没有写理由）';
  @override
  String get extRestartSuffix => '；这份改动要重启主进程才生效';
  @override
  String get extServerNoReason => '（服务端没有给原因）';
  @override
  String extReasonParen(String reason) =>
      '（$reason）';
  @override
  String get extEnabledWord => '启用';
  @override
  String extSavedWho(String who) =>
      '已保存$who';
  @override
  String extSavedWhoDisabled(String who) =>
      '已保存$who（停用状态）';
  @override
  String extIndentedNote(String descNote) =>
      '　$descNote';
  @override
  String extPeerVersion(Object? name, Object? version) =>
      ' · 对面自称 $name $version';
  @override
  String get extAllOnWord => '已全开';
  @override
  String get extAllOffWord => '已全关';
  @override
  String extEnabledPart(int on) =>
      ' · $on 条生效';
  @override
  String get extDisabledWord => '停用';

  // ── 更新检查（2026-10-22）──

  @override
  String updateBannerAvailable(String latest, String current) =>
      '${updateNewVersionTitle(latest, current)} · $updateView';
  @override
  String updateBannerRequired(String latest, String current) =>
      '${updateNewVersionTitle(latest, current)} · $updateRequiredNotice';
  @override
  String get updateView => '查看';
  @override
  String get updateDismiss => '关闭这条提示';
  @override
  String get updateSectionTitle => '更新';
  @override
  String get updateSectionNote =>
      '只 GET 一个静态 JSON（不带任何标识），不下载、不安装。'
      '启动 60 秒后查一次，之后每 12 小时一次（连续失败 3 次后改为 24 小时）。';
  @override
  String get updateCheckNow => '立即检查';
  @override
  String get updateChecking => '正在检查…';
  @override
  String get updateUpToDate => '已是最新版本';
  @override
  String get updateDisabled => '更新检查已在配置里关闭（update.enabled = false）';
  @override
  String get updateNeverChecked => '还没检查过';
  @override
  String get updateNoPage => '这一版没有可打开的页面';
  @override
  String updateCurrentVersion(String version) => '当前版本：v$version';
  @override
  String updateLatestVersion(String version) => '最新版本：v$version';
  @override
  String updateAvailableText(String latest) => '有新版本 v$latest';
  @override
  String updateRequiredText(String minimum) => '低于最低可用版本（v$minimum），请先升级';
  @override
  String updateUnknownText(String reason) => '这次没查到（$reason）';
  @override
  String updateLastChecked(String time) => '上次检查：$time';
  @override
  String updateNextAllowed(String time) => '下次允许检查：$time';
  @override
  String updateChannelLabel(String channel) => '通道：$channel';
  @override
  String updateCheckFailed(String reason) => '检查更新失败：$reason';
  @override
  String updateReasonText(String reason) => switch (reason) {
        'up-to-date' => '已是最新',
        'older-than-current' => '站点上的版本比当前旧',
        'channel-mismatch' => '通道不一致',
        'prerelease' => 'stable 通道不把预发布当更新',
        'pending' => '站点还没发完（_pending）',
        'newer' => '有新版本',
        'below-minimum' => '低于最低可用版本',
        'network' => '网络不通',
        'timeout' => '超时',
        'bad-json' => '返回的不是合法 JSON',
        'bad-shape' => '返回内容不符合约定',
        'too-large' => '返回内容过大',
        'bad-endpoint' => '端点地址不可用',
        'bad-current-version' => '当前版本号无法解析',
        'never-checked' => '还没查过',
        _ when reason.startsWith('http-') => 'HTTP ${reason.substring(5)}',
        _ => reason.isEmpty ? '未知原因' : reason,
      };
  @override
  String trayUpdateItem(String latest) => '有新版本 v$latest · 查看';
  @override
  String trayUpdateRequiredItem(String latest) => '有新版本 v$latest · 请升级';
  @override
  String trayUpdateTooltip(String name, String latest) => '$name · 有新版本 v$latest';
  @override
  String trayUpdateRequiredTooltip(String name, String latest) => '$name · 需要升级到 v$latest';

  // ── 更新检查：三处共用的那几句 ──

  @override
  String updateNewVersionTitle(String latest, String current) => '有新版本 v$latest（当前 v$current）';
  @override
  String get updateRequiredNotice => '低于最低可用版本，请先升级';
  @override
  String get updateChannelMismatchText => '站点上没有这条通道的版本（通道不匹配）';
  @override
  String get updateDownloadTitle => '下载';
  @override
  String get updateDownloadNote => '只打开链接，不自动下载、不静默安装。';
  @override
  String get updateGitHubDownload => 'GitHub 下载';
  @override
  String get updateNetdiskDownload => '网盘下载';
  @override
  String get updateNetdiskSoon => '即将开放';
  @override
  String get updateBaiduDownload => '百度网盘下载';
  @override
  String get updateQuarkDownload => '夸克网盘下载';
  @override
  String get updatePendingUpload => '待上传';
  @override
  String updateExtractCode(String code) => '提取码：$code';
  @override
  String get updateCopyCode => '复制提取码';
  @override
  String get updateCopied => '已复制';
  @override
  String get updateReleasePage => '官方发布页';
  @override
  String updatePlatformLine(String os, String arch, String kind) => '$os $arch · ${updateKindLabel(kind)}';
  @override
  String updateKindLabel(String kind) => switch (kind) {
        'installer' => '安装包',
        'portable' => '便携版',
        'update' => '更新包',
        _ => kind,
      };
  @override
  String get updateChannelSwitchNote => '切换会清掉 12/24 小时的节流，并立刻查一次。';
  @override
  String updateSwitched(String channel) => '已切到 $channel 通道并立刻检查';
  @override
  String updateSwitchFailed(String reason) => '切换通道失败：$reason';
}

/// English。
///
/// 口径：**短、动词开头、不过度礼貌**——和中文那份同一个语气。按钮用 Title Case
/// （Material 桌面端的惯例），说明文字用句子。专有名词不译：`Irmia`、`OneBot`、
/// `MCP`、`QQ`、`token`。
class EnStrings extends AppStrings {
  const EnStrings();

  @override
  AppLanguage get language => AppLanguage.en;

  @override
  String get retry => 'Retry';
  @override
  String get cancel => 'Cancel';
  @override
  String get confirm => 'Confirm';
  @override
  String get save => 'Save';
  @override
  String get loading => 'Loading…';
  @override
  String get error => 'Something went wrong';
  @override
  String get empty => 'Nothing here';
  @override
  String get collapse => 'Collapse';
  @override
  String expandAll(int chars) => 'Show all ($chars chars)';
  @override
  String loadFailed(String reason) => 'Failed to load: $reason';
  @override
  String get settingsLoadingConfig => 'Loading config…';
  @override
  String configReadFailed(String reason) => 'Failed to read config: $reason';
  @override
  String requestWaiting(String request, int seconds) => 'Waiting on $request ($seconds s)';
  @override
  String requestTimeout(String request, int seconds, bool maybeDone) => maybeDone
      ? '$request got no answer for $seconds s. This action may already have taken effect — '
          'check that page first, then decide whether to retry.'
      : '$request got no answer for $seconds s. This one did not come back — press Retry.';
  @override
  String requestStreamStalled(int seconds) =>
      'The event stream has been silent for $seconds s; treating it as disconnected '
      '(reconnecting, and events sent meanwhile are replayed).';

  @override
  String get navChat => 'Chat';
  @override
  String get navSettings => 'Settings';
  @override
  String get navOverview => 'Overview';
  @override
  String get navChannels => 'Channels';
  @override
  String get navExtensions => 'Extensions';
  @override
  String get navPersona => 'Persona';
  @override
  String get navSchedule => 'Schedule';
  @override
  String get navMemory => 'Memory';
  @override
  String get navLogs => 'Logs';
  @override
  String get navMore => 'More';

  // ── Overview / restart / tray ──
  @override
  String get overviewConfigGuide => 'Setup guide';
  @override
  String restartConfirmed(String evidence) => 'Restart confirmed: $evidence';
  @override
  String restartEvidence(int backendPid, bool portReady) {
    final parts = <String>[
      if (backendPid > 0) 'new pid $backendPid',
      if (portReady) 'port ready',
    ];
    return parts.isEmpty ? 'the server gave no evidence (no pid, no port)' : parts.join(' · ');
  }

  @override
  String get restartSentWithGui =>
      'Restart dispatched: both the UI and the backend will restart — the window closes first, '
      'wait for it to come back (about 1–2 minutes on this machine)';
  @override
  String get restartSentBackendOnly =>
      'Restart dispatched: the backend comes back in about 20–90 seconds '
      '(the UI is not part of this action; it only reconnects)';
  @override
  String restartFailed(String reason) => 'Restart failed: $reason';
  @override
  String restartRefused(String reason) => 'Restart was not dispatched: $reason';
  @override
  String restartNoReceipt(String reason) =>
      'The restart request was dispatched, but no receipt came back ($reason). '
      'Do not press it again just yet: the machine may already be restarting, and the UI will '
      'reconnect on its own and tell you how it went.';
  @override
  String get restartNoConclusion => 'Restart dispatched, but the server returned no verdict';
  @override
  String get restartBackReady => 'Ready: the backend is back';
  @override
  String restartBackTimeout(int seconds) =>
      'The backend has not come back (waited $seconds s): check data/restart-trace.log';
  @override
  String get restartNeverWentDown =>
      'The backend never went offline: this request probably had no effect';

  @override
  String get trayShow => 'Show window';
  @override
  String get trayHide => 'Hide to tray';
  @override
  String get trayRestart => 'Restart backend + UI';
  @override
  String get trayQuitUi => 'Quit UI (she keeps running)';
  @override
  String get trayQuitAll => 'Quit everything (UI + backend)';
  @override
  String get quitAllConfirmTitle => 'Quit everything?';
  @override
  String quitAllConfirmBody(bool busy) =>
      'This ends the backend as well (including the protocol side it started), '
      'then closes this window.\n'
      '${busy ? 'She is in the middle of a turn: that turn will be interrupted and settled '
          'by the recovery flow on the next start.\n' : ''}'
      'Windows has no externally reachable graceful shutdown, so this is a hard kill: '
      'you may have to log the protocol side in again in its WebUI.\n'
      'To close only the UI (she keeps running in the background), use "Quit UI" in the tray.';
  @override
  String get quitAllConfirmLabel => 'Quit everything';
  @override
  String get quitAllWorking => 'Stopping the backend…';
  @override
  String quitAllFailed(String reason) =>
      'The backend did not stop: $reason (the UI was left open so you are not misled)';
  @override
  String get quitAllDone => 'Quit everything: the UI and the backend are both gone';

  @override
  String get onboardingManualSaved => 'Guide finished; the steps you changed were saved';
  @override
  String get onboardingManualNoChanges =>
      'Just had a look: nothing was changed and nothing was written';
  @override
  String get onboardingManualOpenBadge => 'Opened manually · not part of the first-run check';

  // ── First-run guide (six-step card) ──
  @override
  String get onboardingStepNameTitle => 'Her name';
  @override
  String get onboardingStepNameNote =>
      "The name is her identity; the word list below decides which words count as calling her in a group "
      '(no @ needed).';
  @override
  String get onboardingStepNameHint =>
      'Written into the "名字：" line of persona/IDENTITY.md (the old version is snapshotted, roll it back on '
      'the Persona page); the display name is read from there.';
  @override
  String get onboardingKeywordsHint =>
      'Separate with commas; any of these words in a message counts as calling her (same path as the @); '
      'typing a name fills one in, clearing it means @ only.';
  @override
  String get onboardingStepApiTitle => 'API';
  @override
  String get onboardingStepApiNote =>
      'Which model she uses. Written to config.json and data/.keys.json; takes effect after a restart.';
  @override
  String get onboardingStepChannelTitle => 'Message adapter';
  @override
  String get onboardingStepChannelNote =>
      'Where she receives messages. The QQ Official Bot AppID and AppSecret are filled in below.';
  @override
  String get onboardingStepPersonaTitle => 'Persona';
  @override
  String get onboardingStepPersonaNote =>
      'Who she is. This text is written to persona/IDENTITY.md and stays her permanent persona.';
  @override
  String get onboardingStepTrustTitle => 'Trust scope';
  @override
  String get onboardingStepTrustNote =>
      'How far she can reach: the whole machine, or a single working directory. '
      'Pick one; full trust is the default.';
  @override
  String get onboardingApiRecommendLead => 'We recommend using ';
  @override
  String get onboardingApiRecommendModel => "DeepSeek's models";
  @override
  String get onboardingApiRecommendJoin => ', ';
  @override
  String get onboardingApiRegisterKey => 'Sign up and get an API key';
  @override
  String get onboardingChannelRecommendLead => 'We recommend the ';
  @override
  String get onboardingChannelRecommendQq => 'QQ Official Bot';
  @override
  String get onboardingChannelRecommendTail => ' as the message adapter';
  @override
  String get onboardingQqTileDetail =>
      'The official open-platform channel: create it by scanning, or fill in the AppID / AppSecret below '
      '(write-only).';
  @override
  String get onboardingQqCredentialsTitle =>
      'QQ Official Bot credentials (stored in data/.keys.json, never in config.json)';
  @override
  String get onboardingQqAppIdLabel => 'AppID';
  @override
  String get onboardingQqAppIdHint => 'The bot ID from the open-platform console.';
  @override
  String get onboardingQqAppSecretLabel => 'AppSecret';
  @override
  String get onboardingQqAppSecretHint => 'The secret used to fetch an access_token.';
  @override
  String onboardingSecretConfigured(String? mask) => mask == null || mask.isEmpty
      ? 'Configured; paste a new value to overwrite'
      : 'Configured ($mask); paste a new value to overwrite';
  @override
  String get onboardingQqCredentialsNote =>
      'Filling in both enables the QQ Official Bot automatically; you can also skip this and add them '
      'later on the Channels page.';
  @override
  String get onboardingQqEntryScan => 'Scan to create (recommended)';
  @override
  String get onboardingQqEntryManual => 'Enter credentials';
  @override
  String get onboardingQqBindIntro =>
      'Scan with mobile QQ: it creates the official bot and stores the AppID / AppSecret on this machine.';
  @override
  String get onboardingQqBindStart => 'Scan to create';
  @override
  String get onboardingQqBindStarting => 'Requesting a QR code from QQ…';
  @override
  String get onboardingQqBindWaitScan => 'Scan the QR code in the browser with mobile QQ.';
  @override
  String get onboardingQqBindWaiting => 'Waiting for the scan… (checking every 2 seconds; you can cancel)';
  @override
  String get onboardingQqBindSuccess => 'Bound successfully';
  @override
  String get onboardingQqBindSavedNote =>
      'The AppID and AppSecret are saved and enabled (written to data/.keys.json; the channel configuration '
      'takes effect after a restart).';
  @override
  String get onboardingQqBindRegenerate => 'The QR code expired — generate a new one';
  @override
  String get onboardingQqBindTestConnection => 'Test connection';
  @override
  String get onboardingQqBindTokenTesting => 'Testing the connection…';
  @override
  String onboardingQqBindAppId(String appId) => 'AppID: $appId';
  @override
  String onboardingQqBindTokenOk(int expiresIn) =>
      'Connection test passed: access_token obtained (valid for $expiresIn s).';
  @override
  String onboardingQqBindTokenFailed(String reason) => 'Connection test failed: $reason';
  @override
  String onboardingQqBindStartFailed(String reason) => 'Could not start the QR binding: $reason';
  @override
  String onboardingQqBindStatusFailed(String reason) => 'Could not read the QR status: $reason';
  @override
  String get onboardingOnebotDetail => 'You can configure it separately after setup.';
  // 英文那份里那个 `名字：` 是 IDENTITY.md 里**真的那一行**（数据，不是界面词），不能翻。
  @override
  String get onboardingPersonaHint =>
      'Whatever you write replaces the whole file (the server keeps a snapshot; roll back on the Persona page); '
      'keep the leading "名字：" line, and an empty or unchanged draft writes nothing.';
  @override
  String get onboardingTrustNoteSame =>
      'This is a boundary, not a reminder: out-of-scope reads, writes and commands are refused (fs and pwsh '
      'both honour it). Identical to what is on disk, so this screen writes nothing; change it later on the '
      'Settings page under Trust scope.';
  @override
  String get onboardingTrustNoteChanged =>
      'This is a boundary, not a reminder: out-of-scope reads, writes and commands are refused (fs and pwsh '
      'both honour it). Pressing Done writes config.json; it takes over after a restart. Change it later on '
      'the Settings page under Trust scope.';
  @override
  String get onboardingStepDepsTitle => 'External dependencies';
  @override
  String get onboardingStepDepsNote =>
      'Without them some tools do not work: the pwsh tools, rg for grep, es for find, and the python lane.';
  @override
  String get onboardingDepsInstallLabel => 'Download and install these external dependencies';
  @override
  String get onboardingDepsAllReady => 'All four are already in place; just press Done.';
  @override
  String get onboardingDepsStatusReady => 'ready';
  @override
  String get onboardingDepsStatusMissing => 'missing';
  @override
  String get onboardingDepsItemRunning => 'installing…';
  @override
  String get onboardingDepsItemOk => 'done';
  @override
  String onboardingDepsItemFailed(String reason) => 'failed: $reason';
  @override
  String onboardingDepsSummary(int ok, int failed) => 'Done $ok / failed $failed';
  @override
  String get onboardingDepsRetry => 'Retry';
  @override
  String onboardingDepsLastRun(int ok, int failed) => 'Last run: done $ok / failed $failed';
  @override
  String onboardingDepsReadFailed(String reason) => 'Could not read the dependency status: $reason';
  @override
  String get onboardingDepsUnavailable =>
      'This backend has no dependency manager wired in, so nothing can be installed; just press Done.';
  @override
  String get onboardingRestartTitle => 'Restart needed';
  @override
  String get onboardingRestartBody => 'The dependencies are installed; restart the UI for them to take effect.';
  @override
  String get onboardingRestartNow => 'Restart now';
  @override
  String get onboardingRestartLater => 'Later';
  @override
  String onboardingOpenLinkFailed(String url) => 'Could not open a browser; the address is $url';
  @override
  String onboardingChannelSaveFailed(String reason) => 'The channel switch was not saved: $reason';
  @override
  String onboardingSecretsSaveFailed(String reason) =>
      'The AppID / AppSecret were not saved: $reason';
  @override
  String onboardingApiKeyWritten(String gates) => 'Key written to $gates';
  @override
  String onboardingApiKeyHintWritten(String gates) =>
      'Written to $gates; paste a new key to replace it';
  @override
  String onboardingApiKeyHintPartial(String have, String missing) =>
      'Only $have has a key; pasting a new one also writes $missing';
  @override
  String onboardingApiKeySaveFailed(String gates, String reason) =>
      'Nothing was written to $gates (the key file is written atomically, so no slot changed): $reason';
  @override
  String onboardingApiKeyNoSlot(String routes, String envNames) =>
      '$routes has no key slot of its own (data/.keys.json only knows heavy / light): '
      'set the $envNames environment variable for it';

  // ── Step 2: model probe / protocol / key status (2026-10-26) ─────────

  @override
  String get onboardingModelLabel => 'Model';
  @override
  String get onboardingModelRequired => 'The model name cannot be empty; nothing was saved';
  @override
  String get onboardingBaseUrlLabel => 'Base URL';
  @override
  String get onboardingBaseUrlRequired => 'The Base URL cannot be empty; nothing was saved';
  @override
  String get onboardingBaseUrlNote => 'API root URL, without the /responses suffix.';
  @override
  String get onboardingApiKeyLabel => 'API key';
  @override
  String get onboardingApiKeyStatusMissing => 'Not configured';
  @override
  String onboardingApiKeyStatusWritten(String gates) => 'Written to $gates';
  @override
  String onboardingApiKeyStatusPartial(String have) => 'Only written to $have';
  @override
  String get onboardingProbeButton => 'Probe';
  @override
  String get onboardingProbeRunning => 'Probing…';
  @override
  String get onboardingProbeBaseRequired => 'Fill in the Base URL first';
  @override
  String onboardingProbeDone({
    required int count,
    required bool responsesOk,
    required int? responsesMs,
    required bool chatOk,
    required int? chatMs,
    String? recommended,
  }) {
    String segment(String name, bool ok, int? ms) =>
        '$name ${ms == null ? '—' : '${ms}ms'} ${ok ? '✓' : '✗'}';
    final tail = recommended == null ? '' : ' · recommended $recommended';
    return 'Probe complete: $count models · ${segment('Responses', responsesOk, responsesMs)}'
        ' · ${segment('Chat', chatOk, chatMs)}$tail';
  }

  @override
  String get onboardingProbeSearchHint => 'Search models…';
  @override
  String get onboardingProbeNoMatch => 'No matching models';
  @override
  String get onboardingProbeEmptyList => 'This endpoint returned no models; type the model name manually.';
  @override
  String onboardingProbeBadge(String protocol, bool supported) => '$protocol ${supported ? '✓' : '✗'}';
  @override
  String get onboardingProbeUnreachable =>
      'Probe failed: cannot reach this endpoint (network unreachable or timed out). You can still type the model name manually.';
  @override
  String get onboardingProbeUnauthorized =>
      'Probe failed: the key was rejected (401/403). Check the API key and retry, or type the model name manually.';
  @override
  String get onboardingProbeNoModels =>
      'Probe failed: this endpoint has no /models, so the model name must be typed manually.';
  @override
  String get onboardingProbeNoKey =>
      'Probe failed: no API key is available yet. Fill one in and probe again, or type the model name manually.';
  @override
  String onboardingProbeFailed(String reason) => 'Probe failed: $reason';
  @override
  String onboardingProbeOnlyProtocol(String protocol) => 'This endpoint only supports $protocol';
  @override
  String onboardingProbeWarning(String warning) => 'Note: $warning';

  @override
  String get chatTitle => 'Chat';
  @override
  String get chatSubtitle => 'Conversations, message sources, manual wake-up';
  @override
  String get composerHint => 'Type a message… (/reset clears context, /dream asks her to tidy up memory)';
  @override
  String get jumpToLatest => 'Jump to latest';
  @override
  String get jumpToLatestNew => 'New messages · Jump to latest';
  @override
  String get earlierFailed => 'Earlier records failed to load. Scroll up to retry.';
  @override
  String get noEarlier => 'No earlier records';
  @override
  String get historyErrorTitle => 'Failed to load conversation';
  @override
  String get historyErrorMessage => 'Could not read the conversation from the main process.';
  @override
  String get chatEmptyTitle => 'No conversation yet';
  @override
  String get chatEmptyMessage => 'There are no messages yet.';
  @override
  String get chatEmptyAction => 'Type a message';
  @override
  String get chatEmptyHint => 'Send something below and the conversation shows up here.';
  @override
  String get tagFrameworkNotice => 'Framework notice';
  @override
  String get tagFrameworkReminder => 'Framework reminder';
  @override
  String get tagInjection => 'Injection warning';
  @override
  String get tagContextBoundary => 'Context boundary';
  @override
  String get injectionCardTitle => 'An outside message looks like it is trying to direct her';
  @override
  String get unnamedSender => 'Unnamed conversation';
  @override
  String receivedFrom(String sender, String id) => 'Received from $sender ($id)';
  @override
  String get dash => '—';
  @override
  String mentionsYou(String where) => 'Someone mentioned you in $where';
  @override
  String talkingAbout(String what) => 'They are talking about: $what';
  @override
  String get directMessage => 'Direct message';
  @override
  String get groupMention => 'Group mention';
  @override
  String get groupMessage => 'Group message';
  @override
  String get chatTypeDirect => 'Direct';
  @override
  String get chatTypeGroup => 'Group';
  @override
  String get qqOfficialBot => 'QQ official bot';
  @override
  String get externalChannel => 'External channel';
  @override
  String get qqMessage => 'QQ message';
  @override
  String get oneBotMessage => 'OneBot message';
  @override
  String get externalMessage => 'External message';
  @override
  String get byModel => 'Model decision';
  @override
  String get byRule => 'Rule match';
  @override
  String fromWho(String who) => 'from $who';
  @override
  String get manualWake => 'Manual wake-up';
  @override
  String get intentWake => 'Intent wake-up';
  @override
  String get schedulerFire => 'Scheduled task fired';
  @override
  String scheduledAt(String at) => 'due $at';
  @override
  String get backgroundProgress => 'Background task update';
  @override
  String get eventDream => 'Dream';
  @override
  String get eventMcpDeclChanged => 'MCP declaration changed';
  @override
  String get contextClearedHere => 'Context cleared here';
  @override
  String get contextCompactedHere => 'Context compacted here';
  @override
  String get contextClearedHereDetail => 'Nothing before this line counts toward her context';
  @override
  String get contextCompactedHereDetail =>
      'Everything before this line is replaced by a handover note and no longer counted turn by turn';
  @override
  String get humanReplyRecorded => 'Human reply recorded';
  @override
  String get markedOk => 'Marked as succeeded';
  @override
  String get markedFailed => 'Marked as failed';
  @override
  String get toolRunning => 'Running';
  @override
  String get toolExecuting => 'Running…';
  @override
  String get toolDone => 'Done';
  @override
  String get toolError => 'Error';
  @override
  String get toolTimeout => 'Timed out (result unknown)';
  @override
  String get toolDenied => 'Denied by policy';
  @override
  String get toolUnknown => 'Outcome unknown';
  @override
  String get toolNotDispatched => 'Not dispatched';
  @override
  String get toolOverStepCap => 'Exceeded per-step cap';
  @override
  String get thinkingLabel => 'Thinking';
  @override
  String thinkingStep(String step) => 'step $step';
  @override
  String thinkingChars(String chars) => '$chars chars';
  @override
  String thinkingElapsed(String elapsed) => 'elapsed $elapsed';
  @override
  String get thinkingGap => '  ';
  @override
  String compactChars(int chars) {
    if (chars < 1000) return '$chars';
    final k = chars / 1000;
    if (k >= 100) return '${k.round()}k';
    return '${k.toStringAsFixed(1)}k';
  }
  @override
  String get toastContextCleared => 'Context cleared. The conversation starts from zero.';
  @override
  String toastClearFailed(String reason) => 'Clear failed: $reason';
  @override
  String get toastDream => 'Asked her to dream — the result is written to memory, visible in Logs';
  @override
  String toastTriggerFailed(String reason) => 'Trigger failed: $reason';
  @override
  String get toastDuplicateSend =>
      'Identical to the message just sent, so it was ignored — try again in a few seconds';
  @override
  String toastSendFailed(String reason) => 'Send failed: $reason';

  @override
  String get settingsTitle => 'Settings';
  @override
  String get settingsSubtitle => 'Status, channels, persona and local parameters';
  @override
  String get settingsSectionUi => 'Interface';
  @override
  String get settingsUiNote => 'Theme and window behaviour. Local only, never written to config.';
  @override
  String get instantApply => 'Applies immediately';
  @override
  String get settingsThemeMode => 'Theme';
  @override
  String get themeLight => 'Light';
  @override
  String get themeDark => 'Dark';
  @override
  String get settingsCurrentTheme => 'Current theme';
  @override
  String get settingsThemeNote =>
      'Local preference, applied immediately. Never written to config, never affects the render fingerprint.';
  @override
  String get settingsCloseToTray => 'Minimize to tray on close (keep running)';
  @override
  String get settingsCloseToTrayNote =>
      'If the tray icon is hidden by Windows, closing the window makes the UI impossible to find. '
      'With this off, the × button just exits (she keeps running).';
  @override
  String get settingsLanguage => 'Language';
  @override
  String get languageFollowSystem => 'Follow system';
  @override
  String get settingsLanguageNote =>
      'Language of the interface, applied immediately. Never written to config and never changes how she speaks.';

  @override
  String get settingsStringsOverride => 'Text overrides';
  @override
  String get settingsStringsOverrideNote =>
      'Edit that file to change the words on screen. Unlisted keys keep the built-in text; '
      'sentences with parameters (such as "Failed to load: …") are not overridable yet. '
      'Click "Reload text" to apply — no restart needed.';
  @override
  String get stringsOverridePathLabel => 'Override file';
  @override
  String get stringsOverrideOpen => 'Open text file';
  @override
  String get stringsOverrideReload => 'Reload text';
  @override
  String get stringsOverrideExport => 'Export current text as template';
  @override
  String get stringsOverrideNone => 'No overrides (built-in text)';
  @override
  String stringsOverrideLoaded(int zh, int en) => 'Loaded ${zh + en} override(s) (zh $zh / en $en)';
  @override
  String stringsOverrideFailed(String reason) => 'Parse failed: $reason';
  @override
  String stringsOverrideUnreadable(String detail) => 'Cannot read the file ($detail)';
  @override
  String stringsOverrideBadJson(String detail) => 'Invalid JSON ($detail)';
  @override
  String get stringsOverrideBadRoot =>
      'The top level is not a JSON object (expected {"zh": {…}, "en": {…}} or {"key": "text"})';
  @override
  String stringsOverrideIgnored(int count) =>
      '$count key(s) not applied (unknown names or non-string values; see the startup log)';
  @override
  String stringsOverrideExported(String path) => 'Template written to $path';
  @override
  String stringsOverrideExportFailed(String reason) => 'Could not write the template: $reason';
  @override
  String stringsOverrideOpenFailed(String path) => 'Could not open $path';

  @override
  String get settingsAnchorCaption => 'Sections';
  @override
  String get settingsNavModel => 'Model';
  @override
  String get settingsNavUi => 'Interface';
  @override
  String get settingsNavSpeak => 'Speech';
  @override
  String get settingsNavDeps => 'Dependencies';
  @override
  String get settingsNavProtocol => 'Protocol';
  @override
  String get settingsNavWebhook => 'Webhook';
  @override
  String get settingsNavMemory => 'Memory';
  @override
  String get settingsNavTrust => 'Trust scope';
  @override
  String get settingsNavSystem => 'System';
  @override
  String get settingsNavAccount => 'Account';
  @override
  String get settingsNavAbout => 'About';
  // ── Overview page ──
  @override
  String get overviewSubtitle => 'Current status, usage, and things waiting for you';
  @override
  String get overviewSectionAdvice => 'Suggestions';
  @override
  String get overviewSectionRecent => 'Recent events';
  @override
  String get overviewPersonaSeedAdvice =>
      'Persona assets are not initialized yet: IDENTITY.md is still the template. '
      'Fill in who she is and how she speaks.';
  @override
  String get overviewNoPendingCalls => 'Nothing is waiting for a decision right now';
  @override
  String get overviewTimerCancelTitle => 'Cancel this timer?';
  @override
  String get overviewTimerCancel => 'Cancel';
  @override
  String get overviewDeadDiscardTitle => 'Discard this dead letter?';
  @override
  String get overviewDeadDiscardConfirm => 'Discard';
  @override
  String get overviewDeadRequeue => 'Requeue';
  @override
  String get overviewDeadDiscard => 'Discard';
  @override
  String get overviewLoadFailedTitle => 'Could not load status data';
  @override
  String get overviewMarkSucceeded => 'Mark succeeded';
  @override
  String get overviewMarkFailed => 'Mark failed';
  @override
  String get overviewTodayUsage => 'Today';
  @override
  String get overviewCacheHitRate => 'Cache hit rate';
  @override
  String get overviewPending => 'Pending';
  @override
  String get overviewFailStreak => 'Fail streak';
  @override
  String get overviewActFallback => 'Open';
  @override
  String get overviewDeadLettersUnread => 'Dead-letter details are unavailable; refresh and look again.';
  @override
  String get overviewUnknownSession => 'Unknown chat';
  @override
  String get overviewChatTypeDirect => 'Direct';
  @override
  String get overviewChatTypeGroupAt => 'Group @';
  @override
  String get overviewChatTypeGroup => 'Group';
  @override
  String get overviewChatTypeGuild => 'Channel';
  @override
  String get overviewChatTypeUnknown => 'Unknown type';
  @override
  String get overviewExternalSessions => 'External chats';
  @override
  String get overviewExternalSessionsNote =>
      'Chats added through a message adapter. Messages the platform pushes to us go into the inbox; '
      'the agent reads them on her own.';
  @override
  String get overviewExternalSessionsLoading => 'Reading external chats…';
  @override
  String get overviewExternalSessionsErrorHint =>
      'Status and usage are unaffected; this card appears as soon as data arrives.';
  @override
  String get overviewNoAccumulatedMessages =>
      'No accumulated messages (the inbox is empty; messages in groups that do not @ her only arrive '
      'if the official bot pushes them to us first).';
  @override
  String get overviewLevelCritical => 'Critical';
  @override
  String get overviewLevelWarn => 'Warning';
  @override
  String get overviewLevelInfo => 'Info';
  @override
  String get overviewLevelUnknown => 'Unknown level';
  @override
  String get overviewFrameworkNote => 'Framework note';
  @override
  String get overviewFrameworkNotesLoading => 'Reading framework notes…';
  @override
  String get overviewFrameworkNotesErrorHint =>
      'Runtime is unaffected; injection warnings and alerts are still recorded in the event log.';
  @override
  String get overviewNoFrameworkNotes => 'Nothing needs your attention.';
  @override
  String get overviewTimers => 'Timers';
  @override
  String get overviewTimersNote =>
      'Wakes she scheduled herself (timer tool, action=set). They wake her when due; '
      'cancelling only works for timers that have not fired yet.';
  @override
  String get overviewNoTimers => 'No timers are scheduled right now.';
  @override
  String get overviewTimersErrorHint =>
      'It may have fired or been cancelled already; refresh to see the latest list.';
  @override
  String get overviewTimerUnknownTime => 'time unknown';
  @override
  String get overviewTimerRecurring => 'Recurring';
  @override
  String get overviewRecentEmpty => 'No events recorded yet.';
  @override
  String get overviewRecentEmptyAction => 'Wake her now';
  @override
  String get overviewRecentEmptyHint =>
      'After a wake or an incoming message, the latest events are listed here.';
  @override
  String get overviewJudgedByRule => 'rule';
  @override
  String get overviewJudgedByModel => 'model';
  @override
  String get overviewSessionsNotList => 'The response was not a chat list';
  @override
  String get overviewNotesNotList => 'The response was not a note list';
  @override
  String get overviewContextTitle => 'Current context composition';
  @override
  String get overviewContextLoading => 'Reading the context breakdown…';
  @override
  String get overviewContextErrorHint =>
      'Status and usage are unaffected; this block returns once the data is readable.';
  @override
  String get overviewContextEmpty => 'No requests yet — numbers appear after her next turn';
  @override
  String get overviewContextNotObject => 'The response was not a context breakdown';
  @override
  String get overviewContextKeepOn => 'on';
  @override
  String get overviewContextKeepOff => 'off';
  @override
  String overviewAdviceLine(String title, String body) => '$title: $body';
  @override
  String overviewDeadLetterLine(int seq, int claimCount, String? stamp) =>
      'seq $seq · ${claimCount == 1 ? '1 claim' : '$claimCount claims'}${stamp == null ? '' : ' · $stamp'}';
  @override
  String overviewPendingCount(int count) =>
      count == 1 ? '1 waiting for a decision' : '$count waiting for a decision';
  @override
  String overviewTodayUsageTooltip(String exact) => 'Today: $exact';
  @override
  String overviewTimerCancelBody(String timerId) =>
      'Timer $timerId will be cancelled: it will no longer wake her when it fires.\n'
      'This cancellation is written to the log (timer/cancelled); if you cancel the wrong one, '
      'she has to schedule it again.';
  @override
  String overviewTimerCancelled(String timerId) =>
      'Timer $timerId cancelled: it will not wake her again';
  @override
  String overviewTimerCancelFailed(String timerId, String reason) =>
      'Could not cancel $timerId: $reason';
  @override
  String overviewTimerCancelToastFailed(String reason) => 'Cancel failed: $reason';
  @override
  String overviewMarkFailedToast(String reason) => 'Could not mark it: $reason';
  @override
  String overviewDeadRequeued(int seq) =>
      'Requeued seq $seq: it is back in the queue and will be claimed again on the next tick';
  @override
  String overviewDeadDiscardBody(int inputSeq) =>
      'seq $inputSeq will not be requeued and will not be executed — it leaves the pending queue.\n'
      'This decision is written to the log; the input itself stays in the event log for later '
      'inspection.';
  @override
  String overviewDeadDiscarded(int seq) =>
      'Discarded seq $seq: it will not be executed; the input stays in the log';
  @override
  String overviewDeadActionFailed(String verb, int seq, String reason) =>
      '$verb seq $seq failed: $reason';
  @override
  String overviewDeadActionToastFailed(String verb, String reason) => '$verb failed: $reason';
  @override
  String overviewHistoricalBadge(String label) =>
      label.isEmpty ? 'recovered · historical' : '$label · recovered · historical';
  @override
  String overviewSourceFramework(String? fingerprint) => fingerprint == null
      ? 'Source: the framework itself'
      : 'Source: the framework itself · $fingerprint';
  @override
  String overviewSourceChat(String who) => 'Source: $who';
  @override
  String overviewQuote(String text) => '“$text”';
  @override
  String overviewGroupsCount(int count) => count == 1 ? '1 group' : '$count groups';
  @override
  String overviewSinglesCount(int count) => count == 1 ? '1 direct chat' : '$count direct chats';
  @override
  String overviewOthersCount(int count) => count == 1 ? '1 other' : '$count others';
  @override
  String overviewUnreadTotal(int count) => '$count unread in total';
  @override
  String overviewMessagesSeen(int count) =>
      count == 1 ? '1 message received' : '$count messages received';
  @override
  String overviewUnreadBadge(int count) => '$count unread';
  @override
  String overviewTimersWaiting(int count) => count == 1 ? '1 waiting' : '$count waiting';
  @override
  String overviewTimerCron(String cron) => 'recurring $cron';
  @override
  String overviewTimerPayload(String payload) => 'Wakes with: $payload';
  @override
  String overviewExternalSessionsError(String reason) =>
      'Could not read external chats: $reason';
  @override
  String overviewFrameworkNotesError(String reason) =>
      'Could not read framework notes: $reason';
  @override
  String overviewContextTokens(String used, String budget) => '$used / $budget tok';
  @override
  String overviewContextSubline(int percent, String keep, String stamp) =>
      '$percent% of budget · keep historical reasoning: $keep · from the $stamp step';
  @override
  String overviewContextShare(int share) => '$share%';
  @override
  String overviewContextLegendNumbers(String tokens, int share) => '$tokens · $share%';
  @override
  String overviewContextError(String reason) => 'Could not read the context breakdown: $reason';
  @override
  String get settingsLaneHeavyLabel => 'Main loop (heavy)';
  @override
  String get settingsLaneLightLabel => 'Lightweight (light)';
  @override
  String get settingsLaneHeavyNote => 'The model the turn main loop uses';
  @override
  String get settingsLaneLightNote => 'The model used for necessity checks, compaction summaries, and guard classification';
  @override
  String get settingsDepSourceManaged => 'managed by the framework';
  @override
  String get settingsDepSourceSystemPath => 'system PATH';
  @override
  String get settingsDepVersionUnknown => 'version unknown';
  @override
  String get settingsDepPathUnknown => 'path unknown';
  @override
  String get settingsSysHostEmptyError => 'Listen address cannot be empty: an empty value means listening on all interfaces; not saved';
  @override
  String settingsSysEmptyError(String label) => '$label cannot be empty; not saved';
  @override
  String settingsSysIntRequired(String label) => '$label must be an integer; not saved';
  @override
  String settingsSysPortRange(String label) => '$label must be between 1 and 65535; not saved';
  @override
  String settingsSysMinOne(String label) => '$label must be at least 1; not saved';
  @override
  String settingsSysRatioRequired(String label) => '$label must be a decimal (0.8 means 80%); not saved';
  @override
  String settingsSysRatioRange(String label) => '$label is a ratio and must be within 0–1 (0 excluded); not saved';
  @override
  String settingsSysMin(String label, int lo) => '$label must be at least $lo; not saved';
  @override
  String settingsSysMax(String label, int hi) => '$label must be at most $hi; not saved';
  @override
  String get settingsSysHostLabel => 'Listen address';
  @override
  String get settingsSysHostNote => 'For local use, enter 127.0.0.1; the port must be 1–65535. Leaving it empty means listening on all interfaces, and it will be blocked.';
  @override
  String get settingsSysPortLabel => 'Port';
  @override
  String get settingsSysTimezoneLabel => 'Time zone';
  @override
  String get settingsSysTimezoneNote => 'IANA name, for example Asia/Shanghai. The budget "today" is split by it.';
  @override
  String get settingsSysStepToolsLabel => 'Budget · tool calls per step';
  @override
  String get settingsSysStepToolsNote => 'How many tool calls a single step may make.';
  @override
  String get settingsSysTurnStepsLabel => 'Budget · steps per turn';
  @override
  String get settingsSysTurnStepsNote => 'How many steps a turn may take.';
  @override
  String get settingsSysTaskTokensLabel => 'Budget · task token cap';
  @override
  String get settingsSysTaskTokensNote => 'Cumulative cap per task; enter the raw value — shorthand such as 20M is not accepted. The metric is non-cached tokens (what you actually pay for), not the usage on your bill.';
  @override
  String get settingsSysDailyTokensLabel => 'Budget · daily token cap';
  @override
  String get settingsSysDailyTokensNote => 'Cumulative cap per day, split by the time zone above. Same metric as the line above: only the part that missed the cache counts.';
  @override
  String get settingsSysSoftRatioLabel => 'Budget · soft threshold';
  @override
  String get settingsSysSoftRatioNote => 'A decimal from 0 to 1: 0.8 means 80%. At this line she gets a wrap-up warning; only crossing it hard-stops.';
  @override
  String get settingsSysFailStreakLabel => 'Budget · consecutive failure cap';
  @override
  String get settingsSysFailStreakNote => 'After this many consecutive failures she raises an alert and pauses.';
  @override
  String get settingsSysHeartbeatLabel => 'Heartbeat interval · mean (minutes)';
  @override
  String get settingsSysHeartbeatNote => 'How often she wakes on average — larger saves tokens, smaller wakes her more often. Both ends are still bounded by the floor and ceiling: they do not change with this number, she will not wake below the quiet floor, and she must wake by the ceiling.';
  @override
  String get settingsSysCompactionLabel => 'Context · compaction line (token estimate)';
  @override
  String get settingsSysCompactionNote => 'When the visible history reaches this many tokens (estimated), it is folded into a handover note; compaction only masks, never deletes. The unit is the estimator reading, not the provider count (the estimate runs about 1.65–1.66× lower). Enter the raw value: 200000-style notation is not accepted; lower = more frequent compaction, and each compaction costs a call of its own. Takes effect immediately, no restart needed.';
  @override
  String get settingsTrustConsequenceWorkspaceUnknown => 'She can only work inside the workspace directory configured in trust.workspaceRoot; reads, writes, and commands outside it are refused.';
  @override
  String settingsTrustConsequenceWorkspace(String root) => 'She can only work inside $root; reads, writes, and commands outside it are refused.';
  @override
  String get settingsTrustConsequenceFull => 'She can read and write files anywhere on this computer and run commands in any directory.';
  @override
  String get settingsTrustLabelWorkspace => 'Workspace only';
  @override
  String get settingsTrustLabelFull => 'Full trust';
  @override
  String get settingsWebhookStateNotObject => 'Could not read the credential state (the response was not an object)';
  @override
  String get settingsProtocolStateNotObject => 'Could not read the protocol-side state (the response was not an object)';
  @override
  String get settingsDepsReadFailed => 'Could not read the dependency report';
  @override
  String get settingsKeysReadFailed => 'Could not read the key status';
  @override
  String get settingsProjectionReadFailed => 'Could not read runtime data';
  @override
  String get settingsModelNameRequired => 'Model name cannot be empty; not saved';
  @override
  String get settingsBaseUrlRequired => 'Base URL cannot be empty; not saved';
  @override
  String get settingsNoChanges => 'Nothing to save';
  @override
  String get settingsWrittenModelSettings => 'model settings';
  @override
  String get settingsWrittenKey => 'API key';
  @override
  String get settingsRestartSuffix => '; takes effect after the process restarts';
  @override
  String settingsSaveFailed(String err) => 'Save failed: $err';
  @override
  String get settingsClearKeyBody => 'After clearing you have to enter it again; gates that share the same environment variable are cleared together (one name, one value); values from environment variables are not affected.';
  @override
  String get settingsClear => 'Clear';
  @override
  String get settingsKeyCleared => 'Local key cleared';
  @override
  String settingsClearFailed(String err) => 'Clear failed: $err';
  @override
  String get settingsConfigErrorHint => 'Model keys and system information need the active config. Make sure the main process is running.';
  @override
  String get settingsConfigUnavailable => 'Config unavailable.';
  @override
  String get settingsConfigUnavailableHint => 'The local service /api/config returned no config content.';
  @override
  String settingsKeysReadFailedHint(String keysError) => 'Could not read the key status ($keysError). The key badge is unavailable; model names and Base URLs can still be saved.';
  @override
  String get settingsConfigFallbackNote => 'config.json could not be read, so this page shows the config that is now in effect (saving still writes to the file).';
  @override
  String get settingsModelRestartNote => 'Changes above are not in effect yet: model names, endpoints and protocols are startup parameters and only take effect after the process restarts — until then she keeps using the ones from startup. The save itself succeeded; the fields show what is on disk.';
  @override
  String settingsModelRunningNow(String lane, String model, String baseUrl) =>
      'Running now: $lane=$model @ $baseUrl';
  @override
  String get settingsKeysNote => 'Keys are write-only: this page always shows a mask, and the full value is read once when the connection is established. Saving writes config.json and data/.keys.json and takes effect after the process restarts (environment variables win over files).';
  @override
  String get settingsKeyConfiguredHint => 'Configured; paste a new key to replace it';
  @override
  String get settingsKeySampleHint => 'sk-…';
  @override
  String get settingsModelName => 'Model name';
  @override
  String get settingsBaseUrlNote => 'API root address, without /responses.';
  @override
  String get settingsModelProtocol => 'Protocol';
  @override
  String get settingsModelProtocolAuto => 'Try Responses first; switch only when the endpoint proves unsupported (recommended)';
  @override
  String get settingsModelProtocolChat => 'Force Chat (no "must echo reasoning" requirement, so far fewer 400s — but reasoning is shown less)';
  @override
  String get settingsModelProtocolResponses => 'Force Responses (fails outright if the endpoint does not support it; no automatic fallback)';
  @override
  String settingsKeyEnvNote(String envName) => 'The environment variable $envName wins; if it has no value the value here is used (written to data/.keys.json, write-only).';
  @override
  String get settingsClearKey => 'Clear key';
  @override
  String get settingsReading => 'Reading…';
  @override
  String get settingsStateReadFailed => 'Could not read the status';
  @override
  String get settingsNotConfigured => 'Not configured';
  @override
  String get settingsSpeakNote => 'The rhythm she speaks in: one piece at a time, with a gap between pieces. It only affects how delivery feels, not what she says.';
  @override
  String get settingsSpeakTyping => 'Typing rhythm';
  @override
  String get settingsSpeakTypingNote => 'On: messages are sent piece by piece according to how long the text would take to type, like a person typing (and the other side can cut in at any moment). Off: the whole message is sent at once and arrives as fast as possible.';
  @override
  String get settingsSpeakSpeed => 'Typing speed';
  @override
  String get settingsSpeakSpeedUnit => 'chars/min';
  @override
  String get settingsSpeakSpeedNote => 'Default 90 (a common speed for Chinese mobile typing). Larger means faster speech and shorter waits; range 30–600.';
  @override
  String get settingsCurrentlyActive => 'Currently in effect';
  @override
  String settingsSpeakTypingOn(String saved) => '$saved chars/min · sent piece by piece';
  @override
  String settingsSpeakTypingOff(String saved) => '$saved chars/min · sent all at once';
  @override
  String get settingsSpeakTypingEnabled => 'Typing rhythm enabled (takes effect after restart)';
  @override
  String get settingsSpeakTypingDisabled => 'Typing rhythm disabled (takes effect after restart)';
  @override
  String get settingsSpeakSpeedRange => 'Typing speed must be between 30 and 600';
  @override
  String get settingsSavedRestartNote => 'Saved (takes effect after restart)';
  @override
  String get settingsSavedLive => 'Saved; effective immediately (no restart needed)';
  @override
  String get settingsSavedRestart => 'Saved; takes effect after restart';
  @override
  String get settingsDepsAllReady => 'All ready';
  @override
  String get settingsDepsNote => 'External dependencies we recommend; the framework can install them in one step.';
  @override
  String settingsDepsReadFailedHint(String depsError) => 'Could not read the dependency report ($depsError). If you can neither install nor see the status, first check on the command line that the main process is running.';
  @override
  String get settingsDepsProbing => 'Probing this machine for pwsh / ripgrep / es.exe / python …';
  @override
  String get settingsDepsInstallLocation => 'Install location: <data dir>/tools/<name>/. It takes effect right after installing — the probe result is re-checked and refreshed after installation, so the next tool call uses the new engine.';
  @override
  String get settingsDepReadyManaged => 'ready · managed';
  @override
  String get settingsDepReadySystem => 'ready · system';
  @override
  String get settingsDepMismatch => 'version mismatch';
  @override
  String get settingsDepMissing => 'not installed';
  @override
  String get settingsDepNoAction => 'no action needed';
  @override
  String get settingsDepInstalling => 'installing…';
  @override
  String get settingsInstall => 'Install';
  @override
  String get settingsDownloadPage => 'Download page';
  @override
  String get settingsOpenDownloadPage => 'Open download page';
  @override
  String get settingsDownloadAndInstall => 'Download and install';
  @override
  String settingsInstallRequestFailed(String err) => 'Install request failed: $err';
  @override
  String get settingsStepDownloadFailed => 'download failed';
  @override
  String get settingsStepExtractFailed => 'extract failed';
  @override
  String get settingsStepVerifyFailed => 'post-install check failed';
  @override
  String get settingsStepInstallFailed => 'install failed';
  @override
  String settingsOpenedUrl(String url) => 'Opened with the default program: $url';
  @override
  String get settingsUnknown => 'unknown';
  @override
  String get settingsRestartRequired => 'restart required';
  @override
  String get settingsProtocolTitle => 'Protocol side (optional)';
  @override
  String get settingsProtocolNote => 'Optional: an OneBot protocol side launched by the framework, backed by a real QQ account. It is an independent inbound channel from the official bot; enabling one does not affect the other.';
  @override
  String settingsProtocolError(String protocolError) => 'Could not read the protocol-side state: $protocolError';
  @override
  String get settingsProtocolErrorHint => 'This card failing does not affect the other settings. First check that the main process is running, then retry. Until the state can be read, no switch, directory, or one-click install is offered here — that would mean writing a value you cannot see.';
  @override
  String get settingsProtocolLoading => 'Reading the protocol-side state…';
  @override
  String get settingsProtocolEmpty => 'The built-in protocol side is not configured yet.';
  @override
  String get settingsProtocolEmptyHint => 'Not enabling it changes nothing: the official bot channel is unaffected. To use this route, press "one-click install" below to install and configure it in one go.';
  @override
  String get settingsProtocolEnabled => 'Enable the built-in protocol side';
  @override
  String get settingsProtocolEnabledNote => 'The framework connects automatically at startup; when off you can fill in and configure both sides manually.';
  @override
  String get settingsInstallDir => 'Install directory';
  @override
  String get settingsInstallDirHint => '<protocol-side install directory>';
  @override
  String get settingsSaveDir => 'Save directory';
  @override
  String get settingsInstallDirNote => 'Protocol-side install directory (absolute path). After unpacking the Lite package, the entry index.mjs sits at this level, with no dist/ subdirectory; "one-click install" fills it in automatically.';
  @override
  String get settingsOneClickInstall => 'One-click install';
  @override
  String get settingsOneClickInstallNote => 'Downloads the Lite package from the official SnowLuma Release; if the automatic download fails, download it yourself and fill in the install directory. This package is not distributed with the framework and must not be used commercially.';
  @override
  String get settingsOneClickPrerequisite => 'Prerequisite: a QQ client is signed in on this machine (the bot account).';
  @override
  String get settingsInstallRunningNote => 'Downloading from the official Releases and unpacking. It is 4.6 MB and may take a minute or two depending on your connection — please wait, and do not press it again. The step-by-step log (which step, how much downloaded) is listed all at once when this step finishes: this endpoint is a synchronous request, not a stream, so progress lines cannot be interleaved.';
  @override
  String settingsInstallManualRoute(String protocolDownloadUrl) => 'You can also do it yourself: download the release package from $protocolDownloadUrl, unpack it, and fill that directory in above. This route is for when one-click install fails or you want to control the version yourself; the framework also downloads from the same address and does not distribute the package with itself (the licence is "source-visible, non-commercial", fine for personal use).';
  @override
  String get settingsInstallLogEmpty => 'Install log: (none this time — the failure happened before anything ran)';
  @override
  String get settingsInstallLog => 'Install log:';
  @override
  String get settingsInstalledNextTitle => 'Installed. Next: restart the service, then scan the QR code.';
  @override
  String get settingsInstalledNextBody => '① Restart the service: the running protocol-side instance was built from the config at startup, so only after a restart will it be launched with the config just written (the framework does not restart it for you — a failed self-restart leaves nothing behind).\n② Then scan the QR code: after the restart an "open panel" button appears on this card; open it, read and accept the terms of service and privacy policy there (that consent is legal in nature and you have to press it yourself), then connect QQ and scan the code. The first login needs the initial credentials it printed at startup — that line is already shown below the button (password masked), with "copy credential" next to it. Scanning connects your local QQ client; the framework does not manage the login state.';
  @override
  String get settingsInstallDirEmpty => '(no install directory yet)';
  @override
  String get settingsEntryFound => 'executable entry found';
  @override
  String get settingsEntryMissing => 'no executable entry in the directory';
  @override
  String get settingsEntryPendingRestart => 'entry will be checked after a restart';
  @override
  String settingsEndpointPoint(String wsUrl) => 'Endpoint: $wsUrl';
  @override
  String get settingsStart => 'Start';
  @override
  String get settingsStop => 'Stop';
  @override
  String get settingsOpenPanel => 'Open panel';
  @override
  String get settingsProtocolNotAttachedNote => 'This config was not read when the current process started: the framework does not hold an instance for it now, and "start/stop" only works after the process is restarted.';
  @override
  String get settingsChainProcess => '① Process';
  @override
  String get settingsChainUnobserved => 'not observed';
  @override
  String get settingsChainNoInstance => 'This process has no instance; nobody is watching this level';
  @override
  String get settingsChainNotRunning => 'not running';
  @override
  String get settingsChainNoPort => 'its panel port is not listening';
  @override
  String get settingsChainSpawned => 'spawned by this process';
  @override
  String get settingsChainDiscovered => 'already running before this process';
  @override
  String get settingsChainPortOnly => 'port only';
  @override
  String get settingsChainRunning => 'running';
  @override
  String settingsChainListening(String url) => 'listening $url';
  @override
  String get settingsChainOneBotConfig => '② OneBot config';
  @override
  String get settingsChainWithToken => 'with token';
  @override
  String get settingsChainNoToken => 'no token (authentication off)';
  @override
  String get settingsChainPresent => 'present';
  @override
  String settingsChainEndpoint(String ws) => 'endpoint $ws';
  @override
  String get settingsChainUnreadable => 'unreadable';
  @override
  String get settingsChainMissing => 'missing';
  @override
  String get settingsChainMissingDetail => 'QQ not signed in: this file is only generated after login';
  @override
  String get settingsChainAdapter => '③ Adapter';
  @override
  String get settingsChainConnected => 'connected';
  @override
  String settingsChainDelivered(String delivered) =>
      'received $delivered ${delivered == '1' ? 'message' : 'messages'}';
  @override
  String get settingsChainReconnecting => 'reconnecting';
  @override
  String settingsChainBackoff(String attempts) => 'backoff attempt $attempts';
  @override
  String get settingsChainNoEndpoint => 'no endpoint to connect';
  @override
  String get settingsChainNoEndpointDetail => 'The OneBot config of the protocol side has not appeared yet, and no address was filled in manually';
  @override
  String get settingsChainDisabled => 'disabled';
  @override
  String get settingsChainNotAssembled => 'not assembled';
  @override
  String get settingsChainNotAssembledDetail => 'This process has no OneBot adapter';
  @override
  String get settingsChainNoData => 'No data for this level';
  @override
  String settingsCredentialCaptured(String user, String masked) => 'Initial credential (captured from its output during this startup; user $user / password $masked)';
  @override
  String settingsCredentialFromLog(String user, String masked) => 'Initial credential (recovered from the framework\'s own startup trace: user $user / password $masked; if it has restarted since, this one is no longer valid)';
  @override
  String get settingsCredentialLost => 'The initial credential cannot be recovered: it prints it to its own output only once at startup (it is gone when the program closes). To get a usable one, let the framework restart it once (that run\'s output will be captured and shown here).';
  @override
  String get settingsConsentPending => 'The terms and privacy policy have not been accepted yet — until the panel is unlocked, the entry to QQ is locked.';
  @override
  String get settingsPasswordUnchanged => 'The initial password has not been changed: the first of the two gates is the password change, and the panel keeps asking you to do it first.';
  @override
  String settingsQrLoginAt(String webuiUrl) =>
      'Scan the QR code in $webuiUrl to sign in (the framework does not manage the QQ login state).';
  @override
  String get settingsCredentialCopied => 'Credential copied (user + password)';
  @override
  String get settingsCopyCredential => 'Copy credential';
  @override
  String settingsManualDownloadGuide(String protocolDownloadUrl) => 'You can also do it yourself: download the release package from $protocolDownloadUrl, unpack it, and fill that directory in above. This route is for when one-click install fails or you want to control the version yourself; the framework also downloads from the same address and does not distribute the package with itself (the licence is "source-visible, non-commercial", fine for personal use).';
  @override
  String get settingsProtocolThirdPartyTitle => 'Third-party component: SnowLuma';
  @override
  String get settingsProtocolThirdPartyNote =>
      'SnowLuma is an independent third-party project, developed and maintained by SnowLumaDevs: '
      'this project only downloads it from the official Releases, unpacks it and hosts its process on your behalf, '
      'and never modifies any of its files. '
      'Use is subject to its EULA and LICENSE and is limited to non-commercial purposes.';
  @override
  String get settingsProtocolOfficialProject => 'Official project';
  @override
  String get settingsProtocolOfficialSite => 'Official site';
  @override
  String get settingsProtocolLicenseRow => 'License (EULA / LICENSE)';
  @override
  String get settingsProtocolRestartNote => 'The change is written to config.json, but it takes effect only after the process restarts: the running protocol-side instance was built from the config at startup. Until the restart, the state shown here is still the one from this startup.';
  @override
  String get settingsInstallDirRequired => 'Install directory cannot be empty';
  @override
  String get settingsStartRequested => 'Start requested';
  @override
  String get settingsStopRequested => 'Stop requested';
  @override
  String settingsInstallRequestFailedHint(String err) => 'Install request failed: $err (the request never reached the install step; first check that the main process is running)';
  @override
  String get settingsOneClickFailed => 'One-click install failed: see the card for the reason';
  @override
  String get settingsInstallNoReason => 'Install failed and the server gave no reason (no detail in the response)';
  @override
  String get settingsInstalledOk => 'Installed';
  @override
  String get settingsInstalledConfigured => 'Installed and configured with it; restart and it is ready';
  @override
  String get settingsInstalledNotConfigured => 'Installed, but the automatic configuration did not go through: see the note on the card';
  @override
  String get settingsRestartSuffixParen => '(takes effect after the process restarts)';
  @override
  String get settingsGenerated => 'generated';
  @override
  String get settingsNotGenerated => 'not generated yet';
  @override
  String get settingsWebhookNote => 'Dedicated credential for external systems delivering to this instance (POST /webhook/*).';
  @override
  String settingsWebhookErrorHint(String webhookError) => 'Could not read the credential state ($webhookError). While the state is unreadable, do not press "regenerate" yet: rotation is irreversible (the old one becomes invalid immediately) and you do not know whether anyone is using it right now.';
  @override
  String get settingsWebhookLoading => 'Reading the webhook credential state…';
  @override
  String get settingsWebhookCurrent => 'Current credential';
  @override
  String settingsWebhookCurrentValue(String secretId, String createdAt) =>
      'Credential $secretId · generated at $createdAt';
  @override
  String get settingsWebhookNotConfiguredNote => 'This channel currently returns 401 for everything (nobody can deliver without a credential). Press the button below to generate one.';
  @override
  String get settingsWebhookRotated => 'Last rotated';
  @override
  String get settingsWebhookNever => 'never';
  @override
  String settingsWebhookBy(String by) => 'Initiated by: $by';
  @override
  String get settingsRegenerate => 'Regenerate';
  @override
  String get settingsGenerateWebhook => 'Generate webhook credential';
  @override
  String get settingsWebhookCredentialNote => '/webhook/* does not accept UI credentials (nor the transitional data/.ui-token): this channel accepts only the dedicated credential above. It is for external systems — they can deliver, but they cannot read anything under /api/*.';
  @override
  String get settingsRegenerateTitle => 'Regenerate the webhook credential';
  @override
  String get settingsRegenerateBody => 'The previous one becomes invalid immediately: external scripts already using it will start getting 401 — remember to switch the new credential over as well. The new credential is shown only once.';
  @override
  String get settingsNoTokenReturned => 'The server did not return the credential text; please press again. If this keeps happening, check the main process log';
  @override
  String get settingsWebhookRotatedNote => 'The previous one is now invalid (external scripts still using it will start getting 401).';
  @override
  String settingsGenerateFailed(String err) => 'Generation failed: $err';
  @override
  String get settingsMemoryNote => 'Who maintains the long-term memory (MEMORIES/ and diary/): the framework for you, or she reads, writes, and organizes it herself.';
  @override
  String get settingsNotInEffect => 'not in effect yet';
  @override
  String get settingsMemoryEnableLabel => 'Let the framework manage memory automatically (off = she only knows these files exist; reading, writing, and organizing are all hers)';
  @override
  String get settingsMemoryEnableNote => 'On: the framework creates and maintains MEMORIES/INDEX.md, injects the index into a fixed block every turn, and organizes once a day.';
  @override
  String get settingsMemoryOn => 'framework-managed memory (index injected every turn, organized daily)';
  @override
  String get settingsMemoryOff => 'she manages it herself (the framework does not generate, inject, or organize)';
  @override
  String get settingsMemoryUnaffectedNote => 'Two paths are not affected by this switch: MEMORIES/aliases.md takes part in "who is talking / watch list", which belongs to the channel side; STATE.md (her current state) is a separate layer.';
  @override
  String get settingsMemoryRestartNote => 'This setting is read when the process starts: saving writes config.json and takes effect after a restart. Turning it off deletes no files.';
  @override
  String get settingsMemoryDetail => 'With it off the framework does not generate, inject, or organize, but she can still read and write those files herself. Why keep this switch: to give people who want the agent to manage its own memory a clean path. The daily tidy-up time is set by wake.memoryMaintainCron (once a day by default): stale running notes are merged into facts.md and a diary/ entry is written. The !pinned section and item TTL of facts.md are also maintained by the framework.';
  @override
  String get settingsMemoryCost => 'The cost: she may forget to tidy up, facts.md keeps growing, and the index stops updating — all of that becomes hers.';
  @override
  String get settingsMemoryOnSaved => 'Changed to framework-managed memory (takes effect after restart)';
  @override
  String get settingsMemoryOffSaved => 'Changed to self-managed memory (takes effect after restart)';
  @override
  String get settingsTrustNote => 'Her working boundary: the whole computer, or a single workspace directory. Crossing it is a refusal, not a reminder.';
  @override
  String get settingsTrustReachLabel => 'How far she can reach';
  @override
  String get settingsTrustReachNote => 'What each level governs is written in the option itself; changing to a level applies that level\'s consequences.';
  @override
  String get settingsTrustWorkspaceUnknownPath => 'Workspace only (path not read)';
  @override
  String settingsTrustWorkspaceValue(String root) => 'Workspace only · $root';
  @override
  String get settingsTrustFullValue => 'Full trust (the whole computer)';
  @override
  String get settingsTrustPendingNote => 'The level chosen above is not in effect yet: it is written on disk, but the running process still uses the one read at startup — it takes effect after a restart. Until then she keeps working under the level currently in effect.';
  @override
  String get settingsTrustRootNote => 'The workspace is computed by the server (default <config dir>/workspace) and is not filled in on this page: writing the same boundary in two places is how you end up with "the config says A but it actually blocks at B".';
  @override
  String get settingsTrustBoundaryNote => 'It is a boundary, not a reminder: reads, writes, and commands outside it are refused.';
  @override
  String get settingsTrustRulesDetail => 'It governs the fs tool family (safe_read / safe_write / safe_edit / rg_search etc.) and pwsh: the former is judged through the same path, and the latter\'s workdir is governed together with paths in the command line. It is one of three independent gates along with the destructive switch and the pwsh command blacklist — this one governs scope and does not replace the other two.\nWhy full trust is the default: she is an unattended resident agent, and "being able to go find, fix, and install things herself" is how she exists; shutting her into an empty directory by default would leave most of her abilities unusable out of the box.';
  @override
  String get settingsTrustFullTitle => 'Switch to full trust';
  @override
  String get settingsTrustFullConfirmTail => 'This is a boundary; removing it means she can really do all of the above. Are you sure?';
  @override
  String get settingsTrustWorkspaceSaved => 'Changed to workspace only; reads, writes, and commands outside it will be refused (takes effect after the process restarts)';
  @override
  String get settingsTrustFullSaved => 'Changed to full trust (takes effect after the process restarts)';
  @override
  String get settingsSystemNote => 'The listen address, time zone, six budgets and heartbeat are all startup parameters of this process: change them here, save to config.json, and they take effect after a restart. The compaction line is the exception — it takes effect as soon as it is written (the server also updates the in-memory copy in the same critical section).';
  @override
  String get settingsDataDir => 'Data directory';
  @override
  String get settingsDataDirNote => 'The path fixed at startup: the event log, persona assets, and keys all live under it, and changing it means the next process starts from an empty directory.';
  @override
  String get settingsSystemFootnote => 'The data directory cannot be changed here (it decides where everything she owns lives, and it is fixed at process startup); the other fields take effect after the process restarts — except the compaction line, which takes over immediately after saving.';
  @override
  String get settingsLiveNow => 'effective immediately';
  @override
  String get settingsEdit => 'Edit';
  @override
  String get settingsAccountNote =>
      'The credential used to get into this UI: change password, end instance, sign out (clear credentials on this machine).';
  @override
  String get settingsAccountLegacyBadge => 'legacy shared token';
  @override
  String get settingsAccountSessionBadge => 'session credential';
  @override
  String get settingsAccountInstance => 'Current instance';
  @override
  String get settingsAccountInstanceNote => 'Credentials are stored per instance in separate files (%APPDATA%\\Irmia\\sessions): opening a second instance on the same machine will not replace this one.';
  @override
  String get settingsAccountLegacyNote => 'This one uses the legacy shared token (this instance has never had a password), and the server does not accept the "session" it produces: neither changing the password nor signing out can work (ending the instance is unaffected). Set a password first, then sign in and out by session.';
  @override
  String get settingsChangePassword => 'Change password';
  @override
  String get settingsLogout => 'Sign out (clear credentials on this machine)';
  @override
  String get settingsSetPasswordFirst => 'Set a password first';
  @override
  String get settingsPasswordChanged => 'Password changed; this UI is now using the new credential';
  @override
  String get settingsLogoutBody =>
        'Sign out: clear the credential saved on this machine, stop its backend process, then return to the '
        'instance picker — you will have to log in again with your password. To only stop the instance and '
        'keep your sign-in, use "End instance".';
  @override
  String get settingsCloseInstance => 'End instance';
  @override
  String get settingsCloseInstanceBody => 'End instance: stop its backend process (no more heartbeat, no more '
      'incoming messages) and return to the instance picker. Your sign-in is kept — pick "Open" there and you '
      'are straight back in, no password needed.';
  @override
  String get gateHintSessionExpired => 'Your session credential is no longer valid. Please log in again.';
  @override
  String get gateHintSetupNeeded => 'This instance has no password yet. Set one first.';
  @override
  String get gateHintAlreadyInitialized => 'This instance already has a password. Please log in with it.';
  @override
  String gateWaitingBackend(int port) => 'backend is not up yet (waiting on :$port)';
  @override
  String gateBackendDown(String address) => 'The backend is not up yet ($address). Retrying…';
  @override
  String gateBackendStarting(String phase) => phase.trim().isEmpty
      ? 'The backend is still starting. Retrying…'
      : 'The backend is still starting (phase: ${phase.trim()}). Retrying…';
  @override
  String backendPhaseLabel(String phase) => switch (phase.trim()) {
        'events' => 'replaying events',
        'mcp' => 'external tools',
        'channels' => 'message channels',
        'ready' => 'ready',
        final other => other,
      };
  @override
  String gateBackendProgress(int seconds, int retries) =>
      '${seconds}s elapsed · $retries retries so far';
  @override
  String get gateBackendLogHint => 'The backend never became ready: see %LOCALAPPDATA%\\Irmia\\gui.log';
  // ── Instance picker (2026-10) ──
  @override
  String get pickerTitle => 'Choose an instance';
  @override
  String get pickerBody => 'The previous instance has ended: its backend process is stopped (no more heartbeat, '
      'no more incoming messages), but your sign-in is kept — pick "Open" to come straight back. Choose an '
      'instance here, or create a new one. Instances are fully isolated: their own data, their own password, '
      'their own edit rights.';
  @override
  String get pickerLoading => 'Reading the instance list…';
  @override
  String get pickerEmpty => 'No instances registered yet. Create one to get started.';
  @override
  String get pickerUnreadable =>
      'The instance list could not be read (missing or corrupt): you can still create a new one — other instances are unaffected.';
  @override
  String get pickerRunning => 'Running';
  @override
  String get pickerStopped => 'Stopped';
  @override
  String get pickerDefaultBadge => 'Default';
  @override
  String get pickerLogin => 'Sign in';
  @override
  String get pickerStart => 'Start and sign in';
  @override
  String get pickerStarting => 'Starting…';
  @override
  String get pickerEnter => 'Open';
  @override
  String get pickerStartEnter => 'Start and open';
  @override
  String get pickerEntering => 'Opening…';
  @override
  String get pickerForget => 'Forget credential';
  @override
  String get pickerSessionExpired => 'Sign-in has expired. Please sign in again.';
  @override
  String get pickerNew => 'New instance';
  @override
  String get pickerDelete => 'Delete';
  @override
  String get pickerNewNameLabel => 'Name';
  @override
  String get pickerNewDirLabel => 'Data folder';
  @override
  String get pickerNewCreate => 'Create';
  @override
  String get pickerNewUseDir => 'Use this folder';
  @override
  String get pickerDeleteTitle => 'Delete instance';
  @override
  String pickerDeleteBody(String name) => 'Delete "$name"?';
  @override
  String pickerForgetBody(String name) => 'Forget the credential for "$name"? This only clears the sign-in '
      'credential stored on this machine: the instance keeps running and its registry entry stays. '
      'You will need the password next time.';
  @override
  String get pickerDeleteNote =>
      'By default only the entry in the instance list is removed; the data folder stays on disk. '
      'Deleting the folder too removes the memory and persona inside it — that cannot be undone.';
  @override
  String get pickerDeleteKeepDir => 'Remove entry only';
  @override
  String get pickerDeleteWithDir => 'Remove entry and folder';
  @override
  String get pickerRename => 'Rename';
  @override
  String get pickerRenameTitle => 'Rename instance';
  @override
  String get pickerRenameBody =>
      'This is the name shown on the picker. Once renamed it counts as manually set: starting the backend '
      'will not overwrite it with the name from the persona file.';
  @override
  String get pickerRenameSave => 'Save';
  @override
  String get pickerProblemNameRequired => 'Please give the instance a name.';
  @override
  String get pickerProblemNoLauncher =>
      'The instance list has no usable launch path (node and entry script): the backend cannot be started — '
      'start that instance once and it will write its paths into the list itself.';
  @override
  String get pickerProblemLaunchFailed => 'The backend did not start (check the node and entry script paths).';
  @override
  String get pickerProblemPortUnavailable => 'No free port from 7788 upwards: stop another instance first.';
  @override
  String get pickerProblemRemoveFailed =>
      'Could not delete: the instance list file is not writable (it may be locked). Try again.';
  @override
  String get pickerProblemRenameFailed =>
      'Could not rename: the instance list file is not writable (it may be locked). '
      'The name is unchanged — try again.';
  @override
  String pickerProblemDirNotEmpty(String dir) =>
      'The folder already exists and is not empty: $dir. Choose another name, or pick "Use this folder".';
  @override
  String pickerProblemNotReady(int seconds, String phase, String port) =>
      'Waited $seconds s and it is still starting'
      '${phase.trim().isEmpty ? '' : ' (phase: ${phase.trim()})'}: stopped waiting'
      ' (port :$port) — check its log.';
  @override
  String pickerWaitingReady(int seconds, String phase) => 'Waited $seconds s and it is still starting'
      '${phase.trim().isEmpty ? '' : ' (phase: ${phase.trim()})'}';
  @override
  String get pickerStopWaiting => 'Stop waiting';
  @override
  String pickerProblemPortTaken(String id) =>
      'Another instance is already on that port ($id): not connecting — instances must not cross.';
  @override
  String pickerProblemCannotDeleteRunning(String name) =>
      '"$name" is running: sign in and end it first, then come back to delete it.';
  @override
  String pickerProblemCannotDeleteDefault(String name) =>
      '"$name" is the default instance and cannot be deleted (its data folder is in use).';
  @override
  String pickerStartingNamed(String name) => 'Starting "$name"… (the first start takes a while)';
  @override
  String pickerNewPort(String port) => 'Will use port :$port';
  @override
  String pickerDeleteDisabled(String reason) => 'Cannot delete: $reason';
  @override
  String get settingsAboutNote => 'UI version and runtime projection data.';
  @override
  String get settingsAboutBadge => 'Flutter native UI';
  @override
  String get settingsVersionLabel => 'Version';
  @override
  String get settingsGuardedDays => 'Days guarded';
  @override
  String get settingsWatermark => 'Event watermark';
  @override
  String settingsProjectionReadFailedHint(String projError) =>
      'Could not read the runtime data ($projError); days guarded and the event watermark are unavailable.';
  @override
  String get settingsProjectionFootnote => 'Days guarded and the event watermark come from the runtime projection (GET /api/projection) and are measured values.';
  @override
  String settingsDaysCount(String days) => '$days ${days == '1' ? 'day' : 'days'}';
  @override
  String settingsDaysSince(String days, String stamp) =>
      '$days ${days == '1' ? 'day' : 'days'} (since $stamp)';
  @override
  String get settingsDestructivePolicy => 'destructive tool policy';
  @override
  String get settingsModify => 'Change';
  @override
  String get settingsPolicyNoneOption => 'All off (she cannot see any of them)';
  @override
  String get settingsPolicyAllOption => 'All on (everything in the list is granted)';
  @override
  String get settingsPolicyListOption => 'By list (only the ones you check)';
  @override
  String get settingsPolicyListTitle => 'Allow by list';
  @override
  String get settingsPolicyNoTools => 'Could not get the tool list (the registry may not be up yet) — check "Extensions · Tools" first and come back.';
  @override
  String get settingsDestructiveTitle => 'Change the destructive tool policy';
  @override
  String get settingsDestructiveRelaxedBody => 'This lets her see and call tools that change this machine (writing files, running commands, etc.). Are you sure?';
  @override
  String get settingsDestructiveRestrictedBody => 'Back to the restricted level: she will not see the destructive tools (safer). Are you sure?';
  @override
  String get settingsPolicyAll => 'all on';
  @override
  String get settingsPolicyListEmpty => 'by list (empty)';
  @override
  String get settingsPolicyNone => 'all off';
  // ── Settings page: hand-written members ──
  @override
  String get settingsListAnd => ' and ';
  @override
  String settingsSaved(String written, String restart) => 'Saved $written$restart';
  @override
  String settingsClearKeyTitle(String laneLabel) => 'Clear key · $laneLabel';
  @override
  String settingsKeyConfiguredMask(String mask) => 'Configured $mask';
  @override
  String settingsDepPipUnavailable(String? reason) =>
      'pip: unavailable${reason == null ? '' : ' ($reason)'}';
  @override
  String settingsInstallConfirmBody(String managedDir) =>
      'Downloads an archive from the official address, unpacks it to $managedDir, and re-checks '
      'immediately. Once installed the agent can use it (rg_search / es_search get registered with '
      'it; for Python it also guides pip so she can pip install extra capabilities herself).';
  @override
  String settingsDepReadyToast(String label, String version) => '$label is ready ($version)';
  @override
  String settingsStepErrorToast(String step, String error) => '$step: $error';
  @override
  String settingsNoDownloadPage(String hint) => 'No download page for this one; install it like this: $hint';
  @override
  String settingsOpenUrlFailed(String url, String? hint) =>
      'Could not open a browser; the address is $url${hint == null ? '' : ' ($hint)'}';
  @override
  String settingsInstalledVersion(String? version) => 'Installed${version == null ? '' : ' $version'}';
  @override
  String settingsWriteErrorNote(String writeError) =>
      'The automatic configuration was not written: $writeError. The installed directory has already '
      'been filled into "install directory" below; press "save directory", turn on "enable the '
      'built-in protocol side", and you are done (also takes effect after a restart).';
  @override
  String settingsChainSince(String when) => 'since $when';
  @override
  String settingsChainUnreadableDetail(String path) =>
      'The file is there ($path) but the endpoint could not be parsed — someone has to fix it';
  @override
  String settingsProtocolToggled(bool on, bool restart) =>
      '${on ? 'Enabled' : 'Disabled'} the built-in protocol side'
      '${restart ? ' (takes effect after restart)' : ''}';
  @override
  String settingsInstallDirSaved(String saved, bool restart) =>
      'Install directory saved: $saved${restart ? ' (takes effect after restart)' : ''}';
  @override
  String settingsProtocolActionFailed(bool start, String err) =>
      '${start ? 'Start' : 'Stop'} request failed: $err';
  @override
  String settingsWebhookFileNote(String file) =>
      'Credential file: $file (only its sha256 is on disk: the plaintext appeared on screen only '
      'when you pressed the button, and nobody can read it back afterwards).';
  @override
  String settingsTrustFullBody(String consequence) => 'After switching to full trust: $consequence';
  @override
  String settingsPolicyListCount(int count) => 'By list ($count items)';
  @override
  String get settingsUnknownReason => 'unknown reason';
  @override
  String get settingsSeeOfficialDocs => 'see the official documentation';
  @override
  String get settingsWebhookCurlTokenPlaceholder => '<dedicated credential>';
  @override
  String get settingsWebhookCurlSampleText => 'Disk is almost full';
  @override
  String settingsDepsSuggested(int count) => '$count recommended installation(s)';
  @override
  String settingsDepPipReady(String version) => 'pip $version (she can pip install extra capabilities herself)';
  @override
  String settingsDepPurposeImpact(String purpose, String impact) => '$purpose. $impact';
  @override
  String settingsInstallTitle(String label) => 'Install $label';
  @override
  String settingsPolicySave(int count) => 'Save ($count items)';
  @override
  String settingsInstallHead(bool ok, String? version, bool configured) => ok
      ? 'Installed${version == null ? '' : ' $version'}${configured ? ', configured with it; restart and it is ready.' : ', but the automatic configuration did not go through.'}'
      : 'Install failed';
  @override
  String get chanSourceQqOfficial => 'QQ Official';
  @override
  String get chanEventInboundWake => 'Inbound wake';
  @override
  String get chanEventFile => 'File event';
  @override
  String get chanAlertExit => 'alert exit';
  @override
  String get chanQqAppIdHint => 'The bot ID from the Open Platform console.';
  @override
  String get chanQqAppSecretHint => 'The secret exchanged for an access_token.';
  @override
  String get chanOneBotTokenHint => 'Required when the protocol side enables auth.';
  @override
  String get chanQqApiBaseLabel => 'API base URL';
  @override
  String get chanQqUrlHint => 'Leave empty to use the official URL; http(s) only.';
  @override
  String get chanQqTokenUrlLabel => 'Token URL';
  @override
  String get chanQqGatewayUrlLabel => 'Gateway override URL';
  @override
  String get chanQqGatewayHint => 'Leave empty to fetch it from the token endpoint; ws(s) only.';
  @override
  String get chanOneBotWsLabel => 'Protocol-side ws URL';
  @override
  String get chanOneBotWsHint => 'Forward WebSocket port of the protocol side; must be ws:// or wss://.';
  @override
  String get chanAlertWebhookLabel => 'Alert exit webhook';
  @override
  String get chanAlertWebhookHint => 'Leave empty and alerts only reach the log — nothing is sent out.';
  @override
  String get chanAlertRateLabel => 'Repeat-alert rate-limit window';
  @override
  String get chanAlertRateHint => 'In minutes.';
  @override
  String get chanEndpointLabel => 'Endpoint host:port';
  @override
  String get chanListenLabel => 'Inbound listen address';
  @override
  String get chanQqTitle => 'QQ Official Bot API';
  @override
  String get chanQqHint => "Fill in AppID and AppSecret below — they go into this machine's data/.keys.json, not config.json; "
      'both are needed before it connects.';
  @override
  String get chanOneBotHint => 'Forward WebSocket of the protocol side (NapCat / go-cqhttp); fill in access_token below.';
  @override
  String get chanOneBotBlurb => 'Protocol-side forward WebSocket';
  @override
  String get chanHookTitle => 'Webhook and file watch';
  @override
  String get chanHookHint => 'With no exit URL, alerts are written to the log only.';
  @override
  String get chanHookBlurb => 'Alert exit · inbound listen';
  @override
  String get chanConfigReadFailed => 'Could not read the config';
  @override
  String get chanKeysReadFailed => 'Could not read the key status';
  @override
  String chanClearSecretTitle(String label) =>
      'Clear key · $label';
  @override
  String get chanClearSecretBody => 'You will need to fill it in again.';
  @override
  String chanClearFailed(String reason) =>
      'Could not clear it: $reason';
  @override
  String chanNotANumber(String field) =>
      '$field must be a number — nothing was saved';
  @override
  String get chanNothingToSave => 'Nothing to save';
  @override
  String chanSavedFieldCount(int count) =>
      "$count setting${count == 1 ? '' : 's'}";
  @override
  String chanSavedSecretCount(int count) =>
      "$count key${count == 1 ? '' : 's'}";
  @override
  String get chanSavedRestartSuffix => ', takes effect after a restart';
  @override
  String get chanSavedLiveSuffix => ', takes effect on the next connection';
  @override
  String chanSaved(String parts, String suffix) =>
      'Saved $parts$suffix';
  @override
  String get chanReloaded => 'Reloaded from the active config';
  @override
  String chanTestDelivered(String url) =>
      "Delivered: this test message reached ${url.isEmpty ? 'the alert exit' : url}";
  @override
  String chanTestNotDelivered(String reason) =>
      "Not delivered${reason.isEmpty ? ': the exit did not answer' : ': $reason'}";
  @override
  String chanTestFailed(String reason) =>
      'The test failed: $reason';
  @override
  String get chanStatusUnknown => 'Status unknown';
  @override
  String get chanStatusUnknownNote => 'The active config has not been read yet, so the channel status is unknown.';
  @override
  String get chanStatusOff => 'Disabled';
  @override
  String get chanStatusOffNote => 'Switched off in the config, so the adapter never connects.';
  @override
  String get chanStatusOn => 'Enabled';
  @override
  String get chanStatusOnNote => 'No channel events yet.';
  @override
  String chanStatusRunningNote(String at, String suffix) =>
      'Latest channel event $at$suffix.';
  @override
  String get chanStatusNoExit => 'No exit configured';
  @override
  String get chanStatusNoExitNote => 'The exit URL is empty, so alerts only go to the log and are never sent out.';
  @override
  String get chanStatusExitOn => 'Exit configured';
  @override
  String get chanStatusExitOnNote => 'Nothing triggered yet: no inbound wake and no file event.';
  @override
  String chanStatusHookRunningNote(String tag, String at) =>
      'Latest event: $tag at $at.';
  @override
  String chanFootnoteError(String error) =>
      'Could not read channel activity ($error). Status is decided by the config file.';
  @override
  String chanFootnoteCount(int count) =>
      'Channel activity comes from the last 50 channel events ($count received); status is decided from '
      'them.';
  @override
  String get chanPageTitle => 'Message adapters';
  @override
  String get chanPageSubtitle => 'Inbound channels, alert exit and file watch';
  @override
  String get chanGuideText => 'No message channel is enabled yet.';
  @override
  String get chanGuideAction => 'Set up QQ Official';
  @override
  String get chanGuideHint => 'Switches and endpoint settings live in the "channel config" card on this page: they are written to '
      'config.json and taken over after a restart.';
  @override
  String get chanListHeader => 'Channels';
  @override
  String get chanReloadAction => 'Reload';
  @override
  String get chanConfigAction => 'Configure';
  @override
  String get chanConfigUnavailable => 'Config unavailable';
  @override
  String get chanConfigUnavailableHint => 'The local service /api/config returned no config.';
  @override
  String get chanBackToList => 'Channel list';
  @override
  String get chanRecentActivity => 'Recent activity';
  @override
  String get chanMentionTitle => 'What she is called';
  @override
  String get chanMentionNote => 'When someone skips the @ and just says one of these words in a group, the framework treats it as '
      'calling her and brings it to her just like an @.';
  @override
  String get chanMentionEmpty => 'Only the platform @ counts right now: in groups, people who say her name without an @ are not heard.';
  @override
  String get chanMentionHint => 'Takes effect immediately (the next message is judged by the new list); no restart needed.';
  @override
  String chanMentionSaveFailed(String problem) =>
      'Could not write it: $problem';
  @override
  String get chanMentionCleared => 'Set to "only an @ counts"';
  @override
  String chanMentionSaved(String words) =>
      'Noted: $words';
  @override
  String get chanContactsTitle => 'Conversation contacts';
  @override
  String get chanContactsNote => 'QQ gives no nicknames; tell her who is who here.';
  @override
  String get chanDetailsLabel => 'Details';
  @override
  String get chanContactsDetail => 'In a group chat only an @ or her name reaches the conversation; whether anything else arrives '
      'depends on the official Bot message permission—whatever the platform pushes to us still lands in '
      'the inbox. Anyone who @-ed her in a group is registered under that group automatically (so she sees '
      'more than an openid) — expand to rename. The note she keeps (the part in brackets after the name) is '
      'shown here only: it is not the name and cannot be edited —that field saves the name; the note stays '
      'in her own memory.';
  @override
  String get chanContactsEmpty => 'No conversation has talked to her yet. Once someone says something, that conversation shows up here.';
  @override
  String get chanGroupSceneLabel => 'Group chats';
  @override
  String get chanGroupSceneHard => 'Hard refusal: no local tools';
  @override
  String get chanGroupSceneSoft => 'Soft warning: spell out the risk, she decides';
  @override
  String get chanContactsRestartNote => 'Takes effect only after the main process restarts (the contact table is not hot-reloaded).';
  @override
  String chanContactLine(String chat, String when) =>
      '$chat · last seen $when';
  @override
  String chanContactNote(String note) =>
      'Note: $note';
  @override
  String get chanContactHint => 'Who is this (leave empty to keep it unnamed)';
  @override
  String get chanContactSaveTooltip => 'Save this name';
  @override
  String get chanMembersCollapse => 'Hide group members';
  @override
  String chanMembersExpand(int count) =>
      'Show group members ($count)';
  @override
  String get chanWarnExempt => 'Framework warning: exempt';
  @override
  String get chanWarnOn => 'Framework warning: on';
  @override
  String get chanMemberSaveTooltip => 'Save this name (active next turn)';
  @override
  String chanMemberNameTooltip(String who) =>
      'Give $who a name';
  @override
  String get chanExemptSessionOn => 'Framework warnings exempted for this direct chat';
  @override
  String get chanExemptSessionOff => 'Framework warnings restored for this direct chat';
  @override
  String get chanExemptMemberOn => 'Framework warnings exempted for this person';
  @override
  String get chanExemptMemberOff => 'Framework warnings restored for this person';
  @override
  String get chanGroupSceneHardToast => 'Group chats switched to hard refusal: she cannot touch this machine from a group';
  @override
  String get chanGroupSceneSoftToast => 'Group chats switched back to soft warning: the framework warns her and she decides';
  @override
  String chanToggleFailed(String err) =>
      'Could not switch it: $err';
  @override
  String get chanNameRequired => 'The name cannot be empty';
  @override
  String chanMemberSaved(String name) =>
      'Saved as "$name" — that is what she will call him next turn';
  @override
  String get chanContactCleared => 'Cleared the name of this conversation';
  @override
  String chanContactSaved(String name) =>
      'Saved as "$name" — after the main process restarts she will know this conversation by that name';
  @override
  String get chanConfigTitle => 'Channel config';
  @override
  String get chanNeedsRestart => 'Needs restart';
  @override
  String get chanConfigNote => 'Written to config.json and taken over after a restart; clearing a field means back to the default.';
  @override
  String get chanConfigDetail => 'Secret fields take the value directly: it lives in the local key file, not in '
      'config.json. Environment variables take precedence over these files.';
  @override
  String get chanTestAlert => 'Test the alert exit';
  @override
  String chanSaveWithCount(int count) =>
      "Save ($count change${count == 1 ? '' : 's'})";
  @override
  String get chanEnableLabel => 'Enable this channel';
  @override
  String get chanEnableNoteOn => 'Connects and starts receiving messages after a restart.';
  @override
  String get chanEnableNoteOff => 'Off: the adapter does not connect.';
  @override
  String get chanSecretHintConfigured => 'Already set — paste a new value to replace it';
  @override
  String chanSecretHintPaste(String label) =>
      'Paste $label';
  @override
  String chanSecretConfigured(String mask) =>
      'Set $mask';
  @override
  String get chanNumberHint => 'Number';
  @override
  String get chanNotSetHint => 'Not set';
  @override
  String chanReadonlyFold(int count) =>
      'Read-only ($count)';
  @override
  String get chanChannelIdLabel => 'Channel id';
  @override
  String get chanFeedEmpty => 'No channel activity yet — records appear once a message, wake or delivery comes in.';
  @override
  String get chanSourceExternal => 'External';
  @override
  String get chanEventGeneric => 'event';
  @override
  String get chanJoinWords => ', ';
  @override
  String get schedNotProjection => 'The response is not a projection';
  @override
  String get schedCancelTitle => 'Cancel this plan?';
  @override
  String schedCancelBody(String timerId) =>
      'Timer $timerId will be cancelled: when the time comes it will no longer wake her up.\nThe '
      'cancellation goes into the log (timer/cancelled); if you cancel by mistake she can only schedule it '
      'again.\nTo change the time or the content, take this route too: cancel this one, then tell her a new '
      'one ("new plan").';
  @override
  String get schedCancelPlan => 'Cancel plan';
  @override
  String schedCancelled(String timerId) =>
      'Cancelled $timerId: it will not wake her again';
  @override
  String schedCancelFailed(String timerId, String err) =>
      'Could not cancel $timerId: $err';
  @override
  String schedCancelFailedShort(String err) =>
      'Could not cancel it: $err';
  @override
  String schedBuilt(String when, String note) =>
      'Scheduled: $when · $note';
  @override
  String get schedBuiltToast => 'Plan created';
  @override
  String get schedNoServerTime => '(the server returned no time)';
  @override
  String schedRecurringWithNext(String label, String when) =>
      'Recurring $label (next at $when)';
  @override
  String get schedSearchTitle => 'Search plans';
  @override
  String get schedSearchHint => 'Title / what to do / why';
  @override
  String get schedSearch => 'Search';
  @override
  String get schedPageTitle => 'Upcoming plans';
  @override
  String get schedPageSubtitle => 'Schedules, reminders and her own plans in one place.';
  @override
  String get schedBackToThisWeek => 'This week';
  @override
  String get schedNewPlan => 'New plan';
  @override
  String get schedLoading => 'Reading the plans she has queued…';
  @override
  String schedLoadFailed(String error) =>
      'Could not read the schedule: $error';
  @override
  String get schedLoadHint => 'This page reads the timers in the /api/projection payload: try refreshing; if it never loads, the '
      'main process has a problem.';
  @override
  String get schedStatThisWeek => 'This week';
  @override
  String get schedStatThisWeekNote => 'One-off and recurring';
  @override
  String get schedStatWaiting => 'Waiting to fire';
  @override
  String get schedStatWaitingNote => 'She re-judges at the time';
  @override
  String get schedStatSelfWork => 'Agent at work';
  @override
  String get schedStatSelfWorkNote => 'You may not hear from her';
  @override
  String get schedStatDrafts => 'Ideas to share';
  @override
  String get schedStatDraftsNote => 'Her drafts are not stored yet';
  @override
  String get schedCalendarTitle => 'Week';
  @override
  String get schedPrevWeek => 'Previous week';
  @override
  String schedWeekRange(int month, int day, int endDay) =>
      '$month/$day – $endDay';
  @override
  String get schedNextWeek => 'Next week';
  @override
  String schedUnplaceable(int count) =>
      '$count recurring entries cannot be drawn this week (they are in the list)';
  @override
  String schedTimeRecurring(String hour, String minute) =>
      '$hour:$minute · recurring';
  @override
  String schedMonthDay(int month, int day) =>
      '$month/$day';
  @override
  String get schedRecurringPill => 'Recurring';
  @override
  String get schedWeekEmpty => 'No plans this week.';
  @override
  String schedWeekHidden(int hidden) =>
      '$hidden more this week do not fit — see the list on the right';
  @override
  String get schedListTitle => 'Plan list';
  @override
  String schedFilterDay(String day) =>
      'Only $day';
  @override
  String schedFilterQuery(String query) =>
      'Matching "$query"';
  @override
  String schedFilterCount(int count) =>
      '$count entries';
  @override
  String get schedShowAll => 'Show all';
  @override
  String get schedClearSearch => 'Clear search';
  @override
  String get schedActionGoneHint => 'It may have fired or been cancelled already; refresh to see the latest list.';
  @override
  String get schedListNoMatch => 'No plans match this.';
  @override
  String get schedListEmpty => 'Nothing is scheduled yet.';
  @override
  String get schedListEmptyHint => 'A plan is only a chance — when the time comes she first checks whether it is still worth doing, and '
      'skips it if not.';
  @override
  String get schedDetailPlaceholder => 'Pick a plan';
  @override
  String get schedFieldWhen => 'When';
  @override
  String schedDetailRecurring(String label) =>
      'Recurring $label (the server reschedules the next one)';
  @override
  String schedDetailTimeSuffix(String label) =>
      ' · recurring $label';
  @override
  String get schedFieldWhy => 'Why it was planned';
  @override
  String get schedFieldWhat => 'What to do';
  @override
  String get schedFieldWhere => 'Where to say it';
  @override
  String get schedFieldDuration => 'Duration';
  @override
  String schedMinutes(Object? dur) =>
      '$dur min';
  @override
  String schedMinutesDefault(Object? dur) =>
      '$dur min (default: this entry has no dur)';
  @override
  String get schedFieldAfter => 'After it fires';
  @override
  String get schedUnwritten => 'Not set';
  @override
  String schedWakeReceipt(String text) =>
      'Said one line to her: "$text"';
  @override
  String get schedSeeChat => 'See her reaction in chat';
  @override
  String schedBuiltReceipt(String text) =>
      '$text — you scheduled this one yourself: at that time she will read your reason.';
  @override
  String get schedChoiceNotify => 'Remind me at that time';
  @override
  String get schedChoiceSelf => 'She starts on it';
  @override
  String get schedChoiceDraft => 'Save a draft first';
  @override
  String get schedKindMemoryMaintain => 'Daily memory tidy-up';
  @override
  String get schedKindWait => 'something she waits for';
  @override
  String get schedUntitled => 'Untitled plan';
  @override
  String get schedStatusDraft => 'Draft to share';
  @override
  String get schedStatusRecurring => 'Recurring task';
  @override
  String get schedStatusWaiting => 'Waiting';
  @override
  String get schedWakeDeduped => 'Exactly the same as what she just got, so it was treated as a duplicate and ignored — try again in '
      'a few seconds';
  @override
  String get schedViewWeek => 'Week';
  @override
  String get schedViewList => 'List';
  @override
  String schedRecurringLine(String label) =>
      'Recurring · $label';
  @override
  String get schedChorePill => 'her chores';
  @override
  String schedWillSay(String label) =>
      'will speak in $label';
  @override
  String get schedErrDate => '"Date" not understood: write today / tomorrow / 2026-10-20.';
  @override
  String get schedErrClock => '"Time" must look like 20:00 (24-hour clock).';
  @override
  String get schedErrWhat => '"What to do" is required: it is the line she sees at that time.';
  @override
  String get schedErrDuration => '"Roughly how long" takes a number of minutes (leave it empty and it is taken as half an hour).';
  @override
  String get schedRepeatDaily => 'Every day';
  @override
  String get schedRepeatWeekly => 'Every week';
  @override
  String get schedErrBrief => 'Write one line for her to schedule (it is exactly what she will read).';
  @override
  String schedWakePrefix(String text) =>
      'Please schedule a plan for me: $text';
  @override
  String schedWakeFailed(String err) =>
      'Could not deliver that line to her: $err';
  @override
  String schedCreateFailed(String err) =>
      'That plan could not be created: $err';
  @override
  String get schedCardLead => 'It is usually better to let her create it: she writes the "why" herself and re-checks at the time '
      'whether it is still worth doing. Creating it yourself is for when you are in a hurry.';
  @override
  String get schedPathHer => 'Let her create it';
  @override
  String get schedPathDirect => 'Create it myself';
  @override
  String get schedLater => 'Later';
  @override
  String get schedSending => 'Sending…';
  @override
  String get schedCreateDirect => 'Create';
  @override
  String get schedLetHerSchedule => 'Send to her';
  @override
  String get schedFieldBrief => 'One line for her';
  @override
  String get schedBriefHint => 'Next Monday at nine, remind me to look at the weekly plan';
  @override
  String get schedBriefNote => 'This line goes straight to her and she schedules it.';
  @override
  String get schedFieldDay => 'Which day';
  @override
  String get schedDayHint => 'today / tomorrow / 2026-10-20';
  @override
  String get schedFieldClock => 'What time';
  @override
  String get schedFieldRepeat => 'Repeat';
  @override
  String get schedRepeatOnceChoice => 'Only this once';
  @override
  String get schedRepeatWeeklyChoice => 'Every week (this day)';
  @override
  String get schedFieldWhatToDo => 'What to do';
  @override
  String get schedWhatHint => 'Check whether the report is final';
  @override
  String get schedMoreOptions => 'More options (title, category, who to tell…)';
  @override
  String get schedFieldTitle => 'Title';
  @override
  String get schedTitleHint => 'Leave it empty and the "what to do" line is used';
  @override
  String get schedFieldWhyInput => 'Why schedule it';
  @override
  String get schedWhyHint => 'It is due on Wednesday and I am afraid I will forget';
  @override
  String get schedFieldDurationInput => 'Roughly how long (minutes)';
  @override
  String get schedFieldCategory => 'Category';
  @override
  String get schedNoCategory => 'No category';
  @override
  String get schedFieldSid => 'Tell anyone?';
  @override
  String get schedNoSid => 'Tell nobody';
  @override
  String get schedPastWarning => 'That moment has already passed: if you save it she is woken once right away.';
  @override
  String get schedCreateNote => 'Once created it is a real plan: at that time she sees the line you wrote.';
  @override
  String schedSidWithName(String name, String short) =>
      '$name ($short)';
  @override
  String schedMonthDayRaw(Object month, Object day) =>
      '$month/$day';
  @override
  String schedWhenStamp(int month, int day, String time) =>
      '$month/$day · $time';
  @override
  String get schedWeekdayMon => 'Mon';
  @override
  String get schedWeekdayTue => 'Tue';
  @override
  String get schedWeekdayWed => 'Wed';
  @override
  String get schedWeekdayThu => 'Thu';
  @override
  String get schedWeekdayFri => 'Fri';
  @override
  String get schedWeekdaySat => 'Sat';
  @override
  String get schedWeekdaySun => 'Sun';
  @override
  String schedCronDaily(String time) =>
      'Every day at $time';
  @override
  String schedCronRange(String from, String to) =>
      '$from to $to';
  @override
  String schedCronWeekly(String weekdays, String time) =>
      'Every $weekdays at $time';
  @override
  String get schedCatWork => 'Work / study';
  @override
  String get schedCatPersonal => 'Company / talk';
  @override
  String get schedCatLife => 'Daily life';
  @override
  String get schedCatRoutine => 'Routine';
  @override
  String get schedActionSelf => 'works on it herself';
  @override
  String get schedActionNotify => 'reminds you';
  @override
  String get schedActionDraft => 'saves a draft';
  @override
  String get extSectionSkills => 'Skills';
  @override
  String get extSectionSkillsBlurb => 'Task knowledge packs: a SKILL.md says when to use it and how';
  @override
  String get extSectionMcpBlurb => 'External tool servers: an executable is started on demand, and its tools are reached through the '
      'built-in mcp tool';
  @override
  String get extSectionTools => 'Built-in tools';
  @override
  String get extSectionToolsBlurb => 'Tools that ship with the app: switch them by group; off means gone from her list';
  @override
  String get extSectionHooksBlurb => 'Execution hooks: an external command can be plugged in at PreToolUse / PostToolUse / Wake';
  @override
  String get extSectionPlugins => 'Plugins';
  @override
  String get extSectionPluginsBlurb => 'Review Skills, Hooks and MCP contributions by package hash; manual lifecycle changes take effect after restart';
  @override
  String get extPluginInstall => 'Install plugin';
  @override
  String get extPluginInstallTitle => 'Install a plugin from a local directory';
  @override
  String get extPluginSourceDir => 'Plugin directory (absolute path)';
  @override
  String get extPluginSourceHint => r'For example C:\packages\demo or /home/me/demo';
  @override
  String get extPluginAbsoluteRequired => 'Enter an absolute local directory';
  @override
  String get extPluginEmpty => 'No plugins installed';
  @override
  String get extPluginEmptyHint => 'Install a local directory, then review its package hash and permissions. Installing neither trusts nor enables it.';
  @override
  String extPluginSummary(int count) => '$count plugin packages';
  @override
  String extPluginStat(int count) => '$count plugin packages';
  @override
  String extPluginState(String state) => switch (state) {
        'untrusted' => 'Review required',
        'disabled' => 'Disabled',
        'enabled' => 'Enabled',
        'invalid' => 'Invalid',
        'quarantined' => 'Quarantined',
        'probing' => 'Probing',
        _ => state,
      };
  @override
  String get extPluginRestartRequired => 'Takes effect after restart';
  @override
  String extPluginContributions(int skills, int hooks, int mcp) => 'Skills $skills · Hooks $hooks · MCP $mcp';
  @override
  String extPluginVersionHash(String version, String hash) => 'Version $version · Hash $hash';
  @override
  String get extPluginPermissionsLabel => 'Permissions';
  @override
  String get extPluginProblemsLabel => 'Problems';
  @override
  String get extPluginReview => 'Review and trust';
  @override
  String extPluginReviewTitle(String id) => 'Review plugin $id';
  @override
  String extPluginReviewBody(String id, String hash) =>
      'Check the package hash $hash, contributions and permissions for $id. Plugin contributions are trusted code, not a security sandbox; confirmation binds only this hash.';
  @override
  String get extPluginEnable => 'Enable';
  @override
  String get extPluginDisable => 'Disable';
  @override
  String extPluginEnableTitle(String id) => 'Enable plugin $id?';
  @override
  String extPluginDisableTitle(String id) => 'Disable plugin $id?';
  @override
  String get extPluginRestartBody => 'Manual lifecycle changes update the next effective state only. Restart the main process to apply them; current contributions do not change immediately.';
  @override
  String get extPluginInstalledToast => 'Installed and awaiting review; it is not trusted or enabled yet';
  @override
  String extPluginConfirmedToast(String id) => 'Confirmed the current hash of $id; enable it separately';
  @override
  String extPluginRestartToast(String action, String id) => '$id $action; takes effect after restart';
  @override
  String extPluginFailed(String reason) => 'Plugin operation failed: $reason';
  @override
  String extPluginCircuit(String contribution, int count) => 'Failed contribution $contribution · $count consecutive failures';
  @override
  String extPluginCircuitReason(String reason) => 'Failure reason: $reason';
  @override
  String extPluginRetryAt(String at) => 'Next retry: $at';
  @override
  String get extBadResponse => 'The response shape is not recognized';
  @override
  String get extPageSubtitle => 'Skills, local plugins, MCP servers, built-in tools and hooks';
  @override
  String get extListHeader => 'Extensions';
  @override
  String get extDataReadFailed => 'Could not read the data';
  @override
  String extBadStructure(Object? endpoint) =>
      'The local service /api/$endpoint returned an unexpected shape.';
  @override
  String get extBackToList => 'Extension list';
  @override
  String get extRescan => 'Scan folder';
  @override
  String get extNewSkill => 'New skill';
  @override
  String extSkillsSummary(int active, int pending, int tokens) =>
      '$active active · $pending pending · catalog $tokens token';
  @override
  String get extNoSkills => 'No skill installed yet.';
  @override
  String get extNoSkillsHint => 'A skill is a folder: skills/<name>/SKILL.md. After it is found it still has to pass the trust gate '
      '(you confirm here) before it enters the catalog.';
  @override
  String get extPendingTitle => 'Pending';
  @override
  String get extPendingHint => 'Nothing enters the catalog unconfirmed — however good the description is, she cannot see it yet.';
  @override
  String get extActiveTitle => 'Active';
  @override
  String get extActiveHint => 'In the catalog: she sees these names and descriptions every turn.';
  @override
  String get extActiveEmpty => 'No confirmed skill yet — the pending ones show up here once confirmed.';
  @override
  String get extIgnoredTitle => 'Ignored';
  @override
  String get extIgnoredHint => 'Local note only (stored in data/skills-ignored.json): no event is written and it never enters the '
      'catalog; it will not follow you to another machine.';
  @override
  String get extRejectedTitle => 'Rejected folders';
  @override
  String get extRejectedHint => 'Invalid frontmatter or a duplicate name: she cannot read these folders. Fix the SKILL.md and scan '
      'again.';
  @override
  String extRejectedLine(Object? dir, Object? reason) =>
      '$dir: $reason';
  @override
  String get extGuideSkillPath => 'The skill lives at <project root>/skills/<name>/SKILL.md: the folder name is the skill name '
      '(lowercase letters, digits, hyphens).';
  @override
  String get extGuideSkillTrust => 'After scanning it still has to pass the trust gate — only when you press "confirm" and '
      'skill/installed is written does it enter the catalog.';
  @override
  String get extInCatalogBadge => 'In catalog';
  @override
  String get extFieldDescription => 'Description';
  @override
  String get extFieldSkillFile => 'Skill file';
  @override
  String get extFieldSizeHash => 'Size and hash';
  @override
  String extSizeHash(int bytes, String short) =>
      '$bytes bytes · $short';
  @override
  String get extFieldTrustDetail => 'Trust details';
  @override
  String get extActionRestore => 'Restore: put it back under pending';
  @override
  String get extActionRetire => 'Disable: pull it out of the catalog (files untouched, restorable any time)';
  @override
  String get extActionDelete => 'Delete: move the whole skill folder to the trash (restorable, not rm -rf)';
  @override
  String get extActionConfirm => 'Confirm: write skill/installed and the skill enters the catalog';
  @override
  String get extActionIgnore => 'Ignore: put it under "ignored" — no event, no catalog';
  @override
  String extConfirmedToast(String name) =>
      'Confirmed: $name is now in the catalog';
  @override
  String extConfirmFailed(String reason) =>
      'Could not confirm: $reason';
  @override
  String extIgnoredToast(String name) =>
      'Ignored: $name (local note only)';
  @override
  String extRestoredToast(String name) =>
      'Back under pending: $name';
  @override
  String extOpFailed(String reason) =>
      'That did not work: $reason';
  @override
  String extRetireTitle(String name) =>
      'Disable skill · $name';
  @override
  String get extRetireBody => 'Disable means pulling it into "ignored": she will not see it from the next turn on (it is out of '
      'the catalog). Not one byte of the skill file changes; press "restore" to put it back.';
  @override
  String get extDisable => 'Disable';
  @override
  String extDeleteSkillTitle(String name) =>
      'Delete skill · $name';
  @override
  String get extDeleteBody => 'The whole folder is moved to the trash (<dataDir>/trash/), which is "not rm -rf": the contents are '
      'untouched, so moving that copy back restores it. After deleting she will not see it from the next '
      'turn on — if you only want it out of sight for now, use "disable".';
  @override
  String get extDelete => 'Delete';
  @override
  String extDeletedToast(String name) =>
      'Deleted: $name is in the trash (contents untouched, move it back to restore)';
  @override
  String extDeleteFailed(String reason) =>
      'Could not delete it: $reason';
  @override
  String get extCreateHint => 'A spec-compliant skeleton is generated at skills/<name>/SKILL.md and then stops at pending —she '
      'cannot see it before you confirm. The name may only use lowercase letters, digits and hyphens (the '
      'folder name is the skill name).';
  @override
  String get extFieldSkillName => 'Skill name';
  @override
  String get extSkillNameHint => 'e.g. morning-review';
  @override
  String get extSkillNameInvalid => 'Lowercase letters, digits and hyphens only';
  @override
  String get extFieldOneLineDesc => 'One-line description';
  @override
  String get extOneLineDescHint => 'Say what it does and when to use it — this is the only trigger she can see';
  @override
  String extSkillCreatedToast(String path) =>
      '''Created ${path.isEmpty ? 'SKILL.md' : path}; it waits for your confirmation under "pending"''';
  @override
  String extCreateSkillFailed(String reason) =>
      'Could not create it: $reason';
  @override
  String get extAddServer => 'Add server';
  @override
  String extMcpSummary(int servers, int running, int tools, String pendingPart) =>
      "$servers server${servers == 1 ? '' : 's'} · $running running · $tools "
      "tool${tools == 1 ? '' : 's'}$pendingPart";
  @override
  String extPendingGrants(int count) =>
      'Waiting for you: requests she filed ($count)';
  @override
  String extUnpreparedGrants(int count) =>
      'Not picked up yet ($count)';
  @override
  String get extUnpreparedTitle => 'These requests have not been picked up yet';
  @override
  String get extUnpreparedHint => 'The framework scans the request folder once per tick. Ones just written wait for the next tick; '
      'ones that stay here have probably failed validation— that tick records an outcome (the rejection '
      'reason is under "answered"), and the file itself is never deleted.';
  @override
  String get extConfigProblems => 'Config problems';
  @override
  String get extConfigProblemsHint => 'Declared but unreadable: fix mcp.servers in config.json and reload.';
  @override
  String get extAnsweredTitle => 'Answered requests';
  @override
  String get extAnsweredHint => 'The requests she filed and how they ended. Once approved the framework writes config.json;"approved '
      'but not installed" is written here as it is (that is not the same as "rejected").';
  @override
  String get extGuideMcp1 => 'An MCP server is just an executable: the main process starts it on demand and reclaims it after 5 '
      'idle minutes, so "not running" is the normal state.';
  @override
  String get extGuideMcp2 => 'Its tools are untrusted by default (sideEffect = destructive): declare it explicitly in config.json '
      'to downgrade that, and a restart of the main process is needed for the change to take over.';
  @override
  String get extGuideMcp3 => 'She can add and remove them herself (by filing a request, see "waiting for you" above) — you just '
      'approve or reject it here.';
  @override
  String extGrantRejectedToast(String suffix) =>
      'Rejected$suffix — she gets this decision on her next tick';
  @override
  String extGrantApprovedToast(String suffix) =>
      'Approved and written to the config$suffix';
  @override
  String extGrantApprovedFailedToast(String failure) =>
      'Approved, but running it failed: $failure';
  @override
  String extGrantDecideFailed(String reason) =>
      'Could not record that decision: $reason';
  @override
  String get extGrantAfterSkillInstall =>
      'Once approved: installed into skills/<name>; nothing runs automatically, she has to read it.';
  @override
  String get extGrantAfterSkillRemove =>
      'Once approved the whole directory moves to the trash (data/trash/); it can be moved back.';
  @override
  String get extGrantExecOkSkillInstall => 'The framework installed it into the skill root';
  @override
  String get extGrantExecOkSkillRemove => 'Moved to the trash';
  @override
  String get extGrantLabelSkillInstall => 'Install';
  @override
  String grantInboxActionMcpAdd(String name) => 'Add an MCP server: $name';
  @override
  String grantInboxActionMcpRemove(String name) => 'Remove the MCP server: $name';
  @override
  String grantInboxActionSkillInstall(String name) => 'Install a skill: $name';
  @override
  String grantInboxActionSkillRemove(String name) => 'Remove the skill: $name';
  @override
  String grantInboxActionUnknown(String name) => 'She filed a request: $name';
  @override
  String grantInboxCommand(String command) => 'Command: $command';
  @override
  String grantInboxRiskSkillScripts(int count) =>
      'Ships $count executable script(s); nothing runs automatically — approving only installs it into the skill root.';
  @override
  String get grantInboxRiskSkillInstall =>
      'Nothing runs automatically: approving only installs it into the skill root (skills/); she uses it by reading it.';
  @override
  String get grantInboxRiskSkillRemove =>
      'The whole folder moves to the trash (data/trash/) and can be moved back.';
  @override
  String get grantInboxRiskMcpAdd =>
      'Approving writes it into the config (mcp.servers[] in config.json); it then launches a local process.';
  @override
  String get grantInboxRiskMcpRemove =>
      'Removes this entry from the config (mcp.servers[] in config.json).';
  @override
  String get grantInboxRiskUnknown => 'Only the details say what this request does.';
  @override
  String get grantInboxSource => 'She wrote this request herself';
  @override
  String get grantInboxHighRiskBadge => 'High risk';
  @override
  String get grantInboxApprove => 'Approve';
  @override
  String get grantInboxApproveHighRisk => 'Review and approve';
  @override
  String get grantInboxReject => 'Reject';
  @override
  String get grantInboxDetails => 'Details';
  @override
  String get grantInboxWorking => 'Working…';
  @override
  String get grantInboxCollapseTooltip => 'Collapse (it is still waiting; click to expand)';
  @override
  String get grantInboxExpandTooltip => 'Expand the pending cards (approve and reject live there)';
  @override
  String get grantInboxOpenExtensions => 'Open Extensions';
  @override
  String get grantInboxDetailsClose => 'Close details';
  @override
  String grantInboxHeader(int count) => 'Waiting for you · $count';
  @override
  String grantInboxMore(int count) => '$count more waiting for you';
  @override
  String grantInboxCollapsed(int count) => '$count waiting for you';
  @override
  String grantInboxFailed(String reason) => 'Could not record that decision: $reason';
  @override
  String get grantUnreadableTitle => 'One request cannot be read';
  @override
  String grantUnreadableBody(String id, String why) => '$id: $why';
  @override
  String grantUnreadableMore(int count) => ' ($count more)';
  @override
  String trayPendingItem(int count) => '$count waiting for approval';
  @override
  String trayPendingTooltip(String name, int count) => '$name · $count waiting for approval';
  @override
  String get extNoServers => 'No MCP server configured yet. Press the button in the page header to add one, and give it a launch '
      'command.';
  @override
  String get extNoServersHint1 => 'A server is just an executable: the main process starts it on demand and reclaims it after 5 idle '
      'minutes, so "not running" is the normal state.';
  @override
  String get extNoServersHint2 => 'Its tools are treated as destructive by default; declare it explicitly in config.json to downgrade '
      'that, and a restart of the main process is needed for the change to take over.';
  @override
  String get extDisabledBadge => 'Disabled';
  @override
  String extToolCountBadge(int count) =>
      '$count tools';
  @override
  String get extCollapseServer => 'Collapse this server';
  @override
  String get extExpandServer => 'Expand this server';
  @override
  String get extNoDesc => '(nothing says what it does — she only sees this name in the index)';
  @override
  String extSelfReportedDesc(String desc) =>
      '$desc (self-reported)';
  @override
  String get extFieldCommand => 'Launch command';
  @override
  String get extFieldEnv => 'Environment variables';
  @override
  String extLastRun(String at, String suffix) =>
      'Last run: $at$suffix';
  @override
  String extPidLine(Object? pid) =>
      'pid in the log: $pid';
  @override
  String get extStartingProcess => 'Starting the process…';
  @override
  String get extTestConnection => 'Test connection';
  @override
  String get extEditServerTooltip => 'Edit this server';
  @override
  String get extDeleteServerTooltip => 'Delete this server';
  @override
  String get extNoToolDesc => '(this server gave no description)';
  @override
  String extToolsAllListed(int count) =>
      'The list is complete: all $count are here.';
  @override
  String get extNoChange => 'The config already looked like this — nothing changed';
  @override
  String get extTakeEffectNow => 'Live already, no restart needed';
  @override
  String get extNeedsRestart => 'A main-process restart is needed for this to take over';
  @override
  String extMcpToggledToast(String name, String action, String outcome) =>
      '$name is now $action: $outcome';
  @override
  String extToggleFailed(String reason) =>
      'Could not switch it: $reason';
  @override
  String get extEditMcpTitle => 'Edit MCP server';
  @override
  String get extAddMcpTitle => 'Add MCP server';
  @override
  String get extMcpFormLead => 'A server = one launch command. Saving writes it into mcp.servers[] of config.json and takes effect '
      'immediately:Calls go through the built-in mcp tool (which starts the server on demand and reclaims '
      'it after 5 idle minutes by default).';
  @override
  String get extFieldServerName => 'Server name';
  @override
  String get extServerNameHint => 'The name you give this server; used when calling it (letters, digits, - and _ only, e.g. filesystem)';
  @override
  String get extCommandHint => 'The program to launch: uvx … or node D:\\…\\cli.js (an absolute .exe path works too). The launcher '
      'must be on the whitelist (node, uvx, python); inline execution is not allowed, and npx does not '
      'start on Windows';
  @override
  String get extFieldDesc => 'desc (what it does)';
  @override
  String get extDescHint => "One line: what this server does and what you plan to use it for (e.g. read this machine's browser "
      'history and open tabs)';
  @override
  String get extDescNote => 'This line enters her standing index (one line per server). Saving works without it too — then she '
      'only sees the name in the index.';
  @override
  String get extFieldArgs => 'args (one per line)';
  @override
  String get extArgsHint => 'One argument per line: -y on one line, the package name on the next';
  @override
  String get extFieldEnvForm => 'env (one KEY=VALUE per line)';
  @override
  String get extEnvHint => 'Optional: beyond these lines it also inherits the environment variables of the main process';
  @override
  String get extFieldTestTimeout => 'Test-connection timeout (ms)';
  @override
  String get extTestTimeoutHint => 'The first package pull can take 30s or more; it only affects "test connection" in this dialog '
      '(500–60000) and is not written to the config';
  @override
  String get extEnableSwitchLabel => 'Enable this server (off = the config stays but no process is started and calls do not start it '
      'either)';
  @override
  String get extNameAndCommandRequired => 'Both the server name and command are required';
  @override
  String extSaveFailed(String reason) =>
      'Could not save: $reason';
  @override
  String extMcpSavedToast(String saved, String outcome, String note) =>
      '$saved: $outcome$note';
  @override
  String get extFillCommandFirst => 'Fill in command before testing';
  @override
  String extTestFailed(String reason) =>
      'The test failed: $reason';
  @override
  String get extConnectOk => 'Connected';
  @override
  String get extConnectFailed => 'Connection failed';
  @override
  String extProbeOk(Object? name, Object? ms) =>
      '$name started, the handshake passed and the tool list came back ($ms ms).';
  @override
  String get extProbeNoTools => 'It declares the tools capability but the list is empty: this server currently offers no tools.';
  @override
  String extProtocolLine(String version, String peer) =>
      'Protocol version $version$peer';
  @override
  String extProbeShutdown(String stages) =>
      'Process shut down ($stages) — no background process left behind';
  @override
  String get extUnknownReason => 'unknown reason';
  @override
  String extStderrTail(Object? tail) =>
      'stderr tail: $tail';
  @override
  String get extGotIt => 'Got it';
  @override
  String extDeleteServerTitle(String name) =>
      'Delete MCP server · $name';
  @override
  String get extDeleteServerBody => 'Remove this entry from mcp.servers[] in config.json. Her mcp tool will no longer have this '
      'server.The program itself is not uninstalled.';
  @override
  String extServerDeletedToast(String name, String outcome) =>
      'Deleted $name: $outcome';
  @override
  String get extNoToolRegistry => 'No tool registry yet.';
  @override
  String get extNoToolRegistryHint => 'The registry is assembled at runtime; when this process reads an empty list there are no entries. '
      'Tools of MCP servers are not in this list: look them up on demand through the built-in mcp tool.';
  @override
  String get extRefresh => 'Refresh';
  @override
  String extToolsSummary(Object? enabled, int total, Object? policy) =>
      '$enabled enabled / $total total · destructive: $policy';
  @override
  String get extToolsHint1 => 'Turning one tool off does not change the capability boundary, it only takes the name out of her '
      'list — she will not see it from the next turn on.';
  @override
  String get extToolsHint2 => 'destructive tools have a separate switch of their own (tools.destructiveEnabled); this one here '
      'cannot turn that off.';
  @override
  String extGroupSummary(int on, int total, String note) =>
      '$on / $total enabled$note';
  @override
  String get extEnableAll => 'All on';
  @override
  String get extDisableAll => 'All off';
  @override
  String get extOffBadge => 'Off';
  @override
  String get extFieldMode => 'Concurrency mode';
  @override
  String get extFieldTimeout => 'Timeout';
  @override
  String get extToggleOffMessage => 'Off: take it out of her tool list';
  @override
  String get extToggleOnMessage => 'On: put it back in her tool list';
  @override
  String extToolFailureLine(String name, String reason) =>
      '$name: $reason';
  @override
  String extAllToggledToast(String state, int count) =>
      'All $state ($count)';
  @override
  String extSomeFailedToast(int count, String first) =>
      '$count did not change: $first';
  @override
  String extRequiredParam(Object? name) =>
      '$name (required)';
  @override
  String get extAddHook => 'Add hook';
  @override
  String extHookBoundaryNote(String relative) =>
      '$relative defines "who can change me": the agent can only read it (writes are refused by the path '
      'guard),and only you can change it here. These operations all require a confirmation phrase, and a '
      'main-process restart is needed for them to be assembled.';
  @override
  String extHooksSummary(int enabled, int total) =>
      '$enabled enabled / $total total';
  @override
  String get extHooksTitle => 'Hook entries';
  @override
  String get extHooksHint => 'Run in file order; the timeout of one hook does not block the main flow (killed on timeout, output '
      'dropped).';
  @override
  String get extHooksEmpty => 'No hook configured yet. Press the button in the page header to add one: a hook can refuse a tool '
      'call, and it can rewrite arguments.';
  @override
  String get extInvalidEntries => 'Invalid entries';
  @override
  String get extInvalidEntriesHint => 'Invalid entries do not stop the rest of the config from taking effect, but they have to be fixed — '
      'right now not one of them runs.';
  @override
  String get extHookBoundary1 => 'This line is drawn at "who can change me": hooks can refuse tool calls and rewrite arguments, so '
      'the agent can never change this file.';
  @override
  String get extHookBoundary2 => 'Writing it from the UI requires a confirmation phrase (X-Confirm: hook-save / hook-remove), and a '
      'main-process restart is needed for it to be assembled.';
  @override
  String get extFieldEvent => 'Event';
  @override
  String get extFieldCondition => 'Trigger condition';
  @override
  String get extHookToggleOffMessage => 'Disable: keep the command line, but do not assemble it';
  @override
  String get extHookToggleOnMessage => 'Enable: assemble it after a restart';
  @override
  String get extEditHookTooltip => 'Edit this hook';
  @override
  String get extDeleteHookTooltip => 'Delete this hook';
  @override
  String extHookToggledToast(String state) =>
      'This hook is now $state — it is assembled after the main process restarts';
  @override
  String get extEditHookTitle => 'Edit hook';
  @override
  String get extHookDialogNote => 'A hook runs an external command at an execution point: stdin receives a JSON context, exit code 2 = '
      'refuse (the only enforcing channel),other non-zero codes do not block the main flow. This config is '
      'read-only for the agent.';
  @override
  String get extFieldExecutionPoint => 'Execution point';
  @override
  String get extFieldMatcher => 'matcher (regex)';
  @override
  String get extWakeMatcherHint => 'Matches the wake source: timer|file|webhook|manual|heartbeat';
  @override
  String get extToolMatcherHint => 'Matches the tool name: safe_edit|safe_write';
  @override
  String get extFieldShellCommand => 'command (handed to the system shell)';
  @override
  String get extShellCommandHint => 'e.g. node scripts/check.mjs';
  @override
  String get extFieldConditionOptional => 'Trigger condition (optional)';
  @override
  String get extConditionHint => 'e.g. pwsh(rm *); no match means no process is started';
  @override
  String get extFieldTimeoutMs => 'Timeout (ms)';
  @override
  String get extTimeoutHint => 'Killed on timeout, output dropped, the main flow is not blocked';
  @override
  String get extEnableHookSwitch => 'Enable (off = it stays in the file but is not assembled)';
  @override
  String get extMatcherAndCommandRequired => 'Both matcher and command are required';
  @override
  String get extHookSavedToast => 'Written to data/hooks.json — assembled after the main process restarts';
  @override
  String extDeleteHookBody(int index) =>
      'Remove entry $index from data/hooks.json. Once it is gone it takes part in no execution point —to '
      'put it away for a while use "disable" instead of deleting.';
  @override
  String get extHookDeletedToast => 'Deleted — takes effect after the main process restarts';
  @override
  String get extStatusUnknown => 'Status unknown';
  @override
  String get extReading => 'Reading…';
  @override
  String extStatSkills(int active, int pending) =>
      '$active active · $pending pending';
  @override
  String extStatMcp(int servers, int running) =>
      '$servers servers · $running running';
  @override
  String extStatTools(int on, int total) =>
      '$on of $total enabled';
  @override
  String extStatHooks(int total, String suffix) =>
      '$total hooks$suffix';
  @override
  String extPendingPart(int count) =>
      ' · waiting: $count';
  @override
  String get extNoReasonGiven => ' (no reason given)';
  @override
  String get extRestartSuffix => '; this change needs a main-process restart';
  @override
  String get extServerNoReason => '(the server gave no reason)';
  @override
  String extReasonParen(String reason) =>
      ' ($reason)';
  @override
  String get extEnabledWord => 'enabled';
  @override
  String extSavedWho(String who) =>
      'Saved $who';
  @override
  String extSavedWhoDisabled(String who) =>
      'Saved $who (disabled state)';
  @override
  String extIndentedNote(String descNote) =>
      '　$descNote';
  @override
  String extPeerVersion(Object? name, Object? version) =>
      ' · peer says $name $version';
  @override
  String get extAllOnWord => 'on';
  @override
  String get extAllOffWord => 'off';
  @override
  String extEnabledPart(int on) =>
      ' · $on enabled';
  @override
  String get extDisabledWord => 'disabled';

  // ── 更新检查（2026-10-22）──

  @override
  String updateBannerAvailable(String latest, String current) =>
      '${updateNewVersionTitle(latest, current)} · $updateView';
  @override
  String updateBannerRequired(String latest, String current) =>
      '${updateNewVersionTitle(latest, current)} · $updateRequiredNotice';
  @override
  String get updateView => 'View';
  @override
  String get updateDismiss => 'Dismiss this notice';
  @override
  String get updateSectionTitle => 'Updates';
  @override
  String get updateSectionNote =>
      'Only GETs one static JSON (no identifiers), never downloads or installs. '
      'Checks once 60 s after startup, then every 12 hours (24 hours after 3 consecutive failures).';
  @override
  String get updateCheckNow => 'Check now';
  @override
  String get updateChecking => 'Checking…';
  @override
  String get updateUpToDate => 'Up to date';
  @override
  String get updateDisabled => 'Update checks are disabled in config (update.enabled = false)';
  @override
  String get updateNeverChecked => 'Never checked';
  @override
  String get updateNoPage => 'No page to open for this version';
  @override
  String updateCurrentVersion(String version) => 'Current: v$version';
  @override
  String updateLatestVersion(String version) => 'Latest: v$version';
  @override
  String updateAvailableText(String latest) => 'Update v$latest available';
  @override
  String updateRequiredText(String minimum) =>
      'Below the minimum supported version (v$minimum), please upgrade first';
  @override
  String updateUnknownText(String reason) => 'Not checked this time ($reason)';
  @override
  String updateLastChecked(String time) => 'Last check: $time';
  @override
  String updateNextAllowed(String time) => 'Next allowed: $time';
  @override
  String updateChannelLabel(String channel) => 'Channel: $channel';
  @override
  String updateCheckFailed(String reason) => 'Update check failed: $reason';
  @override
  String updateReasonText(String reason) => switch (reason) {
        'up-to-date' => 'already up to date',
        'older-than-current' => 'the site version is older than this build',
        'channel-mismatch' => 'channel mismatch',
        'prerelease' => 'the stable channel does not treat prereleases as updates',
        'pending' => 'the release is not finished yet (_pending)',
        'newer' => 'a newer version exists',
        'below-minimum' => 'below the minimum supported version',
        'network' => 'network unreachable',
        'timeout' => 'timed out',
        'bad-json' => 'the response is not valid JSON',
        'bad-shape' => 'the response does not match the contract',
        'too-large' => 'the response is too large',
        'bad-endpoint' => 'the endpoint address is unusable',
        'bad-current-version' => 'the current version string cannot be parsed',
        'never-checked' => 'never checked',
        _ when reason.startsWith('http-') => 'HTTP ${reason.substring(5)}',
        _ => reason.isEmpty ? 'unknown reason' : reason,
      };
  @override
  String trayUpdateItem(String latest) => 'Update v$latest available · View';
  @override
  String trayUpdateRequiredItem(String latest) => 'Update v$latest · Please upgrade';
  @override
  String trayUpdateTooltip(String name, String latest) => '$name · update v$latest available';
  @override
  String trayUpdateRequiredTooltip(String name, String latest) => '$name · upgrade to v$latest required';

  // ── 更新检查：三处共用的那几句 ──

  @override
  String updateNewVersionTitle(String latest, String current) =>
      'Update v$latest available (current v$current)';
  @override
  String get updateRequiredNotice => 'Below the minimum supported version, please upgrade first';
  @override
  String get updateChannelMismatchText => 'No release on this channel (channel mismatch)';
  @override
  String get updateDownloadTitle => 'Download';
  @override
  String get updateDownloadNote => 'Opens links only; never downloads or installs silently.';
  @override
  String get updateGitHubDownload => 'Download from GitHub';
  @override
  String get updateNetdiskDownload => 'Netdisk download';
  @override
  String get updateNetdiskSoon => 'Coming soon';
  @override
  String get updateBaiduDownload => 'Download from Baidu Netdisk';
  @override
  String get updateQuarkDownload => 'Download from Quark';
  @override
  String get updatePendingUpload => 'Pending upload';
  @override
  String updateExtractCode(String code) => 'Code: $code';
  @override
  String get updateCopyCode => 'Copy code';
  @override
  String get updateCopied => 'Copied';
  @override
  String get updateReleasePage => 'Release page';
  @override
  String updatePlatformLine(String os, String arch, String kind) => '$os $arch · ${updateKindLabel(kind)}';
  @override
  String updateKindLabel(String kind) => switch (kind) {
        'installer' => 'installer',
        'portable' => 'portable',
        'update' => 'update package',
        _ => kind,
      };
  @override
  String get updateChannelSwitchNote =>
      'Switching clears the 12/24-hour throttle and checks immediately.';
  @override
  String updateSwitched(String channel) => 'Switched to the $channel channel and checked immediately';
  @override
  String updateSwitchFailed(String reason) => 'Could not switch channel: $reason';

}

/// 按具体语言取文案表。[AppLanguage.system] 必须先经 [AppLanguage.resolve]。
AppStrings stringsFor(AppLanguage language) => switch (language) {
      AppLanguage.en => const EnStrings(),
      AppLanguage.system || AppLanguage.zh => const ZhStrings(),
    };

/// 系统 locale → 具体语言（只有**入口**调它一次，见 `main.dart`）
AppLanguage resolveSystemLanguage(Locale systemLocale) =>
    AppLanguage.system.resolve(systemLocale);

/// 截断省略号：`_clip` 那一族把它拼在**值**后面（两种语言都是它，没有可译的东西）。
///
/// 为什么不放进 [AppStrings]：它不是一句话，是"这里被截断了"的记号；而 `_clip` 是纯函数
/// （`String _clip(String text, int max)`），拿不到 `context`，也就没有"当前语言那条"可取。
const String kEllipsis = '…';

// ════════════════════════ 数据（**不是界面文案**） ════════════════════════
//
// 下面这组常量是**她写在数据里的中文词汇**：`payload.cat` / `payload.action`、记忆文件的
// 分区标题、手动输入「日期」时打的相对日子，以及两条**按中文标点**切句/认日期的正则。
//
// 为什么不进 [AppStrings]：它们不是"界面该显示的那句话"，而是"界面怎么**认出**她那句话"——
// 她写的是数据（换成英文界面她也照旧写中文），把这些词翻掉就等于让她排过的安排认不出来。
// 它们仍然要有**唯一的家**（页面里不许再出现中文字面量，见 `test/copy_coverage_test.dart`），
// 所以放在文案表这个文件里，并单独成段。

/// `payload.cat` 的中文别名 → 分类 id（界面上的分类名走 [AppStrings.schedCatWork] 那一族）
const Map<String, String> kScheduleCategoryAliases = {
  '工作 / 学习': 'work',
  '工作': 'work',
  '学习': 'work',
  '陪伴 / 交流': 'personal',
  '陪伴': 'personal',
  '交流': 'personal',
  '生活习惯': 'life',
  '周期计划': 'routine',
};

/// `payload.action` 的中文写法 → 英文键（`_normalizeAction` 用；判据只此一处）
const Map<String, String> kScheduleActionAliases = {
  '自主工作': 'self',
  '提醒': 'notify',
  '提醒你': 'notify',
  '存草稿': 'draft',
};

/// 「日期」那一格认的相对日子（值 = 相对今天几天）。
///
/// 英文那两条是给**英文界面**的人用的（提示里说的就是它们）：认不出来的写法一律报那句
/// 「「日期」看不懂」，多认两个词不会把任何既有输入挤掉。
const Map<String, int> kScheduleDayWords = {
  '今天': 0,
  '今日': 0,
  '明天': 1,
  '明日': 1,
  '后天': 2,
  'today': 0,
  'tomorrow': 1,
};

/// `10月20日` 这种写法（中文日期）
const String kScheduleCnDayPattern = r'^(\d{1,2})月(\d{1,2})日?$';

/// 一句话取第一句：按**中文句读**切（`.。！？!?；;`）
const String kScheduleFirstSentencePattern = r'^[^。！？!?；;]+';

/// cron 人话化用的单字星期（0 = 周日，与 `int 星期 % 7` 一套）
const List<String> kScheduleWeekdayShort = ['日', '一', '二', '三', '四', '五', '六'];

// ════════════════════ 数据（**不是界面文案**） ════════════════════

/// 服务端「测试/保存 MCP 服务」回执里那句"她的索引里只会有这个名字"的**措辞**。
///
/// 页面拿它**判断**这次保存要不要用提醒色（`descNote.contains(...)`）：上屏的是服务端那句话
/// 本身，不是这一串。它是**回执的词汇**（换英文界面服务端照旧写中文），所以不翻译。
const String kExtDescNoteMarker = '只会有这个名字';


