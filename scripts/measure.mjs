// 零依赖指标采集：用 CDP 驱动本机 Chromium 打开页面，实测
//   ① 首屏资源传输体积（transfer/encoded）  ② DOMContentLoaded / load 耗时
//   ③ 稳定期渲染帧率（rAF 采样 120 帧）       ④ WebGL 渲染器（判断是否硬件加速）
// 用法：node scripts/measure.mjs <url>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_IN = process.argv[2] || 'http://127.0.0.1:8123/';
const CANDIDATES = [
  path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'),
  path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const BROWSER = CANDIDATES.find(existsSync);
if (!BROWSER) { console.error('找不到 Chromium/Edge'); process.exit(1); }

const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(os.tmpdir(), 'cdp-measure-' + Date.now()),
  '--window-size=1440,900', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--ignore-gpu-blocklist', '--enable-gpu',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

let nextId = 1; const pending = new Map();
let ws;
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
try {
  for (let i = 0; i < 100; i++) {
    try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); if (v.webSocketDebuggerUrl) break; } catch {}
    await sleep(100);
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  const t0 = Date.now();
  await send('Page.navigate', { url: URL_IN });
  await sleep(9000); // 等 6s 预热豁免过去，进入稳定期
  const warmup = Date.now() - t0;

  const info = await evaluate(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    let transfer = 0, encoded = 0, decoded = 0;
    const big = [];
    for (const r of res) {
      transfer += r.transferSize || 0; encoded += r.encodedBodySize || 0; decoded += r.decodedBodySize || 0;
      big.push({ n: r.name.split('/').slice(-1)[0], kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 1024) });
    }
    big.sort((a, b) => b.kb - a.kb);
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : 'no-webgl2'),
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '',
      reqCount: res.length,
      transferKB: Math.round(transfer / 1024),
      encodedKB: Math.round(encoded / 1024),
      decodedKB: Math.round(decoded / 1024),
      dclMs: Math.round(nav.domContentLoadedEventEnd || 0),
      loadMs: Math.round(nav.loadEventEnd || 0),
      perfStatus: (document.getElementById('perf-status') || {}).textContent || '(no #perf-status)',
      top: big.slice(0, 8),
    };
  })()`);

  const fps = await evaluate(`new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    function tick(now) { times.push(now - last); last = now; if (times.length < 120) requestAnimationFrame(tick); else {
      const sorted = [...times].sort((a, b) => a - b);
      const sum = times.reduce((a, b) => a + b, 0);
      resolve({ frames: times.length, avgFps: +(1000 / (sum / times.length)).toFixed(1),
                p50ms: +sorted[60].toFixed(2), p95ms: +sorted[113].toFixed(2), maxMs: +sorted[sorted.length-1].toFixed(2) });
    } }
    requestAnimationFrame(tick);
  })`);
  console.log(JSON.stringify({ url: URL_IN, browserReadyMs: warmup, ...info, fps }, null, 2));
} catch (e) {
  console.error('MEASURE ERROR:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { child.kill(); } catch {}
}
