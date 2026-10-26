/**
 * 启动入口的判据段 —— `src/main.ts`（REVIEW P1-29：唯一的生产装配入口零覆盖）
 *
 * 这一份**不起任何真进程**：它只盯 `main.ts` 里那几条"判据型"函数——它们在 2026-10-18
 * 之前是 `runMain` / `main` 的行内表达式，谁也测不到。它建的是**真目录与真 config.json**
 * （`loadConfig` 的解析本来就是那段判据的一部分），但不建数据目录、不开日志、不抢锁。
 *
 * 要守住的三件事（每一条都对应一个启动期的真实失败形状）：
 *   ① 数据目录的取值链：**`--data-dir` 参数 > `IRMIA_DATA_DIR` > config.json 的 `dataDir`
 *      > `<cwd>/data`**（2026-10-23 补上第三档）。弄错的后果不是报错，而是**静默起在另一个
 *      data 目录上**（两份并行事实）——现场那次：key 从配置那份 `.keys.json` 读到、事件却写进
 *      `<cwd>/data`，启动摘要写着 `最大 seq 0`，而真实的 235197 条在另一个目录里。
 *   ② 数据目录与配置**必须一致**：`config.dataDir`（key / 协议端目录 / 依赖自装目录读的那一格）
 *      与生效 `dataDir`（事件 / 人格 / 锁写的那一格）一旦分家，就是上面那种脑裂。
 *   ③ `isDirectRun` / `startupExitCode` / `startupFailureLine`：入口判定与失败回执的形状。
 *
 * ⚠️ 范围说清：`runMain` 本体（建目录 / 开日志 / 抢锁 / 起模型 / 装配各通道）**没有被覆盖**，
 * 那需要真起进程与真数据目录，不在本笔内。这份用例只保证"抽出来的判据是对的"。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

import {
  DEFAULT_DATA_DIR_NAME,
  describeLaneReadout,
  isDirectRun,
  parseMainArgs,
  pinDataDir,
  renderStartupSummary,
  resolveDataDir,
  resolveStartupPaths,
  startupExitCode,
  startupFailureLine,
} from '../src/main.ts';
import { configHash, defaultConfig, loadConfig } from '../src/config/config.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import type { RecoverResult } from '../src/runtime/recover.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

describe('resolveDataDir · 数据目录的取值链：参数 > 环境变量 > 配置 > <cwd>/data', () => {
  const cwd = join('F:', 'cwd');

  test('① 只有 config.json 的 dataDir ⇒ 用它（这是 2026-10-23 修掉的那一档）', () => {
    const resolved = resolveDataDir({ env: {}, cwd, configDataDir: join('G:', 'from-config') });
    assert.equal(resolved.dataDir, join('G:', 'from-config'));
    assert.equal(resolved.source, 'config');
  });

  test('② 环境变量覆盖 config.json 的 dataDir', () => {
    const resolved = resolveDataDir({
      env: { IRMIA_DATA_DIR: join('E:', 'from-env') },
      cwd,
      configDataDir: join('G:', 'from-config'),
    });
    assert.equal(resolved.dataDir, join('E:', 'from-env'));
    assert.equal(resolved.source, 'env');
  });

  test('③ --data-dir 参数覆盖环境变量（三档都给时用参数）', () => {
    const resolved = resolveDataDir({
      dataDir: join('D:', 'explicit'),
      env: { IRMIA_DATA_DIR: join('E:', 'from-env') },
      cwd,
      configDataDir: join('G:', 'from-config'),
    });
    assert.equal(resolved.dataDir, join('D:', 'explicit'));
    assert.equal(resolved.source, 'flag');
  });

  test('④ 三档都没有 ⇒ 落到 <cwd>/data（出厂目录名 data）', () => {
    assert.equal(DEFAULT_DATA_DIR_NAME, 'data');
    const resolved = resolveDataDir({ env: {}, cwd });
    assert.equal(resolved.dataDir, join(cwd, 'data'));
    assert.equal(resolved.source, 'cwd');
  });

  test('⑤ 相对路径不在这里展开：config 那一档交进来的**已经是绝对路径**（见 loadConfig 的用例）', () => {
    // 这条钉的是"职责分工"，不是"忘了展开"：把相对路径解析成绝对路径只有一处实现
    // （`config.ts` 的 `parseAppConfig`，基准是**配置文件所在目录**而不是 cwd）。
    const resolved = resolveDataDir({ env: {}, cwd, configDataDir: join('G:', 'cfg', 'mydata') });
    assert.equal(resolved.dataDir, join('G:', 'cfg', 'mydata'));
  });

  test('环境变量存在但值是空串时**不会**回落到下一档（现状语义：空串也是"给了值"）', () => {
    // 这条不是在夸它，而是在钉住现状：`??` 只看 null/undefined，空串会被原样交给
    // runMain（那里的 mkdirSync 会当场报错，不是静默换目录）。哪天要改成"空串当没给"，
    // 这条用例应当被**显式改掉**，而不是悄悄变绿。
    const resolved = resolveDataDir({ env: { IRMIA_DATA_DIR: '' }, cwd, configDataDir: join('G:', 'x') });
    assert.equal(resolved.dataDir, '');
    assert.equal(resolved.source, 'env');
  });
});

describe('parseMainArgs · 命令行里的 --data-dir / --config / --port（认不出来的一律忽略）', () => {
  test('两种写法都认：`--data-dir X` 与 `--data-dir=X`', () => {
    assert.equal(parseMainArgs(['--data-dir', join('D:', 'a')]).dataDir, join('D:', 'a'));
    assert.equal(parseMainArgs([`--data-dir=${join('D:', 'b')}`]).dataDir, join('D:', 'b'));
  });

  test('`--config` 同样两种写法（它可以在目录、也可以直接指 config.json）', () => {
    assert.equal(parseMainArgs(['--config', join('D:', 'cfg')]).configPath, join('D:', 'cfg'));
    assert.equal(parseMainArgs([`--config=${join('D:', 'cfg', 'config.json')}`]).configPath,
      join('D:', 'cfg', 'config.json'));
  });

  // ── `--port`（2026-10 多实例）：界面给新实例选好的空闲端口必须**当场交给进程** ──
  test('`--port` 两种写法都认，且只认合法端口；非法值当没给（宽容解析的一条）', () => {
    assert.equal(parseMainArgs(['--port', '7789']).port, 7789);
    assert.equal(parseMainArgs(['--port=7801']).port, 7801);
    for (const bad of ['0', '70000', 'abc', '-1', '']) {
      const args = parseMainArgs([`--port=${bad}`]);
      assert.equal(args.port, undefined, `非法端口当没给：${bad}`);
      assert.ok(args.ignored.length >= 1, '并且要留在 ignored 里（诊断时看得见）');
    }
  });

  test('`--port` 与另外两个参数一起给：三格各自落地、互不吞', () => {
    const args = parseMainArgs([
      '--data-dir', join('D:', 'data'), '--config', join('D:', 'cfg'), '--port', '7790',
    ]);
    assert.equal(args.dataDir, join('D:', 'data'));
    assert.equal(args.configPath, join('D:', 'cfg'));
    assert.equal(args.port, 7790);
    assert.deepEqual(args.ignored, []);
  });

  test('别的参数一律忽略、不报错：拉起器会追加 `--kill-tag=…`，它不该让进程起不来', () => {
    const args = parseMainArgs(['--kill-tag=probe-4711', '--data-dir', join('D:', 'a')]);
    assert.equal(args.dataDir, join('D:', 'a'));
    assert.deepEqual(args.ignored, ['--kill-tag=probe-4711']);
  });

  test('空值（`--data-dir=`）当没给：手滑不该让无人值守进程起不来', () => {
    const args = parseMainArgs(['--data-dir=', '--config', '']);
    assert.equal(args.dataDir, undefined);
    assert.equal(args.configPath, undefined);
    assert.deepEqual(args.ignored, ['--data-dir=', '--config']);
  });

  test('一个参数都没给 ⇒ 三个都不设（走缺省：<cwd>/config.json 与它的 dataDir / web.port）', () => {
    const args = parseMainArgs([]);
    assert.equal(args.dataDir, undefined);
    assert.equal(args.configPath, undefined);
    assert.equal(args.port, undefined);
    assert.deepEqual(args.ignored, []);
  });
});

// ──────────────────────── 启动期"配置→数据目录"的整条链 ────────────────────────
//
// 这一组用**真目录 + 真 config.json**：`loadConfig` 的解析（尤其"相对路径相对配置文件"）
// 本来就是判据的一部分，拿假的配置对象测等于把它跳过去。

/** 一份最小的 config.json 文档（其余字段全走默认值，与手写配置的常见形态一致） */
function writeConfig(configDir: string, doc: Record<string, unknown>): string {
  mkdirSync(configDir, { recursive: true });
  const path = join(configDir, 'config.json');
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, ...doc }, null, 2)}\n`, 'utf8');
  return path;
}

describe('resolveStartupPaths · 先定配置、再定数据目录（顺序即判据）', () => {
  test('① 配置里写 dataDir ⇒ 用它；来源 config；且它被**钉进** config.dataDir', async () => {
    const root = tempDirSync('irmia-startup-config-');
    const configDir = join(root, 'cfg');
    const dataDir = join(root, 'elsewhere');
    const configPath = writeConfig(configDir, { dataDir });

    const startup = await resolveStartupPaths({ configPath: configPath, env: {}, cwd: join(root, 'cwd') });

    assert.equal(resolve(startup.dataDir), resolve(dataDir));
    assert.equal(startup.source, 'config');
    assert.equal(startup.configDataDir, dataDir);
    // 决定性的那一条：config.dataDir（keys / 协议端目录读它）与生效 dataDir 必须是同一个
    assert.equal(resolve(startup.loaded.config.dataDir), resolve(startup.dataDir));
    assert.equal(startup.loaded.path, resolve(configPath));
  });

  test('② 环境变量覆盖配置（并说明"配置那一格被覆盖"这条读数拿得到原值）', async () => {
    const root = tempDirSync('irmia-startup-env-');
    const configDir = join(root, 'cfg');
    const fromConfig = join(root, 'from-config');
    const fromEnv = join(root, 'from-env');
    writeConfig(configDir, { dataDir: fromConfig });

    const startup = await resolveStartupPaths({
      configPath: configDir,
      env: { IRMIA_DATA_DIR: fromEnv },
      cwd: join(root, 'cwd'),
    });

    assert.equal(resolve(startup.dataDir), resolve(fromEnv));
    assert.equal(startup.source, 'env');
    // 配置里写的那个原值要留着（启动日志那句"配置写的是 …，本次不生效"靠它）
    assert.equal(startup.configDataDir, fromConfig);
    // 生效之后配置对象与它一致：否则 key 走一套、事件走另一套（脑裂）
    assert.equal(resolve(startup.loaded.config.dataDir), resolve(fromEnv));
  });

  test('③ --data-dir 覆盖环境变量与配置', async () => {
    const root = tempDirSync('irmia-startup-flag-');
    const configDir = join(root, 'cfg');
    writeConfig(configDir, { dataDir: join(root, 'from-config') });

    const startup = await resolveStartupPaths({
      dataDir: join(root, 'from-flag'),
      env: { IRMIA_DATA_DIR: join(root, 'from-env') },
      cwd: join(root, 'cwd'),
    });

    assert.equal(resolve(startup.dataDir), resolve(join(root, 'from-flag')));
    assert.equal(startup.source, 'flag');
  });

  test('④ 配置里没写 dataDir ⇒ 来源 cwd、值 <cwd>/data（不是别的目录名）', async () => {
    const root = tempDirSync('irmia-startup-cwd-');
    const configDir = join(root, 'cfg');
    const cwd = join(root, 'cwd');
    writeConfig(configDir, {});
    mkdirSync(cwd, { recursive: true });

    const startup = await resolveStartupPaths({ configPath: configDir, env: {}, cwd });

    assert.equal(startup.configDataDir, null, '没写就是 null（"配置指定了"与"用了默认值"必须分得开）');
    assert.equal(startup.source, 'cwd');
    assert.equal(resolve(startup.dataDir), resolve(join(cwd, 'data')));
  });

  test('⑤ 配置里的**相对** dataDir 相对配置文件所在目录解析（不是 cwd）', async () => {
    const root = tempDirSync('irmia-startup-rel-');
    const configDir = join(root, 'cfg');
    const cwd = join(root, 'cwd');
    const configPath = writeConfig(configDir, { dataDir: 'mydata' });
    mkdirSync(cwd, { recursive: true });

    const startup = await resolveStartupPaths({ configPath, env: {}, cwd });

    assert.equal(startup.source, 'config');
    assert.equal(resolve(startup.dataDir), resolve(join(configDir, 'mydata')),
      '相对路径的基准是配置目录，不是 cwd');
    assert.notEqual(resolve(startup.dataDir), resolve(join(cwd, 'mydata')));
  });

  test('⑥ 回归（防脑裂）：<cwd>/data 存在，但配置指向别处 ⇒ **不许**读 cwd 的那份', async () => {
    const root = tempDirSync('irmia-startup-split-');
    const configDir = join(root, 'cfg');
    const cwd = join(root, 'cwd');
    const dataDir = join(root, 'real-data');
    // cwd 下有一份"看起来像数据目录"的 data（现场那次就是这样：它先被建出来、写进了新事件）
    mkdirSync(join(cwd, 'data', 'events'), { recursive: true });
    writeFileSync(join(cwd, 'data', '.keys.json'), JSON.stringify({ heavy: 'sk-from-cwd' }), 'utf8');
    writeConfig(configDir, { dataDir });

    const startup = await resolveStartupPaths({ configPath: configDir, env: {}, cwd });

    assert.equal(resolve(startup.dataDir), resolve(dataDir));
    assert.equal(startup.source, 'config');
    assert.notEqual(resolve(startup.dataDir), resolve(join(cwd, 'data')),
      '<cwd>/data 存在也不能被选中——它正是那次"事件写进另一套"的落点');
    // 连配置对象那一格也必须是配置说的那个：keys 与事件同源
    assert.equal(resolve(startup.loaded.config.dataDir), resolve(dataDir));
  });

  test('--config 可以直接指 config.json 本身（目录与文件两种写法等价）', async () => {
    const root = tempDirSync('irmia-startup-cfgpath-');
    const configDir = join(root, 'cfg');
    const configPath = writeConfig(configDir, { dataDir: join(root, 'data1') });

    const byFile = await resolveStartupPaths({ configPath, env: {}, cwd: root });
    const byDir = await resolveStartupPaths({ configPath: configDir, env: {}, cwd: root });

    assert.equal(byFile.configDir, byDir.configDir);
    assert.equal(resolve(byFile.dataDir), resolve(byDir.dataDir));
  });

  test('configHash 跟着生效配置走：钉了 dataDir 之后指纹与 configHash(config) 一致', async () => {
    const root = tempDirSync('irmia-startup-hash-');
    const configDir = join(root, 'cfg');
    writeConfig(configDir, { dataDir: join(root, 'a') });

    const startup = await resolveStartupPaths({
      dataDir: join(root, 'b'),
      env: {},
      cwd: root,
    });

    assert.equal(startup.loaded.configHash, configHash(startup.loaded.config));
  });
});

describe('pinDataDir · 生效数据目录钉进配置对象（"两边一致"的唯一一处实现）', () => {
  test('值不同 ⇒ 改它并重算 configHash；值相同 ⇒ 一个字都不动', async () => {
    const dir = tempDirSync('irmia-pin-');
    const loaded = await loadConfig(dir);
    const before = loaded.configHash;

    pinDataDir(loaded, loaded.config.dataDir);
    assert.equal(loaded.configHash, before, '同一个值不该改指纹');

    pinDataDir(loaded, join(dir, 'other'));
    assert.equal(loaded.config.dataDir, join(dir, 'other'));
    assert.equal(loaded.configHash, configHash(loaded.config), '指纹描述的是**生效配置**');
    assert.notEqual(loaded.configHash, before);
  });
});

describe('isDirectRun · process.argv[1] 与本模块的比对', () => {
  const entry = join('C:', 'somewhere', 'main.js');
  const moduleUrl = pathToFileURL(entry).href;

  test('argv[1] 就是本模块 ⇒ true（是入口，可以跑 main）', () => {
    assert.equal(isDirectRun(moduleUrl, entry), true);
  });

  test('argv[1] 是别的文件 ⇒ false（被 import / 被别的入口带进来）', () => {
    assert.equal(isDirectRun(moduleUrl, join('C:', 'somewhere', 'test.ts')), false);
  });

  test('拿不到 argv[1] ⇒ false（不猜、不抛）', () => {
    assert.equal(isDirectRun(moduleUrl, undefined), false);
  });

  test('路径相同但写法不同（相对路径 vs file URL）⇒ 不相等（判据是 file URL，不是字符串相似）', () => {
    assert.equal(isDirectRun(moduleUrl, 'somewhere/main.js'), false);
  });
});

describe('startupExitCode / startupFailureLine · 启动失败 → exit 1 + 一行 [致命]', () => {
  test('跑起来了（err = null）⇒ 0', () => {
    assert.equal(startupExitCode(null), 0);
  });

  test('启动失败 ⇒ 1（Error 与非 Error 都是 1；不存在 2/3 那种细分）', () => {
    assert.equal(startupExitCode(new Error('boom')), 1);
    assert.equal(startupExitCode('boom'), 1);
    assert.equal(startupExitCode({ code: 42 }), 1);
  });

  test('Error 的写法是 `名称: 消息`，且整行以 [致命] 启动失败：开头', () => {
    const line = startupFailureLine(new Error('boom'));
    assert.equal(line, '[致命] 启动失败：Error: boom');
    // 守护/重启脚本按前缀认这一行，前缀写歪等于没人看见失败
    assert.ok(line.startsWith('[致命] 启动失败：'));
  });

  test('非 Error 直接 String()（不吞、不包一层 "unknown"）', () => {
    assert.equal(startupFailureLine('boom'), '[致命] 启动失败：boom');
  });

  test('自定义 Error 子类保留类名（排查时靠它区分"锁被占"与"配置坏了"）', () => {
    class LockHeld extends Error {}
    assert.equal(startupFailureLine(new LockHeld('已有一个后端在跑')), '[致命] 启动失败：Error: 已有一个后端在跑');
  });
});

describe('renderStartupSummary · 启动摘要里的四件事（水位/待办/定时器/锁）', () => {
  const persona = {
    identity: '', constitution: '', style: '', state: '',
    personaHash: 'deadbeefdeadbeef', isSeed: false,
  } as PersonaAssets;

  function recoveryOf(overrides: Partial<{ lastSeq: number; watermark: number; pending: unknown[]; openTurn: unknown; shardCount: number; repairs: string[] }> = {}): RecoverResult {
    return {
      lock: { pid: 4242, startedAt: '2026-10-18T00:00:00.000Z' },
      log: { shardFiles: Array.from({ length: overrides.shardCount ?? 2 }, () => ({})) },
      projection: {
        lastSeq: overrides.lastSeq ?? 123,
        watermark: overrides.watermark ?? 100,
        pending: overrides.pending ?? [{}, {}],
        openTurn: overrides.openTurn ?? null,
      },
      repairs: overrides.repairs ?? [],
    } as unknown as RecoverResult;
  }

  /**
   * 摘要的头三行（2026-10-23 加）：`数据目录` / `配置` / `数据来源`。
   *
   * 为什么单独钉这三行：现场那次脑裂的全部症状就是这三件事对不上，而当时摘要里只有第一行
   * ——"配置说 A、实际写进 B"因此读不出来。三行必须同时出现、且逐字是那三个标签。
   */
  test('头三行必须同时出现：数据目录 / 配置 / 数据来源（一行都不许少）', () => {
    const configPath = join('D:', 'app', 'config.json');
    const text = renderStartupSummary({
      dataDir: join('D:', 'data'),
      configPath,
      dataDirSource: 'config',
      recovery: recoveryOf(),
      timers: new TimerStore(null),
      startTurn: 0,
      mode: 'real',
      persona,
    });
    assert.ok(text.includes(`数据目录: ${join('D:', 'data')}`), text);
    assert.ok(text.includes(`配置: ${configPath}`), text);
    assert.ok(text.includes('数据来源: config'), text);
    // 三行必须是连续的（中间不许被别的读数插进去：它们说的是同一件事）
    const lines = text.split('\n');
    const head = lines.indexOf(`数据目录: ${join('D:', 'data')}`);
    assert.equal(lines[head + 1], `配置: ${configPath}`);
    assert.equal(lines[head + 2], '数据来源: config');
  });

  test('三种来源逐字都在（config / env / cwd；参数那一档是 flag）', () => {
    type Source = Parameters<typeof renderStartupSummary>[0]['dataDirSource'];
    for (const source of ['config', 'env', 'cwd', 'flag'] as Source[]) {
      const text = renderStartupSummary({
        dataDir: join('D:', 'data'),
        configPath: join('D:', 'app', 'config.json'),
        dataDirSource: source,
        recovery: recoveryOf(),
        timers: new TimerStore(null),
        startTurn: 0,
        mode: 'real',
        persona,
      });
      assert.ok(text.includes(`数据来源: ${source}`), text);
    }
  });

  test('真循环：模式那句是"真循环（已配置模型）"，且四项读数逐项在', () => {
    const text = renderStartupSummary({
      dataDir: join('D:', 'data'),
      configPath: join('D:', 'app', 'config.json'),
      dataDirSource: 'config',
      recovery: recoveryOf(),
      timers: new TimerStore(null),
      startTurn: 7,
      mode: 'real',
      persona,
    });
    assert.ok(text.includes('真循环（已配置模型）'), text);
    assert.ok(text.includes(`数据目录: ${join('D:', 'data')}`), text);
    assert.ok(text.includes('最大 seq 123 / 分片 2 个'), text);
    assert.ok(text.includes('水位: 100 / 待办 2 条'), text);
    assert.ok(text.includes('定时器 0 个（在途句柄 0）'), text);
    assert.ok(text.includes('未闭合 turn: 无'), text);
    // startTurn 是"上一轮"，摘要里印的是下一轮
    assert.ok(text.includes('下一轮 turn 号: 8'), text);
    assert.ok(text.includes('锁: 持有 pid 4242'), text);
    assert.ok(text.includes('（hash deadbeefdeadbeef）'), text);
  });

  test('假循环：没有 API key 时摘要必须说"假循环（仅写事件不调模型）"', () => {
    const text = renderStartupSummary({
      dataDir: join('D:', 'data'),
      configPath: join('D:', 'app', 'config.json'),
      dataDirSource: 'cwd',
      recovery: recoveryOf(),
      timers: new TimerStore(null),
      startTurn: 0,
      mode: 'fake',
      persona,
    });
    assert.ok(text.includes('假循环（未配置 API key，仅写事件不调模型）'), text);
  });

  test('种子人格：摘要必须说出来（不填人格 = 出来的是默认配置）', () => {
    const text = renderStartupSummary({
      dataDir: join('D:', 'data'),
      configPath: join('D:', 'app', 'config.json'),
      dataDirSource: 'config',
      recovery: recoveryOf(),
      timers: new TimerStore(null),
      startTurn: 0,
      mode: 'fake',
      persona: { ...persona, isSeed: true } as PersonaAssets,
    });
    assert.ok(text.includes('种子模板未填写'), text);
    assert.ok(text.includes('IDENTITY.md'), text);
  });

  test('未闭合 turn 与恢复补偿：有就逐条列，没有就不出现"补偿 0 项"', () => {
    const withFacts = renderStartupSummary({
      dataDir: join('D:', 'data'),
      configPath: join('D:', 'app', 'config.json'),
      dataDirSource: 'config',
      recovery: recoveryOf({ openTurn: { turn: 9 }, repairs: ['把悬空工具调用标成 unknown'] }),
      timers: new TimerStore(null),
      startTurn: 9,
      mode: 'real',
      persona,
    });
    assert.ok(withFacts.includes('未闭合 turn: #9（本次恢复已结算）'), withFacts);
    assert.ok(withFacts.includes('恢复补偿 1 项'), withFacts);
    assert.ok(withFacts.includes('  - 把悬空工具调用标成 unknown'), withFacts);

    const clean = renderStartupSummary({
      dataDir: join('D:', 'data'),
      configPath: join('D:', 'app', 'config.json'),
      dataDirSource: 'config',
      recovery: recoveryOf({ repairs: [] }),
      timers: new TimerStore(null),
      startTurn: 9,
      mode: 'real',
      persona,
    });
    assert.equal(clean.includes('恢复补偿'), false, clean);
  });
});

/**
 * **「现在跑的是什么」的启动读数**（2026-10-21，per-lane 端点与密钥）。
 *
 * 这一行是"界面之外的那份读数"：`models.<lane>.model @ .baseUrl` + 每一格密钥的来源。
 * 它要回答的现场是——
 *
 *   > 设置页显示 light 指着 X 端点，可请求仍旧打 heavy 的端点；而且进程里一个旧的
 *   > `IRMIA_API_KEY` 压过了界面刚写进 `.keys.json` 的那把，所以"填了新 key 还是 401"。
 *
 * 于是三条判据：两条 lane 的值都在、来源逐格说清、`lightLaneKey` 的三档（本格 / 沿用 heavy /
 * 没有）各有一句人话。环境变量优先这一条必须单独钉住：它是那个"新 key 不生效"的唯一解释。
 */
describe('describeLaneReadout · 两条 lane 的启动读数（端点 + 密钥来源）', () => {
  /** 临时数据目录 + 出厂配置（`config.dataDir` = `<dir>/data`）；目录由 helper 统一清理 */
  function fixture(): { dir: string; dataDir: string } {
    const dir = tempDirSync('irmia-readout-');
    const cfg = defaultConfig(dir);
    return { dir, dataDir: cfg.dataDir };
  }

  /** 写一份 `.keys.json`（受管键按格存） */
  function writeKeys(dataDir: string, keys: Record<string, string>): void {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, '.keys.json'), JSON.stringify(keys), 'utf8');
  }

  /**
   * 在"这几个环境变量被临时设成给定值（`null` = 删掉）"的窗口里跑一段代码，跑完**还原**。
   * 不隔离的话，"读数说 key 来自文件"这条断言会随跑测试那台机器的环境变量漂移。
   */
  function withEnv<T>(vars: Record<string, string | null>, run: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const [name, value] of Object.entries(vars)) {
      saved.set(name, process.env[name]);
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      return run();
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  test('两条 lane 的 model/baseUrl 都在读数里；密钥来源逐格说清（这里来自文件）', () => {
    const { dir, dataDir } = fixture();
    const cfg = defaultConfig(dir);
    writeKeys(dataDir, { heavy: 'sk-heavy-file', light: 'sk-light-file' });

    const line = withEnv({ [cfg.models.heavy.apiKeyEnv]: null }, () => describeLaneReadout(cfg, undefined));

    assert.ok(line.includes(`heavy=${cfg.models.heavy.model} @ ${cfg.models.heavy.baseUrl}`), line);
    assert.ok(line.includes(`light=${cfg.models.light.model} @ ${cfg.models.light.baseUrl}`), line);
    assert.ok(line.includes('data/.keys.json 的 heavy 格'), line);
    assert.ok(line.includes('沿用 heavy 的'), line, 'lightLaneKey === undefined ⇒ 与 heavy 同端点、沿用同一把');
    assert.ok(line.includes('要重启进程才接管'), line, '`models.*` 是 restart 级：读数必须把这层说出来');
  });

  test('light 没 key 且端点不同 ⇒ 读数直说"没有可用的 key"（不借 heavy 的）', () => {
    const { dir } = fixture();
    const cfg = defaultConfig(dir);

    const line = withEnv({ [cfg.models.heavy.apiKeyEnv]: null }, () => describeLaneReadout(cfg, null));

    assert.ok(line.includes('没有可用的 key'), line);
    assert.ok(line.includes('不会借用 heavy 的密钥'), line);
    assert.ok(line.includes(cfg.models.light.apiKeyEnv), line, '要指出该设哪个环境变量');
  });

  test('环境变量优先：key 来自 env 时读数点名那个变量（它会压过设置页刚写进文件的那把）', () => {
    const { dir, dataDir } = fixture();
    const cfg = defaultConfig(dir);
    // 盘上有一把"设置页刚写的"，环境里有一把"进程启动时就在的"——后者赢
    writeKeys(dataDir, { heavy: 'sk-from-file', light: 'sk-from-file' });
    const line = withEnv({ [cfg.models.heavy.apiKeyEnv]: 'sk-from-env' },
      () => describeLaneReadout(cfg, 'sk-from-env'));

    assert.ok(line.includes(`环境变量 ${cfg.models.heavy.apiKeyEnv}`), line);
    assert.ok(line.includes('压过密钥文件'), line, '这正是"填了新 key 却还是 401"的唯一解释');
  });
});

