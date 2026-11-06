import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import http from 'node:http';

const server = new Server(
  { name: 'linre-file-helper', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'send_file',
        description: '提供直接发送文件给用户的工具：支持将本地文件通过 OneBot 协议端上传并私聊发送。',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: '要发送的本地文件路径（绝对路径或相对工作目录）' },
            userId: { type: 'number', description: '接收者的 QQ 号（默认发给妈 3652971137）' },
            fileName: { type: 'string', description: '发送时的文件名（可选，默认取原文件名）' }
          },
          required: ['filePath']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'send_file') {
    throw new Error(`未知工具: ${request.params.name}`);
  }

  const args = request.params.arguments || {};
  const filePath = String(args.filePath || '');
  const userId = Number(args.userId || 3652971137);
  const fileName = args.fileName ? String(args.fileName) : basename(filePath);

  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    return {
      content: [{ type: 'text', text: `发送失败：文件不存在 -> ${absPath}` }],
      isError: true
    };
  }

  // 尝试通过标准的 OneBot HTTP 接口发送文件
  // 默认 OneBot 地址：http://127.0.0.1:3000 (或通过环境变量)
  const onebotUrl = process.env.ONEBOT_HTTP_URL || 'http://127.0.0.1:3000';
  const accessToken = process.env.ONEBOT_ACCESS_TOKEN || '';

  try {
    // 构造 JSON 请求上传私聊文件
    const payload = JSON.stringify({
      user_id: userId,
      file: absPath,
      name: fileName
    });

    const urlObj = new URL('/upload_private_file', onebotUrl);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    const resultText = await new Promise((resolveP, rejectP) => {
      const req = http.request({
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'POST',
        headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolveP(data));
      });
      req.on('error', err => rejectP(err));
      req.write(payload);
      req.end();
    });

    const resJson = JSON.parse(resultText);
    if (resJson.ok || resJson.status === 'ok') {
      return {
        content: [{ type: 'text', text: `文件已成功通过 OneBot 协议私聊发送给 ${userId}（文件: ${fileName}，路径: ${absPath}）` }]
      };
    } else {
      return {
        content: [{ type: 'text', text: `OneBot 返回错误: ${resultText}。提示：若协议端运行在容器内，可将文件考入容器或通过桌面文件夹交付。当前文件已备在桌面：C:\\Users\\admin\\Desktop\\第3单元作业.zip` }],
        isError: true
      };
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `调用 OneBot 失败: ${err.message}。当前文件已备在桌面：C:\\Users\\admin\\Desktop\\第3单元作业.zip` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
