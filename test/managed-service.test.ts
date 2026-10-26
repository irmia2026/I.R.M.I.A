/**
 * 内置协议端服务测试 —— src/services/snowluma.ts
 *
 * 这一层的价值全在"框架能不能自己把它拉起来并对上接口"上，所以测试也照这条线走：
 *   • `readEndpointFromConfig` 是纯函数，坏配置的每一种形状都该返回 null（**绝不猜端口**：
 *     猜错会连到别的本地服务上，比连不上更难查）
 *   • 端到端那条**真的 spawn 一个假协议端**（一个开 TCP 端口 + 写自己配置的小脚本），
 *     走完 拉起 → 探端口 → 读配置 → ready → stop 的全程
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WEBUI_URL, ManagedProtocolService, SecretRedactor, canConnect, discoverWebuiListener,
  maskCredential, parseCredentialLine, parseNetstatListenLine, readConsentInfo, readCredentialFromLogFile,
  readEndpointFromConfig, readOnebotConfigInfo, resolveServiceDir, type WebuiListenerInfo,
} from '../src/services/snowluma.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const roots: string[] = [];
test.after(() => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

function tempDir(): string {
  const dir = tempDirSync('irmia-svc-');
  roots.push(dir);
  return dir;
}

/** 写一份协议端配置（形状照 SnowLuma 的 config/onebot.json） */
function writeConfig(dir: string, body: unknown): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'onebot.json'), JSON.stringify(body), 'utf8');
}

/** 写一份**按账号的快照**（`onebot_<uin>.json`——真实首跑时它落的是这一份） */
function writeNamedConfig(dir: string, name: string, body: unknown): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', name), JSON.stringify(body), 'utf8');
}

function configWith(server: unknown): unknown {
  return { networks: { httpServers: [], httpClients: [], wsServers: [server], wsClients: [] } };
}

test('读配置：正常那份能取出 wsUrl 与 access_token', () => {
  const dir = tempDir();
  writeConfig(dir, configWith({ name: 'ws-default', host: '127.0.0.1', port: 3001, path: '/', accessToken: 'sekret' }));
  assert.deepEqual(readEndpointFromConfig(dir), { wsUrl: 'ws://127.0.0.1:3001/', accessToken: 'sekret' });
});

test('读配置：坏形状一律 null —— 绝不猜一个端口出来', () => {
  const cases: Array<[string, unknown]> = [
    ['还没有那份文件（第一次跑之前）', undefined],
    ['JSON 坏了', '{ not json'],
    ['没有 networks', { other: 1 }],
    ['wsServers 是空的', configWith(undefined)],
    ['wsServers 不是数组', { networks: { wsServers: 'nope' } }],
    ['端口不是数字', configWith({ host: '127.0.0.1', port: 'abc' })],
    ['端口越界', configWith({ host: '127.0.0.1', port: 99999 })],
  ];
  for (const [why, body] of cases) {
    const dir = tempDir();
    if (body !== undefined) {
      if (typeof body === 'string') {
        mkdirSync(join(dir, 'config'), { recursive: true });
        writeFileSync(join(dir, 'config', 'onebot.json'), body, 'utf8');
      } else {
        writeConfig(dir, body);
      }
    }
    assert.equal(readEndpointFromConfig(dir), null, why);
  }
});

test('读配置：缺 host / path 时用安全默认，token 缺了给空串（协议端可能没开校验）', () => {
  const dir = tempDir();
  writeConfig(dir, configWith({ port: 3001 }));
  assert.deepEqual(readEndpointFromConfig(dir), { wsUrl: 'ws://127.0.0.1:3001/', accessToken: '' });
});

test('canConnect：有人听就 true，没人听就 false（不握手，只探端口）', async () => {
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await canConnect(`ws://127.0.0.1:${port}/`), true);
    assert.equal(await canConnect('ws://127.0.0.1:1/'), false);
    assert.equal(await canConnect('不是个 url'), false);
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); });
  }
});

test('服务：目录里没有入口 → not-installed，并且说清该怎么办', async () => {
  const dir = tempDir();
  // 注入"没有别的实例在跑"：不注入的话本机上真跑着的协议端会被（正确地）认出来，
  // 于是这条用例测的就不是"没装"这条分支了
  const svc = new ManagedProtocolService({ dir, discover: () => null });
  const status = await svc.start();
  assert.equal(status.state, 'not-installed');
  assert.match(status.detail, /下载/);
});

test('服务：端到端——拉起假协议端 → 探到端口 → 读出配置 → ready → 停掉', async () => {
  const dir = tempDir();
  // 一个"假协议端"：开一个 TCP 端口，并把自己的 OneBot 配置写到 config/onebot.json
  const fake = `
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const port = Number(process.env.FAKE_PORT ?? '0');
const server = createServer();
server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port;
  mkdirSync(join(process.cwd(), 'config'), { recursive: true });
  writeFileSync(join(process.cwd(), 'config', 'onebot.json'), JSON.stringify({
    networks: { wsServers: [{ name: 'ws-default', host: '127.0.0.1', port: actual, path: '/', accessToken: 'tok-from-config' }] },
  }));
  console.log('fake protocol side ready on ' + actual);
  // 照真实现的样子把监听那一行与初始凭据打出来（它只往 stdout 打）：
  // 这条用例因此顺带验了第 2 步的捕获——服务层要能把这两行认出来
  console.log('[WebUI] listening http://127.0.0.1:15099');
  console.log('[WebUI] initial credentials: user=admin password=fake-bootstrap-9f3a');
});
setInterval(() => {}, 1000);
`;
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.mjs'), fake, 'utf8');

  const logs: string[] = [];
  const svc = new ManagedProtocolService({
    dir,
    readyTimeoutMs: 15_000,
    onLog: (line) => logs.push(line),
    // **必须注入"没有别的实例在跑"**：不注入的话这条用例会走默认的端口表探测，
    // 而开发机上真有一个 SnowLuma 在跑时，它会（正确地）认为"已经在跑了"从而拒绝 spawn——
    // 单测因此变成"看那台机器上装了什么"，那不是这条用例要验的事。
    discover: () => null,
    /**
     * **探活也必须注入**（2026-10-07 补）：默认那条探活是真 TCP，而它的兜底地址是写死的
     * `ws://127.0.0.1:3001`——开发机上真有一个协议端听着 3001 时，第一拍（假协议端还没把配置
     * 写下来）就会被它骗过去：`waitReady` 于是返回**那个空 token 的兜底 probe**，
     * 与 `discover` 不注入时是同一个病（"看这台机器上装了什么"）。
     * 这里注入的判据与生产要求一致：**探活要确认"那个端口后面是本服务自己的实例"**，
     * 而"它自己那份配置里写着这个端点"就是它的身份凭据。
     */
    probe: async (wsUrl) => readEndpointFromConfig(dir)?.wsUrl === wsUrl,
  });
  const status = await svc.start();
  try {
    assert.equal(status.state, 'ready', `拉起失败：${status.detail}\n日志：${logs.join('\n')}`);
    assert.equal(status.endpoint?.accessToken, 'tok-from-config', '对接点必须来自它自己的配置');
    assert.notEqual(status.endpoint?.accessToken, '', '空 token 的兜底 probe 不许被当成 endpoint');
    assert.match(String(status.endpoint?.wsUrl), /^ws:\/\/127\.0\.0\.1:\d+\/$/u);
    // WebUI 地址取**它自己报的那个端口**（不是写死的 5099）：它会退让，退让后 5099 打不开
    assert.equal(status.webuiUrl, 'http://127.0.0.1:15099');
    assert.ok(status.pid !== undefined && status.pid > 0);
    // 三档也要跟着对：spawn 出来的那个进程 = 第一档 running，托管方式 spawned
    assert.equal(status.report.process.running, true);
    assert.equal(status.report.process.managed, 'spawned');
    assert.equal(status.report.onebotConfig.present, true, '假协议端把配置写出来了');
    // 第 2 步的捕获：stdout 里那一行要认出来，且**不许**跟着留痕走
    assert.equal(status.report.webui.credential.source, 'stdout');
    assert.equal(status.report.webui.credential.user, 'admin');
    assert.equal(status.report.webui.credential.password, 'fake-bootstrap-9f3a');
    assert.equal(logs.some((line) => line.includes('fake-bootstrap-9f3a')), false,
      `口令不许跟着留痕走，日志里却被写进去了：${logs.join(' / ')}`);
    assert.equal(logs.some((line) => line.includes('initial credentials') && line.includes('***')), true,
      '那一行本身要留着（留痕归留痕），只是口令换成 ***');
  } finally {
    await svc.stop();
  }
  assert.equal((await svc.status()).state, 'stopped');
});

test('服务目录：相对路径按给定基准解，绝对路径原样', () => {
  assert.equal(resolveServiceDir('D:/SnowLuma', 'C:/base'), 'D:/SnowLuma');
  assert.equal(resolveServiceDir('vendor/snowluma', 'C:/base'), join('C:/base', 'vendor/snowluma'));
});

// ────────────────────────── 三档状态（v36，第 1 步的核心） ──────────────────────────

/**
 * 那一档真正要治的病：**进程活着、OneBot 配置缺失**。
 *
 * 旧状态机只有一枚 `state`，于是它只能报"启动失败"——而被人看到的是一句和事实相反的话
 * （进程明明在跑）。这条用例锁的就是"这两件事必须分成两句说"。
 */
test('三档①：进程在跑而 OneBot 配置缺失 ⇒ 绝不报"启动失败"，要说清"没登录"', async () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'config'), { recursive: true });
  // 只有 WebUI 的那两份文件——正是实测现场的样子（没有 config/onebot*.json）
  writeFileSync(join(dir, 'config', 'runtime.json'), JSON.stringify({ webuiPort: 5099 }), 'utf8');
  writeFileSync(join(dir, 'config', 'webui.json'), JSON.stringify({ mustChangePassword: true }), 'utf8');
  writeFileSync(join(dir, 'index.mjs'), '// 假入口：只要它在，探测就认得出该去比什么\n', 'utf8');

  const svc = new ManagedProtocolService({
    dir,
    // 注入探测：单测绝不去查真机的端口表
    discover: (): WebuiListenerInfo => ({ pid: 34552, port: 5099, host: '127.0.0.1', startedAt: '2026-10-07T01:26:38.000Z' }),
    readConsoleCredential: () => null,
  });

  const status = await svc.status();
  const report = status.report;

  // ① 进程档：在跑，且如实说是"反查到的"（不是本次进程起的）
  assert.equal(report.process.running, true);
  assert.equal(report.process.pid, 34552);
  assert.equal(report.process.managed, 'discovered', '本次进程没起它，就必须这么说');
  assert.equal(report.process.startedAt, '2026-10-07T01:26:38.000Z');
  assert.equal(report.process.webuiUrl, 'http://127.0.0.1:5099');

  // ② 配置档：不在 ⇒ 这一档就是"没登录过 QQ"
  assert.equal(report.onebotConfig.present, false);
  assert.equal(report.onebotConfig.endpoint, undefined);
  assert.equal(report.onebotConfig.unreadable, undefined, '文件压根不在，不是"读不出"');

  // ③ WebUI 档：门都还没过，面板开着但没有口令可给
  assert.equal(report.webui.open, true, '进程在跑就意味着面板能打开');
  assert.equal(report.webui.url, 'http://127.0.0.1:5099');
  assert.equal(report.webui.mustChangePassword, true);
  assert.equal(report.webui.consentRecorded, false);
  assert.equal(report.webui.credential.source, 'none');
  assert.equal(report.webui.credential.password, undefined);

  // 面板地址必须给出去：旧口径"只有 ready/starting 才给"会让人连登录都做不到
  assert.equal(status.webuiUrl, 'http://127.0.0.1:5099');
});

test('三档①：端口退让到 5100 时，界面显示的是 5100（从监听端口反查出来的那个）', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.mjs'), '// 假入口\n', 'utf8');
  const svc = new ManagedProtocolService({
    dir,
    discover: () => ({ pid: 4242, port: 5100, host: '127.0.0.1' }),
    readConsoleCredential: () => null,
  });
  const report = (await svc.status()).report;
  assert.equal(report.process.running, true);
  assert.equal(report.process.webuiUrl, 'http://127.0.0.1:5100', '实际监听在 5100，就不许显示 5099');
  assert.equal(report.webui.url, 'http://127.0.0.1:5100');
  assert.notEqual((await svc.status()).webuiUrl, DEFAULT_WEBUI_URL, '退让之后默认那个地址是打不开的');
});

test('三档①：探测说没有进程 ⇒ 三档一致地报"没在跑"，不给任何 pid', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.mjs'), '// 假入口\n', 'utf8');
  const svc = new ManagedProtocolService({ dir, discover: () => null, readConsoleCredential: () => null });
  const report = (await svc.status()).report;
  assert.equal(report.process.running, false);
  assert.equal(report.process.pid, undefined);
  assert.equal(report.process.managed, undefined);
  assert.equal(report.webui.open, false);
  assert.equal(report.webui.url, undefined, '没在跑就不给一个点不开的地址');
  assert.equal((await svc.status()).webuiUrl, undefined);
});

test('三档②：配置在盘上但读不出端点 ⇒ 报 unreadable，绝不说成"没有配置"', () => {
  const dir = tempDir();
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'onebot_10001.json'), '{ 坏掉的 json', 'utf8');
  const info = readOnebotConfigInfo(dir);
  assert.equal(info.present, false);
  assert.equal(info.unreadable, true, '人看得见那个文件，就不能说"配置缺失"');
  assert.match(String(info.path), /onebot_10001\.json$/u);
});

test('三档②：按账号快照（真实首跑那份）也算"配置在"，并指出是哪一份文件', () => {
  const dir = tempDir();
  writeNamedConfig(dir, 'onebot_10001.json', {
    networks: { wsServers: [{ host: '127.0.0.1', port: 3001, path: '/', accessToken: 'snap-token' }] },
  });
  const info = readOnebotConfigInfo(dir);
  assert.equal(info.present, true);
  assert.equal(info.endpoint?.wsUrl, 'ws://127.0.0.1:3001/');
  assert.match(String(info.path), /onebot_10001\.json$/u);
});

test('三档③：两个门的状态各自从它自己的落盘文件读，读盘不联网', () => {
  const dir = tempDir();
  assert.deepEqual(readConsentInfo(dir), { consentRecorded: false, mustChangePassword: false });
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'consent.json'), JSON.stringify({ version: 'x', acceptedAt: 'now' }), 'utf8');
  writeFileSync(join(dir, 'config', 'webui.json'), JSON.stringify({ mustChangePassword: false }), 'utf8');
  assert.deepEqual(readConsentInfo(dir), { consentRecorded: true, mustChangePassword: false });
  writeFileSync(join(dir, 'config', 'webui.json'), JSON.stringify({ mustChangePassword: true }), 'utf8');
  assert.equal(readConsentInfo(dir).mustChangePassword, true);
});

// ────────────────────────── 凭据：解析、打码、抹除（第 2 步） ──────────────────────────

/** 凭据那一行的原文（从实测的现场留痕里抄来的形状，一个字都没改） */
const CREDENTIAL_LINE = '[协议端] 01:26:39 INFO               [WebUI] initial credentials: user=admin password=d198b971dd2b7b03';

test('凭据解析：认那一行的形状（含前缀与栏距），口令取到原文', () => {
  assert.deepEqual(parseCredentialLine(CREDENTIAL_LINE), { user: 'admin', password: 'd198b971dd2b7b03' });
  assert.deepEqual(parseCredentialLine('initial credentials: user=admin password=abc123'), {
    user: 'admin', password: 'abc123',
  });
});

test('凭据解析：形状不对一律 null —— 宁可报"没解析到"，也不猜一个口令出来', () => {
  for (const line of [
    '',
    '★ WebUI 初始登录凭据 / Initial WebUI Credentials ★',
    '  Log in and change the password now; it will not be shown again.',
    'awaiting EULA/PRIVACY consent before the panel unlocks',
    'initial credentials: user=admin',                        // 没有口令
    'initial credentials: password=abc',                      // 没有用户名
    'initial credentials: user= password=abc',                // 用户名空
  ]) {
    assert.equal(parseCredentialLine(line), null, JSON.stringify(line));
  }
});

test('打码：留头尾各两位（够人核对，不够还原），短口令整段遮住', () => {
  assert.equal(maskCredential('d198b971dd2b7b03'), 'd1…03');
  assert.equal(maskCredential('abc'), '****');
  assert.equal(maskCredential(''), '');
});

test('抹除器：学过的口令从这里出去就没了，句子本身留着', () => {
  const redactor = new SecretRedactor();
  redactor.learn('d198b971dd2b7b03');
  const redacted = redactor.apply(CREDENTIAL_LINE);
  assert.equal(redacted.includes('d198b971dd2b7b03'), false, '口令不许跟着留痕走');
  assert.match(redacted, /initial credentials: user=admin password=\*\*\*/u);
  // 太短的"口令"不学：那只会误伤正常文本
  redactor.learn('abc');
  assert.equal(redactor.apply('abcdef'), 'abcdef');
});

test('抹除器：同一行里出现两次也全抹掉', () => {
  const redactor = new SecretRedactor();
  redactor.learn('tok-abcdef123456');
  assert.equal(redactor.apply('a tok-abcdef123456 b tok-abcdef123456'), 'a *** b ***');
});

test('凭据留痕：进程不是本次起的时，从框架自己的启动输出里捞回**最后一条**', () => {
  // 现场那两份留痕的形状（`<安装根>\agent-console.out.log` 里就是这么两行）：
  // 它每次启动都重新生成口令，所以留痕里可能有好几条，**只有最后那条还有效**
  const dir = tempDir();
  const logPath = join(dir, 'agent-console.out.log');
  writeFileSync(logPath, [
    '[协议端] 00:00:40 INFO               [WebUI] initial credentials: user=admin password=6188048eb0228d57',
    '[协议端] 00:00:40 INFO               [WebUI] listening http://127.0.0.1:5099',
    '[协议端] 01:26:38 INFO               [App] SnowLuma starting',
    '[协议端] 01:26:39 INFO               [WebUI] initial credentials: user=admin password=d198b971dd2b7b03',
  ].join('\n'), 'utf8');
  const found = readCredentialFromLogFile(logPath);
  assert.equal(found?.source, 'console-log');
  assert.equal(found?.user, 'admin');
  assert.equal(found?.password, 'd198b971dd2b7b03', '取最后一条：前一条在它重新生成之后就作废了');
  // 文件不在 / 里面没有那一行 ⇒ null（**不猜**一个口令出来）
  assert.equal(readCredentialFromLogFile(join(dir, '没有这个文件.log')), null);
  writeFileSync(logPath, '[协议端] 01:26:39 INFO [WebUI] listening http://127.0.0.1:5099\n', 'utf8');
  assert.equal(readCredentialFromLogFile(logPath), null);
});

/**
 * 协议端自己的日志里**没有**口令——它是这条链上最容易搞错的一步。
 *
 * `logInitialWebuiCredentials` 走的是 `process.stdout.write`，绕开了它的文件传输层：
 * `logs/snowluma-<date>.log` 里只有横幅与提示句，`initial credentials:` 那一行不在里面。
 * 所以"去它的日志里找口令"这条路是走不通的（第 2 步的实现必须认这一点）。
 */
test('凭据留痕：协议端自己的日志里只有横幅、没有口令（所以来源是框架的 stdout 留痕）', () => {
  const dir = tempDir();
  const ownLog = join(dir, 'snowluma-2026-10-07.log');
  writeFileSync(ownLog, [
    '01:26:39 INFO               [WebUI] ════════════════════════════════════════════════════════════════',
    '01:26:39 INFO               [WebUI]   ★ WebUI 初始登录凭据 / Initial WebUI Credentials ★',
    '01:26:39 INFO               [WebUI]   Log in and change the password now; it will not be shown again.',
    '01:26:39 INFO               [WebUI] ────────────────────────────────────────────────────────────────',
    '01:26:39 INFO               [WebUI] ════════════════════════════════════════════════════════════════',
  ].join('\n'), 'utf8');
  assert.equal(readCredentialFromLogFile(ownLog), null, '那一份里没有口令，就不该从它里面"读出"一个');
});

test('netstat 行判定：只认 LISTEN，端口取本地地址最后一段（IPv6 也一样）', () => {
  assert.deepEqual(
    parseNetstatListenLine('  TCP    127.0.0.1:5099         0.0.0.0:0              LISTENING       34552'),
    { port: 5099, pid: 34552 },
  );
  assert.deepEqual(
    parseNetstatListenLine('  TCP    [::1]:5100             [::]:0                 LISTENING       34552'),
    { port: 5100, pid: 34552 },
  );
  // 不是监听的一律不认：把一条连出去的长连接当成"它在听"是假的
  assert.equal(parseNetstatListenLine('  TCP    127.0.0.1:5099         127.0.0.1:52000        ESTABLISHED     34552'), null);
  assert.equal(parseNetstatListenLine('  UDP    127.0.0.1:5099         *:*                                    34552'), null);
  assert.equal(parseNetstatListenLine(''), null);
});

test('默认探测：从 netstat 里挑出"命令行指向本目录入口"的那个进程（端口退让也认）', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.mjs'), '// 假入口\n', 'utf8');
  const netstat = [
    '  TCP    127.0.0.1:135          0.0.0.0:0              LISTENING       900',
    '  TCP    127.0.0.1:5099         0.0.0.0:0              LISTENING       111',
    '  TCP    127.0.0.1:5100         0.0.0.0:0              LISTENING       34552',
  ].join('\r\n');
  // 一次调用拿整批候选 pid 的事实（真实现只查那几个 pid，不拉整张进程表）
  const facts = (pids: readonly number[]): Map<number, { startedAt?: string; commandLine: string }> => {
    const out = new Map<number, { startedAt?: string; commandLine: string }>();
    for (const pid of pids) {
      out.set(pid, pid === 34552
        ? { startedAt: '2026-10-07T01:26:38.000Z', commandLine: `node ${join(dir, 'index.mjs')}` }
        : { commandLine: 'C:\\Windows\\other.exe' });
    }
    return out;
  };
  const found = discoverWebuiListener(dir, { netstat: () => netstat, facts });
  assert.equal(found?.pid, 34552);
  assert.equal(found?.port, 5100, '退让之后要认新的那个端口');
  assert.equal(found?.startedAt, '2026-10-07T01:26:38.000Z');
  assert.equal(found?.via, 'port-table');
});

test('默认探测：命令行对不上就返回 null —— 本机别的监听程序不许被说成"协议端在跑"', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.mjs'), '// 假入口\n', 'utf8');
  const found = discoverWebuiListener(dir, {
    netstat: () => '  TCP    127.0.0.1:5099         0.0.0.0:0              LISTENING       111',
    facts: (pids) => new Map(pids.map((pid) => [pid, { commandLine: 'C:\\Windows\\System32\\svchost.exe -k netsvcs' }])),
  });
  assert.equal(found, null);
});

/**
 * 隔离问题的钉子（2026-10-07 补）：**兜底探活探到的"有人在听"，永远不许被当成端点**。
 *
 * 为什么单独立一条：`waitReady` 在没有端点可探时会去探一个**写死的**兜底地址
 * （`DEFAULT_FALLBACK_PROBE_URL` = 3001），而"通了"这件事在真机上根本证明不了什么——
 * 本机 3001 这种号段上谁都可能听着（实测：真实协议端一登录，3001 立刻有人应）。
 * 判据（与 `ManagedServiceOptions.probe` 里写的是同一条）：
 *   · 探活必须确认"那个端口后面**是本服务自己的实例**"，**或**
 *   · 端点是它自己配置里写着的那一份（那一份通常还带 token）；
 *   两者缺一 ⇒ 不许当 endpoint。
 *
 * 这条用例把兜底端口搬到一个**自己控制的端口**上（否则就得依赖真机 3001 有没有人听，
 * 那正是要治的病），并且先证明"裸 TCP 探活确实会被骗"——对照组不能省：
 * 少了它，这条用例退化成"探活这次说了 false 而已"。
 */
test('兜底端口上真的有人听 ⇒ 也不许把空 token 的 probe 当成 endpoint', async () => {
  const dir = tempDir();
  // ① 冒充"别人的 3001"：一个只监听、什么都不做的裸服务
  const foreign = createServer(() => { /* 有人连进来也不说话：它只是占着端口 */ });
  await new Promise<void>((resolve) => { foreign.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = foreign.address();
  if (address === null || typeof address === 'string') throw new Error('冒充的兜底端口没能监听');
  const foreignUrl = `ws://127.0.0.1:${address.port}`;
  try {
    // 对照组：默认那条探活（裸 TCP）**会被它骗过去**——这正是必须把它注入掉的理由
    assert.equal(await canConnect(foreignUrl), true, '对照组：兜底端口上确实有人听，裸 TCP 探活返回 true');

    // ② 假协议端：端口先开，配置**晚一拍**才落盘（"配置缺失"那几拍必须真的发生）
    const fake = `
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  const actual = server.address().port;
  setTimeout(() => {
    mkdirSync(join(process.cwd(), 'config'), { recursive: true });
    writeFileSync(join(process.cwd(), 'config', 'onebot.json'), JSON.stringify({
      networks: { wsServers: [{ name: 'ws-default', host: '127.0.0.1', port: actual, path: '/', accessToken: 'tok-after-delay' }] },
    }));
  }, 1200);
});
setInterval(() => {}, 1000);
`;
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.mjs'), fake, 'utf8');

    const svc = new ManagedProtocolService({
      dir,
      readyTimeoutMs: 15_000,
      discover: () => null,
      fallbackProbeUrl: foreignUrl,
      // 判据落在探活口上：只认"它自己那份配置里写着这个端点"（身份凭据）——
      // 于是"别人的 3001"永远答不上来，而它自己的端点答得上来
      probe: async (wsUrl) => readEndpointFromConfig(dir)?.wsUrl === wsUrl,
    });
    const status = await svc.start();
    try {
      assert.equal(status.state, 'ready', `拉起失败：${status.detail}`);
      const fromConfig = readEndpointFromConfig(dir);
      assert.equal(status.endpoint?.wsUrl, fromConfig?.wsUrl, '端点必须是它自己配置里那一份');
      assert.equal(status.endpoint?.accessToken, 'tok-after-delay');
      assert.notEqual(status.endpoint?.wsUrl, foreignUrl, '兜底探活探到的那个地址不许成为端点');
      assert.notEqual(status.endpoint?.accessToken, '', '空 token 的兜底 probe 不许成为端点');
    } finally {
      await svc.stop();
    }
  } finally {
    await new Promise<void>((resolve) => { foreign.close(() => { resolve(); }); });
  }
});

/**
 * 「端口通」≠「服务就绪」（2026-10-07 收紧）。
 *
 * 判据：**端点没有配置背书（读不出 wsUrl/token）就不算 ready**。理由就是今晚那条故障本身：
 * `waitReady` 的兜底探活是裸 TCP，答不了"端口后面是谁"——真机上别人的 3001 会被读成 ready，
 * 并交出一个**空 token 的兜底端点**（适配器拿着它去连一个开着校验的端口 ⇒ 永远的 401）。
 *
 * 这条用例**不注入探活**（走生产默认的真 TCP），只把兜底端口搬到自己控制的地址上，
 * 于是"端口上真的有人听"这件事是真的、可计数的：探到了、但配置读不出 ⇒ 仍然不许 ready，
 * 状态要按三档如实说成"进程在跑 · OneBot 配置缺失"。
 */
test('兜底端口上有人听、但配置读不出 ⇒ 不许 ready（三档如实报"进程在跑 · 配置缺失"）', async () => {
  const dir = tempDir();
  // 冒充"别人的 3001"：真的有人听，而且我们数得出它被探到过几次
  let hits = 0;
  const foreign = createServer(() => { hits += 1; });
  await new Promise<void>((resolve) => { foreign.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = foreign.address();
  if (address === null || typeof address === 'string') throw new Error('冒充的兜底端口没能监听');
  const foreignUrl = `ws://127.0.0.1:${address.port}`;
  try {
    // 假协议端：进程活着、端口开着、连 WebUI 那行都打了，但**配置始终不写**（= 从没登录过 QQ）
    const fake = `
import { createServer } from 'node:net';
createServer().listen(0, '127.0.0.1', () => {
  console.log('[WebUI] listening http://127.0.0.1:15099');
});
setInterval(() => {}, 1000);
`;
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'index.mjs'), fake, 'utf8');

    const svc = new ManagedProtocolService({
      dir,
      readyTimeoutMs: 2_000, // 这条验的是"不许 ready"，不是等满 30 秒
      discover: () => null, // 本进程刚 spawn 的，这条探测用不上；注入只为不去查真机
      fallbackProbeUrl: foreignUrl,
    });
    const status = await svc.start();
    try {
      assert.notEqual(status.state, 'ready', `端口上有人听也不许 ready：${status.detail}`);
      assert.equal(status.state, 'failed');
      assert.equal(status.endpoint, undefined, '读不出配置就没有端点可给（尤其不许给空 token 的那个）');
      assert.ok(hits >= 1, `兜底端口必须真的被探到过（实际 ${hits} 次）——否则这条用例什么也没验到`);
      assert.equal(readEndpointFromConfig(dir), null, '前提：这一刻确实读不出端点');

      // 三档如实：进程在跑，而 OneBot 配置缺失（不是一句笼统的失败）
      assert.equal(status.report.process.running, true, '第一档：进程在跑');
      assert.equal(status.report.onebotConfig.present, false, '第二档：OneBot 配置缺失');
      assert.match(status.detail, /进程在跑/u, `文案要说清是进程那一档：${status.detail}`);
      assert.match(status.detail, /配置缺失/u, `文案要说清是配置那一档：${status.detail}`);
    } finally {
      await svc.stop();
    }
  } finally {
    await new Promise<void>((resolve) => { foreign.close(() => { resolve(); }); });
  }
});

/** 背书判据不许把正常路径挡在门外：配置读得出 ⇒ 照常 ready（走生产默认探活） */
test('配置读得出 ⇒ 照常 ready（背书判据不误伤）', async () => {
  const dir = tempDir();
  // 假协议端：端口开着，并且**立刻**把配置写下来（真实协议端登录 QQ 之后就是这个样子）
  const fake = `
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  const actual = server.address().port;
  mkdirSync(join(process.cwd(), 'config'), { recursive: true });
  writeFileSync(join(process.cwd(), 'config', 'onebot.json'), JSON.stringify({
    networks: { wsServers: [{ name: 'ws-default', host: '127.0.0.1', port: actual, path: '/', accessToken: 'tok-backed' }] },
  }));
});
setInterval(() => {}, 1000);
`;
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.mjs'), fake, 'utf8');

  const svc = new ManagedProtocolService({
    dir,
    readyTimeoutMs: 15_000,
    discover: () => null,
    // 兜底端口指向一个**没人听**的地址：配置落盘前那几拍不许被真机 3001 影响（隔离）
    fallbackProbeUrl: 'ws://127.0.0.1:1',
  });
  const status = await svc.start();
  try {
    assert.equal(status.state, 'ready', `配置读得出就该 ready：${status.detail}`);
    assert.equal(status.endpoint?.accessToken, 'tok-backed');
    assert.equal(status.endpoint?.wsUrl, readEndpointFromConfig(dir)?.wsUrl, '端点来自它自己的配置');
  } finally {
    await svc.stop();
  }
});

test('服务：已经在跑时 start() 不再拉第二个（会被说成"已经在跑"，并如实给出面板地址）', async () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'index.mjs'), '// 假入口\n', 'utf8');
  let spawnCalls = 0;
  const svc = new ManagedProtocolService({
    dir,
    discover: () => ({ pid: 34552, port: 5099, host: '127.0.0.1' }),
    readConsoleCredential: () => null,
    // 真被调用到就说明"已经在跑"这条判据没生效
    spawnFn: (() => { spawnCalls += 1; throw new Error('不该 spawn'); }) as never,
  });
  const status = await svc.start();
  assert.equal(spawnCalls, 0, '已经在跑就不许再拉一个（两个进程会抢同一个端口）');
  assert.equal(status.report.process.running, true);
  assert.match(status.detail, /已经在跑/u);
  assert.match(status.detail, /没登录/u, '没有 OneBot 端口时要说清是"还没登录"');
});
