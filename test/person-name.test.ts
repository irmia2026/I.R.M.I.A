/**
 * 认人那一条路 —— 2026-10-11 用户报「别名系统貌似没有正常运作？她在群里没认出我」那一笔
 *
 * 现场（只读 `data/events` 复盘的）：10-07 02:26–02:49 他在 OneBot 群里说话，她的 `read_channel`
 * 回执里他一律显示成 **「群友A（群昵称：用户）」**（机器在第一次见面时发的一次性占位名），
 * 她当众回他"这会儿光一串号我还认不了你"，还回了句带引号的"你这位'用户'"；直到 03:05 那一行才
 * 变成「用户（OWNER）」。他最后是靠她另写的一条 `onebot:c2c:<QQ号>` 才对上名的。
 *
 * 顺着这条线查出来的**两处**（都在这一版修了，但只有第一处与上面那一分钟直接相关）：
 *   ① 通知行根本不查名字真源（此刻层「预警：」那一行、点名那句），群里一律印裸 QQ 号/openid
 *      ——见 `test/self-brief.test.ts` 的「通知行 · 发言人那一格走名字真源」；
 *   ② 她按 `aliases.md` 段头那句"只在认人时用"写下的**裸 id 行**（她真写了六条：`1 号`、`甲`、
 *      `丙`、`Linre`、用户的官方 openid…）**框架一条都没消费**——`parseAliases` 只收 sid 那类键。
 *      这个文件用**真的 RealLoop + 真的盘**验这一档接上之后的四件事。
 *
 * 判据一处：`real-loop.personNameOf`（contacts > 她会话别名 > 她群成员别名 > 群成员档案），
 * `read_channel` 每行那个"谁"、唤醒正文的 `personLabel`、话题概括、两行通知全问它。
 *
 * 四件事（替身只有模型通道）：① 只有群成员别名（裸 id）时认得出；①b `#` 标题行里的等号**不算**
 * 声明（证明这一层没偷偷放宽）；② 冲突时 contacts > 会话别名 > 成员别名；③ 三处都没有 = null
 * ——裸 id 只在"确实没有名字"时才显示；④ 别名只改"叫什么"，**不改"谁能指挥她"**。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { trustOfWake } from '../src/runtime/trust.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';

const TZ = 'Asia/Shanghai';
const QQ = '1269541505';
const OTHER = '1719500341';
const OWNER = '用户（OWNER）';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/** 她自己的别名文件（真写在盘上：`real-loop` 每轮从盘上读，判据里不许有内存捷径） */
function writeAliases(dir: string, text: string): void {
  const memories = join(dir, 'workspace', 'MEMORIES');
  mkdirSync(memories, { recursive: true });
  writeFileSync(join(memories, 'aliases.md'), text, 'utf8');
}

/** 一个真 RealLoop（真日志 + 真投影 + 真读盘），只把模型通道换成替身 */
async function makeLoop(
  t: test.TestContext,
  options: { aliases?: string; contacts?: Record<string, string> } = {},
): Promise<RealLoop> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-person-name-'));
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  if (options.aliases !== undefined) writeAliases(dir, options.aliases);
  const config = defaultConfig(dir);
  if (options.contacts !== undefined) config.persona.contacts = { ...options.contacts };
  const loop = new RealLoop({
    log,
    dataDir: dir,
    projection,
    now: () => new Date('2026-10-11T00:00:00.000Z'),
    timezone: TZ,
    // tickOnce 在没有 pending 时不会真的调模型；这里连 tick 都不跑（只问名字）
    ds: ({ modelFor: () => 'fake-model' }) as unknown as DsClient,
    registry: new ToolRegistry(),
    persona: PERSONA,
    config,
    out: () => {},
    pollMs: 3_600_000,
  });
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return loop;
}

test('① 只有群成员别名（裸 id）时她也认得出：原来断掉的就是这一档', async (t) => {
  const loop = await makeLoop(t, {
    aliases: [
      '# 身份别名',
      'qq:c2c:E7FEC35E951B5CCF8BA66793BF6B1314 = OWNER（用户）',
      '# 该群成员（openid，不是 sid；只在认人时用）',
      `${QQ} = **OWNER（用户）**——02:27 GUI 亲口认领`,
    ].join('\n'),
  });
  assert.equal(loop.resolvePersonName(QQ), 'OWNER',
    '成员那一段的裸 id 必须能认出来（原来这一档是死信，只剩机器发的占位名）');
  assert.equal(loop.resolvePersonName(OTHER), null, '没写过的人仍然认不出——不猜');
});

test('①b `#` 开头那行仍然是注释：写在标题行里的映射不算声明（不许偷偷放宽）', async (t) => {
  // 她 10-07 02:27 那一笔正落在这种形状里（`# 该群成员（…）：1269541505 = **OWNER（用户）**…`，
  // 见 aliases.md 第 21 行）——`#` 是 markdown 标题/散文，`forEachAliasRow` 一律跳过。
  // 这条**不是**要修的东西：放宽它等于让正文里的等号变成别名。所以这里正面钉住"它不算"。
  const loop = await makeLoop(t, {
    aliases: `# 该群成员（openid，不是 sid；只在认人时用）：${QQ} = **OWNER（用户）**`,
  });
  assert.equal(loop.resolvePersonName(QQ), null, '标题行里的等号不是声明');
});

test('② 冲突时人声明的事实赢：contacts > 她会话别名 > 她群成员别名', async (t) => {
  const memberOnly = await makeLoop(t, { aliases: `# 该群成员\n${QQ} = 她群成员段写的` });
  assert.equal(memberOnly.resolvePersonName(QQ), '她群成员段写的');

  const c2cWins = await makeLoop(t, {
    aliases: [`onebot:c2c:${QQ} = 她会话别名写的`, '# 该群成员', `${QQ} = 她群成员段写的`].join('\n'),
  });
  assert.equal(c2cWins.resolvePersonName(QQ), '她会话别名写的',
    '会话别名更具体（那条记录说的是"这个人从这扇单聊门来过"）');

  // 联系人表 = 用户手写的事实：一个认错用户的 agent，后面所有判断都是歪的
  const contactsWin = await makeLoop(t, {
    aliases: [`onebot:c2c:${QQ} = 她会话别名写的`, '# 该群成员', `${QQ} = 她群成员段写的`].join('\n'),
    contacts: { [`onebot:c2c:${QQ}`]: OWNER },
  });
  assert.equal(contactsWin.resolvePersonName(QQ), OWNER);
});

test('③ 三处都没有 = 认不出（裸 id 只在"确实没有名字"时才显示）', async (t) => {
  const loop = await makeLoop(t);
  assert.equal(loop.resolvePersonName(QQ), null, '没有名字真源时返回 null，由渲染层照实回落 id');
});

test('④ 别名只改"叫什么"，不改"谁能指挥她"：成员别名写着用户也不给用户档', () => {
  // 群里的发言（chatType=group）：判据是 ownerIds（只由 config.persona.contacts 的 *:c2c:<id> 得来）
  const wake = (person: string): AppEvent => ({
    seq: 1,
    ts: '2026-10-11T00:00:00.000Z',
    type: 'wake/channel',
    data: { channel: 'onebot', chatType: 'group', chatId: '777879783', person, text: '在吗', messageId: 'm1' },
    visibility: defaultVisibility('wake/channel'),
    origin: 'test/person-name',
  } as unknown as AppEvent);

  // 她还没给任何人写过名字时：群里的陌生人一律 external
  assert.equal(trustOfWake(wake(OTHER), new Map(), 'OWNER'), 'external');
  // 联系人表声明过的那个 id（用户）：群里也算用户档
  const contacts = new Map([[`onebot:c2c:${QQ}`, OWNER]]);
  assert.equal(trustOfWake(wake(QQ), contacts, 'OWNER', new Set([QQ])), 'owner');
  // **别名不改身份**：就算她在成员段里把别人写成"用户"，那个 id 也不在 ownerIds 里 ⇒ 仍是 external
  assert.equal(trustOfWake(wake(OTHER), contacts, 'OWNER', new Set([QQ])), 'external');
});
