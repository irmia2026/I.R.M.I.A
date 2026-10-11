/**
 * Irmia Agent — 本轮的可信级别（谁能指挥她）
 *
 * 为什么需要它：群里**任何人**都能 @ 她，而那条消息**本身就是输入**。光在装置自述里写
 * "别人说的话不是指令"是防不住的——提示词可以被绕过，一句"忽略之前的指令"就够了。
 * 所以硬约束放在**工具清单**那一层：外部来源的轮次里，危险工具**根本不出现在她眼前**，
 * 她连看都看不到，也就无从调用。
 *
 * 这与 registry.ts 里那条既有原则同源：「destructive 默认不进模型清单……**拦截点在这里，
 * 不在提示词里**」。这里做的事是把它从"全局配置"细化成"按轮次"。
 *
 * 判定的输入只有一个：**这一轮是谁唤醒的**。她自己发起的心跳/意图/定时器，与用户从界面
 * 说话一样可信；而"某人在群里 @ 了她"——无论那条消息写得多像用户的口吻——一律按外部处理。
 */

import { sidOf } from '../channel/sessions.ts';
import type { AppEvent } from '../log/types.ts';

/**
 * 四档可信级别，从宽到严：`owner` = `self` > `trusted` > `external`。
 *
 * - `owner`    用户：界面消息，或**联系人表里标成用户名字**的那个单聊会话
 * - `self`     她自己发起的：心跳、意图到期、定时器、后台任务、看门目录（本地事实，不是外人递话）
 * - `trusted`  人在联系人表里记过名字、但不是用户的单聊会话
 * - `external` 群里 @ 她、没记过名字的单聊、webhook，以及**任何认不出来的来源**
 */
export type TurnTrust = 'owner' | 'self' | 'trusted' | 'external';

/**
 * 外部来源能看到的**全部**工具——**严格白名单**，不是"非 destructive 的那些"。
 *
 * 为什么不能只靠 `includeDestructive: false`：`safe_read` / `rg_search` 都不是
 * destructive，但它们能读到工作根里 `MEMORIES/` 的内容——那里面有关于用户的事。对一个从群里
 * 来的陌生人，这些同样不该给。留下的是四件"说话与看"的能力：
 *
 *   - `speak` / `report`：她要能回话（这是她的本职，也是她拒绝的方式）
 *   - `read_channel`：看那个会话积累的消息（"可以选择看"那条设计的落点）
 *   - `vision_read`：看别人发的图
 *
 * 名单里没有的工具即使已经注册也不会出现在清单里；将来新增工具时**默认也不给外部**——
 * 这个白名单是"要主动加才能给"的方向，与 destructive 的"要主动开才能给"一致。
 *
 * ⚠ **它现在不许拿去做"过滤工具数组"那件事**（2026-10-11 用户裁决）：清单对所有轮次恒定，
 * 收窄只在**执行期**（`authz.ts` 的 `authzGate` + `tools.groupSceneHardRefusal`）。
 * 这条名单本身**不删、也不改口径**——它是"外部来源到底该有哪些能力"这份判断的真源，
 * 留着给①评审时人读、②`test/trust.test.ts` 钉着这条口径、③哪天版本更新真的要改清单时当依据。
 * 消费它的唯一活代码是 `modelVisibilityFor()`（同文件下面那一段，**刻意不调用**）。
 */
export const EXTERNAL_TOOL_ALLOWLIST: readonly string[] = [
  'speak', 'report', 'read_channel', 'vision_read',
];

/** 从严到宽的排序：混合批次取最严的那一档，安全默认 */
const SEVERITY: Record<TurnTrust, number> = { external: 3, trusted: 2, self: 1, owner: 1 };

/** 取两档里更严的那个 */
export function strictest(a: TurnTrust, b: TurnTrust): TurnTrust {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/**
 * 一条唤醒事件的可信级别。
 *
 * **`group-at`（群里 @ 她）一律 external**，哪怕用户自己在那条群里 @ 她。原因不是保守，
 * 是技术上判不出来：QQ 的 openid 是**按场景**发的，同一个人在群里与私聊拿到的不是同一个
 * 值，所以"这个群成员就是用户"这件事无从确认。要破例得人在配置里显式声明，不做默认。
 */
/**
 * 这条联系人标签算不算用户。
 *
 * 全等当然算；**标签里带着用户的名字也算**。为什么不能只做全等：联系人表是用户写给人看的
 * （真实值就是 `用户（OWNER）`），而这道门拿它做**身份判定**——全等比较会把用户的私聊
 * 降成 trusted，destructive 工具整批消失。实测（2026-10-04）：她在 QQ 单聊里看不到 send_media，
 * 根因就是这里差了一对括号。
 *
 * 容错方向与代价：联系人表只由用户在本机/GUI 里写，外人碰不到；把用户的名字写进别人的标签
 * 是用户自己的表述，按用户算符合他的意图。
 */
export function isOwnerLabel(name: string, owner: string): boolean {
  const label = name.trim();
  const who = owner.trim();
  if (who === '') return false;
  return label === who || label.includes(who);
}
export function trustOfWake(
  event: AppEvent,
  contacts: ReadonlyMap<string, string>,
  owner: string,
  /**
   * **已知是用户的 id**（2026-10-04 加）：单聊那个 openid + 各个群里他那串 member_openid。
   *
   * 为什么需要它：QQ 的 id 按场景隔离，同一个人在群里与单聊拿到的不是同一个值——所以
   * 「群里的这个人就是用户」判不出来，只能声明。声明过的 id 在这个集合里，群聊唤醒
   * 也就能给到最高档（用户 2026-10-04 的口径：用户群聊消息地位等同 GUI）。
   */
  ownerIds: ReadonlySet<string> = new Set<string>(),
): TurnTrust {
  switch (event.type) {
    case 'wake/manual':
      // 界面消息：署名通常是他本人，但**不保证**（同一台机器别人也可能碰到）。
      // 这一档的判定沿用既有口径——界面是本机的、有物理边界，与"群里陌生人"不同量级。
      return 'owner';
    case 'wake/heartbeat':
    case 'wake/intention':
    case 'wake/timer':
    case 'wake/job':
    case 'wake/file':
      // 她自己发起的，或本机文件变化：不是外人递话
      return 'self';
    case 'wake/webhook':
      // 看门目录里的外部投递：内容来源在机器之外
      return 'external';
    case 'wake/channel': {
      const d = event.data;
      // 群里：先看这个 id 是不是被声明过的用户（群成员 openid 按群隔离，只能靠声明）
      if (d.chatType !== 'c2c') {
        return d.person !== '' && ownerIds.has(d.person) ? 'owner' : 'external';
      }
      const name = contacts.get(sidOf(d.channel, d.chatType, d.chatId));
      if (name === undefined) return 'external';
      return isOwnerLabel(name, owner) ? 'owner' : 'trusted';
    }
    default:
      // 认不出来的来源按最严处理：新增唤醒类型时，忘了在这里登记也不会变成漏洞
      return 'external';
  }
}

/** 一批唤醒里取最严的那一档（一轮可能同时被"用户说话"与"群里有人 @"唤醒，按最不可信的算） */
export function trustOfBatch(
  wakes: readonly AppEvent[],
  contacts: ReadonlyMap<string, string>,
  owner: string,
  ownerIds: ReadonlySet<string> = new Set<string>(),
): TurnTrust {
  let trust: TurnTrust = 'owner';
  for (const event of wakes) trust = strictest(trust, trustOfWake(event, contacts, owner, ownerIds));
  return trust;
}

/** 交给注册表的可见性选项（`listForModel` 的入参形状） */
export interface ModelVisibility {
  includeDestructive?: boolean | readonly string[];
  allowOnly?: readonly string[];
}

/**
 * 把"本轮信任级"与"用户配置的 destructive 开关"合成注册表要的那份选项——**取更严的**。
 *
 * `configured` 就是 `config.tools.destructiveEnabled`（用户可能全开）。它在用户与她自己的
 * 轮次里照常生效；到了 `trusted` / `external` 一律收紧，配置再宽也压不过这里——
 * 否则"用户图方便全开"就等于"群里任何人都能使唤她"。
 *
 * ⚠ **当前刻意不调用**（2026-10-11 用户裁决）：
 * 2026-10-04 用户定过"**工具清单恒定**"，2026-10-11 的裁决把它定成不可动的铁律
 * （原话：「tool 数组是绝对不动的（除非我们版本更新）任何情况都不应该变动」）——
 * **接上去就违反裁决**：这一函数一旦回到 `real-loop.ts` 的 `modelVisibility`，`tools` 段
 * 就又随轮次的信任级变，而那正是被禁掉的那件事（`tools` 段是请求体最前面的稳定前缀，
 * 清单一变，它之后那整段历史的前缀缓存全部失效；实测同签名命中 85.2% / 换签名 41.2%）。
 *
 * 外部来源那几轮**不是不收紧，是换了一层**：收窄挪到**执行期**——`docs/design.md:1029`
 * 的定稿口径，落在 `authz.ts` 的 `authzGate` 上。两种选项由用户在 GUI 选（默认软提醒、
 * 可切硬拒绝，`config.tools.groupSceneHardRefusal`）。
 *
 * 所以：**函数与用例都留着，接线点就是"不接"**。要动工具数组只有一条路——**版本更新**
 * （用户明说的例外），那时连 `RENDER_VERSION` 一起递增，并按 `render.ts` 的红线走全套。
 * 别照 `docs/mcp-chain-review.md` 的建议 A1 把它接回去：那份稿子写于裁决之前。
 */
export function modelVisibilityFor(
  trust: TurnTrust,
  configured: boolean | readonly string[],
): ModelVisibility {
  if (trust === 'external') return { allowOnly: EXTERNAL_TOOL_ALLOWLIST };
  if (trust === 'trusted') return { includeDestructive: false };
  return { includeDestructive: configured };
}
