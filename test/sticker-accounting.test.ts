import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { EventLog } from '../src/log/event-log.ts';
import { emptyProjection, type AppEvent } from '../src/log/types.ts';
import { appendVisionConsumption } from '../src/main.ts';
import { tempDir } from './helpers/temp-dirs.ts';
import { stickerModelResponse } from './helpers/sticker-fixtures.ts';

test('sticker accounting：真实 usage 带 stickerTagging 标记并进入预算', async (t) => {
  const dir = await tempDir('irmia-sticker-accounting-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => { log.close(); });
  const projection = emptyProjection();
  const response = stickerModelResponse('{}');
  appendVisionConsumption(
    { log, projection, now: () => new Date('2026-10-31T04:00:00.000Z') },
    response, 0, 0, { origin: 'stickers/tagger', stickerTagging: true, model: 'vision-test' },
  );
  const events: AppEvent[] = [];
  for await (const event of log.readAll()) events.push(event);
  assert.equal(events.length, 1);
  const data = events[0]!.data as Record<string, unknown>;
  assert.equal(data['stickerTagging'], true);
  assert.equal(data['lane'], 'light');
  assert.equal(data['inputTokens'], 100);
  assert.equal(data['outputTokens'], 20);
  assert.equal(data['finishReason'], 'completed');
  assert.equal(data['origin'], undefined, 'origin 在事件信封而不是 data');
  assert.equal(events[0]!.origin, 'stickers/tagger');
  assert.equal(projection.budget.tokensTodayLight, 110);
});

test('sticker accounting：模型失败写 0 用量失败账，不伪造成本', async (t) => {
  const dir = await tempDir('irmia-sticker-accounting-fail-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await EventLog.open(join(dir, 'events'));
  t.after(() => { log.close(); });
  const projection = emptyProjection();
  appendVisionConsumption(
    { log, projection, now: () => new Date('2026-10-31T04:00:00.000Z') },
    null, 0, 0, { origin: 'stickers/tagger', stickerTagging: true, model: 'vision-test' },
  );
  for await (const event of log.readAll()) {
    assert.equal(event.type, 'budget/consumed');
    if (event.type !== 'budget/consumed') continue;
    assert.equal(event.data.stickerTagging, true);
    assert.equal(event.data.finishReason, 'failed');
    assert.equal(event.data.inputTokens, 0);
    assert.equal(event.data.outputTokens, 0);
    assert.equal(event.data.model, 'vision-test');
  }
  assert.equal(projection.failStreak, 1);
});
