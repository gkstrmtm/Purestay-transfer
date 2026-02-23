const { sendJson, handleCors, bearerToken } = require('../lib/vercelApi');
const { getLogTail } = require('../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const adminToken = process.env.ADMIN_TOKEN || '';
  const url = req.url ? new URL(req.url, 'http://localhost') : null;
  const token = (url && url.searchParams.get('token')) || bearerToken(req) || '';

  if (!adminToken || token !== adminToken) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }

  const items = await getLogTail('purestay:log:contact:v1', 200);
  return sendJson(res, 200, { ok: true, items });
};
