/**
 * 一键安装协议端测试 —— src/services/install-snowluma.ts
 *
 * 这条链是"引导客户安装、尽量少配置"落地的地方，所以测试盯着三件最容易悄悄坏掉的事：
 *   • **选包选错**（把 37.8 MB 的完整包当成 lite 下下来，或者在不支持的平台上硬下一份解不开的）
 *   • **release 的回应形状变了**却被当成正常（那会一路走到"解压失败"，报错指不到根因）
 *   • **解压完不复检**（deps 那边学到的教训：装完不验就报"已装好"，用户很久以后才发现没生效）
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  installSnowLuma, parseRelease, pickLiteAsset, snowlumaServiceDir, type SnowLumaAsset,
} from '../src/services/install-snowluma.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const roots: string[] = [];
after(() => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

function tempDir(): string {
  const dir = tempDirSync('irmia-inst-');
  roots.push(dir);
  return dir;
}

const FIXTURE = readFileSync(new URL('./fixtures/snowluma-lite.zip', import.meta.url));

/** 一份形状与官方一致的 release 回应（只留我们读的字段，另加一个无关字段证明会忽略） */
function releaseJson(tag: string): string {
  return JSON.stringify({
    tag_name: tag,
    name: 'ignored',
    assets: [
      { name: `SnowLuma-${tag}-win-x64.zip`, browser_download_url: 'https://example/full.zip', size: 37_841_306 },
      { name: `SnowLuma-${tag}-win-x64-lite.zip`, browser_download_url: 'https://example/lite.zip', size: 4_772_925 },
      { name: `SnowLuma-${tag}-linux-x64-lite.tar.gz`, browser_download_url: 'https://example/linux.tar.gz', size: 4_101_518 },
    ],
  });
}

describe('安装协议端 · 选包', () => {
  const assets: SnowLumaAsset[] = [
    { name: 'SnowLuma-v1.2.3-win-x64.zip', url: 'https://example/full.zip', size: 100 },
    { name: 'SnowLuma-v1.2.3-win-x64-lite.zip', url: 'https://example/lite.zip', size: 5 },
    { name: 'SnowLuma-v1.2.3-linux-x64-lite.tar.gz', url: 'https://example/linux.tgz', size: 4 },
  ];

  test('Windows 上挑 lite 那份，不挑 37 MB 的完整包', () => {
    const picked = pickLiteAsset(assets, 'win32');
    assert.equal(picked?.url, 'https://example/lite.zip');
  });

  test('不支持的平台返回 null（而不是下一份解不开的包）', () => {
    // 官方在 Linux 上发的是 .tar.gz，而解压器只认 zip（零依赖手写的那一个）
    assert.equal(pickLiteAsset(assets, 'linux'), null);
    assert.equal(pickLiteAsset(assets, 'darwin'), null);
  });

  test('这个版本里没有 lite 包时返回 null', () => {
    assert.equal(pickLiteAsset([{ name: 'SnowLuma-x-win-x64.zip', url: 'u', size: 1 }], 'win32'), null);
  });
});

describe('安装协议端 · 解析 release 回应', () => {
  test('正常回应能取出 tag 与资产', () => {
    const parsed = parseRelease(releaseJson('v1.14.20'));
    assert.equal(parsed?.tag, 'v1.14.20');
    assert.equal(parsed?.assets.length, 3);
  });

  test('形状不对一律 null（宁可说"看不懂"，也不要一路走到解压失败）', () => {
    for (const bad of ['不是 JSON', '[]', '{}', '{"tag_name":"v1"}', '{"assets":[]}', '{"tag_name":"v1","assets":"nope"}']) {
      assert.equal(parseRelease(bad), null, bad);
    }
  });

  test('资产里缺 url 或 name 的条目会被跳过，不产生半条记录', () => {
    const parsed = parseRelease(JSON.stringify({
      tag_name: 'v1',
      assets: [{ name: 'a.zip' }, { browser_download_url: 'u' }, { name: 'b.zip', browser_download_url: 'u2', size: 3 }],
    }));
    assert.deepEqual(parsed?.assets, [{ name: 'b.zip', url: 'u2', size: 3 }]);
  });
});

describe('安装协议端 · 端到端（假 GitHub + 假下载 + 真 zip）', () => {
  test('从"查到版本"到"解压完复检通过"，整条路走通', async () => {
    const dataDir = tempDir();
    const lines: string[] = [];
    let downloadedTo = '';
    const outcome = await installSnowLuma({
      dataDir,
      platform: 'win32',
      fetchText: async () => releaseJson('v9.9.9'),
      // 假下载：把测试包写到目标路径（真实实现是 node:https）
      download: async (_url, target) => {
        downloadedTo = target;
        writeFileSync(target, FIXTURE);
        return { ok: true, path: target, bytes: FIXTURE.length, finalUrl: _url, error: '' };
      },
      onProgress: (line) => { lines.push(line); },
    });

    assert.equal(outcome.ok, true, `该成功：${outcome.detail}\n${lines.join('\n')}`);
    assert.equal(outcome.version, 'v9.9.9');
    assert.equal(outcome.dir, snowlumaServiceDir(dataDir));

    // 落点：固定的家 + 缓存目录里留着 zip（失败了人能自己去看那半截文件）
    assert.ok(existsSync(join(snowlumaServiceDir(dataDir), 'index.mjs')), '入口必须落地');
    assert.ok(existsSync(join(snowlumaServiceDir(dataDir), 'LICENSE')), '许可随包落地');
    assert.ok(downloadedTo.includes('.cache'), `下载该进缓存目录：${downloadedTo}`);

    // 进度是给人看的：每一步都要有一句
    assert.ok(lines.some((l) => l.includes('查询')), '缺"查询 release"那一步');
    assert.ok(lines.some((l) => l.includes('下载完成')), '缺"下载完成"那一步');
    assert.ok(lines.some((l) => l.includes('解压完成')), '缺"解压完成"那一步');
  });

  test('解压完但入口不在 → 报失败而不是"已装好"', async () => {
    // 这是 deps 那边学到的教训：解压成功不等于能跑，包结构变了（或杀软隔离了文件）
    // 都在"解压成功"之后才暴露。装完不验就报"已装好"，用户会在很久以后才发现没生效。
    const dataDir = tempDir();
    const noEntry = readFileSync(new URL('./fixtures/snowluma-no-entry.zip', import.meta.url));
    const outcome = await installSnowLuma({
      dataDir,
      platform: 'win32',
      fetchText: async () => releaseJson('v9.9.9'),
      download: async (_url, target) => {
        writeFileSync(target, noEntry);
        return { ok: true, path: target, bytes: noEntry.length, finalUrl: _url, error: '' };
      },
    });
    assert.equal(outcome.ok, false, '解压成功但没有入口，不能算装好');
    assert.match(outcome.detail, /index\.mjs/, '要说清缺的是哪个文件');
    // 但文件确实落地了——所以那句话得是"结构可能变了"，不是"没下下来"
    assert.ok(existsSync(join(snowlumaServiceDir(dataDir), 'LICENSE')), '包内容是解开了的');
  });

  test('下载失败 → ok:false 且原因带出来（不抛）', async () => {
    const dataDir = tempDir();
    const outcome = await installSnowLuma({
      dataDir,
      platform: 'win32',
      fetchText: async () => releaseJson('v9.9.9'),
      download: async () => ({ ok: false, path: '', bytes: 0, finalUrl: '', error: '连接被重置' }),
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /连接被重置/);
  });

  test('查 release 失败 → ok:false 且提示可以手动安装（不抛）', async () => {
    const dataDir = tempDir();
    const outcome = await installSnowLuma({
      dataDir,
      platform: 'win32',
      fetchText: async () => { throw new Error('HTTP 403'); },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /HTTP 403/);
    assert.match(outcome.detail, /手动下载/, '失败要给出路，不能只说失败');
  });

  test('非 Windows → 明确说不支持一键安装，并给手动路径', async () => {
    const dataDir = tempDir();
    const outcome = await installSnowLuma({ dataDir, platform: 'linux', fetchText: async () => releaseJson('v1') });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /只支持 Windows/);
    assert.match(outcome.detail, /releases/, '要给出下载地址');
  });
});
