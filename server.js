// 로컬 실행용 서버: public/ 정적 파일 + /api/extract, /api/inbox
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import extract from './api/extract.js';
import inbox from './api/inbox.js';

const pub = join(dirname(fileURLToPath(import.meta.url)), 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.png': 'image/png', '.apk': 'application/vnd.android.package-archive', '.txt': 'text/plain; charset=utf-8',
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/api/extract') return extract(req, res);
  if (path === '/api/inbox') return inbox(req, res);
  let file = normalize(join(pub, path));
  if (!file.startsWith(pub)) { res.statusCode = 403; return res.end(); }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    statSync(file);
  } catch { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log(`http://localhost:${process.env.PORT || 3000}`));
