import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/theme.dart';

/// 按钮文字的字体栈（用户 ⑨："为什么字体一粗一细？"）。
///
/// 病根不在字号也不在字重：`ButtonStyle.textStyle` 是**直接**交给 `Material` 用的
/// （见 `ButtonStyleButton.build` 里的 `Material(textStyle: …)`），**不会**与上下文的
/// `DefaultTextStyle` 合并。所以谁在页面里写一句 `TextStyle(fontSize: 13, …)`，
/// 谁的按钮就丢掉 `ThemeData.fontFamily`，落到平台兜底字体——同一个界面里两种字形。
///
/// 两条锁：一条钉住"按钮拿到的确实是主题那套字体"，一条钉住"没人再在页面里自己写 textStyle"。
void main() {
  testWidgets('三种按钮的文字都带主题的字体栈', (tester) async {
    final theme = IrmiaTheme.light();
    final family = theme.textTheme.labelLarge?.fontFamily;
    expect(family, isNotNull, reason: '主题的 labelLarge 本身要有字体栈');

    await tester.pumpWidget(
      MaterialApp(
        theme: theme,
        home: Scaffold(
          body: Column(
            children: [
              FilledButton(onPressed: () {}, child: const Text('主按钮')),
              FilledButton.tonal(onPressed: () {}, child: const Text('次按钮')),
              TextButton(onPressed: () {}, child: const Text('文字按钮')),
              SegmentedButton<String>(
                segments: const [ButtonSegment(value: 'a', label: Text('分段'))],
                selected: const {'a'},
              ),
            ],
          ),
        ),
      ),
    );

    // 按钮把解析后的 textStyle 交给 Material，Material 再把它当作子树的默认文字样式——
    // 所以"这个按钮的字是什么字体"就看这一层的 textStyle。
    for (final label in ['主按钮', '次按钮', '文字按钮', '分段']) {
      final material = tester.widget<Material>(
        find.ancestor(of: find.text(label), matching: find.byType(Material)).first,
      );
      expect(material.textStyle?.fontFamily, family, reason: '「$label」的字体栈丢了');
    }
  });

  test('lib 下只有 theme.dart 能出现 textStyle:', () {
    // 页面里写 textStyle 就是丢字体栈（见文件头的说明）。字号要改就在 theme.dart 那个
    // buttonText 上改一次——这条锁是让下一个人不必先踩一遍才知道。
    final offenders = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      if (entity.path.endsWith('theme.dart')) continue;
      final rows = entity.readAsLinesSync();
      for (var i = 0; i < rows.length; i += 1) {
        final text = rows[i].trim();
        if (text.startsWith('//')) continue; // 注释里提到它没关系
        if (text.contains('textStyle:')) offenders.add('${entity.path}:${i + 1}  $text');
      }
    }
    expect(offenders, isEmpty, reason: '这些地方自己写了 textStyle，按钮会落到兜底字体');
  });
}
