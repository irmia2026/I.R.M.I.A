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
import { loadRelationship, relationshipPathOf } from './loader.ts';

/** 只有这三种唤醒可能带人（其余唤醒类型一律不注入档案） */
const PERSON_WAKE_TYPES: ReadonlySet<string> = new Set([
  'wake/webhook', 'wake/manual', 'wake/channel',
]);

/**
 * 用**她已经维护的那份 sid→名字 表**（`MEMORIES/aliases.md`）把一个渠道身份解析成人名。
 *
 * 为什么需要这一步（2026-10-05 实测的真 bug）：档案文件名是**人名**（`RELATIONSHIPS/阿岚.md`），
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

/**
 * 一份关系档案的**索引**（v78）——**不含正文**。
 *
 * 用户 2026-10-22 的原话：「改为类同记忆索引吧。」（指关系档案的注入方式）
 *
 * 为什么不再把正文塞进来：这一段进的是**本轮固定块**——历史之后、不命中前缀缓存，于是命中一份
 * 档案就要**每轮全价**背它整篇。实测阿岚那篇 1,151 字节（≈500 token/轮）、测试群
 * 2,553 字节（≈1,109 token/轮），而 `admin.ts` 对按需层（STATE / RELATIONSHIPS）只有
 * 「超了只警告」的软上限 ⇒ 它可以无限长。改成索引之后每轮只付两行，正文按需从工具侧取
 * ——读回来的内容作为工具结果留在历史里，从此每轮都在前缀里（与记忆索引同一条口径，
 * 见 `persona/memory-injection.ts` 与 docs/memory-injection.md §5）。
 *
 * **这个结构里一个字正文都不许有**：`path` 指向正文（fs 工具族认这个地址），`chars` 让她判断
 * 值不值得读，`sections` 让她知道里面大概有什么。正文走第二条路（工具结果），不走这里。
 * 渲染层只陈述这三件事 + 一句"如已在上下文中，则不需再读"，**不给读取指令**。
 */
export interface RelationshipNote {
  /** 这一轮命中的是谁（人名 / 群名 / 渠道标识；与文件名同源，不是猜出来的） */
  who: string;
  /** 相对 dataDir 的路径（`persona/RELATIONSHIPS/<文件名>.md`）——`safe_read` 的 `path` 就用它 */
  path: string;
  /** 正文字符数（**码点**口径，不是字节数：中文一个字三字节，两个数差三倍） */
  chars: number;
  /** 文件里 `## ` 开头的前 3 个小节名（没有就是空数组——渲染层据此整段省掉"小节：…"） */
  sections: string[];
}

/** 索引里最多列几个小节名：3 个够她认出"里面有什么"，再多就变回一份目录了 */
const SECTION_NAMES_MAX = 3;

/** 正文的字符数（码点口径；BOM / 行尾不特殊处理——它量的是"读回来大概多长"） */
export function charCountOf(text: string): number {
  return Array.from(text).length;
}

/**
 * 文件里 `## ` 开头的前 N 个小节名（`### ` 不算：子小节的名字脱离父节就读不懂；同名小节照列）。
 *
 * 判据是**行首** `## ` 加空白——`###` 在第二个 `#` 处就不是空白，天然排除，不必额外判长度。
 */
export function sectionNamesOf(text: string, max: number = SECTION_NAMES_MAX): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!/^##[ \t]/u.test(line)) continue;
    const name = line.slice(2).trim();
    if (name === '') continue;
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

/**
 * 命中一份档案 → 它的**索引**；没有这个人返回 null。
 *
 * 这里**读文件**（要量字数、抽小节名），但**只把索引带出去**：正文在这个函数的栈上走完就丢，
 * 一个字节都不进返回结构（见 {@link RelationshipNote}）。
 */
function relationshipIndexOf(dataDir: string, who: string): RelationshipNote | null {
  const content = loadRelationship(dataDir, who);
  if (content === null) return null;
  return {
    who,
    path: relationshipPathOf(who),
    chars: charCountOf(content),
    sections: sectionNamesOf(content),
  };
}

/** 唤醒 → 关系档案的索引；没人、没档案、或唤醒类型不带人时返回 null */
export function relationshipForWake(
  wakeEvent: AppEvent | null | undefined,
  dataDir: string,
): RelationshipNote | null {
  if (!wakeEvent) return null;
  if (!PERSON_WAKE_TYPES.has(wakeEvent.type)) return null;
  const data = wakeEvent.data as Record<string, unknown>;
  const person = typeof data['person'] === 'string' ? data['person'].trim() : '';
  if (person !== '') {
    const note = relationshipIndexOf(dataDir, person);
    if (note !== null) return note;
  }
  // ② **把渠道身份解析成人名再找一次**（2026-10-05 修）：`person` 在 QQ 那条路上是 openid，
  //    而档案文件名是人名（`RELATIONSHIPS/阿岚.md`）——不做这一步，他在 QQ 单聊里说话就
  //    没有档案，在 GUI 里说话却有。同一个人两个样子，是这轮要修的 bug。
  const channel = typeof data['channel'] === 'string' ? data['channel'].trim() : '';
  const chatType = typeof data['chatType'] === 'string' ? data['chatType'].trim() : '';
  const chatId = typeof data['chatId'] === 'string' ? data['chatId'].trim() : '';
  if (person !== '' && channel !== '' && chatType !== '' && chatId !== '') {
    const aliasName = aliasNameFor(dataDir, sidOf(channel, chatType, chatId));
    if (aliasName !== null && aliasName !== person) {
      const note = relationshipIndexOf(dataDir, aliasName);
      if (note !== null) return note;
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
    const note = relationshipIndexOf(dataDir, chatId);
    if (note !== null) return note;
  }
  return null;
}

/** 手动唤醒该带谁的标识：GUI / CLI / 看门文件三者共用这一处判据 */
export function ownerPersonOf(config: { persona: { owner: string } }): string {
  return config.persona.owner.trim() === '' ? 'owner' : config.persona.owner.trim();
}
