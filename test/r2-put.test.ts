/**
 * 零依赖 R2 上传器（`tools/r2-put.mjs`）的签名自测。
 *
 * 为什么这组用例值得存在：上传器是我们自己写的 SigV4 —— 签名只差一个字节，R2 就回 403
 * `SignatureDoesNotMatch`，而**发版机没有 aws/rclone 可以对照**。所以判据不能是"能传上去就行"
 * （那要真凭据、真网络），必须是"对**已知的** key/时间/请求，算出**已知的** Authorization"。
 * 这就是下面第 1~3 组干的事：拿 AWS 官方文档/官方测试套件的向量，逐字节比。
 *
 * 向量出处（两条来源，凭据字符串**故意不同**，别混）：
 *   · AWS SigV4 测试套件（`awslabs/aws-c-auth` 的 `aws-signing-test-suite`，公开副本也到处都是）：
 *       get-vanilla                 GET /                      → Signature 5fa00fa3…fbf31
 *       get-vanilla-query-unreserved GET /?-._~0123…            → Signature 9c3e54bf…40197
 *     这两条的 secret 是 `…K7MDENG+bPxRfiCYEXAMPLEKEY`（**加号**）。
 *   · AWS S3 API 文档《Signature Calculations for the Authorization Header: Transferring Payload
 *     in a Single Chunk》里的 “Example: PUT Object”：
 *       PUT /test$file.text（canonical `/test%24file.text`）→ Signature 98ad7217…08bd
 *       canonical request 的 sha256 = 9e0e90d9…2019d
 *     这一条的 secret 是 `…K7MDENG/bPxRfiCYEXAMPLEKEY`（**斜杠**），和测试套件那条不是同一个。
 *     ⚠️ 曾经把两条的 secret 混用，结果 PUT 对、lifecycle 不对 —— 所以这里每个向量各写各的 secret。
 *
 * 断言分四层，越往下越接近真实发版：
 *   1. SigV4 核心：canonical request / string-to-sign / signature / Authorization 全逐字节相等；
 *   2. 编码边界：UriEncode 的保留字符集（空格 `%20` 不是 `+`、`+`/`%`/`$`/`/` 都要编、`~` 不编、
 *      UTF-8 逐字节大写 hex）、对象键按 `/` 分段编码、`..`/空段不被规范化；
 *   3. 请求形状：`Content-Length` = **字节数**（不是字符数）、payload hash、签名头集合、可选 `x-amz-acl`；
 *   4. CLI 行为：`--dry-run` 只打印 URL/头名（**不打印密钥/签名**、不需要凭据）；
 *      真上传走本地回环 HTTP 服务（不碰外网、不需要真凭据），验 PUT 的 method/path/body/Content-Length、
 *      验 HEAD 回读比 size、CDN GET 回读比 sha256，以及两种不符时退出码为 2。
 *
 * ⚠️ 测试里的凭据全是哨兵串（`AKID_SENTINEL…`），断言之一就是它们**一个字都不许出现在输出里**。
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(REPO, 'tools', 'r2-put.mjs');

/** 官方测试套件里的 secret（加号版） */
const SUITE_SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
/** AWS S3 文档示例里的 secret（斜杠版）—— 和套件那条不是同一个 */
const DOCS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface SignedRequest {
  authorization: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  scope: string;
  amzDate: string;
}

interface PutRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  signedHeaders: string;
  authorization: string | null;
  payloadHash: string;
  size: number;
  amzDate: string;
}

interface ToolModule {
  ALGORITHM: string;
  EMPTY_SHA256: string;
  sha256Hex(input: string | Buffer): string;
  uriEncode(value: string): string;
  encodeKeyPath(key: string): string;
  formatAmzDate(date?: Date): string;
  buildCanonicalRequest(opts: {
    method: string;
    canonicalUri: string;
    canonicalQuery?: string;
    headers: Record<string, string> | Array<[string, string]>;
    payloadHash: string;
  }): string;
  signRequest(opts: {
    method: string;
    canonicalUri: string;
    canonicalQuery?: string;
    headers: Record<string, string> | Array<[string, string]>;
    payloadHash: string;
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    service?: string;
    amzDate?: string;
  }): SignedRequest;
  buildPutRequest(opts: {
    endpoint: string;
    bucket: string;
    key: string;
    size: number;
    payloadHash: string;
    contentType?: string;
    acl?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    now?: Date;
  }): PutRequest;
  fileInfo(file: string): Promise<{ size: number; sha256: string }>;
}

/** 动态 import：`tools/r2-put.mjs` 没有 .d.ts，静态 import 会让 `tsc` 要声明文件 */
const tool = (await import(pathToFileURL(TOOL).href)) as ToolModule;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

const R2_ENV_KEYS = [
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET', 'R2_ENDPOINT', 'R2_REGION', 'R2_PUBLIC_BASE',
];

/** 清掉环境里可能真存在的 R2 凭据，再叠加用例自己的哨兵值（测试不许蹭真凭据） */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of R2_ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}

function runSync(args: string[], extraEnv: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000, env: cleanEnv(extraEnv),
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * 异步版：端到端用例里本进程还开着 HTTP 服务，`spawnSync` 会把事件循环堵死、服务无法应答。
 * 所以凡是要回环服务的用例都必须 await 这个。
 */
function runAsync(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [TOOL, ...args], {
      cwd: REPO, env: cleanEnv(extraEnv), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function tempFile(t: TestContext, name: string, content: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'irmia-r2-put-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * 本地回环 S3 替身：不碰外网、不需要真凭据，只按 method 回固定形状。
 * `respond` 拿得到完整请求（method/url/headers/body），断言在用例里做。
 */
function startServer(
  t: TestContext,
  respond: (req: SeenRequest, res: http.ServerResponse) => void,
): Promise<number> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      respond({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }, res);
    });
  });
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function send(res: http.ServerResponse, status: number, body: Buffer | string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 官方向量（AWS SigV4 测试套件）
// ════════════════════════════════════════════════════════════════════════════

test('官方向量 get-vanilla：canonical request / string-to-sign / Authorization 逐字节相等', () => {
  const result = tool.signRequest({
    method: 'GET',
    canonicalUri: '/',
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256,
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: SUITE_SECRET,
    region: 'us-east-1',
    service: 'service',
    amzDate: '20150830T123600Z',
  });

  assert.equal(result.canonicalRequest, [
    'GET',
    '/',
    '',
    'host:example.amazonaws.com',
    'x-amz-date:20150830T123600Z',
    '',
    'host;x-amz-date',
    EMPTY_SHA256,
  ].join('\n'), 'canonical request 必须与官方向量逐字节相等');

  assert.equal(result.stringToSign, [
    'AWS4-HMAC-SHA256',
    '20150830T123600Z',
    '20150830/us-east-1/service/aws4_request',
    'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
  ].join('\n'), 'string-to-sign 必须与官方向量逐字节相等');

  assert.equal(result.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(result.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, '
    + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    'Authorization 必须与官方向量逐字节相等');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. 官方向量（S3 文档 PUT Object）—— 本文件最要紧的一条：PUT 签名
// ════════════════════════════════════════════════════════════════════════════

test('官方向量 S3 PUT Object：`$` 编成 `%24`，canonical hash / 签名逐字节相等', () => {
  const payload = tool.sha256Hex('Welcome to Amazon S3.');
  assert.equal(payload, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    '示例 body 的 SHA-256 必须与文档一致');
  assert.equal(tool.encodeKeyPath('test$file.text'), 'test%24file.text',
    'S3 文档的 PUT 示例把 `$` 编成 `%24`：UriEncode 的保留字符集比 URL 标准更窄');

  const result = tool.signRequest({
    method: 'PUT',
    canonicalUri: '/test%24file.text',
    headers: {
      date: 'Fri, 24 May 2013 00:00:00 GMT',
      host: 'examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256': payload,
      'x-amz-date': '20130524T000000Z',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
    },
    payloadHash: payload,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: DOCS_SECRET,
    region: 'us-east-1',
    service: 's3',
    amzDate: '20130524T000000Z',
  });

  assert.equal(result.canonicalRequest, [
    'PUT',
    '/test%24file.text',
    '',
    'date:Fri, 24 May 2013 00:00:00 GMT',
    'host:examplebucket.s3.amazonaws.com',
    `x-amz-content-sha256:${payload}`,
    'x-amz-date:20130524T000000Z',
    'x-amz-storage-class:REDUCED_REDUNDANCY',
    '',
    'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
    payload,
  ].join('\n'), 'canonical request 必须与 S3 文档示例逐字节相等');

  assert.equal(result.stringToSign.split('\n')[3],
    '9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d',
    'canonical request 的 SHA-256 必须与文档里的 9e0e90d9… 相等');
  assert.equal(result.signature,
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    'PUT 签名必须与 S3 文档示例逐字节相等');
  assert.equal(result.signedHeaders,
    'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');

  // 文档里的 Authorization 排版是**不带空格**的逗号；我们按 AWS 通用排版（`, `）输出，
  // 两种排版服务端都认，签名本身必须逐字节相等 —— 所以把分隔空格归一后再比整串。
  assert.equal(result.authorization.replace(/, /gu, ','),
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,'
    + 'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class,'
    + 'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. URL 编码边界（官方 query 向量 + 逐字符断言）
// ════════════════════════════════════════════════════════════════════════════

test('URL 编码边界：保留字符、UTF-8 字节、对象键分段，与 query-unreserved 官方向量', () => {
  // ① 保留字符集：unreserved 原样，其余按 UTF-8 字节大写 hex
  assert.equal(tool.uriEncode('AZaz09-._~'), 'AZaz09-._~', 'unreserved 一个都不该被编码（`~` 尤其容易错）');
  assert.equal(tool.uriEncode(' '), '%20', '空格是 %20，不是 +');
  assert.equal(tool.uriEncode('+'), '%2B', '`+` 本身要编码成 %2B');
  assert.equal(tool.uriEncode('/'), '%2F', '单独的 / 编码成 %2F（键里的 / 由分段函数保留）');
  assert.equal(tool.uriEncode('%'), '%25', '`%` 必须编码，否则会造出二次转义');
  assert.equal(tool.uriEncode('$'), '%24', 'S3 文档示例：`$` 也算要编码');
  assert.equal(tool.uriEncode('中文'), '%E4%B8%AD%E6%96%87', 'UTF-8 逐字节、大写 hex');
  assert.equal(tool.uriEncode('😀'), '%F0%9F%98%80', '代理对也必须按 4 字节 UTF-8 编码');

  // ② 对象键：按 / 分段编码，段间 / 保留；空段与 .. 不做规范化（S3/R2 的键是字面量）
  assert.equal(tool.encodeKeyPath('/irmia/0.1.0-beta.12/安装 包+1%.zip'),
    'irmia/0.1.0-beta.12/%E5%AE%89%E8%A3%85%20%E5%8C%85%2B1%25.zip');
  assert.equal(tool.encodeKeyPath('a//b/c'), 'a//b/c');
  assert.equal(tool.encodeKeyPath('a/../b'), 'a/../b', '`..` 不许被吃掉：那是两个不同的对象键');
  assert.equal(tool.encodeKeyPath('/'), '', '只有斜杠的键等于空键');

  // ③ 官方 get-vanilla-query-unreserved：query 里的 unreserved 字符原样进 canonical query
  const query = '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
    + '=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const result = tool.signRequest({
    method: 'GET',
    canonicalUri: '/',
    canonicalQuery: query,
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256,
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: SUITE_SECRET,
    region: 'us-east-1',
    service: 'service',
    amzDate: '20150830T123600Z',
  });
  assert.equal(result.signature, '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197');
  assert.equal(result.canonicalRequest.split('\n')[2], query, 'canonical query 必须原样保留 unreserved 字符');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 请求形状：Content-Length / payload hash / 可选 x-amz-acl
// ════════════════════════════════════════════════════════════════════════════

test('Content-Length 是字节数（不是字符数），且不参与签名；x-amz-acl 参与签名', async (t) => {
  const data = Buffer.from('IRMIA 安装包 v0.1.0-beta.12\n', 'utf8');
  const file = tempFile(t, 'irmia-agent 安装包+.zip', data);
  const info = await tool.fileInfo(file);

  assert.equal(info.size, data.length);
  assert.equal(info.size, Buffer.byteLength(data), '大小必须是字节数：中文一个字 3 字节，不是 1');
  assert.equal(info.sha256, tool.sha256Hex(data));

  const request = tool.buildPutRequest({
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'irmia-dl',
    key: 'irmia/0.1.0-beta.12/安装 包+1%.zip',
    size: info.size,
    payloadHash: info.sha256,
    contentType: 'application/zip',
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'SECRETTEST',
  });

  assert.equal(request.headers['content-length'], String(data.length),
    'Content-Length 必须等于文件字节数');
  assert.equal(request.headers['x-amz-content-sha256'], info.sha256);
  assert.equal(request.headers['content-type'], 'application/zip');
  assert.equal(request.signedHeaders, 'host;x-amz-content-sha256;x-amz-date',
    '只签 host + x-amz-*：Content-Length/Content-Type 照发但不绑进签名');
  assert.equal(request.url,
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/irmia-dl/'
    + 'irmia/0.1.0-beta.12/%E5%AE%89%E8%A3%85%20%E5%8C%85%2B1%25.zip',
    'URL path 必须逐段编码，桶名/键都按 S3 path-style 拼');

  const withAcl = tool.buildPutRequest({
    endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'irmia-dl',
    key: 'irmia/0.1.0-beta.12/pkg.zip',
    size: info.size,
    payloadHash: info.sha256,
    acl: 'public-read',
    accessKeyId: 'AKIDTEST',
    secretAccessKey: 'SECRETTEST',
  });
  assert.equal(withAcl.headers['x-amz-acl'], 'public-read');
  assert.equal(withAcl.signedHeaders, 'host;x-amz-acl;x-amz-content-sha256;x-amz-date',
    '可选 acl 头要一起签名（头名排序是 acl 在 content-sha256 前）');
  assert.match(withAcl.authorization ?? '',
    /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-acl;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. CLI --dry-run：打印 URL/头名，不打印密钥/签名，不需要凭据
// ════════════════════════════════════════════════════════════════════════════

test('--dry-run：只打印 URL 与头名，不含密钥/签名；没有凭据也能跑', (t) => {
  const file = tempFile(t, 'pkg.zip', Buffer.from('dry-run payload', 'utf8'));
  const env = {
    R2_BUCKET: 'irmia-dl',
    R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    R2_ACCESS_KEY_ID: 'AKID_SENTINEL_DO_NOT_PRINT',
    R2_SECRET_ACCESS_KEY: 'SECRET_SENTINEL_DO_NOT_PRINT',
  };
  const run = runSync([
    '--file', file,
    '--key', 'irmia/0.1.0-beta.12/安装 包+1%.zip',
    '--content-type', 'application/zip',
    '--dry-run',
  ], env);

  assert.equal(run.code, 0, `dry-run 必须 exit 0：\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /URL\s+:/u, '必须打印将发的 URL');
  assert.match(run.stdout, /签名头名\s+:/u, '必须打印签名头名');
  assert.match(run.stdout, /host;x-amz-content-sha256;x-amz-date/u);
  assert.ok(run.stdout.includes('content-length'), '请求头名里要看得到 content-length');
  assert.ok(run.stdout.includes('irmia-dl/irmia/0.1.0-beta.12/'),
    'URL 里要有桶名和编码后的键');

  // 三条不许：凭据、签名值、Authorization 头值
  assert.ok(!run.stdout.includes('AKID_SENTINEL_DO_NOT_PRINT'), 'access key 一个字都不许进输出');
  assert.ok(!run.stdout.includes('SECRET_SENTINEL_DO_NOT_PRINT'), 'secret 一个字都不许进输出');
  assert.ok(!run.stdout.includes('Signature='), 'dry-run 不许出现签名值');
  assert.ok(!run.stderr.includes('SECRET_SENTINEL_DO_NOT_PRINT'), 'stderr 同样不许带 secret');

  // 没有凭据也必须能 dry-run（它只算 URL/头名，不签名）
  const noCreds = runSync([
    '--file', file,
    '--key', 'irmia/0.1.0-beta.12/pkg.zip',
    '--endpoint', env.R2_ENDPOINT,
    '--bucket', env.R2_BUCKET,
    '--dry-run',
  ]);
  assert.equal(noCreds.code, 0, `dry-run 不该依赖凭据：\n${noCreds.stdout}${noCreds.stderr}`);
  assert.match(noCreds.stdout, /Authorization\s+:\s+（dry-run/u);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. 端到端：本地回环服务上的真 PUT + HEAD/CDN 回读
// ════════════════════════════════════════════════════════════════════════════

test('端到端（本地回环）：PUT 的 path/body/Content-Length/签名头正确，HEAD 比 size、CDN GET 比 sha256', async (t) => {
  const data = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0xff, 0x1a, 0x2b]);
  const file = tempFile(t, 'irmia-agent.zip', data);
  const seen: SeenRequest[] = [];
  const port = await startServer(t, (req, res) => {
    seen.push(req);
    if (req.method === 'PUT') {
      send(res, 200, '');
    } else if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(data.length) });
      res.end();
    } else {
      send(res, 200, data, { 'content-type': 'application/zip' });
    }
  });
  const key = 'irmia/0.1.0-beta.12/安装 包+1%.zip';
  const env = {
    R2_ACCESS_KEY_ID: 'AKIDTESTKEY',
    R2_SECRET_ACCESS_KEY: 'SECRETTESTVALUE',
    R2_BUCKET: 'test-bucket',
    R2_ENDPOINT: `http://127.0.0.1:${port}`,
    R2_REGION: 'auto',
  };
  const run = await runAsync([
    '--file', file,
    '--key', key,
    '--content-type', 'application/zip',
    '--public-base', `http://127.0.0.1:${port}/cdn`,
  ], env);

  assert.equal(run.code, 0, `真上传路径必须 exit 0：\n${run.stdout}\n${run.stderr}`);

  const put = seen.find((req) => req.method === 'PUT');
  assert.ok(put, '必须真的发出 PUT');
  assert.equal(put.url,
    '/test-bucket/irmia/0.1.0-beta.12/%E5%AE%89%E8%A3%85%20%E5%8C%85%2B1%25.zip',
    'PUT 的 path 必须是 path-style + 逐段 UriEncode');
  assert.equal(put.headers['content-length'], String(data.length), 'PUT 必须带正确的 Content-Length');
  assert.deepEqual(put.body, data, 'PUT body 必须逐字节等于本地文件');
  assert.equal(put.headers['x-amz-content-sha256'], tool.sha256Hex(data));
  assert.match(String(put.headers.authorization),
    /^AWS4-HMAC-SHA256 Credential=AKIDTESTKEY\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/u,
    'Authorization 必须是 auto/s3 的 SigV4，且只签 host + x-amz-*');

  const head = seen.find((req) => req.method === 'HEAD');
  assert.ok(head, '上传后必须回读 HEAD');
  assert.equal(head.url, put.url, 'HEAD 打的是同一个对象');
  assert.ok(seen.some((req) => req.method === 'GET'), '给了 public-base 就必须做 CDN GET');

  assert.match(run.stdout, /✓ PUT HTTP 200/u);
  assert.match(run.stdout, /✓ HEAD HTTP 200\s+size=10 B/u);
  assert.match(run.stdout, /✓ GET HTTP 200\s+sha256=/u);
  assert.ok(!run.stdout.includes('SECRETTESTVALUE'));
  assert.ok(!run.stderr.includes('SECRETTESTVALUE'));
  assert.ok(!run.stdout.includes('AKIDTESTKEY'), '输出里连 access key id 都不该有');
  assert.ok(!run.stdout.includes('Signature='), '输出里不许有签名值');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. 回读不符：HEAD 大小 / CDN sha256 都要 exit 2
// ════════════════════════════════════════════════════════════════════════════

test('回读大小不符：HEAD 的 Content-Length ≠ 本地 ⇒ exit 2，且报错不含凭据', async (t) => {
  const data = Buffer.from('same bytes', 'utf8');
  const file = tempFile(t, 'pkg.zip', data);
  const port = await startServer(t, (req, res) => {
    if (req.method === 'PUT') {
      send(res, 200, '');
      return;
    }
    // 故意多报 1 字节
    res.writeHead(200, { 'content-length': String(data.length + 1) });
    res.end();
  });
  const run = await runAsync(['--file', file, '--key', 'irmia/v/pkg.zip'], {
    R2_ACCESS_KEY_ID: 'AKIDTESTKEY',
    R2_SECRET_ACCESS_KEY: 'SECRETTESTVALUE',
    R2_BUCKET: 'test-bucket',
    R2_ENDPOINT: `http://127.0.0.1:${port}`,
  });

  assert.equal(run.code, 2, `回读不符必须 exit 2（实际 ${run.code}）：\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /HEAD 大小不符：远端=11 本地=10/u);
  assert.ok(!run.stderr.includes('SECRETTESTVALUE'));
  assert.ok(!run.stdout.includes('✓ HEAD'), '不符时不该打通过的那行 ✓');
});

test('回读 sha256 不符：CDN GET 的内容 ≠ 本地 ⇒ exit 2', async (t) => {
  const data = Buffer.from('original bytes', 'utf8');
  const file = tempFile(t, 'pkg.zip', data);
  const port = await startServer(t, (req, res) => {
    if (req.method === 'PUT') {
      send(res, 200, '');
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(data.length) });
      res.end();
      return;
    }
    // CDN 上是一份被改过的内容（大小相同，内容不同）
    send(res, 200, Buffer.from('tampered bytes', 'utf8'));
  });
  const run = await runAsync([
    '--file', file,
    '--key', 'irmia/v/pkg.zip',
    '--public-base', `http://127.0.0.1:${port}/cdn`,
  ], {
    R2_ACCESS_KEY_ID: 'AKIDTESTKEY',
    R2_SECRET_ACCESS_KEY: 'SECRETTESTVALUE',
    R2_BUCKET: 'test-bucket',
    R2_ENDPOINT: `http://127.0.0.1:${port}`,
  });

  assert.equal(run.code, 2, `sha256 不符必须 exit 2（实际 ${run.code}）：\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /CDN sha256 不符/u);
  assert.ok(!run.stderr.includes('SECRETTESTVALUE'));
});

// ════════════════════════════════════════════════════════════════════════════
// 8. 缺凭据：exit 1，且报错只点环境变量名
// ════════════════════════════════════════════════════════════════════════════

test('缺凭据：真上传必须 exit 1，提示环境变量名，不打印任何值', (t) => {
  const file = tempFile(t, 'pkg.zip', Buffer.from('x', 'utf8'));
  const run = runSync(['--file', file, '--key', 'irmia/v/pkg.zip'], {
    R2_BUCKET: 'test-bucket',
    R2_ENDPOINT: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  });

  assert.equal(run.code, 1, `缺凭据是用法/环境错误，exit 1（实际 ${run.code}）：\n${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /R2_ACCESS_KEY_ID \/ R2_SECRET_ACCESS_KEY/u);
  assert.ok(!run.stdout.includes('undefined'));
  assert.ok(!run.stderr.includes('undefined'));
});
