const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

async function canSeeEvent(sbAdmin, { profile, userId, eventId }) {
  if (isManager(profile)) return true;
  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('id, created_by, assigned_role, assigned_user_id')
    .eq('id', eventId)
    .limit(1);
  if (error) return false;
  const event = Array.isArray(data) ? data[0] : null;
  if (!event) return false;
  const role = String(profile?.role || '');
  return (
    (event.assigned_user_id && event.assigned_user_id === userId) ||
    (event.created_by && event.created_by === userId) ||
    (role && event.assigned_role && roleMatchesAny(event.assigned_role, role)) ||
    (role === 'event_host' && event.assigned_role === 'media_team') ||
    (role === 'media_team' && event.assigned_role === 'event_host')
  );
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/event_recaps', 'http://localhost');

  if (req.method === 'GET') {
    const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const okEvent = await canSeeEvent(s.sbAdmin, { profile: s.profile, userId: s.user.id, eventId });
    if (!okEvent) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const { data, error } = await s.sbAdmin
      .from('portal_event_recaps')
      .select('*')
      .eq('event_id', eventId)
      .order('id', { ascending: false })
      .limit(50);

    if (error) return sendJson(res, 500, { ok: false, error: 'recaps_query_failed' });
    return sendJson(res, 200, { ok: true, recaps: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_host', 'media_team', 'event_coordinator'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.eventId, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const okEvent = await canSeeEvent(s.sbAdmin, { profile: s.profile, userId: s.user.id, eventId });
    if (!okEvent) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const mediaUrls = Array.isArray(body.mediaUrls)
      ? body.mediaUrls.map((u) => cleanStr(u, 2000)).filter(Boolean).slice(0, 30)
      : [];

    const recap = {
      event_id: eventId,
      created_by: s.user.id,
      recap: cleanStr(body.recap, 10_000),
      media_urls: mediaUrls,
      payload: (body.payload && typeof body.payload === 'object') ? body.payload : {},
    };

    const { data, error } = await s.sbAdmin
      .from('portal_event_recaps')
      .insert(recap)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'recap_insert_failed' });
    return sendJson(res, 200, { ok: true, recap: Array.isArray(data) ? data[0] : null });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
