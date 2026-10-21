// TODO(i18n): 本文件还有 24 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/ui_kit.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'her_name.dart';
import 'i18n/strings_scope.dart';
import 'theme.dart';

/// Irmia GUI 交互基元（来源：docs/astrbot-ux-interaction.md §八「直接照搬」）。
///
/// 四件事收口在这里，各页只写业务：
/// - [IrmiaToast]：全局 toast，同一时刻只显示一条，连续调用自动接棒。
/// - [confirm] / [confirmDestructive]：确认框，以及要交代附带后果的危险操作增强版。
/// - [showHumanAskCard]：**她在问**的那张顶层卡（design §6 的 agent 来源；标题与按钮文案写死，
///   她只能决定问什么，不能决定这张卡长什么样）。
/// - [StateBlock]：区块三态（加载中 / 空 / 失败 + 重试）。
/// - [PagerBar]：列表分页栏（每页条数 + 计数 + 圆形页码）。
///
/// 页面骨架（页头 / 引导条 / 行数收口 / 详情折叠）在 `page_chrome.dart`，
/// 两处不重叠：那边管「一页长什么样」，这里管「发生了什么事、要不要继续、
/// 还没有内容、怎么翻页」。文案一律走 docs/copy-guide.md 的语气与词表。

/// 对话框最大宽度：AstrBot `ConfirmDialog.vue` 的 `max-width="400"`
const kDialogMaxWidth = 400.0;

/// 每页条数默认档位（通用列表用；日志页既有的 100/200/500 属该页自己的量级）
const kPageSizes = <int>[10, 20, 50, 100];

/// 页码窗口槽位上限（含省略号），照 Vuetify 的 `:total-visible="7"`
const kMaxPageDots = 7;

/// 区块三态默认内边距：与页面 26px 水平留白对齐
const kStateBlockPadding = EdgeInsets.fromLTRB(26, 14, 26, 14);

/// 空态图标尺寸（AstrBot `PlatformPage.vue:126-140` 的 `size="42"`）
const kStateBlockIconSize = 42.0;

/// 三态块的宽度上限。
///
/// 为什么要它：块的容器是"整行宽 + 淡色底 + 描边"，而空态里的内容只有一个图标、一句
/// 状态、一个按钮。在 1200px 宽的内容区里撑满，就成了一整片淡蓝色空白——远看像页面坏了，
/// 近看又找不着重点（扩展页那几个 tab 空态就是这样，实测被用户点名"跟别的页不像、也不好看"）。
/// 限制到 560 之后它重新变成"一块提示"，而不是"一堵墙"；再宽的屏也只是右边缘更空，
/// 而那块空是页面的留白，不是控件的底色。
const kStateBlockMaxWidth = 560.0;

/// toast 的语义等级：只改图标与色相，版式一律相同。
enum ToastKind {
  /// 中性通报：已复制、已发出
  info,

  /// 做成了：已保存、已连接
  success,

  /// 提醒：部分失败、需要留意
  warn,

  /// 出错：请求失败、操作被拒
  error,
}

/// 全局 toast —— 全站唯一的一条即时反馈通道
/// （AstrBot `App.vue:6-17` + `stores/toast.js` 的队列化 snackbar）。
///
/// 什么时候用：任何「动作已发出 / 已失败」的一句话反馈——保存、复制、唤醒、
/// 标记、卸载、请求报错。都走这里，别在页面里自己 `showSnackBar`，
/// 否则同一时刻会有两条提示叠在一起。
/// 什么时候不用：需要用户点头才继续的用 [confirm]；需要常驻展示的状态
/// （连接中断、脏状态）用页面自己的状态条；一行放不下的报错给 [StateBlock]。
///
/// 版式固定：浮动、圆角 8、左侧图标随 [kind]、4 秒后自动消失。
/// 队列化：新的一条先把当前这条收走（[ScaffoldMessenger.hideCurrentSnackBar]）
/// 再上屏，连续调用不会叠成两行。
class IrmiaToast {
  IrmiaToast._();

  /// 停留时长：4 秒（AstrBot 本地 snackbar 取 3 秒，我们留够读完一句的长度）
  static const duration = Duration(seconds: 4);

  /// 浮动条的宽度区间（用户 ⑫："太长了，能不能自适应长度和高度？"）。
  ///
  /// 为什么不能像以前那样只给 `margin`：浮动 SnackBar 只在没给 `width` 时才会撑满
  /// （屏宽 − 左右 16），于是"上下文已清空"这种七个字的提示也占满一整条。
  /// 给了 `width` 它就会水平居中、宽度由我们定，高度仍由文字自己长（最多两行，见 [maxLines]）。
  static const _minWidth = 240.0;
  /// 上限与 [kStateBlockMaxWidth] 同档：两处"一块提示"的宽度不该各说各话
  static const _maxWidth = kStateBlockMaxWidth;
  /// 图标 18 + 图标与文字间距 10 + SnackBar 自己的左右内边距（浮动条默认 16×2）
  static const _chromeWidth = 18.0 + 10.0 + 32.0;
  /// 最多两行（超出省略号）：再长就不该用 toast，改用 [StateBlock]
  static const maxLines = 2;

  /// 量一句文案要占多宽：单行量完加上图标与内边距，再夹进 [_minWidth, _maxWidth]。
  /// 夹到上限时文字自己换成两行——所以"高度也跟着内容走"不需要另写一段。
  static double _widthFor(BuildContext context, String message) {
    final theme = Theme.of(context);
    final style = theme.snackBarTheme.contentTextStyle ?? theme.textTheme.bodyMedium ?? const TextStyle();
    final painter = TextPainter(
      text: TextSpan(text: message, style: style),
      maxLines: maxLines,
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final wanted = painter.width + _chromeWidth;
    painter.dispose();
    return wanted.clamp(_minWidth, _maxWidth);
  }

  /// 弹一条 toast。找不到 [ScaffoldMessenger]（比如脱离 MaterialApp 的
  /// 局部测试）时静默跳过，不抛异常打断调用方。
  static void show(BuildContext context, String message, {ToastKind kind = ToastKind.info}) {
    final messenger = ScaffoldMessenger.maybeOf(context);
    if (messenger == null) return;

    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final background = theme.snackBarTheme.backgroundColor ?? scheme.inverseSurface;

    // 队列化：当前这条先收走，排队还没上屏的那些直接丢（否则几秒前的旧消息
    // 会一条条补播），保证同一时刻只有一条、且永远是最新那句话
    messenger.hideCurrentSnackBar();
    messenger.clearSnackBars();
    messenger.showSnackBar(
      SnackBar(
        duration: duration,
        behavior: SnackBarBehavior.floating,
        // width 与 margin 二选一（SnackBar 自己断言了这一点）：给了宽度就居中，不撑满
        width: _widthFor(context, message),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        ),
        content: Row(
          children: [
            Icon(
              _iconFor(kind),
              size: 18,
              color: _readable(_toneFor(kind, scheme), background),
            ),
            const SizedBox(width: 10),
            Expanded(child: Text(message, maxLines: maxLines, overflow: TextOverflow.ellipsis)),
          ],
        ),
      ),
    );
  }

  static IconData _iconFor(ToastKind kind) => switch (kind) {
        ToastKind.info => Icons.info_outline_rounded,
        ToastKind.success => Icons.check_circle_outline_rounded,
        ToastKind.warn => Icons.warning_amber_rounded,
        ToastKind.error => Icons.error_outline_rounded,
      };

  static Color _toneFor(ToastKind kind, ColorScheme scheme) => switch (kind) {
        ToastKind.info => scheme.primary,
        ToastKind.success => IrmiaTheme.ok,
        ToastKind.warn => IrmiaTheme.warn,
        ToastKind.error => IrmiaTheme.danger,
      };

  /// 状态四色在浮动条底上要够显眼：深底提亮、浅底压暗，色相不动（语义不漂）
  static Color _readable(Color tone, Color background) {
    final lift = ThemeData.estimateBrightnessForColor(background) == Brightness.dark;
    return Color.alphaBlend(
      (lift ? Colors.white : Colors.black).withValues(alpha: 0.3),
      tone,
    );
  }
}

/// 统一确认框（AstrBot `ConfirmDialog.vue` + `utils/confirmDialog.ts`）。
///
/// 什么时候用：需要用户点头一次才继续的动作——删除、覆盖、重置、断开、清空。
/// 什么时候不用：一句话反馈走 [IrmiaToast]；动作会顺带毁掉别的东西、需要用户
/// 勾选作用范围的走 [confirmDestructive]；要填字段的表单用页面自己的 `showDialog`。
///
/// 版式固定：对话框最宽 [kDialogMaxWidth]、标题 + 可选正文、取消是灰色文字按钮、
/// 确认是 tonal 按钮（[danger] 为真时换红底）。点外部或按 Esc 都等同取消，
/// 一律返回 false——所以调用方不需要判空。
Future<bool> confirm(
  BuildContext context, {
  required String title,
  String? body,
  String? confirmLabel,
  bool danger = false,
}) async {
  if (!context.mounted) return false;
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) {
      final scheme = Theme.of(dialogContext).colorScheme;
      final s = IrmiaStrings.of(dialogContext);
      return AlertDialog(
        constraints: const BoxConstraints(minWidth: 280, maxWidth: kDialogMaxWidth),
        title: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        content: body == null
            ? null
            : Text(
                body,
                style: TextStyle(fontSize: 13, height: 1.7, color: scheme.onSurfaceVariant),
              ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
            // 「取消」是**跨页同一句话**：文案表里只有一处（s.cancel）
            child: Text(s.cancel),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            style: _confirmButtonStyle(scheme, danger),
            child: Text(confirmLabel ?? s.confirm),
          ),
        ],
      );
    },
  );
  return result ?? false;
}

/// 危险操作的「附带后果」条目：一条可勾选的作用范围。
///
/// 勾选结果写回本对象（[selected]），所以调用方在 [confirmDestructive] 返回 true
/// 之后读 `options.where((o) => o.selected)` 就知道这次要连带动哪些东西。
class ConfirmOption {
  ConfirmOption({
    required this.label,
    this.note,
    this.tone = ConfirmTone.warn,
    this.selected = false,
  }) : _initialSelected = selected;

  /// 复选框文案：名词短语，说明这一项会顺带删掉/改掉什么
  final String label;

  /// 一句话补充（挂在右侧 ⓘ 的 tooltip 上），比如「本地配置无法从备份恢复」
  final String? note;

  /// 色相：删配置一类的用 [ConfirmTone.warn]，删数据的用 [ConfirmTone.danger]
  final ConfirmTone tone;

  final bool _initialSelected;

  /// 当前是否勾选；弹窗每次打开都会先重置成初始值，调用方不必手工清理
  bool selected;

  /// 回到构造时的勾选态
  void reset() => selected = _initialSelected;
}

/// 附带后果的严重级
enum ConfirmTone {
  /// 会丢配置、丢设置
  warn,

  /// 会丢数据，不可恢复
  danger,
}

/// 危险操作增强版确认框（AstrBot `UninstallConfirmDialog.vue:22-66`）。
///
/// 什么时候用：一次动作会顺带毁掉不止一样东西——卸载扩展（删配置 / 删数据）、
/// 删除人格资产、清空日志、重置设置。光问一句不够，要把附带后果摊成复选框让
/// 用户自己勾，勾了任意一项才浮出「操作不可撤销」的警示条。
///
/// 勾选结果写在传入的 [options] 上（见 [ConfirmOption.selected]），返回值只表示
/// 「确认还是取消」。返回 false 的情形：点取消、点外部、按 Esc。
Future<bool> confirmDestructive(
  BuildContext context, {
  required String title,
  required List<ConfirmOption> options,
  required String warning,
  String? body,
  String confirmLabel = '确认',
}) async {
  if (!context.mounted) return false;
  // 复用同一份 options 的调用方不该被上一次的勾选污染
  for (final option in options) {
    option.reset();
  }

  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (builderContext, setDialogState) {
        final scheme = Theme.of(builderContext).colorScheme;
        final picked = options.any((option) => option.selected);
        return AlertDialog(
          constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
          title: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (body != null) ...[
                Text(
                  body,
                  style: TextStyle(fontSize: 13, height: 1.7, color: scheme.onSurfaceVariant),
                ),
                const SizedBox(height: 8),
              ],
              for (final option in options)
                _OptionRow(
                  option: option,
                  onToggle: () => setDialogState(() => option.selected = !option.selected),
                ),
              if (picked) ...[
                const SizedBox(height: 10),
                _IrreversibleNote(text: warning),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
              // 「取消」是**跨页同一句话**：文案表里只有一处（s.cancel）
            child: Text(IrmiaStrings.of(dialogContext).cancel),
            ),
            FilledButton.tonal(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              style: _confirmButtonStyle(scheme, true),
              child: Text(confirmLabel),
            ),
          ],
        );
      },
    ),
  );
  return result ?? false;
}

ButtonStyle _confirmButtonStyle(ColorScheme scheme, bool danger) => FilledButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 18),
      minimumSize: const Size(0, 36),
      backgroundColor: danger ? scheme.errorContainer : null,
      foregroundColor: danger ? scheme.onErrorContainer : null,
    );

// ──────────────────────────────── 她在问（design §6 的 agent 来源） ────────────────────────────────

/// 卡片标题的固定句式（**写死在界面里，一个字节都不来自她**）。
///
/// design §6 的防伪是硬约束：不可信内容不得变成可信 UI。她的 `question` 是她的原话
/// （还可能被外部消息牵着走），所以卡片必须**先说清这是谁在问**——句子由框架写死，
/// 按钮文案同理（[kAskCardAnswerLabel] / [kAskCardLaterLabel]）。她只能决定问什么，
/// 不能决定这张卡长什么样、更不能借"确认"这类系统口吻去冒充框架。
///
/// 名字是**唯一的变量**，而且它不是从她那条载荷里来的：它来自人格资产 `persona/IDENTITY.md`
/// 的「名字：」那一行——那份文件在她的工具通道里是拒写的（`write_persona` 对 IDENTITY.md
/// 连提案都不收，见 src/tools/admin.ts 的 PERSONA_PROTECTED_FILES），要改得由人在界面上改。
/// 句式仍是框架的，名字读不到时退化成 [kHerPronoun]（"她想问你："），所以这张卡永远不会
/// 因为读不到名字而变成一个可疑的标题。
const String kAskCardSentence = '想问你：';

/// 拼出卡面标题：`小七想问你：` / `她想问你：`（名字的口径全在 [herNameInSentence] 里）
String askCardTitle(String? herName) => '${herNameInSentence(herName)}$kAskCardSentence';

/// 动作文案：也是固定词表（与 [confirm] 那族同一姿势：动作由框架命名）。
const kAskCardAnswerLabel = '答复';
const kAskCardLaterLabel = '稍后';

/// 「稍后」的语义说明：**它不记录任何东西**——不是拒绝、也不是跳过（design §6.1）。
const kAskCardLaterNote = '已收起这张卡（本次运行内不再显示）。她不会收到任何答复：这不是拒绝，也没有替她做决定。';

/// 她问人：一张顶层卡，人要写一段话回去。
///
/// 与 [confirm] 的分工：那个问"要不要做这件事"（返回 bool），这个要的是**只有人知道的那件事**
/// （返回那段文字）。版式与 [confirm] 同族：对话框最宽 [kDialogMaxWidth]、标题 16/w600、
/// 取消位是灰色文字按钮、主按钮 tonal——差别只在正文多一个输入框。
///
/// 返回值：**null = 稍后**（没做任何决定，卡还在台面上，等服务端下一拍照样会给回来）；
/// 非 null = 人写的答复文本（调用方负责发 `POST /api/commands/answer` 带上 `askSeq`）。
///
/// 参数里**没有**标题、没有按钮文案：那两样是防伪面，由本函数与 [askCardTitle] 写死。
/// [herName] 只是"这是谁在问"那个名字（读不到就退化成"她"，见 [askCardTitle]）。
/// [queued] 与 [expired] 是**框架的事实**（服务端算出来的），不是她的原话。
Future<String?> showHumanAskCard(
  BuildContext context, {
  /// 她的名字（`persona/IDENTITY.md` 的「名字：」那一行；null = 读不到）
  String? herName,
  required String question,
  /// 她的原话里"为什么问、查到哪一步"那一段（服务端字段叫 `context`；
  /// 这里改名只因为它与 BuilderContext 同名，读起来会歧义）
  String? contextNote,
  int queued = 0,
  bool expired = false,
}) async {
  if (!context.mounted) return null;
  final controller = TextEditingController();
  try {
    final result = await showDialog<String>(
      context: context,
      builder: (dialogContext) {
        final scheme = Theme.of(dialogContext).colorScheme;
        return StatefulBuilder(
          builder: (builderContext, setDialogState) => AlertDialog(
            constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
            title: Text(askCardTitle(herName),
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 她的原话：字号与其它正文一致，靠"是谁在说"的标题分层（不是靠加大字号）
                Text(question, style: TextStyle(fontSize: 13.5, height: 1.7, color: scheme.onSurface)),
                if (contextNote != null && contextNote.trim().isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Text(
                    contextNote.trim(),
                    style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant),
                  ),
                ],
                const SizedBox(height: 12),
                TextField(
                  controller: controller,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 4,
                  onChanged: (_) => setDialogState(() {}),
                  onSubmitted: (value) {
                    if (value.trim().isEmpty) return;
                    Navigator.of(dialogContext).pop(value.trim());
                  },
                  decoration: const InputDecoration(hintText: '写一句答复'),
                ),
                const SizedBox(height: 8),
                Text(
                  '答复会记进日志，她在下一轮看到。'
                  '${expired ? '这张卡已超时：她收到的是「未批准、未拒绝」，你没有做决定。' : ''}'
                  '${queued > 0 ? '还有 $queued 条在排队，答完这张才会显示。' : ''}',
                  style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
                child: const Text(kAskCardLaterLabel),
              ),
              FilledButton.tonal(
                onPressed: controller.text.trim().isEmpty
                    ? null
                    : () => Navigator.of(dialogContext).pop(controller.text.trim()),
                style: _confirmButtonStyle(scheme, false),
                child: const Text(kAskCardAnswerLabel),
              ),
            ],
          ),
        );
      },
    );
    return result == null || result.trim().isEmpty ? null : result.trim();
  } finally {
    // 退场动画跑完再销毁：`showDialog` 的 Future 在**路由弹出时**就 resolve，而 TextField
    // 还要几十毫秒才从树上摘掉——这期间 `didUpdateWidget` 仍会去 listen 这个已经销毁的
    // controller，于是报 "A TextEditingController was used after being disposed"（实测踩到过：
    // 一关弹窗就崩）。延迟一拍最省事，代价只是几百毫秒的临时对象。
    disposeLater(controller);
  }
}

/// 弹窗退场之后再销毁输入控制器（原因见 [showHumanAskCard] 里的那段注释）。
///
/// 公开而不是留着私有：首次启动引导那张卡（onboarding.dart）里也有几个 TextField 会随弹窗一起
/// 退场，同一个坑只需要一处说明、一份实现——两处各写一个定时器，改一处忘一处就又是一次崩溃。
void disposeLater(TextEditingController controller) {
  Future<void>.delayed(const Duration(milliseconds: 600), controller.dispose);
}

// ──────────────────────── 「她被怎么称呼」 ────────────────────────

/// 首次使用时问一次（也在消息适配器页里随时可改）。
///
/// 为什么框架要问：群里的人常常不打 @ 直接喊名字（"小七，帮我看看"），而平台不会把那种
/// 句子标成"提到了机器人"——**只有人知道她被怎么称呼**。不填的话那些话只会静静躺在信箱里，
/// 她永远听不见；填宽了会误唤醒、填窄了会漏，所以分寸必须由人来定。
///
/// 这张卡问的是"机器怎么认出在叫她"，**不是她的名字**（名字在人格资产里，见 her_name.dart）；
/// [herName] 只用来把输入框的示例写得像她一点：写死一个别人的名字（原来的
/// `'伊尔弥亚、弥亚小姐、Irmia'`）会让人以为那就是她的名字。
const kMentionCardTitle = '她可能被怎么称呼？';
const kMentionCardSaveLabel = '保存';
const kMentionCardLaterLabel = '以后再说';
const kMentionCardNote = '群里的人不打 @ 直接喊这几个词时，框架会把那些话当作"在叫她"，'
    '与 @ 一样推到她面前。用逗号或顿号隔开。空着 = 只认平台的 @。';

/// 让用户填「她被怎么称呼」。返回**去重后的词表**；null = 以后再说（一个字节都不写）。
Future<List<String>?> showMentionKeywordsCard(
  BuildContext context, {
  List<String> initial = const [],
  /// 她的名字（只影响输入框里的示例提示；null = 给一个中性示例）
  String? herName,
}) async {
  if (!context.mounted) return null;
  final controller = TextEditingController(text: initial.join('、'));
  final state = ValueNotifier<int>(0);
  try {
    final result = await showDialog<List<String>>(
      context: context,
      builder: (dialogContext) {
        final scheme = Theme.of(dialogContext).colorScheme;
        return ValueListenableBuilder<int>(
          valueListenable: state,
          builder: (builderContext, _, __) => AlertDialog(
            constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
            title: Text(kMentionCardTitle,
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextField(
                  controller: controller,
                  autofocus: true,
                  minLines: 1,
                  maxLines: 3,
                  onChanged: (_) => state.value++,
                  decoration: InputDecoration(hintText: mentionKeywordsHint(herName)),
                ),
                const SizedBox(height: 8),
                Text(kMentionCardNote,
                    style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
                child: const Text(kMentionCardLaterLabel),
              ),
              FilledButton.tonal(
                // 空词表也是**合法的**（= 只认 @），但"保存一个空表"和"以后再说"在她看来是
                // 两件事：前者是决定，后者是没决定。所以这里允许空着保存。
                onPressed: () => Navigator.of(dialogContext).pop(splitMentionKeywords(controller.text)),
                style: _confirmButtonStyle(scheme, false),
                child: const Text(kMentionCardSaveLabel),
              ),
            ],
          ),
        );
      },
    );
    return result;
  } finally {
    state.dispose();
    disposeLater(controller);
  }
}

/// 把界面里那行文字切成词表：逗号/顿号/空格都当分隔符，去重且保序。
///
/// 与服务端 `set-mention-keywords` 的清洗**同一口径**（它还会再洗一遍并校验长度）：
/// 界面这一层先切好，用户看到的词数才与保存后的一致。
List<String> splitMentionKeywords(String text) {
  final out = <String>[];
  for (final raw in text.split(RegExp(r'[,，、\s]+'))) {
    final word = raw.trim();
    if (word.isEmpty || out.contains(word)) continue;
    out.add(word);
  }
  return out;
}

/// 一条可勾选的附带后果：整行可点，右侧 ⓘ 挂说明
class _OptionRow extends StatelessWidget {
  const _OptionRow({required this.option, required this.onToggle});

  final ConfirmOption option;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = option.tone == ConfirmTone.danger ? IrmiaTheme.danger : IrmiaTheme.warn;
    return InkWell(
      onTap: onToggle,
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(
          children: [
            Checkbox(
              value: option.selected,
              onChanged: (_) => onToggle(),
              activeColor: tone,
              visualDensity: VisualDensity.compact,
              materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                option.label,
                style: TextStyle(fontSize: 13, height: 1.5, color: scheme.onSurface),
              ),
            ),
            if (option.note != null)
              Tooltip(
                message: option.note!,
                child: Icon(Icons.info_outline_rounded, size: 16, color: scheme.onSurfaceVariant),
              ),
          ],
        ),
      ),
    );
  }
}

/// 勾选后的「操作不可撤销」警示条：warning 色、细描边，与 GuideBar 同一套色阶
class _IrreversibleNote extends StatelessWidget {
  const _IrreversibleNote({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    const tone = IrmiaTheme.warn;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: tone.withValues(alpha: 0.32)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(Icons.warning_amber_rounded, size: 16, color: tone),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '操作不可撤销。$text',
              style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurface),
            ),
          ),
        ],
      ),
    );
  }
}

enum _BlockKind { loading, empty, error }

/// 区块三态占位：加载中 / 空 / 失败。
///
/// 什么时候用：任何「异步取来的一段内容」还没有内容可渲染的时候——事件列表、
/// 渠道列表、扩展列表、详情面板、用量卡。三态一次写全，别让「加载中」和
/// 「没有数据」被同一句话糊过去。
/// 什么时候不用：整页首次进入的整体骨架由页面自己排；这里只占一个区块。
///
/// 版式与 `page_chrome.dart` 的 `GuideBar` 同源：圆角 [IrmiaTheme.radiusCard]、
/// 淡底 + 细描边（alpha 0.06 / 0.28），图标在左、文案一句、动作在右。
class StateBlock extends StatelessWidget {
  /// 加载中：顶部 2px 不确定进度线（AstrBot `ConfigPage.vue:58-63`），不用居中转圈。
  /// 理由：贴一条线不打断阅读，数据到达时整块也不会跳动。
  const StateBlock.loading({super.key, this.hint, this.padding = kStateBlockPadding})
      : _kind = _BlockKind.loading,
        icon = null,
        message = null,
        action = null,
        onRetry = null,
        retryLabel = '重试',
        tone = null;

  /// 空态：图标 + 一句状态 + CTA（AstrBot `PlatformPage.vue:126-140`）。
  /// CTA 常用 [StateBlock.cta] 拼；不需要动作时 [action] 留空。
  const StateBlock.empty({
    super.key,
    required this.icon,
    required this.message,
    this.action,
    this.hint,
    this.tone,
    this.padding = kStateBlockPadding,
  })  : _kind = _BlockKind.empty,
        onRetry = null,
        retryLabel = '重试';

  /// 失败态：错误图标 + 报错文案 + 重试按钮。
  /// [hint] 用来补 copy-guide §5 要求的「影响 / 下一步」，[message] 说清发生了什么。
  const StateBlock.error({
    super.key,
    required this.message,
    this.onRetry,
    this.retryLabel = '重试',
    this.hint,
    this.padding = kStateBlockPadding,
  })  : _kind = _BlockKind.error,
        icon = Icons.error_outline_rounded,
        action = null,
        tone = null;

  /// 空态 CTA 的标准形态：tonal 按钮（与 AstrBot「新增适配器」同款）
  static Widget cta(String label, VoidCallback onTap) =>
      FilledButton.tonal(onPressed: onTap, child: Text(label));

  final _BlockKind _kind;
  final IconData? icon;
  final String? message;
  final Widget? action;
  final VoidCallback? onRetry;
  final String retryLabel;
  final String? hint;
  final Color? tone;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (_kind == _BlockKind.loading) {
      return Padding(
        padding: padding,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const LinearProgressIndicator(minHeight: 2),
            if (hint != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  hint!,
                  style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                ),
              ),
          ],
        ),
      );
    }

    final color = tone ?? (_kind == _BlockKind.error ? IrmiaTheme.danger : scheme.primary);
    final cta = action ??
        (onRetry == null
            ? null
            : FilledButton.tonal(onPressed: onRetry, child: Text(retryLabel)));

    // 宽度受限 + 靠左：见 kStateBlockMaxWidth 的说明。靠左而不是居中，是为了跟页面里
    // 那些左对齐的卡片标题在同一条视线上。
    return Align(
      alignment: Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: kStateBlockMaxWidth),
        child: Container(
          width: double.infinity,
          padding: padding,
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.06),
            borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
            border: Border.all(color: color.withValues(alpha: 0.28)),
          ),
          child: Column(
            children: [
              // icon 在非 loading 的两个构造里必非空
              Icon(icon, size: kStateBlockIconSize, color: color),
              const SizedBox(height: 12),
              Text(
                message!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13.5, height: 1.6, color: scheme.onSurface),
              ),
              if (hint != null) ...[
                const SizedBox(height: 6),
                Text(
                  hint!,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant),
                ),
              ],
              if (cta != null) ...[const SizedBox(height: 16), cta],
            ],
          ),
        ),
      ),
    );
  }
}

/// 卡内的一行灰字：**卡片里的空态**用它，不要用 [StateBlock.empty]。
///
/// 什么时候用：容器本身已经是一张卡（有标题、有边界），"里面没有内容"是**常态**——
/// 「没有积累的消息」「没有需要你知道的事」「还没有通道活动」。这时再摆一块 [StateBlock]
/// 就是盒子套盒子：图标 + 居中文案 + CTA 占掉半张卡，读起来像出了事，而事实是一切照常。
/// 什么时候不用：内容区里**独立的一块**要空态（旁边没有卡片包着）——那时那块提示本身
/// 就是版式的一部分，走 [StateBlock.empty]；需要 CTA 的也走它。
class HintLine extends StatelessWidget {
  const HintLine(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        fontSize: 12.5,
        height: 1.6,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
    );
  }
}

/// 密钥格「已配置」时的样子：**文字与边框转蓝、内容居中**（用户 ⑥ 定的规格）。
///
/// 什么时候用：**只写不读**的密钥/令牌输入框——渠道页的 AppID / AppSecret、
/// 设置页两条 lane 的 API Key。它们有同一个状态"已经配好了，粘新值才覆盖"，
/// 而那是个**状态**，不该靠一行谁都不会去读的灰字承担（用户 ③ 的原话是"提醒明显一点"）。
///
/// 为什么收在 ui_kit：这几处是同一件事，规格各写一遍迟早漂移——用户 ⑥ 否掉的正是 ③ 里
/// 我自己给渠道页挑的绿。改一次，所有密钥格一起变。
///
/// 返回两样东西：`textAlign` 是 [TextField] 的属性，不在装饰里，所以要一起给。
/// [base] 由调用方给，未配置时原样返回它——字号、内边距、空态提示仍归各页自己。
///
/// 一处已知副作用：`textAlign` 管的是整个输入框，分不开"提示文字"与"值"，
/// 所以往已配置的格子里粘新值时那串值也是居中的（见 docs/gui-revision.md ⑥）。
({InputDecoration decoration, TextAlign textAlign}) secretLook(
  BuildContext context, {
  required bool configured,
  required InputDecoration base,
  required double hintFontSize,
}) {
  if (!configured) {
    return (decoration: base, textAlign: TextAlign.start);
  }
  final primary = Theme.of(context).colorScheme.primary;
  return (
    decoration: base.copyWith(
      hintStyle: TextStyle(fontSize: hintFontSize, fontWeight: FontWeight.w500, color: primary),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        borderSide: BorderSide(color: primary.withValues(alpha: 0.55), width: 1.4),
      ),
    ),
    textAlign: TextAlign.center,
  );
}

/// 脏状态提示 pill（AstrBot `ConfigPage.vue:109-119` 的底浮提示的卡内版本）。
///
/// 什么时候用：一张卡里有未保存的改动，且保存按钮就在同一行——它紧挨按钮给出原因，
/// 这样「保存为什么是灰的」不用猜。带 liveRegion，读屏会播报一次。
/// 文案默认「有未保存的更改」；需要更具体的说法（如「1 项改动」）时传 [label]。
class DirtyPill extends StatelessWidget {
  const DirtyPill({super.key, this.label = '有未保存的更改'});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: label,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: IrmiaTheme.warn.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.circle, size: 7, color: IrmiaTheme.warn),
            const SizedBox(width: 7),
            Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: IrmiaTheme.warn)),
          ],
        ),
      ),
    );
  }
}

/// 分页栏（AstrBot `ConversationPage.vue:203-223`）：不做无限滚动，一律分页。
///
/// 什么时候用：条数可能多到要翻页的列表——事件日志、会话、扩展目录、历史记录。
/// 什么时候不用：条数本来就在一屏内（AstrBot 的 `PlatformPage` 直接 `v-for`），
/// 或者内容是追加式流动的（聊天）。
///
/// 三个元素一次摆齐：每页条数下拉、`第 X-Y 条 / 共 N 条` 计数、圆形页码。
/// 页码窗口最多 [kMaxPageDots] 个槽位，超出用省略号收口，首尾恒可见。
/// 组件是受控的：page / pageSize / total 由调用方持有，[onPage] 与 [onPageSize]
/// 只回传新值，自己不存状态（这样发请求的时机由页面决定）。
/// [page] 从 1 开始计数。
class PagerBar extends StatelessWidget {
  const PagerBar({
    super.key,
    required this.page,
    required this.pageSize,
    required this.total,
    required this.onPage,
    required this.onPageSize,
    this.pageSizes = kPageSizes,
    this.padding = kStateBlockPadding,
  });

  /// 当前页（1 起）
  final int page;

  /// 每页条数
  final int pageSize;

  /// 总条数（未加载完时传当前已知条数）
  final int total;

  /// 翻页回调：参数是目标页
  final ValueChanged<int> onPage;

  /// 改每页条数回调：参数是新的 pageSize，页面通常要顺便回到第 1 页
  final ValueChanged<int> onPageSize;

  /// 下拉档位
  final List<int> pageSizes;

  final EdgeInsets padding;

  /// 下拉档位：传入的 pageSize 不在档位里时补进去，避免 DropdownButton 断言失败
  List<int> get _sizes => pageSizes.contains(pageSize)
      ? pageSizes
      : (<int>{...pageSizes, pageSize}.toList()..sort());

  int get _totalPages => total <= 0 ? 1 : (total / pageSize).ceil();

  /// 渲染用的当前页：越界的 page 只影响显示，不回调纠正（受控组件不擅自改值）
  int get _current => page < 1 ? 1 : (page > _totalPages ? _totalPages : page);

  int get _rangeStart => total <= 0 ? 0 : (_current - 1) * pageSize + 1;

  int get _rangeEnd => total <= 0 ? 0 : math.min(_current * pageSize, total);

  /// 页码槽位：null 表示省略号。首尾固定，中间跟着当前页滑。
  List<int?> get _slots {
    final last = _totalPages;
    if (last <= kMaxPageDots) return [for (var i = 1; i <= last; i++) i];
    final current = _current;
    if (current <= 4) return [1, 2, 3, 4, 5, null, last];
    if (current >= last - 3) {
      return [1, null, last - 4, last - 3, last - 2, last - 1, last];
    }
    return [1, null, current - 1, current, current + 1, null, last];
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final current = _current;
    return Padding(
      padding: padding,
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            decoration: BoxDecoration(
              color: scheme.surface,
              border: Border.all(color: scheme.outlineVariant),
              borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
            ),
            child: DropdownButton<int>(
              value: pageSize,
              isDense: true,
              underline: const SizedBox.shrink(),
              borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
              style: TextStyle(fontSize: 12.5, color: scheme.onSurface),
              items: [
                for (final size in _sizes)
                  DropdownMenuItem<int>(value: size, child: Text('每页 $size 条')),
              ],
              onChanged: (value) {
                if (value == null || value == pageSize) return;
                onPageSize(value);
              },
            ),
          ),
          const SizedBox(width: 12),
          // 计数吸掉中间所有余量：窗口再窄也只是把「共 N 条」截掉，不会把页码顶出去
          Expanded(
            child: Text(
              '第 $_rangeStart-$_rangeEnd 条 / 共 $total 条',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11.5,
                color: scheme.onSurfaceVariant,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          const SizedBox(width: 12),
          _PageArrow(
            icon: Icons.chevron_left_rounded,
            tooltip: '上一页',
            onTap: current > 1 ? () => onPage(current - 1) : null,
          ),
          for (final slot in _slots)
            if (slot == null)
              const _PageGap()
            else
              _PageDot(
                label: '$slot',
                active: slot == current,
                onTap: () => onPage(slot),
              ),
          _PageArrow(
            icon: Icons.chevron_right_rounded,
            tooltip: '下一页',
            onTap: current < _totalPages ? () => onPage(current + 1) : null,
          ),
        ],
      ),
    );
  }
}

/// 圆形页码：当前页实心 primary 底，其余透明；数字等宽防抖
class _PageDot extends StatelessWidget {
  const _PageDot({required this.label, required this.active, this.onTap});

  final String label;
  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: Material(
        color: active ? scheme.primary : Colors.transparent,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onTap,
          child: SizedBox(
            width: 30,
            height: 30,
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                  color: active ? scheme.onPrimary : scheme.onSurfaceVariant,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 省略号占位：与页码同宽，保持整排节奏
class _PageGap extends StatelessWidget {
  const _PageGap();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 26,
      height: 30,
      child: Center(
        child: Text(
          '…',
          style: TextStyle(fontSize: 12.5, color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ),
    );
  }
}

/// 左右翻页箭头：禁用态自动变灰（onTap 为 null）
class _PageArrow extends StatelessWidget {
  const _PageArrow({required this.icon, required this.tooltip, this.onTap});

  final IconData icon;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: onTap,
      icon: Icon(icon, size: 18),
      tooltip: tooltip,
      padding: EdgeInsets.zero,
      visualDensity: VisualDensity.compact,
      constraints: const BoxConstraints.tightFor(width: 30, height: 30),
    );
  }
}
