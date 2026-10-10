import 'dart:async';

import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import '../ui_kit.dart';
import '../ui_state.dart';
import 'page_chrome.dart';

part 'extensions_kit.dart';

/// 扩展页 —— 与 Web 端 #/extensions 同构，版式照 [ChannelsPage]：
/// 左侧 260px 四项（技能 / MCP / 内置工具 / Hooks）+ 右侧详情工作台；
/// 窄窗（<900px）降级为「列表 ↔ 详情」单独视图，详情带「← 列表」返回入口。
///
/// **为什么从"上面一排 tab、下面一列卡片"改成这个形状**：那排 tab 把四类东西压成三个
/// （MCP 与工具注册表挤在「工具」里），而它们的管理动作完全不同——技能要过信任门、
/// MCP 要拉进程、工具只是开关、Hooks 是"谁能改我"。左列表 + 右详情能让每一类**各占一整块**
/// 写自己的引导、表单与说明，而不是在同一列卡片里互相挤。
///
/// 数据只读端点四个：GET /api/skills · /api/mcp · /api/tools · /api/hooks。
/// 写动作六条命令（都带 X-Confirm，见 server.ts 的 CONFIRM_PHRASES）：
///   skill-confirm（信任门放行）· skill-ignore（本机备忘，落 data/skills-ignored.json）·
///   skill-create（新建骨架）· mcp-save / mcp-remove（写 config.mcp.servers）· mcp-test（真起进程试）·
///   hook-save / hook-remove（写 data/hooks.json）
///
/// 四条硬约束（沿袭既有手法）：
///   · 行尾动作走 icon-only 28×28 按钮（照 AstrBot `ConversationPage.vue:170-181` 的 actions 列）；
///   · 加载走顶部 2px 进度线，不用居中转圈（docs/astrbot-ux-interaction.md §五）；
///   · 「数据读取失败 / 响应格式无法识别 / 加载中」三态一个都不少（ui_kit 的 StateBlock）；
///   · Hooks 那一份配置对 agent **只读**（protectedHookPaths）：界面上只能由人写，
///     所以它的引导条不是在说"怎么改"，而是在说"这条线画在哪"。
class ExtensionsPage extends StatefulWidget {
  const ExtensionsPage({super.key, required this.state});
  final AppState state;

  @override
  State<ExtensionsPage> createState() => _ExtensionsPageState();
}

/// 四项的唯一清单（左列表与详情都照它摆）
const _sections = <_SectionDef>[
  (
    id: 'skills',
    title: '技能',
    icon: Icons.auto_awesome_outlined,
    // 「在这里能做什么」一句话：它同时是详情页的开场白
    blurb: '任务知识包：一份 SKILL.md 说明什么时候用它、怎么用',
  ),
  (
    id: 'mcp',
    title: 'MCP',
    icon: Icons.hub_outlined,
    blurb: '外部工具服务：按需拉起一个可执行程序，工具都从内置的 mcp 工具走',
  ),
  (
    id: 'tools',
    title: '内置工具',
    icon: Icons.build_outlined,
    blurb: '随程序一起来的工具：按组开关，关掉即从她的清单里拿掉',
  ),
  (
    id: 'hooks',
    title: 'Hooks',
    icon: Icons.bolt_outlined,
    blurb: '执行点钩子：PreToolUse / PostToolUse / Wake 三处可插入外部命令',
  ),
];

/// section id → 它要读的端点（进度线、轮询、错误态都按它算）
///
/// `mcp` 读两个：`/api/mcp`（声明 + 运行期）与 `/api/grants`（她的**申请单**，2026-10-11 加）。
/// 待批那一段必须在 MCP 这一屏里，因为"加/删一个 server"正是这张单子要做的事；
/// 而它单独一个端点（而不是并进 `/api/mcp`）的理由：人点完批准之后，那一段要**立刻**消失，
/// 不能等下一次轮询（`/api/grants` 每次现读，界面在决定之后单独再拉一次）。
const _sectionKeys = <String, List<String>>{
  'skills': ['skills'],
  'mcp': ['mcp', 'grants'],
  'tools': ['tools'],
  'hooks': ['hooks'],
};

const _keys = ['skills', 'mcp', 'grants', 'tools', 'hooks'];

/// 列表宽度与窄窗阈值：与消息适配器页同宽（两页并排切过去时不该跳一下）
const _sidebarWidth = 260.0;
const _wideBreakpoint = 900.0;

/// 「测试连接」超时的界面默认值：30 秒。
///
/// 为什么不跟服务端那个 8 秒的默认值（`MCP_TEST_TIMEOUT_DEFAULT_MS`）一致：
/// 两者的场景不同。服务端那个是**没给 timeoutMs 时的兜底**（宁可快些失败），
/// 这里的默认值是给人按的——首次 `npx -y <包>` 要拉包，实测 30s+ 是常态，
/// 而"测试连接超时"会被误读成"这个服务不可用"（实测被用户点名）。
/// 服务端仍会把入参夹在 500ms..60s 之间，所以这个值是可以放心直接发过去的。
const _mcpTestTimeoutDefaultMs = 30_000;

class _ExtensionsPageState extends State<ExtensionsPage> {
  /// 选中的分区 id：四项在客户端定义，首项恒有效
  String selectedId = _sections.first.id;

  /// 窄窗视图位：false = 列表，true = 详情（宽窗两栏并排，这个位不参与）
  bool narrowDetail = false;

  /// 端点视图与三态：`firstLoad` 只为「首读还没内容」服务（顶部进度线在跑时不摆错误占位）
  final data = <String, Map<String, dynamic>?>{};
  final errors = <String, String?>{};
  final loading = <String, bool>{};
  bool firstLoad = true;

  Timer? poll;

  /// 展开 / 折叠的服务名（MCP 每个服务各自展开——用户点名要这个）
  final expandedServers = <String>{};

  /// 正在「测试连接」的服务名：那一下要真起一个进程，装不下并发点两下
  final mcpTesting = <String>{};

  /// 驳回理由的输入框，**按申请单号存**（2026-10-11 加）。
  ///
  /// 为什么由页面持有而不是卡片自己 `TextEditingController`：待批那一段每 20 秒重读一次
  /// （`_reloadSection`），卡片会被整个重建——控制器长在卡片里的话，人打了一半的理由
  /// 会在轮询那一拍被清空。放在这里之后，重读只是重画那一行。
  final grantReasons = <String, TextEditingController>{};

  /// 正在提交的那一张申请单 id（两枚按钮都禁用它，防连点出两次决定）
  String? grantBusy;

  /// 正在整组开/关的工具组 id（一行在忙时其余开关暂不可点，避免连点出一串并发写）
  String? busyGroup;

  /// 本机忽略集的**兜底副本**：服务端 `skills-ignored.json` 是唯一真相源，
  /// 这份只在响应里还没有 `ignored` 字段（旧服务端）时用，保证界面不因字段缺失而错分三段。
  final ignoredFallback = <String>{};

  ColorScheme get cs => Theme.of(context).colorScheme;

  @override
  void initState() {
    super.initState();
    for (final key in _keys) {
      data[key] = null;
      errors[key] = null;
      loading[key] = true;
    }
    widget.state.addListener(_onStateChange);
    unawaited(loadAll());
    // 从别处（建议卡的 `goto-tools`）跳进来时，直接落在要看的那个分组上
    _applyPendingSection();
    // 信任门与 MCP 状态会随 agent 侧写入变化：低频轮询，只刷当前分区
    poll = Timer.periodic(const Duration(seconds: 20), (_) => _reloadSection());
  }

  @override
  void dispose() {
    poll?.cancel();
    widget.state.removeListener(_onStateChange);
    // 驳回理由那几个控制器（见 `grantReasons` 的注释）：页面走了就一起放掉
    for (final controller in grantReasons.values) {
      controller.dispose();
    }
    super.dispose();
  }

  /// 消费 AppState 里的落点提示（`setPage(id, section: ...)`）：**取走即清**，
  /// 所以左侧导航进来时不会有第二次跳转。
  void _applyPendingSection() {
    final section = widget.state.takeSectionFor('extensions');
    if (section == null || !mounted) return;
    if (!_sections.any((def) => def.id == section)) return; // 认不出的段就当没这条提示
    _select(section);
  }

  void _onStateChange() {
    _applyPendingSection();
    if (widget.state.online && _sectionKeys[selectedId]!.any((key) => errors[key] != null)) {
      _reloadSection();
    }
  }

  void _reloadSection() {
    for (final key in _sectionKeys[selectedId]!) {
      unawaited(load(key));
    }
  }

  /// 读一个端点。`silent` 为真时不把 loading 立起来（轮询重读不该让进度线闪一下）。
  Future<void> load(String key, {bool silent = false, bool rescan = false}) async {
    if (!silent && mounted) setState(() => loading[key] = true);
    try {
      final res = await widget.state.api.get(rescan && key == 'skills' ? '/api/skills?rescan=1' : '/api/$key');
      if (!mounted) return;
      final view = res is Map<String, dynamic> ? res : null;
      setState(() {
        loading[key] = false;
        data[key] = view;
        errors[key] = view == null ? '响应格式无法识别' : null;
      });
      if (key == 'skills' && view != null) _syncIgnoredFallback(view);
    } catch (err) {
      if (!mounted) return;
      setState(() {
        loading[key] = false;
        errors[key] = err.toString();
      });
    }
  }

  Future<void> loadAll() async {
    await Future.wait(_keys.map((key) => load(key)));
    if (mounted) setState(() => firstLoad = false);
  }

  /// 旧服务端的 /api/skills 不带 ignored：退回 ui_state 里的本机标记（老行为照旧可用）
  void _syncIgnoredFallback(Map<String, dynamic> view) {
    if (view['ignored'] is List) return;
    for (final item in _maps(view['items'])) {
      final name = '${item['name'] ?? ''}';
      if (name.isEmpty || ignoredFallback.contains(name)) continue;
      unawaited(loadFlag('skill.ignored.$name').then((on) {
        if (on && mounted) setState(() => ignoredFallback.add(name));
      }));
    }
  }

  // ── 选中与视图位 ──

  _SectionDef _defOf(String id) =>
      _sections.firstWhere((def) => def.id == id, orElse: () => _sections.first);

  /// 点行体 = 选中；窄窗同时切到详情视图（宽窗右侧原地换内容）
  void _select(String id) => setState(() {
        selectedId = id;
        narrowDetail = true;
      });

  /// 顶部 2px 不定进度线（取 ui_kit 的 StateBlock.loading 线形态）：高度固定，
  /// 出现与消失都不推动内容、也不转圈（docs/astrbot-ux-interaction.md §五）。
  Widget _progressLine(bool active) => SizedBox(
        height: 2,
        child: active ? const StateBlock.loading(padding: EdgeInsets.zero) : null,
      );

  /// 当前分区是否在读取
  bool get _sectionLoading => _sectionKeys[selectedId]!.any((key) => loading[key] == true);

  void _toast(String text, {ToastKind kind = ToastKind.info}) {
    if (!mounted) return;
    IrmiaToast.show(context, text, kind: kind);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const PageHeader(title: '扩展', subtitle: '技能、MCP 服务、内置工具与执行点钩子'),
        _progressLine(_sectionLoading),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              // 宽窗：左列表 + 右详情并排；窄窗：一次只摆一个视图
              if (constraints.maxWidth >= _wideBreakpoint) {
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(width: _sidebarWidth, child: _listPane(context, narrow: false)),
                    Container(width: 1, color: scheme.outlineVariant),
                    Expanded(child: _detailPane(context, narrow: false)),
                  ],
                );
              }
              return narrowDetail ? _detailPane(context, narrow: true) : _listPane(context, narrow: true);
            },
          ),
        ),
      ],
    );
  }

  // ── 左：四个分区 ──

  Widget _listPane(BuildContext context, {required bool narrow}) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(narrow ? 26 : 20, 14, narrow ? 16 : 8, 4),
          child: Row(
            children: [
              Text('扩展项',
                  style: TextStyle(
                      fontSize: 12.5, fontWeight: FontWeight.w600, letterSpacing: 0.3, color: scheme.onSurfaceVariant)),
              const Spacer(),
              _iconAction(context, icon: Icons.refresh_rounded, tooltip: '重新加载', onPressed: () => unawaited(loadAll())),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: loadAll,
            child: ListView(
              padding: EdgeInsets.fromLTRB(narrow ? 18 : 12, 0, narrow ? 18 : 8, 24),
              children: [for (final def in _sections) _sectionTile(context, def)],
            ),
          ),
        ),
      ],
    );
  }

  /// 列表行：图标 + 名称 + 状态点 + 一行摘要（摘要按该项的实测数据算，见 _summaryOf）
  Widget _sectionTile(BuildContext context, _SectionDef def) {
    final scheme = Theme.of(context).colorScheme;
    final stat = _statOf(def);
    final selected = def.id == selectedId;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Material(
        color: selected ? scheme.surfaceContainerHighest : Colors.transparent,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: InkWell(
          // 测试按 id 认行：文案会改，id 不会（widget 测试锁骨架靠它）
          key: ValueKey('ext-item-${def.id}'),
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          onTap: () => _select(def.id),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 9, 6, 9),
            child: Row(
              children: [
                Icon(def.icon, size: 18, color: selected ? scheme.primary : scheme.onSurfaceVariant),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(def.title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: selected ? scheme.primary : scheme.onSurface)),
                          ),
                          const SizedBox(width: 6),
                          BreathDot(kind: stat.kind, size: 7),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(stat.summary,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, height: 1.4, color: scheme.onSurfaceVariant)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ── 右：详情工作台 ──

  Widget _detailPane(BuildContext context, {required bool narrow}) {
    final def = _defOf(selectedId);
    final keys = _sectionKeys[def.id]!;
    Widget body;
    final failed = keys.firstWhere((key) => errors[key] != null, orElse: () => '');
    if (failed != '') {
      body = StateBlock.error(
        message: '数据读取失败',
        hint: errors[failed],
        onRetry: () => unawaited(load(failed)),
        padding: const EdgeInsets.symmetric(vertical: 14),
      );
    } else if (keys.any((key) => data[key] == null)) {
      // 三态里的「加载中」：**不摆占位块**，顶部的 2px 进度线已经在说明进展（照消息适配器页）。
      // 读完了仍然是 null 才是响应结构问题——那时才摆 StateBlock.error。
      final pending = keys.where((key) => data[key] == null).toList();
      final reading = pending.any((key) => loading[key] == true);
      body = reading
          ? const SizedBox.shrink()
          : StateBlock.error(
              message: '响应格式无法识别',
              hint: '本地服务 /api/${pending.first} 的响应不是预期结构。',
              onRetry: () => unawaited(load(pending.first)),
              padding: const EdgeInsets.symmetric(vertical: 14),
            );
    } else {
      body = switch (def.id) {
        'skills' => _skillsPanel(context, data['skills']!),
        'mcp' => _mcpPanel(context, data['mcp']!),
        'tools' => _toolsPanel(context, data['tools']!),
        _ => _hooksPanel(context, data['hooks']!),
      };
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(narrow ? 26 : 10, narrow ? 10 : 14, 26, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (narrow)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: TextButton.icon(
                onPressed: () => setState(() => narrowDetail = false),
                icon: const Icon(Icons.arrow_back_rounded, size: 16),
                label: const Text('扩展项列表', style: TextStyle(fontSize: 12.5)),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(0, 30),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
            ),
          Expanded(child: SingleChildScrollView(child: body)),
        ],
      ),
    );
  }

  /// 详情页头：图标 + 标题 + 一句话「这里能做什么」，右侧挂该分区的主动作
  Widget _panelHeader(BuildContext context, _SectionDef def, {List<Widget> actions = const []}) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(def.icon, size: 18, color: scheme.onSurfaceVariant),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(def.title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                const SizedBox(height: 3),
                Text(def.blurb,
                    style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          ...actions,
        ],
      ),
    );
  }

  // ── ① 技能：待确认 / 已生效 / 已忽略 ──

  Widget _skillsPanel(BuildContext context, Map<String, dynamic> view) {
    final items = _maps(view['items']);
    final ignored = _ignoredOf(view, items);
    String nameOf(Map<String, dynamic> item) => '${item['name'] ?? ''}';
    final active = items.where((item) => item['inCatalog'] == true).toList();
    final pending = items
        .where((item) => item['inCatalog'] != true && !ignored.contains(nameOf(item)))
        .toList();
    final ignoredItems = items
        .where((item) => item['inCatalog'] != true && ignored.contains(nameOf(item)))
        .toList();
    final rejected = _maps(view['rejected']);
    final tokens = _int(view['catalogTokens']);

    return _stack([
      _panelHeader(context, _defOf('skills'), actions: [
        TextButton.icon(
          onPressed: () => unawaited(load('skills', rescan: true)),
          icon: const Icon(Icons.search_rounded, size: 16),
          label: const Text('扫描目录', style: TextStyle(fontSize: 12.5)),
          style: _textButtonStyle(),
        ),
        const SizedBox(width: 4),
        FilledButton.icon(
          key: const ValueKey('skill-create'),
          onPressed: () => unawaited(_createSkillDialog()),
          icon: const Icon(Icons.add_rounded, size: 16),
          label: const Text('新建技能', style: TextStyle(fontSize: 12.5)),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            minimumSize: const Size(0, 34),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
        ),
      ]),
      _summaryLine('${active.length} 已生效 · ${pending.length} 待确认 · catalog $tokens token'),
      if (items.isEmpty && rejected.isEmpty)
        StateBlock.empty(
          icon: Icons.auto_awesome_outlined,
          message: '还没有安装技能。',
          hint: '技能是一个目录：skills/<name>/SKILL.md。扫描到之后要过信任门（在这里确认）才进 catalog。',
          action: StateBlock.cta('新建技能', () => unawaited(_createSkillDialog())),
          padding: const EdgeInsets.symmetric(vertical: 14),
        ),
      if (pending.isNotEmpty)
        _card(
          title: '待确认',
          hint: '未经确认不会进入 catalog——描述写得再好，她这会儿也看不见它。',
          children: [for (final item in pending) _skillRow(item, 'pending')],
        ),
      _card(
        title: '已生效',
        hint: '已进 catalog：她每一轮都能看到这些名字与描述。',
        children: [
          if (active.isEmpty)
            _small('还没有已确认的技能——待确认的那些确认之后会出现在这里。')
          else
            for (final item in active) _skillRow(item, 'active'),
        ],
      ),
      if (ignoredItems.isNotEmpty)
        _card(
          title: '已忽略',
          hint: '仅本机备忘（落 data/skills-ignored.json）：不写事件、不进 catalog，换台机器不会跟着走。',
          children: [for (final item in ignoredItems) _skillRow(item, 'ignored')],
        ),
      if (rejected.isNotEmpty)
        _card(
          title: '被拒绝的目录',
          hint: 'frontmatter 非法或重名：这些目录她读不到，修好 SKILL.md 后重新扫描即可。',
          children: [for (final item in rejected) _problem('${item['relDir'] ?? ''}：${item['reason'] ?? ''}')],
        ),
      _guide(
        icon: Icons.auto_awesome_outlined,
        lines: [
          '技能就在 <项目根>/skills/<name>/SKILL.md：目录名即技能名（小写字母、数字、连字符）。',
          '扫描之后要过信任门——只有你在这里点「确认」写下 skill/installed，它才进 catalog。',
        ],
      ),
    ]);
  }

  /// 忽略集的三个来源，优先级即事实强度：
  /// 服务端 `ignored` 数组（落盘真相，服务端已经滤掉了扫描不到的名字）> 逐条 `ignored: true`
  /// > 本机兜底副本。
  ///
  /// 无论走哪个来源，渲染时都只摆**`items` 里确实存在**的那几条：`skills-ignored.json` 是
  /// 只增不减的备忘，技能目录被删掉之后那里会留下一条指向空气的记录——它不该在界面上
  /// 变成一行"查无此技"（三段都从 `items` 里过滤，所以天然守住了这条）。
  Set<String> _ignoredOf(Map<String, dynamic> view, List<Map<String, dynamic>> items) {
    final raw = view['ignored'];
    if (raw is List) {
      // 服务端已经滤过一遍（只回传"扫描得到的名字"）；这里仍然与 items 求一次交，
      // 免得旧服务端或手改过的文件把一条指向空气的记录带进界面
      final present = {for (final item in items) '${item['name'] ?? ''}'};
      return raw.map((item) => '$item').where(present.contains).toSet();
    }
    final marked = items.where((item) => item['ignored'] == true).map((item) => '${item['name'] ?? ''}');
    final fromItems = marked.where((name) => name.isNotEmpty).toSet();
    if (fromItems.isNotEmpty) return fromItems;
    final present = {for (final item in items) '${item['name'] ?? ''}'};
    return ignoredFallback.where(present.contains).toSet();
  }

  Widget _skillRow(Map<String, dynamic> item, String state) {
    final name = '${item['name'] ?? ''}';
    final trust = '${item['trust'] ?? 'never-confirmed'}';
    final inCatalog = item['inCatalog'] == true;
    final description = '${item['description'] ?? ''}';
    final detail = '${item['trustDetail'] ?? ''}';
    final path = '${item['skillPath'] ?? ''}';
    final bytes = _int(item['bytes']);
    final hash = '${item['contentHash'] ?? ''}';
    final short = hash.length > 8 ? hash.substring(0, 8) : hash;
    return _row(
      cs: cs,
      key: ValueKey('skill-$name'),
      title: name,
      titleMono: true,
      badges: [
        _badge(_trustLabel[trust] ?? trust, _toneOf(cs, trust)),
        if (inCatalog) _badge('已进 catalog', IrmiaTheme.ok),
      ],
      notes: [if (description.isNotEmpty) description],
      detail: [
        DetailRow(label: '描述', value: description.isEmpty ? '—' : description),
        DetailRow(label: '技能文件', value: path.isEmpty ? '—' : path),
        DetailRow(label: '体积与指纹', value: '$bytes 字节 · ${short.isEmpty ? '—' : short}'),
        if (detail.isNotEmpty) DetailRow(label: '信任详情', value: detail),
      ],
      trailing: _skillActions(name, state: state, inCatalog: inCatalog),
    );
  }

  /// 行尾动作：待确认 = 确认 + 忽略；已忽略 = 恢复；已生效 = 停用 + 删除。
  ///
  /// 为什么已生效的行没有「打开目录」：桌面壳里没有可靠的打开方式（不引外部依赖就拿不到
  /// `explorer` 的等价物），摆一枚按不出结果的按钮比不摆更糟。技能文件路径在行的「详情」里，
  /// 复制得出来。
  Widget _skillActions(String name, {required String state, required bool inCatalog}) {
    if (state == 'ignored') {
      return Row(mainAxisSize: MainAxisSize.min, children: [
        _iconAction(context,
            icon: Icons.undo_rounded,
            tooltip: '恢复：重新列回待确认',
            onPressed: () => unawaited(_setIgnored(name, false))),
      ]);
    }
    if (inCatalog) {
      return Row(mainAxisSize: MainAxisSize.min, children: [
        _iconAction(context,
            icon: Icons.visibility_off_outlined,
            tooltip: '停用：从 catalog 里收起来（不改文件，随时可恢复）',
            onPressed: () => unawaited(_retireSkill(name))),
        // 「删除」与「停用」并排摆着，口径差在**动不动磁盘**：停用只改 catalog 的可见性，
        // 删除把整个目录移进回收站。两枚都在，人才不会把"想收起来"错点成"想删掉"。
        _iconAction(context,
            icon: Icons.delete_outline_rounded,
            tooltip: '删除：把技能目录整份移进回收站（可恢复，不是 rm -rf）',
            color: IrmiaTheme.danger,
            onPressed: () => unawaited(_removeSkill(name))),
      ]);
    }
    return Row(mainAxisSize: MainAxisSize.min, children: [
      _iconAction(context,
          icon: Icons.check_circle_outline_rounded,
          tooltip: '确认：写入 skill/installed，技能进入 catalog',
          color: cs.primary,
          onPressed: () => unawaited(confirmSkill(name))),
      _iconAction(context,
          icon: Icons.do_not_disturb_alt_rounded,
          tooltip: '忽略：收进「已忽略」，不写事件、不进 catalog',
          onPressed: () => unawaited(_setIgnored(name, true))),
    ]);
  }

  /// 信任门放行：写 skill/installed { by: 'human' }，是技能进 catalog 的唯一凭据
  Future<void> confirmSkill(String name) async {
    try {
      await widget.state.api
          .post('/api/commands/skill-confirm', {'name': name}, confirm: 'skill-confirm');
      if (mounted) _toast('已确认：$name 已进入 catalog', kind: ToastKind.success);
      await load('skills', silent: true);
    } catch (err) {
      if (mounted) _toast('确认失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  /// 忽略 / 恢复：写 `<dataDir>/skills-ignored.json`（服务端落盘，不再是前端内存）
  Future<void> _setIgnored(String name, bool ignored) async {
    try {
      await widget.state.api
          .post('/api/commands/skill-ignore', {'name': name, 'ignored': ignored}, confirm: 'skill-ignore');
      if (mounted) {
        _toast(ignored ? '已忽略：$name（仅本机备忘）' : '已放回待确认：$name');
      }
      await load('skills', silent: true);
    } catch (err) {
      if (mounted) _toast('操作失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  /// 「停用」= 从 catalog 里收起来。它与"删技能"是两件事，所以走的是同一条忽略通道，
  /// 而不是去删文件。
  ///
  /// 2026-10-06 改准：这条注释从前收尾于"撤回一个已生效的技能，目前没有对应的服务端命令
  /// （不摆假入口）"——**那句话已经不成立**：`skill-remove`（src/web/server.ts:4694，实现
  /// `removeSkill`）一直都在，只是界面从没接过（docs/repo-cleanliness-audit.md §8 第 4 条）。
  /// 现在删除是它自己那颗按钮，两件事各走各的门：停用不碰磁盘，删除移进回收站。
  Future<void> _retireSkill(String name) async {
    final ok = await confirm(
      context,
      title: '停用技能 · $name',
      body: '停用 = 收进「已忽略」，她下一轮就不再看到它（catalog 里没有它）。'
          '技能文件一个字节都不动，想放回来点「恢复」即可。',
      confirmLabel: '停用',
    );
    if (!ok || !mounted) return;
    await _setIgnored(name, true);
  }

  /// 删除技能：把 `<技能根>/<name>/` **整个移进** `<dataDir>/trash/`（服务端的 `skill-remove`，
  /// 实现是 `removeSkill`）——不是 rm -rf（design §8 用户选的可恢复那条）。
  ///
  /// 它照危险操作走三样：确认框（danger）、危险短语 `X-Confirm: skill-remove`、服务端移进回收站。
  /// 与上面「停用」的区别说在按钮的 tooltip 与确认框里：停用只是把它从 catalog 里收起来，
  /// 删除动的是磁盘上那份真实资产；代价由回收站与日志留痕兜住。
  Future<void> _removeSkill(String name) async {
    final ok = await confirm(
      context,
      title: '删除技能 · $name',
      body: '整个目录会移进回收站（<dataDir>/trash/），「不是 rm -rf」：内容一个字节不改，'
          '把那一份移回原处就恢复。删掉之后她下一轮就看不到它了——只想让她暂时看不到，用「停用」。',
      confirmLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await widget.state.api
          .post('/api/commands/skill-remove', {'name': name}, confirm: 'skill-remove');
      if (!mounted) return;
      _toast('已删除：$name 已移进回收站（内容未改，可移回恢复）', kind: ToastKind.success);
      await load('skills', silent: true);
    } catch (err) {
      if (mounted) _toast('删除失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  /// 新建技能：名称 + 一句话描述 → 服务端按规范拼骨架 → 落进「待确认」
  Future<void> _createSkillDialog() async {
    final result = await _formDialog(
      context,
      title: '新建技能',
      hint: '会在 skills/<名字>/SKILL.md 生成一份符合规范的骨架，然后停在待确认——'
          '确认之前她看不到它。名字只能用英文小写、数字与连字符（目录名即技能名）。',
      fields: [
        _FormField(
          key: 'name',
          label: '技能名',
          hint: '如 morning-review',
          validator: (value) =>
              RegExp(r'^[a-z0-9]+(?:-[a-z0-9]+)*$').hasMatch(value) ? null : '只允许小写字母、数字与连字符',
        ),
        _FormField(
          key: 'description',
          label: '一句话描述',
          hint: '写清它做什么、什么时候该用它——这是她唯一能看到的触发条件',
          maxLines: 2,
        ),
      ],
    );
    if (result == null || !mounted) return;
    try {
      final res = await widget.state.api.post(
        '/api/commands/skill-create',
        {'name': result['name'], 'description': result['description']},
        confirm: 'skill-create',
      );
      if (!mounted) return;
      final path = res is Map ? '${res['skillPath'] ?? ''}' : '';
      _toast('已生成 ${path.isEmpty ? 'SKILL.md' : path}，在「待确认」里等你的确认',
          kind: ToastKind.success);
      await load('skills', silent: true);
    } catch (err) {
      if (mounted) _toast('新建失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  // ── ② MCP：一个服务一行，可各自展开 / 折叠 ──

  Widget _mcpPanel(BuildContext context, Map<String, dynamic> view) {
    final servers = _maps(view['servers']);
    final problems = _strings(view['problems']);
    final registered = _int(view['registeredCount']);
    final running = _int(view['runningCount']);
    // 她的申请单（2026-10-11）：待批的摆在服务卡**之前**——那是要人动手的事；
    // 已答复的收在最后，供"她申请过什么、谁批的、批完落地没有"回看。
    final grants = _maps(data['grants']?['items']);
    final pending = [
      for (final grant in grants)
        if (grant['outcome'] == null && grant['picked'] == true) grant,
    ];
    final done = [
      for (final grant in grants)
        if (grant['outcome'] != null) grant,
    ];
    final unprepared = [
      for (final grant in grants)
        if (grant['outcome'] == null && grant['picked'] != true) grant,
    ];
    // "什么都没有" = 没服务也没配置问题。空态与底部那条「从这里开始」**二选一**：
    // 引导条那几句已经并进空态那张卡里，两块摞着就是用户圈出来的那一片。
    // 待批那一段**不参与**这个判据：它摆的是"等她点头的事"，不是"这一页有没有内容"。
    final nothingYet = servers.isEmpty && problems.isEmpty;
    return _stack([
      _panelHeader(context, _defOf('mcp'), actions: [
        FilledButton.icon(
          key: const ValueKey('mcp-add'),
          onPressed: () => unawaited(_mcpFormDialog(null)),
          icon: const Icon(Icons.add_rounded, size: 16),
          label: const Text('添加服务', style: TextStyle(fontSize: 12.5)),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            minimumSize: const Size(0, 34),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
        ),
      ]),
      _summaryLine('${servers.length} 个服务 · $running 已运行 · 工具 $registered 件'
          '${pending.isEmpty ? '' : ' · 待批 ${pending.length}'}'),
      // ── ① 待批（她递的单子，等人点批准或驳回）──
      if (pending.isNotEmpty) ...[
        _groupTitle('待批：她递来的申请单（${pending.length}）'),
        for (final grant in pending) _grantCard(grant),
      ],
      // ── ② 还没被拾取的那些（她刚写完 / 没通过校验）：只如实说状态，不给按钮 ──
      if (unprepared.isNotEmpty) ...[
        _groupTitle('还没有进入待批（${unprepared.length}）'),
        _card(
          title: '这些申请单还没被框架拾取',
          hint: '框架每一拍扫一次申请单目录。刚写完的等下一拍；一直停在这里的多半是没通过校验'
              '——那一拍会落一条结局（驳回理由在「已答复」那一段里），文件本身不会被删。',
          children: [
            for (final grant in unprepared)
              _row(
                cs: Theme.of(context).colorScheme,
                key: ValueKey('grant-wait-${grant['id']}'),
                title: '${grant['id'] ?? ''}',
                titleMono: true,
                monoLine: '${grant['name'] ?? ''}',
              ),
          ],
        ),
      ],
      if (nothingYet)
        _mcpEmptyCard()
      else
        for (final server in servers) _mcpCard(context, server),
      if (problems.isNotEmpty)
        _card(
          title: '配置问题',
          hint: '已声明但读不出来：修好 config.json 的 mcp.servers 后重新加载。',
          children: [for (final item in problems) _problem(item)],
        ),
      // ── ③ 已答复（批准/驳回 + 框架执行的结果）：回看用，不给动作 ──
      if (done.isNotEmpty)
        _card(
          title: '已答复的申请单',
          hint: '她递过的单子与它们的结局。批准之后由框架写 config.json；'
              '"批准了但没装成"会如实写在这一行里（那与"被驳回"是两件事）。',
          children: [for (final grant in done) GrantDoneRow(grant: grant)],
        ),
      if (!nothingYet)
        _guide(
          icon: Icons.hub_outlined,
          lines: [
            '一个 MCP 服务就是一个可执行程序：主进程按需拉起它、空闲 5 分钟回收，所以"没在跑"是常态。',
            '工具默认不信任（sideEffect = destructive）：要在 config.json 里为它显式声明才降级，配置改完要重启主进程才接管。',
            // 用户这一轮的口径：她可以自己增删，人只做审批（那张单子就摆在这一屏最上面）
            '她可以自己发起增删（写一份申请单，见上面「待批」那一段）——你在这里点批准或驳回即可。',
          ],
        ),
    ]);
  }

  /// 一张待批的申请单（卡片本体在 `extensions_kit.dart` 的 [GrantPendingCard]）。
  ///
  /// 理由的控制器**按单号存在页面里**（见 `grantReasons`）：这样 20 秒一次的轮询重画
  /// 不会把人打了一半的理由清掉。
  Widget _grantCard(Map<String, dynamic> grant) {
    final id = '${grant['id'] ?? ''}';
    final controller = grantReasons.putIfAbsent(id, TextEditingController.new);
    return GrantPendingCard(
      grant: grant,
      reasonController: controller,
      busy: grantBusy == id,
      onApprove: () => _decideGrant(id, approve: true),
      onReject: () => _decideGrant(id, approve: false),
    );
  }

  /// 用户的那一次点头或摇头（`POST /api/commands/grant-decide`）。
  ///
  /// 三处分寸：
  ///   · **理由只随驳回发**（批准没有"批准理由"这回事）；留空**照发**——人不该被一个
  ///     必填项挡住驳回，那时服务端回执里写的是"人驳回了，没有给理由"；
  ///   · 提交期间把那一张的两枚按钮禁掉（`grantBusy`），防连点出两次决定
  ///     （服务端那边也拦：第二次点撞 `grant-already-decided` 那个 409）；
  ///   · 回执里那几格**如实转述**（"已批准并写进配置" / "批准了但执行没成功" / "驳回了"），
  ///     不把"批了"说成"装上了"。
  Future<void> _decideGrant(String id, {required bool approve}) async {
    if (grantBusy != null) return;
    final reason = (grantReasons[id]?.text ?? '').trim();
    setState(() => grantBusy = id);
    try {
      final res = await widget.state.api.post('/api/commands/grant-decide', {
        'id': id,
        'decision': approve ? 'approve' : 'reject',
        if (!approve) 'reason': reason,
      });
      if (!mounted) return;
      final exec = res is Map && res['exec'] is Map
          ? (res['exec'] as Map).cast<String, dynamic>()
          : const <String, dynamic>{};
      final state = '${exec['state'] ?? ''}';
      final outcome = res is Map ? '${res['outcome'] ?? ''}' : '';
      final note = outcome == 'rejected'
          ? '已驳回${reason.isEmpty ? '（没有写理由）' : ''}——她下一拍会收到这条决定'
          : state == 'ok'
              ? '已批准并写进配置${res is Map && res['restartRequired'] == true ? '；这份改动要重启主进程才生效' : ''}'
              : '已批准，但执行没成功：${exec['failure'] ?? '（服务端没有给原因）'}';
      _toast(note, kind: state == 'ok' || outcome == 'rejected' ? ToastKind.success : ToastKind.error);
      // 答完之后立刻重读：待批那一段自己会消失（不等下一次轮询）
      await load('grants');
      await load('mcp', silent: true);
    } catch (err) {
      if (mounted) _toast('没能记下这个决定：${_clip('$err', 120)}', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => grantBusy = null);
    }
  }

  /// 这一段的小标题（待批 / 还没进入待批）：与卡片标题同字号但更轻，
  /// 因为它只是一组卡的组头，不是一张卡。
  Widget _groupTitle(String text) => Builder(builder: (context) {
        final scheme = Theme.of(context).colorScheme;
        return Padding(
          padding: const EdgeInsets.only(top: 4, bottom: 8),
          child: Text(text,
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
        );
      });

  /// MCP 的空态：**一张与上面那些服务卡同壳的卡**，里面只摆现状与解释。
  ///
  /// 为什么不做成"图标 + 居中提示 + 按钮"那一块（[StateBlock.empty]，本页技能/内置工具
  /// 两个页签还是那个形态）：那块提示自带一枚「添加服务」，而页头已经有一枚——同一个动作
  /// 在一屏里出现两次，是用户圈着说"太不协调"的地方。「消息适配器」页定过同一条规矩：
  /// 空态负责说清现状与去处，入口由页头那一枚承担（见 channels_page.dart 的 `_feed`）。
  ///
  /// 也不用 `_card`：MCP 有内容时压根没有分组标题（一个服务就是一张卡），
  /// 空态自己长出一个标题，等加上第一个服务时那个标题又得消失。
  Widget _mcpEmptyCard() => _mcpShell(
        cardKey: const ValueKey('mcp-empty'),
        children: const [
          // 只指"去哪加"，不复述页头那枚按钮的名字：用户这一条要的正是"空态里不再出现那几个字"，
          // 一屏里同一个名字出现两次（一枚按钮 + 一句指路）也违背"同一件事只说一遍"。
          HintLine('还没有配置 MCP 服务。点页头那枚按钮加一个，填一段启动命令即可。'),
          SizedBox(height: 4),
          // 下面两句原样来自底部那条「从这里开始」：并进这张卡之后那条就不再单独摆
          // （同一件事说两遍，正是 4.2.1 第二条要删的）。
          HintLine('一个服务就是一个可执行程序：主进程按需拉起、空闲 5 分钟回收，所以「没在跑」是常态。'),
          HintLine('它的工具默认按 destructive 处理，在 config.json 里显式声明才降级；改完要重启主进程才接管。'),
        ],
      );

  /// MCP 卡片的统一外壳：折叠一行、展开多行、空态一行提示，三个都吃它。
  ///
  /// 抽成一处是为了让"空态与有内容时同一形态"由**构造**保证——圆角、描边、内边距
  /// 各抄一遍迟早漂移（用户这次圈出来的，正是同屏两块东西不同宽不同起点）。
  /// 底部内边距留给调用方：展开态要多一口气，折叠态与空态不需要。
  Widget _mcpShell({Key? cardKey, required List<Widget> children, double bottom = 10}) {
    return Builder(builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return Container(
        key: cardKey,
        // 铺满可用宽度：这个 Container 落在 `_stack`（Column，crossAxisAlignment.start）里，
        // 而 Column 给孩子的宽度是**松**约束——不写这一句，卡片就按内容量收窄，
        // 空态那三行提示又没有一行服务那一排（Row + Spacer）长，于是空态比服务卡窄一截、
        // 左沿也会跟着漂。用户圈出来的"不协调"里就有这一条：同屏两块不同宽。
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 12),
        padding: EdgeInsets.fromLTRB(14, 10, 8, bottom),
        decoration: BoxDecoration(
          color: scheme.surface,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
          border: Border.all(color: scheme.outlineVariant),
          boxShadow: IrmiaTheme.hairline,
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
      );
    });
  }

  /// 一个服务一张卡：折叠态一行（服务名 + 状态 + 工具件数 + 清单时刻），展开态摆配置 + 工具 + 动作
  /// （用户点名要"各自展开/折叠"）。
  ///
  /// **工具名单是这一页的主内容之一**（用户 2026-10-10："mcp 卡片要显示 server 和工具名称"）：
  /// 折叠态那行摘要里就有"N 件 · 取于 HH:mm"，展开态把名字 + 一句话描述列在服务名下面缩进一层。
  /// 三处细节是有意的：
  ///   · 清单是**哪一刻的**写在名单头上（`它提供的工具（N 件 · 取于 …）`），放了几天还会多一句
  ///     ——清单只在启动那一刻取得到，而服务空闲 5 分钟就被回收，不写时刻就是把旧答案当新答案；
  ///   · 描述按 `_kMcpDescChars` 截断并留一个可见的「…」（界面 chrome 不渲染 Markdown，
  ///     也没有 hover 提示那一套：截断必须自己看得出来）；
  ///   · 空态分四种（拉过是空的 / 已停用 / 从未启动 / 记录不完整）——都写"0 件"等于把四件
  ///     不同的事写成同一件，而人正是靠这句话决定"要不要点测试连接"。
  Widget _mcpCard(BuildContext context, Map<String, dynamic> server) {
    final scheme = Theme.of(context).colorScheme;
    final name = '${server['name'] ?? ''}';
    final state = '${server['state'] ?? 'never-started'}';
    final enabled = server['disabled'] != true;
    final expanded = expandedServers.contains(name);
    final tools = _McpTools(server);
    final env = server['env'] is Map ? (server['env'] as Map).cast<String, dynamic>() : <String, dynamic>{};
    final lastAt = _stamp(server['lastAt']);
    final reason = '${server['stopReason'] ?? ''}';
    // 状态点：已运行 / 已停止 / 从未启动（停用是配置事实，单独用徽章说）
    final kind = state == 'started' ? 'running' : (state == 'stopped' ? 'idle' : 'sleeping');

    return _mcpShell(
      cardKey: ValueKey('mcp-$name'),
      bottom: expanded ? 14 : 10,
      children: [
        Row(
          children: [
            BreathDot(kind: kind, size: 8),
            const SizedBox(width: 8),
            Flexible(
              child: Text('$name  ·  ${_mcpLabel[state] ?? state}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
            ),
            const SizedBox(width: 8),
            if (!enabled) _badge('已停用', scheme.onSurfaceVariant),
            // 徽章的数**与展开里那份清单同源**（老后端只给"此刻注册的"计数，见 `badgeCount`）：
            // 徽章写 3 件、下面列了 5 件，这一页就没人信了
            if (tools.badgeCount > 0) _badge('${tools.badgeCount} 件工具', scheme.primary),
            const Spacer(),
            Switch(
              value: enabled,
              onChanged: (value) => unawaited(_toggleMcpServer(name, value)),
            ),
            _iconAction(context,
                icon: expanded ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                tooltip: expanded ? '折叠这个服务' : '展开这个服务',
                onPressed: () => setState(() {
                      if (expanded) {
                        expandedServers.remove(name);
                      } else {
                        expandedServers.add(name);
                      }
                    })),
          ],
        ),
        // 折叠态也看得到"它有什么、什么时候取的"（展开才看得到的话，这一页就还得先点一下才知道）
        Padding(
          padding: const EdgeInsets.only(top: 4, right: 6),
          child: Text(
            tools.summary,
            key: ValueKey('mcp-$name-tools-summary'),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 12, height: 1.4, color: scheme.onSurfaceVariant),
          ),
        ),
        /**
         * 「它是干什么的」（2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
         *
         * **摆在折叠态**，与索引那一行同一个位置关系（名字下面第一句）：人在这里看到的
         * 就是她在索引里看到的那一句——两处不一致时，这一页就没有可信度了。
         *
         * 三种来源照服务端给的那一格分（界面**不推断**）：
         *   · `descFrom == 'config'` ⇒ 原样；
         *   · `descFrom == 'cache'`  ⇒ 加一句"它自报的"（**不是一声明**，判据在
         *     `src/mcp/description.ts` 的文件头）；
         *   · 没有（`absent` / 空串）⇒ 照实说"没写它做什么"，并把"这一格该补"说出来——
         *     省掉这一行的话，这一页读起来与改动之前逐字相同，而人也就不知道要补它。
         */
        Padding(
          padding: const EdgeInsets.only(top: 2, right: 6),
          child: Text(
            (() {
              final desc = '${server['desc'] ?? ''}'.trim();
              if (desc.isEmpty) return '（没写它做什么——她在索引里只看到这个名字）';
              return server['descFrom'] == 'cache' ? '$desc（它自报的）' : desc;
            })(),
            key: ValueKey('mcp-$name-desc'),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12,
              height: 1.45,
              fontStyle: '${server['desc'] ?? ''}'.trim().isEmpty ? FontStyle.italic : FontStyle.normal,
              color: scheme.onSurfaceVariant,
            ),
          ),
        ),
        if (expanded) ...[
          const SizedBox(height: 8),
          Text('启动命令', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: _monoText('${server['command'] ?? ''} ${_strings(server['args']).join(' ')}'),
          ),
          if (env.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('环境变量', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            for (final entry in env.entries)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: _monoText('${entry.key}=${entry.value}'),
              ),
          ],
          const SizedBox(height: 10),
          _mcpToolsBlock(context, name: name, tools: tools),
          if (lastAt.isNotEmpty)
            _small('最近一次运行记录：$lastAt${reason.isEmpty ? '' : '（$reason）'}'),
          if (_int(server['pid']) > 0) _small('日志里的 pid：${server['pid']}'),
          const Divider(height: 20),
          Row(
            children: [
              TextButton.icon(
                onPressed: mcpTesting.contains(name) ? null : () => unawaited(_testServer(name)),
                icon: mcpTesting.contains(name)
                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Icon(Icons.power_rounded, size: 15),
                label: Text(mcpTesting.contains(name) ? '正在拉起进程…' : '测试连接',
                    style: const TextStyle(fontSize: 12.5)),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  minimumSize: const Size(0, 32),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
              const Spacer(),
              _iconAction(context,
                  icon: Icons.edit_outlined,
                  tooltip: '编辑这个服务',
                  onPressed: () => unawaited(_mcpFormDialog(server))),
              _iconAction(context,
                  icon: Icons.delete_outline_rounded,
                  tooltip: '删除这个服务',
                  color: IrmiaTheme.danger,
                  onPressed: () => unawaited(_removeServer(name))),
            ],
          ),
        ],
      ],
    );
  }

  /// 展开态里那一块「服务 → 工具名」：服务名做小标题，工具名列在它下面**缩进一层**。
  ///
  /// 缩进不是装饰：用户要的是"层级关系一眼看清"（原话：`<mcp><server><toolname>`）：
  /// 这一块的标题是服务（`它提供的工具（N 件 · 取于 …）`），工具名一律缩进 22px 起。
  /// 短名给人看（排得下），全名只在和短名不同时补一行（对照日志与「内置工具」页签用）。
  Widget _mcpToolsBlock(BuildContext context, {required String name, required _McpTools tools}) {
    final scheme = Theme.of(context).colorScheme;
    final rows = <Widget>[
      for (final tool in tools.items)
        Padding(
          key: ValueKey('mcp-$name-tool-${tool.short}'),
          padding: const EdgeInsets.only(left: 22, bottom: 5),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 150,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      tool.short,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, height: 1.5),
                    ),
                    // 全名只在**与短名不一样**时多给一行：日志与「内置工具」页签里出现的都是
                    // `mcp__{server}__{name}`，要对照时不必回去猜；一样就不重复占一行。
                    if (tool.full.isNotEmpty && tool.full != tool.short)
                      Text(
                        tool.full,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontFamily: 'monospace', fontSize: 10, height: 1.4, color: scheme.onSurfaceVariant),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  tool.description.isEmpty ? '（这个服务没给描述）' : _mcpClip(tool.description),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurface),
                ),
              ),
            ],
          ),
        ),
    ];
    return Padding(
      key: ValueKey('mcp-$name-tools'),
      padding: const EdgeInsets.only(right: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            tools.heading,
            style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 5),
          if (rows.isEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 10, top: 2),
              child: Text(
                tools.emptyLine,
                style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant),
              ),
            )
          else ...[
            ...rows,
            // 名单列全了（以前这里收在 12 件）——顺带说一句"没有漏"，免得人以为还有下文
            _small('清单是完整的：${tools.items.length} 件全在上面。'),
          ],
          if (tools.staleNote.isNotEmpty) _small(tools.staleNote),
        ],
      ),
    );
  }

  /// **写命令回执怎么读成人话**（`mcp-save` / `mcp-remove` 共用）。
  ///
  /// 判据只有服务端一处（`WebServerImpl.mcpRestartOutcome` 的方法头：那一格回答的是
  /// "这次改动**是否真的**需要重启"，`mcp.servers` 是热更字段、接线活着就不必重启）
  /// ——界面**不自己算**，只照它说人话。三态各自成句，因为它们说的是三件不同的事：
  ///
  ///   · `effect == 'unchanged'` ⇒ 这次什么都没改（**不是**"已生效"）：说"已生效"会让人以为
  ///     自己刚保存的那点东西起了作用，而盘上那份与原来逐字段相同；
  ///   · `restartRequired == true` ⇒ 真要重启，**并把服务端那句"为什么"原样带上**
  ///     （接线没活、或顺带写了不走热更的字段——两种理由不一样，界面没有本事自己分辨）；
  ///   · 其余 ⇒ 已生效、不必重启（生产常态：声明面写盘即生效）。
  ///
  /// 读不出来（响应体不是 Map、或那两格形状不对）时按**最保守**的一侧说"需要重启主进程才生效"：
  /// 说"要重启"顶多多一次重启，说"已生效"而其实没生效是撒谎
  /// （与 `_protocolField` 那条"读不到就什么都不说"同一条纪律）。
  String _mcpWriteOutcome(dynamic receipt) {
    final map = receipt is Map ? receipt : const <String, dynamic>{};
    if (map['effect'] == 'unchanged') return '配置本来就是这样，没有改动';
    // 生效与否只认那一格：缺它、或它不是布尔 ⇒ 按最保守的一侧说（见上面最后一段）
    final needsRestart = map['restartRequired'] is bool ? map['restartRequired'] as bool : true;
    if (!needsRestart) return '已生效，不用重启';
    // 那句理由由服务端写全（它才知道是哪一格接不住）；界面只负责**原样转达**，
    // 不自己编一句——编一句就等于第二份判据，两处迟早说不到一块去。
    final why = map['restartNote'] is String ? (map['restartNote'] as String).trim() : '';
    return why.isNotEmpty ? why : '需要重启主进程才生效';
  }

  /// 启用开关 = 写 `disabled`（界面说 enabled，配置存 disabled：转换只在服务端那一处发生）
  Future<void> _toggleMcpServer(String name, bool enabled) async {
    final server = _maps(data['mcp']?['servers']).firstWhere(
      (item) => '${item['name']}' == name,
      orElse: () => <String, dynamic>{},
    );
    if (server.isEmpty) return;
    try {
      final receipt = await widget.state.api.post('/api/commands/mcp-save', {
        'name': name,
        'command': '${server['command'] ?? ''}',
        'args': _strings(server['args']),
        'env': server['env'] is Map ? (server['env'] as Map).cast<String, dynamic>() : <String, dynamic>{},
        // desc 照原样带上：那是"它是干什么的"，拨一次开关不该把它抹掉
        // （服务端对"没给这一格"的语义本来就是**原样保留**，带上是更直白的写法）
        'desc': '${server['desc'] ?? ''}',
        'enabled': enabled,
      }, confirm: 'mcp-save');
      if (mounted) {
        _toast(
          '$name 已${enabled ? '启用' : '停用'}：${_mcpWriteOutcome(receipt)}',
          kind: ToastKind.success,
        );
      }
      await load('mcp', silent: true);
    } catch (err) {
      if (mounted) _toast('切换失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  /// 添加 / 编辑服务。`existing` 为 null 即"添加"。
  Future<void> _mcpFormDialog(Map<String, dynamic>? existing) async {
    final isEdit = existing != null;
    final nameCtl = TextEditingController(text: isEdit ? '${existing['name']}' : '');
    final cmdCtl = TextEditingController(text: isEdit ? '${existing['command']}' : '');
    final argsCtl = TextEditingController(text: isEdit ? _strings(existing['args']).join('\n') : '');
    final envCtl = TextEditingController(
      text: isEdit && existing['env'] is Map
          ? (existing['env'] as Map).entries.map((e) => '${e.key}=${e.value}').join('\n')
          : '',
    );
    /// 测试连接的超时。默认 [_mcpTestTimeoutDefaultMs] 而不是服务端那个 8s：
    /// 首次 `npx -y <包>` 要拉包，30s+ 是常态，而"测试连接超时"会被误读成"这个服务不可用"。
    final timeoutCtl = TextEditingController(text: '$_mcpTestTimeoutDefaultMs');
    /// 「它是干什么的」（2026-10-11 加，用户点名的"索引内容质量低"那一笔）。
    ///
    /// 它进的是**她的常驻索引**那一行（`- obscura —— <这一句> —— 启用，已见 3 件工具`），
    /// 所以这一格是"她下次要不要用它、怎么用它"唯一的依据。**留空不拦人**（人不是模型），
    /// 但输入框下面那行小字如实说清后果：留空之后她在索引里只看到名字。
    final descCtl = TextEditingController(text: isEdit ? '${existing['desc'] ?? ''}' : '');
    var enabled = isEdit ? existing['disabled'] != true : true;
    // 还没保存就先试一下：内联的这份配置由服务端过一遍 parseMcpServers，界面不自己判合法性
    var enableToggle = enabled;
    /// 这一次保存的回执（弹窗关掉之后 toast 要用它说生效与否）：
    /// `null` = 还没保存过（人点了取消或保存失败），此时不许说任何结果。
    dynamic saveReceipt;
    /// 这次保存的服务名（弹窗里那个 `name` 的作用域只到 `builder` 里，toast 在它外面）：
    /// 空串 = 还没保存过。原来那句 toast 不带名字，于是"保存了哪一个"只能从上下文猜。
    var savedName = '';

    /// 输入框里的超时（读不出正数就回默认——比拦着不让测要好）
    int timeoutOf() {
      final parsed = int.tryParse(timeoutCtl.text.trim()) ?? 0;
      return parsed > 0 ? parsed : _mcpTestTimeoutDefaultMs;
    }

    final result = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (builderContext, setDialogState) {
          final scheme = Theme.of(builderContext).colorScheme;
          return AlertDialog(
            constraints: const BoxConstraints(minWidth: 420, maxWidth: 560),
            title: Text(isEdit ? '编辑 MCP 服务' : '添加 MCP 服务',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '一个服务 = 一段启动命令。保存写进 config.json 的 mcp.servers[]，写完即生效：'
                    '调用走内置的 mcp 工具（它按需拉起这个服务，默认空闲 5 分钟回收）。',
                    style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant),
                  ),
                  const SizedBox(height: 12),
                  _dialogField(nameCtl, '服务名', '给这个服务起的名字，调用时用得到（只允许字母、数字、- 与 _，如 filesystem）', fieldKey: const ValueKey('mcp-field-name')),
                  // 示例顺序按"本机真起得来"排：uvx / node <绝对路径>.js 实测能起，
                  //   而 npx 在 Windows 上起不来（只有 .cmd 垫片 + 启动器不经 shell），所以它不再排第一个。
                  //   判据与整段话在 src/mcp/launcher-guard.ts 的「这一台机器上起不来的形状」那一节。
                  //   长度受 test/copy_rules_test.dart 的 100 字上限约束（超了就是散文）。
                  _dialogField(cmdCtl, 'command', '要拉起的程序：uvx … 或 node D:\\…\\cli.js（绝对路径 .exe 也行）。启动器须在白名单里（node、uvx、python），不许内联执行；npx 在 Windows 上起不来', fieldKey: const ValueKey('mcp-field-command')),
                  _dialogField(
                    descCtl,
                    'desc（它是干什么的）',
                    '一句话：这个服务是干什么的、你打算用它做什么（例如：读本机浏览器历史与当前标签页）',
                    fieldKey: const ValueKey('mcp-field-desc'),
                    helper: '这一句会进她的常驻索引（一个服务一行）。留空也能保存——那样她在索引里只看到名字。',
                  ),
                  _dialogField(argsCtl, 'args（一行一个）', '每个参数占一行：-y 一行、包名一行', maxLines: 3, fieldKey: const ValueKey('mcp-field-args')),
                  _dialogField(envCtl, 'env（一行一个 KEY=VALUE）', '可选：这几行之外，它还会继承主进程的环境变量', maxLines: 2, fieldKey: const ValueKey('mcp-field-env')),
                  _dialogField(timeoutCtl, '测试连接超时（毫秒）',
                      '首次拉包可能要 30s 以上；只影响这个对话框里的「测试连接」（500–60000），不写进配置',
                      fieldKey: const ValueKey('mcp-field-timeout')),
                  const SizedBox(height: 4),
                  Row(
                    children: [
                      Expanded(
                        child: Text('启用这个服务（关掉 = 配置留着但不起进程，调用也不会拉起它）',
                            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                      ),
                      Switch(
                        value: enableToggle,
                        onChanged: (value) => setDialogState(() => enableToggle = value),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
                child: const Text('取消'),
              ),
              TextButton(
                // 「试一下」不关弹窗：结果摆在下面的对话框里，人可以照着改参数再试
                onPressed: () => _probeIt(
                  name: nameCtl.text.trim(),
                  command: cmdCtl.text.trim(),
                  argsText: argsCtl.text,
                  envText: envCtl.text,
                  timeoutMs: timeoutOf(),
                ),
                style: TextButton.styleFrom(foregroundColor: scheme.primary),
                child: const Text('测试连接'),
              ),
              FilledButton(
                onPressed: () async {
                  final name = nameCtl.text.trim();
                  final command = cmdCtl.text.trim();
                  if (name.isEmpty || command.isEmpty) {
                    _toast('服务名与 command 都得填', kind: ToastKind.warn);
                    return;
                  }
                  try {
                    final receipt = await widget.state.api.post('/api/commands/mcp-save', {
                      'name': name,
                      'command': command,
                      'args': _lines(argsCtl.text),
                      'env': _envPairs(envCtl.text),
                      // desc（"它是干什么的"）：**照原样发**，留空就是留空（服务端把空串存下来，
                      // 并在回执里如实说"她在索引里只看到名字"）。不在这里替人补一句——
                      // 那正是"框架替人编"，而这一格的全部价值就是那句话得是真的。
                      'desc': descCtl.text.trim(),
                      'enabled': enableToggle,
                    }, confirm: 'mcp-save');
                    saveReceipt = receipt;
                    savedName = name;
                    enabled = enableToggle;
                    if (dialogContext.mounted) Navigator.of(dialogContext).pop(true);
                  } catch (err) {
                    if (mounted) _toast('保存失败：${_clip('$err', 90)}', kind: ToastKind.error);
                  }
                },
                child: const Text('保存'),
              ),
            ],
          );
        },
      ),
    );
    // 退场动画跑完再销毁：见 extensions_kit 的 _disposeSoon 注释
    _disposeSoon([nameCtl, cmdCtl, descCtl, argsCtl, envCtl, timeoutCtl]);
    if (result == true && mounted) {
      // 生效与否**只照服务端那份回执说**（见 `_mcpWriteOutcome`）：热更落地之后写盘即生效，
      // 这里再写死"进程重启后接管"就是让人白重启一次；而"这次什么都没改"也不许说成"已生效"。
      // 停用状态那半句照旧保留（它说的是配置事实，与服务端回执无关）。
      final outcome = _mcpWriteOutcome(saveReceipt);
      final who = savedName.isEmpty ? '' : ' $savedName';
      /**
       * desc 那一格的结果**照服务端那句话原样说**（2026-10-11 加）。
       *
       * 三条，一条都不许省（都是用户点名的那件事）：
       *   · 留空 ⇒ 明说"她的索引里只会有这个名字"（**留空不拦人**，但后果要说清）；
       *   · 存上了 ⇒ 明说那一句会进索引；
       *   · 空着但有缓存兜底 ⇒ 明说那一句是**它自报的**（不是一声明）。
       * 界面不自己判这四种情形（那是 `mcp/description.ts` 的判据），只转达 `descNote`。
       */
      final descNote = saveReceipt is Map && saveReceipt['descNote'] is String
          ? (saveReceipt['descNote'] as String).trim()
          : '';
      _toast(
        '${enabled ? '已保存$who' : '已保存$who（停用状态）'}：$outcome'
        '${descNote.isEmpty ? '' : '　$descNote'}',
        // 留空那一档用提醒色：那一句是"她下次只看到名字"，不是一次干净的完成
        kind: descNote.contains('只会有这个名字') ? ToastKind.warn : ToastKind.success,
      );
      await load('mcp', silent: true);
    }
  }

  /// 内联测试：还没保存就先试一下（`{name, command, args, env, timeoutMs}` 直接进 mcp-test）
  Future<void> _probeIt({
    required String name,
    required String command,
    required String argsText,
    required String envText,
    required int timeoutMs,
  }) async {
    if (command.isEmpty) {
      _toast('先填 command 再测', kind: ToastKind.warn);
      return;
    }
    await _runProbe({
      'name': name,
      'command': command,
      'args': _lines(argsText),
      'env': _envPairs(envText),
      // 超时跟 command/args 一起走：拉包慢的服务不该被 8 秒的默认值判成"不可用"
      'timeoutMs': timeoutMs,
    });
  }

  /// 已保存的服务：按名字测（服务端从 config.json 里取那条配置）
  Future<void> _testServer(String name) async {
    setState(() => mcpTesting.add(name));
    try {
      await _runProbe({'name': name});
    } finally {
      if (mounted) setState(() => mcpTesting.remove(name));
    }
  }

  Future<void> _runProbe(Map<String, dynamic> body) async {
    try {
      final res = await widget.state.api.post('/api/commands/mcp-test', body, confirm: 'mcp-test');
      if (!mounted) return;
      await _showProbeResult(res is Map ? res.cast<String, dynamic>() : <String, dynamic>{});
    } catch (err) {
      if (mounted) _toast('测试失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  /// 成功与失败都要有明确反馈：失败给原因（命令不存在 / 握手超时 / 协议不符），
  /// 成功把**取回来的工具清单**摆出来——这是"它到底能做什么"的唯一实测答案。
  Future<void> _showProbeResult(Map<String, dynamic> res) async {
    final ok = res['ok'] == true;
    final tools = _maps(res['tools']);
    final info = res['serverInfo'] is Map ? (res['serverInfo'] as Map).cast<String, dynamic>() : <String, dynamic>{};
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        final scheme = Theme.of(dialogContext).colorScheme;
        return AlertDialog(
          constraints: const BoxConstraints(minWidth: 420, maxWidth: 560),
          title: Row(children: [
            Icon(ok ? Icons.check_circle_outline_rounded : Icons.error_outline_rounded,
                size: 18, color: ok ? IrmiaTheme.ok : IrmiaTheme.danger),
            const SizedBox(width: 8),
            Text(ok ? '连接成功' : '连接失败', style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          ]),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (ok) ...[
                  Text('${res['name'] ?? ''} 起来了、握手通过、工具清单取回来了（${_int(res['durationMs'])}ms）。',
                      style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 10),
                  if (tools.isEmpty)
                    _small('它声明了 tools 能力但清单是空的：这个服务当前不提供工具。')
                  else
                    for (final tool in tools)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            _monoText('${tool['name'] ?? ''}'),
                            if ('${tool['description'] ?? ''}'.isNotEmpty)
                              Text('${tool['description']}',
                                  style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
                          ],
                        ),
                      ),
                  const SizedBox(height: 6),
                  _small('协议版本 ${res['protocolVersion'] ?? '—'}'
                      '${info.isEmpty ? '' : ' · 对面自称 ${info['name']} ${info['version']}'}'),
                  _small('进程已收掉（${_strings(res['shutdownStages']).join(' → ')}）——不留后台进程。'),
                ] else ...[
                  Text('${res['reason'] ?? '未知原因'}',
                      style: TextStyle(fontSize: 12.5, height: 1.7, color: scheme.onSurface)),
                  if ('${res['stderrTail'] ?? ''}'.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    _small('它的 stderr 尾部：${res['stderrTail']}'),
                  ],
                ],
                const SizedBox(height: 10),
                Text('${res['note'] ?? ''}',
                    style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('知道了'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _removeServer(String name) async {
    final ok = await confirm(
      context,
      title: '删除 MCP 服务 · $name',
      // 后果说准（2026-10-11 改）：热更落地之后删一条**当场生效**，不再是"重启后生效"；
      // 真要重启的情形服务端会在回执里说（见 `_mcpWriteOutcome`），这一句不必替它先下结论。
      body: '从 config.json 的 mcp.servers[] 里删掉这一条。她的 mcp 工具里不再有这个服务。'
          '程序本体不会被卸载。',
      confirmLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      final receipt = await widget.state.api.post('/api/commands/mcp-remove', {'name': name}, confirm: 'mcp-remove');
      if (mounted) {
        _toast('已删除 $name：${_mcpWriteOutcome(receipt)}', kind: ToastKind.success);
      }
      setState(() => expandedServers.remove(name));
      await load('mcp', silent: true);
    } catch (err) {
      if (mounted) _toast('删除失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  // ── ③ 内置工具：按组分区（容器支持多组，将来会有 computer use 组） ──

  Widget _toolsPanel(BuildContext context, Map<String, dynamic> view) {
    final tools = _maps(view['tools']);
    if (tools.isEmpty) {
      return _stack([
        _panelHeader(context, _defOf('tools')),
        StateBlock.empty(
          icon: Icons.build_outlined,
          message: '还没有工具注册表。',
          hint: '注册表由运行期装配；本进程读到空清单时不会有条目。MCP 服务的工具不在这个清单里：走内置的 mcp 工具按需看。',
          action: StateBlock.cta('刷新', () => unawaited(load('tools'))),
          padding: const EdgeInsets.symmetric(vertical: 14),
        ),
      ]);
    }
    // 分组的唯一清单在后端 tools/groups.ts：这里只按它给的顺序摆，不自己分组。
    // **容器按组遍历**是刻意的：今天只有「基本组」，明天加「computer use 组」时这里一个字都不用改。
    final groups = _maps(view['groups']);
    final labelOf = <String, String>{for (final g in groups) '${g['id']}': '${g['label'] ?? g['id']}'};
    final noteOf = <String, String>{for (final g in groups) '${g['id']}': '${g['note'] ?? ''}'};
    final byGroup = <String, List<Map<String, dynamic>>>{};
    for (final tool in tools) {
      byGroup.putIfAbsent('${tool['group'] ?? 'builtin'}', () => <Map<String, dynamic>>[]).add(tool);
    }
    // 顺序照 groups[]（后端已定序：内置在前，MCP 按首次出现）；不在清单里的组补在后面
    final order = <String>[...groups.map((g) => '${g['id']}'), ...byGroup.keys.where((id) => !labelOf.containsKey(id))];
    final enabled = tools.where((tool) => tool['enabled'] != false).length;

    return _stack([
      _panelHeader(context, _defOf('tools')),
      _summaryLine('$enabled 件启用 / 共 ${tools.length} 件 · destructive：${_policy(view['destructivePolicy'])}'),
      for (final id in order)
        _toolGroup(
          id: id,
          label: labelOf[id] ?? id,
          note: noteOf[id] ?? '',
          tools: byGroup[id] ?? const [],
        ),
      _guide(
        icon: Icons.build_outlined,
        lines: [
          '关掉一件工具不改变能力边界，只是把它的名字从她的清单里拿掉——她下一轮就看不见它了。',
          'destructive 类工具本身还有一道独立的开关（tools.destructiveEnabled），这里关不掉那一道。',
        ],
      ),
    ]);
  }

  /// 一组工具：组头（名字 + 计数 + 全开/全关）+ 行
  Widget _toolGroup({
    required String id,
    required String label,
    required String note,
    required List<Map<String, dynamic>> tools,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final on = tools.where((tool) => tool['enabled'] != false).length;
    final allOn = tools.isNotEmpty && on == tools.length;
    final allOff = on == 0;
    return Container(
      key: ValueKey('tool-group-$id'),
      margin: const EdgeInsets.only(bottom: 18),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 14),
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
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 3),
                    Text('$on / ${tools.length} 件启用${note.isEmpty ? '' : ' · $note'}',
                        style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant)),
                  ],
                ),
              ),
              TextButton(
                onPressed: (allOn || busyGroup != null) ? null : () => unawaited(_toggleGroup(id, tools, true)),
                style: _textButtonStyle(),
                child: const Text('全开', style: TextStyle(fontSize: 12.5)),
              ),
              TextButton(
                onPressed: (allOff || busyGroup != null) ? null : () => unawaited(_toggleGroup(id, tools, false)),
                style: _textButtonStyle(),
                child: const Text('全关', style: TextStyle(fontSize: 12.5)),
              ),
            ],
          ),
          const SizedBox(height: 4),
          for (final tool in tools) _toolRow(tool),
        ],
      ),
    );
  }

  Widget _toolRow(Map<String, dynamic> tool) {
    final name = '${tool['name'] ?? ''}';
    final effect = '${tool['sideEffect'] ?? 'none'}';
    final mode = '${tool['executionMode'] ?? ''}';
    final description = '${tool['description'] ?? ''}';
    final on = tool['enabled'] != false;
    return _row(
      cs: cs,
      key: ValueKey('tool-$name'),
      title: name,
      titleMono: true,
      badges: [
        _badge(effect, _toneOf(cs, effect)),
        if (mode.isNotEmpty) _badge(mode, cs.onSurfaceVariant),
        if (!on) _badge('已关闭', cs.onSurfaceVariant),
        if (tool['fromMcp'] == true) _badge('MCP', cs.primary),
      ],
      notes: [if (description.isNotEmpty) description],
      detail: [
        DetailRow(label: '并发模式', value: mode.isEmpty ? '—' : mode),
        DetailRow(label: '超时', value: _ms(tool['timeoutMs'])),
        ..._paramRows(tool['parameters']),
      ],
      trailing: Tooltip(
        message: on ? '关闭：从她的工具清单里拿掉' : '开启：放回她的工具清单',
        child: Switch(
          value: on,
          onChanged: busyGroup == null ? (value) => unawaited(_toggleTool(name, value)) : null,
        ),
      ),
    );
  }

  /// 开关一件工具：写 config.tools.disabled（服务端同时把内存注册表调到同一状态）
  Future<void> _toggleTool(String name, bool enabled, {bool reload = true}) async {
    if (name.isEmpty) return;
    await widget.state.api.post('/api/commands/tool-toggle', {'name': name, 'enabled': enabled});
    if (reload && mounted) await load('tools', silent: true);
  }

  /// 整组开/关：**就是逐件调 tool-toggle**，不另造一个批量命令。
  ///
  /// 一条一条发（不是 `Future.wait` 并发）：服务端现在有 `configFileLock` 兜着，并发也安全
  /// （见 `test/extensions-commands.test.ts` 的两条并发用例），但串行仍有两条实际好处——
  /// 中途能按名字如实报出"哪一件没改成"，以及不去制造 N 条同时落盘的写命令。
  /// 代价是 N 次往返；本机口径 21 件工具约几百毫秒，比"整组只有一半生效"好得多。
  Future<void> _toggleGroup(String groupId, List<Map<String, dynamic>> tools, bool enabled) async {
    setState(() => busyGroup = groupId);
    final failures = <String>[];
    try {
      for (final tool in tools) {
        final name = '${tool['name'] ?? ''}';
        if (name.isEmpty || (tool['enabled'] != false) == enabled) continue;
        try {
          await _toggleTool(name, enabled, reload: false);
        } catch (err) {
          failures.add('$name：${_clip('$err', 40)}');
        }
      }
      if (!mounted) return;
      if (failures.isEmpty) {
        _toast('${enabled ? '已全开' : '已全关'}（${tools.length} 件）', kind: ToastKind.success);
      } else {
        _toast('有 ${failures.length} 件没改成：${failures.first}', kind: ToastKind.warn);
      }
      await load('tools', silent: true);
    } finally {
      if (mounted) setState(() => busyGroup = null);
    }
  }

  /// 入参摘要：名字 + 必填标记 + 说明。
  /// 之前界面上完全看不到参数，于是「report 有没有 `to`」这种问题只能去翻源码——
  /// 她能带什么参数是她能力的一部分，该看得见。
  List<Widget> _paramRows(Object? raw) {
    if (raw is! List) return const [];
    final rows = <Widget>[];
    for (final item in raw.whereType<Map>()) {
      final name = '${item['name'] ?? ''}';
      if (name.isEmpty) continue;
      final desc = '${item['description'] ?? ''}';
      rows.add(DetailRow(
        label: item['required'] == true ? '$name（必填）' : name,
        value: desc.isEmpty ? '—' : desc,
      ));
    }
    return rows.isEmpty ? const [] : [const SizedBox(height: 2), ...rows];
  }

  // ── ④ Hooks：条目列表 + 添加/编辑 ──

  Widget _hooksPanel(BuildContext context, Map<String, dynamic> view) {
    final entries = _maps(view['entries']);
    final problems = _strings(view['problems']);
    final relative = '${view['relative'] ?? 'data/hooks.json'}';
    return _stack([
      _panelHeader(context, _defOf('hooks'), actions: [
        FilledButton.icon(
          key: const ValueKey('hook-add'),
          onPressed: () => unawaited(_hookFormDialog(null)),
          icon: const Icon(Icons.add_rounded, size: 16),
          label: const Text('添加钩子', style: TextStyle(fontSize: 12.5)),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            minimumSize: const Size(0, 34),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
        ),
      ]),
      _notice('$relative 定义的是「谁能改我」：agent 对它只读（写入口被路径守卫拒绝），'
          '只有你在这里能改。这类操作都要求确认短语，改完要重启主进程才装配。'),
      _summaryLine('${_int(view['enabledCount'])} 条生效 / 共 ${entries.length} 条'),
      // 空态与有内容时是**同一张卡**：同一个标题、同一行副标题，屏幕上换掉的只有卡里那内容。
      // 加上第一条钩子时卡片本身不动，四个页签的第一个方块也就都从同一条线上开始。
      _card(
        title: '钩子条目',
        hint: '按文件顺序执行；一条钩子的超时不会阻塞主流程（超时即杀、输出丢弃）。',
        children: [
          if (entries.isEmpty)
            // 卡内空态走 HintLine 不走 StateBlock.empty（ui_kit 对这两种场合的分工）：
            // 卡片自己已经有边界，"里面没有内容"是常态，再摆一块带图标的提示就是盒子套盒子；
            // 也不给按钮——页头那枚是唯一入口，与「消息适配器」页同一条规矩；
            // 指路只说"页头那枚按钮"，不复述它的名字（用户要求空态里不再出现那几个字）。
            // "钩子能做什么"原在底部那条「从这里开始」里，并到这一行之后那条就不再单独摆。
            const HintLine('还没有配置钩子。点页头那枚按钮加一条：钩子可以拒绝工具调用，也可以改写参数。')
          else
            for (final entry in entries) _hookRow(entry),
        ],
      ),
      if (problems.isNotEmpty)
        _card(
          title: '无效条目',
          hint: '无效条目不影响其余配置生效，但需要修掉——它现在一条都不会跑。',
          children: [for (final item in problems) _problem(item)],
        ),
      // 没有条目时不再摞一条「从这里开始」：它那两句里，"agent 改不了这份文件"与"要带确认短语、
      // 改完重启"上面那条 _notice 已经说过，"钩子能拒绝/改写"并进了空态那张卡。
      // 用户圈出来的那一片，正是"空态 + 解释卡"两块摞着。
      if (entries.isNotEmpty)
        _guide(
          icon: Icons.lock_outline_rounded,
          lines: [
            '这条线画在"谁能改我"上：钩子能拒绝工具调用、能改写参数，所以 agent 永远改不了这份文件。',
            '从界面写它要带确认短语（X-Confirm: hook-save / hook-remove），写完重启主进程才装配。',
          ],
        ),
    ]);
  }

  Widget _hookRow(Map<String, dynamic> entry) {
    final index = _int(entry['index']);
    final enabled = entry['enabled'] != false;
    final matcher = '${entry['matcher'] ?? ''}';
    final condition = '${entry['if'] ?? ''}';
    return _row(
      cs: cs,
      key: ValueKey('hook-$index'),
      title: '${entry['hook'] ?? ''}',
      badges: [
        if (matcher.isNotEmpty) _badge(matcher, cs.primary),
        if (!enabled) _badge('已停用', cs.onSurfaceVariant),
      ],
      monoLine: '${entry['command'] ?? ''}',
      detail: [
        DetailRow(label: '事件', value: '${entry['hook'] ?? ''}'),
        DetailRow(label: 'matcher', value: matcher.isEmpty ? '—' : matcher),
        DetailRow(label: '超时', value: _ms(entry['timeoutMs'])),
        DetailRow(label: '触发条件', value: condition.isEmpty ? '—' : condition),
      ],
      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
        Tooltip(
          message: enabled ? '停用：保留命令行，但不装配它' : '启用：重启后装配它',
          child: Switch(
            value: enabled,
            onChanged: (value) => unawaited(_toggleHook(entry, value)),
          ),
        ),
        _iconAction(context,
            icon: Icons.edit_outlined,
            tooltip: '编辑这条钩子',
            onPressed: () => unawaited(_hookFormDialog(entry))),
        _iconAction(context,
            icon: Icons.delete_outline_rounded,
            tooltip: '删除这条钩子',
            color: IrmiaTheme.danger,
            onPressed: () => unawaited(_removeHook(index))),
      ]),
    );
  }

  /// 开关一条钩子 = 原样重写一遍、只翻 `enabled`（走同一条 hook-save，
  /// 不另造 hook-toggle——参数只增不减，而且这条路径本来就要过确认短语）
  Future<void> _toggleHook(Map<String, dynamic> entry, bool enabled) async {
    try {
      await widget.state.api.post('/api/commands/hook-save', {
        'index': _int(entry['index']),
        'hook': '${entry['hook'] ?? ''}',
        'matcher': '${entry['matcher'] ?? ''}',
        'command': '${entry['command'] ?? ''}',
        'timeoutMs': _int(entry['timeoutMs']),
        if ('${entry['if'] ?? ''}'.isNotEmpty) 'if': '${entry['if']}',
        'enabled': enabled,
      }, confirm: 'hook-save');
      if (mounted) _toast('已${enabled ? '启用' : '停用'}这条钩子——重启主进程后装配', kind: ToastKind.success);
      await load('hooks', silent: true);
    } catch (err) {
      if (mounted) _toast('切换失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  Future<void> _hookFormDialog(Map<String, dynamic>? existing) async {
    final isEdit = existing != null;
    final points = _strings(data['hooks']?['hookPoints']);
    final options = points.isEmpty ? const ['PreToolUse', 'PostToolUse', 'Wake'] : points;
    var hook = isEdit ? '${existing['hook']}' : options.first;
    if (!options.contains(hook)) hook = options.first;
    final matcherCtl = TextEditingController(text: isEdit ? '${existing['matcher']}' : '');
    final commandCtl = TextEditingController(text: isEdit ? '${existing['command']}' : '');
    final ifCtl = TextEditingController(text: isEdit ? '${existing['if'] ?? ''}' : '');
    final timeoutCtl = TextEditingController(
      text: isEdit ? '${_int(existing['timeoutMs'])}' : '${_int(data['hooks']?['defaultTimeoutMs']) == 0 ? 10000 : _int(data['hooks']?['defaultTimeoutMs'])}',
    );
    var enabled = isEdit ? existing['enabled'] != false : true;

    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (builderContext, setDialogState) {
          final scheme = Theme.of(builderContext).colorScheme;
          return AlertDialog(
            constraints: const BoxConstraints(minWidth: 440, maxWidth: 580),
            title: Text(isEdit ? '编辑钩子' : '添加钩子',
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '钩子会在执行点上跑一条外部命令：stdin 收一段 JSON 上下文，退出码 2 = 拒绝（唯一强制通道），'
                    '其他非零码不阻塞主流程。这份配置对 agent 只读。',
                    style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant),
                  ),
                  const SizedBox(height: 12),
                  Text('执行点', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 4),
                  DropdownButtonFormField<String>(
                    key: const ValueKey('hook-point'),
                    initialValue: hook,
                    isDense: true,
                    decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                    items: [for (final point in options) DropdownMenuItem(value: point, child: Text(point, style: const TextStyle(fontSize: 13)))],
                    onChanged: (value) => setDialogState(() => hook = value ?? hook),
                  ),
                  _dialogField(matcherCtl, 'matcher（正则）', fieldKey: const ValueKey('hook-field-matcher'),
                      hook == 'Wake' ? '对唤醒来源匹配：timer|file|webhook|manual|heartbeat' : '对工具名匹配：safe_edit|safe_write'),
                  _dialogField(commandCtl, 'command（交给系统 shell）', '如 node scripts/check.mjs', fieldKey: const ValueKey('hook-field-command')),
                  _dialogField(ifCtl, '触发条件（可选）', '如 pwsh(rm *)，不匹配就不起进程', fieldKey: const ValueKey('hook-field-if')),
                  _dialogField(timeoutCtl, '超时（毫秒）', '超时即杀并丢弃输出，不阻塞主流程', fieldKey: const ValueKey('hook-field-timeout')),
                  Row(
                    children: [
                      Expanded(
                        child: Text('启用（关掉 = 留在文件里但不装配）',
                            style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                      ),
                      Switch(value: enabled, onChanged: (value) => setDialogState(() => enabled = value)),
                    ],
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () async {
                  final matcher = matcherCtl.text.trim();
                  final command = commandCtl.text.trim();
                  if (matcher.isEmpty || command.isEmpty) {
                    _toast('matcher 与 command 都得填', kind: ToastKind.warn);
                    return;
                  }
                  try {
                    await widget.state.api.post('/api/commands/hook-save', {
                      if (isEdit) 'index': _int(existing['index']),
                      'hook': hook,
                      'matcher': matcher,
                      'command': command,
                      if (ifCtl.text.trim().isNotEmpty) 'if': ifCtl.text.trim(),
                      'timeoutMs': int.tryParse(timeoutCtl.text.trim()) ?? 10000,
                      'enabled': enabled,
                    }, confirm: 'hook-save');
                    if (dialogContext.mounted) Navigator.of(dialogContext).pop(true);
                  } catch (err) {
                    if (mounted) _toast('保存失败：${_clip('$err', 90)}', kind: ToastKind.error);
                  }
                },
                child: const Text('保存'),
              ),
            ],
          );
        },
      ),
    );
    _disposeSoon([matcherCtl, commandCtl, ifCtl, timeoutCtl]);
    if (saved == true && mounted) {
      _toast('已写入 data/hooks.json——重启主进程后装配', kind: ToastKind.success);
      await load('hooks', silent: true);
    }
  }

  Future<void> _removeHook(int index) async {
    final ok = await confirm(
      context,
      title: '删除这条钩子',
      body: '从 data/hooks.json 里删掉第 ${index + 1} 条。删掉之后它就不再参与任何执行点——'
          '想临时收起来用「停用」即可，不必删。',
      confirmLabel: '删除',
      danger: true,
    );
    if (!ok || !mounted) return;
    try {
      await widget.state.api.post('/api/commands/hook-remove', {'index': index}, confirm: 'hook-remove');
      if (mounted) _toast('已删除——重启主进程后生效', kind: ToastKind.success);
      await load('hooks', silent: true);
    } catch (err) {
      if (mounted) _toast('删除失败：${_clip('$err', 90)}', kind: ToastKind.error);
    }
  }

  // ── 列表摘要：每项一行，数据没读到就不给结论（不臆造 0） ──

  _Stat _statOf(_SectionDef def) {
    final view = data[def.id];
    if (view == null) {
      return (kind: errors[def.id] != null ? 'idle' : 'loading', summary: errors[def.id] != null ? '状态未知' : '读取中…');
    }
    switch (def.id) {
      case 'skills':
        final items = _maps(view['items']);
        final ignored = _ignoredOf(view, items);
        final active = items.where((item) => item['inCatalog'] == true).length;
        final pending = items
            .where((item) => item['inCatalog'] != true && !ignored.contains('${item['name'] ?? ''}'))
            .length;
        return (kind: pending > 0 ? 'idle' : 'running', summary: '$active 已生效 · $pending 待确认');
      case 'mcp':
        final servers = _maps(view['servers']);
        final running = _int(view['runningCount']);
        return (kind: running > 0 ? 'running' : (servers.isEmpty ? 'sleeping' : 'idle'), summary: '${servers.length} 个服务 · $running 已运行');
      case 'tools':
        final tools = _maps(view['tools']);
        final on = tools.where((tool) => tool['enabled'] != false).length;
        return (kind: on > 0 ? 'running' : 'sleeping', summary: '$on 件启用 / 共 ${tools.length}');
      default:
        final entries = _maps(view['entries']);
        final on = entries.where((entry) => entry['enabled'] != false).length;
        return (kind: on > 0 ? 'running' : 'sleeping', summary: '${entries.length} 条${on == entries.length ? '' : ' · $on 条生效'}');
    }
  }

  // ── 版式零件（与消息适配器页同一套手感） ──

  Widget _stack(List<Widget> children) =>
      Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);

  Widget _summaryLine(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(text, style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant)),
      );
}

/// 分区定义（左列表与详情共用一份）
typedef _SectionDef = ({String id, String title, IconData icon, String blurb});

/// 列表行的状态点（kind 给 BreathDot）与一行摘要
typedef _Stat = ({String kind, String summary});
