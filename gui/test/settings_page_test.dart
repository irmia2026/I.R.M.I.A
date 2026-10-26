import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show SystemChannels;
import 'package:flutter_test/flutter_test.dart';

import 'package:irmia_gui/api.dart';
import 'package:irmia_gui/app.dart';
import 'package:irmia_gui/external_link.dart';
import 'package:irmia_gui/i18n/app_strings.dart';
import 'package:irmia_gui/i18n/strings_scope.dart';
import 'package:irmia_gui/pages/settings_page.dart';
import 'package:irmia_gui/theme.dart';
import 'package:irmia_gui/ui_kit.dart';
import 'package:irmia_gui/ui_state.dart';

/// 设置页的锚点 + 分区卡片交互（docs/astrbot-ux-interaction.md「改造后适用」第一条）：
/// 用真实 loopback 服务喂数据，锁住这些事——锚点列表渲染（含 v30 的「外部依赖」与 v34 的「协议端」）、
/// 字段两列的断点行为、「保存」未改动即禁用、保存成功后的提示、
/// 外部依赖卡片的三态与安装通道、"建议安装"必须写清影响，
/// 协议端卡片的开关/目录/启停/登录入口与「需重启」提示，
/// 以及 v35 的「一键安装」：装成功后**确实**调了 PUT /config 把三件事一次写好、
/// 失败时 detail 与逐行过程记录留在卡上（不塞进 toast）、安装期间按钮点不动。
///
/// ⑭ 起系统卡是**逐行就地编辑**（紧凑表 + 每行一枚「编辑」胶囊）：只动这一行、只写这一行、
/// 取消就丢、默认只露 4 行能展开收起、两条只读行没有胶囊——这七条锁在文件末尾。
/// 心跳频率那一行（`wake.heartbeatTargetMeanMin`，2026-10-05 加）三条锁在系统卡那组之后：
/// 渲染盘上那份的值、只发一条 config-update、`X-Confirm` **不带** `trust-full-access`。
/// 「记忆」卡（`persona.memoryEnabled`）三条锁在最后：开关读盘上那份、点一下走 config-update、
/// **关掉时那句代价必须在**（它是一句"什么都不会报错、代价过几天才显形"的话）。
void main() {
  /// GET /api/protocol-side 的样例（v34；v36 起带三档）。
  /// 各用例按需改其中几个键（没配置 / 读失败 / 需重启 / 已停止 / 进程在跑而配置缺失）。
  ///
  /// **三档的样例必须与真服务端同形**：界面直接读 `process` / `onebotConfig` / `adapter`
  /// 这三块，少一个键就会出现一块假的"未观测"——那种 red 会让人去查一个没坏的东西。
  Map<String, dynamic> protocolView() => <String, dynamic>{
        'configured': true,
        'enabled': true,
        'kind': 'snowluma',
        'dir': 'D:/SnowLuma',
        'autoStart': true,
        'configSource': 'disk',
        'attached': true,
        'state': 'ready',
        'stateText': '已就绪',
        'detail': '已就绪，OneBot 在 ws://127.0.0.1:3001/',
        'restartRequired': false,
        'endpoint': {'wsUrl': 'ws://127.0.0.1:3001/', 'hasToken': true, 'source': 'live'},
        'webuiUrl': 'http://127.0.0.1:5099',
        'installed': true,
        'entryPath': 'D:/SnowLuma/dist/index.mjs',
        // 三档（v36）
        'summary': '进程在跑 · OneBot 配置在 · 适配器已连上',
        'process': {
          'known': true,
          'running': true,
          'pid': 34552,
          'managed': 'spawned',
          'startedAt': '2026-02-14T10:00:00.000Z',
          'webuiUrl': 'http://127.0.0.1:5099',
          'detail': '在跑（pid 34552）；实际监听 http://127.0.0.1:5099',
        },
        'onebotConfig': {
          'present': true,
          'wsUrl': 'ws://127.0.0.1:3001/',
          'hasToken': true,
          'path': 'D:/SnowLuma/config/onebot.json',
          'detail': '在（D:/SnowLuma/config/onebot.json），端点 ws://127.0.0.1:3001/',
        },
        'adapter': {
          'state': 'connected',
          'connected': true,
          'hasEndpoint': true,
          'target': 'ws://127.0.0.1:3001/',
          'selfId': '10001',
          'reconnectAttempts': 0,
          'lastEventAt': null,
          'delivered': 0,
          'detail': '已连上 ws://127.0.0.1:3001/',
        },
        // 面板的登录口（v36 的第 2 步）
        'webuiLogin': {
          'url': 'http://127.0.0.1:5099',
          'open': true,
          'consentRecorded': true,
          'mustChangePassword': false,
          'credential': {
            'source': 'stdout',
            'user': 'admin',
            'password': 'd198b971dd2b7b03',
            'passwordMasked': 'd1…03',
          },
        },
      };

  /// 现场那一档（实测）：**进程在跑、OneBot 配置缺失**——三档必须分开说，不能笼统报"启动失败"
  Map<String, dynamic> protocolViewBrokenChain() => <String, dynamic>{
        ...protocolView(),
        'state': 'failed',
        'stateText': '启动失败',
        'detail': '等 30 秒仍没等到 OneBot 端口——协议端进程在跑（pid 34552，面板在 http://127.0.0.1:5099），'
            '而 OneBot 配置缺失（config/onebot.json 还没有）——这一份是它登录 QQ 之后才物化的。',
        'endpoint': null,
        'webuiUrl': 'http://127.0.0.1:5099',
        'summary': '进程在跑 · OneBot 配置缺失 · 适配器没端点可连',
        'process': {
          'known': true,
          'running': true,
          'pid': 34552,
          'managed': 'discovered',
          'startedAt': '2026-02-14T10:00:00.000Z',
          'webuiUrl': 'http://127.0.0.1:5099',
        },
        'onebotConfig': {'present': false, 'detail': '缺失（它登录 QQ 之后才会生成这一份）'},
        'adapter': {
          'state': 'no-endpoint',
          'connected': false,
          'hasEndpoint': false,
          'reconnectAttempts': 0,
          'lastEventAt': null,
          'delivered': 0,
          'detail': '没有可连的端点（协议端的 OneBot 配置还没出现，配置里也没有手填地址）',
        },
        'webuiLogin': {
          'url': 'http://127.0.0.1:5099',
          'open': true,
          'consentRecorded': false,
          'mustChangePassword': true,
          'credential': {'source': 'none'},
        },
      };

  /// GET /api/deps 的样例：rg 就绪、es 可一键装、pwsh 只能人工装（三态各一），
  /// 外加 v-next 的第 4 件 **Python**。
  ///
  /// python 那一行给的是**本机最常见的形状**（用户 2026-10-17 的口径：「Python 和 pip
  /// 不应该是默认要求装的，而是**有就用 PATH 里的**」）：`source: 'path'` —— 机器上本来就
  /// 有 python，所以它是「已就绪·系统」，**不是**"建议安装"。另外两态（托管那份兜底、
  /// 一个都没有）由下面单独两条用例喂——三条各锁一句话，合并就分不清是哪一句错了。
  ///
  /// python 的 pip 刻意给的是"**有 pip**"这一态：用户 2026-10-16 的原话是
  /// 「pip 必须要，方便后续 agent 自行拓展能力」⇒ 界面必须把 pip 版本显示出来。
  /// "没有 pip"那一态由下面单独一条用例喂（`pipVersion: ''` + `pipReason`）——
  /// 那一态是**不许静默**的，所以它值得自己一条。
  Map<String, dynamic> depsReport({
    String pipVersion = '26.2.1',
    String pipReason = '',
    String pythonSource = 'path',
  }) =>
      <String, dynamic>{
        'available': true,
        'dataDir': 'D:/irmia/data',
        'toolsDir': 'D:/irmia/data/tools',
        'needsAttention': true,
        'entries': [
          {
            'name': 'pwsh',
            'label': 'PowerShell 7（pwsh）',
            'status': 'missing',
            'ok': false,
            'path': '',
            'version': '',
            'source': null,
            'reason': '未找到 pwsh（最低要求 7.0）',
            'purpose': 'pwsh 工具的默认 shell；工具的第一条通道',
            'impact': '没有它时 pwsh 工具如实回退到 Windows PowerShell 5.1',
            'action': 'open-download',
            'installable': false,
            'manualHint': 'winget install Microsoft.PowerShell',
            'downloadPage': 'https://github.com/PowerShell/PowerShell/releases/latest',
            'minVersion': '7.0',
            'managedDir': 'D:/irmia/data/tools/pwsh',
          },
          {
            'name': 'rg',
            'label': 'ripgrep（rg）',
            'status': 'ready',
            'ok': true,
            'path': 'D:/irmia/data/tools/rg/rg.exe',
            'version': '15.1.0',
            'source': 'managed',
            'reason': '',
            'purpose': 'rg_search 的引擎；按内容搜索',
            'impact': '没有它时 rg_search 不注册',
            'action': null,
            'installable': true,
            'manualHint': null,
            'downloadPage': 'https://github.com/BurntSushi/ripgrep/releases',
            'minVersion': '13.0',
            'managedDir': 'D:/irmia/data/tools/rg',
          },
          {
            'name': 'es',
            'label': 'Everything 命令行（es.exe）',
            'status': 'missing',
            'ok': false,
            'path': '',
            'version': '',
            'source': null,
            'reason': '未找到 es（最低要求 1.1）',
            'purpose': 'es_search 的引擎；按文件名搜索',
            'impact': '没有它时 es_search 不注册（装 Everything 主程序不会带上 es.exe）',
            'action': 'install',
            'installable': true,
            'manualHint': null,
            'downloadPage': 'https://www.voidtools.com/downloads/',
            'minVersion': '1.1',
            'managedDir': 'D:/irmia/data/tools/es',
          },
          {
            'name': 'python',
            'label': 'Python 运行环境',
            'status': 'ready',
            'ok': true,
            // 系统 PATH 上那一份（本机实测 3.11.5 就在 PATH 上）——"有就用 PATH 里的"
            'path': 'C:/Users/<user>/AppData/Local/Programs/Python/Python311/python.exe',
            'version': '3.11.5',
            'source': pythonSource,
            'reason': '',
            'purpose': "给她自己扩展能力用的运行环境（含 pip）：pwsh 工具的 lang:'python' 档，"
                '将来的 Office 工具包与 computer use 插件也挂在它上面',
            'impact': '没有它时 pwsh 的 python 档如实报找不到解释器',
            'action': null,
            'installable': true,
            'manualHint': null,
            'downloadPage': 'https://www.python.org/downloads/windows/',
            'minVersion': '3.8',
            'managedDir': 'D:/irmia/data/tools/python',
            'pipVersion': pipVersion,
            'pipReason': pipReason,
          },
        ],
        'generatedAt': '2026-10-01T00:00:00.000Z',
      };

  /// GET /api/config?source=saved 的回执。**可变**：记忆卡那两条用例要按开关的开/关各喂一份。
  var config = <String, dynamic>{
    'dataDir': 'D:/irmia/data',
    'web': {'host': '127.0.0.1', 'port': 7788},
    'timezone': 'Asia/Shanghai',
    'models': {
      'heavy': {
        'model': 'gpt-4o-mini',
        'baseUrl': 'https://api.example.com',
        'apiKeyEnv': 'IRMIA_KEY_HEAVY',
      },
      'light': {
        'model': 'gpt-4o-mini-lite',
        'baseUrl': 'https://api.example.com',
        'apiKeyEnv': 'IRMIA_KEY_LIGHT',
      },
    },
    'budget': {
      'stepTools': 8,
      'turnSteps': 30,
      'taskTokens': 120000,
      'dailyTokens': 2000000,
      'softRatio': 0.8,
      'failStreakMax': 3,
    },
    'tools': {'destructiveEnabled': false},
    'speak': {'typingEffect': true, 'charsPerMinute': 90},
    // 心跳平均间隔（`wake.heartbeatTargetMeanMin`）：用户 2026-10-05 点名要的那个旋钮——
    // "心跳频率我没有地方可以控制吗？"。假配置给的是**与出厂默认相同**的 15，
    // 所以这一条不能证明"读的是配置"（写死 15 也过）——那件事由下面 `heartbeatMean`
    // 那条用例用另一个值（40）单独锁住。
    'wake': {'heartbeatFloorMin': 5, 'heartbeatCeilMin': 60, 'heartbeatTargetMeanMin': 15},
    // persona.memoryEnabled 是记忆卡的读源；$pending 是服务端给"盘上已改、进程还没接管"的元信息
    'persona': {'memoryEnabled': true, 'contacts': <String, dynamic>{}},
    r'$pending': {'source': 'saved', 'restartRequired': <String>[]},
  };

  /// GET /api/config **不带** `source=saved` 的回执 = **生效那份**（运行期真值）。
  ///
  /// 两处用处，问的是同一件事"现在按什么跑"：
  ///   · 模型卡那行**常驻读数**「现在跑的是 …」（2026-10-21 起）：端点/模型名只从这一份里取，
  ///     因为盘上那份在"改完还没重启"时本来就不一样；
  ///   · 压缩线那一行（`persona.compactionThresholdTokens`）：压缩判定与 80% 预警读的
  ///     都是进程内存里那个数。
  /// 默认与盘上那份逐字段相同，个别用例会把它改成另一个值——那正是"界面画的是运行期真值"
  /// 这条的判据。
  late Map<String, dynamic> liveConfig;

  /// 让"生效那份"读失败（模型卡的读数行必须**说读不到**，不许回落成盘上那份）
  bool liveConfigFails = false;

  late HttpServer server;
  late AppState state;
  /// 界面状态的临时文件目录（「关窗时收进托盘」会写它，见 setUp）
  late Directory stateTmpDir;
  Map<String, dynamic>? lastPost;
  String? lastConfirm;
  /// 最近一条写命令的**路径**（压缩线那条走的是它自己的端点，与 config-update 分开——
  /// 只看 body 分不出"走了哪条通道"，而那正是这一格的关键口径）
  String? lastPath;
  /// 写命令的**次数**（⑭：逐行保存要断言"只发一条"，只看 lastPost 分不出"发了一条"还是
  /// "发了三条、最后一条正好是它"——这条计数是那次踩过之后的必备件）
  int postCount = 0;
  /// 安装接口的回执：默认成功；失败路径的用例改写它（三种 step 各一条）
  Map<String, dynamic> installReply = <String, dynamic>{};
  /// 让 /api/deps 返回 404（"读不到依赖状态"那条路径）
  bool depsFails = false;
  /// 覆盖整份 /api/deps 报告（默认 null = 用上面的三态样例）。
  /// 用例用它喂**默认样例覆盖不到的态**：python 就绪但没有 pip。
  Map<String, dynamic>? depsReportOverride;

  /// GET /api/protocol-side 的回执（v34）；protocolFails = 让它 500（"读不到协议端状态"）
  Map<String, dynamic> protocolSide = protocolView();
  bool protocolFails = false;
  /// 一键安装（v35）的回执：默认成功；失败路径的用例改写它
  Map<String, dynamic> installSideReply = <String, dynamic>{};
  /// 装了几次——"安装中不许重复点"那条靠它断言（只发一次请求才算数）
  int installCalls = 0;
  /// 把安装请求按在"进行中"：那条端点是同步的（几秒到几十秒），
  /// 用例靠它撑开"安装中"那一段窗口，好在那一瞬间断言按钮点不动
  Completer<void>? installGate;
  /// 协议端三条写通道最近一次的请求：方法 / 路径 / body
  String? sideMethod;
  String? sidePath;
  Map<String, dynamic>? sideBody;
  /// PUT 配置与启停各自的回执（默认按服务端形状给一份）
  Map<String, dynamic> sideWriteReply = <String, dynamic>{'ok': true, 'restartRequired': true, 'dir': 'D:/SnowLuma'};
  Map<String, dynamic> sideActionReply = <String, dynamic>{
    'ok': true,
    'action': 'start',
    'changed': true,
    'state': 'ready',
    'note': '已拉起，OneBot 在 ws://127.0.0.1:3001/',
  };

  setUp(() async {
    // TestWidgetsFlutterBinding 默认把所有 HttpClient 请求挡成 400（请求不会真的发出），
    // 本组要打真实 loopback 服务，先把那层 mock 摘掉。
    HttpOverrides.global = null;
    // 「关窗时收进托盘」这个界面偏好会落 %APPDATA%/Irmia/ui-state.json（v36）：
    // 测试指向临时文件，别踩真实那份——设置页那条用例会真的写盘。
    stateTmpDir = Directory.systemTemp.createTempSync('irmia-settings-state-');
    stateFileOverride = '${stateTmpDir.path}${Platform.pathSeparator}ui-state.json';
    closeToTray.value = kCloseToTrayDefault;
    lastPost = null;
    lastConfirm = null;
    lastPath = null;
    postCount = 0;
    config = {
      'dataDir': 'D:/irmia/data',
      'web': {'host': '127.0.0.1', 'port': 7788},
      'timezone': 'Asia/Shanghai',
      'models': {
        'heavy': {'model': 'gpt-4o-mini', 'baseUrl': 'https://api.example.com', 'apiKeyEnv': 'IRMIA_KEY_HEAVY'},
        'light': {'model': 'gpt-4o-mini-lite', 'baseUrl': 'https://api.example.com', 'apiKeyEnv': 'IRMIA_KEY_LIGHT'},
      },
      'budget': {
        'stepTools': 8, 'turnSteps': 30, 'taskTokens': 120000,
        'dailyTokens': 2000000, 'softRatio': 0.8, 'failStreakMax': 3,
      },
      'tools': {'destructiveEnabled': false},
      'speak': {'typingEffect': true, 'charsPerMinute': 90},
      'wake': {'heartbeatFloorMin': 5, 'heartbeatCeilMin': 60, 'heartbeatTargetMeanMin': 15},
      'persona': {'memoryEnabled': true, 'contacts': <String, dynamic>{}},
      r'$pending': {'source': 'saved', 'restartRequired': <String>[]},
    };
    // 生效那份：与盘上那份同形（去掉只属于"盘上那份"的 `$pending`），并补上压缩线那一格
    // ——真服务端的生效配置一定带它（缺格按默认补齐）。要测"读的是哪一份"的用例自己改它。
    liveConfig = Map<String, dynamic>.from(jsonDecode(jsonEncode(config)) as Map<String, dynamic>)
      ..remove(r'$pending');
    (liveConfig['persona'] as Map<String, dynamic>)['compactionThresholdTokens'] = 100000;
    liveConfigFails = false;
    depsFails = false;
    depsReportOverride = null;
    installReply = <String, dynamic>{'ok': true, 'step': 'done', 'version': '1.1.0.38'};
    protocolSide = protocolView();
    protocolFails = false;
    installCalls = 0;
    installGate = null;
    // 一键安装的回执：**照真服务端的形状**给（含逐行 log——那是给人看的进度）
    installSideReply = <String, dynamic>{
      'ok': true,
      'dir': r'C:\path\to\snowluma',
      'version': 'v1.14.20',
      'detail': '已装好 v1.14.20',
      'log': <String>[
        '正在查询官方 Releases…',
        '找到 v1.14.20 的 SnowLuma-v1.14.20-win-x64-lite.zip（4.6 MB）',
        '正在下载…',
        '下载完成（4.6 MB）',
        '正在解压…',
        // 文件数是**实测值**（真包解出来 43 个文件、13 个顶层条目）：假数据与事实对齐，
        // 免得以后有人拿测试里的数字去写文档
        '解压完成（43 个文件）',
        r'就绪：C:\path\to\snowluma',
      ],
    };
    sideMethod = null;
    sidePath = null;
    sideBody = null;
    sideWriteReply = <String, dynamic>{'ok': true, 'restartRequired': true, 'dir': 'D:/SnowLuma'};
    sideActionReply = <String, dynamic>{
      'ok': true,
      'action': 'start',
      'changed': true,
      'state': 'ready',
      'note': '已拉起，OneBot 在 ws://127.0.0.1:3001/',
    };
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      final response = req.response..headers.contentType = ContentType.json;
      final path = req.uri.path;
      if (path == '/api/config') {
        // 不带 `source=saved` = **生效那份**（运行期真值）：见 [liveConfig] 的说明。
        //
        // `bounds` 照真服务端的形状给（`src/web/server.ts` 的 `/api/config`）——界面的
        // 保存前拦截**只从它取**（2026-10-11 收口：Dart 侧那一对常量已删）。缺这一格，
        // 越界那一格就退回"不预拦、由服务端拒"，下面那条用例当场红——**这正是要的**：
        // 它钉住"边界只有服务端一个真源"。
        final wantsSaved = req.uri.queryParameters['source'] == 'saved';
        if (!wantsSaved && liveConfigFails) {
          // 模型卡的读数行只认这一份：它读不到时**必须说读不到**（不许回落成盘上那份）
          response.statusCode = 500;
          response.write(jsonEncode({'error': {'message': '生效配置读不到'}}));
        } else {
          final body = wantsSaved ? config : liveConfig;
          response.write(jsonEncode({
            ...body,
            'bounds': {
              'compactionThreshold': {'min': 10000, 'max': 2000000},
            },
          }));
        }
      } else if (path == '/api/keys') {
        response.write(jsonEncode({'heavy': {'configured': true, 'mask': 'sk-…1a2b'}, 'light': {'configured': false}}));
      } else if (path == '/api/projection') {
        response.write(jsonEncode({'watermark': 42, 'firstEventAt': '2026-09-01T00:00:00.000Z'}));
      } else if (path == '/api/deps') {
        if (depsFails) {
          response.statusCode = 500;
          response.write(jsonEncode({'error': {'message': 'deps 端点不可用'}}));
        } else {
          // `depsReportOverride` 让某一条用例喂一份**不同态**的报告
          // （例如"python 就绪但没有 pip"）——默认那份三态覆盖不了它
          response.write(jsonEncode(depsReportOverride ?? depsReport()));
        }
      } else if (path == '/api/protocol-side') {
        // 协议端状态（v34）：读不到时 500，让卡片走它自己的 error 态
        if (protocolFails) {
          response.statusCode = 500;
          response.write(jsonEncode({'error': {'message': '协议端状态端点不可用'}}));
        } else {
          response.write(jsonEncode(protocolSide));
        }
      } else if (path == '/api/protocol-side/install') {
        // 一键安装（v35）：无 body 的同步请求。installGate 让用例把这一段按住，
        // 好在"安装中"那一瞬间断言按钮点不动、且**只**发了一次请求
        installCalls += 1;
        sideMethod = req.method;
        sidePath = path;
        final raw = await utf8.decoder.bind(req).join();
        sideBody = raw.isEmpty ? <String, dynamic>{} : (jsonDecode(raw) as Map<String, dynamic>);
        if (installGate != null) await installGate!.future;
        response.write(jsonEncode(installSideReply));
      } else if (path.startsWith('/api/protocol-side/')) {
        // 写通道：PUT 配置 / POST 启停。方法与路径都记下来，用例要按它们断言
        sideMethod = req.method;
        sidePath = path;
        final raw = await utf8.decoder.bind(req).join();
        sideBody = raw.isEmpty ? <String, dynamic>{} : (jsonDecode(raw) as Map<String, dynamic>);
        response.write(jsonEncode(path == '/api/protocol-side/config' ? sideWriteReply : sideActionReply));
      } else if (path.startsWith('/api/commands/')) {
        postCount += 1;
        lastPath = path;
        lastPost = jsonDecode(await utf8.decoder.bind(req).join()) as Map<String, dynamic>;
        lastConfirm = req.headers.value('X-Confirm');
        response.write(jsonEncode(installReply));
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
    stateFileOverride = null;
    closeToTray.value = kCloseToTrayDefault;
    try {
      stateTmpDir.deleteSync(recursive: true);
    } catch (_) {
      // 清不掉临时目录不影响断言
    }
  });

  /// 交替推进真异步与假时钟：HttpClient 的每一步 await 都要先让真实 I/O 跑完，
  /// 再 pump 把结果落进树——单次「等待 + pump」跑不完整条请求链，因此轮询到目标出现。
  Future<void> pumpUntil(WidgetTester tester, Finder target, {int rounds = 40}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 25)));
      await tester.pump();
      if (target.evaluate().isNotEmpty) {
        await tester.pump();
        return;
      }
    }
    fail('等待目标未出现：$target');
  }

  /// 真实文件 IO 在 fake async 环境里要靠 runAsync 推进，pump 负责回灌微任务：
  /// 两者交替几轮，ui-state.json 的**串行写入队列**才真的跑完（与 shell_layout_test 同一招）。
  /// 不推它就直接读盘，会撞上"文件还没写出来"——那正是这条用例第一版踩的坑。
  Future<void> settleIo(WidgetTester tester, {int rounds = 12}) async {
    for (var i = 0; i < rounds; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
      await tester.pump();
    }
  }

  /// 收尾：把所有还在飞的请求与 toast 计时器跑完，避免测试结束时报 pending timer
  Future<void> drain(WidgetTester tester) async {
    for (var i = 0; i < 6; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
      await tester.pump();
    }
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 600));
    await tester.pump(const Duration(milliseconds: 400));
  }

  /// 把当前那条 toast **彻底**送走（不是"跑完计时器"就够了）。
  ///
  /// 为什么要单独一条、不能只靠 [drain]：SnackBar 的自动消失计时器是在**入场动画结束
  /// 之后**才起跑的，而 `pump(4s)` 一次推完只会让那条计时器"刚刚开始倒数"——toast 于是
  /// 留在屏上。它是一条贴底的漂浮条，正好盖住页面底部的「保存」键：⑪ 的校验用例要连按
  /// 五次保存，第二次开始就点在了 toast 上（这条用例踩过，现象是"该来的提示一句都没来"）。
  Future<void> away(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 400)); // 入场动画走完，4 秒计时器起跑
    await tester.pump(IrmiaToast.duration + const Duration(milliseconds: 400)); // 计时器触发
    await tester.pump(const Duration(milliseconds: 600)); // 退出动画走完，条子离场
  }

  /// 把断言**限定在某一张设置卡内部**。
  ///
  /// v34 之后页面上并排站着两张同形态的卡（「外部依赖」与「协议端」），它们各自的徽章词表
  /// 是同一套（已就绪 / 未安装 / 需重启…）。全局按文本找会跨卡命中，于是"依赖卡该有三态徽章"
  /// 这种断言会被另一张卡的存在搅浑——那既可能假绿（别处凑够了数）也可能假红。
  /// 定位锚用卡头的说明句（每张卡唯一），取它最近的那个 Container 祖先 = 卡本身。
  Finder inCard(String noteFragment, Finder target) => find.descendant(
        of: find.ancestor(of: find.textContaining(noteFragment), matching: find.byType(Container)).first,
        matching: target,
      );

  /// 「外部依赖」卡内部
  Finder inDepsCard(Finder target) => inCard('建议安装的外部依赖', target);
  /// 「协议端（可选）」卡内部（锚句随 2026-10-02 的副标题更正换过一次）
  Finder inProtocolCard(Finder target) => inCard('各是一条独立的入站通道', target);
  /// 「系统」卡内部（⑪ 之后它不再只读，卡头说明句是这一页上唯一的那句）。
  ///
  /// 2026-10-05 心跳那行加进来时，卡头说明句跟着改了（"六条预算" → "六条预算与心跳"），
  /// 这里的锚句**必须同步改**——它是一段 `textContaining`，锚句对不上就是"找不到卡"，
  /// 而 `find.ancestor(...).first` 找不到时不会报"锚句过期"，只会让**五条系统卡用例一起红**
  /// （现象是"某个控件在卡里找不到"，看上去像控件坏了）。卡头说明句与这一行是**配对**的。
  Finder inSystemCard(Finder target) =>
      inCard('监听地址、时区、六条预算与心跳都是这个进程的启动参数', target);

  /// 系统卡某一格**编辑态**输入框里的文本：按点路径取，不按"页面上第几个框"取——
  /// 这一页的输入框已经多到按序号取必然出错（⑪ 之前那条 `.last` 就是被这件事绊倒的）。
  String sysText(WidgetTester tester, String path) =>
      tester.widget<TextField>(find.byKey(ValueKey('sys-field-$path'))).controller?.text ?? '';

  /// 系统卡某一行**读态**摆出来的当前值（按行 id 取；行 id 见 settings_page.dart 的 _sysRowFields）
  String sysValue(WidgetTester tester, String id) =>
      tester.widget<Text>(find.byKey(ValueKey('sys-value-$id'))).data ?? '';

  /// 行尾那枚「编辑」胶囊 / 行内的「保存」「取消」
  Finder sysEdit(String id) => find.byKey(ValueKey('sys-edit-$id'));
  Finder sysSaveBtn(String id) => find.byKey(ValueKey('sys-save-$id'));
  Finder sysCancelBtn(String id) => find.byKey(ValueKey('sys-cancel-$id'));

  /// 点系统卡里的某个控件：先把它滚进视口（设置页很长，tap 点不到屏幕外的控件），
  /// 再把屏上那条 toast 送走——它是贴底漂浮条，会盖住卡片底部的控件（⑪ 踩过这个坑，
  /// 现象是"该来的提示一句都没来"，所以这里把它做进"点"这个动作本身）。
  Future<void> tapInCard(WidgetTester tester, Finder target) async {
    await away(tester);
    await tester.ensureVisible(target);
    await tester.pump();
    await tester.tap(target);
    await tester.pump();
  }

  Future<void> pumpSettings(WidgetTester tester, {Size size = const Size(1350, 900)}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: IrmiaTheme.light(),
        home: Scaffold(body: SettingsPage(state: state)),
      ),
    );
    // 「模型」锚点出现 = 配置到手、分区卡片已渲染（三态已越过）
    await pumpUntil(tester, find.text('模型'));
    await drain(tester);
  }

  testWidgets('十一个分区锚点与分区卡片同时就位（含 v30 的「外部依赖」、v34 的「协议端」、新加的「记忆」与「信任范围」）', (tester) async {
    await pumpSettings(tester);

    // 锚点在左栏（「模型」只属于锚点；「外部依赖」也只有锚点——卡头与它同名但只渲染一次，
    // 其余四个与卡头同名，各出现两次）
    expect(find.text('模型'), findsOneWidget);
    expect(find.text('界面'), findsNWidgets(2));
    expect(find.text('发言'), findsNWidgets(2));
    expect(find.text('外部依赖'), findsNWidgets(2));
    expect(find.text('系统'), findsNWidgets(2));
    expect(find.text('关于'), findsNWidgets(2));

    // v34 的锚点：左栏一处，卡头是「协议端（可选）」（不同名，所以锚点只有一处）
    expect(find.text('协议端'), findsOneWidget);
    expect(find.text('协议端（可选）'), findsOneWidget);

    // 「记忆」分区的锚点与卡头同名：左栏一处、卡头一处，正好两处
    expect(find.text('记忆'), findsNWidgets(2));

    // 「信任范围」同形（与 trust.mode 那笔一起加的）：锚点一处 + 卡头一处
    expect(find.text('信任范围'), findsNWidgets(2));

    // 模型组两条 lane 各一张卡片，卡头 = 组名 + 一句说明
    expect(find.text('主循环（heavy）'), findsOneWidget);
    expect(find.text('turn 主循环使用的模型'), findsOneWidget);
    expect(find.text('轻量（light）'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('发言分区：打字节奏开关与速度输入，都写 config.speak', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 2400));

    // 开关反映生效值（示例配置 speak.typingEffect = true）
    final speakSwitch = inCard('她说话时的节奏', find.byType(Switch));
    expect(tester.widget<Switch>(speakSwitch).value, isTrue, reason: '开关要显示"当前生效"的值，而不是一个空壳');

    // 点一下立刻提交（开关这类二值项没有"改到一半"的中间态，不该逼人多按一次保存）
    await tester.tap(speakSwitch);
    await drain(tester);
    expect(lastPost?['fields']?['speak.typingEffect'], isFalse);
    expect(lastConfirm, 'config-update');

    // 速度输入框预填生效值，改完按保存才提交（限定在发言卡里：v34 的协议端卡也有输入框，
    // ⑪ 之后系统卡还多了一个「保存」——所以这里按卡定位，不再用"页面上最后一个"那种取法）
    final speed = inCard('她说话时的节奏', find.byType(TextField));
    final speedSave = inCard('她说话时的节奏', find.widgetWithText(FilledButton, '保存'));
    expect(tester.widget<TextField>(speed).controller?.text, '90');
    await tester.enterText(speed, '150');
    await tester.pump();
    await tester.tap(speedSave);
    await drain(tester);
    expect(lastPost?['fields']?['speak.charsPerMinute'], 150);

    // 越界的值不发请求（30~600 之外是笔误，不该写进配置）
    lastPost = null;
    await tester.enterText(speed, '5');
    await tester.pump();
    await tester.tap(speedSave);
    await drain(tester);
    expect(lastPost, isNull, reason: '5 字/分钟是笔误，不该写进配置');
  });

  testWidgets('宽窗字段两列、窄窗降一列', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 900));
    var model = tester.getRect(find.byType(TextField).at(0));
    var baseUrl = tester.getRect(find.byType(TextField).at(1));
    expect((baseUrl.top - model.top).abs() < 0.5, isTrue,
        reason: '宽窗下模型名与 Base URL 应在同一行（model.top=${model.top}, base.top=${baseUrl.top}）');
    expect(model.left, lessThan(baseUrl.left), reason: '两列时左格应在右格左侧');

    await pumpSettings(tester, size: const Size(700, 900));
    model = tester.getRect(find.byType(TextField).at(0));
    baseUrl = tester.getRect(find.byType(TextField).at(1));
    expect(baseUrl.top, greaterThan(model.top), reason: '窄窗下降为一列（上下叠放）');
  });

  testWidgets('保存按钮未改动即禁用，改动后可用并给出脏提示', (tester) async {
    await pumpSettings(tester);

    FilledButton saveButton() =>
        tester.widget<FilledButton>(find.widgetWithText(FilledButton, '保存').first);

    expect(saveButton().onPressed, isNull, reason: '未改动时「保存」应禁用');
    expect(find.text('有未保存的更改'), findsNothing);

    await tester.enterText(find.byType(TextField).first, 'deepseek-reasoner');
    await tester.pump();
    expect(saveButton().onPressed, isNotNull, reason: '改动后「保存」应可用');
    expect(find.text('有未保存的更改'), findsOneWidget);

    // 改回生效配置里的原值：脏状态自动消失，按钮回到禁用
    await tester.enterText(find.byType(TextField).first, 'gpt-4o-mini');
    await tester.pump();
    expect(saveButton().onPressed, isNull, reason: '改回原值后应重新禁用');
    expect(find.text('有未保存的更改'), findsNothing);
  });

  testWidgets('保存提交改动字段并提示成功', (tester) async {
    await pumpSettings(tester);

    await tester.enterText(find.byType(TextField).first, 'deepseek-reasoner');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '保存').first);
    await tester.pump();
    await pumpUntil(tester, find.text('已保存模型设置，进程重启后生效'));

    expect(lastPost?['fields'], {'models.heavy.model': 'deepseek-reasoner'});
    expect(lastConfirm, 'config-update', reason: '写配置必须带 X-Confirm');
    expect(find.text('已保存模型设置，进程重启后生效'), findsOneWidget);
    await drain(tester);
  });

  // ── 协议三档（`models.<lane>.protocol`，协议回退 C-3）──
  //
  // 三条锁：① 三档都渲染、缺省落在 auto、选中后保存**只写这一格**；② 改完走既有的「待重启」
  // 提示（服务端 `$pending.restartRequired` 说 models.* 盘上已改 ⇒ 卡下那句 + toast 后缀）；
  // ③ 英文文案真的挂到了控件上（页面单独 pump 时 IrmiaStrings 会回中文，所以显式注入 EnStrings）。

  /// 某条 lane 卡片里的协议单选组（`groupValue` = 当前选中的那一档；界面不另存第二份状态）
  RadioGroup<String> protocolGroup(WidgetTester tester, int index) =>
      tester.widgetList<RadioGroup<String>>(find.byType(RadioGroup<String>)).elementAt(index);

  testWidgets('模型卡 · 协议三档：缺省落在 auto，选中 Chat 后保存只写 models.<lane>.protocol', (tester) async {
    await pumpSettings(tester);
    await pumpUntil(tester, find.text('主循环（heavy）'));

    const zh = ZhStrings();
    // 三条说明逐字在（一档一句"选它意味着什么"）
    expect(find.text(zh.settingsModelProtocolAuto), findsWidgets);
    expect(find.text(zh.settingsModelProtocolChat), findsWidgets);
    expect(find.text(zh.settingsModelProtocolResponses), findsWidgets);
    expect(find.text(zh.settingsModelProtocol), findsWidgets, reason: '协议那一格的标签');

    // 两条 lane 各一组；配置里没有这一格 ⇒ 都落在 auto（不崩、不猜第三档）
    expect(find.byType(RadioGroup<String>), findsNWidgets(2));
    expect(protocolGroup(tester, 0).groupValue, 'auto');
    expect(protocolGroup(tester, 1).groupValue, 'auto');

    // 选 Chat（heavy）：选中态换过去、脏提示亮起
    await tester.ensureVisible(find.text(zh.settingsModelProtocolChat).first);
    await tester.pump();
    await tester.tap(find.text(zh.settingsModelProtocolChat).first);
    await tester.pump();
    expect(protocolGroup(tester, 0).groupValue, 'chat-completions');
    expect(find.text('有未保存的更改'), findsOneWidget);

    // 保存：**只写这一格**（模型名/端点/密钥都没动，不跟着带）
    await tester.tap(find.widgetWithText(FilledButton, '保存').first);
    await tester.pump();
    await pumpUntil(tester, find.text('已保存模型设置，进程重启后生效'));
    expect(lastPost?['fields'], {'models.heavy.protocol': 'chat-completions'});
    expect(lastConfirm, 'config-update');
    await drain(tester);
  });

  testWidgets('模型卡 · 协议改完显示「待重启」：服务端回 \$pending 说 models.* 盘上已改就走既有提示', (tester) async {
    await pumpSettings(tester);
    await pumpUntil(tester, find.text('主循环（heavy）'));

    const zh = ZhStrings();
    expect(find.text(zh.settingsModelRestartNote), findsNothing, reason: '还没改：不喊重启');

    await tester.ensureVisible(find.text(zh.settingsModelProtocolChat).first);
    await tester.pump();
    await tester.tap(find.text(zh.settingsModelProtocolChat).first);
    await tester.pump();

    // 真服务端保存后会按"盘上那份 vs 启动时那份"给 $pending；这里把那次回读的现场摆好。
    // （协议是 restart 级：`config/watcher.ts` 的 RESTART_REQUIRED_FIELDS 已含 `models.`）
    final models = config['models'] as Map<String, dynamic>;
    (models['heavy'] as Map<String, dynamic>)['protocol'] = 'chat-completions';
    config[r'$pending'] = <String, dynamic>{
      'source': 'saved',
      'restartRequired': <String>['models.heavy.protocol'],
    };

    await tester.tap(find.widgetWithText(FilledButton, '保存').first);
    await tester.pump();
    // ① toast 自带"进程重启后生效"后缀（既有文案，不另写一句）
    await pumpUntil(tester, find.textContaining('进程重启后生效'));
    // ② 卡下那句"上面有改动还没生效……"（既有 footnote，判据来自服务端）
    await pumpUntil(tester, find.text(zh.settingsModelRestartNote));
    expect(find.text(zh.settingsModelRestartNote), findsOneWidget);
    await drain(tester);
  });

  testWidgets('模型卡 · 协议三档有英文文案（en 下逐句换成英文，不露中文）', (tester) async {
    const en = EnStrings();
    tester.view.physicalSize = const Size(1350, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    // 页面单独 pump 时 `IrmiaStrings.of` 会回中文（见 strings_scope.dart 的兜底），
    // 所以这一条**显式注入**英文那份：判的是"英文文案存在、且真的挂到了控件上"。
    await tester.pumpWidget(MaterialApp(
      theme: IrmiaTheme.light(),
      home: IrmiaStrings(
        strings: en,
        child: Scaffold(body: SettingsPage(state: state)),
      ),
    ));
    await pumpUntil(tester, find.text(en.settingsModelProtocolAuto));

    expect(find.text(en.settingsModelProtocolAuto), findsWidgets);
    expect(find.text(en.settingsModelProtocolChat), findsWidgets);
    expect(find.text(en.settingsModelProtocolResponses), findsWidgets);
    expect(find.text(en.settingsModelProtocol), findsWidgets, reason: '标签也是英文的');

    // 中文一句都不许漏（en 下露中文 = 没进文案表）
    const zh = ZhStrings();
    expect(find.text(zh.settingsModelProtocolAuto), findsNothing);
    expect(find.text(zh.settingsModelProtocolChat), findsNothing);
    expect(find.text(zh.settingsModelProtocolResponses), findsNothing);
    await drain(tester);
  });

  // ── 「现在跑的是 …」常驻读数 + 按 lane 的「尚未生效」徽章（2026-10-21）──
  //
  // 病根：这一页只显示**盘上那份**（`?source=saved`），而请求实际打到哪里只由**进程启动
  // 那一刻**的 `models.*` 决定（restart 级）。于是"在 light 卡里换了端点、界面显示新值、
  // 请求仍打 heavy 的端点"在屏幕上完全看不出来，且界面上**没有任何**"现在在用哪个端点"的读数。
  //
  // 三条锁：① 读数取**生效那份**（不是盘上那份），与输入框并排摆着；② 生效那份读不到时
  // 照实说读不到（不回落、不装作知道）；③ 徽章按 lane 点亮、判据只来自服务端
  // `$pending.restartRequired`，并且它**不会**在"落盘那一瞬之后"消失（下一次进页面照样在）。

  /// 某条 lane 卡里那行常驻读数的整句（按容器 key 取，不按文本猜）
  String runtimeLine(WidgetTester tester, String lane) {
    final box = find.byKey(ValueKey('models-runtime-$lane'));
    expect(box, findsOneWidget, reason: '每个 lane 卡都该有一行常驻读数');
    final text = find.descendant(of: box, matching: find.byType(Text));
    return tester.widget<Text>(text).data ?? '';
  }

  /// 某条 lane 卡里那枚「尚未生效」徽章（卡由卡头那句说明定位，见 [inCard]）
  Finder laneBadge(String laneNote, String badgeText) => inCard(laneNote, find.text(badgeText));

  /// **重新进一次这一页**：先把树清空（State 销毁），再 pump 回来 ⇒ `initState` 里的
  /// `_loadConfig` 会真的再读一次服务端。为什么要这么写：直接再 `pumpWidget` 一次
  /// 相同类型的 widget 会**复用同一个 State**（Flutter 的 element 复用），于是 `pendingRestart`
  /// 是上一次留下的——那样"保持"这条断言会在"根本没重新读"的情况下假绿。
  Future<void> reopenSettings(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox.shrink())));
    await tester.pump();
    await pumpSettings(tester, size: const Size(1350, 1200));
    await pumpUntil(tester, find.text('主循环（heavy）'));
  }

  testWidgets('模型卡 · 常驻读数印的是**生效那份**的 model/baseUrl（输入框仍是盘上那份）', (tester) async {
    // 盘上（saved）与生效（live）**故意不同**——正是"保存了但没重启"那一刻的现场
    (config['models']['light'] as Map<String, dynamic>)['model'] = 'saved-light-model';
    (config['models']['light'] as Map<String, dynamic>)['baseUrl'] = 'https://saved.example.com';
    config[r'$pending'] = <String, dynamic>{
      'source': 'saved',
      'restartRequired': <String>['models.light.model', 'models.light.baseUrl'],
    };
    (liveConfig['models']['light'] as Map<String, dynamic>)['model'] = 'running-light-model';
    (liveConfig['models']['light'] as Map<String, dynamic>)['baseUrl'] = 'https://running.example.com';

    await pumpSettings(tester, size: const Size(1350, 1200));
    await pumpUntil(tester, find.text('主循环（heavy）'));

    const zh = ZhStrings();
    // ① 读数：light 那行是**生效**值（heavy 那行同样有，说明它不是我拼出来的一句常量）
    expect(
      runtimeLine(tester, 'light'),
      zh.settingsModelRunningNow('light', 'running-light-model', 'https://running.example.com'),
      reason: '读数只能来自生效那份：它回答的是"此刻请求打到哪"',
    );
    expect(
      runtimeLine(tester, 'heavy'),
      zh.settingsModelRunningNow('heavy', 'gpt-4o-mini', 'https://api.example.com'),
    );
    // ② 输入框里仍是**盘上**值（这一页编辑的是"我保存下来的值"）
    //    ——"我存了什么"与"它此刻在用什么"同屏，正是这一行的全部意义
    final fields = tester.widgetList<TextField>(find.byType(TextField)).toList();
    expect(fields[3].controller?.text, 'saved-light-model', reason: 'light 的模型名框：盘上那份');
    expect(fields[4].controller?.text, 'https://saved.example.com', reason: 'light 的 Base URL 框：盘上那份');
    // ③ 这条 lane 也真的挂着「尚未生效」（盘上与生效不同，判据来自服务端 `$pending`）
    expect(laneBadge(zh.settingsLaneLightNote, zh.settingsNotInEffect), findsOneWidget);
    await drain(tester);
  });

  testWidgets('模型卡 · 生效那份读不到时，读数行说「状态读取失败」——不回落成盘上那份', (tester) async {
    liveConfigFails = true;
    await pumpSettings(tester, size: const Size(1350, 1200));
    await pumpUntil(tester, find.text('主循环（heavy）'));

    const zh = ZhStrings();
    expect(runtimeLine(tester, 'heavy'), zh.settingsStateReadFailed);
    expect(runtimeLine(tester, 'light'), zh.settingsStateReadFailed);
    // 反向断言：读不到的时候**不许**把盘上那份摆成"现在跑的是 …"
    expect(find.textContaining('现在跑的是'), findsNothing);
    await drain(tester);
  });

  testWidgets('模型卡 · 「尚未生效」按 lane 点亮，且下一次进页面仍在（保持到重启成功）', (tester) async {
    // 只有 light 的模型名"盘上已改、进程还没接管"
    (config['models']['light'] as Map<String, dynamic>)['model'] = 'saved-light-model';
    config[r'$pending'] = <String, dynamic>{
      'source': 'saved',
      'restartRequired': <String>['models.light.model'],
    };

    await pumpSettings(tester, size: const Size(1350, 1200));
    await pumpUntil(tester, find.text('主循环（heavy）'));
    const zh = ZhStrings();
    expect(laneBadge(zh.settingsLaneLightNote, zh.settingsNotInEffect), findsOneWidget,
        reason: 'light 那一格真的与生效值不同');
    expect(laneBadge(zh.settingsLaneHeavyNote, zh.settingsNotInEffect), findsNothing,
        reason: 'heavy 没改：不许跟着挂徽章');

    // ② 保持：**再进一次页面**（另一次读取、另一次渲染）徽章还在——
    //    它不是"保存那一瞬"的 toast，而该一直挂到进程真的重启（那时 `$pending` 才空）。
    await reopenSettings(tester);
    expect(laneBadge(zh.settingsLaneLightNote, zh.settingsNotInEffect), findsOneWidget,
        reason: '落盘之后的下一次读取，服务端仍会说"尚未生效"');

    // ③ 重启成功：盘上那份成了生效那份（`$pending` 空）⇒ 徽章自己消失
    config[r'$pending'] = <String, dynamic>{'source': 'saved', 'restartRequired': <String>[]};
    (liveConfig['models']['light'] as Map<String, dynamic>)['model'] = 'saved-light-model';
    await reopenSettings(tester);
    expect(laneBadge(zh.settingsLaneLightNote, zh.settingsNotInEffect), findsNothing);
    await drain(tester);
  });

  testWidgets('模型密钥格：已配置的那条整格转蓝并居中，未配置的不变', (tester) async {
    await pumpSettings(tester);
    await pumpUntil(tester, find.text('主循环（heavy）'));

    // 两条 lane 各一个密钥格（假数据里 heavy 已配置、light 没有），正好断言对照
    final obscured = tester.widgetList<TextField>(find.byType(TextField)).where((f) => f.obscureText).toList();
    expect(obscured.length, 2, reason: '两条 lane 各一个密钥格');
    expect(obscured[0].decoration?.hintStyle?.color, IrmiaTheme.light().colorScheme.primary,
        reason: '用户 ⑦：设置页这里与渠道页同样处理——蓝色');
    expect(obscured[0].textAlign, TextAlign.center, reason: '用户 ⑦：居中');
    expect(obscured[1].decoration?.hintStyle, isNull, reason: 'light 没配密钥：它就是普通输入框');
    expect(obscured[1].textAlign, TextAlign.start);
    await drain(tester);
  });

  testWidgets('清除密钥走统一确认框，取消不发请求、确认才发', (tester) async {
    await pumpSettings(tester);
    await pumpUntil(tester, find.text('清除密钥').first);

    await tester.tap(find.text('清除密钥').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(find.text('清除密钥 · 主循环（heavy）'), findsOneWidget, reason: '应弹出 ui_kit 确认框');

    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(lastPost, isNull, reason: '取消不应发出写请求');

    await tester.tap(find.text('清除密钥').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.text('清除'));
    await tester.pump();
    await pumpUntil(tester, find.text('已清除本地密钥'));

    expect(lastPost, {'name': 'heavy', 'value': ''});
    expect(lastConfirm, 'set-key');
    await drain(tester);
  });

  testWidgets('点锚点滚动到对应分区并高亮它', (tester) async {
    await pumpSettings(tester);

    final before = tester.getRect(find.text('版本')).top;
    await tester.tap(find.text('关于').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 240));

    expect(tester.takeException(), isNull);
    expect(tester.getRect(find.text('版本')).top, lessThan(before), reason: '「关于」分区应滚到视口上方');
    final active = tester.widget<Text>(find.text('关于').first);
    expect(active.style?.color, IrmiaTheme.light().colorScheme.primary, reason: '被点中的锚点应高亮');
  });

  testWidgets('手动滚动时高亮跟着走，不再钉死在「模型」', (tester) async {
    await pumpSettings(tester);
    final primary = IrmiaTheme.light().colorScheme.primary;
    Color? colorOf(String label) => tester.widget<Text>(find.text(label).first).style?.color;

    expect(colorOf('模型'), primary, reason: '一开始在最上面，高亮就是「模型」');

    // 先确认拖拽真的滚起来了——否则后面的断言都是假的
    final position = tester.state<ScrollableState>(find.byType(Scrollable).first).position;
    expect(position.pixels, 0);
    await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -240));
    await tester.pump();
    expect(position.pixels, greaterThan(0), reason: '拖拽要能滚动这张页');

    // 一格一格往下滚（不点锚点）：滚到「外部依赖」那一段就该亮它。
    // 目标取中段的分区，不取「系统」——滚到「系统」时页面已经到底，
    // 「到底钉住最后一项」那条分支会接管（那是刻意的），断言会跟着变得依赖布局高度。
    // 也不用 scrollUntilVisible——SingleChildScrollView 的子树整棵都在，那个 finder 一开始就非空，
    // 它会一步都不滚就返回。
    var steps = 0;
    final seen = <String>{};
    while (colorOf('外部依赖') != primary && steps < 40) {
      for (final id in ['模型', '界面', '发言', '外部依赖', '协议端', '系统', '关于']) {
        if (colorOf(id) == primary) seen.add(id);
      }
      await tester.drag(find.byType(SingleChildScrollView), const Offset(0, -200));
      await tester.pump();
      steps += 1;
    }

    expect(steps, lessThan(40), reason: '滚了 $steps 格还没轮到「外部依赖」；途中亮过：$seen');
    expect(colorOf('外部依赖'), primary, reason: '滚到哪一区，高亮就该落在哪一区');
    expect(colorOf('模型'), isNot(primary),
        reason: '原来这里恒为「模型」——判定线没把滚动量算进去（用户 ⑩）');
  });

  testWidgets('窄窗锚点降级为顶部横条', (tester) async {
    await pumpSettings(tester, size: const Size(760, 900));

    expect(find.text('模型'), findsOneWidget, reason: '锚点应以横条形式保留');
    await tester.tap(find.text('系统').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 240));
    expect(tester.takeException(), isNull);
  });

  // ── 「界面」卡：关窗行为（v36） ──

  testWidgets('界面卡：关窗开关默认开（点 × 收进托盘），关掉后写进本机状态文件', (tester) async {
    // 2026-10-21 用户裁决：出厂默认就是开（关窗收进托盘、不退出界面）。
    // "关窗=收进托盘"曾经是个陷阱（托盘图标被 Windows 收进"隐藏的图标"面板时窗口找不回来），
    // 现在防它的是 main.dart 那道"托盘没装成就不隐藏"，不是把这个开关默认关掉。
    await pumpSettings(tester, size: const Size(1350, 1600));

    /// 读那份状态文件（真实 I/O 要走 runAsync 才推得动）
    Future<Map<String, dynamic>> readState() async {
      final raw = await tester.runAsync(() => File(stateFileOverride!).readAsString());
      return jsonDecode(raw!) as Map<String, dynamic>;
    }
    final toggle = find.byKey(const ValueKey('close-to-tray'));
    expect(toggle, findsOneWidget, reason: '开关要在「界面」卡里露面');
    expect(tester.widget<Switch>(toggle).value, isTrue, reason: '默认开：点 × 收进托盘（不退出界面）');
    // 后果要写在卡上（托盘图标被系统藏起来时，关窗=界面不见了）
    expect(find.textContaining('托盘图标若被系统收进"隐藏的图标"面板'), findsOneWidget);
    expect(find.textContaining('关掉此项则点 × 直接退出（她照常运行）'), findsOneWidget);

    // 关掉：偏好落本机状态文件（键 close-to-tray），不碰服务端配置。
    // 写配置的请求数按"翻开关前后的差值"算——加载这一页本身要读好几条 GET，
    // 但一条 POST config-update 都不该有。
    final postsBefore = postCount;
    await tapInCard(tester, toggle);
    expect(tester.widget<Switch>(toggle).value, isFalse);
    expect(closeToTray.value, isFalse, reason: '本次运行里就该生效（关窗回调读的是内存镜像）');
    await settleIo(tester);
    expect((await readState())[kCloseToTrayFlag], isFalse);

    // 再打开：同一个键写成 true（显式覆盖仍然优先，出厂默认那一档本来也是 true）
    await tapInCard(tester, toggle);
    expect(tester.widget<Switch>(toggle).value, isTrue);
    expect(closeToTray.value, isTrue);
    await settleIo(tester);
    expect((await readState())[kCloseToTrayFlag], isTrue);
    expect(postCount, postsBefore, reason: '这是界面自己的偏好，不该写服务端配置');
    await drain(tester);
  });

  // ── 外部依赖卡片（v30） ──

  testWidgets('外部依赖卡片：三态徽章、探测到的路径与版本、建议安装的计数', (tester) async {
    // 卡片在「发言」之后，长页面要够高才渲染得到它
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('PowerShell 7（pwsh）'));

    // 徽章三态：就绪 ×2（rg 与 python）/ 未安装 ×2（pwsh 与 es）。
    // 断言限定在这张卡里——v34 的协议端卡也在用同一套词。
    // ⚠ 「已就绪」现在是**两种说法**（2026-10-17）：rg 是框架托管那份、python 是系统 PATH 那份
    expect(inDepsCard(find.text('已就绪·托管')), findsOneWidget);
    expect(inDepsCard(find.text('已就绪·系统')), findsOneWidget);
    expect(inDepsCard(find.text('未安装')), findsNWidgets(2));
    // 卡头的汇总徽章："建议安装 N 项"（rg 与 python 已就绪，剩 pwsh 与 es）
    expect(find.text('建议安装 2 项'), findsOneWidget);

    // 就绪的行要给"**用的是哪一份** + 探测到的路径与版本"（这是事实，不是承诺。
    // python 那一行的路径是**系统 PATH 上那个**——用户 2026-10-17 要的就是这个形状）
    expect(find.textContaining('系统 PATH · 15.1.0 · D:/irmia/data/tools/rg/rg.exe'), findsNothing,
        reason: 'rg 命中的是自装目录，来源该写「框架托管」');
    expect(find.textContaining('框架托管 · 15.1.0 · D:/irmia/data/tools/rg/rg.exe'), findsOneWidget);
    expect(
      find.textContaining(
        '系统 PATH · 3.11.5 · C:/Users/<user>/AppData/Local/Programs/Python/Python311/python.exe',
      ),
      findsOneWidget,
    );

    // **显式告知建议安装**：未安装的行必须写清"没有它会怎样"
    expect(find.textContaining('如实回退到 Windows PowerShell 5.1'), findsOneWidget);
    expect(find.textContaining('es_search 不注册'), findsOneWidget);
    // 第 4 件那一行要写清"它是给谁用的"（用户点名：pwsh 的 python 档 + 将来的扩展）
    expect(find.textContaining("pwsh 工具的 lang:'python' 档"), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('外部依赖卡片：Python 那一行显示 pip 版本（她要能自己 pip install 扩能力）', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('Python 运行环境'));
    expect(find.text('pip 26.2.1（她可以自己 pip install 扩能力）'), findsOneWidget);
  });

  testWidgets('外部依赖卡片：三态各一条 —— 已就绪·系统（有就用 PATH 里的那份）', (tester) async {
    // 这一条锁用户 2026-10-17 那句「**有就用 PATH 里的**」在界面上的落点：
    // PATH 上那份可用 ⇒ 徽章是「已就绪·系统」，**不是**"建议安装"，也没有「安装」按钮。
    depsReportOverride = depsReport(pythonSource: 'path');
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('Python 运行环境'));
    expect(inDepsCard(find.text('已就绪·系统')), findsOneWidget,
        reason: 'PATH 上那份是"机器上本来就有的"——徽章要说清，别让人以为要去装');
    expect(inDepsCard(find.text('已就绪·托管')), findsOneWidget, reason: '那是 rg（自装目录那份）');
    expect(find.text('建议安装 2 项'), findsOneWidget,
        reason: 'python 已就绪 ⇒ 建议安装的账里不该有它（只有 pwsh 与 es）');
    // 这一行下面那条断言才是关键：就绪的行**不给按钮**（摆了只会重复劳动）
    expect(inDepsCard(find.widgetWithText(FilledButton, '安装')), findsOneWidget,
        reason: '只有 es 需要「安装」——python 就绪时不该给按钮');
    expect(find.text('无需操作'), findsNWidgets(2), reason: 'rg 与 python 两行写"无需操作"');
  });

  testWidgets('外部依赖卡片：三态各一条 —— 已就绪·托管（没有 Python 的机器用兜底那份）', (tester) async {
    // PATH 一个都没有、托管顶上：徽章是「已就绪·托管」（那是**框架装的**那份，说法不同），
    // 那一行也要如实写"框架托管"，别写成系统的
    depsReportOverride = depsReport(pythonSource: 'managed');
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('Python 运行环境'));
    expect(inDepsCard(find.text('已就绪·托管')), findsNWidgets(2),
        reason: 'rg（自装目录）+ python（托管兜底）各一枚');
    expect(inDepsCard(find.text('已就绪·系统')), findsNothing, reason: '这一份报告里没有系统那份');
    expect(find.textContaining('框架托管 · 3.11.5 · '), findsOneWidget,
        reason: '用的是托管那份 ⇒ 那一行写「框架托管」');
  });

  testWidgets('外部依赖卡片：三态各一条 —— 未就绪（两处都没有 ⇒ 才建议安装）', (tester) async {
    // 这是"没有的话就要求装"那一态：**只有两处都没有**时它才是未安装 + 建议安装
    final report = depsReport();
    report['entries'] = [
      for (final entry in (report['entries']! as List))
        if ((entry as Map)['name'] == 'python')
          {
            ...entry,
            'status': 'missing',
            'ok': false,
            'path': '',
            'version': '',
            'source': null,
            'reason': '未找到 python（最低要求 3.8）。已试：config: 未指定；'
                'path: 试过 python.exe / python3.exe / python / python3 / py.exe / py',
            'action': 'install',
            'pipVersion': '',
            'pipReason': 'python 未就绪，所以 pip 也没探到',
          }
        else
          entry,
    ];
    depsReportOverride = report;
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('Python 运行环境'));
    expect(inDepsCard(find.text('未安装')), findsNWidgets(3), reason: 'pwsh / es / python 三件都没装');
    expect(find.text('建议安装 3 项'), findsOneWidget);
    // 未就绪时那一行给的是 reason（"试过哪几处"），不是路径与版本
    expect(find.textContaining('已试：config: 未指定'), findsOneWidget);
    // 可一键装的两件（es 与 python）各有一枚「安装」；两个已就绪的不给
    expect(inDepsCard(find.widgetWithText(FilledButton, '安装')), findsNWidgets(2));
    expect(find.text('无需操作'), findsNWidgets(1), reason: '这一份报告里只有 rg 就绪 ⇒ 只有它写"无需操作"');
  });

  testWidgets('外部依赖卡片：python 就绪但**没有 pip** 时必须明说，不许静默', (tester) async {
    // 这一态单独一条用例：默认那份报告里 python 是带 pip 的，覆盖不到它。
    // ⚠ 用户 2026-10-17 点名的那条也在这一条里：**没有 pip 不许把 python 判成"未就绪"**
    depsReportOverride = depsReport(
      pipVersion: '',
      pipReason: '系统这份 Python 上没有可用的 pip——不影响用它跑脚本',
    );
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('Python 运行环境'));
    expect(
      find.text('pip：不可用（系统这份 Python 上没有可用的 pip——不影响用它跑脚本）'),
      findsOneWidget,
      reason: 'python 可用但 pip 不可用时，界面必须把这件事说出来（她的扩展能力正缺在这一环）',
    );
    // 徽章照旧是「已就绪·系统」——python 本身确实就绪，pip 那一行单独说清，两件事不混
    expect(inDepsCard(find.text('已就绪·系统')), findsOneWidget);
    expect(inDepsCard(find.text('未安装')), findsNWidgets(2), reason: 'python 不许因为没 pip 就变成未安装');
  });

  testWidgets('外部依赖卡片：可一键装的给「安装」、只能人装的给「打开下载页」', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('Everything 命令行（es.exe）'));

    // es 可一键装：按钮是「安装」（另配一个「下载页」旁路）
    expect(inDepsCard(find.widgetWithText(FilledButton, '安装')), findsOneWidget);
    // pwsh 只能人工装：动作是「打开下载页」（tonal 样式，与「安装」区分开）。
    // 限定在依赖卡里：协议端卡的下载引导也用同一个词（同一个动作，同一个说法）
    expect(inDepsCard(find.widgetWithText(FilledButton, '打开下载页')), findsOneWidget);
    expect(inDepsCard(find.widgetWithText(FilledButton, '安装')), findsOneWidget,
        reason: '就绪的那件不该给「安装」按钮');
    // 就绪行明确写"无需操作"，而不是摆一枚按下去只会重复劳动的按钮。
    // 两处：rg 与 python（第 4 件就绪时也不该给按钮）
    expect(find.text('无需操作'), findsNWidgets(2));
  });

  testWidgets('安装走确认框 + X-Confirm: dep-install，成功后提示并复检', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.widgetWithText(FilledButton, '安装'));

    // 先滚到按钮可见再点（2026-10-21）：模型卡多了一行常驻读数之后整页高了一点，
    // 这一枚「安装」落在 2600px 的测试视口之外——`tap()` 会静默打空（它只发一条警告），
    // 然后"确认框没出现"被误读成"按钮没接上"。**是高度变了，不是行为变了**。
    await tester.ensureVisible(find.widgetWithText(FilledButton, '安装'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '安装'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    // 确认框要说清装什么、装到哪（这一步会把一段外部代码放到盘上）
    expect(find.text('安装 Everything 命令行（es.exe）'), findsOneWidget);
    expect(find.textContaining('D:/irmia/data/tools/es'), findsOneWidget);

    // 先取消：不发请求
    await tester.tap(find.text('取消'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(lastPost, isNull, reason: '取消不应发出安装请求');

    // 再确认：post 到 dep-install，带危险操作短语。
    // 等待条件要**唯一**：卡片上本来就有「已就绪」徽章，用 find.textContaining('已就绪')
    // 会在 POST 还没发出去时就命中——那正是"假锁"的一种（绿得没有信息）。
    // 这里等 toast 的整句话（它带上服务端回的版本号，只有安装成功才会有）。
    await tester.ensureVisible(find.widgetWithText(FilledButton, '安装'));
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, '安装'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.tap(find.text('下载并安装'));
    await tester.pump();
    await pumpUntil(tester, find.text('Everything 命令行（es.exe） 已就绪（1.1.0.38）'));
    expect(lastPost, {'name': 'es'});
    expect(lastConfirm, 'dep-install', reason: '安装外部可执行文件必须带 X-Confirm');
    await drain(tester);
  });

  testWidgets('三种安装失败分开反馈：下载 / 解压 / 复检各有各的话', (tester) async {
    // 逐条验：合成一句"安装失败"的代价是用户不知道该重试、该换源、还是该看杀毒软件
    const cases = <String, String>{
      'download': '下载失败',
      'extract': '解压失败',
      'verify': '装完复检没通过',
    };
    for (final entry in cases.entries) {
      installReply = <String, dynamic>{
        'ok': false,
        'step': entry.key,
        'error': '（服务端原话：${entry.key} 阶段的具体原因）',
      };
      await pumpSettings(tester, size: const Size(1350, 2600));
      await pumpUntil(tester, find.widgetWithText(FilledButton, '安装'));

      // 滚到按钮可见再点（理由同上一条用例：模型卡多了一行常驻读数，整页高了一点）
      await tester.ensureVisible(find.widgetWithText(FilledButton, '安装'));
      await tester.pump();
      await tester.tap(find.widgetWithText(FilledButton, '安装'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      await tester.tap(find.text('下载并安装'));
      await tester.pump();
      // 等 toast 的整句话（"<阶段>：<服务端原话>"）：只等阶段名的话，
      // 卡片上本来就有的「安装」按钮文案也可能先命中——那是假锁
      final expected = '${entry.value}：（服务端原话：${entry.key} 阶段的具体原因）';
      await pumpUntil(tester, find.text(expected));
      expect(find.text(expected), findsOneWidget, reason: 'step=${entry.key} 该报「${entry.value}」');
      expect(lastPost, {'name': 'es'}, reason: '失败路径也要真的发过请求');
      await drain(tester);
    }
  });

  testWidgets('依赖报告读不到时卡片降级：说清读不到，而不是假装清单正常', (tester) async {
    // 这条锁的是"失败不白屏也不撒谎"：api 报错时卡片必须显式说出来
    depsFails = true;
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.textContaining('依赖报告读取失败'));
    expect(find.textContaining('依赖报告读取失败'), findsOneWidget);
    // 读不到时**不许**出现"全部就绪"这种乐观结论
    expect(find.text('全部就绪'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('依赖报告正常时不该挂着报错文案（反向断言）', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 2600));
    await pumpUntil(tester, find.text('PowerShell 7（pwsh）'));
    expect(find.textContaining('依赖报告读取失败'), findsNothing);
  });

  // ── 协议端卡片（v34） ──

  testWidgets('协议端卡片：锚点 + 状态徽章 + detail 全文 + 对接点 + 登录入口', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    // 锚点（左栏）与卡头各一处
    expect(find.text('协议端'), findsOneWidget, reason: '锚点栏要有它');
    expect(find.text('协议端（可选）'), findsOneWidget);
    // 状态：中文说法（服务端给的 stateText，本页不自己译一份）+ detail 原样显示
    expect(inProtocolCard(find.text('已就绪')), findsOneWidget, reason: '徽章用服务端给的 stateText');
    expect(find.text('已就绪，OneBot 在 ws://127.0.0.1:3001/'), findsOneWidget,
        reason: 'detail 是给人看的那句话，要全文显示');
    expect(find.text('对接点：ws://127.0.0.1:3001/'), findsOneWidget);
    expect(find.text('D:/SnowLuma'), findsNWidgets(2),
        reason: '装在哪要摆两处：状态行（事实）与目录输入框（可改的那个）');
    expect(find.text('已找到可执行入口'), findsOneWidget, reason: '装没装是实测的（entryPath 找得到）');

    // 三个动作：启动 / 停止 / 打开面板（已在跑时「启动」禁用）
    expect(find.widgetWithText(FilledButton, '启动'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '停止'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, '打开面板'), findsOneWidget);
    final start = tester.widget<FilledButton>(find.widgetWithText(FilledButton, '启动'));
    expect(start.onPressed, isNull, reason: '已经在跑：再点「启动」没有意义');
    expect(find.textContaining('扫码登录在 http://127.0.0.1:5099'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  /// v36 的落点：**进程活着、OneBot 配置缺失**必须显示成
  /// "进程在跑 · OneBot 配置缺失"，而不是笼统一句"启动失败"。
  ///
  /// 这条用例锁的是"三档分开显示"这件事本身：三行各带判据与证据，
  /// 人一眼看得出断在第二环（他还没登录 QQ），而不是去查一个活着的进程。
  testWidgets('协议端卡片：三档分开显示——进程在跑 · OneBot 配置缺失（不是一句"启动失败"）', (tester) async {
    protocolSide = protocolViewBrokenChain();
    await pumpSettings(tester, size: const Size(1350, 4000));

    // 三行的档名必须在
    expect(find.text('① 进程'), findsOneWidget);
    expect(find.text('② OneBot 配置'), findsOneWidget);
    expect(find.text('③ 适配器'), findsOneWidget);
    // 第一档：在跑（这是旧口径丢掉的那个事实）
    expect(find.text('在跑'), findsOneWidget);
    expect(find.textContaining('pid 34552'), findsWidgets);
    expect(find.textContaining('监听 http://127.0.0.1:5099'), findsOneWidget);
    // 第二档：缺失 + 说清"为什么"
    expect(find.text('缺失'), findsOneWidget);
    expect(find.textContaining('未登录 QQ'), findsOneWidget);
    // 第三档：没端点可连（而不是"连不上"——那是两句不同的话）
    expect(find.text('没端点可连'), findsOneWidget);
    // 面板地址照给：state 是 failed，但面板确实开着（旧口径会把按钮一起藏掉）
    expect(find.widgetWithText(FilledButton, '打开面板'), findsOneWidget);
    // 没有口令可用时如实说"找不回来"，并给出唯一的出路
    expect(find.textContaining('初始凭据找不回来'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  /// 凭据显示的分寸：屏幕上只出现**打码**形态，明文只走「复制凭据」那一下。
  testWidgets('协议端卡片：凭据只以打码形态出现在屏幕上（明文进剪贴板）', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform,
        (call) async {
      if (call.method == 'Clipboard.setData') {
        copied.add((call.arguments as Map)['text'] as String);
      }
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null));

    await pumpSettings(tester, size: const Size(1350, 4000));

    expect(find.textContaining('d1…03'), findsOneWidget, reason: '屏幕上给的是打码形态');
    expect(find.textContaining('d198b971dd2b7b03'), findsNothing, reason: '明文不许出现在界面上');

    await tester.tap(find.widgetWithText(FilledButton, '复制凭据'));
    await drain(tester);
    expect(copied, ['admin d198b971dd2b7b03'], reason: '真要明文时走剪贴板（它不在屏幕上停留）');
    expect(tester.takeException(), isNull);
  });

  testWidgets('协议端卡片：开关写 channels.onebot.enabled（PUT，不是 commands）', (tester) async {
    // 视口要高过整张卡：v35 在状态行下面加了「一键安装」那一块，开关随之下移
    await pumpSettings(tester, size: const Size(1350, 4000));

    final toggle = find.byKey(const ValueKey('protocol-side-enabled'));
    expect(tester.widget<Switch>(toggle).value, isTrue, reason: '开关显示的是盘上那份的当前值');

    await tester.tap(toggle);
    await drain(tester);
    expect(sideMethod, 'PUT');
    expect(sidePath, '/api/protocol-side/config');
    expect(sideBody, {'enabled': false});
    // 回执里说要重启：提示里必须带上这句（不说的话人点完保存会以为已经生效）
    await pumpUntil(tester, find.textContaining('已关闭内置协议端'));
    expect(find.textContaining('重启进程后接管'), findsOneWidget);
  });

  testWidgets('协议端卡片：目录可编辑、保存走 PUT、回填服务端归一化后的路径', (tester) async {
    // 同上：目录那一格在「一键安装」之下，视口要给够才点得到
    await pumpSettings(tester, size: const Size(1350, 4000));

    final field = find.byKey(const ValueKey('protocol-side-dir'));
    expect(tester.widget<TextField>(field).controller?.text, 'D:/SnowLuma');

    // 未改动即禁用（与模型卡的保存同一条口径）
    FilledButton save() => tester.widget<FilledButton>(find.widgetWithText(FilledButton, '保存目录'));
    expect(save().onPressed, isNull);

    await tester.enterText(field, r'C:\path\to\snowluma');
    await tester.pump();
    expect(save().onPressed, isNotNull);
    // 服务端写盘那一步的回执：**归一化之后**的路径就是它给的（真实服务端会解成绝对路径）
    sideWriteReply = <String, dynamic>{'ok': true, 'restartRequired': true, 'dir': r'C:\path\to\snowluma'};
    // 写完之后 GET 看到的也是新值（这是"保存成功"的判据）
    protocolSide = <String, dynamic>{...protocolSide, 'dir': r'C:\path\to\snowluma'};
    await tester.tap(find.widgetWithText(FilledButton, '保存目录'));
    await drain(tester);

    expect(sideMethod, 'PUT');
    expect(sideBody, {'dir': r'C:\path\to\snowluma'});
    await pumpUntil(tester, find.textContaining('已保存安装目录'));
    // 回填的是**服务端存下来的那个**（它才是以后真正会用的路径）
    expect(tester.widget<TextField>(field).controller?.text, r'C:\path\to\snowluma');
    expect(save().onPressed, isNull, reason: '保存成功后又回到干净态');
  });

  testWidgets('协议端卡片：启动/停止走 POST，并把服务端那句 note 原样弹出来', (tester) async {
    protocolSide = <String, dynamic>{
      ...protocolView(),
      'state': 'stopped',
      'stateText': '已停止',
      'detail': '已停止（本次没有自动拉起：autoStart=false，或者还没点过「启动」）。',
      'endpoint': null,
      'webuiUrl': null,
      'summary': '进程没在跑 · OneBot 配置在 · 适配器没端点可连',
      // 没在跑：第一档如实说"没在跑"，面板地址不给（那个页面此刻打不开）
      'process': {'known': true, 'running': false, 'detail': '没在跑'},
      'adapter': {
        'state': 'no-endpoint',
        'connected': false,
        'hasEndpoint': false,
        'reconnectAttempts': 0,
        'lastEventAt': null,
        'delivered': 0,
      },
      'webuiLogin': null,
    };
    await pumpSettings(tester, size: const Size(1350, 3400));

    // 没在跑：不给「打开面板」（那个页面此刻打不开），「启动」可用、「停止」禁用
    expect(find.widgetWithText(FilledButton, '打开面板'), findsNothing);
    expect(find.text('没在跑'), findsWidgets);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '启动')).onPressed, isNotNull);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '停止')).onPressed, isNull);

    sideActionReply = <String, dynamic>{
      'ok': true,
      'action': 'start',
      'changed': false,
      'state': 'failed',
      // 服务端那句 note 的原话（界面必须原样弹出来，不自己编一套）
      'note': '没能拉起来（或者它已经在了但端口一直没通）：原因见下面的状态说明。'
          '要重来一次，先点「停止」再点「启动」——服务层见到已有子进程会直接返回，重复点「启动」不会有任何动作。',
    };
    await tester.tap(find.widgetWithText(FilledButton, '启动'));
    await drain(tester);

    expect(sideMethod, 'POST');
    expect(sidePath, '/api/protocol-side/start');
    await pumpUntil(tester, find.textContaining('没能拉起来'));
    expect(find.textContaining('先点「停止」再点「启动」'), findsOneWidget,
        reason: 'note 是服务端写给人看的那句话，要原样出现（界面不自己编一套）');
  });

  testWidgets('协议端卡片：restartRequired 时摆「需重启」徽章与提示条', (tester) async {
    protocolSide = <String, dynamic>{
      ...protocolView(),
      'attached': false,
      'restartRequired': true,
      // 目录刚改过：入口信息属于**旧实例**，服务端因此报"不知道"（null）而不是 false
      'installed': null,
      'entryPath': null,
      'state': 'stopped',
      'stateText': '已停止',
      'detail': '这段配置是本次进程启动之后才写下的：重启进程后框架才会接管它的拉起与对接。',
      'endpoint': null,
      'webuiUrl': null,
      // 没有实例：第一档如实报"未观测"（**不是**"没在跑"——那两句话不一样）
      'summary': '进程未观测 · OneBot 配置在 · 适配器没端点可连',
      'process': {
        'known': false,
        'running': null,
        'detail': '本进程没有装配协议端实例，这一档没人在看（重启进程后才看得到）。',
      },
      'webuiLogin': null,
    };
    await pumpSettings(tester, size: const Size(1350, 3400));

    expect(inProtocolCard(find.text('需重启')), findsOneWidget);
    expect(find.textContaining('要重启进程才接管'), findsOneWidget);
    // 没有实例时也要说清楚：启停按钮此刻按下去不会有动作
    expect(find.textContaining('本次进程启动时还没读到这段配置'), findsOneWidget);
    // installed 的三态要分开：null 不是 false——"不知道"不该被说成"这个目录里没有入口"
    expect(find.text('入口要重启后才核对'), findsOneWidget);
    // 第一档的三态同理：没有实例 ≠ 没在跑（实测现场正是"进程在跑、只是本次框架没管它"）
    expect(find.text('未观测'), findsOneWidget);
    expect(find.text('没在跑'), findsNothing, reason: '没人在看的时候不许替它下"没在跑"这个结论');
    expect(find.text('目录里没有可执行入口'), findsNothing);
  });

  testWidgets('协议端卡片：没配置时是空态，但引导与输入框都还在（不能把出路藏起来）', (tester) async {
    protocolSide = <String, dynamic>{
      'configured': false,
      'enabled': false,
      'kind': null,
      'dir': '',
      'autoStart': false,
      'configSource': 'disk',
      'attached': false,
      'state': 'stopped',
      'stateText': '已停止',
      'detail': '未配置内置协议端：框架不拉起它，OneBot 连的是配置里手填的地址与密钥。',
      'restartRequired': false,
      'endpoint': null,
      'webuiUrl': null,
      'installed': false,
      'entryPath': null,
    };
    await pumpSettings(tester, size: const Size(1350, 3400));

    expect(find.text('还没配置内置协议端。'), findsOneWidget);
    // 引导必须在：下载地址是纯文本给出来的（框架从官方代下载，但自己下的那条路一直在）
    expect(find.textContaining('https://github.com/SnowLuma/SnowLuma/releases'), findsOneWidget);
    // 2026-10 起这条出路是**普通链接**，不再是按钮：SnowLumaDevs 的书面要求②是"无需自动弹出浏览器"
    expect(inProtocolCard(find.byKey(const ValueKey('protocol-side-download-page'))), findsOneWidget);
    expect(inProtocolCard(find.widgetWithText(FilledButton, '打开下载页')), findsNothing);
    // v35 的主路径也必须在这里：没配置的时候正是最需要「一键安装」的时候
    expect(find.byKey(const ValueKey('protocol-side-install')), findsOneWidget);
    // 输入框与开关也必须在——空态里没有它们，人就没有地方可填
    expect(find.byKey(const ValueKey('protocol-side-dir')), findsOneWidget);
    expect(find.byKey(const ValueKey('protocol-side-enabled')), findsOneWidget);
    // 卡头也要如实说"未配置"，而不是留白或者乐观地写一句状态
    expect(inProtocolCard(find.text('未配置')), findsOneWidget);
  });

  testWidgets('协议端状态读不到：只灰这张卡，且不给写入控件（不在盲写）', (tester) async {
    protocolFails = true;
    await pumpSettings(tester, size: const Size(1350, 3400));
    await pumpUntil(tester, find.textContaining('协议端状态读取失败'));

    expect(find.textContaining('协议端状态读取失败'), findsOneWidget);
    // 整页照常：别的分区还在
    expect(find.text('外部依赖'), findsNWidgets(2));
    expect(find.text('系统'), findsNWidgets(2));
    // 读不到当前值时**不提供**开关与目录：那等于让人在看不到当前值的情况下写它。
    // v35 的「一键安装」同理不摆——它紧接着就要写配置，那就是盲写
    expect(find.byKey(const ValueKey('protocol-side-enabled')), findsNothing);
    expect(find.byKey(const ValueKey('protocol-side-dir')), findsNothing);
    expect(find.byKey(const ValueKey('protocol-side-install')), findsNothing);
    expect(find.textContaining('这张卡读不到不影响其它设置'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('协议端状态正常时不该挂着报错文案（反向断言）', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));
    await pumpUntil(tester, find.text('协议端（可选）'));
    expect(find.textContaining('协议端状态读取失败'), findsNothing);
  });

  // ── 第三方署名（SnowLumaDevs 的书面要求①②，凭证见 docs/third-party-authorizations.md） ──
  //
  // 两条要求落到代码上是两件**不同**的事，所以各有一条用例：
  //   ① 「在集成界面注明 SnowLuma 是独立第三方项目，并提供官方项目及许可链接」⇒ 说明与链接都在；
  //   ② 「无需自动弹出浏览器」⇒ 卡片照常渲染时**一个地址都不开**；点链接才开；安装流程**从头到尾**
  //      不碰 `openExternalUrl`（真开浏览器那条路只有 `external_link.dart` 一处，
  //      用例把它换成记账的替身，于是"开没开"是可断言的事实，而不是靠读代码）。

  testWidgets('协议端卡片：注明 SnowLuma 是独立第三方项目，官方项目/站点/许可链接都在，且是普通链接', (tester) async {
    final opened = <String>[];
    externalUrlOpener = (url) async => opened.add(url);
    addTearDown(() => externalUrlOpener = openUrlInSystemBrowser);

    await pumpSettings(tester, size: const Size(1350, 4000));

    const zh = ZhStrings();
    expect(find.text(zh.settingsProtocolThirdPartyTitle), findsOneWidget,
        reason: '要求①：卡上要有一处点明这是第三方组件');
    expect(find.text(zh.settingsProtocolThirdPartyNote), findsOneWidget,
        reason: '要求①：那段说明（独立第三方 / 只代为下载并托管、不改文件 / 须遵守 EULA）必须在屏上');

    // 两个官方链接：**地址本身就是可见文字**（对方要"提供官方项目及许可链接"，藏进 tooltip 不算）
    expect(inProtocolCard(find.text(protocolProjectUrl)), findsOneWidget);
    expect(inProtocolCard(find.text(protocolSiteUrl)), findsOneWidget);
    // 许可那一行（EULA 与 LICENSE）也在
    expect(find.text(zh.settingsProtocolLicenseRow), findsOneWidget);
    for (final key in <String>[
      'protocol-side-link-project',
      'protocol-side-link-site',
      'protocol-side-link-eula',
      'protocol-side-link-license',
    ]) {
      expect(find.byKey(ValueKey(key)), findsOneWidget, reason: '缺链接：$key');
    }

    // 它们是**链接，不是按钮**：这一块不许有"按钮点了就开页面"的形状
    // （只看协议端卡内部：「外部依赖」卡里 pwsh 那条人装路仍是按钮，它与本授权无关）
    expect(find.widgetWithText(FilledButton, protocolProjectUrl), findsNothing);
    expect(find.widgetWithText(FilledButton, protocolSiteUrl), findsNothing);
    expect(inProtocolCard(find.widgetWithText(FilledButton, '打开下载页')), findsNothing);

    // 要求②：**渲染这一页本身不开任何地址**（不自动弹浏览器）
    expect(opened, isEmpty, reason: '卡片渲染不许自己开浏览器——对方原话是"无需自动弹出浏览器"');

    // 人点链接才开，而且开的是那一条
    final project = find.byKey(const ValueKey('protocol-side-link-project'));
    await tester.ensureVisible(project);
    await tester.pump();
    await tester.tap(project);
    await drain(tester);
    expect(opened, <String>[protocolProjectUrl], reason: '点「官方项目」只该开这一个地址');
  });

  testWidgets('一键安装：装成功也**不打开任何外部页面**（安装流程里没有"顺手开浏览器"这一步）', (tester) async {
    final opened = <String>[];
    externalUrlOpener = (url) async => opened.add(url);
    addTearDown(() => externalUrlOpener = openUrlInSystemBrowser);

    await pumpSettings(tester, size: const Size(1350, 4000));
    expect(opened, isEmpty, reason: '载入页面本身不该开浏览器');

    final install = find.byKey(const ValueKey('protocol-side-install'));
    await tester.ensureVisible(install);
    await tester.pump();
    await tester.tap(install);
    await pumpUntil(tester, find.textContaining('已装好 v1.14.20'));
    await drain(tester);

    // 先证"按钮真的点着、请求真的发出去了"——否则"没开浏览器"可能只是"什么都没发生"
    expect(installCalls, 1, reason: '安装请求必须真的发出（不然这条用例证明不了任何事）');
    expect(find.textContaining('已装好 v1.14.20'), findsWidgets, reason: '整条安装流程要走完');
    // 要求②：整条安装流程**不碰** openExternalUrl（下载页、官方站点都不许被自动打开）
    expect(opened, isEmpty, reason: '安装流程不许打开任何外部页面（对方要求②）');
  });

  // ── 一键安装（v35）：一次点击 + 一次重启 + 一次扫码 ──

  testWidgets('一键安装：装成功后自动把目录/开关/自动拉起一次写好，并给出「重启 → 扫码」的引导', (tester) async {
    // 起点就是用户说的那个场景：这台机器还没配置过，用户点一下要能走通
    protocolSide = <String, dynamic>{
      'configured': false,
      'enabled': false,
      'kind': null,
      'dir': '',
      'autoStart': false,
      'configSource': 'disk',
      'attached': false,
      'state': 'stopped',
      'stateText': '已停止',
      'detail': '未配置内置协议端：框架不拉起它，OneBot 连的是配置里手填的地址与密钥。',
      'restartRequired': false,
      'endpoint': null,
      'webuiUrl': null,
      'installed': false,
      'entryPath': null,
    };
    // 把安装请求按住：这段窗口里补上"盘上已经有了"这条事实（真服务端装完就是这样）
    final gate = Completer<void>();
    installGate = gate;
    await pumpSettings(tester, size: const Size(1350, 4000));

    // 空态里也必须有一键安装这条路——空态最忌讳的就是把出路一起藏起来
    final install = find.byKey(const ValueKey('protocol-side-install'));
    expect(install, findsOneWidget);
    expect(find.text('还没配置内置协议端。'), findsOneWidget);
    // 前提要**装之前**就说，而且是用户 ⑨ 定的那句
    expect(find.textContaining('使用前提：本机已登录 QQ 客户端'), findsOneWidget);

    await tester.tap(install);
    await pumpUntil(tester, find.textContaining('正在从官方 Releases 下载并解压'));
    await drain(tester);
    expect(installCalls, 1);

    // 装完：PUT 的回执与随后的 GET 都按真服务端的形状给（配置写下了、本进程还没接管它）
    sideWriteReply = <String, dynamic>{
      'ok': true,
      'restartRequired': true,
      'dir': r'C:\path\to\snowluma',
    };
    protocolSide = <String, dynamic>{
      ...protocolView(),
      'dir': r'C:\path\to\snowluma',
      'restartRequired': true,
      'attached': false,
      'state': 'stopped',
      'stateText': '已停止',
      'detail': '这段配置是本次进程启动之后才写下的：重启进程后框架才会接管它的拉起与对接。',
      'endpoint': null,
      'webuiUrl': null,
      'summary': '进程未观测 · OneBot 配置在 · 适配器没端点可连',
      'process': {
        'known': false,
        'running': null,
        'detail': '本进程没有装配协议端实例，这一档没人在看（重启进程后才看得到）。',
      },
      'webuiLogin': null,
      // 没有实例去核对那个目录："不知道"就报 null，不能说成"这个目录里没有入口"
      'installed': null,
      'entryPath': null,
    };
    gate.complete();
    await pumpUntil(tester, find.text('已装好并用它配好了；重启一下就能用'));
    await drain(tester);

    // **本轮的核心那一条**：装成功后确实调了 PUT /config，而且一次把三件事都写好——
    // 这就是"尽量少配置"的落点：用户一个字段都不用碰
    expect(sideMethod, 'PUT');
    expect(sidePath, '/api/protocol-side/config');
    expect(sideBody, <String, dynamic>{
      'dir': r'C:\path\to\snowluma',
      'enabled': true,
      'autoStart': true,
    });

    // 卡上：装好那句话 + 逐行过程记录（那是给人看的进度，不藏着）
    expect(find.textContaining('已装好 v1.14.20，并用它配好了；重启一下就能用。'), findsOneWidget);
    expect(find.text('正在下载…'), findsOneWidget);
    expect(find.text('下载完成（4.6 MB）'), findsOneWidget);

    // 装好之后的引导：先重启、再扫码、扫码是接入 QQ 客户端
    expect(find.textContaining('已经装好了。下一步'), findsOneWidget);
    expect(find.textContaining('先重启服务'), findsOneWidget);
    expect(find.textContaining('打开面板'), findsWidgets);
    expect(find.textContaining('扫码接的是你本机的 QQ 客户端'), findsOneWidget);

    // 目录与开关都替人写好了：目录框回填的是**服务端存下来的那个**，开关是开的，且没有未保存改动
    expect(tester.widget<TextField>(find.byKey(const ValueKey('protocol-side-dir'))).controller?.text,
        r'C:\path\to\snowluma');
    expect(tester.widget<Switch>(find.byKey(const ValueKey('protocol-side-enabled'))).value, isTrue);
    expect(tester.widget<FilledButton>(find.widgetWithText(FilledButton, '保存目录')).onPressed, isNull);
    // 「需重启」要摆出来，且入口三态不许把"不知道"说成"没有"
    expect(inProtocolCard(find.text('需重启')), findsOneWidget);
    expect(find.text('入口要重启后才核对'), findsOneWidget);
    expect(inProtocolCard(find.text('目录里没有可执行入口')), findsNothing);
  });

  testWidgets('一键安装失败：detail 原文与过程记录摆在卡上，并留着手动下载那条出路', (tester) async {
    // 失败也是 200（只有鉴权 / 方法不对才非 200），所以判据是 ok，界面不能只看状态码
    const detail = '下载失败：connect ETIMEDOUT——检查网络，或手动下载后把目录填进来。';
    installSideReply = <String, dynamic>{
      'ok': false,
      'dir': null,
      'version': null,
      'detail': detail,
      'log': <String>[
        '正在查询官方 Releases…',
        '找到 v1.14.20 的 SnowLuma-v1.14.20-win-x64-lite.zip（4.6 MB）',
        '正在下载…',
      ],
    };
    await pumpSettings(tester, size: const Size(1350, 4000));

    await tester.tap(find.byKey(const ValueKey('protocol-side-install')));
    await pumpUntil(tester, find.text('一键安装失败：原因见卡片'));
    await drain(tester);

    // 失败**不能**塞进一条 toast 就完了：detail 与 log 都留在卡上，人要看得见卡在哪一步
    expect(find.text(detail), findsOneWidget);
    expect(inProtocolCard(find.text('正在下载…')), findsOneWidget);
    expect(inProtocolCard(find.textContaining('找到 v1.14.20 的')), findsOneWidget);
    expect(inProtocolCard(find.textContaining('过程记录')), findsOneWidget);

    // 出路还在：手动下载那条路（地址 + 链接）不能被失败一起吞掉
    expect(inProtocolCard(find.textContaining('手动出路')), findsOneWidget);
    expect(find.textContaining('https://github.com/SnowLuma/SnowLuma/releases'), findsWidgets);
    expect(inProtocolCard(find.byKey(const ValueKey('protocol-side-download-page'))), findsOneWidget);

    // 没装成就不该往配置里写：**没有** PUT /config（请求停在安装那一条上）
    expect(installCalls, 1);
    expect(sideMethod, 'POST');
    expect(sidePath, '/api/protocol-side/install');
    // 也不许摆出"重启一下就能用"这种乐观结论
    expect(find.textContaining('已装好'), findsNothing);
    expect(find.textContaining('已经装好了。下一步'), findsNothing);
  });

  testWidgets('安装期间：按钮转忙且点不动，重复点只发一次请求，这张卡的写控件一并按下', (tester) async {
    final gate = Completer<void>();
    installGate = gate;
    await pumpSettings(tester, size: const Size(1350, 4000));

    final install = find.byKey(const ValueKey('protocol-side-install'));
    await tester.tap(install);
    await pumpUntil(tester, find.textContaining('正在从官方 Releases 下载并解压'));
    await drain(tester);
    expect(installCalls, 1);
    // 不能摆假进度：这条端点是同步的，中间插不进进度行——就说清"记录会一次性回来"
    expect(find.textContaining('分步记录'), findsOneWidget);

    // 安装中按钮必须是禁用的：这条端点同步跑几秒到几十秒，点两遍就是下两份、解压两遍
    expect(tester.widget<FilledButton>(install).onPressed, isNull);
    // 再点一次（禁用态）：仍然只有一次请求
    await tester.tap(install, warnIfMissed: false);
    await drain(tester);
    expect(installCalls, 1, reason: '安装中重复点击不该发第二个请求');

    // 这张卡的其它写控件也一并按下：安装会把那个目录整段清空重写，
    // 这期间去启停一个正从那个目录跑着的实例，两件事都能弄坏
    expect(tester.widget<Switch>(find.byKey(const ValueKey('protocol-side-enabled'))).onChanged, isNull);
    expect(tester.widget<TextField>(find.byKey(const ValueKey('protocol-side-dir'))).enabled, isFalse);

    // 放开闸门：这一次安装照常走完，提示与请求都还是那一次
    gate.complete();
    await pumpUntil(tester, find.text('已装好并用它配好了；重启一下就能用'));
    await drain(tester);
    expect(installCalls, 1);
    expect(sidePath, '/api/protocol-side/config');
  });

  // ── 「系统」卡（用户 ⑪ 起可改，⑭ 起改成逐行就地编辑） ──
  //
  // ⑪ 那四条用例断言的是"一直摊开的表单"（九格常驻输入框、卡头浮脏提示、卡底一个总保存键）。
  // ⑭ 把交互换成了"紧凑表 + 每行一枚胶囊"（用户原话："就像原来这样，后面有个胶囊按钮，
  // 点击就可以编辑对应行行不行吗"），语义变了，所以这四条**重写**而不是把断言改绿：
  // 现在要锁的是"只动这一行、只写这一行、取消就丢、改不了的行没有胶囊"。

  testWidgets('系统卡：默认只露 4 行，其余收在「查看全部」后面，展开后能再收起', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    // 默认露出来的正是那 4 项：监听地址 / 时区 / 预算 · 每日 token 上限 / 数据目录
    // （用户 ⑭ 点名："最常看/最常调的先摆"）。读数就是 config.json 里的原值。
    expect(sysValue(tester, 'web'), '127.0.0.1:7788');
    expect(sysValue(tester, 'timezone'), 'Asia/Shanghai');
    expect(sysValue(tester, 'budget.dailyTokens'), '2000000');
    expect(inSystemCard(find.text('D:/irmia/data')), findsOneWidget, reason: '第 4 行是数据目录');

    // 其余 7 行连渲染都还没发生（不是"藏起来"，是根本没挂上去）
    expect(find.byKey(const ValueKey('sys-value-budget.stepTools')), findsNothing);
    expect(inSystemCard(find.text('预算 · 软阈值')), findsNothing);
    expect(inSystemCard(find.text('destructive 工具策略')), findsNothing);
    // 心跳平均间隔（2026-10-05 加的那一行）也收在里面：它落在预算那一组的末尾
    expect(inSystemCard(find.text('心跳间隔 · 平均（分钟）')), findsNothing);
    expect(find.byKey(const ValueKey('sys-value-wake.heartbeatTargetMeanMin')), findsNothing);

    // CappedChildren 报的是**总行数**（11 = 9 个可编辑 + 2 个只读），标签在展开后切成「收起」
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));
    expect(inSystemCard(find.text('预算 · 软阈值')), findsOneWidget);
    expect(inSystemCard(find.text('destructive 工具策略')), findsOneWidget);
    expect(inSystemCard(find.text('心跳间隔 · 平均（分钟）')), findsOneWidget);
    expect(inSystemCard(find.text('查看全部（12 行）')), findsNothing);
    expect(inSystemCard(find.text('收起')), findsOneWidget);

    await tapInCard(tester, inSystemCard(find.text('收起')));
    expect(inSystemCard(find.text('预算 · 软阈值')), findsNothing, reason: '展开后要能再收起');
    expect(inSystemCard(find.text('查看全部（12 行）')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await drain(tester);
  });

  testWidgets('系统卡：点「编辑」只让那一行就地变输入框，别行照旧是只读值', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    await tapInCard(tester, sysEdit('timezone'));

    // 就地：框里先摆着当前值（不是空框，也不是示例）
    expect(sysText(tester, 'timezone'), 'Asia/Shanghai');
    // 这一行的读态值让位给输入框（两者不会同时在）
    expect(find.byKey(const ValueKey('sys-value-timezone')), findsNothing);
    // 胶囊那一位换成「保存 / 取消」
    expect(sysEdit('timezone'), findsNothing);
    expect(sysSaveBtn('timezone'), findsOneWidget);
    expect(sysCancelBtn('timezone'), findsOneWidget);

    // **其余行不动**：它们还是只读值 + 各自的胶囊，页面上没有第二个输入框
    expect(sysValue(tester, 'budget.dailyTokens'), '2000000');
    expect(find.byKey(const ValueKey('sys-field-budget.dailyTokens')), findsNothing);
    expect(sysEdit('budget.dailyTokens'), findsOneWidget);

    // 没改动时「保存」是灰的（这一页的既有分寸：未改动即禁用）
    expect(tester.widget<FilledButton>(sysSaveBtn('timezone')).onPressed, isNull);
    await tester.enterText(find.byKey(const ValueKey('sys-field-timezone')), 'Europe/Paris');
    await tester.pump();
    expect(tester.widget<FilledButton>(sysSaveBtn('timezone')).onPressed, isNotNull);

    // ⑭ 起没有"整卡脏了"这个概念：卡头不再浮脏提示，卡片底部也没有总保存键——
    // 卡里此刻只有**这一行**那一枚「保存」
    expect(find.text('有未保存的更改'), findsNothing);
    expect(inSystemCard(find.widgetWithText(FilledButton, '保存')), findsOneWidget);
    await drain(tester);
  });

  testWidgets('系统卡：行内「保存」只发一条 config-update，body 里只有这一行的字段', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    await tapInCard(tester, sysEdit('budget.dailyTokens'));
    await tester.enterText(find.byKey(const ValueKey('sys-field-budget.dailyTokens')), '5000000');
    await tester.pump();
    await tapInCard(tester, sysSaveBtn('budget.dailyTokens'));
    await pumpUntil(tester, find.text('已保存，重启后生效'));

    // 一条请求、只有这一个字段（别的八行一个字都没带）
    expect(postCount, 1, reason: '逐行保存就是一条请求');
    expect(lastPost?['fields'], {'budget.dailyTokens': 5000000});
    expect(lastConfirm, 'config-update', reason: '写配置必须带 X-Confirm');

    // 保存成功后退出编辑态、退回只读行；值按盘上那份回填（假服务端没改值，所以回到原值）
    expect(find.byKey(const ValueKey('sys-field-budget.dailyTokens')), findsNothing);
    expect(sysEdit('budget.dailyTokens'), findsOneWidget);
    expect(sysValue(tester, 'budget.dailyTokens'), '2000000');
    expect(find.text('有未保存的更改'), findsNothing);
    await drain(tester);
  });

  testWidgets('系统卡：六个示例值（hint）逐个钉住——每日 token 上限与出厂默认 100M 对齐', (tester) async {
    // 判据：提示值 = **出厂默认值**（`src/config/config.ts` 的 `buildDefaults`）。出厂从 2M 改成
    // 100M 之后，这里若还写着 2000000，就是在教人填一个会被心跳自己吃穿的值。这条测试同时钉住
    // "只动了日额度那一个"——其余五个提示**没有**跟着改（防"顺手一起改"）。
    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    /// 点开某一行的编辑态，读那一格输入框的 hint，再用「取消」把这行收回去
    /// （不收的话下一行要点的「编辑」胶囊不在——这正是逐行交互的样子）。
    Future<String?> hintOf(String id, String path) async {
      await tapInCard(tester, sysEdit(id));
      final box = tester.widget<TextField>(find.byKey(ValueKey('sys-field-$path')));
      final hint = box.decoration?.hintText;
      await tapInCard(tester, sysCancelBtn(id));
      return hint;
    }

    expect(await hintOf('budget.dailyTokens', 'budget.dailyTokens'), '100000000',
        reason: '每日 token 上限的提示要跟出厂默认（100_000_000）逐字一致，不是随手一个示例');
    expect(await hintOf('budget.stepTools', 'budget.stepTools'), '20');
    expect(await hintOf('budget.turnSteps', 'budget.turnSteps'), '30');
    expect(await hintOf('budget.taskTokens', 'budget.taskTokens'), '500000');
    expect(await hintOf('budget.softRatio', 'budget.softRatio'), '0.8');
    expect(await hintOf('budget.failStreakMax', 'budget.failStreakMax'), '5');
    await drain(tester);
  });

  testWidgets('系统卡：非法值当场拦下，一个字节都不写盘（六种取值逐个试）', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));
    // 六次里有两次落在默认收起的那几行上（软阈值 / 步内工具调用上限），先把整张表展开
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    // 逐条按解析器的规则来（src/config/config.ts）。每一格试完用「取消」把这一行收掉：
    // 不然那一行还开着输入框，下一行要点的「编辑」胶囊根本不在（这正是逐行交互的样子）。
    Future<void> check(String id, String path, String bad, String message) async {
      await tapInCard(tester, sysEdit(id));
      await tester.enterText(find.byKey(ValueKey('sys-field-$path')), bad);
      await tester.pump();
      await tapInCard(tester, sysSaveBtn(id));
      await pumpUntil(tester, find.text(message));
      expect(postCount, 0, reason: '$path = $bad 不该写进配置');
      // 拦下之后**留在编辑态**：人就在那个框上，改完再按一次就行
      expect(find.byKey(ValueKey('sys-field-$path')), findsOneWidget);
      await tapInCard(tester, sysCancelBtn(id));
      expect(find.byKey(ValueKey('sys-field-$path')), findsNothing);
    }

    // host 空串：解析器收，但空串会绑到所有网卡——界面按危险处理
    await check('web', 'web.host', '', '监听地址不能为空：空值等于监听所有网卡，未保存');
    // 端口越界（pickInt(..., 1, 65535)）
    await check('web', 'web.port', '70000', '端口要在 1~65535 之间，未保存');
    // 时区空串：pickNonEmptyString 直接拒
    await check('timezone', 'timezone', '', '时区不能为空，未保存');
    // 80 而不是 0.8：这是解析器专门抓的那个真实错误（pickRatio 的注释里就写着它）
    await check('budget.softRatio', 'budget.softRatio', '80',
        '预算 · 软阈值是比例，要落在 0~1 之间（不含 0），未保存');
    // 预算是整数，下限 1（pickInt 的 min）
    await check('budget.stepTools', 'budget.stepTools', '0', '预算 · 步内工具调用上限最小是 1，未保存');
    // 紧凑写法在这里不接受：框里要的是 config.json 里的原值（⑪ 的硬要求，⑭ 照旧）
    await check('budget.dailyTokens', 'budget.dailyTokens', '2M', '预算 · 每日 token 上限要填整数，未保存');

    // 六次尝试，零请求
    expect(postCount, 0);
    await drain(tester);
  });

  testWidgets('系统卡：行内「取消」丢弃这一行的改动，一个请求都不发', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    await tapInCard(tester, sysEdit('timezone'));
    await tester.enterText(find.byKey(const ValueKey('sys-field-timezone')), 'Europe/Paris');
    await tester.pump();
    await tapInCard(tester, sysCancelBtn('timezone'));

    expect(postCount, 0, reason: '「取消」就是丢弃，不该有任何写请求');
    expect(find.byKey(const ValueKey('sys-field-timezone')), findsNothing);
    expect(sysValue(tester, 'timezone'), 'Asia/Shanghai');

    // 草稿没留下：再点开还是盘上那份
    await tapInCard(tester, sysEdit('timezone'));
    expect(sysText(tester, 'timezone'), 'Asia/Shanghai');
    expect(postCount, 0);
    await drain(tester);
  });

  testWidgets('系统卡：数据目录只读，destructive 策略这一行是唯一能改它的地方', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    // 两条只读行没有胶囊，也没有输入框（键就是点路径/行 id，找不到即证明它不可编辑）
    expect(find.byKey(const ValueKey('sys-edit-dataDir')), findsNothing);
    expect(find.byKey(const ValueKey('sys-edit-tools.destructiveEnabled')), findsNothing);
    expect(find.byKey(const ValueKey('sys-field-dataDir')), findsNothing);
    expect(find.byKey(const ValueKey('sys-field-tools.destructiveEnabled')), findsNothing);

    // 原因写在各自那一行里（不是一句"只读"）
    expect(inSystemCard(find.text('D:/irmia/data')), findsOneWidget);
    expect(inSystemCard(find.textContaining('换它等于让下一个进程从空目录开始')), findsOneWidget);

    // destructive 那一行**不是只读的**，只是它的改法与别的行不同（⑪ 起可改，2026-10-04 用户定调）。
    // 它没有 `sys-edit-*` 胶囊，走的是一条三档选择通道：行上摆当前档 + 一枚「修改」，
    // 点开弹层选档 → 再过一道确认框 → 才写盘（写的时候带字段级危险短语）。
    // 为什么锁这一条：它曾经与数据目录并排当"只读行"，看起来像"这里改不了"——
    // 那会把人推去手改 config.json，而这个开关正是最不该让人手改的一个。
    final policyRow = find.ancestor(
      of: find.text('destructive 工具策略'),
      matching: find.byType(Row),
    ).first;
    // 行上的读数就是**盘上那份配置**的档位（示例是 false = 全关），不是一句静态说明
    expect(
      find.descendant(of: policyRow, matching: find.text('全关')),
      findsOneWidget,
      reason: '行上要摆当前档，人才知道现在是哪一档',
    );
    final policyEdit = find.descendant(of: policyRow, matching: find.text('修改'));
    expect(policyEdit, findsOneWidget, reason: '这一行可改：给一枚明确的入口，而不是只写一句说明');
    await tapInCard(tester, policyEdit);

    // 三档弹层：全关 / 全开 / 按名单（后两档要挑工具，所以「按名单」那一步是另一个弹层）
    expect(find.text('全关（一件都不给她看）'), findsOneWidget);
    expect(find.text('全开（清单里全给）'), findsOneWidget);
    expect(find.text('按名单（只给勾中的那几件）'), findsOneWidget);

    // 选「全开」→ ui_kit 确认框（放宽权限这件事要人再点一次头）
    await tester.tap(find.text('全开（清单里全给）'));
    await tester.pumpAndSettle();
    expect(find.text('修改 destructive 工具策略'), findsOneWidget, reason: '放宽之前还要一道确认');
    expect(postCount, 0, reason: '确认之前一个字节都不该写盘');

    // 确认之后才是那一次写：值是 true，且必须带字段级危险短语（服务端按它拦）
    await tester.tap(find.text('确认'));
    await pumpUntil(tester, find.text('已保存（重启后接管）'));
    expect(postCount, 1);
    expect(lastPost?['fields'], {'tools.destructiveEnabled': true});
    expect(lastConfirm, 'update-config; enable-destructive');

    // 「需重启」只挂在能改的那 9 行上：改不了的行喊重启没意义（⑭ 的原话）
    expect(inSystemCard(find.text('需重启')), findsNWidgets(9));
    await drain(tester);
  });

  testWidgets('系统卡：监听地址那一行编辑时是两个框，保存时两个字段一起写', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    expect(sysValue(tester, 'web'), '127.0.0.1:7788', reason: '一行一个读数：host:port');

    await tapInCard(tester, sysEdit('web'));
    expect(find.byKey(const ValueKey('sys-field-web.host')), findsOneWidget);
    expect(find.byKey(const ValueKey('sys-field-web.port')), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('sys-field-web.host')), '0.0.0.0');
    await tester.enterText(find.byKey(const ValueKey('sys-field-web.port')), '8899');
    await tester.pump();
    await tapInCard(tester, sysSaveBtn('web'));
    await pumpUntil(tester, find.text('已保存，重启后生效'));

    // 两半本来就是同一行的两个字段：一次写、一条请求
    expect(postCount, 1);
    expect(lastPost?['fields'], {'web.host': '0.0.0.0', 'web.port': 8899});
    expect(lastConfirm, 'config-update');
    await drain(tester);
  });

  // ── 心跳频率：系统卡里那一行 `wake.heartbeatTargetMeanMin`（用户 2026-10-05） ──
  //
  // 用户原话："心跳频率我没有地方可以控制吗？" —— 结论是只能手改 config.json，界面上没有入口。
  // 这三条锁的就是"入口补上了、而且补对了"：
  //   ① 这一行**渲染盘上那份的值**（不是写死的 15，也不是空框）；
  //   ② 改动只走既有的 config-update，body 里就是这一个字段、值就是框里那个数；
  //   ③ 它的 `X-Confirm` **不带**字段短语 —— `trust-full-access` 只给带 `trust.mode` 的请求
  //      （见 settings_page.dart 顶部的写通道说明与 [kTrustConfirm]）。无脑跟一份短语，
  //      轻则没意义，重则把"每次改心跳都要带危险短语"变成习惯，那句话本身就不值钱了。

  testWidgets('系统卡 · 心跳频率：这一行渲染盘上那份的值（15），标签与说明是人话', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));
    // 它在默认收起的那几行里：先展开整张表（与上面几条系统卡用例同一条路）
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    // ① 读态摆的就是配置里那个数（示例配置 = 出厂默认 15）
    expect(sysValue(tester, 'wake.heartbeatTargetMeanMin'), '15',
        reason: '这一行要摆盘上那份的值，不是空着让人猜');
    // ② 标签是人话（点路径不上屏）：用户要能一眼看懂"我改的是哪个数"
    expect(inSystemCard(find.text('心跳间隔 · 平均（分钟）')), findsOneWidget);
    expect(inSystemCard(find.textContaining('wake.heartbeatTargetMeanMin')), findsNothing,
        reason: '字段路径是给实现者看的，不该出现在界面上');

    // ③ 点开编辑态：框里预填当前值，旁注把"越大越省、两端有兜底"如实说清
    await tapInCard(tester, sysEdit('wake.heartbeatTargetMeanMin'));
    expect(sysText(tester, 'wake.heartbeatTargetMeanMin'), '15', reason: '编辑态先摆当前值，不是空框');
    // 文案规则（用户 2026-10-05）：说明 = 一行要点，**不带 markdown 记号**
    //（界面 chrome 不做渲染，渲染器只服务正文）。所以这里既钉内容、也钉"没有 **"。
    expect(
      find.text('她平均多久自己醒一次——越大越省 token，越小越常醒。'
          '两端仍由上下限兜住：不因这个数改变，安静不足下限不会醒、到了上限必然会醒。'),
      findsOneWidget,
      reason: '这句说明是这一行的一半价值：没有它，人不知道自己填的数会怎样影响她',
    );
    expect(find.textContaining('**'), findsNothing, reason: '界面提示里不许再留 markdown 记号');
    await tapInCard(tester, sysCancelBtn('wake.heartbeatTargetMeanMin'));
    await drain(tester);
  });

  testWidgets('系统卡 · 心跳频率：读数跟着配置走（40 也照实渲染，不是写死的 15）', (tester) async {
    // 上一条用的是 15（= 出厂默认），所以它证明不了"读的是配置"——写死 15 也能过。
    // 这一条把盘上那份改成 40：读数必须跟着变，而那正是用户按这个框时看到的起始值。
    config['wake'] = {'heartbeatFloorMin': 5, 'heartbeatCeilMin': 60, 'heartbeatTargetMeanMin': 40};
    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    expect(sysValue(tester, 'wake.heartbeatTargetMeanMin'), '40',
        reason: '框里必须是配置里那个值本身，不是一个写死的默认值');
    await tapInCard(tester, sysEdit('wake.heartbeatTargetMeanMin'));
    expect(sysText(tester, 'wake.heartbeatTargetMeanMin'), '40', reason: '点开编辑态也摆同一个值');
    await tapInCard(tester, sysCancelBtn('wake.heartbeatTargetMeanMin'));
    await drain(tester);
  });

  testWidgets('系统卡 · 心跳频率：改值保存走 config-update，fields 就是这一个字段、X-Confirm 不带字段短语', (tester) async {    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    await tapInCard(tester, sysEdit('wake.heartbeatTargetMeanMin'));
    await tester.enterText(find.byKey(const ValueKey('sys-field-wake.heartbeatTargetMeanMin')), '45');
    await tester.pump();
    await tapInCard(tester, sysSaveBtn('wake.heartbeatTargetMeanMin'));
    await pumpUntil(tester, find.text('已保存，重启后生效'));

    // 一条请求、一个字段、值是框里那个数（不是字符串 '45'，也不是别人的字段）
    expect(postCount, 1, reason: '逐行保存就是一条请求');
    expect(lastPost?['fields'], {'wake.heartbeatTargetMeanMin': 45});
    // X-Confirm：命令短语要有；字段短语**一个都不许跟**
    expect(lastConfirm, contains('config-update'), reason: '写配置必须带命令短语');
    expect(lastConfirm, isNot(contains('trust-full-access')),
        reason: '这一项不在服务端 DANGEROUS_FIELDS 里，不许无脑带上 trust 的字段短语');
    expect(lastConfirm, 'config-update', reason: '逐字相等才算证明：多带的那半截就是从这里溜进去的');

    // 保存成功后退出编辑态、按盘上那份回填（假服务端没改配置，所以回到 15）
    expect(find.byKey(const ValueKey('sys-field-wake.heartbeatTargetMeanMin')), findsNothing);
    expect(sysEdit('wake.heartbeatTargetMeanMin'), findsOneWidget);
    await drain(tester);
  });

  testWidgets('系统卡 · 心跳频率：越界的值当场拦下（一个字节都不写盘）', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    // 逐条按这一行的边界试（6~59）。文案由 _SysField.problem 生成，与别的数值行同一套口径。
    Future<void> check(String bad, String message) async {
      await tapInCard(tester, sysEdit('wake.heartbeatTargetMeanMin'));
      await tester.enterText(
          find.byKey(const ValueKey('sys-field-wake.heartbeatTargetMeanMin')), bad);
      await tester.pump();
      await tapInCard(tester, sysSaveBtn('wake.heartbeatTargetMeanMin'));
      await pumpUntil(tester, find.text(message));
      expect(postCount, 0, reason: 'wake.heartbeatTargetMeanMin = $bad 不该写进配置');
      // 拦下之后留在编辑态：人就在那个框上，改完再按一次就行
      expect(find.byKey(const ValueKey('sys-field-wake.heartbeatTargetMeanMin')), findsOneWidget);
      await tapInCard(tester, sysCancelBtn('wake.heartbeatTargetMeanMin'));
    }

    // 5 = 现存的下限本身：平均值贴着下限不是"平均"，是"每一拍都在最早那一刻"
    await check('5', '心跳间隔 · 平均（分钟）最小是 6，未保存');
    // 60 = 现存的上限本身：同理（这三个数就是边界，不是随手挑的）
    await check('60', '心跳间隔 · 平均（分钟）最大是 59，未保存');
    // 非整数照样拦（与其余数值行同一句文案）
    await check('7.5', '心跳间隔 · 平均（分钟）要填整数，未保存');

    expect(postCount, 0);
    await drain(tester);
  });

  // ── 系统卡 · 压缩线（`persona.compactionThresholdTokens`，用户 2026-10-12 点名要暴露的） ──

  testWidgets('压缩线：读的是**生效那份**（运行期真值），徽章说「立刻生效」而不是「需重启」', (tester) async {
    // 两份刻意给不同的值：盘上 100000（老现场值；`persona.` 属于 RESTART_REQUIRED_FIELDS，
    // 手改 config.json 不会当拍接管），生效那份 200000。这一行画出来的必须是**现在按什么跑**的数。
    config['persona'] = {'compactionThresholdTokens': 100000};
    liveConfig['persona'] = {'compactionThresholdTokens': 200000};
    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    expect(inSystemCard(find.text('上下文 · 压缩线（token 估算）')), findsOneWidget);
    expect(sysValue(tester, 'persona.compactionThresholdTokens'), '200000',
        reason: '压缩判定与 80% 预警读的都是生效那份，界面就得画它（画盘上那份是在说一个没生效的数）');

    // 旁注两句口径要在（单位 = 估算器读数 / 改完立刻生效）：旁注只在编辑态出现，所以先点开
    await tapInCard(tester, sysEdit('persona.compactionThresholdTokens'));
    expect(sysText(tester, 'persona.compactionThresholdTokens'), '200000',
        reason: '点开编辑态摆的是同一个值（读数与编辑态不许各写各的）');
    expect(inSystemCard(find.textContaining('估算器读数，不是供方计数')), findsOneWidget);
    expect(inSystemCard(find.textContaining('估算比供方偏低约 1.65~1.66 倍')), findsOneWidget,
        reason: '这一格不能让人误读成"供方 200k"');
    expect(inSystemCard(find.textContaining('改完立刻生效，不用重启')), findsOneWidget);
    // 文案规则（与心跳那一行同一条，用户 2026-10-05）：说明 = 一行要点，**不带 markdown 记号**
    // （界面 chrome 不做渲染）。旁注只在编辑态出现，所以这条检查必须在这里做——
    // 别的用例点开的是别一行，扫不到这一行的字。
    expect(inSystemCard(find.textContaining('**')), findsNothing, reason: '界面提示里不许再留 markdown 记号');

    // 这一行挂的是「立刻生效」：挂「需重启」会叫人去做一件不必做的事
    expect(inSystemCard(find.text('立刻生效')), findsOneWidget);
    await tapInCard(tester, sysCancelBtn('persona.compactionThresholdTokens'));
    await drain(tester);
  });

  testWidgets('压缩线：保存走 set-compaction-threshold（立刻生效那条路），越界的值当场拦下', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));
    await tapInCard(tester, inSystemCard(find.text('查看全部（12 行）')));

    // 越界三条：**一个字节都不写**（文案由 _SysField.problem 生成，与别的数值行同一套口径），
    // 并且拦下之后留在编辑态（人就在那个框上，改完再按一次就行）。
    //
    // ⚠ 这一组拦下来的**边界来自服务端**（`/api/config` 的 `bounds.compactionThreshold`，
    // 见上面那个假服务端），界面这一侧**没有**自己的常量（2026-10-11 收口删掉了
    // `kCompactionThresholdMin/Max`）——所以这几条断言同时钉住"边界真的从回执流到了框上"。
    Future<void> check(String bad, String message) async {
      await tapInCard(tester, sysEdit('persona.compactionThresholdTokens'));
      await tester.enterText(
          find.byKey(const ValueKey('sys-field-persona.compactionThresholdTokens')), bad);
      await tester.pump();
      await tapInCard(tester, sysSaveBtn('persona.compactionThresholdTokens'));
      await pumpUntil(tester, find.text(message));
      expect(postCount, 0, reason: 'compactionThresholdTokens = $bad 不该写进配置');
      expect(find.byKey(const ValueKey('sys-field-persona.compactionThresholdTokens')), findsOneWidget);
      await tapInCard(tester, sysCancelBtn('persona.compactionThresholdTokens'));
    }

    await check('9999', '上下文 · 压缩线（token 估算）最小是 10000，未保存');
    await check('2000001', '上下文 · 压缩线（token 估算）最大是 2000000，未保存');
    await check('200000.5', '上下文 · 压缩线（token 估算）要填整数，未保存');
    expect(postCount, 0);

    // 合法值：走它**自己的端点**（不是 config-update）。这一条是重点——
    // 通用那条只写盘、回执写死"要重启"，用它就等于让这一格说假话。
    await tapInCard(tester, sysEdit('persona.compactionThresholdTokens'));
    await tester.enterText(
        find.byKey(const ValueKey('sys-field-persona.compactionThresholdTokens')), '250000');
    await tester.pump();
    await tapInCard(tester, sysSaveBtn('persona.compactionThresholdTokens'));
    await pumpUntil(tester, find.text('已保存，立刻生效（不用重启）'));
    expect(postCount, 1);
    expect(lastPath, '/api/commands/set-compaction-threshold');
    expect(lastPost?['tokens'], 250000);
    expect(lastConfirm, isNull,
        reason: '它不改能力边界（与 set-group-scene 同级，短语为 null），界面不必多问一次');
    expect(find.text('已保存，重启后生效'), findsNothing, reason: '这一格不叫人重启');
    await drain(tester);
  });

  // ── 「记忆」卡：框架代管记忆的总开关（persona.memoryEnabled） ──

  testWidgets('记忆卡：开关读 persona.memoryEnabled，点一下走 config-update 写它', (tester) async {
    config['persona'] = {'memoryEnabled': false, 'contacts': <String, dynamic>{}};
    await pumpSettings(tester, size: const Size(1350, 3400));

    final toggle = find.byKey(const ValueKey('memory-enabled'));
    // 读：开关显示的是**盘上那份**的值，不是一个写死的默认（否则"关着却显示开着"没人能发现）
    expect(tester.widget<Switch>(toggle).value, isFalse, reason: '开关要显示配置里的值');

    // 关着时那行只读要说"她自己管"，与开着的说法分开——两种状态两句话
    expect(find.text('她自己管（框架不生成、不注入、不整理）'), findsOneWidget);

    // 写：点一下立刻提交（开关是二值项，没有"改到一半"的中间态）
    await tapInCard(tester, toggle);
    await pumpUntil(tester, find.text('已改为框架自动管记忆（重启后接管）'));
    expect(postCount, 1);
    expect(lastPost?['fields'], {'persona.memoryEnabled': true});
    expect(lastConfirm, 'config-update', reason: '写配置必须带 X-Confirm');
    await drain(tester);
  });

  testWidgets('记忆卡：关掉时那句代价必须在，且标明要重启才接管', (tester) async {
    // 服务端口径：这一条是启动参数，盘上改了、进程还没接管 → $pending 里报回来
    config['persona'] = {'memoryEnabled': false, 'contacts': <String, dynamic>{}};
    config[r'$pending'] = {
      'source': 'saved',
      'restartRequired': <String>['persona.memoryEnabled'],
    };
    await pumpSettings(tester, size: const Size(1350, 3400));

    final cost = find.text('代价：她可能忘记整理，facts.md 会一直长下去，索引也不再更新——这些都归她自己。');
    expect(cost, findsOneWidget, reason: '关掉是一句"什么都不会报错、代价过几天才显形"的选择，代价必须摆在旁边');
    expect(
      find.text('让框架自动管记忆（关掉 = 她只知道自己有这些文件，读、写、整理全归她）'),
      findsOneWidget,
      reason: '开关自己那句要说清后果，不是"启用记忆系统"四个字',
    );

    // 「需重启」按服务端算出来的结论显示，这一页不另算一份
    expect(find.text('尚未生效'), findsOneWidget);
    expect(tester.widget<Switch>(find.byKey(const ValueKey('memory-enabled'))).value, isFalse);
    await drain(tester);
  });

  testWidgets('记忆卡：开着时不摆那句代价（它是"关掉"这一种状态的话）', (tester) async {
    await pumpSettings(tester, size: const Size(1350, 3400));

    expect(tester.widget<Switch>(find.byKey(const ValueKey('memory-enabled'))).value, isTrue);
    expect(find.textContaining('代价：她可能忘记整理'), findsNothing);
    expect(find.text('框架自动管记忆（每轮注入索引、每日整理）'), findsOneWidget);
    // 开关**不能**顶替锚点：这一页的分区名与卡头同名，两处都在
    expect(find.text('记忆'), findsNWidgets(2));
    await drain(tester);
  });

  // ── 信任范围卡（`trust.mode`：完全信任 / 只限工作目录） ──

  /// 信任卡里的两行（[TrustModeChoice] 的 key 是 `trust-mode-<档>`）
  Finder trustRow(String mode) => find.byKey(ValueKey('trust-mode-$mode'));

  /// 这一行现在是不是选中的那一档。
  ///
  /// 选中态由三处冗余提示之一读出来（这里是描边宽度，见 [TrustModeChoice]）：
  /// 不按"点一下之后页面自己记了什么"判断，而是按**屏上真的画出来的**那一份判断
  /// ——那正是这个断言要锁的东西（"默认高亮完全信任"）。
  bool trustRowSelected(WidgetTester tester, String mode) {
    final box = tester.widget<Container>(
      find.descendant(of: trustRow(mode), matching: find.byType(Container)).first,
    );
    final border = (box.decoration as BoxDecoration).border as Border;
    return border.top.width > 1;
  }

  testWidgets('信任范围卡：读到盘上那档并说清后果，点「完全信任」改回默认那档要走确认', (tester) async {
    config['trust'] = {'mode': 'workspace', 'workspaceRoot': r'C:\path\to\workspace'};
    await pumpSettings(tester, size: const Size(1350, 3600));

    // 锚点（左栏）与卡头同名：一处锚点 + 一处卡头
    expect(find.text('信任范围'), findsNWidgets(2));

    // ① **读到盘上那份**：受管那一档是当前选中，另一档没选中
    expect(trustRow('workspace'), findsOneWidget);
    expect(trustRow('full'), findsOneWidget);
    expect(trustRowSelected(tester, 'workspace'), isTrue, reason: '选中态要跟着盘上那份走，不是写死');
    expect(trustRowSelected(tester, 'full'), isFalse);

    // ② 两种选择的后果各一句，且「只限工作目录」那句要把 workspaceRoot 念出来
    expect(find.text('她能读写整台电脑上的文件、也能在任意目录跑命令。'), findsOneWidget);
    expect(find.text(r'她只能在 C:\path\to\workspace 里活动；越界的读写与命令会被拒绝。'), findsOneWidget);
    // 只读的「当前生效」行说清现在按哪一档跑
    expect(find.text(r'只限工作目录 · C:\path\to\workspace'), findsOneWidget);
    // 这一条的定性要在卡上（它是边界，不是提醒）——按文案规则（用户 2026-10-05）
    // 长解释收进了「详情」折叠：所以先断言折叠在，再展开断言那句话在。
    // 展开点按**这一条自己那枚**折叠头找（设置页上「详情」不止一处，所以按 key）。
    expect(find.text('它是边界，不是提醒：越界的读写与命令一律被拒绝。'), findsOneWidget);
    await tapInCard(
      tester,
      find.descendant(
        of: find.byKey(const ValueKey('trust-rules-fold')),
        matching: find.textContaining('详情'),
      ),
    );
    expect(find.textContaining('它管 fs 工具族'), findsOneWidget,
        reason: '折叠里要有那道边界的完整口径');

    // ③ 点「完全信任」= 放宽边界：先出确认框，取消就一个请求都不发
    await tapInCard(tester, trustRow('full'));
    await tester.pump(const Duration(milliseconds: 200));
    await pumpUntil(tester, find.widgetWithText(FilledButton, '改成完全信任'));
    expect(
      find.textContaining('她能读写整台电脑上的文件、也能在任意目录跑命令。'),
      findsNWidgets(2),
      reason: '确认框里写的是那句后果，不是"确定吗"（卡上那句 + 框里那句）',
    );
    await tester.tap(find.text('取消'));
    await tester.pump(const Duration(milliseconds: 200));
    expect(postCount, 0, reason: '取消不该发出写请求');

    // ④ 确认才写：走既有的 config-update 通道，带 X-Confirm；写的是一个字段
    await tapInCard(tester, trustRow('full'));
    await pumpUntil(tester, find.widgetWithText(FilledButton, '改成完全信任'));
    await tester.tap(find.widgetWithText(FilledButton, '改成完全信任'));
    await pumpUntil(tester, find.textContaining('已改为完全信任'));
    expect(postCount, 1);
    expect(lastPost?['fields'], {'trust.mode': 'full'});
    // 字段短语：改 `trust.mode` 时 `X-Confirm` 必须**同时**含命令短语与 `trust-full-access`。
    // 服务端 `DANGEROUS_FIELDS`（src/web/server.ts）对这一个字段两个方向都要——
    // 少了它，界面点"改成完全信任"会吃 400 confirm-required（配对改动只落一半的老事故）。
    expect(lastConfirm, kTrustConfirm, reason: '改信任范围要带字段短语 trust-full-access');
    expect(lastConfirm, contains('config-update'), reason: '命令短语也得在');
    expect(lastConfirm, contains('trust-full-access'), reason: '字段短语也得在');
    await drain(tester);
  });

  testWidgets('信任范围卡：默认完全信任、切到工作目录时后果文案在，并显示服务端算出的「需重启」', (tester) async {
    // 起点 = 配置默认值（`trust.mode` 就是 full；workspaceRoot 由服务端算出来）
    config['trust'] = {'mode': 'full', 'workspaceRoot': r'C:\path\to\config\workspace'};
    await pumpSettings(tester, size: const Size(1350, 3600));

    // ① 默认档：完全信任是选中的那一档
    expect(trustRowSelected(tester, 'full'), isTrue, reason: '默认高亮「完全信任」（与配置默认值一致）');
    expect(trustRowSelected(tester, 'workspace'), isFalse);
    expect(find.text('完全信任（整台电脑）'), findsOneWidget);
    // 还没改过任何东西：此刻没有"需重启"要喊（喊多了这句话就不值钱了）
    expect(find.text('尚未生效'), findsNothing);

    // ② 与盘上那份一致时点一下**什么都不写**：不该凭空多出一条"改了还没重启"
    await tapInCard(tester, trustRow('full'));
    await drain(tester);
    expect(postCount, 0, reason: '点已经选中的那一档不该写盘');
    expect(find.text('尚未生效'), findsNothing);

    // ③ 切到「只限工作目录」：这一档不拦（收窄边界是安全方向），直接写
    await tapInCard(tester, trustRow('workspace'));
    await pumpUntil(tester, find.textContaining('已改为只限工作目录'));
    expect(postCount, 1);
    expect(lastPost?['fields'], {'trust.mode': 'workspace'});
    // **收紧也要带**：服务端刻意不做方向区分（只给放宽加门就得先读盘上现值判方向，
    // 那是同一件事的第二处判据）。所以"只限工作目录"这一档同样要带字段短语。
    expect(lastConfirm, kTrustConfirm, reason: '收紧那一档同样要带 trust-full-access');
    await drain(tester);
  });

  testWidgets('信任范围卡：盘上那份与生效那份不同时，照服务端的结论显示「需重启」', (tester) async {
    // 服务端口径：`$pending.restartRequired` 是"盘上那份 vs 本进程启动时那份"的逐字段差异。
    // `trust.mode` 属 `trust.` 前缀，不在 watcher.ts 的 HOT_RELOAD_FIELDS 里
    // （那份名单是空的：全部字段都要重启），所以盘上改过的这一档会被报回来。
    config['trust'] = {'mode': 'workspace', 'workspaceRoot': r'C:\path\to\config\workspace'};
    config[r'$pending'] = {
      'source': 'saved',
      'restartRequired': <String>['trust.mode'],
    };
    await pumpSettings(tester, size: const Size(1350, 3600));

    // 界面只显示服务端算出来的结论：徽章是「尚未生效」（= 盘上与生效**真的**不同），
    // 而不是笼统的「需重启」（那只是"这类字段改完要重启"的常态说明）
    expect(find.text('尚未生效'), findsOneWidget);
    expect(find.textContaining('上面选的那一档还没生效'), findsOneWidget);
    expect(find.textContaining('重启后接管'), findsWidgets);
    // 那一档本身照旧摆在卡上（选中的仍是盘上那份：将来跑的就是它）
    expect(trustRowSelected(tester, 'workspace'), isTrue);
    expect(find.text(r'她只能在 C:\path\to\config\workspace 里活动；越界的读写与命令会被拒绝。'),
        findsOneWidget);
    await drain(tester);
  });
}
