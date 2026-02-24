const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!isManager(s.profile)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  const { data: profiles, error } = await s.sbAdmin
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) return sendJson(res, 500, { ok: false, error: 'profiles_query_failed' });

  const listed = await s.sbAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const byId = new Map((listed?.data?.users || []).map((u) => [u.id, u]));

  const users = (profiles || []).map((p) => {
    const u = byId.get(p.user_id);
    return {
      userId: p.user_id,
      role: p.role,
      fullName: p.full_name || '',
      email: u?.email || '',
      createdAt: p.created_at,
    };
  });

  return sendJson(res, 200, { ok: true, users });
};
