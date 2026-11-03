import { Worker } from 'node:worker_threads';

import { PluginRpcError, PLUGIN_RPC_ERRORS } from './protocol.ts';

/** Regex execution belongs in a disposable worker, never on the host event loop. */
export const PLUGIN_FILTER_REGEX_TIMEOUT_MS = 50;
const JOB_TIMEOUT_MS = 2_000;
const MAX_WORKERS = 2;
const MAX_QUEUED = 64;
export const PLUGIN_FILTER_MAX_TEXT_CHARS = 64_000;

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.once('message', ({ source, flags, text }) => {
  try { parentPort.postMessage({ matched: new RegExp(source, flags).test(text) }); }
  catch (error) { parentPort.postMessage({ error: String(error.message || error) }); }
});
parentPort.postMessage({ ready: true });
`;

interface Job {
  source: string;
  flags: string;
  text: string;
  deadline: number;
  resolve: (matched: boolean) => void;
  reject: (error: Error) => void;
}

let active = 0;
const queue: Job[] = [];

function timeout(message: string): PluginRpcError {
  return new PluginRpcError(PLUGIN_RPC_ERRORS.timeout, `message.received.regex: ${message}`, 'timeout');
}

async function run(job: Job): Promise<boolean> {
  const remaining = job.deadline - Date.now();
  if (remaining <= 0) throw timeout('过滤排队超时');
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
  });
  let jobTimer: NodeJS.Timeout | undefined;
  let matchTimer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (value: boolean | Error): void => {
        if (settled) return;
        settled = true;
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      jobTimer = setTimeout(() => finish(timeout('过滤启动或排队超过 2000ms')), remaining);
      worker.on('message', (value: { ready?: boolean; matched?: boolean; error?: string }) => {
        if (settled) return;
        if (value.ready === true) {
          matchTimer = setTimeout(() => finish(timeout(`匹配超过 ${PLUGIN_FILTER_REGEX_TIMEOUT_MS}ms`)), PLUGIN_FILTER_REGEX_TIMEOUT_MS);
          worker.postMessage({ source: job.source, flags: job.flags, text: job.text });
        } else if (typeof value.matched === 'boolean') finish(value.matched);
        else finish(new PluginRpcError(PLUGIN_RPC_ERRORS.invalidParams,
          `message.received.regex: ${value.error ?? '过滤工作线程返回无效结果'}`, 'protocol'));
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', () => finish(new Error('message.received.regex: 过滤工作线程提前退出')));
    });
  } finally {
    if (jobTimer !== undefined) clearTimeout(jobTimer);
    if (matchTimer !== undefined) clearTimeout(matchTimer);
    // Await termination before admitting another job, including timeout and crash paths.
    await worker.terminate();
  }
}

function drain(): void {
  while (active < MAX_WORKERS && queue.length > 0) {
    const job = queue.shift()!;
    active += 1;
    void run(job).then(job.resolve, job.reject).finally(() => { active -= 1; drain(); });
  }
}

/** Full JavaScript regex syntax is retained; concurrency, input and execution are bounded. */
export async function testMessageRegex(regex: RegExp, text: string): Promise<boolean> {
  if (text.length > PLUGIN_FILTER_MAX_TEXT_CHARS) {
    throw new PluginRpcError(PLUGIN_RPC_ERRORS.business,
      `message.received.regex: 正文超过 ${PLUGIN_FILTER_MAX_TEXT_CHARS} 字符，跳过此过滤订阅`, 'business');
  }
  if (queue.length >= MAX_QUEUED) throw timeout('过滤队列已满');
  return await new Promise<boolean>((resolve, reject) => {
    queue.push({ source: regex.source, flags: regex.flags, text, deadline: Date.now() + JOB_TIMEOUT_MS, resolve, reject });
    drain();
  });
}
