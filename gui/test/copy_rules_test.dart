import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// 文案规则（用户 2026-10-05 立的三条）的两条**可机器判的**：
///
///   ① 界面提示 / 脚注里**不许有 Markdown 记号**——界面 chrome 不做渲染，
///      记号会原样显示给人看（渲染器 [MarkdownText] 只服务正文：聊天气泡与提醒卡）。
///   ② 一串用户可见文案**不许是一大段**——超过 [kMaxCopyChars] 字的那叫散文，
///      该拆成"短标签 + 一行要点 + 折叠里的长解释"。
///
/// 判据落在**字符串字面量**上（注释里的 `**` 无害，不进这一份）：本文件带一个小扫描器，
/// 按 Dart 的词法走一遍源码（跳过注释、处理原始字符串与 `$` 插值），把字面量连位置一起取出来。
/// 这样报错能指到"哪个文件第几行"，而不是让人自己去 grep。
void main() {
  /// 一行文案的字数上限：13px 正文一行约 50 个汉字，两行就是 100——取 100。
  const kMaxCopyChars = 100;

  /// 允许超长的例外：**必须是"已经这么定了"的东西**，不是"还没改"。
  const tooLongAllowed = <String, String>{
    // 键是 `文件:行` 之前的稳定片段（用内容开头匹配），值写为什么放它一马
  };

  final libDir = Directory('lib');

  test('界面字符串里不许有 Markdown 记号（** 与反引号）', () {
    final offenders = <String>[];
    for (final file in _dartFiles(libDir)) {
      for (final literal in _stringLiterals(file)) {
        // 渲染器自己那几条正则描述的是**语法**，不是给人看的文案
        if (file.path.replaceAll(r'\', '/').endsWith('lib/markdown.dart')) continue;
        if (literal.text.contains('**') || literal.text.contains('`')) {
          offenders.add('${_where(file, literal)}: ${_snippet(literal.text)}');
        }
      }
    }
    expect(offenders, isEmpty,
        reason: '这些界面上会原样显示 `**` 或反引号（界面 chrome 不渲染 Markdown）：\n'
            '${offenders.join('\n')}\n'
            '改法：去掉记号、写成朴素措辞；真需要强调就把那句收进「说明 / 详情」折叠。');
  });

  test('用户可见的整段文案不过长（超过 $kMaxCopyChars 字就是散文）', () {
    final offenders = <String>[];
    for (final file in _dartFiles(libDir)) {
      for (final literal in _stringLiterals(file)) {
        final text = literal.text;
        // 只判"像给人读的中文句子"的：纯技术串（路径、命令行、正则）不在此列
        if (text.length <= kMaxCopyChars) continue;
        if (!RegExp(r'[\u4e00-\u9fff]').hasMatch(text)) continue;
        // 注释里那种"用 · 拼起来的键值"也不算散文
        if (!RegExp(r'[，。；：！？]').hasMatch(text)) continue;
        if (tooLongAllowed.keys.any((prefix) => text.startsWith(prefix))) continue;
        offenders.add('${_where(file, literal)}: ${text.length} 字 —— ${_snippet(text)}');
      }
    }
    expect(offenders, isEmpty,
        reason: '这几处是一整段口语说明（用户点名的反面样本就是这个形状）：\n'
            '${offenders.join('\n')}\n'
            '改法：短标签 + 一行要点，长解释挪进「说明 / 详情」折叠或 tooltip。');
  });
}

// ──────────────────────────────── 小扫描器 ────────────────────────────────

class _Literal {
  _Literal(this.text, this.line);
  final String text;
  final int line;
}

List<File> _dartFiles(Directory dir) => dir
    .listSync(recursive: true)
    .whereType<File>()
    .where((f) => f.path.endsWith('.dart'))
    .toList()
  ..sort((a, b) => a.path.compareTo(b.path));

String _where(File file, _Literal literal) =>
    '${file.path.replaceAll(r'\', '/')}:${literal.line}';

String _snippet(String text) {
  final flat = text.replaceAll('\n', '\\n');
  return flat.length <= 90 ? flat : '${flat.substring(0, 90)}…';
}

/// 按 Dart 词法把源码里的**字符串字面量**取出来（注释与插值表达式不算）。
///
/// 为什么要自己走一遍而不是正则：`//` 注释里到处都是 `**`（那些无害），
/// 而正则分不开"注释里的星号"与"字符串里的星号"——判据就会淹在噪声里。
List<_Literal> _stringLiterals(File file) {
  final source = file.readAsStringSync();
  final out = <_Literal>[];
  var i = 0;
  var line = 1;

  while (i < source.length) {
    final c = source[i];

    if (c == '\n') {
      line += 1;
      i += 1;
      continue;
    }

    // 行注释
    if (c == '/' && i + 1 < source.length && source[i + 1] == '/') {
      while (i < source.length && source[i] != '\n') {
        i += 1;
      }
      continue;
    }
    // 块注释（Dart 的块注释可以嵌套）
    if (c == '/' && i + 1 < source.length && source[i + 1] == '*') {
      var depth = 0;
      while (i < source.length) {
        if (source.startsWith('/*', i)) {
          depth += 1;
          i += 2;
          continue;
        }
        if (source.startsWith('*/', i)) {
          depth -= 1;
          i += 2;
          if (depth == 0) break;
          continue;
        }
        if (source[i] == '\n') line += 1;
        i += 1;
      }
      continue;
    }

    // 原始字符串：r'...' / r"..."
    var raw = false;
    if ((c == 'r' || c == 'R') &&
        i + 1 < source.length &&
        (source[i + 1] == "'" || source[i + 1] == '"')) {
      raw = true;
      i += 1;
    }

    final q = source[i];
    if (q != "'" && q != '"') {
      i += 1;
      continue;
    }

    final startLine = line;
    final triple = source.startsWith(q * 3, i);
    final quote = triple ? q * 3 : q;
    final buf = StringBuffer();
    i += quote.length;
    while (i < source.length) {
      if (source.startsWith(quote, i)) {
        i += quote.length;
        break;
      }
      final ch = source[i];
      if (!raw && ch == r'\') {
        // 转义：连下一个字符一起收（两个字符都算字面内容？不——转义后的**值**才算，
        // 但这里判的是"源码里写没写记号"，所以把被转义的那个字符照收）
        if (i + 1 < source.length) {
          buf.write(source[i + 1]);
          if (source[i + 1] == '\n') line += 1;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (!raw && ch == r'$' && i + 1 < source.length && source[i + 1] == '{') {
        // 插值表达式：里面的字符串是另外的字面量，由外层循环各自处理；
        // 这里把它整段跳过（不并进本字符串的文本）
        var depth = 0;
        i += 1; // 停在 '{'
        while (i < source.length) {
          if (source[i] == '{') depth += 1;
          if (source[i] == '}') {
            depth -= 1;
            if (depth == 0) {
              i += 1;
              break;
            }
          }
          if (source[i] == '\n') line += 1;
          i += 1;
        }
        continue;
      }
      if (ch == '\n') line += 1;
      buf.write(ch);
      i += 1;
    }
    out.add(_Literal(buf.toString(), startLine));
  }
  return out;
}
