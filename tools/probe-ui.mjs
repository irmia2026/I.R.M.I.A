import { spawn } from 'node:child_process';

const worker = process.argv[2];
const viewPath = process.argv[3] ?? '/ui/stickers';
const child = spawn(process.execPath, [worker], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === 2) {
      console.log(JSON.stringify(message.result ?? message.error, null, 2).slice(0, 4000));
      child.kill();
      process.exit(0);
    }
  }
});

const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { apiVersion: 2, pluginId: 'probe', capabilities: ['ui.api'] } });
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'ui/handle', params: { path: viewPath } }), 1200);
setTimeout(() => {
  console.error('超时：没有拿到 id=2 的回执');
  child.kill();
  process.exit(1);
}, 15000);
