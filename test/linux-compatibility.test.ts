import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { DepsManager } from '../src/deps/manager.ts';
import { KEYS_FILE_NAME, writeKeyFile } from '../src/config/keys.ts';
import { killProcessTree, spawnManagedProcess } from '../src/process/kill-tree.ts';
import { ManagedProtocolService } from '../src/services/snowluma.ts';
import { AUTH_FILE_NAME, AuthStore } from '../src/web/auth.ts';
import { WEBHOOK_SECRET_FILE_NAME, WebhookSecretStore } from '../src/web/webhook-secret.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('Linux dependency reports and installation use the native package instructions', async () => {
  const dataDir = tempDirSync('irmia-linux-deps-');
  const manager = new DepsManager({
    dataDir, platform: 'linux',
    download: async () => assert.fail('Linux attempted to download a Windows dependency'),
    wingetPath: () => assert.fail('Linux attempted to resolve winget'),
  });
  const everything = await manager.get('es');
  assert.equal(everything.status, 'missing');
  assert.match(everything.reason, /Windows/u);
  const { entries } = await manager.report();
  assert(entries.every(entry => !entry.installable));
  assert.equal(entries.find(entry => entry.name === 'es')?.action, null);
  for (const dep of ['rg', 'es', 'python', 'pwsh'] as const) {
    assert.equal((await manager.install(dep)).ok, false);
  }
});

test('Linux saves credentials with owner-only access under umask 022', { skip: process.platform !== 'linux' }, async () => {
  const dataDir = tempDirSync('irmia-linux-secrets-');
  const umask = process.umask(0o022);
  try {
    const options = { dataDir, now: () => new Date() };
    await writeKeyFile(dataDir, 'heavy', 'fake-model-key-for-permission-test');
    assert.equal((await new AuthStore(options).setup('test-local-password')).ok, true);
    assert.equal(new WebhookSecretStore(options).rotate().ok, true);
    for (const file of [KEYS_FILE_NAME, AUTH_FILE_NAME, WEBHOOK_SECRET_FILE_NAME]) {
      assert.equal(statSync(join(dataDir, file)).mode & 0o777, 0o600, file);
    }
  } finally {
    process.umask(umask);
  }
});

test('Linux manages an unpacked protocol launcher and releases its process group',
  { skip: process.platform !== 'linux' }, async (t) => {
    const dir = tempDirSync('irmia-snowluma-');
    const entry = join(dir, 'launcher.sh');
    const pidFile = join(dir, 'helper.pid');
    writeFileSync(entry, 'sleep 30 &\nprintf "%s\\n" "$!" > helper.pid\nwait\n');
    writeFileSync(join(dir, 'index.mjs'), 'throw new Error("launcher.sh should take precedence");');
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'onebot.json'), JSON.stringify({
      networks: { wsServers: [{ host: '127.0.0.1', port: 3001, accessToken: 'fixture' }] },
    }));
    const service = new ManagedProtocolService({
      dir, discover: () => null, readyTimeoutMs: 1_500, probe: async () => existsSync(pidFile),
    });
    t.after(() => service.stop());
    assert.equal(service.entryPath(), entry);
    const started = await service.start();
    assert.equal(started.state, 'ready', started.detail);
    assert.equal(started.endpoint?.accessToken, 'fixture');
    assert.equal(started.report.process.managed, 'spawned');
    assert.equal((await service.start()).pid, started.pid);

    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert(pid > 1);
    const statPath = `/proc/${pid}/stat`;
    await service.stop();
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!existsSync(statPath) || /\) Z /u.test(readFileSync(statPath, 'utf8'))) break;
      await delay(50);
    }
    assert(!existsSync(statPath) || /\) Z /u.test(readFileSync(statPath, 'utf8')), 'launcher descendant is no longer running');
    assert.equal((await service.status()).state, 'stopped');
  });

const launcher = [
  "const { spawn } = require('node:child_process');",
  "spawn(process.execPath, ['-e', 'console.log(42); setTimeout(() => {}, 8000)'],",
  "  { stdio: ['ignore', 'inherit', 'inherit'] });",
  "process.stdin.once('data', () => process.exit(0));",
].join('\n');

for (const forced of [false, true]) {
  test(`Linux process groups close inherited pipes after ${forced ? 'cancellation' : 'normal exit'}`,
    { skip: process.platform !== 'linux' }, async (t) => {
      const child = spawnManagedProcess(process.execPath, ['-e', launcher], { stdio: ['pipe', 'pipe', 'pipe'] });
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
      });
      assert(child.stdout);
      const output = createInterface({ input: child.stdout });
      const [line] = await once(output, 'line', { signal: AbortSignal.timeout(5000) });
      assert.equal(line, '42');
      const closed = once(child, 'close', { signal: AbortSignal.timeout(4000) });
      if (forced) killProcessTree(child);
      else child.stdin?.end('done');
      assert.deepEqual(await closed, forced ? [null, 'SIGKILL'] : [0, null]);
    });
}
