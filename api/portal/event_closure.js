const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole } = require('../../lib/portalAuth');
const { upsertEventClosureRecord } = require('../../lib/portalFoundation');

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

  const url = new URL(req.url || '/api/portal/event_closure', 'http://localhost');
  const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);

  if (req.method === 'GET') {
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });
    const { data, error } = await s.sbAdmin
      .from('portal_event_closure_records')
      .select('*')
      .eq('event_id', eventId)
      .limit(1);
    if (error) return sendJson(res, 500, { ok: false, error: 'closure_lookup_failed' });
    return sendJson(res, 200, { ok: true, eventId, closure: Array.isArray(data) ? data[0] || null : null });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const bodyEventId = clampInt(body.eventId, 1, 1e12, null);
    if (!bodyEventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const approvedNow = ['approved', 'closed'].includes(cleanStr(body.closureStatus, 40).toLowerCase());
    const closureResult = await upsertEventClosureRecord(s.sbAdmin, {
      eventId: bodyEventId,
      closureStatus: cleanStr(body.closureStatus, 40) || 'in_review',
      staffingComplete: !!body.staffingComplete,
      formsComplete: !!body.formsComplete,
      assetsReturned: !!body.assetsReturned,
      vendorItemsClosed: !!body.vendorItemsClosed,
      reportComplete: !!body.reportComplete,
      payoutReviewComplete: !!body.payoutReviewComplete,
      approvedBy: approvedNow ? (cleanStr(body.approvedBy, 80) || s.actorUserId) : cleanStr(body.approvedBy, 80),
      approvedAt: approvedNow ? (cleanStr(body.approvedAt, 80) || new Date().toISOString()) : cleanStr(body.approvedAt, 80),
      notes: cleanStr(body.notes, 4000),
      meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
    });
    if (!closureResult.ok) return sendJson(res, 500, { ok: false, error: closureResult.error, detail: closureResult.detail || '' });

    const eventPatch = {};
    if (body.closureStatus != null) {
      const normalized = cleanStr(body.closureStatus, 40).toLowerCase();
      if (['approved', 'closed'].includes(normalized)) eventPatch.completion_state = 'closed';
      else if (normalized === 'blocked') eventPatch.completion_state = 'in_progress';
    }
    if (body.reportComplete === true) eventPatch.report_status = 'submitted';

    let event = null;
    if (Object.keys(eventPatch).length) {
      const { data, error } = await s.sbAdmin
        .from('portal_events')
        .update(eventPatch)
        .eq('id', bodyEventId)
        .select('*')
        .limit(1);
      if (!error) event = Array.isArray(data) ? data[0] || null : null;
    }

    return sendJson(res, 200, { ok: true, eventId: bodyEventId, closure: closureResult.closureRecord || null, event });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};