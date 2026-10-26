// TODO(i18n): 本文件没有界面文案（只有数据与判据）——文案全部在 lib/i18n/app_strings.dart 的
// `grantInbox*` / `trayPending*` 那一族里。这一份只回答两件事：**哪张单子高风险**、**待批是哪几条**。
/// 待批申请单的**共享那一份**：右下角通知卡、左侧导航角标、托盘提示三处读同一份数据。
///
/// ## 为什么要有这一层（2026-10-21）
///
/// 用户原话：「很多新手小白不知道**在哪可以审批**」。审批入口本来只在
/// 「扩展 → MCP → 待批」那一段里，而那一页**只有在人主动切过去时才存在**
/// （`home.dart` 的 `_PageHost` 用 `AnimatedSwitcher` 换页，页面走了轮询也停了）。
/// 于是"她递了一张单子"这件事，在人不去那一页的时候**屏幕上一点痕迹都没有**。
///
/// 这一层的职责就是把这个事实**搬到壳一级**：
///   · [PendingGrantPoller] 每 [kGrantPollSeconds] 秒读一次 `GET /api/grants`
///     （**复用既有端点，不新增后端接口**），把"待批"那几条交给 [AppState]；
///   · 判据、顺序、风险分级都在本文件里（一处实现），三处显示只读结果。
///
/// ## 安全分级（本文件最重要的那条判据）
///
/// **只有可回滚/可移回的那两支算低风险**，其余一律高风险：
///
///   | kind | 风险 | 依据 |
///   |---|---|---|
///   | `mcp-remove` | **低** | 只从 config.json 删一条声明，重新加回来即可（`mcp-grant.ts:905-938` 的落地复核会回滚原文件） |
///   | `skill-remove` | **低** | 整目录移进 `data/trash/`，移回即可（`skill-grant.ts:109`） |
///   | `mcp-add` | **高** | 它会拉起一个本机进程，工具默认按 `destructive` 处理（`mcp-grant.ts:354`） |
///   | `skill-install` | **高** | 新指令进她的 catalog；带 `scripts/` 时还引入可执行内容（`skill-grant.ts:216`） |
///   | 认不出的 kind | **高** | 兜底：不知道它做什么，就不许一键批 |
///
/// 这条判据是**白名单**（低风险只剩两支），不是黑名单：将来后端加了第五种 kind，
/// 它自动落进"高风险 ⇒ 先看详情"，而不是自动获得一个一键批准。
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'gui_log.dart';

/// 全局重读待批清单的间隔（秒）。
///
/// **10 秒**，理由三条：
///   · 扩展页那一支原来只在「MCP」分区被选中时 20 秒读一次（`extensions_page.dart:168`）——
///     20 > 15，一个新单子最多要等 20 秒才在界面上出现，而这一层是"通知"，太慢就等于没有；
///   · 10 秒与壳的心跳（`app.dart` 的 `kOnlinePollSeconds`）同一档：同一条读链上的两件事
///     不该一个 10 秒一个 2 秒，否则"她刚递了单子"会看起来是随机延迟；
///   · 端点本身便宜：`/api/grants` 走 `listGrants`（`mcp-grant.ts:528`），而它读的事件是
///     `readAllEvents` 的**增量缓存**（`src/state/event-snapshot.ts:112`，只读新尾部），
///     载荷是一张小清单。10 秒一跳换"人不用找就知道有单子"，值。
const int kGrantPollSeconds = 10;

/// 一张申请单的风险档。
enum GrantRisk {
  /// 可回滚/可移回：卡上的「批准」直接生效（仍然写回执）。
  low,

  /// 会引入新东西/不可一眼看清：卡上的按钮是「查看并批准」，点了**先开详情**。
  high,
}

/// 低风险白名单：**只有这两支**。
///
/// 为什么是白名单而不是"把危险的列出来"：后端的 `GrantKind` 是联合类型
/// （`src/log/types.ts:2226`：`mcp-add | mcp-remove | skill-install | skill-remove`），
/// 但界面与后端是两个可执行文件、可能先升界面再升后端。列危险的写法遇到第五种 kind 时
/// 会**默认放行**（一键批一个谁也没见过的动作）；白名单遇到它则默认升级成"先看详情"。
const Set<String> kLowRiskGrantKinds = <String>{'mcp-remove', 'skill-remove'};

/// 这张单子的风险档（判据表见文件头）。
GrantRisk grantRiskOf(Map<String, dynamic> grant) {
  final kind = '${grant['kind'] ?? ''}';
  return kLowRiskGrantKinds.contains(kind) ? GrantRisk.low : GrantRisk.high;
}

/// 这张单子此刻是不是**等着人点头**：她递过（`picked`）且还没结局（`outcome == null`）。
///
/// 与扩展页那一段的判据逐字相同（`extensions_page.dart:793-796`）：
/// `picked != true` 的那些还没有 `grant/requested` 事件，内容一格都不知道（`listGrants` 的注释），
/// 既没法在卡上说清是什么，也就没有可批的东西——它们不该出现在通知卡里。
bool isPendingGrant(Map<String, dynamic> grant) =>
    grant['outcome'] == null && grant['picked'] == true;

/// 一张待批单子的"时间"：还没结局时取她递单子的那一刻。
///
/// 判据取自服务端给的那两格，界面不自己算（与扩展页 `_grantTimeOf` 同一条口径）。
DateTime? grantRequestedAtOf(Map<String, dynamic> grant) {
  for (final key in const <String>['requestedAt', 'outcomeAt']) {
    final raw = grant[key];
    if (raw is! String || raw.trim().isEmpty) continue;
    final at = DateTime.tryParse(raw.trim());
    if (at != null) return at;
  }
  return null;
}

/// 把 `GET /api/grants` 的 `items` 过成**待批清单**：只留待批的，**最新的在最上面**。
///
/// 顺序照扩展页那一条（用户 2026-10-18："申请单历史自上而下的顺序应该是由时间最近的到最远的"）：
/// 同一时刻的两条保持服务端给的先后（`seq` 兜底）——`List.sort` 不稳定，只按时间比会让
/// 相等的那两条每次轮询随机换位，那在右下角这种"一直在动"的地方尤其刺眼。
List<Map<String, dynamic>> pendingGrantsNewestFirst(Object? rawItems) {
  final items = rawItems is List
      ? rawItems.whereType<Map>().map((item) => item.cast<String, dynamic>()).where(isPendingGrant).toList()
      : <Map<String, dynamic>>[];
  final rows = <({Map<String, dynamic> grant, DateTime? at, int seq})>[
    for (var i = 0; i < items.length; i++)
      (grant: items[i], at: grantRequestedAtOf(items[i]), seq: i),
  ];
  rows.sort((a, b) {
    if (a.at == null || b.at == null) {
      if (a.at != null) return -1;
      if (b.at != null) return 1;
      return a.seq.compareTo(b.seq);
    }
    final byTime = b.at!.compareTo(a.at!);
    return byTime != 0 ? byTime : a.seq.compareTo(b.seq);
  });
  return <Map<String, dynamic>>[for (final row in rows) row.grant];
}

/// 两份待批清单是不是"同一批"（按 id 与顺序比）。
///
/// 用途只有一个：轮询每 10 秒读一次，**内容没变就不通知**——否则右下角那张卡会每 10 秒
/// 重建一次（输入框、动画全被打断），而"整表重建"正是用户 2026-10-16 明确不要的东西。
bool samePendingGrants(List<Map<String, dynamic>> a, List<Map<String, dynamic>> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i += 1) {
    if ('${a[i]['id'] ?? ''}' != '${b[i]['id'] ?? ''}') return false;
    if ('${a[i]['kind'] ?? ''}' != '${b[i]['kind'] ?? ''}') return false;
    if ('${a[i]['name'] ?? ''}' != '${b[i]['name'] ?? ''}') return false;
  }
  return true;
}

/// 把 `GET /api/grants` 的 `malformed` 那一段过成"读不出来的单子"清单（2026-10-22）。
///
/// 服务端判据只有一处（`grantFileProblems`）：盘上有、日志里还没有、又解析不过的那些单子。
/// 界面**只负责把它们说出来**——那一档在"待批"判据里两样都不满足（`picked:false` 且挂不出卡），
/// 曾经是"人写了单子、框架一声不响"的那条缝。
List<Map<String, dynamic>> malformedGrantsOf(Object? raw) {
  if (raw is! List) return const <Map<String, dynamic>>[];
  final out = <Map<String, dynamic>>[];
  for (final item in raw) {
    if (item is! Map) continue;
    final id = '${item['id'] ?? ''}'.trim();
    if (id.isEmpty) continue;
    out.add(<String, dynamic>{
      'id': id,
      'why': '${item['why'] ?? ''}'.trim(),
    });
  }
  return out;
}

/// 两份"读不出来"清单是不是同一批（按 id + 原因比）：没变就不通知。
bool sameMalformedGrants(List<Map<String, dynamic>> a, List<Map<String, dynamic>> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i += 1) {
    if ('${a[i]['id'] ?? ''}' != '${b[i]['id'] ?? ''}') return false;
    if ('${a[i]['why'] ?? ''}' != '${b[i]['why'] ?? ''}') return false;
  }
  return true;
}

/// 读 `GET /api/grants` 并把「待批」那几条交给宿主（[onPending]）。
///
/// 生命周期由壳（`_IrmiaAppState`）管：进了门 `start()`、回门上 `stop()`、退场 `dispose()`。
/// 与 `AppState` 的关系是**单向回调**（不 import app.dart，也就不形成库环）。
///
/// 三条分寸：
///   · **读失败不清空**：服务端抖一下不该让屏幕上的卡凭空消失（那会让人以为"批掉了"），
///     保留上一次那份，下一次成功再换；
///   · **401 不在这里处理**：壳的心跳会走同一条 401 自愈 / 回门的路（`AppState._requireAuth`），
///     这里抢着做只会多一份判据；
///   · **防重入**：一次读在飞的时候再点（或心跳与手动刷新撞上）就直接让位——
///     `/api/grants` 每次现算，同一刻读两遍没有任何意义。
class PendingGrantPoller {
  PendingGrantPoller({
    required this.api,
    required this.onPending,
    this.onMalformed,
    this.interval = const Duration(seconds: kGrantPollSeconds),
  });

  final IrmiaApi api;

  /// 读到一份**变了**的待批清单时调它（没变不调，见 [samePendingGrants]）
  final void Function(List<Map<String, dynamic>> pending) onPending;

  /// 读到一份**变了**的"读不出来的单子"清单时调它（没变不调，见 [sameMalformedGrants]）。
  ///
  /// 它是**独立的一条**而不是并进 [onPending]：待批卡与"有一张单读不出来"是两件事，
  /// 一张读不出来的单子**绝不能**进待批队列（它没有可点的卡，点它只会拿到一句错）。
  final void Function(List<Map<String, dynamic>> malformed)? onMalformed;

  final Duration interval;

  Timer? _timer;
  bool _running = false;
  bool _ticking = false;

  /// 这一拍是**什么时候**开始的（[_kTickLatchMax] 那道年龄锁的判据）
  DateTime? _tickingSince;

  /// 最后一次成功读到的那份（失败时保留它；[last] 也给诊断与用例看）
  List<Map<String, dynamic>> last = const <Map<String, dynamic>>[];

  /// 最后一次成功读到的"读不出来的单子"（同上，失败时保留）
  List<Map<String, dynamic>> lastMalformed = const <Map<String, dynamic>>[];

  /// 最近一次读失败的原因（成功一次就清空）。**只在诊断里用**：界面上不显示它，
  /// 因为"读不到清单"与"没有清单"是两件事，而卡片不出现本身就是"没有可批的"。
  String? lastError;

  /// 成功读到过几次（用例读它验"真的在轮"）
  int reads = 0;

  bool get running => _running;

  /// 起跳：立刻读一次，然后每 [interval] 一拍。重复调用无副作用。
  void start() {
    if (_running) return;
    _running = true;
    unawaited(refresh());
  }

  /// 收口：**取消定时器但不扔手上的清单**（回门时由宿主决定清不清）。
  void stop() {
    _running = false;
    _timer?.cancel();
    _timer = null;
  }

  /// 手动读一次（点了批准/驳回之后立刻刷新走这里）。
  Future<void> refresh() async {
    if (_ticking) {
      final since = _tickingSince;
      final age = since == null ? Duration.zero : DateTime.now().difference(since);
      // **年龄锁**（2026-10-24）：`_ticking` 与 `_schedule()` 是一对——`_schedule` 在
      // `finally` 里，所以这一拍一旦永远不返回，待批轮询就**再也不排下一拍**
      // （2026-10-23「用久了卡死」的另一处放大器，形状与 `AppState._readingDashboard` 相同）。
      // 请求本身现在有时限（`kApiRequestTimeout`），这是第二道锁：超过
      // [_kTickLatchMax] 就当成那一拍已经死了，放行并留一笔现场。
      if (age <= _kTickLatchMax) return;
      guiLog.write('[wait] grants latch stale ${secsOf(age)}');
    }
    _ticking = true;
    _tickingSince = DateTime.now();
    try {
      final view = await api.get('/api/grants');
      final raw = view is Map ? view['items'] : null;
      final pending = pendingGrantsNewestFirst(raw);
      final malformed = malformedGrantsOf(view is Map ? view['malformed'] : null);
      lastError = null;
      reads += 1;
      if (!samePendingGrants(last, pending)) {
        last = pending;
        onPending(pending);
      }
      if (!sameMalformedGrants(lastMalformed, malformed)) {
        lastMalformed = malformed;
        onMalformed?.call(malformed);
      }
    } on ApiAuthError {
      // 由壳的心跳处理（见类注释）；这里只记一笔，别把清单清空
      lastError = 'unauthorized';
    } catch (err) {
      lastError = '$err';
      debugPrint('[grant-inbox] read /api/grants failed: $err');
    } finally {
      _ticking = false;
      _tickingSince = null;
      _schedule();
    }
  }

  /// 防重入闸最多能关多久（与 `AppState.kReadLatchMax` 同一条口径：请求时限的 3 倍）
  static const Duration _kTickLatchMax = Duration(seconds: 45);

  void _schedule() {
    _timer?.cancel();
    if (!_running) return;
    _timer = Timer(interval, () => unawaited(refresh()));
  }

  /// 退场：与 [stop] 同一条路（定时器是唯一要收的东西）
  void dispose() => stop();
}
