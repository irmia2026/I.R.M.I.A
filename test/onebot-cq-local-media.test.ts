/**
 * OneBot：CQ 码里指向**本机文件**的媒体内联（{@link inlineLocalCqMedia}）。
 *
 * 来历是 2026-11-03 的一次实测：她往 `speak` 里塞 `[CQ:image,file=1.jpg]`，
 * 协议端（NapCat，跑在 `100.68.92.32` 那台）回的是
 * `retcode=100 ENOENT: no such file or directory, stat '1.jpg'` ——
 * 它 stat 的是**它自己的盘**，看不到我们这边的文件。
 *
 * 这一层把"本地文件"翻译成协议端能取的 `base64://`（`send_media` 早就是这么干的，
 * 见 `oneBotMediaCall`），两条出口于是同一条规矩。
 *
 * 口径：**改不了就一个字不动**。不存在的、非普通文件的、空的、超上限的、
 * 不是 image/record/video 的、取值本来就不是路径的 —— 一律原样返回，
 * 让协议端按它自己的规矩报错，不在这一层编造"成功"。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

import { ONEBOT_LOCAL_INLINE_MAX_BYTES, inlineLocalCqMedia } from '../src/channel/onebot.ts';

/** 每次调用一个干净的临时目录：这些用例只关心"这个路径上有没有文件"，彼此不共用状态。 */
function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-cq-media-'));
  return run(dir).finally(() => { rmSync(dir, { recursive: true, force: true }); });
}

const BYTES = Buffer.from('PNGDATA-一贴纸');
const B64 = BYTES.toString('base64');

describe('onebot：CQ 码的本机媒体内联', () => {
  test('本机真文件 → base64://，图片还要标成表情包（sub_type=1）', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, '贴纸.png');
      writeFileSync(path, BYTES);

      // 她写的 `sub_type` 优先：写了 0 就是普通图片，框架不替她推翻
      const out = await inlineLocalCqMedia(`[CQ:image,file=${path}]`);
      assert.equal(out, `[CQ:image,file=base64://${B64},sub_type=1]`);

      const withParams = await inlineLocalCqMedia(`[CQ:image,file=${path},sub_type=0]`);
      assert.equal(withParams, `[CQ:image,file=base64://${B64},sub_type=0]`,
        '显式 sub_type=0 必须保留，且不许再追加一个');
    });
  });

  test('只有**图片**标表情包：语音/视频内联后不追加 sub_type', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'a.bin');
      writeFileSync(path, BYTES);
      assert.equal(await inlineLocalCqMedia(`[CQ:image,file=${path}]`),
        `[CQ:image,file=base64://${B64},sub_type=1]`);
      for (const type of ['record', 'video']) {
        assert.equal(await inlineLocalCqMedia(`[CQ:${type},file=${path}]`),
          `[CQ:${type},file=base64://${B64}]`, `${type} 不该带 sub_type`);
      }
      // 这些的参数是数字/编号，不是文件：一个字都不该改
      for (const raw of ['[CQ:at,qq=1000]', '[CQ:reply,id=42]', '[CQ:face,id=178]']) {
        assert.equal(await inlineLocalCqMedia(raw), raw);
      }
    });
  });

  test('文件不存在 / 空文件 / 超上限 → 原样返回（不假装内联过）', async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, '没有这个文件.png');
      const rawMissing = `[CQ:image,file=${missing}]`;
      assert.equal(await inlineLocalCqMedia(rawMissing), rawMissing);

      const empty = join(dir, '空.png');
      writeFileSync(empty, Buffer.alloc(0));
      const rawEmpty = `[CQ:image,file=${empty}]`;
      assert.equal(await inlineLocalCqMedia(rawEmpty), rawEmpty);

      const big = join(dir, 'big.bin');
      writeFileSync(big, Buffer.alloc(64));
      const rawBig = `[CQ:image,file=${big}]`;
      // 上限压到 8 字节：同一个文件"该内联"与"不该内联"的边界就落在这里，不造 16MB 真文件
      assert.equal(await inlineLocalCqMedia(rawBig, 8), rawBig);
      assert.equal(await inlineLocalCqMedia(rawBig, 64), `[CQ:image,file=base64://${Buffer.alloc(64).toString('base64')},sub_type=1]`);
      assert.ok(ONEBOT_LOCAL_INLINE_MAX_BYTES >= 1024 * 1024, '生产上限至少 1MB，否则正常贴纸会被挡在外面');
    });
  });

  test('本来就不需要内联的取值：http、base64://、协议端缓存键 —— 原样', async () => {
    const raws = [
      '[CQ:image,file=https://x.test/a.png]',
      '[CQ:image,file=http://x.test/a.png]',
      '[CQ:image,file=base64://QUJD]',
      '[CQ:image,file=abc123.image]',   // NapCat 的缓存键，正是"文件不存在"那条报错里的样子
      '[CQ:image,url=https://x.test/a.png]',  // 只认 file=，url= 不动
    ];
    for (const raw of raws) assert.equal(await inlineLocalCqMedia(raw), raw);
  });

  test('一条消息里多个 CQ 码：各判各的，码外的文字一个字节都不动', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'b.png');
      writeFileSync(path, BYTES);
      const raw = `前[CQ:image,file=${path}]中[CQ:image,file=保持原样.png]后`;
      const out = await inlineLocalCqMedia(raw);
      assert.equal(out, `前[CQ:image,file=base64://${B64},sub_type=1]中[CQ:image,file=保持原样.png]后`);
    });
  });

  test('没有 CQ 码、或只有半截的 —— 直接原样（不做任何"尽力解析"）', async () => {
    for (const raw of ['你好呀', '', '[CQ:image,file=a.png', '[CQ:]', '普通[文字]']) {
      assert.equal(await inlineLocalCqMedia(raw), raw);
    }
  });
});
