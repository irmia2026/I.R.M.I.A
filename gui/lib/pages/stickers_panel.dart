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

  void _accept(Map<String, dynamic> value) {
    _view = Map<String, dynamic>.from(value);
    _settings = Map<String, dynamic>.from((_view['settings'] as Map?) ?? const {});
  }

  List<Map<String, dynamic>> get _entries => [
        for (final item in (_view['items'] as List? ?? const []))
          if (item is Map) Map<String, dynamic>.from(item),
      ];

  int _count(String key) => ((_view['counts'] as Map?)?[key] as num?)?.toInt() ?? 0;

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
    if (value == 4 && _events == null) unawaited(_loadEvents());
  }

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    if (!validStickerView(_view)) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(s.stickerInvalidData, style: const TextStyle(color: IrmiaTheme.danger)),
        TextButton(onPressed: _busy ? null : _load, child: Text(s.retry)),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Row(children: [
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(s.stickerTitle, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600)),
          Text(s.stickerBlurb, style: TextStyle(fontSize: 12, height: 1.5, color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ])),
        IconButton(onPressed: _busy ? null : _load, icon: const Icon(Icons.refresh_rounded), tooltip: s.retry),
        FilledButton.icon(
          key: const ValueKey('sticker-upload'),
          onPressed: _busy ? null : _upload,
          icon: const Icon(Icons.upload_file_outlined, size: 17),
          label: Text(s.stickerUpload),
        ),
      ]),
      const SizedBox(height: 10),
      Text(s.stickerStats(_count('approved'), _count('pending'), _count('sentToday'))),
      if (_busy) const LinearProgressIndicator(minHeight: 2),
      if (_notice != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(_notice!, style: const TextStyle(color: IrmiaTheme.ok))),
      if (_error != null) Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(s.stickerActionFailed(_error!), style: const TextStyle(color: IrmiaTheme.danger)),
      ),
      const SizedBox(height: 10),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(children: [
          for (final (index, label) in [s.stickerTabLibrary, s.stickerTabTagging, s.stickerTabReview, s.stickerTabSettings, s.stickerTabEvents].indexed)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(key: ValueKey('sticker-tab-$index'), label: Text(label), selected: _tab == index, onSelected: (_) => _selectTab(index)),
            ),
        ]),
      ),
      const SizedBox(height: 12),
      switch (_tab) {
        0 => _library(),
        1 => _tagging(),
        2 => _reviewTab(),
        3 => _settingsTab(),
        _ => _eventsTab(),
      },
    ]);
  }

  Widget _library() {
    final s = IrmiaStrings.of(context);
    final approved = _entries.where((entry) => entry['status'] == 'approved').toList();
    final blocked = _entries.where((entry) => entry['status'] == 'blocked').toList();
    if (_entries.isEmpty) return _empty();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerLibraryHint),
      for (final tag in kStickerTags)
        if (approved.any((entry) => (entry['tags'] as List? ?? const []).contains(tag)))
          _group(tag, approved.where((entry) => (entry['tags'] as List? ?? const []).contains(tag)).toList()),
      if (blocked.isNotEmpty) _group(s.stickerStatus('blocked'), blocked),
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
