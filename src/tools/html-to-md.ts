/**
 * Irmia Agent — HTML → Markdown 正文抽取（零依赖，纯函数）
 *
 * 来路（实测选的型，不是拍脑袋）：`_tmp/webfetch-compare/REPORT.md` 拿同一份解码后的 HTML
 * 比过四个方案（自写 / readability 三件套 / trafilatura / 现 `htmlToText`），结论是
 * **自写胜出**：有正文的 5 个页命中率 100%、导航污染 1.4、平均行长 52.3、单页 1.7–18.7 ms、
 * 新增依赖 0。而现役 `htmlToText` 的缺陷不是"不够好"而是**错**：它把每个标签换成
 * **一个空格** ⇒ `<span>asyncio.</span><span>sleep</span>(delay, result=None)` 变成
 * `asyncio. sleep ( delay , result = None )`，中文变成 `本杂志 开源 ，欢迎 投稿 。`。
 * 行内 token（函数名、URL、中文句子）全被打断，而这是模型读正文时最需要的东西。
 *
 * 流水线：**剥内容永不可见的容器 → tokenize 建树 → 剪枝（junk 标签 + 负向 class/id）→
 * 打分选块 → 序列化成 Markdown**。
 *
 * 打分严格按实验里的公式：`分数 = 文字密度 × 标点密度 ÷ 链接密度`
 *   · 文字密度 = 该块文字字符数 / 该块序列化体积（后序遍历一遍累加，不做 O(n²) 重序列化）
 *   · 标点密度 = 标点字符数 / 文字字符数
 *   · 链接密度 = `<a>` 内文字字符数 / 文字字符数
 * 两处工程补丁（否则纯公式会选出"一个逗号很多的短段落"），理由写在 `chooseBlock` 上：
 *   ① 只考虑文字量 ≥ max(200, 30% × 最大候选块) 的块；② 链接密度 < 0.001 时按 0.001 计（防除零爆 Infinity）。
 *
 * **两个补丁是必须付的成本**（报告 §5.3 点名的两个缺口，不补会带着已知缺陷上线）：
 *   ① **链接农场**：选中的块 `linkDensity > 0.6` ⇒ 只留链接的**标题文字**、丢掉 URL
 *      （救 163 首页那种 10142 字 / 523 链接的页；门户首页的内容本来就是标题列表，
 *      但把 523 条 URL 一起搬进上下文是纯噪声）。
 *   ② **抽不到就回空**：返回 `''`，由**调用方**回落到 `net.ts` 的 `htmlToText`——
 *      那条 20 行的老路径与它的用例因此原样保住（它是兜底，不再是主路径）。
 *
 * 纪律：
 *   · **纯函数**：输入已解码的 HTML 字符串（+ 可选的页面地址，只用于把相对链接补成全链接），
 *     输出 Markdown 字符串；不抓网、不读盘、不读时钟、无随机。
 *   · **绝不把行内标签拆成空格**：行内子节点直接相接，`span`/`em`/`b` 不打分隔符。
 *   · 结构保留：标题（`#`…`######`）、列表（`-` / `1.`）、表格（GFM 管道表）、
 *     代码块（``` 围栏）、链接（`[文字](绝对 URL)`）、强调（`**` / `*` / `~~`）。
 *   · 为什么不是 200 行：多出来的不是抽取逻辑，是 **Markdown 序列化**（表格 / 代码块 /
 *     列表 / 嵌套强调 / 实体表）。报告 §4.3 已经把这个账算清："200 行做纯文本成立，
 *     200 行做 Markdown 不成立"。
 *
 * 调用点只有一处：`src/tools/net.ts` 的 `http_get`（见那里的注释）。
 */

/**
 * 空元素：没有闭合标签，建树时**不许**把它们当容器压栈（否则整页会挂到 `<br>` 底下）。
 */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** 整块丢弃：既不产出文字，也不该参与密度统计 */
const JUNK = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'template', 'canvas', 'object', 'embed', 'map',
  'select', 'option', 'button', 'input', 'textarea', 'video', 'audio', 'dialog',
]);

/** 结构性样板：整块去掉（正文永远不在 nav / aside / footer 里） */
const BOILER_TAG = new Set(['nav', 'aside', 'footer']);

/** 块级元素：只有这些参与"选正文块"的评比 */
const BLOCK = new Set(['div', 'article', 'section', 'main', 'td', 'th', 'body', '#root', 'blockquote', 'figure', 'li']);

/** 同标签隐式闭合（`<li>a<li>b` 这种没有 `</li>` 的老页面） */
const AUTO_CLOSE: Record<string, readonly string[]> = {
  p: ['p'], li: ['li'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], tr: ['tr', 'td', 'th'],
  td: ['td', 'th'], th: ['td', 'th'], thead: ['tbody', 'thead', 'tfoot'], tbody: ['tbody', 'thead', 'tfoot'],
  option: ['option'], a: ['a'],
};

/**
 * 负向 class/id 词表：站点自己声明"这块是样板"。
 *
 * ⚠ 按**单个 class 词**判，**不做子串匹配**——这是实验里最贵的一条教训：
 * Tailwind 的 `has-sidebar`、`lg:top-[var(--vp-banner-height,0)]` 会被子串匹配骗到，
 * vitejs.dev/guide 实测 **9279 / 9356 字被误杀**，整页只剩 58 字。
 */
const NEG_WORDS = new Set([
  'nav', 'navbar', 'navigation', 'menu', 'sidebar', 'sider', 'footer', 'header',
  'masthead', 'breadcrumb', 'crumb', 'cookie', 'banner', 'ad', 'ads', 'advert', 'advertisement', 'sponsor',
  'share', 'social', 'comment', 'comments', 'related', 'recommend', 'popup', 'modal', 'subscribe',
  'newsletter', 'pagination', 'pager', 'toolbar', 'login', 'signin', 'register', 'search', 'lang',
  'copyright', 'skip',
]);

/** 负向词必须出现在**词首**：`nav-bar` / `footer__links` 命中，`has-sidebar` / `vp-banner-height` 不命中 */
const NEG_PREFIX = /^(nav|navbar|navigation|sidebar|sider|footer|header|masthead|breadcrumb|crumb|cookie|banner|advert|advertisement|sponsor|share|social|comment|comments|related|recommend|popup|modal|subscribe|newsletter|pagination|pager|toolbar|login|signin|register|search|copyright|skip)([-_]|$)/i;

/** 中文站点的样板声明（`<div class="导航栏">` 这种） */
const NEG_CJK = /(导航|菜单|侧栏|页脚|页头|广告|推荐|相关|评论|分享|登录|注册|搜索|版权|面包屑)/;

/** 链接农场判据：选中的块里 `<a>` 内文字占全部文字的比例超过它，就只留标题文字 */
const LINK_FARM_DENSITY = 0.6;

const PUNCT = /[，。！？；：、…—·《》（）()「」『』“”‘’"'!?;,.:]/gu;
const WS = /[ \t\f\v\u00a0\u3000]+/g;

// ─────────────────────────── 实体解码 ───────────────────────────

/**
 * 命名实体表。**只收正文里真会出现的那些**——收全 2000 多个 HTML 实体是几万字节的常数，
 * 而模型读的正文里出现一个没解的长实体名（`&hellip;`）也不影响理解。
 * 不认识的**保持原样**（与 `net.ts` 的 `decodeEntities` 同一条口径）。
 */
const ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', deg: '°', times: '×',
  divide: '÷', plusmn: '±', frac12: '½', sup2: '²', sup3: '³', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', dagger: '†', permil: '‰', prime: '′', Prime: '″', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return ENT[body] ?? ENT[body.toLowerCase()] ?? match;
  });
}

const clip = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ─────────────────────────── 建树 ───────────────────────────

interface Metrics {
  /** 该子树里的文字字符数（含链接文字） */
  textLen: number;
  /** 该子树里落在 `<a>` 内的文字字符数 */
  linkLen: number;
  /** 该子树里的标点字符数 */
  punct: number;
  /** 该子树的序列化体积估算（自身标签 + 属性开销 + 孩子） */
  htmlLen: number;
}

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlNode | null;
  /** 仅 `#text` 节点有意义：已解实体的原文 */
  text: string;
  m: Metrics;
}

function makeNode(tag: string, attrs: Record<string, string>, parent: HtmlNode | null, text = ''): HtmlNode {
  return { tag, attrs, children: [], parent, text, m: { textLen: 0, linkLen: 0, punct: 0, htmlLen: 0 } };
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    if (name === '') continue;
    attrs[name] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return attrs;
}

/**
 * 只在原始串上摘掉"内容永不可见"的容器。
 *
 * 为什么这一步必须在 tokenize **之前**：`<script>` 里常出现 `a < b` 这类文本，
 * 拿它当 HTML 继续 tokenize 会把后面整棵树建歪（实验里混进过 `<!DOCTYPE html>` 与
 * 半截脚本，就是因为只剥了注释）。顺带把 `<!DOCTYPE>` / `<?xml?>` / CDATA 一起剥掉。
 */
function stripInvisible(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
    .replace(/<\?xml[\s\S]*?\?>/gi, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
}

const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9:_.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** 是否在 `<pre>` 里（代码块的空白是内容，不能压） */
function inPre(node: HtmlNode | null): boolean {
  for (let cursor = node; cursor !== null; cursor = cursor.parent) {
    if (cursor.tag === 'pre') return true;
  }
  return false;
}

function buildTree(html: string): HtmlNode {
  const root = makeNode('#root', {}, null);
  let cur = root;
  let pos = 0;
  const pushText = (raw: string): void => {
    const text = decodeEntities(raw);
    if (text.trim() === '') {
      /*
       * 纯空白文本节点：**不能一律丢**。
       *
       * 丢掉它会把行内元素之间的词粘在一起——实测 docs.python.org 的代码块
       * `<span>await</span> <span>asyncio.sleep</span>(1)` 变成 `awaitasyncio.sleep(1)`，
       * 正文里 `Source code:` 与 `Lib/asyncio/...` 也粘成 `Source code:Lib/...`。
       * 这与"每个标签换一个空格"是**同一枚硬币的两面**：一个凭空造空格，一个凭空删空格，
       * 两种都会毁掉 token。
       *
       * 所以：`<pre>` 里原样保留（缩进与换行是代码的内容），别处收成**一个空格**——
       * 只保留源码里真实存在的那个分界。中文页面的行内标签之间源码里本来就没有空白
       * （`<span>本杂志</span><a>开源</a>`），因此**不会**凭空多出空格。
       */
      if (inPre(cur)) {
        cur.children.push(makeNode('#text', {}, cur, text));
      } else if (/[ \t\f\v\u00a0\u3000]/.test(text)) {
        cur.children.push(makeNode('#text', {}, cur, ' '));
      }
      return;
    }
    cur.children.push(makeNode('#text', {}, cur, text));
  };
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > pos) pushText(html.slice(pos, m.index));
    pos = TAG_RE.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const name = (m[2] ?? '').toLowerCase();
    if (name === '') continue;
    if (m[1] === '/') {
      let node: HtmlNode | null = cur;
      while (node !== null && node !== root && node.tag !== name) node = node.parent;
      if (node !== null && node !== root) cur = node.parent ?? root;
      continue;
    }
    const implied = AUTO_CLOSE[name];
    if (implied !== undefined) {
      while (cur !== root && implied.includes(cur.tag)) cur = cur.parent ?? root;
    }
    const node = makeNode(name, parseAttributes(m[3] ?? ''), cur);
    cur.children.push(node);
    if (!VOID.has(name)) cur = node;
  }
  if (pos < html.length) pushText(html.slice(pos));
  return root;
}

// ─────────────────────────── 剪枝 ───────────────────────────

function hintNegative(hint: string): boolean {
  if (hint.trim() === '') return false;
  if (NEG_CJK.test(hint)) return true;
  for (const token of hint.split(/\s+/)) {
    if (token === '') continue;
    // Tailwind 任意值 / CSS 变量 / 变体前缀：里头的词不是语义类名
    if (token.includes('[') || token.includes(']') || token.includes('var(') || token.includes(':')) continue;
    if (NEG_WORDS.has(token.toLowerCase())) return true;
    if (NEG_PREFIX.test(token)) return true;
  }
  return false;
}

function negative(node: HtmlNode): string | null {
  const a = node.attrs;
  if (a['aria-hidden'] === 'true' || a['hidden'] !== undefined) return 'hidden';
  const role = (a['role'] ?? '').toLowerCase();
  if (['navigation', 'banner', 'complementary', 'contentinfo', 'menu', 'search', 'dialog'].includes(role)) {
    return `role=${role}`;
  }
  // id 单独判一次：id 通常就是整块语义名（如 id="sidebar"），子串匹配的误杀风险比 class 小得多
  if (a['id'] !== undefined && hintNegative(a['id'])) return 'neg-id';
  if (a['class'] !== undefined && hintNegative(a['class'])) return 'neg-class';
  return null;
}

/**
 * 剪枝返回"替换后的节点数组"：`[]` = 整块丢，`[node]` = 保留，`node.children` = 解包保留的孩子。
 *
 * `header` 特殊对待：`body` 直属的 header 是站点头（丢），`article` 里的 header 常是标题（解包保留）。
 */
function prune(node: HtmlNode): HtmlNode[] {
  if (node.tag === '#text') return [node];
  if (JUNK.has(node.tag)) return [];
  if (BOILER_TAG.has(node.tag)) return [];
  if (node.tag === 'header') {
    const isSiteHead = node.parent !== null && node.parent.tag === 'body';
    return isSiteHead || negative(node) !== null ? [] : node.children;
  }
  if (negative(node) !== null) return [];
  const out: HtmlNode[] = [];
  for (const child of node.children) out.push(...prune(child));
  node.children = out;
  for (const child of out) child.parent = node;
  return [node];
}

// ─────────────────────────── 统计与打分 ───────────────────────────

function rawText(node: HtmlNode): string {
  if (node.tag === '#text') return node.text;
  return node.children.map(rawText).join('');
}

function measure(node: HtmlNode): Metrics {
  if (node.tag === '#text') {
    const text = node.text;
    const punct = (text.match(PUNCT) ?? []).length;
    node.m = { textLen: text.length, linkLen: 0, punct, htmlLen: text.length };
    return node.m;
  }
  const overhead =
    node.tag.length * 2 + 5
    + Object.entries(node.attrs).reduce((n, [k, v]) => n + k.length + v.length + 4, 0);
  const m: Metrics = { textLen: 0, linkLen: 0, punct: 0, htmlLen: overhead };
  for (const child of node.children) {
    const cm = measure(child);
    m.textLen += cm.textLen;
    m.punct += cm.punct;
    m.htmlLen += cm.htmlLen;
    m.linkLen += node.tag === 'a' ? cm.textLen : cm.linkLen;
  }
  if (node.tag === 'a') m.linkLen = m.textLen;
  node.m = m;
  return m;
}

interface Score {
  score: number;
  textDensity: number;
  punctDensity: number;
  linkDensity: number;
}

function scoreOf(node: HtmlNode): Score {
  const { textLen, linkLen, punct, htmlLen } = node.m;
  if (textLen === 0) return { score: 0, textDensity: 0, punctDensity: 0, linkDensity: 0 };
  const textDensity = textLen / Math.max(1, htmlLen);
  const punctDensity = punct / textLen;
  const linkDensity = Math.max(linkLen / textLen, 0.001);
  return { score: (textDensity * punctDensity) / linkDensity, textDensity, punctDensity, linkDensity };
}

/** 真实链接密度（不夹 0.001 的地板）：链接农场判据用它，夹过地板就判不出 0.96 与 0.6 的差别 */
function rawLinkDensity(node: HtmlNode): number {
  return node.m.textLen === 0 ? 0 : node.m.linkLen / node.m.textLen;
}

function chooseBlock(root: HtmlNode): { best: HtmlNode; scored: HtmlNode[] } {
  const blocks: HtmlNode[] = [];
  const walk = (node: HtmlNode): void => {
    if (node.tag === '#text') return;
    if (BLOCK.has(node.tag)) blocks.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  if (blocks.length === 0) return { best: root, scored: [] };
  // body / #root 不参与评比：它永远"文字最多"，一旦让它进候选，地板的相对阈值就被它自己撑爆，
  // 结果永远是整页原样返回（实验实测：选中 #root ⇒ 40k 字、链接密度 0.96）。只有别无选择时才退回它们。
  const inner = blocks.filter((b) => b.tag !== '#root' && b.tag !== 'body');
  const pool = inner.length > 0 ? inner : blocks;
  const maxText = Math.max(...pool.map((b) => b.m.textLen));
  // 地板 = max(200, 30% × 最大候选块)：抑制"深而小"的段落靠逗号密度夺冠
  const floor = Math.max(200, maxText * 0.3);
  const eligible = pool.filter((b) => b.m.textLen >= floor);
  const finalPool = eligible.length > 0 ? eligible : pool;
  const scored = [...finalPool].sort((a, b) => scoreOf(b).score - scoreOf(a).score);
  return { best: scored[0] ?? root, scored };
}

// ─────────────────────────── Markdown 序列化 ───────────────────────────

interface Ctx {
  /** 补全相对链接用的页面地址（调用方给的最终 URL；空串 ⇒ 只保留原样 href） */
  base: string;
  /** 链接农场模式：`<a>` 只留标题文字，不产 `[文字](URL)`；`<img>` 直接丢 */
  linkTextOnly: boolean;
  /** 在 `<pre>` 里：文本原样输出，不做转义、不压空白 */
  pre: number;
}

function resolveUrl(href: string | undefined, base: string): string | null {
  if (href === undefined || href.trim() === '') return null;
  const trimmed = href.trim();
  if (trimmed.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(trimmed)) return null;
  if (base === '') return /^https?:\/\//i.test(trimmed) ? trimmed : null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** 行内文本的 Markdown 转义：只转那些真会改结构的字符 */
const escText = (s: string): string => s.replace(/([\\`*_[\]])/g, '\\$1');

const inlineChildren = (node: HtmlNode, ctx: Ctx): string =>
  node.children.map((child) => serialize(child, ctx)).join('');

function trimBlock(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

function serializeTable(node: HtmlNode, ctx: Ctx): string {
  const rows: HtmlNode[] = [];
  const harvest = (n: HtmlNode): void => {
    for (const child of n.children) {
      if (child.tag === 'tr') rows.push(child);
      else if (child.tag === 'thead' || child.tag === 'tbody' || child.tag === 'tfoot') harvest(child);
    }
  };
  harvest(node);
  const cells = rows.map((tr) =>
    tr.children.filter((c) => c.tag === 'td' || c.tag === 'th').map((c) => clip(inlineChildren(c, ctx))),
  );
  const kept = cells.filter((row) => row.some((c) => c !== ''));
  if (kept.length === 0) return '';
  const width = Math.max(...kept.map((r) => r.length));
  const pad = (r: string[]): string => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  // 只有一行时不给分隔行（单行表格在 GFM 里不成立，给分隔行反而多两行噪声）
  const head = kept.length > 1 ? `${pad(kept[0] ?? [])}\n|${' --- |'.repeat(width)}\n` : '';
  const body = kept.length > 1 ? kept.slice(1) : kept;
  return `\n\n${head}${body.map(pad).join('\n')}\n\n`;
}

function serialize(node: HtmlNode, ctx: Ctx): string {
  if (node.tag === '#text') {
    if (ctx.pre > 0) return node.text;
    return escText(node.text.replace(WS, ' '));
  }
  const t = node.tag;
  if (t === 'br') return ctx.pre > 0 ? '\n' : '  \n';
  if (t === 'hr') return '\n\n---\n\n';
  if (t === 'img') {
    if (ctx.linkTextOnly) return '';
    const src = resolveUrl(node.attrs['src'] ?? node.attrs['data-src'], ctx.base);
    if (src === null) return '';
    return `![${clip(node.attrs['alt'] ?? '')}](${src})`;
  }
  if (t === 'pre') {
    const lang = (node.attrs['class'] ?? '').match(/language-([\w+#-]+)/)?.[1] ?? '';
    return `\n\n\`\`\`${lang}\n${trimBlock(rawText(node))}\n\`\`\`\n\n`;
  }
  if (t === 'code') {
    const text = rawText(node);
    return text.includes('\n') ? `\n\n\`\`\`\n${trimBlock(text)}\n\`\`\`\n\n` : `\`${clip(text)}\``;
  }
  if (t === 'a') {
    const body = clip(inlineChildren(node, ctx));
    if (body === '') return '';
    if (ctx.linkTextOnly) return body;
    const href = resolveUrl(node.attrs['href'], ctx.base);
    return href === null ? body : `[${body}](${href})`;
  }
  if (/^h[1-6]$/.test(t)) {
    const level = Number(t[1]);
    const body = clip(inlineChildren(node, ctx));
    return body === '' ? '' : `\n\n${'#'.repeat(level)} ${body}\n\n`;
  }
  if (t === 'strong' || t === 'b') {
    const body = clip(inlineChildren(node, ctx));
    return body === '' ? '' : `**${body}**`;
  }
  if (t === 'em' || t === 'i') {
    const body = clip(inlineChildren(node, ctx));
    return body === '' ? '' : `*${body}*`;
  }
  if (t === 'del' || t === 's') {
    const body = clip(inlineChildren(node, ctx));
    return body === '' ? '' : `~~${body}~~`;
  }
  if (t === 'ul' || t === 'ol') {
    const items = node.children.filter((c) => c.tag === 'li');
    if (items.length === 0) return '';
    const lines = items
      .map((li, i) => {
        const body = clip(inlineChildren(li, ctx));
        if (body === '') return null;
        return `${t === 'ol' ? `${i + 1}.` : '-'} ${body}`;
      })
      .filter((x): x is string => x !== null);
    return lines.length === 0 ? '' : `\n\n${lines.join('\n')}\n\n`;
  }
  if (t === 'blockquote') {
    const body = trimBlock(inlineChildren(node, ctx));
    return body === '' ? '' : `\n\n${body.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
  }
  if (t === 'table') return serializeTable(node, ctx);
  const inner = inlineChildren(node, ctx);
  if (
    t === 'p' || t === 'div' || t === 'section' || t === 'article' || t === 'main'
    || t === 'li' || t === 'dt' || t === 'dd' || t === 'figcaption' || t === 'header' || t === 'footer'
    || t === 'tr' || t === 'td' || t === 'th' || t === 'hgroup' || t === 'address'
  ) {
    return inner.trim() === '' ? '' : `\n\n${inner}\n\n`;
  }
  return inner;
}

/**
 * 文档顺序里的**第一个 `<h1>`** 的文字（没有就是 `''`）。
 *
 * 为什么需要它：博客/新闻页最常见的形状是 `<article><h1>标题</h1><div class="content">正文…`，
 * 而打分选中的往往是那个 `div`（文字密度更高）⇒ **整页的标题落在选块之外，被丢掉了**。
 * 实验里这一条就值一个必含短语：阮一峰那篇的 `科技爱好者周刊（第 415 期）` 在 `<h1 id="page-title">`
 * 里、而选中的块是 `div#main-content`，原版 A 靠"把 `<title>` 当 H1 前置"碰巧补上（于是有了
 * `<title>` 与正文 H1 各一遍的重复）。
 *
 * 这里换一条更干净的做法：**只补选块之外的那一行 H1**，且补完再判一次"正文里已经有了吗"。
 * `<title>` 不进正文——它是回执的 `[标题]` 那一行，正文里再来一遍就是同一句话说两遍。
 */
function firstH1Text(root: HtmlNode): string {
  let found = '';
  const walk = (node: HtmlNode): boolean => {
    if (node.tag === '#text') return false;
    if (node.tag === 'h1') {
      const text = clip(rawText(node));
      if (text !== '') {
        found = text;
        return true;
      }
    }
    for (const child of node.children) if (walk(child)) return true;
    return false;
  };
  walk(root);
  return found;
}

/** 收拾整篇：统一换行、去行尾空白、连续空行压成一个、首尾不留空 */
function tidy(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

// ─────────────────────────── 入口 ───────────────────────────

/** 抽取的可调旋钮（产品路径一个都不传，全用默认值） */
export interface HtmlToMarkdownOptions {
  /** 链接农场判据：`<a>` 内文字占全部文字的比例超过它 ⇒ 只留标题文字。默认 {@link LINK_FARM_DENSITY} */
  linkFarmDensity?: number;
}

/**
 * HTML → Markdown。**抽不到正文时返回 `''`**（调用方据此回落到 `htmlToText`）。
 *
 * @param html 已解码的 HTML（本函数不认识编码，也不该认识——那是 `net.ts` 的事）
 * @param pageUrl 最终落地的页面地址，只用于把相对链接补成全链接（空串 ⇒ 只留绝对链接）
 * @param options `linkFarmDensity`：链接农场判据，默认 {@link LINK_FARM_DENSITY}。
 *   传 `Infinity` 等于关掉这个补丁——**只有对照实验与用例会这么做**，产品路径不传。
 */
export function htmlToMarkdown(html: string, pageUrl = '', options: HtmlToMarkdownOptions = {}): string {
  if (html === '') return '';
  const stripped = stripInvisible(html);
  const root = buildTree(stripped);
  prune(root);
  measure(root);
  if (root.m.textLen === 0) return '';

  const { best } = chooseBlock(root);
  if (best.m.textLen === 0) return '';
  // 补丁 ①：链接农场。门户首页的内容本来就是标题列表，但把几百条 URL 一起搬进上下文是纯噪声
  // （实验实测 163 首页 10142 字 / 523 链接 ⇒ 导航污染 5、输出体积是 trafilatura 的 6 倍）。
  const threshold = options.linkFarmDensity ?? LINK_FARM_DENSITY;
  const linkFarm = rawLinkDensity(best) > threshold;
  const ctx: Ctx = { base: pageUrl, linkTextOnly: linkFarm, pre: 0 };
  const body = tidy(serialize(best, ctx));
  if (body === '') return '';
  // 选块之外的那一行 H1 是这一页的标题，别让它掉（见 firstH1Text 的注释）
  const heading = firstH1Text(root);
  if (heading !== '' && !body.includes(heading)) return `# ${heading}\n\n${body}`;
  return body;
}

/**
 * 页面 `<title>`（回执的 `[标题]` 那一行用它）。
 *
 * 为什么标题**不写进 Markdown 正文**：`[标题]` 已经是回执里的一行，正文里再来一个 `# 标题`
 * 就是同一句话说两遍（实验里 A 的那个小毛病：`<title>` 当 H1 又加了一遍）。正文只放页面自己
 * 的 H1/H2……
 */
export function htmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match?.[1] === undefined) return '';
  return clip(decodeEntities(match[1].replace(/<[^>]*>/g, ' ')));
}

/**
 * 这个 HTML 是不是一个"空壳"（只挂着前端挂载点，正文要 JS 渲染）。
 *
 * 判据刻意保守：**只有 `<div id="root"></div>` 这种空挂载点**、或 SSR 框架的数据岛才算。
 * 为什么要它：`http_get` 抓 SPA 时拿到的是几乎空的正文，而"（正文为空）"这四个字
 * 对她是无信息的——她需要知道"这不是我的工具坏了，是这页要 JS"，以及下一步该用哪件工具。
 */
export function looksLikeSpaShell(html: string): boolean {
  if (html === '') return false;
  const head = html.slice(0, 200_000);
  if (/<(?:div|main|section)[^>]+\bid\s*=\s*["'](?:root|app|__next|__nuxt|app-root|mount|vue-app)["'][^>]*>\s*<\/(?:div|main|section)>/i.test(head)) {
    return true;
  }
  return /__NEXT_DATA__|window\.__NUXT__|data-reactroot|ng-version=|__VUE__/i.test(head);
}
