// 测试跑手：tests/*.mjs 是「种子自验」脚本（直接 eval 生产代码纯函数区，非传统测试框架）。
// 这里逐个以子进程执行、聚合退出码 —— 任一脚本非 0 退出即整体失败。
// 为什么不直接用 `node --test`：test runner 会把每个文件跑在子进程里，在部分受限/沙箱环境下
// spawn 会以 EPERM 失败；用 spawnSync 跑同一 node 可执行文件则不受影响。
//
// 注意：这些脚本断言的是「数学与状态机规则」（跳跃可达性红线、追逐状态机、障碍采样不变量），
// 不是「它在浏览器里画得好看」——后者需人工在 http://localhost:8000 验收。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests');
const files = readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort();

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`\n${failed === 0 ? '✔ all suites passed' : '✖ ' + failed + ' suite(s) failed'} (${files.length} files)`);
process.exit(failed === 0 ? 0 : 1);
