import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_override.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/pages/settings_page.dart';
import 'package:irmia_gui/theme.dart';

/// 文案覆盖层（`%APPDATA%\Irmia\strings-override.json`）的五条承诺：
///
///   ① **覆盖压过默认值**：分语言段的覆盖只改那一种语言，另一种语言与没写的键照旧；
///   ② **未知键忽略 + 报出来**：不认识的键、值不是字符串的键都不生效，但要进
///      `ignored` 并打到控制台（拼错时人能发现），且**不许崩**；
///   ③ **文件缺失 / JSON 坏**：静默回默认文案，状态行如实说"未使用覆盖 / 解析失败：…"；
///   ④ **重新载入不重启**：`reloadStringsOverride()` 之后新值当场生效，整棵树不重建
///      （状态还在，只换字）；
///   ⑤ **模板 = 接口**：导出模板的键集合与 `AppStrings` 的无参 getter 集合逐一对得上
///      （`AppStrings` 加了新 getter 却忘了补 `stringsAsMap`，这条会红）。
///
/// 真机观感（覆盖文件在 `%APPDATA%` 下的实际读写、设置页点按钮的手感）不在射程内。
void main() {
  late Directory tmp;
  late String overrideFile;

  const emptySnapshot = StringsOverrideSnapshot(language: AppLanguage.zh, revision: 0);

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('irmia-strings-override-');
    overrideFile = '${tmp.path}${Platform.pathSeparator}$kStringsOverrideFileName';
    stringsOverrideFileOverride = overrideFile;
    stringsOverrideState.value = emptySnapshot;
    effectiveLanguage.value = AppLanguage.zh;
    languagePreference.value = AppLanguage.system;
  });

  tearDown(() {
    stringsOverrideFileOverride = null;
    stringsOverrideState.value = emptySnapshot;
    effectiveLanguage.value = AppLanguage.zh;
    languagePreference.value = AppLanguage.system;
    try {
      tmp.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
  });

  group('① 覆盖生效（覆盖值 > 默认值）', () {
    test('zh 覆盖一条 ⇒ 读到覆盖值；没写的键回默认；en 不受影响', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '闲聊'},
        'en': {'navChat': 'Gossip'},
      }));
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.total, 2);
      expect(snapshot.zh, {'navChat': '闲聊'});
      expect(snapshot.en, {'navChat': 'Gossip'});

      expect(resolveStrings(AppLanguage.zh).navChat, '闲聊');
      expect(resolveStrings(AppLanguage.en).navChat, 'Gossip');
      // 解析顺序是"逐键"的：没写的仍回 ZhStrings / EnStrings
      expect(resolveStrings(AppLanguage.zh).navSettings, const ZhStrings().navSettings);
      expect(resolveStrings(AppLanguage.en).navSettings, const EnStrings().navSettings);
      // 语言与 locale 仍来自 base（覆盖层不改"这是什么语言"）
      expect(resolveStrings(AppLanguage.zh).language, AppLanguage.zh);
      expect(resolveStrings(AppLanguage.en).locale, const Locale('en'));
    });

    test('只覆盖 zh：en 那一份仍是默认实现本身（空覆盖不套装饰器）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '闲聊'},
      }));
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.zh, hasLength(1));
      expect(snapshot.en, isEmpty);
      expect(resolveStrings(AppLanguage.zh).navChat, '闲聊');
      expect(resolveStrings(AppLanguage.en), isA<EnStrings>());
      expect(resolveStrings(AppLanguage.en).navChat, const EnStrings().navChat);
    });

    test('扁平形状：只覆盖加载时那一种语言', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({'navChat': '闲聊'}));
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.zh, {'navChat': '闲聊'});
      expect(snapshot.en, isEmpty);
      expect(resolveStrings(AppLanguage.zh).navChat, '闲聊');
      expect(resolveStrings(AppLanguage.en).navChat, const EnStrings().navChat);
    });

    test('扁平形状按加载时给的语言绑定（en 加载 ⇒ 覆盖的是英文那一份）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({'navChat': 'Gossip'}));
      await loadStringsOverride(language: AppLanguage.en);
      expect(resolveStrings(AppLanguage.en).navChat, 'Gossip');
      expect(resolveStrings(AppLanguage.zh).navChat, const ZhStrings().navChat);
    });

    test('没覆盖时 resolveStrings 就是默认实现（与加这一层之前等价）', () {
      expect(resolveStrings(AppLanguage.zh), isA<ZhStrings>());
      expect(resolveStrings(AppLanguage.en), isA<EnStrings>());
      expect(resolveStrings(AppLanguage.zh).revision, 0);
    });

    test('带参数的句子：委托给默认实现（覆盖层不碰它的参数位）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '闲聊'},
      }));
      await loadStringsOverride(language: AppLanguage.zh);
      final s = resolveStrings(AppLanguage.zh);
      expect(s.loadFailed('端口不通'), const ZhStrings().loadFailed('端口不通'));
      expect(s.thinkingStep('7'), const ZhStrings().thinkingStep('7'));
    });
  });

  group('② 未知键：忽略 + 列出（不崩）', () {
    test('拼错的键 / 值不是字符串 / 带参句子的键：都不生效，但要报出来', () async {
      final printed = <String>[];
      final saved = debugPrint;
      debugPrint = (String? message, {int? wrapWidth}) {
        if (message != null) printed.add(message);
      };
      addTearDown(() => debugPrint = saved);

      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {
          'navChat': '闲聊',
          'navChatTypo': '这条拼错了',
          'loadFailed': '带参句子不支持',
        },
        'en': {'navChat': 42},
        'fr': {'navChat': 'Bonjour'},
      }));
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);

      // 认识的键照常生效；其余一律不进覆盖表
      expect(snapshot.zh, {'navChat': '闲聊'});
      expect(snapshot.en, isEmpty);
      // 四条都进了 ignored（拼错 / 带参句子 / 值不是字符串 / 不认识的顶层段）
      expect(snapshot.ignored, hasLength(4));
      final joined = snapshot.ignored.join('\n');
      expect(joined, contains('zh.navChatTypo'));
      expect(joined, contains('zh.loadFailed'));
      expect(joined, contains('en.navChat'));
      expect(joined, contains('fr'));
      // 控制台里逐条说清
      expect(printed.join('\n'), contains('zh.navChatTypo'));
      expect(printed.join('\n'), contains('unknown key'));
      expect(printed.join('\n'), contains('value is not a string'));
      // 没有崩：界面照常用默认文案 + 那一条覆盖
      expect(resolveStrings(AppLanguage.zh).navChat, '闲聊');
      expect(resolveStrings(AppLanguage.zh).navSettings, const ZhStrings().navSettings);
    });

    test('顶层多了别的段：整份仍可用（只忽略那一段）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '闲聊'},
        'zh-CN': {'navChat': '简体'},
      }));
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.zh, {'navChat': '闲聊'});
      expect(snapshot.total, 1);
      expect(snapshot.ignored.join('\n'), contains('zh-CN'));
    });
  });

  group('③ 文件缺失 / JSON 坏：回默认 + 状态如实说', () {
    test('文件不存在：没覆盖，状态「未使用覆盖（默认文案）」', () async {
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.exists, isFalse);
      expect(snapshot.failed, isFalse);
      expect(snapshot.total, 0);
      expect(resolveStrings(AppLanguage.zh).navChat, const ZhStrings().navChat);
      expect(
        stringsOverrideStatusLine(const ZhStrings(), snapshot),
        '未使用覆盖（默认文案）',
      );
      expect(
        stringsOverrideStatusLine(const EnStrings(), snapshot),
        'No overrides (built-in text)',
      );
    });

    test('JSON 坏：回默认，状态「解析失败：…」（中英各一句）', () async {
      File(overrideFile).writeAsStringSync('{ "zh": { "navChat": ');
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.failed, isTrue);
      expect(snapshot.errorKind, StringsOverrideError.badJson);
      expect(snapshot.total, 0);
      expect(resolveStrings(AppLanguage.zh).navChat, const ZhStrings().navChat);

      final zhStatus = stringsOverrideStatusLine(const ZhStrings(), snapshot);
      expect(zhStatus, startsWith('解析失败：'));
      expect(zhStatus, contains('JSON 格式不对'));
      final enStatus = stringsOverrideStatusLine(const EnStrings(), snapshot);
      expect(enStatus, startsWith('Parse failed:'));
      expect(enStatus, contains('Invalid JSON'));
    });

    test('顶层是数组：回默认，状态说清"顶层不是 JSON 对象"', () async {
      File(overrideFile).writeAsStringSync('[1, 2, 3]');
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.errorKind, StringsOverrideError.badRoot);
      expect(snapshot.total, 0);
      expect(resolveStrings(AppLanguage.zh).navChat, const ZhStrings().navChat);
      expect(
        stringsOverrideStatusLine(const ZhStrings(), snapshot),
        contains('顶层不是 JSON 对象'),
      );
    });

    test('不是 UTF-8 文本：回默认、不抛', () async {
      File(overrideFile).writeAsBytesSync(<int>[0xFF, 0xFE, 0x00, 0x41]);
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.errorKind, StringsOverrideError.unreadable);
      expect(snapshot.total, 0);
      expect(resolveStrings(AppLanguage.zh).navChat, const ZhStrings().navChat);
      expect(
        stringsOverrideStatusLine(const ZhStrings(), snapshot),
        startsWith('解析失败：读不出来'),
      );
    });

    test('记事本写的 BOM 不算坏 JSON', () async {
      File(overrideFile).writeAsStringSync(
        '\uFEFF${jsonEncode({'zh': {'navChat': '闲聊'}})}',
      );
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.failed, isFalse, reason: 'BOM 要先剥掉再 decode');
      expect(resolveStrings(AppLanguage.zh).navChat, '闲聊');
    });

    test('已加载的条数写进状态行（zh / en 分列）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '闲聊', 'navMore': '还有'},
        'en': {'navChat': 'Gossip'},
      }));
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(
        stringsOverrideStatusLine(const ZhStrings(), snapshot),
        '已加载 3 条覆盖（zh 2 / en 1）',
      );
      expect(
        stringsOverrideStatusLine(const EnStrings(), snapshot),
        'Loaded 3 override(s) (zh 2 / en 1)',
      );
      expect(const ZhStrings().stringsOverrideIgnored(2), contains('2 条键没被采用'));
    });
  });

  group('④ 重新载入：不重启、不重建整树', () {
    testWidgets('reloadStringsOverride 之后新值当场生效（State 还在）', (tester) async {
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '第一版'},
      }));
      await tester.runAsync(() => loadStringsOverride(language: AppLanguage.zh));

      var builds = 0;
      await tester.pumpWidget(
        ListenableBuilder(
          // 与 app.dart 的根同构：语言 **或** 覆盖层变了就重建 MaterialApp 那一层
          listenable: Listenable.merge([effectiveLanguage, stringsOverrideState]),
          builder: (context, _) {
            final language = effectiveLanguage.value;
            builds += 1;
            return IrmiaStrings(
              strings: resolveStrings(language),
              child: MaterialApp(home: const _Probe()),
            );
          },
        ),
      );
      await tester.pump();
      expect(find.text('第一版'), findsOneWidget);
      expect(find.text('设置'), findsOneWidget, reason: '没覆盖的键仍是默认文案');

      final stateBefore = tester.state<_ProbeState>(find.byType(_Probe));

      // 改文件 + 重新载入（真 IO ⇒ 必须走 runAsync；widget 用例跑在 fake-async 里）
      File(overrideFile).writeAsStringSync(jsonEncode({
        'zh': {'navChat': '第二版'},
      }));
      await tester.runAsync(reloadStringsOverride);
      await tester.pump();

      expect(find.text('第二版'), findsOneWidget);
      expect(find.text('第一版'), findsNothing);
      expect(builds, greaterThan(1));
      expect(
        identical(tester.state<_ProbeState>(find.byType(_Probe)), stateBefore),
        isTrue,
        reason: '只换字，不重建整棵树（State 必须还是同一个）',
      );
    });

    test('reload 省略语言时沿用上一次加载的语言', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({'navChat': 'Gossip'}));
      await loadStringsOverride(language: AppLanguage.en);
      File(overrideFile).writeAsStringSync(jsonEncode({'navChat': 'Gossip 2'}));
      final snapshot = await reloadStringsOverride();
      expect(snapshot.language, AppLanguage.en);
      expect(resolveStrings(AppLanguage.en).navChat, 'Gossip 2');
    });

    test('重新载入后 revision 变、language 不变（IrmiaStrings 靠它通知）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({'zh': {'navChat': '甲'}}));
      final first = await loadStringsOverride(language: AppLanguage.zh);
      File(overrideFile).writeAsStringSync(jsonEncode({'zh': {'navChat': '乙'}}));
      final second = await reloadStringsOverride();
      expect(second.revision, greaterThan(first.revision));
      expect(second.language, first.language);
      expect(resolveStrings(AppLanguage.zh).navChat, '乙');
    });
  });

  group('⑤ 导出模板 = AppStrings 的键表', () {
    test('模板键集合与 AppStrings 的无参 getter 逐一对得上', () async {
      final path = await exportStringsTemplate(language: AppLanguage.zh);
      expect(path, stringsTemplatePath());
      expect(File(path).existsSync(), isTrue);

      final decoded = jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
      expect(decoded.keys, <String>['zh'], reason: '导出的是当前语言那一段（zh）');
      final section = (decoded['zh'] as Map).cast<String, dynamic>();
      final declared = _abstractGetterNames();
      expect(declared, isNotEmpty);
      expect(section.keys.toSet(), declared);
      expect(section.length, declared.length);
      // 抽查：值就是此刻中文那份
      expect(section['navChat'], const ZhStrings().navChat);
      expect(section['settingsLanguage'], const ZhStrings().settingsLanguage);
    });

    test('导出的是"此刻生效"的那份（含已生效的覆盖值）', () async {
      File(overrideFile).writeAsStringSync(jsonEncode({'zh': {'navChat': '闲聊'}}));
      await loadStringsOverride(language: AppLanguage.zh);
      final path = await exportStringsTemplate(language: AppLanguage.zh);
      final section = (jsonDecode(File(path).readAsStringSync())
          as Map<String, dynamic>)['zh'] as Map<String, dynamic>;
      expect(section['navChat'], '闲聊');
    });

    test('模板改名成覆盖文件后：全部键都被自己吃下（ignored 为空）', () async {
      final path = await exportStringsTemplate(language: AppLanguage.zh);
      File(path).copySync(overrideFile);
      final snapshot = await loadStringsOverride(language: AppLanguage.zh);
      expect(snapshot.ignored, isEmpty);
      expect(snapshot.zh.length, _abstractGetterNames().length);
      expect(resolveStrings(AppLanguage.zh).navChat, const ZhStrings().navChat);
    });

    test('英文：导出的是 en 那一段（键数同、值与 EnStrings 一致）', () async {
      final path = await exportStringsTemplate(language: AppLanguage.en);
      final decoded = jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;
      expect(decoded.keys, <String>['en']);
      final section = (decoded['en'] as Map).cast<String, dynamic>();
      expect(section.keys.toSet(), _abstractGetterNames());
      expect(section['navChat'], const EnStrings().navChat);
    });
  });

  group('设置页入口（「界面」卡里，紧跟语言选择器）', () {
    testWidgets('路径 / 打开 / 重新载入 / 导出 / 状态行都在，状态说「未使用覆盖」', (tester) async {
      // 设置页在 initState 里要打几个真端点：给一个"什么都能答"的最小 loopback 服务。
      // **必须在 runAsync 里 bind**：HttpServer 自带一个 2 分钟的 idleTimeout 定时器，
      // 在 fake-async 区里建它会被记成"没取消的 Timer"，用例收尾直接红。
      HttpOverrides.global = null; // 默认 TestWidgetsFlutterBinding 会把 HTTP 打成 400
      final server = await tester.runAsync(() async {
        final bound = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        bound.listen((req) async {
          req.response.headers.contentType = ContentType.json;
          req.response.write('{}');
          await req.response.close();
        });
        return bound;
      });
      addTearDown(() => server?.close(force: true));

      final state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server!.port}'));
      // AppState 自带轮询定时器：**必须在用例体里停掉**（addTearDown 太晚——
      // binding 在测试体结束时就会检查"还有没有 Timer 没取消"）
      var disposed = false;
      void disposeState() {
        if (disposed) return;
        disposed = true;
        state.dispose();
      }

      addTearDown(disposeState);
      tester.view.physicalSize = const Size(1350, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(MaterialApp(
        theme: IrmiaTheme.light(),
        home: Scaffold(body: SettingsPage(state: state)),
      ));
      // 真 IO 在 fake async 里要靠 runAsync 推进，pump 负责回灌（与 settings_page_test 同一招）
      final target = find.byKey(const ValueKey('strings-override-path'));
      for (var i = 0; i < 60 && target.evaluate().isEmpty; i += 1) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
        await tester.pump();
      }
      expect(target, findsOneWidget, reason: '「界面」卡里应有覆盖文件路径这一格');
      expect(tester.widget<SelectableText>(target).data, stringsOverridePath());
      expect(find.byKey(const ValueKey('strings-override-open')), findsOneWidget);
      expect(find.byKey(const ValueKey('strings-override-reload')), findsOneWidget);
      expect(find.byKey(const ValueKey('strings-override-export')), findsOneWidget);
      // 默认快照 = 没覆盖：状态行就是那句"未使用覆盖（默认文案）"
      expect(find.text('未使用覆盖（默认文案）'), findsOneWidget);
      expect(tester.takeException(), isNull, reason: '这一格不许溢出/抛异常');
      // 收尾：停掉轮询定时器（见上面 disposeState 的说明）
      disposeState();
      await tester.pump();
    });
  });
}

/// 只做一件事：读一次文案（那样才登记依赖），把标题那句话摆出来。
class _Probe extends StatefulWidget {
  const _Probe();

  @override
  State<_Probe> createState() => _ProbeState();
}

class _ProbeState extends State<_Probe> {
  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    return Scaffold(
      body: Column(
        children: [
          Text(s.navChat),
          Text(s.navSettings),
        ],
      ),
    );
  }
}

/// `AppStrings` 里**无参 String getter** 的键名集合。
///
/// 没有 `dart:mirrors`（Flutter 不带它），所以从源码里数：`abstract class AppStrings {`
/// 那段里 `String get xxx;` 的每一个 `xxx` 就是一条可覆盖的键。这条是 ⑤ 的判据——
/// 往接口里加了新 getter 却忘了补 `stringsAsMap`，用例当场红（而不是等用户发现改不动）。
Set<String> _abstractGetterNames() {
  final source = File('lib/i18n/app_strings.dart').readAsStringSync();
  final start = source.indexOf('abstract class AppStrings {');
  if (start < 0) throw StateError('找不到 abstract class AppStrings');
  var depth = 0;
  var i = source.indexOf('{', start);
  final begin = i;
  for (; i < source.length; i += 1) {
    if (source[i] == '{') depth += 1;
    if (source[i] == '}') {
      depth -= 1;
      if (depth == 0) break;
    }
  }
  final body = source.substring(begin, i);
  final names = <String>{};
  for (final match in RegExp(r'^\s*String\s+get\s+(\w+)\s*;', multiLine: true).allMatches(body)) {
    names.add(match.group(1)!);
  }
  return names;
}
