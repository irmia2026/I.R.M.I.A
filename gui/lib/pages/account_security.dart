// TODO(i18n): 本文件还有 15 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/account_security.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
/// 改密码那张表单（设置页「账号与安全」卡上的那个按钮打开它）。
///
/// ## 为什么是对话框，不是卡上一排输入框
///
/// 项目既有的分寸写在 `ui_kit.dart` 的 `confirm` 上：**要填字段的表单用页面自己的
/// `showDialog`**，`confirm` 只管"点一次头"。设置页那几张卡的写控件都是"点一下就写"
/// （开关、单行编辑），而改密码是三个框一起填、还要两次比对——硬塞进卡片里会让
/// 那张卡的手感跟整页不一样，也会把"当前密码不对"这种要留在人眼前的话挤成一行。
///
/// ## 登出为什么**不在**这个对话框里
///
/// 登出不需要填任何东西，只要一次点头：它是设置页那张卡上的一颗按钮 + 项目既有的
/// `confirm`（灰取消 / 红确认，见 `settings_page.dart` 的 `_logoutAccount`）。
/// 两件事各用自己合适的形状，也比"一个对话框里塞两件事"更好读。
///
/// ## 校验的分寸
///
/// 三条**本地**规矩先过一遍（当前密码空 / 新密码太短 / 两次不一致）：不合格就
/// **一个请求都不发**，并且把话说在框下面（不弹 SnackBar——提示几秒就没了，
/// 而"当前密码不对"正是人要停下来改一处的时刻）。这三条与门上"设置密码"那一屏同口径
/// （见 auth_gate.dart 的 `_SetupForm` 与 app.dart 的 `setupPassword`）。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../app.dart';
import '../theme.dart';
import '../ui_kit.dart';

/// 打开「改密码」；返回 true = 真的改掉了（新凭据已经就位）。
///
/// 调用方（设置页那张卡）据此补一句 toast：对话框那一刻已经收起来了，
/// 提示挂在页面上比挂在一条正在退场的路由上稳当。
Future<bool> showChangePasswordDialog(BuildContext context, AppState state) async {
  final changed = await showDialog<bool>(
    context: context,
    builder: (_) => _ChangePasswordDialog(state: state),
  );
  return changed ?? false;
}

class _ChangePasswordDialog extends StatefulWidget {
  const _ChangePasswordDialog({required this.state});

  final AppState state;

  @override
  State<_ChangePasswordDialog> createState() => _ChangePasswordDialogState();
}

class _ChangePasswordDialogState extends State<_ChangePasswordDialog> {
  final current = TextEditingController();
  final next = TextEditingController();
  final again = TextEditingController();

  /// 就地那句话（本地校验没过 / 服务端回的失败）
  String problem = '';

  /// 请求在飞（按钮显示"正在改…"并禁用，防连点）
  bool busy = false;

  @override
  void dispose() {
    current.dispose();
    next.dispose();
    again.dispose();
    super.dispose();
  }

  void fail(String text) {
    setState(() {
      problem = text;
      busy = false;
    });
  }

  /// 改密码：三条本地规矩 → confirm（危险操作）→ 发请求 → 就地换上新凭据。
  Future<void> _submit() async {
    final old = current.text;
    final fresh = next.text;
    final repeat = again.text;

    if (old.isEmpty) {
      fail('请输入当前密码。');
      return;
    }
    if (fresh.length < kPasswordMinLength) {
      fail('新密码至少 $kPasswordMinLength 位（现在 ${fresh.length} 位）。');
      return;
    }
    // 两次一致与否**只能在这里判**：那是"同时看到两个框"才成立的事（服务端只收到一个值），
    // 所以它在本地拦下，一个请求都不发，并且当场把话说清楚。
    if (fresh != repeat) {
      fail('两次输入的密码不一样，请重新输入。');
      return;
    }

    // 危险操作走项目既有的 confirm（灰取消 / 红确认）：改密码会让**全部**旧会话失效，
    // 别处已经登录的界面/设备都会退出——这件事三个输入框里一个字都没有
    final go = await confirm(
      context,
      title: '改密码',
      body: '改掉之后，其它已经登录的界面/设备都会退出（都需要重新登录）；'
          '这一份会当场换成新凭据，不用重新登录。',
      confirmLabel: '改密码',
      danger: true,
    );
    if (!go || !mounted) return;

    setState(() {
      busy = true;
      problem = '';
    });
    final failure = await widget.state.changePassword(old, fresh);
    if (!mounted) return;
    if (failure == null) {
      Navigator.of(context).pop(true);
      return;
    }
    fail(failure);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return AlertDialog(
      constraints: const BoxConstraints(minWidth: 320, maxWidth: kDialogMaxWidth),
      title: const Text('改密码', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '旧密码验证通过才改得动。改掉之后，其它已经登录的地方会退出（都需要重新登录）；'
              '这一份当场换成新凭据，不用重新登录。',
              style: TextStyle(fontSize: 12.5, height: 1.7, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 14),
            _PasswordField(
              fieldKey: const ValueKey('account-old'),
              controller: current,
              hint: '当前密码',
              enabled: !busy,
              autofocus: true,
            ),
            const SizedBox(height: 10),
            _PasswordField(
              fieldKey: const ValueKey('account-new'),
              controller: next,
              hint: '新密码（至少 $kPasswordMinLength 位）',
              enabled: !busy,
            ),
            const SizedBox(height: 10),
            _PasswordField(
              fieldKey: const ValueKey('account-again'),
              controller: again,
              hint: '再输一遍新密码',
              enabled: !busy,
              onSubmitted: _submit,
            ),
            if (problem.isNotEmpty) ...[
              const SizedBox(height: 12),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      problem,
                      style: TextStyle(fontSize: 12.5, height: 1.5, color: scheme.onSurface),
                    ),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: busy ? null : () => Navigator.of(context).pop(false),
          style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
          child: const Text('取消'),
        ),
        FilledButton(
          key: const ValueKey('account-change-submit'),
          onPressed: busy ? null : () => unawaited(_submit()),
          child: Text(busy ? '正在改…' : '改密码'),
        ),
      ],
    );
  }
}

/// 遮蔽的密码框：与门上那两态共用同一套规矩（遮蔽、不要自动更正、回车即提交）
class _PasswordField extends StatelessWidget {
  const _PasswordField({
    required this.fieldKey,
    required this.controller,
    required this.hint,
    required this.enabled,
    this.autofocus = false,
    this.onSubmitted,
  });

  final Key fieldKey;
  final TextEditingController controller;
  final String hint;
  final bool enabled;
  final bool autofocus;
  final VoidCallback? onSubmitted;

  @override
  Widget build(BuildContext context) {
    return TextField(
      key: fieldKey,
      controller: controller,
      enabled: enabled,
      autofocus: autofocus,
      obscureText: true,
      // 遮蔽是密码框唯一不能省的东西（与 auth_gate.dart 同一条理由）
      enableSuggestions: false,
      autocorrect: false,
      decoration: InputDecoration(hintText: hint),
      onSubmitted: onSubmitted == null ? null : (_) => onSubmitted!.call(),
    );
  }
}

