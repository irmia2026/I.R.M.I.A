export const TRUST_WEIGHTS = {
  owner: 1.0,
  trusted: 0.65,
  external: 0.25,
};

const TRIVIAL_ACKS = new Set([
  '嗯',
  '嗯嗯',
  '哦',
  '噢',
  '啊',
  '好',
  '好的',
  '好吧',
  '行',
  '行吧',
  'ok',
  'okay',
  'k',
  'kk',
  '早',
  '早安',
  '午安',
  '晚安',
  '收到',
  '知道了',
  '明白',
  '哈哈',
  '哈哈哈',
  '6',
  '666',
]);

export function extractEventText(data) {
  if (data === null || typeof data !== 'object') return '';
  if (typeof data.text === 'string' && data.text.trim() !== '') return data.text;
  if (Array.isArray(data.parts)) {
    const joined = data.parts
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ');
    if (joined.trim() !== '') return joined;
  }
  if (typeof data.content === 'string' && data.content.trim() !== '') return data.content;
  if (typeof data.result === 'string' && data.result.trim() !== '') return data.result;
  if (typeof data.output === 'string' && data.output.trim() !== '') return data.output;
  return '';
}

export function isTrivialAck(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('/')) return true;
  const normalized = trimmed
    .replace(/[.。!！~～?？,，、\s]+$/gu, '')
    .replace(/^[.。!！~～?？,，、\s]+/gu, '')
    .toLowerCase();
  if (normalized === '') return true;
  return TRIVIAL_ACKS.has(normalized);
}

function toIdSet(list) {
  const out = new Set();
  if (list instanceof Set) {
    for (const v of list) {
      const s = String(v ?? '').trim();
      if (s !== '') out.add(s);
    }
    return out;
  }
  if (Array.isArray(list)) {
    for (const v of list) {
      const s = String(v ?? '').trim();
      if (s !== '') out.add(s);
    }
  }
  return out;
}

function collectActorIds(data) {
  if (!data || typeof data !== 'object') return [];
  const raw = [
    data.senderId,
    data.userId,
    data.openId,
    data.authorId,
    data.from,
    data.uin,
    data.qq,
    data.personId,
    data.actorId,
    data.sender && typeof data.sender === 'object' ? data.sender.id : undefined,
    data.author && typeof data.author === 'object' ? data.author.id : undefined,
  ];
  const ids = [];
  for (const val of raw) {
    if (val === undefined || val === null) continue;
    const s = String(val).trim();
    if (s !== '') ids.push(s);
  }
  return ids;
}

export function resolveActorTier(event, config = {}) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const ownerIds = toIdSet(config.ownerIds);
  const trustedIds = toIdSet(config.trustedIds);
  const actorIds = collectActorIds(data);

  if (data.isOwner === true || data.role === 'owner') return 'owner';
  if (type === 'wake/manual' && data.source === 'human') return 'owner';
  for (const id of actorIds) {
    if (ownerIds.has(id)) return 'owner';
  }
  if (type === 'wake/message' && actorIds.length === 0) return 'owner';
  if (type === 'wake/manual' && data.source === undefined && actorIds.length === 0) return 'owner';

  if (data.isTrusted === true || data.role === 'trusted' || data.trust === 'trusted') return 'trusted';
  for (const id of actorIds) {
    if (trustedIds.has(id)) return 'trusted';
  }
  return 'external';
}

export function triageEvent(event, config = {}) {
  if (event === null || typeof event !== 'object') return null;
  if (!Number.isSafeInteger(event.seq)) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data && typeof event.data === 'object' ? event.data : {};

  if (type === 'wake/manual') {
    if (data.via !== undefined) return null;
  } else if (type === 'wake/channel' || type === 'channel/message') {
    const allowed = type === 'wake/channel'
      || data.mentionsMe === true
      || data.chatType === 'c2c'
      || data.chatType === 'group-at';
    if (!allowed) return null;
  } else if (type === 'tool/result') {
    const toolName = data.name ?? data.tool;
    if (toolName !== 'read_channel') return null;
    if (data.isError === true) return null;
  } else if (type !== 'wake/message') {
    return null;
  }

  const text = extractEventText(data).trim();
  if (isTrivialAck(text)) return null;

  const actorTier = resolveActorTier(event, config);
  const weight = TRUST_WEIGHTS[actorTier];
  return {
    seq: event.seq,
    type,
    text: [...text].slice(0, 1000).join(''),
    ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString(),
    actorTier,
    weight,
  };
}
