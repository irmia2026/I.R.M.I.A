/// **实例选择页**（2026-10，多实例）：「关掉实例 / 彻底登出」之后的落点。
///
/// ## 它为什么在"门"上，而不是壳里的一页
///
/// 走到这里时手上**没有实例**：上一台的后端已经停了（`AppState.closeInstance` 三步 /
/// `AppState.logout` 三步），壳里的一切数据都属于那台已经不存在的实例。所以它是
/// [AuthGateKind.picker]——门上的第三种画面，和"设置密码 / 登录"同级。门只画"还没进去的
/// 时候看什么"，页面本身不读任何实例数据。
///
/// ## 这一页能做七件事（也只有这七件）
///
///   · **进入**（有票且它在跑）：`GET /api/instance` 问得通 ⇒ 直接切过去——盘上那张票
///     有效就**不再打密码门**（2026-10-27，用户的口径："如果登回来了就接着吗？"）；
///   · **启动并进入**（有票但它没跑）：先用**登记表里它自己那条**（node / entry / dataDir）
///     拉起来，轮询 `/api/instance` 到就绪（≤180 秒），再拿票直接进；
///   · **登录 / 启动并登录**（没票，或票刚被服务端判 401）：走密码门（该设密码还是该登录
///     由服务端的事实决定）；
///   · **新建实例**：名字 + 数据目录（默认 `<数据目录的父目录>/instances/<名字>`）→ 端口从
///     7788 起向上找第一个空闲 → 拉起 → 等就绪 → 进**首次设密码**；
///   · **忘记凭据**（每行那行小字，二次确认）：只清**本机这一份** token——实例照跑、
///     登记表条目照留（`AppState.forgetCredential`）；
///   · **改名**：原名旁边那个小铅笔（只改登记表里显示的名字，写 `nameSource: "manual"`，
///     后端此后永不覆盖——见 `AppState.renameInstance`）；
///   · **删除实例**：只允许**未运行**且**非默认**（判据只有一处：`InstanceEntry.canDelete`）；
///     默认只删条目，目录留不留由人在确认框里选（默认留）。
///
/// ⚠ **这里没有任何"跨实例写"的入口**：列表是只读的（除了新建自己的 / 改自己的名 / 删自己的），
/// 点任何一台都是"切过去、以它自己的身份进门"。理由见 `gui/lib/instances.dart` 的文件头。
///
/// ⚠ **这里也不作废凭据**：本页没有"登出"这个词（那个动作在设置页「账号与安全」里，
/// 是安全出口）。`[life] close … token=kept` 是这一页那条路留下的现场。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'app.dart';
import 'i18n/app_strings.dart';
import 'i18n/strings_scope.dart';
import 'instances.dart';
import 'theme.dart';
import 'ui_kit.dart';

/// 选择页（门上的第三种画面）
class InstancePicker extends StatefulWidget {
  const InstancePicker({super.key, required this.state});

  final AppState state;

  @override
  State<InstancePicker> createState() => _InstancePickerState();
}

class _InstancePickerState extends State<InstancePicker> {
  final _name = TextEditingController();
  final _dir = TextEditingController();

  /// 新建表单展开了吗
  bool _formOpen = false;

  /// 目录那一格被人改过吗（没改过就跟着名字自动填默认值）
  bool _dirTouched = false;

  @override
  void initState() {
    super.initState();
    // 进这一页就要读一次登记表：内容不属于任何实例，**没有一个"已经加载好"的时机**
    unawaited(widget.state.refreshInstances());
  }

  @override
  void dispose() {
    _name.dispose();
    _dir.dispose();
    super.dispose();
  }

  AppState get state => widget.state;

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 16),
          child: Container(
            width: 640,
            padding: const EdgeInsets.all(24),
            decoration: BoxDecoration(
              color: scheme.surface,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: scheme.outlineVariant),
              boxShadow: IrmiaTheme.hairline,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Center(child: HerFace(size: 56, radius: 18)),
                const SizedBox(height: 14),
                Text(s.pickerTitle, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: 6),
                Text(
                  s.pickerBody,
                  style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant, height: 1.6),
                ),
                const SizedBox(height: 16),
                _list(context, s),
                _waiting(context, s),
                _sessionExpiredNote(context, s),
                _problem(context, s),
                if (_formOpen) ...[
                  const SizedBox(height: 12),
                  _newInstanceForm(context, s),
                ],
                const SizedBox(height: 16),
                Row(
                  children: [
                    FilledButton(
                      key: const ValueKey('picker-new'),
                      onPressed: state.pickerBusyId == null
                          ? () {
                              setState(() {
                                _formOpen = !_formOpen;
                                if (_formOpen && _dir.text.trim().isEmpty && _name.text.trim().isNotEmpty) {
                                  _dir.text = state.defaultInstanceDir(_name.text);
                                }
                              });
                            }
                          : null,
                      child: Text(s.pickerNew),
                    ),
                    const Spacer(),
                    if (state.instancesLoading)
                      const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ──────────────────────────────── 列表 ────────────────────────────────

  Widget _list(BuildContext context, AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    if (state.instancesLoading && state.instancesList.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(s.pickerLoading, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
      );
    }
    if (state.instancesList.isEmpty) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Text(
          // 三档分开说：真的还没有实例（文件都不在）/ 有文件但读坏了 / 正常
          state.instancesMissing || state.instancesReadable ? s.pickerEmpty : s.pickerUnreadable,
          key: const ValueKey('picker-empty'),
          style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant, height: 1.6),
        ),
      );
    }
    final rows = <Widget>[];
    for (final entry in state.instancesList) {
      rows.add(_row(context, s, entry));
    }
    return Column(children: rows);
  }

  Widget _row(BuildContext context, AppStrings s, InstanceEntry entry) {
    final scheme = Theme.of(context).colorScheme;
    final running = state.instancesRunning[entry.id] == true;
    // 本机有没有这一台的票：按钮的字就靠它（[AppState.hasTokenFor]，判据只有一处）
    final hasToken = state.hasTokenFor(entry);
    final busy = state.pickerBusyId == entry.id || state.pickerBusyId == '';
    final deletable = InstanceEntry.canDelete(entry: entry, running: running);
    final reason = entry.isDefault ? s.pickerDefaultBadge : s.pickerRunning;
    // 这颗按钮的两根轴：**有票吗**（要不要密码）× **在跑吗**（要不要先拉起）。
    //   · 有票 + 在跑   ⇒ 「进入」        —— 点一下直接进壳，不打密码门；
    //   · 有票 + 没跑   ⇒ 「启动并进入」  —— 拉起，再拿票直接进；
    //   · 没票 + 在跑   ⇒ 「登录」        —— 走现有登录门（票没了，只能凭密码）；
    //   · 没票 + 没跑   ⇒ 「启动并登录」  —— 两件都要做，字面上也得说清楚。
    // 忙的那一台显示进度词：正在拉起 ⇒ 「正在启动…」；已经在跑（在验票）⇒ 「正在进入…」。
    final String label;
    if (busy && state.pickerBusyId == entry.id) {
      label = running ? s.pickerEntering : s.pickerStarting;
    } else if (hasToken) {
      label = running ? s.pickerEnter : s.pickerStartEnter;
    } else {
      label = running ? s.pickerLogin : s.pickerStart;
    }
    return Container(
      key: ValueKey('instance-row-${entry.id}'),
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Row(
        children: [
          // 实心 = 运行中、空心 = 未运行（颜色不是唯一判据：右边还有一行字）
          Icon(
            running ? Icons.circle : Icons.radio_button_unchecked,
            size: 10,
            color: running ? IrmiaTheme.ok : scheme.onSurfaceVariant,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        entry.name,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                      ),
                    ),
                    // 改名入口就在原名旁边（铅笔）：改名只动登记表，写 `nameSource: "manual"`，
                    // 后端此后永不覆盖它（见 `AppState.renameInstance`）
                    IconButton(
                      key: ValueKey('instance-rename-${entry.id}'),
                      tooltip: s.pickerRename,
                      icon: const Icon(Icons.edit_outlined, size: 14),
                      visualDensity: VisualDensity.compact,
                      padding: EdgeInsets.zero,
                      constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
                      onPressed: state.pickerBusyId == null
                          ? () => unawaited(_confirmRename(entry))
                          : null,
                    ),
                    if (entry.isDefault) ...[
                      const SizedBox(width: 8),
                      _badge(s.pickerDefaultBadge, scheme),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  '${entry.address} · ${running ? s.pickerRunning : s.pickerStopped}',
                  key: ValueKey('instance-state-${entry.id}'),
                  style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            key: ValueKey('instance-open-${entry.id}'),
            onPressed: state.pickerBusyId == null ? () => unawaited(state.openInstance(entry)) : null,
            child: Text(label),
          ),
          // 有票才给「忘记凭据」：没票的那一行没有可忘的东西（灰着反而是噪音）。
          // 字号落在**子 Text** 上而不是 `ButtonStyle.textStyle` 上：后者不参与
          // DefaultTextStyle 合并，会把按钮的字体栈丢掉（见 button_typography_test 那条锁）。
          if (hasToken)
            TextButton(
              key: ValueKey('instance-forget-${entry.id}'),
              // 只清本机这一份 token：**不停实例、不动登记表**（见 AppState.forgetCredential）
              onPressed: state.pickerBusyId == null ? () => unawaited(_confirmForget(entry)) : null,
              style: TextButton.styleFrom(
                foregroundColor: scheme.onSurfaceVariant,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                minimumSize: const Size(0, 30),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: Text(s.pickerForget, style: const TextStyle(fontSize: 11.5)),
            ),
          const SizedBox(width: 6),
          Tooltip(
            message: deletable ? s.pickerDelete : s.pickerDeleteDisabled(reason),
            child: TextButton(
              key: ValueKey('instance-delete-${entry.id}'),
              // **灰着本身就是一句话**：运行中 / 默认实例不能删（理由在 tooltip 与上面那行状态里）
              onPressed: deletable && state.pickerBusyId == null
                  ? () => unawaited(_confirmDelete(entry))
                  : null,
              style: TextButton.styleFrom(foregroundColor: IrmiaTheme.danger),
              child: Text(s.pickerDelete),
            ),
          ),
        ],
      ),
    );
  }

  /// 上一趟「启动并进入」正在等它就绪：**说清等了多久、它到哪一步**，并给一颗「停止等待」。
  ///
  /// 为什么单独一行而不是让按钮上的"正在启动…"扛着：那三个字既不说是哪一台、也不说
  /// 等了多少秒，而这一段最长 180 秒（冷启动实测 35–42 秒）——人既没法判断"是不是卡住了"，
  /// 也没法叫停（2026-10-28）。
  Widget _waiting(BuildContext context, AppStrings s) {
    if (!state.pickerWaiting) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    // 阶段由服务端说（`/api/health` 的 phase），这一层只负责翻成人话；
    // 问不到就**不编**，那一行退回"已经等了 N 秒，它还在启动"。
    final phase = state.pickerWaitPhase.trim().isEmpty
        ? ''
        : s.backendPhaseLabel(state.pickerWaitPhase.trim());
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              s.pickerWaitingReady(state.pickerWaitSeconds, phase),
              key: const ValueKey('picker-waiting'),
              style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant, height: 1.5),
            ),
          ),
          TextButton(
            key: const ValueKey('picker-stop-waiting'),
            // 只停止等待：实例照跑，那一行随时可以再点一次
            onPressed: () => state.cancelPickerWait(),
            child: Text(s.pickerStopWaiting, style: const TextStyle(fontSize: 11.5)),
          ),
        ],
      ),
    );
  }

  /// 上一次「进入」被服务端判了 401：一行**中性提示**（不是错误卡，见 [AppState.pickerSessionExpired]）。
  ///
  /// 它同时说明"那一行的按钮为什么变成了「登录」"——不然人会以为按钮自己变了。
  Widget _sessionExpiredNote(BuildContext context, AppStrings s) {
    if (state.pickerSessionExpired.isEmpty) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.info_outline_rounded, size: 15, color: scheme.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              s.pickerSessionExpired,
              key: const ValueKey('picker-session-expired'),
              style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }

  Widget _badge(String text, ColorScheme scheme) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(text, style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant)),
      );

  // ──────────────────────────────── 错误行 ────────────────────────────────

  Widget _problem(BuildContext context, AppStrings s) {
    final text = pickerProblemText(s, state);
    if (text.isEmpty) return const SizedBox.shrink();
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              key: const ValueKey('picker-problem'),
              style: TextStyle(fontSize: 12.5, color: scheme.onSurface, height: 1.5),
            ),
          ),
        ],
      ),
    );
  }

  // ──────────────────────────────── 新建表单 ────────────────────────────────

  Widget _newInstanceForm(BuildContext context, AppStrings s) {
    final scheme = Theme.of(context).colorScheme;
    final busy = state.pickerBusyId == '';
    final conflict = state.createDirConflict;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(s.pickerNew, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('new-instance-name'),
            controller: _name,
            enabled: !busy,
            decoration: InputDecoration(hintText: s.pickerNewNameLabel),
            onChanged: (value) {
              if (!_dirTouched) _dir.text = state.defaultInstanceDir(value);
              setState(() {});
            },
          ),
          const SizedBox(height: 8),
          TextField(
            key: const ValueKey('new-instance-dir'),
            controller: _dir,
            enabled: !busy,
            decoration: InputDecoration(hintText: s.pickerNewDirLabel),
            onChanged: (_) {
              _dirTouched = true;
              setState(() {});
            },
          ),
          if (state.pickerPort != null && busy) ...[
            const SizedBox(height: 6),
            Text(
              s.pickerNewPort('${state.pickerPort}'),
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
            ),
          ],
          const SizedBox(height: 10),
          Row(
            children: [
              FilledButton(
                key: const ValueKey('new-instance-create'),
                onPressed: busy
                    ? null
                    : () => unawaited(state.createInstance(name: _name.text, dir: _dir.text)),
                child: Text(s.pickerNewCreate),
              ),
              if (conflict.isNotEmpty) ...[
                const SizedBox(width: 8),
                // 目录已存在且非空：第二条出路是**明确地**用它（绝不自动覆盖）
                OutlinedButton(
                  key: const ValueKey('new-instance-use-dir'),
                  onPressed: busy
                      ? null
                      : () => unawaited(state.createInstance(
                            name: _name.text,
                            dir: conflict,
                            useExistingDir: true,
                          )),
                  child: Text(s.pickerNewUseDir),
                ),
              ],
              const Spacer(),
              TextButton(
                key: const ValueKey('new-instance-cancel'),
                onPressed: busy
                    ? null
                    : () => setState(() {
                          _formOpen = false;
                        }),
                child: Text(s.cancel),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ──────────────────────────────── 改名 ────────────────────────────────

  /// 改名对话框：**只改登记表里显示的名字**（不动数据目录、不动人格文件）。
  ///
  /// 改成什么就写 `nameSource: "manual"`（`InstanceBook.renameById`）：后端启动时的
  /// "旧条目一次性升级"只认 `dir` 那一档，人工改过的名字从此不会被任何启动路径覆盖。
  /// 名字空着就当场拒（不写盘）：名字是选择页上唯一的标签，空串等于让它退回目录末段。
  Future<void> _confirmRename(InstanceEntry entry) async {
    final s = IrmiaStrings.of(context);
    // 不用 TextEditingController：对话框关掉时路由还要放一帧退出动画，那一帧仍会重建 TextField
    // ——controller 在那之前 dispose 会撞上 `used after being disposed`。`initialValue` + 一个
    // 闭包变量就够（这里要的只是"最后那一行字"，不需要监听）。
    var draft = entry.name;
    final next = await showDialog<String>(
      context: context,
      builder: (dialogContext) {
        final scheme = Theme.of(dialogContext).colorScheme;
        return AlertDialog(
          title: Text(s.pickerRenameTitle),
          content: SizedBox(
            width: 420,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  s.pickerRenameBody,
                  style: TextStyle(fontSize: 13, color: scheme.onSurface, height: 1.6),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  key: const ValueKey('instance-rename-field'),
                  initialValue: entry.name,
                  autofocus: true,
                  decoration: InputDecoration(hintText: s.pickerNewNameLabel),
                  onChanged: (value) => draft = value,
                  // 回车 = 保存（输入框里那一下最自然）；空名字由状态层拒（同一个 `nameRequired`）
                  onFieldSubmitted: (value) => Navigator.of(dialogContext).pop(value),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              key: const ValueKey('instance-rename-cancel'),
              onPressed: () => Navigator.of(dialogContext).pop(null),
              child: Text(s.cancel),
            ),
            FilledButton(
              key: const ValueKey('instance-rename-save'),
              onPressed: () => Navigator.of(dialogContext).pop(draft),
              child: Text(s.pickerRenameSave),
            ),
          ],
        );
      },
    );
    if (next == null || !mounted) return;
    await state.renameInstance(entry, next);
  }

  // ──────────────────────────────── 忘记凭据 ────────────────────────────────

  /// 「忘记凭据」的二次确认：**只清本机这一份 token**——不停实例、不删登记表条目。
  ///
  /// 为什么值得一个确认框：清掉之后下一次进来就要密码（这是不可撤销的——没人能替他把票
  /// 变回来）。但它不该被写成危险的红按钮：它什么都不停，只是"这台机器不再记得我"。
  Future<void> _confirmForget(InstanceEntry entry) async {
    final s = IrmiaStrings.of(context);
    final go = await confirm(
      context,
      // 标题与那颗按钮同一句（"忘记凭据"）：这个动作的名字就是它，不再另起一句
      title: s.pickerForget,
      body: s.pickerForgetBody(entry.name),
      confirmLabel: s.pickerForget,
      danger: true,
    );
    if (!go || !mounted) return;
    await state.forgetCredential(entry);
  }

  // ──────────────────────────────── 删除 ────────────────────────────────

  /// 删除确认：**默认不删目录**（那里面是她的记忆与人格），要删得人明确点第二个按钮。
  Future<void> _confirmDelete(InstanceEntry entry) async {
    final s = IrmiaStrings.of(context);
    final keepDir = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final scheme = Theme.of(dialogContext).colorScheme;
        return AlertDialog(
          title: Text(s.pickerDeleteTitle),
          content: SizedBox(
            width: 420,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  s.pickerDeleteBody(entry.name),
                  style: TextStyle(fontSize: 13, color: scheme.onSurface, height: 1.6),
                ),
                const SizedBox(height: 8),
                Text(s.pickerDeleteNote, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant, height: 1.6)),
              ],
            ),
          ),
          actions: [
            TextButton(
              key: const ValueKey('instance-delete-cancel'),
              onPressed: () => Navigator.of(dialogContext).pop(null),
              child: Text(s.cancel),
            ),
            TextButton(
              key: const ValueKey('instance-delete-withdir'),
              onPressed: () => Navigator.of(dialogContext).pop(false),
              style: TextButton.styleFrom(foregroundColor: IrmiaTheme.danger),
              child: Text(s.pickerDeleteWithDir),
            ),
            FilledButton(
              key: const ValueKey('instance-delete-keepdir'),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(s.pickerDeleteKeepDir),
            ),
          ],
        );
      },
    );
    if (keepDir == null || !mounted) return;
    await state.deleteInstance(entry, deleteDir: !keepDir);
  }
}

/// 状态层记的**种类** → 这个语言的那一句（null/空 = 不显示）。
///
/// 为什么映射在这里而不是在 `AppState` 里拼：状态层没有 `BuildContext`，也拿不到
/// `AppStrings`；而语序因语言而异（"不能删：运行中" 与 "Cannot delete: running" 的
/// 冒号位置与词序都不一样），拼接只能发生在文案层。
String pickerProblemText(AppStrings s, AppState state) {
  switch (state.pickerProblem) {
    case InstanceGateProblem.none:
      return '';
    case InstanceGateProblem.noPort:
    case InstanceGateProblem.noLauncher:
      return s.pickerProblemNoLauncher;
    case InstanceGateProblem.portTaken:
      return s.pickerProblemPortTaken(state.pickerProblemDetail);
    case InstanceGateProblem.launchFailed:
      return s.pickerProblemLaunchFailed;
    case InstanceGateProblem.notReady:
      // 说"等了多久、它到哪一步"，而不是只说"超时"（2026-10-28）
      return s.pickerProblemNotReady(
        state.pickerWaitSeconds,
        state.pickerWaitPhase.trim().isEmpty
            ? ''
            : s.backendPhaseLabel(state.pickerWaitPhase.trim()),
        state.pickerProblemDetail,
      );
    case InstanceGateProblem.portUnavailable:
      return s.pickerProblemPortUnavailable;
    case InstanceGateProblem.nameRequired:
      return s.pickerProblemNameRequired;
    case InstanceGateProblem.dirNotEmpty:
      return s.pickerProblemDirNotEmpty(state.pickerProblemDetail);
    case InstanceGateProblem.cannotDeleteRunning:
      return s.pickerProblemCannotDeleteRunning(_nameOf(state));
    case InstanceGateProblem.cannotDeleteDefault:
      return s.pickerProblemCannotDeleteDefault(_nameOf(state));
    case InstanceGateProblem.removeFailed:
      return s.pickerProblemRemoveFailed;
    case InstanceGateProblem.renameFailed:
      return s.pickerProblemRenameFailed;
  }
}

/// 上一次动作针对的那台实例的名字（错误句子里要用；找不到就用 ID 里的那半截）
String _nameOf(AppState state) {
  final id = state.pickerBusyId;
  for (final entry in state.instancesList) {
    if (id != null && entry.id == id) return entry.name;
  }
  return id ?? '';
}
