import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { createHarness, makeModelReply, type Harness } from './helpers/plugin-runtime-harness.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

function pluginSource(id: string): string {
  const source = tempDirSync(`irmia-plugin-model-budget-${id}-`);
  writeFileSync(join(source, 'plugin.json'), JSON.stringify({
    apiVersion: 2, id, version: '1.0.0', engine: { irmia: '>=0.1.0-beta.13' },
    runtime: { type: 'node', entry: 'main.mjs' }, permissions: ['tools.define', 'model.call'],
  }));
  writeFileSync(join(source, 'main.mjs'), `export async function activate(ctx){
    await ctx.tools.define({name:'complete',description:'complete',handler:async(args)=>{
      try {
        const reply=await ctx.model.complete({tier:'light',messages:[{role:'user',content:String(args?.text??'')}]});
        return {content:reply.text};
      } catch (error) { return {content:'code:'+String(error?.code)}; }
    }});
  }`);
  return source;
}

async function addPlugin(harness: Harness, id: string): Promise<void> {
  const pkg = harness.manager.install(pluginSource(id));
  await harness.host.startPackage(pkg);
}

function tracked(t: TestContext, harness: Harness): Harness {
  t.after(async () => { await harness.dispose(); });
  return harness;
}

test('插件模型调用：日预算拒绝返回 -32006，且不调用模型出口', async (t) => {
  let denied: string | null = null;
  let calls = 0;
  const harness = tracked(t, await createHarness({
    modelBudgetDenied: () => denied,
    completeModel: async (_plugin, request) => {
      calls += 1;
      return makeModelReply(`model:${request.messages[0]?.content ?? ''}`);
    },
  }));
  await addPlugin(harness, 'model-budget');

  assert.equal((await harness.callTool('model-budget__complete', { text: 'one' })).content, 'model:one');
  denied = 'daily exhausted';
  assert.equal((await harness.callTool('model-budget__complete', { text: 'two' })).content, 'code:-32006');
  assert.equal(calls, 1);
});

test('插件模型调用：跨插件并发重新判预算，失败后的队列仍可继续', async (t) => {
  let denied: string | null = null;
  let calls = 0;
  let failNext = false;
  const harness = tracked(t, await createHarness({
    modelBudgetDenied: () => denied,
    completeModel: async (_plugin, request) => {
      calls += 1;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      if (failNext) {
        failNext = false;
        throw new Error('synthetic model failure');
      }
      denied = 'daily exhausted after first call';
      return makeModelReply(String(request.messages[0]?.content ?? ''));
    },
  }));
  await addPlugin(harness, 'model-a');
  await addPlugin(harness, 'model-b');

  const first = await Promise.all([
    harness.callTool('model-a__complete', { text: 'one' }),
    harness.callTool('model-b__complete', { text: 'two' }),
  ]);
  const firstContents = first.map((result) => result.content).sort();
  assert.equal(firstContents[0], 'code:-32006');
  assert.ok(firstContents[1] === 'one' || firstContents[1] === 'two');
  assert.equal(calls, 1, '第二条并发请求必须在第一条记账后重新判预算');

  denied = null;
  failNext = true;
  const second = await Promise.all([
    harness.callTool('model-a__complete', { text: 'three' }),
    harness.callTool('model-b__complete', { text: 'four' }),
  ]);
  const secondContents = second.map((result) => result.content).sort();
  assert.equal(secondContents[0], 'code:-32603');
  assert.ok(secondContents[1] === 'three' || secondContents[1] === 'four');
  assert.equal(calls, 3);
});
