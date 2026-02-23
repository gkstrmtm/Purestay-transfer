const { sendJson, handleCors, isValidEmail } = require('../../lib/vercelApi');
const { getSetMembers } = require('../../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const url = req.url ? new URL(req.url, 'http://localhost') : null;
  const email = String((url && url.searchParams.get('email')) || '').trim().toLowerCase();
  if (!isValidEmail(email)) return sendJson(res, 422, { ok: false, error: 'invalid_email' });

  const completed = await getSetMembers(`purestay:training:completed:${email}`);
  return sendJson(res, 200, { ok: true, completed });
};
