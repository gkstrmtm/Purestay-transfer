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

function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function canSeeTask({ profile, userId, task }) {
  if (isManager(profile)) return true;
  const role = String(profile?.role || '');
  return (
    (task.assigned_user_id && task.assigned_user_id === userId) ||
    (task.created_by && task.created_by === userId) ||
    (role && task.assigned_role && roleMatchesAny(task.assigned_role, role))
  );
}

async function insertLeadActivity(sbAdmin, { leadId, userId, outcome, notes, payload }) {
  if (!leadId) return;
  const activity = {
    lead_id: leadId,
    created_by: userId,
    activity_type: 'dispatch',
    outcome: cleanStr(outcome, 80),
    notes: cleanStr(notes, 5000),
    payload: (payload && typeof payload === 'object') ? payload : {},
  };
  await sbAdmin.from('portal_lead_activities').insert(activity);
}

async function lookupLeadLabel(sbAdmin, leadId) {
  if (!leadId) return { leadLabel: '', lead: null };
  const { data, error } = await sbAdmin
    .from('portal_leads')
    .select('id, first_name, last_name, property_name, company')
    .eq('id', leadId)
    .limit(1);
  if (error) return { leadLabel: '', lead: null };
  const lead = Array.isArray(data) ? data[0] : null;
  if (!lead) return { leadLabel: '', lead: null };
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim();
  const prop = lead.property_name || lead.company || '';
  const leadLabel = [name, prop].filter(Boolean).join(' • ');
  return { leadLabel, lead };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/dispatch', 'http://localhost');

  if (req.method === 'GET') {
    const status = cleanStr(url.searchParams.get('status'), 40);
    const assignedRole = cleanStr(url.searchParams.get('assignedRole'), 40);
    const leadId = clampInt(url.searchParams.get('leadId'), 1, 1e12, null);
    const overdueOnly = cleanStr(url.searchParams.get('overdue'), 10) === '1';
    const scope = cleanStr(url.searchParams.get('scope'), 20);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);

    let query = s.sbAdmin
      .from('portal_events')
      .select('*')
      .contains('meta', { kind: 'dispatch' })
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true })
      .order('id', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (assignedRole) query = applyRoleFilter(query, 'assigned_role', assignedRole);
    if (leadId) query = query.contains('meta', { kind: 'dispatch', leadId });

    if (!isManager(s.profile)) {
      const role = String(s.profile.role || '');
      const uid = String(s.effectiveUserId || s.user.id || '');

      // Manager view-as mode: simulate the role inbox (unassigned).
      if (s.viewAsRole && role && !s.effectiveUserId) {
        query = applyRoleFilter(query, 'assigned_role', role);
        query = query.eq('assigned_user_id', null);
      } else {

        if (scope === 'mine') {
          query = query.eq('assigned_user_id', uid);
        } else if (scope === 'role') {
          if (!role) {
            query = query.eq('assigned_user_id', uid);
          } else {
            query = applyRoleFilter(query, 'assigned_role', role);
            query = query.or([`assigned_user_id.is.null`, `assigned_user_id.eq.${uid}`].join(','));
          }
        } else {
          const parts = [
            `assigned_user_id.eq.${uid}`,
            `created_by.eq.${uid}`,
          ];
          if (role) parts.push(...buildRoleOrParts('assigned_role', role));
          query = query.or(parts.join(','));
        }
      }
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'dispatch_query_failed', detail: error.message || '' });

    const tasks = (Array.isArray(data) ? data : []).filter((t) => {
      const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
      if (meta.kind !== 'dispatch') return false;
      const uid = String(s.effectiveUserId || s.user.id || '');
      if (!canSeeTask({ profile: s.profile, userId: uid, task: t })) return false;
      if (!overdueOnly) return true;
      const due = String(t.event_date || '');
      const st = String(t.status || '');
      return !!due && due < todayIsoDate() && !['completed', 'cancelled'].includes(st);
    });

    return sendJson(res, 200, { ok: true, tasks });
  }

  if (req.method === 'POST') {
    if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const leadId = clampInt(body.leadId, 1, 1e12, null);
    const title = cleanStr(body.title, 200);
    if (!title) return sendJson(res, 422, { ok: false, error: 'missing_title' });

    const assignedRole = cleanStr(body.assignedRole, 40);
    if (!assignedRole) return sendJson(res, 422, { ok: false, error: 'missing_assigned_role' });

    const dueDate = cleanStr(body.dueDate, 20) || null;
    const dueTime = cleanStr(body.dueTime, 20) || '';
    const priority = clampInt(body.priority, -5, 5, 0);

    let assignedUserId = cleanStr(body.assignedUserId, 80) || null;
    if (!isManager(s.profile)) {
      // Non-managers can only assign to themselves.
      if (assignedUserId && assignedUserId !== s.actorUserId) assignedUserId = null;
    }

    const { leadLabel } = await lookupLeadLabel(s.sbAdmin, leadId);

    const task = {
      created_by: s.actorUserId,
      status: 'open',
      title,
      event_date: dueDate,
      start_time: dueTime,
      end_time: '',
      address: '',
      city: '',
      state: '',
      postal_code: '',
      area_tag: 'dispatch',
      assigned_role: assignedRole,
      assigned_user_id: assignedUserId,
      payout_cents: 0,
      notes: cleanStr(body.notes, 5000),
      meta: {
        kind: 'dispatch',
        leadId: leadId || null,
        leadLabel: leadLabel || '',
        priority,
        reason: cleanStr(body.reason, 200),
      },
    };

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .insert(task)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'dispatch_insert_failed' });
    const inserted = Array.isArray(data) ? data[0] : null;

    if (leadId) {
      const when = [dueDate || '', dueTime || ''].filter(Boolean).join(' ');
      await insertLeadActivity(s.sbAdmin, {
        leadId,
        userId: s.actorUserId,
        outcome: 'created',
        notes: `Dispatch task created: ${title}${when ? (`\nDue: ${when}`) : ''}`,
        payload: { taskId: inserted?.id || null, priority },
      });
    }

    return sendJson(res, 200, { ok: true, task: inserted });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const taskId = clampInt(body.id, 1, 1e12, null);
    if (!taskId) return sendJson(res, 422, { ok: false, error: 'missing_task_id' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('*')
      .eq('id', taskId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'dispatch_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'dispatch_not_found' });

    const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
    if (meta.kind !== 'dispatch') return sendJson(res, 404, { ok: false, error: 'dispatch_not_found' });

    if (String(body.action || '') === 'escalate') {
      if (!hasRole(s.profile, ['event_coordinator', 'manager'])) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' });
      }

      const nextMeta = Object.assign({}, meta);
      const currentPriority = clampInt(nextMeta.priority, -5, 5, 0);
      nextMeta.priority = Math.max(currentPriority, 5);
      nextMeta.escalatedAt = new Date().toISOString();
      nextMeta.escalatedBy = s.actorUserId;

      const { data, error } = await s.sbAdmin
        .from('portal_events')
        .update({ meta: nextMeta })
        .eq('id', taskId)
        .select('*')
        .limit(1);

      if (error) return sendJson(res, 500, { ok: false, error: 'dispatch_update_failed' });
      const updated = Array.isArray(data) ? data[0] : null;

      const leadId = clampInt(meta.leadId, 1, 1e12, null);
      if (leadId) {
        await insertLeadActivity(s.sbAdmin, {
          leadId,
          userId: s.actorUserId,
          outcome: 'escalated',
          notes: `Dispatch task escalated: ${String(row.title || '').trim()}`.trim(),
          payload: { taskId, priority: nextMeta.priority },
        });
      }

      return sendJson(res, 200, { ok: true, task: updated });
    }

    const canEdit = isManager(s.profile)
      || hasRole(s.profile, ['event_coordinator'])
      || (row.assigned_user_id && row.assigned_user_id === s.actorUserId)
      || (row.created_by && row.created_by === s.actorUserId);

    const requestedAssignedUserId = body.assignedUserId != null ? (cleanStr(body.assignedUserId, 80) || null) : undefined;
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
      event_date: body.dueDate != null ? (cleanStr(body.dueDate, 20) || null) : undefined,
      start_time: body.dueTime != null ? cleanStr(body.dueTime, 20) : undefined,
      assigned_role: body.assignedRole != null ? cleanStr(body.assignedRole, 40) : undefined,
      assigned_user_id: body.assignedUserId != null ? (cleanStr(body.assignedUserId, 80) || null) : undefined,
      notes: body.notes != null ? cleanStr(body.notes, 5000) : undefined,
      meta: body.meta != null ? ((body.meta && typeof body.meta === 'object') ? body.meta : {}) : undefined,
    };

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    if (canClaim) {
      const allowed = {
        assigned_user_id: patch.assigned_user_id,
        status: patch.status || 'assigned',
      };
      for (const k of Object.keys(patch)) delete patch[k];
      patch.assigned_user_id = allowed.assigned_user_id;
      patch.status = allowed.status;
    }

    if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, task: row });

    const prevStatus = String(row.status || '');
    const nextStatus = patch.status != null ? String(patch.status) : prevStatus;

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .update(patch)
      .eq('id', taskId)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'dispatch_update_failed' });
    const updated = Array.isArray(data) ? data[0] : null;

    const leadId = clampInt(meta.leadId, 1, 1e12, null);
    if (leadId && prevStatus !== nextStatus) {
      if (nextStatus === 'completed') {
        await insertLeadActivity(s.sbAdmin, {
          leadId,
          userId: s.actorUserId,
          outcome: 'completed',
          notes: `Dispatch task completed: ${row.title || ''}`.trim(),
          payload: { taskId },
        });
      }
      if (nextStatus === 'cancelled') {
        await insertLeadActivity(s.sbAdmin, {
          leadId,
          userId: s.actorUserId,
          outcome: 'cancelled',
          notes: `Dispatch task cancelled: ${row.title || ''}`.trim(),
          payload: { taskId },
        });
      }
    }

    return sendJson(res, 200, { ok: true, task: updated });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
