import type { ChannelsConfig } from '../config/config.js';
import type { WakeChannel } from '../log/types.js';
import { QQ_CHANNEL_NAME } from './qq-official.ts';

export type GroupPolicy = Pick<ChannelsConfig['qqOfficial'], 'allowedGroups' | 'blockedGroups'>;

export function isAllowedGroupMessage(data: WakeChannel['data'], policy: GroupPolicy): boolean {
  if (data.channel !== QQ_CHANNEL_NAME || (data.chatType !== 'group' && data.chatType !== 'group-at')) return true;
  if (policy.blockedGroups.includes(data.chatId)) return false;
  return policy.allowedGroups.length === 0 || policy.allowedGroups.includes(data.chatId);
}

/** 在下游认领、记录日志或写信箱前过滤，不产生被拒绝消息的副作用。 */
export function withGroupPolicy(
  handler: (data: WakeChannel['data']) => void,
  policy: GroupPolicy,
): (data: WakeChannel['data']) => void {
  return (data) => {
    if (isAllowedGroupMessage(data, policy)) handler(data);
  };
}
