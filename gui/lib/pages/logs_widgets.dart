// TODO(i18n): 本文件还有 22 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/logs_widgets.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
part of 'logs_page.dart';

const _jsonEncoder = JsonEncoder.withIndent('  ');

/// 事件类型分组：与 Web 端同一张表，过滤菜单照它排布
const _eventGroups = <String, List<String>>{
  '生命周期': ['session/start', 'session/end', 'turn/start', 'turn/end', 'step/start', 'step/end'],
  '消息': ['message/user', 'message/assistant', 'message/reasoning', 'developer/message'],
  '工具': ['tool/call', 'tool/result', 'tool/zombie'],
  '唤醒与队列': ['wake/timer', 'wake/file', 'wake/webhook', 'wake/manual', 'wake/heartbeat', 'wake/intention', 'wake/job', 'wake/channel', 'timer/set', 'timer/fired', 'timer/cancelled', 'input/claimed', 'input/dead-letter', 'input/requeued'],
  '预算': ['budget/consumed', 'budget/rollover', 'budget/exhausted', 'budget/topped-up', 'budget/resumed'],
  '策略与审计': ['policy/denied', 'log/repaired', 'instance/takeover', 'alarm/sent', 'review/resolved', 'snapshot/checkpoint', 'compaction/summary', 'persona/updated', 'config/changed'],
  '扩展面': ['mcp/server-started', 'mcp/server-stopped', 'skill/installed', 'hook/fired', 'speak/sent', 'intention/raised', 'intention/acted', 'todo/updated', 'job/started', 'job/finished', 'human/asked', 'human/answered', 'human/expired', 'model/degraded', 'model/restored'],
};

/// 过滤器里的「人话名字」：条目的**值仍然是事件类型**（过滤是服务端按 `types=` 做的，
/// 见 logs_page 的 `loadEvents`），这里只换显示名。
///
/// 「上下文归因」为什么是 `budget/consumed` 的一个名字、而不是另开一条（2026-10-04）：
///   · 归因（`budget/consumed.context`）**不是一个事件类型**，它是那条预算事件上的一个字段
///     ——框架自己定过"归因挂在已有事件上，不新增类型"（见 src/model/context-audit.ts 的文件头）；
///   · 服务端只按类型过滤（精确匹配，或以 `/` 结尾时前缀匹配），编一个
///     `budget/consumed.context` 的假类型过去**一条都匹配不到**；
///   · 所以它按既有分法归到「预算」组（与其余四条同域），落点就是它所在的那个类型。
///   代价说清：选「上下文归因」等于选 `budget/consumed`（那一屏里既有带归因的、也有不带的），
///   而"这条到底有没有归因"在**行摘要**上就看得出来（带归因的那行会缀「归因 X」，
///   点开还有整条等式）——比多一条匹配不到任何东西的假类型诚实。
///   （显示名也**不能太长**：菜单项的宽度是有限的，'上下文归因（budget/consumed）' 实测会把
///   那一行撑出 22px 溢出——多出来的那截类型名放注释里，别放在菜单上。）
const _typeLabels = <String, String>{
  'budget/consumed': '上下文归因',
};

// ─── 取值与格式化 ───

int _int(Object? value) => value is num ? value.toInt() : 0;

String _str(Object? value) => value?.toString() ?? '';

Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const <String, dynamic>{};

List<Map<String, dynamic>> _maps(Object? value) => (value is List ? value : const [])
    .whereType<Map>()
    .map((e) => e.cast<String, dynamic>())
    .toList();

double _hitRate(Map<String, dynamic> point) {
  final hit = _int(point['hit']).toDouble();
  final miss = _int(point['miss']).toDouble();
  return hit + miss == 0 ? 0.0 : hit / (hit + miss);
}

String _clip(String text, [int max = 80]) => text.length <= max ? text : '${text.substring(0, max)}…';

String _brief(Object? value, [int max = 70]) {
  if (value == null) return '';
  if (value is String) return _clip(value, max);
  try {
    return _clip(_jsonEncoder.convert(value), max);
  } catch (_) {
    return _clip(value.toString(), max);
  }
}

String _short(Object? hash) {
  final text = _str(hash);
  if (text.isEmpty) return '未知';
  return text.length <= 8 ? text : text.substring(0, 8);
}

// 千分位那个与 k/M/G 那个都搬去了 `../format.dart`
//（2026-10-05：单位格式只能有一处实现，见 `logs_format.dart` 的文件头）。
// 这一页剩下的"人话"（归因等式、解除那句话）印的是**精确整数**——那是给人逐位核对的，
// 不是读量级的，所以它们走 `formatExact`（同一个函数，同一份千分位规则）。

String _p2(int value) => value.toString().padLeft(2, '0');

String _hms(String? iso) {
  final dt = DateTime.tryParse(iso ?? '')?.toLocal();
  if (dt == null) return '--:--:--';
  return '${_p2(dt.hour)}:${_p2(dt.minute)}:${_p2(dt.second)}';
}

String _stamp(String? iso) {
  final dt = DateTime.tryParse(iso ?? '')?.toLocal();
  if (dt == null) return '—';
  return '${_p2(dt.month)}-${_p2(dt.day)} ${_p2(dt.hour)}:${_p2(dt.minute)}';
}

TextStyle _mono(double size, Color color) => TextStyle(
      fontFamily: 'monospace',
      fontSize: size,
      color: color,
      fontFeatures: const [FontFeature.tabularFigures()],
    );

// ─── 两条"事实类"事件的人话（唯一实现：行摘要与详情面板共用，界面不写第二份措辞） ───

// 千分位那份实现在 `../format.dart` 的 `formatExact`（本地那份与它逐字相同，已合并）：
// 与 TS 侧 `context-audit.ts` 的 `exact()` 同一口径——归因那一行是给人**核对**的，
// 两千和三千不能都印成"0.2万"。

int _segTokens(Map<String, dynamic> segment) => _int(segment['tokens']);

/// 归因里的"整条"（指令 + 工具 + input 段）。三者是**顶层三段**，`input.tokens` 不含前两段——
/// 这正是当初"合计比前面几项之和还小"那个读起来像瞎写的 bug（见 context-audit.ts `describeContext`）。
int? _contextWhole(Map<String, dynamic> data) {
  final context = data['context'];
  if (context is! Map) return null;
  final ctx = context.cast<String, dynamic>();
  return _segTokens(_map(ctx['instructions'])) + _segTokens(_map(ctx['tools'])) + _segTokens(_map(ctx['input']));
}

/// 上下文归因 → 一行人话（`src/model/context-audit.ts` 的 `describeContext` 的界面版）。
///
/// 口径与那边逐条对齐：**整条 = 指令 + 工具 + input 段**，每项精确整数、等式两边按定义相等；
/// 固定块（B2）在旧记录里没有那一段，没有就**不印**（印 0 会被读成"当时这一段是空的"）；
/// 措辞里**不出现任何价格/货币字样**（用户明确不要计价）。
/// 没有 `context` 字段（旧日志，或这条不是模型记账）返回 null——调用方据此退回原来的摘要。
String? _contextLine(Map<String, dynamic> data) {
  final context = data['context'];
  if (context is! Map) return null;
  final ctx = context.cast<String, dynamic>();
  final instructions = _map(ctx['instructions']);
  final tools = _map(ctx['tools']);
  final input = _map(ctx['input']);
  final history = _map(ctx['history']);
  final segments = <String>['记忆 ${formatExact(_segTokens(_map(ctx['memory'])))}'];
  final state = ctx['state'];
  if (state is Map) {
    segments.add('固定块 ${formatExact(_segTokens(state.cast<String, dynamic>()))}');
  }
  segments
    ..add('历史 ${formatExact(_segTokens(history))}（${_int(history['items'])} 条）')
    ..add('此刻层 ${formatExact(_segTokens(_map(ctx['now'])))}');
  // 这两段为 0 时不印：它们不是"当时是空的"，而是"那一步没有这一格"
  if (_segTokens(_map(ctx['wake'])) > 0) segments.add('本轮输入 ${formatExact(_segTokens(_map(ctx['wake'])))}');
  if (_segTokens(_map(ctx['hint'])) > 0) segments.add('尾部插播 ${formatExact(_segTokens(_map(ctx['hint'])))}');
  return '整条 ${formatExact(_contextWhole(data) ?? 0)} = 指令 ${formatExact(_segTokens(instructions))}'
      ' + 工具 ${formatExact(_segTokens(tools))}（${_int(tools['count'])} 件）'
      ' + input 段 ${formatExact(_segTokens(input))}（${segments.join(' · ')}）';
}

/// `budget/resumed` → 一行人话：哪一层、谁解的、凭什么解的、解除那一刻两个数是多少。
///
/// 两个数都是**解除那一刻**的（`actual` 是已用量、`limit` 是**有效上限**＝基础上限＋累计加注）——
/// 当时撞线的那个数不在这里，它在解除之前那条 `budget/exhausted` 里（见 src/log/types.ts）。
String _resumedLine(Map<String, dynamic> data) {
  final why = _str(data['reason']) == 'limit-raised' ? '配置里的上限被调大' : '累计加注把上限抬高了';
  return '${_str(data['layer'])} 层暂停已解除：已用 ${formatExact(_int(data['actual']))}'
      ' / 有效上限 ${formatExact(_int(data['limit']))}（$why）';
}

/// 详情面板顶上那段"读法"：有归因给归因等式，`budget/resumed` 给解除那句话，其余返回 null
/// （返回 null 就不显示这一段——行摘要已经说得清，原始 JSON 照旧在下面）。
String? _detailLine(Map<String, dynamic> ev) {
  final data = _map(ev['data']);
  if (_str(ev['type']) == 'budget/resumed') return _resumedLine(data);
  return _contextLine(data);
}

Widget _card(BuildContext context, Widget child) {
  final scheme = Theme.of(context).colorScheme;
  return Container(
    padding: const EdgeInsets.all(16),
    decoration: BoxDecoration(
      color: scheme.surface,
      borderRadius: BorderRadius.circular(IrmiaTheme.radiusCard),
      border: Border.all(color: scheme.outlineVariant),
      boxShadow: IrmiaTheme.hairline,
    ),
    child: child,
  );
}

/// 结局色调：失败红、预算类黄，其余保持正文色
Color? _reasonTone(String? kind) {
  if (kind == null) return null;
  if (kind.contains('fail') || kind.contains('error')) return IrmiaTheme.danger;
  if (kind.contains('budget') || kind.contains('abort')) return IrmiaTheme.warn;
  return null;
}

Color _typeTone(BuildContext context, String type) {
  final scheme = Theme.of(context).colorScheme;
  const danger = ['policy/denied', 'input/dead-letter', 'log/repaired'];
  if (danger.contains(type) || type.startsWith('tool/zombie')) return IrmiaTheme.danger;
  if (type.startsWith('budget/')) return IrmiaTheme.warn;
  if (type.startsWith('tool/')) return scheme.primary;
  return scheme.onSurfaceVariant;
}

// ─── 基础小组件 ───

class _TabBar extends StatelessWidget {
  const _TabBar({required this.labels, required this.index, required this.onPick});

  final List<String> labels;
  final int index;
  final ValueChanged<int> onPick;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: scheme.surfaceContainer,
        borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var i = 0; i < labels.length; i++)
            Padding(
              padding: EdgeInsets.only(right: i < labels.length - 1 ? 3 : 0),
              child: Material(
                color: i == index ? scheme.surface : Colors.transparent,
                borderRadius: BorderRadius.circular(6),
                child: InkWell(
                  borderRadius: BorderRadius.circular(6),
                  onTap: () => onPick(i),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 7),
                    child: Text(
                      labels[i],
                      style: TextStyle(
                        fontSize: 13,
                        fontWeight: i == index ? FontWeight.w600 : FontWeight.w400,
                        color: i == index ? scheme.primary : scheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _HeadText extends StatelessWidget {
  const _HeadText(this.text, {this.end = false});

  final String text;
  final bool end;

  @override
  Widget build(BuildContext context) => Text(
        text,
        textAlign: end ? TextAlign.right : TextAlign.left,
        style: TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
        ),
      );
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, {this.tone});

  final String text;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    final color = tone ?? Theme.of(context).colorScheme.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(text, style: _mono(11, color)),
    );
  }
}

class _StateBlock extends StatelessWidget {
  const _StateBlock({required this.title, this.detail, this.loading = false, this.onRetry});

  final String title;
  final String? detail;
  final bool loading;
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(26),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (loading) const CircularProgressIndicator(),
            if (loading) const SizedBox(height: 14),
            Text(title, style: TextStyle(fontSize: 13.5, color: scheme.onSurfaceVariant)),
            if (detail != null && detail!.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(detail!,
                  textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              OutlinedButton(onPressed: () => unawaited(onRetry!()), child: const Text('重试')),
            ],
          ],
        ),
      ),
    );
  }
}

class _Spark extends StatelessWidget {
  const _Spark({required this.values, required this.color});

  final List<double> values;
  final Color color;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: 34,
        width: double.infinity,
        child: CustomPaint(painter: _SparkPainter(values: values, color: color)),
      );
}

class _SparkPainter extends CustomPainter {
  _SparkPainter({required this.values, required this.color});

  final List<double> values;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) => IrmiaTheme.paintSparkline(canvas, size, values, color);

  @override
  bool shouldRepaint(_SparkPainter old) => old.values != values || old.color != color;
}
