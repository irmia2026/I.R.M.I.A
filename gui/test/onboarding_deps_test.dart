import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/onboarding.dart';
// 手动打开通道（首页「配置引导」）：第 6 步在那条路上也要走得通
import 'package:irmia_gui/onboarding_request.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 用户第 3 轮（2026-10-20）那五条里，本轮新增/改写的两块：
///
///   **A. 四段说明压成一行**（①第 1 步三处 / ②第 2 步两句合一 / ③第 4 步 / ④第 5 步）：
///      单行、长度上界、关键信息一个不丢；第 2 步"只有一行"用"只有一个 [Wrap]"钉。
///   **B. 第 6 步「外部依赖」**：四件现状来自 `GET /api/deps`、一个勾选框（默认勾上）、
///      勾了之后逐件串行调**既有**的 `POST /api/commands/dep-install`
///      （`X-Confirm: dep-install`，与设置页 `_installDep` 同一套）、已就位跳过、
///      一件失败不中断其余、最后汇总 + 重试；装完弹**顶层窗口**要求重启
///      （「立即重启」接 `restart_action.dart` 的 `performRestart`）。
///
/// 假服务的响应形状照 `src/web/server.ts` 的真实回包写（`/api/deps` 的 entries、
/// `dep-install` 的 `{ok, step, error}`、`restart` 的回执）。
void main() {
  late HttpServer server;
  late AppState state;
  late Directory tmpDir;
  late Map<String, dynamic> config;
  late Map<String, String> depStatus;
  late String? depFailName;
  late bool personaIsSeed;
  late bool depsBroken;
  late List<Map<String, dynamic>> posts;
  late List<String> gets;

  const seedIdentity = '<!-- SEED 填写后删除本行 -->\n# 我是谁\n\n名字：（改成她的名字）\n';
  const zh = ZhStrings();
  const en = EnStrings();

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，本组要打真实服务
    HttpOverrides.global = null;
    posts = [];
    gets = [];
    depStatus = {'pwsh': 'ready', 'rg': 'ready', 'es': 'ready', 'python': 'ready'};
    depFailName = null;
    personaIsSeed = true;
    depsBroken = false;
    config = {
      'models': {
        'heavy': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
        'light': {'model': 'deepseek-chat', 'baseUrl': 'https://api.deepseek.com'},
      },
      'channels': {
        'qqOfficial': {'enabled': false},
        'onebot': {'enabled': false},
        'mentionKeywords': <String>[],
      },
      'trust': {'mode': 'full', 'workspaceRoot': r'C:\work'},
    };
    // 状态文件指向每次独立的临时目录：别踩真实 %APPDATA% 里那份 ui-state.json
    // （第 6 步"上次装完"的记录就写在这里，用例之间必须互不影响）
    tmpDir = Directory.systemTemp.createTempSync('irmia-onboarding-deps-');
    stateFileOverride = '${tmpDir.path}${Platform.pathSeparator}ui-state.json';

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path.startsWith('/api/commands/')) {
        final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        posts.add({'path': path, 'body': body, 'confirm': req.headers.value('X-Confirm')});
        if (path == '/api/commands/dep-install') {
          final name = body['name'] as String;
          if (name == depFailName) {
            // 服务端的"没装成"也是 200（4xx/5xx 会被前端统一弹成"请求失败"）
            response.write(jsonEncode({
              'ok': false,
              'name': name,
              'step': 'download',
              'error': '下载失败（测试里故意让它坏）',
            }));
            // 每个分支都得把响应关掉再返回：漏了它，客户端那条请求永远不结束（实测踩到过）
            await response.close();
            return;
          }
          depStatus[name] = 'ready';
          response.write(jsonEncode({
            'ok': true,
            'name': name,
            'step': 'verify',
            'dir': 'D:/irmia/data/tools/$name',
            'exePath': 'D:/irmia/data/tools/$name/$name.exe',
            'version': '1.2.3',
          }));
          await response.close();
          return;
        }
        if (path == '/api/commands/restart') {
          // 回执照 src/web/server.ts 那一档：scriptOk=true = 链条自己确认成功（不必再等它回来）
          response.write(jsonEncode({
            'ok': true,
            'gui': true,
            'scriptStarted': true,
            'scriptOk': true,
            'backendPid': 4242,
            'port': 'ready',
            'path': 'repo-script',
            'note': '拉起成功',
          }));
          await response.close();
          return;
        }
        response.write(jsonEncode({'ok': true}));
      } else if (path == '/api/config') {
        gets.add(path);
        response.write(jsonEncode(config));
      } else if (path == '/api/keys') {
        gets.add(path);
        response.write(jsonEncode({
          'heavy': {'configured': false, 'mask': null},
        }));
      } else if (path == '/api/deps') {
        gets.add(path);
        if (depsBroken) {
          // 与"服务端没装配依赖管理器"同一档的失败：这条端点整份数据都来自管理器
          response.statusCode = 501;
          response.write(jsonEncode({
            'error': {'code': 'not-implemented', 'message': '依赖管理器没装配'},
          }));
          await response.close();
          return;
        }
        response.write(jsonEncode({
          'available': true,
          'dataDir': 'D:/irmia/data',
          'toolsDir': 'D:/irmia/data/tools',
          'needsAttention': depStatus.values.any((status) => status != 'ready'),
          'generatedAt': '2026-10-20T00:00:00.000Z',
          'entries': [
            for (final entry in depStatus.entries)
              {
                'name': entry.key,
                'label': entry.key,
                'status': entry.value,
                'path': entry.value == 'ready' ? 'C:/tools/${entry.key}.exe' : '',
                'version': entry.value == 'ready' ? '1.2.3' : '',
                'source': 'path',
                'reason': '',
                'purpose': '',
                'impact': '',
                'action': entry.value == 'ready' ? null : 'install',
                'installable': true,
                'downloadPage': null,
                'manualHint': null,
                'minVersion': '7.0',
                'managedDir': 'D:/irmia/data/tools/${entry.key}',
                'pipVersion': null,
                'pipReason': '',
              },
          ],
        }));
      } else if (path == '/api/persona/files') {
        gets.add(path);
        response.write(jsonEncode({
          'root': 'D:/irmia/data/persona',
          'files': [
            {
              'path': 'IDENTITY.md',
              'name': 'IDENTITY.md',
              'bytes': 80,
              'mtime': '2026-10-01T00:00:00.000Z',
              'reserved': true,
              'tokens': 20,
              'proposalCount': 0,
              'proposals': 0,
              'isSeed': personaIsSeed,
            },
          ],
          'relationships': <String>[],
          'proposals': <String>[],
        }));
      } else if (path == '/api/persona/file') {
        gets.add(path);
        response.write(jsonEncode({
          'path': 'IDENTITY.md',
          'content': seedIdentity,
          'bytes': 80,
          'mtime': '2026-10-01T00:00:00.000Z',
          'tokens': 20,
          'reserved': true,
        }));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'message': '接口不存在'}}));
      }
      unawaited(response.close());
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
    try {
      tmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 临时目录清不掉不影响断言
    }
    stateFileOverride = null;
  });

  /// 交替推进真异步与假时钟（与 onboarding_test.dart 同一手法）
  Future<void> settle(WidgetTester tester, {int rounds = 30, int ms = 20}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(Duration(milliseconds: ms)));
      await tester.pump();
    }
  }

  /// 等到某个东西出现（装依赖是**真的** HTTP 往返：不交替推事件循环就永远看不到结果）
  Future<void> waitFor(WidgetTester tester, Finder target, {int rounds = 120, int ms = 20}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(Duration(milliseconds: ms)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) return;
    }
    fail('等待目标未出现：$target');
  }

  /// 收尾：把 toast 的定时器与"退场后销毁控制器"的定时器都跑完，再拆树。
  ///
  /// 顺序很重要：**先**推假时钟把 toast 跑完，**再**拆树（拆树时 `disposeLater` 才排下
  /// "退场后销毁控制器"那几个 600ms 定时器），最后再推一次把它推掉——
  /// 反过来的话测试收尾会报 "A Timer is still pending"（实测踩到过）。
  Future<void> closeOut(WidgetTester tester) async {
    await tester.pump(IrmiaToast.duration);
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
    await tester.pump();
    await settle(tester, rounds: 4);
  }

  Future<void> pumpHost(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1350, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: OnboardingHost(
        state: state,
        child: const Scaffold(body: Center(child: Text('壳'))),
      ),
    ));
    await settle(tester);
  }

  /// 等卡片弹出来（首次那条路：人格还是种子模板 ⇒ 判据说该弹）
  Future<void> expectCardShown(WidgetTester tester) async {
    await waitFor(tester, find.text(kOnboardingTitle));
  }

  /// 点一个文字按钮（一律在**卡片内部**找：壳上可能也有同名文字）
  Future<void> tapInCard(WidgetTester tester, Finder target) async {
    final inCard = find.descendant(of: find.byType(Dialog), matching: target);
    await waitFor(tester, inCard, rounds: 60);
    await tester.tap(inCard);
    await tester.pump();
    await settle(tester, rounds: 10);
  }

  /// 卡脚那颗主按钮（「继续」/「完成」）
  Future<void> tapPrimary(WidgetTester tester) async {
    final button = find.descendant(of: find.byType(Dialog), matching: find.byType(FilledButton));
    await waitFor(tester, button, rounds: 60);
    await tester.tap(button.first);
    await tester.pump();
    await settle(tester, rounds: 10);
  }

  /// 从第 1 步走到第 6 步（一路「跳过这一步」：前五步一个字节都不写）
  Future<void> goToDeps(WidgetTester tester, {bool expectRows = true}) async {
    for (var i = 0; i < 5; i++) {
      await tapInCard(tester, find.text(kOnboardingSkipLabel));
    }
    await waitFor(tester, find.text(zh.onboardingStepDepsTitle).first);
    if (expectRows) await waitFor(tester, find.byKey(const ValueKey('onboarding-dep-pwsh')));
  }

  /// 手动打开那张卡（首页「配置引导」走的是同一条通道）：
  /// 先把假服务的那台机器设成"已经配好"（人格不是种子），自动判据就不会弹，
  /// 于是这一趟的 `posts` 干净——"未勾选 ⇒ 零请求"才能逐字断言。
  Future<void> openManually(WidgetTester tester) async {
    personaIsSeed = false;
    await pumpHost(tester);
    await settle(tester, rounds: 15);
    expect(find.text(kOnboardingTitle), findsNothing, reason: '配好的机器不该自动弹');
    requestOnboarding();
    await waitFor(tester, find.text(kOnboardingTitle));
  }

  Finder depRow(String name) => find.byKey(ValueKey('onboarding-dep-$name'));

  Finder depStatusText(String name, String status) =>
      find.descendant(of: depRow(name), matching: find.text(status));

  Finder depResultText(String name) => find.byKey(ValueKey('onboarding-dep-result-$name'));

  List<Map<String, dynamic>> postsOf(String path) =>
      posts.where((entry) => entry['path'] == path).toList();

  const depInstallPath = '/api/commands/dep-install';
  const restartPath = '/api/commands/restart';

  // ────────────────────────── A：四段文案压成一行 ──────────────────────────

  group('A · 四段说明压成一行（单行 / 长度上界 / 关键信息不丢）', () {
    /// 单行 + 长度上界 + 首尾不挂空白 + 最多一个句末标点。
    ///
    /// [before] 是**压之前那份的字数**（写死在用例里）：谁把它改回去、或者又长回去，这条就红。
    void oneLine(String label, String after, {required int before, required int limit}) {
      expect(after.contains('\n'), isFalse, reason: '$label 里不许有换行');
      expect(after.contains('\r'), isFalse, reason: '$label 里不许有回车');
      expect(after.trim(), after, reason: '$label 首尾不许挂空白');
      expect(after.length, lessThanOrEqualTo(limit),
          reason: '$label 现在 ${after.length} 字，上界钉在 $limit');
      if (before > 0) {
        expect(after.length, lessThan(before), reason: '$label 要比压之前（$before 字）短');
      }
      // "不许两句"：中文按句号数、英文按 ". " 数，最多一个句末标点
      expect('。'.allMatches(after).length, lessThanOrEqualTo(1), reason: '$label 不许两句');
      expect(RegExp(r'\.\s').allMatches(after).length, lessThanOrEqualTo(1),
          reason: '$label 不许两句（英文按 ". " 数）');
    }

    test('① 第 1 步名字框上方那段（原来 50 字）', () {
      oneLine('onboardingStepNameNote', zh.onboardingStepNameNote, before: 50, limit: 40);
      // 关键因果一个不丢：名字 = 身份；词表 = 群里喊哪些词算在叫她；不打 @ 也算
      expect(zh.onboardingStepNameNote, contains('身份'));
      expect(zh.onboardingStepNameNote, contains('词表'));
      expect(zh.onboardingStepNameNote, contains('叫'));
      expect(zh.onboardingStepNameNote, contains('@'));
      oneLine('en.onboardingStepNameNote', en.onboardingStepNameNote, before: 0, limit: 120);
      expect(en.onboardingStepNameNote, contains('identity'));
      expect(en.onboardingStepNameNote, contains('word list'));
    });

    test('① 第 1 步名字框下方那段（原来 82 字：写哪儿 / 快照能回滚 / 界面上的称呼）', () {
      oneLine('onboardingStepNameHint', zh.onboardingStepNameHint, before: 82, limit: 64);
      expect(zh.onboardingStepNameHint, contains('persona/IDENTITY.md'));
      expect(zh.onboardingStepNameHint, contains('「名字：」'));
      expect(zh.onboardingStepNameHint, contains('快照'));
      expect(zh.onboardingStepNameHint, contains('回滚'));
      expect(zh.onboardingStepNameHint, contains('称呼'));
      oneLine('en.onboardingStepNameHint', en.onboardingStepNameHint, before: 0, limit: 165);
      expect(en.onboardingStepNameHint, contains('IDENTITY.md'));
    });

    test('① 第 1 步词表下方那段（原来 64 字：分隔符 / 同平台 @ / 清空 = 只认 @）', () {
      oneLine('onboardingKeywordsHint', zh.onboardingKeywordsHint, before: 64, limit: 52);
      expect(zh.onboardingKeywordsHint, contains('顿号'));
      expect(zh.onboardingKeywordsHint, contains('在叫她'));
      expect(zh.onboardingKeywordsHint, contains('@'));
      expect(zh.onboardingKeywordsHint, contains('清空'));
      oneLine('en.onboardingKeywordsHint', en.onboardingKeywordsHint, before: 0, limit: 165);
      expect(en.onboardingKeywordsHint, contains('commas'));
    });

    test('② 第 2 步两句推荐语合成一行（原来是两个段落：20 字 + 17 字）', () {
      final line = '${zh.onboardingApiRecommendLead}${zh.onboardingApiRecommendModel}'
          '${zh.onboardingApiRecommendJoin}${zh.onboardingApiRegisterKey}';
      // 两段合一之后只多了一个连接词（38 = 20 + 17 + 1）：字数没涨，行数从两行变一行
      expect(line.length, 20 + 17 + zh.onboardingApiRecommendJoin.length);
      oneLine('onboarding api recommend', line, before: 0, limit: 42);
      expect(zh.onboardingApiRecommendJoin.trim(), isNotEmpty, reason: '两段之间要有个连接词才读得成一句');
      expect(line, contains('DeepSeek'));
      expect(line, contains('API Key'));
      final enLine = '${en.onboardingApiRecommendLead}${en.onboardingApiRecommendModel}'
          '${en.onboardingApiRecommendJoin}${en.onboardingApiRegisterKey}';
      expect(enLine.contains('\n'), isFalse);
      expect('。'.allMatches(enLine).length, 0);
      expect(enLine.length, lessThanOrEqualTo(80));
    });

    test('③ 第 4 步人格说明压成一行（原来 80 字三句）', () {
      oneLine('onboardingPersonaHint', zh.onboardingPersonaHint, before: 80, limit: 56);
      // 四条关键信息：整份替换 / 服务端留快照可回滚 / 留空或没改动就不写 / 名字行别删
      expect(zh.onboardingPersonaHint, contains('替换整份文件'));
      expect(zh.onboardingPersonaHint, contains('快照'));
      expect(zh.onboardingPersonaHint, contains('回滚'));
      expect(zh.onboardingPersonaHint, contains('留空或没改动就不写'));
      expect(zh.onboardingPersonaHint, contains('「名字：」'));
      expect(zh.onboardingPersonaHint, contains('别删'));
      oneLine('en.onboardingPersonaHint', en.onboardingPersonaHint, before: 0, limit: 195);
      expect(en.onboardingPersonaHint, contains('snapshot'));
    });

    test('④ 第 5 步信任范围说明压成一行（原来 79 / 97 字）', () {
      oneLine('onboardingTrustNoteSame', zh.onboardingTrustNoteSame, before: 79, limit: 68);
      oneLine('onboardingTrustNoteChanged', zh.onboardingTrustNoteChanged, before: 97, limit: 82);
      for (final note in [zh.onboardingTrustNoteSame, zh.onboardingTrustNoteChanged]) {
        expect(note, contains('边界'), reason: '它是边界，不是提醒');
        expect(note, contains('命令'), reason: '越界的命令会被拒');
        expect(note, contains('pwsh'), reason: '谁执行这条边界（fs 与 pwsh 都管）');
        expect(note, contains('设置页'), reason: '之后在哪儿改');
      }
      expect(zh.onboardingTrustNoteSame, contains('不写盘'));
      expect(zh.onboardingTrustNoteChanged, contains('config.json'));
      expect(zh.onboardingTrustNoteChanged, contains('重启'));
      // 英文两份也是单行
      for (final note in [en.onboardingTrustNoteSame, en.onboardingTrustNoteChanged]) {
        expect(note.contains('\n'), isFalse);
        expect(RegExp(r'\.\s').allMatches(note).length, lessThanOrEqualTo(2));
        expect(note, contains('boundary'));
        expect(note, contains('pwsh'));
      }
    });

    test('第 6 步的说明一句点名四件（pwsh / rg / es / python）', () {
      oneLine('onboardingStepDepsNote', zh.onboardingStepDepsNote, before: 0, limit: 60);
      expect(zh.onboardingStepDepsNote, contains('pwsh'));
      expect(zh.onboardingStepDepsNote, contains('rg'));
      expect(zh.onboardingStepDepsNote, contains('es'));
      expect(zh.onboardingStepDepsNote, contains('python'));
      expect(zh.onboardingStepDepsNote, contains('用不了'));
      expect(en.onboardingStepDepsNote.contains('\n'), isFalse);
      for (final name in ['pwsh', 'rg', 'es', 'python']) {
        expect(en.onboardingStepDepsNote, contains(name));
      }
    });
  });

  testWidgets('② 第 2 步那两句推荐语在界面上只占一行（只有一个 Wrap）', (tester) async {
    await pumpHost(tester);
    await expectCardShown(tester);
    await tapInCard(tester, find.text(kOnboardingSkipLabel)); // 第 1 步 → 第 2 步

    final line = find.byKey(const ValueKey('onboarding-api-recommend'));
    await waitFor(tester, line);
    expect(line, findsOneWidget, reason: '合成一行 = 只有一个 Wrap 装着整句话');
    final wrap = tester.widget<Wrap>(line);
    expect(wrap.children, hasLength(4), reason: '前导语 + DeepSeek 那颗蓝链 + 连接词 + 注册那颗蓝链');
    for (final part in [
      zh.onboardingApiRecommendLead,
      zh.onboardingApiRecommendModel,
      zh.onboardingApiRecommendJoin,
      zh.onboardingApiRegisterKey,
    ]) {
      expect(find.descendant(of: line, matching: find.text(part)), findsOneWidget,
          reason: '「$part」要排在同一行里');
    }
    // 两行那个旧形状的反面：注册那颗蓝链只出现一次，且就在这一行里
    expect(find.text(zh.onboardingApiRegisterKey), findsOneWidget);
    await closeOut(tester);
  });

  // ────────────────────── B：第 6 步「外部依赖」 ──────────────────────

  group('B · 第 6 步「外部依赖」', () {
    testWidgets('第 6 步在、步骤条是 6 步、四件现状来自 /api/deps', (tester) async {
      depStatus = {'pwsh': 'ready', 'rg': 'missing', 'es': 'version-mismatch', 'python': 'missing'};
      await pumpHost(tester);
      await expectCardShown(tester);

      // 步骤条：6 步（标题与正文标题是同一句）
      expect(_stepTitles(zh), hasLength(6));
      expect(find.text('1 / 6'), findsOneWidget);
      expect(find.text(zh.onboardingStepDepsTitle), findsOneWidget, reason: '步骤条上已经有第 6 格');

      await goToDeps(tester);
      expect(find.text('6 / 6'), findsOneWidget, reason: '五步之后还有第 6 步');
      expect(find.text(zh.onboardingStepDepsTitle), findsWidgets);
      expect(gets, contains('/api/deps'), reason: '现状只从既有那条 /api/deps 读');

      // 四件按固定顺序自上而下摆出来（顺序是界面的事，不跟服务端 entries 的顺序走）
      expect(kOnboardingDepNames, ['pwsh', 'rg', 'es', 'python']);
      final ys = [for (final name in kOnboardingDepNames) tester.getTopLeft(depRow(name)).dy];
      expect(ys, orderedEquals([...ys]..sort()), reason: 'pwsh / rg / es / python 自上而下');

      // 状态逐件对：ready = 就位；missing 与 version-mismatch 都按未就位（那一档同样要装）
      expect(depStatusText('pwsh', zh.onboardingDepsStatusReady), findsOneWidget);
      expect(depStatusText('rg', zh.onboardingDepsStatusMissing), findsOneWidget);
      expect(depStatusText('es', zh.onboardingDepsStatusMissing), findsOneWidget);
      expect(depStatusText('python', zh.onboardingDepsStatusMissing), findsOneWidget);

      // 有没就位的 ⇒ 摆勾选框，默认勾上
      final box = tester.widget<Checkbox>(find.byKey(const ValueKey('onboarding-deps-install')));
      expect(box.value, isTrue, reason: '默认勾上');
      expect(find.text(zh.onboardingDepsInstallLabel), findsOneWidget);
      expect(posts, isEmpty, reason: '只是走进这一屏：一个写请求都不该发');
      await closeOut(tester);
    });

    testWidgets('勾选后点「完成」⇒ 逐件串行调 dep-install（顺序 + X-Confirm），已就位跳过，一件失败不中断其余',
        (tester) async {
      depStatus = {'pwsh': 'missing', 'rg': 'ready', 'es': 'missing', 'python': 'missing'};
      depFailName = 'es'; // 中间那一件失败：后面的 python 必须照旧往下装
      await pumpHost(tester);
      await expectCardShown(tester);
      await goToDeps(tester);

      await tapPrimary(tester); // 「完成」⇒ 自动开始安装

      // 整轮结束的标志就是那个顶层窗口：等它出现，安装才是"全部结束"（否则会读到半截列表）
      await waitFor(tester, find.text(zh.onboardingRestartTitle));

      final installs = postsOf(depInstallPath);
      expect([for (final entry in installs) (entry['body'] as Map)['name']], ['pwsh', 'es', 'python'],
          reason: '已就位的 rg 跳过；顺序 = 界面上的顺序 = 串行');
      for (final entry in installs) {
        expect(entry['confirm'], 'dep-install',
            reason: '与设置页 _installDep 同一套：同端点、同确认短语（服务端按危险操作登记）');
      }

      // 装成功过 ⇒ 顶层窗口要求重启（这里先按「稍后」；「立即重启」那条另有专门用例）
      await tester.tap(find.byKey(const ValueKey('onboarding-restart-later')));
      await tester.pump();
      await settle(tester, rounds: 12);

      // 一件失败不中断其余：pwsh / python 成功，es 失败并给出原因
      expect(tester.widget<Text>(depResultText('es')).data,
          zh.onboardingDepsItemFailed('下载失败（测试里故意让它坏）'));
      expect(depStatusText('es', zh.onboardingDepsStatusMissing), findsOneWidget);
      expect(depStatusText('pwsh', zh.onboardingDepsStatusReady), findsOneWidget,
          reason: '装成的那一件现状当场点亮（服务端装完就地复检过）');
      expect(depStatusText('python', zh.onboardingDepsStatusReady), findsOneWidget,
          reason: '前面一件失败不影响后面那件');

      // 汇总 + 重试，且留在这一屏
      expect(find.text(zh.onboardingDepsSummary(2, 1)), findsOneWidget);
      expect(find.byKey(const ValueKey('onboarding-deps-retry')), findsOneWidget);
      expect(find.text(kOnboardingTitle), findsOneWidget, reason: '有失败 ⇒ 留在这一屏，让人重试');

      // 复查：结局落了盘（同一页再打开要看得见）
      final saved = await tester.runAsync(() => loadDepsAttempt());
      expect(saved, isNotNull);
      expect(saved!.ok, 2);
      expect(saved.failed, 1);
      expect(saved.failures.keys, ['es']);
      expect(saved.checked, isTrue);
      expect(postsOf(restartPath), isEmpty, reason: '点了「稍后」⇒ 重启请求一个字节都不发');
      await closeOut(tester);
    });

    testWidgets('全部结束后弹顶层窗口；「立即重启」走既有那条重启（同端点、同短语）', (tester) async {
      depStatus = {'pwsh': 'missing', 'rg': 'missing', 'es': 'ready', 'python': 'ready'};
      await pumpHost(tester);
      await expectCardShown(tester);
      await goToDeps(tester);

      await tapPrimary(tester);
      await waitFor(tester, find.text(zh.onboardingRestartTitle));

      // 它就是一张压在引导卡之上的 dialog（顶层窗口）：标题 + 一句原因 + 两个按钮
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text(zh.onboardingRestartBody), findsOneWidget);
      expect(find.text(zh.onboardingRestartLater), findsOneWidget);
      expect(find.text(zh.onboardingRestartNow), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('onboarding-restart-now')));
      await tester.pump();
      await settle(tester, rounds: 25);

      final restart = postsOf(restartPath);
      expect(restart, hasLength(1), reason: '「立即重启」接的就是 restart_action.dart 那条 performRestart');
      expect(restart.single['confirm'], 'restart', reason: '同一条命令、同一个确认短语（首页与托盘也走它）');
      expect(restart.single['body'], containsPair('guiExe', isA<String>()),
          reason: '身体里带着界面自己的可执行路径：给了路径就要连界面一起重启');
      expect(find.text(kOnboardingTitle), findsNothing, reason: '重启那条路走完、卡片收起，回到首页');
      expect(find.text('壳'), findsOneWidget);
      await closeOut(tester);
    });

    testWidgets('未勾选 ⇒ 零请求（一个 dep-install 都不发，卡片照常走完）', (tester) async {
      depStatus = {'pwsh': 'missing', 'rg': 'missing', 'es': 'ready', 'python': 'ready'};
      await openManually(tester);
      await goToDeps(tester);

      await tester.tap(find.byKey(const ValueKey('onboarding-deps-install')));
      await tester.pump();
      expect(tester.widget<Checkbox>(find.byKey(const ValueKey('onboarding-deps-install'))).value, isFalse);

      await tapPrimary(tester); // 「完成」
      await settle(tester, rounds: 20);

      expect(posts, isEmpty, reason: '没勾 = 零请求（装依赖属用户主动勾选，不许替人决定）');
      expect(find.text(kOnboardingTitle), findsNothing, reason: '不装也走得完');
      expect(find.text(zh.onboardingRestartTitle), findsNothing, reason: '一件都没装 ⇒ 没有"要重启"这回事');

      // 勾选状态也落了盘：下次打开这一屏要能复查"上次没勾"
      final saved = await tester.runAsync(() => loadDepsAttempt());
      expect(saved, isNotNull);
      expect(saved!.checked, isFalse);
      expect(saved.hasResult, isFalse);
      await closeOut(tester);
    });

    testWidgets('四件都已就位：说"都已就位"、不摆勾选框，直接完成（零 dep-install）', (tester) async {
      await openManually(tester);
      await goToDeps(tester);

      expect(find.text(zh.onboardingDepsAllReady), findsOneWidget);
      expect(find.byKey(const ValueKey('onboarding-deps-install')), findsNothing);
      for (final name in kOnboardingDepNames) {
        expect(depStatusText(name, zh.onboardingDepsStatusReady), findsOneWidget);
      }

      await tapPrimary(tester);
      await settle(tester, rounds: 20);
      expect(posts, isEmpty);
      expect(find.text(kOnboardingTitle), findsNothing);
      await closeOut(tester);
    });

    testWidgets('读不到依赖状态：如实说读不到、不猜"都没装"（零请求，卡片照常能走完）', (tester) async {
      depsBroken = true; // /api/deps 回 501：与"服务端没装配依赖管理器"同一档
      await openManually(tester);
      await goToDeps(tester, expectRows: false);

      await waitFor(tester, find.textContaining('读不到依赖状态'));
      expect(find.byKey(const ValueKey('onboarding-dep-pwsh')), findsNothing);
      expect(find.byKey(const ValueKey('onboarding-deps-install')), findsNothing,
          reason: '四件就位与否都不知道 ⇒ 不摆勾选框（装什么都是瞎猜）');

      await tapPrimary(tester);
      await settle(tester, rounds: 20);
      expect(posts, isEmpty, reason: '读不到就不装');
      expect(find.text(kOnboardingTitle), findsNothing);
      await closeOut(tester);
    });

    testWidgets('手动打开（首页「配置引导」）也走得通第 6 步：安装 + 重启窗口', (tester) async {
      depStatus = {'pwsh': 'missing', 'rg': 'ready', 'es': 'ready', 'python': 'ready'};
      await openManually(tester);
      await goToDeps(tester);
      await tapPrimary(tester);

      final installs = postsOf(depInstallPath);
      expect([for (final entry in installs) (entry['body'] as Map)['name']], ['pwsh']);
      expect(installs.single['confirm'], 'dep-install');
      await waitFor(tester, find.text(zh.onboardingRestartTitle));
      await tester.tap(find.byKey(const ValueKey('onboarding-restart-later')));
      await tester.pump();
      await settle(tester, rounds: 12);
      expect(find.text(kOnboardingTitle), findsNothing, reason: '手动那条路也走得完（全装成了就收卡回首页）');
      // 手动打开不碰首次判据
      final flag = await tester.runAsync(() => loadFlag(kOnboardingDoneFlag));
      expect(flag, isFalse, reason: '手动打开不许消费"第一次启动该弹一次"那条判据');
      await closeOut(tester);
    });

    testWidgets('复查：同一页再打开时看得见上次装完 / 失败，勾选状态也照上次那个决定', (tester) async {
      depStatus = {'pwsh': 'missing', 'rg': 'ready', 'es': 'ready', 'python': 'ready'};
      // 上一次的结局（真实那条路会由 _runDepsRound 落盘；这里直接摆好，专钉"读回来"这一半）
      await tester.runAsync(() => saveDepsAttempt(const DepsAttempt(
            checked: false,
            ok: 1,
            failed: 1,
            failures: {'python': '解压失败（上次的现场）'},
          )));

      await pumpHost(tester);
      await expectCardShown(tester);
      await goToDeps(tester);

      expect(find.text(zh.onboardingDepsLastRun(1, 1)), findsOneWidget, reason: '上次装完的结果要复查得到');
      expect(find.text(zh.onboardingDepsItemFailed('解压失败（上次的现场）')), findsOneWidget,
          reason: '失败的那一件要点名说清为什么');
      expect(
        tester.widget<Checkbox>(find.byKey(const ValueKey('onboarding-deps-install'))).value,
        isFalse,
        reason: '上次没勾 ⇒ 这次打开照上次那个决定（复查的另一个半边）',
      );

      // 复查之后照样能改主意：勾上再点完成就真的装
      await tester.tap(find.byKey(const ValueKey('onboarding-deps-install')));
      await tester.pump();
      await tapPrimary(tester);
      expect([for (final entry in postsOf(depInstallPath)) (entry['body'] as Map)['name']], ['pwsh']);
      await waitFor(tester, find.text(zh.onboardingRestartTitle));
      await tester.tap(find.byKey(const ValueKey('onboarding-restart-later')));
      await tester.pump();
      await settle(tester, rounds: 12);
      await closeOut(tester);
    });
  });
}

/// 六步的标题（顺序与 onboarding.dart 的 `_stepKeys` 一致：这一条只用来数"是不是 6 步"）
List<String> _stepTitles(AppStrings s) => [
      s.onboardingStepNameTitle,
      s.onboardingStepApiTitle,
      s.onboardingStepChannelTitle,
      s.onboardingStepPersonaTitle,
      s.onboardingStepTrustTitle,
      s.onboardingStepDepsTitle,
    ];
