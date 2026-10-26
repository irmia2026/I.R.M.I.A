/**
 * 重启后的群成员**回填** — src/runtime/real-loop.ts 的 `warmUp` + `backfillGroupMembers`
 *
 * 这里锁的是一道**跨重启的空档**（2026-10-07 对齐 OneBot 时查出来的，不是哪次改出来的）：
 * `warmUp` 只折会话簿（`collectSessionsFromLog`），而运行期那趟 `foldChannelEvents` 还负责
 * `registerGroupMembers`（群成员自动档案）。游标一前移到当刻水位，**重启前**到达的那些群 @
 * 就再也没人折——那些人永远进不了档案，她问"甲是谁"时框架只能给一串 openid。
 *
 * 为什么"看起来能用"的两种补法都是坑（前一个代理实测过，别再试）：
 *   ① **把游标留在 0、让下一拍重折一遍** ⇒ 会话簿的条数与未读是**累加**出来的
 *      （`applyChannelMessage` 在旧值上加），从 0 重折必然翻倍（实测 5 条变 10 条）。
 *      本文件第 3 条用例正面断言"条数/未读一个都没变"，就是钉死这条路不许被走。
 *   ② **在 warmUp 里直接补跑 `registerGroupMembers`** ⇒ 那条路会给历史发言人**发占位号**
 *      （群友A、群友B…），而那个名字是**持久**的（落盘、`personNameOf` 优先读它），
 *      往后每一次引用这个人都带着一个"她其实没跟他打过交道"的占位名——那是污染。
 *      本文件的第 4、5 条用例正面断言"没有昵称时不许造名字"。
 *
 * 正确的那条路（本次实现）是**只回填"已经攒下来的人"**：对重启前已落盘的事件，**只做
 * "成员登记"这一件事**——只落平台给的事实（id ↔ 昵称、在哪个群见过），不碰会话簿、不碰未读、
 * 不碰游标、不发占位号。
 *
 * 用真的 EventLog + 真的 fold + 真的 RealLoop（替身只有模型通道那一个），因为这条链的价值
 * 就在"写下去的东西重启后读得回来"——替身会把这层抹掉。事件载荷照**真实适配器**的形状写
 * （官方那条给 `username`，OneBot 那条给 `sender.card`；见 `qq-official.ts` / `onebot.ts`）。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { GROUP_MEMBERS_FILE } from '../src/channel/group-members.ts';
import { EventLog } from '../src/log/event-log.ts';
import { defaultVisibility, type AppEvent } from '../src/log/types.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { RealLoop } from '../src/runtime/real-loop.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { DsClient } from '../src/model/ds-client.ts';
import type { PersonaAssets } from '../src/persona/loader.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const TZ = 'Asia/Shanghai';

const PERSONA: PersonaAssets = {
  identity: 'IDENTITY',
  constitution: 'CONSTITUTION',
  style: 'STYLE',
  state: 'STATE',
  relationship: null,
  personaHash: 'test-hash',
  isSeed: false,
} as unknown as PersonaAssets;

/**
 * 测试台：一个盘的日志 + 一个投影 + **可以反复重建的 RealLoop**（重建 = 重启）。
 *
 * `restart()` 换的是 RealLoop 实例，日志与投影**共用**——这正是"重启"这个词在这里的意思：
 * 事件还在盘上，内存里那些跨重启的东西（会话簿、折叠游标、群成员档案句柄）全部归零。
 */
interface Rig {
  dir: string;
  loop: () => RealLoop;
  write: (type: string, data: unknown) => AppEvent;
  restart: () => void;
  close: () => void;
}

/**
 * 配置覆盖点（可选）：只给"人声明的名字"那条用例用——它要验的是
 * **已经有名字的人不许被回填成群友**，而那件事的真相源就是 `config.persona.contacts`。
 */
type PatchConfig = (config: ReturnType<typeof defaultConfig>) => void;

async function makeRig(t: test.TestContext, patchConfig?: PatchConfig): Promise<Rig> {
  const dir = tempDirSync('irmia-restart-members-');
  const log = await EventLog.open(join(dir, 'events'));
  const projection = fold([]);
  const now = (): Date => new Date('2026-10-07T07:00:00.000Z');

  const build = (): RealLoop => {
    const config = defaultConfig(dir);
    patchConfig?.(config);
    return new RealLoop({
      log,
      dataDir: dir,
      projection,
      now,
      timezone: TZ,
      // tickOnce 在没有 pending 时不会真的调模型；但早期几拍会问一下当前路由的模型名
      ds: ({ modelFor: () => 'fake-model' }) as unknown as DsClient,
      registry: new ToolRegistry(),
      persona: PERSONA,
      config,
      out: () => {},
      pollMs: 3_600_000,
    });
  };

  let loop = build();
  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    loop: () => loop,
    restart: () => { loop = build(); },
    write: (type, data) => {
      const event = {
        seq: log.nextSeq(),
        ts: now().toISOString(),
        type,
        data,
        visibility: defaultVisibility(type),
        origin: 'test/restart-group-members',
      } as unknown as AppEvent;
      log.append(event, { sync: true });
      applyOne(projection, event);
      return event;
    },
    close: () => log.close(),
  };
}

/** 档案文件的**原始字节**（幂等那条要逐字节比，所以不能只比对象） */
function membersBytes(dir: string): string {
  const path = join(dir, GROUP_MEMBERS_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** 档案里某个人的条目（没有这个人就 null） */
function memberEntry(dir: string, openid: string): {
  name: string;
  nickname?: string;
  groupSid?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  source: string;
} | null {
  const path = join(dir, GROUP_MEMBERS_FILE);
  if (!existsSync(path)) return null;
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { members?: Record<string, Record<string, unknown>> };
  const entry = doc.members?.[openid];
  if (entry === undefined) return null;
  return entry as unknown as { name: string; source: string };
}

/** 会话簿的稳定指纹：**条数 + 未读 + 总消息数**（回填不许动它们任何一个） */
function sessionFingerprint(loop: RealLoop): string {
  return loop.sessions()
    .map((s) => `${s.sid}|${s.messages}|${s.unread}|${s.readUpToSeq}|${s.lastSeenAt}`)
    .sort()
    .join('\n');
}

const GROUP = '20002';
const SID = `onebot:group:${GROUP}`;

/** OneBot 群里 @ 了她的一条（形状照 `onebot.ts` 的 `mapEventToWakeChannel`） */
function atMe(data: {
  person: string;
  nickname?: string;
  messageId: string;
  msgSeq: number;
}): unknown {
  return {
    channel: 'onebot',
    chatType: 'group-at',
    person: data.person,
    ...(data.nickname === undefined ? {} : { nickname: data.nickname }),
    chatId: GROUP,
    text: '帮我看看这个',
    messageId: data.messageId,
    msgSeq: data.msgSeq,
    mentionsMe: true,
    dedupeKey: `onebot:${data.messageId}`,
  };
}

/** OneBot 群里的普通闲聊（没 @ 她：进信箱、不算"叫过她"） */
function chitchat(data: { person: string; nickname?: string; messageId: string; msgSeq: number }): unknown {
  return {
    channel: 'onebot',
    chatType: 'group',
    person: data.person,
    ...(data.nickname === undefined ? {} : { nickname: data.nickname }),
    chatId: GROUP,
    text: '今天天气不错',
    messageId: data.messageId,
    msgSeq: data.msgSeq,
    dedupeKey: `onebot:${data.messageId}`,
  };
}

/** 官方那条通道的群 @（形状照 `qq-official.ts`：昵称在 `username` 里） */
function officialAtMe(data: { person: string; nickname?: string; messageId: string; msgSeq: number }): unknown {
  return {
    channel: 'qq-official',
    chatType: 'group-at',
    person: data.person,
    ...(data.nickname === undefined ? {} : { nickname: data.nickname }),
    chatId: 'G-OFFICIAL',
    text: '在吗',
    messageId: data.messageId,
    msgSeq: data.msgSeq,
    mentionsMe: true,
    dedupeKey: data.messageId,
  };
}

// ─────────────────────────── ① 重启前有群 @ ⇒ 重启后档案里有人 ───────────────────────────

test('重启前到达的群 @，重启后靠**已落盘的事件**回填进成员档案（两条通道都算）', async (t) => {
  const rig = await makeRig(t);
  // **重启之前**落库的三条：两个 OneBot 群里 @ 她的人、一个官方群里 @ 她的人
  rig.write('wake/channel', atMe({ person: '1234567891', nickname: '阿岚', messageId: 'g-1', msgSeq: 1 }));
  rig.write('wake/channel', atMe({ person: '10001', nickname: '群里的老王', messageId: 'g-2', msgSeq: 2 }));
  rig.write('wake/channel', officialAtMe({ person: 'E7FE0A1B', nickname: '阿岚', messageId: 'o-1', msgSeq: 1 }));
  assert.equal(existsSync(join(rig.dir, GROUP_MEMBERS_FILE)), false, '重启前还没有人折过这些事件：档案不存在');

  // 只做**一次** `tickOnce`：里面会跑 `warmUp`（这就是重启），而 `foldChannelEvents` 因为
  // 游标已被 warmUp 推到当刻水位而**什么都不做**——所以下面这几条断言只可能来自回填。
  await rig.loop().tickOnce();

  const lan = memberEntry(rig.dir, '1234567891');
  assert.ok(lan !== null, '重启前 @ 过她的人必须进档案（这道空档就是本次要补的）');
  assert.equal(lan.nickname, '阿岚', '平台给的昵称要如实记下（那是回填唯一该落的事实）');
  assert.equal(lan.groupSid, SID, '在哪个群见的也要记（界面按群分组显示）');
  assert.equal(lan.firstSeenAt, '2026-10-07T07:00:00.000Z', '首见时刻取那条事件的时刻');
  assert.equal(lan.lastSeenAt, '2026-10-07T07:00:00.000Z');

  const wang = memberEntry(rig.dir, '10001');
  assert.ok(wang !== null, '同一个群里的第二个人也要回填（不是只补第一个）');
  assert.equal(wang.nickname, '群里的老王');

  const kai = memberEntry(rig.dir, 'E7FE0A1B');
  assert.ok(kai !== null, '官方那条通道同样适用（用户要的是跨通道一致，不是只修 OneBot）');
  assert.equal(kai.nickname, '阿岚');
  assert.equal(kai.groupSid, 'qq:group:G-OFFICIAL', '官方那条的群 sid 也要如实记');
});

// ─────────────────────────── ② 幂等：跑两遍结果相同 ───────────────────────────

test('回填**幂等**：再重启一次，档案字节与再次重启前逐字节相同', async (t) => {
  const rig = await makeRig(t);
  rig.write('wake/channel', atMe({ person: '1234567891', nickname: '阿岚', messageId: 'g-1', msgSeq: 1 }));
  rig.write('wake/channel', officialAtMe({ person: 'E7FE0A1B', nickname: '阿岚', messageId: 'o-1', msgSeq: 1 }));

  await rig.loop().tickOnce();
  const afterFirst = membersBytes(rig.dir);
  assert.ok(afterFirst.includes('1234567891'), '第一遍回填该落下东西（否则下面的"没变"没有意义）');
  const sessionsBefore = sessionFingerprint(rig.loop());

  // 第二遍：**新实例**（游标归零）再读同一份日志。同一批事件折两遍，结果必须一样。
  rig.restart();
  await rig.loop().tickOnce();
  assert.equal(membersBytes(rig.dir), afterFirst, '回填必须幂等：第二遍不许改档案的任何一个字节');
  assert.equal(sessionFingerprint(rig.loop()), sessionsBefore, '会话簿也不许因为又回填了一次而变化');

  // 第三遍：确认"幂等"不是"第二次恰好没跑"
  rig.restart();
  await rig.loop().tickOnce();
  assert.equal(membersBytes(rig.dir), afterFirst, '第三次也一样');
});

// ─────────────────── ③ 会话条数 / 未读不因回填而变化（正面断言） ───────────────────

test('回填**不碰**会话簿：条数、未读、已读位与"不回填时"逐字相同', async (t) => {
  const rig = await makeRig(t);
  // 一个群里攒下一批：**五条进信箱的消息**（未读正是从它们里算）+ 两条 @ 她的（会回填），
  // 中间夹一条 `channel/read` 说她读到第 3 条了（于是 4、5 两条是未读）。
  //
  // 两个口径都是既有的、不是本次改的，用例顺着它们写：
  //   • `wake/channel` 是"已经送进她上下文"的那条，她当场看到了——**不计入未读**
  //     （见 `sessions.ts` 的 `applyChannelMessage` 那段"只有进信箱的才算积累"）；
  //   • `channel/read` 把已读位推到哪，未读就按那个位置**重算**（读位之后新到的那几条才累积）
  //     ——所以它必须排在"要算未读的那几条"**之前**。
  for (let seq = 1; seq <= 3; seq += 1) {
    rig.write('channel/message', {
      channel: 'onebot', chatType: 'group', person: '10086', nickname: '路人甲',
      chatId: GROUP, text: `闲聊 ${seq}`, messageId: `g-${seq}`, msgSeq: seq,
    });
  }
  rig.write('channel/read', { sid: SID, upToSeq: 3 });
  rig.write('wake/channel', atMe({ person: '1234567891', nickname: '阿岚', messageId: 'g-4', msgSeq: 4 }));
  rig.write('wake/channel', atMe({ person: '10001', nickname: '群里的老王', messageId: 'g-5', msgSeq: 5 }));
  for (let seq = 6; seq <= 7; seq += 1) {
    rig.write('channel/message', {
      channel: 'onebot', chatType: 'group', person: '10086', nickname: '路人甲',
      chatId: GROUP, text: `闲聊 ${seq}`, messageId: `g-${seq}`, msgSeq: seq,
    });
  }

  await rig.loop().tickOnce();
  const before = sessionFingerprint(rig.loop());

  // 重启：走的正是那条新加的回填
  rig.restart();
  await rig.loop().tickOnce();
  assert.equal(sessionFingerprint(rig.loop()), before, '回填一个字都不许改会话条数/未读/已读位');
  assert.ok(memberEntry(rig.dir, '1234567891') !== null, '这一趟确实回填了（否则上面的"没变"可能是没跑）');

  // 正面把数字说出来（不只是"两边相等"）：一个会话、7 条消息、未读 2 条（第 4、5 条在已读位 3 之后）
  const entry = rig.loop().sessions().find((s) => s.sid === SID);
  assert.ok(entry !== undefined, '那个群仍然是一个会话');
  assert.equal(entry.messages, 7, '7 条都算进"这个会话来过多少条"');
  assert.equal(entry.unread, 2, '只有进信箱且没过已读位的那两条算未读');
  assert.equal(entry.readUpToSeq, 3);

  // 再重启一次也还是这两个数（回填跑了几遍都不影响计数）
  rig.restart();
  await rig.loop().tickOnce();
  const again = rig.loop().sessions().find((s) => s.sid === SID);
  assert.equal(again?.messages, 7, '条数不许翻倍（"游标留 0"那条错路的病征正是它变成 14）');
  assert.equal(again?.unread, 2, '未读同理');
});

// ─────────────────── ④ 没有昵称时不造名字（反面判据，含"占位号"） ───────────────────

test('平台没给昵称 ⇒ 如实留空名，**不发占位号**（回填不是"她见过这个人"）', async (t) => {
  const rig = await makeRig(t);
  // Q 官方有些事件不带 `username`：这正是"没昵称"的那种情况
  rig.write('wake/channel', officialAtMe({ person: 'E7FE0A1B', messageId: 'o-1', msgSeq: 1 }));

  await rig.loop().tickOnce();
  const entry = memberEntry(rig.dir, 'E7FE0A1B');
  assert.ok(entry !== null, '"见过、且叫过她"这件事本身要落下（事实只有一个 id 就写一个 id）');
  assert.equal(entry.name, '', '没有昵称就留空名：**不许**编一个"群友A"（那个名字是持久的，往后每次引用都带着它）');
  assert.equal(entry.nickname, undefined, '没有昵称就不写这个字段（不是写个空串）');
  assert.ok(!membersBytes(rig.dir).includes('群友'), '档案里一个占位号都不许出现');
});

test('对照组：**运行期**那条路仍然发占位号（回填改了，注册没改）', async (t) => {
  const rig = await makeRig(t);
  await rig.loop().tickOnce(); // 先跑一拍，把折的游标推到当刻水位
  // 这一条是**运行期新到的**：由 `foldChannelEvents` 走 `register` 那条路
  rig.write('wake/channel', officialAtMe({ person: 'E7FE0A1B', messageId: 'o-2', msgSeq: 1 }));
  await rig.loop().tickOnce();

  const entry = memberEntry(rig.dir, 'E7FE0A1B');
  assert.ok(entry !== null, '运行期 @ 她的人当然要登记');
  assert.equal(entry.name, '群友A', '运行期这条路维持原样：没有昵称就按群、按首次出现顺序发占位号');
});

// ─────────────────── ⑤ 反向：非 @ 的闲聊不登记 ───────────────────

test('回填只认"叫过她"：群里的普通闲聊不登记', async (t) => {
  const rig = await makeRig(t);
  rig.write('wake/channel', chitchat({ person: '10086', nickname: '路人甲', messageId: 'g-1', msgSeq: 1 }));
  rig.write('channel/message', {
    channel: 'onebot', chatType: 'group', person: '10087', nickname: '路人乙',
    chatId: GROUP, text: '另一个闲人', messageId: 'g-2', msgSeq: 2,
  });
  rig.write('wake/channel', atMe({ person: '1234567891', nickname: '阿岚', messageId: 'g-3', msgSeq: 3 }));

  await rig.loop().tickOnce();
  assert.equal(memberEntry(rig.dir, '10086'), null, '没叫她的人不进档案（免得把冒过泡的人都灌进去）');
  assert.equal(memberEntry(rig.dir, '10087'), null, '信箱那条路的人也不进（登记只认"叫她"的那条路）');
  assert.ok(memberEntry(rig.dir, '1234567891') !== null, '同一批里真叫过她的人照样进来');
});

// ─────────────────── ⑥ 已经有名字的人不进档案（与运行期同一条判据） ───────────────────

test('回填跳过**人已经声明过名字**的人：用户不许变成"群友"', async (t) => {
  const rig = await makeRig(t, (config) => {
    // 用户：名字由人写进 `persona.contacts`（键是**单聊** sid，与 real-loop 的判据同源）
    config.persona.owner = '用户';
    config.persona.contacts['onebot:c2c:1234567891'] = '用户';
  });
  rig.write('wake/channel', atMe({ person: '1234567891', nickname: '阿岚', messageId: 'g-1', msgSeq: 1 }));
  rig.write('wake/channel', atMe({ person: '10001', nickname: '群里的老王', messageId: 'g-2', msgSeq: 2 }));

  await rig.loop().tickOnce();
  assert.equal(memberEntry(rig.dir, '1234567891'), null, '用户不进"群成员"档案（实测踩过：他被注册成过群友）');
  assert.ok(memberEntry(rig.dir, '10001') !== null, '同一批里没有名字的人照常回填');
});

// ─────────────────── ⑦ 回填落在真相上：昵称后到就补上，不覆盖已有的名字 ───────────────────

test('后到的昵称只是**补上事实**，不覆盖运行期已经发出去的占位号', async (t) => {
  const rig = await makeRig(t);
  // 先有一条**运行期**的 @（没有昵称）：发占位号——她此刻可能已经认过这个名字
  await rig.loop().tickOnce();
  rig.write('wake/channel', officialAtMe({ person: 'E7FE0A1B', messageId: 'o-1', msgSeq: 1 }));
  await rig.loop().tickOnce();
  assert.equal(memberEntry(rig.dir, 'E7FE0A1B')?.name, '群友A', '运行期那条路照旧发占位号');

  // 之后平台才给出昵称（同一个人的下一条消息），而且这一条落在**重启之前**
  rig.write('wake/channel', officialAtMe({ person: 'E7FE0A1B', nickname: '阿岚', messageId: 'o-2', msgSeq: 2 }));
  rig.restart();
  await rig.loop().tickOnce();

  const entry = memberEntry(rig.dir, 'E7FE0A1B');
  assert.equal(entry?.name, '群友A', '占位号是运行期发的、她可能已经认过它：回填不许替它改名');
  assert.equal(entry?.nickname, '阿岚', '但平台给的昵称要如实补上（这是"补事实"，不是"改身份"）');
});

