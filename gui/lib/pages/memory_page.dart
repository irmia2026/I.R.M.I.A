// TODO(i18n): 本文件还有 27 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/memory_page.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';

import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import 'page_chrome.dart';

/// 记忆页 —— 她的长期记忆（`data/workspace/MEMORIES/`）。
///
/// 记忆**不进上下文**（design §4.17：她要用就自己 `read_file` 读），所以磁盘是唯一真相，
/// 这个页面就是人唯一的观察窗：有没有记忆、记了什么、什么时候整理。
///
/// 三块内容各有用处：`facts.md` 是长期事实（分区渲染，条目数一眼看得出她记得多少）、
/// `episodes/` 是流水账（按日期，过期的会被并进事实并移入 `archive/`）、`diary/` 是日记。
class MemoryPage extends StatefulWidget {
  const MemoryPage({super.key, required this.state});
  final AppState state;

  @override
  State<MemoryPage> createState() => _MemoryPageState();
}

/// 清单里的一条。`path` 为 null 表示分组标题（不可点）
class _MemoryEntry {
  _MemoryEntry({required this.label, required this.bytes, this.path, this.mtime});
  final String label;
  final String? path;
  final int bytes;
  final String? mtime;
}

class _MemoryGroup {
  _MemoryGroup({required this.title, required this.note, required this.items});
  final String title;
  final String note;
  final List<_MemoryEntry> items;
}

class _MemoryPageState extends State<MemoryPage> {
  bool loading = true;
  String? error;
  Map<String, dynamic>? view;
  String? selected;
  String content = '';
  bool loadingContent = false;
  String? contentError;

  @override
  void initState() {
    super.initState();
    unawaited(load());
  }

  Future<void> load() async {
    try {
      final data = await widget.state.api.get('/api/memory');
      if (!mounted) return;
      setState(() {
        view = (data as Map).cast<String, dynamic>();
        loading = false;
        error = null;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = '$err';
      });
    }
  }

  Future<void> open(String path) async {
    setState(() {
      selected = path;
      loadingContent = true;
      contentError = null;
    });
    try {
      final data = await widget.state.api.get('/api/memory?file=${Uri.encodeComponent(path)}');
      final map = (data as Map).cast<String, dynamic>();
      if (!mounted) return;
      setState(() {
        content = (map['content'] ?? '').toString();
        loadingContent = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        contentError = '$err';
        content = '';
        loadingContent = false;
      });
    }
  }

  List<dynamic> _listOf(String key) => (view?[key] as List?) ?? const [];

  /// 分组：事实在最前（它才是"记忆"的主体），流水账与日记按时间倒序
  List<_MemoryGroup> _groups() {
    /// 清单里给了 `path` 就**原样用它**——文件在哪个子目录只有服务端知道
    /// （它就是从那儿列出来的）。界面自己拼过一次，代价是"流水账"与"归档"两组
    /// 少了 `episodes/` 那一层，点开就说文件不存在（2026-10-04 修的）。
    /// `prefix` 只服务于**老服务端**（响应里没有 `path` 时）的兜底，取值与
    /// `memoryView` 的分组一一对应。
    _MemoryEntry entryOf(Map<String, dynamic> raw, String prefix) => _MemoryEntry(
          label: '${raw['name']}',
          path: (raw['path'] as String?) ?? '$prefix${raw['name']}',
          bytes: (raw['bytes'] as num?)?.toInt() ?? 0,
          mtime: raw['mtime']?.toString(),
        );

    final facts = (view?['facts'] as Map?)?.cast<String, dynamic>();
    final sections = (facts?['sections'] as List?) ?? const [];
    return [
      _MemoryGroup(
        title: '长期事实',
        note: '关于世界与用户的稳定事实，按分区组织',
        items: [
          _MemoryEntry(
            label: 'facts.md',
            path: (facts?['path'] as String?) ?? 'MEMORIES/facts.md',
            bytes: (facts?['bytes'] as num?)?.toInt() ?? 0,
            mtime: facts?['mtime']?.toString(),
          ),
          for (final section in sections.whereType<Map>())
            _MemoryEntry(
              label: '${section['title']}'.replaceFirst('## ', ''),
              bytes: (section['lines'] as num?)?.toInt() ?? 0,
            ),
        ],
      ),
      _MemoryGroup(
        title: '其他',
        note: '黑话表与表达风格观察',
        items: [
          for (final raw in _listOf('files').whereType<Map>())
            entryOf(raw.cast<String, dynamic>(), 'MEMORIES/'),
        ],
      ),
      _MemoryGroup(
        title: '流水账',
        note: '她随手记的当天经过；超过七天会被并进事实',
        items: [
          for (final raw in _listOf('episodes').whereType<Map>())
            entryOf(raw.cast<String, dynamic>(), 'MEMORIES/episodes/'),
        ],
      ),
      _MemoryGroup(
        title: '归档',
        note: '整理过的流水账原件，只留档不再注入',
        items: [
          for (final raw in _listOf('archive').whereType<Map>())
            entryOf(raw.cast<String, dynamic>(), 'MEMORIES/episodes/archive/'),
        ],
      ),
      _MemoryGroup(
        title: '日记',
        note: '整理时写下的当天小结',
        items: [
          for (final raw in _listOf('diary').whereType<Map>())
            entryOf(raw.cast<String, dynamic>(), 'diary/'),
        ],
      ),
    ];
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        const PageHeader(title: '记忆', subtitle: '她的长期记忆：事实、流水账与日记'),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : error != null
                  ? _notice(scheme, '读取失败：$error', retry: true)
                  : Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _rail(scheme),
                        VerticalDivider(width: 1, color: scheme.outlineVariant),
                        Expanded(child: _reader(scheme)),
                      ],
                    ),
        ),
      ],
    );
  }

  Widget _rail(ColorScheme scheme) {
    return SizedBox(
      width: 320,
      child: Container(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.3),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 20),
          children: [
            _summary(scheme),
            for (final group in _groups()) ...[
              const SizedBox(height: 18),
              Text(group.title,
                  style: TextStyle(
                      fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              const SizedBox(height: 2),
              Text(group.note,
                  style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant, height: 1.4)),
              const SizedBox(height: 6),
              if (group.items.isEmpty)
                Text('（空）', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))
              else
                for (final item in group.items) _row(scheme, item),
            ],
          ],
        ),
      ),
    );
  }

  Widget _summary(ColorScheme scheme) {
    final facts = (view?['facts'] as Map?)?.cast<String, dynamic>();
    final cron = ((view?['maintain'] as Map?)?['cron'] ?? '') as Object;
    final items = ((facts?['sections'] as List?) ?? const [])
        .whereType<Map>()
        .fold<int>(0, (sum, s) => sum + ((s['lines'] as num?)?.toInt() ?? 0));
    final lines = <String>[
      '事实条目 $items 条',
      '流水账 ${_listOf('episodes').length} 份 · 归档 ${_listOf('archive').length} 份 · 日记 ${_listOf('diary').length} 篇',
      '整理节奏：$cron',
    ];
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('记忆概览',
              style: TextStyle(
                  fontSize: 12, fontWeight: FontWeight.w600, color: scheme.onSurface)),
          const SizedBox(height: 6),
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Text(line,
                  style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant, height: 1.4)),
            ),
        ],
      ),
    );
  }

  Widget _row(ColorScheme scheme, _MemoryEntry item) {
    final isFact = item.path == null;
    final active = item.path != null && item.path == selected;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: active ? scheme.primary.withValues(alpha: 0.1) : Colors.transparent,
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: item.path == null ? null : () => unawaited(open(item.path!)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(
              children: [
                if (isFact) ...[
                  Icon(Icons.subdirectory_arrow_right_rounded,
                      size: 13, color: scheme.onSurfaceVariant),
                  const SizedBox(width: 4),
                ],
                Expanded(
                  child: Text(
                    item.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: isFact ? 11.5 : 12.5,
                      color: isFact ? scheme.onSurfaceVariant : scheme.onSurface,
                      fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                    ),
                  ),
                ),
                Text(
                  isFact ? '${item.bytes} 行' : _bytes(item.bytes),
                  style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _reader(ColorScheme scheme) {
    if (selected == null) {
      final empty = view?['empty'] == true;
      return _notice(
        scheme,
        empty
            ? '她还没有写下任何记忆。\n\n'
                '记忆不在上下文里，是她用普通文件工具自己读写的：值得长期记住的事写进 '
                'MEMORIES/facts.md，当天的经过写成 episodes/<日期>.md。\n'
                '每天有一次自动整理，把过期的流水账并进事实。'
            : '从左侧挑一份来看。\n\n'
                '长期事实按分区组织：置顶、约定与承诺、稳定事实、观察、归档。',
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(18, 14, 18, 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  selected!,
                  style: const TextStyle(
                      fontFamily: 'monospace', fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
              TextButton(
                onPressed: () => unawaited(load()),
                child: const Text('刷新'),
              ),
            ],
          ),
        ),
        Divider(height: 1, color: scheme.outlineVariant),
        Expanded(
          child: loadingContent
              ? const Center(child: CircularProgressIndicator())
              : contentError != null
                  ? _notice(scheme, contentError!)
                  : content.isEmpty
                      ? _notice(scheme, '这个文件是空的。')
                      : SingleChildScrollView(
                          padding: const EdgeInsets.fromLTRB(18, 14, 18, 24),
                          child: SelectableText(
                            content,
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 12.5,
                              height: 1.6,
                            ),
                          ),
                        ),
        ),
      ],
    );
  }

  Widget _notice(ColorScheme scheme, String text, {bool retry = false}) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              text,
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, height: 1.7, color: scheme.onSurfaceVariant),
            ),
            if (retry) ...[
              const SizedBox(height: 14),
              OutlinedButton(onPressed: () => unawaited(load()), child: const Text('重试')),
            ],
          ],
        ),
      ),
    );
  }
}

String _bytes(int n) => n < 1024 ? '$n B' : '${(n / 1024).toStringAsFixed(1)} KB';
