function defaultCorsHeaders(methods = []) {
  const allowedMethods = Array.isArray(methods) && methods.length
    ? methods
    : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Portal-View-As, X-Portal-View-As-User',
    'Access-Control-Allow-Methods': allowedMethods.join(','),
    'Cache-Control': 'no-store',
  };
}

function applyCors(res, options = {}) {
  const headers = Object.assign({}, defaultCorsHeaders(options.methods), options.headers || {});
  Object.entries(headers).forEach(([key, value]) => {
    if (value != null) res.setHeader(key, value);
  });
}

function handleCors(req, res, options = {}) {
  applyCors(res, options);
  if (String(req?.method || '').toUpperCase() === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, statusCode, payload, options = {}) {
  applyCors(res, options);
  res.statusCode = Number(statusCode) || 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJson(req, options = {}) {
  if (req && req.body !== undefined) {
    if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
    if (typeof req.body === 'string') {
      try {
        return Promise.resolve(req.body.trim() ? JSON.parse(req.body) : {});
      } catch {
        return Promise.resolve(null);
      }
    }
  }

  const limitBytes = Number(options.limitBytes || 1024 * 1024);
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limitBytes) req.destroy();
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function bearerToken(req) {
  const header = String(req?.headers?.authorization || '').trim();
  if (!/^Bearer\s+/i.test(header)) return '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

function isValidEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 320) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

module.exports = {
  bearerToken,
  handleCors,
  isValidEmail,
  readJson,
  sendJson,
};