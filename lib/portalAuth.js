const { bearerToken } = require('./vercelApi');

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;

  try {
    // Lazily require so local dev still runs without deps installed.
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    return createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch {
    return null;
  }
}

async function getUserFromReq(sbAdmin, req) {
  const token = bearerToken(req);
  if (!token) return { ok: false, error: 'missing_bearer_token' };

  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: 'invalid_token' };
  return { ok: true, token, user: data.user };
}

async function getProfile(sbAdmin, userId) {
  const { data, error } = await sbAdmin
    .from('portal_profiles')
    .select('user_id, role, full_name, created_at')
    .eq('user_id', userId)
    .limit(1);

  if (error) return { ok: false, error: 'profile_lookup_failed' };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { ok: false, error: 'profile_missing' };
  return { ok: true, profile: row };
}

function cleanStr(v, maxLen) {
  return String(v || '').trim().slice(0, maxLen);
}

const VIEW_AS_HEADER = 'x-portal-view-as';
const VIEW_AS_ROLES = new Set([
  'dialer',
  'in_person_setter',
  'remote_setter',
  'closer',
  'account_manager',
  'event_host',
  'event_coordinator',
  'media_team',
]);

function viewAsRoleFromReq(req) {
  const h = req?.headers || {};
  const raw = h[VIEW_AS_HEADER] || h[VIEW_AS_HEADER.toLowerCase()] || '';
  const role = cleanStr(raw, 40);
  if (!role) return '';
  if (role === 'manager') return '';
  return VIEW_AS_ROLES.has(role) ? role : '';
}

function isManager(profile) {
  return String(profile?.role || '') === 'manager';
}

function hasRole(profile, roles) {
  const role = String(profile?.role || '');
  const allowed = Array.isArray(roles) ? roles : [roles];
  return allowed.includes(role) || role === 'manager';
}

async function requirePortalSession(req) {
  const sbAdmin = supabaseAdmin();
  if (!sbAdmin) return { ok: false, error: 'missing_supabase_service_role', status: 503 };

  const u = await getUserFromReq(sbAdmin, req);
  if (!u.ok) return { ok: false, error: u.error, status: 401 };

  const p = await getProfile(sbAdmin, u.user.id);
  if (!p.ok) return { ok: false, error: p.error, status: 403 };

  const realProfile = p.profile;
  let profile = realProfile;

  // Manager-only: allow the UI to request a narrowed view of data.
  const viewAsRole = isManager(realProfile) ? viewAsRoleFromReq(req) : '';
  if (viewAsRole) {
    profile = Object.assign({}, realProfile, { role: viewAsRole });

    // View-as is a simulation mode: deny any mutations to avoid managers
    // accidentally taking actions while viewing other workspaces.
    const m = String(req?.method || 'GET').toUpperCase();
    if (!['GET', 'OPTIONS', 'HEAD'].includes(m)) {
      return { ok: false, error: 'view_as_read_only', status: 403 };
    }
  }

  return {
    ok: true,
    sbAdmin,
    token: u.token,
    user: u.user,
    profile,
    realProfile,
    viewAsRole,
  };
}

module.exports = {
  supabaseAdmin,
  requirePortalSession,
  isManager,
  hasRole,
  viewAsRoleFromReq,
};
