// 引导第 2 步「API 配置」——**模型探测 / 可搜索模型列表 / 密钥状态**（2026-10-26）。
//
// 这一份用**真实 loopback 假服务**（`HttpServer`）钉住界面那一半：
//   ① 点「探测」→ 结果区展开（摘要 + 模型列表 + 每行协议徽章），请求体是 `{lane, baseUrl}`；
//   ② 搜索框按子串过滤（大小写不敏感）；
//   ③ 点中一个模型 ⇒ 写回「模型名」输入框；
//   ④ **反向断言：这一屏没有协议单选**（三档文案 / 单选组 / 单选圆点一个都不在，2026-10-26
//      用户：「算了，协议项不放在引导第二步吧，有点占位置了」）；
//   ⑤ 三档失败文案各自出现（不可达 / 密钥无效 / 没有 /models），且**输入一个字都不丢**；
//   ⑥ 点「继续」⇒ `config-update` 的 fields 里**只有** `model` 与 `baseUrl`
//      （**没有** `models.heavy.protocol`——协议不在这屏问，也就不该在这屏写）；
//   ⑦ Base URL 空着点探测 ⇒ 就地红字、**零请求**；
//   ⑧ 密钥状态行：未配置 / 已写入 heavy / light（不显示内容）；
//   ⑨ 探测结论"只通一套协议"⇒ 一行**中性事实**（"该端点只支持 …"），不是"建议去选某一档"。
//
// 为什么不复用 `onboarding_test.dart` 的宿主：那一条路要先读一遍 `/api/config`、`/api/keys`、
// persona……才能弹卡；这一份要验的是"第 2 步本身"，直接把 [OnboardingSignals] 摆好，
// 从第 1 步点「跳过」进第 2 步，读数与断言都只围着这一步转。

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/onboarding.dart';
import 'package:irmia_gui/theme.dart';

void main() {
  late HttpServer server;
  late AppState state;
  late List<Map<String, dynamic>> probes;
  late List<Map<String, dynamic>> configUpdates;
  late List<Map<String, dynamic>> setKeys;
  late Map<String, dynamic> probeReply;
  late String? lastConfirm;

  const baseUrl = 'https://api.example.test/v1';

  /// 探测成功的回包（形状照 `src/model/probe.ts` 的 `ModelProbeSuccess`）
  Map<String, dynamic> successReply({bool responsesOk = true, bool chatOk = true}) => <String, dynamic>{
        'ok': true,
        'models': <String>['deepseek-chat', 'gemini-3.8-flash'],
        'modelsLatencyMs': 812,
        'responses': <String, dynamic>{'supported': responsesOk, 'latencyMs': 780, 'status': responsesOk ? 200 : 404},
        'chat': <String, dynamic>{'supported': chatOk, 'latencyMs': 640, 'status': chatOk ? 200 : 500},
        'recommended': responsesOk && chatOk ? 'gemini-3.8-flash' : null,
        'warnings': <String>[],
      };

  OnboardingSignals buildSignals({
    String model = 'alpha-model',
    bool keyConfigured = false,
  }) =>
      OnboardingSignals(
        identityIsSeed: true,
        apiReady: false,
        channelsReady: false,
        model: model,
        baseUrl: baseUrl,
        apiKeyConfigured: keyConfigured,
        apiKeyGates: const <String>['heavy', 'light'],
        apiKeyGatesConfigured: keyConfigured ? const <String>['heavy', 'light'] : const <String>[],
        qqEnabled: false,
        onebotEnabled: false,
        qqAppId: SecretState.absent,
        qqClientSecret: SecretState.absent,
        mentionKeywords: const <String>[],
        identityContent: '名字：小七\n\n她是小七。\n',
        herName: '小七',
        trustMode: 'full',
        trustRoot: 'D:/work',
      );

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400，这一组要打真实服务
    HttpOverrides.global = null;
    probes = <Map<String, dynamic>>[];
    configUpdates = <Map<String, dynamic>>[];
    setKeys = <Map<String, dynamic>>[];
    probeReply = successReply();
    lastConfirm = null;
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final path = req.uri.path;
      final text = await utf8.decoder.bind(req).join();
      final body = text.trim().isEmpty ? <String, dynamic>{} : jsonDecode(text) as Map<String, dynamic>;
      final response = req.response..headers.contentType = ContentType.json;
      if (req.headers.value('X-Confirm') != null) lastConfirm = req.headers.value('X-Confirm');
      if (path == '/api/models/probe') {
        probes.add(body);
        response.write(jsonEncode(probeReply));
      } else if (path == '/api/commands/config-update') {
        configUpdates.add(body);
        final fields = (body['fields'] as Map).keys.toList(growable: false);
        response.write(jsonEncode({'ok': true, 'fields': fields, 'configHash': 'test'}));
      } else if (path == '/api/commands/set-key') {
        setKeys.add(body);
        response.write(jsonEncode({
          'ok': true,
          'name': body['name'],
          'configured': true,
          'mask': 'sk-…t3st',
          'source': 'file',
          'gates': <String>['heavy', 'light'],
          'changed': <String>['heavy', 'light'],
          'skipped': <Object>[],
        }));
      } else {
        response.statusCode = 404;
        response.write(jsonEncode({'error': {'code': 'not-found', 'message': '接口不存在'}}));
      }
      await response.close();
    });
    state = AppState(api: IrmiaApi(baseUrl: 'http://127.0.0.1:${server.port}'));
  });

  tearDown(() async {
    state.dispose();
    await server.close(force: true);
  });

  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 100}) async {
    for (var i = 0; i < rounds; i += 1) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  Future<void> tapAndSettle(WidgetTester tester, Finder target) async {
    final inCard = find.descendant(of: find.byType(Dialog), matching: target);
    await pumpUntil(tester, inCard);
    await tester.tap(inCard.first);
    await tester.pump();
    for (var i = 0; i < 12; i += 1) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
  }

  /// 打开引导卡并从第 1 步「跳过」进第 2 步（第 2 步的界面话才在树上）
  Future<void> openApiStep(WidgetTester tester, OnboardingSignals signals) async {
    tester.view.physicalSize = const Size(1350, 1000);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              key: const ValueKey('open-onboarding'),
              onPressed: () => unawaited(showOnboardingCard(
                context,
                state: state,
                signals: signals,
                fromFirstRun: true,
              )),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.byKey(const ValueKey('open-onboarding')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    await tapAndSettle(tester, find.text(kOnboardingSkipLabel));
    expect(find.text(const ZhStrings().onboardingStepApiTitle), findsWidgets, reason: '应当在第 2 步');
  }

  /// 点那一颗「探测」并等这一次请求真正落地（真实 I/O 要靠 runAsync 推）
  Future<void> tapProbe(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('onboarding-probe')));
    await tester.pump();
    for (var i = 0; i < 20; i += 1) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }
  }

  String textOf(WidgetTester tester, String key) =>
      tester.widget<TextField>(find.byKey(ValueKey(key))).controller!.text;

  testWidgets('① 点探测：结果区展开，摘要 + 模型列表 + 每行协议徽章都在', (tester) async {
    await openApiStep(tester, buildSignals());
    expect(find.byKey(const ValueKey('onboarding-probe-result')), findsNothing, reason: '还没探测，不展开结果区');

    await tapProbe(tester);
    expect(find.byKey(const ValueKey('onboarding-probe-result')), findsOneWidget);
    expect(probes, hasLength(1));
    expect(probes.single['lane'], 'heavy');
    expect(probes.single['baseUrl'], baseUrl);
    expect(probes.single.containsKey('apiKey'), isFalse, reason: '框里没打密钥就不该带这一格');

    expect(
      find.text('探测完成：2 个模型 · Responses 780ms ✓ · Chat 640ms ✓ · 推荐 gemini-3.8-flash'),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('onboarding-probe-model-deepseek-chat')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-probe-model-gemini-3.8-flash')), findsOneWidget);
    expect(find.text('Responses ✓'), findsNWidgets(2), reason: '每个模型行右侧都标 Responses ✓');
    expect(find.text('Chat ✓'), findsNWidgets(2));

    // 收尾：拆树 flush 掉控制器销毁的定时器
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('② 搜索框过滤模型列表（大小写不敏感，清空恢复全量）', (tester) async {
    await openApiStep(tester, buildSignals());
    await tapProbe(tester);

    await tester.enterText(find.byKey(const ValueKey('onboarding-probe-search')), 'FLASH');
    await tester.pump();
    expect(find.byKey(const ValueKey('onboarding-probe-model-gemini-3.8-flash')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-probe-model-deepseek-chat')), findsNothing);

    await tester.enterText(find.byKey(const ValueKey('onboarding-probe-search')), 'no-such-model');
    await tester.pump();
    expect(find.byKey(const ValueKey('onboarding-probe-no-match')), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('onboarding-probe-search')), '');
    await tester.pump();
    expect(find.byKey(const ValueKey('onboarding-probe-model-deepseek-chat')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-probe-model-gemini-3.8-flash')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('③ 点中一个模型 ⇒ 写回「模型名」输入框', (tester) async {
    await openApiStep(tester, buildSignals());
    await tapProbe(tester);
    expect(textOf(tester, 'onboarding-model'), 'alpha-model');

    await tester.tap(find.byKey(const ValueKey('onboarding-probe-model-gemini-3.8-flash')));
    await tester.pump();
    expect(textOf(tester, 'onboarding-model'), 'gemini-3.8-flash', reason: '选中即写进模型名那一格');

    // 再点另一个，输入框跟着换（列表里的选中高亮只是结果区的视觉，真相是这一格）
    await tester.tap(find.byKey(const ValueKey('onboarding-probe-model-deepseek-chat')));
    await tester.pump();
    expect(textOf(tester, 'onboarding-model'), 'deepseek-chat');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('④ 反向断言：引导第 2 步页面上**没有**协议三档（文案 / 单选组 / 单选圆点都不在）', (tester) async {
    await openApiStep(tester, buildSignals());

    // 三个选项的**文案**一个都不许出现（用字面量而不是 getter：那三个 getter 已经删了——
    // 这一条要钉的正是"页面上没人念这三句话"，而不是"文案表里还有没有那几条"）。
    const protocolLabels = <String>[
      '自动（先 Responses，不支持就切 Chat）',
      '强制 Responses',
      '强制 Chat Completions',
    ];
    for (final label in protocolLabels) {
      expect(
        find.text(label),
        findsNothing,
        reason: '引导第 2 步不再问协议：「$label」不该出现在这张卡上',
      );
    }

    // 控件本身也不在（不只是文案）：单选组与单选圆点在这一屏一个都没有
    expect(find.byKey(const ValueKey('onboarding-protocol-group')), findsNothing);
    expect(
      find.descendant(of: find.byType(Dialog), matching: find.byType(RadioGroup<String>)),
      findsNothing,
      reason: '协议单选整块已删（设置页那组单选仍原样存在，与这一屏无关）',
    );
    expect(
      find.descendant(of: find.byType(Dialog), matching: find.byType(Radio<String>)),
      findsNothing,
    );

    // 同一条事实的另一半：第 2 步该在的东西都还在（这一条不是为了"少一行"，是为了"没删错"）
    expect(find.byKey(const ValueKey('onboarding-model')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-base')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-api-key')), findsOneWidget);
    expect(find.byKey(const ValueKey('onboarding-probe')), findsOneWidget);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('⑤ 失败三档文案各自出现，且输入一个字都不丢', (tester) async {
    await openApiStep(tester, buildSignals());

    final cases = <String, String>{
      'unreachable': const ZhStrings().onboardingProbeUnreachable,
      'unauthorized': const ZhStrings().onboardingProbeUnauthorized,
      'no-models-endpoint': const ZhStrings().onboardingProbeNoModels,
    };
    for (final entry in cases.entries) {
      probeReply = <String, dynamic>{'ok': false, 'code': entry.key, 'message': '服务端细节'};
      await tapProbe(tester);
      expect(find.text(entry.value), findsOneWidget, reason: '${entry.key} 要有自己的文案');
      expect(find.byKey(const ValueKey('onboarding-probe-failure')), findsOneWidget);
      // 输入保留：模型名与 Base URL 都还是人填的那一份
      expect(textOf(tester, 'onboarding-model'), 'alpha-model');
      expect(textOf(tester, 'onboarding-base'), baseUrl);
    }
    expect(probes, hasLength(3), reason: '三次失败各发了一次探测（不是重试到成功为止）');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('⑥ 点「继续」⇒ config-update 只写 model / baseUrl（没有 protocol）', (tester) async {
    await openApiStep(tester, buildSignals());
    await tester.enterText(find.byKey(const ValueKey('onboarding-model')), 'gemini-3.8-flash');
    await tester.pump();

    await tester.tap(find.byType(FilledButton).first);
    await tester.pump();
    for (var i = 0; i < 20; i += 1) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
    }

    expect(configUpdates, hasLength(1));
    final fields = (configUpdates.single['fields'] as Map).cast<String, dynamic>();
    expect(fields, <String, dynamic>{
      'models.heavy.model': 'gemini-3.8-flash',
      'models.heavy.baseUrl': baseUrl,
    });
    expect(
      fields.containsKey('models.heavy.protocol'),
      isFalse,
      reason: '协议不在引导页问（2026-10-26），这一屏也就不该替人写它——'
          '盘上那一档由设置页管，不能被一次「继续」冲掉',
    );
    expect(lastConfirm, 'config-update', reason: '写配置走既有那条确认短语');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('⑦ Base URL 空着点探测 ⇒ 就地红字，零请求', (tester) async {
    await openApiStep(tester, buildSignals());
    await tester.enterText(find.byKey(const ValueKey('onboarding-base')), '');
    await tester.pump();

    await tapProbe(tester);
    expect(find.byKey(const ValueKey('onboarding-probe-base-required')), findsOneWidget);
    expect(find.text(const ZhStrings().onboardingProbeBaseRequired), findsOneWidget);
    expect(probes, isEmpty, reason: '本地就能回答的事不该发请求');
    expect(find.byKey(const ValueKey('onboarding-probe-result')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('⑧ 密钥状态行：未配置 / 已写入 heavy / light（不显示内容）', (tester) async {
    await openApiStep(tester, buildSignals(keyConfigured: false));
    final status = find.byKey(const ValueKey('onboarding-api-key-status'));
    expect(tester.widget<Text>(status).data, const ZhStrings().onboardingApiKeyStatusMissing);

    // 已经配置过的机器：状态行念出格名，输入框仍然空着（只写不读）
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
    await openApiStep(tester, buildSignals(keyConfigured: true));
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('onboarding-api-key-status'))).data,
      const ZhStrings().onboardingApiKeyStatusWritten('heavy / light'),
    );
    expect(textOf(tester, 'onboarding-api-key'), isEmpty, reason: '密钥内容永远不回显');

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('⑨ 探测结论只通一套协议 ⇒ 一行中性事实（不是"建议去选"）', (tester) async {
    // 只通 Chat（Responses 404）：那一行说的是"该端点只支持 …"，没有人被要求去改选择
    probeReply = successReply(responsesOk: false, chatOk: true);
    await openApiStep(tester, buildSignals());
    await tapProbe(tester);
    final note = find.byKey(const ValueKey('onboarding-probe-single-protocol'));
    expect(note, findsOneWidget);
    expect(
      tester.widget<Text>(note).data,
      const ZhStrings().onboardingProbeOnlyProtocol('Chat Completions'),
    );
    expect(find.text('该端点只支持 Chat Completions'), findsOneWidget);
    // 不只是"文案对不对"：这一行里不许出现"建议去选"那类措辞
    expect(tester.widget<Text>(note).data, isNot(contains('建议')));
    // 实测徽章照旧（保留的是实测信息，不是选择项）
    expect(find.text('Responses ✗'), findsNWidgets(2));
    expect(find.text('Chat ✓'), findsNWidgets(2));

    // 另一端：只通 Responses ⇒ 那一行换成 Responses（不是同一句话换个位置）
    probeReply = successReply(responsesOk: true, chatOk: false);
    await tapProbe(tester);
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('onboarding-probe-single-protocol'))).data,
      const ZhStrings().onboardingProbeOnlyProtocol('Responses'),
    );

    // 两套都通 ⇒ 没有这一行（没有"只支持"可说）
    probeReply = successReply();
    await tapProbe(tester);
    expect(find.byKey(const ValueKey('onboarding-probe-single-protocol')), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 1));
  });
}
