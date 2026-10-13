/** 跑 tests/*.test.js（可选传文件名做子串过滤）：node tests/run.js [filter] */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runAll } from './harness.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js'))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (files.length === 0) {
  console.error(`没有匹配到测试文件${filter ? `（过滤：${filter}）` : ''}`);
  process.exit(1);
}

for (const f of files) {
  process.stdout.write(`\n\x1b[36m── ${f}\x1b[0m\n`);
  await import(pathToFileURL(path.join(dir, f)).href);
}

const { pass, fail } = await runAll('M1');
process.exit(fail > 0 ? 1 : 0);
