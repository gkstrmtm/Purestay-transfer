const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function canSeeLead({ profile, userId, lead }) {
  if (isManager(profile)) return true;
  const role = String(profile?.role || '');
  return (
    (lead.assigned_user_id && lead.assigned_user_id === userId) ||
    (lead.created_by && lead.created_by === userId) ||
    (role && lead.assigned_role && lead.assigned_role === role)
  );
}

async function loadLead(sbAdmin, leadId) {
  const { data, error } = await sbAdmin
    .from('portal_leads')
    .select('id, created_by, assigned_role, assigned_user_id, status, first_name, last_name, property_name, company')
    .eq('id', leadId)
    .limit(1);
  if (error) return { ok: false, error: 'lead_lookup_failed' };
  const lead = Array.isArray(data) ? data[0] : null;
  if (!lead) return { ok: false, error: 'lead_not_found' };
  return { ok: true, lead };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/activities', 'http://localhost');

  if (req.method === 'GET') {
    const leadId = clampInt(url.searchParams.get('leadId'), 1, 1e12, null);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 80);
    const type = cleanStr(url.searchParams.get('type'), 40);

    if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

    const l = await loadLead(s.sbAdmin, leadId);
    if (!l.ok) return sendJson(res, l.error === 'lead_not_found' ? 404 : 500, { ok: false, error: l.error });
    if (!canSeeLead({ profile: s.profile, userId: s.user.id, lead: l.lead })) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    let query = s.sbAdmin
      .from('portal_lead_activities')
      .select('*')
      .eq('lead_id', leadId)
      .order('id', { ascending: false })
      .limit(limit);

    if (type) query = query.eq('activity_type', type);

    const { data, error } = await query;
    if (error) return sendJson(res, 500, { ok: false, error: 'activities_query_failed' });

    return sendJson(res, 200, {
      ok: true,
      lead: l.lead,
      activities: Array.isArray(data) ? data : [],
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const leadId = clampInt(body.leadId, 1, 1e12, null);
    if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

    const l = await loadLead(s.sbAdmin, leadId);
    if (!l.ok) return sendJson(res, l.error === 'lead_not_found' ? 404 : 500, { ok: false, error: l.error });
    if (!canSeeLead({ profile: s.profile, userId: s.user.id, lead: l.lead })) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' });
    }

    const activityType = cleanStr(body.activityType || 'note', 40) || 'note';
    const notes = cleanStr(body.notes, 8000);
    if (!notes) return sendJson(res, 422, { ok: false, error: 'missing_notes' });

    const activity = {
      lead_id: leadId,
      created_by: s.user.id,
      activity_type: activityType,
      outcome: cleanStr(body.outcome, 80),
      notes,
      payload: (body.payload && typeof body.payload === 'object') ? body.payload : {},
    };

    const { data, error } = await s.sbAdmin
      .from('portal_lead_activities')
      .insert(activity)
      .select('*')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'activity_insert_failed' });

    return sendJson(res, 200, { ok: true, activity: Array.isArray(data) ? data[0] : null });
  }

  return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
};
