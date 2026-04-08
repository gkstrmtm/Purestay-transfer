const { sendJson, handleCors, readJson } = require('../../lib/vercelApi');
const {
  createPreviewSession,
  previewAuthEnabled,
  supabaseAdmin,
  verifyPreviewAccessCode,
} = require('../../lib/portalAuth');
const { normalizePortalRole, cleanStr, syncPortalPerson } = require('../../lib/portalFoundation');

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
  return normalizePortalRole(roleLike, 'dialer');
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

  // IMPORTANT: do not call signInWithPassword on the same client used for service-role DB writes.
  // Supabase-js will attach the user JWT to subsequent requests, which then triggers RLS.
  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const svc = await assertServiceRole(sbAdmin);
  if (!svc.ok) return sendJson(res, 503, { ok: false, error: svc.error, detail: svc.detail });

  const sbAuth = supabaseAuthClient();
  if (!sbAuth) return sendJson(res, 503, { ok: false, error: 'missing_supabase_service_role' });

  const body = await readJson(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'invalid_body' });

  const previewCode = cleanStr(body.preview_code || body.previewCode, 200);
  if (previewCode) {
    if (!previewAuthEnabled()) return sendJson(res, 403, { ok: false, error: 'preview_auth_disabled' });
    if (!verifyPreviewAccessCode(previewCode)) {
      return sendJson(res, 401, { ok: false, error: 'invalid_preview_code' });
    }

    const preview = await createPreviewSession(sbAdmin);
    if (!preview.ok) {
      return sendJson(res, preview.status || 403, { ok: false, error: preview.error || 'preview_auth_failed' });
    }

    return sendJson(res, 200, {
      ok: true,
      session: preview.session,
      user: preview.user,
      profile: preview.profile,
    });
  }

  const email = cleanStr(body.email, 320).toLowerCase();
  const password = cleanStr(body.password, 200);

  if (!email || !password) return sendJson(res, 422, { ok: false, error: 'missing_credentials' });

  const r = await sbAuth.auth.signInWithPassword({ email, password });
  if (r.error || !r.data?.session || !r.data?.user) {
    return sendJson(res, 401, { ok: false, error: 'invalid_login' });
  }

  // Ensure the user exists in portal_profiles (auto-provision for allowed emails).
  const userId = r.data.user.id;
  const { data: prof, error: pErr } = await sbAdmin
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

    const { error: upsertErr } = await sbAdmin
      .from('portal_profiles')
      .upsert({ user_id: userId, role, full_name: fullName }, { onConflict: 'user_id' });
    if (upsertErr) {
      return sendJson(res, 500, {
        ok: false,
        error: 'profile_provision_failed',
        detail: upsertErr.message || '',
      });
    }

    const { data: prof2, error: pErr2 } = await sbAdmin
      .from('portal_profiles')
      .select('user_id, role, full_name, created_at')
      .eq('user_id', userId)
      .limit(1);
    if (pErr2) return sendJson(res, 500, { ok: false, error: 'profile_lookup_failed' });
    const profile2 = Array.isArray(prof2) ? prof2[0] : null;
    if (!profile2) return sendJson(res, 403, { ok: false, error: 'profile_missing' });

    const personSync = await syncPortalPerson(sbAdmin, {
      userId,
      role: profile2.role,
      fullName: profile2.full_name,
      createdAt: profile2.created_at,
    });
    if (!personSync.ok) {
      return sendJson(res, 500, {
        ok: false,
        error: personSync.error || 'portal_people_sync_failed',
        detail: personSync.detail || '',
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
        role: profile2.role,
        fullName: profile2.full_name || '',
        createdAt: profile2.created_at,
      },
    });
  }

  const personSync = await syncPortalPerson(sbAdmin, {
    userId,
    role: profile.role,
    fullName: profile.full_name,
    createdAt: profile.created_at,
  });
  if (!personSync.ok) {
    return sendJson(res, 500, {
      ok: false,
      error: personSync.error || 'portal_people_sync_failed',
      detail: personSync.detail || '',
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
