import type { EventLog } from '../log/event-log.js';
import type { AppEvent } from '../log/types.js';

/** 按 seq 更新只保留查询所需状态的视图。同步读之间可共用一次日志扫描。 */
export class EventFold<State> {
  private readonly log: EventLog;
  private readonly types: ReadonlySet<string>;
  private readonly state: State;
  private readonly apply: (state: State, event: AppEvent) => void;
  private upToSeq = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    log: EventLog,
    types: readonly string[],
    state: State,
    apply: (state: State, event: AppEvent) => void,
  ) {
    this.log = log;
    this.types = new Set(types);
    this.state = state;
    this.apply = apply;
  }

  async sync(): Promise<State> {
    const requested = this.log.latestSeq();
    // 等待旧请求期间新写入的事件，下一次读取仍要补齐到自己的水位。
    while (this.upToSeq < requested) {
      this.inflight ??= this.advance(this.log.latestSeq()).finally(() => { this.inflight = null; });
      await this.inflight;
    }
    return this.state;
  }

  private async advance(throughSeq: number): Promise<void> {
    for await (const event of this.log.readRange(this.upToSeq + 1, { throughSeq, types: this.types })) {
      this.apply(this.state, event);
      this.upToSeq = event.seq;
    }
    this.upToSeq = throughSeq;
  }
}
