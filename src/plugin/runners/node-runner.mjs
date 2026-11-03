/**
 * IRMIA 插件运行器（Node / JS / TS）
 *
 * 起法（宿主拼的命令行，逐字见 runtime-process.ts 的 buildCommand）：
 *   node --permission --allow-fs-read=<包目录> --allow-fs-write=<插件数据目录>
 *        [--experimental-strip-types] <runner.mjs> <入口文件>
 *
 * 职责边界：
 *   · 加载入口模块（`.mjs` / `.js` / `.ts`），把 `activate(ctx)` 跑起来；
 *   · 把 ctx 的每个方法翻成一帧 JSON-RPC 发给宿主，**插件拿不到宿主内部对象**；
 *   · 收到宿主的回调（tool.invoke / hook.invoke / timer.fire）时执行本地注册的 handler 再回帧。
 *
 * 三条刻意的做法：
 *   ① **console 改道**：插件里 console.log 直接写 stdout 会污染行协议，所以在这里改成
 *      `log.write` 通知（宿主日志会带插件前缀）。插件绕过 console 直接 stdout.write 仍会毁协议，
 *      宿主侧把坏帧记成协议问题、不崩——这是"不炸宿主"的底线。
 *   ② **全局网络口拆掉**：Node 权限模型不管网络，所以真正的限网在宿主代理（`ctx.net.fetch`
 *      走 JSON-RPC，白名单与 SSRF 判据都在宿主侧）。删掉 fetch/WebSocket 只是抬高门槛，
 *      挡不住 `import('node:http')`——文档必须如实这么写。
 *   ③ **handler 结果归一化**：返回字符串 = content；返回对象带 content 就用它；其余 JSON 化。
 */

import { pathToFileURL } from 'node:url';

const entryPath = process.argv[2];
if (typeof entryPath !== 'string' || entryPath === '') {
  process.stderr.write('[irmia-plugin] 缺少入口文件参数\n');
  process.exit(2);
}

let nextId = 1;
const pending = new Map();
const toolHandlers = new Map();
/** point → handler[]（旧宿主不带 subscriptionId 时的兼容路径） */
const hookHandlers = new Map();
/** subscriptionId → handler（所有点都按订阅回调；同点多次订阅互不覆盖） */
const subscriptionHandlers = new Map();
/** 兼容旧路径：message.received 的订阅 id → handler */
const messageHandlers = new Map();
/** commandId → handler */
const commandHandlers = new Map();
const timerHandlers = new Map();
let pluginConfig = Object.freeze({});
let netAllow = Object.freeze([]);
let activated = false;
let pluginModule = null;

function emitFrame(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function notify(method, params) {
  emitFrame({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
}

/** 向宿主发一个请求并等响应。插件侧不设超时：宿主那边每一类调用都有自己的上限。 */
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    emitFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  });
}

function text(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeResult(value) {
  if (typeof value === 'string') return { content: value };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.content === 'string') {
    return {
      content: value.content,
      ...(value.isError === true ? { isError: true } : {}),
      ...(value.additionalContext === undefined ? {} : { additionalContext: value.additionalContext }),
    };
  }
  return { content: text(value ?? null) };
}

// ② 全局网络口：删掉（只是门槛，见文件头）
try {
  // eslint-disable-next-line no-global-assign
  globalThis.fetch = undefined;
  globalThis.WebSocket = undefined;
  globalThis.EventSource = undefined;
} catch {
  /* 只读属性之类的环境差异：删不掉就算了 */
}

// ① console 全部改道到宿主日志
for (const [method, level] of [['log', 'info'], ['info', 'info'], ['debug', 'info'], ['warn', 'warn'], ['error', 'error']]) {
  console[method] = (...args) => {
    notify('log.write', { level, message: args.map((item) => typeof item === 'string' ? item : text(item)).join(' ') });
  };
}

function makeContext() {
  return {
    config: pluginConfig,
    tools: {
      async define(definition) {
        if (definition === null || typeof definition !== 'object') throw new Error('ctx.tools.define 需要一个对象');
        const name = String(definition.name ?? '');
        if (name === '') throw new Error('ctx.tools.define 缺少 name');
        if (typeof definition.handler !== 'function') throw new Error('ctx.tools.define 缺少 handler');
        await rpc('tool.register', {
          name,
          description: String(definition.description ?? ''),
          parameters: definition.schema ?? definition.parameters ?? { type: 'object', properties: {} },
          ...(definition.sideEffect === undefined ? {} : { sideEffect: definition.sideEffect }),
        });
        toolHandlers.set(name, definition.handler);
      },
    },
    hooks: {
      /**
       * `on(point, handler, options?)`；`message.received` 仍是
       * `on(point, handler, filter, options?)`（过滤条件必须显式给）。
       *
       * options: `{ mode?, order?, timeoutMs?, errorPolicy?, abort? }`。所有值都由宿主在
       * `hook.subscribe` 那一刻校验；运行器只透传，不在插件进程里另造一份判据。
       */
      async on(point, handler, filterOrOptions, options) {
        if (typeof point !== 'string' || typeof handler !== 'function') throw new Error('ctx.hooks.on(point, handler, options?) 参数不对');
        const isMessage = point === 'message.received';
        let filter;
        let opts;
        if (isMessage) {
          // 过滤条件必须显式给：宿主侧按它筛，插件拿到的只有"已过滤后的那一条"
          if (filterOrOptions === null || typeof filterOrOptions !== 'object' || Array.isArray(filterOrOptions)) {
            throw new Error('ctx.hooks.on("message.received", handler, filter, options?) 必须给过滤条件对象');
          }
          filter = filterOrOptions;
          opts = options;
        } else {
          if (filterOrOptions !== undefined && (filterOrOptions === null || typeof filterOrOptions !== 'object' || Array.isArray(filterOrOptions))) {
            throw new Error(`ctx.hooks.on(${JSON.stringify(point)}, handler, options?) 的第三参数必须是选项对象`);
          }
          opts = filterOrOptions;
        }
        if (opts !== undefined && (opts === null || typeof opts !== 'object' || Array.isArray(opts))) {
          throw new Error('ctx.hooks.on 的选项必须是对象');
        }
        const result = await rpc('hook.subscribe', {
          point,
          ...(isMessage ? { filter } : {}),
          ...(opts ?? {}),
        });
        if (typeof result?.subscriptionId !== 'string') throw new Error('宿主没有返回订阅 id');
        subscriptionHandlers.set(result.subscriptionId, handler);
        // 旧宿主可能不带 id：保留 point 队列作为兜底；新宿主永远走 subscriptionId。
        if (isMessage) messageHandlers.set(result.subscriptionId, handler);
        else {
          const list = hookHandlers.get(point) ?? [];
          list.push(handler);
          hookHandlers.set(point, list);
        }
      },
    },
    commands: {
      async define(definition) {
        if (definition === null || typeof definition !== 'object') throw new Error('ctx.commands.define 需要一个对象');
        if (typeof definition.handler !== 'function') throw new Error('ctx.commands.define 缺少 handler');
        const result = await rpc('command.define', {
          name: String(definition.name ?? ''),
          description: String(definition.description ?? ''),
          permission: definition.permission,
          ...(definition.aliases === undefined ? {} : { aliases: definition.aliases }),
          ...(definition.args === undefined ? {} : { args: definition.args }),
        });
        commandHandlers.set(result.commandId, definition.handler);
        return result;
      },
    },
    net: {
      /** 清单里的网络白名单（只读；实际判据在宿主侧） */
      get allow() { return netAllow; },
      async fetch(url, init) {
        if (typeof url !== 'string' || url === '') throw new Error('ctx.net.fetch(url, init?) 需要一个 URL 字符串');
        if (init !== undefined && (init === null || typeof init !== 'object' || Array.isArray(init))) {
          throw new Error('ctx.net.fetch 的第二个参数必须是对象');
        }
        return await rpc('net.fetch', { url, ...(init === undefined ? {} : { init }) });
      },
    },
    chat: {
      async send(message) {
        if (message === null || typeof message !== 'object') throw new Error('ctx.chat.send 需要一个对象');
        return await rpc('chat.send', message);
      },
      async history(limit = 20) {
        return (await rpc('chat.read', { limit })).messages;
      },
    },
    model: {
      async complete(request) {
        if (request === null || typeof request !== 'object') throw new Error('ctx.model.complete 需要一个对象');
        return await rpc('model.complete', request);
      },
    },
    timers: {
      async every(interval, handler) {
        const timerId = `every-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        timerHandlers.set(timerId, handler);
        await rpc('timer.every', { timerId, intervalMs: interval });
        return timerId;
      },
      async cron(expression, handler) {
        const timerId = `cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        timerHandlers.set(timerId, handler);
        await rpc('timer.cron', { timerId, expression });
        return timerId;
      },
      async cancel(timerId) {
        timerHandlers.delete(timerId);
        return await rpc('timer.cancel', { timerId });
      },
    },
    state: {
      session: {
        async get(key) { return (await rpc('state.get', { scope: 'session', key })).value; },
        async set(key, value) { await rpc('state.set', { scope: 'session', key, value }); },
      },
      plugin: {
        async get(key) { return (await rpc('state.get', { scope: 'plugin', key })).value; },
        async set(key, value) { await rpc('state.set', { scope: 'plugin', key, value }); },
      },
    },
    files: {
      async read(path, options) {
        const result = await rpc('files.read', { path, ...(options?.encoding === undefined ? {} : { encoding: options.encoding }) });
        return result.data;
      },
      async write(path, data, options) {
        const result = await rpc('files.write', {
          path, data,
          ...(options?.encoding === undefined ? {} : { encoding: options.encoding }),
        });
        return result.bytes;
      },
      async list(dir) {
        const result = await rpc('files.list', dir === undefined ? {} : { dir });
        return result.entries;
      },
    },
    log: {
      info(message, extra) { notify('log.write', { level: 'info', message: text(message), ...(extra === undefined ? {} : { extra }) }); },
      warn(message, extra) { notify('log.write', { level: 'warn', message: text(message), ...(extra === undefined ? {} : { extra }) }); },
      error(message, extra) { notify('log.write', { level: 'error', message: text(message), ...(extra === undefined ? {} : { extra }) }); },
    },
  };
}

const ctx = makeContext();

async function dispatch(frame) {
  if (frame.method === 'plugin.activate') {
    pluginConfig = Object.freeze({ ...(frame.params?.config ?? {}) });
    netAllow = Object.freeze([...(frame.params?.netAllow ?? [])]);
    ctx.config = pluginConfig;
    const activate = pluginModule?.activate ?? (typeof pluginModule?.default === 'function' ? pluginModule.default : null)
      ?? (typeof pluginModule?.default?.activate === 'function' ? pluginModule.default.activate : null);
    if (typeof activate === 'function') await activate(ctx);
    activated = true;
    return { ok: true };
  }
  if (frame.method === 'plugin.ping') return { ok: true, uptimeMs: Math.round(process.uptime() * 1000) };
  if (frame.method === 'plugin.deactivate') {
    const deactivate = pluginModule?.deactivate ?? (typeof pluginModule?.default?.deactivate === 'function' ? pluginModule.default.deactivate : null);
    if (typeof deactivate === 'function') await deactivate(ctx);
    activated = false;
    return { ok: true };
  }
  if (frame.method === 'tool.invoke') {
    const handler = toolHandlers.get(frame.params?.name);
    if (typeof handler !== 'function') throw new Error(`插件没有注册工具 ${String(frame.params?.name)}`);
    return normalizeResult(await handler(frame.params?.args ?? {}));
  }
  if (frame.method === 'hook.invoke') {
    const params = frame.params ?? {};
    // 所有点都按订阅回调：宿主明确给 subscriptionId，别拿 point 猜（同点多次订阅才不会串）
    if (typeof params.subscriptionId === 'string') {
      const handler = subscriptionHandlers.get(params.subscriptionId) ?? messageHandlers.get(params.subscriptionId);
      if (typeof handler !== 'function') return {};
      const result = await handler(params.payload ?? {});
      return result === undefined ? {} : result;
    }
    const list = hookHandlers.get(params.point) ?? [];
    if (list.length === 0) return {};
    let last;
    for (const handler of list) {
      const result = await handler(params.payload ?? {});
      if (result !== undefined) last = result;
    }
    return last === undefined ? {} : last;
  }
  if (frame.method === 'command.invoke') {
    const params = frame.params ?? {};
    const handler = commandHandlers.get(params.commandId);
    if (typeof handler !== 'function') throw new Error(`插件没有注册指令 ${String(params.commandId)}`);
    const result = await handler({ args: params.args ?? {}, message: params.message ?? {} });
    if (result === undefined || result === null) return {};
    if (typeof result === 'string') return { text: result };
    if (typeof result !== 'object' || Array.isArray(result)) return {};
    return {
      ...(typeof result.text === 'string' ? { text: result.text } : {}),
      ...(result.media === undefined ? {} : { media: result.media }),
      ...(result.keepInContext === true ? { keepInContext: true } : {}),
    };
  }
  if (frame.method === 'timer.fire') {
    const handler = timerHandlers.get(frame.params?.timerId);
    if (typeof handler !== 'function') return {};
    await handler();
    return { ok: true };
  }
  throw new Error(`插件运行器不认识方法 ${String(frame.method)}`);
}

async function handleLine(line) {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    notify('log.write', { level: 'warn', message: '宿主发来一帧不是合法 JSON（已忽略）' });
    return;
  }
  if (frame === null || typeof frame !== 'object') return;
  // 响应：兑现一个在飞的请求
  if (frame.id !== undefined && frame.method === undefined) {
    const entry = pending.get(frame.id);
    if (entry === undefined) return;
    pending.delete(frame.id);
    if (frame.error !== undefined) {
      const error = new Error(String(frame.error.message ?? '宿主调用失败'));
      error.code = frame.error.code;
      error.data = frame.error.data;
      entry.reject(error);
    } else {
      entry.resolve(frame.result);
    }
    return;
  }
  if (typeof frame.method !== 'string') return;
  if (frame.id === undefined) {
    // 通知：目前宿主只发 plugin.deactivate；按方法跑一遍但不用回帧
    void dispatch(frame).catch(() => undefined);
    return;
  }
  try {
    const result = await dispatch(frame);
    emitFrame({ jsonrpc: '2.0', id: frame.id, result });
    if (frame.method === 'plugin.deactivate') setTimeout(() => process.exit(0), 10).unref();
  } catch (error) {
    emitFrame({
      jsonrpc: '2.0',
      id: frame.id,
      error: {
        code: typeof error?.code === 'number' ? error.code : -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') void handleLine(line);
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => { process.exit(0); });

process.on('uncaughtException', (error) => {
  notify('log.write', { level: 'error', message: `未捕获异常：${error instanceof Error ? error.stack ?? error.message : String(error)}` });
  // 宿主会把这次退出记成 plugin/crashed 并按冷却重启一次
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  notify('log.write', { level: 'error', message: `未处理的 Promise 拒绝：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}` });
  process.exit(1);
});

try {
  pluginModule = await import(pathToFileURL(entryPath).href);
} catch (error) {
  notify('log.write', { level: 'error', message: `插件入口加载失败：${error instanceof Error ? error.stack ?? error.message : String(error)}` });
  process.exit(1);
}

notify('plugin.ready', { protocol: 1, activated });
