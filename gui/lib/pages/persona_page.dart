// TODO(i18n): 本文件还有 53 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/persona_page.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

/// 人格配置页 —— 与 Web 端同构（web/pages/persona.js）。
/// 左 240px 文件树 · 右编辑工作台 · 下演化时间线（persona/updated 倒序）。
///
/// 写通道只有一条：POST /api/commands/persona-edit（{file, content}）。服务端先落旧内容
/// 版本快照、再原子写入、最后写 persona/updated{by:'human'}——GUI 的每次保存与 agent 的
/// write_persona 落在同一条审计线上，所以保存完时间线顶部立刻多一条。
/// 白名单：IDENTITY / CONSTITUTION / STYLE / STATE 四份 .md 与 RELATIONSHIPS/<名字>.md；
/// 提案区（proposals/）由 agent 产出，行内保持只读，进出去批准 / 拒绝。
///
/// 编辑是「直接可编辑」：正文一到手就能改，没有额外的编辑态开关（少一次点击）。
/// 防误触交给两道门——未改动时「保存」与「恢复原状」都禁用；切文件时若有未保存改动先问一次。
class PersonaPage extends StatefulWidget {
  const PersonaPage({super.key, required this.state});
  final AppState state;
  @override
  State<PersonaPage> createState() => _PersonaPageState();
}

/// 常驻层预算口径：与 Web 端同一根「合计 / 1.5k」刻度
const _budgetTokens = 1500;

/// 正文上限：与 src/web/server.ts 的 validatePersonaEdit 同一根线（64 KB）
const _maxEditBytes = 64 * 1024;

/// 可直编的顶层四份（后端白名单的 UI 副本；其余可编辑项是 RELATIONSHIPS/ 下一级 .md）
const _personaCoreFiles = {'IDENTITY.md', 'CONSTITUTION.md', 'STYLE.md', 'STATE.md'};

/// 核心人格：改动影响后续所有行为，编辑区底部常驻警示
const _coreWarningFiles = {'IDENTITY.md', 'CONSTITUTION.md'};
const _coreWarning = '这是核心人格：改动会影响后续所有行为';

const _mono = TextStyle(fontFamily: 'monospace');

/// 可直编判定：与后端 validatePersonaEdit 的白名单同一口径
bool _editablePath(String path) {
  if (_personaCoreFiles.contains(path)) return true;
  final segs = path.split('/');
  return segs.length == 2 && segs[0] == 'RELATIONSHIPS' && segs[1].endsWith('.md');
}

class _PersonaPageState extends State<PersonaPage> {
  List<Map<String, dynamic>> files = const [];
  List<Map<String, dynamic>> history = const [];
  Map<String, dynamic>? current;
  bool loadingFiles = true, loadingHistory = true, loadingCurrent = false;
  String? filesError, historyError, currentError, selectedPath;
  bool relOpen = true;
  int? expandedSeq;

  /// 编辑工作台：控制器 + 服务端原文快照（脏状态的唯一基准）+ 保存中标志
  final _editor = TextEditingController();
  final _editorScroll = ScrollController();
  String _baseText = '';
  bool saving = false;

  /// 提案决定（批准 / 拒绝）正在飞：两颗按钮一起禁用，防重复提交
  bool decidingProposal = false;

  /// 上一次已渲染的脏状态：只有翻转时才重建整页（逐字输入不牵动时间线）
  bool _lastDirty = false;

  bool get _dirty => _editor.text != _baseText;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChange);
    _editor.addListener(_onEditorChanged);
    unawaited(loadAll());
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChange);
    _editor.removeListener(_onEditorChanged);
    _editor.dispose();
    _editorScroll.dispose();
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && (filesError != null || historyError != null)) unawaited(loadAll());
  }

  /// 脏状态翻转才整页重建；字节数由底部提示自己监听控制器
  void _onEditorChanged() {
    final dirty = _dirty;
    if (dirty == _lastDirty) return;
    _lastDirty = dirty;
    if (mounted) setState(() {});
  }

  Future<void> loadAll() async { await Future.wait([loadFiles(), loadHistory()]); }
  Future<void> reload() async {
    final path = selectedPath;
    await Future.wait([loadFiles(), loadHistory(), if (path != null) loadFile(path)]);
  }
  Future<void> loadFiles() async {
    setState(() { loadingFiles = true; filesError = null; });
    try {
      final data = await widget.state.api.get('/api/persona/files');
      final raw = (data is Map && data['files'] is List) ? data['files'] as List : const <dynamic>[];
      final parsed = raw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      if (!mounted) return;
      setState(() { files = parsed; loadingFiles = false; });
      // 首屏自动选中第一份（与 Web 同一条节奏）
      if (selectedPath == null && parsed.isNotEmpty) await loadFile(parsed.first['path']?.toString() ?? '');
    } catch (err) {
      if (mounted) setState(() { filesError = err.toString(); loadingFiles = false; });
    }
  }
  Future<void> loadHistory() async {
    setState(() { loadingHistory = true; historyError = null; });
    try {
      final data = await widget.state.api.get('/api/persona/history');
      final raw = (data is Map && data['entries'] is List) ? data['entries'] as List : const <dynamic>[];
      final parsed = raw.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
      if (!mounted) return;
      setState(() { history = parsed; loadingHistory = false; });
    } catch (err) {
      if (mounted) setState(() { historyError = err.toString(); loadingHistory = false; });
    }
  }

  /// 取一份人格文件。切到别的文件且当前有未保存改动时先问一次——用户写的东西
  /// 不该因为一次误点就没了；同一文件重新加载则只换元信息，正文与输入保持原样。
  Future<void> loadFile(String path, {bool force = false}) async {
    final switching = path != selectedPath;
    if (switching && _dirty && !force) {
      final leave = await confirm(
        context,
        title: '放弃未保存的改动？',
        body: '${selectedPath ?? '当前文件'} 的改动尚未保存，切换到 $path 后这些改动会丢失。',
        confirmLabel: '放弃改动',
        danger: true,
      );
      if (!leave || !mounted) return;
    }
    setState(() { selectedPath = path; loadingCurrent = true; currentError = null; });
    try {
      final data = await widget.state.api.get('/api/persona/file?path=${Uri.encodeComponent(path)}');
      if (!mounted) return;
      final view = data is Map ? Map<String, dynamic>.from(data) : null;
      // 服务端内容只在「不是同一个文件」或「本地没有待保存改动」时才回填输入框
      if (view != null && (switching || force || !_dirty)) _seedEditor(view['content']?.toString() ?? '');
      setState(() { current = view; currentError = view == null ? '无法读取该文件' : null; loadingCurrent = false; });
    } catch (err) {
      if (mounted) setState(() { current = null; currentError = err.toString(); loadingCurrent = false; });
    }
  }

  /// 输入框以服务端原文为基准重新落子（保存成功、切文件、刷新各走一次）。
  /// 内容一致时不动输入框：重设 text 会把光标顶回开头。
  void _seedEditor(String content) {
    _baseText = content;
    if (_editor.text != content) _editor.text = content;
    _lastDirty = _dirty;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_editorScroll.hasClients) _editorScroll.jumpTo(0);
    });
  }

  /// 单文件接口不带 by：从演化记录反查最近一次改动的人（Web 端同一口径）
  String? _lastEditor(String path) {
    for (final e in history) {
      if (e['file']?.toString() == path && (e['by']?.toString() ?? '').isNotEmpty) return e['by'].toString();
    }
    return null;
  }

  // ── 写：直编人格文件 ──

  /// 保存当前文件。失败时绝不碰输入框与基准值——用户写的内容留在原地，按钮继续可用。
  Future<void> _save() async {
    final path = selectedPath;
    if (path == null || saving) return;
    final content = _editor.text;
    if (content.trim().isEmpty) {
      _toast('内容不能为空，未保存', kind: ToastKind.warn);
      return;
    }
    final bytes = utf8.encode(content).length;
    if (bytes > _maxEditBytes) {
      _toast('内容过大（$bytes 字节，上限 $_maxEditBytes），未保存', kind: ToastKind.warn);
      return;
    }

    setState(() => saving = true);
    try {
      final data = await widget.state.api
          .post('/api/commands/persona-edit', {'file': path, 'content': content});
      if (!mounted) return;
      // 服务端在内容与当前一致时回 {changed:false} 且不写事件：别说成「已保存」
      final changed = !(data is Map && data['changed'] == false);
      _baseText = content;
      // 以此刻真实脏状态为准：保存期间用户可能又改了（那仍然是脏的，不能谎报干净）
      _lastDirty = _dirty;
      setState(() => saving = false);
      _toast(changed ? '已保存' : '内容与当前一致，未写入',
          kind: changed ? ToastKind.success : ToastKind.info);
      // 文件树（字节 / 时间）与时间线（顶部新增一条 persona/updated）跟着刷新
      unawaited(loadFiles());
      unawaited(loadHistory());
      // 改的可能正是 IDENTITY.md 的「名字：」那一行（她叫什么就写在那里）：
      // 重读一遍，窗口标题 / 侧栏品牌区 / 托盘提示跟着换，不用重开界面
      unawaited(widget.state.refreshHerName());
    } catch (err) {
      if (!mounted) return;
      setState(() => saving = false);
      _toast('保存失败：$err', kind: ToastKind.error);
    }
  }

  /// 恢复原状：丢弃本次改动，回到服务端原文
  void _revert() {
    if (!_dirty) return;
    _editor.text = _baseText;
  }

  // ── 提案区：批准 / 拒绝（POST /api/commands/persona-approve | persona-reject） ──

  /// 这份文件在门口等着的提案有几份。
  ///
  /// 数从**文件清单**来（`/api/persona/files` 的 `proposalCount`），不从单文件视图来：
  /// 后者只有正文与元信息，不带提案计数（src/web/server.ts 的 readPersonaFileView）。
  int _proposalCountOf(String path) {
    for (final f in files) {
      if ((f['path']?.toString() ?? '') != path) continue;
      return (f['proposalCount'] as num?)?.toInt() ?? (f['proposals'] as num?)?.toInt() ?? 0;
    }
    return 0;
  }

  /// 批准 = 提案内容写进目标文件（服务端还写一条 persona/updated）；拒绝 = 只删提案文件，
  /// 人格文件一个字不动、也不写事件（server.ts 的 `persona-reject` 注释里写着这条口径）。
  ///
  /// 两条都先过确认框：批准会**真的改人格资产**，拒绝会**删掉 agent 写的那份提案**——
  /// 都是不可撤销的动作，不能让一次误点决定。批准时不带 `diffHash`（界面没有提案正文可比对），
  /// 服务端允许留空；它只在"提案审阅期间被改写"时才需要比对。
  Future<void> _decideProposal(String path, {required bool approve}) async {
    if (decidingProposal) return;
    final dirty = _dirty;
    final ok = await confirm(
      context,
      title: approve ? '批准这份提案？' : '拒绝这份提案？',
      body: approve
          ? '提案的内容会写入 $path，并记一条 persona/updated（与你自己保存走同一条审计线）。'
              '${dirty ? '你现在有未保存的改动，批准之后编辑区会以写入后的正文为准——那些改动会丢。' : ''}'
          : '$path 会保留现状，只删掉那份提案文件（不写事件）。要再看到它，得等 agent 重新提一次。',
      confirmLabel: approve ? '批准' : '拒绝',
      danger: !approve,
    );
    if (!ok || !mounted) return;

    setState(() => decidingProposal = true);
    try {
      await widget.state.api.post(
        approve ? '/api/commands/persona-approve' : '/api/commands/persona-reject',
        {'file': path},
      );
      if (!mounted) return;
      setState(() => decidingProposal = false);
      _toast(approve ? '已批准，提案已写入 $path' : '已拒绝，提案已删除',
          kind: approve ? ToastKind.success : ToastKind.info);
      // 计数要跟着变（提案没了），时间线在批准时多一条 persona/updated
      unawaited(loadFiles());
      if (approve) {
        unawaited(loadHistory());
        // 批准改的是盘上那份文件：重读正文（force = 用户已在确认框里被告知改动会丢）
        unawaited(loadFile(path, force: true));
        // 提案可能改的正是 IDENTITY.md 的「名字：」那一行，与保存后同一条纪律
        unawaited(widget.state.refreshHerName());
      }
    } catch (err) {
      if (!mounted) return;
      setState(() => decidingProposal = false);
      _toast('${approve ? '批准' : '拒绝'}失败：$err', kind: ToastKind.error);
    }
  }

  /// 提案区那条横幅：告诉人门口有一份提案、两条出路各是什么意思。
  ///
  /// 放在正文**上方**（而不是塞进工具栏）：它是"这份文件现在处于待决定状态"这件事的提示，
  /// 与"保存 / 恢复原状"（对正文的编辑动作）不是一回事。文案与 `_readOnly` 里那句
  /// 「提案请用批准 / 拒绝处理」同一条口径——那句话说出口的按钮就在这里。
  Widget _proposalBar(String path, int count) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 12, 8),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.06),
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(children: [
        Icon(Icons.rate_review_outlined, size: 16, color: scheme.primary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            '$path 有 $count 份待确认提案：批准会把它写入这份文件，拒绝只删掉提案。',
            style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
          ),
        ),
        const SizedBox(width: 10),
        TextButton(
          onPressed: decidingProposal ? null : () => unawaited(_decideProposal(path, approve: false)),
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            minimumSize: const Size(0, 30),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: const Text('拒绝提案'),
        ),
        const SizedBox(width: 6),
        FilledButton.tonal(
          onPressed: decidingProposal ? null : () => unawaited(_decideProposal(path, approve: true)),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 14),
            minimumSize: const Size(0, 30),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: const Text('批准提案'),
        ),
      ]),
    );
  }

  /// 提示条统一走 ui_kit 的全局单例 toast：同一时刻只有一条，页面里不再自己 showSnackBar
  void _toast(String text, {ToastKind kind = ToastKind.info}) {
    if (!mounted) return;
    IrmiaToast.show(context, text, kind: kind);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final head = PageHeader(
      title: '人格配置',
      subtitle: '人格资产、常驻层与演化记录',
      action: IconButton(
        onPressed: () => unawaited(reload()),
        icon: const Icon(Icons.refresh_rounded, size: 19),
        color: scheme.onSurfaceVariant,
        tooltip: '重新加载',
      ),
    );
    final pane = Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SizedBox(width: 240, child: _tree()),
      const SizedBox(width: 16),
      Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Expanded(flex: 3, child: _content()),
        const SizedBox(height: 16),
        Expanded(flex: 2, child: _timeline()),
      ])),
    ]);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      head,
      const SizedBox(height: 12),
      Expanded(child: Padding(padding: const EdgeInsets.fromLTRB(26, 0, 26, 22), child: pane)),
    ]);
  }

  Widget _tree() {
    final top = files.where((f) => !(f['path']?.toString() ?? '').contains('/')).toList();
    final rel = files.where((f) => (f['path']?.toString() ?? '').startsWith('RELATIONSHIPS/')).toList();
    // 四态：0 正在读 · 1 读挂了 · 2 空的 · 3 有数据
    final phase = files.isEmpty ? (loadingFiles ? 0 : (filesError != null ? 1 : 2)) : 3;
    final Widget body = switch (phase) {
      0 => const _Panel(busy: true, title: '正在加载人格文件…'),
      1 => _Panel(danger: true, icon: Icons.error_outline_rounded, title: filesError!, onRetry: loadAll),
      2 => const _Panel(icon: Icons.description_outlined, title: '暂无人格文件', hint: '首次启动时写入模板，写入后在此显示。'),
      _ => ListView(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8), children: [
        for (final f in top) _treeRow(f),
        _relGroup(rel.length),
        if (relOpen) ...[
          // 关系档案为空：给一条「从这里开始」的引导（§3.3）
          if (rel.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 6, 4, 6),
              child: GuideBar(
                icon: Icons.favorite_border_rounded,
                text: '还没有关系档案。',
                actionLabel: '重新加载',
                onAction: () => unawaited(reload()),
                hint: '在 RELATIONSHIPS/ 下新建档案文件后重新加载。',
              ),
            )
          else
            for (final f in rel) _treeRow(f, indent: true),
        ],
      ]),
    };
    return _Card(title: '文档', note: files.isEmpty ? null : '${files.length} 份', child: body);
  }
  Widget _treeRow(Map<String, dynamic> file, {bool indent = false}) {
    final path = file['path']?.toString() ?? '';
    final proposals = (file['proposalCount'] as num?)?.toInt() ?? (file['proposals'] as num?)?.toInt() ?? 0;
    return _TreeRow(
        label: file['name']?.toString() ?? path, editable: _editablePath(path), indent: indent, proposals: proposals,
        selected: selectedPath == path, onTap: () => unawaited(loadFile(path)));
  }
  Widget _relGroup(int count) {
    final scheme = Theme.of(context).colorScheme;
    final arrow = Icon(relOpen ? Icons.keyboard_arrow_down_rounded : Icons.keyboard_arrow_right_rounded, size: 17, color: scheme.onSurfaceVariant);
    final style = TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: scheme.onSurface);
    return Material(color: Colors.transparent, child: InkWell(
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      onTap: () => setState(() => relOpen = !relOpen),
      child: Padding(padding: const EdgeInsets.fromLTRB(2, 9, 8, 7), child: Row(children: [
        arrow,
        const SizedBox(width: 4),
        Expanded(child: Text('RELATIONSHIPS', maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
        Text('$count', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
      ])),
    ));
  }
  Widget _content() {
    final cur = current;
    final path = cur?['path']?.toString() ?? selectedPath ?? '';
    final content = cur?['content']?.toString() ?? '';
    final editable = _editablePath(path);

    // 五态：0 没选 · 1 正在读 · 2 读挂了 · 3 没拿到视图 · 4 白名单外只读 · 5 编辑工作台
    final phase = selectedPath == null
        ? 0
        : (loadingCurrent ? 1 : (currentError != null ? 2 : (cur == null ? 3 : (editable ? 5 : 4))));
    final Widget body = switch (phase) {
      0 => const _Panel(icon: Icons.person_outline_rounded, title: '未选择文件', hint: '在左侧选择人格文件，此处显示正文与编辑区。'),
      1 => _Panel(busy: true, title: '正在加载 $path…'),
      2 => _Panel(danger: true, icon: Icons.error_outline_rounded, title: currentError!, onRetry: () => loadFile(selectedPath!)),
      3 => const _Panel(icon: Icons.description_outlined, title: '无法读取该文件内容'),
      4 => _readOnly(content),
      _ => _workbench(),
    };
    // 门口有提案时，正文上方多一条横幅（两颗按钮）：提案区唯一的入口就在这里，
    // 而 `_readOnly` 那句「提案请用批准 / 拒绝处理」说的正是它。
    final proposals = path.isEmpty ? 0 : _proposalCountOf(path);
    final cardBody = proposals == 0
        ? body
        : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            _proposalBar(path, proposals),
            Expanded(child: body),
          ]);

    final tokens = (cur?['tokens'] as num?)?.toInt() ?? 0;
    final bytes = (cur?['bytes'] as num?)?.toInt() ?? 0;
    final editor = _lastEditor(path);
    final parts = <String>[
      '最后修改 ${_stamp(cur?['mtime']?.toString())}${editor == null ? '' : ' by $editor'}',
      '估算 token：${tokens > 0 ? tokens : '—'}',
      if (bytes > 0) '${(bytes / 1024).toStringAsFixed(1)} KB',
      // 常驻预算只算顶层四份：关系档案不进常驻层
      if (!path.contains('/') && tokens > 0) '常驻层占比 ${((tokens / _budgetTokens) * 100).round()}%',
    ];

    return _Card(
      title: path.isEmpty ? '内容' : path,
      mono: true,
      note: phase == 5 ? '可编辑' : (phase == 4 ? '只读' : null),
      subtitle: cur == null ? null : parts.join(' · '),
      trailing: phase == 5 ? _toolbar() : null,
      child: cardBody,
    );
  }

  /// 工具栏右段：脏状态提示 + 恢复原状 + 保存（未改动时后两者都禁用）
  Widget _toolbar() {
    final dirty = _dirty;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      if (dirty) ...[const DirtyPill(), const SizedBox(width: 10)],
      TextButton(
        onPressed: (dirty && !saving) ? _revert : null,
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          minimumSize: const Size(0, 34),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: const Text('恢复原状'),
      ),
      const SizedBox(width: 6),
      FilledButton(
        onPressed: (dirty && !saving) ? () => unawaited(_save()) : null,
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          minimumSize: const Size(0, 34),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: const Text('保存'),
      ),
    ]);
  }

  /// 编辑工作台：细进度线（保存中）+ 等宽正文输入 + 底部提示
  Widget _workbench() {
    final scheme = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      if (saving) const LinearProgressIndicator(minHeight: 2),
      Expanded(
        // **不要再套一层 Scrollbar**（2026-10-04 撤掉）：Windows 上 Flutter 已经自己给每个
        // 纵向 Scrollable 套了一条（MaterialScrollBehavior.buildScrollbar 的 windows 分支），
        // 包装点在 Scrollable.build 里。再套一层就是两条挂在**同一个**滚动位置上，
        // 并排画出来（用户 ② 报的"右边有两条滚动条"）。
        // `_editorScroll` 仍然要留给 TextField：`_seedEditor` 换文件时要 jumpTo(0)。
        child: TextField(
          controller: _editor,
          scrollController: _editorScroll,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          keyboardType: TextInputType.multiline,
          style: _mono.copyWith(fontSize: 12.5, height: 1.7, color: scheme.onSurface),
          decoration: const InputDecoration(
            border: InputBorder.none,
            isDense: true,
            contentPadding: EdgeInsets.fromLTRB(14, 12, 14, 14),
            hintText: '（内容为空）',
          ),
        ),
      ),
      _hints(),
    ]);
  }

  /// 底部两行提示：字节数 / 上限，以及核心人格警示
  Widget _hints() {
    final scheme = Theme.of(context).colorScheme;
    final core = _coreWarningFiles.contains(selectedPath);
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 10),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: scheme.outlineVariant))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _ByteHint(controller: _editor, max: _maxEditBytes),
        if (core) ...[
          const SizedBox(height: 6),
          const Row(children: [
            Icon(Icons.warning_amber_rounded, size: 15, color: IrmiaTheme.warn),
            SizedBox(width: 6),
            Expanded(child: Text(_coreWarning, style: TextStyle(fontSize: 11.5, height: 1.5, color: IrmiaTheme.warn))),
          ]),
        ],
      ]),
    );
  }

  /// 白名单外的文件（提案区等）：只读展示，不给写入口
  Widget _readOnly(String content) {
    final scheme = Theme.of(context).colorScheme;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Container(
        padding: const EdgeInsets.fromLTRB(14, 9, 14, 9),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: scheme.outlineVariant))),
        child: Text('该文件不在可编辑名单内：提案请用批准 / 拒绝处理。',
            style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
      ),
      Expanded(child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
        child: SelectableText(
          content.isEmpty ? '（文件为空）' : content,
          style: _mono.copyWith(fontSize: 12.5, height: 1.7, color: content.isEmpty ? scheme.onSurfaceVariant : scheme.onSurface),
        ),
      )),
    ]);
  }

  Widget _timeline() {
    final proposals = files.fold<int>(0, (sum, f) => sum + ((f['proposalCount'] as num?)?.toInt() ?? (f['proposals'] as num?)?.toInt() ?? 0));
    final tail = history.isEmpty ? '' : ' · ${history.length} 条${proposals > 0 ? ' · $proposals 个待确认提案' : ''}';

    // 四态：0 正在读 · 1 读挂了 · 2 空的 · 3 有数据
    final phase = history.isEmpty ? (loadingHistory ? 0 : (historyError != null ? 1 : 2)) : 3;
    final Widget body = switch (phase) {
      0 => const _Panel(busy: true, title: '正在加载演化记录…'),
      1 => _Panel(danger: true, icon: Icons.error_outline_rounded, title: historyError!, onRetry: loadHistory),
      2 => const _Panel(icon: Icons.timeline_rounded, title: '暂无演化记录', hint: '首次 persona/updated 事件后出现条目。'),
      _ => ListView(padding: EdgeInsets.zero, children: [
        // 默认 8 行，其余收进「查看全部」（§3.4）
        CappedChildren(children: [
          for (final entry in history)
            _TimelineRow(
              entry: entry,
              expanded: (entry['seq'] as num?)?.toInt() == expandedSeq,
              onTap: () {
                final seq = (entry['seq'] as num?)?.toInt();
                setState(() => expandedSeq = expandedSeq == seq ? null : seq);
              },
            ),
        ]),
      ]),
    };

    return _Card(title: '演化时间线', note: 'persona/updated 倒序$tail', child: body);
  }
}
/// 卡片壳：surface 底 + outlineVariant 边 + radiusCard + 发丝影 + 统一页眉
class _Card extends StatelessWidget {
  const _Card({required this.title, required this.child, this.note, this.subtitle, this.trailing, this.mono = false});
  final String title;
  final Widget child;
  final String? note;
  final String? subtitle;
  final Widget? trailing;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final variant = TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant);
    final titleStyle = mono
        ? _mono.copyWith(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.onSurface)
        : TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurface);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: scheme.surface, borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard), border: Border.all(color: scheme.outlineVariant), boxShadow: IrmiaTheme.hairline),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Container(
          padding: const EdgeInsets.fromLTRB(14, 9, 14, 9),
          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: scheme.outlineVariant))),
          // 标题 + 副标题作为**一整块**占满左侧，工具栏在右侧与这一整块**垂直居中**
          // （用户 2026-10-02："对这两个边居中才对"、"这边怎么空白？"）。
          // 原来工具栏塞在标题那一行里：它跟标题对齐，于是标题下方那块空间成了空白，
          // 而右边的高度本该由这两行整体去分。
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Flexible(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: titleStyle)),
                    if (note != null) ...[
                      const SizedBox(width: 8),
                      Flexible(child: Text(note!, maxLines: 1, overflow: TextOverflow.ellipsis, style: variant)),
                    ],
                  ]),
                  if (subtitle != null) ...[
                    const SizedBox(height: 4),
                    Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: variant),
                  ],
                ]),
              ),
              if (trailing != null) ...[const SizedBox(width: 12), trailing!],
            ],
          ),
        ),
        Expanded(child: child),
      ]),
    );
  }
}
/// 四态占位：loading / error / empty 共用一块（文案诚实，不假装有内容）
class _Panel extends StatelessWidget {
  const _Panel({required this.title, this.hint, this.icon, this.onRetry, this.busy = false, this.danger = false});
  final String title;
  final String? hint;
  final IconData? icon;
  final Future<void> Function()? onRetry;
  final bool busy;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final hintStyle = TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant);
    final titleStyle = TextStyle(fontSize: 13.5, height: 1.5, fontWeight: danger ? FontWeight.w600 : FontWeight.w400, color: danger ? IrmiaTheme.danger : scheme.onSurfaceVariant);
    return Center(child: Padding(padding: const EdgeInsets.all(20), child: Column(mainAxisSize: MainAxisSize.min, children: [
      if (busy) const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2)) else Icon(icon ?? Icons.info_outline_rounded, size: 24, color: scheme.onSurfaceVariant),
      const SizedBox(height: 10),
      Text(title, textAlign: TextAlign.center, style: titleStyle),
      if (hint != null) ...[const SizedBox(height: 4), Text(hint!, textAlign: TextAlign.center, style: hintStyle)],
      if (onRetry != null) ...[const SizedBox(height: 12), OutlinedButton(onPressed: () => unawaited(onRetry!()), child: const Text('重试'))],
    ])));
  }
}

/// 字节数提示：直接监听控制器——逐字输入只重建这一行，不牵动整页；
/// 超上限立刻转 danger 色，再点保存会被挡下
class _ByteHint extends StatelessWidget {
  const _ByteHint({required this.controller, required this.max});
  final TextEditingController controller;
  final int max;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: controller,
      builder: (context, value, _) {
        final bytes = utf8.encode(value.text).length;
        return Text(
          '$bytes 字节 / 上限 ${max ~/ 1024} KB',
          style: _mono.copyWith(fontSize: 11.5, color: bytes > max ? IrmiaTheme.danger : scheme.onSurfaceVariant),
        );
      },
    );
  }
}

class _TreeRow extends StatelessWidget {
  const _TreeRow({required this.label, required this.selected, required this.onTap, this.editable = false, this.proposals = 0, this.indent = false});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  /// 可直编（顶层四份与关系档案）：行尾挂铅笔；白名单外的行保持只读标记
  final bool editable;
  final int proposals;
  final bool indent;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final tone = selected ? scheme.primary : scheme.onSurfaceVariant;
    final style = TextStyle(fontSize: 13, fontWeight: selected ? FontWeight.w600 : FontWeight.w400, color: selected ? scheme.primary : scheme.onSurface);
    final row = Row(children: [
      Icon(editable ? Icons.description_outlined : Icons.lock_outline, size: 16, color: tone),
      const SizedBox(width: 8),
      Expanded(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: style)),
      if (proposals > 0) ...[const SizedBox(width: 6), _chip(scheme, '提案 $proposals')],
      const SizedBox(width: 6),
      if (editable)
        Tooltip(message: '可编辑', child: Icon(Icons.edit_outlined, size: 16, color: tone))
      else
        Tooltip(message: '只读', child: Icon(Icons.lock_outline, size: 16, color: scheme.onSurfaceVariant)),
    ]);
    return Padding(
      padding: EdgeInsets.only(left: indent ? 16 : 0, bottom: 2),
      child: Material(
        color: selected ? scheme.surfaceContainerHighest : Colors.transparent,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: InkWell(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          onTap: onTap,
          child: Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8), child: row),
        ),
      ),
    );
  }
}
class _TimelineRow extends StatelessWidget {
  const _TimelineRow({required this.entry, required this.expanded, required this.onTap});
  final Map<String, dynamic> entry;
  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final row = Row(children: [
      SizedBox(width: 86, child: Text(_stamp(entry['ts']?.toString()), style: _mono.copyWith(fontSize: 11.5, color: scheme.onSurfaceVariant))),
      Expanded(child: Text(entry['file']?.toString() ?? '', maxLines: 1, overflow: TextOverflow.ellipsis, style: _mono.copyWith(fontSize: 12, color: scheme.onSurface))),
      const SizedBox(width: 8),
      _chip(scheme, entry['by']?.toString() ?? 'agent', accent: entry['by'] == 'human'),
      const SizedBox(width: 6),
      Icon(expanded ? Icons.expand_less_rounded : Icons.expand_more_rounded, size: 16, color: scheme.onSurfaceVariant),
    ]);
    return Material(color: Colors.transparent, child: InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 9, 14, 9),
        decoration: BoxDecoration(border: Border(top: BorderSide(color: scheme.outlineVariant))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [row, if (expanded) _detail(scheme)]),
      ),
    ));
  }

  /// 日志只留指纹、没存当时的正文：如实标出，并给出取全文的去处
  Widget _detail(ColorScheme scheme) => Container(
        margin: const EdgeInsets.only(top: 8, bottom: 2),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: BoxDecoration(color: scheme.surfaceContainer, borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl), border: Border.all(color: scheme.outlineVariant)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _kv(scheme, '事件', '#${entry['seq']} · ${_stamp(entry['ts']?.toString(), full: true)}'),
          _kv(scheme, '文件', '${entry['file']} · by ${entry['by']}'),
          _kv(scheme, 'diffHash', entry['diffHash']?.toString() ?? '—'),
          const SizedBox(height: 6),
          Text('日志仅记录本次改动的指纹，未保存正文。查看全文：CLI irmia persona diff', style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
        ]),
      );

  Widget _kv(ColorScheme scheme, String key, String value) => Padding(
        padding: const EdgeInsets.only(bottom: 5),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 66, child: Text(key, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant))),
          Expanded(child: Text(value, style: _mono.copyWith(fontSize: 11.5, height: 1.5))),
        ]),
      );
}
/// 小徽章：提案计数、改动来源共用一枚（accent = 人改的）
Widget _chip(ColorScheme scheme, String text, {bool accent = false}) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
        color: accent ? scheme.primary.withValues(alpha: 0.10) : scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: accent ? scheme.primary.withValues(alpha: 0.35) : scheme.outlineVariant),
      ),
      child: Text(text, style: TextStyle(fontSize: 10.5, color: accent ? scheme.primary : scheme.onSurfaceVariant)),
    );
String _stamp(String? iso, {bool full = false}) {
  final raw = iso ?? '';
  final dt = DateTime.tryParse(raw)?.toLocal();
  if (dt == null) return raw.isEmpty ? '—' : raw;
  String two(int v) => v.toString().padLeft(2, '0');
  final day = full ? '${dt.year}-${two(dt.month)}-${two(dt.day)}' : '${two(dt.month)}-${two(dt.day)}';
  return '$day ${two(dt.hour)}:${two(dt.minute)}${full ? ':${two(dt.second)}' : ''}';
}
