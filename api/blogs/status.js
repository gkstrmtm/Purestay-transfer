const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { getState, listPosts } = require('../../lib/blogs');
const { hasKvEnv, hasSupabaseEnv, hasStorageEnv } = require('../../lib/storage');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  // Optional protection (same pattern as settings)
  const adminToken = process.env.ADMIN_TOKEN || '';
  const isProtected = Boolean(adminToken);
  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  if (isProtected && token !== adminToken) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  if (hasStorageEnv()) {
    const state = await getState();
    const listing = await listPosts({ limit: 1, offset: 0 });
    return sendJson(res, 200, {
      ok: true,
      mode: hasSupabaseEnv() ? 'supabase' : (hasKvEnv() ? 'kv' : 'unknown'),
      state,
      latest: listing.posts?.[0] || null,
      total: listing.total || 0,
    });
  }

  return sendJson(res, 200, {
    ok: true,
    mode: 'disabled',
    reason: 'storage_required',
    latest: null,
    total: 0,
  });
};
