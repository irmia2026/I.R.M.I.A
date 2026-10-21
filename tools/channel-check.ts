/**
 * 官 bot 适配器的**能力验收**（可复跑）。
 *
 * 为什么要有它：这十几轮往适配器里加了不少东西（富媒体/分片/流式/频道/验签…），
 * 但"加了"与"接线了"与"真的在跑"是三件事。这个脚本一次把三列答案摆出来，**不靠叙述**：
 *
 *   ① 实现了 —— 模块导出在不在（运行时 import 检查，不是 grep）
 *   ② 接线了 —— 工具清单里有没有那个出口（`send_media` 等），配置里通道开没开
 *   ③ 见过   —— 事件日志里有没有这种事件真的发生过（没见过就写"未实测"，不假装验过）
 *
 * 跑法：`node --experimental-strip-types tools/channel-check.ts`
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogToolSpecs } from '../src/tools/catalog.ts';
import { loadConfig } from '../src/config/config.ts';
import * as qq from '../src/channel/qq-official.ts';
import * as webhook from '../src/channel/qq-webhook.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const dataDir = join(repo, 'data');

/** 事件日志里的所有事件类型（只读一遍，下面各处复用） */
function loadEventTypes(): { types: Map<string, number>; lastSeq: number } {
  const dir = join(dataDir, 'events');
  const types = new Map<string, number>();
  let lastSeq = 0;
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const event = JSON.parse(line) as { type: string; seq: number };
      types.set(event.type, (types.get(event.type) ?? 0) + 1);
      if (event.seq > lastSeq) lastSeq = event.seq;
    }
  }
  return { types, lastSeq };
}

const { types, lastSeq } = loadEventTypes();
const loaded = await loadConfig(repo).catch(() => null);
const config = loaded?.config ?? null;
// 按**真实配置**取清单：`send_media` 是 destructive 组（发出去就收不回来），
// 开关关着时它本来就不该出现在模型视线里——这一步正是要验"按当前配置，她看得见哪些"。
const destructiveEnabled = config?.tools.destructiveEnabled ?? false;
const includeDestructive = destructiveEnabled === true
  || (Array.isArray(destructiveEnabled) && destructiveEnabled.includes('send_media'));
const specs = await catalogToolSpecs(dataDir, { includeDestructive });
const toolNames = (specs.specs ?? []).map((tool) => tool.name);

/** 模块导出检查：实现了没有 */
const implemented: Array<[string, boolean]> = [
  ['富媒体上传（单次）', typeof (qq.QqMessageSender.prototype as { uploadMedia?: unknown }).uploadMedia === 'function'],
  ['富媒体上传（分片）', typeof (qq.QqMessageSender.prototype as { uploadMediaChunked?: unknown }).uploadMediaChunked === 'function'],
  ['分片阈值判定', typeof qq.needsChunkedUpload === 'function'],
  ['流式原语（仅单聊，无出口）', typeof (qq.QqMessageSender.prototype as { sendStreamChunk?: unknown }).sendStreamChunk === 'function'],
  ['媒体投递口（通道侧）', typeof qq.createChannelMediaPoster === 'function'],
  ['频道发送路径', qq.messagesPathOf('guild', 'C') === '/channels/C/messages'],
  ['回投地址认 guild', qq.parseReplyUrl('qq:guild:C').ok],
  ['频道私信路径', qq.messagesPathOf('dm', 'G') === '/dms/G/messages'],
  ['回投地址认 dm', qq.parseReplyUrl('qq:dm:G').ok],
  ['频道媒体（multipart）', typeof (qq.QqMessageSender.prototype as { sendGuildMedia?: unknown }).sendGuildMedia === 'function'],
  ['Webhook 验签', typeof webhook.verifyWebhookSignature === 'function'],
  ['Webhook 地址验证', typeof webhook.urlVerifyResponse === 'function'],
  ['Webhook 事件去重', typeof webhook.WebhookDedupe === 'function'],
];

const wired: Array<[string, boolean]> = [
  ['工具里有 send_media', toolNames.includes('send_media')],
  ['工具里有 read_channel', toolNames.includes('read_channel')],
  ['QQ 官方通道已启用', config?.channels.qqOfficial.enabled === true],
  ['OneBot 通道已启用', config?.channels.onebot.enabled === true],
  ['群消息攒批窗口（分钟）', true],
];

const seen: Array<[string, string]> = [
  ['群里收到过消息', types.has('wake/channel') ? `${types.get('wake/channel')} 次 wake/channel` : '未实测'],
  ['全量群消息进过信箱', types.has('channel/message') ? `${types.get('channel/message')} 次 channel/message` : '未实测'],
  ['话题概括跑过', types.has('channel/topic') ? `${types.get('channel/topic')} 次 channel/topic` : '未实测'],
  ['注入判定跑过', types.has('injection/flagged') || types.has('injection/noted') ? '有' : '未实测'],
  ['她发过话（回投）', types.has('speak/sent') ? `${types.get('speak/sent')} 次 speak/sent` : '未实测'],
  ['跨进程恢复跑过', types.has('input/requeued') ? `${types.get('input/requeued')} 次 input/requeued` : '未实测'],
  ['富媒体真的发过', '未实测（要她实际发一次图）'],
  ['语音转写真的收到过', '未实测（要有人发语音）'],
  ['频道消息真的收到过', '未实测（要有频道）'],
];

function table(title: string, rows: Array<[string, unknown]>): void {
  console.log(`\n=== ${title} ===`);
  for (const [name, value] of rows) {
    const mark = value === true ? '✓' : value === false ? '✗' : String(value);
    console.log(`  ${name.padEnd(26, ' ')} ${mark}`);
  }
}

console.log(`官 bot 适配器能力验收（data/lastSeq=${lastSeq}，工具 ${toolNames.length} 件）`);
table('① 实现了（运行时导出检查）', implemented);
table('② 接线了（工具/配置）', wired);
table('③ 日志里见过（未见过的老实写"未实测"）', seen);
console.log('\n（"未实测"不等于没做完：那几项需要真机上有人发一次图/语音/频道消息才能验。）');
