import { basename } from 'node:path';

import { affectAt } from '../affect/engine.ts';
import type { AffectState, EmotionName } from '../affect/types.js';
import { affectEnabled, type AppConfig } from '../config/config.ts';
import type { ReplyOutcome, ReplyTarget } from '../tools/admin.ts';
import type { MediaPoster } from '../tools/admin.js';
import { isStickerTag, type StickerEntry, type StickerTag } from './types.ts';
import type { StickerStore } from './store.ts';

export interface StickerSelection {
  entry: StickerEntry;
  tag: StickerTag;
  dice: number;
  candidates: string[];
}

export interface StickerDelivery extends StickerSelection {
  source: 'active' | 'passive';
  turn: number;
  position: 'after' | 'before' | 'only';
  target: ReplyTarget | null;
  affect?: { dominant: string; value: number };
}

const EMOTION_TAG: Record<EmotionName, StickerTag> = {
  joy: '开心', distress: '难过', concern: '担心', irritation: '生气', warmth: '亲近', shyness: '害羞',
};

export interface StickerRuntimeDeps {
  store: StickerStore;
  config: () => AppConfig;
  affect: () => AffectState;
  mediaPoster?: MediaPoster;
  emit: (type: string, data: unknown) => void;
  random?: () => number;
  now?: () => Date;
}

export class StickerRuntime {
  private readonly sentTurns = new Set<number>();
  private readonly deps: StickerRuntimeDeps;

  constructor(deps: StickerRuntimeDeps) {
    this.deps = deps;
  }

  /**
   * 主动选图。失败时除了照旧写 `sticker/skipped` / `sticker/unknown-tag`，还把
   * **同一份原因**交给可选的 `onSkip`：调用方（speak 的 handler）靠它把"没发出去"
   * 如实写进工具回执，而不是拿一个空成功回执让她误以为发了。
   *
   * 四个出口各回调一次；成功时不回调。现有调用点不传第五参，行为不变。
   */
  active(
    turn: number,
    chatType: string,
    channel: string,
    rawTag: unknown,
    onSkip?: (reason: string) => void,
  ): StickerSelection | null {
    if (this.cooldownActive()) {
      this.deps.emit('sticker/skipped', { reason: 'cooldown' });
      onSkip?.('cooldown');
      return null;
    }
    if (this.sentTurns.has(turn)) {
      this.deps.emit('sticker/skipped', { reason: 'turn-cap' });
      onSkip?.('turn-cap');
      return null;
    }
    if (!this.allowed(chatType, channel)) {
      this.deps.emit('sticker/skipped', { reason: 'disabled' });
      onSkip?.('disabled');
      return null;
    }
    if (!isStickerTag(rawTag)) {
      this.deps.emit('sticker/unknown-tag', { tag: String(rawTag ?? '') });
      onSkip?.('unknown-tag');
      return null;
    }
    const activeProbability = this.deps.config().stickers.activeProbability ?? 1;
    const dice = this.deps.random?.() ?? Math.random();
    if (dice >= activeProbability) {
      this.deps.emit('sticker/skipped', { reason: 'dice' });
      onSkip?.('dice');
      return null;
    }
    const selection = this.choose(rawTag);
    if (selection === null) {
      // `choose` 已经落了 sticker/skipped{no-candidates}，这里只补回调，不重复写事件。
      onSkip?.('no-candidates');
    }
    return selection;
  }

  async deliver(input: StickerDelivery): Promise<boolean> {
    if (input.target === null || this.deps.mediaPoster === undefined) {
      this.deps.emit('sticker/skipped', { reason: 'channel-unsupported' });
      return false;
    }
    const found = this.deps.store.findById(input.entry.id);
    if (found === null) {
      this.deps.emit('sticker/skipped', { reason: 'no-candidates' });
      return false;
    }
    const path = this.deps.store.entryPath(found.pack.packId, found.entry.file);
    let outcome: ReplyOutcome;
    try {
      outcome = await this.deps.mediaPoster.post(input.target, {
        fileType: 1,
        data: this.deps.store.readEntryBytes(input.entry.id),
        path,
        name: basename(path),
      });
    } catch {
      this.deps.emit('sticker/skipped', { reason: 'media-failed' });
      return false;
    }
    if (!outcome.ok) {
      this.deps.emit('sticker/skipped', { reason: 'media-failed' });
      return false;
    }
    this.deps.store.recordSent(input.entry.id, this.now(), input.turn);
    this.sentTurns.add(input.turn);
    this.deps.emit('sticker/sent', {
      source: input.source,
      tag: input.tag,
      stickerId: input.entry.id,
      position: input.position,
      dice: input.dice,
      ...(input.affect === undefined ? {} : { affect: input.affect }),
      candidates: input.candidates,
    });
    return true;
  }

  async passive(input: {
    turn: number;
    chatType: string;
    channel: string;
    target: ReplyTarget | null;
    toolFailure: boolean;
  }): Promise<boolean> {
    if (this.cooldownActive()) {
      this.deps.emit('sticker/skipped', { reason: 'cooldown' });
      return false;
    }
    if (this.sentTurns.has(input.turn)) return false;
    const config = this.deps.config();
    if (!affectEnabled(config)) {
      this.deps.emit('sticker/skipped', { reason: 'affect-disabled' });
      return false;
    }
    if (!this.allowed(input.chatType, input.channel)) {
      this.deps.emit('sticker/skipped', { reason: 'disabled' });
      return false;
    }
    const state = this.deps.store.readState();
    const quietTurns = state.lastStickerTurn === null ? input.turn : Math.max(0, input.turn - state.lastStickerTurn);
    if (quietTurns < config.stickers.minTurnsBetween) {
      this.deps.emit('sticker/skipped', { reason: 'cooldown' });
      return false;
    }
    const now = this.now();
    const current = affectAt(this.deps.affect(), now.getTime());
    if (input.toolFailure || current.causes.some((cause) => cause.reasonCode === 'task_failure' || cause.reasonCode === 'owner_setback')) {
      this.deps.emit('sticker/skipped', { reason: 'serious-context' });
      return false;
    }
    const dominant = (Object.keys(EMOTION_TAG) as EmotionName[]).reduce((a, b) => current.emotions[a] >= current.emotions[b] ? a : b);
    const value = current.emotions[dominant];
    if (value < 0.35) {
      this.deps.emit('sticker/skipped', { reason: 'affect-too-low' });
      return false;
    }
    const dice = this.deps.random?.() ?? Math.random();
    if (dice >= config.stickers.passiveProbability) {
      this.deps.emit('sticker/skipped', { reason: 'dice' });
      return false;
    }
    const selection = this.choose(EMOTION_TAG[dominant]);
    if (selection === null) return false;
    return await this.deliver({
      ...selection,
      source: 'passive',
      turn: input.turn,
      position: 'after',
      target: input.target,
      affect: { dominant, value },
    });
  }

  /** Global cooldown: latest successful sticker send gates both active and passive. */
  private cooldownActive(): boolean {
    const seconds = this.deps.config().stickers.cooldownSeconds ?? 0;
    if (seconds <= 0) return false;
    const state = this.deps.store.readState();
    const latest = state.sent.reduce((max, item) => Math.max(max, item.atMs), 0);
    return latest > 0 && this.now().getTime() - latest < seconds * 1000;
  }

  private choose(tag: StickerTag): StickerSelection | null {
    const now = this.now();
    const candidates = this.deps.store.candidates(tag, now);
    if (candidates.length === 0) {
      this.deps.emit('sticker/skipped', { reason: 'no-candidates' });
      return null;
    }
    const weighted = candidates.map((entry) => {
      const last = entry.stats.lastSentAt === null ? 90 : Math.max(0, (now.getTime() - Date.parse(entry.stats.lastSentAt)) / 86_400_000);
      return { entry, weight: (1 + Math.min(90, last) / 30) / (1 + entry.stats.sent) };
    });
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    const dice = (this.deps.random?.() ?? Math.random()) * total;
    let cursor = 0;
    let selected = weighted[weighted.length - 1]!.entry;
    for (const item of weighted) {
      cursor += item.weight;
      if (dice <= cursor) {
        selected = item.entry;
        break;
      }
    }
    return { entry: selected, tag, dice, candidates: candidates.map((entry) => entry.id) };
  }

  private allowed(chatType: string, channel: string): boolean {
    const config = this.deps.config();
    if (!config.stickers.enabled) return false;
    if (chatType === 'c2c') return true;
    if (config.stickers.groups) return true;
    return channel === 'onebot' ? config.channels.onebot.stickers : config.channels.qqOfficial.stickers;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
