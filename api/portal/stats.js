const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');
const { buildRoleOrParts } = require('../../lib/portalRoleAliases');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

async function countLeads(sbAdmin, { whereOr, status }) {
  let q = sbAdmin
    .from('portal_leads')
    .select('*', { count: 'exact', head: true });
  if (status) q = q.eq('status', status);
  if (whereOr) q = q.or(whereOr);
  const { count, error } = await q;
  if (error) return null;
  return Number(count || 0);
}

async function countActivities(sbAdmin, { whereOr, activityType, sinceIso }) {
  let q = sbAdmin
    .from('portal_lead_activities')
    .select('*', { count: 'exact', head: true });
  if (activityType) q = q.eq('activity_type', activityType);
  if (sinceIso) q = q.gte('created_at', sinceIso);

  if (whereOr) {
    // Join via leads is not available; so limit to created_by for non-managers.
    // Caller should pass null for managers.
  }

  const { count, error } = await q;
  if (error) return null;
  return Number(count || 0);
}

async function countAppointments(sbAdmin, { assignedUserId, sinceDate }) {
  let q = sbAdmin
    .from('portal_events')
    .select('*', { count: 'exact', head: true })
    .contains('meta', { kind: 'appointment' });
  if (assignedUserId) q = q.eq('assigned_user_id', assignedUserId);
  if (sinceDate) q = q.gte('event_date', sinceDate);
  const { count, error } = await q;
  if (error) return null;
  return Number(count || 0);
}

async function countDispatch(sbAdmin, { statusIn, overdueOnly }) {
  let q = sbAdmin
    .from('portal_events')
    .select('*', { count: 'exact', head: true })
    .contains('meta', { kind: 'dispatch' });

  if (Array.isArray(statusIn) && statusIn.length) q = q.in('status', statusIn);
  if (overdueOnly) {
    const today = new Date();
    const yyyy = today.getUTCFullYear();
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const todayIso = `${yyyy}-${mm}-${dd}`;
    q = q.lt('event_date', todayIso);
  }

  const { count, error } = await q;
  if (error) return null;
  return Number(count || 0);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  const url = new URL(req.url || '/api/portal/stats', 'http://localhost');
  const scope = cleanStr(url.searchParams.get('scope'), 30) || 'me';

  const role = String(s.profile.role || '');
  const manager = isManager(s.profile);

  let whereOr = null;
  if (!manager && scope === 'me') {
    const parts = [
      `assigned_user_id.eq.${s.user.id}`,
      `created_by.eq.${s.user.id}`,
    ];
    if (role) parts.push(...buildRoleOrParts('assigned_role', role));
    whereOr = parts.join(',');
  }

  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(today.getUTCDate()).padStart(2, '0');
  const todayIso = `${yyyy}-${mm}-${dd}`;
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const statuses = ['new', 'working', 'booked', 'won', 'lost'];
  const leadCounts = {};
  // eslint-disable-next-line no-restricted-syntax
  for (const st of statuses) {
    // eslint-disable-next-line no-await-in-loop
    leadCounts[st] = await countLeads(s.sbAdmin, { whereOr, status: st });
  }

  let callsLast24h = null;
  if (manager && scope !== 'me') {
    callsLast24h = await countActivities(s.sbAdmin, { activityType: 'call', sinceIso });
  } else {
    // For non-managers, only count their own calls.
    const q = s.sbAdmin
      .from('portal_lead_activities')
      .select('*', { count: 'exact', head: true })
      .eq('activity_type', 'call')
      .eq('created_by', s.user.id)
      .gte('created_at', sinceIso);
    const { count } = await q;
    callsLast24h = Number(count || 0);
  }

  const upcomingAppointments = await countAppointments(s.sbAdmin, {
    assignedUserId: manager && scope !== 'me' ? null : s.user.id,
    sinceDate: todayIso,
  });

  const dispatchOpen = await countDispatch(s.sbAdmin, {
    statusIn: ['open', 'assigned'],
    overdueOnly: false,
  });

  const dispatchOverdue = await countDispatch(s.sbAdmin, {
    statusIn: ['open', 'assigned'],
    overdueOnly: true,
  });

  return sendJson(res, 200, {
    ok: true,
    scope: manager ? scope : 'me',
    role,
    leadCounts,
    callsLast24h,
    upcomingAppointments,
    dispatchOpen,
    dispatchOverdue,
  });
};
