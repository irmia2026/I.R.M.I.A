/**
 * 重启链条的 shell 探测（`src/runtime/restart-shell.ts`）。
 *
 * 钉的是"哪种环境挑到哪一个"：这些环境造不出来（不能为了测试删掉系统里的 pwsh），
 * 所以把环境变量与"文件在不在"都做成注入点，四种情形一次摆完。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FALLBACK_SHELL, findOnPath, resolveRestartShell } from '../src/runtime/restart-shell.ts';

/** 造一个"只有这些路径存在"的世界 */
function world(existing: readonly string[]): (path: string) => boolean {
  const set = new Set(existing);
  return (path: string) => set.has(path);
}

test('显式指定 IRMIA_PWSH 优先（而且必须真的存在）', () => {
  const custom = 'C:\\path\\to\\pwsh.exe';
  assert.equal(
    resolveRestartShell({
      env: { IRMIA_PWSH: custom, PATH: 'C:\\Windows\\System32' },
      fileExists: world([custom, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
    }),
    custom,
  );
  // 指了一个不存在的地方：不能原样返回它（那正是"配了却不生效"最难查的一类故障），
  // 继续往下探测
  assert.equal(
    resolveRestartShell({
      env: { IRMIA_PWSH: 'D:\\没有这个\\pwsh.exe' },
      fileExists: world(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
    }),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  );
});

test('PATH 里的 pwsh 次之（带引号、带尾斜杠的目录都要认）', () => {
  const onPath = 'C:\\Tools\\bin\\pwsh.exe';
  assert.equal(
    resolveRestartShell({
      env: { PATH: `C:\\Windows;"C:\\Tools\\bin";D:\\other\\` },
      fileExists: world([onPath]),
    }),
    onPath,
  );
});

test('PATH 里没有就看标准安装目录（服务/任务计划那种被裁过 PATH 的环境）', () => {
  assert.equal(
    resolveRestartShell({
      env: { PATH: 'C:\\Windows\\System32' },
      fileExists: world(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
    }),
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  );
});

test('一个都探测不到时用系统自带的 powershell.exe', () => {
  assert.equal(
    resolveRestartShell({ env: { PATH: 'C:\\Windows\\System32' }, fileExists: world([]) }),
    FALLBACK_SHELL,
  );
  assert.equal(FALLBACK_SHELL, 'powershell.exe', '兜底那一个必须在 System32 里，WMI 环境也找得到');
  // PATH 缺失（undefined）也不该抛：那种环境里只剩"系统自带"这一条路
  assert.equal(resolveRestartShell({ env: {}, fileExists: world([]) }), FALLBACK_SHELL);
});

test('findOnPath：空段、空 PATH、找不到都返回 null（不猜）', () => {
  assert.equal(findOnPath(';;;', 'pwsh.exe', world([])), null);
  assert.equal(findOnPath(undefined, 'pwsh.exe', world([])), null);
  assert.equal(findOnPath('', 'pwsh.exe', world([])), null);
  const probe = 'C:\\a\\pwsh.exe';
  assert.equal(findOnPath('C:\\a', 'pwsh.exe', world([probe])), probe);
});
