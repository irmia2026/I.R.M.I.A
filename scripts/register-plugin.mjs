#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

function calculateHash(pluginDir) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        files.push(relative(pluginDir, full).split(sep).join('/'));
      }
    }
  }
  walk(pluginDir);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(pluginDir, rel)));
  }
  return hash.digest('hex');
}

function main() {
  const targetDir = process.argv[2];
  if (!targetDir) {
    console.error('用法: node register-plugin.mjs <插件目录>');
    process.exit(1);
  }

  const absDir = resolve(targetDir);
  if (!existsSync(absDir)) {
    console.error(`目录不存在: ${absDir}`);
    process.exit(1);
  }

  const manifestPath = join(absDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    console.error(`未找到 plugin.json: ${manifestPath}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.error(`plugin.json 解析失败: ${err.message}`);
    process.exit(1);
  }

  const hash = calculateHash(absDir);
  console.log('=== 插件校验成功 ===');
  console.log(`插件 ID:       ${manifest.id}`);
  console.log(`版本号:        ${manifest.version}`);
  console.log(`整包 SHA256:   ${hash}`);
  console.log(`绝对路径:      ${absDir}`);
  console.log('\n你可以通过前端界面 -> 扩展 -> 填入该绝对路径完成安装；');
  console.log('或在框架 HTTP API 调用 plugin-install / plugin-confirm / plugin-enable。');
}

main();
