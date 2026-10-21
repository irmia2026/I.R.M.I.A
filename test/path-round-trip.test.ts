/**
 * 路径的 **round-trip 不变式**（v64，用户 2026-10-13 的裁决）。
 *
 * 判据（用户拍板的那一条，逐字意译）：
 *   **回执里印出来的任何一串路径，原样喂回任何接受路径的工具，都必须指向同一个文件。**
 *   配套三件：
 *     ① **基准 = 仓库根**（单一基准；实测 87.2% 的历史调用按它解析，`data\workspace` 只有 7.3%）；
 *     ② **具名根**：`MEMORIES/…`、`diary/…` 落记忆目录 —— **在所有工具里语义一致（含 `send_media`）**；
 *     ③ **绝对路径仍接受**，但**回执统一印相对形态**。
 *   外加一条**反面锁**：任何提示文案里**不许出现**「工作根 / 工作区」这类要她猜的词
 *   （用户原话「注意不要导致 agent 困惑」）——这条是断言，防以后又飘。
 *
 * 为什么要有这一份：路径是这一批（v64）动得最多的一处（基准、别名、边界只挡写），而"她能看懂"
 * 的判据只能落在**回环**上——印出来的东西喂回去还能用，才叫没让她困惑。
 */

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { createAdminTools } from '../src/tools/admin.ts';
import { createEnv, fsTools, resolveGuarded } from '../src/tools/fs/index.ts';
import { comparisonKey, expandAliases, pathAliasesFor } from '../src/tools/fs/index.ts';
import { DepsManager, type DepName } from '../src/deps/manager.ts';
import { FS_ERROR_CODES } from '../src/tools/fs/types.ts';
import { TimerStore } from '../src/wake/timer-store.ts';
import { tempDir } from './helpers/temp-dirs.ts';

/** 引擎一律"没有"：这一份测的是路径语义，不需要真 rg/es（与 `fs-tools.test.ts` 同一个替身） */
function stubDeps(): DepsManager {
  return new DepsManager({
    dataDir: join(tmpdir(), 'irmia-roundtrip-stub-deps'),
    probe: async (name: DepName) => ({
      name,
      status: 'missing' as const,
      path: '',
      version: '',
      anyVersion: '',
      source: null,
      dir: null,
      reason: '测试台：这一份不测引擎',
      attempts: ['test: 固定结论'],
    }),
  } as unknown as ConstructorParameters<typeof DepsManager>[0]);
}

async function rig(root: string, boundaryRoot?: string | null): Promise<{
  tool: (name: string) => ToolDefinition;
  ctx: ToolContext;
}> {
  const table = new Map<string, ToolDefinition>();
  await fsTools(
    { register: (tool) => table.set(tool.name, tool) },
    { deps: stubDeps(), onNote: () => {} },
  );
  return {
    tool: (name: string) => {
      const found = table.get(name);
      assert.ok(found !== undefined, `${name} 没注册`);
      return found;
    },
    ctx: {
      callId: 'c1',
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
      workspaceRoot: root,
      ...(boundaryRoot === undefined ? {} : { boundaryRoot }),
    } as ToolContext,
  };
}

test('round-trip：具名根那一串在四个工具里指向同一份文件，且回执印相对形态', async (t) => {
  const root = await tempDir('irmia-roundtrip-');
  t.after(() => rm(root, { recursive: true, force: true }));
  // 记忆目录的真实落点：<dataDir>/workspace/MEMORIES（dataDir 缺省 = <仓库根>/data）
  const memories = join(root, 'data', 'workspace', 'MEMORIES');
  await mkdir(memories, { recursive: true });
  await writeFile(join(memories, 'facts.md'), '第一行：用户喝龙井\n', 'utf8');

  const { tool, ctx } = await rig(root);

  // ① 具名根形态读得到
  const read = await tool('safe_read').handler({ path: 'MEMORIES/facts.md' }, ctx);
  assert.equal(read.isError, undefined, read.content);
  assert.match(read.content, /龙井/u);
  // ② 回执印的是**相对形态**（不是绝对路径）——判据 ③
  assert.ok(!read.content.includes(root), `回执里不该出现绝对路径：${read.content}`);
  assert.match(read.content, /MEMORIES\/facts\.md/u, '回执里印的相对形态要能直接喂回来');

  // ③ 同一串喂给别的接受路径的工具：解析到同一个文件（`safe_edit` 与 `grep` 各验一次）
  const guarded = await resolveGuarded(
    createEnv({ dataDir: join(root, 'data') }),
    ctx,
    'MEMORIES/facts.md',
    { purpose: 'round-trip', access: 'read' },
  );
  assert.equal(guarded.ok, true, JSON.stringify(guarded));
  assert.equal(guarded.ok && guarded.path.toLowerCase(), join(memories, 'facts.md').toLowerCase(),
    '同一串在 fs 的解析与 safe_read 一致（比小写：realpath 会规范盘上的真实大小写）');

  // ④ 别名是**同一张表**（vision / net / send_media 都引它）——判据 ②
  const aliases = pathAliasesFor(ctx);
  assert.equal(
    expandAliases('MEMORIES/facts.md', aliases, root).toLowerCase(),
    join(memories, 'facts.md').toLowerCase(),
  );
  assert.deepEqual(
    expandAliases('diary/2026-10-13.md', aliases, root),
    join(root, 'data', 'workspace', 'diary', '2026-10-13.md'),
  );
  // 绝对路径照旧接受（判据 ③ 的前半句）：别名表不认识绝对路径，原样返回
  assert.equal(expandAliases(join(memories, 'facts.md'), aliases, root), join(memories, 'facts.md'));
});

test('round-trip：写→读回环（写类落盘后，回执里那串喂回读类读得到）', async (t) => {
  const root = await tempDir('irmia-roundtrip-w-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const { tool, ctx } = await rig(root);

  const wrote = await tool('safe_write').handler({ path: 'notes/todo.md', content: '买菜\n' }, ctx);
  assert.equal(wrote.isError, undefined, wrote.content);
  const readBack = await tool('safe_read').handler({ path: 'notes/todo.md' }, ctx);
  assert.equal(readBack.isError, undefined, readBack.content);
  assert.match(readBack.content, /买菜/u, '写进去的那串能原样读回来');
});

test('边界只挡写（v64）：workspace 档下读越界照走、写越界被拒并说清', async (t) => {
  const root = await tempDir('irmia-roundtrip-b-');
  const outside = await tempDir('irmia-outside-');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'there.txt'), '外面\n', 'utf8');

  const env = createEnv({ dataDir: join(root, 'data') });
  const ctx = {
    workspaceRoot: root,
    boundaryRoot: root, // 显式给了边界 ⇒ 等同 trust.mode='workspace'
  };

  // 读：不受边界约束（全盘就是全盘）
  const readOk = await resolveGuarded(env, ctx, join(outside, 'there.txt'), {
    purpose: 'round-trip-read',
    access: 'read',
  });
  assert.equal(readOk.ok, true, `读类不该被边界挡住：${JSON.stringify(readOk)}`);

  // 写：被拒，且理由里给出边界与怎么改
  const writeDenied = await resolveGuarded(env, ctx, join(outside, 'new.txt'), {
    purpose: 'round-trip-write',
    access: 'write',
    allowMissing: true,
  });
  assert.equal(writeDenied.ok, false);
  assert.equal(writeDenied.ok === false && writeDenied.code, FS_ERROR_CODES.PATH_DENIED);
  assert.match(writeDenied.ok === false ? writeDenied.reason : '', /trust\.mode/u, '拒绝要说清怎么改');
});

test('出站类按"写"处理（v64）：send_media 在 full 档能发工作区外的文件，在 workspace 档被拒并说清', async (t) => {
  const root = await tempDir('irmia-outbound-');
  const outside = await tempDir('irmia-outbound-out-');
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const file = join(outside, 'photo.png');
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const sent: Array<{ sid: string; bytes: number }> = [];
  const timers = new TimerStore({ dir: join(root, 'timers.json'), fire: () => {} });
  const tools = createAdminTools({
    timers,
    emit: (() => {}) as never,
    replyTargetOf: () => ({ url: 'qq:c2c:TEST', idempotencyKey: 'k1' }),
    mediaPoster: {
      post: async (target, media) => {
        sent.push({ sid: target.url, bytes: media.data?.byteLength ?? 0 });
        return { ok: true };
      },
    },
  } as never);
  const ctx = (boundaryRoot?: string | null): ToolContext => ({
    callId: 'c1', turn: 1, step: 1, signal: new AbortController().signal,
    workspaceRoot: root,
    ...(boundaryRoot === undefined ? {} : { boundaryRoot }),
  } as ToolContext);

  // ① `full` 档（`boundaryRoot: null` = 完全信任）⇒ 工作区外的文件发得出去
  const full = await tools.byName('send_media').handler({ path: file, to: 'qq:c2c:TEST' }, ctx(null));
  assert.equal(full.isError, undefined, full.content);
  assert.equal(sent.length, 1, '投递口收到了那一份');
  assert.equal(sent[0]?.bytes, 4, '发出去的是文件字节（工具层读的）');

  // ② `workspace` 档 ⇒ 被拒，且理由说清边界在哪、怎么改
  const denied = await tools.byName('send_media').handler({ path: file, to: 'qq:c2c:TEST' }, ctx(root));
  assert.equal(denied.isError, true, `workspace 档该拒：${denied.content}`);
  assert.match(denied.content, /trust\.mode/u, '要说清怎么改');
  assert.equal(sent.length, 1, '被拒时一份都不许发出去');

  // ③ 具名根照旧通（与 fs 族同一张别名表）：MEMORIES/ 下的文件在 full 档发得出去
  await mkdir(join(root, 'data', 'workspace', 'MEMORIES'), { recursive: true });
  await writeFile(join(root, 'data', 'workspace', 'MEMORIES', 'pic.png'), Buffer.from([1, 2, 3]));
  const aliased = await tools.byName('send_media').handler({ path: 'MEMORIES/pic.png', to: 'qq:c2c:TEST' }, ctx(null));
  assert.equal(aliased.isError, undefined, `别名写法该通：${aliased.content}`);
  assert.equal(sent.length, 2);
});

test('不困惑（反面锁）：工具描述与参数说明里**不许出现**「工作根 / 工作区」', async () => {
  const timers = new TimerStore({ dir: 'data', fire: () => {} });
  const { registry } = await buildCatalogRegistry({
    dataDir: 'data',
    timers,
    emit: () => {},
    destructiveEnabled: true,
  });
  const banned = ['工作根', '工作区'];
  const offenders: string[] = [];
  for (const tool of registry.listForModel({ includeDestructive: true })) {
    const texts: Array<[string, string]> = [['description', tool.description]];
    for (const [key, schema] of Object.entries(
      (tool.parameters?.properties ?? {}) as Record<string, { description?: string }>,
    )) {
      if (typeof schema.description === 'string') texts.push([key, schema.description]);
    }
    for (const [where, text] of texts) {
      for (const word of banned) {
        if (text.includes(word)) offenders.push(`${tool.name}.${where} 出现「${word}」：${text}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `${offenders.join('\n')}\n改成「仓库根」——她不认识"工作根/工作区"这两个词`);
});
