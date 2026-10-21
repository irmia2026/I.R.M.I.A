// TODO(i18n): 本文件还有 31 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/logs_panels.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
part of 'logs_page.dart';

/// 概览与事件两个 tab：状态留在 _LogsPageState，这里只负责把数据摆出来
extension _LogsPanels on _LogsPageState {
  // ─── 概览：用量 + 告警落盘 + 自检 ───

  Widget overviewTab(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (budgetLoading) return const _StateBlock(title: '正在加载用量数据…', loading: true);
    if (budgetError != null) return _StateBlock(title: '预算数据读取失败', detail: budgetError, onRetry: loadBudget);
    final d = budget;
    if (d == null) return const _StateBlock(title: '暂无用量记录', detail: '该时间段内没有模型调用。');

    final today = _map(d['today']);
    final limits = _map(d['limits']);
    final month = _map(d['month']);
    final hard = _int(limits['dailyTokens']);
    final softRatio = (limits['softRatio'] as num?)?.toDouble() ?? 0.8;
    final total = _int(today['tokens']);
    final hitRate = (today['hitRate'] as num?)?.toDouble();
    final series = _maps(budgetRange == 'today' ? d['hourly'] : d['daily']);
    final tokenSeries = series.map((p) => _int(p['tokens']).toDouble()).toList();
    final hitSeries = series.map(_hitRate).toList();
    final turns = _maps(d['turns']).reversed.take(20).toList();
    final peak = tokenSeries.isEmpty ? 0 : tokenSeries.reduce((a, b) => a > b ? a : b).round();

    return ListView(
      padding: const EdgeInsets.fromLTRB(26, 16, 26, 30),
      children: [
        Row(
          children: [
            _TabBar(
              labels: const ['今日', '近 7 天'],
              index: budgetRange == 'today' ? 0 : 1,
              onPick: (i) {
                final next = i == 0 ? 'today' : '7d';
                if (next == budgetRange) return;
                apply(() => budgetRange = next);
                unawaited(loadBudget());
              },
            ),
          ],
        ),
        const SizedBox(height: 14),
        Row(
          children: [
            Expanded(
              child: _LaneCard(
                label: 'heavy lane',
                tokens: _int(today['heavy']),
                total: total,
                hardLimit: hard,
                softRatio: softRatio,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _LaneCard(
                label: 'light lane',
                tokens: _int(today['light']),
                total: total,
                hardLimit: hard,
                softRatio: softRatio,
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        _card(
          context,
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(budgetRange == 'today' ? '24 小时' : '近 7 天',
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  Text('缓存命中率 ${hitRate == null ? '—' : '${(hitRate * 100).round()}%'}',
                      style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                ],
              ),
              const SizedBox(height: 10),
              if (tokenSeries.length < 2)
                Text('暂无序列数据', style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant))
              else ...[
                // 峰值与卡片、页脚同源（`logsPeakLine` → format.dart）：这个数也是非缓存口径
                Text(logsPeakLine(peak),
                    style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                _Spark(values: tokenSeries, color: scheme.primary),
                const SizedBox(height: 12),
                Text('缓存命中率 · 0 → 100%', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                _Spark(values: hitSeries, color: IrmiaTheme.ok),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        _card(
          context,
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('最近 turn 明细', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  const Spacer(),
                  TextButton(onPressed: openTurnFromStats, child: const Text('打开事件')),
                ],
              ),
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 6),
                child: Row(
                  children: [
                    SizedBox(width: 46, child: _HeadText('turn')),
                    Expanded(child: _HeadText('结束原因')),
                    SizedBox(width: 76, child: _HeadText('输入', end: true)),
                    SizedBox(width: 76, child: _HeadText('输出', end: true)),
                    SizedBox(width: 68, child: _HeadText('耗时', end: true)),
                  ],
                ),
              ),
              if (turns.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Text('暂无 turn 明细', style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
                )
              else
                // 默认 8 行，其余收进「查看全部」（§3.4）
                CappedChildren(children: [for (final t in turns) _turnRow(context, t)]),
              const Divider(height: 18),
              // 页脚与两张 lane 卡说的是同一件事（都是非缓存口径的 token 累计），
              // 数字走 `logsMonthLine` → `format.dart`：同一个数在这里和运行情况页长得一样
              Text(
                logsMonthLine(_int(month['tokens']), _int(month['turns']), _int(month['avgPerTurn'])),
                style: TextStyle(fontSize: 12, height: 1.6, color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        alarmSection(context),
        const SizedBox(height: 12),
        doctorSection(context),
        const SizedBox(height: 10),
        // 限额来源等技术字段默认收起：概览只留结论
        DetailFold(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DetailRow(label: '预算限额来源', value: '${d['limitSource'] ?? 'default'}'),
              DetailRow(label: '统计范围', value: budgetRange == 'today' ? '今日' : '近 7 天'),
              DetailRow(label: '窗口点数', value: '${series.length} 点'),
            ],
          ),
        ),
      ],
    );
  }

  Widget _turnRow(BuildContext context, Map<String, dynamic> t) {
    final scheme = Theme.of(context).colorScheme;
    final kind = t['reasonKind']?.toString();
    final ms = _int(t['durationMs']);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        children: [
          SizedBox(width: 46, child: Text('${t['turn'] ?? '-'}', style: _mono(12.5, scheme.onSurface))),
          Expanded(
            child: Text(kind ?? '—',
                style: TextStyle(fontSize: 12.5, color: _reasonTone(kind) ?? scheme.onSurface)),
          ),
          SizedBox(
            width: 76,
            child: Text(logsCompactTokens(_int(t['input'])), textAlign: TextAlign.right, style: _mono(12.5, scheme.onSurface)),
          ),
          SizedBox(
            width: 76,
            child: Text(logsCompactTokens(_int(t['output'])), textAlign: TextAlign.right, style: _mono(12.5, scheme.onSurface)),
          ),
          SizedBox(
            width: 68,
            child: Text(ms >= 1000 ? '${(ms / 1000).toStringAsFixed(1)}s' : '${ms}ms',
                textAlign: TextAlign.right, style: _mono(12.5, scheme.onSurfaceVariant)),
          ),
        ],
      ),
    );
  }

  // ─── 事件 ───

  Widget eventsTab(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(26, 16, 26, 0),
          child: Row(
            children: [
              _TypeMenu(picked: picked, onToggle: toggleType, onClear: clearTypes),
              const SizedBox(width: 10),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10),
                decoration: BoxDecoration(
                  color: scheme.surface,
                  border: Border.all(color: scheme.outlineVariant),
                  borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
                ),
                child: DropdownButton<int>(
                  value: evLimit,
                  isDense: true,
                  underline: const SizedBox.shrink(),
                  style: TextStyle(fontSize: 12.5, color: scheme.onSurface),
                  items: const [
                    DropdownMenuItem(value: 100, child: Text('100 条')),
                    DropdownMenuItem(value: 200, child: Text('200 条')),
                    DropdownMenuItem(value: 500, child: Text('500 条')),
                  ],
                  onChanged: (value) {
                    if (value == null || value == evLimit) return;
                    apply(() => evLimit = value);
                    unawaited(loadEvents(reset: true));
                  },
                ),
              ),
              const Spacer(),
              TextButton.icon(
                onPressed: () => unawaited(loadEvents(reset: true)),
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: const Text('重新加载'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        Expanded(child: _eventsBody(context)),
        Padding(
          padding: const EdgeInsets.fromLTRB(26, 6, 26, 14),
          child: Row(
            children: [
              if (evCursor != null)
                TextButton(
                  onPressed: () => unawaited(loadEvents(fromSeq: evCursor)),
                  child: Text('加载更早一批（$evLimit 条）'),
                ),
              if (events.length > kListCap) ...[
                if (evCursor != null) const SizedBox(width: 8),
                TextButton(
                  onPressed: () => apply(() => evAll = !evAll),
                  child: Text(evAll ? '收起' : '查看全部（${events.length} 条）'),
                ),
              ],
              const Spacer(),
              Text('本地共 ${events.length} 条', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _eventsBody(BuildContext context) {
    if (events.isEmpty) {
      if (evLoading) return const _StateBlock(title: '正在读取事件…', loading: true);
      if (evError != null) {
        return _StateBlock(title: '事件读取失败', detail: evError, onRetry: () => loadEvents(reset: true));
      }
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(26),
          child: GuideBar(
            icon: Icons.article_outlined,
            text: picked.isEmpty ? '还没有事件日志。' : '还没有匹配的事件。',
            actionLabel: '重新加载',
            onAction: () => unawaited(loadEvents(reset: true)),
            hint: picked.isEmpty
                ? '事件由 agent 运行期写入；本进程尚未读到任何一条。'
                : '可放宽类型过滤条件，或等待新事件写入。',
          ),
        ),
      );
    }
    final shown = evAll ? events.length : (events.length > kListCap ? kListCap : events.length);
    return ListView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 26),
      itemCount: shown,
      itemBuilder: (context, i) {
        final ev = events[i];
        final seq = _int(ev['seq']);
        return _EventRow(
          ev: ev,
          open: openSeq == seq,
          onTap: () => apply(() => openSeq = openSeq == seq ? null : seq),
        );
      },
    );
  }
}
