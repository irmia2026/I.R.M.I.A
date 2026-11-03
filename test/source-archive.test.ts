import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { tempDirSync } from './helpers/temp-dirs.ts';

const script = resolve(import.meta.dirname, '../tools/make-source-archive.ps1');
const skip = process.platform !== 'win32'
  || spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status !== 0;

function fixture(missingAsset = false): { repo: string; out: string; words: string; zip: string } {
  const root = tempDirSync('irmia-source-archive-');
  const repo = join(root, 'repo');
  const out = join(root, 'out');
  mkdirSync(join(repo, 'gui', 'assets', '2.0x'), { recursive: true });
  writeFileSync(join(repo, 'gui', 'pubspec.yaml'), 'name: archive_fixture\nflutter:\n  assets:\n    - assets/tray.ico\n    - assets/mark.png\n');
  writeFileSync(join(repo, 'gui', 'assets', 'tray.ico'), 'synthetic icon');
  if (!missingAsset) writeFileSync(join(repo, 'gui', 'assets', 'mark.png'), 'synthetic bitmap');
  writeFileSync(join(repo, 'gui', 'assets', '2.0x', 'mark.png'), 'synthetic resolution variant');
  const words = join(root, 'synthetic-words.json');
  writeFileSync(words, JSON.stringify({
    words: [{ word: 'AUDIT_SENTINEL', level: 'fatal', why: 'synthetic', scope: ['package', 'oss'] }],
    forbiddenNames: [], forbiddenExtensions: [],
  }));
  return { repo, out, words, zip: join(out, 'irmia-agent-v0.0.0-test-source.zip') };
}

test('源码归档保留 pubspec 的图标、图片及分辨率变体', { skip }, () => {
  const fx = fixture();
  const run = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Version', '0.0.0-test', '-Repo', fx.repo, '-OutDir', fx.out], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_PRIVATE_WORDS: fx.words },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const entries = spawnSync('pwsh', ['-NoProfile', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:IRMIA_ARCHIVE_TEST_ZIP); try { @($zip.Entries.FullName) | ConvertTo-Json -Compress } finally { $zip.Dispose() }'], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_ARCHIVE_TEST_ZIP: fx.zip },
  });
  assert.equal(entries.status, 0, entries.stderr);
  const names = (JSON.parse(entries.stdout) as string[]).map((name) => name.replaceAll('\\', '/'));
  for (const path of ['pubspec.yaml', 'assets/tray.ico', 'assets/mark.png', 'assets/2.0x/mark.png']) {
    assert.ok(names.includes(`irmia-agent/gui/${path}`), `归档缺文件：${path}`);
  }
});

test('源码归档缺少声明资源时失败且不交付 zip', { skip }, () => {
  const fx = fixture(true);
  const run = spawnSync('pwsh', ['-NoProfile', '-File', script, '-Version', '0.0.0-test', '-Repo', fx.repo, '-OutDir', fx.out], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_PRIVATE_WORDS: fx.words },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /assets\/mark\.png/);
  assert.equal(existsSync(fx.zip), false);
});

test('归档与发布脚本均可被 PowerShell 解析', { skip }, () => {
  for (const file of [script, resolve(import.meta.dirname, '../tools/release.ps1')]) {
    const parsed = spawnSync('pwsh', ['-NoProfile', '-Command',
      '$tokens=$null; $issues=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:IRMIA_SCRIPT_TO_PARSE,[ref]$tokens,[ref]$issues); if($issues.Count){$issues | ForEach-Object {$_.Message}; exit 1}'], {
      windowsHide: true, encoding: 'utf8', env: { ...process.env, IRMIA_SCRIPT_TO_PARSE: file },
    });
    assert.equal(parsed.status, 0, parsed.stdout + parsed.stderr);
  }
});
