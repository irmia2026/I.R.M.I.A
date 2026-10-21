/// 测试用的 **Dart 源码字面量扫描器**（`gui/test/` 里几个"文案闸门"共用）。
///
/// 为什么要有它：判据落在**字符串字面量**上，而注释里到处都是中文/星号/反引号——
/// 用正则分不开"注释里的"与"字符串里的"，判据会淹在噪声里。这里按 Dart 的词法走一遍：
///
///   · 跳过 `//` 行注释、`///` 文档注释、`/* */` 块注释（Dart 的块注释可以嵌套）；
///   · 原始字符串 `r'...'` / `r"..."`：反斜杠不是转义，整段照收；
///   · 普通字符串：转义连下一个字符一起收（**值**里那个字符才算）；
///   · 插值：`${...}` 整段跳过（里面的字符串是**另外**的字面量，由外层循环各自处理），
///     `$name` 只是一个 `$` 加标识符，无害；
///   · 三引号 `'''` / `"""` 与单引号一视同仁（换行时行号照加）。
///
/// 只依赖 `dart:io`，不依赖 Flutter——这样它也能被一个纯 Dart 脚本直接跑（盘点用）。
library;

import 'dart:io';

/// 一个字符串字面量：**值**（插值已剔除）+ 原始写法 + 位置。
class DartLiteral {
  DartLiteral(this.text, this.line, {this.raw = '', this.start = 0, this.end = 0, this.rawString = false});

  /// 字面量的值（不含外层引号；`${...}` 与 `$name` 的表达式部分不在里面）
  final String text;

  /// **源码里那一串**（不含外层引号）：转义照原样、`${...}` 照原样。
  ///
  /// 两个用途：① 生成文案表时**逐字**搬进实现（不经过"值"这一层，`\n` 不会变成半个换行）；
  /// ② 豁免名单按它匹配（它比"值"稳定：同一段文案的写法只有一种）。
  final String raw;

  /// 在源文件里的起始行（1 基）
  final int line;

  /// 在源文件里的偏移：`[start, end)` 含外层引号（改写源码时按它切片）
  final int start;
  final int end;

  /// 是不是原始字符串（`r'...'`）——原始串里的 `\n` 是两个字符，不是换行
  final bool rawString;

  /// 单行化后的片段（报错/分布表用）
  String get snippet {
    final flat = text.replaceAll('\n', r'\n');
    return flat.length <= 90 ? flat : '${flat.substring(0, 90)}…';
  }
}

/// 列出 [dir] 下所有 `.dart` 文件（按路径排序，保证输出稳定）
List<File> dartFilesIn(Directory dir) => dir
    .listSync(recursive: true)
    .whereType<File>()
    .where((f) => f.path.endsWith('.dart'))
    .toList()
  ..sort((a, b) => a.path.compareTo(b.path));

/// 相对 [root] 的路径，并把分隔符统一成 `/`（跨平台、报告里稳定）
String relativeDartPath(String root, File file) {
  final full = file.absolute.path.replaceAll(r'\', '/');
  final base = root.replaceAll(r'\', '/');
  final prefix = base.endsWith('/') ? base : '$base/';
  return full.startsWith(prefix) ? full.substring(prefix.length) : full;
}

/// 按 Dart 词法把 [source] 里的字符串字面量取出来（注释不算，见文件头）。
List<DartLiteral> stringLiteralsOf(String source) {
  final out = <DartLiteral>[];
  /// `${...}` 里那一段的 [start, end)（里面还可能套字面量，函数末尾递归扫）
  final nestedSpans = <({int start, int end})>[];
  var i = 0;
  var line = 1;

  while (i < source.length) {
    final c = source[i];

    if (c == '\n') {
      line += 1;
      i += 1;
      continue;
    }

    // 行注释（`//` 与文档注释 `///` 同一条路径）
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
    final prefixStart = i;
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
    final rawStart = i;
    while (i < source.length) {
      if (source.startsWith(quote, i)) {
        i += quote.length;
        break;
      }
      final ch = source[i];
      if (!raw && ch == r'\') {
        // 转义：连下一个字符一起收。**值**才是判据（`\n` 是换行，不是字母 n）——
        // 常见的那几个按 Dart 的转义表还原，其余原样收（例如 `\$` → `$`）。
        if (i + 1 < source.length) {
          final next = source[i + 1];
          buf.write(switch (next) {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'b' => '\b',
            'f' => '\f',
            _ => next,
          });
          if (next == '\n') line += 1;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (!raw && ch == r'$' && i + 1 < source.length && source[i + 1] == '{') {
        // 插值表达式：里面的字符串是**另外的字面量**（也是界面文案！）——本层只把整段
        // 跳过去、不并进本字符串的文本，嵌套的字面量交给函数末尾的"再扫一遍"。
        var depth = 0;
        i += 1; // 停在 '{'
        final innerStart = i + 1;
        while (i < source.length) {
          if (source[i] == '{') depth += 1;
          if (source[i] == '}') {
            depth -= 1;
            if (depth == 0) {
              nestedSpans.add((start: innerStart, end: i));
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
    out.add(DartLiteral(
      buf.toString(),
      startLine,
      raw: source.substring(rawStart, i - quote.length),
      start: prefixStart,
      end: i,
      rawString: raw,
    ));
  }

  // 插值里的字面量也是字面量（`'${cond ? '甲' : '乙'}'` 那两个"甲/乙"就是界面文案）：
  // 对每一段 `${...}` 递归扫一遍，位置/行号换算回整个文件。
  for (final span in nestedSpans) {
    final inner = source.substring(span.start, span.end);
    final lineOffset = _lineOf(source, span.start) - 1;
    for (final literal in stringLiteralsOf(inner)) {
      out.add(DartLiteral(
        literal.text,
        literal.line + lineOffset,
        raw: literal.raw,
        start: literal.start + span.start,
        end: literal.end + span.start,
        rawString: literal.rawString,
      ));
    }
  }
  return out;
}

/// 偏移 [offset] 在 [source] 里的行号（1 基）
int _lineOf(String source, int offset) {
  var line = 1;
  for (var i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] == '\n') line += 1;
  }
  return line;
}

/// 字面量里的 CJK 判定：汉字（含扩展 A 与兼容区）+ 中文标点。
///
/// 为什么把标点也算进来：一个只有「：」或「…」的字面量也是给人看的界面文本；
/// 而**纯技术串**（路径、正则、命令）里不会有这些标点。
final RegExp _cjk = RegExp(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff'
    r'\u3000-\u303f\uff01-\uff60\u2018\u2019\u201c\u201d\u2026\u2014]');

/// 这个字面量里有没有 CJK（有 ⇒ 它是一条界面文案）
bool hasCjk(String text) => _cjk.hasMatch(text);

/// [source] 里含 CJK 的字面量（这就是"一处文案"）
List<DartLiteral> cjkLiteralsOf(String source) =>
    [for (final l in stringLiteralsOf(source)) if (hasCjk(l.text)) l];
