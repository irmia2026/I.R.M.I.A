// TODO(i18n): 本文件还有 10 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/webhook_secret.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
/// 「这串凭据只显示这一次」那张对话框（B9：设置页「外部回调」卡上的动作回执）。
///
/// ## 为什么它必须是一个"读完就没了"的框
///
/// `POST /api/commands/regenerate-webhook-token` 的响应是**唯一**能见到明文的地方：盘上
/// （`data/.webhook-secret.json`）只留它的 sha256，日志与事件里一个字节都没有——与
/// `/api/auth/*` 签发会话同一条纪律（见 `src/web/webhook-secret.ts` 的文件头）。
///
/// 所以界面这边有三条不许破的规矩：
///   · **不落本地存储**：明文只活在这个对话框的入参里（调用方那次 await 的局部变量），
///     不写 ui-state.json、不写任何 prefs、不进日志；
///   · **不做"再看一眼"**：没有"显示已生成的凭据"这条路，也没有第二次打开——框关掉就是没了。
///     真丢了就再轮换一次（旧的那份当场失效，代价写在按钮的确认框里）；
///   · **抄走要给一只手**：一个「复制」按钮（`Clipboard`，Flutter 自带，不引第三方包）。
///     没有它的话，"抄走"这三个字就是让人拿眼睛对着屏幕手敲 43 个字符。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';
import '../ui_kit.dart';

/// 打开"只显示这一次"的凭据框；关掉即不再持有明文。
///
/// [action] 是服务端给的那一个（`generate` / `rotate`）：轮换之后要**当面**说清
/// "上一份此刻已经失效"，因为一定有外部脚本还没换，而那正是这次收窄的已知代价。
Future<void> showWebhookTokenDialog(
  BuildContext context, {
  required String token,
  required String note,
  required String action,
  String? previousSecretId,
}) {
  return showDialog<void>(
    context: context,
    // 点外部/按 Esc 也能关（关掉就是"抄走了"）——但**不许**因为误点而丢：框里那行
    // "关掉就再也看不到它了"就写在凭据上面
    builder: (dialogContext) => _WebhookTokenDialog(
      token: token,
      note: note,
      action: action,
      previousSecretId: previousSecretId,
    ),
  );
}

class _WebhookTokenDialog extends StatelessWidget {
  const _WebhookTokenDialog({
    required this.token,
    required this.note,
    required this.action,
    this.previousSecretId,
  });

  final String token;
  final String note;
  final String action;
  final String? previousSecretId;

  bool get _rotated => action == 'rotate';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final previous = previousSecretId;
    return AlertDialog(
      constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
      title: Text(
        _rotated ? '新的 webhook 凭据（上一份已失效）' : 'webhook 凭据',
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
      ),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    '这串凭据只显示这一次：关掉这个框就再也看不到它了——现在抄走。',
                    style: TextStyle(fontSize: 12.5, height: 1.6, color: scheme.onSurface),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            // 明文只在这里出现：可选中（手抄/局部复制都行）+ 一个复制按钮
            Container(
              padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
              decoration: BoxDecoration(
                color: scheme.surfaceContainer,
                borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
                border: Border.all(color: scheme.outlineVariant),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: SelectableText(
                      token,
                      key: const ValueKey('webhook-token-plain'),
                      style: TextStyle(
                        fontFamily: 'monospace',
                        fontSize: 12.5,
                        height: 1.5,
                        color: scheme.onSurface,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  TextButton(
                    key: const ValueKey('webhook-token-copy'),
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: token));
                      if (!context.mounted) return;
                      IrmiaToast.show(context, '已复制', kind: ToastKind.success);
                    },
                    child: const Text('复制'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (_rotated)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(
                  previous == null || previous.isEmpty
                      ? '上一份凭据此刻已经失效：还在用它的外部脚本会开始收 401，记得一并换掉。'
                      : '上一份凭据（$previous）此刻已经失效：还在用它的外部脚本会开始收 401，'
                          '记得一并换掉。',
                  style: TextStyle(fontSize: 12.5, height: 1.7, color: IrmiaTheme.danger),
                ),
              ),
            // 服务端那句 note 照原样摆着（它已经把"只显示这一次"与"旧的全废"说全了）
            Text(
              note,
              style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 10),
            Text(
              '配到调用方的 Authorization: Bearer 头上。这串东西读不到 /api/* 上的任何数据——'
              '它只够往 /webhook/* 投递。',
              style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
      actions: [
        FilledButton(
          key: const ValueKey('webhook-token-done'),
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('我抄走了'),
        ),
      ],
    );
  }
}
