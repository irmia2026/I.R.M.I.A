import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/her_name.dart';

/// 她的名字的规则（gui/lib/her_name.dart）：**读**（从 IDENTITY.md 认名字）、
/// **写**（把「名字：」那一行拼进正文）、**显示**（读不到时回退成什么）。
///
/// 这是一组纯函数测试：名字的三条判据、占位符、老实例的散文兜底，全在文本层面钉死——
/// 它们一旦松动，界面就会开始显示一个不是她的名字的名字（这次要修的正是这个）。
void main() {
  group('认名字：结构化那一行说了算', () {
    test('「名字：」那一行直接给出名字', () {
      expect(herNameFromIdentity('# 我是谁\n\n名字：小七\n'), '小七');
      expect(herNameFromIdentity('名字:小七'), '小七', reason: '半角冒号也认');
      expect(herNameFromIdentity('- 名字：小七\n'), '小七', reason: '人写成列表项也认');
      expect(herNameFromIdentity('名字：  小七  \n'), '小七', reason: '首尾空白不算名字的一部分');
      expect(herNameFromIdentity('名字：小七。\n'), '小七', reason: '行尾标点是排版');
    });

    test('名字后面括号里的是注解，不是名字的一部分', () {
      expect(herNameFromIdentity('名字：小七（Xiaoqi）\n'), '小七');
      expect(herNameFromIdentity('名字：伊尔弥亚（Irmia）\n'), '伊尔弥亚');
    });

    test('有那一行就不去正文里猜：写得不清楚 = 没写（模板占位符永远不会变成名字）', () {
      const seed = '<!-- SEED 填写后删除本行 -->\n'
          '# 我是谁\n\n'
          '名字：（改成她的名字）\n\n'
          '示例：我叫伊尔弥亚，是这台机器上常驻的伙伴。\n';
      expect(herNameFromIdentity(seed), isNull);
      expect(herNameFromIdentity('名字：\n\n我叫小七。\n'), isNull, reason: '空值也是"没写"');
      expect(herNameFromIdentity('名字：<!-- 待定 -->\n\n我叫小七。\n'), isNull);
    });

    test('太长的一行不是名字（上限与唤醒词的上限同值）', () {
      final long = '名' * (kHerNameMaxChars + 1);
      expect(herNameFromIdentity('名字：$long\n'), isNull);
      expect(herNameFromIdentity('名字：${'名' * kHerNameMaxChars}\n'), '名' * kHerNameMaxChars);
    });
  });

  group('认名字：正文兜底（只为首启种子模板之前就写好人格的老实例）', () {
    test('本机这份的写法：我是伊尔弥亚（Irmia）。→ 伊尔弥亚', () {
      const identity = '# 我是谁\n\n'
          '我是伊尔弥亚（Irmia）。表面身份：秩序圣殿祭司、弥亚庄园大小姐。\n'
          '真实身份：魔神，每百年失忆一次。\n';
      expect(herNameFromIdentity(identity), '伊尔弥亚');
    });

    test('我叫小七，是这台机器上常驻的伙伴。→ 小七', () {
      expect(herNameFromIdentity('# 我是谁\n\n我叫小七，是这台机器上常驻的伙伴。\n'), '小七');
    });

    test('句子片段不是名字：宁可认不出来，也不显示一个像名字的东西', () {
      expect(herNameFromIdentity('# 我是谁\n\n我是一个喜欢安静的人。\n'), isNull);
      expect(herNameFromIdentity('# 我是谁\n\n我是这台机器上常驻的伙伴。\n'), isNull);
      expect(herNameFromIdentity('# 我是谁\n\n我是谁？还没想好。\n'), isNull);
      expect(herNameFromIdentity('# 我是谁\n\n我是。,！\n'), isNull);
    });

    test('前一句不是名字就往后找：我是助手。我叫小七。→ 小七', () {
      expect(herNameFromIdentity('# 我是谁\n\n我是一个助手。我叫小七。\n'), '小七');
    });

    test('还是首启种子模板：里面的示例句不是她 → 认不出', () {
      const seed = '<!-- SEED 填写后删除本行 -->\n# 我是谁\n\n'
          '（名字、身份、核心性格。）\n\n'
          '示例：我叫伊尔弥亚（Irmia），是这台机器上常驻的伙伴。\n';
      expect(herNameFromIdentity(seed), isNull,
          reason: '老实例升级上来时踩的正是这条：模板里的示例不能被当成她的名字');
    });

    test('读不到正文 / 空正文 → 认不出', () {
      expect(herNameFromIdentity(null), isNull);
      expect(herNameFromIdentity(''), isNull);
      expect(herNameFromIdentity('   \n\n'), isNull);
      expect(herNameFromIdentity('# 我是谁\n\n（还没写。）\n'), isNull);
    });
  });

  group('写名字：把「名字：」那一行拼进正文', () {
    test('没有那一行就插在最前面，正文其余部分一个字节不动', () {
      const body = '<!-- SEED 填写后删除本行 -->\n# 我是谁\n\n（身份。）\n';
      final next = upsertHerNameLine(body, '小七');
      expect(next, '名字：小七\n$body');
      expect(next.endsWith(body), isTrue);
    });

    test('已经有那一行就换掉值，缩进与列表符号保留', () {
      expect(upsertHerNameLine('名字：（改成她的名字）\n# 我是谁\n', '小七'),
          '名字：小七\n# 我是谁\n');
      expect(upsertHerNameLine('- 名字：旧名\n- 别的\n', '小七'), '- 名字：小七\n- 别的\n');
      expect(upsertHerNameLine('名字：伊尔弥亚（Irmia）\n正文\n', '小七'), '名字：小七\n正文\n');
    });

    test('原文的第二个「名字：」不动（改的是第一处，也就是她自己的那一行）', () {
      const body = '名字：旧名\n\n## 别人怎么叫我\n\n名字：随便\n';
      expect(upsertHerNameLine(body, '小七'), '名字：小七\n\n## 别人怎么叫我\n\n名字：随便\n');
    });

    test('幂等：同样的名字写两遍结果一样', () {
      final once = upsertHerNameLine('正文\n', '小七');
      expect(upsertHerNameLine(once, '小七'), once);
    });

    test('空名字 = 不改正文（删那一行不是这一处的活）', () {
      expect(upsertHerNameLine('正文\n', ''), '正文\n');
      expect(upsertHerNameLine('正文\n', '   '), '正文\n');
    });

    test('带 BOM 的文件不会被插出第二行名字', () {
      final next = upsertHerNameLine('\uFEFF名字：旧名\n正文\n', '小七');
      expect(next, '\uFEFF名字：小七\n正文\n');
      expect(herNameFromIdentity(next), '小七');
    });

    test('名字里的换行与连续空白被压成一行（名字是一行字）', () {
      expect(sanitizeHerNameInput('  小\n七  '), '小 七');
      expect(upsertHerNameLine('正文\n', '  小七\n'), '名字：小七\n正文\n');
    });
  });

  group('显示：读不到名字时回退成什么（保守口径）', () {
    test('宽位置（窗口标题 / 托盘提示）→ 产品名', () {
      expect(herNameOrFallback(null), kProductName);
      expect(herNameOrFallback('  '), kProductName);
      expect(herNameOrFallback('小七'), '小七');
    });

    test('窄位置（侧栏品牌区）→ 产品名的短写，不是某个像名字的词', () {
      expect(herBrandName(null), kProductNameShort);
      expect(herBrandName('小七'), '小七');
      expect(kProductNameShort.length, lessThan(kProductName.length));
    });

    test('句子里的主语 → "她"（产品名塞进"…想问你："是错的）', () {
      expect(herNameInSentence(null), kHerPronoun);
      expect(herNameInSentence('小七'), '小七');
    });

    test('唤醒词输入框的示例：有名字照她的名字举例，没有就给格式示例', () {
      expect(mentionKeywordsHint(null), '名字、昵称、缩写');
      expect(mentionKeywordsHint('小七'), '小七、昵称');
      expect(mentionKeywordsHint('小七'), isNot(contains('伊尔弥亚')));
    });
  });

  test('回归锁：界面里不再写死任何一个名字', () {
    // 这次修的 bug 就是"界面写死了伊尔弥亚"。判据放在源码层面：lib/ 下的**代码行**里
    // 不许再出现她的名字（注释里可以提，那是说明来历——所以跳过整行注释）。
    final offenders = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final rows = entity.readAsLinesSync();
      for (var i = 0; i < rows.length; i += 1) {
        final code = rows[i].trimLeft();
        if (code.startsWith('//')) continue;
        if (rows[i].contains('伊尔弥亚') || rows[i].contains('弥亚小姐')) {
          offenders.add('${entity.path}:${i + 1}  ${rows[i].trim()}');
        }
      }
    }
    expect(offenders, isEmpty, reason: '这些地方还写死着她的名字：$offenders');
  });
}
