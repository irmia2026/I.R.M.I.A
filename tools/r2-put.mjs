#!/usr/bin/env node
/**
 * r2-put.mjs —— 零依赖的 Cloudflare R2 上传器（S3 SigV4，只用 Node 内置模块）
 *
 * 为什么要有它：发版机（Windows）上**没有 aws CLI、也没有 rclone**，而二进制必须传到 R2；
 *   为此装一套 AWS 工具链既慢又多个供应链面。这个文件只 import `node:*`，Node ≥ 22 直接跑：
 *     node tools/r2-put.mjs --file <本地文件> --key <对象键>
 *   它就是 `deploy/site/publish-release.sh` 的 R2 上传主路径；aws/rclone 只在**存在时**回退。
 *
 * 实现的协议（够用就好，不做 SDK）：
 *   · 单次 PUT `PUT /<bucket>/<key>`（path-style，R2 的 S3 endpoint 就是这个形状）
 *   · SigV4（AWS Signature Version 4）头签名：`host` + `x-amz-content-sha256` + `x-amz-date`
 *     （可选 `x-amz-acl`）；`content-length` / `content-type` 照发但**不参与签名**
 *     —— 它们由运行时保证，绑进签名只会给中间层留一个改坏签名的机会。
 *   · 区域默认 `auto`（R2 的约定），服务固定 `s3`。
 *   · 上传后回读：先对 R2 endpoint 发**已签名 HEAD** 比 `Content-Length`；
 *     若给了 `--public-base`（CDN 域名）再 `GET <public-base>/<key>` 比 sha256。
 *     两步都是真的读回来，不是"PUT 返回 200 就当成功"。
 *
 * 凭据**只从环境变量读**，且**从不打印**（连长度、前后缀都不打）：
 *   R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY     必填（真上传时）
 *   R2_BUCKET                                    桶名（也可 --bucket）
 *   R2_ENDPOINT                                  如 https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 *   R2_ACCOUNT_ID                                没给 R2_ENDPOINT 时用它拼 endpoint
 *   R2_REGION                                    默认 auto
 *   R2_PUBLIC_BASE                               CDN 根（也可 --public-base）
 *
 * CLI：
 *   node tools/r2-put.mjs --file <path> --key <key> [--dry-run]
 *        [--content-type CT] [--acl private|public-read]
 *        [--endpoint URL] [--bucket B] [--region auto] [--public-base URL] [--no-verify]
 *
 *   --dry-run  只打印将发的 URL、大小、sha256、**请求头名与签名头名**；
 *              **不计算、不打印 Authorization**，不需要凭据，一个网络请求都不发。
 *
 * 退出码：0 成功；1 用法/环境错误（缺参数、缺凭据、文件不存在）；2 上传或回读校验失败。
 *
 * ⚠️ 安全纪律：本文件任何分支都不 echo 凭据、不把凭据写进 URL/日志/错误消息；
 *    SignatureDoesNotMatch 之类的服务端错误只抽取 <Code>/<Message>，不回显整个响应体
 *    （S3 的错误体里可能带 canonical request，虽然不含密钥，但没必要进日志）。
 */

import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

/** SigV4 的算法名，也出现在 Authorization 的第一段 */
export const ALGORITHM = 'AWS4-HMAC-SHA256';
/** 空 body 的 SHA-256（HEAD/GET 这类没有负载的请求要带它） */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** 网络超时：PUT 允许大文件慢慢传；HEAD/GET 只是回读校验，别拖太久 */
const PUT_TIMEOUT_MS = 30 * 60 * 1000;
const READ_TIMEOUT_MS = 60 * 1000;
/** 错误响应最多读这么多字节（只用来抽 <Code>/<Message>，不是拿来当正文） */
const MAX_ERROR_BODY = 64 * 1024;

// ════════════════════════════════════════════════════════════════════════════
// 一、哈希 / 编码 / 时间
// ════════════════════════════════════════════════════════════════════════════

/** SHA-256 → 小写 hex。入参可以是 string（按 UTF-8）或 Buffer/Uint8Array。 */
export function sha256Hex(input) {
    return createHash('sha256').update(input).digest('hex');
}

/**
 * AWS 的 UriEncode：**只**保留 `A-Z a-z 0-9 - . _ ~`，其余一律按 UTF-8 字节转成
 * `%XX`（大写十六进制）。注意三件事，都是踩过/文档里写死的：
 *   ① 空格是 `%20`，不是 `+`（`+` 本身要编成 `%2B`）；
 *   ② `~` 不编码（RFC 3986 的 unreserved，和 encodeURIComponent 不同）；
 *   ③ `$` 要编码（官方 S3 的 PUT 示例里 `test$file.text` → `/test%24file.text`）。
 * `/` 也会被编码；对象键的路径分隔由 `encodeKeyPath` 按段处理。
 */
export function uriEncode(value) {
    const text = String(value);
    let out = '';
    for (const ch of text) {
        if (ch.length === 1 && /[A-Za-z0-9\-._~]/.test(ch)) {
            out += ch;
            continue;
        }
        for (const byte of Buffer.from(ch, 'utf8')) {
            out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
        }
    }
    return out;
}

/**
 * 对象键 → URL path（不含开头的 `/`）：按 `/` 切段、**逐段** UriEncode，段之间的 `/` 保留。
 * 于是 `irmia/0.1.0-beta.12/安装 包+1%.zip` 仍是 3 段，空格/加号/百分号各自编码；
 * 空段也保留（`a//b` → `a//b`），不做路径规范化 —— S3/R2 的键是字面量，`..` 不该被吃掉。
 */
export function encodeKeyPath(key) {
    const clean = String(key).replace(/^\/+/, '');
    if (clean === '') return '';
    return clean.split('/').map(uriEncode).join('/');
}

/** `x-amz-date` 的形状：`YYYYMMDD'T'HHMMSS'Z'`（UTC，无毫秒） */
export function formatAmzDate(date = new Date()) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ════════════════════════════════════════════════════════════════════════════
// 二、SigV4 核心（可单独调用，测试直接拿官方测试向量打这里）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 头名小写、值去首尾空白并把内部连续空白压成一个空格，按头名排序；
 * 同名头（数组形式传入）按出现顺序用逗号合并 —— 与 SigV4 的 CanonicalHeaders 一致。
 * 返回 `[[name, value], …]`，已排序。
 */
export function normalizeHeaders(headers) {
    const pairs = Array.isArray(headers) ? headers : Object.entries(headers ?? {});
    const merged = new Map();
    for (const [rawName, rawValue] of pairs) {
        const name = String(rawName).toLowerCase();
        const value = String(rawValue).trim().replace(/\s+/g, ' ');
        merged.set(name, merged.has(name) ? `${merged.get(name)},${value}` : value);
    }
    return [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 拼 CanonicalRequest（六行，CanonicalHeaders 自身以 `\n` 结尾，所以中间有一个空行）：
 *   method \n canonicalUri \n canonicalQuery \n canonicalHeaders \n signedHeaders \n payloadHash
 * `canonicalUri` 必须是**已经编码好的**绝对路径（`/` 开头）；这里不再编码，
 * 免得同一个字符被编两遍（S3 与其它服务在 URI 编码上本来就不同）。
 */
export function buildCanonicalRequest({ method, canonicalUri, canonicalQuery = '', headers, payloadHash }) {
    if (typeof canonicalUri !== 'string' || !canonicalUri.startsWith('/')) {
        throw new Error(`canonicalUri 必须以 / 开头：${canonicalUri}`);
    }
    if (!payloadHash) throw new Error('缺少 payloadHash');
    const entries = normalizeHeaders(headers);
    if (entries.length === 0) throw new Error('至少要有 host 参与签名');
    const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join('');
    const signedHeaders = entries.map(([name]) => name).join(';');
    return [
        String(method).toUpperCase(),
        canonicalUri,
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');
}

/** 派生签名密钥：HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
export function signingKey(secretAccessKey, dateStamp, region, service) {
    const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp, 'utf8').digest();
    const kRegion = createHmac('sha256', kDate).update(region, 'utf8').digest();
    const kService = createHmac('sha256', kRegion).update(service, 'utf8').digest();
    return createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
}

/** StringToSign → 签名（小写 hex） */
export function computeSignature({ secretAccessKey, dateStamp, region, service, stringToSign }) {
    const key = signingKey(secretAccessKey, dateStamp, region, service);
    return createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
}

/**
 * 对一批**已经决定好的**头做 SigV4 签名，返回 Authorization 与中间产物。
 * 这里刻意不自动塞 `x-amz-content-sha256`：官方测试向量（get-vanilla）里没有这个头，
 * 自动加就会改变 SignedHeaders、也改变签名。要 S3 形状请用 `buildPutRequest`。
 *
 * 返回：{ authorization, canonicalRequest, stringToSign, signature, signedHeaders, scope, amzDate }
 * Authorization 的排版与 AWS 官方测试套件一致（`Credential=…, SignedHeaders=…, Signature=…`）。
 */
export function signRequest({
    method,
    canonicalUri,
    canonicalQuery = '',
    headers,
    payloadHash,
    accessKeyId,
    secretAccessKey,
    region = 'auto',
    service = 's3',
    amzDate,
}) {
    if (!accessKeyId) throw new Error('缺少 accessKeyId');
    if (!secretAccessKey) throw new Error('缺少 secretAccessKey');

    const entries = normalizeHeaders(headers);
    const headerDate = entries.find(([name]) => name === 'x-amz-date')?.[1];
    const stamp = amzDate ?? headerDate ?? formatAmzDate(new Date());
    if (headerDate && stamp !== headerDate) {
        throw new Error('amzDate 与 headers 里的 x-amz-date 不一致');
    }
    const dateStamp = stamp.slice(0, 8);
    const scope = `${dateStamp}/${region}/${service}/aws4_request`;
    const canonicalRequest = buildCanonicalRequest({
        method, canonicalUri, canonicalQuery, headers: entries, payloadHash,
    });
    const stringToSign = [
        ALGORITHM,
        stamp,
        scope,
        sha256Hex(canonicalRequest),
    ].join('\n');
    const signature = computeSignature({ secretAccessKey, dateStamp, region, service, stringToSign });
    const signedHeaders = entries.map(([name]) => name).join(';');
    const authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, canonicalRequest, stringToSign, signature, signedHeaders, scope, amzDate: stamp };
}

// ════════════════════════════════════════════════════════════════════════════
// 三、把文件变成"要发的那个请求"
// ════════════════════════════════════════════════════════════════════════════

/** endpoint → { protocol, hostname, port, host, basePath }；basePath 保留自定义前缀（去掉尾部 `/`） */
export function endpointParts(endpoint) {
    let url;
    try {
        url = new URL(String(endpoint));
    } catch {
        throw new Error(`endpoint 不是合法 URL：${endpoint}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`endpoint 只支持 http/https：${endpoint}`);
    }
    const rawBase = url.pathname.replace(/\/+$/, '');
    return {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        host: url.host,
        basePath: rawBase === '/' ? '' : rawBase,
    };
}

/** 对象在 endpoint 上的绝对路径：`<basePath>/<bucket>/<encoded key>`（key 为空时以 `/` 结尾） */
export function objectPath({ bucket, key, basePath = '' }) {
    if (!bucket) throw new Error('缺少 bucket');
    const base = basePath ? basePath.replace(/\/+$/, '') : '';
    return `${base}/${uriEncode(bucket)}/${encodeKeyPath(key)}`;
}

/** 上传时要签的头（顺序无所谓，normalizeHeaders 会排序）：host + 全部 x-amz-*，可选 acl */
function signableHeaders({ host, payloadHash, amzDate, acl }) {
    const headers = {
        host,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
    };
    if (acl) headers['x-amz-acl'] = acl;
    return headers;
}

/**
 * 构造 PUT 请求。凭据可选：
 *   · 给了 → 带上 Authorization（真上传）；
 *   · 没给 → `authorization` 为 null，但 URL/头/签名头名全都算好（`--dry-run` 用，不碰凭据）。
 * 返回：
 *   { method, url, path, headers, signedHeaders, authorization, payloadHash, size, amzDate,
 *     protocol, hostname, port }
 */
export function buildPutRequest({
    endpoint,
    bucket,
    key,
    size,
    payloadHash,
    contentType = 'application/octet-stream',
    acl = '',
    region = 'auto',
    service = 's3',
    accessKeyId = '',
    secretAccessKey = '',
    now = new Date(),
}) {
    const parts = endpointParts(endpoint);
    const path = objectPath({ bucket, key, basePath: parts.basePath });
    const amzDate = formatAmzDate(now);
    const headers = {
        host: parts.host,
        'content-length': String(size),
        'content-type': contentType,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
    };
    if (acl) headers['x-amz-acl'] = acl;

    const toSign = signableHeaders({ host: parts.host, payloadHash, amzDate, acl });
    const signedHeaders = normalizeHeaders(toSign).map(([name]) => name).join(';');
    let authorization = null;
    if (accessKeyId && secretAccessKey) {
        authorization = signRequest({
            method: 'PUT',
            canonicalUri: path,
            headers: toSign,
            payloadHash,
            accessKeyId,
            secretAccessKey,
            region,
            service,
            amzDate,
        }).authorization;
        headers.authorization = authorization;
    }
    return {
        method: 'PUT',
        url: `${parts.protocol}//${parts.host}${path}`,
        path,
        headers,
        signedHeaders,
        authorization,
        payloadHash,
        size,
        amzDate,
        protocol: parts.protocol,
        hostname: parts.hostname,
        port: parts.port,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 四、网络：一个最小的请求器（不用 fetch，因为要精确控制 Host/Content-Length）
// ════════════════════════════════════════════════════════════════════════════

/** 单次请求；PUT 的 body 是文件流时边读边发，不把大文件整个吃进内存 */
function sendRequest({ protocol, hostname, port, path, method, headers, body, timeoutMs }) {
    return new Promise((resolvePromise, reject) => {
        const mod = protocol === 'https:' ? https : http;
        const req = mod.request({ protocol, hostname, port, path, method, headers }, (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total <= MAX_ERROR_BODY) chunks.push(chunk);
            });
            res.on('end', () => resolvePromise({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`请求超时（${timeoutMs} ms）`));
        });
        req.on('error', reject);
        if (body) {
            pipeline(body, req).catch(reject);
        } else {
            req.end();
        }
    });
}

/** 把 URL 的内容读成 sha256 + 字节数（用于 CDN 回读；不缓存整份 body） */
function hashUrl(url, timeoutMs = READ_TIMEOUT_MS, redirectsLeft = 3) {
    return new Promise((resolvePromise, reject) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            reject(new Error(`回读 URL 不合法：${url}`));
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            reject(new Error(`回读 URL 只支持 http/https：${url}`));
            return;
        }
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.get(parsed, (res) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
                res.resume();
                const next = new URL(res.headers.location, parsed);
                hashUrl(next.href, timeoutMs, redirectsLeft - 1).then(resolvePromise, reject);
                return;
            }
            const hash = createHash('sha256');
            let size = 0;
            res.on('data', (chunk) => {
                hash.update(chunk);
                size += chunk.length;
            });
            res.on('end', () => resolvePromise({
                status,
                sha256: hash.digest('hex'),
                size,
                contentLength: res.headers['content-length'],
            }));
            res.on('error', reject);
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`回读超时（${timeoutMs} ms）：${url}`)));
        req.on('error', reject);
    });
}

/** 从 S3 的错误 XML 里只抽 <Code>/<Message>，不回显整段 body */
function errorSummary(body) {
    const code = /<Code>([^<]*)<\/Code>/u.exec(body)?.[1];
    const message = /<Message>([^<]*)<\/Message>/u.exec(body)?.[1];
    const text = [code, message].filter(Boolean).join(': ');
    return text || body.replace(/\s+/gu, ' ').slice(0, 200);
}

// ════════════════════════════════════════════════════════════════════════════
// 五、文件信息 / 上传 / 回读
// ════════════════════════════════════════════════════════════════════════════

/** 边读边算 sha256，同时核对"读到的字节数 == stat 的 size"（防止读的途中文件被改） */
export async function fileInfo(file) {
    const info = await stat(file);
    if (!info.isFile()) throw new Error(`不是普通文件：${file}`);
    const hash = createHash('sha256');
    let read = 0;
    for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
        read += chunk.length;
    }
    if (read !== info.size) {
        throw new Error(`文件在读取过程中变了：stat=${info.size} B，实读=${read} B`);
    }
    return { size: info.size, sha256: hash.digest('hex') };
}

/** 已签名 HEAD：回读 R2 上的对象，返回 { status, contentLength } */
async function headObject({ endpoint, bucket, key, accessKeyId, secretAccessKey, region }) {
    const parts = endpointParts(endpoint);
    const path = objectPath({ bucket, key, basePath: parts.basePath });
    const amzDate = formatAmzDate(new Date());
    const toSign = signableHeaders({ host: parts.host, payloadHash: EMPTY_SHA256, amzDate });
    const { authorization } = signRequest({
        method: 'HEAD',
        canonicalUri: path,
        headers: toSign,
        payloadHash: EMPTY_SHA256,
        accessKeyId,
        secretAccessKey,
        region,
        amzDate,
    });
    const res = await sendRequest({
        protocol: parts.protocol,
        hostname: parts.hostname,
        port: parts.port,
        path,
        method: 'HEAD',
        headers: { ...toSign, authorization },
        timeoutMs: READ_TIMEOUT_MS,
    });
    return { status: res.status, contentLength: res.headers['content-length'] };
}

/**
 * 真上传 + 回读。
 * 返回 { size, sha256, putStatus, headStatus, headSize, cdnStatus, cdnSha256 }；
 * 任一步不符就 throw（消息里只有状态码/大小/hash 前缀，不含凭据）。
 */
export async function putObject({
    file,
    key,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region = 'auto',
    contentType = 'application/octet-stream',
    acl = '',
    publicBase = '',
    verify = true,
    log = () => {},
}) {
    const info = await fileInfo(file);
    const request = buildPutRequest({
        endpoint,
        bucket,
        key,
        size: info.size,
        payloadHash: info.sha256,
        contentType,
        acl,
        region,
        accessKeyId,
        secretAccessKey,
    });
    log(`PUT ${request.url}`);
    const put = await sendRequest({
        protocol: request.protocol,
        hostname: request.hostname,
        port: request.port,
        path: request.path,
        method: 'PUT',
        headers: request.headers,
        body: createReadStream(file),
        timeoutMs: PUT_TIMEOUT_MS,
    });
    if (put.status !== 200 && put.status !== 201) {
        throw new Error(`PUT 失败：HTTP ${put.status} ${errorSummary(put.body)}`);
    }
    log(`✓ PUT HTTP ${put.status}  size=${info.size} B  sha256=${info.sha256.slice(0, 16)}…`);

    let headStatus = 0;
    let headSize = null;
    if (verify) {
        const head = await headObject({
            endpoint, bucket, key, accessKeyId, secretAccessKey, region,
        });
        headStatus = head.status;
        headSize = head.contentLength === undefined ? null : Number(head.contentLength);
        if (head.status !== 200) {
            throw new Error(`HEAD 回读失败：HTTP ${head.status}  ${request.url}`);
        }
        if (headSize === null || Number.isNaN(headSize)) {
            throw new Error(`HEAD 没给 Content-Length，无法核对大小：${request.url}`);
        }
        if (headSize !== info.size) {
            throw new Error(`HEAD 大小不符：远端=${headSize} 本地=${info.size}  ${request.url}`);
        }
        log(`✓ HEAD HTTP 200  size=${headSize} B（与本地一致）`);
    }

    let cdnStatus = 0;
    let cdnSha256 = '';
    if (verify && publicBase) {
        const base = String(publicBase).replace(/\/+$/, '');
        const url = `${base}/${encodeKeyPath(key)}`;
        const got = await hashUrl(url);
        cdnStatus = got.status;
        cdnSha256 = got.sha256;
        if (got.status !== 200) {
            throw new Error(`CDN GET 失败：HTTP ${got.status}  ${url}`);
        }
        if (got.sha256 !== info.sha256) {
            throw new Error(`CDN sha256 不符：远端=${got.sha256.slice(0, 16)}… 本地=${info.sha256.slice(0, 16)}…  ${url}`);
        }
        if (got.contentLength !== undefined && Number(got.contentLength) !== info.size) {
            throw new Error(`CDN 大小不符：远端=${got.contentLength} 本地=${info.size}  ${url}`);
        }
        log(`✓ GET HTTP 200  sha256=${got.sha256.slice(0, 16)}…（与本地一致）  ${url}`);
    }
    return {
        size: info.size,
        sha256: info.sha256,
        putStatus: put.status,
        headStatus,
        headSize,
        cdnStatus,
        cdnSha256,
    };
}

// ════════════════════════════════════════════════════════════════════════════
// 六、CLI
// ════════════════════════════════════════════════════════════════════════════

const USAGE = `用法：
  node tools/r2-put.mjs --file <path> --key <key> [--dry-run]
       [--content-type CT] [--acl private|public-read]
       [--endpoint URL] [--bucket B] [--region auto]
       [--public-base URL] [--no-verify]

环境变量（只从环境读，绝不打印）：
  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY  R2_BUCKET  R2_ENDPOINT
  R2_ACCOUNT_ID（没有 R2_ENDPOINT 时用）   R2_REGION（默认 auto）   R2_PUBLIC_BASE

--dry-run 只打印将发的 URL / 大小 / sha256 / 请求头名 / 签名头名，不算签名、不碰网络、不需凭据。
退出码：0 成功；1 用法或环境错误；2 上传或回读校验失败。`;

class UsageError extends Error {}

function parseArgs(argv) {
    const args = {
        file: '',
        key: '',
        dryRun: false,
        contentType: 'application/octet-stream',
        acl: '',
        endpoint: '',
        bucket: '',
        region: '',
        publicBase: '',
        verify: true,
        help: false,
    };
    const need = (name, value) => {
        if (value === undefined || value === '') throw new UsageError(`${name} 需要值`);
        return value;
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--file': args.file = need('--file', argv[++i]); break;
            case '--key': args.key = need('--key', argv[++i]); break;
            case '--content-type': args.contentType = need('--content-type', argv[++i]); break;
            case '--acl': args.acl = need('--acl', argv[++i]); break;
            case '--endpoint': args.endpoint = need('--endpoint', argv[++i]); break;
            case '--bucket': args.bucket = need('--bucket', argv[++i]); break;
            case '--region': args.region = need('--region', argv[++i]); break;
            case '--public-base': args.publicBase = need('--public-base', argv[++i]); break;
            case '--dry-run': args.dryRun = true; break;
            case '--no-verify': args.verify = false; break;
            case '-h':
            case '--help': args.help = true; break;
            default:
                throw new UsageError(`未知参数：${arg}（--help 看用法）`);
        }
    }
    if (args.acl && args.acl !== 'private' && args.acl !== 'public-read') {
        throw new UsageError('--acl 只能是 private 或 public-read');
    }
    return args;
}

/** 从环境变量解析出 endpoint / bucket / region / 凭据；不打印任何值 */
function resolveConfig(args, env) {
    const endpoint = args.endpoint || env.R2_ENDPOINT || (() => {
        const account = env.R2_ACCOUNT_ID || '';
        if (!account) return '';
        if (!/^[A-Za-z0-9-]+$/u.test(account)) {
            throw new UsageError('R2_ACCOUNT_ID 含非法字符（应为账户 ID，不是 URL）');
        }
        return `https://${account}.r2.cloudflarestorage.com`;
    })();
    if (!endpoint) throw new UsageError('缺 R2_ENDPOINT 或 R2_ACCOUNT_ID（或 --endpoint）');
    const bucket = args.bucket || env.R2_BUCKET || '';
    if (!bucket) throw new UsageError('缺 R2_BUCKET（或 --bucket）');
    return {
        endpoint,
        bucket,
        region: args.region || env.R2_REGION || 'auto',
        publicBase: args.publicBase || env.R2_PUBLIC_BASE || '',
        accessKeyId: env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY || '',
    };
}

function printPlan({ args, config, request, size, sha256, file }) {
    const headerNames = Object.keys(request.headers)
        .filter((name) => name !== 'authorization')
        .sort();
    console.log('R2 PUT（dry-run：一个请求都不发）');
    console.log(`  文件            : ${file}`);
    console.log(`  URL             : ${request.url}`);
    console.log('  method          : PUT');
    console.log(`  size            : ${size} B`);
    console.log(`  content-type    : ${args.contentType}`);
    if (args.acl) console.log(`  x-amz-acl       : ${args.acl}`);
    console.log(`  x-amz-date      : ${request.amzDate}`);
    console.log(`  payload sha256  : ${sha256}`);
    console.log(`  请求头名        : ${headerNames.join(', ')}`);
    console.log(`  签名头名        : ${request.signedHeaders}`);
    console.log('  Authorization   : （dry-run：不计算、不打印签名）');
    console.log(`  回读计划        : 已签名 HEAD ${request.url} 比 size`
        + (config.publicBase ? `；GET ${config.publicBase.replace(/\/+$/, '')}/… 比 sha256` : '；未给 public-base，不做 CDN GET'));
    console.log(`  bucket / region : ${config.bucket} / ${config.region}`);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
    let args;
    let config;
    try {
        args = parseArgs(argv);
    } catch (err) {
        console.error(`✗ ${err.message}`);
        return 1;
    }
    if (args.help) {
        console.log(USAGE);
        return 0;
    }
    try {
        if (!args.file) throw new UsageError('缺 --file');
        if (!args.key) throw new UsageError('缺 --key');
        const file = resolve(args.file);
        config = resolveConfig(args, env);

        // dry-run 也要真的读文件：size/sha256 是计划的一部分，而且能提前暴露路径/权限问题
        const info = await fileInfo(file);
        const request = buildPutRequest({
            endpoint: config.endpoint,
            bucket: config.bucket,
            key: args.key,
            size: info.size,
            payloadHash: info.sha256,
            contentType: args.contentType,
            acl: args.acl,
            region: config.region,
        });

        if (args.dryRun) {
            printPlan({ args, config, request, size: info.size, sha256: info.sha256, file });
            return 0;
        }
        if (!config.accessKeyId || !config.secretAccessKey) {
            throw new UsageError('缺 R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY（只从环境变量读，不会打印）');
        }
        const result = await putObject({
            file,
            key: args.key,
            endpoint: config.endpoint,
            bucket: config.bucket,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            region: config.region,
            contentType: args.contentType,
            acl: args.acl,
            publicBase: config.publicBase,
            verify: args.verify,
            log: (line) => console.log(line),
        });
        console.log(`✓ 完成：${request.url}`);
        console.log(`  size=${result.size} B  sha256=${result.sha256}`);
        console.log(`  bucket=${config.bucket}  region=${config.region}  （凭据未打印）`);
        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`✗ ${message}`);
        if (err instanceof UsageError) return 1;
        // 网络/服务端/校验错误统一 2；用法错误已在上面判过
        return shouldBeUsage(message) ? 1 : 2;
    }
}

/** 少数运行期错误（文件不存在、endpoint 不合法）其实是用法问题，按 1 返回更准确 */
function shouldBeUsage(message) {
    return /不是普通文件|ENOENT|endpoint 不是合法 URL|endpoint 只支持|缺少 bucket/u.test(message);
}

const invokedDirectly = process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
    main().then((code) => {
        process.exitCode = code;
    }).catch((err) => {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
    });
}
