import 'dart:convert';
import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import 'page_chrome.dart';

IconData pluginViewIcon(String? name) => switch (name) {
      'mood' => Icons.mood_outlined,
      'emoji' => Icons.emoji_emotions_outlined,
      'chat' => Icons.chat_bubble_outline,
      'image' => Icons.image_outlined,
      'photo' => Icons.photo_library_outlined,
      'chart' => Icons.insights_outlined,
      'list' => Icons.view_list_outlined,
      'grid' => Icons.grid_view_outlined,
      'setting' => Icons.settings_outlined,
      'memory' => Icons.psychology_outlined,
      'clock' => Icons.schedule_outlined,
      'tag' => Icons.sell_outlined,
      'link' => Icons.link_outlined,
      'shield' => Icons.shield_outlined,
      'spark' => Icons.auto_awesome_outlined,
      _ => Icons.extension_outlined,
    };

IconData pluginViewSolidIcon(String? name) => switch (name) {
      'mood' => Icons.mood_rounded,
      'emoji' => Icons.emoji_emotions_rounded,
      'chat' => Icons.chat_bubble,
      'image' => Icons.image,
      'photo' => Icons.photo_library,
      'chart' => Icons.insights,
      'list' => Icons.view_list,
      'grid' => Icons.grid_view,
      'setting' => Icons.settings,
      'memory' => Icons.psychology,
      'clock' => Icons.schedule,
      'tag' => Icons.sell,
      'link' => Icons.link,
      'shield' => Icons.shield,
      'spark' => Icons.auto_awesome,
      _ => Icons.extension,
    };

class PluginViewEntry {
  const PluginViewEntry({
    required this.pluginId,
    required this.viewId,
    required this.title,
    required this.icon,
    required this.subtitle,
  });

  final String pluginId;
  final String viewId;
  final String title;
  final String icon;
  final String subtitle;

  String get keyName => '$pluginId/$viewId';

  static PluginViewEntry fromJson(Map<String, dynamic> json) => PluginViewEntry(
        pluginId: '${json['pluginId'] ?? ''}',
        viewId: '${json['viewId'] ?? ''}',
        title: '${json['title'] ?? ''}',
        icon: '${json['icon'] ?? 'extension'}',
        subtitle: '${json['subtitle'] ?? ''}',
      );
}

class PluginViewPage extends StatefulWidget {
  const PluginViewPage({
    super.key,
    required this.state,
    required this.pluginId,
    required this.viewId,
    this.title,
    this.subtitle,
  });

  final AppState state;
  final String pluginId;
  final String viewId;
  final String? title;
  final String? subtitle;

  @override
  State<PluginViewPage> createState() => _PluginViewPageState();
}

class _PluginViewPageState extends State<PluginViewPage> {
  bool loading = true;
  bool _submitting = false;
  String? error;
  Map<String, dynamic>? doc;
  final Map<String, String> _query = <String, String>{};

  String get _postPath => '/api/plugin/${widget.pluginId}/ui/${widget.viewId}';

  String get _getPath => Uri(
        path: _postPath,
        queryParameters: _query.isEmpty ? null : _query,
      ).toString();

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = doc == null;
      error = null;
    });
    try {
      final raw = await widget.state.api.get(_getPath);
      if (!mounted) return;
      setState(() {
        doc = (raw as Map).cast<String, dynamic>();
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        loading = false;
      });
    }
  }

  void _applyQuery(Map<String, String> q) {
    setState(() {
      for (final e in q.entries) {
        if (e.value.isEmpty) {
          _query.remove(e.key);
        } else {
          _query[e.key] = e.value;
        }
      }
    });
    _load();
  }

  Future<void> _invokeAction(Map<String, dynamic> payload) async {
    setState(() => _submitting = true);
    try {
      final res = await widget.state.api.post(_postPath, payload);
      if (!mounted) return;
      var shouldRefresh = true;
      if (res is Map) {
        final msg = res['message'];
        if (msg is String && msg.trim().isNotEmpty) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
        }
        final nextQuery = res['query'];
        if (nextQuery is Map) {
          for (final e in nextQuery.entries) {
            final k = '${e.key}';
            final v = '${e.value ?? ''}';
            if (v.isEmpty) {
              _query.remove(k);
            } else {
              _query[k] = v;
            }
          }
        }
        if (res['refresh'] == false) {
          shouldRefresh = false;
        }
      }
      if (shouldRefresh) {
        await _load();
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('操作失败：$e')));
      }
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  List<Map<String, dynamic>> get _blocks =>
      ((doc?['blocks'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        PageHeader(
          title: widget.title ?? '${doc?['title'] ?? ''}'.ifEmpty('插件页'),
          subtitle: widget.subtitle ?? '来自 ${widget.pluginId}',
          action: IconButton(
            onPressed: _submitting ? null : _load,
            icon: _submitting
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.refresh_rounded, size: 18),
            tooltip: '刷新',
          ),
        ),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : error != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('读取失败：$error', textAlign: TextAlign.center),
                            const SizedBox(height: 12),
                            FilledButton.tonal(onPressed: _load, child: const Text('重试')),
                          ],
                        ),
                      ),
                    )
                  : PluginViewRenderer(
                      blocks: _blocks,
                      apiBaseUrl: widget.state.api.baseUrl,
                      apiToken: widget.state.api.token,
                      busy: _submitting,
                      onRefresh: _load,
                      onQuery: _applyQuery,
                      onInvoke: _invokeAction,
                    ),
        ),
      ],
    );
  }
}

extension _StringFallback on String {
  String ifEmpty(String fallback) => trim().isEmpty ? fallback : this;
}

class PluginViewRenderer extends StatelessWidget {
  const PluginViewRenderer({
    super.key,
    required this.blocks,
    this.apiBaseUrl,
    this.apiToken,
    this.busy = false,
    required this.onRefresh,
    this.onQuery,
    this.onInvoke,
  });

  final List<Map<String, dynamic>> blocks;
  final String? apiBaseUrl;
  final String? apiToken;
  final bool busy;
  final VoidCallback onRefresh;
  final void Function(Map<String, String>)? onQuery;
  final Future<void> Function(Map<String, dynamic>)? onInvoke;

  @override
  Widget build(BuildContext context) {
    final m = MoodPalette.of(context);
    if (blocks.isEmpty) {
      return Center(child: Text('这个页面没有内容', style: TextStyle(color: m.muted)));
    }
    final children = <Widget>[];
    for (final block in blocks) {
      final widget = _buildBlock(context, m, block);
      if (widget == null) continue;
      if (children.isNotEmpty) children.add(const SizedBox(height: 14));
      children.add(widget);
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
      children: children,
    );
  }

  Widget? _buildBlock(BuildContext context, MoodPalette m, Map<String, dynamic> block) {
    final type = '${block['type'] ?? ''}';
    switch (type) {
      case 'tabs':
        return _tabs(m, block);
      case 'grid':
        return _card(m, _grid(context, m, block));
      case 'form':
        return _card(m, _form(block));
      case 'section':
        return _section(m, block);
      case 'hero':
        return _card(m, _hero(m, block));
      case 'metrics':
        return _card(m, _metrics(m, block));
      case 'bars':
        return _card(m, _bars(m, block));
      case 'progress':
        return _card(m, _progress(m, block));
      case 'list':
        return _card(m, _list(context, m, block));
      case 'table':
        return _card(m, _table(m, block));
      case 'timeline':
        return _card(m, _timeline(m, block));
      case 'kv':
        return _card(m, _kv(m, block));
      case 'chips':
        return _card(m, _chips(m, block));
      case 'text':
        return _card(m, _text(m, block));
      case 'chart':
        return _card(m, _chart(m, block));
      case 'image':
        return _card(m, _image(m, block));
      case 'actions':
        return _actions(context, m, block);
      case 'empty':
        return _card(m, _empty(m, block));
      default:
        return _card(m, _empty(m, {'text': '未知的块类型：$type'}));
    }
  }

  Color _tone(MoodPalette m, String? tone) => switch (tone) {
        'ok' => IrmiaTheme.ok,
        'warn' => IrmiaTheme.warn,
        'danger' || 'err' => IrmiaTheme.danger,
        'muted' => m.muted,
        'joy' || 'distress' || 'concern' || 'irritation' || 'warmth' || 'shyness' => m.emotionColor(tone!),
        _ => m.primary,
      };

  String _str(Map<String, dynamic> source, String key, [String fallback = '']) {
    final value = source[key];
    return value == null ? fallback : '$value';
  }

  double _num(Map<String, dynamic> source, String key, [double fallback = 0]) {
    final value = source[key];
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value) ?? fallback;
    return fallback;
  }

  List<Map<String, dynamic>> _items(Map<String, dynamic> block) =>
      ((block['items'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  List<Map<String, dynamic>> _itemsOf(Map<String, dynamic> block, String key) =>
      ((block[key] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  List<String> _stringChips(dynamic raw) {
    if (raw is! List) return const [];
    final out = <String>[];
    for (final entry in raw) {
      if (entry is String && entry.trim().isNotEmpty) {
        out.add(entry.trim());
      } else if (entry is Map && entry['label'] != null) {
        out.add('${entry['label']}');
      }
    }
    return out;
  }

  Widget _card(MoodPalette m, Widget child) => Container(
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: m.card,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: m.edge),
        ),
        child: child,
      );

  Widget _title(MoodPalette m, String text, {String? note}) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Row(
          children: [
            Expanded(
              child: Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: m.title)),
            ),
            if (note != null && note.isNotEmpty)
              Text(note, style: TextStyle(fontSize: 11, color: m.muted)),
          ],
        ),
      );

  Widget _section(MoodPalette m, Map<String, dynamic> block) => Padding(
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 0),
        child: Row(
          children: [
            Text(_str(block, 'title'), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: m.title)),
            const Spacer(),
            if (_str(block, 'note').isNotEmpty)
              Text(_str(block, 'note'), style: TextStyle(fontSize: 11, color: m.muted)),
          ],
        ),
      );

  Widget _tabs(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    final active = _str(block, 'active');
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final item in items)
          ChoiceChip(
            label: Text(_str(item, 'label')),
            selected: _str(item, 'id') == active,
            onSelected: busy
                ? null
                : (selected) {
                    if (selected && onQuery != null) {
                      onQuery!({'tab': _str(item, 'id')});
                    }
                  },
          ),
      ],
    );
  }

  Widget _hero(MoodPalette m, Map<String, dynamic> block) {
    final color = _tone(m, _str(block, 'tone'));
    final badge = _str(block, 'badge');
    final chips = _itemsOf(block, 'chips');
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (badge.isNotEmpty)
          Container(
            width: 58,
            height: 58,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color.withValues(alpha: 0.13),
              border: Border.all(color: color.withValues(alpha: 0.42)),
            ),
            alignment: Alignment.center,
            child: Text(badge, style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: color)),
          ),
        if (badge.isNotEmpty) const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                _str(block, 'title'),
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: m.heading, height: 1.35),
              ),
              if (_str(block, 'subtitle').isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(_str(block, 'subtitle'), style: TextStyle(fontSize: 12.5, color: m.muted)),
              ],
              if (chips.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  children: [for (final chip in chips) _pill(m, _str(chip, 'label'), _str(chip, 'value'), _str(chip, 'tone'))],
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _pill(MoodPalette m, String label, String value, [String tone = '']) {
    final color = tone.isEmpty ? m.ink : _tone(m, tone);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: m.chipBg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: m.chipBorder),
      ),
      child: Text.rich(
        TextSpan(
          children: [
            if (label.isNotEmpty) TextSpan(text: '$label ', style: TextStyle(fontSize: 11, color: m.muted)),
            TextSpan(text: value, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: color)),
          ],
        ),
      ),
    );
  }

  Widget _metrics(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < items.length; i += 1) ...[
              if (i > 0) const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${_str(items[i], 'value')}${_str(items[i], 'unit')}',
                      style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700, color: _tone(m, _str(items[i], 'tone'))),
                    ),
                    const SizedBox(height: 2),
                    Text(_str(items[i], 'label'), style: TextStyle(fontSize: 11.5, color: m.muted)),
                  ],
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _bars(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        if (items.isEmpty) Text('没有数据', style: TextStyle(fontSize: 12, color: m.mutedSoft)),
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 9),
            child: _barRow(m, item),
          ),
      ],
    );
  }

  Widget _barRow(MoodPalette m, Map<String, dynamic> item) {
    final color = _tone(m, _str(item, 'tone'));
    final value = _num(item, 'value').clamp(0.0, 1.0);
    final trailing = _str(item, 'trailing').ifEmpty('${(value * 100).round()}%');
    return Row(
      children: [
        SizedBox(
          width: 70,
          child: Row(
            children: [
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: color,
                  shape: BoxShape.circle,
                  boxShadow: [BoxShadow(color: color.withValues(alpha: 0.13), spreadRadius: 3)],
                ),
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  _str(item, 'label'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: m.ink),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: SizedBox(
            height: 6,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ColoredBox(color: m.track),
                  FractionallySizedBox(
                    alignment: Alignment.centerLeft,
                    widthFactor: value.toDouble(),
                    child: ColoredBox(color: color),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 12),
        SizedBox(
          width: 44,
          child: Text(trailing, textAlign: TextAlign.right, style: TextStyle(fontSize: 11.5, color: m.muted)),
        ),
      ],
    );
  }

  Widget _progress(MoodPalette m, Map<String, dynamic> block) {
    final color = _tone(m, _str(block, 'tone'));
    final value = _num(block, 'value').clamp(0.0, 1.0);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        Row(
          children: [
            Expanded(child: Text(_str(block, 'label'), style: TextStyle(fontSize: 12.5, color: m.ink))),
            Text('${(value * 100).round()}%', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: color)),
          ],
        ),
        const SizedBox(height: 8),
        SizedBox(
          height: 8,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(99),
            child: Stack(
              fit: StackFit.expand,
              children: [
                ColoredBox(color: m.track),
                FractionallySizedBox(
                  alignment: Alignment.centerLeft,
                  widthFactor: value.toDouble(),
                  child: ColoredBox(color: color),
                ),
              ],
            ),
          ),
        ),
        if (_str(block, 'footer').isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(_str(block, 'footer'), style: TextStyle(fontSize: 11.5, color: m.muted)),
        ],
      ],
    );
  }

  Widget _list(BuildContext context, MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        if (items.isEmpty) Text('没有记录', style: TextStyle(fontSize: 12, color: m.mutedSoft)),
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(shape: BoxShape.circle, color: _tone(m, _str(item, 'tone'))),
                  ),
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_str(item, 'label'), style: TextStyle(fontSize: 12.5, color: m.ink)),
                      if (_str(item, 'detail').isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(_str(item, 'detail'), style: TextStyle(fontSize: 11.5, color: m.mutedSoft)),
                        ),
                      if (_itemsOf(item, 'actions').isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Wrap(
                            spacing: 6,
                            runSpacing: 6,
                            children: [
                              for (final action in _itemsOf(item, 'actions'))
                                _actionButton(context, m, action, compact: true),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                if (_str(item, 'trailing').isNotEmpty)
                  Text(_str(item, 'trailing'), style: TextStyle(fontSize: 12, color: m.muted)),
              ],
            ),
          ),
      ],
    );
  }

  Widget _grid(BuildContext context, MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    final width = MediaQuery.sizeOf(context).width;
    final columns = width > 1400 ? 4 : width > 1050 ? 3 : width > 720 ? 2 : 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        if (items.isEmpty) Text('没有条目', style: TextStyle(fontSize: 12, color: m.mutedSoft)),
        if (items.isNotEmpty)
          LayoutBuilder(
            builder: (ctx, constraints) {
              const gap = 12.0;
              final itemWidth = (constraints.maxWidth - gap * (columns - 1)) / columns;
              return Wrap(
                spacing: gap,
                runSpacing: gap,
                children: [
                  for (final item in items)
                    SizedBox(width: itemWidth, child: _gridCard(ctx, m, item)),
                ],
              );
            },
          ),
      ],
    );
  }

  Widget _gridCard(BuildContext context, MoodPalette m, Map<String, dynamic> item) {
    final color = _tone(m, _str(item, 'tone'));
    final image = _str(item, 'image');
    final dots = item['dots'];
    final chips = _stringChips(item['chips']);
    final actions = _itemsOf(item, 'actions');
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: m.chipBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: m.chipBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (image.isNotEmpty)
            Container(
              height: 132,
              width: double.infinity,
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                color: m.track,
                borderRadius: BorderRadius.circular(8),
              ),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(8),
                child: _buildImage(m, image, BoxFit.contain),
              ),
            ),
          Row(
            children: [
              Expanded(
                child: Text(
                  _str(item, 'title'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: m.ink),
                ),
              ),
              if (_str(item, 'badge').isNotEmpty)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: color.withValues(alpha: 0.13),
                    borderRadius: BorderRadius.circular(999),
                    border: Border.all(color: color.withValues(alpha: 0.36)),
                  ),
                  child: Text(
                    _str(item, 'badge'),
                    style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: color),
                  ),
                ),
            ],
          ),
          if (dots is Map) ...[
            const SizedBox(height: 6),
            Row(
              children: [
                for (var i = 0; i < ((dots['total'] as num?)?.toInt() ?? 5); i += 1)
                  Container(
                    width: 6,
                    height: 6,
                    margin: const EdgeInsets.only(right: 4),
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i < ((dots['filled'] as num?)?.toInt() ?? 0) ? color : m.track,
                    ),
                  ),
              ],
            ),
          ],
          if (_str(item, 'subtitle').isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(_str(item, 'subtitle'), style: TextStyle(fontSize: 11, color: m.muted)),
          ],
          if (chips.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (final chip in chips)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: m.card,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: m.edge),
                    ),
                    child: Text(chip, style: TextStyle(fontSize: 10.5, color: m.muted)),
                  ),
              ],
            ),
          ],
          if (actions.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final action in actions)
                  _actionButton(context, m, action, compact: true),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _actionButton(BuildContext context, MoodPalette m, Map<String, dynamic> item, {bool compact = false}) {
    final kind = _str(item, 'kind');
    final actionName = _str(item, 'action');
    final tone = _str(item, 'tone');
    final enabled = !busy &&
        (kind == 'refresh' ||
            (kind == 'query' && onQuery != null) ||
            (actionName.isNotEmpty && onInvoke != null));
    final fg = (tone == 'ok' || tone == 'err' || tone == 'danger' || tone == 'warn') ? _tone(m, tone) : null;
    return FilledButton.tonal(
      style: FilledButton.styleFrom(
        visualDensity: compact ? VisualDensity.compact : VisualDensity.standard,
        padding: compact ? const EdgeInsets.symmetric(horizontal: 10, vertical: 6) : null,
        foregroundColor: fg,
      ),
      onPressed: enabled ? () => _handleItemTap(context, item) : null,
      child: Text(_str(item, 'label'), style: compact ? const TextStyle(fontSize: 12) : null),
    );
  }

  void _handleItemTap(BuildContext context, Map<String, dynamic> item) {
    final kind = _str(item, 'kind');
    if (kind == 'refresh') {
      onRefresh();
      return;
    }
    if (kind == 'query') {
      final raw = item['query'];
      if (raw is Map && onQuery != null) {
        onQuery!(raw.map((k, v) => MapEntry('$k', '${v ?? ''}')));
      }
      return;
    }
    _runAction(context, item);
  }

  Future<void> _runAction(BuildContext context, Map<String, dynamic> item) async {
    final confirm = _str(item, 'confirm');
    if (confirm.isNotEmpty) {
      final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('确认操作'),
          content: Text(confirm),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('取消')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('确定')),
          ],
        ),
      );
      if (yes != true || !context.mounted) return;
    }

    final promptFields = ((item['promptFields'] as List?) ?? const [])
        .whereType<Map>()
        .map((e) => e.cast<String, dynamic>())
        .toList();
    final params = <String, dynamic>{};
    if (promptFields.isNotEmpty) {
      final result = await showDialog<Map<String, dynamic>>(
        context: context,
        builder: (ctx) => _PromptModal(fields: promptFields, title: _str(item, 'label').ifEmpty('编辑参数')),
      );
      if (result == null) return;
      params.addAll(result);
    }

    if (onInvoke != null) {
      await onInvoke!({
        'action': _str(item, 'action'),
        ...((item['params'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{}),
        ...params,
      });
    }
  }

  Widget _form(Map<String, dynamic> block) {
    return _PluginFormBlock(
      block: block,
      busy: busy,
      onSubmit: (values) {
        if (_str(block, 'kind') == 'query') {
          if (onQuery != null) {
            onQuery!(values.map((k, v) => MapEntry(k, '${v ?? ''}')));
          }
          return;
        }
        if (onInvoke != null) {
          onInvoke!({
            'action': _str(block, 'action'),
            ...((block['params'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{}),
            ...values,
          });
        }
      },
    );
  }

  Widget _table(MoodPalette m, Map<String, dynamic> block) {
    final headers = ((block['headers'] as List?) ?? const []).whereType<String>().toList();
    final rows = ((block['rows'] as List?) ?? const [])
        .whereType<List>()
        .map((row) => row.map((cell) => '$cell').toList())
        .toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        if (headers.isNotEmpty)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 10),
            decoration: BoxDecoration(color: m.chipBg, borderRadius: BorderRadius.circular(8)),
            child: Row(
              children: [
                for (final header in headers)
                  Expanded(
                    child: Text(
                      header,
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: m.muted),
                    ),
                  ),
              ],
            ),
          ),
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 7, horizontal: 10),
            child: Row(
              children: [
                for (var i = 0; i < headers.length; i += 1)
                  Expanded(
                    child: Text(
                      i < row.length ? row[i] : '',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: m.ink),
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _timeline(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        if (items.isEmpty) Text('没有事件', style: TextStyle(fontSize: 12, color: m.mutedSoft)),
        for (var i = 0; i < items.length; i += 1)
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 64,
                  child: Text(
                    _str(items[i], 'at'),
                    style: TextStyle(fontSize: 11, color: m.muted, fontFeatures: const [FontFeature.tabularFigures()]),
                  ),
                ),
                Column(
                  children: [
                    Container(
                      width: 8,
                      height: 8,
                      margin: const EdgeInsets.only(top: 4),
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: _tone(m, _str(items[i], 'tone')),
                      ),
                    ),
                    if (i != items.length - 1)
                      Expanded(child: Container(width: 1.5, color: m.edge)),
                  ],
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(bottom: i == items.length - 1 ? 0 : 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(_str(items[i], 'label'), style: TextStyle(fontSize: 12.5, color: m.ink)),
                        if (_str(items[i], 'detail').isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Text(_str(items[i], 'detail'), style: TextStyle(fontSize: 11.5, color: m.mutedSoft)),
                          ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _kv(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: 88,
                  child: Text(_str(item, 'key'), style: TextStyle(fontSize: 12, color: m.muted)),
                ),
                Expanded(
                  child: Text(_str(item, 'value'), style: TextStyle(fontSize: 12, color: m.ink)),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _chips(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final item in items)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(
                  color: _tone(m, _str(item, 'tone')).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: _tone(m, _str(item, 'tone')).withValues(alpha: 0.3)),
                ),
                child: Text(
                  _str(item, 'label'),
                  style: TextStyle(fontSize: 11.5, color: _tone(m, _str(item, 'tone'))),
                ),
              ),
          ],
        ),
      ],
    );
  }

  Widget _text(MoodPalette m, Map<String, dynamic> block) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
          Text(_str(block, 'body'), style: TextStyle(fontSize: 12.5, height: 1.6, color: m.ink)),
        ],
      );

  Widget _chart(MoodPalette m, Map<String, dynamic> block) {
    final points = ((block['points'] as List?) ?? const [])
        .map((e) => e is num ? e.toDouble() : double.tryParse('$e') ?? 0.0)
        .toList();
    final empty = _str(block, 'empty').ifEmpty('没有数据');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        if (points.isEmpty)
          SizedBox(
            height: 72,
            child: Center(child: Text(empty, style: TextStyle(fontSize: 12, color: m.mutedSoft))),
          )
        else
          SizedBox(
            height: 104,
            child: CustomPaint(
              painter: _LinePainter(
                points: points,
                min: _num(block, 'min', -1),
                max: _num(block, 'max', 1),
                line: m.chartLine,
                grid: m.chartGrid,
              ),
              size: Size.infinite,
            ),
          ),
      ],
    );
  }

  Widget _image(MoodPalette m, Map<String, dynamic> block) {
    final src = _str(block, 'src');
    final aspect = _num(block, 'aspect', 1.6);
    final fit = _str(block, 'fit') == 'contain' ? BoxFit.contain : BoxFit.cover;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(
            aspectRatio: aspect <= 0 ? 1.6 : aspect,
            child: _buildImage(m, src, fit),
          ),
        ),
        if (_str(block, 'caption').isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(_str(block, 'caption'), style: TextStyle(fontSize: 11.5, color: m.muted)),
        ],
      ],
    );
  }

  Widget _buildImage(MoodPalette m, String src, BoxFit fit) {
    Widget fallback(String text) => ColoredBox(
          color: m.track,
          child: Center(child: Text(text, style: TextStyle(fontSize: 12, color: m.mutedSoft))),
        );
    if (src.isEmpty) {
      return fallback('没有图片');
    }
    if (src.startsWith('data:image/')) {
      final comma = src.indexOf(',');
      if (comma > 0) {
        try {
          return Image.memory(
            base64Decode(src.substring(comma + 1)),
            fit: fit,
            gaplessPlayback: true,
            errorBuilder: (c, e, s) => fallback('加载失败'),
          );
        } catch (_) {
          return fallback('加载失败');
        }
      }
      return fallback('加载失败');
    }
    final hasToken = apiToken != null && apiToken!.isNotEmpty;
    if (src.startsWith('/')) {
      final fullUrl = '${apiBaseUrl ?? ''}$src';
      final headers = hasToken ? <String, String>{'Authorization': 'Bearer $apiToken'} : null;
      return Image.network(
        fullUrl,
        headers: headers,
        fit: fit,
        gaplessPlayback: true,
        errorBuilder: (c, e, s) => fallback('加载失败'),
      );
    }
    final isSameOrigin = apiBaseUrl != null && apiBaseUrl!.isNotEmpty && src.startsWith(apiBaseUrl!);
    final headers = (isSameOrigin && hasToken) ? <String, String>{'Authorization': 'Bearer $apiToken'} : null;
    return Image.network(
      src,
      headers: headers,
      fit: fit,
      gaplessPlayback: true,
      errorBuilder: (c, e, s) => fallback('加载失败'),
    );
  }

  Widget _actions(BuildContext context, MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final item in items) _actionButton(context, m, item),
      ],
    );
  }

  Widget _empty(MoodPalette m, Map<String, dynamic> block) => Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Text(_str(block, 'text'), style: TextStyle(fontSize: 12, color: m.mutedSoft)),
        ),
      );
}

List<Widget> _buildFormControls(
  BuildContext context,
  List<Map<String, dynamic>> fields,
  Map<String, dynamic> values,
  Map<String, TextEditingController> controllers,
  void Function(void Function()) update,
) {
  final m = MoodPalette.of(context);
  final out = <Widget>[];
  for (final f in fields) {
    final key = '${f['key'] ?? ''}';
    if (key.isEmpty) continue;
    final type = '${f['type'] ?? 'text'}';
    final label = '${f['label'] ?? key}';
    if (type == 'text') {
      final ctrl = controllers[key];
      final multiline = f['multiline'] == true;
      out.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: TextField(
            controller: ctrl,
            maxLines: multiline ? 4 : 1,
            decoration: InputDecoration(
              labelText: label,
              hintText: f['placeholder']?.toString(),
              isDense: true,
            ),
            onChanged: (v) => values[key] = v,
          ),
        ),
      );
    } else if (type == 'select') {
      final options = ((f['options'] as List?) ?? const []).map((e) => '$e').toList();
      final current = values[key]?.toString() ?? (options.isNotEmpty ? options.first : '');
      out.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: TextStyle(fontSize: 12, color: m.muted)),
              const SizedBox(height: 6),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final opt in options)
                    ChoiceChip(
                      label: Text(opt),
                      selected: current == opt,
                      onSelected: (sel) {
                        if (sel) update(() => values[key] = opt);
                      },
                    ),
                ],
              ),
            ],
          ),
        ),
      );
    } else if (type == 'slider') {
      final min = (f['min'] is num) ? (f['min'] as num).toDouble() : 0.0;
      final max = (f['max'] is num) ? (f['max'] as num).toDouble() : 100.0;
      final divisions = (f['divisions'] is num) ? (f['divisions'] as num).toInt() : null;
      final rawVal = values[key];
      final val = ((rawVal is num) ? rawVal.toDouble() : (double.tryParse('$rawVal') ?? min)).clamp(min, max);
      out.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$label：${val.round()}', style: TextStyle(fontSize: 12.5, color: m.ink)),
              Slider(
                value: val,
                min: min,
                max: max,
                divisions: divisions,
                onChanged: (v) => update(() => values[key] = v.round()),
              ),
            ],
          ),
        ),
      );
    } else if (type == 'switch') {
      final val = values[key] == true || values[key] == 'true';
      out.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: SwitchListTile(
            contentPadding: EdgeInsets.zero,
            dense: true,
            title: Text(label, style: TextStyle(fontSize: 12.5, color: m.ink)),
            value: val,
            onChanged: (v) => update(() => values[key] = v),
          ),
        ),
      );
    }
  }
  return out;
}

class _PromptModal extends StatefulWidget {
  const _PromptModal({required this.fields, required this.title});

  final List<Map<String, dynamic>> fields;
  final String title;

  @override
  State<_PromptModal> createState() => _PromptModalState();
}

class _PromptModalState extends State<_PromptModal> {
  final Map<String, dynamic> _values = <String, dynamic>{};
  final Map<String, TextEditingController> _controllers = <String, TextEditingController>{};

  @override
  void initState() {
    super.initState();
    for (final f in widget.fields) {
      final key = '${f['key'] ?? ''}';
      if (key.isEmpty) continue;
      _values[key] = f['value'];
      if ('${f['type'] ?? 'text'}' == 'text') {
        _controllers[key] = TextEditingController(text: '${f['value'] ?? ''}');
      }
    }
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: SizedBox(
        width: 420,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: _buildFormControls(context, widget.fields, _values, _controllers, setState),
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('取消')),
        FilledButton(onPressed: () => Navigator.pop(context, Map<String, dynamic>.from(_values)), child: const Text('确定')),
      ],
    );
  }
}

class _PluginFormBlock extends StatefulWidget {
  const _PluginFormBlock({
    required this.block,
    required this.busy,
    required this.onSubmit,
  });

  final Map<String, dynamic> block;
  final bool busy;
  final void Function(Map<String, dynamic>) onSubmit;

  @override
  State<_PluginFormBlock> createState() => _PluginFormBlockState();
}

class _PluginFormBlockState extends State<_PluginFormBlock> {
  final Map<String, dynamic> _values = <String, dynamic>{};
  final Map<String, TextEditingController> _controllers = <String, TextEditingController>{};

  List<Map<String, dynamic>> get _fields =>
      ((widget.block['fields'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  @override
  void initState() {
    super.initState();
    _syncFields();
  }

  void _syncFields() {
    for (final f in _fields) {
      final key = '${f['key'] ?? ''}';
      if (key.isEmpty) continue;
      if (!_values.containsKey(key)) {
        _values[key] = f['value'];
      }
      if ('${f['type'] ?? 'text'}' == 'text' && !_controllers.containsKey(key)) {
        _controllers[key] = TextEditingController(text: '${f['value'] ?? ''}');
      }
    }
  }

  @override
  void didUpdateWidget(covariant _PluginFormBlock oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncFields();
  }

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final m = MoodPalette.of(context);
    final title = '${widget.block['title'] ?? ''}';
    final submitLabel = '${widget.block['submitLabel'] ?? ''}'.ifEmpty('保存');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title.isNotEmpty) ...[
          Text(title, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: m.title)),
          const SizedBox(height: 12),
        ],
        ..._buildFormControls(context, _fields, _values, _controllers, setState),
        FilledButton(
          onPressed: widget.busy ? null : () => widget.onSubmit(Map<String, dynamic>.from(_values)),
          child: Text(submitLabel),
        ),
      ],
    );
  }
}

class PluginViewsPage extends StatefulWidget {
  const PluginViewsPage({super.key, required this.state});

  final AppState state;

  @override
  State<PluginViewsPage> createState() => _PluginViewsPageState();
}

class _PluginViewsPageState extends State<PluginViewsPage> {
  bool loading = true;
  String? error;
  List<PluginViewEntry> entries = const [];

  MoodPalette get _m => MoodPalette.of(context);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = entries.isEmpty;
      error = null;
    });
    try {
      final raw = await widget.state.api.get('/api/plugin/views');
      if (!mounted) return;
      final payload = (raw as Map).cast<String, dynamic>();
      final list = ((payload['views'] as List?) ?? const [])
          .whereType<Map>()
          .map((e) => PluginViewEntry.fromJson(e.cast<String, dynamic>()))
          .where((e) => e.pluginId.isNotEmpty && e.viewId.isNotEmpty)
          .toList();
      setState(() {
        entries = list;
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        loading = false;
      });
    }
  }

  void _open(PluginViewEntry entry) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => Scaffold(
          backgroundColor: _m.shell,
          body: SafeArea(
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
                  child: Row(
                    children: [
                      TextButton.icon(
                        onPressed: () => Navigator.of(context).pop(),
                        icon: const Icon(Icons.arrow_back_rounded, size: 18),
                        label: const Text('返回'),
                      ),
                      const Spacer(),
                      TextButton.icon(
                        onPressed: () => Navigator.of(context).pop(),
                        icon: const Icon(Icons.close_rounded, size: 18),
                        label: const Text('关闭'),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: PluginViewPage(
                    state: widget.state,
                    pluginId: entry.pluginId,
                    title: entry.title,
                    viewId: entry.viewId,
                    subtitle: entry.subtitle,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        PageHeader(
          title: '插件页',
          subtitle: '由插件自己声明的界面；新增插件不用重新编译',
          action: IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh_rounded, size: 18),
            tooltip: '刷新',
          ),
        ),
        Expanded(
          child: loading
              ? const Center(child: CircularProgressIndicator())
              : error != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('读取失败：$error', textAlign: TextAlign.center),
                            const SizedBox(height: 12),
                            FilledButton.tonal(onPressed: _load, child: const Text('重试')),
                          ],
                        ),
                      ),
                    )
                  : entries.isEmpty
                      ? Center(
                          child: Padding(
                            padding: const EdgeInsets.all(28),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.extension_outlined, size: 32, color: _m.mutedSoft),
                                const SizedBox(height: 12),
                                Text(
                                  '还没有插件声明界面',
                                  style: TextStyle(fontSize: 13, color: _m.muted),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  '在 plugin.json 的 contributions.views 里加一条就会出现在这里',
                                  textAlign: TextAlign.center,
                                  style: TextStyle(fontSize: 11.5, color: _m.mutedSoft),
                                ),
                              ],
                            ),
                          ),
                        )
                      : ListView.separated(
                          padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
                          itemCount: entries.length,
                          separatorBuilder: (context, index) => const SizedBox(height: 10),
                          itemBuilder: (context, index) => _tile(entries[index]),
                        ),
        ),
      ],
    );
  }

  Widget _tile(PluginViewEntry entry) {
    return InkWell(
      onTap: () => _open(entry),
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.all(15),
        decoration: BoxDecoration(
          color: _m.card,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: _m.edge),
        ),
        child: Row(
          children: [
            Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: _m.primarySoft,
                borderRadius: BorderRadius.circular(11),
              ),
              child: Icon(pluginViewIcon(entry.icon), size: 19, color: _m.primary),
            ),
            const SizedBox(width: 13),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    entry.title,
                    style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: _m.title),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    entry.subtitle.isEmpty ? entry.keyName : entry.subtitle,
                    style: TextStyle(fontSize: 11.5, color: _m.muted),
                  ),
                ],
              ),
            ),
            Icon(Icons.chevron_right_rounded, size: 18, color: _m.mutedSoft),
          ],
        ),
      ),
    );
  }
}

class _LinePainter extends CustomPainter {
  _LinePainter({
    required this.points,
    required this.min,
    required this.max,
    required this.line,
    required this.grid,
  });

  final List<double> points;
  final double min;
  final double max;
  final Color line;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final gridPaint = Paint()
      ..color = grid
      ..strokeWidth = 1;
    for (var i = 0; i <= 4; i += 1) {
      final y = size.height * i / 4;
      canvas.drawLine(Offset(0, y), Offset(size.width, y), gridPaint);
    }
    final zeroY = size.height / 2;
    canvas.drawLine(Offset(0, zeroY), Offset(size.width, zeroY), gridPaint);
    if (points.isEmpty) return;

    final span = (max - min).abs() < 1e-6 ? 1.0 : max - min;
    double yOf(double value) => size.height / 2 - ((value - min) / span - 0.5) * (size.height - 12);
    double xOf(int index) => points.length == 1 ? size.width / 2 : size.width * index / (points.length - 1);

    final path = Path();
    for (var i = 0; i < points.length; i += 1) {
      final clamped = points[i].clamp(min, max).toDouble();
      if (i == 0) {
        path.moveTo(xOf(i), yOf(clamped));
      } else {
        path.lineTo(xOf(i), yOf(clamped));
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeJoin = StrokeJoin.round
        ..strokeCap = StrokeCap.round,
    );
    for (var i = 0; i < points.length; i += 1) {
      final clamped = points[i].clamp(min, max).toDouble();
      canvas.drawCircle(Offset(xOf(i), yOf(clamped)), 2.5, Paint()..color = line);
    }
  }

  @override
  bool shouldRepaint(_LinePainter oldDelegate) =>
      oldDelegate.points != points || oldDelegate.line != line || oldDelegate.grid != grid;
}
