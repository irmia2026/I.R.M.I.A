import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  collectRecentFiles,
  formatAgeText,
  formatAmbientLine,
  formatBytes,
  formatDiskSegment,
  formatIdleText,
  readDriveFreeGb,
  sampleWindows,
} from './lib/sampler.mjs';

const PLUGIN_ID = 'linre-ambient';
const DEFAULT_POLL_SECONDS = 45;
const MIN_POLL_SECONDS = 15;
const MAX_POLL_SECONDS = 180;

let dataDir = '';
let config = {
  enabled: true,
  pollSeconds: DEFAULT_POLL_SECONDS,
  hideWindowTitles: false,
};
let baselineCFreeGb = null;
let lastSample = null;
let sampling = false;
let pollTimer = null;

function clampPollSeconds(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_POLL_SECONDS;
  return Math.max(MIN_POLL_SECONDS, Math.min(MAX_POLL_SECONDS, Math.round(num)));
}

function configPath() {
  return dataDir ? join(dataDir, 'config.json') : '';
}

function loadConfig() {
  const path = configPath();
  if (!path || !existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (typeof parsed.enabled === 'boolean') config.enabled = parsed.enabled;
    if (typeof parsed.hideWindowTitles === 'boolean') config.hideWindowTitles = parsed.hideWindowTitles;
    if (parsed.pollSeconds !== undefined) config.pollSeconds = clampPollSeconds(parsed.pollSeconds);
  } catch {
  }
}

function saveConfig() {
  const path = configPath();
  if (!path) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  } catch {
  }
}

async function sampleOnce() {
  if (sampling) return lastSample;
  sampling = true;
  try {
    const winData = await sampleWindows({ hideWindowTitles: config.hideWindowTitles });
    const recentFiles = collectRecentFiles({ limit: 8 });
    const cFreeGb = readDriveFreeGb(process.platform === 'win32' ? 'C:\\' : '/');
    if (baselineCFreeGb === null && cFreeGb !== null) baselineCFreeGb = cFreeGb;
    lastSample = {
      sampledAtMs: Date.now(),
      fgProcess: winData.fgProcess,
      fgTitle: winData.fgTitle,
      idleSeconds: winData.idleSeconds,
      windows: winData.windows,
      recentFiles,
      cFreeGb,
      baselineCFreeGb,
    };
    return lastSample;
  } catch {
    return lastSample;
  } finally {
    sampling = false;
  }
}

function restartTimer() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (!config.enabled) return;
  const intervalMs = clampPollSeconds(config.pollSeconds) * 1000;
  pollTimer = setInterval(() => {
    void sampleOnce();
  }, intervalMs);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function reply(id, body) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
}

function applyInitParams(params) {
  const cfg = params && typeof params === 'object'
    ? (params.config && typeof params.config === 'object' ? params.config : params)
    : {};
  if (typeof cfg.dataDir === 'string' && cfg.dataDir.trim() !== '') {
    dataDir = cfg.dataDir.trim();
    loadConfig();
  }
  if (typeof cfg.enabled === 'boolean') config.enabled = cfg.enabled;
  if (typeof cfg.hideWindowTitles === 'boolean') config.hideWindowTitles = cfg.hideWindowTitles;
  if (cfg.pollSeconds !== undefined) config.pollSeconds = clampPollSeconds(cfg.pollSeconds);
}

function buildUiDocument(nowMs) {
  const sample = lastSample;
  const line = sample ? formatAmbientLine(sample, config, 160) : '';
  const idleText = sample ? formatIdleText(sample.idleSeconds) : '未采样';
  const diskText = sample && sample.cFreeGb !== null ? formatDiskSegment(sample.cFreeGb, sample.baselineCFreeGb) : '未知';
  const ageText = sample ? formatAgeText(Math.max(0, nowMs - sample.sampledAtMs)) : '尚未采样';
  const winCount = sample ? sample.windows.length : 0;

  let badge = '待';
  let tone = 'primary';
  if (!config.enabled) {
    badge = '关';
    tone = 'warn';
  } else if (sample) {
    if (sample.idleSeconds === null || sample.idleSeconds < 60) {
      badge = '活';
      tone = 'ok';
    } else {
      badge = '闲';
      tone = 'primary';
    }
  }

  const heroTitle = !config.enabled
    ? '环境感知已暂停（可在下方设置重新开启）'
    : (line || '正在等待首次环境采样...');

  const windowItems = (sample?.windows ?? []).map((w) => ({
    tone: w.process === sample.fgProcess ? 'ok' : 'primary',
    label: w.process,
    detail: w.title || '（无标题）',
    trailing: w.process === sample.fgProcess ? '前台' : '',
  }));

  const fileItems = (sample?.recentFiles ?? []).map((f) => ({
    tone: 'primary',
    label: `${f.name}`,
    detail: `${f.dir} · ${formatBytes(f.sizeBytes)}`,
    trailing: formatAgeText(f.ageMs),
  }));

  return {
    title: '环境感知',
    blocks: [
      {
        type: 'hero',
        badge,
        tone,
        title: heroTitle,
        subtitle: sample?.fgProcess ? `当前焦点：${sample.fgProcess}` : '轻量采样本机窗口、键鼠状态与近期新文件',
        chips: [
          { label: '状态', value: config.enabled ? '已启用' : '已暂停' },
          { label: '周期', value: `${config.pollSeconds} 秒` },
          { label: '标题脱敏', value: config.hideWindowTitles ? '全部隐藏' : '仅敏感词' },
        ],
      },
      {
        type: 'metrics',
        items: [
          { label: '键鼠状态', value: idleText },
          { label: 'C盘可用', value: diskText.replace(/^C盘/, '') || '未知' },
          { label: '活跃窗口', value: `${winCount} 个` },
          { label: '采样距今', value: ageText },
        ],
      },
      {
        type: 'list',
        title: '可见应用窗口',
        empty: '暂未获取到桌面窗口（或当前在无桌面环境）',
        items: windowItems,
      },
      {
        type: 'list',
        title: '近期新文件（30分钟内）',
        empty: '近 30 分钟 Downloads / Desktop 没有新文件',
        items: fileItems,
      },
      {
        type: 'actions',
        items: [
          { label: '立即采样', tone: 'primary', kind: 'post', action: 'refresh_now' },
          { label: '刷新视图', kind: 'refresh' },
        ],
      },
      {
        type: 'form',
        title: '环境感知设置',
        kind: 'post',
        action: 'save_settings',
        submitLabel: '保存设置',
        fields: [
          { key: 'enabled', label: '启用此刻层环境脉搏', type: 'switch', value: config.enabled },
          { key: 'hideWindowTitles', label: '隐藏窗口具体标题', type: 'switch', value: config.hideWindowTitles },
          { key: 'pollSeconds', label: '采样间隔（秒）', type: 'slider', min: MIN_POLL_SECONDS, max: MAX_POLL_SECONDS, divisions: 11, value: config.pollSeconds },
        ],
      },
    ],
  };
}

async function handleInvoke(params) {
  const body = params && typeof params === 'object' ? params : {};
  const action = typeof body.action === 'string' ? body.action : '';
  if (action === 'refresh_now') {
    await sampleOnce();
    return { ok: true, message: '已完成一次环境采样', refresh: true };
  }
  if (action === 'save_settings') {
    if (typeof body.enabled === 'boolean') config.enabled = body.enabled;
    if (typeof body.hideWindowTitles === 'boolean') config.hideWindowTitles = body.hideWindowTitles;
    if (body.pollSeconds !== undefined) config.pollSeconds = clampPollSeconds(body.pollSeconds);
    saveConfig();
    restartTimer();
    if (config.enabled) await sampleOnce();
    return { ok: true, message: '环境感知设置已保存', refresh: true };
  }
  return { ok: false, message: `未知操作：${action || '（空）'}` };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on('line', (line) => {
  const raw = line.trim();
  if (raw === '') return;
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    process.stderr.write(`[${PLUGIN_ID}] 非 JSON 输入，丢弃\n`);
    return;
  }
  if (message === null || typeof message !== 'object') return;
  const id = message.id;
  if (typeof message.method !== 'string' || id === undefined) return;

  if (message.method === 'initialize') {
    applyInitParams(message.params);
    restartTimer();
    reply(id, { result: { ok: true, pluginId: PLUGIN_ID, protocol: 'linre.adapter.v2' } });
    return;
  }

  if (message.method === 'adapter/init') {
    applyInitParams(message.params);
    restartTimer();
    if (config.enabled) void sampleOnce();
    reply(id, { result: { ok: true, config } });
    return;
  }

  if (message.method === 'prompt/render') {
    const params = message.params ?? {};
    const slot = typeof params.slot === 'string' ? params.slot : 'now-layer';
    const maxChars = Number.isSafeInteger(params.maxChars) && params.maxChars > 0 ? params.maxChars : 160;
    if (slot !== 'now-layer' || !config.enabled || !lastSample) {
      reply(id, { result: { lines: [], text: '' } });
      return;
    }
    const lineText = formatAmbientLine(lastSample, config, maxChars);
    if (!lineText) {
      reply(id, { result: { lines: [], text: '' } });
      return;
    }
    reply(id, { result: { lines: [lineText], text: lineText } });
    return;
  }

  if (message.method === 'ui/handle') {
    const params = message.params ?? {};
    const path = typeof params.path === 'string' ? params.path : '';
    if (path !== '/state' && path !== '/state/' && path !== '/ui/ambient' && path !== '/ui/ambient/' && path !== '' && path !== '/') {
      reply(id, { error: { code: -32601, message: `未知视图路径: ${path}` } });
      return;
    }
    reply(id, { result: buildUiDocument(Date.now()) });
    return;
  }

  if (message.method === 'ui/invoke') {
    void handleInvoke(message.params)
      .then((result) => reply(id, { result }))
      .catch((error) => reply(id, { result: { ok: false, message: error instanceof Error ? error.message : String(error) } }));
    return;
  }

  reply(id, { error: { code: -32601, message: `Method not found: ${String(message.method)}` } });
});

input.on('close', () => {
  if (pollTimer !== null) clearInterval(pollTimer);
  process.exit(0);
});

process.stderr.write(`[${PLUGIN_ID}] worker 已启动\n`);
