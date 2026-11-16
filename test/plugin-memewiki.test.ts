import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';

import { AfterCommitEventBus } from '../src/adapter/event-bus.ts';
import { AdapterSupervisor } from '../src/adapter/supervisor.ts';
import { composePluginMcp, composePluginSkillRoots, composePluginTools } from '../src/plugin/contributions.ts';
import { parsePluginManifest } from '../src/plugin/manifest.ts';
import { compareCodePoint, PLUGIN_FILE_LIMITS, scanPluginPackage } from '../src/plugin/package-store.ts';
import { composePluginAdapters } from '../src/plugin/runtime.ts';
import { readConfig, trollTierInfo, writeConfig } from '../plugins/builtin/linre-memewiki/lib/config.mjs';
import { createMemeDb } from '../plugins/builtin/linre-memewiki/lib/db.mjs';
import { tempDirSync } from './helpers/temp-dirs.ts';

const pluginRoot = resolve('plugins/builtin/linre-memewiki');
const workerPath = resolve(pluginRoot, 'adapter-worker.mjs');
const serverPath = resolve(pluginRoot, 'server.mjs');

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function computeDirHash(rootDir: string): string {
  const files: Array<{ rel: string; bytes: Buffer }> = [];
  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodePoint(a.name, b.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const st = lstatSync(abs);
      if (st.isDirectory()) {
        walk(abs);
      } else if (st.isFile()) {
        files.push({
          rel: relative(rootDir, abs).split(sep).join('/'),
          bytes: readFileSync(abs),
        });
      }
    }
  }
  walk(rootDir);
  files.sort((a, b) => compareCodePoint(a.rel, b.rel));
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.rel);
    hash.update('\0');
    hash.update(f.bytes);
  }
  return hash.digest('hex');
}

function mcpCall(env: Record<string, string>, requests: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: pluginRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const responses: Array<Record<string, unknown>> = [];
    const expectedIds = new Set(requests.filter((r) => r.id !== undefined).map((r) => r.id));

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`MCP timeout; stderr=${stderr}`));
    }, 10_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let idx: number;
      while ((idx = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        responses.push(msg);
        if (responses.filter((m) => expectedIds.has(m.id)).length >= expectedIds.size) {
          clearTimeout(timer);
          child.once('close', () => resolvePromise(responses));
          child.kill();
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }
  });
}

const initialPackageHash = computeDirHash(pluginRoot);

test('清单与插件贡献声明校验通过', () => {
  const raw = JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'));
  const manifest = parsePluginManifest(raw, 'plugin.json');
  assert.equal(manifest.apiVersion, 2);
  assert.equal(manifest.id, 'linre-memewiki');
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.contributions.views?.[0]?.id, 'memewiki');

  const pkg = {
    rootDir: pluginRoot,
    contentHash: initialPackageHash,
    fileCount: 1,
    totalBytes: 1,
    manifest,
  };
  const mcp = composePluginMcp([pkg]);
  assert.deepEqual(mcp.warnings, []);
  assert.equal(mcp.servers[0]?.name, 'linre-memewiki__memewiki');

  const tools = composePluginTools([pkg]);
  assert.deepEqual(tools.warnings, []);
  assert.deepEqual(
    tools.entries.map((t) => t.name),
    ['plugin__linre-memewiki__lookup_meme', 'plugin__linre-memewiki__random_meme', 'plugin__linre-memewiki__feedback_meme'],
  );

  const skills = composePluginSkillRoots([pkg]);
  assert.equal(skills.length, 1);

  const adapters = composePluginAdapters([pkg]);
  assert.deepEqual(adapters.warnings, []);
  assert.equal(adapters.adapters.length, 1);
  assert.deepEqual(adapters.adapters[0]?.capabilities, ['event.observe', 'event.publish', 'prompt.inject', 'ui.api']);

  const scanned = scanPluginPackage(pluginRoot);
  assert.equal(scanned.contentHash, initialPackageHash);
  assert.ok(scanned.totalBytes <= PLUGIN_FILE_LIMITS.maxTotalBytes);
});

test('SQLite 词库加载 6792 条且精确全词预查与前缀不误命中', (t) => {
  const dataDir = tempDirSync('memewiki-db-');
  const t0 = performance.now();
  const db = createMemeDb({ pluginDataDir: dataDir });
  const elapsedMs = performance.now() - t0;
  t.after(() => {
    db.close();
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
    }
  });

  const stats = db.getStats();
  assert.equal(stats.total, 6792);
  assert.equal(stats.isUserCopy, false);
  assert.ok(elapsedMs < 2000, `startup load took ${elapsedMs.toFixed(1)}ms`);

  const hit = db.matchMessage('今天大家一起去码头整点薯条吧');
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.title, '去码头整点薯条');

  const prefixMiss = db.matchMessage('去码头');
  assert.deepEqual(prefixMiss, []);

  const prefixMiss2 = db.matchMessage('恶意');
  assert.deepEqual(prefixMiss2, []);

  const capHits = db.matchMessage('我发了个恶意图顺便去码头整点薯条再看看尼罗河二圣', { limit: 2 });
  assert.equal(capHits.length, 2);
  assert.equal(capHits[0]?.title, '去码头整点薯条');
});

test('写时复制到 pluginDataDir 并支持增删改查且不污染包目录', (t) => {
  const dataDir = tempDirSync('memewiki-cow-');
  const db = createMemeDb({ pluginDataDir: dataDir });
  t.after(() => {
    db.close();
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
    }
  });

  assert.equal(existsSync(join(dataDir, 'memes.db')), false);

  const created = db.upsertMeme({
    title: '林芮专属测试梗',
    aliases: 'lrzsg',
    tags: '测试,本地',
    summary: '用于验证写时复制的测试词条',
    usage: '直接回复测试成功即可',
    origin: '单元测试',
  });
  assert.equal(created.total, 6793);
  assert.equal(existsSync(join(dataDir, 'memes.db')), true);
  assert.equal(db.getStats().isUserCopy, true);

  const aliasHit = db.matchMessage('群友刚刚刷了一个 lrzsg 哈哈');
  assert.equal(aliasHit.length, 1);
  assert.equal(aliasHit[0]?.title, '林芮专属测试梗');

  const renamed = db.upsertMeme({
    oldTitle: '林芮专属测试梗',
    title: '林芮改名测试梗',
    aliases: 'lrgm',
    tags: '测试',
    summary: '改名后的释义',
    usage: '改名后的接法',
    origin: '单元测试',
  });
  assert.equal(renamed.total, 6793);
  assert.equal(db.getByTitle('林芮专属测试梗'), null);
  assert.equal(db.getByTitle('林芮改名测试梗')?.aliases, 'lrgm');

  const removed = db.deleteMeme('林芮改名测试梗');
  assert.equal(removed.deleted, 1);
  assert.equal(removed.total, 6792);
});

test('串子程度四档位文案与配置持久化正确', (t) => {
  const dataDir = tempDirSync('memewiki-cfg-');
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));

  const initial = readConfig(dataDir);
  assert.equal(initial.autoLookup, true);
  assert.equal(initial.trollEnabled, false);
  assert.equal(initial.trollLevel, 50);
  assert.equal(initial.nickname, '林芮');

  assert.equal(trollTierInfo(50, false).guidance, '');
  assert.match(trollTierInfo(15, true).guidance, /串子极低:点到即止绝不冒犯/);
  assert.match(trollTierInfo(40, true).guidance, /串子偏低:损操作不损人/);
  assert.match(trollTierInfo(65, true).guidance, /串子中等:顺着群友气氛接梗反讽/);
  assert.match(trollTierInfo(90, true).guidance, /串子拉满:放开玩梗互损黑称但看场合收手/);

  const saved = writeConfig(dataDir, { autoLookup: false, trollEnabled: true, trollLevel: 120, nickname: '小芮' });
  assert.equal(saved.autoLookup, false);
  assert.equal(saved.trollEnabled, true);
  assert.equal(saved.trollLevel, 100);
  assert.equal(saved.nickname, '小芮');
});

test('Adapter Worker 事件观测、预查注入、串子渲染与 GUI ui/handle + ui/invoke', async (t) => {
  const dataDir = tempDirSync('memewiki-worker-');
  const bus = new AfterCommitEventBus({ handlerTimeoutMs: 2_000 });
  const appended: unknown[] = [];
  const failures: unknown[] = [];
  const supervisor = new AdapterSupervisor({
    eventBus: bus,
    handshakeTimeoutMs: 5_000,
    requestTimeoutMs: 8_000,
    onEventAppend: (_id, _hash, payload) => {
      appended.push(payload);
      return null;
    },
    onFailure: (_id, error) => failures.push(error),
  });
  t.after(async () => {
    await supervisor.stop();
    await sleep(100);
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
    }
  });

  await supervisor.start([{
    id: 'linre-memewiki',
    version: '0.1.0',
    contentHash: initialPackageHash,
    worker: workerPath,
    capabilities: ['event.observe', 'event.publish', 'prompt.inject', 'ui.api'],
    cwd: pluginRoot,
    env: { LINRE_PLUGIN_DATA_DIR: dataDir },
  }]);

  assert.equal(supervisor.statuses()[0]?.state, 'ready');
  assert.deepEqual(failures, []);

  bus.publishAfterCommit({
    seq: 1,
    ts: new Date().toISOString(),
    type: 'wake/channel',
    data: { text: '走啊，一起去码头整点薯条' },
    visibility: 'model',
  });
  await sleep(150);

  const rendered1 = await supervisor.request('linre-memewiki', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
  assert.match(rendered1.text, /^梗百科：「去码头整点薯条」/);
  assert.match(rendered1.text, /先自然接梗别科普/);
  assert.ok([...rendered1.text].length <= 160);
  assert.ok(appended.length >= 1);

  bus.publishAfterCommit({
    seq: 2,
    ts: new Date().toISOString(),
    type: 'wake/manual',
    data: { note: '去码头' },
    visibility: 'model',
  });
  await sleep(120);

  const renderedPrefix = await supervisor.request('linre-memewiki', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
  assert.equal(renderedPrefix.text, '');

  bus.publishAfterCommit({
    seq: 3,
    ts: new Date().toISOString(),
    type: 'tool/result',
    data: { name: 'read_channel', status: 'ok', content: '· 12:00 路人：别发恶意图了' },
    visibility: 'model',
  });
  await sleep(120);

  const renderedTool = await supervisor.request('linre-memewiki', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
  assert.match(renderedTool.text, /恶意图/);

  const saveRes = await supervisor.request('linre-memewiki', 'ui/invoke', {
    action: 'save_settings',
    autoLookup: true,
    trollEnabled: true,
    trollLevel: 85,
    nickname: '林芮',
  }) as { ok: boolean };
  assert.equal(saveRes.ok, true);

  const renderedTroll = await supervisor.request('linre-memewiki', 'prompt/render', { slot: 'now-layer', maxChars: 160 }) as { text: string };
  assert.match(renderedTroll.text, /恶意图/);
  assert.match(renderedTroll.text, /串子拉满:放开玩梗互损黑称但看场合收手/);
  assert.ok([...renderedTroll.text].length <= 160);

  const overviewDoc = await supervisor.request('linre-memewiki', 'ui/handle', {
    path: '/ui/memewiki',
    query: { tab: 'overview' },
  }) as { title: string; blocks: Array<Record<string, unknown>> };
  assert.equal(overviewDoc.title, '梗百科');
  assert.equal(overviewDoc.blocks[0]?.type, 'tabs');
  assert.ok(overviewDoc.blocks.some((b) => b.type === 'hero'));
  assert.ok(overviewDoc.blocks.some((b) => b.type === 'metrics'));
  assert.ok(overviewDoc.blocks.some((b) => b.type === 'form' && b.action === 'save_settings'));

  const upsertRes = await supervisor.request('linre-memewiki', 'ui/invoke', {
    action: 'upsert_entry',
    title: 'GUI测试新梗',
    aliases: 'gui_meme',
    tags: '测试',
    summary: 'GUI 新增词条',
    usage: '在浏览页可见',
    origin: 'GUI 测试',
  }) as { ok: boolean; query?: Record<string, string> };
  assert.equal(upsertRes.ok, true);
  assert.equal(upsertRes.query?.tab, 'browse');

  const browseDoc = await supervisor.request('linre-memewiki', 'ui/handle', {
    path: '/ui/memewiki',
    query: { tab: 'browse', q: 'GUI测试新梗' },
  }) as { blocks: Array<{ type: string; items?: Array<{ title: string; actions?: Array<Record<string, unknown>> }> }> };
  const grid = browseDoc.blocks.find((b) => b.type === 'grid');
  assert.ok(grid);
  assert.equal(grid.items?.[0]?.title, 'GUI测试新梗');
  assert.equal(grid.items?.[0]?.actions?.[0]?.action, 'upsert_entry');
  assert.equal(grid.items?.[0]?.actions?.[1]?.action, 'delete_entry');

  const randomDoc = await supervisor.request('linre-memewiki', 'ui/handle', {
    path: '/ui/memewiki',
    query: { tab: 'browse', q: '__random__' },
  }) as { blocks: Array<{ type: string; items?: unknown[] }> };
  const randomGrid = randomDoc.blocks.find((b) => b.type === 'grid');
  assert.ok(randomGrid && (randomGrid.items?.length ?? 0) > 0);

  const createDoc = await supervisor.request('linre-memewiki', 'ui/handle', {
    path: '/ui/memewiki',
    query: { tab: 'create' },
  }) as { blocks: Array<{ type: string; action?: string }> };
  assert.ok(createDoc.blocks.some((b) => b.type === 'form' && b.action === 'upsert_entry'));

  const deleteRes = await supervisor.request('linre-memewiki', 'ui/invoke', {
    action: 'delete_entry',
    title: 'GUI测试新梗',
  }) as { ok: boolean };
  assert.equal(deleteRes.ok, true);
});

test('MCP Server 工具 lookup_meme / random_meme / feedback_meme 正常工作', async (t) => {
  const dataDir = tempDirSync('memewiki-mcp-');
  t.after(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
    }
  });

  const responses = await mcpCall({ LINRE_PLUGIN_DATA_DIR: dataDir }, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lookup_meme', arguments: { query: '去码头' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'random_meme', arguments: { count: 3 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'feedback_meme', arguments: { title: 'MCP本地反馈测试', content: '直接测试本地保存', saveLocal: true } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'lookup_meme', arguments: { query: 'MCP本地反馈测试' } } },
  ]);

  const byId = new Map(responses.map((r) => [r.id, r]));
  const listResult = byId.get(2)?.result as { tools: Array<{ name: string }> };
  assert.deepEqual(listResult.tools.map((tool) => tool.name), ['lookup_meme', 'random_meme', 'feedback_meme']);

  const lookupRes = byId.get(3)?.result as { content: Array<{ text: string }> };
  assert.match(lookupRes.content[0]?.text || '', /去码头整点薯条/);
  assert.match(lookupRes.content[0]?.text || '', /接梗规则/);

  const randomRes = byId.get(4)?.result as { content: Array<{ text: string }> };
  assert.match(randomRes.content[0]?.text || '', /\[1\]/);
  assert.match(randomRes.content[0]?.text || '', /\[3\]/);

  const fbRes = byId.get(5)?.result as { content: Array<{ text: string }>; isError?: boolean };
  assert.notEqual(fbRes.isError, true);
  assert.match(fbRes.content[0]?.text || '', /已写入本地可写词库/);

  const lookupAdded = byId.get(6)?.result as { content: Array<{ text: string }> };
  assert.match(lookupAdded.content[0]?.text || '', /MCP本地反馈测试/);
  assert.match(lookupAdded.content[0]?.text || '', /直接测试本地保存/);
});

test('插件包目录哈希在全部测试前后完全一致且无 WAL/SHM 污染', () => {
  const scanned = scanPluginPackage(pluginRoot);
  assert.equal(scanned.contentHash, initialPackageHash);
  const finalHash = computeDirHash(pluginRoot);
  assert.equal(finalHash, initialPackageHash);
});
