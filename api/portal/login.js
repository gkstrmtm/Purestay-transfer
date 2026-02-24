const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { supabaseAdmin } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const sb = supabaseAdmin();
  if (!sb) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const email = cleanStr(body.email, 320).toLowerCase();
  const password = cleanStr(body.password, 200);

  if (!email || !password) return sendJson(res, 422, { ok: false, error: 'missing_credentials' });

  const r = await sb.auth.signInWithPassword({ email, password });
  if (r.error || !r.data?.session || !r.data?.user) {
    return sendJson(res, 401, { ok: false, error: 'invalid_login' });
  }

  // Enforce that the user exists in portal_profiles
  const userId = r.data.user.id;
  const { data: prof, error: pErr } = await sb
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .eq('user_id', userId)
    .limit(1);

  if (pErr) return sendJson(res, 500, { ok: false, error: 'profile_lookup_failed' });
  const profile = Array.isArray(prof) ? prof[0] : null;
  if (!profile) return sendJson(res, 403, { ok: false, error: 'profile_missing' });

  return sendJson(res, 200, {
    ok: true,
    session: {
      access_token: r.data.session.access_token,
      refresh_token: r.data.session.refresh_token,
      expires_at: r.data.session.expires_at,
      expires_in: r.data.session.expires_in,
      token_type: r.data.session.token_type,
    },
    user: {
      id: r.data.user.id,
      email: r.data.user.email || '',
    },
    profile: {
      role: profile.role,
      fullName: profile.full_name || '',
      createdAt: profile.created_at,
    },
  });
};
