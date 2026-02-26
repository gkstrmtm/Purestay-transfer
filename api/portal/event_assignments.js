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

function normalizeRole(role) {
  const r = cleanStr(role, 40);
  if (!r) return '';
  const allowed = new Set(['event_host', 'media_team', 'event_coordinator']);
  return allowed.has(r) ? r : '';
}

function normalizeStatus(status) {
  const s = cleanStr(status, 20);
  const allowed = new Set(['pending', 'accepted', 'declined', 'removed']);
  return allowed.has(s) ? s : 'pending';
}

function normalizeAssignments(input) {
  const arr = Array.isArray(input) ? input : [];
  const out = [];
  const seenUser = new Set();

  for (const a of arr) {
    const role = normalizeRole(a?.role);
    const userId = cleanStr(a?.userId, 80);
    if (!role || !userId) continue;

    // Enforce: no one can hold multiple roles for an event.
    const key = userId;
    if (seenUser.has(key)) continue;
    seenUser.add(key);

    out.push({
      role,
      userId,
      status: normalizeStatus(a?.status),
      note: cleanStr(a?.note, 500),
      updatedAt: a?.updatedAt ? cleanStr(a.updatedAt, 40) : new Date().toISOString(),
      decidedAt: a?.decidedAt ? cleanStr(a.decidedAt, 40) : null,
    });
  }

  return out;
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
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/event_assignments', 'http://localhost');

  if (req.method === 'GET') {
    const eventId = clampInt(url.searchParams.get('eventId'), 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const okEvent = await canSeeEvent(s.sbAdmin, { profile: s.profile, userId: s.actorUserId, eventId });
    if (!okEvent) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .select('id, meta')
      .eq('id', eventId)
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const row = Array.isArray(data) ? data[0] : null;
    const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
    const assignments = Array.isArray(meta.assignments) ? meta.assignments : [];
    return sendJson(res, 200, { ok: true, eventId, assignments });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.eventId, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('id, meta')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const nextAssignments = normalizeAssignments(body.assignments);

    const nextMeta = Object.assign({}, meta, { assignments: nextAssignments });

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .update({ meta: nextMeta })
      .eq('id', eventId)
      .select('id, meta')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_update_failed' });
    const updated = Array.isArray(data) ? data[0] : null;
    const updatedMeta = updated?.meta && typeof updated.meta === 'object' ? updated.meta : {};
    return sendJson(res, 200, { ok: true, eventId, assignments: updatedMeta.assignments || [] });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.eventId, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const action = cleanStr(body.action, 30);
    if (!action) return sendJson(res, 422, { ok: false, error: 'missing_action' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('id, meta, status')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    const assignments = Array.isArray(meta.assignments) ? meta.assignments : [];

    if (action === 'respond') {
      const role = normalizeRole(body.role);
      const decision = cleanStr(body.decision, 20);
      if (!role) return sendJson(res, 422, { ok: false, error: 'invalid_role' });
      if (!['accepted', 'declined'].includes(decision)) return sendJson(res, 422, { ok: false, error: 'invalid_decision' });

      const uid = String(s.actorUserId || '');
      const idx = assignments.findIndex((a) => String(a?.userId || '') === uid && String(a?.role || '') === role);
      if (idx < 0) return sendJson(res, 403, { ok: false, error: 'not_assigned' });

      const next = assignments.slice();
      const prev = next[idx] && typeof next[idx] === 'object' ? next[idx] : {};
      next[idx] = Object.assign({}, prev, {
        status: decision,
        decidedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const nextMeta = Object.assign({}, meta, { assignments: next });
      const patch = { meta: nextMeta };

      // If any assignee accepted, move event to assigned.
      if (String(row.status || '') === 'open' && decision === 'accepted') {
        patch.status = 'assigned';
      }

      const { data, error } = await s.sbAdmin
        .from('portal_events')
        .update(patch)
        .eq('id', eventId)
        .select('id, meta, status')
        .limit(1);

      if (error) return sendJson(res, 500, { ok: false, error: 'event_update_failed' });
      const updated = Array.isArray(data) ? data[0] : null;
      const updatedMeta = updated?.meta && typeof updated.meta === 'object' ? updated.meta : {};
      return sendJson(res, 200, { ok: true, eventId, status: updated?.status || row.status, assignments: updatedMeta.assignments || [] });
    }

    if (action === 'add') {
      if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }

      const role = normalizeRole(body.role);
      const userId = cleanStr(body.userId, 80);
      if (!role || !userId) return sendJson(res, 422, { ok: false, error: 'missing_role_or_user' });

      // Enforce: no multi-role per person.
      if (assignments.some((a) => String(a?.userId || '') === userId)) {
        return sendJson(res, 409, { ok: false, error: 'user_already_assigned' });
      }

      const next = assignments.concat([{ role, userId, status: 'pending', note: '', updatedAt: new Date().toISOString(), decidedAt: null }]);
      const nextMeta = Object.assign({}, meta, { assignments: next });

      const { data, error } = await s.sbAdmin
        .from('portal_events')
        .update({ meta: nextMeta })
        .eq('id', eventId)
        .select('id, meta')
        .limit(1);

      if (error) return sendJson(res, 500, { ok: false, error: 'event_update_failed' });
      const updated = Array.isArray(data) ? data[0] : null;
      const updatedMeta = updated?.meta && typeof updated.meta === 'object' ? updated.meta : {};
      return sendJson(res, 200, { ok: true, eventId, assignments: updatedMeta.assignments || [] });
    }

    if (action === 'remove') {
      if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }

      const role = normalizeRole(body.role);
      const userId = cleanStr(body.userId, 80);
      if (!role || !userId) return sendJson(res, 422, { ok: false, error: 'missing_role_or_user' });

      const next = assignments.filter((a) => !(String(a?.userId || '') === userId && String(a?.role || '') === role));
      const nextMeta = Object.assign({}, meta, { assignments: next });

      const { data, error } = await s.sbAdmin
        .from('portal_events')
        .update({ meta: nextMeta })
        .eq('id', eventId)
        .select('id, meta')
        .limit(1);

      if (error) return sendJson(res, 500, { ok: false, error: 'event_update_failed' });
      const updated = Array.isArray(data) ? data[0] : null;
      const updatedMeta = updated?.meta && typeof updated.meta === 'object' ? updated.meta : {};
      return sendJson(res, 200, { ok: true, eventId, assignments: updatedMeta.assignments || [] });
    }

    return sendJson(res, 422, { ok: false, error: 'unknown_action' });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
