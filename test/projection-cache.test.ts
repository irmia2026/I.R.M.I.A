/**
 * 投影缓存测试 — src/state/projection-cache.ts
 *
 * 覆盖 docs/schema.md §8 的缓存形状、docs/design.md §4.2 的命中条件、
 * docs/review.md P2-18 的统一写盘规则，以及 milestones.md 的 T2 验收点
 * （写到一半崩 → 缓存被判定损坏并重算，不误用半截缓存）。
 *
 * 全部用临时目录 + 注入故障，不碰仓库里的任何文件。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BUDGET_ACCOUNTING_VERSION, emptyProjection, type Projection } from '../src/log/types.ts';
import {
  PROJECTION_CACHE_FILE,
  PROJECTION_CACHE_VERSION,
  isCacheValid,
  loadProjectionCache,
  loadProjectionCacheResult,
  saveProjectionCache,
  type ProjectionCacheDeps,
} from '../src/state/projection-cache.ts';
import { tempDir } from './helpers/temp-dirs.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function makeTempDir(): Promise<string> {
  return tempDir('irmia-projection-');
}

/**
 * 造一份「非平凡」投影：有 pending、有未闭合的工具调用、有定时器、有认领记录与预算。
 * 直接构造而不用 fold()：本模块的输入就是一份已成形的投影，与折叠实现解耦，
 * 折叠的正确性由 fold 自己的测试负责。
 */
function sampleProjection(): Projection {
  return {
    ...emptyProjection(),
    lastSeq: 8,
    watermark: 6,
    pending: [{ wakeSeq: 9, source: 'timer', claimCount: 0, dedupeKey: 'k1' }],
    openTurn: { turn: 7, step: 1 },
    openTools: [{ callId: 'call_a1', name: 'http_get', sideEffect: 'none', callSeq: 4 }],
    needsReview: [{ callId: 'call_b2', name: 'shell', at: '2026-09-29T14:00:00.000+08:00' }],
    budget: {
      // 口径版本：缓存要参与折叠，就必须说明这份累计是按哪一版口径折的（见 log/types.ts）。
      // 缺它 = 不认识 ⇒ 载入层判不可用（重建），这条契约由下面的"旧口径"用例钉住。
      budgetVersion: BUDGET_ACCOUNTING_VERSION,
      tokensToday: 120,
      tokensTodayHeavy: 0,
      tokensTodayLight: 120,
      cacheHitToday: 80,
      cacheMissToday: 20,
      tokensTask: 120,
      stepsThisTurn: 1,
      toolCallsThisStep: 1,
    },
    timers: [{ timerId: 't2', at: '2026-09-29T15:00:00.000+08:00', payload: { note: '自省' } }],
    claimedByTurn: { 7: [2] },
    intentions: [{ intentionId: 'i1', content: '看看日志', triggerAt: '2026-09-29T16:00:00.000+08:00' }],
    todoList: [{ content: '写投影缓存', status: 'completed' }],
    jobs: { j1: { command: 'pnpm build', turn: 7, startedAt: '2026-09-29T14:00:00.000+08:00' } },
    waitingHuman: null,
    lastExhausted: { daily: { at: '2026-09-29T13:00:00.000+08:00', limit: 100, actual: 120 } },
    dedupeKeys: ['k0', 'k1'],
    lastModelSuccessAt: '2026-09-29T14:00:06.000+08:00',
    firstEventAt: '2026-09-29T14:00:00.000+08:00',
    failStreak: 0,
    degraded: null,
    idleTicks: 2,
    lastWake: { source: 'timer', at: '2026-09-29T14:00:01.000+08:00' },
    lastAssistantText: '继续等',
    lastAssistantAt: '2026-09-29T14:00:04.000+08:00',
    deadLetters: [{ inputSeq: 3, claimCount: 3, at: '2026-09-29T14:00:03.000+08:00' }],
    lastArchiveAt: null,
    pressure: 0.55,
  };
}

/** 读缓存目录下的文件名（用于验证 tmp 残留与原子性） */
async function listDir(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

function readCacheText(dir: string): Promise<string> {
  return readFile(join(dir, PROJECTION_CACHE_FILE), 'utf8');
}

// ──────────────────────────────── 保存-读回 ────────────────────────────────

test('保存后读回：lastSeq 与 state 逐字段一致', async () => {
  const dir = await makeTempDir();
  try {
    const projection = sampleProjection();
    await saveProjectionCache(dir, projection, projection.lastSeq);

    const cache = await loadProjectionCache(dir);
    assert.notEqual(cache, null);
    assert.equal(cache?.lastSeq, projection.lastSeq);
    assert.equal(cache?.version, PROJECTION_CACHE_VERSION);
    // 深层相等：任何字段被漏写都会在这里暴露
    assert.deepEqual(cache?.state, projection);
    assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('落盘内容是 { version, lastSeq, state } 信封，且单行 JSON', async () => {
  const dir = await makeTempDir();
  try {
    const projection = sampleProjection();
    await saveProjectionCache(dir, projection, projection.lastSeq);

    const text = await readCacheText(dir);
    assert.equal(text.endsWith('\n'), true);
    assert.equal(text.trimEnd().includes('\n'), false);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ['lastSeq', 'state', 'version']);
    assert.equal(parsed['lastSeq'], projection.lastSeq);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('目标目录不存在时自动创建（mkdir -p 语义）', async () => {
  const dir = join(await makeTempDir(), 'data');
  const root = join(dir, '..');
  try {
    const projection = emptyProjection();
    await saveProjectionCache(dir, projection, 0);
    const cache = await loadProjectionCache(dir);
    assert.equal(cache?.lastSeq, 0);
    assert.deepEqual(cache?.state, projection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lastSeq 与 state.lastSeq 不一致的缓存不可用（拒绝静默制造错误水位）', async () => {
  const dir = await makeTempDir();
  try {
    const projection = sampleProjection();
    await writeFile(
      join(dir, PROJECTION_CACHE_FILE),
      JSON.stringify({ lastSeq: projection.lastSeq + 1, state: projection }),
      'utf8',
    );
    assert.equal(await loadProjectionCache(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────── 损坏与缺失 ────────────────────────────────

test('文件缺失返回 null，不抛错', async () => {
  const dir = await makeTempDir();
  try {
    assert.equal(await loadProjectionCache(dir), null);
    const result = await loadProjectionCacheResult(dir);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason.includes('不存在'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('手工写入半截 JSON（写一半崩）返回 null', async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, PROJECTION_CACHE_FILE), '{"lastSeq": 8, "state": {"lastS', 'utf8');
    assert.equal(await loadProjectionCache(dir), null);

    await writeFile(join(dir, PROJECTION_CACHE_FILE), '', 'utf8');
    assert.equal(await loadProjectionCache(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSON 合法但顶层不是对象 / lastSeq 非法 都返回 null', async () => {
  const dir = await makeTempDir();
  const path = join(dir, PROJECTION_CACHE_FILE);
  try {
    for (const body of ['[]', 'null', '"x"', '3', '{"state":{}}', '{"lastSeq":"8","state":{}}', '{"lastSeq":8.5,"state":{}}', '{"lastSeq":-1,"state":{}}']) {
      await writeFile(path, body, 'utf8');
      assert.equal(await loadProjectionCache(dir), null, `body=${body}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('state 形状大体不对（缺关键字段/类型错）返回 null', async () => {
  const dir = await makeTempDir();
  const path = join(dir, PROJECTION_CACHE_FILE);
  const good = sampleProjection();
  try {
    const broken: Array<Record<string, unknown>> = [
      {},
      { ...good, budget: undefined },
      { ...good, pending: {} },
      { ...good, pressure: 'high' },
      { ...good, watermark: -1 },
      { ...good, jobs: [] },
      { ...good, idleTicks: 1.5 },
    ];
    for (const state of broken) {
      await writeFile(path, JSON.stringify({ lastSeq: good.lastSeq, state }), 'utf8');
      assert.equal(await loadProjectionCache(dir), null, `state=${JSON.stringify(state).slice(0, 40)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('信封版本不认识时丢弃（不猜未知字段语义）', async () => {
  const dir = await makeTempDir();
  const path = join(dir, PROJECTION_CACHE_FILE);
  const projection = sampleProjection();
  try {
    await writeFile(path, JSON.stringify({ version: 99, lastSeq: projection.lastSeq, state: projection }), 'utf8');
    assert.equal(await loadProjectionCache(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('信封版本缺失：不再按当前版本接受——它只可能来自换口径之前那一版代码', async () => {
  // 这条契约 2026-10-05 刻意反转（原来是"版本缺失则按当前版本接受"）。
  // 理由：`budget` 那几格是**累计量**，一半按旧算式、一半按新算式就没法对账；
  // 而"没有版本号"正是旧文件的特征。宁可做一次全量重放，也不许把旧账续进新账。
  const dir = await makeTempDir();
  const path = join(dir, PROJECTION_CACHE_FILE);
  const projection = sampleProjection();
  try {
    await writeFile(path, JSON.stringify({ lastSeq: projection.lastSeq, state: projection }), 'utf8');
    assert.equal(await loadProjectionCache(dir), null, '旧文件（无信封版本）⇒ 丢弃、重建');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('投影里的口径版本缺失或过期：整份丢弃（累计量跨不了口径）', async () => {
  const dir = await makeTempDir();
  const path = join(dir, PROJECTION_CACHE_FILE);
  try {
    // ① 信封是当前版本，但 state 里没有 budgetVersion（旧口径写的投影）
    const stale = sampleProjection();
    delete (stale.budget as { budgetVersion?: number }).budgetVersion;
    await writeFile(path, JSON.stringify({ version: PROJECTION_CACHE_VERSION, lastSeq: stale.lastSeq, state: stale }), 'utf8');
    assert.equal(await loadProjectionCache(dir), null, 'budgetVersion 缺失 ⇒ 不认识 ⇒ 重建');

    // ② budgetVersion 是别的版本号（换口径那一刻盘上的样子）
    const older = sampleProjection();
    older.budget = { ...older.budget, budgetVersion: BUDGET_ACCOUNTING_VERSION - 1 };
    await writeFile(path, JSON.stringify({ version: PROJECTION_CACHE_VERSION, lastSeq: older.lastSeq, state: older }), 'utf8');
    assert.equal(await loadProjectionCache(dir), null, 'budgetVersion 过期 ⇒ 重建（这就是现场那两个数量级差异的来源）');

    // ③ 当前版本则照常命中（别把判据做成"永远重建"）
    const fresh = sampleProjection();
    await writeFile(path, JSON.stringify({ version: PROJECTION_CACHE_VERSION, lastSeq: fresh.lastSeq, state: fresh }), 'utf8');
    const loaded = await loadProjectionCache(dir);
    assert.equal(loaded?.lastSeq, fresh.lastSeq);
    assert.deepEqual(loaded?.state, fresh);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('读取抛非 ENOENT 错误（如 EACCES）也返回 null', async () => {
  const dir = await makeTempDir();
  try {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const result = await loadProjectionCacheResult(dir, {
      readFile: async () => {
        throw denied;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(await loadProjectionCache(dir, { readFile: async () => { throw denied; } }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ──────────────────────────────── 命中判定 ────────────────────────────────

test('lastSeq 与日志末尾一致才命中，落后或超前都失效', async () => {
  const dir = await makeTempDir();
  try {
    const projection = sampleProjection();
    await saveProjectionCache(dir, projection, projection.lastSeq);
    const cache = await loadProjectionCache(dir);

    assert.equal(isCacheValid(cache, projection.lastSeq), true);
    // 日志又追加了事件 → 缓存落后 → 失效
    assert.equal(isCacheValid(cache, projection.lastSeq + 1), false);
    // 日志被截断/换了一份 → 超前同样失效
    assert.equal(isCacheValid(cache, projection.lastSeq - 1), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缓存为 null / latestSeq 非法 一律失效', async () => {
  assert.equal(isCacheValid(null, 0), false);
  const projection = emptyProjection();
  const cache = { version: PROJECTION_CACHE_VERSION, lastSeq: 0, state: projection };
  assert.equal(isCacheValid(cache, 0), true);
  assert.equal(isCacheValid(cache, 1.5), false);
  assert.equal(isCacheValid(cache, -1), false);
  assert.equal(isCacheValid(cache, Number.NaN), false);
});

// ──────────────────────────────── tmp + rename 语义 ────────────────────────────────

test('rename 失败：原文件完好、无 .tmp 残留、并抛出可读错误', async () => {
  const dir = await makeTempDir();
  try {
    const first = sampleProjection();
    await saveProjectionCache(dir, first, first.lastSeq);
    const baseline = await readCacheText(dir);

    const second: Projection = { ...first, pressure: 0.9, lastSeq: 42, watermark: 42 };
    await assert.rejects(
      async () => {
        await saveProjectionCache(dir, second, 42, {
          rename: async () => {
            throw Object.assign(new Error('EPERM: rename 被拒'), { code: 'EPERM' });
          },
        });
      },
      /写入投影缓存/,
    );

    // 原文件仍是上一次成功的快照：崩溃在任何一步都不该丢缓存
    assert.equal(await readCacheText(dir), baseline);
    assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
    const cache = await loadProjectionCache(dir);
    assert.equal(cache?.lastSeq, first.lastSeq);
    assert.deepEqual(cache?.state, first);

    // 注入点撤掉后仍能正常覆盖
    await saveProjectionCache(dir, second, 42);
    assert.equal((await loadProjectionCache(dir))?.lastSeq, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createExclusive 失败（写盘满）：不产生 tmp 残留，原文件不受影响', async () => {
  const dir = await makeTempDir();
  try {
    const projection = emptyProjection();
    await saveProjectionCache(dir, projection, 0);
    const baseline = await readCacheText(dir);

    await assert.rejects(
      async () => {
        await saveProjectionCache(dir, { ...projection, lastSeq: 9 }, 9, {
          createExclusive: async () => {
            throw Object.assign(new Error('ENOSPC: 磁盘满'), { code: 'ENOSPC' });
          },
        });
      },
      /ENOSPC/,
    );

    assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
    assert.equal(await readCacheText(dir), baseline);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('首次保存即失败时不留下任何缓存文件（半截缓存才是危险品）', async () => {
  const dir = await makeTempDir();
  try {
    const projection = emptyProjection();
    await assert.rejects(
      async () => {
        await saveProjectionCache(dir, projection, 0, {
          createExclusive: async (path: string, data: string) => {
            // 模拟「文件名已建、内容只写了一半就崩」：留下半截文件，由 save 的失败路径清掉
            await writeFile(path, data.slice(0, Math.max(1, Math.floor(data.length / 2))), 'utf8');
            throw new Error('boom');
          },
        });
      },
      /写入投影缓存/,
    );
    assert.deepEqual(await listDir(dir), []);
    assert.equal(await loadProjectionCache(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('并发保存：不产生 .tmp 残留，盘上要么是空要么是某个完整信封（Windows 并发覆盖失败可接受）', async () => {
  const dir = await makeTempDir();
  try {
    const base = sampleProjection();
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 8; i++) {
      const projection: Projection = { ...base, lastSeq: 100 + i, watermark: 100 + i, idleTicks: i };
      writes.push(saveProjectionCache(dir, projection, 100 + i));
    }
    const settled = await Promise.allSettled(writes);

    // 并发 rename 到同一目标在 Windows 上可能 EPERM（目标被占用）：调用方重试即可，
    // 但绝不接受半截缓存或残留 tmp——这才是这条用例真正要钉的不变量
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        assert.match(String(outcome.reason), /写入投影缓存/);
      }
    }
    assert.equal(settled.some(outcome => outcome.status === 'fulfilled'), true);

    // 唯一文件名：只允许 projection.json 本体
    assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
    const cache = await loadProjectionCache(dir);
    if (cache !== null) {
      assert.equal(cache.lastSeq >= 100 && cache.lastSeq <= 107, true);
      assert.equal(cache.state.lastSeq, cache.lastSeq);
      assert.deepEqual(cache.state.pending, base.pending);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('连续覆盖写：逐个信封完整落地，lastSeq 单调跟上', async () => {
  const dir = await makeTempDir();
  try {
    const base = sampleProjection();
    for (let i = 0; i < 5; i++) {
      const projection: Projection = { ...base, lastSeq: 30 + i, watermark: 30 + i };
      await saveProjectionCache(dir, projection, 30 + i);
      const cache = await loadProjectionCache(dir);
      assert.equal(cache?.lastSeq, 30 + i);
      assert.deepEqual(cache?.state, projection);
      assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('并发写入失败时原文件仍可读（不留半截缓存给下次启动）', async () => {
  const dir = await makeTempDir();
  try {
    const first = sampleProjection();
    await saveProjectionCache(dir, first, first.lastSeq);
    const baseline = await readCacheText(dir);

    const failures = await Promise.allSettled([
      saveProjectionCache(dir, { ...first, lastSeq: 201 }, 201, {
        rename: async () => {
          throw Object.assign(new Error('EPERM: 目标被占用'), { code: 'EPERM' });
        },
      }),
      saveProjectionCache(dir, { ...first, lastSeq: 202 }, 202, {
        rename: async () => {
          throw Object.assign(new Error('EBUSY: 目标被占用'), { code: 'EBUSY' });
        },
      }),
    ]);
    assert.deepEqual(failures.map(f => f.status), ['rejected', 'rejected']);

    assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
    assert.equal(await readCacheText(dir), baseline);
    assert.equal((await loadProjectionCache(dir))?.lastSeq, first.lastSeq);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('覆盖写不先删原文件：写之前原文件一直可读（单线程顺序观察）', async () => {
  const dir = await makeTempDir();
  const path = join(dir, PROJECTION_CACHE_FILE);
  try {
    const first = sampleProjection();
    await saveProjectionCache(dir, first, first.lastSeq);

    let observedDuringWrite: string | null = null;
    const deps: Partial<ProjectionCacheDeps> = {
      createExclusive: async (tmpPath: string, data: string) => {
        // 真实实现进入写盘、rename 之前，原文件必须仍在（不是「先删再写」）
        observedDuringWrite = await readFile(path, 'utf8');
        assert.notEqual(tmpPath, path);
        await writeFile(tmpPath, data, 'utf8');
      },
    };
    const second: Projection = { ...first, lastSeq: 77, watermark: 77 };
    await saveProjectionCache(dir, second, 77, deps);

    const envelope = `${JSON.stringify({ version: PROJECTION_CACHE_VERSION, lastSeq: first.lastSeq, state: first })}\n`;
    assert.equal(observedDuringWrite, envelope);
    assert.equal((await loadProjectionCache(dir))?.lastSeq, 77);
    assert.deepEqual(await listDir(dir), [PROJECTION_CACHE_FILE]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
