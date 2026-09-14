// 测试配套静态服务器：把仓库根目录挂在 http://127.0.0.1:8734/ 下
// 用法：node tests/dev-server.mjs  （Ctrl+C 停止；tests/e2e.mjs 依赖它）
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8734;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8'
};

http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(ROOT, p));
  if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end('forbidden'); return; }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    createReadStream(file)
      .on('error', () => { res.writeHead(404).end('not found'); })
      .once('open', () => res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' }))
      .pipe(res);
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/index.html`);
});
