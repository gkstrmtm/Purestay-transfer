const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/payouts', 'http://localhost');
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);
  const requestedUserId = String(url.searchParams.get('userId') || '').trim();

  let query = s.sbAdmin
    .from('portal_payouts')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit);

  if (isManager(s.profile)) {
    if (requestedUserId) query = query.eq('user_id', requestedUserId);
  } else {
    if (s.viewAsRole && !s.effectiveUserId) {
      return sendJson(res, 200, { ok: true, payouts: [] });
    }
    const uid = String(s.effectiveUserId || s.user.id || '').trim();
    query = query.eq('user_id', uid);
  }

  const { data, error } = await query;
  if (error) return sendJson(res, 500, { ok: false, error: 'payouts_query_failed' });
  return sendJson(res, 200, { ok: true, payouts: Array.isArray(data) ? data : [] });
};
