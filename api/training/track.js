const { sendJson, handleCors, readJson, isValidEmail } = require('../../lib/vercelApi');
const { appendLog } = require('../../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const payload = await readJson(req);
  if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const email = String(payload.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'invalid_email' });

  const entry = {
    type: 'training_track',
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || '',
    userAgent: String(req.headers['user-agent'] || ''),
    email,
    full_name: String(payload.full_name || '').slice(0, 200),
    module_slug: String(payload.module_slug || '').slice(0, 80),
    module_title: String(payload.module_title || '').slice(0, 200),
    action: String(payload.action || '').slice(0, 80),
    device: String(payload.device || '').slice(0, 30),
  };

  await appendLog('purestay:log:training:v1', entry);
  return sendJson(res, 200, { ok: true });
};
