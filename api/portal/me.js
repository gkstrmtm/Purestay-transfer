const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, buildPortalCapabilities } = require('../../lib/portalAuth');
const { tableExists } = require('../../lib/portalFoundation');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  let person = null;
  if (await tableExists(s.sbAdmin, 'portal_people')) {
    const { data } = await s.sbAdmin
      .from('portal_people')
      .select('user_id, role, full_name, employment_status, readiness_status, team_code, manager_user_id, can_be_assigned, home_base_city, home_base_state, created_at, updated_at')
      .eq('user_id', s.user.id)
      .limit(1);
    person = Array.isArray(data) ? data[0] || null : null;
  }

  return sendJson(res, 200, {
    ok: true,
    session: {
      mode: s.sessionMode || 'supabase',
      preview: !!s.previewAccess,
    },
    user: {
      id: s.user.id,
      email: s.user.email || '',
    },
    profile: {
      role: s.profile.role,
      fullName: s.profile.full_name || '',
      createdAt: s.profile.created_at,
    },
    roleContext: {
      realRole: s.realProfile?.role || s.profile.role || '',
      effectiveRole: s.profile.role || '',
      viewAsRole: s.viewAsRole || '',
      viewAsUserId: s.viewAsUserId || '',
    },
    capabilities: s.capabilities || buildPortalCapabilities(s),
    person,
  });
};
