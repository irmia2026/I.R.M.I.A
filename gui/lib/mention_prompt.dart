// TODO(i18n): 本文件还有 3 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/mention_prompt.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'package:flutter/material.dart';

import 'app.dart';
import 'ui_kit.dart';
import 'ui_state.dart';

/// 「她被怎么称呼」的首次提示（design：文本提及唤醒）。
///
/// 三件事，与 [AskCardHost] 同一姿势（顶层、一次一张、字由框架写死）：
///   ① **只在第一次**弹：词表非空、或人点过「以后再说」，就不再打扰
///      （`ui-state.json` 里一个 `mention-prompt-done` 开关，与"更多"折叠组同一份状态文件）；
///   ② **读的是她当前生效的那份配置**（`GET /api/config` 的 `channels.mentionKeywords`）——
///      已经在别处填过的人不该再被问一次；
///   ③ 不阻塞任何事：这是一个提示，弹不弹她都在正常跑。
///
/// 为什么不放在设置页里做：第一次用的人不会主动去设置页找这个字段，而这件事**不填就等于
/// 群里喊她名字她永远听不见**——它得自己找上门来一次。
class MentionPromptHost extends StatefulWidget {
  const MentionPromptHost({super.key, required this.state, required this.child});

  final AppState state;
  final Widget child;

  @override
  State<MentionPromptHost> createState() => _MentionPromptHostState();
}

/// 该不该问：**没问过、且名单还是空的**才问。
///
/// 抽成纯函数是为了能被直接测（widget 那层要读文件、问端点、弹卡，全是异步的；
/// 把判据埋在里面就只能靠一整串时序去测它，实测很脆）。
bool shouldAskMentionKeywords({required bool askedBefore, required List<String> current}) {
  return !askedBefore && current.isEmpty;
}

class _MentionPromptHostState extends State<MentionPromptHost> {
  /// 本次运行里已经问过（无论答没答）：一次会话里只弹一次
  bool asked = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeAsk());
  }

  Future<void> _maybeAsk() async {
    if (asked || !mounted) return;
    asked = true;
    // `loadFlag` 是三态（true / false / null = 记录坏了）。这一条提示把"未知"按"没问过"
    // 处理：坏掉的状态文件没有可用记录，问一次、写一次就会把它重建成干净的一份（自愈）；
    // 不问的话它就永远停在"未知"。引导判据那边相反（未知 ⇒ 不弹）：那张卡是挡在面前的，
    // 误弹的代价更大。
    final askedBefore = (await loadFlag('mention-prompt-done')) ?? false;
    if (!mounted) return;
    List<String> current = const [];
    try {
      final data = await widget.state.api.get('/api/config');
      final channels = data is Map ? data['channels'] : null;
      final raw = channels is Map ? channels['mentionKeywords'] : null;
      if (raw is List) {
        current = raw.whereType<String>().map((word) => word.trim()).where((w) => w.isNotEmpty).toList();
      }
    } catch (_) {
      // 配置读不到就不问：宁可不提示，也不要拿一份猜的现状去问人
      return;
    }
    // 已经有词表 = 这件事已经办过了，不再打扰
    if (!shouldAskMentionKeywords(askedBefore: askedBefore, current: current)) {
      // 只**补记**一次：盘上已经是 true 就不再碰那份文件。
      // 从前这里每次启动都无条件 `saveFlag` 一遍（内容一个字节没变也写一次盘），
      // 2026-10-21 改成"值会变才写"——启动不该产生写放大，也不该刷新 mtime。
      if (current.isNotEmpty && !askedBefore) await saveFlag('mention-prompt-done', true);
      return;
    }
    if (!mounted) return;
    final words = await showMentionKeywordsCard(
      context,
      initial: current,
      // 示例按她的名字写（写死一个别人的名字会让人以为那就是她）——读不到就给中性示例
      herName: widget.state.herName,
    );
    if (words == null) {
      // 以后再说：记下"问过了"，但**不写配置**（没做决定就是没做决定）
      await saveFlag('mention-prompt-done', true);
      if (mounted) IrmiaToast.show(context, '先记着这件事——消息适配器页里随时能填', kind: ToastKind.info);
      return;
    }
    final problem = await widget.state.saveMentionKeywords(words);
    await saveFlag('mention-prompt-done', true);
    if (!mounted) return;
    if (problem == null) {
      IrmiaToast.show(
        context,
        words.isEmpty ? '已设为"只认 @ 叫她"' : '记下了：${words.join('、')}',
        kind: ToastKind.success,
      );
    } else {
      IrmiaToast.show(context, '没写进去：$problem', kind: ToastKind.error);
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
