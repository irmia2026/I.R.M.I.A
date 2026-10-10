part of 'extensions_page.dart';

/// 信任门四态的展示词（与 Web 端同一张表）
const _trustLabel = <String, String>{
  'trusted': '已确认', 'never-confirmed': '未确认',
  'agent-proposed': 'agent 提议', 'content-changed': '确认后已变更',
};

/// MCP 运行期的展示词：日志里没有启动事件就显示"从未启动"，不臆造"正在运行"
const _mcpLabel = <String, String>{
  'started': '已运行', 'stopped': '已停止',
  'disabled': '已停用', 'never-started': '从未启动',
};

/// 徽章取色表：信任门与 sideEffect 共用一张，键不重叠
const _tone = <String, Color>{
  'trusted': IrmiaTheme.ok, 'started': IrmiaTheme.ok, 'running': IrmiaTheme.ok,
  'agent-proposed': IrmiaTheme.warn, 'stopped': IrmiaTheme.warn,
  'content-changed': IrmiaTheme.danger, 'destructive': IrmiaTheme.danger,
  'disabled': IrmiaTheme.sleep, 'none': IrmiaTheme.sleep,
};

int _int(Object? v) => v is num ? v.toInt() : 0;

List<Map<String, dynamic>> _maps(Object? v) =>
    v is List ? v.whereType<Map>().map((e) => e.cast<String, dynamic>()).toList() : const [];

List<String> _strings(Object? v) => v is List ? v.map((e) => '$e').toList() : const [];

/// 一件 MCP 工具在界面上要用的三格（卡片那两层「服务 → 工具名」就吃它）。
///
/// [short] 是 server 自报的短名，[full] 是 `mcp__{server}__{name}` 全名——**短名给人看、
/// 全名给人对**：日志与 `工具` 页签里出现的都是全名，没有它这一页就没法和别处对上号。
class _McpTool {
  const _McpTool({required this.short, required this.full, required this.description});

  final String short;
  final String full;
  final String description;
}

/// 「这个服务给过哪些工具」——一张卡上关于清单的**全部结论**都从这一处算出来。
///
/// 为什么收成一个零件而不是散在构建函数里：这句话有四个互相牵制的部分（清单来自哪里、
/// 哪一刻看到的、这次到底问没问过、能不能点开看），分开写就会出现"卡片说 12 件、展开里
/// 列了 3 件"这种自相矛盾——而用户要的正是"一眼看清层级"。
///
/// 读数分两档，**新旧后端都要能读**：界面与主进程是两个可执行文件，界面先升、后端还跑着
/// 上一版 dist 是常态。新后端给 `toolList`/`toolsFrom`/`toolsListAt`/`toolsQuery`（口径见
/// `src/web/server.ts` 的 `mcpView`）；没有这几格时按老形状回退到 `toolDetails` / `registeredTools`，
/// 并按 `state` 推出来源（在跑 = 此刻的、已停 = 上一次的）。回退那一档**说得出的话少一些**：
/// 老后端不给"问没问过"，所以那种情况下 `query` 一律为空，界面不猜。
class _McpTools {
  _McpTools(Map<String, dynamic> server)
      : disabled = server['disabled'] == true,
        state = '${server['state'] ?? 'never-started'}',
        reason = '${server['stopReason'] ?? ''}',
        declaredCount = _int(server['toolsCount']),
        listAt = server['toolsListAt'] is String
            ? server['toolsListAt'] as String
            : (server['toolsSeenAt'] is String ? server['toolsSeenAt'] as String : ''),
        from = '${server['toolsFrom'] ?? ''}',
        query = server['toolsQuery'] is String ? server['toolsQuery'] as String : '',
        ageMs = server['toolsAgeMs'] is num ? (server['toolsAgeMs'] as num).toInt() : null {
    final raw = _maps(server['toolList']).isNotEmpty
        ? _maps(server['toolList'])
        : (_maps(server['toolDetails']).isNotEmpty
            ? _maps(server['toolDetails'])
            : [
                // 最老的一档：只有全名，没有描述（`registeredTools` 是名字清单）
                for (final full in _strings(server['registeredTools']))
                  {'name': _mcpShortName(full), 'fullName': full, 'description': ''},
              ]);
    items = [
      for (final tool in raw)
        _McpTool(
          short: '${tool['name'] ?? ''}',
          full: '${tool['fullName'] ?? ''}',
          description: '${tool['description'] ?? ''}',
        ),
    ];
  }

  final bool disabled;
  final String state;
  final String reason;
  final int declaredCount;
  final String listAt;
  final String from;
  final String query;
  final int? ageMs;
  late final List<_McpTool> items;

  /// 这份清单是**此刻**的（服务在跑），还是上一次运行时留下的
  bool get live => from == 'live' || (from.isEmpty && items.isNotEmpty && state == 'started');

  /// 这次启动**问过工具清单**没有：`ok` / `empty` / 空（老后端不给这一格，或者根本没起来过）
  String get asked => query.isNotEmpty
      ? query
      : (items.isNotEmpty
          ? 'ok'
          : (state == 'started' || state == 'stopped' ? 'unknown' : ''));

  /// 有没有一份能摆出来的清单
  bool get hasList => items.isNotEmpty;

  /// 卡片标题右边那枚徽章的数：老后端只给"此刻注册的"计数（`toolsCount`），新后端与清单同源。
  /// 取大值是有意的——**少说一件**比"徽章写着 3 件、展开里列着 5 件"好。
  int get badgeCount => declaredCount > items.length ? declaredCount : items.length;

  /// 折叠态那行摘要。四种空各说各的：**别把"没拉过"说成"0 件"**。
  String get summary {
    if (hasList) {
      final when = _stamp(listAt);
      final tail = when.isEmpty ? '' : ' · ${live ? '取于' : '上次取于'} $when';
      return '${live ? '工具' : '上次运行时的工具'} ${items.length} 件$tail';
    }
    if (asked == 'empty') return '工具清单取回来了：这个服务当前不提供工具。';
    if (state == 'disabled') return '已停用：工具清单不会更新（要试就点开关放开它）。';
    if (state == 'never-started') return '从未启动过，还没有工具清单（点「测试连接」看它给什么）。';
    return '拿不到这个服务的工具清单：日志里没有可读的启动记录。';
  }

  /// 展开态第一行：说清这份清单**是哪一刻的**，以及会不会过期。
  String get heading {
    final when = _stamp(listAt);
    if (!hasList) return '它提供的工具';
    final mark = live ? '取于' : '上次取于';
    return when.isEmpty
        ? '它提供的工具（${items.length} 件）'
        : '它提供的工具（${items.length} 件 · $mark $when）';
  }

  String get staleNote => _mcpStaleNote(ageMs, live: live, reason: reason);

  /// 展开态里那句如实的空态（**四种空各说各的**：拉过是空的 / 已停用 / 从未启动 / 记录不完整）
  String get emptyLine {
    if (asked == 'empty') return '它起来了、握手过了，工具清单是空的：这个服务当前不提供工具。';
    if (state == 'disabled') return '已停用，清单也不在手上：放开这个开关、重启主进程再看。';
    if (state == 'never-started') return '还没看到过清单：它没起来过（或者起来了但握手没走完）。';
    return '日志里没有可读的工具清单记录——不知道它有没有工具。';
  }
}

/// 全名 `mcp__{server}__{tool}` → 短名。名字不合这个形状就原样返回（按数据读，不按承诺读）。
String _mcpShortName(String fullName) {
  final at = fullName.lastIndexOf('__');
  return at >= 0 && at + 2 < fullName.length ? fullName.substring(at + 2) : fullName;
}

/// 描述那一栏的字数上限：MCP 的描述常常是整段英文，摊开会把一屏塞满。
/// 超了截断并留一个可见的「…」（界面 chrome 不渲染 Markdown，也不做 tooltip 悬停那一套）。
const int _kMcpDescChars = 88;

String _mcpClip(String text, [int max = _kMcpDescChars]) =>
    text.length <= max ? text : '${text.substring(0, max)}…';

/// "这份清单多旧"：超过一天就直说一句，别让人把几天前的清单当成此刻的。
String _mcpStaleNote(int? ageMs, {required bool live, required String reason}) {
  if (ageMs == null || live) return '';
  // 崩溃与空闲回收分开说：前者是"它出过事"（下一次调用会重新拉起），后者是"没人用它"
  if (reason == 'crashed') return '服务上次是崩掉的，这份清单是崩之前拉的：再拉起会刷新。';
  if (reason == 'shutdown') return '主进程上次退出前它被收掉了，这是那时的那份清单。';
  final days = ageMs ~/ 86400000;
  if (days >= 1) return '这份清单已经放了 $days 天：服务重新起来之后以那时拉的为准。';
  if (ageMs >= 3600000) return '这份清单是一小时以前取的：服务早回收了，下次拉起会刷新。';
  return '服务回收了，这是它上一次运行时给的那份清单。';
}

/// 超时展示词：0 是"没有超时"，不是"0 秒"
String _ms(Object? v) {
  final n = _int(v);
  if (n <= 0) return '无';
  if (n < 1000) return '${n}ms';
  final sec = n / 1000;
  return sec == sec.roundToDouble() ? '${sec.round()}s' : '${sec.toStringAsFixed(1)}s';
}

/// 截断长文案：toast 里塞一整段服务端报错会把它挤成一团，前 N 个字符说到点就够
String _clip(String text, int max) {
  final runes = text.runes;
  return runes.length <= max ? text : '${String.fromCharCodes(runes.take(max))}…';
}

/// 今天的时刻只给 HH:mm，隔天补日期（MCP 的"最近一次"常在几天前）
String _stamp(Object? v) {
  final dt = v is String && v.isNotEmpty ? DateTime.tryParse(v)?.toLocal() : null;
  if (dt == null) return '';
  final now = DateTime.now();
  final hm = '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
  final today = dt.year == now.year && dt.month == now.month && dt.day == now.day;
  return today ? hm : '${dt.month.toString().padLeft(2, '0')}-${dt.day.toString().padLeft(2, '0')} $hm';
}

String _policy(Object? v) {
  if (v == true) return '全开';
  if (v is List) return v.isEmpty ? '按名单（空）' : '按名单（${v.length} 件）';
  return '全关';
}

/// 徽章取色：表里没有的走主色（idempotent / never-started），再退到灰
Color _toneOf(ColorScheme s, String key) {
  if (key == 'idempotent' || key == 'never-started') return s.primary;
  return _tone[key] ?? s.onSurfaceVariant;
}

/// 属性徽章：底色取主色 10%、边框 35%，不用字面色值
Widget _badge(String text, Color color) => Container(
      margin: const EdgeInsets.only(right: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: color.withValues(alpha: 0.35)),
      ),
      child: Text(text, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w500)),
    );

Widget _monoText(String text) => Text(text,
    style: const TextStyle(fontFamily: 'monospace', fontSize: 11.5, height: 1.5));

Widget _small(String text) => Builder(builder: (context) {
      final scheme = Theme.of(context).colorScheme;
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text(text, style: TextStyle(fontSize: 12, height: 1.5, color: scheme.onSurfaceVariant)),
      );
    });

/// 卡片内的一行：标题（可等宽）+ 徽章 + 等宽副行 + 单行描述 + 右侧动作；
/// 技术字段（描述、路径、参数…）一律先折叠，点「详情」才铺开。
///
/// 为什么行内还要再折一层 [DetailFold]：这一页的行大多是"名字 + 一句说明"，
/// 而路径、指纹、入参 schema 这些东西平时没人看，摊开会把一屏塞满——
/// 技术字段默认收起是 docs/astrbot-benchmark.md §3.4 的口径，这里照办。
Widget _row({
  required ColorScheme cs,
  required Key key,
  required String title,
  bool titleMono = false,
  List<Widget> badges = const [],
  String monoLine = '',
  List<String> notes = const [],
  List<Widget> detail = const [],
  Widget? trailing,
}) {
  final body = Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Wrap(
        spacing: 0,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: Text(title,
                style: TextStyle(
                    fontFamily: titleMono ? 'monospace' : null,
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600)),
          ),
          ...badges,
        ],
      ),
      if (monoLine.isNotEmpty)
        Padding(padding: const EdgeInsets.only(top: 4), child: _monoText(monoLine)),
      for (final note in notes)
        Padding(
          padding: const EdgeInsets.only(top: 3),
          child: Text(note,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, height: 1.5, color: cs.onSurfaceVariant)),
        ),
      if (detail.isNotEmpty)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: DetailFold(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: detail),
          ),
        ),
    ],
  );
  if (trailing == null) {
    return KeyedSubtree(key: key, child: body);
  }
  return Row(
    // key 挂在**整行**上，不是行内那一列：测试与无障碍都要能按行定位到它的开关
    key: key,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Expanded(child: body),
      Padding(padding: const EdgeInsets.only(left: 12, top: 2), child: trailing),
    ],
  );
}

/// 列表里的卡片：标题 + 说明 + 若干行（行间一根发丝线，行数默认 8 行，其余收进「查看全部」）。
///
/// 排版与设置页的 `_SectionCard` 对齐（标题 15/w600、说明另起一行、内边距 18/16、卡片间距 18）：
/// 前几版里这些卡各写各的——标题字号差 1.5、说明挤在标题右边、间距一个靠 margin 一个靠
/// SizedBox，攒在一起就是"这个页面跟别的页不像"（v28 记的正是这件事）。
Widget _card({required String title, required String hint, required List<Widget> children}) {
  return Builder(builder: (context) {
    final s = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 18),
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      decoration: BoxDecoration(
        color: s.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: s.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
          if (hint.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(hint, style: TextStyle(fontSize: 12.5, height: 1.5, color: s.onSurfaceVariant)),
            ),
          const SizedBox(height: 10),
          CappedChildren(
            children: [
              for (final child in children)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(border: Border(top: BorderSide(color: s.outlineVariant))),
                  child: child,
                ),
            ],
          ),
        ],
      ),
    );
  });
}

/// 底部引导条：这一项**怎么加、加完过哪道门、什么时候生效**。
///
/// 为什么每项都要一条：这个页面上的四类东西各有一套"引导添加"的口径（技能要过信任门、
/// MCP 要重启、工具只是名字、Hooks 只有人能改），把它们塞进详情页头会淹没主内容，
/// 所以一律放在最下面——读完了自然会看到，要用的时候也找得到。
Widget _guide({required IconData icon, required List<String> lines}) {
  return Builder(builder: (context) {
    final s = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(top: 2),
      padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
      decoration: BoxDecoration(
        color: s.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: s.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 15, color: s.onSurfaceVariant),
              const SizedBox(width: 8),
              Text('从这里开始', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: s.onSurface)),
            ],
          ),
          for (final line in lines)
            Padding(
              padding: const EdgeInsets.only(left: 23, top: 4),
              child: Text(line, style: TextStyle(fontSize: 12, height: 1.6, color: s.onSurfaceVariant)),
            ),
        ],
      ),
    );
  });
}

/// 纪律说明条：不是"跳转去改"的入口，是把一条**边界**说清楚（Hooks 的 agent 只读）
Widget _notice(String text) => Builder(builder: (context) {
      final s = Theme.of(context).colorScheme;
      return Container(
        margin: const EdgeInsets.only(bottom: 12),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        decoration: BoxDecoration(
          color: s.surfaceContainer,
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
          border: Border.all(color: s.outlineVariant),
        ),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.lock_outline_rounded, size: 15, color: s.onSurfaceVariant),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, height: 1.6, color: s.onSurfaceVariant))),
        ]),
      );
    });

/// 行尾 icon-only 操作按钮（照 AstrBot `ConversationPage.vue:170-181` 的 actions 列）：
/// 28×28 命中区、16px 图标，文案由 tooltip 承担
Widget _iconAction(BuildContext context,
    {required IconData icon, required String tooltip, required VoidCallback? onPressed, Color? color}) {
  final s = Theme.of(context).colorScheme;
  return IconButton(
    icon: Icon(icon, size: 16, color: color ?? (onPressed == null ? s.outlineVariant : s.onSurfaceVariant)),
    tooltip: tooltip,
    onPressed: onPressed,
    padding: EdgeInsets.zero,
    constraints: const BoxConstraints.tightFor(width: 28, height: 28),
    visualDensity: VisualDensity.compact,
    style: IconButton.styleFrom(tapTargetSize: MaterialTapTargetSize.shrinkWrap),
  );
}

Widget _problem(String text) => Builder(builder: (context) {
      final s = Theme.of(context).colorScheme;
      return Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Icon(Icons.error_outline_rounded, size: 14, color: IrmiaTheme.warn),
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: TextStyle(fontSize: 12.5, height: 1.5, color: s.onSurface))),
        ],
      );
    });

/// 次级文字按钮的统一手感（扫描目录 / 全开 / 全关这一排）
ButtonStyle _textButtonStyle() => TextButton.styleFrom(
      padding: const EdgeInsets.symmetric(horizontal: 10),
      minimumSize: const Size(0, 32),
      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    );

/// 弹窗里的一个输入框（带一行标签与提示）。MCP / Hooks 那两张表单字段多，
/// 统一成一个零件，免得每处都要重写一遍 `InputDecoration` 的七个参数。
Widget _dialogField(TextEditingController controller, String label, String hint,
    {int maxLines = 1, Key? fieldKey, String? helper}) {
  return Builder(builder: (context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
          const SizedBox(height: 4),
          TextField(
            // 按 key 而不是按 hint 定位：hint 是**提示文案**（改文案就会打不到），
            // key 是契约。测试与无障碍都靠它认框（与渠道页的 field-<path> 同一手法）。
            key: fieldKey,
            controller: controller,
            maxLines: maxLines,
            autocorrect: false,
            enableSuggestions: false,
            style: const TextStyle(fontSize: 12.5),
            decoration: InputDecoration(
              isDense: true,
              hintText: hint,
              border: const OutlineInputBorder(),
            ),
          ),
          // 那一格下面的一行补充（MCP 的 desc 用它说清"留空之后她在索引里只看到名字"）
          if (helper != null && helper.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(helper, style: TextStyle(fontSize: 11, height: 1.4, color: scheme.onSurfaceVariant)),
            ),
        ],
      ),
    );
  });
}

// ──────────────────── 申请单（她发起 · 用户只做审批，2026-10-11） ────────────────────

/// 一张**待批**的申请单：她递单子（`<dataDir>/grants/<id>.json`）⇒ 框架挂出这条待批
/// ⇒ 用户在这里点「批准」或「驳回」（驳回可以写理由，写给谁看的是她）。
///
/// 三条纪律，与人格提案、`ask_human` 那两条同源（design §6 防伪）：
///   · **卡上的每一个字都是界面写死的**（标题、按钮、那一行说明）——她的原话只出现在
///     「她写的理由」那一行里，而且服务端已经洗净（去控制字符、压成一行、封顶）；
///   · 摆出来的字段全部来自 `GET /api/grants`（框架算的：命令、风险、执行结果），
///     界面**不推断**任何一格；
///   · 驳回理由**允许留空**（人不该被一个必填项挡住驳回），留空时回执里说的是
///     "人驳回了，没有给理由"——那是一句真话，不是"未批准、未拒绝"。
class GrantPendingCard extends StatelessWidget {
  const GrantPendingCard({
    super.key,
    required this.grant,
    required this.reasonController,
    required this.onApprove,
    required this.onReject,
    this.busy = false,
  });

  final Map<String, dynamic> grant;

  /// 驳回理由的输入框（**由外面持有**：重读那一屏不该把它清空——人打了一半的字还在）
  final TextEditingController reasonController;
  final Future<void> Function() onApprove;
  final Future<void> Function() onReject;

  /// 这一张正在提交（两枚按钮都禁用，防连点出两次决定）
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final id = '${grant['id'] ?? ''}';
    final name = '${grant['name'] ?? ''}';
    final kind = '${grant['kind'] ?? ''}';
    final desc = '${grant['desc'] ?? ''}';
    final command = '${grant['command'] ?? ''}';
    final args = _strings(grant['args']);
    final envKeys = _strings(grant['envKeys']);
    final reason = '${grant['reason'] ?? ''}';
    final context_ = '${grant['context'] ?? ''}';
    final expiredAt = grant['expiredAt'];
    final isAdd = kind == 'mcp-add';
    // 技能那一支：`scripts/` 下那些**可执行内容**——方案稿 D8 要的就是这一行**单列**
    // （装技能 = 引入可执行内容，而本机上真发生过：`skills/anysearch/scripts/` 里有一批脚本）
    final scriptNames = _strings(grant['scriptNames']);
    final isSkill = kind == 'skill-install' || kind == 'skill-remove';
    final title = switch (kind) {
      'mcp-add' => '她想加一个 MCP 服务',
      'mcp-remove' => '她想删掉一个 MCP 服务',
      'skill-install' => '她想装一个技能',
      'skill-remove' => '她想删掉一个技能',
      _ => '她递了一张申请单',
    };

    return Container(
      key: ValueKey('grant-$id'),
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
        border: Border.all(color: cs.outlineVariant),
        boxShadow: IrmiaTheme.hairline,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Text(title,
                  style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600)),
              _badge(isAdd || kind == 'skill-install' ? '新增' : '删除',
                  isAdd || kind == 'skill-install' ? cs.primary : IrmiaTheme.danger),
              _badge('待批', IrmiaTheme.warn),
              if (expiredAt != null) _badge('超时未答', IrmiaTheme.sleep),
            ],
          ),
          const SizedBox(height: 6),
          _monoText(name.isEmpty ? id : name),
          if (isSkill && scriptNames.isNotEmpty)
            // **风险点单列一行**（方案稿 D8）：这几个文件是会被跑起来的东西
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Padding(
                    padding: EdgeInsets.only(top: 2),
                    child: Icon(Icons.warning_amber_rounded, size: 14, color: IrmiaTheme.warn),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '它会带 ${scriptNames.length} 个可执行脚本（scripts/）：${scriptNames.join('、')}'
                      '——装了之后她会照这个技能的指示做。',
                      style: const TextStyle(fontSize: 12.5, height: 1.5),
                    ),
                  ),
                ],
              ),
            ),
          if (isAdd) ...[
            // 「它是干什么的」摆在最前：用户这一轮抱怨的正是"审批时看不出它是干什么的"
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                desc.isEmpty ? '（这份申请单里没写它是干什么的）' : desc,
                style: TextStyle(fontSize: 12.5, height: 1.5, color: cs.onSurface),
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: _monoText([command, ...args].where((s) => s.isNotEmpty).join(' ')),
            ),
            if (envKeys.isNotEmpty)
              _small('它会拿到这几个环境变量（值不显示）：${envKeys.join('、')}'),
          ],
          if (reason.isNotEmpty) _small('她写的理由：$reason'),
          if (context_.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: DetailFold(
                child: Text(context_, style: TextStyle(fontSize: 12, height: 1.6, color: cs.onSurfaceVariant)),
              ),
            ),
          const SizedBox(height: 8),
          // 批准**不带**理由输入框（没有"批准理由"这回事）；驳回**带**一格，而且允许留空。
          TextField(
            key: ValueKey('grant-reason-$id'),
            controller: reasonController,
            maxLines: 2,
            autocorrect: false,
            enableSuggestions: false,
            style: const TextStyle(fontSize: 12.5),
            decoration: const InputDecoration(
              isDense: true,
              hintText: '驳回理由（可以不写；写了她下一拍就能看到）',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              TextButton(
                key: ValueKey('grant-reject-$id'),
                onPressed: busy ? null : () => unawaited(onReject()),
                style: TextButton.styleFrom(foregroundColor: cs.onSurfaceVariant),
                child: const Text('驳回'),
              ),
              const SizedBox(width: 8),
              FilledButton.tonal(
                key: ValueKey('grant-approve-$id'),
                onPressed: busy ? null : () => unawaited(onApprove()),
                child: const Text('批准'),
              ),
              const Spacer(),
              _small('批准之后由框架写进 config.json 的 mcp.servers[]（失败会回滚原文件）'),
            ],
          ),
        ],
      ),
    );
  }
}

/// 已经答复过的那一张（批准或驳回 + 框架执行的结果）——摆在这里是为了"她申请过什么、
/// 谁批的、批完落地没有"能在同一屏里回看，而不是只留在日志里。
class GrantDoneRow extends StatelessWidget {
  const GrantDoneRow({super.key, required this.grant});

  final Map<String, dynamic> grant;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final id = '${grant['id'] ?? ''}';
    final name = '${grant['name'] ?? ''}';
    final kind = '${grant['kind'] ?? ''}';
    final outcome = '${grant['outcome'] ?? ''}';
    final approved = outcome == 'approved';
    final exec = grant['exec'] is Map ? (grant['exec'] as Map).cast<String, dynamic>() : const <String, dynamic>{};
    final state = '${exec['state'] ?? ''}';
    // 四态各说各的：**"批了但没装成"不许读成"装上了"**（判据在 grant/mcp-grant.ts 的 exec 那一格）
    final execText = switch (state) {
      'ok' => '框架已写进配置',
      'failed' => '执行没成功：${exec['failure'] ?? '（没有原因）'}',
      'skipped-stale' => '没执行：这份单子在审阅期间被改过',
      'skipped-invalid' => '没执行：${exec['failure'] ?? '落地复核没过'}',
      'not-applicable' => '驳回（没有执行）',
      _ => '',
    };
    final rejectReason = '${grant['rejectReason'] ?? ''}';
    return Padding(
      key: ValueKey('grant-done-$id'),
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _badge(approved ? '已批准' : '已驳回', approved ? IrmiaTheme.ok : IrmiaTheme.danger),
              Text('${kind == 'mcp-add' ? '加' : '删'} $name',
                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              Text(_stamp(grant['outcomeAt']),
                  style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant)),
            ],
          ),
          if (execText.isNotEmpty) _small(execText),
          if (!approved)
            _small(rejectReason.isEmpty ? '驳回时没有写理由。' : '驳回理由：$rejectReason'),
        ],
      ),
    );
  }
}


/// 弹窗关掉之后再销毁控制器。
///
/// 为什么不能就地 dispose：`showDialog` 的 Future 在**路由弹出时**就 resolve，
/// 而弹窗的退场动画还要几十毫秒才把 TextField 从树上摘掉——这期间 `didUpdateWidget`
/// 仍会去 listen 那个已经销毁的 controller，于是报 "A TextEditingController was used
/// after being disposed"（实测踩到过：弹窗一关，整页就崩）。延迟一拍最省事：
/// 退场动画（200ms）跑完再丢。代价是几百毫秒的临时对象，收益是这一页不会因为关弹窗而崩。
void _disposeSoon(List<TextEditingController> controllers) {
  Future<void>.delayed(const Duration(milliseconds: 600), () {
    for (final controller in controllers) {
      controller.dispose();
    }
  });
}

/// 多行文本 → 字符串列表（agent 表单里的 args：一行一个参数）
List<String> _lines(String text) =>
    text.split('\n').map((line) => line.trim()).where((line) => line.isNotEmpty).toList();

/// 多行文本 → env 映射（`KEY=VALUE`，一行一个；没有 `=` 的行丢掉，不塞进一个空值变量）
Map<String, String> _envPairs(String text) {
  final out = <String, String>{};
  for (final line in text.split('\n')) {
    final trimmed = line.trim();
    if (trimmed.isEmpty) continue;
    final at = trimmed.indexOf('=');
    if (at <= 0) continue;
    out[trimmed.substring(0, at).trim()] = trimmed.substring(at + 1).trim();
  }
  return out;
}

/// 表单里的一个字段定义（[_formDialog] 用）：key 是回传时的字段名
class _FormField {
  const _FormField({
    required this.key,
    required this.label,
    required this.hint,
    this.maxLines = 1,
    this.validator,
  });

  final String key;
  final String label;
  final String hint;
  final int maxLines;

  /// 返回非 null 即错误文案；为空时按钮不提交（在弹窗里当场说清楚，省一次往返）
  final String? Function(String value)? validator;
}

/// 通用小表单弹窗：标题 + 说明 + 若干个输入框 + 取消/创建。
///
/// 为什么自己写而不复用 `showDialog`：这一页有四处"填两个字段建个东西"（新建技能、
/// 添加服务、添加钩子…），各写一遍会把同一套校验/布局抄四份。
/// 校验在**这里**做（而不是等 POST 回来）：名字不合规这种错，当场说比绕一圈说清楚。
Future<Map<String, String>?> _formDialog(
  BuildContext context, {
  required String title,
  required String hint,
  required List<_FormField> fields,
  String confirmLabel = '创建',
}) async {
  final controllers = {for (final field in fields) field.key: TextEditingController()};
  final errors = <String, String?>{};
  final result = await showDialog<Map<String, String>>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (builderContext, setDialogState) {
        final scheme = Theme.of(builderContext).colorScheme;
        return AlertDialog(
          constraints: const BoxConstraints(minWidth: 400, maxWidth: 520),
          title: Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(hint, style: TextStyle(fontSize: 12, height: 1.7, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 12),
                for (final field in fields) ...[
                  Text(field.label, style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 4),
                  TextField(
                    key: ValueKey('form-${field.key}'),
                    controller: controllers[field.key],
                    maxLines: field.maxLines,
                    autocorrect: false,
                    enableSuggestions: false,
                    style: const TextStyle(fontSize: 12.5),
                    decoration: InputDecoration(
                      isDense: true,
                      hintText: field.hint,
                      errorText: errors[field.key],
                      border: const OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(null),
              style: TextButton.styleFrom(foregroundColor: scheme.onSurfaceVariant),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () {
                final out = <String, String>{};
                var bad = false;
                for (final field in fields) {
                  final value = controllers[field.key]!.text.trim();
                  final message = value.isEmpty ? '这一项不能为空' : field.validator?.call(value);
                  errors[field.key] = message;
                  if (message != null) bad = true;
                  out[field.key] = value;
                }
                if (bad) {
                  setDialogState(() {});
                  return;
                }
                Navigator.of(dialogContext).pop(out);
              },
              child: Text(confirmLabel),
            ),
          ],
        );
      },
    ),
  );
  // 退场动画跑完再销毁：见 _disposeSoon 的注释
  _disposeSoon(controllers.values.toList());
  return result;
}
