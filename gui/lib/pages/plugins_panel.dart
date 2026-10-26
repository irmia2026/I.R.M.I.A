import 'package:flutter/material.dart';

import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../ui_kit.dart';

List<Map<String, dynamic>> parsePluginsResponse(Object? raw) {
  final Object? items;
  if (raw is List) {
    items = raw;
  } else if (raw is Map && raw['items'] is List) {
    items = raw['items'];
  } else if (raw is Map && raw['plugins'] is List) {
    items = raw['plugins'];
  } else {
    throw const FormatException('plugins response must be an array or contain an items/plugins array');
  }
  return [
    for (final item in items as List)
      if (item is Map) item.cast<String, dynamic>(),
  ];
}

typedef PluginInstall = Future<void> Function(String sourceDir);
typedef PluginCommand = Future<void> Function(String command, String id, String contentHash);

class PluginsPanel extends StatelessWidget {
  const PluginsPanel({
    super.key,
    required this.view,
    required this.busy,
    required this.onInstall,
    required this.onCommand,
  });

  final Map<String, dynamic> view;
  final bool busy;
  final PluginInstall onInstall;
  final PluginCommand onCommand;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final items = [
      for (final item in view['items'] as List? ?? const [])
        if (item is Map) item.cast<String, dynamic>(),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _header(context, s),
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(s.extPluginSummary(items.length),
              style: TextStyle(fontSize: 12.5, color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ),
        if (items.isEmpty)
          StateBlock.empty(
            key: const ValueKey('plugins-empty'),
            icon: Icons.extension_outlined,
            message: s.extPluginEmpty,
            hint: s.extPluginEmptyHint,
            padding: const EdgeInsets.symmetric(vertical: 14),
          )
        else
          for (final item in items) _PluginCard(item: item, busy: busy, onReview: _review, onAction: _action),
      ],
    );
  }

  Widget _header(BuildContext context, AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.extension_outlined, size: 18, color: scheme.onSurfaceVariant),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.extSectionPlugins, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
                const SizedBox(height: 3),
                Text(s.extSectionPluginsBlurb,
                    style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          const SizedBox(width: 8),
          FilledButton.icon(
            key: const ValueKey('plugin-install'),
            onPressed: busy ? null : () => _install(context),
            icon: const Icon(Icons.add_rounded, size: 16),
            label: Text(s.extPluginInstall, style: const TextStyle(fontSize: 12.5)),
            style: FilledButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 14),
              minimumSize: const Size(0, 34),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _install(BuildContext context) async {
    final s = IrmiaStrings.read(context);
    final controller = TextEditingController();
    var submitted = false;
    String? error;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          return AlertDialog(
            constraints: const BoxConstraints(minWidth: 420, maxWidth: 560),
            title: Text(s.extPluginInstallTitle, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            content: TextField(
              key: const ValueKey('plugin-source-dir'),
              controller: controller,
              autofocus: true,
              decoration: InputDecoration(
                labelText: s.extPluginSourceDir,
                hintText: s.extPluginSourceHint,
                border: const OutlineInputBorder(),
                errorText: error,
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.of(dialogContext).pop(), child: Text(s.cancel)),
              FilledButton(
                key: const ValueKey('plugin-install-submit'),
                onPressed: () {
                  if (!_absoluteDirectory(controller.text.trim())) {
                    setDialogState(() => error = s.extPluginAbsoluteRequired);
                    return;
                  }
                  submitted = true;
                  Navigator.of(dialogContext).pop();
                },
                child: Text(s.extPluginInstall),
              ),
            ],
          );
        },
      ),
    );
    if (submitted) await onInstall(controller.text.trim());
    controller.dispose();
  }

  Future<void> _review(BuildContext context, Map<String, dynamic> item) async {
    final s = IrmiaStrings.read(context);
    final id = _id(item);
    final hash = _hash(item);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        constraints: const BoxConstraints(minWidth: 420, maxWidth: 560),
        title: Text(s.extPluginReviewTitle(id), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
        content: Text(s.extPluginReviewBody(id, hash),
            style: TextStyle(fontSize: 13, height: 1.7, color: Theme.of(dialogContext).colorScheme.onSurfaceVariant)),
        actions: [
          TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(s.cancel)),
          FilledButton.tonal(
            key: const ValueKey('plugin-review-confirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(s.extPluginReview),
          ),
        ],
      ),
    );
    if (confirmed == true) await onCommand('plugin-confirm', id, hash);
  }

  Future<void> _action(BuildContext context, Map<String, dynamic> item, String command) async {
    final s = IrmiaStrings.read(context);
    final id = _id(item);
    final enable = command == 'plugin-enable';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final scheme = Theme.of(dialogContext).colorScheme;
        return AlertDialog(
          title: Text(enable ? s.extPluginEnableTitle(id) : s.extPluginDisableTitle(id),
              style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          content: Text(s.extPluginRestartBody,
              style: TextStyle(fontSize: 13, height: 1.7, color: scheme.onSurfaceVariant)),
          actions: [
            TextButton(onPressed: () => Navigator.of(dialogContext).pop(false), child: Text(s.cancel)),
            FilledButton.tonal(
              key: const ValueKey('plugin-action-confirm'),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              style: enable ? null : FilledButton.styleFrom(backgroundColor: scheme.error, foregroundColor: scheme.onError),
              child: Text(enable ? s.extPluginEnable : s.extPluginDisable),
            ),
          ],
        );
      },
    );
    if (confirmed == true) await onCommand(command, id, _hash(item));
  }
}

class _PluginCard extends StatelessWidget {
  const _PluginCard({required this.item, required this.busy, required this.onReview, required this.onAction});

  final Map<String, dynamic> item;
  final bool busy;
  final Future<void> Function(BuildContext, Map<String, dynamic>) onReview;
  final Future<void> Function(BuildContext, Map<String, dynamic>, String) onAction;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final id = _id(item);
    final state = '${item['state'] ?? ''}';
    final manifest = _manifest(item);
    final contributions = manifest['contributions'] is Map
        ? (manifest['contributions'] as Map).cast<String, dynamic>()
        : const <String, dynamic>{};
    final skills = contributions['skills'] is List ? (contributions['skills'] as List).length : 0;
    final hooks = '${contributions['hooks'] ?? ''}'.isEmpty ? 0 : 1;
    final mcp = '${contributions['mcp'] ?? ''}'.isEmpty ? 0 : 1;
    final permissions = [
      for (final value in manifest['permissions'] as List? ?? const []) '$value',
    ];
    final problems = [for (final value in item['problems'] as List? ?? const []) '$value'];
    final circuit = item['circuit'] is Map ? (item['circuit'] as Map).cast<String, dynamic>() : null;

    return Container(
      key: ValueKey('plugin-$id'),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(16, 13, 12, 14),
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
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Wrap(
                  spacing: 8,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Text(id, style: const TextStyle(fontFamily: 'monospace', fontSize: 14, fontWeight: FontWeight.w600)),
                    _badge(s.extPluginState(state), _stateColor(scheme, state)),
                    if (item['requiresRestart'] == true) _badge(s.extPluginRestartRequired, IrmiaTheme.warn),
                  ],
                ),
              ),
              if (state == 'untrusted')
                TextButton(
                  key: ValueKey('plugin-review-$id'),
                  onPressed: busy ? null : () => onReview(context, item),
                  child: Text(s.extPluginReview),
                )
              else if (state == 'disabled')
                TextButton(
                  key: ValueKey('plugin-enable-$id'),
                  onPressed: busy ? null : () => onAction(context, item, 'plugin-enable'),
                  child: Text(s.extPluginEnable),
                )
              else if (state == 'enabled' || state == 'quarantined' || state == 'probing')
                TextButton(
                  key: ValueKey('plugin-disable-$id'),
                  onPressed: busy ? null : () => onAction(context, item, 'plugin-disable'),
                  child: Text(s.extPluginDisable),
                ),
            ],
          ),
          const SizedBox(height: 5),
          SelectableText(
            s.extPluginVersionHash('${manifest['version'] ?? '—'}', _hash(item)),
            style: TextStyle(fontFamily: 'monospace', fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 4),
          Text(s.extPluginContributions(skills, hooks, mcp),
              style: const TextStyle(fontSize: 12.5, height: 1.5)),
          const SizedBox(height: 4),
          Text('${s.extPluginPermissionsLabel}: ${permissions.isEmpty ? '—' : permissions.join(', ')}',
              style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
          if (problems.isNotEmpty) ...[
            const SizedBox(height: 7),
            Text(s.extPluginProblemsLabel,
                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: IrmiaTheme.danger)),
            for (final problem in problems)
              Text(problem, style: TextStyle(fontSize: 12, height: 1.5, color: IrmiaTheme.danger)),
          ],
          if (circuit != null) ...[
            const SizedBox(height: 7),
            Text(
              s.extPluginCircuit(
                '${circuit['contributionKind'] ?? '—'}/${circuit['contributionName'] ?? '—'}',
                _int(circuit['count']),
              ),
              style: TextStyle(fontSize: 12, height: 1.5, color: IrmiaTheme.danger),
            ),
            if ('${circuit['lastError'] ?? ''}'.isNotEmpty)
              Text(s.extPluginCircuitReason('${circuit['lastError']}'),
                  style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
            if ('${circuit['retryAt'] ?? ''}'.isNotEmpty)
              Text(s.extPluginRetryAt('${circuit['retryAt']}'),
                  style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
          ],
        ],
      ),
    );
  }
}

Map<String, dynamic> _manifest(Map<String, dynamic> item) {
  if (item['package'] is! Map) return const {};
  final package = (item['package'] as Map).cast<String, dynamic>();
  return package['manifest'] is Map ? (package['manifest'] as Map).cast<String, dynamic>() : const {};
}

String _id(Map<String, dynamic> item) => '${_manifest(item)['id'] ?? ''}';

String _hash(Map<String, dynamic> item) {
  if (item['package'] is! Map) return '';
  return '${(item['package'] as Map)['contentHash'] ?? ''}';
}

int _int(Object? value) => value is num ? value.toInt() : int.tryParse('$value') ?? 0;

bool _absoluteDirectory(String value) =>
    RegExp(r'^(?:[A-Za-z]:[\\/]|/|\\\\)').hasMatch(value);

Color _stateColor(ColorScheme scheme, String state) => switch (state) {
      'enabled' => IrmiaTheme.ok,
      'invalid' || 'quarantined' => IrmiaTheme.danger,
      'untrusted' || 'probing' => IrmiaTheme.warn,
      _ => scheme.onSurfaceVariant,
    };

Widget _badge(String text, Color color) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w500)),
    );
