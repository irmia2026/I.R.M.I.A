/**
 * `web_search` 用例 — src/tools/web-search.ts
 *
 * 用户 2026-10-12 裁决第 2 条：「**web_search 要做就做好做强大**。」
 *
 * 这一组钉四件事（每一条都对应实现里的一条纪律，见那个文件的文件头）：
 *   ① **只读出网**（`sideEffect: 'none'` / `parallel`）——搜索不该被 destructive 那道门关掉；
 *   ② **产出是给她读的 Markdown**（标题+链接+摘要，条数与耗时在头一行）；
 *   ③ **两条失败线分开**：没搜到（查询问题）与取正文失败（抓取问题）不许糊成一句；
 *   ④ **密钥只报来源、不报值**：匿名档照旧能用，带 key 时回执里也一个字符都不出现。
 *
 * 网络出口一律是夹具（`fetch` 注入），**不打真端点**：这一组要能在没有网的机器上跑。
 * 端点的响应形状按 `skills/anysearch/scripts/shared/doc_spec.md` 与那份 py CLI 的格式化器
 * 写（`data.results[].title/url/content`、`data.metadata.total_results/search_time_ms`、
 * `data.content` 给 extract）——两处互相印证过，不是从记忆里编的。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { estimateTokens } from '../src/tools/registry.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { defaultNetDeps } from '../src/tools/net.ts';
import {
  ANYSEARCH_API_KEY_ENV,
  WEB_SEARCH_DOMAINS,
  WEB_SEARCH_TOOL_NAME,
  createWebSearchTool,
  parseExtractEnvelope,
  parseSearchEnvelope,
  renderSearchMarkdown,
  resolveAnySearchCredential,
  resolveWebSearchDeps,
} from '../src/tools/web-search.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const BASE = 'https://api.anysearch.com';

function makeCtx(patch: Partial<ToolContext> = {}): ToolContext {
  return {
    callId: 'call_web',
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
    workspaceRoot: process.cwd(),
    ...patch,
  };
}

interface Call {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** 一个按 URL 分派的网络出口夹具：记下每一次调用，答一份给定 JSON */
function rig(handler: (call: Call) => { status?: number; json?: unknown; text?: string }): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value);
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const call: Call = { url, body, headers };
    calls.push(call);
    const answer = handler(call);
    const status = answer.status ?? 200;
    const payload = answer.text ?? JSON.stringify(answer.json ?? {});
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchFn };
}

/** lookup 恒返回一个公网地址：SSRF 复查这道门在这一组里不该拦任何东西 */
const publicLookup = async (): Promise<string[]> => ['93.184.216.34'];

const sampleSearch = {
  code: 0,
  message: 'ok',
  data: {
    results: [
      { title: '滚木与棍木的来历', url: 'https://example.com/a', content: '测试群里那个梗的源头在这里。' },
      { title: '第二条', url: 'https://example.com/b', snippet: '换了 snippet 这个字段名也要认。', date: '2026-10-12' },
    ],
    metadata: { total_results: 42, search_time_ms: 137 },
  },
};

test('web_search：只读出网（不该被 destructive 那道门关掉）', () => {
  const tool = createWebSearchTool({ skillRoot: null }, { fetch: rig(() => ({ json: sampleSearch })).fetch, lookup: publicLookup });
  assert.equal(tool.name, WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.sideEffect, 'none', '搜索是只读动作：标成 destructive 会让默认档下她连搜都搜不了');
  assert.equal(tool.executionMode, 'parallel');
  assert.ok(tool.timeoutMs > 0);
  // 描述预算是硬门（§4.18 单件 ≤100，超了 register 抛错 = 这件工具静默消失）
  assert.ok(estimateTokens(tool.description) < 100, `描述 ${estimateTokens(tool.description)} token`);
});

test('web_search：拿回标题+链接+摘要的 Markdown，头一行给条数与端点耗时', async () => {
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const tool = createWebSearchTool({ skillRoot: null }, { fetch: fetchFn, lookup: publicLookup });
  const result = await tool.handler({ query: '滚木 棍木' }, makeCtx());

  assert.equal(result.isError, undefined, result.content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${BASE}/v1/search`);
  assert.deepEqual(calls[0]?.body, { query: '滚木 棍木', max_results: 5 }, '缺省 5 条、field 名与端点一致');
  assert.equal(calls[0]?.headers['x-anysearch-client'], 'skill/3.1.1', '客户端标识与四条 CLI 同源');

  assert.match(result.content, /^## 搜索「滚木 棍木」：返回 2 条，共 42 条命中，137ms/u);
  assert.match(result.content, /### 1\. 滚木与棍木的来历/);
  assert.match(result.content, /https:\/\/example\.com\/a/);
  assert.match(result.content, /测试群里那个梗的源头在这里。/);
  // `snippet` 这个别名也认（CLI 的格式化器自己就写了 content or snippet 的回退）
  assert.match(result.content, /### 2\. 第二条（2026-10-12）/);
  assert.match(result.content, /换了 snippet 这个字段名也要认。/);
  // 外部内容是数据不是指令（§4.15）
  assert.ok((result.additionalContext ?? []).some((line) => line.includes('不可信')), '要提醒内容不可信');
});

test('web_search：count 上限 10、越界当场拒（不是静默夹住）', async () => {
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const tool = createWebSearchTool({ skillRoot: null }, { fetch: fetchFn, lookup: publicLookup });
  const tooMany = await tool.handler({ query: 'x', count: 11 }, makeCtx());
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.content, /count/);
  assert.equal(calls.length, 0, '参数不合法不许发请求');

  await tool.handler({ query: 'x', count: 10 }, makeCtx());
  assert.deepEqual(calls[0]?.body, { query: 'x', max_results: 10 });
});

test('web_search：垂类——domain 单独给会被拦（端点会拒），配 sub_domain 才发 tag', async () => {
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const tool = createWebSearchTool({ skillRoot: null }, { fetch: fetchFn, lookup: publicLookup });

  const alone = await tool.handler({ query: 'AAPL', domain: 'finance' }, makeCtx());
  assert.equal(alone.isError, true);
  assert.match(alone.content, /sub_domain/u, '要说清还缺哪一格');
  assert.equal(calls.length, 0);

  const mismatch = await tool.handler({ query: 'AAPL', domain: 'finance', sub_domain: 'academic.search' }, makeCtx());
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content, /前缀/u);
  assert.equal(calls.length, 0);

  const unknown = await tool.handler({ query: 'AAPL', domain: '股票' }, makeCtx());
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /general/, '取值表要摆出来，否则她只能瞎试');
  assert.equal(calls.length, 0);

  const ok = await tool.handler({ query: 'AAPL', domain: 'finance', sub_domain: 'finance.quote' }, makeCtx());
  assert.equal(ok.isError, undefined, ok.content);
  assert.deepEqual(calls[0]?.body, { query: 'AAPL', max_results: 5, tag: 'finance.quote' },
    '端点的垂类靠 tag（domain 只是前缀校验，四条 CLI 同一条口径）');
  assert.match(ok.content, /垂类 finance\.quote/);
});

test('web_search：extract=true 再取前两条正文；取不到那条只影响它自己', async () => {
  const { calls, fetch: fetchFn } = rig((call) => {
    if (call.url.endsWith('/v1/extract')) {
      const target = (call.body as { url?: string }).url ?? '';
      if (target.endsWith('/b')) return { status: 500, text: 'boom' };
      return { json: { code: 0, data: { content: '# 正文标题\n\n这里是正文。' } } };
    }
    return { json: sampleSearch };
  });
  const tool = createWebSearchTool({ skillRoot: null }, { fetch: fetchFn, lookup: publicLookup });
  const result = await tool.handler({ query: '滚木', extract: true }, makeCtx());

  assert.equal(result.isError, undefined, result.content);
  assert.equal(calls.length, 3, '一次搜索 + 两条正文');
  assert.deepEqual(calls[1]?.body, { url: 'https://example.com/a' });
  // 取正文成功的那条：正文原样进来
  assert.match(result.content, /## 取回的正文（前 2 条）/);
  assert.match(result.content, /### 正文：https:\/\/example\.com\/a\n# 正文标题/);
  // 失败的那条：**分开说**，而且不影响搜索那一段（上面那两行照旧在）
  assert.match(result.content, /### 正文取不到：https:\/\/example\.com\/b/);
  assert.match(result.content, /HTTP 500/);
  assert.match(result.content, /### 1\. 滚木与棍木的来历/, '取正文的失败不许把搜索结果吃掉');
});

test('web_search：没命中不是错误，但要给出下一步；匿名档要说明配额', async () => {
  const { fetch: fetchFn } = rig(() => ({ json: { code: 0, data: { results: [] } } }));
  const tool = createWebSearchTool({ skillRoot: null, env: {} }, { fetch: fetchFn, lookup: publicLookup });
  const result = await tool.handler({ query: '一个查不到的东西' }, makeCtx());
  assert.equal(result.isError, undefined, '没命中是查询的结果，不是工具失败');
  assert.match(result.content, /没有命中/);
  assert.match(result.content, /换个说法/u, '要给下一步，不能只说"没有"');
  assert.match(result.content, /匿名配额/, '匿名档要说清配额这件事（用尽时看起来也像没有命中）');
});

test('web_search：端点报错与报文不对齐，两条路都如实说', async () => {
  const failing = rig(() => ({ status: 429, text: '{"code":429,"message":"rate limited"}' }));
  const toolA = createWebSearchTool({ skillRoot: null }, { fetch: failing.fetch, lookup: publicLookup });
  const limited = await toolA.handler({ query: 'x' }, makeCtx());
  assert.equal(limited.isError, true);
  assert.match(limited.content, /HTTP 429/);
  assert.match(limited.content, /rate limited/);

  const junk = rig(() => ({ json: { code: 0, data: { unexpected: true } } }));
  const toolB = createWebSearchTool({ skillRoot: null }, { fetch: junk.fetch, lookup: publicLookup });
  const bad = await toolB.handler({ query: 'x' }, makeCtx());
  assert.equal(bad.isError, true);
  assert.match(bad.content, /改版/u, '结构不对要说"给维护者看"，不是让她改查询');
});

test('web_search：密钥只报来源不报值；匿名档不带 Authorization', async () => {
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const anonymous = createWebSearchTool({ skillRoot: null, env: {} }, { fetch: fetchFn, lookup: publicLookup });
  const anon = await anonymous.handler({ query: 'x' }, makeCtx());
  assert.match(anon.content, /匿名配额/);
  assert.equal(calls[0]?.headers['authorization'], undefined, '匿名档不许编一个头出来');
  assert.equal(anon.content.includes(ANYSEARCH_API_KEY_ENV), false, '回执里连变量名都不必出现');

  const keyed = createWebSearchTool(
    { skillRoot: null, env: { [ANYSEARCH_API_KEY_ENV]: 'sk-secret-value-1234' } },
    { fetch: fetchFn, lookup: publicLookup },
  );
  const withKey = await keyed.handler({ query: 'x' }, makeCtx());
  assert.match(withKey.content, /已带密钥/);
  assert.equal(withKey.content.includes('sk-secret-value-1234'), false, '密钥值一个字符都不许进回执');
  assert.equal(calls[1]?.headers['authorization'], 'Bearer sk-secret-value-1234');
});

test('web_search：SSRF 那一套是复用 net.ts 的（私网地址在发请求之前就被拒）', async () => {
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const tool = createWebSearchTool(
    { skillRoot: null, baseUrl: 'http://127.0.0.1:9' },
    { fetch: fetchFn, lookup: publicLookup },
  );
  const result = await tool.handler({ query: 'x' }, makeCtx());
  assert.equal(result.isError, true);
  assert.match(result.content, /SSRF|私网|环回/u);
  assert.equal(calls.length, 0, '私网目标不许真的发出去');
});

test('web_search：端点覆盖读环境变量（与四条 CLI 同名的那个）', async () => {
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const tool = createWebSearchTool(
    { skillRoot: null, env: { ANYSEARCH_API_BASE_URL: 'https://mirror.example.com/' } },
    { fetch: fetchFn, lookup: publicLookup },
  );
  await tool.handler({ query: 'x' }, makeCtx());
  assert.equal(calls[0]?.url, 'https://mirror.example.com/v1/search', '末尾斜杠要归一化');
});

test('web_search：17 个垂类域与技能自己的 constants.json 逐字一致（防两处漂移）', () => {
  // 这张表抄进了代码（描述与校验都要在编译期确定），所以必须有东西盯着它别与技能那份漂开。
  // 技能目录不在时**跳过**（技能是可选资产），在的时候逐字比。
  const path = join(process.cwd(), 'skills', 'anysearch', 'scripts', 'shared', 'constants.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = JSON.parse(raw) as { available_domains?: string[] };
  assert.deepEqual(
    [...WEB_SEARCH_DOMAINS],
    [...(parsed.available_domains ?? [])],
    'skills/anysearch 的 constants.json 与 WEB_SEARCH_DOMAINS 漂了：两处必须一起改',
  );
});

test('web_search：解析与渲染是纯函数，字段别名两种都认', () => {
  const parsed = parseSearchEnvelope(sampleSearch);
  assert.equal(parsed?.hits.length, 2);
  assert.equal(parsed?.hasResults, true);
  assert.equal(parsed?.totalResults, 42);
  assert.equal(parsed?.elapsedMs, 137);
  // `results` **缺席**（报文形状变了）与 `results: []`（真的没命中）是两件事，这一位分开它们
  assert.equal(parseSearchEnvelope({ code: 0, data: { unexpected: true } })?.hasResults, false);
  assert.equal(parseSearchEnvelope({ code: 0, data: { results: [] } })?.hasResults, true);
  // `code !== 0` 那层信封 = 失败，不硬解
  assert.equal(parseSearchEnvelope({ code: 1, message: 'boom' }), null);
  assert.equal(parseSearchEnvelope('<html>not json</html>'), null);
  // extract 的正文可能叫三个名字
  assert.equal(parseExtractEnvelope({ code: 0, data: { markdown: '# x' } }), '# x');
  assert.equal(parseExtractEnvelope({ code: 0, data: {} }), null);

  const rendered = renderSearchMarkdown({
    query: 'q',
    hits: [{
      title: 'A\nB', url: 'https://a', snippet: 'x\ny', snippetTruncated: true, publishedAt: null, domain: null,
    }],
    totalResults: null,
    elapsedMs: null,
    credential: { baseUrl: BASE, apiKey: null, source: 'anonymous' },
    domain: null,
    subDomain: null,
  });
  // 标题与摘要里的换行要压成空格（一条命中占一行块，不是一整段）
  assert.match(rendered, /### 1\. A B/);
  assert.match(rendered, /x y …（摘要过长已截断，取全文用 extract:true）/);
  assert.ok(!rendered.includes('共 '), '端点没报总数就不许编一个');
});

test('web_search：缺省出口必须是真的（线上 2026-10-12 那条 DNS_FAILED 的回归锁）', () => {
  // ── 这条用例锁的是一个**真发生过的线上故障**，判据是它的逐字现场 ──
  //
  // 现场（`data/events/000000087671.jsonl`，seq 88395 / 88402 / 88416）：
  //   `搜索失败：DNS 解析 api.anysearch.com 没有返回任何地址`（code `DNS_FAILED`，durationMs 0）
  // 而那 0ms 就是根因的指纹：**一次真网络都没发出去**（真 DNS 要几毫秒到几十毫秒）。
  // 实现里的病是 `lookup: depsOverride.lookup ?? (async () => [])` —— 一个"没有注入就返回
  // 空地址表"的假兜底；而**所有既有用例都显式注入 lookup**，于是它测试里看着完全正常。
  //
  // ⇒ 这一条**不联网**（联网的用例在没网的机器上会飘），它断言的是**函数同一性**：
  // 缺省时用的必须就是 `net.ts` 的默认出口那两个函数本身。任何"再写一个假兜底"的改法
  // （返回空数组、返回 127.0.0.1、自己再实现一份 DNS……）都会在这里当场变红。
  const resolved = resolveWebSearchDeps();
  assert.equal(resolved.lookup, defaultNetDeps.lookup, '缺省的 lookup 必须是 net.ts 的真 DNS 出口');
  assert.equal(resolved.fetch, defaultNetDeps.fetch, '缺省的 fetch 必须是真的 fetch');
  // 注入仍然生效（测试与宿主那条路没被这次修复堵死）
  const stubLookup = async (): Promise<string[]> => ['93.184.216.34'];
  const stubFetch = (async () => new Response('{}')) as unknown as typeof fetch;
  assert.equal(resolveWebSearchDeps({ lookup: stubLookup }).lookup, stubLookup);
  assert.equal(resolveWebSearchDeps({ fetch: stubFetch }).fetch, stubFetch);
  assert.equal(typeof defaultNetDeps.lookup, 'function');
  assert.equal(typeof defaultNetDeps.fetch, 'function');
});

test('web_search：DNS 解析不出地址时，回执要指出卡在哪一步（且不与"密钥没配"混成一句）', async () => {
  // 反面：**真的**解析不出地址时（夹具：空地址表），错误必须指出是解析这一步，
  // 而且要与"密钥没配"分开说——两件事的下一步完全不同（一个去配密钥，一个去查网络/域名）。
  const { calls, fetch: fetchFn } = rig(() => ({ json: sampleSearch }));
  const tool = createWebSearchTool(
    { skillRoot: null, env: {} },
    { fetch: fetchFn, lookup: async () => [] },
  );
  const result = await tool.handler({ query: 'x' }, makeCtx());
  assert.equal(result.isError, true);
  assert.equal(result.error?.code, 'DNS_FAILED');
  assert.match(result.content, /DNS 解析/u, '要说清卡在 DNS 这一步');
  assert.match(result.content, /api\.anysearch\.com/u, '要点名是哪个主机');
  assert.equal(calls.length, 0, '解析不出去就不该发请求（这一点是对的，坏的是"永远解析不出去"）');
  // 密钥那条路**不受影响**：匿名是合法状态（技能文档写着匿名可用），不该混进这条错误里
  assert.doesNotMatch(result.content, /密钥|配额/u, '这是网络问题，不是密钥问题——两者不许混成一句');
});

test('web_search：密钥取值链 = 环境变量 > 技能 .env > 匿名', () => {
  const dir = tempDirSync('irmia-anysearch-');
  try {
    // 技能根下的 `.env`（与四条 CLI 的 _load_env() 同一个文件）
    writeFileSync(join(dir, '.env'), '# 注释\nANYSEARCH_API_KEY="sk-from-file"\n', 'utf8');
    assert.deepEqual(
      resolveAnySearchCredential({ env: {}, skillRoot: dir }),
      { baseUrl: BASE, apiKey: 'sk-from-file', source: 'skill-env-file' },
    );
    assert.equal(
      resolveAnySearchCredential({ env: { [ANYSEARCH_API_KEY_ENV]: 'sk-from-env' }, skillRoot: dir }).source,
      'env',
      '环境变量优先于文件（与技能文档那条优先级一致）',
    );
    assert.equal(resolveAnySearchCredential({ env: {}, skillRoot: null }).source, 'anonymous');
    // 目录在但文件没有：不抛错，落回匿名
    const empty = tempDirSync('irmia-anysearch-empty-');
    try {
      mkdirSync(join(empty, 'x'), { recursive: true });
      assert.equal(resolveAnySearchCredential({ env: {}, skillRoot: empty }).source, 'anonymous');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
