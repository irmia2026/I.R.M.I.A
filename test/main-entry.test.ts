/**
 * 启动入口的纯函数段 —— `src/main.ts`（REVIEW P1-29：唯一的生产装配入口零覆盖）
 *
 * 这一份**不起任何真进程**，也不碰仓库里的任何文件：它只盯 `main.ts` 里那几条"判据型"
 * 纯函数——它们在 2026-10-18 之前是 `runMain` / `main` 的行内表达式，谁也测不到。
 *
 * 要守住的三件事（每一条都对应一个启动期的真实失败形状）：
 *   ① `resolveDataDir`：数据目录的取值链是 **参数 > `IRMIA_DATA_DIR` > `<cwd>/data`**。
 *      弄错的后果不是报错，而是**静默起在另一个 data 目录上**（两份并行事实）。
 *   ② `isDirectRun`：`process.argv[1]` 与本模块的比对决定"这是入口还是被 import"。
 *      判错的后果很凶：被 import 时也跑 `main()`，测试进程会去抢单实例锁。
 *   ③ `startupExitCode` / `startupFailureLine`：启动失败必须是 **exit 1 + 一行**
 *      `[致命] 启动失败：…`（守护脚本与重启脚本读的就是这两样）。
 *
 * ⚠️ 范围说清：`runMain` 本体（建目录 / 开日志 / 抢锁 / 起模型 / 装配各通道）**没有被覆盖**，
 * 那需要真起进程与真数据目录，不在本笔内。这份用例只保证"抽出来的判据是对的"。
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';

import {
  DEFAULT_DATA_DIR_NAME,
  describeLaneReadout,
  isDirectRun,
  renderStartupSummary,
  resolveDataDir,
  startupExitCode,
  startupFailureLine,
} from '../src/main.ts';
import { defaultConfig } from '../src/config/config.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import type { RecoverResult } from '../src/runtime/recover.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

describe('resolveDataDir · 数据目录的取值链：参数 > 环境变量 > <cwd>/data', () => {
  test('显式参数优先于环境变量（两条都给时用参数）', () => {
    const dataDir = resolveDataDir({
      dataDir: join('D:', 'explicit'),
      env: { IRMIA_DATA_DIR: join('E:', 'from-env') },
      cwd: join('F:', 'cwd'),
    });
    assert.equal(dataDir, join('D:', 'explicit'));
  });

  test('没有参数时用 IRMIA_DATA_DIR（变量名就是这个，不是别的名字）', () => {
    const dataDir = resolveDataDir({
      dataDir: undefined,
      env: { IRMIA_DATA_DIR: join('E:', 'from-env') },
      cwd: join('F:', 'cwd'),
    });
    assert.equal(dataDir, join('E:', 'from-env'));
  });

  test('两处都没有时落到 <cwd>/data（出厂目录名 data）', () => {
    const cwd = join('F:', 'cwd');
    assert.equal(DEFAULT_DATA_DIR_NAME, 'data');
    assert.equal(resolveDataDir({ env: {}, cwd }), join(cwd, 'data'));
  });

  test('环境变量存在但值是空串时**不会**回落到 cwd（现状语义：空串也是"给了值"）', () => {
    // 这条不是在夸它，而是在钉住现状：`??` 只看 null/undefined，空串会被原样交给
    // runMain（那里的 mkdirSync 会当场报错，不是静默换目录）。哪天要改成"空串当没给"，
    // 这条用例应当被**显式改掉**，而不是悄悄变绿。
    assert.equal(resolveDataDir({ env: { IRMIA_DATA_DIR: '' }, cwd: join('F:', 'cwd') }), '');
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

  test('真循环：模式那句是"真循环（已配置模型）"，且四项读数逐项在', () => {
    const text = renderStartupSummary({
      dataDir: join('D:', 'data'),
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
