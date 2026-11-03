import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../app.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';

class StickerFile {
  const StickerFile({required this.bytes, required this.mime, required this.name});
  final Uint8List bytes;
  final String mime;
  final String name;
}

typedef StickerFilePicker = Future<StickerFile?> Function();

Future<StickerFile?> pickStickerFile() async {
  if (!Platform.isWindows) throw UnsupportedError('sticker-upload-windows-only');
  const script = r'''
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Filter = 'PNG/JPEG/GIF/WebP|*.png;*.jpg;*.jpeg;*.gif;*.webp'
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  [Console]::Write($dialog.FileName)
}
''';
  final result = await Process.run('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
  if (result.exitCode != 0) throw ProcessException('powershell.exe', const [], '${result.stderr}', result.exitCode);
  final path = '${result.stdout}'.trim();
  if (path.isEmpty) return null;
  final extension = path.split('.').last.toLowerCase();
  final mime = switch (extension) {
    'png' => 'image/png',
    'jpg' || 'jpeg' => 'image/jpeg',
    'gif' => 'image/gif',
    'webp' => 'image/webp',
    _ => null,
  };
  if (mime == null) throw const FormatException('unsupported-sticker-type');
  return StickerFile(bytes: await File(path).readAsBytes(), mime: mime, name: path.split(Platform.pathSeparator).last);
}

bool validStickerView(dynamic raw) =>
    raw is Map && raw['items'] is List && raw['counts'] is Map && raw['settings'] is Map && raw['tags'] is Map;

class StickersPanel extends StatefulWidget {
  const StickersPanel({super.key, required this.state, required this.view, this.onRefresh, this.picker = pickStickerFile});
  final AppState state;
  final Map<String, dynamic> view;
  final Future<void> Function()? onRefresh;
  final StickerFilePicker picker;

  @override
  State<StickersPanel> createState() => _StickersPanelState();
}

class _StickersPanelState extends State<StickersPanel> {
  late Map<String, dynamic> _view;
  late Map<String, dynamic> _settings;
  int _tab = 0;
  bool _busy = false;
  String? _error;
  String? _notice;
  final Set<String> _selected = <String>{};
  List<dynamic>? _events;
  bool _eventsLoading = false;

  /// 左栏与右栏各自一个滚动位置：两边互不牵连，右栏里始终只有一个滚动区。
  final ScrollController _sideScroll = ScrollController();
  final ScrollController _rightScroll = ScrollController();

  /// 库模式的本地筛选（只影响右侧显示，不发任何请求）。
  String? _selectedTag;
  String? _selectedStatus;

  @override
  void initState() {
    super.initState();
    _accept(widget.view);
  }

  @override
  void didUpdateWidget(covariant StickersPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.view != widget.view && !_busy) _accept(widget.view);
  }

  @override
  void dispose() {
    _sideScroll.dispose();
    _rightScroll.dispose();
    super.dispose();
  }

  void _accept(Map<String, dynamic> value) {
    _view = Map<String, dynamic>.from(value);
    _settings = Map<String, dynamic>.from((_view['settings'] as Map?) ?? const {});
  }

  List<Map<String, dynamic>> get _entries => [
        for (final item in (_view['items'] as List? ?? const []))
          if (item is Map) Map<String, dynamic>.from(item),
      ];

  int _count(String key) => ((_view['counts'] as Map?)?[key] as num?)?.toInt() ?? 0;

  List<Map<String, dynamic>> get _approvedEntries =>
      _entries.where((entry) => entry['status'] == 'approved').toList();

  /// 左栏标签上的数量来自服务端这份 tags 计数；没有就按已入库的图现算。
  Map<String, int> get _tagCounts {
    final raw = _view['tags'];
    if (raw is Map) {
      return {
        for (final tag in kStickerTags) tag: (raw[tag] as num?)?.toInt() ?? 0,
      };
    }
    return {
      for (final tag in kStickerTags)
        tag: _approvedEntries
            .where((entry) => (entry['tags'] as List? ?? const []).contains(tag))
            .length,
    };
  }

  /// 库模式当前筛选出的条目。标签筛选只碰已入库；已拒绝 / 停用是独立状态筛选。
  List<Map<String, dynamic>> get _libraryEntries {
    final status = _selectedStatus;
    if (status != null) {
      return _entries.where((entry) => entry['status'] == status).toList();
    }
    final tag = _selectedTag;
    if (tag != null) {
      return _approvedEntries
          .where((entry) => (entry['tags'] as List? ?? const []).contains(tag))
          .toList();
    }
    return _approvedEntries;
  }

  int? get _headerCount => switch (_tab) {
        0 => _libraryEntries.length,
        1 => _entries.length,
        2 => _entries
            .where((entry) => entry['status'] == 'pending' || entry['status'] == 'rejected')
            .length,
        4 => _events?.length,
        _ => null,
      };

  String _viewTitle(AppStrings s) {
    if (_tab == 0) {
      final status = _selectedStatus;
      if (status != null) return s.stickerStatus(status);
      return _selectedTag ?? s.stickerTabLibrary;
    }
    return switch (_tab) {
      1 => s.stickerTabTagging,
      2 => s.stickerTabReview,
      3 => s.stickerTabSettings,
      _ => s.stickerTabEvents,
    };
  }

  /// 切视图 / 换筛选都回到右栏顶部：新内容不该继承上一屏的滚动位置。
  void _jumpRightToTop() {
    if (!_rightScroll.hasClients) return;
    _rightScroll.animateTo(0, duration: const Duration(milliseconds: 160), curve: Curves.easeOut);
  }

  void _selectTagFilter(String? tag) {
    setState(() {
      _selectedTag = tag;
      _selectedStatus = null;
    });
    _jumpRightToTop();
  }

  void _selectStatusFilter(String status) {
    setState(() {
      _selectedTag = null;
      _selectedStatus = status;
    });
    _jumpRightToTop();
  }

  Future<void> _load() async {
    try {
      if (widget.onRefresh != null) {
        await widget.onRefresh!();
      } else {
        final raw = await widget.state.api.get('/api/stickers');
        if (!validStickerView(raw)) throw const FormatException('invalid-sticker-response');
        if (mounted) setState(() => _accept(Map<String, dynamic>.from(raw as Map)));
      }
      if (mounted) setState(() => _error = null);
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    }
  }

  Future<void> _review(String id, Map<String, dynamic> patch) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      await widget.state.api.patch('/api/stickers/$id', patch);
      await _load();
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _batch(String status) async {
    if (_busy || _selected.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    var done = 0;
    try {
      for (final id in _selected.toList()) {
        await widget.state.api.patch('/api/stickers/$id', {'status': status});
        done += 1;
      }
      _selected.clear();
      await _load();
      if (mounted) setState(() => _notice = IrmiaStrings.read(context).stickerBatchDone(done));
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _setting(String field, dynamic value) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      if (field == 'stickers.harvest.enabled') {
        await widget.state.api.post('/api/commands/sticker-harvest', {'enabled': value});
      } else {
        await widget.state.api.post('/api/commands/config-update', {
          'fields': {field: value},
        }, confirm: 'config-update');
      }
      if (mounted) {
        setState(() {
          _settings[field] = value;
          _notice = IrmiaStrings.read(context).stickerSettingsSaved;
        });
      }
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _upload() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      final file = await widget.picker();
      if (file == null) return;
      final raw = await widget.state.api.post('/api/stickers', {
        'mime': file.mime,
        'data': base64Encode(file.bytes),
      }, timeout: const Duration(seconds: 60));
      if (raw is! Map || raw['entry'] is! Map) throw const FormatException('invalid-upload-response');
      if (!mounted) return;
      setState(() {
        _busy = false;
        _notice = IrmiaStrings.read(context).stickerUploadDone;
      });
      final action = await _previewUpload(Map<String, dynamic>.from(raw['entry'] as Map), file);
      if (action != null) await _review('${raw['entry']['id']}', {'status': action});
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _previewUpload(Map<String, dynamic> entry, StickerFile file) {
    final s = IrmiaStrings.read(context);
    return showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(s.stickerUpload),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Center(child: Image.memory(file.bytes, width: 180, height: 180, fit: BoxFit.contain)),
              const SizedBox(height: 12),
              Text('${entry['tags']?.join(' / ') ?? ''}'),
              Text('${s.stickerIntensityLabel}: ${s.stickerIntensity('${entry['intensity']}')}'),
              Text('${s.stickerConfidence} ${(((entry['tagConfidence'] as num?)?.toDouble() ?? 0) * 100).round()}%'),
              if ('${entry['note'] ?? ''}'.isNotEmpty) Text('${entry['note']}'),
              const SizedBox(height: 8),
              Text(s.stickerUploadHint, style: const TextStyle(fontSize: 12, height: 1.5)),
            ]),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: Text(s.cancel)),
          TextButton(onPressed: () => Navigator.pop(context, 'rejected'), child: Text(s.stickerReject)),
          FilledButton(key: const ValueKey('sticker-upload-approve'), onPressed: () => Navigator.pop(context, 'approved'), child: Text(s.stickerApprove)),
        ],
      ),
    );
  }

  Future<void> _confirmDelete(Map<String, dynamic> entry, {required bool purge}) async {
    final s = IrmiaStrings.read(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(s.stickerConfirmDeleteTitle),
        content: Text(purge ? s.stickerConfirmPurgeBody : s.stickerConfirmDeleteBody),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: Text(s.cancel)),
          FilledButton(
            key: const ValueKey('sticker-delete-confirm'),
            onPressed: () => Navigator.pop(context, true),
            child: Text(purge ? s.stickerPurge : s.stickerDelete),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    final id = '${entry['id']}';
    if (purge) {
      await _runDelete('/api/commands/stickers-purge', 'stickers-purge', {'id': id});
    } else {
      await _runDelete('/api/stickers/$id', 'sticker-delete');
    }
  }

  Future<void> _runDelete(String path, String confirm, [Map<String, dynamic>? body]) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.state.api.delete(path, body: body, confirm: confirm);
      await _load();
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _editTags(Map<String, dynamic> entry) async {
    final selected = <String>{for (final tag in (entry['tags'] as List? ?? const [])) '$tag'};
    final next = await showDialog<List<String>>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialogState) {
          final s = IrmiaStrings.of(context);
          return AlertDialog(
            title: Text(s.stickerEditTags),
            content: Wrap(spacing: 8, runSpacing: 8, children: [
              for (final tag in kStickerTags)
                FilterChip(
                  label: Text(tag),
                  selected: selected.contains(tag),
                  onSelected: (value) {
                    if (value && selected.length >= 2) return;
                    setDialogState(() => value ? selected.add(tag) : selected.remove(tag));
                  },
                ),
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context), child: Text(s.cancel)),
              FilledButton(
                key: const ValueKey('sticker-tags-confirm'),
                onPressed: selected.isEmpty ? null : () => Navigator.pop(context, selected.toList()),
                child: Text(s.confirm),
              ),
            ],
          );
        },
      ),
    );
    if (next != null) await _review('${entry['id']}', {'tags': next});
  }

  Future<void> _loadEvents() async {
    if (_eventsLoading) return;
    setState(() => _eventsLoading = true);
    try {
      final raw = await widget.state.api.get('/api/stickers/events');
      if (raw is! Map || raw['items'] is! List) throw const FormatException('invalid-sticker-events');
      if (mounted) setState(() => _events = raw['items'] as List);
    } catch (err) {
      if (mounted) setState(() => _error = '$err');
    } finally {
      if (mounted) setState(() => _eventsLoading = false);
    }
  }

  void _selectTab(int value) {
    setState(() => _tab = value);
    _jumpRightToTop();
    if (value == 4 && _events == null) unawaited(_loadEvents());
  }

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(26, 12, 26, 16),
      child: !validStickerView(_view)
          ? Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(s.stickerInvalidData, textAlign: TextAlign.center, style: const TextStyle(color: IrmiaTheme.danger)),
                const SizedBox(height: 8),
                TextButton(onPressed: _busy ? null : _load, child: Text(s.retry)),
              ]),
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SizedBox(width: 230, child: _sidebar(s)),
                const SizedBox(width: 16),
                Expanded(child: _contentCard(s)),
              ],
            ),
    );
  }

  Widget _sidebar(AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    final counts = _tagCounts;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Scrollbar(
        controller: _sideScroll,
        thumbVisibility: true,
        child: ListView(
          key: const ValueKey('sticker-side-scroll'),
          controller: _sideScroll,
          padding: const EdgeInsets.fromLTRB(12, 16, 12, 16),
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Text(s.stickerTitle, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
            ),
            const SizedBox(height: 6),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 6),
              child: Text(
                s.stickerStats(_count('approved'), _count('pending'), _count('sentToday')),
                style: TextStyle(fontSize: 11.5, height: 1.55, color: scheme.onSurfaceVariant),
              ),
            ),
            const SizedBox(height: 14),
            _navRow(
              key: const ValueKey('sticker-tab-0'),
              icon: Icons.grid_view_rounded,
              label: s.stickerTabLibrary,
              count: _count('approved'),
              selected: _tab == 0,
              onTap: () => _selectTab(0),
            ),
            _navRow(
              key: const ValueKey('sticker-tab-1'),
              icon: Icons.sell_outlined,
              label: s.stickerTabTagging,
              count: _entries.length,
              selected: _tab == 1,
              onTap: () => _selectTab(1),
            ),
            _navRow(
              key: const ValueKey('sticker-tab-2'),
              icon: Icons.fact_check_outlined,
              label: s.stickerTabReview,
              count: _count('pending'),
              selected: _tab == 2,
              onTap: () => _selectTab(2),
            ),
            _navRow(
              key: const ValueKey('sticker-tab-3'),
              icon: Icons.tune_rounded,
              label: s.stickerTabSettings,
              selected: _tab == 3,
              onTap: () => _selectTab(3),
            ),
            _navRow(
              key: const ValueKey('sticker-tab-4'),
              icon: Icons.history_rounded,
              label: s.stickerTabEvents,
              count: _events?.length,
              selected: _tab == 4,
              onTap: () => _selectTab(4),
            ),
            if (_tab == 0) ...[
              const Divider(height: 26),
              Padding(
                padding: const EdgeInsets.fromLTRB(6, 0, 6, 6),
                child: Text(
                  s.stickerEditTags,
                  style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant),
                ),
              ),
              _filterRow(
                key: const ValueKey('sticker-filter-all'),
                label: s.stickerFilterAll,
                count: _count('approved'),
                selected: _selectedTag == null && _selectedStatus == null,
                onTap: () => _selectTagFilter(null),
              ),
              for (final tag in kStickerTags)
                _filterRow(
                  key: ValueKey('sticker-filter-tag-$tag'),
                  label: tag,
                  count: counts[tag] ?? 0,
                  selected: _selectedTag == tag,
                  onTap: () => _selectTagFilter(tag),
                ),
              const Divider(height: 18),
              _filterRow(
                key: const ValueKey('sticker-filter-rejected'),
                label: s.stickerStatus('rejected'),
                count: _count('rejected'),
                selected: _selectedStatus == 'rejected',
                onTap: () => _selectStatusFilter('rejected'),
              ),
              _filterRow(
                key: const ValueKey('sticker-filter-blocked'),
                label: s.stickerStatus('blocked'),
                count: _count('blocked'),
                selected: _selectedStatus == 'blocked',
                onTap: () => _selectStatusFilter('blocked'),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _navRow({
    required Key key,
    required IconData icon,
    required String label,
    required bool selected,
    required VoidCallback onTap,
    int? count,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final tone = selected ? scheme.primary : scheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: selected ? scheme.surfaceContainerHighest : Colors.transparent,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: InkWell(
          key: key,
          onTap: onTap,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
            child: Row(children: [
              Icon(icon, size: 16, color: tone),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    color: selected ? scheme.primary : scheme.onSurface,
                  ),
                ),
              ),
              if (count != null) ...[
                const SizedBox(width: 6),
                Text('$count', style: TextStyle(fontSize: 11, color: tone)),
              ],
            ]),
          ),
        ),
      ),
    );
  }

  Widget _filterRow({
    required Key key,
    required String label,
    required int count,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 1),
      child: Material(
        color: selected ? scheme.surfaceContainerHighest : Colors.transparent,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: InkWell(
          key: key,
          onTap: onTap,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Row(children: [
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w400,
                    color: selected ? scheme.primary : scheme.onSurfaceVariant,
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Text('$count', style: TextStyle(fontSize: 11, color: selected ? scheme.primary : scheme.onSurfaceVariant)),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _contentCard(AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        _cardHeader(s, _headerCount),
        if (_busy) const LinearProgressIndicator(minHeight: 2),
        Expanded(child: _rightScrollArea(s)),
      ]),
    );
  }

  Widget _cardHeader(AppStrings s, int? count) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 9, 10, 9),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: scheme.outlineVariant))),
      child: Row(children: [
        Expanded(
          child: Row(children: [
            Flexible(
              child: Text(
                _viewTitle(s),
                key: const ValueKey('sticker-view-title'),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: scheme.onSurface),
              ),
            ),
            if (count != null) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Text(
                  '$count',
                  key: const ValueKey('sticker-view-count'),
                  style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
                ),
              ),
            ],
          ]),
        ),
        const SizedBox(width: 8),
        IconButton(
          key: const ValueKey('sticker-refresh'),
          onPressed: _busy ? null : _load,
          icon: const Icon(Icons.refresh_rounded, size: 19),
          tooltip: s.retry,
          padding: EdgeInsets.zero,
          visualDensity: VisualDensity.compact,
          constraints: const BoxConstraints.tightFor(width: 36, height: 36),
        ),
        const SizedBox(width: 4),
        FilledButton.icon(
          key: const ValueKey('sticker-upload'),
          onPressed: _busy ? null : _upload,
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            minimumSize: const Size(0, 34),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          icon: const Icon(Icons.upload_file_outlined, size: 16),
          label: Text(s.stickerUpload),
        ),
      ]),
    );
  }

  Widget _rightScrollArea(AppStrings s) {
    final Widget body;
    if (_tab == 3) {
      body = ListView(
        key: const ValueKey('sticker-content-scroll'),
        controller: _rightScroll,
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
        children: [_messages(s), _settingsTab()],
      );
    } else if (_tab == 4) {
      body = ListView(
        key: const ValueKey('sticker-content-scroll'),
        controller: _rightScroll,
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
        children: [_messages(s), _eventsTab()],
      );
    } else {
      body = SingleChildScrollView(
        key: const ValueKey('sticker-content-scroll'),
        controller: _rightScroll,
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 18),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _messages(s),
          switch (_tab) {
            0 => _library(),
            1 => _tagging(),
            _ => _reviewTab(),
          },
        ]),
      );
    }
    return Scrollbar(controller: _rightScroll, thumbVisibility: true, child: body);
  }

  Widget _messages(AppStrings s) {
    if (_notice == null && _error == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (_notice != null) Text(_notice!, style: const TextStyle(color: IrmiaTheme.ok)),
        if (_error != null) Text(s.stickerActionFailed(_error!), style: const TextStyle(color: IrmiaTheme.danger)),
      ]),
    );
  }

  Widget _library() {
    final s = IrmiaStrings.of(context);
    if (_entries.isEmpty) return _empty();
    final selected = _libraryEntries;
    if (selected.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 24),
        child: Text(s.stickerNoMatches, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );
    }
    if (_selectedStatus != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _hint(s.stickerLibraryHint),
        _group(s.stickerStatus(_selectedStatus!), selected),
      ]);
    }
    final approved = _approvedEntries;
    if (_selectedTag != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _hint(s.stickerLibraryHint),
        _group(_selectedTag!, selected),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerLibraryHint),
      for (final tag in kStickerTags)
        if (approved.any((entry) => (entry['tags'] as List? ?? const []).contains(tag)))
          _group(tag, approved.where((entry) => (entry['tags'] as List? ?? const []).contains(tag)).toList()),
    ]);
  }

  Widget _tagging() {
    final s = IrmiaStrings.of(context);
    if (_entries.isEmpty) return _empty();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerTaggingHint),
      Wrap(spacing: 12, runSpacing: 12, children: [for (final entry in _entries) _card(entry)]),
    ]);
  }

  Widget _reviewTab() {
    final s = IrmiaStrings.of(context);
    final pending = _entries.where((entry) => entry['status'] == 'pending').toList();
    final rejected = _entries.where((entry) => entry['status'] == 'rejected').toList();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerReviewHint),
      Row(children: [
        Text(s.stickerStatus('pending'), style: const TextStyle(fontWeight: FontWeight.w600)),
        const Spacer(),
        TextButton(key: const ValueKey('sticker-batch-approve'), onPressed: _busy || _selected.isEmpty ? null : () => _batch('approved'), child: Text(s.stickerBatchApprove)),
        TextButton(key: const ValueKey('sticker-batch-reject'), onPressed: _busy || _selected.isEmpty ? null : () => _batch('rejected'), child: Text(s.stickerBatchReject)),
      ]),
      if (pending.isEmpty) Text(s.stickerNoPending) else Wrap(spacing: 12, runSpacing: 12, children: [for (final entry in pending) _card(entry, selectable: true)]),
      const SizedBox(height: 16),
      Text(s.stickerStatus('rejected'), style: const TextStyle(fontWeight: FontWeight.w600)),
      if (rejected.isEmpty) Text(s.stickerNoRejected) else Wrap(spacing: 12, runSpacing: 12, children: [for (final entry in rejected) _card(entry)]),
    ]);
  }

  Widget _settingsTab() {
    final s = IrmiaStrings.of(context);
    final probability = (_settings['stickers.harvest.probability'] as num?)?.toDouble() ?? (_settings['harvestProbability'] as num?)?.toDouble() ?? 0.15;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerSettingsHint),
      SwitchListTile(
        key: const ValueKey('sticker-enabled'),
        title: Text(s.stickerEnabled),
        value: _settings['stickers.enabled'] == true || _settings['enabled'] == true,
        onChanged: _busy ? null : (value) => _setting('stickers.enabled', value),
      ),
      SwitchListTile(
        key: const ValueKey('sticker-harvest-enabled'),
        title: Text(s.stickerHarvestEnabled),
        value: _settings['stickers.harvest.enabled'] == true || _settings['harvestEnabled'] == true,
        onChanged: _busy ? null : (value) => _setting('stickers.harvest.enabled', value),
      ),
      SwitchListTile(
        key: const ValueKey('sticker-tagging-enabled'),
        title: Text(s.stickerTaggingEnabled),
        value: _settings['stickers.tagging.enabled'] == true || _settings['taggingEnabled'] == true,
        onChanged: _busy ? null : (value) => _setting('stickers.tagging.enabled', value),
      ),
      Text('${s.stickerHarvestProbability} ${(probability * 100).round()}%'),
      Slider(
        key: const ValueKey('sticker-harvest-probability'),
        value: probability.clamp(0, 1),
        divisions: 20,
        onChanged: _busy ? null : (value) => setState(() => _settings['stickers.harvest.probability'] = value),
        onChangeEnd: _busy ? null : (value) => _setting('stickers.harvest.probability', value),
      ),
    ]);
  }

  Widget _eventsTab() {
    final s = IrmiaStrings.of(context);
    final events = _events;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerEventsHint),
      if (_eventsLoading) const LinearProgressIndicator(minHeight: 2),
      if (events == null && !_eventsLoading) TextButton(onPressed: _loadEvents, child: Text(s.retry)),
      if (events != null && events.isEmpty) Text(s.stickerNoEvents),
      if (events != null)
        for (final event in events.whereType<Map>())
          Card(
            child: ListTile(
              dense: true,
              title: Text('${event['type']}'),
              subtitle: Text('${event['ts']}\n${jsonEncode(event['data'])}', maxLines: 3, overflow: TextOverflow.ellipsis),
            ),
          ),
    ]);
  }

  Widget _group(String title, List<Map<String, dynamic>> entries) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text('$title ${entries.length}', style: const TextStyle(fontWeight: FontWeight.w600))),
        Wrap(spacing: 12, runSpacing: 12, children: [for (final entry in entries) _card(entry)]),
      ]);

  Widget _card(Map<String, dynamic> entry, {bool selectable = false}) {
    final s = IrmiaStrings.of(context);
    final id = '${entry['id']}';
    final status = '${entry['status']}';
    final selected = _selected.contains(id);
    final intensity = '${entry['intensity']}';
    return Container(
      key: ValueKey('sticker-card-$id'),
      width: 184,
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: selected ? Theme.of(context).colorScheme.primary : Theme.of(context).colorScheme.outlineVariant),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
        Row(children: [
          if (selectable)
            SizedBox(
              width: 28,
              height: 28,
              child: Checkbox(
                key: ValueKey('sticker-select-$id'),
                value: selected,
                onChanged: _busy ? null : (value) => setState(() => value == true ? _selected.add(id) : _selected.remove(id)),
              ),
            ),
          Expanded(child: Text(s.stickerStatus(status), style: const TextStyle(fontSize: 11))),
        ]),
        ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: Image.network(
            '${widget.state.api.baseUrl}${entry['imageUrl']}',
            key: ValueKey('sticker-image-$id'),
            headers: widget.state.api.token == null ? null : {'Authorization': 'Bearer ${widget.state.api.token}'},
            height: 104,
            width: 168,
            fit: BoxFit.cover,
            errorBuilder: (_, __, ___) => const SizedBox(height: 104, child: Center(child: Icon(Icons.broken_image_outlined))),
          ),
        ),
        const SizedBox(height: 6),
        Text((entry['tags'] as List? ?? const []).join(' / '), maxLines: 1, overflow: TextOverflow.ellipsis),
        Text('${s.stickerSource('${entry['source']}')} · ${s.stickerUseCount(((entry['stats'] as Map?)?['sent'] as num?)?.toInt() ?? 0)}', style: const TextStyle(fontSize: 11)),
        Row(children: [
          Text('${s.stickerIntensityLabel}: ', style: const TextStyle(fontSize: 11)),
          Expanded(
            child: DropdownButton<String>(
              value: ['mild', 'obvious', 'strong'].contains(intensity) ? intensity : 'obvious',
              isDense: true,
              isExpanded: true,
              items: ['mild', 'obvious', 'strong'].map((value) => DropdownMenuItem(value: value, child: Text(s.stickerIntensity(value), style: const TextStyle(fontSize: 11)))).toList(),
              onChanged: _busy ? null : (value) => value == null ? null : _review(id, {'intensity': value}),
            ),
          ),
        ]),
        Row(children: [
          Expanded(child: _cardAction(
            ValueKey('sticker-tags-$id'), s.stickerEditTags, _busy ? null : () => _editTags(entry))),
          if (status == 'pending')
            Expanded(child: _cardAction(
              ValueKey('sticker-approve-$id'), s.stickerApprove, _busy ? null : () => _review(id, {'status': 'approved'}))),
          if (status == 'pending')
            Expanded(child: _cardAction(
              ValueKey('sticker-reject-$id'), s.stickerReject, _busy ? null : () => _review(id, {'status': 'rejected'}))),
          if (status == 'approved')
            Expanded(child: _cardAction(
              ValueKey('sticker-block-$id'), s.stickerBlock, _busy ? null : () => _review(id, {'status': 'blocked'}))),
          if (status == 'approved')
            Expanded(child: _cardAction(
              ValueKey('sticker-delete-$id'), s.stickerDelete, _busy ? null : () => _confirmDelete(entry, purge: false))),
          if (status == 'rejected' || status == 'blocked')
            Expanded(child: _cardAction(
              ValueKey('sticker-restore-$id'), s.stickerRestore, _busy ? null : () => _review(id, {'status': 'approved'}))),
          if (status == 'rejected')
            Expanded(child: _cardAction(
              ValueKey('sticker-purge-$id'), s.stickerPurge, _busy ? null : () => _confirmDelete(entry, purge: true))),
        ]),
      ]),
    );
    }

    /// 卡片里的一颗文字动作：紧凑到一行放得下三颗（删除仍有确认短语，不靠 tooltip 兜底）
    Widget _cardAction(Key key, String label, VoidCallback? onPressed) => TextButton(
          key: key,
          onPressed: onPressed,
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            minimumSize: const Size(0, 30),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            visualDensity: VisualDensity.compact,
          ),
          child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5)),
        );

  Widget _empty() {
    final s = IrmiaStrings.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(s.stickerEmpty, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Text(s.stickerEmptyHint, style: const TextStyle(height: 1.5)),
      ]),
    );
  }

  Widget _hint(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: Text(text, style: TextStyle(fontSize: 12, height: 1.5, color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );
}
