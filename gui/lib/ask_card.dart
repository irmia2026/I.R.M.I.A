// TODO(i18n): 本文件还有 2 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/ask_card.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'package:flutter/material.dart';

import 'app.dart';
import 'ui_kit.dart';

/// 顶层卡的宿主：把「她在问」的那张卡挂在整个壳之上（design §6 的顶层对话层）。
///
/// 三条口径：
///   ① **顶层**：人切到哪一页都该看得见它——他可能正在设置页翻配置，而她正等一个只有他知道的
///      答案。所以宿主包住 [HomeShell]，不挂在聊天页里。
///   ② **一次只一张**（§6.3）：从服务端给的队列里挑**第一张还没被收起的**弹出来，同一时刻只有
///      一个对话框。答掉之后服务端队列里就少一条，下一拍照样从队首开始；按下「稍后」则立刻轮到
///      后面那张（不让任何一条提问被一次点击悄悄吞掉）。
///   ③ **卡上的字一个都不来自她**：标题与按钮由 [showHumanAskCard] 写死（防伪硬约束）。
///      这里只搬运她问的那两句与框架算出来的两个事实（排队数、超时没超时）。
///
/// 「稍后」只记在**本次运行**里：那张卡当下不再弹（队列里还有别的就先弹别的），但它仍在服务端
/// 队列里（没做任何决定，超时事实照落），左栏角标与 `irmia status` 都还看得见，下次开界面还会提醒
/// ——静默丢掉的卡等于把她的问题吞了。
class AskCardHost extends StatefulWidget {
  const AskCardHost({super.key, required this.state, required this.child});

  final AppState state;
  final Widget child;

  @override
  State<AskCardHost> createState() => _AskCardHostState();
}

class _AskCardHostState extends State<AskCardHost> {
  /// 正在弹（防止一次轮询里叠出第二张）
  bool showing = false;

  /// 本次运行里被"稍后"收起来的卡（按 `human/asked` 的 seq）
  final dismissed = <int>{};

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_maybeShow);
    // 首帧之后再看一次：进界面时就有一张挂着的卡是常态（她昨天问的，人今天才打开界面）
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShow());
  }

  @override
  void dispose() {
    widget.state.removeListener(_maybeShow);
    super.dispose();
  }

  /// 队首那张还没被收起的卡；都收起来了（或本来就没有）时为 null
  AskCardData? _nextCard() {
    for (final card in widget.state.askCards) {
      if (!dismissed.contains(card.seq)) return card;
    }
    return null;
  }

  void _maybeShow() {
    if (!mounted || showing) return;
    final card = _nextCard();
    if (card == null) return;

    showing = true;
    // 轮询回调（notifyListeners）里不能直接动导航栈：排到本帧之后再弹
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) {
        showing = false;
        return;
      }
      final answer = await showHumanAskCard(
        context,
        // 卡面标题里的名字：读的是人格资产（不是她这条载荷里的任何字段——design §6 的防伪面）
        herName: widget.state.herName,
        question: card.question,
        contextNote: card.context,
        queued: widget.state.askTotal > 1 ? widget.state.askTotal - 1 : 0,
        expired: card.expiredAt != null,
      );
      if (!mounted) {
        showing = false;
        return;
      }
      if (answer == null) {
        // 稍后：只收起这一张，不动任何日志（不是拒绝，也不是跳过——§6.1 不许框架替人做决定）
        setState(() {
          dismissed.add(card.seq);
          showing = false;
        });
        IrmiaToast.show(context, kAskCardLaterNote);
        // 立刻轮到后面那张（还在本次会话里没被收起的那些）：不让一次点击把队列吞掉
        _maybeShow();
        return;
      }
      final problem = await widget.state.answerAsk(card.seq, answer);
      showing = false;
      if (!mounted) return;
      if (problem == null) {
        IrmiaToast.show(context, '答复已记录，她在下一轮看到', kind: ToastKind.success);
      } else {
        // 答不进去就把原因说清（卡还在，再点一次就行）——不静默吞掉
        IrmiaToast.show(context, '答复没记上：$problem', kind: ToastKind.error);
      }
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
