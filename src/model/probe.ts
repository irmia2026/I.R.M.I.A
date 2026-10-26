/**
 * 模型探测（`POST /api/models/probe` 的实现核心）。
 *
 * 引导第 2 步那颗「探测」按钮要回答的**只有三件事实**，而且三件都要是实测：
 *   ① 这个端点上有哪些模型（`GET {baseUrl}/models` 的 `data[].id`）；
 *   ② 两套协议（Responses / Chat Completions）各自通不通、各花多久；
 *   ③ 按"实测结论"推荐哪一个模型（[recommended]，规则写在函数体里）。
 *
 * ──────────────────────────── 四条纪律 ────────────────────────────
 *
 * **① 密钥只进请求头，绝不进任何字符串。** 错误消息、warnings、返回体里只允许出现
 * `protocol//host/path`（[sanitizeEndpoint] 是更新检查那条通道的同一份实现）；连
 * `fetch` 抛出来的原始 message 都不原样透传——它可能带着完整 URL（含 query 里的签名）。
 * 网络错误最多带一个 `err.cause.code`（`ENOTFOUND` / `ECONNREFUSED` 这种大写枚举），
 * 那是排障需要且不含凭据。
 *
 * **② 只读。** 探测只做一次 `GET /models` 与两次 `POST`（两套协议各一次），后者的请求体
 * 被压到 `max_output_tokens/max_tokens = 1`、单条 `user: "hi"`、`stream: false`
 * —— 除了"可能产生一次极小的费用"以外没有任何副作用：不落盘、不写事件、不改配置。
 * 两个协议探测**并行**发，各自拿自己的 status 与 latency；失败也照实带回来
 * （`status: null` = 连响应都没拿到），不许因为一边失败就吞掉另一边的读数。
 *
 * **③ 总时限 12 秒（[MODEL_PROBE_TIMEOUT_MS]）。** 不是每个子请求 12 秒，而是**整条探测**
 * 共用同一个 `AbortController`：先 `GET /models`，成功之后再用**剩下的时间**并行探两套协议。
 * 理由很实在：界面那条客户端请求的总时限是 15 秒（`gui/lib/api.dart` 的
 * `kApiRequestTimeout`），如果这里按"每个子请求 12 秒"最坏要 36 秒，界面会先超时——
 * 人看到的是"探测失败"而服务端还在跑，两边对事实的描述就对不上了。
 *
 * **④ 失败分档。** 调用方（界面）要按 `code` 给出不同的出路文案，所以这里不许把三类失败
 * 揉成一句"探测失败"：
 *   · `unreachable` —— DNS / 连不上 / 超时；
 *   · `unauthorized` —— 401 / 403（密钥不对，或这把 key 没权限）；
 *   · `no-models-endpoint` —— 404、不是 JSON、没有 `data[]`（这条端点只能手填模型名）。
 * 另外两种是本模块自己要说的：`invalid-base-url`（填的字面量不是 http(s) 地址）与
 * `no-api-key`（由服务端在解析密钥时给）；还有兜底的 `probe-failed`（例如 500）。
 */

import { sanitizeEndpoint } from '../update/check.ts';

/** 整条探测的总时限（毫秒）。理由见文件头第 ③ 条。 */
export const MODEL_PROBE_TIMEOUT_MS = 12_000;

/** 一次协议试探的读数。`status: null` = 连 HTTP 响应都没拿到（超时 / 连接断了）。 */
export interface ProtocolProbeResult {
  supported: boolean;
  latencyMs: number;
  status: number | null;
}

/** 失败分档（界面按它选文案；新增一档要同时补界面那边的文案与用例）。 */
export type ModelProbeFailureCode =
  | 'unreachable'
  | 'unauthorized'
  | 'no-models-endpoint'
  | 'no-api-key'
  | 'invalid-base-url'
  | 'probe-failed';

export interface ModelProbeFailure {
  ok: false;
  code: ModelProbeFailureCode;
  message: string;
}

export interface ModelProbeSuccess {
  ok: true;
  /** `GET /models` 的 `data[].id`：去重、升序（空数组也是合法结果） */
  models: string[];
  modelsLatencyMs: number;
  responses: ProtocolProbeResult;
  chat: ProtocolProbeResult;
  /** 按实测结论推荐；没有可用模型 / 两套协议都不通 ⇒ null */
  recommended: string | null;
  /** 给人看的警告（橙色小字）：空列表、协议不通、配置里的模型不在列表里…… */
  warnings: string[];
}

export type ModelProbeResult = ModelProbeSuccess | ModelProbeFailure;

export interface ModelProbeOptions {
  /** API 根地址（不含 `/responses`；尾斜杠会被去掉） */
  baseUrl: string;
  /** 已经解析好的密钥（服务端负责"用已存的那把"，本模块不读盘） */
  apiKey: string;
  /** 当前配置里这一档的模型名（推荐规则要用它；空串 = 还不知道） */
  model?: string | undefined;
  /** 总时限覆盖点（用例把它调小；缺省 [MODEL_PROBE_TIMEOUT_MS]） */
  timeoutMs?: number | undefined;
  /** fetch 覆盖点（用例注入计数/假响应） */
  fetchImpl?: typeof fetch | undefined;
  /** 时钟覆盖点（latency 读数；缺省 `Date.now`） */
  now?: (() => number) | undefined;
}

/** 网络失败的**可公开**细节：只认大写枚举 code，绝不透传 message/URL。 */
function networkCode(error: unknown): string {
  const direct = (error as { code?: unknown } | null)?.code;
  if (typeof direct === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(direct)) return direct;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof cause === 'string' && /^[A-Z][A-Z0-9_]*$/u.test(cause)) return cause;
  return '';
}

/** 一次 fetch 的原始结局（**不在这里分类**：分类要看用途：models / 两套协议各不相同）。 */
interface FetchOutcome {
  response: Response | null;
  latencyMs: number;
  timedOut: boolean;
  errorCode: string;
}

async function runFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  now: () => number,
): Promise<FetchOutcome> {
  const started = now();
  try {
    const response = await fetchImpl(url, { ...init, signal });
    // 这里只等**响应头**；body 由调用方按用途读（要量的是"多久有回应"）。
    return { response, latencyMs: Math.max(0, now() - started), timedOut: false, errorCode: '' };
  } catch (error) {
    return { response: null, latencyMs: Math.max(0, now() - started), timedOut: signal.aborted, errorCode: networkCode(error) };
  }
}

/** `data[].id`：去重、去空白、升序。形状不对 ⇒ null（与"空列表"是两件事）。 */
function parseModelIds(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = new Set<string>();
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string' && id.trim() !== '') ids.add(id.trim());
  }
  return [...ids].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sameShapeProbe(latencyMs: number): ProtocolProbeResult {
  return { supported: false, latencyMs, status: null };
}

/** 试探一套协议：只发一次最小请求，读数（supported / latency / status）原样带回来。 */
async function probeProtocol(
  kind: 'responses' | 'chat-completions',
  url: string,
  apiKey: string,
  model: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<ProtocolProbeResult> {
  const started = now();
  // 请求体是**契约**：两套协议各自只放最小可判定的字段。
  // Responses 用 `max_output_tokens`，Chat 用 `max_tokens`（两边叫法不同，混用会被 400）。
  const body = kind === 'responses'
    ? { model, input: [{ role: 'user', content: 'hi' }], max_output_tokens: 1, stream: false }
    : { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    // 读掉 body：不读会把 keep-alive 连接挂在半截上（下一次探测/主循环可能复用同一条连接）。
    // 只读不解析——这次探测只关心"对方接不接受这套协议"，不关心它回了什么内容。
    try {
      await response.text();
    } catch {
      /* body 读失败不影响 status 这个事实 */
    }
    return {
      supported: response.status >= 200 && response.status < 300,
      latencyMs: Math.max(0, now() - started),
      status: response.status,
    };
  } catch {
    return { supported: false, latencyMs: Math.max(0, now() - started), status: null };
  }
}

/** 给人看的一小段读数（warnings 用）：`HTTP 404` / `超时或连不上`。 */
function probeDescription(probe: ProtocolProbeResult): string {
  return probe.status === null ? '超时或连不上' : `HTTP ${probe.status}`;
}

/**
 * 探一个端点（**唯一入口**）。
 *
 * 推荐规则（用户的原话，落地成四行）：
 *   · 两套协议都通、且当前配置的模型在列表里 ⇒ 就是它；
 *   · 否则 Responses 通 ⇒ 列表第一个；
 *   · 再否则 Chat 通 ⇒ 列表第一个；
 *   · 都不通 / 没有模型 ⇒ null。
 */
export async function probeModels(options: ModelProbeOptions): Promise<ModelProbeResult> {
  const rawBase = options.baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    return { ok: false, code: 'invalid-base-url', message: 'Base URL 不是合法地址：填一个 http(s) 开头的根地址。' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, code: 'invalid-base-url', message: 'Base URL 只接受 http(s) 地址。' };
  }
  /**
   * 拼地址的三条规矩（顺序不能反）：
   *   · **origin + pathname**：userinfo 不进请求 URL（凭据只走 Authorization 头）；
   *   · **query 保留但放到最后**：`{base}?x=1` 直接拼 `/models` 会变成 `?x=1/models`，
   *     那是把路径塞进 query 里——真实供应商里带 `api-version` 一类查询参数的端点不少；
   *   · **尾斜杠只去掉拼接处那一层**：`/v1/` + `/models` 不许出现 `//`。
   */
  const basePath = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, '');
  const query = parsed.search;
  /** 拼一个子路径（query 永远在最后） */
  const endpointOf = (suffix: string): string => `${basePath}/${suffix}${query}`;
  // **唯一允许出现在消息里的端点形态**：query / fragment / userinfo 全部丢掉。
  const where = sanitizeEndpoint(basePath);

  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const budget = options.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS;
  const configuredModel = (options.model ?? '').trim();

  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, budget);
  // 测试进程/短命 CLI 里别为这条计时器吊住事件循环（探测结束会 clearTimeout，这只是兜底）。
  timer.unref?.();

  try {
    // ── ① 模型清单 ──
    const modelsOutcome = await runFetch(
      fetchImpl,
      endpointOf('models'),
      {
        method: 'GET',
        headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      },
      controller.signal,
      now,
    );

    if (modelsOutcome.response === null) {
      const reason = modelsOutcome.timedOut || expired
        ? `在 ${budget} 毫秒内没有响应`
        : '网络不可达或 DNS 解析失败';
      const code = modelsOutcome.errorCode === '' ? '' : `（${modelsOutcome.errorCode}）`;
      return {
        ok: false,
        code: 'unreachable',
        message: `连不上 ${where || '这个端点'}：${reason}${code}。`,
      };
    }

    const modelsStatus = modelsOutcome.response.status;
    if (modelsStatus === 401 || modelsStatus === 403) {
      return {
        ok: false,
        code: 'unauthorized',
        message: `${where} 拒绝了这把密钥（HTTP ${modelsStatus}）：检查 API Key 后重试。`,
      };
    }
    if (modelsStatus === 404 || modelsStatus === 405) {
      return {
        ok: false,
        code: 'no-models-endpoint',
        message: `${where} 没有 /models 端点（HTTP ${modelsStatus}）：模型名只能手填。`,
      };
    }
    if (modelsStatus < 200 || modelsStatus >= 300) {
      return {
        ok: false,
        code: 'probe-failed',
        message: `${where} 的 /models 回了 HTTP ${modelsStatus}，读不到模型列表。`,
      };
    }

    let modelsText: string;
    try {
      modelsText = await modelsOutcome.response.text();
    } catch {
      // 响应头到了、body 半截断了：超时还是"对端断了"要分开说——前者人该重试/换端点，
      // 后者通常说明这个端点不是 OpenAI 兼容的。
      if (expired) {
        return {
          ok: false,
          code: 'unreachable',
          message: `${where} 在 ${budget} 毫秒内没把 /models 的响应读完。`,
        };
      }
      return {
        ok: false,
        code: 'no-models-endpoint',
        message: `${where} 的 /models 响应体读不出来：模型名只能手填。`,
      };
    }
    // latency 取的是**发出到响应头**那一段（runFetch 已经量了，读 body 的时间不算在内）：
    // 界面要的是"这个端点回话多快"，不是"这个 JSON 有多大"。
    const models = parseModelIds(modelsText);
    if (models === null) {
      return {
        ok: false,
        code: 'no-models-endpoint',
        message: `${where} 的 /models 不是可解析的模型清单（要 JSON 的 data[]）：模型名只能手填。`,
      };
    }

    // ── ② 两套协议（并行，共用剩余预算） ──
    const probeModel = configuredModel !== '' ? configuredModel : (models[0] ?? '');
    const skipped = sameShapeProbe(0);
    let responses = skipped;
    let chat = skipped;
    if (probeModel !== '') {
      [responses, chat] = await Promise.all([
        probeProtocol('responses', endpointOf('responses'), options.apiKey, probeModel, controller.signal, fetchImpl, now),
        probeProtocol('chat-completions', endpointOf('chat/completions'), options.apiKey, probeModel, controller.signal, fetchImpl, now),
      ]);
    }

    // ── ③ 结论与警告 ──
    const warnings: string[] = [];
    if (models.length === 0) warnings.push('该端点的 /models 返回了空列表：模型名只能手填。');
    if (probeModel === '') {
      warnings.push('没有可用来试探协议的模型名：两套协议这次都没有结论。');
    } else if (!responses.supported && !chat.supported) {
      warnings.push(
        `两套协议都没探通（Responses: ${probeDescription(responses)}；Chat: ${probeDescription(chat)}）：先核对 Base URL 与密钥。`,
      );
    } else if (!responses.supported) {
      warnings.push(`该端点不支持 Responses（${probeDescription(responses)}），建议协议选「强制 Chat Completions」。`);
    } else if (!chat.supported) {
      warnings.push(`该端点不支持 Chat Completions（${probeDescription(chat)}），建议协议选「强制 Responses」。`);
    }
    if (configuredModel !== '' && models.length > 0 && !models.includes(configuredModel)) {
      warnings.push(`当前配置的模型「${configuredModel}」不在这个端点的模型列表里。`);
    }

    let recommended: string | null = null;
    if (models.length > 0) {
      if (responses.supported && chat.supported && configuredModel !== '' && models.includes(configuredModel)) {
        recommended = configuredModel;
      } else if (responses.supported || chat.supported) {
        recommended = models[0] ?? null;
      }
    }

    return {
      ok: true,
      models,
      modelsLatencyMs: modelsOutcome.latencyMs,
      responses,
      chat,
      recommended,
      warnings,
    };
  } finally {
    clearTimeout(timer);
  }
}
