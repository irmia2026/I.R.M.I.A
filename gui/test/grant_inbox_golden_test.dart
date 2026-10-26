import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/grant_inbox_overlay.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/theme.dart';

/// 右下角**快速审批卡**的肉眼验收（两张图）。
///
/// 上一份 golden（`grant_card_golden_test.dart`）拍的是**扩展页**那张完整卡；这一份拍的是
/// 壳上的那一摞：单卡的版式对不对、三张堆叠起来会不会挤、超过三张那一行在什么位置。
///
/// 图落在 `test/goldens/`：
///   • `grant_inbox_single.png` —— **单卡**（低风险 `mcp-remove`：按钮是「批准」，没有风险徽章）；
///   • `grant_inbox_stack.png`  —— **多卡堆叠**（三张：装技能[高风险] / 加 MCP[高风险] /
///     删技能[低风险] + 底下那行「还有 1 条待批」）。
///
/// ── 为什么要 `IRMIA_GOLDENS=1` 才跑 ──
/// 截图是**逐像素**比对：它取决于本机有没有那套中文字体、以及渲染后端的小数取舍，
/// 换一台机器跑同一条必然不同（那不是回归，是字体不同）。所以普通 `flutter test` 跳过，
/// 要出图/重出图时显式跑一次：
///
///     PowerShell:  $env:IRMIA_GOLDENS=1; flutter test --update-goldens test/grant_inbox_golden_test.dart
///     bash:        IRMIA_GOLDENS=1 flutter test --update-goldens test/grant_inbox_golden_test.dart
final bool _enabled = Platform.environment['IRMIA_GOLDENS'] == '1';

/// 本机的中文字体候选（goldens 要"能肉眼看字"，不能是一排方框）
const _fontCandidates = <String>[
  r'C:\Windows\Fonts\simhei.ttf',
  r'C:\Windows\Fonts\Deng.ttf',
  r'C:\Windows\Fonts\msyh.ttc',
];

/// 把一套真字体注册到给定 family 上
Future<bool> _loadFont(String family, {List<String> paths = _fontCandidates}) async {
  for (final path in paths) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = await file.readAsBytes();
    final loader = FontLoader(family)..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
    await loader.load();
    return true;
  }
  return false;
}

/// 图标字体（`MaterialIcons`）的**最佳努力**加载。
///
/// 不加载的话，图里那几枚图标（通知、展开/收起、待处理）渲染成空方框——真机上不是那样，
/// 而这一份图的用途就是"给人肉眼看"。字体在 Flutter SDK 的缓存里，**不是**仓库里的资源，
/// 所以只在本机能找到时加载；找不到就照旧出方框（用例照样绿，只是图糙一点）。
Future<bool> _loadIconFont() async {
  final candidates = <String>[];
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root != null && root.isNotEmpty) {
    candidates.add('$root/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
  }
  // 从 Dart VM 的位置回推：<sdk>/bin/cache/dart-sdk/bin/dart.exe ⇒ <sdk>/bin/cache
  final cache = File(Platform.resolvedExecutable).parent.parent.parent.path;
  candidates.add('$cache/artifacts/material_fonts/MaterialIcons-Regular.otf');
  return _loadFont('MaterialIcons', paths: candidates);
}

/// 一张待批的申请单（字段照 `GET /api/grants` 的 items 形状）
Map<String, dynamic> grant({
  required String id,
  required String kind,
  required String name,
  String command = '',
  List<dynamic> args = const <dynamic>[],
  List<dynamic> scriptNames = const <dynamic>[],
  String requestedAt = '2026-02-14T02:00:00.000Z',
}) =>
    <String, dynamic>{
      'id': id,
      'kind': kind,
      'name': name,
      'desc': '',
      'command': command,
      'args': args,
      'envKeys': <dynamic>[],
      'scriptNames': scriptNames,
      'fileCount': 0,
      'reason': '想每天固定做一次，省得你早上还要问我在忙什么',
      'question': '批准？',
      'context': '',
      'askSeq': 7,
      'expiredAt': null,
      'requestedAt': requestedAt,
      'outcome': null,
      'outcomeAt': null,
      'rejectReason': null,
      'exec': null,
      'picked': true,
    };

void main() {
  setUpAll(() async {
    // 主题里写死的那两个字体栈：不注册真字形，截图里就是一堆方框（等于没验）
    await _loadFont(IrmiaTheme.windowsUiFont);
    await _loadFont('monospace');
    // 图标同理（通知 / 展开收起的几枚）：找不到 SDK 里的那份字体就出方框，不影响断言
    await _loadIconFont();
  });

  /// 把那一摞卡摆在**右下角**（与真机同一个角），只截它自己那一块。
  ///
  /// 画布给得足够大是刻意的：截的是 `RepaintBoundary`，尺寸由内容决定——但外层窗口要够宽够高，
  /// 否则 `Positioned`/`Align` 那一步会先按窗口约束把卡压窄（图就不是真机上的样子了）。
  Future<void> pumpShot(WidgetTester tester, Widget panel, {required Size size}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      builder: (context, child) => IrmiaStrings(
        strings: const ZhStrings(),
        child: child ?? const SizedBox.shrink(),
      ),
      home: Scaffold(
        body: Align(
          alignment: Alignment.bottomRight,
          child: Padding(
            padding: const EdgeInsets.all(kGrantInboxInset),
            child: RepaintBoundary(
              key: const ValueKey('shot'),
              // 测试侧的字体替身（不是产品代码）：卡里的字大多是"只给字号"的 Text，
              // 环境默认风格落在测试字库上就是方框；补上真字库注册的那个族名即可。
              child: DefaultTextStyle.merge(
                style: const TextStyle(fontFamily: IrmiaTheme.windowsUiFont, fontSize: 13),
                child: panel,
              ),
            ),
          ),
        ),
      ),
    ));
    await tester.pump();
  }

  Future<void> expectShot(WidgetTester tester, String file) async {
    await expectLater(find.byKey(const ValueKey('shot')), matchesGoldenFile('goldens/$file'));
  }

  /// 一张卡的纯展示主机（回调给空实现：golden 只看版式，不点）
  Widget panel(List<Map<String, dynamic>> pending, {bool collapsed = false}) => GrantInboxPanel(
        pending: pending,
        collapsed: collapsed,
        onApprove: (_) {},
        onReject: (_) {},
        onDetails: (_) {},
        onExpand: () {},
        onCollapse: () {},
        onOpenExtensions: () {},
      );

  testWidgets('单卡（低风险 mcp-remove）：按钮是「批准」，三行字 + 来源都在', (tester) async {
    await pumpShot(
      tester,
      panel(<Map<String, dynamic>>[
        grant(
          id: 'g-1',
          kind: 'mcp-remove',
          name: 'obscura',
          requestedAt: '2026-02-14T02:00:00.000Z',
        ),
      ]),
      size: const Size(680, 520),
    );
    expect(tester.takeException(), isNull);
    await expectShot(tester, 'grant_inbox_single.png');
  }, skip: !_enabled);

  testWidgets('多卡堆叠：三张（两张高风险 + 一张低风险）+「还有 1 条待批」', (tester) async {
    await pumpShot(
      tester,
      panel(<Map<String, dynamic>>[
        // 最新最上：装技能（带 2 个可执行脚本 ⇒ 高风险）
        grant(
          id: 'g-4',
          kind: 'skill-install',
          name: 'daily-brief',
          scriptNames: <dynamic>['scripts/brief.py', 'scripts/collect.sh'],
          requestedAt: '2026-02-14T04:00:00.000Z',
        ),
        // 加 MCP（高风险：那一行影响给的是**命令名**）。
        // 路径故意给成真机上那条长的：420 宽、13 号等宽字下它该在**目录边界**（`\`）处折成两行，
        // 而不是从路径中间硬切成 `…\@play` / `wright\mcp\cli.js`（用户截图里那条）。
        // 用户名位置写 `<用户名>`：闸门只放行 `C:\Users\<…>` 这种占位形态（见仓库外那份私有词表（IRMIA_PRIVATE_WORDS））。
        grant(
          id: 'g-3',
          kind: 'mcp-add',
          name: 'playwright',
          command: 'node',
          args: <dynamic>[r'C:\Users\<用户名>\AppData\Roaming\npm\node_modules\@playwright\mcp\cli.js'],
          requestedAt: '2026-02-14T03:00:00.000Z',
        ),
        // 删技能（低风险：可移回回收站）
        grant(
          id: 'g-2',
          kind: 'skill-remove',
          name: 'old-skill',
          requestedAt: '2026-02-14T02:00:00.000Z',
        ),
        // 第四张：被收进「还有 1 条待批」那一行
        grant(
          id: 'g-1',
          kind: 'mcp-remove',
          name: 'filesystem',
          requestedAt: '2026-02-14T01:00:00.000Z',
        ),
      ]),
      size: const Size(680, 900),
    );
    expect(tester.takeException(), isNull);
    await expectShot(tester, 'grant_inbox_stack.png');
  }, skip: !_enabled);
}
