const { sendJson, handleCors, readJson } = require('../../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../../lib/portalAuth');
const { generateFollowup } = require('../../../lib/aiPortal');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
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

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const leadId = clampInt(body.leadId, 1, 1e12, null);
  if (!leadId) return sendJson(res, 422, { ok: false, error: 'missing_lead_id' });

  const { data, error } = await s.sbAdmin
    .from('portal_leads')
    .select('*')
    .eq('id', leadId)
    .limit(1);

  if (error) return sendJson(res, 500, { ok: false, error: 'lead_lookup_failed' });
  const lead = Array.isArray(data) ? data[0] : null;
  if (!lead) return sendJson(res, 404, { ok: false, error: 'lead_not_found' });
  if (!canSeeLead({ profile: s.profile, userId: s.user.id, lead })) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const r = await generateFollowup({ lead, outcome: body.outcome, notes: body.notes });
  if (!r.ok) return sendJson(res, 502, { ok: false, error: r.error });

  return sendJson(res, 200, { ok: true, followup: r.data });
};
