// TODO(i18n): 本文件还有 ~40 处硬编码中文字符串字面量未迁（2026-10-20 盘点，lib/onboarding.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
// 「上次装完的结局」是一条 JSON 字符串（写进 ui-state.json 那一格）；不引新依赖，用 sdk 自带的
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

import 'app.dart';
// QQ 官方 Bot 那两把凭据的键名与「消息适配器」页**同一份**（见 channel_keys.dart）：
// 第 3 步填的就是设置页那两格，落盘走同一条 set-key。
import 'channel_keys.dart';
// 开外链只有一条实现（系统默认浏览器）。第 2、3 步那几颗蓝链与设置页的「下载页」走同一个
// `Process.run`，这里不另写一份（否则平台分支与失败措辞就要各养一套）。
import 'external_link.dart';
// 第 2/3/4 步的所有界面话都进文案表（中英各一条），页面里不再拼中文字面量
import 'i18n/app_strings.dart';
import 'her_name.dart';
// 手动打开那两句收尾话走文案表（`IrmiaStrings.read`）：新增的界面话一律进那一层
import 'i18n/strings_scope.dart';
// 「配置引导」那颗按钮的手动打开通道（`lib/onboarding_request.dart`）：
// 页里那颗按钮 → 这一层宿主 → 同一张卡，**不碰**首次判据。
import 'onboarding_request.dart';
// 「信任范围」那一步与设置页读**同一份**文案与**同一个**二选一控件：
// 两处各写一份的下场是"引导页默认 A、设置页默认 B"这种没人会发现的漂移。
import 'pages/settings_page.dart';
// 「立即重启」也走**既有那条唯一的路**（首页与托盘都走它）：同端点、同确认短语、同一套结局判据。
// 第 6 步装完依赖之后那个顶层窗口里的按钮就交给它，这里一行重启逻辑都不新写。
import 'restart_action.dart';
import 'theme.dart';
// 字号/间距/圆角不写魔法数字：新加的那几块（推荐语、蓝链、凭据格）一律取令牌
import 'theme/design_tokens.dart';
import 'ui_kit.dart';
import 'ui_state.dart';

/// 首次启动引导（六步：她叫什么 / API 配置 / 消息适配器 / 人格 / 信任范围 / 外部依赖）。
///
/// 形制与「她在问」的那张卡同族（[AskCardHost]）：**顶层**（包住整个壳，人在哪一页都看得见）、
/// 遮罩之上一次只一张、六步在同一张卡里前后走完——不是新开一页。
///
/// 三件事先说清：
///   ① **判据**（[shouldShowOnboarding]）：见那个函数的注释，一句话——人格还是种子模板、
///      且 API 或通道还没配好。判据读的是**服务端的现状**，不是"我这次弹过没有"：
///      只在内存里记一个"弹过了"，重启就没了。
///   ② **不再弹**照 [MentionPromptHost] 的姿势持久化：`ui-state.json` 里的
///      `onboarding-done` 开关（与"更多"折叠组、提及提示同一份文件）。
///   ③ **每一步只写它自己那一件事**（每次点「继续 / 完成」时结算，失败就把原因说清并留在原地）：
///        · 名字 → `POST /api/commands/persona-edit`（写 persona/IDENTITY.md 的「名字：」那一行）
///                 **和** `POST /api/commands/set-mention-keywords`（唤醒词：从名字派生，人可改）
///        · API  → `POST /api/commands/config-update`（`X-Confirm: config-update`）
///                 + `POST /api/commands/set-key`（`X-Confirm: set-key`）
///        · 通道 → `POST /api/commands/config-update`（`X-Confirm: config-update`）
///        · 人格 → `POST /api/commands/persona-edit`（危险表里是 null，不带确认短语）
///        · 信任范围 → `POST /api/commands/config-update`
///                     （`X-Confirm: config-update; trust-full-access`——多出来的那半是**字段短语**，
///                       见 [kTrustConfirm]；写 `trust.mode` 少了它服务端回 400）
///        · 外部依赖 → 逐件 `POST /api/commands/dep-install`（`X-Confirm: dep-install`），
///                     **只读** `/api/deps` 取现状；已就位的跳过，一件失败不中断其余
///                     （见 [_OnboardingCardState._runDepsRound]）
///
///      （前三步都写 `X-Confirm: config-update`；`config-update` 这条命令在服务端的
///        `CONFIRM_PHRASES` 里是 **null**，所以那半截短语是声明性的，真正被校验的是字段短语。）
///
/// **为什么信任范围这一步排在最后**（2026-10-05 加）：前四步填的是"她是谁、怎么说话"，
/// 这一步定的是"她能碰多远"。放最后是因为它是**一次边界声明**——前四步没有一步会问她
/// "你能动我的电脑吗"，而这件事必须在第一次运行时就问过一遍（默认值是**完全信任**，
/// 与配置里的默认值同一个字面量，见 [defaultTrustMode]）。
///
/// **第 6 步「外部依赖」为什么排在信任范围之后**（2026-10-20 用户第 3 轮 ⑤）：前面五步都是
/// "写进配置文件的东西"，这一屏是**装东西**——它会往数据目录里落可执行文件，而且装完要重启
/// 才生效（所以它后面跟一个顶层窗口）。把它放最后，人才是"配置已经填完、最后再决定要不要装"。
/// 四件依赖（pwsh / rg / es / python）的说明与状态都在这一屏，**不装也走得完**：
/// 勾选框默认勾上，但没勾就一个请求都不发（见 [_OnboardingCardState._runDepsRound]）。
///
/// **第一步为什么写两件事**：这一屏问的其实是两件事——"她叫什么"（她的人格身份，落在
/// persona/IDENTITY.md）与"群里喊什么算在叫她"（机器配置 channels.mentionKeywords）。
/// 以前只写了后者，于是名字从来没被真正配置过：换个人装这个框架，界面照样管他的 agent
/// 叫伊尔弥亚（那些字面量的来历与现在的口径见 her_name.dart）。
///
/// 为什么引导排在 `AuthGate` **之后**（见 app.dart 的接线）：`/api/*` 全部要会话凭据，
/// 没有它连 `/api/config` 都读不到——密钥与配置一个字节也写不进去。
/// 所以那道门（首次设密码 / 登录）是第一步，凭据有了才谈得上"引导她把第一次配置做完"。

/// 「引导已经出现过」这个事实的存放键（`ui-state.json`）
const kOnboardingDoneFlag = 'onboarding-done';

/// 允许强制弹出引导（排障与人工验证用；正式运行不要设）。
///
/// 为什么留这个口子：判据读的是服务端现状——在一台**已经配好**的机器上（比如用户的开发机），
/// 引导永远不该弹，于是"弹出来长什么样、四步走得通吗"就只能靠改配置去凑。有了它，
/// `$env:IRMIA_GUI_FORCE_ONBOARDING='1'` 起一次界面就能看那张卡（不写任何服务端状态：
/// 点「以后再说」/关闭就直接退出）。
const kForceOnboardingEnv = 'IRMIA_GUI_FORCE_ONBOARDING';

/// 卡片的标题（写死的框架口吻：这张卡与"她在问"那张一样，标题不由内容决定）
const kOnboardingTitle = '首次启动引导';

/// 引导卡的最大宽度。
///
/// 比 [kDialogMaxWidth]（400，确认框与"她在问"那张卡）宽：那两张卡只有一段话，
/// 这张卡里有四个输入框与一组通道选项，400 会把密钥框挤成一条缝。
/// 也不跟着窗口无限长：卡片再宽就成"第二层窗口"，与它"浮在壳之上的一张卡"的定位不符。
const kOnboardingCardWidth = 620.0;

/// 信任范围那一步的**默认档**——`'full'`，与 `src/config/config.ts` 的
/// `buildDefaults()`（`trust: { mode: 'full', … }`）以及设置页缺字段时的回落**同一个字面量**。
///
/// 为什么把它拎成一个常量并在注释里点名另外两处：用户的要求是"默认高亮完全信任，
/// 与配置默认值一致，不许出现引导页默认 A、配置默认 B"。三处各自写一个 `'full'` 也能跑，
/// 但下一次有人改默认值时就只会改一处——这个常量是那条要求唯一能落地的形状。
const defaultTrustMode = 'full';

/// 第 2 步「模型名」那一格的**默认值**（用户 2026-10-18 定的）。
///
/// 为什么不是后端那个 `DEFAULT_MODEL`：`buildDefaults()` 里的出厂值是
/// `'deepseek-chat'`（`src/config/config.ts:60`），而用户要新用户默认走 `deepseek-flash`。
/// 界面不改 `config.json` 的默认值（那是后端的事），只把**这一格预填成什么**定在这里；
/// 人点「继续」时按这一格的值写进 `models.heavy.model`（与"改了才写"同一条口径）。
const kDefaultModelName = 'deepseek-flash';

/// 后端 `buildDefaults()` 的出厂模型名（`src/config/config.ts` 的 `DEFAULT_MODEL`）。
///
/// 判据用它区分"人选的模型"与"没人动过的出厂值"：盘上还是它 ⇒ 这一格显示 [kDefaultModelName]；
/// 是别的值 ⇒ 原样回填，**绝不**拿推荐值盖掉人自己选过的模型。
const kFactoryDefaultModel = 'deepseek-chat';

/// 第 2 步模型格首次进入时预填什么。
///
/// 三种输入：空（读不到配置）、出厂默认（没人选过）、人自己选的模型。
/// 前两种给推荐值 [kDefaultModelName]，第三种原样回去——这是"预填"唯一说得通的语义：
/// 界面上摆的就是"你现在按哪个模型跑"，除了"还没选过"以外都不该替人改。
String initialOnboardingModel(String configured) {
  final model = configured.trim();
  if (model.isEmpty || model == kFactoryDefaultModel) return kDefaultModelName;
  return model;
}

/// 第 2 步「DeepSeek 的模型」那颗蓝链的地址：DeepSeek 的 API 平台。
///
/// 2026-10-18 实测可达（HTTP 200）。地址是**产品事实**不是界面文案，所以不进 AppStrings——
/// 两种语言的同一句话打开的是同一个页面。
const kDeepSeekPlatformUrl = 'https://platform.deepseek.com/';

/// 第 2 步「点击注册账号并获取 API Key」那颗蓝链的地址：DeepSeek 的注册页。
const kDeepSeekSignupUrl = 'https://platform.deepseek.com/sign_up';

/// 第 3 步「QQ 官方 Bot」那颗蓝链的地址：QQ 开放平台。
const kQqOpenPlatformUrl = 'https://q.qq.com/';

/// 步骤区的最小高度：六步的内容长短不一，不钉住高度就会一跳一跳
const _bodyMinHeight = 268.0;

// ────────────────────── 第 6 步：外部依赖（2026-10-20） ──────────────────────

/// 第 6 步要摆出来的四件外部依赖，**顺序就是界面顺序，也是安装的串行顺序**。
///
/// 与后端 `src/deps/probe.ts` 的 `DEP_NAMES`（`['pwsh','rg','es','python']`）同一份名单：
/// 那一份是"有哪些依赖"的唯一来源，这里只决定"这一屏按什么顺序摆、按什么顺序装"。
/// 写死而不是拿 `/api/deps` 的 `entries` 顺序：接口的条目顺序是服务端的实现细节，
/// 界面上的顺序不该随它变（人第三次打开这张卡时，前两次学的还是这个顺序）。
const kOnboardingDepNames = <String>['pwsh', 'rg', 'es', 'python'];

/// 这一屏要读的现状（`GET /api/deps`），一件一条。
class OnboardingDep {
  const OnboardingDep({required this.name, required this.ready});

  /// `pwsh` / `rg` / `es` / `python`
  final String name;

  /// 服务端说它**就位**了（`status == 'ready'`）。
  ///
  /// 只有 `ready` 才算就位：`version-mismatch`（装了但版本不够）与 `missing` 在本屏都按
  /// "未就位"处理——这一屏要回答的是"要不要装"，而那一档同样需要（重）装一次。
  final bool ready;

  /// 刚装成的那一件：服务端复检过了，现状就是"就位"。
  OnboardingDep asReady() => OnboardingDep(name: name, ready: true);

  /// 从 `GET /api/deps` 的回包里取这一件。
  ///
  /// 形状照服务端（`src/deps/manager.ts` 的 `DepReportEntry`）：每条有 `name` / `status` /
  /// `version` / ……。读不到那条、或形状不对，一律按**未就位**处理：这一屏宁可说"没装"
  /// 让人去装一次，也不能反过来替服务端宣称"已就位"（那样人就再也不会去装了）。
  static OnboardingDep from(String name, Object? raw) {
    final map = raw is Map ? raw : const {};
    return OnboardingDep(name: name, ready: map['status']?.toString() == 'ready');
  }
}

/// 上一次装完的结局（落 `ui-state.json` 的 [kOnboardingDepsKey] 一格，JSON 字符串）。
///
/// 为什么它要落盘（用户第 3 轮 ⑤「装完的勾选状态与结果要能复查」）：卡片一关，内存里的
/// 状态就没了；而"上次勾没勾、装成没装成"是人做过的决定与这次动作的结局，下一次打开
/// 这一页时必须还看得见——否则"装失败了"会被静默吞掉，人只会记得"我点过安装"。
class DepsAttempt {
  const DepsAttempt({
    required this.checked,
    required this.ok,
    required this.failed,
    this.failures = const <String, String>{},
  });

  /// 人当时勾没勾那个勾选框（默认是勾上的，见 [_OnboardingCardState.depsInstallChecked]）
  final bool checked;

  /// 成功几件
  final int ok;

  /// 失败几件
  final int failed;

  /// 失败的那几件：名字 → 原因（复查时点名说清是哪一件、为什么）
  final Map<String, String> failures;

  String encode() => jsonEncode(<String, dynamic>{
        'checked': checked,
        'ok': ok,
        'failed': failed,
        'failures': failures,
      });

  /// 读回来。认不出（JSON 坏了、形状不对）一律 null——那时界面上不摆"上次装完"那一行。
  ///
  /// **0 成功 0 失败也是一条有效记录**：它是"上次没勾"那个决定的载体
  /// （见 [_OnboardingCardState._runDepsRound] 的未勾选分支），勾选状态照样要复查得到。
  static DepsAttempt? decode(String? raw) {
    if (raw == null || raw.trim().isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return null;
      final map = decoded.cast<String, dynamic>();
      final ok = map['ok'];
      final failed = map['failed'];
      final rawFailures = map['failures'];
      if (ok is! num || failed is! num) return null;
      return DepsAttempt(
        checked: map['checked'] != false,
        ok: ok.toInt(),
        failed: failed.toInt(),
        failures: rawFailures is Map
            ? {
                for (final entry in rawFailures.entries)
                  entry.key.toString(): entry.value?.toString() ?? '',
              }
            : const <String, String>{},
      );
    } catch (_) {
      return null;
    }
  }

  /// 装没装过东西（0/0 那条记录只回答"上次勾没勾"，没有结局可复查）
  bool get hasResult => ok + failed > 0;
}

/// 「上一次装完的结局」在 `ui-state.json` 里的键名（值是 [DepsAttempt] 的 JSON）
const kOnboardingDepsKey = 'onboarding-deps';

/// 读回上一次装完的结局（读不到 = null，界面不摆那一行）
Future<DepsAttempt?> loadDepsAttempt() async => DepsAttempt.decode(await loadString(kOnboardingDepsKey));

/// 落盘这一次装完的结局（写不进去不影响使用，`ui_state.dart` 那边失败静默）
Future<void> saveDepsAttempt(DepsAttempt attempt) =>
    saveString(kOnboardingDepsKey, attempt.encode());

/// 一把「只写不读」的密钥在界面上的现状：**只有"配没配"与掩码**，完整值从不经过界面
/// （`GET /api/keys` 就只回这两个字段）。
///
/// 第 3 步的 AppID / AppSecret 与第 2 步的 API Key 是同一族东西，所以形状也同一个：
/// 已配置时输入框留空、占位提示显示掩码（见 ui_kit 的 `secretLook`）。
class SecretState {
  const SecretState({required this.configured, this.mask});

  /// 盘上有没有这把密钥
  final bool configured;

  /// 服务端给的掩码（例如 `qqA…9f3c`）；null = 没给/没配置
  final String? mask;

  /// 没配置的那一档（读不到 `/api/keys` 时也回它）
  static const absent = SecretState(configured: false);
}

/// 引导要读的那几项**服务端现状**。三个字段刻意给得很直白，判据（[shouldShowOnboarding]）
/// 只读它们，不读原始 JSON——"怎么读"与"根据它决定什么"分开，换端点时判据一个字都不用动。
class OnboardingSignals {
  const OnboardingSignals({
    required this.identityIsSeed,
    required this.apiReady,
    required this.channelsReady,
    required this.model,
    required this.baseUrl,
    required this.apiKeyConfigured,
    required this.apiKeyGates,
    required this.apiKeyGatesConfigured,
    required this.qqEnabled,
    required this.onebotEnabled,
    required this.qqAppId,
    required this.qqClientSecret,
    required this.mentionKeywords,
    required this.identityContent,
    required this.herName,
    required this.trustMode,
    required this.trustRoot,
  });

  /// 人格是否**确定**还停在种子模板（IDENTITY.md 里还有 `<!-- SEED` 那行）。
  /// null = 读不到（端点在、但响应形状不对）——那时按"不确定"处理，见判据。
  final bool? identityIsSeed;

  /// API 侧就绪：配了模型名 / 端点，且有可用的密钥
  final bool apiReady;

  /// 通道侧就绪：QQ 官方 或 OneBot 至少开了一个
  final bool channelsReady;

  /// 当前生效的两个值：既是判据的输入，也用来回填输入框与判断"这一格改没改"
  final String model;
  final String baseUrl;

  /// API 侧就绪：**当前配置里存在的每一条模型路由**都有自己的密钥（见 [apiKeyGates]）。
  ///
  /// 为什么不是"heavy 有就算有"（2026-10-20 改）：密钥文件是**按格**存的（heavy / light），
  /// 前端只写 heavy 那一格时，这一项会因为"heavy 有"而报就绪，而设置页按格看的 light 写着
  /// 「未配置」——同一条事实两个答案，人当然觉得没配好。现在两个口径都用**全部格**。
  final bool apiKeyConfigured;

  /// 当前配置里**有密钥格**的模型路由（今天 `heavy` / `light`；`degraded` 没有自己的格）。
  /// 格名取自 `GET /api/keys` 的回包（服务端的 `KEY_NAMES`），界面不另写一份名单。
  final List<String> apiKeyGates;

  /// [apiKeyGates] 里**此刻确实有 key** 的那几格
  final List<String> apiKeyGatesConfigured;
  final bool qqEnabled;
  final bool onebotEnabled;

  /// QQ 官方 Bot 那两把凭据的现状（只写不读：界面只知道"配没配"与掩码）。
  /// 第 3 步的两个输入框据此决定占位提示——已配置就**不回显**，只摆掩码。
  final SecretState qqAppId;
  final SecretState qqClientSecret;

  /// 她当前被怎么称呼（可能被喊的那些词）：回填第一步的词表
  final List<String> mentionKeywords;

  /// IDENTITY.md 的现正文（null = 读不到）：回填第四步的文本框，同时是第一步写名字时的**底稿**
  final String? identityContent;

  /// 她现在的名字（从 [identityContent] 里认出来的；null = 认不出）。
  /// 回填第一步的名字格——老实例（名字写在正文散文里）也能被回填成结构化那一行。
  final String? herName;

  /// 盘上那份的 `trust.mode`（`'full'` / `'workspace'`）。缺字段按 [defaultTrustMode] 回落
  /// ——与配置默认值一致：这里绝不显示成"受限"那一档（界面要显示的是"她实际按哪一档跑"）。
  final String trustMode;

  /// 盘上那份的 `trust.workspaceRoot`（解析器算出来的那个目录）。
  /// 「只限工作目录」那句后果要把这个路径念出来，否则人不知道自己被关在哪。
  final String trustRoot;
}

/// 该不该弹首次引导。
///
/// 判据三句：
///   · `askedBefore` —— 本地状态文件里的 `onboarding-done`，**三态**：`false` = 没问过
///     （**文件不在也算这一档**：真·首次安装就是它，要弹）、`true` = 问过、
///     `null` = 记录坏了（读不动 / JSON 坏）。这是**唯一**的"不再弹"来源，重启后照旧管用。
///     口径一句话：**"没有记录" = 弹，"记录坏了" = 不弹**——把"不知道"说成"没问过"是
///     fail-open（状态文件坏一次就把老用户挡一张卡），把"没有记录"说成"不知道"则会把
///     新用户挡在引导外面。未知与 `identityIsSeed` 为 null 是同一条口径：宁可不弹；
///   · `identityIsSeed` —— 服务端说 IDENTITY.md 里还留着 `<!-- SEED` 那行（种子模板没动过）。
///     人格是"她的存在方式"，装好就把名字与身份写了的机器，几乎一定不是第一次启动；
///     反过来**只有**人格还是模板才会往下判，于是老用户升级到这一版不会被补弹一次；
///   · `apiReady` / `channelsReady` —— 这两样她还缺一样，才值得把卡摆出来。
///
/// 为什么 `identityIsSeed` 为 null（读不到）时**不弹**：读不到现状就无法排除"他是老用户"，
/// 误弹的代价是每个老用户开界面都被挡一张卡；漏弹的代价只是他自己去设置页填——
/// 两害相权，宁可不弹（与 mention_prompt 里"配置读不到就不问"同一条纪律）。
///
/// 注意判据里**没有**"她叫什么"这一项：词表是不是空的，只决定第一步要不要提醒，不决定弹不弹
/// ——群里打不打 @ 是外部习惯，不该拿来判断"这是不是第一次启动"。
bool shouldShowOnboarding({
  required bool? askedBefore,
  required bool? identityIsSeed,
  required bool apiReady,
  required bool channelsReady,
}) {
  // `askedBefore != false` = true 或 **未知**：除了"确定没问过"，一律不弹
  if (askedBefore != false) return false;
  if (identityIsSeed != true) return false;
  return !apiReady || !channelsReady;
}

/// 要不要把引导摆出来——**唯一**的那处判断（宿主只读结果，不再自己加条件）。
///
/// [forceEnv] 是 [kForceOnboardingEnv] 的原始值（宿主从环境变量读来传进来；纯函数才好测）。
/// 它是排障口子：在一台已经配好的机器上想看这张卡长什么样，设 `IRMIA_GUI_FORCE_ONBOARDING=1`
/// 起一次界面即可——但它**只放宽**判据，不放宽"已经走过就不再弹"：
/// 人点过「以后再说」之后，连强制也不该再把卡拍在他脸上。
///
/// `askedBefore` 三态（见 [shouldShowOnboarding]）：只有确凿的 `true` 连强制也拦；
/// 未知（null）在常规判据下同样不弹，但强制口子照旧能开——那是排障，不是自动通道。
bool shouldShowOnboardingNow({
  required bool? askedBefore,
  required bool? identityIsSeed,
  required bool apiReady,
  required bool channelsReady,
  String? forceEnv,
}) {
  if (askedBefore == true) return false;
  if (forceEnv == '1') return true;
  return shouldShowOnboarding(
    askedBefore: askedBefore,
    identityIsSeed: identityIsSeed,
    apiReady: apiReady,
    channelsReady: channelsReady,
  );
}

/// 读一遍服务端的现状。任何一项读不到都退化成"只有真相的那部分"——
/// 这里**不抛**：引导是个提示，读不到就不弹（判据那边兜住），不该让壳崩。
Future<OnboardingSignals> readOnboardingSignals(AppState state) async {
  dynamic cfg;
  try {
    cfg = await state.api.get('/api/config');
  } catch (_) {
    cfg = null;
  }

  // 密钥现状（`GET /api/keys`）：只回 {configured, mask}，完整值从不经过界面。
  //
  // 为什么要读 qqAppId / qqClientSecret：第 3 步那两个框就在引导页上填（用户 2026-10-18），
  // 与「消息适配器」页一样**已有的不回显**——已配置时框留空、占位提示摆掩码。
  //
  // 模型那两格（heavy / light）要**逐格**读：密钥文件是按格存的，同一个 `apiKeyEnv`
  // 在有 key 之前那几格可以是空的——"只配了一半"是必须能被看见的状态（见 apiKeyGates）。
  var apiKeyGates = <String>[];
  var apiKeyGatesConfigured = <String>[];
  var qqAppId = SecretState.absent;
  var qqClientSecret = SecretState.absent;
  try {
    final keys = await state.api.get('/api/keys');
    if (keys is Map) {
      for (final entry in keys.entries) {
        final name = entry.key.toString();
        if (name != 'heavy' && name != 'light') continue;
        apiKeyGates = [...apiKeyGates, name];
        if (entry.value is Map && (entry.value as Map)['configured'] == true) {
          apiKeyGatesConfigured = [...apiKeyGatesConfigured, name];
        }
      }
    }
    qqAppId = _secretState(keys, kQqAppIdKey);
    qqClientSecret = _secretState(keys, kQqAppSecretKey);
  } catch (_) {
    // 读不到就当作"没配"：这一点只影响"这一步要不要提醒"，不影响是否弹卡（人格那边说了算）
  }
  // 一格都没读到（端点没回 heavy / light）时退回"只看 heavy"：这是加逐格读取之前的口径，
  // 读不到格名单不该让已经配好的人被当成没配。
  if (apiKeyGates.isEmpty) apiKeyGates = const ['heavy'];
  final apiKeyConfigured = apiKeyGates.every(apiKeyGatesConfigured.contains);

  final model = _text(cfg, 'models.heavy.model');
  final baseUrl = _text(cfg, 'models.heavy.baseUrl');
  // 协议（`models.heavy.protocol`）在这里**已经不读了**（2026-10-26 用户：「算了，协议项不放在
  // 引导第二步吧，有点占位置了」）：引导页不问协议，那三档仍原样留在设置页（`settings_page.dart`
  // 的 `_protocolPicker`）。读一个不问的字段，只会让人以为这一屏还要照着它写点什么。

  final keywords = <String>[];
  final rawKeywords = _at(cfg, 'channels.mentionKeywords');
  if (rawKeywords is List) {
    keywords.addAll(rawKeywords.whereType<String>().map((w) => w.trim()).where((w) => w.isNotEmpty));
  }

  final qqEnabled = _at(cfg, 'channels.qqOfficial.enabled') == true;
  final onebotEnabled = _at(cfg, 'channels.onebot.enabled') == true;

  // 人格现状：`GET /api/persona/files` 的 `isSeed` 逐份给。
  //
  // 为什么读这条而不是 dashboard 的某个字段：本机这份服务端的 dashboard 里**没有**人格种子
  // 标记（`personaIsSeed` 不在响应里，实测过），人格的 isSeed 只出现在这里。读不到 IDENTITY.md
  // 条目就当"不确定"（null）——判据会因此不弹，不会误伤老用户。
  bool? identityIsSeed;
  String? identityContent;
  try {
    final files = await state.api.get('/api/persona/files');
    final list = files is Map ? files['files'] : null;
    if (list is List) {
      for (final raw in list) {
        if (raw is! Map) continue;
        if (raw['path']?.toString() != kIdentityFile) continue;
        identityIsSeed = raw['isSeed'] == true;
      }
      if (identityIsSeed != null) {
        final view = await state.api.get('/api/persona/file?path=${Uri.encodeComponent(kIdentityFile)}');
        final content = view is Map ? view['content'] : null;
        identityContent = content is String ? content : null;
      }
    }
  } catch (_) {
    // 保持 null = 不确定
  }

  return OnboardingSignals(
    identityIsSeed: identityIsSeed,
    // 判据口径：模型名与端点非空、且**每一条模型路由都有自己的密钥**，才算 API 侧就绪
    // （2026-10-20 改：从前只问 heavy 那一格，于是一个只写进 heavy 的 key 会让这里报"就绪"，
    // 而设置页按格看的 light 仍写着「未配置」。两个口径现在都看 [apiKeyGates] 的全部格。）
    apiReady: model.isNotEmpty && baseUrl.isNotEmpty && apiKeyConfigured,
    channelsReady: qqEnabled || onebotEnabled,
    model: model,
    baseUrl: baseUrl,
    apiKeyConfigured: apiKeyConfigured,
    apiKeyGates: apiKeyGates,
    apiKeyGatesConfigured: apiKeyGatesConfigured,
    qqEnabled: qqEnabled,
    onebotEnabled: onebotEnabled,
    qqAppId: qqAppId,
    qqClientSecret: qqClientSecret,
    mentionKeywords: keywords,
    identityContent: identityContent,
    // 名字就地认出来（同一份正文，不必再发一条请求）：口径全在 her_name.dart——
    // 认不出来就是 null，第一步的名字格留空，界面显示回退值，**不猜**。
    herName: herNameFromIdentity(identityContent),
    // 信任范围（2026-10-05 加）：读的是同一份 `/api/config`（生效配置）。
    // 缺字段按 defaultTrustMode 回落（= 配置默认值），**不猜成受限那一档**——
    // 界面要显示的是"她实际按哪一档跑"，猜一个更安全的答案同样是撒谎。
    trustMode: _text(cfg, 'trust.mode') == 'workspace' ? 'workspace' : defaultTrustMode,
    trustRoot: _text(cfg, 'trust.workspaceRoot'),
  );
}

/// 引导宿主：包住整个壳，首帧之后看一眼要不要弹。
///
/// 与 [AskCardHost] 的分工：那张卡是**她**问的、每次运行都可能再来；这张卡是**一次性的**，
/// 走完（或人点过"以后再说"）就写盘，此后不再出现。
class OnboardingHost extends StatefulWidget {
  const OnboardingHost({super.key, required this.state, required this.child});

  final AppState state;
  final Widget child;

  @override
  State<OnboardingHost> createState() => _OnboardingHostState();
}

class _OnboardingHostState extends State<OnboardingHost> {
  /// 本次运行里已经处理过（弹过、或读完现状判定不弹）：一次会话里只做一次判断
  bool checked = false;

  /// 卡片此刻开着没有（手动再点一次「配置引导」不叠第二张）
  bool _cardUp = false;

  @override
  void initState() {
    super.initState();
    // 手动打开通道（首页「配置引导」那颗按钮）：与首帧那次自动判断**是两条路**，
    // 互不影响——自动那条只跑一次，手动这条可以来很多次。
    onboardingOpenRequest.addListener(_onManualRequest);
    WidgetsBinding.instance.addPostFrameCallback((_) => unawaited(_maybeShow()));
  }

  @override
  void dispose() {
    onboardingOpenRequest.removeListener(_onManualRequest);
    super.dispose();
  }

  /// 有人按了「配置引导」：打开同一张卡，但**不读也不写** `onboarding-done`。
  ///
  /// 为什么手动打开不许动那个标志：它是**唯一**的"不再自动弹"来源（见
  /// [shouldShowOnboarding] 的 askedBefore）。人来只是"再看看这张卡、提点意见"——
  /// 把"已经引导过"写死，等于替他把"第一次启动该弹一次"这件事消费掉；
  /// 反过来（先手动打开、再去读标志）也不该让自动那条提前认为"已经引导过"。
  void _onManualRequest() {
    unawaited(_openManually());
  }

  Future<void> _openManually() async {
    if (!mounted || _cardUp) return;
    // 卡片里每一格都要回填"现在盘上是什么"，所以照样读一遍现状——
    // 读不到也照开（手动是显式动作，不该被"判据说不该弹"拦住）。
    final signals = await readOnboardingSignals(widget.state);
    if (!mounted) return;
    await _show(signals: signals, fromFirstRun: false);
  }

  Future<void> _maybeShow() async {
    if (checked || !mounted) return;
    checked = true;

    // 三态：false = 没问过（文件不在也算这一档：真·首次安装）；true = 问过；
    // null = 记录坏了。未知按"不弹"处理——手动通道（首页「配置引导」）照样能开，
    // 见 [_openManually]。
    final askedBefore = await loadFlag(kOnboardingDoneFlag);
    if (!mounted) return;
    final force = Platform.environment[kForceOnboardingEnv];
    // 强制口子下不必读现状：它要答的问题是"这张卡长什么样、四步走得通吗"，
    // 而在一台配好的机器上现状永远说"不该弹"（见 shouldShowOnboardingNow）。
    final signals = force == '1' ? null : await readOnboardingSignals(widget.state);
    if (!mounted) return;
    if (!shouldShowOnboardingNow(
      askedBefore: askedBefore,
      identityIsSeed: signals?.identityIsSeed,
      apiReady: signals?.apiReady ?? false,
      channelsReady: signals?.channelsReady ?? false,
      forceEnv: force,
    )) {
      return;
    }
    await _show(signals: signals);
  }

  Future<void> _show({OnboardingSignals? signals, bool fromFirstRun = true}) async {
    if (_cardUp) return;
    _cardUp = true;
    try {
      final ready = signals ?? await readOnboardingSignals(widget.state);
      if (!mounted) return;
      final wrote = await showOnboardingCard(
        context,
        state: widget.state,
        signals: ready,
        // 手动打开（「配置引导」那颗按钮）= 只是打开看看：预填的推荐模型不算"改动"，
        // 关掉时一个字节都不写（见 `_OnboardingCardState._apiDirty`）；
        // 卡头也要据此挂上「手动打开 · 不计入首次判据」那行标识（见 `_header`）。
        fromFirstRun: fromFirstRun,
      );
      // 只有"首次那条路"才写「问过了」：手动打开不动它（见 [_openManually]）
      if (fromFirstRun) await saveFlag(kOnboardingDoneFlag, true);
      if (!mounted) return;
      final strings = IrmiaStrings.read(context);
      IrmiaToast.show(
        context,
        fromFirstRun
            ? (wrote ? '引导走完了，之后不再自动弹出' : '先记着这件事——设置页与人格配置页里随时能填')
            : (wrote ? strings.onboardingManualSaved : strings.onboardingManualNoChanges),
        kind: wrote ? ToastKind.success : ToastKind.info,
      );
    } finally {
      _cardUp = false;
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// 六步的**键**：结算时按它分派（[`_OnboardingCardState._settle`]）。
///
/// 标题与说明**不在**这里——它们在 [AppStrings] 里，中英各一份（见 `_stepCopyOf`）。
/// 步骤条上的标签与正文标题是同一句，所以只在文案表里写一次。
///
/// **第 6 步 `deps` 不在这条结算链上**：它会装东西、要弹重启窗口、失败了还要能重试，
/// 不是一个 `Future<String?>` 能说清的（见 [_OnboardingCardState._runDepsRound]）。
/// 所以 [_settle] 对它什么都不做，`_finish` 单独走那一条。
const _stepKeys = <String>['name', 'api', 'channel', 'persona', 'trust', 'deps'];

/// 一步的标题 + 一句人话（两种语言由 [AppStrings] 给；标题也当步骤条的标签用）
typedef _StepCopy = ({String title, String note});

/// 第 3 步 QQ 官方 Bot 的**两个并列入口**（用户 2026-10-23）：
///   · [scan]   —— 扫码创建（推荐）：点一下 → 系统浏览器打开二维码页 → 轮询状态；
///   · [manual] —— 填写凭据：原有的 AppID / AppSecret 表单（一个字都不改）。
///
/// 为什么默认是扫码：用户在原话里把它排在第一，且新用户手里通常**还没有** AppID /
/// AppSecret（要先去开放平台建机器人）；扫码那条路把这些步骤都省了。
enum _QqEntry { scan, manual }

/// 扫码创建那一支的状态机（界面侧）：
///   · [idle]     —— 还没点过（或上一次发起失败，可以重来）；
///   · [starting] —— 正在向 QQ 要任务（一个短过场，界面上给一句"正在申请二维码"）；
///   · [pending]  —— 二维码已在浏览器里打开，等手机扫（每 2 秒查一次）；
///   · [success]  —— 「绑定成功」+ AppID（secret 只显示"已保存"）；
///   · [expired]  —— 过期/超时/取消 ⇒ 摆「二维码过期了，重新生成」。
enum _QqBindPhase { idle, starting, pending, success, expired }

/// 按当前语言取六步的标题与说明（顺序与 [_stepKeys] 一一对应）。
///
/// 为什么是"每次 build 现取"而不是顶层 const：语言可以在不重启的情况下切换
/// （见 `i18n/strings_scope.dart`），const 一份中文会把切换锁死在启动那一刻。
List<_StepCopy> _stepCopyOf(AppStrings s) => <_StepCopy>[
      (title: s.onboardingStepNameTitle, note: s.onboardingStepNameNote),
      (title: s.onboardingStepApiTitle, note: s.onboardingStepApiNote),
      (title: s.onboardingStepChannelTitle, note: s.onboardingStepChannelNote),
      (title: s.onboardingStepPersonaTitle, note: s.onboardingStepPersonaNote),
      (title: s.onboardingStepTrustTitle, note: s.onboardingStepTrustNote),
      (title: s.onboardingStepDepsTitle, note: s.onboardingStepDepsNote),
    ];

/// 打开引导卡，返回**有没有真的写进去过东西**（false = 四步都跳过了或原地关掉）。
///
/// 返回这个 boolean 是为了让宿主那句收尾提示说准：全跳过的场合说"走完了"是假的。
///
/// [fromFirstRun] 只有"首次启动那条路"是 true，其余（手动打开）是 false。它管两件事：
///   · **预填值算不算改动**：首次启动时预填的推荐值（第 2 步的 `deepseek-flash`）就是人
///     看到的默认配置，点继续/关掉时照写；手动打开时预填值不算改动，关掉时一个字节都不写；
///   · **卡头那行标识**：手动打开时挂「手动打开 · 不计入首次判据」，人就不会误以为
///     "这张卡又自己弹出来了"。
Future<bool> showOnboardingCard(
  BuildContext context, {
  required AppState state,
  required OnboardingSignals signals,
  bool fromFirstRun = true,
}) async {
  if (!context.mounted) return false;
  final result = await showDialog<bool>(
    context: context,
    // 点遮罩不关：这张卡里有四个输入框，误点一下就把人刚打的字丢了
    barrierDismissible: false,
    builder: (_) => _OnboardingCard(state: state, signals: signals, fromFirstRun: fromFirstRun),
  );
  return result ?? false;
}

class _OnboardingCard extends StatefulWidget {
  const _OnboardingCard({
    required this.state,
    required this.signals,
    this.fromFirstRun = true,
  });

  final AppState state;
  final OnboardingSignals signals;

  /// 这条是不是"首次启动那条路"（见 [showOnboardingCard]）：手动打开时是 false
  final bool fromFirstRun;

  @override
  State<_OnboardingCard> createState() => _OnboardingCardState();
}

class _OnboardingCardState extends State<_OnboardingCard> {
  int step = 0;

  /// 正在结算：一次只允许一个请求飞（按钮同时按下去，避免连点写出两份）
  bool busy = false;

  /// 写失败的原因（留在卡上，不塞进 toast——输入框还在，人要照着改）
  String? problem;

  /// "这一屏还缺一样东西"（比如没填密钥）：与 [problem] 一样摆在卡上，但**不拦人退出**
  /// ——"我这次先不填"是完全正常的决定，退出时不该被自己的提示挡住。
  String? requirement;

  /// 写成功后的**回执**（绿条）：说清这次写到了哪几格（例如「密钥已写入 heavy / light」）。
  ///
  /// 为什么必须有它（2026-10-20，用户实测的挫败点）：从前写完密钥这一屏什么都不说，
  /// 人只能去设置页看——而那里 light 那张卡写着「未配置」（引导页当时只写了 heavy 一格）。
  /// 回执把"哪几格拿到了这把 key"直接摆在卡上，格名来自服务端的 `gates`，界面不自己猜。
  String? receipt;

  /// 有没有真的写进去过东西
  bool wrote = false;

  /// 已经被处理过的步骤（手动「跳过」，或结算成功）：不再重复写
  final settled = <int>{};

  /// 人有没有**主动**前后走过一步（点卡脚那两个键）。
  ///
  /// 为什么要它在：「上一步」只在第 2 步之后才摆出来，如果它一出现就占住位置，卡脚那排按钮
  /// 会在第 1→2 步之间整体挪一下（主按钮横向跳一格）。所以第一次往前走之后就一直留着它——
  /// 位置稳定比"少一个用不上的按钮"重要（这是照着 [ConfirmDialog] 那族"按钮位置不跳"的分寸）。
  bool navigated = false;

  // ── 第一步：她叫什么（两格：名字 + 唤醒词表） ──
  /// 她的名字 → persona/IDENTITY.md 的「名字：」那一行
  late final TextEditingController nameCtl =
      TextEditingController(text: widget.signals.herName ?? '');

  /// 群里喊哪些词算在叫她 → channels.mentionKeywords（机器配置）
  late final TextEditingController keywordsCtl =
      TextEditingController(text: widget.signals.mentionKeywords.join('、'));

  /// 上一次由名字**自动**填进唤醒词框的内容。
  ///
  /// 为什么记它：填名字的时候顺手把唤醒词填上（"小七"填完，词表里就有"小七"），
  /// 但**只在人没有自己写过词表时**这么干——人改过的词表是一个决定，不能被名字的输入覆盖掉。
  /// 判据就是这个字段：框里的内容还是我们上次填的那份（或本来是空的），才可以再同步一次。
  String autoKeywords = '';

  // ── 第二步：API 配置 ──
  /// 模型名：出厂默认（`deepseek-chat`）或空 ⇒ 预填 [kDefaultModelName]（见 [initialOnboardingModel]）
  late final TextEditingController modelCtl =
      TextEditingController(text: initialOnboardingModel(widget.signals.model));
  late final TextEditingController baseCtl = TextEditingController(text: widget.signals.baseUrl);
  final keyCtl = TextEditingController();

  /// 密钥**此刻在哪几格**（格名 = `.keys.json` 的受管键名：`heavy` / `light`）。
  ///
  /// 初值来自 `GET /api/keys`（[OnboardingSignals.apiKeyGatesConfigured]）；写成功之后换成服务端
  /// 回执里那几格。判据只有一处：它是不是覆盖了 [OnboardingSignals.apiKeyGates] 的全部格。
  late List<String> keyGatesHolding = List<String>.of(widget.signals.apiKeyGatesConfigured);

  /// 这一趟**写不进去**的那几条路由（`degraded` 这种没有密钥格的）：回执要如实说出来
  List<({String route, String envName})> keyGatesNoSlot = const [];

  // ── 第二步：模型探测（2026-10-26）──
  //
  // 只有探测，**没有协议选择**（2026-10-26 用户：「算了，协议项不放在引导第二步吧，
  // 有点占位置了」）：那三档仍原样留在设置页（`settings_page.dart` 的 `_protocolPicker`），
  // 这一屏只是不再问。

  /// 正在探测（按钮转圈 + 结果区那一行"正在探测…"）
  bool probeRunning = false;

  /// 探测成功的结果（服务端 `POST /api/models/probe` 的原样回包；null = 还没成功过）
  Map<String, dynamic>? probe;

  /// 探测失败的**分档**（`unreachable` / `unauthorized` / `no-models-endpoint` / …）。
  ///
  /// 文案按它选（[AppStrings]），不把服务端那句中文直接摆给英文界面。
  String? probeFailureCode;

  /// 兜底失败的原文（只有认不出的 code 才显示；三类已知分档各有自己的话）
  String? probeFailureMessage;

  /// Base URL 空着就点了探测：就地红字，一个请求都不发
  bool probeBaseMissing = false;

  /// 探测请求的序号：飞行中改了 Base URL / 密钥 ⇒ 旧结果作废（不许盖掉新输入对应的那一份）。
  ///
  /// 为什么需要它：一次探测在网络里要待几百毫秒到十几秒，人完全可能在这期间改端点；
  /// 没有序号的话，旧端点回来的列表会摆在新端点下面，人照着选模型就选错了。
  int probeSeq = 0;

  /// 探测结果里被选中的模型（只是为了在列表里高亮；真相仍是 [modelCtl] 的文本）
  String? selectedProbeModel;

  /// 模型列表上方的搜索框（纯界面过滤，不改服务端任何东西）
  final modelSearchCtl = TextEditingController();

  // ── 第三步：消息适配器（现状 + 人这次的选择；勾上的就是"这次要开"的） ──
  late bool qqOn = widget.signals.qqEnabled;
  late bool onebotOn = widget.signals.onebotEnabled;

  /// QQ 官方 Bot 的两把凭据（用户 2026-10-18：首次就在这一页填）。
  ///
  /// 与第 2 步的 API Key 一个规格：**只写不读**，已经配置过就不回显、框留空
  /// （掩码摆在占位提示里，见 `secretLook`）。落盘走设置页「消息适配器」同一条 set-key，
  /// 键名取自 `channel_keys.dart`——两处填的是同一把凭据。
  final appIdCtl = TextEditingController();
  final appSecretCtl = TextEditingController();

  // ── 第三步的扫码入口（2026-10-23）──
  //
  // 这一组状态只属于**界面**：真正在轮询、在落盘的是后端那个绑定会话
  // （`src/channel/qq-bind.ts` 的 QqBindSession，成功那一刻自己写 `data/.keys.json`）。
  // 界面每 2 秒问一次 `/bind/status`，按回来的 status 换三态——所以**关掉这张卡也不会丢**：
  // 后端照样会把它落完，下次打开设置页就能看到 AppID 已配置。

  /// 人选的入口（默认扫码创建：推荐那条）
  _QqEntry qqEntry = _QqEntry.scan;

  /// 扫码那一支当前处在哪一态
  _QqBindPhase qqBindPhase = _QqBindPhase.idle;

  /// 二维码地址（发不出去浏览器时要把地址说出来，这是唯一不靠外部程序的办法）
  String? qqBindUrl;

  /// 成功之后服务端回的 AppID（**不是** secret：secret 永远不回显，只显示"已保存"）
  String? qqBindAppId;

  /// 成功那一刻两条落盘事实（服务端回执的原样）
  bool qqBindSaved = false;
  bool qqBindEnabled = false;

  /// 服务端自动跑的那一次连接测试（`ok` 为 null = 还没跑到/不知道）
  bool? qqBindConnectionOk;
  int? qqBindExpiresIn;
  String? qqBindConnectionError;

  /// 扫码那一支最近一句人话（发起失败 / 查状态失败 / 保存失败）
  String? qqBindError;

  /// 界面的轮询定时器（2 秒一次；离场/成功/过期/取消都释放）
  Timer? qqBindTimer;

  /// 上一次轮询还没回来：别叠着发（假服务/慢网络下会把同一个请求排成一串）
  bool qqBindPolling = false;

  // 「填写凭据」那一支的「测试连接」结果（与服务端 `qq-token-test` 同一条端点）
  bool qqTestRunning = false;
  bool? qqTestOk;
  int? qqTestExpiresIn;
  String? qqTestError;

  /// 第四步：人格
  late final TextEditingController personaCtl =
      TextEditingController(text: widget.signals.identityContent ?? '');

  /// 第五步：信任范围（盘上那份的当前档 + 人这次选的档）。
  ///
  /// 默认值就是 [defaultTrustMode]（= `'full'`，配置默认值）——**不是**"没选"：
  /// 引导页上必须有一档是选中的，而且那一档要与配置里的默认值一致（用户的原话）。
  late String trustMode = widget.signals.trustMode;

  /// 第四步输入框的**基准**（= 服务端那句"现正文"）。
  ///
  /// 为什么要一个可变字段而不是每次读 `signals.identityContent`：第一步写完名字之后，
  /// 服务端那份正文就变了（多了「名字：」那一行），基准得跟着走——否则第四步会把
  /// 第一步刚写的名字当成"人的改动"，或者反过来把名字冲掉。
  late String personaBase = widget.signals.identityContent ?? '';

  // ── 第六步：外部依赖（2026-10-20 用户第 3 轮 ⑤） ──
  //
  // 这一屏的四件事：现状（只读 /api/deps）、勾选框、逐件串行安装、装完要重启。
  // **一律不新写安装逻辑**：安装请求就是设置页 `_installDep` 那一条（同端点、同
  // `X-Confirm: dep-install`），重启就是 `restart_action.dart` 的 `performRestart`。

  /// 四件依赖的现状（顺序固定为 [kOnboardingDepNames]；读不到时是空表）
  List<OnboardingDep> deps = const <OnboardingDep>[];

  /// 正在读 `/api/deps`（这一屏的三态之一）
  bool depsLoading = false;

  /// 读不到的原因（null = 读到了）
  String? depsError;

  /// 服务端没装配依赖管理器（`available: false`）：这一屏只说明，不摆勾选框、不装
  bool depsUnavailable = false;

  /// 读现状那条 Future：人可能一进这一屏就点「完成」，那时先等它，再决定装哪几件
  Future<void>? depsPending;

  /// 这一屏有没有发起过那条读（一次就够：装完的现状由安装回执就地更新）
  bool depsRequested = false;

  /// 勾选框：下载并安装这些外部依赖。
  ///
  /// **默认勾上**（用户的要求）；但"上次没勾"那个决定会被 [DepsAttempt] 读回来
  /// （见 [_restoreDepsAttempt]）——复查要看得见，同时没勾就一个请求都不发。
  bool depsInstallChecked = true;

  /// 人这一趟亲手改过勾选框没有（改过就不让读回来的旧值盖掉它）
  bool depsCheckTouched = false;

  /// 正在装哪一件（null = 没在装）
  String? depsRunning;

  /// 这一轮每件的结局：名字 → (成了没, 原因/版本)
  final Map<String, ({bool ok, String reason})> depsResults = <String, ({bool ok, String reason})>{};

  /// 这一轮装完没有（装完才摆汇总行与「重试」）
  bool depsRoundDone = false;

  /// 上一次装完的结局（上一轮，或上一次开这张卡时落盘的那一份）——复查就靠它
  DepsAttempt? depsLastAttempt;

  @override
  void initState() {
    super.initState();
    // 上次装完的结局：开卡就读回来（本地文件，不打服务端）。读回来之后这一屏才有
    // "上次装完：成功 N / 失败 M"那一行，勾选框也照上次那个决定。
    unawaited(_restoreDepsAttempt());
  }

  /// 读回上一次装完的结局（见 [kOnboardingDepsKey]）。
  Future<void> _restoreDepsAttempt() async {
    final attempt = await loadDepsAttempt();
    if (!mounted || attempt == null) return;
    setState(() {
      depsLastAttempt = attempt;
      if (!depsCheckTouched) depsInstallChecked = attempt.checked;
    });
  }

  @override
  void dispose() {
    // 扫码轮询的定时器随这张卡一起释放：卡没了就没有"再查一次"的意义
    // （后端那一轮会话不受影响：它自己会把成功结果落盘，最长 3 分钟自己结束）
    qqBindTimer?.cancel();
    qqBindTimer = null;
    // 退场动画跑完再销毁输入控制器：`showDialog` 的 Future 在路由弹出时就 resolve，
    // 而这几个 TextField 还要几十毫秒才从树上摘掉（原因见 ui_kit 里那段注释）。
    for (final ctl in [
      nameCtl,
      keywordsCtl,
      modelCtl,
      baseCtl,
      keyCtl,
      modelSearchCtl,
      appIdCtl,
      appSecretCtl,
      personaCtl,
    ]) {
      disposeLater(ctl);
    }
    super.dispose();
  }

  /// 第 2 步那两格（模型名 / Base URL）有没有一项与盘上不同。
  ///
  /// 基准是"**这一屏进来时摆的是什么**"：
  ///   · 首次启动（[widget.fromFirstRun] = true）时基准是盘上那份——这一格摆的是
  ///     [kDefaultModelName] 而盘上还是后端出厂值（`deepseek-chat`）时，点「继续」就写一次
  ///     （"默认走 deepseek-flash"这条要求落地的形状）；
  ///   · 手动打开（false）时基准是**预填值**：人只是打开看看，什么都没改就关掉 ⇒ 零写入
  ///     （`onboarding_manual_open_test` 钉着这条）。
  ///
  /// **两格是一组**：任何一格变了，就把两格一起写（见 `_settleApi`）——只写一半的配置
  /// 下一次启动就是连不上的那一半。
  ///
  /// 协议（`models.heavy.protocol`）**不在这里**：引导页不问它（2026-10-26），也就不该拿它
  /// 当"改没改"的判据；设置页那三档自己管自己那一份。
  bool get _apiDirty {
    final baseline = widget.fromFirstRun
        ? widget.signals.model
        : initialOnboardingModel(widget.signals.model);
    return modelCtl.text.trim() != baseline || baseCtl.text.trim() != widget.signals.baseUrl;
  }

  bool get _keyDirty => keyCtl.text.trim().isNotEmpty;

  /// 两把凭据都填上了就把 QQ 官方 Bot 勾上（只自动勾、不自动取消）。
  ///
  /// 为什么要有这一下：用户要的是"首次就能填"——填完两把凭据却还得再勾一个框，
  /// 那一步谁都会漏；漏了的下场是"填完了她照样收不到消息"，而界面没有任何提示。
  /// 只勾不取消：人手动取消过就是一个决定，不能被输入框里的字又翻回来。
  void _syncQqFromCredentials() {
    if (qqOn || widget.signals.qqEnabled) return;
    if (appIdCtl.text.trim().isEmpty || appSecretCtl.text.trim().isEmpty) return;
    qqOn = true;
  }

  bool get _personaDirty => personaCtl.text.trim() != personaBase.trim();

  /// 现在"她叫什么"这件事上已知的名字：第一步那一格填着就用它，否则用读到的现状。
  /// 第四步写正文时用它把「名字：」那一行带上（换了正文不该把名字弄丢）。
  String get _knownName {
    final typed = sanitizeHerNameInput(nameCtl.text);
    return typed.isNotEmpty ? typed : sanitizeHerNameInput(widget.signals.herName ?? '');
  }

  /// 名字格敲字时把唤醒词框顺手带上（只在人没自己写过词表时，理由见 [autoKeywords]）
  void _syncKeywordsFromName() {
    final current = keywordsCtl.text.trim();
    if (current.isNotEmpty && current != autoKeywords) return;
    final next = sanitizeHerNameInput(nameCtl.text);
    if (next == current) return;
    autoKeywords = next;
    keywordsCtl.text = next;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // 六步的标题与说明来自文案表（切语言时这一步跟着变，见 `_stepCopyOf`）
    final steps = _stepCopyOf(IrmiaStrings.of(context));
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        side: BorderSide(color: scheme.outlineVariant),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kOnboardingCardWidth),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _header(scheme, steps.length),
            Padding(
              padding: const EdgeInsets.fromLTRB(22, 4, 22, 14),
              child: _stepStrip(scheme, steps),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(22, 0, 22, 4),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: _bodyMinHeight),
                  child: _body(scheme, steps),
                ),
              ),
            ),
            if (receipt != null) _receiptBar(scheme),
            if (problem != null) _problemBar(scheme),
            if (requirement != null) _requirementBar(scheme),
            _footer(scheme, steps.length),
          ],
        ),
      ),
    );
  }

  // ── 卡头：她的脸 + 标题 + 关闭 ──

  Widget _header(ColorScheme scheme, int stepCount) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(22, 20, 14, 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const HerFace(size: 40),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text(kOnboardingTitle,
                        style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                    const SizedBox(width: 8),
                    Text('${step + 1} / $stepCount',
                        style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                  ],
                ),
                const SizedBox(height: 4),
                Text('$stepCount 步把她的基本配置填完，跳过的那几项之后在设置页里随时能改。',
                    style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant)),
                // 手动打开时挂一行可见标识：这张卡与"首次启动自己弹出来"是两条路，
                // 不标出来，人看到它就会以为"怎么又自己弹了"（2026-10-21）。
                if (!widget.fromFirstRun) ...[
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Icon(Icons.touch_app_rounded, size: 13, color: scheme.primary),
                      const SizedBox(width: 4),
                      Flexible(
                        child: Text(
                          IrmiaStrings.of(context).onboardingManualOpenBadge,
                          style: TextStyle(
                            fontSize: 12,
                            height: 1.5,
                            color: scheme.primary,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          IconButton(
            onPressed: busy ? null : () => unawaited(_finish()),
            icon: const Icon(Icons.close_rounded, size: 18),
            color: scheme.onSurfaceVariant,
            tooltip: kOnboardingCloseLabel,
          ),
        ],
      ),
    );
  }

  /// 步骤条：序号 + 标题。点已经走过的那几步可以一步一步退回去改（与「上一步」同一条路）
  Widget _stepStrip(ColorScheme scheme, List<_StepCopy> steps) {
    return Row(
      children: [
        for (var i = 0; i < steps.length; i++) ...[
          if (i > 0)
            Expanded(
              child: Container(
                height: 1,
                margin: const EdgeInsets.symmetric(horizontal: 6),
                color: i <= step ? scheme.primary.withValues(alpha: 0.45) : scheme.outlineVariant,
              ),
            ),
          _stepChip(i, scheme, steps),
        ],
      ],
    );
  }

  Widget _stepChip(int index, ColorScheme scheme, List<_StepCopy> steps) {
    final active = index == step;
    final done = index < step;
    final tone = active ? scheme.primary : (done ? scheme.primary : scheme.onSurfaceVariant);
    return InkWell(
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      onTap: (busy || index >= step) ? null : () => unawaited(_stepBack(index)),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 18,
              height: 18,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: active ? scheme.primary : Colors.transparent,
                border: Border.all(color: tone.withValues(alpha: active ? 1 : 0.5)),
                shape: BoxShape.circle,
              ),
              child: Text(
                '${index + 1}',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: active ? scheme.onPrimary : tone,
                ),
              ),
            ),
            const SizedBox(width: 6),
            Text(
              steps[index].title,
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                color: tone,
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 「这一步真的写成了」：与 [_problemBar] 同一块版式，换成 ok 色。
  ///
  /// 为什么要它（2026-10-20，用户实测的挫败点）：密钥那一步从前**写成功什么都不说**，
  /// 人只能去设置页确认，而设置页按格显示——引导页只写了 heavy 一格时，light 那张卡写着
  /// 「未配置」，于是"我明明填了 key"和"界面说没配"同时成立。回执把**哪几格拿到了这把 key**
  /// 直接摆在卡上（格名来自服务端回执），写完之后一直留到卡片关掉——后面几步也看得见。
  Widget _receiptBar(ColorScheme scheme) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(22, 6, 22, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.ok.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.ok.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.check_circle_outline_rounded, size: 16, color: IrmiaTheme.ok),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              receipt!,
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  Widget _problemBar(ColorScheme scheme) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(22, 6, 22, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.danger.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              problem!,
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  /// 「这一屏还缺一样东西」：与 [_problemBar] 同一块版式，只是换成 warn 色。
  ///
  /// 为什么与"写失败"分开：[problem] 是"这次没成，改完再来"，会把人留在卡里；而缺一样东西
  /// 是"还没填，你要么现在填、要么明确跳过"——后者不该把人锁住（见 [_finish]）。
  /// 出路就是卡脚那颗「跳过这一步」，所以这里不再放第二个同名按钮（两个一样的动作只会让人犹豫点哪个）。
  Widget _requirementBar(ColorScheme scheme) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.fromLTRB(22, 6, 22, 0),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: IrmiaTheme.warn.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.warn.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.info_outline_rounded, size: 16, color: IrmiaTheme.warn),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              requirement!,
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }

  Widget _footer(ColorScheme scheme, int stepCount) {
    final last = step == stepCount - 1;
    return Container(
      padding: const EdgeInsets.fromLTRB(22, 12, 22, 16),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          TextButton(
            onPressed: busy ? null : () => unawaited(_finish()),
            style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
            child: const Text('以后再说'),
          ),
          const Spacer(),
          // 「上一步」第一次往前走之后就一直留着（位置不跳，理由见 navigated）
          if (step > 0 || navigated) ...[
            TextButton(
              onPressed: (busy || step == 0) ? null : () => unawaited(_back()),
              child: const Text(kOnboardingBackLabel),
            ),
            const SizedBox(width: 6),
          ],
          TextButton(
            onPressed: busy ? null : () => unawaited(_skipStep()),
            child: const Text(kOnboardingSkipLabel),
          ),
          const SizedBox(width: 6),
          FilledButton(
            // 最后一步那颗是「完成」：**只有它**会把第 6 步的安装跑起来（install: true）。
            // 「以后再说」/ 关闭 / 跳过这一步都不装——"我只是打开看了看"不该落四个可执行文件。
            onPressed: busy ? null : () => unawaited(last ? _finish(install: true) : _next()),
            child: busy
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(last ? kOnboardingDoneLabel : kOnboardingNextLabel),
          ),
        ],
      ),
    );
  }

  // ── 每步的正文 ──

  Widget _body(ColorScheme scheme, List<_StepCopy> steps) {
    final copy = steps[step];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(copy.title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Text(copy.note, style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 16),
        switch (step) {
          0 => _nameStep(scheme),
          1 => _apiStep(scheme),
          2 => _channelStep(scheme),
          3 => _personaStep(scheme),
          4 => _trustStep(scheme),
          _ => _depsStep(scheme),
        },
      ],
    );
  }

  /// 框下面那行旁注：与设置页的 note 同一形态（12px / 行高 1.7 / onSurfaceVariant）
  Widget _note(String text, ColorScheme scheme) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(text, style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant)),
      );

  /// 第一步：她的名字（人格资产）+ 唤醒词表（机器配置）。
  ///
  /// 为什么是两格而不是一格：这是**两件事**，以前挤在一格里（只写词表）正是这次的 bug。
  ///   ① 名字 = 她是谁，落在 `persona/IDENTITY.md` 的「名字：」那一行——界面上的称呼
  ///      （窗口标题、左侧栏、托盘提示、"她问你"那张卡）读的都是它；
  ///   ② 词表 = 机器怎么认出在叫她，落在 `channels.mentionKeywords`——是**唤醒判据**，
  ///      从名字派生出来的第一份默认值，人可以按群里的叫法改宽或改窄。
  /// 名字改了而词表没改，群里喊新名字她照样听不见——所以两格并排摆着，关系写在旁注里。
  ///
  /// 两段旁注（名字框下 / 词表下）**第 3 轮压成了一行**（用户 2026-10-20 ①）：一行里
  /// 说清"写哪儿、有没有快照能回滚、怎么分隔、清空等于什么"，字数上界由用例钉着。
  Widget _nameStep(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('她的名字', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: nameCtl,
          autofocus: true,
          style: const TextStyle(fontSize: 13),
          onChanged: (_) => setState(() {
            problem = null;
            _syncKeywordsFromName();
          }),
          decoration: const InputDecoration(hintText: '小七'),
        ),
        _note(s.onboardingStepNameHint, scheme),
        const SizedBox(height: 16),
        Text('群里喊哪些词算在叫她', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          controller: keywordsCtl,
          style: const TextStyle(fontSize: 13),
          onChanged: (_) => setState(() => problem = null),
          decoration: InputDecoration(hintText: mentionKeywordsHint(_knownName)),
        ),
        _note(s.onboardingKeywordsHint, scheme),
      ],
    );
  }

  // ── 第 2 步：探测（2026-10-26）──
  //
  // 探测走 `POST /api/models/probe`（唯一的新端点，见 src/web/server.ts）。界面在这一层
  // 只做四件事：**收集输入**（model 当前值 / baseUrl / 可选的新密钥）、**分档显示失败**、
  // **让模型列表可搜索可选**、**把两套协议通不通翻成一句人话**。它不自己发外部请求，
  // 也不替服务端猜"哪些模型走 Responses 通"——那是实测结论。
  //
  // 这一层**不管"选哪个协议"**：那三档在设置页（2026-10-26 起引导页不问，见 `_apiStep`）。

  /// 点「探测」：先本地判 Base URL 非空（空着就不发请求），再调那一条端点。
  Future<void> _runProbe() async {
    if (probeRunning) return;
    final s = IrmiaStrings.read(context);
    final baseUrl = baseCtl.text.trim();
    if (baseUrl.isEmpty) {
      // 就地红字；**一个请求都不发**（"先填 Base URL"是本地就能回答的事）
      setState(() {
        probeBaseMissing = true;
        probe = null;
        probeFailureCode = null;
        probeFailureMessage = null;
      });
      return;
    }
    setState(() {
      probeRunning = true;
      probeBaseMissing = false;
      probe = null;
      probeFailureCode = null;
      probeFailureMessage = null;
      selectedProbeModel = null;
      modelSearchCtl.clear();
    });
    final seq = ++probeSeq;
    final key = keyCtl.text.trim();
    try {
      final data = await widget.state.api.post('/api/models/probe', {
        'lane': 'heavy',
        'baseUrl': baseUrl,
        // 框里刚打的密钥优先（人可能还没点「继续」保存）；空着就让服务端用已存的那把
        if (key.isNotEmpty) 'apiKey': key,
      });
      if (!mounted || seq != probeSeq) return;
      final map = data is Map ? Map<String, dynamic>.from(data) : null;
      if (map == null) {
        setState(() {
          probeFailureCode = 'request-failed';
          probeFailureMessage = s.onboardingProbeFailed('服务端返回的不是 JSON 对象');
        });
      } else if (map['ok'] == true) {
        setState(() {
          probe = map;
        });
      } else {
        setState(() {
          probeFailureCode = map['code']?.toString();
          probeFailureMessage = map['message']?.toString() ?? '';
        });
      }
    } catch (err) {
      if (!mounted || seq != probeSeq) return;
      setState(() {
        probeFailureCode = 'request-failed';
        probeFailureMessage = s.onboardingProbeFailed('$err');
      });
    } finally {
      if (mounted && seq == probeSeq) setState(() => probeRunning = false);
    }
  }

  /// 从结果列表里点中一个模型：写回「模型名」输入框（只改这一格，不碰 Base URL）
  void _pickProbeModel(String name) {
    setState(() {
      modelCtl.text = name;
      selectedProbeModel = name;
      problem = null;
    });
  }

  /// 探测结果里的模型清单（形状不对 = 空表；不在这里抛）
  List<String> get _probeModelList {
    final raw = probe?['models'];
    if (raw is! List) return const <String>[];
    return raw.whereType<String>().toList(growable: false);
  }

  /// 搜索框过滤之后的清单（大小写不敏感的子串；空查询 = 全量）
  List<String> get _probeFilteredModels {
    final query = modelSearchCtl.text.trim().toLowerCase();
    if (query.isEmpty) return _probeModelList;
    return _probeModelList
        .where((name) => name.toLowerCase().contains(query))
        .toList(growable: false);
  }

  /// 探测结果里某一套协议通不通（`key` = `responses` / `chat`）
  bool _probeSupported(String key) {
    final raw = probe?[key];
    if (raw is! Map) return false;
    return raw['supported'] == true;
  }

  /// 探测结果里某一套协议的耗时（毫秒；缺项 = null，界面上显示 `—`）
  int? _probeLatency(String key) {
    final raw = probe?[key];
    if (raw is! Map) return null;
    final value = raw['latencyMs'];
    return value is num ? value.round() : null;
  }

  /// 服务端 warnings（橙色小字，原样显示——那是数据，不是界面文案）
  List<String> get _probeWarnings {
    final raw = probe?['warnings'];
    if (raw is! List) return const <String>[];
    return raw.whereType<String>().where((line) => line.trim().isNotEmpty).toList(growable: false);
  }

  /// 失败分档 → 界面话。三类已知分档各有自己的出路文案（不可达 / 密钥无效 / 没有 /models），
  /// `no-api-key` 与兜底各有各的；**不把服务端那句中文原样摆给英文界面**。
  String _probeFailureText(AppStrings s) {
    switch (probeFailureCode) {
      case 'unreachable':
        return s.onboardingProbeUnreachable;
      case 'unauthorized':
        return s.onboardingProbeUnauthorized;
      case 'no-models-endpoint':
        return s.onboardingProbeNoModels;
      case 'no-api-key':
        return s.onboardingProbeNoKey;
      default:
        final detail = probeFailureMessage?.trim() ?? '';
        return detail.isEmpty ? s.onboardingProbeFailed('—') : s.onboardingProbeFailed(detail);
    }
  }

  /// 探测结论里"这个端点**只**通一套协议"时，那套协议的名字（null = 通两套 / 两套都不通 / 还没探测）。
  ///
  /// 这是一句**事实陈述**，不是"建议你去选某一档"（引导页 2026-10-26 起不问协议了，
  /// 那三档仍在设置页）。两端都不可用或都可用时没有话可说，返回 null。
  ///
  /// 返回的是服务端那两套协议的名字（`Responses` / `Chat Completions`）：它们是产品事实，
  /// 两种语言里都这么写，所以不由文案表翻译（与 `onboardingProbeBadge` 同一口径）。
  String? _probeSingleProtocol() {
    if (probe == null) return null;
    final responsesOk = _probeSupported('responses');
    final chatOk = _probeSupported('chat');
    if (responsesOk == chatOk) return null;
    return responsesOk ? 'Responses' : 'Chat Completions';
  }

  /// 结果区里的一行模型：名字 + 两套协议的实测徽章；点一下写回模型名输入框。
  Widget _probeModelRow(String name, ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    final responsesOk = _probeSupported('responses');
    final chatOk = _probeSupported('chat');
    final selected = selectedProbeModel == name || modelCtl.text.trim() == name;
    return InkWell(
      key: ValueKey('onboarding-probe-model-$name'),
      onTap: () => _pickProbeModel(name),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: Space.x2, vertical: 7),
        decoration: BoxDecoration(
          color: selected ? scheme.primary.withValues(alpha: 0.10) : null,
          border: Border(bottom: BorderSide(color: scheme.outlineVariant.withValues(alpha: 0.6))),
        ),
        child: Row(
          children: [
            if (selected) ...[
              Icon(Icons.check_rounded, size: 14, color: scheme.primary),
              const SizedBox(width: 4),
            ],
            Expanded(
              child: Text(
                name,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12.5,
                  color: selected ? scheme.primary : scheme.onSurface,
                  fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text(
              s.onboardingProbeBadge('Responses', responsesOk),
              style: TextStyle(fontSize: 11, color: responsesOk ? IrmiaTheme.ok : scheme.error),
            ),
            const SizedBox(width: 8),
            Text(
              s.onboardingProbeBadge('Chat', chatOk),
              style: TextStyle(fontSize: 11, color: chatOk ? IrmiaTheme.ok : scheme.error),
            ),
          ],
        ),
      ),
    );
  }

  /// 探测结果区（有内容才展开）：三态 = 探测中 / 失败分档 / 有结果。
  ///
  /// **失败不收起输入**：本方法只画结果区，输入框在它上面、状态全在 controller 里，
  /// 一次失败不会清掉任何一个字（用户明确要求："失败时保留输入"）。
  Widget _probeResultArea(ColorScheme scheme, AppStrings s) {
    final hasFailure = probeFailureCode != null;
    if (!probeRunning && probe == null && !hasFailure) return const SizedBox.shrink();
    final children = <Widget>[];
    if (probeRunning) {
      children.add(Row(
        key: const ValueKey('onboarding-probe-running'),
        children: [
          const SizedBox(
            width: 13,
            height: 13,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          const SizedBox(width: Space.x2),
          Text(
            s.onboardingProbeRunning,
            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
          ),
        ],
      ));
    } else if (hasFailure) {
      children.add(Text(
        _probeFailureText(s),
        key: const ValueKey('onboarding-probe-failure'),
        style: TextStyle(fontSize: 12, height: 1.6, color: scheme.error),
      ));
    } else if (probe != null) {
      final models = _probeFilteredModels;
      final allModels = _probeModelList;
      final responsesOk = _probeSupported('responses');
      final chatOk = _probeSupported('chat');
      final recommended = probe?['recommended'];
      children.add(Text(
        s.onboardingProbeDone(
          count: allModels.length,
          responsesOk: responsesOk,
          responsesMs: _probeLatency('responses'),
          chatOk: chatOk,
          chatMs: _probeLatency('chat'),
          recommended: recommended is String && recommended.trim().isNotEmpty ? recommended : null,
        ),
        key: const ValueKey('onboarding-probe-summary'),
        style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
      ));
      children.add(const SizedBox(height: Space.x2));
      children.add(TextField(
        key: const ValueKey('onboarding-probe-search'),
        controller: modelSearchCtl,
        autocorrect: false,
        enableSuggestions: false,
        style: const TextStyle(fontSize: 12.5),
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(
          hintText: s.onboardingProbeSearchHint,
          isDense: true,
          prefixIcon: const Icon(Icons.search_rounded, size: 16),
        ),
      ));
      children.add(const SizedBox(height: Space.x1));
      children.add(Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          border: Border.all(color: scheme.outlineVariant),
        ),
        clipBehavior: Clip.antiAlias,
        child: models.isEmpty
            ? Padding(
                padding: const EdgeInsets.all(Space.x2),
                child: Text(
                  allModels.isEmpty ? s.onboardingProbeEmptyList : s.onboardingProbeNoMatch,
                  key: const ValueKey('onboarding-probe-no-match'),
                  style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                ),
              )
            : ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 168),
                child: ListView.builder(
                  shrinkWrap: true,
                  padding: EdgeInsets.zero,
                  itemCount: models.length,
                  itemBuilder: (_, index) => _probeModelRow(models[index], scheme),
                ),
              ),
      ));
      // 「这个端点只通一套协议」是实测结论里的一句事实（中性色，不是警告、不是建议）：
      // 引导页不问协议，但人得知道这一端点另一套不通——否则下一屏（设置页）里那三档
      // 就成了没有依据的选择。
      final only = _probeSingleProtocol();
      if (only != null) {
        children.add(const SizedBox(height: Space.x2));
        children.add(Text(
          s.onboardingProbeOnlyProtocol(only),
          key: const ValueKey('onboarding-probe-single-protocol'),
          style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant),
        ));
      }
      for (final (index, warning) in _probeWarnings.indexed) {
        children.add(const SizedBox(height: Space.x1));
        children.add(Text(
          s.onboardingProbeWarning(warning),
          key: ValueKey('onboarding-probe-warning-$index'),
          style: TextStyle(fontSize: 11.5, height: 1.5, color: IrmiaTheme.warn),
        ));
      }
    }
    return Container(
      key: const ValueKey('onboarding-probe-result'),
      margin: const EdgeInsets.only(top: Space.x3),
      padding: const EdgeInsets.all(Space.x3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
  }

  Widget _apiStep(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    // 已配置时的样子（蓝、居中）与设置页的密钥格共用一份：ui_kit 的 secretLook
    final gates = widget.signals.apiKeyGates;
    final holding = gates.where(keyGatesHolding.contains).toList();
    final missing = gates.where((gate) => !keyGatesHolding.contains(gate)).toList();
    final ready = gates.isNotEmpty && missing.isEmpty;
    // 占位提示说清**写到了哪几格**（2026-10-20：从前只有一句"已配置"，人看不出 heavy / light
    // 到底谁有——而那正是设置页按格显示的那个答案）。三态：全有 / 只有几格 / 一格都没有。
    final hint = ready
        ? s.onboardingApiKeyHintWritten(_gatesLabel(gates))
        : (holding.isNotEmpty
            ? s.onboardingApiKeyHintPartial(_gatesLabel(holding), _gatesLabel(missing))
            : 'sk-…');
    final look = secretLook(
      context,
      configured: ready,
      hintFontSize: 13,
      base: InputDecoration(hintText: hint),
    );
    // 状态那一行：**能看出配没配、属于哪一档**，但永远不显示内容（只有格名）。
    final statusText = ready
        ? s.onboardingApiKeyStatusWritten(_gatesLabel(gates))
        : (holding.isEmpty
            ? s.onboardingApiKeyStatusMissing
            : s.onboardingApiKeyStatusPartial(_gatesLabel(holding)));
    final statusColor = ready
        ? IrmiaTheme.ok
        : (holding.isEmpty ? scheme.onSurfaceVariant : IrmiaTheme.warn);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(s.onboardingModelLabel, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('onboarding-model'),
                controller: modelCtl,
                autocorrect: false,
                enableSuggestions: false,
                style: const TextStyle(fontSize: 13),
                onChanged: (_) => setState(() => problem = null),
                // 框里已经有默认值（[kDefaultModelName]），提示只在人清空之后才看得见
                decoration: const InputDecoration(hintText: kDefaultModelName),
              ),
            ),
            const SizedBox(width: Space.x2),
            SizedBox(
              width: 88,
              height: 44,
              child: OutlinedButton(
                key: const ValueKey('onboarding-probe'),
                onPressed: probeRunning ? null : () => unawaited(_runProbe()),
                child: probeRunning
                    ? const SizedBox(
                        width: 15,
                        height: 15,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(s.onboardingProbeButton),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Text(s.onboardingBaseUrlLabel, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 6),
        TextField(
          key: const ValueKey('onboarding-base'),
          controller: baseCtl,
          autocorrect: false,
          enableSuggestions: false,
          style: const TextStyle(fontSize: 13),
          // 端点变了 ⇒ 上一次的探测结果是对旧端点的，必须作废（否则人会照着旧列表选模型）；
          // 飞行中的那一条也一并作废：`probeSeq` 一加，它回来时自己会被丢掉。
          onChanged: (_) => setState(() {
            problem = null;
            probeBaseMissing = false;
            probe = null;
            probeFailureCode = null;
            probeFailureMessage = null;
            probeSeq += 1;
            probeRunning = false;
          }),
          decoration: const InputDecoration(hintText: 'https://api.deepseek.com'),
        ),
        _note(s.onboardingBaseUrlNote, scheme),
        if (probeBaseMissing)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              s.onboardingProbeBaseRequired,
              key: const ValueKey('onboarding-probe-base-required'),
              style: TextStyle(fontSize: 11.5, color: scheme.error),
            ),
          ),
        // 协议三档**不在这屏**（2026-10-26 用户：「算了，协议项不放在引导第二步吧，有点占位置了」）：
        // 那组单选整块删掉，设置页里那三档原样留着（`settings_page.dart` 的 `_protocolPicker`）。
        // 探测结果区里的 `Responses ✓ / Chat ✓` 与摘要那行照旧——那是实测信息，不是选择项。
        const SizedBox(height: Space.x3),
        Row(
          children: [
            Text(s.onboardingApiKeyLabel, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
            const Spacer(),
            Text(
              statusText,
              key: const ValueKey('onboarding-api-key-status'),
              style: TextStyle(fontSize: 11.5, color: statusColor),
            ),
          ],
        ),
        const SizedBox(height: 6),
        TextField(
          key: const ValueKey('onboarding-api-key'),
          controller: keyCtl,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          style: const TextStyle(fontSize: 13),
          textAlign: look.textAlign,
          // 又动手改这把 key 了 ⇒ 上一次那条回执与探测结果都过时了，收掉
          onChanged: (_) => setState(() {
            problem = null;
            receipt = null;
            probe = null;
            probeFailureCode = null;
            probeFailureMessage = null;
            probeSeq += 1;
            probeRunning = false;
          }),
          decoration: look.decoration,
        ),
        // 用户 ②（2026-10-18）：原来这里是一段"密钥只写不读…"的解释，删掉，换成
        // 「我们推荐您使用 DeepSeek 的模型」+「点击注册账号并获取 API Key」两段话，
        // 里面那两截是蓝链——点开浏览器去 DeepSeek 的 API 平台（注册页）。
        // 地址是产品事实（两种语言同一个），文案在 AppStrings 里。
        //
        // 第 3 轮（2026-10-20 用户 ②）：那**两行合成一行**——原来一次 `_recommendLine`
        // 只有一句话，两行读起来像两条互不相干的推荐；现在四段排在同一行（同一个 [Wrap]），
        // 中间那个连接词也进文案表（英文是 ", "、中文是 "，"）。
        const SizedBox(height: Space.x3),
        _recommendLine(
          scheme,
          [
            (text: s.onboardingApiRecommendLead, url: null, keyName: null),
            (
              text: s.onboardingApiRecommendModel,
              url: kDeepSeekPlatformUrl,
              keyName: 'onboarding-link-deepseek-model',
            ),
            (text: s.onboardingApiRecommendJoin, url: null, keyName: null),
            (
              text: s.onboardingApiRegisterKey,
              url: kDeepSeekSignupUrl,
              keyName: 'onboarding-link-deepseek-signup',
            ),
          ],
          // 用例按这个 key 找"那一行"：整句话只许有一个 [Wrap]（两行就成两个了）
          lineKey: const ValueKey('onboarding-api-recommend'),
        ),
        _probeResultArea(scheme, s),
      ],
    );
  }

  Widget _channelStep(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 用户 ③（2026-10-18）：一句推荐 + 蓝链，链到 QQ 开放平台。
        // 「QQ 官方 Bot」那截可点，句子其余部分照原文排（语序两种语言各一份，见 AppStrings）。
        _recommendLine(scheme, [
          (text: s.onboardingChannelRecommendLead, url: null, keyName: null),
          (
            text: s.onboardingChannelRecommendQq,
            url: kQqOpenPlatformUrl,
            keyName: 'onboarding-link-qq-open-platform',
          ),
          (text: s.onboardingChannelRecommendTail, url: null, keyName: null),
        ]),
        const SizedBox(height: Space.x3),
        _channelTile(
          scheme,
          label: 'QQ 官方 Bot API',
          detail: s.onboardingQqTileDetail,
          value: qqOn,
          wasOn: widget.signals.qqEnabled,
          onChanged: (next) => setState(() {
            qqOn = next;
            problem = null;
          }),
        ),
        const SizedBox(height: Space.x2),
        // **两个并列入口**（用户 2026-10-23）：扫码创建（推荐）/ 填写凭据。
        // 扫码那条走 `/api/channels/qq-official/bind/*`；填凭据那条就是原来那两格
        // （同一个 set-key、同一对键名、同一条落盘路径）。
        _qqEntrySwitch(scheme, s),
        const SizedBox(height: Space.x2),
        if (qqEntry == _QqEntry.scan)
          _qqScanPanel(scheme, s)
        else
          _qqCredentialFields(scheme, s),
        const SizedBox(height: Space.x2),
        _channelTile(
          scheme,
          label: 'OneBot 11',
          // 用户 2026-10-23：这里只写一句「配置完成后可自行另行设置。」——
          // 不做任何自动流程（不扫、不填、不检测协议端）。
          detail: s.onboardingOnebotDetail,
          value: onebotOn,
          wasOn: widget.signals.onebotEnabled,
          onChanged: (next) => setState(() {
            onebotOn = next;
            problem = null;
          }),
        ),
        _note(!widget.signals.channelsReady
            ? '两个都关着 = 她收不到任何消息；之后在「消息适配器」页里随时能开。'
            : '现在开着的那条不会再被这里关掉（这一屏只负责"要开哪条"）。', scheme),
      ],
    );
  }

  /// 两个并列入口的二选一（扫码 / 填凭据）。
  ///
  /// 用 [SegmentedButton] 而不是两颗按钮：这是**同一个问题的两种填法**（QQ 官方 Bot 从哪来），
  /// 二选一的语义靠控件本身说清；两颗并排的按钮会让人以为可以"都点一下"。
  Widget _qqEntrySwitch(ColorScheme scheme, AppStrings s) {
    return Align(
      alignment: Alignment.centerLeft,
      child: SegmentedButton<_QqEntry>(
        key: const ValueKey('onboarding-qq-entry'),
        segments: [
          ButtonSegment<_QqEntry>(
            value: _QqEntry.scan,
            label: Text(s.onboardingQqEntryScan),
            icon: const Icon(Icons.qr_code_2_rounded, size: 16),
          ),
          ButtonSegment<_QqEntry>(
            value: _QqEntry.manual,
            label: Text(s.onboardingQqEntryManual),
            icon: const Icon(Icons.key_rounded, size: 16),
          ),
        ],
        selected: <_QqEntry>{qqEntry},
        showSelectedIcon: false,
        onSelectionChanged: busy
            ? null
            : (picked) => setState(() {
                  qqEntry = picked.first;
                  problem = null;
                }),
      ),
    );
  }

  /// 扫码创建那一支的面板：三态（进行中 / 成功 / 过期）+ 发起失败的人话。
  Widget _qqScanPanel(ColorScheme scheme, AppStrings s) {
    return Container(
      padding: const EdgeInsets.all(Space.x3),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.onboardingQqBindIntro, style: _asideStyle(scheme)),
          const SizedBox(height: Space.x2),
          ..._qqBindBody(scheme, s),
          if (qqBindError != null) ...[
            const SizedBox(height: Space.x2),
            Text(
              qqBindError!,
              key: const ValueKey('onboarding-qq-bind-error'),
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.error),
            ),
          ],
        ],
      ),
    );
  }

  /// 按 [qqBindPhase] 摆这一屏的三态。
  ///
  /// 为什么是"每次 build 现算"而不是把整块塞进状态里：文案要跟着语言换（同一条状态，
  /// 切到英文后那几句也得是英文），把 Widget 存进状态就锁在切换语言那一刻了。
  List<Widget> _qqBindBody(ColorScheme scheme, AppStrings s) {
    switch (qqBindPhase) {
      case _QqBindPhase.idle:
        return [
          FilledButton.icon(
            key: const ValueKey('onboarding-qq-bind-start'),
            onPressed: busy ? null : () => unawaited(_startQqBind()),
            icon: const Icon(Icons.qr_code_2_rounded, size: 18),
            label: Text(s.onboardingQqBindStart),
          ),
        ];
      case _QqBindPhase.starting:
        return [_busyLine(scheme, s.onboardingQqBindStarting)];
      case _QqBindPhase.pending:
        return [
          _busyLine(scheme, s.onboardingQqBindWaitScan),
          const SizedBox(height: Space.x1),
          Text(s.onboardingQqBindWaiting, style: _asideStyle(scheme)),
          const SizedBox(height: Space.x1),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextButton(
                key: const ValueKey('onboarding-qq-bind-cancel'),
                onPressed: busy ? null : _cancelQqBind,
                child: Text(s.cancel),
              ),
              if (qqBindUrl != null)
                Expanded(
                  child: Padding(
                    // 浏览器打不开时这一行就是唯一的出路：地址要能选中、能复制
                    padding: const EdgeInsets.only(left: Space.x1, top: 10),
                    child: SelectableText(
                      qqBindUrl!,
                      maxLines: 2,
                      style: _asideStyle(scheme),
                    ),
                  ),
                ),
            ],
          ),
        ];
      case _QqBindPhase.success:
        return [
          Row(
            children: [
              Icon(Icons.check_circle_rounded, size: 18, color: IrmiaTheme.ok),
              const SizedBox(width: 6),
              Text(
                s.onboardingQqBindSuccess,
                key: const ValueKey('onboarding-qq-bind-success'),
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: IrmiaTheme.ok),
              ),
            ],
          ),
          if (qqBindAppId != null) ...[
            const SizedBox(height: Space.x1),
            SelectableText(
              s.onboardingQqBindAppId(qqBindAppId!),
              key: const ValueKey('onboarding-qq-bind-appid'),
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
          ],
          // 落盘成功才敢说"已保存并启用"：保存失败时下面那行红字才是实话，
          // 这两句不能同时挂着（一对互相矛盾的话比少一句更难查）。
          if (qqBindSaved && qqBindEnabled) ...[
            const SizedBox(height: Space.x1),
            Text(
              s.onboardingQqBindSavedNote,
              key: const ValueKey('onboarding-qq-bind-saved'),
              style: _asideStyle(scheme),
            ),
          ],
          // 连接测试是**独立的一行**（修正 4：绑定成功 ≠ 一定能连上）：
          // 凭据已存、但机器人可能没上线 / secret 被轮换过——那件事在这行说。
          if (qqBindConnectionOk != null) ...[
            const SizedBox(height: Space.x1),
            Text(
              qqBindConnectionOk!
                  ? s.onboardingQqBindTokenOk(qqBindExpiresIn ?? 0)
                  : s.onboardingQqBindTokenFailed(qqBindConnectionError ?? ''),
              key: const ValueKey('onboarding-qq-bind-connection'),
              style: TextStyle(
                fontSize: 12,
                height: 1.6,
                color: qqBindConnectionOk! ? IrmiaTheme.ok : scheme.error,
              ),
            ),
          ],
        ];
      case _QqBindPhase.expired:
        return [
          // 官方没有给二维码的明确有效期（只有"过期"这个状态 + 可以重建），
          // 所以**不做倒计时**：过期了就摆这一颗，重新要一个任务。
          OutlinedButton.icon(
            key: const ValueKey('onboarding-qq-bind-regenerate'),
            onPressed: busy ? null : () => unawaited(_startQqBind()),
            icon: const Icon(Icons.refresh_rounded, size: 18),
            label: Text(s.onboardingQqBindRegenerate),
          ),
        ];
    }
  }

  /// 「进行中」那一行：转圈 + 一句人话
  Widget _busyLine(ColorScheme scheme, String text) {
    return Row(
      children: [
        const SizedBox(
          width: 14,
          height: 14,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(text, style: TextStyle(fontSize: 13, height: 1.6, color: scheme.onSurface)),
        ),
      ],
    );
  }

  /// 扫码那一支的 2 秒轮询（可取消：见 pending 那一态的「取消」与 dispose）。
  void _stopQqBindPolling() {
    qqBindTimer?.cancel();
    qqBindTimer = null;
  }

  /// 点「扫码创建」/「二维码过期了，重新生成」：建任务 → **系统浏览器**打开 → 起轮询。
  ///
  /// 三条口径（与后端 `src/channel/qq-bind.ts` 同一个节奏）：
  ///   · 二维码由 q.qq.com 那个页面自己渲染（官方原文「请使用手机QQ扫码绑定」），
  ///     所以我们只把 URL 交给系统浏览器，**不需要二维码编码库**；
  ///   · 打开失败不静默：把地址原样显示出来（人手动打开也能扫）；
  ///   · 轮询 2 秒一次；成功/过期/取消都停表，离场（dispose）也停。
  Future<void> _startQqBind() async {
    final s = IrmiaStrings.read(context);
    _stopQqBindPolling();
    setState(() {
      qqBindPhase = _QqBindPhase.starting;
      qqBindError = null;
      qqBindUrl = null;
      qqBindAppId = null;
      qqBindSaved = false;
      qqBindEnabled = false;
      qqBindConnectionOk = null;
      qqBindExpiresIn = null;
      qqBindConnectionError = null;
    });
    try {
      final resp = await widget.state.api.post(
        '/api/channels/qq-official/bind/start',
        const <String, dynamic>{},
      );
      if (!mounted) return;
      final url = resp is Map ? resp['url'] : null;
      if (url is! String || url.trim().isEmpty) {
        // 开发者口径（只有日志/断言看得到），不是界面文案
        throw StateError('qq bind: start returned no url');
      }
      final opened = await openExternalUrl(url.trim());
      if (!mounted) return;
      setState(() {
        qqBindUrl = url.trim();
        qqBindPhase = _QqBindPhase.pending;
        qqBindError = opened ? null : s.onboardingOpenLinkFailed(url.trim());
      });
      qqBindTimer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => unawaited(_pollQqBind()),
      );
    } catch (err) {
      if (!mounted) return;
      setState(() {
        qqBindPhase = _QqBindPhase.idle;
        qqBindError = s.onboardingQqBindStartFailed('$err');
      });
    }
  }

  /// 查一次状态。**一次失败不结束这一轮**（后端会话有 3 分钟兜底，下一拍照旧）。
  Future<void> _pollQqBind() async {
    if (qqBindPolling || !mounted) return;
    qqBindPolling = true;
    final s = IrmiaStrings.read(context);
    try {
      final resp = await widget.state.api.get('/api/channels/qq-official/bind/status');
      if (!mounted) return;
      final map = resp is Map ? resp : const <Object?, Object?>{};
      final status = map['status'];
      if (status == 'success') {
        _stopQqBindPolling();
        final appId = map['appId'];
        final connection = map['connection'];
        final expires = connection is Map ? connection['expiresIn'] : null;
        final why = connection is Map ? connection['error'] : null;
        final saveError = map['error'];
        setState(() {
          qqBindPhase = _QqBindPhase.success;
          // 服务端在成功那一刻已经把它启用了：勾选框跟着说实话，别还显示没开
          qqOn = true;
          qqBindAppId = appId is String && appId.trim().isNotEmpty ? appId.trim() : null;
          qqBindSaved = map['saved'] == true;
          qqBindEnabled = map['enabled'] == true;
          qqBindConnectionOk = connection is Map ? connection['ok'] == true : null;
          qqBindExpiresIn = expires is num ? expires.toInt() : null;
          qqBindConnectionError = why is String && why.trim().isNotEmpty ? why.trim() : null;
          qqBindError = saveError is String && saveError.trim().isNotEmpty ? saveError.trim() : null;
        });
        return;
      }
      if (status == 'expired' || status == 'idle') {
        _stopQqBindPolling();
        setState(() => qqBindPhase = _QqBindPhase.expired);
        return;
      }
      // pending（或老服务端不认识的中间态）：继续等，把上一次的偶发错误收掉
      setState(() {
        qqBindPhase = _QqBindPhase.pending;
        qqBindError = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() => qqBindError = s.onboardingQqBindStatusFailed('$err'));
    } finally {
      qqBindPolling = false;
    }
  }

  /// 「取消」：只停界面的轮询（后端那一轮会话自己会在 3 分钟内结束或落盘）。
  void _cancelQqBind() {
    _stopQqBindPolling();
    setState(() {
      qqBindPhase = _QqBindPhase.idle;
      qqBindUrl = null;
      qqBindError = null;
    });
  }

  /// 「测试连接」：`POST /api/commands/qq-token-test` —— 用**框里刚敲的**那两把
  /// （没敲就用盘上那份）真去换一次 access_token。凭据写对了不等于连得上，所以要有这一下。
  Future<void> _testQqConnection() async {
    setState(() {
      qqTestRunning = true;
      qqTestOk = null;
      qqTestExpiresIn = null;
      qqTestError = null;
    });
    final body = <String, dynamic>{};
    final appId = appIdCtl.text.trim();
    final secret = appSecretCtl.text.trim();
    if (appId.isNotEmpty) body['appId'] = appId;
    if (secret.isNotEmpty) body['clientSecret'] = secret;
    try {
      final resp = await widget.state.api.post('/api/commands/qq-token-test', body);
      if (!mounted) return;
      final map = resp is Map ? resp : const <Object?, Object?>{};
      final expires = map['expiresIn'];
      final why = map['error'];
      setState(() {
        qqTestRunning = false;
        qqTestOk = map['ok'] == true;
        qqTestExpiresIn = expires is num ? expires.toInt() : null;
        qqTestError = why is String && why.trim().isNotEmpty ? why.trim() : null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        qqTestRunning = false;
        qqTestOk = false;
        // 只记原因原文：展示那一层会套 `onboardingQqBindTokenFailed` 的前缀，
        // 这里再套一次就成了"连接测试没通过：连接测试没通过：…"
        qqTestError = '$err';
      });
    }
  }

  /// 旁注那一档字（说明 12/18）。蓝链与它旁边的说明**同一个字号**，只有颜色与下划线不同。
  TextStyle _asideStyle(ColorScheme scheme) => Type.caption.style(color: scheme.onSurfaceVariant);

  /// 一段"说明 + 蓝链"的旁注（用户 ②③）：[parts] 里带 url 的那几段是蓝链。
  ///
  /// 为什么用 [Wrap] 而不是一行 [Row]：中英两种语言的句子长度不同，窄窗（或长翻译）时
  /// 整句排不进一行——Wrap 会自己折行，Row 只会溢出。
  ///
  /// [lineKey] 是给用例的一个抓手：一次调用 = **那一行**（第 2 步那两句推荐语合成一行之后，
  /// "只有一行"这件事只能靠"只有一个 Wrap"来钉，见 `test/onboarding_copy_one_line_test.dart`）。
  Widget _recommendLine(
    ColorScheme scheme,
    List<({String text, String? url, String? keyName})> parts, {
    Key? lineKey,
  }) {
    return Wrap(
      key: lineKey,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (final part in parts)
          part.url == null
              ? Text(part.text, style: _asideStyle(scheme))
              : _inlineLink(scheme, label: part.text, url: part.url!, keyName: part.keyName!),
      ],
    );
  }

  /// 内联蓝链：一段说明里那截可以点的字。
  ///
  /// 为什么不是 TextButton：按钮自带 labelLarge 的字号与最小触控尺寸，塞进 12px 的旁注里
  /// 会把这一行撑高一档；而 `button_typography_test` 又不许页面里写 `textStyle:`
  /// （按钮会丢字体栈）。所以链接就是一个 InkWell + Text：字号行高取 [Type.caption]，
  /// 颜色取主题主色——**不写魔法数字**，也不必给按钮另造一套文字样式。
  Widget _inlineLink(
    ColorScheme scheme, {
    required String label,
    required String url,
    required String keyName,
  }) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: InkWell(
        key: ValueKey(keyName),
        borderRadius: Shape.control,
        onTap: busy ? null : () => unawaited(_openLink(url)),
        child: Text(
          label,
          style: _asideStyle(scheme).copyWith(
            color: scheme.primary,
            decoration: TextDecoration.underline,
            decorationColor: scheme.primary,
          ),
        ),
      ),
    );
  }

  /// 点蓝链：交给系统默认浏览器（全仓唯一那条实现在 `external_link.dart`）。
  /// 打不开就**把地址说出来**——那是唯一不靠外部程序也能让人拿到它的方式。
  Future<void> _openLink(String url) async {
    final opened = await openExternalUrl(url);
    if (!mounted || opened) return;
    IrmiaToast.show(
      context,
      IrmiaStrings.read(context).onboardingOpenLinkFailed(url),
      kind: ToastKind.warn,
    );
  }

  /// 第 3 步 QQ 官方 Bot 的两把凭据（AppID / AppSecret）。
  ///
  /// 三件与设置页「消息适配器」**同一套**的事：
  ///   · 落盘走同一条 `POST /api/commands/set-key`，键名取自 `channel_keys.dart`
  ///     （见 [_settleChannel]）——不新开写入路径；
  ///   · 输入框 `obscureText`（密钥掩码）；**已配置的不回显**，只把服务端给的掩码摆在占位提示里；
  ///   · 已配置时套 `secretLook`（蓝边 + 居中），与第 2 步的 API Key 那格长得一样。
  Widget _qqCredentialFields(ColorScheme scheme, AppStrings s) {
    return Padding(
      padding: const EdgeInsets.only(top: Space.x2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.onboardingQqCredentialsTitle, style: _asideStyle(scheme)),
          const SizedBox(height: Space.x2),
          Text(s.onboardingQqAppIdLabel, style: _asideStyle(scheme)),
          const SizedBox(height: Space.x1),
          _secretField(
            controller: appIdCtl,
            fieldKey: 'onboarding-qq-appid',
            state: widget.signals.qqAppId,
            hint: s.onboardingQqAppIdHint,
            s: s,
          ),
          const SizedBox(height: Space.x3),
          Text(s.onboardingQqAppSecretLabel, style: _asideStyle(scheme)),
          const SizedBox(height: Space.x1),
          _secretField(
            controller: appSecretCtl,
            fieldKey: 'onboarding-qq-appsecret',
            state: widget.signals.qqClientSecret,
            hint: s.onboardingQqAppSecretHint,
            s: s,
          ),
          const SizedBox(height: Space.x1),
          Text(s.onboardingQqCredentialsNote, style: _asideStyle(scheme)),
          const SizedBox(height: Space.x2),
          // 「测试连接」：真去换一次 access_token（`qq-token-test`）。凭据写对了不等于连得上，
          // 这条消息与扫码成功后自动跑的那一次是**同一个端点、同一份判定**。
          Row(
            children: [
              OutlinedButton(
                key: const ValueKey('onboarding-qq-token-test'),
                onPressed: busy || qqTestRunning ? null : () => unawaited(_testQqConnection()),
                child: Text(
                  qqTestRunning ? s.onboardingQqBindTokenTesting : s.onboardingQqBindTestConnection,
                ),
              ),
            ],
          ),
          if (qqTestOk != null) ...[
            const SizedBox(height: Space.x1),
            Text(
              qqTestOk!
                  ? s.onboardingQqBindTokenOk(qqTestExpiresIn ?? 0)
                  : s.onboardingQqBindTokenFailed(qqTestError ?? ''),
              key: const ValueKey('onboarding-qq-token-result'),
              style: TextStyle(
                fontSize: 12,
                height: 1.6,
                color: qqTestOk! ? IrmiaTheme.ok : scheme.error,
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// 一格「只写不读」的密钥：与设置页渠道卡里那两格同一个规格（掩码、不回显、secretLook）。
  Widget _secretField({
    required TextEditingController controller,
    required String fieldKey,
    required SecretState state,
    required String hint,
    required AppStrings s,
  }) {
    final look = secretLook(
      context,
      configured: state.configured,
      hintFontSize: 13,
      base: InputDecoration(
        hintText: state.configured ? s.onboardingSecretConfigured(state.mask) : hint,
      ),
    );
    return TextField(
      key: ValueKey(fieldKey),
      controller: controller,
      obscureText: true,
      autocorrect: false,
      enableSuggestions: false,
      style: const TextStyle(fontSize: 13),
      textAlign: look.textAlign,
      onChanged: (_) => setState(() {
        problem = null;
        _syncQqFromCredentials();
      }),
      decoration: look.decoration,
    );
  }

  Widget _channelTile(
    ColorScheme scheme, {
    required String label,
    required String detail,
    required bool value,
    required bool wasOn,
    required ValueChanged<bool> onChanged,
  }) {
    return Container(
      padding: const EdgeInsets.fromLTRB(10, 10, 12, 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: value ? scheme.primary.withValues(alpha: 0.45) : scheme.outlineVariant),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Checkbox(
            value: value || wasOn,
            // 现成就开着的那条只读：这一屏的语义是"启用哪个入站通道"，不是"顺手关掉一个"
            onChanged: wasOn ? null : (next) => onChanged(next ?? false),
            visualDensity: VisualDensity.compact,
            materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurface)),
                const SizedBox(height: 3),
                Text(detail, style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          if (wasOn)
            Padding(
              padding: const EdgeInsets.only(left: 8, top: 2),
              child: Text('现在开着', style: TextStyle(fontSize: 11, color: scheme.primary)),
            ),
        ],
      ),
    );
  }

  Widget _personaStep(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: 148,
          child: TextField(
            controller: personaCtl,
            maxLines: null,
            expands: true,
            textAlignVertical: TextAlignVertical.top,
            keyboardType: TextInputType.multiline,
            style: TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.7, color: scheme.onSurface),
            onChanged: (_) => setState(() => problem = null),
            decoration: const InputDecoration(
              hintText: '# 我是谁\n\n（名字、身份、核心性格。500 token 以内）',
            ),
          ),
        ),
        // 用户 ⑤（2026-10-18）：原来这里是一大段散文（"这段文字就是 … 的全部内容…"），
        // 压成三句、只留四条关键信息：整份替换 / 服务端留快照可回滚 / 留空或没改就不写 /
        // 第一步那个名字行别删。字数由 `onboarding_copy_test.dart` 钉着上界。
        _note(s.onboardingPersonaHint, scheme),
      ],
    );
  }

  /// 第五步：信任范围（`trust.mode`）——**二选一，默认高亮「完全信任」**。
  ///
  /// 两条纪律（用户的原话）：
  ///   · **默认档必须与配置默认值同一个字面量**：这里用的是 [defaultTrustMode]（`'full'`），
  ///     两侧共用同一个常量，不许出现"引导页默认 A、配置默认 B"；
  ///   · **两种选择各一句后果说明**：文案取自 [trustModeConsequence]（与设置页同一份），
  ///     不在这一页另写一遍——两处措辞一分叉，人就判断不了自己选了什么。
  ///
  /// 控件也复用设置页那一枚（[TrustModeChoice]），所以两处的形状、高亮口径、点击手感
  /// 是同一套东西。这里多点一层"改哪一档就按哪一档的后果算"的旁注，是因为这一屏的人
  /// 大多第一次见这个概念：他只看到两个选项，得知道选了之后**谁来执行**这条边界。
  Widget _trustStep(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    final root = widget.signals.trustRoot;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TrustModeChoice(
          mode: kTrustFull,
          selected: trustMode == kTrustFull,
          consequence: trustModeConsequence(s, kTrustFull, root),
          enabled: !busy,
          onPick: (picked) => setState(() {
            trustMode = picked;
            problem = null;
          }),
        ),
        const SizedBox(height: 8),
        TrustModeChoice(
          mode: kTrustWorkspace,
          selected: trustMode == kTrustWorkspace,
          consequence: trustModeConsequence(s, kTrustWorkspace, root),
          enabled: !busy,
          onPick: (picked) => setState(() {
            trustMode = picked;
            problem = null;
          }),
        ),
        // 第 3 轮（2026-10-20 用户 ④）：这段压成**一行**。原来它是
        // "这是边界，不是提醒：…（fs 工具族与 pwsh 都管）。" + 分叉句 + "之后在设置页…"三截拼的，
        // 读起来三句。现在两档各一整句（进文案表，中英各一条），拼的动作没有了：
        // 分叉那半句本来就得跟着盘上那份走，但"哪一档"这件事只剩一个三元。
        _note(
          trustMode == widget.signals.trustMode
              ? s.onboardingTrustNoteSame
              : s.onboardingTrustNoteChanged,
          scheme,
        ),
      ],
    );
  }

  // ── 第六步：外部依赖（2026-10-20 用户第 3 轮 ⑤） ──

  /// 这一屏一进来就把 `/api/deps` 读一次。
  ///
  /// 为什么放在"进这一屏"而不是"开卡"：前五步与依赖无关，开卡就去探测四件依赖只是白等
  /// （设置页那张卡也是"不阻塞首屏"的同一条理由）。也不能直接在 build 里发：
  /// build 期间 `setState` 会炸，所以挪到本帧之后。
  void _ensureDepsLoaded() {
    if (depsRequested) return;
    depsRequested = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final pending = _loadDeps();
      depsPending = pending;
      unawaited(pending);
    });
  }

  /// 读四件依赖的现状：`GET /api/deps`（**只读**，一个写请求都不发）。
  ///
  /// 形状照服务端（`src/web/server.ts` 的 `depsView`）：`{available, entries:[{name,status,…}]}`。
  /// 三条兜底：`available:false` ⇒ 这台服务端没装依赖管理器（不摆勾选框）；
  /// 读失败 / 形状不对 ⇒ [depsError]（不猜"都没装"，那会让人白装四件）。
  Future<void> _loadDeps() async {
    if (!mounted) return;
    setState(() {
      depsLoading = true;
      depsError = null;
    });
    try {
      final data = await widget.state.api.get('/api/deps');
      if (!mounted) return;
      final map = data is Map ? data.cast<String, dynamic>() : null;
      final unavailable = map != null && map['available'] == false;
      final rawList = map == null ? null : map['entries'];
      setState(() {
        depsUnavailable = unavailable;
        depsLoading = false;
        if (unavailable) {
          deps = const <OnboardingDep>[];
          depsError = null;
          return;
        }
        if (rawList is! List) {
          // 响应形状不对：不猜"四件都没装"（那会让人白装一遍），如实说读不到
          deps = const <OnboardingDep>[];
          depsError = 'entries';
          return;
        }
        final byName = <String, Object?>{};
        for (final raw in rawList) {
          if (raw is Map) byName[raw['name']?.toString() ?? ''] = raw;
        }
        // 四件里**少了一件**也当读不到：缺的那件到底是没装还是接口没说，这一屏分不出来，
        // 而"猜它没装"的代价是让人白装一遍（真装上之后复检也过不了）
        if (kOnboardingDepNames.any((name) => !byName.containsKey(name))) {
          deps = const <OnboardingDep>[];
          depsError = 'entries';
          return;
        }
        deps = [
          for (final name in kOnboardingDepNames) OnboardingDep.from(name, byName[name]),
        ];
        depsError = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        depsError = '$err';
        depsLoading = false;
      });
    }
  }

  /// 第 6 步的正文：说明 + 四件的现状 + 勾选框（或"都已就位"）+ 这一轮的结局。
  ///
  /// 说明那一句（不装会怎样、点名四件）在步骤文案里（[AppStrings.onboardingStepDepsNote]），
  /// 与另外五步同一个位置——不在这一屏另起一套版式。
  Widget _depsStep(ColorScheme scheme) {
    final s = IrmiaStrings.of(context);
    _ensureDepsLoaded();
    final missing = deps.where((dep) => !dep.ready).length;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (depsLoading && deps.isEmpty)
          Row(
            children: [
              const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
              const SizedBox(width: Space.x2),
              Text(s.onboardingDepsItemRunning, style: _asideStyle(scheme)),
            ],
          )
        else if (depsUnavailable)
          _note(s.onboardingDepsUnavailable, scheme)
        else if (depsError != null)
          _note(s.onboardingDepsReadFailed(depsError!), scheme)
        else ...[
          for (final dep in deps) _depRow(dep, s, scheme),
          const SizedBox(height: Space.x2),
          // 四件都已就位时不摆勾选框：没什么可装的，摆一个按不动的勾选框只会让人以为还得点它
          if (missing == 0) _note(s.onboardingDepsAllReady, scheme) else _depsCheckbox(s, scheme),
        ],
        if (depsRoundDone || depsLastAttempt != null) _depsOutcome(s, scheme),
      ],
    );
  }

  /// 一件依赖那一行：名字 · 现状（就位 / 未就位）· 这一轮的进度或结局。
  ///
  /// 现状与结局**分两行**（同一个 `Column` 里两个 `Text`）：现状是"盘上现在是什么"，
  /// 结局是"这一趟干了什么"——两者可以同时存在（刚装成的那一件：就位 + 成功）。
  Widget _depRow(OnboardingDep dep, AppStrings s, ColorScheme scheme) {
    final result = depsResults[dep.name];
    final running = depsRunning == dep.name;
    return Padding(
      key: ValueKey('onboarding-dep-${dep.name}'),
      padding: const EdgeInsets.only(bottom: Space.x2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 58,
            child: Text(
              dep.name,
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurface),
            ),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  dep.ready ? s.onboardingDepsStatusReady : s.onboardingDepsStatusMissing,
                  style: TextStyle(
                    fontSize: 12,
                    color: dep.ready ? IrmiaTheme.ok : IrmiaTheme.warn,
                  ),
                ),
                if (running || result != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      running
                          ? s.onboardingDepsItemRunning
                          : (result!.ok
                              ? s.onboardingDepsItemOk
                              : s.onboardingDepsItemFailed(result.reason)),
                      key: ValueKey('onboarding-dep-result-${dep.name}'),
                      style: TextStyle(
                        fontSize: 11.5,
                        height: 1.6,
                        color: running
                            ? scheme.onSurfaceVariant
                            : (result!.ok ? IrmiaTheme.ok : IrmiaTheme.danger),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 那个勾选框：下载并安装这些外部依赖（默认勾上）。
  ///
  /// 勾不勾是一个**人的决定**，所以 `depsCheckTouched` 记着它：卡片开的时候读回来的
  /// "上次没勾"不许盖掉这一次的点击（读盘是异步的，两个动作会撞在同一帧附近）。
  Widget _depsCheckbox(AppStrings s, ColorScheme scheme) {
    return InkWell(
      borderRadius: Shape.control,
      onTap: busy ? null : () => _toggleDepsInstall(!depsInstallChecked),
      child: Padding(
        padding: const EdgeInsets.only(top: Space.x2),
        child: Row(
          children: [
            Checkbox(
              key: const ValueKey('onboarding-deps-install'),
              value: depsInstallChecked,
              onChanged: busy ? null : (next) => _toggleDepsInstall(next ?? false),
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            const SizedBox(width: Space.x2),
            Expanded(
              child: Text(
                s.onboardingDepsInstallLabel,
                style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _toggleDepsInstall(bool next) {
    depsCheckTouched = true;
    setState(() {
      depsInstallChecked = next;
      problem = null;
    });
  }

  /// 这一轮的结局：装完的汇总（成功 N / 失败 M）+ 失败时的「重试」，
  /// 或者（还没装过时）上次装完的那份记录——**复查**就靠这一行。
  Widget _depsOutcome(AppStrings s, ColorScheme scheme) {
    if (depsRoundDone) {
      final ok = depsResults.values.where((entry) => entry.ok).length;
      final failed = depsResults.values.where((entry) => !entry.ok).length;
      return Padding(
        padding: const EdgeInsets.only(top: Space.x2),
        child: Wrap(
          spacing: Space.x2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Text(
              s.onboardingDepsSummary(ok, failed),
              key: const ValueKey('onboarding-deps-summary'),
              style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
            ),
            if (failed > 0)
              TextButton(
                key: const ValueKey('onboarding-deps-retry'),
                onPressed: busy ? null : () => unawaited(_retryDeps()),
                child: Text(s.onboardingDepsRetry),
              ),
          ],
        ),
      );
    }
    final attempt = depsLastAttempt;
    // 0 成功 0 失败那条只说明"上次没勾"，没有结局可复查——不摆一行 0/0
    if (attempt == null || !attempt.hasResult) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: Space.x2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.onboardingDepsLastRun(attempt.ok, attempt.failed),
            key: const ValueKey('onboarding-deps-last'),
            style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant),
          ),
          // 失败的那几件逐条点名：只说"上次失败 2 件"等于什么都没说
          for (final entry in attempt.failures.entries)
            Padding(
              padding: const EdgeInsets.only(top: Space.x1),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 58,
                    child: Text(
                      entry.key,
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: scheme.onSurface),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      s.onboardingDepsItemFailed(entry.value),
                      style: TextStyle(fontSize: 11.5, height: 1.6, color: IrmiaTheme.danger),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  /// 汇总行旁边那颗「重试」：只重试**还没就位 / 上次没装成**的那几件（同一条 [_runDepsRound]）。
  ///
  /// 与「完成」的区别只在收尾：重试成功之后卡片**不关**（人按的是重试，不是完成），
  /// 汇总行会变成"成功 N / 失败 0"，他再按一次「完成」即可。
  Future<void> _retryDeps() async {
    if (busy) return;
    setState(() {
      busy = true;
      problem = null;
      depsRoundDone = false;
    });
    await _runDepsRound();
    if (!mounted) return;
    setState(() => busy = false);
  }

  /// 第 6 步的**结算**：勾了就逐件装（串行），装完弹那个顶层窗口。
  ///
  /// 返回 true = 这一屏可以关了；false = 留在这一屏（有失败：汇总与「重试」就在这一屏上）。
  ///
  /// 五条纪律（用户第 3 轮 ⑤ 的原话，逐条落在下面）：
  ///   ① **未勾选 ⇒ 零请求**：`depsInstallChecked` 为假时一个 `dep-install` 都不发；
  ///   ② **只调既有的那条命令**：`POST /api/commands/dep-install` + `X-Confirm: dep-install`，
  ///      与设置页 `_installDep` 同一套（这里不新写任何安装逻辑，下载/解压/复检都在服务端）；
  ///   ③ **已就位的跳过**：[missing] 只装没就位的那几件；
  ///   ④ **串行**、每件给进度（进行中 / 成功 / 失败+原因），**一件失败不中断其余**：
  ///      循环里没有 `return`，失败只往 [depsResults] 记一笔；
  ///   ⑤ **装完才要重启**：至少一件装成了就弹那个顶层窗口——一件都没装上时没有"生效"可言。
  Future<bool> _runDepsRound() async {
    // ① 先等这一屏那份现状（人可能一点进来就点「完成」）
    final pending = depsPending;
    if (pending != null) {
      try {
        await pending;
      } catch (_) {
        // 读失败的原因已经摆在 depsError 上，这里不必再说一遍
      }
      if (!mounted) return false;
    }
    // 读不到 / 服务端没装依赖管理器 / 四件都已就位 / 人没勾 ⇒ 一个请求都不发
    if (depsUnavailable || depsError != null || deps.isEmpty) return true;
    final missing = [for (final dep in deps) if (!dep.ready) dep.name];
    if (missing.isEmpty) return true;
    if (!depsInstallChecked) {
      // 人明确没勾：一个请求都不发，但这个**决定**要留下来——
      // 下次打开这一屏时"上次没勾"要看得见（复查的另一半，见 [DepsAttempt]）
      final declined = const DepsAttempt(checked: false, ok: 0, failed: 0);
      depsLastAttempt = declined;
      await saveDepsAttempt(declined);
      return true;
    }

    setState(() {
      depsResults.clear();
      depsRoundDone = false;
      depsRunning = null;
      problem = null;
    });

    var ok = 0;
    final failures = <String, String>{};
    for (final name in missing) {
      if (!mounted) return false;
      setState(() => depsRunning = name);
      try {
        final data = await widget.state.api.post(
          '/api/commands/dep-install',
          {'name': name},
          confirm: 'dep-install',
        );
        if (!mounted) return false;
        final map = data is Map ? data.cast<String, dynamic>() : const <String, dynamic>{};
        if (map['ok'] == true) {
          ok += 1;
          setState(() {
            depsResults[name] = (ok: true, reason: '');
            // 服务端装完**就地复检**过（`src/web/server.ts` 的 dep-install 那一段）：
            // 这一件现在真的能跑了，界面上的现状跟着点亮
            deps = [for (final dep in deps) dep.name == name ? dep.asReady() : dep];
          });
        } else {
          final reason = _depInstallReason(map);
          failures[name] = reason;
          setState(() => depsResults[name] = (ok: false, reason: reason));
        }
      } catch (err) {
        // 请求本身没出去（网络断了 / 501 / 400）：同样是"这一件没装成"，其余照旧往下走
        failures[name] = '$err';
        if (mounted) setState(() => depsResults[name] = (ok: false, reason: '$err'));
      }
    }
    if (!mounted) return false;
    if (ok > 0) wrote = true;
    setState(() {
      depsRunning = null;
      depsRoundDone = true;
    });
    // 落盘：这一页下次打开时要能复查"上次装完 / 失败"（含勾没勾）
    depsLastAttempt = DepsAttempt(
      checked: depsInstallChecked,
      ok: ok,
      failed: failures.length,
      failures: failures,
    );
    await saveDepsAttempt(depsLastAttempt!);
    if (!mounted) return false;
    if (ok == 0) return failures.isEmpty;
    final restart = await _showDepsRestartDialog();
    if (!mounted) return false;
    if (restart) await _restartNow();
    if (!mounted) return false;
    return failures.isEmpty;
  }

  /// 一件依赖没装成时那句原因。
  ///
  /// 服务端的 `error` 本身就是给人读的（三种失败各带一句下一步，见 `src/deps/manager.ts`），
  /// 所以原样摆出来；它没给就退回 `step`（阶段名）——宁可只有一格阶段名，也不要凭空编一句话。
  String _depInstallReason(Map<String, dynamic> map) {
    final error = map['error']?.toString().trim() ?? '';
    if (error.isNotEmpty) return error;
    final step = map['step']?.toString().trim() ?? '';
    return step.isEmpty ? 'ok:false' : step;
  }

  /// 装完那个**顶层窗口**（用户 ⑤ 的 ★）：标题 + 一句原因 + 两个按钮。
  ///
  /// 它压在引导卡之上（`showDialog` 走根 Navigator），所以是"顶层窗口"而不是卡里的一行字：
  /// 装完依赖这件事必须被看见，而"要不要现在重启"是它唯一的决定。
  /// 点遮罩不关（`barrierDismissible: false`）：这里没有"误触关掉"这个选项，只有「立即重启」与「稍后」。
  ///
  /// 返回 true = 人点了「立即重启」。
  Future<bool> _showDepsRestartDialog() async {
    final s = IrmiaStrings.read(context);
    final picked = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: Text(s.onboardingRestartTitle),
        content: Text(s.onboardingRestartBody),
        actions: [
          TextButton(
            key: const ValueKey('onboarding-restart-later'),
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(s.onboardingRestartLater),
          ),
          FilledButton(
            key: const ValueKey('onboarding-restart-now'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(s.onboardingRestartNow),
          ),
        ],
      ),
    );
    return picked == true;
  }

  /// 「立即重启」：**不新写重启逻辑**——交给 `restart_action.dart` 的 [performRestart]
  /// （首页那颗「重启前后端」与托盘那个菜单项走的是同一个函数：同端点、同确认短语、
  /// 同一套"三态只认链条自己的话"的判据，连"等它回来"也是同一段）。
  Future<void> _restartNow() async {
    final strings = IrmiaStrings.read(context);
    final state = widget.state;
    await performRestart(
      api: state.api,
      strings: strings,
      say: (message, kind) {
        // 卡片可能已经被重启链条关掉：那时这句话没地方落，说出来只是在日志里制造噪音
        if (!mounted) return;
        IrmiaToast.show(context, message, kind: kind);
      },
      online: () => state.online,
      alive: () => mounted,
    );
  }

  // ── 结算 ──

  /// 把第 [i] 步结算掉（没写过就跳过）并记下；返回失败原因（null = 成了）
  Future<String?> _settleOnce(int i) async {
    if (settled.contains(i)) return null;
    requirement = null;
    final err = await _settle(i);
    if (err == null) settled.add(i);
    return err;
  }

  /// 往前走**一步**：把**当前这一步**结算掉再过去。
  ///
  /// 为什么只结算当前这步：往后那几步人**还没开始填**（第 2 步的密钥、第 4 步的人格都在后面），
  /// 顺手一起结算只会撞上"还没填"的拦阻——那正是"往前走一步"该走成的动作。
  /// 一路走到底时每步各结算各的；中途关卡的场合由 [_finish] 把剩下的补齐。
  Future<void> _next() async {
    if (busy || step >= _stepKeys.length - 1) return;
    setState(() {
      busy = true;
      problem = null;
      requirement = null;
    });
    final err = await _settleOnce(step);
    if (!mounted) return;
    if (err != null) {
      setState(() {
        problem = err;
        busy = false;
      });
      return;
    }
    setState(() {
      navigated = true;
      step += 1;
      busy = false;
    });
  }

  /// 往后退**一步**：只回退，不结算。
  ///
  /// 退回去的那一步会从 [settled] 里放出来（连同它后面已经走过的几步），于是人改完再往前走时
  /// 会重新结算一次——"点过跳过、后来又想填"是完全正常的顺序，不该因为先跳过就再也写不进去。
  ///
  /// 为什么是"一步"而不是"跳到第 N 步"：后者要顺带结算中间每一步，于是点一次「上一步」
  /// 可能往回跳好几步——实测踩到过，那种"点一下退两步"的界面最像坏了。
  Future<void> _back() async {
    if (busy || step == 0) return;
    settled.removeWhere((index) => index >= step - 1);
    setState(() {
      navigated = true;
      problem = null;
      step -= 1;
    });
  }

  /// 跳到已经走过的那一步（步骤条上的圆点）：**只能往回**，且同样一步一脚印地退。
  ///
  /// 为什么不做"点第 4 步就跳到第 4 步"：那等于替人跳过中间两步（跳过 = 一个字节都不写，
  /// 与他自己按「跳过这一步」是两件事）；这里退一步，他再点一次就再退一步，明明白白。
  ///
  /// [index] 只用来判"是不是往回"——具体退到第几步由 [_back] 说了算（一步），
  /// 两处各退各的迟早会分叉。
  Future<void> _stepBack(int index) async {
    if (busy || index >= step) return;
    await _back();
  }

  /// 跳过这一步：这一步**一个字节都不写**，只是不再问它（退回来再填照样能写进去）
  Future<void> _skipStep() async {
    if (busy) return;
    if (step == _stepKeys.length - 1) {
      await _finish();
      return;
    }
    setState(() {
      navigated = true;
      problem = null;
      requirement = null;
      step += 1;
    });
  }

  /// 完成 / 关闭 / 以后再说：把**还没结算的那几步**补上，再退出。
  ///
  /// 补的是哪几步：人可能在第 1 步填完称呼就一路按「以后再说」，也可能退回去改过模型又直接关掉
  /// ——凡是这一趟填过、却还没落盘的东西，都在这里补写（每步自己判"改了没有"，重复走不会重复写）。
  ///
  /// 两类"没成"在这里是**两件事**：
  ///   · [_problem]（写失败：网络断了、服务端拒了）——**把人留住**并说清原因，退出去就是静默丢；
  ///   · [_requirement]（这一屏还没填：比如没填密钥）——**照旧退出**，只在卡上报一句。
  ///     人这次就是不想填，退出时被自己的提示挡住是最没道理的一种拦阻。
  ///
  /// 「以后再说」与关闭的区别只在措辞：两者都写 `onboarding-done`（不再自动弹），
  /// 但已经填好的那几步照样落盘——人填了东西却因为"没点完成"而丢掉，最没道理。
  ///
  /// **第 6 步（外部依赖）走的是另一个口子**（[install]）：只有卡脚那颗主按钮按到它
  /// （「完成」，last 那一步）才**真的开始装**。关闭 / 以后再说 / 跳过这一步一律不装
  /// ——"我只是打开看了看"不该往数据目录里落四个可执行文件（那正是零请求那条用例钉着的）。
  Future<void> _finish({bool install = false}) async {
    if (busy) return;
    setState(() {
      busy = true;
      problem = null;
      requirement = null;
    });
    // 前五步照旧：一步一步补写，写失败就停在那一屏并说清原因
    for (var i = 0; i < _stepKeys.length - 1; i++) {
      final err = await _settleOnce(i);
      if (err != null) {
        if (!mounted) return;
        setState(() {
          step = i;
          problem = err;
          busy = false;
        });
        return;
      }
    }
    if (!mounted) return;
    // 第 6 步：勾了、且真有没就位的那几件，才逐件装（串行）。
    // 「有失败」在这里**不是** problem（那会把人锁在卡里）：装东西失败不丢任何数据，
    // 人完全可以关掉以后再来——所以汇总与「重试」摆在那一屏上，卡片照旧能关。
    if (install) {
      final done = await _runDepsRound();
      if (!mounted) return;
      if (!done) {
        setState(() {
          step = _stepKeys.length - 1;
          busy = false;
        });
        return;
      }
    }
    if (!mounted) return;
    Navigator.of(context).pop(wrote);
  }

  /// 结算第 [i] 步：返回 null = 成了（或本来就没东西可写），返回文字 = 失败原因。
  ///
  /// "还缺一样东西"（[requirement]）不算失败：它把话摆在卡上，但**不**拦住这一次动作
  /// ——人按「继续」时看到"缺密钥"就说明白了（这一步没写成），按关闭/以后再说则直接退出。
  Future<String?> _settle(int index) async {
    switch (_stepKeys[index]) {
      case 'name':
        return _settleName();
      case 'api':
        return _settleApi();
      case 'channel':
        return _settleChannel();
      case 'persona':
        return _settlePersona();
      case 'trust':
        return _settleTrust();
      default:
        // 第 6 步不在结算链上：它会装东西、要弹重启窗口、失败了还要能重试，
        // 那条路是 [_runDepsRound]（见 [_stepKeys] 的说明）
        return null;
    }
  }

  /// 第一步 → 两条通道，各写各的：
  ///   · 名字 → `POST /api/commands/persona-edit`（{file:'IDENTITY.md', content: 正文 + 名字行}）
  ///   · 词表 → `POST /api/commands/set-mention-keywords`（{keywords: [...]}）
  ///
  /// 顺序是刻意的：先写人格身份（"她是谁"），再写唤醒判据（"机器怎么认出在叫她"）。
  /// 前一步失败就停在原地报原因，不往下写——人看到的现状与盘上的一致，重试一次即可。
  Future<String?> _settleName() async {
    final name = sanitizeHerNameInput(nameCtl.text);
    if (name.runes.length > kHerNameMaxChars) {
      return '名字最多 $kHerNameMaxChars 个字，未保存';
    }
    final keywords = splitMentionKeywords(keywordsCtl.text);

    // ── ① 名字 → 人格资产 ──
    if (name.isNotEmpty && name != widget.signals.herName) {
      final base = widget.signals.identityContent;
      // **底稿必须是真的正文**：读不到就只能不写。拿一份空串当底稿，等于用"名字：小七"
      // 一行覆盖掉她整个人格——这是这一步唯一会造成实质破坏的可能，所以宁可报错。
      if (base == null) {
        return '读不到 persona/IDENTITY.md 的现正文，名字没写（去人格配置页改「名字：」那一行）';
      }
      final next = upsertHerNameLine(base, name);
      try {
        await widget.state.api
            .post('/api/commands/persona-edit', {'file': kIdentityFile, 'content': next});
      } catch (err) {
        return '名字没写进去：$err';
      }
      wrote = true;
      // 第四步那个框跟着走：不这么做，人接着往下走、在第四步写一份正文，就把刚填的名字冲掉了
      // （他手上那份稿子也补上同一行——他要是已经改过稿，改过的那份不能被我们丢掉）
      personaCtl.text = upsertHerNameLine(personaCtl.text, name);
      personaBase = next;
      // 界面上的称呼（窗口标题 / 侧栏 / 托盘）立刻跟手：重读一遍盘上那份，而不是把输入当结论
      await widget.state.refreshHerName();
    }

    // ── ② 唤醒词 → 通道配置（机器配置；从名字派生的第一份默认值） ──
    if (keywords.join('、') != widget.signals.mentionKeywords.join('、')) {
      try {
        await widget.state.api.post('/api/commands/set-mention-keywords', {'keywords': keywords});
      } catch (err) {
        return '唤醒词没写进去：$err';
      }
      wrote = true;
    }
    return null;
  }

  /// 第二步 → 模型与端点走 `config-update`（短语 config-update），密钥走 `set-key`（短语 set-key）
  ///
  /// **密钥这一步要一次写到每一档**（2026-10-20，用户实测的挫败点）：
  /// 从前这里发的是 `{'name': 'heavy'}`，于是 `.keys.json` 只多了 `heavy` 一格，而设置页的
  /// light 那张卡（按格读）写着「未配置」——人明明填了 key，却被告知另一半没配。
  /// 现在带 `modelRoutes: true`：服务端按**当前配置里存在的模型路由**一次落多格（默认的
  /// heavy / light 共用同一个 `apiKeyEnv`，所以是一把 key、一次原子写、两格都拿到），
  /// 回执里的 `gates` 就是"写到了哪几格"，界面照它说话、不自己猜。
  Future<String?> _settleApi() async {
    final s = IrmiaStrings.read(context);
    final model = modelCtl.text.trim();
    final baseUrl = baseCtl.text.trim();
    final key = keyCtl.text.trim();
    final fields = <String, dynamic>{};

    if (_apiDirty) {
      // 两格是一个整体：只改一半的配置写下去，下一次启动就是连不上的那一半。
      //
      // **不写 `models.heavy.protocol`**（2026-10-26）：这一屏已经不问协议了，
      // 点「继续」只落 model 与 baseUrl；盘上那份协议原样不动（设置页写的那一档不被界面覆盖）。
      if (model.isEmpty) return s.onboardingModelRequired;
      if (baseUrl.isEmpty) return s.onboardingBaseUrlRequired;
      fields['models.heavy.model'] = model;
      fields['models.heavy.baseUrl'] = baseUrl;
    }
    // 第一次启动的人最可能什么都不改就点继续（默认值本来就是 DeepSeek 那两个），
    // 所以这一屏**不拦**"没填模型"——真正拦人的是密钥那一条：没有它她连不上任何模型。
    //
    // 注意它走的是 requirement 而不是 problem：这是"还没填"，不是"写失败"——人按关闭 /
    // 以后再说时不该被它挡住（见 _finish）。写失败由下面的 catch 报成 problem。
    //
    // 两种"还没配齐"分开说（2026-10-20）：一格都没有 ⇒ 「还没填 API Key」；只有几格有
    // （老用户只配过 heavy 的现场）⇒ 说清是哪几格、再填一次会写到哪几格。
    final missingGates =
        widget.signals.apiKeyGates.where((gate) => !keyGatesHolding.contains(gate)).toList();
    if (key.isEmpty && keyGatesHolding.isEmpty) {
      requirement = keysRequiredNote;
    } else if (key.isEmpty && missingGates.isNotEmpty) {
      requirement = s.onboardingApiKeyHintPartial(
        _gatesLabel(widget.signals.apiKeyGates.where(keyGatesHolding.contains).toList()),
        _gatesLabel(missingGates),
      );
    }
    if (fields.isEmpty && !_keyDirty) return null;

    try {
      if (fields.isNotEmpty) {
        await widget.state.api
            .post('/api/commands/config-update', {'fields': fields}, confirm: 'config-update');
      }
    } catch (err) {
      return 'API 配置没写进去：$err';
    }
    if (key.isNotEmpty) {
      final gates = widget.signals.apiKeyGates;
      try {
        final resp = await widget.state.api.post(
          '/api/commands/set-key',
          {'name': 'heavy', 'value': key, 'modelRoutes': true},
          confirm: 'set-key',
        );
        // 写到哪几格以**服务端回执**为准（它知道当前配置里有几条路由、哪几条有格）；
        // 老服务端（不认识 modelRoutes）只回 name ⇒ 退回"就写这一格"，不假装写了别的。
        final written = _stringList(resp, 'gates');
        keyGatesHolding = written.isEmpty ? const ['heavy'] : written;
        keyGatesNoSlot = _noSlotRoutes(resp);
        receipt = [
          s.onboardingApiKeyWritten(_gatesLabel(keyGatesHolding)),
          if (keyGatesNoSlot.isNotEmpty)
            s.onboardingApiKeyNoSlot(
              keyGatesNoSlot.map((route) => route.route).join(' / '),
              keyGatesNoSlot.map((route) => route.envName).join(' / '),
            ),
        ].join('\n');
        // 框里那串密钥已经不必要了：清掉，占位提示换成"写到了哪几格"
        keyCtl.clear();
      } catch (err) {
        return s.onboardingApiKeySaveFailed(
          _gatesLabel(gates.isEmpty ? const ['heavy'] : gates),
          '$err',
        );
      }
    }
    wrote = true;
    return null;
  }

  /// 第三步 → 两条既有通道，各写各的：
  ///   · 通道开关 → `POST /api/commands/config-update`（短语 config-update），只提交开关本身；
  ///   · AppID / AppSecret → `POST /api/commands/set-key`（短语 set-key），**与设置页「消息适配器」
  ///     页那两格完全同一条路**：同一个端点、同一个键名（`channel_keys.dart`）、同一个确认短语。
  ///
  /// 为什么凭据也在这里写（用户 2026-10-18 ④）：首次使用的人就在这一页把两把凭据填了，
  /// 再让他去设置页填一遍是白跑一趟；但**写入路径不新开一条**——set-key 落到同一份
  /// `data/.keys.json`，设置页那边读到的就是这里写进去的。
  ///
  /// 只写非空的那几条：框空着 = 这一次不碰那条（不是"清空"；清除密钥在渠道页有专门的确认动作）。
  Future<String?> _settleChannel() async {
    final fields = <String, dynamic>{};
    // 扫码绑定成功那一刻，服务端已经写过 `channels.qqOfficial.enabled = true` 与两把凭据
    // （见 src/web/server.ts 的 settleQqBind）——这里再写一遍只会多一条 config/changed。
    if (qqOn && !widget.signals.qqEnabled && !qqBindSaved) {
      fields['channels.qqOfficial.enabled'] = true;
    }
    if (onebotOn && !widget.signals.onebotEnabled) fields['channels.onebot.enabled'] = true;

    final secrets = <String, String>{};
    final appId = appIdCtl.text.trim();
    final appSecret = appSecretCtl.text.trim();
    if (appId.isNotEmpty) secrets[kQqAppIdKey] = appId;
    if (appSecret.isNotEmpty) secrets[kQqAppSecretKey] = appSecret;

    if (fields.isEmpty && secrets.isEmpty) return null;
    final strings = IrmiaStrings.read(context);
    if (fields.isNotEmpty) {
      try {
        await widget.state.api
            .post('/api/commands/config-update', {'fields': fields}, confirm: 'config-update');
      } catch (err) {
        return strings.onboardingChannelSaveFailed('$err');
      }
    }
    if (secrets.isNotEmpty) {
      try {
        for (final entry in secrets.entries) {
          await widget.state.api.post(
            '/api/commands/set-key',
            {'name': entry.key, 'value': entry.value},
            confirm: 'set-key',
          );
        }
      } catch (err) {
        // 开关与凭据是两条通道，错误分开说：混成一句"保存失败"人就不知道该重填哪个
        return strings.onboardingSecretsSaveFailed('$err');
      }
    }
    wrote = true;
    return null;
  }

  /// 第四步 → `POST /api/commands/persona-edit`（危险表里是 null：不带确认短语）
  ///
  /// 写之前把「名字：」那一行补上（见 her_name.dart 的 upsertHerNameLine）：名字是界面上的称呼
  /// 与唤醒词的来源，**换一份正文不该把它弄丢**。旁注里跟人说清了这件事，所以不是暗箱操作。
  Future<String?> _settlePersona() async {
    final draft = personaCtl.text.trim();
    if (!_personaDirty) return null;
    if (draft.isEmpty) return '人格不能写成空的（要清空请去人格配置页），未保存';
    final content = upsertHerNameLine(draft, _knownName);
    try {
      await widget.state.api.post('/api/commands/persona-edit', {
        'file': kIdentityFile,
        'content': content,
      });
    } catch (err) {
      return '人格没写进去：$err';
    }
    wrote = true;
    // 名字行可能刚补上或刚被改掉：界面上的称呼跟着重读一遍（读不到就保持现状，见 refreshHerName）
    await widget.state.refreshHerName();
    return null;
  }

  /// 第五步 → `POST /api/commands/config-update`，只提交 `trust.mode`。
  ///
  /// `X-Confirm` 要带**字段短语** `trust-full-access`（服务端 `DANGEROUS_FIELDS` 对
  /// `trust.mode` 两个方向都要），所以这一处读设置页那个共享常量 [kTrustConfirm]，
  /// 与本文件顶部 import 里的 `kTrustFull` 同一条理由：同一个字段的写法只许有一份。
  ///
  /// **与盘上那份一致就一个字节都不写**：引导页的默认高亮就是配置默认值（[defaultTrustMode]），
  /// 也就是说绝大多数人这一屏根本不会改任何东西——那时还硬写一次 config.json，换来的是
  /// `$pending.restartRequired` 里凭空多一条 `trust.mode`：设置页会因此显示"尚未生效"、
  /// 人什么都没改却被告知"有一项边界改了还没重启"。同一份默认值写不写盘没有区别，
  /// 那就别写。
  Future<String?> _settleTrust() async {
    if (trustMode == widget.signals.trustMode) return null;
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {
          'fields': {'trust.mode': trustMode},
        },
        confirm: kTrustConfirm,
      );
    } catch (err) {
      return '信任范围没写进去：$err';
    }
    wrote = true;
    return null;
  }
}

/// 第二步缺密钥时卡上那句话（单独拎出来是为了能被测试直接引用，不靠抄一遍文案）
const keysRequiredNote = '还没填 API Key：她连不上任何模型。填进去，或者点「以后再说」稍后再配。';

const kOnboardingNextLabel = '继续';
const kOnboardingBackLabel = '上一步';
const kOnboardingSkipLabel = '跳过这一步';
const kOnboardingDoneLabel = '完成';
const kOnboardingCloseLabel = '关闭引导';

// ──────────────────────────────── 取值小工具 ────────────────────────────────

/// 按点路径取配置值（`a.b.c`）；任一层缺失都给 null
Object? _at(Object? doc, String path) {
  Object? current = doc;
  for (final segment in path.split('.')) {
    if (current is! Map) return null;
    current = current[segment];
  }
  return current;
}

/// 点路径取字符串：非字符串一律当空串（界面要的是"能显示的字"）
String _text(Object? doc, String path) {
  final value = _at(doc, path);
  return value is String ? value.trim() : '';
}

/// 从 `GET /api/keys` 的回包里取一把密钥的现状。
///
/// 形状照服务端：`{ "<name>": { "configured": true, "mask": "qqA…9f3c" } }`。
/// 读不到/形状不对 ⇒ [SecretState.absent]（"当作没配"，不抛：引导是个提示，不该让壳崩）。
SecretState _secretState(Object? keys, String name) {
  final raw = keys is Map ? keys[name] : null;
  if (raw is! Map) return SecretState.absent;
  final mask = raw['mask'];
  return SecretState(configured: raw['configured'] == true, mask: mask is String ? mask : null);
}

/// 格名的统一写法（`heavy / light`）：占位提示、回执、失败原因三处共用一份。
///
/// 为什么值得抽一行：这三句话都在念"哪几格"，各拼一次的话总有一天一处用顿号、一处用斜杠，
/// 而这三句是并排给人看的（同一屏上先看提示、再看回执）。
String _gatesLabel(List<String> gates) => gates.join(' / ');

/// 从 `set-key` 回执里取一个字符串数组（`gates` / `changed` 那种）；形状不对给空表。
///
/// 为什么容忍"没有这个字段"：老服务端不认 `modelRoutes`，回包里只有 `name`——那时界面
/// 要退回"就写了这一格"，而不是假装写了别的格（回执说假话比没有回执更糟）。
List<String> _stringList(Object? resp, String field) {
  final raw = resp is Map ? resp[field] : null;
  if (raw is! List) return const [];
  return raw.whereType<String>().map((name) => name.trim()).where((name) => name.isNotEmpty).toList();
}

/// 从 `set-key` 回执里取"配置里有、但**没有密钥格**"的那几条路由（今天只有 `degraded`）。
///
/// 服务端回 `skipped: [{route, envName}]`：写不进去的东西必须说出来（"用环境变量给"），
/// 悄悄忽略等于让人以为配好了。
List<({String route, String envName})> _noSlotRoutes(Object? resp) {
  final raw = resp is Map ? resp['skipped'] : null;
  if (raw is! List) return const [];
  final out = <({String route, String envName})>[];
  for (final item in raw) {
    if (item is! Map) continue;
    final route = item['route'];
    if (route is! String || route.trim().isEmpty) continue;
    final envName = item['envName'];
    out.add((route: route.trim(), envName: envName is String ? envName.trim() : ''));
  }
  return out;
}
