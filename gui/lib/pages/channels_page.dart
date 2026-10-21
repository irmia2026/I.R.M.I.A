// 本页文案**已经全部**落在 lib/i18n/app_strings.dart（`chan*` 那一族）：页面里不再有中文
// 字面量，`gui/test/copy_coverage_test.dart` 的闸门盯着这件事。加一句话 = 往文案表加一条
// （中英各一处），页面里只许 `IrmiaStrings.of(context).xxx`。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
import 'dart:async';

import 'package:flutter/material.dart';

import '../api.dart';
import '../app.dart';
// QQ 官方 Bot 两把凭据的键名（与首次引导第 3 步同一份，见 channel_keys.dart）
import '../channel_keys.dart';
import '../i18n/app_strings.dart';
import '../i18n/strings_scope.dart';
import '../theme.dart';
import '../ui_kit.dart';
import 'page_chrome.dart';

// 消息适配器页 —— 与 Web 端 web/pages/channels.js 同构，版式对标 AstrBot `PlatformPage.vue:82-167`：
// 左侧 260px 渠道列表 + 右侧详情工作台；窄窗（<900px）降级为「列表 ↔ 详情」单独视图。
// 连接状态由「生效配置 + 事件日志」实测：未启用 / 已启用（零事件）/ 在跑，不做臆造。
//
// 配置就地改（与 Web 端同一形态，AstrBot 的平台页也是就地配）：通道开关与端点参数都写在
// 本页的「通道配置」卡里，不走「先跳设置页再找」的弯路。写通道只有一条：
//   POST /api/commands/config-update {fields}（X-Confirm: config-update）
// 改动只进草稿（draft: 路径 → 待写值），点保存才提交草稿里的字段——和 Web 端 S.draft 同构，
// 因此「未改动即禁用」是草稿为空的直接推论，不需要另算一份脏状态。
// 写进 config.json 的字段要进程重启才接管，UI 照实标「需重启」，不假装即时生效。
class ChannelsPage extends StatefulWidget {
  const ChannelsPage({super.key, required this.state});

  final AppState state;

  @override
  State<ChannelsPage> createState() => _ChannelsPageState();
}

/// 只拉通道/入站 webhook/文件/回投/告警五类事件的最近 50 条：
/// types 过滤是 /api/events 的原生能力（listEvents 的 filters.types），旧服务端不认时退回全量段。
const _eventTypes = 'wake/channel,wake/webhook,wake/file,speak/sent,alarm/sent';
final _eventsQuery = Uri(path: '/api/events', queryParameters: const {'types': _eventTypes, 'limit': '50'}).toString();
const _fallbackEventsQuery = '/api/events?limit=50';

/// 列表宽度与窄窗阈值（AstrBot PlatformPage 的 bot-list 侧栏同宽）
const _sidebarWidth = 260.0;
const _wideBreakpoint = 900.0;

/// Webhook 与文件监听这一项不是单一通道：活动由三类事件合看
const _hookChannelId = 'webhook-file';
const _qqChannelId = 'qq-official';
const _hookEventTypes = {'wake/webhook', 'wake/file', 'alarm/sent'};

/// 渠道 id → 名字（`qq-official` 那条跟着语言走；`OneBot 11` 是专有名词，不译）
String _sourceOf(AppStrings s, String channel) => switch (channel) {
      'qq-official' => s.chanSourceQqOfficial,
      'onebot' => 'OneBot 11',
      _ => channel.isEmpty ? s.chanSourceExternal : channel,
    };

/// 会话类型 → 名字（`c2c` 这些 id 是判据、永不翻译）
String _chatTypeLabel(AppStrings s, String type) => switch (type) {
      'c2c' => s.chatTypeDirect,
      'group-at' => s.overviewChatTypeGroupAt,
      'group' => s.chatTypeGroup,
      'guild' => s.overviewChatTypeGuild,
      _ => '',
    };

/// 事件类型 → 名字（Webhook 与文件监听那张卡的三个触发源）
String _eventTagLabel(AppStrings s, Object? type) => switch (type) {
      'wake/webhook' => s.chanEventInboundWake,
      'wake/file' => s.chanEventFile,
      'alarm/sent' => s.chanAlertExit,
      _ => s.chanEventGeneric,
    };

/// 实测状态（kind 给 BreathDot，tone 给状态标签上色）/ 只读参数行 / 参数定义 / 渠道定义
/// custom 为 null 时按 path 的配置点路径取值
typedef _Status = ({String kind, String tone, String label, String note});
typedef _Row = ({String label, String path, String? value});
typedef _Spec = ({String label, String path, String? Function(_ChannelsPageState state)? custom});

/// 就地可改的字段：kind 决定控件与提交值类型（`number` 提交数字，其余提交字符串）
typedef _Field = ({String label, String path, String kind, String? hint});

/// 密钥字段：值**只写不读**（写入落本机 data/.keys.json，读只拿掩码），因此不进 config 那套脏判定。
/// 只给标签与一句用途，不摆环境变量名——这是桌面本地场景，没人需要那套容器侧的抽象。
typedef _SecretField = ({String label, String keyName, String hint});

typedef _ChannelDef = ({
  String id,
  String title,
  IconData icon,
  /// 状态判定用的配置点：两个通道看 enabled，webhook 项看出口地址
  String enabledPath,
  /// 可切换的布尔配置点；webhook 项为 null（它的「开」就是填上出口地址）
  String? switchPath,
  String channel,
  String hint,
  String blurb,
  /// 就地可改的字段；保存时只提交与生效值不同的项
  List<_Field> fields,
  /// 只读补充项：由其它字段推导出的组合值，或路径列表这类不适合单值文本框的东西
  List<_Spec> specs,
  /// 密钥字段（值写进本机密钥文件，不进 config.json）
  List<_SecretField> secrets,
});

/// QQ 官方通道的两把密钥：开放平台管理端给的 AppID 与 AppSecret。
/// 界面上直接填**值**（写进本机 data/.keys.json），不填变量名。
///
/// 键名取 `channel_keys.dart` 那份（与首次引导第 3 步**同一对**）：两处填的是同一把凭据，
/// 各写一遍键名就会漂成"这边写进去、那边读不到"。
List<_SecretField> _qqSecrets(AppStrings s) => <_SecretField>[
  (label: 'AppID', keyName: kQqAppIdKey, hint: s.chanQqAppIdHint),
  (label: 'AppSecret', keyName: kQqAppSecretKey, hint: s.chanQqAppSecretHint),
];
List<_SecretField> _onebotSecrets(AppStrings s) => <_SecretField>[
  (label: 'access_token', keyName: 'onebotToken', hint: s.chanOneBotTokenHint),
];

/// 字段定义与 src/config/config.ts 的解析规则对齐：`pickHttpUrlOptional` 只收 http(s)、
/// `pickGatewayUrlOptional` / `pickOneBotWsUrl` 只收 ws(s)。
///
/// 这里**没有** appIdEnv / clientSecretEnv：那两个是「环境变量叫什么」，属于高级配置——
/// 界面上填的是值（见 _qqSecrets 的密钥行），变量名以只读形态显示在密钥行里，
/// 要用环境变量的高级用户直接改 config.json。
List<_Field> _qqFields(AppStrings s) => <_Field>[
  (label: s.chanQqApiBaseLabel, path: 'channels.qqOfficial.apiBase', kind: 'text', hint: s.chanQqUrlHint),
  (label: s.chanQqTokenUrlLabel, path: 'channels.qqOfficial.tokenUrl', kind: 'text', hint: s.chanQqUrlHint),
  (label: s.chanQqGatewayUrlLabel, path: 'channels.qqOfficial.gatewayUrl', kind: 'text', hint: s.chanQqGatewayHint),
];
List<_Field> _onebotFields(AppStrings s) => <_Field>[
  (label: s.chanOneBotWsLabel, path: 'channels.onebot.wsUrl', kind: 'text', hint: s.chanOneBotWsHint),
];
List<_Field> _hookFields(AppStrings s) => <_Field>[
  (label: s.chanAlertWebhookLabel, path: 'alerts.webhookUrl', kind: 'text', hint: s.chanAlertWebhookHint),
  (label: s.chanAlertRateLabel, path: 'alerts.rateLimitMin', kind: 'number', hint: s.chanAlertRateHint),
];

List<_Spec> _onebotSpecs(AppStrings s) => <_Spec>[
  (label: s.chanEndpointLabel, path: 'channels.onebot.wsUrl · port', custom: _endpointOf),
];
List<_Spec> _hookSpecs(AppStrings s) => <_Spec>[
  (label: s.chanListenLabel, path: 'web.host · web.port', custom: _listenOf),
];

/// 左列表三项：定义来自客户端（等于 config 结构本身），因此配置读不到时列表照常可点，
/// 只是状态点显示「状态未知」——不臆造运行时事实。
List<_ChannelDef> _channels(AppStrings s) => <_ChannelDef>[
  (
    id: 'qq-official',
    title: s.chanQqTitle,
    icon: Icons.forum_outlined,
    enabledPath: 'channels.qqOfficial.enabled',
    switchPath: 'channels.qqOfficial.enabled',
    channel: 'qq-official',
    hint: s.chanQqHint,
    blurb: 'AppID + AppSecret',
    fields: _qqFields(s),
    specs: const [],
    secrets: _qqSecrets(s),
  ),
  (
    id: 'onebot',
    title: 'OneBot 11',
    icon: Icons.hub_outlined,
    enabledPath: 'channels.onebot.enabled',
    switchPath: 'channels.onebot.enabled',
    channel: 'onebot',
    hint: s.chanOneBotHint,
    blurb: s.chanOneBotBlurb,
    fields: _onebotFields(s),
    specs: _onebotSpecs(s),
    secrets: _onebotSecrets(s),
  ),
  (
    id: _hookChannelId,
    title: s.chanHookTitle,
    icon: Icons.webhook_outlined,
    enabledPath: 'alerts.webhookUrl',
    switchPath: null,
    channel: _hookChannelId,
    hint: s.chanHookHint,
    blurb: s.chanHookBlurb,
    fields: _hookFields(s),
    specs: _hookSpecs(s),
    secrets: const [],
  ),
];

class _ChannelsPageState extends State<ChannelsPage> {
  Map<String, dynamic>? cfg;
  String? cfgError;
  List<Map<String, dynamic>> events = const [];
  String? evError;
  bool firstLoad = true;
  bool refreshing = false;
  Timer? _poll;

  /// 选中的渠道 id：三项在客户端定义，首项恒有效
  String selectedId = _qqChannelId;

  /// 窄窗视图位：false = 列表，true = 详情（宽窗两栏并排，这个位不参与）
  bool narrowDetail = false;

  /// 密钥状态（GET /api/keys）：只有 {configured, mask}，完整值不经过本页
  Map<String, dynamic>? keys;
  String? keysError;

  /// 密钥输入框：值只写不读，提交后立刻清空（掩码以服务端为准）
  final Map<String, TextEditingController> _secretCtls = {};

  /// 会话联系人（GET /api/sessions）：她拿到的是一串 openid（QQ 不给昵称），
  /// 所以得由人在这里告诉系统"那个会话是谁"。
  List<Map<String, dynamic>> sessions = const [];
  final Map<String, TextEditingController> _contactCtls = {};
  /// 群成员档案（GET /api/sessions 的 `groupMembers`）：键是群 sid，值是那个群里见过的人。
  /// 与联系人表分开：那是"会话"的名字（键是 sid），这是"群里的人"（键是 openid）——
  /// 群成员没私聊过她，压根没有 sid。
  Map<String, List<Map<String, dynamic>>> _groupMembers = {};
  /// 群成员名字的输入框（键是 openid；同样不重建，免得光标丢）
  final Map<String, TextEditingController> _memberCtls = {};
  /// 哪些群会话是展开的（默认收起：群里人多，全摊开会把卡片撑得很长）
  final Set<String> _expandedGroups = {};
  /// 正在改名的那个成员（openid）：只让一行变成输入框，其余保持列表形态（省空间）
  String? _editingMember;
  /// 预警豁免：单聊按会话（sid），群里按人（群 sid → openid 集合）。
  /// 默认两边都是空的 = **全都预警**（安全的那一侧）；群聊没有"整群豁免"这一档。
  /// 群聊场景开关（软提醒 = false / 硬拒绝 = true）。**立刻生效**：动作里同临界区改了内存那份。
  bool _groupSceneHardRefusal = false;
  final Set<String> _exemptSessions = {};
  final Map<String, Set<String>> _exemptMembers = {};

  // ── 就地配置的输入态（控制器与快照都属于本页，不写进全局状态） ──

  /// 字段控制器：path → 控制器。复用同一实例是刻意的——重建时换新控制器会丢光标位置。
  final Map<String, TextEditingController> _ctls = {};

  /// 生效配置里各字段的原始串：脏 = 控制器内容与它不同，因此改回原值会自动回干净
  final Map<String, String> _saved = {};

  /// 开关草稿：path → 待写布尔值；没有条目即未改动
  final Map<String, bool> _switchDraft = {};

  bool saving = false;

  /// 「测试告警出口」正在飞（那颗按钮只在 Webhook 那一项的配置卡上，见 [_testAlertExit]）
  bool alertTesting = false;

  /// 配置卡锚点：行尾齿轮、引导条与状态卡的动作都滚到这里
  final _configKey = GlobalKey();

  /// 配置卡被「配置」动作唤醒时闪一下描边：卡片本来就在视口里时，也该看得出按钮确实生效
  bool _configPulse = false;
  Timer? _pulse;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChange);
    unawaited(load());
    // 事件 15s 一跳（与 Web 端同频）；配置只在进页与下拉刷新时重读，免得卡片闪
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => unawaited(_loadEvents()));
  }

  @override
  void dispose() {
    _poll?.cancel();
    _pulse?.cancel();
    widget.state.removeListener(_onStateChange);
    for (final ctl in _ctls.values) {
      ctl.removeListener(_onFormChanged);
      ctl.dispose();
    }
    for (final ctl in _secretCtls.values) {
      ctl.removeListener(_onFormChanged);
      ctl.dispose();
    }
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && cfgError != null) unawaited(load());
  }

  Future<void> load() async {
    if (mounted) setState(() => refreshing = true);
    await Future.wait([_loadConfig(), _loadEvents(), _loadKeys(), _loadSessions()]);
    if (mounted) setState(() { firstLoad = false; refreshing = false; });
  }

  /// 会话联系人（她见过的会话 + 现在给它们起的名字）。
  /// 读不到就留空——这块不承担报错职责，主流程照走。
  Future<void> _loadSessions() async {
    try {
      final data = await widget.state.api.get('/api/sessions');
      final list = data is Map ? data['sessions'] : null;
      if (!mounted) return;
      final next = list is List
          ? list.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList()
          : const <Map<String, dynamic>>[];
      final rawExempt = data is Map ? data['warnExempt'] : null;
      final exemptSessions = <String>{};
      final exemptMembers = <String, Set<String>>{};
      if (rawExempt is Map) {
        final sids = rawExempt['sessions'];
        if (sids is List) {
          for (final s in sids) {
            if (s is String && s.isNotEmpty) exemptSessions.add(s);
          }
        }
        final memberMap = rawExempt['members'];
        if (memberMap is Map) {
          for (final entry in memberMap.entries) {
            final list = entry.value;
            if (list is! List) continue;
            exemptMembers['${entry.key}'] = list
                .whereType<String>()
                .where((x) => x.isNotEmpty)
                .toSet();
          }
        }
      }
      final rawMembers = data is Map ? data['groupMembers'] : null;
      final sceneHard = data is Map && data['groupSceneHardRefusal'] == true;
      final members = <String, List<Map<String, dynamic>>>{};
      if (rawMembers is Map) {
        for (final entry in rawMembers.entries) {
          final list = entry.value;
          if (list is! List) continue;
          members['${entry.key}'] = list
              .whereType<Map>()
              .map((e) => e.cast<String, dynamic>())
              .toList();
        }
      }
      setState(() {
        sessions = next;
        _groupMembers = members;
        _groupSceneHardRefusal = sceneHard;
        _exemptSessions
          ..clear()
          ..addAll(exemptSessions);
        _exemptMembers
          ..clear()
          ..addAll(exemptMembers);
        // 已存在的输入框保留（不重建控制器，光标与未保存的输入不会丢）
        for (final sess in next) {
          final sid = '${sess['sid']}';
          if (!_contactCtls.containsKey(sid)) {
            _contactCtls[sid] = TextEditingController(text: '${sess['name'] ?? ''}');
          }
        }
      });
    } catch (_) {
      // 忽略：会话列表是附加信息
    }
  }

  /// 读生效配置。`seed` 为真时把生效值回填进输入框并丢弃草稿——首次加载、下拉刷新与
  /// 保存成功后各一次；这三个时机用户的预期都是「按服务端的值重来」。
  Future<void> _loadConfig({bool seed = true}) async {
    final s = IrmiaStrings.read(context);
    try {
      final data = await widget.state.api.get('/api/config');
      if (!mounted) return;
      final next = data is Map<String, dynamic> ? data : null;
      setState(() {
        cfg = next;
        cfgError = next == null ? s.chanConfigReadFailed : null;
      });
      if (seed && next != null) _seedInputs();
    } catch (err) {
      if (mounted) setState(() => cfgError = err.toString());
    }
  }

  Future<void> _loadEvents() async {
    try {
      dynamic data;
      try {
        data = await widget.state.api.get(_eventsQuery);
      } on ApiError {
        data = await widget.state.api.get(_fallbackEventsQuery);
      }
      final list = data is Map ? data['events'] : (data is List ? data : null);
      if (mounted) setState(() { events = list is List ? list.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const []; evError = null; });
    } catch (err) {
      if (mounted) setState(() => evError = err.toString());
    }
  }

  // ── 就地配置：控制器、脏判定与保存 ──

  TextEditingController _ctl(String path) {
    return _ctls.putIfAbsent(path, () {
      final ctl = TextEditingController();
      ctl.addListener(_onFormChanged);
      return ctl;
    });
  }

  /// 输入框每敲一个字符都会走这里：只驱动重建，不做去抖（脏判定是纯比较，没有开销）
  void _onFormChanged() {
    if (mounted) setState(() {});
  }

  // ── 密钥：值写进本机密钥文件，界面只看得见掩码 ──

  TextEditingController _secretCtl(String keyName) {
    return _secretCtls.putIfAbsent(keyName, () {
      final ctl = TextEditingController();
      ctl.addListener(_onFormChanged);
      return ctl;
    });
  }

  /// 密钥状态（GET /api/keys）：掩码以服务端为准，本页不自己算一份
  Future<void> _loadKeys() async {
    final s = IrmiaStrings.read(context);
    try {
      final data = await widget.state.api.get('/api/keys');
      if (!mounted) return;
      setState(() {
        keys = data is Map ? data.cast<String, dynamic>() : null;
        keysError = data is Map ? null : s.chanKeysReadFailed;
      });
    } catch (err) {
      if (mounted) setState(() => keysError = '$err');
    }
  }

  ({bool configured, String? mask}) _keyState(String keyName) {
    final raw = keys?[keyName];
    if (raw is! Map) return (configured: false, mask: null);
    final mask = raw['mask'];
    return (configured: raw['configured'] == true, mask: mask is String ? mask : null);
  }

  /// 待写入的密钥：输入框非空即待保存（密钥只写不读，没有"改回原值"这回事）
  Map<String, String> _pendingSecrets(_ChannelDef def) {
    final out = <String, String>{};
    for (final secret in def.secrets) {
      final value = _secretCtl(secret.keyName).text.trim();
      if (value.isNotEmpty) out[secret.keyName] = value;
    }
    return out;
  }

  /// 清除某个密钥：同一个 set-key 通道，空值 = 删除该键
  Future<void> _clearSecret(_SecretField field) async {
    final s = IrmiaStrings.read(context);
    final confirmed = await confirm(
      context,
      title: s.chanClearSecretTitle(field.label),
      body: s.chanClearSecretBody,
      confirmLabel: s.settingsClear,
      danger: true,
    );
    if (!confirmed || !mounted) return;
    setState(() => saving = true);
    try {
      await widget.state.api
          .post('/api/commands/set-key', {'name': field.keyName, 'value': ''}, confirm: 'set-key');
      if (!mounted) return;
      _toast(s.settingsKeyCleared, kind: ToastKind.success);
      await _loadKeys();
    } catch (err) {
      if (mounted) _toast(s.chanClearFailed(_clip('$err', 80)), kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  /// 用生效配置回填输入框与开关快照；丢弃未保存的草稿
  void _seedInputs() {
    final s = IrmiaStrings.read(context);
    for (final def in _channels(s)) {
      for (final field in def.fields) {
        final text = _text(field.path) ?? '';
        _saved[field.path] = text;
        final ctl = _ctl(field.path);
        // 值相同就不赋：赋值会把光标挪到末尾，刷新时不该动正在编辑的输入框
        if (ctl.text != text) ctl.text = text;
      }
      final path = def.switchPath;
      if (path != null) _switchDraft.remove(path);
      // 密钥框清空：值为只写不读，重读后本来就该是空的（掩码由 keys 状态单独给）
      for (final secret in def.secrets) {
        final ctl = _secretCtl(secret.keyName);
        if (ctl.text.isNotEmpty) ctl.clear();
      }
    }
  }

  /// 开关当前值：草稿优先，否则取生效配置
  bool _switchOf(_ChannelDef def) {
    final path = def.switchPath;
    if (path == null) return false;
    return _switchDraft[path] ?? (_at(cfg, path) == true);
  }

  /// 数字字段的非法值（返回字段名）；服务端也会拦，但格式问题在这里当场说更省一次往返。
  /// 空值不算非法：清空 = 回到默认值。
  String? _invalidNumber(_ChannelDef def) {
    for (final field in def.fields) {
      if (field.kind != 'number') continue;
      final text = _ctl(field.path).text.trim();
      if (text.isEmpty) continue;
      if (text != (_saved[field.path] ?? '') && num.tryParse(text) == null) return field.label;
    }
    return null;
  }

  /// 待提交的字段：只含与生效配置不同的项（改回原值即不算改动）。
  ///
  /// 清空一律提交 `null`，不提交空串：配置解析器把 `null` 当「用默认值」，而空串在
  /// `pickNonEmptyString` 那里是硬错误（`channels.*` 与 `alerts.webhookUrl` 都会因此被拒并回滚）。
  Map<String, dynamic> _dirtyFields(_ChannelDef def) {
    final out = <String, dynamic>{};
    if (cfg == null) return out;
    for (final field in def.fields) {
      final text = _ctl(field.path).text.trim();
      if (text == (_saved[field.path] ?? '')) continue;
      if (text.isEmpty) {
        out[field.path] = null; // 回到默认值
      } else if (field.kind == 'number') {
        final value = num.tryParse(text);
        if (value == null) continue; // 非法数字不进 fields：保存前另有拦截
        out[field.path] = value;
      } else {
        out[field.path] = text;
      }
    }
    final path = def.switchPath;
    if (path != null && _switchDraft.containsKey(path)) out[path] = _switchDraft[path];
    return out;
  }

  /// 有无待保存内容：填了非法数字也算（否则按钮禁用，用户卡在那儿无路可走）；密钥框非空也算
  bool _dirty(_ChannelDef def) =>
      _invalidNumber(def) != null || _dirtyFields(def).isNotEmpty || _pendingSecrets(def).isNotEmpty;

  Future<void> _save(_ChannelDef def) async {
    final s = IrmiaStrings.read(context);
    final invalid = _invalidNumber(def);
    if (invalid != null) {
      _toast(s.chanNotANumber(invalid), kind: ToastKind.warn);
      return;
    }
    final fields = _dirtyFields(def);
    final secrets = _pendingSecrets(def);
    if (fields.isEmpty && secrets.isEmpty) {
      _toast(s.chanNothingToSave);
      return;
    }
    setState(() => saving = true);
    final written = <String>[];
    try {
      if (fields.isNotEmpty) {
        await widget.state.api
            .post('/api/commands/config-update', {'fields': fields}, confirm: 'config-update');
        written.add(s.chanSavedFieldCount(fields.length));
      }
      // 密钥逐条写：一条失败不影响其余已写入的（界面按服务端返回的掩码重画状态）
      for (final entry in secrets.entries) {
        await widget.state.api
            .post('/api/commands/set-key', {'name': entry.key, 'value': entry.value}, confirm: 'set-key');
      }
      if (secrets.isNotEmpty) written.add(s.chanSavedSecretCount(secrets.length));
      if (!mounted) return;
      for (final secret in def.secrets) {
        _secretCtl(secret.keyName).clear();
      }
      if (fields.isNotEmpty) await _loadConfig(); // 生效值即新值：草稿随之回干净
      if (secrets.isNotEmpty) await _loadKeys();
      if (!mounted) return;
      // 参数要重启接管；密钥写盘即刻可用（下次建连时读），不跟着喊重启
      final restart = fields.isNotEmpty ? s.chanSavedRestartSuffix : s.chanSavedLiveSuffix;
      _toast(s.chanSaved(written.join(s.settingsListAnd), restart), kind: ToastKind.success);
    } catch (err) {
      // 服务端写盘后会跑一次配置校验，失败即回滚原文件并说明原因：原样转达，不自己编一句
      if (mounted) _toast(s.settingsSaveFailed(_clip('$err', 80)), kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  /// 重新加载 = 丢弃未保存的改动，按生效配置重来（按钮 tooltip 是这么写的）
  Future<void> _reload() async {
    final s = IrmiaStrings.read(context);
    await load();
    if (mounted) _toast(s.chanReloaded);
  }

  /// 给 `alerts.webhookUrl` 发一条**真测试消息**（`POST /api/commands/webhook-test`）。
  ///
  /// 为什么摆在这一项（Webhook 与文件监听）的配置卡上、而不是别处：出口地址就是这个卡片里
  /// 那格「告警出口 webhook」，**改了地址不知道通不通**正是这颗按钮要答的问题。
  /// 服务端走的是与真告警**同一条** notifier 路（`notifier.alert({category:'webhook-test'})`），
  /// 所以"测通了"就等于"真告警也送得出去"。
  ///
  /// 两个**不许说错话**的地方：
  ///   · 它只认**生效配置**里的出口：请求里带 `url` 也必须与生效值一致，服务端直接 400。
  ///     所以刚改完地址还没保存时点它会得到一句"请先保存再测"——那是事实，不是故障，照原样转达。
  ///   · **送达失败也回 HTTP 200**（`{ok:false, reason}`）：不能只看"有没有抛错"，
  ///     否则出口不通会被说成"测好了"。判据只认回包里的 `sent`/`ok`。
  Future<void> _testAlertExit() async {
    final s = IrmiaStrings.read(context);
    if (alertTesting) return;
    setState(() => alertTesting = true);
    try {
      final reply = await widget.state.api.post('/api/commands/webhook-test', const <String, dynamic>{});
      if (!mounted) return;
      final map = reply is Map ? reply.cast<String, dynamic>() : const <String, dynamic>{};
      final url = map['url']?.toString() ?? '';
      if (map['sent'] == true || map['ok'] == true) {
        _toast(s.chanTestDelivered(url), kind: ToastKind.success);
      } else {
        final reason = map['reason']?.toString() ?? '';
        _toast(s.chanTestNotDelivered(reason), kind: ToastKind.error);
      }
    } catch (err) {
      if (mounted) _toast(s.chanTestFailed(_clip('$err', 90)), kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => alertTesting = false);
    }
  }

  /// 行尾齿轮、引导条与状态卡的「配置」都落到配置卡：先选中该渠道，再滚过去并闪一下描边
  void _openConfig(String id) {
    setState(() {
      selectedId = id;
      narrowDetail = true;
      _configPulse = true;
    });
    _pulse?.cancel();
    _pulse = Timer(const Duration(milliseconds: 900), () {
      if (mounted) setState(() => _configPulse = false);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = _configKey.currentContext;
      if (target == null) return;
      unawaited(Scrollable.ensureVisible(
        target,
        duration: IrmiaTheme.durCard,
        curve: Curves.easeOutCubic,
        alignment: 0.02,
      ));
    });
  }

  void _toast(String text, {ToastKind kind = ToastKind.info}) {
    if (!mounted) return;
    IrmiaToast.show(context, text, kind: kind);
  }

  // ── 选中与视图位 ──

  _ChannelDef _defOf(AppStrings s, String id) =>
      _channels(s).firstWhere((def) => def.id == id, orElse: () => _channels(s).first);

  /// 点行体 = 选中；窄窗同时切到详情视图（宽窗右侧原地换内容）
  void _select(String id) => setState(() { selectedId = id; narrowDetail = true; });

  // ── 状态实测 ──

  Map<String, dynamic>? _lastOfType(String type) {
    Map<String, dynamic>? hit;
    for (final ev in events) {
      if (ev['type'] != type) continue;
      if (hit == null || _newer(ev, hit)) hit = ev;
    }
    return hit;
  }

  /// 通道最近一条事件：wake/channel 与 speak/sent 都按 data.channel 归类（与 Web 端同口径）
  Map<String, dynamic>? _channelLast(String channel) {
    Map<String, dynamic>? hit;
    for (final ev in events) {
      final data = ev['data'];
      if (data is! Map || data['channel'] != channel) continue;
      if (hit == null || _newer(ev, hit)) hit = ev;
    }
    return hit;
  }

  /// ISO 8601 同格式，字符串比较即时间序
  static bool _newer(Map<String, dynamic> a, Map<String, dynamic> b) =>
      (a['ts']?.toString() ?? '').compareTo(b['ts']?.toString() ?? '') > 0;

  String? _text(String path) {
    final value = _at(cfg, path);
    if (value == null) return null;
    final text = value is String ? value.trim() : value.toString();
    return text.isEmpty ? null : text;
  }

  _Status _statusOf(_ChannelDef def) {
    final s = IrmiaStrings.of(context);
    // 配置没读到就不给结论：状态点走「状态未知」，不按缺省值猜开关
    if (cfg == null) {
      return (kind: 'loading', tone: 'none', label: s.chanStatusUnknown, note: s.chanStatusUnknownNote);
    }
    return def.id == _hookChannelId ? _hookStatus() : _channelStatus(def.enabledPath, def.channel);
  }

  _Status _channelStatus(String enabledPath, String channel) {
    final s = IrmiaStrings.of(context);
    final last = _channelLast(channel);
    if (_at(cfg, enabledPath) != true) return (kind: 'sleeping', tone: 'none', label: s.chanStatusOff, note: s.chanStatusOffNote);
    if (last == null) return (kind: 'idle', tone: 'info', label: s.chanStatusOn, note: s.chanStatusOnNote);
    return (kind: 'running', tone: 'ok', label: s.toolRunning, note: s.chanStatusRunningNote(AppState.hhmm(last['ts']?.toString() ?? ''), last['seq'] == null ? '' : ' · #${last['seq']}'));
  }

  _Status _hookStatus() {
    final s = IrmiaStrings.of(context);
    final hits = [_lastOfType('wake/webhook'), _lastOfType('wake/file'), _lastOfType('alarm/sent')].whereType<Map<String, dynamic>>().toList()..sort((a, b) => (b['ts']?.toString() ?? '').compareTo(a['ts']?.toString() ?? ''));
    if (hits.isEmpty) {
      return _text('alerts.webhookUrl') == null
          ? (kind: 'sleeping', tone: 'none', label: s.chanStatusNoExit, note: s.chanStatusNoExitNote)
          : (kind: 'idle', tone: 'info', label: s.chanStatusExitOn, note: s.chanStatusExitOnNote);
    }
    final last = hits.first;
    return (kind: 'running', tone: 'ok', label: s.toolRunning, note: s.chanStatusHookRunningNote(_eventTagLabel(s, last['type']), AppState.hhmm(last['ts']?.toString() ?? '')));
  }

  List<_Row> _rows(List<_Spec> specs) => [for (final s in specs) (label: s.label, path: s.path, value: s.custom?.call(this) ?? _text(s.path))];

  /// 该项的活动：单通道看自己的通道事件，Webhook 项看三类事件
  List<Map<String, dynamic>> _feedOf(_ChannelDef def) {
    final list = def.id == _hookChannelId
        ? events.where((e) => _hookEventTypes.contains(e['type'])).toList()
        : events.where((e) => e['data'] is Map && (e['data'] as Map)['channel'] == def.channel).toList();
    list.sort((a, b) => (b['ts']?.toString() ?? '').compareTo(a['ts']?.toString() ?? ''));
    return list;
  }

  /// 两个入站通道都没启用：顶部给一条「从这里开始」的引导（docs/astrbot-benchmark.md §3.3）
  bool get _anyChannelEnabled =>
      _at(cfg, 'channels.qqOfficial.enabled') == true ||
      _at(cfg, 'channels.onebot.enabled') == true;

  bool get _loading => firstLoad || refreshing;

  /// 顶部 2px 不定进度线（取 ui_kit 的 StateBlock.loading 线形态）：高度固定，
  /// 出现与消失都不推动内容（docs/astrbot-ux-interaction.md §五）。
  Widget _progressLine(bool active) => SizedBox(
        height: 2,
        child: active ? const StateBlock.loading(padding: EdgeInsets.zero) : null,
      );

  String _footnote(AppStrings s) => evError != null
      ? s.chanFootnoteError(evError!)
      : s.chanFootnoteCount(events.length);

  @override
  Widget build(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        PageHeader(title: s.chanPageTitle, subtitle: s.chanPageSubtitle),
        // 列表加载走顶部 2px 进度线，不占位、不转圈（docs/astrbot-ux-interaction.md §五）
        _progressLine(_loading),
        if (cfg != null && !_anyChannelEnabled)
          Padding(
            padding: const EdgeInsets.fromLTRB(26, 12, 26, 0),
            child: GuideBar(
              icon: Icons.swap_horiz_rounded,
              text: s.chanGuideText,
              actionLabel: s.chanGuideAction,
              onAction: () => _openConfig(_qqChannelId),
              hint: s.chanGuideHint,
            ),
          ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, constraints) {
              // 宽窗：左列表 + 右详情并排；窄窗：一次只摆一个视图
              if (constraints.maxWidth >= _wideBreakpoint) {
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(
                      width: _sidebarWidth,
                      child: _listPane(context, narrow: false),
                    ),
                    Container(width: 1, color: scheme.outlineVariant),
                    Expanded(child: _detailPane(context, narrow: false)),
                  ],
                );
              }
              return narrowDetail ? _detailPane(context, narrow: true) : _listPane(context, narrow: true);
            },
          ),
        ),
      ],
    );
  }

  // ── 左：渠道列表 ──

  Widget _listPane(BuildContext context, {required bool narrow}) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(narrow ? 26 : 20, 14, narrow ? 16 : 8, 4),
          child: Row(
            children: [
              Text(s.chanListHeader, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, letterSpacing: 0.3, color: scheme.onSurfaceVariant)),
              const Spacer(),
              _iconAction(context, icon: Icons.refresh_rounded, tooltip: s.chanReloadAction, onPressed: () => unawaited(load())),
            ],
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: load,
            child: ListView(
              padding: EdgeInsets.fromLTRB(narrow ? 18 : 12, 0, narrow ? 18 : 8, 24),
              children: [for (final def in _channels(s)) _channelTile(context, def)],
            ),
          ),
        ),
      ],
    );
  }

  /// 列表行：图标 + 名称 + 状态点 + 一行副标题，行尾 icon-only「配置」
  Widget _channelTile(BuildContext context, _ChannelDef def) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final status = _statusOf(def);
    final selected = def.id == selectedId;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Material(
        color: selected ? scheme.surfaceContainerHighest : Colors.transparent,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: InkWell(
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          onTap: () => _select(def.id),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 9, 6, 9),
            child: Row(
              children: [
                Icon(def.icon, size: 18, color: selected ? scheme.primary : scheme.onSurfaceVariant),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(def.title,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: selected ? scheme.primary : scheme.onSurface)),
                          ),
                          const SizedBox(width: 6),
                          BreathDot(kind: status.kind, size: 7),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text('${status.label} · ${def.blurb}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, height: 1.4, color: scheme.onSurfaceVariant)),
                    ],
                  ),
                ),
                _iconAction(context, icon: Icons.tune_rounded, tooltip: s.chanConfigAction, onPressed: () => _openConfig(def.id)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ── 右：详情工作台 ──

  Widget _detailPane(BuildContext context, {required bool narrow}) {
    final s = IrmiaStrings.of(context);
    final def = _defOf(s, selectedId);
    final Widget body;
    if (cfgError != null) {
      body = StateBlock.error(
        message: s.chanConfigReadFailed,
        hint: cfgError,
        onRetry: () => unawaited(load()),
        padding: const EdgeInsets.symmetric(vertical: 14),
      );
    } else if (cfg == null) {
      // 首读期间不摆占位块：页面顶部的 2px 进度线已经在说明进展
      body = firstLoad
          ? const SizedBox.shrink()
          : StateBlock.error(
              message: s.chanConfigUnavailable,
              hint: s.chanConfigUnavailableHint,
              onRetry: () => unawaited(load()),
              padding: const EdgeInsets.symmetric(vertical: 14),
            );
    } else {
      body = _detailBody(context, def);
    }
    return Padding(
      padding: EdgeInsets.fromLTRB(narrow ? 26 : 10, narrow ? 10 : 14, 26, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (narrow)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: TextButton.icon(
                onPressed: () => setState(() => narrowDetail = false),
                icon: const Icon(Icons.arrow_back_rounded, size: 16),
                label: Text(s.chanBackToList, style: TextStyle(fontSize: 12.5)),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  minimumSize: const Size(0, 30),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
            ),
          Expanded(child: SingleChildScrollView(child: body)),
        ],
      ),
    );
  }

  Widget _detailBody(BuildContext context, _ChannelDef def) {
    final status = _statusOf(def);
    final rows = _rows(def.specs);
    final feed = _feedOf(def);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _detailCard(context, def: def, status: status, rows: rows),
        const SizedBox(height: 16),
        // 配置卡挂 _configKey：行尾齿轮滚到这张卡（状态卡上那枚「编辑配置」已按用户 ③ 去掉）
        KeyedSubtree(key: _configKey, child: _configCard(context, def)),
        const SizedBox(height: 20),
        // **联系人表**（2026-10-02 用户："我在GUI里没看见联系人表？"）：原来它埋在每条通道的
        // 详情里、得往下翻才看得见。现在提到配置卡之后这一层——**但只列当前这条通道自己的会话**：
        // 官 bot 与 OneBot 是两台各自独立的手机，互不往来（用户 2026-10-02 定的），
        // 一张卡里混着两边就等于把两台手机摆在同一个通讯录里。
        if (def.id != _hookChannelId) ...[
          _contactsCard(context, def),
          const SizedBox(height: 20),
        ],
        const SizedBox(height: 20),
        // 「她怎么被称呼」：名单是**跨通道**的（谁喊她名字都算），所以放在通道相关的那几卡
        // 之后、与「最近活动」之前——它是"外面的人怎么叫她"，不是某一条通道的属性
        _mentionCard(context),
        const SizedBox(height: 20),
        // 用户 ④：这一段原来是"裸"在页面底上的——一个光标题加一列横贯整页的行，
        // 跟上面三张卡不是一个形态。现在它有同一套壳（surface / outlineVariant /
        // radiusCard / hairline / 18-16 内边距），标题也升到与「通道配置」同一档。
        _activityCard(context, feed),
      ],
    );
  }

  /// 最近活动卡：形态与上面三张卡完全一致；行分隔线只在行与行之间
  /// （卡片里标题已经把上面隔开了，第一行再顶一条线就多了一道）
  Widget _activityCard(BuildContext context, List<Map<String, dynamic>> feed) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(s.chanRecentActivity, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
              _iconAction(context, icon: Icons.refresh_rounded, tooltip: s.chanReloadAction, onPressed: () => unawaited(load())),
            ],
          ),
          const SizedBox(height: 12),
          _feed(context, feed),
          const SizedBox(height: 4),
          // 脚注收进卡里：与「会话联系人」的尾注同一档字号，卡片自带说明，不留孤零零一行在卡外
          Text(_footnote(s), style: TextStyle(fontSize: 11, height: 1.6, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }

  // ── 「她怎么被称呼」卡：文本提及唤醒的那个名单 ──

  /// 现在生效的几个词（读的是 `/api/config` 的 `channels.mentionKeywords`）
  List<String> get _mentionKeywords {
    final channels = cfg?['channels'];
    final raw = channels is Map ? channels['mentionKeywords'] : null;
    if (raw is! List) return const [];
    return raw.whereType<String>().map((w) => w.trim()).where((w) => w.isNotEmpty).toList();
  }

  /// 为什么要有这一条（用户 2026-10-02）：群里的人常不打 @ 直接喊名字，平台不会把那种句子
  /// 标成"提到了机器人"——名单空着，那些话只会静静躺在信箱里，她永远听不见。
  ///
  /// 与「会话联系人」同一族（都是"外面的人是谁、在叫她什么"的事实），所以并排放在这里；
  /// 首次使用还会由 [MentionPromptHost] 主动问一次。
  Widget _mentionCard(BuildContext context) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final words = _mentionKeywords;
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(s.chanMentionTitle, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  s.chanMentionNote,
                  style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                ),
              ),
              TextButton(
                onPressed: () => unawaited(_editMentionKeywords()),
                child: Text(s.settingsEdit),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (words.isEmpty)
            HintLine(s.chanMentionEmpty)
          else
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                // 用现成的徽章形态（12% 淡底 + radiusCtl）：与同页那些「已配置/已启用」同一族，
                // 不为这一处再养一种"标签"的样式
                for (final word in words) _badge(word, scheme.primary),
              ],
            ),
          const SizedBox(height: 6),
          Text(s.chanMentionHint,
              style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }

  Future<void> _editMentionKeywords() async {
    final s = IrmiaStrings.read(context);
    final words = await showMentionKeywordsCard(
      context,
      initial: _mentionKeywords,
      // 输入框示例按她的名字写（这张卡问的是"机器怎么认出在叫她"，不是她的名字）
      herName: widget.state.herName,
    );
    if (words == null || !mounted) return; // 取消 = 一个字节都不写
    final problem = await widget.state.saveMentionKeywords(words);
    if (!mounted) return;
    if (problem != null) {
      IrmiaToast.show(context, s.chanMentionSaveFailed(problem), kind: ToastKind.error);
      return;
    }
    IrmiaToast.show(
      context,
      words.isEmpty ? s.chanMentionCleared : s.chanMentionSaved(words.join(s.chanJoinWords)),
      kind: ToastKind.success,
    );
    await _loadConfig();
  }

  // ── 会话联系人卡：给人一个"这个 sid 是谁"的地方 ──

  /// 为什么要它：QQ **不提供**单聊/群聊用户的昵称，也没接口查成员，她拿到的就是一串 openid。
  /// 手改 config.json 不是人人都愿意干的事，所以把那张表搬到这里来——而且可选目标是
  /// **她真的见过的会话**（从 wake/channel 事件折叠），不需要手打一串随机字符。
  ///
  /// 只列**本通道**的会话（用户 ⑤）：原来看的是全量会话，于是在 OneBot 页上也能看到
  /// 官 Bot 的联系人——而这张卡是"这条通道里的这个 sid 是谁"，跨通道就是答非所问。
  /// 口径与「最近活动」一致：都按 `def.channel` 过一遍。
  Widget _contactsCard(BuildContext context, _ChannelDef def) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    // **只列本通道的会话**：sid 里就带着通道名（`qq:` 对官 bot、`onebot:` 对协议端），
    // 所以这张卡天然就是"这条通道里的谁是谁"——两台手机互相独立（用户 2026-10-02）。
    final mine = sessions.where((sess) => '${sess['channel']}' == def.channel).toList();
    return Container(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(s.chanContactsTitle, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: scheme.onSurface)),
              const SizedBox(width: 8),
              // **短标签 + 一行要点，长解释收进「说明」折叠**（用户 2026-10-05 定的文案规则）。
              //
              // 原来这里是**一整段散文**（四句、占四五行的口语说明挂在一行标题右边），
              // 用户点名的反面样本就是它。现在这一行只说"这里能干什么"，
              // 下面两个『说明』折叠各收一组细节：口径与边界一组、字段各归谁管一组。
              //
              // 事实一个字都没丢，只是换了地方——尤其是"其余能不能收到取决于官方 Bot 的
              // 消息权限"（2026-10-04 改准的那半句）：它仍逐字在，`channels_contact_note_test`
              // 钉着它（那是"我们侧单方面做不到一句一条不丢"的如实口径，不许再退回去）。
              Expanded(
                child: Text(
                  s.chanContactsNote,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Align(
            alignment: Alignment.centerLeft,
            child: DetailFold(
              // 定位件：这一页有好几处「说明」折叠（通道配置也有一处），
              // 用例要的是"会话联系人卡里这一处"——按 key 找，不按文字找。
              key: const ValueKey('contacts-note'),
              label: s.chanDetailsLabel,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.chanContactsDetail,
                    style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (mine.isEmpty)
            HintLine(s.chanContactsEmpty)
          else
            for (final sess in mine) _contactRow(context, sess),
          const SizedBox(height: 10),
          // **群聊场景开关**（用户 2026-10-04 定的两种情景）：默认软提醒——框架把风险讲清楚、
          // 判断留给她；切到硬拒绝，群聊里的本机类工具在执行期直接拒。这条**立刻生效**
          //（与上面那张联系人表不同：那个要重启）。
          Row(
            children: [
              Text(s.chanGroupSceneLabel, style: TextStyle(fontSize: 12, color: scheme.onSurface)),
              const SizedBox(width: 8),
              _warnChip(
                context,
                exempt: _groupSceneHardRefusal,
                label: _groupSceneHardRefusal ? s.chanGroupSceneHard : s.chanGroupSceneSoft,
                onTap: () => unawaited(_toggleGroupScene()),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(s.chanContactsRestartNote,
              style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }

  Widget _contactRow(BuildContext context, Map<String, dynamic> sess) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final sid = '${sess['sid']}';
    final members = _groupMembers[sid] ?? const <Map<String, dynamic>>[];
    final chat = sess['chatType'] == 'c2c' ? s.chatTypeDirect : s.chatTypeGroup;
    final when = '${sess['lastSeenAt']}'.replaceFirst('T', ' ').split('.').first;
    // 备注（她写在别名名字后面括号里的那段口径）：**只读**，与名字分两处。
    // 为什么不让它进那个可编辑的格子：那一格保存时写回 `config.persona.contacts`（人声明的名字），
    // 备注长在她自己的 `MEMORIES/aliases.md` 里——把它塞进输入框，改一次名字就等于替她把口径
    // 抄进人的表里，还会把原话挤得只剩尾巴（用户看到的就是这个形状）。
    final note = '${sess['note'] ?? ''}'.trim();
    final ctl = _contactCtls.putIfAbsent(
      sid,
      () => TextEditingController(text: '${sess['name'] ?? ''}'),
    );
    // 展开时成员挂在**这一行下面**（用户 2026-10-04 的口径：注册的人要挂在对应群下面）。
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
          Expanded(
            // 身份文字 + **紧挨着它右边**的预警标签；这一行用 center 交叉轴对齐，
            // 于是标签相对那两行文字**上下居中**（用户 2026-10-04 的口径：上下居中、跟在身份右边）。
            child: Row(
              children: [
                Flexible(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(s.chanContactLine(chat, when),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: scheme.onSurface)),
                      Text(sid,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontFamily: 'monospace', fontSize: 10.5)),
                      // **她的备注另起一行，比 sid 还低一档**（用户 2026-10-04 报的 bug：
                      // 备注原来混在名字里，长长的口径把那一格挤得只剩尾巴）。为什么不做成
                      // 纯 hover 提示：这句是"她在群里怎么说话"的口径，看的人要能一眼扫到，
                      // 而不是先猜到那儿有东西；所以常态可见，整行单行 + 省略号（行高不变），
                      // 悬浮再给完整原话——那句话往往比一行宽。
                      if (note.isNotEmpty)
                        Tooltip(
                          message: note,
                          child: Text(s.chanContactNote(note),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 10.5,
                                color: scheme.onSurfaceVariant.withValues(alpha: 0.85),
                              )),
                        ),
                    ],
                  ),
                ),
                if (chat == s.chatTypeDirect) ...[
                  const SizedBox(width: 10),
                  _warnChip(
                    context,
                    exempt: _exemptSessions.contains(sid),
                    onTap: () => unawaited(_toggleExemptSession(sid)),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          const SizedBox(width: 12),
          SizedBox(
            width: 200,
            child: TextField(
              controller: ctl,
              decoration: InputDecoration(
                hintText: s.chanContactHint,
                isDense: true,
                border: OutlineInputBorder(),
              ),
              style: const TextStyle(fontSize: 12.5),
            ),
          ),
          const SizedBox(width: 6),
          _iconAction(
            context,
            icon: Icons.check_rounded,
            tooltip: s.chanContactSaveTooltip,
            onPressed: () => unawaited(_saveContact(sid)),
          ),
          // **展开按钮占一个恒定槽位（28）**：没有成员的会话也留着它。
          // 用户 2026-10-04 指出的对齐问题：群聊多这一个图标，它的名字输入框就比单聊的
          // 往左挪了一格——槽位固定之后，所有会话的输入框左边缘就都在同一条线上。
          SizedBox(
            width: 28,
            child: members.isEmpty
                ? null
                : _iconAction(
                    context,
                    icon: _expandedGroups.contains(sid)
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    tooltip: _expandedGroups.contains(sid) ? s.chanMembersCollapse : s.chanMembersExpand(members.length),
                    onPressed: () => setState(() {
                      if (!_expandedGroups.remove(sid)) _expandedGroups.add(sid);
                    }),
                  ),
          ),
            ],
          ),
        ),
        if (_expandedGroups.contains(sid)) _memberBlock(context, sid, members),
      ],
    );
  }

  /// 群成员列表块（用户 2026-10-04：要一个列表块，省空间）。
  ///
  /// 一行为一条：名字在左、openid 尾巴在右，点铅笔就地变成输入框（回车即存）。
  /// 名字写进群成员档案（数据文件，不在 config 里），改完**下一轮就生效**，不用重启。
  /// 框架预警的小标签：亮 = 已豁免（这个人/这个会话不过判定），暗 = 预警开着。
  /// 做成文字标签而不是图标：状态是"开还是关"，文字比铃铛更一眼看得懂（用户嫌图标丑）。
  Widget _warnChip(
    BuildContext context, {
    required bool exempt,
    required VoidCallback onTap,
    String? label,
  }) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(5),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
        decoration: BoxDecoration(
          border: Border.all(color: exempt ? scheme.primary : scheme.outlineVariant),
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(
          label ?? (exempt ? s.chanWarnExempt : s.chanWarnOn),
          style: TextStyle(
            fontSize: 10.5,
            color: exempt ? scheme.primary : scheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }

  Widget _memberBlock(BuildContext context, String groupSid, List<Map<String, dynamic>> members) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      // 右边留出 34 = 间距 6 + 图标 28：让这个块的右边缘与上面那排**名字输入框的右边缘**齐平
      // （用户 2026-10-04：没对齐不好看）。左边缩进 18，表示它是这一行的从属内容。
      // 右边留 34 = 间距 6 + 图标 28：让这个块的右边缘与上面那排**名字输入框的右边缘**齐平
      margin: const EdgeInsets.only(left: 18, right: 34, bottom: 10),
      decoration: BoxDecoration(
        border: Border.all(color: scheme.outlineVariant),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard - 6),
      ),
      child: Column(
        children: [
          for (var i = 0; i < members.length; i += 1) ...[
            if (i > 0) Divider(height: 1, thickness: 1, color: scheme.outlineVariant),
            _memberRow(context, groupSid, members[i]),
          ],
        ],
      ),
    );
  }

  Widget _memberRow(BuildContext context, String groupSid, Map<String, dynamic> member) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final openid = '${member['openid']}';
    final editing = _editingMember == openid;
    final ctl = _memberCtls.putIfAbsent(
      openid,
      () => TextEditingController(text: '${member['name'] ?? ''}'),
    );
    final tail = openid.length <= 8 ? openid : openid.substring(openid.length - 8);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
      child: Row(
        children: [
          if (editing)
            Expanded(
              child: TextField(
                controller: ctl,
                autofocus: true,
                decoration: const InputDecoration(isDense: true, border: OutlineInputBorder()),
                style: const TextStyle(fontSize: 12.5),
                onSubmitted: (_) => unawaited(_saveMember(openid, groupSid)),
              ),
            )
          else
            Expanded(
              child: Row(
                children: [
                  Flexible(
                    child: Text(
                      '${member['name'] ?? openid}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12.5, color: scheme.onSurface),
                    ),
                  ),
                  const SizedBox(width: 10),
                  _warnChip(
                    context,
                    exempt: (_exemptMembers[groupSid] ?? const <String>{}).contains(openid),
                    onTap: () => unawaited(_toggleExemptMember(groupSid, openid)),
                  ),
                ],
              ),
            ),
          const SizedBox(width: 8),
          // openid 只给尾巴：认得出是哪个号就够，整串没人看（用户 2026-10-02 的口径）
          Text(tail,
              style: TextStyle(fontFamily: 'monospace', fontSize: 10.5, color: scheme.onSurfaceVariant)),
          if (editing) ...[
            const SizedBox(width: 2),
            _iconAction(
              context,
              icon: Icons.check_rounded,
              tooltip: s.chanMemberSaveTooltip,
              onPressed: () => unawaited(_saveMember(openid, groupSid)),
            ),
          ] else ...[
            const SizedBox(width: 2),
            _iconAction(
              context,
              icon: Icons.edit_outlined,
              tooltip: s.chanMemberNameTooltip(member['name'] ?? openid),
              onPressed: () => setState(() {
                _editingMember = openid;
                _memberCtls[openid]?.text = '${member['name'] ?? ''}';
              }),
            ),
          ],
        ],
      ),
    );
  }
  /// 单聊豁免开关（立刻生效：下一轮那条会话的消息就不过判定了）
  Future<void> _toggleExemptSession(String sid) async {
    final s = IrmiaStrings.read(context);
    final on = !_exemptSessions.contains(sid);
    try {
      await widget.state.api.post(
        '/api/commands/set-warn-exempt',
        {'kind': 'session', 'sid': sid, 'on': on},
        confirm: 'set-warn-exempt',
      );
      if (!mounted) return;
      IrmiaToast.show(context, on ? s.chanExemptSessionOn : s.chanExemptSessionOff,
          kind: ToastKind.success);
      await load();
    } catch (err) {
      if (mounted) IrmiaToast.show(context, s.settingsSaveFailed('$err'), kind: ToastKind.error);
    }
  }

  /// 群成员豁免开关（群里只能按人豁免，没有整群那一档）
  Future<void> _toggleExemptMember(String groupSid, String openid) async {
    final s = IrmiaStrings.read(context);
    final on = !(_exemptMembers[groupSid] ?? const <String>{}).contains(openid);
    try {
      await widget.state.api.post(
        '/api/commands/set-warn-exempt',
        {'kind': 'member', 'groupSid': groupSid, 'openid': openid, 'on': on},
        confirm: 'set-warn-exempt',
      );
      if (!mounted) return;
      IrmiaToast.show(context, on ? s.chanExemptMemberOn : s.chanExemptMemberOff, kind: ToastKind.success);
      await load();
    } catch (err) {
      if (mounted) IrmiaToast.show(context, s.settingsSaveFailed('$err'), kind: ToastKind.error);
    }
  }

  /// 群聊场景：软提醒 ↔ 硬拒绝（立刻生效）
  Future<void> _toggleGroupScene() async {
    final s = IrmiaStrings.read(context);
    final next = !_groupSceneHardRefusal;
    try {
      await widget.state.api.post(
        '/api/commands/set-group-scene',
        {'hardRefusal': next},
        confirm: 'set-group-scene',
      );
      if (!mounted) return;
      IrmiaToast.show(
        context,
        next ? s.chanGroupSceneHardToast : s.chanGroupSceneSoftToast,
        kind: ToastKind.success,
      );
      await load();
    } catch (err) {
      if (mounted) IrmiaToast.show(context, s.chanToggleFailed('$err'), kind: ToastKind.error);
    }
  }

  Future<void> _saveMember(String openid, String groupSid) async {
    final s = IrmiaStrings.read(context);
    final name = _memberCtls[openid]?.text.trim() ?? '';
    if (name.isEmpty) {
      if (mounted) IrmiaToast.show(context, s.chanNameRequired, kind: ToastKind.error);
      return;
    }
    try {
      await widget.state.api.post(
        '/api/commands/set-group-member',
        {'openid': openid, 'name': name, 'groupSid': groupSid},
        confirm: 'set-group-member',
      );
      if (!mounted) return;
      IrmiaToast.show(context, s.chanMemberSaved(name), kind: ToastKind.success);
      _editingMember = null;
      await load();
    } catch (err) {
      if (mounted) IrmiaToast.show(context, s.settingsSaveFailed('$err'), kind: ToastKind.error);
    }
  }

  Future<void> _saveContact(String sid) async {
    final s = IrmiaStrings.read(context);
    final name = _contactCtls[sid]?.text.trim() ?? '';
    try {
      await widget.state.api.post(
        '/api/commands/set-contact',
        {'sid': sid, 'name': name},
        confirm: 'set-contact',
      );
      if (!mounted) return;
      IrmiaToast.show(
        context,
        name.isEmpty ? s.chanContactCleared : s.chanContactSaved(name),
        kind: ToastKind.success,
      );
      await load();
    } catch (err) {
      if (mounted) IrmiaToast.show(context, s.settingsSaveFailed('$err'), kind: ToastKind.error);
    }
  }

  // ── 就地配置卡：开关 + 字段 + 保存 / 重新加载 ──

  /// 一张卡装下该渠道的全部可写项。脏 = 与生效值逐字段比较，因此改回原值就自动干净——
  /// 不额外维护草稿状态机，也不存在 Web 端「改回原值仍显示 N 项改动」那种假脏。
  Widget _configCard(BuildContext context, _ChannelDef def) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final dirty = _dirty(def);
    final count = _dirtyFields(def).length;
    return AnimatedContainer(
      duration: IrmiaTheme.durCard,
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: _configPulse ? scheme.primary : scheme.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(s.chanConfigTitle, style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
              _badge(s.chanNeedsRestart, IrmiaTheme.warn),
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              s.chanConfigNote,
              style: TextStyle(fontSize: 12.5, height: 1.5, color: scheme.onSurfaceVariant),
            ),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: DetailFold(
              label: s.chanDetailsLabel,
              child: Text(
                s.chanConfigDetail,
                style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
              ),
            ),
          ),
          if (def.switchPath != null) ...[
            const SizedBox(height: 14),
            _switchRow(context, def),
          ],
          for (final secret in def.secrets) _secretRow(context, secret),
          for (final field in def.fields) _fieldRow(context, field),
          const SizedBox(height: 14),
          Row(
            children: [
              TextButton(
                onPressed: saving ? null : () => unawaited(_reload()),
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  minimumSize: const Size(0, 36),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: Text(s.chanReloadAction),
              ),
              // 「测试」只长在**有出口地址的那一项**上（Webhook 与文件监听）：
              // 另外两项（QQ / OneBot）与告警出口无关，摆一颗按不出结果的按钮比不摆更糟。
              if (def.id == _hookChannelId) ...[
                const SizedBox(width: 6),
                TextButton(
                  key: const ValueKey('alert-test'),
                  onPressed: alertTesting ? null : () => unawaited(_testAlertExit()),
                  style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    minimumSize: const Size(0, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: alertTesting
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(s.chanTestAlert),
                ),
              ],
              const Spacer(),
              if (dirty) ...[
                const DirtyPill(),
                const SizedBox(width: 10),
              ],
              FilledButton(
                onPressed: (dirty && !saving) ? () => unawaited(_save(def)) : null,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  minimumSize: const Size(0, 36),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: saving
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(count > 0 ? s.chanSaveWithCount(count) : s.save),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// 启用开关行：开关只写草稿，点保存才落配置
  Widget _switchRow(BuildContext context, _ChannelDef def) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final on = _switchOf(def);
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.fromLTRB(12, 4, 6, 4),
      decoration: BoxDecoration(color: scheme.surfaceContainer, borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl)),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.chanEnableLabel, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500)),
                Text(
                  on ? s.chanEnableNoteOn : s.chanEnableNoteOff,
                  style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          Switch(
            value: on,
            onChanged: saving
                ? null
                : (next) => setState(() => _switchDraft[def.switchPath!] = next),
          ),
        ],
      ),
    );
  }

  /// 密钥行：值与普通字段同样就地填，但**只写不读**——填一次存进本机密钥文件，
  /// 界面上永远只看得见掩码（桌面本地场景，值不出这台机器）。
  Widget _secretRow(BuildContext context, _SecretField field) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    final state = _keyState(field.keyName);
    final look = secretLook(
      context,
      configured: state.configured,
      hintFontSize: 12.5,
      base: InputDecoration(
        isDense: true,
        hintText: state.configured ? s.chanSecretHintConfigured : s.chanSecretHintPaste(field.label),
        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
      ),
    );
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 186,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(field.label, style: const TextStyle(fontSize: 12.5)),
                    const SizedBox(width: 6),
                    Icon(Icons.lock_outline_rounded, size: 12, color: scheme.onSurfaceVariant),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text(field.hint, style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        key: ValueKey('secret-${field.keyName}'),
                        controller: _secretCtl(field.keyName),
                        enabled: !saving,
                        obscureText: true,
                        autocorrect: false,
                        enableSuggestions: false,
                        style: const TextStyle(fontSize: 12.5),
                        // 已配置是个**状态**，不是一句占位提示：规格（蓝、居中）在 ui_kit
                        // 的 secretLook 里，与设置页两条 lane 的 API Key 共用一份
                        textAlign: look.textAlign,
                        decoration: look.decoration,
                      ),
                    ),
                    const SizedBox(width: 8),
                    _keyBadge(state),
                  ],
                ),
                if (state.configured)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: TextButton(
                      onPressed: saving ? null : () => unawaited(_clearSecret(field)),
                      style: TextButton.styleFrom(
                        foregroundColor: IrmiaTheme.danger,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        minimumSize: const Size(0, 28),
                        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      child: Text(s.settingsClearKey),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 密钥徽章：只有掩码，没有完整值
  Widget _keyBadge(({bool configured, String? mask}) state) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    if (keys == null) {
      return Text(keysError != null ? s.chanStatusUnknown : s.settingsReading,
          style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant));
    }
    if (!state.configured) return _badge(s.settingsNotConfigured, scheme.onSurfaceVariant);
    return _badge(s.chanSecretConfigured(state.mask ?? '…'), IrmiaTheme.ok);
  }

  /// 字段行：左标签 + 配置点路径，右输入框（AstrBot 的 field-row 版式）
  Widget _fieldRow(BuildContext context, _Field field) {
    final s = IrmiaStrings.of(context);
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 186,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(field.label, style: const TextStyle(fontSize: 12.5)),
                Text(field.path, style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: scheme.onSurfaceVariant)),
                if (field.hint != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Text(field.hint!, style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: TextField(
              // 测试与无障碍定位都按配置点路径认框，不数“第几个输入框”
              key: ValueKey('field-${field.path}'),
              controller: _ctl(field.path),
              enabled: !saving,
              autocorrect: false,
              enableSuggestions: false,
              style: const TextStyle(fontSize: 12.5),
              decoration: InputDecoration(
                isDense: true,
                hintText: field.kind == 'number' ? s.chanNumberHint : s.chanNotSetHint,
                contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 状态卡：状态点 + 标题 + 状态标签 + 状态说明与提示 + 只读补充项。
/// 右上角原先有一枚「编辑配置」——用户 ③ 说它没意义了：配置卡就在同一页的下面，
/// 这枚按钮只是同页滚动，去掉。行尾那枚齿轮仍然滚到配置卡（见 `_configKey`）。
Widget _detailCard(BuildContext context, {required _ChannelDef def, required _Status status, required List<_Row> rows}) {
  final s = IrmiaStrings.of(context);
  final scheme = Theme.of(context).colorScheme;
  final tone = _toneColor(context, status.tone);
  return Container(
    padding: const EdgeInsets.fromLTRB(18, 14, 12, 16),
    decoration: BoxDecoration(
      color: scheme.surface,
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
      border: Border.all(color: scheme.outlineVariant),
      boxShadow: IrmiaTheme.hairline,
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            BreathDot(kind: status.kind, size: 8),
            const SizedBox(width: 8),
            Flexible(child: Text(def.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600))),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              decoration: BoxDecoration(color: tone.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl)),
              child: Text(status.label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w500, color: tone)),
            ),
          ],
        ),
        Padding(
          padding: const EdgeInsets.only(right: 6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const SizedBox(height: 8),
              Text('${status.note}\n${def.hint}', style: TextStyle(fontSize: 12, height: 1.65, color: scheme.onSurfaceVariant)),
              if (rows.isNotEmpty)
                // 配置点路径属技术字段：默认收在「详情」里（§3.4）；可写字段在下面的配置卡
                DetailFold(
                  label: s.chanReadonlyFold(rows.length),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      DetailRow(label: s.chanChannelIdLabel, value: def.id),
                      for (final row in rows) _paramRow(context, row),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    ),
  );
}

Widget _paramRow(BuildContext context, _Row row) {
  final s = IrmiaStrings.of(context);
  final scheme = Theme.of(context).colorScheme;
  return Container(
    margin: const EdgeInsets.only(top: 8),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
    decoration: BoxDecoration(color: scheme.surfaceContainer, borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl)),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 186,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(row.label, style: const TextStyle(fontSize: 12.5)),
              Text(row.path, style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: scheme.onSurfaceVariant)),
            ],
          ),
        ),
        const SizedBox(width: 12),
        Expanded(child: Text(row.value ?? s.settingsNotConfigured, style: TextStyle(fontSize: 12.5, height: 1.5, color: row.value == null ? scheme.onSurfaceVariant : scheme.onSurface))),
      ],
    ),
  );
}

/// 该渠道最近活动：时间 + 来源 + 文本前 40 字；默认 8 行，其余收进「查看全部」
Widget _feed(BuildContext context, List<Map<String, dynamic>> events) {
  final s = IrmiaStrings.of(context);
  // 空态走卡内一行灰字，不摆 StateBlock（用户 ⑤：卡片化之后那块提示会变成盒子套盒子）。
  // 重试也不用给按钮——卡片标题行右端就有刷新。
  if (events.isEmpty) {
    return HintLine(s.chanFeedEmpty);
  }
  return CappedChildren(children: [
    for (var i = 0; i < events.length; i += 1) _feedRow(context, events[i], index: i, divider: i > 0),
  ]);
}

Widget _feedRow(BuildContext context, Map<String, dynamic> event, {required int index, required bool divider}) {
  final s = IrmiaStrings.of(context);
  final scheme = Theme.of(context).colorScheme;
  final chatType = _chatTypeLabel(s, _field(event, 'chatType'));
  final text = _field(event, 'text').replaceAll(RegExp(r'\s+'), ' ').trim();
  return Container(
    // 测试按行号定位（分隔线只在行之间，这条规则要有东西锁住）
    key: ValueKey('feed-row-$index'),
    width: double.infinity,
    padding: const EdgeInsets.symmetric(vertical: 9),
    decoration: divider ? BoxDecoration(border: Border(top: BorderSide(color: scheme.outlineVariant))) : null,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(AppState.hhmm(event['ts']?.toString() ?? ''), style: TextStyle(fontFamily: 'monospace', fontSize: 11.5, color: scheme.onSurfaceVariant)),
            const SizedBox(width: 8),
            Text('${_sourceOf(s, _field(event, 'channel'))}${chatType.isEmpty ? '' : ' · $chatType'}', style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600)),
          ],
        ),
        const SizedBox(height: 3),
        Text(_clip(text, 40), style: const TextStyle(fontSize: 13.5, height: 1.5)),
      ],
    ),
  );
}

/// 行尾 icon-only 操作按钮（照 AstrBot `ConversationPage.vue:170-181` 的 actions 列）：
/// 28×28 命中区、16px 图标，文案由 tooltip 承担
Widget _iconAction(BuildContext context, {required IconData icon, required String tooltip, required VoidCallback? onPressed, Color? color}) {
  final scheme = Theme.of(context).colorScheme;
  return IconButton(
    icon: Icon(icon, size: 16, color: color ?? (onPressed == null ? scheme.outlineVariant : scheme.onSurfaceVariant)),
    tooltip: tooltip,
    onPressed: onPressed,
    padding: EdgeInsets.zero,
    constraints: const BoxConstraints.tightFor(width: 28, height: 28),
    visualDensity: VisualDensity.compact,
    style: IconButton.styleFrom(tapTargetSize: MaterialTapTargetSize.shrinkWrap),
  );
}

/// 小圆角徽章（与设置页 _badge 同一形态）：标签 + 语义色
Widget _badge(String text, Color tone) {
  return Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: tone.withValues(alpha: 0.12),
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
    ),
    child: Text(text, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500, color: tone)),
  );
}

/// 按点路径取生效配置里的值（与 Web 端 getPath 同一口径）
Object? _at(Map<String, dynamic>? root, String path) {
  Object? node = root;
  for (final key in path.split('.')) {
    if (node is! Map || !node.containsKey(key)) return null;
    node = node[key];
  }
  return node;
}

String _field(Map<String, dynamic> event, String key) {
  final data = event['data'];
  return data is Map ? (data[key]?.toString() ?? '') : '';
}

Color _toneColor(BuildContext context, String tone) {
  final scheme = Theme.of(context).colorScheme;
  return tone == 'ok' ? IrmiaTheme.ok : tone == 'info' ? scheme.primary : scheme.onSurfaceVariant;
}


String? _endpointOf(_ChannelsPageState state) {
  final ws = state._text('channels.onebot.wsUrl');
  final uri = ws == null ? null : Uri.tryParse(ws);
  return uri == null || uri.host.isEmpty ? ws : '${uri.host}:${uri.port}';
}

/// 入站监听地址 = 本地观测/回调 HTTP 服务的实际绑定
String? _listenOf(_ChannelsPageState state) {
  final port = _at(state.cfg, 'web.port');
  return port is num ? 'http://${state._text('web.host') ?? '127.0.0.1'}:${port.toInt()}' : null;
}

String _clip(String text, int max) {
  final runes = text.runes;
  return runes.length <= max ? text : '${String.fromCharCodes(runes.take(max))}$kEllipsis';
}
