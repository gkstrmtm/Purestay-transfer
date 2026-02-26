const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { supabaseAdmin } = require('../../lib/portalAuth');

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

function supabaseAuthClient() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const sbAuth = supabaseAuthClient();
  if (!sbAuth) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const refreshToken = cleanStr(body.refresh_token || body.refreshToken, 5000);
  if (!refreshToken) return sendJson(res, 422, { ok: false, error: 'missing_refresh_token' });

  const r = await sbAuth.auth.refreshSession({ refresh_token: refreshToken });
  if (r.error || !r.data?.session || !r.data?.user) {
    return sendJson(res, 401, { ok: false, error: 'invalid_refresh_token' });
  }

  // Ensure the user still exists in portal_profiles.
  const userId = r.data.user.id;
  const { data: prof, error: pErr } = await sbAdmin
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
