const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { roleMatchesAny } = require('../../lib/portalRoleAliases');
const { tableExists } = require('../../lib/portalFoundation');

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

function assignmentRowToLegacy(row) {
  const status = normalizeStatus(row?.status);
  return {
    role: normalizeRole(row?.role),
    userId: cleanStr(row?.user_id, 80),
    status,
    note: cleanStr(row?.notes, 500),
    updatedAt: cleanStr(row?.updated_at || row?.created_at || new Date().toISOString(), 40),
    decidedAt: cleanStr(row?.responded_at || row?.confirmed_at || row?.removed_at || '', 40) || null,
  };
}

async function staffingTablesReady(sbAdmin) {
  const [hasRequirements, hasAssignments] = await Promise.all([
    tableExists(sbAdmin, 'portal_event_staff_requirements'),
    tableExists(sbAdmin, 'portal_event_staff_assignments'),
  ]);
  return hasRequirements && hasAssignments;
}

async function loadEventMetaAssignments(sbAdmin, eventId) {
  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('id, meta')
    .eq('id', eventId)
    .limit(1);
  if (error) throw new Error('event_lookup_failed');
  const row = Array.isArray(data) ? data[0] : null;
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  return normalizeAssignments(meta.assignments);
}

async function loadNormalizedAssignments(sbAdmin, eventId) {
  const { data, error } = await sbAdmin
    .from('portal_event_staff_assignments')
    .select('event_id, requirement_id, user_id, role, status, notes, created_at, updated_at, responded_at, confirmed_at, removed_at')
    .eq('event_id', eventId)
    .order('created_at', { ascending: true });
  if (error) throw new Error('assignment_lookup_failed');
  return (Array.isArray(data) ? data : []).map(assignmentRowToLegacy).filter((item) => item.role && item.userId);
}

async function loadAssignmentsWithSource(sbAdmin, eventId) {
  const ready = await staffingTablesReady(sbAdmin);
  if (!ready) {
    return { source: 'legacy', assignments: await loadEventMetaAssignments(sbAdmin, eventId) };
  }
  const normalized = await loadNormalizedAssignments(sbAdmin, eventId);
  if (normalized.length) return { source: 'normalized', assignments: normalized };
  return { source: 'legacy', assignments: await loadEventMetaAssignments(sbAdmin, eventId) };
}

async function ensureRequirementsForRoles(sbAdmin, eventId, roles) {
  const uniqueRoles = Array.from(new Set((Array.isArray(roles) ? roles : []).map((role) => normalizeRole(role)).filter(Boolean)));
  for (const role of uniqueRoles) {
    await sbAdmin
      .from('portal_event_staff_requirements')
      .upsert({
        event_id: eventId,
        role,
        required_count: 1,
        filled_count: 0,
        status: 'open',
      }, { onConflict: 'event_id,role' });
  }
}

async function syncRequirementRollups(sbAdmin, eventId, assignments, extraRoles = []) {
  const roles = Array.from(new Set([
    ...(Array.isArray(assignments) ? assignments.map((item) => item?.role) : []),
    ...(Array.isArray(extraRoles) ? extraRoles : []),
  ].map((role) => normalizeRole(role)).filter(Boolean)));
  await ensureRequirementsForRoles(sbAdmin, eventId, roles);

  const { data, error } = await sbAdmin
    .from('portal_event_staff_requirements')
    .select('id, role, required_count, status')
    .eq('event_id', eventId);
  if (error) throw new Error('requirement_lookup_failed');

  for (const row of Array.isArray(data) ? data : []) {
    const role = normalizeRole(row?.role);
    if (!role) continue;
    const filledCount = (Array.isArray(assignments) ? assignments : []).filter((item) => String(item?.role || '') === role && ['accepted', 'confirmed'].includes(String(item?.status || ''))).length;
    const nextStatus = String(row?.status || '') === 'cancelled'
      ? 'cancelled'
      : (filledCount >= Math.max(1, Number(row?.required_count || 1)) ? 'filled' : 'open');
    await sbAdmin
      .from('portal_event_staff_requirements')
      .update({
        filled_count: filledCount,
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
  }
}

async function replaceNormalizedAssignments(sbAdmin, eventId, assignments) {
  const nextAssignments = normalizeAssignments(assignments);
  await ensureRequirementsForRoles(sbAdmin, eventId, nextAssignments.map((item) => item.role));

  const { data: requirements, error: requirementError } = await sbAdmin
    .from('portal_event_staff_requirements')
    .select('id, role')
    .eq('event_id', eventId);
  if (requirementError) throw new Error('requirement_lookup_failed');
  const requirementByRole = new Map((Array.isArray(requirements) ? requirements : []).map((row) => [String(row.role || ''), row.id]));

  const { error: deleteError } = await sbAdmin
    .from('portal_event_staff_assignments')
    .delete()
    .eq('event_id', eventId);
  if (deleteError) throw new Error('assignment_replace_failed');

  if (nextAssignments.length) {
    const now = new Date().toISOString();
    const rows = nextAssignments.map((item) => ({
      event_id: eventId,
      requirement_id: requirementByRole.get(String(item.role || '')) || null,
      user_id: item.userId,
      role: item.role,
      status: item.status,
      assigned_by: null,
      notes: item.note || '',
      responded_at: item.status === 'accepted' || item.status === 'declined' ? (item.decidedAt || now) : null,
      confirmed_at: item.status === 'confirmed' ? (item.decidedAt || now) : null,
      removed_at: item.status === 'removed' ? (item.decidedAt || now) : null,
      meta: {},
    }));
    const { error: insertError } = await sbAdmin.from('portal_event_staff_assignments').insert(rows);
    if (insertError) throw new Error('assignment_insert_failed');
  }

  await syncRequirementRollups(sbAdmin, eventId, nextAssignments);
  return nextAssignments;
}

async function writeLegacyAssignmentMirror(sbAdmin, eventId, assignments, patch = {}) {
  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('id, meta')
    .eq('id', eventId)
    .limit(1);
  if (error) throw new Error('event_lookup_failed');
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('event_not_found');
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  const nextMeta = Object.assign({}, meta, { assignments: normalizeAssignments(assignments) });
  const update = Object.assign({ meta: nextMeta }, patch || {});
  const { error: updateError } = await sbAdmin
    .from('portal_events')
    .update(update)
    .eq('id', eventId);
  if (updateError) throw new Error('event_update_failed');
}

async function persistAssignments(sbAdmin, eventId, assignments, patch = {}) {
  const ready = await staffingTablesReady(sbAdmin);
  const nextAssignments = normalizeAssignments(assignments);
  if (ready) {
    await replaceNormalizedAssignments(sbAdmin, eventId, nextAssignments);
  }
  await writeLegacyAssignmentMirror(sbAdmin, eventId, nextAssignments, patch);
  return nextAssignments;
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

    try {
      const current = await loadAssignmentsWithSource(s.sbAdmin, eventId);
      return sendJson(res, 200, { ok: true, eventId, assignments: current.assignments, source: current.source });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) || 'assignment_lookup_failed' });
    }
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

    try {
      const nextAssignments = await persistAssignments(s.sbAdmin, eventId, body.assignments);
      return sendJson(res, 200, { ok: true, eventId, assignments: nextAssignments });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) || 'event_update_failed' });
    }
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

    let current;
    try {
      current = await loadAssignmentsWithSource(s.sbAdmin, eventId);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err.message || err) || 'assignment_lookup_failed' });
    }
    const assignments = normalizeAssignments(current.assignments);

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

      const patch = {};

      // If any assignee accepted, move event to assigned.
      if (String(row.status || '') === 'open' && decision === 'accepted') {
        patch.status = 'assigned';
      }
      try {
        const persisted = await persistAssignments(s.sbAdmin, eventId, next, patch);
        return sendJson(res, 200, { ok: true, eventId, status: patch.status || row.status, assignments: persisted });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err.message || err) || 'event_update_failed' });
      }
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
      try {
        const persisted = await persistAssignments(s.sbAdmin, eventId, next);
        return sendJson(res, 200, { ok: true, eventId, assignments: persisted });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err.message || err) || 'event_update_failed' });
      }
    }

    if (action === 'remove') {
      if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }

      const role = normalizeRole(body.role);
      const userId = cleanStr(body.userId, 80);
      if (!role || !userId) return sendJson(res, 422, { ok: false, error: 'missing_role_or_user' });

      const next = assignments.filter((a) => !(String(a?.userId || '') === userId && String(a?.role || '') === role));
      try {
        const persisted = await persistAssignments(s.sbAdmin, eventId, next);
        return sendJson(res, 200, { ok: true, eventId, assignments: persisted });
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: String(err.message || err) || 'event_update_failed' });
      }
    }

    return sendJson(res, 422, { ok: false, error: 'unknown_action' });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
