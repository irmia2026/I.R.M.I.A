#!/usr/bin/env node
/**
 * linre-presence —— 「进频道」插件（用户 2026-11-04 裁决的形态）。
 *
 * ## 它解决什么
 *
 * 群里的闲话原先只进信箱（`channel/message`，visibility=internal），她要看见**必须**
 * 主动 `read_channel`。这跟"在屋里坐着，别人说话自然飘进来"是两回事。
 *
 * 插件**不能**改渲染、不能让消息自动出现在她眼前（那是内核的口子，worker 只能观测
 * 已提交事件，而 internal 事件根本到不了 worker）。所以这里做成**长轮询**：
 * 她进屋 → 拿前 20 条 → 想等就调 `wait_messages`，等到的消息作为**工具结果**回来。
 * 工具结果天然进上下文，且每条只出现一次，不会每步重复占上下文。
 *
 * ## 数据来源（只读）
 *
 * 直接读事件日志 `<dataDir>/events/*.jsonl` —— 那是框架自己声明的唯一真相源，
 * 追加写、只增不改。插件不起来源，只做索引。
 *
 * ## 两条硬规矩
 *
 * • `wait_messages` 硬顶 120 秒（用户定的上限），期间每 25 秒发一次 progress 通知
 *   把 MCP 软超时顶回去；`mcp.json` 那边把 requestTimeoutMs 提到 150 秒兜底。
 * • 10 分钟内**没有任何工具调用**就当作已自动退出。判据是事件日志里的 `tool/call`：
 *   取"当前这次之前"最近的一次，中间隔了 10 分钟以上就算过期。惰性判定，
 *   不起定时器 —— 没调用的时候本来也没人在等。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const SESSION_TTL_MS = 10 * 60 * 1000;
const WAIT_HARD_CAP_SECONDS = 120;
const DEFAULT_WAIT_SECONDS = 60;
const DEFAULT_ENTER_COUNT = 20;
const ENTER_COUNT_MAX = 50;
const POLL_MS = 400;
const PROGRESS_EVERY_MS = 25 * 1000;
/** 当前这次工具调用自己的事件已经在日志里了；用它前后这段窗口把自己排除掉 */
const SELF_CALL_GUARD_MS = 5000;

// ─────────────────────────── 数据目录 ───────────────────────────
/**
 * 插件 MCP 的 cwd 是**插件包根**（`contributions.ts:91`：`cwd = pkg.rootDir`），
 * 不是仓库根，所以不能写死 `./data`。这里向上找"有 events 那层"：
 * 从包根往上 4 层正好是 `<repo>/data`，但路径布局不该被抄成第二份知识。
 */
function findDataDir() {
  const fromEnv = process.env.IRMIA_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(join(fromEnv, 'events'))) return resolve(fromEnv);
  let dir = resolve(process.cwd());
  for (let step = 0; step < 10; step += 1) {
    if (existsSync(join(dir, 'events'))) return dir;
    if (existsSync(join(dir, 'data', 'events'))) return join(dir, 'data');
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'data');
}

const dataDir = findDataDir();
const eventsDir = join(dataDir, 'events');
const stateDir = join(dataDir, 'presence');
const statePath = join(stateDir, 'session.json');

// ─────────────────────────── 事件日志 ───────────────────────────
/** 每个文件已读到的字节数：只读新增部分，不每轮重扫整份日志 */
const offsets = new Map();

function eventFiles() {
  try {
    return readdirSync(eventsDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
}

function parseLines(chunk) {
  const out = [];
  for (const raw of chunk.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.seq === 'number') out.push(parsed);
    } catch {
      // 半行（正在写）：留给下一轮
    }
  }
  return out;
}

/** 只读游标之后的新事件 */
function readNewEvents() {
  const out = [];
  for (const name of eventFiles()) {
    const path = join(eventsDir, name);
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    let from = offsets.get(name) ?? 0;
    if (size < from) from = 0; // 被轮转/截断过
    if (size === from) continue;
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      continue;
    }
    const chunk = buffer.subarray(from, size).toString('utf8');
    // 只消费到最后一个换行：末尾那半行下次再读
    const lastBreak = chunk.lastIndexOf('\n');
    if (lastBreak < 0) continue;
    const complete = chunk.slice(0, lastBreak + 1);
    offsets.set(name, from + Buffer.byteLength(complete, 'utf8'));
    out.push(...parseLines(complete));
  }
  return out;
}

/** 全量读一遍（进屋取历史用；不受游标影响） */
function readAllEvents() {
  const out = [];
  for (const name of eventFiles()) {
    try {
      out.push(...parseLines(readFileSync(join(eventsDir, name), 'utf8')));
    } catch {
      // 单个文件读不动就跳过：少几行历史，不能让进屋失败
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// ─────────────────────────── 消息筛选 ───────────────────────────
function isChannelMessage(event) {
  if (event === null || typeof event !== 'object') return false;
  if (event.type !== 'channel/message' && event.type !== 'wake/channel') return false;
  const data = event.data;
  return data !== null && typeof data === 'object' && typeof data.chatId === 'string';
}

/** `onebot:group:953245617` → 三段；认不出来就 null（不许瞎猜） */
function parseSid(sid) {
  const parts = String(sid).split(':');
  if (parts.length < 3) return null;
  const chatId = parts[parts.length - 1] ?? '';
  const chatType = parts[parts.length - 2] ?? '';
  const channel = parts.slice(0, parts.length - 2).join(':');
  if (chatId === '' || chatType === '' || channel === '') return null;
  return { channel, chatType, chatId };
}

function matchesSid(data, match) {
  return data.chatId === match.chatId && (data.channel === undefined || data.channel === match.channel);
}

function clockOf(ts) {
  const at = new Date(ts);
  if (Number.isNaN(at.getTime())) return '--:--';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

function flat(value, max = 400) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 一行消息，行文与 read_channel 同一形状：`· 时:分 谁说：什么 ·m<id>` */
function lineOf(event) {
  const data = event.data ?? {};
  const who = flat(data.nickname ?? data.person ?? '?', 24);
  const body = flat(data.text ?? '', 400);
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const pictures = attachments.filter((item) => item !== null && typeof item === 'object' && item.type === 'image');
  const said = body === '' ? (pictures.length > 0 ? '［图］' : '（空消息）') : body;
  const id = typeof data.messageId === 'string' && data.messageId !== '' ? ` ·m${data.messageId}` : '';
  return `· ${clockOf(event.ts)} ${who}：${said}${id}`;
}

// ─────────────────────────── 状态 ───────────────────────────
function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // 没状态就是不在频道里
  }
  return { sid: null, enteredAtMs: 0, cursorSeq: 0 };
}

function saveState(state) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
  } catch {
    // 写不进去就退化成本次有效：不因为一个状态文件把工具调用弄失败
  }
}

/**
 * 10 分钟没有工具调用 ⇒ 已自动退出（惰性判定）。
 * 判据取"当前这次之前"最近的一条 `tool/call`：现在这条自己的事件已经在日志里了，
 * 用 5 秒的窗口把它排除掉，否则永远是"刚刚有调用"。
 */
function expiredAt(state, nowMs) {
  if (state === null || typeof state.sid !== 'string' || state.sid === '') return null;
  const stamps = [];
  for (const event of readAllEvents()) {
    if (event.type !== 'tool/call') continue;
    const at = Date.parse(String(event.ts ?? ''));
    if (Number.isFinite(at) && at <= nowMs - SELF_CALL_GUARD_MS) stamps.push(at);
  }
  const lastCall = stamps.length === 0 ? null : Math.max(...stamps);
  /**
   * 参照点必须是**两者取大**：日志里最后一条工具调用，与"这次进屋的时刻"。
   *
   * 只取前者的那次实测（2026-11-04）：进屋 5 秒后 `wait_messages` 就报"10 分钟没调用"——
   * 因为日志里最后一条 `tool/call` 是二十分钟前她发的某句话。进屋本身也是算数的动作，
   * 它在真实链路里会落一条 `tool/call`，但**不能靠那个巧合**：越过宿主的直接调用不会有，
   * 而且进屋后一分钟内就判定过期，逻辑上本来就不成立。
   */
  const enteredAtMs = typeof state.enteredAtMs === 'number' ? state.enteredAtMs : 0;
  const refusedFrom = Math.max(lastCall ?? 0, enteredAtMs);
  if (refusedFrom === 0) return null;
  return nowMs - refusedFrom > SESSION_TTL_MS ? refusedFrom : null;
}

function dropChannel(reason) {
  const state = loadState();
  state.sid = null;
  state.expired = reason;
  saveState(state);
  return state;
}

// ─────────────────────────── 工具 ───────────────────────────
const TOOLS = [
  {
    name: 'enter_channel',
    description: '进一个频道待着：返回该会话最近的消息，之后可用 wait_messages 等新消息。一次只能在一个频道；进别的频道会自动退出当前这个。',
    inputSchema: {
      type: 'object',
      properties: {
        sid: { type: 'string', description: '会话 id，例如 onebot:group:953245617 或 onebot:c2c:3652971137。' },
        count: { type: 'integer', minimum: 1, maximum: ENTER_COUNT_MAX, description: '进来先看多少条，默认 20。' },
      },
      required: ['sid'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_messages',
    description: `在当前频道等新消息（最多 ${WAIT_HARD_CAP_SECONDS} 秒）：有消息立刻返回，没有则等到点。等到了可以再等，也可以直接 speak。`,
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { type: 'integer', minimum: 1, maximum: WAIT_HARD_CAP_SECONDS, description: `等多久，默认 ${DEFAULT_WAIT_SECONDS}，硬顶 ${WAIT_HARD_CAP_SECONDS}。` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'leave_channel',
    description: '退出当前的频道。之后不再收这个频道的消息（已经看到的不会被收回）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function clampInt(value, fallback, min, max) {
  const number = Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

const AUTO_ENTER_WINDOW_MS = 30 * 60 * 1000;

function readChannelSidOf(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'tool/call') return null;
  const data = event.data;
  if (data === null || typeof data !== 'object' || data.name !== 'read_channel') return null;
  let args = data.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (args === null || typeof args !== 'object') return null;
  const sid = flat(args.sid, 200);
  return sid === '' ? null : sid;
}

function pickReadChannel(events, currentSid) {
  let found = null;
  for (const event of events) {
    const sid = readChannelSidOf(event);
    if (sid !== null && sid !== currentSid) found = { sid, event };
  }
  return found;
}

function enterFromRead(sid, event) {
  const match = parseSid(sid);
  if (match === null) return null;
  const nowMs = Date.now();
  saveState({ sid, match, enteredAtMs: nowMs, cursorSeq: typeof event.seq === 'number' ? event.seq : 0, auto: true });
  return loadState();
}

function findRecentRead() {
  const files = eventFiles().sort();
  if (files.length === 0) return null;
  let events;
  try {
    events = parseLines(readFileSync(join(eventsDir, files[files.length - 1]), 'utf8'));
  } catch {
    return null;
  }
  const floor = Date.now() - AUTO_ENTER_WINDOW_MS;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    const sid = readChannelSidOf(event);
    if (sid === null) continue;
    if (clockOf(event.ts) < floor) return null;
    return { sid, event };
  }
  return null;
}

function seedOffsets() {
  for (const name of eventFiles()) {
    try {
      offsets.set(name, statSync(join(eventsDir, name)).size);
    } catch {
      // 读不到就留给下一轮
    }
  }
}

function enterChannel(args) {
  const sid = flat(args.sid, 200);
  const match = parseSid(sid);
  if (match === null) return textResult(`sid 认不出来：${sid || '（空）'}。要形如 onebot:group:953245617。`, true);
  const count = clampInt(args.count, DEFAULT_ENTER_COUNT, 1, ENTER_COUNT_MAX);
  const nowMs = Date.now();
  const previous = loadState();
  const expired = expiredAt(previous, nowMs);
  const leftNote = typeof previous.sid === 'string' && previous.sid !== ''
    ? `已离开 ${previous.sid}${expired === null ? '（换频道）' : '（10 分钟没有工具调用，自动退出）'}`
    : null;

  const all = readAllEvents();
  const history = all.filter((event) => isChannelMessage(event) && matchesSid(event.data, match)).slice(-count);
  const latestSeq = all.length === 0 ? 0 : all[all.length - 1].seq;
  saveState({ sid, match, enteredAtMs: nowMs, cursorSeq: latestSeq });

  const lines = history.length === 0
    ? ['（这个频道我这边还没有消息记录）']
    : history.map(lineOf);
  const body = [
    leftNote,
    `已进频道 ${sid}`,
    history.length === 0 ? '刚才这屋在聊：' : `刚才这屋在聊（最近 ${history.length} 条）：`,
    ...lines,
    history.length === 0 ? null : '（更早的用 read_channel 翻）',
    '',
    '接下来三条路：',
    '· 直接 speak 接话',
    '· 立刻 read_channel 翻更早的',
    `· wait_messages 等新消息（最多 ${WAIT_HARD_CAP_SECONDS} 秒；一次一个频道）`,
  ].filter((item) => item !== null);
  return textResult(body.join('\n'));
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitMessages(args, progressToken) {
  const pending = readNewEvents();
  let state = loadState();
  const switchedOnEntry = pickReadChannel(pending, typeof state.sid === 'string' ? state.sid : '');
  if (switchedOnEntry !== null) state = enterFromRead(switchedOnEntry.sid, switchedOnEntry.event) ?? state;
  if (typeof state.sid !== 'string' || state.sid === '') {
    const recent = findRecentRead();
    if (recent === null) return textResult('你不在任何频道里。先用 read_channel 看一眼那个频道，就自动进去了。', true);
    state = enterFromRead(recent.sid, recent.event) ?? state;
  }
  const expired = expiredAt(state, Date.now());
  if (expired !== null) {
    dropChannel('10 分钟没有工具调用');
    const recent = findRecentRead();
    if (recent === null || recent.sid === state.sid) {
      return textResult(`已自动退出 ${state.sid}（10 分钟没有任何工具调用）。要再看就 read_channel 一眼。`, true);
    }
    state = enterFromRead(recent.sid, recent.event) ?? state;
  }
  const seconds = clampInt(args.seconds, DEFAULT_WAIT_SECONDS, 1, WAIT_HARD_CAP_SECONDS);
  const deadline = Date.now() + seconds * 1000;
  let cursor = typeof state.cursorSeq === 'number' ? state.cursorSeq : 0;
  const collected = [];
  let lastProgress = Date.now();

  while (Date.now() < deadline) {
    let switched = null;
    for (const event of readNewEvents()) {
      const readSid = readChannelSidOf(event);
      if (readSid !== null && readSid !== state.sid) {
        switched = { sid: readSid, event };
        break;
      }
      if (event.seq <= cursor) continue;
      cursor = event.seq;
      if (isChannelMessage(event) && matchesSid(event.data, state.match)) collected.push(event);
    }
    if (switched !== null) {
      const moved = enterFromRead(switched.sid, switched.event);
      if (moved !== null) {
        return textResult([
          `已离开 ${state.sid}（换频道）`,
          `已进频道 ${moved.sid}：刚才 read_channel 看的就是这里。`,
          '',
          '接下来：wait_messages 等新消息，或者直接 speak。',
        ].join('\n'));
      }
    }
    if (collected.length > 0) break;
    if (progressToken !== undefined && Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: 0, total: 1 } });
      lastProgress = Date.now();
    }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }

  state.cursorSeq = cursor;
  saveState(state);

  if (collected.length === 0) {
    return textResult(`这 ${seconds} 秒 ${state.sid} 没人说话。\n可以再 wait_messages，也可以 speak，或者 leave_channel。`);
  }
  return textResult([
    `${state.sid} 来了 ${collected.length} 条：`,
    ...collected.map(lineOf),
    '',
    `可以再 wait_messages（最多 ${WAIT_HARD_CAP_SECONDS} 秒），也可以直接 speak。`,
  ].join('\n'));
}

function leaveChannel() {
  const state = loadState();
  if (typeof state.sid !== 'string' || state.sid === '') return textResult('你本来就不在任何频道里。');
  dropChannel(null);
  return textResult(`已退出 ${state.sid}。之后这个频道的消息不会再送到你眼前（已经看到的不会被收回）。`);
}

async function callTool(name, args, progressToken) {
  if (args !== null && typeof args === 'object' && Array.isArray(args)) return textResult('工具参数必须是对象', true);
  const safeArgs = args !== null && typeof args === 'object' ? args : {};
  if (name === 'enter_channel') return enterChannel(safeArgs);
  if (name === 'wait_messages') return await waitMessages(safeArgs, progressToken);
  if (name === 'leave_channel') return leaveChannel();
  return textResult(`未知工具：${name}`, true);
}

// ─────────────────────────── MCP 主循环 ───────────────────────────
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'linre-presence', version: '0.1.0' },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === 'tools/call') {
    const params = message.params ?? {};
    const progressToken = params._meta?.progressToken;
    try {
      send({ jsonrpc: '2.0', id: message.id, result: await callTool(params.name, params.arguments ?? {}, progressToken) });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, result: textResult(`linre-presence: ${error instanceof Error ? error.message : String(error)}`, true) });
    }
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

seedOffsets();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line === '') continue;
    try {
      void handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`invalid MCP message: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
});
