const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { applyRoleFilter, buildRoleOrParts, roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function canSeeEvent({ profile, userId, event }) {
  if (isManager(profile)) return true;
  const role = String(profile?.role || '');
  return (
    (event.assigned_user_id && event.assigned_user_id === userId) ||
    (event.created_by && event.created_by === userId) ||
    (role && event.assigned_role && roleMatchesAny(event.assigned_role, role)) ||
    // Allow Events + Media to collaborate on the same event records.
    (role === 'event_host' && event.assigned_role === 'media_team') ||
    (role === 'media_team' && event.assigned_role === 'event_host')
  );
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/events', 'http://localhost');

  if (req.method === 'GET') {
    const status = cleanStr(url.searchParams.get('status'), 40);
    const assignedRole = cleanStr(url.searchParams.get('assignedRole'), 40);
    const areaTag = cleanStr(url.searchParams.get('areaTag'), 80);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 100);

    let query = s.sbAdmin
      .from('portal_events')
      .select('*')
      .order('event_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (assignedRole) query = applyRoleFilter(query, 'assigned_role', assignedRole);
    if (areaTag) query = query.eq('area_tag', areaTag);

    if (!isManager(s.profile)) {
      const role = String(s.profile.role || '');
      const uid = String(s.effectiveUserId || s.user.id || '');

      if (s.viewAsRole && role && !s.effectiveUserId) {
        if (role === 'event_host') query = query.in('assigned_role', ['event_host', 'media_team']);
        else if (role === 'media_team') query = query.in('assigned_role', ['media_team', 'event_host']);
        else query = applyRoleFilter(query, 'assigned_role', role);
      } else {
        const parts = [
          `assigned_user_id.eq.${uid}`,
          `created_by.eq.${uid}`,
        ];
        if (role) {
          parts.push(...buildRoleOrParts('assigned_role', role));
          // Coordinators need operational visibility across staffing roles.
          if (role === 'event_coordinator') {
            parts.push(...buildRoleOrParts('assigned_role', 'event_host'));
            parts.push(...buildRoleOrParts('assigned_role', 'media_team'));
          }
          if (role === 'event_host') parts.push(...buildRoleOrParts('assigned_role', 'media_team'));
          if (role === 'media_team') parts.push(...buildRoleOrParts('assigned_role', 'event_host'));
        }
        query = query.or(parts.join(','));
      }
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'events_query_failed' });
    return sendJson(res, 200, { ok: true, events: Array.isArray(data) ? data : [] });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const event = {
      created_by: s.actorUserId,
      status: cleanStr(body.status || 'open', 40),
      title: cleanStr(body.title, 200),
      event_date: cleanStr(body.eventDate, 20) || null,
      start_time: cleanStr(body.startTime, 20),
      end_time: cleanStr(body.endTime, 20),
      address: cleanStr(body.address, 200),
      city: cleanStr(body.city, 120),
      state: cleanStr(body.state, 20),
      postal_code: cleanStr(body.postalCode, 20),
      area_tag: cleanStr(body.areaTag, 80),
      assigned_role: cleanStr(body.assignedRole, 40),
      assigned_user_id: cleanStr(body.assignedUserId, 60) || null,
      payout_cents: clampInt(body.payoutCents, 0, 1e9, 0),
      notes: cleanStr(body.notes, 5000),
      meta: (body.meta && typeof body.meta === 'object') ? body.meta : {},
    };

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .insert(event)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_insert_failed' });
    return sendJson(res, 200, { ok: true, event: Array.isArray(data) ? data[0] : null });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.id, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_event_id' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('*')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'event_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'event_not_found' });

    const canEdit = isManager(s.profile)
      || hasRole(s.profile, ['event_coordinator'])
      || (row.assigned_user_id && row.assigned_user_id === s.actorUserId)
      || (row.created_by && row.created_by === s.actorUserId);

    const requestedAssignedUserId = body.assignedUserId != null ? (cleanStr(body.assignedUserId, 60) || null) : undefined;
    const wantsSelfAssign = requestedAssignedUserId && requestedAssignedUserId === s.actorUserId;
    const role = String(s.profile?.role || '');
    const canClaim = !canEdit
      && wantsSelfAssign
      && !row.assigned_user_id
      && row.assigned_role
      && role
      && roleMatchesAny(row.assigned_role, role)
      && String(row.status || 'open') === 'open';

    if (!canEdit && !canClaim) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const patch = {
      status: body.status != null ? cleanStr(body.status, 40) : undefined,
      title: body.title != null ? cleanStr(body.title, 200) : undefined,
      event_date: body.eventDate != null ? (cleanStr(body.eventDate, 20) || null) : undefined,
      start_time: body.startTime != null ? cleanStr(body.startTime, 20) : undefined,
      end_time: body.endTime != null ? cleanStr(body.endTime, 20) : undefined,
      address: body.address != null ? cleanStr(body.address, 200) : undefined,
      city: body.city != null ? cleanStr(body.city, 120) : undefined,
      state: body.state != null ? cleanStr(body.state, 20) : undefined,
      postal_code: body.postalCode != null ? cleanStr(body.postalCode, 20) : undefined,
      area_tag: body.areaTag != null ? cleanStr(body.areaTag, 80) : undefined,
      assigned_role: body.assignedRole != null ? cleanStr(body.assignedRole, 40) : undefined,
      assigned_user_id: body.assignedUserId != null ? (cleanStr(body.assignedUserId, 60) || null) : undefined,
      payout_cents: body.payoutCents != null ? clampInt(body.payoutCents, 0, 1e9, row.payout_cents || 0) : undefined,
      notes: body.notes != null ? cleanStr(body.notes, 5000) : undefined,
      meta: body.meta != null ? ((body.meta && typeof body.meta === 'object') ? body.meta : {}) : undefined,
    };

    if (patch.meta) {
      const budget = patch.meta?.budget && typeof patch.meta.budget === 'object' ? patch.meta.budget : null;
      if (budget) {
        const hostPayCents = Number(budget.hostPayCents || 0);
        const mediaPayCents = Number(budget.mediaPayCents || 0);
        if (Number.isFinite(hostPayCents) && Number.isFinite(mediaPayCents) && mediaPayCents > 0) {
          const minHost = Math.ceil(mediaPayCents * 0.75);
          if (hostPayCents < minHost) {
            return sendJson(res, 422, { ok: false, error: 'budget_constraint_failed', minHostPayCents: minHost });
          }
        }
      }
    }

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    if (canClaim) {
      // Claimers can only self-assign and move status to assigned.
      const allowed = {
        assigned_user_id: patch.assigned_user_id,
        status: patch.status || 'assigned',
      };
      for (const k of Object.keys(patch)) delete patch[k];
      patch.assigned_user_id = allowed.assigned_user_id;
      patch.status = allowed.status;
    }

    if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, event: row });

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .update(patch)
      .eq('id', eventId)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'event_update_failed' });
    const updated = Array.isArray(data) ? data[0] : null;
    if (updated && !canSeeEvent({ profile: s.profile, userId: s.actorUserId, event: updated })) {
      // If they edited it into a state they can no longer view (rare), just return ok.
      return sendJson(res, 200, { ok: true, event: null });
    }
    return sendJson(res, 200, { ok: true, event: updated });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
