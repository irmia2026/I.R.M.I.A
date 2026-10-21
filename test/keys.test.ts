/**
 * 本地密钥存储测试 — src/config/keys.ts（对齐设置页 · 模型分区那条交付路径）
 *
 * 五件事按验收口径钉住：
 *   ① 写入后可读（值按受管键名读回来，别人的键与键序都不动）；
 *   ② 环境变量优先于文件（且空值按缺失处理、envName 可被配置覆盖）；
 *   ③ 清除生效（空串删掉该键，其余键保留，清空后文件仍是个合法 `{}`）；
 *   ④ 掩码不泄漏全值（前 3 后 4，短值整体打码）；
 *   ⑤ 目录自动创建（dataDir 不存在时第一次写就建出来）。
 * 另加两条防线：文件损坏时读路径宽容失败（不抛到请求路径上）、readApiKey 真的接上了文件回退。
 * 全部在临时目录里跑，不碰仓库里的任何文件。
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { readApiKey } from '../src/config/config.ts';
import { modelKeyGroups, modelKeyRoutes, defaultConfig } from '../src/config/config.ts';
import {
  KEY_ENV,
  KEY_NAMES,
  backfillSharedKeys,
  isKeyName,
  keyShapeProblem,
  keyStatus,
  keysPath,
  loadKeysFile,
  maskKey,
  planModelKeyWrite,
  readKeyFile,
  resolveKey,
  writeKeyFile,
  writeKeysFile,
  type ModelKeyRoute,
} from '../src/config/keys.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function freshDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await tempDir('irmia-keys-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir);
}

/** 直接读盘上的原文档（断言键序与"文件里到底写了什么"用） */
async function rawDocument(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(keysPath(dir), 'utf8')) as Record<string, unknown>;
}

// ──────────────────────────────── ① 受管键名与环境变量名 ────────────────────────────────

test('受管键名与默认环境变量名：与 config.json 的 *_Env 字段一一对应', () => {
  assert.deepEqual([...KEY_NAMES], ['heavy', 'light', 'qqAppId', 'qqClientSecret', 'onebotToken']);
  assert.deepEqual(KEY_ENV, {
    heavy: 'IRMIA_API_KEY',
    light: 'IRMIA_LIGHT_API_KEY',
    qqAppId: 'QQ_BOT_APP_ID',
    qqClientSecret: 'QQ_BOT_CLIENT_SECRET',
    onebotToken: 'ONEBOT_ACCESS_TOKEN',
  });
  // 白名单收窄：来自 HTTP 请求体的任何值都要先过它
  assert.equal(isKeyName('heavy'), true);
  assert.equal(isKeyName('__proto__'), false, '原型链上的名字不是受管键');
  assert.equal(isKeyName(''), false);
  assert.equal(isKeyName(null), false);
});

// ──────────────────────────────── ② 写入后可读 ────────────────────────────────

test('写入后可读：值按受管键名读回来，别人的键不动、键序固定', async (t) => {
  const dir = await freshDir(t);

  assert.equal(readKeyFile(dir, 'heavy'), null, '前置：文件还不存在');

  await writeKeyFile(dir, 'onebotToken', 'token-abcdef');
  await writeKeyFile(dir, 'heavy', 'sk-abcdef1234');

  assert.equal(readKeyFile(dir, 'heavy'), 'sk-abcdef1234');
  assert.equal(readKeyFile(dir, 'onebotToken'), 'token-abcdef');
  assert.equal(readKeyFile(dir, 'light'), null);

  // 键序 = KEY_NAMES 的顺序（diff 干净、人可读），因此 heavy 排在 onebotToken 之前
  const doc = await rawDocument(dir);
  assert.deepEqual(Object.keys(doc), ['heavy', 'onebotToken']);
  assert.deepEqual(loadKeysFile(dir), { heavy: 'sk-abcdef1234', onebotToken: 'token-abcdef' });

  // 覆盖同一个键：只动它，别人的值原样
  await writeKeyFile(dir, 'heavy', 'sk-2222222222');
  assert.deepEqual(loadKeysFile(dir), { heavy: 'sk-2222222222', onebotToken: 'token-abcdef' });

  // 列表里没登记的键名进不来（文档里出现也不认）
  await writeFile(keysPath(dir), JSON.stringify({ heavy: 'sk-1', stray: 'nope' }), 'utf8');
  assert.deepEqual(Object.keys(loadKeysFile(dir)), ['heavy']);
});

// ──────────────────────────────── ③ 目录自动创建 ────────────────────────────────

test('目录自动创建：dataDir 不存在时，第一次写就把目录与文件建出来', async (t) => {
  const root = await freshDir(t);
  const dataDir = join(root, 'nested', 'data');

  assert.equal(existsSync(dataDir), false, '前置：目录确实不存在');

  await writeKeyFile(dataDir, 'heavy', 'sk-abcdef1234');

  assert.equal(existsSync(dataDir), true, '写路径必须自己建目录（首次配置时 data/ 可能还没有）');
  assert.equal(readKeyFile(dataDir, 'heavy'), 'sk-abcdef1234');
  assert.equal(existsSync(keysPath(dataDir)), true);
});

// ──────────────────────────────── ④ 环境变量优先于文件 ────────────────────────────────

test('环境变量优先于文件：两边都有值时以环境变量为准，空值按缺失处理', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-from-file-1111');
  await writeKeyFile(dir, 'light', 'sk-light-file-2222');

  assert.equal(resolveKey(dir, 'heavy', { env: { IRMIA_API_KEY: 'sk-from-env-9999' } }), 'sk-from-env-9999');
  assert.equal(resolveKey(dir, 'heavy', { env: {} }), 'sk-from-file-1111', '环境里没有值 → 回落到文件');
  assert.equal(
    resolveKey(dir, 'heavy', { env: { IRMIA_API_KEY: '   ' } }),
    'sk-from-file-1111',
    '只有空白的值按缺失处理（与 readApiKey 的历史语义一致）',
  );

  // 配置里把环境变量名改过：以调用方给的名字为准，文件回退仍按受管键名走
  assert.equal(resolveKey(dir, 'light', { env: { MY_LIGHT_KEY: 'sk-custom-3333' }, envName: 'MY_LIGHT_KEY' }), 'sk-custom-3333');
  assert.equal(resolveKey(dir, 'light', { env: { IRMIA_LIGHT_API_KEY: '   ' } }), 'sk-light-file-2222', 'light 有独立的环境变量名');

  // dataDir 传 null = 只看环境变量；name 传 null = 不认文件里的键
  assert.equal(resolveKey(null, 'heavy', { env: { IRMIA_API_KEY: 'sk-env-only' } }), 'sk-env-only');
  assert.equal(resolveKey(null, 'heavy', { env: {} }), null);
  assert.equal(resolveKey(dir, null, { env: {}, envName: 'IRMIA_API_KEY' }), null);

  // 环境变量在进程环境里也认（缺省 env = process.env）
  const envName = `IRMIA_TEST_KEYS_${process.pid}`;
  process.env[envName] = 'sk-from-process-env';
  t.after(() => {
    delete process.env[envName];
  });
  assert.equal(resolveKey(dir, 'qqAppId', { envName }), 'sk-from-process-env');
});

test('readApiKey 接上本地密钥文件：环境变量缺失时回落到 .keys.json', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-file-only-1234');

  // 这个变量名保证进程环境里没有它
  const lane = { apiKeyEnv: `IRMIA_TEST_ABSENT_${process.pid}` };
  assert.equal(readApiKey(lane, {}, dir, 'heavy'), 'sk-file-only-1234');
  assert.equal(
    readApiKey(lane, { [lane.apiKeyEnv]: 'sk-from-env' }, dir, 'heavy'),
    'sk-from-env',
    '环境变量仍然压过文件',
  );
  assert.equal(readApiKey(lane, {}, null, 'heavy'), null, '不传 dataDir 时只看环境变量（历史语义不变）');
  assert.equal(readApiKey(lane, {}), null, '不传 dataDir / name 时既不看文件也没环境值');
});

// ──────────────────────────────── ⑤ 清除生效 ────────────────────────────────

test('清除生效：空串删掉该键、其余键保留；清空后文件仍是个合法 {}', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-heavy-1111');
  await writeKeyFile(dir, 'light', 'sk-light-2222');
  await writeKeyFile(dir, 'qqAppId', '123456');

  await writeKeyFile(dir, 'heavy', '');

  assert.equal(readKeyFile(dir, 'heavy'), null, '清掉的键读不到');
  assert.equal(resolveKey(dir, 'heavy', { env: {} }), null, '清除后不回落任何东西');
  assert.deepEqual(await rawDocument(dir), { light: 'sk-light-2222', qqAppId: '123456' });
  assert.deepEqual(Object.keys(await rawDocument(dir)), ['light', 'qqAppId'], '剩下的键仍按 KEY_NAMES 排序');

  // 纯空白也算清除（界面上手滑打个空格不该变成密钥）
  await writeKeyFile(dir, 'light', '   ');
  assert.equal(readKeyFile(dir, 'light'), null);

  await writeKeyFile(dir, 'qqAppId', '');
  assert.deepEqual(loadKeysFile(dir), {});
  assert.equal((await stat(keysPath(dir))).isFile(), true, '一个键都不剩时保留一个 {} 文件（配过密钥的痕迹）');
  assert.deepEqual(await rawDocument(dir), {});
});

// ──────────────────────────────── ⑥ 掩码 ────────────────────────────────

test('掩码不泄漏全值：前 3 后 4，短于 8 位整体打码', () => {
  const secret = 'sk-abcdef1234';
  const masked = maskKey(secret);
  assert.equal(masked, 'sk-…1234');
  assert.notEqual(masked, secret);
  assert.equal(masked.includes(secret), false, '掩码里不得出现全值');
  assert.ok(masked.length < secret.length, '掩码必须比原值短');

  // 8 位起才露前 3 后 4；再短的串上"前 3 后 4"等于把原文还回去
  assert.equal(maskKey('12345678'), '123…5678');
  for (const short of ['', 'sk', 'sk-1', 'sk-1234', 'abc1234']) {
    assert.equal(maskKey(short), '…', `${JSON.stringify(short)} 太短，应当整体打码`);
    assert.equal(maskKey(short).includes(short) && short !== '', false);
  }

  // 带空白的值按 trim 后的形态打码（与取值链同一口径）
  assert.equal(maskKey('  sk-abcdef1234  '), 'sk-…1234');

  // 状态视图只给掩码：configured / mask / source / envName，**没有任何字段是值**
  assert.deepEqual(keyStatus('heavy', { env: {}, dataDir: null }), {
    configured: false,
    mask: null,
    source: null,
    envName: KEY_ENV.heavy,
  });
  const status = keyStatus('heavy', { env: { IRMIA_API_KEY: secret }, dataDir: null });
  assert.equal(status.configured, true);
  assert.equal(status.source, 'env');
  assert.equal(status.mask, 'sk-…1234');
  assert.equal(JSON.stringify(status).includes(secret), false, '状态视图序列化后不得含全值');
});

// ──────────────────────────────── ⑦ 损坏文件 ────────────────────────────────

test('密钥文件损坏时按未配置处理，且写入会把它覆盖回合法文档', async (t) => {
  const dir = await freshDir(t);

  await writeFile(keysPath(dir), '{ 这不是 JSON', 'utf8');
  assert.deepEqual(loadKeysFile(dir), {}, '损坏文件不得让调用方炸掉');
  assert.equal(readKeyFile(dir, 'heavy'), null);
  assert.equal(resolveKey(dir, 'heavy', { env: {} }), null);

  await writeFile(keysPath(dir), '[1, 2, 3]', 'utf8');
  assert.deepEqual(loadKeysFile(dir), {}, '顶层不是对象同样当未配置');

  await writeKeyFile(dir, 'heavy', 'sk-abcdef1234');
  assert.deepEqual(await rawDocument(dir), { heavy: 'sk-abcdef1234' }, '写路径整体覆盖，坏的残留不会传染');
});

// ────────────────────── ⑧ 模型路由的密钥格（2026-10-20 用户的实测挫败点） ──────────────────────
//
// 现场（原话）：「新用户通过引导页填写了 key，但是实际上 key 只给了 heavy loop，而没给 light
// loop……默认填了这里就会同时给两个吧」。根因是**存储按格、配置按环境变量名**：
// `.keys.json` 的格是 heavy / light（KEY_NAMES），而两条路由的 `apiKeyEnv` 出厂是同一个名字，
// 只写 heavy 那一格的时候，设置页按格读到的 light 永远是「未配置」。
//
// 这一节钉三件事：① 该写哪几格（纯函数）；② 一次原子写多格（不写半截）；③ 老用户补齐且幂等。

/** 出厂形态的路由表：heavy / light 共用同一个 apiKeyEnv（这就是"填一次、两格都要有"的现场） */
const sharedEnvRoutes = (): ModelKeyRoute[] => [
  { route: 'heavy', slot: 'heavy', envName: 'IRMIA_API_KEY' },
  { route: 'light', slot: 'light', envName: 'IRMIA_API_KEY' },
];

test('modelKeyRoutes：heavy / light 恒在，degraded 只有配置写了才有、且没有自己的密钥格', () => {
  const base = defaultConfig(resolve(tmpdir()));
  assert.deepEqual(modelKeyRoutes(base), [
    { route: 'heavy', slot: 'heavy', envName: base.models.heavy.apiKeyEnv },
    { route: 'light', slot: 'light', envName: base.models.light.apiKeyEnv },
  ]);
  assert.equal(
    base.models.heavy.apiKeyEnv,
    base.models.light.apiKeyEnv,
    '出厂配置里两条路由指向同一个环境变量名——"一把 key 管两档"是正常形态，不是巧合',
  );

  const withDegraded = {
    ...base,
    models: { ...base.models, degraded: { model: 'x', baseUrl: 'https://x', apiKeyEnv: 'IRMIA_DEGRADED_KEY' } },
  };
  const routes = modelKeyRoutes(withDegraded);
  assert.deepEqual(routes.map((route) => route.route), ['heavy', 'light', 'degraded']);
  assert.equal(routes[2]?.slot, null, 'degraded 在 KEY_NAMES 里没有格：写不进去也不许假装写了');
});

test('planModelKeyWrite：引导页那条路（allRoutes）把一把 key 写给每一条有格的路由', () => {
  // 出厂形态：两个名字相同 ⇒ 写一份，落到两格
  assert.deepEqual(planModelKeyWrite('heavy', sharedEnvRoutes(), { allRoutes: true }), {
    slots: ['heavy', 'light'],
    noSlot: [],
  });

  // 名字不同也照样每格都写：人只填了一把 key，她要的是"能用"，不是"三档各配一次"
  const splitEnv: ModelKeyRoute[] = [
    { route: 'heavy', slot: 'heavy', envName: 'IRMIA_API_KEY' },
    { route: 'light', slot: 'light', envName: 'IRMIA_LIGHT_API_KEY' },
  ];
  assert.deepEqual(planModelKeyWrite('heavy', splitEnv, { allRoutes: true }).slots, ['heavy', 'light']);
  // 而按格保存（设置页）时，名字不同的格**不动**：那是另一把 key，页面上有它自己的输入框
  assert.deepEqual(planModelKeyWrite('heavy', splitEnv, { allRoutes: false }).slots, ['heavy']);
  assert.deepEqual(
    planModelKeyWrite('heavy', sharedEnvRoutes(), { allRoutes: false }).slots,
    ['heavy', 'light'],
    '名字相同 ⇒ 顺手补上同名的另一格（同名环境变量不可能有两个值）',
  );

  // 没有格的路由进 noSlot：回执要如实说"这一条得你自己给环境变量"
  const withDegraded: ModelKeyRoute[] = [
    ...sharedEnvRoutes(),
    { route: 'degraded', slot: null, envName: 'IRMIA_DEGRADED_KEY' },
  ];
  const plan = planModelKeyWrite('heavy', withDegraded, { allRoutes: true });
  assert.deepEqual(plan.slots, ['heavy', 'light']);
  assert.deepEqual(plan.noSlot, [{ route: 'degraded', slot: null, envName: 'IRMIA_DEGRADED_KEY' }]);
  // 同名时它已经被 heavy 那一格覆盖，不该再报"没写进去"
  assert.deepEqual(
    planModelKeyWrite('heavy', [...sharedEnvRoutes(), { route: 'degraded', slot: null, envName: 'IRMIA_API_KEY' }],
      { allRoutes: true }).noSlot,
    [],
  );

  // 通道凭据不在这套扇出里：只有模型格才谈"写到哪几格"
  assert.deepEqual(planModelKeyWrite('qqAppId', sharedEnvRoutes(), { allRoutes: true }).slots, ['qqAppId']);
});

test('modelKeyGroups：同名环境变量的几格成一组（启动补齐全看这一组）', () => {
  const base = defaultConfig(resolve(tmpdir()));
  // 出厂形态：heavy / light 都指 IRMIA_API_KEY ⇒ 一组两格，启动时补齐就是"补另一格"
  assert.deepEqual(modelKeyGroups(base), [
    { envName: base.models.heavy.apiKeyEnv, slots: ['heavy', 'light'] },
  ]);

  // 名字分开 ⇒ 两组、各一格：谁都不许替对方写（那是两把 key）
  const split = { ...base, models: { ...base.models, light: { ...base.models.light, apiKeyEnv: 'IRMIA_LIGHT_KEY' } } };
  assert.deepEqual(modelKeyGroups(split), [
    { envName: 'IRMIA_API_KEY', slots: ['heavy'] },
    { envName: 'IRMIA_LIGHT_KEY', slots: ['light'] },
  ]);

  // degraded 有自己名字但没有格 ⇒ 不进任何一组（补不了的东西不该出现在"该补齐"的名单里）
  const withDegraded = {
    ...base,
    models: {
      ...base.models,
      degraded: { model: 'x', baseUrl: 'https://x', apiKeyEnv: 'IRMIA_DEGRADED_KEY' },
    },
  };
  assert.deepEqual(modelKeyGroups(withDegraded), [{ envName: 'IRMIA_API_KEY', slots: ['heavy', 'light'] }]);
});

test('writeKeysFile：一次原子写多格，键序固定，重复保存不落盘也不报错', async (t) => {
  const dir = await freshDir(t);

  const changed = await writeKeysFile(dir, { light: 'sk-shared-1111', heavy: 'sk-shared-1111' });
  assert.deepEqual(changed, ['heavy', 'light'], '返回值按 KEY_NAMES 排序（回执念格名的顺序）');
  assert.deepEqual(await rawDocument(dir), { heavy: 'sk-shared-1111', light: 'sk-shared-1111' });
  assert.deepEqual(Object.keys(await rawDocument(dir)), ['heavy', 'light'], '键序 = KEY_NAMES');

  // 幂等：同样的值再写一次 ⇒ 一格都没变（不落盘，mtime 不抖）
  const before = (await stat(keysPath(dir))).mtimeMs;
  assert.deepEqual(await writeKeysFile(dir, { heavy: 'sk-shared-1111', light: 'sk-shared-1111' }), []);
  assert.equal((await stat(keysPath(dir))).mtimeMs, before, '没变就不写盘');

  // 别人的格一个字节都不动；空串 = 只清那一格
  await writeKeyFile(dir, 'qqAppId', '10240001');
  assert.deepEqual(await writeKeysFile(dir, { light: '' }), ['light']);
  assert.deepEqual(await rawDocument(dir), { heavy: 'sk-shared-1111', qqAppId: '10240001' });
});

test('backfillSharedKeys：老用户只配过 heavy ⇒ 补齐 light；再跑一次什么都不做', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-only-heavy');

  const groups = [{ envName: 'IRMIA_API_KEY', slots: ['heavy', 'light'] as const }];
  const first = await backfillSharedKeys(dir, groups);
  assert.deepEqual(first, [
    { envName: 'IRMIA_API_KEY', slots: ['heavy', 'light'], source: 'heavy', filled: ['light'], conflict: false },
  ]);
  assert.deepEqual(await rawDocument(dir), { heavy: 'sk-only-heavy', light: 'sk-only-heavy' }, '两格同值');
  // 补齐之后 light 走取值链真的能用（环境里没有那个变量）
  assert.equal(readApiKey({ apiKeyEnv: 'IRMIA_API_KEY' }, {}, dir, 'light'), 'sk-only-heavy');

  // 幂等：第二次一格都不补、不写盘
  const before = (await stat(keysPath(dir))).mtimeMs;
  assert.deepEqual(await backfillSharedKeys(dir, groups), []);
  assert.equal((await stat(keysPath(dir))).mtimeMs, before);
});

test('backfillSharedKeys：同名的几格值不同 ⇒ 不猜、一格都不写，只报冲突', async (t) => {
  const dir = await freshDir(t);
  await writeKeyFile(dir, 'heavy', 'sk-heavy-1111');
  await writeKeyFile(dir, 'light', 'sk-light-2222');

  const out = await backfillSharedKeys(dir, [{ envName: 'IRMIA_API_KEY', slots: ['heavy', 'light'] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.conflict, true);
  assert.deepEqual(out[0]?.filled, []);
  assert.deepEqual(await rawDocument(dir), { heavy: 'sk-heavy-1111', light: 'sk-light-2222' }, '一个字节都没动');
});

test('backfillSharedKeys：都没配过 ⇒ 什么都不做（不凭空造一份空文件）', async (t) => {
  const dir = await freshDir(t);
  assert.deepEqual(await backfillSharedKeys(dir, [{ envName: 'IRMIA_API_KEY', slots: ['heavy', 'light'] }]), []);
  assert.equal(existsSync(keysPath(dir)), false, '没人配过密钥就不该落一份文件');
});

test('keyShapeProblem：粘贴带进来的空白在写盘前就拒掉（"key 无效"的现场形态）', () => {
  assert.equal(keyShapeProblem('sk-abcdef1234'), null);
  assert.equal(keyShapeProblem('  sk-abcdef1234  '), null, '首尾空白是手滑，trim 之后就正常了');
  assert.equal(keyShapeProblem(''), null, '空串 = 清除，不是非法值');
  assert.equal(keyShapeProblem('   '), null);

  const withNewline = keyShapeProblem('sk-abc\ndef');
  assert.ok(withNewline !== null && withNewline.includes('换行'), `应当说清是换行：${withNewline}`);
  assert.ok(withNewline !== null && withNewline.includes('第 7 个字符'), '位置要念出来，人才知道从哪剪');
  const withSpace = keyShapeProblem('sk-abc def');
  assert.ok(withSpace !== null && withSpace.includes('空格'));
});
