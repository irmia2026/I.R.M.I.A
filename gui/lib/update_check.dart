/// 更新检查的**界面那一半**（数据模型 + 顶部提醒条 + 设置页那一块 + 下载页）。
///
/// 它只做显示与"人去点"的动作，**不自己判节流、不自己发请求、不自己下载**：
///   · 数据来自 `GET /api/update`（`UpdateInfo.fromJson` 是唯一的解析点）；
///   · 手动检查走 `AppState.checkUpdateNow()`（`POST /api/update/check`）；
///   · 切通道走 `AppState.switchUpdateChannel()`（`POST /api/update/channel`，服务端写 config +
///     清节流 + 立刻查一次）；
///   · 打开外链走 `lib/external_link.dart`（全仓唯一一条 `Process.run`，**没有新依赖**）。
///
/// 三条文案口径（与 docs/update-check.md §5 同源）：
///   · 有新版本：`有新版本 vX（当前 vY）· 查看`——**提示条 / 设置页 / 下载页读同一个 key**
///     （`AppStrings.updateNewVersionTitle`）；
///   · 必须升级：同一句 + `低于最低可用版本，请先升级`，**不可关**；
///   · "这次没查到"不是错误：只在设置页那一行说一句原因，**不弹窗**。
///
/// 文案全在 `lib/i18n/app_strings.dart`（这里一个中文字面量都没有——
/// `test/copy_coverage_test.dart` 会拦；注释不算）。
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import 'external_link.dart';
import 'i18n/strings_scope.dart';

/// 一个平台产物（下载页的一行）：`_pending:true` 时灰掉并标「待上传」。
class UpdatePlatformInfo {
  const UpdatePlatformInfo({
    required this.os,
    required this.arch,
    required this.kind,
    required this.url,
    required this.pending,
  });

  final String os;
  final String arch;
  final String kind;
  final String url;
  final bool pending;

  static UpdatePlatformInfo? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final os = _text(raw['os']);
    final arch = _text(raw['arch']);
    final kind = _text(raw['kind']);
    if (os == null || arch == null || kind == null) return null;
    return UpdatePlatformInfo(
      os: os,
      arch: arch,
      kind: kind,
      url: _text(raw['url']) ?? '',
      pending: raw['pending'] == true,
    );
  }
}

/// 网盘分流（用户定下的结构）：`pending` = 还没开放；`baidu` / `quark` = 已就绪。
class UpdateMirrorInfo {
  const UpdateMirrorInfo({required this.provider, this.url, this.code});

  final String provider;
  final String? url;
  final String? code;

  /// 点了能打开才算就绪（`pending` 或没有地址都算未就绪）
  bool get ready => provider != 'pending' && url != null && url!.isNotEmpty;

  static UpdateMirrorInfo? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final provider = _text(raw['provider']);
    if (provider == null) return null;
    return UpdateMirrorInfo(
      provider: provider,
      url: _text(raw['url']),
      code: _text(raw['code']),
    );
  }
}

String? _text(Object? value) {
  if (value is String && value.trim().isNotEmpty) return value.trim();
  return null;
}

/// `GET /api/update` / `POST /api/update/check` 的 `view` 那一格。
///
/// 字段与 `src/update/service.ts` 的 `UpdateView` 一一对应；**只读**，不做本地推断
/// （`status` / `dismissible` 都由服务端给，界面不另算一份——两处判据必然漂移）。
class UpdateInfo {
  const UpdateInfo({
    required this.enabled,
    required this.channel,
    required this.currentVersion,
    required this.status,
    required this.intervalHours,
    required this.dismissible,
    this.latestVersion,
    this.downloadUrl,
    this.notesUrl,
    this.minimumVersion,
    this.reason,
    this.checkedAt,
    this.lastSuccessAt,
    this.nextAllowedAt,
    this.releasesUrl,
    this.platforms = const <UpdatePlatformInfo>[],
    this.mirrors = const <UpdateMirrorInfo>[],
  });

  final bool enabled;
  final String channel;
  final String currentVersion;

  /// `none` / `available` / `required` / `unknown`（后者的意思是"这次没查到"）
  final String status;
  final int intervalHours;
  final bool dismissible;
  final String? latestVersion;
  final String? downloadUrl;
  final String? notesUrl;
  final String? minimumVersion;
  final String? reason;
  final String? checkedAt;
  final String? lastSuccessAt;
  final String? nextAllowedAt;

  /// 官方发布页（服务端由端点 origin 推出来）；「查看」没有 notesUrl 时用它
  final String? releasesUrl;

  /// 平台产物（下载页按它分流；`_pending` 的那几条也在，供界面灰掉）
  final List<UpdatePlatformInfo> platforms;

  /// 网盘分流（今天恒为一条 `pending`）
  final List<UpdateMirrorInfo> mirrors;

  /// 有没有值得提示的版本（`required` 也算——而且它更该被看见）
  bool get hasUpdate => status == 'available' || status == 'required';

  /// 低于站点声明的最低可用版本：**不可 dismiss**，文案也不一样
  bool get required => status == 'required';

  /// 已是最新
  bool get upToDate => status == 'none';

  /// 这次没查到（网络/超时/坏 JSON/`_pending`…）：**不是错误**
  bool get unknown => status == 'unknown';

  /// 站点上没有这条通道的版本（`none` 里唯一需要人多看一眼的那一种）
  bool get channelMismatch => status == 'none' && reason == 'channel-mismatch';

  /// 「查看」/「官方发布页」该打开哪个地址：notes 优先，其次服务端给的发布页
  String? get viewUrl => notesUrl ?? releasesUrl;

  /// 解析服务端响应。形状不对 ⇒ null（界面显示"读不到"，不猜）。
  static UpdateInfo? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final status = _text(raw['status']);
    final current = _text(raw['currentVersion']);
    final channel = _text(raw['channel']);
    if (status == null || current == null || channel == null) return null;
    final interval = raw['intervalHours'];
    return UpdateInfo(
      enabled: raw['enabled'] == true,
      channel: channel,
      currentVersion: current,
      status: status,
      intervalHours: interval is num ? interval.toInt() : 12,
      dismissible: raw['dismissible'] != false,
      latestVersion: _text(raw['latestVersion']),
      downloadUrl: _text(raw['downloadUrl']),
      notesUrl: _text(raw['notesUrl']),
      minimumVersion: _text(raw['minimumVersion']),
      reason: _text(raw['reason']),
      checkedAt: _text(raw['checkedAt']),
      lastSuccessAt: _text(raw['lastSuccessAt']),
      nextAllowedAt: _text(raw['nextAllowedAt']),
      releasesUrl: _text(raw['releasesUrl']),
      platforms: <UpdatePlatformInfo>[
        for (final item in (raw['platforms'] is List ? raw['platforms'] as List : const <Object?>[]))
          if (UpdatePlatformInfo.fromJson(item) case final platform?) platform,
      ],
      mirrors: <UpdateMirrorInfo>[
        for (final item in (raw['mirrors'] is List ? raw['mirrors'] as List : const <Object?>[]))
          if (UpdateMirrorInfo.fromJson(item) case final mirror?) mirror,
      ],
    );
  }
}

/// ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；解析不了给 `—`（**不猜**）。
String formatUpdateStamp(String? iso) {
  if (iso == null || iso.isEmpty) return '—';
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return '—';
  final local = parsed.toLocal();
  String two(int value) => value.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} '
      '${two(local.hour)}:${two(local.minute)}';
}

/// **主界面顶部那条提示**（有新版本 / 必须升级）。
///
/// `required` 时**没有 ×**（不可 dismiss）：那是"低于最低可用版本，请先升级"，
/// 用户关掉它并不会让版本变新。`available` 时 × 是一次性的——关掉之后
/// `dismissedVersion` 记住"这一版我已经看过了"，下一个版本再出现时重来。
///
/// 「查看」**用系统浏览器打开发布页**（`notesUrl` 或服务端推出来的发布页），
/// **不是**在界面里下载：这一段只打开一个链接，什么时候下、下哪个由人在浏览器里决定。
class UpdateBanner extends StatelessWidget {
  const UpdateBanner({
    required this.info,
    required this.dismissedVersion,
    required this.onDismiss,
    super.key,
  });

  final UpdateInfo? info;

  /// 已经被关掉的那一版（`%APPDATA%/Irmia/ui-state.json` 的 `update-dismissed-version`）
  final String dismissedVersion;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final data = info;
    // 关掉更新检查（update.enabled=false）时连提醒也不显示：那是"本进程一个更新请求都不发"
    // 的一半含义——另一半是不发请求（判据在服务端，界面只照着做）。
    if (data == null || !data.enabled || !data.hasUpdate) return const SizedBox.shrink();
    // required 不可关：连"已关掉"都不看（旧版本关过一次，升级线压下来时仍要出现）
    if (!data.required && dismissedVersion == data.latestVersion) {
      return const SizedBox.shrink();
    }

    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final background = data.required ? scheme.errorContainer : scheme.primaryContainer;
    final foreground = data.required ? scheme.onErrorContainer : scheme.onPrimaryContainer;
    final latest = data.latestVersion ?? '?';
    // 三处（提示条/设置页/下载页）共用 updateNewVersionTitle 这一条；后缀各按场景拼。
    final text = data.required
        ? '${s.updateNewVersionTitle(latest, data.currentVersion)}· ${s.updateRequiredNotice}'
        : '${s.updateNewVersionTitle(latest, data.currentVersion)}· ${s.updateView}';

    return Material(
      key: const ValueKey('update-banner'),
      color: background,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 6, 10, 6),
        child: Row(
          children: [
            Icon(
              data.required ? Icons.gpp_maybe_rounded : Icons.system_update_alt_rounded,
              size: 18,
              color: foreground,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                text,
                key: const ValueKey('update-banner-text'),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12.5, height: 1.35, color: foreground),
              ),
            ),
            TextButton(
              key: const ValueKey('update-banner-view'),
              onPressed: () => unawaited(_openReleasePage(context, data)),
              style: TextButton.styleFrom(foregroundColor: foreground),
              child: Text(s.updateView),
            ),
            if (!data.required)
              IconButton(
                key: const ValueKey('update-banner-dismiss'),
                tooltip: s.updateDismiss,
                iconSize: 16,
                visualDensity: VisualDensity.compact,
                color: foreground,
                onPressed: onDismiss,
                icon: const Icon(Icons.close_rounded),
              ),
          ],
        ),
      ),
    );
  }

  /// 用系统默认浏览器打开发布页（打不开就把地址说出来——与设置页 `_openUrl` 同一条口径）。
  ///
  /// **只有人点这一下才会开浏览器**：检测、提醒、轮询都不碰任何外部程序。
  Future<void> _openReleasePage(BuildContext context, UpdateInfo data) async {
    final s = IrmiaStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final url = data.viewUrl;
    if (url == null) {
      messenger.showSnackBar(SnackBar(content: Text(s.updateNoPage)));
      return;
    }
    final opened = await openExternalUrl(url);
    messenger.showSnackBar(SnackBar(
      content: Text(opened ? s.settingsOpenedUrl(url) : s.settingsOpenUrlFailed(url, null)),
    ));
  }
}

/// **设置页「关于」里那一块**：当前状态 + 通道切换 + 「立即检查」+ 下载入口。
///
/// 手动检查立刻发请求（服务端那边无视 12h/24h 节流），所以按钮旁边永远有一行
/// 「上次检查 / 下次允许」——人按完能立刻看到时间变了，不必猜"到底有没有查"。
class UpdateCheckSection extends StatelessWidget {
  const UpdateCheckSection({
    required this.info,
    required this.busy,
    required this.switching,
    required this.error,
    required this.onCheck,
    required this.onChannel,
    required this.onDownload,
    super.key,
  });

  final UpdateInfo? info;
  final bool busy;

  /// 切通道在飞（写 config + 清节流 + 立刻查一次，一次请求）
  final bool switching;

  /// 读/查/切失败时的那句话（空 = 没问题）。**只在这一行说**，不弹窗。
  final String error;
  final VoidCallback onCheck;
  final ValueChanged<String> onChannel;

  /// 打开 GUI 的下载页（平台分流 / 网盘分流 / 官方发布页）
  final VoidCallback onDownload;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final data = info;
    final disabled = data != null && !data.enabled;
    final channel = data?.channel ?? 'beta';

    return Column(
      key: const ValueKey('update-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Divider(height: 26),
        Row(
          children: [
            Text(
              s.updateSectionTitle,
              style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
            const Spacer(),
            if (data != null && data.hasUpdate) ...[
              OutlinedButton.icon(
                key: const ValueKey('update-download'),
                onPressed: onDownload,
                icon: const Icon(Icons.download_rounded, size: 16),
                label: Text(s.updateDownloadTitle),
              ),
              const SizedBox(width: 8),
            ],
            FilledButton.tonalIcon(
              key: const ValueKey('update-check-now'),
              onPressed: busy || disabled ? null : onCheck,
              icon: busy
                  ? const SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.refresh_rounded, size: 16),
              label: Text(busy ? s.updateChecking : s.updateCheckNow),
            ),
          ],
        ),
        const SizedBox(height: 8),
        // 通道：beta / stable。**写回 config（update.channel）**，服务端当场清节流 + 查一次。
        // 两档的名字是标识（不翻译），后面的括注走文案表。
        Row(
          children: [
            Text(s.updateChannelLabel(channel), style: const TextStyle(fontSize: 12.5)),
            const SizedBox(width: 12),
            SegmentedButton<String>(
              key: const ValueKey('update-channel-switch'),
              segments: const <ButtonSegment<String>>[
                ButtonSegment<String>(value: 'beta', label: Text('Beta')),
                ButtonSegment<String>(value: 'stable', label: Text('Stable')),
              ],
              selected: <String>{channel == 'stable' ? 'stable' : 'beta'},
              showSelectedIcon: false,
              style: SegmentedButton.styleFrom(
                visualDensity: VisualDensity.compact,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onSelectionChanged: switching || disabled ? null : (picked) => onChannel(picked.first),
            ),
            if (switching) ...[
              const SizedBox(width: 8),
              const SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 2)),
            ],
          ],
        ),
        const SizedBox(height: 4),
        Text(
          s.updateChannelSwitchNote,
          style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        if (disabled)
          Text(s.updateDisabled, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant))
        else if (data == null)
          Text(
            // 还没读到（刚进门那一瞬）与读失败是两句不同的话：前者只是"还没查过"，
            // 后者才需要把原因摆出来。**两句都不弹窗**。
            error.isEmpty ? s.updateNeverChecked : s.updateCheckFailed(error),
            style: TextStyle(
              fontSize: 12,
              color: error.isEmpty ? scheme.onSurfaceVariant : scheme.error,
            ),
          )
        else ...[
          _statusLine(context, data),
          const SizedBox(height: 6),
          Wrap(
            spacing: 18,
            runSpacing: 4,
            children: [
              _meta(context, s.updateCurrentVersion(data.currentVersion)),
              _meta(
                context,
                data.checkedAt == null
                    ? s.updateNeverChecked
                    : s.updateLastChecked(formatUpdateStamp(data.checkedAt)),
              ),
              if (data.nextAllowedAt != null && !data.required)
                _meta(context, s.updateNextAllowed(formatUpdateStamp(data.nextAllowedAt))),
            ],
          ),
          if (error.isNotEmpty) ...[
            const SizedBox(height: 6),
            Text(s.updateCheckFailed(error), style: TextStyle(fontSize: 12, color: scheme.error)),
          ],
        ],
        const SizedBox(height: 6),
        Text(
          s.updateSectionNote,
          style: TextStyle(fontSize: 11.5, height: 1.55, color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }

  /// 一行状态（按 `status` 四种取值各一句；**required 用错误色**）
  Widget _statusLine(BuildContext context, UpdateInfo data) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final latest = data.latestVersion ?? '?';
    if (data.required) {
      return Column(
        key: const ValueKey('update-status'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            s.updateNewVersionTitle(latest, data.currentVersion),
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.error),
          ),
          const SizedBox(height: 2),
          Text(
            data.minimumVersion == null
                ? s.updateRequiredNotice
                : s.updateRequiredText(data.minimumVersion!),
            style: TextStyle(fontSize: 12, color: scheme.error),
          ),
        ],
      );
    }
    if (data.hasUpdate) {
      // 与提示条、下载页**同一个 key**（用户：同一句话三处不许各写一份）
      return Text(
        s.updateNewVersionTitle(latest, data.currentVersion),
        key: const ValueKey('update-status'),
        style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.primary),
      );
    }
    if (data.channelMismatch) {
      return Text(
        s.updateChannelMismatchText,
        key: const ValueKey('update-status'),
        style: const TextStyle(fontSize: 12.5),
      );
    }
    if (data.upToDate) {
      return Text(
        s.updateUpToDate,
        key: const ValueKey('update-status'),
        style: const TextStyle(fontSize: 12.5),
      );
    }
    return Text(
      s.updateUnknownText(s.updateReasonText(data.reason ?? '')),
      key: const ValueKey('update-status'),
      style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
    );
  }

  Widget _meta(BuildContext context, String text) => Text(
        text,
        style: TextStyle(fontSize: 11.5, color: Theme.of(context).colorScheme.onSurfaceVariant),
      );
}

/// 打开 **GUI 的下载页**（不是浏览器那个页面）：平台分流 + 网盘分流 + 官方发布页。
///
/// 三条硬纪律：
///   · **不自动下载、不静默安装**：这里只把地址交给系统浏览器（人点一下才发生）；
///   · `_pending:true` 的平台灰掉并标「待上传」；
///   · 网盘 `pending` ⇒ 「网盘下载 · 即将开放」disabled；`baidu`/`quark` 就绪后按 provider
///     出「百度网盘下载」/「夸克网盘下载」，有提取码就显示并给一键复制。
Future<void> showUpdateReleaseDialog(BuildContext context, UpdateInfo info) {
  return showDialog<void>(
    context: context,
    builder: (dialogContext) => _UpdateReleaseDialog(info: info),
  );
}

class _UpdateReleaseDialog extends StatelessWidget {
  const _UpdateReleaseDialog({required this.info});

  final UpdateInfo info;

  Future<void> _open(BuildContext context, String? url) async {
    final s = IrmiaStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    if (url == null || url.isEmpty) {
      messenger.showSnackBar(SnackBar(content: Text(s.updateNoPage)));
      return;
    }
    final opened = await openExternalUrl(url);
    messenger.showSnackBar(SnackBar(
      content: Text(opened ? s.settingsOpenedUrl(url) : s.settingsOpenUrlFailed(url, null)),
    ));
  }

  /// 平台按钮的文案：就绪 = 「GitHub 下载」；待上传 = 「待上传」disabled
  Widget _platformButton(BuildContext context, UpdatePlatformInfo platform, int index) {
    final s = IrmiaStrings.of(context);
    final label = platform.pending ? s.updatePendingUpload : s.updateGitHubDownload;
    final onPressed = platform.pending || platform.url.isEmpty
        ? null
        : () => unawaited(_open(context, platform.url));
    return OutlinedButton(
      key: ValueKey<String>('update-platform-$index'),
      onPressed: onPressed,
      child: Text(label),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final latest = info.latestVersion ?? '?';
    return AlertDialog(
      key: const ValueKey('update-dialog'),
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(s.updateDownloadTitle, style: const TextStyle(fontSize: 16)),
          const SizedBox(height: 4),
          Text(
            s.updateNewVersionTitle(latest, info.currentVersion),
            key: const ValueKey('update-dialog-title'),
            style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant),
          ),
        ],
      ),
      content: SizedBox(
        width: 520,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                s.updateDownloadNote,
                style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
              ),
              if (info.platforms.isNotEmpty) ...[
                const SizedBox(height: 14),
                for (var index = 0; index < info.platforms.length; index += 1) ...[
                  if (index > 0) const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          s.updatePlatformLine(
                            info.platforms[index].os,
                            info.platforms[index].arch,
                            info.platforms[index].kind,
                          ),
                          style: const TextStyle(fontSize: 12.5),
                        ),
                      ),
                      _platformButton(context, info.platforms[index], index),
                    ],
                  ),
                ],
              ],
              if (info.mirrors.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text(
                  s.updateNetdiskDownload,
                  style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 6),
                for (var index = 0; index < info.mirrors.length; index += 1) ...[
                  if (index > 0) const SizedBox(height: 8),
                  _mirrorRow(context, info.mirrors[index], index),
                ],
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (info.viewUrl != null)
          TextButton(
            key: const ValueKey('update-open-release'),
            onPressed: () => unawaited(_open(context, info.viewUrl)),
            child: Text(s.updateReleasePage),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(s.confirm),
        ),
      ],
    );
  }

  Widget _mirrorRow(BuildContext context, UpdateMirrorInfo mirror, int index) {
    final s = IrmiaStrings.of(context);
    if (!mirror.ready) {
      // 未就绪（今天就是这一档）：disabled + 「即将开放」，不摆一个点了没反应的按钮
      return Row(
        children: [
          OutlinedButton(
            key: ValueKey<String>('update-mirror-$index'),
            onPressed: null,
            child: Text('${s.updateNetdiskDownload} · ${s.updateNetdiskSoon}'),
          ),
        ],
      );
    }
    final label = mirror.provider == 'baidu' ? s.updateBaiduDownload : s.updateQuarkDownload;
    final code = mirror.code;
    return Wrap(
      spacing: 10,
      runSpacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        OutlinedButton(
          key: ValueKey<String>('update-mirror-$index'),
          onPressed: () => unawaited(_open(context, mirror.url)),
          child: Text(label),
        ),
        if (code != null) Text(s.updateExtractCode(code), style: const TextStyle(fontSize: 12.5)),
        if (code != null)
          TextButton(
            key: ValueKey<String>('update-copy-code-$index'),
            onPressed: () => unawaited(_copyCode(context, code)),
            child: Text(s.updateCopyCode),
          ),
      ],
    );
  }

  Future<void> _copyCode(BuildContext context, String code) async {
    final s = IrmiaStrings.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await Clipboard.setData(ClipboardData(text: code));
      messenger.showSnackBar(SnackBar(content: Text(s.updateCopied)));
    } catch (_) {
      // 剪贴板在某些受限环境会失败：那就把提取码留在屏幕上，人自己选中复制
    }
  }
}
