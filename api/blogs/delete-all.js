const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { hasKvEnv } = require('../../lib/storage');
const { deleteAllPosts } = require('../../lib/blogs');

async function requireAdminIfConfigured(req) {
  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return { ok: true, warning: 'unprotected' };

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  if (token !== adminToken) return { ok: false };
  return { ok: true };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const auth = await requireAdminIfConfigured(req);
  if (!auth.ok) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  if (!hasKvEnv()) {
    return sendJson(res, 400, { ok: false, error: 'kv_required' });
  }

  const r = await deleteAllPosts();
  return sendJson(res, 200, { ok: true, deleted: r.deleted || 0, ...(auth.warning ? { warning: auth.warning } : {}) });
};
