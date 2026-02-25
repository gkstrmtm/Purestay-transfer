const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, isManager } = require('../../lib/portalAuth');
const { roleMatchesAny } = require('../../lib/portalRoleAliases');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function clampNum(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, x));
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

  if (!hasRole(s.profile, ['closer', 'account_manager', 'manager'])) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' });
  }

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const leadId = clampInt(body.leadId, 1, 1e12, null);
  if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

  const okLead = await canTouchLead(s.sbAdmin, { profile: s.profile, userId: s.user.id, leadId });
  if (!okLead) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const status = body.status != null ? cleanStr(body.status, 40) : null;
  const raw = (body.payload && typeof body.payload === 'object') ? body.payload : {};

  const disposition = cleanStr(raw.disposition, 80) || 'follow_up';

  const payload = {
    disposition,
    closedOn: raw.closedOn ? cleanStr(raw.closedOn, 20) : null,
    packageTier: raw.packageTier ? cleanStr(raw.packageTier, 40) : null,
    packagePrice: clampNum(raw.packagePrice, 0, 1e9, 0),
    initialPayment: clampNum(raw.initialPayment, 0, 1e9, 0),
    termMonths: clampInt(raw.termMonths, 0, 1200, 0),
    monthlyPricing: clampNum(raw.monthlyPricing, 0, 1e9, 0),
    contractSendDate: raw.contractSendDate ? cleanStr(raw.contractSendDate, 20) : null,
    notes: cleanStr(raw.notes, 5000),
  };

  // Update lead status (optional)
  if (status) {
    const { error: e1 } = await s.sbAdmin
      .from('portal_leads')
      .update({ status })
      .eq('id', leadId);
    if (e1) return sendJson(res, 500, { ok: false, error: 'lead_update_failed' });
  }

  const activity = {
    lead_id: leadId,
    created_by: s.user.id,
    activity_type: 'close',
    outcome: disposition,
    notes: payload.notes || '',
    payload,
  };

  const { data, error } = await s.sbAdmin
    .from('portal_lead_activities')
    .insert(activity)
    .select('*')
    .limit(1);

  if (error) return sendJson(res, 500, { ok: false, error: 'close_log_failed' });
  return sendJson(res, 200, { ok: true, activity: Array.isArray(data) ? data[0] : null });
};
