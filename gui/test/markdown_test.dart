import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/markdown.dart';
import 'package:irmia_gui/theme.dart';

/// 简单 MD 渲染器的**四条**契约（用户 2026-10-05：**该实现简单的 MD 渲染了**；
/// 第二批：**标题、表格这些都要实现，很常用**；
/// 第三批：**用 Table/WidgetSpan 画真正的表格，竖线彻底不显示、列严格对齐**）。
///
/// ① **显示层只许少、不许改**：段落/标题/引用/列表/行内元素逐字上屏（记号字号 0）。
///    **唯一的例外是表格块**——它换成真的表格控件（`Table`），原文那一段因此不在 span 树里，
///    纯文本里留下一个 `U+FFFC` 占位符。所以这一批的判据从"拼回原文"改成**两条一起看**：
///      · `显示层 == 源串里每个表格块换成一个 U+FFFC`（[expectedDisplay] 与 [show] 逐例钉住）；
///      · `markdownPlainSpan` 那条**文本路**照旧逐字等于源串（一个字节都不少）——
///        它是对账用的那一层，也是「复制原文」入口所依据的事实。
/// ② **表格是真的网格**：竖线一个都不显示（`|` 连字形都不出现）、列由控件严格对齐、
///    表头加粗、`:` 标记的左/中/右照旧生效。表格**外面的**结构一样都不许变。
/// ③ **复制得到的必须是原文**：入口是消息级的「复制原文」（[markdownCopySourceLabel]）。
///    用例用真实那条含表格的消息当夹具，钉住"写进剪贴板的 == 源串"。
/// ④ **规则外的符号原样显示 / 未闭合与歧义退化**：`C#`、`a | b`、`| 只有一行 |`、
///    分隔行列数不符这类形状穿过解析器必须一个字节不变，而且**一个控件都不出现**
///    （退化时选中复制拿到的仍是原文——与表格块正好相反的那一半）。
///
/// 支持范围 = 标题 / 表格 / 引用 / 链接 / 水平线 / 嵌套列表（最多两层）
/// + 既有的粗体、斜体、行内码、围栏代码块、列表、段落换行。
/// **setext 标题（`甲\n---`）不做**——`---` 与水平线、表格分隔行、列表记号同形，
/// 猜错一次就把一行正文吃成标题；这里把它钉成"正文 + 水平线"。
///
/// 断言方式：所有例子都从**真实 widget 树**里取——文字取自屏幕上那棵 span 树，
/// 表格取自屏幕上那个 `Table` 控件（每一格的文字/对齐/字重/位置都是它自己报出来的），
/// 不是另建一棵树来对答案。
void main() {
  /// 把整棵 span 树按**文档顺序**拼回纯文本，**树里出现 `WidgetSpan` 就当场失败**。
  ///
  /// 这是"文本那条路"的判据：表格之外的来源必须逐字拼回原文（表格块换了控件，
  /// 所以表格来源请用 [show]）。出现 `WidgetSpan` 意味着原文里混进了占位符 `/` 少了一段。
  String flatten(InlineSpan span) {
    final buf = StringBuffer();
    void walk(InlineSpan s) {
      if (s is WidgetSpan) {
        fail('span 树里出现了 WidgetSpan（表格块之外不该有：它会往纯文本里塞 U+FFFC）');
      }
      if (s is TextSpan) {
        if (s.text != null) buf.write(s.text);
        for (final child in s.children ?? const <InlineSpan>[]) {
          walk(child);
        }
      }
    }

    walk(span);
    return buf.toString();
  }

  /// 屏幕上那层纯文本：整棵 span 树按文档顺序拼起来，**表格控件算一个 `U+FFFC`**。
  ///
  /// 这就是"选中复制能拿到什么"——表格块换成了控件，所以它比源串**少**了表格那一段
  /// （纪律 ①：只许多少，不许改）。要原文走「[markdownCopySourceLabel]」那个入口。
  String show(InlineSpan span) {
    final buf = StringBuffer();
    void walk(InlineSpan s) {
      if (s is WidgetSpan) {
        buf.write('\uFFFC');
        return;
      }
      if (s is TextSpan) {
        if (s.text != null) buf.write(s.text);
        for (final child in s.children ?? const <InlineSpan>[]) {
          walk(child);
        }
      }
    }

    walk(span);
    return buf.toString();
  }

  /// 显示层**应当**长什么样：源串里每一段表格块换成一个 `U+FFFC`，其余逐字照抄。
  ///
  /// 表格块的位置由 [markdownTableRanges] 给出（渲染器自己算的那一份）——用例不另写一套
  /// 表格识别；"哪些行算表格"由**另一批用例**从外面钉（正例必须有控件、坏结构必须没有）。
  String expectedDisplay(String source) {
    final normalized = normalizeMarkdownSource(source);
    final buf = StringBuffer();
    var at = 0;
    for (final (start, end) in markdownTableRanges(source)) {
      buf.write(normalized.substring(at, start));
      buf.write('\uFFFC');
      at = end;
    }
    buf.write(normalized.substring(at));
    return buf.toString();
  }

  /// 整棵 span 树按**叶子**摊平：每个叶子一项，`(该叶子的纯文本, 该叶子生效后的样式)`。
  ///
  /// 样式**沿树累加**（`merge`）：`**粗*斜*粗**` 里那个"斜"的粗体来自祖先，
  /// 只看叶子会误判成"没加粗"——而屏幕上它是粗的。
  List<(String, TextStyle)> segments(InlineSpan span) {
    final out = <(String, TextStyle)>[];

    void walk(InlineSpan s, TextStyle inherited) {
      if (s is WidgetSpan) fail('span 树里出现了 WidgetSpan（这条判据只看文字那条路）');
      if (s is! TextSpan) return;
      final style = inherited.merge(s.style);
      final kids = s.children ?? const <InlineSpan>[];
      if (kids.isEmpty) {
        out.add((s.text ?? '', style));
        return;
      }
      for (final child in kids) {
        walk(child, style);
      }
    }

    walk(span, const TextStyle());
    return out;
  }

  /// 所有**可见**文字（字号 0 的记号不算——它们在版面上不占位置）。
  /// 每个可见的换行补一个 '\u0001'：**换行是版面上真实存在的分隔**（它决定了
  /// "这两个块各自成行"还是"挤在一起"），不能像空白那样被吃掉。
  /// **表格控件算一个 `U+FFFC`**：它也是版面上真实占位的一块。
  String visible(InlineSpan span) {
    final buf = StringBuffer();
    void walk(InlineSpan s) {
      if (s is WidgetSpan) {
        buf.write('\uFFFC');
        return;
      }
      if (s is! TextSpan) return;
      final text = s.text ?? '';
      final children = s.children ?? const <InlineSpan>[];
      if ((s.style?.fontSize ?? 1) != 0) {
        buf.write(text.replaceAll('\n', '\u0001'));
      }
      for (final child in children) {
        walk(child);
      }
    }

    walk(span);
    return buf.toString();
  }

  /// 整棵树里 **字号 0 的隐藏 span 的内容**（按文档顺序）。用来钉"记号在树里活着"。
  List<String> hidden(InlineSpan span) {
    final out = <String>[];
    void walk(InlineSpan s) {
      if (s is! TextSpan) return;
      final text = s.text ?? '';
      if (text.isNotEmpty && (s.style?.fontSize ?? 1) == 0) out.add(text);
      for (final child in s.children ?? const <InlineSpan>[]) {
        walk(child);
      }
    }

    walk(span);
    return out;
  }

  /// **网格里每一格**：文字 / 对齐 / 可见那一叶的字重与字体——全部取自屏幕上那个 [Text]
  /// 控件自己报出来的东西（[Table] 的几个格子就是几个）。
  ///
  /// [text] 取的是**版面上看得见的那份**（`visible`：记号是字号 0，不算）：格子里的
  /// `**粗**` 在屏幕上就是"粗"两个字，记号仍活在 span 里（与正文同一条纪律）。
  List<({String text, TextAlign? align, FontWeight? weight, String? family})> gridCells(
      WidgetTester tester) {
    final out = <({String text, TextAlign? align, FontWeight? weight, String? family})>[];
    for (final text in tester.widgetList<Text>(
        find.descendant(of: find.byType(Table), matching: find.byType(Text)))) {
      final span = text.textSpan;
      final leaves = span == null ? const <(String, TextStyle)>[] : segments(span);
      // 可见的那一叶（`**粗**` 这种格子里，叶子前面还有字号 0 的记号）
      final body = leaves.where((leaf) => leaf.$1.isNotEmpty && (leaf.$2.fontSize ?? 1) != 0);
      final leaf = body.isNotEmpty ? body.first : (leaves.isEmpty ? null : leaves.first);
      out.add((
        text: span == null ? (text.data ?? '') : visible(span),
        align: text.textAlign,
        weight: leaf?.$2.fontWeight,
        family: leaf?.$2.fontFamily,
      ));
    }
    return out;
  }

  /// 屏幕上还有没有 `|` 这个**字形**（表格区那些竖线）。
  int pipeGlyphs() => find.textContaining('|').evaluate().length;

  /// [text] 是不是被某个 span 以 [test] 那种样式画出来的（沿树累加，见 [segments]）。
  /// 支持**跨 span** 的片段（`**粗体**` 的"粗体"是一个叶子，标题里的也是）。
  bool styled(InlineSpan span, String text, bool Function(TextStyle) test) =>
      segments(span).any((segment) => segment.$1.contains(text) && test(segment.$2));

  /// 把 [source] 真渲染一次，返回屏幕上那棵 span 树。
  ///
  /// 取的是 [SelectableText] 自己那份 `textSpan`——**就是它画出来、也是它复制出去的那棵**
  /// （不用另建一棵树来对答案）。
  Future<TextSpan> render(WidgetTester tester, String source, {bool dark = false}) async {
    await tester.pumpWidget(MaterialApp(
      theme: dark ? IrmiaTheme.dark() : IrmiaTheme.light(),
      home: Scaffold(body: MarkdownText(source)),
    ));
    await tester.pump();
    final span = tester.widget<SelectableText>(find.byType(SelectableText)).textSpan;
    if (span is! TextSpan) fail('根 span 不是 TextSpan：${span.runtimeType}');
    return span;
  }

  /// 真实那条消息的形状（用户圈出来的那条）：一级标题 + 三列表格，
  /// 分隔行**不带空格**（`|---|---|---|`），数据行三行，末尾一个换行。
  /// 「复制原文」那条用例就拿它当夹具。
  const diskChecklist = '# 磁盘甄别清单\n\n'
      '| 项 | 大小 | 说明 |\n'
      '|---|---|---|\n'
      '| C 盘 | 118 GB | 系统盘，别动 |\n'
      '| D 盘 | 1.8 TB | 数据盘 |\n'
      '| E 盘 | 512 GB | 备份盘 |\n';

  // ─────────────────────────── ① 不改变文本本身 ───────────────────────────

  group('① 显示层只许少、不许改（表格块换成控件）', () {
    /// 正例与反例一起过：**每一例**都必须原样拼回
    const cases = <String, String>{
      // ── 第一批（既有六样） ──
      '粗体': '**粗体**',
      '斜体': '*斜体*',
      '行内代码': '`code`',
      '粗斜混排': '**粗**与*斜*与`码`',
      '围栏代码块': '```dart\nfinal a = 1;\n```',
      '围栏代码块（无语言）': '```\nplain\n```',
      '波浪围栏': '~~~\nplain\n~~~',
      '无序列表': '- 甲\n- 乙\n- 丙',
      '星号无序列表': '* 甲\n* 乙',
      '加号无序列表': '+ 甲\n+ 乙',
      '有序列表': '1. 甲\n2. 乙\n10. 丙',
      '有序列表（右括号）': '1) 甲\n2) 乙',
      '段落 + 空行': '第一段\n\n第二段',
      '段内换行': '第一行\n第二行',
      '列表夹在段落之间': '开头\n\n- 甲\n- 乙\n\n结尾',
      '空行贴着列表': '- 甲\n\n- 乙',
      '连续空行': '甲\n\n\n\n乙',
      '代码块夹在段落之间': '上面\n\n```\nx\n```\n\n下面',
      '外部消息形状：@ 提及': '[@1 号] 在吗',
      '外部消息形状：平台标签': '<qqbot-at-user openid="A1" /> 你好',
      '外部消息形状：省略号': '这个……那个……',
      '反例：未闭合粗体': '**未闭合',
      '反例：四个星号': '****',
      '反例：三个星号': '***',
      '反例：五个星号': '*****',
      '反例：未闭合行内码': '`未闭合',
      '反例：未闭合围栏': '```\n没有闭栏',
      '反例：单个星号': '*',
      '反例：表格': '| a | b |\n| - | - |',
      '反例：标题': '# 标题\n## 二级',
      '反例：图片': '![alt](http://x/y.png)',
      '反例：HTML': '<b>不加粗</b>',
      '反例：链接': '[文字](http://x)',
      '反例：下划线强调（不支持）': '_斜_',
      '引用（一行）': '> 引用',
      '反例：列表记号后没空格': '-没空格',
      '嵌套列表（两层）': '- 甲\n  - 甲一',
      '反例：乘号算式': '3 * 4 = 12',
      '反例：两个独立星号': 'a * b * c',
      '反例：CRLF 行尾': '第一行\r\n第二行',
      '反例：孤立的反引号': '半个 ` 代码',
      '反例：粗体里未闭合的斜体': '**a *b*',
      // ── 第二批：标题 ──
      '标题 一级': '# 一级标题',
      '标题 六级': '###### 六级标题',
      '标题后带空格与内联元素': '# **粗**的标题',
      '标题行尾的井号是原文': '## 标题 ##',
      '反例：井号后没空格': '#标签 不是标题',
      '反例：C# 里的井号': 'C# 与 F#',
      '反例：七个井号': '####### 七级不算',
      '反例：井号单独一行': '# ',
      // ── 第二批：表格 ──
      '表格：基本': '| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |',
      '表格：对齐三种': '| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |',
      '表格：无外框管道': '名 | 值\n--- | ---\n甲 | 1',
      '表格：格内行内元素': '| 名 | 值 |\n| --- | --- |\n| **粗** | `码` |',
      '表格：列宽不齐（要补对齐）': '| 名 | 值 |\n| --- | --- |\n| 名字 | 乙 |',
      '表格：中文与 emoji 混排': '| 列 | 说明 |\n| --- | --- |\n| 🐟 | 鱼 |',
      '表格：转义管道属于格内': '| a | b |\n| --- | --- |\n| x \\| y | z |',
      '表格：行内代码里的管道不当分隔': '| a | b |\n| --- | --- |\n| `x|y` | z |',
      '表格：夹在段落之间': '上面\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n下面',
      '反例：只有表头没有分隔行': '| a | b |',
      '反例：竖线只是正文': 'a | b',
      '反例：拿竖线当装饰': '注意：| 这里 | 不是表格 |',
      '反例：分隔行列数与表头不符': '| a | b |\n| --- | --- | --- |\n| 1 | 2 |',
      '反例：分隔行里夹了空列': '| a | b |\n| --- |  |\n| 1 | 2 |',
      '反例：代码块里的竖线': '```\n| a | b |\n| --- | --- |\n```',
      '反例：表格形状的纯文本': '| 只有一行 | 没有分隔行 |',
      // ── 第二批：引用 ──
      '引用：一行': '> 引用的**粗**字',
      '引用：多行': '> 第一行\n> 第二行',
      '引用：里套标题与列表': '> # 标题\n> - 甲',
      '引用：嵌套一层': '> > 内层',
      '反例：单个大于号': '>',
      '反例：大于号后没空格': '>引用 不算',
      '反例：行中的大于号': '甲 > 乙',
      '反例：引用里的空行': '> 甲\n>\n> 乙',
      // 引用是**逐行**剥掉 `>` 再解析的，一行凑不出"表头 + 分隔行"——
      // 所以引用里的表格形状按普通文字（管道照旧看得见）。这是已知边界，钉在这里。
      '反例：引用里的表格形状': '> | a | b |\n> | --- | --- |',
      // ── 第二批：链接 ──
      '链接：基本': '[看这里](http://example.com/a)',
      '链接：标签里有粗体': '[**重点**](http://x/1)',
      '链接：夹在句子里': '见 [文档](https://a.b/c) 这一节',
      '反例：没有 scheme 的地址': '[不是链接](no-scheme)',
      '反例：空地址': '[空]()',
      '反例：只有方括号': '[只有括号]',
      '反例：未闭合的圆括号': '[文字](http://x',
      '反例：图片不是链接': '![alt](http://x/y.png)',
      // ── 第二批：水平线 ──
      '水平线：短横': '---',
      '水平线：星号': '***',
      '水平线：下划线': '___',
      '水平线：中间带空格': '- - -',
      '水平线：夹在段落之间': '上面\n\n---\n\n下面',
      '反例：上一行加短横（setext 形状不认）': '甲\n---',
      '反例：句尾的短横': '甲 --- 乙',
      '反例：两个短横': '--',
      '反例：四个下划线混在一句话里': '___粗___',
      // ── 第二批：嵌套列表（最多两层） ──
      '嵌套列表：两层': '- 甲\n  - 甲一',
      '嵌套列表：四空格缩进': '- 甲\n    - 甲一',
      '嵌套列表：有序套无序': '1. 甲\n    - 甲一',
      '反例：第三层（按普通缩进文字）': '- 甲\n      - 甲一',
      '反例：缩进但没有记号': '- 甲\n      普通缩进行',
    };

    cases.forEach((name, source) {
      testWidgets('$name —— 原文一个字符不少（表格块换成控件）', (tester) async {
        final span = await render(tester, source);
        // 新契约（纪律 ①）：表格块之外逐字上屏，每个表格块换成一个 U+FFFC 占位符。
        expect(show(span), expectedDisplay(source));
        // 而且**每个表格块恰好换成一个控件**：没有表格的来源一个控件都不许有
        // （退化那一条的另一半——坏结构上屏时连 `Table` 都不出现）。
        expect(find.byType(Table), findsNWidgets(markdownTableRanges(source).length));
      });
    });

    test('纯文本那条路（markdownPlainSpan）逐字等于原文——一个字节都不少', () {
      // 这条路**不做网格**：表格块在它这里仍然是原文那几行字符（含 `|`、含分隔行）。
      // 它是"对账"的那一层：显示层少了哪一段，由 [expectedDisplay] 说得清清楚楚。
      for (final source in cases.values) {
        expect(flatten(markdownPlainSpan(source)), normalizeMarkdownSource(source));
      }
    });

    test('表格块的位置：markdownTableRanges 指的就是源串里那几行', () {
      final ranges = markdownTableRanges(diskChecklist);
      expect(ranges.length, 1);
      final (start, end) = ranges.single;
      final slice = diskChecklist.substring(start, end);
      expect(slice.startsWith('| 项 | 大小 | 说明 |'), isTrue, reason: '从表头行第一个字符起');
      expect(slice.contains('|---|---|---|'), isTrue, reason: '分隔行在块里');
      expect(slice.contains('| E 盘 | 512 GB | 备份盘 |'), isTrue, reason: '数据行在块里');
      // 区间到"块自己那一整段"为止：表格是最后一段时，收尾那个换行也算它的
      // （不并进去的话，占位符后面那个孤零零的换行会被算成"又一个表格那么高的空行"，
      //  见 markdown.dart 里 _MarkdownTableGrid 上面那段实测账）。
      expect(slice.endsWith('| E 盘 | 512 GB | 备份盘 |\n'), isTrue, reason: '末尾那个换行并进块里');
      expect(end, diskChecklist.length, reason: '这块正好收到源串末尾');
      // 表格后面还有正文时，收尾换行**不**并进块（它是控件与下一段之间的断行）
      const withTail = '| a | b |\n| --- | --- |\n| 1 | 2 |\n下面';
      final (tailStart, tailEnd) = markdownTableRanges(withTail).single;
      expect(withTail.substring(tailStart, tailEnd).endsWith('| 1 | 2 |'), isTrue);
      expect(withTail[tailEnd], '\n');
      // 没有表格就没有区间（退化那一条据此判"没有控件"）
      expect(markdownTableRanges('a | b'), isEmpty);
      expect(markdownTableRanges('| a | b |\n| --- | --- | --- |\n| 1 | 2 |'), isEmpty);
    });

    test('规范化只做 CRLF → LF，别的空白一个不动', () {
      expect(normalizeMarkdownSource('a\r\nb\rc'), 'a\nb\nc');
      expect(normalizeMarkdownSource('a  b\t c'), 'a  b\t c');
      expect(normalizeMarkdownSource('  行首留白'), '  行首留白');
    });

    testWidgets('空串不炸', (tester) async {
      final span = await render(tester, '');
      expect(flatten(span), '');
      expect(tester.takeException(), isNull);
    });
  });

  // ─────────────────────────── ② 记号之外原样显示 ───────────────────────────

  group('② 规则外的符号原样显示（她的消息里的形状）', () {
    testWidgets('[@1 号] 不被当成链接、方括号原样在', (tester) async {
      final span = await render(tester, '[@1 号] 你在吗');
      expect(flatten(span), '[@1 号] 你在吗');
      expect(visible(span), '[@1 号] 你在吗');
    });

    testWidgets('<qqbot-at-user …/> 不被当成 HTML 吃掉', (tester) async {
      const source = '<qqbot-at-user openid="A1B2" /> 你好';
      final span = await render(tester, source);
      expect(flatten(span), source);
      expect(visible(span), source, reason: '整句照旧可见，一个字符都没少');
    });

    testWidgets('省略号、破折号、全角引号、emoji 一个不动', (tester) async {
      const source = '这个……那个——还有「引号」和 🐟';
      final span = await render(tester, source);
      expect(flatten(span), source);
      expect(visible(span), source);
    });

    testWidgets('"不做"的那几样：记号原样看得见（图片 / HTML / 下划线强调）', (tester) async {
      // `![alt](url)` 整句原样（图片不做，连它那一半链接也不做）：见下
      const image = '![alt](http://x/y.png)';
      final imageSpan = await render(tester, image);
      expect(visible(imageSpan), image, reason: '图片不做：整句可见（`[]()` 也不当成链接）');
      expect(flatten(imageSpan), image);
      expect(styled(imageSpan, 'alt', (s) => s.decoration == TextDecoration.underline), isFalse,
          reason: '图片那一半不许被渲染成链接');
      // 反例：没有 `!` 前缀时同一个形状就是链接（`[]()` 不占版面）
      final linkSpan = await render(tester, '[alt](http://x/y.png)');
      expect(visible(linkSpan), 'althttp://x/y.png');
      // HTML：尖括号照旧
      const html = '<b>不加粗</b>';
      expect(visible(await render(tester, html)), html);
      expect(styled(await render(tester, html), '不加粗', (s) => s.fontWeight == FontWeight.w700),
          isFalse);
      // 下划线强调：不做（`_` 在正文里就是下划线字符）
      const underscore = '_斜_';
      expect(visible(await render(tester, underscore)), '_斜_');
      expect(styled(await render(tester, underscore), '斜', (s) => s.fontStyle == FontStyle.italic),
          isFalse);
    });

    testWidgets('C# / #标签 / a | b：与结构同形的普通文字一个不动', (tester) async {
      for (final source in const ['C# 与 F#', '#标签 不是标题', 'a | b', '注意：| 这里 | 不是表格 |']) {
        final span = await render(tester, source);
        expect(visible(span), source, reason: '$source 应当整句可见（规则外就原样）');
      }
    });
  });

  // ─────────────────────────── ③ 未闭合 → 普通文字 ───────────────────────────

  group('③ 未闭合与歧义记号的退化', () {
    testWidgets('**未闭合：四个字符都看得见，且没有粗体跑出来', (tester) async {
      final span = await render(tester, '**未闭合');
      expect(visible(span), '**未闭合');
      expect(styled(span, '未闭合', (s) => s.fontWeight == FontWeight.w700), isFalse);
    });

    testWidgets('*** / **** / *****：整行三个以上星号 = 水平线（不可见，但不吞）', (tester) async {
      // 这一批加了水平线，`***` 与 `---`、`___` 同形：文档里它就是一条分割线，
      // 所以版面上**不可见**——但字符一个不少（复制出去还是 `***`）。
      for (final source in const ['***', '****', '*****']) {
        final span = await render(tester, source);
        expect(visible(span), '', reason: '$source 是水平线，不占版面');
        expect(flatten(span), source, reason: '$source 的字符一个不少');
        expect(hidden(span).contains(source), isTrue, reason: '记号在树里活着');
      }
      // 反例：`**粗**` 这种"行内强调"仍然照常渲染（别把 `***` 的规则读宽了）
      final bold = await render(tester, '**粗**');
      expect(visible(bold), '粗');
      expect(styled(bold, '粗', (s) => s.fontWeight == FontWeight.w700), isTrue);
    });

    testWidgets('` 未闭合：反引号照旧可见', (tester) async {
      expect(visible(await render(tester, '半个 ` 代码')), '半个 ` 代码');
    });

    testWidgets('3 * 4 = 12 不会被读成斜体（星号之间是空格）', (tester) async {
      final span = await render(tester, '3 * 4 = 12');
      expect(visible(span), '3 * 4 = 12');
      expect(styled(span, '3', (s) => s.fontStyle == FontStyle.italic), isFalse);
    });

    testWidgets('a * b * c 里那三段文字都不是斜体', (tester) async {
      final span = await render(tester, 'a * b * c');
      for (final piece in const ['a ', ' b ', ' c']) {
        expect(styled(span, piece, (s) => s.fontStyle == FontStyle.italic), isFalse,
            reason: '「$piece」不该是斜体');
      }
    });

    testWidgets('表格坏结构：分隔行列数不符 / 夹空列 / 只有一行 —— 全按普通文字、且不出现任何控件',
        (tester) async {
      const bad = <String>[
        '| a | b |\n| --- | --- | --- |\n| 1 | 2 |', // 分隔行多一列
        '| a | b |\n| --- |  |\n| 1 | 2 |', // 分隔行里有空列
        '| a | b |', // 只有表头，没有分隔行
        '| 只有一行 |', // 只有一行
      ];
      for (final source in bad) {
        final span = await render(tester, source);
        expect(visible(span), source.replaceAll('\n', '\u0001'),
            reason: '$source 应当整块可见（坏结构 → 普通文字）');
        expect(hidden(span).where((text) => text.contains('-')).isEmpty, isTrue,
            reason: '坏结构里不该有"整行隐掉"的分隔行');
        // 「降级照旧」的另一半：**连控件都不出现**——这时选中复制拿到的仍然是原文
        // （与真正的表格块正好相反：那边靠「复制原文」入口补回来）。
        expect(find.byType(Table), findsNothing, reason: '$source 不该画成网格');
        expect(show(span), normalizeMarkdownSource(source), reason: '退化时显示层 == 原文');
        expect(pipeGlyphs(), greaterThan(0), reason: '管道这些字照旧看得见（它就是原文）');
      }
    });

    testWidgets('标题坏结构：`#` 后没空格 / 七个井号 —— 按普通文字', (tester) async {
      for (final source in const ['#标签 不是标题', '####### 七级不算']) {
        final span = await render(tester, source);
        expect(visible(span), source);
        expect(styled(span, '标签', (s) => (s.fontSize ?? 0) > 14), isFalse,
            reason: '不是标题就不该被放大');
      }
    });

    testWidgets('引用坏结构：空的 `>` 是普通文字；`>引用` 没空格也算引用（如实钉住）',
        (tester) async {
      // `>` 后面什么都没有 → 不是引用（纪律 ③：未闭合/坏结构当普通文字）
      expect(visible(await render(tester, '>')), '>');
      expect(visible(await render(tester, '> 甲\n>\n> 乙')), '甲\u0001>\u0001乙',
          reason: '中间那个光杆 `>` 照旧可见');
      // `>引用`（`>` 后没有空格）：**判成引用**（记号按 GFM 的写法允许不带空格）。
      // 这是"往引用那一边靠"的决定：她把整行当引用的可能性，比"`>` 是个装饰字符"大。
      final tight = await render(tester, '>引用 不算');
      expect(visible(tight), '引用 不算', reason: '`>` 是引用记号，不占版面');
      expect(flatten(tight), '>引用 不算', reason: '但复制出去还在');
      // 反例：行中间那个 `>` 什么都不是
      expect(visible(await render(tester, '甲 > 乙')), '甲 > 乙');
    });

    testWidgets('链接坏结构：没 scheme / 空地址 / 未闭合 —— 按普通文字', (tester) async {
      for (final source in const ['[不是链接](no-scheme)', '[空]()', '[文字](http://x']) {
        final span = await render(tester, source);
        expect(visible(span), source);
        expect(styled(span, '不是链接', (s) => s.color != null), isFalse,
            reason: '不是链接就不该上链接色');
      }
    });
  });

  // ─────────────────────────── 正例：真的渲染了 ───────────────────────────

  group('正例：支持的结构都真的渲染出来', () {
    testWidgets('**粗体** 的可见文字不含星号，且是 w700', (tester) async {
      final span = await render(tester, '前 **粗体** 后');
      expect(visible(span), '前 粗体 后', reason: '记号不占版面');
      expect(styled(span, '粗体', (s) => s.fontWeight == FontWeight.w700), isTrue);
    });

    testWidgets('*斜体* 是 italic', (tester) async {
      final span = await render(tester, '*斜体*');
      expect(visible(span), '斜体');
      expect(styled(span, '斜体', (s) => s.fontStyle == FontStyle.italic), isTrue);
    });

    testWidgets('`行内代码` 是等宽 + 淡底（取色走主题）', (tester) async {
      final span = await render(tester, '看 `x = 1` 这行');
      expect(visible(span), '看 x = 1 这行');
      expect(styled(span, 'x = 1', (s) => s.fontFamily == 'monospace'), isTrue);
      expect(styled(span, 'x = 1', (s) => s.backgroundColor != null), isTrue,
          reason: '行内代码要有淡底（取色走主题）');
    });

    testWidgets('围栏代码块：内容可见、围栏记号不可见、内部 `**` 不再解析', (tester) async {
      const source = '```\na = **b**\n```';
      final span = await render(tester, source);
      // 围栏那两行（连同**开栏那个换行**）都隐形；正文与闭栏之间那个换行是真的换行（留着），
      // 闭栏自己的换行在文档末尾、本来就没有。
      expect(visible(span), 'a = **b**\u0001',
          reason: '围栏两行隐形，只有正文（它内部的 ** 不解析）');
      expect(styled(span, 'a = ', (s) => s.fontFamily == 'monospace'), isTrue);
      expect(styled(span, 'a = ', (s) => s.fontWeight == FontWeight.w700), isFalse,
          reason: '代码块里不解析行内记号');
    });

    testWidgets('无序列表：记号可见（它就是列表的样子），正文各自成块', (tester) async {
      final span = await render(tester, '- 甲\n- 乙');
      expect(visible(span), '- 甲\u0001- 乙');
      expect(flatten(span), '- 甲\n- 乙');
    });

    testWidgets('有序列表：`1. ` 归列表记号', (tester) async {
      final span = await render(tester, '1. 甲\n2. 乙');
      expect(visible(span), '1. 甲\u00012. 乙');
      expect(flatten(span), '1. 甲\n2. 乙');
    });

    testWidgets('**粗**里套*斜*：两层都成立', (tester) async {
      final span = await render(tester, '**粗*斜*粗**');
      expect(flatten(span), '**粗*斜*粗**');
      expect(visible(span), '粗斜粗');
      expect(styled(span, '斜', (s) => s.fontStyle == FontStyle.italic), isTrue);
      expect(styled(span, '斜', (s) => s.fontWeight == FontWeight.w700), isTrue,
          reason: '套在粗体里的斜体应当同时是粗的（继承外层）');
    });

    testWidgets('ATX 标题：`#` 不可见、文字放大加粗（级别越高越大）', (tester) async {
      final h1 = await render(tester, '# 一级');
      final h3 = await render(tester, '### 三级');
      expect(visible(h1), '一级', reason: '`# ` 不占版面');
      expect(styled(h1, '一级', (s) => s.fontWeight == FontWeight.w700), isTrue);
      expect(styled(h1, '一级', (s) => (s.fontSize ?? 0) > 14), isTrue, reason: '标题要比正文大');
      expect(styled(h3, '三级', (s) => (s.fontSize ?? 99) < 14 * 1.3), isTrue,
          reason: '三级比一级小');
      expect(flatten(h1), '# 一级');
    });

    testWidgets('标题里的行内元素继承标题字号：`# **粗**`', (tester) async {
      final span = await render(tester, '# **粗**字');
      expect(visible(span), '粗字');
      expect(styled(span, '粗', (s) => s.fontWeight == FontWeight.w700 && (s.fontSize ?? 0) > 14),
          isTrue);
      expect(styled(span, '字', (s) => (s.fontSize ?? 0) > 14), isTrue);
    });

    // ── 表格：这一批的主战场（真网格） ──

    testWidgets('表格：画成真的网格——控件在、竖线一个字形都没有、表头加粗、格子等宽',
        (tester) async {
      const source = '| 名 | 值 |\n| --- | --- |\n| 甲 | 1 |';
      final span = await render(tester, source);
      // ① 屏幕上真的有一个网格控件，而且**只有一个**（两个表格块才是两个）
      expect(find.byType(Table), findsOneWidget);
      // ② **竖线彻底不显示**：`|` 在屏幕上连字形都没有（它不是内容，是语法）
      expect(pipeGlyphs(), 0, reason: '表格区那些竖线一个都不该出现');
      expect(visible(span), '\uFFFC', reason: '整条消息就是这一张表：版面上一个占位符');
      // ③ 表头加粗、格子等宽（字体与上一版逐字相同：这批只动结构）
      final cells = gridCells(tester);
      expect(cells.map((c) => c.text).toList(), ['名', '值', '甲', '1']);
      expect(cells.take(2).every((c) => c.weight == FontWeight.w700), isTrue, reason: '表头加粗');
      expect(cells.skip(2).every((c) => c.weight != FontWeight.w700), isTrue, reason: '数据行不加粗');
      expect(cells.every((c) => c.family == 'monospace'), isTrue, reason: '格子等宽');
      // ④ 分隔行不再以"隐形文字"的形式留在树里——它是语法，退出显示层了
      //    （字符没丢：文本那条路逐字拼得回来，见 ① 组里那条用例）
      expect(hidden(span).any((text) => text.contains('---')), isFalse);
      // ⑤ 网格自己不画竖线：边框的左右与内部竖线都是 none
      final table = tester.widget<Table>(find.byType(Table));
      expect(table.border?.verticalInside, BorderSide.none);
      expect(table.border?.left, BorderSide.none);
      expect(table.border?.right, BorderSide.none);
    });

    testWidgets('表格：列严格对齐（同一列的格子左右边界一模一样）', (tester) async {
      const source = '| 项 | 大小 | 说明 |\n'
          '|---|---|---|\n'
          '| C 盘 | 118 GB | 系统盘 |\n'
          '| D 盘 | 1.8 TB | 数据盘 |\n';
      await render(tester, source);
      // 判据取自**真实布局**：同一列的每一格，左边界与宽度都必须完全相同。
      Rect rectOf(String text) => tester.getRect(find.text(text).first);
      for (final column in const [
        ['项', 'C 盘', 'D 盘'],
        ['大小', '118 GB', '1.8 TB'],
        ['说明', '系统盘', '数据盘'],
      ]) {
        final rects = column.map(rectOf).toList();
        final first = rects.first;
        for (final rect in rects.skip(1)) {
          expect(rect.left, first.left, reason: '「$column」这一列的左边界必须对齐');
          expect(rect.width, first.width, reason: '「$column」这一列的列宽必须相同');
        }
      }
      // 列与列之间不重叠、且严格从左到右（这就是"网格"）
      final lefts = [rectOf('项').left, rectOf('大小').left, rectOf('说明').left];
      expect(lefts[0] < lefts[1] && lefts[1] < lefts[2], isTrue);
      expect(rectOf('项').right <= rectOf('大小').left, isTrue);
      expect(rectOf('大小').right <= rectOf('说明').left, isTrue);
    });

    testWidgets('表格：`:` 对齐标记左/中/右都生效', (tester) async {
      await render(tester, '| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b | c |');
      final cells = gridCells(tester);
      expect(cells.map((c) => c.text).toList(), ['左', '中', '右', 'a', 'b', 'c']);
      for (final cell in cells) {
        final expected = switch (cell.text) {
          '左' || 'a' => TextAlign.left,
          '中' || 'b' => TextAlign.center,
          _ => TextAlign.right,
        };
        expect(cell.align, expected, reason: '「${cell.text}」这一列的对齐标记没生效');
      }
    });

    testWidgets('表格：格子里的字就是原文里那一格的字（不补空白凑列宽）', (tester) async {
      // 上一版这条用例叫"一个字符都不多不少"：那时表格还是文字，判据是"拼回原文 == 源串"。
      // 真网格之后显示层不再等于原文（多了一个占位符、少了 `|` 与分隔行），
      // 但**"不往她的话里补东西"**这条没有放宽：判据改成"每一格的文字都来自原文那一格"。
      const cases = <String, List<String>>{
        '| 名 | 值 |\n| --- | --- |\n| 名字 | 乙 |': ['名', '值', '名字', '乙'], // 列宽不齐：最容易想补空白的一例
        '| a | b |\n| --- | --- |\n| 12 | 3 |': ['a', 'b', '12', '3'],
        '| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| x | y | z |': ['左', '中', '右', 'x', 'y', 'z'],
        '名 | 值\n--- | ---\n甲 | 1': ['名', '值', '甲', '1'], // 没有外框管道
      };
      for (final entry in cases.entries) {
        final source = entry.key;
        final span = await render(tester, source);
        // 格子里的每一段文字都能在源串里找到（格子首尾的空白是原文的排版留白，裁掉的不算字）
        for (final cell in gridCells(tester).map((c) => c.text)) {
          expect(source.contains(cell), isTrue,
              reason: '$source：格子里出现了原文里没有的文字「$cell」');
        }
        expect(gridCells(tester).map((c) => c.text).toList(), entry.value);
        // 字号 0 的 span 里不许出现**空白填充**（补出来的对齐填充一定是空格串）。
        // 现在这条路上只剩记号（标题的 `#`、引用的 `>` 之类），表格那一段根本不进树。
        final padding = hidden(span).where((text) => text.trim().isEmpty && text != '\n').toList();
        expect(padding, isEmpty,
            reason: '$source：字号 0 的 span 里出现了空白填充「${padding.join('|')}」');
      }
    });

    testWidgets('表格：单元格里的行内元素照常（**粗** / `码`）', (tester) async {
      await render(tester, '| a | b |\n| --- | --- |\n| **粗** | `码` |');
      final cells = gridCells(tester);
      expect(cells.map((c) => c.text).toList(), ['a', 'b', '粗', '码']);
      final bold = cells.firstWhere((c) => c.text == '粗');
      expect(bold.weight, FontWeight.w700, reason: '格子里的 `**粗**` 照常加粗');
      final code = cells.firstWhere((c) => c.text == '码');
      expect(code.family, 'monospace', reason: '格子里的行内码照常等宽');
    });

    testWidgets('表格：数据行格数不齐也不丢字（少的补空格子、多的并进最后一格）', (tester) async {
      // `Table` 要求每一行格数相同（不等会当场断言失败），而 GFM 允许数据行格数不齐。
      // 取"不丢字"这一边：多出来的格并进最后一格（并的时候不补分隔符——补一个空格也是补字）。
      await render(tester, '| a | b |\n| --- | --- |\n| 1 | 2 | 3 |');
      expect(gridCells(tester).map((c) => c.text).toList(), ['a', 'b', '1', '23']);
      await render(tester, '| a | b | c |\n| --- | --- | --- |\n| 1 |');
      expect(gridCells(tester).map((c) => c.text).toList(), ['a', 'b', 'c', '1', '', '']);
    });

    testWidgets('表格：下面不会多出一整块空白（占位符后面那个孤零零的换行）', (tester) async {
      // 实测过的排版账（markdown.dart 里 _MarkdownTableGrid 上面那段）：`WidgetSpan`
      // 后面只跟一个换行、整段就结束时，那一个"空行"会按**占位符的高度**算——
      // 表格下面凭空多出一整块和表格一样高的空白（实测 100 高的占位符 → 多 109）。
      // 表格正好收尾的这条消息就是这种形状，所以这里连高度一起钉住。
      await render(tester, diskChecklist);
      final table = tester.getRect(find.byType(Table));
      final box = tester.getRect(find.byType(SelectableText));
      expect(box.bottom - table.bottom, lessThan(30),
          reason: '表格下面只该有那一行的行距，不该再多出一整块空白');
      expect(box.height, lessThan(table.height + 120),
          reason: '整条消息的高度不该把表格算两遍');
      // 表格后面还有正文时，那个换行照旧是"断行"（不并进块）
      await render(tester, '| a | b |\n| --- | --- |\n| 1 | 2 |\n下面一句');
      expect(find.byType(Table), findsOneWidget);
      expect(visible(await render(tester, '| a | b |\n| --- | --- |\n| 1 | 2 |\n下面一句')),
          '\uFFFC\u0001下面一句', reason: '表格自成一行，下一句另起一行');
    });

    testWidgets('表格：夹在段落之间时，表格前后的正文逐字上屏', (tester) async {
      const source = '上面\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n下面';
      final span = await render(tester, source);
      expect(show(span), expectedDisplay(source));
      expect(show(span), '上面\n\n\uFFFC\n\n下面');
      expect(visible(span), '上面\u0001\u0001\uFFFC\u0001\u0001下面', reason: '网格自成一行，前后各留一个空行');
      expect(pipeGlyphs(), 0);
    });

    testWidgets('表格：转义管道 `\\|` 是格内的内容，照原样显示', (tester) async {
      // `\|` 是**她写的**（内容），不是语法：它留在格子里的字面上（一个字节都不改），
      // 所以这一条用例里屏幕上**会有**一个 `|` 字形——那不是表格的竖线。
      await render(tester, '| a | b |\n| --- | --- |\n| x \\| y | z |');
      final cells = gridCells(tester);
      expect(cells.map((c) => c.text).toList(), ['a', 'b', r'x \| y', 'z']);
      expect(pipeGlyphs(), 1, reason: '只有格内那一个字面管道，表格的竖线仍然一个都没有');
    });

    testWidgets('引用：`>` 不可见，里层文字缩进/斜体，引用里的行内元素照常', (tester) async {
      final span = await render(tester, '> 引用的**粗**字');
      expect(visible(span), '引用的粗字', reason: '`> ` 不占版面');
      expect(flatten(span), '> 引用的**粗**字');
      expect(styled(span, '引用的', (s) => s.fontStyle == FontStyle.italic), isTrue,
          reason: '引用块整体是斜的（版面上看得出"这是引用"）');
      expect(styled(span, '粗', (s) => s.fontWeight == FontWeight.w700), isTrue);
    });

    testWidgets('引用里的标题与列表照常解析（同一套块级规则）', (tester) async {
      final span = await render(tester, '> # 标题\n> - 甲');
      expect(visible(span), '标题\u0001- 甲');
      expect(styled(span, '标题', (s) => s.fontWeight == FontWeight.w700), isTrue);
    });

    testWidgets('水平线：整行隐形，但字符仍在树里（复制得到原文）', (tester) async {
      for (final rule in const ['---', '***', '___', '- - -']) {
        final source = '上面\n\n$rule\n\n下面';
        final span = await render(tester, source);
        expect(visible(span), '上面\u0001\u0001\u0001\u0001下面',
            reason: '$rule 应当整行不可见（只有它两边的空行各留一个换行）');
        expect(flatten(span), source);
      }
    });

    testWidgets('嵌套列表：第二层的记号更小，缩进本身仍是原文', (tester) async {
      final span = await render(tester, '- 甲\n  - 甲一');
      expect(visible(span), '- 甲\u0001  - 甲一', reason: '缩进是原文，照旧可见');
      expect(flatten(span), '- 甲\n  - 甲一');
      final markers = segments(span).where((segment) => segment.$1.trim() == '-').toList();
      expect(markers.length, 2, reason: '两层各有一个 `- ` 记号');
      expect((markers.last.$2.fontSize ?? 14) < (markers.first.$2.fontSize ?? 14), isTrue,
          reason: '第二层的记号要小一点（嵌套在版面上看得出来）');
    });

    testWidgets('链接：可见、上链接色、有下划线（**当前不可点**）', (tester) async {
      final span = await render(tester, '见 [文档](https://a.b/c) 这一节');
      // `[]()` 与方括号不占版面；地址留在版面上（比标签淡）——
      // 因为这一批**不可点**，认出来全靠看得见：只剩"文档"两个字就没人知道它是个链接。
      expect(visible(span), '见 文档https://a.b/c 这一节');
      expect(flatten(span), '见 [文档](https://a.b/c) 这一节');
      expect(styled(span, '文档', (s) => s.color != null), isTrue, reason: '链接标签有色');
      expect(styled(span, '文档', (s) => s.decoration == TextDecoration.underline), isTrue,
          reason: '链接标签有下划线');
    });

    testWidgets('链接：标签里的强调继承链接色；悬停时给出完整 URL', (tester) async {
      final span = await render(tester, '[**重点**](http://x/1)');
      expect(styled(span, '重点', (s) => s.fontWeight == FontWeight.w700 && s.color != null),
          isTrue);
      expect(visible(span), '重点http://x/1', reason: '`[]()` 不占版面，标签与地址都看得见');
    });

    testWidgets('暗色主题下渲染结果一样（取色不写死）', (tester) async {
      const source = '**粗** `码`\n\n```\nx\n```';
      final span = await render(tester, source, dark: true);
      expect(flatten(span), source);
      // 可见部分：正文 + 空行那一个换行 + 代码与闭栏之间那个换行 + 正文 x。
      // 围栏那两行（含开栏自己的换行）隐形。
      expect(visible(span), '粗 码\u0001\u0001x\u0001');
    });

    testWidgets('样例消息：标题 + 表格 + 引用 + 链接 + 水平线 + 嵌套列表 一起过', (tester) async {
      const source = '# 今日\n\n'
          '| 项 | 值 |\n| :-- | --: |\n| 鱼 | 3 |\n\n'
          '> 引用一句\n\n'
          '见 [文档](https://a.b/c)\n\n'
          '---\n\n'
          '- 甲\n  - 甲一\n';
      final span = await render(tester, source);
      // 表格块换成控件、其余逐字上屏；文本那条路一个字节不少（对账过了）
      expect(show(span), expectedDisplay(source));
      expect(flatten(markdownPlainSpan(source)), source);
      expect(tester.takeException(), isNull);
      expect(hidden(span).any((text) => text.contains('#')), isTrue);
      expect(hidden(span).any((text) => text.contains('>')), isTrue);
      // 表格的分隔行不在树里了（它换成了控件）；这里的 `---` 是那条**水平线**：
      // 它是正文层的记号，照旧活着（标题/引用/列表/水平线这一批一条都没变）。
      expect(hidden(span).any((text) => text.contains('---')), isTrue);
      expect(find.byType(Table), findsOneWidget);
      expect(pipeGlyphs(), 0, reason: '表格区那些竖线不显示；这一条里也没有字面的管道');
    });

    testWidgets('末尾换行照旧属于原文（复制出去不许少）', (tester) async {
      const source = '结尾有个换行\n';
      expect(flatten(await render(tester, source)), source);
    });
  });

  // ─────────────────────────── 记号在树里活着 ───────────────────────────

  group('记号的隐藏方式', () {
    testWidgets('隐藏记号是"字号 0"，不是被删掉——所以复制出去还有 **', (tester) async {
      final span = await render(tester, '**粗体**');
      expect(hidden(span), ['**', '**']);
      expect(flatten(span), '**粗体**');
    });

    testWidgets('只有表格块会换成 WidgetSpan：别处一个都不许有', (tester) async {
      // 这一条上一版叫"树里不许出现 WidgetSpan"——那时表格还是文字，占位符是纯粹的差错。
      // 这一版表格**必须**是 WidgetSpan（真网格），所以判据收紧成两条：
      //   没有表格块的来源：一个 WidgetSpan 都不许有（`flatten` 会在 WidgetSpan 上当场失败）；
      //   表格块：恰好一个，位置对得上（`show` 与 `expectedDisplay` 已经钉住）。
      for (final source in const [
        '**a**',
        '```\nx\n```',
        '- a',
        '<t x="1"/>',
        '# 标题',
        '| a | b |\n| --- | --- | --- |\n| 1 | 2 |', // 坏结构：也不许有
        '> 引用',
        '[链接](http://x)',
        '甲\n---',
      ]) {
        expect(markdownTableRanges(source), isEmpty, reason: '$source 里没有表格块');
        final span = await render(tester, source);
        expect(() => flatten(span), returnsNormally, reason: '$source：不该出现 WidgetSpan');
        expect(find.byType(Table), findsNothing);
      }
      // 表格块：恰好一个 WidgetSpan（`flatten` 会在它上面失败——这就是"有一个"的证据）
      final table = await render(tester, '| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(() => flatten(table), throwsA(isA<TestFailure>()));
      expect(show(table), '\uFFFC');
    });
  });

  // ────────────────── ④ 复制得到的必须是原文（消息级入口） ──────────────────

  group('④ 复制得到的必须是原文（消息级「复制原文」）', () {
    /// 剪贴板替身：把 `Clipboard.setData` 写进来的字符串按顺序记下来。
    List<String> clipboard(WidgetTester tester) {
      final written = <String>[];
      tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          written.add((call.arguments as Map)['text'] as String);
        }
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));
      return written;
    }

    /// 在消息正文上右键，点菜单里那一项（返回时剪贴板已经写完、toast 正在上屏）。
    Future<void> copyViaMenu(WidgetTester tester) async {
      await tester.tap(find.byType(SelectableText), buttons: kSecondaryButton);
      await tester.pumpAndSettle();
      expect(find.text(markdownCopySourceLabel), findsOneWidget, reason: '菜单里必须有这一项');
      await tester.tap(find.text(markdownCopySourceLabel));
      await tester.pumpAndSettle();
    }

    /// 让 toast 自己走完（4 秒），别把定时器留给下一个用例。
    Future<void> settleToast(WidgetTester tester) async {
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    }

    testWidgets('菜单里那一项写进剪贴板的 == 源串（真实那条含表格的消息）', (tester) async {
      final written = clipboard(tester);
      final span = await render(tester, diskChecklist);

      // 先钉住"为什么需要这个入口"：显示层已经不是原文了（表格块成了一个占位符）
      expect(show(span), isNot(diskChecklist));
      expect(show(span), contains('\uFFFC'));
      expect(pipeGlyphs(), 0, reason: '表格区那些竖线一个都不显示');
      expect(find.byType(Table), findsOneWidget);

      await copyViaMenu(tester);

      expect(written, [diskChecklist], reason: '写进剪贴板的必须逐字节等于她写的源串');
      // 逐字节的证据：管道与分隔行都在（含 `|---|---|---|` 这种不带空格的写法）
      expect(written.single.contains('| 项 | 大小 | 说明 |'), isTrue);
      expect(written.single.contains('|---|---|---|'), isTrue);
      expect(written.single.endsWith('| E 盘 | 512 GB | 备份盘 |\n'), isTrue);
      expect(find.text(markdownCopySourceToast), findsOneWidget, reason: '复制要有反馈');
      await settleToast(tester);
      expect(find.text(markdownCopySourceToast), findsNothing, reason: '提示自己会走');
    });

    testWidgets('没有表格的消息也走同一个入口（它是消息级的，不是表格专有）', (tester) async {
      final written = clipboard(tester);
      const source = '**收到**，`/reset` 之后再看：\n- 甲\n- 乙\n';
      await render(tester, source);
      await copyViaMenu(tester);
      expect(written, [source], reason: '没有表格时同样是逐字节的源串');
      await settleToast(tester);
    });

    testWidgets('CRLF 也不动它（规范化只是版面口径，复制走原文）', (tester) async {
      final written = clipboard(tester);
      const source = '第一行\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n';
      await render(tester, source);
      // 版面上 CRLF 按 LF 排版（行尾那个 `\r` 是 Windows 的产物，不是她写的字）
      expect(markdownTableRanges(source).length, 1);
      await copyViaMenu(tester);
      expect(written, [source], reason: '复制这条路上一个字节都不许动——连 CRLF 都不动');
      await settleToast(tester);
    });

    testWidgets('selectable: false 的卡片上没有这个入口（它挂在选中工具条上）', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: IrmiaTheme.light(),
        home: const Scaffold(body: MarkdownText(diskChecklist, selectable: false)),
      ));
      await tester.pump();
      expect(find.byType(SelectableText), findsNothing);
      // 网格照画（表格与"能不能选中"是两件事）；但没有工具条就没有那个入口
      expect(find.byType(Table), findsOneWidget);
      expect(find.text(markdownCopySourceLabel), findsNothing);
    });
  });

  // ─────────────────────────── 上屏（widget 层） ───────────────────────────

  group('上屏：MarkdownText 的纯文本（没有表格块时逐字 == 源串）', () {
    testWidgets('RichText 的纯文本 == 源串；版面上不再有字面的 **', (tester) async {
      // **没有表格块**的消息：选中复制拿到的就是原文——这一条没有放宽。
      const source = '**收到**，`/reset` 之后再看：\n- 甲\n- 乙\n\n[@1 号] 别急……';
      final span = await render(tester, source);
      expect(span.toPlainText(), source, reason: '选中复制拿到的就是原文');
      expect(visible(span), isNot(contains('**')));
      expect(visible(span), isNot(contains('`')));
    });

    testWidgets('有表格块的消息：纯文本里是占位符——所以入口是「复制原文」', (tester) async {
      final span = await render(tester, diskChecklist);
      expect(span.toPlainText().contains('\uFFFC'), isTrue,
          reason: 'WidgetSpan 的占位符（真网格的代价，如实钉住）');
      expect(span.toPlainText(), isNot(diskChecklist));
      // 原文一个字节没丢：它只是不在这棵树里了
      expect(flatten(markdownPlainSpan(diskChecklist)), diskChecklist);
    });

    testWidgets('selectable: false 时不挂 SelectableText', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: IrmiaTheme.light(),
        home: const Scaffold(body: MarkdownText('**a**', selectable: false)),
      ));
      await tester.pump();
      expect(find.byType(SelectableText), findsNothing);
      expect(find.byType(RichText), findsOneWidget);
    });

    testWidgets('selectable: true（默认）时可选中复制', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: IrmiaTheme.light(),
        home: const Scaffold(body: MarkdownText('**a**')),
      ));
      await tester.pump();
      expect(find.byType(SelectableText), findsOneWidget);
    });

    testWidgets('链接悬停：下方给出一行 URL，且它不进 span 树（不是原文）', (tester) async {
      const source = '见 [文档](https://a.b/c)';
      final span = await render(tester, source);
      expect(flatten(span), source, reason: '悬停提示不许混进原文');
      expect(find.text('https://a.b/c'), findsNothing, reason: '没悬停时不显示 URL');

      // 悬停到链接那一段文字上（屏幕坐标来自真实布局）。
      // 这里**不用 pumpAndSettle**：光标闪烁是个永不结束的动画，settle 会超时。
      final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await gesture.addPointer(location: Offset.zero);
      addTearDown(gesture.removePointer);
      final box = tester.getRect(find.byType(SelectableText));
      await gesture.moveTo(Offset(box.left + box.width / 2, box.top + box.height / 2));
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('https://a.b/c'), findsOneWidget, reason: '悬停时显示完整 URL');

      await gesture.moveTo(box.topLeft - const Offset(80, 80));
      await tester.pump(const Duration(milliseconds: 50));
      expect(find.text('https://a.b/c'), findsNothing, reason: '移开后提示要消失');
    });
  });
}
