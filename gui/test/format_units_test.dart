import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/format.dart';
import 'package:irmia_gui/pages/logs_page.dart';

/// 单位与口径格式（`gui/lib/format.dart`）——与 `src/format/units.ts` **逐字镜像**。
///
/// 立这份测试的那条意见（用户 2026-10-05，逐字）：
///   > 「时机合适时单位换为M」——运行情况页写 2705.9k，日志页写 2.7M，
///   > **同一时刻同一个数两种写法**。
///
/// 所以这里钉两件事：
///   ① **换档边界**（999.9k / 1000k / 1.05M / 10M / 1G），逐条与 TS 侧那张表相同；
///   ② **同一个数在不同页面格式化结果一致**——这一条是那个 bug 的直接回归：
///      过去运行情况页一个内联三目（只会 k）、日志页一个 `_num()`，同一个 2705946 于是
///      成了 `2705.9k` 与 `2.7M` 两种写法。
void main() {
  group('换档边界', () {
    test('小于 1000 原样整数，1000 起换 k，100 万起换 M，10 亿起换 G', () {
      expect(formatCompact(0), '0');
      expect(formatCompact(1), '1');
      expect(formatCompact(999), '999');
      expect(formatCompact(1000), '1.0k');
      expect(formatCompact(1500), '1.5k');
      expect(formatCompact(999949), '999.9k');
      expect(formatCompact(999950), '1.0M', reason: '先舍入再换档：999.95k 印成 1000.0k 就读不出量级了');
      expect(formatCompact(1000000), '1.0M');
      expect(formatCompact(1050000), '1.1M');
      expect(formatCompact(2705946), '2.7M');
      expect(formatCompact(10000000), '10M', reason: '两位数起不带小数位');
      expect(formatCompact(105000000), '105M');
      expect(formatCompact(999949999), '999.9M');
      expect(formatCompact(999950000), '1.0G');
      expect(formatCompact(1000000000), '1.0G', reason: '1G');
      expect(formatCompact(1500000000), '1.5G');
    });

    test('真数：千分位，永不四舍五入到别处', () {
      expect(formatExact(2705946), '2,705,946');
      expect(formatExact(700), '700');
      expect(formatExact(1000000000), '1,000,000,000');
    });

    test('紧凑写法旁边永远有真数；两截同形时只印一遍', () {
      expect(formatWithExact(2705946), '2.7M（2,705,946）');
      expect(formatWithExact(700), '700');
      expect(budgetTokensText(6400000), '6.4M（6,400,000） 非缓存 token');
      expect(budgetTokensTooltip(2705946), '2,705,946 非缓存 token');
    });
  });

  group('同一个数在不同页面同一个写法', () {
    test('现场那个数：运行情况页与日志页的格式化函数给出同一串字符', () {
      // 用户报的那个数（2026-10-05 的「今日用量」）：2705946。
      // 这三个入口必须说同一句话——日志页两张 lane 卡、页脚月累计、运行情况页磁贴。
      const value = 2705946;
      expect(formatCompact(value), '2.7M');
      expect(logsCompactTokens(value), formatCompact(value));
      expect(formatWithExact(value), '2.7M（2,705,946）');
      expect(logsExactTokens(value), formatExact(value));
    });

    test('磁贴与 lane 卡共用同一份实现（不是各自算一遍）', () {
      // 两个页面导出的取数函数就是 `format.dart` 的那两个——同一个数不可能有两种写法。
      // 这条断言的意义在于"哪天有人又写一个内联三目"，它不会红（它只是标识函数），
      // 所以真正的回归在下面那条：把两个页面的**额度行**文案摆在一起比。
      expect(logsLimitLine(2705946, 50000000, 40000000), contains('2.7M'));
      expect(logsLimitLine(2705946, 50000000, 40000000), contains('50M'));
      expect(logsLimitLine(2705946, 50000000, 40000000), contains('非缓存口径'),
          reason: '凡"计入预算"的数字旁边都要看得出是非缓存口径');
      expect(logsLimitLine(2705946, 50000000, 40000000), contains('2,705,946'),
          reason: '真数也要在：紧凑写法 + 括号里的原始值');
    });

    test('月度页脚与弹层都走同一处格式化', () {
      expect(logsMonthLine(12345678, 42, 293945), contains('12.3M'));
      expect(logsMonthLine(12345678, 42, 293945), contains('12,345,678'));
    });
  });

  group('口径词', () {
    test('只有一个词：非缓存口径；旧说法（未扣缓存 / 含命中）不在这一份口径里', () {
      expect(kBudgetMetricLabel, '非缓存口径');
      expect(kBudgetMetricLabel.contains('未扣缓存'), isFalse);
      expect(kBudgetMetricLabel.contains('含命中'), isFalse);
    });
  });
}
