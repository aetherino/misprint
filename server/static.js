// Static file handler with the same URL layout as tools/static.mjs:
//   /…        → <root>/public/…      /shared/… → <root>/shared/…
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

export function createStaticHandler(root) {
  const publicDir = path.join(root, 'public');
  const sharedDir = path.join(root, 'shared');

  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (p.includes('\0')) { res.writeHead(400).end('bad request'); return; }
    if (p.endsWith('/')) p += 'index.html';

    const shared = p.startsWith('/shared/');
    const base = shared ? sharedDir : publicDir;
    const file = path.normalize(path.join(shared ? root : publicDir, p));
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  };
}
