/**
 * 关系档案路由测试 — src/persona/relationship.ts（+ 三个带人入口）
 *
 * 这条路径此前**一条测试都没有**，而测试只覆盖了「注入后怎么渲染」（render.test.ts）与
 * 「文件怎么读写」（CLI / GUI 的 persona 通道），唯独中间那段「唤醒 → 找到档案 → 注入」空着。
 * 于是两个真问题一直躺着没被发现：
 *   ① 手动唤醒根本不带 person —— 本机用户在聊天框里说了半天，他的档案永远注入不了；
 *   ② real-loop 与 replay 各写一份判据，口径随即漂移（real-loop 支持了 wake/channel，
 *      replay 还只认 webhook/manual），重放出来的请求与当时对不上。
 * 现在判据只有一份（`relationshipForWake`），本文件按**来源**逐条钉住它。
 *
 * **v78（2026-10-22）起它返回的是索引**（`{who, path, chars, sections}`），正文不再进这个
 * 结构——本文件的断言跟着改成路径/字数/小节名。索引怎么渲染、正文怎么按需读，归
 * `test/relationship-index.test.ts`（那一支是用户点名的四条验收）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { ownerPersonOf, relationshipForWake } from '../src/persona/relationship.ts';
import { writeWakeNote } from '../src/cli.ts';
import { defaultVisibility } from '../src/log/types.ts';
import type { AppEvent } from '../src/log/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const roots: string[] = [];

/** 造一个只带 data 的唤醒事件：路由只读 type 与 data.person */
function wake<T extends AppEvent>(type: T['type'], data: Record<string, unknown>): T {
  return {
    seq: 1,
    ts: '2026-10-01T00:00:00.000Z',
    type,
    data,
    visibility: defaultVisibility(type),
  } as unknown as T;
}

/** 临时数据目录，可预置若干份关系档案 */
function fixture(relationships: Record<string, string> = {}): string {
  const dir = tempDirSync('irmia-rel-');
  roots.push(dir);
  const rel = join(dir, 'persona', 'RELATIONSHIPS');
  mkdirSync(rel, { recursive: true });
  for (const [who, content] of Object.entries(relationships)) {
    writeFileSync(join(rel, `${who}.md`), content, 'utf8');
  }
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('关系档案路由 · 带人的三种来源', () => {
  test('手动唤醒（本机用户）：person 命中就注入', () => {
    const body = '# 阿岚\n\n## 牵挂\n- 他还在改代码\n';
    const dir = fixture({ 阿岚: body });
    const note = relationshipForWake(
      wake('wake/manual', { note: '在吗', person: '阿岚' }),
      dir,
    );
    assert.ok(note, '用户在聊天框说话，档案必须进上下文');
    assert.equal(note.who, '阿岚');
    // v78：注入的是**索引**（路径 / 字数 / 小节名），正文要她自己 safe_read
    assert.equal(note.path, 'persona/RELATIONSHIPS/阿岚.md');
    assert.equal(note.chars, Array.from(body).length);
    assert.deepEqual(note.sections, ['牵挂']);
    assert.equal('content' in note, false, '正文不许进索引结构');
  });

  test('IM 来话（wake/channel）：按发送者标识命中', () => {
    // 这条正是 replay 曾经漏掉的：real-loop 认它，重放不认，于是重放少一段档案
    const dir = fixture({ user_openid_abc: '# 某位群友\n' });
    const note = relationshipForWake(
      wake('wake/channel', { channel: 'qq-official', chatType: 'group-at', person: 'user_openid_abc' }),
      dir,
    );
    assert.equal(note?.who, 'user_openid_abc');
  });

  test('外部 webhook：payload 里给 person 就注入', () => {
    const dir = fixture({ ci: '# CI\n' });
    assert.equal(relationshipForWake(wake('wake/webhook', { path: '/hook', body: '{}', person: 'ci' }), dir)?.who, 'ci');
  });

  test('不带人的唤醒一律不注入', () => {
    const dir = fixture({ 阿岚: '# x\n' });
    const withoutPerson: AppEvent[] = [
      wake('wake/manual', { note: '脚本注入' }),
      wake('wake/timer', { timerId: 't1', scheduledAt: 'x', firedAt: 'y' }),
      wake('wake/heartbeat', { quietSeconds: 900, idleTicks: 1, pressure: 0 }),
      wake('wake/file', { path: 'INBOX.md', kind: 'changed' }),
      wake('wake/intention', { intentionId: 'i1', content: 'x' }),
      wake('wake/job', { jobId: 'j1' }),
    ];
    for (const e of withoutPerson) {
      assert.equal(relationshipForWake(e, dir), null, `${e.type} 不该注入档案`);
    }
    assert.equal(relationshipForWake(null, dir), null);
  });
});

describe('关系档案路由 · 边界', () => {
  test('没有这个人的档案：不注入、不报错、不猜', () => {
    const dir = fixture({ 别人: '# x\n' });
    assert.equal(relationshipForWake(wake('wake/manual', { note: 'x', person: '不存在的名字' }), dir), null);
  });

  test('person 为空或只有空白：按「没人」处理', () => {
    const dir = fixture({ owner: '# owner\n' });
    for (const person of ['', '   ', '\t']) {
      assert.equal(relationshipForWake(wake('wake/manual', { note: 'x', person }), dir), null);
    }
    // 非字符串同理（坏数据不该让它去猜一个文件名）
    assert.equal(relationshipForWake(wake('wake/manual', { note: 'x', person: 42 }), dir), null);
  });

  test('person 里带路径分隔符：被替换，读不到 persona/ 之外去', () => {
    const dir = fixture({ owner: '# owner\n' });
    // 归档时 `/ \ : ` 这些一律换成下划线（loader 的同一条纪律）
    assert.equal(relationshipForWake(wake('wake/manual', { note: 'x', person: '../secret' }), dir), null);
    assert.equal(relationshipForWake(wake('wake/manual', { note: 'x', person: 'a/b' }), dir), null);
  });

  test('前后空白被裁掉后再找文件', () => {
    const dir = fixture({ 阿岚: '# x\n' });
    assert.equal(relationshipForWake(wake('wake/manual', { note: 'x', person: '  阿岚  ' }), dir)?.who, '阿岚');
  });
});

describe('ownerPersonOf · 手动唤醒该带谁', () => {
  test('正常取值去掉首尾空白', () => {
    assert.equal(ownerPersonOf({ persona: { owner: ' 阿岚 ' } }), '阿岚');
  });

  test('空串回落 "owner"（不因为一个空字段就变成没有用户）', () => {
    assert.equal(ownerPersonOf({ persona: { owner: '' } }), 'owner');
    assert.equal(ownerPersonOf({ persona: { owner: '   ' } }), 'owner');
  });
});

describe('带人入口 · 看门文件（CLI irmia wake）', () => {
  test('person 落进看门文件，人会被主进程拾取', () => {
    const dir = fixture();
    const path = writeWakeNote(dir, { note: '在吗', person: '阿岚' }, new Date('2026-10-01T00:00:00.000Z'));
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal(payload['note'], '在吗');
    assert.equal(payload['person'], '阿岚');
  });

  test('不带人时不写 person 字段（脚本注入的形态）', () => {
    const dir = fixture();
    const path = writeWakeNote(dir, { note: '自动注入' }, new Date('2026-10-01T00:00:01.000Z'));
    const payload = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    assert.equal('person' in payload, false);
  });
});

describe('关系档案 · 会话级回退（她自己维护的"群"这一层）', () => {
  test('群里说话：发言者没有档案时，退一步用这个会话自己的档案', () => {
    // 群消息的 person 是**发言者**。一个刚冒头的人在群里说话，按 person 查必然没有档案——
    // 于是她可能早写过的"这群一贯聊装机，气氛还行"永远注入不进来。
    // 用户要的是"她自己维护群聊与某个人的画像"，这两层都得能落到眼前。
    const dir = fixture({ GROUP1: '这群一贯聊装机，气氛还行' });
    const note = relationshipForWake(
      wake('wake/channel', { channel: 'qq-official', chatType: 'group', person: 'stranger', chatId: 'GROUP1' }),
      dir,
    );
    assert.deepEqual(note, {
      who: 'GROUP1',
      path: 'persona/RELATIONSHIPS/GROUP1.md',
      chars: 12,
      sections: [],
    });
  });

  test('发言者自己有档案时，优先用他自己的那本', () => {
    const dir = fixture({ 老张: '熟人，说话客气', GROUP1: '这群一贯聊装机' });
    const note = relationshipForWake(
      wake('wake/channel', { channel: 'qq-official', chatType: 'group-at', person: '老张', chatId: 'GROUP1' }),
      dir,
    );
    assert.equal(note?.who, '老张', '命中发言者自己的那一本');
    assert.equal(note?.path, 'persona/RELATIONSHIPS/老张.md');
    assert.equal(note?.chars, 7);
  });

  test('两个都没有 → null：不注入、不报错、不猜', () => {
    const dir = fixture({});
    assert.equal(
      relationshipForWake(
        wake('wake/channel', { channel: 'qq-official', chatType: 'group', person: 'nobody', chatId: 'GROUP9' }),
        dir,
      ),
      null,
    );
  });

  test('私聊没有会话级回退的余地：person 与 chatId 相同，不会来回查两遍', () => {
    const dir = fixture({});
    assert.equal(
      relationshipForWake(
        wake('wake/channel', { channel: 'qq-official', chatType: 'c2c', person: 'U1', chatId: 'U1' }),
        dir,
      ),
      null,
    );
  });

  test('QQ 单聊：openid 经 aliases 解析成人名后**命中人名档案**（2026-10-05 修的真 bug）', () => {
    // 现场形状：档案文件名是人名（`RELATIONSHIPS/阿岚.md`），而唤醒里的 person 是 openid。
    // 不做身份归一 ⇒ 拿 openid 找文件必然落空 ⇒ 他在 QQ 单聊里说话没有档案、在 GUI 里说话却有。
    const dir = fixture({ 阿岚: '他是我用户。' });
    const mem = join(dir, 'workspace', 'MEMORIES');
    mkdirSync(mem, { recursive: true });
    writeFileSync(
      join(mem, 'aliases.md'),
      '# 别名\nqq:c2c:OPENID1 = 阿岚（用户）\n',
      'utf8',
    );
    const note = relationshipForWake(
      wake('wake/channel', {
        channel: 'qq-official', chatType: 'c2c', person: 'OPENID1', chatId: 'OPENID1',
      }),
      dir,
    );
    assert.equal(note?.who, '阿岚', '解析出来的人名要用于寻址');
    assert.equal(note?.path, 'persona/RELATIONSHIPS/阿岚.md', '路径也用解析后的名字');
    assert.equal(note?.chars, Array.from('他是我用户。').length);
  });

  test('没有 aliases 表时行为与从前一致：不猜、不报错（群/成员档案仍按 sid 命中）', () => {
    const dir = fixture({ OPENID1: '按 openid 命名的档案' });
    // 故意不写 aliases.md：解析不到额外线索，应当回到 person/chatId 两步
    const note = relationshipForWake(
      wake('wake/channel', {
        channel: 'qq-official', chatType: 'c2c', person: 'OPENID1', chatId: 'OPENID1',
      }),
      dir,
    );
    assert.equal(note?.who, 'OPENID1', '没有表就照旧按原样寻址');
  });
});