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

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['dialer', 'in_person_setter', 'remote_setter', 'closer', 'account_manager', 'event_coordinator'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const leadId = clampInt(body.leadId, 1, 1e12, null);
  if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

  const okLead = await canTouchLead(s.sbAdmin, { profile: s.profile, userId: s.actorUserId, leadId });
  if (!okLead) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const activity = {
    lead_id: leadId,
    created_by: s.actorUserId,
    activity_type: 'call',
    outcome: cleanStr(body.outcome, 80),
    notes: cleanStr(body.notes, 5000),
    payload: (body.payload && typeof body.payload === 'object') ? body.payload : {},
  };

  const { data, error } = await s.sbAdmin
    .from('portal_lead_activities')
    .insert(activity)
    .select('*')
    .limit(1);

  if (error) return sendJson(res, 500, { ok: false, error: 'call_log_failed' });
  return sendJson(res, 200, { ok: true, activity: Array.isArray(data) ? data[0] : null });
};
