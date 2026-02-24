const { sendJson, handleCors } = require('../../lib/vercelApi');
const { requirePortalSession } = require('../../lib/portalAuth');

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['GET', 'OPTIONS'] })) return;
  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const s = await requirePortalSession(req);
  if (!s.ok) return sendJson(res, s.status || 401, { ok: false, error: s.error });

  return sendJson(res, 200, {
    ok: true,
    user: {
      id: s.user.id,
      email: s.user.email || '',
    },
    profile: {
      role: s.profile.role,
      fullName: s.profile.full_name || '',
      createdAt: s.profile.created_at,
    },
  });
};
