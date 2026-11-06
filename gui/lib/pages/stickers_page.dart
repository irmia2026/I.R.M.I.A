import 'package:flutter/material.dart';

import '../app.dart';
import '../theme.dart';
import 'page_chrome.dart';

class StickersPage extends StatefulWidget {
  const StickersPage({super.key, required this.state});
  final AppState state;

  @override
  State<StickersPage> createState() => _StickersPageState();
}

class _StickersPageState extends State<StickersPage> {
  bool loading = true;
  String? error;
  Map<String, dynamic>? view;

  MoodPalette get _m => MoodPalette.of(context);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = view == null;
      error = null;
    });
    try {
      final raw = await widget.state.api.get('/api/plugin/linre-stickers/state');
      if (!mounted) return;
      setState(() {
        view = (raw as Map).cast<String, dynamic>();
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

  List<Map<String, dynamic>> get _items =>
      ((view?['items'] as List?) ?? const []).whereType<Map>().map((e) => e.cast<String, dynamic>()).toList();

  int get _total => ((view?['total'] as num?) ?? 0).round();

  int get _approved => ((view?['approved'] as num?) ?? 0).round();

  int get _pending => ((view?['pending'] as num?) ?? 0).round();

  String get _renderLine => (view?['renderLine'] as String?) ?? '暂无可配图。';

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        PageHeader(
          title: '表情包',
          subtitle: '可配图目录；数据来自 linre-stickers 插件',
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
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(18, 6, 18, 28),
                      children: [
                        _summaryCard(),
                        const SizedBox(height: 14),
                        _catalogCard(),
                      ],
                    ),
        ),
      ],
    );
  }

  Widget _card({required Widget child, EdgeInsets padding = const EdgeInsets.all(18)}) {
    final m = _m;
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: m.card,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: m.edge),
      ),
      child: child,
    );
  }

  Widget _sectionTitle(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Text(text, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _m.title)),
    );
  }

  Widget _summaryCard() {
    final m = _m;
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 58,
                height: 58,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  color: m.primary.withValues(alpha: 0.13),
                  border: Border.all(color: m.primary.withValues(alpha: 0.42)),
                ),
                alignment: Alignment.center,
                child: Icon(Icons.emoji_emotions_outlined, size: 26, color: m.primary),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _renderLine,
                      style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: m.heading, height: 1.35),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 6,
                      children: [
                        _pill('总数', '$_total'),
                        _pill('可用', '$_approved'),
                        _pill('待审', '$_pending'),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _pill(String label, String value) {
    final m = _m;
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
            TextSpan(text: '$label ', style: TextStyle(fontSize: 11, color: m.muted)),
            TextSpan(text: value, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: m.ink)),
          ],
        ),
      ),
    );
  }

  Widget _catalogCard() {
    final m = _m;
    final items = _items;
    return _card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _sectionTitle('图库'),
          if (items.isEmpty)
            Text('目录是空的', style: TextStyle(fontSize: 12, color: m.mutedSoft))
          else
            for (final item in items)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: _StickerRow(
                  item: item,
                  palette: m,
                ),
              ),
        ],
      ),
    );
  }
}

class _StickerRow extends StatelessWidget {
  const _StickerRow({required this.item, required this.palette});

  final Map<String, dynamic> item;
  final MoodPalette palette;

  @override
  Widget build(BuildContext context) {
    final m = palette;
    final id = '${item['id'] ?? ''}';
    final tags = ((item['tags'] as List?) ?? const []).whereType<String>().toList();
    final intensity = ((item['intensity'] as num?) ?? 0).round();
    final status = '${item['status'] ?? 'pending'}';
    final landed = '${item['path'] ?? ''}'.isNotEmpty;
    final (statusText, statusColor) = switch (status) {
      'approved' => ('可用', IrmiaTheme.ok),
      'pending' => ('待审', IrmiaTheme.warn),
      _ => ('未启用', m.muted),
    };
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
                  id,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: m.ink),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.13),
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: statusColor.withValues(alpha: 0.36)),
                ),
                child: Text(statusText, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: statusColor)),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              for (var i = 1; i <= 5; i += 1)
                Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i <= intensity ? m.primary : m.track,
                    ),
                  ),
                ),
              const SizedBox(width: 8),
              Text('强度 $intensity', style: TextStyle(fontSize: 11, color: m.muted)),
              const SizedBox(width: 12),
              Icon(
                landed ? Icons.check_circle_outline : Icons.cloud_off_outlined,
                size: 13,
                color: landed ? m.muted : m.mutedSoft,
              ),
              const SizedBox(width: 4),
              Text(landed ? '已落地' : '未落地', style: TextStyle(fontSize: 11, color: m.mutedSoft)),
            ],
          ),
          if (tags.isNotEmpty) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final tag in tags)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: m.track,
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(tag, style: TextStyle(fontSize: 11, color: m.title)),
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
