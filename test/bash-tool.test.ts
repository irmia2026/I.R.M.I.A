import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bashAbsolutePathsIn, buildBashSessionBootstrap, buildBashSessionRoundScript, shellToolName,
} from '../src/tools/bash.ts';
import { createPwshTool, detectPowerShell, resetPowerShellProbeCache } from '../src/tools/pwsh.ts';
import { screenCommand } from '../src/tools/pwsh.ts';
import { decideAuthz, MACHINE_TOOLS } from '../src/runtime/authz.ts';
import type { ToolContext } from '../src/tools/types.ts';

afterEach(() => resetPowerShellProbeCache());

function context(root: string, patch: Partial<ToolContext> = {}): ToolContext {
  return { callId: 'bash-test', turn: 1, step: 1, signal: new AbortController().signal, workspaceRoot: root, ...patch };
}

async function harness(t: { after: (fn: () => unknown) => void }) {
  resetPowerShellProbeCache();
  const root = await mkdtemp(join(tmpdir(), 'irmia-bash-'));
  const tool = createPwshTool({ platform: 'linux', destructiveEnabled: true });
  t.after(async () => { await tool.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await tool.probe();
  return { root, tool, ctx: context(root) };
}

test('按平台选择工具名与权限分类', () => {
  assert.equal(shellToolName('win32'), 'pwsh');
  assert.equal(shellToolName('linux'), 'bash');
  assert.equal(shellToolName('darwin'), 'bash');
  assert.equal(createPwshTool({ platform: 'linux' }).name, 'bash');
  assert.ok(MACHINE_TOOLS.includes('bash'));
  assert.equal(decideAuthz({ scenario: 'guest', tool: 'bash', hardRefusal: true }).allow, false);
});

test('非 Windows 探测 Bash，不调用 PowerShell 依赖探测', async () => {
  resetPowerShellProbeCache();
  const calls: string[] = [];
  const result = await detectPowerShell({ platform: 'linux',
    runProbe: async (exe) => { calls.push(exe); return '5.2.15'; },
    deps: { probe: async () => { throw new Error('不应探测 PowerShell'); } },
  });
  assert.equal(result.kind, 'bash');
  assert.equal(result.version, '5.2.15');
  assert.deepEqual(calls, ['bash']);
  assert.equal((await detectPowerShell({ platform: 'linux' })).version, result.version);
});

test('找不到 Bash 时明确报错', async () => {
  resetPowerShellProbeCache();
  await assert.rejects(() => detectPowerShell({ platform: 'linux', runProbe: async () => null }), /Bash.*PATH/u);
});

test('bootstrap 与命令输入分离，macOS 采用兼容的 base64 解码', () => {
  assert.match(buildBashSessionBootstrap('marker', 'linux'), /base64 -d/u);
  assert.match(buildBashSessionBootstrap('marker', 'darwin'), /base64 -D/u);
  assert.match(buildBashSessionBootstrap('marker'), /eval.*<\/dev\/null/u);
  assert.match(buildBashSessionRoundScript('pwd', "/tmp/owner's folder"), /'\\''/u);
});

test('Linux 危险命令黑名单只检查，不执行危险命令', () => {
  for (const command of ['rm --recursive --force /', 'rm -rf /', 'dd if=x of=/dev/sda', 'reboot', 'chmod -R 777 /', 'chown -R root /']) {
    assert.notEqual(screenCommand(command, 'linux'), null, command);
  }
  for (const command of ['pwd', "printf '%s' hello", 'ls -la /tmp']) {
    assert.equal(screenCommand(command, 'linux'), null, command);
  }
});

test('POSIX 路径扫描识别引号与重定向，不把 URL 和标准流当文件路径', () => {
  assert.deepEqual(bashAbsolutePathsIn('cat /tmp/outside.txt'), ['/tmp/outside.txt']);
  assert.deepEqual(bashAbsolutePathsIn("cat '/tmp/a b.txt' > /tmp/result.txt"), ['/tmp/a b.txt', '/tmp/result.txt']);
  assert.deepEqual(bashAbsolutePathsIn('curl https://example.com/x >/dev/null'), []);
});

test('真实 Bash 单次执行：中文、引号、标准错误与退出码', async (t) => {
  const { tool, ctx } = await harness(t);
  const result = await tool.handler({ command: "printf '%s\\n' '中文与引号正常'; printf 'stderr-ok\\n' >&2; exit 9", persistent: false }, ctx);
  assert.equal(result.isError, undefined, result.content);
  assert.match(result.content, /^中文与引号正常/u);
  assert.match(result.content, /stderr-ok/u);
  assert.match(result.content, /exit code: 9/u);
  assert.match(result.content, /\[shell\] bash/u);
});

test('真实 Bash 持久会话：变量、函数和显式目录跨多次调用保持', async (t) => {
  const { tool, root, ctx } = await harness(t);
  await tool.handler({ command: 'x=1; tag() { printf "tag-ok\\n"; }' }, ctx);
  const next = await tool.handler({ command: 'x=$((x+41)); printf "%s\\n" "$x"; tag' }, ctx);
  assert.match(next.content, /^42\ntag-ok/u);
  const dir = join(root, "folder with quote'");
  await mkdir(dir);
  const cwd = await tool.handler({ command: 'basename "$PWD"', workdir: dir.replace(/\\/gu, '/') }, ctx);
  assert.match(cwd.content, /^folder with quote'/u);
  const kept = await tool.handler({ command: 'basename "$PWD"; printf "%s\\n" "$x"' }, ctx);
  assert.match(kept.content, /^folder with quote'\n42/u);
});

test('命令不能读走宿主的下一帧，结束后仍可执行下一条', async (t) => {
  const { tool, ctx } = await harness(t);
  const read = await tool.handler({ command: 'read -r ignored; printf "done\\n"' }, ctx);
  assert.match(read.content, /^done/u);
  const next = await tool.handler({ command: 'printf "next-round\\n"' }, ctx);
  assert.match(next.content, /^next-round/u);
});

test('单次执行不保留变量，exit 后持久会话会重建', async (t) => {
  const { tool, ctx } = await harness(t);
  await tool.handler({ command: 'isolated=5', persistent: false }, ctx);
  const separate = await tool.handler({ command: 'printf "%s\\n" "${isolated:-empty}"', persistent: false }, ctx);
  assert.match(separate.content, /^empty/u);
  const exited = await tool.handler({ command: 'printf "leaving\\n"; exit 7' }, ctx);
  assert.match(exited.content, /exit code: 7/u);
  assert.match(exited.content, /持久会话.*终止/u);
  const rebuilt = await tool.handler({ command: 'printf "rebuilt\\n"' }, ctx);
  assert.match(rebuilt.content, /^rebuilt/u);
  assert.match(rebuilt.content, /持久会话已在本次调用前重建/u);
});

test('真实 Bash 超时与取消：停止后下一次调用可用', async (t) => {
  const { tool, ctx } = await harness(t);
  const timeout = await tool.handler({ command: 'sleep 30', timeoutMs: 300 }, ctx);
  assert.equal(timeout.error?.code, 'E_TIMEOUT');
  const controller = new AbortController();
  const pending = tool.handler({ command: 'sleep 30' }, context(ctx.workspaceRoot, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 300);
  assert.equal((await pending).error?.code, 'E_ABORTED');
  const result = await tool.handler({ command: 'printf "alive\\n"' }, ctx);
  assert.match(result.content, /^alive/u);
});

test('边界外路径拒绝，未开启 destructive 时不执行', async (t) => {
  const { tool, root, ctx } = await harness(t);
  const outside = await tool.handler({ command: 'cat /tmp/irmia-outside-file' }, ctx);
  assert.equal(outside.error?.code, 'E_UNSAFE_PATH');
  const cwd = await tool.handler({ command: 'pwd', workdir: join(root, '..') }, ctx);
  assert.equal(cwd.error?.code, 'E_UNSAFE_PATH');
  const gated = createPwshTool({ platform: 'linux' });
  const result = await gated.handler({ command: 'printf should-not-run' }, ctx);
  assert.equal(result.error?.code, 'E_DESTRUCTIVE_DISABLED');
});

test('真实 Bash 后台任务沿用 jobs 回调与输出落盘', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'irmia-bash-job-'));
  const finished: Array<{ exitCode: number | null; outputRef?: string }> = [];
  const tool = createPwshTool({ platform: 'linux', destructiveEnabled: true, jobsDir: join(root, 'jobs'),
    jobs: { started: () => {}, finished: (job) => finished.push(job) },
  });
  t.after(async () => { await tool.shutdown(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const launched = await tool.handler({ command: 'printf "background-complete\\n"', runInBackground: true }, context(root));
  assert.equal(launched.isError, undefined, launched.content);
  assert.match(launched.content, /后台任务已启动/u);
  const deadline = Date.now() + 10000;
  while (finished.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished.length, 1);
  assert.equal(finished[0]!.exitCode, 0);
  assert.match(await readFile(finished[0]!.outputRef!, 'utf8'), /background-complete/u);
});
