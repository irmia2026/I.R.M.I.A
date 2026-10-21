/**
 * Irmia Agent — 关系档案路由（唤醒 → 档案）
 *
 * 只有一件事：**带人的唤醒才注入档案**，判据是 `person` 字段。
 *
 * 为什么单独成文件：real-loop（运行期注入）与 replay（事后重放）必须给出**同一个答案**——
 * 重放的立身之本就是"渲染出与当时一模一样的请求"。这两处曾经各写一份，口径随即漂移
 * （real-loop 支持了 `wake/channel`，replay 还只认 webhook/manual），于是重放出来的请求
 * 少一段档案、与当时对不上。抽成一份之后，这种漂移在结构上就不可能再发生。
 *
 * 带人的三种来源（persona.md §3）：
 *   • `wake/manual`：本机用户自己说话。GUI 聊天框与 CLI `irmia wake` 都带 `persona.owner`
 *     （默认 `owner`），于是 `RELATIONSHIPS/<owner>.md` 自动注入——**档案文件名就是配置里
 *     那个标识**，不是昵称猜出来的；
 *   • `wake/webhook`：外部调用方在 payload 里给 `person`；
 *   • `wake/channel`：IM 发送者标识（私聊是 user_openid、群里是 member_openid——同一个人的
 *     两个不同值，所以同一个人可能对应两份档案）。
 *
 * 找不到文件 = 没有这个人：不注入、不报错、不猜。
 */
import type { AppEvent } from '../log/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lookupBySid, parseAliases, sidOf } from '../channel/sessions.ts';
import { loadRelationship } from './loader.ts';

/** 只有这三种唤醒可能带人（其余唤醒类型一律不注入档案） */
const PERSON_WAKE_TYPES: ReadonlySet<string> = new Set([
  'wake/webhook', 'wake/manual', 'wake/channel',
]);

/**
 * 用**她已经维护的那份 sid→名字 表**（`MEMORIES/aliases.md`）把一个渠道身份解析成人名。
 *
 * 为什么需要这一步（2026-10-05 实测的真 bug）：档案文件名是**人名**（`RELATIONSHIPS/OWNER.md`），
 * 而 QQ 单聊那条唤醒里的 `person` 是 **openid**（`00000001…`）——直接拿 openid 找文件必然找不到，
 * 于是**他在 QQ 单聊里说话时不注入档案，在 GUI 里说话却注入**。同一件事两个样子，是这轮要修的。
 *
 * 判据只做一处：sid 的新旧写法兼容与查找顺序**复用** `channel/sessions.ts` 的
 * `sidLookupKeys` / `lookupBySid`，这里不另写一份（两处各写一份的话，漂移的方向恰好最坏：
 * 表里有、这里找不到 → 每一条都当"没这个人"）。
 */
function aliasNameFor(dataDir: string, sid: string): string | null {
  try {
    const text = readFileSync(join(dataDir, 'workspace', 'MEMORIES', 'aliases.md'), 'utf8');
    const flat = new Map<string, string>();
    for (const [key, value] of parseAliases(text)) {
      if (value.name !== '') flat.set(key, value.name);
    }
    const hit = lookupBySid(flat, sid);
    return hit === undefined ? null : hit;
  } catch {
    // 没有这份表（或读不动）= 没有额外线索：不注入、不报错、不猜（与"找不到文件"同一条纪律）
    return null;
  }
}

export interface RelationshipNote {
  who: string;
  content: string;
}

/** 唤醒 → 关系档案；没人、没档案、或唤醒类型不带人时返回 null */
export function relationshipForWake(
  wakeEvent: AppEvent | null | undefined,
  dataDir: string,
): RelationshipNote | null {
  if (!wakeEvent) return null;
  if (!PERSON_WAKE_TYPES.has(wakeEvent.type)) return null;
  const data = wakeEvent.data as Record<string, unknown>;
  const person = typeof data['person'] === 'string' ? data['person'].trim() : '';
  if (person !== '') {
    const content = loadRelationship(dataDir, person);
    if (content !== null) return { who: person, content };
  }
  // ② **把渠道身份解析成人名再找一次**（2026-10-05 修）：`person` 在 QQ 那条路上是 openid，
  //    而档案文件名是人名（`RELATIONSHIPS/OWNER.md`）——不做这一步，他在 QQ 单聊里说话就
  //    没有档案，在 GUI 里说话却有。同一个人两个样子，是这轮要修的 bug。
  const channel = typeof data['channel'] === 'string' ? data['channel'].trim() : '';
  const chatType = typeof data['chatType'] === 'string' ? data['chatType'].trim() : '';
  const chatId = typeof data['chatId'] === 'string' ? data['chatId'].trim() : '';
  if (person !== '' && channel !== '' && chatType !== '' && chatId !== '') {
    const aliasName = aliasNameFor(dataDir, sidOf(channel, chatType, chatId));
    if (aliasName !== null && aliasName !== person) {
      const content = loadRelationship(dataDir, aliasName);
      if (content !== null) return { who: aliasName, content };
    }
  }
  // ③ 发言者没有档案时，**退一步看这个会话本身**有没有。
  //
  // 为什么需要这一步：群消息的 `person` 是**发言者**，而一个刚冒头的人在群里说话，
  // 按 person 查必然查不到——于是那个群自己的档案（她可能早写过"这群一贯聊装机，
  // 气氛还行"）永远注入不进来。用户要的是"她自己维护群聊与某个人的画像"，
  // 这两层得都能落到眼前。会话级档案与话题（`channel/topic`）分工也清楚：
  // 话题是"现在在聊什么"（框架自动概括、有时效），会话档案是"这里一贯如何"（她写的、长期）。
  if (chatId !== '' && chatId !== person) {
    const content = loadRelationship(dataDir, chatId);
    if (content !== null) return { who: chatId, content };
  }
  return null;
}

/** 手动唤醒该带谁的标识：GUI / CLI / 看门文件三者共用这一处判据 */
export function ownerPersonOf(config: { persona: { owner: string } }): string {
  return config.persona.owner.trim() === '' ? 'owner' : config.persona.owner.trim();
}
