import { copyFile, mkdir } from 'node:fs/promises';

// TypeScript only emits JavaScript. Plugin runners also need these original files.
const runners = [
  'node-runner.mjs',
  'python/ast_scan.py',
  'python/irmia_plugin.py',
  'python/runner.py',
  'windows-job.ps1',
];
const source = new URL('../src/plugin/runners/', import.meta.url);
const target = new URL('../dist/plugin/runners/', import.meta.url);
await mkdir(new URL('python/', target), { recursive: true });
await Promise.all(runners.map(path => copyFile(new URL(path, source), new URL(path, target))));
await mkdir(new URL('../dist/media/', import.meta.url), { recursive: true });
await copyFile(new URL('../src/media/pillow-worker.py', import.meta.url), new URL('../dist/media/pillow-worker.py', import.meta.url));
await mkdir(new URL('../dist/runtime/', import.meta.url), { recursive: true });
await copyFile(new URL('../src/runtime/portal-screenshot.py', import.meta.url), new URL('../dist/runtime/portal-screenshot.py', import.meta.url));
