// 本文件**一个界面文案字面量都没有**：卡面、细条、详情标题、失败那一行、按钮全是
// `lib/i18n/app_strings.dart` 的 `grantInbox*` 那一族（中英各一份）。判据与数据在
// `lib/grant_inbox.dart`（风险分级 / 待批判据 / 顺序 / 轮询），本文件只负责**画**与**按**。
/// 右下角「**快速审批卡**」：应用窗口内右下角那一摞卡（**不是**系统 toast、**不是**独立置顶窗）。
///
/// ## 为什么是这一层（2026-10-21，用户原话）
///
/// 「很多新手小白不知道**在哪可以审批**」。审批入口本来只在「扩展 → MCP → 待批」那一段，
/// 而那一页**只有人主动切过去时才存在**（`home.dart` 的 `_PageHost` 用 `AnimatedSwitcher`
/// 换页，页面一走它那条 20 秒轮询也停了）。于是"她递了一张单子"这件事，在人不去那一页的
/// 时候屏幕上一点痕迹都没有。这一层把它搬到**壳一级**：人切到哪一页都看得见。
///
/// ## 三条硬约束（都是有理由的，别在重构里丢掉）
///
///   ① **不抢焦点**：卡出现时**没有人按任何东西**，所以它不许抢键盘焦点、不许弹模态
///      （没有 `ModalBarrier`、没有 `showDialog`、没有 `windowManager.focus()`）——
///      它只是一个 `Stack` 里的一片纸。人正在聊天框里打字时才真会被这种"通知"打断。
///      唯一的模态是「详情」（人自己点的，那一层才配拿焦点）。
///   ② **15 秒后收起但不消失**：卡占着右下角，久了就碍事；但"收掉"等于让人又一次找不到
///      审批入口（正是这一轮要修的毛病）。所以收成**一条细条**（[kGrantInboxCollapseAfter]），
///      点它再展开。
///   ③ **高风险不许一键批**：按钮按 `grant_inbox.dart` 的白名单分级——
///      低风险（`mcp-remove` / `skill-remove`，都可回滚）点了直接生效；高风险（`mcp-add` /
///      `skill-install` / 认不出的 kind）按钮是「查看并批准」，点了**先开详情**，
///      在详情那张完整卡上才批得下去。判据只有 `grantRiskOf` 一处。
///
/// ## 与扩展页那张卡的关系
///
/// 「详情」里摆的就是扩展页那张**完整卡**（[GrantPendingCard]）——同一段代码、同一套字、
/// 同一套判据。不复刻一份的理由：两处各写一份卡片，迟早一处说"写进配置"、另一处说
/// "装进技能根"，而人凭哪一句决定要不要批？
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'app.dart';
import 'grant_inbox.dart';
import 'i18n/app_strings.dart';
import 'i18n/strings_scope.dart';
// 「详情」= 扩展页那张完整卡（GrantPendingCard）：同一份卡片只写一遍
import 'pages/extensions_page.dart';
import 'theme.dart';
import 'theme/design_tokens.dart';
import 'ui_kit.dart';

/// 竖直堆叠**最多几张**（超出显示「还有 N 条待批」）。
///
/// 三张是"一屏看得完 + 还能看见它挡住的内容"的折中：四张在 1366×768 的笔记本上就要
/// 盖掉半屏，而这一层是**通知**不是工作台（工作台在扩展页）。
const int kGrantInboxMaxCards = 3;

/// 显示多久之后收成细条（[GrantInboxHost] 的默认值）。
///
/// 15 秒：读一张卡上的三行字（做了什么 / 影响 / 谁写的）+ 想一下，够；再久就开始碍事。
/// 取成常量而不是写在 `Timer(...)` 里，是因为**用例要读它**（`test/grant_inbox_overlay_test.dart`
/// 拿它 pump 到点），而"15"这个数只该有一处。
const Duration kGrantInboxCollapseAfter = Duration(seconds: 15);

/// 卡片的宽（细条按内容量收窄，不用它）。
///
/// **420**（2026-10-21 由 340 放大一档，用户原话：「这个弹窗有点太小太丑了，可以稍微放大一点点」）。
/// 340 的时候一张卡里塞三行字：`加一个 MCP 服务：playwright` 折成两行、「命令：」那条在路径
/// 中间硬切（`…\@play` / `wright\mcp\cli.js`）——不是字太小，是**一行放不下**。420 给出的
/// 内容宽是 388（= 420 − 两侧 16 的内边距），一条带盘符的 Windows 路径能整个落在两行里。
/// 上界就是 420，不再往上：再宽会盖住聊天页右侧的发送键那一列。
const double kGrantInboxWidth = 420;

/// 卡上那三枚按钮的**最小高度**（2026-10-21 由 30 抬到 36）。
///
/// 36 是"一眼看得见、手也够得着"的那一档（Windows 上按钮的常规高度就是 32~36）；
/// 30 配 12 号的字显得像一枚标签而不是按钮。三枚**同一个数**：它们是一排控件，不是一个高一个矮。
const double kGrantInboxButtonHeight = 36;

/// 卡上正文最多几行（命令行与那一行影响**同一套换行策略**，中英各一份文案都按它收口）。
///
/// 3 行：一条 `C:\…\@playwright\mcp\cli.js` 在 388 宽、13 号等宽字下正好两行，
/// 留给罕见的超长命令行第三行；超出就省略，全文在 tooltip 里（见 [QuickGrantCard]）。
const int kGrantInboxBodyMaxLines = 3;

/// 距窗口右边 / 下边的留白（[Space.x4]，与页面内容区的 16 同一档）。
const double kGrantInboxInset = Space.x4;

/// 「详情」弹窗最宽多少。
///
/// 里面摆的是**扩展页那张完整卡**，它底部那一行 `[驳回][批准] … [批准之后会发生什么]`
/// 里最后那句是长的：量过技能装那一支，内容区需要 ~712，所以弹窗要能给出 ~800 的卡片宽度。
/// 880 = 800 + 卡片两侧内边距 + 弹窗两侧留白。
const double kGrantInboxDetailsMaxWidth = 880;

/// 「详情」里那张卡**最窄**多少（再窄就横向滚动，而不是把那一行挤爆）。
const double kGrantInboxDetailsMinWidth = 800;

/// 一套卡的**宿主**：把待批那一摞挂在整个壳的右下角（与 [AskCardHost] 同一种挂法）。
///
/// 它只做三件事：**跟着 `AppState.pendingGrants` 重建**、记**每张卡的提交中/失败**、
/// 记**收起还是展开**。判据（哪张高风险、哪几条待批、什么顺序）一律来自 `grant_inbox.dart`。
class GrantInboxHost extends StatefulWidget {
  const GrantInboxHost({
    super.key,
    required this.state,
    required this.child,
    this.collapseAfter = kGrantInboxCollapseAfter,
  });

  final AppState state;

  /// 壳本身（被这一层**包住**，不替换）
  final Widget child;

  /// 多久之后收成细条（用例把它调小，产品里用 [kGrantInboxCollapseAfter]）
  final Duration collapseAfter;

  @override
  State<GrantInboxHost> createState() => _GrantInboxHostState();
}

class _GrantInboxHostState extends State<GrantInboxHost> {
  /// 收成细条了吗（**细条不是消失**：待批还在，点一下再展开）
  bool collapsed = false;

  /// 正在提交的那一张的 id（两枚按钮同时禁用，防连点出两次决定）。空串 = 没有人在飞。
  ///
  /// 为什么是**一张**而不是每张一个开关：服务端那边 `grant-already-decided` 是按单号拦的，
  /// 而两枚按钮在**同一张卡**上——同一刻只可能有一个决定在飞。多张卡各飞一条也不会更糟，
  /// 但"哪一张在飞"只需要记住一个，判据越少越不容易错。
  String busyId = '';

  /// 提交失败的原因（按单号）：**卡留在原地**，原因写在卡里（不弹窗、不静默吞掉）。
  final Map<String, String> failures = <String, String>{};

  /// 驳回理由的输入框：按单号存（详情弹窗关掉再开，人打了一半的理由还在）。
  ///
  /// 与扩展页 `grantReasons` 同一条理由：那张卡是**同一张**（[GrantPendingCard]），
  /// 控制器必须由外面持有，否则每 10 秒一次重画就把它清空一次。
  final Map<String, TextEditingController> reasonControllers = <String, TextEditingController>{};

  Timer? _collapseTimer;

  /// 上一份待批清单的 id 集合：用来分辨"**新来了一张**"与"批掉了一张"。
  ///
  /// 这个分辨是体验上的关键：新来一张 ⇒ 展开 + 重新计 15 秒（它是通知，得让人看见）；
  /// 批掉一张 ⇒ **不动**当前的开合状态（人刚点完，屏幕不该跳一下）。
  Set<String> _knownIds = <String>{};

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChanged);
    // 进界面时就已经挂着一张单子是常态（她昨天晚上递的，人今早才开界面）
    _knownIds = _idsOf(widget.state.pendingGrants);
    if (_knownIds.isNotEmpty) _armCollapse();
  }

  @override
  void didUpdateWidget(GrantInboxHost old) {
    super.didUpdateWidget(old);
    if (old.state != widget.state) {
      old.state.removeListener(_onStateChanged);
      widget.state.addListener(_onStateChanged);
      _onStateChanged();
    }
  }

  @override
  void dispose() {
    _collapseTimer?.cancel();
    _collapseTimer = null;
    widget.state.removeListener(_onStateChanged);
    for (final controller in reasonControllers.values) {
      controller.dispose();
    }
    reasonControllers.clear();
    super.dispose();
  }

  static Set<String> _idsOf(List<Map<String, dynamic>> pending) =>
      <String>{for (final grant in pending) '${grant['id'] ?? ''}'};

  void _onStateChanged() {
    if (!mounted) return;
    final next = _idsOf(widget.state.pendingGrants);
    final fresh = next.difference(_knownIds);
    final changed = fresh.isNotEmpty || next.length != _knownIds.length;
    _knownIds = next;
    if (next.isEmpty) {
      // 全批完了：细条也收掉（留着一条"0 条待批"是纯噪音），失败记录跟着作废
      _collapseTimer?.cancel();
      _collapseTimer = null;
      collapsed = false;
      failures.clear();
      busyId = '';
    } else if (fresh.isNotEmpty) {
      // **新来了一张**：展开给人看，并重新计 15 秒
      collapsed = false;
      _armCollapse();
    } else if (changed) {
      // 批掉/驳回掉一张：清掉它的失败记录，但**不动**开合状态
      failures.clear();
    }
    setState(() {});
  }

  /// 起一次"15 秒后收起"的计时（重复调用 = 重新计）。
  void _armCollapse() {
    _collapseTimer?.cancel();
    _collapseTimer = null;
    if (widget.state.pendingGrants.isEmpty) return;
    _collapseTimer = Timer(widget.collapseAfter, () {
      if (!mounted) return;
      // 正在提交就先别收：人刚点了按钮，卡在他手上缩成一条线会像是"点丢了"
      if (busyId.isNotEmpty) {
        _armCollapse();
        return;
      }
      setState(() => collapsed = true);
    });
  }

  /// 人点了细条：展开，并重新计 15 秒（不然刚展开就又被收回去）
  void _expand() {
    setState(() => collapsed = false);
    _armCollapse();
  }

  void _collapse() {
    _collapseTimer?.cancel();
    _collapseTimer = null;
    setState(() => collapsed = true);
  }

  /// 去扩展页（溢出那一行与空态的去处）。
  ///
  /// 只切页，**不动窗口**：卡片这一层从不显式显示/聚焦窗口（见文件头 ①）。
  void _openExtensions() => widget.state.setPage('extensions');

  /// 用户的那一次点头或摇头（走 [AppState.decideGrant]，与扩展页同一个端点、同一套判据）。
  ///
  /// 两种"失败"分开对待：
  ///   · **没记上**（请求失败 / 服务端拒收）⇒ 原因写在卡里、卡留着，人再点一次就行；
  ///   · **记上了但落地没成功**（`exec.state != 'ok'`）⇒ 结局已经落定（卡会消失），
  ///     所以**必须**用 toast 把"批了但没装成"说出来——不说不等于成功。
  Future<void> _decide(Map<String, dynamic> grant, {required bool approve}) async {
    final id = '${grant['id'] ?? ''}';
    // 防连点：一张在飞的时候，第二次点击直接让位（服务端那边同样会拦，两条都要有）
    if (id.isEmpty || busyId.isNotEmpty) return;
    final s = IrmiaStrings.read(context);
    setState(() {
      busyId = id;
      failures.remove(id);
    });
    final reason = (reasonControllers[id]?.text ?? '').trim();
    final decision = await widget.state.decideGrant(id, approve: approve, reason: reason);
    if (!mounted) return;
    if (!decision.recorded) {
      setState(() {
        busyId = '';
        failures[id] = decision.error ?? s.extServerNoReason;
      });
      return;
    }
    setState(() {
      busyId = '';
      failures.remove(id);
    });
    final accepted = decision.outcome == 'rejected' || decision.execState == 'ok';
    final note = decision.outcome == 'rejected'
        ? s.extGrantRejectedToast(reason.isEmpty ? s.extNoReasonGiven : '')
        : decision.execState == 'ok'
            ? s.extGrantApprovedToast(decision.restartRequired ? s.extRestartSuffix : '')
            : s.extGrantApprovedFailedToast(
                decision.failure.isEmpty ? s.extServerNoReason : decision.failure);
    IrmiaToast.show(context, note, kind: accepted ? ToastKind.success : ToastKind.error);
    // 立刻重读一次（卡马上消失，不等 10 秒那一拍）
    await widget.state.refreshPendingGrants();
  }

  /// 「详情」：把**扩展页那张完整的卡**摆在弹窗里。
  ///
  /// 高风险那一支点「查看并批准」走的也是这条路——这是"不许一键批"的落地形态：
  /// 卡上有风险点、她写的理由、批准之后到底发生什么（装进技能根 / 移进回收站 / 写进配置），
  /// 而**批准按钮只在那张卡上**。
  ///
  /// ## 宽度为什么这样算（踩过一次）
  ///
  /// 那张完整卡底部有一行 `[驳回][批准] … [批准之后会发生什么]`，而最后那句是**长的**
  /// （技能装那支尤其长），它不会自己换行到按钮下面——窗口窄过它需要的那一点点，整行就
  /// 溢出成红条纹。所以：弹窗尽量宽（[kGrantInboxDetailsMaxWidth]），而卡片另有**下限**
  /// （[kGrantInboxDetailsMinWidth]）——窄到下限以下就**横向滚动**，不挤爆版面。
  Future<void> _openDetails(Map<String, dynamic> grant) async {
    final id = '${grant['id'] ?? ''}';
    final controller = reasonControllers.putIfAbsent(id, TextEditingController.new);
    final s = IrmiaStrings.read(context);
    final screen = MediaQuery.sizeOf(context).width;
    // 左右各留 24：弹窗不许顶到窗口边缘（那边还有一圈描边与阴影）
    final maxWidth = screen - Space.x6 * 2;
    final dialogWidth = maxWidth < kGrantInboxDetailsMaxWidth ? maxWidth : kGrantInboxDetailsMaxWidth;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => Dialog(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: dialogWidth, maxHeight: 720),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(Space.x4, Space.x3, Space.x1, Space.x2),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        s.grantInboxDetails,
                        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                      ),
                    ),
                    IconButton(
                      key: const ValueKey('grant-inbox-details-close'),
                      tooltip: s.grantInboxDetailsClose,
                      onPressed: () => Navigator.of(dialogContext).pop(),
                      icon: const Icon(Icons.close_rounded, size: 18),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: LayoutBuilder(builder: (context, constraints) {
                  final inner = constraints.maxWidth - Space.x4 * 2;
                  final cardWidth = inner < kGrantInboxDetailsMinWidth ? kGrantInboxDetailsMinWidth : inner;
                  return SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(Space.x4, 0, Space.x4, Space.x4),
                    child: SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: SizedBox(
                        width: cardWidth,
                        child: GrantPendingCard(
                          grant: grant,
                          reasonController: controller,
                          busy: busyId == id,
                          onApprove: () async {
                            await _decide(grant, approve: true);
                            // 用 dialogContext 自己的 mounted：这个回调跨过一次 await，
                            // 而"详情弹窗还开着吗"只有它知道（State.mounted 判的是宿主那一侧）
                            if (dialogContext.mounted) Navigator.of(dialogContext).pop();
                          },
                          onReject: () async {
                            await _decide(grant, approve: false);
                            if (dialogContext.mounted) Navigator.of(dialogContext).pop();
                          },
                        ),
                      ),
                    ),
                  );
                }),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pending = widget.state.pendingGrants;
    return Stack(
      children: [
        widget.child,
        // 右下角：**只在这一层**定位（卡自己不带任何绝对坐标，golden 才能单独拍它）
        Positioned(
          right: kGrantInboxInset,
          bottom: kGrantInboxInset,
          child: GrantInboxPanel(
            pending: pending,
            malformed: widget.state.malformedGrants,
            collapsed: collapsed,
            busyId: busyId,
            failures: failures,
            onApprove: (grant) => unawaited(_decide(grant, approve: true)),
            onReject: (grant) => unawaited(_decide(grant, approve: false)),
            onDetails: (grant) => unawaited(_openDetails(grant)),
            onExpand: _expand,
            onCollapse: _collapse,
            onOpenExtensions: _openExtensions,
          ),
        ),
      ],
    );
  }
}

/// 那一摞卡的**版式**（纯展示：没有定时器、没有请求，状态全在参数里）。
///
/// 抽出来有三个用处，三条都不是"为了好看"：
///   · 宿主只操心状态，版式可以**单独**交给用例与 golden（两张图拍的就是它）；
///   · 「无待批 ⇒ 什么都不画」只有一处判据（`count == 0` 那一行），不会出现"细条还在、
///     卡没了"的半截状态；
///   · 三张的截断与「还有 N 条待批」的口径也只有一处。
class GrantInboxPanel extends StatelessWidget {
  const GrantInboxPanel({
    super.key,
    required this.pending,
    required this.onApprove,
    required this.onReject,
    required this.onDetails,
    required this.onExpand,
    required this.onCollapse,
    required this.onOpenExtensions,
    this.collapsed = false,
    this.busyId = '',
    this.failures = const <String, String>{},
    this.malformed = const <Map<String, dynamic>>[],
  });

  /// 待批清单（**最新在最前**，顺序由 `pendingGrantsNewestFirst` 定）
  final List<Map<String, dynamic>> pending;

  /// **读不出来的申请单**（`/api/grants.malformed`，2026-10-22）。
  ///
  /// 它与 [pending] 是两条独立的判据：那一档没有可点的卡（`picked:false` + 解析不过），
  /// 绝不能被并进待批队列；但**也不许什么都不显示**——它是"人写了单子、框架一声不响"
  /// 那条缝的补丁（过去 `pending` 一空整块就 `SizedBox.shrink()`）。
  final List<Map<String, dynamic>> malformed;

  final void Function(Map<String, dynamic> grant) onApprove;
  final void Function(Map<String, dynamic> grant) onReject;
  final void Function(Map<String, dynamic> grant) onDetails;
  final VoidCallback onExpand;
  final VoidCallback onCollapse;
  final VoidCallback onOpenExtensions;

  /// 收成细条了（待批还在，点一下展开）
  final bool collapsed;

  /// 正在提交的那一张（两枚决策按钮都禁用）
  final String busyId;

  /// 提交失败的原因（按单号）
  final Map<String, String> failures;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    // 「一条待批都没有」不是"什么都不画"：读不出来的单子照样得说出来
    if (pending.isEmpty) {
      if (malformed.isEmpty) return const SizedBox.shrink();
      return SizedBox(width: kGrantInboxWidth, child: _unreadableBar(context, s));
    }
    if (collapsed) return _collapsedBar(context, s);
    final shown = pending.take(kGrantInboxMaxCards).toList();
    final hidden = pending.length - shown.length;
    return SizedBox(
      width: kGrantInboxWidth,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _header(context, s),
          // 有待批卡时也照样把"读不出来的那一张"说出来：两件事互不遮蔽
          if (malformed.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: Space.x2),
              child: _unreadableBar(context, s),
            ),
          for (final grant in shown)
            Padding(
              padding: const EdgeInsets.only(top: Space.x2),
              child: QuickGrantCard(
                key: ValueKey('grant-quick-${grant['id'] ?? ''}'),
                grant: grant,
                busy: busyId == '${grant['id'] ?? ''}',
                failure: failures['${grant['id'] ?? ''}'],
                onApprove: () => onApprove(grant),
                onReject: () => onReject(grant),
                onDetails: () => onDetails(grant),
              ),
            ),
          if (hidden > 0) _moreRow(context, s, hidden),
        ],
      ),
    );
  }

  /// 堆叠上面那一行：`待批 · N 条` + 收起（这一行是"这一摞是什么"的唯一标题）。
  Widget _header(BuildContext context, AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        const Icon(Icons.notifications_active_outlined, size: 14, color: IrmiaTheme.warn),
        const SizedBox(width: Space.x1),
        Text(
          s.grantInboxHeader(pending.length),
          style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant),
        ),
        const SizedBox(width: Space.x1),
        Tooltip(
          message: s.grantInboxCollapseTooltip,
          child: InkWell(
            key: const ValueKey('grant-inbox-collapse'),
            borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
            onTap: onCollapse,
            child: Padding(
              padding: const EdgeInsets.all(Space.x1),
              child: Icon(Icons.expand_more_rounded, size: 16, color: scheme.onSurfaceVariant),
            ),
          ),
        ),
      ],
    );
  }

  /// **「有一张单读不出来」**（2026-10-22）：唯一会在"一条待批都没有"时也画出来的那一行。
  ///
  /// 为什么它必须存在：读不出来的单子既没有 `grant/requested`（于是不进待批队列），
  /// 又解析不过（于是连卡都挂不出来）——过去 `pending` 一空整块就 `SizedBox.shrink()`，
  /// 人就永远看不见"有东西在等你"。这里只说两件事：**哪一张**、**为什么读不出来**
  /// （原因原样来自服务端 `grantFileProblems`，不译、不截断成"未知错误"）。
  ///
  /// 不给按钮：一张读不出来的单子没有可批的东西（点批准只会拿到一句错）。
  /// 想动手就去扩展页看她写的那份原文（`_openExtensions` 那条路）。
  Widget _unreadableBar(BuildContext context, AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    final first = malformed.first;
    final more = malformed.length > 1 ? s.grantUnreadableMore(malformed.length - 1) : '';
    return Container(
      key: const ValueKey('grant-inbox-unreadable'),
      padding: const EdgeInsets.all(Space.x3),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: IrmiaTheme.danger.withValues(alpha: 0.5)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.error_outline_rounded, size: 14, color: IrmiaTheme.danger),
              const SizedBox(width: Space.x1),
              Text(
                s.grantUnreadableTitle,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: IrmiaTheme.danger,
                ),
              ),
            ],
          ),
          const SizedBox(height: Space.x1),
          Text(
            '${s.grantUnreadableBody('${first['id'] ?? ''}', '${first['why'] ?? ''}')}$more',
            style: TextStyle(fontSize: 11.5, height: 1.4, color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  /// 收起之后的**细条**：`N 条待批`，点一下展开。
  ///
  /// 刻意做成"按内容量收窄"的一小条（不是整宽的条）：它停在右下角，越窄越不像一块挡板。
  Widget _collapsedBar(BuildContext context, AppStrings s) {    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.bottomRight,
      child: Material(
        color: scheme.surface,
        // 只给 shape（`Material` 不许同时给 shape 与 borderRadius）：细条也要有描边与阴影
        // ——它是"一张还在的纸"，不是浮在内容上的一行字
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        child: InkWell(
          key: const ValueKey('grant-inbox-collapsed'),
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          onTap: onExpand,
          child: Tooltip(
            message: s.grantInboxExpandTooltip,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: Space.x3, vertical: Space.x2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.pending_actions_outlined, size: 14, color: IrmiaTheme.warn),
                  const SizedBox(width: Space.x1),
                  Text(
                    s.grantInboxCollapsed(pending.length),
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(width: Space.x1),
                  Icon(Icons.expand_less_rounded, size: 14, color: scheme.onSurfaceVariant),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// 超过三张：`还有 N 条待批`（点它去扩展页——那里是能一次看完的地方）。
  Widget _moreRow(BuildContext context, AppStrings s, int hidden) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Tooltip(
        message: s.grantInboxOpenExtensions,
        child: InkWell(
          key: const ValueKey('grant-inbox-more'),
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          onTap: onOpenExtensions,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: Space.x1, vertical: Space.x1),
            child: Text(
              s.grantInboxMore(hidden),
              style: TextStyle(fontSize: 11.5, color: scheme.primary, fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ),
    );
  }
}

/// **一张**快速审批卡（`grant_inbox.dart` 的判据 + `AppStrings` 的字，这里只排版）。
///
/// 卡上只有四样东西，每一样都有"为什么必须有它"：
///   · **动作 + 名字**（`装一个技能：x` / `加一个 MCP 服务：y`）——人第一眼要知道"她想动什么"；
///   · **一行影响**——技能那两支必须出现「不会自动执行」（新手最怕的是"批了它就会跑"），
///     MCP 那两支给命令名（`命令：node …`），因为"它会拉起什么"是那一支的真正风险点；
///   · **来源**（「这份单子是她自己写的」）——这句话是防伪面的那一半：卡上的字是人写的，
///     内容是她写的；
///   · **三枚按钮**（批准 / 查看并批准 / 驳回 / 详情）。
class QuickGrantCard extends StatelessWidget {
  const QuickGrantCard({
    super.key,
    required this.grant,
    required this.onApprove,
    required this.onReject,
    required this.onDetails,
    this.busy = false,
    this.failure,
  });

  final Map<String, dynamic> grant;
  final VoidCallback onApprove;
  final VoidCallback onReject;
  final VoidCallback onDetails;

  /// 这一张正在提交（两枚决策按钮都禁用，且「批准」那颗显示「处理中…」）
  final bool busy;

  /// 上一次提交没记上的原因（**卡留着**，原因写在按钮上面那一行）
  final String? failure;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final s = IrmiaStrings.of(context);
    final ink = IrmiaInk.of(context);
    final id = '${grant['id'] ?? ''}';
    final risk = grantRiskOf(grant);
    final high = risk == GrantRisk.high;
    return Container(
      key: ValueKey('grant-inbox-card-$id'),
      // 一圈 16（原 12/8/8/8）：卡放大一档之后内边距跟着放大，字不再贴着描边
      padding: Space.padCard,
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  _actionOf(s, grant),
                  key: ValueKey('grant-inbox-title-$id'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  // 层次靠**字号与颜色**，不靠加粗：15 / w500 / 主文字色。
                  // 上一版这一行 + 下面那行影响 + 再下面那行来源**全是粗的**，三层一个重量，
                  // 于是"满屏粗体 = 没有层次"（用户 2026-10-21：「字体不要胡乱加粗」）。
                  // 这里**不许再回到 w700**，有断言钉着（`grant_inbox_overlay_test.dart` ①）。
                  style: TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w500,
                    height: 1.35,
                    color: ink.ink,
                  ),
                ),
              ),
              if (high) ...[
                const SizedBox(width: Space.x2),
                // 高风险徽章：颜色与「超时未答」同档（warn）——都是"别顺手点"的意思。
                // **它是这张卡上唯一一处该醒目的东西**：别的行靠字号与颜色分层，
                // 不许再用加粗或强调色来跟它抢（见上面那段与 [grantInboxSource] 那一行）。
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                  decoration: BoxDecoration(
                    color: IrmiaTheme.warn,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Text(
                    s.grantInboxHighRiskBadge,
                    style: const TextStyle(color: Colors.white, fontSize: 10.5),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: Space.x2),
          // 正文那一条（命令 / 那一行影响）：13 / w400 / 次要色，命令行换等宽字（见 [_bodyLine]）
          _bodyLine(id, _impactOf(s, grant), ink),
          const SizedBox(height: Space.x2),
          Text(
            s.grantInboxSource,
            key: ValueKey('grant-inbox-source-$id'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            // 卡上**最次要**的一行：12 / w400 / 更次要的 tertiary 色（`ink.faint`）。
            // 原来它是 11 + 与正文同一个颜色，跟上面两行挤成一团灰。
            style: TextStyle(fontSize: 12, height: 1.4, fontWeight: FontWeight.w400, color: ink.faint),
          ),
          if (failure != null && failure!.isNotEmpty) ...[
            const SizedBox(height: Space.x2),
            // 失败那一行用 danger 色：这一张**还在**，再点一次就行
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 1),
                  child: Icon(Icons.error_outline_rounded, size: 13, color: IrmiaTheme.danger),
                ),
                const SizedBox(width: Space.x1),
                Expanded(
                  // 服务端那几句是**人话**（"申请单 x 已经有结局了（approved，…）：同一个决定
                  // 只可能有一次终局…"），全摆出来会把卡撑成一整条——封三行，全文进 tooltip
                  child: Tooltip(
                    message: s.grantInboxFailed(failure!),
                    child: Text(
                      s.grantInboxFailed(failure!),
                      key: ValueKey('grant-inbox-failure-$id'),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 11, height: 1.45, color: IrmiaTheme.danger),
                    ),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: Space.x3),
          // 三枚按钮**右对齐成一组**，间距统一 12（原来是 [批准][驳回] … [详情]，
          // 中间塞了一个 Spacer ⇒ 驳回与详情之间空一格、两者还一个灰一个蓝，
          // 用户 2026-10-21 说的就是这两处"间距/视觉权重不一致"）。
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              // 高风险那一支的按钮文案**单独一句**（「查看并批准」）：它不是"批准"的装饰，
              // 而是"点了会先给你看详情"的承诺——而低风险那一支点了就生效。
              //
              // 底色取主题里**既有那一颗 primary**（`filledButtonTheme`；原来这里是
              // `FilledButton.tonal` 的浅蓝）——一张卡上一个主按钮就够了，另外两枚是文字按钮。
              FilledButton(
                key: ValueKey('grant-inbox-approve-$id'),
                onPressed: busy ? null : (high ? onDetails : onApprove),
                style: FilledButton.styleFrom(
                  // 水平 16 / 最小高 36（原 12 / 30）：36 才是"按得下去"的高度，
                  // 30 配 12 号的字看起来像一枚标签。三枚同高同档内边距（见 [kGrantInboxButtonHeight]）。
                  padding: const EdgeInsets.symmetric(horizontal: Space.x4),
                  minimumSize: const Size(0, kGrantInboxButtonHeight),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(
                  busy
                      ? s.grantInboxWorking
                      : (high ? s.grantInboxApproveHighRisk : s.grantInboxApprove),
                  style: const TextStyle(fontSize: 12),
                ),
              ),
              const SizedBox(width: Space.x3),
              // 「驳回」与「详情」：两枚**同权重**的文字按钮（同一个灰、同一档内边距）。
              // 详情原来走主题的 primary 蓝 ⇒ 与驳回一比就是"一个重一个轻"；
              // 而这一张卡上只留一个强调（primary 那一颗 + 高风险徽章），别再加第二个蓝。
              TextButton(
                key: ValueKey('grant-inbox-reject-$id'),
                onPressed: busy ? null : onReject,
                style: TextButton.styleFrom(
                  foregroundColor: ink.secondary,
                  padding: const EdgeInsets.symmetric(horizontal: Space.x4),
                  minimumSize: const Size(0, kGrantInboxButtonHeight),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(s.grantInboxReject, style: const TextStyle(fontSize: 12)),
              ),
              const SizedBox(width: Space.x3),
              TextButton(
                key: ValueKey('grant-inbox-details-$id'),
                onPressed: onDetails,
                style: TextButton.styleFrom(
                  foregroundColor: ink.secondary,
                  padding: const EdgeInsets.symmetric(horizontal: Space.x4),
                  minimumSize: const Size(0, kGrantInboxButtonHeight),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(s.grantInboxDetails, style: const TextStyle(fontSize: 12)),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 卡上正文那一条（「命令：…」或「不会自动执行…」）。
  ///
  /// 两种文案**只差字形**，字号/字重/颜色三样完全一致（13 / w400 / 次要色）：
  /// 这样同一摞卡里"命令那一行"不会比"影响那一行"看起来更响（原来整段是 w600 的正文色）。
  ///
  /// 命令行另加两件事，都是为可读性、不是为好看：
  ///   · **等宽字**（[Type.mono]）——路径里的 `\`、`@`、`.` 在比例字下对不齐，一眼看不出
  ///     哪一段是目录、哪一段是可执行文件；
  ///   · **优先在 `\` 处折行**（见 [_breakable]）——不然 388 宽放不下时它会从路径中间硬切。
  Widget _bodyLine(String id, _Impact impact, IrmiaInk ink) {
    final style = impact.isCommand
        ? Type.mono(ink.secondary, size: 13, weight: FontWeight.w400)
        : TextStyle(fontSize: 13, height: 1.5, fontWeight: FontWeight.w400, color: ink.secondary);
    return Tooltip(
      // 全文进 tooltip：正常一条 `C:\…\@playwright\mcp\cli.js` 折两行就够，
      // 超过 [kGrantInboxBodyMaxLines] 才省略——省略的那部分在这里，鼠标一悬停就看得见。
      message: impact.text,
      child: Text(
        impact.isCommand ? _breakable(impact.text) : impact.text,
        key: ValueKey('grant-inbox-impact-$id'),
        maxLines: kGrantInboxBodyMaxLines,
        overflow: TextOverflow.ellipsis,
        style: style,
      ),
    );
  }
}

/// 卡首那一句：「装 / 加 / 删 + 名字」。
///
/// 认不出的 kind 走兜底句（不猜它是加还是删——猜错的代价是"批了一个以为不是它的东西"）。
String _actionOf(AppStrings s, Map<String, dynamic> grant) {
  final name = '${grant['name'] ?? ''}'.trim();
  final label = name.isEmpty ? '${grant['id'] ?? ''}' : name;
  return switch ('${grant['kind'] ?? ''}') {
    'mcp-add' => s.grantInboxActionMcpAdd(label),
    'mcp-remove' => s.grantInboxActionMcpRemove(label),
    'skill-install' => s.grantInboxActionSkillInstall(label),
    'skill-remove' => s.grantInboxActionSkillRemove(label),
    _ => s.grantInboxActionUnknown(label),
  };
}

/// 卡上正文那一条的两种排法：**普通说明**与**命令行**（后者换等宽字、优先在 `\` 处折行）。
///
/// 为什么把它标出来而不是让下游自己认 kind：判据只有 `_impactOf` 一处（"这条文案是不是一条
/// 命令行"），卡片只管按结果排版——两处各认一次，迟早一处认成命令、一处认成说明。
typedef _Impact = ({String text, bool isCommand});

/// 卡上那一行**影响**（判据照 `grant_inbox.dart` 那张表，文案全部来自 `AppStrings`）。
///
/// 技能两支必带「不会自动执行」（`grantInboxRiskSkillInstall` / `grantInboxRiskSkillScripts`
/// 里都写了）：新手对这一族最大的误会是"批准 = 它马上开始跑"。
/// MCP 两支给命令名（`grantInboxCommand`）——"它要拉起什么进程"是那一支的真风险；
/// 命令没写时才退回"它会拉起一个本机进程"那句。
_Impact _impactOf(AppStrings s, Map<String, dynamic> grant) {
  switch ('${grant['kind'] ?? ''}') {
    case 'skill-install':
      final scripts = _stringList(grant['scriptNames']).length;
      return (
        text: scripts > 0 ? s.grantInboxRiskSkillScripts(scripts) : s.grantInboxRiskSkillInstall,
        isCommand: false,
      );
    case 'skill-remove':
      return (text: s.grantInboxRiskSkillRemove, isCommand: false);
    case 'mcp-add':
      final command = _commandLineOf(grant);
      return command.isEmpty
          ? (text: s.grantInboxRiskMcpAdd, isCommand: false)
          : (text: s.grantInboxCommand(command), isCommand: true);
    case 'mcp-remove':
      return (text: s.grantInboxRiskMcpRemove, isCommand: false);
    default:
      return (text: s.grantInboxRiskUnknown, isCommand: false);
  }
}

/// 零宽空格：告诉排版器"这里可以断"，但它自己**不占宽度、也看不见**。
const String _zeroWidthSpace = '\u200B';

/// 让一条路径**优先在 `\` 处折行**（只影响显示，不进 tooltip、不进断言比对）。
///
/// 为什么需要它：Flutter 只在词边界断行，而 `C:\Users\<用户名>\…\@playwright\mcp\cli.js` 整个是一个
/// "词"——放不下时它就在字符之间硬切（用户截图里那一行正是 `…\@play` / `wright\mcp\cli.js`，
/// 一个目录名被劈成两半，读起来最费劲的就是这种断法）。在每个 `\` 后面插一个 [U+200B]，
/// 断点就落回目录边界上；没有 `\` 的文本原样返回（`replaceAll` 一个字都不改）。
String _breakable(String text) => text.replaceAll(r'\', '\\$_zeroWidthSpace');

/// `command` + `args` 拼成一行（与服务端 / 扩展页同一个形状：空格分列，不加引号）
String _commandLineOf(Map<String, dynamic> grant) {
  final parts = <String>[
    '${grant['command'] ?? ''}'.trim(),
    ..._stringList(grant['args']).map((item) => item.trim()),
  ]..removeWhere((item) => item.isEmpty);
  return parts.join(' ');
}

/// 响应里的一格字符串数组（缺字段 / 形状不对都当空——界面不猜）
List<String> _stringList(Object? raw) =>
    raw is List ? <String>[for (final item in raw) '$item'] : const <String>[];
