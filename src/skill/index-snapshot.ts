/**
 * **`skill/index` 快照的唯一写入口**（2026-10-23 抽出）。
 *
 * ──────────────────────────── 为什么要把这一段抽出来 ────────────────────────────
 *
 * 在这之前，"构建文本 + 写事件"这一段只长在 `RealLoop.skillIndexSync` 里，也就是说
 * `skill/index` 只有**循环**那一条写入路径：首次 / 模板换代 / 压缩之后（三条判据见那个方法头）。
 *
 * 2026-10-23 迁移事故暴露了这套判据缺的一格：她的信任表已经修好（`skill list` 7/7 生效），
 * 可日志里那份快照还是事故当场写下的**2 个技能**——而循环那三条判据**一条都不成立**
 * （version 一致、seq 不小于 coveredSeq、日志里已有快照）⇒ **重启也不会重建**，
 * 只能等她下一次压缩摘要。代价是固定块里那一段只列 2 个技能：另外 5 个她**看不见**，
 * 等于能力暂时缺失。这类"信任表对了，字节却停在旧快照上"的现场，需要一个**由人发起**的归集。
 *
 * 修法有两个诱人的错法，这一格存在的意义就是同时躲开它们：
 *
 *   ① **在 CLI 里复制一份"构建文本 + 写事件"**——两份字节迟早漂开（一个改了键顺序、
 *      一个忘了 `truncated`），而它们写的是**同一格日志**：`render` 取最后一条，
 *      于是"同一份日志重建同一份请求"这条承诺当场作废，而且没有谁会立刻发现；
 *   ② **在 CLI 里伪造一条 `compaction/summary`**（让它看起来"该归集了"）——那是往唯一
 *      真相源里灌一条**没发生过的压缩**，投影、预算、审计全会被它骗过去。
 *
 * ⇒ 所以只抽这一段：**一条事件类型、一个口径、一份实现**，循环与人工归集共用。
 * 事件 data 的形状（含**键顺序**）就定在这里，两个调用点谁都改不了它。
 *
 * ──────────────────────────── data 的三个字段（与循环那次逐字段相同） ────────────────────────────
 *
 * 键序照抄原来那段字面量：`version` → `text` → `skills`。日志是逐字节的，键序变了就是
 * 另一条字节串，`replay` 与审计会把它当成"不同的一次归集"。
 *   • `version`：写下它时的 `RENDER_VERSION`（快照的度量衡，口径见 `SkillIndexSnapshot`）；
 *   • `text`：`SkillManager.catalog().text`——**逐字节进请求的那一段**，这里一个字节都不重拼
 *     （信任门、单条/总 token 预算、截断全在 `catalog()` 里，见 `skillIndexSync` 方法头 ①）；
 *   • `skills`：进了索引的那几条（名字 / 进索引的那一句 / 估算 token / 截断标记），审计用。
 *
 * `coveredSeq` **不进 data**：它只参与**判据**（"快照早于最后一次压缩 ⇒ 该归集"），而
 * "最后一条 `compaction/summary` 是谁"日志里本来就有（`skillIndexOf` 同一个口径）。
 * 把它复制进快照等于把同一件事记两遍，还给"同一份请求"多一个可以漂的字段。
 *
 * ──────────────────────────── 空索引不写（与 `mcpIndexSync` 同一条口径） ────────────────────────────
 *
 * `text === ''`（那一刻一个可用技能都没有）时**不写事件**：该段在渲染层整段不出现
 * （`render` 的 `push('skills', …)` 只在非空时出现），写一条空快照只会在事件流里多一行
 * 没人读的东西，还会让"事件序列逐字相同"的基线无故变红。调用方拿到 `skipped: 'empty'`
 * 与空文本，照旧把"这一拍定下的是空串"记进自己的缓存。
 *
 * ──────────────────────────── 幂等只属人工那一路（`skipWhenUnchanged`） ────────────────────────────
 *
 * 循环那一路**不传** `skipWhenUnchanged`：它只在三条判据成立时走到这里，而其中一条
 * （`点.seq < 点.coveredSeq`）表达的是"这份快照早于最后一次压缩"——**即使文本一字未变，
 * 那条事件也是必须写的**：它记录的正是"我现在归集到了这次压缩之后"，少了它下一拍还会判过期。
 *
 * 人点的这一次不同（`irmia skill reindex`）：它没有新的压缩要覆盖，字节没变还写一条，
 * 纯属在日志里多一句噪声（而且会让"事件序列逐字相同"的基线变红）⇒ 人那一路传 `true`。
 * 判"字节没变"的**口径是三项一起**：已有快照存在、`text` 逐字节相同、`version` 同代。
 * 只看 text 会漏掉模板换代（那一版的快照该被换成新度量衡），只看 version 会漏掉技能变化。
 */

import type { AppEvent, SkillIndexEntry, SkillIndexSnapshot } from '../log/types.js';
import { RENDER_VERSION, skillIndexOf } from '../model/render.ts';
import type { SkillCatalog } from './skills.ts';

/**
 * 写一条 `skill/index` 的通道（落库由宿主负责，与 `SkillManager` 的 `emit` 同一个形状）。
 *
 * 两个调用点各自实现它，而**构建 data 的那一步只有这一份**：
 *   • 循环：`(data) => this.appendSync('skill/index', data, 'internal')`（顺带折投影与压力）；
 *   • CLI ：`(data) => { const event = {…, seq: log.nextSeq(), …}; log.append(event, {sync:true}); return event; }`。
 */
export type SkillIndexEventWriter = (data: SkillIndexSnapshot) => AppEvent;

export interface WriteSkillIndexSnapshotDeps {
  /**
   * 本拍看到的事件快照（**只读**）：读"最后一条 `compaction/summary`"（算 `coveredSeq`）
   * 与"已有快照是什么"（判幂等）。写入点仍然是日志，这里不就地改它。
   */
  events: readonly AppEvent[];
  /** 技能目录；`null` = 这一任没有技能系统（循环里 `skills` 可空） */
  catalog: SkillCatalog | null;
  /** 落一条 `skill/index` 并返回它（见 [SkillIndexEventWriter]） */
  write: SkillIndexEventWriter;
  /** 模板代（缺省 `RENDER_VERSION`；测试注入用） */
  version?: string;
  /**
   * 内容与当前快照逐字节相同的**人工**归集不写事件（理由见文件头最后一段）。
   * 循环那一路**不许**传它。
   */
  skipWhenUnchanged?: boolean;
}

export interface WriteSkillIndexSnapshotResult {
  /** 这一次真写下去了没有（`false` 时要看 `skipped` 才知道为什么） */
  written: boolean;
  /** 写下（或本该写下）的那条事件的 seq；没写时给**已有快照**的 seq，没有快照时 0 */
  seq: number;
  /** 这一拍定下的文本（`''` = 一个可用技能都没有） */
  text: string;
  /** 写进快照（或本该写进快照）的模板代 */
  version: string;
  /** 最后一条 `compaction/summary` 的 seq（与循环那次同一口径）；没有时为 0 */
  coveredSeq: number;
  /** 进了索引的技能条数 */
  entries: number;
  /** 还在等信任门的条数（`catalog.pending`） */
  pending: number;
  /** catalog 估算 token（含头部固定文案，与 `skill list` 同一个数） */
  tokens: number;
  /** 为什么没写；写了就是 `null` */
  skipped: 'empty' | 'unchanged' | null;
}

/**
 * 构建这一版技能索引的文本与事件 data，并（按需）落一条 `skill/index`。
 *
 * ⚠ `events` 会被扫两遍的场景只有一个：循环那一路先自己扫一遍判 stale，再在这里扫一遍算
 * `coveredSeq`——而它只在**该重建的那一拍**走到这里（不是每拍），与 `mcpIndexSync` 同一量级，
 * 不值得为它把 `SkillIndexPoint` 从调用方传进来（那会让"data 从哪来"多一个来源）。
 */
export function writeSkillIndexSnapshot(
  deps: WriteSkillIndexSnapshotDeps,
): WriteSkillIndexSnapshotResult {
  const point = skillIndexOf(deps.events);
  const version = deps.version ?? RENDER_VERSION;
  const text = deps.catalog?.text ?? '';
  const entries = deps.catalog?.entries ?? [];
  const counts = {
    version,
    coveredSeq: point.coveredSeq,
    entries: entries.length,
    pending: deps.catalog?.pending.length ?? 0,
    tokens: deps.catalog?.tokens ?? 0,
  };

  // 空索引分两种形状（判据见文件头）：首启不写；**从非空变空必须写墓碑**。
  // 不写的话，重建（`replay` 的 `skillCatalogForReplay`）读到的仍是上一条非空快照——
  // 「实时请求里已经没有了、重建又把它请回来」，同一份日志重建出两份不同的请求。
  if (text === '') {
    if (point.seq === 0 || (point.text ?? '') === '') {
      // 首启（从来没有过快照）或已经是空快照：空快照与「没有快照」在渲染上逐字节等价，
      // 再写一条只会在事件流里多一行没人读的东西，还会让「事件序列逐字相同」的基线无故变红。
      return { written: false, seq: point.seq, text: '', ...counts, skipped: 'empty' };
    }
    // 从非空变空：写一条 `text: ''` 的墓碑。写完下一拍 `point.text === ''` ⇒ 不会再写，
    // 不会每拍刷事件。
    const event = deps.write({ version, text: '', skills: [] });
    return { written: true, seq: event.seq, text: '', ...counts, skipped: null };
  }

  // 人工归集的幂等：三项一起（理由见文件头最后一段）
  if (
    deps.skipWhenUnchanged === true
    && point.seq !== 0
    && point.text === text
    && point.version === version
  ) {
    return { written: false, seq: point.seq, text, ...counts, skipped: 'unchanged' };
  }

  // 键序就是日志里那串字节的形状：**别动顺序**（改它 = 改历史快照的可比性）
  const data: SkillIndexSnapshot = {
    version,
    text,
    skills: entries.map((entry): SkillIndexEntry => ({
      name: entry.name,
      // 存的是**进索引的那一句**（已截断；正文永不在此出现，那是渐进披露第二层）
      description: entry.description,
      tokens: entry.tokens,
      ...(entry.truncated ? { truncated: true } : {}),
    })),
  };

  const event = deps.write(data);
  return { written: true, seq: event.seq, text, ...counts, skipped: null };
}
