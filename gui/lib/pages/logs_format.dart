// TODO(i18n): 本文件还有 5 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/logs_format.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
part of 'logs_page.dart';

/// 日志页的**数字与口径**取数（2026-10-05 加的薄层）。
///
/// 为什么单开这一层而不是就地写在卡片里：用户报的那个 bug 就是"同一时刻同一个数两种写法"，
/// 而它成立的前提正是**每个页面各自算一遍**。这个文件里的四个函数是日志页唯一算数的地方，
/// 且它们全部转手给 `../format.dart`（与 `src/format/units.ts` 逐字镜像的唯一实现）——
/// 于是"日志页怎么写这个数"与"运行情况页怎么写"在结构上不可能分岔。
///
/// 另一条：**口径词与数字一起给**。凡"计入预算/用量"的数，旁边都要能看出是**非缓存口径**
///（用户 2026-10-05：口径换了而说明没换，人读到的就是上一套语义）。所以下面几个句子
/// 一律带着 [kBudgetMetricLabel] 或"非缓存 token"，不接受"数字单独摆在那里"。

/// 紧凑写法（卡片大数字用）：与运行情况页磁贴同一个函数
String logsCompactTokens(num value) => formatCompact(value);

/// 千分位真数（hover 提示、对账行用）
String logsExactTokens(num value) => formatExact(value);

/// 卡片大数字的悬停提示：`2,705,946 非缓存 token`
String logsTokensTooltip(num value) => budgetTokensTooltip(value);

/// 「距预算上限 X / Y（软线 Z）」这一行。
///
/// 三个数都走同一处格式化；口径词只在**一行末尾出现一次**（每个数后面缀一遍就成了噪音，
/// 而"这一行数的是非缓存口径"这件事一行说一次就够）。
String logsLimitLine(int tokens, int hardLimit, int softLimit) {
  if (hardLimit <= 0) return '未设置日上限，进度条不可用';
  final exact = formatExact(tokens);
  final needsExact = formatCompact(tokens) != exact;
  return '距预算上限 ${formatCompact(tokens)}${needsExact ? '（$exact）' : ''} / ${formatWithExact(hardLimit)}'
      '（软线 ${formatWithExact(softLimit)}） · $kBudgetMetricLabel';
}

/// 页脚那一行：`月累计 X token · turn 数 N · 单次均价 Y`
String logsMonthLine(int tokens, int turns, int avgPerTurn) =>
    '月累计 ${budgetTokensText(tokens)} · turn 数 $turns · 单次均价 ${budgetTokensText(avgPerTurn)}';

/// 趋势线那一行的峰值：`token 用量 · 峰值 X`
String logsPeakLine(int peak) => 'token 用量（$kBudgetMetricLabel）· 峰值 ${formatWithExact(peak)}';
