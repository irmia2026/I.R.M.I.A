/**
 * **端口文件**（`src/runtime/server-port-file.ts`）—— 界面取端口的第一档。
 *
 * 为什么它值得单独立案：这条链的另一半在 Dart（`gui/lib/backend_port.dart`，那里有
 * 三级来源的用例），而**写**的那一半在这里。两边必须认同一份形状：
 * `%LOCALAPPDATA%\Irmia\server.json` → `{"port":7788,"pid":58888,"since":"…"}`。
 *
 * 三条纪律（都是事故教出来的）：
 *   ① **bind 成功那一刻才写**——先写再 bind 等于把"我听了 7788"说在一个没人听的端口上；
 *   ② **退出时删掉，但只删自己那份**——一份过期的端口文件会把界面带到一个死端口；
 *      而"旧实例收尾很慢、新实例已经接管"时删错，就是删掉别人正在用的那一份；
 *   ③ **解析失败一律当没有**——坏的提示位不许把界面指向一个瞎猜的端口。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  SERVER_PORT_FILE_NAME, readServerPortFile, removeServerPortFile, serverPortFilePath, shouldClaimLegacyPortFile, writeServerPortFile,
} from '../src/runtime/server-port-file.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('① 路径口径：`%LOCALAPPDATA%\\Irmia\\server.json`（与界面的 serverPortFilePath 同形）', () => {
  const path = serverPortFilePath({ LOCALAPPDATA: 'C:\\fake-localappdata' }, 'win32');
  assert.equal(path, join('C:\\fake-localappdata', 'Irmia', SERVER_PORT_FILE_NAME));
  assert.equal(SERVER_PORT_FILE_NAME, 'server.json');
  // 拿不到 LOCALAPPDATA / 不是 Windows ⇒ null（不猜一个目录写进去）
  assert.equal(serverPortFilePath({}, 'win32'), null);
  assert.equal(serverPortFilePath({ LOCALAPPDATA: '   ' }, 'win32'), null);
  assert.equal(serverPortFilePath({ LOCALAPPDATA: 'C:\\x' }, 'linux'), null);
});

test('② 写 → 读：形状就是 {port,pid,since}，读回来一字不差', () => {
  const dir = tempDirSync('irmia-port-file-');
  const path = join(dir, 'server.json');
  const ok = writeServerPortFile({
    path, port: 7788, pid: 58888, since: '2026-10-26T00:00:00.000Z',
  });
  assert.equal(ok, true);
  assert.equal(existsSync(path), true);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(raw, { port: 7788, pid: 58888, since: '2026-10-26T00:00:00.000Z' });
  assert.deepEqual(readServerPortFile(path), {
    port: 7788, pid: 58888, since: '2026-10-26T00:00:00.000Z',
  });
});

test('②b 写不进去（目录是个文件）⇒ 返回 false、**不抛**（写不进去不该拦住后端启动）', () => {
  const dir = tempDirSync('irmia-port-file-bad-');
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'x', 'utf8');
  const lines: string[] = [];
  const ok = writeServerPortFile({
    path: join(blocker, 'server.json'), port: 7788, pid: 1, out: (line) => { lines.push(line); },
  });
  assert.equal(ok, false);
  assert.ok(lines.some((line) => line.includes('端口文件写不进去')), '写不进去要留一句话（不静默）');
});

test('③ 坏文件一律当没有：不存在 / 半截 JSON / port 不是合法整数', () => {
  const dir = tempDirSync('irmia-port-file-corrupt-');
  const path = join(dir, 'server.json');
  assert.equal(readServerPortFile(path), null, '不存在 ⇒ null');

  for (const body of ['{"port":', '{"port":"7788"}', '{"port":0}', '{"port":70000}', '[]', 'null', '{"pid":1}']) {
    writeFileSync(path, body, 'utf8');
    assert.equal(readServerPortFile(path), null, `坏文件必须当没有：${body}`);
  }

  // pid/since 读不出来不影响端口（端口是唯一的硬判据）
  writeFileSync(path, '{"port":7801}', 'utf8');
  assert.deepEqual(readServerPortFile(path), { port: 7801, pid: 0, since: '' });
});

test('④ 退出时删：只删自己那份（pid 不同 ⇒ 一个字节都不动）', () => {
  const dir = tempDirSync('irmia-port-file-remove-');
  const path = join(dir, 'server.json');
  writeServerPortFile({ path, port: 7788, pid: 222, since: '2026-10-26T00:00:00.000Z' });

  // 不是自己那份（新实例已经接管）⇒ 不许删
  removeServerPortFile(path, { pid: 111 });
  assert.equal(existsSync(path), true, '别人的端口文件不许删');
  assert.equal(readServerPortFile(path)?.pid, 222);

  // 自己那份 ⇒ 删
  removeServerPortFile(path, { pid: 222 });
  assert.equal(existsSync(path), false);

  // 本来就没有 ⇒ 不抛（退出路径上这不是错）
  removeServerPortFile(path, { pid: 222 });
  removeServerPortFile(null);
});

test('shouldClaimLegacyPortFile：盘上那份还活着就不抢（2026-10-26 冒烟现场）', () => {
  const base = { path: 'C:\\x\\server.json', pid: 4242 };
  const alive = (pid: number): boolean => pid === 1111;

  assert.equal(shouldClaimLegacyPortFile({ ...base, existing: null, alive }).reason, 'missing');
  assert.equal(shouldClaimLegacyPortFile({ ...base, existing: { port: 7788, pid: 4242, since: '' }, alive }).reason, 'same-pid');
  // 关键一条：另一份实例还在跑 ⇒ **不抢**
  const live = shouldClaimLegacyPortFile({ ...base, existing: { port: 7788, pid: 1111, since: '' }, alive });
  assert.equal(live.claim, false);
  assert.equal(live.reason, 'live-other');
  // 那个 pid 已经死了 ⇒ 接班
  const stale = shouldClaimLegacyPortFile({ ...base, existing: { port: 7788, pid: 9999, since: '' }, alive });
  assert.equal(stale.claim, true);
  assert.equal(stale.reason, 'stale');
  assert.equal(shouldClaimLegacyPortFile({ ...base, path: null, existing: null, alive }).reason, 'no-path');
});
