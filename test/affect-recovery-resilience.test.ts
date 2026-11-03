/**
 * Affect 重建韧性：
 *   ① 坏 / 未来版本的 `affect/appraised` 只跳过（不拖垮 fold 与启动），并计入 repairs/日志；
 *   ② 缺 `version` 的旧快照整份丢弃，改走全量重放（不再靠 shape 兜底放行）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeAppraisedData } from '../src/affect/engine.ts';
import { EventLog } from '../src/log/event-log.ts';
import type { Projection } from '../src/log/types.js';
import type { AppEvent } from '../src/log/types.js';
import { fold } from '../src/state/fold.ts';
import { saveProjectionCache } from '../src/state/projection-cache.ts';
import { loadLatestSnapshot, writeSnapshot } from '../src/state/snapshot.ts';
import { recover, timersOf } from '../src/runtime/recover.ts';

const NOW = '2026-10-29T10:00:00.000Z';
const AP = { r: 1, s: 0, u: -0.8, g: 0, b: 0, n: 0.2, z: 0.5, c: 0.1, q: 1 };

const VALID = makeAppraisedData({
  sourceSeq: 1,
  evaluatedAtMs: Date.parse(NOW),
  sourceWeight: 1,
  appraisal: AP,
  reasonCode: 'owner_setback',
});
const BAD = { ...VALID, version: 99, sourceSeq: 2 };

const VALID_EVENT = {
  seq: 1,
  ts: NOW,
  type: 'affect/appraised',
  visibility: 'internal',
  data: VALID,
} as AppEvent;
const BAD_EVENT = {
  seq: 2,
  ts: '2026-10-29T10:01:00.000Z',
  type: 'affect/appraised',
  visibility: 'internal',
  data: BAD,
} as AppEvent;

function cloneProjection(p: Projection): Projection {
  return JSON.parse(JSON.stringify(p)) as Projection;
}

async function writeLog(dir: string, events: readonly AppEvent[]): Promise<void> {
  const log = await EventLog.open(join(dir, 'events'));
  try {
    for (const event of events) {
      log.append({ ...event, seq: log.nextSeq() } as AppEvent, { sync: true });
    }
  } finally {
    log.close();
  }
}

async function disposeRecovered(recovered: Awaited<ReturnType<typeof recover>> | null): Promise<void> {
  timersOf(recovered as NonNullable<typeof recovered>)?.stop();
  recovered?.log.close();
  recovered?.lock.release();
}

async function withRecovered(
  dir: string,
  body: (recovered: Awaited<ReturnType<typeof recover>>, lines: string[]) => void | Promise<void>,
): Promise<void> {
  let recovered: Awaited<ReturnType<typeof recover>> | null = null;
  const lines: string[] = [];
  try {
    recovered = await recover({
      dataDir: dir,
      log: (_level, message) => {
        lines.push(message);
      },
    });
    await body(recovered, lines);
  } finally {
    await disposeRecovered(recovered);
  }
}

function expectedProjection(): Projection {
  return fold([VALID_EVENT]);
}

/** fold 本身：坏事件跳过并计数，不中断、不折。 */
test('fold：坏的 affect/appraised 跳过并计数，后续事件照常折', () => {
  const skipped: number[] = [];
  const p = fold([VALID_EVENT, BAD_EVENT], (event) => {
    skipped.push(event.seq);
  });
  assert.deepEqual(skipped, [2], '只跳过坏的那一条');
  assert.equal(p.lastSeq, 2, 'lastSeq 仍推进到末尾');
  assert.deepEqual(p.affect, expectedProjection().affect, '情绪状态等于跳过坏事件后的结果');
});

/** 全量重放：无 cache/快照，recover 必须跳过坏事件并启动。 */
test('recover 全量重放：坏 affect 事件不拖垮启动，状态等于跳过它的结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-affect-bad-full-'));
  try {
    await writeLog(dir, [VALID_EVENT, BAD_EVENT]);
    await withRecovered(dir, (recovered, lines) => {
      assert.deepEqual(recovered.projection.affect, expectedProjection().affect);
      assert.ok(
        recovered.repairs.some(line => line.includes('跳过 1 条无法应用的 affect/appraised')),
        `repairs 必须记录跳过：${recovered.repairs.join(' / ')}`,
      );
      assert.ok(
        lines.some(line => line.includes('投影重建跳过无法应用的事件')),
        `日志必须记录跳过：${lines.join(' / ')}`,
      );
      assert.ok(lines.some(line => line.includes('没有可用快照，投影由日志全量折叠')));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 缓存命中：缓存里已经是跳过后的状态；启动不得因日志里的坏事件失败。 */
test('recover 缓存命中：坏事件不拖垮启动，情绪状态沿用跳过后的缓存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-affect-bad-cache-'));
  try {
    await writeLog(dir, [VALID_EVENT, BAD_EVENT]);
    const cached = cloneProjection(expectedProjection());
    cached.lastSeq = 2;
    await saveProjectionCache(dir, cached, 2);
    await withRecovered(dir, (recovered, lines) => {
      assert.deepEqual(recovered.projection.affect, expectedProjection().affect);
      assert.ok(lines.some(line => line.includes('投影取自缓存')));
      assert.equal(
        recovered.repairs.some(line => line.includes('跳过')),
        false,
        '缓存命中不会重新折坏事件，也就不该伪造一条跳过',
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 快照续算：快照只覆盖好的那条，坏的那条在增量折叠时被跳过并记账。 */
test('recover 快照续算：坏 affect 事件被跳过并计入 repairs/日志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-affect-bad-snapshot-'));
  try {
    await writeLog(dir, [VALID_EVENT, BAD_EVENT]);
    // 快照只覆盖 seq 1；seq 2（坏事件）留给增量折叠。
    await writeSnapshot(dir, expectedProjection());
    await withRecovered(dir, (recovered, lines) => {
      assert.deepEqual(recovered.projection.affect, expectedProjection().affect);
      assert.ok(lines.some(line => line.includes('投影由快照增量折叠')));
      assert.ok(
        recovered.repairs.some(line => line.includes('跳过 1 条无法应用的 affect/appraised')),
        `repairs 必须记录跳过：${recovered.repairs.join(' / ')}`,
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** 缺 version 的旧快照：必须整份丢弃，改走全量重放。 */
test('snapshot：缺 version 的快照整份丢弃，恢复走全量重放且结果正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-affect-old-snapshot-'));
  try {
    await writeLog(dir, [VALID_EVENT]);
    const written = await writeSnapshot(dir, expectedProjection());
    const envelope = JSON.parse(await readFile(written.path, 'utf8')) as Record<string, unknown>;
    delete envelope['version'];
    await writeFile(written.path, `${JSON.stringify(envelope)}\n`, 'utf8');

    assert.equal(await loadLatestSnapshot(dir), null, '缺 version 的快照必须读不出来');

    await withRecovered(dir, (recovered, lines) => {
      assert.deepEqual(recovered.projection.affect, expectedProjection().affect);
      assert.ok(
        lines.some(line => line.includes('没有可用快照，投影由日志全量折叠')),
        `必须走全量重放：${lines.join(' / ')}`,
      );
      assert.equal(
        lines.some(line => line.includes('投影由快照增量折叠')),
        false,
        '缺 version 的快照不许被采信',
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
