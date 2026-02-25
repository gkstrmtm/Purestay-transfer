const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { requirePortalSession, isManager } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'PATCH', 'OPTIONS'] })) return;

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });
  if (!isManager(s.realProfile)) return sendJson(res, 403, { ok: false, error: 'forbidden' });

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

    const userId = cleanStr(body.userId, 80);
    if (!userId) return sendJson(res, 422, { ok: false, error: 'missing_user_id' });

    const patch = {
      role: body.role != null ? cleanStr(body.role, 40) : undefined,
      full_name: body.fullName != null ? cleanStr(body.fullName, 120) : undefined,
    };

    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    if (!Object.keys(patch).length) {
      return sendJson(res, 422, { ok: false, error: 'missing_patch_fields' });
    }

    const { data, error } = await s.sbAdmin
      .from('portal_profiles')
      .update(patch)
      .eq('user_id', userId)
      .select('user_id, role, full_name, created_at')
      .limit(1);

    if (error) return sendJson(res, 500, { ok: false, error: 'profile_update_failed' });
    const profile = Array.isArray(data) ? data[0] : null;
    if (!profile) return sendJson(res, 404, { ok: false, error: 'profile_not_found' });
    return sendJson(res, 200, { ok: true, profile });
  }

  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

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
