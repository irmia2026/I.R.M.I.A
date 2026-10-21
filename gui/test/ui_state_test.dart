import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/ui_state.dart';

/// 「关窗时收进托盘」这个界面偏好的**默认值与往返**（2026-10-04 加，2026-10-21 默认翻成开）。
///
/// 锁四件事：
///   ① 键名是 `close-to-tray`、**出厂默认 true**（`kCloseToTrayDefault`，2026-10-21 用户裁决：
///      设置页 → 界面 →「关窗时收进托盘（不退出界面）」默认开启）；
///   ② 写盘之后 `restoreCloseToTray()` 读回来是同值（main.dart 启动时靠它决定拦不拦关闭）；
///   ③ **显式关掉仍然优先**：写进去 false ⇒ 读回来 false（"默认开"不等于"关不掉"）；
///   ④ 键缺失 / 文件坏掉回落到**出厂默认 true**（不是 false）——这是"新建/没写过"的那一档；
///      真正防"界面丢进黑洞"的是 main.dart 里那道"托盘没装成就不隐藏"，不是这里回 false。
void main() {
  late Directory tmpDir;
  late String path;

  setUp(() {
    tmpDir = Directory.systemTemp.createTempSync('irmia-ui-state-close-');
    path = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';
    stateFileOverride = path;
    // 内存镜像是全局的：每条用例从**出厂默认**起跑，免得互相串（第一条用例会先读它验默认值）
    closeToTray.value = kCloseToTrayDefault;
  });

  tearDown(() {
    stateFileOverride = null;
    stateFileRenameOverride = null;
    closeToTray.value = kCloseToTrayDefault;
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 清不掉临时目录不影响断言
    }
  });

  /// 直接读那份 json（不走 loadFlag）：要断言的是"盘上到底写了什么键"
  Map<String, dynamic> readFile() =>
      jsonDecode(File(path).readAsStringSync()) as Map<String, dynamic>;

  test('出厂默认开：没写过这个键时读回来就是 true（关窗 = 收进托盘）', () async {
    expect(kCloseToTrayFlag, 'close-to-tray');
    expect(kCloseToTrayDefault, isTrue, reason: '2026-10-21 用户裁决的出厂默认值就是开');
    expect(closeToTray.value, isTrue, reason: '内存镜像的初值同样是开');
    expect(await loadFlagOr(kCloseToTrayFlag, kCloseToTrayDefault), isTrue, reason: '缺项 ⇒ 出厂默认');
    expect(await restoreCloseToTray(), isTrue);
    expect(closeToTray.value, isTrue);
  });

  test('显式打开：写盘 + 内存镜像立刻变 true，重启后读得回来', () async {
    await setCloseToTray(true);

    expect(closeToTray.value, isTrue, reason: '本次运行里就该生效（关窗回调读的是内存镜像）');
    expect(readFile()[kCloseToTrayFlag], isTrue, reason: '键名与值都要落盘');
    // 「重启」那一步：重新读一次盘（restoreCloseToTray 就是 main() 启动时那个动作）
    closeToTray.value = false;
    expect(await restoreCloseToTray(), isTrue);
    expect(closeToTray.value, isTrue);
  });

  test('显式关掉仍然优先：写盘是 false，重启后也读回 false（默认开不等于关不掉）', () async {
    await setCloseToTray(false);

    expect(closeToTray.value, isFalse);
    expect(readFile()[kCloseToTrayFlag], isFalse);
    closeToTray.value = true;
    expect(await restoreCloseToTray(), isFalse);
    expect(closeToTray.value, isFalse);
  });

  test('改这个键不动别的键（整份文件是读改写，不是覆写）', () async {
    await saveFlag('moreGroupOpen', true);
    await setCloseToTray(false);

    final flags = readFile();
    expect(flags['moreGroupOpen'], isTrue, reason: '别人的键要留着');
    expect(flags[kCloseToTrayFlag], isFalse);
  });

  test('文件坏掉时 loadFlag 回"未知"，带默认值的那个照旧回落到出厂默认 true', () async {
    await setCloseToTray(false);
    File(path).writeAsStringSync('{ 这不是 json');

    expect(await loadFlag(kCloseToTrayFlag), isNull,
        reason: '三态（2026-10-21）：读不动的文件 = 未知，不再是"缺项即 false"——'
            '把不知道说成没问过，会让首次引导在老用户机器上自动弹');
    expect(await loadFlagOr(kCloseToTrayFlag, kCloseToTrayDefault), isTrue, reason: '这个键的出厂默认是开');
    expect(await restoreCloseToTray(), isTrue);
    expect(closeToTray.value, isTrue);
  });

  // ── 三态：true / false / null（记录坏了） ──
  //
  // 口径（2026-10-21 用户裁决，第四档）：**"没有记录" = false，"记录坏了" = null**。
  //   · 文件不在 / 键不在 ⇒ false：没问过，真·首次安装就该弹；
  //   · 文件在且是布尔 ⇒ 原样；
  //   · 读不动 / JSON 坏 / 非对象 / 值不是布尔 ⇒ null：由调用方决定未知算什么
  //     （引导判据那边未知 = 不弹；见 onboarding.dart 的 shouldShowOnboarding）。

  test('三态：文件不在 ⇒ false（没有记录 = 没问过，不是未知）', () async {
    expect(File(path).existsSync(), isFalse);
    expect(await loadFlag('onboarding-done'), isFalse,
        reason: '真·首次安装时状态文件本来就不存在：这一档必须当"没问过"，首次引导才会弹');
  });

  test('三态：文件读得动、键不在 ⇒ false（同上，只是别的键写过）', () async {
    File(path).writeAsStringSync(jsonEncode({'mention-prompt-done': true}));
    expect(await loadFlag('onboarding-done'), isFalse);
  });

  test('三态：true / false 原样读回；值不是布尔 ⇒ 未知', () async {
    await saveFlag('a', true);
    await saveFlag('b', false);
    expect(await loadFlag('a'), isTrue);
    expect(await loadFlag('b'), isFalse);

    File(path).writeAsStringSync(jsonEncode({'a': 'true'}));
    expect(await loadFlag('a'), isNull, reason: '写坏的布尔值属于"记录坏了"，不许当成 false');
  });

  test('三态：记录坏了（坏 JSON / 非对象 / 非法 UTF-8）⇒ 未知', () async {
    for (final body in <String>['{ 这不是 json', '[true]', '42', '"onboarding-done"', 'null']) {
      File(path).writeAsStringSync(body);
      expect(await loadFlag('a'), isNull, reason: '记录坏了 ≠ 没问过：$body');
    }
    File(path).writeAsBytesSync(<int>[0xFF, 0xFE, 0x00]);
    expect(await loadFlag('a'), isNull, reason: '文件在但读不动（不是 UTF-8）也属于"记录坏了"');
  });

  test('三态：loadString 不受影响（字符串偏好照旧缺项即 null）', () async {
    expect(await loadString('lang'), isNull);
    await saveString('lang', 'en');
    expect(await loadString('lang'), 'en');
  });

  test('saveFlag 遇到坏 JSON ⇒ 重建干净文件（只含这次写入），unknown 不会永远持续', () async {
    File(path).writeAsStringSync('{ 这不是 json');

    await saveFlag('mention-prompt-done', true);

    expect(File(path).readAsStringSync(), isNot(contains('这不是 json')));
    expect(readFile(), {'mention-prompt-done': true},
        reason: '坏记录没救：重建 = 只写这一次的键（旧内容本来就已不可读）');
    expect(await loadFlag('mention-prompt-done'), isTrue, reason: '重建之后读得动，不再停在未知');
    expect(File('$path.tmp').existsSync(), isFalse);
  });

  // ── 原子写：同目录写 *.tmp 再 rename ──
  //
  // 锁的是"写盘失败不许留下半截"：原文件在 rename 成功之前一个字节都不动，
  // 失败时那份 .tmp 要被清掉。注入点见 ui_state.dart 的 stateFileRenameOverride。

  group('原子写（tmp + rename）', () {
    test('成功：落到正式文件，不留 .tmp', () async {
      await saveFlag('x', true);

      expect(jsonDecode(File(path).readAsStringSync()), {'x': true});
      expect(File('$path.tmp').existsSync(), isFalse, reason: 'rename 之后 tmp 不在了');
    });

    test('改名那一步抛 ⇒ 原文件保持旧内容、不留 .tmp（flag 这条）', () async {
      await saveFlag('keep', true);
      final before = File(path).readAsStringSync();
      stateFileRenameOverride = (tmp, target) async =>
          throw const FileSystemException('测试桩：改名故意失败');

      await saveFlag('keep', false); // 失败被吞掉：这条链路不该抛

      expect(File(path).readAsStringSync(), before, reason: '原文件必须还是上一份完整内容');
      expect(readFile()['keep'], isTrue, reason: '旧值不许被半截写坏');
      expect(File('$path.tmp').existsSync(), isFalse, reason: '半截的 .tmp 不许留下');
    });

    test('改名那一步抛 ⇒ 字符串那条也一样（saveString）', () async {
      await saveString('lang', 'zh');
      final before = File(path).readAsStringSync();
      stateFileRenameOverride = (tmp, target) async =>
          throw const FileSystemException('测试桩：改名故意失败');

      await saveString('lang', 'en');

      expect(File(path).readAsStringSync(), before);
      expect(File('$path.tmp').existsSync(), isFalse);
    });

    test('写盘失败之后照旧能写：注入点撤掉就好（失败不留毒）', () async {
      await saveFlag('keep', true);
      stateFileRenameOverride =
          (tmp, target) async => throw const FileSystemException('测试桩：这次故意失败');
      await saveFlag('keep', false);
      stateFileRenameOverride = null;

      await saveFlag('keep', false);
      expect(readFile()['keep'], isFalse);
      expect(File('$path.tmp').existsSync(), isFalse);
    });
  });
}
