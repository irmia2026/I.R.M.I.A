import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

// `GrantPendingCard` / `GrantDoneRow` 是 `extensions_page.dart` 的 part
// （`extensions_kit.dart` 头一行就是 `part of 'extensions_page.dart'`）：只能从库入口 import。
import 'package:irmia_gui/pages/extensions_page.dart';
import 'package:irmia_gui/theme.dart';

/// 扩展页 · **申请单那张卡的肉眼验收**（2026-10-11 那一版自承的缺口③：「GUI 那张卡没肉眼验」）。
///
/// 这一份不出断言，出**图**：技能那一支的卡在"批准态"与"驳回态"下长什么样，
/// 人一眼就能看出来（哪句话在、哪句话不在、按钮在哪、字数会不会挤爆版面）。
/// 图落在 `test/goldens/`：
///   • `skill_grant_approve.png` —— 待批的**装技能**卡（「批准 / 驳回」两枚按钮都在）＝批准态；
///   • `skill_grant_reject.png`  —— **已驳回**那一行（驳回理由看得见）＝驳回态；
///   • `skill_grant_remove.png`  —— 待批的**删技能**卡（另一条 kind：删的那张卡）；
///   • `skill_grant_approved.png`—— **已批准**那一行（框架执行结果那一句）。
///
/// ── 为什么要 `IRMIA_GOLDENS=1` 才跑 ──
/// 截图是**逐像素**比对：它取决于本机有没有那套中文字体、以及渲染后端的小数取舍。
/// 在别人的机器/CI 上跑同一条必然不同（那不是回归，是字体不同）。所以普通 `flutter test`
/// 里这一条 skip，要出图/重出图时显式跑一次：
///
///     PowerShell:  $env:IRMIA_GOLDENS=1; flutter test --update-goldens test/grant_card_golden_test.dart
///     bash:        IRMIA_GOLDENS=1 flutter test --update-goldens test/grant_card_golden_test.dart
///
/// 卡片里的那几个字段**不是手编的**：`context` / `question` / `scriptNames` 是从
/// `src/grant/skill-grant.ts`（`skillGrantContextOf` / `skillGrantQuestionOf` /
/// `skillGrantSummaryOf`）对同一份申请单实算出来的原文抄过来的——图里的字就是她真会看到的那串。
final bool _enabled = Platform.environment['IRMIA_GOLDENS'] == '1';

/// 本机的中文字体候选（goldens 要"能肉眼看字"，不能是一排方框）。
/// 只读系统字体、不往仓库里塞字体文件（那会把一个几千 KB 的二进制带进版本库）。
const _fontCandidates = <String>[
  r'C:\Windows\Fonts\simhei.ttf',
  r'C:\Windows\Fonts\Deng.ttf',
  r'C:\Windows\Fonts\msyh.ttc',
];

/// 把一套真字体注册到给定 family 上（`IrmiaTheme` 里写死的那两个栈都要有真字形）
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

/// 一份待批的**装技能**申请单（字段照 `GET /api/grants` 的 items 形状；`context` 是真算出来的）
Map<String, dynamic> pendingInstallGrant() => {
      'id': 's-1',
      'kind': 'skill-install',
      'name': 'daily-brief',
      'desc': '每天早上把昨天的日记与未读消息收成一份简报，问一句今天先做哪件。',
      'command': '',
      'args': <dynamic>[],
      'envKeys': <dynamic>[],
      'scriptNames': <dynamic>['scripts/brief.py', 'scripts/collect.sh'],
      'fileCount': 3,
      'reason': '想每天固定做一次，省得你早上还要问我在忙什么',
      'question': '批准装一个技能「daily-brief」？',
      'context': '它会做什么：每天早上把昨天的日记与未读消息收成一份简报，问一句今天先做哪件。\n'
          '来源：这份申请单是**她自己写的**（名字、描述、正文、随包文件都来自那张单子）；'
          '框架只校验格式与安全边界，一个字都没替她补。\n'
          '风险点：它带 2 个**可执行脚本**（scripts/）：scripts/brief.py、scripts/collect.sh'
          '——装了之后她会照这个技能的指示做，而这些脚本是会被跑起来的东西。\n'
          '另外还带 1 个文件（共 1 KB）：references/template.md\n'
          '**不会自动执行**：批准只是把这个目录装进来（外加一条信任门凭据）；'
          '框架不会执行 SKILL.md 里的指令，也不会替她跑 scripts/ 里的脚本——要跑只能是她自己调 pwsh（那条路另有门）。\n'
          '正文 213 字节（SKILL.md）。\n'
          '批准之后：由 framework 建 skills/daily-brief/ 并写 SKILL.md（内容逐字照这份单子），'
          '随后写一条 skill/installed{by:"human"} —— 那是**信任门**的凭据，'
          '写了它这个技能才进得了她下一拍的 catalog（不写就等于"装了但她看不见"），'
          '而**索引**要到下一次归集（压缩/重启）才改字节（与 MCP 索引同一套缓存保护）。\n'
          '她写的理由：想每天固定做一次，省得你早上还要问我在忙什么\n'
          '不点会怎样：超时只落一条「未批准、未拒绝」的事实，这张单子原地不动，你回来照样能批。',
      'askSeq': 7,
      'expiredAt': null,
      'requestedAt': '2026-02-14T02:00:00.000Z',
      'outcome': null,
      'outcomeAt': null,
      'rejectReason': null,
      'exec': null,
      'picked': true,
    };

/// 一份待批的**删技能**申请单（同一个 `skill-*` 那一支的另一半：整目录进回收站）
Map<String, dynamic> pendingRemoveGrant() => {
      'id': 's-2',
      'kind': 'skill-remove',
      'name': 'old-skill',
      'desc': '',
      'command': '',
      'args': <dynamic>[],
      'envKeys': <dynamic>[],
      'scriptNames': <dynamic>[],
      'fileCount': 0,
      'reason': '不用了，留着还占目录',
      'question': '批准删掉技能「old-skill」？',
      'context': '它会删掉：技能根下名为「old-skill」的那个目录。'
          '走的是**回收站**（整目录移到 <dataDir>/trash/<时间戳>-<name>/，内容一个字节不改，'
          '移回去即可恢复），不是 rm -rf。\n'
          '批准之后：framework 移目录 + 写一条 skill/installed 之外的两条申请单事件；'
          '她的 catalog 下一拍就没有这个技能了。\n'
          '她写的理由：不用了，留着还占目录\n'
          '不点会怎样：超时只落一条「未批准、未拒绝」的事实，这张单子原地不动，你回来照样能批。',
      'askSeq': 8,
      'expiredAt': null,
      'requestedAt': '2026-02-14T03:00:00.000Z',
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
  });

  /// 把一张卡放进真实的主题里，并把它包在一个 `RepaintBoundary` 里（截图只取这一块）。
  ///
  /// 窗口给得足够大是刻意的：**不许出现滚动条或裁切**——截图要能一屏看完，
  /// 否则"下面那句话被挤掉了"这种毛病在图里看不出来。
  ///
  /// 中间那个 `DefaultTextStyle.merge` 是**测试侧**的字体替身（不是产品代码的一部分）：
  /// 卡片里绝大多数文字是 `Text(style: TextStyle(fontSize: …))`——只给字号，字体族靠
  /// 环境默认风格继承。真机上那一路继承的是系统字体（Microsoft YaHei UI），而在 widget test
  /// 里环境默认风格落到测试字库（全是方框）⇒ 图上一片框，等于没验。这里把"环境默认风格"
  /// 补上同一个族名（真字库已由 `_loadFont` 注册在它名下），版面与真机一致、字也认得出来。
  Future<void> pumpShot(WidgetTester tester, Widget card, {required Size size}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(20),
          child: RepaintBoundary(
            key: const ValueKey('shot'),
            child: Align(
              alignment: Alignment.topLeft,
              child: DefaultTextStyle.merge(
                style: const TextStyle(fontFamily: IrmiaTheme.windowsUiFont, fontSize: 13),
                child: card,
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

  testWidgets('批准态：待批的装技能卡（批准 / 驳回两枚按钮、脚本风险单列、折叠里的框架上下文）', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await pumpShot(
      tester,
      GrantPendingCard(
        grant: pendingInstallGrant(),
        reasonController: controller,
        onApprove: () async {},
        onReject: () async {},
      ),
      size: const Size(840, 1200),
    );
    // 「详情」里那段是**框架算出来的**上下文（来源 / 风险点 / 不会自动执行 / 索引什么时候变）：
    // 展开它，截图才验得到"卡上到底写了什么"，而不是只看到一枚「详情」。
    await tester.tap(find.text('详情'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    await expectShot(tester, 'skill_grant_approve.png');
  }, skip: !_enabled);

  testWidgets('驳回态：已驳回那一行（理由看得见）', (tester) async {
    final rejected = {
      ...pendingInstallGrant(),
      'outcome': 'rejected',
      'outcomeAt': '2026-02-14T02:30:00.000Z',
      'rejectReason': '它会动我的日记，我不想让它常驻',
      'exec': {'state': 'not-applicable'},
    };
    await pumpShot(tester, GrantDoneRow(grant: rejected), size: const Size(840, 260));
    expect(tester.takeException(), isNull);
    await expectShot(tester, 'skill_grant_reject.png');
  }, skip: !_enabled);

  testWidgets('批准后的回看：已批准那一行（框架执行结果那一句）', (tester) async {
    final approved = {
      ...pendingInstallGrant(),
      'outcome': 'approved',
      'outcomeAt': '2026-02-14T02:10:00.000Z',
      'rejectReason': null,
      'exec': {'state': 'ok', 'landed': 'daily-brief'},
    };
    await pumpShot(tester, GrantDoneRow(grant: approved), size: const Size(840, 260));
    expect(tester.takeException(), isNull);
    await expectShot(tester, 'skill_grant_approved.png');
  }, skip: !_enabled);

  testWidgets('删除那一支：待批的删技能卡（说清走回收站、可逆）', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await pumpShot(
      tester,
      GrantPendingCard(
        grant: pendingRemoveGrant(),
        reasonController: controller,
        onApprove: () async {},
        onReject: () async {},
      ),
      size: const Size(840, 820),
    );
    await tester.tap(find.text('详情'));
    await tester.pump();
    expect(tester.takeException(), isNull);
    await expectShot(tester, 'skill_grant_remove.png');
  }, skip: !_enabled);
}
