// TODO(i18n): 本文件还有 38 处硬编码中文字符串字面量未迁（2026-10-17 盘点，lib/pages/logs_ops.dart）。
// 迁移口径在 lib/i18n/app_strings.dart：往 AppStrings 里加 getter（ZhStrings / EnStrings 各实现一次），
// 页面里 `final s = IrmiaStrings.of(context);` 之后取用，**别在页面里拼字符串**（语序因语言而异）。
// 不许迁的：她的人设文案、她的发言/记忆正文、她说话的口吻——那是内容，不是界面的一层皮。
part of 'logs_page.dart';

/// 概览里的告警落盘与自检两块（原为独立 tab，现并入概览折叠区），以及追踪 tab
extension _LogsOps on _LogsPageState {
  // ─── 概览 · 告警落盘（折叠区；空态给引导条） ───

  Widget alarmSection(BuildContext context) {
    if (alarmsLoading && alarms == null) return _loadingCard(context, '正在读取告警目录…');
    final message = alarmsError;
    if (message != null) {
      return _card(context, _inlineError(context, '告警目录读取失败', message, loadAlarms));
    }
    final files = _maps(alarms?['files']);
    if (files.isEmpty) {
      return GuideBar(
        icon: Icons.notifications_none_rounded,
        text: '还没有告警落盘。',
        actionLabel: '重新加载',
        onAction: () => unawaited(loadAlarms()),
        hint: '首次告警发出后创建该目录；目录存在但无文件同样按空态处理。',
      );
    }
    return DetailFold(
      label: '告警落盘（${files.length} 个文件）',
      child: SizedBox(
        height: 280,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(width: 210, child: _alarmList(context, files)),
            const SizedBox(width: 12),
            Expanded(child: _alarmBody(context)),
          ],
        ),
      ),
    );
  }

  Widget _alarmList(BuildContext context, List<Map<String, dynamic>> files) {
    final scheme = Theme.of(context).colorScheme;
    final curName = alarmCur?['name']?.toString();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('文件', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            const Spacer(),
            TextButton(
              onPressed: () {
                apply(() => alarmCur = null);
                unawaited(loadAlarms());
              },
              child: const Text('重新加载'),
            ),
          ],
        ),
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: [
              CappedChildren(
                children: [for (final file in files) _alarmFileRow(context, file, curName)],
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _alarmFileRow(BuildContext context, Map<String, dynamic> file, String? curName) {
    final scheme = Theme.of(context).colorScheme;
    final name = _str(file['name']);
    final on = name == curName;
    return InkWell(
      onTap: () => unawaited(selectAlarm(name)),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
        decoration: BoxDecoration(
          color: on ? scheme.surfaceContainerHighest : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
        ),
        child: Row(
          children: [
            Icon(Icons.insert_drive_file_outlined, size: 15, color: scheme.onSurfaceVariant),
            const SizedBox(width: 8),
            Expanded(child: Text(name, style: _mono(11.5, on ? scheme.primary : scheme.onSurface))),
            Text('${file['lines'] ?? 0} 行', style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant)),
          ],
        ),
      ),
    );
  }

  Widget _alarmBody(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final cur = alarmCur;
    if (cur == null) {
      return const _StateBlock(title: '未选择告警文件', detail: '在左侧列表选择文件，此处显示原文。');
    }
    if (curLoading) return const _StateBlock(title: '正在加载…', loading: true);
    if (curError != null) {
      return _StateBlock(title: '告警文件读取失败', detail: curError, onRetry: () => selectAlarm(_str(cur['name'])));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Flexible(child: Text(_str(cur['name']), style: _mono(11.5, scheme.onSurface))),
            const SizedBox(width: 8),
            if (cur['truncated'] == true) _Badge('已截断', tone: IrmiaTheme.warn),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          '${cur['lines'] ?? 0} 行 · ${cur['bytes'] ?? 0} 字节 · ${_stamp(cur['mtime']?.toString())}',
          style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: SingleChildScrollView(
            child: SelectableText(_str(cur['content']), style: _mono(11.5, scheme.onSurface)),
          ),
        ),
      ],
    );
  }

  // ─── 概览 · 自检（折叠区；空态给引导条） ───

  Widget doctorSection(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (doctorLoading && doctor == null) return _loadingCard(context, '正在执行自检…');
    final message = doctorError;
    if (message != null) {
      return _card(context, _inlineError(context, '自检数据读取失败', message, loadDoctor));
    }
    final items = _maps(doctor?['items']);
    if (items.isEmpty) {
      return GuideBar(
        icon: Icons.fact_check_outlined,
        text: '还没有自检结果。',
        actionLabel: '执行自检',
        onAction: () => unawaited(loadDoctor()),
        hint: '自检逐项核对配置、日志与目录；执行后在此列出结果。',
      );
    }
    final failures = _int(doctor?['failures']);
    final skips = _int(doctor?['skips']);
    return DetailFold(
      label: '自检（doctor）· ${items.length} 条 · 失败 $failures · 跳过 $skips',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CappedChildren(children: [for (final item in items) _doctorRow(context, item)]),
          const SizedBox(height: 6),
          Row(
            children: [
              TextButton.icon(
                onPressed: () => unawaited(loadDoctor()),
                icon: const Icon(Icons.refresh_rounded, size: 16),
                label: const Text('重新执行'),
              ),
              const Spacer(),
              Text(
                '事件 ${_int(doctor?['events'])} · 坏行 ${_int(doctor?['badLines'])}',
                style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _doctorRow(BuildContext context, Map<String, dynamic> item) {
    final scheme = Theme.of(context).colorScheme;
    final status = _str(item['status']);
    final ok = item['ok'] == true;
    final color = ok ? IrmiaTheme.ok : (status == 'skip' ? IrmiaTheme.sleep : IrmiaTheme.danger);
    final detail = _str(item['detail']);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 18,
            child: Text(ok ? '✓' : (status == 'skip' ? '–' : '✗'),
                style: TextStyle(fontSize: 13, color: color, fontWeight: FontWeight.w600)),
          ),
          SizedBox(width: 46, child: Text(_str(item['id']), style: _mono(11.5, scheme.onSurfaceVariant))),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(_str(item['title']),
                    style: TextStyle(fontSize: 12.5, color: ok ? scheme.onSurface : color)),
                if (detail.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(_clip(detail, 96),
                        style: TextStyle(fontSize: 11, height: 1.5, color: scheme.onSurfaceVariant)),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  // ─── 通用小块 ───

  Widget _loadingCard(BuildContext context, String title) {
    final scheme = Theme.of(context).colorScheme;
    return _card(
      context,
      Row(
        children: [
          const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
          const SizedBox(width: 12),
          Text(title, style: TextStyle(fontSize: 13, color: scheme.onSurfaceVariant)),
        ],
      ),
    );
  }

  Widget _inlineError(BuildContext context, String title, String detail, Future<void> Function() onRetry) {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: IrmiaTheme.danger)),
        const SizedBox(height: 6),
        Text(detail, style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
        const SizedBox(height: 10),
        OutlinedButton(onPressed: () => unawaited(onRetry()), child: const Text('重试')),
      ],
    );
  }

  // ─── 追踪 ───

  Widget traceTab(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(26, 16, 26, 30),
      children: [
        _card(
          context,
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const Text('重放某一步', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  const SizedBox(width: 8),
                  Text('按当时的日志重建请求体', style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('turn', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 110,
                    child: TextField(
                      controller: turnCtl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(hintText: '3'),
                    ),
                  ),
                  const SizedBox(width: 14),
                  Text('step', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
                  const SizedBox(width: 8),
                  SizedBox(
                    width: 110,
                    child: TextField(
                      controller: stepCtl,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(hintText: '2'),
                    ),
                  ),
                  const SizedBox(width: 14),
                  FilledButton(onPressed: replayFromInput, child: const Text('重建请求体')),
                  const SizedBox(width: 8),
                  TextButton(onPressed: replayFromLast, child: const Text('用最近一步')),
                ],
              ),
              const SizedBox(height: 8),
              Text('turn/step 取自已加载事件；未写入日志的 step 无法重建。',
                  style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            ],
          ),
        ),
        const SizedBox(height: 12),
        _replayBlock(context),
      ],
    );
  }

  Widget _replayBlock(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (replayLoading) return const _StateBlock(title: '正在重建请求体…', loading: true);
    if (replayError != null) {
      return _StateBlock(title: '重放数据读取失败', detail: replayError, onRetry: () async => replayFromInput());
    }
    final r = replay;
    if (r == null) return const _StateBlock(title: '未选择步骤', detail: '填写 turn 与 step 后在此显示当时的请求体。');

    final fp = _map(r['fingerprints']);
    final personaChanged = fp['personaChanged'] == true;
    final configChanged = fp['configChanged'] == true;
    final changed = personaChanged || configChanged;
    final tone = changed ? IrmiaTheme.warn : scheme.primary;
    final messages = _maps(r['messages']);
    final usage = r['usage'] is Map ? _map(r['usage']) : null;

    return _card(
      context,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text('请求体与三指纹',
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: scheme.onSurfaceVariant)),
              const SizedBox(width: 10),
              Text('turn ${r['turn'] ?? '-'} · step ${r['step'] ?? '-'} · ${_stamp(r['ts']?.toString())}',
                  style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant)),
            ],
          ),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              _Badge('render ${_short(r['renderVersion'] ?? fp['renderVersion'])}', tone: scheme.primary),
              _Badge('persona ${_short(r['personaHash'] ?? fp['personaHash'])}',
                  tone: personaChanged ? IrmiaTheme.warn : scheme.primary),
              _Badge('config ${_short(r['configHash'] ?? fp['configHash'])}',
                  tone: configChanged ? IrmiaTheme.warn : scheme.primary),
              _Badge('origin ${r['origin'] ?? '—'}'),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            changed ? '结论：人格或配置在之后发生变更，重建请求体与当前不一致。' : '结论：三指纹一致，重建请求体与当前一致。',
            style: TextStyle(fontSize: 11.5, color: changed ? tone : scheme.onSurfaceVariant),
          ),
          if (usage != null) ...[
            const SizedBox(height: 6),
            Text(
              '当时用量：输入 ${logsCompactTokens(_int(usage['inputTokens']))} · 输出 ${logsCompactTokens(_int(usage['outputTokens']))}'
              ' · 命中 ${logsCompactTokens(_int(usage['cacheHitTokens']))} · 耗时 ${_int(usage['durationMs'])}ms'
              ' · ${usage['model'] ?? ''} (${usage['lane'] ?? ''})',
              style: TextStyle(fontSize: 11.5, color: scheme.onSurfaceVariant),
            ),
          ],
          const Divider(height: 20),
          Row(
            children: [
              Text('请求体 ${messages.length} 段', style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant)),
              const Spacer(),
              TextButton(
                onPressed: () => apply(() => showRawJson = !showRawJson),
                child: Text(showRawJson ? '按角色看' : '原始 JSON'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Container(
            height: 380,
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: scheme.surfaceContainer,
              borderRadius: BorderRadius.circular(IrmiaTheme.radiusCtl),
            ),
            child: SingleChildScrollView(
              child: showRawJson
                  ? SelectableText(_jsonEncoder.convert(r), style: _mono(11.5, scheme.onSurface))
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (messages.isEmpty)
                          Text('本次请求体为空（可能为纯流程 step）。',
                              style: TextStyle(fontSize: 12.5, color: scheme.onSurfaceVariant)),
                        for (final m in messages) ...[
                          Text(_str(m['role']), style: _mono(11.5, tone).copyWith(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          SelectableText(_str(m['content']), style: _mono(11.5, scheme.onSurface)),
                          const SizedBox(height: 14),
                        ],
                      ],
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
