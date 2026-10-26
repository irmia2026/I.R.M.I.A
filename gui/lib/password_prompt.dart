// TODO(i18n): 本文件还有 7 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/password_prompt.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'package:flutter/material.dart';

import 'app.dart';

/// 「该设密码了」的首次提示 —— 只对**凭老凭据进门**的人弹一次。
///
/// ## 它补的是哪一个洞
///
/// 升级期有这么一种状态：后端还没设过密码，界面手上那份**老凭据**（`data/.ui-token`，
/// 界面那侧存在 `%APPDATA%\Irmia\gui-token`）照样能进 `/api/*`。这时候界面如果直接开始干活，
/// 那条老路就会一直能用，而用户原话「首次启动的时候要求用户设置密码就行了」就永远没人去执行——
/// 升级期一过，这件事就烂在那儿了。
///
/// 所以：进得来，但要**说一次**"现在设一个密码"。措辞与门上的 `_SetupForm` 同一口径
/// （它挡的是本机别的程序与本地网页，不是拿到你磁盘的人），两处说法不一致比不说更糟。
///
/// 姿势照 [MentionPromptHost]（同一族：顶层、一次一张、字由框架写死、状态落在
/// `ui-state.json` 的一个开关里），并且**不阻塞任何事**：按「以后再说」她照常跑。
class PasswordPromptHost extends StatefulWidget {
  const PasswordPromptHost({super.key, required this.state, required this.child});

  final AppState state;
  final Widget child;

  @override
  State<PasswordPromptHost> createState() => _PasswordPromptHostState();
}

class _PasswordPromptHostState extends State<PasswordPromptHost> {
  /// 本次运行里已经弹过（无论答没答）：一次会话里只弹一次
  bool asked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeAsk());
  }

  Future<void> _maybeAsk() async {
    if (asked || !mounted) return;
    asked = true;
    if (!widget.state.needsPasswordPrompt) return;
    if (!mounted) return;
    final wants = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (context) => AlertDialog(
        title: const Text('给这台实例设个密码'),
        content: const Text(
          '现在用的是升级前留下的旧凭据。设一个密码之后，打开界面就用它进来——'
          '那条旧凭据会当场失效。\n\n'
          '密码只保存在本机（data/.auth.json）。它挡的是本机上别的程序、以及本地网页'
          '顺手打你的端口，不是拿到你磁盘的人。',
          style: TextStyle(height: 1.6),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('以后再说'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('现在设置'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    if (wants == true) {
      widget.state.openPasswordSetup();
      return;
    }
    // 「以后再说」：记下来，这次会话与以后都不再打扰（但旧凭据照旧能用，她照常跑）
    widget.state.dismissPasswordPrompt();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

