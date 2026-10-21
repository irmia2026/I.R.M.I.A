// TODO(i18n): 本文件还有 18 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/auth_gate.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
/// 界面的一道门：**首次设密码** 与 **登录** 两态（取代原来的 TokenGate 粘贴框）。
///
/// ## 为什么换成这两态
///
/// 用户的口径是「不需要 token，首次启动的时候要求用户设置密码就行了」。原来那扇门要人
/// 去控制台复制一串 64 位 hex 再粘贴进来——那串东西既记不住、又会随实例重生而变，
/// 而它防的东西（本机上别的程序、本地网页顺手打你的端口）用一个密码就够了。
///
/// ## 这道门防的是什么，如实写在门上说
///
/// **不是**防住拿到磁盘的人：凭据文件就在 `data/.auth.json` 里，能读盘的人也能直接删掉它
/// 重启重设密码（那正是"忘记密码"的恢复路径）。它防的是本机上别的程序、以及任何一个
/// 能向回环地址发请求的本地网页。这段话必须摆在界面上，而不是只躺在源码注释里——
/// 让人以为自己有了一道它并不提供的保险，比没有保险更糟。
///
/// ## 状态怎么定的（都在 AppState 里，这里只画）
///
/// 界面启动时先不带凭据打一条读端点，服务端会在 401 里回一个 `code`：
///   · `auth-uninitialized` → 这台实例还没设过密码 → 画 [AuthGateKind.setup]；
///   · `unauthorized`       → 设过密码但手上这张票不作数 → 画 [AuthGateKind.login]。
/// 所以**不需要第二条公开的探测端点**，服务端那边的"待初始化只放行设置密码"一个字都不用让步。
library;

import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'app.dart';
import 'theme.dart';

/// 门上的三种画面。`ready`（进主界面）不在这里——那是 `AppState` 的事，
/// 门只负责"还没进去的时候画什么"。
enum AuthGateKind {
  /// 正在问服务端"这台实例是什么状态"（一两百毫秒的事，但必须有一屏，
  /// 否则会先闪一下登录框再跳到设置密码）
  checking,

  /// 首次设密码（这台实例还没有凭据文件）
  setup,

  /// 登录（设过密码了，手上这张票不作数）
  login,
}

/// 门：她的脸 + 一件事（设密码 / 登录）。沿用 TokenGate 那套视觉（380 宽卡片、
/// 圆角 16、hairline 阴影），只是卡片里换成了密码表单。
class AuthGate extends StatelessWidget {
  const AuthGate({super.key, required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(vertical: 24),
          child: switch (state.gate) {
            AuthGateKind.checking => _ConnectingCard(state: state),
            AuthGateKind.setup => _SetupForm(state: state),
            AuthGateKind.login => _LoginForm(state: state),
          },
        ),
      ),
    );
  }
}

/// 第三屏：正在连接（含"还在自动重连"的进度）/ 降级之后的连不上。
///
/// 为什么要独立一屏而不是"先画登录框再说"：连不上本地服务与"你没凭据"是**两件事**，
/// 混在一起会让人对着密码框反复重输——而真正的问题是主进程没在跑。
///
/// 2026-10-04 起这一屏多了一层含义：**"连不上"不是终态**。重启前后端时界面先起来、
/// 服务端还在载入事件日志，那一刻的连接被拒是**安排好的中间态**，所以这一屏画的是
/// "正在连接…（第 N 次尝试，已等 Xs）"这样一句进度话，而不是一张错误卡——
/// 自动重连一直在跑（见 `AppState._scheduleGateRetry`），人一次按键都不用按。
///
/// 两种话的分寸（用户 ① 的原话：正在等待/重启中用中性话，过了窗口才说"确认主进程在运行"）：
///   · 宽限窗口内：[state.gateError] 是空的 → 中性话，只说进度，不提"确认主进程"；
///   · 窗口用尽（[state.gateUnreachable]）：才把原因摆出来，让人去查主进程——
///     这时候仍然留着「重试」，因为人刚手动拉起主进程时需要一个"现在就再来一次"的动作，
///     而"什么都不按也会自己好"这件事不写出来会被那颗按钮盖过去，所以body里写明。
class _ConnectingCard extends StatelessWidget {
  const _ConnectingCard({required this.state});

  final AppState state;

  @override
  Widget build(BuildContext context) {
    final degraded = state.gateUnreachable || state.gateError.isNotEmpty;
    return _Shell(
      title: degraded ? '连不上本地服务' : '正在连接本地服务',
      body: degraded
          ? '界面还在后台自动重试（每 ${state.gateSlowRetrySeconds} 秒一次），服务端一起来就会自己进来。'
          : (state.gateRetrying
              ? '本地服务正在启动…（第 ${state.gateAttempt} 次尝试，已等 ${state.gateWaited}s）'
              : '在确认这台实例的状态…'),
      error: degraded && state.gateError.isNotEmpty ? state.gateError : null,
      child: degraded
          ? FilledButton(
              onPressed: () => unawaited(state.retryBootstrap()),
              child: const Text('立即重试'),
            )
          : const Center(child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))),
    );
  }
}

/// 卡片外壳：门上的两态共用同一副骨架（脸、标题、说明、正文、错误行）。
///
/// 抽出来不是为了省几行，是为了**保证两态长得一样**：一扇门的两半如果排版不同，
/// 人会觉得"这是两个地方"，而它们其实是同一件事的两步。
class _Shell extends StatelessWidget {
  const _Shell({
    required this.title,
    required this.body,
    required this.child,
    this.notice,
    this.error,
  });

  final String title;
  final String body;

  /// 卡片底部的说明（安全口径那一段）
  final String? notice;

  /// 上一次失败的人话原因；null **或空串** = 没有。
  ///
  /// 空串也要当成"没有"：否则会画出一个只有红色感叹号、一个字都没有的行——
  /// 那比不画更让人慌（"它是不是想说点什么但说不出来"）。
  final String? error;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final problem = error == null || error!.trim().isEmpty ? null : error!.trim();
    return Container(
      width: 380,
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Center(child: HerFace(size: 64, radius: 20)),
          const SizedBox(height: 14),
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 6),
          Text(
            body,
            style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant, height: 1.6),
          ),
          const SizedBox(height: 16),
          child,
          if (problem != null) ...[
            const SizedBox(height: 12),
            _ProblemLine(text: problem),
          ],
          if (notice != null) ...[
            const SizedBox(height: 14),
            Text(
              notice!,
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant, height: 1.6),
            ),
          ],
        ],
      ),
    );
  }
}

/// 失败行：**说人话、留在卡片里**。
///
/// 不用 SnackBar：那种提示几秒就没了，而"密码不对"正是人会停下来想一想再试一次的时刻——
/// 提示消失之后卡片上什么都没留下，人会怀疑自己是不是看错了。
class _ProblemLine extends StatelessWidget {
  const _ProblemLine({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.error_outline_rounded, size: 16, color: IrmiaTheme.danger),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: TextStyle(fontSize: 12.5, color: scheme.onSurface, height: 1.5),
          ),
        ),
      ],
    );
  }
}

/// 遮蔽的密码框：两态共用（遮蔽与"回车即提交"是同一件事的两面，不该各写一遍）
class _PasswordField extends StatelessWidget {
  const _PasswordField({
    required this.controller,
    required this.hint,
    required this.enabled,
    this.autofocus = false,
    this.onSubmitted,
  });

  final TextEditingController controller;
  final String hint;
  final bool enabled;
  final bool autofocus;
  final VoidCallback? onSubmitted;

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: controller,
      autofocus: autofocus,
      enabled: enabled,
      obscureText: true,
      // 遮蔽是这道门唯一不能省的东西：密码框不遮蔽，旁边路过的人一眼就看见了，
      // 而"本地门锁"防的从来不包括站在你身后的人。
      enableSuggestions: false,
      autocorrect: false,
      decoration: InputDecoration(hintText: hint),
      onSubmitted: onSubmitted == null ? null : (_) => onSubmitted!.call(),
    );
  }
}

/// 首次设密码
class _SetupForm extends StatefulWidget {
  const _SetupForm({required this.state});

  final AppState state;

  @override
  State<_SetupForm> createState() => _SetupFormState();
}

class _SetupFormState extends State<_SetupForm> {
  final password = TextEditingController();
  final confirm = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final busy = widget.state.gateBusy;
    return _Shell(
      title: '设置密码',
      body: '这台实例还没有密码。设一个，之后打开界面就用它进来。',
      error: widget.state.gateError,
      notice: '密码只保存在本机（data/.auth.json）。它挡的是「本机上别的程序」与「本地网页顺手'
          '打你的端口」，不是拿到你磁盘的人——忘记密码的处理办法就是删掉那个文件重启，再设一次。',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _PasswordField(
            controller: password,
            hint: '新密码（至少 $kPasswordMinLength 位）',
            enabled: !busy,
            autofocus: true,
          ),
          const SizedBox(height: 10),
          _PasswordField(
            controller: confirm,
            hint: '再输一遍',
            enabled: !busy,
            onSubmitted: _submit,
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: busy ? null : _submit,
            child: Text(busy ? '正在设置…' : '设置并进入'),
          ),
        ],
      ),
    );
  }

  void _submit() {
    // 两次输入不一致在**本地**就挡住：这不是安全边界，是少一次让人困惑的往返
    unawaited(widget.state.setupPassword(password.text, confirm.text));
  }

  @override
  void dispose() {
    // 这里是**整页**退场（不是弹窗）：树一帧就整体摘掉，所以同步销毁是对的。
    // 别误用 ui_kit 的 disposeLater（那是给弹窗用的，见那里的注释）：在它之后
    // 还会留一个 600ms 的定时器，而页面退场时没人再 pump，测试与真机都要白等它。
    password.dispose();
    confirm.dispose();
    super.dispose();
  }
}

/// 登录
class _LoginForm extends StatefulWidget {
  const _LoginForm({required this.state});

  final AppState state;

  @override
  State<_LoginForm> createState() => _LoginFormState();
}

class _LoginFormState extends State<_LoginForm> {
  final password = TextEditingController();

  @override
  Widget build(BuildContext context) {
    final busy = widget.state.gateBusy;
    return _Shell(
      title: '登录',
      body: '这台实例设过密码了。输一次，之后请求自动携带会话凭据。',
      error: widget.state.gateError,
      notice: '忘记密码：删掉 data/.auth.json 后重启主进程，再设一次。'
          '连续输错会退避（等几秒），但不会把谁永久锁在门外。',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _PasswordField(
            controller: password,
            hint: '密码',
            enabled: !busy,
            autofocus: true,
            onSubmitted: _submit,
          ),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: busy ? null : _submit,
            child: Text(busy ? '正在登录…' : '登录'),
          ),
        ],
      ),
    );
  }

  void _submit() {
    unawaited(widget.state.login(password.text));
  }

  @override
  void dispose() {
    // 同上：整页退场，同步销毁
    password.dispose();
    super.dispose();
  }
}
