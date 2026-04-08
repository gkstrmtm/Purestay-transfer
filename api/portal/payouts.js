const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function ymdToIsoStart(ymd) {
  const s = cleanStr(ymd, 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return `${s}T00:00:00.000Z`;
}

function isoOrYmdToIso(s, { endOfDay = false } = {}) {
  const v = cleanStr(s, 64);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return endOfDay ? `${v}T23:59:59.999Z` : `${v}T00:00:00.000Z`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/payouts', 'http://localhost');
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);
  const requestedUserId = String(url.searchParams.get('userId') || '').trim();
  const since = isoOrYmdToIso(url.searchParams.get('since'), { endOfDay: false });
  const until = isoOrYmdToIso(url.searchParams.get('until'), { endOfDay: true });

  let query = s.sbAdmin
    .from('portal_payouts')
    .select('*')
    .order('id', { ascending: false })
    .limit(limit);

  if (since) query = query.gte('created_at', since);
  if (until) query = query.lte('created_at', until);

  const manager = isManager(s.profile);
  const viewAs = !!s.viewAsRole;

  // In manager view-as mode, default to the impersonated user.
  if (manager && viewAs) {
    const uid = String(s.effectiveUserId || '').trim();
    if (requestedUserId) query = query.eq('user_id', requestedUserId);
    else if (uid) query = query.eq('user_id', uid);
  } else if (manager) {
    if (requestedUserId) query = query.eq('user_id', requestedUserId);
  } else {
    const uid = String(s.effectiveUserId || s.user.id || '').trim();
    query = query.eq('user_id', uid);
  }

  const { data, error } = await query;
  if (error) return sendJson(res, 500, { ok: false, error: 'payouts_query_failed' });
  return sendJson(res, 200, { ok: true, payouts: Array.isArray(data) ? data : [] });
};
