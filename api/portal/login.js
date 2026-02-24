const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const { supabaseAdmin } = require('../../lib/portalAuth');

const ALLOWED_ROLES = [
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'event_host',
  'account_manager',
  'event_coordinator',
  'media_team',
  'manager',
];

function titleCase(s) {
  return String(s || '')
    .split(/[_\-\s]+/g)
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(' ');
}

function emailDomain(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return '';
  return s.slice(at + 1);
}

function allowedDomains() {
  const raw = String(process.env.PORTAL_ALLOWED_EMAIL_DOMAINS || '').trim();
  const fallback = ['purestaync.com', 'demo.purestaync.com'];
  const items = raw
    ? raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    : fallback;
  return Array.from(new Set(items));
}

function isAllowedEmail(email) {
  const d = emailDomain(email);
  if (!d) return false;
  return allowedDomains().some((x) => d === x || d.endsWith('.' + x));
}

function normalizeRole(roleLike) {
  const r = String(roleLike || '').trim().toLowerCase();
  if (ALLOWED_ROLES.includes(r)) return r;
  return 'dialer';
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

async function assertServiceRole(sb) {
  try {
    const r = await sb.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (r?.error) return { ok: false, error: 'invalid_supabase_service_role', detail: r.error.message || '' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'invalid_supabase_service_role', detail: String(e?.message || e || '') };
  }
}

module.exports = async (req, res) => {
  if (handleCors(req, res, { methods: ['POST', 'OPTIONS'] })) return;
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });

  const sb = supabaseAdmin();
  if (!sb) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const svc = await assertServiceRole(sb);
  if (!svc.ok) return sendJson(res, 503, { ok: false, error: svc.error, detail: svc.detail });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const email = cleanStr(body.email, 320).toLowerCase();
  const password = cleanStr(body.password, 200);

  if (!email || !password) return sendJson(res, 422, { ok: false, error: 'missing_credentials' });

  const r = await sb.auth.signInWithPassword({ email, password });
  if (r.error || !r.data?.session || !r.data?.user) {
    return sendJson(res, 401, { ok: false, error: 'invalid_login' });
  }

  // Ensure the user exists in portal_profiles (auto-provision for allowed emails).
  const userId = r.data.user.id;
  const { data: prof, error: pErr } = await sb
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .eq('user_id', userId)
    .limit(1);

  if (pErr) return sendJson(res, 500, { ok: false, error: 'profile_lookup_failed' });
  const profile = Array.isArray(prof) ? prof[0] : null;

  if (!profile) {
    if (!isAllowedEmail(email)) return sendJson(res, 403, { ok: false, error: 'profile_missing' });

    const metaRole = r.data.user.user_metadata?.role;
    const localPart = String(email.split('@')[0] || '').trim().toLowerCase();
    const role = normalizeRole(metaRole || localPart);
    const fullName = titleCase(role);

    const { error: upsertErr } = await sb
      .from('portal_profiles')
      .upsert({ user_id: userId, role, full_name: fullName }, { onConflict: 'user_id' });
    if (upsertErr) {
      return sendJson(res, 500, {
        ok: false,
        error: 'profile_provision_failed',
        detail: upsertErr.message || '',
      });
    }

    const { data: prof2, error: pErr2 } = await sb
      .from('portal_profiles')
      .select('user_id, role, full_name, created_at')
      .eq('user_id', userId)
      .limit(1);
    if (pErr2) return sendJson(res, 500, { ok: false, error: 'profile_lookup_failed' });
    const profile2 = Array.isArray(prof2) ? prof2[0] : null;
    if (!profile2) return sendJson(res, 403, { ok: false, error: 'profile_missing' });

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
        role: profile2.role,
        fullName: profile2.full_name || '',
        createdAt: profile2.created_at,
      },
    });
  }

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
