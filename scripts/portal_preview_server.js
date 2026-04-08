const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const BACKEND_ORIGIN = process.env.PORTAL_BACKEND_ORIGIN || 'http://127.0.0.1:3000';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}

function safeFilePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, '');
  const resolved = path.resolve(ROOT, `.${normalized}`);
  return resolved.startsWith(ROOT) ? resolved : null;
}

function serveFile(req, res, filePath) {
  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function proxyApi(req, res, requestUrl) {
  const upstreamUrl = new URL(requestUrl.pathname + requestUrl.search, BACKEND_ORIGIN);
  const options = {
    method: req.method,
    headers: Object.assign({}, req.headers, { host: upstreamUrl.host }),
  };

  const upstreamReq = http.request(upstreamUrl, options, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (error) => {
    const payload = JSON.stringify({ ok: false, error: 'backend_unreachable', detail: String(error.message || error) });
    send(res, 502, payload, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (requestUrl.pathname.startsWith('/api/')) {
    proxyApi(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    serveFile(req, res, path.join(ROOT, 'Portal.html'));
    return;
  }

  const filePath = safeFilePath(requestUrl.pathname);
  if (!filePath) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  serveFile(req, res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`Portal preview running at http://${HOST}:${PORT}`);
  console.log(`Proxying /api/* to ${BACKEND_ORIGIN}`);
});
