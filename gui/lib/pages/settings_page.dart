import 'dart:async';
// Process / Platform：只为「打开下载页」那一个动作（用系统默认浏览器打开官方链接）。
// 刻意不引 url_launcher——这个 GUI 是零第三方依赖的桌面壳，多一个包只为开一个链接不划算。
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;

import '../app.dart';
import '../theme.dart';
import '../ui_kit.dart';
// 「关窗时收进托盘」是界面自己的偏好（closeToTray / setCloseToTray），不进服务端配置
import '../ui_state.dart';
// 「改密码」那张表单（三个框）在 account_security.dart 里：它是这一页的一个分区动作，
// 但表单本身是一段自包含的东西（本地校验 + confirm + 就地换凭据）
import 'account_security.dart';
import 'page_chrome.dart';
// 「webhook 凭据只显示这一次」那张框：明文只在生成响应里出现一次，本页不留它
import 'webhook_secret.dart';

// 设置页 —— 锚点 + 分区卡片（docs/astrbot-ux-interaction.md「改造后适用」第一条）：
//   · 左侧 180px 分区锚点（模型 / 界面 / 发言 / 外部依赖 / 协议端 / 外部回调 / 记忆 / 系统 / 账号与安全 / 关于），
//     点击滚动到右侧对应分区；
//   · 右侧每组一张卡片（surface + outlineVariant 描边 + radiusCard），卡头 = 组名 + 一句说明；
//   · 模型组字段两列排布，窄窗降一列；
//   · 保存按钮未改动即禁用，脏时给出「有未保存的更改」；保存成功走 toast。
// 与 web/pages/settings.js 同构：字段路径、只读纪律与文案口径都对齐，两处不漂移。
//
// 写通道只有两条：
//   · 配置字段（模型 / 发言节奏 / 系统参数）→ POST /api/commands/config-update
//     （写 config.json，X-Confirm: config-update，进程重启后接管）
//     **例外**：有两个字段在服务端 `DANGEROUS_FIELDS` 里登记了**字段短语**，改它们时
//     `X-Confirm` 要在 `config-update` 之后追加那半截——`trust.mode` → 见 [kTrustConfirm]，
//     `tools.destructiveEnabled` → `enable-destructive`（那一处就地写着）。其余字段不许跟着加。
//   · API 密钥 → POST /api/commands/set-key（写 data/.keys.json，X-Confirm: set-key）
// 密钥只写不读：GET /api/keys 只返回 {configured, mask}，完整值不经过本页面。
class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.state});

  final AppState state;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

/// GUI 版本号：与 gui/pubspec.yaml 的 version 同步维护（pubspec 那份是 `0.1.0+1`）。
/// Flutter 没有运行时读取 pubspec 的内置途径，零依赖前提下写成常量。
///
/// 为什么带 `v` 与 `-beta` 而 pubspec 里没有：pubspec 的 version 要喂给 Windows 资源
/// 版本号（windows/runner/Runner.rc 的 FILEVERSION 是 4 个整数）与安装器，容不下预发布
/// 标记——beta 只体现在这里与包名/说明里；后端那边对同一版号的口径是 `AGENT_VERSION`
/// （不带 v，见 src/main.ts）。
/// ⚠️ 别把具体版号抄进注释：出包脚本只改这一行的字面量、不改注释，抄一处就留一处对不上。
const guiVersion = 'v0.1.0-beta.6';

/// 锚点侧栏宽度（AstrBot 的左侧 section 导航）
const _railWidth = 180.0;

/// 锚点转顶部横条、字段由两列降一列的断点
const _railBreakpoint = 900.0;
const _twoColBreakpoint = 620.0;

/// 锚点判定带宽：分区顶边进入这条线以内即算「当前分区」
const _activeBand = 24.0;

/// 两条模型 lane（与 src/config/config.ts 的 ModelsConfig.heavy/light 同名）
const _laneIds = ['heavy', 'light'];
const _laneLabels = {'heavy': '主循环（heavy）', 'light': '轻量（light）'};
const _laneNotes = {
  'heavy': 'turn 主循环使用的模型',
  'light': '必要性判断、压缩摘要与守卫分类使用的模型',
};

/// 分区锚点：id 与下方 _sectionBlock 的分区 key 一一对应
typedef _Anchor = ({String id, String label, IconData icon});

const _anchors = <_Anchor>[
  (id: 'model', label: '模型', icon: Icons.tune_rounded),
  (id: 'ui', label: '界面', icon: Icons.palette_outlined),
  (id: 'speak', label: '发言', icon: Icons.record_voice_over_outlined),
  // 外部依赖（v30）：pwsh 7 / ripgrep / es.exe 三件事由框架管，这里只做"看得见 + 一键装"。
  // 位置放在「发言」之后、「系统」之前：它是**可写的运维动作**（安装），
  // 不该混进只读的「系统」快照里，而"她能用什么工具"排在"她怎么说话"之后正合适。
  (id: 'deps', label: '外部依赖', icon: Icons.extension_outlined),
  // 内置协议端（v34）：紧跟「外部依赖」之后——它与那张卡是同一类东西（框架管的外部程序），
  // 但**可选**：不开的人照旧用官方通道，开了才多一双"看得见群"的眼睛。
  (id: 'protocol', label: '协议端', icon: Icons.hub_outlined),
  // 外部回调（B9）：`POST /webhook/*` 的专用凭据（生成 / 轮换）。紧跟在「协议端」之后——
  // 它与那两张卡是同一类东西（框架管的外部程序 / 外部系统怎么接进来），
  // 而它是一次**可写的运维动作**（生成），不该混进只读的「系统」快照里。
  (id: 'webhook', label: '外部回调', icon: Icons.webhook_rounded),
  // 记忆（2026-10-04 加）：**框架代管记忆**的总开关（`persona.memoryEnabled`）。
  // 为什么单独一个分区、而不是塞进「系统」快照里：它是"她怎么活"的一条开关（框架替不替她
  // 管长期记忆），与监听地址/预算那种**整台实例的启动参数**不是一类东西；而它也不是人格资产
  // 本身——人格资产页编的是文件内容，这条决定那些文件由谁维护。紧邻「系统」之前：
  // 两者都是"这台实例这一层"的话，但这条更靠近她。
  (id: 'memory', label: '记忆', icon: Icons.psychology_outlined),
  // 信任范围（`trust.mode`）：**她的活动边界有多宽**——整台电脑，还是只有一个工作目录。
  // 为什么紧挨在「系统」之前、而不是塞进「系统」那张表里：系统卡是"这台实例怎么启动"
  // （监听地址、预算、数据目录），而这一条是"她这个人能碰多远"——它和「记忆」属于同一族
  // （她的行为边界），只是这一条更硬：越过它就是拒绝，不是提醒。
  (id: 'trust', label: '信任范围', icon: Icons.shield_outlined),
  (id: 'system', label: '系统', icon: Icons.dns_outlined),
  // 账号与安全（B10）：改密码与登出。排在这里而不是塞进「模型」卡里：它改的是**进来的方式**
  // （凭据），与"她怎么说话、用哪个模型"毫无关系；而它与「系统」同属"整台实例这一层"，
  // 所以紧跟在系统之后、「关于」之前。
  (id: 'account', label: '账号与安全', icon: Icons.lock_outline_rounded),
  (id: 'about', label: '关于', icon: Icons.info_outline_rounded),
];

/// 协议端官方 Releases（**手动那条路的出路**：一键安装失败、或平台不是 Windows 时人自己去下）。
///
/// 许可那件事照实说：SnowLuma 是"源码可见非商业许可"，自用可以、随框架分发不行。
/// 框架现在做的是**从官方 Releases 代下载**（替他点一下下载那三步），不随框架分发、不改它一个字节；
/// 所以这个地址仍然要摆在界面上——代下载失败时，它就是唯一还走得通的那条路。
const protocolDownloadUrl = 'https://github.com/SnowLuma/SnowLuma/releases';

/// 依赖探测结果的界面形状（与 GET /api/deps 的 entries 一一对应）。
///
/// 为什么不直接拿 Map 用：这张卡片有十来处取值（徽章、路径、影响说明、动作按钮），
/// 散着写 `entry['field']` 的话，字段改名会静默变成 null 而不是编译错误——
/// 那正是"界面上少了一句话而没人发现"的典型成因。
class _DepEntry {
  const _DepEntry({
    required this.name,
    required this.label,
    required this.status,
    required this.path,
    required this.version,
    required this.reason,
    required this.purpose,
    required this.impact,
    required this.installable,
    required this.downloadPage,
    required this.manualHint,
    required this.managedDir,
  });

  final String name;
  final String label;

  /// ready / version-mismatch / missing（未知值按 missing 处理：宁可说"没装"也别假装就绪）
  final String status;
  final String path;
  final String version;
  final String reason;
  final String purpose;
  final String impact;
  final bool installable;
  final String? downloadPage;
  final String? manualHint;
  final String managedDir;

  bool get ready => status == 'ready';
  bool get mismatch => status == 'version-mismatch';

  static _DepEntry from(Object? raw) {
    final map = raw is Map ? raw.cast<String, dynamic>() : const <String, dynamic>{};
    String text(String key) {
      final value = map[key];
      return value == null ? '' : value.toString();
    }

    return _DepEntry(
      name: text('name'),
      label: text('label').isEmpty ? text('name') : text('label'),
      status: text('status').isEmpty ? 'missing' : text('status'),
      path: text('path'),
      version: text('version'),
      reason: text('reason'),
      purpose: text('purpose'),
      impact: text('impact'),
      installable: map['installable'] == true,
      downloadPage: text('downloadPage').isEmpty ? null : text('downloadPage'),
      manualHint: text('manualHint').isEmpty ? null : text('manualHint'),
      managedDir: text('managedDir'),
    );
  }
}

/// 这一次「一键安装」的结果（v35）。
///
/// 为什么这份东西留在**页面里**而不是从服务端读回来：它是**这一次点击**的产物——
/// `log`（卡在哪一步）只在这条回执里，服务端压根没有"最近一次安装"这个概念，
/// 凭空造一个服务端的"上次安装"就是多一份迟早会漂移的真相。
/// 代价是刷新页面后引导消失；那时状态行、`restartRequired` 徽章与「需重启」提示条还在说同一件事，
/// 不至于把人晾在半路。
class _ProtocolInstall {
  const _ProtocolInstall({
    required this.ok,
    required this.dir,
    required this.version,
    required this.detail,
    required this.log,
    this.writeError = '',
  });

  /// 失败：只带服务端那句人话与过程记录（没有目录、没有版本可谈）
  const _ProtocolInstall.failed(this.detail, {this.log = const <String>[]})
      : ok = false,
        dir = '',
        version = '',
        writeError = '';

  /// 装成了没有
  final bool ok;
  /// 装到哪（服务端定的那个固定的家；ok 为 true 时非空）
  final String dir;
  /// 装的是哪个版本（取自官方 release tag）
  final String version;
  /// 服务端那句人话：成功="已装好 vX"，失败="卡在哪一步、为什么"
  final String detail;
  /// 过程记录，逐行给人看（"正在下载…"这类）
  final List<String> log;
  /// **装成了但紧接着那次写配置失败了**的原因：与"压根没装成"是两件事，分开记
  final String writeError;

  /// 装好并且配好了——"重启一下就能用"这句话只在这种状态下才成立
  bool get configured => ok && writeError.isEmpty;
}

/// 一条 lane 的输入态：控制器、原始值快照与保存中标志都属于本页，不写进全局状态。
/// 原始值快照用于「未改动即禁用」：控制器内容与快照逐字段比对得出脏状态。
class _LaneForm {
  _LaneForm({required this.onChanged}) {
    modelCtl.addListener(onChanged);
    baseCtl.addListener(onChanged);
    keyCtl.addListener(onChanged);
  }

  final VoidCallback onChanged;
  final modelCtl = TextEditingController();
  final baseCtl = TextEditingController();
  final keyCtl = TextEditingController();
  bool saving = false;

  /// 生效配置里的原始值（首次加载与保存成功后各回填一次）
  String baseModel = '';
  String baseBaseUrl = '';

  /// 待保存的模型字段改动
  bool get modelDirty => modelCtl.text.trim() != baseModel || baseCtl.text.trim() != baseBaseUrl;

  /// 待写入的密钥：密钥只写不读，非空即为待保存内容
  bool get keyDirty => keyCtl.text.trim().isNotEmpty;

  bool get dirty => modelDirty || keyDirty;

  void seed({required String model, required String baseUrl}) {
    baseModel = model.trim();
    baseBaseUrl = baseUrl.trim();
    modelCtl.text = model;
    baseCtl.text = baseUrl;
  }

  void dispose() {
    modelCtl.removeListener(onChanged);
    baseCtl.removeListener(onChanged);
    keyCtl.removeListener(onChanged);
    modelCtl.dispose();
    baseCtl.dispose();
    keyCtl.dispose();
  }
}

/// 系统卡可编辑字段的取值形状。
///
/// 这四种形状是**照 `src/config/config.ts` 的解析器抄的**，不是照界面的手感挑的：
/// 解析器只收整数（`pickInt`，下限 1；端口另有 65535 的上限）、(0,1] 的小数（`pickRatio`）
/// 与非空字符串（`pickNonEmptyString`）。界面只要放宽一格，那次保存就注定被服务端回滚
/// ——而回滚发生在写盘之后，人看到的是一句"保存失败"，不是"这个值不对"。
enum _SysKind {
  /// 主机地址。解析器（`pickString`）收空串，但空串会一路走到 `server.listen(port, '')`，
  /// 而 Node 把空 host 当"未指定"绑到 `::`——观测台就此对局域网开门。所以这里按危险处理。
  host,

  /// 监听端口：`pickInt(..., 1, 65535)`
  port,

  /// 非空文本（时区还要过 IANA 名，那一条只有服务端的 `Intl.DateTimeFormat` 判得了）
  text,

  /// 整数且 ≥ 1：六条预算里除 softRatio 之外的五条
  count,

  /// (0,1] 的小数：`pickRatio` 专门拒绝"写成 8 而不是 0.8"这种真实错误
  ratio,

  /// **闭区间内的整数**：区间由字段自己带（[min] / [max]）。
  ///
  /// 与 [count] 分开，是因为"这一段数里才有意义"与"至少是 1"是两种判据，硬塞进 [count]
  /// 会让那五条预算的提示文案跟着变形。当前唯一的一个是心跳平均间隔
  /// （`wake.heartbeatTargetMeanMin`，6~59，见 [_sysHeartbeatMean]）。
  range,
}

/// 系统卡里的一个可编辑字段：点路径 + 标签 + 形状 + 旁注。
///
/// 为什么规格摆成数据而不是十段长得一样的 build 代码：脏判定、保存、回填、渲染四处
/// 都按这一份清单走；抄九遍的下场是某一格"改了却存不进去"或"存了却不显脏"，
/// 而这两种 bug 都不会报错，只会静静地少写一个字段。
class _SysField {
  const _SysField(this.path, this.label, this.kind, {this.note, this.hint, this.min, this.max});

  /// 写进 config.json 的点路径：既是输入框的 key（测试按它定位），也是提交时的字段名
  final String path;
  final String label;
  final _SysKind kind;

  /// 框下面那句旁注：单位、范围、写法都归它（数值本身不许在这里被"换算"）
  final String? note;

  /// 框里的示例（只在框空着时显示）
  final String? hint;

  /// [kind] 为 range 时的**闭区间**（含两端）。其余形状用不到（它们的边界写死在
  /// [problem] 里：pickInt 的下限 1、端口的上限 65535、比例的开区间 0~(0,1]）。
  final int? min;
  final int? max;

  /// 数字字段用等宽（docs/copy-guide.md §6）：20000000 与 500000 要能一眼比出量级
  bool get numeric =>
      kind == _SysKind.port || kind == _SysKind.count || kind == _SysKind.ratio || kind == _SysKind.range;

  /// 生效值 → 输入框文本。**原样呈现**：20000000 就是 `20000000`，不做 k/M 换算、
  /// 不补百分号——框里必须是 config.json 里那个值本身（用户 ⑪）。
  /// 紧凑写法（20M）与百分比（80%）只允许出现在旁注里，否则人会以为能照那样填。
  String seed(Map<String, dynamic>? cfg) {
    final value = _at(cfg, path);
    if (value == null) return '';
    return switch (kind) {
      _SysKind.host || _SysKind.text => value is String ? value : value.toString(),
      _SysKind.ratio => value is num ? _plainDouble(value.toDouble()) : '',
      _SysKind.port || _SysKind.count || _SysKind.range => value is num ? value.toInt().toString() : '',
    };
  }

  /// 输入框文本 → 提交值（调用前必先过 [problem]）
  Object decode(String text) => switch (kind) {
        _SysKind.host || _SysKind.text => text,
        _SysKind.ratio => double.parse(text),
        _SysKind.port || _SysKind.count || _SysKind.range => int.parse(text),
      };

  /// 不合规返回那句话（保存前拦下，一个字节都不写盘）；合规返回 null
  String? problem(String text) {
    switch (kind) {
      case _SysKind.host:
        return text.isEmpty ? '监听地址不能为空：空值等于监听所有网卡，未保存' : null;
      case _SysKind.text:
        return text.isEmpty ? '$label不能为空，未保存' : null;
      case _SysKind.port:
        final value = int.tryParse(text);
        if (value == null) return '$label要填整数，未保存';
        return (value < 1 || value > 65535) ? '$label要在 1~65535 之间，未保存' : null;
      case _SysKind.count:
        final value = int.tryParse(text);
        if (value == null) return '$label要填整数，未保存';
        return value < 1 ? '$label最小是 1，未保存' : null;
      case _SysKind.ratio:
        final value = double.tryParse(text);
        if (value == null) return '$label要填小数（0.8 表示 80%），未保存';
        return (value <= 0 || value > 1) ? '$label是比例，要落在 0~1 之间（不含 0），未保存' : null;
      case _SysKind.range:
        final value = int.tryParse(text);
        if (value == null) return '$label要填整数，未保存';
        final lo = min;
        final hi = max;
        if (lo != null && value < lo) return '$label最小是 $lo，未保存';
        if (hi != null && value > hi) return '$label最大是 $hi，未保存';
        return null;
    }
  }
}

/// 系统卡的两条地址字段：分开摆是因为解析器把它们当两个字段，合成 `127.0.0.1:7788`
/// 只是显示上的方便——而"显示方便"换个方向就是"改不了其中一半"。
const _sysHost = _SysField('web.host', '监听地址', _SysKind.host,
    note: '本机用就填 127.0.0.1；端口 1~65535。留空等于监听所有网卡，会被拦下。');
const _sysPort = _SysField('web.port', '端口', _SysKind.port, hint: '7788');
const _sysTimezone = _SysField('timezone', '时区', _SysKind.text,
    note: 'IANA 名称，例如 Asia/Shanghai。预算的「今日」按它切分。', hint: 'Asia/Shanghai');

/// 六条预算（与 `BudgetConfig` 同名同序）。标签沿用原来那张表上的写法，少一处漂移。
const _sysStepTools = _SysField('budget.stepTools', '预算 · 步内工具调用上限', _SysKind.count,
    note: '单个 step 里最多调几次工具。', hint: '20');
const _sysTurnSteps = _SysField('budget.turnSteps', '预算 · 单 turn 步数上限', _SysKind.count,
    note: '一个 turn 最多走多少步。', hint: '30');
const _sysTaskTokens = _SysField('budget.taskTokens', '预算 · 任务 token 上限', _SysKind.count,
    note: '单个任务累计上限；填原值，20M 这类简写不接受。'
        '口径是非缓存 token（真花钱的那部分），不是账单上的用量。', hint: '500000');
/// 提示值 = **出厂默认值**（`src/config/config.ts` 的 `buildDefaults`：`dailyTokens: 100_000_000`）。
/// 2026-10-04 与出厂值对齐：出厂从 2M 改成 100M 之后，这里还写着 2000000 就是在教人填一个
/// 会被心跳自己吃穿的值（心跳是真实唤醒，2M 撑不住一天）。只改提示，校验逻辑一个字都没动。
const _sysDailyTokens = _SysField('budget.dailyTokens', '预算 · 每日 token 上限', _SysKind.count,
    note: '每日累计上限，按上面的时区切分。口径同上一行：只数没命中缓存的那部分。',
    hint: '100000000');
const _sysSoftRatio = _SysField('budget.softRatio', '预算 · 软阈值', _SysKind.ratio,
    note: '0~1 的小数：0.8 就是 80%。到这一线先提示收尾，越过才硬停。', hint: '0.8');
const _sysFailStreak = _SysField('budget.failStreakMax', '预算 · 连续失败上限', _SysKind.count,
    note: '连续失败这么多次就告警并进入暂停。', hint: '5');

/// 心跳的平均间隔（`wake.heartbeatTargetMeanMin`）——**用户 2026-10-05 要的那个「我能不能控制心跳频率」**。
///
/// 落在这一组里的理由：它管的确实是"她多久醒一次"，但它同时也是一条**花销旋钮**
/// （每醒一次就真跑一个 turn、真花 token），与上面六条预算在使用上是同一类东西——
/// 想省 token 的人来这一组找，找得到。
///
/// 取值 6~59 是**按后端契约的前端提示**（后端才是最终判据；写错了启动就报配置错，
/// 不会静默夹一个值——见 config.example.json 的 `wake.$comment` 与 docs/operations.md §1.3）：
/// 那边要求目标均值**严格**落在 `heartbeatFloorMin` 与 `heartbeatCeilMin` 之间，且整体落在 5~60。
/// 出厂那组边界是 floor 5 / ceil 60，于是当下可填的整数区间正好是 6~59：
///   · 6  = 比下限 5 大 1：平均值贴着下限不是"平均"，是"每一拍都在最早那一刻"；
///   · 59 = 比上限 60 小 1：平均值贴着上限同理（每一拍都是最后一拍）。
/// 用户若把 floor / ceil 改成别的值，这个前端提示会显得保守一格——**这是有意的**：
/// 界面只拦"明显不可能"的两端，真正判合不合规的是后端，而把 floor/ceil 读进界面来算区间
/// 会让同一件事有第二份判据（改了配置却不重启时，界面算出来的区间是错的，比保守更糟）。
///
/// hint 15 = 出厂默认值（= 实测均值，real-loop 与 docs/design.md §4.12 都写着 15 分钟）。
///
/// 旁注**刻意不报具体数字**：那两个边界将来会被用户按自己的 config.json 改（他改了这里也不会跟着变），
/// 而写了数字的旁注一旦落后就成了假话——所以这里只说"两端各由一条上下限兜住"，数字让人去看 config.json。
const _sysHeartbeatMean = _SysField(
  'wake.heartbeatTargetMeanMin',
  '心跳间隔 · 平均（分钟）',
  _SysKind.range,
  min: 6,
  max: 59,
  hint: '15',
  note: '她平均多久自己醒一次——越大越省 token，越小越常醒。'
      '两端仍由上下限兜住：不因这个数改变，安静不足下限不会醒、到了上限必然会醒。',
);

/// 系统卡的全部可编辑字段（回填、脏判定与销毁都遍历它）
const _sysFields = <_SysField>[
  _sysHost,
  _sysPort,
  _sysTimezone,
  _sysStepTools,
  _sysTurnSteps,
  _sysTaskTokens,
  _sysDailyTokens,
  _sysSoftRatio,
  _sysFailStreak,
  _sysHeartbeatMean,
];

/// 信任范围的两档（`trust.mode`）——**取值与字面量与 `src/config/config.ts` 的
/// `TrustMode` 逐字对齐**（那边只认这两个字面量，拼错即报错），界面不许自己造第三档、
/// 也不许把标签当成写入值（标签是给人看的，写进去的永远是这两个 id 之一）。
const kTrustFull = 'full';
const kTrustWorkspace = 'workspace';

/// 改 `trust.mode` 时 `X-Confirm` 要带的**命令短语 + 字段短语**。
///
/// 为什么是这一串、以及为什么"收紧"也要带：服务端 `DANGEROUS_FIELDS`
/// （`src/web/server.ts` 的 `'trust.mode': 'trust-full-access'`）**刻意不做方向区分**——
/// 只给"放宽"加门就得先读盘上现值再判方向，那会变成同一件事的第二处判据，
/// 而"改这个字段一律要短语"是一句话能核对完的规则。短语值按 `;` 拆、只看包含，多带无害。
///
/// 为什么拎成常量：引导卡第五步（`onboarding.dart` 的 `_settleTrust`）写的是**同一个字段**，
/// 两处各写一份字面量的下场与本文件顶部 `kTrustFull` 那条注释说的一样——服务端换短语时
/// 只会改一处，另一处静默地吃 400。**这两处必须同时改**，所以它们读同一个名字。
const kTrustConfirm = 'config-update; trust-full-access';

/// 二选一的**后果话术**（两处共用：设置页与首次引导页）。
///
/// 为什么把文案抽出来：这两句话是这一档的全部意义所在——用户要的是"两种选择各一句后果
/// 说明"，而且**两处必须一模一样**。各写一份的下场是引导页说"只能在某个目录里"、
/// 设置页说成别的，人根本判断不了自己选了什么。
///
/// 「只限工作目录」那句里带上 [root]（= `trust.workspaceRoot`，由服务端解析器算出来），
/// 因为"被关在一个目录里"这件事不说清是哪个目录就等于没说——被拦下的那一刻他才知道，
/// 那就太晚了。
String trustModeConsequence(String mode, String root) {
  if (mode == kTrustWorkspace) {
    return root.isEmpty
        ? '她只能在配置里的工作目录（trust.workspaceRoot）中活动；越界的读写与命令会被拒绝。'
        : '她只能在 $root 里活动；越界的读写与命令会被拒绝。';
  }
  return '她能读写整台电脑上的文件、也能在任意目录跑命令。';
}

/// 二选一那一行的**标题**（同样两处共用）
String trustModeLabel(String mode) =>
    mode == kTrustWorkspace ? '只限工作目录' : '完全信任';

/// 二选一的一个可点选项（**设置页与首次引导页共用同一份实现**）。
///
/// 为什么两处共用而不是各画一张：这两处的选择是同一件事（`trust.mode`），版式一分为二
/// 之后就会出现"引导页强调的那档与设置页高亮的那档不一样"这种没人会发现的漂移。
///
/// 形状是**成对的选择行**：左边一枚 Radio、右边标题 + 一句后果。为什么不用 SegmentedButton
/// （「界面」卡里那个）：它一行只放得下一个短标签，装不下"她能读写整台电脑上的文件"这句话
/// ——而把后果压成"选中之后才显示"的一行，就等于把另一半蒙起来让人选。
///
/// 选中态有三处冗余的提示（Radio 的点、描边加粗、底色），这不是装饰：这一行决定的是
/// **边界**，选错的那一档不该靠"对比两行颜色的深浅"才看得出来。
class TrustModeChoice extends StatelessWidget {
  const TrustModeChoice({
    super.key,
    required this.mode,
    required this.selected,
    required this.consequence,
    this.enabled = true,
    required this.onPick,
  });

  /// 这一行代表哪一档（取值就是写进 config.json 的那两个字面量）
  final String mode;

  /// 是不是当前选中的那档
  final bool selected;

  /// 选它之后会发生什么（一句话，两处共用 [trustModeConsequence]）
  final String consequence;

  /// 写入中：整行按下（避免连点两次打两个请求）
  final bool enabled;

  /// 人点了它——**点已选中的那一行同样会回调**：要不要写一次盘由调用方判
  /// （"与盘上那份一样就不写"的判据在页面手里，这一行只负责报"他点了"）
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: selected ? scheme.primary.withValues(alpha: 0.06) : scheme.surface,
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      child: InkWell(
        key: ValueKey('trust-mode-$mode'),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        onTap: enabled ? () => onPick(mode) : null,
        child: Container(
          padding: const EdgeInsets.fromLTRB(6, 8, 12, 8),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
            border: Border.all(
              color: selected ? scheme.primary.withValues(alpha: 0.55) : scheme.outlineVariant,
              // 选中那一行描边加粗一档：灰度截图或色弱时"深浅"不一定分得出来，"粗细"分得出
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 每一行自己是一个 RadioGroup（成员只有它那一枚 Radio，取值恒为 true）——
              // 而不是两行共用一个：共用的那个"组值"必须来自两行之外的某个地方，而这两行
              // 本来就分属两个 widget，组值会变成第二份"当前选中的是哪档"的真相。
              // 分组只为了**不踩 deprecation**（3.35 起 Radio.groupValue/onChanged 已废弃，
              // 替代品正是 RadioGroup 这个祖先），选中状态仍由上面的 [selected] 一个来源决定。
              // `toggleable` 不开：二选一必有一档生效，"两档都不选"不是一个状态。
              RadioGroup<bool>(
                groupValue: true,
                // 写入中给一个不做事的回调（RadioGroup.onChanged 是必填）：加上下面
                // Radio 的 enabled=false，键盘与鼠标两条路都点不动
                onChanged: enabled ? (_) => onPick(mode) : (_) {},
                child: Radio<bool>(
                  value: true,
                  enabled: enabled,
                  visualDensity: VisualDensity.compact,
                  materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      trustModeLabel(mode),
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                        color: scheme.onSurface,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      consequence,
                      style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 系统卡的**行**（交互单位）：行 id → 这一行管的字段。
///
/// 为什么行与字段要分成两个概念：监听地址那一行是**两个字段**（`web.host` + `web.port`，
/// 解析器也当两个字段看），而"点编辑 / 点保存 / 点取消"这个动作是按**行**发生的。
/// 行 id 同时是编辑态的键与测试定位的键（`sys-edit-<id>` / `sys-value-<id>` …）。
const _sysRowFields = <String, List<_SysField>>{
  'web': [_sysHost, _sysPort],
  'timezone': [_sysTimezone],
  'budget.dailyTokens': [_sysDailyTokens],
  'budget.stepTools': [_sysStepTools],
  'budget.turnSteps': [_sysTurnSteps],
  'budget.taskTokens': [_sysTaskTokens],
  'budget.softRatio': [_sysSoftRatio],
  'budget.failStreakMax': [_sysFailStreak],
  // 心跳平均间隔（用户 2026-10-05）：行 id 与字段路径**同名**——这一行只有一个字段，
  // 没必要为它另起一个名字（监听地址那种"两字段一行"才需要）。
  'wake.heartbeatTargetMeanMin': [_sysHeartbeatMean],
};

class _SettingsPageState extends State<SettingsPage> {
  Map<String, dynamic>? cfg;
  String? cfgError;
  bool loading = true;

  /// **盘上已改、进程还没接管**的字段（服务端 `$pending.restartRequired` 给的点路径）。
  ///
  /// 判据只有这一处：本页不另算一份"哪些要重启"（同一件事存两处，迟早有两种说法）。
  /// 它的用处是把「需重启」那枚徽章说准——那一行现在**真的**和生效值不一样时，
  /// 徽章换成「尚未生效」；只是"这一类字段改完要重启"时，仍旧是「需重启」。
  Set<String> pendingRestart = const <String>{};

  /// 这一份配置是从哪儿读来的：`saved` = 盘上那份；`memory` = 盘读不出来、回落成生效配置。
  /// 空串表示服务端没给这个字段（老服务端）。
  String savedSource = '';

  Map<String, dynamic>? keys;
  String? keysError;
  bool keysLoading = true;

  Map<String, dynamic>? proj;
  String? projError;

  /// 外部依赖（GET /api/deps）：三件依赖的探测结果 + 建议动作 + 自装目录
  List<_DepEntry>? deps;
  String? depsError;
  bool depsLoading = true;
  /// 正在安装哪一件（按名字）：装的时候按钮转圈并禁用，避免连点两次装两遍
  String? depsInstalling;

  /// 内置协议端（GET /api/protocol-side）：配置 + 运行状态 + 装没装，一份自包含的视图。
  /// **刻意不阻塞首屏**（与 /api/deps 同一条理由）：它要读盘、探端口，卡片自己有三态。
  Map<String, dynamic>? protocolSide;
  String? protocolError;
  bool protocolLoading = true;
  /// 写入中（开关 / 目录 / 启停共用）：这期间把控件禁用，避免连点两次打两个请求
  bool protocolSaving = false;
  /// 启停中：与写入分开，因为它的回执是一句话（note），要单独弹给人看
  bool protocolBusy = false;
  /// 一键安装中（v35）：**这条端点是同步请求**，几秒到几十秒，期间按钮转忙并
  /// 连同这张卡上其它写动作一起按下去（详见 _protocolCardBusy 的说明）
  bool protocolInstalling = false;
  /// 这一次安装的结果（含过程记录与"装好之后"的引导；失败也留在卡上，不塞进 toast）
  _ProtocolInstall? protocolInstall;
  final _protocolDirCtl = TextEditingController();
  /// 目录的已存值快照（「保存」未改动即禁用）
  String protocolDirBase = '';

  /// 外部回调（B9）：`GET /api/webhook-secret` 的状态视图。
  ///
  /// **这里面没有明文**（也不该有）：服务端只报"配没配 + 那个非密钥的 id + 时刻"，
  /// 明文只在生成那一次的响应里出现，直接进 [showWebhookTokenDialog] 那张框，
  /// **一个字节都不落到本页的字段上**（不写 ui-state.json、不做"再看一眼"）。
  Map<String, dynamic>? webhookSecret;
  String? webhookError;
  bool webhookLoading = true;
  /// 生成/轮换中：按钮转忙并禁用（这条命令是写盘 + 落事件的，连点两次会连换两把钥匙）
  bool webhookRotating = false;
  /// 轮换之后留在卡上的那句话（**只放"上一份已失效"这类非密钥信息**，不含明文）
  String webhookRotatedNote = '';

  /// 发言节奏的速度输入（字/分钟）。开关是即时生效的，速度要按保存键——
  /// 数字框边打字边写盘会把 90 打成 9、再打成 900，那种"逐字符生效"没人想要。
  final _speakSpeedCtl = TextEditingController();
  bool _speakSaving = false;

  /// 系统卡的输入框：**key 就是 config.json 的点路径**，一张表管十格。
  /// 为什么数据驱动而不是十个具名 controller：脏判定、保存、回填三处都遍历同一张表，
  /// 少写一处就是"改了存不进去"或"存了却不显脏"。
  late final Map<String, TextEditingController> _sysCtls = {
    for (final field in _sysFields) field.path: TextEditingController(),
  };

  /// 生效值快照（文本形态）：与框里的文本逐字符比对——改回原值同样算不脏
  final Map<String, String> _sysBase = {};

  /// 正开着编辑态的行（行 id）。为什么是集合而不是一个"当前编辑行"：⑭ 起每一行**自包自足**
  /// ——点开一行不牵动别的行，取消也只丢这一行的草稿。若只留一个槽位，点开第二行时第一行的
  /// 草稿就得被无声丢掉，那是最难查的一类"我明明打了字"。
  final Set<String> _sysEditing = {};

  /// 系统卡写入中：这期间整张卡的写控件一起按下去（与发言卡同一条分寸）。
  /// 一个进程只有一条配置写通道，两条请求同时在飞没有好处。
  bool _sysSaving = false;

  late final Map<String, _LaneForm> _forms = {
    for (final id in _laneIds) id: _LaneForm(onChanged: _onFormChanged),
  };

  /// 右侧滚动区：锚点跳转与滚动联动都挂在它上面
  final _scroll = ScrollController();

  /// 内容根：分区顶边的相对坐标以它为基准
  final _contentKey = GlobalKey();

  /// 每个分区的定位 key（点击锚点即滚到这里）
  final Map<String, GlobalKey> _sectionKeys = {
    for (final anchor in _anchors) anchor.id: GlobalKey(),
  };

  /// 当前分区（只驱动锚点高亮，避免滚动时整页重建）
  final _active = ValueNotifier<String>(_anchors.first.id);

  /// 帧后合并：滚动通知每帧可能来多次，锚点高亮一帧只算一次
  bool _activePending = false;

  @override
  void initState() {
    super.initState();
    widget.state.addListener(_onStateChange);
    _scroll.addListener(_onScroll);
    _speakSpeedCtl.addListener(_onFormChanged);
    _protocolDirCtl.addListener(_onFormChanged);
    for (final ctl in _sysCtls.values) {
      ctl.addListener(_onFormChanged);
    }
    unawaited(load());
  }

  @override
  void dispose() {
    widget.state.removeListener(_onStateChange);
    _scroll.removeListener(_onScroll);
    _scroll.dispose();
    _active.dispose();
    _speakSpeedCtl.removeListener(_onFormChanged);
    _speakSpeedCtl.dispose();
    _protocolDirCtl.removeListener(_onFormChanged);
    _protocolDirCtl.dispose();
    for (final ctl in _sysCtls.values) {
      ctl.removeListener(_onFormChanged);
      ctl.dispose();
    }
    for (final form in _forms.values) {
      form.dispose();
    }
    super.dispose();
  }

  void _onStateChange() {
    if (widget.state.online && cfgError != null) unawaited(load());
  }

  void _onFormChanged() {
    if (mounted) setState(() {});
  }

  // ── 取数 ──

  Future<void> load() async {
    await Future.wait([
      _loadConfig(seed: true), _loadKeys(), _loadProjection(), _loadDeps(), _loadProtocolSide(),
      _loadWebhookSecret(),
    ]);
    if (mounted) setState(() => loading = false);
  }

  /// webhook 专用凭据的状态（GET /api/webhook-secret）。与依赖/协议端同一条纪律：
  /// **不阻塞首屏**、读失败只影响这张卡（卡片自己有三态），不把整页变成错误页。
  Future<void> _loadWebhookSecret() async {
    setState(() => webhookLoading = true);
    try {
      final data = await widget.state.api.get('/api/webhook-secret');
      if (!mounted) return;
      setState(() {
        webhookSecret = data is Map ? data.cast<String, dynamic>() : null;
        webhookError = data is Map ? null : '凭据状态读取失败（响应不是对象）';
        webhookLoading = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() {
          webhookError = '$err';
          webhookLoading = false;
        });
      }
    }
  }

  /// 协议端状态（GET /api/protocol-side）。与依赖报告一样**不阻塞首屏**：
  /// 没配它的机器上这条端点也要读盘、可能还要探端口，让"模型/密钥"等它没道理。
  ///
  /// 读失败**只影响这张卡**（protocolError 单独持有）：整页照常可用——
  /// 一张附加信息的卡读不到，不该把设置页变成错误页（v33 的框架提示卡同一条纪律）。
  Future<void> _loadProtocolSide() async {
    setState(() => protocolLoading = true);
    try {
      final data = await widget.state.api.get('/api/protocol-side');
      if (!mounted) return;
      final map = data is Map ? data.cast<String, dynamic>() : null;
      setState(() {
        protocolSide = map;
        protocolError = map == null ? '协议端状态读取失败（响应不是对象）' : null;
        protocolLoading = false;
      });
      if (map != null) _seedProtocolDir(_protocolField('dir'));
    } catch (err) {
      if (mounted) {
        setState(() {
          protocolError = '$err';
          protocolLoading = false;
        });
      }
    }
  }

  /// 目录输入框回填：**只在没有未保存改动时**覆盖——否则一次后台刷新会把人正在敲的路径冲掉
  void _seedProtocolDir(String dir) {
    if (!mounted) return;
    if (_protocolDirCtl.text.trim() != protocolDirBase.trim()) return;
    setState(() {
      protocolDirBase = dir;
      _protocolDirCtl.text = dir;
    });
  }

  /// 外部依赖报告。刻意**不阻塞**首屏：它要跑一次探测（没装的依赖要试几个候选），
  /// 让"模型/密钥"这些常用项等它没道理；卡片自己有三态。
  Future<void> _loadDeps() async {
    setState(() => depsLoading = true);
    try {
      final data = await widget.state.api.get('/api/deps');
      if (!mounted) return;
      final map = data is Map ? data.cast<String, dynamic>() : null;
      final rawList = map?['entries'];
      setState(() {
        deps = rawList is List ? [for (final item in rawList) _DepEntry.from(item)] : null;
        depsError = map == null
            ? '依赖报告读取失败'
            : (map['available'] == false ? map['reason']?.toString() : null);
        depsLoading = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() {
          depsError = '$err';
          depsLoading = false;
        });
      }
    }
  }

  Future<void> _loadConfig({bool seed = false}) async {
    try {
      // **读盘上那份**（`?source=saved`，2026-10-04 修）：设置页编辑的是"我保存下来的值"。
      // 默认那条 `/api/config` 给的是**进程启动时的生效配置**——保存成功后本页会立刻回读它
      // 并回填输入框，于是刚写下去的值当场被冲掉（用户报的「编辑后点保存，前端又会弹回
      // 默认的 url」，系统卡的「编辑」也一样）。盘上那份还多带一个 `$pending`：
      // 哪些字段与生效值不同（= 还没生效），本页据此把「需重启」说准。
      final data = await widget.state.api.get('/api/config?source=saved');
      if (!mounted) return;
      final raw = data is Map ? data.cast<String, dynamic>() : null;
      final pending = raw == null ? null : raw[r'$pending'];
      // `$pending` 是给这一页看的元信息，不是配置项：取出来之后就从文档里摘掉，
      // 免得它跟着 `_text('…')` 一类的点路径查找走（配置本体里没有以 `$` 开头的可读项）。
      final next = raw == null ? null : (Map<String, dynamic>.from(raw)..remove(r'$pending'));
      setState(() {
        cfg = next;
        pendingRestart = pending is Map && pending['restartRequired'] is List
            ? (pending['restartRequired'] as List).whereType<String>().toSet()
            : const <String>{};
        savedSource = pending is Map ? '${pending['source']}' : '';
        cfgError = null; // 非对象走 empty 态（配置不可用），异常才走 error 态
      });
      if (seed && next != null) _seedInputs();
    } catch (err) {
      if (mounted) setState(() => cfgError = '$err');
    }
  }

  /// 密钥状态单独一条：保存密钥后只刷它（掩码以服务端为准，本页不自己算一份）
  Future<void> _loadKeys() async {
    setState(() => keysLoading = true);
    try {
      final data = await widget.state.api.get('/api/keys');
      if (!mounted) return;
      setState(() {
        keys = data is Map ? data.cast<String, dynamic>() : null;
        keysError = data is Map ? null : '密钥状态读取失败';
        keysLoading = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() {
          keysError = '$err';
          keysLoading = false;
        });
      }
    }
  }

  Future<void> _loadProjection() async {
    try {
      final data = await widget.state.api.get('/api/projection');
      if (!mounted) return;
      setState(() {
        proj = data is Map ? data.cast<String, dynamic>() : null;
        projError = data is Map ? null : '运行数据读取失败';
      });
    } catch (err) {
      if (mounted) setState(() => projError = '$err');
    }
  }

  /// 用生效配置回填输入框并重记原始值（首次加载与保存成功后各一次；输入态不做双份状态）
  void _seedInputs() {
    for (final id in _laneIds) {
      _forms[id]!.seed(model: _text('models.$id.model'), baseUrl: _text('models.$id.baseUrl'));
    }
    final speed = _amount('speak.charsPerMinute');
    if (speed != '—') _speakSpeedCtl.text = speed;
    // 系统卡各格一起回填：seed 为真就是"盘上那份才算数"（与两条 lane 同一纪律）。
    // 唯一的例外是**正开着编辑态的那一行**：这次回填可能是别处触发的（另一行保存成功、
    // 连接恢复后重读配置），把人正在打的字冲掉属于最没道理的那种"正确"。那一行的草稿留着，
    // 只有它自己按下「保存」或「取消」才结束。
    for (final field in _sysFields) {
      final text = field.seed(cfg);
      _sysBase[field.path] = text;
      if (_sysEditingPaths.contains(field.path)) continue;
      _sysCtls[field.path]!.text = text;
    }
  }

  /// 正开着编辑态的那几格（点路径）：回填时跳过它们，草稿才留得住
  Set<String> get _sysEditingPaths =>
      {for (final id in _sysEditing) for (final field in _sysRowFields[id]!) field.path};

  /// 某一行有没有未保存的改动（逐格与盘上那份比：改回原值同样不算改）。
  /// 它是这一行「保存」键的开关——"未改动即禁用"是这一页的既有分寸，灰着本身就是一句话：
  /// 盘上就是这个值。
  bool _sysRowDirty(List<_SysField> fields) =>
      fields.any((field) => _sysText(field) != (_sysBase[field.path] ?? ''));

  /// 这一行的字段里，有没有"盘上已改、进程还没接管"的（判据来自服务端，本页不另算）
  bool _rowPending(List<_SysField> fields) =>
      fields.any((field) => pendingRestart.contains(field.path));

  /// 把某一行的框还原成盘上那份（「取消」与保存成功都走它）
  void _resetSysDraft(List<_SysField> fields) {
    for (final field in fields) {
      _sysCtls[field.path]!.text = _sysBase[field.path] ?? '';
    }
  }

  /// 某一格当前的文本（统一 trim：尾部空格是手滑，不是值）
  String _sysText(_SysField field) => _sysCtls[field.path]!.text.trim();

  // ── 写：模型名 / Base URL / 密钥 ──

  /// 保存本卡片的所有改动：模型字段走 config-update，密钥非空走 set-key。
  /// 只提交与生效配置不同的字段，多余的写入没有意义。
  Future<void> _save(String lane) async {
    final form = _forms[lane]!;
    final model = form.modelCtl.text.trim();
    final baseUrl = form.baseCtl.text.trim();
    final key = form.keyCtl.text.trim();

    final fields = <String, dynamic>{};
    if (form.modelDirty) {
      if (model.isEmpty) {
        _toast('模型名不能为空，未保存', kind: ToastKind.warn);
        return;
      }
      if (baseUrl.isEmpty) {
        _toast('Base URL 不能为空，未保存', kind: ToastKind.warn);
        return;
      }
      if (model != form.baseModel) fields['models.$lane.model'] = model;
      if (baseUrl != form.baseBaseUrl) fields['models.$lane.baseUrl'] = baseUrl;
    }
    if (fields.isEmpty && key.isEmpty) {
      _toast('没有需要保存的改动');
      return;
    }

    setState(() => form.saving = true);
    final written = <String>[];
    try {
      if (fields.isNotEmpty) {
        await widget.state.api
            .post('/api/commands/config-update', {'fields': fields}, confirm: 'config-update');
        written.add('模型设置');
      }
      if (key.isNotEmpty) {
        await widget.state.api
            .post('/api/commands/set-key', {'name': lane, 'value': key}, confirm: 'set-key');
        written.add('密钥');
      }
      if (!mounted) return;
      form.keyCtl.clear();
      if (fields.isNotEmpty) await _loadConfig(seed: true);
      if (key.isNotEmpty) await _loadKeys();
      if (!mounted) return;
      // 只有配置项需要重启接管；密钥写盘即刻可用，不跟着喊重启
      final restart = fields.isNotEmpty ? '，进程重启后生效' : '';
      _toast('已保存${written.join('与')}$restart', kind: ToastKind.success);
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => form.saving = false);
    }
  }

  /// 清除密钥：同一个 set-key 通道，空值 = 删除该键；环境变量里的值不受影响
  Future<void> _clearKey(String lane) async {
    // 危险操作统一走 ui_kit 的确认框：灰取消 / 红确认
    final confirmed = await confirm(
      context,
      title: '清除密钥 · ${_laneLabels[lane]}',
      body: '清除后需重新填写；来自环境变量的值不受影响。',
      confirmLabel: '清除',
      danger: true,
    );
    if (!confirmed || !mounted) return;

    final form = _forms[lane]!;
    setState(() => form.saving = true);
    try {
      await widget.state.api
          .post('/api/commands/set-key', {'name': lane, 'value': ''}, confirm: 'set-key');
      if (!mounted) return;
      _toast('已清除本地密钥', kind: ToastKind.success);
      await _loadKeys();
    } catch (err) {
      if (mounted) _toast('清除失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => form.saving = false);
    }
  }

  /// 提示条统一走 ui_kit 的全局单例 toast（docs/astrbot-ux-interaction.md §8 收口项）：
  /// 同一时刻只有一条，页面里不再自己 showSnackBar。
  void _toast(String text, {ToastKind kind = ToastKind.info}) {
    if (!mounted) return;
    IrmiaToast.show(context, text, kind: kind);
  }

  // ── 锚点定位 ──

  /// 当前滚动位（切宽窄布局时可能短暂挂载多个 position，取第一个）
  ScrollPosition? get _scrollPosition {
    if (!_scroll.hasClients || _scroll.positions.isEmpty) return null;
    return _scroll.positions.first;
  }

  /// 分区顶边在内容坐标系里的位置
  double? _sectionOffset(String id) {
    final target = _sectionKeys[id]?.currentContext;
    final origin = _contentKey.currentContext;
    if (target == null || origin == null) return null;
    final box = target.findRenderObject();
    final root = origin.findRenderObject();
    if (box is! RenderBox || root is! RenderBox) return null;
    return box.localToGlobal(Offset.zero, ancestor: root).dy;
  }

  /// 点锚点：把对应分区滚到滚动区顶部
  void _goTo(String id) {
    final position = _scrollPosition;
    final offset = _sectionOffset(id);
    if (position == null || offset == null) return;
    final target = offset.clamp(0.0, position.maxScrollExtent);
    if (_active.value != id) _active.value = id;
    _scroll.animateTo(target.toDouble(), duration: IrmiaTheme.durPage, curve: Curves.easeOutCubic);
  }

  void _onScroll() {
    if (_activePending) return;
    _activePending = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _activePending = false;
      if (mounted) _refreshActiveAnchor();
    });
  }

  /// 滚动联动高亮：取最后一个顶边越过判定带的分区；到底则钉住最后一个
  ///
  /// `_sectionOffset` 给的是**内容坐标**（相对滚动内容根），所以判定线要换算到同一个坐标系：
  /// `position.pixels + _activeBand`。原来这里直接拿 `top` 与 `_activeBand` 比，
  /// 于是只有第一个分区（top ≈ 0）恒满足，高亮永远钉在「模型」上——用户 ⑩ 的那个现象。
  void _refreshActiveAnchor() {
    final position = _scrollPosition;
    if (position == null) return;
    var current = _anchors.first.id;
    final last = _anchors.last;
    if (position.maxScrollExtent > 0 && position.pixels >= position.maxScrollExtent - 1) {
      current = last.id;
    } else {
      final line = position.pixels + _activeBand;
      for (final anchor in _anchors) {
        final top = _sectionOffset(anchor.id);
        if (top != null && top <= line) current = anchor.id;
      }
    }
    if (_active.value != current) _active.value = current;
  }

  // ── 骨架 ──

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const PageHeader(title: '设置', subtitle: '模型密钥、界面偏好、发言节奏与系统参数'),
        Expanded(child: _pane()),
      ],
    );
  }

  /// 四态：loading（首次拉取）/ error（读取失败）/ empty（没返回配置本体）/ data。
  /// 前三态没有可跳转的分区，锚点栏随之隐藏，只留一条滚动区承载提示与重试。
  Widget _pane() {
    if (loading && cfg == null) {
      return _scrolling(const [StateBlock.loading(hint: '正在读取配置…')], left: 0);
    }
    if (cfgError != null && cfg == null) {
      return _scrolling([
        StateBlock.error(
          message: '配置读取失败：$cfgError',
          hint: '模型密钥与系统信息需要生效配置才能显示。请确认主进程已启动。',
          onRetry: () => unawaited(load()),
        ),
      ], left: 0);
    }
    if (cfg == null) {
      return _scrolling([
        StateBlock.empty(
          icon: Icons.settings_suggest_outlined,
          message: '配置不可用。',
          hint: '本地服务 /api/config 未返回配置内容。',
          action: StateBlock.cta('重试', () => unawaited(load())),
        ),
      ], left: 0);
    }
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < _railBreakpoint) {
          // 窄窗：锚点降级为顶部横条，不占正文宽度
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(26, 2, 26, 8),
                child: _anchorStrip(),
              ),
              Expanded(child: _scrolling(_sections())),
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(width: 26),
            Padding(padding: const EdgeInsets.only(top: 16), child: _anchorRail()),
            const SizedBox(width: 18),
            Expanded(child: _scrolling(_sections(), left: 0)),
          ],
        );
      },
    );
  }

  List<Widget> _sections() {
    return [
      _sectionBlock('model', [
        _laneCard('heavy'),
        const SizedBox(height: 12),
        _laneCard('light'),
        const SizedBox(height: 10),
        if (keysError != null)
          _footnote('密钥状态读取失败（$keysError）。密钥徽章不可用，模型名与 Base URL 仍可保存。'),
        if (savedSource == 'memory')
          _footnote('读不到 config.json，这一页显示的是当前生效的那份（保存仍会写进文件）。'),
        if (pendingRestart.any((path) => path.startsWith('models.')))
          _footnote('上面有改动还没生效：模型名与端点是启动参数，要重启进程才接管——'
              '在那之前跑的还是启动时那份。保存本身是成功的，框里显示的就是盘上那份。'),
        _footnote('密钥只写不读：本页显示的始终是掩码，完整值仅在建立连接时读取一次。'
            '保存写入 config.json 与 data/.keys.json，进程重启后接管（环境变量优先于文件）。'),
      ]),
      const SizedBox(height: 18),
      _sectionBlock('ui', [_uiCard()]),
      const SizedBox(height: 18),
      _sectionBlock('speak', [_speakCard()]),
      const SizedBox(height: 18),
      _sectionBlock('deps', [_depsCard()]),
      const SizedBox(height: 18),
      _sectionBlock('protocol', [_protocolCard()]),
      const SizedBox(height: 18),
      _sectionBlock('webhook', [_webhookCard()]),
      const SizedBox(height: 18),
      _sectionBlock('memory', [_memoryCard()]),
      const SizedBox(height: 18),
      // 信任范围紧挨在「系统」之前：她是"这个人能碰多远"，系统是"这个进程怎么起来"
      _sectionBlock('trust', [_trustCard()]),
      const SizedBox(height: 18),
      _sectionBlock('system', [_systemCard()]),
      const SizedBox(height: 18),
      _sectionBlock('account', [_accountCard()]),
      const SizedBox(height: 18),
      _sectionBlock('about', [_aboutCard()]),
    ];
  }

  /// 分区块：定位 key 挂在这里，锚点跳转与滚动联动都以它为准
  Widget _sectionBlock(String id, List<Widget> children) {
    return Column(
      key: _sectionKeys[id],
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  Widget _scrolling(List<Widget> children, {double left = 26}) {
    return RefreshIndicator(
      onRefresh: load,
      child: SingleChildScrollView(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.fromLTRB(left, 16, 26, 30),
        child: Column(
          key: _contentKey,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      ),
    );
  }

  // ── 锚点栏 ──

  Widget _anchorRail() {
    return SizedBox(
      width: _railWidth,
      child: ValueListenableBuilder<String>(
        valueListenable: _active,
        builder: (context, active, _) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Padding(
              padding: EdgeInsets.only(left: 12, bottom: 8),
              child: _AnchorCaption(),
            ),
            for (final anchor in _anchors) _anchorTile(anchor, active == anchor.id),
          ],
        ),
      ),
    );
  }

  /// 窄窗：同一批锚点摊成一行，横向可滚
  Widget _anchorStrip() {
    return ValueListenableBuilder<String>(
      valueListenable: _active,
      builder: (context, active, _) => SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final anchor in _anchors) ...[
              if (anchor != _anchors.first) const SizedBox(width: 6),
              _anchorChip(anchor, active == anchor.id),
            ],
          ],
        ),
      ),
    );
  }

  Widget _anchorTile(_Anchor anchor, bool active) {
    final scheme = Theme.of(context).colorScheme;
    final tone = active ? scheme.primary : scheme.onSurfaceVariant;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Material(
        color: active ? scheme.primary.withValues(alpha: 0.08) : Colors.transparent,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: InkWell(
          onTap: () => _goTo(anchor.id),
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(anchor.icon, size: 17, color: tone),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    anchor.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13.5,
                      fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                      color: tone,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _anchorChip(_Anchor anchor, bool active) {
    final scheme = Theme.of(context).colorScheme;
    final tone = active ? scheme.primary : scheme.onSurfaceVariant;
    return Material(
      color: active ? scheme.primary.withValues(alpha: 0.08) : Colors.transparent,
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      child: InkWell(
        onTap: () => _goTo(anchor.id),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(anchor.icon, size: 16, color: tone),
              const SizedBox(width: 8),
              Text(
                anchor.label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: active ? FontWeight.w600 : FontWeight.w400,
                  color: tone,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  // ── 分区一：模型（可写） ──

  Widget _laneCard(String lane) {
    final scheme = Theme.of(context).colorScheme;
    final form = _forms[lane]!;
    final envName = _text('models.$lane.apiKeyEnv');
    final keyState = _keyState(lane);
    final keyLook = secretLook(
      context,
      configured: keyState.configured,
      hintFontSize: 13,
      base: InputDecoration(hintText: keyState.configured ? '已配置；粘贴新密钥可覆盖' : 'sk-…'),
    );

    return _SectionCard(
      title: _laneLabels[lane]!,
      note: _laneNotes[lane]!,
      trailing: Text('models.$lane', style: _mono(11.5, scheme.onSurfaceVariant)),
      children: [
        _FieldPair(
          cells: [
            _FieldCell(
              label: '模型名',
              field: TextField(
                controller: form.modelCtl,
                autocorrect: false,
                enableSuggestions: false,
                style: const TextStyle(fontSize: 13),
                decoration: const InputDecoration(hintText: 'deepseek-chat'),
              ),
            ),
            _FieldCell(
              label: 'Base URL',
              field: TextField(
                controller: form.baseCtl,
                autocorrect: false,
                enableSuggestions: false,
                style: const TextStyle(fontSize: 13),
                decoration: const InputDecoration(hintText: 'https://api.deepseek.com'),
              ),
              note: 'API 根地址，不含 /responses。',
            ),
          ],
        ),
        const SizedBox(height: 12),
        _FieldCell(
          label: 'API Key',
          field: Row(
            children: [
              Expanded(
                child: TextField(
                  controller: form.keyCtl,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  style: const TextStyle(fontSize: 13),
                  // 已配置时的样子（蓝、居中）与渠道页的密钥格共用一份：ui_kit 的 secretLook
                  textAlign: keyLook.textAlign,
                  decoration: keyLook.decoration,
                ),
              ),
              const SizedBox(width: 10),
              _keyBadge(keyState),
            ],
          ),
          note: '环境变量 $envName 优先；它没有值时使用此处的值（写入 data/.keys.json，只写不读）。',
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            if (keyState.configured)
              TextButton(
                onPressed: form.saving ? null : () => unawaited(_clearKey(lane)),
                style: TextButton.styleFrom(
                  foregroundColor: IrmiaTheme.danger,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  minimumSize: const Size(0, 36),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: const Text('清除密钥'),
              ),
            const Spacer(),
            // 未改动即禁用（ProviderPage.vue:78-90）；脏时紧挨按钮给一句状态
            if (form.dirty) ...[
              const DirtyPill(),
              const SizedBox(width: 10),
            ],
            FilledButton(
              onPressed: (form.dirty && !form.saving) ? () => unawaited(_save(lane)) : null,
              style: _btnStyle(context),
              child: form.saving
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('保存'),
            ),
          ],
        ),
      ],
    );
  }

  /// 某个受管键的状态（形状严格照 GET /api/keys 的契约：{configured, mask}）
  ({bool configured, String? mask}) _keyState(String lane) {
    final raw = keys?[lane];
    if (raw is! Map) return (configured: false, mask: null);
    final mask = raw['mask'];
    return (configured: raw['configured'] == true, mask: mask is String ? mask : null);
  }

  /// 密钥徽章：只有掩码，没有完整值
  Widget _keyBadge(({bool configured, String? mask}) state) {
    if (keysLoading && keys == null) {
      return Text(
        '读取中…',
        style: TextStyle(fontSize: 11.5, color: Theme.of(context).colorScheme.onSurfaceVariant),
      );
    }
    if (keysError != null && keys == null) return _badge('状态读取失败', IrmiaTheme.warn);
    if (!state.configured) return _badge('未配置', Theme.of(context).colorScheme.onSurfaceVariant);
    return _badge('已配置 ${state.mask ?? '…'}', IrmiaTheme.ok);
  }

  // ── 分区二：界面（可写） ──

  /// 「界面」卡：主题偏好 + **关窗行为**。
  ///
  /// 2026-10-04 加的「关窗时收进托盘」是**界面自己的偏好**（键 `close-to-tray`，
  /// 落在 `%APPDATA%/Irmia/ui-state.json`，与主题一样**不写服务端配置**）：
  /// 关不关窗是窗口的事，与服务端那份 config.json 无关。默认 false——
  /// 理由写在 ui_state.dart 的 [kCloseToTrayFlag] 上（她是独立进程，关窗不影响她运行；
  /// 而"藏起来"在托盘图标不可见时就是个陷阱）。
  ///
  /// 这里**不摆"需重启"**：开关本身立刻写盘，下次启动由 main.dart 读；
  /// 而且它在同一次运行里也已经生效（窗口关闭回调读的是内存镜像，见 ui_state 的 [closeToTray]）。
  Widget _uiCard() {
    final scheme = Theme.of(context).colorScheme;
    final mode = widget.state.themeMode;
    return _SectionCard(
      title: '界面',
      note: '主题偏好与关窗行为；仅本地生效，不写入配置。',
      trailing: Text('即时生效', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
      children: [
        _FieldCell(
          label: '明暗模式',
          field: Align(
            alignment: Alignment.centerLeft,
            child: SegmentedButton<ThemeMode>(
              segments: const [
                ButtonSegment(value: ThemeMode.light, label: Text('亮')),
                ButtonSegment(value: ThemeMode.dark, label: Text('暗')),
              ],
              selected: {mode},
              showSelectedIcon: false,
              style: SegmentedButton.styleFrom(
                visualDensity: VisualDensity.compact,
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              onSelectionChanged: (picked) {
                final next = picked.first;
                if (widget.state.themeMode != next) widget.state.toggleTheme();
              },
            ),
          ),
          note: '仅本地偏好，即时生效；不写入配置、不影响渲染指纹。',
        ),
        const SizedBox(height: 12),
        _FieldCell(
          label: '关窗时收进托盘（不退出界面）',
          field: Align(
            alignment: Alignment.centerLeft,
            child: ValueListenableBuilder<bool>(
              valueListenable: closeToTray,
              builder: (context, enabled, _) => Switch(
                key: const ValueKey('close-to-tray'),
                value: enabled,
                onChanged: (next) => unawaited(setCloseToTray(next)),
              ),
            ),
          ),
          // 后果要写清：托盘图标在 Windows 11 上默认被收进"隐藏的图标"面板，
          // 那时"关窗"就等于"界面不见了"——这正是用户踩过两次的那个坑。
          note: '托盘图标若被系统收进"隐藏的图标"面板，关窗后会找不到界面；'
              '关掉此项则点 × 直接退出（她照常运行）。',
        ),
        const SizedBox(height: 12),
        _readOnlyRow('当前主题', mode == ThemeMode.dark ? '暗' : '亮', restart: false),
      ],
    );
  }

  // ── 分区三：发言（可写） ──
  /// 发言节奏：她说话时拆成几条、每条之间隔多久。
  ///
  /// 写的是 `config.speak`（typingEffect / charsPerMinute），两者都要重启才接管——
  /// 它们是**工具装配参数**（admin 工具在启动时构造），不是每拍现读的运行期开关。
  Widget _speakCard() {
    final scheme = Theme.of(context).colorScheme;
    final typing = _at(cfg, 'speak.typingEffect') == true;
    final saved = _amount('speak.charsPerMinute');
    final dirty = saved != '—' && _speakSpeedCtl.text.trim() != saved;
    return _SectionCard(
      title: '发言',
      note: '她说话时的节奏：一条条往外蹦、每条之间隔多久。只影响投递手感，不影响说话内容。',
      trailing: dirty ? const DirtyPill() : null,
      children: [
        _FieldCell(
          label: '打字节奏',
          field: Switch(
            value: typing,
            onChanged: _speakSaving ? null : (next) => unawaited(_saveSpeakTyping(next)),
          ),
          note: '开着：按“这段话要打多久”逐条发出，像人在打字（对方也随时能插话打断）。'
              '关掉：一次发完，内容尽快到手。',
        ),
        const SizedBox(height: 12),
        _FieldCell(
          label: '打字速度',
          field: Row(
            children: [
              SizedBox(
                width: 92,
                child: TextField(
                  controller: _speakSpeedCtl,
                  enabled: !_speakSaving,
                  keyboardType: TextInputType.number,
                  // 不给 border：原来这里写了一句 `border: OutlineInputBorder()`，而它默认半径 4——
                  // 与主题的 8 不是一个数（实际生效的是主题的 enabledBorder，那句是死的）。
                  // 控件圆角统一由主题给（用户 ⑧），这里不再自报一个数。
                  decoration: const InputDecoration(
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text('字/分钟', style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
              const SizedBox(width: 12),
              FilledButton(
                onPressed: dirty && !_speakSaving ? () => unawaited(_saveSpeakSpeed()) : null,
                child: const Text('保存'),
              ),
            ],
          ),
          note: '默认 90（中文手机输入的常见速度）。调大说得更快、等待更短；范围 30~600。',
        ),
        const SizedBox(height: 12),
        _readOnlyRow(
          '当前生效',
          saved == '—' ? '—' : (typing ? '$saved 字/分钟 · 逐条发' : '$saved 字/分钟 · 一次发完'),
          restart: true,
        ),
      ],
    );
  }

  Future<void> _saveSpeakTyping(bool value) async {
    setState(() => _speakSaving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {
          'fields': {'speak.typingEffect': value},
        },
        confirm: 'config-update',
      );
      await _loadConfig(seed: true);
      if (!mounted) return;
      _toast(value ? '已开启打字节奏（重启后接管）' : '已关闭打字节奏（重启后接管）');
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.warn);
    } finally {
      if (mounted) setState(() => _speakSaving = false);
    }
  }

  Future<void> _saveSpeakSpeed() async {
    final value = int.tryParse(_speakSpeedCtl.text.trim());
    if (value == null || value < 30 || value > 600) {
      _toast('打字速度要在 30~600 之间', kind: ToastKind.warn);
      return;
    }
    setState(() => _speakSaving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {
          'fields': {'speak.charsPerMinute': value},
        },
        confirm: 'config-update',
      );
      await _loadConfig(seed: true);
      if (!mounted) return;
      _toast('已保存（重启后接管）');
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.warn);
    } finally {
      if (mounted) setState(() => _speakSaving = false);
    }
  }

  /// 保存**这一行**：一条请求，body 里只有这一行的字段（用户 ⑭："只写这一行"）。
  ///
  /// 与 ⑪ 那版的差别只在粒度：那次是"一条请求带上整张卡改过的字段"，理由是服务端一条
  /// `config-update` 内部是"读→改→写→复核"的临界区，怕半新半旧的配置落盘。逐行之后
  /// 这个理由仍然成立而且更硬了——一行就是一次完整、自洽的改动（监听地址那行的两半一起写，
  /// 它们本来就是同一个 listen 调用的两个参数），**不存在"半行"这种可写状态**。
  ///
  /// 校验**先于请求**，与 ⑪ 一字不差（同一批 `problem()` 文案）：非法值当场拦下、一个字节
  /// 都不写，并且**留在编辑态**——人就在那个框上，改完再按一次就行。
  Future<void> _saveSysRow(String id, List<_SysField> fields) async {
    final changed = <String, dynamic>{};
    for (final field in fields) {
      final text = _sysText(field);
      if (text == (_sysBase[field.path] ?? '')) continue; // 没变的字段不写
      final problem = field.problem(text);
      if (problem != null) {
        _toast(problem, kind: ToastKind.warn);
        return;
      }
      changed[field.path] = field.decode(text);
    }
    if (changed.isEmpty) return; // 保存键本来就是灰的，这里只是兜底

    setState(() => _sysSaving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {'fields': changed},
        confirm: 'config-update',
      );
      // 保存成功后回读生效配置（服务端可能归一化过值），这一行退出编辑态、按盘上那份回填。
      // 别的行若正开着，草稿留着（见 _seedInputs 与 _sysEditing 的说明）。
      await _loadConfig(seed: true);
      if (!mounted) return;
      setState(() {
        _resetSysDraft(fields);
        _sysEditing.remove(id);
      });
      _toast('已保存，重启后生效', kind: ToastKind.success);
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => _sysSaving = false);
    }
  }

  // ── 分区四：外部依赖（可写：一键安装） ──

  /// 外部依赖卡片（v30）。用户点名的两件事都在这张卡上：
  ///   ① **显式告知建议安装**——未安装时不止说"没装"，还要说清"没有它会怎样"（impact 那一行）；
  ///   ② **框架里自动安装配置**——能一键装的给「安装」，只能人去装的给「打开下载页」。
  ///
  /// 状态徽章三态与后端 status 一一对应（已就绪 / 未安装 / 版本不符）：
  /// "版本不符"必须与"未安装"分开——前者该升级、后者该安装，合成一句话会让人去装一个已经装了的东西。
  Widget _depsCard() {
    final entries = deps;
    final missing = entries?.where((entry) => !entry.ready).toList() ?? const <_DepEntry>[];
    // 卡头汇总：**建议安装**是用户点名要显式说出来的那句话，所以它不只是颜色，还带数字。
    // 读不到报告时**不给任何汇总**——"全部就绪"这种乐观结论在没有数据的时候就是撒谎。
    final summary = depsError != null
        ? null
        : (entries == null
            ? (depsLoading ? '读取中…' : null)
            : (missing.isEmpty ? '全部就绪' : '建议安装 ${missing.length} 项'));
    return _SectionCard(
      title: '外部依赖',
      // 用户 ⑨ 指定的新副标题
      note: '建议安装的外部依赖，可由框架一键安装。',
      trailing: summary == null
          ? null
          : _badge(summary, missing.isEmpty ? IrmiaTheme.ok : IrmiaTheme.warn),
      children: [
        if (depsError != null)
          _footnote('依赖报告读取失败（$depsError）。装不了也看不见状态时，先在命令行确认主进程已启动。'),
        if (entries == null && depsError == null)
          _footnote('正在探测本机的 pwsh / ripgrep / es.exe …'),
        for (final entry in entries ?? const <_DepEntry>[]) ...[
          _depRow(entry),
          const SizedBox(height: 10),
        ],
        if (entries != null && entries.isNotEmpty)
          // 用户 ⑨：删掉"（报告里的 managedDir 就是它）"——那是给实现者看的对应关系
          _footnote('安装位置：<数据目录>/tools/<名字>/。'
              '装完立即生效——探测结论会在安装后复检并刷新，下一次工具调用用的就是新引擎。'),
      ],
    );
  }

  /// 一件依赖一行：名字 + 状态徽章 + 动作按钮；下面两行灰字是"它是干什么的 / 没有它会怎样"。
  Widget _depRow(_DepEntry entry) {
    final scheme = Theme.of(context).colorScheme;
    final busy = depsInstalling == entry.name;
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(entry.label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
              ),
              _depBadge(entry),
              const SizedBox(width: 10),
              ..._depActions(entry, busy: busy),
            ],
          ),
          const SizedBox(height: 6),
          // 就绪时给"探测到的路径与版本"；没就绪时给"试过哪几处"——前者是事实，后者是下一步
          Text(
            entry.ready
                ? '${entry.version.isEmpty ? '版本未知' : entry.version} · ${entry.path}'
                : (entry.manualHint ?? entry.reason),
            style: _mono(11.5, scheme.onSurfaceVariant),
          ),
          const SizedBox(height: 4),
          Text(
            entry.ready ? entry.purpose : '${entry.purpose}。${entry.impact}',
            style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  /// 状态徽章：三态三色。字面口径与后端一致（"版本不符"不是"未安装"）
  Widget _depBadge(_DepEntry entry) {
    if (entry.ready) return _badge('已就绪', IrmiaTheme.ok);
    if (entry.mismatch) return _badge('版本不符', IrmiaTheme.danger);
    return _badge('未安装', IrmiaTheme.warn);
  }

  /// 行尾动作：可一键装的给「安装」，只能人去装的给「打开下载页」。
  /// 已就绪的行**什么都不给**——一枚按下去只会重复劳动的按钮比不摆更糟。
  List<Widget> _depActions(_DepEntry entry, {required bool busy}) {
    if (entry.ready) {
      return const [
        Text('无需操作', style: TextStyle(fontSize: 11.5, color: IrmiaTheme.ok)),
      ];
    }
    if (busy) {
      return const [
        SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
        SizedBox(width: 8),
        Text('安装中…', style: TextStyle(fontSize: 12)),
      ];
    }
    final installing = depsInstalling != null;
    if (entry.installable) {
      return [
        FilledButton(
          onPressed: installing ? null : () => unawaited(_installDep(entry)),
          style: _btnStyle(context),
          child: const Text('安装'),
        ),
        if (entry.downloadPage != null) ...[
          const SizedBox(width: 6),
          TextButton(
            onPressed: installing ? null : () => unawaited(_openDownloadPage(entry)),
            style: TextButton.styleFrom(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              minimumSize: const Size(0, 36),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: const Text('下载页'),
          ),
        ],
      ];
    }
    return [
      FilledButton.tonal(
        onPressed: installing ? null : () => unawaited(_openDownloadPage(entry)),
        style: FilledButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          minimumSize: const Size(0, 36),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: const Text('打开下载页'),
      ),
    ];
  }

  /// 一键安装：**先确认再动手**。
  ///
  /// 为什么要确认：这一步会从网上下一个可执行文件放进数据目录，之后 agent 会真的调用它——
  /// 它比"改一个配置项"更接近能力边界（服务端也按危险操作登记了 X-Confirm: dep-install）。
  /// 确认框里写清三件事：装什么、从哪来、装到哪。
  Future<void> _installDep(_DepEntry entry) async {
    final confirmed = await confirm(
      context,
      title: '安装 ${entry.label}',
      body: '会从官方地址下载压缩包并解压到 ${entry.managedDir}，然后立即复检。'
          '装好后 agent 就能用它（rg_search / es_search 会随之注册）。',
      confirmLabel: '下载并安装',
    );
    if (!confirmed || !mounted) return;

    setState(() => depsInstalling = entry.name);
    try {
      final data = await widget.state.api.post(
        '/api/commands/dep-install',
        {'name': entry.name},
        confirm: 'dep-install',
      );
      final map = data is Map ? data.cast<String, dynamic>() : const <String, dynamic>{};
      if (!mounted) return;
      if (map['ok'] == true) {
        _toast('${entry.label} 已就绪（${map['version'] ?? ''}）', kind: ToastKind.success);
      } else {
        // 三种失败分开说：下载 / 解压 / 复检各有各的下一步，合成一句"安装失败"等于没说
        _toast('${_stepLabel(map['step'])}：${map['error'] ?? '未知原因'}', kind: ToastKind.error);
      }
    } catch (err) {
      if (mounted) _toast('安装请求失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) {
        setState(() => depsInstalling = null);
        await _loadDeps();
      }
    }
  }

  /// 安装失败的阶段名（服务端的 step 字段）。三条路的处置完全不同：
  /// 网络问题重试、包不对换源、复检不过看杀毒软件。
  String _stepLabel(Object? step) {
    switch (step?.toString()) {
      case 'download':
        return '下载失败';
      case 'extract':
        return '解压失败';
      case 'verify':
        return '装完复检没通过';
      default:
        return '安装失败';
    }
  }

  /// 打开官方下载页（pwsh 这条路只能人工装：MSI/winget 要提权，无人值守进程里弹 UAC 只会卡住）。
  ///
  /// 实现用 `Process.run` 调系统默认浏览器，而不是引 url_launcher：这个 GUI 是零第三方依赖的
  /// 桌面壳，多一个包只为打开一个链接不划算（与 extensions_page 里"不摆按不出结果的按钮"
  /// 是同一条取舍——只不过这里我们自己实现得了）。
  Future<void> _openDownloadPage(_DepEntry entry) async {
    final url = entry.downloadPage;
    if (url == null) {
      _toast('这一项没有下载页；装法：${entry.manualHint ?? '见官方文档'}', kind: ToastKind.warn);
      return;
    }
    await _openUrl(url, hint: entry.manualHint);
  }

  /// 用系统默认浏览器打开一个外链。打不开就**把地址说出来**——那是唯一不靠外部程序
  /// 也能让人拿到它的方式（协议端的下载页与登录界面都走这里）。
  Future<void> _openUrl(String url, {String? hint}) async {
    try {
      if (Platform.isWindows) {
        await Process.run('cmd', ['/c', 'start', '', url], runInShell: true);
      } else if (Platform.isMacOS) {
        await Process.run('open', [url]);
      } else {
        await Process.run('xdg-open', [url]);
      }
      if (mounted) _toast('已用默认程序打开 $url');
    } catch (err) {
      if (mounted) {
        _toast('打不开浏览器，地址是 $url${hint == null ? '' : '（$hint）'}', kind: ToastKind.warn);
      }
    }
  }

  // ── 分区六：协议端（可选开启的内置服务，v34） ──

  /// 内置协议端卡片：**第二条独立的入站通道**（OneBot，背后是一个真实 QQ 号）。
  ///
  /// 它与官方 Bot 各是一个独立的消息适配器，**互不依赖**（2026-10-02 用户澄清）：
  /// 官方那条在平台上开了「接收所有消息」之后，群里谁说话也推得到（同一个订阅位，
  /// 见 docs/review.md 的「已了结」一节）；这条的长处是走客户端协议、背后有一个真实 QQ 号
  /// 的社交圈，不受开放平台的沙箱与审核限制。装不装都不影响另一条。
  ///
  /// 但它**可选**，三条形态纪律都是为这件事服务的：
  ///   · **读不到只灰这张卡**：`StateBlock.error` + 重试，其余分区照常；
  ///   · **"没配置"不是错误**：那是这台机器还没决定要不要开它——空态旁边**必须留着控件**，
  ///     否则人就没有地方可填（空态最忌讳的就是把出路一起藏起来）；
  ///   · **读失败时不给写入控件**：开关、目录、以及 v35 的「一键安装」都以"当前值"为前提，
  ///     读不到就在盲写——宁可让人先点重试，也不要替他猜一个 `enabled` 出来。
  ///
  /// 开关与目录都写 `config.json`，而协议端实例是**启动时**按那份配置建的，
  /// 所以卡上要显式摆出「需重启」——服务端回的 `restartRequired` 直接显示，本页不另算一份。
  ///
  /// v35 把主路径压成一句话：**点「一键安装」→ 框架装好并顺手把配置写好 → 重启 → 扫码**。
  /// 前两步框架能做（代下载 + 写一次配置），后两步做不了（重启是危险动作、扫码要人拿手机），
  /// 所以卡上给的是"做完前两步之后的引导"，而不是替人做后两步。
  Widget _protocolCard() {
    final scheme = Theme.of(context).colorScheme;
    final data = protocolSide;
    final restartRequired = data?['restartRequired'] == true;
    final state = _protocolField('state');
    final stateText = _protocolField('stateText');
    final configured = data?['configured'] == true;
    final install = protocolInstall;

    // 卡头汇总：读不到就**什么都不说**（没有数据时的"已就绪"就是撒谎，v30 同一条纪律）。
    // 状态徽章只在这里摆一枚——状态行里再摆一枚就是同一句话说两遍（与「外部依赖」卡同构：
    // 汇总在卡头，明细在行里）。
    final Widget? trailing = (protocolError != null || data == null)
        ? null
        : Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (configured) ...[
                _badge(stateText.isEmpty ? '未知' : stateText, _protocolTone(state)),
                if (restartRequired) const SizedBox(width: 6),
              ],
              if (restartRequired)
                _badge('需重启', IrmiaTheme.warn)
              else if (!configured)
                _badge('未配置', scheme.onSurfaceVariant),
            ],
          );

    return _SectionCard(
      title: '协议端（可选）',
      // 2026-10-02 用户澄清：官 bot 开了「接收所有消息」之后，群聊场景它自己就能覆盖，
      // 所以这里**不再把 SnowLuma 说成"群聊场景的建议"**——两条通道各是一个独立的消息适配器
      note: '可选：由框架拉起的 OneBot 协议端，背后是一个真实 QQ 号。'
          '它与官方 Bot 各是一条独立的入站通道，装不装都不影响另一条。',
      trailing: trailing,
      children: [
        if (protocolError != null)
          StateBlock.error(
            message: '协议端状态读取失败：$protocolError',
            hint: '这张卡读不到不影响其它设置。先确认主进程已启动，再点重试；'
                '在读到状态之前，这里不提供开关、目录与一键安装——那等于让你在看不到当前值的情况下写它。',
            onRetry: () => unawaited(_loadProtocolSide()),
          )
        else if (data == null)
          const StateBlock.loading(hint: '正在读取协议端状态…')
        else ...[
          if (!configured)
            StateBlock.empty(
              icon: Icons.hub_outlined,
              message: '还没配置内置协议端。',
              // 原来的后半句是"要收群里的全量消息，点下面的「一键安装」"——那建立在"官 bot 收不到
              // 群消息"的错判上（见 docs/review.md 的「已了结」）。现在这句只讲这条路自己。
              hint: '不开也照常用：官方 Bot 那条通道不受影响。'
                  '要用这条路，点下面的「一键安装」把装与配一次做完。',
            )
          else
            _protocolStatusRow(state),
          const SizedBox(height: 14),
          // 主路径（v35）：装 + 配一次点完。手填目录那条路留在它下面——它是备选，不是主路
          _protocolInstallBlock(install),
          const SizedBox(height: 14),
          _FieldCell(
            label: '启用内置协议端',
            field: Switch(
              // key 是给测试与无障碍用的：本页不止一个开关（「发言」那张卡也有），
              // 按类型取会拿到"页面上的第几个"这种一改布局就失效的定位
              key: const ValueKey('protocol-side-enabled'),
              value: data['enabled'] == true,
              onChanged: _protocolCardBusy ? null : (next) => unawaited(_saveProtocolEnabled(next)),
            ),
            // 用户 ⑨ 指定的新副标题
            note: '框架启动时自动连接；关闭后可在双端手动填写和配置。',
          ),
          const SizedBox(height: 14),
          _FieldCell(
            label: '安装目录',
            field: Row(
              children: [
                Expanded(
                  child: TextField(
                    key: const ValueKey('protocol-side-dir'),
                    controller: _protocolDirCtl,
                    enabled: !_protocolCardBusy,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: _mono(12.5, scheme.onSurface),
                    decoration: const InputDecoration(hintText: r'<协议端安装目录>'),
                  ),
                ),
                const SizedBox(width: 10),
                // 备选路径，所以是 tonal 而不是主色：主路径是上面那个「一键安装」——
                // 同一种填充色摆在两处，人分不出哪个才是该点的那个（v35 的分寸之一）
                FilledButton.tonal(
                  onPressed:
                      _protocolDirDirty && !_protocolCardBusy ? () => unawaited(_saveProtocolDir()) : null,
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    minimumSize: const Size(0, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text('保存目录'),
                ),
              ],
            ),
            // 用户 ⑨：这段原来口语化（"以后的人就得先猜它相对谁""我自己下载解压"），
            // 改成技术说明——只留填这一格真正要知道的两件事：填哪一层、谁来填
            note: '协议端安装目录（绝对路径）。Lite 包解压后入口 index.mjs 就在这一层，'
                '没有 dist/ 子目录；「一键安装」会自动填好。',
          ),
          const SizedBox(height: 10),
          _protocolDownloadGuide(),
          if (restartRequired) ...[
            const SizedBox(height: 10),
            _restartNote(),
          ],
        ],
      ],
    );
  }

  /// 这张卡上"有写在飞"的总闸：保存 / 启停 / 一键安装三者任一在跑，其余写动作一律按下。
  ///
  /// 为什么安装要连启停一起按：安装会把 `<数据目录>/services/snowluma` **整段清空重写**
  /// （解压器先清目标目录，那是有意的：升级该是一次干净落地）。这期间去启停一个正从那个目录
  /// 跑着的实例，两件事都能弄坏——而坏的样子（文件半新半旧、进程握着被换掉的文件）极难查。
  bool get _protocolCardBusy => protocolSaving || protocolBusy || protocolInstalling;

  /// 「一键安装」那一块：主按钮 + 它到底做了什么 + 这一次的结果。
  ///
  /// 它是这张卡上**唯一的主色填充按钮**（「保存目录」与「打开下载页」都降成 tonal 备选样式）：
  /// 用户要的是"引导客户安装、尽量少让对方配置"，所以主路必须一眼看到、不给第二眼犹豫的机会——
  /// 两处都用主色填充的话，人就分不出哪个才是该点的那个。
  Widget _protocolInstallBlock(_ProtocolInstall? install) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // 用户 ⑨ 删掉了按钮旁边那句"装好自动填好目录与开关，你一个字段都不用填"（与卡头重复）。
        // 但他随后指着留下的空位问："一整行只放了一个按钮？"——删是对的，**没把腾出来的位置用上**
        // 是错的。现在把下面那段说明挪上来与它同行：动作和它的代价摆在一处，也省掉一整行。
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            FilledButton(
              // key 同上：这张卡上按钮不止一个，按文字取会拿到"第几个"这种一改布局就失效的定位
              key: const ValueKey('protocol-side-install'),
              // 安装中**不接受第二次点击**：这条端点是同步的，点两下就是下两份、解压两遍，
              // 而第二遍会先清空第一遍刚写好的目录（自己踩自己）
              onPressed: protocolInstalling ? null : () => unawaited(_installProtocolSide()),
              style: _btnStyle(context),
              child: protocolInstalling
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Text('一键安装'),
            ),
            const SizedBox(width: 12),
            // 用户 ⑨ 指定的四句（原文照抄，只补了中英文之间的空格与断句）
            Expanded(
              child: Text(
                '从 SnowLuma 官方 Release 下载 Lite 包；自动下载失败时，自行下载并填写安装目录。'
                '此包不随框架分发，不得用于商业使用。',
                style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurfaceVariant),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        // 用户 ⑨ 指定的前提句，单独一行留警告色：这是唯一一步框架替不了他的
        Text(
          '使用前提：本机已登录 QQ 客户端（Bot 账号）。',
          style: TextStyle(fontSize: 11.5, height: 1.7, color: IrmiaTheme.warn),
        ),
        if (protocolInstalling) ...[
          const SizedBox(height: 10),
          _protocolInstallRunning(),
        ] else if (install != null) ...[
          const SizedBox(height: 10),
          _protocolInstallOutcome(install),
          // 引导只在**装好之后**出现：装之前摆一长串"下一步"是噪音，
          // 而此刻它是这张卡上最该被看到的一句话
          if (install.ok) ...[
            const SizedBox(height: 10),
            _protocolNextSteps(),
          ],
        ],
      ],
    );
  }

  /// 安装中：只给"在做什么 + 还要多久"，**不摆假进度**。
  ///
  /// 两件事写在这里是有依据的，不是客套话：
  ///   · **一两分钟**：实测真装一次约 104 秒（4.6 MB 的包，本机约 45 KB/s）。说"几秒就好"会让人
  ///     以为卡死了，然后去点第二次。
  ///   · **记录一次性回来**：这条端点是同步请求，不是流——中间的进度行拿不到，
  ///     所以"进度感"只能由按钮状态与这段文案提供（为此加 SSE 不划算）。
  Widget _protocolInstallRunning() {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Text(
        '正在从官方 Releases 下载并解压。要下 4.6 MB，视网速可能要一两分钟——先别急，也别再点一次。'
        '分步记录（下到哪一步、下多大）会在这一步结束时一次性列出来：这条端点是同步请求，不是流，'
        '中间插不进进度行。',
        style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurface),
      ),
    );
  }

  /// 这一次安装的结果。**成功与失败都摆在这里**（失败尤其不能只弹一句 toast 就完了）：
  ///   · 成功 = 一句"装好并配好了" + 下一步引导；
  ///   · 失败 = 服务端那句 `detail` **原文**（它就是给人看的原因与出路）+ 逐行过程记录。
  /// 过程记录是这次失败唯一能回答"卡在哪一步"的东西，所以它跟着结果一起留在卡上。
  Widget _protocolInstallOutcome(_ProtocolInstall install) {
    final scheme = Theme.of(context).colorScheme;
    final tone = install.ok ? (install.configured ? IrmiaTheme.ok : IrmiaTheme.warn) : IrmiaTheme.danger;
    // 版本号缺了就别硬凑一句话（服务端没给版本时说明它自己也没解析出 tag）
    final head = install.ok
        ? '已装好${install.version.isEmpty ? '' : ' ${install.version}'}'
            '${install.configured ? '，并用它配好了；重启一下就能用。' : '，但自动配置那一步没成。'}'
        : '安装失败';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: tone.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                install.ok ? Icons.check_circle_outline : Icons.error_outline_rounded,
                size: 15,
                color: tone,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  head,
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.onSurface),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // detail 原样显示、不截断、不改写：失败时它就是"卡在哪一步、为什么"那句人话
          Text(install.detail, style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurface)),
          if (install.writeError.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              '自动配置没写成：${install.writeError}。装好的目录已经替你填在下面的「安装目录」里，'
              '点一下「保存目录」、再把「启用内置协议端」打开就行（同样是重启后接管）。',
              style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurface),
            ),
          ],
          if (!install.ok) ...[
            const SizedBox(height: 4),
            Text(
              '手动出路：从 $protocolDownloadUrl 下载发行包，解压后把那个目录填到下面的「安装目录」，'
              '再点「保存目录」、打开开关——效果与一键安装一样，只是这几步由你做。',
              style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurface),
            ),
          ],
          const SizedBox(height: 8),
          Text(
            install.log.isEmpty ? '过程记录：（这次没有——失败发生在动手之前）' : '过程记录：',
            style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant),
          ),
          // 逐行摆出来，一行不加不减：这几行是"到底卡在哪儿"的全部证据
          for (final line in install.log)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(line, style: _mono(11.5, scheme.onSurfaceVariant)),
            ),
        ],
      ),
    );
  }

  /// 装好之后的引导：把散在卡片各处的两件事（重启、扫码）串成一条看得见的线。
  ///
  /// 为什么必须显式说"先重启"：运行中的协议端实例是按**启动时**那份配置建的，
  /// 刚写好的配置此刻还没有任何东西去执行它——不说明白，人会以为"我装好了但它没动，是不是坏了"。
  /// 为什么说"扫码是接入 QQ 客户端"：那是唯一一步框架给不了的，得让人知道去哪儿把它接上。
  ///
  /// 重启这件事**没有端点可调**，也不该有：让一个常驻进程"重启自己"是危险动作
  /// （拉不起来就什么都不剩），框架只引导、不代劳。
  Widget _protocolNextSteps() {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: scheme.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: scheme.primary.withValues(alpha: 0.28)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '已经装好了。下一步：先重启服务，再扫码。',
            style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.onSurface),
          ),
          const SizedBox(height: 6),
          Text(
            '① 重启服务：运行中的协议端实例是按启动时的配置建的，重启之后它才会按刚写好的配置被拉起'
            '（框架不替你重启——重启自己失败就什么都不剩了）。\n'
            '② 再扫码：重启后这张卡上会出现「打开面板」，点开在那边先读并同意用户协议与隐私政策'
            '（那是法律性质的同意，要你自己按），再接入 QQ 并扫码；'
            '首次登录要用它启动时打印的初始凭据——那句话现在就显示在按钮下面（口令打码），'
            '旁边有「复制凭据」。扫码接的是你本机的 QQ 客户端，框架不代管登录态。',
            style: TextStyle(fontSize: 11.5, height: 1.8, color: scheme.onSurface),
          ),
        ],
      ),
    );
  }

  /// 状态行：装到哪了 + detail **全文** + 三档 + 三个动作（状态徽章在卡头，这里不重复第二枚）。
  ///
  /// `detail` 原样显示、不截断：它就是给人看的那句话（失败时带着原因与下一步），
  /// 截断等于把唯一的线索切掉一半。
  ///
  /// v36 起这句 detail **不再是唯一的那句话**：它上面多了一块三档明细
  /// （进程 / OneBot 配置 / 适配器），各带自己的判据与证据。理由是实测出来的：
  /// 一句话的 `state` 只能报"启动失败"，而现场的事实是"进程活着、配置缺失"——
  /// 那句话和事实相反，人照着它去查日志会白查半天。三档明细就是"到底断在哪一环"的答案。
  Widget _protocolStatusRow(String state) {
    final scheme = Theme.of(context).colorScheme;
    final dir = _protocolField('dir');
    final endpoint = protocolSide?['endpoint'];
    final wsUrl = endpoint is Map ? (endpoint['wsUrl']?.toString() ?? '') : '';
    final webuiUrl = _protocolField('webuiUrl');
    // 三态要留住：`installed` 可能是 true / false / null（见服务端的说明），
    // 用 `== true` 会把 null 与 false 糊成同一个"没有入口"，那句判断很可能是错的
    final installed = protocolSide?['installed'];
    final attached = protocolSide?['attached'] == true;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.folder_outlined, size: 15, color: scheme.onSurfaceVariant),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  dir.isEmpty ? '（还没填安装目录）' : dir,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: _mono(11.5, scheme.onSurface),
                ),
              ),
              // installed 是三态：true / false / null（配置刚改过、重启后才核对得出）。
              // null 时**不许**说成"目录里没有入口"——那是另一个意思，而且很可能是错的
              if (installed == true)
                Text('已找到可执行入口', style: TextStyle(fontSize: 11.5, color: IrmiaTheme.ok))
              else if (installed == false)
                Text('目录里没有可执行入口', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant))
              else
                Text('入口要重启后才核对', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            _protocolField('detail'),
            style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurface),
          ),
          if (wsUrl.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text('对接点：$wsUrl', style: _mono(11.5, scheme.onSurfaceVariant)),
          ],
          // 三档明细：证书那一行下面是"链条"，这里是"链条断在哪一环"
          _protocolChainBlock(),
          const SizedBox(height: 10),
          Row(
            children: [
              FilledButton(
                // 「启动」在"已经在跑"时应当按不动：那种情况下点它只会得到一句
                // "它已经在跑了"，而按钮亮着就是在暗示"点一下会好"
                onPressed: (_protocolCardBusy || _protocolProcessRunning == true)
                    ? null
                    : () => unawaited(_protocolAction('start')),
                style: _btnStyle(context),
                child: protocolBusy
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Text('启动'),
              ),
              const SizedBox(width: 8),
              FilledButton.tonal(
                // 同理：没在跑就不给「停止」（它只会回一句"它本来就没在跑"）
                onPressed: (_protocolCardBusy || _protocolProcessRunning != true)
                    ? null
                    : () => unawaited(_protocolAction('stop')),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                  minimumSize: const Size(0, 36),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: const Text('停止'),
              ),
              const Spacer(),
              // 扫码登录是在**它的 WebUI** 里做的，框架不代管 QQ 登录态；
              // 没在跑时不给这个按钮——那个页面此刻打不开，摆一个点不出东西的按钮比不摆更糟
              if (webuiUrl.isNotEmpty)
                FilledButton.tonal(
                  onPressed: _protocolCardBusy ? null : () => unawaited(_openUrl(webuiUrl)),
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    minimumSize: const Size(0, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text('打开面板'),
                ),
            ],
          ),
          if (webuiUrl.isNotEmpty) _protocolLoginBlock(webuiUrl),
          if (!attached) ...[
            const SizedBox(height: 2),
            Text(
              '本次进程启动时还没读到这段配置：框架现在不持有它的实例，'
              '「启动/停止」要等重启进程之后才有效。',
              style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
            ),
          ],
        ],
      ),
    );
  }

  /// 第一档：进程在不在。三态——在跑 / 没在跑 / **本进程没在看**（没有实例时不许说"没在跑"）。
  bool? get _protocolProcessRunning {
    final process = protocolSide?['process'];
    if (process is! Map) return null;
    final running = process['running'];
    return running is bool ? running : null;
  }

  /// 三档链条：一行一档，左边是档名，中间是判据，右边是证据。
  ///
  /// 为什么把"证据"（pid / 启动时刻 / 监听地址 / 配置路径 / 重连次数）也摆出来：
  /// 这一版要治的就是"笼统报一句启动失败"。判据本身也要能被核对——不然换个人来看，
  /// 他还是只能选择信不信那句话。证据摆出来，他自己就能判。
  Widget _protocolChainBlock() {
    final scheme = Theme.of(context).colorScheme;
    if (protocolSide == null) return const SizedBox.shrink();

    final process = protocolSide!['process'];
    final config = protocolSide!['onebotConfig'];
    final adapter = protocolSide!['adapter'];
    final rows = <Widget>[
      _protocolChainRow(
        '① 进程',
        _protocolChainText(process, (map) {
          if (map['known'] != true) return ('未观测', '本进程没有实例，这一档没人在看');
          if (map['running'] != true) return ('没在跑', '没有监听到它的面板端口');
          final pid = map['pid'];
          final started = map['startedAt']?.toString() ?? '';
          final url = map['webuiUrl']?.toString() ?? '';
          final how = map['managed'] == 'spawned'
              ? '本次进程拉起'
              : map['managed'] == 'discovered' ? '本次进程之前就在跑' : '只探到端口';
          return (
            '在跑',
            [
              if (pid != null) 'pid $pid',
              if (started.isNotEmpty) '${_shortTime(started)} 起',
              if (url.isNotEmpty) '监听 $url',
              how,
            ].join(' · '),
          );
        }),
        ok: process is Map && process['running'] == true,
        unknown: process is Map && process['known'] != true,
      ),
      _protocolChainRow(
        '② OneBot 配置',
        _protocolChainText(config, (map) {
          if (map['present'] == true) {
            final ws = map['wsUrl']?.toString() ?? '';
            final token = map['hasToken'] == true ? '带 token' : '无 token（协议端未开校验）';
            return ('在', [if (ws.isNotEmpty) '端点 $ws', token].join(' · '));
          }
          if (map['unreadable'] == true) {
            return ('读不出', '那份文件在（${map['path'] ?? '?'}）但端点解析失败——要人去修它');
          }
          return ('缺失', '未登录 QQ：这一份是登录之后才生成的');
        }),
        ok: config is Map && config['present'] == true,
        warn: config is Map && config['unreadable'] == true,
        unknown: config == null,
      ),
      _protocolChainRow(
        '③ 适配器',
        _protocolChainText(adapter, (map) {
          final state = map['state']?.toString() ?? '';
          final target = map['target']?.toString() ?? '';
          final attempts = map['reconnectAttempts'];
          final delivered = map['delivered'];
          switch (state) {
            case 'connected':
              return (
                '已连上',
                [
                  if (target.isNotEmpty) target,
                  if (map['selfId'] != null && '${map['selfId']}'.isNotEmpty) 'QQ ${map['selfId']}',
                  '已收 $delivered 条',
                ].join(' · '),
              );
            case 'reconnecting':
              return ('重连中', [if (target.isNotEmpty) target, '第 $attempts 次退避'].join(' · '));
            case 'no-endpoint':
              return ('没端点可连', '协议端的 OneBot 配置还没出现，配置里也没有手填地址');
            case 'disabled':
              return ('未启用', 'config.channels.onebot.enabled=false');
            default:
              return ('未装配', '本进程没有 OneBot 适配器');
          }
        }),
        ok: adapter is Map && adapter['state'] == 'connected',
        warn: adapter is Map && adapter['state'] == 'reconnecting',
        unknown: adapter == null || adapter['state'] == 'not-assembled',
      ),
    ];

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: rows),
    );
  }

  /// 三档里的一行；`unknown` 是"没人在看"（既不是好也不是坏，用中性色）
  Widget _protocolChainRow(
    String label,
    (String, String) verdict, {
    bool ok = false,
    bool warn = false,
    bool unknown = false,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final tone = unknown
        ? scheme.onSurfaceVariant
        : ok
            ? IrmiaTheme.ok
            : warn
                ? IrmiaTheme.warn
                : IrmiaTheme.danger;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 96,
            child: Text(label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
          ),
          SizedBox(
            width: 78,
            child: Text(
              verdict.$1,
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: tone),
            ),
          ),
          Expanded(
            child: Text(
              verdict.$2,
              style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
            ),
          ),
        ],
      ),
    );
  }

  /// 从一档的 map 里取结论；map 缺失或形状不对时由调用方给"未观测"
  (String, String) _protocolChainText(
    Object? value,
    (String, String) Function(Map<String, dynamic> map) read,
  ) {
    if (value is! Map) return ('未观测', '这一档没有数据');
    return read(value.cast<String, dynamic>());
  }

  /// ISO 时刻 → `10-07 01:26`（本地时间；只用于显示，判据仍是原文那个 ISO）
  String _shortTime(String iso) {
    final parsed = DateTime.tryParse(iso);
    if (parsed == null) return iso;
    final local = parsed.toLocal();
    String two(int value) => value.toString().padLeft(2, '0');
    return '${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
  }

  /// 面板入口那一块：凭据 + 两个门 + 接下来该做什么。
  ///
  /// 口令**来自服务端**（`.password`），而这里显示的是打码形态 `.passwordMasked`
  /// ——"留头尾各两位"是为了让人能和自己手里那条核对（全遮之后两个不同的口令长得一样）。
  /// 真要复制原文，走「复制凭据」那个按钮：它把明文放剪贴板，不在屏幕上停留。
  Widget _protocolLoginBlock(String webuiUrl) {
    final scheme = Theme.of(context).colorScheme;
    final login = protocolSide?['webuiLogin'];
    final map = login is Map ? login.cast<String, dynamic>() : const <String, dynamic>{};
    final credential = map['credential'];
    final cred = credential is Map ? credential.cast<String, dynamic>() : const <String, dynamic>{};
    final source = cred['source']?.toString() ?? 'none';
    final user = cred['user']?.toString() ?? '';
    final masked = cred['passwordMasked']?.toString() ?? '';
    final password = cred['password']?.toString() ?? '';
    final consentRecorded = map['consentRecorded'] == true;
    final mustChange = map['mustChangePassword'] == true;

    final lines = <String>[
      if (source == 'stdout')
        '初始凭据（本次启动从它的输出里捕到，用户 $user / 口令 $masked）'
      else if (source == 'console-log')
        '初始凭据（从框架自己的启动留痕里捞回来的：用户 $user / 口令 $masked；'
            '若它之后又重启过，这条就作废了）'
      else
        '初始凭据找不回来：它只在启动时往自己的输出里打一次（关掉程序就没了）。'
            '要拿到一条可用的，就让框架重启它一次（那一次的输出会被捕获并显示在这里）。',
      if (!consentRecorded) '协议与隐私政策还没同意——面板解锁之前，接入 QQ 的入口是锁着的。',
      if (mustChange) '初始口令还没改：两个门里第一个就是改密，面板会一直要求你先改它。',
    ];

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '扫码登录在 $webuiUrl 里做（框架不代管 QQ 登录态）。',
            style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
          ),
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                line,
                style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
              ),
            ),
          if (password.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.tonal(
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: '$user $password'.trim()));
                    if (mounted) _toast('凭据已复制（用户 + 口令）', kind: ToastKind.success);
                  },
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    minimumSize: const Size(0, 36),
                    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  child: const Text('复制凭据'),
                ),
              ),
            ),
        ],
      ),
    );
  }

  /// 下载引导：**手动那条路的出路**（一键安装之外的第二条路，不是唯一的路）。
  ///
  /// 许可口径照实说：包从官方 Releases 代下载、一个字节不改、**不随框架分发**它——
  /// 所以地址永远摆在界面上：一键安装那份是"替他点几下"，这条路是"他自己来"，
  /// 两条路落到盘上的东西是一样的（与「外部依赖」卡里 pwsh 那条同一个姿势）。
  Widget _protocolDownloadGuide() {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '也可以自己来：从 $protocolDownloadUrl 下载发行包解压，把那个目录填在上面。'
          '这条路在一键安装失败、或者你想自己控制版本时用；框架也从同一个地址代下载，不随框架分发它'
          '（许可是"源码可见非商业"，自用没问题）。',
          style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 6),
        FilledButton.tonal(
          onPressed: _protocolCardBusy ? null : () => unawaited(_openUrl(protocolDownloadUrl)),
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            minimumSize: const Size(0, 36),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: const Text('打开下载页'),
        ),
      ],
    );
  }

  /// 「需重启」提示条：改了配置之后**必须**看得见的一句话。
  ///
  /// 为什么这么显眼：运行中的协议端实例是按**启动时**的配置建的，点完保存界面上的状态
  /// 一点都不会变——不说明白，人会以为"我开了它却没生效，是不是坏了"。
  Widget _restartNote() {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        color: IrmiaTheme.warn.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.warn.withValues(alpha: 0.28)),
      ),
      child: Text(
        '改动已写入 config.json，但要重启进程才接管：运行中的协议端实例是按启动时那份配置建的。'
        '重启之前，这里显示的状态仍是本次启动的那一个。',
        style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurface),
      ),
    );
  }

  /// 状态徽章的颜色：失败要红、要动手的黄、正常的绿、其余保持中性
  Color _protocolTone(String state) {
    switch (state) {
      case 'ready':
        return IrmiaTheme.ok;
      case 'failed':
        return IrmiaTheme.danger;
      case 'not-installed':
      case 'starting':
        return IrmiaTheme.warn;
      default:
        return Theme.of(context).colorScheme.onSurfaceVariant;
    }
  }

  /// 取协议端视图里的一个字符串字段（缺字段一律空串：界面上显示"—"而不是 "null"）
  String _protocolField(String key) {
    final value = protocolSide?[key];
    return value == null ? '' : value.toString();
  }

  bool get _protocolDirDirty => _protocolDirCtl.text.trim() != protocolDirBase.trim();

  /// 写 `channels.onebot.enabled`（开关是即时生效的那种控件：二值项没有"改到一半"的中间态，
  /// 不该逼人多按一次保存——与「发言」卡的打字节奏开关同一条口径）。
  Future<void> _saveProtocolEnabled(bool value) async {
    setState(() => protocolSaving = true);
    try {
      final data = await widget.state.api.put('/api/protocol-side/config', {'enabled': value});
      final map = data is Map ? data.cast<String, dynamic>() : const <String, dynamic>{};
      await _loadProtocolSide();
      if (!mounted) return;
      _toast('${value ? '已开启' : '已关闭'}内置协议端${_restartSuffix(map)}',
          kind: ToastKind.success);
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => protocolSaving = false);
    }
  }

  /// 写 `channels.onebot.managed.dir`（归一化与校验都在服务端，这里只做"非空"这一层的当场拦）
  Future<void> _saveProtocolDir() async {
    final dir = _protocolDirCtl.text.trim();
    if (dir.isEmpty) {
      _toast('安装目录不能为空', kind: ToastKind.warn);
      return;
    }
    setState(() => protocolSaving = true);
    try {
      final data = await widget.state.api.put('/api/protocol-side/config', {'dir': dir});
      final map = data is Map ? data.cast<String, dynamic>() : const <String, dynamic>{};
      // 落盘的是**归一化之后**的那个路径：把它回填进输入框并重记原始值，
      // 否则"保存成功但按钮还是亮的"（脏判定比的是旧快照，人会以为没存上）
      final saved = map['dir']?.toString() ?? dir;
      if (mounted) {
        setState(() {
          protocolDirBase = saved;
          _protocolDirCtl.text = saved;
        });
      }
      await _loadProtocolSide();
      if (!mounted) return;
      _toast('已保存安装目录：$saved${_restartSuffix(map)}', kind: ToastKind.success);
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => protocolSaving = false);
    }
  }

  /// 启停。回执里的 `note` 是服务端写给人看的一句话，**原样弹出来**：
  /// "点了但什么都没发生"（已经在跑 / 本来就没跑 / 没有实例）必须说出来，不能弹个绿 toast 了事。
  Future<void> _protocolAction(String action) async {
    setState(() => protocolBusy = true);
    try {
      final data = await widget.state.api.post('/api/protocol-side/$action', const {});
      final map = data is Map ? data.cast<String, dynamic>() : const <String, dynamic>{};
      await _loadProtocolSide();
      if (!mounted) return;
      final note = map['note']?.toString() ?? '';
      final changed = map['changed'] == true;
      final state = map['state']?.toString() ?? '';
      final kind = !changed
          ? ToastKind.info
          : (state == 'ready' ? ToastKind.success : ToastKind.warn);
      _toast(note.isEmpty ? (action == 'start' ? '已请求启动' : '已请求停止') : note, kind: kind);
    } catch (err) {
      if (mounted) _toast('${action == 'start' ? '启动' : '停止'}请求失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => protocolBusy = false);
    }
  }

  /// 一键安装：**装，然后立刻配好**——这是"尽量少让对方配置"的落点。
  ///
  /// 两步的顺序是有意的：
  ///   ① `POST /api/protocol-side/install`：框架从官方 Releases 代下载 lite 包并解压到固定的家
  ///      （`<数据目录>/services/snowluma`，**不需要人选路径**），装完就地复检入口；
  ///   ② 装成功才 `PUT /api/protocol-side/config`，body `{dir, enabled:true, autoStart:true}`：
  ///      目录、开关、自动拉起**一次写好**，用户不用再去填任何一个字段。
  ///
  /// ②为什么由界面调、而不是让安装端点顺手写：一个端点做两件有副作用的事，出错时说不清是哪一件坏的
  /// （服务端也刻意没这么干）。两次调用各自的成败在这里分开记：**装了但没配上**与**压根没装成**
  /// 是两件事——说成一句，人会对着已经装好的机器再下一遍包。
  ///
  /// 失败**不塞进 toast 就完了**：`detail`（它就是那句人话）与 `log`（卡在哪一步）都摆回卡上，
  /// 人得能看见"下到哪一步断的"，才知道该重试、该换网络、还是该自己下。
  Future<void> _installProtocolSide() async {
    // 上一次的结果先清掉：新旧两份过程记录混在一起，人就分不清哪一行属于哪一次
    setState(() {
      protocolInstalling = true;
      protocolInstall = null;
    });

    Map<String, dynamic> map = const <String, dynamic>{};
    try {
      // 无 body：装到哪由服务端定（固定位置），所以这里没有"选路径"这一步——那正是要压掉的操作。
      // 这条端点是**同步**的、要跑一两分钟（实测约 104 秒），回执里带着完整的 log。
      //
      // **这条请求不能加客户端总超时**：IrmiaApi 的 connectionTimeout 只覆盖"建连"那一下
      // （dart:_http 里它只包在 Socket.startConnect 外面），所以它天然等得住一次两分钟的安装。
      // 反过来，给它套一个 `Future.timeout` 会造出最难查的那种故障——超时只是把回执丢掉，
      // 服务端的下载照跑：界面上写着"失败"，盘上东西其实装好了；人再点一次又下一遍。
      final data = await widget.state.api.post('/api/protocol-side/install', const {});
      map = data is Map ? data.cast<String, dynamic>() : const <String, dynamic>{};
    } catch (err) {
      if (!mounted) return;
      setState(() {
        protocolInstalling = false;
        protocolInstall = _ProtocolInstall.failed('安装请求失败：$err（请求没走到安装那一步，先确认主进程在跑）');
      });
      _toast('一键安装失败：原因见卡片', kind: ToastKind.error);
      return;
    }

    final detail = map['detail']?.toString() ?? '';
    final log = <String>[
      for (final line in (map['log'] is List ? map['log'] as List : const <Object>[])) line.toString(),
    ];

    // 失败也是 200（只有鉴权/方法不对才非 200）：所以判据是 ok，不是 HTTP 状态
    if (map['ok'] != true) {
      if (!mounted) return;
      setState(() {
        protocolInstalling = false;
        protocolInstall = _ProtocolInstall.failed(
          detail.isEmpty ? '安装失败，服务端没有给出原因（回执里没有 detail）' : detail,
          log: log,
        );
      });
      _toast('一键安装失败：原因见卡片', kind: ToastKind.error);
      return;
    }

    final dir = map['dir']?.toString() ?? '';
    final version = map['version']?.toString() ?? '';

    // ② 紧接着把配置一次写好。这一步失败**不代表装失败**，所以分开记、分开说
    var saved = dir;
    var writeError = '';
    try {
      final reply = await widget.state.api.put('/api/protocol-side/config', {
        'dir': dir,
        'enabled': true,
        'autoStart': true,
      });
      // 落盘的是服务端**归一化之后**那个路径（相对路径按数据目录解成绝对路径）。
      // 回填它而不是回填我们传进去的那个：以后真正被用到的是盘上那份
      if (reply is Map && reply['dir'] != null) saved = reply['dir'].toString();
    } catch (err) {
      writeError = '$err';
    }

    if (!mounted) return;
    setState(() {
      protocolInstalling = false;
      protocolInstall = _ProtocolInstall(
        ok: true,
        dir: saved,
        version: version,
        detail: detail.isEmpty ? '已装好' : detail,
        log: log,
        writeError: writeError,
      );
      // 配上时：与「保存目录」成功时同一条口径——用服务端存下来的那个路径重记快照再回填，
      // 否则输入框、快照、盘上三份状态对不上，按钮会一直亮着而人以为没存上
      _protocolDirCtl.text = saved;
      if (writeError.isEmpty) protocolDirBase = saved;
    });

    // 只看配置那一步的结论决定提示，不看安装那一步（它已经成功了）
    await _loadProtocolSide();
    if (!mounted) return;
    _toast(
      writeError.isEmpty ? '已装好并用它配好了；重启一下就能用' : '已装好，但自动配置没写成：见卡片里的说明',
      kind: writeError.isEmpty ? ToastKind.success : ToastKind.warn,
    );
  }

  /// 「需重启」后缀：**只信服务端算出来的那个结论**（它比较的是盘上那份与本进程启动时那份）。
  /// 与当前生效一致时不该喊重启——喊多了这句话就不值钱了。
  String _restartSuffix(Map<String, dynamic> map) => map['restartRequired'] == true ? '（重启进程后接管）' : '';

  // ── 分区七：外部回调（B9：webhook 专用凭据） ──

  /// 「外部回调」卡：`POST /webhook/*` 的专用凭据——现在这份的状态 + **生成 / 轮换**。
  ///
  /// 为什么这条通道要一份**单独的**凭据（而不是让人拿界面会话凭据去配外部脚本）：
  /// 会话凭据会随「改密码 / 登出 / 换机器」失效，而失效的现场在**另一台机器**上——
  /// 半夜开始收 401，人在这边看不出为什么。专用凭据只够投递、读不到 `/api/*` 上的任何东西，
  /// 也不随界面那扇门开关（完整取舍见 `src/web/webhook-secret.ts` 的文件头）。
  ///
  /// 状态来自只读端点 `GET /api/webhook-secret`：它只报"配没配 + 那个非密钥的 id + 时刻"，
  /// **绝不吐明文或哈希**。明文只在生成那一次的响应里出现，直接进
  /// [showWebhookTokenDialog] 那张"只显示这一次"的框，本页一个字节都不留。
  Widget _webhookCard() {
    final scheme = Theme.of(context).colorScheme;
    final configured = webhookSecret?['configured'] == true;
    final secretId = _secretText('secretId');
    final createdAt = _stamp(_secretText('createdAt'));
    final rotatedRaw = _secretText('rotatedAt');
    final by = _secretText('by');
    final summary = webhookError != null
        ? null
        : (webhookSecret == null
            ? (webhookLoading ? '读取中…' : null)
            : (configured ? '已生成' : '还没有生成'));
    return _SectionCard(
      title: '外部回调',
      note: '外部系统往这台实例投递用的专用凭据（POST /webhook/*）。',
      trailing: summary == null ? null : _badge(summary, configured ? IrmiaTheme.ok : IrmiaTheme.warn),
      children: [
        if (webhookError != null) ...[
          _footnote('凭据状态读取失败（$webhookError）。状态看不见时先别按"重新生成"：'
              '轮换不可逆（旧的那份当场失效），而此刻你并不知道有没有人在用它。'),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              key: const ValueKey('webhook-retry'),
              onPressed: () => unawaited(_loadWebhookSecret()),
              child: const Text('重试'),
            ),
          ),
        ],
        if (webhookSecret == null && webhookError == null)
          _footnote('正在读取 webhook 凭据状态…'),
        if (webhookSecret != null) ...[
          _readOnlyRow(
            '当前凭据',
            configured ? '凭据 $secretId · 生成于 $createdAt' : '还没有生成',
            restart: false,
            note: configured
                ? null
                : '这条通道现在一律 401（没有凭据就没人投得进来）。按下面的按钮生成一份。',
          ),
          if (configured)
            _readOnlyRow(
              '上次轮换',
              rotatedRaw.isEmpty ? '从未' : _stamp(rotatedRaw),
              restart: false,
              note: by.isEmpty ? null : '发起方：$by',
            ),
          if (webhookRotatedNote.isNotEmpty) _footnote(webhookRotatedNote),
          const SizedBox(height: 14),
          Row(
            children: [
              FilledButton(
                key: const ValueKey('webhook-rotate'),
                onPressed: webhookRotating ? null : () => unawaited(_rotateWebhookSecret(configured: configured)),
                style: _btnStyle(context),
                child: webhookRotating
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(configured ? '重新生成' : '生成 webhook 凭据'),
              ),
            ],
          ),
        ],
        const SizedBox(height: 10),
        // 这条例子是**给外部系统抄的**：host:port 取这一页能看到的生效配置，不写死端口
        Container(
          margin: const EdgeInsets.only(top: 4),
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          decoration: BoxDecoration(
            color: scheme.surfaceContainer,
            borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          ),
          child: SelectableText(_webhookCurl(), style: _mono(11.5, scheme.onSurface)),
        ),
        _footnote('/webhook/* 不认界面凭据（也不认迁移期那份 data/.ui-token）：这条通道只认'
            '上面那份专用凭据。它是给外部系统的——投得进来，读不到 /api/* 上的任何东西。'),
        _footnote('凭据文件：${_secretText('file').isEmpty ? 'data/.webhook-secret.json' : _secretText('file')}'
            '（盘上只有它的 sha256：原文只在你按下按钮那一次出现在屏幕上，之后再没人读得回来）。'),
      ],
    );
  }

  /// webhook 状态视图里的一个字符串字段（null / 缺失 → 空串）
  String _secretText(String key) {
    final value = webhookSecret?[key];
    return value == null ? '' : value.toString();
  }

  /// 给外部系统抄的那条 curl（路径与 body 形状照 docs/operations.md §4.2）
  String _webhookCurl() {
    final host = _text('web.host').isEmpty ? '127.0.0.1' : _text('web.host');
    final port = _amount('web.port') == '—' ? '7788' : _amount('web.port');
    return 'curl -X POST http://$host:$port/webhook/alert \\\n'
        '     -H "Authorization: Bearer <专用凭据>" \\\n'
        '     -H "Content-Type: application/json" \\\n'
        "     -d '{\"level\":\"warn\",\"text\":\"磁盘快满了\"}'";
  }

  /// 生成 / 轮换 webhook 专用凭据（`POST /api/commands/regenerate-webhook-token`）。
  ///
  /// 「重新生成」是**危险操作**：这个通道永远只有一把钥匙，再生成一次就是把旧的那把当场作废——
  /// 还在用它投递的外部脚本会开始收 401，而故障现场在另一台机器上。所以只在这一档问一次
  /// （confirm：灰取消 / 红确认）；第一次生成不会让任何东西失效，不必多问一遍。
  ///
  /// 明文（响应里的 `token`）**只进那张对话框**：它是这个方法里的一个局部变量，
  /// 这一页不留它（不写状态文件、不做"再看一眼"）。服务端那句 `note` 照原样摆进框里。
  Future<void> _rotateWebhookSecret({required bool configured}) async {
    if (configured) {
      final go = await confirm(
        context,
        title: '重新生成 webhook 凭据',
        body: '上一份会当场失效：已经在用它的外部脚本会立刻开始收 401——记得把新凭据一起换过去。'
            '新凭据只显示一次。',
        confirmLabel: '重新生成',
        danger: true,
      );
      if (!go || !mounted) return;
    }
    setState(() => webhookRotating = true);
    try {
      final reply = await widget.state.api.post(
        '/api/commands/regenerate-webhook-token',
        {'by': 'gui'},
        confirm: 'regenerate-webhook-token',
      );
      if (!mounted) return;
      final map = reply is Map ? reply.cast<String, dynamic>() : const <String, dynamic>{};
      final token = map['token']?.toString() ?? '';
      final action = map['action']?.toString() ?? (configured ? 'rotate' : 'generate');
      final note = map['note']?.toString() ?? '';
      // 先刷新状态（卡上的 id 与时刻换成新那份），再弹那张"只显示这一次"的框
      await _loadWebhookSecret();
      if (!mounted) return;
      if (token.isEmpty) {
        // 服务端没给明文：那就没有"抄走"这回事，如实说（不猜、也不假装成功）
        _toast('服务端没有回凭据原文，请再按一次；若反复如此，去看主进程日志', kind: ToastKind.error);
        return;
      }
      setState(() {
        webhookRotatedNote =
            action == 'rotate' ? '上一份已当场失效（还在用它的外部脚本会开始收 401）。' : '';
      });
      await showWebhookTokenDialog(
        context,
        token: token,
        note: note,
        action: action,
        previousSecretId: map['previousSecretId']?.toString(),
      );
    } catch (err) {
      if (mounted) _toast('生成失败：$err', kind: ToastKind.error);
    } finally {
      if (mounted) setState(() => webhookRotating = false);
    }
  }

  // ── 分区八：记忆（框架代管记忆的总开关） ──

  /// 「记忆」卡：一个开关 —— `persona.memoryEnabled`。
  ///
  /// **为什么放在设置页而不是人格配置页**：人格配置页编的是 `MEMORIES/` 里那些文件的**内容**
  /// （她的资产），这一条决定的是**那些文件由谁维护**——框架替她管，还是她自知有这些文件、
  /// 自己去读去写去整理。它改的是运行行为，不是资产，所以归设置页。
  ///
  /// 文案口径（用户要求）：**说清后果**，不是"启用记忆系统"四个字。
  /// 开 = 框架生成 `MEMORIES/INDEX.md`、每轮把索引注入固定块、每日整理一次、
  /// 并维护 `!pinned` 与条目 TTL；关 = 框架不生成索引、不注入任何记忆、不跑整理，
  /// 她只从装置自述知道 `MEMORIES/`（facts.md / episodes/ / jargon.md / style-notes.md /
  /// aliases.md）与 `diary/` 存在，读写维护全归她自己。
  ///
  /// 关掉时旁边**必须**摆出那句代价（这里做成只在关掉时出现的一行警示）：
  /// 她可能忘了整理、`facts.md` 会一直长下去、索引不再更新。理由很直白——
  /// 关掉这个开关不会有任何报错、也不会有任何东西变红，代价是**几天后才显形**的那种；
  /// 不在按下去的那一刻说清，人只会以为"界面变安静了"。
  ///
  /// 不受它影响的两条路也写在卡头里（`aliases.md` 参与会话认人属于通道侧；
  /// `STATE.md` 是独立的一层）：免得下一个人以为关掉就全没了。
  Widget _memoryCard() {
    final scheme = Theme.of(context).colorScheme;
    final enabled = _at(cfg, 'persona.memoryEnabled') != false;
    final pending = pendingRestart.contains('persona.memoryEnabled');
    return _SectionCard(
      title: '记忆',
      note: '长期记忆（MEMORIES/ 与 diary/）由谁维护：框架替你管，还是她自己读、自己写、自己整理。',
      trailing: pending ? _badge('尚未生效', IrmiaTheme.warn) : null,
      children: [
        _FieldCell(
          label: '让框架自动管记忆（关掉 = 她只知道自己有这些文件，读、写、整理全归她）',
          field: Align(
            alignment: Alignment.centerLeft,
            child: Switch(
              key: const ValueKey('memory-enabled'),
              value: enabled,
              onChanged: _memorySaving ? null : (next) => unawaited(_saveMemoryEnabled(next)),
            ),
          ),
          note: '开着：框架生成并维护 MEMORIES/INDEX.md，每轮把索引注入固定块，并每日整理一次。',
        ),
        // 关掉时才出现的代价行：与卡头的说明分开，是因为它只在关掉这一种状态下成立
        if (!enabled) ...[
          const SizedBox(height: 12),
          _memoryCostNote(),
        ],
        const SizedBox(height: 12),
        _readOnlyRow(
          '当前生效',
          enabled ? '框架自动管记忆（每轮注入索引、每日整理）' : '她自己管（框架不生成、不注入、不整理）',
          restart: true,
        ),
        _footnote('不受这个开关影响的两条路：MEMORIES/aliases.md 参与「会话认人 / 关注名单」'
            '属于通道侧；STATE.md（她当前状态）是独立的一层。'),
        _footnote('这一项是进程启动时读的：保存写进 config.json，重启后接管。'
            '关掉不会删任何文件。'),
        DetailFold(
          child: Text(
            '关掉之后框架不生成、不注入、不整理，但她照旧能自己读写那些文件。'
            '为什么留这个开关：给只想让 agent 自己管记忆的人一条干净的路。'
            '每日整理的时间点由 wake.memoryMaintainCron 定（默认每日一次）：'
            '过期的流水账并进 facts.md，另写一篇 diary/。'
            'facts.md 的 !pinned 分区与条目 TTL 也归框架维护。',
            style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }

  /// 关掉记忆托管时的那句代价（只在关掉时出现）。
  ///
  /// 用警示色而不是灰字：它是这一页上唯一"按下去什么都不会报错、代价却要过几天才显形"的开关。
  Widget _memoryCostNote() {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      decoration: BoxDecoration(
        color: IrmiaTheme.warn.withValues(alpha: 0.08),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: IrmiaTheme.warn.withValues(alpha: 0.28)),
      ),
      child: Text(
        '代价：她可能忘记整理，facts.md 会一直长下去，索引也不再更新——这些都归她自己。',
        style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurface),
      ),
    );
  }

  bool _memorySaving = false;

  /// 落盘（走既有的 config-update 通道，与发言卡的打字节奏开关同一条路）。
  ///
  /// **需重启才生效**，判据不是我在这里猜的：服务端按"盘上那份 vs 本进程启动时那份"算
  /// `$pending.restartRequired`，`persona.` 前缀本来就在 RESTART_REQUIRED_FIELDS 里
  /// （而 HOT_RELOAD_FIELDS 目前是空名单——全部字段都要重启），所以保存后回读会把这一条
  /// 报回来，卡头那枚「尚未生效」徽章与这行只读的「需重启」都是直接显示服务端结论。
  /// 说得准的理由还有一层：她这一轮的上下文与索引注入方式是在 turn 装配时定下的，
  /// 半新半旧地接管会让"这一轮到底注入了没有"变成没人说得清的事。
  Future<void> _saveMemoryEnabled(bool value) async {
    setState(() => _memorySaving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {
          'fields': {'persona.memoryEnabled': value},
        },
        confirm: 'config-update',
      );
      await _loadConfig(seed: true);
      if (!mounted) return;
      _toast(value ? '已改为框架自动管记忆（重启后接管）' : '已改为她自己管记忆（重启后接管）');
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.warn);
    } finally {
      if (mounted) setState(() => _memorySaving = false);
    }
  }

  // ── 分区九：信任范围（`trust.mode`：完全信任 / 只限工作目录） ──

  /// 「信任范围」卡：**她的活动边界有多宽**——整台电脑，还是只有一个工作目录。
  ///
  /// 为什么是一条独立的卡、而不是系统卡里的一行：系统卡那些字段问的是"这个进程怎么启动"
  /// （监听地址、预算、数据目录），这一条问的是"她这个人能碰多远"。后者是**边界**：
  /// 越过它就是拒绝（越界的读写与命令直接被拦），不是提醒、不是降级、也不是"下次注意"。
  ///
  /// 三处口径刻意不自己造：
  ///   · **当前值读盘上那份**（`/api/config?source=saved`，与这一页其余字段同一来源）——
  ///     读生效配置的话，保存成功后回读会把刚选的那档冲回去；
  ///   · **需不需要重启**只认服务端算出来的 `$pending.restartRequired`（判据见下方
  ///     [_trustPending]），本页不另算一份；
  ///   · **「只限工作目录」的路径**取 `trust.workspaceRoot`（解析器算出来的那份）。
  ///     它与执行器真正拦的路径是**同一个来源**——界面显示 A 而拦在 B 是最难查的一类故障。
  ///
  /// 写入走这一页既有的通道（`POST /api/commands/config-update`，`X-Confirm: config-update`），
  /// 与「记忆」卡的开关同一条路：点一下即写、写前问一次（放宽边界那一档要多问一句后果）。
  /// 选中的那一档会**马上**从盘上回读，所以界面显示的永远是"盘上那份"而不是"我以为写下去的"。
  Widget _trustCard() {
    final scheme = Theme.of(context).colorScheme;
    final mode = _trustMode();
    final root = _text('trust.workspaceRoot');
    final pending = _trustPending;
    return _SectionCard(
      title: '信任范围',
      note: '她的活动边界：整台电脑，或只有一个工作目录。越界就是拒绝，不是提醒。',
      trailing: pending ? _badge('尚未生效', IrmiaTheme.warn) : null,
      children: [
        _FieldCell(
          label: '她能碰到多远',
          field: Column(
            children: [
              TrustModeChoice(
                mode: kTrustFull,
                selected: mode == kTrustFull,
                consequence: trustModeConsequence(kTrustFull, root),
                enabled: !_trustSaving,
                onPick: (picked) => unawaited(_saveTrustMode(picked)),
              ),
              const SizedBox(height: 8),
              TrustModeChoice(
                mode: kTrustWorkspace,
                selected: mode == kTrustWorkspace,
                consequence: trustModeConsequence(kTrustWorkspace, root),
                enabled: !_trustSaving,
                onPick: (picked) => unawaited(_saveTrustMode(picked)),
              ),
            ],
          ),
          note: '两档各自管什么写在选项里，改哪一档就按哪一档的后果算。',
        ),
        const SizedBox(height: 12),
        // 只读的「当前生效」行：与「记忆」卡同形（服务端说了要重启就摆"需重启"，
        // 盘上那份与生效那份真的不一样时另有一行提示——见下面那条 footnote）
        _readOnlyRow(
          '当前生效',
          mode == kTrustWorkspace
              ? (root.isEmpty ? '只限工作目录（路径未读到）' : '只限工作目录 · $root')
              : '完全信任（整台电脑）',
          restart: true,
        ),
        if (pending)
          _footnote('上面选的那一档还没生效：盘上已经写下了，但正跑着的这个进程用的仍是'
              '启动时读到的那份——重启后接管。在那之前，她照旧按当前生效的那一档活动。'),
        _footnote('工作目录由服务端算出来（默认 <配置目录>/workspace），界面上不手填：'
            '同一条边界写两个值，就一定会出现"配置说 A、实际拦在 B"。'),
        _footnote('它是边界，不是提醒：越界的读写与命令一律被拒绝。'),
        DetailFold(
          // 定位件：设置页上「详情」不止一处，用例要的是"信任范围卡里这一处"
          key: const ValueKey('trust-rules-fold'),
          child: Text(
            '它管 fs 工具族（safe_read / safe_write / safe_edit / rg_search 等）与 pwsh：'
            '前者经同一条路径判定，后者的 workdir 与命令行里的路径一起受管。'
            '它与 destructive 开关、pwsh 命令黑名单是各自独立的三道门——这一条管的是范围，'
            '不代替那两道。\n'
            '为什么默认完全信任：她是一台无人值守的常驻 agent，"能自己去找、去修、去装"本来'
            '就是她存在的方式；默认把她关进一个空目录，等于出厂就让她大多数本事用不出来。',
            style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
          ),
        ),
      ],
    );
  }

  /// 盘上那份的 `trust.mode`。**缺字段当 `'full'`**（与 `src/config/config.ts` 的
  /// `buildDefaults` 同源：那边默认就是完全信任）——绝不因为"界面没读到"就显示成受限那一档：
  /// 界面说到底该显示的是"她实际按哪一档跑"，猜一个更安全的答案同样是撒谎。
  String _trustMode() {
    final raw = _text('trust.mode');
    return raw == kTrustWorkspace ? kTrustWorkspace : kTrustFull;
  }

  /// 这一档**要不要重启**——判据只有服务端那一份（`$pending.restartRequired`，它是
  /// "盘上那份 vs 本进程启动时那份"的逐字段差异）。
  ///
  /// 为什么不去自己找一套口径：`src/config/watcher.ts` 的字段归类里，
  /// `HOT_RELOAD_FIELDS` 是**空名单**（全部字段都要重启才生效，`trust.mode` 自然也在其中），
  /// 而 `trust.` 并不在 `RESTART_REQUIRED_FIELDS` 那几个前缀里——那两处只决定"事件里怎么记、
  /// 日志里怎么喊"。界面要答的问题更简单也更硬：**盘上这份与生效那份是否一致**。
  /// 那正是 `$pending.restartRequired` 的答案，所以这里只读它、只显示它。
  bool get _trustPending => pendingRestart.contains('trust.mode');

  bool _trustSaving = false;

  /// 落盘一档边界（`trust.mode`）。
  ///
  /// 两条分寸：
  ///   · **改到放宽的那一档（完全信任）要多问一句**：确认框里写的就是那句后果，而不是
  ///     "确定吗"——按错一次就等于撤掉一条边界；
  ///   · **与盘上那份相同就什么都不做**：点已经选中的那一行不该产生一次写入（那会让
  ///     "$pending 里凭空多一条 trust.mode"，界面上突然冒出"尚未生效"，而人什么都没改）。
  Future<void> _saveTrustMode(String mode) async {
    if (mode != kTrustFull && mode != kTrustWorkspace) return; // 不认识的值一个字节都不写
    if (mode == _trustMode()) return;

    if (mode == kTrustFull) {
      final ok = await confirm(
        context,
        title: '改成完全信任',
        body: '改成完全信任之后：${trustModeConsequence(kTrustFull, _text('trust.workspaceRoot'))}'
            '这是一条边界，撤掉它她是真的能做到上面这些事。确定吗？',
        confirmLabel: '改成完全信任',
        danger: true,
      );
      if (ok != true || !mounted) return;
    }

    setState(() => _trustSaving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {
          'fields': {'trust.mode': mode},
        },
        // 字段级危险短语（服务端 DANGEROUS_FIELDS）：**两档都要**，不是只给"放宽"那一档。
        // 少了它这次写入会被服务端挡成 400 confirm-required。
        confirm: kTrustConfirm,
      );
      // 写完立刻按**盘上那份**回读（本页其余字段同一条纪律）：服务端可能拒了、也可能归一化过，
      // "我以为写下去的"不作数
      await _loadConfig(seed: true);
      if (!mounted) return;
      _toast(
        mode == kTrustWorkspace
            ? '已改为只限工作目录；越界的读写与命令会被拒绝（重启进程后接管）'
            : '已改为完全信任（重启进程后接管）',
      );
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.warn);
    } finally {
      if (mounted) setState(() => _trustSaving = false);
    }
  }

  // ── 分区十：系统（逐行就地编辑：监听地址 / 时区 / 六条预算 / 心跳平均间隔） ──

  /// 系统卡（用户 ⑪ 起可改，⑭ 起改成**逐行**就地编辑）。
  ///
  /// 为什么回到"紧凑表 + 每行一枚胶囊"：⑪ 第二版把整张表摊成常驻输入框，用户看了说
  /// "就像原来这样，后面有个胶囊按钮，点击就可以编辑对应行行不行吗"——**表是读的地方，
  /// 改是偶发动作**。常驻十个框，把"扫一眼参数"变成了"面对一张表单"。
  ///
  /// 为什么仍然要一个「保存」而不是像开关那样点一下就写：数字框边打字边落盘会把
  /// 20000000 打成 2（与发言卡的速度框同一条理由），而这九行都是**进程启动参数**
  /// （`HOT_RELOAD_FIELDS` 是空的：没有哪个字段能热更，包括心跳）
  /// ——它们的共同点恰恰是"改到一半的状态谁都不该用"。现在这个"保存"是**行内**的，
  /// 所以卡头不再有「有未保存的更改」，也不再有卡片底部的总保存键：
  /// 逐行自包自足，没有"整张卡脏了"这个概念了。
  ///
  /// 两条**刻意留只读**（理由写在各自那一行里，不是忘了做）：
  ///   · dataDir —— 它决定她的全部身家落在哪，而且是进程启动时定下的路径；
  ///   · tools.destructiveEnabled —— "她能碰什么"的危险开关，只在带确认短语的那一处改。
  Widget _systemCard() {
    return _SectionCard(
      title: '系统',
      // 卡头原来挂「只读」，脚注写着"修改请编辑 config.json"——⑪ 之后这两句都会变成假话。
      //
      // 这句话**同时也是这一页测试的定位锚**（`inSystemCard` 按它找卡——`find.textContaining`
      // 只取第一个 Container 祖先，所以这句必须**只出现一次**）。2026-10-05 加"心跳"两个字时
      // 顺手把它写成了"监听地址、时区、六条预算与心跳的平均间隔"——那正好把「监听地址」那一行的
      // 标签也变成了候选，锚点于是指到了行上，五条系统卡用例一起红。**别再往这句里塞行标签**。
      note: '监听地址、时区、六条预算与心跳都是这个进程的启动参数：'
          '在这里改，保存写进 config.json，重启后生效。',
      children: [
        // 默认露前 4 行（最常看/最常调的先摆），其余 7 行收在「查看全部」后面
        // （用户 ⑭："平时可能只暴露几项，可以全部展开"）。展开/收起由 CappedChildren 自带。
        CappedChildren(
          cap: 4,
          children: [
            _sysEditRow('web', value: _sysListenValue()),
            _sysEditRow('timezone'),
            _sysEditRow('budget.dailyTokens'),
            // 两条只读行与可编辑行**同族同壳**，只是不给胶囊、也不挂「需重启」（改不了的行
            // 喊重启没意义）；"为什么改不了"就写在它们自己那一行的灰字里。
            _readOnlyRow(
              '数据目录',
              _text('dataDir'),
              restart: false,
              note: '启动时定下的路径：事件日志、人格资产与密钥都在它下面，'
                  '换它等于让下一个进程从空目录开始。',
            ),
            _sysEditRow('budget.stepTools'),
            _sysEditRow('budget.turnSteps'),
            _sysEditRow('budget.taskTokens'),
            _sysEditRow('budget.softRatio'),
            _sysEditRow('budget.failStreakMax'),
            // 心跳平均间隔（用户 2026-10-05："心跳频率我没有地方可以控制吗？"）：
            // 摆在预算那一组的**末尾**——它与上面几条是同一类旋钮（都决定"她花多少 token"），
            // 而它是这一组里唯一"直接决定她多久醒一次"的一条。放在 destructive 那行之前，
            // 因为 destructive 管的是"能碰什么"，不是"跑多勤"。
            _sysEditRow('wake.heartbeatTargetMeanMin'),
            _destructiveRow(),
          ],
        ),
        _footnote('数据目录在这里改不了（它决定她的全部身家落在哪，且进程启动时就定下了）；'
            '其余字段保存后重启进程生效。'),
      ],
    );
  }

  /// 一行可编辑项：读态摆「左标签 → 当前值 → 需重启徽章 → 编辑胶囊」，点「编辑」就地变成
  /// 「输入框 → 保存 / 取消」——**只有这一行变**，别行照旧。
  ///
  /// [id] 是编辑态的键（也是测试定位的键，见 [_sysRowFields]）；[value] 留给"两个字段拼一个
  /// 读数"的那种行（监听地址）。行的外壳与 [_readOnlyRow] 同族：同样的底色、圆角、
  /// 上下间距与内边距——两处行摆在一条竖线上要看着是一张表，不是两种控件。
  Widget _sysEditRow(String id, {String? value}) {
    final scheme = Theme.of(context).colorScheme;
    final fields = _sysRowFields[id]!;
    final editing = _sysEditing.contains(id);
    final shown = value ?? _sysValue(fields.first);
    final note = fields.first.note;
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // 标签列宽度与只读行一模一样（200）：两种行才对得齐
              SizedBox(
                width: 200,
                child: Text(fields.first.label, style: const TextStyle(fontSize: 12.5)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: editing
                    ? _sysBoxes(fields)
                    : Text(
                        shown.isEmpty ? '—' : shown,
                        key: ValueKey('sys-value-$id'),
                        textAlign: TextAlign.right,
                        style: _mono(12.5, scheme.onSurface),
                      ),
              ),
              const SizedBox(width: 10),
              // 徽章两选一（2026-10-04）：
              //   · 「尚未生效」= 盘上这份与生效那份**真的不一样**（服务端比对出来的），
              //     改完还没重启时才有——它把「需重启」的意思也包含在内，所以同时挂两枚会很吵；
              //   · 「需重启」  = 这一类字段是启动参数，改完要重启进程才接管（常态说明）。
              // 两条只读行不挂（⑭ 的原话：改不了的行喊重启没意义）。
              if (_rowPending(fields))
                _badge('尚未生效', IrmiaTheme.warn)
              else
                _badge('需重启', IrmiaTheme.warn),
              const SizedBox(width: 10),
              if (editing) ..._sysRowActions(id, fields) else _sysEditPill(id),
            ],
          ),
          // 旁注**只在编辑态出现**：读态要的是"一眼扫完的参数表"（⑪ 版式返工的教训），
          // 而"填原值，20M 这类简写不接受""0.8 就是 80%"要说的正是"你正要往框里打字"。
          if (editing && note != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(note,
                  style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
            ),
        ],
      ),
    );
  }

  /// 编辑态的输入区。单字段行就是一个框；监听地址那一行是两个（host + 端口）——
  /// 它们本来就是同一行的两半，右边端口定宽 108：端口就四五位数，给它半张卡是浪费，
  /// 也让人以为那里能填别的。
  Widget _sysBoxes(List<_SysField> fields) {
    if (fields.length == 1) return _sysBox(fields.single);
    return Row(
      children: [
        Expanded(child: _sysBox(fields.first)),
        const SizedBox(width: 10),
        SizedBox(width: 108, child: _sysBox(fields.last)),
      ],
    );
  }

  /// 行尾那枚「编辑」胶囊。
  ///
  /// 形状在这里自报一个 StadiumBorder：⑧ 把按钮家族的圆角统一到了 radiusCtl（8），
  /// 而用户这一条点名要的是**胶囊**。只覆盖 shape——字号与字体栈仍走主题的 buttonText
  /// （⑨ 那条锁：页面里不写 textStyle）。
  Widget _sysEditPill(String id) {
    return FilledButton.tonal(
      key: ValueKey('sys-edit-$id'),
      onPressed: _sysSaving ? null : () => setState(() => _sysEditing.add(id)),
      style: FilledButton.styleFrom(
        shape: const StadiumBorder(),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        minimumSize: const Size(0, 28),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      child: const Text('编辑'),
    );
  }

  /// 编辑态那两枚：保存（主按钮）+ 取消（文字按钮）。保存只有真的改了才可点——
  /// "未改动即禁用"是这一页的既有分寸，灰着本身就是一句话：盘上就是这个值。
  List<Widget> _sysRowActions(String id, List<_SysField> fields) {
    return [
      FilledButton(
        key: ValueKey('sys-save-$id'),
        onPressed: _sysRowDirty(fields) && !_sysSaving ? () => unawaited(_saveSysRow(id, fields)) : null,
        style: _sysRowBtnStyle(),
        child: _sysSaving
            ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
            : const Text('保存'),
      ),
      const SizedBox(width: 4),
      TextButton(
        key: ValueKey('sys-cancel-$id'),
        onPressed: _sysSaving
            ? null
            : () => setState(() {
                  _resetSysDraft(fields);
                  _sysEditing.remove(id);
                }),
        style: _sysRowBtnStyle(),
        child: const Text('取消'),
      ),
    ];
  }

  /// 行内按钮的紧凑尺寸：一行里要塞下两枚，用页面级那套（36 高、左右 16）会把这行撑起来。
  /// **只给尺寸**：圆角仍归主题（⑧），字号仍归主题（⑨）。
  ButtonStyle _sysRowBtnStyle() => const ButtonStyle(
        padding: WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 14)),
        minimumSize: WidgetStatePropertyAll(Size(0, 28)),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
      );

  /// 行右侧那个"当前值"：与点开「编辑」后框里看到的字符串**一模一样**（都走 [_SysField.seed]）。
  ///
  /// 为什么不恢复旧表那套紧凑写法（2M / 80%）：⑪ 定的规矩是"框里摆的就是 config.json 里的值"，
  /// 读数与编辑态各写各的，点一下「编辑」值就自己变了——那是把人当没看见。想要 20M / 80%
  /// 那种读法，旁注里"0.8 就是 80%"就是它的位置。
  String _sysValue(_SysField field) => field.seed(cfg);

  /// 监听地址那一行的读数：`host:port`。host 为空时**不补 127.0.0.1**——那正是 ⑪ 修掉的
  /// 一句假话（空 host 等于监听所有网卡，不是本机）；两半各自如实留白，缺就是缺。
  String _sysListenValue() {
    final host = _sysHost.seed(cfg);
    final port = _sysPort.seed(cfg);
    return '${host.isEmpty ? '—' : host}:${port.isEmpty ? '—' : port}';
  }

  /// 字段输入框。**key 就是点路径**：测试按它精准定位，也不必去数"页面上第几个框"
  /// （这一页的框已经多到按序号取必然出错）。
  TextField _sysBox(_SysField field) {
    return TextField(
      key: ValueKey('sys-field-${field.path}'),
      controller: _sysCtls[field.path],
      enabled: !_sysSaving,
      autocorrect: false,
      enableSuggestions: false,
      keyboardType: field.numeric ? TextInputType.number : TextInputType.text,
      // 等宽只给数字：host 与 IANA 时区名里没有需要对齐的数位
      style: field.numeric
          ? _mono(13, Theme.of(context).colorScheme.onSurface)
          : const TextStyle(fontSize: 13),
      decoration: InputDecoration(hintText: field.hint),
    );
  }

  // ── 分区十一：账号与安全（B10） ──

  /// 「账号与安全」卡：**改密码** 与 **登出**。
  ///
  /// 为什么这两件事在这张卡上、而不是塞进模型卡：它们改的是**进来的方式**（凭据），
  /// 与"她怎么说话、用哪个模型"毫无关系。这一页的分区是按"改的是什么"分的
  /// （模型 / 界面 / 发言 / 依赖 / 协议端 / 系统 / 账号），凭据是独立的一类。
  ///
  /// 两件事各用自己合适的形状：改密码是**三个框一起填**的表单 → 走页面自己的对话框
  /// （`account_security.dart`，与 ui_kit 上"要填字段的表单用 showDialog"那条分寸一致）；
  /// 登出不需要填任何东西 → 卡上一颗按钮 + 项目既有的 `confirm`（灰取消 / 红确认）。
  Widget _accountCard() {
    final state = widget.state;
    // 半升级态：这一份是老的共享 token（这台实例还没设过密码）。它开不出"会话"，
    // 改密码与登出在服务端都做不成——如实写在按钮上面，并把出路（设置密码）一起摆出来。
    final legacy = state.onLegacyToken;
    return _SectionCard(
      title: '账号与安全',
      note: '进来这个界面用的凭据：改密码与登出。',
      trailing: _badge(
        legacy ? '旧的共享 token' : '会话凭据',
        legacy ? IrmiaTheme.warn : IrmiaTheme.ok,
      ),
      children: [
        _readOnlyRow(
          '当前实例',
          state.instance ?? '',
          restart: false,
          note: '凭据按实例分文件存（%APPDATA%\\Irmia\\sessions）：同一台机器上开第二个实例'
              '不会把这一份顶掉。',
        ),
        if (legacy)
          _footnote('这一份用的是旧的共享 token（这台实例还没设过密码），服务端不认它开出的'
              '"会话"：改密码与登出都做不成。先设置一个密码，之后按会话登录/登出。'),
        const SizedBox(height: 14),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            FilledButton(
              key: const ValueKey('account-change-open'),
              // 半升级态下这颗按钮是**灰的**：灰着本身就是一句话（"这条路上改不了"），
              // 而理由就写在它上面一行
              onPressed: legacy ? null : () => unawaited(_openChangePassword()),
              style: _btnStyle(context),
              child: const Text('改密码'),
            ),
            OutlinedButton(
              key: const ValueKey('account-logout'),
              onPressed: () => unawaited(_logoutAccount()),
              style: OutlinedButton.styleFrom(
                foregroundColor: IrmiaTheme.danger,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                minimumSize: const Size(0, 36),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: const Text('登出'),
            ),
            if (legacy)
              TextButton(
                key: const ValueKey('account-setup-password'),
                onPressed: () => state.openPasswordSetup(),
                child: const Text('先去设置密码'),
              ),
          ],
        ),
      ],
    );
  }

  /// 打开「改密码」；改成了就在这一页上留一句提示（对话框那一刻已经收起来了）
  Future<void> _openChangePassword() async {
    final changed = await showChangePasswordDialog(context, widget.state);
    if (changed && mounted) _toast('密码已改；这台界面已经换上新凭据', kind: ToastKind.success);
  }

  /// 登出：危险操作，走项目既有的 confirm（灰取消 / 红确认）。
  ///
  /// 这里**不需要**再收界面：`AppState.logout()` 把 `ready` 置假，整个壳连同这一页一起换成门
  /// （app.dart 里那个三元）——页面上再写一遍"清状态"就是第二份真相。
  Future<void> _logoutAccount() async {
    final go = await confirm(
      context,
      title: '登出',
      body: '退出这个界面并回到门上；本机这份会话凭据会被清掉——下次要用密码进来。',
      confirmLabel: '登出',
      danger: true,
    );
    if (!go || !mounted) return;
    await widget.state.logout();
  }

  // ── 分区十二：关于 ──

  Widget _aboutCard() {
    final scheme = Theme.of(context).colorScheme;
    return _SectionCard(
      title: '关于',
      note: '界面版本与运行期投影数据。',
      trailing: Text('Flutter 原生界面', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
      children: [
        _readOnlyRow('版本', guiVersion, restart: false),
        const SizedBox(height: 12),
        // 守护天数与事件水位属运行期技术字段：默认收在「详情」里（§3.4）
        DetailFold(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DetailRow(label: '守护天数', value: _guardedDays()),
              DetailRow(label: '事件水位', value: _watermark()),
              const SizedBox(height: 10),
              if (projError != null)
                _footnote('运行数据读取失败（$projError），守护天数与事件水位不可用。')
              else
                _footnote('守护天数与事件水位取自运行期投影（GET /api/projection），为实测值。'),
            ],
          ),
        ),
      ],
    );
  }

  /// 守护天数：首条事件到今天（与 Web 端 daysSince 同一口径）
  String _guardedDays() {
    final first = proj?['firstEventAt']?.toString();
    final days = _daysSince(first);
    if (days == null) return '—';
    final stamp = _stamp(first);
    return stamp == '—' ? '$days 天' : '$days 天（自 $stamp）';
  }

  /// 事件水位：watermark 缺失时退回 lastSeq（与 Web 端同口径）
  String _watermark() {
    final value = _at(proj, 'watermark') ?? _at(proj, 'lastSeq');
    return value is num ? value.toInt().toString() : '—';
  }

  // ── 取值与格式化 ──

  /// 按点路径取生效配置里的字符串
  String _text(String path) {
    final value = _at(cfg, path);
    if (value == null) return '';
    return value is String ? value : value.toString();
  }

  String _amount(String path) {
    final value = _at(cfg, path);
    return value is num ? value.toInt().toString() : '—';
  }


  /// **destructive 工具策略**（全关 / 全开 / 按名单）——这里才是它的家。
  ///
  /// 2026-10-04 用户定调：正式产品是 GUI（2026-10 网页观测台整个删除之后更是**唯一**的产品），
  /// 所以这个开关必须能在界面里改，不能把用户往外推。写通道与服务端一致：它是**字段级危险操作**，
  /// X-Confirm 要带 `update-config; enable-destructive`（服务端 DANGEROUS_FIELDS 登记的就是这一条）。
  Widget _destructiveRow() {
    final value = _at(cfg, 'tools.destructiveEnabled');
    final label = _policy();  // 与 Web 端同一口径的三态文案，复用不另写一份
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          const SizedBox(width: 2),
          Text('destructive 工具策略', style: const TextStyle(fontSize: 12.5)),
          const SizedBox(width: 10),
          Text(label, style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurfaceVariant)),
          const Spacer(),
          if (_destrSaving)
            const Padding(
              padding: EdgeInsets.only(right: 8),
              child: SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 2)),
            ),
          TextButton(onPressed: _destrSaving ? null : () => unawaited(_pickDestructivePolicy(value)), child: const Text('修改')),
        ],
      ),
    );
  }

  bool _destrSaving = false;

  /// 选策略：三档。按名单要挑工具，所以那一步走一个带勾选框的弹层。
  Future<void> _pickDestructivePolicy(Object? current) async {
    final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: const Text('destructive 工具策略'),
        children: [
          SimpleDialogOption(
            onPressed: () => Navigator.pop(ctx, 'none'),
            child: const Text('全关（一件都不给她看）'),
          ),
          SimpleDialogOption(
            onPressed: () => Navigator.pop(ctx, 'all'),
            child: const Text('全开（清单里全给）'),
          ),
          SimpleDialogOption(
            onPressed: () => Navigator.pop(ctx, 'list'),
            child: const Text('按名单（只给勾中的那几件）'),
          ),
        ],
      ),
    );
    if (choice == null || !mounted) return;
    if (choice == 'none') return _saveDestructive(false);
    if (choice == 'all') return _saveDestructive(true);
    final tools = await _loadDestructiveTools();
    if (!mounted) return;
    final picked = await _pickToolList(current, tools);
    if (picked == null) return;
    return _saveDestructive(picked);
  }

  /// 弹层里勾工具（按名单模式）
  Future<List<String>?> _pickToolList(Object? current, List<String> tools) async {
    final selected = <String>{
      if (current is List) ...[for (final item in current) if (item is String) item],
    };
    return showDialog<List<String>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setInner) => AlertDialog(
          title: const Text('按名单开放'),
          content: SizedBox(
            width: 420,
            height: 380,
            child: tools.isEmpty
                ? const Text('没拿到工具清单（注册表可能还没起来）——先去「扩展 · 工具」看一眼再回来。',
                    style: TextStyle(fontSize: 12.5))
                : ListView(
                    children: [
                      for (final name in tools)
                        CheckboxListTile(
                          dense: true,
                          value: selected.contains(name),
                          title: Text(name, style: const TextStyle(fontSize: 13)),
                          onChanged: (on) => setInner(() {
                            if (on == true) {
                              selected.add(name);
                            } else {
                              selected.remove(name);
                            }
                          }),
                        ),
                    ],
                  ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, selected.toList()),
              child: Text('保存（${selected.length} 件）'),
            ),
          ],
        ),
      ),
    );
  }

  /// destructive 工具名（按名单模式要列出来勾）：从 /api/tools 的 sideEffect 过滤
  Future<List<String>> _loadDestructiveTools() async {
    try {
      final data = await widget.state.api.get('/api/tools');
      final list = data is Map ? data['tools'] : null;
      if (list is! List) return const [];
      return [
        for (final item in list.whereType<Map>())
          if ('${item['sideEffect']}' == 'destructive') '${item['name']}',
      ];
    } catch (_) {
      return const [];
    }
  }

  /// 落盘。**改这个字段要额外一段确认短语**（服务端的字段级危险操作）——
  /// 与「全开」这种放宽动作相称；顺带把后果写在确认框里，别让人手滑。
  Future<void> _saveDestructive(Object value) async {
    final relaxed = value == true || (value is List && value.isNotEmpty);
    final ok = await confirm(
      context,
      title: '修改 destructive 工具策略',
      body: relaxed
          ? '这会让她能看到并调用会改动本机的工具（写文件、跑命令等）。确定吗？'
          : '改回受限档：她将看不到 destructive 工具（更安全）。确定吗？',
    );
    if (ok != true || !mounted) return;
    setState(() => _destrSaving = true);
    try {
      await widget.state.api.post(
        '/api/commands/config-update',
        {'fields': {'tools.destructiveEnabled': value}},
        confirm: 'update-config; enable-destructive',
      );
      await _loadConfig(seed: true);
      if (!mounted) return;
      _toast('已保存（重启后接管）');
    } catch (err) {
      if (mounted) _toast('保存失败：$err', kind: ToastKind.warn);
    } finally {
      if (mounted) setState(() => _destrSaving = false);
    }
  }

  /// destructive 工具策略三态（与 Web 端 policyLabel 同一口径）
  String _policy() {
    final value = _at(cfg, 'tools.destructiveEnabled');
    if (value == true) return '全开';
    if (value is List) return value.isEmpty ? '按名单（空）' : '按名单（${value.length} 项）';
    return '全关';
  }

  // ── 基础小组件（与 channels_page 同一套卡片语言） ──

  /// 只读行：标签左、值右（等宽），最右是「需重启」标注。
  /// [note] 是行内的一句灰字——⑪ 起用它说清"这一行为什么不给人改"（不要长篇，一行）。
  Widget _readOnlyRow(String label, String value, {bool restart = true, String? note}) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              SizedBox(width: 200, child: Text(label, style: const TextStyle(fontSize: 12.5))),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  value.isEmpty ? '—' : value,
                  textAlign: TextAlign.right,
                  style: _mono(12.5, scheme.onSurface),
                ),
              ),
              if (restart) ...[
                const SizedBox(width: 10),
                _badge('需重启', IrmiaTheme.warn),
              ],
            ],
          ),
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                note,
                style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant),
              ),
            ),
        ],
      ),
    );
  }

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

  Widget _footnote(String text) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Text(text, style: TextStyle(fontSize: 11.5, height: 1.7, color: scheme.onSurfaceVariant)),
    );
  }

  ButtonStyle _btnStyle(BuildContext context) {
    return FilledButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      minimumSize: const Size(0, 36),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );
  }
}

/// 分组卡片：一张卡一组（surface + outlineVariant 描边 + radiusCard），卡头 = 组名 + 一句说明。
/// 参照 AstrBotConfigV4 的分组卡：描述与 hint 在卡头，字段在卡内。
class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.note, required this.children, this.trailing});

  final String title;
  final String note;
  final List<Widget> children;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
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
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              ),
              if (trailing != null) trailing!,
            ],
          ),
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(note, style: TextStyle(fontSize: 12.5, height: 1.5, color: scheme.onSurfaceVariant)),
          ),
          const SizedBox(height: 14),
          ...children,
        ],
      ),
    );
  }
}

/// 字段单元：标签在上、控件在下（两列并排时左右两格顶边对齐，不因标签长度而错位）
class _FieldCell extends StatelessWidget {
  const _FieldCell({required this.label, required this.field, this.note});

  final String label;
  final Widget field;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w500)),
        const SizedBox(height: 6),
        field,
        if (note != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(note!, style: TextStyle(fontSize: 11.5, height: 1.6, color: scheme.onSurfaceVariant)),
          ),
      ],
    );
  }
}

/// 字段两列：够宽就并排，窄窗降一列（AstrBotConfigV4.vue:282-317 的 :sm="6"）
class _FieldPair extends StatelessWidget {
  const _FieldPair({required this.cells});

  final List<Widget> cells;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < _twoColBreakpoint) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (final cell in cells) ...[
                if (cell != cells.first) const SizedBox(height: 12),
                cell,
              ],
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final cell in cells) ...[
              if (cell != cells.first) const SizedBox(width: 16),
              Expanded(child: cell),
            ],
          ],
        );
      },
    );
  }
}

/// 锚点栏的小标题：给左侧列表一个名分，避免四条孤立条目
class _AnchorCaption extends StatelessWidget {
  const _AnchorCaption();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Text(
      '分区',
      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant),
    );
  }
}

/// 按点路径取配置里的值（与 Web 端 getPath 同一口径）
Object? _at(Map<String, dynamic>? root, String path) {
  Object? node = root;
  for (final key in path.split('.')) {
    if (node is! Map || !node.containsKey(key)) return null;
    node = node[key];
  }
  return node;
}

/// 小数原样成文本：0.8 → "0.8"、1 → "1"。
/// **不做百分比换算**——框里摆的是 config.json 里的值，换算一概留给旁注（用户 ⑪）。
String _plainDouble(double value) =>
    value == value.roundToDouble() ? value.toInt().toString() : value.toString();

/// 首条事件到今天的天数；不可解析返回 null（与 Web 端 daysSince 同一口径）
int? _daysSince(String? iso) {
  final dt = DateTime.tryParse(iso ?? '');
  if (dt == null) return null;
  final ms = DateTime.now().difference(dt).inMilliseconds;
  return ms < 0 ? 0 : ms ~/ 86400000;
}

String _stamp(String? iso) {
  final dt = DateTime.tryParse(iso ?? '')?.toLocal();
  if (dt == null) return '—';
  return '${dt.year}-${_p2(dt.month)}-${_p2(dt.day)} ${_p2(dt.hour)}:${_p2(dt.minute)}';
}

String _p2(int value) => value.toString().padLeft(2, '0');

TextStyle _mono(double size, Color color) => TextStyle(
      fontFamily: 'monospace',
      fontSize: size,
      color: color,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
