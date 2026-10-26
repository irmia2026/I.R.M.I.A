/**
 * `src/tools/html-to-md.ts` 的用例 — 零依赖正文抽取器（HTML → Markdown）
 *
 * 这里钉的是**产品行为**，不是实现细节。四条必须守住的：
 *   ① **行内标签绝不被拆成空格**（旧 `htmlToText` 的致命缺陷：`asyncio.sleep` 变
 *      `asyncio. sleep ( delay , result = None )`、中文变 `本杂志 开源 ，欢迎 投稿 。`）；
 *   ② 结构保留：标题 / 列表 / 表格 / 代码块 / 链接；
 *   ③ **链接农场补丁**：`linkDensity > 0.6` 的块只留标题文字（救门户首页那种 523 条链接）；
 *   ④ **抽不到就回空**，由调用方回落 `htmlToText`（回落那条在 `net-vision.test.ts` 里钉，
 *      因为它是 `http_get` 的接线行为）。
 *
 * 判据来源：`_tmp/webfetch-compare/REPORT.md`（四方案实测，A 命中率 100% / 污染 1.4 /
 * 平均行长 52.3）。报告 §5.3 点名的两个补丁就是 ③ 与 ④——不补会带着已知缺陷上线。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { htmlTitle, htmlToMarkdown, looksLikeSpaShell } from '../src/tools/html-to-md.ts';

// ──────────────────────────── ① 行内标签不许被拆成空格 ────────────────────────────

test('行内标签不被拆成空格：asyncio.sleep(delay, result=None) 原样保留', () => {
  // docs.python.org 的真实形状：python 把函数名切成多个 <span>
  const html = '<html><body><p><span>asyncio.</span><span>sleep</span>(delay, result=None) 是协程的睡眠入口。</p></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /asyncio\.sleep\(delay, result=None\)/u);
  assert.doesNotMatch(md, /asyncio\.\s+sleep/u, '标签边界不许凭空造空格');
  assert.doesNotMatch(md, /sleep\s+\(/u);
  assert.doesNotMatch(md, /,\s+result\s+=/u);
});

test('中文行内标签之间不插空格（旧实现会变「本杂志 开源 ，欢迎 投稿 。」）', () => {
  const html = '<html><body><p>本杂志<a href="https://github.com/ruanyf/weekly">开源</a>，欢迎<a href="https://x">投稿</a>。</p></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /本杂志\[开源\]\(https:\/\/github\.com\/ruanyf\/weekly\)，欢迎\[投稿\]\(https:\/\/x\)。/u);
  assert.doesNotMatch(md, /本杂志 开源/u);
  assert.doesNotMatch(md, /，欢迎 投稿/u);
});

test('源码里真实存在的空格要留住（不能反向粘成 awaitasyncio.sleep）', () => {
  // docs.python.org 的代码块：<span>await</span> <span>asyncio.sleep</span>(1)
  const html = '<html><body><pre><span>await</span> <span>asyncio.sleep</span>(1)\n'
    + '    print(name)</pre></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /await asyncio\.sleep\(1\)/u);
  assert.doesNotMatch(md, /awaitasyncio/u);
  assert.match(md, /\n {4}print\(name\)/u, '代码块的缩进是内容');
});

// ──────────────────────────── ② 结构保留 ────────────────────────────

test('Markdown 结构：标题 / 列表 / 表格 / 代码块 / 链接 全保留', () => {
  const html = [
    '<html><head><title>页面标题 - 站点</title></head><body>',
    '<article>',
    '<h1>正文标题</h1>',
    '<h2>第一节</h2>',
    '<p>段落里有 <strong>粗体</strong> 与 <em>斜体</em>。</p>',
    '<ul><li>列表一</li><li>列表二</li></ul>',
    '<ol><li>第一步</li><li>第二步</li></ol>',
    '<table><thead><tr><th>类型</th><th>大小</th></tr></thead>',
    '<tbody><tr><td>安装包</td><td>39 MB</td></tr></tbody></table>',
    '<pre class="language-ts"><code>const a = 1;\nconsole.log(a);</code></pre>',
    '<p><a href="/rel/path">相对链接</a></p>',
    '</article></body></html>',
  ].join('');
  const md = htmlToMarkdown(html, 'https://example.com/dir/page.html');

  assert.match(md, /^# 正文标题$/mu, 'H1 → `# `');
  assert.match(md, /^## 第一节$/mu, 'H2 → `## `');
  assert.match(md, /\*\*粗体\*\*/u);
  assert.match(md, /^- 列表一$/mu);
  assert.match(md, /^1\. 第一步$/mu);
  assert.match(md, /^\| 类型 \| 大小 \|$/mu, '表格是 GFM 管道表（不是裸 HTML）');
  assert.match(md, /^\| 安装包 \| 39 MB \|$/mu);
  assert.match(md, /```ts\nconst a = 1;\nconsole\.log\(a\);\n```/u, '代码块带语言');
  assert.match(md, /\[相对链接\]\(https:\/\/example\.com\/rel\/path\)/u, '相对链接补成全链接');
  assert.doesNotMatch(md, /<[a-z][^>]*>/iu, '输出里不许残留 HTML 标签');
});

test('选块之外的 H1 会被补回来（博客常见的 <h1> + div.content 形状）', () => {
  // 阮一峰那种页：标题在 <h1 id="page-title">，正文在另一个 div 里，打分只会选中正文块
  const html = '<html><body><article>'
    + '<h1 id="page-title">科技爱好者周刊（第 415 期）</h1>'
    + '<div id="main-content"><p>' + '正文内容，一二三四五六七八九十。'.repeat(30) + '</p></div>'
    + '</article></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /^# 科技爱好者周刊（第 415 期）$/mu, '整页标题不许因为"不在选中的块里"而丢掉');
});

test('script/style/注释/DOCTYPE 一个字节都不进正文；实体解码', () => {
  const html = '<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body>'
    + '<!-- 注释不该出现 -->'
    + '<script>var leak = "<div>骗你的</div>";</script>'
    + '<p>世界 &amp; 你好&nbsp;&lt;ok&gt; &hellip;</p></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /世界 & 你好 <ok> …/u);
  assert.doesNotMatch(md, /color:red|var leak|骗你的|注释|DOCTYPE|<!--/u);
});

test('正文取自内容块，导航/页脚/侧栏被剪掉', () => {
  const html = '<html><body>'
    + '<nav><a href="/">首页</a><a href="/about">关于我们</a><a href="/login">登录</a></nav>'
    + '<div class="sidebar"><p>侧栏推荐</p></div>'
    + '<div id="content"><p>' + '这是真正的正文段落，读起来像人话。'.repeat(20) + '</p></div>'
    + '<footer>版权所有 © 2026</footer>'
    + '</body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /这是真正的正文段落/u);
  assert.doesNotMatch(md, /关于我们|登录|侧栏推荐|版权所有/u);
});

// ──────────────────────────── ③ 链接农场补丁 ────────────────────────────

/** 造一个"链接农场"：只有一个 div，里面全是同长度的链接标题（门户首页的形状） */
function linkFarmHtml(count: number): string {
  const items = Array.from({ length: count }, (_, i) => `<li><a href="https://news.example.com/a/${i}">新闻标题第${i}条</a></li>`).join('');
  return `<html><body><div id="content"><ul>${items}</ul></div></body></html>`;
}

test('链接农场补丁：linkDensity > 0.6 的块只留标题文字，URL 一个都不进上下文', () => {
  const html = linkFarmHtml(60);
  const md = htmlToMarkdown(html);
  assert.match(md, /新闻标题第0条/u, '标题文字要留住');
  assert.match(md, /新闻标题第59条/u);
  assert.equal((md.match(/\]\(https?:\/\//g) ?? []).length, 0, '链接农场里不许留 60 条 URL');
  // 同一条 HTML 关掉补丁 ⇒ URL 全在（作为对照，证明上面那个 0 是补丁干的，不是"本来就没有"）
  const noPatch = htmlToMarkdown(html, '', { linkFarmDensity: Infinity });
  assert.equal((noPatch.match(/\]\(https?:\/\//g) ?? []).length, 60, '对照：关掉补丁时 60 条链接都在');
  assert.ok(noPatch.length > md.length * 2, `对照：关掉补丁输出更大（${noPatch.length} vs ${md.length} 字节）`);
});

test('链接密度正常的正文块**不**触发链接农场（补丁不能误伤文章页）', () => {
  const html = '<html><body><div id="content">'
    + `<p>${'这是一段正常正文，句子很长，链接只占很小一部分。'.repeat(12)}</p>`
    + '<p><a href="https://example.com/x">一个链接</a></p>'
    + '</div></body></html>';
  const md = htmlToMarkdown(html);
  assert.match(md, /\[一个链接\]\(https:\/\/example\.com\/x\)/u);
});

// ──────────────────────────── ④ 抽不到就回空 ────────────────────────────

test('抽不到正文时返回空串（调用方据此回落 htmlToText）', () => {
  assert.equal(htmlToMarkdown(''), '');
  assert.equal(htmlToMarkdown('<html><head><title>只有标题</title></head><body></body></html>'), '');
  assert.equal(htmlToMarkdown('<html><body><script>var a = 1;</script><!-- 空 --></body></html>'), '');
  // 整页唯一的文字落在一个被判定为样板的块里 ⇒ 本抽取器给空，老路径才有东西
  const boilerplateOnly = '<html><body><div class="comment">评论区里的文字</div></body></html>';
  assert.equal(htmlToMarkdown(boilerplateOnly), '');
});

test('htmlTitle 取 <title> 并解实体；没有就是空串', () => {
  assert.equal(htmlTitle('<html><head><title>示例 &amp; 标题</title></head></html>'), '示例 & 标题');
  assert.equal(htmlTitle('<html><body>没有标题</body></html>'), '');
});

test('looksLikeSpaShell 只认"空挂载点/数据岛"，正常页面不误判', () => {
  assert.equal(looksLikeSpaShell('<html><body><div id="root"></div><script src="/a.js"></script></body></html>'), true);
  assert.equal(looksLikeSpaShell('<html><body><div id="app"></div></body></html>'), true);
  assert.equal(
    looksLikeSpaShell('<html><body><script id="__NEXT_DATA__" type="application/json">{}</script></body></html>'),
    true,
  );
  assert.equal(looksLikeSpaShell('<html><body><div id="root"><h1>有内容</h1><p>正文</p></div></body></html>'), false);
  assert.equal(looksLikeSpaShell(''), false);
});
