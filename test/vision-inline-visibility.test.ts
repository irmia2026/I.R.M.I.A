/**
 * 「说了做了、其实没做」的那一类静默失效 —— **工具侧写入点的可见性与 inline 的载荷判据**。
 *
 * 事故形状（2026-10-11 核实并修）：
 *   ① **可见性**：事件类型 → 可见性那张表（`log/types.ts` 的 `EVENT_VISIBILITY`）写着
 *      `image/attached` / `message/assistant` 是 `model`，而工具侧那个写入点（`src/main.ts`
 *      的 `emit`）的默认参数是**恒为 `internal`** 的字面量、`vision` 的 emit 适配层
 *      （`src/tools/catalog.ts`）又把第三个参数整个吃掉。于是"省略可见性"这一个动作在两侧的
 *      含义相反：表说 `model`、落库成 `internal`、渲染层（`render.ts` 的 `isModelVisible`）
 *      不看它——**事件在、数据也在，只有那一栏不对**，从日志上根本查不出错；而回执照旧写着
 *      "图片已放进你的上下文"。
 *   ② **载荷**：`inline` 原先只看扩展名（`imageMimeOf` 认得 `image/bmp`）就写事件，而进上下文
 *      的型别白名单只有 png/jpeg/gif/webp ⇒ 渲染层当场丢掉它，回执照旧说进了。**实测**：
 *      事件 1 条、请求体 input_image = 0。修法：型别不在白名单就**别写事件**，回执如实说清
 *      （"进不去上下文" + 出路）。
 *
 * 这一份钉五件事（判据只紧不松）：
 *   ① **端到端（正向）**：真装配（`buildCatalogRegistry`——vision 的 emit 适配层就是生产那一处）
 *      + 与 `main.ts` 同一条写入判据（`resolveEventVisibility`）⇒ `vision_read { inline: true }`
 *      收 png ⇒ **请求体里真有 image part**（从请求体那一侧看，不看工具回执——回执会说谎，
 *      请求体不会）；
 *   ② **端到端（载荷那一侧）**：`.bmp` ⇒ 零 `image/attached` 事件、回执逐字含"进不去上下文"
 *      与那个 mime、请求体 0 张；png+bmp 混着要 ⇒ 只有 png 那条事件、请求体 1 张、回执如实
 *      点出被跳过的那张；
 *   ③ **她说的话在她自己的历史里**：`speak` 落下的 `message/assistant` 是 model ⇒
 *      下一拍的请求体里有那一句（她是靠历史认"我刚才说了什么"的）；
 *   ④ **防呆（静态）**：全仓 `emit(` 调用点扫描——凡事件类型的缺省可见性是 `model` 的，
 *      **必须显式给**可见性；省一处就红（口径与 `test/thinking-effort-invariant.test.ts`
 *      的模型调用点扫描同源："新加一处调用必然先红"，而不是靠每个调用点记性）；
 *   ⑤ **防呆（写入判据本身）**：表说 `model` 的事件，省略可见性 ⇒ 当场抛。
 *
 * 三条刻意的构造：
 *   · 写入点**与生产逐字同形**（`main.ts` 的 `emit`）：可见性走同一处判据；本文件里的 rig
 *     **不许吞掉可见性参数**——旧 rig（`emit: (type, data) => {…}`）正是这个 bug 藏身处；
 *   · 工具的 `workspaceRoot` 与 loader 的解析基准**取同一个根**（生产里两边都是 `process.cwd()`：
 *     `agent-loop.ts` 的 `deps.workspaceRoot ?? process.cwd()` 与 `real-loop.ts` 的 loadImage
 *     那半句 `resolve(process.cwd(), ref.key)`）。这里是临时目录，但"同一个根"这条性质不变；
 *   · 具体那张图的字节由**渲染层注入的那个 loader**（`readFileImage` + `CONTEXT_IMAGE_HARD_BYTES`）
 *     决定进不进——不是本文件另写一套判据。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';

import { CONTEXT_IMAGE_HARD_BYTES, readFileImage } from '../src/channel/attachment-store.ts';
import { EventLog } from '../src/log/event-log.ts';
import { EVENT_VISIBILITY, resolveEventVisibility, type AppEvent, type Visibility } from '../src/log/types.ts';
import { render, type RenderImageRef, type RenderedRequest } from '../src/model/render.ts';
import { applyOne, fold } from '../src/state/fold.ts';
import { buildCatalogRegistry } from '../src/tools/catalog.ts';
import { TimerStore } from '../src/wake/timer-store.ts';

const TZ = 'Asia/Shanghai';

/** 合法 PNG 的字节头（够让 loader 的字节头判据认出来）；内容无所谓，判的是"进没进请求体" */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.alloc(9, 0),
]);
/** `.bmp`：`imageMimeOf` 认得它（`image/bmp`），而进上下文的型别白名单里没有它 */
const BMP_BYTES = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(16, 0)]);

interface Rig {
  dir: string;
  workspace: string;
  events: AppEvent[];
  call: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>;
  request: () => RenderedRequest;
  ofType: (type: string) => AppEvent[];
}

/**
 * 真链路测试台：真 EventLog + 真投影 + **真 `buildCatalogRegistry`**（照 `main.ts` 那份选项）。
 * 工具那侧唯一没给的是 `visionClient`（这一份不该发起模型调用），而它不影响 inline 那条路
 * ——inline 根本不调模型。
 */
async function makeRig(t: TestContext): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-inline-vis-'));
  const dataDir = join(dir, 'data');
  // 工具的工作根：生产里 = `process.cwd()`（见文件头第 2 条构造），这里 = 临时目录
  const workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const log = await EventLog.open(join(dataDir, 'events'));
  const projection = fold([]);
  const events: AppEvent[] = [];
  const now = (): Date => new Date('2026-10-11T10:00:00.000+08:00');
  const append = (event: AppEvent): AppEvent => {
    log.append(event, { sync: true });
    applyOne(projection, event);
    events.push(event);
    return event;
  };

  /**
   * **与 `main.ts` 的写入点逐字同形**：可见性交给 `resolveEventVisibility` 那一处判据
   * （省略 ⇒ 由 schema 表判；表说 `model` 的事件省略就当场抛）。
   *
   * 这里**刻意不写** `visibility ?? 'internal'`：那正是生产里出事的那个默认值，写进 rig 就等于
   * 把要测的错替被测方兜住（旧 rig 就是这么绿的）。也**不许**像 `test/admin-pwsh.test.ts` 的
   * `makeRecorder` 那样把第三个参数整个吞掉。
   */
  const emit = (type: string, data: unknown, visibility?: Visibility): void => {
    append({
      seq: log.nextSeq(),
      ts: now().toISOString(),
      type,
      data,
      visibility: resolveEventVisibility(type, visibility),
      origin: 'test/vision-inline-visibility',
    } as unknown as AppEvent);
  };

  const { registry, problems } = await buildCatalogRegistry({
    dataDir,
    timers: new TimerStore(null),
    emit,
    visionImagesToContext: true,
    // 打字节奏关掉：这一份测的是"说过的话进没进历史"，不该真等
    speakTyping: { typingEffect: false, charsPerMinute: 90 },
    onNote: () => {},
  });
  assert.deepEqual(problems, [], '工具装配不该有问题（有问题就说明这一份测的清单不是生产那份）');

  // 一条 user 消息：让"下一拍有历史"这件事成立
  append({
    seq: log.nextSeq(),
    ts: now().toISOString(),
    type: 'wake/manual',
    data: { note: '看一眼这张图' },
    visibility: 'model',
    origin: 'test/vision-inline-visibility',
  } as unknown as AppEvent);

  const ctx = {
    callId: 'call_1', turn: 1, step: 1,
    signal: new AbortController().signal,
    workspaceRoot: workspace,
  };

  t.after(() => {
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
    workspace,
    events,
    call: async (name, args) => {
      const tool = registry.get(name);
      assert.ok(tool !== null, `${name} 该在注册表里`);
      const result = await tool.handler(args, ctx);
      return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
    },
    /**
     * 与运行期同一条渲染路径（`render`）+ `real-loop` 注入的那个 loader 的逐字逻辑
     * （`source === 'file'` 走 `readFileImage`，基准 = 工具的工作根）。
     */
    request: () => render({
      events,
      persona: { identity: 'i', constitution: 'c', style: 's', state: '' },
      tools: [],
      wakeEvent: null,
      taskCard: null,
      now: now().toISOString(),
      timezone: TZ,
      model: 'deepseek-v4-pro',
      lane: 'heavy',
      contact: null,
      mentionNotice: null,
      machine: null,
      usage: null,
      asks: null,
      injection: null,
      loadImage: (ref: RenderImageRef) => {
        const read = readFileImage(
          isAbsolute(ref.key) ? ref.key : resolve(workspace, ref.key),
          ref.mime,
          CONTEXT_IMAGE_HARD_BYTES,
        );
        return read.ok ? read.image : null;
      },
      maxContextImages: 4,
      softHint: null,
      memoryIndex: null,
      skillCatalog: null,
      turnBlock: null,
      stateBytes: null,
      stateBudgetBytes: null,
    }),
    ofType: (type) => events.filter((e) => e.type === type),
  };
}

/** 请求体里所有 `input_image` 的 data URL */
function imageUrls(r: RenderedRequest): string[] {
  const out: string[] = [];
  for (const item of r.input) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) if (part.type === 'input_image') out.push(part.image_url);
  }
  return out;
}

/** 请求体里所有 assistant 消息的正文（顺序即进请求体的顺序） */
function assistantTexts(r: RenderedRequest): string[] {
  return r.input
    .filter((item) => item.type === 'message' && item.role === 'assistant')
    .map((item) => (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)));
}

// ─────────────────── ① vision_read inline：请求体里真有 image part ───────────────────

test('① vision_read inline(png) ⇒ 请求体里真有 image part（不是回执说进了，是真进了）', async (t) => {
  const rig = await makeRig(t);
  writeFileSync(join(rig.workspace, 'pic.png'), PNG_BYTES);

  const result = await rig.call('vision_read', { paths: ['pic.png'], inline: true });
  assert.equal(result.isError, undefined, `inline 这条路不该报错：${result.content}`);
  // 回执自称进了上下文——下面从**请求体那一侧**验它是不是真的
  assert.match(result.content, /已放进你的上下文/u, `回执的形状：${result.content}`);

  const attached = rig.ofType('image/attached');
  assert.equal(attached.length, 1, '一次 inline 该写一条 image/attached（图只能靠事件进上下文）');
  assert.equal(attached[0]?.visibility, 'model',
    '可见性必须是 model：渲染层按 visibility === \'model\' 过滤（render.ts 的 isModelVisible）');

  const expected = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
  assert.deepEqual(imageUrls(rig.request()), [expected],
    '请求体里必须真有那张图：工具结果是文本，图进上下文只有 image/attached 这一条路');
});

// ─────────── ② inline 的载荷判据：进不去的型别不写事件，回执如实说 + 给出路 ───────────

test('② vision_read inline(.bmp)：零事件、回执逐字说"进不去上下文"、请求体 0 张', async (t) => {
  const rig = await makeRig(t);
  writeFileSync(join(rig.workspace, 'pic.bmp'), BMP_BYTES);

  const result = await rig.call('vision_read', { paths: ['pic.bmp'], inline: true });

  // 零事件：写了也是白写——渲染层按型别白名单当场丢掉它
  assert.deepEqual(rig.ofType('image/attached'), [],
    '型别不在白名单里的那张**不许**写 image/attached：写了也进不去，只会让日志看起来"带过了"');
  // 回执如实（逐字要素：进不去上下文 + 那个 mime），并且给出一条她走得了的路
  assert.match(result.content, /进不去上下文/u, `回执必须如实说进不去：${result.content}`);
  assert.match(result.content, /image\/bmp/u, `回执要说清是哪一种型别：${result.content}`);
  assert.match(result.content, /转述|png\/jpeg/u, `回执必须给出路：${result.content}`);
  assert.doesNotMatch(result.content, /已放进你的上下文/u, '一张都没进去，不许说"已放进上下文"');
  assert.equal(result.isError, true, '一张都没进去 = 这次 inline 没成，不许报成功');
  // 结果那一侧
  assert.deepEqual(imageUrls(rig.request()), [], '请求体里当然也不该有它');
});

test('② png 与 bmp 混着要：只有 png 进上下文，回执如实点出被跳过的那张', async (t) => {
  const rig = await makeRig(t);
  writeFileSync(join(rig.workspace, 'ok.png'), PNG_BYTES);
  writeFileSync(join(rig.workspace, 'no.bmp'), BMP_BYTES);

  const result = await rig.call('vision_read', { paths: ['ok.png', 'no.bmp'], inline: true });

  assert.equal(result.isError, undefined, `有能进的就不该整条失败：${result.content}`);
  const attached = rig.ofType('image/attached');
  assert.deepEqual(attached.map((e) => (e.data as { key?: string }).key), ['ok.png'],
    '只给进得去的那张写事件');
  assert.equal(attached[0]?.visibility, 'model', '而且可见性必须是 model');
  assert.match(result.content, /skipped|没进去/u, `少了一张要如实说，别让人对路径才发现：${result.content}`);
  assert.deepEqual(imageUrls(rig.request()), [`data:image/png;base64,${PNG_BYTES.toString('base64')}`],
    '请求体里恰好是那 1 张（png）');
});

// ─────────────── ③ 她说出口的话：在她自己的历史里看得见（next step 的请求体） ───────────────

test('③ speak 说过的话在下一拍的请求体里（她认"我刚才说了什么"靠的就是这份历史）', async (t) => {
  const rig = await makeRig(t);
  const said = '在的，我先看一眼日志。';

  const result = await rig.call('speak', { text: said });
  assert.equal(result.isError, undefined, `speak 不该报错：${result.content}`);

  const bubbles = rig.ofType('message/assistant');
  assert.equal(bubbles.length, 1, `整段一次发言该落一条 message/assistant：${result.content}`);
  assert.equal(bubbles[0]?.visibility, 'model',
    'message/assistant 在 schema 表里是 model（docs/schema.md:957；speak/sent 才是 internal）');

  assert.ok(assistantTexts(rig.request()).includes(said),
    '下一拍的请求体里必须有她说过的这句话的**独立形态**（assistant 消息）——'
    + '生产里它虽然也在 speak 那次 function_call 的 arguments 里，但"我说过什么"在历史里'
    + `没有可读的形态：\n${JSON.stringify(assistantTexts(rig.request()))}`);
});

// ─────────────────────────── ④ 防呆：写入判据本身 ───────────────────────────

test('④ 防呆：表说 model 的事件，省略可见性 ⇒ 当场抛（不是静默落 internal）', () => {
  const modelTypes = Object.entries(EVENT_VISIBILITY)
    .filter(([, visibility]) => visibility === 'model')
    .map(([type]) => type);
  assert.ok(modelTypes.length > 10, `表里该有一批 model 类型（现在是 ${modelTypes.length} 个）`);

  for (const type of modelTypes) {
    assert.throws(() => resolveEventVisibility(type), new RegExp(type.replace(/[/-]/gu, '.')),
      `${type}：省略可见性必须抛——省略曾经静默落成 internal，事件在日志里、渲染层却看不见它`);
    assert.throws(() => resolveEventVisibility(type, 'internal'), /internal/u,
      `${type}：显式写 internal 同样是静默失效，不许放行`);
    assert.equal(resolveEventVisibility(type, 'model'), 'model', `${type}：显式给 model 放行`);
  }
  // internal 那一侧照旧可省（省略与表同值）：这是"省略即错"不成立的另一半
  assert.equal(resolveEventVisibility('speak/sent'), 'internal');
  assert.equal(resolveEventVisibility('channel/message', 'internal'), 'internal');
  // 而且这条路**真的**通到写入点：main.ts 的 emit 调的就是它（rig 里那份逐字同形）
  assert.throws(() => resolveEventVisibility('image/attached'), /image\/attached/u);
});

// ─────────────────────── ⑤ 防呆：全仓 emit 调用点扫描 ───────────────────────

/** 仓库根（本文件在 test/ 下） */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface EmitSite {
  /** `src/<相对路径>:<行号>` */
  where: string;
  /** 第一个实参（原文，压掉空白） */
  first: string;
  /** 第三个实参在不在 = 显式给了可见性 */
  hasVisibility: boolean;
  /** 那一行原文（用来断言"适配层确实显式给了"） */
  source: string;
}

/**
 * 扫 `src/**` 里的 `emit(` 调用点（跳过注释行）。
 *
 * 判据只认**字面量事件类型**那一条：它是"这个写入点写的是哪种事件"唯一可静态判定的形态。
 * 动态那一类（第一实参是变量）交给下面两张认领表——`tools/catalog.ts` 那个适配层正是这次
 * 事故的藏身点，扫描器按"字面量"这条判据抓不到它，所以**必须**有人在表里认领它。
 *
 * 两处必须按这个做法来（都踩过）：
 *   · **实参要跨行读**（`plan-mode.ts` 的 `emit('human/asked', {…}, defaultVisibility(…))`
 *     第三参在四行之后）——只读一行会把"显式给了"误判成"省略了"；
 *   · **行尾先归一**（仓库里 CRLF 与 LF 混着）：`.+$` 里的 `.` 不吃 `\r`，CRLF 文件会整行失配。
 */
function scanEmitSites(): EmitSite[] {
  const srcRoot = join(REPO_ROOT, 'src');
  const out: EmitSite[] = [];
  for (const entry of readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })) {
    const rel = String(entry).replace(/\\/gu, '/');
    if (!rel.endsWith('.ts')) continue;
    const text = readFileSync(join(srcRoot, rel), 'utf8').replace(/\r\n/gu, '\n');
    const lines = text.split('\n');
    const offsets: number[] = [];
    let at = 0;
    for (const line of lines) { offsets.push(at); at += line.length + 1; }
    for (let n = 0; n < lines.length; n += 1) {
      const line = lines[n]!;
      if (/^\s*(\/\/|\*|\/\*)/u.test(line)) continue;          // 注释行不算
      const re = /(?:^|[^A-Za-z0-9_$])(?:this\.|options\.|[A-Za-z_$][\w$]*\.)?emit\(/gu;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const open = (offsets[n] ?? 0) + m.index + m[0].length - 1;
        const close = matchParen(text, open);
        if (close === -1) continue;
        const args = splitTopLevel(text.slice(open + 1, close));
        if (args.length === 0) continue;
        out.push({
          // 调用跨行时报**调用起始**那一行
          where: `src/${rel}:${n + 1}`,
          first: args[0]!.replace(/\s+/gu, ' '),
          hasVisibility: args.length >= 3,
          source: line,
        });
      }
    }
  }
  return out;
}

/** 从 `(` 起找与它配对的那个 `)`（跳过字符串与注释；跨行） */
function matchParen(text: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return -1;
}

/** 按顶层逗号切实参（够用：跳过字符串与括号） */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s !== '');
}

/** 认领表的键：文件 + 第一实参（不含行号——行号会随无关改动漂，键跟着漂就没人愿意维护它） */
function siteKey(file: string, first: string): string {
  return `${file} | ${first}`;
}

/**
 * 第一实参不是事件类型字面量的 `emit(` 调用点：逐条认领。
 *
 * 表里**多数不是日志写入**（进程输出、定时器内部回调、`#emit` 自己的调用点），认领理由逐条
 * 写在注释里——它们进这张表只是"扫描器看得见它们"这件事的如实记录。真正的意义在于
 * `tools/catalog.ts` 那一行：它必须出现在这里，等于强迫下一个人回答"这一处给了什么可见性"。
 */
const DYNAMIC_EMIT_SITES: readonly string[] = [
  // vision 的 emit 适配层：**可见性必须在这一层显式给**（见 ⑤-b）
  siteKey('src/tools/catalog.ts', 'type'),
  // 钩子运行器的回调（收一个对象，可见性由构造它的 main.ts 那一处决定）
  siteKey('src/hook/hooks.ts', '{ hook: point, outcome: run.outcome }'),
  // `JobManager#emit(event, visibility, sync)`：可见性是**必填形参**（不是可省略的那个洞）
  siteKey('src/runtime/job-manager.ts', "{ type: 'job/started', data: { jobId: job.jobId, command: job.command, turn: job.turn } }"),
  siteKey('src/runtime/job-manager.ts', "{ type: 'job/finished', data: { jobId: job.jobId, exitCode: job.exitCode, outputRef: JSON.stringify(output) } }"),
  siteKey('src/runtime/job-manager.ts', "{ type: 'wake/job', data: this.#wakeDataOf(record, settled.text) }"),
  siteKey('src/runtime/job-manager.ts', "{ type: 'job/finished', data: { jobId, exitCode: null, outputRef: JSON.stringify(output) } }"),
  siteKey('src/runtime/job-manager.ts', "{ type: 'wake/job', data: this.#wakeDataOf(record, settledOutput.ok ? settledOutput.text : null) }"),
  siteKey('src/runtime/job-manager.ts', 'event: JobEventInput'),
  // 定时器内部回调（`WakeSink` / `TimerStore` 的 emit 收条目、不收事件类型）
  siteKey('src/wake/sources.ts', 'entry'),
  siteKey('src/wake/sources.ts', 'entry: StoredTimerEntry'),
  siteKey('src/wake/timer-store.ts', 'entry'),
  siteKey('src/wake/timer-store.ts', 'entry: StoredTimerEntry'),
];

/**
 * 「可见性由适配层给」的写入点：**写入点不是它自己**。
 *
 * `vision.ts` 的窄接口（`VisionToolOptions.emit`）里没有 visibility 这一格——它只该写
 * `image/attached` 这一种事件，"该给什么可见性"由 `tools/catalog.ts` 那个适配层显式给。
 * 认领它时**同时**要求适配层那一处真的是显式的（见 ⑤-b），所以这不是一句"相信我"。
 */
const VISIBILITY_FROM_ADAPTER: readonly string[] = [
  siteKey('src/tools/vision.ts', "'image/attached'"),
];

test('⑤ 防呆：全仓 emit 调用点——表说 model 的事件必须显式给可见性', () => {
  const sites = scanEmitSites();
  const literal = /^'([^']*)'$/u;
  const unresolved: string[] = [];
  const missing: string[] = [];

  for (const site of sites) {
    const file = site.where.slice(0, site.where.lastIndexOf(':'));
    const lit = literal.exec(site.first);
    if (lit === null) { unresolved.push(siteKey(file, site.first)); continue; }
    const type = lit[1]!;
    if (EVENT_VISIBILITY[type] !== 'model' || site.hasVisibility) continue;
    if (VISIBILITY_FROM_ADAPTER.includes(siteKey(file, site.first))) continue;
    missing.push(`${site.where}  ${type}`);
  }

  assert.deepEqual(missing, [],
    '这些写入点写的是"她必须看见"的事件（表说 model），却没显式给可见性：\n'
    + `${missing.join('\n')}\n`
    + '省略可见性在工具侧写入点上曾经静默落成 internal（事件在日志里、渲染层看不见它）。'
    + `改法：第三个实参写 \`defaultVisibility('<事件类型>')\`；`
    + '确实由适配层给的那种，在 VISIBILITY_FROM_ADAPTER 里认领并说明。');

  assert.deepEqual([...new Set(unresolved)].sort(), [...DYNAMIC_EMIT_SITES].sort(),
    '第一实参不是事件类型字面量的 emit 调用点与认领表对不上：\n'
    + '新加了一处 ⇒ 在 DYNAMIC_EMIT_SITES 里认领它（并回答"这一处给了什么可见性"）；\n'
    + '删掉了一处 ⇒ 把那一行也删掉。**别让这条变绿了事**——tools/catalog.ts 那一处正是这次事故的藏身点。');
});

test('⑤-b 防呆：vision 的 emit 适配层显式把可见性给出去（那个洞原来的藏身点）', () => {
  const adapters = scanEmitSites().filter((site) =>
    site.where.startsWith('src/tools/catalog.ts:') && site.first === 'type');
  assert.equal(adapters.length, 1,
    `tools/catalog.ts 里该有且只有一处动态 emit 适配层（现在 ${adapters.length} 处）`);
  assert.match(adapters[0]!.source, /defaultVisibility\(/u,
    '适配层必须显式把可见性给出去（`options.emit(type, data, defaultVisibility(type))`）——'
    + 'vision 的窄接口里没有这一格，而省略它会让 `image/attached` 落成 internal：'
    + '回执写着"图片已放进你的上下文"，请求体里一张图都没有');
});
