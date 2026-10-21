/**
 * 告警出口测试 — src/alert/notifier.ts
 *
 * 覆盖 docs/milestones.md M3-6（告警限流）、M3-7（恢复通知）、M3-10（限流跨重启）、
 * M3-8 的"告警已发出"一半，以及 docs/design.md §4.9 的三档出口。
 *
 * 时间用可注入时钟钉死在 2024-01-01T00:00:00Z；网络用注入的 fetch 假实现，
 * 不产生任何真实外呼；文件档落在 mkdtemp 出来的临时目录里。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ALERT_DIR_NAME, AlarmIndex, createNotifier, foldAlarms, Notifier, RATE_LIMITED,
  fingerprintOf, type AlertInput, type AlertNotifier, type AlertRecord,
} from '../src/alert/notifier.ts';
import type { AppEvent } from '../src/log/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

const T0 = Date.parse('2024-01-01T00:00:00Z');
const MIN_MS = 60_000;
const DAY = '2024-01-01';
const WEBHOOK = 'https://alerts.test/hook';

interface WebhookCall {
  url: string;
  body: Record<string, unknown>;
  contentType: string | undefined;
}

interface Fixture {
  dir: string;
  notifier: AlertNotifier;
  /** 假 fetch 收到的全部请求（顺序即发送顺序） */
  calls: WebhookCall[];
  /** 宿主落库的 alarm/sent 事件（限流窗口的事实来源） */
  events: AppEvent[];
  /** 推进注入时钟 */
  advance: (ms: number) => void;
  /** 设置下一次 webhook 的响应码 */
  setStatus: (status: number) => void;
  logPath: () => string;
  logLines: () => string[];
}

function setup(
  t: TestContext,
  options: { webhook?: string | undefined; rateLimitMin?: number; history?: Iterable<AppEvent> } = {},
): Fixture {
  const dir = tempDirSync('irmia-alert-');
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const calls: WebhookCall[] = [];
  const events: AppEvent[] = [];
  const state = { status: 200 };
  let nowMs = T0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      contentType: headers['content-type'],
    });
    return new Response('{}', { status: state.status });
  };

  const config = options.webhook === undefined
    ? { rateLimitMin: options.rateLimitMin ?? 30 }
    : { rateLimitMin: options.rateLimitMin ?? 30, webhookUrl: options.webhook };

  const notifier = createNotifier({
    config,
    dataDir: dir,
    emit: (type, data, visibility) => {
      events.push({
        seq: events.length + 1,
        ts: new Date(nowMs).toISOString(),
        type,
        data,
        visibility,
      } as unknown as AppEvent);
    },
    now: () => new Date(nowMs),
    fetchImpl,
    ...(options.history !== undefined ? { history: options.history } : {}),
  });

  return {
    dir,
    notifier,
    calls,
    events,
    advance: (ms) => {
      nowMs += ms;
    },
    setStatus: (status) => {
      state.status = status;
    },
    logPath: () => join(dir, ALERT_DIR_NAME, `${DAY}.log`),
    logLines: () => {
      const path = join(dir, ALERT_DIR_NAME, `${DAY}.log`);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(line => line !== '');
    },
  };
}

function budgetAlert(overrides: Partial<AlertInput> = {}): AlertInput {
  return {
    category: 'budget-exhausted',
    level: 'warn',
    title: '预算耗尽（turn 层）',
    body: 'actual=30 limit=30',
    params: { layer: 'turn' },
    ...overrides,
  };
}

// ──────────────────────────────── 文件档 ────────────────────────────────

test('文件档：永远可用，按 UTC 日期分片追加，一条占一行', async (t: TestContext) => {
  const f = setup(t, { webhook: undefined });

  const outcome = await f.notifier.alert(budgetAlert({ body: '第一行\n第二行' }));
  assert.deepEqual(outcome, { ok: true });
  assert.equal(f.calls.length, 0, '未配 webhookUrl 就不出网');

  const lines = f.logLines();
  assert.equal(lines.length, 1);
  const line = lines[0] ?? '';
  assert.ok(line.startsWith('2024-01-01T00:00:00.000Z [warn] fp='));
  assert.ok(line.includes('预算耗尽（turn 层）'));
  assert.ok(line.includes('第一行 ⏎ 第二行'), '换行转义，保证 grep 得到完整一条');

  await f.notifier.alert(budgetAlert({ params: { layer: 'task' } }));
  assert.equal(f.logLines().length, 2, '追加而不是覆盖');
});

test('文件名与指纹：目录取自 dataDir/alarms，指纹是类别+关键参数的哈希', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });
  await f.notifier.alert(budgetAlert());

  assert.equal(f.logPath(), join(f.dir, 'alarms', `${DAY}.log`));
  assert.equal(f.calls[0]?.url, WEBHOOK);
  assert.equal(f.calls[0]?.contentType, 'application/json');
  assert.deepEqual(Object.keys(f.calls[0]?.body ?? {}).sort(), ['body', 'fingerprint', 'level', 'title', 'ts']);
  assert.equal(f.calls[0]?.body['fingerprint'], fingerprintOf('budget-exhausted', { layer: 'turn' }));
  assert.equal(f.calls[0]?.body['level'], 'warn');
  assert.match(f.logLines()[0] ?? '', /fp=[0-9a-f]{16}/u);

  // 参数键序无关：同一个指纹
  assert.equal(
    fingerprintOf('budget-exhausted', { a: 1, b: 'x' }),
    fingerprintOf('budget-exhausted', { b: 'x', a: 1 }),
  );
});

test('未配置 webhookUrl：只有文件档，通道缺失不算失败', async (t: TestContext) => {
  const f = setup(t, { webhook: undefined });
  assert.deepEqual(await f.notifier.alert(budgetAlert()), { ok: true });
  assert.equal(f.calls.length, 0);
  assert.equal(f.logLines().length, 1);
  assert.deepEqual(f.notifier.stats(), { sent: 1, suppressed: 0, failed: 0 });
});

test('Webhook 失败：如实在结局里报原因，文件档仍然写入（人至少能在盘上看到）', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });
  f.setStatus(503);

  const outcome = await f.notifier.alert(budgetAlert());
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? '' : outcome.reason, /HTTP 503/u);
  assert.equal(f.logLines().length, 1, '文件档不受 webhook 失败影响');
  // 送达失败但存档成功：限流窗口照常推进，否则挂掉的 webhook 会在每一拍被重试
  assert.deepEqual(f.notifier.stats(), { sent: 1, suppressed: 0, failed: 0 });
  await f.notifier.alert(budgetAlert());
  assert.equal(f.calls.length, 1, '窗口内不再重试同一个挂掉的端点');
  assert.equal(f.notifier.stats().suppressed, 1);
});

// ──────────────────────────────── 限流（M3-6） ────────────────────────────────

test('限流：同一指纹 10 分钟内 50 次只发出 1 条（不刷屏）', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });

  for (let i = 0; i < 50; i += 1) {
    await f.notifier.alert(budgetAlert());
    f.advance(20_000); // 每次间隔 20 秒，50 次共 16.7 分钟，仍在一个 30 分钟窗口内
  }

  assert.equal(f.calls.length, 1, '只有第一条真正出网');
  assert.equal(f.logLines().length, 1);
  assert.equal(f.events.length, 1, 'alarm/sent 只写一条');
  assert.equal(f.notifier.stats().sent, 1);
  assert.equal(f.notifier.stats().suppressed, 49);
});

test('限流：键是"类别+关键参数"，换参数即换指纹，各自限流', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });

  await f.notifier.alert(budgetAlert({ params: { layer: 'turn' } }));
  await f.notifier.alert(budgetAlert({ params: { layer: 'turn' } }));
  await f.notifier.alert(budgetAlert({ params: { layer: 'task' } }));
  await f.notifier.alert(budgetAlert({ params: { layer: 'daily' } }));

  assert.equal(f.calls.length, 3, 'turn 层压掉一次，task/daily 各自成立');
});

test('限流窗口到期后放行（30 分钟是窗口，不是永久封条）', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });

  await f.notifier.alert(budgetAlert());
  f.advance(29 * MIN_MS);
  await f.notifier.alert(budgetAlert());
  assert.equal(f.calls.length, 1);

  f.advance(2 * MIN_MS); // 距首条 31 分钟
  await f.notifier.alert(budgetAlert());
  assert.equal(f.calls.length, 2);
});

test('限流可关：rateLimitMin = 0 表示每次都发', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK, rateLimitMin: 0 });
  await f.notifier.alert(budgetAlert());
  await f.notifier.alert(budgetAlert());
  assert.equal(f.calls.length, 2);
});

// ──────────────────────────────── 限流跨重启（M3-10） ────────────────────────────────

test('foldAlarms：限流窗口从 alarm/sent 事件折叠（纯函数，不读时钟）', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });
  await f.notifier.alert(budgetAlert());

  const fingerprint = fingerprintOf('budget-exhausted', { layer: 'turn' });
  const windows = foldAlarms(f.events);
  assert.deepEqual([...windows], [[fingerprint, T0]]);
  assert.equal(foldAlarms([]).size, 0);
  assert.equal(foldAlarms([{ ...f.events[0], ts: '不是时间' } as AppEvent]).size, 0, '坏时间戳不产生窗口');
});

test('限流跨重启：重建窗口后，30 分钟内同类告警仍被限流（M3-10）', async (t: TestContext) => {
  const first = setup(t, { webhook: WEBHOOK });
  await first.notifier.alert(budgetAlert());
  assert.equal(first.calls.length, 1);

  // 重启：新进程，盘上只有刚写下的 alarm/sent 事件
  const restarted = setup(t, { webhook: WEBHOOK, history: first.events });
  await restarted.notifier.alert(budgetAlert());
  assert.equal(restarted.calls.length, 0, '重启不会让坏接口重新刷屏');
  assert.equal(restarted.notifier.stats().suppressed, 1);

  restarted.advance(31 * MIN_MS);
  await restarted.notifier.alert(budgetAlert());
  assert.equal(restarted.calls.length, 1, '窗口过期后放行');
});

test('AlarmIndex：事件驱动的窗口索引，可判定"窗口内已发过"', () => {
  const index = new AlarmIndex();
  const event = {
    seq: 1,
    ts: new Date(T0).toISOString(),
    type: 'alarm/sent',
    data: { fingerprint: 'fp1', level: 'warn', title: 't' },
    visibility: 'internal',
  } as unknown as AppEvent;

  index.apply(event);
  index.merge([{ ...event, seq: 2, ts: new Date(T0 + 5 * MIN_MS).toISOString() } as AppEvent]);
  assert.equal(index.suppressed('fp1', T0 + 10 * MIN_MS, 30 * MIN_MS), true);
  assert.equal(index.suppressed('fp1', T0 + 36 * MIN_MS, 30 * MIN_MS), false, '以上次发出为准算 30 分钟');
  assert.equal(index.suppressed('fp2', T0, 30 * MIN_MS), false);
  assert.deepEqual([...index.entries()], [['fp1', T0 + 5 * MIN_MS]], '同一指纹取最晚一次');
});

// ──────────────────────────────── stall 恢复通知（M3-7） ────────────────────────────────

test('stall：故障期间只发一条，恢复时发"已恢复"，再报不再刷屏', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });
  const failure: AlertInput = {
    category: 'model-failure',
    level: 'critical',
    title: '模型连续失败达到阈值',
    body: '连续 5 次',
  };

  await f.notifier.fail(failure);
  await f.notifier.fail(failure);
  await f.notifier.fail(failure);
  assert.equal(f.calls.length, 1, '同一串故障只发一条（限流是第二道保险）');
  assert.equal(f.notifier.stats().suppressed, 2);

  const recovered = await f.notifier.ok('model-failure');
  assert.deepEqual(recovered, { ok: true });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]?.body['level'], 'info');
  assert.match(String(f.calls[1]?.body['title']), /已恢复：model-failure/u);
  assert.match(String(f.calls[1]?.body['body']), /连续 3 次/u);

  // 已经恢复过了：再报不算故障，不发通知
  assert.deepEqual(await f.notifier.ok('model-failure'), { ok: true });
  assert.equal(f.calls.length, 2);
});

test('stall：恢复通知不被故障那 30 分钟窗口连坐（指纹独立）', async (t: TestContext) => {
  const f = setup(t, { webhook: WEBHOOK });
  const failure: AlertInput = {
    category: 'stall', level: 'warn', title: '水位停滞', body: '11 分钟没有成功调用',
  };

  await f.notifier.fail(failure);
  f.advance(MIN_MS);
  await f.notifier.ok('stall');

  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0]?.body['fingerprint'], f.calls[1]?.body['fingerprint']);
});

test('恢复通知也会落文件档（通道一致性）', async (t: TestContext) => {
  const f = setup(t, { webhook: undefined });
  await f.notifier.fail({ category: 'stall', level: 'warn', title: '水位停滞', body: 'x' });
  await f.notifier.ok('stall');
  const lines = f.logLines();
  assert.equal(lines.length, 2);
  assert.ok((lines[1] ?? '').includes('[info]'));
  assert.ok((lines[1] ?? '').includes('已恢复：stall'));
});

// ──────────────────────────────── 宿主形状（Notifier 类） ────────────────────────────────

test('Notifier 类：send/recover 形状与 admin 兼容的 send(message) 共存', async (t: TestContext) => {
  const dir = tempDirSync('irmia-alert-core-');
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response('{}', { status: 200 });
  };
  const records: AlertRecord[] = [];
  let nowMs = T0;
  const core = new Notifier({
    alertDir: join(dir, ALERT_DIR_NAME),
    rateLimitMin: 30,
    now: () => new Date(nowMs),
    record: (record) => {
      records.push(record);
    },
    webhookUrl: WEBHOOK,
    fetchImpl,
  });

  const delivery = await core.send('warn', '水位停滞', '有输入但没被处理');
  assert.equal(delivery.sent, true);
  assert.match(delivery.fingerprint, /^[0-9a-f]{16}$/u);
  assert.ok(delivery.file.endsWith(`${DAY}.log`));
  // 故障键进事件（2026-10-03）：进程重启后 `foldStalls` 靠它把"还没恢复的故障"重建回来，
  // 否则一条已经报出去的故障永远配不上它的"已恢复"
  assert.deepEqual(records, [{
    fingerprint: delivery.fingerprint,
    level: 'warn',
    title: '水位停滞',
    key: 'alert:水位停滞',
  }]);

  const suppressed = await core.send('warn', '水位停滞', 'again');
  assert.equal(suppressed.sent, false);
  assert.equal(suppressed.reason, RATE_LIMITED);

  const recovered = await core.recover({ level: 'warn', title: '水位停滞' }, '模型调用已恢复');
  assert.ok(recovered !== null);
  assert.equal(recovered.sent, true);
  assert.equal(await core.recover({ level: 'warn', title: '水位停滞' }, 'again'), null);

  assert.deepEqual(core.stats(), { sent: 2, suppressed: 1, failed: 0 });

  // 同一实例也能当 admin 的 Notifier 用（notify 工具的第二路）
  nowMs += 31 * 60_000;
  const notify = await core.sendMessage({ level: 'info', title: '备份已完成', body: '共 3 个文件' });
  assert.deepEqual(notify, { ok: true });
  assert.equal(calls.length, 3);
});

test('Notifier 类：history 索引把限流窗口带过重启', async (t: TestContext) => {
  const dir = tempDirSync('irmia-alert-history-');
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const index = new AlarmIndex();
  const fingerprint = fingerprintOf('alert', { title: '预算耗尽' });
  index.apply({
    seq: 1,
    ts: new Date(T0).toISOString(),
    type: 'alarm/sent',
    data: { fingerprint, level: 'critical', title: '预算耗尽' },
    visibility: 'internal',
  } as unknown as AppEvent);

  const calls: string[] = [];
  const core = new Notifier({
    alertDir: join(dir, ALERT_DIR_NAME),
    rateLimitMin: 30,
    now: () => new Date(T0 + 5 * MIN_MS),
    history: index,
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response('{}', { status: 200 });
    },
    webhookUrl: WEBHOOK,
  });

  const delivery = await core.send('critical', '预算耗尽', 'already sent before restart');
  assert.equal(delivery.sent, false);
  assert.equal(delivery.reason, RATE_LIMITED);
  assert.equal(calls.length, 0);
});
