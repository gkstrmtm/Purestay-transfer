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

function statusesForKind(kind) {
  if (kind === 'dialer') return ['new', 'working', 'booked'];
  if (kind === 'closer') return ['working', 'booked'];
  return ['new', 'working', 'booked'];
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/queue', 'http://localhost');
  const kind = cleanStr(url.searchParams.get('kind'), 20) || 'dialer';
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 40);

  const statuses = statusesForKind(kind);

  let query = s.sbAdmin
    .from('portal_leads')
    .select('*')
    .in('status', statuses)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (!isManager(s.profile)) {
    const role = String(s.profile.role || '');
    const uid = String(s.effectiveUserId || s.user.id || '');

    // Manager view-as mode: show the role inbox (unassigned) instead of manager-owned data.
    if (s.viewAsRole && role && !s.effectiveUserId) {
      query = query.eq('assigned_role', role).is('assigned_user_id', null);
    } else {
      const parts = [
        `assigned_user_id.eq.${uid}`,
        `created_by.eq.${uid}`,
      ];
      if (role) parts.push(`assigned_role.eq.${role}`);
      query = query.or(parts.join(','));
    }
  }

  const { data, error } = await query;
  if (error) return sendJson(res, 500, { ok: false, error: 'queue_query_failed' });

  return sendJson(res, 200, {
    ok: true,
    kind,
    leads: Array.isArray(data) ? data : [],
  });
};
