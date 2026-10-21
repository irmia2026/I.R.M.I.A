// TODO(i18n): 本文件还有 3 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/format.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
/// 数字口径与单位格式的**界面实现**——与 `src/format/units.ts` **逐字镜像**。
///
/// 立这个文件的那条意见（用户 2026-10-05，逐字）：
///   > 「时机合适时单位换为M」——运行情况页写 2705.9k，日志页写 2.7M，
///   > **同一时刻同一个数两种写法**。
///
/// 根因是两处各写各的（运行情况页一个内联三目、日志页一个 `_num()`）。所以这里收成一份，
/// 并且**阈值表与那边逐条对应**：改一边就必须改另一边（`test/format-units.test.ts` 与
/// `gui/test/format_units_test.dart` 钉的是同一张表）。
///
/// 约定（与 TS 侧一致）：
///   · 1000 进制；`k` / `M` / `G` 三档，小于 1000 的原样印整数；
///   · **保留 1 位小数**（`1.0k` / `2.7M` / `1.0G`）；两位数起不带小数位（`10M` / `105M`）；
///   · **先四舍五入再换档**（`999949 → 999.9k`，`999950 → 1.0M`，`1000000 → 1.0M`，`1G`）。
library;

const List<({int from, String suffix})> _scales = [
  (from: 1000000000, suffix: 'G'),
  (from: 1000000, suffix: 'M'),
  (from: 1000, suffix: 'k'),
];

/// 一个数 → `k` / `M` / `G` 自动换档的紧凑写法（界面唯一实现）。
String formatCompact(num value) {
  if (!value.isFinite) return '$value';
  final n = value.round();
  final picked = _scaleIndexFor(n); // -1 = 比 k 还小，不印单位
  if (picked < 0) return '$n';
  final scaled = _round1(n / _scales[picked].from);
  // 舍入把这一档顶穿（999.95k → 1000.0k）就交给上一档，让它印成 1.0M
  final scale = scaled.abs() >= 1000 && picked > 0 ? picked - 1 : picked;
  return '${_digits(_round1(n / _scales[scale].from))}${_scales[scale].suffix}';
}

/// 量级落在哪一档（0=G 1=M 2=k）；**比 k 还小返回 -1**（= 这个数不印单位）
int _scaleIndexFor(int value) {
  for (var i = 0; i < _scales.length; i += 1) {
    if (value.abs() >= _scales[i].from) return i;
  }
  return -1;
}

/// 档内数字的字面写法：两位数起不带小数位（`10M`），一位数时那一位留着（`1.0k`）。
/// 注意"不带小数位"不等于"抹掉小数"：`999.9k` 的那个 .9 是真的量级差。
String _digits(double value) =>
    value.abs() >= 10 && value == value.roundToDouble() ? '${value.round()}' : value.toStringAsFixed(1);

double _round1(num value) => (value * 10).round() / 10;

/// **原始精确值**：千分位分隔的整数（与 `units.ts` 的 `formatExact` 同一条）。
String formatExact(num value) {
  final n = value.isFinite ? value.round() : 0;
  final text = n.abs().toString();
  final out = StringBuffer(n < 0 ? '-' : '');
  for (var i = 0; i < text.length; i += 1) {
    if (i > 0 && (text.length - i) % 3 == 0) out.write(',');
    out.write(text[i]);
  }
  return out.toString();
}

/// 紧凑写法 + （真数）：`2.7M（2,705,946）`。
///
/// 用户要求逐字是「保留"原始精确值"在 tooltip 或括号里（别让人看不到真实数）」。
/// 两截字面相同时只印一遍（`700`）。
String formatWithExact(num value) {
  final compact = formatCompact(value);
  final exact = formatExact(value);
  return compact == exact ? compact : '$compact（$exact）';
}

/// 界面上的**口径词**：凡"计入预算/用量"的 token 数旁边都用它。
///
/// 口径 = **非缓存** token（`(input − cacheHit) + output`，唯一一处定义在
/// `state/fold.ts` 的 `budgetTokensOf`）。旧说法（"未扣缓存"/"含命中"）说的是换口径
/// **之前**的语义，留着就是假话。
const String kBudgetMetricLabel = '非缓存口径';

/// 一句话读法：`2.7M（2,705,946）非缓存 token`——给正文行（页脚、弹层小字）用。
String budgetTokensText(num value) => '${formatWithExact(value)} 非缓存 token';

/// tooltip 的那一行：`2,705,946 非缓存 token`。
///
/// 卡面印紧凑写法、悬停给真数——**真数永远拿得到**，而卡面不被一串数字撑爆。
String budgetTokensTooltip(num value) => '${formatExact(value)} 非缓存 token';
