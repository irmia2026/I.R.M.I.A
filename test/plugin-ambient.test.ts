import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';
import { scanPluginPackage } from '../src/plugin/package-store.ts';
import {
  collectRecentFiles,
  formatAmbientLine,
  formatDiskSegment,
  redactWindowTitle,
  searchEverything,
} from '../plugins/builtin/linre-ambient/lib/sampler.mjs';

const pluginRoot = resolve('plugins/builtin/linre-ambient');
const worker = resolve(pluginRoot, 'adapter-worker.mjs');
const mcpServer = resolve(pluginRoot, 'server.mjs');

test('环境感知插件：scanPluginPackage 校验通过且清单合规', () => {
  const pkg = scanPluginPackage(pluginRoot);
  assert.equal(pkg.manifest.id, 'linre-ambient');
  assert.equal(pkg.manifest.version, '0.1.0');
  assert.equal(pkg.manifest.apiVersion, 2);
  if (pkg.manifest.apiVersion === 2) {
    assert.equal(pkg.manifest.contributions.views?.[0]?.id, 'ambient');
    assert.equal(pkg.manifest.contributions.mcp, 'mcp.json');
    assert.equal(pkg.manifest.contributions.tools, 'tools.json');
  }
});

test('环境感知采样器：敏感窗口标题脱敏与全局隐藏', () => {
  assert.equal(redactWindowTitle('1Password - 主保险库'), '[隐私窗口]');
  assert.equal(redactWindowTitle('Bitwarden Vault'), '[隐私窗口]');
  assert.equal(redactWindowTitle('查看 APIKey 与 secret 配置'), '[隐私窗口]');
  assert.equal(redactWindowTitle('无痕浏览 - Edge'), '[隐私窗口]');
  assert.equal(redactWindowTitle('L.i.N.R.E - Visual Studio Code'), 'L.i.N.R.E - Visual Studio Code');
  assert.equal(redactWindowTitle('L.i.N.R.E - Visual Studio Code', true), '[已隐藏]');
});

test('环境感知采样器：近期文件过滤临时/隐藏/超时文件并按新旧排序', () => {
  const base = mkdtempSync(join(tmpdir(), 'ambient-files-'));
  try {
    const downloads = join(base, 'Downloads');
    const desktop = join(base, 'Desktop');
    mkdirSync(downloads, { recursive: true });
    mkdirSync(desktop, { recursive: true });

    const nowMs = Date.now();
    const f1 = join(downloads, 'screenshot.png');
    const f2 = join(desktop, 'notes.md');
    const fOld = join(downloads, 'old.zip');
    const fTmp = join(downloads, 'movie.crdownload');
    const fHidden = join(desktop, '.secret');

    writeFileSync(f1, 'png');
    writeFileSync(f2, 'md');
    writeFileSync(fOld, 'zip');
    writeFileSync(fTmp, 'tmp');
    writeFileSync(fHidden, 'hid');

    utimesSync(f1, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
    utimesSync(f2, new Date(nowMs - 180_000), new Date(nowMs - 180_000));
    utimesSync(fOld, new Date(nowMs - 45 * 60_000), new Date(nowMs - 45 * 60_000));

    const recent = collectRecentFiles({
      dirs: [
        { label: 'Downloads', path: downloads },
        { label: 'Desktop', path: desktop },
      ],
      nowMs,
      maxAgeMs: 30 * 60_000,
      limit: 5,
    });
    assert.deepEqual(recent.map((item: { name: string }) => item.name), ['screenshot.png', 'notes.md']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('环境感知采样器：紧凑行渲染、磁盘变化与 Everything 调用', async () => {
  assert.equal(formatDiskSegment(10.8, 10.8), 'C盘余10.8G(稳)');
  assert.equal(formatDiskSegment(10.2, 10.8), 'C盘余10.2G(-0.6G)');

  const line = formatAmbientLine({
    fgProcess: 'Code',
    fgTitle: 'L.i.N.R.E',
    idleSeconds: 12,
    windows: [
      { process: 'Code', title: 'L.i.N.R.E' },
      { process: 'QQ', title: '群聊' },
      { process: 'MuMu', title: '模拟器' },
      { process: 'FlClash', title: 'FlClash' },
    ],
    recentFiles: [{ name: 'xxx.png' }],
    cFreeGb: 10.8,
    baselineCFreeGb: 10.8,
  }, { enabled: true, hideWindowTitles: false }, 160);
  assert.match(line, /^环境：前台=Code「L\.i\.N\.R\.E」｜键鼠活跃｜开着=QQ,MuMu,FlClash｜新文件=xxx\.png｜C盘余10\.8G\(稳\)$/);
  assert.ok([...line].length <= 160);
  assert.equal(formatAmbientLine({ fgProcess: 'Code' }, { enabled: false }, 160), '');

  const missingEs = await searchEverything('abc', { existsFn: () => false });
  assert.equal(missingEs.available, false);

  const mockEs = await searchEverything('report\n', {
    existsFn: () => true,
    execRunner: async (_cmd: string, args: string[]) => {
      assert.deepEqual(args, ['-p', '-n', '20', 'report']);
      return { ok: true, stdout: 'C:\\Users\\admin\\Downloads\\report.pdf\n' };
    },
  });
  assert.equal(mockEs.available, true);
  assert.deepEqual(mockEs.results, ['C:\\Users\\admin\\Downloads\\report.pdf']);
});

test('环境感知 worker：prompt/render、ui/handle 与 ui/invoke 配置持久化', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ambient-data-'));
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
  });
  try {
    await supervisor.start([{
      id: 'linre-ambient',
      version: '0.1.0',
      contentHash: 'a'.repeat(64),
      worker,
      capabilities: ['event.observe', 'prompt.inject', 'ui.api'],
      cwd: pluginRoot,
      env: { ...process.env, LINRE_AMBIENT_NO_PS: '1' },
    }]);

    const beforeInit = await supervisor.request('linre-ambient', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { lines: string[]; text: string };
    assert.deepEqual(beforeInit.lines, []);

    await supervisor.request('linre-ambient', 'adapter/init', { config: { dataDir } });

    const refreshRes = await supervisor.request('linre-ambient', 'ui/invoke', { action: 'refresh_now' }) as { ok: boolean; refresh: boolean };
    assert.equal(refreshRes.ok, true);
    assert.equal(refreshRes.refresh, true);

    const rendered = await supervisor.request('linre-ambient', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { lines: string[]; text: string };
    assert.equal(rendered.lines.length, 1);
    assert.match(rendered.lines[0], /^环境：/);
    assert.ok([...rendered.lines[0]].length <= 160);

    const uiDoc = await supervisor.request('linre-ambient', 'ui/handle', { path: '/ui/ambient' }) as { title: string; blocks: Array<{ type: string }> };
    assert.equal(uiDoc.title, '环境感知');
    assert.ok(uiDoc.blocks.some((b) => b.type === 'hero'));
    assert.ok(uiDoc.blocks.some((b) => b.type === 'metrics'));
    assert.ok(uiDoc.blocks.some((b) => b.type === 'actions'));
    assert.ok(uiDoc.blocks.some((b) => b.type === 'form'));

    const saved = await supervisor.request('linre-ambient', 'ui/invoke', {
      action: 'save_settings',
      enabled: false,
      hideWindowTitles: true,
      pollSeconds: 60,
    }) as { ok: boolean };
    assert.equal(saved.ok, true);
    assert.ok(existsSync(join(dataDir, 'config.json')));
    const persisted = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as { enabled: boolean; hideWindowTitles: boolean; pollSeconds: number };
    assert.equal(persisted.enabled, false);
    assert.equal(persisted.hideWindowTitles, true);
    assert.equal(persisted.pollSeconds, 60);

    const disabledRender = await supervisor.request('linre-ambient', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { lines: string[] };
    assert.deepEqual(disabledRender.lines, []);

    await assert.rejects(supervisor.request('linre-ambient', 'ui/handle', { path: '/invalid' }));
  } finally {
    await supervisor.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('环境感知 MCP server：tools/list 暴露 peek_host 并支持各 scope 调用', async () => {
  const proc = spawn(process.execPath, [mcpServer], {
    cwd: pluginRoot,
    env: { ...process.env, LINRE_AMBIENT_NO_PS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number } & Record<string, unknown>;
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const resolveFn = pending.get(msg.id)!;
        pending.delete(msg.id);
        resolveFn(msg);
      }
    }
  });

  const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((resolveFn) => {
    pending.set(id, resolveFn);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });

  try {
    const init = await rpc(1, 'initialize', {}) as { result: { serverInfo: { name: string } } };
    assert.equal(init.result.serverInfo.name, 'linre-ambient');
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = await rpc(2, 'tools/list') as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(list.result.tools.map((t) => t.name), ['peek_host']);

    const callAll = await rpc(3, 'tools/call', { name: 'peek_host', arguments: { scope: 'all' } }) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    assert.notEqual(callAll.result.isError, true);
    const allText = callAll.result.content[0]?.text ?? '';
    assert.match(allText, /【窗口与键鼠】/);
    assert.match(allText, /【近期文件】/);
    assert.match(allText, /【存储概览】/);

    const callStorage = await rpc(4, 'tools/call', { name: 'peek_host', arguments: { scope: 'storage' } }) as { result: { content: Array<{ text: string }> } };
    assert.match(callStorage.result.content[0]?.text ?? '', /可用：/);
  } finally {
    proc.kill();
  }
});
