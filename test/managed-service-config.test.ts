/**
 * 协议端配置读取测试 —— src/services/snowluma.ts 的 readEndpointFromConfig
 *
 * 这一条链最容易悄悄坏掉的地方就是"读配置读错了地方"，而它的表现形式极具迷惑性：
 * **端口通了却一直连不上**（拿空 token 去连一个开了随机 token 校验的端口），
 * 日志里只有鉴权失败，看不出根因。所以每种文件布局都单独锁一条。
 *
 * 真实首跑的样子是**只有按账号快照**（`onebot_<uin>.json`）：SnowLuma 的 OneBotManager
 * 用 `persistDefaults: true` 加载配置，而没有全局文件时它落的是按账号的完整快照——
 * 全局那份 `config/onebot.json` 根本不会出现。
 */

import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { readEndpointFromConfig } from '../src/services/snowluma.ts';
import { tempDirSync } from './helpers/temp-dirs.ts';

const roots: string[] = [];
after(() => {
  for (const dir of roots) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
});

function tempDir(): string {
  const dir = tempDirSync('irmia-svccfg-');
  roots.push(dir);
  return dir;
}

function cfg(server: unknown): string {
  return JSON.stringify({ networks: { wsServers: [server] } });
}

function writeNamed(dir: string, name: string, body: unknown): void {
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', name), JSON.stringify(body), 'utf8');
}

describe('协议端配置读取', () => {
  test('只有按账号快照时（真实首跑）也要读得到', () => {
    const dir = tempDir();
    writeNamed(dir, 'onebot_10001.json', {
      networks: { wsServers: [{ host: '127.0.0.1', port: 3001, path: '/', accessToken: 'from-snapshot' }] },
    });
    assert.deepEqual(readEndpointFromConfig(dir), {
      wsUrl: 'ws://127.0.0.1:3001/',
      accessToken: 'from-snapshot',
    });
  });

  test('全局那份优先于按账号快照（人在 WebUI 里存过的才是他的意图）', () => {
    const dir = tempDir();
    writeNamed(dir, 'onebot.json', { networks: { wsServers: [{ port: 3100, path: '/', accessToken: 'global' }] } });
    writeNamed(dir, 'onebot_10001.json', { networks: { wsServers: [{ port: 3001, path: '/', accessToken: 'snap' }] } });
    const found = readEndpointFromConfig(dir);
    assert.equal(found?.accessToken, 'global');
    assert.match(String(found?.wsUrl), /:3100\//u);
  });

  test('多账号取最近改动的那个（按 mtime，不按 uin 数字）', () => {
    const dir = tempDir();
    writeNamed(dir, 'onebot_90001.json', { networks: { wsServers: [{ port: 3001, accessToken: 'older-bigger-uin' }] } });
    writeNamed(dir, 'onebot_10001.json', { networks: { wsServers: [{ port: 3002, accessToken: 'newer' }] } });
    const long = new Date(Date.now() - 86_400_000);
    utimesSync(join(dir, 'config', 'onebot_90001.json'), long, long);
    assert.equal(readEndpointFromConfig(dir)?.accessToken, 'newer');
  });

  test('config 目录里只有无关文件时返回 null——绝不猜一个端口出来', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'webui.json'), '{}', 'utf8');
    appendFileSync(join(dir, 'config', 'notes.txt'), 'hi', 'utf8');
    assert.equal(readEndpointFromConfig(dir), null);
  });

  test('快照坏了就跳过它，看下一个候选（不是整条链判死）', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'onebot_10001.json'), '{ 坏掉的 json', 'utf8');
    writeNamed(dir, 'onebot_20002.json', { networks: { wsServers: [{ port: 3005, accessToken: 'good' }] } });
    // 让坏文件更新一些，确保它是先被看到的那一个
    const now = new Date();
    utimesSync(join(dir, 'config', 'onebot_10001.json'), now, now);
    assert.equal(readEndpointFromConfig(dir)?.accessToken, 'good');
  });
});
