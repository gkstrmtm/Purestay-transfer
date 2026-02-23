/* Minimal static server + contact API (no GHL dependencies)
   - Serves files from repo root
   - GET / -> Home.html
   - POST /api/contact -> append JSONL in server/data/contact-submissions.jsonl
   - GET /api/health
   - GET /api/submissions (requires ADMIN_TOKEN)
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(__dirname, 'data');
const CONTACT_LOG = path.join(DATA_DIR, 'contact-submissions.jsonl');
const QUOTE_LOG = path.join(DATA_DIR, 'quote-submissions.jsonl');
const BOOKING_LOG = path.join(DATA_DIR, 'booking-requests.jsonl');
const TRAINING_LOG = path.join(DATA_DIR, 'training-events.jsonl');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function env(key, fallback = undefined) {
  return process.env[key] ?? fallback;
}

const PORT = Number(env('PORT', '5173'));
const ADMIN_TOKEN = env('ADMIN_TOKEN', '');

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, obj) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeDecode(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.mp4': return 'video/mp4';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function withinRoot(candidatePath) {
  const rel = path.relative(ROOT_DIR, candidatePath);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function parseUrlEncoded(buf) {
  const s = buf.toString('utf8');
  const out = {};
  for (const [k, v] of new URLSearchParams(s).entries()) out[k] = v;
  return out;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function appendSubmission(filePath, entry) {
  ensureDataDir();
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

function readSubmissions() {
  const p = CONTACT_LOG;
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split(/\n+/).filter(Boolean);
  return lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\n+/).filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* ignore */ }
  }
  return out;
}

function trainingCompletedForEmail(email) {
  if (!email) return [];
  const items = readJsonl(TRAINING_LOG);
  const completed = new Set();
  for (const it of items) {
    if (it && it.type === 'training_complete' && String(it.email || '').toLowerCase() === email.toLowerCase()) {
      if (it.module_slug) completed.add(String(it.module_slug));
    }
    if (it && it.type === 'training_certificate' && String(it.email || '').toLowerCase() === email.toLowerCase()) {
      completed.add('certification');
    }
  }
  return Array.from(completed);
}

function computeQuote(payload) {
  const propertyCount = Math.max(1, Math.min(500, Number(payload?.property_count || 1)));
  const term = String(payload?.term || '3').trim();
  const pkg = String(payload?.package || payload?.package_name || '').trim();

  const baseByPkg = {
    core: 1000,
    culture_shift: 1500,
    signature: 2000,
    discounted_core: 900,
  };
  const base = baseByPkg[pkg] ?? 1000;

  const termDiscount = term === '12' ? 0.10 : term === '6' ? 0.05 : 0;
  const bulkDiscount = propertyCount >= 6 ? 0.08 : propertyCount >= 3 ? 0.05 : 0;
  const discount = Math.min(0.20, termDiscount + bulkDiscount);

  const perPropertyMonthly = Math.round(base * (1 - discount));
  const totalMonthly = perPropertyMonthly * propertyCount;

  return {
    propertyCount,
    termMonths: Number(term) || 3,
    pkg,
    perPropertyMonthly,
    totalMonthly,
    discount,
  };
}

function bearerToken(req) {
  const h = req.headers['authorization'];
  if (!h) return '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeSettings(next) {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
}

function sanitizeSettingsForPublic(settings) {
  const s = settings || {};
  return {
    bookingCalendarUrl: typeof s.bookingCalendarUrl === 'string' ? s.bookingCalendarUrl : '',
    stripeCheckoutUrl: typeof s.stripeCheckoutUrl === 'string' ? s.stripeCheckoutUrl : '',
    stripePricingUrl: typeof s.stripePricingUrl === 'string' ? s.stripePricingUrl : '',
    googleSheets: typeof s.googleSheets === 'string' ? s.googleSheets : '',
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = safeDecode(u.pathname);

  // Convenience slugs
  if (pathname === '/backend' || pathname === '/admin') {
    req.url = '/Backend.html';
    return; // fall through to static handler below
  }

  // --- API ---
  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, now: new Date().toISOString() });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    const settings = sanitizeSettingsForPublic(readSettings());
    return json(res, 200, { ok: true, settings });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const token = bearerToken(req) || u.searchParams.get('token') || '';
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }

    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });

    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const current = readSettings();
    const next = {
      ...current,
      bookingCalendarUrl: String(payload.bookingCalendarUrl || '').trim().slice(0, 2000),
      stripeCheckoutUrl: String(payload.stripeCheckoutUrl || '').trim().slice(0, 2000),
      stripePricingUrl: String(payload.stripePricingUrl || '').trim().slice(0, 2000),
      googleSheets: String(payload.googleSheets || '').trim().slice(0, 20_000),
      updatedAt: new Date().toISOString(),
    };
    writeSettings(next);
    return json(res, 200, { ok: true, settings: sanitizeSettingsForPublic(next) });
  }

  if (pathname === '/api/contact' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });

    let payload = null;
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json')) {
      try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      payload = parseUrlEncoded(buf);
    }

    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const subject = String(payload.subject || '').trim();
    const message = String(payload.message || '').trim();
    if (!subject && !message) return json(res, 422, { ok: false, error: 'subject_or_message_required' });

    const entry = {
      type: 'contact',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      page: String(payload.page || ''),
      subject,
      message
    };

    try {
      appendSubmission(CONTACT_LOG, entry);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { ok: false, error: 'write_failed' });
    }
  }

  if (pathname === '/api/quote' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });

    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const email = String(payload.email || '').trim();
    if (email && !isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });

    const q = computeQuote(payload);
    const entry = {
      type: 'quote',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      payload,
      quote: q,
    };

    try {
      appendSubmission(QUOTE_LOG, entry);
    } catch {
      // ignore write failure; still return quote
    }

    const settings = readSettings();
    const stripeCheckoutUrl = typeof settings.stripeCheckoutUrl === 'string' ? settings.stripeCheckoutUrl.trim() : '';
    const bookingCalendarUrl = typeof settings.bookingCalendarUrl === 'string' ? settings.bookingCalendarUrl.trim() : '';
    const fallbackUrl = '/Discovery.html#ps-calendar';
    const checkoutUrl = stripeCheckoutUrl || bookingCalendarUrl || fallbackUrl;

    return json(res, 200, {
      ok: true,
      quote: {
        band: `$${q.perPropertyMonthly.toLocaleString()}/mo per property`,
        per_property: q.perPropertyMonthly,
        total_monthly: q.totalMonthly,
        properties: q.propertyCount,
        term: q.termMonths,
        package: q.pkg,
      },
      checkout: { url: checkoutUrl },
    });
  }

  if (pathname === '/api/booking' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });

    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const email = String(payload.email || '').trim();
    if (!isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });

    const entry = {
      type: 'booking_request',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      name: String(payload.name || '').slice(0, 200),
      email: email.slice(0, 200),
      property: String(payload.property || '').slice(0, 200),
      date: String(payload.date || '').slice(0, 20),
      time: String(payload.time || '').slice(0, 40),
      tz: String(payload.tz || '').slice(0, 80),
    };

    if (!entry.date || !entry.time) return json(res, 422, { ok: false, error: 'missing_date_time' });

    try {
      appendSubmission(BOOKING_LOG, entry);
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 500, { ok: false, error: 'write_failed' });
    }
  }

  if (pathname === '/api/training/progress' && req.method === 'GET') {
    const email = String(u.searchParams.get('email') || '').trim().toLowerCase();
    if (!isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });
    return json(res, 200, { ok: true, completed: trainingCompletedForEmail(email) });
  }

  if (pathname === '/api/training/enter' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });
    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const email = String(payload.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });

    const entry = {
      type: 'training_enter',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      email,
      full_name: String(payload.full_name || '').slice(0, 200),
    };
    try { appendSubmission(TRAINING_LOG, entry); } catch { /* ignore */ }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/training/track' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });
    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const email = String(payload.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });

    const entry = {
      type: 'training_track',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      email,
      full_name: String(payload.full_name || '').slice(0, 200),
      module_slug: String(payload.module_slug || '').slice(0, 80),
      module_title: String(payload.module_title || '').slice(0, 200),
      action: String(payload.action || '').slice(0, 80),
      device: String(payload.device || '').slice(0, 30),
    };
    try { appendSubmission(TRAINING_LOG, entry); } catch { /* ignore */ }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/training/complete' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });
    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const email = String(payload.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });
    const moduleSlug = String(payload.module_slug || '').trim();
    if (!moduleSlug) return json(res, 422, { ok: false, error: 'missing_module' });

    const entry = {
      type: 'training_complete',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      email,
      full_name: String(payload.full_name || '').slice(0, 200),
      module_slug: moduleSlug.slice(0, 80),
      module_title: String(payload.module_title || '').slice(0, 200),
      device: String(payload.device || '').slice(0, 30),
    };
    try { appendSubmission(TRAINING_LOG, entry); } catch { return json(res, 500, { ok: false, error: 'write_failed' }); }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/training/certificate' && req.method === 'POST') {
    const buf = await readBody(req).catch(() => null);
    if (!buf) return json(res, 400, { ok: false, error: 'Missing body' });
    let payload = null;
    try { payload = JSON.parse(buf.toString('utf8')); } catch { payload = null; }
    if (!payload) return json(res, 400, { ok: false, error: 'Invalid body' });

    const email = String(payload.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return json(res, 422, { ok: false, error: 'invalid_email' });

    const entry = {
      type: 'training_certificate',
      ts: new Date().toISOString(),
      ip: req.socket?.remoteAddress || '',
      userAgent: String(req.headers['user-agent'] || ''),
      email,
      full_name: String(payload.full_name || '').slice(0, 200),
      date_iso: String(payload.date_iso || '').slice(0, 20),
    };
    try { appendSubmission(TRAINING_LOG, entry); } catch { /* ignore */ }
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/submissions' && req.method === 'GET') {
    const token = u.searchParams.get('token') || bearerToken(req);
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      return json(res, 401, { ok: false, error: 'unauthorized' });
    }
    return json(res, 200, { ok: true, items: readSubmissions() });
  }

  // --- Static ---
  let filePath = pathname;
  if (filePath === '/') filePath = '/Home.html';

  const abs = path.join(ROOT_DIR, filePath);
  const normalized = path.normalize(abs);

  // block path traversal
  if (!withinRoot(normalized)) {
    return json(res, 400, { ok: false, error: 'bad_path' });
  }

  fs.stat(normalized, (err, st) => {
    if (err || !st.isFile()) {
      // basic 404
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    }

    const type = contentType(normalized);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store'
    });

    fs.createReadStream(normalized).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[purestay] server running: http://localhost:${PORT}`);
  console.log(`[purestay] serving: ${ROOT_DIR}`);
  if (!ADMIN_TOKEN) console.log('[purestay] ADMIN_TOKEN not set (admin submissions endpoint will be locked)');
});
