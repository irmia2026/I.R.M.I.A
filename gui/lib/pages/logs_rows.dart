// TODO(i18n): 本文件还有 23 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/logs_rows.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
part of 'logs_page.dart';

/// 事件摘要：与 web/pages/logs.js 的 summarize 同一张表
String _summary(Map<String, dynamic> ev) {
  final d = _map(ev['data']);
  switch (_str(ev['type'])) {
    case 'tool/call':
      return '${d['name'] ?? '工具'}(${_brief(d['arguments'])})';
    case 'tool/result':
      return '${d['status'] ?? '结果'} · ${_brief(d['content'])}';
    case 'budget/consumed':
      // 归因（`context`）是这条事件上的一个字段：有它就缀一句"整条多大"（点开有整条等式），
      // 没有（旧日志、或这条不是模型记账）就照旧只报这笔用量
      return '+${logsCompactTokens(_int(d['inputTokens']))}↑ +${logsCompactTokens(_int(d['outputTokens']))}↓ (hit ${logsCompactTokens(_int(d['cacheHitTokens']))}) ${d['lane'] ?? ''}'
          '${_contextWhole(d) == null ? '' : ' · 归因 ${logsCompactTokens(_contextWhole(d)!)}'}';
    case 'budget/resumed':
      return _resumedLine(d);
    case 'turn/end':
      return d['reason'] is Map ? _str(_map(d['reason'])['kind']) : '结束原因未知';
    case 'turn/start':
      return 'turn ${d['turn'] ?? '-'}';
    case 'step/start':
      return 'turn ${d['turn'] ?? '-'} step ${d['step'] ?? '-'} · ${d['model'] ?? ''}';
    case 'step/end':
      return '${d['toolCalls'] ?? 0} 次工具调用';
    case 'wake/manual':
      return '手动唤醒 · ${_brief(d['note'], 60)}';
    case 'wake/timer':
      return '定时器 ${d['timerId'] ?? ''}';
    case 'wake/file':
      return '${d['kind'] ?? '变更'} · ${d['path'] ?? ''}';
    case 'wake/webhook':
      return 'webhook ${d['path'] ?? ''}';
    case 'wake/channel':
      return '${d['channel'] ?? '通道'} · ${_brief(d['text'], 60)}';
    case 'speak/sent':
      return '${d['channel'] ?? ''} → ${_brief(d['text'], 60)}';
    case 'wake/heartbeat':
      return '心跳 · 空拍 ${d['idleTicks'] ?? 0}';
    case 'message/assistant':
      final text = _brief(d['text'], 70);
      return text.isEmpty ? '工具调用 ${(d['toolCalls'] as List?)?.length ?? 0} 个' : text;
    case 'message/user':
      return _brief(d['text'], 70);
    case 'policy/denied':
      return '${d['tool'] ?? '工具'} 已拦截：${d['rule'] ?? ''} · ${_brief(d['reason'], 50)}';
    case 'alarm/sent':
      return '${d['level'] ?? ''} · ${_brief(d['title'], 60)}';
    case 'session/start':
      return 'pid ${d['pid'] ?? ''} · schema ${d['schemaVersion'] ?? ''}';
    case 'instance/takeover':
      return '接管旧实例 pid ${d['previousPid'] ?? ''}';
    case 'model/degraded':
      return '${d['lane'] ?? ''} 降级：${_brief(d['reason'], 50)}';
    default:
      return _brief(d, 90);
  }
}

/// lane 大数字卡：进度条走「该 lane 今日消耗 / 日层硬上限」，软线由 softRatio 标出
class _LaneCard extends StatelessWidget {
  const _LaneCard({
    required this.label,
    required this.tokens,
    required this.total,
    required this.hardLimit,
    required this.softRatio,
  });

  final String label;
  final int tokens;
  final int total;
  final int hardLimit;
  final double softRatio;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final soft = (hardLimit * softRatio).round();
    final ratio = hardLimit > 0 ? (tokens / hardLimit).clamp(0.0, 1.0).toDouble() : 0.0;
    final tone = hardLimit > 0 && tokens > hardLimit
        ? IrmiaTheme.danger
        : (hardLimit > 0 && tokens > soft ? IrmiaTheme.warn : scheme.primary);
    return _card(
      context,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(label, style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
              const SizedBox(width: 6),
              // 口径词摆在卡头：这张卡上的数**计入预算**，而非缓存口径是它唯一的语义
              //（2026-10-05 换的口径：`(input − cacheHit) + output`，见 state/fold.ts）
              Text('· $kBudgetMetricLabel',
                  style: TextStyle(fontSize: 10.5, color: scheme.onSurfaceVariant.withValues(alpha: 0.85))),
              const Spacer(),
              Text(total > 0 ? '占今日 ${(tokens / total * 100).round()}%' : '—',
                  style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(height: 6),
          // 卡面印紧凑写法（2.7M），悬停给真数（2,705,946）——两者由同一个函数给
          Tooltip(
            message: logsTokensTooltip(tokens),
            child: Text(logsCompactTokens(tokens),
                style: const TextStyle(
                    fontSize: 26, fontWeight: FontWeight.w600, fontFeatures: [FontFeature.tabularFigures()])),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 6,
            child: Stack(
              children: [
                Container(
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(4),
                  ),
                ),
                FractionallySizedBox(
                  widthFactor: ratio,
                  child: Container(
                    decoration: BoxDecoration(color: tone, borderRadius: BorderRadius.circular(4)),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          // 这一行是"预算卡有没有跟着设置一起变"最直接的读法：硬上限与软线都印出来。
          // 三个数走 `logsLimitLine`（同一处格式化），口径词一行说一次。
          Text(
            logsLimitLine(tokens, hardLimit, soft),
            style: TextStyle(fontSize: 11.5, height: 1.5, color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _TypeMenu extends StatelessWidget {
  const _TypeMenu({required this.picked, required this.onToggle, required this.onClear});

  final Set<String> picked;
  final ValueChanged<String> onToggle;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return PopupMenuButton<void>(
      tooltip: '按类型过滤',
      itemBuilder: (context) => [
        for (final group in _eventGroups.entries) ...[
          PopupMenuItem<void>(
            enabled: false,
            height: 28,
            child: Text(group.key,
                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
          ),
          for (final type in group.value)
            PopupMenuItem<void>(
              height: 32,
              onTap: () => onToggle(type),
              child: Row(
                children: [
                  Icon(
                    picked.contains(type) ? Icons.check_box_rounded : Icons.check_box_outline_blank_rounded,
                    size: 15,
                    color: picked.contains(type) ? scheme.primary : scheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 8),
                  // 显示名走 `_typeLabels`（logs_widgets.dart：人话名字表），
                  // 勾选与过滤用的仍然是**事件类型**本身——服务端只按 type 过滤，见那张表的注释
                  Text(_typeLabels[type] ?? type,
                      style: _mono(11.5, picked.contains(type) ? scheme.primary : scheme.onSurface)),
                ],
              ),
            ),
        ],
        const PopupMenuDivider(),
        PopupMenuItem<void>(height: 32, onTap: onClear, child: const Text('清空过滤', style: TextStyle(fontSize: 12.5))),
      ],
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          color: scheme.surface,
          border: Border.all(color: scheme.outlineVariant),
          borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.filter_list_rounded, size: 15, color: scheme.onSurfaceVariant),
            const SizedBox(width: 6),
            Text(picked.isEmpty ? '类型：全部' : '类型：${picked.length} 个', style: const TextStyle(fontSize: 12.5)),
            const SizedBox(width: 2),
            Icon(Icons.expand_more_rounded, size: 16, color: scheme.onSurfaceVariant),
          ],
        ),
      ),
    );
  }
}

/// 事件行：时间等宽 + 类型徽章 + 摘要；点开给详情（seq / 可见性 / 来源 + 原始 JSON）
class _EventRow extends StatelessWidget {
  const _EventRow({required this.ev, required this.open, required this.onTap});

  final Map<String, dynamic> ev;
  final bool open;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final type = _str(ev['type']);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 9),
            child: Row(
              children: [
                SizedBox(width: 66, child: Text(_hms(ev['ts']?.toString()), style: _mono(11.5, scheme.onSurfaceVariant))),
                _Badge(type, tone: _typeTone(context, type)),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(_summary(ev),
                      maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13)),
                ),
                Icon(open ? Icons.expand_less_rounded : Icons.expand_more_rounded,
                    size: 16, color: scheme.onSurfaceVariant),
              ],
            ),
          ),
        ),
        if (open)
          Container(
            margin: const EdgeInsets.only(bottom: 8),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // 技术字段（seq / 可见性 / 来源）默认收起：行上只留时间与摘要
                DetailRow(label: '序列号', value: '#${ev['seq'] ?? '—'}'),
                DetailRow(label: '可见性', value: _str(ev['visibility']).isEmpty ? 'internal' : _str(ev['visibility'])),
                DetailRow(label: '来源', value: _str(ev['origin']).isEmpty ? '—' : _str(ev['origin'])),
                // 有"人话"可读的事件（上下文归因 / 预算暂停解除）在原始 JSON **之前**先给人读的那一行：
                // 这两类事件的原始 JSON 是一张字段表，人得自己在脑子里加一遍（归因的"整条"尤其）
                if (_detailLine(ev) != null) ...[
                  const SizedBox(height: 8),
                  Text('读法', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
                  const SizedBox(height: 6),
                  SelectableText(_detailLine(ev)!, style: _mono(11.5, scheme.onSurface)),
                ],
                const SizedBox(height: 8),
                Text('原始 JSON', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 6),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 260),
                  child: SingleChildScrollView(
                    child: SelectableText(_jsonEncoder.convert(ev), style: _mono(11.5, scheme.onSurface)),
                  ),
                ),
              ],
            ),
          ),
        Divider(height: 1, color: scheme.outlineVariant),
      ],
    );
  }
}
