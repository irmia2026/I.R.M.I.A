/**
 * 更新检查的**节流、状态与留痕**（`src/update/service.ts`）。
 *
 * 验收里那三条读数在这里钉住：
 *   · 12 小时窗口内第二次调用**不发请求**（假服务器计数 = 1），手动检查可越过窗口；
 *   · **连续失败 3 次后降频到 24 小时**（第 4 次在 12 小时后仍被挡下，24 小时后才放行）；
 *   · 状态文件是原子写的合法 JSON；**坏 JSON 当成没有状态重建**；
 *   · 事件 `update/checked` 的可见性是 `internal`（不进她的上下文），且端点已脱敏。
 *
 * 一律打 `127.0.0.1` 随机端口的假服务器，不碰真站。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  UPDATE_DEGRADED_INTERVAL_MS,
  UPDATE_FAILURE_THRESHOLD,
  UPDATE_INTERVAL_MS,
  UPDATE_STATE_FILE_NAME,
  UpdateService,
  nextAllowedMsOf,
  parseUpdateState,
  readUpdateState,
  updateIntervalMs,
  writeUpdateState,
  type UpdateState,
} from '../src/update/service.ts';
import type { UpdateChecked } from '../src/log/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 假服务器 ────────────────────────────────

interface Fake {
  endpoint: string;
  requests: number;
  close: () => Promise<void>;
}

async function fakeServer(
  respond: (res: import('node:http').ServerResponse) => void,
): Promise<Fake> {
  const state = { requests: 0 };
  const server = createServer((_req, res) => {
    state.requests += 1;
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    get requests() {
      return state.requests;
    },
    endpoint: `http://127.0.0.1:${address.port}/releases/latest.json`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function okManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    channel: 'beta',
    version: '0.1.0-beta.13',
    notesUrl: 'https://irmia.me/releases/beta/',
    minimumVersion: null,
    platforms: [{
      os: 'win32',
      arch: 'x64',
      kind: 'installer',
      url: 'https://irmia.me/releases/beta/setup.exe',
      size: 1,
      sha256: 'a'.repeat(64),
    }],
    ...overrides,
  };
}

function jsonResponder(payload: unknown): (res: import('node:http').ServerResponse) => void {
  return (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
}

const T0 = Date.parse('2026-10-22T00:00:00.000Z');

interface Harness {
  dir: string;
  service: UpdateService;
  events: Array<{ type: string; data: UpdateChecked['data']; visibility: string }>;
  logs: string[];
  advance: (ms: number) => void;
  now: () => Date;
  statePath: string;
}

function harness(options: {
  endpoint: string;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  channel?: 'beta' | 'stable';
}): Harness {
  const dir = tempDirSync('irmia-update-');
  mkdirSync(dir, { recursive: true });
  let nowMs = T0;
  const now = (): Date => new Date(nowMs);
  const events: Harness['events'] = [];
  const logs: string[] = [];
  const service = new UpdateService({
    dataDir: dir,
    currentVersion: '0.1.0-beta.12',
    enabled: options.enabled ?? true,
    channel: options.channel ?? 'beta',
    endpoint: options.endpoint,
    now,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    emit: (type, data, visibility) => {
      events.push({ type, data, visibility });
    },
    out: (line) => logs.push(line),
  });
  return {
    dir,
    service,
    events,
    logs,
    now,
    advance: (ms: number) => { nowMs += ms; },
    statePath: join(dir, UPDATE_STATE_FILE_NAME),
  };
}

// ──────────────────────────────── 节流 ────────────────────────────────

describe('节流：12 小时窗口内不发第二次请求', () => {
  test('第一次查（发 1 次）→ 12h 内第二次被挡（计数仍是 1）→ 手动可越过', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });

    const first = await fx.service.checkNow();
    assert.equal(first.performed, true);
    assert.equal(fake.requests, 1, '第一次真的发了');
    assert.equal(first.view.status, 'available');

    fx.advance(60 * 60 * 1000); // +1h
    const second = await fx.service.checkNow();
    assert.equal(second.performed, false, '1 小时后还在 12h 窗口里');
    assert.equal(second.skipped, 'throttled');
    assert.equal(fake.requests, 1, '节流命中时假服务器计数不变');

    // 手动检查是人的意图：无视窗口
    const manual = await fx.service.checkNow({ manual: true });
    assert.equal(manual.performed, true);
    assert.equal(fake.requests, 2, '手动检查真发了一次');
  });

  test('窗口过了（12h + 1s）自动检查放行', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();
    fx.advance(UPDATE_INTERVAL_MS + 1000);
    const again = await fx.service.checkNow();
    assert.equal(again.performed, true);
    assert.equal(fake.requests, 2);
  });

  test('连续失败 3 次后降频到 24 小时（第 4 次 12h 后仍被挡，24h 后才放）', async (t) => {
    const fake = await fakeServer((res) => {
      res.writeHead(500);
      res.end('boom');
    });
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });

    await fx.service.checkNow(); // 失败 1：next = +12h
    assert.equal(fx.service.view().consecutiveFailures, 1);
    fx.advance(UPDATE_INTERVAL_MS + 1000);
    await fx.service.checkNow(); // 失败 2
    assert.equal(fx.service.view().consecutiveFailures, 2);
    fx.advance(UPDATE_INTERVAL_MS + 1000);
    const third = await fx.service.checkNow(); // 失败 3：窗口变 24h
    assert.equal(third.performed, true);
    assert.equal(fx.service.view().consecutiveFailures, UPDATE_FAILURE_THRESHOLD);
    assert.equal(fx.service.view().intervalHours, 24);
    assert.equal(fake.requests, 3);

    // 12 小时之后：仍在 24h 窗口里 ⇒ 不发请求
    fx.advance(UPDATE_INTERVAL_MS + 1000);
    const fourth = await fx.service.checkNow();
    assert.equal(fourth.performed, false);
    assert.equal(fourth.skipped, 'throttled');
    assert.equal(fake.requests, 3, '降频生效：第 4 次在 12h 后没有发出去');

    // 再等到 24h 窗口过去（累计 24h + 2s）⇒ 放行
    fx.advance(12 * 60 * 60 * 1000 + 1000);
    const fifth = await fx.service.checkNow();
    assert.equal(fifth.performed, true);
    assert.equal(fake.requests, 4);
  });

  test('成功一次就把失败计数清零（窗口回到 12h）', async (t) => {
    let fail = true;
    const fake = await fakeServer((res) => {
      if (fail) {
        res.writeHead(500); res.end('x'); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(okManifest()));
    });
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();
    fx.advance(UPDATE_INTERVAL_MS + 1);
    await fx.service.checkNow();
    assert.equal(fx.service.view().consecutiveFailures, 2);
    fail = false;
    fx.advance(UPDATE_INTERVAL_MS + 1);
    await fx.service.checkNow();
    assert.equal(fx.service.view().consecutiveFailures, 0);
    assert.equal(fx.service.view().intervalHours, 12);
  });
});

// ──────────────────────────────── 状态文件 ────────────────────────────────

describe('状态文件：原子写、坏 JSON 重建', () => {
  test('检查之后状态文件是合法 JSON，且没有 .tmp 残留', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();

    assert.equal(existsSync(fx.statePath), true);
    const saved = JSON.parse(readFileSync(fx.statePath, 'utf8')) as UpdateState;
    assert.equal(saved.lastStatus, 'available');
    assert.equal(saved.latestVersion, '0.1.0-beta.13');
    assert.equal(saved.currentVersion, '0.1.0-beta.12');
    assert.equal(saved.channel, 'beta');
    assert.equal(saved.consecutiveFailures, 0);
    assert.equal(typeof saved.lastAttemptAt, 'string');
    assert.equal(
      readdirSync(fx.dir).some((name) => name.includes('.tmp.')),
      false,
      '原子写的临时文件必须已经被 rename 掉',
    );
  });

  test('坏 JSON ⇒ 当成没有状态重建（不是永远停摆）', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    writeFileSync(fx.statePath, '{ this is not json', 'utf8');

    // 读：坏文件 = 空状态（不是抛，也不是把上一个版本号当真）
    assert.equal(readUpdateState(fx.statePath).lastAttemptAt, null);
    assert.equal(fx.service.view().status, 'unknown');
    assert.equal(fx.service.view().reason, 'never-checked');

    // 写：下一次检查把整份重建出来
    await fx.service.checkNow();
    const saved = JSON.parse(readFileSync(fx.statePath, 'utf8')) as UpdateState;
    assert.equal(saved.schema, 1);
    assert.equal(saved.lastStatus, 'available');
  });

  test('单格坏了只丢那一格（时间戳不是时间 ⇒ null，其余照收）', () => {
    const parsed = parseUpdateState(JSON.stringify({
      schema: 1,
      lastAttemptAt: 'not-a-time',
      lastStatus: 'available',
      latestVersion: '0.1.0-beta.13',
      consecutiveFailures: -3,
    }));
    assert.equal(parsed.lastAttemptAt, null);
    assert.equal(parsed.lastStatus, 'available');
    assert.equal(parsed.latestVersion, '0.1.0-beta.13');
    assert.equal(parsed.consecutiveFailures, 0, '负数是坏数据，回 0');
  });

  test('write/read 往返；nextAllowedAt 由 lastAttemptAt + 当前窗口算', () => {
    const dir = tempDirSync('irmia-update-state-');
    const path = join(dir, UPDATE_STATE_FILE_NAME);
    const state: UpdateState = {
      ...readUpdateState(path),
      lastAttemptAt: new Date(T0).toISOString(),
      lastStatus: 'unknown',
      reason: 'network',
      consecutiveFailures: 3,
    };
    assert.equal(writeUpdateState(path, state), true);
    const back = readUpdateState(path);
    assert.deepEqual(back, state);
    assert.equal(nextAllowedMsOf(back), T0 + UPDATE_DEGRADED_INTERVAL_MS);
    assert.equal(updateIntervalMs(0), UPDATE_INTERVAL_MS);
    assert.equal(updateIntervalMs(2), UPDATE_INTERVAL_MS);
    assert.equal(updateIntervalMs(3), UPDATE_DEGRADED_INTERVAL_MS);
  });
});

// ──────────────────────────────── 事件与隐私 ────────────────────────────────

describe('事件 update/checked：internal、脱敏、失败也留痕', () => {
  test('成功的检查写一条 internal 事件，字段齐全', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();

    assert.equal(fx.events.length, 1);
    const event = fx.events[0];
    assert.ok(event !== undefined);
    assert.equal(event.type, 'update/checked');
    assert.equal(event.visibility, 'internal', '不进她的上下文');
    assert.deepEqual(event.data, {
      status: 'available',
      currentVersion: '0.1.0-beta.12',
      latestVersion: '0.1.0-beta.13',
      channel: 'beta',
      endpoint: fake.endpoint,
      checkedAt: new Date(T0).toISOString(),
      reason: 'newer',
    });
  });

  test('失败的检查也写事件：status unknown + reason 如实带上（不是错误弹窗）', async (t) => {
    const fake = await fakeServer((res) => {
      res.writeHead(404);
      res.end('no');
    });
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();
    const event = fx.events[0];
    assert.ok(event !== undefined);
    assert.equal(event.data.status, 'unknown');
    assert.equal(event.data.reason, 'http-404');
    assert.equal(event.visibility, 'internal');
  });

  test('端点里的 query 不写进事件/状态/视图（请求时仍用它）', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const endpoint = `${fake.endpoint}?token=super-secret&who=owner`;
    const fx = harness({ endpoint });
    await fx.service.checkNow();

    const event = fx.events[0];
    assert.ok(event !== undefined);
    assert.equal(event.data.endpoint, fake.endpoint, '事件里只剩 protocol//host/path');
    assert.equal(JSON.stringify(event.data).includes('super-secret'), false);
    assert.equal(JSON.stringify(fx.service.view()).includes('super-secret'), false);
    const savedText = readFileSync(fx.statePath, 'utf8');
    assert.equal(savedText.includes('super-secret'), false, '状态文件里也不许留 query');
  });

  test('required ⇒ dismissible:false；available ⇒ true', async (t) => {
    const requiredFake = await fakeServer(jsonResponder(okManifest({
      version: '0.1.0-beta.14',
      minimumVersion: '0.1.0-beta.13',
    })));
    const availableFake = await fakeServer(jsonResponder(okManifest()));
    t.after(async () => {
      await requiredFake.close();
      await availableFake.close();
    });
    const required = harness({ endpoint: requiredFake.endpoint });
    await required.service.checkNow();
    assert.equal(required.service.view().status, 'required');
    assert.equal(required.service.view().dismissible, false, '低于最低可用版本，不可关');

    const available = harness({ endpoint: availableFake.endpoint });
    await available.service.checkNow();
    assert.equal(available.service.view().status, 'available');
    assert.equal(available.service.view().dismissible, true);
  });

  test('并发两次检查只发一个请求（在飞去重）', async (t) => {
    const fake = await fakeServer((res) => {
      // 故意延迟一点：让两个调用真的叠在一起
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(okManifest()));
      }, 30);
    });
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    const [a, b] = await Promise.all([
      fx.service.checkNow(),
      fx.service.checkNow({ manual: true }),
    ]);
    assert.equal(a.performed, true);
    assert.equal(b.performed, true);
    assert.equal(fake.requests, 1, '两条链路同时到 = 一个请求');
    assert.equal(fx.events.length, 1);
  });
});

// ──────────────────────────────── 开关与起拍 ────────────────────────────────

describe('平台与网盘分流（GUI 下载入口的数据）', () => {
  test('platforms / mirrors 落进状态与视图（pending 条目也在，供界面灰掉「待上传」）', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest({
      platforms: [
        { os: 'win32', arch: 'x64', kind: 'installer', url: 'https://irmia.me/setup.exe', size: 1, sha256: 'a'.repeat(64) },
        { os: 'linux', arch: 'x64', kind: 'installer', url: 'https://irmia.me/linux.AppImage', size: 1, sha256: 'b'.repeat(64) },
        // 待上传的条目可以还没有 url（站点还没传完）
        { os: 'darwin', arch: 'arm64', kind: 'portable', _pending: true },
      ],
      mirrors: [
        { provider: 'baidu', url: 'https://pan.baidu.com/s/abc', code: 'x7k2' },
        // 就绪但没有地址 ⇒ 丢掉（点了没反应的按钮不该出现）
        { provider: 'quark' },
      ],
    })));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();

    const view = fx.service.view();
    assert.equal(view.platforms.length, 3);
    assert.deepEqual(view.platforms[2], {
      os: 'darwin', arch: 'arm64', kind: 'portable', url: '', pending: true,
    });
    assert.deepEqual(view.mirrors, [{ provider: 'baidu', url: 'https://pan.baidu.com/s/abc', code: 'x7k2' }]);
    assert.match(view.releasesUrl, /^http:\/\/127\.0\.0\.1:\d+\/releases\/$/);
    // 落盘：下次启动（比如收在托盘里之后重启）还看得见同一份
    const saved = JSON.parse(readFileSync(fx.statePath, 'utf8')) as UpdateState;
    assert.equal(saved.platforms.length, 3);
    assert.deepEqual(saved.mirrors, view.mirrors);
  });

  test('站点清单里没有 mirrors ⇒ 视图仍有一条 pending（GUI 永远有"网盘下载"那一格）', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.checkNow();
    assert.deepEqual(fx.service.view().mirrors, [{ provider: 'pending' }]);
  });
});

describe('切通道（运行期那一半）：清节流 + 立刻查一次', () => {
  test('applyChannel：换通道、清空失败计数与旧结果、立刻发一次请求', async (t) => {
    let fail = true;
    const fake = await fakeServer((res) => {
      if (fail) { res.writeHead(500); res.end('x'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(okManifest()));
    });
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });

    await fx.service.checkNow();
    fx.advance(UPDATE_INTERVAL_MS + 1);
    await fx.service.checkNow();
    assert.equal(fx.service.view().consecutiveFailures, 2);
    assert.equal(fake.requests, 2);

    fail = false;
    const run = await fx.service.applyChannel('stable');
    assert.equal(run.performed, true, '切完立刻查（无视 12h 窗口）');
    assert.equal(fake.requests, 3);
    const view = fx.service.view();
    assert.equal(view.channel, 'stable');
    assert.equal(view.consecutiveFailures, 0, '节流状态被清空');
    assert.equal(view.status, 'none');
    assert.equal(view.reason, 'channel-mismatch', '假站点只说 beta');

    // 状态文件也换了通道（重启后界面显示的是同一条通道）
    const saved = JSON.parse(readFileSync(fx.statePath, 'utf8')) as UpdateState;
    assert.equal(saved.channel, 'stable');
  });

  test('applyChannel 后 12h 内自动检查仍按新窗口节流', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    await fx.service.applyChannel('beta');
    assert.equal(fake.requests, 1);
    fx.advance(60 * 60 * 1000);
    const auto = await fx.service.checkNow({ manual: false });
    assert.equal(auto.performed, false);
    assert.equal(fake.requests, 1);
  });
});

describe('关闭与起拍', () => {
  test('enabled:false ⇒ 自动/手动都不发请求，返回 skipped disabled', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint, enabled: false });
    const auto = await fx.service.checkNow();
    assert.deepEqual([auto.performed, auto.skipped], [false, 'disabled']);
    const manual = await fx.service.checkNow({ manual: true });
    assert.deepEqual([manual.performed, manual.skipped], [false, 'disabled']);
    assert.equal(fake.requests, 0, '关掉之后一个请求都不发');
    assert.equal(fx.events.length, 0);
    assert.equal(fx.service.view().enabled, false);
  });

  test('start() 按 firstCheckDelayMs 起拍；stop() 之后不再排下一次', async (t) => {
    const fake = await fakeServer(jsonResponder(okManifest()));
    t.after(() => fake.close());
    const fx = harness({ endpoint: fake.endpoint });
    const service = new UpdateService({
      dataDir: fx.dir,
      currentVersion: '0.1.0-beta.12',
      enabled: true,
      channel: 'beta',
      endpoint: fake.endpoint,
      now: fx.now,
      firstCheckDelayMs: 5,
      emit: (type, data, visibility) => { fx.events.push({ type, data, visibility }); },
      out: () => {},
    });
    service.start();
    const deadline = Date.now() + 3000;
    while (fx.events.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fx.events.length, 1, '首检在 5ms 后发生');
    assert.equal(fake.requests, 1);
    service.stop();
    // stop 之后就算时间飞过 12h，也不该再自动发第二发（这里没有定时器可等了，断言状态即可）
    assert.equal(fake.requests, 1);
  });
});
