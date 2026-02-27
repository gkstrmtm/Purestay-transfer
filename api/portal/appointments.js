const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { expandRoleAliases, roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function isDemoManagerEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  // Keep this narrowly scoped to the demo tenant.
  return e.endsWith('@demo.purestaync.com') || e.includes('@demo.') || e.includes('+demo@');
}

async function ensureDemoAppointments(sbAdmin, { demoSeedTag, assignedRole, assignedUserId, createdBy }) {
  const uid = String(assignedUserId || '').trim();
  if (!uid) return { ok: false, error: 'missing_assigned_user' };

  // Avoid duplicates: if any already exist for this assignee, do nothing.
  {
    const { data, error } = await sbAdmin
      .from('portal_events')
      .select('id')
      .eq('area_tag', 'appointment')
      .eq('assigned_user_id', uid)
      .limit(1);
    if (!error && Array.isArray(data) && data.length) return { ok: true, inserted: 0 };
  }

  // Try to attach to real leads if present.
  let leadIds = [];
  try {
    const { data } = await sbAdmin
      .from('portal_leads')
      .select('id')
      .order('id', { ascending: true })
      .limit(12);
    leadIds = (Array.isArray(data) ? data : []).map((r) => r?.id).filter(Boolean);
  } catch {
    leadIds = [];
  }

  const today = new Date();
  const baseYmd = today.toISOString().slice(0, 10);
  const mkYmd = (offsetDays) => {
    const d = new Date(`${baseYmd}T00:00:00`);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  const rows = [];
  for (let i = 0; i < 10; i++) {
    const leadId = leadIds[i % Math.max(1, leadIds.length)] || null;
    const eventDate = mkYmd(1 + (i % 10));
    rows.push({
      created_at: new Date().toISOString(),
      created_by: String(createdBy || '').trim() || uid,
      status: 'scheduled',
      title: leadId ? `Appointment • Lead #${leadId}` : `Appointment • Demo`,
      event_date: eventDate,
      start_time: ['09:00', '10:30', '13:00', '15:30', '17:00'][i % 5],
      end_time: ['09:30', '11:00', '13:30', '16:00', '17:30'][i % 5],
      area_tag: 'appointment',
      assigned_role: String(assignedRole || 'closer'),
      assigned_user_id: uid,
      payout_cents: 0,
      notes: 'Demo meeting',
      meta: {
        ...(demoSeedTag && typeof demoSeedTag === 'object' ? demoSeedTag : {}),
        kind: 'appointment',
        ...(leadId ? { leadId, leadLabel: `Lead #${leadId}` } : { leadLabel: 'Demo Lead' }),
      },
    });
  }

  const { error } = await sbAdmin
    .from('portal_events')
    .insert(rows);

  if (error) return { ok: false, error: 'demo_backfill_failed', detail: error.message || '' };
  return { ok: true, inserted: rows.length };
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
    (role && lead.assigned_role && roleMatchesAny(lead.assigned_role, role))
  );
}

async function userIdsForRole(sbAdmin, role, { limit = 200 } = {}) {
  const roles = expandRoleAliases(role);
  if (!roles.length) return [];
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id')
    .in('role', roles)
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
    (role && event.assigned_role && roleMatchesAny(event.assigned_role, role))
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

    // Keep the DB query simple and robust: fetch appointment-tagged rows,
    // then apply user/role visibility rules in JS.
    let query = s.sbAdmin
      .from('portal_events')
      .select('*')
      // Back-compat: older demo rows may rely on meta.kind.
      .or('area_tag.eq.appointment,meta->>kind.eq.appointment')
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true })
      .order('id', { ascending: false })
      .limit(limit);

    if (status) query = query.eq('status', status);
    if (leadId) query = query.contains('meta', { leadId });

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'appointments_query_failed' });

    const uid = String(s.effectiveUserId || s.user.id || '');
    let filtered = (Array.isArray(data) ? data : []).filter((ev) => canSeeEvent({ profile: s.profile, userId: uid, event: ev }));

    // Demo hardening: if the demo manager is viewing as closer/AM and meetings
    // are empty, auto-backfill a few demo appointments for the impersonated user.
    // This is intentionally scoped to the demo tenant to avoid side effects.
    try {
      const viewingRole = String(s.profile?.role || '').trim();
      const isDemoMgr = Boolean(s.realIsManager) && isDemoManagerEmail(s.user?.email);
      if (isDemoMgr && !filtered.length && ['closer', 'account_manager'].includes(viewingRole)) {
        await ensureDemoAppointments(s.sbAdmin, {
          demoSeedTag: { demoSeed: 'auto', demoRun: 'auto', demoDomain: (String(s.user?.email || '').split('@')[1] || 'demo') },
          assignedRole: viewingRole,
          assignedUserId: uid,
          createdBy: s.user?.id,
        });

        const retry = await s.sbAdmin
          .from('portal_events')
          .select('*')
          .or('area_tag.eq.appointment,meta->>kind.eq.appointment')
          .order('event_date', { ascending: true })
          .order('start_time', { ascending: true })
          .order('id', { ascending: false })
          .limit(limit);

        if (!retry.error) {
          filtered = (Array.isArray(retry.data) ? retry.data : []).filter((ev) => canSeeEvent({ profile: s.profile, userId: uid, event: ev }));
        }
      }
    } catch {
      // Best-effort; do not fail the request.
    }

    return sendJson(res, 200, { ok: true, appointments: filtered });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const leadId = clampInt(body.leadId, 1, 1e12, null);
    if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

    const okLead = await canTouchLead(s.sbAdmin, { profile: s.profile, userId: s.actorUserId, leadId });
    if (!okLead) return sendJson(res, 403, { ok: false, error: 'forbidden' });

    const eventDate = cleanStr(body.eventDate, 20);
    if (!eventDate) return sendJson(res, 422, { ok: false, error: 'missing_event_date' });

    const startTime = cleanStr(body.startTime, 20);
    if (!startTime) return sendJson(res, 422, { ok: false, error: 'missing_start_time' });

    const role = String(s.profile?.role || '');
    let assignedUserId = cleanStr(body.assignedUserId, 80) || null;
    // Closers scheduling for themselves: keep behavior.
    if (!isManager(s.profile) && ['closer', 'account_manager'].includes(role)) assignedUserId = s.actorUserId;
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
      created_by: s.actorUserId,
      status: 'scheduled',
      title: cleanStr(body.title, 200) || (leadLabel ? `Appointment • ${leadLabel}` : 'Appointment'),
      event_date: eventDate,
      start_time: startTime,
      end_time: cleanStr(body.endTime, 20),
      city: cleanStr(body.city, 120) || (lead ? cleanStr(lead.city, 120) : ''),
      state: cleanStr(body.state, 20) || (lead ? cleanStr(lead.state, 20) : ''),
      area_tag: 'appointment',
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
      userId: s.actorUserId,
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
    const kind = String((meta && typeof meta === 'object' ? meta.kind : '') || row.area_tag || '');
    if (kind !== 'appointment') return sendJson(res, 404, { ok: false, error: 'appointment_not_found' });

    const canEdit = isManager(s.profile)
      || (row.assigned_user_id && row.assigned_user_id === s.actorUserId)
      || (row.created_by && row.created_by === s.actorUserId);

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
          userId: s.actorUserId,
          outcome: 'completed',
          notes: 'Appointment marked completed',
          payload: { appointmentId: eventId },
        });
      }
      if (nextStatus === 'no_show') {
        await insertLeadActivity(s.sbAdmin, {
          leadId,
          userId: s.actorUserId,
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
