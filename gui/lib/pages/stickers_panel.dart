import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../app.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../ui_kit.dart';

class StickerFile {
  const StickerFile({required this.bytes, required this.mime, required this.name});
  final Uint8List bytes;
  final String mime;
  final String name;
}

/// 审核页的两段各自持有页码与总数：待审、已拒绝互不牵连。
class _PagedStickers {
  List<Map<String, dynamic>> items = const [];
  int page = 1;
  int total = 0;
  int epoch = 0;
  bool loading = false;
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
  const StickersPanel({super.key, required this.state, required this.view, this.picker = pickStickerFile});
  final AppState state;
  final Map<String, dynamic> view;
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

  /// 分页游标（来自 `/api/stickers` 的 page/pageSize/total）：
  /// 左栏库存是全局计数，右栏一次只有一页——两者必须靠翻页对齐。
  int _page = 1;
  int _pageSize = 48;
  int _total = 0;
  bool _listLoading = false;
  int _loadEpoch = 0;

  /// 审核页：待审与已拒绝分别请求，各自翻页；计数一律看整库 counts。
  final _reviewPending = _PagedStickers();
  final _reviewRejected = _PagedStickers();
  int _reviewPageSize = 48;

  /// 左栏与右栏各自一个滚动位置：两边互不牵连，右栏里始终只有一个滚动区。
  final ScrollController _sideScroll = ScrollController();
  final ScrollController _rightScroll = ScrollController();

  /// 库模式的筛选：交给服务端做（`status`/`tag`），右栏只重新取第一页。
  String? _selectedTag;
  String? _selectedStatus;

  /// 熔断秒数：输入期间只改文本，提交（回车/失焦）才写后端。
  final TextEditingController _cooldownInput = TextEditingController();
  final FocusNode _cooldownFocus = FocusNode();

  @override
  void initState() {
    super.initState();
    _cooldownFocus.addListener(_onCooldownFocusChanged);
    _accept(widget.view);
  }

  @override
  void didUpdateWidget(covariant StickersPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.view != widget.view && !_busy) _accept(widget.view);
  }

  @override
  void dispose() {
    _cooldownFocus.removeListener(_onCooldownFocusChanged);
    _cooldownFocus.dispose();
    _cooldownInput.dispose();
    _sideScroll.dispose();
    _rightScroll.dispose();
    super.dispose();
  }

  void _accept(Map<String, dynamic> value) {
    _view = Map<String, dynamic>.from(value);
    _settings = Map<String, dynamic>.from((_view['settings'] as Map?) ?? const {});
    final page = (_view['page'] as num?)?.toInt() ?? 1;
    final pageSize = (_view['pageSize'] as num?)?.toInt() ?? _pageSize;
    _page = page < 1 ? 1 : page;
    _pageSize = pageSize < 1 ? 48 : pageSize;
    _total = ((_view['total'] as num?)?.toInt() ?? _entries.length).clamp(0, 1 << 30);
    _syncCooldownInput();
  }

  List<Map<String, dynamic>> _itemsFrom(Map<String, dynamic> value) => [
        for (final item in (value['items'] as List? ?? const []))
          if (item is Map) Map<String, dynamic>.from(item),
      ];

  List<Map<String, dynamic>> get _entries => _itemsFrom(_view);

  /// 审核页的两段响应仍带整库 counts/tags/settings；只吸收这些，不碰库/打标的页码。
  void _absorbGlobals(Map<String, dynamic> value) {
    _view['counts'] = value['counts'];
    _view['tags'] = value['tags'];
    _view['settings'] = value['settings'];
    _settings = Map<String, dynamic>.from((value['settings'] as Map?) ?? const {});
    _syncCooldownInput();
  }

  int _count(String key) => ((_view['counts'] as Map?)?[key] as num?)?.toInt() ?? 0;

  /// 后端的配置键是 dotted；老夹具 / 老响应只给短名时也认。
  double get _activeProbability {
    final raw = _settings['stickers.activeProbability'] ?? _settings['activeProbability'];
    return ((raw as num?)?.toDouble() ?? 1).clamp(0.0, 1.0).toDouble();
  }

  int get _cooldownSeconds {
    final raw = _settings['stickers.cooldownSeconds'] ?? _settings['cooldownSeconds'];
    final value = (raw as num?)?.toInt() ?? 0;
    return value < 0 ? 0 : value;
  }

  void _syncCooldownInput({bool force = false}) {
    if (!force && _cooldownFocus.hasFocus) return;
    final text = '$_cooldownSeconds';
    if (_cooldownInput.text != text) _cooldownInput.text = text;
  }

  void _onCooldownFocusChanged() {
    if (!_cooldownFocus.hasFocus) _submitCooldown();
  }

  void _submitCooldown() {
    if (_busy || !mounted) return;
    final value = int.tryParse(_cooldownInput.text.trim());
    if (value == null || value < 0) {
      _syncCooldownInput(force: true);
      return;
    }
    _cooldownInput.text = '$value';
    if (value == _cooldownSeconds) return;
    unawaited(_setting('stickers.cooldownSeconds', value));
  }

  List<Map<String, dynamic>> get _approvedEntries =>
      _entries.where((entry) => entry['status'] == 'approved').toList();

  /// 九标签计数始终来自服务端整库（不是当前页），标签分区标题也用它。
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

  /// 打标面板的库存总数：四个状态相加，避免只数当前页。
  int get _allStoredCount => _count('approved') + _count('pending') + _count('rejected') + _count('blocked');

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
        0 || 1 => _total,
        2 => _count('pending') + _count('rejected'),
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
    unawaited(_load(page: 1));
  }

  void _selectStatusFilter(String status) {
    setState(() {
      _selectedTag = null;
      _selectedStatus = status;
    });
    _jumpRightToTop();
    unawaited(_load(page: 1));
  }

  /// 列表取数路径：库页按已入库 + 当前标签/状态筛选，打标页取全部状态。
  /// 筛选交给服务端，翻页才能在整库范围内连续，而不是只筛当前这一页。
  String _listPath({required int page, required int pageSize}) {
    final params = <String, String>{'page': '$page', 'pageSize': '$pageSize'};
    if (_tab == 0) {
      final status = _selectedStatus;
      if (status != null) {
        params['status'] = status;
      } else {
        params['status'] = 'approved';
        final tag = _selectedTag;
        if (tag != null) params['tag'] = tag;
      }
    }
    return Uri(path: '/api/stickers', queryParameters: params).toString();
  }

  /// 取一页列表；晚到的旧响应不许盖掉新页码（翻页/筛选可能连点）。
  Future<void> _load({int? page, int? pageSize}) async {
    final epoch = ++_loadEpoch;
    final targetPage = page ?? _page;
    final targetSize = pageSize ?? _pageSize;
    if (mounted) setState(() => _listLoading = true);
    try {
      final raw = await widget.state.api.get(_listPath(page: targetPage, pageSize: targetSize));
      if (!validStickerView(raw)) throw const FormatException('invalid-sticker-response');
      if (!mounted || epoch != _loadEpoch) return;
      setState(() {
        _accept(Map<String, dynamic>.from(raw as Map));
        _error = null;
      });
      // 显式翻页/改每页条数后回到顶部：新一页不该继承上一页的滚动位置。
      if (page != null) _jumpRightToTop();
      // 删除/移出最后一页的唯一一张后，页码可能已经越界；回到最后一页，别摆假空态。
      final lastPage = _total <= 0 ? 1 : ((_total + _pageSize - 1) ~/ _pageSize);
      if (_entries.isEmpty && _page > lastPage) unawaited(_load(page: lastPage));
    } catch (err) {
      if (mounted && epoch == _loadEpoch) setState(() => _error = '$err');
    } finally {
      if (mounted && epoch == _loadEpoch) setState(() => _listLoading = false);
    }
  }

  String _statusPath(String status, int page, int pageSize) => Uri(
        path: '/api/stickers',
        queryParameters: {'status': status, 'page': '$page', 'pageSize': '$pageSize'},
      ).toString();

  /// 审核一段（待审或已拒绝）取一页；总数用整库 counts，而不是这一页的条数。
  Future<void> _loadReviewSection(String status, int page) async {
    final slot = status == 'pending' ? _reviewPending : _reviewRejected;
    final epoch = ++slot.epoch;
    final pageSize = _reviewPageSize;
    if (mounted) setState(() => slot.loading = true);
    try {
      final raw = await widget.state.api.get(_statusPath(status, page, pageSize));
      if (!validStickerView(raw)) throw const FormatException('invalid-sticker-response');
      if (!mounted || epoch != slot.epoch) return;
      final view = Map<String, dynamic>.from(raw as Map);
      final items = _itemsFrom(view);
      final counts = view['counts'] as Map?;
      final total = ((counts?[status] as num?)?.toInt() ?? (view['total'] as num?)?.toInt() ?? items.length).clamp(0, 1 << 30);
      setState(() {
        slot.items = items;
        slot.page = ((view['page'] as num?)?.toInt() ?? page).clamp(1, 1 << 30);
        slot.total = total;
        slot.loading = false;
        _reviewPageSize = ((view['pageSize'] as num?)?.toInt() ?? pageSize).clamp(1, 1 << 30);
        _absorbGlobals(view);
        _error = null;
      });
      final lastPage = slot.total <= 0 ? 1 : ((slot.total + pageSize - 1) ~/ pageSize);
      if (items.isEmpty && slot.total > 0 && slot.page > lastPage) {
        unawaited(_loadReviewSection(status, lastPage));
      }
    } catch (err) {
      if (mounted && epoch == slot.epoch) {
        setState(() {
          slot.loading = false;
          _error = '$err';
        });
      }
    }
  }

  Future<void> _loadReview({bool reset = false}) async {
    await Future.wait([
      _loadReviewSection('pending', reset ? 1 : _reviewPending.page),
      _loadReviewSection('rejected', reset ? 1 : _reviewRejected.page),
    ]);
  }

  void _changeReviewPageSize(int size) {
    if (size == _reviewPageSize) return;
    setState(() => _reviewPageSize = size);
    unawaited(_loadReviewSection('pending', 1));
    unawaited(_loadReviewSection('rejected', 1));
  }

  Future<void> _reloadCurrentTab() => _tab == 2 ? _loadReview() : _load();

  Future<void> _review(String id, Map<String, dynamic> patch) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
      _notice = null;
    });
    try {
      await widget.state.api.patch('/api/stickers/$id', patch);
      await _reloadCurrentTab();
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
      await _reloadCurrentTab();
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
      await _reloadCurrentTab();
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
    final changed = value != _tab;
    setState(() => _tab = value);
    _jumpRightToTop();
    if (value == 4 && _events == null) unawaited(_loadEvents());
    if (!changed) return;
    // 库/打标共用一份列表视图；审核页是待审、已拒绝两段各自按 status 取页。
    if (value == 2) {
      unawaited(_loadReview(reset: true));
    } else if (value < 3) {
      unawaited(_load(page: 1));
    }
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
                TextButton(onPressed: _busy ? null : () => unawaited(_load()), child: Text(s.retry)),
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
              count: _allStoredCount,
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
        if (_busy || _listLoading) const LinearProgressIndicator(minHeight: 2),
        Expanded(child: _rightScrollArea(s)),
        if (_pagerVisible) ...[
          Divider(height: 1, color: scheme.outlineVariant),
          LayoutBuilder(
            builder: (context, constraints) => PagerBar(
              key: const ValueKey('sticker-pager'),
              page: _page,
              pageSize: _pageSize,
              total: _total,
              onPage: (page) => unawaited(_load(page: page)),
              onPageSize: (size) => unawaited(_load(page: 1, pageSize: size)),
              // 窄窗先收「每页条数」下拉；箭头与页码必须留下，否则翻不了页。
              showPageSize: constraints.maxWidth >= 520,
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            ),
          ),
        ],
      ]),
    );
  }

  /// 超过一页才摆分页栏；事件区走自己的 `limit`，不在这一套里。
  bool get _pagerVisible => (_tab == 0 || _tab == 1) && _total > _pageSize;

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
          onPressed: _busy ? null : () => unawaited(_reloadCurrentTab()),
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
    final selected = _libraryEntries;
    if (_total == 0) {
      // 库里只有待审/已拒绝时，已入库为 0，但「还没有贴纸」是假话。
      final hasAny = _selectedTag != null || _selectedStatus != null || _allStoredCount > 0;
      return hasAny ? _noMatches() : _empty();
    }
    if (selected.isEmpty) return _noMatches();
    if (_selectedStatus != null) {
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _hint(s.stickerLibraryHint),
        _group(s.stickerStatus(_selectedStatus!), selected, count: _count(_selectedStatus!)),
      ]);
    }
    final approved = _approvedEntries;
    final counts = _tagCounts;
    if (_selectedTag != null) {
      final tag = _selectedTag!;
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _hint(s.stickerLibraryHint),
        _group(tag, selected, count: counts[tag] ?? selected.length),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerLibraryHint),
      for (final tag in kStickerTags)
        if (approved.any((entry) => (entry['tags'] as List? ?? const []).contains(tag)))
          _group(
            tag,
            approved.where((entry) => (entry['tags'] as List? ?? const []).contains(tag)).toList(),
            count: counts[tag] ?? 0,
          ),
    ]);
  }

  Widget _noMatches() {
    final s = IrmiaStrings.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 24),
      child: Text(s.stickerNoMatches, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
    );
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
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      _hint(s.stickerReviewHint),
      Row(children: [
        Text('${s.stickerStatus('pending')} ${_count('pending')}', style: const TextStyle(fontWeight: FontWeight.w600)),
        const Spacer(),
        TextButton(key: const ValueKey('sticker-batch-approve'), onPressed: _busy || _selected.isEmpty ? null : () => _batch('approved'), child: Text(s.stickerBatchApprove)),
        TextButton(key: const ValueKey('sticker-batch-reject'), onPressed: _busy || _selected.isEmpty ? null : () => _batch('rejected'), child: Text(s.stickerBatchReject)),
      ]),
      _reviewSection(
        key: const ValueKey('sticker-review-pending'),
        status: 'pending',
        slot: _reviewPending,
        emptyText: s.stickerNoPending,
        selectable: true,
      ),
      const SizedBox(height: 16),
      Text('${s.stickerStatus('rejected')} ${_count('rejected')}', style: const TextStyle(fontWeight: FontWeight.w600)),
      _reviewSection(
        key: const ValueKey('sticker-review-rejected'),
        status: 'rejected',
        slot: _reviewRejected,
        emptyText: s.stickerNoRejected,
        selectable: false,
      ),
    ]);
  }

  /// 审核的一段：卡片区 + 自己的分页栏；总数来自整库 counts。
  Widget _reviewSection({
    required Key key,
    required String status,
    required _PagedStickers slot,
    required String emptyText,
    required bool selectable,
  }) {
    final s = IrmiaStrings.of(context);
    return Column(key: key, crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (slot.loading) const LinearProgressIndicator(minHeight: 2),
      if (slot.items.isNotEmpty)
        Wrap(spacing: 12, runSpacing: 12, children: [for (final entry in slot.items) _card(entry, selectable: selectable)])
      else if (!slot.loading || slot.total > 0)
        Text(slot.total == 0 ? emptyText : s.stickerNoMatches),
      if (slot.total > _reviewPageSize)
        LayoutBuilder(
          builder: (context, constraints) => PagerBar(
            key: ValueKey('sticker-review-$status-pager'),
            page: slot.page,
            pageSize: _reviewPageSize,
            total: slot.total,
            onPage: (page) => unawaited(_loadReviewSection(status, page)),
            onPageSize: _changeReviewPageSize,
            showPageSize: constraints.maxWidth >= 520,
            padding: const EdgeInsets.fromLTRB(0, 8, 0, 8),
          ),
        ),
    ]);
  }

  Widget _settingsTab() {
    final s = IrmiaStrings.of(context);
    final probability = (_settings['stickers.harvest.probability'] as num?)?.toDouble() ?? (_settings['harvestProbability'] as num?)?.toDouble() ?? 0.15;
    final activeProbability = _activeProbability;
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
      const Divider(height: 28),
      Text('${s.stickerActiveProbability} ${(activeProbability * 100).round()}%'),
      Slider(
        key: const ValueKey('sticker-active-probability'),
        value: activeProbability,
        divisions: 100,
        label: '${(activeProbability * 100).round()}%',
        onChanged: _busy ? null : (value) => setState(() => _settings['stickers.activeProbability'] = value),
        onChangeEnd: _busy ? null : (value) => _setting('stickers.activeProbability', value),
      ),
      _hint(s.stickerActiveProbabilityHint),
      const SizedBox(height: 4),
      Text(s.stickerCooldownSeconds),
      const SizedBox(height: 6),
      SizedBox(
        width: 220,
        child: TextField(
          key: const ValueKey('sticker-cooldown-seconds'),
          controller: _cooldownInput,
          focusNode: _cooldownFocus,
          enabled: !_busy,
          keyboardType: TextInputType.number,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submitCooldown(),
          decoration: const InputDecoration(
            hintText: '0',
            isDense: true,
            border: OutlineInputBorder(),
            contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          ),
        ),
      ),
      const SizedBox(height: 6),
      Text(
        s.stickerCooldownSecondsHint,
        style: TextStyle(fontSize: 12, height: 1.5, color: Theme.of(context).colorScheme.onSurfaceVariant),
      ),
      const SizedBox(height: 20),
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

  Widget _group(String title, List<Map<String, dynamic>> entries, {int? count}) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text('$title ${count ?? entries.length}', style: const TextStyle(fontWeight: FontWeight.w600))),
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
