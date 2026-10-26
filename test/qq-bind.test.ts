/**
 * 「扫码创建 QQ 官方 Bot」的协议层与状态机（src/channel/qq-bind.ts）。
 *
 * 这一份用例只碰**纯逻辑**（不建 HTTP 服务、不打外网）：
 *
 *   ① **解密布局**：`base64(12B nonce | 密文 | 16B tag)`、AES-256-GCM、key = 我们自己那 32 字节。
 *      用自造向量（自己加密再解密）钉住 nonce/tag 的位置；错 key / 改过密文 / 坏 base64
 *      一律回**中文**「解密失败」，不把 OpenSSL 的话甩给界面。
 *   ② **一轮扫码的状态机**：`flaky`（0→0→2 成功）、`expired`（3 → 自动重建一次 → 再 3 就 expired）、
 *      总超时、`cancel()` 释放定时器。
 *   ③ **节奏**：2 秒一次、总超时 3 分钟这些常量与"过期自动重建一次"的口径（与官方 SDK 同档）。
 *
 * 端点上那一层（鉴权、落盘、不回显）在 `test/qq-bind-api.test.ts` 单独立案。
 */

import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  QQ_BIND_NONCE_BYTES,
  QQ_BIND_POLL_INTERVAL_MS,
  QQ_BIND_STATUS_EXPIRED,
  QQ_BIND_STATUS_PENDING,
  QQ_BIND_STATUS_SUCCESS,
  QQ_BIND_TAG_BYTES,
  QQ_BIND_TIMEOUT_MS,
  QqBindSession,
  bindUrlOf,
  createBindTask,
  decryptBindSecret,
  pollBindResult,
  type QqBindHttp,
  type QqBindHttpRequest,
  type QqBindScheduler,
  type QqBindSettled,
} from '../src/channel/qq-bind.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

/** 自造向量：按官方布局 `nonce | 密文 | tag` 加密一段明文（key 是 base64 的 32 字节） */
function encryptSecret(plain: string, keyB64: string): string {
  const nonce = randomBytes(QQ_BIND_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), nonce, {
    authTagLength: QQ_BIND_TAG_BYTES,
  });
  const body = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

/** 手动调度器：定时器不进事件循环，用例自己决定"什么时候响" */
class ManualScheduler implements QqBindScheduler {
  intervals: Array<{ fn: () => void; ms: number }> = [];
  timeouts: Array<{ fn: () => void; ms: number }> = [];

  setInterval(fn: () => void, ms: number): unknown {
    const handle = { fn, ms };
    this.intervals.push(handle);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.intervals = this.intervals.filter((item) => item !== handle);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = { fn, ms };
    this.timeouts.push(handle);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts = this.timeouts.filter((item) => item !== handle);
  }

  /** 点燃当前那个总超时（模拟"3 分钟到了"） */
  fireDeadline(): void {
    this.timeouts[0]?.fn();
  }
}

/** 伪 QQ：建任务 / 查结果 / 换 token 三个端点各按脚本回答，并把请求原样记下来 */
class FakeQq {
  readonly requests: QqBindHttpRequest[] = [];
  /** 每次 create_bind_task 收到的 key（base64），用来加密 bot_encrypt_secret */
  readonly keys: string[] = [];
  /** 轮询脚本：一次 poll_bind_result 消耗一个；用完之后一直重复最后一个 */
  statuses: number[] = [];
  /** 换 token 的响应（`null` = 传输层直接失败） */
  tokenBody: Record<string, unknown> | null = { access_token: 'fake-token', expires_in: 7200 };
  createCount = 0;
  pollCount = 0;
  tokenCount = 0;

  http: QqBindHttp = async (request) => {
    this.requests.push(request);
    if (request.url.includes('create_bind_task')) {
      this.createCount += 1;
      const key = (request.jsonBody as { key?: string }).key ?? '';
      this.keys.push(key);
      return { status: 200, text: '', body: { data: { task_id: `T${this.createCount}` } } };
    }
    if (request.url.includes('poll_bind_result')) {
      const index = Math.min(this.pollCount, Math.max(0, this.statuses.length - 1));
      const status = this.statuses[index] ?? QQ_BIND_STATUS_PENDING;
      this.pollCount += 1;
      const key = this.keys[this.keys.length - 1] ?? '';
      return {
        status: 200,
        text: '',
        body: {
          data: {
            status,
            ...(status === QQ_BIND_STATUS_SUCCESS
              ? {
                bot_appid: '10240001',
                bot_encrypt_secret: encryptSecret('fake-secret-1', key),
                user_openid: 'user-openid-1',
              }
              : {}),
          },
        },
      };
    }
    if (request.url.includes('getAppAccessToken')) {
      this.tokenCount += 1;
      if (this.tokenBody === null) throw new Error('连不上 QQ 的接口（fake）：ECONNREFUSED');
      return { status: 200, text: '', body: this.tokenBody };
    }
    throw new Error(`fake 不认识这个地址：${request.url}`);
  };
}

// ──────────────────────────────── ① 解密 ────────────────────────────────

test('解密：自造向量（nonce 12B + 密文 + tag 16B）解回原文，且换一把 key 就失败', () => {
  const key = randomBytes(32).toString('base64');
  const secret = 'CLIENT-SECRET-0123456789abcdef';
  const encrypted = encryptSecret(secret, key);
  assert.equal(decryptBindSecret(encrypted, key), secret);

  const otherKey = randomBytes(32).toString('base64');
  assert.throws(
    () => decryptBindSecret(encrypted, otherKey),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /解密失败/u, '错 key 要回中文的「解密失败」');
      assert.doesNotMatch(err.message, /Unsupported|unable to authenticate/u, '不把 OpenSSL 原文交给界面');
      return true;
    },
  );
});

test('解密：布局是「tag 在尾巴」——把 tag 挪到头部就解不开（钉住 12/16 的位置）', () => {
  const keyB64 = randomBytes(32).toString('base64');
  const key = Buffer.from(keyB64, 'base64');
  const secret = 'layout-vector';
  const nonce = randomBytes(QQ_BIND_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: QQ_BIND_TAG_BYTES });
  const body = Buffer.concat([cipher.update(Buffer.from(secret, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 官方布局：nonce | 密文 | tag
  assert.equal(decryptBindSecret(Buffer.concat([nonce, body, tag]).toString('base64'), keyB64), secret);
  // 错布局：nonce | tag | 密文（这是最容易写错的一种）
  assert.throws(
    () => decryptBindSecret(Buffer.concat([nonce, tag, body]).toString('base64'), keyB64),
    /解密失败/u,
  );
});

test('解密：密文被改一个字节 / base64 坏掉 / 密钥不是 32 字节 —— 都是中文「解密失败」', () => {
  const keyB64 = randomBytes(32).toString('base64');
  const encrypted = Buffer.from(encryptSecret('tamper-me', keyB64), 'base64');
  const tampered = Buffer.from(encrypted);
  // 动密文中间那一段（不是 nonce、不是 tag）
  tampered[QQ_BIND_NONCE_BYTES + 1] = (tampered[QQ_BIND_NONCE_BYTES + 1] ?? 0) ^ 0xff;
  assert.throws(() => decryptBindSecret(tampered.toString('base64'), keyB64), /解密失败/u);

  assert.throws(() => decryptBindSecret('***not-base64***', keyB64), /解密失败/u);
  assert.throws(() => decryptBindSecret(encrypted.toString('base64'), randomBytes(16).toString('base64')), /32 字节/u);
  assert.throws(() => decryptBindSecret('', keyB64), /解密失败/u);
});

// ──────────────────────────────── ② 三步协议 ────────────────────────────────

test('建任务：请求体是 base64 的 32 字节 key；响应缺 data.task_id ⇒ 中文人话', async () => {
  const fake = new FakeQq();
  const task = await createBindTask(fake.http);
  assert.equal(task.taskId, 'T1');
  assert.equal(Buffer.from(task.keyB64, 'base64').length, 32, 'key 是 32 随机字节（AES-256）');
  assert.deepEqual(fake.requests[0]?.jsonBody, { key: task.keyB64 }, '第 1 步的 body 只有 key');

  const bad: QqBindHttp = async () => ({ status: 200, text: '', body: { data: {} } });
  await assert.rejects(() => createBindTask(bad), /看不懂的响应/u);
});

test('查结果：status 缺了是「看不懂」，网络失败原样带出中文原因', async () => {
  const bad: QqBindHttp = async () => ({ status: 200, text: '', body: { data: { bot_appid: 'x' } } });
  await assert.rejects(() => pollBindResult('T1', bad), /看不懂的响应/u);

  const offline: QqBindHttp = async () => {
    throw new Error('连不上 QQ 的接口（fake）：ECONNREFUSED');
  };
  await assert.rejects(() => pollBindResult('T1', offline), /连不上 QQ 的接口/u);
});

test('二维码地址：task_id + source=irmia + _wv=2（形状由官方页面自己认）', () => {
  assert.equal(
    bindUrlOf('TASK-1'),
    'https://q.qq.com/qqbot/openclaw/connect.html?task_id=TASK-1&source=irmia&_wv=2',
  );
  // source 可换（平台名只是展示），taskId 要 URL 编码
  const url = new URL(bindUrlOf('a b&c', 'my platform'));
  assert.equal(url.searchParams.get('task_id'), 'a b&c');
  assert.equal(url.searchParams.get('source'), 'my platform');
  assert.equal(url.searchParams.get('_wv'), '2');
  assert.throws(() => bindUrlOf('  '), /task_id 是空的/u);
});

test('节奏常量：2 秒一次、总超时 3 分钟（与官方 SDK 同档）', () => {
  assert.equal(QQ_BIND_POLL_INTERVAL_MS, 2000);
  assert.equal(QQ_BIND_TIMEOUT_MS, 180_000);
});

// ──────────────────────────────── ③ 会话状态机 ────────────────────────────────

test('flaky（0 → 0 → 2）：先是 pending，成功那一刻解出 AppID/Secret 并交给落盘回调', async () => {
  const fake = new FakeQq();
  fake.statuses = [QQ_BIND_STATUS_PENDING, QQ_BIND_STATUS_PENDING, QQ_BIND_STATUS_SUCCESS];
  const settled: Array<{ appId: string; clientSecret: string }> = [];
  const onSettled = async (input: { appId: string; clientSecret: string }): Promise<QqBindSettled> => {
    settled.push(input);
    return { saved: true, enabled: true, connection: { ok: true, expiresIn: 7200 } };
  };
  const session = new QqBindSession({
    http: fake.http,
    pollIntervalMs: 0, // 完全由 poll() 驱动（用例不靠真定时器）
    timeoutMs: QQ_BIND_TIMEOUT_MS,
    scheduler: new ManualScheduler(),
    onSettled,
  });

  const started = await session.start();
  assert.equal(started.taskId, 'T1');
  assert.equal(started.url, bindUrlOf('T1'));

  assert.equal((await session.poll()).status, 'pending');
  assert.equal((await session.poll()).status, 'pending');
  const view = await session.poll();
  assert.equal(view.status, 'success');
  assert.equal(view.appId, '10240001');
  assert.equal(view.saved, true);
  assert.equal(view.enabled, true);
  assert.deepEqual(view.connection, { ok: true, expiresIn: 7200 });
  assert.deepEqual(settled, [{ appId: '10240001', clientSecret: 'fake-secret-1' }]);
  assert.equal(fake.createCount, 1, '成功之后不再重建任务');

  // 成功是终态：再 poll 不再打网络（结果不会"回退"成 pending）
  const before = fake.pollCount;
  assert.equal((await session.poll()).status, 'success');
  assert.equal(fake.pollCount, before);
  session.cancel();
});

test('expired（3 → 自动重建一次 → 再 3 ⇒ expired）', async () => {
  const fake = new FakeQq();
  fake.statuses = [QQ_BIND_STATUS_EXPIRED, QQ_BIND_STATUS_EXPIRED];
  const lines: string[] = [];
  const session = new QqBindSession({
    http: fake.http,
    pollIntervalMs: 0,
    scheduler: new ManualScheduler(),
    onError: (line) => lines.push(line),
  });

  const first = await session.start();
  const rebuilt = await session.poll();
  assert.equal(rebuilt.status, 'pending', '第一次过期不结束：自动重建一次（像官方 SDK）');
  assert.equal(rebuilt.taskId, 'T2', '重建之后是一个新任务');
  assert.notEqual(rebuilt.url, first.url, '新任务的二维码地址不一样');
  assert.equal(fake.createCount, 2);
  assert.ok(lines.some((line) => line.includes('自动重建')), '重建这件事要留一行痕');

  const expired = await session.poll();
  assert.equal(expired.status, 'expired');
  assert.match(expired.reason ?? '', /过期/u);
  assert.equal(fake.createCount, 2, '只重建一次，不无限重建');
  assert.equal(fake.pollCount, 2);
  session.cancel();
});

test('超时：等够 3 分钟 ⇒ expired（两条路：poll 里判、总超时定时器到点）', async () => {
  let nowMs = 1_000;
  const fake = new FakeQq();
  fake.statuses = [QQ_BIND_STATUS_PENDING];
  const scheduler = new ManualScheduler();
  const session = new QqBindSession({
    http: fake.http,
    pollIntervalMs: 0,
    timeoutMs: 3_000,
    now: () => nowMs,
    scheduler,
  });
  await session.start();
  assert.equal((await session.poll()).status, 'pending');
  nowMs += 3_001;
  const expired = await session.poll();
  assert.equal(expired.status, 'expired');
  assert.match(expired.reason ?? '', /等待超时/u);

  // 另一条路：后台那个总超时定时器到点（界面完全没来 poll 也要结束）
  const second = new QqBindSession({
    http: fake.http,
    pollIntervalMs: 0,
    timeoutMs: 3_000,
    now: () => nowMs,
    scheduler,
  });
  await second.start();
  scheduler.fireDeadline();
  assert.equal(second.snapshot().status, 'expired');
  assert.match(second.snapshot().reason ?? '', /等待超时/u);
});

test('节奏：界面轮询与后台定时器合流，最多每 2 秒一次网络请求', async () => {
  let nowMs = 0;
  const fake = new FakeQq();
  fake.statuses = [QQ_BIND_STATUS_PENDING];
  const scheduler = new ManualScheduler();
  const session = new QqBindSession({
    http: fake.http,
    pollIntervalMs: QQ_BIND_POLL_INTERVAL_MS,
    timeoutMs: QQ_BIND_TIMEOUT_MS,
    now: () => nowMs,
    scheduler,
  });
  await session.start();

  // 后台定时器那一拍：到 2 秒才该查
  nowMs = QQ_BIND_POLL_INTERVAL_MS;
  scheduler.intervals[0]?.fn();
  await session.poll(); // 有在飞的就等它，不会另起一拍
  assert.equal(fake.pollCount, 1, '后台那一拍查了一次');

  // 界面紧接着又点了一下（同一秒内）：不该再打一次
  nowMs += 1;
  await session.poll();
  assert.equal(fake.pollCount, 1, '同一拍里界面再问一次也不重复打网络');

  // 过了 2 秒，界面这一问才真的查一次
  nowMs += QQ_BIND_POLL_INTERVAL_MS;
  await session.poll();
  assert.equal(fake.pollCount, 2);
  session.cancel();
});

test('cancel()：释放两个定时器，之后 poll 不再发任何请求', async () => {
  const fake = new FakeQq();
  fake.statuses = [QQ_BIND_STATUS_PENDING];
  const scheduler = new ManualScheduler();
  const session = new QqBindSession({
    http: fake.http,
    pollIntervalMs: QQ_BIND_POLL_INTERVAL_MS,
    timeoutMs: QQ_BIND_TIMEOUT_MS,
    scheduler,
  });
  await session.start();
  assert.equal(scheduler.intervals.length, 1, '起来之后有一个轮询定时器');
  assert.equal(scheduler.timeouts.length, 1, '还有一个总超时定时器');

  session.cancel();
  assert.equal(scheduler.intervals.length, 0);
  assert.equal(scheduler.timeouts.length, 0);

  const before = fake.pollCount;
  const view = await session.poll();
  assert.equal(view.status, 'pending', '取消不是失败：状态停在原处，界面可以重新发起');
  assert.equal(fake.pollCount, before, '取消之后一个请求都不发');
});

test('落盘回调抛错：绑定仍是 success，但回执如实说"没保存"（不假装写好了）', async () => {
  const fake = new FakeQq();
  fake.statuses = [QQ_BIND_STATUS_SUCCESS];
  const session = new QqBindSession({
    http: fake.http,
    pollIntervalMs: 0,
    scheduler: new ManualScheduler(),
    onSettled: async () => {
      throw new Error('磁盘满了');
    },
  });
  await session.start();
  const view = await session.poll();
  assert.equal(view.status, 'success');
  assert.equal(view.saved, false);
  assert.match(view.error ?? '', /没写进去/u);
  assert.match(view.error ?? '', /磁盘满了/u);
  session.cancel();
});
