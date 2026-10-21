/**
 * Irmia Agent — 聊天分段（speak 工具专用）
 *
 * 规则来自 YG 本人的口径，两句话就说完：
 *
 *   **每个候选标点上只做一个决定——摘不摘它。摘了就分段，不摘就不断。**
 *
 * 没有中间态：不存在"留着符号却在那儿断开"，也不存在"摘了符号还接着写"。所以这套规则
 * 只有一个开关，读起来与做起来是同一件事。
 *
 *   | 标点 | 摘不摘 | 为什么 |
 *   |---|---|---|
 *   | `。` | **一定摘** | 书面语的收尾，真人打字不写它 |
 *   | `，` `,` | **一定摘** | 意群停顿 |
 *   | `！` | **短句不摘**，长句摘 | 「好！」的叹号是语气本身，摘了就没那股劲 |
 *   | `？` `…` `；` `～` | **基本不摘** | 它们本身就是停顿的表情，摘掉反而丢东西 |
 *   | `、` | **不摘也不断** | 列举项是同一口气里的几样东西，拆开就成了点名册（2026-10-02 用户："顿号不拆了"） |
 *
 * 语气词（「唉」「哼」）单独一条：它出现在逗号前时，那个逗号必摘、那句必断——这是
 * 「摘出语气词」那条初衷的落点。
 *
 * 「基本不摘」里的"基本"由兜底承担：某一段长过 `SPLIT_MAX_CHARS` 时，`splitLong` 仍会在
 * 最近的标点处断开——那时断的是"太长了"，不是"这是个句末"。
 *
 * 另学自 AstrBot 分段插件的两条保护（github.com/nuomicici/astrbot_plugin_splitter）：
 * **成对符号保护**（括号 / 引号 / 书名号内部不被切断）与 **代码块保护**（``` 整段保留）。
 * 未采用：拟真延迟（多段在同一次工具调用里发出，IM 侧延迟天然形成间隔）、组件控制、TTS。
 *
 * 还有一条实测补的：**只认中文标点**。ASCII 的 `. ! ? ;` 不能当句末——它们在
 * `server.ts`、`v1.2`、`example.com` 里是词的一部分，当断点就是把词劈开。
 *
 * ──────────────────────── 判定顺序（2026-10-02 用户的三条追加口径） ────────────────────────
 *
 * 按**这个顺序**判，前一条成立就不看后面：
 *
 *   1. **太短不拆**（不足 `SPLIT_MIN_CHARS` = 12 字）：整段原样作为一条发出。
 *      线下面拆开的样子实测很难看：「好，不说了。」→「好」「不说了」（seq 2842）。
 *   2. **成对符号保护**：`（` `「` `『` `《` `〈` `【` `〔` `“` `‘`（含 ASCII 对应）**内部不许有切点**；
 *      嵌套按**栈**配对。**配不齐就保守**——整篇不拆，宁可让她一次说完，也不切进括号里。
 *   3. **选切点**：`cutLine` 认句末（`。` 与逗号类，以及她自己换的行）；
 *      `splitLong` 只管"某段长过上限"时的兜底，且**同样不许切进成对符号里**。
 *
 * 这个模块只做一件事——切。**除了被"摘掉"的那些标点，它不改动任何字**。
 */

/**
 * 一定摘的标点：切在这里，并且把这个标点**删掉**。
 *
 * **逗号与句号同级**（用户的口径：逗号全摘全分段）。不要"有时留着、有时摘掉"的随机形态——
 * 一条消息本身就是一个意群，逗号留着反而像书面语。所以这里没有概率：摘与不摘是同一个决定，
 * 而这两类标点永远摘。概率机制（以及为它准备的随机源注入）随之删掉，规则少一层。
 *
 * **顿号不在这里**（用户 2026-10-02："顿号不拆了"）：列举项属于同一口气。
 *
 * **只收中文标点**，另加 ASCII 逗号。ASCII 的 `. ? ;` 一律不当断点——它们被当成句末，
 * 实际却常常是结构字符：`server.ts` 被切成 `server` + `ts`，`v1.2` 变成 `v1` + `2`，
 * `example.com` 变成两截。实测吃过这个亏（她说的正是“改的是 server | ts”）。
 * 中文句号与逗号绝不会出现在词内部，所以只信它们。
 */
const ALWAYS_STRIP = new Set<string>(['。', '，', ',']);

/**
 * 太短就不拆的下限：**按中文计字口径**数出来的字数（`charCount`：一个字算一个，
 * emoji / 增补平面字符也算一个）——与 `speak` 文本长度上限（`maxLength`）同一个口径。
 *
 * 12 是用户定的线。线下面那些拆开的样子实测很难看：「好，不说了。」变成
 * 「好」「不说了」，「嗨。找我什么事，说吧。」变成三条（日志 seq 2842 / 4700 / 5067）。
 */
export const SPLIT_MIN_CHARS = 12;

/**
 * 短句不摘的叹号。
 *
 * 「好！」「真的！」「成了！」——叹号是那句语气的一部分，摘掉就只剩一个干巴巴的词；
 * 而「太好了我总算把这个破玩意儿修好了！」里叹号只是收尾，摘掉更像随手打的。
 * 判据是断点前的字数（不含标点本身），到这个数以内算短句。
 */
export const SHORT_EXCLAIM_CHARS = 5;

/**
 * 「基本不摘」的那些标点：它们在 `cutLine` 里留着且不断，只在 `splitLong` 兜底时**可以**
 * 当断点。**顿号不在此列**——连兜底也不在它身上断（用户："顿号不拆了"）。
 */
const SOFT_KEEP = new Set<string>(['？', '；', '…', '～']);

/**
 * 兜底断点：切点只能落在这些字符**之后**，且切完不留尾巴。
 *
 * 分两类：`。` `，` `,` 与空格是"丢掉派"（断了就消失，下一段不带着它起头）；
 * 其余是**续写型**——问号、分号、冒号、破折号是**上一句的收尾**，切在它们身上时把它们
 * 留给上一段，下一段从新句子起头。这条修的是实测里「…把话拆成 29 | 条全发出去了」
 * （问号被留在了下一段的头上）。
 */
const CUT_AFTER = new Set<string>(['。', '，', ',', ' ', '　', '？', '；', '…', '～', '：', '—']);

/**
 * 切点**之后**不能是这些字符：它们是上一句的收尾，不该成为下一句的开头。
 * 与 `CUT_AFTER` 一起把「劈开问号」「下一段以冒号起头」（`[image/jpeg: 哈希 | .jpg]` 那种）
 * 挡在外面——半角标点也一并收进来。
 */
const NO_CUT_BEFORE = new Set<string>(['？', '！', '…', '；', '～', '：', '—',
  '」', '』', '）', ')', '》', '〉', '】', '〕', '”', '’',
  '.', ',', ';', ':', '!', '?']);

/** 汉字（含扩展区）：只用来判"汉字 ↔ 非汉字"这个**兜底**断点，不参与一级断点 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

/**
 * 成对符号的开闭：内部一律不切。
 *
 * 用 `Map` 而不是两个互不相认的集合：`（` 与 `)` 混用（中文左 + 半角右）时也算一对——
 * 实测日志里两种混着写是常事。
 */
const PAIR_OPEN = new Map<string, string>([
  ['（', '）'], ['(', ')'],
  ['「', '」'], ['『', '』'],
  ['“', '”'], ['‘', '’'],
  ['《', '》'], ['〈', '〉'],
  ['【', '】'], ['〔', '〕'],
  ['[', ']'],
]);

/**
 * 同一族的左/右符号（`（` 与 `)` 算一族：实测混写很常见，不该判成配不齐）。
 * 左表与右表分开：配对判定问的是"这个符号是开口还是闭口"，不是"它属于哪一族"。
 */
const FAMILY_OPEN = new Set<string>(['（', '(', '「', '『', '“', '‘', '《', '〈', '【', '〔', '[']);
const FAMILY_CLOSE = new Set<string>(['）', ')', '」', '』', '”', '’', '》', '〉', '】', '〕', ']']);

/** 第几族（左 `（` 与右 `)` 同族）；-1 = 不是成对符号 */
function pairFamily(ch: string): number {
  if ('（()）'.includes(ch)) return 1;
  if ('「『'.includes(ch) || '」』'.includes(ch)) return 2;
  if ('“‘'.includes(ch) || '”’'.includes(ch)) return 3;
  if ('《〈'.includes(ch) || '》〉'.includes(ch)) return 4;
  if ('【〔'.includes(ch) || '】〕'.includes(ch)) return 5;
  if (ch === '[' || ch === ']') return 6;
  return -1;
}

/** 段长上限：超过它就找二级断点，再不行宁可不切 */
export const SPLIT_MAX_CHARS = 20;

/**
 * 「汉字↔非汉字交界」算不算断点：两侧至少各有这么多个同侧字符。
 *
 * 旧规则见到交界就下刀，于是 `server.ts` 边上、`2.2MB 的 PNG` 里、`[image/jpeg: 哈希.jpg]`
 * 的词中间都被切过（实测 `我按规矩说的话其实落不到谁手上——你能看 | 见的只是对话流`）。
 * 取 3 是"两侧都够长才认"，短到 `在的 | 。` 这种就不认了；这个数只影响兜底，不影响一级断点。
 */
const SPLIT_MIN_WORD_CHARS = 3;

export interface SplitOptions {
  max?: number;
  /** 注入随机源（测试用；缺省 Math.random）——破折号化开是加权随机的，用例要能钉住 */
  random?: () => number;
}

/**
 * 破折号化开（用户 2026-10-02 的口径）：`——` 随机换成「，」「~」「...」「。」「！」，
 * **越往后概率越低**。
 *
 * 为什么：`——` 是书面语的连接号，真人聊天几乎不打；她写出来会显得像在写文章。
 * 换成什么由**加权随机**定（下面那张表）。
 *
 * **顺序**（用户 2026-10-02 更正）：切分时 `——` **不算断点**（连接号两边是同一口气），
 * 所以是"**先切、后化开**"——`splitForChat` 在返回前对每条做这件事。反过来先化开的话，
 * "换成逗号"会凭空多出一个断点，分段就不是她要的样子了。
 *
 * 表格（权重越大越常见）：`，` 40 / `~` 25 / `...` 15 / `。` 12 / `！` 8 —— 合计 100。
 * 两个注意：
 *   • 只认**中文双破折号** `——`（以及全角 `—`×2 的变体），ASCII 的 `--` 一律不动
 *     ——它在命令行、代码块、`--flag` 里是词的一部分（与"只认中文标点"同一条纪律）；
 *   • 代码块（``` 围栏）里的破折号**不动**：那是她要保留的原文，改写等于篡改她的输出。
 */
export function softenDashes(text: string, random: () => number = Math.random): string {
  if (!text.includes('—')) return text;
  const table: ReadonlyArray<readonly [string, number]> = [
    ['，', 40], ['~', 25], ['...', 15], ['。', 12], ['！', 8],
  ];
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  const pick = (): string => {
    let roll = random() * total;
    for (const [mark, weight] of table) {
      roll -= weight;
      if (roll < 0) return mark;
    }
    return table[table.length - 1]![0];
  };
  // 按代码块切成"可改写段 / 原样段"，只在可改写段里动手
  const parts = text.split(/(```[\s\S]*?(?:```|$))/u);
  return parts
    .map((part) => (part.startsWith('```') ? part : part.replace(/—{2,}/gu, () => pick())))
    .join('');
}

/** 中文计字口径：一个字算一个（`text.length` 会把 emoji 数成两个） */
export function charCount(text: string): number {
  return [...text].length;
}

/**
 * 成对符号能不能配齐（**栈式**配对，嵌套也算配齐）。
 *
 * 贪心配对在括号串上是可靠的：左符号先假定被后面的某个右符号闭合，一旦发现配不上
 * （右符号来的时候栈空、或栈顶不是同族；收尾时栈非空）就返回 false。这就是"保守"的判据
 * ——配不齐时调用方整篇不拆，绝不切进括号里。
 */
export function pairsBalanced(text: string): boolean {
  const stack: string[] = [];
  for (const ch of text) {
    if (FAMILY_OPEN.has(ch)) {
      stack.push(ch);
      continue;
    }
    if (!FAMILY_CLOSE.has(ch)) continue;
    const top = stack.pop();
    if (top === undefined) return false; // 多余的闭口
    if (pairFamily(top) !== pairFamily(ch)) return false; // 张冠李戴（`（` 用 `]` 闭）
  }
  return stack.length === 0;
}

/** 一条切好的段，外加"这一刀之后丢掉了什么"（续写型标点要跟着上一段走） */
interface Piece {
  text: string;
  /** 切点处被摘掉的那个字符（'' = 没摘任何东西） */
  dropped: string;
}

/**
 * 按一级断点切一段文本，切点处的标点丢弃；**成对符号内部不切**（栈式深度）。
 *
 * 收整篇文本（不是一行）：它内部要先认出 ``` 围栏，再把围栏内部整段保护起来。
 * 换行与句末标点同级——她自己分的行就是最准的边界。
 */
function cutLine(text: string): Piece[] {
  const out: Piece[] = [];
  let buffer = '';
  let dropped = '';
  const stack: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  /** 收一段；`at` 是这一段的切点处摘掉的字符 */
  const flush = (at: string): void => {
    const piece = buffer.trim();
    if (piece !== '') out.push({ text: piece, dropped: at });
    buffer = '';
  };

  const parts = text.split(/(?<=\n)/u);
  for (const part of parts) {
    const fence = /^\s*(```|~~~)/u.exec(part);
    if (fence !== null) {
      if (!inFence) {
        flush(dropped);
        dropped = '';
        buffer = part;
        inFence = true;
        fenceMarker = fence[1]!;
      } else if (part.trimStart().startsWith(fenceMarker)) {
        buffer += part;
        flush('');
        dropped = '';
        inFence = false;
        fenceMarker = '';
      } else {
        buffer += part;
      }
      continue;
    }
    if (inFence) {
      buffer += part;
      continue;
    }

    for (const ch of part) {
      if (PAIR_OPEN.has(ch)) {
        stack.push(ch);
        buffer += ch;
        continue;
      }
      if (pairFamily(ch) !== -1) {
        if (stack.length > 0) stack.pop();
        buffer += ch;
        continue;
      }
      const atTop = stack.length === 0;
      // 换行与「一定摘」的句末标点同级：换行本身就是句子结束（句号是书面语，所以它消失、它不留）
      if (atTop && (ch === '\n' || ALWAYS_STRIP.has(ch))) {
        flush(dropped);
        dropped = ch;
        continue;
      }
      // 叹号：短句留着它（「好！」摘了就没了那股劲），长句摘掉并断开
      if (atTop && ch === '！') {
        const piece = buffer.trim();
        if (piece !== '' && charCount(piece) <= SHORT_EXCLAIM_CHARS) {
          buffer += ch;
          continue;
        }
        flush(dropped);
        dropped = ch;
        continue;
      }
      // 问号、分号、省略号、波浪号、顿号：不摘也不断——它们本身就是停顿的表情
      // （顿号是"同一口气里的并列"）。真正的"断开"留给兜底 splitLong。
      if (atTop && (SOFT_KEEP.has(ch) || ch === '、')) {
        buffer += ch;
        continue;
      }
      buffer += ch;
    }
  }
  flush(dropped);
  return out;
}

/**
 * 过长的一段：在标点、空格或"汉字↔非汉字交界"处切；**找不到断点就停手，剩下的整段留下**。
 *
 * 中文没空格，硬切一定从词中间劈开——实测就切出过「…拆成 29 | 条全发出去了」与
 * 「你能看 | 见的只是对话流」。一条长消息比一个被劈开的词好看得多，所以宁可放长也不硬切。
 *
 * 断点只有三类，且必须是"一个成分的边界"（判据见下）：
 *
 *   ① 空格（半角/全角）；
 *   ② 标点：切在它**之后**；丢不掉的（问号、冒号、破折号…）留给上一段，下一段从新句子起头；
 *   ③ **汉字 ↔ 非汉字交界**——只在①②都找不到时才用，且判据收紧到"两边都成词"：
 *      非汉字那一侧要连续 ≥ `SPLIT_MIN_WORD_CHARS` 个同侧字符（这样 `在的 | 。` 不算交界，
 *      而 `…你手上—— | 你能看见的` 算）。它修的是旧规则"见到交界就下刀"留下的
 *      `[image/jpeg: 哈希 | .jpg]`、`你能看 | 见的` 这类切法（2026-10-02 收窄）。
 *
 * **成对符号内部不切**（与 `cutLine` 同一个栈口径）：`[image/jpeg: 哈希.jpg]` 是一个整体，
 * 顶端被字数封顶截断时也不许把 `[` 与 `]` 分到两条消息里——实测 seq 3989/3991 就是这么劈的。
 */
function splitLong(piece: Piece, max: number): Piece[] {
  const text = piece.text;
  if (charCount(text) <= max) return [piece];
  const minPiece = Math.max(2, Math.floor(max / 3));
  const minWord = SPLIT_MIN_WORD_CHARS;
  const out: Piece[] = [];
  let rest = text;
  let carried = piece.dropped;
  while (charCount(rest) > max) {
    const window = [...rest].slice(0, max).join('');
    const beyond = [...rest].slice(max, max + 1).join('');
    const open: string[] = []; // 开着的成对符号（栈）：非空即"这一刀不许落在这儿"
    let cut = -1;
    let cutChar = '';
    let pending = -1; // ①② 都不成时，这里放"汉字↔非汉字交界"的兜底切点
    for (let i = 0; i < window.length; i += 1) {
      const ch = window[i]!;
      if (FAMILY_OPEN.has(ch)) {
        open.push(ch);
        continue;
      }
      if (FAMILY_CLOSE.has(ch)) {
        if (open.length > 0 && pairFamily(open[open.length - 1]!) === pairFamily(ch)) open.pop();
        continue;
      }
      if (open.length > 0) continue; // 成对符号内部：一个切点都不许有
      if (i < minPiece - 1) continue; // 太靠前就不切（不然会切出「好」这种孤零零一段）
      const next = window[i + 1] ?? beyond;
      if (NO_CUT_BEFORE.has(next)) continue; // 下一段不许以收尾标点起头
      if (ch === ' ' || ch === '　' || CUT_AFTER.has(ch)) {
        // 空格后面还是汉字 → 这不是**词与词**的边界，只是中英混排的习惯性空格
        // （实测 `slice、I11 的 data/events 禁区`）。在这种地方下刀会切出
        // 「slice、I11 | 的 data/events」这种把定语与中心语劈开的形态，所以跳过它，
        // 继续往前找真正的句读断点；找不到就整段留着（"宁可放长也不硬切"）。
        if ((ch === ' ' || ch === '　') && CJK.test(next)) continue;
        cut = i + 1;
        cutChar = ch;
        break;
      }
      // 兜底：只有两边都成词的交界才算断点（左 ≥ SPLIT_MIN_WORD_CHARS、右 ≥ SPLIT_MIN_WORD_CHARS）
      if (pending < 0 && next !== '' && CJK.test(ch) !== CJK.test(next)) {
        let left = 0;
        for (let k = i; k >= 0 && CJK.test(window[k]!) === CJK.test(ch); k -= 1) left += 1;
        let right = 0;
        for (let k = i + 1; k < window.length && CJK.test(window[k]!) === CJK.test(next); k += 1) right += 1;
        if (left >= minWord && right >= minWord) pending = i + 1;
      }
    }
    if (cut <= 0) cut = pending;
    if (cut <= 0) break; // 没有断点：不硬切，剩下的整段作为一条
    const headText = rest.slice(0, cut).trim();
    if (headText !== '') out.push({ text: headText, dropped: carried });
    carried = segTailChar(cutChar);
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') out.push({ text: rest, dropped: carried });
  return out;
}

/** 这一刀摘掉的字符：空格与句读是"丢掉派"，其余（问号、冒号…）跟着上一段走 */
function segTailChar(ch: string): string {
  return ch === ' ' || ch === '　' || ALWAYS_STRIP.has(ch) ? ch : '';
}

/**
 * 段末收尾：**只去掉决定要摘的那些**——句号与逗号类。
 *
 * 这里曾经是"段末标点一律去掉"，那与上面的口径直接冲突：问号、省略号、叹号之所以还在，
 * 正是因为判定为**不摘**（它们本身就是停顿的表情）；到段末又被清掉，等于把刚做的决定推翻。
 * 所以兜底只处理"本来就是摘掉派"的那几个，其余一概留着。
 *
 * **顿号同样留着**（它现在与问号同级）：`苹果、梨` 不再被削成 `苹果`。
 */
function trimTail(piece: string): string {
  return piece.replace(/[。，,\s]+$/u, '').trim();
}

/**
 * 把一段话切成聊天节奏的分段。空输入返回空数组（调用方据此跳过投递）。
 *
 * 不合并短条：三段话就是三条，一个字也是合法的一条（「唉」）——**但整段不到
 * `SPLIT_MIN_CHARS` 字时不拆**（见文件头的判定顺序第 1 条）。
 */
export function splitForChat(text: string, options: SplitOptions = {}): string[] {
  const max = options.max ?? SPLIT_MAX_CHARS;
  const trimmed = text.trim();
  if (trimmed === '') return [];

  // ① 太短不拆：整段作为一条（先于一切其它规则）
  if (charCount(trimmed) < SPLIT_MIN_CHARS) return [softenDashes(trimmed, options.random)];

  // ② 成对符号配不齐就保守：整段不拆（宁可一次说完，也不切进括号里）
  if (!pairsBalanced(trimmed)) return [softenDashes(trimmed, options.random)];

  // ③ 选切点。不在外面按行预切：cutLine 要把 ``` 围栏当成整体看，预先拆行会让它再也
  // 认不出 fence（换行本身已由 cutLine 当断点处理，无需另切一道）。
  const out: Piece[] = [];
  for (const piece of cutLine(trimmed)) {
    // 代码块整段保留：它内部的行长与标点都不该被拆
    if (/^\s*(```|~~~)/u.test(piece.text)) {
      out.push(piece);
      continue;
    }
    out.push(...splitLong(piece, max));
  }
  // ④ **先切、后化开**（用户 2026-10-02 更正）：`——` 在切分时**不算断点**（它是连接号，
  //    两边是同一口气），切完再把每条里的 `——` 加权随机换成 ，/~ /.../。/！
  //    ——顺序反了的话「换成逗号」会凭空多出一个断点，那不是她要的分段。
  return out
    .map((p) => softenDashes(trimTail(p.text), options.random))
    .filter((seg) => seg !== '');
}
