export type PluginContributionKind = 'skill' | 'hook' | 'mcp';
export type PluginFailureCategory = 'start' | 'protocol' | 'crash' | 'timeout' | 'hook-error' | 'hook-timeout' | 'business' | 'bad-arguments' | 'denied' | 'overloaded' | 'cancelled';

export interface PluginFailure {
  pluginId: string;
  contentHash: string;
  contributionKind: PluginContributionKind;
  contributionName: string;
  category: PluginFailureCategory;
  message: string;
}

export function isSystemicPluginFailure(failure: PluginFailure): boolean {
  return ['start', 'protocol', 'crash', 'timeout', 'hook-error', 'hook-timeout'].includes(failure.category);
}

/**
 * 探针被取消。**取消不是失败**：这是宿主主动收摊（关停、换组合），不是被探测方又坏了。
 *
 * 为什么必须是一个可识别的类型：熔断器对探针抛出的任何错误都按「还是坏的」处理
 * （`count`/`strikes` 加一、退避按 30s×2^strikes 翻倍、再记一条 `plugin/quarantined`）。
 * 而关停时探测池会被 `shutdown()`，在飞的 `listTools` 必然被拒——照此记一笔，用户关一次
 * 进程就会让某插件的隔离期平白翻倍，日志里还多出一条它根本没犯过的罪。抛出方（宿主侧的
 * `probePlugin`）负责把「因为我让它停」折算成这个类，而不是普通的 Error。
 */
export class PluginProbeCancelledError extends Error {
  constructor(message = '探针被取消') {
    super(message);
    this.name = 'PluginProbeCancelledError';
  }
}
