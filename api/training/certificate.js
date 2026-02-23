const { sendJson, handleCors, readJson, isValidEmail } = require('../../lib/vercelApi');
const { appendLog, addToSet } = require('../../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const payload = await readJson(req);
  if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const email = String(payload.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'invalid_email' });

  const entry = {
    type: 'training_certificate',
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || '',
    userAgent: String(req.headers['user-agent'] || ''),
    email,
    full_name: String(payload.full_name || '').slice(0, 200),
    date_iso: String(payload.date_iso || '').slice(0, 20),
  };

  await appendLog('purestay:log:training:v1', entry);
  await addToSet(`purestay:training:completed:${email}`, 'certification');

  return sendJson(res, 200, { ok: true });
};
