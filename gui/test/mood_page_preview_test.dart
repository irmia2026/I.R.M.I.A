import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/pages/mood_page.dart';
import 'package:irmia_gui/theme.dart';

/// 情绪页的**肉眼验收图**（设计稿 2026-10-31）。
///
/// 不出断言，出 PNG：把新页按 1280×900 渲染一次，存到
/// `tmp/emotion-panel-preview.png`（仓库根下）；再切到第三个 tab「亲密」出
/// `tmp/intimacy-panel-preview.png`。默认 skip——截图依赖本机的中文字体，
/// 在别人的机器上渲染出来是方框，不该当成回归。要出图时显式跑：
///
///     PowerShell:  $env:IRMIA_PREVIEW=1; flutter test test/mood_page_preview_test.dart
///
/// 数据是**固定假数据**（设计稿 quiet 那一幕；亲密那一屏是"开着 + 有冷却前的一拍读数"），
/// 只走 `/api/affect` `/api/intimacy` 的响应形状，不碰真后端、不写 `data/`。
final bool _enabled = Platform.environment['IRMIA_PREVIEW'] == '1';

const _fontCandidates = <String>[
  r'C:\Windows\Fonts\simhei.ttf',
  r'C:\Windows\Fonts\Deng.ttf',
  r'C:\Windows\Fonts\msyh.ttc',
];

Future<bool> _loadFont(String family) async {
  for (final path in _fontCandidates) {
    final file = File(path);
    if (!file.existsSync()) continue;
    final bytes = await file.readAsBytes();
    final loader = FontLoader(family)..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
    await loader.load();
    return true;
  }
  return false;
}

/// 图标也要有真字形，否则预览图里每个图标都是一枚方框。
Future<void> _loadIconFont() async {
  final roots = <String?>[
    Platform.environment['FLUTTER_ROOT'],
    // flutter_tester 在 <root>/bin/cache/artifacts/engine/<platform>/ 下
    () {
      var dir = File(Platform.resolvedExecutable).parent;
      for (var i = 0; i < 8; i += 1) {
        if (File('${dir.path}${Platform.pathSeparator}bin${Platform.pathSeparator}cache').existsSync()) {
          return dir.path;
        }
        final parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
      return null;
    }(),
  ];
  for (final root in roots) {
    if (root == null || root.isEmpty) continue;
    final file = File('$root${Platform.pathSeparator}bin${Platform.pathSeparator}cache'
        '${Platform.pathSeparator}artifacts${Platform.pathSeparator}material_fonts'
        '${Platform.pathSeparator}materialicons-regular.otf');
    if (!file.existsSync()) continue;
    final bytes = await file.readAsBytes();
    final loader = FontLoader('MaterialIcons')..addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
    await loader.load();
    return;
  }
}

/// 真机两个 bug 的合并现场：`history` 恰好 2 个今天点（轨迹索引不能越界）+ `causes` 为空
/// （「最近的影响」必须从轨迹兜底）。其余读数照设计稿 quiet 那一幕。
Map<String, dynamic> _previewView() {
  final now = DateTime.now();
  final day = DateTime(now.year, now.month, now.day);
  final history = <Map<String, dynamic>>[
    {
      'atMs': day.add(const Duration(hours: 9)).millisecondsSinceEpoch,
      'valence': 0.10,
      'arousal': 0.36,
      'dominant': 'warmth',
      'reasonCode': 'friendly_contact',
      'strength': 0.18,
    },
    {
      'atMs': day.add(const Duration(hours: 16)).millisecondsSinceEpoch,
      'valence': 0.18,
      'arousal': 0.38,
      'dominant': 'concern',
      'reasonCode': 'owner_success',
      'strength': 0.24,
    },
  ];
  return <String, dynamic>{
    'enabled': true,
    'configured': true,
    'evaluatorEnabled': true,
    'atMs': now.millisecondsSinceEpoch,
    // 85 分钟前：页头右上角那一格要显示相对时间（用户截图里的样子）
    'updatedAt': now.subtract(const Duration(minutes: 85)).toUtc().toIso8601String(),
    'emotions': <String, double>{
      'concern': 0.72,
      'warmth': 0.61,
      'shyness': 0.43,
      'joy': 0.36,
      'distress': 0.12,
      'irritation': 0.08,
    },
    'mood': <String, double>{'valence': 0.18, 'arousal': 0.38},
    // 投影里的 cause 窗口已过期：这正是 Bug 2 的现场，界面要从 history 兜底
    'causes': <dynamic>[],
    'neutral': false,
    'renderLine': '情绪：平静，带一点牵挂。',
    'history': history,
  };
}

/// 亲密那一屏的假数据（`GET /api/intimacy` 的响应形状）：开着、有 6 拍读数、
/// 三档上限里选了「明显」、两条原因、一次"收住"。图里四格读数与走势都要看得出差别。
Map<String, dynamic> _previewIntimacy() {
  final now = DateTime.now();
  return <String, dynamic>{
    'enabled': true,
    'configured': true,
    'privateOnly': true,
    'maxLevel': 'obvious',
    'atMs': now.millisecondsSinceEpoch,
    'updatedAt': now.subtract(const Duration(minutes: 5, seconds: 30)).toUtc().toIso8601String(),
    'intimacy': 62,
    'desire': 41,
    'satisfaction': 73,
    'restraint': 55,
    'level': 'obvious',
    // 状态机：截图里只留「已进入发情」一枚状态 chip（phase 的「发情」不再并排）
    'phase': 'estrus',
    'estrus': true,
    // 四格档位：后端 labels 原样显示（满足/克制不被 maxLevel 封顶）
    'labels': <String, String>{
      'intimacy': '明显',
      'desire': '轻微',
      'satisfaction': '强烈',
      'restraint': '明显',
    },
    'line': '亲密：想靠近一点，但还克制着。',
    'renderLine': '亲密：想靠近一点，但还克制着（明显）。',
    'causes': <dynamic>[
      {
        'atMs': now.subtract(const Duration(minutes: 3, seconds: 30)).millisecondsSinceEpoch,
        'reasonCode': 'owner_close',
        'strength': 0.4,
        'label': '用户主动靠近',
      },
      {
        'atMs': now.subtract(const Duration(minutes: 42, seconds: 30)).millisecondsSinceEpoch,
        'reasonCode': 'long_gap',
        'strength': 0.2,
        'label': '隔了很久没说话',
      },
    ],
    'history': <dynamic>[
      for (var i = 0; i < 6; i += 1)
        {
          'atMs': now.subtract(Duration(minutes: 10 * (6 - i))).millisecondsSinceEpoch,
          'intimacy': 44.0 + i * 3.5,
          'desire': 30.0 + i * 2.4,
          'satisfaction': 58.0 + i * 2.6,
          'restraint': 68.0 - i * 2.2,
        },
    ],
    'cooldownUntilMs': null,
    'stoppedAtMs': now.subtract(const Duration(minutes: 10, seconds: 30)).millisecondsSinceEpoch,
  };
}

void main() {
  HttpServer? server;
  AppState? state;
  late Map<String, dynamic> view;
  late Map<String, dynamic> intimacy;

  setUpAll(() async {
    // 字体要在 testWidgets 的假时钟之外加载（FontLoader 走引擎消息，测试体里会等不到）
    await _loadFont(IrmiaTheme.windowsUiFont);
    await _loadIconFont();
  });

  setUp(() async {
    // 服务端也放 testWidgets 外面：在假时钟里 bind 一个真 socket，测试收尾会等它等到超时
    HttpOverrides.global = null;
    view = _previewView();
    intimacy = _previewIntimacy();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server!.listen((request) async {
      final response = request.response..headers.contentType = ContentType.json;
      if (request.uri.path == '/api/affect') {
        response.write(jsonEncode(view));
      } else if (request.uri.path == '/api/intimacy') {
        response.write(jsonEncode(intimacy));
      } else if (request.uri.path == '/api/stickers') {
        response.write(jsonEncode(<String, dynamic>{'items': [], 'counts': {}, 'settings': {}, 'tags': {}}));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode(<String, dynamic>{'error': {'message': 'not found'}}));
      }
      unawaited(response.close());
    });
  });

  tearDown(() async {
    state?.dispose();
    state = null;
    await server?.close(force: true);
    server = null;
  });

  testWidgets(
    '情绪页预览图：1280×900 渲染到 tmp/emotion-panel-preview.png',
    (tester) async {
      state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server!.port}'));

      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: IrmiaTheme.light(),
          home: Scaffold(
            body: RepaintBoundary(
              key: const ValueKey('mood-preview'),
              child: MediaQuery(
                // 静态截图：关掉浮动动画，避免一帧一帧永远排下去
                data: const MediaQueryData(size: Size(1280, 900), disableAnimations: true),
                // 测试环境的环境默认风格是测试字库（全是方框）；把真字体栈补到继承链上，
                // 图里的字才认得出（与 grant_card_golden_test 同一招）
                child: DefaultTextStyle.merge(
                  style: const TextStyle(fontFamily: IrmiaTheme.windowsUiFont, fontSize: 13),
                  child: MoodPage(state: state!),
                ),
              ),
            ),
          ),
        ),
      );

      // 等数据进来（真实 HTTP 走的是 runAsync 那一侧）。判据必须是**数据到达后**才有的字：
      // 页头的「当前心境」在 loading 那一帧就已经在了，拿它当判据会立刻跳出循环、截到空态。
      var ready = false;
      for (var i = 0; i < 200; i += 1) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
        if (find.text('心境倾向').evaluate().isNotEmpty) {
          ready = true;
          break;
        }
      }
      expect(ready, isTrue, reason: '预览数据没进来（HTTP 桩没被读到）');
      // 再多走几拍：另一个 tab 的 /api/stickers 请求也要落地，别把在飞的请求留到测试收尾
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 200)));
      await tester.pump(const Duration(milliseconds: 800));

      final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(const ValueKey('mood-preview')));
      // 截图要放在 runAsync 里：`toImage` 等的是引擎栅格线程，假时钟区里会一直等下去
      final bytes = await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 1);
        expect(image.width, 1280);
        expect(image.height, 900);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        return data!.buffer.asUint8List();
      });
      final workspace = Directory.current.path.endsWith('gui') ? Directory.current.parent.path : Directory.current.path;
      final target = File('$workspace${Platform.pathSeparator}tmp${Platform.pathSeparator}emotion-panel-preview.png');
      // 真实的盘上写同样要放到 runAsync 里
      await tester.runAsync(() async {
        await target.parent.create(recursive: true);
        await target.writeAsBytes(bytes!);
      });
      debugPrint('emotion panel preview: ${target.path}');

      // 第二张：第三个 tab「亲密」（数据是 /api/intimacy 的响应形状）。
      // 懒加载——点开这个 tab 才会去打那条端点，所以这里点完还要等一轮 runAsync。
      await tester.tap(find.byKey(const ValueKey('mood-tab-2')));
      await tester.pump();
      var intimacyReady = false;
      for (var i = 0; i < 200; i += 1) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
        await tester.pump();
        if (find.byKey(const ValueKey('intimacy-readings')).evaluate().isNotEmpty) {
          intimacyReady = true;
          break;
        }
      }
      expect(intimacyReady, isTrue, reason: '亲密的数据没进来（HTTP 桩没被读到）');
      // 让四条读数的条形动画走完，别截到半截
      await tester.pump(const Duration(milliseconds: 800));

      final intimacyBoundary =
          tester.renderObject<RenderRepaintBoundary>(find.byKey(const ValueKey('mood-preview')));
      final intimacyBytes = await tester.runAsync(() async {
        final image = await intimacyBoundary.toImage(pixelRatio: 1);
        expect(image.width, 1280);
        expect(image.height, 900);
        final data = await image.toByteData(format: ui.ImageByteFormat.png);
        image.dispose();
        return data!.buffer.asUint8List();
      });
      final intimacyTarget =
          File('$workspace${Platform.pathSeparator}tmp${Platform.pathSeparator}intimacy-panel-preview.png');
      await tester.runAsync(() async {
        await intimacyTarget.parent.create(recursive: true);
        await intimacyTarget.writeAsBytes(intimacyBytes!);
      });
      debugPrint('intimacy panel preview: ${intimacyTarget.path}');
    },
    skip: !_enabled,
    timeout: const Timeout(Duration(seconds: 90)),
  );
}
