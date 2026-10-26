/**
 * **实例登记表**（`src/runtime/instance-registry.ts`）+ 两条新端点（`GET /api/instance` /
 * `POST /api/commands/stop-instance`）—— 「登出 = 结束当前实例」那条产品行为的判据层。
 *
 * 这一份钉的是用户确认过的那三条语义：
 *   ① 登记表是**盘上的唯一真相源**，后端写、界面读：upsert 不覆盖 name、不清别人的条目；
 *      退出时**pid 清 0 而不是删条目**；文件坏了**不许**当空表覆盖（先留 `.bad` 证据）；
 *   ② 「停掉自己」是**受控**的：缺 `X-Confirm` 400、缺有效凭据 401、两样都带 200 且真的
 *      走**既有优雅退出路径**（注入的 `onStopInstanceExit` 被调用，不是 `process.exit`）；
 *   ③ `GET /api/instance` **免凭据**，且响应里只有那七个字段（dataDir 是**刻意**给的，
 *      其余一个字节都不多）。
 *
 * 为什么单独立案：这条链的另一半在 Dart（`gui/lib/instances.dart` / `instance_picker.dart`，
 * 那里有用例钉着选择页与登出三步），而**写**的那一半在这里。两边必须认同一份形状。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection } from '../src/log/types.ts';
import {
  INSTANCES_FILE_NAME, cleanNameValue, defaultDataDirOf, fallbackInstanceName, herNameFromIdentity,
  instancesFilePath, isDefaultDataDir, looksLikeName, markInstanceReady, markInstanceStopped,
  nameSourceOf, readInstancesFile, removeInstanceRecord, upsertRunningInstance, type InstanceRecord,
} from '../src/runtime/instance-registry.ts';
import { SERVER_PORT_FILE_PREFIX, serverPortFilePathForPort } from '../src/runtime/server-port-file.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { AuthStore } from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const NOW = (): Date => new Date('2026-10-26T10:00:00.000Z');

/** 一份"另一台实例"的条目（用来看"别人的条目有没有被弄丢"） */
function 别人那条(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: '127.0.0.1:7799#aaaabbbbccccdddd',
    name: '别人的实例',
    dataDir: 'D:\\instances\\other',
    host: '127.0.0.1',
    port: 7799,
    pid: 4321,
    nodeExe: 'D:\\tools\\node\\node.exe',
    entry: 'D:\\app\\dist\\main.js',
    createdAt: '2026-10-20T00:00:00.000Z',
    lastStartedAt: '2026-10-20T00:00:00.000Z',
    lastReadyAt: '2026-10-20T00:00:01.000Z',
    isDefault: false,
    ...overrides,
  };
}

function seed(path: string, records: InstanceRecord[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ v: 1, instances: records }, null, 2)}\n`, 'utf8');
}

function read(path: string): { v: number; instances: InstanceRecord[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { v: number; instances: InstanceRecord[] };
}

// ─────────────────────────── ① 路径与读（形状层） ───────────────────────────

test('① 路径口径：`%APPDATA%\\Irmia\\instances.json`；拿不到 APPDATA / 非 Windows ⇒ null', () => {
  const path = instancesFilePath({ APPDATA: 'C:\\fake-appdata' }, 'win32');
  assert.equal(path, join('C:\\fake-appdata', 'Irmia', INSTANCES_FILE_NAME));
  assert.equal(INSTANCES_FILE_NAME, 'instances.json');
  assert.equal(instancesFilePath({}, 'win32'), null);
  assert.equal(instancesFilePath({ APPDATA: '  ' }, 'win32'), null);
  assert.equal(instancesFilePath({ APPDATA: 'C:\\x' }, 'linux'), null);
});

test('①b 读：缺文件 / 半截 JSON / 顶层不是对象 三档分明（坏文件不许当空表）', () => {
  const dir = tempDirSync('irmia-instances-read-');
  const path = join(dir, INSTANCES_FILE_NAME);

  const missing = readInstancesFile(path);
  assert.equal(missing.missing, true);
  assert.equal(missing.recovered, false);
  assert.deepEqual(missing.file.instances, []);

  for (const body of ['{"v":1,"instances":[', '[]', 'null', '"x"']) {
    writeFileSync(path, body, 'utf8');
    const got = readInstancesFile(path);
    assert.equal(got.recovered, true, `坏文件必须报 recovered：${body}`);
    assert.equal(got.missing, false);
    assert.deepEqual(got.file.instances, []);
  }

  // 一行坏记录只丢那一行，不影响别的（id/dataDir 是硬判据）
  writeFileSync(path, JSON.stringify({
    v: 1,
    instances: [{ id: '', dataDir: 'D:\\x' }, { id: 'a#b', dataDir: '' }, 别人那条()],
  }), 'utf8');
  const kept = readInstancesFile(path);
  assert.equal(kept.recovered, false);
  assert.equal(kept.file.instances.length, 1);
  assert.equal(kept.file.instances[0]!.name, '别人的实例');
});

// ─────────────────── ① upsert：不覆盖 name、不清别人的条目 ───────────────────

test('② upsert 新增：字段齐全，name 用候选（空则目录末段），isDefault 照传', () => {
  const dir = tempDirSync('irmia-instances-upsert-');
  const path = join(dir, INSTANCES_FILE_NAME);
  const lines: string[] = [];
  const record = upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#9d1a89b00db1365b',
    name: '伊尔弥亚',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 58888,
    nodeExe: 'D:\\agent\\tools\\node\\node.exe',
    entry: 'D:\\agent\\app\\dist\\main.js',
    isDefault: true,
    now: NOW,
    out: (line) => lines.push(line),
  });
  assert.notEqual(record, null);
  assert.equal(record!.pid, 58888);
  assert.equal(record!.name, '伊尔弥亚');
  assert.equal(record!.nameSource, 'identity', '调用方给了名字（没说出处）⇒ 按"有名字 ⇒ identity"落格');
  assert.equal(record!.createdAt, '2026-10-26T10:00:00.000Z');
  assert.equal(record!.lastStartedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(record!.lastReadyAt, '');
  assert.ok(lines.some((line) => line.includes('登记表已更新')), '写成功了要留一句（不静默）');

  const file = read(path);
  assert.equal(file.v, 1);
  assert.equal(file.instances.length, 1);
  assert.equal(file.instances[0]!.name, '伊尔弥亚');

  // 没有名字 ⇒ 目录末段
  const other = upsertRunningInstance({
    path,
    id: '127.0.0.1:7789#ffff',
    name: '   ',
    dataDir: 'D:\\agent\\instances\\qa-a',
    host: '127.0.0.1',
    port: 7789,
    pid: 1,
    nodeExe: '',
    entry: '',
    isDefault: false,
    now: NOW,
  });
  assert.equal(other!.name, 'qa-a', '取不到名字就用数据目录末段');
  assert.equal(other!.nameSource, 'dir', '空名字 ⇒ 一定是目录末段（不用调用方说）');
  assert.equal(fallbackInstanceName('D:\\agent\\data\\'), 'data');
});

test('②b upsert 已有：**不覆盖 name / createdAt / isDefault**，只更新 pid/port/时刻', () => {
  const dir = tempDirSync('irmia-instances-upsert2-');
  const path = join(dir, INSTANCES_FILE_NAME);
  upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#hash',
    name: '伊尔弥亚',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 111,
    nodeExe: 'node-old',
    entry: 'entry-old',
    isDefault: true,
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  });
  // 第二次启动：名字候选不同、isDefault 也不同（模拟调用方改口径），都不许盖掉已定下的那两格
  const again = upsertRunningInstance({
    path,
    id: '127.0.0.1:7790#hash',
    name: '别的名字',
    dataDir: 'D:\\agent\\data\\',
    host: '127.0.0.1',
    port: 7790,
    pid: 222,
    nodeExe: 'node-new',
    entry: 'entry-new',
    isDefault: false,
    now: NOW,
  });
  assert.equal(again!.name, '伊尔弥亚', 'name 只在新增时定一次');
  assert.equal(again!.nameSource, 'identity', '名字没动，来源也不许跟着后一次启动变');
  assert.equal(again!.isDefault, true, 'isDefault 也不许被后一次启动改掉（它是"能不能删"的判据）');
  assert.equal(again!.createdAt, '2026-10-20T00:00:00.000Z', 'createdAt 是"这个实例第一次出现"的时刻');
  assert.equal(again!.pid, 222);
  assert.equal(again!.port, 7790);
  assert.equal(again!.lastStartedAt, '2026-10-26T10:00:00.000Z');
  assert.equal(again!.nodeExe, 'node-new');

  const file = read(path);
  assert.equal(file.instances.length, 1, '按 dataDir 认同一条（尾部反斜杠不算两条）');
});

test('②c 只写自己那条：预置别人的条目，upsert 之后别人一个字节都不许变', () => {
  const dir = tempDirSync('irmia-instances-neighbor-');
  const path = join(dir, INSTANCES_FILE_NAME);
  const neighbour = 别人那条();
  seed(path, [neighbour]);

  upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#mine',
    name: '我的',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 999,
    nodeExe: 'n',
    entry: 'e',
    isDefault: true,
    now: NOW,
  });

  const file = read(path);
  assert.equal(file.instances.length, 2, '追加而不是整份重写');
  assert.deepEqual(file.instances[0], neighbour, '别人那条必须逐字段不变');
  assert.equal(file.instances[1]!.name, '我的');
});

test('②d 坏文件：upsert 先把它改名成 `.bad` 留证据，再按空表重建（不静默抹掉）', () => {
  const dir = tempDirSync('irmia-instances-bad-');
  const path = join(dir, INSTANCES_FILE_NAME);
  writeFileSync(path, '{"v":1,"instances":[ {"id":"x","dataDir":"D:\\\\x"} ', 'utf8');
  const lines: string[] = [];
  upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#mine',
    name: '我的',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 7,
    nodeExe: 'n',
    entry: 'e',
    isDefault: false,
    now: NOW,
    out: (line) => lines.push(line),
  });
  const backup = readFileSync(`${path}.bad`, 'utf8');
  assert.ok(backup.includes('"id":"x"'), '坏文件原样留在 .bad 里（那里面可能有别人的残骸）');
  assert.equal(read(path).instances.length, 1);
  assert.ok(lines.some((line) => line.includes('.bad')), '重建这件事要说出来');
});

test('②e 陈旧锁：上一个持有者死了（mtime 很老）⇒ 直接接管，不卡住启动', () => {
  const dir = tempDirSync('irmia-instances-lock-');
  const path = join(dir, INSTANCES_FILE_NAME);
  const lock = `${path}.lock`;
  writeFileSync(lock, '', 'utf8');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);

  const record = upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#mine',
    name: '我的',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 7,
    nodeExe: 'n',
    entry: 'e',
    isDefault: false,
    now: NOW,
  });
  assert.notEqual(record, null);
  assert.equal(read(path).instances.length, 1);
  assert.equal(existsSync(lock), false, '放锁之后锁文件不许留在盘上');
});

// ─────────────────────── ② 退出：pid 清 0，不删条目 ───────────────────────

test('③ 退出：pid 清 0（条目还在）；pid 换用户了两个字节都不动；lastReadyAt 只认自己', () => {
  const dir = tempDirSync('irmia-instances-stop-');
  const path = join(dir, INSTANCES_FILE_NAME);
  seed(path, [别人那条()]);
  upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#mine',
    name: '我的',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 777,
    nodeExe: 'n',
    entry: 'e',
    isDefault: true,
    now: NOW,
  });

  // 就绪时刻：pid 是自己才写
  markInstanceReady({ path, dataDir: 'D:\\agent\\data', pid: 777, now: () => new Date('2026-10-26T10:00:30.000Z') });
  const ready = read(path).instances.find((item) => item.dataDir === 'D:\\agent\\data')!;
  assert.equal(ready.lastReadyAt, '2026-10-26T10:00:30.000Z');
  markInstanceReady({ path, dataDir: 'D:\\agent\\data', pid: 888, now: () => new Date('2026-10-26T11:00:00.000Z') });
  assert.equal(read(path).instances.find((item) => item.dataDir === 'D:\\agent\\data')!.lastReadyAt,
    '2026-10-26T10:00:30.000Z', 'pid 不是自己就不许拿旧时刻盖上去');

  // 别人的 pid 不同 ⇒ 清 0 这一下不许生效
  assert.equal(markInstanceStopped({ path, dataDir: 'D:\\agent\\data', pid: 999 }), false);
  assert.equal(read(path).instances.find((item) => item.dataDir === 'D:\\agent\\data')!.pid, 777);

  // 自己那份 ⇒ pid 清 0，条目还在，别人的那条照旧
  const lines: string[] = [];
  assert.equal(markInstanceStopped({
    path, dataDir: 'D:\\agent\\data', pid: 777, out: (line) => lines.push(line),
  }), true);
  const file = read(path);
  assert.equal(file.instances.length, 2, '退出**不删条目**（它是"这台机器上有过哪些实例"的记忆）');
  assert.equal(file.instances.find((item) => item.dataDir === 'D:\\agent\\data')!.pid, 0);
  assert.equal(file.instances[0]!.pid, 4321, '别人的 pid 不许被清');
});

test('③b 删条目：按 id 精确删（对称实现，供工具/用例用）', () => {
  const dir = tempDirSync('irmia-instances-remove-');
  const path = join(dir, INSTANCES_FILE_NAME);
  seed(path, [别人那条(), 别人那条({ id: '127.0.0.1:7798#zz', dataDir: 'D:\\instances\\z' })]);
  assert.equal(removeInstanceRecord({ path, id: '127.0.0.1:7798#zz' }), true);
  assert.equal(removeInstanceRecord({ path, id: '127.0.0.1:7798#zz' }), false);
  const file = read(path);
  assert.equal(file.instances.length, 1);
  assert.equal(file.instances[0]!.id, '127.0.0.1:7799#aaaabbbbccccdddd');
});

// ───────────────────── ① 名字：解析规则（与 gui/lib/her_name.dart 同形） ─────────────────────

/**
 * 名字的解析规则**必须与 `gui/lib/her_name.dart` 同形**（权威在那份 Dart 里）：下面这些样本
 * 与 `gui/test/her_name_test.dart` 刻意用同一批句子。三条判据：
 *   ① 有 `名字：` 那一行 ⇒ 一切以它为准（写得不清楚 = 没写，不去正文里猜）；
 *   ② 没有这一行、正文还是首启种子模板（`<!-- SEED`）⇒ 认不出；
 *   ③ 没有这一行、正文是人写过的 ⇒ 只认「我叫…」「我是…」，第一个**像名字的**算数。
 */
test('④ 名字解析：结构化行 / 括号注解 / 行尾标点 / 种子模板 / 散文过滤器', () => {
  // ① 结构化那一行说了算
  assert.equal(herNameFromIdentity('名字：小七'), '小七');
  assert.equal(herNameFromIdentity('- 名字: 小七（Xiaoqi）'), '小七', '括号那段是注解');
  assert.equal(herNameFromIdentity('名字：小七。'), '小七', '行尾标点是排版');
  assert.equal(herNameFromIdentity('名字：  小 七  '), '小 七', '压空白、去首尾');
  // 有这一行但写得不清楚 = 没写（不去正文里猜）
  assert.equal(herNameFromIdentity('名字：\n\n我叫小七。\n'), null);
  assert.equal(herNameFromIdentity('名字：<!-- 待定 -->\n\n我叫小七。\n'), null);
  // ② 种子模板里的示例句不是她
  assert.equal(herNameFromIdentity('<!-- SEED 填写后删除本行 -->\n名字：（改成她的名字）'), null);
  assert.equal(herNameFromIdentity('<!-- SEED 填写后删除本行 -->\n\n我叫小七。\n'), null);
  // ③ 散文过滤器：宁可认不出，也不把句子片段当名字
  assert.equal(herNameFromIdentity('我是一个住在服务器里的助手'), null);
  assert.equal(herNameFromIdentity('我是一个喜欢安静的人。'), null);
  assert.equal(herNameFromIdentity('我是这台机器上常驻的伙伴。'), null);
  assert.equal(herNameFromIdentity('我是谁？还没想好。'), null);
  assert.equal(herNameFromIdentity('我是。,！'), null);
  assert.equal(herNameFromIdentity('# 我是谁\n\n（还没写。）\n'), null);
  assert.equal(herNameFromIdentity(null), null);
  assert.equal(herNameFromIdentity(''), null);
  assert.equal(herNameFromIdentity('   \n\n'), null);
  // 清洗与长度上限
  assert.equal(cleanNameValue('x'.repeat(25)), null, '超长不是名字');
  assert.equal(cleanNameValue('  小 七  '), '小 七', '压空白、去首尾');
  assert.equal(looksLikeName('一个喜欢安静的人'), false);
  assert.equal(looksLikeName('小七'), true);
});

test('④a 名字①（用户口径）：IDENTITY 用**散文形状**（本机那份）⇒ 解出「伊尔弥亚」', () => {
  // 本机 `D:\agent\data\persona\IDENTITY.md` 的前两行就是这两句
  const identity = '# 我是谁\n\n'
    + '我是伊尔弥亚（Irmia）。表面身份：秩序圣殿祭司、弥亚庄园大小姐、总管家。\n'
    + '真实身份：魔神，每百年失忆一次。当前实力被极大削弱，魔力受限。\n';
  assert.equal(herNameFromIdentity(identity), '伊尔弥亚',
    '散文兜底就是为这一档存在的（旧版只认结构化行 ⇒ 登记表回落成 `data`）');
  // 「我叫…」同档；前一句不像名字就往后找（不因为第一句不像就整份放弃）
  assert.equal(herNameFromIdentity('# 我是谁\n\n我叫小七，是这台机器上常驻的伙伴。\n'), '小七');
  assert.equal(herNameFromIdentity('# 我是谁\n\n我是一个助手。我叫小七。\n'), '小七');
});

test('④b 名字②（用户口径）：只有**结构化那一行** ⇒ 同样解出', () => {
  assert.equal(herNameFromIdentity('名字：伊尔弥亚'), '伊尔弥亚');
  assert.equal(herNameFromIdentity('# 我是谁\n\n名字：伊尔弥亚\n'), '伊尔弥亚');
  // 结构化行优先于散文：两边都在时以那一行为准
  assert.equal(herNameFromIdentity('名字：小七\n\n我是伊尔弥亚（Irmia）。\n'), '小七');
});

test('④c 名字③（用户口径）：**都没有** ⇒ 目录末段（nameSource = dir）', () => {
  const dir = tempDirSync('irmia-instances-name-dir-');
  const path = join(dir, INSTANCES_FILE_NAME);
  // 正文认不出（"我是一个喜欢安静的人"不是名字）
  assert.equal(herNameFromIdentity('# 我是谁\n\n我是一个喜欢安静的人。\n'), null);
  const record = upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#namedir',
    name: fallbackInstanceName('D:\\agent\\data'), // 调用方解不出名字时就是这么传的
    nameSource: 'dir',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 11,
    nodeExe: 'n',
    entry: 'e',
    isDefault: true,
    now: NOW,
  });
  assert.equal(record!.name, 'data', '认不出名字 ⇒ 目录末段');
  assert.equal(record!.nameSource, 'dir');
  assert.equal(fallbackInstanceName('D:\\agent\\data\\'), 'data');
  assert.equal(fallbackInstanceName('D:\\agent\\instances\\qa-a'), 'qa-a');
});

test('④d 名字④（用户口径）：已有 **manual** 名字不被启动覆盖（连 nameSource 都不改）', () => {
  const dir = tempDirSync('irmia-instances-name-manual-');
  const path = join(dir, INSTANCES_FILE_NAME);
  seed(path, [别人那条({
    id: '127.0.0.1:7788#manual',
    name: '用户给起的名字',
    nameSource: 'manual',
    dataDir: 'D:\\agent\\data',
  })]);
  const after = upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#manual',
    name: '伊尔弥亚', // 这一次 IDENTITY 解出来了：也不许盖掉人工改过的
    nameSource: 'identity',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 22,
    nodeExe: 'n',
    entry: 'e',
    isDefault: true,
    now: NOW,
  });
  assert.equal(after!.name, '用户给起的名字', 'manual 的名字**永不覆盖**');
  assert.equal(after!.nameSource, 'manual');
  // 第三次、第四次启动（连"目录末段"都不给）照样不动
  upsertRunningInstance({
    path, id: '127.0.0.1:7788#manual', name: 'data', nameSource: 'dir',
    dataDir: 'D:\\agent\\data', host: '127.0.0.1', port: 7788, pid: 33,
    nodeExe: 'n', entry: 'e', isDefault: true, now: NOW,
  });
  const file = read(path);
  assert.equal(file.instances[0]!.name, '用户给起的名字');
  assert.equal(file.instances[0]!.nameSource, 'manual');
});

test('④e 名字⑤（用户口径）：旧条目 name=目录末段且有更好名字 ⇒ **升级一次**，第二次不再动', () => {
  const dir = tempDirSync('irmia-instances-name-upgrade-');
  const path = join(dir, INSTANCES_FILE_NAME);
  // 旧版登记下来的形状：name 是回落的目录末段，**没有 nameSource**（那一版还没有这个字段）
  seed(path, [别人那条({
    id: '127.0.0.1:7788#upgrade',
    name: 'data',
    dataDir: 'D:\\agent\\data',
  })]);
  const lines: string[] = [];
  const first = upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#upgrade',
    name: '伊尔弥亚',
    nameSource: 'identity',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 44,
    nodeExe: 'n',
    entry: 'e',
    isDefault: true,
    now: NOW,
    out: (line) => lines.push(line),
  });
  assert.equal(first!.name, '伊尔弥亚', '当时回落的那个名字，现在能解出来了 ⇒ 升级');
  assert.equal(first!.nameSource, 'identity');
  assert.ok(lines.some((line) => line.includes('升级')), '升级这件事要说出来（不静默改名字）');

  // 第二次启动：她后来改了名（IDENTITY 换成"新名字"）也**不许再覆盖**——只升级一次
  // 注意这条记录此刻 pid 还是 44（上一次没走退出路径），upsert 照旧按 dataDir 认它
  const second = upsertRunningInstance({
    path,
    id: '127.0.0.1:7788#upgrade',
    name: '新名字',
    nameSource: 'identity',
    dataDir: 'D:\\agent\\data',
    host: '127.0.0.1',
    port: 7788,
    pid: 55,
    nodeExe: 'n',
    entry: 'e',
    isDefault: true,
    now: NOW,
  });
  assert.equal(second!.name, '伊尔弥亚', '升级只发生一次（第二次启动一个字节都不动名字）');
  assert.equal(second!.nameSource, 'identity');
  assert.equal(read(path).instances[0]!.name, '伊尔弥亚');

  // 反面：旧条目 name=目录末段、但这一次也解不出名字 ⇒ 名字不动，只把来源补成 dir
  const dir2 = tempDirSync('irmia-instances-name-keepdir-');
  const path2 = join(dir2, INSTANCES_FILE_NAME);
  seed(path2, [别人那条({ id: '127.0.0.1:7790#keep', name: 'qa-a', dataDir: 'D:\\agent\\instances\\qa-a' })]);
  const kept = upsertRunningInstance({
    path: path2,
    id: '127.0.0.1:7790#keep',
    name: 'qa-a',
    nameSource: 'dir',
    dataDir: 'D:\\agent\\instances\\qa-a',
    host: '127.0.0.1',
    port: 7790,
    pid: 66,
    nodeExe: 'n',
    entry: 'e',
    isDefault: false,
    now: NOW,
  });
  assert.equal(kept!.name, 'qa-a', '没有更好的名字就保持目录末段');
  assert.equal(kept!.nameSource, 'dir', '老条目缺的那一格补成事实');
  // nameSourceOf 的反推：老条目（没有这一格）按"名字是不是目录末段"判
  assert.equal(nameSourceOf({ name: 'data', dataDir: 'D:\\agent\\data' }), 'dir');
  assert.equal(nameSourceOf({ name: '伊尔弥亚', dataDir: 'D:\\agent\\data' }), 'identity');
  assert.equal(nameSourceOf({ name: 'data', dataDir: 'D:\\agent\\data', nameSource: 'manual' }), 'manual');
});

test('④f 默认实例：安装根 config.json 写的那个 dataDir（本机现场）⇒ true', () => {
  // 本机部署形状：程序装在 `<安装根>\app`、数据在 `<数据根>\data`（config.json 里显式写着）
  const entry = 'D:\\agent\\app\\dist\\main.js';
  assert.equal(defaultDataDirOf({ entry, configDataDir: 'D:\\agent\\data' }), 'D:\\agent\\data');
  assert.equal(isDefaultDataDir({ entry, dataDir: 'D:\\agent\\data', configDataDir: 'D:\\agent\\data' }), true);
  // 大小写/尾部分隔符写法不同仍是同一个目录
  assert.equal(isDefaultDataDir({ entry, dataDir: 'd:\\agent\\data\\', configDataDir: 'D:\\agent\\data' }), true);
  // 另起的实例（--data-dir 指向别处）⇒ 不是默认
  assert.equal(isDefaultDataDir({ entry, dataDir: 'D:\\agent\\instances\\qa-a', configDataDir: 'D:\\agent\\data' }), false);
  // 出厂布局：config 没写 dataDir ⇒ `<install>/data`
  assert.equal(defaultDataDirOf({ entry, configDataDir: null }), join('D:\\agent\\app', 'data'));
  assert.equal(isDefaultDataDir({ entry, dataDir: join('D:\\agent\\app', 'data'), configDataDir: null }), true);
  // 判不出来 ⇒ 不给"默认"这个身份
  assert.equal(isDefaultDataDir({ entry: '', dataDir: 'D:\\x', configDataDir: null }), false);
});

test('④g 端口文件：每实例一份 `server.<port>.json`（旧名 server.json 留给默认实例）', () => {
  const path = serverPortFilePathForPort(7789, { LOCALAPPDATA: 'C:\\fake-local' }, 'win32');
  assert.equal(path, join('C:\\fake-local', 'Irmia', `${SERVER_PORT_FILE_PREFIX}7789.json`));
  assert.equal(SERVER_PORT_FILE_PREFIX, 'server.');
  assert.equal(serverPortFilePathForPort(7789, {}, 'win32'), null);
  assert.equal(serverPortFilePathForPort(0, { LOCALAPPDATA: 'C:\\x' }, 'win32'), null);
  assert.equal(serverPortFilePathForPort(70000, { LOCALAPPDATA: 'C:\\x' }, 'win32'), null);
});

// ─────────────────────── ③ / ④ 两条新端点（真服务） ───────────────────────

const PASSWORD = 'instance-test-password-0123';

interface Fixture {
  base: string;
  server: WebServer;
  token: string;
  /** 优雅退出的注入点收到过几次（每次 = 一次 requestGracefulStopExit） */
  exits: { count: number };
  /** 让 `now` 往前走（"60 秒宽限窗口过期"那条用例） */
  advance: (ms: number) => void;
}

async function realServer(t: TestContext, options: { identity?: { name: string; isDefault: boolean } } = {}): Promise<Fixture> {
  const dir = tempDirSync('irmia-instance-api-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const base = Date.parse('2026-10-26T10:00:00.000Z');
  let offset = 0;
  const now = (): Date => new Date(base + offset);
  const auth = new AuthStore({ dataDir, now, out: () => {} });
  const issued = await auth.setup(PASSWORD);
  assert.equal(issued.ok, true);
  if (!issued.ok) throw new Error('夹具设密码失败');

  const log = await EventLog.open(join(dataDir, 'events'));
  const timers = new TimerStore(join(dataDir, 'timers.json'), { now });
  const config = defaultConfig(dataDir);
  const configPath = join(dataDir, 'config.json');
  writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, 'utf8');
  const exits = { count: 0 };
  const server = await startWebServer({
    log,
    projection: emptyProjection(),
    config,
    personaRoot: join(dataDir, 'persona'),
    dataDir,
    timers,
    now,
    auth,
    port: 0,
    configPath,
    out: () => {},
    // **绝不真的退出**：注入之后 requestGracefulStopExit 只记一笔（这条用例要断言"走的是哪条路"）
    onStopInstanceExit: () => { exits.count += 1; },
    ...(options.identity === undefined ? {} : { instanceIdentity: options.identity }),
  });
  t.after(async () => {
    await server.close();
    log.close();
  });
  return { base: server.url(), server, token: issued.token, exits, advance: (ms) => { offset += ms; } };
}

async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // 非 JSON：留着空对象，断言自己决定怎么读
  }
  return { status: res.status, body };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('⑤ GET /api/instance：**免凭据**、七个字段、不多说一个字', async (t) => {
  const f = await realServer(t, { identity: { name: '伊尔弥亚', isDefault: true } });
  const got = await call(`${f.base}/api/instance`);
  assert.equal(got.status, 200, '这条端点不许要凭据（门前判活就要用）');
  assert.deepEqual(Object.keys(got.body).sort(), [
    'dataDir', 'id', 'isDefault', 'name', 'pid', 'port', 'runningMs',
  ]);
  assert.equal(got.body['name'], '伊尔弥亚');
  assert.equal(got.body['isDefault'], true);
  assert.equal(got.body['port'], f.server.port());
  assert.equal(got.body['pid'], process.pid);
  assert.equal(typeof got.body['dataDir'], 'string', 'dataDir 是刻意给的（界面要拿它拉起后端）');
  assert.equal(typeof got.body['runningMs'], 'number');
  assert.match(String(got.body['id']), /^127\.0\.0\.1:\d+#[0-9a-f]{16}$/u, 'id 是 <host>:<port>#<哈希>');
  // 泄露面：不带凭据、不带会话数、不带事件
  for (const forbidden of ['token', 'sessions', 'password', 'auth', 'events']) {
    assert.equal(forbidden in got.body, false, `响应里不许出现 ${forbidden}`);
  }

  // 没注入身份时如实降级（name = 目录末段、isDefault = false，不猜"我是默认实例"）
  const plain = await realServer(t);
  const fallback = await call(`${plain.base}/api/instance`);
  assert.equal(fallback.body['name'], 'data');
  assert.equal(fallback.body['isDefault'], false);
});

test('⑤b GET /api/instance：未就绪也照常答（判活不许把"正在启动"读成"没在跑"）', async (t) => {
  const f = await realServer(t);
  // 这份装配没注入 startup ⇒ 默认就是"已就绪"；这里直接验 POST 以外的行为一致即可
  const got = await call(`${f.base}/api/instance`, { method: 'POST' });
  assert.equal(got.status, 405, '方法不对是 405（地址存在，只是不接受 POST）');
});

test('⑥ POST /api/commands/stop-instance：缺 X-Confirm=400；缺凭据=401；两样都带=200 并走优雅退出', async (t) => {
  const f = await realServer(t);
  const url = `${f.base}/api/commands/stop-instance`;
  const auth = { authorization: `Bearer ${f.token}` };

  // ① 缺 X-Confirm：400 confirm-required（与 /api/commands/* 那条通道同一句话）
  const noConfirm = await call(url, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noConfirm.status, 400);
  assert.equal((noConfirm.body['error'] as Record<string, unknown>)['code'], 'confirm-required');
  assert.equal(f.exits.count, 0, '被拦下的请求不许触发退出');

  // ② 带 X-Confirm 但没凭据：401（它不是免认证端点）
  const noToken = await call(url, {
    method: 'POST',
    headers: { 'x-confirm': 'stop-instance', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(noToken.status, 401);
  assert.equal(f.exits.count, 0);

  // ③ 两样都带：200 + {ok, stopping}，然后（回执之后）走**既有优雅退出路径**
  const ok = await call(url, {
    method: 'POST',
    headers: { ...auth, 'x-confirm': 'stop-instance', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, stopping: true });
  assert.equal(f.exits.count, 0, '回执先回，退出不许压在同一次响应里');
  await sleep(150);
  assert.equal(f.exits.count, 1, '回执之后必须走一次优雅退出（不是 process.exit）');
});

test('⑥b 登出三步的顺序可行：logout 把票作废之后，那张票仍能停一次（60 秒宽限），过期就 401', async (t) => {
  const f = await realServer(t);
  const auth = { authorization: `Bearer ${f.token}` };

  // 第一步：作废会话（界面那三步的第一步）
  const logout = await call(`${f.base}/api/auth/logout`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'gui' }),
  });
  assert.equal(logout.status, 200);

  // 作废之后，普通读端点立刻不认这张票（"登出"这件事是真的）
  const afterLogout = await call(`${f.base}/api/projection`, { headers: auth });
  assert.equal(afterLogout.status, 401);

  // 但第二步（停实例）还能用它 —— 否则「登出=优雅结束实例」永远只能退化成硬杀
  const stop = await call(`${f.base}/api/commands/stop-instance`, {
    method: 'POST',
    headers: { ...auth, 'x-confirm': 'stop-instance', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(stop.status, 200);
  await sleep(120);
  assert.equal(f.exits.count, 1);

  // 宽限窗口过期之后：同一张票不再放行（它不是一条新通道）
  const late = await realServer(t);
  const lateAuth = { authorization: `Bearer ${late.token}` };
  await call(`${late.base}/api/auth/logout`, {
    method: 'POST',
    headers: { ...lateAuth, 'content-type': 'application/json' },
    body: '{}',
  });
  late.advance(61_000);
  const expired = await call(`${late.base}/api/commands/stop-instance`, {
    method: 'POST',
    headers: { ...lateAuth, 'x-confirm': 'stop-instance', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(expired.status, 401, '超过 60 秒的旧票不放行');
  assert.equal(late.exits.count, 0);
});

