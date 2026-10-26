// TODO(i18n): 本文件还有 3 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/home.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';

import 'package:flutter/material.dart';

import 'app.dart';
import 'theme.dart';
import 'ui_state.dart';
// 主界面顶部那条"有新版本"提醒（一次性可关；required 不可关。文案在 i18n，数据在 AppState）
import 'update_check.dart';
// 顶部第二条细带："有请求等久了"时出现（说清在等哪一条 + 一颗「重试」）
import 'wait_banner.dart';

/// 侧栏那条**整列对齐基线**（用户 2026-10-04 的截图意见："品牌名太贴边了"＋
/// "导航项要和品牌名对齐"）。
///
/// 列里所有图标/标识的左边缘都落在这一条竖线上：
///
///   品牌名          = [_sideInset]                      （那枚图案撤掉之后，名字自己就是基准）
///   一级导航项的图标 = [_sideInset] + 0                  （ListView 不再自己加内边距）
///   二级导航项的图标 = [_sideInset] + 30                 （_NavItem 的 indented 档）
///
/// 为什么基准取**图标**那一列、而不是"让导航文字去对品牌名"：导航行里图标在文字左边，
/// 文字若压到 22 上，图标就得落在侧栏外（负坐标）。图标是一条实打实的左边线、
/// 文字是它的下游，所以整列以图标对齐，品牌名跟着它对——这是能让两者落在同一条竖线上
/// 的唯一一种摆法。谁改 [_sideInset] 都是一起动，不会再错位。
const double _sideInset = 22;

/// 二级项的额外缩进（照 _NavItem.indented 的 18 + 图标 17 的那一档观感）
const double _navIndent = 30;

class HomeShell extends StatelessWidget {
  const HomeShell({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final brightness = Theme.of(context).brightness;

    return Scaffold(
      body: Row(
        children: [
          Container(
            width: 220,
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              border: Border(right: BorderSide(color: scheme.outlineVariant)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Brand(state: state),
                const SizedBox(height: 8),
                Expanded(
                  child: ListView(
                    // 不再自己加左右内边距：整列的基准在 _sideInset 那一处定，
                    // 这里再加一层就等于把导航项从基线上推走。
                    padding: const EdgeInsets.symmetric(horizontal: _sideInset),
                    children: [
                      for (final page in navPages)
                        _NavItem(
                          // 定位件：侧栏那一项自己的名字。页面上同名的文字不止一处
                          // （一级导航项 + 页头标题），用例要的是"侧栏里那一项"——
                          // 按 key 找，不按文字猜。
                          key: ValueKey('nav-${page.id}'),
                          icon: page.icon,
                          activeIcon: page.activeIcon,
                          label: page.label,
                          selected: state.pageId == page.id,
                          badge: _badgeOf(state, page),
                          onTap: () => state.setPage(page.id),
                        ),
                    ],
                  ),
                ),
                const Divider(height: 1),
                Padding(
                  padding: const EdgeInsets.fromLTRB(_sideInset, 10, _sideInset, 10),
                  child: _MoreGroup(state: state),
                ),
              ],
            ),
          ),
          Expanded(
            child: Container(
              decoration: IrmiaTheme.dawn(brightness),
              child: Column(
                children: [
                  // 主界面顶部那条提示（2026-10-22）：有新版本时出现，占满内容区宽度、
                  // 不压侧栏。`required` 时没有 ×，文案说"低于最低可用版本，请升级"。
                  UpdateBanner(
                    info: state.updateInfo,
                    dismissedVersion: state.updateDismissedVersion,
                    onDismiss: () => unawaited(state.dismissUpdateBanner()),
                  ),
                  // 第二条细带（2026-10-24）：**有请求等久了**才出现，说清"在等哪一条、
                  // 已等多久"，右端那颗「重试」把这一页整页重挂。平时零高度，不占版面。
                  // 它挂在页面上方而不是页里，是为了"哪一页都看得见"——卡死时人可能已经
                  // 切到别的页去了（见 wait_banner.dart 的文件头）。
                  WaitBanner(state: state),
                  Expanded(child: _PageHost(state: state)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 徽章规则：待确认项只挂在日志页（一级与二级共用同一条判定）；
/// **她在问**只挂在聊天页——卡是顶层的，被人用「稍后」收起来之后，
/// 至少还看得见"还有几条没答"（不然收起就等于丢掉，而设计里不许框架替人做这个决定）。
///
/// **待批**挂在扩展页（2026-10-21）：右下角那张快速审批卡 15 秒后会收成细条，
/// 人把它收起来之后得有第二处痕迹——这个角标就是那一处（0 时不显示，不摆一个「0」）。
int? _badgeOf(AppState state, PageEntry page) {
  if (page.id == 'logs' && state.needsReview > 0) return state.needsReview;
  if (page.id == 'chat' && state.askTotal > 0) return state.askTotal;
  if (page.id == 'extensions' && state.pendingGrantCount > 0) return state.pendingGrantCount;
  return null;
}

class _Brand extends StatelessWidget {
  const _Brand({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      // 左边距走整列那条基线（原来 14 是配着图案给的，图案撤掉之后 14 就显得贴边了）
      padding: const EdgeInsets.fromLTRB(_sideInset, 16, _sideInset, 0),
      child: Container(
        padding: const EdgeInsets.only(bottom: 14),
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
        ),
        child: Row(
          children: [
            // 品牌区**不放图案**（用户看过之后定的：干脆去掉）。只留她的名字与状态点，
            // 名字的左边缘落在 _sideInset 那条基线上，与下面所有导航项的图标对齐。
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // 品牌区显示的是**她的名字**（人格资产 IDENTITY.md 的「名字：」那一行），
                  // 不再是写死的字面量：那是这次要修的毛病本身——换个人装这个框架，
                  // 他的 agent 不叫伊尔弥亚。
                  //
                  // 读不到名字时显示产品名的短写（`Irmia Agent`，见 her_name.dart）：
                  // 这是**常驻显示**的位置，宁可显示一个明确不是名字的东西，也不能空着一块
                  // （人一进界面会以为界面坏了），更不能猜一个像名字的词。
                  // 名字最长 24 字（her_name.dart 的上限），这里允许折行一次；
                  // 更长的由输入框与服务端两头拦住。
                  Text(
                    state.herBrandLabel,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 14.5, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 3),
                  Row(
                    children: [
                      BreathDot(kind: state.dotKind, size: 7),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          // 左上这一行字是**唯一**换说法的地方（用户 2026-10-16 ①：
                          // 这里原来跟着服务端的 `stateText` 写「Agent 正在值守」，
                          // 而她在跑 turn 的时候那句话要改成「思考中」）。
                          // 判据不在这一行：`stateTextForBrand` 只在 `thinking` 为真时换词，
                          // 而 `thinking` 来自服务端同一个响应里的 `openTurn` + `state`
                          // （见 AppState 的注释）。别处（总览页大卡、设置页协议卡）照旧
                          // 显示服务端的原话——那是"当刻在干什么"的正式说法，不该被这里带偏。
                          state.stateTextForBrand,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 底部「更多」折叠组：日志与设置收在这里；二级项选中时组标题同样高亮并自动展开。
/// 展开态写进状态文件（照 AstrBot VerticalSidebar 的 sidebar_openedItems）：重启后
/// 保持用户上次的选择；当前页在二级里时以选中态为准，不读文件。
class _MoreGroup extends StatefulWidget {
  const _MoreGroup({required this.state});
  final AppState state;

  @override
  State<_MoreGroup> createState() => _MoreGroupState();
}

class _MoreGroupState extends State<_MoreGroup> {
  /// 展开态在 ui-state.json 里的键名
  static const _openFlag = 'moreGroupOpen';

  bool open = false;

  /// 当前页是否落在二级里
  bool get _holdsSelection => morePages.any((page) => page.id == widget.state.pageId);

  /// 折叠时把二级的待确认项汇总到组标题上
  int get _collapsedBadge {
    var total = 0;
    for (final page in morePages) {
      total += _badgeOf(widget.state, page) ?? 0;
    }
    return total;
  }

  @override
  void initState() {
    super.initState();
    open = _holdsSelection;
    unawaited(_restoreOpen());
  }

  /// 恢复上次的展开态；读不到就保持折叠（失败静默在 ui_state 里）
  Future<void> _restoreOpen() async {
    if (open) return;
    // 三态里的"未知"（文件不在/坏了）当作没展开：折叠是安全的一侧
    final saved = await loadFlag(_openFlag);
    if (!mounted || open || saved != true) return;
    setState(() => open = true);
  }

  /// 手动开合：落盘，写不进去也不影响本次会话内的展开态
  void _toggle() {
    final next = !open;
    setState(() => open = next);
    unawaited(saveFlag(_openFlag, next));
  }

  @override
  void didUpdateWidget(_MoreGroup old) {
    super.didUpdateWidget(old);
    // 从别处切进二级页时展开，避免「当前页是二级却看不见」
    if (_holdsSelection) open = true;
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final collapsedBadge = _collapsedBadge;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _NavItem(
          icon: Icons.more_horiz_rounded,
          activeIcon: Icons.more_horiz_rounded,
          label: '更多',
          selected: _holdsSelection,
          badge: open || collapsedBadge == 0 ? null : collapsedBadge,
          trailing: AnimatedRotation(
            turns: open ? 0.5 : 0,
            duration: IrmiaTheme.durPage,
            child: Icon(
              Icons.expand_more_rounded,
              size: 18,
              color: _holdsSelection ? scheme.primary : scheme.onSurfaceVariant,
            ),
          ),
          onTap: _toggle,
        ),
        // 展开/收合平滑过渡：收合时为零高度
        AnimatedSize(
          duration: IrmiaTheme.durPage,
          curve: Curves.easeOut,
          alignment: Alignment.topCenter,
          child: open
              ? Column(
                  children: [
                    for (final page in morePages)
                      _NavItem(
                        icon: page.icon,
                        activeIcon: page.activeIcon,
                        label: page.label,
                        selected: widget.state.pageId == page.id,
                        badge: _badgeOf(widget.state, page),
                        indented: true,
                        onTap: () => widget.state.setPage(page.id),
                      ),
                  ],
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }
}

class _NavItem extends StatelessWidget {
  const _NavItem({
    super.key,
    required this.icon,
    required this.activeIcon,
    required this.label,
    required this.selected,
    required this.onTap,
    this.badge,
    this.trailing,
    this.indented = false,
  });

  final IconData icon;
  final IconData activeIcon;
  final String label;
  final bool selected;
  final VoidCallback onTap;
  final int? badge;
  final Widget? trailing;

  /// 二级项：右移一档、字号收小
  final bool indented;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // **回退**：选中态曾经被换成主题 token（`navSelectedFill/On` = secondaryContainer 一族），
    // 亮主题下原来是 primary 蓝的字也跟着变了。用户 2026-10-05 圈的范围只有气泡与发送键
    // （"改其他的干嘛"），所以这里回到原样：底 surfaceContainerHighest、字与图标 primary。
    // 暗主题下唯一新加的东西是气泡与发送键那两圈白描边，见 theme.dart 的 IrmiaDarkPair。
    final fill = selected ? scheme.surfaceContainerHighest : Colors.transparent;
    final tone = selected ? scheme.primary : scheme.onSurface;
    final iconTone = selected ? scheme.primary : scheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Material(
        color: fill,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onTap,
          child: Padding(
            // 一级项左边距写 0：外层的 ListView 已经把它推到 [_sideInset] 那条基线上了。
            // 二级项在此基础上再右移 [_navIndent]（图标与文字都跟着移，间距不变）。
            padding: EdgeInsets.symmetric(
              horizontal: indented ? _navIndent : 0,
              vertical: indented ? 7 : 9,
            ),
            child: Row(
              children: [
                Icon(
                  selected ? activeIcon : icon,
                  size: indented ? 17 : 19,
                  color: iconTone,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    label,
                    style: TextStyle(
                      fontSize: indented ? 12.8 : 13.5,
                      color: tone,
                      fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
                if (badge != null && badge! > 0)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: IrmiaTheme.warn,
                      borderRadius: BorderRadius.circular(9),
                    ),
                    child: Text('$badge',
                        style: const TextStyle(color: Colors.white, fontSize: 11)),
                  ),
                if (trailing != null) ...[
                  const SizedBox(width: 4),
                  trailing!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 页面宿主：按当前页 id 取注册表条目渲染，切换 180ms 淡入（MaidKit 曲线）
class _PageHost extends StatelessWidget {
  const _PageHost({required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    // 未知 id 兜底到首页，避免切出空白
    final entry = pageEntryById(state.pageId) ?? navPages.first;
    return AnimatedSwitcher(
      duration: IrmiaTheme.durPage,
      switchInCurve: Curves.easeOut,
      // key 里带**重挂计数**（`AppState.pageEpoch`）：那颗「重试」一加一，这一页就整页
      // 重建（重新 initState ⇒ 重新取数）。没有它的话，"页面卡在自己的 loading 里"
      // 从外面没有任何办法 —— 见 wait_banner.dart 与 `AppState.reloadCurrentPage`。
      child: KeyedSubtree(
        key: ValueKey('${entry.id}#${state.pageEpoch}'),
        child: entry.builder(state),
      ),
    );
  }
}

/// 未实现页的占位说明
class PlaceholderPage extends StatelessWidget {
  const PlaceholderPage({super.key, required this.title});
  final String title;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(26, 22, 26, 0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text('该页面的原生界面尚未实现。',
                  style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
            ],
          ),
        ),
        Expanded(
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const HerFace(size: 40, radius: 13),
                const SizedBox(height: 14),
                Text('界面尚未实现。功能由服务端与 CLI 提供。',
                    style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13)),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
