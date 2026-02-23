const { sendJson, handleCors, readJson, isValidEmail } = require('../lib/vercelApi');
const { appendLog } = require('../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const payload = await readJson(req);
  if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const email = String(payload.email || '').trim();
  if (!isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'invalid_email' });

  const entry = {
    type: 'booking_request',
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || '',
    userAgent: String(req.headers['user-agent'] || ''),
    name: String(payload.name || '').slice(0, 200),
    email: email.slice(0, 200),
    property: String(payload.property || '').slice(0, 200),
    date: String(payload.date || '').slice(0, 20),
    time: String(payload.time || '').slice(0, 40),
    tz: String(payload.tz || '').slice(0, 80),
  };

  if (!entry.date || !entry.time) return sendJson(res, 422, { ok: false, error: 'missing_date_time' });

  const ok = await appendLog('purestay:log:booking:v1', entry);
  if (!ok) return sendJson(res, 200, { ok: true, stored: false, warning: 'storage_unavailable' });

  return sendJson(res, 200, { ok: true, stored: true });
};
