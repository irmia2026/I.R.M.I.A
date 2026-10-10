/**
 * Irmia Agent — MCP server 的「它是干什么的」那一句（`desc` 的来源与判据）
 *
 * 用户 2026-10-11 的原话（这一篇就是为它写的）：
 * 「她刚加入的 obscura，**索引内容质量低**。我觉得这东西得**要求 LLM 弄懂了加的是什么、
 *  用于什么，再自主填写**才对。（或者人添加时直接填写 desc）」
 *
 * ──────────────────────────── 它解决的是什么 ────────────────────────────
 *
 * 常驻索引里一个 server 原先长这样（`persona/assets.ts` 的 `mcpIndexLineOf`）：
 *
 *     - obscura —— 启用，工具清单还没拉过（要看就调 mcp 工具）
 *
 * 三个事实（名字 / 状态 / 工具数）都在，**但没有一个字说它是干什么的**——用户正是拿这一行
 * 来抱怨的。`desc` 就是补上那一格的：`- obscura —— <desc> —— 启用，已见 3 件工具`。
 *
 * ──────────────────────────── desc 从哪来（判据，按优先级） ────────────────────────────
 *
 * **两个来源，顺序是判据不是风格**（`mcpServerDescOf` 是唯一实现，索引与申请单都调它）：
 *
 *   ① **`config.json` 的 `mcp.servers[].desc`**（`source: 'config'`）——**权威**。
 *      它是"加这个 server 的人（或她，经人批准）弄懂了之后写下来的那句话"。
 *   ② **落盘清单缓存里 server 自报的工具描述**（`source: 'cache'`）——**兜底，而且如实标注**。
 *      老配置没有 `desc` 字段（这一格是 2026-10-11 才有的），而 `<dataDir>/mcp-cache/<server>.json`
 *      里存着它自己给的每件工具的 description（`client.ts` 的 `McpToolsCacheFile.tools`）。
 *      从里面取**第一句非空描述**，就回答得了"它是干什么的"。
 *
 * **为什么顺序不能反过来**：`desc` 是人（或人批过的她）**声明**的用途，它是这一格的**权威**；
 * 而缓存里那句是 server **自报**的——它是一句**推断**，可能只是某一件工具的简介，
 * 也可能与"这个 server 整体是干什么的"不是一回事。有声明就用声明，没有才推断。
 *
 * **推断那一档必须在正文里承认自己是推断**（`describeMcpIndexDesc` 返回的 `fromCacheLabel`
 * 就是那句话）：把 server 自报的一句工具描述不加标注地摆在索引里，就等于**假造了一条声明**
 * ——而这一格的用户恰恰是最在意"别编"的那一位（同 `toolsClauseOf` 的「还没拉过 ≠ 0 件」）。
 *
 * **一个字的用法都不替她编**（与 `persona/assets.ts` 文件头那条纪律同源）：本模块只做
 * "从已经存在的事实里取出那句话、洗净、截断"，**不生成**任何描述。取不到就是取不到——
 * 索引里照实只写名字（`noDesc`），绝不拿名字凑一句同义反复。
 *
 * ──────────────────────────── 老配置（没有这一格） ────────────────────────────
 *
 * `desc` 是**可选字段**：缺了照旧可用（`parseMcpServers` 不因它抛错），索引那一行只是没有
 * 那句话。三种"没有"分得开，一个都不许混：
 *   • `reason: 'absent'` —— 配置里没写、缓存里也没有 ⇒ 索引行写"配置里没写它做什么"；
 *   • `reason: 'cache-only'` —— 配置没写但缓存里有 ⇒ **照实说是推断**（`fromCacheLabel`）；
 *   • 缓存文件坏了 / 版本不对 / 没有那个文件 ⇒ 与 `absent` 同路（**不报错、不告警**：
 *     一段索引不值得让进程多一句抱怨，同 `assets.ts` 的 `readToolsCacheFile`）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MCP_TOOLS_CACHE_DIR, MCP_TOOLS_CACHE_VERSION, type McpServerEntry } from './client.ts';

// ──────────────────────────────── 上限 ────────────────────────────────

/**
 * 索引行里那一句话的长度上限（字符）。
 *
 * 为什么是 120：这一行要**逐字节进请求前缀**（`RENDER_VERSION` 那一族的缓存代价），
 * 而一段索引里可能有好几个 server——一句描述写满一屏会把索引本身变成噪音。
 * 120 足够写完"它是干什么的"（中文一句话约 20–40 字），超出部分**可见地截断**（`…`），
 * 绝不静默吞掉（同 `mcp-entry.ts` 的 `sanitizeToolField` 第四条）。
 */
export const MCP_DESC_MAX_CHARS = 120;

/**
 * 声明里那一句 `desc` 的长度上限（字符）。**超了就判"说不清"，而不是截断**。
 *
 * 与 [MCP_DESC_MAX_CHARS] 刻意不同，理由是一条：**索引行可以截断，声明不行**。
 * 索引行截断之后她仍能看到"这句话还有后半截"（有 `…`），而一条 500 字的 desc 被批准写进
 * `config.json` 之后，没有任何一处会再告诉写它的人"你写太长了、索引里看不到全的"
 * ——那正是用户抱怨的那件事（索引读起来没用）的另一个版本。⇒ 当场退回去让她重写一句短的。
 */
export const MCP_DESC_DECLARED_MAX_CHARS = 200;

// ──────────────────────────────── 洗净 ────────────────────────────────

/**
 * 把一句话压成**一行**（去控制字符、去反引号、压平空白），**不截断**。
 *
 * 三件事与 `mcp-entry.ts` 的 `sanitizeToolField` 同源（那里管的是 server 给的工具描述，
 * 这里管的是 server 的用途描述，两者都是要进上下文的**外部或半可信文本**）：
 *   • **去控制字符**（含换行）：一行一条是索引的**结构**，换行是唯一能破坏它的字符
 *     ——描述里带换行 = 能把"一个 server"伪装成"多行 + 伪造的下一行条目"；
 *   • **去反引号**：我们自己的排版用 `——`，而反引号在她那里常被读成"这是命令/代码"；
 *   • **压空白**（含全角/不换行空格）：让"一行"真的是一行。
 *
 * 截断**不在这里**：`desc` 声明超限要判"说不清"（见 [MCP_DESC_DECLARED_MAX_CHARS]），
 * 而渲染用的那句才截断（见 [describeMcpIndexDesc]）。混在一个函数里就没法区分这两件事。
 */
export function sanitizeMcpDescText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/`/gu, '')
    .replace(/[\s\u3000\u00a0]+/gu, ' ')
    .trim();
}

// ──────────────────────────────── 声明那一侧 ────────────────────────────────

/** 一句话**像不像**"说清了它是干什么的"（判据与理由见 [mcpDescProblem]） */
const NAME_ECHO_OF = (desc: string): string => desc.replace(/[\s\-_/\\|、,，.。:：;；"'「」『』()（）[\]【】]/gu, '');

/**
 * 她**发起**时那句 `desc` 合不合格；合格给 `null`，不合格给一句**能读懂、能照着改**的话。
 *
 * 用户 2026-10-11 的口径（原话）：「**要求 LLM 弄懂了加的是什么、用于什么，再自主填写**」，
 * 并且「空/敷衍（例如只有『浏览器自动化』五个字、或抄名字）⇒ 回执**如实要求她先弄清再填**」。
 *
 * 四条判据，一条都不许松（每一条都对应一种真实见过的敷衍）：
 *
 *   ① **不能空**：空 = 她没弄懂。而这一格是**唯一**能回答"加它干嘛"的地方（索引那一行
 *      就靠它）——留空等于又回到用户抱怨的那个状态。
 *   ② **不能只是名字的同义反复**（`obscura` → `"obscura"`、`"obscura server"`）：
 *      那种话在索引里等于没写（她读到的还是名字），而且看起来像写过了——**比留空更坏**。
 *   ③ **不能太短**（< 4 个字符）：中英混排下"四字以下"几乎不可能是"用途"。
 *   ④ **不能太长**（> [MCP_DESC_DECLARED_MAX_CHARS]）：索引行装不下（理由见那个常量）。
 *
 * **刻意不做的两件事**（免得下一个人当成漏了）：
 *   • 不做"关键词黑名单"（例如不许写"工具"）：判据要能被复算，而不是一份会过期的词表；
 *   • **不替她改写**（不生成、不建议一句话）：那正是"框架替她编"——本仓库最硬的一条纪律。
 *     这里只**拒绝**并说清要求，改由她自己写。
 */
export function mcpDescProblem(name: string, desc: string): string | null {
  const text = sanitizeMcpDescText(desc);
  if (text === '') {
    return 'desc 是空的。**这句话会一直摆在你自己的常驻索引里**（一个 server 一行），'
      + '是你下次决定"要不要用它、怎么用它"时唯一看得到的说明——'
      + '先把它弄懂（读它的 README / 跑一次它的 --help / 看它有哪些工具），再用一句话写下来。';
  }
  if (text.length > MCP_DESC_DECLARED_MAX_CHARS) {
    return `desc 写了 ${text.length} 个字，超过 ${MCP_DESC_DECLARED_MAX_CHARS} 个字的格子：`
      + '它要进的是**索引里的一行**，不是一段介绍。把"它是干什么的、你打算用它做什么"压成一句话再发一次。';
  }
  // 去标点后与名字逐字相同（含 `name` + 常见后缀）：这是"抄了一遍名字"
  const compact = NAME_ECHO_OF(text).toLowerCase();
  const bare = NAME_ECHO_OF(name).toLowerCase();
  if (compact === bare || compact === `${bare}server` || compact === `${bare}mcp`) {
    return `desc 与 server 名「${name}」是同义反复，等于没写：它在索引里读起来还是只有名字。`
      + '写"**它是干什么的**"（例：「读本机浏览器历史与当前标签页」），不是复述名字。';
  }
  if (text.length < 4) {
    return 'desc 只有 ' + text.length + ' 个字，太短了：说清"这个 server 是干什么的、你打算用它做什么"，'
      + '一句话写完（这是索引里那一行，不是标题）。';
  }
  return null;
}

// ──────────────────────────────── 缓存那一侧（兜底） ────────────────────────────────

/**
 * 从落盘清单缓存里取一句"它是干什么的"（**兜底**，见文件头的判据 ②）。
 *
 * 四条分寸：
 *   • **只认第一句非空描述**：缓存里那 N 件工具是同一个 server 提供的，第一句通常最接近
 *     "这个 server 整体是干什么的"；把 N 句拼起来会得到一个句子的缝合怪。
 *   • **版本对不上 / 文件没有 / JSON 坏了 ⇒ null**（不抛、不告警）：缓存是**加速器**
 *     （`client.ts` 的注释如此），读不动就当没有——一段索引不值得让进程多一句抱怨。
 *   • **不校验 `fingerprint`**：那要重算 server 指纹（command/args/cwd/env 的散列），属于池的
 *     内部口径（`entryFingerprint`）；本模块重写一遍就是第二份实现。
 *   • 只读 `tools[].description` 一格，别的字段一格不碰。
 */
export function readMcpCacheToolDesc(dataDir: string, server: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, MCP_TOOLS_CACHE_DIR, `${server}.json`), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== MCP_TOOLS_CACHE_VERSION) return null;
  // 缓存属于哪个 server 要自己对上（缓存目录里是 `<name>.json`，但文件名不是判据——文件里那格才是）
  if (typeof record['server'] !== 'string' || record['server'] !== server) return null;
  const tools = record['tools'];
  if (!Array.isArray(tools)) return null;
  for (const item of tools) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const description = (item as Record<string, unknown>)['description'];
    if (typeof description !== 'string') continue;
    const text = sanitizeMcpDescText(description);
    if (text !== '') return text;
  }
  return null;
}

// ──────────────────────────────── 对外：一个 server 的那句话 ────────────────────────────────

/** 这句话是**声明**（权威）还是**推断**（server 自报的工具描述） */
export type McpDescSource = 'config' | 'cache';

export interface McpServerDesc {
  /** 洗净之后那句话；取不到时是空串（**不编**） */
  text: string;
  /** `text === ''` 时为什么没有这句话：`absent` = 声明与缓存都没有 */
  source: McpDescSource | 'absent';
}

/**
 * 一个 server 的"它是干什么的"（**唯一实现**：索引渲染与申请单校验都调它，两处不许各拼一遍）。
 *
 * 优先级与理由见文件头。`text` 是**已经洗净**的那一份（去控制字符、压成一行），
 * 但**没有截断**——截断是渲染那一侧的事（[describeMcpIndexDesc]）。
 */
export function mcpServerDescOf(entry: McpServerEntry, dataDir: string): McpServerDesc {
  const declared = typeof entry.desc === 'string' ? sanitizeMcpDescText(entry.desc) : '';
  if (declared !== '') return { text: declared, source: 'config' };
  const inferred = readMcpCacheToolDesc(dataDir, entry.name);
  if (inferred !== null && inferred !== '') return { text: inferred, source: 'cache' };
  return { text: '', source: 'absent' };
}

/** 索引行里那句话（声明 / 推断 / 没有，三种） */
export type McpIndexDesc =
  | { kind: 'declared'; text: string }
  | { kind: 'inferred'; text: string; label: string }
  | { kind: 'none' };

/**
 * 把 [mcpServerDescOf] 的结论变成**索引行里**那一小截。
 *
 * 三种结果，三种写法（**没有一种会编**）：
 *   • `declared` —— 声明那句，超长**可见地截断**（末尾 `…`，绝不静默）；
 *   • `inferred` —— 推断那句 + [MCP_DESC_INFERRED_LABEL]（**必须带标注**，理由见文件头）；
 *   • `none`     —— 没有就是没有（调用方照实只写名字，见 `mcpIndexLineOf`）。
 */
export function describeMcpIndexDesc(desc: McpServerDesc): McpIndexDesc {
  const text = desc.text.trim();
  if (text === '' || desc.source === 'absent') return { kind: 'none' };
  if (desc.source === 'cache') {
    // 推断那一档：**先截到第一句**再截长度（判据见 [MCP_DESC_INFERRED_LABEL] 的注释）
    const first = firstSentenceOf(text);
    const clipped = first.length > MCP_DESC_MAX_CHARS ? `${first.slice(0, MCP_DESC_MAX_CHARS)}…` : first;
    return { kind: 'inferred', text: clipped, label: MCP_DESC_INFERRED_LABEL };
  }
  return { kind: 'declared', text: text.length > MCP_DESC_MAX_CHARS ? `${text.slice(0, MCP_DESC_MAX_CHARS)}…` : text };
}

/**
 * 一句话的**第一句**（中英句末标点都认；认不出来就整串还回去）。
 *
 * 为什么推断那一档要截到第一句：缓存里那一句是**某一件工具**的简介（可能还很长——
 * 工具描述在本仓库里有自己的预算，见 `tools/registry.ts` 的 `MAX_DESCRIPTION_TOKENS`），
 * 而索引行要的是"这个 server 是干什么的"这一句概述。把一整段工具说明搬进常驻索引，
 * 既挤掉别的 server 的行，也会把"怎么调用它"的细节塞进一个**本来只回答有哪些 server**
 * 的地方（v46 那条纪律：这一段里一个工具名都不该有）。
 *
 * 只截**第一句**、不做改写：框架一个字的用法都不替她编（`assets.ts` 文件头那条纪律）。
 */
function firstSentenceOf(text: string): string {
  const hit = /[。！？!?；;]/u.exec(text);
  if (hit === null || hit.index === 0) return text;
  return text.slice(0, hit.index + 1).trim();
}

/**
 * 推断那一档的标注。**加这句话是本模块存在的意义之一**：不标注就等于把"server 自报的
 * 某一件工具的简介"冒充成"声明的用途"——而这一格的用户恰恰最在意别编。
 *
 * 它与 [MCP_DESC_MISSING_CLAUSE] 的**取舍是刻意的**（两条判据都写在这里，免得下一轮有人
 * 顺手删掉一条）：
 *   • 有缓存时**用它**（带标注）：用户报的那件事正是"`obscura` 一个字都没有"——索引里
 *     写着"据它自报的工具描述：读浏览器历史"远比只写个名字有用，而"据它自报"四个字
 *     保证了她（与人）知道**这不是一句声明**；
 *   • 连缓存都没有才写"配置里没写它做什么"：那时确实一个字都拿不到，如实说是唯一的选项。
 *   **两种情况都不许编**：不拿名字凑、不拿"某个工具的描述"冒充 server 的用途。
 */
export const MCP_DESC_INFERRED_LABEL = '（据它自报的工具描述）';

/**
 * `desc` 缺失时索引行里那一句**如实**的话（不编一句描述出来，也不假装这一格不存在）。
 *
 * 为什么非写不可（而不是干脆不写那一截）：用户这一轮要的判据是"**必须带一句它是干什么的**"。
 * 一句都不写，索引读起来与改动之前**逐字相同**——那正是他抱怨的那一行；
 * 而写了"配置里没写它做什么"，人一眼就看得出"该补的是这一格"，她也会知道
 * "这个 server 我只能看见名字"（而不是以为它没有用途）。
 *
 * 措辞刻意不是"（未声明）"那种缩写：它要能被人**直接读懂并行动**。
 */
export const MCP_DESC_MISSING_CLAUSE = '（配置里没写它做什么）';
