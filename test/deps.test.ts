/**
 * 外部依赖（探测 / 安装 / 复检）测试 —— src/deps/
 *
 * 三条纪律，每条都对应一次踩过的坑：
 *
 *   1. **绝不碰真机**。探测与安装都要"用注入的假可执行文件 / 假下载源"：
 *      用例不能因为开发机上恰好装了 rg 就变绿、没装就变红（那是"假锁"的另一种形态：
 *      绿得没有信息）。所有进程与网络入口都是本文件里的假实现。
 *   2. **断言理由，不只断言红绿**。安装的三类失败必须各报各的（下载 / 解压 / 复检），
 *      所以这里逐个断言 `step` 与错误文本里的关键词，而不是"失败了就行"。
 *   3. **锁的是语义，不是当前实现**。比如"配置指定的路径坏了不许静默落到 PATH"——
 *      断言的是"PATH 上那个可执行文件一次都没被碰过"，而不是某句错误消息的措辞。
 *
 * 跑法就是 npm test（node --test --experimental-strip-types）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import {
  DEP_SPECS,
  ES_CLI_ZIP_URL,
  ES_DOWNLOAD_PAGE,
  isManagedHit,
  managedInterpreterOf,
  pathInterpreterSlotOf,
  PYTHON_DOWNLOAD_PAGE,
  PYTHON_EMBED_URL,
  PWSH_DOWNLOAD_PAGE,
  managedDirFor,
  pickLatestPythonRelease,
  probeDependency,
  readManifest,
  readZipEntries,
  resolvePythonEmbedUrl,
  resolveRipgrepAsset,
  sourceKindOf,
  stripSingleTopDir,
  versionAtLeast,
  type DepProcessResult,
  type DependencyProbeOutcome,
  type DepName,
} from '../src/deps/index.ts';
import { DepsManager, packageFor, summarizeNotReady } from '../src/deps/manager.ts';
import {
  bootstrapPip,
  enableSiteInPth,
  findPthFile,
  parsePipVersion,
  pickPipWheel,
} from '../src/deps/pip.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 假可执行文件 ────────────────────────────────

/**
 * 假进程层：按可执行文件名回答版本。
 *
 * `answers` 的键是"候选名"（`pwsh.exe` / `rg.exe` / …），值是探测输出；
 * 不在表里的名字一律当作"没这个文件"（ENOENT）——这正是探测链要处理的正常情形。
 */
function fakeRunner(
  answers: Record<string, string | { stdout: string; code?: number; timedOut?: boolean; failed?: boolean }>,
  seen?: string[],
): (exe: string) => Promise<DepProcessResult> {
  return async (exe: string): Promise<DepProcessResult> => {
    seen?.push(exe);
    const answer = answers[exe];
    if (answer === undefined) {
      return { code: null, stdout: '', stderr: `spawn ${exe} ENOENT`, failed: true, timedOut: false };
    }
    if (typeof answer === 'string') {
      return { code: 0, stdout: answer, stderr: '', failed: false, timedOut: false };
    }
    return {
      code: answer.code ?? 0,
      stdout: answer.stdout,
      stderr: '',
      failed: answer.failed ?? false,
      timedOut: answer.timedOut ?? false,
    };
  };
}

/** 造一个假的"自装目录"：`files` 里的相对路径都当作真实存在 */
function fakeFs(files: readonly string[]): {
  exists: (path: string) => boolean;
  listDir: (dir: string) => string[];
  add(path: string): void;
} {
  const set = new Set(files);
  return {
    exists: (path) => set.has(path),
    listDir: (dir) => {
      const prefix = `${dir}\\`;
      const names = new Set<string>();
      for (const file of set) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf('\\');
        if (slash === -1) continue; // 只列子目录名（manager 会自己去拼候选名）
        names.add(rest.slice(0, slash));
      }
      return [...names];
    },
    add: (path) => {
      set.add(path);
    },
  };
}

/** 探测一个依赖：注入假进程层与假文件系统，**不碰真机** */
async function probeWith(
  name: DepName,
  input: {
    configPath?: string;
    managedDir: string;
    answers: Record<string, string | { stdout: string; code?: number; timedOut?: boolean; failed?: boolean }>;
    files?: readonly string[];
    extraSearchDirs?: readonly string[];
  },
  seen?: string[],
): Promise<DependencyProbeOutcome> {
  const fs = fakeFs(input.files ?? []);
  const spec = DEP_SPECS[name];
  // probeDependency 内部用 runProbeCommand（真 spawn），这里换成假实现：
  // 通过 monkey patch 太重，所以直接调 probeCandidate 那条路——见下面的 runProbe 注入
  return await probeDependency(spec, {
    ...(input.configPath === undefined ? {} : { configPath: input.configPath }),
    managedDir: input.managedDir,
    exists: fs.exists,
    listDir: fs.listDir,
    ...(input.extraSearchDirs === undefined ? {} : { extraSearchDirs: input.extraSearchDirs }),
    runProbe: fakeRunner(input.answers, seen),
  });
}

// ──────────────────────────────── 版本判定 ────────────────────────────────

describe('依赖探测：版本判定', () => {
  it('versionAtLeast 只做主版本级比较（四件依赖的判据都是这个粒度）', () => {
    assert.equal(versionAtLeast('7.4.6', [7]), true);
    assert.equal(versionAtLeast('7.0.0', [7]), true);
    assert.equal(versionAtLeast('5.1.26100.9444', [7]), false);
    assert.equal(versionAtLeast('15.1.0', [13]), true);
    assert.equal(versionAtLeast('12.0.0', [13]), false);
    assert.equal(versionAtLeast('1.1.0.38', [1, 1]), true);
    assert.equal(versionAtLeast('1.0.9', [1, 1]), false);
    // 位数不够时按缺失位为 0 处理（'1' >= [1,0]，但 < [1,1]）
    assert.equal(versionAtLeast('1', [1, 0]), true);
    assert.equal(versionAtLeast('1', [1, 1]), false);
  });

  it('pwsh 的判据是**主版本 >= 7**：5.1 是一个能跑的 shell，但它不算满足', () => {
    const spec = DEP_SPECS.pwsh;
    assert.equal(spec.parseVersion('7.4.6', { code: 0, stdout: '7.4.6', stderr: '', failed: false, timedOut: false }), '7.4.6');
    assert.equal(spec.parseVersion('5.1.26100.9444', { code: 0, stdout: '', stderr: '', failed: false, timedOut: false }), null);
    // 输出不是版本号（比如打印了别的东西）也算不可用
    assert.equal(spec.parseVersion('not a version', { code: 0, stdout: '', stderr: '', failed: false, timedOut: false }), null);
    // 但"解析出了 5.1"这件事要能区分出来——它决定报告说"版本不符"还是"未安装"
    assert.equal(spec.parseAnyVersion?.('5.1.26100.9444'), '5.1.26100.9444');
    assert.equal(spec.minVersion, '7.0');
  });

  it('rg 的版本取自 `ripgrep X.Y.Z` 那一行；es 的版本是一行纯版本号', () => {
    const ctx: DepProcessResult = { code: 0, stdout: '', stderr: '', failed: false, timedOut: false };
    assert.equal(DEP_SPECS.rg.parseVersion('ripgrep 15.1.0 (rev abc)', ctx), '15.1.0');
    assert.equal(DEP_SPECS.rg.parseVersion('ripgrep 15.1.0\nfeatures:+pcre2', ctx), '15.1.0');
    assert.equal(DEP_SPECS.rg.parseVersion('something else', ctx), null);
    assert.equal(DEP_SPECS.es.parseVersion('1.1.0.38', ctx), '1.1.0.38');
    assert.equal(DEP_SPECS.es.parseVersion('ES 1.1.0.27', ctx), '1.1.0.27');
    assert.equal(DEP_SPECS.es.parseVersion('Everything IPC unavailable', ctx), null);
    // es 的版本参数是**单横线**（voidtools 的口径），写错就是永远探不到
    assert.deepEqual([...DEP_SPECS.es.versionArgs()], ['-version']);
    assert.deepEqual([...DEP_SPECS.rg.versionArgs()], ['--version']);
  });

  /**
   * Python 的版本串形状与另外三件都不同：**带着 `Python ` 前缀**（pwsh 是一行纯数字、
   * rg 是 `ripgrep X.Y.Z`、es 是一行纯版本号）。三件事都在这一条里钉住：
   *   ① 前缀连着一起认；② 判据是 3.8+；③ **2.x 要能被说成"版本不符"而不是"未安装"**。
   */
  it('python 的版本取自 `Python X.Y.Z`（带前缀），判据是 3.8+；2.x 算"版本不符"不算满足', () => {
    const spec = DEP_SPECS.python;
    const ctx: DepProcessResult = { code: 0, stdout: '', stderr: '', failed: false, timedOut: false };
    // 实测形状（本机 3.11.5 / python.org 3.15.0 都是这一行，纯 ASCII，写 stdout）
    assert.equal(spec.parseVersion('Python 3.11.5', ctx), '3.11.5');
    assert.equal(spec.parseVersion('Python 3.15.0\n', ctx), '3.15.0');
    assert.equal(spec.parseVersion('Python 3.8.0', ctx), '3.8.0', '3.8 是下限本身，算满足');
    // 低于下限：不算满足……
    assert.equal(spec.parseVersion('Python 3.7.9', ctx), null);
    assert.equal(spec.parseVersion('Python 2.7.18', ctx), null, 'Python 2 不算满足');
    // ……但"解析出了 2.7.18"必须能被上层看见（它决定报告说"版本不符"还是"未安装"）
    assert.equal(spec.parseAnyVersion?.('Python 2.7.18'), '2.7.18');
    assert.equal(spec.parseAnyVersion?.('Python 3.7.9'), '3.7.9');
    // 输出看不懂时两处都是 null（→ "未安装"，不是"版本不符"）
    assert.equal(spec.parseVersion('command not found', ctx), null);
    assert.equal(spec.parseAnyVersion?.('command not found'), null);
    assert.equal(spec.minVersion, '3.8');
    // 版本参数就是 `--version`（Python 3.4+ 写 stdout；2.x 写 stderr，两路一起收的见 pwsh.ts）
    assert.deepEqual([...spec.versionArgs()], ['--version']);
    assert.equal(spec.install, 'zip');
  });
});

// ──────────────────────────────── 三段顺序 ────────────────────────────────

describe('依赖探测：三段顺序（config → 自装目录 → PATH）', () => {
  const managedDir = 'C:\\data\\tools\\rg';

  it('config 指定的路径最先（人明确指过就以他为准）', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      configPath: 'C:\\path\\to\\rg.exe',
      managedDir,
      answers: { 'C:\\path\\to\\rg.exe': 'ripgrep 15.1.0', 'rg.exe': 'ripgrep 14.0.0' },
      files: [`${managedDir}\\rg.exe`],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'config');
    assert.equal(outcome.path, 'C:\\path\\to\\rg.exe');
    assert.equal(outcome.version, '15.1.0');
    assert.deepEqual(seen, ['C:\\path\\to\\rg.exe'], '命中第一段就不该再碰后两段');
  });

  it('config 没指定时先看自装目录（一键安装的落点），命中就不去 PATH', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      managedDir,
      answers: { [`${managedDir}\\rg.exe`]: 'ripgrep 15.1.0', 'rg.exe': 'ripgrep 14.0.0' },
      files: [`${managedDir}\\rg.exe`],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'managed');
    assert.equal(outcome.path, `${managedDir}\\rg.exe`);
    assert.deepEqual(seen, [`${managedDir}\\rg.exe`]);
  });

  it('自装目录里多一层子目录也认（手工解压 zip 的人不会剥那层）', async () => {
    const outcome = await probeWith('rg', {
      managedDir,
      answers: { [`${managedDir}\\ripgrep-15.1.0-x86_64-pc-windows-msvc\\rg.exe`]: 'ripgrep 15.1.0' },
      files: [`${managedDir}\\ripgrep-15.1.0-x86_64-pc-windows-msvc\\rg.exe`],
    });
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'managed');
    assert.match(outcome.path, /ripgrep-15\.1\.0/u);
  });

  it('前两段都没有时走 PATH（并带上系统常见安装位置）', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('es', {
      managedDir: 'C:\\data\\tools\\es',
      answers: { 'C:\\Program Files\\Everything\\es.exe': '1.1.0.38' },
      extraSearchDirs: ['C:\\Program Files\\Everything'],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'path');
    assert.equal(outcome.path, 'C:\\Program Files\\Everything\\es.exe');
    assert.ok(seen.length >= 2, `应当逐级试过来：${seen.join(' → ')}`);
  });

  it('**config 指定的路径坏了不许静默落到 PATH**：如实报错，且 PATH 上的同名程序一次都没被碰', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      configPath: 'D:\\Broken\\rg.exe',
      managedDir,
      answers: { 'rg.exe': 'ripgrep 15.1.0' },
    }, seen);
    assert.equal(outcome.status, 'missing');
    assert.deepEqual(seen, ['D:\\Broken\\rg.exe'], '用户指定优先且排他：不许被 PATH 顶替');
    assert.match(outcome.reason, /配置里指定/u);
    assert.match(outcome.attempts.join(' '), /D:\\Broken\\rg\.exe/u);
  });

  it('一个候选都没有时：状态是未安装，reason 里列出试过哪几处（下一步该动哪里）', async () => {
    const outcome = await probeWith('rg', { managedDir, answers: {} });
    assert.equal(outcome.status, 'missing');
    assert.equal(outcome.path, '');
    assert.ok(outcome.attempts.length >= 3, `三段都要留痕：${outcome.attempts.join(' | ')}`);
    assert.match(outcome.attempts[0] ?? '', /config/u);
    assert.match(outcome.attempts[1] ?? '', /managed/u);
    assert.match(outcome.attempts[2] ?? '', /path/u);
  });

  it('**装了但版本不符**与"根本没装"是两句话（前者该升级、后者该安装）', async () => {
    const outcome = await probeWith('pwsh', {
      managedDir: 'C:\\data\\tools\\pwsh',
      answers: { 'pwsh.exe': '5.1.26100.9444' },
    });
    assert.equal(outcome.status, 'version-mismatch');
    assert.equal(outcome.anyVersion, '5.1.26100.9444');
    assert.equal(outcome.version, '');
    assert.match(outcome.reason, /低于要求的 7\.0/u);
    assert.match(outcome.reason, /请升级/u);
  });

  it('探测超时算这个候选不可用，整条链继续往下（一个卡住的候选不该拖死探测）', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('rg', {
      managedDir,
      answers: {
        'rg.exe': { stdout: '', timedOut: true },
        'rg.cmd': 'ripgrep 15.1.0',
      },
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.path, 'rg.cmd');
    assert.deepEqual(seen, ['rg.exe', 'rg.cmd']);
  });

  /**
   * Python 在**这台机器**上的真实形状：`python3` 不存在、`python` 在（实测 3.11.5）。
   * 这一条锁的是"候选链一路试过去、后一个候选照样能用"——不是 Python 专属的行为，
   * 但 Python 是唯一一个**第二个候选就是常态**的依赖（Windows 官方安装器给的是
   * `python.exe`，而 Linux/macOS 上 `python` 常常根本不存在），所以拿它当例子。
   */
  it('python：`python3` 不存在时落到 `python`（Windows 官方安装器的名字），且试过的名字留痕', async () => {
    const seen: string[] = [];
    const outcome = await probeWith('python', {
      managedDir: 'C:\\data\\tools\\python',
      answers: { 'python.exe': 'Python 3.11.5' },
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'path');
    assert.equal(outcome.version, '3.11.5');
    // 候选链按 candidates 的顺序试：python.exe 在最前（自装目录里落地的一定是它）
    assert.equal(seen[0], 'python.exe', `第一个候选该是 python.exe：${seen.join(' → ')}`);
  });

  it('python：装了 2.x 是"版本不符"（该升级），不是"未安装"（该安装）', async () => {
    const outcome = await probeWith('python', {
      managedDir: 'C:\\data\\tools\\python',
      answers: { 'python.exe': 'Python 2.7.18' },
    });
    assert.equal(outcome.status, 'version-mismatch');
    assert.equal(outcome.anyVersion, '2.7.18');
    assert.match(outcome.reason, /低于要求的 3\.8/u);
  });

  it('python：**PATH 上那个优先于自装目录**（用户装了 3.11，框架也装了一份 3.15 ⇒ 用用户的）', async () => {
    // 用户 2026-10-17：「**Python 和 pip 不应该是默认要求装的，而是有就用 PATH 里的。
    // 没有的话就要求装。**」⇒ `DEP_SPECS.python.sourceOrder === 'path-first'`：
    // 机器上本来就有 python 的，框架托管那一份**一次都不该被碰**。
    const managedExe = 'C:\\data\\tools\\python\\python.exe';
    const seen: string[] = [];
    const outcome = await probeWith('python', {
      managedDir: 'C:\\data\\tools\\python',
      answers: { 'python.exe': 'Python 3.11.5', [managedExe]: 'Python 3.15.0' },
      files: [managedExe],
    }, seen);
    assert.equal(outcome.status, 'ready');
    assert.equal(outcome.source, 'path', 'PATH 上那份先命中（托管只是兜底）');
    assert.equal(outcome.version, '3.11.5');
    assert.equal(seen.includes(managedExe), false, `托管那份一次都不该被碰：${seen.join(' → ')}`);
    assert.equal(DEP_SPECS.python.sourceOrder, 'path-first');
    // 另外三件是既有口径（托管优先），别被这一件的例外带跑
    assert.equal(DEP_SPECS.rg.sourceOrder ?? 'managed-first', 'managed-first');
    assert.equal(DEP_SPECS.pwsh.sourceOrder ?? 'managed-first', 'managed-first');
    assert.equal(DEP_SPECS.es.sourceOrder ?? 'managed-first', 'managed-first');
  });

  it('python：PATH 上一个都没有、托管有 ⇒ 用托管的（没有 Python 的机器走得通的那条路）', async () => {
    const managedExe = 'C:\\data\\tools\\python\\python.exe';
    const outcome = await probeWith('python', {
      managedDir: 'C:\\data\\tools\\python',
      answers: { [managedExe]: 'Python 3.13.16' },
      files: [managedExe],
    });
    assert.equal(outcome.status, 'ready', 'PATH 全空不是"未就绪"——托管那份就是"就绪"');
    assert.equal(outcome.source, 'managed');
    assert.equal(outcome.path, managedExe);
    assert.equal(outcome.version, '3.13.16');
  });

  it('python：PATH 与托管一个都没有 ⇒ 未就绪，且 reason 说清试过哪些名字', async () => {
    const outcome = await probeWith('python', { managedDir: 'C:\\data\\tools\\python', answers: {} });
    assert.equal(outcome.status, 'missing');
    assert.equal(outcome.path, '');
    assert.match(outcome.attempts.join(' '), /python3/u, '要说清试过 PATH 上的名字（不然用户只能瞎试）');
    assert.match(outcome.reason, /已试/u);
  });
});

// ──────────────────────────────── 缓存与复检 ────────────────────────────────

describe('依赖管理器：一次探测 + 安装后复检', () => {
  it('探测只做一次：多次 get 与 getAll 共用同一份结论', async () => {
    let calls = 0;
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => {
        calls += 1;
        return {
          name, status: 'missing', path: '', version: '', anyVersion: '',
          source: null, dir: null, reason: `${name} 没有`, attempts: [],
        };
      },
    });
    await manager.get('rg');
    await manager.get('rg');
    await manager.getAll();
    assert.equal(calls, 4, '四件依赖各探一次（rg 只探一次）');
    assert.equal(manager.probeCount, 4);
  });

  it('返回值连失败一起缓存：get 不因失败而反复重探', async () => {
    let calls = 0;
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => {
        calls += 1;
        return {
          name, status: 'missing', path: '', version: '', anyVersion: '',
          source: null, dir: null, reason: '', attempts: [],
        };
      },
    });
    const first = await manager.get('es');
    const second = await manager.get('es');
    assert.equal(first, second, '同一份对象（不是每次新建一份）');
    assert.equal(calls, 1);
  });

  it('复检能刷新结论：refresh() 之后 get 拿到新答案（"装完不必重启进程"）', async () => {
    let ready = false;
    let calls = 0;
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => {
        calls += 1;
        return ready
          ? {
            name, status: 'ready', path: 'C:\\data\\tools\\rg\\rg.exe', version: '15.1.0',
            anyVersion: '15.1.0', source: 'managed', dir: 'C:\\data\\tools\\rg', reason: '', attempts: [],
          }
          : {
            name, status: 'missing', path: '', version: '', anyVersion: '',
            source: null, dir: null, reason: '没装', attempts: [],
          };
      },
    });
    assert.equal((await manager.get('rg')).status, 'missing');
    ready = true;
    assert.equal((await manager.get('rg')).status, 'missing', '没刷新之前必须还是旧结论');
    manager.refresh();
    const after = await manager.get('rg');
    assert.equal(after.status, 'ready');
    assert.equal(after.path, 'C:\\data\\tools\\rg\\rg.exe');
    assert.equal(calls, 2);
  });

  it('报告形状：四件依赖各一行，字段齐（徽章/路径/版本/影响/动作/自装目录）', async () => {
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => ({
        name,
        status: name === 'rg' ? 'ready' : 'missing',
        path: name === 'rg' ? 'C:\\data\\tools\\rg\\rg.exe' : '',
        version: name === 'rg' ? '15.1.0' : '',
        anyVersion: '',
        source: name === 'rg' ? 'managed' : null,
        dir: null,
        reason: name === 'rg' ? '' : `${name} 未安装`,
        attempts: [],
      }),
    });
    const report = await manager.report(() => new Date('2026-10-01T00:00:00.000Z'));
    assert.equal(report.entries.length, 4);
    assert.equal(report.needsAttention, true);
    assert.equal(report.toolsDir, 'C:\\data\\tools');
    const rg = report.entries.find((entry) => entry.name === 'rg')!;
    assert.equal(rg.ok, true);
    assert.equal(rg.action, null, '已就绪就没有建议动作');
    assert.equal(rg.managedDir, managedDirFor('C:\\data', 'rg'));
    const pwsh = report.entries.find((entry) => entry.name === 'pwsh')!;
    // pwsh 只能人工装：动作是"打开下载页"，不是"一键安装"
    assert.equal(pwsh.installable, false);
    assert.equal(pwsh.action, 'open-download');
    assert.equal(pwsh.downloadPage, PWSH_DOWNLOAD_PAGE);
    assert.match(pwsh.manualHint ?? '', /winget/u);
    // 未安装的影响必须写出来（用户点名要"显式告知建议安装"）
    assert.ok(pwsh.impact.length > 0);
    assert.match(pwsh.impact, /5\.1/u);
    const es = report.entries.find((entry) => entry.name === 'es')!;
    assert.equal(es.installable, true);
    assert.equal(es.action, 'install');
    // Python 与 rg / es 同档：能一键装（官方 embeddable zip 进既有那条 zip 流水线）
    const python = report.entries.find((entry) => entry.name === 'python')!;
    assert.equal(python.installable, true);
    assert.equal(python.action, 'install');
    assert.equal(python.downloadPage, PYTHON_DOWNLOAD_PAGE);
    assert.equal(python.managedDir, managedDirFor('C:\\data', 'python'));
    // 界面要照 purpose / impact 两句话解释"它是给谁用的"——这是用户点名要的那一行说明
    assert.match(python.purpose, /lang/u);
    assert.match(python.purpose, /pwsh/u);
    assert.ok(python.impact.length > 0);
    // 报告里的顺序就是 DEP_NAMES 的顺序（界面按它排）：Python 排在**最后**是新加的那一行
    assert.deepEqual(report.entries.map((entry) => entry.name), ['pwsh', 'rg', 'es', 'python']);
  });

  it('startup 告知：未就绪的每一件都有一句话，且带上装法', async () => {
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: `${name} 未安装`, attempts: [],
      }),
    });
    const lines = summarizeNotReady(await manager.report());
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? '', /PowerShell 7/u);
    assert.match(lines[0] ?? '', /winget/u);
    assert.match(lines[1] ?? '', /ripgrep/u);
    assert.match(lines[1] ?? '', /一键安装/u);
    // 第四件也要有一句话（不然装没装 python 只能去界面里翻）
    assert.match(lines[3] ?? '', /Python/u);
    assert.match(lines[3] ?? '', /一键安装/u);
  });
});

// ──────────────────────────────── zip 解析 ────────────────────────────────

/** 手写一个最小 zip：只支持 store 与 deflate，够用来验解析 */
function buildZip(entries: Array<{ name: string; data: Buffer; store?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const method = entry.store === true ? 0 : 8;
    const body = method === 0 ? entry.data : deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

/** CRC32（zip 的校验字段）。手写一份：零依赖约束下不引包 */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('zip 解析与解压（零依赖自实现）', () => {
  it('能读 store 与 deflate 两种成员（ripgrep 的包是 deflate）', () => {
    const zip = buildZip([
      { name: 'x86_64-pc-windows-msvc/rg.exe', data: Buffer.from('fake-rg-binary', 'utf8') },
      { name: 'x86_64-pc-windows-msvc/LICENSE-MIT', data: Buffer.from('MIT', 'utf8'), store: true },
    ]);
    const read = readZipEntries(zip);
    assert.equal(read.ok, true, read.error);
    assert.deepEqual(read.entries.map((entry) => entry.name), [
      'x86_64-pc-windows-msvc/rg.exe',
      'x86_64-pc-windows-msvc/LICENSE-MIT',
    ]);
    assert.equal(read.entries[0]?.data.toString('utf8'), 'fake-rg-binary');
    assert.equal(read.entries[1]?.data.toString('utf8'), 'MIT');
  });

  it('单层公共前缀会被剥掉（`ripgrep-x/rg.exe` → `rg.exe`）——装完的目录才扁平', () => {
    const zip = buildZip([
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe', data: Buffer.from('a', 'utf8') },
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/doc/rg.1', data: Buffer.from('b', 'utf8') },
    ]);
    const stripped = stripSingleTopDir(readZipEntries(zip).entries);
    assert.deepEqual(stripped.map((entry) => entry.name), ['rg.exe', 'doc/rg.1']);
  });

  it('不是"单层公共前缀"就不剥（两个顶层目录时保持原样）', () => {
    const zip = buildZip([
      { name: 'bin/rg.exe', data: Buffer.from('a', 'utf8') },
      { name: 'doc/rg.1', data: Buffer.from('b', 'utf8') },
    ]);
    const stripped = stripSingleTopDir(readZipEntries(zip).entries);
    assert.deepEqual(stripped.map((entry) => entry.name), ['bin/rg.exe', 'doc/rg.1']);
  });

  it('不是 zip 时如实报"不是 zip"，而不是抛异常或解出一堆垃圾', () => {
    const read = readZipEntries(Buffer.from('<html>代理拦截页</html>', 'utf8'));
    assert.equal(read.ok, false);
    assert.match(read.error, /不是 zip/u);
  });

  it('截断的 zip 被识别为损坏（下载中断的包不该被当成好包）', () => {
    const zip = buildZip([{ name: 'rg.exe', data: Buffer.from('x'.repeat(2000), 'utf8') }]);
    // 砍掉尾部（EOCD 在最后，砍掉它就没有目录可读）
    const truncated = zip.subarray(0, zip.length - 40);
    const read = readZipEntries(truncated);
    assert.equal(read.ok, false, '截断的包不该解析成功');
    // 只砍数据段（目录还在）时也必须在读成员时报错，而不是给出一份半截的解压结果
    const halfData = zip.subarray(0, 60);
    assert.equal(readZipEntries(halfData).ok, false);
  });
});

// ──────────────────────────────── 安装编排 ────────────────────────────────

/** 假下载源：把给定字节写到目标路径，不联网 */
function fakeDownload(bytes: Buffer, options: { fail?: string; onCall?: (url: string) => void } = {}) {
  return async (url: string, target: string): Promise<{
    ok: boolean; path: string; bytes: number; finalUrl: string; error: string;
  }> => {
    options.onCall?.(url);
    if (options.fail !== undefined) {
      return { ok: false, path: target, bytes: 0, finalUrl: url, error: options.fail };
    }
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
    return { ok: true, path: target, bytes: bytes.length, finalUrl: url, error: '' };
  };
}

describe('一键安装：下载 → 解压 → 复检', () => {
  it('整条链走通：解压到自装目录、复检通过、写清单、并刷新探测缓存', async () => {
    const root = await tempDir('irmia-dep-');
    const dataDir = join(root, 'data');
    const zip = buildZip([
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe', data: Buffer.from('exe-bytes', 'utf8') },
      { name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc/README.md', data: Buffer.from('# rg', 'utf8') },
    ]);

    // 探测结论由"文件系统上真的有没有"决定：装完复检才有意义。
    // 复检那一步注入假探测——测试里落地的是一段假字节，跑不起来（生产路径走真探测）
    const manager = new DepsManager({
      dataDir,
      probe: async (name) => {
        const exe = join(managedDirFor(dataDir, name), name === 'rg' ? 'rg.exe' : 'es.exe');
        const ok = existsSync(exe);
        return {
          name,
          status: ok ? 'ready' : 'missing',
          path: ok ? exe : '',
          version: ok ? '15.1.0' : '',
          anyVersion: '',
          source: ok ? 'managed' : null,
          dir: ok ? managedDirFor(dataDir, name) : null,
          reason: ok ? '' : `${name} 未安装`,
          attempts: [],
        };
      },
      verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '15.1.0' } : null),
      download: fakeDownload(zip),
    });

    assert.equal((await manager.get('rg')).status, 'missing');
    const outcome = await manager.install('rg');
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;

    assert.equal(outcome.step, 'done');
    assert.equal(outcome.dir, managedDirFor(dataDir, 'rg'));
    assert.equal(outcome.exePath, join(managedDirFor(dataDir, 'rg'), 'rg.exe'));
    assert.equal(existsSync(outcome.exePath), true, '可执行文件必须真落地');
    assert.equal(existsSync(join(outcome.dir, 'README.md')), true, '顶层目录被剥掉后其余文件照落');
    assert.equal(existsSync(join(outcome.dir, 'ripgrep-15.1.0-x86_64-pc-windows-msvc')), false, '不该留着那层壳');

    // 清单：人可读（装了什么、从哪来）
    const manifest = await readManifest(dataDir, 'rg');
    assert.equal(manifest?.['name'], 'rg');
    assert.equal(manifest?.['exePath'], outcome.exePath);

    // **复检通过后缓存必须刷新**：不然界面点亮了、工具还看不见
    assert.equal((await manager.get('rg')).status, 'ready');
  });

  it('失败一：下载失败 → step=download，且说清"重试还是换源"', async () => {
    const root = await tempDir('irmia-dep-');
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      download: fakeDownload(Buffer.alloc(0), { fail: 'HTTP 404' }),
    });

    const outcome = await manager.install('es');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.step, 'download');
    assert.match(outcome.error, /下载失败/u);
    assert.match(outcome.error, /HTTP 404/u);
    assert.match(outcome.error, /打开下载页/u, '要给出下一步');
    assert.ok(outcome.details.some((line) => line.includes(ES_CLI_ZIP_URL)), '细节里要有下载地址');
  });

  /**
   * ──────────────── 下载失败时的**离线包回退**（用户 2026-10-16 点名要的那条路） ────────────────
   *
   * 这台机器上的 7897 是死的（隧道建不起来），别的机器上还有代理、防火墙、公司镜像。
   * 一条"必须联网才能装上"的依赖，在一台连不出去的机器上就是永远装不上——而人手里有浏览器。
   *
   * 三条判据分别对应实现里三个**会出错的地方**：
   *   ① 用了离线包就要说清（不许假装联网成功）；
   *   ② **失败的下载不许把用户放的那个包毁掉**（下载器流式写同一个路径 —— 暂存必须在下载之前）；
   *   ③ 没放包时那句错误要**带上确切路径**（"失败时用户该把什么放到哪里"要能照抄）。
   */
  /**
   * python 的"版本查询"夹具。**离线那三条用例必须注入它**：
   * 不给的话 `packageFor('python').resolveUrl` 会去问真 python.org——那既是联网测试，
   * 也会让"钉住的兜底地址"这条断言随上游版本漂移（实测 2026-10-16 它回的是 3.15.0）。
   */
  const pythonReleaseJson = (): string => JSON.stringify([
    { name: 'Python 3.15.0', pre_release: false },
    { name: 'Python 3.14.8', pre_release: false },
    { name: 'Python 3.15.0rc1', pre_release: true },
  ]);

  it('离线回退①：下载失败但人放了 `<dataDir>/tools/.cache/python.zip` ⇒ 用它装上，且如实说清', async () => {
    const root = await tempDir('irmia-dep-');
    const dataDir = join(root, 'data');
    const cacheDir = join(dataDir, 'tools', '.cache');
    await mkdir(cacheDir, { recursive: true });
    // 人手动放下的官方包（这里用最小 zip 代替：形状一样，`python.exe` 在根，没有顶层目录）
    const offline = buildZip([{ name: 'python.exe', data: Buffer.from('fake-python', 'utf8') }]);
    await writeFile(join(cacheDir, 'python.zip'), offline);

    const manager = new DepsManager({
      dataDir,
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '3.13.16' } : null),
      fetchText: async () => pythonReleaseJson(),
      // 网络这一路**一律失败**：这一条要证的正是"不靠网络也能装上"
      download: fakeDownload(Buffer.alloc(0), { fail: 'ECONNREFUSED 127.0.0.1:7897' }),
    });

    const outcome = await manager.install('python');
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error);
    if (!outcome.ok) return;
    assert.equal(outcome.step, 'done');
    assert.equal(outcome.exePath, join(managedDirFor(dataDir, 'python'), 'python.exe'));
    assert.equal(existsSync(outcome.exePath), true, '离线包也要真落地');
    // ① 不许假装联网成功：失败原因与"用的是本地包"都要在 details 里
    assert.ok(
      outcome.details.some((line) => /下载失败/.test(line) && /ECONNREFUSED/.test(line)),
      `details 里要有真实的下载失败原因：${outcome.details.join(' | ')}`,
    );
    assert.ok(
      outcome.details.some((line) => /手动放的离线包/.test(line)),
      `details 里要说清用的是本地包：${outcome.details.join(' | ')}`,
    );
    // 清单不许拿下载地址假装：sourceUrl 是那个本地路径
    const manifest = await readManifest(dataDir, 'python');
    assert.equal(manifest?.['sourceUrl'], join(cacheDir, 'python.zip'));
    assert.equal(manifest?.['version'], '3.13.16');
    // 用户自己那份留着（我们没有资格替他扔东西），暂存件用完就删
    assert.equal(existsSync(join(cacheDir, 'python.zip')), true);
    assert.equal(existsSync(join(cacheDir, 'python.offline.zip')), false);
  });

  it('离线回退②：**失败的下载不许毁掉用户放的包**（暂存发生在下载之前）', async () => {
    const root = await tempDir('irmia-dep-');
    const dataDir = join(root, 'data');
    const cacheDir = join(dataDir, 'tools', '.cache');
    await mkdir(cacheDir, { recursive: true });
    const offline = buildZip([{ name: 'python.exe', data: Buffer.from('fake-python', 'utf8') }]);
    const offlinePath = join(cacheDir, 'python.zip');
    await writeFile(offlinePath, offline);

    // 最阴的一种失败：下载器**先截断目标文件再报错**（真实实现就是流式写同一个路径的）
    const truncating = async (url: string, target: string): Promise<{
      ok: boolean; path: string; bytes: number; finalUrl: string; error: string;
    }> => {
      await writeFile(target, Buffer.alloc(0));
      return { ok: false, path: target, bytes: 0, finalUrl: url, error: 'HTTP 502（写到一半断了）' };
    };

    const manager = new DepsManager({
      dataDir,
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '3.13.16' } : null),
      fetchText: async () => pythonReleaseJson(),
      download: truncating,
    });

    const outcome = await manager.install('python');
    assert.equal(outcome.ok, true, `下载把同路径的文件截断了，但暂存件该救回来：${outcome.ok ? '' : outcome.error}`);
    assert.equal(existsSync(join(managedDirFor(dataDir, 'python'), 'python.exe')), true);
    // 用户自己那份**不动**（那是他的文件），临时件用完就删
    assert.equal(existsSync(offlinePath), true, '用户放的包不该被我们删掉或覆盖');
    assert.equal(
      (await readFile(offlinePath)).length,
      offline.length,
      '用户放的包必须与原文件逐字节一样长（没被那次失败的下载截断）',
    );
    assert.equal(existsSync(join(cacheDir, 'python.offline.zip')), false, '暂存件装完要删掉');
  });

  it('离线回退③：没放包时，那句错误要带上**确切路径**（用户照抄就能做）', async () => {
    const root = await tempDir('irmia-dep-');
    const dataDir = join(root, 'data');
    const manager = new DepsManager({
      dataDir,
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      // 让"查最新版"这条路**必然挑不出结果**（列表里只有 rc）⇒ 用钉住的兜底地址。
      // 这样这条用例既断言的是那个**确定的**常量地址，又完全不联网（不许依赖上游版本）。
      fetchText: async () => JSON.stringify([{ name: 'Python 3.16.0rc1', pre_release: true }]),
      download: fakeDownload(Buffer.alloc(0), { fail: 'ECONNREFUSED 127.0.0.1:7897' }),
    });

    const outcome = await manager.install('python');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    // 没放包 ⇒ 阶段仍然是 **download**（回退不许把失败态吃掉）
    assert.equal(outcome.step, 'download');
    assert.match(outcome.error, /下载失败/u);
    assert.match(outcome.error, /ECONNREFUSED/u);
    const expected = join(dataDir, 'tools', '.cache', 'python.zip');
    assert.ok(outcome.error.includes(expected), `错误里要有那句"放到这里"的确切路径：${outcome.error}`);
    assert.ok(
      outcome.details.some((line) => line.includes(expected)),
      `details 里也要有它：${outcome.details.join(' | ')}`,
    );
    assert.ok(outcome.details.some((line) => line.includes(PYTHON_EMBED_URL)), 'details 里要有官方下载地址');
  });

  /**
   * ──────────────── 重装不许清空 `Lib\site-packages`（P1-19，2026-10-18） ────────────────
   *
   * 病：整条编排是"下载 → **清空目标目录** → 解压 → 复检"，而托管 Python 的 `Lib\site-packages`
   * 里装的是**她后来 `pip install` 的东西**——那些包不在我们任何一个 zip 里。重装就等于替她
   * 把装过的包静默卸掉，而回执里一个字都不提。
   *
   * 修：重装时把 `Lib/site-packages` 挪到一边、装完迁回，并在 details 里明说"保住了什么"；
   * 其余文件**照旧清空**（留一半旧文件会让复检认出一个上一次装坏的 exe，那条纪律没变）。
   *
   * 两条用例各锁一半：① 装两遍她的包还在、旧版独有文件照旧被清掉；② 第二遍的包是坏的
   * （含越界成员）时，已经挪出去的包必须迁回——**失败也不许丢**。
   */
  const installFor = (dataDir: string, bytes: Buffer): DepsManager => new DepsManager({
    dataDir,
    probe: async (name) => ({
      name, status: 'missing', path: '', version: '', anyVersion: '',
      source: null, dir: null, reason: '', attempts: [],
    }),
    verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '3.13.16' } : null),
    fetchText: async () => pythonReleaseJson(),
    download: fakeDownload(bytes),
    // pip 引导不是这一组的事（它自己有整整一组用例）：这里只回一个"成功"，不碰真 python
    bootstrapPip: async () => ({
      ok: true, version: '26.2.1', step: 'verify', reason: '', details: ['（用例：假 pip 引导）'],
    }),
  });

  it('重装①：装两遍之后，她 `pip install` 的包一个字节都没少，且回执里明说保住了什么', async () => {
    const root = await tempDir('irmia-dep-');
    const dataDir = join(root, 'data');
    const dir = managedDirFor(dataDir, 'python');
    const site = join(dir, 'Lib', 'site-packages');
    // 两版包：第二版换了 python.exe 的字节，且**没有** v1 那个 first-only.txt
    const v1 = buildZip([
      { name: 'python.exe', data: Buffer.from('python-v1', 'utf8') },
      { name: 'first-only.txt', data: Buffer.from('v1 only', 'utf8') },
    ]);
    const v2 = buildZip([{ name: 'python.exe', data: Buffer.from('python-v2', 'utf8') }]);

    const first = await installFor(dataDir, v1).install('python');
    assert.equal(first.ok, true, first.ok ? '' : first.error);
    // 第一次装：没有可保的，就不许出现"保住了什么"（否则是制造一个不存在的动作）
    assert.equal(
      first.details.some((line) => line.includes('重装保留了')),
      false,
      `第一次装不该说"保留"：${first.details.join(' | ')}`,
    );

    // 她装了两个第三方包（这就是"她 pip install 的一切"）
    await mkdir(join(site, 'six'), { recursive: true });
    await writeFile(join(site, 'six', '__init__.py'), '# 她装的 six\n', 'utf8');
    await mkdir(join(site, 'packaging-24.0.dist-info'), { recursive: true });
    await writeFile(join(site, 'packaging-24.0.dist-info', 'METADATA'), 'Name: packaging\nVersion: 24.0\n', 'utf8');

    const second = await installFor(dataDir, v2).install('python');
    assert.equal(second.ok, true, second.ok ? '' : second.error);

    // ① 她的包一个字节都没少（两个都查：一个带目录、一个带版本号目录）
    assert.equal(await readFile(join(site, 'six', '__init__.py'), 'utf8'), '# 她装的 six\n', 'third-party 包必须还在');
    assert.equal(
      await readFile(join(site, 'packaging-24.0.dist-info', 'METADATA'), 'utf8'),
      'Name: packaging\nVersion: 24.0\n',
      'dist-info 也要在（pip 靠它认版本）',
    );
    // ② 该覆盖的覆盖、该清的清：这不是"干脆不删目录"
    assert.equal(await readFile(join(dir, 'python.exe'), 'utf8'), 'python-v2', '新包的可执行文件要覆盖旧的');
    assert.equal(
      existsSync(join(dir, 'first-only.txt')),
      false,
      '旧版独有的文件要清掉，否则复检会认出一个上一次装坏的东西',
    );
    // ③ 回执里明说保留了什么（"她装过的东西还在"必须是一句可对账的话）
    assert.ok(
      second.details.some((line) => line.includes('重装保留了 Lib/site-packages')
        && line.includes('2 个文件')),
      `details 要说清保住了哪一棵子树、多少文件：${second.details.join(' | ')}`,
    );
    // 暂存目录不许留在 `<dataDir>/tools/` 下面（装完就该没了）
    const leftovers = (await readdir(join(dataDir, 'tools'))).filter((name) => name.startsWith('.reinstall-'));
    assert.deepEqual(leftovers, [], `暂存目录没清掉：${leftovers.join(', ')}`);
  });

  it('重装②：新包里有 `../` 越界成员 ⇒ 中止，但已经挪出去的她的包必须迁回来', async () => {
    const root = await tempDir('irmia-dep-');
    const dataDir = join(root, 'data');
    const dir = managedDirFor(dataDir, 'python');
    const site = join(dir, 'Lib', 'site-packages');
    const good = buildZip([{ name: 'python.exe', data: Buffer.from('python-v1', 'utf8') }]);
    const evil = buildZip([
      { name: 'python.exe', data: Buffer.from('python-v2', 'utf8') },
      { name: '../evil.txt', data: Buffer.from('should never land outside the install dir', 'utf8') },
    ]);

    assert.equal((await installFor(dataDir, good).install('python')).ok, true);
    await mkdir(join(site, 'six'), { recursive: true });
    await writeFile(join(site, 'six', '__init__.py'), '# 她装的 six\n', 'utf8');

    const second = await installFor(dataDir, evil).install('python');
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.step, 'extract', '越界成员属于包结构问题，阶段要报 extract');
    assert.match(second.error, /路径越界/u);
    // 越界成员一个字节都不许写到安装目录外面
    assert.equal(existsSync(join(dataDir, 'tools', 'evil.txt')), false, 'zip-slip：不许写到目标目录之外');
    // 失败也必须把她的包迁回来（挪出去不搬回来 = 静默卸载）
    assert.equal(
      await readFile(join(site, 'six', '__init__.py'), 'utf8'),
      '# 她装的 six\n',
      '解压失败时她的包也要迁回原位',
    );
  });

  it('失败二：解压失败 → step=extract（下载到的东西不是 zip）', async () => {    const root = await tempDir('irmia-dep-');
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      // 下载成功，但内容是一个 HTML 拦截页
      download: fakeDownload(Buffer.from('<html>blocked</html>', 'utf8')),
    });

    const outcome = await manager.install('rg');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.step, 'extract');
    assert.match(outcome.error, /解压失败/u);
    assert.match(outcome.error, /不是 zip/u);
    // 与下载失败**必须是两句不同的话**（处置完全不同：一个重试、一个换源）
    assert.ok(!outcome.error.includes('下载失败'), '解压失败不该被写成下载失败');
  });

  it('失败三：装完复检仍不行 → step=verify（文件在，但探测不通过）', async () => {
    const root = await tempDir('irmia-dep-');
    const zip = buildZip([{ name: 'rg/rg.exe', data: Buffer.from('not-really-rg', 'utf8') }]);
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      download: fakeDownload(zip),
      // 复检走真探测：这个假 exe 跑不起来 → verify 失败
      probeTimeoutMs: 3000,
    });

    const outcome = await manager.install('rg');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.step, 'verify');
    assert.match(outcome.error, /复检/u);
    assert.match(outcome.error, /杀毒软件/u, '要给出最可能的下一步（隔离是这类失败的头号原因）');
    assert.equal(existsSync(join(managedDirFor(join(root, 'data'), 'rg'), 'rg.exe')), true, '文件确实落地了');
  });

  it('pwsh **不提供一键安装**：如实说清为什么，并给出官方下载页', async () => {
    const root = await tempDir('irmia-dep-');
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name, status: 'missing', path: '', version: '', anyVersion: '',
        source: null, dir: null, reason: '', attempts: [],
      }),
      // 给了下载器也不该被用到：pwsh 这条路根本不进下载
      download: fakeDownload(Buffer.from('should-not-be-used', 'utf8')),
    });

    const outcome = await manager.install('pwsh');
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.error, /不支持一键安装/u);
    assert.ok(outcome.details.some((line) => line.includes(PWSH_DOWNLOAD_PAGE)));
    assert.ok(outcome.details.some((line) => /UAC|提权|MSI/u.test(line)), '取舍理由要写在回执里');
    assert.equal(packageFor('pwsh'), null);
  });

  it('es 的包地址是 voidtools 的 CLI 包；rg 用 GitHub API 解析最新版', async () => {
    const es = packageFor('es');
    assert.equal(es?.url, ES_CLI_ZIP_URL);
    assert.match(ES_CLI_ZIP_URL, /^https:\/\/www\.voidtools\.com\/ES-[\d.]+\.x64\.zip$/u);
    assert.deepEqual(es?.exeNames, ['es.exe']);
    assert.equal(DEP_SPECS.es.downloadPage, ES_DOWNLOAD_PAGE);

    // rg：不写死版本号，从 release API 里挑 Windows 资产
    const asset = await resolveRipgrepAsset(async () => JSON.stringify({
      tag_name: '15.1.0',
      assets: [
        { name: 'ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz', browser_download_url: 'https://x/linux' },
        {
          name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
          browser_download_url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
        },
      ],
    }));
    assert.equal(asset.ok, true);
    if (!asset.ok) return;
    assert.equal(asset.version, '15.1.0');
    assert.match(asset.url, /windows-msvc\.zip$/u);

    // API 挂了要如实说，而不是静默用一个空地址去下载
    const failed = await resolveRipgrepAsset(async () => {
      throw new Error('ECONNRESET');
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /ECONNRESET/u);

    // 没有 msvc 资产时也要如实报（而不是随便挑一个装错平台）
    const wrongPlatform = await resolveRipgrepAsset(async () => JSON.stringify({
      tag_name: '15.1.0',
      assets: [{ name: 'ripgrep-15.1.0-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://x/mac' }],
    }));
    assert.equal(wrongPlatform.ok, false);
  });

  /**
   * Python 的包地址有**两条路**（与 rg 同形：能查就查、查不到用钉住的兜底），
   * 但兜底那条比 rg 稳——python.org 的 ftp 路径形状从 3.5 至今没变过。这一条钉三件事：
   *   ① 兜底地址是钉住的 3.13.16（用户 2026-10-16 批的那一版，当时实测 HEAD 200）；
   *   ② API 那条路能挑出**真正最新的稳定版**，且**版本序按数字比**（字符串序会把 3.9 排在 3.15 前）；
   *   ③ rc / 开发版**不许**被挑中（它们在同一个列表里，实测 `3.15.0rc1` 就在）。
   */
  it('python 的包地址：钉住 3.13.16 兜底，API 那条路挑最新稳定版（rc 与字符串序都不许混进来）', async () => {
    const pkg = packageFor('python');
    assert.equal(pkg?.url, PYTHON_EMBED_URL);
    assert.match(PYTHON_EMBED_URL, /^https:\/\/www\.python\.org\/ftp\/python\/[\d.]+\/python-[\d.]+-embed-amd64\.zip$/u);
    assert.equal(PYTHON_EMBED_URL, 'https://www.python.org/ftp/python/3.13.16/python-3.13.16-embed-amd64.zip');
    // embeddable 包没有顶层目录：`python.exe` 就在根；`python3.exe` 是商店版的名字，手工放包时会出现
    assert.deepEqual(pkg?.exeNames, ['python.exe', 'python3.exe']);
    assert.equal(DEP_SPECS.python.downloadPage, PYTHON_DOWNLOAD_PAGE);

    // ② 版本序按数字比、③ 排除非稳定版：夹具刻意把 3.9.0 放前面、把 rc 放在最新那个旁边
    const list = JSON.stringify([
      { name: 'Python 3.9.0', pre_release: false },
      { name: 'Python 3.15.0rc1', pre_release: true },
      { name: 'Python 3.15.0', pre_release: false },
      { name: 'Python 3.14.8', pre_release: false },
      { name: 'Python 3.15.0a1', pre_release: false },
      { name: 'Python 2.7.18', pre_release: false },
    ]);
    const picked = pickLatestPythonRelease(list);
    assert.equal(picked.ok, true, picked.ok ? '' : picked.error);
    if (!picked.ok) return;
    assert.equal(picked.version, '3.15.0', '字符串序会把 3.9.0 排到最前；rc / a1 / 2.x 都不许中选');
    assert.equal(picked.url, 'https://www.python.org/ftp/python/3.15.0/python-3.15.0-embed-amd64.zip');

    const resolved = await resolvePythonEmbedUrl(async () => list);
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.version, '3.15.0');

    // 三种"挑不出来"都要**如实报**，而不是给一个空地址去下载（调用方那时会用钉住的兜底）
    for (const bad of ['<html>拦截页</html>', '{"objects":[]}', JSON.stringify({ nope: 1 })]) {
      const failed = pickLatestPythonRelease(bad);
      assert.equal(failed.ok, false, `这份输入不该挑出结果：${bad}`);
      if (!failed.ok) assert.ok(failed.error.length > 0, '失败必须带一句人话');
    }
    // 列表里只有 rc 时也不许将就
    const onlyRc = pickLatestPythonRelease(JSON.stringify([{ name: 'Python 3.16.0rc1', pre_release: true }]));
    assert.equal(onlyRc.ok, false, '宁可退回钉住的 3.13.16，也不许装一个 rc');
    // API 抛错时给的是"查询失败"，不是静默
    const threw = await resolvePythonEmbedUrl(async () => {
      throw new Error('ECONNRESET');
    });
    assert.equal(threw.ok, false);
    if (!threw.ok) assert.match(threw.error, /ECONNRESET/u);
  });

  it('安装的落点是 <dataDir>/tools/<name>，且清单写在那个目录里', async () => {
    const root = await tempDir('irmia-dep-');
    const zip = buildZip([{ name: 'rg.exe', data: Buffer.from('bytes', 'utf8') }]);
    // fetchText 注入假的 release 元数据：这条用例要在**任意一台机器、任意网络**下同一个结果，
    // 绝不能让 packageFor 去问真 GitHub（那既是联网测试，也会随上游版本漂移）
    const manager = new DepsManager({
      dataDir: join(root, 'data'),
      probe: async (name) => ({
        name,
        status: existsSync(join(managedDirFor(join(root, 'data'), name), 'rg.exe')) ? 'ready' : 'missing',
        path: '', version: '', anyVersion: '', source: null, dir: null, reason: '', attempts: [],
      }),
      verifyProbe: async (exePath) => (existsSync(exePath) ? { version: '15.1.0' } : null),
      fetchText: async () => JSON.stringify({
        tag_name: '15.1.0',
        assets: [{
          name: 'ripgrep-15.1.0-x86_64-pc-windows-msvc.zip',
          browser_download_url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/rg.zip',
        }],
      }),
      download: fakeDownload(zip),
    });
    const installed = await manager.install('rg');
    assert.equal(installed.ok, true, installed.ok ? '' : installed.error);
    assert.equal(existsSync(join(root, 'data', 'tools', 'rg', 'install.json')), true);
    const manifest = JSON.parse(await readFile(join(root, 'data', 'tools', 'rg', 'install.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(manifest['name'], 'rg');
    assert.equal(manifest['sourceUrl'], 'https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/rg.zip');
    assert.equal(manifest['version'], '15.1.0');
    // 下载的临时包不该留在 .cache 里
    assert.equal(existsSync(join(root, 'data', 'tools', '.cache', 'rg.zip')), false);
  });
});

// ──────────────────────────────── PATH 优先 · 托管兜底（2026-10-17 口径翻正） ────────────────────────────────

/**
 * 用户 2026-10-17 的口径（**覆盖上一版的"托管优先、PATH 兜底"**）：
 *
 * > 「**Python 和 pip 不应该是默认要求装的，而是有就用 PATH 里的。没有的话就要求装。**」
 *
 * 这一组锁三件事，每件都会骗到人：
 *   ① **PATH 上有一个可用的 ⇒ 这一件就是"已就绪"**，报告里**不许**再出现"建议安装"；
 *      探到的路径与版本要能显示出来；
 *   ② **PATH 的 python 没有 pip ⇒ 不算"未就绪"**：python 可用就是可用，pip 那一行单独说清
 *      （并给出路：装框架托管那份，或她自己 `python -m pip`）；托管那份没有 pip 是**另一句话**；
 *   ③ **托管那份仍然保留**：一个都没有时它顶上，一键安装 / pip 引导 / 离线回退都不动。
 */
describe('python：PATH 优先 · 托管兜底（用户 2026-10-17）', () => {
  const managedDir = 'C:\\data\\tools\\python';
  const managedExe = `${managedDir}\\python.exe`;

  /** 造一个走真 `probeDependency`、只注入假进程与假文件系统、并且**带上 pip 探测**的管理器 */
  function managerWith(input: {
    answers: Record<string, string | { stdout: string; code?: number; timedOut?: boolean; failed?: boolean }>;
    files?: readonly string[];
    pip?: Map<string, { ok: boolean; version: string; reason: string }>;
  }): { manager: DepsManager; seen: string[] } {
    const fs = fakeFs(input.files ?? []);
    const seen: string[] = [];
    const manager = new DepsManager({
      dataDir: 'C:\\data',
      exists: fs.exists,
      listDir: fs.listDir,
      probe: (name, spec) => probeDependency(spec, {
        managedDir: managedDirFor('C:\\data', name),
        exists: fs.exists,
        listDir: fs.listDir,
        runProbe: fakeRunner(input.answers, seen),
        ...(name === 'python'
          ? { probePip: async (exe) => input.pip?.get(exe) ?? { ok: false, version: '', reason: '夹具：没有 pip' } }
          : {}),
      }),
    });
    return { manager, seen };
  }

  it('PATH 有 python ⇒ 报告里是"已就绪"（不是"建议安装"），路径与版本都摆出来', async () => {
    const { manager } = managerWith({ answers: { 'python.exe': 'Python 3.11.5' } });
    const report = await manager.report();
    const python = report.entries.find((entry) => entry.name === 'python')!;
    assert.equal(python.ok, true);
    assert.equal(python.status, 'ready');
    assert.equal(python.action, null, '已就绪就没有建议动作（界面上不会出现「安装」按钮）');
    assert.equal(python.path, 'python.exe', '命中的就是 PATH 上那个（spawn 自己解析 PATH）');
    assert.equal(python.version, '3.11.5', '版本要显示出来（owner 要的「探到的路径与版本要显示出来」）');
    assert.equal(python.source, 'path');
    assert.equal(sourceKindOf(python.source), 'system', '界面按它说"系统 PATH 上的 Python"');
    // 卡头那句汇总也不该再点它：四件依赖里只有真正缺的那几件进 needsAttention 的账
    const lines = summarizeNotReady(report);
    assert.equal(lines.some((line) => line.includes('Python')), false,
      `PATH 上有一个可用的 python，就不该再有"未就绪"那一行：${lines.join(' | ')}`);
  });

  it('PATH 的 python **没有 pip** ⇒ pip 那一行如实说，但 python 那一件仍是"已就绪"', async () => {
    const { manager } = managerWith({
      answers: { 'python.exe': 'Python 3.11.5' },
      pip: new Map([['python.exe', { ok: false, version: '', reason: '出厂那句' }]]),
    });
    const python = (await manager.report()).entries.find((entry) => entry.name === 'python')!;
    assert.equal(python.status, 'ready', '**python 可用就是可用**——不许因为没 pip 就判未就绪');
    assert.equal(python.pipVersion, '');
    assert.match(python.pipReason, /系统这份 Python 上没有可用的 pip/u, '要如实说清是"系统这份"没有 pip');
    assert.match(python.pipReason, /跑脚本/u, '要说清这不影响用它跑脚本（不然会以为整件废了）');
    assert.match(python.pipReason, /一键装/u, '要给出路：可以装框架托管那一份（带 pip）');
    assert.match(python.pipReason, /ensurepip/u, '第二条出路：她自己补 pip');
  });

  it('PATH 的 python **有 pip** ⇒ 版本照常显示（就用它，不去碰托管那份）', async () => {
    const { manager, seen } = managerWith({
      answers: { 'python.exe': 'Python 3.11.5', [managedExe]: 'Python 3.13.16' },
      files: [managedExe],
      pip: new Map([['python.exe', { ok: true, version: '26.2.1', reason: '' }]]),
    });
    const python = (await manager.report()).entries.find((entry) => entry.name === 'python')!;
    assert.equal(python.pipVersion, '26.2.1');
    assert.equal(python.pipReason, '');
    assert.equal(python.path, 'python.exe');
    assert.equal(seen.includes(managedExe), false, `托管那份一次都不该被碰：${seen.join(' → ')}`);
  });

  it('PATH 一个都没有、托管有 ⇒ 用托管的（"没有的话就要求装"那条路走通）', async () => {
    const { manager } = managerWith({
      answers: { [managedExe]: 'Python 3.13.16' },
      files: [managedExe],
      pip: new Map([[managedExe, { ok: true, version: '26.2.1', reason: '' }]]),
    });
    const python = (await manager.report()).entries.find((entry) => entry.name === 'python')!;
    assert.equal(python.status, 'ready');
    assert.equal(python.source, 'managed');
    assert.equal(python.path, managedExe);
    assert.equal(sourceKindOf(python.source), 'managed', '界面按它说"框架托管的那份"');
  });

  it('托管那份没有 pip ⇒ 说的是**另一句话**（重装即可），与"系统这份没 pip"不混', async () => {
    const { manager } = managerWith({
      answers: { [managedExe]: 'Python 3.13.16' },
      files: [managedExe],
      pip: new Map([[managedExe, { ok: false, version: '', reason: '夹具' }]]),
    });
    const python = (await manager.report()).entries.find((entry) => entry.name === 'python')!;
    assert.equal(python.status, 'ready');
    assert.match(python.pipReason, /框架托管的那份 Python/u);
    assert.match(python.pipReason, /重新一键安装/u);
    assert.equal(/系统这份/u.test(python.pipReason), false, '两句话不许混：一个是系统的、一个是托管的');
  });

  it('两槽候选的取值：PATH 槽给裸名、托管槽给完整路径（工具的 PATH 优先靠这两格落地）', async () => {
    const ready = { name: 'python', status: 'ready', path: managedExe, version: '3.13.16', anyVersion: '3.13.16', source: 'managed', dir: managedDir, reason: '', attempts: [] } as const;
    assert.equal(pathInterpreterSlotOf(ready, ['python3', 'python']), 'python3',
      '托管命中时 PATH 槽退到裸名链的第一项（PATH 优先在任何来源下都不能退化）');
    assert.equal(isManagedHit(ready, managedDir), true);
    assert.equal(isManagedHit(ready, 'C:\\data\\tools\\other'), false);
    // PATH 命中时它是 PATH 上那个候选名本身；用户指定时给的是他指的路径
    const onPath = { ...ready, path: 'python.exe', source: 'path' as const, dir: null };
    assert.equal(pathInterpreterSlotOf(onPath, ['python3', 'python']), 'python.exe');
    const configured = { ...ready, path: 'D:\\Python311\\python.exe', source: 'config' as const, dir: null };
    assert.equal(pathInterpreterSlotOf(configured, ['python3', 'python']), 'D:\\Python311\\python.exe');
    // 未就绪时两槽都是 null（工具那一侧才会走"找不到"那条诚实回执）
    const missing = { ...ready, status: 'missing' as const, path: '', source: null, dir: null };
    assert.equal(pathInterpreterSlotOf(missing, ['python3', 'python']), null);
    // 托管槽用的是**与探测第二段逐字相同**的定位（`python.exe` 不在 PATH 上、也不在名字链里）
    const slots = managedInterpreterOf(DEP_SPECS.python.candidates, managedDir,
      (path) => path === managedExe, () => []);
    assert.equal(slots, managedExe);
  });
});

// ──────────────────────────────── pip 引导（用户 2026-10-16：「pip 必须要」） ────────────────────────────────

/**
 * 这一组锁的是**托管 Python 装完必须自带可用的 pip**（她要能自己 `python -m pip install <包>`
 * 来扩展能力，将来的 Office 工具包与 computer use 都挂在这上面）。
 *
 * 两条实测事实写进了实现的形状，用例是它们的回归锁：
 *   ① `python -m ensurepip` 在 **embeddable 包里根本不存在**（实测 "No module named ensurepip"）
 *      ⇒ 走"把 pip 的 wheel 用既有解压器铺进 `Lib\site-packages`"这条路；
 *   ② `python3XX._pth` 里不放开 `import site` 时，铺进去的 pip **一个字节都不生效**
 *      （`_pth` 存在时 Python 忽略环境变量、也不跑 site 初始化）。
 * 另外这一组**绝不联网、绝不起真进程**：wheel 是假 zip，命令执行是注入的假命令。
 */
describe('pip 引导：托管 Python 装完必须自带可用的 pip', () => {
  /** 造一个"刚解压完的托管 python"目录：一个假 exe + 一个真 `_pth`（内容照官方原样） */
  async function fakeManagedPython(root: string, pthName = 'python313._pth') {
    const dir = join(root, 'tools', 'python');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'python.exe'), 'fake-python-bytes', 'utf8');
    await writeFile(
      join(dir, pthName),
      'python313.zip\r\n.\r\n\r\n# Uncomment to run site.main() automatically\r\n#import site\r\n',
      'utf8',
    );
    return dir;
  }

  /** 假的 pip wheel：真的 zip，成员就是 pip 包该有的样子（`pip/` 与 dist-info 平铺在根） */
  function fakePipWheel(): Buffer {
    return buildZip([
      { name: 'pip/__init__.py', data: Buffer.from('__version__ = "26.2.1"\n', 'utf8') },
      { name: 'pip/__main__.py', data: Buffer.from('print("pip")\n', 'utf8') },
      { name: 'pip/_internal/__init__.py', data: Buffer.from('', 'utf8') },
      { name: 'pip-26.2.1.dist-info/METADATA', data: Buffer.from('Name: pip\n', 'utf8'), store: true },
    ]);
  }

  it('`_pth` 按**形状**找（不写死 313）：python315._pth 也认，找不到时返回 null', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root, 'python315._pth');
    assert.equal(findPthFile(dir), join(dir, 'python315._pth'), '版本号不许写死：3.15 的 _pth 也要认');
    const empty = join(root, 'tools', 'empty');
    await mkdir(empty, { recursive: true });
    assert.equal(findPthFile(empty), null, '没有 _pth 时要如实返回 null（由调用方报"包结构变了"）');
  });

  it('`_pth` 放行是**幂等**的：连着改两次，文件字节一样（第二次装/复检重跑不该越改越长）', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const pth = join(dir, 'python313._pth');
    const first = await enableSiteInPth(pth);
    const afterFirst = await readFile(pth, 'utf8');
    const second = await enableSiteInPth(pth);
    const afterSecond = await readFile(pth, 'utf8');
    assert.equal(afterSecond, afterFirst, '第二次不该再改一个字节');
    assert.ok(first.some((line) => /放开/.test(line)), `第一次要如实说改了什么：${first.join(' | ')}`);
    assert.ok(second.some((line) => /幂等/.test(line) || /早已放开/.test(line)), `第二次要说"没重复改"：${second.join(' | ')}`);
    // 三件事都落到了文件上：`import site` 那行不带 `#`、且 `Lib\site-packages` 在
    assert.equal(afterFirst.includes('#import site'), false, '`#import site` 必须被放开');
    assert.match(afterFirst, /^import site$/mu);
    assert.match(afterFirst, /^Lib\\site-packages$/mu);
    // 原有的两行（zip 与 `.`）不许被动过
    assert.match(afterFirst, /^python313\.zip$/mu);
    assert.match(afterFirst, /^\.$/mu);
  });

  it('引导成功：wheel 铺进 Lib\\site-packages、复检拿到 pip 版本、写 pip.ini、清单记下它', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const dataDir = join(root, 'data');
    let usedUrl = '';
    const outcome = await bootstrapPip({
      dir,
      cacheDir: join(dataDir, 'tools', '.cache'),
      download: fakeDownload(fakePipWheel(), { onCall: (url) => { usedUrl = url; } }),
      // PyPI 元数据是注入的假 JSON（**绝不联网**）：挑出的地址与 sha 都是夹具给的
      fetchText: async () => JSON.stringify({
        info: { version: '26.2.1' },
        urls: [{
          filename: 'pip-26.2.1-py3-none-any.whl',
          url: 'https://files.pythonhosted.org/packages/xx/pip-26.2.1-py3-none-any.whl',
          digests: { sha256: '' },
        }],
      }),
      // 命令执行是注入的假命令（真路径上是一段真 python；测试里那个 exe 跑不起来）
      runCommand: async (exe, args) => {
        assert.match(exe, /python\.exe$/u, '要拿托管目录里的解释器去问');
        assert.deepEqual([...args], ['-m', 'pip', '--version']);
        return { stdout: 'pip 26.2.1 from C:\\data\\tools\\python\\Lib\\site-packages\\pip (python 3.13)', stderr: '', code: 0 };
      },
    });

    assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.step}: ${outcome.reason}`);
    if (!outcome.ok) return;
    assert.equal(outcome.version, '26.2.1', 'pip 版本要解析出来（界面与清单都显示它）');
    assert.match(usedUrl, /pip-26\.2\.1-py3-none-any\.whl$/u, '要下载 PyPI 给的那个 wheel');
    // wheel 的成员**平铺**进了 site-packages（这就是"装好 pip"的全部含义）
    const site = join(dir, 'Lib', 'site-packages');
    assert.equal(existsSync(join(site, 'pip', '__main__.py')), true, 'pip 的 __main__.py 必须落地（-m pip 靠它）');
    assert.equal(existsSync(join(site, 'pip-26.2.1.dist-info', 'METADATA')), true, 'dist-info 也要落地');
    // 自包含配置：镜像/超时都写在这一个文件里
    assert.equal(existsSync(join(dir, 'pip.ini')), true, '要写 pip.ini（靠 PIP_CONFIG_FILE 生效）');
    assert.match(await readFile(join(dir, 'pip.ini'), 'utf8'), /\[global\]/u);
    // 下载缓存清掉（wheel 已经铺开了，留着只占地方）
    assert.equal(existsSync(join(dataDir, 'tools', '.cache', 'pip-bootstrap.whl')), false);
  });

  it('引导失败①：wheel 下载不了 ⇒ **python 可用但 pip 不可用**要如实报，且给出手动放包的位置', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const dataDir = join(root, 'data');
    const cacheDir = join(dataDir, 'tools', '.cache');
    const outcome = await bootstrapPip({
      dir,
      cacheDir,
      download: fakeDownload(Buffer.alloc(0), { fail: 'ECONNREFUSED 127.0.0.1:7897' }),
      fetchText: async () => JSON.stringify({
        info: { version: '26.2.1' },
        urls: [{ filename: 'pip-26.2.1-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/xx/pip.whl', digests: { sha256: '' } }],
      }),
      runCommand: async () => ({ stdout: '', stderr: '', code: 0 }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.step, 'download', '阶段要精确到 download（处置是"手动放包或重试"）');
    assert.match(outcome.reason, /下载失败/u);
    assert.match(outcome.reason, /ECONNREFUSED/u);
    assert.ok(outcome.reason.includes(join(cacheDir, 'pip.whl')), `要给出该把 wheel 放到哪：${outcome.reason}`);
    // python 本身不受影响：`_pth` 已经放行、site-packages 已经建好了（下次只需补 wheel）
    assert.equal(existsSync(join(dir, 'Lib', 'site-packages')), true);
  });

  it('引导失败②：wheel 铺进去了但 `-m pip` 起不来 ⇒ 报 verify，不许假装成功', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const outcome = await bootstrapPip({
      dir,
      cacheDir: join(root, 'data', 'tools', '.cache'),
      download: fakeDownload(fakePipWheel()),
      fetchText: async () => JSON.stringify({
        info: { version: '26.2.1' },
        urls: [{ filename: 'pip-26.2.1-py3-none-any.whl', url: 'https://files.pythonhosted.org/packages/xx/pip.whl', digests: { sha256: '' } }],
      }),
      // 真实现里这就是"解释器起不来 / pip 装坏了"的形状
      runCommand: async () => ({ stdout: '', stderr: 'No module named pip', code: 1 }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.step, 'verify');
    assert.match(outcome.reason, /复检不通过/u);
    assert.match(outcome.reason, /No module named pip/u, '解释器自己的错要原样带出来');
    assert.equal(outcome.version, '', '失败时不许给一个"看起来有"的版本');
  });

  it('引导失败③：sha256 与 PyPI 声明不符 ⇒ 中止（包可能被中间层换过）', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const outcome = await bootstrapPip({
      dir,
      cacheDir: join(root, 'data', 'tools', '.cache'),
      download: fakeDownload(fakePipWheel()),
      fetchText: async () => JSON.stringify({
        info: { version: '26.2.1' },
        urls: [{
          filename: 'pip-26.2.1-py3-none-any.whl',
          url: 'https://files.pythonhosted.org/packages/xx/pip.whl',
          digests: { sha256: 'deadbeef'.repeat(8) },
        }],
      }),
      runCommand: async () => ({ stdout: 'pip 26.2.1', stderr: '', code: 0 }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.step, 'download');
    assert.match(outcome.reason, /sha256/u);
  });

  /**
   * ──────────────── wheel 的成员安全与离线包校验（P1-22，2026-10-18） ────────────────
   *
   * 病：铺 wheel 那段是 `join(siteDir, entry.name)` 直接写——**没有**过 install.ts 解压器
   * 那道 zip-slip 判据。wheel 里的名字同样是外部输入（手动放的包还能来自任何地方），
   * 一条 `../../evil.py` 就写到 `Lib\site-packages` 外面去了。
   * 另一半：手动放的 `pip.whl` 原先**什么都不验**（哈希那条路只对联网的包生效），
   * 放错一份包（甚至是别的 wheel）也会被铺进去，直到 `-m pip` 复检失败才暴露。
   *
   * 修：复用同一个判据（`zipEntryPath`——install.ts 解压器用的就是它），
   * 并在拿不到权威哈希时至少证明"合法 zip + 成员安全 + 真的是 pip"，把实际 sha256 如实记下来。
   */
  it('成员安全：wheel 里有 `../../evil.py` ⇒ 中止在 unpack，且一个字节都没写到 site-packages 外面', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const evil = buildZip([
      { name: 'pip/__init__.py', data: Buffer.from('__version__ = "26.2.1"\n', 'utf8') },
      // `<dir>/Lib/site-packages` 往上两级就是 `<dir>`
      { name: '../../evil.py', data: Buffer.from('print("pwned")\n', 'utf8') },
    ]);
    const outcome = await bootstrapPip({
      dir,
      cacheDir: join(root, 'data', 'tools', '.cache'),
      download: fakeDownload(evil),
      fetchText: async () => JSON.stringify({
        info: { version: '26.2.1' },
        urls: [{ filename: 'pip-26.2.1-py3-none-any.whl', url: 'https://x/pip.whl', digests: { sha256: '' } }],
      }),
      runCommand: async () => ({ stdout: 'pip 26.2.1', stderr: '', code: 0 }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.step, 'unpack');
    assert.match(outcome.reason, /路径越界/u);
    assert.equal(existsSync(join(dir, 'evil.py')), false, 'zip-slip：不许写到 site-packages 之外');
    assert.equal(existsSync(join(root, 'evil.py')), false);
  });

  it('离线包①：手动放的 wheel 照样装上，并把"没有权威哈希可比"与实际 sha256 如实记在 details 里', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const cacheDir = join(root, 'data', 'tools', '.cache');
    await mkdir(cacheDir, { recursive: true });
    const wheel = fakePipWheel();
    const offlineWheel = join(cacheDir, 'pip.whl');
    await writeFile(offlineWheel, wheel);
    const sha = createHash('sha256').update(wheel).digest('hex');

    let downloaded = false;
    const outcome = await bootstrapPip({
      dir,
      cacheDir,
      // 离线路径**一次都不该联网**：下载器被调到这里就等于"离线优先"没做到
      download: async () => {
        downloaded = true;
        throw new Error('离线时不该调用下载器');
      },
      runCommand: async () => ({ stdout: 'pip 26.2.1', stderr: '', code: 0 }),
    });
    assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.step}: ${outcome.reason}`);
    assert.equal(downloaded, false, '手动放了 wheel 就不许再联网下载');
    assert.ok(
      outcome.details.some((line) => line.includes(offlineWheel)),
      `details 要说清用的是哪份包：${outcome.details.join(' | ')}`,
    );
    // 拿不到权威哈希时：**如实说**没有哈希可比，并且把实际的 sha256 记下来（事后对账的唯一凭据）
    assert.ok(
      outcome.details.some((line) => /没有权威 sha256/u.test(line) && line.includes(sha)),
      `details 里要有实际 sha256：${outcome.details.join(' | ')}`,
    );
    assert.equal(existsSync(join(dir, 'Lib', 'site-packages', 'pip', '__main__.py')), true, '离线包也要真的铺进去');
  });

  it('离线包②：手动放的是一份"合法 zip 但不是 pip"的包 ⇒ 提前说清，一个文件都不铺', async () => {
    const root = await tempDir('irmia-pip-');
    const dir = await fakeManagedPython(root);
    const cacheDir = join(root, 'data', 'tools', '.cache');
    await mkdir(cacheDir, { recursive: true });
    // 形状完全合法、成员也安全，就是别的包（放错文件时最常见的样子）
    await writeFile(
      join(cacheDir, 'pip.whl'),
      buildZip([{ name: 'six/__init__.py', data: Buffer.from('__version__ = "1.16.0"\n', 'utf8') }]),
    );
    const outcome = await bootstrapPip({
      dir,
      cacheDir,
      download: async () => { throw new Error('不该联网'); },
      runCommand: async () => ({ stdout: 'pip 26.2.1', stderr: '', code: 0 }),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.step, 'unpack');
    assert.match(outcome.reason, /pip\/__init__\.py/u, '要指出判据（缺哪个成员），而不是一句"失败了"');
    assert.equal(existsSync(join(dir, 'Lib', 'site-packages', 'six', '__init__.py')), false, '不是 pip 就别铺');
  });

  it('`python -m pip --version` 的第一行解析：`pip X.Y.Z from …`，别的输出一律 null', () => {
    assert.equal(parsePipVersion('pip 26.2.1 from C:\\x\\Lib\\site-packages\\pip (python 3.13)'), '26.2.1');
    assert.equal(parsePipVersion('pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.11)'), '24.0');
    assert.equal(parsePipVersion('No module named pip'), null);
    assert.equal(parsePipVersion(''), null);
    // 前面有别的行时也要认（有的环境会先打印一句警告）
    assert.equal(parsePipVersion('WARNING: something\npip 26.2.1 from /x (python 3.13)'), '26.2.1');
  });

  it('PyPI 元数据挑选：只认 py3-none-any 的 wheel；结构不对/没有 wheel 都如实报', () => {
    const good = pickPipWheel(JSON.stringify({
      info: { version: '26.2.1' },
      urls: [
        { filename: 'pip-26.2.1.tar.gz', url: 'https://x/pip.tar.gz', digests: { sha256: 'a' } },
        { filename: 'pip-26.2.1-py3-none-any.whl', url: 'https://x/pip.whl', digests: { sha256: 'b' } },
      ],
    }));
    assert.equal(good.ok, true);
    assert.equal(good.version, '26.2.1');
    assert.equal(good.url, 'https://x/pip.whl');
    assert.equal(good.sha256, 'b');
    for (const bad of ['<html>', '{}', JSON.stringify({ urls: [{ filename: 'pip-1.tar.gz', url: 'https://x/a' }] })]) {
      const failed = pickPipWheel(bad);
      assert.equal(failed.ok, false, `这份输入不该挑出结果：${bad}`);
      if (!failed.ok) assert.ok(failed.error.length > 0);
    }
  });
});
