/**
 * Ingress Bridge 的来源注册表。
 *
 * 一条来源 = 一个外部脚本/服务：
 *   · 独立 token（盘上只存 sha256，原文只在创建/轮换响应里出现一次）；
 *   · 独立 wake 策略（always / critical / never）；
 *   · 独立启用开关。
 *
 * 旧版 `/webhook/*` 的全局 webhook token 仍然保留，作为 legacy 来源；注册表只是
 * 在它之外增加多来源，不改变旧投递的形状。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const INGRESS_SOURCES_FILE_NAME = '.ingress-sources.json';
export type IngressWakePolicy = 'always' | 'critical' | 'never';

export interface IngressSourceView {
  id: string;
  name: string;
  enabled: boolean;
  wake: IngressWakePolicy;
  createdAt: string;
  rotatedAt: string;
}

interface IngressSourceRecord extends IngressSourceView {
  hash: string;
}

interface IngressSourcesFileV1 {
  v: 1;
  sources: IngressSourceRecord[];
}

export interface IngressSourceCreateResult {
  ok: true;
  token: string;
  source: IngressSourceView;
}

export interface IngressSourceError {
  ok: false;
  code: string;
  message: string;
}

export type IngressSourceMutation = IngressSourceCreateResult | IngressSourceError;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function viewOf(record: IngressSourceRecord): IngressSourceView {
  return {
    id: record.id, name: record.name, enabled: record.enabled,
    wake: record.wake, createdAt: record.createdAt, rotatedAt: record.rotatedAt,
  };
}

function isSource(value: unknown): value is IngressSourceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string'
    && typeof v['name'] === 'string'
    && typeof v['hash'] === 'string'
    && typeof v['enabled'] === 'boolean'
    && (v['wake'] === 'always' || v['wake'] === 'critical' || v['wake'] === 'never')
    && typeof v['createdAt'] === 'string'
    && typeof v['rotatedAt'] === 'string';
}

export class IngressSourceStore {
  private readonly file: string;
  private readonly now: () => Date;
  private readonly random: (bytes: number) => Buffer;
  private loaded = false;
  private sources: IngressSourceRecord[] = [];

  constructor(options: {
    dataDir: string;
    now?: () => Date;
    random?: (bytes: number) => Buffer;
  }) {
    this.file = resolve(options.dataDir, INGRESS_SOURCES_FILE_NAME);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? randomBytes;
  }

  list(): IngressSourceView[] {
    this.load();
    return this.sources.map(viewOf);
  }

  /** 只返回 view，不含 hash/token。 */
  authenticate(token: string): IngressSourceView | null {
    if (token.trim() === '') return null;
    this.load();
    const digest = Buffer.from(hashToken(token.trim()), 'hex');
    for (const source of this.sources) {
      if (!source.enabled) continue;
      const expected = Buffer.from(source.hash, 'hex');
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) {
        return viewOf(source);
      }
    }
    return null;
  }

  create(input: { name: string; wake: IngressWakePolicy }): IngressSourceMutation {
    this.load();
    const name = input.name.trim();
    if (name === '' || name.length > 64) {
      return { ok: false, code: 'invalid-name', message: '来源名必须是 1–64 个字符' };
    }
    if (this.sources.some((source) => source.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, code: 'duplicate-name', message: `来源名已存在：${name}` };
    }
    if (!['always', 'critical', 'never'].includes(input.wake)) {
      return { ok: false, code: 'invalid-wake', message: 'wake 只能是 always / critical / never' };
    }
    const token = `ing_${this.random(24).toString('base64url')}`;
    const now = this.now().toISOString();
    const record: IngressSourceRecord = {
      id: `ing_${this.random(6).toString('hex')}`,
      name, hash: hashToken(token), enabled: true, wake: input.wake,
      createdAt: now, rotatedAt: now,
    };
    this.sources.push(record);
    const saved = this.save();
    return saved.ok ? { ok: true, token, source: viewOf(record) } : saved;
  }

  rotate(id: string): IngressSourceMutation {
    this.load();
    const record = this.sources.find((source) => source.id === id);
    if (record === undefined) return { ok: false, code: 'not-found', message: `来源不存在：${id}` };
    const token = `ing_${this.random(24).toString('base64url')}`;
    record.hash = hashToken(token);
    record.rotatedAt = this.now().toISOString();
    const saved = this.save();
    return saved.ok ? { ok: true, token, source: viewOf(record) } : saved;
  }

  setEnabled(id: string, enabled: boolean): IngressSourceMutation {
    this.load();
    const record = this.sources.find((source) => source.id === id);
    if (record === undefined) return { ok: false, code: 'not-found', message: `来源不存在：${id}` };
    record.enabled = enabled;
    const saved = this.save();
    return saved.ok ? { ok: true, token: '', source: viewOf(record) } : saved;
  }

  remove(id: string): { ok: true } | IngressSourceError {
    this.load();
    const index = this.sources.findIndex((source) => source.id === id);
    if (index < 0) return { ok: false, code: 'not-found', message: `来源不存在：${id}` };
    this.sources.splice(index, 1);
    return this.save();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return;
      const raw = (parsed as { sources?: unknown }).sources;
      if (!Array.isArray(raw)) return;
      this.sources = raw.filter(isSource);
    } catch {
      // 坏文件按空表处理：下次 create 会重写；不把启动/投递拖死
      this.sources = [];
    }
  }

  private save(): { ok: true } | IngressSourceError {
    try {
      const doc: IngressSourcesFileV1 = { v: 1, sources: this.sources };
      const temp = `${this.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      renameSync(temp, this.file);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: 'write-failed',
        message: `Ingress 来源注册表写入失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
