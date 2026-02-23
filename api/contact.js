const { sendJson, handleCors, readJson } = require('../lib/vercelApi');
const { appendLog } = require('../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const payload = await readJson(req);
  if (!payload) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const subject = String(payload.subject || '').trim();
  const message = String(payload.message || '').trim();
  if (!subject && !message) return sendJson(res, 422, { ok: false, error: 'subject_or_message_required' });

  const entry = {
    type: 'contact',
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || '',
    userAgent: String(req.headers['user-agent'] || ''),
    page: String(payload.page || ''),
    subject,
    message,
  };

  const ok = await appendLog('purestay:log:contact:v1', entry);
  if (!ok) {
    // Still succeed so the UX doesn't break, but we warn.
    return sendJson(res, 200, { ok: true, stored: false, warning: 'storage_unavailable' });
  }

  return sendJson(res, 200, { ok: true, stored: true });
};
