/**
 * MCP 声明面**热加载**测试（2026-10-10；用户问的「配置的 mcp 不能热加载吗？」）
 *
 * ──────────────────────────── 这一份钉的是什么 ────────────────────────────
 *
 * 改 `config.json` 的 `mcp.servers`（或 `mcp.extraLaunchers`）**不重启**即可生效。
 * 它由四段组成，每段各自有一条"判据错了就会静默骗人"的地方：
 *
 *   ① **触发与生效**（`config/watcher.ts`）：白名单里只有 `mcp.servers`；热更**就地**改
 *      活的那个 `AppConfig`（不是换一个新对象——换对象等于持有引用的 RealLoop / WebServer
 *      继续读旧配置，那正是"保存后弹回旧值"的形状）；名单外的字段照旧只写 warning。
 *   ② **粒度**（`McpClientPool.applyDeclarations`）：只重连**真变了**的那几个 server，
 *      没变的一个字节都不动（不清运维账、不打断在飞调用）。
 *   ③ **失败回退安全**：解析失败的配置**根本进不来** ⇒ 旧配置继续跑，只留一行诊断；
 *      写坏了配置文件不会把活实例搞死。
 *   ④ **索引刻意不立刻变**：`mcp.servers` 进上下文的那一格是常驻索引，它按既有快照机制
 *      在重大变化点归集——热更**不改它的字节**（改了就是每轮请求前缀失配 = 缓存整段失效）。
 *      这里钉的是"热更之后 `config.mcp.servers` 立刻是新值"这一半，
 *      另一半（索引字节不动）由 `test/mcp-index.test.ts` 的既有用例钉住。
 *
 * ──────────────────────────── 纪律 ────────────────────────────
 *
 * · **不起任何真进程**：池的 `spawner` 注入假进程（这一份测的是"哪些 server 被重连了"，
 *   不是 MCP 协议本身——协议那部分是 `test/mcp-client.test.ts` 的案子）；
 * · **不碰仓库里的任何文件**：全部在临时目录里跑；
 * · **不靠 fs.watch 的时序**：文件监听那一层（去抖 / 轮询 / 串行）按判据由
 *   `reloadNow()`（同一份 `reloadOnce` 逻辑）驱动 —— 时序本身不是这一份要测的东西，
 *   把它混进来只会让用例在慢盘上随机变红。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { CONFIG_FILE_NAME, loadConfig } from '../src/config/config.ts';
import {
  ConfigWatcher,
  HOT_RELOAD_FIELDS,
  RESTART_REQUIRED_FIELDS,
  applyHotFieldsInPlace,
  classifyConfigField,
  type ConfigChange,
} from '../src/config/watcher.ts';
import {
  McpClientPool,
  McpConnection,
  mcpEntryConnectionKey,
  mcpEntryContentKey,
  type McpProcess,
  type McpProcessSpawner,
  type McpServerEntry,
} from '../src/mcp/client.ts';

// ──────────────────────────────── 脚手架 ────────────────────────────────

async function freshDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'irmia-mcp-hot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return resolve(dir);
}

function writeRawConfig(dir: string, value: unknown): Promise<void> {
  return writeFile(join(dir, CONFIG_FILE_NAME), JSON.stringify(value, null, 2), 'utf8');
}

/**
 * 假进程：只够池认出"有一个活着的连接"，绝不应答任何 JSON-RPC。
 *
 * 这一份的用例只关心**声明面**（哪些 server 被重连了），握手成功与否不在判据里
 * （`applyDeclarations` 不握手——它只换表与收连接）。
 */
function fakeProcess(pid: number, onKill?: () => void): McpProcess {
  return {
    pid,
    onStdout() {},
    onStderr() {},
    onExit() {},
    write() {},
    closeStdin() {},
    kill() { onKill?.(); },
  };
}

/** 一个只记账的池：`spawner` 返回假进程，`onLog` 收日志（断言"谁被跳过/谁被收掉"） */
function makePool(options: {
  servers: readonly McpServerEntry[];
  dataDir: string;
  logs?: string[];
  killed?: string[];
  events?: string[];
}): McpClientPool {
  let nextPid = 5000;
  const spawner: McpProcessSpawner = (entry) => {
    const pid = nextPid++;
    return fakeProcess(pid, () => { options.killed?.push(entry.name); });
  };
  return new McpClientPool({
    servers: options.servers,
    emit: (type) => { options.events?.push(type); },
    dataDir: options.dataDir,
    onLog: (line) => { options.logs?.push(line); },
    spawner,
    // 采样关掉：这一份不该起任何外部读数进程（Windows 上是 tasklist）
    rssSampler: null,
  });
}

// ──────────────────────── ① 白名单与"就地生效" ────────────────────────

test('① 白名单：只有 `mcp.servers` 是热的；池级两格与其余字段照旧需要重启', () => {
  assert.deepEqual([...HOT_RELOAD_FIELDS], ['mcp.servers'],
    '名单里只该有申报的那一项——顺手多填一项就是一次没被拍板的取舍');

  assert.equal(classifyConfigField('mcp.servers'), 'hot', '声明面是热的');
  // 同段的两格**刻意不热**：它们是建池时的参数（换一份要不要重建采样器、上限要不要重设）
  assert.notEqual(classifyConfigField('mcp.maxInFlight'), 'hot', '池级在飞上限不在热更名单里');
  assert.notEqual(classifyConfigField('mcp.rssSample'), 'hot', 'RSS 采样开关不在热更名单里');
  assert.notEqual(classifyConfigField('mcp.extraLaunchers'), 'hot',
    '放行口本身不是热更字段：它是**解析**的一部分，与 servers 同一份配置、同一次加载里生效');
  // 别的段一个都不许被顺手放进来（它们的代价没人拍过板）
  for (const field of ['budget.softRatio', 'wake.heartbeatFloorMin', 'tools.disabled', 'persona.owner']) {
    assert.notEqual(classifyConfigField(field), 'hot', `${field} 不该在热更名单里`);
  }
  assert.deepEqual([...RESTART_REQUIRED_FIELDS].slice(0, 2), ['dataDir', 'schemaVersion'],
    '需重启那一列照旧（它的次序是文档口径的一部分）');
});

test('① 热更**就地**改活配置：持有引用的消费者（RealLoop / WebServer）当场看见新值', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, {
    mcp: { servers: [{ name: 'a', command: 'node', args: ['a.js'] }] },
  });
  const loaded = await loadConfig(dir);
  // 两个"持有引用的人"（生产上是 RealLoop 的 deps.config 与 WebServer 的 deps.config）
  const heldByLoop = loaded.config;
  const serversArrayHeldByIndex = loaded.config.mcp.servers;

  const next = structuredClone(loaded.config) as typeof loaded.config;
  next.mcp.servers = [
    { name: 'a', command: 'node', args: ['a.js'] },
    { name: 'b', command: 'uvx', args: ['mcp-server-time'] },
  ];
  const merged = applyHotFieldsInPlace(loaded.config, next, ['mcp.servers']);

  assert.equal(merged, loaded.config, '返回的必须是**同一个对象**（换对象 = 引用持有者继续读旧配置）');
  assert.equal(heldByLoop.mcp.servers.length, 2, '持有引用的那一侧当场看见新声明');
  assert.deepEqual(heldByLoop.mcp.servers.map((entry) => entry.name), ['a', 'b']);
  assert.equal(serversArrayHeldByIndex, heldByLoop.mcp.servers,
    '数组本身也是就地改的（有人可能已经抓住了这个数组——例如索引视图）');
  assert.equal(serversArrayHeldByIndex.length, 2);

  // 名单外的字段**一个都不许被顺手改**（那是"热更"与"什么都热更"的分界线）
  next.budget = { ...loaded.config.budget, softRatio: 0.1 };
  applyHotFieldsInPlace(loaded.config, next, ['mcp.servers']);
  assert.notEqual(heldByLoop.budget.softRatio, 0.1, '名单外的字段必须保持旧值');
});

test('① 端到端：改 `mcp.servers` ⇒ 当场生效、写 `config/changed`、通知订阅者、哈希跟着换', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { mcp: { servers: [{ name: 'a', command: 'node' }] } });
  const loaded = await loadConfig(dir);

  const lines: string[] = [];
  const events: Array<{ type: string; data: unknown }> = [];
  const changes: ConfigChange[] = [];
  const watcher = new ConfigWatcher({
    configDir: dir,
    initial: loaded,
    emit: (type, data) => { events.push({ type, data }); },
    out: (line) => { lines.push(line); },
    // 监听那一层在本用例里不起作用（改动由 reloadNow 驱动）：把去抖与轮询压到最小，
    // 免得它在测试期间自己触发一次重载、把断言搅乱
    debounceMs: 0,
    pollMs: 0,
    minIntervalMs: 0,
  });
  t.after(() => { watcher.stop(); });
  watcher.subscribe((change) => { changes.push(change); });

  // ① 同一份文件重复"保存"：没有差异 ⇒ 不写事件、不通知（`config/changed` 的语义是"已生效"）
  assert.equal(await watcher.reloadNow(), null, '没变就不该产生任何副作用');

  // ② 改一条声明（加一个 server）
  await writeRawConfig(dir, {
    mcp: { servers: [{ name: 'a', command: 'node' }, { name: 'b', command: 'uvx' }] },
  });
  const outcome = await watcher.reloadNow();
  assert.ok(outcome !== null, '有差异就该产生一次结局');
  assert.equal(outcome.applied, true, '声明确实热更生效了');
  assert.deepEqual(outcome.fields, ['mcp.servers'], '生效的字段就是那一项');
  assert.deepEqual(outcome.requiresRestart, [], '这一次没有需要重启的字段');

  // 生效事实三件套：事件 + 订阅者 + 指纹
  assert.deepEqual(events.map((item) => item.type), ['config/changed'],
    '`config/changed` 的语义是"已生效"，热更成功就该写它');
  assert.deepEqual(changes.length, 1, '订阅者收到一次');
  assert.equal(changes[0]?.configHash, watcher.effectiveHash, '变更里的指纹与生效指纹同源');
  assert.notEqual(outcome.configHash, loaded.configHash, '配置变了，指纹必须跟着变（那是设计内的代价）');
  assert.equal(outcome.config, loaded.config, '生效配置就是**原来那个对象**（就地改，不换引用）');
  assert.deepEqual(loaded.config.mcp.servers.map((entry) => entry.name), ['a', 'b'],
    '外面持有的那份引用当场就是新声明');

  // ③ 同一段里的池级参数**照旧要重启**：写 warning、不写 config/changed
  const before = events.length;
  await writeRawConfig(dir, {
    mcp: { maxInFlight: 16, servers: [{ name: 'a', command: 'node' }, { name: 'b', command: 'uvx' }] },
  });
  const second = await watcher.reloadNow();
  assert.ok(second !== null);
  assert.equal(second.applied, false, '只有名单外的字段变了 ⇒ 运行中的实例一字未动');
  assert.deepEqual(second.requiresRestart, ['mcp.maxInFlight'], '要点名是哪个字段需要重启');
  assert.equal(events.length, before, '没生效就不许写 `config/changed`');
  assert.match(second.warnings.join('\n'), /需要重启/u);
  assert.equal(loaded.config.mcp.maxInFlight, 8, '生效配置里的旧值保持不动');
});

// ──────────────────────── ② 重建粒度（只动变了的） ────────────────────────

test('② 粒度：按 server 算净效果，只重连真变了的那几个（没变的一个字节都不动）', async (t) => {
  const dir = await freshDir(t);
  const logs: string[] = [];
  const killed: string[] = [];
  const pool = makePool({
    dataDir: dir,
    logs,
    killed,
    servers: [
      { name: 'keep', command: 'node', args: ['keep.js'] },
      { name: 'edit', command: 'node', args: ['old.js'] },
      { name: 'gone', command: 'uvx', args: ['x'] },
    ],
  });

  // 只加一个 server：其余两个的账一格都不许动
  const add = await pool.applyDeclarations([
    { name: 'keep', command: 'node', args: ['keep.js'] },
    { name: 'edit', command: 'node', args: ['old.js'] },
    { name: 'gone', command: 'uvx', args: ['x'] },
    { name: 'fresh', command: 'uvx', args: ['y'] },
  ]);
  assert.deepEqual(add, { added: ['fresh'], removed: [], changed: [], unchanged: ['keep', 'edit', 'gone'] });
  assert.deepEqual(pool.status().map((row) => row.name), ['keep', 'edit', 'gone', 'fresh'],
    '池的声明面换成新的那一份了');

  // 一次改一条 + 删一条：净效果三格各自对得上，**且只收掉真变了/真删了的那两个**
  const edit = await pool.applyDeclarations([
    { name: 'keep', command: 'node', args: ['keep.js'] },
    { name: 'edit', command: 'node', args: ['new.js'] },
    { name: 'fresh', command: 'uvx', args: ['y'] },
  ]);
  assert.deepEqual(edit, { added: [], removed: ['gone'], changed: ['edit'], unchanged: ['keep', 'fresh'] },
    '顺序即事实：added/changed 按新声明的次序、removed 按旧声明的次序');
  // `gone` 从来没被拉起过（这一份用例不起真连接）⇒ 收不到的就不该出现在 killed 里
  assert.deepEqual(killed, [], '没连过的 server 被删掉时不该有任何进程动作');

  // 只调次序：字段变了但每个 server 的内容都没变 ⇒ 三格全空
  const reorder = await pool.applyDeclarations([
    { name: 'fresh', command: 'uvx', args: ['y'] },
    { name: 'keep', command: 'node', args: ['keep.js'] },
    { name: 'edit', command: 'node', args: ['new.js'] },
  ]);
  assert.deepEqual(reorder, { added: [], removed: [], changed: [], unchanged: ['fresh', 'keep', 'edit'] },
    '次序不算内容变化（否则一次无关的排序会重连整个池、还会白叫她一次）');
});

test('② 内容指纹：键序无关；但 `disabled` / 三属性 / 两格覆盖这些真变化一个都不许漏', () => {
  const base: McpServerEntry = { name: 'x', command: 'node', args: ['a.js'], env: { A: '1', B: '2' } };
  // 键序无关：同一份声明怎么写都算出同一串（否则重新保存一次就会假重连）
  assert.equal(
    mcpEntryContentKey(base),
    mcpEntryContentKey({ env: { B: '2', A: '1' }, args: ['a.js'], command: 'node', name: 'x' }),
    '键序不算变化',
  );
  // 真变化（每一格都是"改了它就该重连"的那种）
  const mutations: Array<[string, McpServerEntry]> = [
    ['command', { ...base, command: 'uvx' }],
    ['args', { ...base, args: ['b.js'] }],
    ['cwd', { ...base, cwd: '/tmp' }],
    ['env 的值', { ...base, env: { A: '1', B: '3' } }],
    ['env 多一个键', { ...base, env: { A: '1', B: '2', C: '3' } }],
    ['disabled', { ...base, disabled: true }],
    ['desc', { ...base, desc: '它是干什么的' }],
    ['requestTimeoutMs', { ...base, requestTimeoutMs: 5000 }],
    ['idleReclaimMs', { ...base, idleReclaimMs: 1000 }],
    ['maxInFlight', { ...base, maxInFlight: 2 }],
    ['toolsCache', { ...base, toolsCache: false }],
    ['toolDefaults', { ...base, toolDefaults: { sideEffect: 'none' } }],
    ['tools', { ...base, tools: { echo: { sideEffect: 'none' } } }],
  ];
  for (const [what, mutated] of mutations) {
    assert.notEqual(mcpEntryContentKey(base), mcpEntryContentKey(mutated),
      `${what} 变了就该被判成"声明变了"（否则改完不重连 = 配了却不生效）`);
  }

  /**
   * **`desc` 是"报成变了"与"值得重连"之间唯一的那一格**（2026-10-11 加）：
   * 它只影响索引那一行的渲染，与"那个进程怎么起"无关 ⇒ 值得通报她，不值得把连接收掉重连。
   * 这两条断言合起来就是那条判据的全文（`mcpEntryConnectionKey` = contentKey 去掉 desc）。
   */
  const withDesc: McpServerEntry = { ...base, desc: '一句说明' };
  assert.notEqual(mcpEntryContentKey(base), mcpEntryContentKey(withDesc),
    '只改 desc 也算一次声明变更（索引那一行会变，要通报她）');
  assert.equal(mcpEntryConnectionKey(base), mcpEntryConnectionKey(withDesc),
    '但**不值得**为一句说明重连（白付一次冷启动、还会打断在飞调用）');
  // 反证：`desc` 之外的任何一格变了，connectionKey 必须跟着变（否则"改了声明却不重连"）
  for (const [what, mutated] of mutations) {
    if (what === 'desc') continue;
    assert.notEqual(mcpEntryConnectionKey(base), mcpEntryConnectionKey(mutated),
      `${what} 变了却不重连 = 配了却不生效`);
  }
  // 键序无关对 connectionKey 同样成立（否则重新保存一次 env 就会假重连）
  assert.equal(
    mcpEntryConnectionKey(base),
    mcpEntryConnectionKey({ desc: undefined, env: { B: '2', A: '1' }, args: ['a.js'], command: 'node', name: 'x' }),
    '键序不算变化（connectionKey 也按同一把尺子）',
  );
});

// ──────────────────────── ③ 失败回退安全 ────────────────────────

test('③ 写坏的配置：保留旧配置继续跑 + 如实报错；活实例一个字都不动', async (t) => {
  const dir = await freshDir(t);
  const good = { mcp: { servers: [{ name: 'a', command: 'node' }], extraLaunchers: [] } };
  await writeRawConfig(dir, good);
  const loaded = await loadConfig(dir);

  const lines: string[] = [];
  const events: string[] = [];
  let loads = 0;
  const watcher = new ConfigWatcher({
    configDir: dir,
    initial: loaded,
    emit: (type) => { events.push(type); },
    out: (line) => { lines.push(line); },
    debounceMs: 0,
    pollMs: 0,
    minIntervalMs: 0,
    // 注入一个会抛的加载器：模拟"文件被写坏了"（真实那条路上抛的是 ConfigError：
    // 非法 JSON / 非法形状 / 启动器不在白名单里 —— 三种都在 loadConfig 这一层拦下）
    load: async (configDir: string) => {
      loads += 1;
      if (loads === 1) throw new Error('配置文件不是合法 JSON（现场模拟）');
      return await loadConfig(configDir);
    },
  });
  t.after(() => { watcher.stop(); });

  const failed = await watcher.reloadNow();
  assert.equal(failed, null, '加载失败不产生结局（没有"生效了什么"可说）');
  assert.deepEqual(events, [], '失败不许写 `config/changed`（那个事件的语义是"已生效"）');
  assert.match(lines.join('\n'), /重载失败，继续用上一份生效配置/u, '要如实说清"继续用旧的"');
  assert.match(lines.join('\n'), /不是合法 JSON/u, '原因要原样带出来（不然没法施救）');
  assert.equal(watcher.effectiveConfig, loaded.config, '生效配置还是原来那一份（对象都没换）');
  assert.equal(watcher.effectiveHash, loaded.configHash, '指纹也是原来那一份');
  assert.deepEqual(loaded.config.mcp.servers.map((entry) => entry.name), ['a'], '活配置一字未动');

  // 文件修好之后，同一条路照旧能热更（一次失败不会把热更功能永久搞坏）。
  // **要真改一个字节**：从"失败"恢复不是靠"再读一次就成功"，而是靠"这份配置现在真的不一样了"
  // ——只把文件写回原样，`diffConfigFields` 会说"没变"，那也返回 null（那是另一条判据：没变就不生效）。
  await writeRawConfig(dir, {
    mcp: { servers: [{ name: 'a', command: 'node' }, { name: 'b', command: 'uvx' }], extraLaunchers: [] },
  });
  const healed = await watcher.reloadNow();
  assert.ok(healed !== null, '修好之后要能重新热更');
  assert.equal(healed.applied, true);
  assert.deepEqual(loaded.config.mcp.servers.map((entry) => entry.name), ['a', 'b'],
    '恢复之后新声明照旧就地生效');
});

test('③ 放行口缺失那一类也在同一层被挡下（坏配置进不到池里）', async (t) => {
  const dir = await freshDir(t);
  await writeRawConfig(dir, { mcp: { servers: [{ name: 'a', command: 'node' }] } });
  const loaded = await loadConfig(dir);
  const lines: string[] = [];
  const watcher = new ConfigWatcher({
    configDir: dir,
    initial: loaded,
    emit: () => {},
    out: (line) => { lines.push(line); },
    debounceMs: 0,
    pollMs: 0,
    minIntervalMs: 0,
  });
  t.after(() => { watcher.stop(); });

  // `irmia-test-launcher` 既不在默认表里、也没写进 `mcp.extraLaunchers` ⇒ loadConfig 当场抛
  // ⚠️ 这个名字是**刻意自造的**：拿现场真在用的启动器当"不在表里"的例子会随默认表一起漂
  //    ——哪天有人把它收进默认表，这条用例就**静默变成一条假绿**（实测过：2026-10-11
  //    有人把 `obscura` 收进默认表，这一格的断言当场反过来）。自造名字不会被任何人收进去。
  await writeRawConfig(dir, { mcp: { servers: [{ name: 'a', command: 'irmia-test-launcher' }] } });
  assert.equal(await watcher.reloadNow(), null, '启动器不在白名单里 ⇒ 这一份配置根本进不来');
  assert.match(lines.join('\n'), /不在白名单里/u, '原因要如实带出来');
  assert.match(lines.join('\n'), /继续用上一份生效配置/u);
  assert.deepEqual(loaded.config.mcp.servers.map((entry) => entry.command), ['node'],
    '"半份坏声明"不可能出现在池里——池读的就是这一份生效配置');

  // 把放行口写上去：同一条声明当场合法，热更生效（**不用重启、也不用设环境变量**）
  await writeRawConfig(dir, {
    mcp: { extraLaunchers: ['irmia-test-launcher'], servers: [{ name: 'a', command: 'irmia-test-launcher' }] },
  });
  const outcome = await watcher.reloadNow();
  assert.ok(outcome !== null, '写了放行口之后这份配置就该进来');
  assert.equal(outcome.applied, true);
  assert.deepEqual(loaded.config.mcp.servers.map((entry) => entry.command), ['irmia-test-launcher'],
    '新的那条声明当场生效');
  /**
   * ⚠️ **放行口那一格本身不在热更名单里**，而这一条是判据、不是遗漏：
   *
   * `mcp.extraLaunchers` 只参与**解析**（`checkStdioLauncher` 的第三个来源）——解析成功之后，
   * 那个名字已经被"用掉"了，运行期没有任何一处还会去看它。所以：
   *   · 改它**不会**让一条**已经被拒**的声明通过（那份配置根本进不来，见上面那半段）；
   *   · 它跟着**下一次**解析生效（改 `servers` / 重启 / 下一次热更都算一次解析）；
   *   · 把它也塞进 `HOT_RELOAD_FIELDS` 只会多出一条"生效了但什么都不影响"的假事件。
   * 于是这里如实钉住：它进了 `requiresRestart`（对**已经跑起来**的实例而言，它确实要重启才"进入生效配置"）。
   */
  assert.deepEqual(outcome.requiresRestart, ['mcp.extraLaunchers'],
    '放行口不是热更字段：它只在解析那一刻起作用，运行期没有消费者');
  assert.deepEqual(loaded.config.mcp.extraLaunchers, [],
    '生效配置里那一格保持旧值（它不影响任何运行期行为）');
});

// ──────────────────────── ② 池的边界（不许把坏东西吃进来） ────────────────────────

test('② 池的边界：非法/重复名字只跳过它自己，绝不因此把池搞坏', async (t) => {
  const dir = await freshDir(t);
  const logs: string[] = [];
  const pool = makePool({ dataDir: dir, logs, servers: [{ name: 'a', command: 'node' }] });

  const change = await pool.applyDeclarations([
    { name: 'a', command: 'node' },
    { name: '有中文', command: 'node' },   // 名字不合规（界面写错时的那一类）
    { name: 'b', command: '' },            // command 空
    { name: 'c', command: 'uvx' },
    { name: 'c', command: 'uvx' },         // 重复
  ]);
  assert.deepEqual(change.added, ['c'], '合法的照旧进来');
  assert.deepEqual(change.unchanged, ['a']);
  assert.deepEqual(pool.status().map((row) => row.name), ['a', 'c'], '坏条目一个都没进池');
  assert.match(logs.join('\n'), /已跳过该 server/u);
  assert.match(logs.join('\n'), /重复：只保留第一条/u);
});

test('② 只改了 `desc`：报成"变了"（要通报她），但**不重连**（不为一句说明付一次冷启动）', async (t) => {
  const dir = await freshDir(t);
  const pool = makePool({ dataDir: dir, servers: [{ name: 'a', command: 'node' }] });
  /**
   * 怎么造出"有一条活着的连接"而**不真起进程、也不握手**：直接把 `McpConnection` 塞进池的连接表。
   *
   * 为什么不走 `listTools(requireConnected: true)`：那条路要握手（`initialize` + `tools/list`），
   * 而这一份用例只问"连接**有没有被收掉**"——真握手要的假 server 是 `test/mcp-client.test.ts` 的案子，
   * 在这里搭一遍只会把 120s 的软超时引进这条判据（实测踩过：整条用例跑了 127 秒才红）。
   * 池把连接当不透明句柄用（`hasExited` / `inFlight` / `lastUsed` / `effectiveIdleReclaimMs`），
   * 所以只要这几个口在，它就是"一条活着的连接"。
   */
  const fakeConn = new McpConnection(
    // `idleReclaimMs` 给一个很大的值：这条用例**不该**被空闲回收扫描器碰到
    // （默认 5 分钟窗口下扫描周期是 5s，而这条用例有几次 await——回收一次就会把
    //  "连接没被收掉"那条判据变成偶发红）。回收这件事本身是 mcp-client 的案子。
    { name: 'a', command: 'node', idleReclaimMs: 3_600_000 },
    fakeProcess(7301),
    pool,
  );
  const connections = (pool as unknown as { connections: Map<string, McpConnection> }).connections;
  connections.set('a', fakeConn);
  const livePid = pool.status()[0]?.pid;
  assert.equal(livePid, 7301, '前提：池里有一条活着的连接');
  assert.equal(pool.status()[0]?.lastReclaimedAtMs, null, '前提：它还没被回收过');

  const onlyDesc = await pool.applyDeclarations([{ name: 'a', command: 'node', desc: '一句说明' }]);
  assert.deepEqual(onlyDesc, { added: [], removed: [], changed: ['a'], unchanged: [] },
    '只改 desc 也算一次声明变更（索引那一行会变 ⇒ 要通报她）');
  assert.equal(connections.get('a'), fakeConn,
    '**连接没被收掉**（同一个句柄还在）——一句说明不值得重连');
  assert.equal(pool.status()[0]?.lastReclaimedAtMs, null, '也不该在池里留下一笔"刚回收过"的账');

  // 反证：真影响进程的那一格变了（command）⇒ 必须收掉重连
  const commandChanged = await pool.applyDeclarations([{ name: 'a', command: 'uvx', desc: '一句说明' }]);
  assert.deepEqual(commandChanged.changed, ['a']);
  assert.equal(connections.has('a'), false, 'command 变了 ⇒ 旧连接被收掉（下次调用按新声明重建）');
});

test('② 声明面热更**不改**索引/池级两格的既有纪律（那是另一件事，别在这里做）', async (t) => {
  const dir = await freshDir(t);
  const pool = makePool({ dataDir: dir, servers: [] });
  // 池只认声明面：`applyDeclarations` 拿到的就是 `config.mcp.servers` 那一份，
  // 池级参数（maxInFlight / rssSample）不在它的入参里 ⇒ 它们不可能被热更顺手改掉。
  assert.equal(pool.maxInFlightPerServer > 0, true, '逐 server 上限照旧（构造期定下来）');
  const change = await pool.applyDeclarations([{ name: 'a', command: 'node' }]);
  assert.deepEqual(change.added, ['a']);
  assert.deepEqual(pool.status().map((row) => row.disabled), [false]);
});
