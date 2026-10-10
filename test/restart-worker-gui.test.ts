/**
 * 自重启那条路的**界面拉起**（`src/runtime/restart-worker.ts` 的 `startGuiProcess`）—— 替身验收。
 *
 * 为什么单独立案：`docs/restart-gui-launch-shape.md` 的结论是"拉界面的三条路必须**同一形状**"
 * （`Start-Process -FilePath <exe 绝对路径> -WorkingDirectory <exe 所在目录> -PassThru`），
 * 而第三条路（这里）过去是 `spawn(guiExe, {cwd, detached})` —— 与两条脚本都不是同一种写法。
 * 换成同一种形状之后，判据要能回答三件事，而且**不是**"代码里写着"：
 *
 *   ① 它给的 pid 是不是**那个界面自己**（`-PassThru`）—— 起来一个替身、读它还在不在；
 *   ② 工作目录是不是**exe 所在目录** —— 判据取**替身自己写下的 cwd**（`cwd-nowin.cs` 的
 *      `<exe>.cwd.txt`），不是"代码里传了 `-WorkingDirectory`"这种实现细节；
 *      Flutter 的产物要**就地**找 `flutter_windows.dll` 与 `data\`，工作目录错了就是起来即退；
 *   ③ "起来就退"与"根本起不来"都必须报 0（脚本那边叫 `appeared-then-exited` /
 *      `spawn-threw`）—— 报了一个已经死掉的 pid，就是"界面没起来"被说成"起来了"。
 *
 * 替身一律 `/target:winexe` + 无窗口/立刻返回：**一个真界面都不弹**，也不碰用户正在用的那份
 * （`D:\IrmiaAgent\...\irmia_gui.exe`，本文件从头到尾不提它）。
 * 沙盒在 `%TEMP%` 下，收尾按"替身 exe 全路径在沙盒里"清，判据绝不含糊到按名字杀。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startGuiProcess } from '../src/runtime/restart-worker.ts';

const IS_WINDOWS = process.platform === 'win32';
/** 仓库根（替身源码在 `test\stand-in\` 下；不靠 cwd，`node --test` 从哪儿跑都成立） */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 与 `test\restart-*.ps1` 那几支同一个编译器（.NET Framework 自带，不装东西） */
function cscPath(): string {
  const root = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (existsSync(root)) return root;
  return join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe');
}

function compile(out: string, source: string): void {
  const built = spawnSync(cscPath(), ['/nologo', '/target:winexe', `/out:${out}`, source], { encoding: 'utf8' });
  assert.equal(built.status, 0, `替身编译失败：${built.stdout ?? ''}${built.stderr ?? ''}`);
  assert.ok(existsSync(out), `替身没生成：${out}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('自重启的界面拉起：形状与两条脚本同一种（替身 exe，一个真界面都不弹）', { skip: !IS_WINDOWS }, () => {
  const box = mkdtempSync(join(tmpdir(), 'irmia-worker-gui-'));
  const started: number[] = [];
  try {
    // ── 替身①：活着 + **自己写下 cwd**（`test\stand-in\cwd-nowin.cs`，无窗口，默认活 60 秒）──
    const stay = join(box, 'gui_stay.exe');
    compile(stay, join(PROJECT_ROOT, 'test', 'stand-in', 'cwd-nowin.cs'));

    const pid = startGuiProcess(stay);
    assert.ok(pid > 0, '活着的替身必须给出 pid（`-PassThru` 给的就是它自己）');
    started.push(pid);
    assert.equal(alive(pid), true, '3 秒复看时它还活着 ⇒ 这个 pid 是真的');

    const cwdFile = `${stay}.cwd.txt`;
    assert.ok(existsSync(cwdFile), `替身没写下 cwd 读数（${cwdFile}）——工作目录这条判据就没证据了`);
    const cwdText = readFileSync(cwdFile, 'utf8');
    assert.match(cwdText, /cwd=/u);
    const cwd = (cwdText.split(/\r?\n/u).find((line) => line.startsWith('cwd=')) ?? '').slice(4).trim();
    assert.equal(
      cwd.toLowerCase(), box.toLowerCase(),
      `工作目录必须是 exe 所在目录（判据取替身自己写下的读数，不是"代码里传了 -WorkingDirectory"）：${cwdText}`,
    );

    // ── 替身②：起来就退（无窗口，立刻返回）⇒ 必须报 0，不许给一个已经死掉的 pid ──
    const die = join(box, 'gui_die.exe');
    const dieSource = join(box, 'die.cs');
    writeFileSync(dieSource, 'internal static class Die { private static int Main(string[] a) { return 0; } }\n', 'utf8');
    compile(die, dieSource);
    assert.equal(startGuiProcess(die), 0, '起来就退的报 0（脚本那边叫 appeared-then-exited）');

    // ── 替身③：根本不是个程序（零字节的 .exe）⇒ `Start-Process` 当场抛 ⇒ 必须报 0、不许抛出去 ──
    const bad = join(box, 'gui_bad.exe');
    writeFileSync(bad, '', 'utf8');
    assert.equal(startGuiProcess(bad), 0, '起不来就是 0（拉起器那一层不该因此崩掉整次重启）');

    // ── 路径不存在 ⇒ 同上（这条路上不许有任何异常逃出去）──
    assert.equal(startGuiProcess(join(box, 'no-such.exe')), 0, '没有这个文件也是 0');
  } finally {
    for (const pid of started) {
      try {
        process.kill(pid);
      } catch {
        /* 已经自己退了 */
      }
    }
    try {
      rmSync(box, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发的句柄占用：清理失败不影响断言结论 */
    }
  }
});
