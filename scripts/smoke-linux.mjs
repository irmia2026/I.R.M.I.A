import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'linux');
const root = await mkdtemp(join(tmpdir(), 'irmia-linux-smoke-'));
const install = join(root, '程序 bundle');
const state = join(root, '运行 state');
const data = join(state, 'data');
const children = [];
const env = {
  HOME: state,
  TMPDIR: root,
  PATH: process.env.PATH,
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  IRMIA_DATA_DIR: data,
  IRMIA_SKILLS_SEED_DIR: fileURLToPath(new URL('../skills/', import.meta.url)),
  IRMIA_TEMP_SWEEP: 'off',
};

async function availablePort() {
  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function start(entry, args) {
  const child = spawn(process.execPath, [join(install, entry), ...args], {
    cwd: state, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, output: '', result: null };
  const capture = chunk => { run.output += chunk; };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  run.result = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  children.push(run);
  return run;
}

async function waitResult(run) {
  return await Promise.race([
    run.result,
    delay(15_000, null, { ref: false }).then(() => assert.fail(run.output || 'Process did not exit')),
  ]);
}

async function request(port, path, payload, token) {
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  if (payload !== undefined) headers['content-type'] = 'application/json';
  if (path.endsWith('/restart')) headers['x-confirm'] = 'restart';
  const response = await fetch('http://127.0.0.1:' + port + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(2000),
  });
  return { status: response.status, body: await response.json() };
}

async function waitFor(run, condition) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && run.child.exitCode === null && run.child.signalCode === null) {
    if (await condition()) return;
    await delay(100);
  }
  assert.fail(run.output || 'Backend did not respond');
}

const ready = async (run, port) => waitFor(run, async () => {
  const health = await request(port, '/api/health').catch(() => null);
  return health?.body?.status === 'ready';
});

try {
  await cp(new URL('../dist/', import.meta.url), install, { recursive: true });
  await mkdir(state);
  await stat(join(install, 'plugin', 'runners', 'node-runner.mjs'));
  await stat(join(install, 'plugin', 'runners', 'python', 'runner.py'));
  const plugin = fileURLToPath(new URL('../test/fixtures/plugin-node/', import.meta.url));
  const pluginRun = start('cli.js', ['plugin', 'smoke', plugin, '--json']);
  assert.equal((await waitResult(pluginRun)).code, 0, pluginRun.output);

  const port = await availablePort();
  const boot = (portNumber) => start('main.js', ['--config', state, '--data-dir', data, '--port', String(portNumber)]);
  let backend = boot(port);
  await ready(backend, port);
  await stat(join(data, 'skills', 'irmia-framework', 'SKILL.md'));

  const password = randomBytes(24).toString('hex');
  const setup = await request(port, '/api/auth/setup', { password, label: 'linux-smoke' });
  assert.equal(setup.status, 200, JSON.stringify(setup.body.error));
  const token = setup.body.token;
  assert.equal(typeof token, 'string');
  const restart = await request(port, '/api/commands/restart', {}, token);
  assert.equal(restart.status, 501);
  assert.equal(restart.body.error.code, 'restart-not-supported');

  const note = 'linux smoke ' + randomBytes(8).toString('hex');
  const wake = start('cli.js', ['wake', '--note', note]);
  assert.equal((await waitResult(wake)).code, 0, wake.output);
  await waitFor(backend, async () => {
    const files = await readdir(join(data, 'events'));
    for (const file of files.filter(file => file.endsWith('.jsonl'))) {
      const events = await readFile(join(data, 'events', file), 'utf8');
      if (events.includes(note) && events.includes('"turn/end"')) return true;
    }
    return false;
  });

  const duplicate = boot(await availablePort());
  assert.equal((await waitResult(duplicate)).code, 1, duplicate.output);
  backend.child.kill('SIGTERM');
  assert.deepEqual(await waitResult(backend), { code: 0, signal: null }, backend.output);

  backend = boot(port);
  await ready(backend, port);
  const login = await request(port, '/api/auth/login', { password, label: 'linux-smoke restarted' });
  assert.equal(login.status, 200);
  backend.child.kill('SIGTERM');
  assert.deepEqual(await waitResult(backend), { code: 0, signal: null }, backend.output);
  console.log('Linux smoke passed: bundle, plugin, skills, auth, CLI wake, lock, SIGTERM and restart.');
} finally {
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  await Promise.all(children.map(run => run.result));
  await rm(root, { recursive: true, force: true });
}
