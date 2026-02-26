const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, hasRole, supabaseAdmin } = require('../../lib/portalAuth');

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function todayIsoDate() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function insertLeadActivity(sbAdmin, { leadId, userId, taskId, title }) {
  if (!leadId) return;
  const activity = {
    lead_id: leadId,
    created_by: userId,
    activity_type: 'dispatch',
    outcome: 'escalated',
    notes: `Dispatch task escalated: ${String(title || '').trim()}`.trim(),
    payload: { taskId },
  };
  await sbAdmin.from('portal_lead_activities').insert(activity);
}

async function scanAndEscalate(sbAdmin, { actorId, limit = 200 }) {
  const today = todayIsoDate();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('*')
    // Back-compat: older demo rows may rely on area_tag instead of meta.kind.
    .or('area_tag.eq.dispatch,meta->>kind.eq.dispatch')
    .in('status', ['open', 'assigned'])
    .order('event_date', { ascending: true })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) return { ok: false, error: 'dispatch_query_failed' };
  const rows = Array.isArray(data) ? data : [];

  const toEscalate = rows.filter((t) => {
    const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
    const kind = String(meta.kind || t.area_tag || '');
    if (kind !== 'dispatch') return false;
    if (meta.escalatedAt) return false;
    const due = String(t.event_date || '');
    if (due) return due < today;
    // No due date: only escalate if old enough
    return String(t.created_at || '') && String(t.created_at) < cutoff;
  });

  const updatedIds = [];
  for (const t of toEscalate) {
    const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
    const nextMeta = { ...meta, priority: 5, escalatedAt: new Date().toISOString(), escalatedBy: actorId };
    // eslint-disable-next-line no-await-in-loop
    const { error: e2 } = await sbAdmin
      .from('portal_events')
      .update({ meta: nextMeta })
      .eq('id', t.id);
    if (e2) continue;

    updatedIds.push(t.id);

    const leadId = clampInt(meta.leadId, 1, 1e12, null);
    // eslint-disable-next-line no-await-in-loop
    await insertLeadActivity(sbAdmin, { leadId, userId: actorId, taskId: t.id, title: t.title });
  }

  return { ok: true, scanned: rows.length, escalated: updatedIds.length, updatedIds };
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!hasRole(s.profile, ['event_coordinator', 'manager'])) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const r = await scanAndEscalate(sbAdmin, { actorId: s.user.id, limit: 200 });
  if (!r.ok) return sendJson(res, 500, { ok: false, error: r.error });
  return sendJson(res, 200, { ok: true, ...r });
};
