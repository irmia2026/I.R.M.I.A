/**
 * 断点定位：把"有档案"与"无档案"两份请求渲染出来，找**第一个字节不同**的位置。
 *
 * 想回答的问题：关系档案首轮注入，到底截断了多少前缀？
 * 若断点落在「此刻层」（input 尾部那一条），说明档案的变化只影响尾部——
 * 而尾部本来就每轮都变（时刻在里面），边际成本 ≈ 0。
 * 若断点落在历史段中间，那才是真破坏。
 *
 * 用法：node scripts/where-is-the-break.mjs [dataDir]
 */
import { readdirSync, readFileSync } from 'node:fs';

const dataDir = process.argv[2] ?? 'data';
// 档案属于谁：由使用者的联系人表决定，脚本里不写死某个具体的人。要查别人就把这一行换掉。
const OWNER = 'OWNER';
const { render } = await import('../dist/model/render.js');
const { loadPersona, loadRelationship } = await import('../dist/persona/loader.js');

const dir = `${dataDir}/events`;
const events = [];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
}
events.sort((a, b) => a.seq - b.seq);

const persona = loadPersona(dataDir);
const wake = events.find((e) => e.type === 'wake/manual' && e.data.person === OWNER);
if (!wake) {
  console.log('日志里没有带人的手动唤醒');
  process.exit(0);
}

const content = loadRelationship(dataDir, OWNER);
const base = {
  events: events.filter((e) => e.seq < wake.seq),
  persona,
  tools: [],
  wakeEvent: wake,
  taskCard: null,
  now: wake.ts,
  timezone: 'Asia/Shanghai',
  model: 'deepseek-flash',
  lane: 'heavy',
  contact: { qqOfficial: true, onebot: false, alertWebhook: false, wakeChannel: null },
};

const withRel = render({ ...base, persona: { ...persona, relationship: { who: OWNER, content } } });
const without = render({ ...base, persona: { ...persona, relationship: null } });

const key = (it) => JSON.stringify(it);
let cut = 0;
while (cut < withRel.input.length && cut < without.input.length && key(withRel.input[cut]) === key(without.input[cut])) {
  cut += 1;
}

const brief = (it) => {
  if (it.type === 'message') return `${it.role}「${it.content.replace(/\s+/g, ' ').slice(0, 46)}」`;
  if (it.type === 'function_call') return `call ${it.name}`;
  if (it.type === 'function_call_output') return `output ${it.output.replace(/\s+/g, ' ').slice(0, 30)}`;
  if (it.type === 'reasoning') return 'reasoning';
  return it.type;
};

console.log(`唤醒：seq ${wake.seq} @ ${wake.ts}（person=${wake.data.person}）`);
console.log(`两条请求的 input 条数：有档案 ${withRel.input.length} / 无档案 ${without.input.length}`);
console.log(`公共前缀：前 ${cut} 条逐字节相同\n`);

console.log('有档案那一条的 input 结构：');
withRel.input.forEach((it, i) => {
  const mark = i === cut ? '  ← 第一个不同的位置' : '';
  console.log(`  ${String(i).padStart(3)}  ${brief(it)}${mark}`);
});

const cutItem = withRel.input[cut];
// 此刻层判据（v23）：它以段头两行开头（18 个破折号 + 「以下为框架提供的此刻层」）。
// 这里硬编那半行而不是导入常量：本脚本是 .mjs，不进 TS 编译（改了模板请连同这一行一起改）。
const NOW_LAYER_MARK = `${'—'.repeat(18)}以下为框架提供的此刻层`;
const isNowLayer = cutItem?.type === 'message'
  && cutItem.role === 'developer'
  && typeof cutItem.content === 'string'
  && cutItem.content.startsWith(NOW_LAYER_MARK);
console.log(`\n断点落在：${cutItem ? brief(cutItem).slice(0, 60) : '（无，两请求等价）'}`);
console.log(isNowLayer
  ? '结论：断点=此刻层（尾部）。档案只影响尾部，而尾部每轮都变（时刻在里面），边际成本≈0。'
  : '结论：断点不在此刻层——需要进一步查（历史段被截断了）。');

const relIndex = withRel.input.findIndex((it) => it.type === 'message' && it.content.includes('[关系档案'));
console.log(`档案所在的 item 序号：${relIndex}（总 ${withRel.input.length} 条，倒数第 ${withRel.input.length - relIndex} 条）`);
