#!/usr/bin/env node
/**
 * 插件脚手架 —— 生成一个**能被现有安装流程直接装上**的 apiVersion 2 插件包。
 *
 * 为什么要有它：P1a 的包形状（plugin.json + 入口 + README）每写一次就要对着
 * `src/plugin/manifest.ts` 的校验规则抄一遍；抄错一处，装包时报的是"清单第 N 个字段不对"，
 * 而不是"你少写了一行"。脚手架只做一件事：把**已经校验过**的形状写出来，剩下的留给作者改。
 *
 * 四条纪律（对应需求，别在模板里破）：
 *   ① 生成的包必须过 `parsePluginManifest` + `scanPluginPackage`：id 规则与清单一致、
 *      version 是合法 SemVer、engine 是 `>=<当前 AGENT_VERSION>`（**从 src/main.ts 读，
 *      不写死**——写死的那天宿主一升级，生成出来的包就装不上了）；
 *   ② 只生成本地文件：不联网、不生成 node_modules、不把本机绝对路径写进任何产物
 *      （README 里一律用"本目录 / <dataDir>"这种相对说法）；
 *   ③ 输出目录已存在且非空 → **拒绝**（除非 --force），并说清拒绝的原因：
 *      那目录里可能正是作者已经写了一半的插件；
 *   ④ 三种语言各给一个最小可运行样板：注册一个工具 + 一条日志。ts 入口不编译
 *      （宿主用 `--experimental-strip-types` 直接加载），py 只用标准库。
 *
 * 用法：node scripts/create-plugin.mjs <id> [--lang js|ts|py] [--dir <目录>] [--name <显示名>] [--force]
 * 退出码：0 成功；1 运行期失败（拒绝覆盖 / 写不进去 / 读不到宿主版号）；2 用法错误。
 *
 * 这个文件同时被 `test/plugin-scaffold.test.ts` 直接 import（不起子进程）：所以入口逻辑放在
 * `runCli()` 里、副作用只在"被当脚本执行"时发生（见文件末尾的 main 判定）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 退出码语义（帮助里也写了一份；测试按这三个数断言） */
export const EXIT_CODES = Object.freeze({ ok: 0, failure: 1, usage: 2 });

/**
 * 插件 id 规则：**与 `src/plugin/manifest.ts` 的 `ID` 正则逐字相同**。
 * 那边没导出这个常量，而本次改动不许动现有文件，所以这里复制一份；
 * `test/plugin-scaffold.test.ts` 用同一组边界值锁住两边（生成 → parsePluginManifest 必过）。
 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export const PLUGIN_ID_RULE = '1–64 个字符，只允许小写字母、数字和连字符';

/** 脚本所在的仓库根（scripts/ 的上一级）；测试 import 时也用它定位 src/main.ts */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 命令行的用法错误：exitCode 固定 2，与"运行期失败"分开 */
export class CliError extends Error {
  /** @param {string} message @param {number} exitCode */
  constructor(message, exitCode) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/**
 * 从 `src/main.ts` 读宿主版号（版号的唯一真源，见那边的注释）。
 *
 * 刻意不读 package.json：发布脚本只改 main.ts 那一行，两处读就会有两处漂。
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function readAgentVersion(repoRoot = REPO_ROOT) {
  const mainFile = join(repoRoot, 'src', 'main.ts');
  let source;
  try {
    source = readFileSync(mainFile, 'utf8');
  } catch (error) {
    throw new CliError(`读不到宿主版号：${mainFile}（${messageOf(error)}）`, EXIT_CODES.failure);
  }
  const match = /^export const AGENT_VERSION = '([^']+)';/m.exec(source);
  if (match === null) {
    throw new CliError(`没在 ${mainFile} 里找到 export const AGENT_VERSION = '...';`, EXIT_CODES.failure);
  }
  return match[1];
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析命令行参数（不碰文件系统，纯函数，测试可直接调）。
 *
 * 支持 `--lang js` 与 `--lang=js` 两种写法；`--help` 优先于其它一切（哪怕 id 缺失）。
 * @param {readonly string[]} argv
 */
export function parseArgs(argv) {
  const options = { id: null, lang: 'js', dir: null, name: null, force: false, help: false };
  const positional = [];
  /** @param {string} message */
  const usage = (message) => new CliError(message, EXIT_CODES.usage);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const flag = equals === -1 ? arg : arg.slice(0, equals);
      let value = equals === -1 ? undefined : arg.slice(equals + 1);
      if (flag !== '--lang' && flag !== '--dir' && flag !== '--name') throw usage(`不认识的选项：${flag}`);
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) throw usage(`${flag} 需要一个值`);
        value = next;
        index += 1;
      }
      if (value === '') throw usage(`${flag} 的值不能为空`);
      if (flag === '--lang') options.lang = value;
      else if (flag === '--dir') options.dir = value;
      else options.name = value;
      continue;
    }
    if (arg.startsWith('-')) throw usage(`不认识的选项：${arg}`);
    positional.push(arg);
  }
  if (options.help) return options;
  if (positional.length === 0) throw usage('缺少插件 id');
  if (positional.length > 1) throw usage(`只能给一个插件 id，实际收到 ${positional.length} 个：${positional.join(', ')}`);
  options.id = positional[0];
  return options;
}

/** 三种语言的样板元数据：入口文件、运行时类型、样板用到的权限 */
const TEMPLATES = Object.freeze({
  js: { entry: 'main.mjs', runtime: 'node', permissions: ['tools.define'], label: 'JavaScript' },
  ts: { entry: 'main.ts', runtime: 'node', permissions: ['tools.define'], label: 'TypeScript' },
  py: { entry: 'main.py', runtime: 'python', permissions: ['tools.define'], label: 'Python' },
});

/**
 * 生成一个插件包（同步、幂等：同一份输入重复跑，产物逐字节相同）。
 *
 * @param {{
 *   id: string,
 *   lang?: 'js' | 'ts' | 'py',
 *   dir?: string,
 *   name?: string,
 *   force?: boolean,
 *   cwd?: string,
 *   agentVersion?: string,
 * }} input
 * @returns {{ id: string, lang: string, dir: string, entry: string, engine: string, agentVersion: string, files: string[] }}
 */
export function createPlugin(input) {
  if (input === null || typeof input !== 'object') throw new CliError('缺少参数对象', EXIT_CODES.usage);
  const id = input.id;
  if (typeof id !== 'string' || id === '') throw new CliError('缺少插件 id', EXIT_CODES.usage);
  if (!PLUGIN_ID_PATTERN.test(id)) {
    throw new CliError(`插件 id 不合法：${JSON.stringify(id)}\n  ${PLUGIN_ID_RULE}（与清单校验同口径）`, EXIT_CODES.usage);
  }
  const lang = input.lang ?? 'js';
  if (typeof lang !== 'string' || !Object.hasOwn(TEMPLATES, lang)) {
    throw new CliError(`--lang 只支持 ${Object.keys(TEMPLATES).join(' / ')}（收到 ${JSON.stringify(lang)}）`, EXIT_CODES.usage);
  }
  const name = input.name ?? id;
  if (typeof name !== 'string' || name.trim() === '') throw new CliError('--name 不能是空字符串', EXIT_CODES.usage);
  if (name.length > 80) throw new CliError(`--name 最多 80 个字符（清单 meta.title 的上限），实际 ${name.length} 个`, EXIT_CODES.usage);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new CliError('--name 不能包含换行或其它控制字符', EXIT_CODES.usage);
  const cwd = input.cwd ?? process.cwd();
  // parseArgs 用 null 表示"没给"；这里统一成 undefined，避免把 null 当路径。
  const dir = input.dir ?? undefined;
  if (dir !== undefined && (typeof dir !== 'string' || dir.trim() === '')) {
    throw new CliError('--dir 必须是非空路径', EXIT_CODES.usage);
  }
  const agentVersion = input.agentVersion ?? readAgentVersion();
  // engine 只写 `>=` 约束：精确相等会把"宿主升了个小版本"变成装不上。
  const engine = `>=${agentVersion}`;
  const target = resolve(cwd, dir ?? id);
  const template = TEMPLATES[lang];
  const files = buildFiles({ id, lang, name, engine, entry: template.entry, runtime: template.runtime, permissions: template.permissions });
  prepareTarget(target, input.force === true);
  for (const file of files) writeFileSync(join(target, file.name), file.content, { encoding: 'utf8' });
  return {
    id,
    lang,
    dir: target,
    entry: template.entry,
    engine,
    agentVersion,
    files: files.map((file) => file.name),
  };
}

/**
 * 输出目录的准备：不存在就建；存在且非空 → 拒绝（除非 force）。
 *
 * 拒绝时说清"为什么"：作者最可能的情况是目录里已经有写了一半的插件，
 * 一句 "EEXIST" 不足以让人判断该不该加 --force。
 * @param {string} target
 * @param {boolean} force
 */
function prepareTarget(target, force) {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    return;
  }
  if (!statSync(target).isDirectory()) {
    throw new CliError(`输出路径已存在且不是目录：${target}\n  换一个 --dir，或先把那个文件挪走。`, EXIT_CODES.failure);
  }
  const entries = readdirSync(target);
  if (entries.length === 0 || force) return;
  throw new CliError(
    [
      `拒绝覆盖：输出目录已存在且非空（${entries.length} 项）：${target}`,
      '  那里面可能正是你已经写过的插件代码，脚手架不替你做"删掉还是留着"的决定。',
      '  确认可以覆盖时加 --force：只覆盖本脚手架生成的文件，目录里其它文件原样保留。',
    ].join('\n'),
    EXIT_CODES.failure,
  );
}

/**
 * 三种语言的产物清单（内容 + 文件名）。
 * @param {{ id: string, lang: string, name: string, engine: string, entry: string, runtime: string, permissions: readonly string[] }} info
 * @returns {{ name: string, content: string }[]}
 */
function buildFiles(info) {
  return [
    { name: 'plugin.json', content: manifestJson(info) },
    { name: info.entry, content: renderEntries(info) },
    { name: 'README.md', content: readme(info) },
  ];
}

/** @param {{ id: string, name: string, engine: string, entry: string, runtime: string, permissions: readonly string[], lang: string }} info */
function manifestJson(info) {
  const described = {
    apiVersion: 2,
    id: info.id,
    version: '0.1.0',
    engine: { irmia: info.engine },
    runtime: { type: info.runtime, entry: info.entry },
    permissions: [...info.permissions],
    meta: {
      title: info.name,
      desc: `create-plugin 生成的 ${TEMPLATES[info.lang].label} 样板：注册一个工具并写一条日志`,
    },
  };
  return `${JSON.stringify(described, null, 2)}\n`;
}

/** @param {{ id: string, lang: string }} info */
function renderEntries(info) {
  return render(ENTRY_TEMPLATES[info.lang], { id: info.id });
}

/** 模板替换：`{{token}}` → 值。不用 `${}`，免得生成代码里的模板字符串跟本文件打架。 */
function render(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}

// ──────────────────────────────── 三种语言的最小样板 ────────────────────────────────
// 逐条纪律：只依赖宿主注入的 ctx；不 import 任何第三方包；不写绝对路径；不用 eval / exec。

const ENTRY_TEMPLATES = Object.freeze({
  js: `/**
 * {{id}} 的入口：导出一个 activate(ctx)，宿主在插件启用时调用它。
 *
 * 这个样板只做两件事：注册一个工具、写一条日志。
 * 不需要 node_modules，也不联网：能力全部经宿主注入的 ctx。
 */

export async function activate(ctx) {
  await ctx.tools.define({
    name: 'hello',
    description: '向 {{id}} 打个招呼',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要打招呼的人（可省略）' } },
    },
    handler: async (args) => {
      const text = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : '世界';
      return { content: '你好，' + text + '！' };
    },
  });

  ctx.log.info('{{id}} 已激活');
}
`,

  ts: `/**
 * {{id}} 的入口：导出一个 activate(ctx)，宿主在插件启用时调用它。
 *
 * 入口是 .ts：宿主用 node --experimental-strip-types **直接加载**，不经过编译。
 * 因此只能用"能被类型擦除"的语法：不要 enum / namespace / 构造函数参数属性 / import =。
 * 这个样板只做两件事：注册一个工具、写一条日志。
 */

interface HelloArgs {
  name?: string;
}

interface PluginContext {
  tools: {
    define(definition: {
      name: string;
      description: string;
      schema?: Record<string, unknown>;
      handler: (args: HelloArgs) => Promise<{ content: string }>;
    }): Promise<void>;
  };
  log: { info(message: string): void };
}

export async function activate(ctx: PluginContext): Promise<void> {
  await ctx.tools.define({
    name: 'hello',
    description: '向 {{id}} 打个招呼',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: '要打招呼的人（可省略）' } },
    },
    handler: async (args: HelloArgs) => {
      const text = args.name !== undefined && args.name.trim() !== '' ? args.name.trim() : '世界';
      return { content: '你好，' + text + '！' };
    },
  });

  ctx.log.info('{{id}} 已激活');
}
`,

  py: `"""{{id}} 的入口：宿主在插件启用时调用 activate(ctx)。

这个样板只做两件事：注册一个工具、写一条日志。
只 import 标准库，不需要 requirements.txt。
"""


def activate(ctx):
    def hello(args):
        text = str(args.get("name") or "").strip() or "世界"
        return {"content": "你好，" + text + "！"}

    ctx.tools.define(
        name="hello",
        description="向 {{id}} 打个招呼",
        schema={
            "type": "object",
            "properties": {"name": {"type": "string", "description": "要打招呼的人（可省略）"}},
        },
        handler=hello,
    )

    ctx.log.info("{{id}} 已激活")
`,
});

// ──────────────────────────────── README ────────────────────────────────

const LANG_NOTES = Object.freeze({
  js: [
    '## 为什么入口是 .mjs',
    '',
    '`.mjs` 明确是 ESM（不依赖 package.json 的 `type` 字段）。用 `import` / `export`，',
    '不要在 ESM 里写 `require`。',
  ],
  ts: [
    '## 为什么入口是 .ts',
    '',
    '宿主用 `node --experimental-strip-types` **直接加载** `.ts`，不经过编译。因此只能用',
    '能被类型擦除的语法：不要 `enum` / `namespace` / 构造函数参数属性 / `import =`；',
    '类型注解、`interface`、`as` 都可以。',
  ],
  py: [
    '## Python 与 requirements',
    '',
    '样板只 import 标准库，**没有** `requirements.txt`，也不需要安装任何东西。',
    '',
    '- 宿主用系统 Python（`python -I`，隔离模式）直接跑入口，**不会**替你执行 pip；',
    '- 如果确实需要第三方包：在插件目录放 `requirements.txt` 写清依赖，并在本 README 里写明',
    '  安装方式。宿主当前不自动安装，缺包会在运行期 import 失败；',
    '- 安装期有一道 Python AST 扫描（提高门槛，不是沙箱）：`os` / `pathlib` 等要 `files`；',
    '  `socket` / `requests` 等网络模块一律拒收，联网只能走 `ctx.net.fetch`（另需 `net` 与 `net.allow`）；',
    '  `subprocess` / `ctypes` 等命令或原生调用模块也一律拒收；`eval` / `exec` / 动态导入同样拒绝。',
    '  样板不碰这些。',
  ],
});

/** @param {{ id: string, name: string, lang: string, entry: string, runtime: string, engine: string, permissions: readonly string[] }} info */
function readme(info) {
  const permissionList = info.permissions.map((permission) => `\`${permission}\``).join('、');
  return [
    `# ${info.name}`,
    '',
    `- 插件 id：\`${info.id}\`（**不要改**：改了就是另一个插件）`,
    '- 版本：`0.1.0`',
    `- 入口：\`${info.entry}\`（运行时 \`${info.runtime}\`，清单 apiVersion 2）`,
    `- 引擎要求：Irmia \`${info.engine}\`（宿主版本低于它时安装会被拒绝）`,
    `- 权限：${permissionList} —— 只用于注册工具`,
    '',
    '## 文件',
    '',
    '| 文件 | 说明 |',
    '| --- | --- |',
    '| `plugin.json` | 清单：id / version / engine / runtime / permissions / meta |',
    `| \`${info.entry}\` | 入口：导出 \`activate(ctx)\`，宿主在启用时调用 |`,
    '| `README.md` | 本文件 |',
    '',
    '## 它能做什么',
    '',
    '`activate(ctx)` 注册了一个名为 `hello` 的工具，并写一条日志。工具在宿主里的全名是',
    `\`${info.id}__hello\`（宿主给每个插件的工具加 id 前缀，避免重名）。`,
    '',
    '## 安装',
    '',
    '1. 宿主执行 `plugin-install`，`sourceDir` 指向**本目录的绝对路径**；',
    '2. 在插件列表里核对权限与来源（review）；',
    '3. `plugin-confirm` → `plugin-enable`。',
    '',
    '安装是**内容寻址**的：整包算一个 SHA-256，落到',
    `\`<dataDir>/plugins/packages/${info.id}/<contentHash>/\`。改任何一个字节装上去都是另一份包，`,
    '需要重新确认。包内不允许符号链接；单文件 ≤1MB、整包 ≤8MB、文件数 ≤256。',
    '',
    '## 开发',
    '',
    '- 不需要 `node_modules`、不需要联网：能力全部来自宿主注入的 `ctx`；',
    '- 改完代码把 `plugin.json` 的 `version` 往上加（`0.1.1`、`0.2.0`…）；',
    '- `engine.irmia` 是 `>=` 约束，发布时按目标宿主版本调整；',
    '- 权限按最小必要声明：只加你真的会调用的 `ctx.*` 对应的那一条。',
    '',
    ...LANG_NOTES[info.lang],
    '',
  ].join('\n');
}

// ──────────────────────────────── 命令行 ────────────────────────────────

/** `--help` 的自描述文本（用数组而不是一个大模板：测试按行断言） */
export function helpLines() {
  return [
    'create-plugin —— 生成一个能被 Irmia 直接安装的 apiVersion 2 插件包',
    '',
    '用法：',
    '  node scripts/create-plugin.mjs <id> [选项]',
    '',
    '参数：',
    `  <id>                插件 id：${PLUGIN_ID_RULE}`,
    '                      （规则与 src/plugin/manifest.ts 一致；装包时还会再校验一次）',
    '',
    '选项：',
    '  --lang js|ts|py     入口语言（默认 js）',
    '                        js → main.mjs（node 运行时，ESM，注册工具 + 日志）',
    '                        ts → main.ts （node 运行时，宿主用 --experimental-strip-types 直接加载）',
    '                        py → main.py （python 运行时，只依赖标准库）',
    '  --dir <目录>        输出目录（默认 ./<id>）',
    '  --name <显示名>     plugin.json 的 meta.title（默认与 id 相同，≤80 字符）',
    '  --force             输出目录已存在且非空时仍然写入（只覆盖本脚手架生成的文件）',
    '  -h, --help          打印本帮助（退出码 0）',
    '',
    '生成：',
    '  plugin.json    apiVersion 2 清单：id / version 0.1.0 / engine >=当前宿主版本 /',
    '                 runtime{type,entry} / permissions / meta；版号从 src/main.ts 读，不写死',
    '  入口文件       导出 activate(ctx)：注册一个 hello 工具 + 写一条日志',
    '  README.md      安装与开发说明（py 另有 requirements 与 AST 扫描的说明）',
    '',
    '退出码：',
    '  0  成功（--help 也返回 0）',
    '  1  运行期失败：拒绝覆盖非空目录、路径不是目录、文件写不进去、读不到宿主版号',
    '  2  用法错误：缺少 id、id 不合法、--lang 不支持、选项缺值或未知选项',
    '',
    '例子：',
    '  node scripts/create-plugin.mjs hello-world',
    '  node scripts/create-plugin.mjs hello-ts --lang ts --dir ./hello-ts --name "你好 TS"',
  ];
}

/**
 * 命令行入口（不调 `process.exit`，只返回退出码；测试直接调它，不启子进程）。
 *
 * @param {readonly string[]} argv
 * @param {{ cwd?: string, stdout?: (line: string) => void, stderr?: (line: string) => void }} [io]
 * @returns {number} 退出码，语义见 {@link EXIT_CODES}
 */
export function runCli(argv, io = {}) {
  const stdout = io.stdout ?? ((line) => console.log(line));
  const stderr = io.stderr ?? ((line) => console.error(line));
  const cwd = io.cwd ?? process.cwd();
  try {
    const options = parseArgs(argv);
    if (options.help) {
      for (const line of helpLines()) stdout(line);
      return EXIT_CODES.ok;
    }
    const result = createPlugin({ ...options, cwd });
    for (const line of summaryLines(result, cwd)) stdout(line);
    return EXIT_CODES.ok;
  } catch (error) {
    const exitCode = error instanceof CliError && error.exitCode === EXIT_CODES.usage ? EXIT_CODES.usage : EXIT_CODES.failure;
    stderr(exitCode === EXIT_CODES.usage ? `用法错误：${messageOf(error)}` : `创建失败：${messageOf(error)}`);
    if (exitCode === EXIT_CODES.usage) stderr('用 --help 看用法与退出码。');
    return exitCode;
  }
}

/** @param {ReturnType<typeof createPlugin>} result @param {string} cwd */
function summaryLines(result, cwd) {
  const relation = relative(cwd, result.dir);
  const shown = relation === '' || relation.startsWith('..') || isAbsolute(relation) ? result.dir : relation;
  return [
    `已生成插件 ${result.id}（${result.lang} → ${result.entry}）`,
    `目录：${shown}`,
    '文件：',
    ...result.files.map((name) => `  ${name}`),
    `engine：${result.engine}（从 src/main.ts 的 AGENT_VERSION 读，宿主低于它会拒绝安装）`,
    '',
    '下一步：把该目录的绝对路径交给宿主的 plugin-install（sourceDir），先 review 权限再 confirm/enable。',
  ];
}

// 只有"被当成脚本执行"时才跑 CLI；被测试 import 时零副作用。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
