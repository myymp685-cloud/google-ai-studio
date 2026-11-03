// 用 CDP 直接驱动本机 Chromium/Edge：验证页面能跑、截静态图、录 screencast 帧（供做 GIF）。
// 零依赖（Node 24 自带 fetch/WebSocket）。用法：
//   node scripts/capture-shots.mjs <url> <outDir>
// 适用：GitHub Pages 子路径模拟、本地 http、任何静态托管地址。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const URL_IN = process.argv[2] || 'http://localhost:8000/';
const OUT = path.resolve(process.argv[3] || 'shots');
const CANDIDATES = [
  path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'),
  path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const BROWSER = CANDIDATES.find(existsSync);
if (!BROWSER) { console.error('找不到 Chromium/Edge'); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const PORT = 9300 + Math.floor(Math.random() * 400);
const PROFILE = path.join(os.tmpdir(), 'cdp-capture-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--window-size=1440,900', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore', detached: false });

// ---- 极简 CDP 客户端 ----
let nextId = 1; const pending = new Map(); const listeners = new Map();
let ws;
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
function on(evt, cb) { (listeners.get(evt) || listeners.set(evt, []).get(evt)).push(cb); }
const consoleErrors = [];

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (v.webSocketDebuggerUrl) break;
    } catch {}
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
    } else if (msg.method) {
      for (const cb of listeners.get(msg.method) || []) cb(msg.params);
      // 收集真正的 JS 错误
      if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push('EXC ' + (msg.params.exceptionDetails?.text || ''));
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
        consoleErrors.push('CONSOLE ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error')
        consoleErrors.push('LOG ' + msg.params.entry.text);
    }
  };
}

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
  return name;
};
const key = async (code, keyName, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(30);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};

(async () => {
  try {
    await connect();
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    console.log('[1] navigate', URL_IN);
    await send('Page.navigate', { url: URL_IN });

    // 等加载层跑完 + 摄像头引导出现（vendor 18MB+5.5MB 本地加载，给足 90s）
    let ready = false;
    await sleep(1400); await shot('00-loading.png');
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      try {
        const s = await evalJs(`(()=>{const p=document.querySelector('#cam-prompt');const o=document.querySelector('#intro-overlay');return {prompt: p && !p.classList.contains('hidden'), overlayDone: o && o.classList.contains('hidden'), pct: (document.querySelector('#intro-load-label')||{}).textContent||''};})()`);
        if (i % 5 === 0) console.log('   wait', i + 's', JSON.stringify(s));
        if (s.prompt) { ready = true; break; }
        if (s.overlayDone) { ready = true; break; }
      } catch (e) { console.log('   poll err', e.message); }
    }
    console.log('[2] intro ready =', ready);
    await shot('00-loading-or-intro.png');

    // 跳过摄像头 → 直接 playing
    const clicked = await evalJs(`(()=>{const a=document.querySelector('#skip-cam-link'); if(a){a.click();return 'skip-clicked';} const p=document.querySelector('#cam-prompt'); return p&&!p.classList.contains('hidden')?'prompt-still':'no-prompt';})()`);
    console.log('[3] skip:', clicked);

    // 等进入 3D playing（hud3d 显示）
    let playing = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await evalJs(`(()=>{const h=document.querySelector('#hud3d');return h? !h.classList.contains('hidden') : false;})()`);
      if (s) { playing = true; break; }
    }
    console.log('[4] playing3d =', playing);
    // 万一卡在 calibrating（点了校准按钮而非跳过），空格跳过
    await evalJs(`(()=>{const f=document.querySelector('#calib-overlay'); if(f && !f.classList.contains('hidden')) document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',bubbles:true}));})()`);

    // ---- 录 screencast（真实游戏帧，供 GIF）----
    const frames = [];
    on('Page.screencastFrame', (p) => {
      frames.push(p.data);
      send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
    await send('Page.startScreencast', { format: 'png', quality: 85, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    console.log('[5] screencast started');

    // 录 14s：定时跳跃 + 偶尔变道，制造动感
    const t0 = Date.now();
    let k = 0;
    while (Date.now() - t0 < 26000) {
      if (k % 2 === 0) await key('Space', ' ', 32);
      if (k % 5 === 3) await key('KeyA', 'a', 65);
      if (k % 5 === 4) await key('KeyD', 'd', 68);
      if (k === 3) await shot('01-gameplay-a.png');
      if (k === 8) await shot('02-gameplay-b.png');
      if (k === 13) await shot('03-gameplay-c.png');
      if (k === 19) await shot('03b-gameplay-d.png');
      if (k === 25) await shot('03c-gameplay-e.png');
      k++;
      await sleep(650);
    }
    await send('Page.stopScreencast');
    console.log('[6] frames captured:', frames.length);

    // 写帧（供 ffmpeg 合成 GIF）
    const frameDir = path.join(OUT, 'frames');
    mkdirSync(frameDir, { recursive: true });
    frames.forEach((d, i) => writeFileSync(path.join(frameDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(d, 'base64')));

    // ---- 等距视角截图 ----
    await evalJs(`(()=>{const b=document.querySelector('#cam-toggle'); if(b)b.click();})()`);
    await sleep(1200); await shot('04-iso-camera.png');

    // 干净版 hero 图：临时隐藏调试摄像头面板（保持等距视角）
    await evalJs(`(()=>{const d=document.querySelector('#cam-debug'); if(d) d.style.display='none';})()`);
    await sleep(1400); await shot('06-hero-clean.png');
    await evalJs(`(()=>{const d=document.querySelector('#cam-debug'); if(d) d.style.display='';})()`);

    // ---- 2D 兜底模式截图 ----
    await evalJs(`(()=>{const b=document.querySelector('#mode-toggle'); if(b)b.click();})()`);
    await sleep(1200); await shot('05-2d-mode.png');

    // 页面状态汇总
    const state = await evalJs(`(()=>({title:document.title, webgl: (()=>{try{return !!document.createElement('canvas').getContext('webgl2')}catch(e){return 'err'}})(), canvases:document.querySelectorAll('canvas').length}))()`);
    console.log('[7] state', JSON.stringify(state));
    console.log('[8] console errors:', consoleErrors.length ? consoleErrors.slice(0, 12) : 'NONE');
    writeFileSync(path.join(OUT, '_report.json'), JSON.stringify({ url: URL_IN, playing, frames: frames.length, consoleErrors, state }, null, 2));
    console.log('DONE ->', OUT);
  } catch (e) {
    console.error('CAPTURE_FAILED', e.message);
    process.exitCode = 1;
  } finally {
    try { await send('Browser.close'); } catch {}
    try { child.kill(); } catch {}
    await sleep(400);
    try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  }
})();
