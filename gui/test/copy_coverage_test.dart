/// **文案覆盖闸门**：把"界面文案全部落在文件里"变成一条可验收的不变量。
///
/// 用户的原话是「到时候我肯定要**大面积审计文案**，**基本上所有文案都要落在文件里**」。
/// 那句话落到工程上只有一条可判的形态：
///
///   > `gui/lib/**` 里的**字符串字面量**，除 [kExemptFiles] / [kExemptLiterals] 两处
///   > 明确列出的豁免之外，**不许出现中文**；还没迁完的文件在 [kPendingCopy] 里挂账，
///   > 每个文件的数字**只许降不许升**。
///
/// 为什么是"字面量"而不是"含中文的行"：注释里到处都是中文（那是解释，不是界面），
/// 而一行代码里可以有两个字面量、一个字面量也可以跨两行——按行数会同时多算与少算。
/// 判据用 `test/support/dart_source.dart` 那台按 Dart 词法走的扫描器（跳过 `//` / `///` /
/// `/* */`，认得原始字符串与 `${...}` 插值）。
///
/// ## 三条红线，各自对应一次"人会犯的错"
///
///   1. **白名单之外出现中文** ⇒ 红。防的是"顺手在页面里写一句中文"（那正是这个仓库
///      过去 1760 条字面量的来历）；新文案必须先进 `AppStrings`，页面里只许 `s.xxx`。
///   2. **白名单里的数字与文件实际不一致** ⇒ 红。涨了是硬编码回潮；**降了也要改数**——
///      那是棘轮的另一半：迁移完必须把这里改小，否则"还剩多少"这份进度表就会撒谎。
///   3. **豁免名单里躺着找不到的字面量/文件** ⇒ 红。豁免是"永远不迁"，不是"先放着"：
///      一段豁免文案若已经不在代码里，就该把它从名单里删掉。
///
/// ## 怎么读这份白名单
///
/// 它就是**验收清单**：每批迁完一个文件，把那一行从 [kPendingCopy] 里删掉（数字归零），
/// 总数就从"还剩多少"往下走。分布表在下面的 `分布（进度读数）` 用例里打印。
library;

import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'support/dart_source.dart';

/// **还没迁完**的文件 → 允许的含中文字面量数（棘轮：只许改小）。
///
/// 键是相对 `gui/` 的路径（与 `flutter test` 的工作目录一致）。迁完一个文件就删掉那一行。
///
/// 数字是 **2026-10-18 实测**（`flutter test test/copy_coverage_test.dart` 的分布用例打印的）。
/// 排序按剩余量从多到少——最上面就是下一批该先吃的。**要迁移一个文件之前先看这一行。**
///
/// 这一批（2026-10-18，第三批）把最重的三页——`extensions_page`(240)、`schedule_page`(195)、
/// `channels_page`(164)——全迁完了，读数从 28 文件 / 1110 处降到 **25 文件 / 511 处**。
/// 2026-10-20：引导页第 2 步的密钥提示/回执挪进 AppStrings（五句，中英各一份）⇒ **25 文件 / 510 处**。
const Map<String, int> kPendingCopy = <String, int>{
  'lib/pages/extensions_kit.dart': 75,
  'lib/pages/persona_page.dart': 67,
  'lib/pages/logs_ops.dart': 42,
  'lib/pages/logs_panels.dart': 39,
  // 2026-10-23：第 3 步 OneBot 那句长文案挪进 AppStrings.onboardingOnebotDetail
  // （用户原话「配置完成后可自行另行设置」）⇒ 35 → 34，棘轮跟着走。
  // 2026-10-26：第 2 步的「模型名 / Base URL / API Key」三个标签、Base URL 说明与两句
  // 非空校验挪进 AppStrings（第 2 步这一屏不再有中文字面量）⇒ 34 → 31。
  'lib/onboarding.dart': 31,
  // 2026-10：登出那条路重写成「登出 = 结束实例」（三步 + 选择页），原来那句
  // `stateText = '已登出'` 没了（选择页那一屏的话全在 instance_picker.dart 的文案表里）
  // ⇒ 35 → 34，棘轮跟着走。
  // 2026-10-28：登录页那句 `连不上本地服务：$err` 退役（门上改成三档各说各的，
  // 话全在 AppStrings 里拼）⇒ 34 → 33，棘轮跟着走。
  'lib/app.dart': 33,
  'lib/pages/memory_page.dart': 28,
  'lib/pages/logs_widgets.dart': 24,
  'lib/ui_kit.dart': 25,
  'lib/auth_gate.dart': 21,
  'lib/pages/logs_rows.dart': 25,
  'lib/pages/account_security.dart': 16,
  'lib/pages/webhook_secret.dart': 11,
  'lib/theme.dart': 9,
  'lib/backend_stop.dart': 10,
  'lib/pages/chat_page.dart': 7,
  'lib/pages/logs_page.dart': 7,
  'lib/password_prompt.dart': 7,
  'lib/pages/logs_format.dart': 6,
  'lib/pages/page_chrome.dart': 5,
  'lib/format.dart': 4,
  'lib/mention_prompt.dart': 5,
  'lib/home.dart': 3,
  'lib/ask_card.dart': 2,
  'lib/markdown.dart': 2,
};

/// **永久豁免的路径**（文件或目录，目录以 `/` 结尾）：里面本来就不该是"翻译得出来的界面文案"。
///
/// 与 [kPendingCopy] 的区别：这里的路径**永远不迁**，也不会从名单里消失。
const Map<String, String> kExemptPaths = <String, String>{
  'lib/i18n/':
      '文案表自己（`app_strings.dart` 的中文是**数据**、`strings_scope.dart` 是运行时、'
          '`strings_override.dart` 是用户自己的覆盖层）：把它也算了，这个闸门就永远红。',
  'lib/her_name.dart':
      '她的名字是**数据**：`IDENTITY.md` 里「名字：」那一行、以及"从一句话里认出名字"用的'
          '那些中文标记词（`我叫…` / 量词 / 括号）——换语言也不该换她的名字与认名规则。',
};

/// **永久豁免的具体字面量**（按源码原文匹配，见 [DartLiteral.raw]）。
///
/// 只收"不是界面文案"的：开发者日志、断言消息、以及**内容形态**的样本。
/// 一条都不该是"还没迁"——还没迁的在 [kPendingCopy] 里。
const Map<String, String> kExemptLiterals = <String, String>{
  '…':
      '省略号：截断与"还没完"的标点，两种语言都是它——它不是句式，没有可译的东西。'
          '（截断处的写法是把 `…` 抽成常量再拼，别把整个格式化串塞进文案表。）',
  '—':
      '缺值占位符（等宽列里的那一横）：语言无关，换英文也还是它。',
  'run 流拼起来必须逐字等于源串（纪律 ①）——这是渲染器的第一不变量':
      'assert 的失败消息：只有开发者看得到（发布构建里整段被编译掉），不是界面文案。',
  '表格块与非表格部分必须不重不漏地拼成整篇源串（纪律 ①）':
      '同上：渲染器的不变量断言。',
  r'写主动退出标记失败（这次会被后端当成崩溃）：$error':
      'debugPrint 的一行日志（gui_quit.dart）：只进日志，不上界面。',
  r'# 我是谁\n\n（名字、身份、核心性格。500 token 以内）':
      '人格正文的**形态样本**（引导页第 4 步输入框的 hintText）：它示范的是 IDENTITY.md 该长'
          '什么样，属于内容，不是界面的一层皮。',
  // ── 2026-10-25：卡死留痕那三类的文案（`[stall]` / `[input]`） ──
  //
  // 判据与上面那条 debugPrint 逐字相同：**只进 gui.log，不上界面**。它们是排障现场里
  // 给人读的那几个字（凌晨三点靠它认出"最后动的是哪个按钮"），不是界面文案——
  // 界面上的同类动作各自读 `AppStrings`（托盘项、`retry`、`trayRestart` 都是取文案表，
  // 所以这里只剩两个必须落成字面量的：发送键没有文字标签、切页那一句要带页名）。
  '发送消息':
      '`[input] tap=发送消息`（chat_page.dart 的发送键）：发送键是一颗图标钮、没有文字标签，'
          '文案表里也没有对应的一条——这一句只给日志用（见 gui_log.dart 的行格式一节）。',
  r'切页 $name':
      '`last="切页 <页名>"`（stall_watch.dart 的 tracePage）：`[stall]` 那行引用的最后一句话，'
          '页名来自 PageEntry.label（尚未迁完的那批）；同样只进日志。',
};

void main() {
  final libDir = Directory('lib');

  /// 扫一遍：相对路径 → 含中文字面量（已去掉豁免路径与豁免字面量）
  bool exemptPath(String rel) => kExemptPaths.keys.any(
      (path) => path.endsWith('/') ? rel.startsWith(path) : rel == path);

  final Map<String, List<DartLiteral>> found = <String, List<DartLiteral>>{};
  for (final file in dartFilesIn(libDir)) {
    final rel = relativeDartPath(Directory.current.path, file);
    if (exemptPath(rel)) continue;
    final literals = cjkLiteralsOf(file.readAsStringSync())
        .where((literal) => !kExemptLiterals.containsKey(literal.raw))
        .toList();
    if (literals.isNotEmpty) found[rel] = literals;
  }

  test('白名单之外不许有中文（注释不算）', () {
    final offenders = <String>[];
    for (final entry in found.entries) {
      if (kPendingCopy.containsKey(entry.key)) continue;
      for (final literal in entry.value) {
        offenders.add('${entry.key}:${literal.line}  ${literal.snippet}');
      }
    }
    expect(
      offenders,
      isEmpty,
      reason: '这些字面量会让界面在英文下露中文（或反过来）：\n${offenders.join('\n')}\n'
          '改法：把文案挪进 `lib/i18n/app_strings.dart`（AppStrings + ZhStrings + EnStrings 各一处），'
          '页面里改用 `final s = IrmiaStrings.of(context);` 之后的 `s.xxx`。\n'
          '确实不是界面文案（断言/日志/她的内容）⇒ 加进 kExemptLiterals 并写清理由。',
    );
  });

  test('白名单的数字就是文件里的实际数（棘轮：只许改小）', () {
    final problems = <String>[];
    for (final entry in kPendingCopy.entries) {
      final rel = entry.key;
      final actual = found[rel]?.length ?? 0;
      if (actual == entry.value) continue;
      if (actual > entry.value) {
        problems.add('$rel：白名单写 ${entry.value}，实际 $actual —— '
            '**涨了**。新写进去的中文必须挪进 AppStrings；'
            '确实非迁不可的历史存量，才允许把数字改大（并在提交说明里讲清为什么）。');
      } else {
        problems.add('$rel：白名单写 ${entry.value}，实际 $actual —— '
            '**降了**。这是好消息，但棘轮要跟着走：把这一行改成 $actual'
            '${actual == 0 ? '（归零就从白名单里删掉）' : ''}。');
      }
    }
    for (final rel in kPendingCopy.keys) {
      if (!File(rel).existsSync()) problems.add('$rel：白名单里的文件不存在了——删掉这一行。');
    }
    expect(problems, isEmpty, reason: '白名单与代码对不上：\n${problems.join('\n')}');
  });

  test('豁免名单里没有"早已不在代码里"的死条目', () {
    final problems = <String>[];
    for (final path in kExemptPaths.keys) {
      final exists = path.endsWith('/') ? Directory(path).existsSync() : File(path).existsSync();
      if (!exists) problems.add('$path：豁免的路径不存在了——删掉这一条。');
    }
    final allRaw = <String>{
      for (final file in dartFilesIn(libDir))
        for (final literal in stringLiteralsOf(file.readAsStringSync())) literal.raw,
    };
    for (final raw in kExemptLiterals.keys) {
      if (!allRaw.contains(raw)) problems.add('「$raw」：这条豁免在代码里已经找不到了——删掉它。');
    }
    expect(problems, isEmpty, reason: '豁免名单要跟着代码走：\n${problems.join('\n')}');
  });

  test('分布（进度读数）：哪些文件还剩多少', () {
    final rows = found.entries.toList()
      ..sort((a, b) {
        final byCount = b.value.length.compareTo(a.value.length);
        return byCount != 0 ? byCount : a.key.compareTo(b.key);
      });
    final lines = <String>[
      '文案覆盖分布（lib/**，词法口径：注释不算；永久豁免不进表）',
      '─' * 66,
      for (final row in rows)
        '${'${row.value.length}'.padLeft(4)}  ${row.key}'
            '${kPendingCopy.containsKey(row.key) ? '' : '   ⚠️ 未挂账'}',
      '─' * 66,
      '待迁：${rows.length} 个文件 / ${rows.fold<int>(0, (sum, row) => sum + row.value.length)} 处',
      '永久豁免：${kExemptPaths.length} 个路径 + ${kExemptLiterals.length} 条具体字面量',
    ];
    // 打印出来给人看（`flutter test --reporter expanded` 能看到）；断言只是"确实扫到了东西"。
    // ignore: avoid_print
    print(lines.join('\n'));
    expect(rows, isNotEmpty, reason: '一个含中文的字面量都没扫到——扫描器或工作目录出问题了');
  });
}
