const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { hasStorageEnv } = require('../../lib/storage');
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

  if (!hasStorageEnv()) {
    return sendJson(res, 400, { ok: false, error: 'storage_required', hint: 'Configure Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or Vercel KV to delete persisted posts.' });
  }

  const r = await deleteAllPosts();
  return sendJson(res, 200, { ok: true, deleted: r.deleted || 0, ...(auth.warning ? { warning: auth.warning } : {}) });
};
