const { sendJson, handleCors, bearerToken } = require('../../lib/vercelApi');
const { supabaseAdmin } = require('../../lib/portalAuth');

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

async function isAuthorized(req) {
  const cronHeader = req.headers?.['x-vercel-cron'];
  if (cronHeader) return true;

  const adminToken = process.env.ADMIN_TOKEN || '';
  if (!adminToken) return true;

  const token = bearerToken(req) || (req.url ? new URL(req.url, 'http://localhost').searchParams.get('token') : '') || '';
  return token === adminToken;
}

async function insertLeadActivity(sbAdmin, { leadId, taskId, title }) {
  if (!leadId) return;
  const activity = {
    lead_id: leadId,
    created_by: null,
    activity_type: 'dispatch',
    outcome: 'escalated',
    notes: `Dispatch task escalated (cron): ${String(title || '').trim()}`.trim(),
    payload: { taskId },
  };
  try {
    await sbAdmin.from('portal_lead_activities').insert(activity);
  } catch (_) {
    // best-effort; don't fail the cron job on audit log issues
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'POST', 'OPTIONS'] })) return;
  if (req.method !== 'GET' && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const okAuth = await isAuthorized(req);
  if (!okAuth) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const url = new URL(req.url || '/api/cron/dispatch-escalate', 'http://localhost');
  const limit = Math.max(1, Math.min(500, clampInt(url.searchParams.get('limit'), 1, 500, 200)));
  const today = todayIsoDate();
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { data, error } = await sbAdmin
    .from('portal_events')
    .select('*')
    .contains('meta', { kind: 'dispatch' })
    .in('status', ['open', 'assigned'])
    .order('event_date', { ascending: true })
    .order('id', { ascending: false })
    .limit(limit);

  if (error) return sendJson(res, 500, { ok: false, error: 'dispatch_query_failed' });

  const rows = Array.isArray(data) ? data : [];
  const toEscalate = rows.filter((t) => {
    const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
    if (meta.kind !== 'dispatch') return false;
    if (meta.escalatedAt) return false;
    const due = String(t.event_date || '');
    if (due) return due < today;
    return String(t.created_at || '') && String(t.created_at) < cutoff;
  });

  const updatedIds = [];
  for (const t of toEscalate) {
    const meta = t.meta && typeof t.meta === 'object' ? t.meta : {};
    const nextMeta = { ...meta, priority: 5, escalatedAt: new Date().toISOString(), escalatedBy: 'cron' };
    // eslint-disable-next-line no-await-in-loop
    const { error: e2 } = await sbAdmin
      .from('portal_events')
      .update({ meta: nextMeta })
      .eq('id', t.id);
    if (e2) continue;
    updatedIds.push(t.id);

    const leadId = clampInt(meta.leadId, 1, 1e12, null);
    // eslint-disable-next-line no-await-in-loop
    await insertLeadActivity(sbAdmin, { leadId, taskId: t.id, title: t.title });
  }

  return sendJson(res, 200, { ok: true, scanned: rows.length, escalated: updatedIds.length, updatedIds });
};
