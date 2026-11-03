// 零依赖静态服务器：摄像头权限需要 localhost / https，双击 file:// 打开无法取摄像头。
// 用法：node scripts/serve.mjs [port]   默认 8000
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

// 仅需极少 MIME 映射：页面实际只用到 html/css/js/mjs/json、wasm、模型、字体
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ROOT 本身的上一级是工作区根目录，可能放着本项目无关的文件（其他项目、依赖源码）。
// 只允许读取 ROOT 之内的真实文件：任何从 ROOT 规范化到 ROOT 之外（含父目录）的请求一律 403。
const ROOT_PREFIX = ROOT + path.sep;

const server = http.createServer(async (req, res) => {
  try {
    // 注意：不能用 new URL().pathname —— WHATWG URL 会把 /a/../../b 先规范化成 /b，
    // 穿越就发生在 URL 解析这一步，之后的 startsWith 检查根本看不到 `..`。
    // 因此直接取请求行原始路径（去掉查询串），自己做一次解码并拒绝含 .. 的段。
    const rawPath = (req.url || '/').split('?')[0].split('#')[0];
    let rel;
    try { rel = decodeURIComponent(rawPath); } catch { rel = rawPath; }
    if (/(^|\/)\.\.(\/|$)/.test(rel) || rel.includes('\0') || /^[a-zA-Z]:/.test(rel)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const filePath = path.resolve(ROOT, '.' + rel);
    if (!filePath.startsWith(ROOT_PREFIX)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found: ' + rel);
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  DINO MOTION  →  http://localhost:${PORT}\n  允许摄像头权限即可开始；Ctrl+C 停止。\n`);
});
