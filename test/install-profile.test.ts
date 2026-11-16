import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { defaultConfig } from '../src/config/config.ts';
import { applyInstallProfile, type FirstRunRunner } from '../src/runtime/install-profile.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

test('install-profile 首启：office 安装包、deskhand 安装并挂一条 disabled MCP', async (t: TestContext) => {
  const root = tempDirSync('irmia-install-profile-');
  t.after(() => { /* temp-dirs 统一清理 */ });
  const dataDir = join(root, 'data');
  const pythonDir = join(dataDir, 'tools', 'python');
  mkdirSync(pythonDir, { recursive: true });
  const python = join(pythonDir, 'python.exe');
  writeFileSync(python, '', 'utf8');
  const configPath = join(root, 'config.json');
  const config = defaultConfig(dataDir);
  writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, mcp: { servers: [] } }), 'utf8');
  const profilePath = join(root, 'install-profile.json');
  writeFileSync(profilePath, JSON.stringify({
    schema: 1, product: 'irmia-agent', components: ['core', 'deps', 'office', 'deskhand'],
    office: { installOnFirstRun: true, pythonPackages: ['python-docx', 'openpyxl'] },
    mcpPresets: {
      deskhand: {
        installRequirement: 'deskhand-mcp[all] @ https://github.com/irmia2026/deskhand-mcp/archive/a7c24ae.zip',
        installArgs: ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input',
          'deskhand-mcp[all] @ https://github.com/irmia2026/deskhand-mcp/archive/a7c24ae.zip'],
        enabledByDefault: false,
      },
    },
  }), 'utf8');

  const calls: Array<{ exe: string; args: string[] }> = [];
  const runner: FirstRunRunner = async (exe, args) => {
    calls.push({ exe, args: [...args] });
    return { code: 0, stdout: '', stderr: '' };
  };
  const deps = {
    managedDir: () => pythonDir,
    install: async () => { throw new Error('不应安装已存在的托管 Python'); },
  };
  const result = await applyInstallProfile({ dataDir, configPath, config, deps: deps as never, run: runner });
  assert.equal(result.applied, true);
  assert.equal(result.office, 'ready');
  assert.equal(result.deskhand, 'ready');
  assert.equal(calls[0]!.exe, python);
  assert.deepEqual(calls[0]!.args.slice(0, 5), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']);
  assert.deepEqual(calls[1]!.args.slice(0, 2), ['-c', 'import docx, openpyxl, reportlab, PIL, lxml, pdfplumber, pikepdf, pypdfium2']);
  assert.equal(calls[2]!.args.at(-1), 'httpx', 'deskhand 必须补上游漏掉的 httpx');
  assert.deepEqual(calls[2]!.args.slice(0, 5), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']);
  assert.deepEqual(calls[3]!.args, ['-c', 'import deskhand_mcp.server; import httpx']);

  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(saved.mcp.servers, [{
    name: 'deskhand',
    command: python,
    args: ['-m', 'deskhand_mcp.server'],
    env: { DESKHAND_DATA_DIR: join(dataDir, 'mcp', 'deskhand') },
    disabled: true,
  }]);
  assert.equal(saved.mcp.servers[0].disabled, true, '首启只挂声明，不自动启用');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  assert.notEqual(profile.appliedAt, null);
  assert.equal(profile.bootstrap.office, 'ready');
  assert.equal(profile.bootstrap.deskhand, 'ready');
  assert.equal(existsSync(python), true);
});
