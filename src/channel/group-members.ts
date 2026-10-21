/**
 * Irmia Agent — 群成员档案（自动注册的落点）
 *
 * 为什么要有它：QQ 官方**不给昵称、也没有查成员的接口**（成员列表要内邀白名单），所以"群里这位是谁"
 * 只能靠消息事件里见过谁。见过的人要有个地方落下，否则每次都只能看她那串 openid。
 *
 * 三条设计约束（都被现实逼出来的）：
 *
 * 1. **不写 config.json**。配置是用户手写的地方（`persona.contacts` 里的"这个会话是用户"）。自动注册
 *    是机器不停在写的东西，两者混在一起，用户一改配置就可能把几百条自动记录覆盖掉。所以单独一个文件
 *    `data/group-members.json`，而且**人写的永远压过自动的**（GUI 里改过一条，它就不再被自动覆盖）。
 * 2. **按 openid 建键，不按 sid**。群成员不是会话：他可能从没私聊过她。按 openid 平铺最省事，
 *    "在哪个群见的"作为字段记着（GUI 要按群分组显示）。
 * 3. **占位号只在没有昵称时发**，而且**按群、按首次出现顺序**发（群友A、群友B…），发了就不改——
 *    她昨天认得"群友A"是甲，今天不能变成乙（这条是 2026-10-03 那次"甲乙丙会飘"的教训）。
 *    但**占位号只在运行期发**：回填（`backfill`）是"消息已经过去了"的那条路，它**不发占位号**——
 *    没昵称就留空名，因为编出来的名字是持久的，而她当时并不在场（见 `backfill` 的四条性质）。
 * 4. **空条目才丢**（2026-10-07 回填引入）：名字、昵称、群归属三样全空的条目没有存在的理由；
 *    而"只有群归属、还没有名字"是回填的**正常形态**，读一次必须还活得回来（见 `load`）。
 *
 * 名字的权威顺序（与 `real-loop.personNameOf` 一致）：用户手写的联系人表 > 这份档案里的人写条目 >
 * 这份档案里的自动条目 > 她那串 id。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 档案文件名（相对 dataDir） */
export const GROUP_MEMBERS_FILE = 'group-members.json';

/** 占位号的字母表：甲/乙/丙 会与"按批次编号"的旧印象混淆，这里用更容易一眼看出是占位的 A、B、C */
const PLACEHOLDER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface GroupMemberEntry {
  /** 显示名（人写的或自动发的占位名） */
  name: string;
  /** 平台给的昵称/群名片（只作显示，不是身份） */
  nickname?: string;
  /** 在哪个群第一次见到（sid 形态：qq:group:<群id>） */
  groupSid?: string;
  /** 第一次见到的时间（ISO） */
  firstSeenAt?: string;
  /** 最近一次见到的时间（ISO） */
  lastSeenAt?: string;
  /** 'human' = 人改过（自动注册不再覆盖）；'auto' = 自动注册 */
  source: 'human' | 'auto';
}

interface GroupMembersDoc {
  version: 1;
  members: Record<string, GroupMemberEntry>;
}

function emptyDoc(): GroupMembersDoc {
  return { version: 1, members: {} };
}

/** 群成员档案：读写与"该给他起什么名"的唯一实现 */
export class GroupMemberBook {
  private readonly path: string;
  private members: Map<string, GroupMemberEntry>;
  /** 盘上文件的 mtime（毫秒）：变了就重读——她自己/GUI 改了文件，下一轮就该看见 */
  private mtimeMs: number;

  constructor(dataDir: string) {
    this.path = join(dataDir, GROUP_MEMBERS_FILE);
    const loaded = this.load();
    this.members = loaded.members;
    this.mtimeMs = loaded.mtimeMs;
  }

  private load(): { members: Map<string, GroupMemberEntry>; mtimeMs: number } {
    const members = new Map<string, GroupMemberEntry>();
    if (!existsSync(this.path)) return { members, mtimeMs: 0 };
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.path).mtimeMs;
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return { members, mtimeMs };
      const raw = (parsed as { members?: unknown }).members;
      if (typeof raw !== 'object' || raw === null) return { members, mtimeMs };
      for (const [openid, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'object' || value === null) continue;
        const entry = value as Record<string, unknown>;
        const name = typeof entry['name'] === 'string' ? entry['name'].trim() : '';
        const nickname = typeof entry['nickname'] === 'string' ? entry['nickname'].trim() : '';
        const groupSid = typeof entry['groupSid'] === 'string' ? entry['groupSid'].trim() : '';
        /**
         * 空条目才丢：**一条事实都没有**的条目没有存在的理由。
         *
         * 为什么判据是"三样全空"而不是只看 `name`（2026-10-07 回填引入）：回填**不发占位号**
         * （那是"凭空造名字"，见 `backfill`），所以它落下的条目可能是"只有群归属、还没有名字"
         * 的形态——那正是"见过这个人、但平台没给昵称"的如实记录，重启后必须活着回来。
         * 只看 `name` 的话，这类条目读一次就没了，等于回填白做。
         */
        if (name === '' && nickname === '' && groupSid === '') continue;
        members.set(openid, {
          name,
          ...(nickname === '' ? {} : { nickname }),
          ...(groupSid === '' ? {} : { groupSid }),
          ...(typeof entry['firstSeenAt'] === 'string' ? { firstSeenAt: entry['firstSeenAt'] } : {}),
          ...(typeof entry['lastSeenAt'] === 'string' ? { lastSeenAt: entry['lastSeenAt'] } : {}),
          source: entry['source'] === 'human' ? 'human' : 'auto',
        });
      }
    } catch {
      // 文件坏了就当空的：档案是"方便认人"的东西，读不动不该拦住她做事
      return { members: new Map(), mtimeMs };
    }
    return { members, mtimeMs };
  }

  /** 盘上变了就重读（每轮调一次，代价是一次 stat） */
  refresh(): void {
    if (!existsSync(this.path)) {
      if (this.members.size > 0 && this.mtimeMs !== 0) { this.members = new Map(); this.mtimeMs = 0; }
      return;
    }
    let mtimeMs = 0;
    try { mtimeMs = statSync(this.path).mtimeMs; } catch { return; }
    if (mtimeMs === this.mtimeMs) return;
    const loaded = this.load();
    this.members = loaded.members;
    this.mtimeMs = loaded.mtimeMs;
  }

  /** 查一个人的显示名（没有就 null——调用方自己决定退回 id 还是占位） */
  nameOf(openid: string): string | null {
    const entry = this.members.get(openid);
    return entry === undefined ? null : entry.name;
  }

  /** 全部条目（GUI 按群分组用） */
  all(): Array<{ openid: string; entry: GroupMemberEntry }> {
    return [...this.members.entries()].map(([openid, entry]) => ({ openid, entry }));
  }

  /** 某个群里见过的人（GUI 展开群会话时用） */
  inGroup(groupSid: string): Array<{ openid: string; entry: GroupMemberEntry }> {
    return this.all().filter((item) => item.entry.groupSid === groupSid);
  }

  get size(): number {
    return this.members.size;
  }

  /**
   * 自动注册/更新一个人。返回是否真的改了东西（false = 无需写盘）。
   *
   * 规则：
   *   • 已经有人写的名字（`source: 'human'`）→ **一律不动**（人改过的就是权威）；
   *   • 已经有自动占位名 → 只在**这次拿到了昵称、而原来没有**时更新（补上昵称，不改号）；
   *   • 没见过 → 发一个新占位号（按群、按现有条目数递增），有昵称时同时记下昵称。
   */
  register(input: {
    openid: string;
    groupSid: string;
    nickname?: string;
    at?: string;
  }): boolean {
    const openid = input.openid.trim();
    if (openid === '') return false;
    const nickname = (input.nickname ?? '').trim();
    const now = input.at ?? new Date().toISOString();
    const existing = this.members.get(openid);

    if (existing !== undefined) {
      if (existing.source === 'human') return false;
      let changed = false;
      const next: GroupMemberEntry = { ...existing };
      if (nickname !== '' && (existing.nickname ?? '') !== nickname) {
        // 昵称是我们能拿到的最好线索：显示名跟着昵称走，但**占位号本身不变**
        next.nickname = nickname;
        changed = true;
      }
      if (existing.groupSid === undefined) { next.groupSid = input.groupSid; changed = true; }
      if (existing.lastSeenAt !== now) { next.lastSeenAt = now; changed = true; }
      if (changed) this.members.set(openid, next);
      return changed;
    }

    const placeholder = this.nextPlaceholder(input.groupSid);
    this.members.set(openid, {
      name: nickname === '' ? placeholder : `${placeholder}（群昵称：${nickname}）`,
      ...(nickname === '' ? {} : { nickname }),
      groupSid: input.groupSid,
      firstSeenAt: now,
      lastSeenAt: now,
      source: 'auto',
    });
    return true;
  }

  /**
   * **只登记已经攒下来的事实**：回填（重启时把重启前那些"在群里叫过她"的人补进档案）。
   *
   * 与 {@link register} 的分工只有一条，而这条就是它存在的理由：
   *   • `register` 是**运行期**的路——她正看着这条消息，认不出的人要当场有个称呼，
   *     所以它会发占位号（`群友A`）。
   *   • `backfill` 是**回填**的路——消息是过去发生的，她此刻并没有在看，**发占位号就是凭空造名字**
   *     （"群友A"听着像她在场认过人，其实她没见过）。所以它只落**平台给的事实**：
   *     id ↔ 平台昵称（`sender.card` / `username`，没有就留空）与"在哪个群见过"。
   *
   * 四条性质，都是"回填"这个词逼出来的：
   *   ① **人写的永远不动**（`source: 'human'` 的条目整条跳过）——与 `register` 同一条纪律；
   *   ② **不删、不覆盖已有的事实**：只补缺的那些（昵称/群归属/首见时刻），已有名字一个字不改；
   *   ③ **幂等**：跑第二遍什么都不改（返回值 false）。所以时刻只**往前**走（`> `，不是 `!==`），
   *      同一批历史事件折两遍，第二遍的 `lastSeenAt` 与第一遍逐字节相同；
   *   ④ **不发占位号**：昵称缺失就留空名字——"认不出就照实留空"比"编一个群友A"诚实，
   *      而且那个编出来的名字是**持久**的（落盘、`personNameOf` 优先读它，往后每次引用都带着它）。
   *
   * 返回有没有改动（调用方据此决定要不要落盘）。
   */
  backfill(entries: readonly {
    openid: string;
    groupSid: string;
    /** 平台给的昵称；没有就不传（**不许**拿 id 或群友X 顶上） */
    nickname?: string;
    at: string;
  }[]): boolean {
    let changed = false;
    for (const input of entries) {
      const openid = input.openid.trim();
      const groupSid = input.groupSid.trim();
      if (openid === '' || groupSid === '') continue;
      const nickname = (input.nickname ?? '').trim();
      const existing = this.members.get(openid);
      if (existing === undefined) {
        // 第一次见：只落事实。有昵称就记下，没有就留空名字（**不是**占位号）
        this.members.set(openid, {
          name: nickname,
          ...(nickname === '' ? {} : { nickname }),
          groupSid,
          firstSeenAt: input.at,
          lastSeenAt: input.at,
          source: 'auto',
        });
        changed = true;
        continue;
      }
      if (existing.source === 'human') continue;
      const next: GroupMemberEntry = { ...existing };
      let touched = false;
      // 昵称是这里唯一会动的"显示线索"。**不回写 `name`**：占位号是运行期发的，她可能已经
      // 认过它（"群友A 是谁"），回填没资格替运行期改显示名——它只管补事实。
      if (nickname !== '' && (existing.nickname ?? '') !== nickname) {
        next.nickname = nickname;
        touched = true;
      }
      if ((existing.groupSid ?? '') === '') { next.groupSid = groupSid; touched = true; }
      if (existing.firstSeenAt === undefined) { next.firstSeenAt = input.at; touched = true; }
      if (existing.lastSeenAt === undefined || input.at > existing.lastSeenAt) {
        next.lastSeenAt = input.at;
        touched = true;
      }
      if (!touched) continue;
      this.members.set(openid, next);
      changed = true;
    }
    return changed;
  }

  /** 只补群归属（回填用：人写的名字不动，只记下"这是在哪个群见到的"） */
  setGroup(openid: string, groupSid: string): boolean {
    const key = openid.trim();
    if (key === '') return false;
    const existing = this.members.get(key);
    if (existing === undefined) return false;
    if (existing.groupSid === groupSid) return false;
    this.members.set(key, { ...existing, groupSid });
    return true;
  }

  /** 人改过的名字（GUI 编辑）：写成 `source: 'human'`，从此自动注册不再覆盖 */
  setName(openid: string, name: string, at?: string): boolean {
    const key = openid.trim();
    if (key === '') return false;
    const trimmed = name.trim();
    if (trimmed === '') return false;
    const existing = this.members.get(key);
    const now = at ?? new Date().toISOString();
    this.members.set(key, {
      ...(existing ?? {}),
      name: trimmed,
      ...(existing?.firstSeenAt === undefined ? { firstSeenAt: now } : {}),
      lastSeenAt: now,
      source: 'human',
    });
    return true;
  }

  /** 按群发下一个占位号（A、B、C…；超过 26 个就 AA、AB——不重复是硬要求） */
  private nextPlaceholder(groupSid: string): string {
    const used = new Set(
      [...this.members.values()]
        .filter((entry) => entry.groupSid === groupSid)
        .map((entry) => entry.name.replace(/（.*$/u, '').trim()),
    );
    for (let index = 0; index < 26 * 27; index += 1) {
      const letter = index < 26
        ? PLACEHOLDER_LETTERS[index]!
        : `${PLACEHOLDER_LETTERS[Math.floor(index / 26) - 1]!}${PLACEHOLDER_LETTERS[index % 26]!}`;
      const candidate = `群友${letter}`;
      if (!used.has(candidate)) return candidate;
    }
    return `群友${Date.now()}`;
  }

  /** 落盘（原子替换：先写临时文件再 rename，崩在中间不会留半份档案） */
  save(): void {
    const doc: GroupMembersDoc = { version: 1, members: Object.fromEntries(this.members) };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.path);
    try { this.mtimeMs = statSync(this.path).mtimeMs; } catch { /* 下一次 refresh 会兜住 */ }
  }
}
