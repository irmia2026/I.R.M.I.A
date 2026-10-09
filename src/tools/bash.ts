import { execFile } from 'node:child_process';
import type { ForbiddenPattern } from './pwsh.js';

export function shellToolName(platform: NodeJS.Platform = process.platform): 'pwsh' | 'bash' {
  return platform === 'win32' ? 'pwsh' : 'bash';
}

export function probeBashVersion(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('bash', ['--version'], { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
      const version = /version (\d+\.\d+(?:\.\d+)?)/u.exec(stdout)?.[1];
      resolve(error === null && version !== undefined ? version : null);
    });
  });
}

export function buildBashSessionBootstrap(marker: string, platform: NodeJS.Platform = process.platform): string {
  const decoder = platform === 'darwin' ? 'base64 -D' : 'base64 -d';
  return [
    'while IFS= read -r irmia_line; do',
    `  irmia_code=$(printf '%s' "$irmia_line" | ${decoder})`,
    // stdin 只承载宿主的命令帧，执行体不能读走下一轮的输入。
    '  eval "$irmia_code" </dev/null 2>&1',
    '  irmia_ec=$?',
    `  printf '\\n%s %s\\n' '__IRMIA_END_${marker}__' "$irmia_ec"`,
    'done',
  ].join('\n');
}

export function buildBashSessionRoundScript(command: string, workdir: string | null): string {
  if (workdir === null) return command;
  const quoted = workdir.replace(/'/gu, `'\\''`);
  return `cd -- '${quoted}' && {\n${command}\n}`;
}

export const BASH_FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    id: 'rm-root',
    pattern: /\brm\s+(?:--?[\w-]+\s+)*(?:["']?\/["']?)(?=\s|$|[;&|])/u,
    reason: '删除文件系统根目录会破坏整台机器',
  },
  {
    id: 'dd-to-device',
    pattern: /\bdd\b[^;\n|&]*\bof=["']?\/dev\//u,
    reason: '直接写入裸设备会破坏磁盘或分区',
  },
  {
    id: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/u,
    reason: '递归创建进程会耗尽机器资源',
  },
  {
    id: 'linux-power-state',
    pattern: /\b(?:shutdown|reboot|halt|poweroff|init\s+[06])\b/u,
    reason: '关机或重启会中断无人值守运行',
  },
  {
    id: 'chmod-root',
    pattern: /\bchmod\s+(?:--?[\w-]+\s+)*777\s+["']?\/["']?(?=\s|$|[;&|])/u,
    reason: '修改根目录权限会破坏机器的权限边界',
  },
  {
    id: 'chown-root',
    pattern: /\bchown\s+(?:--?[\w-]+\s+)*\S+\s+["']?\/["']?(?=\s|$|[;&|])/u,
    reason: '修改根目录属主会破坏系统权限',
  },
];

/** 只检查绝对路径字面量，不解析变量、命令替换或相对路径。 */
export function bashAbsolutePathsIn(command: string): string[] {
  const paths: string[] = [];
  const starts = /(^|[\s"'=<>|;&(])(\/(?!\/))/gu;
  for (let match = starts.exec(command); match !== null; match = starts.exec(command)) {
    const start = match.index + match[1]!.length;
    const previous = command[start - 1];
    const quote = previous === '"' || previous === "'" ? previous : null;
    let end = start + 1;
    while (end < command.length) {
      const char = command[end]!;
      if (quote === null ? /[\s"';|&)<>]/u.test(char) : char === quote) break;
      end += 1;
    }
    const path = command.slice(start, end);
    if (!['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr'].includes(path)) paths.push(path);
    starts.lastIndex = end;
  }
  return paths;
}
