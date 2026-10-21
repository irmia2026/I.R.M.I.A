// TODO(i18n): 本文件还有 4 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/markdown.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
/// 简单 MD 渲染 —— **只给"正文"用**：聊天气泡、"框架提醒"卡正文。
///
/// ## 支持范围（判据只有这一个文件）
///
/// 块级：
///   · ATX 标题 `#`…`######`（**`#` 后必须有一个空格**，`#标签` 不算标题）
///   · GFM 表格（表头行 + 分隔行 `---`/`:--`/`--:`/`:-:` + 数据行）——
///     **画成真的表格控件**（[Table]）：竖线一个都不显示、列由控件严格对齐
///   · 引用 `>`（最多两层；引用里照常解析标题/列表/行内——**表格只认顶层的**：
///     引用是逐行剥壳再解析的，一行凑不出"表头 + 分隔行"，所以引用里的管道按普通文字）
///   · 水平线 `---` / `***` / `___`（整行、至少三个，中间可有空格）
///   · 围栏代码块（``` 或 ~~~）
///   · 无序列表（`-` / `*` / `+`）与有序列表（`1.` / `1)`），**嵌套最多两层**
///   · 段落与换行
///
/// 行内：
///   · `**粗体**`、`*斜体*`、行内 `` `代码` ``
///   · 链接 `[文字](http://…)` —— **只上样式，当前不可点**（理由见下）
///
/// **不做**：图片、HTML、脚注、任务列表、定义列表、下划线强调（`_斜_` 按普通文字），
/// 以及 **setext 标题**（一行文字下面跟一行 `===` / `---`）。
/// 它们一律按普通文字原样显示——少做一样只是少一样，做错一样是把她的话改掉了。
///
/// ### 为什么 setext 标题不做（这是一个决定，不是漏了）
///
/// setext 的 `---` 与**水平线**、与**表格分隔行**、与**列表记号**是同一个记号形状：
/// `甲\n---` 到底是"甲 是一级标题"还是"甲 后面一条水平线"？只能靠猜。
/// 而她写 `---` 时更多是当分割线用；**猜错一次就把一行正文吃成了标题**（那是改她的话）。
/// 所以：**整行 `---` 一律按水平线**，setext 形状按"一段正文 + 一条水平线"处理。
/// 这个行为在测试里被钉死（`___` 同理——它是水平线，不是下划线强调）。
///
/// ### 链接为什么不可点
///
/// 打开 URL 要 `url_launcher`，仓库里没有这个依赖，而**这一批不许引新依赖**。
/// 于是只做"可辨识的链接样式"（主题 primary 色 + 下划线），并在**悬停**时于下方给出一行完整
/// URL（[MarkdownText] 里那一层 Column）——至少能看清它指向哪儿，然后自己复制。
/// **当前不可点**：点下去不会有任何事。这是已知缺口，不是渲染失败。
///
/// ## 四条纪律（每一条都有测试钉着）
///
/// ### ① 显示层**只许少、不许改**（表格块换成控件，其余逐字上屏）
///
/// 记号在版面上不占位置，但它们在 span 树里**一个字都不少**：强调记号、围栏行、
/// 标题的 `#`、引用的 `>`、水平线全部走 [markdownHiddenMarker]（字号 0）。
/// 于是把整棵 span 树的 text 拼起来 == 源串（[markdownPlainSpan] 的契约，测试
/// `纯文本那条路（markdownPlainSpan）逐字等于原文——一个字节都不少` 逐例钉住）。
///
/// **表格是一个例外，而且只有一个**（见下一节）：表格块在显示层换成**真的表格控件**
/// （[Table]），原文那一段（表头行、分隔行、数据行、行间换行）因此**不在 span 树里**——
/// 控件替它站在那里，纯文本里留下的是一个 `U+FFFC` 占位符（`WidgetSpan` 的定义）。
/// 表格块之外的每一个字符照旧逐字上屏。这条新契约由 [markdownTableRanges] 对账：
/// `显示层纯文本 == 源串里每个表格块换成一个 U+FFFC`，测试逐例钉住。
///
/// **表格块之外一个字符都不许多**：不插 `|`、不补空格凑列宽、不加零宽填充
/// （补出来的空白照样会被选中复制，那等于往她的话里塞东西）。
///
/// ### ② 表格是**真网格**：竖线一个都不显示、列严格对齐
///
/// 上一版拿"淡色竖线 + 隐形分隔行 + 等宽单元格"凑表格的样子，结果是**列并不对齐**——
/// 竖线跟着字宽飘，读起来不是网格。这一版改控件：`Table` 负责列，网格由控件给出。
///
/// 三条决定，都写在这里：
///   · **竖线不画**：`|` 是语法不是内容，它连同分隔行一起退出显示层；`Table` 的
///     边框只画表头下面那条横线，竖线一条都没有（`verticalInside` 保持 `none`）。
///   · **列宽走"内容自适应"**（[IntrinsicColumnWidth]）：每列宽度 = 该列所有格子里
///     最宽的那一格（不换行时的宽度）；总宽超过可用宽度时 `Table` 自己按比例收窄到
///     最小固有宽度（换行），所以既不溢出、也不用我手算。**不选均分**：真实的消息里
///     「项 / 大小 / 说明」三列长短差得远，均分会把「项」撑得和「说明」一样宽，
///     短列白占地方、长列频繁折行。
///   · **对齐照 GFM 的 `:` 标记**：`:--` 左、`:-:` 中、`--:` 右（[TextAlign] 落在格子的
///     [Text] 上；`Table` 给每个格子的是**紧宽度**约束，所以右对齐是真的贴到列右边）。
///
/// 顺带一句：列既已由控件保证对齐，格子就不再需要等宽字体来"凑齐"了——但字体/配色
/// **原样不动**（那一档是另一处的取舍，不在这批里顺手改）。
///
/// ### ③ 复制得到的必须是原文——入口是**消息级的「复制原文」**
///
/// 表格块换了控件之后，**选中复制拿到的已经不是原文了**（表格那段变成一个 `U+FFFC`）。
/// 这条纪律不能就这么丢掉：所以 [MarkdownText] 在消息本身上挂了一个**显式入口**——
/// 在消息正文上右键（或长按、或选中后弹工具条）→ 菜单里那一项
/// 「[markdownCopySourceLabel]」→ 写进剪贴板的是 [MarkdownText.source] **本身**，
/// 一个字节都不动（连 CRLF 都不做规范化：规范化只是版面口径）。
/// 测试 `复制原文入口：菜单里那一项写进剪贴板的 == 源串` 用真实那条含表格的消息钉住。
///
/// 为什么不"另存一份原文给复制用、面板上给渲染结果"：那样面板上是 A、剪贴板是 B，
/// 两者一旦分叉（比如换行、空格的差别），人复制回去的东西就不是他看到的——不可对账。
/// 现在两者的关系是**算得出来的**（[markdownTableRanges]），不是"应该差不多"。
///
/// ### ④ 规则外的符号**原样显示**
///
/// 她的消息里有大量 `[@1 号]`、`<qqbot-at-user …/>`、省略号、`C#`、`a | b` 这类形状。
/// 解析器**只认上面那几样**，认不出的字符走普通文字那条路，一个字节都不动
/// （测试 `记号之外原样显示` 逐例钉住）。**特别地 `a | b` 不是表格**（没有分隔行）、
/// **`#标签` 不是标题**（`#` 后没有空格）、**`C#` 里的 `#` 什么都不是**。
///
/// ### ⑤ 渲染失败 / 未闭合的标记 → 当普通文字
///
/// `**未闭合`、`` ` ``、`***`、`| a | b |`（只有一行）、`[不是链接](no-scheme)`、
/// 分隔行列数与表头不符、`>` 后面什么都没有……一律退化成字面文字，**不吞、不猜、不报错**
/// （测试 `未闭合与歧义记号的退化` 逐例钉住）。
///
/// 退化时**一个控件都不出现**：坏结构走的是普通文字那条路，屏幕上连 `Table` 都没有——
/// 这时"选中复制"拿到的仍然是原文（与表格块相反的那一半，测试 `坏结构里不出现任何控件`）。
///
/// ## 不改变文本的边界（如实说）
///
/// 唯一的规范化是 **CRLF → LF**（`\r\n` 与单独的 `\r`）：行尾那个 `\r` 是 Windows 文本的
/// 产物，不是她写的字；留着它会让每行末尾多一个不可见的控制字符。除此之外**没有任何**
/// 去空格、合并空白、补标点、裁掉行尾 `#`（`## 标题 ##` 的那两个 `##` 照旧是可见文字）。
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'ui_kit.dart';

/// 记号（`**`、反引号、围栏行、标题的 `#`、引用的 `>`、水平线）用这个样式：
/// **字号 0**，所以版面上看不见、也不占宽。
///
/// 这是纪律 ① 的实现手段：记号必须在 span 树里活着（否则复制出去就少了 `**`），
/// 又不能出现在版面上。字号 0 是唯一同时满足这两条的做法——`WidgetSpan` 会往
/// 纯文本里塞占位符（`\uFFFC`），那是**改文本**。
///
/// **唯一的例外是表格块**（它换成了控件，见文件头纪律 ②/③）。它只用在
/// "源串里本来就有的记号"上，绝不用于补出来的填充。
const TextStyle markdownHiddenMarker = TextStyle(fontSize: 0, height: 0, letterSpacing: 0);

/// 消息级「复制原文」那一项的**文案**（界面与用例共用一份，措辞不许分叉）。
///
/// 它挂在消息正文的右键/长按菜单里，复制的是 [MarkdownText.source] **本身**——
/// 表格块换了控件之后，这是"复制 == 原文"这条纪律唯一的入口（文件头纪律 ③）。
const String markdownCopySourceLabel = '复制原文';

/// 复制成功后的那一句反馈（走全站唯一那条 toast，纯文本——别在这里写记号）。
const String markdownCopySourceToast = '原文已复制';

/// 文本规范化：只做 CRLF → LF（理由见文件头"不改变文本的边界"）。
String normalizeMarkdownSource(String source) =>
    source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

/// 表格块在**规范化之后**的源串里占的字符区间 `[start, end)`，按出现顺序。
///
/// **只给"对账"用**（测试与排障），不是上屏路径的一部分。它的用处是让纪律 ③ 变成
/// 一条算得出来的等式：显示层的纯文本 == 源串里每一段这样的区间换成一个 `U+FFFC`
/// （见 [markdownTextSpan]）。区间含表头行、分隔行、数据行与**行间**的换行；
/// 落在最后一行上的换行只有当表格就是文档最后一段时才算进来（理由见
/// [_MarkdownTableGrid]：占位符后面孤零零一个换行会被排版算成又一个占位符那么高）。
List<(int, int)> markdownTableRanges(String source) {
  final lexer = _Lexer(normalizeMarkdownSource(source));
  lexer.parse();
  return lexer.tableRanges();
}

/// 文本 → 无样式的 span 树（整棵树的 text 拼起来 == 规范化后的源串）。
///
/// **这条路没有表格控件**：表格块在这里仍然是它自己那几行字符（含 `|`、含分隔行），
/// 所以它是"原文那一层"的对照物——上屏请用 [markdownTextSpan]，要原文请用
/// 「[markdownCopySourceLabel]」那个入口。
TextSpan markdownPlainSpan(String source) => _render(_Lexer(normalizeMarkdownSource(source)).parse());

/// 文本 → 带样式的 span 树（**上屏用这个**）。
///
/// 契约（纪律 ①）：**表格块之外**的每一个字符逐字上屏（记号走字号 0），
/// 每个表格块换成一个 [WidgetSpan]（纯文本里因此是一个 `U+FFFC`）。
/// 于是 `显示层纯文本 == 源串里每个表格块换成一个 U+FFFC`——对账用 [markdownTableRanges]。
///
/// [base] 是正文字号/行高/颜色；记号之外的样式全部由它派生（粗体叠在它上面、标题按比例放大），
/// 所以调用方只给一次正文样式，渲染器不自己发明字号。
///
/// [onLinkEnter] / [onLinkExit]：链接的悬停回调（气泡用它把完整 URL 显示在下方）。
/// 它们**不改文本**——回调只在画的时候挂着。
TextSpan markdownTextSpan(
  BuildContext context,
  String source, {
  TextStyle? base,
  void Function(String url)? onLinkEnter,
  VoidCallback? onLinkExit,
}) {
  final normalized = normalizeMarkdownSource(source);
  final lexer = _Lexer(normalized);
  final runs = lexer.parse();
  assert(
    runs.map((run) => run.text).join() == normalized,
    'run 流拼起来必须逐字等于源串（纪律 ①）——这是渲染器的第一不变量',
  );
  final style = _ThemeStyle(context, base);
  final children = <InlineSpan>[];
  var at = 0;
  for (final block in lexer.tables) {
    while (at < block.start) {
      children.add(_spanOf(runs[at], style, onLinkEnter, onLinkExit));
      at += 1;
    }
    // 表格那一段字符不进 span 树：这个位置换成控件（占位符 U+FFFC 由它带出来）。
    children.add(WidgetSpan(
      alignment: PlaceholderAlignment.top,
      child: _MarkdownTableGrid(block: block, base: base),
    ));
    at = block.end;
  }
  while (at < runs.length) {
    children.add(_spanOf(runs[at], style, onLinkEnter, onLinkExit));
    at += 1;
  }
  assert(
    _partitionsSource(runs, lexer.tables, normalized.length),
    '表格块与非表格部分必须不重不漏地拼成整篇源串（纪律 ①）',
  );
  return TextSpan(text: '', children: children);
}

/// 一个 run → 一个 span（记号走字号 0，链接的两半挂悬停回调）。
TextSpan _spanOf(
  _Run run,
  _Style style,
  void Function(String url)? onLinkEnter,
  VoidCallback? onLinkExit,
) =>
    TextSpan(
      text: run.text,
      style: style.of(run),
      onEnter: _isLinkPart(run.role) && onLinkEnter != null ? (_) => onLinkEnter(run.text) : null,
      onExit: _isLinkPart(run.role) && onLinkExit != null ? (_) => onLinkExit() : null,
    );

/// 表格块与非表格部分是否**恰好**把源串分成两半（长度守恒 + 块区间不重叠且有序）。
bool _partitionsSource(List<_Run> runs, List<_TableBlock> blocks, int sourceLength) {
  var outside = 0;
  var inside = 0;
  var at = 0;
  for (final block in blocks) {
    if (block.start < at || block.end < block.start || block.end > runs.length) return false;
    while (at < block.start) {
      outside += runs[at].text.length;
      at += 1;
    }
    for (var k = block.start; k < block.end; k++) {
      inside += runs[k].text.length;
    }
    at = block.end;
  }
  while (at < runs.length) {
    outside += runs[at].text.length;
    at += 1;
  }
  return outside + inside == sourceLength;
}

/// 表格网格：**真的 [Table] 控件**——竖线一条都不画、列由控件严格对齐。
///
/// 每格文字来自**同一次解析**里的 run（[_TableBlock.rows]），所以格子里的字与
/// "文本那条路"里的字是同一份，不会各解析一遍再对不上。
/// 格首尾的空白是原文里的排版留白（`| 名 |` 两边各一个空格），上屏前裁掉——
/// 裁掉的是空白，不是字。
///
/// ### 为什么末尾那个换行要并进块里（实测出来的一条排版账）
///
/// `WidgetSpan` 是行内对象：它占一行，行高就是控件的高度。但**如果它后面只剩一个
/// 换行、然后整段就结束了**，那个"空行"会被算成**占位符那么高**——表格下面凭空多出
/// 一整块和表格一样高的空白。实测（3.35.4，`Text('前\n') + 占位符 100 高`）：
///
///   · `前\n[占位符]`        → 129（= 文字一行 + 占位符那一行，对）
///   · `前\n[占位符]\n`      → 238（**多出整整一个占位符**，就是这一条）
///   · `前\n[占位符]\n\n`    → 169（两个换行反而正常：一个收尾、一个真的是空行）
///   · `前\n[占位符]\n后`    → 149（后面有字也正常）
///
/// 所以只有"表格正好是最后一段、源串以那一个换行收尾"这一种形状要处理：
/// 把那个换行并进表格块（它本来就是这一行的行尾），版面因此与上面第一行一致。
/// 并进去之后，显示层里表格块后面**没有**任何字符——[markdownTableRanges] 报的区间
/// 也相应地含这个换行（区间口径 = 块自己那一整段）。
class _MarkdownTableGrid extends StatelessWidget {
  const _MarkdownTableGrid({required this.block, this.base});

  final _TableBlock block;
  final TextStyle? base;

  /// 格子内边距：竖线没了之后，格子之间靠这个留出呼吸（也给表头那条横线留高度）。
  static const EdgeInsets _cellPadding = EdgeInsets.symmetric(horizontal: 10, vertical: 4);

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final style = _ThemeStyle(context, base);
    return Table(
      // 列宽 = 内容自适应（理由见文件头纪律 ②）。
      defaultColumnWidth: const IntrinsicColumnWidth(),
      defaultVerticalAlignment: TableCellVerticalAlignment.middle,
      // **一条线都不画**：TableBorder 六条边默认全是 BorderSide.none——竖线当然没有，
      // 横线也不画（行与行之间的分隔线用户没要，多一条就是多一层装修）。
      // 表头那一条横线单独给（见下面 header 那一行的 decoration）：它是 GFM 的分隔行
      // 在版面上的等价物，没有它表头与数据行就分不开了。
      border: const TableBorder(),
      children: [
        for (final row in block.rows)
          TableRow(
            // 表头下面那一条横线。用 TableRow.decoration 而不是 TableBorder.horizontalInside：
            // 后者会在**每一对**相邻行之间都画一条。
            decoration: row.header
                ? BoxDecoration(
                    border: Border(
                      bottom: BorderSide(color: scheme.outlineVariant, width: 1),
                    ),
                  )
                : null,
            children: [
              for (var c = 0; c < row.cells.length; c++)
                Padding(
                  padding: _cellPadding,
                  child: Text.rich(
                    TextSpan(
                      text: '',
                      children: [
                        for (final run in row.cells[c])
                          TextSpan(text: run.text, style: style.of(run)),
                      ],
                    ),
                    // `:` 对齐标记：格子拿到的是**紧宽度**约束（Table 定的列宽），
                    // 所以右对齐是真的贴到这一列的右边。
                    textAlign: block.aligns[c],
                  ),
                ),
            ],
          ),
      ],
    );
  }
}

/// 无样式那条路：[markdownPlainSpan] 用。不做任何颜色/字号，记号仍然字号 0。
/// **表格不走控件**（它就是原文那几行字符），所以这条路逐字等于源串。
TextSpan _render(List<_Run> runs) => TextSpan(
      text: '',
      children: [
        for (final run in runs)
          TextSpan(text: run.text, style: _hidden(run.role) ? markdownHiddenMarker : null),
      ],
    );

/// 正文渲染件：段落 / 标题 / **表格网格** / 引用 / 水平线 / 列表 / 代码块 + 行内元素。
///
/// 两件事是这一版新加的，都在这个件上：
///   · 可选中复制（[selectable]）；
///   · **消息级的「[markdownCopySourceLabel]」入口**：在正文上右键（选中后弹的那条工具条
///     也一样）→ 菜单里那一项 → 写进剪贴板的是 [source] **本身**（逐字节，连 CRLF 都不动）。
///     表格块换了控件之后，这是"复制 == 原文"唯一的入口（纪律 ③）。
///
/// 链接悬停时在下方给出一行完整 URL（灰色小字、**不可选中**——它只是提示，不是原文的一部分，
/// 别混进复制里）。这一行只在悬停期间存在。
class MarkdownText extends StatefulWidget {
  const MarkdownText(
    this.source, {
    super.key,
    this.base,
    this.selectable = true,
  });

  final String source;

  /// 正文字号 / 行高 / 颜色。null = 继承环境（气泡里那几种字号都是显式给的）。
  final TextStyle? base;

  /// 可选中复制（气泡要，卡片里无所谓但也不碍事）。
  ///
  /// **关掉它就等于关掉「[markdownCopySourceLabel]」**：入口挂在选中工具条上，
  /// 而不可选中的 `Text.rich` 没有工具条。
  final bool selectable;

  @override
  State<MarkdownText> createState() => _MarkdownTextState();
}

class _MarkdownTextState extends State<MarkdownText> {
  /// 当前悬停的链接 URL；null = 没悬停在任何链接上。
  String? _hovered;

  void _hover(String? url) {
    if (_hovered == url) return;
    setState(() => _hovered = url);
  }

  /// 「[markdownCopySourceLabel]」按下去做的事：把 [MarkdownText.source] 逐字节写进剪贴板。
  ///
  /// **不做任何规范化**（不 CRLF→LF、不去首尾空白、不补换行）：渲染层的规范化只是版面口径，
  /// 复制这条路上动一个字节，"复制 == 原文"就没了意义。
  void _copySource(BuildContext context) {
    Clipboard.setData(ClipboardData(text: widget.source));
    // 反馈走全站唯一那条 toast（不然按下去像什么都没发生）。
    IrmiaToast.show(context, markdownCopySourceToast, kind: ToastKind.success);
  }

  /// 选中工具条：**系统那几项 + 我们自己那一项**。
  ///
  /// 挂在 `contextMenuBuilder` 上而不是外面再包一层手势件：右键/长按的事件先被
  /// `SelectableText` 自己吃掉（它是文本选择的那一层），外面包一层抢不到。
  Widget _toolbar(BuildContext context, EditableTextState state) {
    return AdaptiveTextSelectionToolbar.buttonItems(
      anchors: state.contextMenuAnchors,
      buttonItems: [
        // 排在最前：它是消息级的动作，别让它排在一串系统项后面被忽略。
        ContextMenuButtonItem(
          label: markdownCopySourceLabel,
          onPressed: () {
            state.hideToolbar();
            _copySource(context);
          },
        ),
        ...state.contextMenuButtonItems,
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    // 链接的 onEnter/onExit 是 span 自带的回调（TextSpan 本身就是 MouseTrackerAnnotation）：
    // 悬停只多画一行提示，**span 树一个字都不变**（也不引任何依赖）。
    final span = markdownTextSpan(
      context,
      widget.source,
      base: widget.base,
      onLinkEnter: _hover,
      onLinkExit: () => _hover(null),
    );
    final text = widget.selectable
        ? SelectableText.rich(span, contextMenuBuilder: _toolbar)
        : Text.rich(span);
    final hovered = _hovered;
    if (hovered == null) return text;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        text,
        Padding(
          padding: const EdgeInsets.only(top: 2),
          child: Text(
            hovered,
            style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }
}

// ──────────────────────────── run：文本与样式的两层模型 ────────────────────────────

/// 一个 run = 源串里**连续的一段原文字符** + 它该怎么画。
///
/// 为什么分成两层而不是直接建 span 树：纪律 ① 要的是**每一个输入字符恰好出现一次**。
/// run 是这条性质的最小载体——解析器只按顺序把"吃掉的原文"交出来，拼回去就是源串
/// （[markdownTextSpan] 里那句 assert 在钉这一条）。样式是 run 的属性，改样式改不动文本。
class _Run {
  const _Run(this.text, {this.role = _Role.normal, this.decoration = const _Decoration()});

  final String text;
  final _Role role;
  final _Decoration decoration;
}

/// run 的角色：样式表按它取 TextStyle。
enum _Role {
  /// 正文：段落、引用、列表项正文，以及记号之外的一切原样文字
  normal,

  /// 覆盖在**源串字符**上的记号（`**`、围栏行、表格分隔行、`#`、引用的 `>`、水平线）：
  /// 版面上不显示，但**复制选中时它们还在**（字号 0 只影响版面，不影响文本）。
  marker,

  /// **这个渲染器永远不发这个 role**（表格不补对齐填充，见文件头纪律 ①）。
  /// 留着它是**防御位**：万一以后有人想补填充，[_hidden] 会把它两条路都按"不显示"处理，
  /// 而"字符多了"这件事仍然会被纪律 ① 的测试当场抓住。
  padding,

  /// 行内代码 / 代码块正文（等宽 + 淡底）
  code,

  /// 列表记号（看得见——它就是列表的样子；比正文淡，第二层更小）
  listMarker,

  /// 表格竖线 `|` —— **只在"文本那条路"（[markdownPlainSpan]）上出现**：
  /// 上屏那条路把整个表格块换成了控件，管道根本不进 span 树（它是语法，不是内容）。
  /// 留着这个 role 是因为 run 流仍要逐字拼回原文（纪律 ①）。
  tablePipe,

  /// 表格单元格里的文字（等宽，格子之间才读得成列）
  tableCell,

  /// 表格表头里的文字（等宽 + 加粗 + 放大一点）
  tableHeader,

  /// 链接的**标签**（可见，就是"文档"那两个字）
  link,

  /// 链接的**地址**（版面上紧跟在标签后面、比正文淡一档；悬停时它更亮）。
  ///
  /// 为什么地址在版面上也占位置：`[文字](url)` 里 `[]()` 不占版面，若把地址也藏起来，
  /// 屏幕上就只剩"文字"，看不出它是个链接（这一批**不可点**，认出来全靠看得见）。
  /// 它比标签淡，所以读起来仍是"文档"两个字在领。
  linkUrl,

  /// 标题文字（按级别放大）
  heading,
}

/// 版面上不显示的角色（记号与对齐填充）。**两条路（带样式/纯文本）必须一致**——
/// 少了这一条，纯文本那条路会把填充空白当成可见文字（纪律 ① 的测试会当场抓住）。
bool _hidden(_Role role) => role == _Role.marker || role == _Role.padding;

/// 链接的两半（标签与地址）都要挂悬停回调。
bool _isLinkPart(_Role role) => role == _Role.link || role == _Role.linkUrl;

/// 行内/块级的叠加修饰（粗 / 斜 / 链接 / 字号缩放）。**只影响画出来的样子。**
class _Decoration {
  const _Decoration({this.bold = false, this.italic = false, this.link = false, this.scale = 1});

  final bool bold;
  final bool italic;

  /// 是不是链接标签内部（颜色与下划线从链接那一档来）。
  final bool link;

  /// 字号缩放（标题、表头用它把"放大"传给它内部的行内强调）。
  final double scale;

  _Decoration withBold() => _Decoration(bold: true, italic: italic, link: link, scale: scale);
  _Decoration withItalic() => _Decoration(bold: bold, italic: true, link: link, scale: scale);
  _Decoration withLink() => _Decoration(bold: bold, italic: italic, link: true, scale: scale);
  _Decoration withScale(double value) =>
      _Decoration(bold: bold, italic: italic, link: link, scale: value);
}

// ──────────────────────────────── 词法（块级 + 行内） ────────────────────────────────

/// 无序列表记号（`-`/`*`/`+`）或有序列表记号（1~9 位数字 + `.`/`)`），后面至少一个空格。
final RegExp _listMarker = RegExp(r'^([-*+]|[0-9]{1,9}[.)])([ \t]+)');

/// 围栏：``` 或 ~~~，三个以上，可跟语言名（```` ```dart ````）。
final RegExp _fenceOpen = RegExp(r'^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$');
final RegExp _fenceClose = RegExp(r'^[ \t]*(`{3,}|~{3,})[ \t]*$');

/// ATX 标题：`#`…`######` + **必须的空格** + 内容。`#标签`、`C#` 都不匹配（纪律 ②）。
final RegExp _heading = RegExp(r'^(#{1,6})([ \t]+)(.*)$');

/// 水平线：整行三个以上的 `-` / `*` / `_`（中间可有空格：`- - -` 也算）。
final RegExp _rule = RegExp(r'^([-*_])[ \t]*(\1[ \t]*){2,}[ \t]*$');

/// 引用记号：`>` 后面要么没有东西，要么一个空格/制表符（`>x` 不算引用）。
final RegExp _quote = RegExp(r'^([ \t]?)>([ \t]?)(.*)$');

/// 表格分隔行的**一格**：`---` / `:--` / `--:` / `:-:`。
final RegExp _delimCell = RegExp(r'^:?-+:?$');

/// 链接：`[标签](地址)`。标签里允许除 `]` 之外的任何东西，地址里不许有空白与括号。
final RegExp _link = RegExp(r'^\[([^\]]*)\]\(([^()\s]*)\)');

/// 有 scheme 的地址才算链接（`no-scheme` 这种形状按普通文字，纪律 ③）。
/// **不做"任何非空地址都算链接"**：那会把 `[查看](见上)` 这种顺手写的东西渲染成链接。
final RegExp _urlScheme = RegExp(r'^[A-Za-z][A-Za-z0-9+.-]*://');

/// 词法器：拿规范化之后的整篇文本，吐一串 [_Run]。
///
/// **唯一的全局不变量**：把返回的 run 的 text 按顺序拼起来 == 输入文本（[markdownTextSpan]
/// 里断言它）。"当前在解析哪几行"只有 [_lines] 一处（引用会临时换掉它，见 [_quoted]），
/// 换行永远由"产出那一行内容的人"在最后一个 run 之后补（[advance]）——
/// 这就是上一轮踩过的坑：按块发边界、事后收敛，在 `- 甲\n- 乙` 上必错。
///
/// 表格那一段同时记进 [tables]（run 下标 + 每格的 run）：**上屏的网格就从这里取字**，
/// 不再另解析一遍（两份解析迟早对不上）。run 流本身照旧是完整的原文——
/// [markdownPlainSpan] 那条路一个字都不少。
class _Lexer {
  _Lexer(this.source) : _lines = source.split('\n');

  final String source;

  /// 当前正在解析的行表（整篇，或引用里被剥掉 `>` 之后的那几行）。
  /// 引用会临时换掉它再还回来——它是"当前在解析什么"的唯一定义。
  List<String> _lines;

  /// 引用深度（0 = 不在引用里）。最多两层。
  int _quoteDepth = 0;

  /// 引用里的行内文字要斜体——这是**版面**上的修饰，与文本无关。
  _Decoration _quoteDecoration = const _Decoration();

  /// 解析出来的表格块（按出现顺序）。
  final List<_TableBlock> tables = <_TableBlock>[];

  /// 最近一次 [parse] 的 run 流（[tableRanges] 把 run 下标换成字符下标要用它）。
  List<_Run>? _parsed;

  /// 全篇行数（判"这是不是最后一行"用）。
  int get _total => _lines.length;

  String line(int i) => _lines[i];
  bool isLast(int i) => i == _total - 1;
  String endOf(int i) => isLast(i) ? '' : '\n';

  /// 换行 run：**只有源串里真有那个换行时才发**（最后一行没有）。
  void advance(List<_Run> out, int i) {
    if (isLast(i)) return;
    out.add(const _Run('\n'));
  }

  /// 表格块在源串里占的字符区间（**先调 [parse]**）：run 下标 → 字符下标。
  List<(int, int)> tableRanges() {
    final runs = _parsed;
    if (runs == null) return const <(int, int)>[];
    final offsets = <int>[];
    var at = 0;
    for (final run in runs) {
      offsets.add(at);
      at += run.text.length;
    }
    offsets.add(at); // 末尾哨兵：源串总长
    return [for (final block in tables) (offsets[block.start], offsets[block.end])];
  }

  List<_Run> parse() {
    final out = <_Run>[];
    _blocks(out);
    _parsed = out;
    return out;
  }

  /// 块级解析当前这一段。
  void _blocks(List<_Run> out) {
    var i = 0;
    while (i < _total) {
      final text = line(i);

      // ① 围栏代码块：开栏 + 内容 + 闭栏。
      //
      // 闭栏**缺失**时读到结尾仍然是代码块——未闭合的**围栏**是"代码块写到一半"，
      // 与未闭合的**强调**不是一回事：强调退化成文字只是少一层粗体，
      // 而把一段代码当正文渲染会把它的 `**` 也吃掉。两者取其轻。
      final open = _fenceOpen.firstMatch(text);
      if (open != null) {
        final fence = open.group(1)!;
        var j = i + 1;
        var closed = false;
        while (j < _total) {
          final close = _fenceClose.firstMatch(line(j));
          // 闭栏要同一种记号，且不短于开栏
          if (close != null &&
              close.group(1)![0] == fence[0] &&
              close.group(1)!.length >= fence.length) {
            closed = true;
            j += 1;
            break;
          }
          j += 1;
        }
        // 开栏那一行（含语言名）进纯文本但不占版面；闭栏那一行同理。
        //
        // 围栏行**连同它自己那个换行**一起隐掉：换行在版面上就是"断一行"，
        // 留着它代码块上下会各多一条空行（那是版面，不是她的原文）。
        // 代码块正文那个换行照旧可见——它是真的换行。
        out.add(_Run(text, role: _Role.marker));
        out.add(_Run(endOf(i), role: _Role.marker));
        for (var k = i + 1; k < j; k++) {
          final isClose = closed && k == j - 1;
          out.add(_Run(line(k), role: isClose ? _Role.marker : _Role.code));
          out.add(_Run(endOf(k), role: isClose ? _Role.marker : _Role.normal));
        }
        i = j;
        continue;
      }

      // ② GFM 表格：表头行 + 分隔行 + 数据行。
      //    判在标题/水平线之前：`| --- | --- |` 这种分隔行同时也是"整行三个短横"，
      //    但它首先是表格的一部分（是不是表格由"上一行是表头"决定）。
      final table = _readTable(i);
      if (table != null) {
        // 这一段字符（含行间的换行）在显示层换成表格控件，所以记下它在 run 流里的范围。
        final blockStart = out.length;
        var blockEnd = out.length;
        final views = <_TableView>[];
        for (var k = 0; k < table.rows.length; k++) {
          final row = table.rows[k];
          if (row.delimiter) {
            // 分隔行整行隐掉：它只是语法，不是内容——但字符一个不少地留着（纪律 ①）。
            // 它那个换行也隐掉（否则表头与数据行之间会空一行）：**这里已经把这一行的
            // 换行发完了**，所以下面 [advance] 只给非分隔行用。
            out.add(_Run(row.source, role: _Role.marker));
            out.add(_Run(endOf(i + k), role: _Role.marker));
            blockEnd = out.length;
          } else {
            // 上屏的格子就取这一次解析出来的 run（不再另解析一遍）。
            final cells = <List<_Run>>[];
            _rowRuns(row, out, cells);
            views.add(_TableView(row.header, cells));
            // 这一行的**换行不进块**：块换成一个控件之后，那一个换行就是控件与后面
            // 正文之间的断行（少了它表格会和下一段挤在同一行）。
            blockEnd = out.length;
            advance(out, i + k);
            // 唯一的例外：换行后面**什么都没有**（表格是最后一段，源串以这一个换行收尾）。
            // 那时这个换行必须算进块里——理由是一条实测出来的排版账，见
            // [_MarkdownTableGrid] 上面"为什么末尾那个换行要并进块里"。
            if (k == table.rows.length - 1 && i + k == _total - 2 && line(_total - 1).isEmpty) {
              blockEnd = out.length;
            }
          }
        }
        final columns = table.rows.first.split.cells.length;
        tables.add(_TableBlock(
          blockStart,
          blockEnd,
          _columnAligns(table.rows[1].split),
          _normalizeRows(views, columns),
        ));
        i = table.end;
        continue;
      }

      // ③ 空行：段落边界，也结束一段引用。空行自己那一个 '\n' 照发。
      if (text.trim().isEmpty) {
        out.add(_Run(text));
        advance(out, i);
        i += 1;
        continue;
      }

      // ④ 引用：`>` 之后**有东西**才算引用（`>` 单独一行 → 普通文字，纪律 ③）。
      //    只剥一层，剩下交给递归——于是 `> > x` 是"引用里的引用"，
      //    引用里的标题/表格/列表照常解析（同一个 [_blocks]）。
      if (_quoteDepth < 2) {
        final quoted = _stripQuote(text);
        if (quoted != null && quoted.trim().isNotEmpty) {
          var j = i;
          while (j < _total) {
            final q = _stripQuote(line(j));
            if (q == null || q.trim().isEmpty) break;
            j += 1;
          }
          // 引用记号（连同它后面那个空格）隐掉：不占版面，复制出去还在。
          // 整行（含 `>`）交给 [_quoted]——它自己会剥一层再解析，记号由它发。
          for (var k = i; k < j; k++) {
            _quoted(line(k), out);
            advance(out, k);
          }
          i = j;
          continue;
        }
      }

      // ⑤ ATX 标题：`#` 后必须有空格（`#标签` 不匹配 → 落到段落，纪律 ②）。
      //    行尾那一串 `#`（`## 标题 ##`）只当普通文字——裁掉它是改文本。
      final head = _heading.firstMatch(text);
      if (head != null && head.group(3)!.isNotEmpty) {
        out.add(_Run(head.group(1)!, role: _Role.marker));
        out.add(_Run(head.group(2)!, role: _Role.marker));
        _inline(
          head.group(3)!,
          out,
          _Decoration(scale: _headingScale(head.group(1)!.length)),
          _Role.heading,
        );
        advance(out, i);
        i += 1;
        continue;
      }

      // ⑥ 水平线。判在标题之后、列表之前：`---` / `- - -` / `***` / `___` 都是整行的线。
      //    setext 形状（上一行 + `---`）不认——见文件头"为什么 setext 标题不做"。
      if (_rule.hasMatch(text)) {
        out.add(_Run(text, role: _Role.marker));
        advance(out, i);
        i += 1;
        continue;
      }

      // ⑦ 列表项：一行一项。
      //    嵌套：缩进 2~5 列算第二层（缩进本身是原文，照旧可见，只是记号更小更淡）；
      //    缩进 ≥6 列（第三层及更深）整行按普通文字（纪律 ③）。
      final indent = _indentColumns(text);
      final marker = indent < 6 ? _listMarker.firstMatch(text.substring(indent)) : null;
      if (marker != null) {
        if (indent > 0) out.add(_Run(text.substring(0, indent)));
        out.add(_Run(
          marker.group(0)!,
          role: _Role.listMarker,
          decoration: _Decoration(scale: indent >= 2 ? 0.85 : 1),
        ));
        _inline(
          text.substring(indent + marker.group(0)!.length),
          out,
          _quoteDecoration,
          _Role.normal,
        );
        advance(out, i);
        i += 1;
        continue;
      }

      // ⑧ 普通行：段落（行内照常解析）。段落之间靠空行分开，不需要额外容器。
      _inline(text, out, _quoteDecoration, _Role.normal);
      advance(out, i);
      i += 1;
    }
  }

  /// 引用里那一行（**整行原文，含 `>`**）：自己剥一层记号再把剩下的递归成块。
  ///
  /// "剥一层"就是"引用里的内容也是一篇小文档"：于是引用里能放标题/表格/列表/行内，
  /// 而 `> > x`（引用里的引用）由第二层递归再剥一次——最多两层（[_quoteDepth]）。
  ///
  /// 换行不在这里发（引用行与它的内容在同一行源文本上，换行由外层 [_blocks] 补）。
  void _quoted(String line, List<_Run> out) {
    final inner = _stripQuote(line)!;
    // 记号（含它后面那个空格）隐掉：不占版面，复制出去还在
    out.add(_Run(line.substring(0, line.length - inner.length), role: _Role.marker));
    final savedLines = _lines;
    final savedDecoration = _quoteDecoration;
    // 引用里的内容 = 一篇小文档（**同一套块级规则**）：换一个行表再走一遍 [_blocks]。
    // 行表是唯一的"当前在解析什么"的状态，不必再对第二处偏移量。
    _lines = inner.split('\n');
    _quoteDepth += 1;
    // 引用块整体斜体（版面上看得出"这是引的一段"）：嵌套一层仍然只有这一档（不叠成两倍）
    _quoteDecoration = const _Decoration(italic: true);
    _blocks(out);
    _quoteDecoration = savedDecoration;
    _quoteDepth -= 1;
    _lines = savedLines;
  }

  // ──────────────────────────── 表格 ────────────────────────────

  /// 从段内第 [i] 行起试读一张表；不是表返回 null。
  ///
  /// 判据（三条都要成立，缺一条就整块按普通文字，纪律 ③）：
  ///   · 第 [i] 行含 `|`；
  ///   · 第 [i+1] 行是**分隔行**（每一格都是 `---`/`:--`/`--:`/`:-:`，且格数非零）；
  ///   · 分隔行的格数 == 表头行的格数。
  _Table? _readTable(int i) {
    if (i + 1 >= _total) return null;
    final headerLine = line(i);
    final delimLine = line(i + 1);
    if (!headerLine.contains('|')) return null;
    final header = _splitRow(headerLine);
    final delim = _splitRow(delimLine);
    if (header.isEmpty || delim.isEmpty) return null;
    if (header.cells.length != delim.cells.length) return null;
    if (!_delimiterShaped(delim)) return null;
    // 数据行：只要"含 |"就跟进来（格数少补空、多则并进最后一格——GFM 的做法）
    var j = i + 2;
    while (j < _total && line(j).contains('|')) {
      j += 1;
    }
    return _Table(i, j, [
      _TableRow(headerLine, header, header: true),
      _TableRow(delimLine, delim, delimiter: true),
      for (var k = i + 2; k < j; k++) _TableRow(line(k), _splitRow(line(k))),
    ]);
  }

  /// 一行表格变成 run：按 [_SplitRow] 那两样拼回去——**原文的每一个字符都在**，
  /// 顺序也一模一样（外框前空白 → 外框 `|` → 各格与格间的 `|` → 外框后空白）。
  ///
  /// 格内文本走行内解析（`**粗**`、`` `码` `` 照常）。
  ///
  /// [cells] 非空时，**同一份** run 顺手交给它一份：上屏的网格直接用它，
  /// 不再另解析一遍（格子的字与"文本那条路"的字因此**必然是同一份**）。
  /// **不补任何填充**：表格的形状由控件给出（列宽、对齐、表头那条横线），
  /// 不是往文本里加空白——见文件头纪律 ②。
  void _rowRuns(_TableRow row, List<_Run> out, [List<List<_Run>>? cells]) {
    final split = row.split;
    if (split.outsideLeading.isNotEmpty) out.add(_Run(split.outsideLeading));
    if (split.leadingPipe) out.add(const _Run('|', role: _Role.tablePipe));
    for (var c = 0; c < split.cells.length; c++) {
      if (c > 0) out.add(const _Run('|', role: _Role.tablePipe));
      final cell = split.cells[c];
      final body = cell.trim();
      // 格内前后的空白是原文的一部分（`| 名 |` 两边各一个空格），照样发出去
      final leading = cell.substring(0, cell.length - cell.trimLeft().length);
      final trailing = cell.substring(cell.trimRight().length);
      if (leading.isNotEmpty) out.add(_Run(leading));
      final bodyRuns = <_Run>[];
      if (body.isNotEmpty) {
        _inline(
          body,
          bodyRuns,
          row.header ? _Decoration(scale: _tableHeaderScale) : const _Decoration(),
          row.header ? _Role.tableHeader : _Role.tableCell,
        );
        out.addAll(bodyRuns);
      }
      // 上屏那一格 = 去掉格首尾空白之后的原文（空白是排版留白，不是字）
      cells?.add(bodyRuns);
      if (trailing.isNotEmpty) out.add(_Run(trailing));
    }
    if (split.trailingPipe) out.add(const _Run('|', role: _Role.tablePipe));
    if (split.outsideTrailing.isNotEmpty) out.add(_Run(split.outsideTrailing));
  }
}

/// 分隔行 → 每一列的对齐（GFM 的 `:` 标记：`:--` 左、`:-:` 中、`--:` 右）。
List<TextAlign> _columnAligns(_SplitRow delimiter) => [
      for (final cell in delimiter.cells)
        switch ((cell.trim().startsWith(':'), cell.trim().endsWith(':'))) {
          (true, true) => TextAlign.center,
          (false, true) => TextAlign.right,
          _ => TextAlign.left,
        },
    ];

/// 把每一行的格子数**对齐到列数**：少了补空格子，多了并进最后一格。
///
/// 为什么不是"多出来的丢掉"（GFM 的做法）：丢字就是改她的话。`Table` 又要求每行格数相同
/// （不等它会当场断言失败），所以只能是这两条路，取"并进最后一格"——
/// **不丢字、也不补出字来**（并进去的那两格之间不加分隔符：加一个空格也是补出来的字符）。
/// 少格子补的是**空**格子（原文里本来就没有那一段）。
List<_TableView> _normalizeRows(List<_TableView> rows, int columns) {
  if (columns <= 0) return const <_TableView>[];
  final out = <_TableView>[];
  for (final row in rows) {
    final cells = <List<_Run>>[];
    for (var c = 0; c < columns; c++) {
      cells.add(c < row.cells.length ? row.cells[c] : const <_Run>[]);
    }
    for (var c = columns; c < row.cells.length; c++) {
      cells[columns - 1] = <_Run>[...cells[columns - 1], ...row.cells[c]];
    }
    out.add(_TableView(row.header, cells));
  }
  return out;
}

/// 一张表：段内第 [start] 行到第 [end] 行（不含），[rows] 逐行对应。
class _Table {
  _Table(this.start, this.end, this.rows);
  final int start;
  final int end;
  final List<_TableRow> rows;
}

/// 一个表格块：它在 run 流里的范围 + **上屏要用的那一份**（列对齐 + 每行每格）。
///
/// [start] / [end] 是 run 下标（不是字符下标）：[start] 是表头行的第一个字符，
/// [end] 是最后一个数据行的最后一个字符——**通常不含**它后面那个换行（那个换行属于
/// 控件之后的正文流，是"表格与下一段之间的断行"）。唯一的例外是表格正好收尾那一种形状，
/// 见 [_MarkdownTableGrid] 上面那段（末尾孤零零一个换行会被排版算成又一个占位符那么高）。
/// 显示层把 `[start, end)` 这一段换成表格控件（[markdownTableRanges] 换成字符下标）。
class _TableBlock {
  _TableBlock(this.start, this.end, this.aligns, this.rows);

  final int start;
  final int end;

  /// 每一列的对齐（来自分隔行），长度 == 列数。
  final List<TextAlign> aligns;

  /// 表头行 + 数据行（分隔行不在里面：它是语法，不上屏）。
  final List<_TableView> rows;
}

/// 表格的一行的**上屏形态**：每格的 run（已做行内解析、已去掉格首尾空白）。
///
/// 它与 [_TableRow] 分开是因为同一行有两种用途：拼回原文（[_rowRuns] 往 run 流里写，
/// 一个字符不能少）与画网格（这里，只要"那一格的字"）。
class _TableView {
  _TableView(this.header, this.cells);

  /// 是不是表头行（加粗 + 放大一档 + 下面那条横线）。
  final bool header;

  /// 每格的 run，长度 == 列数（[_normalizeRows] 保证）。
  final List<List<_Run>> cells;
}

/// 表格的一行：原文 + 切好的**原始段**（段里的字符一个不多一个不少）。
class _TableRow {
  _TableRow(this.source, this.split, {this.delimiter = false, this.header = false});

  /// 原文（分隔行整行隐掉时要用它，于是连 `---` 的字符也一个不少）。
  final String source;

  /// 切好的段 + 两头的外框管道标记（[_splitRow]）。
  final _SplitRow split;

  /// 是不是分隔行（`| --- | :-: |`）。
  final bool delimiter;

  /// 是不是表头行（第一行）。
  final bool header;
}

/// 分隔行是不是"每一格都是 `---`/`:--`/`--:`/`:-:`"。
///
/// 注意 [_splitRow] 会给外框留一个**空段**（`| --- | --- |` → `['', ' --- ', ' --- ']`，
/// 且 [leadingPipe] 为真）：那个空段是外框，不是一格，**不能拿去当分隔格判**——
/// 不然 `| --- | --- |` 永远不是表格（第一格是空的，不匹配 `-+`）。
/// 所以外框那个空段单独跳过；其余的空段（`| --- |  |`）仍然算不合法（纪律 ③）。
bool _delimiterShaped(_SplitRow row) {
  for (final cell in row.cells) {
    if (!_delimCell.hasMatch(cell.trim())) return false;
  }
  return true;
}

/// 表格的一行的两种切法：
///   · [cells] —— **每一列的内容**（含该列前后的空白，一个字都不丢）：判"分隔行列数"用它；
///   · [runs] —— 把这一行**按原样**发成一串 token：先 [outsideLeading]（外框前的空白），
///     再 [cells] 用 `|` 连起来（[leadingPipe]/[trailingPipe] 决定两头那个 `|` 在不在），
///     最后 [outsideTrailing]（外框后的空白）。
///
/// 为什么切成这两样：**"这一段原文属于谁"是唯一的难点**，两种用途正好要两种切法。
/// [cells] 让"分隔行的每一格"判得干净（外框不是格），[runs] 让"拼回原文"变成
/// `外框前空白 + | + cell + | + cell + | + 外框后空白` 这种一眼能对上的形状——
/// 两头少一个 `|`、多一个 `|`，纪律 ① 的 assert 与测试会当场抓住。
class _SplitRow {
  const _SplitRow(this.cells, this.outsideLeading, this.outsideTrailing,
      {required this.leadingPipe, required this.trailingPipe});

  final List<String> cells;
  final String outsideLeading;
  final String outsideTrailing;
  final bool leadingPipe;
  final bool trailingPipe;

  /// 这一行是不是空的（没有任何格）。
  bool get isEmpty => cells.isEmpty;
}

/// 表格的一行 → [_SplitRow]。
///
/// 切法（GFM 的简化版，够用且不猜）：
///   · 首个 `|` 之前**只有空白** → 那是外框（`| a | b |`）：空白进 [outsideLeading]，
///     那个 `|` 记在 [leadingPipe]；
///   · 首个 `|` 之前有内容 → 那是第一格（`a | b`）；
///   · 末尾 `|` 之后只有空白 → 那是外框：那个 `|` 记在 [trailingPipe]，
///     空白进 [outsideTrailing]；
///   · `\|` 是转义的管道，不当分隔（**两个字符都留在格里**，一个字都不少）；
///   · 行内代码里的 `|` 不当分隔（`` `a|b` `` 是一格）。
///
/// 段内头的空白：`| 名 |` 的第一格是 `" 名 "`（含两边空白）→ 发 run 时头部空白照发，
/// 正文单独上样式。于是格内的缩进、外框的空白都一个字符不动。
_SplitRow _splitRow(String line) {
  // 外框前的空白：只在紧接着是 `|` 的时候才算"外框前的空白"
  var lead = 0;
  while (lead < line.length && (line[lead] == ' ' || line[lead] == '\t')) {
    lead += 1;
  }
  final leadingPipe = lead < line.length && line[lead] == '|';
  final outsideLeading = leadingPipe ? line.substring(0, lead) : '';
  final body = leadingPipe ? line.substring(lead + 1) : line;

  final cells = <String>[];
  final buf = StringBuffer();
  var i = 0;
  while (i < body.length) {
    final c = body[i];
    if (c == r'\' && i + 1 < body.length && body[i + 1] == '|') {
      buf.write(body.substring(i, i + 2));
      i += 2;
      continue;
    }
    if (c == '`') {
      final close = body.indexOf('`', i + 1);
      if (close > i) {
        buf.write(body.substring(i, close + 1));
        i = close + 1;
        continue;
      }
    }
    if (c == '|') {
      cells.add(buf.toString());
      buf.clear();
      i += 1;
      continue;
    }
    buf.write(c);
    i += 1;
  }
  var tail = buf.toString();
  // 末尾 `|` 之后只有空白 = 外框；否则那是最后一格
  var trailingPipe = false;
  var outsideTrailing = '';
  if (cells.isNotEmpty && tail.trim().isEmpty) {
    trailingPipe = true;
    outsideTrailing = tail;
  } else {
    cells.add(tail);
    tail = '';
  }
  return _SplitRow(
    cells,
    outsideLeading,
    outsideTrailing,
    leadingPipe: leadingPipe,
    trailingPipe: trailingPipe,
  );
}

// ──────────────────────────────── 行内解析 ────────────────────────────────

/// 行内解析：扫一遍 [text]，只切**真的闭合**的强调、行内代码与链接，其余一个字一个字照发。
///
/// 三条不变量（测试逐条钉）：
///   · 每个输入字符都恰好产出一次（记号也在，只是字号 0）；
///   · 顺序与输入一致；
///   · 认不出 / 未闭合的形状只是普通文字，绝不吞、绝不抛。
void _inline(String text, List<_Run> out, _Decoration decoration, _Role role) {
  final buf = StringBuffer();

  void flush() {
    if (buf.isEmpty) return;
    out.add(_Run(buf.toString(), role: role, decoration: decoration));
    buf.clear();
  }

  var i = 0;
  while (i < text.length) {
    final c = text.codeUnitAt(i);

    // ── 行内代码 `code`：内容**不再解析**（反引号里的 `**` 就是两个星号）
    if (c == 0x60 /* ` */) {
      final close = text.indexOf('`', i + 1);
      if (close > i) {
        flush();
        out.add(const _Run('`', role: _Role.marker));
        out.add(_Run(text.substring(i + 1, close), role: _Role.code, decoration: decoration));
        out.add(const _Run('`', role: _Role.marker));
        i = close + 1;
        continue;
      }
      buf.write(text[i]); // 没闭合：当普通文字（纪律 ③）
      i += 1;
      continue;
    }

    // ── 链接 `[标签](地址)`。
    //    **图片不做**：`![alt](url)` 整个按普通文字（`!` 后面那个 `[` 不是链接的开始）——
    //    Markdown 里 `!` 前缀是图片，本渲染器不渲染图片，那就连它的链接也别认，
    //    否则一半渲染一半不渲染，读起来比整句原样更怪。
    if (c == 0x5B /* [ */ && !_isImageBracket(text, i)) {
      final match = _link.firstMatch(text.substring(i));
      final url = match?.group(2);
      if (match != null && url != null && _urlScheme.hasMatch(url)) {
        flush();
        out.add(const _Run('[', role: _Role.marker));
        // 标签：颜色与下划线从链接那一档来（role 仍是本行的 role，强调照常叠加）
        _inline(match.group(1)!, out, decoration.withLink(), role);
        out.add(const _Run(']', role: _Role.marker));
        out.add(const _Run('(', role: _Role.marker));
        out.add(_Run(url, role: _Role.linkUrl, decoration: decoration));
        out.add(const _Run(')', role: _Role.marker));
        i += match.group(0)!.length;
        continue;
      }
    }

    // ── 强调 `**粗**` / `*斜*`（下划线强调不做：`_斜_` 按普通文字，纪律 ②）
    if (c == 0x2A /* * */) {
      var run = 1;
      while (i + run < text.length && text.codeUnitAt(i + run) == 0x2A) {
        run += 1;
      }
      // 先试长子（粗体），再试单子（斜体）：`**a**` 不该被读成 `*` + `*a*` + `*`。
      // 都不成立时**整串星号**当普通文字发出去——`***`、`****` 就是这么退化的。
      var handled = false;
      for (final len in run >= 2 ? const [2, 1] : const [1]) {
        // 「谁能当开记号」（CommonMark 的左翼规则，简化版）：开记号**后面不许是空白**。
        // 少了这一条，`3 * 4 = 12`、`a * b * c` 这种算式与装饰星号会被读成斜体——
        // 那是**改她的话**（纪律 ①/②），比少渲染一处强调严重得多。
        // 右侧那一半（闭记号**前面不许是空白**）在 [_closingAsterisks] 里判。
        if (_isSpace(text, i + run)) continue;
        final close = _closingAsterisks(text, i + run, len);
        if (close < 0) continue;
        final inner = text.substring(i + len, close);
        if (inner.isEmpty) continue;
        flush();
        out.add(_Run(text.substring(i, i + len), role: _Role.marker));
        // 内容**递归**解析：`**a *b* c**` 里那一小段斜体照旧成立。
        // 递归不会跑偏——每一层都至少吃掉两个记号字符，长度严格下降。
        _inline(inner, out, len == 2 ? decoration.withBold() : decoration.withItalic(), role);
        out.add(_Run(text.substring(close, close + len), role: _Role.marker));
        i = close + len;
        handled = true;
        break;
      }
      if (handled) continue;
      buf.write(text.substring(i, i + run));
      i += run;
      continue;
    }

    buf.write(text[i]);
    i += 1;
  }
  flush();
}

/// [index] 处的 `[` 是不是**图片**的开始（前面紧挨着一个没被转义的 `!`）。
///
/// 图片不做（见文件头"不做"那一行）：于是它的链接那一半也不做——整句原样出去。
bool _isImageBracket(String text, int index) {
  if (index == 0) return false;
  if (text.codeUnitAt(index - 1) != 0x21 /* ! */) return false;
  // `\!` 是转义的叹号：那就不算图片前缀
  var backslashes = 0;
  var k = index - 2;
  while (k >= 0 && text.codeUnitAt(k) == 0x5C /* \ */) {
    backslashes += 1;
    k -= 1;
  }
  return backslashes.isEven;
}

/// [index] 处是不是空白（越界算"空白"：行尾与行首一样，都不是强调内容的边界）。
bool _isSpace(String text, int index) =>
    index < 0 || index >= text.length || text[index].trim().isEmpty;

/// 从 [from] 起找 [len] 个连续星号组成的闭合记号；找不到返 -1。
///
/// 两个判据：
///   · 这一串必须**恰好** [len] 个（不能是更长一串的一部分）：`**a***` 里那个三连星
///     不是 `**` 的闭合——不然会把 `*` 吃进去，那就是改文本了；
///   · 它前面**不许是空白**（右翼规则）：`a * b * c` 里那个收尾的星号前面是空格，
///     所以它不是闭合，整句照旧是普通文字。
int _closingAsterisks(String text, int from, int len) {
  var i = from;
  while (i < text.length) {
    if (text.codeUnitAt(i) != 0x2A) {
      i += 1;
      continue;
    }
    var run = 1;
    while (i + run < text.length && text.codeUnitAt(i + run) == 0x2A) {
      run += 1;
    }
    // 闭合只在一种情况下成立：这一串**正好** len 个，且前面不是空白。
    // 更长的一串（`**a***`）留给它自己的扫描——那三个星号会各自按普通文字出去。
    if (run == len && !_isSpace(text, i - 1)) return i;
    i += run;
  }
  return -1;
}

/// `>` 引用记号 → 剥掉之后的内容；不是引用行返回 null。
String? _stripQuote(String line) {
  final match = _quote.firstMatch(line);
  if (match == null) return null;
  return match.group(3)!;
}

// ──────────────────────────── 版面宽度（只管对齐，不碰文本） ────────────────────────────

/// 标题/表头的字号缩放（行内强调要继承它，所以放在这里共用）。
const List<double> _headingFactors = [1.6, 1.4, 1.25, 1.18, 1.12, 1.08];
const double _tableHeaderScale = 1.06;

double _headingScale(int level) => _headingFactors[(level - 1).clamp(0, 5)];

// 上一版在这里有一个 displayColumns()（按东亚宽度数"这一格占几列"，想拿它凑等宽对齐）。
// 真网格之后列宽由 Table 负责，那个函数一个调用点都没有了——**随这一批一起删掉**：
// 留着一段没人用、文档还说"表格对齐要它"的量度代码，比少一个函数更容易骗人。

/// 行首缩进（空格 / 制表符），返回列数（制表符按 4 列算）。
int _indentColumns(String line) {
  var columns = 0;
  var i = 0;
  while (i < line.length) {
    final c = line[i];
    if (c == ' ') {
      columns += 1;
    } else if (c == '\t') {
      columns += 4;
    } else {
      break;
    }
    i += 1;
  }
  return columns;
}

// ──────────────────────────────── 样式表 ────────────────────────────────

/// 样式表：词法器只认 [_Role] 与 [_Decoration]，颜色/字号全在这里决定。
abstract class _Style {
  TextStyle? of(_Run run);
}

/// 带主题的样式（上屏用）。
///
/// 取色一律走 `Theme.of(context).colorScheme`（明暗两模同一份代码，不写死色值）：
///   · 行内代码/代码块 → `surfaceContainerHighest` 淡底 + 等宽
///   · 列表记号 / 表格竖线 → `onSurfaceVariant`（是排版记号，不比正文抢眼）
///   · 链接 → `primary` + 下划线
class _ThemeStyle implements _Style {
  _ThemeStyle(this.context, this.base);

  final BuildContext context;
  final TextStyle? base;

  ColorScheme get _scheme => Theme.of(context).colorScheme;
  TextStyle get _text => base ?? const TextStyle();

  @override
  TextStyle? of(_Run run) {
    // 记号一律字号 0（纪律 ①：在文本里活着、在版面上不占位）
    if (_hidden(run.role)) return markdownHiddenMarker;

    final decoration = run.decoration;
    var style = switch (run.role) {
      _Role.code => _text.copyWith(
          fontFamily: 'monospace',
          fontSize: (_text.fontSize ?? 14) - 1,
          height: 1.45,
          color: _scheme.onSurface,
          backgroundColor: _scheme.surfaceContainerHighest,
        ),
      _Role.listMarker => _text.copyWith(
          color: _scheme.onSurfaceVariant,
          fontSize: (_text.fontSize ?? 14) * decoration.scale,
        ),
      // 管道现在走不到这里（上屏那条路把表格块换成了控件）——留着是为了
      // switch 穷尽与"文本那条路"万一以后要上屏时不会拿不到样式。
      _Role.tablePipe => _text.copyWith(
          fontFamily: 'monospace',
          height: 1.5,
          color: _scheme.onSurfaceVariant,
        ),
      // 格子里的字：等宽 + 行高 1.5（网格里一行挨一行，1.65 那种正文行高太散）。
      // 字体/配色与上一版**逐字相同**：这一批只动结构（换成真网格），不顺手改观感。
      _Role.tableCell => _text.copyWith(fontFamily: 'monospace', height: 1.5),
      _Role.tableHeader => _text.copyWith(
          fontFamily: 'monospace',
          height: 1.5,
          fontWeight: FontWeight.w700,
          fontSize: (_text.fontSize ?? 14) * decoration.scale,
        ),
      _Role.link => _text.copyWith(
          color: _scheme.primary,
          decoration: TextDecoration.underline,
          decorationColor: _scheme.primary,
        ),
      // 地址：比标签淡一档（它是"指向哪儿"的提示，不是句子的内容）；
      // 悬停时靠 [MarkdownText] 下方那一行完整的 URL 看清
      _Role.linkUrl => _text.copyWith(
          color: _scheme.primary.withValues(alpha: 0.75),
          fontSize: (_text.fontSize ?? 14) - 1,
        ),
      _Role.heading => _text.copyWith(
          fontSize: (_text.fontSize ?? 14) * decoration.scale,
          fontWeight: FontWeight.w700,
          height: 1.35,
        ),
      _Role.normal => _text,
      // 记号与对齐填充都在上面被拦掉了（字号 0）；这里只是让 switch 穷尽。
      _Role.marker || _Role.padding => markdownHiddenMarker,
    };

    // 标题/表头的字号缩放要传到它内部的行内强调上（`# **粗**` 里的"粗"也是标题那么大）
    if (decoration.scale != 1 &&
        run.role != _Role.heading &&
        run.role != _Role.tableHeader &&
        run.role != _Role.listMarker) {
      style = style.copyWith(fontSize: (_text.fontSize ?? 14) * decoration.scale);
    }
    if (decoration.bold) style = style.copyWith(fontWeight: FontWeight.w700);
    if (decoration.italic) style = style.copyWith(fontStyle: FontStyle.italic);
    if (decoration.link && run.role != _Role.link && run.role != _Role.linkUrl) {
      // 链接标签里的强调：颜色/下划线从链接那一档来，粗细/斜体从强调来
      style = style.copyWith(
        color: _scheme.primary,
        decoration: TextDecoration.underline,
        decorationColor: _scheme.primary,
      );
    }
    return style;
  }
}
