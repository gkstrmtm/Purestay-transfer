const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

async function canTouchLead(sbAdmin, { profile, userId, leadId }) {
  if (isManager(profile)) return true;
  const { data, error } = await sbAdmin
    .from('portal_leads')
    .select('id, created_by, assigned_role, assigned_user_id')
    .eq('id', leadId)
    .limit(1);
  if (error) return false;
  const lead = Array.isArray(data) ? data[0] : null;
  if (!lead) return false;
  const role = String(profile?.role || '');
  return (
    (lead.assigned_user_id && lead.assigned_user_id === userId) ||
    (lead.created_by && lead.created_by === userId) ||
    (role && lead.assigned_role && lead.assigned_role === role)
  );
}

async function userIdsForRole(sbAdmin, role, { limit = 200 } = {}) {
  const r = String(role || '').trim();
  if (!r) return [];
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id')
    .eq('role', r)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return [];
  return (Array.isArray(data) ? data : []).map((x) => x.user_id).filter(Boolean);
}

function canSeeEvent({ profile, userId, event }) {
  if (isManager(profile)) return true;
  const role = String(profile?.role || '');
  return (
    (event.assigned_user_id && event.assigned_user_id === userId) ||
    (event.created_by && event.created_by === userId) ||
    (role && event.assigned_role && event.assigned_role === role)
  );
}

async function insertLeadActivity(sbAdmin, { leadId, userId, outcome, notes, payload }) {
  if (!leadId) return;
  const activity = {
    lead_id: leadId,
    created_by: userId,
    activity_type: 'appointment',
    outcome: cleanStr(outcome, 80),
    notes: cleanStr(notes, 5000),
    payload: (payload && typeof payload === 'object') ? payload : {},
  };
  await sbAdmin.from('portal_lead_activities').insert(activity);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  if (!hasRole(s.profile, ['closer', 'account_manager', 'dialer', 'in_person_setter', 'remote_setter', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const url = new URL(req.url || '/api/portal/appointments', 'http://localhost');

  if (req.method === 'GET') {
    const status = cleanStr(url.searchParams.get('status'), 40);
    const leadId = clampInt(url.searchParams.get('leadId'), 1, 1e12, null);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);

    let query = s.sbAdmin
      .from('portal_events')
      .select('*')
      .contains('meta', { kind: 'appointment' })
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true })
      .order('id', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (leadId) query = query.contains('meta', { kind: 'appointment', leadId });

    if (!isManager(s.profile)) {
      const role = String(s.profile?.role || '');
      const uid = String(s.effectiveUserId || s.user.id || '');

      if (s.viewAsRole && role && !s.effectiveUserId) {
        // View-as role without a specific user selected: role-wide preview.
        const ids = await userIdsForRole(s.sbAdmin, role, { limit: 220 });
        if (!ids.length) {
          return sendJson(res, 200, { ok: true, appointments: [] });
        }

        if (['dialer', 'in_person_setter', 'remote_setter'].includes(role)) {
          query = query.in('created_by', ids);
        } else if (['closer', 'account_manager'].includes(role)) {
          query = query.or([
            `assigned_user_id.in.(${ids.join(',')})`,
            `created_by.in.(${ids.join(',')})`,
          ].join(','));
        } else {
          return sendJson(res, 200, { ok: true, appointments: [] });
        }
      } else {
        if (['closer', 'account_manager'].includes(role)) {
          query = query.or([`assigned_user_id.eq.${uid}`, `created_by.eq.${uid}`].join(','));
        } else {
          query = query.eq('created_by', uid);
        }
      }
    }

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'appointments_query_failed' });

    // In view-as mode, the query is already role-scoped; don't re-filter by
    // userId/role ownership checks.
    if (s.viewAsRole && !s.effectiveUserId) {
      return sendJson(res, 200, { ok: true, appointments: Array.isArray(data) ? data : [] });
    }

    const uid = String(s.effectiveUserId || s.user.id || '');
    const filtered = (Array.isArray(data) ? data : []).filter((ev) => canSeeEvent({ profile: s.profile, userId: uid, event: ev }));
    return sendJson(res, 200, { ok: true, appointments: filtered });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const leadId = clampInt(body.leadId, 1, 1e12, null);
    if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

    const okLead = await canTouchLead(s.sbAdmin, { profile: s.profile, userId: s.user.id, leadId });
    if (!okLead) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const eventDate = cleanStr(body.eventDate, 20);
    if (!eventDate) return sendJson(res, 422, { ok: false, error: 'missing_event_date' });

    const startTime = cleanStr(body.startTime, 20);
    if (!startTime) return sendJson(res, 422, { ok: false, error: 'missing_start_time' });

    const role = String(s.profile?.role || '');
    let assignedUserId = cleanStr(body.assignedUserId, 80) || null;
    // Closers scheduling for themselves: keep behavior.
    if (!isManager(s.profile) && ['closer', 'account_manager'].includes(role)) assignedUserId = s.user.id;
    // Dialers/setters scheduling for closers: do NOT force assignment to the caller.
    if (!isManager(s.profile) && ['dialer', 'in_person_setter', 'remote_setter'].includes(role)) {
      assignedUserId = assignedUserId || null;
    }

    const { data: leadRows, error: leadErr } = await s.sbAdmin
      .from('portal_leads')
      .select('id, status, first_name, last_name, property_name, company, city, state')
      .eq('id', leadId)
      .limit(1);

    if (leadErr) return sendJson(res, 500, { ok: false, error: 'lead_lookup_failed' });
    const lead = Array.isArray(leadRows) ? leadRows[0] : null;

    const name = lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim() : '';
    const prop = lead ? (lead.property_name || lead.company || '') : '';
    const leadLabel = [name, prop].filter(Boolean).join(' • ');

    const event = {
      created_by: s.user.id,
      status: 'scheduled',
      title: cleanStr(body.title, 200) || (leadLabel ? `Appointment • ${leadLabel}` : 'Appointment'),
      event_date: eventDate,
      start_time: startTime,
      end_time: cleanStr(body.endTime, 20),
      city: cleanStr(body.city, 120) || (lead ? cleanStr(lead.city, 120) : ''),
      state: cleanStr(body.state, 20) || (lead ? cleanStr(lead.state, 20) : ''),
      assigned_role: 'closer',
      assigned_user_id: assignedUserId,
      notes: cleanStr(body.notes, 5000),
      meta: {
        kind: 'appointment',
        leadId,
        leadLabel,
      },
    };

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .insert(event)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'appointment_insert_failed' });

    const appt = Array.isArray(data) ? data[0] : null;
    const when = [eventDate || '', startTime || ''].filter(Boolean).join(' ');
    await insertLeadActivity(s.sbAdmin, {
      leadId,
      userId: s.user.id,
      outcome: 'scheduled',
      notes: `Appointment scheduled${when ? (`: ${when}`) : ''}` + (event.notes ? (`\n${event.notes}`) : ''),
      payload: { appointmentId: appt?.id || null },
    });

    // If this lead is not already final, push it into booked.
    try {
      const currentStatus = cleanStr(lead?.status, 40);
      if (currentStatus && !['won', 'lost'].includes(currentStatus) && currentStatus !== 'booked') {
        await s.sbAdmin.from('portal_leads').update({ status: 'booked' }).eq('id', leadId);
      }
      if (!currentStatus) {
        // If lead wasn't loaded with status, do a conservative update.
        await s.sbAdmin
          .from('portal_leads')
          .update({ status: 'booked' })
          .eq('id', leadId)
          .not('status', 'in', '("won","lost")');
      }
    } catch {
      // Do not fail appointment creation due to a best-effort lead status update.
    }

    return sendJson(res, 200, { ok: true, appointment: appt });
  }

  if (req.method === 'PATCH') {
    if (!hasRole(s.profile, ['closer', 'account_manager', 'manager'])) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const eventId = clampInt(body.id, 1, 1e12, null);
    if (!eventId) return sendJson(res, 422, { ok: false, error: 'missing_appointment_id' });

    const { data: existing, error: e1 } = await s.sbAdmin
      .from('portal_events')
      .select('*')
      .eq('id', eventId)
      .limit(1);

    if (e1) return sendJson(res, 500, { ok: false, error: 'appointment_lookup_failed' });
    const row = Array.isArray(existing) ? existing[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'appointment_not_found' });

    const meta = row.meta || {};
    if (meta.kind !== 'appointment') return sendJson(res, 404, { ok: false, error: 'appointment_not_found' });

    const canEdit = isManager(s.profile)
      || (row.assigned_user_id && row.assigned_user_id === s.user.id)
      || (row.created_by && row.created_by === s.user.id);

    if (!canEdit) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const patch = {
      status: body.status != null ? cleanStr(body.status, 40) : undefined,
      event_date: body.eventDate != null ? (cleanStr(body.eventDate, 20) || null) : undefined,
      start_time: body.startTime != null ? cleanStr(body.startTime, 20) : undefined,
      end_time: body.endTime != null ? cleanStr(body.endTime, 20) : undefined,
      notes: body.notes != null ? cleanStr(body.notes, 5000) : undefined,
    };

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    if (!Object.keys(patch).length) return sendJson(res, 200, { ok: true, appointment: row });

    const prevStatus = String(row.status || '');
    const nextStatus = patch.status != null ? String(patch.status) : prevStatus;

    const { data, error } = await s.sbAdmin
      .from('portal_events')
      .update(patch)
      .eq('id', eventId)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'appointment_update_failed' });
    const updated = Array.isArray(data) ? data[0] : null;

    const leadId = clampInt(meta.leadId, 1, 1e12, null);
    if (leadId && prevStatus !== nextStatus) {
      if (nextStatus === 'completed') {
        await insertLeadActivity(s.sbAdmin, {
          leadId,
          userId: s.user.id,
          outcome: 'completed',
          notes: 'Appointment marked completed',
          payload: { appointmentId: eventId },
        });
      }
      if (nextStatus === 'no_show') {
        await insertLeadActivity(s.sbAdmin, {
          leadId,
          userId: s.user.id,
          outcome: 'no_show',
          notes: 'Appointment marked no show',
          payload: { appointmentId: eventId },
        });
      }
    }

    return sendJson(res, 200, { ok: true, appointment: updated });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
