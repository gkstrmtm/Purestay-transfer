const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { roleMatchesAny } = require('../../lib/portalRoleAliases');
const { tableExists, upsertEventAttendanceRecord, upsertEventClosureRecord } = require('../../lib/portalFoundation');

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
  if (error) return { ok: false, allowed: false };
  const event = Array.isArray(data) ? data[0] : null;
  if (!event) return { ok: false, allowed: false, error: 'event_not_found' };
  const role = String(profile?.role || '');
  const allowed = (
    (event.assigned_user_id && event.assigned_user_id === userId) ||
    (event.created_by && event.created_by === userId) ||
    (role && event.assigned_role && roleMatchesAny(event.assigned_role, role)) ||
    (role === 'event_host' && event.assigned_role === 'media_team') ||
    (role === 'media_team' && event.assigned_role === 'event_host')
  );
  return { ok: true, allowed, event };
}

function normalizePayload(body) {
  return {
    attendanceEstimate: clampInt(body.attendanceEstimate, 0, 100000, null),
    noShowCount: clampInt(body.noShowCount, 0, 100000, null),
    clientSentiment: cleanStr(body.clientSentiment, 40),
    residentSentiment: cleanStr(body.residentSentiment, 40),
    staffingCoverage: cleanStr(body.staffingCoverage, 40),
    wins: cleanStr(body.wins, 4000),
    issues: cleanStr(body.issues, 4000),
    nextSteps: cleanStr(body.nextSteps, 4000),
    followUpOwner: cleanStr(body.followUpOwner, 120),
    notes: cleanStr(body.notes, 6000),
  };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const exists = await tableExists(s.sbAdmin, 'portal_event_logs');
  if (!exists) return sendJson(res, 200, { ok: true, ready: false, logs: [] });

  const url = new URL(req.url || '/api/portal/event_logs', 'http://localhost');

  if (req.method === 'GET') {
    const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const visible = await canSeeEvent(s.sbAdmin, { profile: s.profile, userId: s.actorUserId, eventId });
    if (!visible.ok && visible.error === 'event_not_found') return sendJson(res, 404, { ok: false, error: visible.error });
    if (!visible.allowed) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const { data, error } = await s.sbAdmin
      .from('portal_event_logs')
      .select('*')
      .eq('event_id', eventId)
      .order('id', { ascending: false })
      .limit(20);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_logs_query_failed' });
    return sendJson(res, 200, { ok: true, ready: true, logs: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_host', 'media_team', 'event_coordinator', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.eventId, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const visible = await canSeeEvent(s.sbAdmin, { profile: s.profile, userId: s.actorUserId, eventId });
    if (!visible.ok && visible.error === 'event_not_found') return sendJson(res, 404, { ok: false, error: visible.error });
    if (!visible.allowed) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const payload = normalizePayload(body.payload && typeof body.payload === 'object' ? body.payload : body);
    const summary = cleanStr(body.summary || payload.notes || payload.wins || payload.issues, 4000);
    const ownerUserId = cleanStr(body.ownerUserId || visible.event?.assigned_user_id || visible.event?.created_by || s.actorUserId, 80) || null;

    const row = {
      event_id: eventId,
      created_by: s.actorUserId,
      owner_user_id: ownerUserId,
      log_type: 'internal',
      status: 'submitted',
      summary: summary || null,
      payload,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await s.sbAdmin
      .from('portal_event_logs')
      .insert(row)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_log_insert_failed' });

    await Promise.all([
      upsertEventAttendanceRecord(s.sbAdmin, {
        eventId,
        attendanceSource: 'internal_log',
        estimatedCount: payload.attendanceEstimate,
        noShowCount: payload.noShowCount,
        capturedBy: s.actorUserId,
        notes: summary || payload.notes,
        meta: {
          source: 'api/portal/event_logs',
          clientSentiment: payload.clientSentiment || null,
          residentSentiment: payload.residentSentiment || null,
        },
      }).catch(() => null),
      upsertEventClosureRecord(s.sbAdmin, {
        eventId,
        closureStatus: visible.event?.status === 'cancelled' ? 'blocked' : 'in_review',
        staffingComplete: ['staffed', 'ready', 'completed', 'closed'].includes(String(visible.event?.execution_status || '').toLowerCase()),
        formsComplete: false,
        assetsReturned: false,
        vendorItemsClosed: false,
        reportComplete: true,
        payoutReviewComplete: false,
        notes: summary || payload.notes,
        meta: {
          source: 'api/portal/event_logs',
          wins: payload.wins || null,
          issues: payload.issues || null,
          nextSteps: payload.nextSteps || null,
        },
      }).catch(() => null),
    ]);

    return sendJson(res, 200, { ok: true, ready: true, log: Array.isArray(data) ? data[0] : null });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
