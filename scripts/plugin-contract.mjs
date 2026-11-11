import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgentVersion } from './create-plugin.mjs';

export const CONTRACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PERMISSION_USAGE = {
  'tools.define': 'ctx.tools.define',
  'hooks.model': 'model.request / model.response / model.waiting',
  'hooks.turn': 'turn.start / turn.end',
  'hooks.tool': 'tool.before / tool.after',
  'chat.send': 'ctx.chat.send、reply.decorate、message.sent',
  'chat.read': 'ctx.chat.history',
  'model.call': 'ctx.model.complete',
  timers: 'ctx.timers.every / cron / cancel',
  'state.session': 'ctx.state.session.get / set',
  'state.plugin': 'ctx.state.plugin.get / set',
  files: 'ctx.files.read / write / list',
  net: 'ctx.net.fetch（另受 net.allow 限制）',
  'messages.read': 'message.received',
  'commands.define': 'ctx.commands.define、command.before / after',
};

const ERROR_USAGE = {
  parseError: '帧不是合法 JSON',
  invalidRequest: 'JSON-RPC 请求形状错误',
  methodNotFound: '宿主不认识该方法',
  invalidParams: '参数缺失、类型或越界错误；Hook 订阅选项不合法',
  internalError: '宿主内部错误、插件异常或模型通道失败',
  permissionDenied: '未声明调用所需权限',
  timeout: '工具、Hook 或激活超时',
  unsupported: '宿主没有接线对应能力',
  pluginExited: '插件进程已经退出',
  isolated: '贡献已被隔离',
  business: '网络策略、指令冲突、当前会话或日预算等业务拒绝',
};

function manifestSchema() {
  const id = { type: 'string', pattern: '^[a-z0-9-]{1,64}$' };
  const version = { type: 'string', pattern: '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?$' };
  const relativePath = { type: 'string', minLength: 1, pattern: '^(?!.*(?:^|/)\\.\\.?(?:/|$))(?!/)(?!.*\\\\).*(?<!/)$' };
  const hookOptions = {
    type: 'object',
    additionalProperties: false,
    required: ['point'],
    properties: {
      point: { type: 'string' },
      mode: { enum: ['blocking', 'observe'] },
      order: { enum: ['EARLY', 'NORMAL', 'LATE'] },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
      errorPolicy: { enum: ['ABORT', 'SKIP', 'LOG'] },
      abort: { type: 'boolean' },
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://irmia.me/schemas/plugin-manifest.schema.json',
    title: 'IRMIA plugin manifest',
    type: 'object',
    additionalProperties: false,
    required: ['apiVersion', 'id', 'version', 'engine', 'permissions'],
    properties: {
      apiVersion: { enum: [1, 2] },
      id,
      version,
      engine: {
        type: 'object', additionalProperties: false, required: ['irmia'],
        properties: { irmia: { type: 'string', pattern: '^(?:>=)?(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?$' } },
      },
      runtime: {
        type: 'object', additionalProperties: false, required: ['type'],
        properties: { type: { enum: ['node', 'python', 'declarative'] }, entry: relativePath },
      },
      permissions: { type: 'array', items: { type: 'string', minLength: 1 } },
      contributions: {
        type: 'object', additionalProperties: false,
        properties: {
          skills: { type: 'array', items: relativePath },
          hooks: relativePath,
          mcp: relativePath,
        },
      },
      config: relativePath,
      meta: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 80 },
          author: { type: 'string', minLength: 1, maxLength: 80 },
          desc: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
      net: {
        type: 'object', additionalProperties: false,
        properties: { allow: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 255 } } },
      },
      'net.allow': { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 255 } },
      hooks: { type: 'array', maxItems: 32, items: { anyOf: [{ type: 'string' }, hookOptions] } },
    },
    allOf: [
      {
        if: { properties: { apiVersion: { const: 1 } } },
        then: {
          required: ['contributions'],
          not: { anyOf: ['runtime', 'config', 'meta', 'net', 'net.allow'].map((property) => ({ required: [property] })) },
        },
      },
      {
        if: { properties: { apiVersion: { const: 2 } } },
        then: {
          required: ['runtime'],
          properties: { permissions: { items: { enum: Object.keys(PERMISSION_USAGE) } } },
        },
      },
      {
        if: { properties: { runtime: { properties: { type: { enum: ['node', 'python'] } }, required: ['type'] } } },
        then: { properties: { runtime: { required: ['entry'] } } },
      },
      {
        if: { properties: { runtime: { properties: { type: { const: 'declarative' } }, required: ['type'] } } },
        then: { properties: { runtime: { not: { required: ['entry'] } } } },
      },
    ],
  };
}

export async function buildPluginContract() {
  const [manifest, registry, protocol] = await Promise.all([
    import('../src/plugin/manifest.ts'),
    import('../src/plugin/hook-registry.ts'),
    import('../src/plugin/protocol.ts'),
  ]);
  return {
    schema: 1,
    hostVersion: readAgentVersion(CONTRACT_ROOT),
    manifestApiVersions: [manifest.PLUGIN_API_VERSION_V1, manifest.PLUGIN_API_VERSION_V2],
    protocol: protocol.PLUGIN_PROTOCOL_VERSION,
    permissions: manifest.PLUGIN_PERMISSIONS.map((permission) => ({ permission, usage: PERMISSION_USAGE[permission] })),
    hooks: registry.PLUGIN_HOOK_POINTS.map((point) => {
      const meta = registry.HOOK_POINT_METADATA[point];
      return {
        point,
        description: meta.description,
        permission: meta.permission,
        modes: [...meta.modes],
        orders: ['EARLY', 'NORMAL', 'LATE'],
        defaultTimeoutMs: meta.defaultTimeoutMs,
        maxTimeoutMs: registry.HOOK_TIMEOUT_MAX_MS,
        errorPolicies: [...meta.errorPolicies],
        allowAbort: meta.allowAbort,
        modifiableFields: [...meta.modifiableFields],
      };
    }),
    methods: {
      host: { ...protocol.PLUGIN_HOST_METHODS },
      plugin: { ...protocol.PLUGIN_PLUGIN_METHODS },
      notifications: { ...protocol.PLUGIN_NOTIFICATIONS },
    },
    errors: Object.fromEntries(Object.entries(protocol.PLUGIN_RPC_ERRORS).map(([name, code]) => [name, { code, meaning: ERROR_USAGE[name] }])),
  };
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function generatedBlocks(contract) {
  return {
    permissions: table(['权限', '对应能力'], contract.permissions.map((item) => [`\`${item.permission}\``, item.usage])),
    hooks: table(
      ['钩子', '权限', '模式', '默认超时', '可修改字段', 'abort'],
      contract.hooks.map((hook) => [
        `\`${hook.point}\``, hook.permission === null ? '无' : `\`${hook.permission}\``, hook.modes.join('／'),
        `${hook.defaultTimeoutMs}ms`, hook.modifiableFields.length === 0 ? '不使用' : hook.modifiableFields.map((field) => `\`${field}\``).join('、'),
        hook.allowAbort ? '可声明' : '—',
      ]),
    ),
    errors: table(
      ['码', '常量名', '含义'],
      Object.entries(contract.errors).map(([name, item]) => [`\`${item.code}\``, `\`${name}\``, item.meaning]),
    ),
  };
}

function replaceMarked(text, name, content) {
  const start = `<!-- plugin-contract:${name}:start -->`;
  const end = `<!-- plugin-contract:${name}:end -->`;
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt < 0 || endAt < startAt) throw new Error(`文档缺少成对生成标记：${name}`);
  return `${text.slice(0, startAt + start.length)}\n${content}\n${text.slice(endAt)}`;
}

function expectedDocuments(contract) {
  const blocks = generatedBlocks(contract);
  const apiPath = join(CONTRACT_ROOT, 'docs', 'plugin-api.md');
  const developmentPath = join(CONTRACT_ROOT, 'docs', 'plugin-development.md');
  let api = readFileSync(apiPath, 'utf8').replace(/对应宿主 `[^`]+`/u, `对应宿主 \`${contract.hostVersion}\``);
  let development = readFileSync(developmentPath, 'utf8').replace(/对应宿主 `[^`]+`/u, `对应宿主 \`${contract.hostVersion}\``);
  for (const [name, content] of Object.entries(blocks)) api = replaceMarked(api, name, content);
  return new Map([[apiPath, api], [developmentPath, development]]);
}

function expectedFiles(contract) {
  const files = expectedDocuments(contract);
  files.set(join(CONTRACT_ROOT, 'sdk', 'contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  files.set(join(CONTRACT_ROOT, 'sdk', 'plugin-manifest.schema.json'), `${JSON.stringify(manifestSchema(), null, 2)}\n`);
  const sdkPackagePath = join(CONTRACT_ROOT, 'sdk', 'node', 'package.json');
  const sdkPackage = JSON.parse(readFileSync(sdkPackagePath, 'utf8'));
  files.set(sdkPackagePath, `${JSON.stringify({ ...sdkPackage, version: contract.hostVersion }, null, 2)}\n`);
  return files;
}

export async function syncPluginContract(options = {}) {
  const contract = await buildPluginContract();
  const changed = [];
  for (const [path, expected] of expectedFiles(contract)) {
    let actual = '';
    try { actual = readFileSync(path, 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (actual === expected) continue;
    if (options.check === true) throw new Error(`插件契约或文档未同步：${path}；运行 npm run plugin:docs`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, expected, 'utf8');
    changed.push(path);
  }
  return { contract, changed };
}

const invoked = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invoked.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const check = process.argv.includes('--check');
  syncPluginContract({ check }).then((result) => {
    console.log(check ? '插件契约、SDK 与文档一致' : `插件契约已同步（更新 ${result.changed.length} 个文件）`);
  }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
