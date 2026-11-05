import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, emptyProjection, type AppEvent, type Projection } from '../src/log/types.ts';
import { SubagentManager } from '../src/runtime/subagent-manager.ts';
import { applyOne } from '../src/state/fold.ts';
import type { ToolRegistry } from '../src/tools/registry.ts';
import { ToolRegistry as Registry } from '../src/tools/registry.ts';
import { AUTH_FILE_NAME, SCRYPT_PARAMS } from '../src/web/auth.ts';
import { startWebServer, type WebServer } from '../src/web/server.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TOKEN = 'subagent-api-test-token-0123456789';
const PASSWORD = 'subagent-api-test-password';
const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const HASH = scryptSync(PASSWORD, SALT, 32, {N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p}).toString('hex');
const PERSONA = {identity: 'test', constitution: 'test', style: 'test', state: '', personaHash: 'hash'};

interface Fixture {
  dir: string;
  log: EventLog;
  projection: Projection;
  config: ReturnType<typeof defaultConfig>;
  registry: ToolRegistry;
  manager: SubagentManager;
  call(method: string, path: string, body?: unknown, confirm?: string, auth?: boolean): Promise<{status: number; body: any}>;
}

async function make(t: TestContext, enabled = true, gate?: Promise<void>): Promise<Fixture> {
  const dir = tempDirSync('irmia-subagent-api-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, {recursive: true});
  writeFileSync(join(dir, 'config.json'), '{"schemaVersion":1}\n');
  writeFileSync(join(dataDir, AUTH_FILE_NAME), JSON.stringify({
    v: 1,
    scrypt: {salt: SALT.toString('hex'), ...SCRYPT_PARAMS},
    hash: HASH,
    sessions: [{id: 'aabbccddeeff0011', hash: createHash('sha256').update(TOKEN).digest('hex'),
      createdAt: '2026-02-14T10:00:00.000Z', label: 'test'}],
  }));
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = emptyProjection();
  const config = defaultConfig(dataDir);
  config.subagents.enabled = enabled;
  const now = () => new Date('2026-02-14T10:00:00.000Z');
  const registry = new Registry();
  const events: AppEvent[] = [];
  const manager = new SubagentManager({
    dataDir,
    log,
    registry,
    projection,
    persona: PERSONA,
    ds: {} as never,
    config: () => config,
    modelCapabilities: {contextLimit: 1_000_000, reasoningEfforts: ['low', 'medium', 'high', 'max']},
    now: () => now().toISOString(),
    timezone: 'Asia/Shanghai',
    runTurnFn: (async (deps) => {
      if (gate !== undefined) {
        await Promise.race([gate, new Promise<void>((resolve) => {
          if (deps.signal?.aborted === true) resolve();
          else deps.signal?.addEventListener('abort', () => resolve(), {once: true});
        })]);
      }
      if (deps.signal?.aborted === true) return {kind: 'aborted', cause: 'signal'};
      const event = {
        seq: log.nextSeq(), ts: now().toISOString(), type: 'message/assistant',
        data: {text: '子代理阶段结论', toolCalls: []}, visibility: defaultVisibility('message/assistant'),
        parentCallId: deps.parentCallId, agentId: deps.agentId,
      } as unknown as AppEvent;
      log.append(event, {sync: true});
      applyOne(deps.projection, event);
      deps.onEvent?.(event);
      events.push(event);
      return {kind: 'completed'};
    }) as never,
  });
  await manager.start();
  let server: WebServer | null = null;
  server = await startWebServer({
    log, projection, config, personaRoot: join(dataDir, 'persona'), dataDir,
    timers: new TimerStore(join(dataDir, 'timers.json'), {now}), now,
    configPath: join(dir, 'config.json'), port: 0, uiToken: null,
    subagents: manager, out: () => undefined,
  });
  t.after(async () => {
    await server!.close();
    log.close();
    rmSync(dir, {recursive: true, force: true});
  });
  const call = async (method: string, path: string, body?: unknown, confirm?: string, auth = true) => {
    const response = await fetch(`${server!.url()}${path}`, {
      method,
      headers: {
        ...(auth ? {authorization: `Bearer ${TOKEN}`} : {}),
        ...(body === undefined ? {} : {'content-type': 'application/json'}),
        ...(confirm === undefined ? {} : {'x-confirm': confirm}),
      },
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    return {status: response.status, body: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : bytes};
  };
  return {dir, log, projection, config, registry, manager, call};
}

test('GET /api/subagents：空态、列表形状与归档过滤', async (t) => {
  const fx = await make(t);
  const empty = await fx.call('GET', '/api/subagents');
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, {enabled: true, items: []});
  const handle = await fx.manager.delegate({task: 'list shape'}, {callId: 'list', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const listed = await fx.call('GET', '/api/subagents');
  assert.equal(listed.body.enabled, true);
  assert.equal(listed.body.items.length, 1);
  assert.deepEqual(Object.keys(listed.body.items[0]).sort(), [
    'agentId', 'canCancel', 'canResume', 'createdAt', 'label', 'lastReportPreview', 'parentCallId',
    'parentTurn', 'profileId', 'status', 'tokens', 'updatedAt',
  ].sort());
  assert.equal(listed.body.items[0].agentId, handle.agentId);
  assert.equal(listed.body.items[0].lastReportPreview, '子代理阶段结论');
  assert.equal(JSON.stringify(listed.body).includes(fx.dir), false, '不泄露 workspace 绝对路径');
  fx.manager.archive(handle.agentId);
  assert.equal((await fx.call('GET', '/api/subagents')).body.items.length, 0);
  assert.equal((await fx.call('GET', '/api/subagents?includeArchived=1')).body.items[0].status, 'archived');
});

test('GET /api/subagents/:id：详情、404、归档可查且不返回 transcript', async (t) => {
  const fx = await make(t);
  const handle = await fx.manager.delegate({task: 'detail'}, {callId: 'detail', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const detail = await fx.call('GET', `/api/subagents/${handle.agentId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.agentId, handle.agentId);
  assert.equal(detail.body.lastReport, '子代理阶段结论');
  assert.equal(JSON.stringify(detail.body).includes(fx.dir), false);
  assert.equal(JSON.stringify(detail.body).includes('transcript'), false);
  assert.equal((await fx.call('GET', '/api/subagents/sub-does-not-exist')).status, 404);
  fx.manager.archive(handle.agentId);
  const archived = await fx.call('GET', `/api/subagents/${handle.agentId}`);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.status, 'archived');
});

test('subagent-message / cancel / resume 命令与确认/禁用错误', async (t) => {
  const fx = await make(t);
  const handle = await fx.manager.delegate({task: 'commands'}, {callId: 'commands', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const message = await fx.call('POST', '/api/commands/subagent-message', {
    agentId: handle.agentId, message: '继续做',
  });
  assert.equal(message.status, 200);
  assert.ok(['queued', 'running', 'completed'].includes(message.body.status));

  const gate = new Promise<void>(() => undefined);
  const cancelFx = await make(t, true, gate);
  const cancelHandle = await cancelFx.manager.delegate({task: 'cancel'}, {callId: 'cancel', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 10));
  const noConfirm = await cancelFx.call('POST', '/api/commands/subagent-cancel', {agentId: cancelHandle.agentId});
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.error.code, 'confirm-required');
  const cancelled = await cancelFx.call('POST', '/api/commands/subagent-cancel',
    {agentId: cancelHandle.agentId}, 'subagent-cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  const resumed = await cancelFx.call('POST', '/api/commands/subagent-resume',
    {agentId: cancelHandle.agentId}, 'subagent-resume');
  assert.equal(resumed.status, 200);
  assert.ok(['queued', 'running'].includes(resumed.body.status));
  assert.equal((await fx.call('POST', '/api/commands/subagent-message',
    {agentId: 'sub-missing', message: 'x'})).status, 404);
  assert.equal((await fx.call('GET', '/api/subagents', undefined, undefined, false)).status, 401);
});

test('GET /api/subagents/profiles：三个角色包摘要，锁定态与字段不泄露 prompt/路径', async (t) => {
  const fx = await make(t);
  const listed = await fx.call('GET', '/api/subagents/profiles');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.enabled, true);
  const ids = listed.body.items.map((item: {id: string}) => item.id).sort();
  assert.deepEqual(ids, ['researcher', 'scribe', 'worker'], 'general 隐式；coder/design 已合并为 worker');
  const worker = listed.body.items.find((row: {id: string}) => row.id === 'worker');
  assert.equal(worker.label, '开发');
  assert.equal(worker.workdir, 'auto');
  assert.equal(worker.shell, 'full', 'worker 是重度主力：full pwsh（cwd 默认 workspace、可访问任意路径）');
  assert.equal(worker.reasoningEffort, 'max');
  assert.equal(worker.contextLimit, 1_000_000);
  assert.equal(worker.compactAt, 0.7);
  assert.ok(worker.skills.includes('dev-workflow'));
  assert.ok(worker.skills.includes('review'));
  assert.ok(worker.skills.includes('design-taste-frontend'), 'design 技能合并进 worker 白名单');
  assert.ok(worker.skills.includes('ui-ux-pro-max'));
  assert.ok(worker.skills.includes('impeccable'));
  assert.deepEqual(worker.mcpServers, [], '合并后 worker 不接 MCP');
  assert.equal(typeof worker.toolCount, 'number');
  assert.equal(worker.available, false);
  assert.equal(worker.locked, true);
  assert.ok(worker.missing.length > 0, '未安装角色包必须回报 missing');
  for (const id of ['researcher', 'scribe']) {
    const item = listed.body.items.find((row: {id: string}) => row.id === id);
    assert.equal(item.available, false, `${id} 默认锁定`);
    assert.ok(item.missing.length > 0, `${id} 必须有 missing`);
  }

  const keys = Object.keys(worker).sort();
  assert.deepEqual(keys, [
    'available', 'compactAt', 'contextLimit', 'description', 'id', 'label', 'locked', 'mcpServers',
    'missing', 'reasoningEffort', 'shell', 'skills', 'toolCount', 'workdir', 'workspace',
  ].sort());
  const text = JSON.stringify(listed.body);
  assert.equal(text.includes('systemPrompt'), false);
  assert.equal(text.includes('requires'), false);
  assert.equal(text.includes('install'), false);
  assert.equal(text.includes('你是调研子代理'), false);
  assert.equal(text.includes(fx.dir), false, '不泄露绝对路径');
  assert.equal(text.includes('role-packages'), false);
});

test('subagent-install / verify：人工确认、真实安装、健康摘要且不泄露来源或路径', async (t) => {
  const fx = await make(t);
  const denied = await fx.call('POST', '/api/commands/subagent-install', {profileId: 'researcher'});
  assert.equal(denied.status, 400);
  assert.equal(denied.body.error.code, 'confirm-required');
  const installed = await fx.call('POST', '/api/commands/subagent-install', {profileId: 'researcher'}, 'subagent-install');
  assert.equal(installed.status, 200);
  assert.equal(installed.body.ok, true);
  assert.equal(installed.body.profile.id, 'researcher');
  assert.equal(installed.body.profile.available, true);
  assert.equal(JSON.stringify(installed.body).includes(fx.dir), false);
  assert.equal(JSON.stringify(installed.body).includes('builtin:'), false);
  const verified = await fx.call('POST', '/api/commands/subagent-verify', {profileId: 'researcher'}, 'subagent-verify');
  assert.equal(verified.status, 200);
  assert.equal(verified.body.profile.locked, false);
  assert.deepEqual(verified.body.profile.missing, []);
  const unknown = await fx.call('POST', '/api/commands/subagent-verify', {profileId: 'nope'}, 'subagent-verify');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'profile-unknown');
});

test('旧 session 的 profileId 只回退显示：label=id + legacy，不映射成新角色', async (t) => {
  const fx = await make(t);
  const agentId = 'sub-0123456789abcdef';
  const dir = join(fx.dir, 'data', 'subagents', 'sessions', agentId);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, 'session.json'), JSON.stringify({
    schema: 1,
    agentId,
    profileId: 'research',
    parentCallId: 'legacy-call',
    parentTurn: 1,
    status: 'completed',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:01:00.000Z',
    startedAt: '2026-11-01T00:00:00.000Z',
    turn: 1,
    resumeCount: 0,
    task: 'P3 老任务',
    context: '',
    pendingMessages: [],
    lastReport: null,
    tokens: {used: 1, limit: 100},
    workspace: 'workspace',
    error: null,
  }), 'utf8');

  const detail = await fx.call('GET', `/api/subagents/${agentId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.profileId, 'research');
  assert.equal(detail.body.label, 'research', 'label fallback 到 id');
  assert.equal(detail.body.profileLegacy, true);
  assert.equal(JSON.stringify(detail.body).includes(fx.dir), false);

  fx.manager.archive(agentId);
  const listed = await fx.call('GET', '/api/subagents?includeArchived=1');
  const row = listed.body.items.find((item: {agentId: string}) => item.agentId === agentId);
  assert.equal(row.label, 'research');
  assert.equal(row.profileLegacy, true);
  assert.equal(row.status, 'archived');
});

test('subagents.enabled=false：列表 200 空，命令 400 subagents-disabled', async (t) => {
  const fx = await make(t, false);
  const list = await fx.call('GET', '/api/subagents');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, {enabled: false, items: []});
  assert.deepEqual((await fx.call('GET', '/api/subagents/profiles')).body, {enabled: false, items: []});
  const command = await fx.call('POST', '/api/commands/subagent-resume',
    {agentId: 'sub-anything'}, 'subagent-resume');
  assert.equal(command.status, 400);
  assert.equal(command.body.error.code, 'subagents-disabled');
});

test('SSE /api/events 序列化包含 agentId', async (t) => {
  const fx = await make(t);
  const handle = await fx.manager.delegate({task: 'sse'}, {callId: 'sse', turn: 1});
  await new Promise((resolve) => setTimeout(resolve, 15));
  const page = await fx.call('GET', '/api/events?types=subagent/started&limit=20');
  assert.equal(page.status, 200);
  const found = page.body.events.find((event: {type: string; agentId?: string}) => event.type === 'subagent/started');
  assert.notEqual(found, undefined);
  assert.equal(found.agentId, handle.agentId);
});
