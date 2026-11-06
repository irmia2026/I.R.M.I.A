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
  String? error;
  Map<String, dynamic>? doc;

  String get _path => '/api/plugin/${widget.pluginId}/ui/${widget.viewId}';

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
      final raw = await widget.state.api.get(_path);
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
                  : PluginViewRenderer(blocks: _blocks, onRefresh: _load),
        ),
      ],
    );
  }
}

extension _StringFallback on String {
  String ifEmpty(String fallback) => trim().isEmpty ? fallback : this;
}

class PluginViewRenderer extends StatelessWidget {
  const PluginViewRenderer({super.key, required this.blocks, required this.onRefresh});

  final List<Map<String, dynamic>> blocks;
  final VoidCallback onRefresh;

  @override
  Widget build(BuildContext context) {
    if (blocks.isEmpty) {
      return Center(child: Text('这个页面没有内容', style: TextStyle(color: MoodPalette.of(context).muted)));
    }
    final children = <Widget>[];
    for (final block in blocks) {
      final widget = _buildBlock(context, block);
      if (widget == null) continue;
      if (children.isNotEmpty) children.add(const SizedBox(height: 14));
      children.add(widget);
    }
    return ListView(
      padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
      children: children,
    );
  }

  Widget? _buildBlock(BuildContext context, Map<String, dynamic> block) {
    final type = '${block['type'] ?? ''}';
    final m = MoodPalette.of(context);
    switch (type) {
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
        return _card(m, _list(m, block));
      case 'grid':
        return _card(m, _grid(context, m, block));
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
        return _actions(m, block);
      case 'empty':
        return _card(m, _empty(m, block));
      default:
        return _card(m, _empty(m, {'text': '未知的块类型：$type'}));
    }
  }

  Color _tone(MoodPalette m, String? tone) => switch (tone) {
        'ok' => IrmiaTheme.ok,
        'warn' => IrmiaTheme.warn,
        'danger' => IrmiaTheme.danger,
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

  List<Map<String, dynamic>> _itemsOf(Map<String, dynamic> block, String key) =>
      ((block[key] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

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

  Widget _list(MoodPalette m, Map<String, dynamic> block) {
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
        LayoutBuilder(
          builder: (context, constraints) {
            final gap = 12.0;
            final itemWidth = (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final item in items)
                  SizedBox(width: itemWidth, child: _gridCard(m, item)),
              ],
            );
          },
        ),
      ],
    );
  }

  Widget _gridCard(MoodPalette m, Map<String, dynamic> item) {
    final color = _tone(m, _str(item, 'tone'));
    final dots = ((item['dots'] as Map?) ?? const {}).cast<String, dynamic>();
    final filled = dots.isEmpty ? 0 : _num(dots, 'filled').round();
    final total = dots.isEmpty ? 0 : _num(dots, 'total').round();
    final tags = ((item['chips'] as List?) ?? const []).whereType<String>().toList();
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: m.chipBg,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: m.chipBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
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
          if (total > 0) ...[
            const SizedBox(height: 8),
            Row(
              children: [
                for (var i = 1; i <= total; i += 1)
                  Padding(
                    padding: const EdgeInsets.only(right: 4),
                    child: Container(
                      width: 6,
                      height: 6,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: i <= filled ? m.primary : m.track,
                      ),
                    ),
                  ),
                if (_str(item, 'subtitle').isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Text(_str(item, 'subtitle'), style: TextStyle(fontSize: 11, color: m.muted)),
                ],
              ],
            ),
          ] else if (_str(item, 'subtitle').isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(_str(item, 'subtitle'), style: TextStyle(fontSize: 11, color: m.muted)),
          ],
          if (tags.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final tag in tags)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(color: m.track, borderRadius: BorderRadius.circular(999)),
                    child: Text(tag, style: TextStyle(fontSize: 11, color: m.title)),
                  ),
              ],
            ),
          ],
        ],
      ),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_str(block, 'title').isNotEmpty) _title(m, _str(block, 'title')),
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(
            aspectRatio: aspect <= 0 ? 1.6 : aspect,
            child: src.isEmpty
                ? ColoredBox(
                    color: m.track,
                    child: Center(child: Text('没有图片', style: TextStyle(fontSize: 12, color: m.mutedSoft))),
                  )
                : Image.network(
                    src,
                    fit: BoxFit.cover,
                    errorBuilder: (context, error, stack) => ColoredBox(
                      color: m.track,
                      child: Center(child: Text('加载失败', style: TextStyle(fontSize: 12, color: m.mutedSoft))),
                    ),
                  ),
          ),
        ),
        if (_str(block, 'caption').isNotEmpty) ...[
          const SizedBox(height: 8),
          Text(_str(block, 'caption'), style: TextStyle(fontSize: 11.5, color: m.muted)),
        ],
      ],
    );
  }

  Widget _actions(MoodPalette m, Map<String, dynamic> block) {
    final items = _items(block);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final item in items)
          FilledButton.tonal(
            onPressed: _str(item, 'kind') == 'refresh' ? onRefresh : null,
            child: Text(_str(item, 'label')),
          ),
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
            child: PluginViewPage(
              state: widget.state,
              pluginId: entry.pluginId,
              viewId: entry.viewId,
              title: entry.title,
              subtitle: entry.subtitle,
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
