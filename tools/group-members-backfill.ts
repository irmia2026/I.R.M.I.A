/**
 * 群成员档案的回填（一次性工具，可重复跑：只加不改）。
 *
 * 两个来源：
 *   ① **她自己的别名表** `MEMORIES/aliases.md` 里那段"群成员（openid，不是 sid）"——
 *      那两个人是她已经认下的（甲、丙/Demain），直接收进档案，标成 `human`（以后自动注册不覆盖）。
 *      站在框架的角度这是"人写的"：写它的是她，比机器攒的可信。
 *   ② **事件日志**：group / group-at 且 `mentionsMe` 为真的消息，把发言人收进来。
 *      （历史事件里没有 mentions 名单——那个字段今天才落库，所以被 @ 的人只能从现在起收。）
 *
 * 跑法：node --experimental-strip-types tools/group-members-backfill.ts [--dry]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GroupMemberBook } from '../src/channel/group-members.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(repo, 'data');
const dry = process.argv.includes('--dry');

const book = new GroupMemberBook(dataDir);

/** 已经有名字的人（用户手写的联系人表）：他们不进群成员档案——那里是给"还没名字的人"准备的 */
const knownContactNames = new Set<string>();
try {
  const rawConfig = JSON.parse(readFileSync(join(repo, 'config.json'), 'utf8')) as {
    persona?: { contacts?: Record<string, string> };
  };
  for (const sid of Object.keys(rawConfig.persona?.contacts ?? {})) {
    const parts = sid.split(':');
    if (parts[1] === 'c2c' && parts.length >= 3) knownContactNames.add(parts.slice(2).join(':'));
  }
} catch { /* 配置读不动就不跳过任何人 */ }
const before = book.size;
const added: string[] = [];

/** ① 她的别名表里那段群成员 */
const aliasesPath = join(dataDir, 'workspace', 'MEMORIES', 'aliases.md');
try {
  const lines = readFileSync(aliasesPath, 'utf8').split(/\r?\n/u);
  let inMembers = false;
  for (const line of lines) {
    if (/^#\s*群成员/u.test(line)) { inMembers = true; continue; }
    if (inMembers && /^#\s/u.test(line)) break;
    if (!inMembers) continue;
    // 形如：OPENID = 名字（其余说明）
    const match = /^([0-9A-Fa-f]{8,})\s*=\s*(.+)$/u.exec(line.trim());
    if (match === null) continue;
    const openid = match[1]!;
    const raw = match[2]!.trim();
    // **只取名字，不取注释**：她写的是 `丙（群昵称：Demain；00:37 问过…**不聊私事**）`，
    // 整段进显示名会把每行撑成一段话。规则：第一个括号之前是名字；若那段括号恰好是
    // `群昵称：X`，它是显示名的一部分（GUI 上就是这么写的），保留；其余括号丢掉。
    const head = raw.split('（')[0]!.trim();
    const firstParen = /^（([^）]*)）/u.exec(raw.slice(head.length))?.[1] ?? '';
    // 括号里往往还跟着一段备注（`群昵称：Demain；00:37 问过…`）：只在第一个分号/句号前取值——
    // 整段进显示名会把每一行撑成一段话（实测过）。
    const short = firstParen.split(/[；;。]/u)[0]!.trim();
    const keep = short.startsWith('群昵称：') ? `${head}（${short}）` : head;
    if (keep === '') continue;
    if (knownContactNames.has(openid)) continue; // 已经有名字的人（用户）不进群成员档案
    if (book.setName(openid, keep)) added.push(`aliases.md → ${openid.slice(0, 8)} = ${keep}`);
  }
} catch (err) {
  console.log('[回填] 读别名表失败（跳过这一来源）：', err instanceof Error ? err.message : String(err));
}

/** ② 事件日志：群里 @ 过她的消息 */
const dir = join(dataDir, 'events');
const events = [];
for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
    if (line.trim() !== '') events.push(JSON.parse(line));
  }
}
events.sort((a, b) => a.seq - b.seq);
let scanned = 0;
for (const event of events) {
  if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
  const data = event.data;
  if (data.chatType !== 'group' && data.chatType !== 'group-at') continue;
  if (data.mentionsMe !== true) continue;
  scanned += 1;
  if (knownContactNames.has(data.person)) continue; // 用户自己：已经有名字了
  const groupSid = `qq:group:${data.chatId}`;
  if (book.register({
    openid: data.person,
    groupSid,
    ...(data.nickname === undefined || data.nickname === '' ? {} : { nickname: data.nickname }),
    at: event.ts,
  })) added.push(`事件 seq ${event.seq} → ${String(data.person).slice(0, 8)}（${data.nickname ?? '无昵称'}）`);
}

console.log(`[回填] 扫过 ${events.length} 条事件，其中"群里 @ 过她"的 ${scanned} 条`);
console.log(`[回填] 档案：${before} 条 → ${book.size} 条`);
for (const line of added) console.log('  + ' + line);
// 落盘放在**补完群归属之后**（2026-10-04 修：原来保存在它前面，群归属只改了内存、没写进文件）
if (dry) {
  console.log('[回填] --dry：没有落盘');
}
// ③ 群归属：别名表里没有群信息，从事件里反查（他在哪个群 @ 过她）
const groupOf = new Map<string, string>();
for (const event of events) {
  if (event.type !== 'wake/channel' && event.type !== 'channel/message') continue;
  const data = event.data;
  if (data.chatType !== 'group' && data.chatType !== 'group-at') continue;
  if (!groupOf.has(data.person)) groupOf.set(data.person, `qq:group:${data.chatId}`);
}
let groupFixed = 0;
for (const { openid, entry } of book.all()) {
  if (entry.groupSid !== undefined) continue;
  const sid = groupOf.get(openid);
  if (sid === undefined) continue;
  if (book.setGroup(openid, sid)) groupFixed += 1;
}
if (groupFixed > 0) console.log(`[回填] 补上群归属 ${groupFixed} 条`);
if (!dry) {
  book.save();
  console.log(`[回填] 已写入 ${join(dataDir, 'group-members.json')}`);
}
console.log('\n最终档案：');
for (const { openid, entry } of book.all()) {
  console.log(`  ${openid.slice(0, 10)}… | ${entry.name} | ${entry.groupSid ?? '（无群）'} | ${entry.source}`);
}
