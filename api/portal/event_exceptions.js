const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { upsertOperationsException } = require('../../lib/portalFoundation');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const url = new URL(req.url || '/api/portal/event_exceptions', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);

  if (req.method === 'GET') {
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });
    const { data, error } = await s.sbAdmin
      .from('portal_operations_exceptions')
      .select('*')
      .eq('event_id', eventId)
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) return sendJson(res, 500, { ok: false, error: 'exceptions_lookup_failed' });
    return sendJson(res, 200, { ok: true, eventId, exceptions: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const bodyEventId = clampInt(body.eventId, 1, 1e12, null);
    const exceptionId = clampInt(body.id, 1, 1e12, null);
    if (!bodyEventId && !exceptionId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const action = cleanStr(body.action, 20).toLowerCase() || 'upsert';
    const targetStatus = action === 'resolve'
      ? 'resolved'
      : (cleanStr(body.status, 40) || 'open');
    const targetResolvedAt = action === 'resolve'
      ? (cleanStr(body.resolvedAt, 80) || new Date().toISOString())
      : cleanStr(body.resolvedAt, 80);

    const result = await upsertOperationsException(s.sbAdmin, {
      id: exceptionId,
      eventId: bodyEventId,
      entityType: cleanStr(body.entityType, 80) || 'event',
      entityId: cleanStr(body.entityId, 160) || (bodyEventId ? String(bodyEventId) : ''),
      exceptionType: cleanStr(body.exceptionType, 80),
      severity: cleanStr(body.severity, 40) || 'medium',
      ownerUserId: cleanStr(body.ownerUserId, 80),
      status: targetStatus,
      openedAt: cleanStr(body.openedAt, 80),
      resolvedAt: targetResolvedAt,
      resolutionNotes: cleanStr(body.resolutionNotes, 4000),
      meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
    });
    if (!result.ok) {
      const status = result.error === 'exception_not_found' ? 404 : 500;
      return sendJson(res, status, { ok: false, error: result.error, detail: result.detail || '' });
    }

    const lookupEventId = bodyEventId || Number(result.exception?.event_id || 0) || null;
    let exceptions = [];
    if (lookupEventId) {
      const { data } = await s.sbAdmin
        .from('portal_operations_exceptions')
        .select('*')
        .eq('event_id', lookupEventId)
        .order('updated_at', { ascending: false })
        .limit(50);
      exceptions = Array.isArray(data) ? data : [];
    }

    return sendJson(res, 200, {
      ok: true,
      eventId: lookupEventId,
      exception: result.exception || null,
      exceptions,
    });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};