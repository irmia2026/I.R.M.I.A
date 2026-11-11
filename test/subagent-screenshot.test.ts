/**
 * worker 专用 `screenshot` 工具测试。
 *
 * 四组：
 *   ① 装配（只给 worker；workspace 缺失不注入；schema 只允许 screen/window）；
 *   ② 参数/边界（mode/window/path 校验；绝对路径、`..`、非 PNG、已存在文件全部在 spawn 前拒绝）；
 *   ③ 注入 runner 的执行面（成功结构、文件名、自定义路径、真实 PNG 头校验、PS 业务错误、
 *      超时/取消/spawn 失败、坏 JSON、写后文件缺失/非 PNG、审计事件不含绝对路径）；
 *   ④ 真实截图冒烟（有桌面才跑；本机无 pwsh/无桌面时如实 skip）。
 *
 * 为什么默认注入 runner：截图是真读屏幕的操作。单元用例不该依赖“测试机此刻有桌面、
 * 屏幕上是什么”；真实冒烟单独一条、失败原因如实报。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  createScreenshotTool, MAX_SCREENSHOT_TIMEOUT_MS, screenshotFileName,
  type ScreenshotCommandInput, type ScreenshotRunner,
} from '../src/runtime/subagent-screenshot.ts';
import { resetShellBinaryCache, resolveShellBinary } from '../src/runtime/subagent-shell.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const CTX: ToolContext = {
  callId: 'call', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: '',
};

function temp(t: TestContext): string {
  const dir = tempDirSync('irmia-subagent-screenshot-');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function workspaceIn(t: TestContext): {root: string; workspace: string} {
  const root = temp(t);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, {recursive: true});
  return {root, workspace};
}

/** 33 字节的“足够被 Node 侧 PNG 头校验接受”的假文件（真 PNG 由 PowerShell 写）。 */
function writePngHeader(path: string, width: number, height: number, padding = 0): void {
  const png = Buffer.alloc(33 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;  // bit depth
  png[25] = 2;  // color type
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, png);
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

interface FakeOptions {
  width?: number;
  height?: number;
  title?: string;
  padding?: number;
  writeFile?: boolean;
  junkFile?: boolean;
  stdout?: string;
  result?: Partial<Awaited<ReturnType<ScreenshotRunner>>>;
}

function fakeRunner(calls: ScreenshotCommandInput[], options: FakeOptions = {}): ScreenshotRunner {
  return async (input) => {
    calls.push(input);
    if (options.result !== undefined) {
      return {code: 0, stdout: '', stderr: '', aborted: false, timedOut: false, ...options.result};
    }
    const target = input.env['IRMIA_SHOT_PATH'];
    assert.equal(typeof target, 'string');
    if (options.writeFile !== false) {
      if (options.junkFile === true) {
        mkdirSync(join(target!, '..'), {recursive: true});
        writeFileSync(target!, 'not-a-png');
      } else {
        writePngHeader(target!, options.width ?? 640, options.height ?? 480, options.padding ?? 0);
      }
    }
    if (options.stdout !== undefined) {
      return {code: 0, stdout: options.stdout, stderr: '', aborted: false, timedOut: false};
    }
    const payload = {
      ok: true, width: options.width ?? 640, height: options.height ?? 480,
      bytes: options.padding ?? 33,
      ...(options.title === undefined ? {} : {titleB64: base64(options.title)}),
    };
    return {code: 0, stdout: JSON.stringify(payload), stderr: '', aborted: false, timedOut: false};
  };
}

function parseContent(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

// ── ① 装配与 schema ─────────────────────────────────────

test('screenshot 工具只给 worker：非 worker / workspace 缺失都不注入；schema 只有 screen/window', (t) => {
  const {workspace} = workspaceIn(t);
  assert.equal(createScreenshotTool({profileId: 'researcher', workspace, agentId: 'a'}), null);
  assert.equal(createScreenshotTool({profileId: 'general', workspace, agentId: 'a'}), null);
  assert.equal(createScreenshotTool({profileId: 'scribe', workspace, agentId: 'a'}), null);
  assert.equal(createScreenshotTool({profileId: 'worker', workspace: join(workspace, 'nope'), agentId: 'a'}), null);

  const tool = createScreenshotTool({profileId: 'worker', workspace, agentId: 'a'});
  assert.notEqual(tool, null);
  assert.equal(tool!.name, 'screenshot');
  assert.equal(tool!.executionMode, 'exclusive');
  assert.equal(tool!.sideEffect, 'idempotent', '只写自己 workspace 的新文件，不标 destructive');
  assert.equal(tool!.timeoutMs, MAX_SCREENSHOT_TIMEOUT_MS);
  const schema = tool!.parameters as {
    type: string; properties: Record<string, {type?: string; enum?: string[]}>; additionalProperties?: boolean;
  };
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties['mode']?.enum, ['screen', 'window']);
  assert.equal(schema.properties['window']?.type, 'string');
  assert.equal(schema.properties['path']?.type, 'string');
  assert.match(tool!.description, /workspace/u);
  assert.match(tool!.description, /PNG/u);
});

test('screenshot 文件名：本地时间戳、按毫秒唯一；默认落在 screenshots/ 下', () => {
  const name = screenshotFileName(Date.UTC(2026, 10, 5, 13, 36, 5, 123));
  assert.match(name, /^\d{8}-\d{6}-\d{3}$/u);
  assert.notEqual(screenshotFileName(1), screenshotFileName(2));
});

// ── ② 参数与边界（不 spawn） ─────────────────────────────

test('screenshot 参数/边界错误：非法 mode、screen+window、window 缺标题、越界/非 PNG/已存在路径均在 spawn 前拒绝', async (t) => {
  const {root, workspace} = workspaceIn(t);
  const calls: ScreenshotCommandInput[] = [];
  const tool = createScreenshotTool({
    profileId: 'worker', workspace, agentId: 'a', runner: fakeRunner(calls), nowMs: () => Date.UTC(2026, 10, 5, 1, 2, 3, 4),
  })!;
  const outside = join(root, 'outside');
  mkdirSync(outside, {recursive: true});
  writeFileSync(join(workspace, 'exists.png'), 'x');

  const cases: Array<[Record<string, unknown>, string]> = [
    [{mode: 'list'}, 'E_INVALID_ARGS'],
    [{mode: 'screen', window: 'x'}, 'E_INVALID_ARGS'],
    [{mode: 'window'}, 'E_INVALID_ARGS'],
    [{mode: 'window', window: '   '}, 'E_INVALID_ARGS'],
    [{window: 42}, 'E_INVALID_ARGS'],
    [{path: join(outside, 'a.png')}, 'E_UNSAFE_PATH'],
    [{path: 'C:\\Windows\\a.png'}, 'E_UNSAFE_PATH'],
    [{path: '\\\\server\\share\\a.png'}, 'E_UNSAFE_PATH'],
    [{path: '../outside.png'}, 'E_UNSAFE_PATH'],
    [{path: 'sub/../../outside.png'}, 'E_UNSAFE_PATH'],
    [{path: 'not-a-png.txt'}, 'E_UNSAFE_PATH'],
    [{path: 'exists.png'}, 'E_UNSAFE_PATH'],
    [{path: 'sub/../a.png'}, 'E_UNSAFE_PATH'],
  ];
  for (const [args, code] of cases) {
    const result = await tool.handler(args, CTX);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.equal(result.error?.code, code, JSON.stringify(args));
  }
  assert.equal(calls.length, 0, '全部边界判定必须在 spawn 之前完成');

  // 默认路径：runner 收到的就是 workspace 内 screenshots/ 下的新文件。
  const ok = await tool.handler({}, CTX);
  assert.equal(ok.isError, undefined, ok.content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.env['IRMIA_SHOT_MODE'], 'screen');
  assert.equal(calls[0]!.env['IRMIA_SHOT_WINDOW'], '');
  assert.match(calls[0]!.env['IRMIA_SHOT_PATH']!, /[\\/]screenshots[\\/]\d{8}-\d{6}-\d{3}\.png$/u);
  assert.equal(calls[0]!.cwd, realpathSync.native(resolve(workspace)));
  assert.ok(calls[0]!.args.includes('-EncodedCommand'));
});

// ── ③ 注入 runner 的执行面 ──────────────────────────────

test('screenshot 成功结构：默认路径/宽高/字节数/绝对路径；自定义子目录路径也不覆盖', async (t) => {
  const {workspace} = workspaceIn(t);
  const calls: ScreenshotCommandInput[] = [];
  const tool = createScreenshotTool({
    profileId: 'worker', workspace, agentId: 'a', runner: fakeRunner(calls, {width: 800, height: 600}),
  })!;
  const result = await tool.handler({}, CTX);
  assert.equal(result.isError, undefined, result.content);
  const payload = parseContent(result.content);
  assert.equal(payload['ok'], true);
  const workspaceReal = realpathSync.native(resolve(workspace));
  const outputPath = String(payload['path']);
  assert.equal(resolve(outputPath).startsWith(workspaceReal), true, '返回的是 workspace 内的绝对路径');
  assert.match(outputPath.replaceAll('\\', '/'), /\/screenshots\/\d{8}-\d{6}-\d{3}\.png$/u);
  assert.equal(payload['width'], 800);
  assert.equal(payload['height'], 600);
  assert.equal(payload['mode'], 'screen');
  assert.ok(existsSync(outputPath), 'PNG 必须真的落在 workspace 里');
  assert.equal(payload['bytes'], statSync(outputPath).size, '字节数以磁盘文件为准');
  assert.equal(payload['windowTitle'], undefined, 'screen 模式没有窗口标题');

  const custom = await tool.handler({path: 'shots/ui/a.png'}, CTX);
  assert.equal(custom.isError, undefined, custom.content);
  assert.equal(resolve(String(parseContent(custom.content)['path'])),
    join(workspaceReal, 'shots', 'ui', 'a.png'));
  assert.ok(existsSync(join(workspace, 'shots', 'ui', 'a.png')));

  // 不覆盖已有文件（即使它是上一次截图）。
  const again = await tool.handler({path: 'shots/ui/a.png'}, CTX);
  assert.equal(again.error?.code, 'E_UNSAFE_PATH');
  assert.match(again.content, /已存在/u);
});

test('screenshot window 模式：标题传到脚本、返回匹配到的窗口标题', async (t) => {
  const {workspace} = workspaceIn(t);
  const calls: ScreenshotCommandInput[] = [];
  const tool = createScreenshotTool({
    profileId: 'worker', workspace, agentId: 'a',
    runner: fakeRunner(calls, {width: 1024, height: 768, title: '设计稿 — 浏览器'}),
  })!;
  const result = await tool.handler({mode: 'window', window: '浏览器'}, CTX);
  assert.equal(result.isError, undefined, result.content);
  assert.equal(calls[0]!.env['IRMIA_SHOT_MODE'], 'window');
  assert.equal(calls[0]!.env['IRMIA_SHOT_WINDOW'], '浏览器');
  const payload = parseContent(result.content);
  assert.equal(payload['width'], 1024);
  assert.equal(payload['height'], 768);
  assert.equal(payload['mode'], 'window');
  assert.equal(payload['windowTitle'], '设计稿 — 浏览器');
});

test('screenshot 错误面：窗口不存在/无桌面/捕获失败/超时/取消/spawn 失败/坏 JSON 都有明确错误', async (t) => {
  const {workspace} = workspaceIn(t);
  const cases: Array<{
    args: Record<string, unknown>;
    options: FakeOptions;
    code: string;
    pattern?: RegExp;
  }> = [
    {
      args: {mode: 'window', window: '不存在的窗口'},
      options: {result: {stdout: JSON.stringify({ok: false, code: 'window-not-found', messageB64: base64('x')})}},
      code: 'screenshot-window-not-found',
      pattern: /不存在的窗口/u,
    },
    {
      args: {},
      options: {result: {stdout: JSON.stringify({ok: false, code: 'no-desktop', messageB64: base64('x')})}},
      code: 'screenshot-no-desktop',
    },
    {
      args: {},
      options: {result: {stdout: JSON.stringify({ok: false, code: 'capture-failed', messageB64: base64('gdi boom')})}},
      code: 'screenshot-capture-failed',
      pattern: /gdi boom/u,
    },
    {args: {}, options: {result: {code: null, timedOut: true}}, code: 'E_TIMEOUT'},
    {args: {}, options: {result: {code: null, aborted: true}}, code: 'E_ABORTED'},
    {args: {}, options: {result: {code: null, spawnError: 'ENOENT'}}, code: 'E_SPAWN_FAILED'},
    {args: {}, options: {stdout: 'not json at all'}, code: 'screenshot-failed'},
  ];
  for (const row of cases) {
    const tool = createScreenshotTool({
      profileId: 'worker', workspace, agentId: 'a', runner: fakeRunner([], row.options),
    })!;
    const result = await tool.handler(row.args, CTX);
    assert.equal(result.isError, true, row.code);
    assert.equal(result.error?.code, row.code);
    if (row.pattern !== undefined) assert.match(result.content, row.pattern);
  }
});

test('screenshot 写后校验：脚本说成功但文件缺失/不是 PNG 都拒绝；越界输出会删掉', async (t) => {
  const {workspace} = workspaceIn(t);

  const missing = createScreenshotTool({
    profileId: 'worker', workspace, agentId: 'a', runner: fakeRunner([], {writeFile: false}),
  })!;
  const missingResult = await missing.handler({}, CTX);
  assert.equal(missingResult.error?.code, 'screenshot-invalid-output');
  assert.match(missingResult.content, /不存在|不是合法 PNG/u);

  const junk = createScreenshotTool({
    profileId: 'worker', workspace, agentId: 'a', runner: fakeRunner([], {junkFile: true}),
  })!;
  const junkResult = await junk.handler({}, CTX);
  assert.equal(junkResult.error?.code, 'screenshot-invalid-output');
  const leftover = readFirstScreenshot(workspace);
  assert.equal(leftover, null, '坏 PNG 必须删除，不能在 workspace 里留半截文件');
});

function readFirstScreenshot(workspace: string): string | null {
  const dir = join(workspace, 'screenshots');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir)[0];
  return file === undefined ? null : join(dir, file);
}

test('screenshot 审计事件：成功/拒绝都落事件，且不带绝对路径/窗口全文', async (t) => {
  const {workspace} = workspaceIn(t);
  const audits: Array<Record<string, unknown>> = [];
  const tool = createScreenshotTool({
    profileId: 'worker', workspace, agentId: 'a', emit: (row) => audits.push(row),
    runner: fakeRunner([], {width: 300, height: 200, title: '很敏感的窗口标题'}),
  })!;
  await tool.handler({}, CTX);
  const ok = audits.find((row) => row['action'] === 'screenshot');
  assert.equal(ok?.['ok'], true);
  assert.equal(ok?.['width'], 300);
  assert.equal(ok?.['height'], 200);
  assert.equal(typeof ok?.['bytes'], 'number');
  assert.equal(typeof ok?.['durationMs'], 'number');
  assert.match(String(ok?.['outputRelative']), /^screenshots\/\d{8}-\d{6}-\d{3}\.png$/u,
    '审计只写相对输出路径');
  assert.equal(ok?.['path'], undefined, '审计不写绝对输出路径');

  const denied = await tool.handler({path: '../escape.png'}, CTX);
  assert.equal(denied.error?.code, 'E_UNSAFE_PATH');
  assert.ok(audits.some((row) => row['action'] === 'screenshot-denied' && row['code'] === 'screenshot-path-invalid'));

  const serialized = JSON.stringify(audits);
  assert.equal(serialized.includes(realpathSync.native(resolve(workspace))), false, '审计事件不得带绝对路径');
  assert.equal(serialized.includes('很敏感的窗口标题'), false, '审计事件不得带窗口标题全文');
});

// ── ④ 真实截图冒烟 ──────────────────────────────────────

test('screenshot 真实冒烟：有桌面就截一张真 PNG；无 pwsh/无桌面时如实 skip', async (t) => {
  const {workspace} = workspaceIn(t);
  resetShellBinaryCache();
  if (resolveShellBinary() === null) {
    t.skip('本机没有 pwsh/powershell.exe，跳过真实截图');
    return;
  }
  const tool = createScreenshotTool({profileId: 'worker', workspace, agentId: 'a'})!;
  const result = await tool.handler({}, CTX);
  if (result.isError === true) {
    // 无交互式桌面/会话 0 的机器上截图本来就该失败——如实报，别把环境限制伪装成通过。
    if (result.error?.code === 'screenshot-no-desktop' || result.error?.code === 'screenshot-capture-failed') {
      t.skip(`当前环境没有可截取的桌面：${result.error.code}`);
      return;
    }
  }
  assert.equal(result.isError, undefined, result.content);
  const payload = parseContent(result.content);
  assert.equal(payload['ok'], true);
  assert.ok(Number(payload['width']) > 0);
  assert.ok(Number(payload['height']) > 0);
  const file = String(payload['path']);
  assert.equal(resolve(file).startsWith(realpathSync.native(resolve(workspace))), true);
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '真 PNG 签名');
  assert.equal(bytes.length, payload['bytes']);
});
