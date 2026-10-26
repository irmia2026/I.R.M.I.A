/**
 * 一键安装协议端测试 —— src/services/install-snowluma.ts
 *
 * 这条链是"引导客户安装、尽量少配置"落地的地方，所以测试盯着三件最容易悄悄坏掉的事：
 *   • **选包选错**（把 37.8 MB 的完整包当成 lite 下下来，或者在不支持的平台上硬下一份解不开的）
 *   • **release 的回应形状变了**却被当成正常（那会一路走到"解压失败"，报错指不到根因）
 *   • **解压完不复检**（deps 那边学到的教训：装完不验就报"已装好"，用户很久以后才发现没生效）
 *
 * 后两组是 **SnowLumaDevs 书面授权的三条要求**里的两条（凭证见 `docs/third-party-authorizations.md`）：
 *   · 要求①「完整保留 LICENSE / EULA / 版权与署名信息」⇒ 逐文件哈希与包内一致、EULA 装前装后不变、
 *     `native/*` 不被复制到安装目录之外；
 *   · 要求②「无需自动弹出浏览器」⇒ 安装链上**没有**"起进程 / 开外链"这条路可走（导入表与端点逐条钉住）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  installSnowLuma, parseRelease, pickLiteAsset, snowlumaServiceDir, SNOWLUMA_PRESERVED_ON_REINSTALL,
  type SnowLumaAsset,
} from '../src/services/install-snowluma.ts';
import { readZipEntries } from '../src/deps/install.ts';
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

/**
 * "下一版"的包：文件**集合**与 [FIXTURE] 一样（`index.mjs` / `LICENSE` / `EULA.md` / `native/...`），
 * 但每个文件的字节都换了——用来验"升级只覆盖包内文件、不碰它自己写的运行期目录"。
 * （两个 tiny zip 都是**合成夹具**，不是官方发行物，也不含真实原生组件。）
 */
const FIXTURE_V2 = readFileSync(new URL('./fixtures/snowluma-lite-update.zip', import.meta.url));

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

// ──────────────────────── 授权要求①：不改它的任何文件 ────────────────────────

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 递归列出 root 下的普通文件（相对路径用 `/` 拼，与 zip 成员名同一个写法） */
function listFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/** 真的走一遍 `installSnowLuma`：假 GitHub + 假下载，包由调用方给（v1 / v2 夹具） */
async function installZipInto(dataDir: string, zip: Buffer) {
  return await installSnowLuma({
    dataDir,
    platform: 'win32',
    fetchText: async () => releaseJson('v9.9.9'),
    download: async (_url, target) => {
      writeFileSync(target, zip);
      return { ok: true, path: target, bytes: zip.length, finalUrl: _url, error: '' };
    },
  });
}

/** 装 `fixtures/snowluma-lite.zip` 那一版 */
async function installFixtureInto(dataDir: string) {
  return await installZipInto(dataDir, FIXTURE);
}

describe('安装协议端 · 不改文件（授权要求①：完整保留 LICENSE / EULA / 署名）', () => {
  test('解压后的每个文件与 zip 内**逐字节相同**（逐个 sha256 对比），EULA.md 装完不变', async () => {
    const zipped = readZipEntries(FIXTURE);
    assert.equal(zipped.ok, true, zipped.error);
    const expected = new Map(zipped.entries.map((entry) => [entry.name, sha256(entry.data)]));
    assert.ok(expected.size > 0);

    const dataDir = tempDir();
    const outcome = await installFixtureInto(dataDir);
    assert.equal(outcome.ok, true, `该装成功：${outcome.detail}\n${outcome.log.join('\n')}`);

    const dir = snowlumaServiceDir(dataDir);
    const installed = listFiles(dir);
    // ① 文件集合一一对应：不少一个（漏了就是丢文件），也不多一个（多了就是它自己写的东西）
    assert.deepEqual(
      [...installed].sort(),
      [...expected.keys()].sort(),
      '装出来的文件集合必须与包内一一对应（不多不少）',
    );
    // ② 每个文件逐字节比对：解压/落地任何一环改写字节，这里当场红
    for (const name of installed) {
      assert.equal(
        sha256(readFileSync(join(dir, name))),
        expected.get(name),
        `${name} 的字节与包内不一致——那已经违反授权范围（只解压、不改写）`,
      );
    }

    // ③ EULA 单独再说一遍：这是授权方点名要求"完整保留"的那一份
    const eulaInZip = zipped.entries.find((entry) => entry.name === 'EULA.md');
    assert.ok(eulaInZip, '夹具里必须有 EULA.md，否则这条用例什么都没验');
    const eulaPath = join(dir, 'EULA.md');
    const eulaBefore = sha256(eulaInZip.data);
    assert.equal(sha256(readFileSync(eulaPath)), eulaBefore, 'EULA.md 装完必须与包内逐字节相同');
    assert.equal(readFileSync(eulaPath, 'utf8'), eulaInZip.data.toString('utf8'), '内容（不只是哈希）也要一样');

    // ④ 再装一次（升级/重装会先清空目标目录）：仍然同一份字节，没有被追加、改写或重新排版
    const second = await installFixtureInto(dataDir);
    assert.equal(second.ok, true, second.detail);
    assert.equal(sha256(readFileSync(eulaPath)), eulaBefore, '重装一次也不许动 EULA.md 一个字节');
  });

  test('native/* 只落在安装目录里：没有被复制到安装目录之外的任何地方', async () => {
    const zipped = readZipEntries(FIXTURE);
    assert.equal(zipped.ok, true, zipped.error);
    const nativeEntries = zipped.entries.filter((entry) => entry.name.startsWith('native/'));
    assert.ok(nativeEntries.length > 0, '夹具里得真有原生件，否则这条用例什么都没验');

    // 观察范围 = 一个**外层**目录，数据目录是它的子目录：安装只要往外面写一个字节，这里就看得见
    const root = tempDir();
    const dataDir = join(root, 'data');
    const outcome = await installFixtureInto(dataDir);
    assert.equal(outcome.ok, true, outcome.detail);

    const serviceDir = snowlumaServiceDir(dataDir);
    const nativeHashes = new Set(nativeEntries.map((entry) => sha256(entry.data)));

    const copies: string[] = [];
    for (const rel of listFiles(root)) {
      const full = join(root, rel);
      if (nativeHashes.has(sha256(readFileSync(full)))) copies.push(full.replaceAll('\\', '/'));
    }
    const allowed = nativeEntries.map((entry) => join(serviceDir, entry.name).replaceAll('\\', '/'));
    assert.deepEqual(
      copies.sort(),
      [...allowed].sort(),
      '原生件只该在安装目录里各出现一次：复制到别处就是"单独分发原生组件"（授权明确不含）',
    );

    // 再退一步：安装写下来的东西**全部**在 `<dataDir>/services/` 里（安装目录 + 下载缓存），
    // 没有任何一个字节落在它旁边
    const servicesRoot = `${join(dataDir, 'services').replaceAll('\\', '/')}/`;
    for (const rel of listFiles(root)) {
      const full = join(root, rel).replaceAll('\\', '/');
      assert.ok(full.startsWith(servicesRoot), `安装往 <dataDir>/services 之外写了东西：${full}`);
    }
  });
});

// ──────────────────────── 授权要求②：不自动弹出浏览器 ────────────────────────
//
// 这两条钉的是"**没有这条路**"，而不是"这次没走"：安装链只要拿到"起进程"或"开外链"的能力，
// 早晚会有人在某个失败分支里顺手用一次（"打不开就带他去下载页"是最自然的写法）。
// 所以判据落在**能力**上——导入表 + 端点函数体，两处都不许出现这类记号。

const BANNED_OPENERS = [
  'child_process',
  'shell: true',
  'execFile',
  'spawn(',
  'xdg-open',
  'explorer',
  'openExternal',
  'open-url',
  'start ""',
] as const;

describe('安装协议端 · 不打开外部页面（授权要求②：无需自动弹出浏览器）', () => {
  test('安装模块没有"起进程 / 开外链"的能力：导入表里只有 fs、path、https 与解压器', () => {
    const source = readFileSync(new URL('../src/services/install-snowluma.ts', import.meta.url), 'utf8');
    const specifiers = [
      ...[...source.matchAll(/\bfrom\s+'([^']+)'/gu)].map((m) => m[1]!),
      ...[...source.matchAll(/\bimport\(\s*'([^']+)'\s*\)/gu)].map((m) => m[1]!),
    ];
    assert.deepEqual(
      [...new Set(specifiers)].sort(),
      ['../deps/install.ts', 'node:fs', 'node:fs/promises', 'node:https', 'node:path'],
      '导入表一长就该有人问"这条为什么要 import 它"——安装只需要文件、路径、网络取数与解压器',
    );
    for (const banned of BANNED_OPENERS) {
      assert.equal(source.includes(banned), false, `安装模块里出现了"打开外部程序"的记号：${banned}`);
    }
  });

  test('跑完一次安装，对外只做两件事：问官方 Releases、下一个官方资产', async () => {
    const calls: Array<{ kind: string; url: string }> = [];
    const dataDir = tempDir();
    const outcome = await installSnowLuma({
      dataDir,
      platform: 'win32',
      fetchText: async (url) => {
        calls.push({ kind: 'fetchText', url });
        return releaseJson('v9.9.9');
      },
      download: async (url, target) => {
        calls.push({ kind: 'download', url });
        writeFileSync(target, FIXTURE);
        return { ok: true, path: target, bytes: FIXTURE.length, finalUrl: url, error: '' };
      },
    });
    assert.equal(outcome.ok, true, outcome.detail);

    // 整条流程的"对外动作"只有这两次，一次都不多——没有第三个出口可以"顺手打开一个页面"
    assert.deepEqual(calls, [
      { kind: 'fetchText', url: 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest' },
      { kind: 'download', url: 'https://example/lite.zip' },
    ]);
    // 回执也只有五件事实：没有 "openedUrl" 这类副作用通道
    assert.deepEqual(Object.keys(outcome).sort(), ['detail', 'dir', 'log', 'ok', 'version']);
  });

  test('服务端那条安装端点同样只有"装 + 回执"：函数体里没有打开页面的动作', () => {
    const source = readFileSync(new URL('../src/web/server.ts', import.meta.url), 'utf8');
    const start = source.indexOf('private async runProtocolSideInstall');
    assert.ok(start > 0, '找不到安装端点——函数改名了就把这条用例跟着改');
    const nextMethod = source.indexOf('\n  private ', start + 10);
    const body = source.slice(start, nextMethod > start ? nextMethod : source.length);

    for (const banned of BANNED_OPENERS) {
      assert.equal(body.includes(banned), false, `安装端点里出现了"打开外部程序"的记号：${banned}`);
    }
    // 它只做两件事：真的去装（installSnowLuma）+ 把结果回执出去（sendJson）
    assert.match(body, /installSnowLuma\(/u);
    assert.match(body, /sendJson\(/u);
  });
});


// ─────────────── 重装/升级保住它自己写的运行期目录（config/ 与 logs/） ───────────────
//
// 病根：`extractZipToDirectory` 先 `rm -rf` 目标目录。这对"干净落地"是对的，但 SnowLuma
// 登录之后会自己在安装目录里物化 `config/`（含 OneBot 的 access_token）与 `logs/`——
// 一起清掉，用户重装一次就要重新扫码、日志也没了。这一组用例钉住"只有包内文件被替换"。

describe('安装协议端 · 重装保住它的 config/、logs/ 与 data/', () => {
  test('保住的前缀**不在发行包里**（在包里的东西必须让新版本覆盖，否则 native 会变旧）', () => {
    assert.deepEqual([...SNOWLUMA_PRESERVED_ON_REINSTALL], ['config', 'logs', 'data']);
    for (const zip of [FIXTURE, FIXTURE_V2]) {
      const zipped = readZipEntries(zip);
      assert.equal(zipped.ok, true, zipped.error);
      for (const prefix of SNOWLUMA_PRESERVED_ON_REINSTALL) {
        const packaged = zipped.entries.some(
          (entry) => entry.name === prefix || entry.name.startsWith(`${prefix}/`),
        );
        assert.equal(packaged, false, `发行包里居然有 ${prefix}/：那它就不是"运行期物化"的，不能进保留名单`);
      }
    }
    // 发行包自带的原生组件**绝不能**进保留名单：留旧的就是"旧版本原生件盖在新版本上"
    for (const packaged of ['native', 'client']) {
      assert.equal(
        SNOWLUMA_PRESERVED_ON_REINSTALL.includes(packaged),
        false,
        `${packaged}/ 是发行包自带的，必须被新版本整份覆盖`,
      );
    }
  });

  test('重装一次：它自己写的 config/ 与 logs/ 仍在，内容一个字节都没变', async () => {
    const dataDir = tempDir();
    const first = await installFixtureInto(dataDir);
    assert.equal(first.ok, true, `第一次该装成功：${first.detail}`);
    const dir = snowlumaServiceDir(dataDir);

    // 模拟"用户已经用它登录过"：这两份是它运行期物化的，发行包里没有
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const configBytes = Buffer.from('{"onebot":{"wsPort":3001,"accessToken":"tok-keep-me"}}', 'utf8');
    const logBytes = Buffer.from('2026-10-23 [ws-default] listening 127.0.0.1:3001/\n', 'utf8');
    writeFileSync(join(dir, 'config', 'onebot_10001.json'), configBytes);
    writeFileSync(join(dir, 'logs', 'snowluma-2026-10-23.log'), logBytes);

    const second = await installFixtureInto(dataDir);
    assert.equal(second.ok, true, `重装该成功：${second.detail}\n${second.log.join('\n')}`);

    assert.deepEqual(
      readFileSync(join(dir, 'config', 'onebot_10001.json')),
      configBytes,
      'config/ 里的字节不许变（access_token 没了就得重新扫码）',
    );
    assert.deepEqual(
      readFileSync(join(dir, 'logs', 'snowluma-2026-10-23.log')),
      logBytes,
      'logs/ 里的字节不许变（排障只能靠它）',
    );

    // 包内文件照旧逐字节落地：保旧的逻辑不许把新包带坏
    const zipped = readZipEntries(FIXTURE);
    assert.equal(zipped.ok, true, zipped.error);
    for (const entry of zipped.entries) {
      assert.equal(
        sha256(readFileSync(join(dir, entry.name))),
        sha256(entry.data),
        `${entry.name} 重装后必须与包内逐字节相同`,
      );
    }

    // 回执要**说出**保住了什么（不说，人就不知道这次重装其实什么都没丢）
    // 这条用例只造了 config/ 与 logs/；data/ 由下一条单独钉
    for (const prefix of ['config', 'logs']) {
      assert.ok(
        second.log.some((line) => line.includes('保留') && line.includes(prefix)),
        `过程记录里缺"保留了 ${prefix}"那一句：\n${second.log.join('\n')}`,
      );
    }
  });

  test('data/ 里是消息库与身份库：重装后逐字节仍在，且它不属于"发行包自带所以绝不保留"那一类', async () => {
    const dataDir = tempDir();
    const first = await installFixtureInto(dataDir);
    assert.equal(first.ok, true, `第一次该装成功：${first.detail}`);
    const dir = snowlumaServiceDir(dataDir);

    // 运行期物化的库：几个字节就够——判据是"字节原样"，不是大小
    // （本机真目录里是 messages.db 36 MB / media.db 9.4 MB / reactions.db / snowluma_identity.db 725 KB）
    mkdirSync(join(dir, 'data', '10001'), { recursive: true });
    const messagesBytes = Buffer.from('SQLite format 3  fixture bytes: messages.db', 'utf8');
    const identityBytes = Buffer.from('SQLite format 3  fixture bytes: snowluma_identity.db', 'utf8');
    writeFileSync(join(dir, 'data', '10001', 'messages.db'), messagesBytes);
    writeFileSync(join(dir, 'data', '10001', 'snowluma_identity.db'), identityBytes);

    const second = await installFixtureInto(dataDir);
    assert.equal(second.ok, true, `重装该成功：${second.detail}\n${second.log.join('\n')}`);

    assert.deepEqual(
      readFileSync(join(dir, 'data', '10001', 'messages.db')),
      messagesBytes,
      'data/ 里的消息库不许动：重装丢了它就是真丢聊天记录',
    );
    assert.deepEqual(
      readFileSync(join(dir, 'data', '10001', 'snowluma_identity.db')),
      identityBytes,
      '身份库不许动：丢了就要重新扫码登录',
    );
    // 回执里也要说出 data 被保住了
    assert.ok(
      second.log.some((line) => line.includes('保留') && line.includes('data')),
      `过程记录里缺"保留了 data"那一句：\n${second.log.join('\n')}`,
    );

    // 自证两件事：data/ **不在**发行包里（是它运行期物化的），也**不是**"发行包自带所以绝不保留"那类
    for (const zip of [FIXTURE, FIXTURE_V2]) {
      const zipped = readZipEntries(zip);
      assert.equal(zipped.ok, true, zipped.error);
      const packaged = zipped.entries.some((entry) => entry.name === 'data' || entry.name.startsWith('data/'));
      assert.equal(packaged, false, '发行包里居然有 data/：那它就不是"运行期物化"的，不能进保留名单');
    }
    assert.equal(SNOWLUMA_PRESERVED_ON_REINSTALL.includes('data'), true, 'data/ 是运行期数据库，重装必须保');
    for (const packaged of ['native', 'client']) {
      assert.equal(
        SNOWLUMA_PRESERVED_ON_REINSTALL.includes(packaged),
        false,
        `${packaged}/ 是发行包自带的，必须被新版本整份覆盖（留旧的就是旧原生件盖新版本）`,
      );
    }
  });

  test('换一版包再装：包内文件换成新版本的字节，config/ 仍是旧的那份', async () => {
    const dataDir = tempDir();
    assert.equal((await installFixtureInto(dataDir)).ok, true);
    const dir = snowlumaServiceDir(dataDir);

    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const configBytes = Buffer.from('{"webui":{"user":"admin"},"onebot":{"accessToken":"old-token"}}', 'utf8');
    const logBytes = Buffer.from('old log line\n', 'utf8');
    writeFileSync(join(dir, 'config', 'webui.json'), configBytes);
    writeFileSync(join(dir, 'logs', 'old.log'), logBytes);
    const v1Index = readFileSync(join(dir, 'index.mjs'));

    const upgraded = await installZipInto(dataDir, FIXTURE_V2);
    assert.equal(upgraded.ok, true, `升级该成功：${upgraded.detail}\n${upgraded.log.join('\n')}`);

    const v2 = readZipEntries(FIXTURE_V2);
    assert.equal(v2.ok, true, v2.error);
    const v2Index = v2.entries.find((entry) => entry.name === 'index.mjs');
    assert.ok(v2Index);
    const after = readFileSync(join(dir, 'index.mjs'));
    // 先证明两版夹具确实不一样，否则"是新的"这句话本身证明不了什么
    assert.notDeepEqual(after, v1Index, '两版夹具的 index.mjs 居然一样——那这条用例什么都没验');
    assert.deepEqual(after, v2Index.data, '包内文件必须是新版本的字节');
    // 整包都换成 v2（逐个文件比，不只入口）
    for (const entry of v2.entries) {
      assert.equal(sha256(readFileSync(join(dir, entry.name))), sha256(entry.data), `${entry.name} 没换成新版本`);
    }
    // 而它自己写的那两份原样留着
    assert.deepEqual(readFileSync(join(dir, 'config', 'webui.json')), configBytes, 'config/ 不该被新版覆盖');
    assert.deepEqual(readFileSync(join(dir, 'logs', 'old.log')), logBytes, 'logs/ 不该被新版覆盖');
  });
});
