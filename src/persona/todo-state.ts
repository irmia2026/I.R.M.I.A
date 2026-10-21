/**
 * Irmia Agent — 「任务清单」的唯一载体：`STATE.md` 的两节
 *
 * 2026-10-04 用户的口径（合并成一份）：「state 应该是类似 todo 的地位的。甚至就应该取代 todo。」
 * →「或者说合并」。所以待办**不再有第二本账**：
 *
 *   • **载体**：`STATE.md` 里两节——`## 当前任务`（当下在做的那一件）与`## 接着干`（排队的那些）；
 *   • **写法**（工具描述里逐字告诉她，她照这个写）：
 *     `- [ ] 一件还没开始的` / `- [~] 正在做的` / `- [x] 已经做完的`；
 *   • **谁在写**：`todo` 工具（名字与调用方式**一个字节没变**，items 仍是全量替换），
 *     它现在把清单**写进这两节**，而不是另起一份投影里的 `todoList`；
 *   • **谁在读**：任务卡（此刻层那条 `当前任务：…` + `未完成计划：`）只从这两节渲染——
 *     显示单源，与 STATE 永远同源。
 *
 * ## 为什么替换必须走 `planEdit`
 *
 * `STATE.md` 是**她手写的资产**（17 KB，里面还有心情、结案记录、群的边界…）。清单只占其中两节，
 * 其余字节**一个都不许动**。所以这里不写第二份匹配逻辑：替换用 `tools/fs/edit-core.ts` 的
 * `planEdit`（与 `safe_edit` 同源的那一份：精确匹配 → 缩进容错 → 多命中消歧），
 * 定位不到就**如实报错**，绝不退回"整份重写"——那会静默毁掉她写的别的东西。
 *
 * ## 解析是宽容的（她自己会手写条目）
 *
 * 与"写"不同，"读"这一侧必须认她手写的样子：`-` / `*` / `1.` 都算条目，`[ ]` `[]` `[x]`
 * `[X]` `[~]` 都认（没有记号按未完成算）；不认的行（说明文字、小标题）不进清单，
 * 但**留在原处**——它们是她写的，机制不动它们。
 */

/** 与 `tools/admin.ts` 的 `TodoItem` 同形（那边从这个模块 import，避免两处各写一份） */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 承载清单的两节（顺序 = 写进 STATE 的顺序；`当前任务` 是"在做的那一件"，`接着干` 是"排队的"） */
export const TODO_SECTIONS = ['当前任务', '接着干'] as const;
export type TodoSection = typeof TODO_SECTIONS[number];

/** 两节之间的分界靠行首的二级标题；这一节到下一个 `## ` 之前都算它 */
const SECTION_HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/u;

/**
 * 一条待办的正文上限（字符）。
 *
 * 500 与 `admin.ts` 的 `TODO_SINGLE_CONTENT_MAX` 同值：**工具收得下的，解析也认**。
 * 收得更紧没有意义——那会让"她写了一条长待办"出现在文件里、却不进任务卡。
 */
const TODO_ROW_MAX_CHARS = 500;

/**
 * 找到承载清单的那一节。标题**以关键词开头**即认（实测她写成 `## 当前任务：无（收尾）`，
 * 多了后缀；换成精确相等就会"那一节明明在、机制说没有"）。
 *
 * 只做"读"这一侧要的事：拿到正文。**写**那一侧要的是行号区间，由 `regionOf` 单独算
 * （两者职责不同：一个认节、一个定位区间）。
 */
function findTodoSection(text: string, key: TodoSection): { title: string; body: string } | null {
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i += 1) {
    const title = SECTION_HEADING_RE.exec(lines[i] as string)?.[1]?.trim();
    if (title === undefined || !title.startsWith(key)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (SECTION_HEADING_RE.test(lines[j] as string)) { end = j; break; }
    }
    return { title, body: lines.slice(i + 1, end).join('\n') };
  }
  return null;
}

/** emoji / 记号开头的"叙事行"（`✅ …`、`**[10-03 …`）：那是她的日记，不是条目 */
const NARRATIVE_ROW_RE = /^(?:[✅✓✔❌⚠️🔴🟡🟢]|\*\*\[|「|\(|（)/u;

/**
 * **说明行**：`- 备注：…` / `- 注意：…` 这类，她写在清单旁边的话。
 *
 * 实测有这一条（`## 当前任务` 里就有 `- 备注：以后 coder 若真递**文件**，走 send_media…`）：
 * 不挡它，任务卡会把这句"给自己的备注"当成一件待办列进「未完成计划」。
 * 判据只认**冒号紧跟标签**的形状——`- 备注一下备份的事` 不算（那是真条目）。
 */
const NOTE_ROW_RE = /^(?:备注|注意|说明|注|附|补充|记|提示|提醒|现状|背景)(?:[:：]|$)/u;

/**
 * 一行 → 一个条目。不是条目就返回 null（那一行原样留着，不进清单）。
 *
 * 认的形状：`- [ ] 正文` / `- [x] 正文`（工具写的形态，最硬）· `- 正文` / `* 正文` ·
 * `1. 正文` / `1) 正文`。
 *
 * 三条限制都是被真实 STATE 逼出来的（实测她那两节里同时住着清单与日记）：
 *   ① 行首缩进最多 3 格——再深是正文里的嵌套；
 *   ② 正文长度 ≤ 500 字符——她写日记时那些长段落不该被当成"待办"抄进任务卡；
 *   ③ 不以 emoji / `**[` / 引号开头，也不是 `备注：…` 这类说明行——`✅ [10-03 办结]…`、
 *      `**[10-03 02:48 …] …`、`- 备注：…` 都是**叙述**，不是待办（它们照样留在 STATE 里，
 *      机制不动它们，只是不把它们算进清单）。
 */
export function parseTodoLine(line: string): TodoItem | null {
  const match = /^[ \t]{0,3}(?:[-*+]|\d{1,2}[.)])[ \t]+(?:\[([ xX~])\][ \t]*)?(.*)$/u.exec(line);
  if (match === null) return null;
  const marker = match[1];
  const content = (match[2] as string).trim();
  if (content === '') return null;
  if (content.length > TODO_ROW_MAX_CHARS) return null;
  if (NARRATIVE_ROW_RE.test(content)) return null;
  if (NOTE_ROW_RE.test(content)) return null;
  const status: TodoItem['status'] = marker === undefined
    ? 'pending'
    : marker === '~'
      ? 'in_progress'
      : marker === 'x' || marker === 'X'
        ? 'completed'
        : 'pending';
  return { content, status };
}

export interface ExtractResult {
  items: TodoItem[];
  /** 缺哪几节（空数组 = 两节都在） */
  missingSections: TodoSection[];
}

/**
 * 从 `STATE.md` 全文里读出清单。**纯函数**：只解析，不改文本，不读盘。
 *
 * 缺节不算错（她可能还没建那两节），由调用方决定怎么处置——写的那一侧会拒（见 `planTodoWrite`）。
 *
 * 一条要记住的实测（见 `parseTodoLine` 的三条限制）：**她那两节里同时住着清单与日记**
 * （`## 接着干` 里既有 `0. **[…]**` 这种叙述，也有普通条目）。所以解析是**逐行**判的，
 * 不设"整节像不像清单"的开关——那个开关会让"她手写了一条、其余是记号条目"的节整个漏掉。
 */
export function extractTodoItems(stateText: string): ExtractResult {
  const items: TodoItem[] = [];
  const missingSections: TodoSection[] = [];
  for (const key of TODO_SECTIONS) {
    const section = findTodoSection(stateText, key);
    if (section === null) {
      missingSections.push(key);
      continue;
    }
    for (const line of section.body.split('\n')) {
      const item = parseTodoLine(line);
      if (item !== null) items.push(item);
    }
  }
  return { items, missingSections };
}

/** 未完成项（任务卡只列这些；`in_progress` 也在内——它是"还没做完"） */
export function openTodoItems(stateText: string): string[] {
  return extractTodoItems(stateText)
    .items
    .filter((item) => item.status !== 'completed')
    .map((item) => item.content);
}

/**
 * 一个条目 → 一行的 markdown（`[ ]` / `[~]` / `[x]`）。
 *
 * 为什么是这个记号：`tools/admin.ts` 回执里那行就是这个形态（`describeTodo`），
 * 她认得出；而且它对人也是可读的（STATE 她会在界面上直接看）。
 */
export function renderTodoLine(item: TodoItem): string {
  const mark = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[~]' : '[ ]';
  return `- ${mark} ${item.content}`;
}

/** 把一批条目按"最先给出的先做"分回两节：第一件给 `当前任务`，其余给 `接着干` */
export function splitAcrossSections(items: readonly TodoItem[]): Record<TodoSection, TodoItem[]> {
  return {
    当前任务: items.slice(0, 1),
    接着干: items.slice(1),
  };
}

/**
 * 一节的**替换区间**（行号，0-based，左闭右开）。
 *
 * 区间语义刻意是 `[标题行, 下一节标题行)`——**含正文之后那串空行**，因为空行是这一节与下一节
 * 之间的分隔符：不把它算进来，替换掉正文就会把 `## 下一节` 顶到内容后面（少一个空行）。
 * 最后一节取到行数组末尾。
 */
interface SectionRegion {
  /** 正文首行（0-based，= 标题行 + 1） */
  bodyStart: number;
  /** 区间末尾（0-based，左闭右开） */
  regionEnd: number;
  /** 当前区间内容（`\n` 连接，**不含**末尾换行） */
  regionLines: string[];
}

function regionOf(lines: readonly string[], key: TodoSection): SectionRegion | null {
  const heading = lines.findIndex((line) => SECTION_HEADING_RE.exec(line)?.[1]?.trim().startsWith(key) === true);
  if (heading === -1) return null;
  let regionEnd = lines.length;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (SECTION_HEADING_RE.test(lines[i] as string)) { regionEnd = i; break; }
  }
  return { bodyStart: heading + 1, regionEnd, regionLines: lines.slice(heading + 1, regionEnd) };
}

/**
 * 一节的新行（**含**收尾那个空行——它是与下一节之间的分隔符）。
 *
 * 空清单只留一个空行：`## 当前任务` 后面直接接下一节，不留一坨空行。
 */
function bodyLinesFor(items: readonly TodoItem[]): string[] {
  return items.length === 0 ? [''] : [...items.map(renderTodoLine), ''];
}

export type PlanTodoWriteResult =
  | { ok: true; text: string; summary: string; changed: boolean }
  | { ok: false; code: 'no_section' | 'no_match' | 'ambiguous' | 'invalid'; message: string };

/**
 * 规划一次"把清单写进 STATE 两节"的编辑。**不碰磁盘**（落盘由 admin 的写通道负责）。
 *
 * 三条纪律（都是本次合并的硬要求）：
 *  ① **只替换那两节的正文区间**——其余字节一个不动（别的节、她手写的说明行、心情…都不在区间里）；
 *  ② **定位不到就报错**（`no_section`），绝不退回"整份重写"；
 *  ③ 内容没变时 `changed: false`，调用方据此**不写盘**（幂等：重复写同一份清单不该产生一次
 *     `persona/updated` 与一次缓存失守）。
 *
 * ## 为什么是按行切区间，而不是拿正文喂 `planEdit` 的 `replace`
 *
 * 先说结论：**匹配那一层仍然只有一份实现**——`edit-core.ts` 里管"内容 → 内容"的是 `planEdit`
 * 的 `replace` 模式（精确 → 缩进容错 → 多命中消歧），管"**第几行到第几行**"的是它的
 * `insert_at_line` / `delete_lines` 两个行模式。这里要的正是后者：**行边界由节标题给出**，
 * 不存在"找不到"或"找到多处"的不确定性，所以不该把已知的行号问题丢给字符串匹配器。
 *
 * 实测过前者（不是为了省事，是先试了）：`planTodoWrite` 第一版把"一节正文"当 `old` 喂给
 * `planEdit(replace)`，在**真实 STATE.md 上必然失败**——`planEdit` 先把输入按"行尾统一成 `\n`"
 * 的中间形态处理，而"一节正文"这个切片**天生带末尾换行**（`…\n\n`），归一化后 old 的尾随空行
 * 没了、正文里的空行也跟着变，于是精确匹配与缩进容错都不命中（实测报 `NO_MATCH`，
 * 而那一节明明就在文件里）。用行模式就没有这个错配。
 *
 * 换行风格按原文探测（`\r\n` 还是 `\n`），与 `planEdit` 的 `rebuild` 同一条纪律：
 * **不许把 CRLF 文件改成 LF**。
 */
export function planTodoWrite(stateText: string, items: readonly TodoItem[]): PlanTodoWriteResult {
  const eol = stateText.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = stateText.endsWith(eol);
  const lines = stateText.split(eol);

  // 两节的区间都先算出来（用到的是**原始**行号），再按下标从后往前改——倒着改不会让前面的下标失效。
  // 顺序反了（`## 接着干` 在 `## 当前任务` 之前）也能处理，但那是她手改过的形状，报出来更好。
  const regions = TODO_SECTIONS.map((key) => ({ key, region: regionOf(lines, key) }));

  const missing = regions.filter((r) => r.region === null).map((r) => r.key);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'no_section',
      message:
        `STATE.md 里找不到${missing.map((key) => `「## ${key}」`).join('')}这一节，`
        + '清单没有写入（其余内容一个字节都没动）。'
        + `待办只写在 STATE 的「${TODO_SECTIONS.join('」「')}」两节里；`
        + `请先在 STATE.md 里补上它们（两行标题分别写成 \`## ${TODO_SECTIONS[0]}\` 与 \`## ${TODO_SECTIONS[1]}\`），`
        + '再重新调用 todo。',
    };
  }

  const perSection = splitAcrossSections(items);
  const edits = regions
    .map(({ key, region }) => ({ key, region: region as SectionRegion, replacement: bodyLinesFor(perSection[key]) }))
    .sort((a, b) => b.region.bodyStart - a.region.bodyStart);

  let out = [...lines];
  const applied: string[] = [];
  for (const edit of edits) {
    if (edit.region.regionLines.join('\n') === edit.replacement.join('\n')) {
      applied.push(`${edit.key}: 无变化`);
      continue;
    }
    out = [
      ...out.slice(0, edit.region.bodyStart),
      ...edit.replacement,
      ...out.slice(edit.region.regionEnd),
    ];
    applied.push(`${edit.key}: ${edit.region.regionLines.length} 行 → ${edit.replacement.length} 行`);
  }

  // 末尾换行的口径：按原文来（有的资产末尾有换行、有的没有）。
  // 注意 `out` 最后一格是 split 出来的"空尾巴"：原文以换行结尾时它就在那儿（长度不减）。
  let text = out.join(eol);
  if (trailingNewline && !text.endsWith(eol)) text += eol;
  if (!trailingNewline && text.endsWith(eol)) text = text.slice(0, -eol.length);

  return { ok: true, text, changed: text !== stateText, summary: applied.join('；') };
}
