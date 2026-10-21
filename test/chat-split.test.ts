/**
 * chat-split 测试 — src/tools/chat-split.ts
 *
 * 这个模块决定她**说话长什么样**：一段话拆成几条、标点留不留。三条硬规则来自 YG 给的正例，
 * 所以第一条用例就是那个正例本身（逐字锁死，防止有人"顺手优化"掉语气词分行或逗号保留）。
 *
 * 切分已经没有随机成分（概率机制连同随机源注入一起删了）：同一输入永远同一形态。
 *
 * 2026-10-02 用户补的三条口径各有专门的用例组（都是表驱动）：
 *   · 「顿号不拆了」        → 分段 · 顿号不再是切分点
 *   · 「12 字以下不拆」     → 分段 · 太短不拆（11 / 12 / 13 三条边界）
 *   · 「成对符号不能中间断开」→ 分段 · 成对符号保护（含嵌套与未闭合）
 *
 * 另有一条贯穿性断言（"不改字"）：切完之后每段都必须仍是原文的顺序子串——
 * 改写、丢字、换序都会被它抓住。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SPLIT_MAX_CHARS, SPLIT_MIN_CHARS, charCount, pairsBalanced, softenDashes, splitForChat,
} from '../src/tools/chat-split.ts';

/** YG 给的正例原文（他平时就是这么说话的） */
const EXAMPLE =
  '唉，这种问题你也问我，我又不会做饭，庄园里厨房那摊子，平时都是别人管的，'
  + '真要说的话，想吃热的，汤面，或者炖的烂烂的那种肉';

/**
 * 正例该拆成的样子：**一个逗号一条**。
 *
 * 用户后来把口径收到"逗号全摘全分段"——不再有"意群内的逗号留着"那种形态。
 * 一上来他给的正例里那两段（「庄园里厨房那摊子，平时都是别人管的」与
 * 「想吃热的，汤面，或者炖的烂烂的那种肉」）当时被读成"逗号该留"，现在按新口径拆开。
 */
const EXAMPLE_SPLIT = [
  '唉',
  '这种问题你也问我',
  '我又不会做饭',
  '庄园里厨房那摊子',
  '平时都是别人管的',
  '真要说的话',
  '想吃热的',
  '汤面',
  '或者炖的烂烂的那种肉',
];

/** 每段都必须是原文的顺序子串（不改写、不丢字、不换序） */
function assertSubstringsInOrder(segments: string[], source: string): void {
  let cursor = 0;
  for (const segment of segments) {
    const at = source.indexOf(segment, cursor);
    assert.ok(at >= 0, `段「${segment}」必须原样出现在原文里且保持顺序`);
    cursor = at + segment.length;
  }
}

describe('分段 · 格式约定', () => {
  test('段长上限 20 字', () => {
    // 这个数字直接决定界面上的观感，改动必须是有意的
    assert.equal(SPLIT_MAX_CHARS, 20);
  });

  test('空输入与纯空白 → 空数组（调用方据此跳过投递）', () => {
    assert.deepEqual(splitForChat(''), []);
    assert.deepEqual(splitForChat('   '), []);
    assert.deepEqual(splitForChat('\n\n'), []);
  });
});

describe('分段 · 正例回归（YG 那段话）', () => {
  test('一个逗号一条：九个逗号切成九条，标点一个不留', () => {
    const out = splitForChat(EXAMPLE);
    assert.deepEqual(out, EXAMPLE_SPLIT);
    assertSubstringsInOrder(out, EXAMPLE);
  });

  test('切分不再有随机成分：同一段话每次切出来逐字节一致', () => {
    // 概率机制连同随机源注入一起删掉了（用户改成"逗号全摘全分段"）。这条锁的是
    // "同一输入永远同一形态"——它顺带说明为什么测试里不再需要注入随机数。
    assert.deepEqual(splitForChat(EXAMPLE), splitForChat(EXAMPLE));
    assert.ok(splitForChat(EXAMPLE).every((seg) => seg.length <= SPLIT_MAX_CHARS), '任何一段都不得超过段长上限');
  });
});


describe('分段 · 新规则（摘了就断、不摘就不断）', () => {
  test('句号一定摘：切在那儿，标点本身消失', () => {
    // 12 字以下是整段不拆的（见「太短不拆」那一组），所以这几条都在线上面；
    // 线下面的短句形态另有一条用例锁着（「你好。我很好。」整段一条）
    assert.deepEqual(
      splitForChat('我在的，一直都在。你回头喊我一声就行。'),
      ['我在的', '一直都在', '你回头喊我一声就行'],
    );
  });

  test('问号不摘：留着它，也不在那儿断', () => {
    // 旧规则把它当句末摘掉，于是「修好啦？那你发张图来试试」被切成两条——
    // 用户的口径是问号本身就是一个停顿的表情，摘掉反而丢东西
    assert.deepEqual(splitForChat('是吗？'), ['是吗？']);
    assert.deepEqual(
      splitForChat('修好啦？那你发张图来试试'),
      ['修好啦？那你发张图来试试'],
    );
  });

  test('省略号、分号、波浪号同样不摘也不断', () => {
    const said = '别发虫子啊……真的别，我这边看着呢。';
    assert.deepEqual(splitForChat(said), ['别发虫子啊……真的别', '我这边看着呢']);
    assert.deepEqual(splitForChat('这样；那样，我一直记着呢'), ['这样；那样', '我一直记着呢']);
    assert.deepEqual(splitForChat('好耶～那我们就这么定了，明天见'), ['好耶～那我们就这么定了', '明天见']);
  });

  test('叹号看句长：短句留着，长句摘掉并断开', () => {
    // 短句整段一条，叹号原样留着（「好！」摘了就只剩一个干巴巴的词）
    assert.deepEqual(splitForChat('好！'), ['好！']);
    assert.deepEqual(splitForChat('真的！'), ['真的！']);
    assert.deepEqual(splitForChat('成了！'), ['成了！']);
    // 长句里的叹号只是收尾，摘掉更像随手打的
    assert.deepEqual(splitForChat('太好了我总算把这个破玩意儿修好了！'), ['太好了我总算把这个破玩意儿修好了']);
    // 判据是断点前的字数（不含标点），5 字以内算短句
    assert.deepEqual(splitForChat('一二三四五！接着往下说点什么'), ['一二三四五！接着往下说点什么']);
    assert.deepEqual(splitForChat('一二三四五六！接着往下说些什么'), ['一二三四五六', '接着往下说些什么']);
  });

  test('用户的原话（今天日志里的真句）：摘与断是同一件事的两面', () => {
    // 「诶，修好啦？那你发张图来试试，我这边看着呢。别发虫子啊……真的别。」
    const said = '诶，修好啦？那你发张图来试试，我这边看着呢。别发虫子啊……真的别。';
    // 逗号全摘 → 每处都断；问号与省略号不摘 → 那两处不断；句号摘 → 断
    assert.deepEqual(
      splitForChat(said),
      ['诶', '修好啦？那你发张图来试试', '我这边看着呢', '别发虫子啊……真的别'],
    );
    assertSubstringsInOrder(splitForChat(said), said);
  });
});

describe('分段 · 三条硬规则', () => {
  test('语气词单发（逗号全断之后，"唉，..."自然就是它自己一条）', () => {
    assert.deepEqual(splitForChat('嗯，知道了，你先去忙你的吧'), ['嗯', '知道了', '你先去忙你的吧']);
    assert.deepEqual(splitForChat('啊？'), ['啊？']);
    assert.deepEqual(splitForChat('唉，这种问题你也问我什么呀'), ['唉', '这种问题你也问我什么呀']);
  });

  test('逗号全摘全分段：标点不跟着走，段末也不会留下它', () => {
    assert.deepEqual(splitForChat('庄园里，别人管的，我一直记着'), ['庄园里', '别人管的', '我一直记着']);
    assert.deepEqual(splitForChat('庄园里，'), ['庄园里，'], '太短（4 字）→ 整段一条，逗号也留着');
    assert.deepEqual(splitForChat('a,b,c,d,e,f,g,h,i,j,k,l,m')[0], 'a', '半角逗号同样是切点');
  });

  test('换行是断点：她自己分的行就是最准的边界', () => {
    assert.deepEqual(splitForChat('第一句\n第二句，还有第三句呢'), ['第一句', '第二句', '还有第三句呢']);
    assert.deepEqual(splitForChat('一\r\n二，三，四，五，六，七，八'), ['一', '二', '三', '四', '五', '六', '七', '八']);
  });
});

// ──────────────────────────────── 用户 2026-10-02 的三条追加口径 ────────────────────────────────

/**
 * ① 顿号不再是切分点（用户："顿号不拆了"）。
 *
 * 修之前它和逗号同级（`ALWAYS_STRIP` 里有它），于是列举项被一条条拆开：
 * 日志 seq 6209 那句「时刻、本机、用度、通道、会话、在等你答复、点名」被拆成七条，
 * 读起来像点名册。下面这几条原文都取自 `data/events/*.jsonl`。
 */
describe('分段 · 顿号不再是切分点', () => {
  test('列举项留在同一条里，逗号照旧断', () => {
    const table: Array<[string, string[]]> = [
      ['时刻、本机、用度、通道、会话', ['时刻、本机、用度、通道、会话']],
      ['苹果、梨、桃、杏，都摆在摊子上了', ['苹果、梨、桃、杏', '都摆在摊子上了']],
      // seq 2225：「最常用的还是读、改、跑这三摊」——修之前断成「读」「改」「跑这三摊」
      ['数一遍是二十四件，八大类，都列全了\n最常用的还是读、改、跑这三摊',
        ['数一遍是二十四件', '八大类', '都列全了', '最常用的还是读、改、跑这三摊']],
      // seq 4600：口吃式的「又、又来」——修之前断成「又」+「又来」
      ['又、又来！谁准你一口一个可爱了', ['又、又来！谁准你一口一个可爱了']],
      // seq 5869：I10、I11 是并列的两条编号，拆开就剩一个孤零零的「I10」
      ['就是你让我等的那两条，I10、I11 的改动',
        ['就是你让我等的那两条', 'I10、I11 的改动']],
      // seq 1854：引号里的并列项「在哪、是谁、吃什么」同属一口气
      ['所以你问我"在哪、是谁、吃什么"，我答的是同一个东西',
        ['所以你问我"在哪、是谁、吃什么"', '我答的是同一个东西']],
    ];
    for (const [source, want] of table) {
      const got = splitForChat(source);
      assert.deepEqual(got, want, `顿号处不该断开：${JSON.stringify(source)}`);
      assertSubstringsInOrder(got, source);
      for (const seg of got) {
        assert.ok(!seg.startsWith('、'), `顿号不该起头：${JSON.stringify(seg)}`);
      }
    }
  });

  test('顿号也不会被"段末收尾"削掉：它现在与问号同级（不摘）', () => {
    // 修之前 `trimTail` 把段末的顿号吃掉，`苹果、梨` 会变成 `苹果` —— 白丢一个标点
    assert.equal(splitForChat('苹果、梨、桃、杏，都摆在摊子上了')[0], '苹果、梨、桃、杏');
  });
});

/**
 * ② 太短不拆（用户定的线：**不足 12 字不拆**）。
 *
 * 线下面的短句拆开实测很难看：「好，不说了。」→「好」「不说了」（seq 2842）。
 * 字数按**中文计字口径**数（`charCount`）：一个字算一个，emoji 也算一个。
 */
describe('分段 · 太短不拆（不足 12 字整段一条）', () => {
  test('11 / 12 / 13 字三条边界', () => {
    // 11 字（线下面）：整段一条，里面的逗号也不摘
    const eleven = '一二三四五，六七八九十';
    assert.equal(charCount(eleven), 11);
    assert.deepEqual(splitForChat(eleven), [eleven]);

    // 12 字：够长了，逗号照旧断
    const twelve = '一二三四五，六七八九十甲';
    assert.equal(charCount(twelve), 12);
    assert.deepEqual(splitForChat(twelve), ['一二三四五', '六七八九十甲']);

    // 13 字：同上
    const thirteen = '一二三四五，六七八九十甲乙';
    assert.equal(charCount(thirteen), 13);
    assert.deepEqual(splitForChat(thirteen), ['一二三四五', '六七八九十甲乙']);
  });

  test('历史日志里被硬拆过的短句（seq 2842 / 4700 / 5067）现在整段一条', () => {
    const table: Array<[number, string]> = [
      [2842, '好，不说了。'],
      [4700, '嗨。找我什么事，说吧。'],
      [5067, '嗯，停着呢。'],
    ];
    for (const [seq, source] of table) {
      assert.ok(charCount(source) < SPLIT_MIN_CHARS, `seq ${seq} 本来就短于 ${SPLIT_MIN_CHARS} 字`);
      assert.deepEqual(splitForChat(source), [source], `seq ${seq} 不该被拆`);
    }
  });

  test('计数口径：一个字算一个（增补平面字符也算一个，不按 UTF-16 码元数）', () => {
    // 十个「𠮷」= 10 字（`length` 会数成 20）→ 仍在 12 字线下面
    const astral = '𠮷'.repeat(10);
    assert.equal(astral.length, 20, '按码元数是 20');
    assert.equal(charCount(astral), 10, '按中文计字口径是 10');
    assert.deepEqual(splitForChat(astral), [astral]);

    assert.equal(SPLIT_MIN_CHARS, 12, '这条线是用户定的，改动必须是有意的');
  });
});

/**
 * ③ 成对符号保护：内部不许切；嵌套按栈配对；**配不齐就保守**（整篇不拆）。
 */
describe('分段 · 成对符号保护（内部不切 / 嵌套 / 未闭合保守）', () => {
  /** 每一对都长过 12 字，所以"没被切开"不可能是"太短不拆"兜住的 */
  const protectedCases: Array<[string, string, string[] | null]> = [
    // [名字, 原文, 期望分段；null = 必须整段一条]
    ['括号', `他说（${'甲'.repeat(14)}，${'乙'.repeat(14)}）就走了`, null],
    ['引号', `他喊“${'甲'.repeat(14)}，${'乙'.repeat(14)}”就没声了`, null],
    ['书名号', `他翻《${'甲'.repeat(14)}，${'乙'.repeat(14)}》看了半天`, null],
    ['嵌套两层', `他说（外面「${'甲'.repeat(12)}，${'乙'.repeat(12)}」这一层）就行了`, null],
    ['嵌套三层', `他说（外「中『${'甲'.repeat(10)}，${'乙'.repeat(10)}』层」面）就行了`, null],
    ['中英混用括号', `他说（${'甲'.repeat(14)}，${'乙'.repeat(14)})就行了`, null],
    // 方括号那一条整体长过上限，所以允许在**括号外**的空格处断；要验的是括号没被劈开
    ['方括号', `我收到的只有一行 [image/jpeg: ${'甲'.repeat(10)}.jpg] 加个临时链接`,
      ['我收到的只有一行', `[image/jpeg: ${'甲'.repeat(10)}.jpg] 加个临时链接`]],
  ];

  test('成对符号内部一个切点都不许有', () => {
    for (const [name, text, want] of protectedCases) {
      const out = splitForChat(text);
      if (want === null) assert.deepEqual(out, [text], `${name}：内部不该被切开`);
      else assert.deepEqual(out, want, `${name}：只许在括号外的空格处断`);
      assertSubstringsInOrder(out, text);
      assert.ok(pairsBalanced(text), `${name}：这一条本身是配齐的，走的应该是保护而不是保守`);
    }
  });

  test('方括号不被劈成两条（实测 seq 3989/3991 那种切法）', () => {
    const text = '我收到的只有一行 [image/jpeg: 哈希.jpg] 加个临时链接，画面本身没进来呀。';
    const out = splitForChat(text);
    assert.deepEqual(out, ['我收到的只有一行', '[image/jpeg: 哈希.jpg] 加个临时链接', '画面本身没进来呀']);
    for (const seg of out) {
      assert.ok(!(seg.includes('[') && !seg.includes(']')), `不许留下只开不闭的方括号：${JSON.stringify(seg)}`);
      assert.ok(!seg.startsWith('.'), `下一段不许以扩展名的点起头：${JSON.stringify(seg)}`);
    }
  });

  test('括号外的逗号照旧断，括号里的不断', () => {
    // 与上面那组对照：保护的是括号**内部**，出了括号该断还是断
    const text = '摊子上有（钱袋、草帽、旧银币）三样，他挑了半天';
    assert.deepEqual(splitForChat(text), ['摊子上有（钱袋、草帽、旧银币）三样', '他挑了半天']);
  });

  test('未闭合就保守：整篇不拆（宁可一次说完，也不切进括号里）', () => {
    const unclosed: Array<[string, string]> = [
      ['只有左括号', `他说（${'甲'.repeat(14)}，${'乙'.repeat(14)}就行了`],
      ['只有右括号', `他说${'甲'.repeat(14)}，${'乙'.repeat(14)}）就行了`],
      ['只有左引号', `他喊“${'甲'.repeat(14)}，${'乙'.repeat(14)}就没声了`],
      ['左括号没闭、引号闭了', `他说（外面「${'甲'.repeat(12)}，${'乙'.repeat(12)}」这一层就行了`],
      ['交叉闭合', `他说（${'甲'.repeat(14)}「${'乙'.repeat(14)}）${'丙'.repeat(14)}」`],
      ['张冠李戴', `他说（${'甲'.repeat(14)}，${'乙'.repeat(14)}]就算了`],
    ];
    for (const [name, text] of unclosed) {
      assert.equal(pairsBalanced(text), false, `${name}：这一条本该判成配不齐`);
      assert.deepEqual(splitForChat(text), [text], `${name}：配不齐时整篇不拆`);
    }
    // 对照：同样的长度，把括号配齐了就会断——证明上面"不拆"是保守规则干的，不是长度兜住的
    const balanced = `他说（${'甲'.repeat(14)}）${'乙'.repeat(14)}，${'丙'.repeat(14)}`;
    assert.ok(pairsBalanced(balanced));
    assert.ok(splitForChat(balanced).length > 1, `配齐了就该正常断：${JSON.stringify(splitForChat(balanced))}`);
  });

  test('pairsBalanced 的判据：栈式配对、嵌套算配齐、张冠李戴算配不齐', () => {
    assert.equal(pairsBalanced('（甲）'), true);
    assert.equal(pairsBalanced('（甲「乙」丙）'), true, '嵌套算配齐');
    assert.equal(pairsBalanced('（甲「乙）丙」'), false, '交叉闭合不算配齐');
    assert.equal(pairsBalanced('（甲'), false);
    assert.equal(pairsBalanced('甲）'), false);
    assert.equal(pairsBalanced('（甲]'), false, '用 ] 闭 （ 是张冠李戴');
    assert.equal(pairsBalanced('（甲)'), true, '中文左配半角右算一族（实测混写很常见）');
    assert.equal(pairsBalanced('《甲》'), true);
    assert.equal(pairsBalanced('【甲】'), true);
    assert.equal(pairsBalanced('〔甲〕'), true);
    assert.equal(pairsBalanced('『甲』'), true);
    assert.equal(pairsBalanced('“甲”'), true);
    assert.equal(pairsBalanced('没有成对符号'), true);
  });
});

describe('分段 · 两条保护', () => {
  test('成对符号内部不切（括号里那句话是一个整体）', () => {
    const text = '他说（这个，那个）就行了';
    assert.deepEqual(splitForChat(text), [text]);
  });

  test('代码块整段保留', () => {
    // 回归锁：曾经在外面先按行预切，导致 cutLine 再也认不出 ``` 围栏，代码被逗号切碎
    const code = '```\nconst a = 1，const b = 2\n```';
    assert.deepEqual(splitForChat(code), [code]);
  });
});

describe('分段 · 不切碎英文标识符（server.ts 的教训）', () => {
  test('文件名、版本号、域名、URL 都不在点号处断开', () => {
    // 实测：界面里出现过孤零零的两条「改的是 server」与「ts」——
    // ASCII 句点被当成句末，把扩展名切掉了
    for (const text of ['server.ts', 'v1.2', 'example.com', 'http://127.0.0.1:7788/api']) {
      assert.deepEqual(splitForChat(text), [text], `「${text}」不该被切开`);
    }
    assert.deepEqual(splitForChat('这个版本 1.2 已经发布了。'), ['这个版本 1.2 已经发布了'], '点号不是句末');
    // 连长度也拦不住：点号仍然不是断点（11 字以下由"太短不拆"兜着，所以这里挑长的）
    assert.deepEqual(
      splitForChat('你那个 server.ts 行号全飘了，我改成按搜索定位了'),
      ['你那个 server.ts 行号全飘了', '我改成按搜索定位了'],
    );
  });

  test('真实案例：扩展名完整；破折号在**切完之后**才化开（用户 2026-10-02 更正）', () => {
    const text = '说认知的话，我分三层。\n第一层是现场——你正在这台机器上改代码，改的是 server.ts。';
    // `——` 在切分时**不算断点**（连接号两边同一口气）→ 分段与旧口径一致；
    // 切完再把它换成随机标点（这里注入 0 = 权重最大的「，」）
    const out = splitForChat(text, { random: () => 0 });
    assert.deepEqual(out, [
      '说认知的话',
      '我分三层',
      '第一层是现场，你正在这台机器上改代码',
      '改的是 server.ts',
    ]);
    assert.ok(!out.some((seg) => seg.includes('——')), '破折号不该留在发出去的话里');
    assert.ok(out.some((seg) => seg.endsWith('server.ts')), '扩展名仍要完整');
  });

  test('长到超过上限时，也不从词中间劈开（同一句话逗号不断的形态）', () => {
    const text = '第一层是现场，你正在这台机器上改代码，改的是 server.ts';
    const out = splitForChat(text);
    assert.ok(out.length > 1, '这句该长到需要断开');
    assert.ok(out.some((seg) => seg.endsWith('server.ts')), `扩展名要完整留着，实际：${JSON.stringify(out)}`);
    assert.ok(!out.some((seg) => seg.trim() === 'ts'), '不该切出孤零零的 ts');
  });

  test('词中间不下刀：`[image/jpeg: 哈希 | .jpg]` 那种切法（实测 seq 3986）已经没了', () => {
    // 她真说过的一句：修之前被切成「[image/jpeg: 哈希」+「.jpg] 加个临时链接」，
    // 方括号被劈成两条消息——这正是用户说的"不能中间断开"
    const text = '我收到的只有一行 [image/jpeg: 哈希.jpg] 加个临时链接，画面本身没进来呀。';
    const out = splitForChat(text);
    assert.ok(out.some((seg) => seg.includes('[image/jpeg: 哈希.jpg]')),
      `方括号那一整段要留在同一条里，实际：${JSON.stringify(out)}`);
    for (const seg of out) {
      assert.ok(!(seg.includes('[') && !seg.includes(']')), `不许留下只开不闭的括号：${JSON.stringify(seg)}`);
    }
  });

  test('ASCII 的 ! ? ; 与冒号同样不当断点（命令与键值对里到处都是）', () => {
    const parts = splitForChat('npm run build; npm test');
    assert.equal(parts.join(' '), 'npm run build; npm test', '拼接后原文不变');
    assert.ok(!parts.includes(';'), '分号不该单独成条');
    assert.ok(!parts.some((seg) => seg.startsWith(';')), `分号不该起头：${JSON.stringify(parts)}`);
    assert.deepEqual(splitForChat('key: value'), ['key: value'], '冒号不是停顿');
  });
});

describe('分段 · 超长的一段', () => {
  test('没有断点就不硬切：宁可整段留下，也不从词中间劈开', () => {
    // 实测切出过「…拆成 29 | 条全发出去了」与「你能看 | 见的只是对话流」
    const long = '那'.repeat(30);
    assert.deepEqual(splitForChat(long), [long]);
  });

  test('汉字与英文/数字的交界是兜底断点，但两边都要成词', () => {
    const mixed = `${'那'.repeat(15)}ABC${'么'.repeat(15)}`;
    const out = splitForChat(mixed);
    assert.ok(out.length > 1, '交界是兜底断点，不该让一条长到离谱');
    assert.ok(out[0]!.endsWith('那'.repeat(15)), `在交界处断开，实际：${JSON.stringify(out)}`);
    assert.equal(out.join(''), mixed, '断开处不丢字');
    // 反过来：交界一侧只有一个字符时不算断点（旧规则会切出「在的 | 。」这种）
    const thin = `${'那'.repeat(25)}A`;
    assert.deepEqual(splitForChat(thin), [thin], '右边只有一个字符 → 不认这个交界');
  });

  test('有空格时在空格处断开（但空格后还是汉字就不算边界）', () => {
    // 空格后是 ASCII（真正的词边界）：可以在那儿断
    const spaced = `${'那'.repeat(15)} ABC${'么'.repeat(10)}`;
    const out = splitForChat(spaced);
    assert.ok(out.length > 1, `该在空格处断开：${JSON.stringify(out)}`);
    assert.equal(out.join(''), spaced.replace(' ', ''), '断开处除空格外不丢字');

    // 空格后还是汉字：那是中英混排的习惯性空格，不是词边界——
    // 在那儿切会切出「slice、I11 | 的 data/events」这种把定语劈开的形态
    const cjkAfter = `${'那'.repeat(15)} 么${'么'.repeat(10)}`;
    assert.deepEqual(splitForChat(cjkAfter), [cjkAfter], '空格两边都是汉字 → 不当断点');
  });
});

describe('分段 · 破折号化开（用户 2026-10-02 的口径）', () => {
  test('「——」按加权随机换成 ，/~ /.../。/！，越往后越少见', () => {
    // 权重表 40/25/15/12/8：用确定的随机源逐个命中每一档（roll 落在哪一段就取哪个）
    const table = ['，', '~', '...', '。', '！'];
    const rolls = [0, 0.4, 0.65, 0.8, 0.92];
    for (const [index, roll] of rolls.entries()) {
      const out = softenDashes('不要这样——我说过了', () => roll);
      assert.equal(out, `不要这样${table[index]}我说过了`, `roll=${roll} 应落到「${table[index]}」`);
    }
  });

  test('分布确实是递减的（不是均匀随机）', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      const out = softenDashes('a——b');
      counts.set(out.slice(1, -1), (counts.get(out.slice(1, -1)) ?? 0) + 1);
    }
    const order = ['，', '~', '...', '。', '！'];
    const seen = order.map((mark) => counts.get(mark) ?? 0);
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(seen[i]! <= seen[i - 1]!, `「${order[i]}」不该比「${order[i - 1]}」更常见：${JSON.stringify(seen)}`);
    }
    assert.ok(seen[0]! > seen[4]! * 2, `首尾差距要明显（40 vs 8）：${JSON.stringify(seen)}`);
  });

  test('代码块与 ASCII 连字符一律不动', () => {
    const fenced = '看这段\n```\nnpm run build -- --watch\n// a——b\n```\n就这样';
    assert.equal(softenDashes(fenced), fenced, '围栏里是她的原文，改写等于篡改');
    assert.equal(softenDashes('用 --flag 跑 pwsh -NoProfile'), '用 --flag 跑 pwsh -NoProfile', 'ASCII 连字符是词的一部分');
  });
});
