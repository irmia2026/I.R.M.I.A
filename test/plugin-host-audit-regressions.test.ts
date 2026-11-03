import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';

import { PLUGIN_FILTER_MAX_TEXT_CHARS, testMessageRegex } from '../src/plugin/filter-regex.ts';
import type { PluginMessageReceivedPayload } from '../src/plugin/host-services.ts';
import { createHarness, type Harness } from './helpers/plugin-runtime-harness.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const message: PluginMessageReceivedPayload = {
  channel: 'onebot', chatType: 'private', chatId: 'u', senderId: 'u', senderName: 'tester',
  text: `${'a'.repeat(30)}!`, mentionsMe: false, mediaCount: 0, messageId: 'm', at: '2026-10-30T00:00:00.000Z',
};

async function fixture(t: TestContext, id: string, permissions: string[], source: string): Promise<{ harness: Harness; pkg: Harness['pkg'] }> {
  const harness = await createHarness();
  t.after(async () => { await harness.dispose(); });
  const dir = tempDirSync('irmia-plugin-host-regression-');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id, version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions,
  }));
  writeFileSync(join(dir, 'main.mjs'), source);
  return { harness, pkg: harness.manager.install(dir) };
}

test('入站正则：灾难性回溯在可终止线程中超时，宿主心跳继续且进程正常退出', () => {
  // A parent-side deadline makes this test fail safely if main-thread matching regresses.
  const moduleUrl = new URL('../src/plugin/host-services.ts', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {parseMessageFilter,matchesMessageFilter} from ${JSON.stringify(moduleUrl)};
    let ticks=0;
    const timer=setInterval(()=>{ticks++;},10);
    try {
      await assert.rejects(matchesMessageFilter(parseMessageFilter({regex:'(a+)+$'}),
        ${JSON.stringify(message)}, ${JSON.stringify(message.text)}, undefined),
        error=>error.code===-32002 && /regex/.test(error.message));
      assert(ticks>0,'宿主心跳被阻塞');
      console.log(JSON.stringify({ticks,completed:true}));
    } finally {clearInterval(timer);}
  `;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).completed, true);
});

test('入站正则：保留完整语法与匹配真假；过长正文明确拒绝，不截断成误匹配', async () => {
  assert.equal(await testMessageRegex(/^(?:weather|天气)\s+\p{L}+$/u, '天气 晴'), true);
  assert.equal(await testMessageRegex(/^(?:weather|天气)\s+\p{L}+$/u, 'hello'), false);
  await assert.rejects(testMessageRegex(/ok/u, 'x'.repeat(PLUGIN_FILTER_MAX_TEXT_CHARS + 1)),
    (error: unknown) => error instanceof Error && /正文超过/.test(error.message));
});

test('入站正则：真实过滤超时保留消息，三次按订阅隔离，其它插件能力仍可用', async (t) => {
  const { harness, pkg } = await fixture(t, 'regex-timeout', ['messages.read', 'tools.define'], `
    export async function activate(ctx) {
      await ctx.hooks.on('message.received', () => ({drop:true}), {regex:'(a+)+$'});
      await ctx.tools.define({name:'ok',description:'healthy',handler:()=>({content:'ok'})});
    }
  `);
  await harness.host.startPackage(pkg);
  for (let i = 0; i < 3; i++) {
    const result = await harness.host.dispatchMessageReceived(message);
    assert.equal(result.text, message.text);
    assert.equal(result.drop, false);
    assert.equal(result.matched, 0);
  }
  assert.equal(harness.host.hasInboundSubscriptions(), false);
  assert.equal((await harness.callTool('regex-timeout__ok', {})).content, 'ok');
  assert(harness.events.some((event) => event.type === 'plugin/contribution-isolated'
    && (event.data as { category: string }).category === 'hook-timeout'));
});

test('激活回滚：注册工具/两类Hook/指令/定时器后失败无残留，同包重试成功', async (t) => {
  const { harness, pkg } = await fixture(t, 'activation-rollback',
    ['tools.define', 'hooks.tool', 'messages.read', 'commands.define', 'timers', 'files'], `
    export async function activate(ctx) {
      await ctx.tools.define({name:'ok',description:'healthy',handler:()=>({content:'ok'})});
      await ctx.hooks.on('tool.before',()=>({}));
      await ctx.hooks.on('message.received',()=>({}),{permission:'all'});
      await ctx.commands.define({name:'rollback-command',description:'retry',permission:'all',handler:()=>({})});
      await ctx.timers.every(1000,()=>ctx.log.info('rollback-timer-fired'));
      let retried=false; try {retried=await ctx.files.read('retry.flag');} catch {}
      if(!retried){await ctx.files.write('retry.flag','retry');throw new Error('first-activation-failed');}
    }
  `);
  await assert.rejects(harness.host.startPackage(pkg), /first-activation-failed/);
  assert.equal(harness.tools.size, 0);
  assert.equal(harness.host.hasHook('tool.before'), false);
  assert.equal(harness.host.hasInboundSubscriptions(), false);
  assert.equal(harness.host.hasCommands(), false);
  assert.equal(harness.host.status(pkg.manifest.id, pkg.contentHash).pid, null);
  await harness.host.stopAll('after-failure');
  await harness.host.startPackage(pkg);
  assert.equal((await harness.callTool('activation-rollback__ok', {})).content, 'ok');
  await delay(1_100);
  assert.equal(harness.writes.filter((line) => line.includes('rollback-timer-fired')).length, 1);
  assert.equal(harness.writes.some((line) => /timer:.*失败/.test(line)), false, '失败激活留下的旧定时器不应再被调用');
});

test('tool.after：仅isError字段也生效；长日志按文档截断并保留原消息', async (t) => {
  const { harness, pkg } = await fixture(t, 'after-flags', ['hooks.tool'], `
    export async function activate(ctx) {
      ctx.log.info('long-log:'+'x'.repeat(4001));
      await ctx.hooks.on('tool.after',payload=>({isError:payload.tool==='mark-error'}));
    }
  `);
  await harness.host.startPackage(pkg);
  const request = { callId: 'c', tool: 'mark-error', input: {}, turn: 1, step: 1 };
  assert.deepEqual((await harness.host.tapToolAfter(request, {status:'ok',isError:false,content:'original',durationMs:1}))?.updatedResult,
    { isError: true });
  assert.deepEqual((await harness.host.tapToolAfter({...request,tool:'mark-success'}, {status:'error',isError:true,content:'original',durationMs:1}))?.updatedResult,
    { isError: false });
  const line = harness.writes.find((value) => value.includes('long-log:'));
  assert.equal(line, '[插件 after-flags] [info] ' + ('long-log:' + 'x'.repeat(4001)).slice(0, 4000));
  assert.equal(harness.writes.some((value) => value.includes('log.write.message: 超过')), false);
});
