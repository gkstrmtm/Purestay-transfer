const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { getState, listPosts } = require('../../lib/blogs');
const { hasKvEnv } = require('../../lib/storage');
const { listScheduled, intervalDays, yearsBack } = require('../../lib/blogSchedule');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  // Optional protection (same pattern as settings)
  const adminToken = process.env.ADMIN_TOKEN || '';
  const isProtected = Boolean(adminToken);
  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  if (isProtected && token !== adminToken) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  if (hasKvEnv()) {
    const state = await getState();
    const listing = await listPosts({ limit: 1, offset: 0 });
    return sendJson(res, 200, {
      ok: true,
      mode: 'kv',
      state,
      latest: listing.posts?.[0] || null,
      total: listing.total || 0,
    });
  }

  const listing = listScheduled({ limit: 1, offset: 0 });
  return sendJson(res, 200, {
    ok: true,
    mode: 'scheduled',
    schedule: { stepDays: intervalDays(), years: yearsBack(), start: listing.schedule?.start || '' },
    latest: listing.posts?.[0] || null,
    total: listing.total || 0,
  });
};
